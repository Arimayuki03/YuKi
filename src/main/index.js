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
const { app, BrowserWindow, ipcMain, dialog, Notification, Tray, nativeImage, shell, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const PythonBridge = require('./python-bridge');
const MpvPlayer = require('./mpv-player');
const FileManager = require('./file-manager');
const Downloader = require('./downloader');
const HlsDownloader = require('./hls-downloader');
const DlRecordStore = require('./dl-record');
const { ensureFfmpeg, isEnsuring: ffmpegEnsuring, thumb: ffmpegThumb } = require('./ffmpeg');
const Settings = require('./settings');
const PushServer = require('./push-server');
const ParseWindow = require('./parse-window');
const SyncplayClient = require('./syncplay-client');
const DlnaCaster = require('./dlna-caster');
const { RotatingLogWriter, installConsoleLogger, readRecentLogs, clearLogs } = require('./logger');
const misans = require('./misans');

// 媒体直链后缀：非直链 URL（share/播放页）先经隐藏窗口抓媒体请求再交 mpv
const MEDIA_URL = /\.(m3u8|mp4|flv|mov|mkv|webm|ts)(\?|#|$)/i;

// Anime4K 实时超分着色器链（v4.1，动漫向）三档位（设置项 anime4kMode，T8）：
// 均衡 Mode A：高光钳制→恢复→2x 升频→再恢复（默认）；细节 Mode A+A：先升频再恢复再升频（低清片源）；
// 修复 Restore：只恢复细节不升频（已高清的片源）。所需着色器均在启动自动下载清单内。
const ANIME4K_CHAINS = {
    a: [
        'Anime4K_Clamp_Highlights.glsl',
        'Anime4K_Restore_CNN_M.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl',
        'Anime4K_Restore_CNN_S.glsl',
        'Anime4K_Upscale_CNN_x2_S.glsl',
        'Anime4K_Darken_HQ.glsl',
    ],
    aa: [
        'Anime4K_Clamp_Highlights.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl',
        'Anime4K_Restore_CNN_M.glsl',
        'Anime4K_Upscale_CNN_x2_M.glsl',
    ],
    restore: [
        'Anime4K_Restore_CNN_M.glsl',
        'Anime4K_Restore_CNN_S.glsl',
    ],
};
const ANIME4K_MIN_SIZE = 128; // 合法着色器远大于此；拦截 0 字节/截断的残留文件

/** 单个着色器文件是否完整可用：存在、非空/截断、且头部含作者版权行（拦截镜像/代理返回的大体积错误页）。 */
function anime4kFileOk(p) {
    try {
        if (!fs.existsSync(p) || fs.statSync(p).size < ANIME4K_MIN_SIZE) return false;
        return fs.readFileSync(p, 'utf8').slice(0, 1024).includes('bloc97');
    } catch (e) { return false; }
}

/** 读指定档位的 Anime4K 着色器链（mpv --glsl-shaders 分隔符 win=';' posix=':'）；任一文件缺失/损坏返回 '' 跳过注入。 */
function buildAnime4kChain(mode) {
    const dir = path.join(RESOURCES_ROOT, 'vendor', 'anime4k');
    const files = (ANIME4K_CHAINS[mode] || ANIME4K_CHAINS.a).map((f) => path.join(dir, f));
    if (!files.every(anime4kFileOk)) return '';
    return files.join(process.platform === 'win32' ? ';' : ':');
}

/** 按当前设置读 Anime4K 着色器链：开关关闭或着色器未就绪返回 ''。 */
function anime4kChainFromSettings() {
    if (!(settings && settings.get('anime4k'))) return '';
    return buildAnime4kChain(String(settings.get('anime4kMode') || 'a'));
}

// Anime4K 着色器源（bloc97/Anime4K v4.1，仓库按功能分子目录）：启动时自动补齐缺失文件，免手动下载。
// 多镜像下载加固：raw.githubusercontent 直连失败 → jsdelivr CDN（单文件上限 20MB，glsl 远小于此）→
// ghfast.top 加速代理。镜像/代理可能回错误页（HTTP 200 假成功），按内容含 "Anime4K" 校验。
const ANIME4K_URLS = {
    'Anime4K_Clamp_Highlights.glsl': 'Restore/Anime4K_Clamp_Highlights.glsl',
    'Anime4K_Restore_CNN_M.glsl': 'Restore/Anime4K_Restore_CNN_M.glsl',
    'Anime4K_Upscale_CNN_x2_M.glsl': 'Upscale/Anime4K_Upscale_CNN_x2_M.glsl',
    'Anime4K_Restore_CNN_S.glsl': 'Restore/Anime4K_Restore_CNN_S.glsl',
    'Anime4K_Upscale_CNN_x2_S.glsl': 'Upscale/Anime4K_Upscale_CNN_x2_S.glsl',
    'Anime4K_Darken_HQ.glsl': 'Experimental-Effects/Anime4K_Darken_HQ.glsl',
};
const ANIME4K_MIRRORS = [
    (rel) => `https://raw.githubusercontent.com/bloc97/Anime4K/master/glsl/${rel}`,
    (rel) => `https://cdn.jsdelivr.net/gh/bloc97/Anime4K@master/glsl/${rel}`,
    (rel) => `https://ghfast.top/https://raw.githubusercontent.com/bloc97/Anime4K/master/glsl/${rel}`,
];

/** 单个着色器多镜像下载：任一镜像成功写盘返回 true；全部失败返回 false（不抛出，换下一个文件继续）。 */
async function downloadAnime4kOne(dest, rel) {
    for (const toUrl of ANIME4K_MIRRORS) {
        try {
            const res = await fetch(toUrl(rel), {
                redirect: 'follow',
                signal: AbortSignal.timeout(12000),
                headers: { 'User-Agent': 'video-pc/1.0' },
            });
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < ANIME4K_MIN_SIZE || !buf.toString('utf8').includes('Anime4K')) continue;
            fs.writeFileSync(dest, buf);
            console.log(`[anime4k] ${rel} <- ${toUrl(rel)}`);
            return true;
        } catch (e) { /* 换下一个镜像 */ }
    }
    console.warn(`[anime4k] 全部镜像下载失败: ${rel}`);
    return false;
}

/** 启动自动补齐 Anime4K 着色器（完整文件跳过，残留/损坏文件重下；网络失败静默降级，不阻断启动）。
 *  单个文件失败不中断其余，下次启动只补缺失的。 */
async function ensureAnime4k() {
    const dir = path.join(RESOURCES_ROOT, 'vendor', 'anime4k');
    let allOk = true;
    for (const [file, rel] of Object.entries(ANIME4K_URLS)) {
        const dest = path.join(dir, file);
        if (anime4kFileOk(dest)) continue;
        if (!(await downloadAnime4kOne(dest, rel))) allOk = false;
    }
    return allOk;
}

const ROOT = path.join(__dirname, '..', '..');
// 打包后 extraResources 放在 resources/ 下，vendor 与 python-backend 均从该处读取
const RESOURCES_ROOT = app.isPackaged ? process.resourcesPath : ROOT;
const LOG_DIR = path.join(os.homedir(), '.video-pc', 'logs');
installConsoleLogger(LOG_DIR);
const bridge = new PythonBridge(ROOT, RESOURCES_ROOT, {
    logWriter: new RotatingLogWriter(path.join(LOG_DIR, 'python-console.log')),
});
const mpv = new MpvPlayer();
const dl = new Downloader();
const hls = new HlsDownloader();
const dlRecords = new DlRecordStore();
const pushServer = new PushServer();
const syncplay = new SyncplayClient();
const dlna = new DlnaCaster();
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

/** mpv 硬盘缓存文件名模式：--demuxer-cache-dir 平铺写入 mpv-cache-<hex>.dat。 */
const MPV_CACHE_FILE_RE = /^mpv-cache-.+\.dat$/i;

/**
 * 清空 mpv 硬盘缓存目录：递归遍历（兼容未来子目录结构），只删 mpv 缓存模式文件
 * （避免在用户自选目录里误删无关文件），随之变空的子目录一并移除。
 * 逐文件 try/catch：正被 mpv 写盘的文件跳过（Windows 下 mpv 以共享删除打开一般可删，
 * 但仍有竞态窗口）。返回成功释放的字节数（不含跳过文件）。
 */
function clearDiskCache(dir) {
    if (!dir || !fs.existsSync(dir)) return 0;
    let cleaned = 0;
    const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
            const p = path.join(d, ent.name);
            try {
                if (ent.isDirectory()) {
                    walk(p);
                    try { fs.rmdirSync(p); } catch (e) { /* 仍有文件/占用：保留 */ }
                } else if (ent.isFile() && MPV_CACHE_FILE_RE.test(ent.name)) {
                    const st = fs.statSync(p);
                    try { fs.rmSync(p, { force: true }); cleaned += st.size; } catch (e) { /* 占用跳过 */ }
                }
            } catch (e) { /* 单项失败不影响整体 */ }
        }
    };
    walk(dir);
    return cleaned;
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
        title: 'YuKi',
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    // 渲染端失败落盘：控制台的 warning/error 与渲染进程崩溃都写进 electron-main.log（redactSecrets 由 writer 负责）
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        // level: 0=log 1=warning 2=error 3=debug；只记 warning/error，避免刷屏
        if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`);
        else if (level === 1) console.warn(`[renderer] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
        console.error('[render-process-gone]', details && details.reason, details && details.exitCode);
    });
    // 外链一律交系统默认浏览器（T73）：target=_blank（如「获取 Bangumi Token」链接）不再开应用内新窗
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
            shell.openExternal(url).catch((e) => console.error('[main] openExternal failed:', url, e));
        }
        return { action: 'deny' };
    });
    // 关闭行为：closeAction ∈ tray(默认缩至托盘)/exit(直接退出)/ask(每次询问)；
    // 后台播放开启时，选退出但 mpv 正在播也转托盘保播
    win.on('close', (e) => {
        if (isQuitting) return;
        const action = settings.get('closeAction') || 'tray';
        let choice = action;
        if (action === 'ask') {
            const r = dialog.showMessageBoxSync(win, {
                type: 'question', title: '关闭 YuKi',
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
            // 后台播放关闭：缩到托盘时也停止播放，避免 mpv 进程残留后台
            if (settings.get('bgPlay') === false && mpv.playing) {
                mpv.stop();
                if (Notification.isSupported()) {
                    new Notification({ title: 'YuKi', body: '已停止播放，应用驻留托盘' }).show();
                }
            } else {
                if (Notification.isSupported() && mpv.playing) {
                    new Notification({ title: 'YuKi', body: '已缩小到托盘，播放继续' }).show();
                }
            }
            win.hide();
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
    tray.setToolTip('YuKi');
    const menu = require('electron').Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => { if (win) { win.show(); win.focus(); } } },
        {
            label: '退出 YuKi', click: () => {
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

    // 关于页系统信息：应用版本 + 运行环境版本
    ipcMain.handle('vpc:app-info', () => ({
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
    }));
    // 内置 MiSans 字体 CSS 的 file:// URL（渲染层注入 <link>；打包内置，无运行时下载，T61）
    ipcMain.handle('vpc:font-css', () => misans.fontCssUrls());
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
        // 三档位所需着色器全集（去重）均就绪才算 Anime4K 可用（T8 后不再有单一 FILES 清单）
        const anime4kFiles = [...new Set(Object.values(ANIME4K_CHAINS).flat())];
        const anime4kOk = anime4kFiles.every((f) => anime4kFileOk(path.join(RESOURCES_ROOT, 'vendor', 'anime4k', f)));
        const mpvPath = mpv.binary || '';
        return {
            ffmpeg: { ready: !!ffmpegPath, downloading: require('./ffmpeg').isEnsuring() },
            mpv: { ready: mpvAvail, path: mpvPath },
            aria2: { ready: !!aria2Path },
            anime4k: { ready: anime4kOk },
        };
    });

    // mpv 起播资产：lua 快捷键提示脚本 + input.conf 自定义步长（设置页可调），
    // 均写 userData 供 --scripts-append / --input-conf 加载；改步长后经 vpc:update-hotkeys 重写。
    // input.conf 合并用户全局键位：--input-conf 会取代 mpv 默认 input.conf 加载（而不是追加），
    // 因此生成文件里保留用户自己的 input.conf 行，且放在应用段之后（mpv 同键后绑定优先 → 用户自定义不被覆盖）。
    const VPC_CONF_MARK = '# ---- video-pc custom bindings ----';
    const VPC_CONF_END = '# ---- video-pc custom bindings end ----';

    /** 用户全局 mpv input.conf 路径：WIN %APPDATA%\mpv\input.conf；POSIX ~/.config/mpv/input.conf。 */
    function getUserMpvInputConfPath() {
        return process.platform === 'win32'
            ? path.join(process.env.APPDATA || '', 'mpv', 'input.conf')
            : path.join(os.homedir(), '.config', 'mpv', 'input.conf');
    }

    /** 读用户全局 input.conf 并剔除本应用旧版写入的 video-pc 段，返回用户原始行（写坏不阻断）。 */
    function readUserMpvInputConf() {
        try {
            const p = getUserMpvInputConfPath();
            if (!fs.existsSync(p)) return [];
            const lines = String(fs.readFileSync(p, 'utf8')).split(/\r?\n/);
            const out = [];
            let inSection = false;
            for (const ln of lines) {
                const t = ln.trim();
                if (t === VPC_CONF_MARK) { inSection = true; continue; }
                if (t === VPC_CONF_END) { inSection = false; continue; }
                if (!inSection) out.push(ln);
            }
            return out;
        } catch (e) { return []; }
    }

    /** 收集 input.conf 已绑定的键名（首个空白分隔 token；跳过注释/空行），应用段据此跳过冲突键。 */
    function inputConfBoundKeys(lines) {
        const keys = new Set();
        for (const ln of lines) {
            const t = ln.trim();
            if (!t || t.startsWith('#')) continue;
            const key = t.split(/\s+/, 1)[0];
            if (key) keys.add(key);
        }
        return keys;
    }

    /** 键名合法性：非空、不含空白与 input.conf 特殊字符（# 注释 ; 命令分隔 " 引号），限长。 */
    const hkKeyOk = (k) => typeof k === 'string' && k.length >= 1 && k.length <= 24 && !/[\s#;"]/.test(k);

    // 可自定义键位表（T8）：动作 id → 默认键；渲染层同表提供按键捕获 UI，
    // 键位存 settings.playerHotkeys.keys，此处写入 input.conf（mpv 语法）。
    const HK_DEF_KEYS = {
        pause: 'SPACE', seekBack: 'LEFT', seekFwd: 'RIGHT',
        volUp: 'UP', volDown: 'DOWN',
        speedDown: '[', speedUp: ']', speedReset: 'BS',
        frameBack: ',', frameFwd: '.', fullscreen: 'f', screenshot: 's',
    };

    function writeMpvAssets() {
        try {
            const hk = (settings && settings.get('playerHotkeys')) || {};
            const seek = Math.max(1, Math.min(120, parseInt(hk.seek, 10) || 5));
            const vol = Math.max(1, Math.min(20, parseInt(hk.vol, 10) || 5));
            const speed = Math.max(0.05, Math.min(1, parseFloat(hk.speed) || 0.1));
            // 自定义键位：只收合法键名，缺失动作回退默认
            const keys = Object.assign({}, HK_DEF_KEYS);
            if (hk.keys && typeof hk.keys === 'object') {
                for (const id of Object.keys(HK_DEF_KEYS)) {
                    if (hkKeyOk(hk.keys[id])) keys[id] = hk.keys[id];
                }
            }
            const a4kChain = anime4kChainFromSettings();
            const a4kLabels = { a: '均衡', aa: '细节增强', restore: '仅修复' };
            const a4kHint = a4kChain
                ? ` | Anime4K 超分: 开（${a4kLabels[String(settings.get('anime4kMode') || 'a')] || '均衡'}）`
                : '';
            const scriptDir = path.join(app.getPath('userData'), 'mpv-scripts');
            fs.mkdirSync(scriptDir, { recursive: true });
            // lua 提示：起播列键位（随自定义键位动态生成）+ 暂停状态中文 OSD 反馈
            const hintParts = [
                `${keys.pause} 暂停/继续`, `${keys.seekBack}/${keys.seekFwd} 快退/快进 ${seek}秒`,
                `${keys.volUp}/${keys.volDown} 音量±${vol}`, `${keys.speedDown} ${keys.speedUp} 倍速∓${speed}`,
                `${keys.speedReset} 恢复原速`, `${keys.frameBack} ${keys.frameFwd} 逐帧`, `${keys.fullscreen} 全屏`,
                `${keys.screenshot} 截图`,
            ];
            const lua = [
                'mp.register_event("file-loaded", function()',
                `  mp.osd_message("快捷键：${hintParts.join(' | ')}${a4kHint}", 6)`,
                'end)',
                'mp.observe_property("pause", "boolean", function(_, v)',
                '  if v ~= nil then mp.osd_message(v and "已暂停" or "继续播放", 1.5) end',
                'end)',
                '',
            ].join('\n');
            fs.writeFileSync(path.join(scriptDir, 'vpc-hints.lua'), lua, 'utf8');
            // input.conf：键位取自设置（mpv 语法：add speed 支持小数步长），动作附中文 show-text 反馈。
            // 同键重复只留首个；用户全局 input.conf 已绑定的键不写入应用段，用户行追加在后（同键以用户为准）。
            const userLines = readUserMpvInputConf();
            const userKeys = inputConfBoundKeys(userLines);
            const bindings = [
                [keys.pause, 'cycle pause', ''],
                [keys.seekBack, `seek -${seek}`, `快退 ${seek} 秒`],
                [keys.seekFwd, `seek ${seek}`, `快进 ${seek} 秒`],
                [keys.volUp, `add volume ${vol}`, `音量 +${vol}`],
                [keys.volDown, `add volume -${vol}`, `音量 -${vol}`],
                [keys.speedDown, `add speed -${speed}`, `倍速 -${speed}`],
                [keys.speedUp, `add speed ${speed}`, `倍速 +${speed}`],
                [keys.speedReset, 'set speed 1', '已恢复原速 1.0x'],
                [keys.frameBack, 'frame-back-step', '上一帧'],
                [keys.frameFwd, 'frame-step', '下一帧'],
                [keys.fullscreen, 'cycle fullscreen', ''],
                [keys.screenshot, 'screenshot', '已截图'],
            ];
            const used = new Set();
            const defaults = [];
            for (const [key, cmd, msg] of bindings) {
                if (!key || used.has(key) || userKeys.has(key)) continue;
                used.add(key);
                defaults.push(msg ? `${key} ${cmd}; show-text "${msg}"` : `${key} ${cmd}`);
            }
            const conf = [
                VPC_CONF_MARK,
                ...defaults,
                VPC_CONF_END,
                '',
                '# 以下为用户全局 mpv input.conf 的键位（自动合并，请编辑全局文件或此段上方）',
                ...userLines,
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
        mpv.anime4kShaders = anime4kChainFromSettings();
        mpv.screenshotDir = path.join(app.getPath('pictures'), 'video-pc');
        writeMpvAssets(); // 同步 OSD 中的 Anime4K 状态提示
        return { ok: true };
    });

    // 截图：把 mpv 当前帧存为 PNG（快捷键走 input.conf 的 screenshot 命令；此端点供程序化触发）
    ipcMain.handle('vpc:mpv-screenshot', async () => {
        try {
            if (!mpv.isAvailable()) return { ok: false, reason: 'mpv-missing' };
            if (!mpv.playing) return { ok: false, reason: 'not-playing' };
            const dir = mpv.screenshotDir || path.join(app.getPath('pictures'), 'video-pc');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `video-pc-${Date.now()}.png`);
            await mpv.screenshot(file);
            if (Notification.isSupported()) {
                const n = new Notification({ title: '已截图', body: path.basename(file) });
                n.on('click', () => { if (win) { win.show(); win.focus(); } });
                n.show();
            }
            return { ok: true, path: file };
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // 打开截图目录（资源管理器）
    ipcMain.handle('vpc:mpv-screenshot-dir', async () => {
        try {
            const dir = mpv.screenshotDir || path.join(app.getPath('pictures'), 'video-pc');
            fs.mkdirSync(dir, { recursive: true });
            const err = await shell.openPath(dir);
            if (err) return { ok: false, reason: err };
            return { ok: true, dir };
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // 播放入口：mpv 就绪则接管；否则 ok:false 让渲染层 <video> 预览兜底
    ipcMain.handle('vpc:play', async (_e, payload) => {
        if (!mpv.isAvailable()) {
            return { ok: false, reason: 'mpv-missing', hint: '设置 → 扩展 → 下载内置播放器' };
        }
        const meta = payload.meta || {};
        const title = [meta.title, meta.subtitle].filter(Boolean).join(' · ');
        // 连播已改渲染层驱动（每次只交单集，播完由 Player._onExit 推进下一集）；
        // meta.playlist 仅作历史兼容兜底，正常链路不会携带
        const episodes = Array.isArray(meta.playlist) && meta.playlist.length
            ? meta.playlist
            : [{ url: payload.url, title }];
        // Anime4K 开关/档位实时生效（播放途中可切换，下次起播注入着色器）
        mpv.anime4kShaders = anime4kChainFromSettings();
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
            // 边下边播（T9，默认关）：静默把当前集追加到下载目录（m3u8 走 ffmpeg 合成，
            // 其余走 aria2）；引擎未就绪/失败静默跳过不打扰播放
            if (settings.get('simulDownload')) {
                try {
                    const ep = episodes[0];
                    const urlPath = String(ep.url).split('?')[0];
                    const isM3u8 = /\.m3u8$/i.test(urlPath);
                    const ext = (urlPath.match(/\.(mp4|mkv|flv|mov|avi|webm|ts)$/i) || ['', ''])[1];
                    const out = (title.replace(/[\\/:*?"<>|]/g, '_').trim() || '视频').slice(0, 150) + ext;
                    if (isM3u8) {
                        syncDlDir(dl.dir || settings.get('dlDir') || app.getPath('downloads'));
                        hls.add({ url: ep.url, out, header: meta.header });
                        startDlPoll();
                        r.simulDl = true;
                    } else if (dl.isAvailable()) {
                        await dl.start(dl.dir || settings.get('dlDir') || app.getPath('downloads'));
                        const opts = { out };
                        if (meta.header && typeof meta.header === 'object') {
                            const pairs = Object.entries(meta.header)
                                .filter(([, v]) => v != null && v !== '')
                                .map(([k, v]) => `${k}: ${v}`);
                            if (pairs.length) opts.header = pairs;
                        }
                        await dl.addUri(ep.url, opts);
                        startDlPoll();
                        r.simulDl = true;
                    }
                } catch (e) { /* 静默跳过：播放优先 */ }
            }
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
        try {
            // 25s 安全超时：解析窗口偶发挂起（槽位/cookies 卡住）时也返回，避免渲染层 loading 永不消失
            return await Promise.race([
                parseWin.resolve(String(url || '')),
                new Promise((res) => setTimeout(() => res(null), 25000)),
            ]);
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // 无解析接口（或解析失败）时的兜底：隐藏窗口直开链接抓媒体请求（share 分享页自带播放器）
    ipcMain.handle('vpc:capture-direct', async (_e, payload) => {
        try {
            // 兼容两种调用：字符串 url（旧）或 {url, legacy}（Kazumi 旧解析器）
            const url = (payload && typeof payload === 'object') ? String(payload.url || '') : String(payload || '');
            const legacy = !!(payload && typeof payload === 'object' && payload.legacy);
            // 25s 安全超时：隐藏窗口偶发挂起时也返回，避免渲染层 loading 永不消失
            const r = await Promise.race([
                parseWin.captureDirect(url, undefined, legacy),
                new Promise((res) => setTimeout(() => res(null), 25000)),
            ]);
            return (r && r.ok) ? r : { ok: false, reason: 'capture-failed' };
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // 验证码源验证（T73）：可见窗口供用户交互，关闭/超时后收割 Cookie 交给后端持久化
    ipcMain.handle('vpc:captcha-verify', async (_e, url) => {
        try {
            const u = String((url && typeof url === 'object') ? url.url || '' : url || '');
            if (!/^https?:\/\//i.test(u)) return { ok: false, reason: 'bad url' };
            // 3 分钟上限：用户完成验证后自行关闭窗口即返回
            return await Promise.race([
                parseWin.captchaVerify(u),
                new Promise((res) => setTimeout(() => res({ ok: true, reason: 'timeout' }), 180000)),
            ]);
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
        if (!mpv.setCustomPath(p)) return { ok: false, reason: '所选文件不存在或不是有效的 mpv' };
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

    // 一键补装内置播放器：用户在安装时取消勾选 mpv、或未内置时，从设置页触发下载。
    // 下载到 userData/vendor（安装目录 resources/ 常在 Program Files 无写权限），完成后
    // 复用自定义路径机制（setCustomPath + 持久化 mpvPath），下次起播即可用。
    let _mpvDownloading = false;
    ipcMain.handle('vpc:download-mpv', async () => {
        if (process.platform !== 'win32') {
            return { ok: false, reason: '非 Windows 平台请用系统包管理器安装 mpv（brew/apt install mpv）' };
        }
        if (mpv.isAvailable()) return { ok: true, path: mpv.binary, already: true };
        if (_mpvDownloading) return { ok: false, reason: 'downloading' };
        _mpvDownloading = true;
        send('vpc:mpv-download-state', { downloading: true });
        try {
            const { downloadMpv } = require('../../scripts/download-binaries');
            const vendorDir = path.join(app.getPath('userData'), 'vendor');
            const target = await downloadMpv(vendorDir);
            if (!target || !fs.existsSync(target)) return { ok: false, reason: 'download-failed' };
            if (!mpv.setCustomPath(target)) return { ok: false, reason: '下载完成但校验失败（文件可能损坏）' };
            settings.set('mpvPath', target);
            if (Notification.isSupported()) {
                new Notification({ title: '内置播放器已就绪', body: 'mpv 安装完成，现在可以播放视频了' }).show();
            }
            return { ok: true, path: target };
        } catch (err) {
            return { ok: false, reason: err.message || 'download-failed' };
        } finally {
            _mpvDownloading = false;
            send('vpc:mpv-download-state', { downloading: false });
        }
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

    // ---- mpv 视频缓冲缓存（内存默认 / 硬盘 + 自定义目录） ----

    // 通用目录选择：mpv 硬盘缓存目录用（openDirectory + createDirectory，取消返回 cancelled）
    ipcMain.handle('vpc:pick-folder', async () => {
        const r = await dialog.showOpenDialog(win, {
            title: '选择文件夹',
            properties: ['openDirectory', 'createDirectory'],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
        return { ok: true, path: r.filePaths[0] };
    });

    /** 读设置注入 mpv 视频缓冲缓存偏好（启动时与设置变更时调用）。 */
    function applyPlayerCache() {
        const m = settings.get('playerCacheMode') === 'disk' ? 'disk' : 'memory';
        mpv.cacheMode = m;
        mpv.cacheDir = m === 'disk' ? (settings.get('playerCacheDir') || settings.defaultCacheDir()) : '';
    }

    /**
     * 设置 mpv 视频缓冲缓存模式/目录：
     * - mode='disk' 且 dir 非空：mkdir + 持久化 playerCacheDir；与旧目录不同则清理旧目录残留（换路径清缓存）。
     * - mode='disk' 且 dir 为空：沿用已记忆目录（还原上次的硬盘缓存目录）。
     * - mode='memory'：切回内存缓冲，清空原硬盘缓存目录残留。
     * 只清旧目录、不清新选择目录（防误删刚指定的目录内容）；返回 {ok, mode, dir, cleanedBytes}。
     */
    ipcMain.handle('vpc:set-player-cache', (_e, mode, dir) => {
        const m = mode === 'disk' ? 'disk' : 'memory';
        const prevDir = settings.get('playerCacheDir') || settings.defaultCacheDir();
        let cleanedBytes = 0;
        let newDir = '';
        if (m === 'disk') {
            newDir = String(dir || '').trim() || prevDir;
            try { fs.mkdirSync(newDir, { recursive: true }); } catch (e) { return { ok: false, reason: 'dir-invalid' }; }
            if (newDir !== prevDir) cleanedBytes = clearDiskCache(prevDir);
        } else {
            cleanedBytes = clearDiskCache(prevDir);
            newDir = '';
        }
        settings.set('playerCacheMode', m);
        if (m === 'disk') settings.set('playerCacheDir', newDir);
        mpv.cacheMode = m;
        mpv.cacheDir = m === 'disk' ? newDir : '';
        return { ok: true, mode: m, dir: mpv.cacheDir, cleanedBytes };
    });

    // 清空 mpv 硬盘缓存（不改变模式/目录；正被占用文件跳过）
    ipcMain.handle('vpc:clear-player-cache', () => {
        const dir = settings.get('playerCacheDir') || settings.defaultCacheDir();
        const cleanedBytes = clearDiskCache(dir);
        return { ok: true, cleanedBytes };
    });

    // 恢复默认设置：清偏好类键（保留收藏/历史/源/凭据等数据），重启应用确保全量生效
    ipcMain.handle('vpc:settings-reset', () => {
        settings.reset(['favorites', 'history', 'lastConfigUrl', 'configHistory', 'customLives', 'dlDir', 'cacheDir', 'playerCacheMode', 'playerCacheDir', 'watchStats', 'recentWatches', 'bangumiToken']);
        // app.exit(0) 不触发 before-quit，须先停 mpv 避免残留后台进程
        if (mpv.playing) mpv.stop();
        app.relaunch();
        isQuitting = true;
        app.exit(0);
        return { ok: true };
    });
    // 代理设置（2.9）：写入环境变量（后端 requests 继承）+ Electron session 代理（渲染层图片/请求），并重启后端使生效
    ipcMain.handle('vpc:set-proxy', async (_e, opts) => {
        const url = String((opts && opts.url) || '').trim();
        const enable = !!(opts && opts.enable);
        settings.set('proxyUrl', url);
        settings.set('proxyEnable', enable);
        try {
            if (enable && url) {
                process.env.HTTP_PROXY = url;
                process.env.HTTPS_PROXY = url;
                await session.defaultSession.setProxy({ proxyRules: url });
            } else {
                delete process.env.HTTP_PROXY;
                delete process.env.HTTPS_PROXY;
                // 显式还原系统代理（T73）：proxyRules:'' 在部分 Electron 版本下不还原，渲染层网络仍走旧代理
                await session.defaultSession.setProxy({ mode: 'system' });
            }
        } catch (e) { /* session 代理失败不影响主流程 */ }
        // 后端重启使 Python requests 应用代理（播放/下载在主进程不受影响）
        try { bridge.stop(); bridge.start(); } catch (e) { /* 重启失败下次自愈 */ }
        return { ok: true };
    });
    /** 合并 aria2 实时任务 + HLS 任务 + 持久化记录（T46）：
     *  持久化记录仅补「本会话不存在的 gid」（应用重启后 aria2c 丢失 stopped 记录，
     *  更换下载目录重启引擎同理），避免与实时任务重复。 */
    function buildDlList(items, hlsItems) {
        const live = [...items, ...hlsItems];
        const liveGids = new Set(live.map((t) => t.gid));
        const restored = dlRecords.all()
            .filter((r) => !liveGids.has(r.gid))
            .map((r) => ({
                gid: r.gid, status: r.status === 'error' ? 'error' : 'complete',
                kind: r.kind, name: r.name, files: r.files || [],
                total: r.size || 0, done: r.size || 0, percent: 100, speed: 0,
                connections: '', errorMessage: r.status === 'error' ? (r.errorMessage || '') : '',
            }));
        return [...live, ...restored];
    }

    function startDlPoll() {
        if (dlTimer) return;
        // 启动即推一次：空闲自停机制下，进入下载页仍能立刻看到历史任务列表
        (async () => {
            try {
                let items = [];
                try { items = await dl.listAll(); } catch (e) { /* aria2 未就绪 */ }
                send('vpc:dl-list', buildDlList(items, hls.list()));
            } catch (e) { /* ignore */ }
        })();
        dlTimer = setInterval(async () => {
            try {
                // aria2 任务 + m3u8 合成任务合并推送（aria2 未就绪不阻断 HLS 展示）
                let items = [];
                try { items = await dl.listAll(); } catch (e) { /* 下一轮会重新拉起 aria2c */ }
                const hlsItems = hls.list();
                send('vpc:dl-list', buildDlList(items, hlsItems));
                // 空闲自停（T10 泄漏/功耗审计）：无进行中任务时停掉 1s 轮询，下次 add 时重新拉起
                const busy = items.some((t) => ['active', 'waiting', 'paused'].includes(t.status))
                    || hlsItems.some((t) => t.status === 'active');
                if (!busy) { clearInterval(dlTimer); dlTimer = null; }
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
                    await dl.start(dir,
                        parseInt(settings.get('dlConcurrency'), 10) || undefined,
                        parseInt(settings.get('dlSplitConcurrency'), 10) || undefined);
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
                        gid = hls.add({
                            url: uri, out: payload.out, header: payload.header,
                            // 广告过滤开关（设置项 hlsAdFilter，默认关；开启时过滤 CUE-OUT/CUE-IN 广告分段）
                            adFilter: payload.adFilter !== undefined ? !!payload.adFilter : settings.get('hlsAdFilter'),
                        });
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
                case 'setSplit': {
                    const n = Math.max(1, Math.min(32, parseInt(payload.n, 10) || 5));
                    settings.set('dlSplitConcurrency', n);
                    if (dl.isAvailable()) await dl.setSplit(n);
                    return { ok: true, n };
                }
                case 'pause':
                    if (String(payload.gid).startsWith('hls-')) return { ok: false, reason: 'm3u8 合成任务不支持暂停，可直接删除' };
                    await dl.pause(payload.gid); return { ok: true };
                case 'unpause':
                    if (String(payload.gid).startsWith('hls-')) return { ok: false, reason: 'not-supported' };
                    await dl.unpause(payload.gid); return { ok: true };
                case 'remove':
                    // 同步删除持久化记录（T46），防止重启后「删除的任务又复活」
                    dlRecords.remove(payload.gid);
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
                    dlRecords.clearErrors(); // 同步清掉失败记录
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
                    dlRecords.clear(); // 同步清掉持久化记录（T46）
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
        dlRecords.add({ gid: task.gid, kind: 'aria2', name: task.name, files: task.files,
            size: task.total || 0, status: 'complete', completedAt: Date.now() });
        send('vpc:dl-event', { type: 'completed', task });
    });
    dl.on('error', (task) => {
        dlRecords.add({ gid: task.gid, kind: 'aria2', name: task.name, files: task.files,
            size: task.total || 0, status: 'error', errorMessage: task.errorMessage || '', completedAt: Date.now() });
        send('vpc:dl-event', { type: 'error', task });
    });
    // m3u8 合成任务完成/失败：与 aria2 同一套通知链路
    hls.on('completed', (task) => {
        if (Notification.isSupported()) {
            const n = new Notification({ title: '下载完成（m3u8 已合成）', body: task.name });
            n.on('click', () => { if (win) { win.show(); win.focus(); send('vpc:dl-goto', {}); } });
            n.show();
        }
        dlRecords.add({ gid: task.gid, kind: 'hls', name: task.name, files: task.files,
            size: 0, status: 'complete', completedAt: Date.now() });
        send('vpc:dl-event', { type: 'completed', task });
    });
    hls.on('error', (task) => {
        dlRecords.add({ gid: task.gid, kind: 'hls', name: task.name, files: task.files,
            size: 0, status: 'error', errorMessage: task.errorMessage || '', completedAt: Date.now() });
        send('vpc:dl-event', { type: 'error', task });
    });

    // 播放事件 → 渲染层（连播由渲染层在 mpv 退出后推进；附退出进度供「看完」判定）
    mpv.on('ended', (info) => send('vpc:player-ended', info));
    // mpv 进程异步启动失败（ENOENT/EACCES：文件被删/损坏/无权限）：友好告知渲染层，不崩溃、不静默
    mpv.on('spawn-error', (info) => {
        send('vpc:player-spawn-error', {
            code: (info && info.code) || 'unknown',
            reason: 'mpv-missing',
        });
    });
    mpv.on('exit', (info) => {
        const userStopped = !!(info && info.userStopped);
        send('vpc:player-exit', {
            pos: (info && typeof info.pos === 'number') ? info.pos : null,
            duration: (info && typeof info.duration === 'number') ? info.duration : null,
            sessionId: (info && typeof info.sessionId === 'number') ? info.sessionId : 0,
            fullscreen: (info && typeof info.fullscreen === 'boolean') ? info.fullscreen : null,
            speed: (info && typeof info.speed === 'number') ? info.speed : null,
            quit: userStopped, // 用户主动关闭（stop() 或 mpv 窗口关闭）：渲染层据此不等待断流重连、不连播
        });
        // 用户主动关闭播放器：绝不自动重连（否则关窗会被误判为断流而重播）
        if (userStopped) return;
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
            new Notification({ title: 'YuKi', body: '播放被中断，正在自动重连…' }).show();
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
    bridge.extraEnv.VPC_LOG_DIR = LOG_DIR;
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
    // 视频缓冲缓存（内存/硬盘）：读设置注入播放器（起播时按模式追加 --cache-on-disk 参数）
    applyPlayerCache();
    // 代理（2.9）：启动时按设置写入环境变量，供 Python 后端 requests 继承（重启后端即生效）
    const proxyUrl = settings.get('proxyUrl') || '';
    if (settings.get('proxyEnable') && proxyUrl) {
        process.env.HTTP_PROXY = proxyUrl;
        process.env.HTTPS_PROXY = proxyUrl;
    }
    // ffmpeg 内置：启动后台自动补齐（m3u8 下载合成与本地预览图依赖；缺失时静默降级）
    ensureFfmpeg().catch(() => { });
    // 内置 MiSans 字体就绪探测（打包内置，无运行时下载；渲染层经 vpc:font-css 注入，T61）
    misans.ensureMisans().catch(() => { });
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

    // SyncPlay 事件转发到渲染层
    syncplay.on('state', (info) => send('vpc:syncplay-state', info));
    syncplay.on('chat', (info) => send('vpc:syncplay-chat', info));
    syncplay.on('file', (info) => send('vpc:syncplay-file', info));
    syncplay.on('users', (info) => send('vpc:syncplay-users', info));
    syncplay.on('disconnect', () => send('vpc:syncplay-disconnect', {}));
    syncplay.on('error', (err) => send('vpc:syncplay-error', { message: String(err.message || err) }));

    // DLNA 事件转发
    dlna.on('devices', (devices) => send('vpc:dlna-devices', devices));
    dlna.on('error', (err) => send('vpc:dlna-error', { message: String(err.message || err) }));

    // SyncPlay IPC
    ipcMain.handle('vpc:syncplay-connect', async (_e, opts) => {
        try {
            await syncplay.connect(opts.server, opts.port, opts.username, opts.room, opts.useTls !== false);
            return { ok: true };
        } catch (e) { return { ok: false, reason: e.message }; }
    });
    ipcMain.handle('vpc:syncplay-disconnect', () => { syncplay.disconnect(); return { ok: true }; });
    ipcMain.handle('vpc:syncplay-state', (_e, pos, paused, seek) => { syncplay.sendState(pos, paused, seek); return { ok: true }; });
    ipcMain.handle('vpc:syncplay-file', (_e, name, duration) => { syncplay.sendFile(name, duration); return { ok: true }; });
    ipcMain.handle('vpc:syncplay-chat', (_e, msg) => { syncplay.sendChat(msg); return { ok: true }; });

    // DLNA IPC
    ipcMain.handle('vpc:dlna-search', async () => {
        try { await dlna.search(); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
    });
    ipcMain.handle('vpc:dlna-cast', async (_e, deviceUrl, mediaUrl, title) => {
        try { await dlna.cast(deviceUrl, mediaUrl, title); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
    });
    ipcMain.handle('vpc:dlna-stop', async (_e, deviceUrl) => {
        try { await dlna.stop(deviceUrl); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
    });

    // ---- 外部播放器 ----
    ipcMain.handle('vpc:external-player', async (_e, url, opts) => {
        const header = (opts && opts.header) || {};
        const title = (opts && opts.title) || '外部播放';
        // 生成临时 m3u8/mp4 播放列表或直接传 URL
        // Windows: 用系统默认程序打开；带 Referer 时无法用系统播放器，需用户指定 VLC 路径
        let extPlayer = settings.get('externalPlayerPath') || '';
        // 自动探测 PATH 中的 VLC
        if (!extPlayer) {
            try {
                const { execSync } = require('child_process');
                if (process.platform === 'win32') {
                    const out = execSync('where vlc', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
                    extPlayer = out.split(/\r?\n/)[0] || '';
                } else {
                    const out = execSync('which vlc', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
                    extPlayer = out || '';
                }
            } catch (e) { /* PATH 中无 VLC */ }
        }
        if (!extPlayer) {
            // 用系统默认程序打开（不带 Referer）
            try {
                await shell.openExternal(url);
                return { ok: true, via: 'system-default' };
            } catch (e) { return { ok: false, reason: 'no-external-player' }; }
        }
        // 用 VLC 打开（支持 Referer via --http-header-fields）
        const args = [url];
        if (header.Referer || header['User-Agent']) {
            const pairs = [];
            if (header.Referer) pairs.push(`Referer: ${header.Referer}`);
            if (header['User-Agent']) pairs.push(`User-Agent: ${header['User-Agent']}`);
            args.push(`--http-header-fields=${pairs.join(',')}`);
        }
        args.push(`--no-video-title-show`);
        try {
            const { spawn } = require('child_process');
            spawn(extPlayer, args, { detached: true, stdio: 'ignore' }).unref();
            return { ok: true, via: extPlayer };
        } catch (e) { return { ok: false, reason: e.message }; }
    });

    ipcMain.handle('vpc:pick-external-player', async () => {
        const r = await dialog.showOpenDialog(win, {
            title: '选择外部播放器（如 VLC/PotPlayer）',
            filters: [{ name: '可执行文件', extensions: ['exe', 'app', ''] }],
            properties: ['openFile'],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
        const p = r.filePaths[0];
        settings.set('externalPlayerPath', p);
        return { ok: true, path: p };
    });

    // ---- 定时关机 ----
    let shutdownTimer = null;
    ipcMain.handle('vpc:shutdown-timer', (_e, minutes) => {
        if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
        if (!minutes || minutes <= 0) return { ok: true, msg: '已取消定时关机' };
        shutdownTimer = setTimeout(() => {
            // 播放停止后关机：先停 mpv 再关机
            mpv.stop();
            setTimeout(() => {
                const { exec } = require('child_process');
                if (process.platform === 'win32') {
                    exec('shutdown /s /t 60 /c "YuKi 定时关机"');
                } else if (process.platform === 'darwin') {
                    exec('osascript -e \'tell app "System Events" to shut down\'');
                } else {
                    exec('shutdown -h +1');
                }
            }, 2000);
        }, minutes * 60 * 1000);
        return { ok: true, msg: `已设定 ${minutes} 分钟后关机` };
    });

    // ---- 日志查看器 ----
    ipcMain.handle('vpc:get-logs', async (_e, page, pageSize, source) => {
        return readRecentLogs(LOG_DIR, page, pageSize, source);
    });
    // 清空日志（当前进程日志句柄继续写新文件）
    ipcMain.handle('vpc:clear-logs', async () => clearLogs(LOG_DIR));
    // 渲染端错误上报：window.onerror / unhandledrejection 转发进 electron-main.log（redactSecrets 由 writer 负责）
    ipcMain.handle('vpc:log-renderer', (_e, level, message) => {
        const lvl = String(level || 'ERROR').toUpperCase();
        console[lvl === 'WARN' ? 'warn' : 'error'](`[renderer] ${message}`);
        return { ok: true };
    });

    // ---- 首次引导状态 ----
    ipcMain.handle('vpc:onboarding-done', () => {
        settings.set('onboarded', true);
        return { ok: true };
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    // 托盘驻留模式（win.hide 不触发；destroy 后才到这里）：保活不停 mpv
    // 只有 isQuitting=true 时才真正退出，否则保留托盘驻留
    if (!isQuitting) return;
    mpv.stop();
    dl.stop();
    pushServer.stop();
    try { syncplay.disconnect(); } catch (e) { /* ignore */ }
    bridge.stop();
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (dlTimer) { clearInterval(dlTimer); dlTimer = null; }
    mpv.stop();
    dl.stop();
    pushServer.stop();
    try { syncplay.disconnect(); } catch (e) { /* ignore */ }
    bridge.stop();
});

// 全局未捕获异常兜底：防进程崩溃导致窗口消失
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});
