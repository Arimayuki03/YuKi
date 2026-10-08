'use strict';
/**
 * common.js 渲染层 single-flight（B-06）白盒测试。
 *
 * 加载方式：fs.readFileSync + node:vm + 全局桩（照抄 tests/js/common-utils.test.js
 * 手法）。被测对象：
 * - singleFlight 泛化工具（对齐主进程 AsyncSingleFlight 语义：同 key 并发共享、
 *   settle 即删、失败不缓存）；
 * - doAction 去重层（key = action + path + 稳定序列化 kv；signal 调用方旁路；
 *   响应顶层浅拷贝防串台）；
 * - getJson 有意不参与去重的现状固化。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lax = require('node:assert'); // 宽松 deepEqual：比较 VM realm 里 JSON.parse 出的对象不查原型
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '../../src/renderer/js/common.js');

// ---------------------------------------------------------------- 极简 jQuery / DOM 桩（照抄 common-utils.test.js）

/** 链式 jQuery 桩：加载期只需 $(window).on / $(document).on 不抛错。 */
function jqOf(items) {
    const api = {
        length: items.length,
        get() { return items.slice(); },
        find() { return jqOf([]); },
        children() { return jqOf([]); },
        each(fn) { items.forEach((el, i) => fn.call(el, i, el)); return api; },
        addClass() { return api; }, removeClass() { return api; },
        hasClass() { return false; },
        on() { return api; }, off() { return api; }, empty() { return api; },
        html() { return api; }, text() { return api; }, css() { return api; },
        data() { return ''; }, removeAttr() { return api; },
    };
    return api;
}

/** 在 VM 中加载 common.js，注入最小全局桩；返回上下文（__api 为被测函数集合）。 */
function loadCommon(extra = {}) {
    const source = fs.readFileSync(SRC, 'utf8');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array,
        parseInt, parseFloat, setTimeout, clearTimeout, URLSearchParams,
        crypto: globalThis.crypto,
        $: (arg) => {
            if (arg && typeof arg === 'object') return jqOf([arg]);
            return jqOf([]);
        },
        getComputedStyle: () => ({ lineHeight: '20px' }),
        document: {
            addEventListener() {}, removeEventListener() {},
            querySelector: () => null, querySelectorAll: () => [],
            getElementById: () => null,
            createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false } }),
            documentElement: {
                classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                style: { setProperty() {}, removeProperty() {} },
                dataset: {},
            },
            body: { style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {} }, dataset: {} },
            head: { appendChild() {} },
        },
        window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        fetch: async () => ({ ok: true, text: async () => '' }),
        AbortSignal: { timeout: () => ({}), any: () => ({}) },
        ...extra,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}
;globalThis.__api = {
    createRuntimeId, setBackendInfo, apiUrl, doAction, _doActionSend, getJson,
    singleFlight, _stableKvString, _shareSafe, _doActionInflight,
};`, context, { filename: 'common.js' });
    return context;
}

const A = (ctx) => ctx.__api;

/** 手动放行 fetch 的加载环境：state.calls 计数 HTTP，state.resolvers 逐个放行/拒绝。 */
function loadWithFetch(extra = {}) {
    const state = { calls: [], resolvers: [] };
    const ctx = loadCommon({
        fetch: (url, opts) => {
            state.calls.push({ url, opts });
            return new Promise((res, rej) => state.resolvers.push({ res, rej }));
        },
        ...extra,
    });
    return { ctx, state };
}

/** 放行第 i 个在途 fetch（返回固定 JSON 文本）。 */
function settle(state, i, text = '{"code":200}') {
    state.resolvers[i].res({ ok: true, text: async () => text });
}

/** 拒绝第 i 个在途 fetch。 */
function boom(state, i, msg = 'boom') {
    state.resolvers[i].rej(new Error(msg));
}

/** 宏任务 flush：把 pending 微任务（settle 摘链回调等）全部跑完。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- singleFlight 泛化工具

test('singleFlight：同 key 并发只执行一次，返回同一 Promise；settle 后摘链', async () => {
    const { singleFlight } = A(loadCommon());
    const map = new Map();
    const resolvers = []; // 每次执行 fn 各占一对 {res, rej}
    const fn = () => new Promise((res, rej) => resolvers.push({ res, rej }));
    const p1 = singleFlight(fn, 'k', map);
    const p2 = singleFlight(fn, 'k', map);
    const p3 = singleFlight(fn, 'k', map);
    await Promise.resolve(); // fn 经 Promise.resolve().then 调度，先 flush 再断言
    assert.equal(resolvers.length, 1, '同 key 只执行一次');
    assert.ok(p1 === p2 && p2 === p3, '并发调用共享同一 Promise');
    assert.equal(map.size, 1, '在途期间保留在 Map');
    resolvers[0].res('ok');
    assert.equal(await p3, 'ok');
    await flush();
    assert.equal(map.size, 0, '响应即删');
    const p4 = singleFlight(fn, 'k', map); // 摘链后同 key 重新执行（非持久缓存）
    await Promise.resolve();
    assert.equal(resolvers.length, 2, 'settle 后重新执行 fn');
    resolvers[1].res('again');
    assert.equal(await p4, 'again');
});

test('singleFlight：失败共享且不缓存——同批调用同 reject，摘链后重试重新执行', async () => {
    const { singleFlight } = A(loadCommon());
    const map = new Map();
    const resolvers = []; // 每次执行 fn 各占一对 {res, rej}
    const fn = () => new Promise((res, rej) => resolvers.push({ res, rej }));
    const p1 = singleFlight(fn, 'k', map);
    const p2 = singleFlight(fn, 'k', map);
    await Promise.resolve();
    assert.equal(resolvers.length, 1);
    resolvers[0].rej(new Error('net down'));
    await assert.rejects(p1, /net down/);
    await assert.rejects(p2, /net down/);
    await flush();
    assert.equal(map.size, 0, '失败同样摘链（失败不缓存）');
    const p3 = singleFlight(fn, 'k', map);
    await Promise.resolve();
    assert.equal(resolvers.length, 2, '失败后重试重新执行 fn');
    resolvers[1].res('fine');
    assert.equal(await p3, 'fine');
});

test('singleFlight：不同 key 互不共享；缺省 map 按 fn 分桶（不同 fn 同 key 互不串台）', async () => {
    const { singleFlight } = A(loadCommon());
    const map = new Map();
    const resolvers = []; // 每次执行 fn 各占一对 {res, rej}
    const fn = () => new Promise((res, rej) => resolvers.push({ res, rej }));
    const pa = singleFlight(fn, 'k1', map);
    const pb = singleFlight(fn, 'k2', map);
    await Promise.resolve();
    assert.equal(map.size, 2, '不同 key 各自在途');
    resolvers[0].res(1); resolvers[1].res(2);
    assert.equal(await pa, 1);
    assert.equal(await pb, 2);

    // 缺省 map：按 fn 分桶，两个不同 fn 用同名 key 各跑各的
    const ran = [];
    const f1 = async () => { ran.push('f1'); return 'a'; };
    const f2 = async () => { ran.push('f2'); return 'b'; };
    assert.equal(await singleFlight(f1, 'shared'), 'a');
    assert.equal(await singleFlight(f2, 'shared'), 'b');
    assert.deepEqual(ran, ['f1', 'f2']);
});

// ---------------------------------------------------------------- doAction 去重层

test('doAction：同 key 并发 3 次只发 1 个 HTTP，三方拿到等值响应且在途 Map 清空', async () => {
    const { ctx, state } = loadWithFetch();
    const { doAction } = A(ctx);
    const p1 = doAction('detailContent', { site: 'a', ids: '[1]' });
    const p2 = doAction('detailContent', { site: 'a', ids: '[1]' });
    const p3 = doAction('detailContent', { site: 'a', ids: '[1]' });
    await Promise.resolve();
    assert.equal(state.calls.length, 1, '并发 3 次只发 1 个 HTTP');
    assert.equal(A(ctx)._doActionInflight.size, 1, '在途期间去重 Map 持有 1 条');
    settle(state, 0, '{"list":[{"vod_id":1}]}');
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    const want = { list: [{ vod_id: 1 }] };
    lax.deepEqual(r1, want);
    lax.deepEqual(r2, want);
    lax.deepEqual(r3, want);
    assert.ok(r1 !== r2 && r2 !== r3, '每个调用方拿到独立顶层对象（_shareSafe 防串台）');
    await flush();
    assert.equal(A(ctx)._doActionInflight.size, 0, '响应后 Map 清空');
    // 第二次调用重新发（响应即删，非持久缓存）
    const p4 = doAction('detailContent', { site: 'a', ids: '[1]' });
    await Promise.resolve();
    assert.equal(state.calls.length, 2, 'settle 后同 key 重新发请求');
    settle(state, 1);
    lax.deepEqual(await p4, { code: 200 });
});

test('doAction：失败不缓存——并发共享同一次失败，重试重新发 HTTP', async () => {
    const { ctx, state } = loadWithFetch();
    const { doAction } = A(ctx);
    const p1 = doAction('homeContent', { site: 'dead' });
    const p2 = doAction('homeContent', { site: 'dead' });
    await Promise.resolve();
    assert.equal(state.calls.length, 1, '并发期间仍只发 1 个');
    boom(state, 0, 'socket hang up');
    await assert.rejects(p1, /socket hang up/);
    await assert.rejects(p2, /socket hang up/);
    await flush();
    assert.equal(A(ctx)._doActionInflight.size, 0, '失败同样摘链');
    const p3 = doAction('homeContent', { site: 'dead' });
    await Promise.resolve();
    assert.equal(state.calls.length, 2, '失败后重试重新发');
    settle(state, 1);
    lax.deepEqual(await p3, { code: 200 });
});

test('doAction：不同 kv / 不同 action / 不同 path 互不共享', async () => {
    const { ctx, state } = loadWithFetch();
    const { doAction } = A(ctx);
    doAction('homeContent', { site: 'a' });
    doAction('homeContent', { site: 'b' });   // kv 不同
    doAction('categoryContent', { site: 'a' }); // action 不同
    doAction('homeContent', { site: 'a' }, '/kazumi/action'); // path 不同
    await Promise.resolve();
    assert.equal(state.calls.length, 4, '四个不同 key 各自发请求');
    assert.ok(state.calls[3].url.includes('/kazumi/action'), 'path 参与请求目标');
    state.resolvers.forEach((r, i) => settle(state, i));
    await flush();
    assert.equal(A(ctx)._doActionInflight.size, 0);
});

test('doAction：去重键对 kv 键序稳定——键序不同的字面量命中同一在途请求', async () => {
    const { ctx, state } = loadWithFetch();
    const { doAction, _stableKvString } = A(ctx);
    assert.equal(_stableKvString({ b: '2', a: '1' }), _stableKvString({ a: '1', b: '2' }),
        '键排序后序列化，键序不影响 key');
    assert.equal(_stableKvString(null), '', '无 kv 归一为空串');
    const p1 = doAction('searchContent', { site: 'a', word: 'x', quick: '0' });
    const p2 = doAction('searchContent', { quick: '0', word: 'x', site: 'a' });
    await Promise.resolve();
    assert.equal(state.calls.length, 1, '键序不同内容相同的并发调用共享 1 个 HTTP');
    settle(state, 0);
    lax.deepEqual(await p1, { code: 200 });
    lax.deepEqual(await p2, { code: 200 });
});

test('doAction：请求体仍是 kv 原值表单编码（去重不改变发出的请求内容）', async () => {
    const { ctx, state } = loadWithFetch();
    const { doAction } = A(ctx);
    const p = doAction('kazumiAdd', { json: '{"name":"r"}' }, '/kazumi/action');
    await Promise.resolve();
    const body = new URLSearchParams(state.calls[0].opts.body);
    assert.equal(body.get('do'), 'kazumiAdd');
    assert.equal(body.get('json'), '{"name":"r"}');
    assert.ok(body.get('requestId'), 'requestId 照常生成（追踪用）');
    assert.equal(state.calls[0].opts.headers['X-Request-Id'], body.get('requestId'));
    settle(state, 0);
    await p;
});

test('doAction：传 options.signal 的调用方旁路去重（世代 signal 不跨代共享）', async () => {
    const { ctx, state } = loadWithFetch();
    const { doAction } = A(ctx);
    const sig = { aborted: false };
    doAction('homeContent', { site: 'a' }, undefined, { signal: sig });
    doAction('homeContent', { site: 'a' }, undefined, { signal: sig });
    doAction('homeContent', { site: 'a' }); // 无 signal 的同 key 调用与 signal 旁路调用也互不共享
    await Promise.resolve();
    assert.equal(state.calls.length, 3, 'signal 调用方各自直发，不加入去重');
    state.resolvers.forEach((r, i) => settle(state, i));
    await flush();
});

test('doAction：响应为原始文本（JSON 解析失败回落）时原样透传', async () => {
    const { ctx, state } = loadWithFetch();
    const { doAction } = A(ctx);
    const pText = doAction('fetchText', { url: 'https://x' });
    await Promise.resolve();
    settle(state, 0, 'plain text not json');
    assert.equal(await pText, 'plain text not json');
    await flush();
});

test('getJson：不参与去重——两次并发各发各的（现状固化：/sites 轮询无双击路径）', async () => {
    const { ctx, state } = loadWithFetch();
    const { getJson } = A(ctx);
    const p1 = getJson('/sites');
    const p2 = getJson('/sites');
    await Promise.resolve();
    assert.equal(state.calls.length, 2, 'getJson 保持逐次直发');
    settle(state, 0, '[]');
    settle(state, 1, '[]');
    assert.deepEqual(await p1, []);
    assert.deepEqual(await p2, []);
});
