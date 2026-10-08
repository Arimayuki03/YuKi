'use strict';
// A-22 详情页键盘可达性回归测试：
// 1) 源码锚点：init() 在 #detail-body 委托链上为 7 类选中元素挂 keydown
//    （.detail-tab / .kazumi-tag / [data-char-filter] / [data-staff-filter] /
//    .bgm-ep-item / .detail-char-card / .detail-relation[data-rel-id]），
//    经共用判定 _kbdActivate 只放行 Enter/Space 且 e.preventDefault()（Space 防滚动）；
// 2) 源码锚点：span 类元素（页签/标签/筛选条）模板补 tabindex="0"（非 button 需可聚焦）；
//    .bgm-ep-item / .detail-char-card / .detail-relation 的既有 tabindex 不回退；
// 3) VM 行为（代表点）：页签 keydown(Enter/Space) 与 click 走同一 _switchTab，
//    观测结果一致；非激活键（'a'/Escape）不触发且不 preventDefault；
// 4) VM 行为：kazumi-tag / 角色与制作筛选条 / bgm-ep-item / 角色卡 / 关联卡
//    keydown 与对应 click 同逻辑（断言同一下游调用被触发）；
// 5) Esc 非回归锚点：新增 keydown 块不引用 'Escape'，.ep-check 本期不接 keydown
//    （有 #ep-check-all 兜底），Esc 仍由 common.js dispatchEsc 全局派发。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('src/renderer/js/detail.js');

/** 提取 .on('keydown', '<sel>', ...) 的完整处理体（配对花括号）。 */
function extractOnBlock(selector) {
    const marker = `.on('keydown', '${selector}'`;
    const start = SRC.indexOf(marker);
    assert.ok(start >= 0, `应存在 keydown 委托：${selector}`);
    const bodyStart = SRC.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
    }
    assert.fail(`keydown 块未闭合：${selector}`);
}

// ---------- 1) 源码锚点：keydown 委托 + _kbdActivate 共用判定 ----------

test('A-22 源码锚点：7 类选中元素在 #detail-body 上有 keydown 委托且经 _kbdActivate 放行', () => {
    const selectors = ['.detail-tab', '.kazumi-tag', '[data-char-filter]', '[data-staff-filter]',
        '.bgm-ep-item', '.detail-char-card', '.detail-relation[data-rel-id]'];
    for (const sel of selectors) {
        const block = extractOnBlock(sel);
        assert.ok(block.includes('this._kbdActivate(e)'), `${sel} 的 keydown 应经 _kbdActivate 放行`);
    }
    // 共用判定：仅 Enter/Space 放行，Space 的 preventDefault 必须存在（防滚动页面）
    const kbd = SRC.match(/_kbdActivate\(e\) \{[\s\S]*?\n    \},/);
    assert.ok(kbd, '应存在 _kbdActivate 共用判定');
    assert.ok(kbd[0].includes("e.key !== 'Enter' && e.key !== ' '"), '只放行 Enter/Space');
    assert.ok(kbd[0].includes('e.preventDefault()'), '放行时必须 preventDefault');
});

test('A-22 源码锚点：span 类元素模板补 tabindex="0"，既有 tabindex 不回退', () => {
    // 页签：span 非原生可聚焦，data-tab 后补 tabindex="0"
    assert.ok(/class="detail-tab \$\{t === this\._activeTab \? 'active' : ''\}" data-tab="\$\{t\}" tabindex="0" role="tab"/.test(SRC),
        '页签 span 模板应含 tabindex="0"');
    // Bangumi 标签 chip（两个变体：带计数 / 不带计数）
    assert.ok(SRC.includes('data-tag="${escHtml(tn)}" tabindex="0" title="共 ${cnt} 人标记"'),
        '带计数标签 chip 应含 tabindex="0"');
    assert.ok(SRC.includes('data-tag="${escHtml(tn)}" tabindex="0">${escHtml(tn)}</span>'),
        '无计数标签 chip 应含 tabindex="0"');
    // 角色/制作筛选条（span role=tab）
    assert.ok(SRC.includes('data-char-filter="${f.key}" tabindex="0" role="tab"'), '角色筛选条应含 tabindex="0"');
    assert.ok(SRC.includes('data-staff-filter="${c.key}" tabindex="0" role="tab"'), '制作筛选条应含 tabindex="0"');
    // 已有 tabindex 的三类（防回退）：bgm-ep-item / detail-char-card / detail-relation
    assert.ok(SRC.includes('class="kazumi-detail-ep bgm-ep-item" data-idx="${i}" tabindex="0"'), 'bgm-ep-item 既有 tabindex 不回退');
    assert.ok(/class="detail-char-card" data-char-id="\$\{escHtml\(c\.id \|\| ''\)\}" tabindex="0"/.test(SRC), 'detail-char-card 既有 tabindex 不回退');
    assert.ok(SRC.includes('data-rel-id="${escHtml(r.id)}" tabindex="0"'), 'detail-relation 既有 tabindex 不回退');
});

test('A-22 Esc 非回归锚点：新增 keydown 不触碰 Escape；.ep-check 本期不接 keydown', () => {
    // 新增 keydown 委托区（首块 .detail-tab 起至 .detail-relation 收尾）不引用 Escape
    const first = SRC.indexOf(".on('keydown', '.detail-tab'");
    const last = SRC.indexOf(".on('keydown', '.detail-relation[data-rel-id]'");
    assert.ok(first >= 0 && last > first, 'keydown 委托区应存在');
    const zone = SRC.slice(first, extractOnBlock('.detail-relation[data-rel-id]').length + last);
    assert.ok(!zone.includes('Escape'), '新增 keydown 块不得引用 Escape（Esc 由 dispatchEsc 派发）');
    // .ep-check 本期不动（优化.md：有 #ep-check-all 兜底）
    assert.ok(!SRC.includes(".on('keydown', '.ep-check'"), '.ep-check 不应接 keydown');
});

// ---------- VM 行为断言 ----------

/** 最小 jQuery 桩（同 detail-start-button.test.js 口径）：记录委托绑定供事件测试触发。 */
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
        // find(s) 对齐真实 querySelector：后代组合器拼接（全批桩统一口径）；
        // 无参调用无子选择器可用，视为后代通配
        find(s) { return makeNode(s === undefined ? String(sel) + ' *' : String(sel) + ' ' + String(s)); },
        each() { return this; },
        not() { return this; },
        is() { return false; },
        toggle() { return this; },
        hide() { return this; },
        show() { return this; },
        closest() { return makeNode(String(sel) + ' ^'); },
        data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
    });
    return (sel) => {
        if (sel && typeof sel === 'object') {
            // $(e.currentTarget) 包装：data() 读走目标节点自带 data 或 _data 缓存
            // （写仍落到 _data），与节点分支的 data(k, v) 口径一致
            return {
                length: 1,
                data(k, v) { if (v !== undefined) { sel._data = sel._data || {}; sel._data[k] = v; } return (typeof sel.data === 'function') ? sel.data(k) : (sel._data && sel._data[k]); },
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

function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const captor = { bound: [], htmlBySel: new Map() };
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
        replayClass: () => {},
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, bound: captor.bound, toasts };
}

/** 取某容器上某事件的委托监听器。 */
function findBound(bound, ev, delegated, sel) {
    const hit = bound.find((b) => b.ev === ev && b.delegated === delegated && b.sel === sel);
    assert.ok(hit, `应找到绑定：${sel} on(${ev}, ${delegated})`);
    return hit.fn;
}

/** 伪造键盘事件：currentTarget.data(k) 按 kv 表返回。 */
function keyEvent(key, kv) {
    let prevented = 0;
    return {
        ev: {
            key,
            preventDefault() { prevented++; },
            currentTarget: { data: (k) => (kv && k in kv ? kv[k] : undefined) },
        },
        prevented: () => prevented,
    };
}

test('A-22 VM：页签 keydown(Enter/Space) 与 click 走同一 _switchTab，观测一致；非激活键不触发', () => {
    // keydown 模式：Enter/Space 都真实经 keydown 处理器驱动（不经 click 抢跑）——
    // 初始态「概览」→ Enter 切「关联」→ Space 切「角色」，两次切换都由 _kbdActivate
    // 放行（prevented()===1），若 _kbdActivate 拒绝 Enter 本用例必红
    const triggerKey = () => {
        const { Detail, bound } = loadDetail();
        const rendered = [];
        Detail._renderTabContent = function () { rendered.push(this._activeTab); };
        Detail.init();
        const handler = findBound(bound, 'keydown', '.detail-tab', '#detail-body');
        const enter = keyEvent('Enter', { tab: '关联' });
        handler(enter.ev);
        const space = keyEvent(' ', { tab: '角色' });
        handler(space.ev);
        // enterPrevented 只做行为外断言（click 无 preventDefault 概念），不进 deepEqual
        return { activeTab: Detail._activeTab, rendered, enterPrevented: enter.prevented() };
    };
    // click 模式：同一对页签以 click 触发，作为观测对照
    const triggerClick = () => {
        const { Detail, bound } = loadDetail();
        const rendered = [];
        Detail._renderTabContent = function () { rendered.push(this._activeTab); };
        Detail.init();
        const handler = findBound(bound, 'click', '.detail-tab', '#detail-body');
        handler({ currentTarget: { data: () => '关联' } });
        handler({ currentTarget: { data: () => '角色' } });
        return { activeTab: Detail._activeTab, rendered };
    };
    const viaKey = triggerKey();
    const viaClick = triggerClick();
    // deepEqual 只比观测（页签状态 + 渲染序列），preventDefault 计数单列
    assert.deepEqual({ activeTab: viaKey.activeTab, rendered: viaKey.rendered }, viaClick, 'keydown 与 click 的切换结果应完全一致');
    assert.equal(viaKey.enterPrevented, 1, 'Enter 放行时必须 preventDefault（keydown 真实驱动）');
    assert.deepEqual(viaKey.rendered, ['关联', '角色'], '两次切换都应走 _renderTabContent（Enter 首切 + Space 次切）');
    assert.equal(viaKey.activeTab, '角色');

    // 非激活键：'a' 不触发不 preventDefault；Escape 同样不触发（Esc 由 dispatchEsc 派发）
    const { Detail, bound } = loadDetail();
    const rendered = [];
    Detail._renderTabContent = function () { rendered.push(this._activeTab); };
    Detail.init();
    const handler = findBound(bound, 'keydown', '.detail-tab', '#detail-body');
    const a = keyEvent('a', { tab: '吐槽' });
    handler(a.ev);
    const esc = keyEvent('Escape', { tab: '吐槽' });
    handler(esc.ev);
    assert.equal(Detail._activeTab, '概览', '非激活键不应切页签');
    assert.deepEqual(rendered, [], '非激活键不应触发渲染');
    assert.equal(a.prevented(), 0, "普通字符键不应 preventDefault");
    assert.equal(esc.prevented(), 0, 'Escape 不应被 keydown 处理器吞掉');
});

test('A-22 VM：kazumi-tag Space 激活与 click 同逻辑（openBangumiTagResult）', () => {
    const opened = [];
    const { Detail, bound } = loadDetail({
        Kazumi: { openBangumiTagResult: (t) => opened.push(t) },
    });
    Detail.init();
    const handler = findBound(bound, 'keydown', '.kazumi-tag', '#detail-body');
    const sp = keyEvent(' ', { tag: '科幻' });
    handler(sp.ev);
    assert.deepEqual(opened, ['科幻'], 'Space 应触发与 click 相同的标签筛选');
    assert.equal(sp.prevented(), 1, 'Space 必须 preventDefault 防滚动');
    // 空 data-tag 与 click 同口径：直接忽略
    const empty = keyEvent('Enter', {});
    handler(empty.ev);
    assert.deepEqual(opened, ['科幻']);
});

test('A-22 VM：角色/制作筛选条 keydown 与 click 同逻辑（写 filter 后重渲页签）', () => {
    const { Detail, bound } = loadDetail();
    const charRenders = [];
    const staffRenders = [];
    Detail._renderCharacters = function () { charRenders.push(this._charFilter); };
    Detail._renderStaff = function () { staffRenders.push(this._staffFilter); };
    Detail.init();
    findBound(bound, 'keydown', '[data-char-filter]', '#detail-body')(keyEvent('Enter', { 'char-filter': 'support' }).ev);
    assert.equal(Detail._charFilter, 'support');
    assert.deepEqual(charRenders, ['support'], '筛选后应重渲角色页签');
    findBound(bound, 'keydown', '[data-staff-filter]', '#detail-body')(keyEvent('Enter', { 'staff-filter': 'director' }).ev);
    assert.equal(Detail._staffFilter, 'director');
    assert.deepEqual(staffRenders, ['director'], '筛选后应重渲制作页签');
});

test('A-22 VM：bgm-ep-item / 角色卡 / 关联卡 keydown 与各自 click 同一下游调用', () => {
    const openedDialogs = [];
    const openedChars = [];
    const openedRel = [];
    const { Detail, bound } = loadDetail({
        Kazumi: {
            openSourceDialog: (title, site, src) => openedDialogs.push([title, site, src]),
            openBangumiInfoPage: (id) => openedRel.push(id),
        },
    });
    Detail.vodName = '测试影片';
    Detail._openCharacterDetail = (cid) => openedChars.push(cid);
    Detail.init();
    // bgm-ep-item：键盘激活打开选源弹窗（与 click 同参）
    findBound(bound, 'keydown', '.bgm-ep-item', '#detail-body')(keyEvent('Enter').ev);
    assert.deepEqual(openedDialogs, [['测试影片', 'kazumi', '']]);
    // detail-char-card：打开人物详情浮层
    findBound(bound, 'keydown', '.detail-char-card', '#detail-body')(keyEvent(' ', { 'char-id': 'c9' }).ev);
    assert.deepEqual(openedChars, ['c9']);
    // detail-relation：跳转关联条目页
    findBound(bound, 'keydown', '.detail-relation[data-rel-id]', '#detail-body')(keyEvent('Enter', { 'rel-id': '789' }).ev);
    assert.deepEqual(openedRel, ['789']);
});
