'use strict';
// A：封面放大浮层「按住拖动平移」。VM 桩沿用 cover-float-toolbar.test.js 的极简 DOM
// 面（只提供 #cover-float 首建路径所需接口），本文件额外给 img 桩加 pointer 捕获桩。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

function mkEl(tag) {
    const el = {
        tag, id: '', style: {}, listeners: {}, children: [], _html: '',
        classList: {
            _set: new Set(),
            add(...k) { k.forEach((x) => this._set.add(x)); },
            remove(...k) { k.forEach((x) => this._set.delete(x)); },
            contains(k) { return this._set.has(k); },
        },
        addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
        appendChild(c) { el.children.push(c); return c; },
        removeAttribute() {},
        setAttribute(k, v) { el['attr_' + k] = v; },
        getAttribute(k) { return el['attr_' + k] === undefined ? null : el['attr_' + k]; },
        querySelector(sel) {
            if (sel === 'img') return el._img || null;
            if (sel === '.cover-float-toolbar button') return el._btn || null;
            return null;
        },
        closest() { return null; },
    };
    if (tag === 'div') el._img = mkImg();
    return el;
}

function mkImg() {
    const el = {
        tag: 'img', style: {}, _imgEv: {}, _captured: [],
        removeAttribute() {},
        setAttribute(k, v) { el['attr_' + k] = v; },
        getAttribute(k) { return el['attr_' + k] === undefined ? null : el['attr_' + k]; },
        addEventListener(type, fn) { (el._imgEv[type] = el._imgEv[type] || []).push(fn); },
        removeEventListener(type, fn) {
            const arr = el._imgEv[type];
            if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
        },
        setPointerCapture(id) { el._captured.push(id); },
        releasePointerCapture(id) {
            const i = el._captured.indexOf(id);
            if (i >= 0) el._captured.splice(i, 1);
        },
    };
    Object.defineProperty(el, 'src', {
        configurable: true,
        get() { return el.attr_src || ''; },
        set(v) { el.attr_src = String(v); },
    });
    const cls = new Set();
    el.classList = {
        add(...k) { k.forEach((x) => cls.add(x)); },
        remove(...k) { k.forEach((x) => cls.delete(x)); },
        contains(k) { return cls.has(k); },
        _set: cls,
    };
    return el;
}

function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, URL,
        parseInt, parseFloat, setTimeout, clearTimeout, setInterval, clearInterval,
        navigator: {},
        document: {
            _els: {},
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: {
                classList: { contains() { return false; } },
                children: [],
                appendChild(c) { this.children.push(c); if (c.id) this._byId[c.id] = c; },
                _byId: {},
            },
            getElementById(id) { return this.body._byId[id] || null; },
            createElement(tag) { return mkEl(tag); },
        },
        $: () => ({ on() { return this; }, off() { return this; }, html() { return this; }, find() { return this; }, length: 0 }),
        registerEsc: () => {}, staggerEnter: () => {}, replayClass: () => {},
        escHtml: (s) => String(s), stripHtml: (s) => String(s || ''),
        warnToast: (m) => { context._toasts.push(m); },
        showLoading() {}, hideLoading() {},
        bangumiCover: () => '', vodCoverImg: () => '', normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        localCacheGet: () => null, localCacheSet: () => {}, localCacheDel: () => {},
        openDialog: () => {}, closeDialog: () => {},
        fmtCommentTimeFull: () => '', commentTsMs: () => 0,
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
        _toasts: [],
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    return { Detail: vm.runInContext('Detail', context), context };
}

/** 首次 _openCoverFloat 走真实创建分支（监听器只在首建时绑定），再把 wrap 接管。 */
function bootstrapFloat(context, Detail) {
    Detail._openCoverFloat('https://example.com/_boot.jpg');
    const wrap = context.document.body.children[context.document.body.children.length - 1];
    wrap.querySelector = (sel) => (sel === 'img' ? wrap._img : (sel.startsWith('.cover-float-toolbar') && wrap._btn) || null);
    return wrap;
}

/** pointer 事件桩：默认鼠标左键、目标为空（非工具栏）。 */
function pEv(o) {
    return Object.assign({
        pointerId: 1, clientX: 0, clientY: 0, button: 0, pointerType: 'mouse',
        _pd: false,
        preventDefault() { this._pd = true; },
        target: { closest: () => null },
    }, o);
}
const fire = (wrap, type, ev) => wrap.listeners[type].forEach((fn) => fn(ev));

// ---------------------------------------------------------------- transform 单一出口

test('_applyCoverFloatTransform：平移/旋转/缩放合成同一条 transform（单一出口）', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._coverZoom = 1.5;
    Detail._coverRotate = 90;
    Detail._coverPanX = 12;
    Detail._coverPanY = -34;
    Detail._applyCoverFloatTransform();
    assert.equal(wrap._img.style.transform, 'translate(12px, -34px) rotate(90deg) scale(1.5)');
    // 复原为 0 平移时不残留旧值（每次都是全量 compose，不是增量拼接）
    Detail._coverPanX = 0; Detail._coverPanY = 0;
    Detail._applyCoverFloatTransform();
    assert.equal(wrap._img.style.transform, 'translate(0px, 0px) rotate(90deg) scale(1.5)');
});

// ---------------------------------------------------------------- 拖动

test('拖动：超过阈值才位移，位移=指针增量且与缩放/旋转叠加；松手摘捕获与 grabbing 态', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/a.jpg');
    Detail._coverZoom = 2;
    Detail._coverRotate = 90;

    fire(wrap, 'pointerdown', pEv({ clientX: 100, clientY: 100 }));
    assert.deepEqual(wrap._img._captured, [1], 'pointerdown 后对 img 建立指针捕获');
    // 阈值内（<4px）不位移、不算拖动
    fire(wrap, 'pointermove', pEv({ clientX: 102, clientY: 101 }));
    assert.equal(Detail._coverPanX, 0);
    assert.equal(Detail._coverPanY, 0);
    assert.ok(!wrap._img.classList.contains('dragging'));
    assert.equal(Detail._coverDragMoved, false, '未过阈值不算拖动（用于区分点击）');
    // 过阈值：位移按指针总增量，且 transform 里同时保留旋转/缩放
    fire(wrap, 'pointermove', pEv({ clientX: 130, clientY: 70 }));
    assert.equal(Detail._coverPanX, 30);
    assert.equal(Detail._coverPanY, -30);
    assert.ok(wrap._img.classList.contains('dragging'), '拖动中挂 grabbing 态类');
    assert.equal(Detail._coverDragMoved, true);
    assert.equal(wrap._img.style.transform, 'translate(30px, -30px) rotate(90deg) scale(2)');
    // 松手：摘捕获、摘 grabbing 态，位移保留（图片停在用户拖到的位置）
    fire(wrap, 'pointerup', pEv({ clientX: 130, clientY: 70 }));
    assert.deepEqual(wrap._img._captured, [], 'pointerup 释放指针捕获');
    assert.ok(!wrap._img.classList.contains('dragging'));
    assert.equal(Detail._coverPanX, 30);
    // 后续 pointermove（无按下）不再位移
    fire(wrap, 'pointermove', pEv({ clientX: 300, clientY: 300 }));
    assert.equal(Detail._coverPanX, 30);
});

test('拖动：pointerdown 阻止默认行为（禁原生拖拽/选中）；pointercancel 收尾；非左键不拖', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/a.jpg');

    // 中键/右键（未按下左键时）：交给原生菜单与右键保存，不进入拖动
    fire(wrap, 'pointerdown', pEv({ button: 2, clientX: 10, clientY: 10 }));
    fire(wrap, 'pointermove', pEv({ button: 2, clientX: 90, clientY: 90 }));
    assert.equal(Detail._coverPanX, 0, '右键不产生平移');
    assert.equal(Detail._coverDragMoved, false);

    const down = pEv({ clientX: 10, clientY: 10 });
    fire(wrap, 'pointerdown', down);
    assert.equal(down._pd, true, 'pointerdown preventDefault（禁原生图片拖拽/文本选择）');

    // 拖动中再按其它键：不重新锚定（位移沿用首次按下的锚点，图片不跳变）
    fire(wrap, 'pointermove', pEv({ clientX: 30, clientY: 10 }));
    assert.equal(Detail._coverPanX, 20);
    fire(wrap, 'pointerdown', pEv({ button: 2, clientX: 30, clientY: 10 }));
    fire(wrap, 'pointermove', pEv({ clientX: 60, clientY: 10 }));
    assert.equal(Detail._coverPanX, 50, '拖动中的第二次按下不重锚（增量为连续 50 而非 30）');

    // pointercancel 收尾：摘捕获、摘 grabbing 态、后续 move 不跟手
    fire(wrap, 'pointercancel', pEv({ clientX: 60, clientY: 10 }));
    assert.deepEqual(wrap._img._captured, [], 'pointercancel 同样释放捕获');
    assert.ok(!wrap._img.classList.contains('dragging'));
    fire(wrap, 'pointermove', pEv({ clientX: 200, clientY: 10 }));
    assert.equal(Detail._coverPanX, 50, 'cancel 后不再跟手');
});

test('拖动：触摸/笔指针同样可拖（pointerType 非 mouse 不要求左键）', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/a.jpg');
    fire(wrap, 'pointerdown', pEv({ pointerType: 'touch', button: -1, clientX: 0, clientY: 0 }));
    fire(wrap, 'pointermove', pEv({ pointerType: 'touch', button: -1, clientX: 20, clientY: 5 }));
    assert.equal(Detail._coverPanX, 20, '触摸拖动不被 button 判定卡死');
    assert.equal(Detail._coverPanY, 5);
});

test('拖动：工具栏区域按下不进入拖动（按钮交互不受影响）', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/a.jpg');
    fire(wrap, 'pointerdown', pEv({ target: { closest: (s) => (s === '.cover-float-toolbar' ? {} : null) } }));
    fire(wrap, 'pointermove', pEv({ clientX: 99, clientY: 99 }));
    assert.equal(Detail._coverPanX, 0, '工具栏上按下不产生平移');
    assert.equal(Detail._coverDragMoved, false);
});

// ---------------------------------------------------------------- 与点击/复位/缩放的关系

test('拖动后松手不判为「点遮罩关闭」；下一次真正的点击仍能关闭', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/a.jpg');
    fire(wrap, 'pointerdown', pEv({ clientX: 0, clientY: 0 }));
    fire(wrap, 'pointermove', pEv({ clientX: 40, clientY: 40 }));
    fire(wrap, 'pointerup', pEv({ clientX: 40, clientY: 40 }));
    // 拖动后紧跟的 click（有些环境会落到遮罩上）不得关闭浮层
    const maskClick = wrap.listeners.click[0];
    maskClick({ target: { closest: () => null } });
    assert.ok(!wrap.classList.contains('float-out'), '拖动后松手不关闭浮层');
    // 标记只吃一次：随后的普通点击照常关闭
    maskClick({ target: { closest: () => null } });
    assert.ok(wrap.classList.contains('float-out'), '普通点击遮罩仍关闭');
});

test('_resetCoverFloatTransform：复位同时清平移与拖动态；重开新图不残留平移', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/a.jpg');
    fire(wrap, 'pointerdown', pEv({ clientX: 0, clientY: 0 }));
    fire(wrap, 'pointermove', pEv({ clientX: 50, clientY: 60 }));
    assert.ok(wrap._img.classList.contains('dragging'));
    Detail._resetCoverFloatTransform();
    assert.equal(Detail._coverPanX, 0);
    assert.equal(Detail._coverPanY, 0);
    assert.equal(Detail._coverZoom, 1);
    assert.equal(Detail._coverRotate, 0);
    assert.equal(Detail._coverDragMoved, false);
    assert.ok(!wrap._img.classList.contains('dragging'), '复位摘除 grabbing 态');
    assert.equal(wrap._img.style.transform, '', '复位清空内联 transform');
    // 拖动后再打开另一张图（_openCoverFloat 内部会调复位）：平移不跨图残留
    fire(wrap, 'pointerdown', pEv({ clientX: 0, clientY: 0 }));
    fire(wrap, 'pointermove', pEv({ clientX: 80, clientY: 0 }));
    Detail._openCoverFloat('https://example.com/b.jpg');
    assert.equal(Detail._coverPanX, 0);
    assert.equal(Detail._coverPanY, 0);
});

test('滚轮缩放与拖动共用同一状态源：缩放后 transform 仍带平移，反之亦然', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/a.jpg');
    fire(wrap, 'pointerdown', pEv({ clientX: 0, clientY: 0 }));
    fire(wrap, 'pointermove', pEv({ clientX: 20, clientY: 0 }));
    const wheelHandler = wrap.listeners.wheel[0];
    wheelHandler({ deltaY: -1, preventDefault() {}, stopPropagation() {} });
    assert.match(wrap._img.style.transform, /^translate\(20px, 0px\) rotate\(0deg\) scale\(1\.12/);
    assert.equal(Detail._coverZoom > 1, true);
});

// ---------------------------------------------------------------- 源码/样式锚点

test('锚点：img 禁用原生拖拽、样式板块含 grab/grabbing 与 touch-action', () => {
    const src = read('src/renderer/js/detail.js');
    assert.match(src, /<img draggable="false" referrerpolicy="no-referrer" alt="">/, 'img 带 draggable=false');
    assert.match(src, /addEventListener\('pointerdown'/, '绑定 pointerdown');
    assert.match(src, /setPointerCapture/, '使用 setPointerCapture');
    const css = read('src/renderer/css/ui.css');
    assert.match(css, /\.cover-float-stage \{[^}]*cursor:grab;/, 'stage 握持光标');
    // 拖动中必须摘掉 transform 过渡，且选择器权重不得低于 #cover-float img.loaded
    // （后者也声明 transition）：单写 .dragging 会被 .loaded 盖掉 → 每帧 transform 都被
    // 150ms 过渡追尾，实测就是「拖动卡顿、图跟不上指针」
    assert.match(css, /#cover-float img\.dragging,\s*#cover-float img\.loaded\.dragging \{ cursor:grabbing; transition:none;/,
        '拖动中 grabbing 光标且摘掉 transform 过渡（1:1 跟手，权重压过 .loaded）');
    assert.match(css, /\.cover-float-stage \{[^}]*touch-action:none;/, 'stage touch-action:none（触摸拖动不被浏览器手势抢走）');
});
