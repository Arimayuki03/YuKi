'use strict';
// A-18 换线路/换源交叉淡入 + A-19 换线路勾选保护 回归测试：
// 1) selectSource（页签内切线路）：重绘集网格后对 #ep-list 重触发 .ep-grid-in 淡入
// 2) _catvodDialogSelectSource（弹窗内切线路）：对 .catvod-play-eps 同样挂 .ep-grid-in
// 3) A-19 方案一：多选态下切线路，清空勾选前计数并以 toast 提示丢弃数量
//    （无勾选 / 非多选路径不弹 toast，不制造噪音）
// 4) _downloadEps 勾选快照语义：勾选只存于 DOM，playSelected/_downloadEps 点击时
//    实时读 .ep-check.checked——切线路清空后，下载拿到的勾选集必须与界面一致（空）
// 5) 弹窗换线路同步清空页签残留勾选（勾选快照与界面一致性）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 极简 DOM 元素（供 replayClass 直接驱动原生 classList，与 replay-motion.test.js 同手法） */
function makeDomEl(tag, attrs = {}) {
    return {
        tag,
        _classes: new Set(attrs.class ? attrs.class.split(/\s+/).filter(Boolean) : []),
        get className() { return Array.from(this._classes).join(' '); },
        set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
        classList: null, // makeNode 内补
        _data: {},
        style: {},
    };
}

/** jQuery 风格节点桩：在 detail-start-button.test.js 基础上补 find/children/prop/
 *  text 记录与 [0] 原生节点桥（replayClass 断言需要原生 classList 视图）。
 *  - find(sel) 返回「按后缀匹配登记表」的子桩（renderEpisodes 在 #ep-list 内查询）；
 *  - [0] 惰性构造原生元素，classList 与 jQuery 侧 addClass/removeClass 同步。 */
function makeJqStub(captor) {
    // 选择器登记表：find/children 构造的子桩按后缀登记，嵌套查询继续挂表
    const registry = new Map(); // suffix -> node stub
    const getStub = (sel) => {
        const key = String(sel);
        if (registry.has(key)) return registry.get(key);
        const n = makeNode(key);
        registry.set(key, n);
        return n;
    };
    function makeNode(sel) {
        const node = {
            sel: String(sel),
            length: 1,
            _data: {},
            _props: {},
            _texts: [],
            _classes: new Set(),
            on(ev, a, b) {
                const fn = typeof b === 'function' ? b : a;
                const delegated = typeof b === 'function' ? String(a) : '';
                if (captor && typeof fn === 'function') captor.bound.push({ sel: String(sel), ev, delegated, fn });
                return this;
            },
            off() { return this; },
            html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), s); return this; },
            text(s) { if (s !== undefined) { node._texts.push(String(s)); captor && captor.texts.push([String(sel), String(s)]); } return this; },
            addClass(...cls) { cls.forEach((c) => node._classes.add(c)); return this; },
            removeClass(...cls) { cls.forEach((c) => node._classes.delete(c)); return this; },
            toggleClass(c, on) { if (on === undefined) on = !node._classes.has(c); if (on) node._classes.add(c); else node._classes.delete(c); return this; },
            prop(k, v) { if (v !== undefined) node._props[k] = v; return this; },
            attr() { return this; },
            find(sel) { return getStub(`${sel}`); },
            children(sel) { return getStub(`${sel}`); },
            each() { return this; },
            not() { return this; },
            is() { return false; },
            toggle() { return this; },
            hide() { return this; },
            show() { return this; },
            closest() { return getStub(`${sel} ^`); },
            data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
            append() { return this; },
        };
        // [0] 桥：原生元素与 jQuery 侧类集合同步，replayClass(epGrid,'ep-grid-in')
        // 的 remove/reflow/add 三段式在测试中可断言
        let raw = null;
        Object.defineProperty(node, 0, {
            get() {
                if (!raw) {
                    raw = makeDomEl('div');
                    raw.classList = {
                        contains: (c) => node._classes.has(c),
                        add: (c) => node._classes.add(c),
                        remove: (c) => node._classes.delete(c),
                    };
                    // replayClass 读取 offsetWidth 强制 reflow
                    Object.defineProperty(raw, 'offsetWidth', { get: () => 42 });
                }
                return raw;
            },
        });
        return node;
    }
    return (sel) => {
        if (sel && typeof sel === 'object') {
            return {
                length: 1,
                data(k, v) { if (v !== undefined) sel._data = sel._data || {}; if (v !== undefined) sel._data[k] = v; return (typeof sel.data === 'function') ? sel.data(k) : (sel._data && sel._data[k]); },
                attr(k) { return (typeof sel.attr === 'function') ? sel.attr(k) : undefined; },
                closest(s) { return (typeof sel.closest === 'function') ? sel.closest(s) : getStub('obj^'); },
                on() { return this; }, off() { return this; },
                html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), s); return this; },
                text() { return this; }, addClass() { return this; }, removeClass() { return this; },
                prop() { return this; }, find() { return this; }, each() { return this; },
                not() { return this; }, is() { return false; }, toggle() { return this; },
            };
        }
        return getStub(sel);
    };
}

/** 在 VM 中加载 detail.js（最小桩），返回 Detail 对象、监听器记录与 HTML 捕获。 */
function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const captor = { bound: [], htmlBySel: new Map(), texts: [] };
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
        openDialog: () => {},
        closeDialog: () => {},
        // replayClass 真实实现（A-04 common.js 同款；打包时由模块注入 detail.js）：
        // 三段式 remove→reflow→add 直接驱动 $ 桩 [0] 桥的原生 classList，供 A-18 断言
        replayClass: (el, cls) => {
            if (!el || !el.classList) return;
            el.classList.remove(cls);
            void el.offsetWidth;
            el.classList.add(cls);
        },
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, bound: captor.bound, htmlBySel: captor.htmlBySel, texts: captor.texts, toasts, context, $: context.$ };
}

const SRCES = [
    { from: '线路A', episodes: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }] },
    { from: '线路B', episodes: [{ name: 'EP1', url: 'v1' }, { name: 'EP2', url: 'v2' }, { name: 'EP3', url: 'v3' }] },
];

// ---------------------------------------------------------------- A-18 换线路交叉淡入

test('A-18：selectSource 换线路后对 #ep-list 重触发 .ep-grid-in 淡入（remove→reflow→add）', () => {
    const { Detail, $ } = loadDetail();
    Detail.sources = SRCES.map((s) => ({ from: s.from, episodes: s.episodes }));
    Detail.activeSource = 0;
    Detail.renderEpisodes();
    // replayClass 走 $ 桩 [0] 桥的原生 classList：重触发后类应仍在（remove→add 收敛）
    const grid = $('#ep-list');
    assert.equal(typeof grid[0], 'object', '$ 桩应支持 [0] 原生节点桥');
    // 初次 renderEpisodes 不挂淡入类（入场归页签 tab-enter，避免叠加动画）
    assert.ok(!grid[0].classList.contains('ep-grid-in'), '初次渲染不应挂 ep-grid-in');
    Detail.selectSource(1);
    assert.ok(grid[0].classList.contains('ep-grid-in'), '换线路后集网格容器应挂 .ep-grid-in（replayClass 重触发）');
    // 每次换线路重触发一次（重复换线路类不丢失，动画由 CSS 端重播）
    Detail.selectSource(0);
    assert.ok(grid[0].classList.contains('ep-grid-in'), '再次换线路仍应保持 .ep-grid-in');
    // 越界下标：不渲染、不挂淡入类变化
    Detail.selectSource(9);
    assert.equal(Detail.activeSource, 0, '越界下标应被忽略');
});

test('A-18：_catvodDialogSelectSource 弹窗内换线路对 .catvod-play-eps 挂 .ep-grid-in', () => {
    const { Detail, $ } = loadDetail();
    Detail.sources = SRCES.map((s) => ({ from: s.from, episodes: s.episodes }));
    Detail.activeSource = 0;
    Detail.vodName = '测试影片';
    Detail._catvodDialogSelectSource(1);
    // 弹窗网格的 [0] 桥：makeJqStub 的 registry 保证 '#catvod-play-dialog-body
    // .catvod-play-eps' 与代码里的选择器命中同一桩节点
    const dlgGrid = $('#catvod-play-dialog-body .catvod-play-eps');
    assert.ok(dlgGrid[0].classList.contains('ep-grid-in'), '弹窗集数网格应挂 .ep-grid-in 淡入');
});

test('A-18：ui.css 定义 epGridIn keyframes 且挂载规则带 html:not(.glass-on) 门控', () => {
    const css = read('src/renderer/css/ui.css');
    assert.ok(css.includes('@keyframes epGridIn'), 'ui.css 应定义 epGridIn keyframes');
    assert.ok(/html:not\(\.glass-on\)[^{]*\.ep-grid\.ep-grid-in\s*\{[^}]*animation:epGridIn/.test(css),
        'ep-grid-in 挂载规则应以 html:not(.glass-on) 门控并引用 epGridIn');
    // 弹窗路径同样有挂载规则
    assert.ok(/html:not\(\.glass-on\)\s+\.catvod-play-sheet \.ep-grid\.ep-grid-in/.test(css),
        '弹窗集数网格应有独立挂载规则');
    // 纯 opacity：keyframes 体不含 transform/translateY（复用节点跳位防护）
    const kf = css.match(/@keyframes epGridIn \{([\s\S]*?)\n\}/);
    assert.ok(kf, '应能截取 epGridIn keyframes 体');
    assert.ok(!/transform/.test(kf[1]), 'epGridIn 只动 opacity，不应含 transform');
});

// ---------------------------------------------------------------- A-19 换线路勾选保护

/** 可控勾选计数的 $ 桩工厂：'.ep-check.checked' 选择器的命中数可指定
 *  （默认桩 length:1 只能表达「1 个勾选」，无法表达 0/N），并记录
 *  removeClass 调用与 [0] 原生桥（selectSource 尾部 replayClass 需要）。 */
function makeCheckedJq(opts) {
    const removed = [];
    const htmlBySel = new Map();
    const checkedLen = opts && Object.prototype.hasOwnProperty.call(opts, 'checkedLength')
        ? opts.checkedLength : 0;
    const makeNode = (sel) => {
        const node = {
            sel: String(sel), length: 1, _data: {}, _classes: new Set(),
            on() { return node; }, off() { return node; },
            html(s) { if (s !== undefined) htmlBySel.set(String(sel), s); return node; },
            text() { return node; },
            addClass() { return node; },
            removeClass(...cls) { cls.forEach((c) => removed.push([String(sel), c])); return node; },
            toggleClass() { return node; },
            prop() { return node; },
            attr() { return node; },
            find() { return makeNode(`${sel} *`); },
            children() { return makeNode(`${sel} >`); },
            each() { return node; },
            not() { return node; }, is() { return false; }, toggle() { return node; },
            hide() { return node; }, show() { return node; },
            closest() { return makeNode(`${sel} ^`); },
            data(k, v) { if (v !== undefined) node._data[k] = v; return node._data[k]; },
            append() { return node; },
        };
        // [0] 原生桥：classList 与 jQuery 侧 addClass/removeClass 同源（replayClass 可断言）
        let raw = null;
        Object.defineProperty(node, 0, {
            get() {
                if (!raw) {
                    raw = makeDomEl('div');
                    raw.classList = {
                        contains: (c) => node._classes.has(c),
                        add: (c) => node._classes.add(c),
                        remove: (c) => node._classes.delete(c),
                    };
                    Object.defineProperty(raw, 'offsetWidth', { get: () => 42 });
                }
                return raw;
            },
        });
        return node;
    };
    const $ = (sel) => {
        if (sel && typeof sel === 'object') return makeNode('obj');
        const n = makeNode(sel);
        if (String(sel).endsWith('.ep-check.checked')) n.length = checkedLen;
        return n;
    };
    return { $, removed, htmlBySel };
}

test('A-19 方案一：多选态下换线路清空勾选并 toast 提示精确数量（勾选 2 集提示 2）', () => {
    // 勾选 2 集：'.ep-check.checked' 命中 2 → toast 文案含 2
    const jq2 = makeCheckedJq({ checkedLength: 2 });
    const { Detail, toasts } = loadDetail({ $: jq2.$ });
    Detail.sources = SRCES.map((s) => ({ from: s.from, episodes: s.episodes }));
    Detail.activeSource = 0;
    Detail._epSelectMode = true;
    Detail.selectSource(1);
    assert.equal(Detail.activeSource, 1, '换线路应生效');
    assert.equal(toasts.length, 1, '有勾选丢弃时应弹 toast');
    assert.ok(/已切换线路.*2 集已清空/.test(toasts[0]), `toast 应含丢弃数量 2（实际「${toasts[0]}」）`);
    // 清空动作确实发生（快照一致性前提）
    const cleared = jq2.removed.filter(([sel, c]) => sel === '#detail-tab-content .ep-check' && c === 'checked');
    assert.ok(cleared.length >= 1, '换线路应清空 .ep-check 的 checked');
});

test('A-19：无勾选时换线路不 toast（不制造噪音）', () => {
    const jq0 = makeCheckedJq({ checkedLength: 0 });
    const { Detail, toasts } = loadDetail({ $: jq0.$ });
    Detail.sources = SRCES.map((s) => ({ from: s.from, episodes: s.episodes }));
    Detail.activeSource = 0;
    Detail._epSelectMode = true;
    Detail.selectSource(1);
    assert.deepEqual(toasts, [], '无勾选时换线路不应弹 toast');
    assert.equal(Detail.activeSource, 1);
});

test('A-19 勾选快照语义：playSelected/downloadSelected 点击时实时读 DOM，切线路清空后取到空集', () => {
    // 结构断言：playSelected 与 downloadSelected 从 $('#ep-list .ep-check.checked')
    // 实时读取（VM 桩无法模拟真实 DOM 状态机，做源码结构校验）。
    // 注意锚定方法定义本体（'xxx() {'），避免命中 init 绑定里的 `() => this.xxx()`。
    const source = read('src/renderer/js/detail.js');
    for (const fn of ['playSelected() {', 'downloadSelected() {']) {
        const i = source.indexOf(fn);
        assert.ok(i > 0, `应存在方法定义 ${fn}`);
        const body = source.slice(i, i + 600);
        assert.ok(body.includes("$('#ep-list .ep-check.checked')"),
            `${fn} 应实时读 #ep-list .ep-check.checked（界面=快照）`);
    }
    // selectSource 内先清空再 renderEpisodes：清空先于重排（节点复用语义）。
    // 锚定方法定义本体（'selectSource(idx) {'），避免命中 init 绑定里的 this.selectSource(idx)
    const si = source.indexOf('selectSource(idx) {');
    const sBody = source.slice(si, si + 1400);
    const clearAt = sBody.indexOf("$('#detail-tab-content .ep-check').removeClass('checked')");
    const renderAt = sBody.indexOf('this.renderEpisodes()');
    assert.ok(clearAt > -1 && renderAt > clearAt, 'selectSource 内清空勾选必须先于 renderEpisodes');
});

test('A-19：弹窗内换线路同步清空页签残留勾选（勾选快照与界面一致性）', () => {
    const jq = makeCheckedJq({ checkedLength: 3 });
    const { Detail, toasts } = loadDetail({ $: jq.$ });
    Detail.sources = SRCES.map((s) => ({ from: s.from, episodes: s.episodes }));
    Detail.activeSource = 0;
    Detail._epSelectMode = true;
    Detail._catvodDialogSelectSource(1);
    assert.equal(Detail.activeSource, 1, '弹窗换线路应同步 activeSource');
    const cleared = jq.removed.filter(([sel, c]) => sel === '#detail-tab-content .ep-check' && c === 'checked');
    assert.ok(cleared.length >= 1, '弹窗换线路应清空页签残留勾选');
    assert.equal(Detail._epSelectMode, false, '弹窗换线路应复位多选态（页签下次渲染干净）');
    // 弹窗路径不弹「已清空」toast（提示归页签换线路路径，弹窗静默复位）
    assert.deepEqual(toasts, [], '弹窗路径不应弹清空提示');
});
