'use strict';
// 划词翻译（translate-bubble.js）纯逻辑单测：
//   - bubblePointForRect：选区锚点 → 气泡视口坐标（下方 8px / 翻转 / clamp）
//   - pickSelectionText：折叠/短文本/输入框内不触发
//   - shouldSuppressClick：选区非折叠吞 click（防划选卡片误导航）
//   - createDeduper：3 秒窗口去重 + 时间戳刷新
//   - buildTranslatePayload：/translate 请求体契约（LLM 字段按设置注入）
//   - mouseup 运行时路径（带 document/window 桩让 init() 执行）：设置闸门
//     （缺 translateEnable 键默认关）、去重登记时机（闸门外不烧窗口）、
//     气泡身份（旧划词的失败响应不移动新气泡）
// VM 加载（bgm-rate.test.js 同款沙箱），不触碰真实 DOM/网络。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 在 VM 中加载 translate-bubble.js（禁用自动 init：无 document 桩）。 */
function loadTranslate() {
    const source = read('src/renderer/js/translate-bubble.js');
    const context = {
        console, Math, Date, JSON, String, Array, Object, Number, Map, Promise,
        setTimeout, clearTimeout,
        navigator: {},
    };
    context.globalThis = context;
    context.window = undefined; // 模块走 globalThis 分支；root.document 缺失则不 init
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__R = YukiTranslate;`, context, { filename: 'translate-bubble.js' });
    return context.__R;
}

test('bubblePointForRect：默认放选区下方 8px', () => {
    const R = loadTranslate();
    const pt = R.bubblePointForRect({ left: 100, top: 50, bottom: 70, right: 140 }, 200, 100, 1000, 800);
    assert.equal(pt.left, 100);
    assert.equal(pt.top, 78);
});

test('bubblePointForRect：下方放不下翻到上方', () => {
    const R = loadTranslate();
    // 选区底 750 + 8 + 高 100 = 858 > 800 → top = 600-100-8 = 492
    const pt = R.bubblePointForRect({ left: 100, top: 600, bottom: 750, right: 140 }, 200, 100, 1000, 800);
    assert.equal(pt.top, 492);
});

test('bubblePointForRect：左右 clamp 进视口（8px 边距）', () => {
    const R = loadTranslate();
    // 越左
    const left = R.bubblePointForRect({ left: -50, top: 10, bottom: 30, right: 0 }, 200, 100, 1000, 800);
    assert.equal(left.left, 8);
    // 越右：vw(1000) - w(200) - 8 = 792
    const right = R.bubblePointForRect({ left: 950, top: 10, bottom: 30, right: 990 }, 200, 100, 1000, 800);
    assert.equal(right.left, 792);
    // 上下也 clamp：top ≥ 8、top ≤ vh - h - 8
    const clamped = R.bubblePointForRect({ left: 100, top: 0, bottom: 0, right: 140 }, 200, 100, 1000, 800);
    assert.ok(clamped.top >= 8 && clamped.top <= 692, clamped.top);
});

test('pickSelectionText：非折叠 ≥2 字符才触发；输入框内不触发', () => {
    const R = loadTranslate();
    const sel = (text, collapsed) => ({ isCollapsed: collapsed, toString: () => text });
    assert.equal(R.pickSelectionText(sel('你好世界', false), null, null), '你好世界');
    assert.equal(R.pickSelectionText(sel('h', false), null, null), null);       // <2 字符
    assert.equal(R.pickSelectionText(sel('', false), null, null), null);        // 空文本
    assert.equal(R.pickSelectionText(sel('abc', true), null, null), null);      // 折叠选区
    assert.equal(R.pickSelectionText(null, null, null), null);
    // anchor 落在 input 内 → 编辑行为，不划词（isEditable 传完整选择器串，按 includes 判定）
    const inputLike = { closest: (s) => (String(s).includes('input') ? {} : null) };
    assert.equal(R.pickSelectionText(sel('你好世界', false), inputLike, null), null);
    const plain = { closest: () => null };
    assert.equal(R.pickSelectionText(sel('你好世界', false), plain, plain), '你好世界');
});

test('shouldSuppressClick：选区内点击吞（防误导航），选区外点击放行', () => {
    const R = loadTranslate();
    // 无坐标（旧口径/沙箱）：非折叠即吞
    assert.equal(R.shouldSuppressClick({ isCollapsed: false, toString: () => '选中文字' }), true);
    assert.equal(R.shouldSuppressClick({ isCollapsed: true, toString: () => '' }), false);
    assert.equal(R.shouldSuppressClick(null), false);
    // 有坐标：仅点击落在选区矩形（±6px 容差）内才吞——划选后点其他 UI 不再被卡
    const sel = {
        isCollapsed: false, rangeCount: 1,
        toString: () => '选中文字',
        getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 100, top: 50, right: 200, bottom: 70, width: 100, height: 20 }) }),
    };
    assert.equal(R.shouldSuppressClick(sel, 150, 60), true);   // 选区内
    assert.equal(R.shouldSuppressClick(sel, 104, 54), true);   // 容差边缘内
    assert.equal(R.shouldSuppressClick(sel, 300, 60), false);  // 选区右侧远处
    assert.equal(R.shouldSuppressClick(sel, 150, 300), false); // 选区下方远处
    assert.equal(R.shouldSuppressClick(sel, 150, 77), false);  // 容差外（bottom+7）
    assert.equal(R.shouldSuppressClick(sel, 93, 60), false);   // 容差外（left-7）
    // 无 range 退化旧口径：非折叠即吞（不可得矩形时保守拦截）
    const noRange = { isCollapsed: false, rangeCount: 0, toString: () => '选中文字' };
    assert.equal(R.shouldSuppressClick(noRange, 150, 60), true);
});

test('拦截豁免：气泡 UI 内点击放行（✕/译/复制不受防误导航拦截影响）', () => {
    const R = loadTranslate();
    // 拦截器在调用 shouldSuppressClick 前先 isInsideOurUI 放行气泡自身 UI——
    // 点 ✕/译 不折叠选区，不豁免则按钮 click 被 document 捕获拦截（关闭失效 bug）。
    // isInsideOurUI 未导出，此处用 closest 桩复现拦截器两段式判定。
    const inUi = { closest: (s) => (String(s).includes('data-yuki-tr-ui') ? {} : null) };
    const outside = { closest: () => null };
    const sel = {
        isCollapsed: false, rangeCount: 1,
        toString: () => '选中文字',
        getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 100, top: 50, right: 200, bottom: 70, width: 100, height: 20 }) }),
    };
    const suppress = (target, x, y) => {
        const inside = !!target && typeof target.closest === 'function' && !!target.closest('[data-yuki-tr-ui]');
        if (inside) return false;
        return R.shouldSuppressClick(sel, x, y);
    };
    assert.equal(suppress(inUi, 150, 60), false);    // 气泡内：放行（✕/译 修复点）
    assert.equal(suppress(outside, 150, 60), true);  // 气泡外且落在选区：吞掉
    assert.equal(suppress(outside, 500, 500), false); // 气泡外但远离选区：放行
});

test('createDeduper：窗口内重复 seen；窗口过期后放行', () => {
    const R = loadTranslate();
    let now = 1000;
    const d = R.createDeduper(() => now);
    assert.equal(d.seen('文本A'), false);       // 首次登记
    assert.equal(d.seen('文本B'), false);
    assert.equal(d.seen('文本A'), true);        // 窗口内重复
    now += 2999;
    assert.equal(d.seen('文本A'), true);        // 仍在 3s 窗口内
    now += 4000;
    assert.equal(d.seen('文本A'), false);       // 已过期放行
});

test('buildTranslatePayload：/translate 请求体契约', () => {
    const R = loadTranslate();
    // 默认：免费通道，无 llm 字段
    const p1 = R.buildTranslatePayload('hello', { translateTarget: 'zh-TW' });
    assert.equal(p1.body.text, 'hello');
    assert.equal(p1.body.to, 'zh-TW');
    assert.equal(p1.target, 'zh-TW');
    // 未设置目标语言 → 默认 zh-CN
    const p2 = R.buildTranslatePayload('hello', {});
    assert.equal(p2.body.to, 'zh-CN');
    // LLM 开启：prefer=llm + 凭据注入（后端不持久存，按次传入）
    const p3 = R.buildTranslatePayload('hello', {
        translateLLMEnable: true, translateLLMBase: 'https://x.com/v1',
        translateLLMKey: 'sk-1', translateLLMModel: 'gpt-x',
    });
    assert.equal(p3.body.prefer, 'llm');
    assert.equal(p3.body.llm.base, 'https://x.com/v1');
    assert.equal(p3.body.llm.key, 'sk-1');
    assert.equal(p3.body.llm.model, 'gpt-x');
    // LLM 关闭：不带 llm 字段
    const p4 = R.buildTranslatePayload('hello', { translateLLMEnable: false });
    assert.equal(p4.body.prefer, undefined);
    // 超长截断到 5000
    const p5 = R.buildTranslatePayload('a'.repeat(6000), {});
    assert.equal(p5.body.text.length, 5000);
});

test('placeFixedInViewport：rect 全 0（无布局）时直接按视口坐标写', () => {
    const R = loadTranslate();
    // 构造最小 DOM 桩：rect 恒 0 → 走"量不到映射直接写"分支
    const el = { style: {}, parentElement: null, getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }) };
    const html = { appendChild: (c) => { c.parentElement = html; } };
    const doc = { documentElement: html };
    const out = R.placeFixedInViewport(el, 120, 88, doc);
    assert.equal(el.style.left, '120px');
    assert.equal(el.style.top, '88px');
    assert.equal(out.left, 120);
    assert.equal(out.top, 88);
});

test('placeFixedInViewport：缩放失真（zoom）下反解仿射映射', () => {
    const R = loadTranslate();
    // zoom = 0.5：本地坐标 v 渲染在视口 v*0.5 处（元素恒有尺寸，不触发全 0 早退）
    let cur = 0;
    const el = {
        style: {},
        parentElement: null,
        getBoundingClientRect() {
            return { width: 10, height: 10, left: cur * 0.5, top: cur * 0.5 };
        },
    };
    const html = {
        appendChild: (c) => { c.parentElement = html; },
        // 读取 style.left/top 时的映射：写 '100px' → cur=100；写 '0px' → cur=0
        get hook() { return null; },
    };
    const doc = { documentElement: html };
    // style 代理：getBoundingClientRect 依赖 cur 跟随 style.left 的写入
    Object.defineProperty(el.style, 'left', {
        set(v) { cur = parseFloat(v) || 0; this._l = v; },
        get() { return this._l || '0px'; },
    });
    Object.defineProperty(el.style, 'top', {
        set(v) { this._t = v; },
        get() { return this._t || '0px'; },
    });
    R.placeFixedInViewport(el, 200, 140, doc);
    // 期望视口 200：本地坐标 = (200 - o.left)/kx，o.left=0、kx=0.5 → 400
    assert.equal(el.style.left, '400px');
    assert.equal(el.style.top, '280px');
});

// ------------------------------------------------------------------ 运行时路径
// 带 document/window 桩加载模块让 init() 真正执行，走完整 mouseup 链路：
// settings/fetch/selection 全部打桩（不触碰真实 DOM/网络），setTimeout 充当
// 宏任务冲刷点——await 链上所有立即完成的微任务在 flush() 前排空。

const flushTasks = () => new Promise((resolve) => setTimeout(resolve, 0));

const RECT_A = { left: 100, top: 50, right: 140, bottom: 70, width: 40, height: 20 };
const RECT_B = { left: 300, top: 100, right: 360, bottom: 130, width: 60, height: 30 };

function makeEl(tag) {
    const el = {
        tag,
        children: [],
        style: {},
        attrs: {},
        className: '',
        textContent: '',
        innerHTML: '',
        offsetWidth: 40,
        offsetHeight: 20,
        parentElement: null,
        setAttribute(k, v) { el.attrs[k] = v; },
        addEventListener() {},
        removeEventListener() {},
        append(...cs) {
            for (const c of cs) { el.children.push(c); if (c && typeof c === 'object') c.parentElement = el; }
        },
        prepend(...cs) {
            el.children.unshift(...cs);
            for (const c of cs) if (c && typeof c === 'object') c.parentElement = el;
        },
        appendChild(c) { el.children.push(c); c.parentElement = el; return c; },
        remove() {
            const p = el.parentElement;
            if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); el.parentElement = null; }
        },
        closest() { return null; },
        contains() { return false; },
        querySelector() { return null; },
        getBoundingClientRect() { return { width: 40, height: 20, left: 0, top: 0, right: 40, bottom: 20 }; },
        classList: { add() {}, remove() {} },
    };
    return el;
}

function loadTranslateRuntime() {
    const state = { settings: {} };
    const docL = {};
    const html = makeEl('html');
    const documentStub = {
        addEventListener(type, fn) { (docL[type] = docL[type] || []).push(fn); },
        createElement: (tag) => makeEl(tag),
        documentElement: html,
        body: makeEl('body'),
    };
    const fetchCalls = [];
    let fetchImpl = () => Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ code: 0, text: '默认译文', provider: 'microsoft' }),
    });
    const context = {
        console, Math, Date, JSON, String, Array, Object, Number, Map, Promise,
        setTimeout, clearTimeout, AbortController,
        requestAnimationFrame: () => 1,
        navigator: {},
        apiUrl: (p) => `http://localhost${p}`,
        document: documentStub,
        innerWidth: 1000,
        innerHeight: 800,
        addEventListener() {}, // window 事件（scroll 等）不触发
        yuki: { settingsGet: () => Promise.resolve(state.settings) },
        fetch: (...args) => { fetchCalls.push(args); return fetchImpl(...args); },
    };
    context.globalThis = context;
    context.window = context; // root === window === globalThis：getSettings 走 yuki.settingsGet
    let selection = null;
    context.getSelection = () => selection;
    vm.createContext(context);
    vm.runInContext(`${read('src/renderer/js/translate-bubble.js')}\n;globalThis.__R = YukiTranslate;`, context,
        { filename: 'translate-bubble.js' });
    return {
        state, html, fetchCalls,
        setSelection(s) { selection = s; },
        setFetch(fn) { fetchImpl = fn; },
        fireMouseup: (target) => Promise.all((docL.mouseup || []).map((fn) => fn({
            target, clientX: 0, clientY: 0,
        }))),
        flush: flushTasks,
    };
}

const plainEl = () => ({ closest: () => null });

function makeSelection(text, rectRef) {
    return {
        isCollapsed: false,
        toString: () => text,
        anchorNode: { parentElement: plainEl() },
        focusNode: { parentElement: plainEl() },
        rangeCount: 1,
        // rectRef 允许传 { rect } 引用，便于用例中途更换矩形
        getRangeAt: () => ({ getBoundingClientRect: () => (rectRef && rectRef.rect) || rectRef }),
    };
}

const uiEls = (html) => html.children.filter((c) => c.attrs && 'data-yuki-tr-ui' in c.attrs);
const bodyOf = (bubble) => bubble.children.find((c) => c.className === 'yuki-tr-body');

test('mouseup 设置闸门：settings 缺 translateEnable 键（undefined）默认关——不出气泡不发请求', async () => {
    const rt = loadTranslateRuntime();
    // 全新安装：设置对象没有 translateEnable 键（undefined ≠ false），必须视为关
    rt.state.settings = { translateTrigger: 'auto', translateTarget: 'zh-CN' };
    rt.setSelection(makeSelection('第一段文本', RECT_A));
    await rt.fireMouseup(plainEl());
    await rt.flush();
    assert.equal(rt.fetchCalls.length, 0);  // 未发翻译请求
    assert.equal(uiEls(rt.html).length, 0); // 未建气泡

    // 设置页显式开启（回显口径 === true 才算开）→ 立即可触发；
    // 侧证闸门未通过的 mouseup 不烧去重窗口（否则同文本会被 3 秒去重吞掉）
    rt.state.settings = { translateEnable: true, translateTrigger: 'auto', translateTarget: 'zh-CN' };
    await rt.fireMouseup(plainEl());
    await rt.flush();
    assert.equal(rt.fetchCalls.length, 1);
    const ui = uiEls(rt.html);
    assert.equal(ui.length, 1);
    assert.equal(bodyOf(ui[0]).textContent, '默认译文');
});

test('划词 A 在途时划词 B：A 的失败响应不移动/不覆盖 B 气泡', async () => {
    const rt = loadTranslateRuntime();
    rt.state.settings = { translateEnable: true, translateTrigger: 'auto', translateTarget: 'zh-CN' };
    let rejectA;
    rt.setFetch(() => {
        if (rt.fetchCalls.length === 1) {
            return new Promise((resolve, reject) => { rejectA = reject; }); // A 在途挂起
        }
        return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ code: 0, text: '译文B', provider: 'microsoft' }),
        });
    });

    // 划词 A：请求在途
    rt.setSelection(makeSelection('文本甲', RECT_A));
    await rt.fireMouseup(plainEl());
    await rt.flush();
    assert.equal(rt.fetchCalls.length, 1);
    assert.equal(uiEls(rt.html).length, 1);

    // 划词 B：close() abort A 的请求，B 气泡接管并按自己的选区定位
    rt.setSelection(makeSelection('文本乙', RECT_B));
    await rt.fireMouseup(plainEl());
    await rt.flush();
    assert.equal(rt.fetchCalls.length, 2);
    const bubbles = uiEls(rt.html);
    assert.equal(bubbles.length, 1);
    const bubbleB = bubbles[0];
    assert.equal(bubbleB.style.left, '300px'); // RECT_B 定位（下方 8px）
    assert.equal(bubbleB.style.top, '138px');

    // A 的响应以失败收场（close() 触发 abort 的 reject 形态）
    rejectA(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await rt.flush();
    // A 的 catch 必须识别「气泡已换人」（bubbleEl === parts.el 身份判断）：
    // 不把 B 挪到 A 的旧选区位置、不写 B 的正文
    assert.equal(bubbleB.style.left, '300px');
    assert.equal(bubbleB.style.top, '138px');
    assert.equal(bodyOf(bubbleB).textContent, '译文B');
});

test('mouseup 闸门：rect 无效的 mouseup 不烧去重窗口；窗口内重复同文本仍只触发一次', async () => {
    const rt = loadTranslateRuntime();
    rt.state.settings = { translateEnable: true, translateTrigger: 'auto', translateTarget: 'zh-CN' };
    const rectRef = { rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } };
    rt.setSelection(makeSelection('第三段文本', rectRef));
    await rt.fireMouseup(plainEl());
    await rt.flush();
    assert.equal(rt.fetchCalls.length, 0); // rect 无效：不触发

    // 选区恢复有效：同文本立即可触发（rect 无效的 mouseup 未占用 3 秒去重窗口）
    rectRef.rect = { left: 100, top: 50, right: 140, bottom: 70, width: 40, height: 20 };
    await rt.fireMouseup(plainEl());
    await rt.flush();
    assert.equal(rt.fetchCalls.length, 1);
    assert.equal(uiEls(rt.html).length, 1);

    // 连划去重语义保留：3 秒窗口内重复 mouseup 同文本不再发请求
    await rt.fireMouseup(plainEl());
    await rt.flush();
    assert.equal(rt.fetchCalls.length, 1);
});
