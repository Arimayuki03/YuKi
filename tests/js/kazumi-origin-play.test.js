/**
 * 白盒单元测试：Kazumi 搜索 → 详情页「开始观看」默认用该源播放（T85）。
 *
 * 链路：search.js 结果卡点击 → Kazumi.openBangumiInfoPage(id, kazumiOrigin)
 *   → Detail.openBangumi(id, '', origin) 存 _kazumiOrigin →
 *   点 #detail-kazumi-start → Kazumi.openSourceDialog(name, origin.site, origin.src)
 *   → openSourceDialog kazumi: 直达分支解析该源剧集（_loadChapters）。
 *
 * 覆盖：
 *   - search.js：两条 Bangumi 匹配成功路径（缓存命中 / bangumiSearch 回填）都携带
 *     kazumiOrigin；匹配失败回落 openSourceDialog 的入参不变（回归口径）
 *   - detail.js：openBangumi 校验/清洗 origin；open() 重置；快照/恢复保留
 *   - detail.js：#detail-kazumi-start 点击按 _kazumiOrigin 分叉
 *   - kazumi.js：openBangumiInfoPage 透传；openSourceDialog 直达分支预建 _dlgState
 *     （「← 返回选源」可回、单源重查结果可上卡）
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------------------------------------------------------------- search.js

/** 加载 search.js（最小桩），返回捕获的 openBangumiInfoPage/openSourceDialog 调用。 */
function loadSearchForCardClick() {
    const source = read('src/renderer/js/search.js');
    const calls = { bangumiInfo: [], sourceDialog: [], bangumiSearch: [] };
    const KazumiStub = {
        openSourceDialog: (name, site, src) => calls.sourceDialog.push([name, site, src]),
        openBangumiInfoPage: (id, origin) => calls.bangumiInfo.push([String(id), origin]),
        bangumiSearch: (name) => {
            calls.bangumiSearch.push(name);
            return new Promise((resolve) => { KazumiStub._resolveSearch = resolve; });
        },
        cacheBangumiMatch: () => {},
    };
    // 记录型 $ 桩：捕获 .vod-card 委托处理器与 data-source 属性识别
    const handlers = new Map();
    const node = (sel) => ({
        sel: String(sel),
        length: 1,
        on(ev, a, b) {
            const fn = typeof b === 'function' ? b : a;
            const delegated = typeof b === 'function' ? String(a) : '';
            const r = handlers.get(String(sel)) || { handlers: [] };
            r.handlers.push({ ev, delegated, fn });
            handlers.set(String(sel), r);
            return this;
        },
        off() { return this; }, html() { return this; }, append() { return this; },
        text() { return this; }, show() { return this; }, hide() { return this; },
        empty() { return this; }, find() { return node(sel + ' *'); },
    });
    const $ = (sel) => ((sel && typeof sel === 'object') ? sel : node(sel));
    $.fire = (sel, ev, evt) => {
        const r = handlers.get(String(sel));
        assert.ok(r, `应已绑定 ${sel}`);
        r.handlers.filter((h) => h.ev === ev).forEach((h) => h.fn.call({}, evt));
    };
    const context = {
        console, setTimeout, clearTimeout, encodeURIComponent, JSON, Math, Object, Array, String, Promise,
        $,
        escHtml: (s) => String(s),
        warnToast: () => {},
        showLoading: () => {}, hideLoading: () => {},
        apiUrl: (u) => u,
        Detail: { open: () => {} },
        Kazumi: KazumiStub,
        vodCard: (v) => `<div class="vod-card" data-id="${v.vod_id}" data-name="${v.vod_name}"></div>`,
        vodCoverImg: () => '', bangumiCover: () => '', bangumiCoverImg: () => '',
        truncateTitle: (s) => s, getCachedCover: () => '', fillMissingCovers: () => {},
        abortCoverFill: () => {}, fitVodTitles: () => {}, playCardsEnter: () => {},
        renderPagerBox: () => {}, pageSizeOf: async () => 20, renderStatusBar: (el) => el,
        errorTextOf: (e) => String(e),
        UIState: { isEnabled: () => false },
        localCacheGet: () => null, localCacheSet: () => {},
        window: {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'search.js' });
    const Search = vm.runInContext('Search', context);
    Search.init();
    // 取当前控制器（agg / kz 同一工厂），注册结果容器委托后模拟点击
    const page = Search.agg || Search.kz;
    const clickCard = (el) => $.fire('#search-results', 'click', { currentTarget: el });
    return { Search, page, clickCard, calls, KazumiStub };
}

const cardEl = (source, id, name) => ({
    _data: { source, id, name },
    data(k) { return this._data[k]; },
});

test('search：Kazumi 卡命中 Bangumi 缓存进详情页时携带 kazumiOrigin（site+src）', async () => {
    const h = loadSearchForCardClick();
    h.KazumiStub.getCachedBangumiMatch = () => ({ id: '383233', cover: 'c.jpg' });
    h.clickCard(cardEl('kazumi:樱花动漫', 'https://src.example/page/1', '葬送的芙莉莲'));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls.bangumiInfo.length, 1, '应走 openBangumiInfoPage');
    assert.equal(h.calls.bangumiInfo[0][0], '383233');
    const origin = h.calls.bangumiInfo[0][1];
    assert.ok(origin && typeof origin === 'object', '应携带 kazumiOrigin');
    assert.equal(origin.site, 'kazumi:樱花动漫');
    assert.equal(origin.src, 'https://src.example/page/1');
});

test('search：Kazumi 卡经 bangumiSearch 回填后进详情页同样携带 kazumiOrigin', async () => {
    const h = loadSearchForCardClick();
    h.KazumiStub.getCachedBangumiMatch = () => null;
    h.KazumiStub.bangumiSearch = () => Promise.resolve([{ id: 999, images: { large: 'l.jpg' } }]);
    h.clickCard(cardEl('kazumi:樱花动漫', 'src-u2', '无职转生'));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls.bangumiInfo.length, 1);
    assert.equal(h.calls.bangumiInfo[0][0], '999');
    const origin = h.calls.bangumiInfo[0][1];
    assert.ok(origin && typeof origin === 'object', '应携带 kazumiOrigin');
    assert.equal(origin.site, 'kazumi:樱花动漫');
    assert.equal(origin.src, 'src-u2');
});

test('search：Kazumi 卡未匹配到 Bangumi 回落 openSourceDialog，入参口径不变', async () => {
    const h = loadSearchForCardClick();
    h.KazumiStub.getCachedBangumiMatch = () => null;
    h.KazumiStub.bangumiSearch = () => Promise.resolve([]); // 无带图结果
    h.clickCard(cardEl('kazumi:樱花动漫', 'src-u3', '冷门番'));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls.bangumiInfo.length, 0);
    assert.deepEqual(h.calls.sourceDialog[0], ['冷门番', 'kazumi:樱花动漫', 'src-u3']);
});

// ---------------------------------------------------------------- detail.js

/** 加载 detail.js（最小桩），返回 Detail 与捕获的 openSourceDialog 调用。 */
function loadDetailHarness() {
    const source = read('src/renderer/js/detail.js');
    const toasts = [];
    const srcDialog = [];
    const app = { currentView: 'search', showView() {}, _detailOpening: false };
    const KazumiStub = {
        openSourceDialog: (name, site, src) => srcDialog.push([name, site, src]),
        bangumiInfo: async () => ({ id: 383233, name: '芙莉莲', name_cn: '葬送的芙莉莲' }),
        hasEnabledRules: () => true,
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, URL,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: () => null,
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: () => {
            const n = { length: 1, on() { return n; }, off() { return n; }, html() { return n; }, text() { return n; },
                addClass() { return n; }, removeClass() { return n; }, attr() { return n; }, prop() { return n; },
                find() { return n; }, each() { return n; }, not() { return n; }, is() { return false; },
                toggle() { return n; }, hide() { return n; }, show() { return n; }, closest() { return n; },
                data() { return undefined; } };
            return n;
        },
        registerEsc: () => {},
        escHtml: (s) => String(s),
        stripHtml: (s) => String(s || ''),
        warnToast: (m) => toasts.push(String(m)),
        showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '', vodCoverImg: () => '<img>', normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        localCacheGet: () => null, localCacheSet: () => {},
        openDialog: () => {}, closeDialog: () => {},
        App: app,
        Kazumi: KazumiStub,
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    Detail.init();
    return { Detail, toasts, srcDialog, app, KazumiStub, context };
}

test('detail：openBangumi 校验 kazumiOrigin（kazumi: 前缀 + src 齐全才保留）', async () => {
    const { Detail } = loadDetailHarness();
    await Detail.openBangumi('111', '', { site: 'kazumi:樱花动漫', src: 'https://s/1' });
    assert.equal(Detail._kazumiOrigin.site, 'kazumi:樱花动漫');
    assert.equal(Detail._kazumiOrigin.src, 'https://s/1');
    // 非法形态清洗为 null
    await Detail.openBangumi('222', '', { site: 'catvodA', src: 'x' });
    assert.equal(Detail._kazumiOrigin, null, '非 kazumi: 前缀不保留');
    await Detail.openBangumi('333', '', { site: 'kazumi:A', src: '' });
    assert.equal(Detail._kazumiOrigin, null, '缺 src 不保留');
    await Detail.openBangumi('444', '');
    assert.equal(Detail._kazumiOrigin, null, '未传为 null');
});

test('detail：open()（CatVod 详情）重置 _kazumiOrigin 防残留', () => {
    const { Detail } = loadDetailHarness();
    Detail._kazumiOrigin = { site: 'kazumi:A', src: 's' };
    Detail.open('catvodA', 'v1', '测试');
    assert.equal(Detail._kazumiOrigin, null);
});

test('detail：嵌套跳转快照保留 _kazumiOrigin，返回恢复后仍直达原源', async () => {
    const { Detail } = loadDetailHarness();
    await Detail.openBangumi('555', '', { site: 'kazumi:樱花动漫', src: 'src-a' });
    const snap = Detail._snapshot();
    Detail._kazumiOrigin = null; // 模拟嵌套打开新详情被覆盖
    Detail._restore(snap);
    assert.equal(Detail._kazumiOrigin && Detail._kazumiOrigin.site, 'kazumi:樱花动漫');
    assert.equal(Detail._kazumiOrigin && Detail._kazumiOrigin.src, 'src-a');
});

test('detail：#detail-kazumi-start 点击按 _kazumiOrigin 分叉（默认源直达 / 全源弹窗）', async () => {
    const h = loadDetailHarness();
    // 直接驱动委托处理器：从 init 绑定的 #detail-body 委托里取 #detail-kazumi-start
    // （桩 on() 全部吞掉，这里用源码行为等价方式：手动调用 handler）
    // ——改为在 $ 桩里记录：重载一份带记录桩的 detail
    const source = read('src/renderer/js/detail.js');
    const bound = [];
    const recNode = (sel) => ({
        length: 1,
        on(ev, a, b) {
            const fn = typeof b === 'function' ? b : a;
            const delegated = typeof b === 'function' ? String(a) : '';
            bound.push({ sel: String(sel), ev, delegated, fn });
            return recNode(sel);
        },
        off() { return recNode(sel); }, html() { return recNode(sel); }, text() { return recNode(sel); },
        addClass() { return recNode(sel); }, removeClass() { return recNode(sel); },
        attr() { return recNode(sel); }, prop() { return recNode(sel); },
        find() { return recNode(sel + ' *'); }, each() { return recNode(sel); },
        not() { return recNode(sel); }, is() { return false; },
        toggle() { return recNode(sel); }, hide() { return recNode(sel); }, show() { return recNode(sel); },
        closest() { return recNode(sel + ' ^'); }, data() { return undefined; },
    });
    const ctx2 = Object.assign({}, h.context, { $: (sel) => recNode(sel) });
    ctx2.globalThis = ctx2;
    vm.createContext(ctx2);
    vm.runInContext(source, ctx2, { filename: 'detail.js' });
    const Detail2 = vm.runInContext('Detail', ctx2);
    Detail2.init();
    const hdl = bound.filter((b) => b.sel === '#detail-body' && b.ev === 'click'
        && b.delegated === '#detail-kazumi-start').map((b) => b.fn);
    assert.equal(hdl.length, 1, '#detail-body 应委托绑定 #detail-kazumi-start');

    // 有来源：直达该源（site=kazumi:规则名 + src）
    await Detail2.openBangumi('666', '', { site: 'kazumi:樱花动漫', src: 'src-x' });
    Detail2.vodName = '葬送的芙莉莲';
    hdl[0].call({});
    assert.deepEqual(h.srcDialog[0], ['葬送的芙莉莲', 'kazumi:樱花动漫', 'src-x'],
        '开始观看应直达搜索来源源');

    // 无来源：维持全源选源弹窗（site='kazumi'、src=''）
    await Detail2.openBangumi('777', '');
    hdl[0].call({});
    assert.deepEqual(h.srcDialog[1], ['葬送的芙莉莲', 'kazumi', ''],
        '无搜索来源时保持全源选源弹窗');
});

// ---------------------------------------------------------------- kazumi.js

/** 加载 kazumi.js（最小桩），返回 Kazumi 与捕获的 _loadChapters 调用。 */
function loadKazumiHarness() {
    const source = read('src/renderer/js/kazumi.js');
    const chapters = [];
    const ctx = {
        console, Map, Promise, Date, Math, JSON, String, Array, parseInt, parseFloat,
        setTimeout, clearTimeout, MutationObserver: function () { this.observe = () => {}; },
        $: () => {
            const n = { length: 1, on() { return n; }, off() { return n; }, val() { return ''; },
                text() { return n; }, html() { return n; }, show() { return n; }, hide() { return n; },
                empty() { return n; }, append() { return n; }, prop() { return n; }, toggle() { return n; } };
            return n;
        },
        openDialog: () => {}, closeDialog: () => {},
        escHtml: (s) => String(s),
        warnToast: () => {},
        apiUrl: (u) => u,
        EventSource: function () { this.close = () => {}; },
        window: { yuki: {} },
        Detail: { openBangumi: async (id, name, origin) => { ctx.__detailCalls.push([id, name, origin]); } },
    };
    ctx.__detailCalls = [];
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(`${source}\n;globalThis.__testKazumi = Kazumi;`, ctx, { filename: 'kazumi.js' });
    const kazumi = ctx.__testKazumi;
    kazumi._loadChapters = async (pluginName, src, title, token) => chapters.push([pluginName, src, title, token]);
    kazumi.hasEnabledRules = () => true; // 桩环境无规则缓存，绕过入口守卫
    return { kazumi, chapters, detailCalls: ctx.__detailCalls, ctx };
}

test('kazumi：openBangumiInfoPage 透传 kazumiOrigin 给 Detail.openBangumi', async () => {
    const { kazumi, detailCalls } = loadKazumiHarness();
    kazumi._infoReferrer = '';
    await kazumi.openBangumiInfoPage('383233', { site: 'kazumi:A', src: 's1' });
    assert.deepEqual(detailCalls[0], ['383233', '', { site: 'kazumi:A', src: 's1' }]);
});

test('kazumi：openSourceDialog kazumi: 直达分支解析该源并预建 _dlgState（返回选源可回）', async () => {
    const { kazumi, chapters } = loadKazumiHarness();
    kazumi._rules = [
        { name: '樱花动漫', enabled: true, validity: 'valid' },
        { name: '禁用源', enabled: false },
        { name: '失效源', enabled: true, validity: 'invalid' },
    ];
    await kazumi.openSourceDialog('葬送的芙莉莲', 'kazumi:樱花动漫', 'https://src/page/1');
    // 直达解析：_loadChapters 收到该插件与 src
    assert.deepEqual(chapters[0], ['樱花动漫', 'https://src/page/1', '葬送的芙莉莲', 1]);
    // 预建选源状态：全部启用且未失效的源建卡（pending），不启动流式检索
    const st = kazumi._dlgState;
    assert.ok(st, '应预建 _dlgState');
    assert.equal(Object.keys(st.plugins).length, 1, '仅启用且未失效源建卡');
    assert.equal(st.plugins['樱花动漫'].status, 'pending');
    assert.equal(st.expanded, '樱花动漫', '当前源标记展开（返回选源回到该源卡）');
    assert.equal(st.keyword, '葬送的芙莉莲');
    // 单源重查可正常上卡（_applySourceResult 不再因 _dlgState 缺失被丢弃）
    kazumi._renderSourceCard = () => {}; // $ 桩无 filter，重绘直接跳过
    kazumi._updateSheetHeader = () => {};
    kazumi._applySourceResult({ name: '樱花动漫', list: [{ src: 'x', name: '芙莉莲' }] });
    assert.equal(st.plugins['樱花动漫'].status, 'success');
    // 返回选源可回（_backToSources → _renderSourceSheet 不再静默 return）
    let rendered = false;
    kazumi._renderSourceSheet = () => { rendered = true; };
    kazumi._backToSources();
    assert.ok(rendered, '「← 返回选源」应有处可回');
});

test('kazumi：openSourceDialog 非 kazumi: 前缀路径不受影响（全源检索，行为不变）', async () => {
    const { kazumi, chapters, ctx } = loadKazumiHarness();
    kazumi._rules = [{ name: 'A', enabled: true }];
    // 非直达路径会启动 SSE 全源检索：桩掉 EventSource 防挂起，记录是否打开
    let streamOpened = false;
    ctx.EventSource = function () { streamOpened = true; this.close = () => {}; this.addEventListener = () => {}; };
    await kazumi.openSourceDialog('测试', 'kazumi', '');
    assert.equal(chapters.length, 0, '无 src 不走直达解析');
    assert.equal(kazumi._dlgState && kazumi._dlgState.expanded, null);
    assert.ok(streamOpened, '应启动全源流式检索');
    assert.deepEqual(chapters, []);
});
