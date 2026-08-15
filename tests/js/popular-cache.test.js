'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 在 VM 中加载 popular.js，注入最小全局桩；localStorage 为内存 Map 桩。 */
function loadPopular() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/popular.js'), 'utf8');
    const lsStore = new Map();
    const ls = {
        getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
        setItem: (k, v) => lsStore.set(k, String(v)),
        removeItem: (k) => lsStore.delete(k),
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout,
        localStorage: ls,
        $: () => ({
            on() { return this; }, empty() { return this; }, html() {}, text() { return this; },
            show() { return this; }, hide() { return this; }, find() { return { on() {} }; },
        }),
        doAction: async () => ({ trends: [], total: 0 }),
        warnToast: () => {},
        showLoading: () => {},
        hideLoading: () => {},
        renderPagerBox: () => {},
        bangumiCard: (item) => `<div class="bangumi-card" data-id="${item.id}">${item.name || ''}</div>`,
        escHtml: (s) => String(s),
        openDialog: () => {},
        closeDialog: () => {},
        Kazumi: {},
        fitVodTitles: () => {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__Popular = Popular;`, context, { filename: 'popular.js' });
    context.__ls = ls;
    context.__lsStore = lsStore;
    return context;
}

function resetPop(ctx) {
    const P = ctx.__Popular;
    P._inited = false;
    P._items = [];
    P._total = 0;
    P._page = 1;
    P._loading = false;
    P._tag = '';
    return P;
}

test('Popular.enter：命中本地缓存立即上屏并后台静默刷新', async () => {
    const ctx = loadPopular();
    const P = resetPop(ctx);
    ctx.__ls.setItem('popular::trends::v2', JSON.stringify({ items: [{ id: 'c1', name: '缓存番' }], total: 1 }));
    let trendsCalls = 0;
    ctx.doAction = async (action, kv, path) => {
        if (action === 'kazumiBangumiTrends') {
            trendsCalls++;
            return { trends: [{ id: 'n1', name: '新番' }], total: 1 };
        }
        return { items: [], total: 0 };
    };
    const p = P.enter();
    assert.equal(P._items.length, 1, '同步路径先用缓存数据上屏');
    assert.equal(P._items[0].id, 'c1');
    assert.equal(P._tag, '', '落地热门番组');
    await new Promise((r) => setImmediate(r)); // 冲刷后台刷新
    await p;
    assert.equal(trendsCalls, 1, '后台静默刷新拉取 trends');
    assert.equal(P._items[0].id, 'n1', '刷新后更新为新数据');
    const cached = JSON.parse(ctx.__ls.getItem('popular::trends::v2'));
    assert.equal(cached.items[0].id, 'n1', '缓存同步更新');
});

test('Popular.enter：无缓存时等待网络加载并写缓存', async () => {
    const ctx = loadPopular();
    const P = resetPop(ctx);
    let trendsCalls = 0;
    ctx.doAction = async (action, kv, path) => {
        if (action === 'kazumiBangumiTrends') {
            trendsCalls++;
            return { trends: [{ id: 'n1', name: '新番' }], total: 1 };
        }
        return { items: [], total: 0 };
    };
    await P.enter();
    assert.equal(trendsCalls, 1);
    assert.equal(P._items[0].id, 'n1');
    const cached = JSON.parse(ctx.__ls.getItem('popular::trends::v2'));
    assert.equal(cached.items[0].id, 'n1', '热门番组加载后写缓存');
});

test('Popular.enter：会话内已加载不重复拉取（瞬间切换）', async () => {
    const ctx = loadPopular();
    const P = resetPop(ctx);
    P._items = [{ id: 's1', name: '会话' }];
    P._total = 1;
    let calls = 0;
    ctx.doAction = async () => { calls++; return { trends: [], total: 0 }; };
    await P.enter();
    assert.equal(calls, 0, '内存有数据不再拉取');
});

test('Popular.load：silent 模式不弹 loading / 失败不 toast', async () => {
    const ctx = loadPopular();
    const P = resetPop(ctx);
    let loadingShown = 0;
    ctx.showLoading = () => { loadingShown++; };
    let toasts = 0;
    ctx.warnToast = () => { toasts++; };
    ctx.doAction = async () => { throw new Error('net'); };
    await P.load(1, true);
    assert.equal(loadingShown, 0, 'silent 不弹 loading');
    assert.equal(toasts, 0, 'silent 失败不 toast');
});

test('Popular：标签视图不覆盖热门番组缓存，热门番组才写缓存', () => {
    const ctx = loadPopular();
    const P = resetPop(ctx);
    P._tag = '日常';
    P._items = [{ id: 't1', name: '标签番' }];
    P._total = 1;
    P._saveCache();
    assert.equal(ctx.__ls.getItem('popular::trends::v2'), null, '标签视图不写缓存');
    P._tag = '';
    P._saveCache();
    assert.ok(ctx.__ls.getItem('popular::trends::v2'), '热门番组写缓存');
});
