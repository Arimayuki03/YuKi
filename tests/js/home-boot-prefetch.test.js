'use strict';
/**
 * home-boot-prefetch.test.js — B-12 loadSites 与首页 feed 解耦（启动预发）
 *
 * 覆盖对象（home.js）：_bootPrefetchHome（预发发起与门控）、_bootPrefetchYield
 * （init 的 loadSites 入口让位）、_bootPrefetchTakeOver（/sites 返回后的接管/
 * 兜底）、loadHome 的 bootPrefetch 探测抑制、loadSites 消费点全链路。
 *
 * 手法：与 home-probe.test.js 相同 —— vm 加载 cache.js + common.js + home.js，
 * 注入最小全局桩与内存 Map 版 localStorage。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 链式 jQuery 桩（覆盖 home.js 启动链路用到的全部方法）。 */
function makeJq() {
    const jq = (sel) => {
        const self = {
            __sel: String(sel),
            on() { return self; }, off() { return self; },
            empty() { return self; }, html() { return self; }, text() { return self; },
            val(v) { if (v === undefined) return ''; return self; },
            append() { return self; }, prepend() { return self; },
            addClass() { return self; }, removeClass() { return self; }, toggleClass() { return self; },
            attr() { return self; }, prop() { return self; }, data() { return undefined; },
            find() { return self; }, closest() { return self; }, each() { return self; },
            children() { return self; }, show() { return self; }, hide() { return self; },
            scrollTop() { return self; }, remove() { return self; },
            get length() { return 0; },
        };
        return self;
    };
    return jq;
}

/** 在 VM 中加载 common.js + home.js，注入最小全局桩；localStorage 为内存 Map 桩。 */
function loadHome(opts = {}) {
    const lsStore = new Map();
    const ls = {
        getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
        setItem: (k, v) => lsStore.set(k, String(v)),
        removeItem: (k) => lsStore.delete(k),
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, document: {},
        localStorage: ls,
        $: makeJq(),
        window: { yuki: { settingsGet: async () => ({ sourceAutoDetect: false }), settingsSet: async () => {} }, localStorage: ls },
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
        getJson: async () => ({ sites: opts.sites || [] }),
    };
    context.globalThis = context;
    vm.createContext(context);
    const src = (f) => fs.readFileSync(path.join(__dirname, '../../src/renderer/js', f), 'utf8');
    vm.runInContext(`${src('cache.js')}\n;${src('common.js')}\n;${src('home.js')}`, context, { filename: 'home.js' });
    // 与 home-probe.test.js 相同：加载后重新打桩覆盖 common.js 真实实现里的 DOM 依赖，
    // cache.js 的 localCache* 挂在 window 上，桥接成 VM 全局供 home.js 裸引用。
    // getJson 同理：common.js 的函数声明会覆盖 context 桩，需再桥接一次（经 __getJson
    // 间接调用，用例可随时改写行为）；不桥接时 fetch 未定义抛错 = 真实「网络失败」语义。
    vm.runInContext(`
        ;globalThis.__Home = Home;
        ;localCacheGet = (typeof window.localCacheGet === 'function') ? window.localCacheGet : (() => null);
        ;localCacheSet = (typeof window.localCacheSet === 'function') ? window.localCacheSet : (() => {});
        ;localCacheDel = (typeof window.localCacheDel === 'function') ? window.localCacheDel : (() => {});
        ;getJson = (p) => globalThis.__getJson(p);
        ;warnToast = () => {}; showLoading = () => {}; hideLoading = () => {};
        ;fillMissingCovers = () => {}; fitVodTitles = () => {}; renderStatusBar = () => {}; renderPagerBox = () => {};
        ;playCardsEnter = () => {}; stageAppendedCards = () => {};
        ;confirmDialog = async () => true; doAction = async () => ({ list: [] }); pageSizeOf = async () => 20;`, context);
    context.__getJson = async () => ({ sites: opts.sites || [] });
    context.__ls = ls;
    context.__lsStore = lsStore;
    return context;
}

/** 重置 Home 的启动上下文（预渲染成功后的典型状态）。settingsGet 默认关探测。 */
function bootedHome(ctx, site) {
    const H = ctx.__Home;
    H.sites = [{ key: site }];
    H._allSites = [{ key: site }];
    H.site = site;
    H.classes = [];
    H.mode = 'home';
    H.tid = '';
    H.page = 1;
    H.pagecount = 1;
    H._loadToken = 0;
    H._sitesLoadToken = 0;
    H._probeToken = 0;
    H._homeList = [];
    H._homeListSite = '';
    H._homeCacheBooted = false;
    H._feedCacheBooted = false;
    H._userRefresh = false;
    H._configPending = false;
    H._pageSizeDirty = false;
    H._autoProbeEnabled = false; // 默认关探测：预发用例不触发后台扫描
    H._bootPrefetchToken = 0;
    H._bootPrefetchSite = '';
    H._bootPrefetchPromise = null;
    // L37 门控桩：预发前 hasSiteCache() 必须为真（站点缓存存在 = 上次会话配置就绪）。
    // 真实实现读 localCacheGet（VM 里恒 null），这里桩成可开关：默认 true 维持
    // 「预渲染成功后的典型状态」语义，门控专项用例置 false 断言不预发。
    H._stubHasSiteCache = true;
    H.hasSiteCache = () => H._stubHasSiteCache;
    return H;
}

// ------------------------------------------------ _bootPrefetchHome（预发发起）

test('预发：不等 /sites 立即发 homeContent/feed 请求（预发期间零 getJson）', async () => {
    const ctx = loadHome();
    const H = bootedHome(ctx, 's1');
    const calls = [];
    let getJsonCalls = 0;
    ctx.doAction = async (action, kv) => { calls.push({ action, site: kv.site }); return { list: [{ vod_id: '1', vod_name: 'x' }] }; };
    ctx.__getJson = async () => { getJsonCalls++; return { sites: [] }; };
    H._bootPrefetchHome();
    assert.ok(H._bootPrefetchPromise, '预发 Promise 已登记');
    assert.equal(H._bootPrefetchSite, 's1', '预发目标源快照');
    assert.equal(H._bootPrefetchToken, H._loadToken, '快照令牌 = loadHome 自持代');
    assert.equal(H._loadToken, 1, '预发占用一代令牌');
    await H._bootPrefetchPromise;
    assert.ok(calls.some((c) => c.action === 'homeContent' && c.site === 's1'), '预发先发 homeContent');
    assert.ok(calls.some((c) => c.action === 'homeVideoContent' && c.site === 's1'), '预发先发 feed');
    assert.equal(getJsonCalls, 0, '预发全程不等 /sites（零 getJson 调用）');
});

test('预发门控：无当前源不预发；savedView 为分类/搜索模式不预发', async () => {
    const ctx = loadHome();
    const H = bootedHome(ctx, 's1');
    H.site = '';
    H._bootPrefetchHome();
    assert.equal(H._bootPrefetchPromise, null, '无当前源不预发');

    const ctx2 = loadHome();
    const H2 = bootedHome(ctx2, 's1');
    H2._viewState = () => ({ site: 's1', mode: 'category', tid: '9', page: 1 });
    H2._bootPrefetchHome();
    assert.equal(H2._bootPrefetchPromise, null, '分类恢复路径不预发');

    const ctx3 = loadHome();
    const H3 = bootedHome(ctx3, 's1');
    H3._viewState = () => ({ site: 's1', mode: 'search', word: 'x', page: 1 });
    H3._bootPrefetchHome();
    assert.equal(H3._bootPrefetchPromise, null, '搜索恢复路径不预发');

    // L37 门控：站点缓存缺失/demo-only（恢复/导入未完成）不预发——此时 _configPending
    // 尚未置位，预发会对 demo 源发必然落空的请求（预取必败）。
    const ctx4 = loadHome();
    const H4 = bootedHome(ctx4, 's1');
    H4._stubHasSiteCache = false;
    H4._bootPrefetchHome();
    assert.equal(H4._bootPrefetchPromise, null, '站点缓存缺失（恢复期）不预发');
});

test('预发：已有预发在途不重复预发', async () => {
    const ctx = loadHome();
    const H = bootedHome(ctx, 's1');
    let n = 0;
    ctx.doAction = async () => { n++; return { list: [] }; };
    H._bootPrefetchHome();
    const first = H._bootPrefetchPromise;
    H._bootPrefetchHome();
    assert.equal(H._bootPrefetchPromise, first, '不覆盖在途预发');
    await first;
    assert.equal(n, 2, '只有首个预发发出请求（homeContent 与 homeVideoContent 各一）');
});

// ------------------------------------------------ _bootPrefetchYield（入口让位）

test('让位：预发在途时不重建加载代（令牌存活）；无预发时返回 false 走原 _nextLoadToken', async () => {
    const ctx = loadHome();
    const H = bootedHome(ctx, 's1');
    ctx.doAction = async () => ({ list: [] });
    H._bootPrefetchHome();
    const token = H._loadToken;
    assert.equal(H._bootPrefetchYield(), true, '预发在途 → 让位');
    assert.equal(H._loadToken, token, '让位不重建加载代，预发令牌存活');
    assert.equal(typeof H._loadAbort, 'object', 'abort 通道可用（预发 loadHome 已建或让位补建）');
    await H._bootPrefetchPromise;

    const ctx2 = loadHome();
    const H2 = bootedHome(ctx2, 's1');
    assert.equal(H2._bootPrefetchYield(), false, '无预发 → 不让位');
});

// ------------------------------------------------ loadSites 消费点（全链路）

test('loadSites(bootPrefetch)：预发成功结算后让位并行，/sites 返回后接管——末尾 loadHome 零重复', async () => {
    const ctx = loadHome({ sites: [{ key: 's1', name: 'S1' }] });
    const H = bootedHome(ctx, 's1');
    ctx.doAction = async () => ({ list: [{ vod_id: '1', vod_name: 'x' }] });
    let homeCalls = 0;
    const orig = H.loadHome;
    H.loadHome = async function (pg, o) { homeCalls++; return orig.call(this, pg, o); };
    H._bootPrefetchHome(); // 1 次调用
    const prefetchToken = H._loadToken;
    await H._bootPrefetchPromise; // M9：接管以预发「成功完成」为前提，先等其结算
    await H.loadSites({ silent: true, bootPrefetch: true }); // 并行拉 /sites
    assert.equal(H._loadToken, prefetchToken, 'bootPrefetch 通道未重建加载代');
    assert.equal(homeCalls, 1, '预发 1 次 + 末尾 0 次（接管）');
    assert.equal(H._pageSizeDirty, false, '接管抵消 invalidatePageCaches 的脏标记');
    assert.equal(H._bootPrefetchToken, 0, '快照已消费');
});

test('loadSites(非 bootPrefetch，如配置重载)：入口照旧重建令牌——预发作废、末尾 loadHome 兜底', async () => {
    const ctx = loadHome({ sites: [{ key: 's1', name: 'S1' }] });
    const H = bootedHome(ctx, 's1');
    ctx.doAction = async () => ({ list: [{ vod_id: '1', vod_name: 'x' }] });
    let homeCalls = 0;
    const orig = H.loadHome;
    H.loadHome = async function (pg, o) { homeCalls++; return orig.call(this, pg, o); };
    H._bootPrefetchHome();
    const prefetchToken = H._loadToken;
    await H.loadSites({ silent: true }); // 配置重载通道：无 bootPrefetch
    assert.ok(H._loadToken > prefetchToken, '非让位通道重建加载代，预发作废');
    assert.equal(homeCalls, 2, '预发 1 次（已作废）+ 末尾兜底 1 次');
    await H._bootPrefetchPromise; // 清理在途预发
});

// ------------------------------------------------ _bootPrefetchTakeOver（接管判定）

test('接管：同代同源 → true 并消费快照；换源/换代/从未预发 → false', async () => {
    const ctx = loadHome();
    const H = bootedHome(ctx, 's1');
    ctx.doAction = async () => ({ list: [] });
    assert.equal(await H._bootPrefetchTakeOver(), false, '从未预发');

    H._bootPrefetchHome();
    await H._bootPrefetchPromise; // 预发完成且未被换代
    assert.equal(H._bootPrefetchToken, H._loadToken, '同代同源结算保留快照');
    assert.equal(await H._bootPrefetchTakeOver(), true, '同代同源 → 接管');
    assert.equal(H._bootPrefetchToken, 0, '快照一次性消费');
    assert.equal(H._bootPrefetchSite, '', '站点快照清零');
    assert.equal(await H._bootPrefetchTakeOver(), false, '已消费不再接管');

    // 换源：预发在途时站点校正换了当前源
    const ctx2 = loadHome();
    const H2 = bootedHome(ctx2, 's1');
    ctx2.doAction = async () => ({ list: [] });
    H2._bootPrefetchHome();
    H2.site = 's2';
    assert.equal(await H2._bootPrefetchTakeOver(), false, '换源 → 拒绝接管');
    await H2._bootPrefetchPromise;

    // 换代：新一代令牌重建（配置重载通道）
    const ctx3 = loadHome();
    const H3 = bootedHome(ctx3, 's1');
    ctx3.doAction = async () => ({ list: [] });
    H3._bootPrefetchHome();
    H3._nextLoadToken();
    assert.equal(await H3._bootPrefetchTakeOver(), false, '换代 → 拒绝接管');
    await H3._bootPrefetchPromise;
});

// ------------------------------------------------ M9 回归防线：失败兜底与接管语义

test('M9：预发 reject（loadHome 兜底路径失败）→ 接管拒绝、快照清零，loadSites 末尾兜底 loadHome', async () => {
    const ctx = loadHome({ sites: [{ key: 's1', name: 'S1' }] });
    const H = bootedHome(ctx, 's1');
    // 预发 loadHome 的「成功」仅指正常 resolve；组件级故障让 loadHome 链路 reject
    //（feed 失败包络保留旧画面后 throw，模拟真实异常路径）。
    ctx.doAction = async (action) => {
        if (action === 'homeVideoContent') { const e = new Error('L2_TIMEOUT'); e.envelope = true; throw e; }
        return { list: [{ vod_id: '1', vod_name: 'x' }] };
    };
    H._homeListSite = 's1'; // feed 失败保留旧画面的前提：归属记录存在
    H._homeList = [{ vod_id: 'old', vod_name: '旧' }];
    let homeCalls = 0;
    const orig = H.loadHome;
    H.loadHome = async function (pg, o) {
        homeCalls++;
        const r = await orig.call(this, pg, o);
        if (o && o.bootPrefetch && homeCalls === 1) throw new Error('boot prefetch pipeline failure'); // 仅预发那次 reject
        return r;
    };
    H._bootPrefetchHome();
    const prefetchToken = H._loadToken;
    await H._bootPrefetchPromise; // 预发结算（失败标记记 false，rejection 不外泄）
    assert.equal(H._loadToken, prefetchToken, '预发令牌未被重建（同代）');
    assert.equal(H._bootPrefetchToken, prefetchToken, '同代结算快照保留（交由接管点消费）');
    assert.notEqual(H._bootPrefetchOk, true, '失败结算：接管标记不得为 true');
    await H.loadSites({ silent: true, bootPrefetch: true });
    assert.equal(await H._bootPrefetchTakeOver(), false, '快照已消费，不可重复接管');
    assert.equal(homeCalls, 2, '预发 1 次（reject）+ 末尾兜底 loadHome 1 次');
    assert.ok(H._loadToken > prefetchToken, '兜底 loadHome 重建加载代');
});

test('M9：预发 loadHome 正常 resolve 但实际无内容（空 feed）→ 接管语义不回归（仍接管跳过兜底）', async () => {
    const ctx = loadHome({ sites: [{ key: 's1', name: 'S1' }] });
    const H = bootedHome(ctx, 's1');
    ctx.doAction = async () => ({ list: [] }); // 全部成功但空：render 空态属正常画面，非失败
    let homeCalls = 0;
    const orig = H.loadHome;
    H.loadHome = async function (pg, o) { homeCalls++; return orig.call(this, pg, o); };
    H._bootPrefetchHome();
    await H._bootPrefetchPromise; // M9：先等预发成功结算（接管以成功完成为前提）
    await H.loadSites({ silent: true, bootPrefetch: true }); // /sites 返回后由接管点消费快照
    assert.equal(homeCalls, 1, '末尾兜底 loadHome 不触发（预发空态即本次启动画面）');
    assert.equal(H._bootPrefetchToken, 0, '快照已消费');
    assert.equal(H._bootPrefetchOk, false, '接管点消费后结算标记归位');
});

test('M9：预发在途 → 接管点等待结算：成功则接管（单次启动语义不回归），失败则兜底 loadHome', async () => {
    const ctx = loadHome({ sites: [{ key: 's1', name: 'S1' }] });
    const H = bootedHome(ctx, 's1');
    let releaseFeed;
    const gate = new Promise((res) => { releaseFeed = res; });
    ctx.doAction = async (action) => {
        if (action === 'homeVideoContent') await gate; // 预发/兜底 feed 挂起：制造「未结算」窗口
        return { list: [{ vod_id: '1', vod_name: 'x' }] };
    };
    let homeCalls = 0;
    const orig = H.loadHome;
    H.loadHome = async function (pg, o) { homeCalls++; return orig.call(this, pg, o); };
    H._bootPrefetchHome();
    const sitesLoad = H.loadSites({ silent: true, bootPrefetch: true }); // 接管点先于预发结算到达：等待中
    releaseFeed(); // 预发与接管等待链共用该闸门：放开让其结算
    await sitesLoad;
    assert.equal(homeCalls, 1, '预发 1 次 + 末尾 0 次（等待结算成功 → 接管，单次启动语义）');
    assert.equal(H._loadToken, 1, 'bootPrefetch 通道不重建加载代');
    assert.equal(await H._bootPrefetchTakeOver(), false, '快照已消费，不可重复接管');
});

test('M9：预发在途且结算为失败（reject）→ 接管等待后拒绝，走兜底 loadHome（M9 核心缺陷路径）', async () => {
    const ctx = loadHome({ sites: [{ key: 's1', name: 'S1' }] });
    const H = bootedHome(ctx, 's1');
    let releaseFeed;
    const gate = new Promise((res) => { releaseFeed = res; });
    ctx.doAction = async (action) => {
        if (action === 'homeVideoContent') await gate;
        return { list: [{ vod_id: '1', vod_name: 'x' }] };
    };
    let homeCalls = 0;
    const orig = H.loadHome;
    H.loadHome = async function (pg, o) {
        homeCalls++;
        const r = await orig.call(this, pg, o);
        if (o && o.bootPrefetch && homeCalls === 1) throw new Error('boot prefetch pipeline failure'); // 仅预发那次 reject
        return r;
    };
    H._bootPrefetchHome();
    const prefetchToken = H._loadToken;
    const sitesLoad = H.loadSites({ silent: true, bootPrefetch: true }); // 接管点等在途预发结算
    await new Promise((res) => setImmediate(res)); // 放行闸门前先让接管点挂到预发 Promise 上
    releaseFeed();
    await sitesLoad;
    assert.ok(H._loadToken > prefetchToken, '兜底 loadHome 重建加载代');
    assert.equal(homeCalls, 2, '预发 1 次（reject）+ 末尾兜底 loadHome 1 次（M9：失败不得接管）');
    assert.equal(await H._bootPrefetchTakeOver(), false, '快照已消费，不可重复接管');
});

// ------------------------------------------------ loadHome bootPrefetch 探测抑制

test('loadHome bootPrefetch：预发不触发分类探测（探测轮由 loadSites 统一延迟调度）', async () => {
    const ctx = loadHome();
    const H = bootedHome(ctx, 's1');
    H._autoProbeEnabled = true;
    H.classes = [{ type_id: 'a', type_name: 'A' }];
    let probed = 0;
    H._probeClasses = async () => { probed++; };
    ctx.doAction = async () => ({ list: [{ vod_id: '1', vod_name: 'x' }] });
    await H.loadHome(undefined, { silent: true, bootPrefetch: true });
    assert.equal(probed, 0, 'bootPrefetch 抑制探测');

    await H.loadHome(undefined, { silent: true });
    assert.equal(probed, 1, '普通调用照常探测');
});

// ------------------------------------------------ 端到端：init → loadSites 全链路

test('端到端：init 预渲染成功 → feed 请求先于 /sites 发出，/sites 返回只刷下拉', async () => {
    const ctx = loadHome();
    const H = ctx.__Home;
    H._inited = false;
    // 种站点列表缓存 + feed 缓存 + 分类缓存（预渲染与预发的数据基础）
    ctx.localCacheSet('home::sites::v1', [{ key: 's1', name: 'S1', api: 'http://a/api.php', spiderType: 'cms0' }], 7 * 24 * 3600 * 1000);
    ctx.localCacheSet('home::feed::v1::s1', { ts: Date.now(), pagecount: 1, items: [{ vod_id: '1', vod_name: 'cached' }] }, 2 * 60 * 60 * 1000);
    ctx.localCacheSet('home::class::v1::s1', [{ type_id: '1', type_name: '电影' }], 24 * 3600 * 1000);
    const seq = []; // 全局请求时序：doAction 与 getJson 按实际发起顺序入列
    ctx.doAction = async (action) => {
        if (action === 'homeContent' || action === 'homeVideoContent') {
            seq.push(action);
            return { list: [{ vod_id: '1', vod_name: 'x' }], class: [{ type_id: '1', type_name: '电影' }] };
        }
        return { list: [] };
    };
    ctx.getJson = async (path) => { seq.push('getJson:' + path); return { sites: [{ key: 's1', name: 'S1', api: 'http://a/api.php', spiderType: 'cms0' }] }; };
    let homeCalls = 0;
    const origLoadHome = H.loadHome;
    H.loadHome = async function (pg, o) { homeCalls++; return origLoadHome.call(this, pg, o); };
    await H.init();
    await H._bootPrefetchPromise; // M9：接管以预发「成功完成」为前提，先等其结算
    assert.ok(seq.indexOf('homeContent') >= 0, '预发发出了 homeContent');
    assert.ok(seq.indexOf('getJson:/sites') >= 0, '/sites 已请求');
    assert.ok(seq.indexOf('homeContent') < seq.indexOf('getJson:/sites'), 'feed 请求先于 /sites（未等待站点列表）');
    assert.equal(homeCalls, 1, 'loadHome 共 1 次：预发 1 次 + loadSites 末尾接管 0 次');
});
