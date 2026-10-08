'use strict';
// A-30 Bangumi 匹配改「先渲染后补」回归测试（detail.js load() 内原 render 前的
// 「匹配 getBangumiMatch + 详情 bangumiInfo」两段串行）：
// 1) 开关关闭：load 不触发匹配（零变化——不发起 getBangumiMatch/bangumiInfo）
// 2) 开关开启：CatVod 数据先 render（断言 render 先于匹配完成，首屏不等 Bangumi）
// 3) bgm 到达后 hero 区被局部更新（_applyDeferredBgm 定点替换，整页 render 未重调）
// 4) 世代竞态：后补匹配期间切源/切详情，旧 bgm 不应用到新页面
// 5) 匹配成功但 bangumiInfo 失败（null）→ 不进局部替换（无混合态）
// 6) _restore（嵌套返回）恢复 CatVod 版面快照时按开关重新后补
// 7) hasBgm 到达后的回填动作与 render() hasBgm 分支逐项等价：
//    本地收藏回填 / _applyBangumiColState 缓存回填+按需 force / _loadBgmExtra / 概览重绘
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 最小 jQuery 桩：html() 按选择器捕获写入；$hero.find() 返回带子选择器上下文的节点，
 *  支撑 _applyDeferredBgm 的 $info.find('.detail-kicker') 等链式定点写。
 *  L47：opts.selLength 支持按选择器指定 length（如令 '#detail-body .detail-hero'
 *  返回 0 以覆盖 hero 缺失守卫分支），默认恒 1 维持既有行为。 */
function makeJqStub(captor, opts = {}) {
    const selLength = opts.selLength || {};
    const makeNode = (sel) => ({
        sel: String(sel),
        length: (String(sel) in selLength) ? selLength[String(sel)] : 1,
        _data: {},
        on(ev, a, b) {
            const fn = typeof b === 'function' ? b : a;
            if (captor && typeof fn === 'function') captor.bound.push({ sel: String(sel), ev, fn });
            return this;
        },
        off() { return this; },
        html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), String(s)); return this; },
        text(s) { if (captor && s !== undefined) captor.textBySel.set(String(sel), String(s)); return this; },
        addClass(c) { if (captor && c) captor.classes.push({ sel: String(sel), op: 'add', cls: c }); return this; },
        removeClass(c) { if (captor && c) captor.classes.push({ sel: String(sel), op: 'remove', cls: c }); return this; },
        attr() { return this; },
        prop() { return this; },
        replaceWith(html) { if (captor && html !== undefined) captor.replaced.push({ sel: String(sel), html: String(html) }); return this; },
        remove() { if (captor) captor.removed.push(String(sel)); return this; },
        find(child) { return makeNode(String(sel) + ' >> ' + String(child)); },
        children() { return Object.assign(makeNode(String(sel) + ' > *'), { length: 0 }); },
        each() { return this; },
        not() { return this; },
        is() { return false; },
        toggle() { return this; },
        hide() { if (captor) captor.hidden.add(String(sel)); return this; },
        show() { if (captor) captor.shown.add(String(sel)); return this; },
        closest() { return makeNode(String(sel) + ' ^'); },
        data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
        css() { return this; },
        toggleClass(c, on) { if (captor && c) captor.classes.push({ sel: String(sel), op: (on === false) ? 'remove' : 'add', cls: c }); return this; },
    });
    return (sel) => {
        if (sel && typeof sel === 'object') return makeNode('obj');
        return makeNode(sel);
    };
}

/** 在 VM 中加载 detail.js（最小桩）。opts.settings 控制开关（catvodBgmMatch）；
 *  opts.matchResult / opts.bgmInfo 控制 Kazumi 匹配与详情返回。 */
function loadDetail(opts = {}) {
    const source = read('src/renderer/js/detail.js');
    const captor = {
        bound: [], htmlBySel: new Map(), textBySel: new Map(),
        classes: [], replaced: [], removed: [], hidden: new Set(), shown: new Set(),
    };
    const toasts = [];
    const Kazumi = {
        matchCalls: [], infoCalls: [], colCalls: [], extraCalls: [],
        getBangumiMatch: async (name) => { Kazumi.matchCalls.push(name); return opts.matchResult === undefined ? { id: 777 } : opts.matchResult; },
        bangumiInfo: async (id) => { Kazumi.infoCalls.push(id); return (opts.bgmInfo === undefined) ? { id: 777, name: 'Bangumi 名', name_cn: '中文名' } : opts.bgmInfo; },
        bangumiSearch: async () => { Kazumi.matchCalls.push('search'); return [{ id: 777 }]; },
    };
    Kazumi._applyBangumiColState = async (id, o) => { Kazumi.colCalls.push({ id: String(id), force: !!(o && o.force) }); };
    const context = {
        console: { warn: () => {}, log: () => {}, error: () => {}, info: () => {} },
        Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, URL,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: () => null,
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: makeJqStub(captor, { selLength: opts.selLength }),
        registerEsc: () => {},
        // L49：与 common.js escHtml 同实现的真实转义桩（含单引号），转义层回归
        // （双重转义/漏转义）在本文件内容断言中可见；口径与 detail-skeleton-wiring 对齐。
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        stripHtml: (s) => String(s || ''),
        warnToast: (m) => toasts.push(String(m)),
        showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: () => '<img src="cover.jpg">',
        normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        localCacheGet: () => null,
        localCacheSet: () => {},
        localCacheDel: () => {},
        openDialog: () => {}, closeDialog: () => {},
        doAction: async () => ({ list: [JSON.parse(JSON.stringify(opts.vod || SAMPLE_VOD))] }),
        App: { currentView: 'detail', showView() {} },
        Records: { isFavorite: async () => false, getFavTag: async () => '', getWatchProgress: async () => null },
        window: { yuki: { settingsGet: async () => ({ catvodBgmMatch: opts.catvodBgmMatch === true }), settingsSet: async () => ({}) } },
        Kazumi,
    };
    Object.assign(context, opts.extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, Kazumi, captor, toasts, context };
}

const SAMPLE_VOD = {
    vod_id: 'v1', vod_name: '测试影片', vod_pic: '', vod_content: 'CatVod 简介',
    vod_play_from: '线路A',
    vod_play_url: '第1集$u1#第2集$u2',
};

/** 标准夹具：site/vodId 就绪，load() 从 doAction 拉 SAMPLE_VOD。 */
function fixture(opts) {
    const loaded = loadDetail(opts);
    loaded.Detail.site = 'site-a';
    loaded.Detail.vodId = 'v1';
    return loaded;
}

const flush = () => new Promise((r) => setImmediate(r));

test('A-30①：开关关闭 → load 渲染 CatVod 版面且不发起匹配（零变化）', async () => {
    const { Detail, Kazumi, captor } = fixture({ catvodBgmMatch: false });
    await Detail.load();
    await flush(); await flush(); // 若误发起匹配，给其完成机会再核对
    assert.equal(Kazumi.matchCalls.length, 0, '开关关闭不应发起任何匹配请求');
    assert.equal(Kazumi.infoCalls.length, 0, '开关关闭不应拉取 Bangumi 详情');
    assert.equal(Kazumi.colCalls.length, 0, '开关关闭不应触发收藏态回填');
    assert.equal(Detail._bgmDefer, undefined, '后补状态机不应进入「匹配中」');
    assert.equal(Detail._bgmId, null, '不应写入 _bgmId');
    const html = String(captor.htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('detail-hero-catvod'), '首屏应为 CatVod 版面 hero');
    assert.ok(html.includes('影片详情'), 'kicker 应为影片详情');
});

test('A-30②：开关开启 → CatVod 数据先 render（render 先于匹配完成）', async () => {
    const { Detail, Kazumi, captor } = fixture({ catvodBgmMatch: true });
    // 记录匹配与渲染的先后顺序
    const order = [];
    Kazumi.getBangumiMatch = async (name) => { order.push('match-start'); await flush(); order.push('match-end'); return { id: 777 }; };
    Kazumi.bangumiInfo = async () => { order.push('info'); return { id: 777, name: 'b', name_cn: 'c' }; };
    const origRender = Detail.render;
    Detail.render = function () { order.push('render'); return origRender.apply(this, arguments); };
    await Detail.load();
    // 此时 load 已返回（首屏完成），后补匹配可能仍在途——render 必须已发生，
    // 且匹配的「结束」要么尚未发生（仍在途，天然晚于 render），要么已记录但排在
    // render 之后（order 里不可能出现 render 晚于 match-end 的排列）
    assert.ok(order.indexOf('render') >= 0, '首屏 render 已执行');
    const matchEnd = order.indexOf('match-end');
    assert.ok(matchEnd === -1 || order.indexOf('render') < matchEnd,
        `render 先于匹配完成（首屏不等 Bangumi），order=${JSON.stringify(order)}`);
    const html = String(captor.htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('detail-hero-catvod'), '首屏为 CatVod 版面');
    assert.ok(html.includes('id="detail-catvod-start"'), 'CatVod 开始播放按钮先上屏');
    // 等后补完成
    await flush(); await flush(); await flush();
    assert.equal(Detail._bgmId, 777, '匹配到达后 _bgmId 写入');
    assert.ok(Detail._bgmInfo && Detail._bgmInfo.id === 777, '详情到达后 _bgmInfo 写入');
});

test('A-30③：bgm 到达后 hero 区局部替换（整页 render 未重调）', async () => {
    const { Detail, captor } = fixture({ catvodBgmMatch: true });
    let renderCalls = 0;
    const origRender = Detail.render;
    Detail.render = function (...a) { renderCalls++; return origRender.apply(this, a); };
    await Detail.load();
    assert.equal(renderCalls, 1, '首屏 render 一次');
    const firstHtml = String(captor.htmlBySel.get('#detail-body') || '');
    assert.ok(firstHtml.includes('detail-hero-catvod'), '首屏 CatVod 版面');
    await flush(); await flush(); await flush();
    assert.equal(renderCalls, 1, 'bgm 到达后不得整页重调 render（局部替换路径）');
    assert.equal(Detail._bgmId, 777);
    // hero 根容器 class 切换为 Bangumi 口径
    const classOps = captor.classes.filter((c) => c.sel === '#detail-body .detail-hero');
    assert.ok(classOps.some((c) => c.op === 'remove' && /detail-hero-catvod/.test(c.cls)), 'hero 应摘 CatVod class');
    assert.ok(classOps.some((c) => c.op === 'add' && /detail-hero-bangumi/.test(c.cls)), 'hero 应挂 Bangumi class');
    // kicker / meta / 统计区 / 操作行被定点更新（均为 find 子选择器路径，非 #detail-body 整页）
    const kicker = captor.htmlBySel.get('#detail-body .detail-hero >> .detail-hero-info >> .detail-kicker');
    assert.ok(kicker === 'BANGUMI 详情', 'kicker 应替换为 BANGUMI 详情');
    const meta = captor.htmlBySel.get('#detail-body .detail-hero >> .detail-hero-info >> .detail-meta');
    assert.ok(typeof meta === 'string', 'meta 行应被定点更新');
    const stats = captor.replaced.find((r) => r.sel.includes('.detail-catvod-facts'));
    assert.ok(stats && stats.html.includes('detail-bgm-stats'), '播放信息卡应替换为 Bangumi 统计区');
    const actions = captor.htmlBySel.get('#detail-body .detail-hero >> .detail-hero-info >> .detail-hero-actions');
    assert.ok(actions.includes('detail-col-current'), '操作行应替换为 Bangumi 收藏行');
    assert.ok(!actions.includes('id="detail-catvod-start"'), '匹配后操作行不应残留开始播放按钮');
    assert.ok(captor.removed.some((s) => s.includes('detail-local-progress')), '本地进度行应随统计区迁移移除');
    const title = captor.htmlBySel.get('#detail-body .detail-hero >> .detail-hero-info >> .detail-title');
    assert.ok(title.includes('中文名'), '标题应换为 Bangumi 中文名');
});

test('A-30④：世代竞态——后补期间切详情，旧 bgm 不应用到新页面', async () => {
    const { Detail, Kazumi, captor } = fixture({ catvodBgmMatch: true });
    // 让第一片的匹配挂起，等待期间切到第二片（后补此时已进入「匹配中」）。
    // 用调用序（而非 Detail._loadGen 运行时读）区分两次匹配调用：load#2 发起的
    // 匹配会立即返回 888（第二片自身的后补正常走完），只有第一片（gen=1 闭包）
    // 的调用挂起待释放。
    let resolveMatch;
    let matchCallSeq = 0;
    Kazumi.getBangumiMatch = async (name) => {
        matchCallSeq++;
        if (matchCallSeq === 1) {
            await new Promise((r) => { resolveMatch = r; });
            return { id: 777 };
        }
        return { id: 888 };
    };
    Kazumi.bangumiInfo = async (id) => ({ id, name: '旧片bgm', name_cn: id === 777 ? '旧片中文名' : '新片中文名' });
    await Detail.load(); // 第一片 load 完成（gen=1），后补#1 挂在匹配上
    // 切到第二片：load()（gen 自增为 2），后补#2 立即拿到 888 并应用
    Detail.vodId = 'v2';
    await Detail.load();
    await flush();
    assert.equal(Detail._bgmId, 888, '第二片自身后补正常应用（对照组）');
    const htmlAfterB = String(captor.htmlBySel.get('#detail-body') || '');
    assert.ok(htmlAfterB.includes('detail-hero-catvod') || htmlAfterB.includes('detail-hero-bangumi'), '第二片页面已由自身后补接管');
    // 释放第一片的挂起匹配：它恢复时 gen=1 已失配（当前 _loadGen=2）——必须被丢弃
    resolveMatch();
    await flush(); await flush(); await flush();
    assert.equal(Detail._bgmId, 888, '旧片（777）结果因世代失配被丢弃，_bgmId 保持第二片的 888');
    assert.ok(Detail._bgmInfo && Detail._bgmInfo.id === 888, '_bgmInfo 不得被旧片数据污染');
    // 页面标题应在第二片后补应用时被局部替换为「新片中文名」（777 的旧片名不得出现）
    const titleSel = '#detail-body .detail-hero >> .detail-hero-info >> .detail-title';
    const titleHtml = String(captor.htmlBySel.get(titleSel) || '');
    assert.ok(titleHtml.includes('新片中文名'), '第二片 bgm 正常在屏（标题局部替换）');
    assert.ok(!titleHtml.includes('旧片中文名'), '旧片 bgm 不出现在新页面');
});

test('A-30④b：后补收口不覆盖新详情的在途状态（_bgmDefer 归属正确）', async () => {
    const { Detail } = fixture({ catvodBgmMatch: true });
    await Detail.load(); // gen=1，后补在途
    const gen1 = Detail._loadGen;
    Detail.vodId = 'v2';
    await Detail.load(); // gen=2，新后补在途
    const gen2 = Detail._loadGen;
    assert.ok(Detail._bgmDefer && Detail._bgmDefer.gen === gen2, '在途状态归属最新世代');
    await flush(); await flush(); await flush();
    // 两个后补都结束后，收口只由各自世代执行，最终为 null（已结束）
    assert.equal(Detail._bgmDefer, null, '全部结束后状态机收口为「已结束」');
    assert.ok(gen1 < gen2, '世代自增守卫就绪');
});

test('A-30⑤：匹配成功但 bangumiInfo 失败（null）→ 不进局部替换，无混合态', async () => {
    const { Detail, Kazumi, captor } = fixture({ catvodBgmMatch: true, bgmInfo: null });
    await Detail.load();
    await flush(); await flush(); await flush();
    assert.equal(Kazumi.matchCalls.length, 1, '匹配已发起');
    assert.equal(Detail._bgmId, null, '详情失败不写 _bgmId（避免「有 ID 无数据」混合态）');
    const html = String(captor.htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('detail-hero-catvod'), '保持 CatVod 版面（可用形态）');
    assert.ok(html.includes('id="detail-catvod-start"'), '开始播放按钮保持可用');
});

test('A-30⑥：_restore 恢复 CatVod 版面快照 → 开关开启时重新后补', async () => {
    const { Detail, Kazumi } = fixture({ catvodBgmMatch: true });
    await Detail.load();
    await flush(); await flush(); await flush(); // 首屏后补完成
    assert.equal(Detail._bgmId, 777);
    // 从完成态压栈快照并恢复：_restore 应恢复 Bangumi 版面快照（已有 _bgmId 走原路径）
    const snap = Detail._snapshot();
    assert.equal(snap._bgmId, 777, '快照应携带已匹配的 _bgmId');
    // 构造一个「CatVod 版面」快照（模拟匹配完成前压栈的恢复场景）
    const catSnap = Object.assign({}, snap, { _bgmId: null, _bgmInfo: null });
    Kazumi.matchCalls.length = 0;
    Detail._bgmId = null; Detail._bgmInfo = null;
    Detail.render = () => {}; // 恢复路径的 render 在本桩环境弱化（局部替换断言已由③覆盖）
    await Detail._restore(catSnap);
    await flush(); await flush(); await flush();
    assert.equal(Kazumi.matchCalls.length, 1, 'CatVod 快照恢复应重新发起后补匹配');
    assert.equal(Detail._bgmId, 777, '后补到达后写回 _bgmId');
    // 开关关闭时恢复不发起匹配（对照）
    const { Detail: D2, Kazumi: K2 } = loadDetail({ catvodBgmMatch: false });
    D2.site = 'site-a'; D2.vodId = 'v1';
    await D2.load();
    K2.matchCalls.length = 0;
    D2.render = () => {};
    await D2._restore(Object.assign({}, D2._snapshot(), { _bgmId: null, _bgmInfo: null }));
    assert.equal(K2.matchCalls.length, 0, '开关关闭时 _restore 不发起匹配');
});

test('A-30⑦：bgm 到达后的回填动作与 render() hasBgm 分支逐项等价', async () => {
    const { Detail, Kazumi } = fixture({ catvodBgmMatch: true });
    const calls = { localCol: 0, bgmExtra: 0, overview: 0 };
    Detail._refreshLocalCol = async () => { calls.localCol++; };
    Detail._loadBgmExtra = async () => { calls.bgmExtra++; Kazumi.extraCalls.push(1); };
    const origOverview = Detail._renderOverview;
    Detail._renderOverview = function () { calls.overview++; return origOverview.call(this); };
    await Detail.load();
    await flush(); await flush(); await flush();
    assert.equal(calls.localCol >= 1, true, '本地收藏态回填（等价 render hasBgm 分支 1）');
    assert.ok(Kazumi.colCalls.some((c) => c.id === '777' && !c.force), '_applyBangumiColState 缓存回填（等价分支 2）');
    assert.equal(Kazumi.extraCalls.length, 1, '_loadBgmExtra 补充数据加载（等价分支 3）');
    assert.ok(calls.overview >= 2, '概览页签重绘（CatVod 简介换 Bangumi 简介/标签；首屏 1 次 + 后补 1 次）');
    // A-28 对账共享入口：无时间戳首次打开应 force 一次
    assert.equal(Kazumi.colCalls.filter((c) => c.force).length, 1, '按需 force 对账走 A-28 共享入口（等价分支 2b）');
});

test('A-30⑧：_applyDeferredBgm 守卫——无 hero DOM / 无有效数据时零写入', async () => {
    const { Detail, captor } = fixture({});
    // 无 _vod / 无 _bgmInfo：直接调用不抛错、不写 DOM
    Detail._vod = null;
    Detail._bgmInfo = null;
    Detail._applyDeferredBgm();
    assert.equal(captor.classes.length, 0, '无数据零写入');
    // L47 重构说明：原第二段注释声称覆盖「hero 不在 DOM」，但桩恒 length:1，两次
    // 调用实际都走 detail.js _vod 主守卫；现按建议给桩加可配置 length（参照
    // detail-source-switch.test.js makeCheckedJq 的做法）真实覆盖 DOM 守卫分支。
    // 段一：_vod 有效但 hero 不在 DOM（length:0）→ $hero.length 守卫返回，零写入
    const { Detail: D2, captor: cap2 } = loadDetail({
        selLength: { '#detail-body .detail-hero': 0 },
    });
    D2.site = 'site-a'; D2.vodId = 'v1';
    D2._vod = { vod_id: 'v1', vod_name: 'x' };
    D2._bgmInfo = { id: 1, name: 'x' };
    D2._applyDeferredBgm();
    assert.equal(cap2.classes.length, 0, 'hero 不在 DOM：$hero.length 守卫零写入');
    // 段二：主守卫组合（_vod=null）维持覆盖：不抛错、零写入
    Detail._bgmInfo = { id: 1, name: 'x' };
    Detail._applyDeferredBgm();
    assert.equal(captor.classes.length, 0, '守卫路径零写入');
});
