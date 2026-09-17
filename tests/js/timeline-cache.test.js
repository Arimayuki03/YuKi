'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/**
 * 时间表「Bangumi 账号收藏集合」持久缓存（timeline::collections::v1）单测。
 * VM 沙箱里同时加载 cache.js（真实读写链路）与 timeline.js，localStorage 为内存 Map 桩，
 * 只测纯数据层逻辑（_loadPersistedColSets / _savePersistedColSets / invalidateColCache），
 * 不触 DOM、不发起真实网络。
 */

const PERSIST_KEY = 'yuki_cache::timeline::collections::v1'; // cache.js 命名空间前缀 + 业务键
const TTL_MS = 30 * 60 * 1000;

/** 在 VM 中加载 cache.js + timeline.js，注入最小全局桩；返回 { Timeline, ls, lsStore }。 */
function loadTimeline() {
    const read = (f) => fs.readFileSync(path.join(__dirname, '../../src/renderer/js', f), 'utf8');
    const lsStore = new Map();
    const ls = {
        getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
        setItem: (k, v) => lsStore.set(k, String(v)),
        removeItem: (k) => lsStore.delete(k),
    };
    const context = {
        console, Date, Math, JSON, String, Number, Array, Map, Set, Object,
        parseInt, parseFloat, Promise, setTimeout, clearTimeout, isNaN,
        localStorage: ls,
        $: () => ({ on() { return this; }, empty() { return this; }, html() { return this; }, text() { return this; }, show() { return this; }, hide() { return this; }, find() { return { on() {} }; }, each() {}, val() { return ''; }, attr() { return this; }, toggleClass() { return this; }, removeClass() { return this; }, addClass() { return this; }, append() { return this; } }),
        doAction: async () => ({ items: [] }),
        escHtml: (s) => String(s),
        warnToast: () => {},
        showLoading: () => {},
        hideLoading: () => {},
        renderPagerBox: () => {},
        pageSizeOf: async () => 20,
        bangumiCard: () => '<div class="bangumi-card"></div>',
        bangumiNetGuide: () => '<div class="tip-line">guide</div>',
        fitVodTitles: () => {},
        Kazumi: {},
        FavHub: { onChanged: () => () => {} },
        UIState: { get: () => null, set: () => {} },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(read('cache.js'), context, { filename: 'cache.js' });
    vm.runInContext(`${read('timeline.js')}\n;globalThis.__testTimeline = Timeline;`, context, { filename: 'timeline.js' });
    return { Timeline: context.__testTimeline, ls, lsStore, ctx: context };
}

/** 重置 Timeline 的收藏缓存状态到「无缓存」初值。 */
function resetColState(T) {
    T._colCache = null;
    T._colCacheToken = '';
    T._colCacheTs = 0;
    T._colAvailable = false;
    T._colSets = { dropped: new Set(), watched: new Set(), watching: new Set() };
}

test('持久缓存写入→读取往返：items 与 token 完整还原', () => {
    const { Timeline: T, lsStore } = loadTimeline();
    resetColState(T);
    T._savePersistedColSets([{ subject_id: 10, type: 5 }, { subject_id: 20, type: 3 }], 'tok-1');
    // 落盘格式：cache.js TTL 包装 {v:{ts,token,items},e,t}，且在 yuki_cache:: 命名空间下
    assert.ok(lsStore.has(PERSIST_KEY), '写入 yuki_cache:: 命名空间');
    const saved = JSON.parse(lsStore.get(PERSIST_KEY));
    assert.equal(saved.v.token, 'tok-1');
    assert.equal(saved.v.items.length, 2);
    assert.ok(saved.e > Date.now() + TTL_MS - 2000, 'TTL 为 30min');

    const loaded = T._loadPersistedColSets();
    assert.ok(loaded, '读取命中');
    assert.equal(loaded.token, 'tok-1');
    assert.deepEqual(loaded.items, [{ subject_id: 10, type: 5 }, { subject_id: 20, type: 3 }]);
    assert.ok(loaded.ageMs < 1000, '刚写入 ageMs 近 0');
});

test('持久缓存只存纯数据（可 JSON 序列化），无 DOM/Set 引用', () => {
    const { Timeline: T, lsStore } = loadTimeline();
    resetColState(T);
    T._savePersistedColSets([{ subject_id: 10, type: 5 }], 'tok');
    const saved = JSON.parse(lsStore.get(PERSIST_KEY));
    assert.ok(Array.isArray(saved.v.items), 'items 为纯数组');
    assert.equal(typeof saved.v.ts, 'number');
    assert.equal(typeof saved.v.token, 'string');
});

test('TTL 过期后读取未命中（cache.js 惰性删除）', () => {
    const { Timeline: T, lsStore } = loadTimeline();
    resetColState(T);
    T._savePersistedColSets([{ subject_id: 10, type: 5 }], 'tok');
    // 时间前进 TTL+1ms：预取现值、替换 ts 与包装过期时间戳，再放回（内存桩无时钟注入）
    const saved = JSON.parse(lsStore.get(PERSIST_KEY));
    const now = Date.now();
    saved.v.ts = now - TTL_MS - 1;
    saved.e = now - 1;
    saved.t = now - TTL_MS - 1;
    lsStore.set(PERSIST_KEY, JSON.stringify(saved));
    assert.equal(T._loadPersistedColSets(), null, '过期后视为未命中');
});

test('持久数据损坏 / 空数组 / 结构不符 → 未命中且不抛错', () => {
    const { Timeline: T, lsStore } = loadTimeline();
    resetColState(T);
    lsStore.set(PERSIST_KEY, '{broken json');
    assert.equal(T._loadPersistedColSets(), null, 'JSON 损坏未命中');
    lsStore.set(PERSIST_KEY, JSON.stringify({ v: { ts: Date.now(), token: 't', items: [] }, e: 0, t: Date.now() }));
    assert.equal(T._loadPersistedColSets(), null, '空数组不作为有效缓存');
    lsStore.set(PERSIST_KEY, JSON.stringify({ v: 'not-an-object', e: 0, t: Date.now() }));
    assert.equal(T._loadPersistedColSets(), null, '非对象结构未命中');
    assert.equal(T._loadPersistedColSets(), null, '反复读取均静默返回 null');
});

test('写入守卫：空结果不落盘（绝不缓存空/错误）', () => {
    const { Timeline: T, lsStore } = loadTimeline();
    resetColState(T);
    T._savePersistedColSets([], 'tok');
    T._savePersistedColSets(null, 'tok');
    assert.equal(lsStore.has(PERSIST_KEY), false, '空/无效结果不写持久缓存');
});

test('_loadColSets：内存 miss 时用持久缓存兜底上屏并恢复世代校验三元组', async () => {
    const { Timeline: T, ctx } = loadTimeline();
    resetColState(T);
    ctx.Kazumi = { _getBangumiToken: async () => 'tok-1' };
    T._savePersistedColSets([{ subject_id: 30, type: 3 }], 'tok-1');
    let netCalls = 0;
    ctx.doAction = async () => { netCalls++; return { items: [] }; }; // 网络不应被调用
    await T._loadColSets();
    assert.equal(netCalls, 0, '持久命中时不发网络请求');
    assert.deepEqual([...T._colSets.watching], ['30'], '过滤集合由持久数据构建');
    assert.ok(T._colAvailable, '有账号收藏即启用过滤');
    assert.equal(T._colCacheToken, 'tok-1', '恢复 token（世代校验）');
    // 收紧（审查 P2）：必须按「内存 5min TTL」口径断言而非 30min 持久 TTL——
    // 旧断言 `<= TTL_MS(30min)` 会把「回填补数（30min-age）」的倒挂 bug 判为通过。
    assert.ok(T._colCacheTs > 0 && Date.now() - T._colCacheTs <= 2000,
        '新快照恢复后内存 age 继承真实 age（近 0），而非 30min 补数');
    assert.equal(T._colCache.length, 1, '回填内存缓存');
    // 紧随其后的重进：内存命中，仍不发网络
    await T._loadColSets();
    assert.equal(netCalls, 0, '恢复出的新内存缓存立即生效');
});

test('_loadColSets：陈旧持久快照（20min）恢复后内存 age 继承真实 age，不再倒挂', async () => {
    // 回归「越陈旧越新鲜」：旧公式给 20min 前的快照回填 10min elapsed、给刚落盘的
    // 快照回填 29.9min elapsed——新鲜数据被判过期、陈旧数据反被当新鲜。
    // 修复后：内存 age = 持久 age。注意网络重拉的时机是持久 TTL（30min）耗尽后：
    // 30min 内重进走持久兜底零网络上屏（设计如此，账号收藏变更另有 invalidateColCache
    // 双清路径），因此第二次进入同样不发网络请求。
    const { Timeline: T, ctx, lsStore } = loadTimeline();
    resetColState(T);
    ctx.Kazumi = { _getBangumiToken: async () => 'tok-1' };
    T._savePersistedColSets([{ subject_id: 10, type: 5 }], 'tok-1');
    const AGE = 20 * 60 * 1000;
    const saved = JSON.parse(lsStore.get(PERSIST_KEY));
    const now = Date.now();
    saved.v.ts = now - AGE;          // 快照真实年龄 20min（仍在 30min 持久 TTL 内）
    saved.e = now - AGE + TTL_MS;    // cache.js 层同步顺延，避免整体过期
    saved.t = now - AGE;
    lsStore.set(PERSIST_KEY, JSON.stringify(saved));
    let netCalls = 0;
    ctx.doAction = async () => { netCalls++; return { items: [{ subject_id: 99, type: 3 }] }; };
    await T._loadColSets(); // 第一次：内存 miss → 持久兜底上屏，不发网络
    assert.equal(netCalls, 0, '持久兜底负责首屏免白屏');
    assert.ok(Math.abs((Date.now() - T._colCacheTs) - AGE) < 2000,
        '恢复 ts 的内存 age 继承持久 age（20min），而非 10min 补数（倒挂回归锁）');
    await T._loadColSets(); // 第二次：内存仍 miss → 持久兜底继续零网络
    assert.equal(netCalls, 0, '持久 TTL 内重进零网络（30min 后才会走网络重拉）');
});

test('_loadColSets：持久缓存 token 与当前 token 不符 → 忽略持久数据走网络', async () => {
    const { Timeline: T, ctx } = loadTimeline();
    resetColState(T);
    ctx.Kazumi = { _getBangumiToken: async () => 'new-token' }; // 当前账号 token 已变
    T._savePersistedColSets([{ subject_id: 10, type: 5 }], 'old-token');
    let netCalls = 0;
    ctx.doAction = async () => { netCalls++; return { items: [{ subject_id: 99, type: 2 }] }; };
    await T._loadColSets();
    assert.equal(netCalls, 1, '换号后持久缓存不串用，重新拉取');
    assert.deepEqual([...T._colSets.watched], ['99']);
    assert.equal(T._colCacheToken, 'new-token');
    // 网络成功后持久缓存同步更新为新 token 的数据
    const loaded = T._loadPersistedColSets();
    assert.equal(loaded.token, 'new-token', '落盘数据同步更新');
    assert.deepEqual(loaded.items, [{ subject_id: 99, type: 2 }]);
});

test('_loadColSets：网络拉取成功写入 _colCache 的同时写持久缓存', async () => {
    const { Timeline: T, lsStore, ctx } = loadTimeline();
    resetColState(T);
    ctx.Kazumi = { _getBangumiToken: async () => 'tok-net' };
    ctx.doAction = async () => ({ items: [{ subject_id: 7, type: 3 }] });
    await T._loadColSets();
    const loaded = T._loadPersistedColSets();
    assert.ok(loaded, '网络成功后落盘');
    assert.equal(loaded.token, 'tok-net');
    assert.deepEqual(loaded.items, [{ subject_id: 7, type: 3 }]);
    assert.ok(lsStore.has(PERSIST_KEY));
});

test('_loadColSets：网络失败（无缓存兜底）不落盘、过滤仍由本地标记驱动', async () => {
    const { Timeline: T, lsStore, ctx } = loadTimeline();
    resetColState(T);
    ctx.Kazumi = { _getBangumiToken: async () => 'tok-x' };
    ctx.doAction = async () => { throw new Error('net down'); };
    await T._loadColSets();
    assert.equal(lsStore.has(PERSIST_KEY), false, '失败结果不写持久缓存');
});

test('invalidateColCache：同时清内存缓存与持久缓存', async () => {
    const { Timeline: T, lsStore, ctx } = loadTimeline();
    resetColState(T);
    T._savePersistedColSets([{ subject_id: 10, type: 5 }], 'tok');
    assert.ok(T._loadPersistedColSets(), '写入后可读');
    T._colCache = [{ subject_id: 10, type: 5 }];
    T._colCacheToken = 'tok';
    T._colCacheTs = Date.now();
    T.invalidateColCache();
    assert.equal(T._colCache, null, '内存缓存清空');
    assert.equal(T._colCacheToken, '');
    assert.equal(T._colCacheTs, 0);
    assert.equal(T._loadPersistedColSets(), null, '持久缓存一并作废（My 同步后重启也不回旧数据）');
    assert.equal(lsStore.has(PERSIST_KEY), false, 'localStorage 条目已删除');
    // 作废后 _loadColSets 走网络重拉
    ctx.Kazumi = { _getBangumiToken: async () => 'tok' };
    let netCalls = 0;
    ctx.doAction = async () => { netCalls++; return { items: [{ subject_id: 11, type: 3 }] }; };
    await T._loadColSets();
    assert.equal(netCalls, 1, '作废后强制重拉');
});

test('cache.js 不可用的沙箱环境：持久层静默降级，不影响主流程', () => {
    // 单独加载 timeline.js（无 cache.js → localCacheGet/Set/Del 未定义）
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/timeline.js'), 'utf8');
    const context = { console, Date, Math, JSON, String, Number, Array, Map, Set, parseInt };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testTimeline = Timeline;`, context, { filename: 'timeline.js' });
    const T = context.__testTimeline;
    resetColState(T);
    T._savePersistedColSets([{ subject_id: 1, type: 3 }], 'tok'); // 不抛错即通过
    assert.equal(T._loadPersistedColSets(), null);
    T.invalidateColCache(); // 不抛错即通过
});
