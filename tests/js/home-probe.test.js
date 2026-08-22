'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 在 VM 中加载 common.js + home.js，注入最小全局桩；localStorage 为内存 Map 桩（T60 持久化）。
 *  sharedStore：可传入外部 Map 以共享 localStorage（跨 vm 上下文测持久化往返）。 */
function loadHome(sharedStore) {
    const cacheSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/cache.js'), 'utf8');
    const commonSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/common.js'), 'utf8');
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/home.js'), 'utf8');
    const lsStore = sharedStore || new Map();
    const ls = {
        getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
        setItem: (k, v) => lsStore.set(k, String(v)),
        removeItem: (k) => lsStore.delete(k),
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, document: {},
        localStorage: ls,
        $: () => ({ on() { return this; }, off() { return this; }, empty() { return this; }, html() {}, val() { return ''; } }),
        window: { vpc: { settingsGet: async () => ({}), settingsSet: async () => {} }, localStorage: ls },
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
    vm.runInContext(`${cacheSrc}\n;${commonSrc}\n;${source}`, context, { filename: 'home.js' });
    // common.js 的真实实现会重定义这些依赖 DOM/后端的函数（showLoading 里就有 $().find），
    // 加载后重新打桩覆盖；纯函数（errorTextOf/escHtml 等）保留真实实现供断言。
    // cache.js 把 localCache* 挂在 window 上，桥接成 VM 全局供 home.js 裸引用。
    vm.runInContext(`
        ;globalThis.__Home = Home; globalThis.__errorTextOf = errorTextOf;
        ;localCacheGet = (typeof window.localCacheGet === 'function') ? window.localCacheGet : (() => null);
        ;localCacheSet = (typeof window.localCacheSet === 'function') ? window.localCacheSet : (() => {});
        ;warnToast = () => {}; showLoading = () => {}; hideLoading = () => {};
        ;fillMissingCovers = () => {}; fitVodTitles = () => {}; renderStatusBar = () => {}; renderPagerBox = () => {};
        ;confirmDialog = async () => true; doAction = async () => ({ list: [] }); pageSizeOf = async () => 20;`, context);
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
    H._probeStartDelayMs = 0; // 探测延迟启动不真等 8s（用例可按需覆盖）
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

test('源自动检测关闭：不执行源/分类探测，也不应用历史空分类结果', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H._autoProbeEnabled = false;
    H._allSites = [{ key: 's' }];
    H._emptyCls.s = new Set(['movie']);
    H.classes = [{ type_id: 'movie', type_name: '电影' }];
    let calls = 0;
    ctx.doAction = async () => { calls++; return { list: [] }; };
    await H._probeSites();
    await H._probeClasses();
    assert.equal(calls, 0, '关闭后不应发起任何后台探测');
    const html = renderWith(H.classes, H._emptyCls.s, '', false);
    assert.match(html, /电影/, '关闭后历史空分类仍应显示');
});

test('_getBlocked：关闭源自动检测时忽略历史 blockedSites', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    const disabled = await H._getBlocked({ sourceAutoDetect: false, blockedSites: ['s'] });
    const enabled = await H._getBlocked({ sourceAutoDetect: true, blockedSites: ['s'] });
    assert.equal(disabled.length, 0);
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0], 's');
});

// ---------------------------------------------------------------- 全源后台探测（T60）

/** 源级探测环境：注入 settingsGet/settingsSet 捕获与 doAction 桩，渲染方法桩掉。 */
function probeEnv(doActionImpl) {
    const ctx = loadHome();
    const H = home(ctx);
    H._allSites = [{ key: 's' }];
    H._updateProbeBar = () => {};
    H._renderSiteSelect = () => {};
    H._probeRetryDelayMs = 0; // 轮内二次确认不真等 3s
    const sets = {};
    ctx.window.vpc.settingsSet = async (k, v) => { sets[k] = v; };
    ctx.doAction = doActionImpl;
    ctx.__sets = sets;
    return ctx;
}

/** 跨「启动轮次」的有状态探测环境：settingsSet 写入的值会在下一轮 settingsGet 读回。 */
function statefulEnv(doActionImpl) {
    const ctx = probeEnv(doActionImpl);
    const store = {};
    ctx.window.vpc.settingsGet = async () => ({ ...store });
    ctx.window.vpc.settingsSet = async (k, v) => { store[k] = v; };
    ctx.__store = store;
    return ctx;
}

test('_probeSites：homeContent 失败包络（ok:false/error/原始串）不屏蔽，留待下次重试', async () => {
    // 后端 spider 超时/异常返回 RuntimeResponse 失败包络（HTTP 非 2xx 但 fetch 不抛异常）
    for (const failed of [
        { ok: false, error: { code: 'L3_RUNTIME_TIMEOUT', message: '站点响应超时' } },
        { list: [], error: { code: 'L3_RUNTIME_CALL_FAILED', message: '接口异常' } },
        'gateway timeout', // 非 JSON 原始文本
        null,
    ]) {
        const ctx = probeEnv(async () => failed);
        const H = ctx.__Home;
        await H._probeSites();
        assert.ok(!ctx.__sets.probedSites || !ctx.__sets.probedSites.includes('s'),
            `失败响应 ${JSON.stringify(failed)} 不应写入 probedSites`);
        assert.ok(!ctx.__sets.blockedSites, '失败响应不应触发屏蔽');
    }
});

test('_probeSites：推荐位为空但分类返回失败包络 → 证据不足不屏蔽', async () => {
    const ctx = probeEnv(async (action) => (action === 'homeContent'
        ? { list: [], class: [{ type_id: 'a', type_name: 'A' }, { type_id: 'b', type_name: 'B' }] }
        : { ok: false, error: { code: 'L3_RUNTIME_TIMEOUT', message: '超时' } }));
    const H = ctx.__Home;
    await H._probeSites();
    assert.ok(!ctx.__sets.blockedSites, '分类确认全部出错时不下「无内容」结论');
    assert.ok(!ctx.__sets.probedSites || !ctx.__sets.probedSites.includes('s'), '留待下次重试');
});

test('_probeSites：真僵尸源（推荐位与全部分类均确认为空）两轮确认后正确屏蔽', async () => {
    const ctx = statefulEnv(async (action) => (action === 'homeContent'
        ? { list: [], class: [{ type_id: 'a', type_name: 'A' }] }
        : { list: [] }));
    const H = ctx.__Home;
    await H._probeSites();
    assert.ok(!ctx.__store.blockedSites, '单轮确认空不屏蔽（防软限流/预热误杀有影片的源）');
    assert.equal(ctx.__store.probeFailStreak.s, 1, '空确认计入连败');
    assert.ok((ctx.__store.blockedSites || []).length === 0);
    await H._probeSites();
    assert.deepEqual(ctx.__store.blockedSites, ['s'], '连续两轮确认全空才按无内容屏蔽');
    assert.ok(ctx.__store.probedSites.includes('s'));
    assert.equal(ctx.__store.blockedReason.s, 'empty', '屏蔽原因标注为无内容');
});

// ---------------------------------------------------------------- 死源连败屏蔽 + 复查

test('死源连败计数：连续 2 轮完全无响应 → 按死源屏蔽（reason=dead），单轮失败不屏蔽', async () => {
    const ctx = statefulEnv(async () => ({ ok: false, error: { code: 'L3_RUNTIME_TIMEOUT', message: '超时' } }));
    const H = ctx.__Home;
    await H._probeSites(); // 第 1 轮（含轮内重试）：证据不足
    assert.ok(!ctx.__store.blockedSites, '单轮失败不得屏蔽（防误杀瞬时故障）');
    assert.equal(ctx.__store.probeFailStreak.s, 1, '连败计数 +1');
    assert.ok(!ctx.__store.probedSites.includes('s'), '未定论不写 probedSites');
    await H._probeSites(); // 第 2 轮：达到阈值 → 按死源屏蔽
    assert.deepEqual(ctx.__store.blockedSites, ['s'], '连续 2 轮（各含二次确认）无响应按死源屏蔽');
    assert.equal(ctx.__store.blockedReason.s, 'dead', '屏蔽原因标注为连续无响应');
    assert.ok(!ctx.__store.probeFailStreak.s, '屏蔽后连败计数清除');
});

test('_resetSessionEvidence：会话开始清空跨会话连败欠账', async () => {
    const ctx = statefulEnv(async () => ({ list: [{ vod_id: '1' }] }));
    ctx.__store.probeFailStreak = { s: 1, other: 2 }; // 上次会话遗留（冷启动慢/中断探测）
    const H = ctx.__Home;
    await H._resetSessionEvidence();
    assert.equal(Object.keys(ctx.__store.probeFailStreak).length, 0, '跨会话欠账清零：本次一轮失败不再直接越限');
    await H._probeSites(); // 有内容的源正常出结论
    assert.ok((ctx.__store.probedSites || []).includes('s'));
});

// ---------------------------------------------------------------- 探测状态内容指纹（probeFp）

test('探测状态指纹迁移：旧版屏蔽/结论无指纹 → 作废重探，新结论附带指纹（自愈误屏蔽）', async () => {
    const ctx = statefulEnv(async () => ({ list: [{ vod_id: '1', vod_name: 'x' }] }));
    const H = ctx.__Home;
    // 旧版遗留：被屏蔽的「空源」在合并换主后同名 key 实际指向了可用新源——
    // 无指纹守卫时新鲜 probedAt 会跳过重探，可用源被永久隐藏（本 bug 的受害现场）
    Object.assign(ctx.__store, {
        blockedSites: ['s'],
        blockedReason: { s: 'empty' },
        probedSites: ['s'],
        probedAt: { s: Date.now() },
    });
    await H._probeSites();
    assert.deepEqual(ctx.__store.blockedSites, [], '旧屏蔽作废并回写清除，源恢复展示');
    assert.ok((ctx.__store.probedSites || []).includes('s'), '重新探测出结论');
    assert.equal(ctx.__store.probeFp.s, '|', '新结论绑定当前内容指纹');
    assert.ok(!ctx.__store.blockedReason || !ctx.__store.blockedReason.s, '屏蔽原因同步清除');
});

test('探测状态指纹复用：结论指纹与当前内容一致且新鲜 → 零请求不重探', async () => {
    let calls = 0;
    const ctx = statefulEnv(async () => { calls++; return { list: [] }; });
    const H = ctx.__Home;
    Object.assign(ctx.__store, {
        probedSites: ['s'],
        probedAt: { s: Date.now() },
        probeFp: { s: '|' },
    });
    await H._probeSites();
    assert.equal(calls, 0, '同仓重启场景：结论照常复用，不发探测请求');
});

test('探测状态指纹失效：同名 key 内容变更（合并漂移）→ 新鲜结论也作废重探', async () => {
    let probes = 0;
    const ctx = statefulEnv(async () => { probes++; return { list: [{ vod_id: '1', vod_name: 'x' }] }; });
    const H = ctx.__Home;
    Object.assign(ctx.__store, {
        probedSites: ['s'],
        probedAt: { s: Date.now() },
        probeFp: { s: 'http://old/api.php|cms0' },
    });
    await H._probeSites();
    assert.ok(probes > 0, '内容变更后即使结论新鲜也重探（防张冠李戴双向生效）');
    assert.equal(ctx.__store.probeFp.s, '|', '重探后写入当前内容的指纹');
    assert.ok((ctx.__store.probedSites || []).includes('s'), '新结论正常持久化');
});

// ---------------------------------------------------------------- 同会话补探第二轮 + 换仓重置

test('同会话补探第二轮：首轮证据不足隔 PROBE_ROUND2_DELAY 补测，连败达标即本次会话内按死源屏蔽', async () => {
    const ctx = statefulEnv(async () => ({ ok: false, error: { code: 'L3_RUNTIME_TIMEOUT', message: '超时' } }));
    const H = ctx.__Home;
    H._probeRound2DelayMs = 5; // 不真等 30s
    await H._probeSites(); // 第 1 轮（含轮内二次确认）：证据不足，未达阈值
    assert.equal(ctx.__store.probeFailStreak.s, 1, '连败计数 +1');
    assert.ok(!ctx.__store.blockedSites, '单轮失败不得屏蔽');
    assert.ok(H._probeRound2Timer, '已调度同会话补探');
    assert.deepEqual([...H._probeRound2Keys], ['s'], '补测目标为证据不足源（VM realm 数组展开后比较）');
    for (let i = 0; i < 200 && !ctx.__store.blockedSites; i++) {
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.deepEqual(ctx.__store.blockedSites, ['s'], '补测轮连败达标 → 本次会话内即按死源屏蔽');
    assert.equal(ctx.__store.blockedReason.s, 'dead', '屏蔽原因标注为连续无响应');
    assert.equal(H._probeRound2Timer, null, '补测轮自终止：不再续期');
});

test('同会话补探第二轮：补测时源恢复响应 → 正常出结论，不再调度', async () => {
    let calls = 0;
    const ctx = statefulEnv(async () => {
        calls++;
        return calls <= 2
            ? { ok: false, error: { code: 'L3_RUNTIME_TIMEOUT', message: '超时' } }
            : { list: [{ vod_id: '1', vod_name: 'x' }] };
    });
    const H = ctx.__Home;
    H._probeRound2DelayMs = 5;
    await H._probeSites(); // 第 1 轮：首次+二次确认均失败 → 证据不足
    assert.ok(H._probeRound2Timer, '已调度补探');
    for (let i = 0; i < 200 && !((ctx.__store.probedSites || []).includes('s')); i++) {
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok((ctx.__store.probedSites || []).includes('s'), '补测轮拿到内容 → 记结论');
    assert.ok(!ctx.__store.blockedSites, '有内容不屏蔽');
    assert.ok(!ctx.__store.probeFailStreak.s, '成功清除连败计数');
    assert.equal(H._probeRound2Timer, null, '有结论后不再调度');
});

/** 换仓重置测试环境：settings 走共享 store（可预置旧仓状态），getJson 可注入站点列表。 */
function repoEnv(getJsonImpl, initialStore) {
    const ctx = loadHome();
    const H = home(ctx);
    const store = Object.assign({}, initialStore || {});
    ctx.window.vpc.settingsGet = async () => ({ ...store });
    ctx.window.vpc.settingsSet = async (k, v) => { store[k] = v; };
    H._getSourceSettings = async () => ({ ...(await ctx.window.vpc.settingsGet()) });
    H.setAutoProbeEnabled = () => {}; // 保持默认开启
    H.invalidatePageCaches = () => {};
    H._renderSiteSelect = () => {};
    H.loadHome = async () => {};
    H._probeSites = () => {};     // 探测延迟启动的入口桩掉
    H._probeAllClasses = () => {};
    ctx.getJson = getJsonImpl;
    ctx.__store = store;
    return ctx;
}

test('换仓重置：配置 URL 变化时清空探测/屏蔽记录，旧仓屏蔽的同名 key 不再误隐藏', async () => {
    // 同名 key 张冠李戴场景：旧仓把 zy_1 屏蔽/标已探过，换到新仓后同名 zy_1 是不同源，
    // 若沿用旧记录会「误隐藏 + 漏探测」，表现为换仓后无法屏蔽无影视的源。
    const ctx = repoEnv(
        async () => ({ sites: [REAL_SITE] }),
        {
            lastConfigUrl: 'http://new/repo.json',
            probeSourceUrl: 'http://old/repo.json',
            blockedSites: ['zy_1'],
            blockedReason: { zy_1: 'empty' },
            probedSites: ['zy_1'],
            probedAt: { zy_1: Date.now() },
        },
    );
    const H = ctx.__Home;
    await H.loadSites();
    // 重置块写入的空数组/对象是 VM realm 字面量：先展开成宿主 realm 再断言
    assert.deepEqual([...(ctx.__store.blockedSites || [])], [], '旧仓屏蔽记录清空');
    assert.deepEqual([...(ctx.__store.probedSites || [])], [], '旧仓已探记录清空（新仓从零全量探测）');
    assert.deepEqual({ ...(ctx.__store.blockedReason || {}) }, {});
    assert.deepEqual({ ...(ctx.__store.probedAt || {}) }, {});
    assert.deepEqual({ ...(ctx.__store.probeFailStreak || {}) }, {});
    assert.equal(ctx.__store.probeSourceUrl, 'http://new/repo.json', '仓标识更新为新 URL');
    assert.deepEqual(H.sites.map((s) => s.key), ['zy_1'], '同名 key 不再被旧仓屏蔽记录误隐藏');
});

test('换仓重置：localStorage 空分类缓存一并作废（按 site key 复用的结论同样张冠李戴）', async () => {
    const ctx = repoEnv(
        async () => ({ sites: [REAL_SITE] }),
        {
            lastConfigUrl: 'http://new/repo.json',
            probeSourceUrl: 'http://old/repo.json',
        },
    );
    const H = ctx.__Home;
    ctx.__ls.setItem('vpc_home_empty_classes', JSON.stringify({ zy_1: { ts: Date.now(), empty: ['a'], ok: [] } }));
    H._loadPersistedEmptyClasses(); // 模拟启动载入旧仓分类结论
    await H.loadSites();
    assert.deepEqual(H._emptyCls.zy_1, undefined, '内存镜像清空');
    assert.equal(ctx.__ls.getItem('vpc_home_empty_classes'), null, '持久化空分类缓存清除');
    assert.ok(!H._clsStarted.zy_1 && !H._clsTs.zy_1, '新仓该源重新全量探测分类');
});

test('同仓重启：配置 URL 未变化时保留探测/屏蔽记录（多仓漂移仍按 key 集签名处理）', async () => {
    const ctx = repoEnv(
        async () => ({ sites: [REAL_SITE] }),
        {
            lastConfigUrl: 'http://same/repo.json',
            probeSourceUrl: 'http://same/repo.json',
            blockedSites: ['other'],
            blockedReason: { other: 'dead' },
            probedSites: ['other'],
            probedAt: { other: Date.now() },
        },
    );
    const H = ctx.__Home;
    await H.loadSites();
    assert.deepEqual(ctx.__store.blockedSites, ['other'], '同仓不重置屏蔽记录');
    assert.deepEqual(ctx.__store.probedSites, ['other']);
    assert.equal(ctx.__store.probeSourceUrl, 'http://same/repo.json', '仓标识保持不变');
});

test('内嵌 error 但返回影片 → 内容优先于错误，判可用不屏蔽', async () => {
    const ctx = statefulEnv(async (action) => (action === 'homeContent'
        ? { list: [{ vod_id: '1' }], error: { code: 'L3_RUNTIME_CALL_FAILED', message: '部分线路失败' } }
        : { list: [{ vod_id: '1' }], error: { code: 'L3_RUNTIME_CALL_FAILED', message: '部分线路失败' } }));
    const H = ctx.__Home;
    await H._probeSites();
    assert.ok(!ctx.__store.blockedSites, '有真实影片的源不得屏蔽');
    assert.ok(ctx.__store.probedSites.includes('s'), '内容即结论');
    assert.ok(!ctx.__store.probeFailStreak.s, '不算连败');
});

test('分类返回内嵌 error 且有影片 → 该分类按有内容计', async () => {
    const ctx = statefulEnv(async (action) => (action === 'homeContent'
        ? { list: [], class: [{ type_id: 'a', type_name: 'A' }] }
        : { list: [{ vod_id: '1' }], error: { code: 'L3_RUNTIME_CALL_FAILED', message: '附错误' } }));
    const H = ctx.__Home;
    await H._probeSites();
    assert.ok(!ctx.__store.blockedSites, '分类有内容 → 源可用');
    assert.ok(ctx.__store.probedSites.includes('s'));
});

test('renderGrid 空态提示：内嵌 error 对象显示 code+message，不再出现 [object Object]', () => {
    const ctx = loadHome();
    const H = ctx.__Home;
    let captured = '';
    ctx.$ = (sel) => ({ empty() { return this; }, html(s) { captured = s; } });
    H.renderGrid([], { code: 'L3_RUNTIME_CALL_FAILED', message: '蜘蛛调用失败', stage: 'site' });
    assert.match(captured, /L3_RUNTIME_CALL_FAILED 蜘蛛调用失败/, '显示 code + message');
    assert.doesNotMatch(captured, /\[object Object\]/);
    // 嵌套 {error:{...}} 与纯字符串同样可读
    H.renderGrid([], { error: { code: 'L3_RUNTIME_TIMEOUT', message: '超时' } });
    assert.match(captured, /L3_RUNTIME_TIMEOUT 超时/);
    H.renderGrid([], 'gateway timeout');
    assert.match(captured, /gateway timeout/);
    H.renderGrid([], null);
    assert.doesNotMatch(captured, /（/, '无错误时不带括号');
});

test('errorTextOf：各形态错误值的文案提取', () => {
    const f = loadHome().__errorTextOf;
    assert.equal(f({ code: 'L1_CONFIG_TIMEOUT', message: '配置加载超时' }), 'L1_CONFIG_TIMEOUT 配置加载超时');
    assert.equal(f({ error: { message: '嵌套' } }), '嵌套');
    assert.equal(f(new Error('boom')), 'boom');
    assert.equal(f('裸字符串'), '裸字符串');
    assert.equal(f({ foo: 1 }), '{"foo":1}');
    assert.equal(f(null), '');
    assert.ok(f({ message: 'x'.repeat(300) }, 100).length <= 101, '超长截断');
});

test('轮内二次确认：首次失败重试成功 → 不计连败、不屏蔽', async () => {
    let calls = 0;
    const ctx = statefulEnv(async () => {
        calls++;
        return calls === 1
            ? { ok: false, error: { code: 'L3_RUNTIME_TIMEOUT', message: '超时' } }
            : { list: [{ vod_id: '1', vod_name: 'x' }] };
    });
    const H = ctx.__Home;
    await H._probeSites();
    assert.equal(calls, 2, '轮内应重试一次');
    assert.ok(!ctx.__store.blockedSites, '重试成功不屏蔽');
    assert.ok(ctx.__store.probedSites.includes('s'), '重试成功即有结论');
    assert.ok(!ctx.__store.probeFailStreak.s, '成功清除连败计数');
});

test('复查：屏蔽源恢复内容 → 自动解除屏蔽并清除原因', async () => {
    let homeResp = { list: [], class: [{ type_id: 'a', type_name: 'A' }] };
    const ctx = statefulEnv(async (action) => (action === 'homeContent' ? homeResp : { list: [] }));
    const H = ctx.__Home;
    await H._probeSites();
    await H._probeSites();
    assert.deepEqual(ctx.__store.blockedSites, ['s'], '先按无内容屏蔽（两轮确认）');
    // 结论过期（超过复查周期），且源恢复了内容
    ctx.__store.probedAt = { s: Date.now() - 8 * 24 * 3600 * 1000 };
    homeResp = { list: [{ vod_id: '1', vod_name: '复活' }] };
    await H._probeSites();
    assert.deepEqual(ctx.__store.blockedSites, [], '复查发现内容 → 自动解除屏蔽');
    assert.ok(!ctx.__store.blockedReason.s, '解除后屏蔽原因清除');
});

test('复查：屏蔽源复查仍无内容 → 保持屏蔽并刷新复查时间（新鲜期内不再重探）', async () => {
    const resp = () => ({ list: [], class: [{ type_id: 'a', type_name: 'A' }] });
    let calls = 0;
    const ctx = statefulEnv(async (action) => { calls++; return action === 'homeContent' ? resp() : { list: [] }; });
    const H = ctx.__Home;
    await H._probeSites();
    await H._probeSites();
    assert.deepEqual(ctx.__store.blockedSites, ['s']);
    ctx.__store.probedAt = { s: Date.now() - 8 * 24 * 3600 * 1000 }; // 过期复查
    await H._probeSites(); // 复查第 1 轮：仍空 → 连败 1，保持屏蔽但结论未刷新
    assert.deepEqual(ctx.__store.blockedSites, ['s'], '复查仍空 → 保持屏蔽');
    await H._probeSites(); // 复查第 2 轮：连败达标 → 结论刷新
    assert.deepEqual(ctx.__store.blockedSites, ['s'], '复查仍空 → 保持屏蔽');
    assert.ok(ctx.__store.probedAt.s > Date.now() - 60 * 1000, '复查时间刷新为现在（非过期旧值）');
    const callsAfterRecheck = calls;
    await H._probeSites(); // 新鲜期内：不再探测
    assert.equal(calls, callsAfterRecheck, '新鲜期内不重复探测');
});

test('复查：结论过期的可用源重新探测（内容失效后补屏蔽）', async () => {
    let homeResp = { list: [{ vod_id: '1' }] };
    const ctx = statefulEnv(async () => homeResp);
    const H = ctx.__Home;
    await H._probeSites();
    assert.ok(ctx.__store.probedSites.includes('s'), '首次有内容');
    assert.ok(!ctx.__store.blockedSites);
    ctx.__store.probedAt = { s: Date.now() - 8 * 24 * 3600 * 1000 };
    homeResp = { list: [], class: [] }; // 内容失效
    await H._probeSites();
    await H._probeSites();
    assert.deepEqual(ctx.__store.blockedSites, ['s'], '连续两轮确认失效 → 补屏蔽');
    assert.equal(ctx.__store.blockedReason.s, 'empty');
});

test('迁移：旧版 probedSites 无时间戳且无指纹 → 一次性作废重探（自愈），此后稳定复用', async () => {
    let calls = 0;
    const ctx = statefulEnv(async () => { calls++; return { list: [{ vod_id: '1' }] }; });
    ctx.__store.probedSites = ['s']; // 旧格式：只有数组，没有 probedAt / probeFp
    const H = ctx.__Home;
    await H._probeSites();
    assert.equal(calls, 1, '旧结论无法证明内容未变 → 升级后首轮重探一次（自愈误屏蔽）');
    assert.ok(ctx.__store.probedAt && ctx.__store.probedAt.s > 0, '时间戳已补');
    assert.equal(ctx.__store.probeFp.s, '|', '新结论附带内容指纹');
    await H._probeSites();
    assert.equal(calls, 1, '带指纹的结论按原样复用：迁移只发生一次，不产生持续重探');
});

test('裁剪：离场源（多仓漂移）的探测记录不残留', async () => {
    const ctx = statefulEnv(async () => ({ list: [{ vod_id: '1' }] }));
    ctx.__store.probedSites = ['gone', 's'];
    ctx.__store.probedAt = { gone: Date.now(), s: 1 }; // s 过期 → 本轮重探
    ctx.__store.probeFailStreak = { gone: 2 };
    const H = ctx.__Home;
    await H._probeSites();
    assert.deepEqual(ctx.__store.probedSites, ['s'], '离场源从 probedSites 裁掉');
    assert.deepEqual(Object.keys(ctx.__store.probedAt), ['s']);
    assert.ok(!ctx.__store.probeFailStreak.gone, '离场源连败计数裁掉');
});

test('_probeSites：分级超时——首轮 20s 快速分类，二次确认 45s 给慢源长机会', async () => {
    const seen = [];
    const ctx = probeEnv(async (action, kv) => {
        seen.push({ action, deadlineMs: kv.deadlineMs, site: kv.site });
        if (seen.length === 1) return { ok: false, error: { code: 'L3_RUNTIME_TIMEOUT', message: '超时' } };
        return { list: [{ vod_id: '1' }] };
    });
    const H = ctx.__Home;
    await H._probeSites();
    const deadlines = seen.filter((x) => x.action === 'homeContent').map((x) => x.deadlineMs);
    assert.deepEqual(deadlines, [20000, 45000], '首轮快速分类，二次确认放长');
});

test('_probeSites：全量轮当前源置顶（首屏反馈优先，其余同轮并发补全）', async () => {
    const order = [];
    const ctx = probeEnv(async (action, kv) => {
        order.push(kv.site);
        return { list: [{ vod_id: '1' }] };
    });
    const H = ctx.__Home;
    H._allSites = Array.from({ length: 10 }, (_, i) => ({ key: 's' + i }));
    H.site = 's5'; // 当前源排在列表中间
    await H._probeSites();
    assert.equal(order[0], 's5', '当前源第一个被探测');
    assert.equal(order.length, 10, '全部源同轮探测（无需手动切换触发）');
});

test('_probeClassesFor：分类失败包络不判空也不标记完成（分类不被误隐藏）', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.classes = [{ type_id: 'a', type_name: 'A' }];
    H._loadToken = 1;
    spyRender(H, ctx);
    ctx.doAction = async () => ({ ok: false, error: { code: 'L3_RUNTIME_CALL_FAILED', message: '接口异常' } });
    await H._probeClasses();
    assert.equal(H._emptyCls.s.size, 0, '失败包络不判空（分类不从栏里消失）');
    assert.equal(H._okCls.s.size, 0);
    assert.ok(!H._clsProbed.s, '有未判定不标记完成，下次载入重试');
});

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

function renderWith(classes, emptySet, activeTid, autoProbeEnabled) {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    if (autoProbeEnabled !== undefined) H._autoProbeEnabled = autoProbeEnabled;
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

test('loadSites：后发配置完成后，旧的站点响应不得覆盖新配置', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H._getSourceSettings = async () => ({});
    H.setAutoProbeEnabled = (enabled) => { H._autoProbeEnabled = false; };
    H.invalidatePageCaches = () => {};
    H._getBlocked = async () => [];
    H._renderSiteSelect = () => {};
    H.loadHome = async () => {};
    H._probeSites = () => {};

    const pending = [];
    ctx.getJson = async () => new Promise((resolve) => pending.push(resolve));
    const first = H.loadSites();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 1, '第一次刷新应先发起站点列表请求');
    const second = H.loadSites();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 2, '第二次刷新也应发起站点列表请求');

    pending[1]({ sites: [{ key: 'new', name: '新配置', state: 'healthy', runtime: 'python' }] });
    await second;
    pending[0]({ sites: [{ key: 'old', name: '旧配置', state: 'healthy', runtime: 'python' }] });
    await first;

    assert.deepEqual(H._allSites.map((site) => site.key), ['new']);
    assert.deepEqual(H.sites.map((site) => site.key), ['new']);
});

// ---------------------------------------------------------------- demo 兜底与站点列表缓存

/** loadSites 测试环境：桩掉与 /sites 无关的旁路，getJson 可注入返回。 */
function sitesEnv(getJsonImpl) {
    const ctx = loadHome();
    const H = home(ctx);
    H._getSourceSettings = async () => ({});
    H.setAutoProbeEnabled = () => { H._autoProbeEnabled = false; };
    H.invalidatePageCaches = () => {};
    H._getBlocked = async () => [];
    H._renderSiteSelect = () => {};
    H.loadHome = async () => {};
    H._probeSites = () => {};
    ctx.getJson = getJsonImpl;
    return ctx;
}

const REAL_SITE = { key: 'zy_1', name: '资源一号', state: 'healthy', runtime: 'python' };
const DEMO_SITE = { key: 'demo', name: '示例源', state: 'healthy', runtime: 'python' };

test('loadSites：/sites 返回 demo 兜底时不写入站点缓存（示例源不是用户内容）', async () => {
    const ctx = sitesEnv(async () => ({ sites: [DEMO_SITE] }));
    await ctx.__Home.loadSites();
    assert.equal(ctx.__ls.getItem('vpc_cache::home::sites::v1'), null,
        'demo-only 不得写入站点列表缓存');
});

test('loadSites：真实站点列表正常写缓存，重启可预渲染', async () => {
    const ctx = sitesEnv(async () => ({ sites: [REAL_SITE, DEMO_SITE] }));
    await ctx.__Home.loadSites();
    assert.notEqual(ctx.__ls.getItem('vpc_cache::home::sites::v1'), null, '真实列表写缓存');
});

test('loadSites：已有真实站点展示时，demo-only /sites 不把示例源顶上屏', async () => {
    // 先以真实列表建立展示（预渲染路径同构），再模拟恢复窗口内 /sites 返回 demo
    const ctx = sitesEnv(async () => ({ sites: [REAL_SITE] }));
    const H = ctx.__Home;
    await H.loadSites();
    assert.deepEqual(H.sites.map((s) => s.key), ['zy_1']);
    ctx.getJson = async () => ({ sites: [DEMO_SITE] });
    await H.loadSites();
    assert.deepEqual(H.sites.map((s) => s.key), ['zy_1'],
        '恢复未完成期间保留真实站点展示，不被内置示例源顶掉');
    assert.deepEqual(H._allSites.map((s) => s.key), ['zy_1']);
});

test('首次运行（无配置无缓存）：demo-only 正常上屏为引导态', async () => {
    const ctx = sitesEnv(async () => ({ sites: [DEMO_SITE] }));
    const H = ctx.__Home;
    await H.loadSites();
    assert.deepEqual(H.sites.map((s) => s.key), ['demo'], '无任何配置时示例源正常展示');
    assert.equal(H.hasSiteCache(), false, 'demo-only 不算「有站点缓存」');
});

test('恢复窗口期（demo-only 且配置任务 loading）：显示恢复提示，不播 demo、不探测', async () => {
    const ctx = sitesEnv(async () => ({ sites: [DEMO_SITE] }));
    const H = ctx.__Home;
    let probeCalls = 0;
    H._probeSites = () => { probeCalls++; };
    H._probeAllClasses = () => {};
    H.loadHome = async () => { throw new Error('恢复期间不得加载首页内容'); };
    ctx.doAction = async () => ({ status: 'loading' }); // configTask → 恢复进行中
    let gridHtml = '';
    ctx.$ = (sel) => ({
        empty() { return this; }, on() { return this; }, val() { return ''; },
        html(s) { if (sel === '#home-grid') gridHtml = s; },
    });
    await H.loadSites();
    assert.match(gridHtml, /正在恢复上次的配置/, '首页显示恢复提示而非示例源');
    assert.equal(probeCalls, 0, '恢复期间不启动探测轮');
    assert.equal(H._probeStartTimer, null);
});

test('loadSites：探测轮延迟启动（先让首屏上屏，不与内容请求抢后端）', async () => {
    const ctx = sitesEnv(async () => ({ sites: [REAL_SITE] }));
    const H = ctx.__Home;
    H.setAutoProbeEnabled = () => {}; // 保持默认开启（sitesEnv 的桩会关掉）
    H._probeStartDelayMs = 15;
    let probeCalls = 0;
    H._probeSites = () => { probeCalls++; };
    H._probeAllClasses = () => {};
    await H.loadSites();
    assert.equal(probeCalls, 0, 'loadSites 完成时不立即探测');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(probeCalls, 1, '延迟后后台启动探测轮');
});

test('renderRestoreProgress：loading 时显示进度条（阶段文案+计数），结束隐藏', () => {
    const ctx = loadHome();
    const H = home(ctx);
    const state = { show: 0, hide: 0 };
    const barStub = () => ({ text() { return this; }, toggleClass() { return this; }, css() { return this; } });
    const el = {
        length: 1,
        children: () => ({ length: 0 }),
        html() { return this; }, empty() { return this; },
        find: barStub, toggleClass() { return this; },
        show() { state.show++; return this; },
        hide() { state.hide++; return this; },
    };
    ctx.$ = (sel) => (sel === '#home-restore-bar' ? el
        : { empty() { return this; }, html() {}, show() {}, hide() {} });
    // 恢复初期（无总数）→ 不定态进度条
    H.renderRestoreProgress({ status: 'loading', progress: { stage: 'restoring', current: 0, total: 0 } });
    assert.equal(state.show, 1, '恢复中显示进度条');
    // build 阶段（有总数）→ 百分比计数
    H.renderRestoreProgress({ status: 'loading', progress: { stage: 'build', current: 48, total: 64 } });
    assert.equal(state.show, 2);
    // 结束 → 隐藏
    H.renderRestoreProgress({ status: 'done' });
    assert.equal(state.hide, 1, '任务结束隐藏进度条');
    H.renderRestoreProgress(null);
    assert.equal(state.hide, 2);
});

test('_fetchHomeFeed：网络失败（失败包络）不把已上屏的缓存内容翻成「暂无内容」', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    H._loadToken = 1;
    // 预置持久化 feed 缓存（冷启动即时上屏源）
    ctx.__ls.setItem('vpc_cache::home::feed::v1::s',
        JSON.stringify({ v: { ts: Date.now(), pagecount: 1, items: makeItems('c-', 5) }, e: Date.now() + 60000, t: Date.now() }));
    H.renderGrid = () => {}; // 不碰 DOM
    H.renderPager = () => {};
    // 网络全部失败（配置恢复中，当前源还不在后端）
    ctx.doAction = async () => ({ ok: false, error: { code: 'L3_RUNTIME_CALL_FAILED', message: 'site not found' } });
    const items = await H._fetchHomeFeed(1, 20);
    assert.equal(items.length, 5, '保留已上屏的缓存内容');
    assert.deepEqual(items.map((v) => v.vod_id).slice(0, 2), ['c-0', 'c-1']);
});

test('_fetchHomeFeed：刷新场景（无缓存引导、已有旧内容）网络失败同样保留旧内容', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    H._loadToken = 1;
    H._homeList = makeItems('old-', 4); // 刷新前已渲染的旧内容
    H.renderGrid = () => {};
    H.renderPager = () => {};
    ctx.doAction = async () => ({ ok: false, error: { code: 'L2_SITE_NOT_FOUND', message: '站点不存在' } });
    const items = await H._fetchHomeFeed(1, 20);
    assert.equal(items.length, 4, '保留刷新前的旧内容，不显示「暂无内容」');
    assert.equal(items[0].vod_id, 'old-0');
});

test('恢复窗口期（_configPending）：刷新/搜索/分类入口直接提示，不发必败请求', async () => {
    const ctx = loadHome();
    const H = home(ctx);
    H.site = 's';
    H._configPending = true;
    H._homeList = makeItems('old-', 3);
    let calls = 0;
    let toasts = 0;
    ctx.doAction = async () => { calls++; return { list: [] }; };
    ctx.warnToast = () => { toasts++; };
    ctx.$ = (sel) => ({
        on() { return this; }, off() { return this; }, empty() { return this; },
        html() {}, val() { return sel === '#home-search' ? '海贼王' : ''; },
    });
    H.searchCurrent();
    await H.loadCategory('1', 1);
    assert.equal(calls, 0, '入口拦截，不发网络请求');
    assert.equal(toasts, 2, '搜索与分类各提示一次');
    assert.equal(H._homeList.length, 3, '已显示内容不被翻空');
    // 真实站点就绪后（_configPending=false）恢复正常
    H._configPending = false;
    await H.loadCategory('1', 1);
    assert.ok(calls >= 1, '就绪后分类请求正常发出');
});

test('searchCurrent：失败包络显示「源暂不可用」，不显示「未找到相关内容」', async () => {
    const ctx = searchEnv(async () => ({ ok: false, error: { code: 'L2_SITE_NOT_FOUND', message: '站点不存在' } }));
    const H = ctx.__Home;
    let gridHtml = '';
    ctx.$ = (sel) => ({
        on() { return this; }, off() { return this; }, empty() { return this; },
        html(s) { if (sel === '#home-grid') gridHtml = s; },
        val() { return '海贼王'; }, removeClass() { return this; },
    });
    ctx.__setWord('海贼王');
    H.renderPager = () => {};
    await H.searchCurrent(1);
    assert.match(gridHtml, /源暂不可用/, '失败包络按「暂不可用」提示');
    assert.doesNotMatch(gridHtml, /相关的内容/, '不得显示「未找到相关内容」误导用户');
});

test('_prerenderFromCache：历史脏数据（demo-only 缓存）不预渲染', async () => {
    const ctx = loadHome();
    ctx.__ls.setItem('vpc_cache::home::sites::v1',
        JSON.stringify({ v: [DEMO_SITE], e: Date.now() + 60000, t: Date.now() }));
    const H = home(ctx);
    H._renderSiteSelect = () => {};
    H._prerenderFromCache();
    assert.equal(H._allSites.length, 0, 'demo-only 缓存不预渲染');
    assert.equal(H.hasSiteCache(), false);
    // 真实缓存正常预渲染
    ctx.__ls.setItem('vpc_cache::home::sites::v1',
        JSON.stringify({ v: [REAL_SITE], e: Date.now() + 60000, t: Date.now() }));
    H._prerenderFromCache();
    assert.deepEqual(H._allSites.map((s) => s.key), ['zy_1'], '真实缓存照常预渲染');
    assert.equal(H.hasSiteCache(), true);
});

test('_prerenderFromCache：过滤屏蔽源，不自动选中屏蔽源为当前源', () => {
    const ctx = loadHome();
    // 缓存列表第一个是已屏蔽源（/sites 原始顺序）——不过滤会把它选为当前源，
    // 启动即对它发请求，恢复窗口期全是 L2_SITE_NOT_FOUND。
    // 屏蔽记录按内容指纹（probeFp）校验后生效：指纹与当前站点内容匹配才继续隐藏。
    const blockedSite = { key: 'blocked_1', name: '已屏蔽源', state: 'healthy', runtime: 'python', api: 'http://b/api.php', spiderType: 'cms0' };
    ctx.__ls.setItem('vpc_cache::home::sites::v1',
        JSON.stringify({ v: [blockedSite, REAL_SITE], e: Date.now() + 60000, t: Date.now() }));
    const H = home(ctx);
    H._renderSiteSelect = () => {};
    H._prerenderFromCache(['blocked_1'], { probeFp: { blocked_1: 'http://b/api.php|cms0' } });
    assert.deepEqual(H.sites.map((s) => s.key), ['zy_1'], '指纹匹配的屏蔽源不进预渲染下拉');
    assert.equal(H.site, 'zy_1', '当前源不落在屏蔽源上');
    assert.deepEqual(H._allSites.map((s) => s.key), ['blocked_1', 'zy_1'], '_allSites 保留全量（探测用）');
});

test('_validBlocked：指纹不匹配/缺失（旧版记录）的屏蔽不再隐藏源——合并换主自愈', () => {
    const ctx = loadHome();
    const H = home(ctx);
    const sitesList = [
        { key: 'k', api: 'http://a/api.php', spiderType: 'cms0' },   // 当前内容
        { key: 'plain', state: 'healthy' },
    ];
    // 指纹不匹配：同名 key 在合并后指向了不同 api → 旧屏蔽失效
    assert.deepEqual(
        H._validBlocked(sitesList, ['k'], { probeFp: { k: 'http://old/api.php|cms0' } }),
        [], '同名 key 内容变更后旧屏蔽不生效');
    // 指纹匹配：屏蔽继续生效
    assert.deepEqual(
        H._validBlocked(sitesList, ['k'], { probeFp: { k: 'http://a/api.php|cms0' } }),
        ['k'], '指纹匹配的屏蔽继续生效');
    // 旧版数据没有 probeFp：无法证明内容未变，一律失效（升级后一次性重探自愈）
    assert.deepEqual(H._validBlocked(sitesList, ['k'], {}), [], '无指纹的旧屏蔽不生效');
    assert.deepEqual(H._validBlocked(sitesList, ['k']), [], '缺 settings 同样不生效');
    // 不在列表里的 key 无从校验指纹，同样不生效（列表过滤场景天然如此）
    assert.deepEqual(H._validBlocked(sitesList, ['ghost'], { probeFp: { ghost: '|' } }), []);
});