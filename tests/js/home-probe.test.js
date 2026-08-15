'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 在 VM 中加载 home.js，注入最小全局桩；localStorage 为内存 Map 桩（T60 持久化）。
 *  sharedStore：可传入外部 Map 以共享 localStorage（跨 vm 上下文测持久化往返）。 */
function loadHome(sharedStore) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/home.js'), 'utf8');
    const lsStore = sharedStore || new Map();
    const ls = {
        getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
        setItem: (k, v) => lsStore.set(k, String(v)),
        removeItem: (k) => lsStore.delete(k),
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout,
        localStorage: ls,
        $: () => ({ on() { return this; }, off() { return this; }, empty() { return this; }, html() {}, val() { return ''; } }),
        window: { vpc: { settingsGet: async () => ({}), settingsSet: async () => {} } },
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        truncateTitle: (s) => String(s || '').slice(0, 60),
        vodCoverImg: (pic) => `<img src="${pic || ''}">`,
        warnToast: () => {},
        showLoading: () => {},
        hideLoading: () => {},
        normalizePic: (p) => p || '',
        Detail: {},
        renderPagerBox: () => {},
        pageSizeOf: async () => 20,
        fillMissingCovers: () => {},
        fitVodTitles: () => {},
        renderStatusBar: () => {},
        doAction: async () => ({ list: [] }),
        getJson: async () => ({ sites: [] }),
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__Home = Home;`, context, { filename: 'home.js' });
    context.__ls = ls;
    context.__lsStore = lsStore;
    return context;
}

/** 每次测试重置 Home 的探测状态与站点上下文。 */
function home(ctx) {
    const H = ctx.__Home;
    H.site = 's';
    H.classes = [];
    H.mode = 'home';
    H.tid = '';
    H._loadToken = 0;
    H._clsProbed = {};
    H._clsBusy = {};
    H._clsStarted = {};
    H._okCls = {};
    H._emptyCls = {};
    return H;
}

function spyRender(H, ctx) {
    H.renderClass = (active) => { ctx.__rcActive = active; ctx.__rcCalls = (ctx.__rcCalls || 0) + 1; };
}

// ---------------------------------------------------------------- 探测分类（T60 加固）

test('_probeClasses：空/有内容分类正确分类并落盘持久化', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.classes = [{ type_id: 'a', type_name: 'A' }, { type_id: 'b', type_name: 'B' }];
    H._loadToken = 1;
    spyRender(H, ctx);
    ctx.doAction = async (action, kv) => (kv.tid === 'a' ? { list: [] } : { list: [{ vod_id: '1', vod_name: 'x' }] });
    await H._probeClasses();
    assert.ok(H._emptyCls.s.has('a'), '空分类 a 应被标记为空');
    assert.ok(H._okCls.s.has('b'), '有内容分类 b 应被标记为有内容');
    assert.equal(H._clsProbed.s, true, '全部分类确认后标记完成');
    assert.equal(ctx.__rcCalls, 1, '有变化应重渲分类栏');
    assert.deepEqual(JSON.parse(ctx.__ls.getItem('vpc_home_empty_classes')).s.empty, ['a'], '持久化只含空分类 a');
});

test('_probeClasses：完整探测过则不再探测（同源只探一次）', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.classes = [{ type_id: 'a', type_name: 'A' }];
    H._clsProbed.s = true;
    let calls = 0;
    ctx.doAction = async () => { calls++; return { list: [] }; };
    await H._probeClasses();
    assert.equal(calls, 0);
});

test('_probeClasses：探测在途时不并发重复探测', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.classes = [{ type_id: 'a', type_name: 'A' }];
    H._clsBusy.s = true;
    let calls = 0;
    ctx.doAction = async () => { calls++; return { list: [] }; };
    await H._probeClasses();
    assert.equal(calls, 0);
});

test('_probeClasses：中断不丢进度，全部分类仍记录并落盘', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.classes = [
        { type_id: 'a', type_name: 'A' },
        { type_id: 'b', type_name: 'B' },
        { type_id: 'c', type_name: 'C' },
    ];
    H._loadToken = 1;
    const pend = [];
    const tids = [];
    ctx.doAction = (action, kv) => {
        tids.push(kv.tid);
        return new Promise((res) => pend.push(() => res(kv.tid === 'a' ? { list: [] } : (kv.tid === 'b' ? { list: [{ vod_id: '1' }] } : { list: [] }))));
    };
    const p1 = H._probeClasses();
    assert.deepEqual([...tids].sort(), ['a', 'b', 'c'], '首次全量并发探测所有分类');
    pend[0](); // a → 空
    H._loadToken = 2; // 模拟中断（切分类/切源）——非丢进度版不丢弃结果
    pend[1](); // b → 有内容
    pend[2](); // c → 空
    await p1;
    assert.deepEqual([...H._emptyCls.s].sort(), ['a', 'c'], '中断后 a/c 仍确认空');
    assert.deepEqual([...H._okCls.s].sort(), ['b'], '中断后 b 仍确认有内容');
    assert.equal(H._clsProbed.s, true, '全部分类确认（含中断后）标记完成');
    assert.deepEqual([...JSON.parse(ctx.__ls.getItem('vpc_home_empty_classes')).s.empty].sort(), ['a', 'c'], '空分类已落盘');
});

test('_probeClasses：探测期间换源，结果仍记录并落盘，但不重渲（避免覆盖新源栏）', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.classes = [{ type_id: 'a', type_name: 'A' }];
    spyRender(H, ctx);
    const pend = [];
    ctx.doAction = (action, kv) => new Promise((res) => pend.push(() => res({ list: [] })));
    const p1 = H._probeClasses();
    pend[0](); // a 探测返回
    H.site = 'other'; // 探测完成前换源（同步置位，微任务冲刷后才执行最终重渲判定）
    await new Promise((r) => setImmediate(r));
    await p1;
    assert.ok(H._emptyCls.s.has('a'), '旧源结果仍按 site 键记录');
    assert.equal(H._clsProbed.s, true, '旧源全部分类确认');
    assert.deepEqual(JSON.parse(ctx.__ls.getItem('vpc_home_empty_classes')).s.empty, ['a'], '旧源空分类已落盘');
    assert.equal(ctx.__rcCalls || 0, 0, '换源后不重渲当前分类栏');
});

test('_probeClasses：探测出错不判空也不判有内容，且不标记完成（留待重试）', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.classes = [{ type_id: 'a', type_name: 'A' }];
    H._loadToken = 1;
    spyRender(H, ctx);
    ctx.doAction = async () => { throw new Error('net'); };
    await H._probeClasses();
    assert.equal(H._emptyCls.s.size, 0, '出错分类不判空');
    assert.equal(H._okCls.s.size, 0, '出错分类不判有内容');
    assert.ok(!H._clsProbed.s, '有出错不标记完成，下次载入可重试');
    assert.equal(ctx.__rcCalls || 0, 0, '无变化不重渲');
});

test('_probeClasses：部分分类出错 → 重试只探测出错分类（跳过已确认空/有内容）', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.classes = [{ type_id: 'a', type_name: 'A' }, { type_id: 'b', type_name: 'B' }];
    const tids = [];
    ctx.doAction = async (action, kv) => {
        tids.push(kv.tid);
        if (kv.tid === 'a') throw new Error('net'); // a 出错
        return { list: [] }; // b 空
    };
    await H._probeClasses();
    assert.ok(!H._clsProbed.s, '有出错不标记完成');
    assert.ok(H._emptyCls.s.has('b'), 'b 已确认空');
    assert.ok(!H._emptyCls.s.has('a'), 'a 出错未判空');
    // 重试：只探测未知（a），不再重复 b
    const tids2 = [];
    ctx.doAction = async (action, kv) => { tids2.push(kv.tid); return { list: [] }; };
    await H._probeClasses();
    assert.deepEqual([...tids2], ['a'], '重试只探测未知（出错）分类');
    assert.equal(H._clsProbed.s, true, '重试后全部分类确认，标记完成');
});

test('_probeClasses：曾判空分类恢复内容后取消隐藏并更新持久化', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.classes = [{ type_id: 'a', type_name: 'A' }, { type_id: 'b', type_name: 'B' }];
    H._emptyCls.s = new Set(['a', 'b']); // 上次会话判空
    H._loadToken = 1;
    spyRender(H, ctx);
    ctx.doAction = async (action, kv) => (kv.tid === 'a' ? { list: [{ vod_id: '1' }] } : { list: [] });
    await H._probeClasses();
    assert.ok(!H._emptyCls.s.has('a'), 'a 恢复内容后应移出空集');
    assert.ok(H._okCls.s.has('a'));
    assert.ok(H._emptyCls.s.has('b'), 'b 仍为空');
    assert.equal(ctx.__rcCalls, 1, '取消隐藏需要重渲');
    assert.deepEqual(JSON.parse(ctx.__ls.getItem('vpc_home_empty_classes')).s.empty, ['b'], '持久化只保留仍空的 b');
});

// ---------------------------------------------------------------- 全源后台探测（T60）

test('_probeAllClasses：后台为多个源补齐分类空态探测并落盘', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H._allSites = [{ key: 's1' }, { key: 's2' }];
    H.sites = [{ key: 's1' }, { key: 's2' }];
    H.site = 's1';
    ctx.doAction = async (action, kv) => {
        if (action === 'homeContent') return { class: [{ type_id: 'a', type_name: 'A' }, { type_id: 'b', type_name: 'B' }] };
        if (action === 'categoryContent') return kv.tid === 'a' ? { list: [] } : { list: [{ vod_id: '1' }] };
        return {};
    };
    await H._probeAllClasses();
    assert.ok(H._emptyCls.s1.has('a'), 's1 的 a 判空');
    assert.ok(H._okCls.s1.has('b'), 's1 的 b 判有内容');
    assert.ok(H._emptyCls.s2.has('a'), 's2 的 a 判空');
    assert.ok(H._clsProbed.s1 && H._clsProbed.s2, '两源均标记完成');
    const persisted = JSON.parse(ctx.__ls.getItem('vpc_home_empty_classes'));
    assert.ok(persisted.s1.empty.includes('a') && persisted.s2.empty.includes('a'), '两源空分类均落盘');
});

test('_probeAllClasses：跳过已探测/在途源，只探剩余源', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H._allSites = [{ key: 's1' }, { key: 's2' }, { key: 's3' }];
    H.sites = [{ key: 's1' }, { key: 's2' }, { key: 's3' }];
    H.site = 's1';
    H._clsProbed.s1 = true; // 已探测
    H._clsBusy.s2 = true;   // 在途
    let homeCalls = 0;
    ctx.doAction = async (action, kv) => {
        if (action === 'homeContent') { homeCalls++; return { class: [{ type_id: 'a', type_name: 'A' }] }; }
        return { list: [] };
    };
    await H._probeAllClasses();
    assert.equal(homeCalls, 1, '只探测 s3（s1 已探测、s2 在途被跳过）');
    assert.ok(H._emptyCls.s3.has('a'));
    assert.ok(H._clsProbed.s3, 's3 标记完成');
});

test('_probeAllClasses：数据新鲜（TTL 内）的源跳过，不重复探测', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H._allSites = [{ key: 's1' }];
    H.sites = [{ key: 's1' }];
    H._clsTs.s1 = Date.now(); // 新鲜
    let calls = 0;
    ctx.doAction = async () => { calls++; return { class: [{ type_id: 'a', type_name: 'A' }] }; };
    await H._probeAllClasses();
    assert.equal(calls, 0, '新鲜源跳过，不取 homeContent 也不探测');
});

// ---------------------------------------------------------------- 分页/填充（T75）

function makeItems(prefix, n) {
    return Array.from({ length: n }, (_, i) => ({ vod_id: prefix + i, vod_name: '片' + i }));
}

test('_fetchCat：合并多个源页填满每页条数（源每页 20 → 拉 2 页得 36 条）', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    const pages = { 1: { page: 1, pagecount: 3, limit: 20, total: 60, list: makeItems('p1-', 20) },
                     2: { page: 2, pagecount: 3, limit: 20, total: 60, list: makeItems('p2-', 20) },
                     3: { page: 3, pagecount: 3, limit: 20, total: 60, list: makeItems('p3-', 20) } };
    ctx.doAction = async (action, kv) => pages[parseInt(kv.pg, 10)] || { list: [] };
    await H._fetchCat('a', 1, 36);
    assert.equal(H._catItems.length, 36, '合并 2 个源页得 36 条');
    assert.equal(H.pagecount, 2, '应用页数 = ceil(60/36) = 2');
});

test('_fetchCat：翻页复用合并窗口，只补拉缺失源页', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    const calls = [];
    ctx.doAction = async (action, kv) => {
        const n = parseInt(kv.pg, 10);
        calls.push(n);
        return { page: n, pagecount: 5, limit: 20, total: 100, list: makeItems('pg' + n + '-', 20) };
    };
    await H._fetchCat('a', 1, 36); // 需 36 → 源页 1,2
    assert.equal(H._catItems.length, 36);
    await H._fetchCat('a', 2, 36); // 需 72 → 补源页 3,4
    assert.equal(H._catItems.length, 36);
    assert.deepEqual(calls, [1, 2, 3, 4], '翻页只补拉缺失的源页');
    assert.equal(H.pagecount, 3, 'ceil(100/36) = 3');
});

test('_extendHome：首个分类内容少时自动换下一个分类填满目标', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    H.classes = [{ type_id: 'a', type_name: 'A' }, { type_id: 'b', type_name: 'B' }];
    H._fillTid = 'a';
    H._fillPg = 0;
    H._homeList = [makeItems('a1-', 1)[0]];
    H._fillSeen = { 'a1-0|片0': 1 };
    const catContent = {
        a: { '1': makeItems('a1-', 1), '2': [] }, // 分类 a 仅 1 条（短页）
        b: { '1': makeItems('b-', 20), '2': makeItems('b2-', 20) },
    };
    ctx.doAction = async (action, kv) => ({ list: (catContent[kv.tid] || {})[kv.pg] || [] });
    let appended = [];
    H._appendGrid = (items) => { appended = appended.concat(items); };
    H._loadToken = 1; // _extendHome 依赖令牌匹配
    await H._extendHome(1);
    assert.equal(H._fillTid, 'b', '短页分类 a 被跳过，换到有内容的 b');
    assert.ok(H._homeList.length >= 20, '首页填满目标（默认 20）');
    assert.ok(appended.length > 0, '增量渲染有内容');
});

// ---------------------------------------------------------------- 「全部」标签分页（T76/T78）

test('_fetchHomeFeed：第 1 页即 feed 前 size 条（严格按设置每页条数）', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    const feedPages = {
        1: { page: 1, pagecount: 5, limit: 20, total: 100, list: makeItems('f1-', 20) },
        2: { page: 2, pagecount: 5, limit: 20, total: 100, list: makeItems('f2-', 20) },
        3: { page: 3, pagecount: 5, limit: 20, total: 100, list: makeItems('f3-', 20) },
        4: { page: 4, pagecount: 5, limit: 20, total: 100, list: makeItems('f4-', 20) },
        5: { page: 5, pagecount: 5, limit: 20, total: 100, list: makeItems('f5-', 20) },
    };
    ctx.doAction = async (action, kv) => (action === 'homeVideoContent' ? (feedPages[parseInt(kv.pg, 10)] || { list: [] }) : {});
    await H._fetchHomeFeed(1, 36); // need 36 → 源页 1,2 → slice(0,36)
    assert.equal(H._homeList.length, 36, '第 1 页显示 36 条');
    assert.equal(H._homeList[0].vod_id, 'f1-0');
    assert.equal(H.pagecount, Math.ceil(100 / 36), '总页数 = ceil(100/36)');
    await H._fetchHomeFeed(2, 36); // need 72 → slice(36,72)
    assert.equal(H._homeList.length, 36);
    assert.equal(H._homeList[0].vod_id, 'f2-16', '第 2 页从第 36 条开始');
});

test('_fetchHomeFeed：翻页复用窗口只补拉缺失源页', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    const calls = [];
    ctx.doAction = async (action, kv) => {
        const n = parseInt(kv.pg, 10);
        calls.push(n);
        return { page: n, pagecount: 5, limit: 20, total: 100, list: makeItems('f' + n + '-', 20) };
    };
    await H._fetchHomeFeed(1, 36); // need 36 → 源页 1,2
    await H._fetchHomeFeed(2, 36); // need 72 → 补源页 3,4
    assert.equal(H._homeList.length, 36);
    assert.deepEqual(calls, [1, 2, 3, 4], '翻页只补拉缺失源页');
    assert.equal(H.pagecount, Math.ceil(100 / 36), '总页数 = ceil(100/36)');
});

test('_fetchHomeFeed：源无「全部」feed 时返回空（第 1 页回退自适应填充）', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    ctx.doAction = async () => ({ list: [] });
    const items = await H._fetchHomeFeed(1, 36);
    assert.equal(items.length, 0, '无 feed 返回空');
    assert.equal(H.pagecount, 1, '无 feed 单页');
});

test('_fetchHomeFeed：feed 有内容但无总量时允翻下一页（分页器不消失）', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    const calls = [];
    ctx.doAction = async (action, kv) => {
        const n = parseInt(kv.pg, 10);
        calls.push(n);
        return { page: n, list: makeItems('f' + n + '-', 20) }; // 无 total/pagecount
    };
    await H._fetchHomeFeed(1, 20); // need 20 → 源页 1（20 条）
    assert.equal(H._homeList.length, 20);
    assert.equal(H.pagecount, 2, '无总量但有内容：暂允试下一页，分页器不消失');
    await H._fetchHomeFeed(2, 20); // need 40 → 补源页 2
    assert.equal(H._homeList.length, 20);
    assert.equal(H.pagecount, 3, '持续翻页仍允下页');
});

// ---------------------------------------------------------------- 缓存失效（T77）

test('invalidatePageCaches：作废页缓存与合并窗口（配置重载/改每页条数后回到页面即生效）', () => {
    const ctx = loadHome();
    const H = home(ctx);
    H._pageCache = new Map();
    H._pageCache.set('s|a', { pagecount: 2, pages: new Map([[1, []]]) });
    H._catWin = new Map();
    H._catWin.set('s|a', { items: [], seen: new Set(), sourcePg: 0, total: 0, perPage: 20 });
    H.invalidatePageCaches();
    assert.equal(H._pageCache, null, '页缓存作废');
    assert.equal(H._catWin.size, 0, '合并窗口作废');
    assert.equal(H._pageSizeDirty, true, '标记每页条数已改');
});

test('onViewShown：设置改过每页条数后回首页视图自动重载当前模式', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.mode = 'category';
    H.tid = '6';
    H.page = 1;
    H._pageSizeDirty = true;
    let catCalls = 0;
    H.loadCategory = async () => { catCalls++; };
    H.onViewShown();
    assert.equal(catCalls, 1, '分类模式自动重载');
    assert.equal(H._pageSizeDirty, false, '脏标记清除');
    H.mode = 'home';
    H._pageSizeDirty = true;
    let homeCalls = 0;
    H.loadHome = async () => { homeCalls++; };
    H.onViewShown();
    assert.equal(homeCalls, 1, '「全部」模式自动重载');
    let c2 = 0;
    H.loadHome = async () => { c2++; };
    H.onViewShown();
    assert.equal(c2, 0, '未脏不重载');
});

// ---------------------------------------------------------------- 首页探测进度条（T81）

test('_startProbe/_probeOneDone/_endProbe：合并两个探测总进度，未显示则完成即清', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H._updateProbeBar = () => {}; // 不碰 DOM
    assert.equal(H._startProbe(10), true, '源级探测计入');
    assert.equal(H._probeBar.total, 10);
    assert.equal(H._startProbe(100), true, '分类探测合并计入');
    assert.equal(H._probeBar.total, 110);
    assert.equal(H._probeBar.active, 2, '两个探测在途');
    H._probeOneDone();
    assert.equal(H._probeBar.done, 1);
    H._endProbe();
    assert.equal(H._probeBar.active, 1, '还有一个探测在跑');
    H._endProbe();
    assert.equal(H._probeBar, null, '未显示过则直接清除（快速探测不闪现）');
});

test('_endProbe：已显示进度则展示「已完成」并延迟隐藏', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = loadHome();
    const H = home(ctx);
    let shown = null;
    H._updateProbeBar = (done) => { shown = done; };
    H._hideProbeBar = () => {};
    H._startProbe(5);
    H._probeBar.shown = true; // 模拟已超过 1s 显示
    H._probeOneDone();
    H._endProbe();
    assert.equal(shown, true, '全部完成后走「已完成」态');
    assert.equal(H._probeBar.done, 5);
    assert.ok(H._probeBar.doneTimer, '调度延迟隐藏');
    t.mock.timers.tick(1500);
    assert.equal(H._probeBar, null, '1.5s 后清除');
});

test('_startProbe：total<=0 不计入进度', () => {
    const ctx = loadHome();
    const H = home(ctx);
    assert.equal(H._startProbe(0), false);
    assert.equal(H._startProbe(-1), false);
    assert.equal(H._probeBar, null);
});

// ---------------------------------------------------------------- renderClass 过滤（T60）

function renderWith(classes, emptySet, activeTid) {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    H.classes = classes;
    if (emptySet) H._emptyCls.s = emptySet;
    let captured = '';
    ctx.$ = (sel) => ({ empty() { return this; }, html(s) { captured = s; } });
    H.renderClass(activeTid);
    return captured;
}

test('renderClass：空分类隐藏、有内容保留、「全部」保留', () => {
    const html = renderWith([
        { type_id: 'movie', type_name: '电影' },
        { type_id: 'serie', type_name: '剧集' },
    ], new Set(['movie']), '');
    assert.match(html, /全部/);
    assert.match(html, /剧集/);
    assert.doesNotMatch(html, /电影/);
});

test('renderClass：激活分类即使为空也不隐藏', () => {
    const html = renderWith([
        { type_id: 'movie', type_name: '电影' },
        { type_id: 'serie', type_name: '剧集' },
    ], new Set(['movie']), 'movie');
    assert.match(html, /电影/, '激活分类应保留');
    assert.match(html, /剧集/);
});

test('renderClass：type_id 数字/字符串归一化，激活空分类不误隐藏', () => {
    const html = renderWith([{ type_id: 123, type_name: '数字分类' }], new Set(['123']), '123');
    assert.match(html, /数字分类/, '数字 type_id 归一化为字符串后激活分类应保留');
});

// ---------------------------------------------------------------- 持久化（T60 加固）

test('持久化：写入（时间戳 + empty/ok）→ 载入往返，清空后 key 移除', () => {
    const ctx = loadHome();
    const H = home(ctx);
    H._emptyCls.s = new Set(['movie', 'serie']);
    H._okCls.s = new Set(['ok1']);
    H._emptyCls.other = new Set(['x']);
    H._persistEmptyClasses();
    const raw = JSON.parse(ctx.__ls.getItem('vpc_home_empty_classes'));
    assert.deepEqual([...raw.s.empty].sort(), ['movie', 'serie']);
    assert.deepEqual([...raw.s.ok], ['ok1']);
    assert.ok(typeof raw.s.ts === 'number', '落盘含时间戳');
    assert.deepEqual(raw.other.empty, ['x']);
    // 新会话（共享同一 localStorage 桩）载入
    const ctx2 = loadHome(ctx.__lsStore);
    const H2 = home(ctx2);
    H2._loadPersistedEmptyClasses();
    assert.deepEqual([...H2._emptyCls.s].sort(), ['movie', 'serie'], '载入还原持久化空分类');
    assert.deepEqual([...H2._okCls.s], ['ok1'], '载入还原有内容分类');
    assert.deepEqual([...H2._emptyCls.other], ['x']);
    assert.ok(H2._clsTs.s > 0, '时间戳载入');
    assert.ok(H2._clsStarted.s, '新鲜数据标记已开始（首次只探未知）');
    // 清空
    H2._clearPersistedEmptyClasses();
    assert.equal(ctx2.__ls.getItem('vpc_home_empty_classes'), null, '清空后 key 移除');
});

test('持久化：旧格式 { site: [tids] } 兼容，按过期处理（重新探测）', () => {
    const ctx = loadHome();
    ctx.__ls.setItem('vpc_home_empty_classes', JSON.stringify({ s: ['movie'] }));
    const H = home(ctx);
    H._loadPersistedEmptyClasses();
    assert.deepEqual([...H._emptyCls.s], ['movie'], '旧格式空分类仍载入');
    assert.ok(!H._clsStarted.s, '旧格式无时间戳 → 视为过期，需重新探测');
});

test('持久化：数据新鲜 → 探测只补未知分类，不重复探测已知', async () => {
    const ctx = loadHome();
    ctx.__ls.setItem('vpc_home_empty_classes', JSON.stringify({
        s: { ts: Date.now(), empty: ['a'], ok: ['b'] },
    }));
    const H = home(ctx);
    H._loadPersistedEmptyClasses();
    H.classes = [{ type_id: 'a', type_name: 'A' }, { type_id: 'b', type_name: 'B' }, { type_id: 'c', type_name: 'C' }];
    const calls = [];
    ctx.doAction = async (action, kv) => { calls.push(kv.tid); return { list: [] }; };
    await H._probeClasses();
    assert.deepEqual([...calls], ['c'], '新鲜数据只探测未知分类 c');
    assert.ok(H._emptyCls.s.has('a'), '载入的空分类保留');
    assert.ok(H._okCls.s.has('b'), '载入的有内容分类保留');
    assert.ok(H._clsProbed.s, '全部分类已知 → 标记完成');
});

test('持久化：数据过期 → 探测全量重探（刷新分类状态）', async () => {
    const ctx = loadHome();
    ctx.__ls.setItem('vpc_home_empty_classes', JSON.stringify({
        s: { ts: Date.now() - 2 * 24 * 3600 * 1000, empty: ['a'], ok: ['b'] }, // 48h 前
    }));
    const H = home(ctx);
    H._loadPersistedEmptyClasses();
    H.classes = [{ type_id: 'a', type_name: 'A' }, { type_id: 'b', type_name: 'B' }];
    const calls = [];
    ctx.doAction = async (action, kv) => {
        calls.push(kv.tid);
        return kv.tid === 'a' ? { list: [] } : { list: [{ vod_id: '1' }] };
    };
    await H._probeClasses();
    assert.deepEqual([...calls].sort(), ['a', 'b'], '过期数据全量重探');
    assert.ok(H._emptyCls.s.has('a'));
    assert.ok(H._okCls.s.has('b'));
    assert.ok(H._clsProbed.s);
});

test('持久化：损坏数据按空处理（重新探测）', () => {
    const ctx = loadHome();
    ctx.__ls.setItem('vpc_home_empty_classes', '{not-json');
    const H = home(ctx);
    H._loadPersistedEmptyClasses();
    assert.equal(H._emptyCls.s || undefined, undefined, '损坏数据忽略');
});

// ---------------------------------------------------------------- 源搜索分页器（T## 页码无限增长修复）

/** 搜索态测试环境：可注入搜索词与 doAction，渲染方法桩掉。 */
function searchEnv(doActionImpl) {
    const ctx = loadHome();
    const H = home(ctx);
    let word = '';
    ctx.$ = (sel) => ({
        on() { return this; }, off() { return this; }, empty() { return this; },
        html() {}, val() { return word; }, removeClass() { return this; },
    });
    H.renderGrid = () => {};
    H.renderPager = () => {};
    ctx.doAction = doActionImpl;
    ctx.__setWord = (w) => { word = w; };
    return ctx;
}

test('searchCurrent：源返回 pagecount 时直接采用（不叠加增长）', async () => {
    const ctx = searchEnv(async () => ({ pagecount: 9, list: makeItems('x-', 20) }));
    const H = ctx.__Home;
    ctx.__setWord('海贼王');
    await H.searchCurrent(1);
    assert.equal(H.pagecount, 9, 'pagecount 有效则直接用源值');
    await H.searchCurrent(2);
    assert.equal(H.pagecount, 9, '翻页后仍用源值，不因 Math.max 增长');
});

test('searchCurrent：伪分页源（每页同一批结果、无 pagecount）页码不无限增长', async () => {
    const ctx = searchEnv(async () => ({ list: makeItems('same-', 20) }));
    const H = ctx.__Home;
    ctx.__setWord('海贼王');
    await H.searchCurrent(1);
    assert.equal(H.pagecount, 2, '第一页有新条目：允试下一页');
    await H.searchCurrent(2);
    assert.equal(H.pagecount, 2, '第二页全是重复：页码停止增长');
    await H.searchCurrent(3);
    await H.searchCurrent(4);
    assert.equal(H.pagecount, 2, '继续翻页页码保持 2，不再无限增加');
});

test('searchCurrent：真实分页源无 pagecount 但每页有新条目 → 页码随内容增长', async () => {
    const ctx = searchEnv(async (a, kv) => ({ list: makeItems('p' + kv.pg + '-', 20) }));
    const H = ctx.__Home;
    ctx.__setWord('海贼王');
    await H.searchCurrent(1);
    assert.equal(H.pagecount, 2);
    await H.searchCurrent(2);
    assert.equal(H.pagecount, 3, '每页都有新内容时仍允许继续翻页');
    await H.searchCurrent(3);
    assert.equal(H.pagecount, 4);
    // 回看已访问页：全部重复 → 页码钉住不回缩
    await H.searchCurrent(2);
    assert.equal(H.pagecount, 4, '回看旧页页码不回缩');
});

test('searchCurrent：空结果页回退页码（max(1, page-1)）', async () => {
    const ctx = searchEnv(async (a, kv) => (parseInt(kv.pg, 10) === 1 ? { list: makeItems('a-', 20) } : { list: [] }));
    const H = ctx.__Home;
    ctx.__setWord('海贼王');
    await H.searchCurrent(1);
    assert.equal(H.pagecount, 2);
    await H.searchCurrent(2);
    assert.equal(H.pagecount, 1, '第 2 页为空：页码回退到 1');
});

test('searchCurrent：换词/重搜重置已见记录与残留页码', async () => {
    const ctx = searchEnv(async (a, kv) => ({ list: makeItems('a-', 20) }));
    const H = ctx.__Home;
    ctx.__setWord('海贼王');
    await H.searchCurrent(1);
    await H.searchCurrent(2); // 全部已见，页码停在 2
    assert.equal(H.pagecount, 2);
    // 模拟残留巨值 + 重新输入同一词搜索（从 home 模式进入 = 新一轮）
    H.pagecount = 50;
    H.mode = 'home';
    await H.searchCurrent(1);
    assert.equal(H.pagecount, 2, '重搜丢弃残留巨值，从新第一页重新推算');
    assert.equal(H._searchSeen.key, 's|海贼王');
    assert.equal(H._searchSeen.ids.size, 20, '重搜后已见记录重置');
    // 换词同样重置
    ctx.__setWord('另一部');
    await H.searchCurrent(1);
    assert.equal(H._searchSeen.key, 's|另一部', '换词按 site|word 隔离已见记录');
    assert.equal(H._searchSeen.ids.size, 20);
});
