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

// ---------------------------------------------------------------- 标签（对齐 Kazumi rating_review_dialog）

test('normalizeTags：去空白/去重/对象 name 兼容/上限截断', () => {
    const R = loadBgmRate();
    // VM 数组与主 realm Array.prototype 非同源：JSON 往返归一后再 deepEqual
    const norm = (v) => JSON.parse(JSON.stringify(R.normalizeTags(v)));
    assert.deepEqual(norm(null), []);
    assert.deepEqual(norm('not-array'), []);
    assert.deepEqual(norm(['神作', ' 神作 ', '', '原创']), ['神作', '原创']);
    // next.bgm 回传 {name,count} 对象形态（同 Kazumi BangumiInterest.fromJson 兼容）
    assert.deepEqual(norm([{ name: 'TV' }, { name: ' TV ' }, { count: 5 }]), ['TV']);
    // 超 10 个截断到前 10（保序）
    const many = Array.from({ length: 15 }, (_, i) => `t${i}`);
    assert.equal(norm(many).length, 10);
    assert.deepEqual(norm(many).slice(0, 3), ['t0', 't1', 't2']);
});

test('normalizeTagInput：空串/超长/重复/超上限的错误口径（对齐 Kazumi）', () => {
    const R = loadBgmRate();
    assert.equal(R.normalizeTagInput('', []).ok, false);
    assert.equal(R.normalizeTagInput('   ', []).ok, false);
    // 单标签 ≤10 字
    const long = R.normalizeTagInput('一二三四五六七八九十X', []);
    assert.equal(long.ok, false);
    assert.match(long.msg, /10 字/);
    assert.equal(R.normalizeTagInput('一二三四五六七八九十', []).ok, true);
    // 重复
    assert.equal(R.normalizeTagInput('神作', ['神作']).ok, false);
    assert.match(R.normalizeTagInput('神作', ['神作']).msg, /已添加/);
    // 满额 10 个后拒绝新增
    const ten = Array.from({ length: 10 }, (_, i) => `tag${i}`);
    const full = R.normalizeTagInput('new', ten);
    assert.equal(full.ok, false);
    assert.match(full.msg, /最多 10 个/);
});

test('buildRatingPayload：tags 语义（undefined=不修改；数组=整体覆盖，空数组=清除）', () => {
    const R = loadBgmRate();
    // 评分 + 标签
    assert.deepEqual(
        JSON.parse(JSON.stringify(R.buildRatingPayload('42', 8, '好看', ['神作', 'TV']))),
        { subjectId: '42', type: -1, rate: 8, comment: '好看', tags: ['神作', 'TV'] });
    // 仅标签（无评分无吐槽）也可提交
    assert.deepEqual(
        JSON.parse(JSON.stringify(R.buildRatingPayload('42', null, '', ['原创']))),
        { subjectId: '42', type: -1, tags: ['原创'] });
    // 空数组 = 清除全部标签（必须能提交，不能被误判为「无改动」）
    assert.deepEqual(
        JSON.parse(JSON.stringify(R.buildRatingPayload('42', null, '', []))),
        { subjectId: '42', type: -1, tags: [] });
    // tags undefined = 不修改（不带 tags 键）
    const noTags = R.buildRatingPayload('42', 8, '', undefined);
    assert.ok(!('tags' in noTags), 'undefined tags 不进 payload');
    // 全空（无评分无吐槽且无 tags 数组）→ null
    assert.equal(R.buildRatingPayload('42', null, '', undefined), null);
    // tags 数组归一化进 payload（去空白/去重）
    const p = R.buildRatingPayload('42', null, '', [' 神作 ', '神作', '']);
    assert.deepEqual(JSON.parse(JSON.stringify(p.tags)), ['神作']);
    // 兼容回归：旧三参调用（无 tags）仍工作
    assert.deepEqual(
        JSON.parse(JSON.stringify(R.buildRatingPayload('42', 8, '好看'))),
        { subjectId: '42', type: -1, rate: 8, comment: '好看' });
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
                on: () => api, off: () => api, text: () => api,
                // #bgm-rate-comment 返回吐槽正文；#bgm-rate-tag-input 返回空（无草稿）
                val: () => (sel === '#bgm-rate-tag-input' ? '' : '吐槽内容'),
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
        R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '', tags: [], tagsInit: [], popularTags: [] };
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

test('my.js/records.js：评分按钮入口已迁至详情页（T80 防回归）', () => {
    const mySrc = read('src/renderer/js/my.js');
    // T80：收藏卡按钮与 document 级委托已移除（评分是详情级操作）
    assert.ok(!mySrc.includes("$('.rec-bgm-rate'"), 'my.js 不应再有 .rec-bgm-rate 委托（入口挪至详情页）');
    assert.ok(!mySrc.includes('injectCardActions'), 'injectCardActions 注入路径应已删除');
    const recSrc = read('src/renderer/js/records.js');
    assert.ok(!recSrc.includes('rec-bgm-rate'), 'recCard 不应再渲染收藏卡评分按钮');
    // 新入口：详情页 hero 操作行按钮 + 委托（detail.js）
    const detailSrc = read('src/renderer/js/detail.js');
    assert.match(detailSrc, /id="detail-bgm-rate"/, '详情页 hero 应渲染 #detail-bgm-rate 按钮');
    assert.match(detailSrc, /on\('click', '#detail-bgm-rate'/, '应绑定 #detail-bgm-rate 点击委托');
    // bgm-rate.js 死代码清理（注释里的历史说明不算，只匹配函数定义）
    const bgmSrc = read('src/renderer/js/bgm-rate.js');
    assert.ok(!/injectCardActions\s*\(/.test(bgmSrc), 'injectCardActions 函数应已删除');
    // 提交成功后通知详情页乐观刷新吐槽
    assert.match(bgmSrc, /Detail\.onBgmCommentSubmitted/, '提交成功应通知详情页刷新吐槽（T80）');
});

// ---------------------------------------------------------------- 对话框生命周期（closeDialog 递归 / 防重入 / 重开复位）

/**
 * 交互级 VM 加载：带可记录调用的 jQuery 桩与真实接线的 openDialog/closeDialog，
 * 返回 { R: BgmRate, context, calls }，覆盖 closeDialog 包装器（Esc 全局派发路径）与
 * _close 直调原始引用（提交成功路径）的完整行为。
 */
function loadBgmRateInteractive(overrides) {
    const source = read('src/renderer/js/bgm-rate.js');
    // hide 按选择器记录：#bgm-rate-status / #bgm-rate-tag-error 的 hide 是状态行
    // 反馈（text('').hide()），与对话框可见性无关；对话框只经 closeDialog 关闭。
    const calls = { closeDialog: [], hide: [], disabled: [] };
    const mk$ = (sel) => {
        // 自反 jQuery 桩：记录 hide() 与 prop('disabled', …) 调用，其余链式返回自身
        const api = {
            on: () => api, off: () => api, text: () => api, val: () => '',
            show: () => api, html: () => api, trigger: () => api,
            hide: () => { calls.hide.push(String(sel)); return api; },
            // openRateDialog 复位后调 _kamojiSync（开窗前清上一会话残影）：
            // 面板/按钮常驻元素需要 toggleClass/attr，自反桩安全透传
            toggleClass: () => api,
            attr: () => api,
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
    // 对话框根节点不经 $.hide() 隐藏（closeDialog 是唯一关闭路径）；hide 只允许打在状态行上
    assert.ok(!calls.hide.some((s) => /bgmRateDialog/.test(s)), '对话框根不走 $.hide()（closeDialog 专责）');

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
    assert.ok(!calls.hide.some((s) => /bgmRateDialog/.test(s)), '对话框根从不走 $.hide()');

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
    R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '', tags: [], tagsInit: [], popularTags: [] };
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
    R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '', tags: [], tagsInit: [], popularTags: [] };
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
    R._ctx = { subjectId: '42', name: 'X', rate: 0, comment: '', tags: [], tagsInit: [], popularTags: [] };   // 0 = 清除评分
    const ok = await R.submit();
    assert.equal(ok, true);
    assert.ok(toasts.includes('已清除评分'), '应提示「已清除评分」');
    assert.ok(!toasts.some((t) => t.includes('已评分：未评分')), '不得出现「已评分：未评分」');
    // 对照：正常评分仍走「已评分：N 分」文案
    toasts.length = 0;
    R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '', tags: [], tagsInit: [], popularTags: [] };
    await R.submit();
    assert.ok(toasts.some((t) => t.startsWith('已评分：') && t.includes('8 分')));
});

test('submit 标签脏检查：初始一致不带 tags 键；有改动整体覆盖（含清除）', async () => {
    // 捕获 doAction 实际提交的 uploads payload
    let sent = null;
    const { R } = loadBgmRateInteractive({
        doAction: async (_do, form) => {
            sent = JSON.parse(form.uploads);
            return { code: 200, result: { uploaded: 1, failed: 0, results: [{ subjectId: '42', ok: true, msg: 'ok' }] } };
        },
    });
    // 1) 初始标签与当前一致（tags === tagsInit）：payload 不带 tags（不动远端标签）
    R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '', tags: ['神作'], tagsInit: ['神作'], popularTags: [] };
    await R.submit();
    assert.equal(sent.length, 1);
    assert.ok(!('tags' in sent[0]), '标签未改动时 payload 不带 tags 键');
    // 2) 新增标签：整体覆盖提交
    R._ctx = { subjectId: '42', name: 'X', rate: null, comment: '', tags: ['神作', 'TV'], tagsInit: ['神作'], popularTags: [] };
    await R.submit();
    assert.deepEqual(sent[0].tags, ['神作', 'TV']);
    // 3) 清空标签：空数组照常提交（清除远端标签）
    R._ctx = { subjectId: '42', name: 'X', rate: null, comment: '', tags: [], tagsInit: ['神作'], popularTags: [] };
    await R.submit();
    assert.deepEqual(sent[0].tags, []);
});

// ---------------------------------------------------------------- 颜文字悬浮面板（单按钮 + 悬停/钉住展开）

test('颜文字清单与常量口径：非空、去重、均为纯文本（可直接进 Bangumi 吐槽）', () => {
    const R = loadBgmRate();
    assert.ok(Array.isArray(R.KAMOJI) && R.KAMOJI.length >= 15, '清单应足够丰富（≥15 个）');
    assert.equal(new Set(R.KAMOJI).size, R.KAMOJI.length, '清单不得重复');
    for (const k of R.KAMOJI) {
        assert.equal(typeof k, 'string');
        assert.ok(k.trim().length > 0);
        assert.ok(k.length <= 20, `颜文字过长（${k}）：保持面板按钮紧凑`);
        // 纯文本表情：不得夹带会破坏标签输入/展示的标记字符
        assert.ok(!/[<>"'&]/.test(k), `颜文字含 HTML 特殊字符（${k}）`);
    }
    assert.equal(typeof R.KAMOJI_HIDE_DELAY, 'number');
    assert.ok(R.KAMOJI_HIDE_DELAY > 0 && R.KAMOJI_HIDE_DELAY <= 500, '悬停收起延时应为短延时（毫秒级）');
});

test('_renderKamoji：全量渲染进悬浮面板网格（data-kamoji 转义）', () => {
    let captured = '';
    const source = read('src/renderer/js/bgm-rate.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        setTimeout, clearTimeout,
        $: (sel) => ({
            on: () => ({}), off: () => ({}), text: () => ({}), val: () => '',
            show: () => ({}), hide: () => ({}), trigger: () => ({}), toggleClass: () => ({}),
            html: (h) => { if (sel === '#bgm-rate-kamoji-panel') captured = h; },
            find: () => ({ on: () => ({}), length: 0 }),
        }),
        doAction: async () => ({}), warnToast: () => {},
        escHtml: (s) => String(s),
        openDialog: () => {}, closeDialog: () => {},
        FavHub: { changed: () => {} },
        Kazumi: { _getBangumiToken: async () => 'tok' },
    };
    context.globalThis = context;
    context.window = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__R = BgmRate;`, context, { filename: 'bgm-rate.js' });
    const R2 = context.__R;
    R2._renderKamoji();
    const html = captured || '';
    const countButtons = (h, cls) => (h.match(new RegExp(cls, 'g')) || []).length;
    // 全量清单一次渲染进面板（不再有「更多」折叠——显隐由面板自身状态机负责）
    assert.equal(countButtons(html, 'class="bgm-rate-kamoji"'), R2.KAMOJI.length, '全量渲染进面板');
    assert.ok(!html.includes('bgm-rate-kamoji-more'), '不应再有「更多」折叠按钮');
    assert.match(html, /data-kamoji=/, '插入目标走 data-kamoji 属性');
});

test('颜文字面板状态机：悬停展开/离开延时收起/点击钉住/点外收起', async () => {
    // setTimeout 桩：不真等待，直接执行回调并记录是否被清除（验证「清延时器」语义）
    const timers = [];
    const mk = () => {
        const source = read('src/renderer/js/bgm-rate.js');
        const classes = { panel: [], btn: [] };
        const attrs = {}; // 记录 aria 等属性写入（kamojiSync 应同步 aria-expanded）
        const ret = { attrs };
        const context = {
            console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
            setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
            clearTimeout: (id) => { if (id) timers[id - 1] = null; },
            $: (sel) => ({
                on: () => ({}), off: () => ({}), text: () => ({}), val: () => '',
                show: () => ({}), hide: () => ({}), trigger: () => ({}), html: () => ({}),
                attr: (name, value) => {
                    if (value === undefined) return attrs[sel + '|' + name];
                    attrs[sel + '|' + name] = value;
                    return {};
                },
                toggleClass: (cls, on) => {
                    if (sel === '#bgm-rate-kamoji-panel') classes.panel.push([cls, !!on]);
                    if (sel === '#bgm-rate-kamoji-btn') classes.btn.push([cls, !!on]);
                },
                find: () => ({ on: () => ({}), length: 0 }),
            }),
            doAction: async () => ({}), warnToast: () => {},
            escHtml: (s) => String(s),
            openDialog: () => {}, closeDialog: () => {},
            FavHub: { changed: () => {} },
            Kazumi: { _getBangumiToken: async () => 'tok' },
        };
        context.globalThis = context;
        context.window = context;
        vm.createContext(context);
        vm.runInContext(`${source}\n;globalThis.__R = BgmRate;`, context, { filename: 'bgm-rate.js' });
        const R = context.__R;
        return { R, classes, attrs };
    };
    const last = (arr) => (arr.length ? JSON.parse(JSON.stringify(arr[arr.length - 1])) : null);
    // ① 悬停展开：面板与按钮同步点亮 .open/.active
    const s1 = mk();
    s1.R._kamojiHoverIn();
    assert.deepEqual(last(s1.classes.panel), ['open', true], '悬停后面板展开');
    assert.deepEqual(last(s1.classes.btn), ['active', true], '悬停后按钮高亮');
    assert.equal(s1.attrs['#bgm-rate-kamoji-btn|aria-expanded'], true, '展开时同步 aria-expanded=true（HTML 静态写死 false 需被覆盖）');
    // ② 离开（未钉住）：挂收起延时器且按时执行
    s1.R._kamojiHoverOut();
    const pending = timers.filter(Boolean);
    assert.equal(pending.length, 1, '离开后挂一个收起延时器');
    assert.equal(pending[0].ms, s1.R.KAMOJI_HIDE_DELAY, '延时值与常量一致');
    pending[0].fn();
    assert.deepEqual(last(s1.classes.panel), ['open', false], '延时到期后面板收起');
    assert.equal(s1.R._kamojiOpen, false, '状态机复位');
    assert.equal(s1.attrs['#bgm-rate-kamoji-btn|aria-expanded'], false, '收起后同步 aria-expanded=false');
    // ③ 离开（已钉住）：不挂收起延时器
    const s2 = mk();
    s2.R._kamojiTogglePin();   // 点击钉住 → 展开
    assert.equal(s2.R._kamojiPinned, true, '点击后钉住');
    assert.deepEqual(last(s2.classes.panel), ['open', true], '钉住后面板展开');
    timers.length = 0;
    s2.R._kamojiHoverOut();
    assert.equal(timers.filter(Boolean).length, 0, '钉住态离开不挂收起延时器');
    // ④ 再点按钮（钉住态）：toggle 收起并解除钉住
    s2.R._kamojiTogglePin();
    assert.equal(s2.R._kamojiOpen, false, '再点按钮收起');
    assert.equal(s2.R._kamojiPinned, false, '收起同时解除钉住');
    assert.deepEqual(last(s2.classes.panel), ['open', false], '面板同步收起');
    // ⑤ 点面板外 dismiss：收起 + 解除钉住
    const s3 = mk();
    s3.R._kamojiTogglePin();
    s3.R._kamojiDismiss();
    assert.equal(s3.R._kamojiOpen, false, '点外收起');
    assert.equal(s3.R._kamojiPinned, false, '点外解除钉住');
    // ⑥ 悬停进入清除挂起的收起延时器（指针跨间隙防闪烁）
    const s4 = mk();
    s4.R._kamojiHoverOut();   // 先挂收起延时器
    assert.equal(timers.filter(Boolean).length, 1);
    s4.R._kamojiHoverIn();    // 又移回来了
    assert.equal(timers.filter(Boolean).length, 0, '悬停进入清除收起延时器');
    assert.equal(s4.R._kamojiOpen, true, '重新展开');
});

test('_insertKamoji：光标处插入/文末追加/选区替换/空串忽略', async () => {
    // 可交互 VM 加载：$ 桩按选择器模拟 #bgm-rate-comment 的值与光标状态，
    // val(next) 写入捕获到外层变量（VM realm 闭包不可直读，经捕获值断言）
    const mk = (value, selStart, selEnd) => {
        const source = read('src/renderer/js/bgm-rate.js');
        const state = { value, set: null, focused: false };
        const context = {
            console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
            setTimeout, clearTimeout,
            document: { activeElement: { tag: 'other' } },
            $: (sel) => {
                if (sel !== '#bgm-rate-comment') {
                    // 模块绑定期会按选择器访问其他常驻控件：返回惰性自反桩
                    const api = { on: () => api, off: () => api, text: () => api, val: () => '',
                        show: () => api, hide: () => api, html: () => api, trigger: () => api,
                        prop: () => api, data: () => '', find: () => ({ on: () => api, length: 0 }), length: 0 };
                    return api;
                }
                return {
                    val: (nv) => (nv === undefined ? state.value : (state.value = nv, state.set = nv, {})),
                    prop: (k) => (k === 'selectionStart' ? selStart : k === 'selectionEnd' ? selEnd : undefined),
                    trigger: (ev) => { if (ev === 'focus') state.focused = true; },
                    0: { tag: 'textarea' },
                };
            },
            doAction: async () => ({}), warnToast: () => {},
            escHtml: (s) => String(s),
            openDialog: () => {}, closeDialog: () => {},
            FavHub: { changed: () => {} },
            Kazumi: { _getBangumiToken: async () => 'tok' },
        };
        context.globalThis = context;
        context.window = context;
        vm.createContext(context);
        vm.runInContext(`${source}\n;globalThis.__R = BgmRate;`, context, { filename: 'bgm-rate.js' });
        return { R: context.__R, state };
    };
    // 光标中插：'好看' 光标 pos=1 → '好' + 颜文字 + '看'，并聚焦输入框
    const a = mk('好看', 1, 1);
    a.R._insertKamoji('(￣▽￣)');
    assert.equal(a.state.value, '好(￣▽￣)看', '插入到光标处');
    assert.equal(a.state.focused, true, '插入后聚焦吐槽框');
    // 选区替换：1..3 的 '看极' 被替换为 Orz
    const b = mk('好看极了', 1, 3);
    b.R._insertKamoji('Orz');
    assert.equal(b.state.value, '好Orz了', '选区被替换');
    // 未聚焦过（selectionStart 非有限数值，模拟未定位光标）：文末追加
    const c = mk('好看', NaN, NaN);
    c.R._insertKamoji('Orz');
    assert.equal(c.state.value, '好看Orz', '无有效光标时追加到文末');
    // 空串忽略：正文不动
    const d = mk('x', 0, 0);
    d.R._insertKamoji('');
    assert.equal(d.state.value, 'x', '空串不写入');
    assert.equal(d.state.focused, false, '空串不触发聚焦');
});

test('颜文字 UI 集成形态：index.html 按钮+悬浮面板结构 + bgm-rate.js 委托绑定 + CSS', () => {
    const html = read('src/renderer/index.html');
    assert.ok(html.includes('id="bgm-rate-kamoji-btn"'), 'index.html 应包含 #bgm-rate-kamoji-btn 触发按钮');
    assert.ok(html.includes('id="bgm-rate-kamoji-panel"'), 'index.html 应包含 #bgm-rate-kamoji-panel 悬浮面板');
    // 无障碍：haspopup/expanded/controls 标注齐全
    assert.match(html, /id="bgm-rate-kamoji-btn"[^>]*aria-haspopup="true"/, '按钮应标注 aria-haspopup');
    assert.match(html, /id="bgm-rate-kamoji-btn"[^>]*aria-controls="bgm-rate-kamoji-panel"/, '按钮应标注 aria-controls');
    // 结构：按钮 + 面板包在同一个 wrap 里，wrap 紧跟吐槽 textarea（外层 resize wrap 之后）
    assert.match(html, /id="bgm-rate-comment-resize"[\s\S]*?<\/div>\s*<\/div>\s*<div class="bgm-rate-kamoji-wrap">/, '颜文字区应紧跟吐槽输入框（含 resize wrap）');
    assert.match(html, /class="bgm-rate-kamoji-wrap">[\s\S]*?id="bgm-rate-kamoji-panel"/, '面板应位于 wrap 内（绝对定位锚点）');
    const bgmSrc = read('src/renderer/js/bgm-rate.js');
    assert.match(bgmSrc, /'#bgm-rate-kamoji-panel'\)\.on\('click', '\.bgm-rate-kamoji'/, '面板内颜文字点击委托');
    assert.match(bgmSrc, /'#bgm-rate-kamoji-btn'\)\.on\('mouseenter'/, '按钮悬停展开');
    assert.match(bgmSrc, /'#bgm-rate-kamoji-btn'\)\.on\('click'/, '按钮点击钉住（触屏/键盘路径）');
    assert.match(bgmSrc, /_renderKamoji\(\)/, '对话框渲染时应渲染颜文字面板');
    const cssSrc = read('src/renderer/css/ui.css');
    assert.match(cssSrc, /\.bgm-rate-kamoji-panel\s*\{/, 'ui.css 应有悬浮面板样式');
    assert.match(cssSrc, /\.bgm-rate-kamoji-panel\.open/, 'ui.css 应有面板展开态样式');
    assert.match(cssSrc, /\.bgm-rate-kamoji-btn\s*\{/, 'ui.css 应有触发按钮样式');
    assert.match(cssSrc, /\.bgm-rate-kamoji\s*\{/, 'ui.css 应有颜文字按钮样式');
    // 面板必须绝对定位悬浮（不挤动文档流），锚点是 wrap
    const panelCss = cssSrc.match(/\.bgm-rate-kamoji-panel\s*\{[^}]*\}/)[0];
    assert.match(panelCss, /position:\s*absolute/, '面板应绝对定位悬浮');
    const wrapCss = cssSrc.match(/\.bgm-rate-kamoji-wrap\s*\{[^}]*\}/)[0];
    assert.match(wrapCss, /position:\s*relative/, 'wrap 应为定位锚点');
});

// ---------------------------------------------------------------- 标签 UI 集成形态

test('标签编辑 UI：index.html 对话框结构 + detail/bangumi-search 入口透传 tags', () => {
    const html = read('src/renderer/index.html');
    // 对话框静态结构（常驻 DOM，控件 id 固定）
    for (const id of ['bgm-rate-tags-selected', 'bgm-rate-tags-popular', 'bgm-rate-tag-input', 'bgm-rate-tag-add', 'bgm-rate-tags-count', 'bgm-rate-tag-error']) {
        assert.ok(html.includes(`id="${id}"`), `index.html 应包含 #${id}`);
    }
    // detail.js：入口透传 tags + popularTags（条目公共标签做热门建议）
    const detailSrc = read('src/renderer/js/detail.js');
    assert.match(detailSrc, /tags: cur\.tags/, 'detail.js 评分入口应透传当前个人标签');
    assert.match(detailSrc, /popularTags:/, 'detail.js 评分入口应透传热门标签建议');
    // bangumi-search.js：搜索卡评分入口已移除（评分统一在详情页 hero），不应再有 .bgm-card-rate 逻辑
    const bsSrc = read('src/renderer/js/bangumi-search.js');
    assert.ok(!bsSrc.includes('bgm-card-rate'), 'bangumi-search.js 不应保留搜索卡评分按钮逻辑');
    // common.js bangumiCard：不再输出 data-tags（BgmRate 热门标签实际取自详情接口，
    // 搜索卡从无消费方，死属性已移除）
    const commonSrc = read('src/renderer/js/common.js');
    assert.ok(!commonSrc.includes('data-tags'), 'bangumiCard 不应再渲染 data-tags 死属性');
    // 事件绑定：chips 移除 / 热门 toggle / 自定义输入（回车 + 按钮）
    const bgmSrc = read('src/renderer/js/bgm-rate.js');
    assert.match(bgmSrc, /'#bgm-rate-tags-selected'\)\.on\('click', '\.bgm-rate-tag-remove'/, '已选 chips 移除委托');
    assert.match(bgmSrc, /'#bgm-rate-tags-popular'\)\.on\('click', '\.bgm-rate-tag-pop'/, '热门标签 toggle 委托');
    assert.match(bgmSrc, /'#bgm-rate-tag-input'\)\.on\('keydown'/, '自定义标签回车添加');
});

test('吐槽框自定义拉伸：wrap+把手结构、resize:none、指针拖拽钳制 84~240px、标签输入行等高对齐', () => {
    const html = read('src/renderer/index.html');
    // 结构：textarea 包在 resize wrap 内，把手为独立元素（原生把手已弃用）
    assert.match(html, /<div class="bgm-rate-comment-wrap">\s*<textarea id="bgm-rate-comment"/, '吐槽框应有 resize wrap 包裹');
    assert.match(html, /id="bgm-rate-comment-resize" class="bgm-rate-resize"/, '应有自定义拉伸把手元素');
    const bgmSrc = read('src/renderer/js/bgm-rate.js');
    assert.match(bgmSrc, /'#bgm-rate-comment-resize'\)\.on\('pointerdown'/, '应绑定把手 pointerdown 拖拽');
    assert.match(bgmSrc, /MIN_H = 84, MAX_H = 240/, '拖拽高度钳制 84~240px（与 CSS min/max 一致）');
    assert.match(bgmSrc, /setPointerCapture/, '拖拽应 setPointerCapture（指针滑出把手持续跟踪）');
    const cssSrc = read('src/renderer/css/ui.css');
    const taCss = cssSrc.match(/#bgm-rate-comment\s*\{[^}]*\}/)[0];
    assert.match(taCss, /resize:\s*none/, '原生 resize 把手应关闭（斜纹三角遮挡滚动条的根因）');
    assert.match(taCss, /overflow-y:\s*auto/, '超高内容内部滚动');
    const handleCss = cssSrc.match(/\.bgm-rate-resize\s*\{[^}]*\}/)[0];
    assert.match(handleCss, /cursor:\s*ns-resize/, '把手应为纵向拉伸光标');
    // 标签输入行：输入框与「添加」按钮同高 32px、stretch 对齐
    const rowCss = cssSrc.match(/\.bgm-rate-tags-input-row\s*\{[^}]*\}/)[0];
    assert.match(rowCss, /align-items:\s*stretch/, '输入行应 stretch 等高对齐');
    const inputCss = cssSrc.match(/\.bgm-rate-tags-input-row \.md-input\s*\{[^}]*\}/)[0];
    assert.match(inputCss, /height:\s*32px/, '输入框应压到与 md-btn-sm 按钮同高 32px');
});

test('fetchCurrent：收藏 GET 回传 tags 归一化进上下文', async () => {
    const source = read('src/renderer/js/bgm-rate.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        setTimeout, clearTimeout,
        $: () => ({ on: () => this, find: () => ({ on: () => this, length: 0 }) }),
        doAction: async (doName) => {
            assert.equal(doName, 'kazumiBangumiCollectionGet');
            return {
                code: 200,
                collection: { rate: 8, comment: '好看', tags: [{ name: '神作' }, 'TV'] },
            };
        },
        warnToast: () => {},
        escHtml: (s) => String(s),
        openDialog: () => {}, closeDialog: () => {},
        FavHub: { changed: () => {} },
        Kazumi: { _getBangumiToken: async () => 'tok' },
    };
    context.globalThis = context;
    context.window = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__R = BgmRate;`, context, { filename: 'bgm-rate.js' });
    const R = context.__R;
    const cur = await R.fetchCurrent('42', null);
    assert.equal(cur.rate, 8);
    assert.equal(cur.comment, '好看');
    // VM 数组跨 realm：JSON 往返归一后比较；{name} 对象与字符串混合应归一化为字符串数组
    assert.deepEqual(JSON.parse(JSON.stringify(cur.tags)), ['神作', 'TV']);
});

