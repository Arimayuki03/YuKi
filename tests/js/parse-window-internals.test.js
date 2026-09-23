// 白盒单元测试：parse-window.js 内部实现（解析窗口池 / 捕获窗口生命周期 / 回收与自愈）
//
// 与既有三个测试互补：
//   - parse-window-pool.test.js：槽位泄漏回归（release 顺序、并发超载后池不枯竭）
//   - parse-window-contract.test.js：resolve 调度（priority/flag/type 分流、取消、超时）
//   - parse-window-guard.test.js：验证码窗口的协议守卫（will-navigate / setWindowOpenHandler）
// 本文件补其未覆盖的部分：
//   - 空闲槽位复用 vs 新建窗口（partition 隔离、并发不串味）
//   - 池上限与超限排队（第 4 个请求必须等到有人归还，且不被提前开窗）
//   - 窗口回收与销毁（destroy + release 顺序、定时器/轮询/拦截器清理）
//   - 媒体命中路径（webRequest onBeforeSendHeaders、DOM <video> 兜底、legacy iframe 跟随）
//   - 崩溃/异常自愈（开窗抛错、did-fail-load 快速失败、Cookie 读取失败仍收尾、abort 作废）
//   - 清理不泄漏（并发 8 > 池 3 全部收尾后槽位/等待队列/定时器/单飞状态全部归零）
//
// 隔离：vm 沙箱装载源码，electron 的 BrowserWindow / shell 全部替身，绝不真创建窗口。
// 定时器全部替身且按比例加速（12s/300ms/100ms 统一压到 ≤15ms），测试不依赖真实等待。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '../../src/main/parse-window.js');
const REAL = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
};
// 替身定时器在真实定时器上按此上限加速：12s 超时 / 300ms 轮询都压到 ≤15ms，
// 用例既不空转等待，又能断言「收尾是否把定时器清干净」（timers 登记表）。
const TIMER_CAP_MS = 15;

/** 隐藏窗口替身：可脚本化的 executeJavaScript / loadURL / 事件发射。 */
function makeWinStub(opts = {}) {
    const navHandlers = [];
    const failHandlers = [];
    const finishHandlers = [];
    const closedHandlers = [];
    let openHandler = null;
    let permissionHandler = null;
    const win = {
        destroyed: false,
        loaded: null,
        loadOpts: null,
        loadUrls: [],
        jsCalls: [],
        navHandlers,
        failHandlers,
        finishHandlers,
        closedHandlers,
        get openHandler() { return openHandler; },
        get permissionHandler() { return permissionHandler; },
        on(ev, cb) { if (ev === 'closed') closedHandlers.push(cb); return this; },
        loadURL(u, o) {
            this.loaded = u;
            this.loadUrls.push(u);
            this.loadOpts = o;
            if (opts.onLoad) return opts.onLoad(u, o);
            return Promise.resolve();
        },
        destroy() { this.destroyed = true; },
        webContents: {
            get navHandlers() { return navHandlers; },
            get failHandlers() { return failHandlers; },
            get finishHandlers() { return finishHandlers; },
            get openHandler() { return openHandler; },
            get permissionHandler() { return permissionHandler; },
            session: {
                setPermissionRequestHandler(fn) { permissionHandler = fn; },
                cookies: { get: () => (opts.cookies ? opts.cookies() : Promise.resolve([])) },
                webRequest: {
                    beforeRequest: null,
                    beforeSendHeaders: null,
                    onBeforeRequest(fn) { this.beforeRequest = fn; },
                    onBeforeSendHeaders(fn) { this.beforeSendHeaders = fn; },
                },
            },
            setMaxListeners() { },
            on(ev, cb) {
                if (ev === 'will-navigate') navHandlers.push(cb);
                if (ev === 'did-fail-load') failHandlers.push(cb);
                if (ev === 'did-finish-load') finishHandlers.push(cb);
                return this;
            },
            setWindowOpenHandler(fn) { openHandler = fn; },
            executeJavaScript(code) {
                win.jsCalls.push(code);
                const r = opts.js ? opts.js(code) : [];
                return r && typeof r.then === 'function' ? r : Promise.resolve(r);
            },
        },
    };
    return win;
}

/** 在 vm 沙箱里装载 parse-window.js，返回实例与替身记录。 */
function loadParseWindow(opts = {}) {
    const source = fs.readFileSync(SRC, 'utf8');
    const created = [];
    const opened = [];
    // 定时器替身：登记在册（可断言「清理是否干净」），timeout 默认按上限加速真实触发；
    // opts.manualTimeout=true 时只登记不触发（由用例自己驱动命中/失败路径，避免超时抢跑）。
    const timers = new Map();
    let seq = 0;
    const setTimeoutStub = (fn, ms) => {
        const h = { id: ++seq, ms, fn, tag: 't', real: null };
        if (!opts.manualTimeout) {
            h.real = REAL.setTimeout(() => { timers.delete(h.id); fn(); }, Math.min(ms, TIMER_CAP_MS));
        }
        timers.set(h.id, h);
        return h;
    };
    const setIntervalStub = (fn, ms) => {
        const h = { id: ++seq, ms, fn, tag: 'i', real: null };
        h.real = REAL.setInterval(() => fn(), Math.max(1, Math.min(ms, TIMER_CAP_MS)));
        timers.set(h.id, h);
        return h;
    };
    const clearStub = (h) => {
        if (!h || h.id === undefined) return;
        timers.delete(h.id);
        if (h.tag === 't') REAL.clearTimeout(h.real); else REAL.clearInterval(h.real);
    };
    const fetchStub = opts.fetch || (async () => ({ ok: true, json: async () => ({}) }));
    const context = {
        console: { log() { }, warn() { }, error() { } },
        Promise, Set, Map, Number, String, Array, Object, Date, Math, JSON, Buffer, URL, URLSearchParams,
        setTimeout: setTimeoutStub, clearTimeout: clearStub,
        setInterval: setIntervalStub, clearInterval: clearStub,
        AbortController, AbortSignal,
        fetch: (url, o) => {
            if (opts.onFetch) opts.onFetch(url, o);
            return fetchStub(url, o);
        },
        module: { exports: {} },
        require(name) {
            if (name === 'electron') {
                return {
                    BrowserWindow: function BrowserWindowStub(o) {
                        if (opts.winThrows) throw new Error('BrowserWindow unavailable');
                        // cookies 既支持 win.cookies 也支持顶层简写（同一套替身行为）
                        const w = makeWinStub({ ...opts.win, cookies: opts.cookies });
                        w.opts = o;
                        created.push(w);
                        return w;
                    },
                    shell: { openExternal(u) { opened.push(u); return Promise.resolve(); } },
                };
            }
            if (name === './app-icon') return { windowIcon: () => null };
            if (name === './async-session') {
                // 默认用真实 AsyncSingleFlight（同 key 去重语义需要被验证）
                if (opts.flight) return { AsyncSingleFlight: opts.flight };
                const { AsyncSingleFlight } = require('../../src/main/async-session');
                return { AsyncSingleFlight };
            }
            throw new Error(`unexpected dependency: ${name}`);
        },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__ParseWindow = ParseWindow;`, context, { filename: SRC });
    const ParseWindow = context.__ParseWindow;
    return {
        ParseWindow,
        pw: new ParseWindow(opts.getInfo || (() => ({})), opts.probe || null),
        created,
        opened,
        timers,
        pending() { return timers.size; },
        /** 立即触发（可选按 ms 过滤的）到期定时器/轮询，绕过加速等待（触发后从登记表移除） */
        fire(pred) {
            for (const h of [...timers.values()]) {
                if (pred && !pred(h)) continue;
                clearStub(h);
                h.fn();
            }
        },
        /** 只驱动一轮轮询（不摘除定时器）：模拟 300ms 轮询的下一轮，可连续调用 */
        pump(pred) {
            for (const h of [...timers.values()]) {
                if (pred && !pred(h)) continue;
                h.fn();
            }
        },
    };
}

/** 触发某个窗口的 did-fail-load（Electron 事件签名）。 */
function failLoad(win, errorCode, isMainFrame = true) {
    for (const cb of win.webContents.failHandlers) cb({}, errorCode, 'ERR', win.loaded, isMainFrame);
}

/** 触发 onBeforeSendHeaders，返回其回调参数。 */
function sendHeaders(win, details) {
    let result = null;
    win.webContents.session.webRequest.beforeSendHeaders(details, (r) => { result = r; });
    return result;
}

/** 让微任务与已排队的 Cookie Promise 落地。 */
const tick = (ms = 0) => new Promise((r) => REAL.setTimeout(r, ms));

/** 媒体请求命中（resourceType=media）。 */
const hitMedia = (win, url) => sendHeaders(win, { url, resourceType: 'media', requestHeaders: {} });

// ---------------------------------------------------------------- 池：复用策略

test('复用策略：串行请求复用归还的槽位，partition 带会话后缀（并发不串味）', async () => {
    const { pw, created } = loadParseWindow();
    // 第一次捕获：取槽 0，partition 带本次会话键
    const p1 = pw._capture({ url: 'https://media.test/a', via: 'v1', timeout: 20,
        context: { playSessionId: 'sess-A' } });
    await tick();
    assert.equal(created.length, 1);
    assert.equal(created[0].loaded, 'https://media.test/a');
    assert.match(created[0].opts.webPreferences.partition, /^parse-0-sess-A$/,
        'partition = parse-<slot>-<会话键>：同 session 只注册一份 webRequest，必须各自独立');
    assert.equal(await p1, null, '未命中媒体 → 超时返回 null');
    assert.equal(created[0].destroyed, true, '收尾必须销毁窗口（session 随最后窗口关闭销毁）');
    assert.deepEqual(pw._slots, [1, 2, 0], '槽位归还（push 回队尾）');
    assert.notEqual(pw._slots[0], 0, '刚用过的槽排到队尾：下一请求优先拿别的槽，避免复用同一 partition 的残留会话');

    // 第二次（另一会话）：取到队首槽 1，partition 换成新会话键
    const p2 = pw._capture({ url: 'https://media.test/b', via: 'v2', timeout: 20,
        context: { playSessionId: 'sess-B' } });
    await tick();
    assert.equal(created.length, 2);
    assert.equal(created[1].loaded, 'https://media.test/b');
    assert.match(created[1].opts.webPreferences.partition, /^parse-1-sess-B$/,
        '复用池中的空闲槽位，但会话隔离后缀不同（旧会话残留不会串味）');
    await p2;
    assert.equal(pw._slots.length, 3);
});

test('复用策略：并发请求各占独立槽位，partition 互不相同（共用会让后注册的 webRequest 覆盖前者）', async () => {
    const { pw, created } = loadParseWindow();
    const pending = [0, 1, 2].map((i) => pw._capture({ url: `https://media.test/${i}`, via: `v${i}`,
        timeout: 20, context: { playSessionId: `s${i}` } }));
    await tick();
    assert.equal(created.length, 3, '3 个槽位各自开窗');
    const parts = created.map((w) => w.opts.webPreferences.partition);
    assert.equal(new Set(parts).size, 3, `三个窗口的 partition 必须互不相同：${parts.join(',')}`);
    assert.deepEqual(pw._slots, [], '池已取空');
    assert.deepEqual(await Promise.all(pending), [null, null, null]);
    assert.equal(pw._slots.length, 3, '全部收尾后池满');
});

// ---------------------------------------------------------------- 池：上限与排队

test('池上限：第 4 个请求排队等待不提前开窗，前 3 个中任一释放即被唤醒', async () => {
    // 手动定时器：超时不抢跑，确认第 4 个确实是被「上一个释放」唤醒而非自己超时重来
    const { pw, created } = loadParseWindow({ manualTimeout: true });
    const pending = [0, 1, 2, 3].map((i) => pw._capture({ url: `https://media.test/${i}`, via: 'v',
        timeout: 12000, context: { playSessionId: `s${i}` } }));
    await tick();
    assert.equal(created.length, 3, 'POOL_SIZE=3：同时最多 3 个窗口');
    assert.equal(pw._waiters.length, 1, '第 4 个必须排队，不得越限开窗');
    assert.equal(pw._slots.length, 0);
    // 命中第一个窗口的媒体请求 → 收尾释放槽 → waiter 被唤醒并真正开窗
    hitMedia(created[0], 'https://media.test/hit.m3u8');
    assert.equal((await pending[0]).url, 'https://media.test/hit.m3u8');
    await tick();
    assert.equal(created.length, 4, 'waiter 必须被唤醒并拿到归还的槽位');
    assert.equal(pw._waiters.length, 0);
    // 收尾其余三个
    for (const w of created.slice(1)) hitMedia(w, 'https://media.test/hit.mp4');
    await Promise.all(pending);
    assert.equal(pw._slots.length, 3, '全部完成后池恢复满槽');
    assert.equal(pw._waiters.length, 0);
    assert.ok(created.every((w) => w.destroyed), '每个窗口都必须被销毁');
});

test('排队：连续 8 个并发（远超 3 槽）按序推进，不丢任务也不永久 pending', async () => {
    // 手动定时器：超时不抢跑，只有本用例驱动命中，才能验证「确实是 waiter 被唤醒」
    const { pw, created } = loadParseWindow({ manualTimeout: true });
    const pending = [];
    for (let i = 0; i < 8; i++) {
        pending.push(pw._capture({ url: `https://media.test/q${i}`, via: 'v', timeout: 12000,
            context: { playSessionId: `q${i}` } }));
    }
    await tick();
    assert.equal(created.length, 3, '开局只能开 3 个窗');
    assert.equal(pw._waiters.length, 5);
    // 逐个命中推进：每个收尾都会唤醒下一个 waiter
    for (let i = 0; i < 8; i++) {
        assert.ok(created[i], `第 ${i} 个窗口必须已被创建（waiter 未被唤醒 = 槽位泄漏）`);
        hitMedia(created[i], `https://media.test/hit${i}.m3u8`);
        await pending[i];
        await tick();
    }
    assert.equal(created.length, 8, '8 个任务都必须实际执行，不得丢任务');
    assert.equal(pw._slots.length, 3, '不泄漏：池恢复满槽');
    assert.equal(pw._waiters.length, 0, '不泄漏：等待队列清空');
    assert.ok(created.every((w) => w.destroyed));
});

// ---------------------------------------------------------------- 命中路径

test('命中路径：media 资源与媒体扩展名均命中；非媒体放行；finish 去注册拦截器', async () => {
    const { pw, created } = loadParseWindow({ manualTimeout: true });
    const p = pw._capture({ url: 'https://jx.test/parse?u=1', via: 'jx', timeout: 12000,
        headers: { Referer: 'https://jx.test/' } });
    await tick();
    const w = created[0];
    assert.ok(typeof w.webContents.session.webRequest.beforeSendHeaders === 'function',
        '必须注册 onBeforeSendHeaders（onBeforeRequest 拿不到可靠请求头）');
    // 非媒体资源：不命中，继续等
    const pass = sendHeaders(w, { url: 'https://jx.test/ads.js', resourceType: 'script',
        requestHeaders: { Referer: 'https://jx.test/' } });
    assert.deepEqual(pass, { requestHeaders: { Referer: 'https://jx.test/' } },
        '非媒体请求必须原样放行');
    assert.equal(w.destroyed, false);
    // XHR 拉的 m3u8（resourceType 非 media 但带扩展名）也应命中
    sendHeaders(w, { url: 'https://cdn.test/live.m3u8?token=1', resourceType: 'xhr',
        requestHeaders: { Referer: 'https://cdn.test/', Cookie: 'a=1', 'X-Other': 'x' } });
    const res = await p;
    assert.equal(res.ok, true);
    assert.equal(res.url, 'https://cdn.test/live.m3u8?token=1');
    assert.equal(res.via, 'jx');
    assert.equal(res.header.Referer, 'https://cdn.test/', '媒体请求头覆盖解析器头（与真正命中的请求一致）');
    assert.equal(res.header.Cookie, 'a=1');
    assert.equal(res.header['X-Other'], undefined, '只保留 UA/Referer/Origin/Cookie/Authorization');
    assert.equal(w.webContents.session.webRequest.beforeSendHeaders, null,
        'finish 必须去注册拦截器（残留回调会在同 session 上重复触发）');
    assert.equal(w.webContents.session.webRequest.beforeRequest, null);
    assert.ok(w.destroyed);
});

test('命中路径：未命中时 DOM <video> 轮询兜底（via ·页面媒体元素），blob/相对地址忽略', async () => {
    const { pw, created, pump } = loadParseWindow({
        manualTimeout: true,
        win: { js: () => ['blob:https://x/1', 'https://cdn.test/fallback.mp4', './relative.mp4'] },
    });
    const p = pw._capture({ url: 'https://page.test/watch', via: 'page', timeout: 12000 });
    await tick();
    const w = created[0];
    pump((h) => h.ms === 300); // 驱动一次 300ms 视频元素轮询
    const r = await p;
    assert.ok(r, 'DOM 兜底必须命中（不等满 timeout，轮询下一轮即出结果）');
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://cdn.test/fallback.mp4', 'blob:/相对地址 mpv 播不了，必须忽略');
    assert.equal(r.via, 'page·页面媒体元素');
    assert.ok(w.destroyed);
    assert.equal(pw._slots.length, 3);
});

test('命中路径：legacy 模式注入 MutationObserver 并限深跟随 iframe src（防环）', async () => {
    const hop = ['https://hop.test/1', 'https://hop.test/2', 'https://cdn.test/real.m3u8'];
    let n = 0;
    const { pw, created, pump } = loadParseWindow({
        manualTimeout: true,
        win: { js: (code) => {
            if (String(code).includes('MutationObserver')) return undefined; // 注入脚本，无返回值
            return hop[Math.min(hop.length - 1, n++)];                      // JS_GET_IFRAME_SRC
        } },
    });
    const p = pw._capture({ url: 'https://page.test/legacy', via: 'legacy', timeout: 12000, legacy: true });
    await tick();
    const w = created[0];
    for (const cb of w.webContents.finishHandlers) cb(); // 首帧加载完成：注入监听脚本
    assert.ok(w.jsCalls.some((c) => c.includes('MutationObserver')), 'legacy 必须注入 iframe src 监听');
    // 逐轮驱动 300ms 轮询：hop1 跟随 → hop2 跟随 → 命中媒体直链
    for (let i = 0; i < 3; i++) {
        pump((h) => h.ms === 300);
        await tick();
    }
    const r = await p;
    assert.ok(r, 'legacy 跟随最终必须命中媒体直链');
    assert.ok(w.jsCalls.some((c) => c.includes('MutationObserver')), 'legacy 必须注入 iframe src 监听');
    assert.equal(r.url, 'https://cdn.test/real.m3u8');
    assert.equal(r.via, 'legacy·iframe');
    // 深度上限 MAX_DEPTH=2：只能跟随两次（hop/1、hop/2），第三次直接命中
    assert.deepEqual(w.loadUrls,
        ['https://page.test/legacy', 'https://hop.test/1', 'https://hop.test/2']);
    assert.ok(w.destroyed);
});

// ---------------------------------------------------------------- 回收与自愈

test('回收：命中后窗口销毁、超时/轮询/取消三个定时器全部清掉', async () => {
    const { pw, created, pending: pendingCount } = loadParseWindow();
    const abort = { requested: false };
    const p = pw._capture({ url: 'https://media.test/x', via: 'v', timeout: 100, abort });
    await tick();
    assert.equal(pendingCount(), 3, '窗口期应存在：超时 + 300ms 轮询 + 100ms 取消轮询');
    hitMedia(created[0], 'https://media.test/x.mp4');
    await p;
    assert.equal(created[0].destroyed, true, '窗口必须销毁（session 随最后窗口关闭销毁）');
    assert.equal(pendingCount(), 0,
        '收尾必须清掉三个定时器——残留 interval 会对已销毁窗口持续 executeJavaScript');
    assert.equal(pw._slots.length, 3, '槽位必须归还');
});

test('自愈：abort 置位立即作废（不等满 timeout）、销毁窗口并释放槽位', async () => {
    const { pw, created, fire, pending: pendingCount } = loadParseWindow();
    const abort = { requested: false };
    const p = pw._capture({ url: 'https://media.test/slow', via: 'v', timeout: 100000, abort });
    await tick();
    assert.equal(created.length, 1);
    assert.equal(pw._slots.length, 2, '已占用一个槽');
    abort.requested = true;
    fire((h) => h.ms === 100); // 取消轮询命中
    assert.equal(await p, null);
    assert.equal(created[0].destroyed, true, '取消必须销毁窗口');
    assert.equal(pw._slots.length, 3, '取消必须释放槽位，否则 25s 安全超时会占死解析池');
    assert.equal(pendingCount(), 0);
});

test('自愈：主框架 did-fail-load 秒级失败；非主框架/ERR_ABORTED/首帧后失败不误杀', async () => {
    // 主框架失败（解析站死链）→ 立即 finish(null)，不必烧满 12s（手动定时器：超时不抢跑）
    const a = loadParseWindow({ manualTimeout: true });
    const pa = a.pw._capture({ url: 'https://dead.test/p', via: 'v', timeout: 12000 });
    await tick();
    failLoad(a.created[0], -102); // ERR_CONNECTION_REFUSED
    assert.equal(await pa, null, '主框架失败应秒级跳过，不必烧满 IFRAME_TIMEOUT');
    assert.equal(a.created[0].destroyed, true);
    assert.equal(a.pw._slots.length, 3);
    assert.equal(a.pending(), 0, '收尾必须清掉超时与轮询定时器');

    const b = loadParseWindow({ manualTimeout: true });
    const pb = b.pw._capture({ url: 'https://jx.test/p', via: 'v', timeout: 12000 });
    await tick();
    failLoad(b.created[0], -102, false);
    assert.equal(b.created[0].destroyed, false, '非主框架失败不得误杀（解析页常含失败 iframe）');
    failLoad(b.created[0], -3);
    assert.equal(b.created[0].destroyed, false, 'ERR_ABORTED(-3，跟随加载/主动中断) 属正常导航');
    for (const cb of b.created[0].webContents.finishHandlers) cb(); // 首帧成功
    failLoad(b.created[0], -102);
    assert.equal(b.created[0].destroyed, false, 'legacy 跟随加载失败交给轮询/超时兜底，不误杀');
    b.fire(); // 手动触发超时收尾
    assert.equal(await pb, null);
    assert.equal(b.pw._slots.length, 3);
});

test('自愈：new BrowserWindow 抛异常时释放槽位并返回 null（不占死解析池）', async () => {
    const { pw } = loadParseWindow({ winThrows: true });
    assert.equal(await pw._capture({ url: 'https://media.test/x', via: 'v', timeout: 20 }), null,
        '开窗失败必须返回 null，交由下一个解析器');
    assert.equal(pw._slots.length, 3, '开窗失败也必须归还槽位（否则一次故障就永久占死一个槽）');
    assert.deepEqual([...pw._slots].sort(), [0, 1, 2], '归还的是原槽位本身，池容量不变');
    assert.equal(pw._waiters.length, 0);
    // 再跑一轮：池仍可用（故障不是永久性的）
    assert.equal(await pw._capture({ url: 'https://media.test/y', via: 'v', timeout: 20 }), null);
    assert.equal(pw._slots.length, 3);
});

test('自愈：captchaVerify 开窗失败返回 {ok:false} 并归还槽位（不永久 pending）', async () => {
    const { pw } = loadParseWindow({ winThrows: true });
    assert.deepEqual(await pw.captchaVerify('https://site.test/captcha', 20), { ok: false });
    assert.equal(pw._slots.length, 3);
});

// ---------------------------------------------------------------- Cookie 收割

test('Cookie：命中后把会话 Cookie 收进结果头（过期/跨域/secure/路径不匹配均过滤）', async () => {
    const now = Date.now() / 1000;
    const { pw, created } = loadParseWindow({ manualTimeout: true,
        cookies: () => Promise.resolve([
            { name: 'ok', value: '1', domain: '.cdn.test', path: '/' },
            { name: 'expired', value: '2', domain: '.cdn.test', path: '/', expirationDate: now - 10 },
            { name: 'future', value: '3', domain: '.cdn.test', path: '/', expirationDate: now + 3600 },
            { name: 'other', value: '4', domain: 'other.test', path: '/' },
            { name: 'sec', value: '5', domain: '.cdn.test', path: '/', secure: true },
            { name: 'badpath', value: '6', domain: '.cdn.test', path: '/nope' },
            { value: 'nameless', domain: '.cdn.test', path: '/' },
        ]),
    });
    const p = pw._capture({ url: 'https://jx.test/p', via: 'v', timeout: 12000 });
    await tick();
    // http（非 https）：secure Cookie 不参与；跨域/过期/路径不符/无名一律剔除
    sendHeaders(created[0], { url: 'http://cdn.test/a.m3u8', resourceType: 'media', requestHeaders: {} });
    const r = await p;
    assert.equal(r.header.Cookie, 'ok=1; future=3',
        '只有未过期、同域、路径匹配、非 secure-only 的 Cookie 才进头');
    assert.equal(pw._slots.length, 3);
});

test('Cookie：读取失败（会话已销毁）时仍收尾并释放槽位，不吞掉已捕获的直链', async () => {
    const { pw, created } = loadParseWindow({
        cookies: () => Promise.reject(new Error('session destroyed')),
    });
    const p = pw._capture({ url: 'https://jx.test/p', via: 'v', timeout: 100 });
    await tick();
    hitMedia(created[0], 'https://cdn.test/a.mp4');
    const r = await p;
    assert.equal(r.ok, true, 'Cookie 收割失败不得吞掉已捕获的直链');
    assert.equal(r.url, 'https://cdn.test/a.mp4');
    assert.equal(created[0].destroyed, true);
    assert.equal(pw._slots.length, 3, 'catch 分支同样必须释放槽位');
});

test('Cookie：captchaVerify 关闭窗口立即收尾（超时定时器被清，不会二次结算）', async () => {
    const { pw, created, pending: pendingCount } = loadParseWindow();
    const p = pw.captchaVerify('https://site.test/captcha', 100000);
    await tick();
    assert.equal(created.length, 1);
    assert.equal(created[0].opts.show, true, '验证码窗口必须可见，用户才能交互');
    assert.match(created[0].opts.webPreferences.partition, /^parse-\d+$/,
        '验证码用独立槽位会话（无会话后缀），与解析互不冲突');
    for (const cb of created[0].closedHandlers) cb(); // 用户关闭窗口
    assert.deepEqual(await p, { ok: true }, '用户关闭即视为验证完成');
    assert.equal(created[0].destroyed, true);
    assert.equal(pw._slots.length, 3);
    assert.equal(pendingCount(), 0, '收尾必须清掉超时定时器');
});

test('Cookie：推送按域名分组，剥离前导点与端口（后端 CookieJar 以 host 为键）', () => {
    const calls = [];
    const source = fs.readFileSync(SRC, 'utf8');
    const ctx = { console: { log() { }, warn() { } }, Promise, Set, Map, Number, String, Array, Object,
        Date, Math, JSON, Buffer, URL, URLSearchParams, setTimeout: REAL.setTimeout,
        clearTimeout: REAL.clearTimeout, setInterval: REAL.setInterval, clearInterval: REAL.clearInterval,
        AbortController, AbortSignal,
        fetch: (url, o) => { calls.push({ url, body: String(o.body) }); return Promise.resolve({ ok: true }); },
        module: { exports: {} },
        require: (n) => {
            if (n === 'electron') return { BrowserWindow: function () { throw new Error('x'); }, shell: {} };
            if (n === './app-icon') return { windowIcon: () => null };
            if (n === './async-session') return { AsyncSingleFlight: class { run(_k, f) { return f(); } } };
            throw new Error(`unexpected dependency: ${n}`);
        } };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(`${source}\n;globalThis.__ParseWindow = ParseWindow;`, ctx, { filename: SRC });
    const inst = new ctx.__ParseWindow(() => ({ base: 'http://127.0.0.1:9978', token: 'tk' }), null);
    inst._pushCookies([
        { name: 'a', value: '1', domain: '.site.test' },
        { name: 'b', value: '2', domain: 'site.test:8080' },
        { name: 'c', value: '3', domain: '.other.test' },
        { name: '', value: 'skip', domain: '.site.test' },   // 无名 Cookie 丢弃
        { domain: '.site.test' },
    ]);
    assert.equal(calls.length, 2, `两个域名各推一次：${calls.map((c) => c.body).join(' | ')}`);
    const hosts = calls.map((c) => /domain=([^&]*)/.exec(c.body)[1]);
    assert.deepEqual(hosts, ['site.test', 'other.test'], '按域名分组推送，每组一次');
    // 前导点（.site.test）与端口（site.test:8080）都归一到 host site.test → 合并为一条
    const merged = JSON.parse(decodeURIComponent(/cookies=([^&]*)/.exec(calls[0].body)[1]));
    assert.deepEqual(merged.map((c) => c.name), ['a', 'b'],
        '前导点与端口剥离后同域合并，无名 Cookie 被丢弃');
    assert.ok(calls.every((c) => c.url.includes('/kazumi/action?token=tk')));
    assert.ok(calls.every((c) => c.body.startsWith('do=kazumiCookieSet')));
    // 空/无 base 时静默跳过
    calls.length = 0;
    inst._pushCookies([]);
    inst._pushCookies(null);
    assert.equal(calls.length, 0);
    const noBase = new ctx.__ParseWindow(() => ({}), null);
    noBase._pushCookies([{ name: 'x', value: '1', domain: 'a.test' }]);
    assert.equal(calls.length, 0, '后端信息缺失时不得推送');
});

// ---------------------------------------------------------------- captureDirect 与单飞去重

test('captureDirect：同 key 并发经 AsyncSingleFlight 合并，只开一个窗口共享结果', async () => {
    const { pw, created } = loadParseWindow();
    const p1 = pw.captureDirect('https://page.test/v', 100, false, null, { playSessionId: 'S1' });
    const p2 = pw.captureDirect('https://page.test/v', 100, false, null, { playSessionId: 'S1' });
    await tick();
    assert.equal(created.length, 1, '同 URL 并发只开一个隐藏窗口');
    hitMedia(created[0], 'https://cdn.test/merged.m3u8');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.url, 'https://cdn.test/merged.m3u8');
    assert.equal(r2.url, 'https://cdn.test/merged.m3u8', '第二个调用方共享同一结果');
    assert.equal(pw._slots.length, 3);
    assert.equal(pw._captureFlight.size(), 0, '完成后单飞在途状态清空（下次同 key 重新执行）');
});

test('captureDirect：不同 playSessionId（不同单飞 key）各自开窗，互不合并', async () => {
    const { pw, created } = loadParseWindow();
    const p1 = pw.captureDirect('https://page.test/v', 40, false, null, { playSessionId: 'S1' });
    const p2 = pw.captureDirect('https://page.test/v', 40, false, null, { playSessionId: 'S2' });
    await tick();
    assert.equal(created.length, 2, '不同播放会话必须各自捕获（单飞 key 含 playSessionId）');
    await Promise.all([p1, p2]);
    assert.equal(pw._slots.length, 3);
});

test('captureDirect：非 http(s) 直接返回 null，不开窗也不占用槽位', async () => {
    const { pw, created } = loadParseWindow();
    for (const bad of ['demohttps://x.test/a', 'intent://scan/#Intent;end', 'magnet:?xt=1',
        'file:///D:/a.mp4', '', null, undefined]) {
        assert.equal(await pw.captureDirect(bad, 20), null, `${String(bad)} 不得交给隐藏窗口`);
    }
    assert.equal(created.length, 0, '畸形 scheme 会弹「用什么应用打开」系统弹窗，必须前置拦截');
    assert.equal(pw._slots.length, 3);
});

// ---------------------------------------------------------------- 权限与守卫（隐藏捕获窗口侧）

test('隐藏捕获窗口：会话注册全拒权限处理器，窗口选项关闭 Node 能力', async () => {
    const { pw, created } = loadParseWindow();
    const p = pw._capture({ url: 'https://jx.test/p', via: 'v', timeout: 40 });
    await tick();
    const w = created[0];
    assert.equal(w.opts.show, false, '隐藏窗口');
    const wp = w.opts.webPreferences;
    assert.equal(wp.contextIsolation, true);
    assert.equal(wp.nodeIntegration, false);
    assert.equal(wp.sandbox, true);
    assert.equal(wp.spellcheck, false);
    assert.match(wp.partition, /^parse-\d/);
    // P2-12：未注册权限处理器时 Chromium 默认放行通知/定位/剪贴板读取
    assert.ok(typeof w.permissionHandler === 'function', '解析会话必须注册全拒处理器');
    for (const perm of ['clipboard-read', 'notifications', 'geolocation', 'media']) {
        let granted = 'unset';
        w.permissionHandler({}, perm, (v) => { granted = v; });
        assert.equal(granted, false, `${perm} 必须拒绝（抓流不依赖任何页面权限）`);
    }
    assert.equal(w.openHandler({ url: 'https://ad.test/x' }).action, 'deny',
        '窗口内新窗一律 deny（不交系统，避免弹「打开方式」）');
    await p;
});

test('隐藏捕获窗口：will-navigate 拦截非 http(s)；解析器头以 extraHeaders 注入 loadURL', async () => {
    const { pw, created } = loadParseWindow();
    const p = pw._capture({ url: 'https://jx.test/p?u=1', via: 'v', timeout: 40,
        headers: { Referer: 'https://site.test/', Cookie: 'a=1' } });
    await tick();
    const w = created[0];
    assert.deepEqual(w.loadOpts, { extraHeaders: 'Referer: https://site.test/\nCookie: a=1' },
        '解析器头按 `Key: value` 换行注入 extraHeaders');
    assert.equal(w.navHandlers.length, 1);
    const nav = (u) => {
        let prevented = false;
        w.navHandlers[0]({ preventDefault() { prevented = true; } }, u);
        return prevented;
    };
    assert.equal(nav('intent://scan/#Intent;end'), true, '非 http(s) 必须拦在窗口内');
    assert.equal(nav('magnet:?xt=1'), true);
    assert.equal(nav('https://jx.test/next'), false, 'http(s) 正常放行');
    await p;
});

// ---------------------------------------------------------------- 清理不泄漏 / 关闭全部

test('关闭全部：并发 8 个（> 3 槽）全部收尾后，槽位/等待队列/定时器/单飞全部归零', async () => {
    const { pw, created, pending: pendingCount } = loadParseWindow();
    const jobs = [];
    for (let i = 0; i < 8; i++) {
        jobs.push(pw.captureDirect(`https://page.test/full-${i}`, 30, false, null,
            { playSessionId: `F${i}` }));
    }
    await tick();
    assert.equal(created.length, 3, '同一时刻最多 3 个窗口');
    const results = await Promise.all(jobs); // 未命中 → 各自超时返回 null
    assert.equal(created.length, 8, '8 个任务都应实际开窗');
    assert.deepEqual(results, new Array(8).fill(null));
    assert.equal(pw._slots.length, 3, '槽位全部归还');
    assert.equal(pw._waiters.length, 0, '等待队列清空');
    assert.equal(pendingCount(), 0, '所有定时器（超时/轮询）都被清掉');
    assert.equal(pw._captureFlight.size(), 0, '单飞在途状态清空');
    assert.ok(created.every((w) => w.destroyed), '每个窗口都销毁（不泄漏隐藏窗口与 session）');
});

test('关闭全部：captchaVerify 与 _capture 混跑后池不串味，槽位与等待队列均归零', async () => {
    const { pw, created } = loadParseWindow();
    const jobs = [
        pw.captchaVerify('https://site.test/c1', 30),
        pw._capture({ url: 'https://jx.test/1', via: 'v', timeout: 30 }),
        pw.captchaVerify('https://site.test/c2', 30),
        pw._capture({ url: 'https://jx.test/2', via: 'v', timeout: 30 }),
    ];
    await tick();
    assert.equal(created.length, 3, '验证码窗口与捕获窗口共用同一个 3 槽池');
    await Promise.all(jobs);
    assert.equal(created.length, 4, '第 4 个任务等首个释放后才开窗');
    assert.deepEqual([...pw._slots].sort(), [0, 1, 2], '归还后所有槽位各归其位');
    assert.equal(pw._slots.length, 3);
    assert.equal(pw._waiters.length, 0);
    assert.ok(created.every((w) => w.destroyed));
});
