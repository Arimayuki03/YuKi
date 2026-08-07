/**
 * index.js — Electron 主进程入口
 *
 * 生命周期：拉起 Python 后端（python-bridge）→ 创建窗口 → 通过 IPC
 * 向渲染进程提供 backend-info。
 * Phase 4：vpc:play 由 mpv-player 接管（缺失时返回 ok:false 走 HTML5 降级）。
 * Phase 5：本地文件管理走 file-manager（白名单根目录 + 防穿越），
 * 本地视频播放复用 mpv-player。
 * Phase 6：下载管理走 downloader（aria2c JSON-RPC），1s 轮询推送进度，
 * 完成发系统通知，一键播放复用 mpv-player；下载目录可更换并持久化。
 * Phase 7：URL 推送（push-server 局域网端口）、设置持久化（settings.js，
 * config URL 自动重载 + 播放偏好）、VIP 解析隐藏窗口（parse-window.js）。
 * UX 批次：弹幕轮询已移除（用户不再需要）；启动自动重载状态经
 * vpc:config-state 提供给渲染层（修复首屏停留示例源需手动刷新）；
 * 直播支持备用线路：起播后未真正开播则自动切换下一条地址。
 */
const { app, BrowserWindow, ipcMain, dialog, Notification, Tray, nativeImage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const PythonBridge = require('./python-bridge');
const MpvPlayer = require('./mpv-player');
const FileManager = require('./file-manager');
const Downloader = require('./downloader');
const HlsDownloader = require('./hls-downloader');
const { ensureFfmpeg, isEnsuring: ffmpegEnsuring, thumb: ffmpegThumb } = require('./ffmpeg');
const Settings = require('./settings');
const PushServer = require('./push-server');
const ParseWindow = require('./parse-window');

// 媒体直链后缀：非直链 URL（share/播放页）先经隐藏窗口抓媒体请求再交 mpv
const MEDIA_URL = /\.(m3u8|mp4|flv|mov|mkv|webm|ts)(\?|#|$)/i;

// Anime4K 实时超分着色器链（v4.1 Mode A：高光钳制→恢复→2x 升频→再恢复，动漫向）
const ANIME4K_FILES = [
    'Anime4K_Clamp_Highlights.glsl',
    'Anime4K_Restore_CNN_M.glsl',
    'Anime4K_Upscale_CNN_x2_M.glsl',
    'Anime4K_Restore_CNN_S.glsl',
    'Anime4K_Upscale_CNN_x2_S.glsl',
    'Anime4K_Darken_HQ.glsl',
];

/** 读 Anime4K 着色器链（mpv --glsl-shaders 分隔符 win=';' posix=':'）；任一文件缺失返回 '' 跳过注入。 */
function buildAnime4kChain() {
    const dir = path.join(RESOURCES_ROOT, 'vendor', 'anime4k');
    const files = ANIME4K_FILES.map((f) => path.join(dir, f));
    if (!files.every((f) => fs.existsSync(f))) return '';
    return files.join(process.platform === 'win32' ? ';' : ':');
}

// Anime4K 着色器源（bloc97/Anime4K v4.1，仓库按功能分子目录）：启动时自动补齐缺失文件，免手动下载
const ANIME4K_BASE = 'https://raw.githubusercontent.com/bloc97/Anime4K/master/glsl/';
const ANIME4K_URLS = {
    'Anime4K_Clamp_Highlights.glsl': 'Restore/Anime4K_Clamp_Highlights.glsl',
    'Anime4K_Restore_CNN_M.glsl': 'Restore/Anime4K_Restore_CNN_M.glsl',
    'Anime4K_Upscale_CNN_x2_M.glsl': 'Upscale/Anime4K_Upscale_CNN_x2_M.glsl',
    'Anime4K_Restore_CNN_S.glsl': 'Restore/Anime4K_Restore_CNN_S.glsl',
    'Anime4K_Upscale_CNN_x2_S.glsl': 'Upscale/Anime4K_Upscale_CNN_x2_S.glsl',
    'Anime4K_Darken_HQ.glsl': 'Experimental-Effects/Anime4K_Darken_HQ.glsl',
};

/** 启动自动补齐 Anime4K 着色器（已存在的跳过；网络失败静默降级，不阻断启动）。 */
async function ensureAnime4k() {
    const dir = path.join(RESOURCES_ROOT, 'vendor', 'anime4k');
    for (const [file, rel] of Object.entries(ANIME4K_URLS)) {
        const dest = path.join(dir, file);
        if (fs.existsSync(dest)) continue;
        try {
            const res = await fetch(ANIME4K_BASE + rel, { redirect: 'follow' });
            if (!res.ok) return false;
            fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        } catch (e) { return false; }
    }
    return true;
}

const ROOT = path.join(__dirname, '..', '..');
// 打包后 extraResources 放在 resources/ 下，vendor 与 python-backend 均从该处读取
const RESOURCES_ROOT = app.isPackaged ? process.resourcesPath : ROOT;
const bridge = new PythonBridge(ROOT, RESOURCES_ROOT);
const mpv = new MpvPlayer();
const dl = new Downloader();
const hls = new HlsDownloader();
const pushServer = new PushServer();
let fileMgr = null;    // app ready 后初始化（依赖 userData 路径）
let settings = null;   // app ready 后初始化（bridge 启动前，供读缓存目录等）
let parseWin = null;   // 同上
let win = null;
let tray = null;       // 托盘图标（关闭→缩小至托盘时应用驻留）
let isQuitting = false; // 真正退出标志（托盘菜单“退出”置位，关窗拦截据此放行）
let dlTimer = null;
// 启动自动重载状态：渲染层经 vpc:config-state 轮询，避免首屏停留在示例源
const configReload = { reloading: false, url: '' };

function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 播放成功后的公共后处理：应用预设音量。 */
function afterPlay() {
    const vol = settings ? parseInt(settings.get('playerVolume'), 10) : 0;
    if (vol > 0) {
        setTimeout(() => { mpv.setVolume(vol).catch(() => { }); }, 1500);
    }
}

/**
 * 起播健康检测：等待 mpv 真正开播（core-idle=false）。
 * 返回 true=已开播；false=进程退出或始终未开播；null=超时未知（慢网络，不触发重试）。
 */
async function mpvStartedOk(timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 800));
        if (!mpv.playing) return false;   // 进程已退出
        try {
            if ((await mpv.getProperty('core-idle')) === false) return true;
        } catch (e) { /* IPC 未就绪或属性暂不可用，继续等 */ }
    }
    return null;
}

/**
 * 直播备用线路：首播未开播则逐条重试 meta.fallbackUrls，
 * 经 vpc:play-retry / vpc:play-failed 通知渲染层提示。
 */
async function watchLiveFallbacks(title, alts, header) {
    if ((await mpvStartedOk(8000)) !== false) return;
    for (const u of alts) {
        send('vpc:play-retry', { title, url: u });
        const r = mpv.play([{ url: u, title }], { title, header, resume: false });
        if (!r.ok) return;
        afterPlay();
        if ((await mpvStartedOk(8000)) !== false) return;
    }
    send('vpc:play-failed', { title });
}

function createWindow() {
    win = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 860,
        minHeight: 560,
        backgroundColor: '#121212',
        title: '影视 PC',
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    // 关闭行为：closeAction ∈ tray(默认缩至托盘)/exit(直接退出)/ask(每次询问)；
    // 后台播放开启时，选退出但 mpv 正在播也转托盘保播
    win.on('close', (e) => {
        if (isQuitting) return;
        const action = settings.get('closeAction') || 'tray';
        let choice = action;
        if (action === 'ask') {
            const r = dialog.showMessageBoxSync(win, {
                type: 'question', title: '关闭影视 PC',
                message: '关闭主窗口时：',
                buttons: ['缩小至托盘（后台继续）', '退出程序', '取消'],
                defaultId: 0, cancelId: 2,
            });
            if (r === 2) { e.preventDefault(); return; }
            choice = r === 0 ? 'tray' : 'exit';
        }
        if (choice === 'exit' && mpv.playing && settings.get('bgPlay') !== false) {
            choice = 'tray'; // 后台播放保护：正在播则转托盘不停 mpv
        }
        if (choice === 'tray') {
            e.preventDefault();
            win.hide();
            if (Notification.isSupported() && mpv.playing) {
                new Notification({ title: '影视 PC', body: '已缩小到托盘，播放继续' }).show();
            }
        } else {
            isQuitting = true; // 放行关闭，窗口全部关闭后随 window-all-closed 退出
        }
    });
    win.on('closed', () => { win = null; });
    // 鼠标侧键前进/后退：转发给渲染层做视图导航（Electron 将 XBUTTON1/2 映射为 browser-backward/forward）
    win.on('app-command', (_e, cmd) => {
        if (cmd === 'browser-backward') send('vpc:mouse-nav', { dir: 'back' });
        else if (cmd === 'browser-forward') send('vpc:mouse-nav', { dir: 'forward' });
    });
}

// ---------------------------------------------------------------- 托盘

/** 托盘图标：内置 16x16 PNG（深底绿三角播放标志），免外部图标资源。 */
function makeTrayIcon() {
    try {
        const crcT = [];
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crcT[n] = c >>> 0;
        }
        const crc32 = (b) => {
            let c = 0xFFFFFFFF;
            for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
            return (c ^ 0xFFFFFFFF) >>> 0;
        };
        const chunk = (type, data) => {
            const t = Buffer.from(type, 'ascii');
            const len = Buffer.alloc(4);
            len.writeUInt32BE(data.length);
            const crc = Buffer.alloc(4);
            crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
            return Buffer.concat([len, t, data, crc]);
        };
        const S = 16;
        const rows = [];
        for (let y = 0; y < S; y++) {
            const row = Buffer.alloc(1 + S * 4);
            for (let x = 0; x < S; x++) {
                const o = 1 + x * 4;
                // 播放三角：x 越界越窄，垂直居中
                const tri = x >= 5 && x <= 11 && Math.abs(y - 7.5) <= (11 - x) * 0.62;
                row[o] = tri ? 0x6C : 0x1E; row[o + 1] = tri ? 0xDB : 0x24;
                row[o + 2] = tri ? 0xA4 : 0x20; row[o + 3] = 255;
            }
            rows.push(row);
        }
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
        ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
        const png = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            chunk('IHDR', ihdr),
            chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
            chunk('IEND', Buffer.alloc(0)),
        ]);
        return nativeImage.createFromBuffer(png);
    } catch (e) { return nativeImage.createEmpty(); }
}

function initTray() {
    tray = new Tray(makeTrayIcon());
    tray.setToolTip('影视 PC');
    const menu = require('electron').Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => { if (win) { win.show(); win.focus(); } } },
        {
            label: '退出影视 PC', click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

app.whenReady().then(() => {
    ipcMain.handle('backend-info', () => bridge.getInfo());
    ipcMain.handle('vpc:config-state', () => ({ ...configReload }));
    ipcMain.handle('vpc:app-version', () => app.getVersion());
    // 资产就绪状态查询（设置页展示 ffmpeg/mpv/aria2/Anime4K 是否就绪）
    ipcMain.handle('vpc:asset-status', () => {
        const ffmpegPath = require('./ffmpeg').findFfmpeg();
        const mpvAvail = mpv.isAvailable();
        const aria2exe = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';
        const aria2Path = (() => {
            const vendorAria2 = path.join(RESOURCES_ROOT, 'vendor', 'aria2', aria2exe);
            if (fs.existsSync(vendorAria2)) return vendorAria2;
            try {
                if (process.platform === 'win32') {
                    const out = require('child_process').execSync('where aria2c', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
                    return out.split(/\r?\n/)[0] || '';
                }
            } catch (e) { /* not in PATH */ }
            return '';
        })();
        const anime4kOk = ANIME4K_FILES.every((f) => fs.existsSync(path.join(RESOURCES_ROOT, 'vendor', 'anime4k', f)));
        const mpvPath = mpv.binary || '';
        return {
            ffmpeg: { ready: !!ffmpegPath, downloading: require('./ffmpeg').isEnsuring() },
            mpv: { ready: mpvAvail, path: mpvPath },
            aria2: { ready: !!aria2Path },
            anime4k: { ready: anime4kOk },
        };
    });

    // mpv 起播资产：lua 快捷键提示脚本 + input.conf 自定义步长（设置页可调），
    // 均写 userData 供 --scripts / --input-conf 加载；改步长后经 vpc:update-hotkeys 重写
    function writeMpvAssets() {
        try {
            const hk = (settings && settings.get('playerHotkeys')) || {};
            const seek = Math.max(1, Math.min(120, parseInt(hk.seek, 10) || 5));
            const vol = Math.max(1, Math.min(20, parseInt(hk.vol, 10) || 5));
            const speed = Math.max(0.05, Math.min(1, parseFloat(hk.speed) || 0.1));
            const anime4kActive = !!(settings && settings.get('anime4k') && buildAnime4kChain());
            const scriptDir = path.join(app.getPath('userData'), 'mpv-scripts');
            fs.mkdirSync(scriptDir, { recursive: true });
            const lua = [
                'mp.register_event("file-loaded", function()',
                `  mp.osd_message("快捷键：空格 暂停/继续 | ←/→ 快退/快进 ${seek}秒 | ↑/↓ 音量±${vol} | [ ] 倍速∓${speed} | Backspace 恢复原速 | , . 逐帧 | F 全屏${anime4kActive ? ' | Anime4K 超分: 开' : ''}", 6)`,
                'end)',
                '',
            ].join('\n');
            fs.writeFileSync(path.join(scriptDir, 'vpc-hints.lua'), lua, 'utf8');
            // input.conf：键位固定，步长取自设置（mpv 语法：add speed 支持小数步长）
            const conf = [
                `LEFT seek -${seek}`,
                `RIGHT seek ${seek}`,
                `UP add volume ${vol}`,
                `DOWN add volume -${vol}`,
                `[ add speed -${speed}`,
                `] add speed ${speed}`,
                'BS set speed 1',
                'SPACE cycle pause',
                'f cycle fullscreen',
                '',
            ].join('\n');
            fs.writeFileSync(path.join(scriptDir, 'input.conf'), conf, 'utf8');
            mpv.scriptPath = path.join(scriptDir, 'vpc-hints.lua');
            mpv.inputConfPath = path.join(scriptDir, 'input.conf');
        } catch (e) { /* 脚本写入失败不影响播放 */ }
    }
    writeMpvAssets();
    ipcMain.handle('vpc:update-hotkeys', () => { writeMpvAssets(); return { ok: true }; });

    // 播放偏好变更（默认倍速 / 记忆位置 / 语言偏好 / Anime4K）：重读设置注入 mpv，下次起播生效
    ipcMain.handle('vpc:update-player-prefs', () => {
        const sp = parseFloat(settings.get('playerSpeed'));
        mpv.defaultSpeed = (sp && sp > 0) ? Math.max(0.25, Math.min(4, sp)) : 1;
        mpv.watchLaterDir = settings.get('resumePos') !== false
            ? path.join(app.getPath('userData'), 'mpv-watch-later')
            : null;
        mpv.audioLang = String(settings.get('playerAlang') || '');
        mpv.subLang = String(settings.get('playerSlang') || '');
        mpv.anime4kShaders = settings.get('anime4k') ? buildAnime4kChain() : '';
        writeMpvAssets(); // 同步 OSD 中的 Anime4K 状态提示
        return { ok: true };
    });

    // 播放入口：mpv 就绪则接管；否则 ok:false 让渲染层 <video> 预览兜底
    ipcMain.handle('vpc:play', (_e, payload) => {
        if (!mpv.isAvailable()) {
            return { ok: false, reason: 'mpv-missing', hint: 'node scripts/download-binaries.js' };
        }
        const meta = payload.meta || {};
        const title = [meta.title, meta.subtitle].filter(Boolean).join(' · ');
        // 连播已改渲染层驱动（每次只交单集，播完由 Player._onExit 推进下一集）；
        // meta.playlist 仅作历史兼容兜底，正常链路不会携带
        const episodes = Array.isArray(meta.playlist) && meta.playlist.length
            ? meta.playlist
            : [{ url: payload.url, title }];
        // Anime4K 开关实时生效（播放途中可切换，下次起播注入着色器）
        mpv.anime4kShaders = settings.get('anime4k') ? buildAnime4kChain() : '';
        // 断流重试上下文：记录本次会话首部 URL/标题/请求头（exit 时未播完可自动重连）
        mpv._lastUrls = episodes.map((e) => e.url);
        mpv._lastTitle = title;
        mpv._lastHeader = meta.header;
        mpv._stallRetried = false;
        // 直播备用线路：首播失败时自动切换（异步监控，不阻塞返回）
        const alts = Array.isArray(meta.fallbackUrls)
            ? meta.fallbackUrls.filter((u) => u && u !== episodes[0].url)
            : [];
        const r = mpv.play(episodes, { title, header: meta.header, resume: !alts.length, speed: meta.speed, fullscreen: meta.fullscreen });
        if (r.ok) {
            // 非连播会话（本地文件/推送）：sessionId 取负，渲染层据此不触碰连播链
            if (meta.noSeq) r.sessionId = -Math.abs(r.sessionId);
            afterPlay();
            if (alts.length) watchLiveFallbacks(title, alts, meta.header).catch(() => { });
            r.anime4k = !!mpv.anime4kShaders; // 渲染层 toast 提示 Anime4K 是否生效
        }
        return r;
    });

    // 播放控制（渲染层备用；mpv 窗口自带默认快捷键）
    ipcMain.handle('vpc:player', (_e, cmd, value) => {
        if (!mpv.playing) return { ok: false };
        const table = {
            pause: () => mpv.setPause(true),
            resume: () => mpv.setPause(false),
            toggle: () => mpv.command('cycle', 'pause'),
            seek: () => mpv.seek(Number(value) || 0),
            volume: () => mpv.setVolume(Number(value) || 0),
            speed: () => mpv.setSpeed(Number(value) || 1),
            quit: () => { mpv.stop(); return Promise.resolve(); },
        };
        const fn = table[cmd];
        if (!fn) return { ok: false, reason: 'unknown cmd' };
        return Promise.resolve(fn()).then(() => ({ ok: true })).catch((e) => ({ ok: false, reason: e.message }));
    });

    ipcMain.handle('vpc:player-state', () => ({ available: mpv.isAvailable(), playing: mpv.playing }));

    // ---- Phase 5 本地文件管理（白名单根目录 + 防穿越） ----
    const fileIpc = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
        try { return { ok: true, ...(await fn(...args)) }; }
        catch (err) { return { ok: false, reason: err.message }; }
    });

    fileIpc('vpc:file-root', () => ({ root: fileMgr.root }));

    ipcMain.handle('vpc:file-pick-root', async () => {
        const r = await dialog.showOpenDialog(win, {
            title: '选择本地文件根目录（白名单）',
            properties: ['openDirectory', 'createDirectory'],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'canceled' };
        const root = fileMgr.setRoot(r.filePaths[0]);
        return { ok: true, root };
    });

    fileIpc('vpc:file-list', (rel) => {
        if (!fileMgr.root) return { needRoot: true };
        return fileMgr.list(rel);
    });

    ipcMain.handle('vpc:file-upload', async (_e, rel) => {
        try {
            const r = await dialog.showOpenDialog(win, {
                title: '选择要上传的文件',
                properties: ['openFile', 'multiSelections'],
            });
            if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'canceled' };
            const copied = fileMgr.uploadFiles(rel, r.filePaths);
            return { ok: true, copied };
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    fileIpc('vpc:file-new-folder', (rel, name) => { fileMgr.newFolder(rel, name); return {}; });
    fileIpc('vpc:file-del-file', (rel) => { fileMgr.delFile(rel); return {}; });
    fileIpc('vpc:file-del-folder', (rel) => { fileMgr.delFolder(rel); return {}; });

    // 本地视频预览图：ffmpeg 抓帧缓存（userData/local-thumbs）；ffmpeg 未就绪返回 ok:false 用占位图
    fileIpc('vpc:file-thumb', async (rel) => {
        const abs = fileMgr.resolveSafe(rel);
        if (!fileMgr.isVideo(abs)) return { ok: false };
        return ffmpegThumb(abs, path.join(app.getPath('userData'), 'local-thumbs'));
    });

    // 本地媒体播放（视频/音频）：相对路径 → 白名单内绝对路径 → 复用 mpv-player
    fileIpc('vpc:file-push', (rel) => {
        if (!mpv.isAvailable()) return { ok: false, reason: 'mpv-missing' };
        const abs = fileMgr.resolveSafe(rel);
        if (!fileMgr.isMedia(abs)) return { ok: false, reason: 'not-video' };
        const title = path.basename(abs);
        const r = mpv.play([{ url: abs, title }], { title, noSeq: true });
        if (r.ok) afterPlay();
        return r;
    });

    // ---- Phase 7 推送 / 解析 / 设置 ----

    // 手动推送（面板）与局域网推送共用同一播放入口
    async function playPushedUrl(url, source) {
        if (!mpv.isAvailable()) return { ok: false, reason: 'mpv-missing' };
        let playUrl = url;
        let header;
        if (!MEDIA_URL.test(url.split('?')[0])) {
            // 非直链（如资源站 share 分享页）：隐藏窗口加载页面抓播放器发出的媒体请求
            const r = await parseWin.captureDirect(url);
            if (!r || !r.ok) return { ok: false, reason: 'resolve-failed' };
            playUrl = r.url;
            header = r.header;
        }
        const title = `推送播放 · ${source}`;
        const r = mpv.play([{ url: playUrl, title }], { title, header, noSeq: true });
        if (r.ok) {
            afterPlay();
            send('vpc:push-received', { url, source });
            if (Notification.isSupported()) {
                new Notification({ title: '推送播放', body: url.slice(0, 80) }).show();
            }
        }
        return r;
    }

    ipcMain.handle('vpc:push-url', async (_e, url) => {
        try { return await playPushedUrl(String(url || '').trim(), '面板'); }
        catch (err) { return { ok: false, reason: err.message }; }
    });

    ipcMain.handle('vpc:push-info', () => pushServer.info());

    ipcMain.handle('vpc:parse', async (_e, url) => {
        try { return await parseWin.resolve(String(url || '')); }
        catch (err) { return { ok: false, reason: err.message }; }
    });

    // 无解析接口（或解析失败）时的兜底：隐藏窗口直开链接抓媒体请求（share 分享页自带播放器）
    ipcMain.handle('vpc:capture-direct', async (_e, url) => {
        try {
            const r = await parseWin.captureDirect(String(url || ''));
            return (r && r.ok) ? r : { ok: false, reason: 'capture-failed' };
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    ipcMain.handle('vpc:settings-get', () => settings.all());
    ipcMain.handle('vpc:settings-set', (_e, key, value) => ({ value: settings.set(String(key), value) }));

    // 直播频道探活：并发检测 HTTP/HTTPS 流地址是否可达（非 HTTP 协议默认放行）。
    // 两段式防误杀：先 HEAD（3s）；出错/超时或响应 403/405/501 时回退 GET（4s），
    // GET 收到任意响应即判活，立即释放连接不拉流；3xx 视为可用。
    ipcMain.handle('vpc:probe-urls', async (_e, urls) => {
        if (!Array.isArray(urls) || !urls.length) return [];
        const probeOne = (url) => new Promise((resolve) => {
            const str = String(url);
            if (!/^https?:\/\//i.test(str)) { resolve(true); return; } // RTMP/RTSP 默认放行
            const mod = str.startsWith('https') ? https : http;
            const attempt = (method, timeoutMs, onDone) => {
                let settled = false;
                const done = (v) => { if (settled) return; settled = true; onDone(v); };
                let req;
                let timer;
                try {
                    req = mod.request(str, { method, timeout: timeoutMs }, (res) => {
                        clearTimeout(timer);
                        const code = res.statusCode || 0;
                        if (method === 'GET') { res.resume(); req.destroy(); done(true); return; } // 任意响应即判活，不拉流
                        if (code >= 300 && code < 400) { res.resume(); done(true); return; }        // 3xx 视为可用
                        if (code === 403 || code === 405 || code === 501) { res.resume(); done(null); return; } // HEAD 被拒 → 回退 GET
                        res.resume();
                        done(code >= 200 && code < 500);
                    });
                } catch (e) { done(null); return; } // 构造失败同样走 GET 兜底
                timer = setTimeout(() => { req.destroy(); done(null); }, timeoutMs);
                req.on('error', () => { clearTimeout(timer); done(null); });
                req.end();
            };
            attempt('HEAD', 3000, (head) => {
                if (head === null) attempt('GET', 4000, (v) => resolve(!!v)); // GET 出错/超时(null) → false
                else resolve(head);
            });
        });
        const results = new Array(urls.length);
        let idx = 0;
        const CONCURRENCY = 12;
        const worker = async () => {
            while (idx < urls.length) {
                const i = idx++;
                results[i] = await probeOne(urls[i]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
        return results;
    });

    // 自定义 mpv 播放器路径：选择本地 mpv.exe 替代内置版本
    ipcMain.handle('vpc:pick-mpv', async () => {
        const r = await dialog.showOpenDialog(win, {
            title: '选择 mpv 可执行文件',
            filters: [
                { name: 'mpv 播放器', extensions: ['exe'] },
                { name: '全部文件', extensions: ['*'] },
            ],
            properties: ['openFile'],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
        const p = r.filePaths[0];
        if (!mpv.setCustomPath(p)) return { ok: false, reason: '所选文件不存在或无法访问' };
        settings.set('mpvPath', p);
        return { ok: true, path: p };
    });

    ipcMain.handle('vpc:clear-mpv-path', () => {
        settings.set('mpvPath', '');
        mpv.resetBinary();
        return { ok: true, available: mpv.isAvailable() };
    });

    ipcMain.handle('vpc:mpv-path', () => {
        return { customPath: settings.get('mpvPath') || '', available: mpv.isAvailable() };
    });

    // 换肤：选择本地图片作壁纸（返回路径，渲染层转 file:// 引用）
    ipcMain.handle('vpc:pick-wallpaper', async () => {
        const r = await dialog.showOpenDialog(win, {
            title: '选择壁纸图片',
            properties: ['openFile'],
            filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
        return { ok: true, path: r.filePaths[0] };
    });

    // 缓存位置自定义：选目录 → 持久化 → 重启后端（VPC_CACHE_DIR 生效）
    ipcMain.handle('vpc:pick-cache-dir', async (_e, dir) => {
        const target = String(dir || '').trim();
        if (!target) {
            const r = await dialog.showOpenDialog(win, {
                title: '选择缓存存放目录',
                properties: ['openDirectory', 'createDirectory'],
            });
            if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
            return { ok: false, reason: 'need-restart', path: r.filePaths[0] }; // 需渲染层确认后再提交
        }
        try { fs.mkdirSync(target, { recursive: true }); } catch (e) { return { ok: false, reason: 'dir-invalid' }; }
        settings.set('cacheDir', target);
        bridge.extraEnv.VPC_CACHE_DIR = target;
        bridge.stop();
        bridge.start();
        return { ok: true, path: target };
    });

    // 恢复默认设置：清偏好类键（保留收藏/历史/源等数据），重启应用确保全量生效
    ipcMain.handle('vpc:settings-reset', () => {
        settings.reset(['favorites', 'history', 'lastConfigUrl', 'configHistory', 'customLives', 'dlDir', 'cacheDir']);
        app.relaunch();
        isQuitting = true;
        app.exit(0);
        return { ok: true };
    });
    function startDlPoll() {
        if (dlTimer) return;
        dlTimer = setInterval(async () => {
            try {
                // aria2 任务 + m3u8 合成任务合并推送（aria2 未就绪不阻断 HLS 展示）
                let items = [];
                try { items = await dl.listAll(); } catch (e) { /* 下一轮会重新拉起 aria2c */ }
                send('vpc:dl-list', [...items, ...hls.list()]);
            } catch (e) { /* ignore */ }
        }, 1000);
    }

    /** 下载目录同步给 aria2 与 HLS 合成器（设置页更换后两者共用）。 */
    function syncDlDir(dir) {
        if (dir) hls.setDir(dir);
    }

    ipcMain.handle('vpc:dl', async (_e, action, payload = {}) => {
        try {
            switch (action) {
                case 'init': {
                    if (!dl.isAvailable()) return { ok: false, reason: 'aria2-missing' };
                    const dir = settings.get('dlDir') || app.getPath('downloads');
                    await dl.start(dir, parseInt(settings.get('dlConcurrency'), 10) || undefined);
                    syncDlDir(dl.dir);
                    startDlPoll();
                    return { ok: true, dir: dl.dir };
                }
                case 'pickDir': {
                    // 更换下载目录：持久化并重启 aria2c（进行中任务中断，可断点续传）
                    const r = await dialog.showOpenDialog(win, {
                        title: '选择下载目录',
                        properties: ['openDirectory', 'createDirectory'],
                    });
                    if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
                    const dir = r.filePaths[0];
                    settings.set('dlDir', dir);
                    syncDlDir(dir);
                    if (dl.isAvailable()) {
                        dl.stop();
                        await dl.start(dir);
                    }
                    startDlPoll();
                    return { ok: true, dir };
                }
                case 'add': {
                    if (!dl.isAvailable()) return { ok: false, reason: 'aria2-missing' };
                    const uri = String(payload.uri || '').trim();
                    if (!uri) throw new Error('empty uri');
                    if (!/^(magnet:|http:|https:)/i.test(uri)) throw new Error('unsupported uri');
                    await dl.start(dl.dir || app.getPath('downloads'));
                    // 详情页批量下载可带文件名与请求头（部分源校验 Referer）
                    const opts = {};
                    const out = String(payload.out || '').replace(/[\\/:*?"<>|]/g, '_').trim();
                    if (out) opts.out = out.slice(0, 150);
                    if (payload.header && typeof payload.header === 'object') {
                        const pairs = Object.entries(payload.header)
                            .filter(([, v]) => v != null && v !== '')
                            .map(([k, v]) => `${k}: ${v}`);
                        if (pairs.length) opts.header = pairs;
                    }
                    const gid = await dl.addUri(uri, opts);
                    startDlPoll();
                    return { ok: true, gid };
                }
                case 'addHls': {
                    // m3u8 切片流：ffmpeg 拉流合成单文件（与 aria2 无关，不要求 aria2 就绪）
                    const uri = String(payload.uri || '').trim();
                    if (!uri) throw new Error('empty uri');
                    syncDlDir(dl.dir || settings.get('dlDir') || app.getPath('downloads'));
                    let gid;
                    try {
                        gid = hls.add({ url: uri, out: payload.out, header: payload.header });
                    } catch (e) {
                        // ffmpeg 首次启动正后台自动下载（约 90MB）：区别于「未安装」，渲染层提示稍后重试
                        if (e && e.message === 'ffmpeg-missing' && ffmpegEnsuring()) return { ok: false, reason: 'ffmpeg-downloading' };
                        throw e;
                    }
                    startDlPoll();
                    return { ok: true, gid };
                }
                case 'addFile': {
                    if (!dl.isAvailable()) return { ok: false, reason: 'aria2-missing' };
                    const r = await dialog.showOpenDialog(win, {
                        title: '选择种子文件 / Metalink',
                        properties: ['openFile'],
                        filters: [{ name: '种子', extensions: ['torrent', 'metalink', 'meta4'] }],
                    });
                    if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
                    const fp = r.filePaths[0];
                    const b64 = fs.readFileSync(fp).toString('base64');
                    await dl.start(dl.dir || app.getPath('downloads'));
                    const gid = fp.toLowerCase().endsWith('.torrent')
                        ? await dl.addTorrent(b64)
                        : await dl.addMetalink(b64);
                    startDlPoll();
                    return { ok: true, gid };
                }
                case 'setConcurrency': {
                    const n = Math.max(1, Math.min(10, parseInt(payload.n, 10) || 3));
                    settings.set('dlConcurrency', n);
                    if (dl.isAvailable()) await dl.setConcurrency(n);
                    return { ok: true, n };
                }
                case 'pause':
                    if (String(payload.gid).startsWith('hls-')) return { ok: false, reason: 'm3u8 合成任务不支持暂停，可直接删除' };
                    await dl.pause(payload.gid); return { ok: true };
                case 'unpause':
                    if (String(payload.gid).startsWith('hls-')) return { ok: false, reason: 'not-supported' };
                    await dl.unpause(payload.gid); return { ok: true };
                case 'remove':
                    if (String(payload.gid).startsWith('hls-')) { hls.remove(payload.gid); return { ok: true }; }
                    await dl.remove(payload.gid); return { ok: true };
                case 'clearFailed': {
                    // 删失败任务及其未完成产物（aria2 --continue 会残留部分下载的文件）
                    let n = 0;
                    if (dl.isAvailable() && dl.proc) {
                        const stopped = await dl.tellStopped();
                        for (const s of stopped) {
                            if (s.status !== 'error') continue;
                            const f = s.files && s.files[0] && s.files[0].path;
                            if (f) { try { fs.rmSync(f, { force: true }); } catch (e) { /* ignore */ } }
                            try { await dl.purge(s.gid); n++; } catch (e) { /* ignore */ }
                        }
                    }
                    n += hls.clearFailed();
                    return { ok: true, n };
                }
                case 'clear': {
                    if (dl.isAvailable() && dl.proc) {
                        const stopped = await dl.tellStopped();
                        for (const s of stopped) {
                            if (['complete', 'error', 'removed'].includes(s.status)) {
                                try { await dl.purge(s.gid); } catch (e) { /* ignore */ }
                            }
                        }
                    }
                    hls.clearStopped();
                    return { ok: true };
                }
                default: return { ok: false, reason: `unknown action ${action}` };
            }
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // 打开下载目录（不依赖 aria2 状态；未更换过则打开系统默认下载目录）
    ipcMain.handle('vpc:dl-open-dir', async () => {
        try {
            const dir = dl.dir || settings.get('dlDir') || app.getPath('downloads');
            const err = await shell.openPath(dir);
            if (err) return { ok: false, reason: err };
            return { ok: true, dir };
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // 下载完成一键播放：直接播本地产出文件（用户主动选择，不受文件白名单限制）
    ipcMain.handle('vpc:dl-play', (_e, filePath) => {
        try {
            if (!mpv.isAvailable()) return { ok: false, reason: 'mpv-missing' };
            const abs = path.resolve(String(filePath || ''));
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, reason: 'file-not-found' };
            if (!fileMgr.isVideo(abs)) return { ok: false, reason: 'not-video' };
            const title = path.basename(abs);
            const r = mpv.play([{ url: abs, title }], { title });
            if (r.ok) afterPlay();
            return r;
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // ---- Phase 6 下载管理（aria2c JSON-RPC） ----

    dl.on('completed', (task) => {
        if (Notification.isSupported()) {
            const n = new Notification({ title: '下载完成', body: task.name || task.gid });
            n.on('click', () => { if (win) { win.show(); win.focus(); send('vpc:dl-goto', {}); } });
            n.show();
        }
        send('vpc:dl-event', { type: 'completed', task });
    });
    dl.on('error', (task) => send('vpc:dl-event', { type: 'error', task }));
    // m3u8 合成任务完成/失败：与 aria2 同一套通知链路
    hls.on('completed', (task) => {
        if (Notification.isSupported()) {
            const n = new Notification({ title: '下载完成（m3u8 已合成）', body: task.name });
            n.on('click', () => { if (win) { win.show(); win.focus(); send('vpc:dl-goto', {}); } });
            n.show();
        }
        send('vpc:dl-event', { type: 'completed', task });
    });
    hls.on('error', (task) => send('vpc:dl-event', { type: 'error', task }));

    // 播放事件 → 渲染层（连播由渲染层在 mpv 退出后推进；附退出进度供「看完」判定）
    mpv.on('ended', (info) => send('vpc:player-ended', info));
    mpv.on('exit', (info) => {
        send('vpc:player-exit', {
            pos: (info && typeof info.pos === 'number') ? info.pos : null,
            duration: (info && typeof info.duration === 'number') ? info.duration : null,
            sessionId: (info && typeof info.sessionId === 'number') ? info.sessionId : 0,
            fullscreen: (info && typeof info.fullscreen === 'boolean') ? info.fullscreen : null,
            speed: (info && typeof info.speed === 'number') ? info.speed : null,
        });
        // 断流自动重连：mpv 在距结尾还有一段时就 EOF/断流退出（CDN 提前断连
        // 或 HLS 实际内容短于声明时长），自动重播当前集一次；每次会话只试一次。
        if (mpv._stallRetried) return;
        const pos = info && typeof info.pos === 'number' ? info.pos : null;
        const dur = info && typeof info.duration === 'number' ? info.duration : null;
        if (pos == null || dur == null || !(dur > 0)) return;
        const left = dur - pos;
        // 剩 <8s 视为正常播完；开播不到 15s 就退是起播失败（另有直播备用线路处理）
        if (left < 8 || pos < 15) return;
        const url = mpv._lastUrls && mpv._lastUrls[0];
        if (!url || !MEDIA_URL.test(String(url))) return; // 仅媒体直链重试
        mpv._stallRetried = true;
        if (Notification.isSupported()) {
            new Notification({ title: '影视 PC', body: '播放被中断，正在自动重连…' }).show();
        }
        setTimeout(() => {
            if (mpv.playing) return; // 用户已另起播放
            const t = mpv._lastTitle || '重连播放';
            const r = mpv.play([{ url, title: t }], { title: t, header: mpv._lastHeader });
            if (r.ok) {
                afterPlay();
                // 同步新会话号：重连集播完后渲染层仍能匹配并推进连播
                send('vpc:player-session', { sessionId: r.sessionId });
            }
        }, 1000);
    });

    /** 自动重载收尾：清状态并通知渲染层（ok=是否成功载入站点）。 */
    function finishReload(ok, sites) {
        configReload.reloading = false;
        send('vpc:config-reloaded', { url: configReload.url, ok: !!ok, sites: sites || 0 });
    }

    bridge.on('ready', (info) => {
        if (win) win.webContents.send('backend-ready', info);
        // Phase 7：自动重载上次成功加载的配置 URL（状态同步置位，供 vpc:config-state 轮询）
        const lastUrl = settings.get('lastConfigUrl');
        if (lastUrl && /^https?:\/\//i.test(lastUrl)) {
            configReload.reloading = true;
            configReload.url = lastUrl;
            console.log('[config] auto reload start:', lastUrl);
            // READY 行早于端口监听：先轮询 health 确认后端可达（最长 20s）
            (async () => {
                for (let i = 0; i < 40; i++) {
                    try {
                        const h = await fetch(`${info.base}/health`, { signal: AbortSignal.timeout(2000) });
                        if (h.ok) break;
                    } catch (e) { /* 未就绪，重试 */ }
                    await new Promise((r) => setTimeout(r, 500));
                }
            // undici 不自动编码非 ASCII 路径（如中文文件名），先 encodeURI
            return fetch(encodeURI(`${info.base}/action?token=${info.token}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ do: 'setting', name: 'config', text: lastUrl }).toString(),
                signal: AbortSignal.timeout(20000),
            }).then((rsp) => rsp.json().catch(() => null))
                .then(async (body) => {
                    const url = `${info.base}/action?token=${info.token}`;
                    if (body && body.code === 202) {
                        // 后端异步加载：轮询任务结果（最长 120s）
                        for (let i = 0; i < 60; i++) {
                            await new Promise((r) => setTimeout(r, 2000));
                            const t = await fetch(url, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body: 'do=configTask',
                            }).then((x) => x.json()).catch(() => null);
                            if (!t || t.status === 'loading') continue;
                            if (t.status === 'done' && t.summary && t.summary.sites > 0) {
                                finishReload(true, t.summary.sites);
                            } else {
                                console.warn('[config] auto reload failed:', (t && t.msg) || '0 sites');
                                finishReload(false);
                            }
                            return;
                        }
                        console.warn('[config] auto reload timeout');
                        finishReload(false);
                    } else if (body && body.code === 200 && body.summary) {
                        finishReload(true, body.summary.sites);
                    } else {
                        console.warn('[config] auto reload failed:', (body && body.msg) || 'unknown');
                        finishReload(false);
                    }
                })
                .catch((e) => { console.warn('[config] auto reload request failed:', e && e.message); finishReload(false); });
            })();
        }
    });
    bridge.on('state', (state) => {
        if (win) win.webContents.send('backend-state', state);
    });

    settings = new Settings(app.getPath('userData'));
    fileMgr = new FileManager(app.getPath('userData'));
    // 本地文件根目录默认与下载目录一致（未手动选过白名单时）
    if (!fileMgr.root) {
        try { fileMgr.setRoot(settings.get('dlDir') || app.getPath('downloads')); } catch (e) { /* 目录无效保持引导态 */ }
    }
    syncDlDir(settings.get('dlDir') || app.getPath('downloads'));
    // 自定义缓存目录：后端 spawn 前注入环境变量（更换目录后重启后端生效）
    const cacheDir = settings.get('cacheDir');
    if (cacheDir) bridge.extraEnv.VPC_CACHE_DIR = cacheDir;
    // 续播位置（mpv watch-later）与默认倍速：读设置注入播放器（可在设置页关闭/调整）
    if (settings.get('resumePos') !== false) {
        mpv.watchLaterDir = path.join(app.getPath('userData'), 'mpv-watch-later');
    }
    // 自定义 mpv 路径：优先使用用户在设置中指定的 mpv.exe
    const customMpvPath = settings.get('mpvPath');
    if (customMpvPath) mpv.setCustomPath(customMpvPath);
    const spd = parseFloat(settings.get('playerSpeed'));
    if (spd && spd > 0) mpv.defaultSpeed = Math.max(0.25, Math.min(4, spd));
    // 语言偏好（音轨/字幕）：读设置注入播放器
    mpv.audioLang = String(settings.get('playerAlang') || '');
    mpv.subLang = String(settings.get('playerSlang') || '');
    // ffmpeg 内置：启动后台自动补齐（m3u8 下载合成与本地预览图依赖；缺失时静默降级）
    ensureFfmpeg().catch(() => { });
    // Anime4K 超分：启动自动补齐着色器（内置免手动下载）；用户从未设置过开关则默认开启，
    // 已手动关闭过（值 false）保持关闭；文件不全时链为空静默降级
    ensureAnime4k().catch(() => { }).finally(() => {
        if (settings.get('anime4k') === undefined && buildAnime4kChain()) settings.set('anime4k', true);
        if (settings.get('anime4k')) mpv.anime4kShaders = buildAnime4kChain();
    });
    bridge.start();
    parseWin = new ParseWindow(() => bridge.info);
    pushServer.on('push', ({ url }) => playPushedUrl(url, '局域网'));
    pushServer.start();
    createWindow();
    initTray();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    // 托盘驻留模式（win.hide 不触发；destroy 后才到这里）：保活不停 mpv
    if (!isQuitting) return;
    mpv.stop();
    dl.stop();
    pushServer.stop();
    bridge.stop();
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (dlTimer) { clearInterval(dlTimer); dlTimer = null; }
    mpv.stop();
    dl.stop();
    pushServer.stop();
    bridge.stop();
});
