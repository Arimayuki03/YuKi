/**
 * src/renderer/js/cache.js 白盒单元测试（渲染层核心业务数据本地持久化）。
 *
 * 与已有测试的互补分工：
 *  - tests/js/timeline-cache.test.js / popular-cache.test.js：站在**业务模块**视角，
 *    用 cache.js 做真实读写链路，只覆盖它们自己用到的那条路径；
 *  本文件站在**缓存层本身**视角，覆盖 cache.js 的全部对外契约：
 *    读写往返 / TTL 过期与惰性删除 / 容量淘汰（LRU-by-write-time）/
 *    命名空间隔离与前缀清理 / 损坏数据兜底 / 序列化边界（大对象、循环引用、
 *    undefined、函数、Symbol、BigInt）/ 并发写入安全 / 无 localStorage 降级。
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const CACHE_SRC = fs.readFileSync(path.join(ROOT, 'src/renderer/js/cache.js'), 'utf8');

/** 内存 localStorage 桩：完整实现 getItem/setItem/removeItem/key(i)/length。 */
function makeLs(sharedStore) {
    const store = sharedStore || new Map();
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        key: (i) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
        __store: store,
    };
}

/**
 * 在 VM 中加载 cache.js；localStorage 由调用方注入（可为 null 模拟不可用）。
 * 注意：cache.js 的 root 取 `typeof window !== 'undefined' ? window : globalThis`，
 * 本桩注入了 window，因此全部导出（localCache* 与 window.YUKI.cache）都挂在
 * context.window 上，读 API 必须经 window 取。
 */
function loadCache(ls) {
    const context = {
        console, Date, Math, JSON, String, Number, Object, Array, Error, isNaN,
        parseInt, parseFloat, Symbol, BigInt,
        window: { localStorage: ls },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(CACHE_SRC, context, { filename: 'cache.js' });
    return context;
}

/** 便捷：加载带内存 localStorage 的 cache.js，返回 { api, raw, ls, store }。 */
function boot(sharedStore) {
    const ls = makeLs(sharedStore);
    const ctx = loadCache(ls);
    return { api: ctx.window.YUKI.cache, raw: ctx.window, ls, store: ls.__store };
}

/** 直接改写某条缓存的包装字段（e/t），用于精确构造 TTL 边界。 */
function patchExpiry(store, key, patch) {
    const full = key.startsWith('yuki_cache::') ? key : 'yuki_cache::' + key;
    const obj = JSON.parse(store.get(full));
    Object.assign(obj, patch);
    store.set(full, JSON.stringify(obj));
}

// ================================================================ 读写往返

describe('cache.js · 读写往返', () => {
    test('set→get 往返：对象/数组/字符串/数字/布尔原样还原', () => {
        const { api } = boot();
        assert.equal(api.set('k1', { a: 1, b: [1, 2] }, 60000), true);
        assert.deepEqual(api.get('k1'), { a: 1, b: [1, 2] });
        api.set('k2', '文本', 60000);
        assert.equal(api.get('k2'), '文本');
        api.set('k3', 42, 60000);
        assert.equal(api.get('k3'), 42);
        api.set('k4', false, 60000);
        assert.equal(api.get('k4'), false, 'falsy 值不得被当作未命中');
        api.set('k5', 0, 60000);
        assert.equal(api.get('k5'), 0, '0 是有效缓存值');
    });

    test('写入落盘结构为 { v, e, t }，e 为过期时间戳、t 为写入时间戳', () => {
        const { api, store } = boot();
        const now = Date.now();
        api.set('k', { a: 1 }, 5000);
        const saved = JSON.parse(store.get('yuki_cache::k'));
        assert.deepEqual(saved.v, { a: 1 });
        assert.ok(saved.e >= now + 5000 && saved.e <= Date.now() + 5000, 'e = now + ttl');
        assert.ok(saved.t >= now && saved.t <= Date.now(), 't = 写入时刻');
    });

    test('覆盖写：同 key 再次写入返回新值，且只占一条存储', () => {
        const { api, store } = boot();
        api.set('k', { v: 1 }, 60000);
        api.set('k', { v: 2 }, 60000);
        assert.deepEqual(api.get('k'), { v: 2 });
        assert.equal(store.size, 1);
    });

    test('del：删除指定条目，其它条目不受影响；删不存在的 key 不抛错', () => {
        const { api } = boot();
        api.set('a', 1, 60000);
        api.set('b', 2, 60000);
        api.del('a');
        assert.equal(api.get('a'), null);
        assert.equal(api.get('b'), 2);
        api.del('ghost'); // 不抛错即通过
    });

    test('全局函数与 YUKI.cache 命名空间指向同一实现', () => {
        const { raw, api } = boot();
        assert.equal(raw.localCacheGet, api.get);
        assert.equal(raw.localCacheSet, api.set);
        assert.equal(raw.localCacheDel, api.del);
        assert.equal(raw.localCacheClearAll, api.clearAll);
        assert.equal(raw.localCacheStats, api.stats);
        assert.equal(raw.localCachePrune, api.prune);
    });
});

// ================================================================ TTL 语义

describe('cache.js · TTL 语义', () => {
    test('TTL 内命中，TTL 过期返回 null 并惰性删除', () => {
        const { api, store } = boot();
        api.set('k', { a: 1 }, 60000);
        assert.deepEqual(api.get('k'), { a: 1 }, '新鲜期内命中');
        patchExpiry(store, 'k', { e: Date.now() - 1 });
        assert.equal(api.get('k'), null, '过期即未命中');
        assert.equal(store.has('yuki_cache::k'), false, '过期条目读时惰性删除');
    });

    test('边界：e 恰等于 now 视为过期（>= 判定）', () => {
        const { api, store } = boot();
        api.set('k', { a: 1 }, 60000);
        patchExpiry(store, 'k', { e: Date.now() });
        assert.equal(api.get('k'), null);
    });

    test('ttl <= 0 或省略 → e=0 永不过期', () => {
        const { api, store } = boot();
        api.set('perm1', { a: 1 }, 0);
        api.set('perm2', { a: 2 }, -100);
        api.set('perm3', { a: 3 });
        for (const k of ['perm1', 'perm2', 'perm3']) {
            assert.equal(JSON.parse(store.get('yuki_cache::' + k)).e, 0, k + ' 的 e 应为 0（永久）');
        }
        assert.deepEqual(api.get('perm1'), { a: 1 });
        assert.deepEqual(api.get('perm2'), { a: 2 });
        assert.deepEqual(api.get('perm3'), { a: 3 }, '省略 ttl 同样按永久处理');
    });

    test('永久条目（e=0）不参与过期统计与清理', () => {
        const { api, store } = boot();
        api.set('perm', { a: 1 }, 0);   // 永久
        api.set('exp', { a: 1 }, 60000); // 有 TTL，先保持新鲜
        assert.equal(api.prune(), 0, '无过期条目时清理 0 条');
        assert.equal(api.stats().expired, 0);
        assert.equal(api.stats().count, 2);
        // 把有 TTL 的那条推进到过期：永久条目仍不得被清理
        patchExpiry(store, 'exp', { e: Date.now() - 1 });
        assert.equal(api.stats().expired, 1, '只统计有 TTL 且已过期的条目');
        assert.equal(api.prune(), 1, '只清理到期的那条');
        assert.equal(api.get('perm').a, 1, '永久条目始终保留（e=0 永不过期）');
        assert.equal(api.get('exp'), null);
    });

    test('prune：只清理已过期条目，返回删除数，永久与新鲜条目保留', () => {
        const { api, store } = boot();
        api.set('fresh', { a: 1 }, 60000);
        api.set('perm', { a: 1 }, 0);
        api.set('gone', { a: 1 }, 1000);
        patchExpiry(store, 'gone', { e: Date.now() - 1 });
        assert.equal(api.prune(), 1, '只删 1 条过期条目');
        assert.equal(api.get('gone'), null);
        assert.deepEqual(api.get('fresh'), { a: 1 });
        assert.deepEqual(api.get('perm'), { a: 1 });
        assert.equal(api.prune(), 0, '再清理无可清理项');
    });

    test('stats：返回 bytes/count/expired，bytes 为键+值字符长度之和', () => {
        const { api, store } = boot();
        api.set('a', { x: 1 }, 60000);
        api.set('b', { x: 2 }, 60000); // 先都保持新鲜，避免 1ms TTL 在断言间自然过期
        const st = api.stats();
        assert.equal(st.count, 2);
        assert.equal(st.expired, 0, '两条都未过期');
        const raw = store.get('yuki_cache::a');
        assert.equal(st.bytes, ('yuki_cache::a'.length + raw.length) + ('yuki_cache::b'.length + store.get('yuki_cache::b').length));
        patchExpiry(store, 'b', { e: Date.now() - 1 }); // 手动把 b 推进到过期
        assert.equal(api.stats().expired, 1, '过期后统计为 1');
    });

    test('stats/prune：损坏条目不计入 expired 也不被清理（解析失败即跳过）', () => {
        const { api, store } = boot();
        store.set('yuki_cache::broken', '{not json');
        const st = api.stats();
        assert.equal(st.count, 1, '损坏条目仍计入条目数');
        assert.equal(st.expired, 0, '解析失败不计过期');
        assert.equal(api.prune(), 0, '损坏条目不被 prune 清理');
    });
});

// ================================================================ 容量淘汰

describe('cache.js · 容量上限与淘汰', () => {
    test('单条目超过 ~1.5MB → 写入失败返回 false，且不动其它条目', () => {
        const { api } = boot();
        api.set('warm', { a: 1 }, 60000);
        const big = 'x'.repeat(Math.ceil(1.6 * 1024 * 1024));
        assert.equal(api.set('huge', big, 60000), false);
        assert.equal(api.get('huge'), null);
        assert.deepEqual(api.get('warm'), { a: 1 }, '不把已有条目淘汰掉');
    });

    test('累积超限 → 按最旧写入时间(t)淘汰，直到可容纳新条目', () => {
        const { api } = boot();
        const chunk = 'y'.repeat(560 * 1024); // 约 0.56MB/条：写第 3 条时必然超限
        api.set('k0', chunk, 60000);
        api.set('k1', chunk, 60000);
        api.set('k2', chunk, 60000);
        assert.equal(api.get('k0'), null, '最旧 k0 被淘汰');
        assert.equal(api.get('k1').length, chunk.length, '较新的 k1 保留');
        assert.equal(api.get('k2').length, chunk.length, '最新 k2 保留');
    });

    test('淘汰按 t 升序：手动把新条的 t 调到最旧，被淘汰的是它而非先写的', () => {
        const { api, store } = boot();
        const chunk = 'z'.repeat(560 * 1024);
        api.set('old', chunk, 60000);
        api.set('new', chunk, 60000);
        patchExpiry(store, 'new', { t: 1 }); // 新条 t 被改成最早
        api.set('third', chunk, 60000);
        assert.equal(api.get('new'), null, 't 最小者先被淘汰');
        assert.equal(api.get('old').length, chunk.length, '写入更早但 t 更大的条目保留');
        assert.equal(api.get('third').length, chunk.length);
    });

    test('覆盖写自身不计入容量增长（先减去旧值体积）', () => {
        const { api, store } = boot();
        const chunk = 'w'.repeat(500 * 1024);
        for (let i = 0; i < 3; i++) api.set('same', chunk, 60000); // 反复覆盖同一 key
        assert.equal(api.get('same').length, chunk.length, '覆盖写后仍可读');
        assert.equal(store.size, 1, '始终只有一条');
        assert.ok(api.stats().bytes < 1.5 * 1024 * 1024, '覆盖写不撑爆容量');
    });

    test('setItem 抛 QuotaExceededError → 激进淘汰后重试；仍失败则静默返回 false', () => {
        const { api, ls } = boot();
        const realSet = ls.setItem.bind(ls);
        let calls = 0;
        ls.setItem = (k, v) => {
            calls++;
            if (calls === 1) { const err = new Error('quota'); err.name = 'QuotaExceededError'; throw err; }
            return realSet(k, v);
        };
        assert.equal(api.set('k', { a: 1 }, 60000), true, '淘汰重试后写入成功');
        assert.deepEqual(api.get('k'), { a: 1 });

        ls.setItem = () => { const err = new Error('quota'); err.name = 'QuotaExceededError'; throw err; };
        assert.equal(api.set('k2', { a: 1 }, 60000), false, '两次都失败则放弃，不抛错');
    });

    test('容量边界：接近上限但不超限的条目仍能写入', () => {
        const { api } = boot();
        const near = 'q'.repeat(Math.floor(1.4 * 1024 * 1024));
        assert.equal(api.set('near', near, 60000), true);
        assert.equal(api.get('near').length, near.length);
    });
});

// ================================================================ 命名空间隔离

describe('cache.js · 命名空间隔离与前缀清理', () => {
    test('所有写入都带 yuki_cache:: 前缀', () => {
        const { api, store } = boot();
        api.set('biz', { a: 1 }, 60000);
        assert.deepEqual(Array.from(store.keys()), ['yuki_cache::biz']);
    });

    test('clearAll：只清本命名空间，保留其它业务键（如 kazumi_bgm_cover）', () => {
        const { api, store } = boot();
        api.set('a', 1, 60000);
        api.set('b', 2, 60000);
        store.set('kazumi_bgm_cover', '{"x":1}');
        store.set('yuki_home_empty_classes', '{}');
        assert.equal(api.clearAll(), 2, '返回删除条目数');
        assert.equal(store.has('kazumi_bgm_cover'), true, '非本命名空间键保留');
        assert.equal(store.has('yuki_home_empty_classes'), true, '不带 yuki_cache:: 前缀的键保留');
        assert.equal(store.has('yuki_cache::a'), false);
    });

    test('clearAll：空存储返回 0；stats 不统计其它命名空间的键', () => {
        const { api, store } = boot();
        store.set('other_key', 'value');
        assert.equal(api.clearAll(), 0);
        const st = api.stats();
        assert.equal(st.count, 0);
        assert.equal(st.bytes, 0);
    });

    test('不同业务前缀（detail::vod vs detail::bgmextra）互不覆盖', () => {
        const { api } = boot();
        api.set('detail::vod::v1::s|1', { kind: 'vod' }, 60000);
        api.set('detail::bgmextra::v1::s|1', { kind: 'bgm' }, 60000);
        assert.deepEqual(api.get('detail::vod::v1::s|1'), { kind: 'vod' });
        assert.deepEqual(api.get('detail::bgmextra::v1::s|1'), { kind: 'bgm' });
    });

    test('get/del 均按完整键定位：前缀相同但后缀不同互不干扰', () => {
        const { api } = boot();
        api.set('site|1', { a: 1 }, 60000);
        api.set('site|11', { a: 2 }, 60000);
        api.del('site|1');
        assert.equal(api.get('site|1'), null);
        assert.deepEqual(api.get('site|11'), { a: 2 }, '前缀相同的邻键不受影响');
    });
});

// ================================================================ 损坏数据兜底

describe('cache.js · 损坏数据兜底', () => {
    test('JSON 损坏 → get 返回 null 并删除该条目（自愈）', () => {
        const { api, store } = boot();
        store.set('yuki_cache::bad', '{broken');
        assert.equal(api.get('bad'), null);
        assert.equal(store.has('yuki_cache::bad'), false, '损坏条目被移除');
    });

    test('解析出非对象（字符串/数字/null）→ 视为未命中；数组包装因无 v 字段同样未命中', () => {
        const { api, store } = boot();
        store.set('yuki_cache::s', JSON.stringify('str'));
        store.set('yuki_cache::n', JSON.stringify(5));
        store.set('yuki_cache::null', JSON.stringify(null));
        store.set('yuki_cache::arr', JSON.stringify([1, 2]));
        assert.equal(api.get('s'), null, '字符串包装不可信');
        assert.equal(api.get('n'), null);
        assert.equal(api.get('null'), null);
        assert.equal(api.get('arr'), null, '裸数组无 v 字段 → 按未命中（不抛错）');
    });

    test('v 字段缺失（undefined）→ 返回 null；v 为空串/0/false 仍算命中', () => {
        const { api, store } = boot();
        store.set('yuki_cache::nov', JSON.stringify({ e: 0, t: Date.now() }));
        assert.equal(api.get('nov'), null, '无 v 字段按未命中');
        store.set('yuki_cache::empty', JSON.stringify({ v: '', e: 0, t: Date.now() }));
        assert.equal(api.get('empty'), '', '空串是有效值');
        store.set('yuki_cache::zero', JSON.stringify({ v: 0, e: 0, t: Date.now() }));
        assert.equal(api.get('zero'), 0, '0 是有效值');
    });

    test('空字符串存储值 → 按未命中返回 null（不抛错）', () => {
        const { api, store } = boot();
        store.set('yuki_cache::blank', '');
        assert.equal(api.get('blank'), null);
    });

    test('getItem/removeItem 抛异常 → 静默返回 null，不向外抛出', () => {
        const { api, ls } = boot();
        ls.getItem = () => { throw new Error('SecurityError'); };
        assert.equal(api.get('any'), null);
        ls.removeItem = () => { throw new Error('SecurityError'); };
        api.del('any'); // 不抛错即通过
        assert.equal(api.prune(), 0, 'prune 内部 removeItem 失败被忽略后仍返回计数');
    });
});

// ================================================================ 序列化边界

describe('cache.js · 序列化边界', () => {
    test('大对象：1 万条数组往返完整还原', () => {
        const { api } = boot();
        const big = Array.from({ length: 10000 }, (_, i) => ({ id: i, name: 'n' + i }));
        assert.equal(api.set('big', big, 60000), true);
        const got = api.get('big');
        assert.equal(got.length, 10000);
        assert.deepEqual(got[9999], { id: 9999, name: 'n9999' });
    });

    test('循环引用：set 返回 false 且不写入（JSON.stringify 抛错被吞）', () => {
        const { api, store } = boot();
        const cyc = { a: 1 };
        cyc.self = cyc;
        assert.equal(api.set('cyc', cyc, 60000), false);
        assert.equal(store.size, 0, '序列化失败不落盘');
        assert.equal(api.get('cyc'), null);
    });

    test('含 undefined 字段：序列化后该字段丢失，其余字段保留', () => {
        const { api } = boot();
        assert.equal(api.set('u', { a: 1, b: undefined }, 60000), true);
        const got = api.get('u');
        assert.equal(got.a, 1);
        assert.equal('b' in got, false, 'undefined 字段在 JSON 序列化中丢失');
    });

    test('函数字段：函数被丢弃（值为函数本身时整体序列化为空对象结构）', () => {
        const { api } = boot();
        assert.equal(api.set('f', { a: 1, fn: () => 2 }, 60000), true);
        const got = api.get('f');
        assert.equal(got.a, 1);
        assert.equal(got.fn, undefined, '函数不可序列化，被丢弃');
        // 顶层值本身就是函数：JSON.stringify(fn) → undefined，写入 "undefined"
        assert.equal(api.set('bare', () => 1, 60000), true);
        assert.equal(api.get('bare'), null, '整体序列化为空 → 按未命中');
    });

    test('Symbol / BigInt 值：BigInt 抛错返回 false，Symbol 序列化为 {}', () => {
        const { api } = boot();
        assert.equal(api.set('bi', { n: BigInt(1) }, 60000), false, 'BigInt 不可 JSON 序列化 → 放弃写入');
        assert.equal(api.set('sym', { s: Symbol('x') }, 60000), true);
        assert.deepEqual(api.get('sym'), {}, 'Symbol 字段在序列化中丢失');
    });

    test('特殊字符串：换行/引号/Unicode/emoji 往返无损', () => {
        const { api } = boot();
        const s = 'a"b\\c\nd\te 🚀 中文';
        api.set('str', s, 60000);
        assert.equal(api.get('str'), s);
    });

    test('null 值本身：可序列化且命中（null 是有效缓存值，不是未命中）', () => {
        const { api } = boot();
        assert.equal(api.set('nul', null, 60000), true, 'v 为 null 可以写入');
        assert.equal(api.get('nul'), null);
        assert.ok(api.get('nul') === null);
        // 与「未命中」的区别体现在存储里确实存在该条目
        assert.equal(api.stats().count, 1);
    });

    test('深层嵌套对象往返还原（10 层）', () => {
        const { api } = boot();
        let deep = { leaf: true };
        for (let i = 0; i < 10; i++) deep = { child: deep, level: i };
        api.set('deep', deep, 60000);
        let cur = api.get('deep');
        let levels = 0;
        while (cur && cur.child) { cur = cur.child; levels++; }
        assert.equal(levels, 10);
        assert.equal(cur.leaf, true);
    });
});

// ================================================================ 并发安全

describe('cache.js · 并发与环境降级', () => {
    test('并发写入不同 key：全部成功且互不覆盖', async () => {
        const { api } = boot();
        const results = await Promise.all(
            Array.from({ length: 50 }, (_, i) => Promise.resolve(api.set('c' + i, { i }, 60000))));
        assert.equal(results.filter(Boolean).length, 50, '50 个并发写入全部成功');
        for (let i = 0; i < 50; i++) assert.deepEqual(api.get('c' + i), { i });
    });

    test('并发读写同一 key：不会读到半写状态，最终值为最后一次写入', async () => {
        const { api } = boot();
        api.set('race', { v: 0 }, 60000);
        const reads = [];
        const writers = Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => {
            api.set('race', { v: i + 1 }, 60000);
            reads.push(api.get('race'));
        }));
        await Promise.all(writers);
        assert.equal(reads.length, 20);
        for (const r of reads) {
            assert.ok(r && typeof r.v === 'number' && r.v >= 1,
                '每次读到的都必须是完整对象（JSON.stringify 原子落盘，无半写值）');
        }
        // 并发调度顺序不定，但存储最终必为某个完整写入值
        const final = api.get('race');
        assert.ok(final && typeof final.v === 'number' && final.v >= 1 && final.v <= 20,
            '最终值落在 1..20 的完整写入集合内');
    });

    test('并发 prune 与 get 交错：过期条目最终一致（重复 prune 幂等）', async () => {
        const { api, store } = boot();
        api.set('e1', { a: 1 }, 60000);
        api.set('e2', { a: 2 }, 60000);
        patchExpiry(store, 'e1', { e: Date.now() - 1 });
        patchExpiry(store, 'e2', { e: Date.now() - 1 });
        const runs = await Promise.all([Promise.resolve(api.prune()), Promise.resolve(api.prune())]);
        assert.equal(runs.reduce((a, b) => a + b, 0), 2, '两条过期条目各被删一次（不重复计数）');
        assert.equal(api.prune(), 0, '再次清理为空');
        assert.equal(api.stats().count, 0);
    });

    test('localStorage 不可用（null）→ 全部 API 静默降级不抛错', () => {
        const ctx = loadCache(null);
        const api = ctx.window.YUKI.cache;
        assert.equal(api.set('k', { a: 1 }, 60000), false);
        assert.equal(api.get('k'), null);
        api.del('k');                 // 不抛错
        assert.equal(api.clearAll(), 0);
        assert.equal(api.prune(), 0);
        // VM realm 对象与宿主原型不同，按字段断言而非 deepStrictEqual
        const st0 = api.stats();
        assert.equal(st0.bytes, 0);
        assert.equal(st0.count, 0);
        assert.equal(st0.expired, 0);
    });

    test('localStorage 访问抛异常（隐私模式）→ _ls() 返回 null 降级', () => {
        const hostile = {
            get localStorage() { throw new Error('SecurityError'); },
        };
        const context = { console, Date, Math, JSON, String, Number, Object, Array, Error, window: hostile };
        context.globalThis = context;
        vm.createContext(context);
        vm.runInContext(CACHE_SRC, context, { filename: 'cache-hostile.js' });
        const api = context.window.YUKI.cache;
        assert.equal(api.set('k', { a: 1 }, 60000), false);
        assert.equal(api.get('k'), null);
        api.del('k');
        assert.equal(api.clearAll(), 0);
        const st = api.stats();
        assert.equal(st.bytes, 0);
        assert.equal(st.count, 0);
        assert.equal(st.expired, 0);
    });

    test('多 VM 实例共享同一 store：跨实例可见（模拟同名脚本重复加载）', () => {
        const shared = new Map();
        const a = boot(shared);
        const b = boot(shared);
        a.api.set('shared', { from: 'a' }, 60000);
        assert.deepEqual(b.api.get('shared'), { from: 'a' }, '第二实例读到第一实例写入的数据');
        assert.equal(b.api.clearAll(), 1);
        assert.equal(a.api.get('shared'), null, '清理对共享 store 生效');
    });
});
