'use strict';
// A-25 + A-26 回归测试：详情页嵌套返回的滚动位置恢复与入场动画跳过。
//
// 数据流背景（A-25 验证结论）：
//   详情页嵌套跳转（详情A → 关联 → 详情B → 返回详情A）全程停留在 #view-detail
//   视图内——Detail._restore 调 App.showView('detail') 时 App.currentView 已是
//   'detail'，showView 的 `name !== this.currentView` 分支不执行（app.js），
//   _scrollPos 不写入不读取；且 showView 对 name==='detail' 固定回顶（backTop=0），
//   但该双 rAF 只在视图切换路径跑，嵌套返回根本不触发。滚动位置只能靠
//   Detail 自己的快照自持 → _snapshot 记录 scrollTop、_restore 经 render 回写。
//
// A-26：嵌套返回是「回到刚离开的页面」，重播 hero→页签→内容三级入场
// （.detail-page-anim）只会拖慢手感；_restore 路径给 render 传 skipPageAnim，
// 页签内容 .tab-enter 淡入保留（_swapTabContent 内 replayClass，与本次无关）。
// 直接打开详情（load/openBangumi → render() 无参）仍播三级入场，行为不变。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SAMPLE_VOD = {
    vod_name: '测试影片', vod_pic: '', vod_content: '这是一段足够长的简介文本，用于触发概览区渲染。' + 'x'.repeat(120),
    vod_play_from: '线路A',
    vod_play_url: '第1集$u1#第2集$u2',
};

/** 最小 jQuery 桩：html 按选择器捕获；addClass/removeClass 记录到 classLog；
 *  $ 全局门 exposeNew 供 render 内 addClass/removeClass 链拆分调用。 */
function makeJqStub(captor, classLog) {
    const makeNode = (sel) => ({
        sel: String(sel),
        length: 1,
        _data: {},
        // on/off 统一为记录调用（全批桩一致口径）：绑定信息落 captor.bound 供事件断言
        on(ev, a, b) {
            const fn = typeof b === 'function' ? b : a;
            const delegated = typeof b === 'function' ? String(a) : '';
            if (captor && typeof fn === 'function') captor.bound.push({ sel: String(sel), ev, delegated, fn });
            return this;
        },
        off() { return this; },
        html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), String(s)); return this; },
        text() { return this; },
        addClass(cls) { if (classLog && String(sel) === '#detail-body') classLog.added.push(String(cls)); return this; },
        removeClass(cls) { if (classLog && String(sel) === '#detail-body') classLog.removed.push(String(cls)); return this; },
        attr() { return this; },
        prop() { return this; },
        // find(s) 对齐真实 querySelector：后代组合器拼接（全批桩统一口径）；
        // 无参调用无子选择器可用，视为后代通配
        find(s) { return makeNode(s === undefined ? String(sel) + ' *' : String(sel) + ' ' + String(s)); },
        children() { return Object.assign(makeNode(String(sel) + ' > *'), { length: 0 }); },
        each() { return this; },
        not() { return this; },
        is() { return false; },
        toggle() { return this; },
        hide() { return this; },
        show() { return this; },
        closest() { return makeNode(String(sel) + ' ^'); },
        data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
    });
    return (sel) => makeNode(sel);
}

/** 在 VM 中加载 detail.js（最小桩）。
 *  viewEl：可选，document.getElementById('view-detail') 返回它（scrollTop 记录用）。 */
function loadDetail(extra, viewEl) {
    const source = read('src/renderer/js/detail.js');
    const captor = { bound: [], htmlBySel: new Map() };
    const classLog = { added: [], removed: [] };
    const app = { currentView: 'detail', showView() {}, _detailOpening: false }; // currentView='detail'：复刻嵌套返回场景
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, URL, Number,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: (id) => (id === 'view-detail' && viewEl ? viewEl : null),
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: makeJqStub(captor, classLog),
        registerEsc: () => {},
        escHtml: (s) => String(s),
        stripHtml: (s) => String(s || ''),
        warnToast: () => {},
        showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: () => '<img src="cover.jpg">',
        normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        localCacheGet: () => null,
        localCacheSet: () => {},
        localCacheDel: () => {},
        openDialog: () => {}, closeDialog: () => {},
        replayClass: () => {},
        App: app,
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, htmlBySel: captor.htmlBySel, classLog, bound: captor.bound, context };
}

/** CatVod 详情夹具：_vod/sources 已填（render 可直接渲染分集与概览）。 */
function withCatvod(Detail) {
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.activeSource = 0;
    Detail.site = 'catvodA';
    Detail.vodId = 'v1';
}

// ---------------------------------------------------------------- A-25

test('A-25：_snapshot 记录 #view-detail 的 scrollTop（滚动容器自持，App._scrollPos 不覆盖嵌套返回）', () => {
    const scrollState = { top: 0 };
    const viewEl = { scrollTop: 0, scrollHeight: 2000, clientHeight: 800 };
    Object.defineProperty(viewEl, 'scrollTop', { get: () => scrollState.top, set: (v) => { scrollState.top = v; } });
    const { Detail } = loadDetail({}, viewEl);
    withCatvod(Detail);
    Detail._activeTab = '概览';
    scrollState.top = 432; // 用户在详情A滚到 432px 后点关联进详情B
    const snap = Detail._snapshot();
    assert.equal(snap.scrollTop, 432, '快照应记录当前视图滚动位置');
    // 元素缺失时兜底 0（vm 外真实 DOM 恒在，桩容错）
    const { Detail: D2 } = loadDetail();
    withCatvod(D2);
    assert.equal(D2._snapshot().scrollTop, 0, 'view-detail 不存在时 scrollTop 兜底 0');
});

test('A-25：_restore 经 render 回写 scrollTop（吸顶区间外的普通位置）', async () => {
    const scrollState = { top: 0 };
    const viewEl = { scrollTop: 0, scrollHeight: 2000, clientHeight: 800 };
    Object.defineProperty(viewEl, 'scrollTop', { get: () => scrollState.top, set: (v) => { scrollState.top = v; } });
    const { Detail } = loadDetail({
        Kazumi: {
            hasEnabledRules: () => false,
            _applyBangumiColState: null,
            bangumiInfo: async () => ({ id: 42, name: '番剧' }),
        },
    }, viewEl);
    withCatvod(Detail);
    const snap = Detail._snapshot();
    snap.scrollTop = 432;
    // 模拟嵌套跳转把当前状态覆盖掉
    Detail._vod = null; Detail.sources = []; Detail._activeTab = '分集';
    scrollState.top = 0;
    await Detail._restore(snap);
    assert.equal(scrollState.top, 432, 'render 后应回写快照滚动位置');
    assert.equal(Detail._activeTab, '概览', '页签随快照恢复');
});

test('A-25：恢复页内容比离开时更矮（scrollTop 越界）→ _clampDetailScroll 同帧钳制', async () => {
    const scrollState = { top: 0 };
    const viewEl = { scrollTop: 0, scrollHeight: 1000, clientHeight: 800 }; // max=200
    Object.defineProperty(viewEl, 'scrollTop', { get: () => scrollState.top, set: (v) => { scrollState.top = v; } });
    const { Detail } = loadDetail({}, viewEl);
    withCatvod(Detail);
    const snap = Detail._snapshot();
    snap.scrollTop = 500; // 越界：max=200
    await Detail._restore(snap);
    assert.equal(scrollState.top, 200, '越界 scrollTop 应被钳到 scrollHeight-clientHeight');
});

// ---------------------------------------------------------------- A-26

test('A-26：_restore 路径 render 不挂 .detail-page-anim，且摘除可能残留的该 class', async () => {
    const { Detail, classLog, htmlBySel } = loadDetail({
        Kazumi: { hasEnabledRules: () => false, bangumiInfo: async () => ({ id: 42, name: '番剧' }) },
    });
    withCatvod(Detail);
    await Detail._restore(Detail._snapshot());
    assert.ok(!classLog.added.includes('detail-page-anim'), '恢复路径不得挂 detail-page-anim');
    assert.ok(classLog.removed.includes('detail-page-anim'), '恢复路径应摘除残留的 detail-page-anim（防入场重播）');
    assert.ok(classLog.added.length === 0 && classLog.removed.includes('detail-page-anim'),
        '恢复路径只摘 class，不新增任何容器类');
    assert.ok(String(htmlBySel.get('#detail-body') || '').includes('detail-tabs'), '内容正常渲染（跳过动画 ≠ 跳过渲染）');
});

test('A-26：直接打开详情（render 无参）仍挂 .detail-page-anim（三级入场行为不变）', () => {
    const { Detail, classLog } = loadDetail();
    withCatvod(Detail);
    Detail.render();
    assert.ok(classLog.added.includes('detail-page-anim'), '直接打开详情应保留三级入场动画挂载');
    assert.equal(classLog.removed.length, 0, '直接打开不应摘除 detail-page-anim');
});

// ---------------------------------------------------------------- 数据流论证

test('A-25 数据流论证：_restore 调 App.showView("detail") 时 currentView 已是 detail，App._scrollPos 不介入', async () => {
    // 断言 app.js 源码锚点：滚动保存/恢复都发生在「视图切换」分支内，
    // 且 detail 恒回顶——证明嵌套返回（视图不切换）的滚动恢复必须由快照自持
    const appSrc = read('src/renderer/js/app.js');
    assert.ok(appSrc.includes('if (name !== this.currentView) {'),
        'showView 仅在视图切换时写 _scrollPos（嵌套返回 name===currentView 不触发）');
    assert.ok(appSrc.includes("(name === 'detail') ? 0 : (this._scrollPos[name] || 0)"),
        'showView 对 detail 固定回顶——视图级滚动记忆对详情页本来就无效');
    // 精确锚点：app.js 仅在导航恢复判定中 getElementById('view-detail')（navTarget，
    // 与滚动无关）；其滚动读写只针对 '.view' 级容器（_scrollPos 记忆 / 回顶），
    // 不触碰 #view-detail 内部滚动容器——嵌套返回的滚动自持必须由 Detail 快照承担
    const scrollZone = appSrc.slice(appSrc.indexOf('if (name !== this.currentView) {'), appSrc.indexOf('initBackTop()'));
    assert.ok(!scrollZone.includes("getElementById('view-detail')"),
        'showView 滚动保存/恢复代码不得触碰 #view-detail 内部滚动容器');
    assert.ok(scrollZone.includes("curEl.scrollTop") && scrollZone.includes("el.scrollTop = backTop"),
        'showView 滚动读写仅作用于 .view 级容器');
    // detail.js 锚点：_restore 体内有 App.showView("detail") 调用
    // （嵌套返回时 currentView 已是 detail，该调用不触发视图切换分支）
    const detailSrc = read('src/renderer/js/detail.js');
    const restoreBody = detailSrc.slice(detailSrc.indexOf('_restore(snapshot)'), detailSrc.indexOf('/** 嵌套跳转回退'));
    assert.ok(restoreBody.includes("App.showView('detail')"),
        '_restore 走 App.showView("detail")——若 currentView 已是 detail 则无视图切换');
    assert.ok(restoreBody.includes('skipPageAnim: true'), 'A-26：_restore 应给 render 传 skipPageAnim 标记');
    assert.ok(restoreBody.includes('snapshot.scrollTop'), 'A-25：_restore 应把快照 scrollTop 传给 render');
});
