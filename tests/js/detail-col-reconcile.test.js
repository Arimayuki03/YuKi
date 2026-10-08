'use strict';
// A-28 收藏态双查降频回归测试（detail.js 收藏对账双查点，原 :722-723）：
// 详情页打开时 Bangumi 收藏原本无条件「缓存回填 + force 回源对账」双查；
// 降频后 force 对账仅在 ①首次/超 5min 窗口 ②写操作置脏 时发起，缓存回填恒发。
// 用例：
// 1) 首次打开 force 对账一次（缓存回填 + force 双查各一次）
// 2) 5min 窗口内二次打开不 force（只走缓存回填）
// 3) 收藏写操作（FavHub 广播置脏）后打开立即 force（init() 订阅接线验证）
// 4) 时间戳过期（>5min）后恢复 force
// 5) 降频入口同时覆盖 render() 与 _restore()（嵌套返回同口径），且发起后清脏/记时间戳
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 最小 jQuery 桩（对齐 detail-bgm-extra-fail.test.js）：html 按选择器捕获 + on 记录监听。 */
function makeJqStub(captor) {
    const makeNode = (sel) => ({
        sel: String(sel),
        length: 1,
        _data: {},
        on(ev, a, b) {
            const fn = typeof b === 'function' ? b : a;
            if (captor && typeof fn === 'function') captor.bound.push({ sel: String(sel), ev, fn });
            return this;
        },
        off() { return this; },
        html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), String(s)); return this; },
        text() { return this; },
        addClass() { return this; },
        removeClass() { return this; },
        attr() { return this; },
        prop() { return this; },
        // find(s) 对齐真实 querySelector：后代组合器拼接（全批桩统一口径）；
        // 无参调用无子选择器可用，视为后代通配
        find(s) { return makeNode(s === undefined ? String(sel) + ' *' : String(sel) + ' ' + String(s)); },
        children() { return Object.assign(makeNode(String(sel) + ' > *'), { length: 0 }); },
        each() { return this; },
        not() { return this; },
        is() { return false; },
        toggle() { return this; },
        hide() { return this; },
        show() { return this; },
        closest() { return makeNode(String(sel) + ' ^'); },
        data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
    });
    return (sel) => makeNode(sel);
}

/** 在 VM 中加载 detail.js（最小桩）。返回 Detail、Kazumi 桩（记录回填/force 调用）与 FavHub 桩。 */
function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const captor = { bound: [], htmlBySel: new Map() };
    const Kazumi = {
        _applyBangumiColState: async () => {},
        bangumiComments: async () => ({ list: [], total: 0 }),
        bangumiCharacters: async () => [],
        bangumiStaff: async () => [],
        bangumiRelations: async () => [],
        bangumiEpisodes: async () => ({ data: [] }),
        bangumiInfo: async () => ({ id: '42', name: '番剧' }),
    };
    const colCalls = []; // 记录 _applyBangumiColState 调用：{ id, force }
    Kazumi._applyBangumiColState = async (id, opts) => {
        colCalls.push({ id: String(id), force: !!(opts && opts.force) });
    };
    const favSubs = []; // FavHub.onChanged 注册的回调（changed() 同步派发）
    const FavHub = {
        onChanged(fn) { if (typeof fn === 'function') favSubs.push(fn); return () => {}; },
        changed(meta) { favSubs.slice().forEach((fn) => { try { fn(meta || {}); } catch (e) { /* ignore */ } }); },
    };
    const context = {
        console: { warn: () => {}, log: () => {}, error: () => {}, info: () => {} },
        Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, URL,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: () => null,
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: makeJqStub(captor),
        registerEsc: () => {},
        escHtml: (s) => String(s),
        stripHtml: (s) => String(s || ''),
        warnToast: () => {},
        showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: () => '<img src="cover.jpg">',
        normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        localCacheGet: () => null,
        localCacheSet: () => {},
        localCacheDel: () => {},
        openDialog: () => {}, closeDialog: () => {},
        doAction: async () => ({ list: [] }),
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
        App: { currentView: 'detail', showView() {} },
        FavHub,
        Kazumi,
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, Kazumi, colCalls, favSubs, FavHub, context };
}

/** 标准夹具：Bangumi-only 详情（_bgmId 已设）。 */
function fixture(extra) {
    const loaded = loadDetail(extra);
    loaded.Detail._bgmId = '42';
    loaded.Detail._bgmInfo = { id: 42, name: '番剧' };
    return loaded;
}

const forceCalls = (colCalls) => colCalls.filter((c) => c.force);
const plainCalls = (colCalls) => colCalls.filter((c) => !c.force);

test('A-28①：首次打开详情 → 缓存回填 + force 对账各一次（force 对账照常进行）', async () => {
    const { Detail, colCalls } = fixture();
    Detail.render();
    await new Promise((r) => setImmediate(r));
    assert.equal(plainCalls(colCalls).length, 1, '缓存回填（非 force）应恒发一次');
    assert.equal(forceCalls(colCalls).length, 1, '首次打开（无对账时间戳）应 force 对账一次');
    assert.ok(Detail._colReconcileTs > 0, 'force 发起后应记录对账时间戳');
    assert.equal(Detail._colReconcileDirty, false, 'force 发起后应清脏标记');
});

test('A-28②：5min 窗口内二次打开 → 只走缓存回填，不 force', async () => {
    const { Detail, colCalls } = fixture();
    Detail.render();
    await new Promise((r) => setImmediate(r));
    const forceFirst = forceCalls(colCalls).length;
    assert.equal(forceFirst, 1, '首次 force 一次');
    // 时间戳未变（刚刚对账过）→ 二次 render 只补缓存回填
    Detail.render();
    await new Promise((r) => setImmediate(r));
    assert.equal(forceCalls(colCalls).length, 1, '5min 窗口内二次打开不应再 force');
    assert.equal(plainCalls(colCalls).length, 2, '缓存回填每次打开都发（快速上屏语义保持）');
});

test('A-28③：收藏写操作（FavHub 广播）置脏 → 下次打开立即 force（写后立即一致）', async () => {
    const { Detail, colCalls, favSubs } = fixture();
    Detail.init(); // FavHub.onChanged 订阅在 init() 中注册
    assert.equal(favSubs.length, 1, 'init() 应注册 FavHub 订阅');
    Detail.render();
    await new Promise((r) => setImmediate(r));
    assert.equal(forceCalls(colCalls).length, 1);
    // 模拟本应用内收藏写操作广播（records.js recSet('favorites') → FavHub.changed）
    favSubs[0]({});
    assert.equal(Detail._colReconcileDirty, true, 'FavHub 广播应置脏（即使详情页未在前台）');
    // 置脏后立即再 render：虽然仍在 5min 窗口内，必须 force
    Detail.render();
    await new Promise((r) => setImmediate(r));
    assert.equal(forceCalls(colCalls).length, 2, '写操作后打开详情应立即 force 对账');
    assert.equal(Detail._colReconcileDirty, false, 'force 发起后脏标记应被消费清除');
    // 再次 render 恢复正常窗口节奏（不会因置脏残留连续 force）
    Detail.render();
    await new Promise((r) => setImmediate(r));
    assert.equal(forceCalls(colCalls).length, 2, '清脏后回到 5min 窗口节奏');
});

test('A-28④：时间戳过期（>5min）后打开 → 恢复 force 对账', async () => {
    const { Detail, colCalls } = fixture();
    Detail.render();
    await new Promise((r) => setImmediate(r));
    assert.equal(forceCalls(colCalls).length, 1);
    // 把上次对账时间戳拨回 6 分钟前（阈值 5min）
    Detail._colReconcileTs = Date.now() - 6 * 60 * 1000;
    Detail.render();
    await new Promise((r) => setImmediate(r));
    assert.equal(forceCalls(colCalls).length, 2, '超窗后打开应恢复 force 对账');
    assert.ok(Detail._colReconcileTs > Date.now() - 60 * 1000, '对账时间戳应刷新为当前时间');
});

test('A-28⑤：_restore（嵌套返回）同口径降频 + 非当前详情防串档', async () => {
    const { Detail, colCalls, favSubs } = fixture();
    Detail.init();
    // 快照：非当前详情的 snapshot._bgmId 与恢复后状态一致（Object.assign 回来）
    const snapshot = Detail._snapshot();
    assert.ok(snapshot._bgmId === '42', '快照应携带 _bgmId');
    Detail.render();
    await new Promise((r) => setImmediate(r));
    assert.equal(forceCalls(colCalls).length, 1);
    // 嵌套返回：窗口内不 force（回填照发）
    await Detail._restore(snapshot);
    assert.equal(forceCalls(colCalls).length, 1, '嵌套返回在 5min 窗口内同样不 force');
    assert.equal(plainCalls(colCalls).length >= 2, true, '嵌套返回仍走缓存回填');
    // 置脏后嵌套返回立即 force
    favSubs[0]({});
    await Detail._restore(Detail._snapshot());
    assert.equal(forceCalls(colCalls).length, 2, '置脏后嵌套返回应立即 force');
});

test('A-28⑥：FavHub 缺失（桩未提供）→ 降频逻辑不抛错，仍按窗口节奏 force', async () => {
    const { Detail, colCalls, context } = fixture();
    vm.runInContext('FavHub = undefined;', context); // 模拟 records.js 未加载
    Detail.render();
    await new Promise((r) => setImmediate(r));
    assert.equal(forceCalls(colCalls).length, 1, '首次打开仍应 force（init 未订阅不影响判定）');
    Detail.render();
    await new Promise((r) => setImmediate(r));
    assert.equal(forceCalls(colCalls).length, 1, '窗口内不 force，不因缺 FavHub 抛错');
});
