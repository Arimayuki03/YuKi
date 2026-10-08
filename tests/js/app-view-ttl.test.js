// 单元测试：App 视图级页缓存 TTL（B-03：60s → 5min）
//
// 目标逻辑（用户定义）：
//   只读浏览视图（home/popular/timeline）在 TTL 内再次切入时跳过 enter 网络重拉；
//   TTL 口径为 5 分钟——popular/timeline 是 Bangumi 慢频数据，切回页面零等待窗口
//   1min → 5min。手动刷新不受影响：各视图刷新按钮直接调自身 load（不经 showView
//   缓存判定），showView(name, { refresh: true }) 也能强制绕过 TTL。
//
// 加载方式：fs.readFileSync + node:vm，注入最小桩（与 nav-branch-memory.test.js
// 同款写法，common-utils.test.js 头部说明的既有手法）。
'use strict';
const { test } = require('node:test');
// L43：统一本批次 assert/strict 口径——当前断言均为同类型比较，改后语义不变
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadApp() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/app.js'), 'utf8');
    const context = {
        console,
        Date, Math, JSON, Promise,
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (f) => f(),
        $: () => ({ on() { return this; }, removeClass() { return this; }, addClass() { return this; }, toggleClass() { return this; }, data() { return ''; } }),
        document: {
            getElementById: (id) => (
                ['home', 'search', 'popular', 'timeline', 'detail', 'settings', 'live', 'my']
                    .some((v) => id === 'view-' + v) ? { id, scrollTop: 0 } : null),
            querySelector: () => null,
            addEventListener: () => {},
        },
        window: {},
        warnToast() {}, showLoading() {}, hideLoading() {},
        applySkin() {}, applyMisansFont: async () => {},
        toFileUrl: (u) => u, setBackendInfo() {},
        dispatchEsc() {}, doAction: async () => ({}),
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
        Kazumi: {}, BangumiSearch: {},
        initAuxPanels() {}, ensureLocalPanel() {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__App = App;`, context, { filename: 'app.js' });
    return { App: context.__App, context };
}

test('TTL 口径：_cacheableViews 三视图均为 5 分钟（B-03：60s → 5min）', () => {
    const { App } = loadApp();
    assert.equal(App._cacheableViews.home, 5 * 60 * 1000, 'home TTL 应为 5min');
    assert.equal(App._cacheableViews.popular, 5 * 60 * 1000, 'popular TTL 应为 5min');
    assert.equal(App._cacheableViews.timeline, 5 * 60 * 1000, 'timeline TTL 应为 5min');
    for (const [name, ttl] of Object.entries(App._cacheableViews)) {
        assert.ok(ttl > 60000, `${name} 的 TTL 必须严格大于旧值 60s（防止回退）`);
    }
});

test('_viewFresh：TTL 内命中、过期失效、未收录视图永不算新鲜', () => {
    const { App } = loadApp();
    const t0 = Date.now();
    App._viewLoadedAt.popular = t0;
    assert.equal(App._viewFresh('popular'), true, '刚加载过应命中');
    App._viewLoadedAt.popular = t0 - 5 * 60 * 1000 + 1000; // 4:59，仍在 TTL 内
    assert.equal(App._viewFresh('popular'), true, 'TTL 边界内（<5min）应命中');
    App._viewLoadedAt.popular = t0 - 5 * 60 * 1000 - 1; // 越过 5min
    assert.equal(App._viewFresh('popular'), false, '超过 5min 应失效');
    assert.equal(App._viewFresh('search'), false, '未收录视图一律重拉');
});

test('showView 缓存路径：TTL 内跳过 enter 重拉，{refresh:true} 强制绕过', () => {
    const { App, context } = loadApp();
    let enterCalls = 0;
    context.Popular = { enter: () => { enterCalls += 1; } }; // app.js 直接引用全局 Popular
    App._viewLoadedAt.popular = Date.now(); // 刚加载过，处于 5min TTL 内
    App.showView('popular', { push: false });
    assert.equal(enterCalls, 0, 'TTL 内再次切入应跳过 enter（零等待）');
    App.showView('popular', { push: false, refresh: true });
    assert.equal(enterCalls, 1, 'refresh:true 必须强制重拉，不受 TTL 影响');
    assert.ok(App._viewLoadedAt.popular >= Date.now() - 1000, '重拉后时间戳刷新');
});
