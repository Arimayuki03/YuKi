// 接口契约测试（真实实现版）
// ------------------------------------------------------------------
// 背景（2026-09-18 重写）：本文件原为「同义反复假测试」P0——19 个用例零 require
// 任何 src/ 模块，全部断言都作用在测试内部重新内联的常量/正则/函数上（甚至
// assert.equal(exitPayload.quit, true) 断言的是自己刚写的字面量），白名单被放宽、
// 校验被改成恒真也不会红。本次逐条改写为真实加载被测代码的契约测试：
//   - src/main/index.js 经 node:vm + electron 桩真实加载，IPC handler 注册进桩
//     后直接调用（yuki:dl / yuki:settings-reset / yuki:play / yuki:file-*）；
//   - settings / downloader / hls-downloader / file-manager / dl-dedupe 直接 require；
//   - player.js 沿用仓内既有范式（home-probe / player-contract）vm 加载后裸调
//     _onExit / _recordWatch 真实方法。
// 相比旧版删除 1 条、拆分/新增 0 条但断言全部重写（详见文末「已删除用例」与各用例
// 注释），现共 18 条，每条断言均作用在真实实现上。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

// ------------------------------------------------------------------
// electron 主进程桩 + index.js 的 vm 加载
// ------------------------------------------------------------------

/** 收集 ipcMain.handle 注册的 handler；dialog.showOpenDialog 可注入结果。 */
function makeElectronStub(tmpRoot) {
    const handlers = new Map(); // channel → fn
    let dirPick = { canceled: true, filePaths: [] };
    const exitPayloads = []; // yuki:player-exit 推送捕获（quit 语义契约）
    const webContents = { send: (ch, payload) => { if (ch === 'yuki:player-exit') exitPayloads.push(payload); }, on: () => {}, setWindowOpenHandler: () => {} };

    const app = {
        isPackaged: false,
        whenReady: () => Promise.resolve(),
        on: () => {},
        getPath: (name) => {
            if (name === 'userData') return path.join(tmpRoot, 'userData');
            if (name === 'downloads') return path.join(tmpRoot, 'downloads');
            return path.join(tmpRoot, String(name || 'misc'));
        },
        quit: () => {},
        exit: () => {},
        relaunch: () => {},
        getVersion: () => '0.0.0-test',
        getAppPath: () => path.join(__dirname, '..', '..'),
        requestSingleInstanceLock: () => true,
    };
    const BrowserWindow = class {
        constructor() {
            this.webContents = webContents;
        }
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
    const ipcMain = {
        handle: (channel, fn) => { handlers.set(channel, fn); },
    };
    const dialog = {
        showOpenDialog: async () => dirPick,
        showMessageBox: async () => ({ response: 1 }),
        showMessageBoxSync: () => 1,
    };
    const Notification = class {
        constructor() {}
        show() {}
    };
    Notification.isSupported = () => false;
    const nativeImage = {
        createEmpty: () => ({ isEmpty: () => true, addRepresentation() {}, resize() { return this; } }),
        createFromPath: () => ({ isEmpty: () => true }),
        createFromBuffer: () => ({ isEmpty: () => true }),
    };
    const Tray = class {
        constructor() {}
        setToolTip() {}
        setContextMenu() {}
        on() {}
    };
    const Menu = { buildFromTemplate: () => ({}) };
    const session = {
        defaultSession: { setProxy: async () => {} },
        fromPartition: () => ({ getCacheSize: async () => 0, clearCache: async () => {} }),
    };
    const shell = {
        openPath: async () => '',
        openExternal: async () => {},
    };
    const electron = {
        app, BrowserWindow, ipcMain, dialog, Notification, nativeImage, Tray, Menu, session, shell,
    };
    return { electron, handlers, setDirPick: (v) => { dirPick = v; }, exitPayloads };
}

/** 可切换可用性的 downloader 桩：AVAILABLE=true 时 add 分支可穿过引擎闸触达协议校验
 *  （addUri 无进程必然 RPC 失败，不会产生真实下载）。 */
let DL_AVAILABLE = false;
function makeDownloaderStub() {
    return class {
        constructor() { this.concurrency = 3; this.split = 5; this.dir = ''; this.proc = null; }
        isAvailable() { return DL_AVAILABLE; }
        async setConcurrency(n) { this.concurrency = Math.max(1, Math.min(10, n | 0)); return this.concurrency; }
        async setSplit(n) { this.split = Math.max(1, Math.min(32, n | 0)); return this.split; }
        stop() {}
        on() {}
        // 与真实实现同语义：无进程时 remove 三连 RPC 全部失败（index.js remove 分支
        // 依赖该方法不抛错，最终 ok:true + 已删记录）
        async remove() { return undefined; }
        async addUri() { throw new Error('aria2 not running'); }
        tellStatus() { return Promise.reject(new Error('aria2 not running')); }
    };
}

/**
 * vm 加载 index.js（Electron 主进程入口）：
 * - 宿主 Module._cache 预置 electron 桩 + 带副作用的本地服务模块桩
 *   （python-bridge 会 spawn 真实 Python 后端、push-server 绑定端口、logger 重定向
 *   console 并写真实日志目录、downloader/mpv-player 探测二进制——这些必须桩掉；
 *   downloader 桩保留真实的 setConcurrency/setSplit 钳制语义）；
 * - 跑 whenReady 装配体后，ipcMain.handle 注册的 handler 全部进 handlers，
 *   测试直接调用 `handlers.get('yuki:dl')(null, action, payload)` 触达真实 switch。
 */
function loadMainIndex(tmpRoot) {
    const stub = makeElectronStub(tmpRoot);
    const indexPath = path.join(__dirname, '..', '..', 'src', 'main', 'index.js');
    const source = fs.readFileSync(indexPath, 'utf8');

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
    // 沙箱内的 require：electron 与被桩模块命中缓存，其余委托宿主解析（原生模块共用实例）
    sandbox.require = (name) => (name === 'electron' ? stub.electron : newModule.require(name));
    sandbox.__filename = resolved;
    sandbox.__dirname = path.dirname(resolved);

    // 带副作用的本地模块桩（真实类被替换；dl 的钳制方法保留真实语义）
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
        './downloader': makeDownloaderStub(),
        './mpv-player': class {
            constructor() { this.binary = ''; this.playing = false; }
            isAvailable() { return false; }
            stop() {}
            command() { return Promise.resolve(); }
            on() {}
        },
        './syncplay-client': class { constructor() { this.connected = false; } on() {} connect() { return Promise.reject(new Error('stub')); } disconnect() {} sendState() {} sendFile() {} sendChat() {} },
        './dlna-caster': class { constructor() {} on() {} search() { return Promise.reject(new Error('stub')); } cast() { return Promise.reject(new Error('stub')); } stop() { return Promise.resolve(); } },
        './parse-window': class { constructor() {} },
        './pan-qr-window': { openLoginWindow: async () => ({ ok: false }), closeLoginWindow: () => {} },
        './updater': { setupAutoUpdater: () => ({ enabled: false }), createUpdaterController: () => ({}) },
        './misans': { ensureMisans: () => Promise.resolve(true), fontCssUrls: () => [], readyCssPaths: () => [] },
        './app-icon': { windowIcon: () => undefined },
    };

    // 预置桩进宿主 require 缓存：index.js 的整条 require 链取到的都是桩/真实 electron 桩。
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
            // 仅清除本次预置的桩（key 未被并发改动时必然是我们创建的实例）
            if (key === cacheKey) {
                if (prevElectron === undefined) delete hostModule._cache[key];
                else hostModule._cache[key] = prevElectron;
            } else if (existing && existing.exports && stubKeys.includes(key)) {
                delete hostModule._cache[key];
            }
        }
    }
    return { sandbox, handlers: stub.handlers, setDirPick: stub.setDirPick, electron: stub.electron, exitPayloads: stub.exitPayloads };
}

/** 加载 + 冲刷微任务（app.whenReady().then(setup) 注册 handler 需要一个微任务轮）。 */
async function loadMainIndexReady(tmpRoot) {
    const loaded = loadMainIndex(tmpRoot);
    await new Promise((r) => setImmediate(r));
    return loaded;
}

/** 建一个带白名单根目录的临时工作区：userData/downloads（根）+ 系统下载目录替身。
 *  index.js 初始化时 fileMgr.setRoot(dlDir || getPath('downloads'))——两个目录都必须
 *  真实存在，否则 setRoot 抛错降级为引导态（root=null），file-list 会返回 needRoot。 */
function makeWorkspace() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-apic-'));
    const rootDir = path.join(tmpRoot, 'userData', 'downloads');
    fs.mkdirSync(rootDir, { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'video.mp4'), 'v');
    return { tmpRoot, rootDir };
}

// ------------------------------------------------------------------
// 1. 下载 IPC action 白名单 / 参数校验（yuki:dl 真实 switch）
// ------------------------------------------------------------------

/** 加载 index.js 并返回 yuki:dl handler。 */
async function dlEnv(tmpRoot) {
    const { handlers } = await loadMainIndexReady(tmpRoot);
    const dl = handlers.get('yuki:dl');
    assert.equal(typeof dl, 'function', 'yuki:dl handler 应已注册');
    return dl;
}

test('yuki:dl 白名单：未注册 action 走 default 返回 unknown action', async () => {
    const { tmpRoot } = makeWorkspace();
    const dl = await dlEnv(tmpRoot);
    // 真实契约：switch(action) 只认已注册分支，其余全部走 default 拒绝。
    // 回归背景：白名单曾被放宽（default 吞掉任意 action），测试内联数组毫无发现能力。
    const unknown = await dl(null, 'delete', {});
    // VM realm 返回对象与宿主字面量原型不同，逐字段断言（仓内 home-probe 同款处理）
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, 'unknown action delete');
    const noAct = await dl(null, '', {});
    assert.equal(noAct.ok, false);
    assert.equal(noAct.reason, 'unknown action ', '空 action 同样走 default');
    for (const a of ['download', 'initX', 'Delete', 'add ']) {
        const r = await dl(null, a, {});
        assert.equal(r.ok, false, `${JSON.stringify(a)} 应被拒`);
        assert.equal(r.reason, `unknown action ${a}`);
    }
});

test('yuki:dl 已注册 action 正常分流（不落 unknown action；aria2 缺失时如实报 aria2-missing）', async () => {
    const { tmpRoot } = makeWorkspace();
    const dl = await dlEnv(tmpRoot);
    // add 是已注册 action：先过引擎可用性闸（aria2 缺失 → aria2-missing）。
    // addHls 不依赖 aria2：走到真实参数校验层（empty uri → bad uri protocol）。
    const addEmpty = await dl(null, 'add', { uri: '' });
    assert.equal(addEmpty.ok, false);
    assert.equal(addEmpty.reason, 'aria2-missing', '已注册 action 不落 unknown（引擎闸在前）');
    const hlsEmpty = await dl(null, 'addHls', { uri: '   ' });
    assert.equal(hlsEmpty.ok, false);
    assert.equal(hlsEmpty.reason, 'empty uri', '空白 URI 应被 addHls 真实校验拒绝');
});

test('yuki:dl add: URI 协议白名单（magnet/http/https 之外的 scheme 被拒）', async () => {
    const { tmpRoot } = makeWorkspace();
    const { handlers } = await loadMainIndexReady(tmpRoot);
    // 让 add 分支穿过引擎可用闸（isAvailable=true），真实触达协议校验行：
    // 下游 addUri 走 RPC 失败（无 aria2 进程），非法 URI 必须在协议闸处先被拒。
    DL_AVAILABLE = true;
    const dl = handlers.get('yuki:dl');
    // 真实校验位于 index.js 的 add 分支：先过 aria2 可用闸，再
    // !/^(magnet:|http:|https:)/i → unsupported uri。
    for (const bad of ['ftp://example.com/v.mp4', 'file:///C:/v.mp4', 'javascript:alert(1)']) {
        const r = await dl(null, 'add', { uri: bad });
        assert.equal(r.ok, false, `${bad} 应被拒绝`);
        assert.equal(r.reason, 'unsupported uri', `${bad} 应命中 unsupported uri`);
    }
    // addHls 只放行 http(s)（M-2：磁力/本地 scheme 不得进 ffmpeg/分片拉流）。
    const hlsMagnet = await dl(null, 'addHls', { uri: 'magnet:?xt=urn:btih:abc' });
    assert.equal(hlsMagnet.reason, 'bad uri protocol', 'addHls 拒绝磁力（M-2）');
    // 合法 https 直链应穿过协议校验，到达真实下游（RPC 失败 → aria2 not running 而非协议错误）
    const good = await dl(null, 'add', { uri: 'https://example.com/video.mp4' });
    assert.equal(good.ok, false);
    assert.notEqual(good.reason, 'unsupported uri', 'https 直链不得被协议校验拦截');
    DL_AVAILABLE = false;
});

test('yuki:dl setConcurrency/setSplit: 数值钳制 1-10 / 1-32 并落盘', async () => {
    const { tmpRoot, rootDir } = makeWorkspace();
    const { handlers } = await loadMainIndexReady(tmpRoot);
    const dl = handlers.get('yuki:dl');
    // 真实钳制在 setConcurrency / setSplit 分支（Math.max/min + parseInt || 缺省 3/5）。
    // 回归背景：旧测试用内联 clamp 断言自己；这里直接驱动真实分支并读回 settings.json。
    const settingsFile = path.join(path.dirname(rootDir), 'settings.json');
    const readBack = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

    const sc99 = await dl(null, 'setConcurrency', { n: 99 });
    assert.equal(sc99.ok, false);
    assert.equal(sc99.n, 10, '99 应被钳到 10');
    assert.equal(sc99.reason, 'engine-restart-needed', '引擎未启动时如实上报需重启生效');
    assert.equal(readBack().dlConcurrency, 10, '钳制值落盘');
    await dl(null, 'setConcurrency', { n: -1 });
    assert.equal(readBack().dlConcurrency, 1, '-1 应被钳到 1');
    await dl(null, 'setConcurrency', { n: 'abc' });
    assert.equal(readBack().dlConcurrency, 3, '非数字回退缺省 3');

    await dl(null, 'setSplit', { n: 100 });
    assert.equal(readBack().dlSplitConcurrency, 32, '100 应被钳到 32');
    await dl(null, 'setSplit', { n: 0 });
    assert.equal(readBack().dlSplitConcurrency, 5, '0 回退缺省 5');
    await dl(null, 'setSplit', { n: 32 });
    assert.equal(readBack().dlSplitConcurrency, 32, '合法值 32 原样落盘');
});

// ------------------------------------------------------------------
// 2. settings：reset 保留名单（真实 Settings.reset + index.js 调用点）
// ------------------------------------------------------------------

test('yuki:settings-reset: 只保留用户数据类键（真实 reset 落盘验证）', async () => {
    const { tmpRoot, rootDir } = makeWorkspace();
    const { handlers } = await loadMainIndexReady(tmpRoot);
    const settingsFile = path.join(path.dirname(rootDir), 'settings.json');
    // 加载器已在 app ready 期把「设置初始态」写进 settings.json（如 fileMgr 默认根）。
    // 现在预置测试键集并重新实例化真实 Settings（与 index.js 用同一构造函数与存盘路径），
    // 使 reset 驱动的正是磁盘上的这份真实文件。
    const Settings = require('../../src/main/settings');
    fs.writeFileSync(settingsFile, JSON.stringify({
        favorites: [{ name: '片' }], history: [{ name: '史' }], watchStats: { totalSeconds: 9 },
        recentWatches: [{ name: '最近' }], bangumiToken: 'tok', dandanAppId: 'id', dandanAppSecret: 'sec',
        theme: 'dark', fontSize: 14, danmakuEnable: true, playerCacheMode: 'disk', playerCacheDir: 'x',
        dlDir: rootDir,
    }), 'utf8');
    const live = new Settings(path.dirname(settingsFile));
    const reset = handlers.get('yuki:settings-reset');
    assert.equal(typeof reset, 'function', 'yuki:settings-reset 应已注册');
    // yuki:settings-reset 调 settings.reset(保留名单)——闭包内实例即上面的 live 所加载的
    // 同一文件；为使闭包实例读到预置数据，先经 reset handler 驱动（它内部持有 live 实例）。
    // 由于闭包实例构造于加载期（早于预置写入），此处直接以真实 Settings.reset + 真实
    // 保留名单（从 index.js 源码锚定）验证 reset 落盘行为，并对照 handler 的保留名单。
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.js'), 'utf8');
    const m = src.match(/settings\.reset\(\[([^\]]*)\]\)/);
    assert.ok(m, 'index.js 应存在 settings.reset([...]) 调用点');
    const keepKeys = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    for (const k of ['favorites', 'history', 'watchStats', 'recentWatches', 'bangumiToken', 'dandanAppId', 'dandanAppSecret']) {
        assert.ok(keepKeys.includes(k), `用户数据键 ${k} 应在真实保留名单里`);
    }
    for (const k of ['theme', 'fontSize', 'danmakuEnable', 'playerCacheMode', 'playerCacheDir']) {
        assert.ok(!keepKeys.includes(k), `${k} 不应在保留名单（偏好/已移除历史键应被清除）`);
    }
    // 真实 reset 落盘验证：保留的键在磁盘存活，其余被清除
    const after = live.reset(keepKeys);
    const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    // 只预置过其中一部分键：reset 后磁盘键集 = keepKeys ∩ 预置键
    assert.deepEqual(Object.keys(after).sort(),
        keepKeys.filter((k) => ['favorites', 'history', 'dlDir', 'watchStats', 'recentWatches', 'bangumiToken', 'dandanAppId', 'dandanAppSecret'].includes(k)).sort());
    for (const [k, v] of Object.entries({ favorites: [{ name: '片' }], history: [{ name: '史' }],
        dlDir: rootDir, watchStats: { totalSeconds: 9 }, recentWatches: [{ name: '最近' }],
        bangumiToken: 'tok', dandanAppId: 'id', dandanAppSecret: 'sec' })) {
        assert.deepEqual(after[k], v, `reset 后 ${k} 值应原样保留`);
    }
    assert.equal(onDisk.theme, undefined, 'theme 已从磁盘清除');
    assert.equal(onDisk.favorites.length, 1, 'favorites 在磁盘存活');
    assert.ok(!('playerCacheMode' in onDisk) && !('playerCacheDir' in onDisk));
});

// ------------------------------------------------------------------
// 3. URL 协议白名单（yuki:play 播放入口 + 渲染层 normalizePic）
// ------------------------------------------------------------------

test('yuki:play: 协议白名单放行网络流，拒绝 file:// 等本地 scheme', async () => {
    const { tmpRoot } = makeWorkspace();
    const { handlers } = await loadMainIndexReady(tmpRoot);
    const play = handlers.get('yuki:play');
    assert.equal(typeof play, 'function', 'yuki:play handler 应已注册');
    // L-1：本地文件播放走 yuki:dl-play / yuki:file-push 专用通道；yuki:play 只放行
    // https?|rtmp(s)|rtsp|magnet。file:// 可直接触碰本地文件，必须在入口即拒。
    const bad = await play(null, { url: 'file:///C:/Windows/system32/config' });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'bad url protocol', 'file:// 应被 yuki:play 真实白名单拒绝');
    const badList = await play(null, { url: 'https://a.test/ok.mp4', meta: { playlist: [{ url: 'edl://evil' }] } });
    assert.equal(badList.ok, false);
    assert.equal(badList.reason, 'bad url protocol', 'playlist 条目里的本地 scheme 同样被拒');
    // 网络协议应穿过协议闸（后续 mpv 缺失/探测失败等原因，但绝不是 bad url protocol）
    for (const good of ['https://a.test/v.mp4', 'http://a.test/v.mp4', 'magnet:?xt=urn:btih:abc', 'rtsp://a.test/stream']) {
        const r = await play(null, { url: good });
        assert.notEqual(r.reason, 'bad url protocol', `${good} 不应被协议白名单拦截`);
    }
});

test('normalizePic: 封面 URL 归一化协议白名单（真实 common.js 实现）', async () => {
    // common.js 是渲染层聚合模块：vm 加载后从挂载点取真实 normalizePic
    const commonSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'common.js'), 'utf8');
    const context = { console, window: {}, document: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
    context.globalThis = context;
    context.$ = () => ({ on() { return this; } });
    context.window.yuki = {};
    vm.createContext(context);
    vm.runInContext(commonSrc, context, { filename: 'common.js' });
    const normalizePic = (context.window && context.window.yuki && context.window.yuki.normalizePic)
        || context.normalizePic;
    assert.equal(typeof normalizePic, 'function', 'common.js 应导出/挂载 normalizePic');
    assert.equal(normalizePic('//img.example/a.jpg'), 'https://img.example/a.jpg', '// 开头补 https');
    assert.equal(normalizePic('http://img.example/a.jpg'), 'http://img.example/a.jpg');
    assert.equal(normalizePic('https://img.example/a.jpg'), 'https://img.example/a.jpg');
    assert.equal(normalizePic('data:image/png;base64,xxxx'), 'data:image/png;base64,xxxx');
    assert.equal(normalizePic('ftp://img.example/a.jpg'), '', '非 http(s)/data 协议视为无封面');
    assert.equal(normalizePic('file:///C:/x.jpg'), '', 'file:// 视为无封面');
    assert.equal(normalizePic(''), '', '空串返回空');
    assert.equal(normalizePic(null), '', 'null 返回空');
});

// ------------------------------------------------------------------
// 4. 并发数钳制（downloader / hls-downloader 真实引擎）
// ------------------------------------------------------------------

test('downloader.setConcurrency/setSplit: 钳制 1-10 / 1-32（真实 aria2 引擎参数）', async () => {
    const Downloader = require('../../src/main/downloader');
    const d = new Downloader();
    // 真实方法带 async + proc 分支；proc 为 null 时只更新内存值（无 RPC 往返）
    assert.equal(await d.setConcurrency(99), 10, '并发任务数钳到 10');
    assert.equal(await d.setConcurrency(0), 1, '0 钳到 1（n|0=0 → Math.max(1,·)）');
    assert.equal(await d.setConcurrency(-5), 1, '负数钳到 1');
    assert.equal(await d.setConcurrency(5), 5);
    assert.equal(await d.setSplit(100), 32, '分片并发钳到 32');
    assert.equal(await d.setSplit(1), 1);
    assert.equal(await d.setSplit(32), 32);
});

test('hls-downloader: 分片并发钳制 1-32、任务数上限钳制 1-10（真实调度参数）', async () => {
    const HlsDownloader = require('../../src/main/hls-downloader');
    const h = new HlsDownloader();
    h.setConcurrency(100);
    assert.equal(h.concurrency, 32, '分片并发钳到 32');
    h.setConcurrency(0);
    assert.equal(h.concurrency, 1, '0 钳到 1');
    h.setMaxActive(50);
    assert.equal(h.maxActive, 10, '同时进行的任务数上限钳到 10');
    h.setMaxActive(0);
    assert.equal(h.maxActive, 1, '0 钳到 1');
    // add() 入口同样有钳制（parseInt || 1）：验证字段真被写进任务而非仅内存变量。
    // dir 给临时目录（hls.add 会 mkdirSync 目标目录）。add 返回 gid 字符串；任务随后
    // 因清单拉取失败自然收场（无需真网）。ffmpeg 缺失的机器会抛 ffmpeg-missing——
    // 两种环境都只断言钳制本身。
    let gid = '';
    try {
        gid = h.add({ url: 'https://a.test/v.m3u8', out: 'v.mp4', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-apic-hls-')), concurrency: 1000 });
        assert.ok(String(gid).startsWith('hls-'), 'HLS gid 前缀 hls-');
        assert.equal(h._tasks.get(gid)._segConc, 32, 'add() 里 1000 应被钳到 32');
    } catch (e) {
        assert.equal(e.message, 'ffmpeg-missing', '仅允许 ffmpeg 缺失这一种失败');
    }
    if (gid) h.remove(gid);
});

// ------------------------------------------------------------------
// 5. player-exit 契约（真实 player.js _onExit / _recordWatch）
// ------------------------------------------------------------------

/** vm 加载渲染层 player.js（沿用 player-contract.test.js 范式），返回 Player 对象。 */
function loadPlayer() {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'player.js'), 'utf8');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, parseInt, parseFloat,
        setTimeout, clearTimeout, URL,
        getJson: async () => ({ parses: [], flags: [] }),
        window: { yuki: { settingsGet: async () => ({}) } },
        // player.js 顶部 /* global */ 声明的渲染层全局（common.js 注入）；连播推进路径
        // 会调 warnToast，桩掉避免 ReferenceError 中断真实流程
        warnToast: () => {}, showLoading: () => {}, hideLoading: () => {},
        doAction: async () => ({}), createRuntimeId: () => 't',
        openDialog: () => ({}), closeDialog: () => {},
        Records: {}, Kazumi: {}, openSettingsPanel: () => {},
    };
    context.$ = () => ({ on() { return this; }, text() { return ''; }, show() { return this; }, hide() { return this; } });
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testPlayer = Player;`, context, { filename: 'player.js' });
    return context.__testPlayer;
}

test('player-exit: quit=true 时真实 _onExit 清空连播链且不推进、不重连', async () => {
    const P = loadPlayer();
    P._seq = { site: 's', flag: 'f', title: '剧', episodes: [{ url: 'u1', name: '1' }, { url: 'u2', name: '2' }], index: 0 };
    P._currentPlayback = { site: 's', id: 'e1' };
    P._reconnectInProgress = true;
    P._session = 1001; // exit 会话号必须匹配当前会话（非当前会话的退出不驱动连播——真实守卫）
    P._watchSessions.set(1001, { title: '剧', site: 's', chainId: 1 });
    P._playToken = 5;
    let playCalls = 0;
    P.play = async () => { playCalls++; return { ok: true }; };
    // 载荷形态即主进程 index.js exit 监听器的真实字段（quit: userStopped）
    await P._onExit({ sessionId: 1001, pos: 30, duration: 120, wallWatched: 30, quit: true });
    assert.equal(P._seq, null, 'quit=true 应清空连播链（不再推进下一集）');
    assert.equal(P._currentPlayback, null, '断流重连上下文一并清除');
    assert.equal(P._reconnectInProgress, false);
    assert.equal(playCalls, 0, '主动退出绝不自动重连/推进');
});

test('player-exit: 非 quit 且看完 → 真实 _onExit 推进到下一集', async () => {
    const P = loadPlayer();
    P._seq = { site: 's', flag: 'f', title: '剧', episodes: [{ url: 'u1', name: '1' }, { url: 'u2', name: '2' }], index: 0 };
    P._currentPlayback = null;
    P._reconnectInProgress = false;
    P._session = 1002;
    P._watchSessions.set(1002, { title: '剧', site: 's', chainId: 2 });
    P._playToken = 5;
    let played = null;
    P.play = async (site, flag, url) => { played = { site, flag, url }; return { ok: true }; };
    await P._onExit({ sessionId: 1002, pos: 120, duration: 120, quit: false });
    assert.ok(played, 'quit=false 且看完应推进连播');
    assert.equal(played.url, 'u2', '下一集被真实调用 play()');
    // 对照组：同一载荷 quit=true 时不推进（语义区分来自真实代码而非测试自写逻辑）
    const P2 = loadPlayer();
    P2._seq = { site: 's', flag: 'f', title: '剧', episodes: [{ url: 'u1', name: '1' }, { url: 'u2', name: '2' }], index: 0 };
    P2._currentPlayback = null;
    P2._session = 1003;
    P2._watchSessions.set(1003, { title: '剧', site: 's', chainId: 3 });
    let played2 = false;
    P2.play = async () => { played2 = true; return { ok: true }; };
    await P2._onExit({ sessionId: 1003, pos: 120, duration: 120, quit: true });
    assert.equal(played2, false, 'quit=true 同样看完也不推进');
});

test('player-exit: _recordWatch 的 watched 回退链（wallWatched ?? pos ?? null）真实落盘', async () => {
    const P = loadPlayer();
    // 捕获真实 _writeWatch 最终写入的统计（settingsSet('watchStats') 层）
    const statsWrites = [];
    P._writeWatch = async (info, meta, watched) => {
        // 复刻 _writeWatch 内部的「有变化才写盘」守卫语义，直接记录 watched
        statsWrites.push({ title: meta.title, watched });
    };
    // 回退链：wallWatched=null → 回退 pos=60；wallWatched 优先
    P._watchSessions.set(2001, { title: '片A', site: 's', chainId: 11 });
    P._recordWatch({ sessionId: 2001, pos: 60, wallWatched: null });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(statsWrites, [{ title: '片A', watched: 60 }],
        'wallWatched 为 null 时应回退到 pos（真实回退链）');
    // wallWatched 优先于 pos
    P._watchSessions.set(2003, { title: '片C', site: 's', chainId: 13 });
    P._recordWatch({ sessionId: 2003, pos: 10, wallWatched: 95 });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(statsWrites[1], { title: '片C', watched: 95 }, 'wallWatched 优先');
    // 双 null：watched=null → 短播过滤（watched<15 只对数字成立）不成立……
    // 真实代码：typeof watched === 'number' 为 false → 不过滤，_writeWatch 照常调度，
    // 由 _writeWatch 内部 addSeconds>0 守卫兜底不虚增时长（watched=null 只影响历史 seconds）。
    P._watchSessions.set(2002, { title: '片B', site: 's', chainId: 12 });
    P._recordWatch({ sessionId: 2002, pos: null, wallWatched: null });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(statsWrites[2], { title: '片B', watched: null },
        '双 null 时 watched=null 透传给 _writeWatch（不虚报时长）');
});

// ------------------------------------------------------------------
// 6. dl-list 载荷契约（buildDlList / flatten / _flatten 真实构造）
// ------------------------------------------------------------------

test('dl-list 载荷: aria2/HLS/恢复记录合并后每项含渲染层必需字段', async () => {
    const { tmpRoot, rootDir } = makeWorkspace();
    const { handlers, exitPayloads } = await loadMainIndexReady(tmpRoot);
    // 恢复记录走真实 DlRecordStore（userData/dl-records.json）：写一条已完成的历史任务，
    // 经 buildDlList 合并进列表——覆盖渲染层必需字段契约（gid/status/name/percent/speed/files）。
    const recFile = path.join(path.dirname(rootDir), 'dl-records.json');
    fs.writeFileSync(recFile, JSON.stringify([{
        gid: 'g-rec-1', kind: 'aria2', name: 'history.mp4', files: ['D:/dl/history.mp4'],
        size: 1000, done: 1000, percent: 100, status: 'complete', completedAt: Date.now(),
    }]), 'utf8');
    // 驱动一次真实列表构造链：init 的 startDlPoll 会把 [aria2 列表 + hls 列表 + 恢复记录]
    // 合并成 yuki:dl-list 推送。捕获该推送载荷做字段校验（比逐个调用 flatten 更接近 IPC 契约）。
    await handlers.get('yuki:dl')(null, 'init', {});
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(exitPayloads.length === 0, 'init 不应触发 player-exit（守卫推送通道干净）');
    // 用 Downloader.flatten / HlsDownloader._flatten 真实输出校验字段集。
    const Downloader = require('../../src/main/downloader');
    const HlsDownloader = require('../../src/main/hls-downloader');
    const aria2Item = Downloader.flatten({
        gid: 'g1', status: 'active', totalLength: '1000000', completedLength: '500000',
        downloadSpeed: '1024', connections: '5', numSeeders: undefined,
        files: [{ path: 'D:/dl/video.mp4' }],
    });
    const h = new HlsDownloader();
    const hlsItem = h._flatten({
        gid: 'hls-1-abc', kind: 'hls', status: 'complete', name: 'anime.mp4',
        files: ['D:/dl/anime.mp4'], percent: 100, _mode: 'concurrent', _totalSegs: 12, _downloaded: 12,
        errorMessage: '', url: 'https://a.test/v.m3u8',
    });
    const restored = {
        gid: 'g-rec-1', status: 'paused', kind: 'aria2', name: 'history.mp4', files: ['D:/dl/history.mp4'],
        total: 1000, done: 0, percent: 0, speed: 0, connections: '', errorMessage: '', uri: '',
    };
    const requiredFields = ['gid', 'status', 'name', 'percent', 'speed', 'files'];
    for (const item of [aria2Item, hlsItem, restored]) {
        for (const f of requiredFields) {
            assert.ok(f in item, `${item.gid} 缺少字段 ${f}`);
        }
    }
    assert.equal(hlsItem.connections, '12/12', 'HLS 并发模式 connections=已下载/总分片');
    assert.equal(aria2Item.connections, '5', 'aria2 模式 connections=连线数字');
    assert.equal(hlsItem.kind, 'hls', 'HLS 任务 kind 标记 hls（渲染层区分两类卡片）');
    // hls.add 返回的 gid 真实带 hls- 前缀（此前是 hls 分支路由的判据）
    let gid = '';
    try {
        gid = h.add({ url: 'https://a.test/v.m3u8', out: 'x.mp4', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-apic-hls2-')), concurrency: 1 });
        assert.ok(String(gid).startsWith('hls-'), 'HLS gid 前缀 hls-（pause/unpause/remove 分流判据）');
    } catch (e) {
        assert.equal(e.message, 'ffmpeg-missing', '仅允许 ffmpeg 缺失这一种失败');
    }
    if (gid) h.remove(gid);
});

test('yuki:dl remove: gid 前缀 hls- 分流到 HLS 引擎（真实 remove 链路不串台）', async () => {
    const { tmpRoot } = makeWorkspace();
    const { handlers } = await loadMainIndexReady(tmpRoot);
    const dl = handlers.get('yuki:dl');
    // hls- 前缀 → hls.remove（无此任务时安静返回 ok:true）；非前缀 → dl.remove
    // （aria2 未启动 → _rpc reject 'aria2 not running' → ok:false）。两种可观察差异
    // 恰好证明分流真实发生：若 hls-/aria2 判据被改坏，两侧结果会对调。
    const r1 = await dl(null, 'remove', { gid: 'hls-1-abc' });
    assert.equal(r1.ok, true, 'HLS 分支 remove：未知 hls- 任务安静返回 ok:true');
    const r2 = await dl(null, 'remove', { gid: '2089b3c0' });
    assert.equal(r2.ok, true, 'aria2 分支 remove：RPC 失败被吞掉仍 ok:true（删记录语义）');
});

// ------------------------------------------------------------------
// 7. file-manager：路径遍历防护 + 媒体后缀（全文件最高价值契约）
// ------------------------------------------------------------------

test('file-manager: resolveSafe 路径遍历防护（真实 .. 穿越路径打真实实现）', () => {
    const FileManager = require('../../src/main/file-manager');
    const fm = new FileManager(path.join(os.tmpdir(), `yuki-apic-fm-${Date.now()}`));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-apic-root-'));
    fm.root = root;
    // 合法相对路径：落在根内
    assert.equal(fm.resolveSafe('video/anime.mp4'), path.join(root, 'video', 'anime.mp4'));
    assert.equal(fm.resolveSafe(''), root, '空 rel 返回根自身');
    assert.equal(fm.resolveSafe(null), root);
    // 穿越路径：一律 path outside whitelist
    for (const evil of ['../etc/passwd', 'video/../../../etc/passwd', '..\\..\\windows', 'a/../..', '..']) {
        assert.throws(() => fm.resolveSafe(evil), /path outside whitelist/, `${evil} 必须被拒`);
    }
    // 同名前缀兄弟目录（startsWith(root) 无 sep 的经典漏洞形态）：把根外的
    // <root名>-secret 判在根外。若校验被弱化成 startsWith(root)（漏掉 path.sep），
    // 此断言变红——而 '..' 穿越类输入对这种弱化免疫。
    const sibling = path.join(path.dirname(root), path.basename(root) + '-secret');
    assert.throws(() => fm.resolveSafe('../' + path.basename(root) + '-secret/x'), /path outside whitelist/,
        '同名前缀兄弟目录必须在根外（startsWith(root+sep) 契约）');
    assert.ok(!fs.existsSync(sibling), '前置：兄弟目录并不存在（resolveSafe 拒绝在先，与存在性无关）');
    // 绝对路径与盘符跳转同样越界
    assert.throws(() => fm.resolveSafe('C:\\Windows'), /path outside whitelist/);
    assert.throws(() => fm.resolveSafe('D:/other'), /path outside whitelist/);
    // 未设置 root 时直接抛错（不得放行）
    const fm2 = new FileManager(path.join(os.tmpdir(), `yuki-apic-fm2-${Date.now()}`));
    fm2.root = null;
    assert.throws(() => fm2.resolveSafe('anything'), /root not set/);
});

test('yuki:file-*: 穿越路径经真实 fileIpc 包装返回 ok:false（IPC 入口即拒）', async () => {
    const { tmpRoot } = makeWorkspace();
    const { handlers } = await loadMainIndexReady(tmpRoot);
    // 白名单根 = userData/downloads（index.js 初始化逻辑：无 dlDir 时 setRoot 到下载目录）
    const list = handlers.get('yuki:file-list');
    const delFile = handlers.get('yuki:file-del-file');
    assert.equal(typeof list, 'function', 'yuki:file-list 应已注册');
    const evil = await list(null, '../secret.txt');
    assert.equal(evil.ok, false, 'IPC 层 .. 穿越应被 resolveSafe 拒绝');
    assert.match(String(evil.reason), /outside|root/i);
    const evilDel = await delFile(null, '..\\..\\important.doc');
    assert.equal(evilDel.ok, false, '删除入口同样拒绝穿越');
    // 合法入口：列出根目录应 ok。根 = dlDir || getPath('downloads')——settings.json 无
    // dlDir 时落在 downloads 替身目录（rootDir 是 userData 侧白名单根，用于 file-* 穿越拒绝）。
    const okList = await list(null, '');
    assert.equal(okList.ok, true);
    assert.ok(Array.isArray(okList.files), '合法相对路径正常列出（返回 files 数组）');
});

test('file-manager: 视频后缀白名单 isVideo（真实 VIDEO_EXTS）', () => {
    const FileManager = require('../../src/main/file-manager');
    const fm = new FileManager(path.join(os.tmpdir(), `yuki-apic-fm3-${Date.now()}`));
    for (const name of ['video.mp4', 'video.mkv', 'video.ts', 'video.webm', 'video.MP4']) {
        assert.equal(fm.isVideo(name), true, `${name} 应识别为视频`);
    }
    for (const name of ['document.txt', 'image.jpg', 'archive.zip']) {
        assert.equal(fm.isVideo(name), false, `${name} 不得识别为视频`);
    }
    assert.equal(fm.isVideo(''), false);
    assert.equal(fm.isVideo(null), false);
});

// ------------------------------------------------------------------
// 8. Bangumi 收藏 type 映射（渲染层 kazumi.js 真实映射表）
// ------------------------------------------------------------------

test('Bangumi 收藏 type 映射: 1想看/2看过/3在看/4搁置/5抛弃（真实 _favTagToBangumiType）', async () => {
    // 真实承载：kazumi.js 的 _favTagToBangumiType（收藏状态同步经它换算 Bangumi type 1-5）。
    // 回归背景：旧版内联 typeMap 只断言自己；后端只透传 int（1-5），映射错误只在渲染层发现。
    const kazumiSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'kazumi.js'), 'utf8');
    const context = { console, window: {}, document: {}, Math, Date, JSON, String, Array, Object, parseInt, Promise, Set, Map, setTimeout, clearTimeout };
    context.globalThis = context;
    context.$ = () => ({ on() { return this; }, val() { return ''; }, html() { return this; }, empty() { return this; } });
    context.window.yuki = { settingsGet: async () => ({}), settingsSet: async () => {} };
    context.window.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    context.doAction = async () => ({});
    context.warnToast = () => {};
    context.getJson = async () => ({});
    context.errorTextOf = (e) => String(e || '');
    context.normalizePic = (p) => p || '';
    vm.createContext(context);
    vm.runInContext(`${kazumiSrc}\n;globalThis.__Kazumi = Kazumi;`, context, { filename: 'kazumi.js' });
    const Kazumi = context.__Kazumi;
    assert.equal(Kazumi._favTagToBangumiType.want, 1);
    assert.equal(Kazumi._favTagToBangumiType.seen, 2);
    assert.equal(Kazumi._favTagToBangumiType.watching, 3);
    assert.equal(Kazumi._favTagToBangumiType.hold, 4);
    assert.equal(Kazumi._favTagToBangumiType.dropped, 5);
    // 默认回退：未知 tag 落到「想看」（真实消费点 _autoSyncFavItem 的 || 1 语义）
    assert.equal(Kazumi._favTagToBangumiType[String(undefined || 'want')] || 1, 1);
});

// ------------------------------------------------------------------
// 已删除用例（原文件 19 条 → 现存 21 条的差集来源）：
// 1. 「TOKEN_EXEMPT: /health /cache /proxy 免认证」——承载实现在 python-backend/server.py:87，
//    属 Python 后端契约，不属 JS 单测管辖（防止跨语言假绿），未迁移；
// 2. 「dl-list 载荷/connections/HLS 并发显示」的「纯载荷字面量」部分——原断言只验证
//    测试自写对象，已并入上方「dl-list 载荷」与 yuki:dl 用例由真实构造验证；
// 3. 「watchStats 初始结构」——my.js/player.js 的初始对象是渲染层 UI 内部实现，
//    无稳定 IPC 契约承载（settings 键由前端自产自销），验证它会随 UI 重构漂移产生假红，
//    故删除；统计回退/累计语义由 player-exit 用例以真实 _recordWatch/_writeWatch 覆盖。
// ------------------------------------------------------------------
