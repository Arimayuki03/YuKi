/**
 * IPC 可信发送方校验（isTrustedIpcSender）+ 本地文件模板 href 回归测试。
 *
 * 回归背景（2026-09 用户报告）：本地文件板块点进文件夹后全部 file-list 调用被
 * isTrustedIpcSender 拒绝（主窗 sender 理论可信、同会话 yuki:play 又通过——现有
 * 拒绝日志只记通道名，frame 现场无从排查），叠加渲染层 javascript:void(0) href
 * 被 CSP 拦成导航错误。本文件锁三道修复：
 *   1. sender.getURL 兜底：frame 瞬态不可用（导航/销毁窗口期）时改用
 *      event.sender.getURL() 作第二来源判定，两处都失败才拒绝（fail-closed 不放松：
 *      兜底 URL 必须通过同一 isLocalAppPageUrl/dev-server 判定）；
 *   2. 拒绝日志带诊断：frame=/sender=/packaged= 追加在通道名后（URL 截断 200）；
 *   3. panels.js 本地文件三处模板（buildParentItem/buildDirItem/buildFileItem）
 *      不再产出 javascript: href（源码锚定，参照 bgm-rate.test.js 写法）。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');

// ------------------------------------------------------------------
// 从 index.js 源码抽取 isTrustedIpcSender 依赖片段，在 VM 沙箱内直测
// （与 main-integration.test.js 的整文件 vm 加载互为补充：这里以最小面
// 精确驱动 frame 异常/空 URL 等桩件分支，不受整窗装配时序影响）。
// 抽取边界锚定注释行，源码结构调整时测试应显式红。
// ------------------------------------------------------------------
function extractSenderFns() {
    const start = INDEX_SRC.indexOf('function _senderUrlOf(event)');
    assert.ok(start >= 0, 'index.js 应存在 _senderUrlOf 兜底实现');
    const end = INDEX_SRC.indexOf('// 一次性包装 ipcMain.handle', start);
    assert.ok(end > start, '_senderUrlOf + isTrustedIpcSender 片段应可完整定位');
    const snippet = INDEX_SRC.slice(start, end);
    const context = {
        console: { log() {}, warn() {}, error() {} },
        URL, Error, TypeError,
        app: { isPackaged: false },
        isLocalAppPageUrl: (u) => {
            // 与主进程同语义的缩小版：file:// 指向本应用 index.html 才可信
            const APP_PAGE = 'D:/App/YuKi/resources/app.asar/renderer/index.html';
            return String(u || '').replace(/^file:\/\/\//, '').replace(/\\/g, '/').toLowerCase()
                === APP_PAGE.toLowerCase();
        },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${snippet}\n;globalThis.__FNS = { isTrustedIpcSender, _senderUrlOf };`, context,
        { filename: 'index.js#isTrustedIpcSender' });
    return context.__FNS;
}

/** 构造 IPC event 桩：frameUrl/getURL 各自可控，throwFrame/throwGet 模拟瞬态异常。 */
function makeEvent({ frameUrl, getURL, throwFrame = false, throwGet = false }) {
    const sender = {
        getURL() {
            if (throwGet) throw new Error('sender destroyed');
            return getURL;
        },
    };
    const event = {
        sender,
        get senderFrame() {
            if (throwFrame) throw new Error('frame destroyed');
            return frameUrl === undefined ? null : { url: frameUrl };
        },
    };
    return event;
}

const TRUSTED_PAGE_URL = 'file:///D:/App/YuKi/resources/app.asar/renderer/index.html';
const DEV_LOCAL_URL = 'http://localhost:5173/index.html';

// ------------------------------------------------------------------
// 1. sender.getURL 兜底分支
// ------------------------------------------------------------------
test('isTrustedIpcSender 兜底：frame 抛异常 + sender.getURL 命中本应用页面 → 通过', () => {
    const { isTrustedIpcSender } = extractSenderFns();
    const ev = makeEvent({ throwFrame: true, getURL: TRUSTED_PAGE_URL });
    assert.equal(isTrustedIpcSender(ev), true,
        'frame 瞬态不可用（导航/销毁窗口期）时 sender 仍持有真实 URL，应放行');
});

test('isTrustedIpcSender 兜底：frame 抛异常 + sender.getURL 非本应用页面 → 拒绝（fail-closed）', () => {
    const { isTrustedIpcSender } = extractSenderFns();
    for (const evil of ['file:///C:/evil/other.html', 'https://evil.example/popup.html', '']) {
        const ev = makeEvent({ throwFrame: true, getURL: evil, throwGet: evil === '' });
        assert.equal(isTrustedIpcSender(ev), false, `不可信 sender URL 应被拒绝: ${evil || '<throw>'}`);
    }
});

test('isTrustedIpcSender 兜底：frame.url 为空（frame 存在但瞬态空）同样落 sender.getURL 兜底', () => {
    const { isTrustedIpcSender } = extractSenderFns();
    assert.equal(isTrustedIpcSender(makeEvent({ frameUrl: '', getURL: TRUSTED_PAGE_URL })), true,
        'frame.url 为空不得立即拒绝：sender URL 可信则放行');
    assert.equal(isTrustedIpcSender(makeEvent({ frameUrl: '', getURL: 'https://evil.example/x' })), false,
        'frame.url 为空 + sender URL 不可信 → 拒绝');
});

test('isTrustedIpcSender 双来源都失败：frame 异常 + sender.getURL 抛异常 → 拒绝', () => {
    const { isTrustedIpcSender } = extractSenderFns();
    const ev = makeEvent({ throwFrame: true, throwGet: true });
    assert.equal(isTrustedIpcSender(ev), false, '两 URL 都拿不到必须拒绝（绝不默认放行）');
});

test('isTrustedIpcSender 语义未放松：frame/sender 一致可信照常通过，dev localhost 放行保留', () => {
    const { isTrustedIpcSender } = extractSenderFns();
    assert.equal(isTrustedIpcSender(makeEvent({ frameUrl: TRUSTED_PAGE_URL, getURL: TRUSTED_PAGE_URL })), true);
    const dev = makeEvent({ frameUrl: DEV_LOCAL_URL, getURL: DEV_LOCAL_URL });
    assert.equal(isTrustedIpcSender(dev), true, '开发模式 localhost dev server 放行不受重构影响');
    const remote = makeEvent({ frameUrl: 'https://evil.example/app.html', getURL: 'https://evil.example/app.html' });
    assert.equal(isTrustedIpcSender(remote), false, '远程页面即便 frame/sender 一致也必须拒绝');
});

// ------------------------------------------------------------------
// 2. 拒绝日志诊断（经 ipcMain.handle 覆写 wrapper 真实触发 console.warn）
// ------------------------------------------------------------------
test('拒绝日志：wrapper 拒绝时 console.warn 含 frame= 与 packaged= 诊断（且 URL 截断 200）', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-fsender-'));
    const warns = [];
    try {
        // 桩要点：renderer/index.html 不存在 → file:///…/renderer/index.html 不匹配
        // isLocalAppPageUrl → 带真实 event 的调用稳定走拒绝路径。
        const handlers = new Map();
        const app = {
            isPackaged: true,
            whenReady: () => Promise.resolve(),
            on: () => {},
            getPath: (name) => path.join(tmpRoot, String(name || 'misc')),
            quit: () => {}, exit: () => {}, relaunch: () => {},
            getVersion: () => '0.0.0-test',
            getAppPath: () => path.join(ROOT),
            requestSingleInstanceLock: () => true,
        };
        const longUrl = 'file:///' + 'a'.repeat(500);
        const evilEvent = {
            sender: { getURL: () => longUrl },
            get senderFrame() { return { url: longUrl }; },
        };
        const electron = {
            app,
            // isPackaged=true 下 RESOURCES_ROOT 等取 process.resourcesPath（index.js:329）
            resourcesPath: tmpRoot,
            BrowserWindow: class { constructor() { this.webContents = { send() {}, on() {}, setWindowOpenHandler() {} }; } on() { return this; } setMenuBarVisibility() {} loadFile() {} isDestroyed() { return false; } isMinimized() { return false; } restore() {} show() {} focus() {} close() {} hide() {} minimize() {} maximize() {} unmaximize() {} isMaximized() { return false; } },
            ipcMain: { handle: (channel, fn) => { handlers.set(channel, fn); } },
            dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 1 }), showMessageBoxSync: () => 1 },
            Notification: Object.assign(class { constructor() {} show() {} }, { isSupported: () => false }),
            nativeImage: { createEmpty: () => ({ isEmpty: () => true, addRepresentation() {}, resize() { return this; } }), createFromPath: () => ({ isEmpty: () => true }) },
            Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} },
            Menu: { buildFromTemplate: () => ({}) },
            session: { defaultSession: { setProxy: async () => {} }, fromPartition: () => ({ getCacheSize: async () => 0, clearCache: async () => {} }) },
            shell: { openPath: async () => '', openExternal: async () => {} },
        };
        const sandbox = {
            console: {
                log() {},
                warn: (...a) => warns.push(a.join(' ')),
                error() {}, info() {}, debug() {},
            },
            setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
            queueMicrotask, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
            Buffer, process,
            structuredClone, Reflect, Proxy, Symbol, Error, TypeError, RangeError,
        };
        sandbox.globalThis = sandbox;
        sandbox.window = sandbox;
        vm.createContext(sandbox);
        // isPackaged=true 下 index.js 的 RESOURCES_ROOT 取 process.resourcesPath
        //（index.js:329，buildAnime4kChain/ensureAnime4k 启动期会真实触达）
        sandbox.process = Object.create(process, { resourcesPath: { value: tmpRoot, enumerable: true } });
        const hostModule = require('module');
        const resolved = require.resolve(path.join(ROOT, 'src', 'main', 'index.js'));
        const newModule = new hostModule(resolved, null);
        newModule.paths = hostModule._nodeModulePaths(path.dirname(resolved));
        newModule.filename = resolved;
        sandbox.require = (name) => (name === 'electron' ? electron : newModule.require(name));
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
                getLogLevel: () => 'info',
                startScheduledLogCleanup: () => {},
                stopScheduledLogCleanup: () => {},
            },
            './downloader': class { constructor() { this.concurrency = 3; this.split = 5; this.dir = ''; } isAvailable() { return false; } stop() {} on() {} },
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
        const preset = (request, exportsValue) => {
            const key = hostModule._resolveFilename(request, newModule);
            const m = new hostModule(key, null);
            m.exports = exportsValue;
            m.loaded = true;
            hostModule._cache[key] = m;
            return key;
        };
        const stubKeys = [preset('electron', electron)];
        for (const [req, impl] of Object.entries(serviceStubs)) stubKeys.push(preset(req, impl));
        try {
            vm.runInContext(INDEX_SRC, sandbox, { filename: 'index.js', breakOnSigint: false });
            newModule.loaded = true;
            await new Promise((r) => setImmediate(r));
            // 任意已注册通道（file-list）：带真实 event 桩调用 → 走覆写 wrapper 拒绝路径
            const fileIpc = handlers.get('yuki:file-list');
            assert.equal(typeof fileIpc, 'function', 'yuki:file-list 应已注册');
            // wrapper 为同步 throw：显式包成 rejected promise 再交 assert.rejects
            await assert.rejects(() => Promise.resolve().then(() => fileIpc(evilEvent, '')), /untrusted sender/,
                '不可信 sender 必须被拒绝');
        } finally {
            const cacheKey = hostModule._resolveFilename('electron', newModule);
            for (const key of stubKeys) {
                if (key === cacheKey) delete hostModule._cache[key];
                else {
                    const existing = hostModule._cache[key];
                    if (existing && existing.exports && stubKeys.includes(key)) delete hostModule._cache[key];
                }
            }
        }
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
    const line = warns.find((w) => w.includes('已拒绝不可信发送方的通道调用') && w.includes('yuki:file-list'));
    assert.ok(line, '拒绝必须落 console.warn 且点名通道');
    assert.ok(/frame=/.test(line) && /sender=/.test(line) && /packaged=true/.test(line),
        `拒绝日志须含 frame/sender/packaged 诊断: ${line}`);
    // URL 截断到 200 字符：500 个 a 的长 URL 不应整段进日志
    const m = line.match(/sender=([^ ]+)/);
    assert.ok(m, 'sender= 字段应可解析');
    assert.ok(m[1].length <= 201, `URL 应截断到 200 字符，实际 ${m[1].length}`);
});

// ------------------------------------------------------------------
// 3. panels.js 本地文件模板不再含 javascript: href（源码锚定）
// ------------------------------------------------------------------
test('panels.js 本地文件三处模板不再产出 javascript:void href（CSP 导航拦截根因拔除）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'panels.js'), 'utf8');
    assert.equal(src.includes('javascript:void'), false,
        'panels.js 全文不得再出现 javascript:void（三处 file-item 模板是最后的残留点）');
    for (const [fn] of [['buildParentItem'], ['buildDirItem'], ['buildFileItem']]) {
        const start = src.indexOf(`function ${fn}(`);
        assert.ok(start >= 0, `${fn} 应存在`);
        const end = src.indexOf('\n}', start);
        const body = src.slice(start, end);
        assert.ok(!/href\s*=/.test(body), `${fn} 模板不得再带 href 属性（无 href 不产生导航）`);
        assert.match(body, /class="file-item"/, `${fn} 须保留 file-item 类（手型光标由其 CSS 提供）`);
        assert.match(body, /onclick=/, `${fn} 点击链路应保留`);
    }
});

test('common.js CSP 桥接：javascript: href 防御逻辑保留（向后兼容旧 DOM）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'common.js'), 'utf8');
    assert.ok(src.includes("href.indexOf('javascript:') === 0"),
        '桥接对 javascript: href 的改写防御必须保留，不得随 panels.js 清理一并删除');
});
