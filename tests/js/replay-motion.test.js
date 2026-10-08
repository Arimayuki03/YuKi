'use strict';
/**
 * replay-motion.test.js — A-04 动效公共工具白盒单测：
 * - replayClass：三段式重触发（remove → 强制 reflow（读 offsetWidth）→ add）的调用序列；
 * - motionAllowed：三合一门控谓词（应用内动画开关 / prefers-reduced-motion / html.glass-on，
 *   任一为真即 false；三条件全放行才 true）；
 * - 错峰常量：STAGGER_STEP_MS=45 / STAGGER_MAX_IDX=7（45ms/第 8 张起封顶 315ms，
 *   A-04 归一基准），并验证 playCardsEnter/stageAppendedCards 产出的延迟序列与常量一致。
 *
 * 加载方式：fs.readFileSync + node:vm，注入 document/window/$/_skin 等全局桩
 * （与 tests/js/common-utils.test.js 同款写法）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '../../src/renderer/js/common.js');

/** 链式 jQuery 桩：够用即可（length/children/each/addClass/removeClass/hasClass/get）。 */
function jqOf(items) {
    const api = {
        length: items.length,
        _items: items,
        0: items[0],
        get() { return items.slice(); },
        find(sel) {
            const cls = String(sel).replace(/^\./, '');
            const out = [];
            for (const it of items) for (const c of (it._children || [])) if (c._classes && c._classes.has(cls)) out.push(c);
            return jqOf(out);
        },
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
        on() { return api; }, off() { return api; }, empty() { return api; },
        html() { return api; }, text() { return api; }, css() { return api; },
        data() { return ''; }, removeAttr() { return api; },
    };
    return api;
}

/**
 * 极简 DOM 元素：_children/_classes + 原生形态 classList（replayClass 直接驱动
 * classList.remove/add，必须提供）+ style。offsetWidth 默认数据属性 100。
 */
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

/**
 * 在 VM 中加载 common.js，注入最小全局桩；返回上下文（__api 为被测函数集合）。
 * opts：animEnabled（应用内开关，false 时经 VM 内改写 _skin.animEnabled）、
 * reducedMotion（matchMedia 桩命中级）、glassOn（html.glass-on 预置）。
 */
function loadCommon(opts = {}) {
    const o = Object.assign({ animEnabled: true, reducedMotion: false, glassOn: false }, opts);
    const source = fs.readFileSync(SRC, 'utf8');
    const registry = new Map();
    const documentElement = {
        classList: {
            _s: new Set(o.glassOn ? ['glass-on'] : []),
            add(c) { this._s.add(c); },
            remove(c) { this._s.delete(c); },
            toggle() {},
            contains(c) { return this._s.has(c); },
        },
        style: { setProperty() {}, removeProperty() {} },
        dataset: {},
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array,
        parseInt, parseFloat, setTimeout, clearTimeout, URLSearchParams,
        crypto: globalThis.crypto,
        // $ 桩：字符串选择器走 registry；对象视作单元素集合（$(容器)）
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
        window: { matchMedia: () => ({ matches: !!o.reducedMotion, addEventListener() {} }) },
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        fetch: async () => ({ ok: true, text: async () => '' }),
        AbortSignal: { timeout: () => ({}) },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}
;globalThis.__api = {
    replayClass, motionAllowed, playCardsEnter, stageAppendedCards,
    STAGGER_STEP_MS, STAGGER_MAX_IDX,
};
// applySkin 依赖面大（zoom/webFrame/壁纸等）不跑：按其同步语义直接改写 _skin.animEnabled
globalThis.__setAnim = (on) => { _skin.animEnabled = on; };`, context, { filename: 'common.js' });
    if (o.animEnabled === false) vm.runInContext('globalThis.__setAnim(false)', context);
    return context;
}

const A = (ctx) => ctx.__api;

// ---------------------------------------------------------------- replayClass

test('replayClass：严格按 移除→读 offsetWidth（reflow）→添加 的序列执行', () => {
    const { replayClass } = A(loadCommon());
    const ops = [];
    const el = makeEl(['tab-enter']);
    el.classList = {
        _s: new Set(['tab-enter']),
        remove(c) { ops.push(`remove:${c}`); this._s.delete(c); },
        add(c) { ops.push(`add:${c}`); this._s.add(c); },
        contains(c) { return this._s.has(c); },
    };
    Object.defineProperty(el, 'offsetWidth', { get() { ops.push('reflow'); return 123; } });
    replayClass(el, 'tab-enter');
    assert.deepEqual(ops, ['remove:tab-enter', 'reflow', 'add:tab-enter'],
        '必须先移除，再借读 offsetWidth 强制 reflow，最后重挂——顺序错则动画不重启');
    assert.ok(el.classList.contains('tab-enter'), '结束时类已重新挂上');
});

test('replayClass：同名移除后重挂（含 reflow 步骤），无关类不受影响', () => {
    const { replayClass } = A(loadCommon());
    const el = makeEl(['a', 'b']);
    const hadA = el.classList.contains('a');
    const reflowReads = [];
    Object.defineProperty(el, 'offsetWidth', { get() { reflowReads.push(1); return 7; } });
    replayClass(el, 'a');
    assert.ok(hadA && el.classList.contains('a'), '同名移除后重挂（remove 与 add 之间读了 offsetWidth）');
    assert.ok(el.classList.contains('b'), '无关类不受影响');
    assert.ok(!el.classList.contains('zz'), '未涉及的类不被引入');
    assert.equal(reflowReads.length, 1, '恰好一次 reflow 读');
});

// ---------------------------------------------------------------- motionAllowed 三态

test('motionAllowed：三条件全放行（开关开/无 reduced-motion/非毛玻璃）时为 true', () => {
    const { motionAllowed } = A(loadCommon({ animEnabled: true, reducedMotion: false, glassOn: false }));
    assert.equal(motionAllowed(), true);
});

test('motionAllowed：应用内动画开关关闭（_skin.animEnabled=false）即 false', () => {
    const ctx = loadCommon({ animEnabled: true });
    const api = A(ctx);
    assert.equal(api.motionAllowed(), true);
    vm.runInContext('globalThis.__setAnim(false)', ctx);
    assert.equal(api.motionAllowed(), false, '开关关（applySkin 同步落 html.no-anim 的同一状态源）');
    vm.runInContext('globalThis.__setAnim(true)', ctx);
    assert.equal(api.motionAllowed(), true);
});

test('motionAllowed：系统 prefers-reduced-motion: reduce 即 false（matchMedia 桩命中）', () => {
    const { motionAllowed } = A(loadCommon({ reducedMotion: true }));
    assert.equal(motionAllowed(), false);
});

test('motionAllowed：html.glass-on（毛玻璃进行中）即 false', () => {
    const { motionAllowed } = A(loadCommon({ glassOn: true }));
    assert.equal(motionAllowed(), false);
});

test('motionAllowed：三条件同时为真仍为 false（不叠加、不抛错）', () => {
    const ctx = loadCommon({ animEnabled: false, reducedMotion: true, glassOn: true });
    const api = A(ctx);
    assert.equal(api.motionAllowed(), false, '任一为真即禁动，三真亦只禁动');
});

// ---------------------------------------------------------------- 错峰常量与序列

test('错峰常量：STAGGER_STEP_MS=45、STAGGER_MAX_IDX=7（45ms/第 8 张起封顶 315ms）', () => {
    const api = A(loadCommon());
    assert.equal(api.STAGGER_STEP_MS, 45);
    assert.equal(api.STAGGER_MAX_IDX, 7);
    assert.equal(api.STAGGER_MAX_IDX * api.STAGGER_STEP_MS, 315);
});

test('playCardsEnter：延迟序列与常量一致——前 8 张递增、第 9 张起封顶 7×45ms', () => {
    const api = A(loadCommon());
    const box = makeEl();
    const reflows = [];
    Object.defineProperty(box, 'offsetWidth', { get() { reflows.push(1); return 100; } });
    const cards = Array.from({ length: 10 }, () => makeEl(['vod-card']));
    box._children = cards;
    api.playCardsEnter(box);
    const expected = cards.map((_, i) => `${Math.min(i, api.STAGGER_MAX_IDX) * api.STAGGER_STEP_MS}ms`);
    assert.deepEqual(cards.map((c) => c.style.animationDelay), expected);
    assert.equal(cards[7].style.animationDelay, '315ms');
    assert.equal(cards[8].style.animationDelay, '315ms', 'idx=8 仍压在 7×45ms');
    assert.equal(cards[9].style.animationDelay, '315ms', 'idx=9 仍压在 7×45ms');
    assert.ok(box._classes.has('cards-enter'));
    assert.equal(reflows.length, 1, 'playCardsEnter 内恰好一次 reflow（replayClass 收口）');
});

test('stageAppendedCards：批内序号同样走常量（0/45/90…，封顶 315ms）', () => {
    const api = A(loadCommon());
    const box = makeEl();
    const oldCards = Array.from({ length: 8 }, () => makeEl(['vod-card']));
    const newCards = Array.from({ length: 9 }, () => makeEl(['vod-card']));
    box._children = [...oldCards, ...newCards];
    api.stageAppendedCards(box, 8);
    assert.deepEqual(newCards.map((c) => c.style.animationDelay),
        ['0ms', '45ms', '90ms', '135ms', '180ms', '225ms', '270ms', '315ms', '315ms']);
    assert.ok(oldCards.every((c) => c.style.animationDelay === undefined), '旧卡不重播');
    assert.ok(box._classes.has('cards-enter'), '首挂补 cards-enter 类');
});
