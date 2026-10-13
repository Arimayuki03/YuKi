'use strict';
// C：角色详情浮层「CV（配音）」信息行。数据源与列表卡同源（_charCvText：actors 优先、
// actor 字符串兜底、多 CV「 / 」连接）；浮层 HTML 经 vm 桩捕获后做串断言。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

/** 可链式调用的 jQuery 桩（find/on/off/css/html/each 全返回自身）。 */
function mkJq() {
    const jq = {
        length: 0,
        on() { return jq; }, off() { return jq; }, html() { return jq; }, text() { return jq; },
        css() { return jq; }, attr() { return jq; }, data() { return jq; },
        find() { return jq; }, each() { return jq; }, removeClass() { return jq; }, addClass() { return jq; },
        toggleClass() { return jq; }, closest() { return jq; },
    };
    return jq;
}

/** char-float 面板桩：innerHTML 被写入时同步造出 firstChild（真实 DOM 的 innerHTML 解析语义）。 */
function mkEl(tag) {
    const el = {
        tag, id: '', style: {}, listeners: {}, children: [],
        classList: {
            _set: new Set(),
            add(...k) { k.forEach((x) => this._set.add(x)); },
            remove(...k) { k.forEach((x) => this._set.delete(x)); },
            contains(k) { return this._set.has(k); },
        },
        addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
        appendChild(c) { el.children.push(c); if (c.id) el._byId[c.id] = c; return c; },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
        querySelector() { return null; }, closest() { return null; },
    };
    el._htmls = [];
    el.firstChild = null;
    Object.defineProperty(el, 'innerHTML', {
        configurable: true,
        get() { return el._htmls[el._htmls.length - 1] || ''; },
        set(v) {
            el._htmls.push(String(v));
            if (!el.firstChild) el.firstChild = mkEl('div');
        },
    });
    return el;
}

function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, URL,
        parseInt, parseFloat, setTimeout, clearTimeout, setInterval, clearInterval,
        navigator: {},
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } }, children: [], appendChild(c) { if (c.id) this._byId[c.id] = c; this.children.push(c); }, _byId: {} },
            getElementById(id) { return this.body._byId[id] || null; },
            createElement(tag) { return mkEl(tag); },
        },
        $: mkJq,
        registerEsc: () => {}, staggerEnter: () => {}, replayClass: () => {},
        escHtml: (s) => String(s == null ? '' : s), stripHtml: (s) => String(s || ''),
        warnToast: () => {}, showLoading() {}, hideLoading() {},
        bangumiCover: () => '', vodCoverImg: () => '', normalizePic: (p) => p || '', abortCoverFill: () => {},
        localCacheGet: () => null, localCacheSet: () => {}, localCacheDel: () => {},
        openDialog: () => {}, closeDialog: () => {},
        fmtCommentTimeFull: () => '', commentTsMs: () => 0,
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
        Kazumi: { bangumiCharacter: async () => null, bangumiCharacterComments: async () => [] },
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    return { Detail: vm.runInContext('Detail', context), context };
}

/** 打开角色详情浮层，返回面板 HTML（真实 _openCharacterDetail 产出）。 */
async function openChar(info, extra) {
    const { Detail, context } = loadDetail(Object.assign({
        Kazumi: {
            bangumiCharacter: async () => info,
            bangumiCharacterComments: async () => [],
        },
    }, extra || {}));
    await Detail._openCharacterDetail('123');
    const wrap = context.document.body._byId['char-float'];
    assert.ok(wrap, 'char-float 浮层已创建');
    // 资料面板内容写在 wrap.firstChild（.char-float-panel）的 innerHTML 上
    const panel = wrap.firstChild;
    assert.ok(panel && panel._htmls.length >= 1, '面板内容已写入（占位串写在 wrap 上、资料面板写在 firstChild 上）');
    return { html: panel._htmls[panel._htmls.length - 1], Detail, context };
}

const BASE_INFO = {
    id: 123, name: '椎名まふゆ', images: { card: 'https://lain.bgm.tv/a.jpg' },
    infobox: [{ key: '简体中文名', value: '椎名真冬' }, { key: '生日', value: '2月22日' }],
    summary: '简介文本',
};

// ---------------------------------------------------------------- CV 文本提取

test('_charCvText：actors（name_cn 优先）→ actor 字符串兜底 → 无 CV 空串', () => {
    const { Detail } = loadDetail();
    assert.equal(Detail._charCvText({ actors: [{ name: '花澤香菜' }] }), '花澤香菜');
    assert.equal(Detail._charCvText({ actors: [{ name: 'Kana Hanazawa', name_cn: '花泽香菜' }] }), '花泽香菜');
    // 多 CV：与列表卡同款「 / 」连接
    assert.equal(Detail._charCvText({ actors: [{ name: 'A' }, { name_cn: 'B' }, { name: 'C' }] }), 'A / B / C');
    // 空项/空白项被过滤，不产生多余分隔符
    assert.equal(Detail._charCvText({ actors: [{ name: '  ' }, null, { name: 'B' }] }), 'B');
    // 镜像兼容：actor 字符串
    assert.equal(Detail._charCvText({ actor: ' 佐倉綾音 ' }), '佐倉綾音');
    // 无数据
    assert.equal(Detail._charCvText({}), '');
    assert.equal(Detail._charCvText({ actors: [] }), '');
    assert.equal(Detail._charCvText(null), '');
    // actors 全空但 actor 存在：仍走兜底
    assert.equal(Detail._charCvText({ actors: [{ name: '' }], actor: 'X' }), 'X');
});

// ---------------------------------------------------------------- 浮层渲染

test('_openCharacterDetail：有 CV 渲染 .char-float-cv 行，多 CV「 / 」连接且转义', async () => {
    const { html } = await openChar(Object.assign({}, BASE_INFO, {
        actors: [{ name: '花澤香菜' }, { name: '早見沙織' }],
    }));
    assert.match(html, /<div class="char-float-cv">CV：花澤香菜 \/ 早見沙織<\/div>/,
        'CV 行存在且与列表卡同款「 / 」连接');
    // 位置：紧随 meta 行之后（与其它信息行同层级，不插进简介/页签）
    assert.ok(html.indexOf('char-float-meta') < html.indexOf('char-float-cv'), 'CV 行在 meta 行之后');
    assert.ok(html.indexOf('char-float-cv') < html.indexOf('char-float-summary') || html.indexOf('char-float-summary') === -1,
        'CV 行在简介之前');
    // 与既有信息行共存（血型/身高/体重仍在）
    const withMeta = await openChar(Object.assign({}, BASE_INFO, { blood_type: 'A', height: 160, actors: [{ name: '甲' }] }));
    assert.match(withMeta.html, /血型 A · 身高 160cm/);
    assert.match(withMeta.html, /CV：甲/);
});

test('_openCharacterDetail：无 CV 不渲染 CV 行（不留空行）', async () => {
    const { html } = await openChar(BASE_INFO);
    assert.ok(!html.includes('char-float-cv'), '无 CV 数据时不渲染空行');
    // 对照组：有 CV 时同一条路径确实渲染（防「断言永假」的假绿）
    const withCv = await openChar(Object.assign({}, BASE_INFO, { actor: '甲' }));
    assert.ok(withCv.html.includes('char-float-cv'), 'actor 字符串形态同样出 CV 行');
    assert.match(withCv.html, /<div class="char-float-cv">CV：甲<\/div>/);
});

test('_openCharacterDetail：CV 名含特殊字符被 escHtml 转义（真实渲染路径）', async () => {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const { html } = await openChar(Object.assign({}, BASE_INFO, { actors: [{ name: 'A<script>alert(1)</script>' }] }), { escHtml: esc });
    assert.match(html, /CV：A&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(!/<script>/.test(html), 'CV 文案不得原样注入标签');
});

// ---------------------------------------------------------------- 样式锚点

test('锚点：ui.css 有 .char-float-cv 规则且与 .char-float-meta 同层级、可换行不溢出', () => {
    const css = read('src/renderer/css/ui.css');
    const m = css.match(/\.char-float-cv \{([^}]*)\}/);
    assert.ok(m, 'ui.css 应存在 .char-float-cv 规则');
    const body = m[1];
    assert.match(body, /font-size:12px/, '字号与 .char-float-meta 一致');
    assert.match(body, /color:var\(--md-on-surface-variant\)/, '颜色用主题 token（适配 html.dark / html[data-color]）');
    assert.match(body, /overflow-wrap:anywhere/, '超长多 CV 换行不溢出');
    // 数据源复用锚点：详情浮层与列表卡读同一提取函数
    const src = read('src/renderer/js/detail.js');
    assert.match(src, /Detail\._charCvText\(info\)/, '浮层复用 _charCvText（同一数据源）');
});
