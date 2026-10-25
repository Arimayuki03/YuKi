'use strict';
/**
 * 自绘下拉弹层（js/custom-select.js）单测。
 *
 * 为什么需要它：原生 <select> 的展开列表由系统绘制、CSS 无钩子（圆角/主题/字号都改不了），
 * 用户要求"下拉展开后的列表要圆角并改样式"，唯一做法是自绘。本组测试锁三件事：
 *   ① 命中范围（哪些 select 走自绘、哪些保持原生）；
 *   ② 选项拍平口径（optgroup 标题、disabled 继承、index 与 selectedIndex 对齐）；
 *   ③ 选中回写语义（写 selectedIndex + 派发 input/change，与原生 <select> 一致），
 *      以及"指针按下被 preventDefault"（这是原生弹层不再出现的唯一依据）。
 *
 * 真实浏览器行为另由 build/ui-harness 的 Electron 场景验收（面板尺寸/位置/层级/动画）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CSS = read('src/renderer/css/ui.css');
const HTML = read('src/renderer/index.html');
const SRC = read('src/renderer/js/custom-select.js');

// ---------------------------------------------------------------- 迷你 DOM 桩

function makeClassList(el) {
    const set = new Set();
    return {
        add(c) { set.add(c); el._cls = Array.from(set).join(' '); },
        remove(c) { set.delete(c); el._cls = Array.from(set).join(' '); },
        contains(c) { return set.has(c); },
    };
}

/** 元素桩：只为 custom-select 用到的能力建档（classList/style/innerHTML/事件/事件派发）。 */
function makeEl(tag, attrs) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        children: [],
        style: {},
        attrs: Object.assign({}, attrs || {}),
        listeners: {},
        isConnected: true,
        parentElement: null,
        _cls: '',
        _html: '',
        className: '',
    };
    el.classList = makeClassList(el);
    Object.defineProperty(el, 'innerHTML', {
        get() { return el._html; },
        set(v) {
            el._html = String(v);
            // 迷你解析：把 .yuki-sel-item 抽成子节点（含 data-idx / class 标记）
            el.children = [];
            const re = /<div class="([^"]*)"[^>]*data-idx="(\d+)"[^>]*>/g;
            let m;
            while ((m = re.exec(el._html)) !== null) {
                const child = makeEl('div');
                child.className = m[1];
                child.attrs['data-idx'] = m[2];
                m[1].split(/\s+/).forEach((c) => { if (c) child.classList.add(c); });
                child.parentElement = el;
                el.children.push(child);
            }
        },
    });
    el.appendChild = (c) => { c.parentElement = el; el.children.push(c); return c; };
    el.contains = (node) => node === el || el.children.indexOf(node) >= 0;
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
    el.hasAttribute = (k) => Object.prototype.hasOwnProperty.call(el.attrs, k);
    el.addEventListener = (t, fn) => { (el.listeners[t] = el.listeners[t] || []).push(fn); };
    el.removeEventListener = () => { };
    el.querySelectorAll = (sel) => (sel === '.yuki-sel-item' ? el.children.filter((c) => c.className.indexOf('yuki-sel-item') >= 0) : []);
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
    el.closest = (sel) => {
        const list = String(sel).split(',').map((s) => s.trim());
        let cur = el;
        while (cur) {
            const hit = list.some((s) => {
                if (s === 'select') return cur.tagName === 'SELECT';
                if (s.charAt(0) === '.') return !!(cur.classList && cur.classList.contains(s.slice(1)));
                return cur.tagName === s.toUpperCase();
            });
            if (hit) return cur;
            cur = cur.parentElement;
        }
        return null;
    };
    el.getBoundingClientRect = () => ({ left: 100, top: 50, right: 220, bottom: 86, width: 120, height: 36 });
    el.focus = () => { el._focused = true; };
    el.dispatchEvent = (ev) => {
        (el.listeners[ev.type] || []).forEach((fn) => fn(ev));
        return true;
    };
    el.scrollIntoView = () => { };
    return el;
}

function makeSelect(opts) {
    const sel = makeEl('select', { class: 'md-select rec-select' });
    sel.className = 'md-select rec-select'; // 组件按 className 判定 .md-select
    sel.children = opts.children || [];
    sel.children.forEach((c) => { c.parentElement = sel; });
    Object.defineProperty(sel, 'options', { get: () => sel.children.filter((c) => c.tagName === 'OPTION') });
    let selectedIndex = opts.selectedIndex || 0;
    Object.defineProperty(sel, 'selectedIndex', {
        get: () => selectedIndex,
        set: (v) => { selectedIndex = Number(v); },
    });
    Object.defineProperty(sel, 'value', {
        get: () => { const o = sel.options[selectedIndex]; return o ? o.attrs.value || o.label : ''; },
        set: (v) => {
            const i = sel.options.findIndex((o) => (o.attrs.value || o.label) === String(v));
            if (i >= 0) selectedIndex = i;
        },
    });
    sel.querySelectorAll = (s) => (s === 'option'
        ? sel.children.filter((c) => c.tagName === 'OPTION')
        : []);
    // option 需要 index/label/textContent
    sel.children.filter((c) => c.tagName === 'OPTION').forEach((o, i) => {
        o.index = i;
        o.label = o.attrs.label || o.textContent || '';
    });
    return sel;
}

/** 加载 custom-select.js（document 桩记录捕获监听）。 */
function loadCustomSelect(selects) {
    const listeners = { doc: {}, win: {} };
    const body = makeEl('body');
    const documentStub = {
        body,
        documentElement: makeEl('html'),
        addEventListener(type, fn) { (listeners.doc[type] = listeners.doc[type] || []).push(fn); },
        createElement: (tag) => makeEl(tag),
        querySelector: (sel) => selects.find((s) => sel.indexOf(s.attrs.id || '') >= 0) || null,
    };
    const context = {
        console, Math, Date, JSON, String, Array, Object, Number, Map, Set, RegExp, Promise,
        setTimeout, clearTimeout,
        document: documentStub,
        innerWidth: 1200, innerHeight: 800,
        addEventListener(type, fn) { (listeners.win[type] = listeners.win[type] || []).push(fn); },
        Event: function Event(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); },
        getComputedStyle: () => ({ zoom: '1' }),
        escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${SRC}\n;globalThis.__CS = YukiCustomSelect;`, context, { filename: 'custom-select.js' });
    return { cs: context.__CS, body, listeners };
}

// ---------------------------------------------------------------- 命中范围

test('_matchSelect：只接管启用的单选 .md-select；multiple/size/disabled/显式退出走原生', () => {
    const { cs } = loadCustomSelect([]);
    const child = makeEl('span');
    const sel = makeSelect({ children: [] });
    child.parentElement = sel;
    assert.equal(cs._matchSelect(child), sel, '.md-select 内的元素命中');
    // 非 md-select
    const plain = makeSelect({ children: [] });
    plain.className = 'rec-filter';
    assert.equal(cs._matchSelect(plain), null, '没有 .md-select 类的不接管');
    // multiple / size>1 / disabled / data-native-select
    const multi = makeSelect({ children: [] });
    multi.multiple = true;
    assert.equal(cs._matchSelect(multi), null, '多选走原生');
    const sized = makeSelect({ children: [] });
    sized.attrs.size = '5';
    sized.size = 5; // 真实 <select> 的 size 是 IDL 属性（反射 size 特性）
    assert.equal(cs._matchSelect(sized), null, 'size>1 列表式走原生');
    const disabled = makeSelect({ children: [] });
    disabled.disabled = true;
    assert.equal(cs._matchSelect(disabled), null, '禁用态不接管');
    const optedOut = makeSelect({ children: [] });
    optedOut.attrs['data-native-select'] = '';
    assert.equal(cs._matchSelect(optedOut), null, 'data-native-select 显式退出');
    assert.equal(cs._matchSelect(null), null);
});

// ---------------------------------------------------------------- 选项拍平

test('_collectItems：index 对齐 selectedIndex、optgroup 标题保留、disabled 继承', () => {
    const { cs } = loadCustomSelect([]);
    const opt1 = makeEl('option'); opt1.attrs.value = 'a'; opt1.textContent = '甲';
    const opt2 = makeEl('option'); opt2.attrs.value = 'b'; opt2.textContent = '乙'; opt2.disabled = true;
    const group = makeEl('optgroup'); group.attrs.label = '分组一'; group.label = '分组一'; // IDL 反射
    const opt3 = makeEl('option'); opt3.attrs.value = 'c'; opt3.textContent = '丙';
    const groupOff = makeEl('optgroup'); groupOff.attrs.label = '分组二'; groupOff.label = '分组二'; groupOff.disabled = true;
    const opt4 = makeEl('option'); opt4.attrs.value = 'd'; opt4.textContent = '丁';

    const sel = makeSelect({ children: [opt1, opt2, group, groupOff] });
    // 组内选项：option.index 由浏览器维护，这里手动对齐
    [opt1, opt2, opt3, opt4].forEach((o, i) => { o.index = i; o.label = o.textContent; });
    opt3.parentElement = group; group.parentElement = sel; sel.children.push(opt3);
    opt4.parentElement = groupOff; groupOff.parentElement = sel; sel.children.push(opt4);
    // querySelectorAll('option') 按文档序返回（含组内）
    sel.querySelectorAll = () => [opt1, opt2, opt3, opt4];

    const items = cs._collectItems(sel);
    // 跨 realm：按 JSON 比较
    assert.equal(JSON.stringify(items.map((i) => i.label)), JSON.stringify(['甲', '乙', '丙', '丁']));
    assert.equal(JSON.stringify(items.map((i) => i.index)), JSON.stringify([0, 1, 2, 3]), 'index 就是 selectedIndex 口径');
    assert.equal(items[1].disabled, true, 'option 自身 disabled');
    assert.equal(items[2].group, '分组一', 'optgroup 标题带上（渲染分组行）');
    assert.equal(items[3].disabled, true, 'optgroup 禁用时组内选项一并禁用');
    assert.equal(items[0].group, '', '不在组内的没有 group');
});

// ---------------------------------------------------------------- 行为（按下 → 打开 → 选中）

test('指针按下被 preventDefault（原生弹层不再出现），随后弹层可选中并派发 change', () => {
    const optA = makeEl('option'); optA.attrs.value = 'a'; optA.textContent = '甲';
    const optB = makeEl('option'); optB.attrs.value = 'b'; optB.textContent = '乙';
    const sel = makeSelect({ children: [optA, optB], selectedIndex: 0 });
    [optA, optB].forEach((o, i) => { o.index = i; o.label = o.textContent; });
    const { cs, body, listeners } = loadCustomSelect([sel]);

    let prevented = false;
    const pd = listeners.doc.pointerdown[0];
    pd({ target: sel, preventDefault: () => { prevented = true; }, clientX: 10, clientY: 10 });
    assert.equal(prevented, true, '按下事件被取消 → 系统下拉不会弹出');
    assert.equal(cs.isOpen(), true, '自绘弹层打开');
    const panel = cs._panel();
    assert.ok(panel && body.children.indexOf(panel) >= 0, '弹层挂在 body 上');
    assert.equal(panel.querySelectorAll('.yuki-sel-item').length, 2, '按选项渲染条目');
    assert.ok(panel.querySelectorAll('.yuki-sel-item')[0].classList.contains('is-checked'), '当前值带勾选态');

    // 点击第二项：写回值 + 派发 input/change（页面监听照旧收到）
    const seen = [];
    sel.addEventListener('change', (e) => seen.push(e.type));
    sel.addEventListener('input', (e) => seen.push(e.type));
    const item = panel.querySelectorAll('.yuki-sel-item')[1];
    listeners.doc.click[0]({ target: item, preventDefault() { }, stopPropagation() { } });
    assert.equal(sel.selectedIndex, 1, '选中项写回 selectedIndex');
    assert.equal(JSON.stringify(seen), JSON.stringify(['input', 'change']), '派发顺序与原生 <select> 一致');
    assert.equal(cs.isOpen(), false, '选完自动收起');
});

test('选中同一项不派发 change（与原生行为一致）；Esc/滚轮可关闭', () => {
    const optA = makeEl('option'); optA.attrs.value = 'a'; optA.textContent = '甲';
    const sel = makeSelect({ children: [optA], selectedIndex: 0 });
    optA.index = 0; optA.label = '甲';
    const { cs, listeners } = loadCustomSelect([sel]);
    let changes = 0;
    sel.addEventListener('change', () => { changes += 1; });
    const pd = listeners.doc.pointerdown[0];
    pd({ target: sel, preventDefault() { } });
    const panel = cs._panel();
    listeners.doc.click[0]({ target: panel.querySelectorAll('.yuki-sel-item')[0], preventDefault() { }, stopPropagation() { } });
    assert.equal(changes, 0, '同值不派发 change');

    // Esc 关闭
    pd({ target: sel, preventDefault() { } });
    assert.equal(cs.isOpen(), true);
    listeners.doc.keydown[0]({ key: 'Escape', preventDefault() { }, stopPropagation() { } });
    assert.equal(cs.isOpen(), false, 'Esc 关闭');
    // 滚轮关闭（弹层外的滚动）
    pd({ target: sel, preventDefault() { } });
    listeners.doc.wheel[0]({ target: makeEl('div') });
    assert.equal(cs.isOpen(), false, '页面滚动关闭弹层');
});

test('键盘：未展开时 Alt+↓ / Space 打开；展开时 ↓ 移动、Enter 选中', () => {
    const optA = makeEl('option'); optA.attrs.value = 'a'; optA.textContent = '甲';
    const optB = makeEl('option'); optB.attrs.value = 'b'; optB.textContent = '乙';
    const sel = makeSelect({ children: [optA, optB], selectedIndex: 0 });
    [optA, optB].forEach((o, i) => { o.index = i; o.label = o.textContent; });
    const { cs, listeners } = loadCustomSelect([sel]);
    const kd = listeners.doc.keydown[0];
    kd({ target: sel, key: 'ArrowDown', altKey: true, preventDefault() { } });
    assert.equal(cs.isOpen(), true, 'Alt+↓ 打开');
    kd({ target: sel, key: 'ArrowDown', preventDefault() { } });
    kd({ target: sel, key: 'Enter', preventDefault() { } });
    assert.equal(sel.selectedIndex, 1, '↓ 到第二项后 Enter 选中');
    assert.equal(cs.isOpen(), false);

    kd({ target: sel, key: ' ', preventDefault() { } });
    assert.equal(cs.isOpen(), true, 'Space 也能打开');
    kd({ target: sel, key: 'Escape', preventDefault() { }, stopPropagation() { } });
});

// ---------------------------------------------------------------- 样式与接线锚点

test('样式锚点：弹层圆角/主题色/层级与条目态齐全，且页面已加载组件', () => {
    const panelRule = CSS.slice(CSS.indexOf('.yuki-sel-panel {'), CSS.indexOf('.yuki-sel-panel {') + 500);
    assert.match(panelRule, /border-radius:var\(--radius-lg\)/, '弹层圆角');
    assert.match(panelRule, /background:var\(--md-surface-container-high\)/, '主题色底');
    assert.match(panelRule, /z-index:1340/, '层级高于对话框(100)/封面浮层(1300)');
    assert.match(CSS, /\.yuki-sel-item\.is-active \{[^}]*accent-hover-bg/, '键盘/悬停高亮态');
    assert.match(CSS, /\.yuki-sel-item\.is-checked \{[^}]*color:var\(--md-primary\)/, '当前项高亮');
    assert.match(CSS, /\.yuki-sel-check \{[^}]*opacity:0/, '勾选标记默认隐藏（仅当前项显示）');
    assert.match(HTML, /<script src="js\/custom-select\.js" defer><\/script>/, '页面加载自绘组件');
});
