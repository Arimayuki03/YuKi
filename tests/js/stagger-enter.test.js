'use strict';
/**
 * stagger-enter.test.js — A-11 详情网格/评论错峰入场测试：
 * 1) 行为测试（common.js vm 桩，手法同 replay-motion.test.js）：
 *    - staggerEnter 容器模式：延迟序列 0/45/…/315ms（STAGGER_STEP_MS/STAGGER_MAX_IDX
 *      常量）、容器挂 .stagger-in 且经 replayClass 三段式（恰一次 reflow）；
 *    - 限量模式（firstN）：.stagger-in 只挂前 min(firstN, 子项数, 8) 个子项、
 *      容器不带类（渐进追加行无标记不入场——评论续拉语义）；firstN 超额封顶 8；
 *    - 容器为空/无匹配子项时静默返回。
 * 2) 源码锚点契约（先例：ep-highlight.test.js 守卫锚点手法）：
 *    - detail.js 四个调用点（角色/制作/关联网格容器模式 + 吐槽首屏限量 8 条）；
 *    - ui.css 门控规则：html:not(.glass-on) 选择器 + vodCardIn 令牌 + 动画只动
 *      transform/opacity + prefers-reduced-motion 关闭 + 限量模式选择器
 *      （.detail-comment-list > .detail-comment.stagger-in，容器不带类仍命中）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const SRC = path.join(ROOT, 'src/renderer/js/common.js');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 链式 jQuery 桩（与 replay-motion.test.js 同款，裁剪到 staggerEnter 依赖面）。 */
function jqOf(items) {
    const api = {
        length: items.length,
        _items: items,
        0: items[0],
        get() { return items.slice(); },
        find() { return jqOf([]); },
        children(sel) {
            const cls = String(sel || '').replace(/^\./, '');
            const out = [];
            for (const it of items) for (const c of (it._children || [])) if (!cls || (c._classes && c._classes.has(cls))) out.push(c);
            return jqOf(out);
        },
        each(fn) { items.forEach((el, i) => fn.call(el, i, el)); return api; },
        addClass(c) { items.forEach((el) => el._classes && el._classes.add(c)); return api; },
        removeClass(c) { items.forEach((el) => el._classes && el._classes.delete(c)); return api; },
        hasClass(c) { return items.some((el) => el._classes && el._classes.has(c)); },
        on() { return api; }, off() { return api; }, html() { return api; }, text() { return api; },
    };
    return api;
}

/** 极简 DOM 元素：_children/_classes + classList + style + offsetWidth（reflow 探针）。 */
function makeEl(classes = [], props = {}) {
    const el = {
        _children: [],
        style: {},
        textContent: '',
        attrs: {},
        offsetWidth: 100,
        getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
        setAttribute(n, v) { this.attrs[n] = String(v); },
    };
    el._classes = new Set(classes);
    el.classList = {
        _s: el._classes,
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
    };
    return Object.assign(el, props);
}

/** 在 VM 中加载 common.js（与 replay-motion.test.js 同款全局桩）。 */
function loadCommon() {
    const source = fs.readFileSync(SRC, 'utf8');
    const registry = new Map();
    const documentElement = {
        classList: { _s: new Set(), add() {}, remove() {}, toggle() {}, contains: () => false },
        style: { setProperty() {}, removeProperty() {} },
        dataset: {},
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array,
        parseInt, parseFloat, setTimeout, clearTimeout, URLSearchParams,
        crypto: globalThis.crypto,
        $: (arg) => {
            if (typeof arg === 'string') return jqOf(registry.get(arg) || []);
            if (arg && typeof arg === 'object') return jqOf([arg]);
            return jqOf([]);
        },
        getComputedStyle: () => ({ lineHeight: '20px' }),
        document: {
            addEventListener() {}, removeEventListener() {},
            querySelector: () => null, querySelectorAll: () => [],
            getElementById: () => null,
            createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false } }),
            documentElement,
            body: { style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {} }, dataset: {} },
            head: { appendChild() {} },
        },
        window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        fetch: async () => ({ ok: true, text: async () => '' }),
        AbortSignal: { timeout: () => ({}) },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}
;globalThis.__api = { staggerEnter, STAGGER_STEP_MS, STAGGER_MAX_IDX };`, context, { filename: 'common.js' });
    return context.__api;
}

// ---------------------------------------------------------------- 容器模式

test('A-11 staggerEnter 容器模式：延迟 0/45/…封顶 315ms，容器挂 .stagger-in 且恰一次 reflow', () => {
    const api = loadCommon();
    const grid = makeEl();
    const reflows = [];
    Object.defineProperty(grid, 'offsetWidth', { get() { reflows.push(1); return 100; } });
    const cards = Array.from({ length: 10 }, () => makeEl(['detail-char-card']));
    grid._children = cards;
    api.staggerEnter(grid, '.detail-char-card');
    const expected = cards.map((_, i) => `${Math.min(i, api.STAGGER_MAX_IDX) * api.STAGGER_STEP_MS}ms`);
    assert.deepEqual(cards.map((c) => c.style.animationDelay), expected, '延迟序列与 A-04 常量一致');
    assert.equal(cards[7].style.animationDelay, '315ms');
    assert.equal(cards[8].style.animationDelay, '315ms', 'idx≥7 封顶 7×45ms');
    assert.ok(cards.every((c) => c.classList.contains('stagger-in')), '容器模式子项全部带 stagger-in');
    assert.ok(grid.classList.contains('stagger-in'), '容器挂 .stagger-in');
    assert.equal(reflows.length, 1, '经 replayClass 三段式重挂（恰一次 reflow）');
});

test('A-11 staggerEnter 容器模式：重渲染时容器类 remove→reflow→add（入场重播）', () => {
    const api = loadCommon();
    const grid = makeEl(['stagger-in']);
    const ops = [];
    grid.classList = {
        _s: grid._classes,
        add(c) { ops.push(`add:${c}`); this._s.add(c); },
        remove(c) { ops.push(`remove:${c}`); this._s.delete(c); },
        contains(c) { return this._s.has(c); },
    };
    Object.defineProperty(grid, 'offsetWidth', { get() { ops.push('reflow'); return 100; } });
    grid._children = [makeEl(['detail-char-card'])];
    api.staggerEnter(grid, '.detail-char-card');
    assert.deepEqual(ops, ['remove:stagger-in', 'reflow', 'add:stagger-in'],
        '筛选条重渲染走三段式重触发，动画从头起播');
});

// ---------------------------------------------------------------- 限量模式

test('A-11 staggerEnter 限量模式：.stagger-in 只挂前 min(firstN,8) 行，容器不带类', () => {
    const api = loadCommon();
    const list = makeEl();
    const reflows = [];
    Object.defineProperty(list, 'offsetWidth', { get() { reflows.push(1); return 100; } });
    const rows = Array.from({ length: 30 }, () => makeEl(['detail-comment']));
    list._children = rows;
    api.staggerEnter(list, '.detail-comment', 8);
    assert.deepEqual(rows.map((r) => r.classList.contains('stagger-in')),
        rows.map((_, i) => i < 8), '恰好前 8 行带标记');
    assert.equal(rows[0].style.animationDelay, '0ms');
    assert.equal(rows[7].style.animationDelay, '315ms');
    assert.equal(rows[8].style.animationDelay, undefined, '第 9 行起无延迟（追加行不入场）');
    assert.ok(!list.classList.contains('stagger-in'), '容器不带类——续拉插入的行永不连带入场');
    assert.equal(reflows.length, 0, '限量模式不触发容器 reflow');
});

test('A-11 staggerEnter 限量模式：firstN 超额封顶 STAGGER_MAX_IDX+1=8，少于子项数时按 firstN', () => {
    const api = loadCommon();
    const mk = (n) => {
        const box = makeEl();
        box._children = Array.from({ length: n }, () => makeEl(['detail-comment']));
        return { box, rows: box._children };
    };
    const a = mk(3);
    api.staggerEnter(a.box, '.detail-comment', 8);
    assert.equal(a.rows.filter((r) => r.classList.contains('stagger-in')).length, 3,
        'firstN > 子项数时按子项数');
    const b = mk(30);
    api.staggerEnter(b.box, '.detail-comment', 100);
    assert.equal(b.rows.filter((r) => r.classList.contains('stagger-in')).length, 8,
        'firstN 超额封顶 8（第 8 条延迟已达 315ms 上限，再多视觉无差）');
    const c = mk(30);
    api.staggerEnter(c.box, '.detail-comment', 5);
    assert.equal(c.rows.filter((r) => r.classList.contains('stagger-in')).length, 5, '按 firstN 计');
});

// ---------------------------------------------------------------- 边界

test('A-11 staggerEnter：空容器/无匹配子项静默返回（不挂类不抛错）', () => {
    const api = loadCommon();
    const empty = makeEl();
    api.staggerEnter(empty, '.detail-char-card');
    assert.ok(!empty.classList.contains('stagger-in'), '无子项不挂容器类');
    const grid = makeEl();
    grid._children = [makeEl(['other-card'])];
    api.staggerEnter(grid, '.detail-char-card');
    assert.ok(!grid.classList.contains('stagger-in'), '选择器不匹配不挂容器类');
});

// ---------------------------------------------------------------- 源码锚点契约

test('A-11 锚点：detail.js 四个调用点——三网格容器模式 + 吐槽首屏限量 8 条', () => {
    const src = read('src/renderer/js/detail.js');
    assert.match(src, /staggerEnter\(box\.find\('\.detail-char-grid'\), '\.detail-char-card'\)/,
        '角色网格：容器模式');
    assert.match(src, /staggerEnter\(box\.find\('\.detail-staff-grid'\), '\.detail-staff'\)/,
        '制作网格：容器模式');
    assert.match(src, /staggerEnter\(box\.find\('\.detail-relation-grid'\), '\.detail-relation'\)/,
        '关联网格：容器模式');
    assert.match(src,
        /staggerEnter\(box\.find\('\.detail-comment-list'\)\.first\(\), '\.detail-comment', 8\)/,
        '吐槽首屏：限量模式 N=8（STAGGER_MAX_IDX+1 封顶）');
    // 续拉/重排增量路径不得布置 staggerEnter（追加行不重播）：
    // 只圈定 _renderComments 的续拉增量分支（if listBox… 到 else 为止）
    const inc = src.match(
        /if \(listBox\.length && listBox\.children\('\.detail-comment'\)\.length\) \{[\s\S]*?\n        \} else \{/,
    );
    assert.ok(inc, '_renderComments 存在续拉增量分支');
    assert.ok(!inc[0].includes('staggerEnter('), '续拉增量分支内不得调用 staggerEnter');
});

test('A-11 锚点：ui.css 门控规则——html:not(.glass-on) + vodCardIn 令牌 + 只动 transform/opacity', () => {
    const css = read('src/renderer/css/ui.css');
    for (const sel of [
        '.detail-char-grid.stagger-in > .detail-char-card',
        '.detail-staff-grid.stagger-in > .detail-staff',
        '.detail-relation-grid.stagger-in > .detail-relation',
        '.detail-comment-list > .detail-comment.stagger-in',
    ]) {
        assert.ok(css.includes(`html:not(.glass-on) ${sel}`), `存在 glass 门控规则：${sel}`);
    }
    // keyframes 复用 vodCardIn（与 .cards-enter 同源），令牌时长/缓动
    assert.match(css,
        /html:not\(\.glass-on\) \.detail-comment-list > \.detail-comment\.stagger-in \{ animation:vodCardIn var\(--dur-slow\) var\(--ease\) both; \}/,
        '动画复用 vodCardIn + 令牌（--dur-slow/--ease）+ both 填充');
    // A-11 段内的选择器组不得引入 transform/opacity 之外的属性（§6 契约）
    const block = css.match(/@keyframes vodCardIn \{[\s\S]*?\n\}/);
    assert.ok(block, 'vodCardIn keyframes 存在');
    assert.match(block[0], /opacity/);
    assert.match(block[0], /transform/);
    assert.doesNotMatch(block[0], /(width|height|margin|padding|filter|box-shadow|border)/,
        'vodCardIn 只动 transform/opacity');
    // prefers-reduced-motion 一并关闭（与 .cards-enter 同口径）
    const rm = css.match(/@media \(prefers-reduced-motion: reduce\) \{[^@]*?detail-comment\.stagger-in \{ animation:none; \}/s);
    assert.ok(rm, 'prefers-reduced-motion 下 A-11 入场动画关闭');
});
