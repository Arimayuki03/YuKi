// 黑盒测试：主进程 index.js 注册的 IPC 处理器契约面
// ------------------------------------------------------------------
// 视角：不 mock 内部业务逻辑，只验证「渲染层发一个 IPC 请求 → 主进程返回什么」
// 这一外部可见契约。四条主线：
//   ① 频道清单完整性：源码 grep 出的注册集合 vs preload 调用集合 vs 渲染层
//      实际使用集合，三者交叉比对（注册未调用 / 调用未注册 / 推送方与订阅方对不上）；
//   ② handle-vs-on：需要返回值的频道必须走 ipcMain.handle，不得只注册 on；
//   ③ 契约形状：入参缺失/null/类型错误时返回结构化错误而非异常穿透；
//   ④ 返回值可序列化：不能含函数/循环引用/undefined 之外的 IPC 不可传值。
// 与 api-contract.test.js / main-integration.test.js 的分工：那两个文件逐个验证
// 业务语义（dl 白名单、settings 落盘、danmaku 接线），本文件验证的是**频道面本身**
// （有没有这条频道、频道类型对不对、畸形入参会不会炸、返回值能不能过 IPC）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_INDEX = path.join(ROOT, 'src', 'main', 'index.js');
const MAIN_UPDATER = path.join(ROOT, 'src', 'main', 'updater.js');
const PRELOAD = path.join(ROOT, 'src', 'preload', 'preload.js');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer', 'js');

const read = (p) => fs.readFileSync(p, 'utf8');
/** preload/index.js 均为 CRLF 仓库，正则按行解析前统一归一，避免 \r 破坏 $ 锚点。 */
const linesOf = (p) => read(p).replace(/\r\n/g, '\n').split('\n');

// ==================================================================
// 0. 频道清单的静态提取（被测对象的「注册表」）
// ==================================================================

/** index.js 注册的 ipcMain.handle 频道（含 fileIpc 包装的 file-* 族）。 */
function mainHandleChannels() {
    const src = read(MAIN_INDEX);
    const out = new Map(); // channel → 'handle'
    let m;
    const re = /ipcMain\.(handle|handleOnce)\(\s*'([^']+)'/g;
    while ((m = re.exec(src))) out.set(m[2], 'handle');
    // fileIpc 是 index.js 内的 handle 包装（统一异常收敛），等价于 handle 注册
    const fre = /fileIpc\(\s*'([^']+)'/g;
    while ((m = fre.exec(src))) out.set(m[1], 'handle');
    return out;
}

/** index.js 注册的 ipcMain.on 频道（无返回值的单向通道）。 */
function mainOnChannels() {
    const src = read(MAIN_INDEX);
    const out = new Set();
    let m;
    const re = /ipcMain\.(on|once)\(\s*'([^']+)'/g;
    while ((m = re.exec(src))) out.add(m[2]);
    return out;
}

/** 主进程主动推送（webContents.send / send 包装）的频道集合。 */
function mainPushChannels() {
    const src = read(MAIN_INDEX);
    const up = read(MAIN_UPDATER);
    const out = new Set();
    let m;
    const re = /(?:^|[^\w.])send\(\s*'([^']+)'/g;
    while ((m = re.exec(src))) out.add(m[1]);
    const re2 = /webContents\.send\(\s*'([^']+)'/g;
    while ((m = re2.exec(src))) out.add(m[1]);
    while ((m = re2.exec(up))) out.add(m[1]);
    return out;
}

/** updater.js 单独注册的 handle 频道（index.js 之外的第二个注册点）。 */
function updaterHandleChannels() {
    const src = read(MAIN_UPDATER);
    const out = new Set();
    let m;
    const re = /electronIpcMain\.handle\(\s*'([^']+)'/g;
    while ((m = re.exec(src))) out.add(m[1]);
    return out;
}

/** preload 的 ipcRenderer.invoke 频道集合。 */
function preloadInvokeChannels() {
    const src = read(PRELOAD);
    const out = new Set();
    let m;
    const re = /ipcRenderer\.invoke\(\s*'([^']+)'/g;
    while ((m = re.exec(src))) out.add(m[1]);
    return out;
}

/** preload 的 ipcRenderer.on 频道集合（主进程推送的订阅方）。 */
function preloadOnChannels() {
    const src = read(PRELOAD);
    const out = new Set();
    let m;
    const re = /ipcRenderer\.on\(\s*'([^']+)'/g;
    while ((m = re.exec(src))) out.add(m[1]);
    return out;
}

/**
 * preload 暴露的 window.yuki.* 方法 → 频道的映射（含 download/syncplay/dlna 三个
 * 嵌套分组，键名记为 `download.control` 形式，与渲染层调用写法一致）。
 * 值为 null 表示该方法是纯本地实现（不经 IPC，如 setZoomFactor 走 webFrame）。
 */
function preloadApiMap() {
    const lines = linesOf(PRELOAD);
    const map = new Map();
    let group = null;
    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const g = ln.match(/^\s{4}([A-Za-z_]\w*):\s*\{\s*$/);
        if (g) { group = g[1]; continue; }
        if (/^\s{4}\},\s*$/.test(ln)) { group = null; continue; }
        const indent = group ? 8 : 4;
        const full = (k) => (group ? `${group}.${k}` : k);
        // 一行式 invoke：name: (args) => ipcRenderer.invoke('ch', ...)
        const inv = ln.match(new RegExp(`^\\s{${indent}}([A-Za-z_]\\w*):\\s*\\(?([^)]*)\\)?\\s*=>\\s*ipcRenderer\\.invoke\\(\\s*'([^']+)'`));
        if (inv) { map.set(full(inv[1]), inv[3]); continue; }
        // 多行式 on：onXxx: (cb) => { \n ipcRenderer.on('ch', ...) }
        const onBlock = ln.match(new RegExp(`^\\s{${indent}}on([A-Za-z_]\\w*):\\s*\\(cb\\)\\s*=>\\s*\\{\\s*$`));
        if (onBlock) {
            const c = (lines[i + 1] || '').match(/ipcRenderer\.on\(\s*'([^']+)'/);
            if (c) map.set(full('on' + onBlock[1]), c[1]);
            continue;
        }
        // 一行式 on：onXxx: (cb) => ipcRenderer.on('ch', ...)
        const onOne = ln.match(new RegExp(`^\\s{${indent}}(on[A-Za-z_]\\w*):\\s*\\(cb\\)\\s*=>\\s*ipcRenderer\\.on\\(\\s*'([^']+)'`));
        if (onOne) { map.set(full(onOne[1]), onOne[2]); continue; }
        // async 块体式（settingsGet/settingsSet/settingsReset）：方法名 → 块内 invoke
        const asyncBlock = ln.match(new RegExp(`^\\s{${indent}}([A-Za-z_]\\w*):\\s*async\\s*\\(?([^)]*)\\)?\\s*=>\\s*\\{\\s*$`));
        if (asyncBlock) {
            for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
                const c = lines[j].match(/ipcRenderer\.invoke\(\s*'([^']+)'/);
                if (c) { map.set(full(asyncBlock[1]), c[1]); break; }
                if (/^\s{4}\},?\s*$/.test(lines[j])) break;
            }
            continue;
        }
        // 块体式（settingsReset 为单行块体 `{ _settingsCache = null; return invoke(...) }`）
        const blockStart = ln.match(new RegExp(`^\\s{${indent}}([A-Za-z_]\\w*):\\s*\\(?([^)]*)\\)?\\s*=>\\s*\\{`));
        if (blockStart) {
            const sameLine = ln.match(/ipcRenderer\.invoke\(\s*'([^']+)'/);
            if (sameLine) { map.set(full(blockStart[1]), sameLine[1]); continue; }
            for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
                const c = lines[j].match(/ipcRenderer\.invoke\(\s*'([^']+)'/);
                if (c) { map.set(full(blockStart[1]), c[1]); break; }
            }
        }
    }
    // setZoomFactor 纯 webFrame 本地实现，不经 IPC
    map.set('setZoomFactor', null);
    return map;
}

/** 渲染层实际书写调用的 window.yuki.* 方法名（含分组前缀），值附文件:行号。 */
function rendererApiUsage() {
    const files = fs.readdirSync(RENDERER_DIR).filter((f) => f.endsWith('.js') && f !== 'jquery.min.js');
    const used = new Map(); // apiName → 'file:line'
    for (const f of files) {
        const s = read(path.join(RENDERER_DIR, f));
        const re = /(?:\b|window\.)yuki((?:\.(?:download|syncplay|dlna))?\.(\w+))(?=\s*[;(.,)\]])/g;
        let m;
        while ((m = re.exec(s))) {
            const key = m[1].slice(1);
            if (!used.has(key)) used.set(key, `${f}:${s.slice(0, m.index).split('\n').length}`);
        }
    }
    return used;
}

/** 渲染层调用 → 频道集合（经 preloadApiMap 翻译）。 */
function rendererChannels() {
    const map = preloadApiMap();
    const used = rendererApiUsage();
    const out = new Map(); // channel → apiName
    for (const api of used.keys()) {
        const ch = map.get(api);
        if (ch) out.set(ch, api);
    }
    return out;
}

// ==================================================================
// 1. index.js 的 vm 加载（electron 桩注入，不真启动应用）
// ==================================================================

/** electron 桩：收集 ipcMain.handle 注册的 handler，供黑盒直接调用。 */
function makeElectronStub(tmpRoot) {
    const handlers = new Map();
    const onHandlers = new Map();
    const sent = []; // 主进程推送捕获（channel 观测点）
    const app = {
        isPackaged: false,
        whenReady: () => Promise.resolve(),
        on: () => {},
        getPath: (name) => {
            if (name === 'userData') return path.join(tmpRoot, 'userData');
            return path.join(tmpRoot, String(name || 'misc'));
        },
        quit: () => {},
        exit: () => {},
        relaunch: () => {},
        getVersion: () => '0.0.0-test',
        getAppPath: () => ROOT,
        requestSingleInstanceLock: () => true,
    };
    const webContents = {
        send: (channel, payload) => { sent.push({ channel, payload }); },
        on: () => {},
        setWindowOpenHandler: () => {},
    };
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
        hide() {}
        minimize() {}
        maximize() {}
        unmaximize() {}
        isMaximized() { return false; }
        close() {}
    };
    BrowserWindow.getAllWindows = () => [];
    const ipcMain = {
        handle: (channel, fn) => { handlers.set(channel, fn); },
        on: (channel, fn) => { onHandlers.set(channel, fn); },
    };
    const dialog = {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }), // 统一模拟「用户取消」
        showMessageBox: async () => ({ response: 1 }),
        showMessageBoxSync: () => 1,
    };
    const Notification = class { constructor() {} show() {} };
    Notification.isSupported = () => false;
    const electron = {
        app, BrowserWindow, ipcMain, dialog, Notification,
        nativeImage: { createEmpty: () => ({ isEmpty: () => true, addRepresentation() {}, resize() { return this; }, createFromPath: () => ({}) }) },
        Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} },
        Menu: { buildFromTemplate: () => ({}) },
        session: { defaultSession: { setProxy: async () => {} }, fromPartition: () => ({ getCacheSize: async () => 0, clearCache: async () => {} }) },
        shell: { openPath: async () => '', openExternal: async () => {} },
    };
    return { electron, handlers, onHandlers, sent };
}

/**
 * 定时器围栏：index.js 里有一部分定时器是「设了就不会自动撤」的长周期业务定时器，
 * 最典型的是 yuki:shutdown-timer —— 传入正整数分钟后它在 index.js:4402 注册一个
 * 30 分钟 / 最长 24 小时的 setTimeout（到点真会 exec('shutdown /s')）。在真实
 * Electron 主进程里这是产品行为，但在本文件的 vm 沙箱里没人撤销它：
 *   - 该定时器持有事件循环引用 → 全部用例跑完后 node --test 的测试子进程永不退出；
 *   - runner 端表现为该文件整文件超时失败，并伴随
 *     `Unable to deserialize cloned data due to invalid or unsupported version`
 *     （子进程被 SIGTERM 杀掉时 stdout 上的 V8 序列化消息流被截断，
 *      runner 的 #processRawBuffer 按长度头解包时读到了半条消息）。
 * 全量套件里这个文件一挂就是 600s，足以让整个 run-jsunit 超时。
 * 对策：把注入沙箱的 setInterval/setTimeout 全部记账，env.dispose() 时统一 clear。
 * 只清测试自己引导出来的定时器，不改 src/ 源码、不动任何断言。
 */
function makeTimerFence() {
    const tracked = new Set();
    return {
        setTimeout: (fn, ms, ...args) => {
            const t = setTimeout(fn, ms, ...args);
            tracked.add(t);
            return t;
        },
        setInterval: (fn, ms, ...args) => {
            const t = setInterval(fn, ms, ...args);
            tracked.add(t);
            return t;
        },
        /** 撤销本次引导注册的全部定时器（关机定时器 / 轮询 / 兜底超时一视同仁）。 */
        clear: () => {
            for (const t of tracked) {
                try { clearTimeout(t); } catch (e) { /* 已到期：忽略 */ }
                try { clearInterval(t); } catch (e) { /* 已到期：忽略 */ }
            }
            tracked.clear();
        },
    };
}

/** vm 加载 index.js（与 api-contract.test.js 同款范式）：注入 electron 桩后真实执行。 */
function loadMainIndex(tmpRoot) {
    const stub = makeElectronStub(tmpRoot);
    const source = read(MAIN_INDEX);
    const timerFence = makeTimerFence();

    // process 桩：index.js 在模块顶层无条件注册 process.on('exit'/'SIGINT'/'SIGTERM'/
    // 'uncaughtException'/'unhandledRejection')，若把真实宿主 process 注入 vm，
    // 每次 boot 会累计追加 5 个监听器（约 22 处 bootEnv → 110 个），且 dispose() 无法撤销；
    // 更严重的是 unhandledRejection 默认行为被抑制、处理器用沙箱静默 console —— 本文件
    // 核心目标恰是「异常不穿透」，真实 process 反而把悬挂 rejection 静默吞掉。
    // 这里注入一个薄桩：on/once/exit 被拦截记录，env 用每次 boot 的快照克隆（避免
    // yuki:set-proxy 等 handler 真实写 process.env 污染宿主），其它只读属性透传。
    const processListeners = [];
    const processStub = {
        platform: process.platform,
        arch: process.arch,
        versions: process.versions,
        resourcesPath: process.resourcesPath,
        cwd: process.cwd.bind(process),
        nextTick: process.nextTick.bind(process),
        hrtime: process.hrtime && process.hrtime.bind(process),
        env: Object.assign({}, process.env),
        on(event, fn) { processListeners.push({ event, fn }); },
        once(event, fn) { processListeners.push({ event, fn }); },
        off() {}, removeListener() {}, removeAllListeners() {},
        exit(code) { throw new Error(`[test] 被测代码不应调用 process.exit(${code})`); },
        kill() {}, abort() {},
        stdout: process.stdout, stderr: process.stderr, stdin: process.stdin,
        pid: process.pid, ppid: process.ppid,
        argv: process.argv, execPath: process.execPath, execArgv: process.execArgv,
    };

    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout: timerFence.setTimeout, clearTimeout,
        setInterval: timerFence.setInterval, clearInterval, setImmediate,
        queueMicrotask, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
        Buffer, process: processStub, structuredClone, Reflect, Proxy, Symbol, Error, TypeError, RangeError,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.createContext(sandbox);

    const hostModule = require('module');
    const resolved = require.resolve(MAIN_INDEX);
    const newModule = new hostModule(resolved, null);
    newModule.paths = hostModule._nodeModulePaths(path.dirname(resolved));
    newModule.filename = resolved;
    sandbox.require = (name) => (name === 'electron' ? stub.electron : newModule.require(name));
    sandbox.__filename = resolved;
    sandbox.__dirname = path.dirname(resolved);

    // 带副作用的本地服务模块桩（真实类会 spawn Python/绑端口/写真实日志/探测二进制）
    const serviceStubs = {
        './python-bridge': class { constructor() {} on() {} get extraEnv() { return {}; } set extraEnv(v) {} start() {} stop() {} getInfo() { return {}; } async cancelRuntime() { return { ok: true }; } },
        './push-server': class { constructor() {} on() {} start() { return Promise.resolve(0); } stop() {} info() { return { ip: '127.0.0.1', port: 0, token: 'stub' }; } },
        './logger': {
            RotatingLogWriter: class { constructor() {} write() {} resetSize() {} },
            installConsoleLogger: () => ({ write() {} }),
            readRecentLogs: () => ({ ok: true, logs: [], total: 0 }),
            clearLogs: () => ({ ok: true }),
            setLogLevel: () => {},
            getLogLevel: () => 'INFO',
            startScheduledLogCleanup: () => {},
            stopScheduledLogCleanup: () => {},
        },
        './downloader': class { constructor() { this.concurrency = 3; this.split = 5; this.dir = ''; } isAvailable() { return false; } async setConcurrency(n) { return n | 0; } async setSplit(n) { return n | 0; } stop() {} on() {} },
        './mpv-player': class {
            constructor() { this.binary = ''; this.playing = false; }
            isAvailable() { return false; }
            stop() {}
            command() { return Promise.resolve(); }
            on() {}
            getTimePos() { return null; }
            setPause() { return Promise.resolve(); }
            resetBinary() {}
            setCustomPath() { return false; }
            loadDanmakuBatch() { return 0; }
        },
        './syncplay-client': class { constructor() { this.connected = false; } on() {} connect() { return Promise.reject(new Error('stub')); } disconnect() {} sendState() {} sendFile() {} sendChat() {} },
        './dlna-caster': class { constructor() {} on() {} search() { return Promise.reject(new Error('stub')); } cast() { return Promise.reject(new Error('stub')); } stop() { return Promise.resolve(); } },
        './parse-window': class { constructor() {} async resolve() { return { ok: false, reason: 'stub' }; } async captureDirect() { return { ok: false, reason: 'stub' }; } async captchaVerify() { return { ok: true }; } },
        './pan-qr-window': { openLoginWindow: async () => ({ ok: false }), closeLoginWindow: () => {} },
        './updater': { setupAutoUpdater: () => ({ enabled: false }), createUpdaterController: () => ({}) },
        './misans': { ensureMisans: () => Promise.resolve(true), fontCssUrls: () => [], readyCssPaths: () => [] },
        './app-icon': { windowIcon: () => undefined },
    };
    const preset = (request, exportsValue) => {
        const key = hostModule._resolveFilename(request, newModule);
        const m = new hostModule(key, null);
        m.exports = exportsValue;
        m.loaded = true;
        hostModule._cache[key] = m;
        return key;
    };
    const stubKeys = [preset('electron', stub.electron)];
    for (const [req, impl] of Object.entries(serviceStubs)) stubKeys.push(preset(req, impl));
    try {
        vm.runInContext(source, sandbox, { filename: 'index.js', breakOnSigint: false });
        newModule.loaded = true;
    } finally {
        for (const key of stubKeys) {
            const existing = hostModule._cache[key];
            if (existing && existing.exports && stubKeys.includes(key)) delete hostModule._cache[key];
        }
    }
    // 定时器围栏随 env 一起交给调用方：用例里调用 handle 才注册的长周期定时器
    // （如 yuki:shutdown-timer 的 30 分钟关机定时器）必须由 dispose() 撤销，
    // 否则测试子进程跑完全部用例也不退出（详见 makeTimerFence 注释）。
    return { sandbox, handlers: stub.handlers, onHandlers: stub.onHandlers, timerFence, processListeners };
}

/** 加载 + 冲刷微任务（app.whenReady().then(...) 注册 handler 需要一个微任务轮）。 */
async function loadMainIndexReady(tmpRoot) {
    const loaded = loadMainIndex(tmpRoot);
    await new Promise((r) => setImmediate(r));
    return loaded;
}

/** 临时工作区：userData/downloads 与系统下载目录都必须真实存在（fileMgr.setRoot 要求）。 */
function makeWorkspace() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-ipcbb-'));
    fs.mkdirSync(path.join(tmpRoot, 'userData', 'downloads'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'pictures'), { recursive: true });
    return tmpRoot;
}

/** 建工作区 + 加载 index.js，返回 { tmpRoot, handlers, processListeners, dispose }。 */
async function bootEnv() {
    const tmpRoot = makeWorkspace();
    const { handlers, onHandlers, timerFence, processListeners } = await loadMainIndexReady(tmpRoot);
    return {
        tmpRoot,
        handlers,
        onHandlers,
        processListeners,
        dispose: () => {
            // 先撤定时器再删目录：index.js 业务定时器可能还在异步访问工作区
            timerFence.clear();
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        },
    };
}

// ==================================================================
// 2. 频道清单完整性（最高价值）
// ==================================================================

test('频道清单：index.js 至少注册 73 条 handle 频道（清单规模基线）', () => {
    const ch = mainHandleChannels();
    assert.ok(ch.size >= 73, `index.js handle 频道数应 >= 73，实为 ${ch.size}`);
    // 规模基线防「整段注册被误删而无人察觉」：低于 70 说明有大片注册消失了
    assert.ok(ch.size <= 200, `频道数异常膨胀（${ch.size}），疑似重复注册`);
});

test('频道清单：preload 调用未注册的频道数为 0（无悬空调用）', () => {
    const registered = new Set([...mainHandleChannels().keys(), ...updaterHandleChannels()]);
    const invoked = preloadInvokeChannels();
    const dangling = [...invoked].filter((c) => !registered.has(c));
    assert.deepEqual(dangling, [],
        `preload 调到未注册频道（渲染层调用将永久 pending/reject）: ${dangling.join(', ')}`);
});

test('频道清单：渲染层调用未注册（handle）的频道数为 0', () => {
    const registered = new Set([...mainHandleChannels().keys(), ...updaterHandleChannels()]);
    const used = rendererChannels();
    const dangling = [...used.keys()].filter((c) => !registered.has(c));
    // 注：推送型频道（主进程 → 渲染层）本就不在 handle 集合里，见下一条用例
    const invokeOnly = dangling.filter((c) => !mainPushChannels().has(c));
    assert.deepEqual(invokeOnly, [],
        `渲染层调到既无 handle 也无主进程推送的频道: ${invokeOnly.join(', ')}`);
});

test('频道清单：渲染层订阅的推送频道全部有主进程发送方（无死订阅）', () => {
    const pushing = mainPushChannels();
    const subscribed = preloadOnChannels();
    const dead = [...subscribed].filter((c) => !pushing.has(c));
    assert.deepEqual(dead, [],
        `preload 订阅了主进程从不发送的频道（事件永不触发的死代码）: ${dead.join(', ')}`);
});

test('频道清单：更新器三条频道由 updater.js 注册（index.js 之外的第二注册点）', () => {
    const upd = updaterHandleChannels();
    for (const ch of ['yuki:check-for-updates', 'yuki:update-download', 'yuki:update-install']) {
        assert.ok(upd.has(ch), `${ch} 应由 updater.js 注册`);
        assert.ok(!mainHandleChannels().has(ch), `${ch} 不应重复注册在 index.js`);
    }
    assert.ok(preloadInvokeChannels().has('yuki:check-for-updates'),
        'preload 的 checkForUpdates 应能落到 updater.js 的注册上');
});

test('频道清单：注册了但渲染层从未调用的频道——差异清单（白盒盘点，附处置建议）', () => {
    const registered = mainHandleChannels();
    const usedByRenderer = rendererChannels();
    const unused = [...registered.keys()].filter((c) => !usedByRenderer.has(c)).sort();
    // 该清单是本次测试的高价值产出：以下频道主进程注册了、preload 也桥接了，
    // 但渲染层当前无调用点。逐个记录结论，避免后人误判为「死代码」直接删。
    // 实测（2026-09-23）全部为「preload 已桥接、渲染层未接线」的待启用功能：
    //   yuki:push-url / yuki:push-info    局域网推送面板未接（pushInfo 面板未落地）
    //   yuki:player-state                 播放器状态查询（player.js 已改用本地态）
    //   yuki:file-root                    本地文件根查询（pickRoot 后由列表回带）
    //   yuki:pick-mpv / yuki:clear-mpv-path / yuki:mpv-path  自定义 mpv 路径三件套未接
    //   yuki:pick-folder                  通用目录选择（后被 pick-cache-dir 取代）
    //   yuki:mpv-screenshot               mpv 截图（仅用了 mpvScreenshotDir 打开目录）
    //   yuki:syncplay-* / yuki:dlna-*     一起看/投屏两组功能面板未落地
    assert.deepEqual(unused, [
        'yuki:clear-mpv-path', 'yuki:dlna-cast', 'yuki:dlna-search', 'yuki:dlna-stop',
        'yuki:file-root', 'yuki:mpv-path', 'yuki:mpv-screenshot', 'yuki:pick-folder',
        'yuki:pick-mpv', 'yuki:player-state', 'yuki:push-info', 'yuki:push-url',
        'yuki:syncplay-chat', 'yuki:syncplay-connect', 'yuki:syncplay-disconnect',
        'yuki:syncplay-file', 'yuki:syncplay-state',
    ], '注册未调用清单已变化：若某条被渲染层接线请从本清单移除；若新增条目请补注释说明用途');
    for (const c of unused) {
        assert.equal(registered.get(c), 'handle', `${c} 应为 handle 注册`);
        assert.ok(preloadInvokeChannels().has(c),
            `${c} 应仍在 preload 桥接（预处理层已备好，接上渲染层即可用）`);
    }
});

test('频道清单：注册=preload 调用（两者一一对应，无「注册了 preload 没暴露」）', () => {
    const registered = mainHandleChannels();
    const invoked = preloadInvokeChannels();
    // 方向一：注册了但 preload 没桥接 → 渲染层永远调不到（死注册）
    const notBridged = [...registered.keys()].filter((c) => !invoked.has(c)).sort();
    assert.deepEqual(notBridged, [],
        `注册了但 preload 未桥接的频道（渲染层无法触达）: ${notBridged.join(', ')}`);
    // 方向二：preload 桥接了但没注册 → 调用永久 pending（悬空调用，见上一条用例）
    const notRegistered = [...invoked].filter((c) => !registered.has(c) && !updaterHandleChannels().has(c));
    assert.deepEqual(notRegistered, [], `preload 桥接了但无人注册: ${notRegistered.join(', ')}`);
});

test('频道清单：渲染层用到的 API 名全部在 preload 有暴露（无 undefined.xxx 崩溃面）', () => {
    const map = preloadApiMap();
    const used = rendererApiUsage();
    const missing = [...used.keys()].filter((api) => !map.has(api));
    assert.deepEqual(missing, [],
        `渲染层调用了 preload 未暴露的 API（运行时 TypeError）: ${missing.join(', ')}`);
});

test('频道清单：主进程推送了但 preload 无订阅的频道（已知死推送 yuki:play-failed）', () => {
    const pushing = mainPushChannels();
    const subscribed = preloadOnChannels();
    const orphan = [...pushing].filter((c) => !subscribed.has(c)).sort();
    // yuki:play-failed 是已确认的死推送：index.js:3489 发送，preload 在 2026-09-22
    // 死接口清理中移除了订阅（渲染层播放失败改走 play() 返回值），事件落空。
    assert.deepEqual(orphan, ['yuki:play-failed'],
        '主进程推送但 preload 无订阅的频道应为且仅为 yuki:play-failed');
});

// ==================================================================
// 3. handle / on 类型匹配
// ==================================================================

test('handle-vs-on：index.js 不存在 ipcMain.on 注册（全部走可返回值的 handle）', () => {
    const onCh = mainOnChannels();
    assert.deepEqual([...onCh], [],
        'index.js 不应有 ipcMain.on 注册：渲染层经 preload 只用 invoke，on 注册收不到调用');
});

test('handle-vs-on：运行时也未注册任何 ipcMain.on 频道（vm 实测）', async () => {
    const env = await bootEnv();
    try {
        assert.equal(env.onHandlers.size, 0,
            `index.js 运行时注册了 ${env.onHandlers.size} 条 on 频道: ${[...env.onHandlers.keys()].join(', ')}`);
    } finally { env.dispose(); }
});

test('process 监听器契约：index.js 顶层只注册 5 类事件且全部落在沙箱桩上（vm 实测）', async () => {
    // 钉住「沙箱 process 桩」隔离契约的另一半：顶层注册集合若增删（如新增
    // process.on('SIGHUP')），本用例变红提醒同步维护 processStub；被测代码全部
    // 通过桩注册，宿主测试进程零污染（不再有 MaxListeners 累积）。
    const env = await bootEnv();
    try {
        const events = env.processListeners.map((l) => l.event).sort();
        // 事件名按 index.js 源码原样（'SIGINT'/'SIGTERM' 大写，其余小写）
        assert.deepEqual(events,
            ['SIGINT', 'SIGTERM', 'exit', 'uncaughtException', 'unhandledRejection'],
            `顶层 process.on 注册集合变化: ${[...new Set(events)].join(', ')}`);
    } finally { env.dispose(); }
});

test('handle-vs-on：所有需要返回值的频道均已在运行时注册为 handle（vm 实测全量）', async () => {
    const env = await bootEnv();
    try {
        const staticCh = mainHandleChannels();
        const missing = [...staticCh.keys()].filter((c) => !env.handlers.has(c));
        assert.deepEqual(missing, [],
            `源码里有注册、运行时却拿不到 handler: ${missing.join(', ')}`);
        assert.equal(env.handlers.size, staticCh.size,
            '运行时 handler 数应与源码静态提取数一致（无重复注册覆盖）');
    } finally { env.dispose(); }
});

test('handle-vs-on：file-* 族 9 条经 fileIpc 包装后仍是 handle（不降级为 on）', async () => {
    const env = await bootEnv();
    try {
        const fileCh = ['yuki:file-root', 'yuki:file-pick-root', 'yuki:file-list', 'yuki:file-open-dir',
            'yuki:file-new-folder', 'yuki:file-del-file', 'yuki:file-del-folder', 'yuki:file-thumb', 'yuki:file-push'];
        for (const c of fileCh) {
            assert.equal(typeof env.handlers.get(c), 'function', `${c} 应注册为可调用的 handle`);
            assert.ok(!env.onHandlers.has(c), `${c} 不得注册为 on`);
        }
    } finally { env.dispose(); }
});

// ==================================================================
// 4. 命名规范一致性
// ==================================================================

test('命名规范：全部频道为小写 kebab-case，冒号分隔（无大写/下划线/空格）', () => {
    const all = [...mainHandleChannels().keys(), ...updaterHandleChannels(), ...mainPushChannels()];
    const bad = all.filter((c) => !/^[a-z0-9]+(?:[:.-][a-z0-9]+)*$/.test(c));
    assert.deepEqual(bad, [], `频道名含非法字符: ${bad.join(', ')}`);
});

test('命名规范：除 backend-info 外全部带 yuki: 前缀（命名空间统一）', () => {
    const all = [...mainHandleChannels().keys(), ...updaterHandleChannels(), ...mainPushChannels()];
    const noPrefix = [...new Set(all)].filter((c) => !c.startsWith('yuki:'));
    assert.deepEqual(noPrefix.sort(), ['backend-info', 'backend-ready', 'backend-state'],
        '非 yuki: 前缀的频道应仅为后端桥接三兄弟（历史命名，渲染层 getBackendInfo/onBackendReady/onBackendState 直用）');
});

test('命名规范：无重复注册（同一频道不得被 handle 注册两次）', () => {
    const src = read(MAIN_INDEX);
    const seen = new Map();
    let m;
    const re = /(?:ipcMain\.handle|fileIpc)\(\s*'([^']+)'/g;
    let dup = [];
    while ((m = re.exec(src))) {
        const line = src.slice(0, m.index).split('\n').length;
        if (seen.has(m[1])) dup.push(`${m[1]}（${seen.get(m[1])} 行 与 ${line} 行）`);
        else seen.set(m[1], line);
    }
    assert.deepEqual(dup, [], `频道被重复注册（后者静默覆盖前者）: ${dup.join('; ')}`);
});

// ==================================================================
// 5. 代表性频道的契约形状（畸形入参不穿透）
// ==================================================================

test('契约形状：yuki:shutdown-timer 入参 null/字符串/负数/对象均返回结构化结果不抛异常', async () => {
    const env = await bootEnv();
    try {
        const h = env.handlers.get('yuki:shutdown-timer');
        assert.equal(typeof h, 'function');
        // 取消语义：null / undefined / 非数字字符串 / 负数 / 0 一律「取消」且 ok:true
        for (const [label, v] of [['null', null], ['undefined', undefined], ['abc', 'abc'], ['-1', -1], ['0', 0]]) {
            const r = await h(null, v);
            assert.equal(typeof r, 'object', `${label} 应返回对象`);
            assert.equal(r.ok, true, `${label} 应按「取消」语义返回 ok:true，实为 ${JSON.stringify(r)}`);
            assert.equal(typeof r.msg, 'string', `${label} 应带文案 msg`);
        }
        // 非数字对象类型：明确拒绝（防 NaN 延时被 setTimeout 钳成 1ms 立即关机）
        for (const v of [{}, []]) {
            const r = await h(null, v);
            assert.equal(r.ok, false, `${JSON.stringify(v)} 应被拒绝（ok:false），实为 ${JSON.stringify(r)}`);
            assert.equal(typeof r.msg, 'string');
        }
        // 正常值：设定成功并回带分钟与时刻
        const ok = await h(null, 30);
        assert.equal(ok.ok, true);
        assert.equal(ok.minutes, 30);
        assert.match(ok.at, /^\d{2}:\d{2}$/, 'at 应为 HH:MM 形态');
        // 超限截断到 24h（防 setTimeout 2^31-1 溢出）
        const capped = await h(null, 100000000);
        assert.equal(capped.minutes, 1440, '超出 24 小时应截断为 1440 分钟');
        assert.match(capped.msg, /截断/);
    } finally { env.dispose(); }
});

test('契约形状：yuki:probe-urls 非数组入参返回空数组而非抛异常', async () => {
    const env = await bootEnv();
    try {
        const h = env.handlers.get('yuki:probe-urls');
        for (const [label, v] of [['null', null], ['undefined', undefined], ['{}', {}], ['字符串', 'not-an-array'], ['[]', []]]) {
            const r = await h(null, v);
            assert.ok(Array.isArray(r), `${label} 应返回数组，实为 ${JSON.stringify(r)}`);
            assert.equal(r.length, 0, `${label} 应返回空数组`);
        }
        // 非 http(s) 协议（rtmp/rtsp）默认放行 → [true]
        const rtmp = await h(null, ['rtmp://live.test/stream']);
        assert.deepEqual(rtmp, [true], '非 HTTP 协议应默认判活');
    } finally { env.dispose(); }
});

test('契约形状：yuki:test-proxy 入参缺失/非法返回 {ok:false, reason} 不抛异常', async () => {
    const env = await bootEnv();
    try {
        const h = env.handlers.get('yuki:test-proxy');
        for (const [label, v] of [['null', null], ['undefined', undefined], ['空对象', {}]]) {
            const r = await h(null, v);
            assert.equal(r.ok, false, `${label} 应为 ok:false，实为 ${JSON.stringify(r)}`);
            assert.equal(typeof r.reason, 'string', `${label} 应带可读 reason`);
        }
        // 缺端口 / 端口越界：结构化拒绝，不发起真实连接
        const noPort = await h(null, { proxyUrl: 'http://127.0.0.1' });
        assert.equal(noPort.ok, false);
        assert.match(noPort.reason, /host:port|无效/);
        const badPort = await h(null, { proxyUrl: 'http://127.0.0.1:99999' });
        assert.equal(badPort.ok, false);
        assert.equal(typeof badPort.reason, 'string');
    } finally { env.dispose(); }
});

test('契约形状：yuki:external-player 空/非法 URL 返回 {ok:false, reason:"bad url"}', async () => {
    const env = await bootEnv();
    try {
        const h = env.handlers.get('yuki:external-player');
        for (const [label, v] of [['null', null], ['undefined', undefined], ['数字', 123],
            ['file://', 'file:///C:/x.mp4'], ['ftp://', 'ftp://a/b'], ['空串', '']]) {
            const r = await h(null, v, null);
            assert.equal(r.ok, false, `${label} 应为 ok:false，实为 ${JSON.stringify(r)}`);
            assert.equal(r.reason, 'bad url', `${label} 的 reason 应为 bad url`);
        }
        // opts 为 null 也不得抛（header 取用有默认值）
        const r2 = await h(null, 'https://a.test/v.mp4', null);
        assert.equal(typeof r2, 'object', 'opts=null 不得抛异常');
    } finally { env.dispose(); }
});

test('契约形状：yuki:file-* 族空/null 入参统一返回 {ok:false, reason} 而非 TypeError', async () => {
    const env = await bootEnv();
    try {
        // fileIpc 包装契约：任何异常收敛为 { ok:false, reason }，不向渲染层 reject
        for (const ch of ['yuki:file-del-file', 'yuki:file-del-folder', 'yuki:file-new-folder']) {
            const r = await env.handlers.get(ch)(null, null);
            assert.equal(typeof r, 'object', `${ch} 应返回对象`);
            assert.equal(r.ok, false, `${ch} null 入参应为 ok:false，实为 ${JSON.stringify(r)}`);
            assert.equal(typeof r.reason, 'string', `${ch} 应带 reason`);
        }
        // yuki:file-thumb 白名单未命中时只回 { ok:false }（无 reason：渲染层据此用占位图，
        // 不弹提示）——契约只要求「不抛异常 + ok:false + 可序列化」
        const thumb = await env.handlers.get('yuki:file-thumb')(null, null);
        assert.equal(thumb.ok, false, `file-thumb null 入参应为 ok:false，实为 ${JSON.stringify(thumb)}`);
        assert.doesNotThrow(() => structuredClone(thumb), 'file-thumb 返回值必须可过 IPC');
        // 越界路径：白名单拒绝
        const outside = await env.handlers.get('yuki:file-open-dir')(null, '../etc');
        assert.equal(outside.ok, false);
        assert.equal(typeof outside.reason, 'string');
        // 正常路径：根目录可列出（契约形态而非业务内容）
        const list = await env.handlers.get('yuki:file-list')(null, '');
        assert.equal(list.ok, true);
        assert.ok(Array.isArray(list.files), 'file-list 应回带 files 数组');
    } finally { env.dispose(); }
});

test('契约形状：yuki:dl 未知 action 与 null payload 均返回结构化失败', async () => {
    const env = await bootEnv();
    try {
        const h = env.handlers.get('yuki:dl');
        const unknown = await h(null, 'no-such-action', {});
        assert.equal(unknown.ok, false);
        assert.equal(unknown.reason, 'unknown action no-such-action',
            '未知 action 应回显 action 名，便于定位渲染层拼写错误');
        const nullAction = await h(null, null, {});
        assert.equal(nullAction.ok, false);
        assert.match(nullAction.reason, /unknown action/);
        // payload 缺省（preload 传 {}，直调时传 null）不得抛
        const nullPayload = await h(null, 'add', null);
        assert.equal(typeof nullPayload, 'object');
        assert.equal(nullPayload.ok, false, 'aria2 不可用时 add 应结构化失败');
    } finally { env.dispose(); }
});

test('契约形状：yuki:parse / yuki:capture-direct 空入参返回带 error.code 的结构化失败', async () => {
    const env = await bootEnv();
    try {
        const parse = await env.handlers.get('yuki:parse')(null, null);
        assert.equal(parse.ok, false);
        assert.equal(typeof parse.reason, 'string', 'parse 应带 reason');
        const capture = await env.handlers.get('yuki:capture-direct')(null, null);
        assert.equal(capture.ok, false);
        assert.equal(typeof capture.error, 'object', 'capture-direct 应带 error 对象（渲染层按 code 分类提示）');
        assert.equal(capture.error.code, 'L4_PARSE_FAILED');
        assert.equal(capture.error.stage, 'parse');
        assert.equal(capture.error.retryable, true);
        assert.equal(typeof capture.error.message, 'string');
    } finally { env.dispose(); }
});

test('契约形状：yuki:play 拒绝 file:// 等本地协议（L-1 白名单）且空 payload 不抛', async () => {
    const env = await bootEnv();
    try {
        const h = env.handlers.get('yuki:play');
        const bad = await h(null, { url: 'file:///C:/secret.mp4' });
        assert.equal(bad.ok, false);
        assert.equal(bad.reason, 'bad url protocol', '本地文件协议必须被拒绝');
        assert.equal(typeof bad.runtimeError, 'object', '应带 runtimeError 供渲染层展示');
        assert.equal(typeof bad.runtimeError.code, 'string');
        // 空 payload：mpv 未就绪 → mpv-missing 结构化失败（不是 TypeError 穿透）
        const empty = await h(null, null);
        assert.equal(empty.ok, false);
        assert.equal(empty.reason, 'mpv-missing');
        assert.equal(typeof empty.runtimeError.code, 'string');
    } finally { env.dispose(); }
});

test('契约形状：yuki:settings-set 白名单外的键返回 {ignored:true} 且不落盘', async () => {
    const env = await bootEnv();
    try {
        const set = env.handlers.get('yuki:settings-set');
        const get = env.handlers.get('yuki:settings-get');
        // 敏感路径键必须被忽略（只能经主进程对话框设置）
        for (const k of ['mpvPath', 'dlDir', 'cacheDir']) {
            const r = await set(null, k, 'C:\\evil');
            assert.equal(r.ignored, true, `${k} 应被白名单拒绝`);
            assert.equal(r.value, undefined);
        }
        const all = await get();
        assert.equal(all.mpvPath, undefined, '被忽略的键不得落盘');
        // 白名单内键正常写入且回带 value
        const ok = await set(null, 'theme', 'dark');
        assert.equal(ok.ignored, undefined);
        assert.equal(ok.value, 'dark');
    } finally { env.dispose(); }
});

test('契约形状：yuki:syncplay-connect 传 null 返回 {ok:false, reason} 而非抛（防未捕获 rejection）', async () => {
    const env = await bootEnv();
    try {
        const r = await env.handlers.get('yuki:syncplay-connect')(null, null);
        assert.equal(r.ok, false);
        assert.equal(typeof r.reason, 'string', '应把 TypeError 收敛为 reason 字符串');
    } finally { env.dispose(); }
});

test('契约形状：yuki:set-proxy / yuki:set-log-level / yuki:set-log-cleanup 空入参不抛', async () => {
    const env = await bootEnv();
    try {
        const proxy = await env.handlers.get('yuki:set-proxy')(null, null);
        assert.equal(proxy.ok, true, '空 opts 视为关闭代理并成功返回');
        const bad = await env.handlers.get('yuki:set-proxy')(null, { url: 'not-a-proxy', enable: true });
        assert.equal(bad.ok, false);
        assert.match(bad.reason, /无效的代理地址/);
        const lvl = await env.handlers.get('yuki:set-log-level')(null, null);
        assert.equal(lvl.ok, true);
        assert.equal(lvl.level, 'INFO', '非法级别应回落默认并回带实际级别');
        const clean = await env.handlers.get('yuki:set-log-cleanup')(null, null);
        assert.equal(clean.ok, true);
        assert.equal(clean.enabled, false);
        assert.equal(clean.days, 0, 'days 非数字应钳到 0');
    } finally { env.dispose(); }
});

test('契约形状：yuki:pick-* 系列在用户取消时统一返回 {ok:false, reason:"cancelled"}', async () => {
    const env = await bootEnv();
    try {
        // 桩的 dialog 恒返回 canceled:true，模拟用户在系统对话框点取消
        for (const ch of ['yuki:pick-wallpaper', 'yuki:pick-folder', 'yuki:pick-mpv', 'yuki:pick-player']) {
            const r = await env.handlers.get(ch)(null);
            assert.equal(r.ok, false, `${ch} 取消时应为 ok:false，实为 ${JSON.stringify(r)}`);
            assert.equal(r.reason, 'cancelled', `${ch} 取消时 reason 应为 cancelled`);
        }
        // pick-cache-dir 空 dir 走弹窗分支，取消同样是 cancelled
        const cache = await env.handlers.get('yuki:pick-cache-dir')(null, '');
        assert.equal(cache.ok, false);
        assert.equal(cache.reason, 'cancelled');
        // UNC 路径（非弹窗分支）走 dir-invalid
        const unc = await env.handlers.get('yuki:pick-cache-dir')(null, '\\\\server\\share');
        assert.equal(unc.ok, false);
        assert.equal(unc.reason, 'dir-invalid');
    } finally { env.dispose(); }
});

// ==================================================================
// 6. 返回值可序列化（IPC 边界必须可 structuredClone）
// ==================================================================

/** 递归扫描：不得出现函数/undefined/Symbol/BigInt/循环引用/Electron 原生对象。 */
function assertSerializable(label, value, seen = new WeakSet(), depth = 0) {
    assert.ok(depth < 12, `${label}: 返回结构嵌套过深（可能含循环引用）`);
    if (value === null) return;
    const t = typeof value;
    if (t === 'function') assert.fail(`${label}: 返回值含函数（IPC 无法传递）`);
    if (t === 'undefined') assert.fail(`${label}: 返回值含 undefined（IPC 会静默丢字段）`);
    if (t === 'symbol') assert.fail(`${label}: 返回值含 Symbol（IPC 无法传递）`);
    if (t === 'bigint') assert.fail(`${label}: 返回值含 BigInt（structuredClone 抛错）`);
    if (t !== 'object') return; // string/number/boolean 均可传
    assert.ok(!seen.has(value), `${label}: 返回值含循环引用（structuredClone 抛错）`);
    seen.add(value);
    // Electron 原生对象（BrowserWindow/webContents/NativeImage 等）不可跨 IPC
    assert.ok(!(value.constructor && /^(BrowserWindow|WebContents|NativeImage|Session|Tray|Menu)/.test(value.constructor.name)),
        `${label}: 返回值含 Electron 原生对象 ${value.constructor.name}`);
    if (Array.isArray(value)) {
        value.forEach((v, i) => assertSerializable(`${label}[${i}]`, v, seen, depth + 1));
        return;
    }
    for (const k of Object.keys(value)) {
        assertSerializable(`${label}.${k}`, value[k], seen, depth + 1);
    }
}

test('返回值可序列化：一批无副作用查询频道的结构化返回不含函数/循环引用', async () => {
    const env = await bootEnv();
    try {
        const cases = [
            ['yuki:app-version', []],
            ['yuki:config-state', []],
            ['backend-info', []],
            ['yuki:player-state', []],
            ['yuki:player-config', []],
            ['yuki:mpv-path', []],
            ['yuki:settings-get', []],
            ['yuki:font-css', []],
            ['yuki:cache-size', []],
            ['yuki:get-logs', [1, 20, null]],
            ['yuki:file-list', ['']],
            ['yuki:file-root', []],
            ['yuki:asset-status', [false]],
            ['yuki:push-info', []],
        ];
        for (const [ch, args] of cases) {
            const h = env.handlers.get(ch);
            assert.equal(typeof h, 'function', `${ch} 应已注册`);
            const r = await h(null, ...args);
            assertSerializable(ch, r);
            // 强校验：必须能过 structuredClone（Electron IPC 的真实编码方式）
            assert.doesNotThrow(() => structuredClone(r), `${ch} 的返回值无法通过 structuredClone`);
        }
    } finally { env.dispose(); }
});

test('返回值可序列化：动作型频道（设置/日志/窗口控制）返回 {ok:...} 且可 JSON 化', async () => {
    const env = await bootEnv();
    try {
        const cases = [
            ['yuki:update-hotkeys', []],
            ['yuki:update-player-prefs', []],
            ['yuki:onboarding-done', []],
            ['yuki:clear-logs', []],
            ['yuki:clear-mpv-path', []],
            ['yuki:clear-player', []],
            ['yuki:win-minimize', []],
            ['yuki:win-maximize', []],
            ['yuki:log-renderer', ['WARN', '黑盒测试日志']],
            ['yuki:syncplay-disconnect', []],
            ['yuki:syncplay-chat', ['hi']],
            ['yuki:dlna-stop', [null]],
        ];
        for (const [ch, args] of cases) {
            const h = env.handlers.get(ch);
            assert.equal(typeof h, 'function', `${ch} 应已注册`);
            const r = await h(null, ...args);
            assert.equal(typeof r, 'object', `${ch} 应返回对象，实为 ${JSON.stringify(r)}`);
            assert.equal(typeof r.ok, 'boolean', `${ch} 应带布尔 ok 字段（渲染层统一判成功）`);
            assertSerializable(ch, r);
            assert.doesNotThrow(() => JSON.stringify(r), `${ch} 返回值无法 JSON 序列化`);
        }
    } finally { env.dispose(); }
});

test('返回值可序列化：yuki:cache-size 返回 {ok,bytes,detail} 且 bytes 为有限数', async () => {
    const env = await bootEnv();
    try {
        const r = await env.handlers.get('yuki:cache-size')(null);
        assert.equal(r.ok, true);
        assert.equal(typeof r.bytes, 'number', 'bytes 必须是数字（渲染层要做字节格式化）');
        assert.ok(Number.isFinite(r.bytes), 'bytes 不得为 NaN/Infinity');
        assert.ok(r.bytes >= 0);
        assert.equal(typeof r.detail, 'object', 'detail 供前端分类合并展示');
        assert.doesNotThrow(() => structuredClone(r), 'cache-size 返回值必须可过 IPC');
    } finally { env.dispose(); }
});

test('返回值可序列化：yuki:asset-status 五个资产位均为 {ready:boolean} 形态', async () => {
    const env = await bootEnv();
    try {
        const r = await env.handlers.get('yuki:asset-status')(null, true); // force 穿透缓存
        assertSerializable('yuki:asset-status', r);
        for (const k of ['ffmpeg', 'mpv', 'aria2', 'anime4k', 'java']) {
            assert.equal(typeof r[k], 'object', `资产位 ${k} 缺失`);
            assert.equal(typeof r[k].ready, 'boolean', `资产位 ${k}.ready 应为布尔（设置页据此渲染就绪态）`);
        }
        assert.doesNotThrow(() => structuredClone(r));
    } finally { env.dispose(); }
});

// ==================================================================
// 7. 可信发送方校验（P2-6 包装层：所有 handle 统一前置）
// ==================================================================

test('可信发送方：不可信来源的调用被拒绝（抛错而非放行）', async () => {
    const env = await bootEnv();
    try {
        const h = env.handlers.get('yuki:app-version');
        const evil = { senderFrame: { url: 'https://evil.example.com/x' }, sender: { getURL: () => 'https://evil.example.com/x' } };
        // 包装层是同步 throw（index.js:79），经 ipcMain.handle 转给渲染层即 rejection
        assert.throws(() => h(evil), /untrusted sender/,
            '外部页面调用特权频道必须被拒绝');
        // 取不到 URL（frame 瞬态 + sender 也无）同样拒绝
        const blank = { senderFrame: { url: '' }, sender: { getURL: () => '' } };
        assert.throws(() => h(blank), /untrusted sender/);
        // 拒绝信息里带通道名，便于日志定位是哪个通道被越权调用
        assert.throws(() => h(evil), /yuki:app-version/);
    } finally { env.dispose(); }
});

test('可信发送方：本应用 file:// 页面与开发态 localhost 放行', async () => {
    const env = await bootEnv();
    try {
        const h = env.handlers.get('yuki:app-version');
        const mk = (url) => ({ senderFrame: { url }, sender: { getURL: () => url } });
        assert.equal(await h(mk('file:///' + MAIN_INDEX.replace(/\\/g, '/').replace(/\/src\/main\/index\.js$/, '/src/renderer/index.html'))),
            '0.0.0-test', '本应用页面应放行');
        assert.equal(await h(mk('http://localhost:5173/')), '0.0.0-test', '开发态 dev server 应放行');
        // event 缺省（主进程内直调/单测桩）视为可信——真实 IPC 恒带 event
        assert.equal(await h(null), '0.0.0-test');
    } finally { env.dispose(); }
});

test('可信发送方：校验包装覆盖全部 handle（模块级注册的 yuki:playlist-build 也生效）', async () => {
    const env = await bootEnv();
    try {
        // yuki:playlist-build 在文件头部模块级注册（包装之后），同样应带校验
        const h = env.handlers.get('yuki:playlist-build');
        assert.equal(typeof h, 'function', '模块级注册也应进入 handler 表');
        const evil = { senderFrame: { url: 'https://evil.example.com/' }, sender: { getURL: () => 'https://evil.example.com/' } };
        assert.throws(() => h(evil), /untrusted sender/);
        const trusted = await h(null, {});
        assert.equal(trusted.ok, false, '可信调用正常进入业务逻辑（空队列结构化失败）');
        assert.equal(typeof trusted.reason, 'string');
    } finally { env.dispose(); }
});
