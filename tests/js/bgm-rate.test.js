'use strict';
// Bangumi 评分/吐槽（bgm-rate.js）纯逻辑单测：
//   - clampRate / starsFor / fmtRateLabel / buildRatingPayload（VM 加载，不触碰 DOM/网络）
//   - common.js bangumiCard 的 my_rate 徽章（渲染 + 转义回归）
// 网络通道（kazumiBangumiSyncApply 单条透传）的 body 由 buildRatingPayload 决定，
// 此处锁 payload 形状即锁后端契约（type=-1 不动收藏 + 可选 rate/comment）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 在 VM 中加载 bgm-rate.js（最小桩），返回 BgmRate 对象。 */
function loadBgmRate() {
    const source = read('src/renderer/js/bgm-rate.js');
    const noop = function () { return this; };
    const $stub = () => ({
        on: noop, off: noop, text: noop, val: noop, show: noop, hide: noop,
        html: noop, trigger: noop, find: () => ({ on: noop, length: 0 }),
    });
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        setTimeout, clearTimeout,
        $: $stub,
        doAction: async () => ({ code: 200, result: { uploaded: 1, failed: 0, results: [{ subjectId: '1', ok: true, msg: 'ok' }] } }),
        warnToast: () => {},
        escHtml: (s) => String(s),
        openDialog: () => {}, closeDialog: () => {},
        FavHub: { changed: () => {} },
        Kazumi: { _getBangumiToken: async () => 'tok' },
    };
    context.globalThis = context;
    context.window = context; // bgm-rate.js 尾部 IIFE 走 window 分支
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__R = BgmRate;`, context, { filename: 'bgm-rate.js' });
    return context.__R;
}

test('clampRate：合法分值/边界/非法输入', () => {
    const R = loadBgmRate();
    assert.equal(R.clampRate(5), 5);
    assert.equal(R.clampRate('7'), 7);
    assert.equal(R.clampRate(0), 0);          // 0=清除评分，合法保留
    assert.equal(R.clampRate(-3), 0);         // 下界钳制
    assert.equal(R.clampRate(99), 10);        // 上界钳制
    assert.equal(R.clampRate(7.6), 8);        // 四舍五入到整数
    assert.equal(R.clampRate(null), null);    // null=不修改
    assert.equal(R.clampRate(''), null);
    assert.equal(R.clampRate('abc'), null);
    assert.equal(R.clampRate(NaN), null);
});

test('buildRatingPayload：后端契约形状（type=-1 + 可选 rate/comment）', () => {
    const R = loadBgmRate();
    // 评分 + 吐槽
    assert.deepEqual(
        JSON.parse(JSON.stringify(R.buildRatingPayload('42', 8, '好看'))),
        { subjectId: '42', type: -1, rate: 8, comment: '好看' });
    // 仅评分
    assert.deepEqual(
        JSON.parse(JSON.stringify(R.buildRatingPayload('42', 3, ''))),
        { subjectId: '42', type: -1, rate: 3 });
    // 仅吐槽
    assert.deepEqual(
        JSON.parse(JSON.stringify(R.buildRatingPayload('42', null, '期待第二季'))),
        { subjectId: '42', type: -1, comment: '期待第二季' });
    // 0 分 = 清除评分，rate 必须出现在 payload
    assert.deepEqual(
        JSON.parse(JSON.stringify(R.buildRatingPayload('42', 0, ''))),
        { subjectId: '42', type: -1, rate: 0 });
    // 空评分 + 空吐槽 → null（无改动不提交）
    assert.equal(R.buildRatingPayload('42', null, '   '), null);
    // 缺 subjectId → null
    assert.equal(R.buildRatingPayload('', 5, 'x'), null);
    // 吐槽首尾空白去除
    const p = R.buildRatingPayload('42', null, '  神作  ');
    assert.equal(p.comment, '神作');
});

test('starsFor / fmtRateLabel：展示映射', () => {
    const R = loadBgmRate();
    assert.equal(R.starsFor(8), '★★★★☆');
    assert.equal(R.starsFor(9), '★★★★⯨');
    assert.equal(R.starsFor(10), '★★★★★');
    assert.equal(R.starsFor(null), '☆☆☆☆☆');
    assert.match(R.fmtRateLabel(10), /10 分/);
    assert.match(R.fmtRateLabel(null), /未评分/);
    assert.match(R.fmtRateLabel(0), /未评分/);
});

test('submit：401 失败提示重新获取 Token，成功后 FavHub.changed 广播', async () => {
    const source = read('src/renderer/js/bgm-rate.js');
    const toasts = [];
    let favChanged = 0;
    const mkCtx = (doActionImpl, tokenImpl) => ({
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        setTimeout, clearTimeout,
        $: (sel) => {
            // 自反 jQuery 桩：所有方法返回自身，支撑 text('…').show() / .text().show() 链式
            const api = {
                on: () => api, off: () => api, text: () => api, val: () => '吐槽内容',
                show: () => api, hide: () => api, html: () => api, trigger: () => api,
                prop: () => api, // submit 禁用/复位提交按钮（prop('disabled', …)）
                find: () => ({ on: () => api, length: 0 }),
                length: 0,
                last: () => ({ data: () => 8 }),
                data: () => '42',
                closest: () => ({ data: () => '42' }),
            };
            return api;
        },
        doAction: doActionImpl,
        warnToast: (m) => toasts.push(m),
        escHtml: (s) => String(s),
        openDialog: () => {}, closeDialog: () => {},
        FavHub: { changed: () => { favChanged++; } },
        Kazumi: { _getBangumiToken: tokenImpl },
    });
    const run = async (doActionImpl, tokenImpl) => {
        const context = mkCtx(doActionImpl, tokenImpl);
        context.globalThis = context;
        context.window = context;
        vm.createContext(context);
        vm.runInContext(`${source}\n;globalThis.__R = BgmRate;`, context, { filename: 'bgm-rate.js' });
        const R = context.__R;
        R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
        return R.submit();
    };
    // 成功路径：FavHub.changed 广播 + true
    let okCalls = 0;
    const ok = await run(async () => {
        okCalls++;
        return { code: 200, result: { uploaded: 1, failed: 0, results: [{ subjectId: '42', ok: true, msg: 'ok' }] } };
    }, async () => 'tok');
    assert.equal(ok, true);
    assert.equal(favChanged, 1);
    assert.equal(okCalls, 1);
    // 401 路径：false + 提示重新获取
    toasts.length = 0;
    const r401 = await run(async () => ({
        code: 400, result: { uploaded: 0, failed: 1, results: [{ subjectId: '42', ok: false, msg: 'POST https://x -> 401' }] },
    }), async () => 'tok');
    assert.equal(r401, false);
    assert.ok(toasts.some((t) => t.includes('401') && t.includes('重新获取')));
    // 无 token：不发请求
    toasts.length = 0;
    const rNoTok = await run(async () => { throw new Error('should not be called'); }, async () => '');
    assert.equal(rNoTok, false);
    assert.ok(toasts.some((t) => t.includes('保存 Token')));
});

// ---------------------------------------------------------------- common.js my_rate 徽章

function loadCommonCard() {
    const source = read('src/renderer/js/common.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, parseInt, parseFloat,
        setTimeout, clearTimeout, URLSearchParams,
        $: () => ({ on() { return this; } }),
        window: {},
        document: {},
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        fetch: async () => ({ ok: true, text: async () => '' }),
        AbortSignal: { timeout: () => ({}) },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__card = bangumiCard; globalThis.__escHtml = escHtml;`,
        context, { filename: 'common.js' });
    return context;
}

test('bangumiCard：my_rate 徽章按需渲染且数值经转义', () => {
    const ctx = loadCommonCard();
    // 带评分：渲染徽章
    const withRate = ctx.__card({ id: '1', name: '日常', my_rate: 9 });
    assert.match(withRate, /我的 9★/);
    assert.match(withRate, /bangumi-myrate-badge/);
    // 无 my_rate 字段（推荐/时间表路径）：不渲染，回归兼容
    const noRate = ctx.__card({ id: '2', name: '日常', rating: { score: 8.3 } });
    assert.doesNotMatch(noRate, /bangumi-myrate-badge/);
    // 越界值不渲染（远端/缓存脏数据防御）
    const badRate = ctx.__card({ id: '3', name: 'x', my_rate: 42 });
    assert.doesNotMatch(badRate, /bangumi-myrate-badge/);
});

test('bangumiCard：原字段（rank/score/air_date）输出不受新增徽章影响', () => {
    const ctx = loadCommonCard();
    const ok = ctx.__card({ id: '42', name: '日常', rating: { score: 8.3, rank: 107 }, air_date: '2011-04-03' });
    assert.match(ok, /#107/);
    assert.match(ok, /⭐8\.3/);
    assert.match(ok, /2011-04-03/);
    assert.doesNotMatch(ok, /bangumi-myrate-badge/);
});

// ---------------------------------------------------------------- 集成形态（my.js / records.js 协作）

test('my.js/records.js：评分按钮委托层级与内嵌渲染（防回归）', () => {
    const mySrc = read('src/renderer/js/my.js');
    // 评分按钮点击委托在 document 级（对话框开合入口；#view-my 收不下独立收藏页 #view-favorites）
    assert.match(mySrc, /\$\(document\)\.on\('click', '\.rec-bgm-rate'/);
    // recCard 已内嵌渲染按钮：my.js 不再有任何 injectCardActions 调用（注入路径已删）
    assert.ok(!mySrc.includes('injectCardActions'), 'injectCardActions 应已由 recCard 内嵌渲染取代，my.js 无残留调用');
    // 卡片委托入口按事件源过滤评分按钮（点评分只开对话框，不进详情页）
    const recSrc = read('src/renderer/js/records.js');
    assert.match(recSrc, /closest\('\.rec-bgm-rate'\)/, '.vod-card 点击处理应跳过 .rec-bgm-rate');
});

// ---------------------------------------------------------------- 对话框生命周期（closeDialog 递归 / 防重入 / 重开复位）

/**
 * 交互级 VM 加载：带可记录调用的 jQuery 桩与真实接线的 openDialog/closeDialog，
 * 返回 { R: BgmRate, context, calls }，覆盖 closeDialog 包装器（Esc 全局派发路径）与
 * _close 直调原始引用（提交成功路径）的完整行为。
 */
function loadBgmRateInteractive(overrides) {
    const source = read('src/renderer/js/bgm-rate.js');
    const calls = { closeDialog: [], hide: [], disabled: [] };
    const mk$ = () => {
        // 自反 jQuery 桩：记录 hide() 与 prop('disabled', …) 调用，其余链式返回自身
        const api = {
            on: () => api, off: () => api, text: () => api, val: () => '',
            show: () => api, html: () => api, trigger: () => api,
            hide: () => { calls.hide.push(1); return api; },
            prop: (k, v) => {
                if (k === 'disabled') calls.disabled.push(v);
                return api;
            },
            data: () => ({}),
            find: () => ({ on: () => api, length: 0 }),
            length: 0,
        };
        return api;
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        setTimeout, clearTimeout,
        $: mk$,
        doAction: async () => ({ code: 200, result: { uploaded: 1, failed: 0, results: [{ subjectId: '42', ok: true, msg: 'ok' }] } }),
        warnToast: () => {},
        escHtml: (s) => String(s),
        openDialog: () => {},
        closeDialog: (id) => { calls.closeDialog.push(id); },
        FavHub: { changed: () => {} },
        Kazumi: { _getBangumiToken: async () => 'tok' },
        ...(overrides || {}),
    };
    context.globalThis = context;
    context.window = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__R = BgmRate;`, context, { filename: 'bgm-rate.js' });
    return { R: context.__R, context, calls };
}

test('closeDialog 递归：Esc/取消/提交成功三条路径 _close 均一次到位，resolve 后 _resolve 置空、隐藏不重复', async () => {
    // —— 路径一：Esc 全局派发（全局 closeDialog('bgmRateDialog') → wrapped → _close(false)）——
    // 模块加载后 IIFE 已把 window.closeDialog 覆写为 wrapped（window === context），
    // 因此 context.closeDialog 即 Esc 全局派发路径的实际派发入口（common.js dispatchEsc 同款；
    // #bgmRateDialog 无遮罩关闭路径，Esc 是唯一的全局关闭入口）
    const { R, context, calls } = loadBgmRateInteractive();
    const p1 = R.openRateDialog({ subjectId: '42', name: 'X', rate: 8 });
    assert.ok(R._resolve, '打开后应有挂起的 Promise');
    const r1 = await Promise.resolve().then(() => context.closeDialog('bgmRateDialog'));
    assert.equal(r1, undefined, 'wrapped 关闭对话框无返回值');
    assert.equal(await p1, false, 'Esc 路径按取消 resolve(false)');
    assert.equal(R._resolve, null, '关闭后 _resolve 已置空（wrapped 不再可捕获 → 递归根除）');
    assert.equal(calls.closeDialog.filter((id) => id === 'bgmRateDialog').length, 1, 'Esc 路径 closeDialog 只执行一次');
    assert.ok(calls.hide.length <= 1, '对话框隐藏至多一次');

    // —— 路径二：取消按钮（直接 _close(false) → 原始 closeDialog 直调，不走 wrapped）——
    const p2 = R.openRateDialog({ subjectId: '42', name: 'X' });
    R._close(false);
    assert.equal(await p2, false);
    assert.equal(R._resolve, null);
    assert.equal(calls.closeDialog.filter((id) => id === 'bgmRateDialog').length, 2, '取消路径 closeDialog 恰好一次');

    // —— 路径三：提交成功（submit → _close(true) → 原始 closeDialog 直调）——
    const p3 = R.openRateDialog({ subjectId: '42', name: 'X', rate: 9 });
    const r3 = await R.submit();
    assert.equal(r3, true, '提交成功必须返回 true（修复前被递归 catch 误报为网络错误）');
    assert.equal(await p3, true, '提交成功 resolve(true) 一次到位');
    assert.equal(R._resolve, null, '提交成功后 _resolve 已置空');
    assert.equal(R._ctx, null, '提交成功后 _ctx 已复位');
    assert.equal(calls.closeDialog.filter((id) => id === 'bgmRateDialog').length, 3, '三次会话各关闭一次（无递归连锁）');
    assert.ok(calls.hide.length <= 3, '每次会话隐藏至多一次');

    // —— 路径四：wrapped 不再触发二次关闭（_resolve 已空，wrapped 透传原始 closeDialog）——
    // 再次全局派发（模拟 Esc 重复按键）：BgmRate._resolve 为空 → wrapped 透传，_close 不再执行
    context.closeDialog('bgmRateDialog');
    assert.equal(calls.closeDialog.filter((id) => id === 'bgmRateDialog').length, 4, 'wrapped 透传一次（不再回调 _close）');
    assert.equal(R._resolve, null);
});

test('submit 防重入：同一 subject 在途时重复触发被拒绝，不并发第二个 PATCH', async () => {
    let doActionCalls = 0;
    let inFlight = 0;
    let releaseGate;
    const gate = new Promise((res) => { releaseGate = res; });
    const { R, calls } = loadBgmRateInteractive({
        doAction: async () => {
            doActionCalls++;
            inFlight++;
            await gate;
            inFlight--;
            return { code: 200, result: { uploaded: 1, failed: 0, results: [{ subjectId: '42', ok: true, msg: 'ok' }] } };
        },
    });
    R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
    const first = R.submit();
    // 等首个请求真正进入 doAction（submit 同步段只到 token 查询的 await）
    await new Promise((r) => setImmediate(r));
    // 首个请求在途（卡在 gate）：模拟连点触发第二次提交
    assert.equal(R._inFlightId, '42', '入口即占位 _inFlightId');
    assert.equal(inFlight, 1);
    const second = await R.submit();
    assert.equal(second, false, '在途期间重复提交返回 false');
    assert.equal(doActionCalls, 1, 'doAction 只发一次（无并发 PATCH）');
    releaseGate();
    assert.equal(await first, true, '首个提交正常完成');
    assert.equal(R._inFlightId, '', 'finally 复位 _inFlightId');
    // 复位后可再次提交（不误锁）。首次成功已 _close(true) 复位 _ctx，需重新挂上下文
    R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
    assert.equal(await R.submit(), true, '复位后可再次提交');
    assert.equal(doActionCalls, 2);
    // 提交按钮禁用/复位按序发生：true(发送前禁用) → false(finally 复位) → true → false
    assert.deepEqual(calls.disabled, [true, false, true, false]);
});

test('重开复位：对话框已打开时再次 openRateDialog，旧 Promise 立即按取消 settle', async () => {
    const { R } = loadBgmRateInteractive();
    const p1 = R.openRateDialog({ subjectId: '42', name: '旧会话', rate: 8 });
    const p2 = R.openRateDialog({ subjectId: '43', name: '新会话', rate: 2 });
    assert.equal(await p1, false, '旧 Promise 按取消 settle（不悬挂）');
    assert.equal(R._ctx.subjectId, '43', '新会话 _ctx 已接管');
    assert.ok(R._resolve, '新会话仍持有挂起 _resolve');
    R._close(true);
    assert.equal(await p2, true, '新 Promise 正常由新会话 resolve');
});

test('清除评分文案：rate=0 成功 toast 为「已清除评分」，不再是「已评分：未评分」', async () => {
    const toasts = [];
    const { R } = loadBgmRateInteractive({ warnToast: (m) => toasts.push(m) });
    R._ctx = { subjectId: '42', name: 'X', rate: 0, comment: '' };   // 0 = 清除评分
    const ok = await R.submit();
    assert.equal(ok, true);
    assert.ok(toasts.includes('已清除评分'), '应提示「已清除评分」');
    assert.ok(!toasts.some((t) => t.includes('已评分：未评分')), '不得出现「已评分：未评分」');
    // 对照：正常评分仍走「已评分：N 分」文案
    toasts.length = 0;
    R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
    await R.submit();
    assert.ok(toasts.some((t) => t.startsWith('已评分：') && t.includes('8 分')));
});

