/**
 * 本地文件板块（file-manager IPC 契约）回归测试。
 *
 * 回归背景（2026-09 用户报告）：使用「本地文件」板块后整个软件出错、无法进行任何操作。
 * 审计结论（多层防线，任一失效都应在本文件红）：
 *   1. 主进程 fileIpc 包装：handler 抛错必须收敛为 { ok:false, reason }（否则 ipcMain.handle
 *      以 reject 传回渲染层，调用点漏 .catch 即成全局未捕获 rejection）；
 *      yuki:file-pick-root 曾游离在 fileIpc 之外（无 try-catch），setRoot 对无效目录
 *      抛错时直接向渲染层 reject。
 *   2. fileMgr 极早期未初始化（窗口已建、whenReady 后半段未跑完）时，file-list /
 *      file-thumb / file-push 不得抛 TypeError——判空降级（needRoot / ok:false）。
 *   3. file-manager.js 本体：穿越路径、无效名、不存在路径等边界输入只抛可被 fileIpc
 *      收敛的 Error，不允许误删根外文件/目录（resolveSafe 白名单契约）。
 *   4. 渲染层 loadLocalThumbs：fileThumb 的 promise 必须 .catch（防未捕获 rejection）。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// ------------------------------------------------------------------
// electron 主进程桩 + index.js 的 vm 加载（api-contract.test.js 同款结构）
// ------------------------------------------------------------------
function makeElectronStub(tmpRoot) {
    const handlers = new Map();
    let dirPick = { canceled: true, filePaths: [] };
    const app = {
        isPackaged: false,
        whenReady: () => Promise.resolve(),
        on: () => {},
        getPath: (name) => path.join(tmpRoot, String(name || 'misc')),
        quit: () => {},
        exit: () => {},
        relaunch: () => {},
        getVersion: () => '0.0.0-test',
        getAppPath: () => path.join(__dirname, '..', '..'),
        requestSingleInstanceLock: () => true,
    };
    const webContents = { send: () => {}, on: () => {}, setWindowOpenHandler: () => {} };
    const BrowserWindow = class {
        constructor() { this.webContents = webContents; }
        on() { return this; }
        setMenuBarVisibility() {}
        loadFile() {}
        isDestroyed() { return false; }
        isMinimized() { return false; }
        restore() {}
        show() {}
        focus() {}
        close() {}
        hide() {}
        minimize() {}
        maximize() {}
        unmaximize() {}
        isMaximized() { return false; }
    };
    BrowserWindow.getAllWindows = () => [];
    const ipcMain = { handle: (channel, fn) => { handlers.set(channel, fn); } };
    const dialog = {
        showOpenDialog: async () => dirPick,
        showMessageBox: async () => ({ response: 1 }),
        showMessageBoxSync: () => 1,
    };
    const Notification = class { constructor() {} show() {} };
    Notification.isSupported = () => false;
    const electron = {
        app, BrowserWindow, ipcMain, dialog, Notification,
        nativeImage: { createEmpty: () => ({ isEmpty: () => true, addRepresentation() {}, resize() { return this; } }), createFromPath: () => ({ isEmpty: () => true }), createFromBuffer: () => ({ isEmpty: () => true }) },
        Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} },
        Menu: { buildFromTemplate: () => ({}) },
        session: { defaultSession: { setProxy: async () => {} }, fromPartition: () => ({ getCacheSize: async () => 0, clearCache: async () => {} }) },
        shell: { openPath: async () => '', openExternal: async () => {} },
    };
    return { electron, handlers, setDirPick: (v) => { dirPick = v; } };
}

/** vm 加载 index.js（副作用模块全部桩掉），返回 handlers Map。 */
function loadMainIndex(tmpRoot, { sourceTransform } = {}) {
    const stub = makeElectronStub(tmpRoot);
    const indexPath = path.join(__dirname, '..', '..', 'src', 'main', 'index.js');
    let source = fs.readFileSync(indexPath, 'utf8');
    if (sourceTransform) source = sourceTransform(source);

    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
        queueMicrotask, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
        Buffer, process,
        structuredClone, Reflect, Proxy, Symbol, Error, TypeError, RangeError,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.createContext(sandbox);

    const hostModule = require('module');
    const resolved = require.resolve(indexPath);
    const newModule = new hostModule(resolved, null);
    newModule.paths = hostModule._nodeModulePaths(path.dirname(resolved));
    newModule.filename = resolved;
    sandbox.require = (name) => (name === 'electron' ? stub.electron : newModule.require(name));
    sandbox.__filename = resolved;
    sandbox.__dirname = path.dirname(resolved);

    const serviceStubs = {
        './python-bridge': class { constructor() {} on() {} get extraEnv() { return {}; } set extraEnv(v) {} start() {} stop() {} getInfo() { return {}; } },
        './push-server': class { constructor() {} on() {} start() { return Promise.resolve(0); } stop() {} },
        './logger': {
            RotatingLogWriter: class { constructor() {} write() {} resetSize() {} },
            installConsoleLogger: () => ({ write() {} }),
            readRecentLogs: () => ({ ok: true, logs: [], total: 0 }),
            clearLogs: () => ({ ok: true }),
            setLogLevel: () => {},
            startScheduledLogCleanup: () => {},
            stopScheduledLogCleanup: () => {},
        },
        './downloader': class { constructor() { this.dir = ''; this.concurrency = 3; this.split = 5; } isAvailable() { return false; } async setConcurrency() {} async setSplit() {} stop() {} on() {} async remove() { return undefined; } async addUri() { throw new Error('aria2 not running'); } tellStatus() { return Promise.reject(new Error('aria2 not running')); } },
        './mpv-player': class { constructor() { this.binary = ''; this.playing = false; } isAvailable() { return false; } stop() {} command() { return Promise.resolve(); } on() {} waitForReady() { return Promise.resolve({ ok: false }); } },
        './syncplay-client': class { constructor() { this.connected = false; } on() {} connect() { return Promise.reject(new Error('stub')); } disconnect() {} sendState() {} sendFile() {} sendChat() {} },
        './dlna-caster': class { constructor() {} on() {} search() { return Promise.reject(new Error('stub')); } cast() { return Promise.reject(new Error('stub')); } stop() { return Promise.resolve(); } },
        './parse-window': class { constructor() {} },
        './pan-qr-window': { openLoginWindow: async () => ({ ok: false }), closeLoginWindow: () => {} },
        './updater': { setupAutoUpdater: () => ({ enabled: false }), createUpdaterController: () => ({}) },
        './misans': { ensureMisans: () => Promise.resolve(true), fontCssUrls: () => [], readyCssPaths: () => [] },
        './app-icon': { windowIcon: () => undefined },
        './ext-watch': { extWatch: { on() {} } },
        './ffmpeg': { findFfmpeg: () => null, ensureFfmpeg: () => Promise.resolve(false), isEnsuring: () => false, thumb: () => Promise.resolve({ ok: false }), urlThumb: () => Promise.resolve({ ok: false }) },
    };

    const cacheKey = require.resolve('electron');
    const prevElectron = hostModule._cache[cacheKey];
    const preset = (request, exportsValue) => {
        const key = hostModule._resolveFilename(request, newModule);
        const m = new hostModule(key, null);
        m.exports = exportsValue;
        m.loaded = true;
        hostModule._cache[key] = m;
        return key;
    };
    const stubKeys = [preset('electron', stub.electron)];
    for (const [req, impl] of Object.entries(serviceStubs)) {
        stubKeys.push(preset(req, impl));
    }

    try {
        vm.runInContext(source, sandbox, { filename: 'index.js', breakOnSigint: false });
        newModule.loaded = true;
    } finally {
        for (const key of stubKeys) {
            const existing = hostModule._cache[key];
            if (key === cacheKey) {
                if (prevElectron === undefined) delete hostModule._cache[key];
                else hostModule._cache[key] = prevElectron;
            } else if (existing && existing.exports && stubKeys.includes(key)) {
                delete hostModule._cache[key];
            }
        }
    }
    return { sandbox, handlers: stub.handlers, setDirPick: stub.setDirPick, electron: stub.electron };
}

async function loadMainIndexReady(tmpRoot, opts) {
    const loaded = loadMainIndex(tmpRoot, opts);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return loaded;
}

/** 白名单根工作区：userData/downloads 与系统下载替身都必须真实存在（setRoot 契约）。 */
function makeWorkspace() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-fmipc-'));
    const rootDir = path.join(tmpRoot, 'userData', 'downloads');
    fs.mkdirSync(rootDir, { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'video.mp4'), 'v');
    fs.writeFileSync(path.join(rootDir, '中文 影片.mp4'), 'v');
    fs.mkdirSync(path.join(rootDir, '子目录'), { recursive: true });
    return { tmpRoot, rootDir };
}

// ------------------------------------------------------------------
// 1. fileIpc 收敛契约：handler 抛错 → ok:false（不得 reject 穿透到渲染层）
// ------------------------------------------------------------------
test('fileIpc 收敛：file-pick-root 对无效根目录/取消返回 ok:false 而非 reject', async () => {
    const { tmpRoot } = makeWorkspace();
    const { handlers, setDirPick } = await loadMainIndexReady(tmpRoot);
    const pickRoot = handlers.get('yuki:file-pick-root');
    assert.equal(typeof pickRoot, 'function', 'yuki:file-pick-root 应已注册');
    // 回归点：旧实现游离在 fileIpc 外（无 try-catch），setRoot 抛错会 reject 穿透，
    // 渲染层 pickRoot 的 .catch 之外路径成为全局未捕获 rejection。
    setDirPick({ canceled: false, filePaths: [path.join(tmpRoot, 'not-exist-dir')] });
    const r = await pickRoot(null);
    assert.equal(r.ok, false, '无效根目录必须收敛为 ok:false');
    assert.ok(String(r.reason || '').length > 0, '失败必须带 reason');
    setDirPick({ canceled: true, filePaths: [] });
    const r2 = await pickRoot(null);
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'canceled');
});

test('fileIpc 收敛：穿越/非法输入经 file-list / file-del-file 返回 ok:false', async () => {
    const { tmpRoot } = makeWorkspace();
    const { handlers } = await loadMainIndexReady(tmpRoot);
    const list = handlers.get('yuki:file-list');
    const delFile = handlers.get('yuki:file-del-file');
    for (const evil of ['..\\..\\windows', '../secret', 'C:\\Windows']) {
        const r = await list(null, evil);
        assert.equal(r.ok, false, `${evil} 必须被白名单拒绝`);
        assert.ok(!r.files, '拒绝时不得携带目录内容');
    }
    const rd = await delFile(null, '../outside.txt');
    assert.equal(rd.ok, false, '删除入口同样拒绝穿越');
});

// ------------------------------------------------------------------
// 2. fileMgr 未初始化窗口：判空降级，不抛 TypeError
// ------------------------------------------------------------------
test('fileMgr 未初始化：file-list 走 needRoot、file-thumb/file-push 收敛 ok:false（不抛 TypeError）', async () => {
    const { tmpRoot } = makeWorkspace();
    // 强制改动：装配完成后把 fileMgr 置回 null，模拟「窗口已建、whenReady 后半段未跑完」
    // 的极早期调用窗口（真实场景：渲染层在初始化完成前抢跑）。
    const { handlers } = await loadMainIndexReady(tmpRoot, {
        sourceTransform: (src) => src.replace(
            "    syncDlDir(settings.get('dlDir') || app.getPath('downloads'));",
            "    fileMgr = null; // [test] 模拟 fileMgr 未初始化窗口\n    syncDlDir(settings.get('dlDir') || app.getPath('downloads'));",
        ),
    });
    const list = await handlers.get('yuki:file-list')(null, '');
    assert.equal(list.needRoot, true, 'fileMgr 缺席时 file-list 必须走引导态而非抛 TypeError');
    const thumb = await handlers.get('yuki:file-thumb')(null, 'video.mp4');
    assert.equal(thumb.ok, false, 'fileMgr 缺席时 file-thumb 相对路径分支必须降级 ok:false（不得 TypeError）');
    // fileIpc 契约：仅当 fn 抛错时才返回 { ok:false, reason }——降级路径是显式
    // return 而非异常，故不得携带 reason（携带即说明走了异常收敛而非判空降级）
    assert.equal(thumb.reason, undefined, 'file-thumb 判空降级必须显式 return，不得经异常收敛');
    const push = await handlers.get('yuki:file-push')(null, 'video.mp4');
    assert.equal(push.ok, false, 'fileMgr 缺席时 file-push 必须降级 ok:false（不得 TypeError）');
    // file-push 降级路径返回语义化 reason（file-not-found，显式 return 而非异常收敛）
    assert.equal(typeof push.reason, 'string', 'file-push 降级必须带语义化 reason 字符串');
    const root = await handlers.get('yuki:file-root')(null);
    assert.equal(root.ok, true, 'file-root 对 null fileMgr 也必须返回可序列化结果');
});

// ------------------------------------------------------------------
// 3. file-manager 本体边界输入（直测，非 Electron 环境）
// ------------------------------------------------------------------
test('file-manager 边界输入：中文/特殊字符/空目录/不存在路径只抛可收敛 Error', async () => {
    const FileManager = require('../../src/main/file-manager');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-fmboundary-'));
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '中文视频.mp4'), 'v');
    fs.writeFileSync(path.join(root, "a&b'c#e%f.mp4"), 'v');
    const fm = new FileManager(tmp, { confirm: async () => 1, getRecords: () => [] });
    fm.setRoot(root);
    // 正常列举：中文名/特殊字符名不炸；time 空串兜底（statSync 失败项）
    const listing = fm.list('');
    assert.ok(listing.files.length >= 2);
    for (const f of listing.files) {
        assert.equal(typeof f.name, 'string');
        assert.equal(typeof f.time, 'string');
        assert.ok(!path.isAbsolute(f.path), '返回路径必须仍是相对路径');
    }
    // 不存在目录 / 穿越一律抛 Error（fileIpc 层负责收敛为 ok:false）
    assert.throws(() => fm.list('不存在目录'), /not a directory/);
    assert.throws(() => fm.list('..\\..'), /path outside whitelist/);
    assert.throws(() => fm.newFolder('', ''), /invalid name/);
    assert.throws(() => fm.newFolder('', '..'), /invalid name/);
    assert.throws(() => fm.delFile('ghost.mp4'), /not a file/);
    // 删除目录 fail-closed：拒绝删根；确认框未注入（fail-closed）时拒绝删除。
    // （fm 的 root=.../root，'子目录' 存在于 fmNoConfirm 的 root 下）
    await assert.rejects(() => fm.delFolder(''), /cannot delete root/);
    fs.mkdirSync(path.join(root, '待删除'), { recursive: true });
    const fmNoConfirm = new FileManager(path.join(tmp, 'cfg2'));
    fmNoConfirm.root = root;
    await assert.rejects(() => fmNoConfirm.delFolder('待删除'), /no confirm/);
});

// ------------------------------------------------------------------
// 4. 渲染层 loadLocalThumbs：fileThumb promise 必须 .catch（防全局未捕获 rejection）
// ------------------------------------------------------------------
test('渲染层 panels.js loadLocalThumbs：fileThumb 调用链必须带 catch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'panels.js'), 'utf8');
    const start = src.indexOf('function loadLocalThumbs()');
    assert.ok(start >= 0, 'loadLocalThumbs 应存在于 panels.js');
    // 函数体终点：下一处行首顶格 "}"（loadLocalThumbs 顶层闭合）
    const end = src.indexOf('\n}', start);
    assert.ok(end > start, 'loadLocalThumbs 函数体应可定位');
    const body = src.slice(start, end);
    assert.match(body, /\.catch\(/, 'loadLocalThumbs 内 fileThumb promise 必须 .catch（防未捕获 rejection 传播到全局）');
});
