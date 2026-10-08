'use strict';
/**
 * home-catwin-cache.test.js — B-05「全部」feed 合并窗口快照落盘
 *
 * 覆盖对象（home.js）：CAT_WIN_CACHE 常量、_catWinGet（恢复）、_catWinDelete（删除联动）、
 * _catWinCachePut|_catWinCacheGet|_catWinCacheDel（快照存取与结构校验）、
 * _fetchHomeFeed（第 1 页窗口完成后落盘 + 冷启动翻页续拉）。
 *
 * 手法：与 home-probe.test.js 相同 —— vm 加载 cache.js + common.js + home.js，
 * 注入最小全局桩与内存 Map 版 localStorage（sharedStore 支持跨 vm 模拟重启持久化往返）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 在 VM 中加载 common.js + home.js，注入最小全局桩；localStorage 为内存 Map 桩。
 *  sharedStore：可传入外部 Map 以共享 localStorage（跨 vm 上下文测持久化往返）。 */
function loadHome(sharedStore) {
    const cacheSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/cache.js'), 'utf8');
    const commonSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/common.js'), 'utf8');
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/home.js'), 'utf8');
    const lsStore = sharedStore || new Map();
    const ls = {
        getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
        setItem: (k, v) => lsStore.set(k, String(v)),
        removeItem: (k) => lsStore.delete(k),
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, document: {},
        localStorage: ls,
        $: () => ({ on() { return this; }, off() { return this; }, empty() { return this; }, html() {}, val() { return ''; } }),
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => {} }, localStorage: ls },
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        truncateTitle: (s) => String(s || '').slice(0, 60),
        vodCoverImg: (pic) => `<img src="${pic || ''}">`,
        warnToast: () => {},
        showLoading: () => {},
        hideLoading: () => {},
        normalizePic: (p) => p || '',
        Detail: {},
        renderPagerBox: () => {},
        pageSizeOf: async () => 20,
        fillMissingCovers: () => {},
        fitVodTitles: () => {},
        renderStatusBar: () => {},
        doAction: async () => ({ list: [] }),
        getJson: async () => ({ sites: [] }),
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${cacheSrc}\n;${commonSrc}\n;${source}`, context, { filename: 'home.js' });
    // 与 home-probe.test.js 相同：加载后重新打桩覆盖 common.js 真实实现里的 DOM 依赖，
    // cache.js 的 localCache* 挂在 window 上，桥接成 VM 全局供 home.js 裸引用。
    vm.runInContext(`
        ;globalThis.__Home = Home;
        ;localCacheGet = (typeof window.localCacheGet === 'function') ? window.localCacheGet : (() => null);
        ;localCacheSet = (typeof window.localCacheSet === 'function') ? window.localCacheSet : (() => {});
        ;localCacheDel = (typeof window.localCacheDel === 'function') ? window.localCacheDel : (() => {});
        ;warnToast = () => {}; showLoading = () => {}; hideLoading = () => {};
        ;fillMissingCovers = () => {}; fitVodTitles = () => {}; renderStatusBar = () => {}; renderPagerBox = () => {};
        ;playCardsEnter = () => {}; stageAppendedCards = () => {};
        ;confirmDialog = async () => true; doAction = async () => ({ list: [] }); pageSizeOf = async () => 20;`, context);
    context.__ls = ls;
    context.__lsStore = lsStore;
    return context;
}

/** 每次测试重置 Home 的上下文状态。 */
function home(ctx) {
    const H = ctx.__Home;
    H.site = 's';
    H.classes = [];
    H.mode = 'home';
    H.tid = '';
    H.page = 1;
    H.pagecount = 1;
    H._loadToken = 1;
    H._allSites = [{ key: 's', api: 'https://api.example/s', spiderType: '' }];
    H._catWin = new Map();
    H._pageCache = null;
    H._homeList = [];
    H._homeListSite = '';
    H._userRefresh = false;
    H._homeCacheBooted = false;
    H._feedCacheBooted = false;
    return H;
}

function makeItems(prefix, n) {
    // 带齐卡片渲染消费的 4 字段：多余字段（若有）应被 _catWinTrimItem 精简掉
    return Array.from({ length: n }, (_, i) => (
        { vod_id: prefix + i, vod_name: '片' + i, vod_pic: 'https://img/p' + i + '.jpg', vod_remarks: '备注' + i }
    ));
}

/** vm 上下文里的数组与本地数组原型不同（deepStrictEqual 按原型比较），先转本地数组再断言。 */
const ids = (list) => Array.from(list, (v) => v.vod_id);

/** 读原始快照 payload（cache.js 包络 {v,e,t} 之外层）。 */
function rawSnap(store, site) {
    const raw = store.get('yuki_cache::home::catwin::v1::' + site);
    return raw ? JSON.parse(raw) : null;
}

// ---------------------------------------------------------------- 快照落盘

test('_fetchHomeFeed：第 1 页窗口构建完成 → 快照写入正确 key 与精简条目', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    ctx.doAction = async (action, kv) => {
        const n = parseInt(kv.pg, 10);
        return { page: n, pagecount: 5, limit: 20, total: 100, list: makeItems('f' + n + '-', 20) };
    };
    await H._fetchHomeFeed(1, 36); // need 36 → 源页 1,2 → 窗口按源页边界超拉至 40 条
    assert.equal(H._homeList.length, 36);
    const env = rawSnap(ctx.__lsStore, 's');
    assert.ok(env, 'yuki_cache::home::catwin::v1::s 已写入');
    assert.ok(env.e > Date.now(), '带 TTL（未过期）');
    const snap = env.v;
    assert.equal(snap.sourcePg, 2, '断点 = 已拉源页数');
    assert.equal(snap.total, 100);
    assert.equal(snap.perPage, 20);
    assert.equal(snap.fp, 'https://api.example/s|', '绑定源内容指纹（api|spiderType）');
    assert.equal(snap.items.length, 40, '快照存完整窗口（含源页边界超拉部分，锚定更远的断点）');
    assert.deepEqual(Object.keys(snap.items[0]).sort(), ['vod_id', 'vod_name', 'vod_pic', 'vod_remarks'],
        '条目只保留卡片渲染/详情跳转消费的字段');
    assert.equal(snap.items[0].vod_id, 'f1-0');
});

test('_fetchHomeFeed：翻页（pg>1）不重写快照，快照锚定第 1 页断点', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    ctx.doAction = async (action, kv) => {
        const n = parseInt(kv.pg, 10);
        return { page: n, pagecount: 5, limit: 20, total: 100, list: makeItems('f' + n + '-', 20) };
    };
    await H._fetchHomeFeed(1, 36);
    const before = rawSnap(ctx.__lsStore, 's');
    await H._fetchHomeFeed(2, 36); // 补源页 3,4
    const after = rawSnap(ctx.__lsStore, 's');
    assert.equal(after.v.sourcePg, before.v.sourcePg, '快照断点不变（只锚定第 1 页）');
    // 包络 {v,e,t} 的 t = 写入时间戳（cache.js:216）；载荷 v 内是业务时间戳 ts（home.js _catWinCachePut）
    assert.equal(after.t, before.t, '未重写（包络写入时间戳不变）');
    assert.equal(after.v.ts, before.v.ts, '未重写（快照业务时间戳不变）');
    // 内存窗口正常续拉不受影响
    assert.deepEqual(ids(H._homeList).slice(0, 2), ['f2-16', 'f2-17']);
});

test('_catWinCachePut：源返回的多余字段被裁剪（只存消费的 4 字段），超限时断点自洽回退', () => {
    const ctx = loadHome();
    const H = home(ctx);
    const fat = Array.from({ length: 310 }, (_, i) => ({
        vod_id: 'v' + i, vod_name: '片' + i, vod_pic: 'p.jpg', vod_remarks: 'r',
        vod_en: 'en' + i, vod_class: '分类', vod_content: '简介'.repeat(100), vod_play_url: '第01集$http://x',
    }));
    H._catWinCachePut('s', { items: fat, seen: new Set(fat.map((v) => v.vod_id)), sourcePg: 16, total: 1000, perPage: 20 });
    const snap = rawSnap(ctx.__lsStore, 's').v;
    // M10：超护栏不再原样截 300——保留条目数与断点必须自洽（300 = 15×20 整源页），
    // 恢复 seen 按 items 重建、续拉从 sourcePg+1=16 发起，被丢源页 16 重拉补齐（无缺口）
    assert.equal(snap.items.length, 300, '按整源页边界保留（keepPg × perPage ≤ 护栏）');
    assert.deepEqual([snap.sourcePg, snap.total, snap.perPage], [15, 1000, 20],
        '断点自洽回退到 15（原 16 的第 16 页整页丢弃，恢复翻页自会重拉）');
    assert.equal(snap.items[299].vod_id, 'v299', '保留的是前 15 个源页的条目');
    assert.deepEqual(Object.keys(snap.items[0]).sort(), ['vod_id', 'vod_name', 'vod_pic', 'vod_remarks'],
        '简介/播放地址等大字段不落盘');
    // 恢复语义验证：_catWinGet 重建 seen/sourcePg 后翻页从 16 续拉，不缺口不重复
    H._catWin = new Map();
    const win = H._catWinGet('s', '__all__');
    assert.equal(win.sourcePg, 15, '恢复断点 = 自洽回退后的 15');
    assert.equal(win.items.length, win.seen.size, 'seen 与 items 同步重建');
});

test('_catWinCachePut：单页即超护栏（perPage > 护栏）→ 整页回退不成立，放弃本次落盘', () => {
    const ctx = loadHome();
    const H = home(ctx);
    const fat = makeItems('v-', 310); // perPage=320：单源页就超 300，无法保留完整一页
    H._catWinCachePut('s', { items: fat, seen: new Set(fat.map((v) => v.vod_id)), sourcePg: 1, total: 1000, perPage: 320 });
    assert.equal(rawSnap(ctx.__lsStore, 's'), null, '放弃本次快照（截断必产生缺口）');
});

// ---------------------------------------------------------------- 冷启动恢复

test('冷启动恢复：空窗口 _catWinGet 从快照恢复，翻页从断点续拉（不全量重拉）', async () => {
    const store = new Map();
    // 会话 1：构建第 1 页窗口并落盘
    const ctx1 = loadHome(store);
    const H1 = home(ctx1);
    ctx1.doAction = async (action, kv) => {
        const n = parseInt(kv.pg, 10);
        return { page: n, pagecount: 5, limit: 20, total: 100, list: makeItems('f' + n + '-', 20) };
    };
    await H1._fetchHomeFeed(1, 36);

    // 会话 2（模拟重启）：全新 Home 实例 + 同一 localStorage
    const ctx2 = loadHome(store);
    const H2 = home(ctx2);
    const calls = [];
    ctx2.doAction = async (action, kv) => {
        const n = parseInt(kv.pg, 10);
        calls.push(n);
        return { page: n, pagecount: 5, limit: 20, total: 100, list: makeItems('f' + n + '-', 20) };
    };
    // 冷启动第 1 页：窗口从快照恢复（36 条），不再发任何请求
    const p1 = await H2._fetchHomeFeed(1, 36);
    assert.deepEqual(calls, [], '第 1 页命中恢复窗口，零请求');
    assert.deepEqual(ids(p1).slice(0, 2), ['f1-0', 'f1-1']);
    assert.equal(H2.pagecount, Math.ceil(100 / 36));
    // 冷启动翻第 2 页：从源页 3 续拉（原先要全量重拉源页 1,2）
    await H2._fetchHomeFeed(2, 36);
    assert.deepEqual(calls, [3, 4], '翻页只补拉缺失源页 3,4');
    assert.equal(H2._homeList[0].vod_id, 'f2-16');
    // 去重 seen 已随 items 重建：续拉不会重复追加已恢复条目
    const win = H2._catWin.get('s|__all__');
    assert.equal(win.items.length, win.seen.size, 'seen 与 items 同步重建');
    assert.equal(win.items.length, 80, '窗口 = 恢复的 40 条 + 补拉源页 3,4（按源页边界至 80 条）');
});

test('冷启动恢复：fp 指纹不符（同名 key 换仓/换主）→ 快照不恢复，走正常拉取', async () => {
    const store = new Map();
    const ctx1 = loadHome(store);
    const H1 = home(ctx1);
    ctx1.doAction = async (action, kv) => {
        const n = parseInt(kv.pg, 10);
        return { page: n, pagecount: 5, limit: 20, total: 100, list: makeItems('f' + n + '-', 20) };
    };
    await H1._fetchHomeFeed(1, 36);

    const ctx2 = loadHome(store);
    const H2 = home(ctx2);
    H2._allSites = [{ key: 's', api: 'https://api.example/OTHER', spiderType: '' }]; // 同名 key 换主
    let calls = 0;
    ctx2.doAction = async () => { calls++; return { page: 1, pagecount: 5, limit: 20, total: 100, list: makeItems('g-', 20) }; };
    await H2._fetchHomeFeed(1, 36);
    assert.ok(calls > 0, '快照被拒后正常发起拉取');
    assert.equal(H2._homeList[0].vod_id, 'g-0');
});

// ---------------------------------------------------------------- 畸形快照安全丢弃

test('畸形快照安全丢弃：items 非数组 / 条目缺 vod_id / sourcePg 非法 → 未命中且不炸渲染', async () => {
    const cases = [
        ['items 非数组', { sourcePg: 2, total: 100, perPage: 20, items: 'nope' }],
        ['条目缺 vod_id', { sourcePg: 2, total: 100, perPage: 20, items: [{ vod_name: 'x' }] }],
        ['条目为 null', { sourcePg: 2, total: 100, perPage: 20, items: [null] }],
        ['sourcePg 为 0', { sourcePg: 0, total: 100, perPage: 20, items: makeItems('x-', 3) }],
        ['sourcePg 非数字', { sourcePg: '2', total: 100, perPage: 20, items: makeItems('x-', 3) }],
        ['perPage 缺失', { sourcePg: 2, total: 100, items: makeItems('x-', 3) }],
        ['total 为负数', { sourcePg: 2, total: -5, perPage: 20, items: makeItems('x-', 3) }],
        ['items 空数组', { sourcePg: 2, total: 100, perPage: 20, items: [] }],
    ];
    for (const [name, snap] of cases) {
        const ctx = loadHome();
        const H = home(ctx);
        ctx.__lsStore.set('yuki_cache::home::catwin::v1::s',
            JSON.stringify({ v: snap, e: Date.now() + 60000, t: Date.now() }));
        const win = H._catWinGet('s', '__all__');
        assert.equal(win.items.length, 0, `畸形（${name}）→ 回退空窗口`);
        assert.equal(win.sourcePg, 0, `畸形（${name}）→ 断点归零`);
    }
});

test('畸形快照安全丢弃：localStorage 原始 JSON 损坏 → 未命中；后续拉取正常', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    ctx.__lsStore.set('yuki_cache::home::catwin::v1::s', '{{{not-json');
    const win = H._catWinGet('s', '__all__');
    assert.equal(win.items.length, 0, '损坏 JSON 不抛异常，回退空窗口');
    // 恢复失败后走正常网络路径
    ctx.doAction = async (action, kv) => {
        const n = parseInt(kv.pg, 10);
        return { page: n, pagecount: 5, limit: 20, total: 100, list: makeItems('f' + n + '-', 20) };
    };
    const items = await H._fetchHomeFeed(1, 36);
    assert.equal(items.length, 36, '畸形缓存不影响主流程');
});

test('畸形快照安全丢弃：快照整体非对象 / 过期 → 未命中', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    ctx.__lsStore.set('yuki_cache::home::catwin::v1::s', JSON.stringify({ v: 42, e: 0, t: Date.now() }));
    assert.equal(H._catWinGet('s', '__all__').items.length, 0, '非对象值视为未命中');
    const ctx2 = loadHome();
    const H2 = home(ctx2);
    ctx2.__lsStore.set('yuki_cache::home::catwin::v1::s',
        JSON.stringify({ v: { sourcePg: 2, total: 100, perPage: 20, items: makeItems('x-', 3) }, e: Date.now() - 1000, t: Date.now() - 99999 }));
    assert.equal(H2._catWinGet('s', '__all__').items.length, 0, 'TTL 过期条目视为未命中');
});

// ---------------------------------------------------------------- 失效联动

test('失效联动：_catWinDelete("__all__") 同步删快照（强制刷新不留幽灵缓存）', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    ctx.doAction = async (action, kv) => {
        const n = parseInt(kv.pg, 10);
        return { page: n, pagecount: 5, limit: 20, total: 100, list: makeItems('f' + n + '-', 20) };
    };
    await H._fetchHomeFeed(1, 36);
    assert.ok(rawSnap(ctx.__lsStore, 's'), '落盘成功（前置）');
    // 用户手动刷新路径：loadHome(userRefresh) → _catWinDelete
    H._catWinDelete('s', '__all__');
    assert.equal(rawSnap(ctx.__lsStore, 's'), null, '快照已同步删除');
    // 分类窗口删除不碰快照
    ctx.__lsStore.set('yuki_cache::home::catwin::v1::s',
        JSON.stringify({ v: { sourcePg: 2, total: 100, perPage: 20, items: makeItems('x-', 3) }, e: 0, t: Date.now() }));
    H._catWinDelete('s', '1'); // 普通分类 tid
    assert.ok(rawSnap(ctx.__lsStore, 's'), '分类窗口删除不影响 __all__ 快照');
});

test('失效联动：切源 _cacheDropSite 清内存窗口但保留快照（跨会话按源复用，TTL 兜底）', () => {
    const ctx = loadHome();
    const H = home(ctx);
    H._catWin.set('s|__all__', { items: [], seen: new Set(), sourcePg: 0, total: 0, perPage: 20 });
    H._catWin.set('s|1', { items: [], seen: new Set(), sourcePg: 0, total: 0, perPage: 20 });
    ctx.__lsStore.set('yuki_cache::home::catwin::v1::s',
        JSON.stringify({ v: { sourcePg: 2, total: 100, perPage: 20, items: makeItems('x-', 3) }, e: 0, t: Date.now() }));
    H._cacheDropSite('s');
    assert.equal(H._catWin.size, 0, '内存窗口按源清理');
    assert.ok(rawSnap(ctx.__lsStore, 's'), '持久化快照保留（与 feed 上屏缓存同策略）');
});

test('_catWinGet：普通分类 tid 不做快照恢复（分类窗口保持纯内存语义）', () => {
    const ctx = loadHome();
    const H = home(ctx);
    ctx.__lsStore.set('yuki_cache::home::catwin::v1::s',
        JSON.stringify({ v: { sourcePg: 2, total: 100, perPage: 20, items: makeItems('x-', 3) }, e: 0, t: Date.now() }));
    const win = H._catWinGet('s', '1');
    assert.equal(win.items.length, 0, '分类窗口不从快照恢复');
    assert.equal(win.sourcePg, 0);
});
