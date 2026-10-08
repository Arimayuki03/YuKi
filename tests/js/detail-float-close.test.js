'use strict';
// A-32 封面放大/角色浮层关闭闪烁修复回归测试（第二轮）：
// 1) 初版根因：_hideDetailFloat 定时器到期同帧 classList.remove('show', 'float-out')——
//    .float-out 一摘，floatOut both 的末态（opacity:0）随之丢失，面板在遮罩基态
//    opacity 过渡淡出半途闪回不透明再二次淡出，视觉上「消失→闪现→再淡出」。
// 2) 第二轮：初版修复把复位拆成两档嵌套定时器（先摘 .show，再等一档才摘 .float-out），
//    但 CSS 过渡/动画比类变更晚一帧起播，定时器按语句时刻计，第二档仍可能抢在遮罩
//    淡出收尾前摘类——闪烁窗口依旧存在（帧偏移竞态，无法用固定延时消除）。
// 3) 终版修复（对齐 closeDialog 的 .dlg-out 手法）：退场末态 opacity:0 显式固化在
//    ui.css 的 #cover-float.float-out / #char-float.float-out 规则上，关闭链路绝不
//    摘 .float-out（复位统一收口在 _showDetailFloat 重开时）——末态不再依赖动画
//    填充保活，定时器与过渡的帧偏移无关紧要。
// 覆盖面：_hideDetailFloat 是封面放大（cover-float）与角色详情（char-float）两个
// 浮层共用的关闭链路，本测试一次覆盖两处。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('src/renderer/js/detail.js');
const CSS = read('src/renderer/css/ui.css');

// ---------- 1) 源码锚点：单档定时器 + 末态固化在 CSS 类上 ----------

test('A-32 源码锚点：_hideDetailFloat 不再摘 .float-out（复位收口在 _showDetailFloat）', () => {
    const fn = SRC.match(/_hideDetailFloat\(el\) \{[\s\S]*?\n    \},/);
    assert.ok(fn, '应存在 _hideDetailFloat');
    assert.ok(!/remove\('float-out'\)|remove\("float-out"\)/.test(fn[0]),
        '_hideDetailFloat 内不得摘 .float-out（末态固化在 CSS 类上，摘类即闪回）');
    assert.ok(/classList\.remove\('show'\)/.test(fn[0]), '到期只摘 .show');
    // 复位唯一收口：_showDetailFloat 重开时清退场遗留
    const show = SRC.match(/_showDetailFloat\(el\) \{[\s\S]*?\n    \},/);
    assert.ok(show && /classList\.remove\('float-out'\)/.test(show[0]),
        '_showDetailFloat 应摘 .float-out 复位末态');
});

test('A-32 源码锚点：floatOut 末态 opacity:0 固化在 ui.css 的 .float-out 规则上', () => {
    // 遮罩末态：摘 .show 后淡出由显式 opacity:0 承接，不依赖动画填充
    assert.ok(/#cover-float\.float-out\s*\{[^}]*opacity:0/.test(CSS),
        '#cover-float.float-out 应显式 opacity:0');
    assert.ok(/#char-float\.float-out\s*\{[^}]*opacity:0/.test(CSS),
        '#char-float.float-out 应显式 opacity:0');
    assert.ok(/const FLOAT_OUT_MS = 150;/.test(SRC), 'FLOAT_OUT_MS 应为 150ms');
    assert.ok(/--dur-fast:\s*150ms;/.test(CSS), 'ui.css --dur-fast 应为 150ms（遮罩淡出与面板退场同速）');
    assert.ok(/_hideDetailFloat/.test(CSS), 'ui.css floatOut 注释应互指 detail.js _hideDetailFloat');
});

// ---------- 2) VM 行为：单档复位 + 重开清遗留 ----------

/** 可控假定时器：step() 一次触发一档到期定时器，返回该档时长（无 pending 返回 0）。 */
function makeTimers() {
    let seq = 0;
    const pending = new Map();
    return {
        setTimeout(fn, ms) { const id = ++seq; pending.set(id, { fn, ms: ms || 0 }); return id; },
        clearTimeout(id) { pending.delete(id); },
        step() {
            if (!pending.size) return 0;
            const [id, t] = [...pending.entries()].sort((a, b) => a[1].ms - b[1].ms)[0];
            pending.delete(id);
            t.fn();
            return t.ms;
        },
        pendingCount: () => pending.size,
    };
}

/** 最小 classList 桩（Set 底座）。 */
function makeFloatEl() {
    const set = new Set();
    return { _set: set, classList: {
        contains: (c) => set.has(c),
        add: (...cs) => cs.forEach((c) => set.add(c)),
        remove: (...cs) => cs.forEach((c) => set.delete(c)),
    } };
}

/** 在 VM 中加载 detail.js（最小桩，手法照抄 detail-refresh.test.js），假定时器注入 context。 */
function loadDetail(timers) {
    const context = {
        console: { warn: () => {}, log: () => {}, error: () => {} },
        Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, URL,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: () => null,
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: () => ({ on() { return this; }, off() { return this; }, find() { return this; }, each() { return this; }, html() { return this; }, text() { return this; }, addClass() { return this; }, removeClass() { return this; }, attr() { return this; }, prop() { return this; }, data() { return undefined; }, css() { return this; }, not() { return this; }, is() { return false; }, toggle() { return this; }, hide() { return this; }, show() { return this; }, remove() { return this; }, closest() { return this; }, length: 1 }),
        registerEsc: () => {}, escHtml: (s) => String(s), stripHtml: (s) => String(s || ''),
        warnToast: () => {}, showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '', vodCoverImg: () => '<img src="cover.jpg">',
        normalizePic: (p) => p || '', abortCoverFill: () => {},
        localCacheGet: () => null, localCacheSet: () => {}, localCacheDel: () => {},
        openDialog: () => {}, closeDialog: () => {},
        doAction: async () => ({ list: [] }),
        App: { currentView: 'detail', showView() {} },
        Records: { isFavorite: async () => false, getFavTag: async () => '', getWatchProgress: async () => null },
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/js/detail.js'), context, { filename: 'detail.js' });
    return vm.runInContext('Detail', context);
}

test('A-32 行为：关闭单档复位——到期只摘 .show，.float-out 保留（末态固化在 CSS）', () => {
    const timers = makeTimers();
    const Detail = loadDetail(timers);
    const el = makeFloatEl();
    el.classList.add('show');

    Detail._hideDetailFloat(el);
    // 立即态：退场动画已挂、层仍可见（淡出中）
    assert.ok(el.classList.contains('float-out') && el.classList.contains('show'),
        '挂 .float-out 后 .show 仍在（淡出播完前层不消失）');

    // 唯一一档到期：只摘 .show，.float-out 永远保留——遮罩淡出由 CSS 显式
    // #*.float-out { opacity:0 } 承接，帧偏移不可能再闪回
    assert.strictEqual(timers.step(), 150, '复位档 = FLOAT_OUT_MS');
    assert.ok(!el.classList.contains('show'), '到期摘 .show');
    assert.ok(el.classList.contains('float-out'), '.float-out 不随关闭摘除（末态固化）');
    assert.strictEqual(timers.step(), 0, '无残留定时器');
});

test('A-32 行为：退场中重开（连开两个角色）——重开清掉 .float-out 遗留与旧定时器', () => {
    const timers = makeTimers();
    const Detail = loadDetail(timers);
    const el = makeFloatEl();
    el.classList.add('show');

    Detail._hideDetailFloat(el);
    timers.step(); // 复位档已过：show 摘、float-out 留、无 pending
    assert.strictEqual(timers.pendingCount(), 0, '关闭链路无残留定时器');

    Detail._showDetailFloat(el); // 重开
    assert.ok(el.classList.contains('show') && !el.classList.contains('float-out'),
        '重开：清退场遗留（.float-out）+ 亮层');
    assert.strictEqual(timers.step(), 0, '重开后无定时器误触发');
    assert.ok(el.classList.contains('show'), '新层保持可见');
});

test('A-32 行为：重复关闭防叠发——clearTimeout 先行，仅一条定时器', () => {
    const timers = makeTimers();
    const Detail = loadDetail(timers);
    const el = makeFloatEl();
    el.classList.add('show');

    Detail._hideDetailFloat(el);
    Detail._hideDetailFloat(el); // 淡出中重复触发（如连点关闭钮）
    assert.ok(el.classList.contains('float-out') && el.classList.contains('show'), '立即态不变');
    timers.step();
    assert.strictEqual(timers.pendingCount(), 0, '旧链已清，无叠加定时器');
    assert.ok(!el.classList.contains('show'), '最终摘 .show');
    assert.ok(el.classList.contains('float-out'), '.float-out 保留待重开复位');
    assert.strictEqual(timers.step(), 0, '无残留定时器');
});

test('A-32 行为：未显示层关闭为 no-op（不挂 .float-out 不挂定时器）', () => {
    const timers = makeTimers();
    const Detail = loadDetail(timers);
    const el = makeFloatEl();
    Detail._hideDetailFloat(el);
    assert.ok(!el.classList.contains('float-out') && timers.pendingCount() === 0,
        '非 .show 层直接跳过');
});
