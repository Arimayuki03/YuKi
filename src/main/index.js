/**
 * index.js — Electron 主进程入口
 *
 * 生命周期：拉起 Python 后端（python-bridge）→ 创建窗口 → 通过 IPC
 * 向渲染进程提供 backend-info。
 * Phase 4：yuki:play 由 mpv-player 接管（缺失时返回 ok:false 走 HTML5 降级）。
 * Phase 5：本地文件管理走 file-manager（白名单根目录 + 防穿越），
 * 本地视频播放复用 mpv-player。
 * Phase 6：下载管理走 downloader（aria2c JSON-RPC），1s 轮询推送进度，
 * 完成发系统通知，一键播放复用 mpv-player；下载目录可更换并持久化。
 * Phase 7：URL 推送（push-server 局域网端口）、设置持久化（settings.js，
 * config URL 自动重载 + 播放偏好）、VIP 解析隐藏窗口（parse-window.js）。
 * UX 批次：弹幕轮询已移除（用户不再需要）；启动自动重载状态经
 * yuki:config-state 提供给渲染层（修复首屏停留示例源需手动刷新）；
 * 播放失败只返回失败原因和实际播放地址，不自动切换其它线路。
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
const { PlaylistProxy } = require('./playlist-proxy');

// 模块级注册：无论 setup 流程走到哪里，渲染层调用都不会悬空 pending
ipcMain.handle('yuki:playlist-build', (_e, queue) => {
    if (!playlistProxyRef) return { ok: false, reason: 'playlist proxy not ready' };
    const q = queue || {};
    // 页面解析型线路（曾解析出 parse=1）：直接拒绝建队，渲染层静默回退逐集
    if (pageQueueBan.has(`${q.site || ''}|${q.flag || ''}`)) {
        return { ok: false, reason: 'page-route' };
    }
    return playlistProxyRef.register(q).then((r) => {
        console.log(`[播放列表] 构建：ok=${!!(r && r.ok)} entries=${(r && r.entries && r.entries.length) || 0}` +
            `${r && r.reason ? ' reason=' + r.reason : ''} kind=${q.kind || 'catvod'}`);
        return r;
    });
});
const { MENU_CONF_ZH } = require('./mpv-menu-conf');
const FileManager = require('./file-manager');
const Downloader = require('./downloader');
const HlsDownloader = require('./hls-downloader');
const DlRecordStore = require('./dl-record');
const { DlDedupe, buildKey: buildEpisodeKey } = require('./dl-dedupe');
const { ensureFfmpeg, isEnsuring: ffmpegEnsuring, thumb: ffmpegThumb, urlThumb: ffmpegUrlThumb } = require('./ffmpeg');
const Settings = require('./settings');
const PushServer = require('./push-server');
const ParseWindow = require('./parse-window');
const { probeMedia, isLocalProxyStreamUrl } = require('./media-probe');
const SyncplayClient = require('./syncplay-client');
const DlnaCaster = require('./dlna-caster');
const { RotatingLogWriter, installConsoleLogger, readRecentLogs, clearLogs, setLogLevel, startScheduledLogCleanup, stopScheduledLogCleanup } = require('./logger');
const { formatAndValidateProxyUrl, setManualProxySource, invalidateCache } = require('./system-proxy');
const PanQr = require('./pan-qr');
const PanQrWindow = require('./pan-qr-window');
const misans = require('./misans');
const { setupAutoUpdater } = require('./updater');

// ---- 数据目录迁移（项目改名 video-pc → yuki）----
// 历史版本：Electron userData=%APPDATA%\video-pc，日志/后端数据=~\.video-pc。
// 首次以新名启动时整体搬移，设置/历史/收藏/缓存无感延续；
// 目标目录已存在且非空则不动（避免覆盖新数据），失败不阻断启动。
function migrateLegacyDataDir(oldDir, newDir) {
    try {
        if (!oldDir || !newDir || oldDir === newDir) return;
        if (!fs.existsSync(oldDir)) return;
        if (!fs.existsSync(newDir)) {
            fs.renameSync(oldDir, newDir);
            console.log('[migrate] legacy data dir moved:', oldDir, '->', newDir);
            return;
        }
        // Electron 启动早期可能预创建空的 userData 目录：清掉空壳再搬
        if (fs.readdirSync(newDir).length === 0) {
            fs.rmdirSync(newDir);
            fs.renameSync(oldDir, newDir);
            console.log('[migrate] legacy data dir moved:', oldDir, '->', newDir);
        }
    } catch (e) {
        console.warn('[migrate] legacy data dir move failed:', oldDir, e && e.message);
    }
}
try {
    const ud = app.getPath('userData'); // %APPDATA%\yuki
    migrateLegacyDataDir(path.join(path.dirname(ud), 'video-pc'), ud);
} catch (e) { /* userData 不可得时跳过 */ }
migrateLegacyDataDir(
    path.join(os.homedir(), '.video-pc'),
    path.join(os.homedir(), '.yuki'),
);

// 媒体直链后缀：非直链 URL（share/播放页）先经隐藏窗口抓媒体请求再交 mpv
const MEDIA_URL = /\.(m3u8|mp4|flv|mov|mkv|webm|ts)(\?|#|$)/i;

// 后端最近一次 ready 的信息（base/token）：播放列表代理按需解析时惰性读取
let lastBackendInfo = null;
// 播放列表代理实例引用：IPC 处理器在模块加载期无条件注册（不依赖 setup 流程走到某一行），
// 实例化后回填引用；未就绪时显式返回失败而非让渲染层永久 pending。
let playlistProxyRef = null;
// 「页面解析型」线路黑名单（site|flag）：代理解析出 parse=1 时精确记录，
// 后续该线路不再建队列——只有这一类被禁止，m3u8 等直连线路不受影响。
const pageQueueBan = new Set();
// 外部播放器最近一次启动的子进程 pid：新启动前 kill 旧进程收敛为单窗口
// （外部播放器无 stop 句柄；kill 位于 spawn 前一刻的同步段，见 launchExternalPlayerItems）。
let lastExtLaunchPid = 0;
// 外部启动 single-flight：同播放意图（kind|site|title）的并发 yuki:play 复用
// 同一次在途启动——static 包装含 await（register/探测），渲染层竞态双发的两次
// IPC 在 await 间隙交错时，仅靠「spawn 前 kill 上一个 pid」仍可能各 spawn 一窗
// （A 完成记录 pid1 → B kill(pid1) → B spawn；但 A 的 spawn 若晚于 B 的 kill
// 检查则逃逸）。flight 保证同意图串行化，从源头消除并发第二窗。
let extLaunchFlight = { key: '', promise: null };

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

/** 当前设置对应的 mpv 右键菜单档位（'off' | 'a' | 'aa' | 'restore'）。
 *  菜单勾选态的唯一事实源：hints.lua 的静态初始值可能过期（默认开启在启动
 *  下载完成后才落地、设置被同步/恢复改写等），消费端必须以实时设置为准。 */
function anime4kMenuModeFromSettings() {
    if (!(settings && settings.get && settings.get('anime4k'))) return 'off';
    const raw = String(settings.get('anime4kMode') || 'a');
    return ANIME4K_CHAINS[raw] ? raw : 'off';
}

/** Anime4K 三档位的展示名（起播 toast / mpv OSD 提示共用）。 */
const ANIME4K_MODE_LABELS = { a: '均衡', aa: '细节增强', restore: '仅修复' };

/** 起播响应附 Anime4K 状态：是否生效 + 档位名（渲染层 toast 提示用；三条起播路径统一走这里）。 */
function attachAnime4kInfo(r) {
    if (!r || !r.ok) return r;
    r.anime4k = !!mpv.anime4kShaders;
    if (r.anime4k) {
        r.anime4kModeLabel = ANIME4K_MODE_LABELS[String(settings.get('anime4kMode') || 'a')] || '均衡';
    }
    return r;
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
                headers: { 'User-Agent': 'yuki/1.0' },
            });
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < ANIME4K_MIN_SIZE || !buf.toString('utf8').includes('Anime4K')) continue;
            // L-7:下载前确保父目录已建立,防 ENOENT
            fs.mkdirSync(path.dirname(dest), { recursive: true });
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
const LOG_DIR = path.join(os.homedir(), '.yuki', 'logs');
installConsoleLogger(LOG_DIR);
const bridge = new PythonBridge(ROOT, RESOURCES_ROOT, {
    logWriter: new RotatingLogWriter(path.join(LOG_DIR, 'python-console.log')),
});
const mpv = new MpvPlayer();
const dl = new Downloader();
const hls = new HlsDownloader();
const dlRecords = new DlRecordStore();
// 同源同集去重（dl-dedupe.js）：边下边播与手动下载共用。liveProvider 聚合
// aria2 + HLS 全量任务，仅在「记录声称进行中」时被调用做存活复核。
const dlDedupe = new DlDedupe(dlRecords, async () => {
    const [aria2Items, hlsItems] = await Promise.all([
        dl.isAvailable() ? dl.listAll().catch(() => []) : Promise.resolve([]),
        Promise.resolve(hls.list()),
    ]);
    return [...aria2Items, ...hlsItems].map((t) => ({ gid: t.gid, status: t.status }));
});
const pushServer = new PushServer();
const syncplay = new SyncplayClient();
const dlna = new DlnaCaster();
let fileMgr = null;    // app ready 后初始化（依赖 userData 路径）
let settings = null;   // app ready 后初始化（bridge 启动前，供读缓存目录等）
let parseWin = null;   // 同上
const runtimeAborts = new Map(); // requestId -> ParseWindow abort marker
let win = null;
let tray = null;       // 托盘图标（关闭→缩小至托盘时应用驻留）
let isQuitting = false; // 真正退出标志（托盘菜单“退出”置位，关窗拦截据此放行）
let dlTimer = null;
// 启动自动重载状态：渲染层经 yuki:config-state 轮询，避免首屏停留在示例源
const configReload = { reloading: false, url: '' };
// 缓存清理并发锁：clearAppCaches 会做多目录遍历+session.clearCache，禁止并行重复清理。
let _clearingAppCaches = false;

function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * mpv 硬盘缓存文件名模式：历史 disk 模式经 --demuxer-cache-dir 平铺写入 mpv-cache-<hex>.dat。
 * 硬盘缓存能力已移除（缓存只走内存，见 mpv-player._cacheArgs），此模式仅供启动时的
 * 一次性残留清理（migratePlayerCache）使用。
 */
const MPV_CACHE_FILE_RE = /^mpv-cache-.+\.dat$/i;

/**
 * 清空 mpv 硬盘缓存残留：递归遍历（兼容旧版可能的子目录结构），只删 mpv 缓存模式文件
 * （避免在用户曾自选的目录里误删无关文件），随之变空的子目录一并移除。
 * 逐文件 try/catch：被占用的文件跳过。返回成功释放的字节数（不含跳过文件）。
 * 唯一调用者是 migratePlayerCache（启动时一次性迁移）。
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
                    // 单次 stat 取大小后删除；占用文件跳过（不计入 cleaned）。
                    const size = fs.statSync(p).size;
                    fs.rmSync(p, { force: true });
                    cleaned += size;
                }
            } catch (e) { /* 单项失败/占用跳过，不影响整体 */ }
        }
    };
    walk(dir);
    return cleaned;
}

/**
 * 一次性迁移：抹掉历史「硬盘缓存」模式的痕迹（启动时调用）。
 *
 * 早期版本用 playerCacheMode/playerCacheDir 两个设置键控制 mpv 是否把视频缓冲写进磁盘
 * （--cache-on-disk=yes + --demuxer-cache-dir）。这两个键没有任何 UI 入口，一旦被写成
 * 'disk' 用户就无法自行关闭，并且**持久化值会压过代码默认值**——这正是「默认已改为内存
 * 但实测仍在写盘」的根因。硬盘缓存能力已整体移除（缓存只走内存），此处把残留清干净：
 * 删 mpv-cache-*.dat（只匹配该模式，不碰用户曾自选目录里的无关文件）+ 删两个键。
 *
 * 幂等：键不存在即直接返回，不需要额外的迁移标记键。
 */
function migratePlayerCache() {
    if (!settings) return;
    const hasMode = settings.get('playerCacheMode') !== undefined;
    const hasDir = settings.get('playerCacheDir') !== undefined;
    if (!hasMode && !hasDir) return;
    const dir = settings.get('playerCacheDir') || path.join(app.getPath('userData'), 'mpv-cache');
    let cleaned = 0;
    try { cleaned = clearDiskCache(dir); } catch (e) { /* 目录不可达/占用：键仍要删掉 */ }
    settings.delete('playerCacheMode');
    settings.delete('playerCacheDir');
    console.log(`[mpv] 已移除硬盘缓存设置残留（清理 ${cleaned} 字节 @ ${dir}），视频缓冲只走内存`);
}

/**
 * 统计目录大小：单次递归遍历累加文件字节数（不删除）。
 * @param {string} p 目录路径
 * @param {(name:string)=>boolean} [fileFilter] 可选文件名过滤（仅统计匹配文件）
 * @returns {{bytes:number, files:number}}
 */
function getDirSize(p, fileFilter) {
    let bytes = 0, files = 0;
    if (!p || !fs.existsSync(p)) return { bytes, files };
    const walk = (d) => {
        let ents;
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of ents) {
            const full = path.join(d, ent.name);
            try {
                if (ent.isDirectory()) walk(full);
                else if (!fileFilter || fileFilter(ent.name)) { bytes += fs.statSync(full).size; files += 1; }
            } catch (e) { /* 单项失败跳过 */ }
        }
    };
    walk(p);
    return { bytes, files };
}

/**
 * 清空目录内容：单次遍历，边累加大小边删除（避免先 dirSize 再 rm 的 O(n^2) 二次遍历）。
 * 目录本身保留，仅清其内容；占用文件跳过不计入释放字节。
 * @param {string} p 目录路径
 * @returns {{bytes:number, files:number}} 实际释放字节与删除文件数
 */
function purgeDir(p) {
    let bytes = 0, files = 0;
    if (!p || !fs.existsSync(p)) return { bytes, files };
    // 后序遍历：先删子内容并累加，再删空目录；避免删除后无法再 stat。
    const walk = (d) => {
        let ents;
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of ents) {
            const full = path.join(d, ent.name);
            try {
                if (ent.isDirectory()) {
                    walk(full);
                    try { fs.rmdirSync(full); } catch (e) { /* 仍有占用文件：保留 */ }
                } else {
                    const size = fs.statSync(full).size;
                    fs.rmSync(full, { force: true });
                    bytes += size; files += 1;
                }
            } catch (e) { /* 单文件失败/占用跳过 */ }
        }
    };
    walk(p);
    return { bytes, files };
}

/** 播放成功后的公共后处理：应用预设音量。 */
function afterPlay() {
    const vol = settings ? parseInt(settings.get('playerVolume'), 10) : 0;
    if (vol > 0) {
        setTimeout(() => { mpv.setVolume(vol).catch(() => { }); }, 1500);
    }
}

// 网盘首次解析/转存可能等待数秒；必须等到 mpv 真正加载媒体再向渲染层
// 返回成功，否则 502/404 会被误报成“已在 mpv 播放”。
const MPV_START_TIMEOUT_MS = 30000;

// yuki:play 整体兜底上限：正常最慢路径 ≈ 媒体探测 8s + 解析竞速 15s/10s + mpv 起播 30s，
// 90s 远在其上；仅在某个子步骤意外挂死时触发，保证渲染层不会因 IPC 永不返回而一直转圈。
const PLAY_HANDLER_TIMEOUT_MS = 90000;

/** 给可能挂起的异步步骤加竞速上限：到时返回 fallback（后台任务不中断）。
 *  用于「结果不影响播放、但不能拖住响应」的次要步骤（如边下边播的 aria2 注册）。 */
function raceWithTimeout(promise, timeoutMs, fallback) {
    let timer = null;
    return Promise.race([
        Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
        new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
}

async function verifyMpvStart(result, timeoutMs = MPV_START_TIMEOUT_MS) {
    if (!result || !result.ok) return result || { ok: false, reason: 'mpv-start-failed' };
    const expectedGen = (typeof result.controlGen === 'number') ? result.controlGen : null;
    const ready = await mpv.waitForReady(result.sessionId, timeoutMs);
    if (ready && ready.ok) return { ...result, started: true };
    // waitForReady 期间如果用户另起了播放，当前请求已失去所有权；不能因为旧请求
    // 的超时再 stop()/重新接管播放，把用户刚点播的新内容杀掉。
    const active = mpv._activeSession;
    const activeIsAnotherRequest = !!(active && active.id !== result.sessionId);
    const generationChanged = expectedGen !== null && mpv.controlGen !== expectedGen;
    // 原生队列豁免代际抖动：队列起播窗口长（首集要经代理解析/抓流），期间旧进程
    // 延迟退出、杂散 stop() 都会 bump 代际——只要没有新会话接管（active 仍是自己），
    // 队列进程还活着就继续认定归属，否则会被误判 play-cancelled 而整队消失。
    if ((activeIsAnotherRequest || generationChanged)
        && !(result.nativeQueue && !activeIsAnotherRequest)) {
        return {
            ...result,
            ok: false,
            reason: 'play-cancelled',
            error: '',
        };
    }
    // 只停止仍属于本次会话的进程，避免旧 IPC/旧请求误杀用户刚启动的新会话。
    mpv.stop();
    return {
        ...result,
        ok: false,
        reason: (ready && ready.reason) || 'mpv-start-failed',
        error: (ready && ready.error) || '',
    };
}

function playerErrorCode(reason) {
    if (String(reason || '').startsWith('media-probe-')) {
        if (reason === 'media-probe-probe-timeout') return 'L5_MEDIA_PROBE_TIMEOUT';
        if (reason === 'media-probe-probe-cancelled') return 'L5_MEDIA_PROBE_CANCELLED';
        return 'L5_MEDIA_PROBE_FAILED';
    }
    if (reason === 'mpv-missing') return 'L6_PLAYER_MISSING';
    if (reason === 'mpv-start-timeout') return 'L6_PLAYER_START_TIMEOUT';
    if (reason === 'play-cancelled') return 'L6_PLAYER_CANCELLED';
    return 'L6_PLAYER_START_FAILED';
}

function withPlayerTrace(result, meta = {}) {
    const value = (result && typeof result === 'object') ? { ...result } : { ok: false, reason: 'mpv-start-failed' };
    if (meta.requestId) value.requestId = String(meta.requestId);
    if (meta.playSessionId) value.playSessionId = String(meta.playSessionId);
    if (!value.ok && !value.launched) {
        const code = playerErrorCode(String(value.reason || ''));
        value.runtimeError = {
            code, stage: 'player', retryable: !['L6_PLAYER_MISSING'].includes(code),
            message: String(value.error || value.reason || '播放器启动失败').slice(0, 240),
        };
    }
    return value;
}

function traceLocalProxy(url, meta = {}) {
    try {
        const parsed = new URL(String(url || ''));
        if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) || parsed.pathname !== '/proxy') return url;
        if (meta.requestId) parsed.searchParams.set('requestId', String(meta.requestId));
        if (meta.playSessionId) parsed.searchParams.set('playSessionId', String(meta.playSessionId));
        return parsed.toString();
    } catch (e) { return url; }
}

/** 是否为禁止边下边播的动态取流目标（网盘资源全局禁止，与开关设置无关）：
 *  1) 本机 go-proxy 端点——do=pan（网盘取流）、do=py/js/jar 或带 siteKey
 *     （蜘蛛代理流）、?url=（直链转发包装）：背后是按需解析的动态会话，
 *     上游可能回转码 m3u8 播放列表文本或短时效签名地址，交给下载引擎只能
 *     得到转发包装/残缺分片；
 *  2) 站点名命中网盘特征——兜底捕获蜘蛛直接回 CDN 签名直链的形态
 *     （正则与 player.js 原生队列的 isPanSource 排除规则保持一致）。 */
function isDynamicProxyStream(url, meta = {}) {
    try {
        const parsed = new URL(String(url || ''));
        if (['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) && parsed.pathname === '/proxy') {
            const doParam = (parsed.searchParams.get('do') || '').toLowerCase();
            if (['pan', 'py', 'js', 'jar'].includes(doParam)) return true;
            if (parsed.searchParams.has('siteKey') || parsed.searchParams.has('url')) return true;
        }
    } catch (e) { /* 非 URL 形态：仅按站点名判断 */ }
    return /pan|quark|uc网盘|aliyun|ali|115|123|天翼|移动|网盘/i
        .test(`${String(meta.site || '')}|${String(meta.source || '')}`);
}

function createWindow() {
    // 系统标题栏开关（默认使用自定义标题栏以获得更现代的外观）
    const useSystemTitleBar = settings.get('systemTitleBar') === true;
    win = new BrowserWindow({
        width: 1480,
        height: 900,
        minWidth: 960,
        minHeight: 600,
        frame: useSystemTitleBar,
        titleBarStyle: useSystemTitleBar ? 'default' : 'hidden',
        backgroundColor: '#121212',
        title: 'YuKi',
        icon: require('./app-icon').windowIcon(), // 预缩多表示图标（exe 图标插值缩会糊/残缺）
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
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
        if (cmd === 'browser-backward') send('yuki:mouse-nav', { dir: 'back' });
        else if (cmd === 'browser-forward') send('yuki:mouse-nav', { dir: 'forward' });
    });
}

// ---------------------------------------------------------------- 托盘

/**
 * 托盘图标三级兜底：
 * 1) assets/tray/tray-{16,20,24,32}.png——由 scripts/make-tray-icons.ps1 从应用图标
 *    最近邻预缩（保住像素画硬边），按屏幕 DPI(100%/125%/150%/200%) 自动选用；
 * 2) assets/icon.png 运行时直接缩放（次优，插值会略糊）；
 * 3) 程序绘制 16x16 像素播放三角（资源全丢时的最后保障）。
 */
function makeTrayIcon() {
    try {
        const img = nativeImage.createEmpty();
        const reps = [[16, 1], [20, 1.25], [24, 1.5], [32, 2]];
        let loaded = 0;
        for (const [size, scale] of reps) {
            const p = path.join(app.getAppPath(), 'assets', 'tray', `tray-${size}.png`);
            if (!fs.existsSync(p)) continue;
            img.addRepresentation({ scaleFactor: scale, buffer: fs.readFileSync(p) });
            loaded++;
        }
        if (loaded > 0 && !img.isEmpty()) return img;
    } catch (e) { /* 落入下一级兜底 */ }
    try {
        const p = path.join(app.getAppPath(), 'assets', 'icon.png');
        if (fs.existsSync(p)) {
            const img = nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
            if (!img.isEmpty()) return img;
        }
    } catch (e) { /* 落入程序绘制兜底 */ }
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

// 单实例锁：第二个实例直接退出。双开会让两套 Electron 主/渲染进程各拉起一个
// yuki-backend 后端（Worker 池也各自独立），进程数与内存压力整体翻倍；低配机型
// 尤其不可接受。重复启动时唤起已有主窗口。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (win && !win.isDestroyed()) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        } else {
            createWindow();
        }
    });
}

app.whenReady().then(() => {
    ipcMain.handle('backend-info', () => bridge.getInfo());
    ipcMain.handle('yuki:config-state', () => ({ ...configReload }));
    ipcMain.handle('yuki:app-version', () => app.getVersion());

    // ---- 夸克网盘扫码登录（官方页面方案，见 pan-qr-window.js）----
    // 打开官方落地页登录窗口，官方 JS 完成全部流程后收割完整 Cookie（含 __puus）。
    ipcMain.handle('yuki:pan-qr-login', async () => {
        try {
            const result = await PanQrWindow.openLoginWindow();
            return { ok: true, cookies: result.cookies };
        } catch (e) {
            return { ok: false, message: String((e && e.message) || e).slice(0, 200) };
        }
    });
    ipcMain.handle('yuki:pan-qr-cancel', async () => {
        PanQrWindow.closeLoginWindow();
        return { ok: true };
    });

    // 内置 MiSans 字体 CSS 的 file:// URL（渲染层注入 <link>；打包内置，无运行时下载，T61）
    ipcMain.handle('yuki:font-css', () => misans.fontCssUrls());
    // 窗口控制（无边框模式下渲染层调用）
    ipcMain.handle('yuki:win-minimize', () => { if (win) win.minimize(); return { ok: true }; });
    ipcMain.handle('yuki:win-maximize', () => { if (!win) return { ok: false }; if (win.isMaximized()) win.unmaximize(); else win.maximize(); return { ok: true, maximized: win.isMaximized() }; });
    ipcMain.handle('yuki:win-close', () => { if (win) win.close(); return { ok: true }; });
    // 资产就绪状态查询（设置页展示 ffmpeg/mpv/aria2/Anime4K 是否就绪）
    ipcMain.handle('yuki:asset-status', () => {
        const ffmpegPath = require('./ffmpeg').findFfmpeg();
        // binary 可能被起播拦截清空（文件丢失/spawn 失败），查询资产状态时重探一次，
        // 避免一次失败后设置页永远显示「未安装」（findMpv 现含 userData\vendor 候选）
        if (!mpv.binary) mpv.resetBinary();
        const mpvAvail = mpv.isAvailable();
        const aria2exe = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';
        const aria2Path = (() => {
            const vendorAria2 = path.join(RESOURCES_ROOT, 'vendor', 'aria2', aria2exe);
            if (fs.existsSync(vendorAria2)) return vendorAria2;
            try {
                if (process.platform === 'win32') {
                    const out = require('child_process').execSync('where aria2c', { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
                    return out.split(/\r?\n/)[0] || '';
                }
            } catch (e) { /* not in PATH */ }
            return '';
        })();
        // 三档位所需着色器全集（去重）均就绪才算 Anime4K 可用（T8 后不再有单一 FILES 清单）
        const anime4kFiles = [...new Set(Object.values(ANIME4K_CHAINS).flat())];
        const anime4kOk = anime4kFiles.every((f) => anime4kFileOk(path.join(RESOURCES_ROOT, 'vendor', 'anime4k', f)));
        const mpvPath = mpv.binary || '';
        // Java 运行时探测（jar spider 源需要）：复用后端 java_probe 逻辑会在主进程查询后端
        const hasJava = (() => {
            try {
                const execSync = require('child_process').execSync;
                const out = execSync('java -version 2>&1', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true });
                return /version\s+"[^"]+"/.test(String(out || ''));
            } catch (e) { return false; }
        })();
        return {
            ffmpeg: { ready: !!ffmpegPath, downloading: require('./ffmpeg').isEnsuring() },
            mpv: { ready: mpvAvail, path: mpvPath },
            aria2: { ready: !!aria2Path },
            anime4k: { ready: anime4kOk },
            java: { ready: hasJava },
        };
    });

    // mpv 起播资产：lua 快捷键提示脚本 + input.conf 自定义步长（设置页可调），
    // 均写 userData 供 --scripts-append / --input-conf 加载；改步长后经 yuki:update-hotkeys 重写。
    // input.conf 合并用户全局键位：--input-conf 会取代 mpv 默认 input.conf 加载（而不是追加），
    // 因此生成文件里保留用户自己的 input.conf 行，且放在应用段之后（mpv 同键后绑定优先 → 用户自定义不被覆盖）。
    const YUKI_CONF_MARK = '# ---- yuki custom bindings ----';
    const YUKI_CONF_END = '# ---- yuki custom bindings end ----';
    // 改名前（video-pc 时代）写入用户全局 input.conf 的段标记：
    // 老用户全局文件里仍是旧标记，读取时一并剔除，避免旧键位残留覆盖用户自定义。
    const LEGACY_CONF_MARK = '# ---- video-pc custom bindings ----';
    const LEGACY_CONF_END = '# ---- video-pc custom bindings end ----';

    /** 用户全局 mpv input.conf 路径：WIN %APPDATA%\mpv\input.conf；POSIX ~/.config/mpv/input.conf。 */
    function getUserMpvInputConfPath() {
        return process.platform === 'win32'
            ? path.join(process.env.APPDATA || '', 'mpv', 'input.conf')
            : path.join(os.homedir(), '.config', 'mpv', 'input.conf');
    }

    /** 读用户全局 input.conf 并剔除本应用旧版写入的 yuki 段，返回用户原始行（写坏不阻断）。 */
    function readUserMpvInputConf() {
        try {
            const p = getUserMpvInputConfPath();
            if (!fs.existsSync(p)) return [];
            const lines = String(fs.readFileSync(p, 'utf8')).split(/\r?\n/);
            const out = [];
            let inSection = false;
            for (const ln of lines) {
                const t = ln.trim();
                if (t === YUKI_CONF_MARK || t === LEGACY_CONF_MARK) { inSection = true; continue; }
                if (t === YUKI_CONF_END || t === LEGACY_CONF_END) { inSection = false; continue; }
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
    // 文件信息走 mpv 内置 stats 脚本第 5 页（与右键菜单「文件信息」同源，见 mpv-menu-conf.js）。
    const HK_DEF_KEYS = {
        pause: 'SPACE', seekBack: 'LEFT', seekFwd: 'RIGHT',
        volUp: 'UP', volDown: 'DOWN', mute: 'm',
        speedDown: '[', speedUp: ']', speedReset: 'BS',
        frameBack: ',', frameFwd: '.', progress: 'o',
        fullscreen: 'f', screenshot: 's', fileInfo: 'i',
        audioCycle: 'a', subToggle: 'v', stopPlay: 'Ctrl+s',
        epPrev: 'PGUP', epNext: 'PGDWN', a4kCycle: 'K',
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
                    let v = hk.keys[id];
                    // 旧版误用 PGDN（mpv 键名为 PGDWN），静默迁移
                    if (v === 'PGDN') v = 'PGDWN';
                    if (hkKeyOk(v)) keys[id] = v;
                }
            }
            // Anime4K 初始档位（写进 hints lua 的 user-data，供菜单勾选态）；
            const a4kInitial = anime4kMenuModeFromSettings();
            const scriptDir = path.join(app.getPath('userData'), 'mpv-scripts');
            fs.mkdirSync(scriptDir, { recursive: true });
            // 清理全部遗留的临时清单/抓流产物（启动时尚无播放会话，可无条件删除）。
            // 不保留、不复用——残留文件一旦被当作清单展开，会导致集数虚增与匹配错位。
            try {
                const tmpDir = os.tmpdir();
                for (const f of fs.readdirSync(tmpDir)) {
                    if (/^yuki-playlist-\d+-\d+\.m3u8$/.test(f)
                        || /^kazumi_stream_\d+\.m3u8$/.test(f)) {
                        try { fs.rmSync(path.join(tmpDir, f), { force: true }); } catch (e) { /* 单个失败跳过 */ }
                    }
                }
            } catch (e) { /* 清扫失败不影响播放 */ }
            const lua = [
                // 文件名即 script-binding 命名空间：mpv 对脚本名做非字母数字→_ 归一化，
                // hints.lua → hints/，与 mpv-menu-conf.js 的 hints/a4k-<mode> 引用严格对应
                // （此前用 yuki-hints.lua 时实际命名空间是 yuki_hints，菜单点击全部落空）。
                '-- hints.lua：快捷键提示 + Anime4K 右键菜单信号（YuKi 自动生成，勿手改）',
                // 加载即写哨兵：主进程 _verifyA4kBindings 读此属性判定脚本存活——
                // 无默认键的绑定只注册为输入节区，不会出现在 input-bindings，无法据此探测。
                'mp.set_property("user-data/yuki/hints-loaded", "1")',
                // Anime4K 档位信号：菜单项 script-binding hints/a4k-<mode> 只写 user-data，
                // 档位应用/持久化/OSD 回显由主进程消费 a4k-request 完成；顶层写入当前档位，
                // 右键菜单勾选态首启即正确（无需运行时握手）。
                `mp.set_property("user-data/yuki/a4k-mode", "${a4kInitial}")`,
                'for _, m in ipairs({ "off", "a", "aa", "restore" }) do',
                '  mp.add_key_binding(nil, "a4k-" .. m, function()',
                '    mp.set_property("user-data/yuki/a4k-request", m)',
                '  end)',
                'end',
                'mp.add_key_binding(nil, "ep-prev", function()',
                '  mp.set_property("user-data/yuki/ep-skip", "-1")',
                'end)',
                'mp.add_key_binding(nil, "ep-next", function()',
                '  mp.set_property("user-data/yuki/ep-skip", "1")',
                'end)',
                'mp.add_key_binding(nil, "a4k-cycle", function()',
                '  local arr = { "off", "a", "aa", "restore" }',
                '  local pos = { off = 1, a = 2, aa = 3, restore = 4 }',
                // 必须用 native 读：实测 vendor 内置 mpv（v0.41.0-744 自建版）的 Lua
                // 字符串 API 读 user-data/* 会返回带字面双引号的值（'"a"'），pos[cur]
                // 永远查不到 → K 键循环恒落回第一档（表现为档位固定不变）；
                // get_property_native 在新旧版本均返回干净字符串。
                '  local cur = mp.get_property_native("user-data/yuki/a4k-mode") or "off"',
                '  local idx = pos[cur] or 1',
                '  mp.set_property("user-data/yuki/a4k-request", arr[(idx % #arr) + 1])',
                'end)',
                'mp.register_event("file-loaded", function()',
                'end)',
                // 注意 observe_property 类型串必须是 "bool"："boolean" 非法会让脚本主 chunk
                // 直接崩溃，连带销毁已注册的 a4k-* 绑定（右键切档因此整体失效过）。
                'mp.observe_property("pause", "bool", function(_, v)',
                '  if v ~= nil then mp.osd_message(v and "已暂停" or "继续播放", 1.5) end',
                'end)',
                'mp.observe_property("mute", "bool", function(_, v)',
                '  if v ~= nil then mp.osd_message(v and "已静音" or "取消静音", 1.5) end',
                'end)',
                '',
            ].join('\n');
            fs.writeFileSync(path.join(scriptDir, 'hints.lua'), lua, 'utf8');
            // input.conf：键位取自设置（mpv 语法：add speed 支持小数步长），动作附中文 show-text 反馈。
            // 同键重复只留首个；用户全局 input.conf 已绑定的键不写入应用段，用户行追加在后（同键以用户为准）。
            const userLines = readUserMpvInputConf();
            const userKeys = inputConfBoundKeys(userLines);
            const bindings = [
                // 上/下集走信号通道（hints/ep-*）：原生队列在 mpv 列表内跳集，
                // 逐集会话转发渲染层推进——单集会话里 playlist-next 会直接退出 mpv，不可直绑
                [keys.epPrev, 'script-binding hints/ep-prev', '上一集'],
                [keys.epNext, 'script-binding hints/ep-next', '下一集'],
                [keys.a4kCycle, 'script-binding hints/a4k-cycle', ''],
                [keys.pause, 'cycle pause', ''],
                [keys.seekBack, `seek -${seek}`, `快退 ${seek} 秒`],
                [keys.seekFwd, `seek ${seek}`, `快进 ${seek} 秒`],
                [keys.volUp, `add volume ${vol}`, `音量 +${vol}`],
                [keys.volDown, `add volume -${vol}`, `音量 -${vol}`],
                // 静音/音轨/字幕的反馈由 hints.lua 的 observe_property OSD 提供，无需 show-text
                [keys.mute, 'cycle mute', ''],
                [keys.audioCycle, 'cycle audio', ''],
                [keys.subToggle, 'cycle sub', ''],
                [keys.speedDown, `add speed -${speed}`, `倍速 -${speed}`],
                [keys.speedUp, `add speed ${speed}`, `倍速 +${speed}`],
                [keys.speedReset, 'set speed 1', '已恢复原速 1.0x'],
                [keys.frameBack, 'frame-back-step', '上一帧'],
                [keys.frameFwd, 'frame-step', '下一帧'],
                // 进度/文件信息：mpv 内置命令与 stats 脚本自带 OSD 展示
                [keys.progress, 'show-progress', ''],
                [keys.fileInfo, 'script-binding stats/display-page-5-toggle', ''],
                [keys.fullscreen, 'cycle fullscreen', ''],
                [keys.screenshot, 'screenshot', '已截图'],
                [keys.stopPlay, 'stop', '已停止播放'],
            ];
            // 注：右键「打开上下文菜单」不走静态绑定——生成文件无法预知所选二进制能力，
            // 由 mpv-player 连接后运行时探测默认绑定再注入（_probeContextMenuBinding），
            // 避免旧版 mpv 按键报 unknown binding、新版误判成暂停。
            const used = new Set();
            const defaults = [];
            for (const [key, cmd, msg] of bindings) {
                if (!key || used.has(key) || userKeys.has(key)) continue;
                used.add(key);
                defaults.push(msg ? `${key} ${cmd}; show-text "${msg}"` : `${key} ${cmd}`);
            }
            const conf = [
                YUKI_CONF_MARK,
                ...defaults,
                YUKI_CONF_END,
                '',
                '# 以下为用户全局 mpv input.conf 的键位（自动合并，请编辑全局文件或此段上方）',
                ...userLines,
                '',
            ].join('\n');
            fs.writeFileSync(path.join(scriptDir, 'input.conf'), conf, 'utf8');
            mpv.scriptPath = path.join(scriptDir, 'hints.lua');
            mpv.inputConfPath = path.join(scriptDir, 'input.conf');
            // 内置中文右键菜单：翻译版 menu.conf 无条件写入并注入——script-opts 对脚本
            // 是不透明键值表，旧版 select.lua 不认识该键时静默忽略，无副作用；新版用它
            // 加载中文菜单。写失败不影响播放，仅退化为所选 mpv 的内置默认菜单。
            try {
                fs.writeFileSync(path.join(scriptDir, 'menu.conf'), MENU_CONF_ZH, 'utf8');
                mpv.menuConfPath = path.join(scriptDir, 'menu.conf');
            } catch (e) { /* 菜单文件写失败不影响播放 */ }
        } catch (e) { /* 脚本写入失败不影响播放 */ }
    }
    // 截图目录首帧就绪：首次起播前就赋值，保证 writeMpvAssets/首播的 --screenshot-directory
    // 已带入 Pictures/yuki（否则首播时为 '' → s 键截图落到 cwd，被误判为失效）。
    // update-player-prefs 仍会刷新该值，保持一致。
    mpv.screenshotDir = path.join(app.getPath('pictures'), 'yuki');
    // mpv 运行日志（--log-file，每次起播覆盖）：--no-terminal 吞掉终端输出后，
    // 起播失败的唯一可读原因（HTTP 4xx/TLS/超时）只在落盘日志里，退出时回读进
    // 失败详情并随渲染层提示展示；也可在 设置 → 日志 里直接查看文件。
    mpv.logFilePath = path.join(LOG_DIR, 'mpv.log');
    writeMpvAssets();
    ipcMain.handle('yuki:update-hotkeys', () => { writeMpvAssets(); return { ok: true }; });

    // 播放偏好变更（默认倍速 / 记忆位置 / 语言偏好 / Anime4K）：重读设置注入 mpv
    ipcMain.handle('yuki:update-player-prefs', () => {
        const sp = parseFloat(settings.get('playerSpeed'));
        mpv.defaultSpeed = (sp && sp > 0) ? Math.max(0.25, Math.min(4, sp)) : 1;
        mpv.watchLaterDir = settings.get('resumePos') !== false
            ? path.join(app.getPath('userData'), 'mpv-watch-later')
            : null;
        mpv.audioLang = String(settings.get('playerAlang') || '');
        mpv.subLang = String(settings.get('playerSlang') || '');
        mpv.anime4kShaders = anime4kChainFromSettings();
        mpv.screenshotDir = path.join(app.getPath('pictures'), 'yuki');
        writeMpvAssets(); // 同步 OSD 中的 Anime4K 状态提示（下次起播读取）
        // 播放途中把 Anime4K 配置热同步到运行中的 mpv：设置页与右键菜单共用同一状态源，
        // 菜单勾选态与实际注入立即对齐，消除「设置页已改、菜单还是旧值」的失步窗。
        // 与 a4k-request 同款运行时替换（已验证安全）；未播放/IPC 未连接时命令被拒，静默忽略。
        if (mpv.playing) {
            mpv.command('no-osd', 'set', 'glsl-shaders', mpv.anime4kShaders).catch(() => { });
            mpv.command('set', 'user-data/yuki/a4k-mode', anime4kMenuModeFromSettings()).catch(() => { });
        }
        return { ok: true };
    });

    // 截图：把 mpv 当前帧存为 PNG（快捷键走 input.conf 的 screenshot 命令；此端点供程序化触发）
    ipcMain.handle('yuki:mpv-screenshot', async () => {
        try {
            if (!mpv.isAvailable()) return { ok: false, reason: 'mpv-missing' };
            if (!mpv.playing) return { ok: false, reason: 'not-playing' };
            const dir = mpv.screenshotDir || path.join(app.getPath('pictures'), 'yuki');
            fs.mkdirSync(dir, { recursive: true });
            // 随机后缀避免同毫秒多次触发时文件名冲突覆盖
            const file = path.join(dir, `yuki-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
            // 传给 mpv 用 posix 斜杠（Windows 反斜杠可能被 JSON IPC 转义导致失败）；
            // 返回给前端的 path 保留系统路径（供打开目录/通知展示）。
            const filePosix = file.replace(/\\/g, '/');
            await mpv.screenshot(filePosix);
            // 校验是否真的落盘：mpv 返回成功但文件未生成时明确报错，不静默
            if (!fs.existsSync(file)) throw new Error('screenshot file not created');
            if (Notification.isSupported()) {
                const n = new Notification({ title: '已截图', body: path.basename(file) });
                n.on('click', () => { if (win) { win.show(); win.focus(); } });
                n.show();
            }
            return { ok: true, path: file };
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // 打开截图目录（资源管理器）
    ipcMain.handle('yuki:mpv-screenshot-dir', async () => {
        try {
            const dir = mpv.screenshotDir || path.join(app.getPath('pictures'), 'yuki');
            fs.mkdirSync(dir, { recursive: true });
            const err = await shell.openPath(dir);
            if (err) return { ok: false, reason: err };
            return { ok: true, dir };
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // 弹幕装载（方案 A）：渲染层拉到弹弹 play 整集弹幕后一次性推给 mpv，转 ASS 并 sub-reload。
    // 仅播放中有意义；返回装载条数。
    ipcMain.handle('yuki:load-danmaku', (_e, comments) => {
        try {
            if (!mpv.playing) return { ok: false, reason: 'not-playing' };
            const n = mpv.loadDanmakuBatch(comments);
            return { ok: true, count: n };
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // 播放入口：以下两种情况都从这里接管——
    //  a) 已指定外部播放器为主播放器（VLC/PotPlayer/其他）：直接把解析好的首条直链交外部播放器。
    //     （外部播放器拿不到结束事件，故选 A：只交首集、不起自动连播。）
    //  b) 否则内置 mpv 就绪则接管；否则 ok:false 让渲染层 <video> 预览兜底
    ipcMain.handle('yuki:play', (_e, payload) => {
        // 整体 watchdog（raceWithTimeout）：任何子步骤意外挂起时 90s 后向渲染层返回
        // 失败结果，而不是让调用方永久等待。超时后后台工作若最终完成，其结果被丢弃
        // （渲染层已按失败收尾）；不主动 stop mpv —— 避免误杀用户随后另起的新会话
        // （对齐 verifyMpvStart 的所有权保护）。
        return raceWithTimeout((async () => {
        let meta = (payload && payload.meta) || {};
        let requestedUrl = String(payload && payload.url || '');
        // L-1：URL 协议白名单——本地文件播放走 yuki:dl-play / yuki:file-push 专用通道，
        // 此处仅放行网络协议，拒绝 file://、edl:// 等可直接触碰本地文件的 scheme
        // （渲染层 playUrl 调用点已确认均为网络直链：站点剧集/直播源/直链播放）
        {
            const protoOk = (u) => /^(https?|rtmps?|rtsp|magnet):/i.test(String(u || ''));
            const meta0 = meta;
            const bad = (payload && payload.url && !protoOk(payload.url))
                || (Array.isArray(meta0.playlist) && meta0.playlist.some((e) => e && e.url && !protoOk(e.url)));
            if (bad) return withPlayerTrace({ ok: false, reason: 'bad url protocol' }, meta);
        }
        // P5.4 / R8.1：任何 HTTP 媒体在交给外部播放器/mpv 前先做 HEAD→Range 探测。
        // 开关 media_probe（默认开）：若用户显式关闭，则跳过探测直接交由播放器。
        // HTML、登录页、403 和已过期签名地址在这里止步，避免播放器黑屏。
        // 例外：本机 go-proxy 取流地址（见 isLocalProxyStreamUrl）。
        const mediaProbeEnabled = settings.get('mediaProbe') !== false && !meta.skipProbe
            && !isLocalProxyStreamUrl(requestedUrl);
        if (/^https?:\/\//i.test(requestedUrl) && mediaProbeEnabled) {
            const requestId = String(meta.requestId || '');
            const controller = new AbortController();
            const marker = { requested: false, reason: '', controller };
            if (requestId) runtimeAborts.set(requestId, marker);
            try {
                const probe = await probeMedia(requestedUrl, {
                    headers: meta.header, skipProbe: false,
                    signal: controller.signal, timeoutMs: 8000,
                });
                if (!probe.ok) {
                    return withPlayerTrace({ ok: false, reason: `media-probe-${probe.reason}`,
                        url: probe.finalUrl || requestedUrl, status: probe.status || 0,
                        source: meta.source || meta.site || '' }, meta);
                }
                requestedUrl = probe.finalUrl || requestedUrl;
                meta = { ...meta, header: probe.headers || meta.header,
                    probe: { via: probe.via || probe.reason || '', status: probe.status || 0 } };
            } finally {
                if (requestId && runtimeAborts.get(requestId) === marker) runtimeAborts.delete(requestId);
            }
        }
        // 外部播放器为主：直接转交，不再走内置 mpv（mpv 缺失时也能用外部播放器起播）
        const extPrimary = primaryExternalPlayer();
        if (extPrimary) {
            const firstUrl = requestedUrl;
            if (!/^(https?|rtmp|rtsp):\/\//i.test(firstUrl)) {
                return withPlayerTrace({ ok: false, reason: 'bad url', via: 'external' }, meta);
            }
            const extLabel = [meta.title, meta.subtitle].filter(Boolean).join(' · ');
            // 组装条目：整季队列（meta.playlist=管道代理地址列表）→ 写 m3u 播放列表
            // 文件交给 PotPlayer 原生列表连播；单集/逐集回退 → 单条目直启。
            // 鉴权头传递（launchExternalPlayerItems 内统一决策）：管道地址入站免鉴权；
            // 带鉴权头真实直链包 static 管道；VLC/mpv 开关可靠维持直传。
            // 双窗口收敛在 launchExternalPlayerItems 的 spawn 前一刻执行（见其注释）。
            // 多条目 m3u 列表：EXTINF 集名 + 纯 ASCII 代理地址；catvod 无头/UA-only
            // 条目经代理 302 直连（探测零等待，总时长即时），强防盗链条目 pipe 预取
            // 加速——整季列表与时长体验兼得。
            const isQueue = Array.isArray(meta.playlist) && meta.playlist.length > 1;
            const items = isQueue
                ? meta.playlist.map((e) => ({
                    url: String((e && e.url) || ''), title: String((e && e.title) || ''),
                    header: isPlaylistProxyUrl(String((e && e.url) || '')) ? (meta.header || null) : null,
                })).filter((it) => it.url)
                : [{ url: firstUrl, title: extLabel, header: meta.header || null }];
            // single-flight：同播放意图（kind|site|title）的并发双发复用在途启动，
            // 从源头消除「两次 IPC 各自走到 spawn」的并发第二窗（kill 收敛兜底其余场景）。
            const flightKey = `${externalPlayerKind(extPrimary)}|${meta.site || ''}|${meta.title || ''}`;
            if (extLaunchFlight.key === flightKey && extLaunchFlight.promise) {
                console.log(`[外部播放器] single-flight 复用在途启动（${flightKey}）`);
                const r0 = await extLaunchFlight.promise.catch((e) => ({ ok: false, reason: e.message }));
                return withPlayerTrace(r0.ok
                    ? { ok: false, launched: true, started: false,
                        reason: 'external-start-unverified', viaExternal: true, via: r0.via, kind: r0.kind }
                    : { ...r0, viaExternal: true }, meta);
            }
            const p = (async () => launchExternalPlayerItems(extPrimary, items))();
            extLaunchFlight = { key: flightKey, promise: p };
            const r = await p.finally(() => {
                if (extLaunchFlight.promise === p) extLaunchFlight = { key: '', promise: null };
            });
            // A detached external process has no file-loaded/first-frame
            // acknowledgement. Report launched separately; ok=true remains
            // reserved for a verified mpv session.
            return withPlayerTrace(r.ok
                ? { ...r, ok: false, launched: true, started: false,
                    reason: 'external-start-unverified', viaExternal: true }
                : { ...r, viaExternal: true }, meta);
        }
        if (!mpv.isAvailable()) {
            return withPlayerTrace({ ok: false, reason: 'mpv-missing', hint: '设置 → 扩展 → 下载内置播放器，或 设置 → 组件状态 指定外部播放器' }, meta);
        }
        const title = [meta.title, meta.subtitle].filter(Boolean).join(' · ');
        // 连播已改渲染层驱动（每次只交单集，播完由 Player._onExit 推进下一集）；
        // meta.playlist 仅作历史兼容兜底，正常链路不会携带
        const episodes = (Array.isArray(meta.playlist) && meta.playlist.length
            ? meta.playlist
            : [{ url: requestedUrl, title }]).map((episode) => ({
                ...episode, url: traceLocalProxy(episode.url, meta),
            }));
        // Anime4K 开关/档位实时生效（播放途中可切换，下次起播注入着色器）
        mpv.anime4kShaders = anime4kChainFromSettings();
        // 断流重试上下文：记录本次会话首部 URL/标题/请求头（exit 时未播完可自动重连）
        mpv._lastUrls = episodes.map((e) => e.url);
        mpv._lastTitle = title;
        mpv._lastHeader = meta.header;
        mpv._lastRequestId = meta.requestId || '';
        mpv._lastPlaySessionId = meta.playSessionId || '';
        mpv._stallRetried = false;
        // 原生队列逐集标题源：file-loaded 时按当前下标经 IPC 设置窗口标题
        mpv._queueTitles = episodes.map((e) => String(e.title || ''));
        mpv._queueSeriesTitle = String(title || '');
        // 不自动切换线路；只等待当前 URL 真正 file-loaded，再向渲染层返回成功。
        // 这样失败时会保留当前地址和错误原因，由用户手动选择其它线路。
        const first = mpv.play(episodes, {
            title, header: meta.header, resume: true, speed: meta.speed,
            fullscreen: meta.fullscreen, format: meta.format,
            subs: meta.subs, position: meta.position,
            requestId: meta.requestId, playSessionId: meta.playSessionId,
            // 原生多集队列（meta.playlist≥2 的静态直链列表）从第 epIndex 项起播
            startIndex: Number.isFinite(Number(meta.epIndex)) ? Number(meta.epIndex) : 0,
        });
        // verifyMpvStart 需要在校验前就知道这是原生队列（代际抖动豁免，见其内注释）
        first.nativeQueue = Array.isArray(meta.playlist) && meta.playlist.length > 1;
        let r = first;
        if (first.ok) {
            if (meta.playlist && meta.playlist.length > 1) {
                console.log(`[mpv] 原生队列起播：entries=${episodes.length} start=${meta.epIndex || 0} m3u 已装载，等待首集就绪…`);
            }
            r = await verifyMpvStart(first, MPV_START_TIMEOUT_MS);
            if (meta.playlist && meta.playlist.length > 1) {
                console.log(`[mpv] 原生队列起播${r.ok ? '成功' : `失败：${r.reason}${r.error ? ' / ' + String(r.error).slice(0, 160) : ''}`}`);
                if (!r.ok) { try { mpv.stop(); } catch (e) { /* ignore */ } }
            }
        }
        // 队列会话（meta.queueCtx）的地址是本地代理：失败时再探测只会触发一次多余的
        // 重新解析，且 502 原因已由代理 toast 告知，跳过补探测。
        if (!r.ok && r.reason === 'mpv-exited-before-playback' && !meta.queueCtx
            && /^https?:\/\//i.test(requestedUrl)) {
            // 从未起播的失败：补一次媒体探测给出精确死因（死链 404 / HTML 风控页 /
            // 签名过期），替代 mpv 收尾日志里无可操作性的调试噪音。仅失败路径多一次
            // 轻量请求；探测成功则保持原结果，由日志提取的真实原因兜底。
            try {
                const post = await probeMedia(requestedUrl, {
                    headers: meta.header, skipProbe: false, timeoutMs: 6000,
                });
                if (post && !post.ok) {
                    r = { ...r, url: post.finalUrl || requestedUrl,
                        postProbe: `${post.reason || 'unknown'}${post.status ? `/${post.status}` : ''}` };
                }
            } catch (e) { /* 探测异常不影响原失败结果 */ }
        }
        if (r.ok) {
            // 非连播会话（本地文件/推送）：sessionId 取负，渲染层据此不触碰连播链
            if (meta.noSeq) r.sessionId = -Math.abs(r.sessionId);
            // 原生多集队列（episodes≥2 静态直链）：渲染层据此改逐集记账、退出不再推进连播
            r.nativeQueue = episodes.length > 1;
            afterPlay();
            attachAnime4kInfo(r); // 渲染层 toast 提示 Anime4K 是否生效及档位
            // 边下边播（T9，默认关）：静默把当前集追加到下载目录（m3u8 走 ffmpeg 合成，
            // 其余走 aria2）；引擎未就绪/失败静默跳过不打扰播放。
            // 直播（meta.source==='live'）是无限流，无法下载，跳过；
            // 网盘/本地代理动态流全局禁止边下边播：do=pan 等端点是按需解析的取流
            // 会话，下载引擎只会拿到 m3u8 转发文本或短时效签名流，且与播放抢占
            // 同一网盘会话的带宽并放大风控概率——即使开关开启也一律跳过。
            const simulUrl = String((episodes[0] && episodes[0].url) || requestedUrl || '');
            if (settings.get('simulDownload') && meta.source !== 'live' && meta.source !== 'queue'
                && !isDynamicProxyStream(simulUrl, meta)) {
                try {
                    const ep = episodes[0];
                    const urlPath = String(ep.url).split('?')[0];
                    const isM3u8 = /\.m3u8$/i.test(urlPath);
                    // 同源同集去重：该集已在下载中/已下载（文件在）→ 静默跳过，不重复建任务。
                    // key 与手动下载一致（站点|剧名|集名），重播/续播/换线路均不再重复下载。
                    const simulKey = buildEpisodeKey({
                        site: meta.site || meta.source, vod: meta.title, episode: meta.subtitle,
                    });
                    const dup = simulKey ? await dlDedupe.check(simulKey) : null;
                    let out;
                    if (isM3u8) {
                        // m3u8 合成产物固定为 mp4（避免无扩展名导致 ffmpeg 无法推断格式而合成失败）
                        out = (title.replace(/[\\/:*?"<>|]/g, '_').trim() || '视频').slice(0, 150) + '.mp4';
                    } else {
                        const ext = (urlPath.match(/\.(mp4|mkv|flv|mov|avi|webm|ts)$/i) || ['', ''])[1];
                        // M-9：命中扩展名才补「.ext」，未命中（如直播/无扩展直链）不加悬挂点号
                        out = (title.replace(/[\\/:*?"<>|]/g, '_').trim() || '视频').slice(0, 150) + (ext ? '.' + ext : '');
                    }
                    if (dup) {
                        // 命中去重：不建任务，落入下方统一出口返回播放结果
                    } else if (isM3u8) {
                        syncDlDir(dl.dir || settings.get('dlDir') || app.getPath('downloads'));
                        const hlsGid = hls.add({ url: ep.url, out, header: meta.header,
                            concurrency: parseInt(settings.get('dlSplitConcurrency'), 10) || 5 });
                        if (simulKey) {
                            dlDedupe.bind(hlsGid, simulKey, {
                                gid: hlsGid, kind: 'hls', name: out, files: [], size: 0, done: 0,
                                percent: 0, status: 'active', uri: ep.url,
                                header: (meta.header && typeof meta.header === 'object') ? meta.header : undefined,
                                completedAt: Date.now(),
                            });
                        }
                        startDlPoll();
                        r.simulDl = true;
                    } else if (dl.isAvailable()) {
                        // 边下边播注册是次要步骤：aria2 引擎/RPC 偶发挂起时不能拖住
                        // yuki:play 的响应（mpv 已开播、渲染层却在转圈），8s 竞速兜底。
                        await raceWithTimeout(
                            startDlEngine(dl.dir || settings.get('dlDir') || app.getPath('downloads')), 8000);
                        const opts = { out };
                        if (meta.header && typeof meta.header === 'object') {
                            const pairs = Object.entries(meta.header)
                                .filter(([, v]) => v != null && v !== '')
                                .map(([k, v]) => `${k}: ${v}`);
                            if (pairs.length) opts.header = pairs;
                        }
                        const ariaGid = await raceWithTimeout(dl.addUri(ep.url, opts), 8000);
                        if (simulKey && ariaGid) {
                            dlDedupe.bind(ariaGid, simulKey, {
                                gid: ariaGid, kind: 'aria2', name: out, files: [], size: 0, done: 0,
                                percent: 0, status: 'waiting', uri: ep.url,
                                header: (opts.header && Array.isArray(opts.header))
                                    ? Object.fromEntries(opts.header.map((h) => { const i = h.indexOf(': '); return [h.slice(0, i), h.slice(i + 2)]; }))
                                    : undefined,
                                completedAt: Date.now(),
                            });
                        }
                        startDlPoll();
                        r.simulDl = true;
                    }
                } catch (e) { /* 静默跳过：播放优先 */ }
            }
        }
        return withPlayerTrace(r, meta);
        })(), PLAY_HANDLER_TIMEOUT_MS, { ok: false, reason: 'play-handler-timeout' })
            .then((result) => withPlayerTrace(result, (payload && payload.meta) || {}));
    });

    // 播放控制（渲染层备用；mpv 窗口自带默认快捷键）
    ipcMain.handle('yuki:player', (_e, cmd, value) => {
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

    ipcMain.handle('yuki:player-state', () => ({ available: mpv.isAvailable(), playing: mpv.playing }));

    // ---- Phase 5 本地文件管理（白名单根目录 + 防穿越） ----
    const fileIpc = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
        try { return { ok: true, ...(await fn(...args)) }; }
        catch (err) { return { ok: false, reason: err.message }; }
    });

    fileIpc('yuki:file-root', () => ({ root: fileMgr.root }));

    ipcMain.handle('yuki:file-pick-root', async () => {
        const r = await dialog.showOpenDialog(win, {
            title: '选择本地文件根目录（白名单）',
            properties: ['openDirectory', 'createDirectory'],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'canceled' };
        const root = fileMgr.setRoot(r.filePaths[0]);
        return { ok: true, root };
    });

    fileIpc('yuki:file-list', (rel) => {
        if (!fileMgr.root) return { needRoot: true };
        return fileMgr.list(rel);
    });

    // 打开本地目录（资源管理器）：rel 限白名单内，'' 为根目录
    fileIpc('yuki:file-open-dir', async (rel) => {
        const dir = fileMgr.resolveSafe(rel);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('not a directory');
        const err = await shell.openPath(dir);
        if (err) throw new Error(err);
        return { path: dir };
    });

    ipcMain.handle('yuki:file-upload', async (_e, rel) => {
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

    fileIpc('yuki:file-new-folder', (rel, name) => { fileMgr.newFolder(rel, name); return {}; });
    fileIpc('yuki:file-del-file', (rel) => { fileMgr.delFile(rel); return {}; });
    fileIpc('yuki:file-del-folder', (rel) => { fileMgr.delFolder(rel); return {}; });

    // 本地与下载视频预览图：ffmpeg 抓帧缓存（userData/local-thumbs）；ffmpeg 未就绪返回 ok:false 用占位图
    fileIpc('yuki:file-thumb', async (rel) => {
        let abs;
        // 直链 URL（直链播放历史卡截帧）：ffmpeg 原生支持 http(s)/m3u8 输入，直接抓帧；
        // 远程地址不经本地路径白名单（无本地文件系统边界问题），缓存 key 用 md5(url)
        const raw = String(rel || '');
        if (/^(https?|rtmps?):\/\//i.test(raw)) {
            return ffmpegUrlThumb(raw, path.join(app.getPath('userData'), 'local-thumbs'));
        }
        const inside = (root, target) => {
            if (!root || !target) return false; // 缺 target（误用漏参）返回 false，而非抛 TypeError
            const r = path.relative(path.resolve(String(root)), target);
            return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r));
        };
        const dlRoot = dl.dir || settings.get('dlDir') || app.getPath('downloads');
        // 支持绝对路径（如已下载文件的绝对路径，必须在下载目录或文件管理根目录白名单内）
        if (path.isAbsolute(String(rel || ''))) {
            abs = path.resolve(String(rel));
            if (!inside(dlRoot, abs) && !inside(fileMgr.root, abs)) return { ok: false };
        } else {
            // 相对路径：优先走 fileMgr.resolveSafe，若未配置 root 或超出则尝试在下载目录内解析
            try {
                abs = fileMgr.resolveSafe(rel);
            } catch (e) {
                if (dlRoot) {
                    const candidate = path.resolve(dlRoot, String(rel || ''));
                    if (inside(dlRoot, candidate)) abs = candidate;
                    else return { ok: false };
                } else return { ok: false };
            }
        }
        // 存量无后缀下载记录自愈：旧版任务曾存出无后缀路径，文件后来补了扩展名
        // （或被重命名规则加上 .mp4）——原路径已不存在时按常见视频扩展名探测同名
        // 文件，命中即用；否则这类记录封面永久占位（statSync 失败 → ok:false）
        if (!fs.existsSync(abs) && !path.extname(abs)) {
            for (const cand of ['.mp4', '.mkv', '.ts', '.m4v', '.webm', '.mov', '.avi', '.flv']) {
                const withExt = abs + cand;
                try {
                    if (fs.existsSync(withExt)) { abs = withExt; break; }
                } catch (e) { /* 探测失败继续下一个候选 */ }
            }
        }
        // 无扩展名文件放行（与 yuki:download-play 一致）：让 ffmpeg 实际探测容器格式，
        // 旧版无后缀存量下载文件也能抓帧；带扩展名但不在视频白名单的仍拒绝
        if (!fileMgr.isVideo(abs) && path.extname(abs)) return { ok: false };
        return ffmpegThumb(abs, path.join(app.getPath('userData'), 'local-thumbs'));
    });

    // 本地媒体播放（视频/音频）：相对路径/绝对路径 → 白名单内绝对路径 → 复用 mpv-player
    fileIpc('yuki:file-push', async (rel) => {
        // 指定播放器为主播放器（VLC/PotPlayer 等）时优先交它，与 yuki:play 行为一致；
        // 此时不再依赖内置 mpv（未装内置 mpv 也能用指定播放器起播）
        const extPrimary = primaryExternalPlayer();
        if (!extPrimary && !mpv.isAvailable()) return { ok: false, reason: 'mpv-missing' };
        if (!rel || !String(rel).trim()) return { ok: false, reason: 'path-denied' };
        let abs;
        const inside = (root, target) => {
            if (!root || !target) return false; // 缺 target（误用漏参）返回 false，而非抛 TypeError
            const r = path.relative(path.resolve(String(root)), target);
            return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r));
        };
        const dlRoot = dl.dir || settings.get('dlDir') || app.getPath('downloads');
        // fileMgr 可能在极早期调用时仍未初始化（窗口已建但 app.whenReady 后半段未执行完），此时优雅降级为 dlRoot 校验
        const fileRoot = (fileMgr && fileMgr.root) ? fileMgr.root : dlRoot;
        if (path.isAbsolute(String(rel || ''))) {
            abs = path.resolve(String(rel));
            if (!inside(dlRoot, abs) && !inside(fileRoot, abs)) return { ok: false, reason: 'path-denied' };
        } else {
            try {
                if (fileMgr && fileMgr.root) abs = fileMgr.resolveSafe(rel);
                else throw new Error('root not set');
            } catch (e) {
                if (dlRoot) {
                    const candidate = path.resolve(dlRoot, String(rel || ''));
                    if (inside(dlRoot, candidate)) abs = candidate;
                    else return { ok: false, reason: 'path-denied' };
                } else return { ok: false, reason: 'path-denied' };
            }
        }
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, reason: 'file-not-found' };
        if (!fileMgr.isMedia(abs)) return { ok: false, reason: 'not-video' };
        const title = path.basename(abs);
        // mpv 对 Windows 反斜杠路径兼容性一般，转正斜杠可规避首播因路径转义导致的加载失败
        const playUrl = abs.replace(/\\/g, '/');
        if (extPrimary) {
            // 本地文件无鉴权头，直接交指定播放器起播（无 file-loaded 校验，spawn 成功即视为已交）
            const r = launchExternalPlayer(extPrimary, playUrl);
            return r.ok ? { ...r, viaExternal: true } : r;
        }
        // 与 yuki:play 对齐：起播前刷新 Anime4K 着色器链（开关/档位实时生效）。
        // 缺此刷新时本地文件用的可能是空/旧链——典型表现为「网络流生效、本地文件不生效」。
        mpv.anime4kShaders = anime4kChainFromSettings();
        const r = mpv.play([{ url: playUrl, title }], { title, noSeq: true });
        if (!r.ok) return r;
        const started = await verifyMpvStart(r, MPV_START_TIMEOUT_MS);
        if (!started.ok) {
            // 首播冷启动偶发 IPC 未就绪导致 verify 超时：延迟 400ms 后重试一次本次本地文件
            // （二次点击成功即为此竞态，自动重试可使首次点击即成功）
            if (started.reason === 'mpv-start-timeout' || started.reason === 'mpv-exited-before-playback') {
                await new Promise((res) => setTimeout(res, 400));
                const retry = mpv.play([{ url: playUrl, title }], { title, noSeq: true });
                if (!retry.ok) return started;
                const retried = await verifyMpvStart(retry, MPV_START_TIMEOUT_MS);
                if (!retried.ok) return retried;
                retried.sessionId = -Math.abs(retried.sessionId);
                afterPlay();
                return attachAnime4kInfo(retried);
            }
            return started;
        }
        started.sessionId = -Math.abs(started.sessionId);
        afterPlay();
        return attachAnime4kInfo(started);
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
        if (!r.ok) return r;
        const started = await verifyMpvStart(r, MPV_START_TIMEOUT_MS);
        if (started.ok) {
            started.sessionId = -Math.abs(started.sessionId);
            afterPlay();
            send('yuki:push-received', { url, source });
            if (Notification.isSupported()) {
                new Notification({ title: '推送播放', body: url.slice(0, 80) }).show();
            }
        }
        return started;
    }

    ipcMain.handle('yuki:push-url', async (_e, url) => {
        try { return await playPushedUrl(String(url || '').trim(), '面板'); }
        catch (err) { return { ok: false, reason: err.message }; }
    });

    ipcMain.handle('yuki:push-info', () => pushServer.info());

    ipcMain.handle('yuki:parse', async (_e, url) => {
        const payload = (url && typeof url === 'object') ? url : { url };
        const requestId = String(payload.requestId || '');
        const playSessionId = String(payload.playSessionId || '');
        const trace = { ...(requestId ? { requestId } : {}), ...(playSessionId ? { playSessionId } : {}) };
        try {
            const targetUrl = String(payload.url || '');
            const parses = Array.isArray(payload.parses) ? payload.parses : undefined;
            const legacy = !!payload.legacy;
            // 25s 安全超时 + 取消传播：超时置 abort 标记，解析窗口立即作废并释放槽位
            // （此前只 race 返回 null，后台解析仍占着槽位，连续超时会耗尽解析池）
            const abort = { requested: false, reason: '' };
            if (requestId) runtimeAborts.set(requestId, abort);
            let timer = null;
            try {
                const result = await Promise.race([
                    parseWin.resolve(targetUrl, parses, legacy, abort, payload),
                    new Promise((res) => { timer = setTimeout(() => {
                        abort.requested = true;
                        abort.reason = 'timeout';
                        res({ ok: false, reason: 'parse-timeout',
                            error: { code: 'L4_PARSE_TIMEOUT', stage: 'parse', retryable: true,
                                message: '播放地址解析超时' }, ...trace });
                    }, 25000); }),
                ]);
                if (abort.requested) {
                    const timedOut = abort.reason === 'timeout';
                    return { ok: false, reason: timedOut ? 'parse-timeout' : 'parse-cancelled',
                        error: { code: timedOut ? 'L4_PARSE_TIMEOUT' : 'L4_PARSE_CANCELLED',
                            stage: 'parse', retryable: true,
                            message: timedOut ? '播放地址解析超时' : '播放地址解析已取消' }, ...trace };
                }
                return result ? { ...result, ...trace } : {
                    ok: false, reason: 'parse-failed',
                    error: { code: 'L4_PARSE_FAILED', stage: 'parse', retryable: true,
                        message: '播放地址解析失败' }, ...trace,
                };
            } finally {
                clearTimeout(timer);
                if (requestId && runtimeAborts.get(requestId) === abort) runtimeAborts.delete(requestId);
            }
        } catch (err) {
            return { ok: false, reason: 'parse-failed',
                error: { code: 'L4_PARSE_FAILED', stage: 'parse', retryable: true,
                    message: String(err && err.message || '播放地址解析失败').slice(0, 240) }, ...trace };
        }
    });

    // 无解析接口（或解析失败）时的兜底：隐藏窗口直开链接抓媒体请求（share 分享页自带播放器）
    ipcMain.handle('yuki:capture-direct', async (_e, payload) => {
        const requestId = String(payload && typeof payload === 'object' ? payload.requestId || '' : '');
        const playSessionId = String(payload && typeof payload === 'object' ? payload.playSessionId || '' : '');
        const trace = { ...(requestId ? { requestId } : {}), ...(playSessionId ? { playSessionId } : {}) };
        try {
            // 兼容两种调用：字符串 url（旧）或 {url, legacy}（Kazumi 旧解析器）
            const url = (payload && typeof payload === 'object') ? String(payload.url || '') : String(payload || '');
            const legacy = !!(payload && typeof payload === 'object' && payload.legacy);
            // 25s 安全超时 + 取消传播：超时置 abort 标记，隐藏窗口作废并释放槽位
            const abort = { requested: false, reason: '' };
            if (requestId) runtimeAborts.set(requestId, abort);
            let timer = null;
            let timedOut = false;
            try {
                const r = await Promise.race([
                    parseWin.captureDirect(url, undefined, legacy, abort, payload),
                    new Promise((res) => { timer = setTimeout(() => {
                        timedOut = true; abort.requested = true; abort.reason = 'timeout'; res(null);
                    }, 25000); }),
                ]);
                if (timedOut) return { ok: false, reason: 'parse-timeout',
                    error: { code: 'L4_PARSE_TIMEOUT', stage: 'parse', retryable: true,
                        message: '播放地址解析超时' }, ...trace };
                if (abort.requested) {
                    const timedOut = abort.reason === 'timeout';
                    return { ok: false, reason: timedOut ? 'parse-timeout' : 'parse-cancelled',
                        error: { code: timedOut ? 'L4_PARSE_TIMEOUT' : 'L4_PARSE_CANCELLED',
                            stage: 'parse', retryable: true,
                            message: timedOut ? '播放地址解析超时' : '播放地址解析已取消' }, ...trace };
                }
                return (r && r.ok) ? { ...r, ...trace } : { ok: false, reason: 'capture-failed',
                    error: { code: 'L4_PARSE_FAILED', stage: 'parse', retryable: true,
                        message: '播放页面未捕获到媒体地址' }, ...trace };
            } finally {
                clearTimeout(timer);
                if (requestId && runtimeAborts.get(requestId) === abort) runtimeAborts.delete(requestId);
            }
        } catch (err) { return { ok: false, reason: 'capture-failed',
            error: { code: 'L4_PARSE_FAILED', stage: 'parse', retryable: true,
                message: String(err && err.message || '播放地址解析失败').slice(0, 240) }, ...trace }; }
    });

    ipcMain.handle('yuki:runtime-cancel', async (_e, context) => {
        const requestId = String(context && context.requestId || '');
        const abort = requestId && runtimeAborts.get(requestId);
        if (abort) {
            abort.requested = true; abort.reason = 'cancelled';
            if (abort.controller) abort.controller.abort();
        }
        const backend = await bridge.cancelRuntime(context || {});
        return { ...backend, ok: backend.ok !== false, cancelled: !!abort || !!backend.cancelled, requestId };
    });

    // 验证码源验证（T73）：可见窗口供用户交互，关闭/超时后收割 Cookie 交给后端持久化
    ipcMain.handle('yuki:captcha-verify', async (_e, url) => {
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

    ipcMain.handle('yuki:settings-get', () => settings.all());
    // settings-set 键白名单（M-1）：仅放行渲染层实际使用的偏好/数据键，防页面脚本写任意键；
    // 敏感路径键（播放器/缓存/下载目录，可指向本地任意位置）不在此列，只能经
    // yuki:pick-player / yuki:pick-cache-dir / yuki:dl pickDir 等主进程对话框设置，走 settings-set 一律忽略。
    const SETTINGS_SET_ALLOWED = new Set([
        'anime4k', 'anime4kMode', 'animEnabled', 'autoNext',
        'bangumiAutoSyncOnStart', 'bangumiAutoSyncStatus', 'bangumiImmediateSyncToastEnable',
        'bangumiSyncPriority', 'bangumiToken', 'bgPlay', 'blockedReason', 'blockedSites',
        'catvodBgmMatch', 'closeAction', 'colorMode', 'configHistory', 'customLives', 'customTheme',
        'dandanAppId', 'dandanAppSecret', 'danmakuEnable', 'enableBangumiProxy', 'enableGitProxy',
        'errorToast', 'favorites', 'fontSize', 'glass', 'history', 'hlsAdFilter', 'incognito',
        'kazumiAutoUpdateOnStart', 'lastConfigUrl', 'lastSourceMap', 'liveProbeCache', 'navCollapsed',
        // 各列表页每页条数（panels.js 动态 key 写入）
        'pageSizeFavorites', 'pageSizeHistory', 'pageSizeHome', 'pageSizeLive', 'pageSizePopular', 'pageSizeSearch',
        'playerAlang', 'playerHotkeys', 'playerSlang', 'playerSpeed', 'playerVolume',
        'probeSourceUrl', 'probeFailStreak', 'probedAt', 'probedSites', 'probeFp', 'proxyTestUrl', 'recentWatches', 'resumePos', 'settingsCat', 'sourceAutoDetect',
        'simulDownload', 'startupView', 'systemTitleBar', 'textColor', 'textSize', 'theme',
        'useMisansFont', 'wallpaper', 'wallpaperDim', 'watchStats', 'watchStatsEnabled',
        // WebDAV 同步全量键。此前 EnableSettings/EnableStats/AutoEnable/AutoMinutes
        // 漏在白名单外，四个开关的写入被静默忽略（重启后回退），此处一并补齐。
        // RestoreBackup 为恢复前本机备份快照，需可写以便误恢复后找回数据。
        'webDavAutoEnable', 'webDavAutoMinutes', 'webDavEnable', 'webDavEnableCollect',
        'webDavEnableHistory', 'webDavEnableRules', 'webDavEnableSettings', 'webDavEnableStats',
        'webDavPassword', 'webDavRemoteDir', 'webDavRestoreBackup', 'webDavSslSkip',
        'webDavStartupPull', 'webDavUrl', 'webDavUsername',
    ]);
    ipcMain.handle('yuki:settings-set', (_e, key, value) => {
        const k = String(key);
        if (!SETTINGS_SET_ALLOWED.has(k)) return { value: undefined, ignored: true };
        return { value: settings.set(k, value) };
    });

    // 直播频道探活：并发检测 HTTP/HTTPS 流地址是否可达（非 HTTP 协议默认放行）。
    // 两段式防误杀：先 HEAD（3s）；出错/超时或响应 403/405/501 时回退 GET（4s），
    // GET 收到任意响应即判活，立即强制销毁连接不拉流，防止后台无限跑流量；3xx 视为可用。
    ipcMain.handle('yuki:probe-urls', async (_e, urls) => {
        if (!Array.isArray(urls) || !urls.length) return [];
        const probeOne = (url) => new Promise((resolve) => {
            const str = String(url);
            if (!/^https?:\/\//i.test(str)) { resolve(true); return; } // RTMP/RTSP 默认放行
            const mod = str.startsWith('https') ? https : http;
            const attempt = (method, timeoutMs, onDone) => {
                let settled = false;
                const done = (v) => {
                    if (settled) return;
                    settled = true;
                    if (timer) clearTimeout(timer);
                    if (req) {
                        try { req.destroy(); } catch (e) { /* ignore */ }
                    }
                    onDone(v);
                };
                let req;
                let timer;
                try {
                    req = mod.request(str, { method, timeout: timeoutMs }, (res) => {
                        const code = res.statusCode || 0;
                        // 收到响应头后立即停止接收后续 stream 数据并销毁响应流，防直播流持续在后台下载
                        try { res.destroy(); } catch (e) { /* ignore */ }
                        
                        // 直播流首帧即判活：mpv/ffplay 等播放器都按「有响应即视为可用」处理。
                        // HEAD/GET 拿到任何 2xx/3xx 都算可用；4xx（403 防盗链等）因可能有
                        // 伪造头/时间戳要求，一律放行，避免把真实可播频道误判为死链。
                        if (code >= 200 && code < 400) { done(true); return; }
                        if (code === 403 || code === 405 || code === 501) { done(null); return; } // HEAD 被拒 → 回退 GET
                        done(code >= 400 && code < 500);
                    });
                } catch (e) { done(null); return; } // 构造失败同样走 GET 兜底
                timer = setTimeout(() => { done(null); }, timeoutMs);
                req.on('error', () => { done(null); });
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
    ipcMain.handle('yuki:pick-mpv', async () => {
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

    ipcMain.handle('yuki:clear-mpv-path', () => {
        settings.set('mpvPath', '');
        mpv.resetBinary();
        return { ok: true, available: mpv.isAvailable() };
    });

    ipcMain.handle('yuki:mpv-path', () => {
        return { customPath: settings.get('mpvPath') || '', available: mpv.isAvailable() };
    });

    // 一键补装内置播放器：用户在安装时取消勾选 mpv、或未内置时，从设置页触发下载。
    // 下载到 userData/vendor（安装目录 resources/ 常在 Program Files 无写权限），完成后
    // 复用自定义路径机制（setCustomPath + 持久化 mpvPath），下次起播即可用。
    let _mpvDownloading = false;
    ipcMain.handle('yuki:download-mpv', async () => {
        if (process.platform !== 'win32') {
            return { ok: false, reason: '非 Windows 平台请用系统包管理器安装 mpv（brew/apt install mpv）' };
        }
        if (mpv.isAvailable()) return { ok: true, path: mpv.binary, already: true };
        if (_mpvDownloading) return { ok: false, reason: 'downloading' };
        _mpvDownloading = true;
        send('yuki:mpv-download-state', { downloading: true });
        let downloadMpv;
        try {
            ({ downloadMpv } = require('../../scripts/download-binaries'));
        } catch (e) {
            // 打包配置（package.json build.files）已随 asar 带上该脚本；此处兜底
            // 旧安装包/脚本损坏的场景，给出可操作的提示而非模块加载错误。
            return { ok: false, reason: '下载组件缺失，请更新或重新安装 YuKi' };
        }
        try {
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
            send('yuki:mpv-download-state', { downloading: false });
        }
    });

    // 换肤：选择本地图片作壁纸（返回路径，渲染层转 file:// 引用）
    ipcMain.handle('yuki:pick-wallpaper', async () => {
        const r = await dialog.showOpenDialog(win, {
            title: '选择壁纸图片',
            properties: ['openFile'],
            filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
        return { ok: true, path: r.filePaths[0] };
    });

    // 缓存位置自定义：选目录 → 持久化 → 重启后端（YUKI_CACHE_DIR 生效）
    ipcMain.handle('yuki:pick-cache-dir', async (_e, dir) => {
        const target = String(dir || '').trim();
        if (!target) {
            const r = await dialog.showOpenDialog(win, {
                title: '选择缓存存放目录',
                properties: ['openDirectory', 'createDirectory'],
            });
            if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
            return { ok: false, reason: 'need-restart', path: r.filePaths[0] }; // 需渲染层确认后再提交
        }
        if (target === '__default__') {
            // 恢复默认缓存位置：清除自定义路径，重启后端
            settings.delete('cacheDir');
            delete bridge.extraEnv.YUKI_CACHE_DIR;
            bridge.stop();
            bridge.start();
            return { ok: true, path: '__default__' };
        }
        try { fs.mkdirSync(target, { recursive: true }); } catch (e) { return { ok: false, reason: 'dir-invalid' }; }
        settings.set('cacheDir', target);
        bridge.extraEnv.YUKI_CACHE_DIR = target;
        bridge.stop();
        bridge.start();
        return { ok: true, path: target };
    });

    // ---- 通用目录选择 ----

    // 通用目录选择对话框（openDirectory + createDirectory，取消返回 cancelled）
    ipcMain.handle('yuki:pick-folder', async () => {
        const r = await dialog.showOpenDialog(win, {
            title: '选择文件夹',
            properties: ['openDirectory', 'createDirectory'],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
        return { ok: true, path: r.filePaths[0] };
    });

    // 统一清理主进程侧本地缓存（配合后端 clearCache 一并调用，见渲染层 clearCache）：
    // 本地预览图 + 解析/验证窗口 partition 会话缓存。
    // （mpv 视频缓冲只走内存，不产生可清理的磁盘缓存；历史残留由启动迁移一次性清掉。）
    // 单次遍历累加并删除（复用 purgeDir/getDirSize，避免 O(n^2) 二次遍历）；
    // 逐目录 try/catch，占用文件跳过；返回释放字节数与各项明细。
    // 并发锁 _clearingAppCaches：清理进行中再次调用直接返回 busy，避免并行重复 walk。
    ipcMain.handle('yuki:clear-app-caches', async () => {
        if (_clearingAppCaches) return { ok: false, reason: 'busy' };
        _clearingAppCaches = true;
        try {
            const ud = app.getPath('userData');
            let total = 0;
            const detail = {};
            // 本地视频预览图缓存（单次遍历边算边删）
            try { const b = purgeDir(path.join(ud, 'local-thumbs')).bytes; detail.thumbs = b; total += b; } catch (e) { /* ignore */ }
            // 解析/验证隐藏窗口的 partition 会话缓存（Chromium 存 userData/Partitions/parse-*）
            try {
                const partRoot = path.join(ud, 'Partitions');
                let freed = 0;
                if (fs.existsSync(partRoot)) {
                    for (const name of fs.readdirSync(partRoot)) {
                        if (/^parse-/i.test(name)) freed += purgeDir(path.join(partRoot, name)).bytes;
                    }
                }
                // 清各 parse-* session 的 HTTP 缓存：先测大小，clearCache 后再测差值补入
                // （会话仍在用时磁盘文件可能被占用无法直删，session 层清理是另一部分释放量）。
                try {
                    for (let i = 0; i < 3; i++) {
                        const part = `parse-${i}`;
                        const sess = session.fromPartition(part);
                        let before = 0;
                        try { before = await sess.getCacheSize(); } catch (e) { /* API 不支持则忽略差值 */ }
                        await sess.clearCache().catch(() => {});
                        try {
                            const after = await sess.getCacheSize();
                            if (before > after) freed += (before - after);
                        } catch (e) { /* ignore */ }
                    }
                } catch (e) { /* ignore */ }
                detail.parsePartitions = freed; total += freed;
            } catch (e) { /* ignore */ }
            return { ok: true, cleanedBytes: total, detail };
        } finally {
            _clearingAppCaches = false;
        }
    });

    // 统计主进程侧本地缓存占用（只统计不删）：供前端与后端 bytes 合并分类展示。
    // 单次遍历各目录累加；parse-* 同时叠加 session HTTP 缓存大小（磁盘文件之外的部分）。
    ipcMain.handle('yuki:cache-size', async () => {
        try {
            const ud = app.getPath('userData');
            const detail = {};
            let total = 0;
            // 本地预览图
            try { const b = getDirSize(path.join(ud, 'local-thumbs')).bytes; detail.thumbs = b; total += b; } catch (e) { /* ignore */ }
            // 解析窗口 partition：磁盘文件 + session HTTP 缓存
            try {
                const partRoot = path.join(ud, 'Partitions');
                let b = 0;
                if (fs.existsSync(partRoot)) {
                    for (const name of fs.readdirSync(partRoot)) {
                        if (/^parse-/i.test(name)) b += getDirSize(path.join(partRoot, name)).bytes;
                    }
                }
                try {
                    for (let i = 0; i < 3; i++) {
                        try { b += await session.fromPartition(`parse-${i}`).getCacheSize(); } catch (e) { /* ignore */ }
                    }
                } catch (e) { /* ignore */ }
                detail.parsePartitions = b; total += b;
            } catch (e) { /* ignore */ }
            // 旧日志（只统计不删）
            try { const b = getDirSize(path.join(ud, 'logs')).bytes; detail.logs = b; total += b; } catch (e) { /* ignore */ }
            return { ok: true, bytes: total, detail };
        } catch (e) {
            return { ok: false, reason: 'stat-failed' };
        }
    });

    // 恢复默认设置：清偏好类键（保留收藏/历史/源/凭据等数据），重启应用确保全量生效
    ipcMain.handle('yuki:settings-reset', () => {
        settings.reset(['favorites', 'history', 'lastConfigUrl', 'configHistory', 'customLives', 'dlDir', 'cacheDir', 'watchStats', 'recentWatches', 'bangumiToken', 'dandanAppId', 'dandanAppSecret']);
        // M-8：app.exit(0) 不触发 before-quit，复用退出清理序列停掉 mpv/aria2/推送/后端等子进程
        runQuitCleanup();
        app.relaunch();
        isQuitting = true;
        app.exit(0);
        return { ok: true };
    });
    // 代理设置（2.9）：校验 → 写入环境变量（后端 requests 继承）+ Electron session 代理（渲染层图片/请求），并重启后端使生效
    ipcMain.handle('yuki:set-proxy', async (_e, opts) => {
        const raw = String((opts && opts.url) || '').trim();
        const enable = !!(opts && opts.enable);
        // 参数校验（仿 Kazumi：启用前必须通过格式校验，非法地址直接拒绝，不落盘）
        const normalized = formatAndValidateProxyUrl(raw);
        if (enable && !normalized) {
            return { ok: false, reason: raw ? '无效的代理地址（示例：127.0.0.1:7890 或 http://127.0.0.1:7890）' : '请填写代理地址' };
        }
        const url = enable ? normalized : '';
        settings.set('proxyUrl', raw);
        settings.set('proxyEnable', enable);
        invalidateCache();
        try {
            if (enable && url) {
                process.env.HTTP_PROXY = url;
                process.env.HTTPS_PROXY = url;
                if (url.startsWith('socks')) {
                    // Electron session 不支持 socks 直设，显式走系统代理（渲染层直连）；socks 代理作用于后端/下载任务
                    await session.defaultSession.setProxy({ mode: 'system' });
                } else {
                    await session.defaultSession.setProxy({ proxyRules: url });
                }
            } else {
                delete process.env.HTTP_PROXY;
                delete process.env.HTTPS_PROXY;
                // 关闭代理开关：显式注入 NO_PROXY，让 Python 后端 requests（trust_env）强制直连，
                // 不再被系统代理（如 Clash 的环回系统代理）接管 —— 否则开关即使关闭，搜索/解析仍可能走代理。
                process.env.NO_PROXY = '*';
                process.env.no_proxy = '*';
                // 显式还原系统代理（T73）：proxyRules:'' 在部分 Electron 版本下不还原，渲染层网络仍走旧代理
                await session.defaultSession.setProxy({ mode: 'system' });
            }
        } catch (e) { /* session 代理失败不影响主流程 */ }
        // 后端重启使 Python requests 应用代理（播放/下载在主进程不受影响）
        try { bridge.stop(); bridge.start(); } catch (e) { /* 重启失败下次自愈 */ }
        return { ok: true };
    });

    // 夸克网盘 JAR 快路径开关：环境变量在后端进程启动时读取，因此修改后重启后端。
    ipcMain.handle('yuki:set-pan-fast-path', (_e, enabled) => {
        const fast = !!enabled;
        settings.set('panFastPath', fast);
        bridge.extraEnv.YUKI_PAN_FAST_PATH = fast ? '1' : '0';
        try { bridge.stop(); bridge.start(); return { ok: true, enabled: fast }; }
        catch (e) { return { ok: false, reason: e.message }; }
    });
    // 代理连通性测试:走给定代理访问测试 URL（不改变持久化设置）。
    // 原生实现（不依赖第三方 proxy-agent 包）：
    //   - http 目标：绝对形式请求行（完整 URL）经代理转发，收到响应即视为链路可用。
    //   - https 目标：先 CONNECT 建隧道（RFC 7231 §4.3.6），再在隧道内做 TLS 握手 + GET。
    //     旧实现用 https.request 且请求行带完整 URL → 实际把 TLS ClientHello 发给代理，
    //     普通 http 代理会直接断开（EPROTO/ECONNRESET），导致 https 测试地址恒失败。
    //   - socks5 代理：RFC1928 握手（无认证）+ CONNECT 隧道，建通即视为连通。
    ipcMain.handle('yuki:test-proxy', async (_e, opts) => {
        const raw = String((opts && opts.proxyUrl) || '').trim();
        const testUrl = String((opts && opts.url) || '').trim() || 'https://www.google.com/generate_204';
        if (!raw) return { ok: false, reason: '请填写代理地址' };
        let parsed;
        try { parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`); }
        catch (e) { return { ok: false, reason: '无效的代理地址' }; }
        const isSocks = /^socks5?$/i.test(parsed.protocol.replace(':', '')) || /^socks5?:\/\//i.test(raw);
        const host = parsed.hostname;
        const port = parseInt(parsed.port, 10);
        if (!host || !port || !Number.isInteger(port) || port < 1 || port > 65535) {
            return { ok: false, reason: '无效的代理地址（需要 host:port）' };
        }
        let target;
        try { target = new URL(testUrl); } catch (e) { return { ok: false, reason: '无效的测试 URL' }; }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return { ok: false, reason: '仅支持 http/https 测试地址' };
        }
        const tHost = target.hostname, tPort = parseInt(target.port, 10) || (target.protocol === 'https:' ? 443 : 80);
        const startedAt = Date.now();
        const timeoutMs = 15000;
        // 友好提示上下文：代理身份 + 测试目标，随结果返回给渲染层展示
        const proxyLabel = `${isSocks ? 'SOCKS5' : 'HTTP'}代理 ${host}:${port}`;
        const finish = (ok, reason, extra) => ({
            ok, reason: reason || undefined, elapsedMs: Date.now() - startedAt,
            proxy: proxyLabel, testHost: tHost, ...(extra || {}),
        });

        if (isSocks) {
            // ---- SOCKS5：握手 + CONNECT 隧道（RFC1928） ----
            return await new Promise((resolve) => {
                let sock;
                const timer = setTimeout(() => { try { sock && sock.destroy(); } catch (e) { /* ignore */ } resolve(finish(false, '超时（15s）')); }, timeoutMs);
                const fail = (reason) => { clearTimeout(timer); try { sock && sock.destroy(); } catch (e) { /* ignore */ } resolve(finish(false, reason)); };
                try {
                    const netMod = require('net');
                    sock = netMod.connect({ host, port });
                    sock.setNoDelay(true);
                    let buf = '';
                    sock.on('data', (chunk) => {
                        buf += chunk.toString('latin1');
                        // 阶段 1：版本选择响应 [VER=5, METHOD]
                        if (buf.length === 2 && buf[0] === '\u0005') {
                            if (buf[1] !== '\u0000') { fail('SOCKS5 服务器要求认证（仅支持无认证）'); return; }
                            buf = '';
                            const ipv4 = netMod.isIP(tHost) === 4, ipv6 = netMod.isIP(tHost) === 6;
                            const atyp = ipv6 ? 4 : (ipv4 ? 1 : 3);
                            let addr;
                            if (ipv4) addr = Buffer.from(tHost.split('.').map(Number));
                            else if (ipv6) {
                                // 展开 IPv6 到 16 字节（支持 :: 缩写）
                                let p = tHost;
                                const dc = p.indexOf('::');
                                if (dc >= 0) {
                                    const l = dc > 0 ? p.slice(0, dc).split(':') : [];
                                    const r = dc < p.length - 2 ? p.slice(dc + 2).split(':') : [];
                                    const mid = Array(8 - l.length - r.length).fill('0');
                                    p = l.concat(mid, r).join(':');
                                }
                                addr = Buffer.from(p.split(':').map((s) => parseInt(s || '0', 16)).flatMap((n) => [(n >> 8) & 0xff, n & 0xff]));
                            } else {
                                addr = Buffer.from(tHost, 'utf8');
                            }
                            const portBuf = Buffer.from([(tPort >> 8) & 0xff, tPort & 0xff]);
                            const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), addr, portBuf]);
                            sock.write(req);
                            buf = '';
                            return;
                        }
                        // 阶段 2：CONNECT 响应 [VER, REP, RSV, ATYP...]
                        if (buf.length >= 4 && buf[0] === '\u0005') {
                            if (buf[1] !== 0) { fail('SOCKS5 连接被拒绝（REP=' + buf[1] + '）'); return; }
                            clearTimeout(timer);
                            try { sock.destroy(); } catch (e) { /* ignore */ }
                            resolve(finish(true, undefined, { statusCode: 0, viaSocks: true }));
                            return;
                        }
                        // 阶段 1 响应异常（非 0x05 开头）
                        fail('SOCKS5 响应异常');
                    });
                    sock.on('error', (err) => fail(err && err.code ? err.code : (err && err.message) || '连接失败'));
                    sock.on('close', () => { if (buf.length < 4) fail('连接被关闭'); });
                    sock.write(Buffer.from([0x05, 0x01, 0x00]));
                } catch (e) { fail('连接失败：' + ((e && e.message) || e)); }
            });
        }

        if (target.protocol === 'https:') {
            // ---- HTTPS 目标：先 CONNECT 隧道，再在隧道内 TLS 握手 + GET ----
            return await new Promise((resolve) => {
                let sock;
                let timer = setTimeout(() => { try { sock && sock.destroy(); } catch (e) { /* ignore */ } resolve(finish(false, '超时（15s）')); }, timeoutMs);
                const fail = (reason) => { clearTimeout(timer); try { sock && sock.destroy(); } catch (e) { /* ignore */ } resolve(finish(false, reason)); };
                try {
                    const netMod = require('net');
                    sock = netMod.connect({ host, port });
                    sock.setNoDelay(true);
                    let buf = '';
                    sock.on('data', (chunk) => {
                        buf += chunk.toString('latin1');
                        if (!buf.includes('\r\n\r\n')) return;
                        const statusLine = buf.split('\r\n')[0];
                        const code = parseInt((statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/) || [])[1], 10);
                        if (!code) { fail('CONNECT 响应异常'); return; }
                        if (code < 200 || code >= 300) { fail(`CONNECT 被代理拒绝（HTTP ${code}）`); return; }
                        // 隧道建立成功：剥掉代理响应头，余下字节属于 TLS 握手，转交 tls 模块；
                        // 重装超时以覆盖 TLS 握手与 GET 阶段
                        clearTimeout(timer);
                        timer = setTimeout(() => { try { sock.destroy(); } catch (e) { /* ignore */ } resolve(finish(false, '超时（15s）')); }, timeoutMs);
                        sock.removeAllListeners('data');
                        const tlsMod = require('tls');
                        const tlsSock = tlsMod.connect({ socket: sock, servername: tHost, ALPNProtocols: ['http/1.1'] }, () => {
                            const httpMod = require('https');
                            const req = httpMod.request({
                                createConnection: () => tlsSock,
                                method: 'GET',
                                path: target.pathname + target.search,
                                headers: {
                                    Host: target.host,
                                    'User-Agent': 'YuKi/1.0 proxy-test',
                                    Accept: '*/*',
                                },
                            }, (res) => {
                                clearTimeout(timer);
                                res.resume();
                                resolve(finish(true, undefined, { statusCode: res.statusCode || 0, viaTunnel: true }));
                            });
                            req.on('error', (err) => fail(err && err.code ? err.code : (err && err.message) || '隧道内请求失败'));
                            req.end();
                        });
                        tlsSock.on('error', (err) => fail(err && err.code ? err.code : (err && err.message) || 'TLS 握手失败'));
                    });
                    sock.on('error', (err) => fail(err && err.code ? err.code : (err && err.message) || '连接失败'));
                    sock.on('close', () => { if (buf.length < 4) fail('连接被关闭'); });
                    sock.write(`CONNECT ${tHost}:${tPort} HTTP/1.1\r\nHost: ${tHost}:${tPort}\r\n\r\n`);
                } catch (e) { fail('连接失败：' + ((e && e.message) || e)); }
            });
        }

        // ---- HTTP 目标：绝对形式请求行（完整 URL）经代理转发 ----
        return await new Promise((resolve) => {
            let req;
            let mod;
            try { mod = require('http'); } catch (e) { resolve(finish(false, '模块加载失败')); return; }
            const reqOpts = {
                host, port, method: 'GET',
                path: testUrl, // 代理模式：完整 URL 放进请求行
                headers: {
                    Host: target.host,
                    'User-Agent': 'YuKi/1.0 proxy-test',
                    Accept: '*/*',
                },
            };
            const timer = setTimeout(() => { try { req && req.destroy(); } catch (e) { /* ignore */ } resolve(finish(false, '超时（15s）')); }, timeoutMs);
            try {
                req = mod.request(reqOpts, (res) => {
                    clearTimeout(timer);
                    res.resume();
                    resolve(finish(true, undefined, { statusCode: res.statusCode || 0 }));
                });
            } catch (e) { clearTimeout(timer); resolve(finish(false, '请求构造失败')); return; }
            req.on('error', (err) => { clearTimeout(timer); resolve(finish(false, err && err.code ? err.code : (err && err.message) || '连接失败')); });
            req.end();
        });
    });
    // 弹幕凭据：保存弹弹 play AppId/AppSecret，注入后端环境并重启后端生效
    ipcMain.handle('yuki:set-dandan', async (_e, opts) => {
        const appid = String((opts && opts.appid) || '').trim();
        const secret = String((opts && opts.secret) || '').trim();
        settings.set('dandanAppId', appid);
        settings.set('dandanAppSecret', secret);
        if (appid) bridge.extraEnv.DANDANAPI_APPID = appid; else delete bridge.extraEnv.DANDANAPI_APPID;
        if (secret) bridge.extraEnv.DANDANAPI_KEY = secret; else delete bridge.extraEnv.DANDANAPI_KEY;
        try { bridge.stop(); bridge.start(); } catch (e) { /* 重启失败下次自愈 */ }
        return { ok: true };
    });
    /** 合并 aria2 实时任务 + HLS 任务 + 持久化记录（T46）：
     *  持久化记录仅补「本会话不存在的 gid」（应用重启后 aria2c 丢失 stopped 记录，
     *  更换下载目录重启引擎同理），避免与实时任务重复。
     *  T81：同时恢复进行中（active/waiting/paused）任务，保留原始状态与进度。 */
    function buildDlList(items, hlsItems) {
        const live = [...items, ...hlsItems];
        const liveGids = new Set(live.map((t) => t.gid));
        const restored = dlRecords.all()
            .filter((r) => !liveGids.has(r.gid))
            .map((r) => {
                // 恢复进行中（active/waiting/paused）任务：显示为暂停状态，用户点击继续重新入队
                if (['active', 'waiting', 'paused'].includes(r.status)) {
                    return {
                        gid: r.gid, status: 'paused', kind: r.kind, name: r.name,
                        files: r.files || [], total: r.size || 0, done: r.done || 0,
                        percent: r.percent || 0, speed: 0, connections: '',
                        errorMessage: '', uri: r.uri || '',
                        addedAt: r.completedAt || 0, // 下载列表按时间排序用（最后状态变更时间近似）
                    };
                }
                // 已完成/失败任务：与原逻辑一致
                return {
                    gid: r.gid, status: r.status === 'error' ? 'error' : 'complete',
                    kind: r.kind, name: r.name, files: r.files || [],
                    total: r.size || 0, done: r.size || 0, percent: 100, speed: 0,
                    connections: '', errorMessage: r.status === 'error' ? (r.errorMessage || '') : '',
                    addedAt: r.completedAt || 0,
                };
            });
        return [...live, ...restored];
    }

    /** 持久化进行中任务（T81）：重启后恢复未完成的下载卡片。
     *  同 gid 状态/进度未变时跳过，减少磁盘写入。 */
    function persistInProgress(items, hlsItems) {
        const all = [...items, ...hlsItems];
        const now = Date.now();
        for (const t of all) {
            if (!['active', 'waiting', 'paused'].includes(t.status)) continue;
            const existing = dlRecords.all().find((r) => r.gid === t.gid);
            if (existing && existing.status === t.status && existing.percent === t.percent && existing.done === t.done) continue;
            dlRecords.add({
                gid: t.gid, kind: t.kind || 'aria2', name: t.name,
                files: t.files || [], size: t.total || 0, done: t.done || 0,
                percent: t.percent || 0, status: t.status, uri: t.uri || '',
                header: t.kind === 'hls' ? (t.header || undefined) : undefined, // L-8:HLS Referer/UA 随记录持久化
                epKey: dlDedupe.stamp(t.gid, existing), // 去重 key 随记录保留（dlRecords.add 按 gid 整条替换）
                completedAt: now,
            });
        }
    }

    function startDlPoll() {
        if (dlTimer) return;
        // 启动即推一次：空闲自停机制下，进入下载页仍能立刻看到历史任务列表。
        // 引擎冷启动期间 listAll 会阻塞等待 RPC 就绪，与立即解析的空列表竞速，
        // 先把持久化恢复记录推出去渲染；实时任务由后续 1s 轮询补上。
        (async () => {
            try {
                let items = [];
                try { items = await Promise.race([dl.listAll(), Promise.resolve([])]); } catch (e) { /* aria2 未就绪 */ }
                send('yuki:dl-list', buildDlList(items, hls.list()));
                persistInProgress(items, hls.list());
            } catch (e) { /* ignore */ }
        })();
        dlTimer = setInterval(async () => {
            try {
                // aria2 任务 + m3u8 合成任务合并推送（aria2 未就绪不阻断 HLS 展示）
                let items = [];
                try { items = await dl.listAll(); } catch (e) { /* 下一轮会重新拉起 aria2c */ }
                const hlsItems = hls.list();
                send('yuki:dl-list', buildDlList(items, hlsItems));
                // 持久化进行中任务（T81）：每轮尝试，但仅状态变化时才写盘，重启后恢复
                persistInProgress(items, hlsItems);
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

    /** 跨卷移动兜底：同卷 rename，EXDEV（如 C: → D:）退化为复制后删除。目录递归。 */
    function movePathSync(src, dest) {
        try {
            fs.renameSync(src, dest);
            return true;
        } catch (e) {
            try {
                if (fs.statSync(src).isDirectory()) {
                    fs.cpSync(src, dest, { recursive: true });
                    fs.rmSync(src, { recursive: true, force: true });
                } else {
                    fs.copyFileSync(src, dest);
                    fs.rmSync(src, { force: true });
                }
                return true;
            } catch (e2) { return false; }
        }
    }

    /** 尽力删除一批文件/目录：aria2c/ffmpeg 释放句柄可能滞后于 RPC 返回，Windows 上
     *  rmSync 会因句柄未关（EBUSY/EPERM）失败——这正是「删除运行中任务后残留 .aria2」
     *  的根因。失败项间隔递增重试（共 5 次尝试），仍失败则留待下次（不阻塞 IPC）。 */
    function rmFilesBestEffort(files, isDir, attempt = 0) {
        const list = (files || []).filter(Boolean);
        if (!list.length) return;
        const left = [];
        for (const f of list) {
            try { fs.rmSync(f, { recursive: !!isDir, force: true }); } catch (e) { left.push(f); }
        }
        const remaining = left.filter((f) => {
            try { return fs.existsSync(f); } catch (e) { return false; }
        });
        if (remaining.length && attempt < 4) {
            setTimeout(() => rmFilesBestEffort(remaining, isDir, attempt + 1), 500 * (attempt + 1));
        }
    }

    /** 更换下载目录第一步：暂停在途任务并把产物（含 .aria2 断点控制文件）迁到新目录。
     *  aria2c 进程无会话持久化，stop 后任务即丢，返回快照供引擎重启后重新入队
     *  （.aria2 控制文件随迁 + continue=true ⇒ 断点续传）。HLS 任务由 hls.migrateDir
     *  处理（分片目录随迁 + 已存在分片跳过）。requeue 条目带旧 gid：重新入队后
     *  新任务拿到新 gid，需据此清除旧 gid 的持久化记录，否则 buildDlList 把旧记录
     *  恢复成「已暂停」幽灵卡片——同一下载出现两张卡，点继续还会真实重复下载。 */
    async function migrateDlFiles(newDir) {
        const result = { moved: 0, requeue: [] };
        if (!dl.isAvailable()) return result;
        let tasks = [];
        try { tasks = await dl.listAll(); } catch (e) { return result; }
        const inProgress = tasks.filter((t) => ['active', 'waiting', 'paused'].includes(t.status) && t.uri);
        try { await dl.pauseAll(); } catch (e) { /* 无活跃任务 */ }
        try { fs.mkdirSync(newDir, { recursive: true }); } catch (e) { /* ignore */ }
        for (const t of inProgress) {
            try {
                const files = (t.files || []).filter((f) => f && f !== '.');
                for (const f of files) {
                    const base = path.basename(f);
                    if (movePathSync(f, path.join(newDir, base))) result.moved++;
                    movePathSync(f + '.aria2', path.join(newDir, base + '.aria2'));
                }
                result.requeue.push({ gid: t.gid, uri: t.uri, name: t.name, header: t.header || null });
            } catch (e) { /* 单任务失败不影响其余 */ }
        }
        try { hls.migrateDir(newDir); } catch (e) { /* HLS 迁移失败不阻断引擎重启 */ }
        return result;
    }

    /** 更换下载目录第二步：引擎已按新目录重启，把快照里的在途任务重新入队（断点续传）。
     *  重新入队后任务拿到新 gid：成功入队即清除旧 gid 的持久化记录（persistInProgress
     *  在迁移期间已把旧 gid 落盘），否则旧记录被恢复成幽灵「已暂停」卡片造成列表
     *  重复 + 重复下载。入队失败的保留记录，用户仍可手动继续。 */
    async function requeueDlTasks(requeue) {
        let n = 0;
        for (const it of requeue || []) {
            try {
                if (!it || !it.uri) continue;
                const isMagnet = /^magnet:/i.test(it.uri);
                const opts = { continue: 'true' };
                // 磁链不带 out（会干扰多文件种子）；HTTP 带原文件名恢复
                if (!isMagnet && it.name && /\.[a-z0-9]{1,5}$/i.test(path.basename(it.name))) {
                    opts.out = path.basename(it.name);
                }
                const newGid = await dl.addUri(it.uri, opts);
                if (it.gid) {
                    // 去重 key 随任务迁移到新 gid，再清旧记录（防幽灵卡片复活）
                    dlDedupe.carry(it.gid, newGid);
                    dlRecords.remove(it.gid);
                }
                n++;
            } catch (e) { /* 单任务失败不影响其余 */ }
        }
        return n;
    }

    /** 按持久化设置拉起 aria2 引擎：并发任务数/分片并发数随 CLI 参数一并生效。
     *  统一入口——此前 add/addFile/pickDir 路径首次拉起时不带持久化值，
     *  用户改过的并发表会被默认值覆盖。 */
    function startDlEngine(dir) {
        return dl.start(dir,
            parseInt(settings.get('dlConcurrency'), 10) || undefined,
            parseInt(settings.get('dlSplitConcurrency'), 10) || undefined);
    }

    ipcMain.handle('yuki:dl', async (_e, action, payload = {}) => {
        try {
            switch (action) {
                case 'init': {
                    if (!dl.isAvailable()) return { ok: false, reason: 'aria2-missing' };
                    const dir = settings.get('dlDir') || app.getPath('downloads');
                    // 先拉起轮询再等引擎：持久化恢复的历史任务立即渲染，aria2 启动
                    // 不阻塞下载页首屏（引擎就绪后再次拉起，确保空闲自停后轮询照常）
                    startDlPoll();
                    await startDlEngine(dir);
                    syncDlDir(dl.dir);
                    // m3u8 任务队列上限与「并发任务数」保持一致（HLS 不经 aria2，需独立同步）
                    hls.setMaxActive(Math.max(1, Math.min(10, parseInt(settings.get('dlConcurrency'), 10) || 3)));
                    startDlPoll();
                    return { ok: true, dir: dl.dir };
                }
                case 'pickDir': {
                    // 更换下载目录：在途任务先暂停并把文件（含 .aria2 断点控制文件）迁到新目录，
                    // 重启引擎后重新入队续传；已完成文件同样随迁
                    const r = await dialog.showOpenDialog(win, {
                        title: '选择下载目录',
                        properties: ['openDirectory', 'createDirectory'],
                    });
                    if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
                    const dir = r.filePaths[0];
                    settings.set('dlDir', dir);
                    syncDlDir(dir);
                    let migrated = 0;
                    let resumed = 0;
                    if (dl.isAvailable()) {
                        const mig = await migrateDlFiles(dir);
                        migrated = mig.moved;
                        dl.stop();
                        await startDlEngine(dir);
                        resumed = await requeueDlTasks(mig.requeue);
                    }
                    startDlPoll();
                    return { ok: true, dir, migrated, resumed };
                }
                case 'resetDir': {
                    // 恢复默认下载位置：清掉自定义 dlDir，迁文件 + 重启引擎到系统下载目录
                    const dir = app.getPath('downloads');
                    const hadCustom = !!settings.get('dlDir');
                    settings.delete('dlDir');
                    syncDlDir(dir);
                    let migrated = 0;
                    let resumed = 0;
                    if (dl.isAvailable()) {
                        const mig = await migrateDlFiles(dir);
                        migrated = mig.moved;
                        dl.stop();
                        await startDlEngine(dir);
                        resumed = await requeueDlTasks(mig.requeue);
                    }
                    startDlPoll();
                    return { ok: true, dir, migrated, resumed, hadCustom };
                }
                case 'add': {
                    if (!dl.isAvailable()) return { ok: false, reason: 'aria2-missing' };
                    const uri = String(payload.uri || '').trim();
                    if (!uri) throw new Error('empty uri');
                    if (!/^(magnet:|http:|https:)/i.test(uri)) throw new Error('unsupported uri');
                    // 同源同集去重：详情页/Kazumi 下载会带 ep* 上下文，命中直接跳过。
                    // vod 一律用剧名（与播放链 meta.title 同源）：手动下载与边下边播两条
                    // 路径才能归到同一 key；vodId 仅详情页有、播放链拿不到，不能掺入。
                    const epKey = buildEpisodeKey({
                        site: payload.epSite, vod: payload.epVodName, episode: payload.epName,
                    });
                    if (epKey) {
                        const dup = await dlDedupe.check(epKey);
                        if (dup) {
                            return { ok: false, reason: dup.state === 'done' ? 'already-done' : 'already-downloading',
                                file: dup.file || '', gid: dup.gid || '' };
                        }
                    }
                    await startDlEngine(dl.dir || app.getPath('downloads'));
                    // 详情页批量下载可带文件名与请求头（部分源校验 Referer）
                    const opts = {};
                    let out = String(payload.out || '').replace(/[\\/:*?"<>|]/g, '_').trim();
                    // 兜底合成文件名：不带 out 的直链下载（下载页「新建」）若放任 aria2
                    // 用 URL 最后一段命名，query 形式/无后缀的直链（…/video?sign=…）
                    // 存出来没有扩展名，播放器无法识别。仿 detail.js：URL 猜扩展，猜不到补 .mp4
                    if (!out && /^https?:\/\//i.test(uri)) {
                        const clean = uri.split('?')[0].split('#')[0];
                        let name = decodeURIComponent(clean.split('/').filter(Boolean).pop() || 'video');
                        name = name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'video';
                        const ext = (clean.match(/\.(mp4|flv|mov|mkv|webm|avi|ts|m4a|mp3|flac|ass|srt|zip|rar|7z)$/i) || [''])[0];
                        if (!/\.\w{1,5}$/.test(name)) name += ext || '.mp4';
                        out = name;
                    }
                    if (out) opts.out = out.slice(0, 150);
                    if (payload.header && typeof payload.header === 'object') {
                        const pairs = Object.entries(payload.header)
                            .filter(([, v]) => v != null && v !== '')
                            .map(([k, v]) => `${k}: ${v}`);
                        if (pairs.length) opts.header = pairs;
                    }
                    const gid = await dl.addUri(uri, opts);
                    // 入队即写携带 epKey 的初始记录：跨重启可恢复、查重立即可见
                    // （后续轮询按真实进度覆盖同 gid 记录，epKey 经 stamp 保留）
                    if (epKey) {
                        dlDedupe.bind(gid, epKey, {
                            gid, kind: 'aria2', name: (out ? String(out).slice(0, 150) : '') || uri,
                            files: [], size: 0, done: 0, percent: 0,
                            status: 'waiting', uri,
                            header: (opts.header && Array.isArray(opts.header))
                                ? Object.fromEntries(opts.header.map((h) => { const i = h.indexOf(': '); return [h.slice(0, i), h.slice(i + 2)]; }))
                                : undefined,
                            completedAt: Date.now(),
                        });
                    }
                    startDlPoll();
                    return { ok: true, gid };
                }
                case 'addHls': {
                    // m3u8 切片流：分片并发模式（concurrency > 1）或 ffmpeg 顺序拉流（兜底）
                    const uri = String(payload.uri || '').trim();
                    if (!uri) throw new Error('empty uri');
                    // M-2：仅放行 http(s)，防 file:// 等本地/畸形 scheme 经 ffmpeg/分片拉取触碰本地文件
                    if (!/^https?:\/\//i.test(uri)) throw new Error('bad uri protocol');
                    // 同源同集去重（与 add 一致）：命中「下载中/已完成」直接跳过
                    const epKey = buildEpisodeKey({
                        site: payload.epSite, vod: payload.epVodName, episode: payload.epName,
                    });
                    if (epKey) {
                        const dup = await dlDedupe.check(epKey);
                        if (dup) {
                            return { ok: false, reason: dup.state === 'done' ? 'already-done' : 'already-downloading',
                                file: dup.file || '', gid: dup.gid || '' };
                        }
                    }
                    syncDlDir(dl.dir || settings.get('dlDir') || app.getPath('downloads'));
                    let gid;
                    try {
                        gid = hls.add({
                            url: uri, out: payload.out, header: payload.header,
                            // 广告过滤开关（设置项 hlsAdFilter，默认关；开启时过滤 CUE-OUT/CUE-IN 广告分段）
                            adFilter: payload.adFilter !== undefined ? !!payload.adFilter : settings.get('hlsAdFilter'),
                            // 分片并发数（设置项 dlSplitConcurrency，默认 5；>1 时走分片并发模式）
                            concurrency: Math.max(1, Math.min(32, parseInt(settings.get('dlSplitConcurrency'), 10) || 5)),
                        });
                    } catch (e) {
                        // ffmpeg 首次启动正后台自动下载（约 90MB）：区别于「未安装」，渲染层提示稍后重试
                        if (e && e.message === 'ffmpeg-missing' && ffmpegEnsuring()) return { ok: false, reason: 'ffmpeg-downloading' };
                        throw e;
                    }
                    if (epKey) {
                        dlDedupe.bind(gid, epKey, {
                            gid, kind: 'hls', name: String(payload.out || '') || uri,
                            files: [], size: 0, done: 0, percent: 0,
                            status: 'active', uri,
                            header: (payload.header && typeof payload.header === 'object') ? payload.header : undefined,
                            completedAt: Date.now(),
                        });
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
                    await startDlEngine(dl.dir || app.getPath('downloads'));
                    const gid = fp.toLowerCase().endsWith('.torrent')
                        ? await dl.addTorrent(b64)
                        : await dl.addMetalink(b64);
                    startDlPoll();
                    return { ok: true, gid };
                }
                case 'setConcurrency': {
                    const n = Math.max(1, Math.min(10, parseInt(payload.n, 10) || 3));
                    settings.set('dlConcurrency', n);
                    // aria2 运行中即时生效；RPC 失败时如实上报 ok:false（渲染层提示重启引擎后生效）
                    let applied = false;
                    if (dl.isAvailable()) {
                        try { await dl.setConcurrency(n); applied = true; } catch (e) { /* 引擎异常，下轮启动生效 */ }
                    }
                    // m3u8 任务队列不经 aria2，始终立即按新上限调度
                    hls.setMaxActive(n);
                    return applied ? { ok: true, n } : { ok: false, n, reason: 'engine-restart-needed' };
                }
                case 'setSplit': {
                    const n = Math.max(1, Math.min(32, parseInt(payload.n, 10) || 5));
                    settings.set('dlSplitConcurrency', n);
                    let applied = false;
                    if (dl.isAvailable()) {
                        try { await dl.setSplit(n); applied = true; } catch (e) { /* 下轮启动生效 */ }
                    }
                    hls.setConcurrency(n); // 即时更新 HLS 分片并发数（后续新增任务生效）
                    return applied ? { ok: true, n } : { ok: false, n, reason: 'engine-restart-needed' };
                }
                case 'pause': {
                    // HLS（m3u8/page 源）任务已支持暂停：杀进程保留分片，继续时断点续传
                    if (String(payload.gid).startsWith('hls-')) {
                        return hls.pause(String(payload.gid))
                            ? { ok: true }
                            : { ok: false, reason: '任务不存在或不在进行中' };
                    }
                    await dl.pause(payload.gid); return { ok: true };
                }
                case 'pauseAll': {
                    // 全部暂停：aria2 任务 + HLS 任务（此前 m3u8 任务无暂停能力被跳过）
                    let n = 0;
                    if (dl.isAvailable()) {
                        try { n += ((await dl.pauseAll()) || []).length; } catch (e) { /* 无活跃任务时 aria2 可能返回空，忽略 */ }
                    }
                    n += hls.pauseAll();
                    try { send('yuki:dl-list', buildDlList(await dl.listAll().catch(() => []), hls.list())); } catch (e) { /* ignore */ }
                    startDlPoll();
                    return { ok: true, n };
                }
                case 'unpauseAll': {
                    let gids = [];
                    if (dl.isAvailable()) {
                        try { gids = (await dl.unpauseAll()) || []; } catch (e) { /* 引擎异常按 0 处理，仍继续恢复持久化记录 */ }
                    }
                    // 会话内暂停的 HLS 任务原地唤醒（保留分片续传）
                    const hlsN = hls.unpauseAll();
                    // 重启后仅存于持久化记录的进行中任务（aria2 已无此任务，列表显示为暂停卡片）：
                    // 与单个「继续」一致地重新入队，否则全部开始会误报「没有已暂停的任务」。
                    const liveGids = new Set([
                        ...(await dl.listAll().catch(() => [])).map((t) => t.gid),
                        ...hls.list().map((t) => t.gid),
                        ...gids,
                    ]);
                    for (const rec of dlRecords.all()) {
                        if (!rec || !rec.uri || liveGids.has(rec.gid)) continue;
                        if (!['active', 'waiting', 'paused'].includes(rec.status)) continue;
                        try {
                            if (rec.kind === 'hls') {
                                syncDlDir(dl.dir || settings.get('dlDir') || app.getPath('downloads'));
                                const hlsGid = hls.add({
                                    url: rec.uri, out: rec.name,
                                    header: rec.header || undefined, // L-8:恢复原任务的 Referer/UA，避免重启后 403
                                    adFilter: settings.get('hlsAdFilter'),
                                    concurrency: Math.max(1, Math.min(32, parseInt(settings.get('dlSplitConcurrency'), 10) || 5)),
                                });
                                dlDedupe.carry(rec.gid, hlsGid);
                            } else {
                                // 磁链不用 out 参数（会干扰多文件 BT 种子），普通 HTTP/HTTPS 带文件名恢复
                                const isMagnet = /^magnet:/i.test(rec.uri);
                                const opts = {};
                                if (!isMagnet && rec.name && /\.\w{1,5}$/.test(rec.name)) opts.out = rec.name;
                                const newGid = await dl.addUri(rec.uri, opts);
                                dlDedupe.carry(rec.gid, newGid);
                            }
                            dlRecords.remove(rec.gid); // 移除旧 gid 记录，新任务由轮询重新持久化
                            gids.push(rec.gid);
                        } catch (e) { /* 单个恢复失败不阻塞其余任务 */ }
                    }
                    try { send('yuki:dl-list', buildDlList(await dl.listAll().catch(() => []), hls.list())); } catch (e) { /* ignore */ }
                    startDlPoll();
                    return { ok: true, n: hlsN + (Array.isArray(gids) ? gids.length : 0) };
                }
                case 'unpause':
                    if (String(payload.gid).startsWith('hls-')) {
                        // 会话内暂停的 HLS 任务原地唤醒（保留分片断点续传）；引擎重启后
                        // 任务对象已丢（卡片来自持久化记录），按原 URL 重新入队
                        if (hls.unpause(String(payload.gid))) {
                            startDlPoll();
                            try { send('yuki:dl-list', buildDlList(await dl.listAll().catch(() => []), hls.list())); } catch (e) { /* ignore */ }
                            return { ok: true };
                        }
                        // HLS 任务：尝试从持久化记录恢复原始 URL
                        const rec = dlRecords.all().find((r) => r.gid === payload.gid);
                        if (rec && rec.uri) {
                            syncDlDir(dl.dir || settings.get('dlDir') || app.getPath('downloads'));
                            try {
                                const gid = hls.add({
                                    url: rec.uri, out: rec.name,
                                    header: rec.header || undefined, // L-8:恢复原任务的 Referer/UA，避免重启后 403
                                    adFilter: settings.get('hlsAdFilter'),
                                    concurrency: Math.max(1, Math.min(32, parseInt(settings.get('dlSplitConcurrency'), 10) || 5)),
                                });
                                dlDedupe.carry(payload.gid, gid);
                                dlRecords.remove(payload.gid);
                                startDlPoll();
                                try { send('yuki:dl-list', buildDlList(await dl.listAll().catch(() => []), hls.list())); } catch (e) { /* ignore */ }
                                return { ok: true, gid, resumed: true };
                            } catch (e) {
                                if (e && e.message === 'ffmpeg-missing' && ffmpegEnsuring()) return { ok: false, reason: 'ffmpeg-downloading' };
                                throw e;
                            }
                        }
                        return { ok: false, reason: 'not-supported' };
                    }
                    try {
                        await dl.unpause(payload.gid);
                        return { ok: true };
                    } catch (e) {
                        // 任务可能不在 aria2 中（重启后丢失），尝试从持久化记录恢复
                        const rec = dlRecords.all().find((r) => r.gid === payload.gid);
                        if (rec && rec.uri && rec.kind !== 'hls') {
                            // 磁链不用 out 参数（会干扰多文件 BT 种子），普通 HTTP/HTTPS 带文件名恢复
                            const isMagnet = /^magnet:/i.test(rec.uri);
                            const opts = {};
                            if (!isMagnet && rec.name && /\.\w{1,5}$/.test(rec.name)) opts.out = rec.name;
                            const gid = await dl.addUri(rec.uri, opts);
                            dlDedupe.carry(payload.gid, gid);
                            dlRecords.remove(payload.gid); // 移除旧 gid 记录，新任务会重新持久化
                            startDlPoll();
                            // 立即推送新列表，避免旧卡消失后新卡延迟 1s 才出现
                            try { send('yuki:dl-list', buildDlList(await dl.listAll().catch(() => []), hls.list())); } catch (e) { /* ignore */ }
                            return { ok: true, gid, resumed: true };
                        }
                        return { ok: false, reason: 'task not found and cannot resume' };
                    }
                case 'remove': {
                    // 收集文件路径（在移除任务/记录之前取，避免取不到）。
                    // delFiles=内容文件（仅 deleteFiles=true 时删除）；ctrlFiles=断点控制文件与
                    // 临时产物（.aria2/.incomplete/.part/.adfilter）——任务已删则它们无所依附，
                    // 「仅移除（保留文件）」也一并清掉，否则磁盘上残留孤儿 .aria2/分片临时文件。
                    const deleteFiles = payload.deleteFiles !== false;
                    const delFiles = new Set();
                    const ctrlFiles = new Set();
                    const hlsSegsDirs = [];
                    if (String(payload.gid).startsWith('hls-')) {
                        const t = hls._tasks.get(payload.gid);
                        if (t && t.files) t.files.forEach((f) => delFiles.add(f));
                    } else {
                        // aria2 任务：从 tellStatus 取文件路径
                        if (dl.isAvailable()) {
                            try {
                                const st = await dl.tellStatus(payload.gid);
                                if (st && st.files) for (const f of st.files) {
                                    if (f && f.path && f.path !== '.') {
                                        delFiles.add(f.path);
                                        // 同时收集 .aria2 控制文件和临时文件（进行中的任务路径可能为空）
                                        ctrlFiles.add(f.path + '.aria2');
                                    }
                                }
                                // 进行中的任务 tellStatus 可能不返回完整路径：
                                // 尝试从 aria2 dir + 文件名构造路径
                                if (st && st.files && st.files.length && st.dir) {
                                    for (const f of st.files) {
                                        if ((!f.path || f.path === '.') && f.uris && f.uris.length) {
                                            // 从 URL 推断文件名
                                            try {
                                                const u = new URL(f.uris[0].uri);
                                                const name = u.pathname.split('/').pop() || '';
                                                if (name) {
                                                    const full = path.join(st.dir, name);
                                                    delFiles.add(full);
                                                    ctrlFiles.add(full + '.aria2');
                                                }
                                            } catch (e) { /* URL 解析失败忽略 */ }
                                        }
                                    }
                                }
                            } catch (e) { /* 任务可能已不在 aria2 */ }
                        }
                    }
                    // 兜底：从持久化记录取文件路径
                    const rec = dlRecords.all().find((r) => r.gid === payload.gid);
                    if (rec && rec.files) rec.files.forEach((f) => { if (f && f !== '.') delFiles.add(f); });
                    // HLS 残留补齐：引擎重启后 hls._tasks 里没有该任务（卡片来自持久化记录），
                    // 此前分片临时目录与 .incomplete 部分文件不收集 → 删除任务后残留。
                    // 无论 live/恢复态，统一按成品路径推导全部临时产物。
                    if (String(payload.gid).startsWith('hls-')) {
                        const dest = [...delFiles][0] || '';
                        if (dest) {
                            const ext = path.extname(dest);
                            ctrlFiles.add(dest + '.incomplete' + ext);
                            ctrlFiles.add(dest + '.part'); // 历史版本临时名
                            ctrlFiles.add(dest + '.adfilter.m3u8');
                            hlsSegsDirs.push(`${dest}.${payload.gid}.segs`);
                        }
                    } else {
                        // aria2 控制文件对持久化记录里的路径同样补一份
                        for (const f of [...delFiles]) ctrlFiles.add(f + '.aria2');
                    }
                    // 先移除任务（停止写入），再删除文件
                    dlRecords.remove(payload.gid);
                    dlDedupe.drop(payload.gid); // 会话去重登记同步清除（持久化记录已随上一行删除）
                    if (String(payload.gid).startsWith('hls-')) { hls.remove(payload.gid); }
                    else { await dl.remove(payload.gid); }
                    if (deleteFiles) rmFilesBestEffort([...delFiles, ...ctrlFiles]);
                    else rmFilesBestEffort([...ctrlFiles]);
                    for (const d of hlsSegsDirs) rmFilesBestEffort([d], true);
                    // 删除后立即推送刷新列表 + 重启轮询（可能有剩余活跃任务）
                    try { send('yuki:dl-list', buildDlList(await dl.listAll().catch(() => []), hls.list())); } catch (e) { /* ignore */ }
                    startDlPoll();
                    return { ok: true, deletedFiles: deleteFiles };
                }
                case 'clearFailed': {
                    // 删失败任务及其未完成产物（aria2 --continue 会残留部分下载的文件）
                    let n = 0;
                    if (dl.isAvailable() && dl.proc) {
                        const stopped = await dl.tellStopped();
                        for (const s of stopped) {
                            if (s.status !== 'error') continue;
                            // 删除全部产出文件（非仅第一个）
                            if (s.files) for (const f of s.files) {
                                if (f && f.path && f.path !== '.') { try { fs.rmSync(f.path, { force: true }); } catch (e) { /* ignore */ } }
                            }
                            try { await dl.purge(s.gid); n++; } catch (e) { /* ignore */ }
                        }
                    }
                    // 删除持久化记录中失败任务的文件（重启后从 dlRecords 恢复的错误任务）
                    for (const r of dlRecords.all()) {
                        if (r.status === 'error' && r.files) for (const f of r.files) {
                            if (f && f !== '.') { try { fs.rmSync(f, { force: true }); } catch (e) { /* ignore */ } }
                        }
                    }
                    n += hls.clearFailed();
                    dlRecords.clearErrors(); // 同步清掉失败记录
                    // 删除后立即推送刷新列表 + 重启轮询
                    try { send('yuki:dl-list', buildDlList(await dl.listAll().catch(() => []), hls.list())); } catch (e) { /* ignore */ }
                    startDlPoll();
                    return { ok: true, n };
                }
                case 'clear': {
                    // 清除已完成：仅从列表/记录中移除任务条目，保留磁盘上已下载的文件。
                    // （失败任务的残留清理仍走 clearFailed；此处只清完成/移除项的列表信息）
                    if (dl.isAvailable() && dl.proc) {
                        const stopped = await dl.tellStopped();
                        for (const s of stopped) {
                            if (['complete', 'error', 'removed'].includes(s.status)) {
                                // 只从 aria2 停止列表移除记录，不删产出文件
                                try { await dl.purge(s.gid); } catch (e) { /* ignore */ }
                            }
                        }
                    }
                    // HLS：仅移除已停止任务的列表记录，保留合成好的成品文件（clearStopped 只清临时分片目录）
                    hls.clearStopped();
                    dlRecords.clearFinished(); // 清已结束记录，保留进行中任务（T81：未完成卡片不消失）
                    // 清除后立即推送刷新列表 + 重启轮询
                    try { send('yuki:dl-list', buildDlList(await dl.listAll().catch(() => []), hls.list())); } catch (e) { /* ignore */ }
                    startDlPoll();
                    return { ok: true };
                }
                default: return { ok: false, reason: `unknown action ${action}` };
            }
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // 打开下载目录（不依赖 aria2 状态；未更换过则打开系统默认下载目录）
    ipcMain.handle('yuki:dl-open-dir', async () => {
        try {
            const dir = dl.dir || settings.get('dlDir') || app.getPath('downloads');
            const err = await shell.openPath(dir);
            if (err) return { ok: false, reason: err };
            return { ok: true, dir };
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // 下载完成一键播放：直接播本地产出文件（来源为下载任务的 files，均在下载目录内）
    ipcMain.handle('yuki:dl-play', async (_e, filePath) => {
        try {
            // 指定播放器为主播放器（VLC/PotPlayer 等）时优先交它，与 yuki:play 行为一致；
            // 此时不再依赖内置 mpv（未装内置 mpv 也能用指定播放器起播）
            const extPrimary = primaryExternalPlayer();
            if (!extPrimary && !mpv.isAvailable()) return { ok: false, reason: 'mpv-missing' };
            const abs0 = path.resolve(String(filePath || ''));
            let abs = abs0;
            // L-1：路径限制在下载目录或本地媒体根目录内（path.relative 无 '..' 前缀且非绝对），
            // 防页面脚本传任意本地路径借 mpv 播放窥探磁盘
            const inside = (root) => {
                if (!root) return false;
                const rel = path.relative(path.resolve(String(root)), abs);
                return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
            };
            const dlRoot = dl.dir || settings.get('dlDir') || app.getPath('downloads');
            // 间歇性「文件未找到」兜底：完成时的自动补 .mp4 改名只有当次推送看到新路径，
            // aria2 后续 tellStatus 仍报旧路径（引擎不知道磁盘改名）——按旧路径找不到时
            // 依次尝试补 .mp4 / 下载根目录同 basename / 持久化记录里的新路径
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
                const bn = path.basename(abs0);
                const cands = [abs0 + '.mp4'];
                if (dlRoot) {
                    cands.push(path.join(dlRoot, bn));
                    if (!/\.[a-z0-9]{1,5}$/i.test(bn)) cands.push(path.join(dlRoot, bn + '.mp4'));
                }
                try {
                    const rec = dlRecords.all().find((r) => r.files && r.files.length === 1
                        && path.resolve(String(r.files[0])) === abs0);
                    if (rec) cands.push(path.resolve(String(rec.files[0])));
                } catch (e) { /* ignore */ }
                for (const c of cands) {
                    try {
                        if (c && fs.existsSync(c) && fs.statSync(c).isFile()) { abs = path.resolve(c); break; }
                    } catch (e) { /* ignore */ }
                }
            }
            if (!inside(dlRoot) && !inside(fileMgr.root)) return { ok: false, reason: 'path-denied' };
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, reason: 'file-not-found' };
            // 无扩展名文件放行：让 mpv 实际探测容器格式（修复前下载的无后缀存量文件可播；
            // 带扩展名但不在视频白名单的仍拒绝，保留 not-video 防线）
            if (!fileMgr.isVideo(abs) && path.extname(abs)) return { ok: false, reason: 'not-video' };
            const title = path.basename(abs);
            if (extPrimary) {
                // 本地文件无鉴权头；Windows 反斜杠路径转正斜杠，规避个别播放器解析问题
                const r = launchExternalPlayer(extPrimary, abs.replace(/\\/g, '/'));
                return r.ok ? { ...r, viaExternal: true } : r;
            }
            // 与 yuki:play 对齐：起播前刷新 Anime4K 着色器链，下载文件同样实时生效
            mpv.anime4kShaders = anime4kChainFromSettings();
            const r = mpv.play([{ url: abs, title }], { title });
            if (!r.ok) return r;
            const started = await verifyMpvStart(r, MPV_START_TIMEOUT_MS);
            if (started.ok) { afterPlay(); attachAnime4kInfo(started); }
            return started;
        } catch (err) { return { ok: false, reason: err.message }; }
    });

    // ---- Phase 6 下载管理（aria2c JSON-RPC） ----

    dl.on('completed', (task) => {
        // 无后缀产物兜底补 .mp4（视频应用语境）：旧版任务/特殊直链可能存出无扩展名文件，
        // 下载页与播放均按扩展名识别导致「下载完播不了」。只动单文件任务且仅缺扩展名时重命名。
        try {
            if (task.files && task.files.length === 1) {
                const f0 = String(task.files[0]);
                if (f0 && !/\.[a-z0-9]{1,5}$/i.test(path.basename(f0)) && fs.existsSync(f0)) {
                    const renamed = f0 + '.mp4';
                    fs.renameSync(f0, renamed);
                    task.files = [renamed];
                    if (task.name && path.basename(task.name) === path.basename(f0)) {
                        task.name = path.basename(renamed);
                    }
                    console.log(`[dl] 无后缀产物已补扩展名：${path.basename(f0)} -> ${path.basename(renamed)}`);
                }
            }
        } catch (e) { console.warn(`[dl] 补扩展名失败：${e && e.message}`); }
        if (Notification.isSupported()) {
            const n = new Notification({ title: '下载完成', body: task.name || task.gid });
            n.on('click', () => { if (win) { win.show(); win.focus(); send('yuki:dl-goto', {}); } });
            n.show();
        }
        // 完成记录需保留去重 key：dlRecords.add 按 gid 整条替换，从旧记录回填 epKey
        const prevRec = dlRecords.all().find((x) => x.gid === task.gid);
        dlRecords.add({ gid: task.gid, kind: 'aria2', name: task.name, files: task.files,
            size: task.total || 0, status: 'complete', epKey: dlDedupe.stamp(task.gid, prevRec),
            completedAt: Date.now() });
        send('yuki:dl-event', { type: 'completed', task });
    });
    dl.on('error', (task) => {
        const prevErr = dlRecords.all().find((x) => x.gid === task.gid);
        dlRecords.add({ gid: task.gid, kind: 'aria2', name: task.name, files: task.files,
            size: task.total || 0, status: 'error', errorMessage: task.errorMessage || '',
            epKey: dlDedupe.stamp(task.gid, prevErr),
            completedAt: Date.now() });
        send('yuki:dl-event', { type: 'error', task });
    });
    // m3u8 合成任务完成/失败：与 aria2 同一套通知链路
    hls.on('completed', (task) => {
        if (Notification.isSupported()) {
            const n = new Notification({ title: '下载完成（m3u8 已合成）', body: task.name });
            n.on('click', () => { if (win) { win.show(); win.focus(); send('yuki:dl-goto', {}); } });
            n.show();
        }
        const prevHls = dlRecords.all().find((x) => x.gid === task.gid);
        dlRecords.add({ gid: task.gid, kind: 'hls', name: task.name, files: task.files,
            size: 0, status: 'complete', epKey: dlDedupe.stamp(task.gid, prevHls),
            completedAt: Date.now() });
        send('yuki:dl-event', { type: 'completed', task });
    });
    hls.on('error', (task) => {
        const prevHlsErr = dlRecords.all().find((x) => x.gid === task.gid);
        dlRecords.add({ gid: task.gid, kind: 'hls', name: task.name, files: task.files,
            size: 0, status: 'error', errorMessage: task.errorMessage || '',
            epKey: dlDedupe.stamp(task.gid, prevHlsErr),
            completedAt: Date.now() });
        send('yuki:dl-event', { type: 'error', task });
    });

    // 在线整季原生播放列表：本地按需解析代理（mpv 打开哪集才解析哪集，直链零过期）。
    // 集目解析失败 → toast 告知并停止队列（mpv 收 502 会跳下一集，这里主动 stop 防静默跳集）。
    /** 边下边播入队（原生队列与逐集链路共用语义）：成功/去重命中返回 true。 */
    async function enqueueSimulDownload({ url, siteKey, fileBase, episodeName, header }) {
        try {
            if (!settings.get('simulDownload')) return false;
            const urlPath = String(url).split('?')[0];
            const isM3u8 = /\.m3u8$/i.test(urlPath);
            const simulKey = buildEpisodeKey({ site: siteKey, vod: fileBase, episode: episodeName });
            const dup = simulKey ? await dlDedupe.check(simulKey) : null;
            let out = (fileBase.replace(/[\\/:*?"<>|]/g, '_').trim() || '视频').slice(0, 150);
            if (isM3u8) {
                out += '.mp4'; // m3u8 合成产物固定 mp4（ffmpeg 推断格式需要扩展名）
            } else {
                const ext = (urlPath.match(/\.(mp4|mkv|flv|mov|avi|webm|ts)$/i) || ['', ''])[1];
                out += ext ? '.' + ext : '';
            }
            if (dup) return true; // 已在下载/已下载：视为已处理
            if (isM3u8) {
                syncDlDir(dl.dir || settings.get('dlDir') || app.getPath('downloads'));
                const hlsGid = hls.add({
                    url, out, header,
                    concurrency: parseInt(settings.get('dlSplitConcurrency'), 10) || 5,
                });
                if (simulKey) {
                    dlDedupe.bind(hlsGid, simulKey, {
                        gid: hlsGid, kind: 'hls', name: out, files: [], size: 0, done: 0,
                        percent: 0, status: 'active', uri: url,
                        header: (header && typeof header === 'object') ? header : undefined,
                        completedAt: Date.now(),
                    });
                }
                startDlPoll();
                return true;
            }
            if (!dl.isAvailable()) return false;
            await raceWithTimeout(
                startDlEngine(dl.dir || settings.get('dlDir') || app.getPath('downloads')), 8000);
            const opts = { out };
            if (header && typeof header === 'object') {
                const pairs = Object.entries(header)
                    .filter(([, v]) => v != null && v !== '')
                    .map(([k, v]) => `${k}: ${v}`);
                if (pairs.length) opts.header = pairs;
            }
            const ariaGid = await raceWithTimeout(dl.addUri(url, opts), 8000);
            if (simulKey && ariaGid) {
                dlDedupe.bind(ariaGid, simulKey, {
                    gid: ariaGid, kind: 'aria2', name: out, files: [], size: 0, done: 0,
                    percent: 0, status: 'waiting', uri: url,
                    header: (opts.header && Array.isArray(opts.header))
                        ? Object.fromEntries(opts.header.map((h) => { const i = h.indexOf(': '); return [h.slice(0, i), h.slice(i + 2)]; }))
                        : undefined,
                    completedAt: Date.now(),
                });
            }
            startDlPoll();
            return true;
        } catch (e) { return false; }
    }

    // 原生队列 × 边下边播：代理每解析成功一集即静默入队下载（集名含 Bangumi 名，
    // 去重键与手动下载一致，重复播放不会重复建任务）。Kazumi 会话自动携带规则头。
    /** 原生队列单集解析成功 → 边下边播入队（静默，播放优先）。 */
    async function onQueueEntryResolved({ index, url, title, sess }) {
        try {
            if (!settings.get('simulDownload')) return;
            if (isDynamicProxyStream(url, {})) return;
            const epName = title || `第${index + 1}集`;
            await enqueueSimulDownload({
                url,
                siteKey: sess.site || '',
                fileBase: [sess.seriesTitle, epName].filter(Boolean).join(' · '),
                episodeName: epName,
                header: sess.headers || undefined,
            });
        } catch (e) { /* 静默：播放优先 */ }
    }

    const playlistProxy = new PlaylistProxy({
        getBackend: () => lastBackendInfo,
        // Kazumi 第二段解析：复用 VIP 解析的隐藏窗口抓流设施（规则头由代理管道转发）
        captureDirect: (pageUrl, legacy) => parseWin.captureDirect(
            pageUrl, undefined, !!legacy, new AbortController().signal, {}),
        onEntryError: ({ index, reason, sess }) => {
            send('yuki:play-failed', { message: `第 ${index + 1} 集：${reason}，原生连播已停止` });
            // 仅 parse=1（页面解析型）拉黑该线路；超时/抖动类失败不记，下次可重试
            if (sess && /需 VIP 解析/.test(String(reason))) {
                pageQueueBan.add(`${sess.site}|${sess.flag}`);
            }
            try { mpv.stop(); } catch (e) { /* ignore */ }
        },
    });
    playlistProxy.on('entry-resolved', onQueueEntryResolved);
    // 实例回填到模块级处理器（注册在最早期已完成，见文件头部）
    playlistProxyRef = playlistProxy;

    // 上/下集快捷键：原生队列直接在 mpv 播放列表内跳集（同进程零等待）；
    // 逐集会话转发渲染层推进（单集会话里 mpv 的 playlist-next 会直接退出进程）。
    mpv.on('ep-skip', ({ dir } = {}) => {
        try {
            const d = Number(dir) || 0;
            if (!d) return;
            const nativeActive = !!(mpv._activeSession && mpv._activeSession.nativeQueue
                && mpv._queueLen > 1);
            if (nativeActive) {
                mpv.command(d > 0 ? 'playlist-next' : 'playlist-prev').catch(() => { });
                return;
            }
            send('yuki:episode-skip', { dir: d });
        } catch (e) { /* ignore */ }
    });

    // 播放事件 → 渲染层（连播由渲染层在 mpv 退出后推进；附退出进度供「看完」判定）
    mpv.on('ended', (info) => send('yuki:player-ended', info));
    // 播放器 IPC 就绪：用实时设置推送右键菜单初始档位。hints.lua 里的静态快照可能
    // 已过期（典型：默认开启在启动着色器下载完成后才写入设置，而 lua 在启动时已按
    // 'off' 生成），不重推会导致「着色器实际生效、菜单却显示关闭」。推送必然早于
    // 菜单可用——右键菜单绑定同样在连接后才注入。
    mpv.on('ipc-connected', () => {
        mpv.command('set', 'user-data/yuki/a4k-mode', anime4kMenuModeFromSettings()).catch(() => { });
    });
    // 播放器右键菜单：Anime4K 全局档位切换。持久化设置 + 当次会话热应用
    // （glsl-shaders 运行时替换，无需重启 mpv）+ 回写 user-data/yuki/a4k-mode
    // 驱动菜单勾选态 + OSD 回显 + 通知渲染层同步设置页。
    // 状态一致性约定：持久层 / 菜单勾选态 / 设置页控件一律反映「已保存的配置意图」；
    // 着色器未就绪导致未注入时由 OSD 与 ready 字段明示，不得把展示态降级成 off
    // （否则持久层说开、菜单/UI 说关，重启后又自动开启，三方失步）。
    mpv.on('a4k-request', ({ mode } = {}) => {
        try {
            const tier = ANIME4K_CHAINS[mode] ? String(mode) : '';
            const on = !!tier;
            settings.set('anime4k', on);
            if (on) settings.set('anime4kMode', tier);
            // 着色器文件缺失/损坏时 buildAnime4kChain 返回 ''：清空运行链＝本次不注入，
            // 但配置仍按用户选择持久化并在所有界面上如实展示。
            const chain = on ? buildAnime4kChain(tier) : '';
            mpv.anime4kShaders = chain;
            mpv.command('no-osd', 'set', 'glsl-shaders', chain).catch(() => { });
            mpv.command('set', 'user-data/yuki/a4k-mode', on ? tier : 'off').catch(() => { });
            const label = (on && chain)
                ? (ANIME4K_MODE_LABELS[tier] || tier)
                : (on ? '未生效（着色器未就绪，请在设置中下载）' : '关闭');
            mpv.command('show-text', `Anime4K 超分：${label}`, 2500).catch(() => { });
            if (win) {
                win.webContents.send('yuki:a4k-changed', {
                    enabled: on, mode: on ? tier : 'off',
                    label: on ? (ANIME4K_MODE_LABELS[tier] || '') : '',
                    ready: !!chain,
                });
            }
        } catch (e) { /* 菜单切换失败不影响播放 */ }
    });
    // mpv 进程异步启动失败（ENOENT/EACCES：文件被删/损坏/无权限）：友好告知渲染层，不崩溃、不静默
    mpv.on('spawn-error', (info) => {
        send('yuki:player-spawn-error', {
            code: (info && info.code) || 'unknown',
            reason: 'mpv-missing',
        });
    });
    mpv.on('exit', (info) => {
        const userStopped = !!(info && info.userStopped);
        send('yuki:player-exit', {
            pos: (info && typeof info.pos === 'number') ? info.pos : null,
            duration: (info && typeof info.duration === 'number') ? info.duration : null,
            sessionId: (info && typeof info.sessionId === 'number') ? info.sessionId : 0,
            fullscreen: (info && typeof info.fullscreen === 'boolean') ? info.fullscreen : null,
            speed: (info && typeof info.speed === 'number') ? info.speed : null,
            wallWatched: (info && typeof info.wallWatched === 'number') ? info.wallWatched : null,
            requestId: (info && info.requestId) || '',
            playSessionId: (info && info.playSessionId) || '',
            // 原生多集队列：渲染层据此在退出时不再按整会话计账/推进（逐集已在 ended 记账），
            // 并补记「正在看的这一集」（playlistPos 定位当集，与已 eof 记账的下标去重）
            nativeQueue: !!(info && info.nativeQueue),
            queueLen: (info && typeof info.queueLen === 'number') ? info.queueLen : null,
            playlistPos: (info && typeof info.playlistPos === 'number') ? info.playlistPos : -1,
            quit: userStopped, // 用户主动关闭（stop() 或 mpv 窗口关闭）：渲染层据此不等待断流重连、不连播
        });
        // 用户主动关闭播放器：绝不自动重连（否则关窗会被误判为断流而重播）
        if (userStopped) return;
        // 断流恢复由渲染层重新调用 playerContent（refresh=1）后再进入本入口，
        // 这样短期 CDN URL 会被重新评估；主进程不得直接复用旧地址。
    });

    /** 自动重载收尾：清状态并通知渲染层（ok=是否成功载入站点）。 */
    function finishReload(ok, sites) {
        configReload.reloading = false;
        send('yuki:config-reloaded', { url: configReload.url, ok: !!ok, sites: sites || 0 });
    }

    bridge.on('ready', (info) => {
        lastBackendInfo = info; // 播放列表代理按需解析用（惰性读取，后端重启后自动更新）
        if (win) win.webContents.send('backend-ready', info);
        // Phase 7：自动重载上次成功加载的配置 URL（状态同步置位，供 yuki:config-state 轮询）
        const lastUrl = settings.get('lastConfigUrl');
        if (lastUrl && /^https?:\/\//i.test(lastUrl)) {
            (async () => {
                // READY 行早于端口监听：先轮询 health 确认后端可达（最长 20s）。
                for (let i = 0; i < 40; i++) {
                    try {
                        const h = await fetch(`${info.base}/health`, { signal: AbortSignal.timeout(2000) });
                        if (h.ok) break;
                    } catch (e) { /* 未就绪，重试 */ }
                    await new Promise((r) => setTimeout(r, 500));
                }
                // 后端的磁盘缓存恢复已改为后台线程（READY 不再等待它）：这里先等
                // 启动恢复结束再做决策，避免与网络重载并发重复构建全部站点。
                // 恢复完成（loading→done 且 healthy>0）按一次成功重载收尾，渲染层
                // 经 yuki:config-reloaded 刷新站点。t=null（端点暂不可达）时继续轮询
                // 而非放弃——READY 刚打印时 uvicorn 可能尚未完成绑定。
                const taskUrl = `${info.base}/action?token=${info.token}`;
                let sawLoading = false;
                for (let i = 0; i < 60; i++) {
                    const t = await fetch(taskUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: 'do=configTask',
                    }).then((x) => x.json()).catch(() => null);
                    if (t && t.status !== 'loading') {
                        if (sawLoading && t.status === 'done' && t.summary
                            && Number(t.summary.healthy ?? t.summary.sites) > 0) {
                            finishReload(true, Number(t.summary.healthy ?? t.summary.sites));
                        }
                        break;
                    }
                    if (t) sawLoading = true;
                    await new Promise((r) => setTimeout(r, 2000));
                }
                // 启动恢复已出结果：已有健康缓存时不再重复下载仓库。
                try {
                    const state = await fetch(`${info.base}/sites?token=${info.token}`, {
                        signal: AbortSignal.timeout(5000),
                    }).then((rsp) => rsp.ok ? rsp.json() : null);
                    const healthy = Number(state && state.summary && state.summary.healthy || 0);
                    if (state && state.cached === true && healthy > 0) {
                        console.log('[config] restored from disk cache; skip auto reload');
                        return;
                    }
                } catch (e) { /* 状态接口尚未就绪，继续走原有加载流程 */ }
                configReload.reloading = true;
                configReload.url = lastUrl;
                console.log('[config] auto reload start:', lastUrl);
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
                            if (t.status === 'done' && t.summary && Number(t.summary.healthy ?? t.summary.sites) > 0) {
                                finishReload(true, Number(t.summary.healthy ?? t.summary.sites));
                            } else {
                                console.warn('[config] auto reload failed:', (t && t.msg) || '0 sites');
                                finishReload(false);
                            }
                            return;
                        }
                        console.warn('[config] auto reload timeout');
                        finishReload(false);
                    } else if (body && body.code === 200 && body.summary) {
                        finishReload(true, Number(body.summary.healthy ?? body.summary.sites));
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
    if (cacheDir) bridge.extraEnv.YUKI_CACHE_DIR = cacheDir;
    bridge.extraEnv.YUKI_LOG_DIR = LOG_DIR;
    bridge.extraEnv.YUKI_PAN_FAST_PATH = settings.get('panFastPath') === false ? '0' : '1';
    bridge.extraEnv.YUKI_MEDIA_PROBE = settings.get('mediaProbe') === false ? '0' : '1';
    bridge.extraEnv.YUKI_AUTO_LINE_FALLBACK = settings.get('autoLineFallback') === false ? '0' : '1';
    bridge.extraEnv.YUKI_LEGACY_PARSER = settings.get('legacyParser') === false ? '0' : '1';
    // 低配机型自适应：按整机内存 / 核数收紧后端运行时 Worker 上限。冻结产物里每个
    // spawn Worker 就是一个独立的 yuki-backend.exe 子进程（jar 站点还会再派生 JVM），
    // 后端默认总上限 8、其中 jar 3；小内存机器全量拉起会内存暴涨。分档：
    //   低配（<8GB 或 ≤2 核）→ 总 4 / jar 1；中配（<14GB）→ 总 6 / jar 2；
    //   其余保持默认 8 / 3。用户显式设置的同名环境变量优先（高级用户自行调优）。
    (function applyAdaptiveWorkerLimits() {
        const totalGiB = os.totalmem() / (1024 ** 3);
        const cores = os.cpus().length;
        const low = totalGiB < 8 || cores <= 2;
        const mid = !low && totalGiB < 14;
        if (!process.env.YUKI_MAX_WORKERS) bridge.extraEnv.YUKI_MAX_WORKERS = String(low ? 4 : mid ? 6 : 8);
        if (!process.env.YUKI_MAX_JAR_WORKERS) bridge.extraEnv.YUKI_MAX_JAR_WORKERS = String(low ? 1 : mid ? 2 : 3);
        console.log(`[python-bridge] adaptive worker limits: total=${low ? 4 : mid ? 6 : 8} jar=${low ? 1 : mid ? 2 : 3} (ram=${totalGiB.toFixed(1)}GiB cores=${cores})`);
    })();
    const lastConfigUrl = settings.get('lastConfigUrl');
    if (lastConfigUrl && /^https?:\/\//i.test(lastConfigUrl)) {
        bridge.extraEnv.YUKI_LAST_CONFIG_URL = lastConfigUrl;
    }
    // 日志级别 + 定时清空日志：启动时按持久化设置生效（可在设置页调整）
    setLogLevel(settings.get('logLevel'));
    // Python 后端按启动环境变量决定自身日志级别（server.py _setup_logging 读取）
    bridge.extraEnv.YUKI_LOG_LEVEL = require('./logger').getLogLevel();
    (function applyScheduledLogCleanup() {
        const enabled = settings.get('logAutoCleanup') === true;
        const days = parseInt(settings.get('logCleanupDays'), 10) || 0;
        // 每 N 天清空一次：N<=0 或开关关闭则不启动；
        // 上次清理时间持久化到 settings，跨重启仍按完整周期判断（逾期启动即补清）
        startScheduledLogCleanup(LOG_DIR, days > 0 ? days * 24 * 60 * 60 * 1000 : 0, enabled, {
            getLastCleanup: () => settings.get('logLastCleanupAt'),
            markCleaned: (ts) => settings.set('logLastCleanupAt', ts),
        });
    })();
    // 弹幕（弹弹 play）凭据：设置里保存的 AppId/AppSecret 注入后端环境，供 danmaku_* 签名使用
    const ddAppId = settings.get('dandanAppId');
    const ddSecret = settings.get('dandanAppSecret');
    if (ddAppId) bridge.extraEnv.DANDANAPI_APPID = String(ddAppId);
    if (ddSecret) bridge.extraEnv.DANDANAPI_KEY = String(ddSecret);
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
    // 视频缓冲缓存：只走内存（见 mpv-player._cacheArgs），无需注入偏好；
    // 历史 disk 模式的残留键与缓存文件在此一次性清理。
    migratePlayerCache();
    // 代理（2.9）：启动时按设置写入环境变量，供 Python 后端 requests 继承（重启后端即生效）
    // 手动代理优先（校验通过才注入）；同时把 settings 源注册给 system-proxy，让下载器/预览等
    // 在 getProxyUrl() 时能读到手动代理（此前只读系统代理，导致手动代理对 aria2 不生效）
    setManualProxySource(() => settings);
    invalidateCache();
    const proxyUrl = settings.get('proxyUrl') || '';
    if (settings.get('proxyEnable')) {
        const normalized = formatAndValidateProxyUrl(proxyUrl);
        if (normalized) {
            process.env.HTTP_PROXY = normalized;
            process.env.HTTPS_PROXY = normalized;
            delete process.env.NO_PROXY;
            delete process.env.no_proxy;
        }
    } else {
        // 开关关闭：注入 NO_PROXY 使后端 requests 强制直连（不被系统代理接管），与 yuki:set-proxy 关闭分支一致
        process.env.NO_PROXY = '*';
        process.env.no_proxy = '*';
    }
    // ffmpeg 内置：启动后台自动补齐（m3u8 下载合成与本地预览图依赖；缺失时静默降级）
    ensureFfmpeg().catch(() => { });
    // 内置 MiSans 字体就绪探测（打包内置，无运行时下载；渲染层经 yuki:font-css 注入，T61）
    misans.ensureMisans().catch(() => { });
    // Anime4K 超分：启动自动补齐着色器（内置免手动下载）；用户从未设置过开关则默认开启，
    // 已手动关闭过（值 false）保持关闭；文件不全时链为空静默降级
    ensureAnime4k().catch(() => { }).finally(() => {
        if (settings.get('anime4k') === undefined && buildAnime4kChain()) settings.set('anime4k', true);
        // 用 anime4kChainFromSettings 带上档位（buildAnime4kChain 无参回退 Mode A，
        // 会忽略用户设置的 anime4kMode）
        if (settings.get('anime4k')) {
            mpv.anime4kShaders = anime4kChainFromSettings();
            // 默认开启此刻才落地，早前生成的 hints.lua 仍是 'off' 快照——重写资产，
            // 使 OSD 提示与菜单初始态同步为最新设置（运行会话另有 ipc-connected 兜底推送）。
            writeMpvAssets();
        }
    });
    bridge.start();
    parseWin = new ParseWindow(() => bridge.info, probeMedia);
    pushServer.on('push', ({ url }) => playPushedUrl(url, '局域网'));
    pushServer.start();
    createWindow();
    setupAutoUpdater(() => win);
    initTray();

    // SyncPlay 事件转发到渲染层
    syncplay.on('state', (info) => send('yuki:syncplay-state', info));
    syncplay.on('chat', (info) => send('yuki:syncplay-chat', info));
    syncplay.on('file', (info) => send('yuki:syncplay-file', info));
    syncplay.on('users', (info) => send('yuki:syncplay-users', info));
    syncplay.on('disconnect', () => send('yuki:syncplay-disconnect', {}));
    syncplay.on('error', (err) => send('yuki:syncplay-error', { message: String(err.message || err) }));

    // DLNA 事件转发
    dlna.on('devices', (devices) => send('yuki:dlna-devices', devices));
    dlna.on('error', (err) => send('yuki:dlna-error', { message: String(err.message || err) }));

    // SyncPlay IPC
    ipcMain.handle('yuki:syncplay-connect', async (_e, opts) => {
        try {
            await syncplay.connect(opts.server, opts.port, opts.username, opts.room, opts.useTls !== false);
            return { ok: true };
        } catch (e) { return { ok: false, reason: e.message }; }
    });
    ipcMain.handle('yuki:syncplay-disconnect', () => { syncplay.disconnect(); return { ok: true }; });
    ipcMain.handle('yuki:syncplay-state', (_e, pos, paused, seek) => { syncplay.sendState(pos, paused, seek); return { ok: true }; });
    ipcMain.handle('yuki:syncplay-file', (_e, name, duration) => { syncplay.sendFile(name, duration); return { ok: true }; });
    ipcMain.handle('yuki:syncplay-chat', (_e, msg) => { syncplay.sendChat(msg); return { ok: true }; });

    // DLNA IPC
    ipcMain.handle('yuki:dlna-search', async () => {
        try { await dlna.search(); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
    });
    ipcMain.handle('yuki:dlna-cast', async (_e, deviceUrl, mediaUrl, title) => {
        try { await dlna.cast(deviceUrl, mediaUrl, title); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
    });
    ipcMain.handle('yuki:dlna-stop', async (_e, deviceUrl) => {
        try { await dlna.stop(deviceUrl); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
    });

    // ---- 外部播放器 ----

    /** 是否本机「原生播放列表」代理地址（pipe 管道会话条目 /pl/<token>/<n> 及其
     *  清单重写产物 /seg/...）。这类 URL 交外部播放器时必须省略鉴权开关：
     *  1) 管道模式数据面由代理带会话头转发上游，入站请求无需任何鉴权；
     *  2) PotPlayer 对无扩展名 URL 走「未知内容」路径，会把命令行开关原样并入
     *     HTTP 请求行（GET /pl/x/0 /user_agent=... HTTP/1.0，2026-08-25 抓包实锤），
     *     Node 解析器报 HPE_INVALID_CONSTANT 直接拒收 → PotPlayer 报「打不开」。 */
    function isPlaylistProxyUrl(u) {
        try {
            const url = new URL(String(u || ''));
            if (!/^https?:$/i.test(url.protocol)) return false;
            if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) return false;
            return /^\/(?:pl|seg)\/[A-Za-z0-9_-]{8,64}(?:\/|$)/.test(url.pathname);
        } catch (e) { return false; }
    }

    /** 按可执行文件名识别播放器类型（决定命令行传参格式：header/标题各家语法不同）。 */
    function externalPlayerKind(execPath) {
        const base = String(execPath || '').toLowerCase().replace(/\\/g, '/').split('/').pop();
        if (/vlc/.test(base)) return 'vlc';
        if (/potplayer/.test(base)) return 'potplayer';
        if (/\bmpv/.test(base)) return 'mpv';
        return 'other';
    }

    const EXT_HEADER_KEYS = ['user-agent', 'referer', 'origin', 'cookie', 'authorization'];
    function hasAuthHeader(header) {
        return !!(header && Object.keys(header).some((key) => EXT_HEADER_KEYS.includes(String(key).toLowerCase())));
    }

    /**
     * 外部播放器启动层（2026-08-25 重写）。
     *
     * 设计原则：**PotPlayer 的命令行鉴权开关与裸 URL 处理均不可靠**——
     *  - /referer= /user_agent= 开关时灵时不灵，失败时开关被并入 HTTP 请求行
     *    （GET url /user_agent=... HTTP/1.0）致上游收到畸形请求；
     *  - 无扩展名 URL 被当 ICY 音频流/顺序流：只出声音、不能 seek、时长随缓冲增长；
     *  - 多次 spawn 无收敛语义（detached 句柄不可 stop），渲染层竞态双发即双窗口。
     *
     * 因此统一为「本地 m3u8 播放列表文件」单一入口：
     *  1. 所有带鉴权头的 http(s) 媒体一律经 playlist-proxy 静态管道转发
     *     （kind='static'，会话头由代理注入上游），播放器只见 127.0.0.1 干净地址；
     *  2. 条目 URL 携带内容一致的扩展名提示，引导正确解码路径与时长计算；
     *  3. 整季写入 .m3u8 播放列表文件交给 PotPlayer——原生列表可切集连播，
     *     单一文件入口天然杜绝多窗口；单条目直接 spawn URL 不落盘；
     *  4. 同播放意图短窗内二次启动：kill 旧进程再起新的（对齐内置 mpv 收敛语义），
     *     渲染层竞态双发也只剩一个存活窗口。
     * VLC/mpv 的 header 开关语法可靠且各自支持 #EXTVLCOPT/--http-header-fields，
     * 维持命令行直传，不走管道。
     */

    /** 外部播放列表临时目录（userData 下，写入前清理 1 小时前的残留）。 */
    function extPlaylistDir() {
        const dir = path.join(app.getPath('userData'), 'ext-playlists');
        try {
            fs.mkdirSync(dir, { recursive: true });
            for (const f of fs.readdirSync(dir)) {
                const p = path.join(dir, f);
                try { if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { force: true }); } catch (e) { /* 单文件失败忽略 */ }
            }
        } catch (e) { /* 目录失败由 writeFileSync 抛出 */ }
        return dir;
    }

    /** 从直链 URL 提取已知的媒体扩展名（无法识别返回 ''）。 */
    function knownMediaExt(url) {
        try {
            const ext = path.extname(new URL(String(url)).pathname).toLowerCase();
            return /^\.(m3u8?|mp4|m4v|mkv|flv|ts|webm|mov|avi)$/.test(ext) ? ext : '';
        } catch (e) { return ''; }
    }

    /** 容器魔数 → 扩展名提示（对齐 media-probe.hasMediaMagic 的判定面）。 */
    function extFromMagic(buf) {
        if (!buf || !buf.length) return '';
        const head4 = buf.subarray(0, 4).toString('ascii');
        if (head4 === 'FLV\x01') return '.flv';
        if (head4.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return '.mkv';
        if (buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return '.mp4';
        if (['OggS'].includes(head4)) return '.webm';
        if (head4 === 'RIFF') return '.avi';
        const text = buf.toString('utf8', 0, Math.min(buf.length, 64)).replace(/^\uFEFF/, '').trimStart();
        if (text.startsWith('#EXTM3U')) return '.m3u8';
        return '';
    }

    /**
     * 扩展名提示嗅探（决定代理地址的伪扩展名，直接影响 PotPlayer 解码路径）：
     * 1. URL 自带已知扩展名 → 直接用；
     * 2. Range 取首块字节做容器魔数判定（100% 反映真实内容——CDN 的
     *    Content-Type 常是 application/octet-stream、page 源直链常无扩展名，
     *    盲猜 .m3u8 会把 mp4 内容误导进 HLS 路径致「只有音轨」黑屏，实测）；
     * 3. 均失败回退 '.m3u8'（带鉴权在线源绝大多数为 HLS）。
     */
    async function sniffMediaExt(url, header) {
        const known = knownMediaExt(url);
        if (known) return known;
        try {
            const u = new URL(url);
            const mod = u.protocol === 'https:' ? require('https') : require('http');
            const reqHeaders = { Range: 'bytes=0-63', ...(header || {}) };
            if (!reqHeaders['User-Agent']) reqHeaders['User-Agent'] = 'Mozilla/5.0';
            const magic = await new Promise((resolve) => {
                let settled = false;
                const done = (v) => { if (!settled) { settled = true; try { rq.destroy(); } catch (e) {} resolve(v); } };
                const rq = mod.request({
                    hostname: u.hostname,
                    port: u.port || (u.protocol === 'https:' ? 443 : 80),
                    path: u.pathname + u.search, method: 'GET', headers: reqHeaders, timeout: 6000,
                }, (rs) => {
                    // 3xx：直链即重定向页（少见），交给默认值；4xx/5xx 同理
                    if (rs.statusCode >= 300 || rs.statusCode < 200) { rs.resume(); return done(''); }
                    const chunks = [];
                    rs.on('data', (c) => { chunks.push(c); if (chunks.reduce((n, x) => n + x.length, 0) >= 64) rs.destroy(); });
                    rs.on('end', () => done(Buffer.concat(chunks)));
                    rs.on('close', () => done(Buffer.concat(chunks)));
                    rs.on('error', () => done(Buffer.concat(chunks)));
                });
                rq.on('timeout', () => done(''));
                rq.on('error', () => done(''));
                rq.end();
            });
            const byMagic = extFromMagic(magic);
            if (byMagic) return byMagic;
        } catch (e) { /* 嗅探失败走默认 */ }
        return '.m3u8';
    }

    /** 把带鉴权头的真实直链包成 static 管道代理地址。失败时返回原 URL（退回旧行为）。 */
    async function pipeWrapAuthUrl(url, header, title) {
        if (!playlistProxyRef || !/^https?:\/\//i.test(url)) return url;
        if (isPlaylistProxyUrl(url)) return url;
        if (!hasAuthHeader(header)) return url;
        try {
            const hint = await sniffMediaExt(url, header);
            const reg = await playlistProxyRef.register({
                kind: 'static', title: String(title || ''), site: '', flag: '',
                eps: [{ id: url, name: String(title || ''), hint }],
                start: 0, pipe: true, headers: { ...header },
            });
            if (reg && reg.ok && Array.isArray(reg.entries) && reg.entries.length === 1) {
                console.log(`[外部播放器] 带鉴权直链包静态管道(${hint})：${url.slice(0, 80)}`);
                return reg.entries[0].url;
            }
        } catch (e) { /* 注册失败退回直传 */ }
        return url;
    }

    /**
     * 归一化并解析外部播放条目通道。
     * items: [{ url, title, header }] → [{ url(最终地址), title }]，顺序保持。
     */
    async function resolveExternalItems(items) {
        const out = [];
        for (const it of items) {
            let url = String(it.url || '');
            const header = (it.header && typeof it.header === 'object') ? it.header : null;
            if (/^https?:\/\//i.test(url)) {
                // 管道地址已是最终形态；带鉴权头直链包静态管道；无鉴权头直连 CDN
                url = await pipeWrapAuthUrl(url, header, it.title);
            }
            out.push({ url, title: String(it.title || '') });
        }
        return out;
    }

    /**
     * 写临时 m3u 播放列表文件（外部播放器启动的**唯一**条目载体）。
     * EXTINF 携带集名（UTF-8 文件内容，不经过 HTTP → 无请求行编码问题）；
     * 条目 URL 纯 ASCII（代理地址序号+扩展名）。PotPlayer 原生列表按 EXTINF
     * 显示集名、F8 可见可切集连播。扩展名用 .m3u（纯播放列表语义）。
     */
    function writeExtPlaylistFile(items) {
        const lines = ['#EXTM3U'];
        for (const it of items) {
            const name = String(it.title || '').replace(/[\r\n\t]/g, ' ').trim() || '未命名';
            lines.push(`#EXTINF:-1,${name}`, it.url);
        }
        const dir = extPlaylistDir();
        const file = path.join(dir, `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.m3u`);
        fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
        return file;
    }

    /** kill 上一次外部播放器进程（收敛语义：同意图重播只保留最新窗口）。 */
    function killPrevExtPlayer(pid) {
        if (!pid || process.platform !== 'win32') return;
        try {
            const { execSync } = require('child_process');
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
        } catch (e) { /* 已退出则忽略 */ }
    }

    /** 外部启动串行链：所有 launchExternalPlayerItems 调用在此队列上严格依次执行。
     *  并发双发（渲染层竞态/切线路回退）的两次启动各自含 await（static 注册等），
     *  「spawn 前 kill」在并发交错下仍有逃逸窗口——串行化后 kill→spawn 原子有序，
     *  任何时刻至多一个存活窗口，最后到达的启动胜出。 */
    let extLaunchChain = Promise.resolve();

    /**
     * 用指定外部播放器起播一批条目（重写后的统一入口）。
     * items: [{ url, title, header }]；
     * 返回 { ok, via, kind, launchedPid } 或 { ok:false, reason }。
     * **统一走临时 .m3u 文件单参数启动**（含单条目）：集名经 EXTINF 显示、
     * 条目 URL 纯 ASCII——命令行多 content 与 /switch 开关两条路都已被实测证伪
     * （开关被当 content 假末集/双窗；中文集名内嵌 URL 未经编码进请求行致
     * HPE_INVALID_URL 双窗），文件是唯一显示与合法性兼得的通道。
     */
    function launchExternalPlayerItems(execPath, items) {
        const p = extLaunchChain.then(async () => {
            const kind = externalPlayerKind(execPath);
            const resolved = await resolveExternalItems(items);
            if (!resolved.length || resolved.some((it) => !it.url)) return { ok: false, reason: 'bad item' };
            try {
                const { spawn } = require('child_process');
                // 此刻位于串行链头部：kill 上一个 pid 后立刻 spawn，中间无 await，
                // 与任何并发交错都不可能产生第二个存活窗口。
                if (lastExtLaunchPid) {
                    console.log(`[外部播放器] 收敛：kill 旧进程 pid=${lastExtLaunchPid}`);
                    killPrevExtPlayer(lastExtLaunchPid);
                }
                const file = writeExtPlaylistFile(resolved);
                console.log(`[外部播放器] spawn ${kind} pid目标 m3u=${path.basename(file)} 条目=${resolved.length} 首=${String(resolved[0].url).slice(0, 70)}`);
                const child = spawn(execPath, [file], { detached: true, stdio: 'ignore', windowsHide: true });
                child.unref();
                lastExtLaunchPid = child.pid;
                console.log(`[外部播放器] 已启动 pid=${child.pid}`);
                return { ok: true, via: execPath, kind, launchedPid: child.pid };
            } catch (e) { return { ok: false, reason: e.message }; }
        });
        extLaunchChain = p.then(() => {}, () => {});
        return p;
    }

    /** （兼容保留）单 URL 直启：VLC/mpv 弹窗按钮等仍走开关直传路径。
     *  同样接入 pid 收敛——dl-play/file-push/外部播放器按钮等所有 spawn 路径
     *  必须共享同一收敛点，否则任一路径漏网即双窗口（实测）。 */
    function launchExternalPlayer(execPath, url, header, label) {
        const kind = externalPlayerKind(execPath);
        const { args } = buildExternalPlayerArgs(kind, url, header || {}, label);
        try {
            const { spawn } = require('child_process');
            if (lastExtLaunchPid) killPrevExtPlayer(lastExtLaunchPid);
            const child = spawn(execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
            child.unref();
            lastExtLaunchPid = child.pid;
            return { ok: true, via: execPath, kind };
        } catch (e) { return { ok: false, reason: e.message }; }
    }

    /** 按播放器类型拼 spawn 参数（仅剩 VLC/mpv 使用命令行 header 开关；
     *  PotPlayer 一律走静态管道，不再生成任何开关参数）。 */
    function buildExternalPlayerArgs(kind, url, header, label) {
        const referer = header && (header.Referer || header.referer);
        const ua = header && (header['User-Agent'] || header.ua);
        if (kind === 'vlc') {
            const args = [url];
            const pairs = [];
            if (referer) pairs.push(`Referer: ${referer}`);
            if (ua) pairs.push(`User-Agent: ${ua}`);
            if (pairs.length) args.push(`--http-header-fields=${pairs.join(',')}`);
            args.push('--no-video-title-show');
            return { args, headerSupported: true };
        }
        if (kind === 'mpv') {
            const args = [url];
            const pairs = [];
            if (referer) pairs.push(`Referer: ${referer}`);
            if (ua) pairs.push(`User-Agent: ${ua}`);
            if (pairs.length) args.push(`--http-header-fields=${pairs.join(', ')}`);
            // 标题：Kazumi 抓流产物是本地临时文件（kazumi_stream_*.m3u8），
            // 不传标题时 mpv 窗口/播放列表会显示该文件名——强制覆盖为集名
            if (label) {
                const t = String(label).replace(/["$]/g, '');
                args.push(`--title=yuki · ${t}`, `--force-media-title=yuki · ${t}`);
            }
            return { args, headerSupported: true };
        }
        // PotPlayer/其他：命令行开关实测不可靠（见区块头注释），仅传 URL。
        // 带鉴权头的场景已在 launchExternalPlayerItems 里管道化。
        return { args: [url], headerSupported: false };
    }

    /** 已指定的外部播放器路径（未指定则尝试自动探测 PATH 中的 VLC）。返回 '' 表示无可用外部播放器。 */
    function resolveExternalPlayerPath() {
        let extPlayer = settings.get('externalPlayerPath') || '';
        if (extPlayer) return extPlayer;
        try {
            const { execSync } = require('child_process');
            if (process.platform === 'win32') {
                const out = execSync('where vlc', { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
                extPlayer = out.split(/\r?\n/)[0] || '';
            } else {
                const out = execSync('which vlc', { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
                extPlayer = out || '';
            }
        } catch (e) { /* PATH 中无 VLC */ }
        return extPlayer;
    }

    /** 用指定外部播放器起播：拼对应 header 参数后 spawn。返回 { ok, via, kind, headerDropped } 或 { ok:false, reason }。 */
    function launchExternalPlayer(execPath, url, header, label) {
        const kind = externalPlayerKind(execPath);
        const hasHeader = !!(header && Object.keys(header).some((key) =>
            ['user-agent', 'referer', 'origin', 'cookie', 'authorization'].includes(String(key).toLowerCase())));
        const { args, headerSupported } = buildExternalPlayerArgs(kind, url, header || {}, label);
        try {
            const { spawn } = require('child_process');
            // 非 verbatim：libuv 自动为含空格的 exe 路径与参数加引号——
            // PotPlayer/VLC/mpv 的命令行解析均兼容该形态（2026-08-25 实测）。
            spawn(execPath, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
            return { ok: true, via: execPath, kind, headerDropped: hasHeader && !headerSupported };
        } catch (e) { return { ok: false, reason: e.message }; }
    }

    /** 当前是否以外部播放器为主播放器（已指定且不是 mpv —— mpv 走内置引擎，功能更全）。
     *  返回外部播放器路径，或 '' 表示走内置 mpv。 */
    function primaryExternalPlayer() {
        const p = settings.get('externalPlayerPath') || '';
        if (!p) return '';
        return externalPlayerKind(p) === 'mpv' ? '' : p;
    }

    ipcMain.handle('yuki:external-player', async (_e, url, opts) => {
        const u = String(url || '').trim();
        if (!/^(https?|rtmp|rtsp):\/\//i.test(u)) return { ok: false, reason: 'bad url' };
        const header = (opts && opts.header) || {};
        const hasHeader = !!Object.keys(header).some((key) =>
            ['user-agent', 'referer', 'origin', 'cookie', 'authorization'].includes(String(key).toLowerCase()));
        const extPlayer = resolveExternalPlayerPath();
        if (!extPlayer) {
            // 未指定外部播放器：带鉴权头的直链交系统默认程序会丢 header 大概率 403，明确告知
            if (hasHeader) return { ok: false, reason: 'need-header-player' };
            try {
                await shell.openExternal(u);
                return { ok: true, via: 'system-default' };
            } catch (e) { return { ok: false, reason: 'no-external-player' }; }
        }
        return launchExternalPlayer(extPlayer, u, header);
    });

    // ---- 统一播放器指定（内置 mpv vs 外部播放器合并入口）----

    /** 统一「指定播放器」：选中 mpv → 作为内置引擎（全功能：弹幕/连播/统计）；
     *  选中 VLC/PotPlayer/其他 → 作为主播放器（所有起播直接交它，无弹幕/连播/统计）。 */
    ipcMain.handle('yuki:pick-player', async () => {
        const r = await dialog.showOpenDialog(win, {
            title: '选择播放器（mpv 全功能；VLC/PotPlayer 等仅外部播放）',
            filters: [
                { name: '可执行文件', extensions: process.platform === 'win32' ? ['exe'] : ['app', ''] },
                { name: '全部文件', extensions: ['*'] },
            ],
            properties: ['openFile'],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'cancelled' };
        const p = r.filePaths[0];
        const kind = externalPlayerKind(p);
        if (kind === 'mpv') {
            // mpv：校验可用后作为内置引擎；清除外部播放器指定
            if (!mpv.setCustomPath(p)) return { ok: false, reason: '所选文件不是有效的 mpv 可执行文件' };
            settings.set('mpvPath', p);
            settings.set('externalPlayerPath', '');
            return { ok: true, path: p, kind, mode: 'internal-mpv' };
        }
        // 外部播放器作为主播放器：记录路径；不动 mpvPath（内置自动发现仍可作为兜底）
        settings.set('externalPlayerPath', p);
        return { ok: true, path: p, kind, mode: 'external' };
    });

    /** 当前播放器配置：外部为主则 mode='external'，否则内置 mpv。 */
    ipcMain.handle('yuki:player-config', () => {
        const ext = settings.get('externalPlayerPath') || '';
        if (ext && externalPlayerKind(ext) !== 'mpv') {
            return { mode: 'external', path: ext, kind: externalPlayerKind(ext) };
        }
        return {
            mode: 'internal-mpv',
            path: settings.get('mpvPath') || '',
            available: mpv.isAvailable(),
        };
    });

    /** 恢复默认播放器：清除内置 mpv 自定义路径与外部播放器指定，mpv 回到自动发现。 */
    ipcMain.handle('yuki:clear-player', () => {
        settings.set('mpvPath', '');
        settings.set('externalPlayerPath', '');
        mpv.resetBinary();
        return { ok: true, available: mpv.isAvailable() };
    });

    // ---- 定时关机 ----
    let shutdownTimer = null;
    ipcMain.handle('yuki:shutdown-timer', (_e, minutes) => {
        if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
        if (!minutes || minutes <= 0) return { ok: true, msg: '已取消定时关机' };
        shutdownTimer = setTimeout(() => {
            // 播放停止后关机：先停 mpv 再关机
            mpv.stop();
            setTimeout(() => {
                const { exec } = require('child_process');
                if (process.platform === 'win32') {
                    exec('shutdown /s /t 60 /c "YuKi 定时关机"', { windowsHide: true });
                } else if (process.platform === 'darwin') {
                    exec('osascript -e \'tell app "System Events" to shut down\'', { windowsHide: true });
                } else {
                    exec('shutdown -h +1', { windowsHide: true });
                }
            }, 2000);
        }, minutes * 60 * 1000);
        return { ok: true, msg: `已设定 ${minutes} 分钟后关机` };
    });

    // ---- 日志查看器 ----
    ipcMain.handle('yuki:get-logs', async (_e, page, pageSize, source) => {
        return readRecentLogs(LOG_DIR, page, pageSize, source);
    });
    // 清空日志（当前进程日志句柄继续写新文件）
    ipcMain.handle('yuki:clear-logs', async () => clearLogs(LOG_DIR));
    // 日志级别 + 定时清空日志：设置页变更后实时生效
    ipcMain.handle('yuki:set-log-level', (_e, level) => {
        setLogLevel(level);
        settings.set('logLevel', String(level || 'INFO').toUpperCase());
        // 同步到后端环境变量：后端下次（重）启动时按当前级别写 python-backend.log
        bridge.extraEnv.YUKI_LOG_LEVEL = require('./logger').getLogLevel();
        return { ok: true, level: require('./logger').getLogLevel() };
    });
    ipcMain.handle('yuki:set-log-cleanup', (_e, opts) => {
        const enabled = !!(opts && opts.enabled);
        const days = Math.max(0, parseInt(opts && opts.days, 10) || 0);
        settings.set('logAutoCleanup', enabled);
        settings.set('logCleanupDays', days);
        // days<=0 或关闭开关时 startScheduledLogCleanup 内部会停掉旧计时器并不启动；
        // 周期跨重启生效：上次清理时间持久化在 settings.logLastCleanupAt
        startScheduledLogCleanup(LOG_DIR, days > 0 ? days * 24 * 60 * 60 * 1000 : 0, enabled, {
            getLastCleanup: () => settings.get('logLastCleanupAt'),
            markCleaned: (ts) => settings.set('logLastCleanupAt', ts),
        });
        return { ok: true, enabled, days };
    });
    // 渲染端错误上报：window.onerror / unhandledrejection 转发进 electron-main.log（redactSecrets 由 writer 负责）
    ipcMain.handle('yuki:log-renderer', (_e, level, message) => {
        // 按真实级别映射 console 方法，级别过滤由 writer.write 统一执行
        const lvl = String(level || 'ERROR').toUpperCase();
        const method = lvl === 'DEBUG' ? 'debug' : lvl === 'INFO' ? 'info' : lvl === 'WARN' ? 'warn' : 'error';
        console[method](`[renderer] ${message}`);
        return { ok: true };
    });

    // ---- 首次引导状态 ----
    ipcMain.handle('yuki:onboarding-done', () => {
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

/** 退出前清理序列（M-8）：before-quit、will-quit、process exit 与 settings-reset 的 app.exit(0) 共用——
 *  彻底清理 mpv、aria2、推送服务、Syncplay、HLS 下载及 Python 进程树，杜绝后台残留。 */
let _cleanedUp = false;
function runQuitCleanup() {
    if (_cleanedUp) return;
    _cleanedUp = true;
    try { if (dlTimer) { clearInterval(dlTimer); dlTimer = null; } } catch (e) {}
    try { stopScheduledLogCleanup(); } catch (e) {}
    try { mpv.stop(); } catch (e) {}
    try { dl.stop(); } catch (e) {}
    try { if (hls && hls.cleanup) hls.cleanup(); } catch (e) {}
    try { pushServer.stop(); } catch (e) {}
    try { syncplay.disconnect(); } catch (e) {}
    try { bridge.stop(); } catch (e) {}
}

app.on('before-quit', () => {
    runQuitCleanup();
});

app.on('will-quit', () => {
    runQuitCleanup();
});

process.on('exit', () => {
    runQuitCleanup();
});

process.on('SIGINT', () => {
    runQuitCleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    runQuitCleanup();
    process.exit(0);
});

// 全局未捕获异常兜底：防进程崩溃导致窗口消失
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});
