'use strict';
// A-12 简介折叠改 class toggle 回归测试：
// 1) 初次渲染仍走 _renderOverview：超三行简介折叠态 + 「展开全部」按钮；短简介不出按钮
// 2) 点击 #detail-desc-toggle 只 toggle .collapsed class + 按钮文案局部更新，
//    不再调 _renderOverview() 全量重建——重建整个概览是闪屏 + 滚动位置跳变的根因，
//    DOM 不重建则浏览器滚动锚定保留，展开/收起视口不漂移
// 3) 展开/收起往返：线夹 class 与按钮文案语义正确（收起后 collapsed 恢复 + 文案回「展开全部」）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 最小 jQuery 桩（手法照抄 detail-start-button.test.js）：链式 on 记录委托监听器，
 *  html 按选择器捕获。对象分支（$(e.currentTarget)）额外记录 text 调用与
 *  closest→find→toggleClass 链路，供 A-12 class toggle 行为断言。 */
function makeJqStub(captor) {
    const makeNode = (sel) => ({
        sel: String(sel),
        length: 1,
        _data: {},
        on(ev, a, b) {
            const fn = typeof b === 'function' ? b : a;
            const delegated = typeof b === 'function' ? String(a) : '';
            if (typeof fn === 'function') captor.bound.push({ sel: String(sel), ev, delegated, fn });
            return this;
        },
        off() { return this; },
        html(s) { if (s !== undefined) captor.htmlBySel.set(String(sel), s); return this; },
        text() { return this; },
        addClass() { return this; },
        removeClass() { return this; },
        attr() { return this; },
        prop() { return this; },
        // find(s) 对齐真实 querySelector：后代组合器拼接（全批桩统一口径）
        find(s) { return makeNode(String(sel) + ' ' + String(s)); },
        each() { return this; },
        not() { return this; },
        is() { return false; },
        toggle() { return this; },
        hide() { return this; },
        show() { return this; },
        closest() { return makeNode(String(sel) + ' ^'); },
        data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
        toggleClass(cls, force) {
            captor.toggles.push({ sel: String(sel), cls: String(cls), force });
            return this;
        },
    });
    // $(domObj)：包装事件目标——closest 沿桩节点链继续（记录链路选择器），
    // text(arg) 捕获按钮文案局部更新，其余链式方法空实现。
    return (sel) => {
        if (sel && typeof sel === 'object') {
            return {
                length: 1,
                closest(s) { return makeNode('closest(' + String(s) + ')'); },
                text(s) { if (s !== undefined) captor.texts.push(String(s)); return this; },
                // find 统一后代组合器口径（与节点分支一致）
                on() { return this; }, off() { return this; },
                html() { return this; }, addClass() { return this; }, removeClass() { return this; },
                attr() { return this; }, prop() { return this; }, find(s) { return makeNode('obj ' + String(s)); },
                each() { return this; }, not() { return this; }, is() { return false; },
                toggle() { return this; }, toggleClass() { return this; }, data() { return undefined; },
            };
        }
        return makeNode(sel);
    };
}

/** 在 VM 中加载 detail.js（最小桩），返回 Detail、监听器记录与行为捕获。 */
function loadDetail() {
    const source = read('src/renderer/js/detail.js');
    const captor = { bound: [], htmlBySel: new Map(), texts: [], toggles: [] };
    const toasts = [];
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
        openDialog: () => {},
        closeDialog: () => {},
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, captor, htmlBySel: captor.htmlBySel, toasts };
}

const LONG_SUMMARY = '长'.repeat(91); // >90 字触发三行线夹与切换按钮

test('A-12 初次渲染仍走 _renderOverview：超三行简介折叠态 + 展开全部按钮；短简介不出按钮', () => {
    const { Detail, htmlBySel } = loadDetail();
    Detail._bgmInfo = { summary: LONG_SUMMARY };
    Detail._descCollapsed = true; // 默认折叠口径不变
    Detail._renderOverview();
    const html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.match(html, /class="detail-desc collapsed"/, '折叠态带 collapsed 线夹 class（三行）');
    assert.match(html, /id="detail-desc-toggle"/, '超三行才出切换按钮');
    assert.match(html, />展开全部<\/button>/);

    // 展开口径重渲染（tags/tabs 等路径重建时维持既有行为）：无 collapsed、文案「收起」
    Detail._descCollapsed = false;
    Detail._renderOverview();
    const html2 = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(!html2.includes('detail-desc collapsed'), '展开态不挂线夹 class');
    assert.match(html2, />收起<\/button>/);

    // 短简介（≤三行）：不出按钮，永不折叠
    const { Detail: D2, htmlBySel: cap2 } = loadDetail();
    D2._bgmInfo = { summary: '短简介' };
    D2._renderOverview();
    const html3 = String(cap2.get('#detail-tab-content') || '');
    assert.ok(!html3.includes('detail-desc-toggle'), '短简介不出切换按钮');
    assert.ok(!html3.includes('collapsed'), '短简介永不折叠');
});

test('A-12 展开点击：只 toggle class + 按钮文案局部更新，不重建概览 DOM', () => {
    const { Detail, captor, htmlBySel } = loadDetail();
    Detail.init();
    const hit = captor.bound.find((b) => b.sel === '#detail-body' && b.ev === 'click'
        && b.delegated === '#detail-desc-toggle');
    assert.ok(hit, '应在 #detail-body 委托区找到 #detail-desc-toggle 点击监听');
    // 幂等：重复 init 不重复绑定（_escBound 守卫）
    Detail.init();
    const hits = captor.bound.filter((b) => b.sel === '#detail-body' && b.ev === 'click'
        && b.delegated === '#detail-desc-toggle');
    assert.equal(hits.length, 1);

    // 折叠态起步（_renderOverview 初次渲染后的状态）
    Detail._descCollapsed = true;
    let renderCalls = 0;
    const origRender = Detail._renderOverview;
    Detail._renderOverview = function () { renderCalls += 1; return origRender.call(this); };

    const stopProp = [];
    const syntheticEvent = {
        type: 'click',
        stopPropagation() { stopProp.push(1); },
        currentTarget: { id: 'detail-desc-toggle' },
    };
    hit.fn(syntheticEvent);

    assert.deepEqual(stopProp, [1], '阻止冒泡（不触发外层点外收起逻辑）');
    assert.equal(renderCalls, 0, '展开不得调 _renderOverview 全量重建（闪屏 + 滚动跳变根因）');
    assert.equal(htmlBySel.get('#detail-tab-content'), undefined,
        '展开不得重写 #detail-tab-content（innerHTML 未变 → 节点引用与滚动锚定保留）');
    assert.equal(Detail._descCollapsed, false, 'state 翻转为展开');
    assert.deepEqual(captor.toggles,
        [{ sel: 'closest(.detail-desc-wrap) .detail-desc', cls: 'collapsed', force: false }],
        '只对 .detail-desc toggle .collapsed（force=false 解除三行线夹）');
    assert.deepEqual(captor.texts, ['收起'], '按钮文案局部更新为「收起」');
});

test('A-12 展开/收起往返：收起后线夹 class 恢复、文案回「展开全部」', () => {
    const { Detail, captor } = loadDetail();
    Detail.init();
    const hit = captor.bound.find((b) => b.sel === '#detail-body' && b.ev === 'click'
        && b.delegated === '#detail-desc-toggle');
    assert.ok(hit);
    const ev = { stopPropagation() {}, currentTarget: { id: 'detail-desc-toggle' } };

    hit.fn(ev); // 第一次点击：折叠 → 展开
    hit.fn(ev); // 第二次点击：展开 → 收起
    assert.equal(Detail._descCollapsed, true, '往返后回到折叠态');
    assert.deepEqual(captor.toggles, [
        { sel: 'closest(.detail-desc-wrap) .detail-desc', cls: 'collapsed', force: false },
        { sel: 'closest(.detail-desc-wrap) .detail-desc', cls: 'collapsed', force: true },
    ], '收起时 collapsed class 恢复挂载（force=true 恢复三行线夹）');
    assert.deepEqual(captor.texts, ['收起', '展开全部'], '文案随状态往返切换');
});
