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
    // 点遮罩的委托处理同样调它 → 两条全局入口一致）
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

    // —— 路径二：取消（_close(false) → 原始 closeDialog 直调，不走 wrapped）——
    // 取消按钮/遮罩走 requestClose 脏检查，无改动时落到同一 _close(false)（本用例
    // 直接调原语锁定「一次到位」语义；脏检查分支见下方「取消二次确认」用例组）
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
                    // input 监听（打字置 _touched）在模块绑定期也会挂到本选择器
                    on: () => ({}),
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
    // detail.js：点击转圈等待补查（Promise.race 超时保险丝），正常返回带预填开窗；
    // 超时先无预填开窗 + 晚到结果经 mergeFetched 合并（不重发请求）
    const detailSrc = read('src/renderer/js/detail.js');
    assert.match(detailSrc, /Promise\.race\(\[\s*fetching,\s*new Promise[\s\S]*?RATE_FETCH_TIMEOUT_MS/, '评分入口应转圈等待补查并以 RATE_FETCH_TIMEOUT_MS 竞速');
    assert.match(detailSrc, /openRateDialog\(\{[\s\S]*?\}\);/, '竞速结束后应开窗（带预填或无预填）');
    // 2026-10-02：合并必须带本次会话号（BgmRate._lastFetchId）——只按 subjectId
    // 判归属时，同一条目关掉重开后第一次的迟到响应会覆盖第二次会话的内容。
    assert.match(detailSrc, /const fetchId = BgmRate\._lastFetchId;/,
        '应取本次对话框会话号用于归属校验');
    assert.match(detailSrc, /BgmRate\.mergeFetched\(sid, late, fetchId\)/,
        '超时开窗后晚到补查结果应经 mergeFetched 合并（带会话号，复用同一次在途请求）');
    assert.match(read('src/renderer/js/bgm-rate.js'), /c\.fetchId !== fetchId\) return false/,
        'mergeFetched 应校验会话号（同条目两次对话框不串台）');
    assert.match(read('src/renderer/js/bgm-rate.js'), /c\.tagsInit = c\.tags\.slice\(\)/,
        'mergeFetched 合并 tags 时应同步初始快照（否则脏检查误判已修改并覆盖并发标签变更）');
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

// ---------------------------------------------------------------- 即时开窗：mergeFetched 合并与 _touched 守卫

/**
 * mergeFetched 行为 VM 加载：自反 $ 桩记录 text/html/val 调用，
 * openRateDialog / mergeFetched 全链路可跑（对话框打开态以 _ctx 存在性模拟）。
 */
function loadBgmRateMerge() {
    const source = read('src/renderer/js/bgm-rate.js');
    const sink = { texts: [], htmls: [], vals: {}, focused: [] };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        setTimeout, clearTimeout,
        $: (sel) => {
            const api = {
                on: () => api, off: () => api, show: () => api, hide: () => api,
                text: (v) => { if (v !== undefined) sink.texts.push({ sel, v: String(v) }); return api; },
                html: (v) => { if (v !== undefined) sink.htmls.push({ sel, v: String(v) }); return api; },
                val: (v) => {
                    if (v === undefined) return sink.vals[sel] === undefined ? '' : sink.vals[sel];
                    sink.vals[sel] = v; return api;
                },
                trigger: (ev) => { if (ev === 'focus') sink.focused.push(sel); return api; },
                toggleClass: () => api, attr: () => api, prop: () => api,
                data: () => '', find: () => ({ on: () => api, length: 0 }), length: 0,
            };
            return api;
        },
        doAction: async () => ({ collection: { rate: 7, comment: '还行', tags: ['旧标签'] } }),
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
    return { R: context.__R, sink };
}

test('mergeFetched：合并进已开对话框并重渲（评分/吐槽/标签三项落进 _ctx）', async () => {
    const { R, sink } = loadBgmRateMerge();
    const p = R.openRateDialog({ subjectId: '42', name: 'X' });
    assert.ok(R._ctx, '对话框已开（_ctx 就绪）');
    const merged = R.mergeFetched('42', { rate: 7, comment: '还行', tags: ['旧标签'] });
    assert.equal(merged, true, '条目匹配且未编辑：应合并');
    assert.equal(R._ctx.rate, 7);
    assert.equal(R._ctx.comment, '还行');
    assert.deepEqual(JSON.parse(JSON.stringify(R._ctx.tags)), ['旧标签']);
    // 重渲落地：吐槽框写入合并值，星级行重渲
    assert.equal(sink.vals['#bgm-rate-comment'], '还行');
    assert.ok(sink.htmls.some((h) => h.sel === '#bgm-rate-stars' && String(h.v).includes('data-rate="7"')));
    // 开窗 Promise 挂起中：合并后仍可正常取消收尾
    R._close(false);
    assert.equal(await p, false);
});

test('mergeFetched：条目不匹配 / 对话框已关 一律丢弃（防串档）', async () => {
    const { R } = loadBgmRateMerge();
    // 对话框未开：丢弃
    assert.equal(R.mergeFetched('42', { rate: 5 }), false);
    // 已开但条目不同（详情页切番剧后补查才回来）：丢弃，不改上下文
    R.openRateDialog({ subjectId: '42', name: 'X' });
    assert.equal(R.mergeFetched('99', { rate: 5 }), false);
    assert.equal(R._ctx.rate, null, '非本条目数据不得写进上下文');
    // 带前后空白的 subjectId 归一后匹配（与 openRateDialog 同口径）
    assert.equal(R.mergeFetched(' 42 ', { rate: 5 }), true);
    assert.equal(R._ctx.rate, 5);
    R._close(false);
});

test('mergeFetched：用户已编辑（_touched）时丢弃远端数据，不覆盖输入', async () => {
    const { R, sink } = loadBgmRateMerge();
    R.openRateDialog({ subjectId: '42', name: 'X' });
    // 用户先打星（_pickRate 置 _touched）
    R._pickRate(3);
    const merged = R.mergeFetched('42', { rate: 7, comment: '还行', tags: ['旧标签'] });
    assert.equal(merged, false, '已编辑：合并应被拒绝');
    assert.equal(R._ctx.rate, 3, '用户选的 3 分不被晚到的 7 分覆盖');
    assert.equal(R._ctx.comment, '', '吐槽框内容不被覆盖');
    assert.deepEqual(JSON.parse(JSON.stringify(R._ctx.tags)), [], '标签不被覆盖（保持开窗时的空数组）');
    // 手动重建 _ctx（带 tags 数组）后逐个验证交互入口置 _touched
    R._ctx = { subjectId: '42', name: 'X', rate: null, comment: '', tags: [] };
    R._touched = false;
    R._clearRate();
    assert.equal(R._touched, true, '_clearRate 应置 _touched');
    R._ctx = { subjectId: '42', name: 'X', rate: null, comment: '', tags: [] };
    R._touched = false;
    R._toggleTag('科幻');
    assert.equal(R._touched, true, '_toggleTag 应置 _touched');
    R._touched = false;
    sink.vals['#bgm-rate-comment'] = '好看';
    R._insertKamoji('(￣▽￣)');
    assert.equal(R._touched, true, '_insertKamoji 应置 _touched');
    assert.equal(sink.vals['#bgm-rate-comment'], '好看(￣▽￣)', '颜文字插入不受影响');
    R._close(false);
});

test('mergeFetched：缺省字段不覆盖（只带 rate 的补查结果不动吐槽与标签）', async () => {
    const { R } = loadBgmRateMerge();
    R.openRateDialog({ subjectId: '42', name: 'X', comment: '原有吐槽' });
    assert.equal(R.mergeFetched('42', { rate: 9 }), true);
    assert.equal(R._ctx.rate, 9);
    assert.equal(R._ctx.comment, '原有吐槽', '无 comment 键时不清空');
    // 空数据对象：合法 no-op，重渲不报错
    assert.equal(R.mergeFetched('42', {}), true);
    assert.equal(R.mergeFetched('42', null), true);
    R._close(false);
});

test('openRateDialog：开窗复位 _touched，跨会话守卫不残留', async () => {
    const { R } = loadBgmRateMerge();
    R.openRateDialog({ subjectId: '42', name: 'X' });
    R._pickRate(5);
    assert.equal(R._touched, true);
    R._close(false);
    // 第二次开窗：_touched 必须复位，否则补查数据永远合并不进来
    R.openRateDialog({ subjectId: '43', name: 'Y' });
    assert.equal(R._touched, false, '重开应复位 _touched');
    assert.equal(R.mergeFetched('43', { rate: 2 }), true, '新会话合并正常');
    R._close(false);
});

test('input 打字置 _touched：吐槽框/标签输入框监听已绑定（防打字被合并覆盖）', () => {
    const bgmSrc = read('src/renderer/js/bgm-rate.js');
    assert.match(bgmSrc, /'#bgm-rate-comment'\)\.on\('input'/, '吐槽框应绑定 input 监听');
    assert.match(bgmSrc, /'#bgm-rate-tag-input'\)\.on\('input'/, '标签输入框应绑定 input 监听');
    assert.match(bgmSrc, /_touched = true/, 'input 路径应置 _touched');
});
// ---------------------------------------------------------------- 超时开窗路径的 mergeFetched（detail.js 入口 4s 保险丝的收尾）

test('mergeFetched：超时无预填开窗后晚到补查合并，rate 缺省不被 clamp 成 0', async () => {
    const { R } = loadBgmRateMerge();
    // detail.js 超时分支传 rate:null/comment:''/tags:undefined——语义必须是
    // 「未知」而非「已确认无评分」：clampRate(null)=null 不改星级、无 tags 键不动标签
    R.openRateDialog({ subjectId: '42', name: 'X', rate: null, comment: '', tags: undefined });
    assert.equal(R._ctx.rate, null, 'null 预填 = 未评分展示，非 0 清除');
    // 晚到的远端数据补齐
    assert.equal(R.mergeFetched('42', { rate: 8, comment: '还行' }), true);
    assert.equal(R._ctx.rate, 8);
    assert.equal(R._ctx.comment, '还行');
    assert.deepEqual(JSON.parse(JSON.stringify(R._ctx.tags)), [], '无 tags 键时标签保持开窗初值');
    R._close(false);
});

// ---------------------------------------------------------------- 评分文案（T-A：5 分标签错字修正）

test('fmtRateLabel：5 分标签为「一般」（错字「不过不去」修正），其余档位保持不动', () => {
    const R = loadBgmRate();
    assert.equal(R.fmtRateLabel(5), '5 分 · 一般');
    // 邻档回归：只动 5 分，其它档位文案不得被顺手改掉
    assert.equal(R.fmtRateLabel(1), '1 分 · 不忍直视');
    assert.equal(R.fmtRateLabel(2), '2 分 · 很差');
    assert.equal(R.fmtRateLabel(3), '3 分 · 差');
    assert.equal(R.fmtRateLabel(4), '4 分 · 较差');
    assert.equal(R.fmtRateLabel(6), '6 分 · 还行');
    assert.equal(R.fmtRateLabel(7), '7 分 · 推荐');
    assert.equal(R.fmtRateLabel(8), '8 分 · 力荐');
    assert.equal(R.fmtRateLabel(9), '9 分 · 神作');
    assert.equal(R.fmtRateLabel(10), '10 分 · 超神作');
    assert.equal(R.fmtRateLabel(0), '未评分');
    assert.equal(R.fmtRateLabel(null), '未评分');
    // 文案表的唯一事实来源就是本函数（弹窗星级下方 #bgm-rate-label 与提交成功 toast
    // 都经它渲染）：错字不能留在标签表里（注释说明历史错字不算）
    const src = read('src/renderer/js/bgm-rate.js');
    const table = src.match(/const labels = \{[\s\S]*?\};/)[0];
    assert.ok(!table.includes('不过不去'), '错字「不过不去」应从标签表移除');
    assert.match(table, /5: '一般'/, '5 分档位文案应为「一般」');
    assert.match(src, /#bgm-rate-label'\)\.text\(this\.fmtRateLabel/, '弹窗徽标应经 fmtRateLabel 渲染（改一处即全局生效）');
    // 渲染层其它评分展示不走文案表（列表卡/详情页是「我的 N★」纯数值徽章），
    // 标签表若被复制他处会漏改——锁死它的唯一性
    for (const f of ['src/renderer/js/common.js', 'src/renderer/js/records.js', 'src/renderer/js/detail.js', 'src/renderer/js/my.js']) {
        assert.ok(!read(f).includes('超神作') && !read(f).includes('不忍直视'),
            `${f} 不应复制评分文案表（统一走 BgmRate.fmtRateLabel）`);
    }
});

// ---------------------------------------------------------------- 取消二次确认（快照对比脏检查）

const tick = () => new Promise((r) => setImmediate(r));

/**
 * 取消确认交互级 VM 加载：$ 桩记录各选择器上的事件处理器（可模拟点取消按钮/点遮罩/
 * 吐槽打字），confirmDialog 为可控 Promise 桩（记录文案与按钮文案，由测试决定确认/取消），
 * 吐槽正文与标签草稿存进 vals 随 val() 读写往返（贴近真实文本框行为）。
 */
function loadBgmRateCancel() {
    const source = read('src/renderer/js/bgm-rate.js');
    const calls = { closeDialog: [], confirm: [] };
    const handlers = {};
    const vals = { '#bgm-rate-comment': '', '#bgm-rate-tag-input': '' };
    const mk$ = (sel) => {
        const api = {
            on: (ev, fn) => {
                if (typeof fn === 'function') {
                    const k = `${String(sel)}|${String(ev)}`;
                    (handlers[k] = handlers[k] || []).push(fn);
                }
                return api;
            },
            off: () => api, text: () => api, html: () => api,
            show: () => api, hide: () => api, trigger: () => api,
            toggleClass: () => api, attr: () => api,
            val: (v) => {
                if (v === undefined) return vals[sel] === undefined ? '' : vals[sel];
                vals[sel] = v;
                return api;
            },
            prop: () => api,
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
        document: { activeElement: null },
        doAction: async () => ({ code: 200, result: { uploaded: 1, failed: 0, results: [{ subjectId: '42', ok: true, msg: 'ok' }] } }),
        warnToast: () => {},
        escHtml: (s) => String(s),
        openDialog: () => {},
        closeDialog: (id) => { calls.closeDialog.push(id); },
        confirmDialog: (msg, opts) => {
            const call = { msg: String(msg), opts: opts || {} };
            calls.confirm.push(call);
            return new Promise((resolve) => { call.resolve = resolve; });
        },
        FavHub: { changed: () => {} },
        Kazumi: { _getBangumiToken: async () => 'tok' },
    };
    context.globalThis = context;
    context.window = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__R = BgmRate;`, context, { filename: 'bgm-rate.js' });
    // 触发选择器上记录到的事件处理器（this 带上 value，供吐槽框 input 监听读取 this.value）
    const fire = (sel, ev, evt) => {
        (handlers[`${sel}|${ev}`] || []).forEach((fn) => fn.call({ value: vals[sel] }, evt));
    };
    const closings = () => calls.closeDialog.filter((id) => id === 'bgmRateDialog').length;
    // 结掉最后一个待决确认框（true=确认放弃，false=取消/留在弹窗）
    const settleConfirm = async (v) => {
        const c = calls.confirm[calls.confirm.length - 1];
        assert.ok(c && c.resolve, '应存在一个待决的确认框');
        c.resolve(v);
        await tick();
    };
    return { R: context.__R, context, calls, vals, fire, closings, settleConfirm };
}

test('hasUnsavedChanges：快照对比口径（评分/未评分等价/吐槽/标签/标签草稿）', () => {
    const R = loadBgmRate();
    const E = { rate: null, comment: '', tags: [], tagDraft: '' };
    // 全空（未评分未填）→ 无改动
    assert.equal(R.hasUnsavedChanges(E, { rate: null, comment: '', tags: [], tagDraft: '' }), false);
    assert.equal(R.hasUnsavedChanges(undefined, undefined), false, '两侧都缺省 = 无改动');
    // 评分：同值/变化/清除
    assert.equal(R.hasUnsavedChanges({ rate: 8 }, { rate: 8 }), false);
    assert.equal(R.hasUnsavedChanges({ rate: 8 }, { rate: 3 }), true);
    assert.equal(R.hasUnsavedChanges({ rate: 8 }, { rate: 0 }), true, '已有评分 → 清除评分 = 改动');
    assert.equal(R.hasUnsavedChanges({ rate: 8 }, { rate: null }), true);
    // 未评分与 0（清除评分）在对话框里展示一致（都「未评分」、星级全灭）：视为同一状态
    assert.equal(R.hasUnsavedChanges({ rate: null }, { rate: 0 }), false, 'null/0 都展示未评分：不算改动');
    assert.equal(R.hasUnsavedChanges({ rate: 0 }, { rate: null }), false);
    // 吐槽：原文比较（不套提交前的 trim，纯空格也是敲进去的内容）
    assert.equal(R.hasUnsavedChanges(E, { rate: null, comment: '好看' }), true);
    assert.equal(R.hasUnsavedChanges({ comment: ' 好看 ' }, { comment: ' 好看 ' }), false);
    assert.equal(R.hasUnsavedChanges({ comment: '' }, { comment: ' ' }), true);
    // 标签：逐项比序（提交语义是整体覆盖）
    assert.equal(R.hasUnsavedChanges({ tags: ['神作'] }, { tags: ['神作'] }), false);
    assert.equal(R.hasUnsavedChanges({ tags: ['神作'] }, { tags: ['神作', 'TV'] }), true);
    assert.equal(R.hasUnsavedChanges({ tags: ['神作'] }, { tags: [] }), true);
    assert.equal(R.hasUnsavedChanges({ tags: ['神作', 'TV'] }, { tags: ['TV', '神作'] }), true, '顺序变化也会写远端');
    // 标签草稿（未回车入列）：关闭会一起丢，算改动
    assert.equal(R.hasUnsavedChanges(E, { rate: null, tagDraft: '科幻' }), true);
    assert.equal(R.hasUnsavedChanges({ tagDraft: '科幻' }, { tagDraft: '科幻' }), false);
});

test('取消二次确认：无评分无改动 / 有评分无改动 → 不弹确认，直接关（resolve(false)）', async () => {
    const h = loadBgmRateCancel();
    // ① 什么都没填就关
    const p1 = h.R.openRateDialog({ subjectId: '42', name: 'X' });
    h.fire('#bgm-rate-cancel', 'click');
    assert.equal(h.calls.confirm.length, 0, '无改动不得弹确认');
    assert.equal(await p1, false, '取消语义保持 resolve(false)');
    assert.equal(h.R._ctx, null, '关闭后 _ctx 复位（待决 Promise 已 settle）');
    assert.equal(h.R._resolve, null);
    assert.equal(h.closings(), 1, '对话框关闭一次');
    // ② 已有评分但没动任何东西
    const p2 = h.R.openRateDialog({ subjectId: '42', name: 'X', rate: 8, comment: '原吐槽', tags: ['神作'] });
    h.fire('#bgm-rate-cancel', 'click');
    assert.equal(h.calls.confirm.length, 0, '已有评分未改动同样不弹');
    assert.equal(await p2, false);
    // ③ 开窗后只等补查数据合并（快照同步推进）：仍不算改动
    const h2 = loadBgmRateCancel();
    const p3 = h2.R.openRateDialog({ subjectId: '42', name: 'X' });
    assert.equal(h2.R.mergeFetched('42', { rate: 7, comment: '还行', tags: ['旧标签'] }), true);
    h2.fire('#bgm-rate-cancel', 'click');
    assert.equal(h2.calls.confirm.length, 0, '补查合并只是「用户看到的初始内容」，不是本次改动');
    assert.equal(await p3, false);
});

test('取消二次确认：无评分但填了内容 → 弹确认；取消=留在弹窗，再取消确认=放弃关闭', async () => {
    const h = loadBgmRateCancel();
    const p = h.R.openRateDialog({ subjectId: '42', name: 'X' });
    // 吐槽框打字（input 事件同时置 _touched 与同步 _ctx.comment）
    h.vals['#bgm-rate-comment'] = '期待第二季';
    h.fire('#bgm-rate-comment', 'input');
    h.fire('#bgm-rate-cancel', 'click');
    await tick();
    assert.equal(h.calls.confirm.length, 1, '有本次未保存改动应弹确认');
    assert.match(h.calls.confirm[0].msg, /取消编辑会丢失本次填写的内容/, '文案应表达「取消编辑会丢失内容」');
    assert.equal(h.calls.confirm[0].opts.okText, '放弃修改');
    assert.equal(h.calls.confirm[0].opts.cancelText, '继续编辑');
    assert.ok(h.R._resolve, '确认期间会话挂起未关闭');
    assert.ok(h.R._ctx, '确认期间对话框仍在编辑态');
    assert.equal(h.closings(), 0, '确认未回前不得关闭对话框');
    // 取消确认 = 留在弹窗继续编辑：不关、Promise 不 settle
    let settled = false;
    p.then(() => { settled = true; });
    await h.settleConfirm(false);
    assert.equal(settled, false, '取消确认后打开 Promise 仍挂起');
    assert.ok(h.R._resolve);
    assert.equal(h.closings(), 0, '取消确认不得关闭对话框');
    // 改动仍在：再次取消应再问一次；这次确认放弃 → 关闭并 resolve(false)
    h.fire('#bgm-rate-cancel', 'click');
    await tick();
    assert.equal(h.calls.confirm.length, 2, '改动仍在：再次取消再问一次');
    await h.settleConfirm(true);
    assert.equal(await p, false, '放弃改动关闭：保持 resolve(false) 语义');
    assert.equal(h.R._ctx, null);
    assert.equal(h.R._resolve, null, '待决 Promise 已清理');
    assert.equal(h.closings(), 1, '确认放弃只关闭一次');
    assert.equal(h.R._closeConfirming, false, '确认结束复位防重入标记');
});

test('取消二次确认：有评分且本次改了数据 → 弹；改回原值 → 不弹（快照对比）', async () => {
    const h = loadBgmRateCancel();
    // ① 8 分 → 改 3 分 → 取消：弹
    const p1 = h.R.openRateDialog({ subjectId: '42', name: 'X', rate: 8 });
    h.R._pickRate(3);
    h.fire('#bgm-rate-cancel', 'click');
    await tick();
    assert.equal(h.calls.confirm.length, 1, '已有评分 + 本次改动 → 弹确认');
    await h.settleConfirm(true);
    assert.equal(await p1, false);
    // ② 8 分 → 3 分 → 改回 8 分 → 取消：不弹（触碰标记表达不了，快照对比才行）
    const p2 = h.R.openRateDialog({ subjectId: '42', name: 'X', rate: 8 });
    h.R._pickRate(3);
    h.R._pickRate(8);
    assert.equal(h.R._touched, true, '期间确实触碰过编辑（_touched 已置位）');
    h.fire('#bgm-rate-cancel', 'click');
    assert.equal(h.calls.confirm.length, 1, '改回原值 = 无改动：不得弹确认');
    assert.equal(await p2, false);
    // ③ 标签「加了又删掉」同样是改回原值：不弹
    const p3 = h.R.openRateDialog({ subjectId: '42', name: 'X', rate: 8, tags: ['神作'] });
    h.R._toggleTag('科幻');
    h.R._toggleTag('科幻');
    h.fire('#bgm-rate-cancel', 'click');
    assert.equal(h.calls.confirm.length, 1, '标签改回原集合 = 无改动：不得弹');
    assert.equal(await p3, false);
    // ④ 已有评分 → 清除评分：是改动，弹
    const p4 = h.R.openRateDialog({ subjectId: '42', name: 'X', rate: 8 });
    h.R._clearRate();
    h.fire('#bgm-rate-cancel', 'click');
    await tick();
    assert.equal(h.calls.confirm.length, 2, '已有评分 → 清除评分 = 改动，应弹');
    await h.settleConfirm(true);
    assert.equal(await p4, false);
    // ⑤ 未评分 → 拨到 0（清除评分）：视觉上仍是「未评分」，不算改动、不弹
    const p5 = h.R.openRateDialog({ subjectId: '42', name: 'X' });
    h.R._clearRate();
    h.fire('#bgm-rate-cancel', 'click');
    assert.equal(h.calls.confirm.length, 2, 'null/0 都是未评分：不视为改动');
    assert.equal(await p5, false);
});

test('取消二次确认：编辑入口全覆盖（星级/清除评分/吐槽/标签/自定义草稿/颜文字）', async () => {
    const h = loadBgmRateCancel();
    const cases = [
        ['星级点击', () => h.R._pickRate(6)],
        ['清除评分', () => h.R._clearRate()],
        ['吐槽打字', () => { h.vals['#bgm-rate-comment'] = '好看'; h.fire('#bgm-rate-comment', 'input'); }],
        ['标签 toggle', () => h.R._toggleTag('科幻')],
        ['自定义标签草稿（未回车）', () => { h.vals['#bgm-rate-tag-input'] = '科幻'; h.fire('#bgm-rate-tag-input', 'input'); }],
        ['颜文字插入', () => h.R._insertKamoji('(￣▽￣)')],
    ];
    for (const [label, mutate] of cases) {
        const before = h.calls.confirm.length;
        const p = h.R.openRateDialog({ subjectId: '42', name: 'X', rate: 8, tags: ['神作'] });
        mutate();
        h.fire('#bgm-rate-cancel', 'click');
        await tick();
        assert.equal(h.calls.confirm.length, before + 1, `${label}：应触发丢弃确认`);
        await h.settleConfirm(true);
        assert.equal(await p, false, `${label}：确认放弃后关闭`);
        assert.equal(h.R._ctx, null, `${label}：会话已复位`);
    }
});

test('取消二次确认：Esc（wrapped closeDialog）与点遮罩同一脏检查；确认在位不叠第二层', async () => {
    const h = loadBgmRateCancel();
    // ① Esc：无改动 → 直接关（wrapped 关闭入口保持无返回值契约）
    const p1 = h.R.openRateDialog({ subjectId: '42', name: 'X', rate: 8 });
    assert.equal(h.context.closeDialog('bgmRateDialog'), undefined, 'wrapped 关闭入口无返回值');
    assert.equal(h.calls.confirm.length, 0, '无改动不弹');
    assert.equal(await p1, false);
    // ② Esc：有改动 → 弹确认；确认在位时再按 Esc 不叠第二层（防递归死锁）
    const p2 = h.R.openRateDialog({ subjectId: '42', name: 'X', rate: 8 });
    h.R._pickRate(4);
    h.context.closeDialog('bgmRateDialog');
    await tick();
    assert.equal(h.calls.confirm.length, 1, 'Esc 同样按脏检查弹确认');
    h.context.closeDialog('bgmRateDialog');
    await tick();
    assert.equal(h.calls.confirm.length, 1, '防重入：不叠第二层确认');
    assert.ok(h.R._resolve, '确认在位期间会话不关');
    let settled = false;
    p2.then(() => { settled = true; });
    await h.settleConfirm(false);            // 取消确认（等价于 Esc 关掉确认框）
    assert.equal(settled, false, '取消确认后回到编辑态，会话继续挂起');
    assert.ok(h.R._ctx, '对话框仍在编辑态');
    h.R._close(false);                       // 收尾（走原始 closeDialog，不再弹）
    assert.equal(await p2, false);
    assert.equal(h.calls.confirm.length, 1, '收尾关闭不触发确认');
    // ③ 点卡片内不关；点遮罩（无改动）直接关
    const p3 = h.R.openRateDialog({ subjectId: '42', name: 'X' });
    const inner = {};
    h.fire('#bgmRateDialog', 'click', { target: inner, currentTarget: {} });
    assert.ok(h.R._ctx, '卡片内点击不关闭');
    assert.equal(h.calls.confirm.length, 1, '卡片内点击不触发确认');
    const overlay = {};
    h.fire('#bgmRateDialog', 'click', { target: overlay, currentTarget: overlay });
    assert.equal(await p3, false, '点遮罩（无改动）直接关');
    // ④ 点遮罩 + 有改动 → 弹确认，确认放弃后关闭
    const p4 = h.R.openRateDialog({ subjectId: '42', name: 'X', rate: 8 });
    h.R._toggleTag('科幻');
    const overlay2 = {};
    h.fire('#bgmRateDialog', 'click', { target: overlay2, currentTarget: overlay2 });
    await tick();
    assert.equal(h.calls.confirm.length, 2, '点遮罩同样按脏检查弹确认');
    await h.settleConfirm(true);
    assert.equal(await p4, false);
});

test('取消二次确认：提交成功关闭不弹（改完就提交不该再问一次）', async () => {
    const h = loadBgmRateCancel();
    const p = h.R.openRateDialog({ subjectId: '42', name: 'X', rate: 8 });
    h.R._pickRate(3);
    h.vals['#bgm-rate-comment'] = '好看';
    h.fire('#bgm-rate-comment', 'input');
    assert.equal(await h.R.submit(), true, '提交成功');
    assert.equal(h.calls.confirm.length, 0, '提交路径不得弹「放弃编辑」确认');
    assert.equal(await p, true, '提交成功 resolve(true) 一次到位');
    assert.equal(h.R._ctx, null);
});

test('取消二次确认：接线形态（取消按钮/遮罩委托/closeDialog 包装统一转 requestClose）', () => {
    const src = read('src/renderer/js/bgm-rate.js');
    assert.match(src, /'#bgm-rate-cancel'\)\.on\('click'[\s\S]{0,120}?BgmRate\.requestClose\(\)/,
        '取消按钮应走 requestClose（脏检查入口）');
    assert.match(src, /'#bgmRateDialog'\)\.on\('click'/,
        '点遮罩关闭应绑定在对话框根节点（overlay 本体）');
    assert.match(src, /BgmRate\.requestClose\(\);\s*\n\s*return;/,
        'wrapped closeDialog（Esc 全局派发）应转交 requestClose');
    assert.match(src, /confirmDialog\('取消编辑会丢失本次填写的内容/,
        '确认文案应表达「取消编辑会丢失本次填写内容」');
    assert.ok(!/'#bgm-rate-cancel'\)\.on\('click'[\s\S]{0,120}?BgmRate\._close\(false\)/.test(src),
        '取消按钮不得再直连 _close 绕过确认');
});
