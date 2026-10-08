'use strict';
// B-07 回归测试：kazumi.js bangumiEpisodes 30min localStorage 持久缓存。
// 1) 首次走网络并落缓存（键 kazumi_bgm_eps::{id}，经 cache.js 命名空间 yuki_cache::，
//    TTL 30 分钟，对齐 bangumiInfo 缓存口径）
// 2) 二次命中缓存零网络（「分集」页签二次打开秒出）
// 3) 畸形缓存（非数组且非 {data:[]} 形态）丢弃安全走网络，并以网络结果回写
// 4) TTL 过期后重新走网络（直接改写落盘条目的过期时间戳，复用 cache.js 真实过期判定）
// 5) 网络失败/空结果不落缓存，resolve(null) 语义与加缓存前一致（返回契约不变）
// 测试同时以 vm 加载真实 cache.js，让 localCacheGet/Set 的 TTL 语义走真实实现。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 内存版 localStorage 桩（cache.js 依赖 getItem/setItem/removeItem/key/length）。 */
function makeLs() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
        setItem: (k, v) => { m.set(String(k), String(v)); },
        removeItem: (k) => { m.delete(String(k)); },
        key: (i) => {
            const arr = Array.from(m.keys());
            return i < arr.length ? arr[i] : null;
        },
        get length() { return m.size; },
    };
}

function loadKazumiWithCache(extra = {}) {
    const ls = makeLs();
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        parseInt, parseFloat, setTimeout, clearTimeout,
        $: () => ({ on() { return this; } }),
        warnToast() {},
        escHtml: (s) => String(s),
        document: {
            addEventListener() {},
            getElementById: () => null,
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
            body: { appendChild() {} },
        },
        window: { localStorage: ls },
        ...extra,
    };
    context.globalThis = context;
    vm.createContext(context);
    // 先加载 cache.js：root 取 window，localCacheGet/Set 挂在 window 上
    vm.runInContext(read('src/renderer/js/cache.js'), context, { filename: 'cache.js' });
    // 提为 context 顶层全局，供 kazumi.js 以裸标识符 typeof localCacheGet 访问
    context.localCacheGet = context.window.localCacheGet;
    context.localCacheSet = context.window.localCacheSet;
    vm.runInContext(read('src/renderer/js/kazumi.js'), context, { filename: 'kazumi.js' });
    return { K: context.window.YUKI && context.window.YUKI.kazumi, ls };
}

/** 读取落盘条目（cache.js 载荷 {v,e,t}）。 */
function readEntry(ls, subjectId) {
    const raw = ls.getItem('yuki_cache::kazumi_bgm_eps::' + subjectId);
    return raw ? JSON.parse(raw) : null;
}

/** vm 上下文里创建的对象与宿主realm原型不同，deepStrictEqual 会判不等；先 JSON 归一。 */
const norm = (x) => JSON.parse(JSON.stringify(x));

const EPISODES_100 = { data: [{ id: 1, ep: 1, name: '第一集', type: 0 }, { id: 2, ep: 2, name: '第二集', type: 0 }], total: 2 };

test('bangumiEpisodes：首次走网络并落缓存（键/TTL/载荷正确）', async () => {
    const calls = [];
    const { K, ls } = loadKazumiWithCache({
        doAction: async (doName, form) => {
            calls.push({ doName, form });
            return { code: 200, episodes: EPISODES_100 };
        },
    });
    const out = await K.bangumiEpisodes(100);
    assert.equal(calls.length, 1, '首次走网络');
    assert.equal(calls[0].doName, 'kazumiBangumiEpisodes');
    assert.deepEqual(calls[0].form && { id: calls[0].form.id }, { id: 100 });
    assert.deepEqual(norm(out), EPISODES_100, '返回值与网络结果一致（契约不变）');
    // 落缓存：独立前缀 kazumi_bgm_eps:: + subject id，经 cache.js 命名空间
    const entry = readEntry(ls, 100);
    assert.ok(entry, '已写入 localStorage');
    assert.deepEqual(norm(entry.v), EPISODES_100);
    assert.ok(entry.e > Date.now() + 29 * 60 * 1000 && entry.e <= Date.now() + 30 * 60 * 1000 + 50,
        'TTL 为 30 分钟');
});

test('bangumiEpisodes：二次命中缓存零网络，返回值一致', async () => {
    const calls = [];
    const { K } = loadKazumiWithCache({
        doAction: async (doName, form) => {
            calls.push({ doName, form });
            return { code: 200, episodes: EPISODES_100 };
        },
    });
    const first = await K.bangumiEpisodes(100);
    const second = await K.bangumiEpisodes('100');
    assert.equal(calls.length, 1, '二次命中缓存不发请求（数字/字符串 id 同键）');
    assert.deepEqual(norm(second), norm(first));
    assert.deepEqual(norm(second), EPISODES_100);
});

test('bangumiEpisodes：畸形缓存安全走网络并以网络结果回写', async () => {
    const calls = [];
    const { K, ls } = loadKazumiWithCache({
        doAction: async (doName, form) => {
            calls.push({ form });
            return { code: 200, episodes: EPISODES_100 };
        },
    });
    const now = Date.now();
    // 两种畸形形态：非对象标量 / 缺 data 数组的对象，均未过期（排除 TTL 干扰）
    ls.setItem('yuki_cache::kazumi_bgm_eps::300', JSON.stringify({ v: 'junk', e: now + 60000, t: now }));
    ls.setItem('yuki_cache::kazumi_bgm_eps::301', JSON.stringify({ v: { data: { nope: 1 } }, e: now + 60000, t: now }));
    const a = await K.bangumiEpisodes(300);
    const b = await K.bangumiEpisodes(301);
    assert.equal(calls.length, 2, '畸形缓存均丢弃走网络');
    assert.deepEqual(norm(a), EPISODES_100);
    assert.deepEqual(norm(b), EPISODES_100);
    // 回写为网络结果（下次命中）
    assert.deepEqual(norm(readEntry(ls, 300).v), EPISODES_100);
    assert.deepEqual(norm(readEntry(ls, 301).v), EPISODES_100);
});

test('bangumiEpisodes：TTL 过期后重新走网络', async () => {
    const calls = [];
    const { K, ls } = loadKazumiWithCache({
        doAction: async (doName, form) => {
            calls.push({ form });
            return { code: 200, episodes: EPISODES_100 };
        },
    });
    await K.bangumiEpisodes(100);
    assert.equal(calls.length, 1);
    // 直接把落盘条目的过期时间戳拨到过去（复用 cache.js 真实过期判定，免假时钟）
    const entry = readEntry(ls, 100);
    entry.e = Date.now() - 1;
    ls.setItem('yuki_cache::kazumi_bgm_eps::100', JSON.stringify(entry));
    const again = await K.bangumiEpisodes(100);
    assert.equal(calls.length, 2, '过期后重新走网络');
    assert.deepEqual(norm(again), EPISODES_100);
});

test('bangumiEpisodes：网络失败不落缓存且 resolve(null)（契约不变）', async () => {
    const { K, ls } = loadKazumiWithCache({
        doAction: async () => { throw new Error('network down'); },
    });
    const out = await K.bangumiEpisodes(100);
    assert.equal(out, null, '失败返回 null，与加缓存前一致');
    assert.equal(readEntry(ls, 100), null, '失败不落缓存');
});

test('bangumiEpisodes：空结果（episodes 缺失）不落缓存', async () => {
    const { K, ls } = loadKazumiWithCache({
        doAction: async () => ({ code: 200 }),
    });
    const out = await K.bangumiEpisodes(100);
    assert.equal(out, null);
    assert.equal(readEntry(ls, 100), null, '空结果不写缓存防毒化');
});

test('bangumiEpisodes：localCacheGet 不可用时退化为直连网络（typeof 守卫）', async () => {
    const calls = [];
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        parseInt, parseFloat, setTimeout, clearTimeout,
        $: () => ({ on() { return this; } }),
        warnToast() {},
        escHtml: (s) => String(s),
        document: { addEventListener() {}, getElementById: () => null },
        window: {},
        doAction: async (doName, form) => { calls.push({ doName, form }); return { code: 200, episodes: EPISODES_100 }; },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/js/kazumi.js'), context, { filename: 'kazumi.js' });
    const K = context.window.YUKI.kazumi;
    const out = await K.bangumiEpisodes(100);
    assert.equal(calls.length, 1, '无缓存层时直连网络');
    assert.deepEqual(norm(out), EPISODES_100, '返回契约不变');
});
