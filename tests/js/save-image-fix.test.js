'use strict';
// B：图片保存失败修复。根因（复现见第 1 组用例）：详情 hero 封面/评论图等经
// bangumiCoverImg 代理链渲染，浮层里的 src 是应用自己的本地代理 URL
// （http://127.0.0.1:<port>/kazumi/cover?token=…&url=<原始地址>）；保存时该 URL
// 原样交主进程，被 L12 私网拦截判成 private-address → 用户永远只看到「保存图片失败」。
// 本文件用真实代码（src/main/index.js 经 node:vm + electron 桩加载，handler 直接调用；
// 渲染层 detail.js 经 vm 加载调真实方法）验证：
//   ① 复现：loopback 代理 URL 直交主进程 → private-address，且不发起任何请求；
//   ② 修复：渲染层 _unwrapCoverProxyUrl 拆回原始远程 URL → 主进程取流写盘成功；
//   ③ 私网/保留地址门槛（含等价写法）、重定向逐跳校验、非 2xx/类型/体积/取消语义；
//   ④ 保存失败文案按 reason 可诊断（区分网络/非图片/权限/取消）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

// ------------------------------------------------------------------
// electron 桩 + index.js 的 vm 加载（照抄 api-contract.test.js 范式，
// 追加 dialog.showSaveDialog 与沙箱 fetch 注入）
// ------------------------------------------------------------------

function makeElectronStub(tmpRoot) {
    const handlers = new Map();
    let savePick = { canceled: true, filePath: '' };
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
    const webContents = { send() {}, on: () => {}, setWindowOpenHandler: () => {} };
    const BrowserWindow = class { constructor() { this.webContents = webContents; }
        on() { return this; } setMenuBarVisibility() {} loadFile() {} isDestroyed() { return false; }
        isMinimized() { return false; } restore() {} show() {} focus() {} close() {} hide() {}
        minimize() {} maximize() {} unmaximize() {} isMaximized() { return false; } };
    BrowserWindow.getAllWindows = () => [];
    const ipcMain = { handle: (ch, fn) => { handlers.set(ch, fn); } };
    const dialog = {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => savePick,
        showMessageBox: async () => ({ response: 1 }),
        showMessageBoxSync: () => 1,
    };
    const Notification = class { constructor() {} show() {} };
    Notification.isSupported = () => false;
    const nativeImage = {
        createEmpty: () => ({ isEmpty: () => true, addRepresentation() {}, resize() { return this; } }),
        createFromPath: () => ({ isEmpty: () => true }),
        createFromBuffer: () => ({ isEmpty: () => true }),
    };
    const Tray = class { constructor() {} setToolTip() {} setContextMenu() {} on() {} };
    const session = { defaultSession: { setProxy: async () => {} }, fromPartition: () => ({ getCacheSize: async () => 0, clearCache: async () => {} }) };
    const shell = { openPath: async () => '', openExternal: async () => {} };
    return {
        electron: { app, BrowserWindow, ipcMain, dialog, Notification, nativeImage, Tray, Menu: { buildFromTemplate: () => ({}) }, session, shell },
        handlers,
        setSavePick: (v) => { savePick = v; },
    };
}

/** vm 加载 index.js：带副作用的本地服务模块全部桩掉（同 api-contract.test.js）。 */
function loadMainIndex(tmpRoot, sandboxExtra) {
    const stub = makeElectronStub(tmpRoot);
    const indexPath = path.join(__dirname, '..', '..', 'src', 'main', 'index.js');
    const source = fs.readFileSync(indexPath, 'utf8');
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask,
        URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder,
        Buffer, process, structuredClone, Reflect, Proxy, Symbol, Error, TypeError, RangeError,
    };
    Object.assign(sandbox, sandboxExtra || {});
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
        './downloader': class { constructor() {} isAvailable() { return false; } on() {} stop() {} },
        './mpv-player': class { constructor() { this.binary = ''; } isAvailable() { return false; } stop() {} command() { return Promise.resolve(); } on() {} },
        './syncplay-client': class { constructor() {} on() {} connect() { return Promise.reject(new Error('stub')); } disconnect() {} sendState() {} sendFile() {} sendChat() {} },
        './dlna-caster': class { constructor() {} on() {} search() { return Promise.reject(new Error('stub')); } cast() { return Promise.reject(new Error('stub')); } stop() { return Promise.resolve(); } },
        './parse-window': class { constructor() {} },
        './pan-qr-window': { openLoginWindow: async () => ({ ok: false }), closeLoginWindow: () => {} },
        './updater': { setupAutoUpdater: () => ({ enabled: false }), createUpdaterController: () => ({}) },
        './misans': { ensureMisans: () => Promise.resolve(true), fontCssUrls: () => [], readyCssPaths: () => [] },
        './app-icon': { windowIcon: () => undefined },
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
    for (const [req, impl] of Object.entries(serviceStubs)) stubKeys.push(preset(req, impl));
    try {
        vm.runInContext(source, sandbox, { filename: 'index.js' });
        newModule.loaded = true;
    } finally {
        for (const key of stubKeys) {
            if (key === cacheKey) {
                if (prevElectron === undefined) delete hostModule._cache[key];
                else hostModule._cache[key] = prevElectron;
            } else if (hostModule._cache[key]) {
                delete hostModule._cache[key];
            }
        }
    }
    return stub;
}

/** 伪造 Response：headers/body 都可流式读（handler 走 for-await 限流分支）。 */
function mkRes({ status = 200, headers = {}, body = [] } = {}) {
    const hmap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const chunks = body.map((c) => Buffer.from(c));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k) => (hmap.has(String(k).toLowerCase()) ? hmap.get(String(k).toLowerCase()) : null) },
        body: (async function* () { for (const c of chunks) yield c; })(),
        arrayBuffer: async () => Buffer.concat(chunks),
    };
}

/** 加载 index.js 并返回 { save, fetchCalls, setSavePick, tmpRoot }。 */
async function saveEnv(script) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-saveimg-'));
    const fetchCalls = [];
    const fetchStub = async (u, opts) => {
        fetchCalls.push({ url: String(u), headers: (opts && opts.headers) || {}, redirect: opts && opts.redirect });
        return script(String(u), opts);
    };
    const stub = loadMainIndex(tmpRoot, { fetch: fetchStub });
    await new Promise((r) => setImmediate(r)); // whenReady().then(setup) 装配
    const save = stub.handlers.get('yuki:save-image');
    assert.equal(typeof save, 'function', 'yuki:save-image handler 应已注册');
    return { save, fetchCalls, setSavePick: stub.setSavePick, tmpRoot };
}

/** vm 加载 detail.js（只取静态方法/pure 逻辑所需的全局）。 */
function loadDetail() {
    const source = read('src/renderer/js/detail.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, URL, URLSearchParams,
        parseInt, parseFloat, setTimeout, clearTimeout, setInterval, clearInterval,
        Uint8Array, btoa, fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
        navigator: {},
        document: {
            _els: {},
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } }, children: [], appendChild(c) { this.children.push(c); }, _byId: {} },
            getElementById() { return null; },
            createElement() { return { style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, appendChild(c) { return c; } }; },
        },
        $: () => ({ on() { return this; }, off() { return this; }, html() { return this; }, find() { return this; }, length: 0 }),
        registerEsc: () => {}, staggerEnter: () => {}, replayClass: () => {},
        escHtml: (s) => String(s), stripHtml: (s) => String(s || ''),
        warnToast: (m) => { context._toasts.push(m); },
        showLoading() {}, hideLoading() {},
        bangumiCover: () => '', vodCoverImg: () => '', normalizePic: (p) => p || '', abortCoverFill: () => {},
        localCacheGet: () => null, localCacheSet: () => {}, localCacheDel: () => {},
        openDialog: () => {}, closeDialog: () => {},
        fmtCommentTimeFull: () => '', commentTsMs: () => 0,
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
        _toasts: [],
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    return { Detail: vm.runInContext('Detail', context), context };
}

// 1x1 PNG（真实可解码字节，仅用于字节级写盘断言）
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==', 'base64');

// ------------------------------------------------------------------
// 1. 根因复现：本地封面代理 URL 直交主进程 → private-address（不发请求）
// ------------------------------------------------------------------

test('根因复现：本地封面代理 URL（127.0.0.1/kazumi/cover）被 SSRF 门槛拒绝且不发请求', async () => {
    const { save, fetchCalls, setSavePick, tmpRoot } = await saveEnv(() => mkRes({ headers: { 'content-type': 'image/png' }, body: [PNG_1PX] }));
    const out = path.join(tmpRoot, 'out.png');
    setSavePick({ canceled: false, filePath: out });
    const proxyUrl = 'http://127.0.0.1:34567/kazumi/cover?token=tok123&url='
        + encodeURIComponent('https://lain.bgm.tv/pic/cover/l/aa/bb/1_x.jpg');
    const r = await save(null, proxyUrl, 'cover.jpg');
    // 修复前：浮层 src 就是这个代理 URL，保存必然走到这里失败（用户只看到「保存图片失败」）
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'private-address', 'loopback 代理 URL 被私网门槛拦下（原始失败形态）');
    assert.equal(fetchCalls.length, 0, '拒绝发生在发请求前（不构成私网探测）');
    assert.equal(fs.existsSync(out), false, '失败不留半截文件');
});

// ------------------------------------------------------------------
// 2. 修复验证：渲染层拆回原始远程 URL → 主进程取流写盘成功
// ------------------------------------------------------------------

test('修复：_unwrapCoverProxyUrl 拆回原始远程 URL，主进程以 origin 取流并落盘', async () => {
    const { save, fetchCalls, setSavePick, tmpRoot } = await saveEnv(() => mkRes({ headers: { 'content-type': 'image/png' }, body: [PNG_1PX] }));
    const { Detail } = loadDetail();
    const origin = 'https://lain.bgm.tv/pic/cover/l/aa/bb/1_x.jpg';
    const proxyUrl = 'http://127.0.0.1:34567/kazumi/cover?token=tok123&url=' + encodeURIComponent(origin);
    const unwrapped = Detail._unwrapCoverProxyUrl(proxyUrl);
    assert.equal(unwrapped, origin, '代理 URL 必须拆回 url 参数里的原始地址');
    const out = path.join(tmpRoot, '1_x.jpg');
    setSavePick({ canceled: false, filePath: out });
    const r = await save(null, unwrapped, '1_x.jpg');
    assert.equal(r.ok, true, '拆回后正常保存');
    assert.equal(r.path, out);
    assert.deepEqual(fs.readFileSync(out), PNG_1PX, '落盘字节与响应体一致');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, origin, '请求的是原始远程 URL 而非本地代理');
    assert.equal(fetchCalls[0].redirect, 'manual', '重定向手动跟随（逐跳校验 host）');
    assert.match(String(fetchCalls[0].headers.Referer), /^https:\/\/lain\.bgm\.tv\/$/, '带目标源 Referer（防 CDN 防盗链 403）');
});

test('_unwrapCoverProxyUrl：只拆本机回环上的 /kazumi/cover，其它形态原样返回', () => {
    const { Detail } = loadDetail();
    const inner = 'https://lain.bgm.tv/pic/cover/l/a.jpg';
    // 非回环 host 的同名路径：不是本应用后端，不拆
    assert.equal(Detail._unwrapCoverProxyUrl(`https://evil.test/kazumi/cover?url=${encodeURIComponent(inner)}`), `https://evil.test/kazumi/cover?url=${encodeURIComponent(inner)}`);
    // 回环但非 /kazumi/cover 路径：不拆
    assert.equal(Detail._unwrapCoverProxyUrl('http://127.0.0.1:34567/other'), 'http://127.0.0.1:34567/other');
    // 内层不是 http(s)（借道绕过尝试）：不拆，原样交主进程再拦一道
    const fileInner = 'http://127.0.0.1:34567/kazumi/cover?url=' + encodeURIComponent('file:///C:/x.jpg');
    assert.equal(Detail._unwrapCoverProxyUrl(fileInner), fileInner);
    // 普通图片 URL / data: / 空值：原样
    assert.equal(Detail._unwrapCoverProxyUrl(inner), inner);
    assert.equal(Detail._unwrapCoverProxyUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
    assert.equal(Detail._unwrapCoverProxyUrl(''), '');
    assert.equal(Detail._unwrapCoverProxyUrl(null), '');
});

// ------------------------------------------------------------------
// 3. 私网/保留地址门槛（含等价写法）与正常 CDN 不误伤
// ------------------------------------------------------------------

test('SSRF 门槛：私网/环回/保留地址的字面量与等价写法一律拒绝', async () => {
    const { save, fetchCalls, setSavePick, tmpRoot } = await saveEnv(() => mkRes({ headers: { 'content-type': 'image/png' }, body: [PNG_1PX] }));
    setSavePick({ canceled: false, filePath: path.join(tmpRoot, 'x.jpg') });
    const bad = [
        'http://localhost/x.jpg',
        'http://localhost./x.jpg',
        'http://127.0.0.1/x.jpg',
        'http://127.0.0.1./x.jpg',            // 结尾点写法
        'http://127.1/x.jpg',                 // 简写（=127.0.0.1）
        'http://2130706433/x.jpg',            // 十进制整数 IP（=127.0.0.1）
        'http://0x7f.0.0.1/x.jpg',            // 十六进制段
        'http://0177.0.0.1/x.jpg',            // 八进制段
        'http://[::1]/x.jpg',
        'http://[::ffff:127.0.0.1]/x.jpg',    // IPv4-mapped IPv6
        'http://[::ffff:7f00:1]/x.jpg',
        'http://10.0.0.5/x.jpg',
        'http://172.16.9.9/x.jpg',
        'http://172.31.255.254/x.jpg',
        'http://192.168.1.10/x.jpg',
        'http://169.254.169.254/latest/meta-data/', // 云元数据
        'http://100.64.0.1/x.jpg',            // CGNAT
        'http://0.0.0.0/x.jpg',
        'http://198.18.0.1/x.jpg',
        'http://[fe80::1]/x.jpg',
        'http://[fd00::1]/x.jpg',
    ];
    for (const u of bad) {
        const r = await save(null, u, 'x.jpg');
        assert.equal(r.ok, false, `${u} 必须被拒`);
        assert.equal(r.reason, 'private-address', `${u} 应命中 private-address`);
    }
    assert.equal(fetchCalls.length, 0, '全部在发请求前拦下');
});

test('SSRF 门槛：正常公网 CDN/图床 host 不被误判，且非 http(s) scheme 拒绝', async () => {
    const { save, setSavePick, tmpRoot } = await saveEnv(() => mkRes({ headers: { 'content-type': 'image/jpeg' }, body: [Buffer.from('jpg-bytes')] }));
    setSavePick({ canceled: false, filePath: path.join(tmpRoot, 'y.jpg') });
    for (const u of ['https://lain.bgm.tv/pic/cover/l/a.jpg', 'https://lain.bangumi.vip/pic/cover/l/a.jpg',
        'https://i0.hdslb.com/bfs/a.jpg', 'http://img.example.com/a.jpg', 'https://10.example.com/a.jpg']) {
        const r = await save(null, u, 'a.jpg');
        assert.equal(r.ok, true, `${u} 不应被 SSRF 门槛拦截`);
    }
    // 私网域名解析（10.example.com 是合法域名）：不在字面量门槛内 → 不误伤
    const bad = await save(null, 'file:///C:/Windows/win.ini', 'a.jpg');
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'unsupported-url', 'file:// 被 scheme 白名单拒绝');
});

test('重定向逐跳校验：302 跳到 127.0.0.1 被拒；跳到公网正常跟随', async () => {
    const { save, fetchCalls, setSavePick, tmpRoot } = await saveEnv((u) => {
        if (u === 'https://cdn.example.com/start.jpg') {
            return mkRes({ status: 302, headers: { location: 'http://127.0.0.1:9/evil.jpg' } });
        }
        if (u === 'https://cdn2.example.com/ok.jpg') {
            return mkRes({ status: 301, headers: { location: 'https://cdn3.example.com/final.jpg' } });
        }
        return mkRes({ headers: { 'content-type': 'image/png' }, body: [PNG_1PX] });
    });
    setSavePick({ canceled: false, filePath: path.join(tmpRoot, 'r.png') });
    const r1 = await save(null, 'https://cdn.example.com/start.jpg', 'r.png');
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'private-address', '重定向到本机必须被逐跳校验拦下（否则是 SSRF 通道）');
    assert.equal(fetchCalls.length, 1, '跳转目标未发起请求');
    const r2 = await save(null, 'https://cdn2.example.com/ok.jpg', 'r.png');
    assert.equal(r2.ok, true, '公网跳转正常跟随');
    assert.deepEqual(fetchCalls.map((c) => c.url),
        ['https://cdn.example.com/start.jpg', 'https://cdn2.example.com/ok.jpg', 'https://cdn3.example.com/final.jpg']);
});

// ------------------------------------------------------------------
// 4. 失败分支与可诊断 reason（渲染层据此给用户区分文案）
// ------------------------------------------------------------------

test('失败分支：非 2xx / 非图片类型 / 超限 / 空体 / 取消各有明确 reason', async () => {
    const { save, setSavePick, tmpRoot } = await saveEnv((u) => {
        if (u.endsWith('/404.jpg')) return mkRes({ status: 404 });
        if (u.endsWith('/403.jpg')) return mkRes({ status: 403 });
        if (u.endsWith('/html.jpg')) return mkRes({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: ['<html>'] });
        if (u.endsWith('/big.jpg')) return mkRes({ headers: { 'content-type': 'image/png', 'content-length': String(30 * 1024 * 1024) } });
        if (u.endsWith('/empty.jpg')) return mkRes({ headers: { 'content-type': 'image/png' }, body: [] });
        return mkRes({ headers: { 'content-type': 'image/png' }, body: [PNG_1PX] });
    });
    setSavePick({ canceled: false, filePath: path.join(tmpRoot, 'x.jpg') });
    const cases = [
        ['https://cdn.example.com/404.jpg', 'http-404'],
        ['https://cdn.example.com/403.jpg', 'http-403'],
        ['https://cdn.example.com/html.jpg', 'bad-content-type:text/html; charset=utf-8'],
        ['https://cdn.example.com/big.jpg', 'too-large'],
        ['https://cdn.example.com/empty.jpg', 'empty-body'],
    ];
    for (const [u, expect] of cases) {
        const r = await save(null, u, 'x.jpg');
        assert.equal(r.ok, false, `${u} 应失败`);
        assert.equal(r.reason, expect, `${u} 的 reason 应可诊断`);
    }
    // 用户取消保存对话框：既有语义（不报错、不发请求）
    const { save: save2, fetchCalls } = await saveEnv(() => mkRes({}));
    const rc = await save2(null, 'https://cdn.example.com/a.jpg', 'a.jpg');
    assert.equal(rc.ok, false);
    assert.equal(rc.reason, 'cancelled');
    assert.equal(fetchCalls.length, 0, '取消后不得发起网络请求');
});

test('data: 分支：页面自带字节按限额解码写盘；非图片类型拒绝', async () => {
    const { save, fetchCalls, setSavePick, tmpRoot } = await saveEnv(() => mkRes({}));
    const out = path.join(tmpRoot, 'd.png');
    setSavePick({ canceled: false, filePath: out });
    const r = await save(null, `data:image/png;base64,${PNG_1PX.toString('base64')}`, 'd.png');
    assert.equal(r.ok, true, 'data: 图片可保存（不经网络）');
    assert.deepEqual(fs.readFileSync(out), PNG_1PX);
    assert.equal(fetchCalls.length, 0, 'data: 不发起服务端请求');
    const svg = await save(null, 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64'), 'd.svg');
    assert.equal(svg.ok, false);
    assert.match(String(svg.reason), /^bad-content-type/, 'SVG 落盘即 XSS，必须拒绝');
    const html = await save(null, 'data:text/html;base64,' + Buffer.from('<html>').toString('base64'), 'd.jpg');
    assert.equal(html.ok, false);
    assert.match(String(html.reason), /^bad-content-type/);
});

// ------------------------------------------------------------------
// 5. 渲染层：保存入参（URL 拆代理 + 文件名）与失败文案
// ------------------------------------------------------------------

test('_saveImageAs：代理 URL 拆回 origin 后才交 IPC，文件名取 origin 尾段', async () => {
    const { Detail, context } = loadDetail();
    const calls = [];
    context.window.yuki.saveImage = async (url, name) => { calls.push({ url, name }); return { ok: true }; };
    const origin = 'https://lain.bgm.tv/pic/cover/l/aa/bb/7_x.webp';
    await Detail._saveImageAs('http://127.0.0.1:34567/kazumi/cover?token=t&url=' + encodeURIComponent(origin));
    assert.deepEqual(calls, [{ url: origin, name: '7_x.webp' }], 'IPC 收到原始远程 URL 与正确文件名');
    assert.ok(context._toasts.some((t) => t.includes('已保存图片：7_x.webp')));
});

test('_saveImageAs：data: 按 mime 定名；相对/file:（占位图）提前给明确失败文案', async () => {
    const { Detail, context } = loadDetail();
    const calls = [];
    context.window.yuki.saveImage = async (url, name) => { calls.push({ url, name }); return { ok: true }; };
    await Detail._saveImageAs('data:image/jpeg;base64,AAAA');
    assert.equal(calls[0].name, 'image.jpg', 'data: 不能把整串 base64 当文件名');
    assert.ok(calls[0].url.startsWith('data:image/jpeg'), 'data: 原样透传给主进程');
    await Detail._saveImageAs('file:///D:/app/assets/cover-fallback.svg');
    assert.equal(calls.length, 1, 'file:// 不再交 IPC');
    assert.ok(context._toasts.some((t) => t === '保存图片失败：该图片地址无法下载'));
});

test('_saveImageFailText：各类 reason 文案可区分（网络/非图片/权限/超大/取消不提示）', async () => {
    const { Detail, context } = loadDetail();
    const seen = new Set();
    for (const reason of ['http-403', 'http-404', 'http-500', 'timeout', 'network', 'too-many-redirects',
        'bad-content-type:text/html', 'too-large', 'empty-body', 'private-address', 'unsupported-url',
        'permission-denied', 'no-space', 'file-locked', 'write-failed', 'something-else']) {
        const text = Detail._saveImageFailText(reason);
        assert.ok(text.startsWith('保存图片失败') || text.startsWith('保存图片失败：'), `${reason} 文案应为失败提示`);
        assert.ok(!seen.has(text), `${reason} 的文案应与其它 reason 不同（可诊断）`);
        seen.add(text);
    }
    assert.match(Detail._saveImageFailText('http-403'), /拒绝访问/);
    assert.match(Detail._saveImageFailText('timeout'), /超时/);
    assert.match(Detail._saveImageFailText('bad-content-type:text/html'), /不是图片/);
    assert.match(Detail._saveImageFailText('permission-denied'), /权限/);
    // 用户取消：既有语义不变（不弹任何失败提示）
    context._toasts.length = 0;
    const { Detail: D2, context: c2 } = loadDetail();
    c2.window.yuki.saveImage = async () => ({ ok: false, reason: 'cancelled' });
    await D2._saveImageAs('https://cdn.example.com/a.jpg');
    assert.deepEqual(c2._toasts, [], '取消保存对话框不得报错/提示');
});
