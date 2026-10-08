'use strict';
/**
 * 封面补拉结果持久化（B-02）测试：common.js 补拉管线写穿 localStorage、
 * getCachedCover 读穿回填、畸形缓存丢弃、TTL 过期走网络。
 *
 * 搭桩方式与 bangumi-cover.test.js / common-utils.test.js 同款：fs.readFileSync +
 * node:vm 加载真实 common.js 与真实 cache.js，localStorage 用内存 Map 桩。
 * 补拉驱动走 _coverFillOne：$ 桩返回带 data-source/data-id 的卡片元素，
 * doAction 桩返回 detailContent 响应（或计数后抛错），断言请求次数与落盘内容。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const COMMON_SRC = path.join(__dirname, '../../src/renderer/js/common.js');
const CACHE_SRC = path.join(__dirname, '../../src/renderer/js/cache.js');

/** 极简 localStorage 桩：Map 语义，支持 length/key/getItem/setItem/removeItem/clear。 */
function makeLocalStorage() {
    const m = new Map();
    return {
        get length() { return m.size; },
        key(i) { return Array.from(m.keys())[i] || null; },
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        clear: () => { m.clear(); },
        _map: m,
    };
}

/** 带卡片数据的 jQuery 包装桩：_coverFillOne 需 el.data('source'/'id'/'name')、
 *  document.contains、el.removeAttr、el.find('.vod-cover').html()/prepend/append。 */
function makeCardEl(data) {
    return {
        _data: Object.assign({ source: '', id: '', name: '' }, data),
        _removed: new Set(),
        _coverHtml: '',
        data(k) { return this._data[k]; },
        removeAttr(n) { this._removed.add(n); return this; },
        find() {
            const self = this;
            const chain = {
                html(h) { if (h !== undefined) self._coverHtml = h; return chain; },
                prepend(h) { self._coverHtml = h + self._coverHtml; return chain; },
                append(h) { self._coverHtml += h; return chain; },
                text() { return ''; },
            };
            return chain;
        },
    };
}

/**
 * 在 VM 中加载 common.js + cache.js（一次加载 = 一次「会话」；重启用新 context 共享 ls）。
 * 返回 { context, state, ls }：state.fetchCalls 记录补拉经 fetch 发出的请求数。
 */
function loadCoverEnv({ detailHandler, kazumiCover, ls } = {}) {
    const state = { fetchCalls: 0 };
    const storage = ls || makeLocalStorage();

    const commonSource = fs.readFileSync(COMMON_SRC, 'utf8');
    const cacheSource = fs.readFileSync(CACHE_SRC, 'utf8');

    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object,
        parseInt, parseFloat, Number, RegExp, Error, Symbol, WeakSet, Function,
        setTimeout, clearTimeout, URLSearchParams,
        localStorage: storage,
        document: { contains: () => true, addEventListener: () => {} },
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        AbortSignal: { timeout: () => ({}), any: (s) => s[0] },
        // $(x)：包装卡片元素（供 _coverFillOne 直调）；其余（$(document).on、
        // $(window).on 等顶层注册）返回通用空桩
        $: (x) => {
            if (x && typeof x === 'object' && x._data) return x;
            const empty = () => ({ length: 0, each() {}, on() { return this; } });
            return {
                length: 0,
                on() { return this; },
                find() { return { length: 0, closest() { return { length: 0, filter() { return empty(); } } } }; },
            };
        },
        // L46：原此处另有一个恒返回空响应的 fetch 键，被下方生效版对象字面量覆盖
        // （死代码），已删除——生效的 fetch 定义即唯一一份，注释随之唯一归属。
        // common.js 内部声明了自己的 doAction（走 fetch），补拉请求经 fetch 发出——
        // 桩 fetch 解析表单编码 body 中的 do 参数，detailContent 返回假数据并计数
        fetch: async (url, opts) => {
            const body = String((opts && opts.body) || '');
            const params = new URLSearchParams(body);
            const action = params.get('do');
            state.fetchCalls++;
            if (action !== 'detailContent') return { ok: true, text: async () => '[]' };
            if (detailHandler) return { ok: true, text: async () => JSON.stringify(detailHandler({ site: params.get('site'), ids: params.get('ids') })) };
            return { ok: true, text: async () => JSON.stringify({ list: [{ vod_pic: 'https://img.example.com/cov.jpg' }] }) };
        },
        Kazumi: {
            getBangumiCover: async (name) => (kazumiCover ? kazumiCover(name) : ''),
            getCachedBangumiMatch: () => null,
        },
        isBangumiCoverUrl: () => false,
        bangumiCoverImg: (p) => `<img src="${p}">`,
        vodCoverImg: (p) => `<img src="${p}">`,
        bangumiEpBadge: () => '',
        escHtml: (s) => String(s),
    };
    context.window = context; // cache.js 挂 localCache* 到 window：浏览器中 window 即全局
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(cacheSource, context, { filename: 'cache.js' });
    vm.runInContext(commonSource, context, { filename: 'common.js' });
    vm.runInContext(`
        globalThis.__fillOne = (pool, item) => _coverFillOne(pool, item);
        globalThis.__getCachedCover = (s, i) => getCachedCover(s, i);
        globalThis.__coverCache = _coverCache;
        globalThis.__persistGet = (s, i) => localCacheGet('cover::' + s + '|' + i);
    `, context, { filename: 'hooks.js' });
    return { context, state, ls: storage };
}

/** 构造一次补拉调用：普通源卡（走 detailContent 路径）。 */
async function fillVod(env, data) {
    const el = makeCardEl(data);
    const item = { el, alive: () => true, tries: 0 };
    await env.context.__fillOne({ opts: {}, seen: new Set() }, item);
    return el;
}

/** 构造一次补拉调用：Kazumi 卡（走 Kazumi.getBangumiCover 路径，不落盘）。 */
async function fillBgm(env, name) {
    const el = makeCardEl({ source: 'kazumi:rule1', id: '', name });
    const item = { el, alive: () => true, tries: 0 };
    await env.context.__fillOne({ opts: {}, seen: new Set() }, item);
    return el;
}

test('B-02 ①：普通源补拉成功写 localStorage，key 为 cover::site|id（只存 URL）', async () => {
    const env = loadCoverEnv();
    const pic = 'https://img.example.com/cov.jpg';
    await fillVod(env, { source: 'siteA', id: '42', name: 'X' });
    // 落盘键与值
    assert.equal(env.context.__persistGet('siteA', '42'), pic);
    const raw = JSON.parse(env.ls.getItem('yuki_cache::cover::siteA|42'));
    assert.equal(raw.v, pic); // 只存 URL 字符串
    assert.ok(raw.e > Date.now() + 6 * 24 * 60 * 60 * 1000); // TTL 7 天内未过期
    // 内存缓存照旧
    assert.equal(env.context.__coverCache.get('siteA|42'), pic);
});

test('B-02 ②：重启场景（内存空）localStorage 命中回填内存，不发网络请求', async () => {
    // 第一次会话：补拉成功落盘
    const env1 = loadCoverEnv();
    await fillVod(env1, { source: 'siteB', id: '7', name: 'Y' });
    assert.ok(env1.state.fetchCalls >= 1);
    // 模拟重启：全新 context（内存缓存空），共用同一 localStorage
    const env2 = loadCoverEnv({ ls: env1.ls });
    assert.equal(env2.context.__coverCache.size, 0); // 内存确为空
    assert.equal(env2.context.__getCachedCover('siteB', '7'), 'https://img.example.com/cov.jpg'); // 读穿命中
    assert.equal(env2.context.__coverCache.get('siteB|7'), 'https://img.example.com/cov.jpg'); // 回填内存
    assert.equal(env2.state.fetchCalls, 0); // 全程未发 detailContent
    // 再次读取走已回填的内存缓存，同样零请求
    env2.context.__getCachedCover('siteB', '7');
    assert.equal(env2.state.fetchCalls, 0);
    // 未落盘的卡仍返回空串（调用方按原逻辑走补拉管线）
    assert.equal(env2.context.__getCachedCover('siteB', '999'), '');
});

test('B-02 ③：畸形落盘值丢弃，回退走网络补拉', async () => {
    // 预置畸形值：非 URL 字符串 / 空串 / 非 JSON 原文
    const env = loadCoverEnv();
    const ls = env.ls;
    ls.setItem('yuki_cache::cover::siteC|1',
        JSON.stringify({ v: 'javascript:alert(1)', e: Date.now() + 86400000, t: Date.now() }));
    ls.setItem('yuki_cache::cover::siteC|2',
        JSON.stringify({ v: '', e: Date.now() + 86400000, t: Date.now() }));
    ls.setItem('yuki_cache::cover::siteC|3', 'not-json{{{');
    // 补拉同一批 key，畸形值应全部弃用并走网络，结果覆盖畸形值
    const pic = 'https://img.example.com/fixed.jpg';
    const env2 = loadCoverEnv({ ls, detailHandler: () => ({ list: [{ vod_pic: pic }] }) });
    await fillVod(env2, { source: 'siteC', id: '1', name: 'Z1' });
    await fillVod(env2, { source: 'siteC', id: '2', name: 'Z2' });
    await fillVod(env2, { source: 'siteC', id: '3', name: 'Z3' });
    assert.equal(env2.state.fetchCalls, 3); // 畸形值全部走网络
    assert.equal(env2.context.__persistGet('siteC', '1'), pic); // 补拉结果覆盖畸形值
    assert.equal(env2.context.__persistGet('siteC', '2'), pic);
    assert.equal(env2.context.__persistGet('siteC', '3'), pic);
    // getCachedCover 不返回畸形值
    assert.equal(env2.context.__getCachedCover('siteC', '1'), pic);
});

test('B-02 ④：TTL 过期（localCacheGet 惰性删除）走网络补拉并续写', async () => {
    const fresh = 'https://img.example.com/new.jpg';
    const env = loadCoverEnv({ detailHandler: () => ({ list: [{ vod_pic: fresh }] }) });
    // 预置一条已过期条目（e 为过去时刻）
    env.ls.setItem('yuki_cache::cover::siteD|9',
        JSON.stringify({ v: 'https://stale.example.com/old.jpg', e: Date.now() - 1000, t: Date.now() - 7 * 24 * 3600 * 1000 }));
    assert.equal(env.context.__getCachedCover('siteD', '9'), ''); // 过期视为未命中
    await fillVod(env, { source: 'siteD', id: '9', name: 'W' });
    assert.equal(env.state.fetchCalls, 1); // 走了网络
    assert.equal(env.context.__persistGet('siteD', '9'), fresh); // 续写成功
    // 过期条目被 localCacheGet 惰性删除后由续写替换，同名键只剩一条新值
    const raw = JSON.parse(env.ls.getItem('yuki_cache::cover::siteD|9'));
    assert.equal(raw.v, fresh);
    assert.ok(raw.e > Date.now());
});

test('B-02 ⑤：只缓存补拉路径——Kazumi/Bangumi 卡不写 cover:: 落盘（走 kazumi_bgm_cover）', async () => {
    const env = loadCoverEnv({ kazumiCover: () => 'https://lain.bgm.tv/pic/cover/c/a/b/1.jpg' });
    await fillBgm(env, '迷宫饭');
    assert.equal(env.context.__coverCache.get('kazumi:rule1|迷宫饭'), 'https://lain.bgm.tv/pic/cover/c/a/b/1.jpg');
    // 本测试全程只此一次补拉，命名空间内不应出现任何 cover:: 条目
    const coverKeys = [];
    for (let i = 0; i < env.ls.length; i++) {
        const k = env.ls.key(i);
        if (k && k.indexOf('yuki_cache::cover::') === 0) coverKeys.push(k);
    }
    assert.deepEqual(coverKeys, []);
});

test('B-02 ⑥：落盘 key 精确同构——cover::site|id，不混入 name', async () => {
    const env = loadCoverEnv();
    await fillVod(env, { source: 'siteE', id: '3', name: 'N' });
    assert.notEqual(env.ls.getItem('yuki_cache::cover::siteE|3'), null);
    assert.equal(env.ls.getItem('yuki_cache::cover::siteE|3|N'), null);
    // detailHandler 收到的仍是原始 site/id 参数（补拉请求不受落盘影响）
    assert.equal(env.context.__getCachedCover('siteE', '3'), 'https://img.example.com/cov.jpg');
});

test('L30：读穿回填遵守内存缓存 2000 条上限（重启后大网格批量回填不超限）', async () => {
    // 直接向落盘池预置 2010 条合法封面（模拟长期积累，绕开补拉写路径）
    const env = loadCoverEnv();
    for (let i = 0; i < 2010; i++) {
        env.ls.setItem('yuki_cache::cover::siteL|i' + i,
            JSON.stringify({ v: 'https://img.example.com/p' + i + '.jpg', e: Date.now() + 86400000, t: Date.now() }));
    }
    // 重启语义：全新会话（loadCoverEnv 内存缓存已空），批量读穿回填
    const env2 = loadCoverEnv({ ls: env.ls });
    for (let i = 0; i < 2010; i++) {
        const pic = env2.context.__getCachedCover('siteL', 'i' + i);
        assert.equal(pic, 'https://img.example.com/p' + i + '.jpg');
    }
    assert.ok(env2.context.__coverCache.size <= 2000, '回填后内存缓存不得突破写路径同款上限，实际 '
        + env2.context.__coverCache.size);
});
