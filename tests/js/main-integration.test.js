// 组件测试：主进程集成收口（index.js 闭包内注册的 handler，经 api-contract.test.js
// 同款 vm 加载范式真实触达；hls-downloader 广告过滤接线按纯函数契约验证）。
// 覆盖三处跨模块衔接：
//   ① yuki:settings-set 白名单放行 opEdSkip（player.js 跳片头开关的持久化通道）；
//   ② 弹幕门控接线：settings 键 danmakuEnable → mpv.danmakuEnabled
//     （启动初始化 + yuki:update-player-prefs 热同步）；
//   ③ 下载链路广告过滤：adFilter=true 时启发式过滤（filterAdBlocks）参与
//     临时播放列表产出（_applyAdFilter 的可观测契约）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

// ---- index.js vm 加载（与 api-contract.test.js 同款 electron/服务桩） ----

function makeElectronStub(tmpRoot) {
    const handlers = new Map();
    const app = {
        isPackaged: false,
        whenReady: () => Promise.resolve(),
        on: () => {},
        getPath: (name) => path.join(tmpRoot, String(name || 'misc')),
        quit: () => {}, exit: () => {}, relaunch: () => {},
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
        hide() {}
        minimize() {}
        maximize() {}
        unmaximize() {}
        isMaximized() { return false; }
    };
    BrowserWindow.getAllWindows = () => [];
    const ipcMain = { handle: (channel, fn) => { handlers.set(channel, fn); } };
    const dialog = {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
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
    return { electron, handlers };
}

/**
 * 可记录赋值的 mpv-player 桩：danmakuEnabled 接线断言的观测点。
 * opts.playing / opts.timePos 供 yuki:player 'get-pos' 契约用例控制会话态：
 * timePos=null 模拟「未起播/属性不可用」，主进程必须回 pos:null 而非报错。
 */
function makeMpvStub(opts = {}) {
    return class MpvStub {
        constructor() {
            this.binary = ''; this.playing = !!opts.playing;
            this.danmakuEnabled = false; // 与真实 mpv-player.js 默认值一致
            this._timePos = (opts.timePos === undefined) ? null : opts.timePos;
            this._timePosReads = 0; // get-pos 不得在无会话时触碰 getTimePos（观测点）
        }
        isAvailable() { return false; }
        stop() {}
        command() { return Promise.resolve(); }
        on() {}
        /** get-pos 契约：返回当前播放位置（秒）或 null */
        getTimePos() { this._timePosReads += 1; return this._timePos; }
        setPause(v) { this._paused = !!v; return Promise.resolve(); }
    };
}

function loadMainIndex(tmpRoot, mpvStubClass) {
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
    sandbox.require = (name) => (name === 'electron' ? stub.electron : newModule.require(name));
    sandbox.__filename = resolved;
    sandbox.__dirname = path.dirname(resolved);
    // mpv 桩实例观测点：index.js 模块级 `const mpv = new MpvPlayer()` 的产物
    // 挂到沙箱上，供接线断言直接读取（danmakuEnabled 的当前值）。
    sandbox.__yukiMpv = null;
    sandbox.__MpvStubClass = mpvStubClass;

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
        './downloader': class { constructor() { this.concurrency = 3; this.split = 5; this.dir = ''; } isAvailable() { return false; } async setConcurrency(n) { return n | 0; } async setSplit(n) { return n | 0; } stop() {} on() {} },
        // mpv 桩经沙箱取真实传入的类（每次加载新建），constructor 把实例登记到沙箱观测点
        './mpv-player': function () {
            const Cls = sandbox.__MpvStubClass;
            const inst = new Cls();
            sandbox.__yukiMpv = inst;
            return inst;
        },
        './syncplay-client': class { constructor() { this.connected = false; } on() {} connect() { return Promise.reject(new Error('stub')); } disconnect() {} sendState() {} sendFile() {} sendChat() {} },
        './dlna-caster': class { constructor() {} on() {} search() { return Promise.reject(new Error('stub')); } cast() { return Promise.reject(new Error('stub')); } stop() { return Promise.resolve(); } },
        './parse-window': class { constructor() {} },
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
    // 记录 mpv 桩实例（constructor 里 app.whenReady 前创建，经 class 闭包捕获）
    try {
        vm.runInContext(source, sandbox, { filename: 'index.js', breakOnSigint: false });
        newModule.loaded = true;
    } finally {
        for (const key of stubKeys) {
            const existing = hostModule._cache[key];
            if (key === hostModule._resolveFilename('electron', newModule)) {
                delete hostModule._cache[key];
            } else if (existing && existing.exports && stubKeys.includes(key)) {
                delete hostModule._cache[key];
            }
        }
    }
    return { sandbox, handlers: stub.handlers };
}

async function loadMainIndexReady(tmpRoot, mpvStubClass) {
    const loaded = loadMainIndex(tmpRoot, mpvStubClass);
    await new Promise((r) => setImmediate(r));
    return loaded;
}

// ------------------------------------------------------------------
// ① yuki:settings-set 白名单放行 opEdSkip
// ------------------------------------------------------------------

test('yuki:settings-set: opEdSkip 不再 ignored（player.js 跳片头开关可持久化）', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-intg-'));
    try {
        const { handlers } = await loadMainIndexReady(tmpRoot, makeMpvStub());
        const set = handlers.get('yuki:settings-set');
        assert.equal(typeof set, 'function', 'yuki:settings-set handler 应已注册');
        // 开关双向写入均须真实落盘（此前 opEdSkip 不在白名单被静默 ignored）
        const on = await set(null, 'opEdSkip', true);
        assert.equal(on.ignored, undefined, 'true 写入不应被忽略');
        assert.equal(on.value, true);
        const off = await set(null, 'opEdSkip', false);
        assert.equal(off.ignored, undefined, 'false 写入不应被忽略（用户关不掉跳片头的直接症状）');
        assert.equal(off.value, false);
        // settings-get 回读一致（真实 Settings 实例落盘）
        const all = await handlers.get('yuki:settings-get')();
        assert.equal(all.opEdSkip, false);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------------
// ② danmakuEnable → mpv.danmakuEnabled 接线
// ------------------------------------------------------------------

test('danmakuEnable 接线：启动初始化读取设置注入 mpv.danmakuEnabled', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-intg-'));
    try {
        // 预置已开启弹幕的 settings.json（启动初始化路径的真实输入）
        const userData = path.join(tmpRoot, 'userData');
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(path.join(userData, 'settings.json'),
            JSON.stringify({ danmakuEnable: true }), 'utf8');
        const { sandbox } = await loadMainIndexReady(tmpRoot, makeMpvStub());
        assert.equal(sandbox.__yukiMpv.danmakuEnabled, true,
            '启动初始化应把 danmakuEnable=true 同步到 mpv.danmakuEnabled');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('danmakuEnable 接线：默认（无设置）保持 mpv.danmakuEnabled=false；关闭值 false 同样关闭', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-intg-'));
    try {
        const { sandbox } = await loadMainIndexReady(tmpRoot, makeMpvStub());
        assert.equal(sandbox.__yukiMpv.danmakuEnabled, false,
            '默认态（键缺省）弹幕门控必须关闭');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('danmakuEnable 接线：yuki:update-player-prefs 热同步设置页开关改动', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-intg-'));
    try {
        const { handlers, sandbox } = await loadMainIndexReady(tmpRoot, makeMpvStub());
        const prefs = handlers.get('yuki:update-player-prefs');
        assert.equal(typeof prefs, 'function');
        assert.equal(sandbox.__yukiMpv.danmakuEnabled, false);
        // 渲染层设置页路径：settings-set 开启 → update-player-prefs 热同步
        await handlers.get('yuki:settings-set')(null, 'danmakuEnable', true);
        await prefs(null);
        assert.equal(sandbox.__yukiMpv.danmakuEnabled, true, '开启后热同步为 true');
        await handlers.get('yuki:settings-set')(null, 'danmakuEnable', false);
        await prefs(null);
        assert.equal(sandbox.__yukiMpv.danmakuEnabled, false, '关闭后热同步为 false');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------------
// ②' yuki:player 'get-pos' 契约（渲染层真实位置估算的位置来源）
// ------------------------------------------------------------------

// 契约：{ ok: true, pos: <秒(浮点)|null> }——「拿不到位置」不是错误。
// pos 来源：mpv time-pos（秒，浮点）；无会话/未起播/属性不可用 → pos=null。
test("yuki:player 'get-pos'：播放中返回 { ok:true, pos }（秒，浮点）", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-intg-'));
    try {
        const { handlers } = await loadMainIndexReady(tmpRoot,
            makeMpvStub({ playing: true, timePos: 1234.56 }));
        const player = handlers.get('yuki:player');
        assert.equal(typeof player, 'function', "yuki:player handler 应已注册（get-pos 与控制类 cmd 同一分发表）");
        // vm 沙箱返回值跨 realm，deepEqual 会因原型不同误报——逐字段断言契约形态
        const r = await player(null, 'get-pos');
        assert.deepEqual(Object.keys(r).sort(), ['ok', 'pos'], '契约字段必须恰为 ok + pos');
        assert.equal(r.ok, true);
        assert.equal(r.pos, 1234.56, 'pos 为当前 time-pos 秒数（浮点原样透传）');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test("yuki:player 'get-pos'：未播放时返回 { ok:true, pos:null }，不触碰播放器", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-intg-'));
    try {
        const { handlers, sandbox } = await loadMainIndexReady(tmpRoot,
            makeMpvStub({ playing: false, timePos: 77.7 }));
        const r = await handlers.get('yuki:player')(null, 'get-pos');
        assert.equal(r.ok, true, '无会话/未起播按「无位置」返回 ok:true，而非 ok:false 报错');
        assert.equal(r.pos, null, 'pos=null 表示拿不到位置');
        assert.equal(sandbox.__yukiMpv._timePosReads, 0,
            '未播放时不得读取播放器位置（主进程侧先判 playing 再取值）');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test("yuki:player 'get-pos'：位置属性不可用（getTimePos=null）同样返回 pos:null", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-intg-'));
    try {
        const { handlers } = await loadMainIndexReady(tmpRoot,
            makeMpvStub({ playing: true, timePos: null }));
        const r = await handlers.get('yuki:player')(null, 'get-pos');
        assert.equal(r.ok, true);
        assert.equal(r.pos, null, '属性不可用按无位置处理，渲染层据此降级');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test("yuki:player：既有控制类 cmd 分发不受 get-pos 分支影响（pause 照常）", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-intg-'));
    try {
        const { handlers, sandbox } = await loadMainIndexReady(tmpRoot,
            makeMpvStub({ playing: true, timePos: 5 }));
        const r = await handlers.get('yuki:player')(null, 'pause');
        assert.equal(r.ok, true);
        assert.equal(sandbox.__yukiMpv._paused, true, 'pause 仍走 setPause 原链路');
        const unknown = await handlers.get('yuki:player')(null, 'no-such-cmd');
        assert.equal(unknown.ok, false);
        assert.equal(unknown.reason, 'unknown cmd');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test("get-pos 接线源码锚定：preload playerControl 透传（无 cmd 白名单）+ yuki:player 分发 get-pos", () => {
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'preload', 'preload.js'), 'utf8');
    assert.ok(/playerControl:\s*\(cmd,\s*value\)\s*=>\s*ipcRenderer\.invoke\('yuki:player',\s*cmd,\s*value\)/.test(preloadSrc),
        'preload 必须原样透传 cmd 给 yuki:player（新增 cmd 无需改 preload 白名单）');
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.js'), 'utf8');
    assert.ok(mainSrc.includes("cmd === 'get-pos'"), "主进程分发处必须识别 'get-pos'");
    assert.ok(mainSrc.includes('mpv.getTimePos()'), '取值必须走 mpv-player.getTimePos()（观察缓存+实时查询）');
});

// ------------------------------------------------------------------
// ③ 下载链路广告过滤接线（_parsePlaylist 的 adFilter 分支）
// ------------------------------------------------------------------

test('下载链路：_parsePlaylist adFilter=true 时启发式过滤参与分片解析产出', async () => {
    const HlsDownloader = require('../../src/main/hls-downloader');
    // 无 CUE 标记、纯 DISCONTINUITY 广告块：旧 filterAdSegments 抓不到，
    // 必须经 filterAdBlocks 才会从解析产出中剔除
    const pl = [
        '#EXTM3U',
        '#EXTINF:10.0,', 'http://hls.test/seg-01.ts',
        '#EXTINF:10.0,', 'http://hls.test/seg-02.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:5.0,', 'http://ad.cdn/ad/01.ts',
        '#EXTINF:5.0,', 'http://ad.cdn/ad/02.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:10.0,', 'http://hls.test/seg-03.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({
        ok: true, status: 200,
        text: async () => (String(url) === 'http://hls.test/pl.m3u8' ? pl : ''),
        arrayBuffer: async () => Buffer.from(pl, 'utf8'),
    });
    try {
        const self = { _segsDir: '' };
        const off = await HlsDownloader.prototype._parsePlaylist.call(self, 'http://hls.test/pl.m3u8', null, false);
        assert.equal(off.segments.length, 5, '关闭 adFilter：广告分片照常进队列');
        const on = await HlsDownloader.prototype._parsePlaylist.call(self, 'http://hls.test/pl.m3u8', null, true);
        assert.equal(on.segments.length, 3, '开启 adFilter：跨 host 广告块被剔除');
        assert.ok(on.segments.every((s) => !s.url.includes('ad.cdn')), '队列中不应残留广告分片');
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('下载链路：_parsePlaylist adFilter=true 且无广告时分片产出与关闭态一致（不过滤不错杀）', async () => {
    const HlsDownloader = require('../../src/main/hls-downloader');
    const pl = [
        '#EXTM3U',
        '#EXTINF:10.0,', 'http://hls.test/seg-01.ts',
        '#EXTINF:10.0,', 'http://hls.test/video/ad-01.ts',
        '#EXTINF:10.0,', 'http://hls.test/seg-03.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true, status: 200,
        text: async () => pl,
        arrayBuffer: async () => Buffer.from(pl, 'utf8'),
    });
    try {
        const self = { _segsDir: '' };
        const off = await HlsDownloader.prototype._parsePlaylist.call(self, 'http://hls.test/pl.m3u8', null, false);
        const on = await HlsDownloader.prototype._parsePlaylist.call(self, 'http://hls.test/pl.m3u8', null, true);
        assert.deepEqual(on.segments, off.segments, '证据不足的路径分片不受过滤影响');
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('下载链路：_applyAdFilter 写临时播放列表（过滤产物落盘供 ffmpeg 输入）', async () => {
    const HlsDownloader = require('../../src/main/hls-downloader');
    const fsMod = require('node:fs');
    const osMod = require('node:os');
    const pathMod = require('node:path');
    const tmpDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'yuki-adt-'));
    const dest = pathMod.join(tmpDir, 'video.mp4');
    try {
        const pl = [
            '#EXTM3U',
            '#EXTINF:10.0,', 'http://hls.test/seg-01.ts',
            '#EXTINF:10.0,', 'http://hls.test/seg-02.ts',
            '#EXT-X-DISCONTINUITY',
            '#EXTINF:5.0,', 'http://ad.cdn/ad/01.ts',
            '#EXTINF:5.0,', 'http://ad.cdn/ad/02.ts',
            '#EXT-X-DISCONTINUITY',
            '#EXTINF:10.0,', 'http://hls.test/seg-03.ts',
            '#EXT-X-ENDLIST',
        ].join('\n');
        const origFetch = globalThis.fetch;
        let task = null;
        globalThis.fetch = async (url) => ({
            ok: true, status: 200,
            text: async () => (String(url) === 'http://hls.test/pl.m3u8' ? pl : ''),
            arrayBuffer: async () => Buffer.from(pl, 'utf8'),
        });
        try {
            task = { url: 'http://hls.test/pl.m3u8', header: null, name: 'video', _dest: dest, _adTemp: null, _input: null, adRemoved: 0, adRemovedSec: 0 };
            await HlsDownloader.prototype._applyAdFilter.call({ }, task);
            assert.ok(task._adTemp, '过滤命中应写临时播放列表');
            assert.equal(task._input, task._adTemp, 'ffmpeg 输入应指向临时清单');
            assert.equal(task.adRemoved, 2);
            const written = fsMod.readFileSync(task._adTemp, 'utf8');
            assert.ok(!written.includes('ad.cdn'), '临时清单不含广告分片');
            assert.ok(written.includes('seg-01'), '临时清单保留正片');
        } finally {
            globalThis.fetch = origFetch;
            if (task._adTemp) fsMod.rmSync(task._adTemp, { force: true });
        }
    } finally {
        fsMod.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('danmakuEnable 接线：源码锚定两处同步点（启动初始化 + update-player-prefs）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.js'), 'utf8');
    const writes = src.split('\n').filter((l) => l.includes('mpv.danmakuEnabled ='));
    assert.ok(writes.length >= 2, '至少存在启动初始化与热同步两处赋值');
    // 语义锚定：只接受 === true 比较的严格布尔（非 true 一律关闭，防真值误放行）
    for (const line of writes) {
        assert.ok(/mpv\.danmakuEnabled = settings\.get\('danmakuEnable'\) === true/.test(line),
            `赋值须来自设置键严格比较: ${line.trim()}`);
    }
});
