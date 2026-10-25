'use strict';
/**
 * 浮层「返回」优先级：对话框 / 图片查看器 / 人物浮层未关之前，视图栈不动。
 *
 * 回归背景（用户报）：打开详情页图片查看器（#cover-float）后按鼠标侧键「后退」，
 * 底下的详情页被退掉了，图片浮层还盖在新页面上——要再按一次才真正退出查看。
 * 键鼠两个入口（Esc → dispatchEsc、侧键 → App.mouseNav）现在共用 common.js 的
 * closeTopOverlay：先关最上层浮层，关完才允许弹视图栈。
 *
 * 手法同 nav-branch-memory.test.js：VM 里加载 common.js + app.js，用最小 DOM 桩
 * 驱动真实的分发逻辑。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl(id) {
    const cls = new Set();
    return {
        id,
        classList: {
            add: (c) => cls.add(c),
            remove: (c) => cls.delete(c),
            contains: (c) => cls.has(c),
        },
        _cls: cls,
    };
}

function loadApp(opts = {}) {
    const common = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/common.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/app.js'), 'utf8');
    const elements = new Map();
    const ensure = (id) => {
        if (!elements.has(id)) elements.set(id, makeEl(id));
        return elements.get(id);
    };
    const shown = new Set(opts.shown || []);
    shown.forEach((id) => ensure(id).classList.add('show'));

    const jq = (arg) => {
        const sel = typeof arg === 'string' ? arg : '';
        const api = {
            length: sel.startsWith('#') && elements.has(sel.slice(1)) ? 1 : 0,
            on() { return api; }, off() { return api; },
            addClass() { return api; }, removeClass() { return api; },
            toggleClass() { return api; }, css() { return api; },
            hide() { return api; }, show() { return api; },
            data() { return undefined; }, text() { return api; }, html() { return api; },
            attr() { return api; }, prop() { return api; }, val() { return ''; },
            find() { return api; }, each() { return api; },
            closest() { return api; }, trigger() { return api; },
        };
        return api;
    };

    const context = {
        console,
        Date, Math, JSON, Promise, Map, Set, Error, TypeError,
        setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
        setInterval() { return 0; }, clearInterval() {}, requestAnimationFrame: (f) => f(),
        $: jq,
        document: {
            getElementById: (id) => elements.get(id) || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
            body: { classList: { add() {}, remove() {}, contains: () => false } },
            createElement: () => makeEl('x'),
        },
        window: { innerWidth: 1440, innerHeight: 900, addEventListener: () => {} },
        warnToast() {}, errToast() {}, showLoading() {}, hideLoading() {},
        applySkin() {}, applyMisansFont: async () => {},
        toFileUrl: (u) => u, setBackendInfo() {}, doAction: async () => ({}),
        confirmDialog: async () => true,
        Player: { init() {} },
        Detail: { init() {}, site: '', vodId: '' },
        Search: { init() {}, focus() {}, onViewShown() {} },
        Live: { init() {} },
        Home: { init: async () => {} },
        My: { enter: async () => {} },
        HistoryView: { enter: async () => {} },
        Downloads: { enter() {} },
        Popular: { enter() {} },
        Timeline: { _inited: true, init() {}, refreshCollections() {}, load() {} },
        Kazumi: {}, BangumiSearch: {}, UIState: {},
        initAuxPanels() {}, ensureLocalPanel() {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${common}\n${app}\n;globalThis.__C = { closeTopOverlay, dispatchEsc, openDialog, closeDialog, registerEsc, dialogStack: () => dialogStack.slice() };globalThis.__App = App;`, context, { filename: 'app-common.vm.js' });
    context.__elements = elements;
    return context;
}

test('closeTopOverlay：最上层浮层优先（对话框 → 图片浮层 → 人物浮层），都没有返回 false', () => {
    const ctx = loadApp({ shown: ['cover-float', 'char-float'] });
    ctx.__C.openDialog('confirmDialog');
    assert.equal(ctx.__C.closeTopOverlay(), true, '有对话框先关对话框');
    assert.deepEqual(ctx.__C.dialogStack(), [], '对话框栈已清空');
    assert.ok(ctx.__elements.get('cover-float').classList.contains('show'), '图片浮层这次不动');
    assert.equal(ctx.__C.closeTopOverlay(), true, '其次关图片查看器');
    assert.ok(!ctx.__elements.get('cover-float').classList.contains('show'));
    assert.equal(ctx.__C.closeTopOverlay(), true, '再关人物浮层');
    assert.ok(!ctx.__elements.get('char-float').classList.contains('show'));
    assert.equal(ctx.__C.closeTopOverlay(), false, '都关完了返回 false（调用方可继续视图级返回）');
});

test('鼠标侧键后退：图片查看器打开时不弹视图栈，只关浮层', () => {
    const ctx = loadApp({ shown: ['cover-float'] });
    const App = ctx.__App;
    App.showView('home');
    App.showView('search');
    const depth = App._navStack.length;
    App._navLast = 0;
    App.mouseNav('back');
    assert.ok(!ctx.__elements.get('cover-float').classList.contains('show'), '浮层被关掉');
    assert.equal(App._navStack.length, depth, '视图栈原样不动');
    assert.equal(App.currentView, 'search', '仍停在本页');
});

test('鼠标侧键后退：浮层都关掉之后才真正后退', () => {
    const ctx = loadApp({ shown: [] });
    const App = ctx.__App;
    App.showView('home');
    App.showView('search');
    App._navLast = 0;
    App.mouseNav('back');
    assert.equal(App.currentView, 'home', '无浮层时后退回上一视图');
});

test('dispatchEsc 语义不变：浮层没关完不惊动视图级处理器，关完才轮到它', () => {
    const ctx = loadApp({ shown: ['cover-float'] });
    let viewHandler = 0;
    ctx.__C.registerEsc(() => { viewHandler += 1; return true; });
    ctx.__C.dispatchEsc();
    assert.ok(!ctx.__elements.get('cover-float').classList.contains('show'), 'Esc 先关图片浮层');
    assert.equal(viewHandler, 0, '浮层消费掉了这次 Esc');
    ctx.__C.dispatchEsc();
    assert.equal(viewHandler, 1, '浮层都关掉后 Esc 才派发给视图处理器');
});
