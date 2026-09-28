'use strict';
// catvod 详情页「开始播放」按钮回归测试：
// 1) CatVod 详情渲染（有线路/选集）时头部包含 #detail-catvod-start，样式 class 与
//    Kazumi「开始观看」按钮一致（md-btn md-btn-filled md-btn-sm + kazumi-watch-row）
// 2) 无线路/选集时不渲染按钮
// 3) 点击「开始播放」打开线路+集数弹窗（T79 引导范式，不再一键直播第 1 集）
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

/** 最小 jQuery 桩：链式 on/addClass/removeClass/attr/html/text/prop/find/each/data。
 *  html(arg) 与 text(arg) 的参数写入 captor（若提供）；节点带 length:1 与 data() 存取。
 *  on 额外记录委托选择器（jQuery 委托签名 on(ev, selector, handler)），
 *  供事件委托测试按「容器 + 委托目标」精确定位监听器。 */
function makeJqStub(captor) {
    const makeNode = (sel) => ({
        sel: String(sel),
        length: 1,
        _data: {},
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
        find() { return makeNode(String(sel) + ' *'); },
        each() { return this; },
        not() { return this; },
        is() { return false; },
        toggle() { return this; },
        hide() { return this; },
        show() { return this; },
        closest() { return makeNode(String(sel) + ' ^'); },
        data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
    });
    // $(domObj)：包装事件目标等对象——data() 委托回原对象（jQuery 读元素 data 的行为），
    // attr/closest 同样委托原对象方法（attr 读元素属性、closest 沿 DOM 上溯），
    // 其余链式方法空实现。选择器字符串仍走节点桩。
    return (sel) => {
        if (sel && typeof sel === 'object') {
            return {
                length: 1,
                data(k, v) { if (v !== undefined) sel._data = sel._data || {}; if (v !== undefined) sel._data[k] = v; return (typeof sel.data === 'function') ? sel.data(k) : (sel._data && sel._data[k]); },
                attr(k) { return (typeof sel.attr === 'function') ? sel.attr(k) : undefined; },
                closest(s) { return (typeof sel.closest === 'function') ? sel.closest(s) : makeNode('obj^'); },
                on() { return this; }, off() { return this; },
                html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), s); return this; },
                text() { return this; }, addClass() { return this; }, removeClass() { return this; },
                prop() { return this; }, find() { return this; }, each() { return this; },
                not() { return this; }, is() { return false; }, toggle() { return this; },
            };
        }
        return makeNode(sel);
    };
}

/** 在 VM 中加载 detail.js（最小桩），返回 Detail 对象、监听器记录与 HTML 捕获。 */
function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const captor = { bound: [], htmlBySel: new Map() };
    const toasts = [];
    const dialogs = { opened: [], closed: [] };
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
        openDialog: (id) => dialogs.opened.push(String(id)),
        closeDialog: (id) => dialogs.closed.push(String(id)),
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, bound: captor.bound, htmlBySel: captor.htmlBySel, toasts, dialogs, context };
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

test('「开始播放」点击：打开线路+集数弹窗（T79 引导范式，不直接起播）', () => {
    const { Detail, toasts } = loadDetail();
    Detail.sources = [{ from: 'A', episodes: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }] }];
    Detail.activeSource = 0;
    Detail.vodName = '测试影片';
    const played = [];
    Detail._playEpisode = async (idx) => { played.push(idx); };
    const opened = [];
    Detail._openCatvodPlayDialog = () => { opened.push(1); };
    Detail._catvodStartPlay();
    assert.deepEqual(played, [], 'T79：开始播放不应一键起播（改走选源选集弹窗）');
    assert.deepEqual(opened, [1], '应打开 CatVod 选源选集弹窗');
    assert.equal(toasts.length, 0);
});

test('「开始播放」点击：无线路时给出友好 toast 不抛错', () => {
    const { Detail, toasts } = loadDetail();
    Detail.sources = [];
    Detail.activeSource = 0;
    Detail._catvodStartPlay();
    assert.equal(toasts.length, 1);
    assert.ok(/暂无可播放/.test(toasts[0]));
});

test('_openCatvodPlayDialog：线路与集数同屏，默认选中当前线路，不含下载/勾选', () => {
    const { Detail, htmlBySel, dialogs } = loadDetail();
    Detail.sources = [
        { from: '线路A', episodes: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }] },
        { from: '线路B', episodes: [{ name: 'EP1', url: 'v1' }] },
    ];
    Detail.activeSource = 0; // lastSourceMap 记忆的线路
    Detail.vodName = '测试影片';
    Detail._epDesc = false;
    Detail._openCatvodPlayDialog();
    const sheetHtml = String(htmlBySel.get('#catvod-play-dialog-body') || '');
    assert.ok(sheetHtml.includes('catvod-play-src'), '弹窗应渲染线路按钮组');
    assert.ok(sheetHtml.includes('线路A'), '弹窗应显示线路名');
    assert.ok(sheetHtml.includes('data-idx="0"'), '弹窗应带线路下标');
    assert.ok(sheetHtml.includes('catvod-ep-btn'), '弹窗应渲染集数网格');
    assert.ok(sheetHtml.includes('第2集'), '弹窗应显示当前线路的集名');
    // 默认选中态：activeSource=0 → 第 0 个线路按钮 active
    assert.ok(/class="play-src catvod-play-src active" data-idx="0"/.test(sheetHtml),
        '当前线路按钮应带 active 高亮');
    // 弹窗内不应有下载/勾选元素（选集起播专用）
    assert.ok(!sheetHtml.includes('ep-check'), '弹窗集数不应含勾选框');
    assert.ok(!sheetHtml.includes('ep-dl-one'), '弹窗集数不应含单集下载');
    assert.deepEqual(dialogs.opened, ['catvodPlayDialog'], '渲染完成后应 openDialog');
    // 倒序记忆影响弹窗展示顺序（仅展示，不改数据下标）。
    // 断言限定在集数网格片段内（线路按钮同样带 data-idx，从整段 HTML 找会误判）
    Detail._epDesc = true;
    Detail._openCatvodPlayDialog();
    const sheetHtml2 = String(htmlBySel.get('#catvod-play-dialog-body') || '');
    const epsFragment2 = (sheetHtml2.match(/catvod-play-eps">([\s\S]*)$/) || ['', ''])[1];
    assert.ok(epsFragment2.indexOf('data-idx="1"') < epsFragment2.indexOf('data-idx="0"'),
        '_epDesc 倒序时弹窗内集数应倒序展示');
});

test('_catvodDialogSelectSource：切换线路重渲弹窗集数并记忆 lastSourceMap', () => {
    const { Detail, htmlBySel } = loadDetail();
    Detail.sources = [
        { from: '线路A', episodes: [{ name: '第1集', url: 'u1' }] },
        { from: '线路B', episodes: [{ name: 'EP1', url: 'v1' }, { name: 'EP2', url: 'v2' }] },
    ];
    Detail.activeSource = 0;
    Detail.vodName = '测试影片';
    const saved = [];
    Detail._saveLastSource = async () => { saved.push(Detail.activeSource); };
    Detail._catvodDialogSelectSource(1);
    assert.equal(Detail.activeSource, 1, '弹窗内点线路应同步 activeSource');
    assert.deepEqual(saved, [1], '弹窗内换线路应记忆 lastSourceMap');
    // 弹窗集数网格应换成新线路的集（线路B 有 EP1/EP2 两集；$ 桩的 html()
    // 以完整选择器字符串为 key，能精确捕获切换后内容）
    const epsHtml = String(htmlBySel.get('#catvod-play-dialog-body .catvod-play-eps') || '');
    assert.ok(epsHtml.includes('EP2') && epsHtml.includes('data-idx="1"'), '弹窗集数网格已换成新线路的集');
    // 越界/重复点击防护
    Detail._catvodDialogSelectSource(5);
    assert.equal(Detail.activeSource, 1, '越界下标应被忽略');
    Detail._catvodDialogSelectSource(1);
    assert.deepEqual(saved, [1], '重复点击当前线路不应重复记忆');
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

test('事件委托：CatVod 弹窗内点集先关窗再起播，点线路切弹窗展示（行为断言）', async () => {
    const { Detail, bound, dialogs } = loadDetail();
    Detail.init();
    const epHit = bound.find((b) => b.sel === '#catvod-play-dialog-body' && b.ev === 'click'
        && b.delegated === '.catvod-ep-btn');
    assert.ok(epHit, '应绑定弹窗集数按钮点击委托（挂弹窗自身容器，非 #detail-body）');
    const srcHit = bound.find((b) => b.sel === '#catvod-play-dialog-body' && b.ev === 'click'
        && b.delegated === '.catvod-play-src');
    assert.ok(srcHit, '应绑定弹窗线路按钮点击委托');

    // 点集：先关窗再起播（用户意图立即生效，弹窗不残留在播放画面之上）
    Detail.sources = [
        { from: '线路A', episodes: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }] },
        { from: '线路B', episodes: [{ name: 'EP1', url: 'v1' }] },
    ];
    Detail.activeSource = 0;
    const played = [];
    Detail._playEpisode = async (idx) => { played.push(idx); };
    // $ 桩 $(e.currentTarget).data('idx') → 节点 _data 预置 idx=2
    await epHit.fn({ currentTarget: { _data: { idx: '2' }, data(k) { return this._data[k]; } } });
    assert.deepEqual(dialogs.closed, ['catvodPlayDialog'], '点集应先关闭弹窗');
    assert.deepEqual(played, [2], '关窗后应按弹窗集下标起播');

    // 点线路：转发 _catvodDialogSelectSource（不关窗、不起播）
    let selected = -1;
    Detail._catvodDialogSelectSource = (idx) => { selected = idx; };
    await srcHit.fn({ currentTarget: { _data: { idx: '1' }, data(k) { return this._data[k]; } } });
    assert.equal(selected, 1, '点线路应转发 _catvodDialogSelectSource');
    assert.equal(dialogs.closed.length, 1, '点线路不应关窗');
    assert.equal(played.length, 1, '点线路不应起播');
});

// ---------------------------------------------------------------- 本地收藏单按钮（Bangumi 同款交互）

test('catvod hero 操作行：本地收藏改为单按钮+六态下拉（Bangumi 同款），不再是平铺六按钮', () => {
    const { Detail, htmlBySel } = loadDetail();
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.activeSource = 0;
    Detail.render();
    const html = String(htmlBySel.get('#detail-body') || '');
    // 单按钮：独立 id + 状态文案 + ▾ 箭头 + 六态菜单容器
    assert.ok(html.includes('id="detail-local-col-current"'), '应渲染本地收藏单按钮 #detail-local-col-current');
    assert.ok(/detail-local-col-current[^>]*>.*detail-col-label.*detail-col-caret/s.test(html),
        '单按钮内应含状态文案 label 与 ▾ 箭头');
    assert.ok(html.includes('detail-local-col-menu'), '应渲染六态下拉菜单容器');
    // 与 Bangumi 收藏按钮同一视觉口径（kazumi-col-btn + detail-col-wrap）
    assert.ok(/id="detail-local-col-current" class="md-btn md-btn-sm kazumi-col-btn"/.test(html),
        '单按钮样式应与 Bangumi 收藏按钮同款（kazumi-col-btn）');
    // 六态菜单齐全（下拉内状态按钮仍走 .detail-col-btn data-tag）
    for (const t of ['want', 'watching', 'seen', 'hold', 'dropped']) {
        assert.ok(html.includes(`data-tag="${t}"`), `六态菜单应含 data-tag="${t}"`);
    }
    // 旧平铺模式残留不应出现
    assert.ok(!html.includes('kazumi-bangumi-colrow detail-local-colrow'), '不应再渲染旧平铺行容器');
    assert.ok(!html.includes('detail-action-label'), '不应再渲染「我的收藏」文案块');
});

test('catvod hero 操作行：纯 CatVod 详情单行渲染 [开始播放][本地收藏▾][↗ 网页]', () => {
    const { Detail, htmlBySel } = loadDetail();
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.activeSource = 0;
    Detail.site = 'dem0';
    Detail._allSites = undefined;
    Detail.render();
    const html = String(htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('id="detail-catvod-start"'), '开始播放按钮保留');
    assert.ok(html.includes('id="detail-local-col-current"'), '本地收藏单按钮并入操作行');
    assert.ok(html.includes('kazumi-watch-row detail-watch-row-plain'), '单行容器与 Bangumi 行同款');
});

test('匹配 Bangumi 时：本地收藏单按钮成行置于 Bangumi 操作行之下（两套收藏并存）', () => {
    const { Detail, htmlBySel } = loadDetail();
    Detail._vod = SAMPLE_VOD;
    Detail._bgmId = '12345';
    Detail._bgmInfo = { id: 12345, name: '测试影片', images: {} };
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.activeSource = 0;
    Detail.render();
    const html = String(htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('id="detail-col-current"'), 'Bangumi 收藏单按钮在操作行');
    assert.ok(html.includes('id="detail-local-col-current"'), '本地收藏单按钮并存（包行容器）');
    // 匹配 Bangumi 时「开始播放」收进 _catvodStartHtml（原口径不渲染）
    assert.ok(!html.includes('id="detail-catvod-start"'), '匹配 Bangumi 时不渲染开始播放（原口径）');
});

test('匹配 Bangumi 时：「↗ 网页」按钮跟本地收藏同行（api 可推导即渲染，与 Bangumi 页按钮并存）', () => {
    const { Detail, htmlBySel } = loadDetail({ Home: { _allSites: [{ key: 'dem0', api: 'https://cdn.example.com/api.php' }] } });
    Detail._vod = SAMPLE_VOD;
    Detail._bgmId = '12345';
    Detail._bgmInfo = { id: 12345, name: '测试影片', images: {} };
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.activeSource = 0;
    Detail.site = 'dem0';
    Detail.render();
    const html = String(htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('id="detail-bgm-open"'), 'Bangumi 页按钮保留');
    assert.ok(html.includes('id="detail-catvod-web"'), '源站网页按钮与本地收藏同行渲染');
    // Bangumi 匹配失败回退（_bgmInfo=null）时网页按钮走纯 CatVod 行，同样存在
    const { Detail: D2, htmlBySel: cap2 } = loadDetail({ Home: { _allSites: [{ key: 'dem0', api: 'https://cdn.example.com/api.php' }] } });
    D2._vod = SAMPLE_VOD;
    D2._bgmId = '12345';
    D2._bgmInfo = null;
    D2.sources = Detail.parsePlay(SAMPLE_VOD);
    D2.activeSource = 0;
    D2.site = 'dem0';
    D2.render();
    const html2 = String(cap2.get('#detail-body') || '');
    assert.ok(html2.includes('id="detail-catvod-web"'), 'bgm=null 回退路径网页按钮不消失');
});

test('_siteWebUrl：从站点 api 推导源站首页（scheme://host/），非 http(s)/解析失败返回空串', () => {
    const { Detail, context } = loadDetail();
    Detail.site = 'a';
    context.Home = { _allSites: [{ key: 'a', api: 'https://cdn.example.com/api.php/provide/vod?at=json' }] };
    assert.equal(Detail._siteWebUrl(), 'https://cdn.example.com/', '应丢弃 path/query 只留 origin');
    context.Home = { _allSites: [{ key: 'a', api: 'http://v.example.com:8080/provide/vod' }] };
    assert.equal(Detail._siteWebUrl(), 'http://v.example.com:8080/', '带端口/路径的 api 同样推导 origin');
    // 非 http(s)（spider 类资源地址 / 相对路径）不推导
    context.Home = { _allSites: [{ key: 'a', api: 'assets://spider/csp_XBPQ' }] };
    assert.equal(Detail._siteWebUrl(), '', '非 http(s) api 不渲染网页按钮');
    // 站点不在列表（找不到 key）返回空串
    context.Home = { _allSites: [{ key: 'b', api: 'https://x.example.com/api.php' }] };
    assert.equal(Detail._siteWebUrl(), '', '找不到站点 key 返回空串');
    // api 为非法 URL 不抛错
    context.Home = { _allSites: [{ key: 'a', api: 'https://' }] };
    assert.equal(Detail._siteWebUrl(), '', 'URL 解析失败返回空串');
    // Home 未定义（页面未初始化）不抛错
    context.Home = undefined;
    assert.equal(Detail._siteWebUrl(), '', 'Home 不可用时返回空串');
});

test('catvod hero 操作行：api 可推导时渲染「↗ 网页」按钮（与 Bangumi 页按钮同款样式）', () => {
    const { Detail, htmlBySel } = loadDetail({ Home: { _allSites: [{ key: 'a', api: 'https://cdn.example.com/api.php' }] } });
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.activeSource = 0;
    Detail.site = 'a';
    Detail.render();
    const html = String(htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('id="detail-catvod-web"'), '应渲染 #detail-catvod-web 按钮');
    assert.ok(html.includes('↗ 网页'), '按钮文案「↗ 网页」');
    assert.ok(/id="detail-catvod-web" class="md-btn md-btn-sm"/.test(html), '与「↗ Bangumi 页」同款样式');
    // 推导不出 URL（spider 类源）时不渲染按钮，开始播放/收藏按钮不受影响
    const { Detail: D2, htmlBySel: cap2 } = loadDetail({ Home: { _allSites: [{ key: 'a', api: 'assets://spider/csp_X' }] } });
    D2._vod = SAMPLE_VOD;
    D2.sources = Detail.parsePlay(SAMPLE_VOD);
    D2.activeSource = 0;
    D2.site = 'a';
    D2.render();
    const html2 = String(cap2.get('#detail-body') || '');
    assert.ok(!html2.includes('id="detail-catvod-web"'), '无网页地址时不渲染网页按钮');
    assert.ok(html2.includes('id="detail-catvod-start"'));
    assert.ok(html2.includes('id="detail-local-col-current"'));
});

test('事件委托：#detail-catvod-web 点击按 _siteWebUrl 结果 window.open（守卫 + URL 口径）', async () => {
    const opened = [];
    const { Detail, bound, toasts, context } = loadDetail({
        window: { open: (u) => opened.push(String(u)), yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
        Home: { _allSites: [{ key: 'a', api: 'https://cdn.example.com/api.php/provide/vod' }] },
    });
    Detail.init();
    const hit = bound.find((b) => b.sel === '#detail-body' && b.ev === 'click'
        && b.delegated === '#detail-catvod-web');
    assert.ok(hit, '应绑定 #detail-catvod-web 点击委托');
    // api 可推导：开源站首页
    Detail.site = 'a';
    await hit.fn({});
    assert.deepEqual(opened, ['https://cdn.example.com/'], '应打开源站 origin');
    // 推导不出 URL：toast 提示，不开窗
    context.Home = { _allSites: [{ key: 'a', api: 'assets://spider/csp_X' }] };
    await hit.fn({});
    assert.equal(opened.length, 1, '无网页地址不应开窗');
    assert.equal(toasts.length, 1);
    assert.ok(/未配置网页地址/.test(toasts[0]));
});

test('本地收藏单按钮：点击展开六态菜单，菜单内状态按钮仍写本地收藏（委托行为断言）', async () => {
    const { Detail, bound } = loadDetail();
    Detail.init();
    const colHit = bound.find((b) => b.sel === '#detail-body' && b.ev === 'click'
        && b.delegated === '.kazumi-col-btn');
    assert.ok(colHit, '本地收藏单按钮复用 .kazumi-col-btn 委托');
    // 模拟 jQuery 包装的事件目标：attr('id') 与 closest().find() 链（菜单开合走 closest→find）
    let toggled = 0;
    const menuStub = { is: () => false, toggle() { toggled += 1; }, hide() {} };
    const mkTarget = (id) => ({
        _data: {},
        attr: (k) => (k === 'id' ? id : undefined),
        data(k) { return this._data[k]; },
        closest: () => ({ find: () => menuStub }),
    });
    await colHit.fn({ currentTarget: mkTarget('detail-local-col-current'), stopPropagation: () => {} });
    assert.equal(toggled, 1, '点击单按钮应切换菜单显隐');
    // 六态菜单内状态按钮走 .detail-col-btn 委托：选中即收藏 + 菜单收起
    const stateHit = bound.find((b) => b.sel === '#detail-body' && b.ev === 'click'
        && b.delegated === '.detail-col-btn');
    assert.ok(stateHit, '应绑定 .detail-col-btn 状态按钮委托');
    let setTag = -9;
    Detail.setLocalCollection = async (t) => { setTag = t; };
    const hidden = [];
    await stateHit.fn({ currentTarget: { _data: { tag: 'seen' }, data(k) { return this._data[k]; }, closest: () => ({ hide: () => hidden.push(1) }) } });
    assert.equal(setTag, 'seen', '菜单内状态按钮触发 setLocalCollection');
    assert.deepEqual(hidden, [1], '选中后收起六态菜单');
});

test('_refreshLocalCol：收藏状态回填单按钮文案与高亮（Bangumi 收藏按钮同款口径）', async () => {
    // 最小 $ 桩：链式记录 text/toggleClass 目标，验证单按钮回填
    const calls = { text: [], active: [] };
    const makeNode = (sel) => {
        const node = {
            sel: String(sel), length: 1,
            text(s) { calls.text.push([node.sel, String(s)]); return node; },
            toggleClass(_cls, on) { if (node.sel.includes('detail-local-col-current')) calls.active.push(!!on); return node; },
            addClass() { return node; }, removeClass() { return node; },
            attr() { return node; }, find() { return node; }, on() { return node; },
            data() { return undefined; },
        };
        return node;
    };
    const source = read('src/renderer/js/detail.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, URL,
        document: { addEventListener() {}, documentElement: { style: { setProperty() {} } }, body: { classList: { contains() { return false; } } }, getElementById: () => null, createElement: () => ({}) },
        $: (sel) => makeNode(sel),
        registerEsc: () => {}, escHtml: (s) => String(s), warnToast: () => {},
        showLoading: () => {}, hideLoading: () => {},
        Records: {
            isFavorite: async () => true,
            getFavTag: async () => 'watching',
        },
        window: { yuki: { settingsGet: async () => ({}) } },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    Detail.site = 'a'; Detail.vodId = '1';
    await Detail._refreshLocalCol();
    const label = calls.text.find(([, txt]) => txt === '在看');
    assert.ok(label, `收藏状态「watching」应回填文案「在看」（实际 ${JSON.stringify(calls.text)}）`);
    assert.ok(calls.active.length && calls.active[calls.active.length - 1] === true, '已收藏时单按钮应高亮');
    // 未收藏：文案回「未收藏」且不高亮
    context.Records.isFavorite = async () => false;
    calls.text.length = 0; calls.active.length = 0;
    await Detail._refreshLocalCol();
    const label2 = calls.text.find(([, txt]) => txt === '未收藏');
    assert.ok(label2, '未收藏时文案回「未收藏」');
    assert.ok(calls.active.length && calls.active[calls.active.length - 1] === false, '未收藏时单按钮不高亮');
});
