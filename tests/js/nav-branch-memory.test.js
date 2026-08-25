// 单元测试：主导航分支位置记忆（首页/搜索/推荐/时间表 ↔ 各自的详情子页）
//
// 目标逻辑（用户定义）：
//   某页面打开详情A → 点其他页面正常进入 → 点回原分支导航恢复详情A
//   → 再点其他页面仍正常 → 再点回原分支导航，还是原来的详情A。
//
// 实现要点：
//   - 每个内容分支记住自己的最后位置；只有「新开详情」（Detail.open/openBangumi，
//     App._detailOpening 标记）且来源是四分支之一时才写入该分支的记忆；
//     导航恢复/侧键返回/嵌套快照恢复等「重新展示」不改写记忆。
//   - 记忆附 site|vodId 内容指纹：单例详情被换片后旧记忆失配自动回根。
//   - 停留在详情页时点内容分支导航：直进目标分支根（「点击其他页面不受影响」）。
//
// 在 VM 中加载 app.js，注入最小桩；通过真实绑定的 .main-nav-item 点击处理器走完整链路。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadApp() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/app.js'), 'utf8');
    const handlers = {};
    const $stub = (sel) => {
        if (sel && typeof sel === 'object') return sel; // 事件 currentTarget 伪元素直通
        return {
            on(ev, fn) { handlers[String(sel) + '|' + ev] = fn; return this; },
            removeClass() { return this; },
            addClass() { return this; },
            toggleClass() { return this; },
            data() { return ''; },
        };
    };
    const context = {
        console,
        Date, Math, JSON, Promise,
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (f) => f(),
        $: $stub,
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
    context.__App.initNav(); // 手动绑定（VM 中 jQuery ready 不执行）
    return {
        App: context.__App,
        Detail: context.Detail,
        clickNav: handlers['.main-nav-item|click'],
    };
}

/** 模拟 Detail.open/openBangumi：先写 site/vodId、置新开标记，再 showView('detail')。 */
function openMovie(ctx, site, vodId) {
    ctx.Detail.site = String(site);
    ctx.Detail.vodId = String(vodId);
    ctx.App._detailOpening = true;
    ctx.App.showView('detail');
}

test('目标流程：首页开详情→其他页面→回首页见详情→其他页面→再回首页仍是同一详情', () => {
    const { App, Detail, clickNav } = loadApp();
    const nav = (b) => clickNav({ currentTarget: { data: (k) => (k === 'view' ? b : undefined) } });

    App.showView('home');
    openMovie({ App, Detail }, '量子资源', '145084'); // ① 首页打开详情 A
    assert.equal(App.currentView, 'detail');

    nav('search');
    assert.equal(App.currentView, 'search', '② 点其他页面不受影响');
    nav('popular');
    assert.equal(App.currentView, 'popular');

    nav('home');
    assert.equal(App.currentView, 'detail', '③ 回到首页分支记住的详情 A');

    nav('timeline');
    assert.equal(App.currentView, 'timeline', '④ 点击其他页面仍不受影响');
    nav('search');
    assert.equal(App.currentView, 'search');

    nav('home');
    assert.equal(App.currentView, 'detail', '⑤ 再回到首页分支，还是原来的详情页');
});

test('写入范围隔离：从首页打开详情只写首页的记忆，其他分支保持根记忆', () => {
    const { App, Detail } = loadApp();
    App.showView('home');
    openMovie({ App, Detail }, 's1', 'v1');
    assert.deepEqual(App._branchLast.home, { v: 'detail', key: 's1|v1' });
    assert.equal(App._branchLast.search, 'search', '搜索分支不受影响');
    assert.equal(App._branchLast.popular, 'popular', '推荐分支不受影响');
    assert.equal(App._branchLast.timeline, 'timeline', '时间表分支不受影响');
});

test('恢复展示不改写归属：从推荐页点「首页」回详情后，多次往返稳定', () => {
    const { App, Detail, clickNav } = loadApp();
    const nav = (b) => clickNav({ currentTarget: { data: (k) => (k === 'view' ? b : undefined) } });

    App.showView('home');
    openMovie({ App, Detail }, 's1', 'v1'); // 首页持有详情 A

    nav('popular'); // 切到推荐根页面
    assert.equal(App.currentView, 'popular');

    nav('home'); // 恢复详情 A（导航恢复路径，非新开）
    assert.equal(App.currentView, 'detail');

    nav('timeline');
    assert.equal(App.currentView, 'timeline');
    nav('home');
    assert.equal(App.currentView, 'detail', '多次往返后仍是原来的详情页');
});

test('单例换片：旧分支指纹失配自动回根，新分支持有新详情', () => {
    const { App, Detail, clickNav } = loadApp();
    const nav = (b) => clickNav({ currentTarget: { data: (k) => (k === 'view' ? b : undefined) } });

    App.showView('home');
    openMovie({ App, Detail }, 's1', 'v1'); // 首页开影片 A

    nav('search');
    assert.equal(App.currentView, 'search');
    openMovie({ App, Detail }, 's2', 'v2'); // 搜索开影片 B（换片）
    assert.deepEqual(App._branchLast.search, { v: 'detail', key: 's2|v2' });
    assert.deepEqual(App._branchLast.home, { v: 'detail', key: 's1|v1' }, '首页记忆未被改写');

    nav('home'); // 首页记忆指向 A，但单例已是 B：指纹失配回根（绝不显示错误影片）
    assert.equal(App.currentView, 'home', '换片后的过期记忆应回退分支根');

    nav('search'); // 搜索分支持有当前详情 B：回详情 B
    assert.equal(App.currentView, 'detail');
});

test('停留在详情页点内容分支导航：直进目标根（点击其他页面不受影响）', () => {
    const { App, Detail, clickNav } = loadApp();
    const nav = (b) => clickNav({ currentTarget: { data: (k) => (k === 'view' ? b : undefined) } });

    App.showView('home');
    openMovie({ App, Detail }, 's1', 'v1');

    nav('search');
    assert.equal(App.currentView, 'search');
    nav('popular');
    assert.equal(App.currentView, 'popular');
    nav('timeline');
    assert.equal(App.currentView, 'timeline');

    // 核心能力保留：设置（内容分支之外）切回仍恢复详情
    App.showView('settings');
    nav('home');
    assert.equal(App.currentView, 'detail', '从设置切回应恢复详情子页');
});
