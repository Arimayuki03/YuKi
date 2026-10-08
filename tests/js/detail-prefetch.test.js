'use strict';
// 详情意图预取（common.js prefetchDetail）回归测试：
// 简介与播放信息只在 detailContent 响应里，首次打开必须等一次网络——悬停/触摸
// 预取把这次请求前移到「点击前」，点击时 Detail.load 走既有缓存命中路径秒出。
// 锁定语义：
//   1) 预取成功写入 detail::vod::v1::（大池，30min TTL，与 Detail.load 同前缀同
//      TTL——点击路径零改动即命中）；
//   2) 同 key 在途去重（悬停+pointerdown 连发只发一次网络）；
//   3) 已有新鲜缓存不预取（零浪费）；
//   4) 并发护栏（扫过一列卡不超过 DETAIL_PREFETCH_LIMIT 个在途）；
//   5) 失败静默（点击后 Detail.load 自会正式请求，预取绝不影响主流程）。
//   （历史 ⑥：abortDetailPrefetch 清空在途——该函数无生产调用点，已随 L20 删除，
//   其「清表释放护栏槽位」语义由在途 Promise 自行 settle 摘链覆盖，对应用例同删。）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** VM 沙箱加载 common.js，注入最小桩（localStorage/网络/后端地址）。 */
function loadCommon() {
    const store = new Map();
    const ls = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        key: (i) => [...store.keys()][i] ?? null,
        get length() { return store.size; },
    };
    const calls = [];
    const context = {
        console: { warn: () => {}, log: () => {}, error: () => {}, info: () => {} },
        $: () => ({ on() {}, off() {}, find() { return { length: 0, each() {}, on() {} }; } }),
        // common.js 顶层有 document/CSP 桥接与事件委托（typeof 守卫只保 addEventListener
        // 缺失场景），VM 沙箱需提供最小 document 桩
        document: { addEventListener() {} },
        // doAction 请求体编码依赖 URLSearchParams（Node 全局，VM 沙箱不自动继承）
        URLSearchParams,
        setTimeout, clearTimeout, Date, Math, JSON, String, Number, Array, Object,
        Map, Set, Promise, Error, parseInt, parseFloat, isNaN, RegExp, Boolean,
        AbortSignal: { timeout: () => ({ addEventListener() {} }), any: () => ({}) },
        fetch: async (url, opts) => {
            const body = String((opts && opts.body) || '');
            const doMatch = body.match(/do=([^&]+)/);
            calls.push({ url: String(url), do: doMatch ? decodeURIComponent(doMatch[1]) : '' });
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify({ code: 1, list: [{ vod_id: 'v1', vod_name: '预取影片', vod_content: '简介文本', vod_play_from: '线路A', vod_play_url: '第1集$u1' }] }),
            };
        },
        window: { localStorage: ls },
        localStorage: ls,
        createRuntimeId: () => 'test-rid',
    };
    context.globalThis = context;
    vm.createContext(context);
    // cache.js 先于 common.js：prefetchDetail 依赖 localCacheGet/localCacheSet 全局。
    // cache.js IIFE 以 window 为 root 挂载（context 里 window 存在），浏览器中
    // window 即全局对象、裸标识符可达；VM 沙箱两realm分离，镜像一层对齐浏览器。
    vm.runInContext(read('src/renderer/js/cache.js'), context, { filename: 'cache.js' });
    vm.runInContext(`
        ;for (const k of ['localCacheGet','localCachePeek','localCacheSet','localCacheDel']) {
            if (window[k]) globalThis[k] = window[k];
        }
    `, context);
    vm.runInContext(read('src/renderer/js/common.js'), context, { filename: 'common.js' });
    // __calls 桥接：fetch 桩闭包引用 Node 侧 calls 数组，断言读 Node 侧同一数组
    //（fetch 桩的闭包变量就是 loadCommon 里的 calls，push 与断言同源，无需沙箱内转接）。
    context.__prefetchDetail = context.prefetchDetail; // common.js IIFE 以 globalThis 为 root 挂载
    context.__localCacheGet = context.localCacheGet || context.window.localCacheGet;
    context.__lsStore = ls;
    return { context, store, calls };
}

const flush = () => new Promise((r) => setImmediate(r));

test('prefetchDetail：成功写入 detail::vod::v1 大池缓存（30min TTL），点击路径零改动命中', async () => {
    const { context, store } = loadCommon();
    // 模拟 Detail 侧写读口径：同前缀同池
    const vod = await context.__prefetchDetail('site-a', 'v1');
    await flush();
    assert.ok(vod && vod.vod_name === '预取影片', '预取返回 vod');
    const raw = store.get('yuki_bigcache::detail::vod::v1::site-a|v1');
    assert.ok(raw, '结果应落大池 detail::vod 缓存（Detail.load 读同键命中秒出）');
    const obj = JSON.parse(raw);
    assert.equal(obj.v.vod_content, '简介文本', '简介随整包缓存');
    assert.ok(obj.e > Date.now() + 29 * 60 * 1000, 'TTL 30min');
});

test('prefetchDetail：同 key 在途去重（悬停+pointerdown 连发只发一次网络）', async () => {
    const { context, calls } = loadCommon();
    const p1 = context.__prefetchDetail('site-a', 'v1');
    const p2 = context.__prefetchDetail('site-a', 'v1'); // 在途重复调用
    assert.equal(p1, p2, '返回同一在途 Promise');
    // singleFlight 的 fn 经 Promise.resolve().then 派发：fetch 在下一微任务才发，
    // 计数断言必须等 flush 后取（同步读恒 0）
    await flush();
    assert.equal(calls.length, 1, '只发一次 HTTP');
});

test('prefetchDetail：已有新鲜缓存不预取（零浪费）', async () => {
    const { context, store } = loadCommon();
    context.__localCacheGet; // noop 引用
    // 预写一条新鲜缓存（模拟上一次打开留下的 detail::vod）
    const fresh = { v: { vod_name: '已缓存' }, e: Date.now() + 60000, t: Date.now() };
    store.set('yuki_bigcache::detail::vod::v1::site-a|v1', JSON.stringify(fresh));
    const r = context.__prefetchDetail('site-a', 'v1');
    assert.equal(r, undefined, '有新鲜缓存直接跳过');
});

test('prefetchDetail：并发护栏——超过上限的在途不再发起', async () => {
    const { context, store } = loadCommon();
    // 清空 store；让 fetch 挂起以维持「在途」
    store.clear();
    let release;
    const held = new Promise((res) => { release = res; });
    context.fetch = async (url, opts) => {
        const body = String((opts && opts.body) || '');
        const idm = body.match(/ids=([^&]+)/);
        context.__seenIds = context.__seenIds || [];
        context.__seenIds.push(decodeURIComponent(idm ? idm[1] : ''));
        await held;
        return { ok: true, text: async () => JSON.stringify({ code: 1, list: [{ vod_id: 'x' }] }) };
    };
    const r1 = context.__prefetchDetail('s', 'a');
    const r2 = context.__prefetchDetail('s', 'b');
    const r3 = context.__prefetchDetail('s', 'c');
    const r4 = context.__prefetchDetail('s', 'd'); // 第 4 个：超护栏
    assert.ok(r1 && r2 && r3, '前 3 个进入在途');
    assert.equal(r4, undefined, '第 4 个被并发护栏拒绝');
    // fetch 派发经 singleFlight 微任务：计数在 flush 后取
    await flush();
    assert.equal((context.__seenIds || []).length, 3, '实际只发 3 个请求');
    release({});
});

test('prefetchDetail：网络失败静默（不写缓存不抛错），点击后 Detail.load 自会重试', async () => {
    const { context, store } = loadCommon();
    context.fetch = async () => { throw new Error('net down'); };
    const vod = await context.__prefetchDetail('site-a', 'v1');
    await flush();
    assert.equal(vod, undefined, '失败返回 undefined（catch 兜底）');
    assert.equal(store.get('yuki_bigcache::detail::vod::v1::site-a|v1'), undefined, '失败不落缓存');
});
