'use strict';
// CatVod 详情页「本地观看进度行」回归测试（detail.js _refreshLocalProgress）：
// 1) 有本地进度记录（Favorites.getProgress）→ 详情头部渲染进度条「N/M」
// 2) 无进度记录 / 未收藏条目 → 进度行保持隐藏（text('') + hide()）
// 3) Bangumi 匹配详情（hasBgm）不渲染本地进度行容器——进度走 ep_status 行
// 4) Records/Favorites 缺失 → 静默隐藏，不抛错
// 5) render() 路径（CatVod 有 vod）自动触发回填
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 最小 jQuery 桩：html/text 落到 captor（text 记 ::text 后缀，与 hide/show 记 flags）。 */
function makeJqStub(captor) {
    const makeNode = (sel) => ({
        sel: String(sel),
        length: 1,
        _data: {},
        on() { return this; },
        off() { return this; },
        html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), s); return this; },
        text(s) { if (captor && s !== undefined) captor.textBySel.set(String(sel), String(s)); return this; },
        css(prop, v) { if (captor && v !== undefined) captor.cssBySel.set(String(sel) + '::' + String(prop), String(v)); return this; },
        addClass() { return this; },
        removeClass() { return this; },
        toggleClass() { return this; },
        replaceWith() { return this; },
        attr() { return this; },
        prop() { return this; },
        find(childSel) {
            // jQuery 语义：find 接受选择器，在当前节点范围内查找——桩按「父选择器 + 子选择器」
            // 拼接落键，保证 el.find('.fill').css('width') 的写入可被测试按完整路径断言。
            const child = String(childSel || '');
            return makeNode(String(sel) + ' ' + (child.startsWith('.') ? child : '*'));
        },
        each() { return this; },
        not() { return this; },
        is() { return false; },
        toggle() { return this; },
        hide() { if (captor) captor.hidden.add(String(sel)); return this; },
        show() { if (captor) captor.shown.add(String(sel)); return this; },
        closest() { return makeNode(String(sel) + ' ^'); },
        data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
    });
    return (sel) => {
        if (sel && typeof sel === 'object') return makeNode('obj');
        return makeNode(sel);
    };
}

/** 在 VM 中加载 detail.js（最小桩）。opts.watchProgress 为通用进度表桩数据；
 *  opts.favProgress 为旧版收藏条目 progress 字段（回退路径）；两者都缺 = 无进度。 */
function loadDetail({ watchProgress = null, favProgress = null, favHubNotify = null } = {}) {
    const captor = { htmlBySel: new Map(), textBySel: new Map(), cssBySel: new Map(), hidden: new Set(), shown: new Set() };
    const toasts = [];
    const wpCalls = [];
    const favCalls = [];
    const source = read('src/renderer/js/detail.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, URL, CSS: { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') },
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: () => null,
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: makeJqStub(captor),
        registerEsc: () => {},
        escHtml: (s) => String(s),
        stripHtml: (s) => String(s || ''),
        warnToast: (m) => toasts.push(String(m)),
        showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: () => '<img src="cover.jpg">',
        normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        localCacheGet: () => null,
        localCacheSet: () => {},
        openDialog: () => {}, closeDialog: () => {},
        App: { currentView: 'detail', showView() {} },
        Kazumi: undefined,
        Records: {
            isFavorite: async () => !!favProgress, // 旧版回退路径对应已收藏；通用表路径不依赖收藏
            getFavTag: async () => 'watching', setFavTag: async () => {}, toggleFavorite: async () => {},
            getWatchProgress: async (site, vodId) => { wpCalls.push({ site, vodId }); return watchProgress; },
        },
        Favorites: {
            getProgress: async (site, vodId) => { favCalls.push({ site, vodId }); return favProgress; },
            updateProgress: async () => {},
        },
        FavHub: { onChanged: (fn) => { if (favHubNotify) favHubNotify.fn = fn; return () => {}; }, changed() {} },
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    Object.defineProperty(context, 'globalThis', { value: context });
    vm.createContext(context);
    vm.runInContext(read('src/renderer/js/cache.js'), context, { filename: 'cache.js' });
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, captor, toasts, wpCalls, favCalls, context };
}

/** 断言进度条状态：el 已显示、文案与条宽符合预期（kind: 'ep'|'話' 后缀）。 */
function assertBar(captor, expectText, expectPct, label) {
    const txt = captor.textBySel.get('#detail-body .detail-local-progress .detail-watch-progress-text');
    const w = captor.cssBySel.get('#detail-body .detail-local-progress .detail-watch-progress-fill::width');
    assert.equal(txt, expectText, label + '：文案');
    assert.equal(w, expectPct + '%', label + '：条宽');
}

const SAMPLE_VOD = {
    vod_name: '测试影片', vod_pic: '', vod_content: '',
    vod_play_from: '线路A',
    vod_play_url: '第1集$u1#第2集$u2',
};

test('本地进度行：通用进度表有记录时显示进度条「N/M」（不依赖收藏）', async () => {
    const { Detail, captor, wpCalls, favCalls } = loadDetail({ watchProgress: { currentEp: 3, totalEps: 12, percent: 25, ts: 1 } });
    Detail.site = 'site-a'; Detail.vodId = 'v1';
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.activeSource = 0;
    Detail.render();
    await Detail._refreshLocalProgress();
    assert.ok(wpCalls.length >= 1, '应调用 Records.getWatchProgress');
    assert.deepEqual(
        { site: wpCalls[wpCalls.length - 1].site, vodId: wpCalls[wpCalls.length - 1].vodId },
        { site: 'site-a', vodId: 'v1' });
    assert.equal(favCalls.length, 0, '通用表命中时不应再走收藏条目回退');
    assertBar(captor, '3/12', 25, '通用表命中'); // 3/12=25%（按集数比例）
    assert.ok(captor.shown.has('#detail-body .detail-local-progress'), '进度条应 show()');
});

test('本地进度行：未收藏影片有播放记录（通用表命中）→ 正常显示进度', async () => {
    // 未收藏：isFavorite=false、收藏条目无 progress；进度只存在于通用表
    const { Detail, captor } = loadDetail({ watchProgress: { currentEp: 5, totalEps: 24, percent: 20, ts: 1 } });
    Detail.site = 'site-b'; Detail.vodId = 'v-not-fav';
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.render();
    await Detail._refreshLocalProgress();
    assertBar(captor, '5/24', 21, '未收藏'); // 5/24≈20.8% → 21%
    assert.ok(captor.shown.has('#detail-body .detail-local-progress'));
});

test('本地进度行：通用表未命中回退旧版收藏条目 progress 字段', async () => {
    const { Detail, captor, favCalls } = loadDetail({ favProgress: { currentEp: 2, totalEps: 10, percent: 20, ts: 1 } });
    Detail.site = 'site-a'; Detail.vodId = 'v1';
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.render();
    await Detail._refreshLocalProgress();
    assert.ok(favCalls.length >= 1, '通用表未命中应走 Favorites.getProgress 回退');
    assertBar(captor, '2/10', 20, '回退收藏字段');
});

test('本地进度行：无进度记录 → 隐藏不显示', async () => {
    const { Detail, captor } = loadDetail({});
    Detail.site = 'site-a'; Detail.vodId = 'v1';
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.render();
    await Detail._refreshLocalProgress();
    assert.equal(captor.textBySel.get('#detail-body .detail-local-progress .detail-watch-progress-text') || '', '');
    assert.ok(captor.hidden.has('#detail-body .detail-local-progress'), '无进度应 hide()');
    assert.ok(!captor.shown.has('#detail-body .detail-local-progress'));
});

test('本地进度行：currentEp=0（看过 0 集）→ 隐藏', async () => {
    const { Detail, captor } = loadDetail({ watchProgress: { currentEp: 0, totalEps: 12, percent: 0, ts: 1 } });
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.render();
    await Detail._refreshLocalProgress();
    assert.ok(captor.hidden.has('#detail-body .detail-local-progress'));
});

test('本地进度行：totalEps 缺失时回退当前线路集数推条宽', async () => {
    const { Detail, captor } = loadDetail({ watchProgress: { currentEp: 1, totalEps: 0, percent: 0, ts: 1 } });
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD); // 2 集
    Detail.render();
    await Detail._refreshLocalProgress();
    assertBar(captor, '1/2', 50, '集数回退'); // 1/2=50%
});

test('Bangumi 匹配详情（hasBgm）：不渲染本地进度行容器', () => {
    const { Detail, captor } = loadDetail();
    Detail._vod = SAMPLE_VOD;
    Detail._bgmId = '12345';
    Detail._bgmInfo = { id: 12345, name: '测试影片', images: {}, eps: 12 };
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.render();
    const html = String(captor.htmlBySel.get('#detail-body') || '');
    assert.ok(!html.includes('detail-local-progress'), '有 Bangumi 数据时进度由统计区进度条展示，不渲染本地进度容器');
});

test('Records/Favorites 缺失：静默隐藏不抛错', async () => {
    const { Detail, captor, context } = loadDetail();
    // _refreshLocalProgress 判断的是 VM 全局 typeof Records/typeof Favorites（context
    // 注入即全局），必须在 VM context 内真删全局才走到组件缺失分支；Detail 对象上
    // 从不读 .Records/.Favorites，对其赋 undefined 是死操作（两条引用里只有全局生效）
    vm.runInContext('Records = undefined; Favorites = undefined;', context);
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.render();
    await Detail._refreshLocalProgress();
    assert.ok(captor.hidden.has('#detail-body .detail-local-progress'), '组件缺失应安全隐藏');
});

test('FavHub 广播：收藏变更回调里会刷新本地进度行（播放逐集记账实时上屏）', async () => {
    const hook = {};
    const { Detail, wpCalls } = loadDetail({ watchProgress: { currentEp: 1, totalEps: 2, percent: 50, ts: 1 }, favHubNotify: hook });
    Detail.init(); // FavHub.onChanged 订阅在 init() 中注册
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.render();
    const before = wpCalls.length;
    assert.equal(typeof hook.fn, 'function', 'init() 应注册 FavHub 订阅回调');
    hook.fn(); // 触发 FavHub.onChanged 注册的回调
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(wpCalls.length > before, '广播回调应触发 _refreshLocalProgress → getWatchProgress');
});
