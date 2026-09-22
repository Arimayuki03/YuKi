'use strict';
// catvod 详情页「开始播放」按钮回归测试：
// 1) CatVod 详情渲染（有线路/选集）时头部包含 #detail-catvod-start，样式 class 与
//    Kazumi「开始观看」按钮一致（md-btn md-btn-filled md-btn-sm + kazumi-watch-row）
// 2) 无线路/选集时不渲染按钮
// 3) 点击「开始播放」直接调 _playEpisode(0)（默认线路第 1 集，一键语义）
// 4) 无线路时点击给出友好 toast，不抛错
// 5) 匹配到 Bangumi ID 但详情拉取失败（_bgmInfo=null）时按钮回退渲染，不静默消失
// 6) Bangumi 数据存在（_bangumiColHtml 非空）时不渲染 #detail-catvod-start，避免双按钮
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 最小 jQuery 桩：链式 on/addClass/removeClass/attr/html/text/prop/find/each。
 *  html(arg) 与 text(arg) 的参数写入 captor（若提供）。
 *  on 额外记录委托选择器（jQuery 委托签名 on(ev, selector, handler)），
 *  供事件委托测试按「容器 + 委托目标」精确定位监听器。 */
function makeJqStub(captor) {
    return (sel) => ({
        on(ev, a, b) {
            const fn = typeof b === 'function' ? b : a;
            const delegated = typeof b === 'function' ? String(a) : '';
            if (captor && typeof fn === 'function') captor.bound.push({ sel: String(sel), ev, delegated, fn });
            return this;
        },
        off() { return this; },
        html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), s); return this; },
        text() { return this; },
        addClass() { return this; },
        removeClass() { return this; },
        attr() { return this; },
        prop() { return this; },
        find() { return this; },
        each() { return this; },
    });
}

/** 在 VM 中加载 detail.js（最小桩），返回 Detail 对象、监听器记录与 HTML 捕获。 */
function loadDetail() {
    const source = read('src/renderer/js/detail.js');
    const captor = { bound: [], htmlBySel: new Map() };
    const toasts = [];
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout,
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
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, bound: captor.bound, htmlBySel: captor.htmlBySel, toasts };
}

const SAMPLE_VOD = {
    vod_name: '测试影片', vod_pic: '', vod_content: '',
    vod_play_from: '线路A$$$线路B',
    vod_play_url: '第1集$u1#第2集$u2$$$第1集$v1',
};

test('catvod 详情渲染：有线路/选集时头部包含「开始播放」按钮且与 Kazumi 开始观看同款样式', () => {
    const { Detail, htmlBySel } = loadDetail();
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.activeSource = 0;
    Detail.render();
    const html = String(htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('id="detail-catvod-start"'), '详情头部应含 #detail-catvod-start 按钮');
    assert.ok(html.includes('开始播放'));
    // 与 #detail-kazumi-start（Kazumi「开始观看」）同一视觉口径
    assert.ok(html.includes('md-btn md-btn-filled md-btn-sm'));
    assert.ok(html.includes('kazumi-watch-row detail-watch-row-plain'));
    // 不应误染 Kazumi 按钮本身（CatVod 源无 Kazumi 开始观看）
    assert.ok(!html.includes('id="detail-kazumi-start"'));
});

test('catvod 详情渲染：无线路/选集时不渲染「开始播放」按钮', () => {
    const { Detail, htmlBySel } = loadDetail();
    Detail._vod = { vod_name: '空片', vod_pic: '', vod_content: '', vod_play_from: '', vod_play_url: '' };
    Detail.sources = Detail.parsePlay(Detail._vod);
    Detail.activeSource = 0;
    Detail.render();
    const html = String(htmlBySel.get('#detail-body') || '');
    assert.ok(!html.includes('id="detail-catvod-start"'), '无线路时不应渲染开始播放按钮');
    // 渲染器层面同样返回空
    const { Detail: D2 } = loadDetail();
    assert.equal(D2._catvodStartHtml(), '');
    D2.sources = [{ from: 'A', episodes: [] }];
    D2.activeSource = 0;
    assert.equal(D2._catvodStartHtml(), '');
});

test('catvod 详情渲染：匹配到 Bangumi ID 但详情拉取失败（bgm=null）时回退渲染「开始播放」按钮', () => {
    // 复现 _bgmId 已设置、Kazumi.bangumiInfo catch 返回 null（_bgmInfo=null）的场景：
    // 此前 _bangumiColHtml(null) 返回空串导致 _catvodStartHtml 被跳过，按钮静默消失
    const { Detail, htmlBySel } = loadDetail();
    Detail._vod = SAMPLE_VOD;
    Detail._bgmId = '12345';
    Detail._bgmInfo = null; // bangumiInfo 拉取失败（kazumi.js catch → null）
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.activeSource = 0;
    Detail.render();
    const html = String(htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('id="detail-catvod-start"'), 'bgm=null 且有线路时仍应渲染开始播放按钮');
    assert.ok(html.includes('开始播放'));
    // _bangumiColHtml(null) 返回空串，触发回退
    assert.equal(Detail._bangumiColHtml(null), '');
});

test('catvod 详情渲染：Bangumi 数据存在时不渲染「开始播放」按钮，避免双按钮', () => {
    const { Detail, htmlBySel } = loadDetail();
    Detail._vod = SAMPLE_VOD;
    Detail._bgmId = '12345';
    // _bangumiColHtml 对无 bgm.id 的数据返回空串；给出有效数据使其渲染收藏行
    Detail._bgmInfo = { id: 12345, name: '测试影片', images: {} };
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.activeSource = 0;
    Detail.render();
    const html = String(htmlBySel.get('#detail-body') || '');
    assert.notEqual(Detail._bangumiColHtml(Detail._bgmInfo), '', '前置：_bangumiColHtml 非空才构成双按钮场景');
    assert.ok(!html.includes('id="detail-catvod-start"'), 'bgm 收藏行非空时不应再渲染开始播放按钮');
    // 纯 Bangumi-only 详情（openBangumi 正常路径 sources=[]）同理
    const { Detail: D2 } = loadDetail();
    D2._bgmId = '12345';
    D2._bgmInfo = { id: 12345, name: '测试影片', images: {} };
    D2.sources = [];
    D2.activeSource = 0;
    D2.render();
    const html2 = String(htmlBySel.get('#detail-body') || '');
    assert.ok(!html2.includes('id="detail-catvod-start"'), 'openBangumi 正常路径不应渲染开始播放按钮');
    assert.equal(D2._catvodStartHtml(), '', 'sources 为空时 _catvodStartHtml 自然返回空串');
});

test('「开始播放」点击：按当前（默认/记忆）线路播第 1 集，一键直达', async () => {
    const { Detail, toasts } = loadDetail();
    Detail.sources = [{ from: 'A', episodes: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }] }];
    Detail.activeSource = 0;
    Detail.vodName = '测试影片';
    const played = [];
    Detail._playEpisode = async (idx) => { played.push(idx); };
    await Detail._catvodStartPlay();
    assert.deepEqual(played, [0]);
    assert.equal(toasts.length, 0);
    // 倒序展示记忆下仍取数据首集（下标 0）
    Detail._epDesc = true;
    await Detail._catvodStartPlay();
    assert.deepEqual(played, [0, 0]);
});

test('「开始播放」点击：无线路时给出友好 toast 不抛错', async () => {
    const { Detail, toasts } = loadDetail();
    Detail.sources = [];
    Detail.activeSource = 0;
    await Detail._catvodStartPlay();
    assert.equal(toasts.length, 1);
    assert.ok(/暂无可播放/.test(toasts[0]));
});

test('事件委托：#detail-body 委托区 #detail-catvod-start 点击转发 _catvodStartPlay（行为断言）', async () => {
    const { Detail, bound } = loadDetail();
    Detail.init();
    const hit = bound.find((b) => b.sel === '#detail-body' && b.ev === 'click'
        && b.delegated === '#detail-catvod-start');
    assert.ok(hit, '应在 #detail-body 委托区找到 #detail-catvod-start 点击监听');
    // 幂等：重复 init 不重复绑定（_escBound 守卫）
    Detail.init();
    const hits = bound.filter((b) => b.sel === '#detail-body' && b.ev === 'click'
        && b.delegated === '#detail-catvod-start');
    assert.equal(hits.length, 1);

    // 行为断言：以合成事件对象直接调用监听器，验证其转发到 _catvodStartPlay
    // （jQuery 委托回调收到事件对象，currentTarget/delegateTarget 指向命中元素）
    const syntheticEvent = {
        type: 'click',
        target: { id: 'detail-catvod-start' },
        currentTarget: { id: 'detail-catvod-start' },
        delegateTarget: { id: 'detail-body' },
    };
    let playCalled = 0;
    Detail._catvodStartPlay = async () => { playCalled += 1; };
    await hit.fn(syntheticEvent);
    assert.equal(playCalled, 1, '#detail-catvod-start 点击监听应转发调用 _catvodStartPlay');
    await hit.fn(syntheticEvent);
    assert.equal(playCalled, 2, '每次点击都应转发（不吞事件）');
});
