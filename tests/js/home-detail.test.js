/**
 * home.js / detail.js 白盒单元测试（渲染层，node:vm + 全局桩加载）。
 *
 * 与已有测试的互补分工：
 *  - tests/js/home-probe.test.js：覆盖 home.js 的探测调度、缓存引导、加载编排；
 *  - tests/js/detail-start-button.test.js：覆盖 detail.js 的「开始播放」按钮路径；
 *  本文件补的是**纯函数与数据渲染层**的分支矩阵：
 *   home.js  isDemoOnlySites / actionResponseFailed / siteProbeFp / vodCard /
 *            _cacheGet|_cachePut|_cacheDropSite（页缓存 LRU）/ _catWinGet /
 *            _cacheHomeGet|_cacheHomePut / _loadClassCache|_saveClassCache / metaLine 等
 *   detail.js _detailCacheGet|_detailCacheSet（TTL 语义、命名空间、空值守卫）/
 *            parsePlay（线路/选集构造）/ metaLine / _renderEpisodes（集目列表）/
 *            _catvodStartHtml（播放按钮状态）/ load() 并发去重与错误态 / 空态
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/**
 * VM 沙箱内创建的对象字面量带 VM realm 的原型，跨 realm 做 deepStrictEqual 会
 * 因原型不同失败（结构与值都相同）。统一经 JSON 往返转成宿主 realm 纯数据。
 */
const plain = (x) => JSON.parse(JSON.stringify(x));

/** 内存 localStorage 桩：真实的 getItem/setItem/removeItem + key(i)/length 遍历语义。 */
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

/** 链式 jQuery 桩：html/append 的内容按选择器捕获，委托 on 记录监听器。 */
function makeJqCaptor() {
    const bySel = new Map();
    const appended = [];
    const bound = [];
    const jq = (sel) => {
        const self = {
            __sel: String(sel),
            on(ev, a, b) {
                const fn = typeof b === 'function' ? b : a;
                const delegated = typeof b === 'function' ? String(a) : '';
                if (typeof fn === 'function') bound.push({ sel: String(sel), ev, delegated, fn });
                return self;
            },
            off() { return self; },
            html(s) { if (s !== undefined) bySel.set(String(sel), String(s)); return self; },
            text(s) { if (s !== undefined) bySel.set(String(sel) + '::text', String(s)); return self; },
            append(s) { appended.push({ sel: String(sel), html: String(s) }); return self; },
            empty() { bySel.set(String(sel), ''); return self; },
            val(v) { if (v !== undefined) bySel.set(String(sel) + '::val', String(v)); return self; },
            addClass() { return self; },
            removeClass() { return self; },
            toggleClass() { return self; },
            attr() { return self; },
            prop() { return self; },
            data() { return self; },
            find() { return self; },
            closest() { return self; },
            each() { return self; },
            children() { return self; },
            map() { return self; },
            get() { return []; },
            show() { return self; },
            hide() { return self; },
            scrollTop() { return self; },
            remove() { return self; },
            get length() { return 0; },
        };
        return self;
    };
    return { $: jq, bySel, appended, bound };
}

/**
 * 在 VM 中加载 cache.js + common.js + home.js，注入最小全局桩。
 * opts.sharedStore 可共享 localStorage；opts.sites 为 /sites 返回；opts.settings 为 yuki 设置。
 */
function loadHome(opts = {}) {
    const ls = makeLs(opts.sharedStore);
    const cap = makeJqCaptor();
    const settings = opts.settings || {};
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout, Error,
        document: {
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains: () => false } },
            getElementById: () => null,
            addEventListener() {},
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        localStorage: ls,
        $: cap.$,
        window: { yuki: { settingsGet: async () => JSON.parse(JSON.stringify(settings)), settingsSet: async () => {} }, localStorage: ls },
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        truncateTitle: (s) => String(s || '').slice(0, 60),
        vodCoverImg: (pic) => `<img src="${pic || 'assets/cover-fallback.svg'}">`,
        warnToast: () => {},
        showLoading: () => {},
        hideLoading: () => {},
        normalizePic: (p) => String(p || '').trim(),
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
    vm.runInContext(`${read('src/renderer/js/cache.js')}\n;${read('src/renderer/js/common.js')}\n;${read('src/renderer/js/home.js')}`,
        context, { filename: 'home.js' });
    // common.js 的真实实现依赖 DOM/后端，加载后用中性桩覆盖；纯函数（escHtml/errorTextOf）保留。
    vm.runInContext(`
        ;globalThis.__Home = Home;
        ;globalThis.__isDemoOnlySites = isDemoOnlySites;
        ;globalThis.__actionResponseFailed = actionResponseFailed;
        ;globalThis.__siteProbeFp = siteProbeFp;
        ;globalThis.__vodCard = vodCard;
        ;localCacheGet = (typeof window.localCacheGet === 'function') ? window.localCacheGet : (() => null);
        ;localCacheSet = (typeof window.localCacheSet === 'function') ? window.localCacheSet : (() => false);
        ;warnToast = () => {}; showLoading = () => {}; hideLoading = () => {};
        ;fillMissingCovers = () => {}; fitVodTitles = () => {}; renderStatusBar = () => {};
        ;renderPagerBox = () => {}; playCardsEnter = () => {}; stageAppendedCards = () => {};
        ;doAction = async () => ({ list: [] }); pageSizeOf = async () => 20;`, context);
    context.__ls = ls;
    context.__lsStore = ls.__store;
    context.__cap = cap;
    return context;
}

/** 重置 Home 的可变状态，避免用例间互相污染。 */
function home(ctx) {
    const H = ctx.__Home;
    H.sites = [];
    H._allSites = [];
    H.site = 's';
    H.classes = [];
    H.tid = '';
    H.page = 1;
    H.pagecount = 1;
    H.mode = 'home';
    H._pageCache = null;
    H._catWin = new Map();
    H._homeList = [];
    H._homeListSite = '';
    H._homeCacheBooted = false;
    H._feedCacheBooted = false;
    H._loadToken = 0;
    H._userRefresh = false;
    H._autoProbeEnabled = false; // 默认关探测：纯数据用例不触发后台请求
    return H;
}

/**
 * 在 VM 中加载 cache.js + detail.js，注入最小全局桩。
 * 返回 Detail 对象、HTML 捕获与 toast 记录；opts.settings 可控 window.yuki 返回。
 */
function loadDetail(opts = {}) {
    const ls = makeLs(opts.sharedStore);
    const cap = makeJqCaptor();
    const toasts = [];
    const settings = opts.settings || {};
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout, Error, RegExp,
        document: {
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains: () => false } },
            getElementById: () => null,
            addEventListener() {},
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        localStorage: ls,
        $: cap.$,
        registerEsc: () => {},
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        stripHtml: (s) => String(s || ''),
        warnToast: (m) => toasts.push(String(m)),
        showLoading: () => {},
        hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: (pic, eager) => `<img src="${pic || 'assets/cover-fallback.svg'}" loading="${eager ? 'eager' : 'lazy'}">`,
        normalizePic: (p) => String(p || '').trim(),
        abortCoverFill: () => {},
        errorTextOf: (e) => String(e || ''),
        App: { currentView: 'home', showView() {} },
        Kazumi: undefined,
        window: { yuki: { settingsGet: async () => JSON.parse(JSON.stringify(settings)), settingsSet: async () => {} }, localStorage: ls },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/js/cache.js'), context, { filename: 'cache.js' });
    vm.runInContext(`${read('src/renderer/js/detail.js')}\n;globalThis.__Detail = Detail;
        ;globalThis.__detailCacheGet = _detailCacheGet; globalThis.__detailCacheSet = _detailCacheSet;
        ;globalThis.__DETAIL_VOD_CACHE_PREFIX = DETAIL_VOD_CACHE_PREFIX;
        ;globalThis.__DETAIL_BGMEXTRA_CACHE_PREFIX = DETAIL_BGMEXTRA_CACHE_PREFIX;
        ;globalThis.__DETAIL_CACHE_TTL = DETAIL_CACHE_TTL;
        ;localCacheGet = (typeof window.localCacheGet === 'function') ? window.localCacheGet : (() => null);
        ;localCacheSet = (typeof window.localCacheSet === 'function') ? window.localCacheSet : (() => false);`,
        context, { filename: 'detail.js' });
    context.__ls = ls;
    context.__lsStore = ls.__store;
    context.__cap = cap;
    context.__toasts = toasts;
    return context;
}

/** 重置 Detail 的可变状态。 */
function detail(ctx, over = {}) {
    const D = ctx.__Detail;
    D.site = 'site-a';
    D.vodId = 'v1';
    D.vodName = '测试影片';
    D.sources = [];
    D.activeSource = 0;
    D._vod = null;
    D._lastVod = null;
    D._bgmId = null;
    D._bgmInfo = null;
    D._activeTab = '概览';
    D._bgmExtraGen = 0;
    D._loadGen = 0;
    D._epDesc = false;
    D._epSelectMode = false;
    Object.assign(D, over);
    return D;
}

// ================================================================ home.js：isDemoOnlySites

describe('home.js · isDemoOnlySites 判定矩阵', () => {
    test('全为内置示例源（key=demo）→ 判定为 demo-only', () => {
        const ctx = loadHome();
        assert.equal(ctx.__isDemoOnlySites([{ key: 'demo' }, { key: 'demo' }]), true);
    });

    test('真实源与示例源混合 → 不是 demo-only（有用户内容）', () => {
        const ctx = loadHome();
        assert.equal(ctx.__isDemoOnlySites([{ key: 'demo' }, { key: 'zy_1' }]), false);
    });

    test('全部为真实源 → 不是 demo-only', () => {
        const ctx = loadHome();
        assert.equal(ctx.__isDemoOnlySites([{ key: 'a' }, { key: 'b' }]), false);
    });

    test('空列表 → 不是 demo-only（空结果不等于示例源）', () => {
        const ctx = loadHome();
        assert.equal(ctx.__isDemoOnlySites([]), false);
    });

    test('null / undefined → 不是 demo-only', () => {
        const ctx = loadHome();
        assert.equal(ctx.__isDemoOnlySites(null), false);
        assert.equal(ctx.__isDemoOnlySites(undefined), false);
    });

    test('非数组入参（对象/字符串/数字）→ 不是 demo-only', () => {
        const ctx = loadHome();
        assert.equal(ctx.__isDemoOnlySites({ key: 'demo' }), false);
        assert.equal(ctx.__isDemoOnlySites('demo'), false);
        assert.equal(ctx.__isDemoOnlySites(0), false);
    });

    test('列表元素缺字段（undefined/null/无 key）→ 不是 demo-only', () => {
        const ctx = loadHome();
        assert.equal(ctx.__isDemoOnlySites([undefined, null]), false);
        assert.equal(ctx.__isDemoOnlySites([{}, { name: 'demo' }]), false);
    });

    test('hasSiteCache：demo-only 缓存不算可用站点缓存，真实站点才算', () => {
        const ctx = loadHome();
        const H = home(ctx);
        ctx.localCacheSet('home::sites::v1', [{ key: 'demo' }], 7 * 24 * 3600 * 1000);
        assert.equal(H.hasSiteCache(), false, 'demo-only 缓存不算可上屏缓存');
        ctx.localCacheSet('home::sites::v1', [{ key: 'demo' }, { key: 'zy_1' }], 7 * 24 * 3600 * 1000);
        assert.equal(H.hasSiteCache(), true, '含真实源即算可用缓存');
    });
});

// ================================================================ home.js：actionResponseFailed

describe('home.js · actionResponseFailed 失败识别', () => {
    test('空值/非对象（原始文本、null、undefined、数字）→ 视为失败', () => {
        const ctx = loadHome();
        assert.equal(ctx.__actionResponseFailed(null), true);
        assert.equal(ctx.__actionResponseFailed(undefined), true);
        assert.equal(ctx.__actionResponseFailed(''), true);
        assert.equal(ctx.__actionResponseFailed('<html>502</html>'), true, '非 JSON 原始文本不能当无内容证据');
        assert.equal(ctx.__actionResponseFailed(0), true);
    });

    test('失败包络 ok:false → 视为失败（HTTP 非 2xx 的 RuntimeResponse）', () => {
        const ctx = loadHome();
        assert.equal(ctx.__actionResponseFailed({ ok: false, error: { code: 'L3_RUNTIME_CALL_FAILED' } }), true);
        assert.equal(ctx.__actionResponseFailed({ ok: false }), true);
    });

    test('空列表（无 error、无 ok 字段）→ 不是失败，作为「确认无内容」', () => {
        const ctx = loadHome();
        assert.equal(ctx.__actionResponseFailed({ list: [] }), false);
        assert.equal(ctx.__actionResponseFailed({ list: [], pagecount: 0 }), false);
    });

    test('正常响应 ok:true 且有内容 → 不是失败', () => {
        const ctx = loadHome();
        assert.equal(ctx.__actionResponseFailed({ ok: true, list: [{ vod_id: '1' }] }), false);
    });

    test('内嵌 error 字段（任意形态）→ 兜底视为失败', () => {
        const ctx = loadHome();
        assert.equal(ctx.__actionResponseFailed({ error: 'boom' }), true);
        assert.equal(ctx.__actionResponseFailed({ error: { code: 'L2_SITE_NOT_FOUND' } }), true);
        assert.equal(ctx.__actionResponseFailed({ list: [], error: { code: 'TIMEOUT' } }), true);
    });

    test('HTTP 错误码形态（status/statusCode 非 2xx 且带失败标记）→ 视为失败', () => {
        const ctx = loadHome();
        // 后端失败包络统一以 ok:false + error.code 表达；单独 status 不构成失败（源可能返回自定义 status）
        assert.equal(ctx.__actionResponseFailed({ status: 500, ok: false }), true);
        assert.equal(ctx.__actionResponseFailed({ statusCode: 404, error: { code: 'HTTP_404' } }), true);
        assert.equal(ctx.__actionResponseFailed({ status: 200, list: [{ vod_id: '1' }] }), false,
            '200 且有内容不算失败');
    });

    test('部分成功：带内嵌 error 但 list 非空 → 本函数仍判失败，由调用方按「内容优先」处理', () => {
        const ctx = loadHome();
        // 与 _probeSites 的「内容优先于错误」语义互补：判定函数只认 error，内容优先在上层
        assert.equal(ctx.__actionResponseFailed({ list: [{ vod_id: '1' }], error: { code: 'WARN' } }), true);
    });
});

// ================================================================ home.js：siteProbeFp

describe('home.js · siteProbeFp 内容指纹稳定性', () => {
    test('相同输入 → 相同输出（指纹稳定）', () => {
        const ctx = loadHome();
        const a = { key: 'k', api: 'http://a/api.php', spiderType: 'cms0' };
        const b = { key: 'k', api: 'http://a/api.php', spiderType: 'cms0' };
        assert.equal(ctx.__siteProbeFp(a), ctx.__siteProbeFp(b));
        assert.equal(ctx.__siteProbeFp(a), 'http://a/api.php|cms0');
    });

    test('api 不同 → 指纹不同（同名 key 换仓/换主）', () => {
        const ctx = loadHome();
        assert.notEqual(
            ctx.__siteProbeFp({ api: 'http://a/api.php', spiderType: 'cms0' }),
            ctx.__siteProbeFp({ api: 'http://b/api.php', spiderType: 'cms0' }));
    });

    test('spiderType 不同 → 指纹不同', () => {
        const ctx = loadHome();
        assert.notEqual(
            ctx.__siteProbeFp({ api: 'http://a/api.php', spiderType: 'cms0' }),
            ctx.__siteProbeFp({ api: 'http://a/api.php', spiderType: 'xc0' }));
    });

    test('缺字段：api/spiderType 缺失、null、undefined → 归一为空串不抛错', () => {
        const ctx = loadHome();
        assert.equal(ctx.__siteProbeFp({}), '|');
        assert.equal(ctx.__siteProbeFp(null), '|');
        assert.equal(ctx.__siteProbeFp(undefined), '|');
        assert.equal(ctx.__siteProbeFp({ api: null, spiderType: undefined }), '|');
    });

    test('非字符串字段（数字 api）→ 转字符串参与指纹；falsy 的 0 按空处理', () => {
        const ctx = loadHome();
        assert.equal(ctx.__siteProbeFp({ api: 123, spiderType: 9 }), '123|9');
        // spiderType 为 0 时走 `(s && s.spiderType)` 的 falsy 分支 → 空串（与缺失同处理）
        assert.equal(ctx.__siteProbeFp({ api: 123, spiderType: 0 }), '123|');
    });

    test('指纹用于 _validBlocked：指纹一致才让屏蔽继续生效', () => {
        const ctx = loadHome();
        const H = home(ctx);
        const sites = [{ key: 'k', api: 'http://a/api.php', spiderType: 'cms0' }];
        assert.deepEqual(H._validBlocked(sites, ['k'], { probeFp: { k: ctx.__siteProbeFp(sites[0]) } }), ['k']);
        assert.deepEqual(H._validBlocked(sites, ['k'], { probeFp: { k: 'x|y' } }), []);
    });
});

// ================================================================ home.js：vodCard

describe('home.js · vodCard 卡片 HTML 构造', () => {
    test('字段映射：vod_id/vod_name 写入 data-id/data-name 与 title', () => {
        const ctx = loadHome();
        const html = ctx.__vodCard({ vod_id: 'id-1', vod_name: '影片甲', vod_pic: 'http://x/p.jpg', vod_remarks: 'HD' }, 'site-a');
        assert.match(html, /class="vod-card"/);
        assert.match(html, /data-id="id-1"/);
        assert.match(html, /data-name="影片甲"/);
        assert.match(html, /data-source="site-a"/);
        assert.match(html, /title="影片甲"/);
        assert.match(html, /http:\/\/x\/p\.jpg/);
    });

    test('封面兜底链：无 vod_pic 时走占位图（并带 data-cover-missing 供补拉）', () => {
        const ctx = loadHome();
        // 本文件的 vodCoverImg 桩输出占位文件名；真实实现还会带 data-cover-missing="1"
        const html = ctx.__vodCard({ vod_id: '1', vod_name: '无封面片' }, 'site-a');
        assert.match(html, /cover-fallback\.svg/);
        assert.doesNotMatch(html, /src=""/);
    });

    test('标题转义防 XSS：片名含 <script> 与引号不产出可执行标签', () => {
        const ctx = loadHome();
        const html = ctx.__vodCard({ vod_id: '"><img onerror=alert(1)>', vod_name: '<script>alert(1)</script>"x\'' }, 'site-a');
        assert.doesNotMatch(html, /<script>/);
        assert.match(html, /&lt;script&gt;/);
        assert.doesNotMatch(html, /data-id=""><img/, 'data-id 属性不得被引号闭合');
        assert.match(html, /&quot;/);
    });

    test('集数/备注展示：vod_remarks 渲染进 .vod-remarks', () => {
        const ctx = loadHome();
        const html = ctx.__vodCard({ vod_id: '1', vod_name: '片', vod_remarks: '更新至 12 集' }, 'site-a');
        assert.match(html, /<div class="vod-remarks">更新至 12 集<\/div>/);
    });

    test('缺字段：无 remarks / 无 name / 无 id 均不抛错且产生空串兜底', () => {
        const ctx = loadHome();
        const html = ctx.__vodCard({}, 'site-a');
        assert.match(html, /class="vod-card"/);
        assert.match(html, /data-name=""/);
        assert.match(html, /<div class="vod-remarks"><\/div>/);
    });

    test('src 为 null/undefined 时不输出 data-source（供 T42 封面补拉定位源）', () => {
        const ctx = loadHome();
        assert.doesNotMatch(ctx.__vodCard({ vod_id: '1', vod_name: 'n' }, null), /data-source/);
        assert.doesNotMatch(ctx.__vodCard({ vod_id: '1', vod_name: 'n' }), /data-source/);
    });

    test('eager 参数透传给封面（首屏立即加载 vs 懒加载）', () => {
        const ctx = loadHome();
        // common.js 的真实 vodCoverImg：eager=true → loading="eager"，否则 lazy
        const eagerHtml = vm.runInContext('vodCard({vod_id:"1",vod_name:"n",vod_pic:"https://x/p.jpg"}, "s", true)', ctx);
        const lazyHtml = vm.runInContext('vodCard({vod_id:"1",vod_name:"n",vod_pic:"https://x/p.jpg"}, "s")', ctx);
        assert.match(eagerHtml, /loading="eager"/);
        assert.match(lazyHtml, /loading="lazy"/);
    });

    test('renderGrid：列表为空时输出「暂无内容」占位（不渲染卡片）', () => {
        const ctx = loadHome();
        const H = home(ctx);
        H.renderGrid([]);
        assert.match(String(ctx.__cap.bySel.get('#home-grid')), /暂无内容/);
    });
});

// ================================================================ home.js：页缓存与合并窗口

describe('home.js · 页缓存 LRU 与合并窗口', () => {
    test('_cachePut/_cacheGet：写入后命中，返回列表与 pagecount', () => {
        const ctx = loadHome();
        const H = home(ctx);
        const list = [{ vod_id: '1' }];
        H._cachePut('s', 'tid1', 1, list, 5);
        const got = H._cacheGet('s', 'tid1', 1);
        assert.deepEqual(got.list, list);
        assert.equal(got.pagecount, 5);
    });

    test('_cacheGet：未命中（无条目/无该页）返回 null', () => {
        const ctx = loadHome();
        const H = home(ctx);
        assert.equal(H._cacheGet('s', 'nope', 1), null);
        H._cachePut('s', 'tid1', 1, [{ vod_id: '1' }], 1);
        assert.equal(H._cacheGet('s', 'tid1', 2), null);
    });

    test('_cachePut：单分类超过 10 页时淘汰最旧页（防无限增长）', () => {
        const ctx = loadHome();
        const H = home(ctx);
        for (let pg = 1; pg <= 11; pg++) H._cachePut('s', 'tid1', pg, [{ vod_id: String(pg) }], 1);
        assert.equal(H._cacheGet('s', 'tid1', 1), null, '最旧的第 1 页被淘汰');
        assert.ok(H._cacheGet('s', 'tid1', 11), '最新页保留');
    });

    test('_cachePut：全局超过 32 个分类时淘汰最旧分类', () => {
        const ctx = loadHome();
        const H = home(ctx);
        for (let i = 1; i <= 33; i++) H._cachePut('s', 'tid' + i, 1, [{ vod_id: 'x' }], 1);
        assert.equal(H._cacheGet('s', 'tid1', 1), null, '最旧分类被淘汰');
        assert.ok(H._cacheGet('s', 'tid33', 1), '最新分类保留');
    });

    test('_cacheDropSite：按源前缀清理页缓存与合并窗口', () => {
        const ctx = loadHome();
        const H = home(ctx);
        H._cachePut('s1', 't', 1, [{ vod_id: '1' }], 1);
        H._cachePut('s2', 't', 1, [{ vod_id: '2' }], 1);
        H._catWinGet('s1', '__all__');
        H._catWinGet('s2', '__all__');
        H._cacheDropSite('s1');
        assert.equal(H._cacheGet('s1', 't', 1), null);
        assert.ok(H._cacheGet('s2', 't', 1), '其它源不受影响');
        assert.equal(H._catWin.has('s1|__all__'), false, '合并窗口按源清理');
        assert.equal(H._catWin.has('s2|__all__'), true);
    });

    test('_catWinGet：懒建窗口，重复取用返回同一对象（累积源页）', () => {
        const ctx = loadHome();
        const H = home(ctx);
        const w1 = H._catWinGet('s', '__all__');
        w1.items.push({ vod_id: '1' });
        const w2 = H._catWinGet('s', '__all__');
        assert.equal(w1, w2, '同一 key 返回同一窗口对象');
        assert.equal(w2.items.length, 1);
        assert.equal(w1.perPage, 20);
    });
});

// ================================================================ home.js：持久化缓存 helper

describe('home.js · 分类/feed 持久化 helper', () => {
    test('_saveClassCache/_loadClassCache：写入读取往返，落在 yuki_cache:: 命名空间', () => {
        const ctx = loadHome();
        const H = home(ctx);
        const cls = [{ type_id: '1', type_name: '电影' }];
        H._saveClassCache('site-a', cls);
        assert.ok(ctx.__lsStore.has('yuki_cache::home::class::v1::site-a'), '写入 cache.js 命名空间');
        assert.deepEqual(H._loadClassCache('site-a'), cls);
    });

    test('_saveClassCache：空列表/非数组/空 site 不写缓存（防异常源污染预渲染）', () => {
        const ctx = loadHome();
        const H = home(ctx);
        H._saveClassCache('site-a', []);
        H._saveClassCache('site-a', null);
        H._saveClassCache('', [{ type_id: '1' }]);
        assert.equal(ctx.__lsStore.size, 0, '空/非法输入不落盘');
    });

    test('_loadClassCache：未命中/非数组返回 null，site 为空返回 null', () => {
        const ctx = loadHome();
        const H = home(ctx);
        assert.equal(H._loadClassCache('none'), null);
        ctx.localCacheSet('home::class::v1::bad', { a: 1 }, 1000);
        assert.equal(H._loadClassCache('bad'), null, '非数组缓存按未命中处理');
        assert.equal(H._loadClassCache(''), null);
    });

    test('_cacheHomePut/_cacheHomeGet：首页 feed 往返（含 pagecount 与 60 条上限截断）', () => {
        const ctx = loadHome();
        const H = home(ctx);
        const items = Array.from({ length: 80 }, (_, i) => ({ vod_id: String(i) }));
        H._cacheHomePut('site-a', items, 4);
        const got = H._cacheHomeGet('site-a');
        assert.ok(got, 'feed 缓存命中');
        assert.equal(got.pagecount, 4);
        assert.equal(got.items.length, 60, '只保留前 60 条');
        assert.equal(got.items[0].vod_id, '0');
    });

    test('_cacheHomePut：空列表/非数组/空 site 不写缓存', () => {
        const ctx = loadHome();
        const H = home(ctx);
        H._cacheHomePut('site-a', [], 1);
        H._cacheHomePut('site-a', null, 1);
        H._cacheHomePut('', [{ vod_id: '1' }], 1);
        assert.equal(ctx.__lsStore.size, 0);
    });

    test('_cacheHomeGet：无缓存 / items 为空数组 → 返回 null', () => {
        const ctx = loadHome();
        const H = home(ctx);
        assert.equal(H._cacheHomeGet('none'), null);
        ctx.localCacheSet('home::feed::v1::empty', { ts: Date.now(), pagecount: 1, items: [] }, 1000);
        assert.equal(H._cacheHomeGet('empty'), null, '空 items 不算有效 feed 缓存');
    });
});

// ================================================================ detail.js：_detailCacheGet / _detailCacheSet

describe('detail.js · _detailCacheGet/_detailCacheSet TTL 语义', () => {
    test('写入→读取往返：值完整还原，落在 yuki_cache::detail::vod::v1:: 命名空间', () => {
        const ctx = loadDetail();
        const key = 'site-a|v1';
        ctx.__detailCacheSet(ctx.__DETAIL_VOD_CACHE_PREFIX, key, { vod_name: '片 A', vod_id: 'v1' }, 60000);
        assert.ok(ctx.__lsStore.has('yuki_cache::' + ctx.__DETAIL_VOD_CACHE_PREFIX + key));
        assert.deepEqual(ctx.__detailCacheGet(ctx.__DETAIL_VOD_CACHE_PREFIX, key), { vod_name: '片 A', vod_id: 'v1' });
    });

    test('TTL 命中：10 分钟内可读（DETAIL_CACHE_TTL 语义）', () => {
        const ctx = loadDetail();
        assert.equal(ctx.__DETAIL_CACHE_TTL, 10 * 60 * 1000);
        ctx.__detailCacheSet(ctx.__DETAIL_VOD_CACHE_PREFIX, 's|1', { a: 1 }, ctx.__DETAIL_CACHE_TTL);
        assert.deepEqual(ctx.__detailCacheGet(ctx.__DETAIL_VOD_CACHE_PREFIX, 's|1'), { a: 1 });
    });

    test('TTL 过期：时间戳推进到过期后读取返回 null 并惰性删除', () => {
        const ctx = loadDetail();
        const full = 'yuki_cache::' + ctx.__DETAIL_VOD_CACHE_PREFIX + 's|exp';
        ctx.__detailCacheSet(ctx.__DETAIL_VOD_CACHE_PREFIX, 's|exp', { a: 1 }, 1000);
        const saved = JSON.parse(ctx.__lsStore.get(full));
        saved.e = Date.now() - 1; // 手动过期
        ctx.__lsStore.set(full, JSON.stringify(saved));
        assert.equal(ctx.__detailCacheGet(ctx.__DETAIL_VOD_CACHE_PREFIX, 's|exp'), null);
        assert.equal(ctx.__lsStore.has(full), false, '过期条目被惰性删除');
    });

    test('未命中：从未写入的 key 返回 null（不抛错）', () => {
        const ctx = loadDetail();
        assert.equal(ctx.__detailCacheGet(ctx.__DETAIL_VOD_CACHE_PREFIX, 'ghost|1'), null);
    });

    test('非法 key：空串 / null / undefined 不读写，返回 null', () => {
        const ctx = loadDetail();
        ctx.__detailCacheSet(ctx.__DETAIL_VOD_CACHE_PREFIX, '', { a: 1 }, 1000);
        ctx.__detailCacheSet(ctx.__DETAIL_VOD_CACHE_PREFIX, null, { a: 1 }, 1000);
        ctx.__detailCacheSet(ctx.__DETAIL_VOD_CACHE_PREFIX, undefined, { a: 1 }, 1000);
        assert.equal(ctx.__lsStore.size, 0, '空 key 不落盘');
        assert.equal(ctx.__detailCacheGet(ctx.__DETAIL_VOD_CACHE_PREFIX, ''), null);
        assert.equal(ctx.__detailCacheGet(ctx.__DETAIL_VOD_CACHE_PREFIX, null), null);
    });

    test('空值守卫：value 为 null/undefined 时不落盘（空 bundle 不缓存）', () => {
        const ctx = loadDetail();
        ctx.__detailCacheSet(ctx.__DETAIL_VOD_CACHE_PREFIX, 's|null', null, 1000);
        ctx.__detailCacheSet(ctx.__DETAIL_VOD_CACHE_PREFIX, 's|undef', undefined, 1000);
        assert.equal(ctx.__lsStore.size, 0);
    });

    test('命名空间隔离：vod 前缀与 bgmextra 前缀互不可见', () => {
        const ctx = loadDetail();
        ctx.__detailCacheSet(ctx.__DETAIL_VOD_CACHE_PREFIX, 'key', { kind: 'vod' }, 10000);
        ctx.__detailCacheSet(ctx.__DETAIL_BGMEXTRA_CACHE_PREFIX, 'key', { kind: 'bgm' }, 10000);
        assert.deepEqual(ctx.__detailCacheGet(ctx.__DETAIL_VOD_CACHE_PREFIX, 'key'), { kind: 'vod' });
        assert.deepEqual(ctx.__detailCacheGet(ctx.__DETAIL_BGMEXTRA_CACHE_PREFIX, 'key'), { kind: 'bgm' });
        assert.equal(ctx.__lsStore.size, 2, '两个前缀各占一条');
    });

    test('容量上限：单条目超过 ~1.5MB 时放弃写入（不把其他条目全淘汰）', () => {
        const ctx = loadDetail();
        ctx.localCacheSet('warm', { a: 1 }, 60000);
        const big = 'x'.repeat(1.6 * 1024 * 1024);
        const ok = ctx.localCacheSet('huge', big, 60000);
        assert.equal(ok, false, '超限条目返回 false');
        assert.equal(ctx.localCacheGet('huge'), null);
        assert.deepEqual(ctx.localCacheGet('warm'), { a: 1 }, '已有条目不被淘汰');
    });

    test('容量上限：累积写入触发淘汰最旧条目（仍在容量内可写入新值）', () => {
        const ctx = loadDetail();
        const chunk = 'y'.repeat(400 * 1024); // 每块约 400KB
        for (let i = 0; i < 4; i++) ctx.localCacheSet('k' + i, chunk, 60000);
        assert.deepEqual(ctx.localCacheGet('k0'), null, '最旧条目被淘汰');
        assert.equal(ctx.localCacheGet('k3').length, chunk.length, '最新条目保留');
    });

    test('缓存不可用（无 localCacheGet/Set）时静默降级：读 null、写不抛错', () => {
        const emptyCtx = { console, Date, JSON, String };
        emptyCtx.globalThis = emptyCtx;
        vm.createContext(emptyCtx);
        vm.runInContext(`${read('src/renderer/js/detail.js')}\n;globalThis.__g = _detailCacheGet; globalThis.__s = _detailCacheSet;`,
            emptyCtx, { filename: 'detail-no-cache.js' });
        assert.equal(emptyCtx.__g('p', 'k'), null);
        emptyCtx.__s('p', 'k', { a: 1 }, 1000); // 不抛错即通过
    });
});

// ================================================================ detail.js：详情数据渲染

describe('detail.js · 详情数据渲染', () => {
    const VOD = {
        vod_id: 'v1', vod_name: '测试影片', vod_pic: 'http://x/p.jpg',
        type_name: '动漫', vod_year: '2024', vod_area: '日本', vod_remarks: '全 12 集',
        vod_director: '导演甲', vod_actor: '演员甲,演员乙', vod_content: '简介文本',
        vod_play_from: '线路A$$$线路B',
        vod_play_url: '第1集$u1#第2集$u2#第3集$u3$$$第1集$v1',
    };

    test('parsePlay：按 $$$ 拆线路、# 拆集、$ 拆集名与地址，空线路被过滤', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        const srcs = plain(D.parsePlay(VOD));
        assert.equal(srcs.length, 2);
        assert.equal(srcs[0].from, '线路A');
        assert.deepEqual(srcs[0].episodes.map((e) => e.name), ['第1集', '第2集', '第3集']);
        assert.deepEqual(srcs[0].episodes.map((e) => e.url), ['u1', 'u2', 'u3']);
        assert.deepEqual(srcs[1].episodes, [{ name: '第1集', url: 'v1' }]);
    });

    test('parsePlay：无 $ 的裸地址 → 集名与地址相同', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        const srcs = plain(D.parsePlay({ vod_play_from: 'A', vod_play_url: 'http://x/1.m3u8' }));
        assert.deepEqual(srcs[0].episodes, [{ name: 'http://x/1.m3u8', url: 'http://x/1.m3u8' }]);
    });

    test('parsePlay：空线路 / 空集数 → 过滤后为空数组（不产生空线路）', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        assert.deepEqual(plain(D.parsePlay({ vod_play_from: '', vod_play_url: '' })), []);
        assert.deepEqual(plain(D.parsePlay({ vod_play_from: 'A$$$B', vod_play_url: '$$$' })), []);
    });

    test('metaLine：元信息按 类型·年份·地区·备注 拼接，缺字段自动跳过', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        assert.equal(D.metaLine(VOD), '动漫 · 2024 · 日本 · 全 12 集');
        assert.equal(D.metaLine({ vod_year: '2020' }), '2020');
        assert.equal(D.metaLine({}), '');
    });

    test('render：字段映射进 hero（片名/元信息/封面/导演演员）', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        D._vod = VOD;
        D.sources = D.parsePlay(VOD);
        D.render();
        const html = String(ctx.__cap.bySel.get('#detail-body') || '');
        assert.match(html, /测试影片/);
        assert.match(html, /动漫 · 2024 · 日本 · 全 12 集/);
        assert.match(html, /http:\/\/x\/p\.jpg/);
        assert.match(html, /导演：导演甲/);
        assert.match(html, /演员：演员甲,演员乙/);
        assert.match(html, /影片详情/, '无 Bangumi 匹配时走 CatVod kicker');
    });

    test('render：来源线路展示「N 条线路 · 共 M 集」', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        D._vod = VOD;
        D.sources = D.parsePlay(VOD);
        D.render();
        const html = String(ctx.__cap.bySel.get('#detail-body') || '');
        assert.match(html, /2 条线路 · 共 3 集/);
    });

    test('render：无播放线路时展示「暂无播放线路」', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        D._vod = { vod_name: '无源片' };
        D.sources = [];
        D.render();
        const html = String(ctx.__cap.bySel.get('#detail-body') || '');
        assert.match(html, /暂无播放线路/);
    });

    test('render：页签栏六页签齐备且当前页签标记 active', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        D._vod = VOD;
        D.sources = D.parsePlay(VOD);
        D.render();
        const html = String(ctx.__cap.bySel.get('#detail-body') || '');
        for (const t of ['概览', '分集', '角色', '吐槽', '制作', '关联']) {
            assert.ok(html.includes(`data-tab="${t}"`), `页签 ${t} 应渲染`);
        }
        assert.match(html, /class="detail-tab active" data-tab="概览"/);
    });

    test('renderEpisodes：集目列表按线路构造并按倒序重排（_epDesc 只影响展示）', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        D.sources = [{ from: '线路A', episodes: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }] }];
        D.activeSource = 0;
        D._epDesc = false;
        D.renderEpisodes();
        const names = ctx.__cap.appended.filter((a) => a.sel === '#ep-list').map((a) => a.html);
        assert.equal(names.length, 2, '正序追加 2 集');
        assert.match(names[0], /data-idx="0"/);
        assert.match(names[1], /data-idx="1"/);
        ctx.__cap.appended.length = 0;
        D._epDesc = true;
        D.renderEpisodes();
        const desc = ctx.__cap.appended.filter((a) => a.sel === '#ep-list').map((a) => a.html);
        assert.match(desc[0], /data-idx="1"/, '倒序时先追加最后一集');
    });

    test('_renderEpisodes：有线路时渲染线路按钮与集数角标', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        D.sources = [{ from: '线路A', episodes: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }] }];
        D.activeSource = 0;
        D._renderEpisodes();
        const html = String(ctx.__cap.bySel.get('#detail-tab-content') || '');
        assert.match(html, /class="play-src active" data-idx="0"/);
        assert.match(html, /线路A <span class="play-src-count">2<\/span>/);
        assert.match(html, /id="ep-list"/);
    });

    test('_renderEpisodes：无线路且无 Bangumi → 空态「该视频暂无播放源」', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        D.sources = [];
        D._bgmId = null;
        D._renderEpisodes();
        const html = String(ctx.__cap.bySel.get('#detail-tab-content') || '');
        assert.match(html, /该视频暂无播放源/);
    });

    test('_catvodStartHtml：有线路有选集 → 渲染「开始播放」；无线/无集 → 空串', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        assert.equal(D._catvodStartHtml(), '', '无线路时无按钮');
        D.sources = [{ from: 'A', episodes: [] }];
        assert.equal(D._catvodStartHtml(), '', '有线路无选集时无按钮');
        D.sources = [{ from: 'A', episodes: [{ name: '第1集', url: 'u1' }] }];
        assert.match(D._catvodStartHtml(), /id="detail-catvod-start"/);
        assert.match(D._catvodStartHtml(), /开始播放/);
    });

    test('load：命中详情缓存时不发网络请求（缓存复用）', async () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        let netCalls = 0;
        ctx.doAction = async () => { netCalls++; return { list: [VOD] }; };
        ctx.__detailCacheSet(ctx.__DETAIL_VOD_CACHE_PREFIX, 'site-a|v1', VOD, ctx.__DETAIL_CACHE_TTL);
        await D.load();
        assert.equal(netCalls, 0, '缓存命中零网络请求');
        assert.equal(D._vod.vod_name, '测试影片');
    });

    test('load：未命中缓存时拉网络并写回缓存（下次免拉）', async () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        let netCalls = 0;
        ctx.doAction = async () => { netCalls++; return { list: [VOD] }; };
        await D.load();
        assert.equal(netCalls, 1);
        assert.deepEqual(ctx.__detailCacheGet(ctx.__DETAIL_VOD_CACHE_PREFIX, 'site-a|v1'), VOD);
    });

    test('load：并发加载去重——A→B 快速连开，慢的 A 响应不得覆盖 B 页面', async () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        const netCalls = [];
        ctx.doAction = async (action, kv) => {
            const id = JSON.parse(kv.ids)[0];
            netCalls.push(id);
            if (id === 'v2') await new Promise((r) => setTimeout(r, 30)); // A 慢
            return { list: [{ vod_id: id, vod_name: id === 'v2' ? '慢片' : '快片' }] };
        };
        D.vodId = 'v2';
        const pSlow = D.load();
        D.vodId = 'v1';
        const pFast = D.load();
        await Promise.all([pSlow, pFast]);
        assert.equal(D.vodId, 'v1', '详情页归属最后一次打开');
        assert.equal(D._vod.vod_name, '快片', '慢响应因世代不符被丢弃（P2-4 守卫）');
        assert.deepEqual(netCalls, ['v2', 'v1'], '两次打开各发一次网络请求');
    });

    test('load：重复打开同一详情命中缓存 → 第二次零网络请求（去重）', async () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        let netCalls = 0;
        ctx.doAction = async () => { netCalls++; return { list: [VOD] }; };
        await D.load();
        await D.load();
        assert.equal(netCalls, 1, '同 site|vodId 第二次走 _detailCacheGet');
    });

    test('load：详情拉取为空 → 空态「未取得详情」（不渲染 hero）', async () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        ctx.doAction = async () => ({ list: [] });
        await D.load();
        const html = String(ctx.__cap.bySel.get('#detail-body') || '');
        assert.match(html, /未取得详情/);
        assert.equal(D._vod, null);
    });

    test('load：详情拉取失败并带 error → 空态附错误原因且已转义', async () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        ctx.doAction = async () => ({ error: '<img onerror=alert(1)>' });
        await D.load();
        const html = String(ctx.__cap.bySel.get('#detail-body') || '');
        assert.match(html, /未取得详情/);
        assert.doesNotMatch(html, /<img onerror/, 'error 必须转义后进 HTML');
        assert.match(html, /&lt;img onerror/);
    });

    test('load：网络抛异常 → 空态「详情载入失败」并提示', async () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        ctx.doAction = async () => { throw new Error('net down'); };
        await D.load();
        const html = String(ctx.__cap.bySel.get('#detail-body') || '');
        assert.match(html, /详情载入失败/);
        assert.ok(ctx.__toasts.some((t) => /详情载入失败/.test(t)), '失败需给用户 toast');
    });

    test('open：缺 site 或 vodId 时直接提示且不进入详情视图', () => {
        const ctx = loadDetail();
        const D = detail(ctx);
        let shown = null;
        ctx.App = { currentView: 'home', showView: (v) => { shown = v; } };
        D.open('', 'v1');
        assert.ok(ctx.__toasts.some((t) => /缺少站点或视频 ID/.test(t)));
        D.open('site-a', '');
        assert.equal(ctx.__toasts.filter((t) => /缺少站点或视频 ID/.test(t)).length, 2);
        assert.equal(shown, null, '参数缺失不切视图');
    });
});
