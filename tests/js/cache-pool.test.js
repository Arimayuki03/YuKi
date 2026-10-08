/**
 * src/renderer/js/cache.js B-10 双池容量治理测试（cache-pool.test.js）。
 *
 * 与 renderer-cache.test.js（单池时代全量契约白盒）互补，本文件只覆盖 B-10 增量语义：
 *   ① 双池路由（显式 opts.pool / 体积阈值兜底）与隔离（两池互不挤占）；
 *   ② 既有 API 兼容（不传 opts 行为与旧单池一致，读/删/清/统计跨池透明）；
 *   ③ localCacheStats() 双池口径（bytes/count 汇总 + big 子对象分池明细）；
 *   ④ TTL / LRU-by-t 淘汰语义在双池下不变形（各池独立按 t 升序淘汰）。
 * 既有单池契约回归仍由 renderer-cache.test.js 全量保障（两文件共用同一桩结构）。
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const CACHE_SRC = fs.readFileSync(path.join(ROOT, 'src/renderer/js/cache.js'), 'utf8');

/** 内存 localStorage 桩（与 renderer-cache.test.js 同构）。 */
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

/** 在 VM 中加载 cache.js，返回挂载在 window 上的 API 与原始 store。 */
function boot(sharedStore) {
    const ls = makeLs(sharedStore);
    const context = {
        console, Date, Math, JSON, String, Number, Object, Array, Error, isNaN,
        parseInt, parseFloat, Symbol, BigInt,
        window: { localStorage: ls },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(CACHE_SRC, context, { filename: 'cache.js' });
    return { api: context.window.YUKI.cache, raw: context.window, ls, store: ls.__store };
}

/** 直接改写某条缓存的包装字段（e/t），用于精确构造 LRU-by-t 与 TTL 边界。 */
function patchWrapped(store, fullKey, patch) {
    const obj = JSON.parse(store.get(fullKey));
    Object.assign(obj, patch);
    store.set(fullKey, JSON.stringify(obj));
}

// ================================================================ 双池路由

describe('cache-pool · B-10 双池路由', () => {
    test('显式 opts.pool="big"：条目落 yuki_bigcache:: 前缀', () => {
        const { api, store } = boot();
        assert.equal(api.set('home::feed::v1::siteA', { items: [1, 2] }, 60000, { pool: 'big' }), true);
        assert.equal(store.has('yuki_bigcache::home::feed::v1::siteA'), true);
        assert.equal(store.has('yuki_cache::home::feed::v1::siteA'), false);
        assert.deepEqual(api.get('home::feed::v1::siteA'), { items: [1, 2] }, '读侧透明命中大池');
    });

    test('显式 opts.pool="small"：即使体积大也强制落小池', () => {
        const { api, store } = boot();
        const big = 'x'.repeat(300 * 1024); // ≥ 256KB 阈值
        assert.equal(api.set('forced', big, 60000, { pool: 'small' }), true);
        assert.equal(store.has('yuki_cache::forced'), true);
        assert.equal(store.has('yuki_bigcache::forced'), false);
    });

    test('体积阈值兜底：未传 opts 时 ≥256KB 自动落大池，小条目仍进小池', () => {
        const { api, store } = boot();
        api.set('small', { a: 1 }, 60000); // 无 opts：常规小条目
        assert.equal(store.has('yuki_cache::small'), true, '小条目不传 opts 行为同旧（进小池）');
        const giant = 'y'.repeat(256 * 1024); // 恰达阈值
        assert.equal(api.set('giant', giant, 60000), true);
        assert.equal(store.has('yuki_bigcache::giant'), true, '≥256KB 自动路由大池');
        assert.equal(api.get('giant').length, giant.length, '读侧透明回读');
        const mid = 'z'.repeat(256 * 1024 - 500); // 阈值下方留出包装余量
        assert.equal(api.set('mid', mid, 60000), true);
        assert.equal(store.has('yuki_cache::mid'), true, '阈值下方仍进小池');
    });

    test('同 key 换池覆盖：新池生效，旧池遗留条目随读/删/清理路径正确处理', () => {
        const { api, store } = boot();
        api.set('k', 'small-v', 60000);                 // 旧单池时代落小池
        assert.deepEqual(api.get('k'), 'small-v');
        api.set('k', { a: 1 }, 60000, { pool: 'big' }); // 显式改落大池
        assert.equal(store.has('yuki_bigcache::k'), true);
        assert.deepEqual(api.get('k'), { a: 1 }, 'get 大池优先探测，读到新值');
        api.del('k');                                    // 双池透明删除
        assert.equal(store.has('yuki_bigcache::k'), false);
        assert.equal(api.get('k'), null);
    });

    test('非法 opts.pool 取值回退体积阈值判定（不抛错）', () => {
        const { api, store } = boot();
        assert.equal(api.set('odd', { a: 1 }, 60000, { pool: 'nope' }), true);
        assert.equal(store.has('yuki_cache::odd'), true, '小条目即使 opts 非法也安全落小池');
    });
});

// ================================================================ M6 写后排他

describe('cache-pool · M6 写后排他（同一业务键任意时刻只存在于一池）', () => {
    test('小→大换池覆盖：大池写入成功后小池同 key 旧条目即被删除（last-write-wins）', () => {
        const { api, store } = boot();
        api.set('k', 'small-v', 0); // ttl=0 永久条目（my.js MY_BGMCOL_KEY 场景）：换池后旧条目不会自然过期
        assert.equal(store.has('yuki_cache::k'), true);
        api.set('k', 'big-v', 60000, { pool: 'big' });
        assert.equal(store.has('yuki_bigcache::k'), true);
        assert.equal(store.has('yuki_cache::k'), false, 'M6：另一池同 key 旧条目随写删除，双池不共存');
        assert.equal(api.get('k'), 'big-v', '读侧命中新值而非另一池残留旧值');
    });

    test('大→小反向覆盖：小池写入后大池同 key 旧条目被删除（读侧大池优先不再命中陈旧值）', () => {
        const { api, store } = boot();
        api.set('rk', 'big-old', 60000, { pool: 'big' });
        api.set('rk', 'small-new', 60000, { pool: 'small' });
        assert.equal(store.has('yuki_bigcache::rk'), false, '反向换池同样排他');
        assert.equal(api.get('rk'), 'small-new', '_locate 大池优先读到的是新值');
    });

    test('同池覆盖不产生跨池影子：多次覆盖后 store 仍只一条', () => {
        const { api, store } = boot();
        api.set('same', 'v1', 60000);
        api.set('same', 'v2', 60000);
        assert.equal(store.size, 1);
        assert.equal(api.get('same'), 'v2');
    });
});

// ================================================================ 两池互不挤占

describe('cache-pool · B-10 双池隔离（核心治理语义）', () => {
    test('大条目灌满大池：小池高频条目不受任何淘汰', () => {
        const { api, store } = boot();
        // 小池写入 50 条高频小条目（模拟封面/匹配缓存）
        for (let i = 0; i < 50; i++) api.set('cover::s|i' + i, { pic: 'p' + i }, 0);
        // 大池连灌多条 ~0.7MB 条目：触发大池自身按 t 淘汰，但绝不动小池
        const chunk = 'b'.repeat(700 * 1024);
        for (let i = 0; i < 6; i++) api.set('detail::vod::' + i, chunk, 60000, { pool: 'big' });
        for (let i = 0; i < 50; i++) {
            assert.deepEqual(api.get('cover::s|i' + i), { pic: 'p' + i },
                '小池条目 ' + i + ' 必须存活（旧单池下一条 0.7MB 即可挤掉数十条）');
        }
        assert.equal(store.has('yuki_cache::detail::vod::0'), false, '大条目不落小池');
    });

    test('小池自身超限淘汰：只淘汰小池条目，大池条目无感', () => {
        const { api } = boot();
        api.set('bigOne', 'B'.repeat(700 * 1024), 60000, { pool: 'big' });
        // 小池灌 3 条 ~0.56MB（显式钉小池：该体积无 opts 时会按 B-10 阈值自动落大池），
        // 超小池 1.5MB 上限触发 LRU 淘汰最旧一条
        const chunk = 's'.repeat(560 * 1024);
        api.set('s0', chunk, 60000, { pool: 'small' });
        api.set('s1', chunk, 60000, { pool: 'small' });
        api.set('s2', chunk, 60000, { pool: 'small' });
        assert.equal(api.get('s0'), null, '小池最旧条目被淘汰（小池内部语义不变）');
        assert.equal(api.get('s1').length, chunk.length);
        assert.equal(api.get('bigOne').length, 700 * 1024, '大池条目不受小池淘汰影响');
    });

    test('淘汰严格限定在所属池：大池写满不 spill 到小池', () => {
        const { api, store } = boot();
        api.set('precious', { n: 1 }, 0);
        const chunk = 'g'.repeat(1024 * 1024); // 1MB/条
        for (let i = 0; i < 5; i++) api.set('big' + i, chunk, 60000, { pool: 'big' });
        // 大池 3MB 上限：写第 4 条时开始淘汰最旧；全过程中 precious 始终在小池存活
        assert.deepEqual(api.get('precious'), { n: 1 });
        assert.equal(api.get('big0'), null, '大池最旧条目被淘汰');
        assert.equal(store.has('yuki_bigcache::big4'), true, '大池最新条目保留');
    });
});

// ================================================================ 既有 API 兼容

describe('cache-pool · 既有 API 兼容', () => {
    test('不传 opts：小条目读写/覆盖/del 与旧单池行为一致', () => {
        const { api, store } = boot();
        api.set('a', 1, 60000);
        api.set('a', 2, 60000); // 覆盖写
        assert.equal(api.get('a'), 2);
        assert.equal(store.size, 1, '仍只占一条存储');
        api.del('a');
        assert.equal(api.get('a'), null);
        assert.equal(store.size, 0);
    });

    test('get：小池不存在时透明回落——存量 yuki_cache:: 条目无需迁移即可命中', () => {
        const { api, store } = boot();
        // 模拟旧单池时代写入的存量条目（不经 set，直接摆进小池）
        store.set('yuki_cache::legacy', JSON.stringify({ v: { old: true }, e: 0, t: Date.now() }));
        assert.deepEqual(api.get('legacy'), { old: true }, '读侧双池透明，迁移期兼容');
    });

    test('del：双池各删一次，均无条目时不抛错', () => {
        const { api } = boot();
        api.del('ghost'); // 不抛错即通过
        api.set('x', 1, 60000, { pool: 'big' });
        api.del('x');
        assert.equal(api.get('x'), null);
    });

    test('clearAll：两池全清并合并计数，独立业务键保留', () => {
        const { api, store } = boot();
        api.set('s1', 1, 60000);
        api.set('b1', 1, 60000, { pool: 'big' });
        store.set('kazumi_bgm_cover', '{"x":1}');
        assert.equal(api.clearAll(), 2, '返回两池合计删除条目数');
        assert.equal(store.has('kazumi_bgm_cover'), true);
        assert.equal(api.stats().count, 0);
    });

    test('全局函数与 YUKI.cache 命名空间指向同一实现（含第 4 参透传）', () => {
        const { raw, api, store } = boot();
        assert.equal(raw.localCacheGet, api.get);
        assert.equal(raw.localCacheSet, api.set);
        raw.localCacheSet('via-raw', 1, 60000, { pool: 'big' });
        assert.equal(store.has('yuki_bigcache::via-raw'), true, '全局入口同样接受 opts');
    });
});

// ================================================================ stats 双池口径

describe('cache-pool · localCacheStats 双池口径', () => {
    test('bytes/count 为两池汇总，big 子对象给出大池分项', () => {
        const { api, store } = boot();
        api.set('s1', 'aaaa', 60000);
        api.set('b1', 'bbbb', 60000, { pool: 'big' });
        api.set('b2', 'cccccc', 60000, { pool: 'big' });
        const st = api.stats();
        assert.equal(st.count, 3, '条目数为两池合计');
        const expectBytes = ['yuki_cache::s1', 'yuki_bigcache::b1', 'yuki_bigcache::b2']
            .reduce((sum, k) => sum + k.length + store.get(k).length, 0);
        assert.equal(st.bytes, expectBytes, 'bytes 为两池键+值字符长度之和');
        assert.equal(st.big.count, 2, '大池分项条目数');
        assert.equal(st.big.bytes, 'yuki_bigcache::b1'.length + store.get('yuki_bigcache::b1').length
            + 'yuki_bigcache::b2'.length + store.get('yuki_bigcache::b2').length, '大池分项 bytes');
    });

    test('expired 跨两池统计；永久条目不计', () => {
        const { api, store } = boot();
        api.set('sf', { a: 1 }, 60000);
        api.set('bf', { a: 1 }, 60000, { pool: 'big' });
        patchWrapped(store, 'yuki_cache::sf', { e: Date.now() - 1 });
        patchWrapped(store, 'yuki_bigcache::bf', { e: Date.now() - 1 });
        assert.equal(api.stats().expired, 2, '两池过期条目合并统计');
        assert.equal(api.prune(), 2, 'prune 跨两池清理');
        assert.equal(api.stats().count, 0);
    });

    test('空存储 / 无 localStorage 降级：stats 恒含 big 子对象（调用方解构安全）', () => {
        const { api } = boot();
        // VM realm 对象与宿主原型不同，按字段断言而非 deepStrictEqual（同 renderer-cache.test.js 口径）
        assert.equal(api.stats().big.bytes, 0);
        assert.equal(api.stats().big.count, 0);
        const context = {
            console, Date, Math, JSON, String, Number, Object, Array, Error,
            window: { localStorage: null },
        };
        context.globalThis = context;
        vm.createContext(context);
        vm.runInContext(CACHE_SRC, context, { filename: 'cache-null.js' });
        const st = context.window.YUKI.cache.stats();
        assert.equal(st.bytes, 0);
        assert.equal(st.big.bytes, 0);
        assert.equal(st.big.count, 0);
    });
});

// ================================================================ TTL / 淘汰语义不变

describe('cache-pool · TTL 与 LRU-by-t 语义不变', () => {
    test('大池条目 TTL 过期：get 返回 null 并惰性删除', () => {
        const { api, store } = boot();
        api.set('bk', { a: 1 }, 60000, { pool: 'big' });
        assert.deepEqual(api.get('bk'), { a: 1 });
        patchWrapped(store, 'yuki_bigcache::bk', { e: Date.now() - 1 });
        assert.equal(api.get('bk'), null, '过期即未命中');
        assert.equal(store.has('yuki_bigcache::bk'), false, '惰性删除');
    });

    test('大池 LRU 按 t 升序：t 最小者先被淘汰（与旧单池同规则）', () => {
        const { api, store } = boot();
        const chunk = 'k'.repeat(1200 * 1024); // 1.2MB/条，大池 3MB：写第 3 条触发淘汰
        api.set('o1', chunk, 60000, { pool: 'big' });
        api.set('o2', chunk, 60000, { pool: 'big' });
        patchWrapped(store, 'yuki_bigcache::o2', { t: 1 }); // 后写的 t 调到最旧
        api.set('o3', chunk, 60000, { pool: 'big' });
        assert.equal(api.get('o2'), null, 't 最小者先淘汰（非先写者）');
        assert.equal(api.get('o1').length, chunk.length);
        assert.equal(api.get('o3').length, chunk.length);
    });

    test('ttl<=0/省略 → e=0 永不过期，双池一致', () => {
        const { api, store } = boot();
        api.set('ps', { a: 1 }, 0);
        api.set('pb', { a: 1 }, 0, { pool: 'big' });
        assert.equal(JSON.parse(store.get('yuki_cache::ps')).e, 0);
        assert.equal(JSON.parse(store.get('yuki_bigcache::pb')).e, 0);
        assert.deepEqual(api.get('pb'), { a: 1 });
    });

    test('单条目超过所属池上限 → 写入失败返回 false 且不动本池其他条目', () => {
        const { api } = boot();
        api.set('warm', { a: 1 }, 60000);
        const huge = 'x'.repeat(3.2 * 1024 * 1024); // 超 3MB 大池上限
        assert.equal(api.set('huge', huge, 60000, { pool: 'big' }), false);
        assert.equal(api.get('huge'), null);
        assert.deepEqual(api.get('warm'), { a: 1 });
        // 小池侧：≥256KB 会自动路由大池，显式 pool:'small' 才可能触发小池拒收
        const smallHuge = 'y'.repeat(1.6 * 1024 * 1024);
        assert.equal(api.set('sh', smallHuge, 60000, { pool: 'small' }), false, '超 1.5MB 小池上限拒收');
    });

    test('覆盖写自身不计入所属池容量增长（先减旧值体积）', () => {
        const { api, store } = boot();
        const chunk = 'w'.repeat(900 * 1024);
        for (let i = 0; i < 3; i++) api.set('same-big', chunk, 60000, { pool: 'big' });
        assert.equal(api.get('same-big').length, chunk.length);
        assert.equal(store.size, 1);
        assert.ok(api.stats().big.bytes < 3 * 1024 * 1024, '大池覆盖写不撑爆容量');
    });

    test('QuotaExceededError：所属池内激进淘汰后重试，仍失败静默返回 false', () => {
        const { api, ls } = boot();
        const realSet = ls.setItem.bind(ls);
        let calls = 0;
        ls.setItem = (k, v) => {
            calls++;
            if (calls === 1) { const err = new Error('quota'); err.name = 'QuotaExceededError'; throw err; }
            return realSet(k, v);
        };
        assert.equal(api.set('qk', { a: 1 }, 60000, { pool: 'big' }), true, '大池淘汰重试后写入成功');
        assert.deepEqual(api.get('qk'), { a: 1 });

        ls.setItem = () => { const err = new Error('quota'); err.name = 'QuotaExceededError'; throw err; };
        assert.equal(api.set('qk2', { a: 1 }, 60000, { pool: 'big' }), false, '两次都失败则放弃，不抛错');
    });
});
