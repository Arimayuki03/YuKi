'use strict';
/**
 * common.js guardedLoad（A-31 加载守卫抽象）单元测试：四种语义形态。
 *
 * 形态矩阵（对齐四处先例，优化.md A-31）：
 *  1. abort 型（home.js/timeline.js _nextLoadToken 先例）：发起前 abort 旧代
 *     AbortController → 重建新一代 → ++token；AbortController 缺失时降级纯世代；
 *  2. 纯世代型（popular.js load 先例）：只 ++token，无 AbortController 交互；
 *  3. 过期丢弃（popular/detail 比对先例）：新一代入列后旧代 isLive() 为假，
 *     且回调丢弃（isLive 反转）；
 *  4. 异常清理（detail load 先例）：请求抛错不污染令牌状态，isLive 仍按令牌
 *     相等判定；宿主侧异常自增（detail 重试路径 ++gen 先例）后旧代即作废。
 *
 * 加载方式：fs.readFileSync + node:vm（与 common-utils.test.js 同款写法）。
 * 另附 timeline.js 真源装载用例：验证 _nextLoadToken 收口后行为不变（abort 旧代 +
 * token 自增），锁定「抽象替换后语义与原实现一致」。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const COMMON_SRC = path.join(__dirname, '../../src/renderer/js/common.js');
const TIMELINE_SRC = path.join(__dirname, '../../src/renderer/js/timeline.js');

/** 在 VM 沙箱载入 common.js，取 guardedLoad 真实实现（走代码里的定义而非复制）。 */
function loadCommon(extraGlobals) {
    const source = fs.readFileSync(COMMON_SRC, 'utf8');
    const context = {
        console, Date, Math, JSON, String, Number, Array, Map, Set, Promise,
        parseInt, parseFloat, setTimeout, clearTimeout,
        AbortController, // Node 18+ 原生可用；形态 1b 用 undefined 覆盖降级分支
        $: () => ({ on() { return this; } }),
        window: {},
        document: undefined,
        ...extraGlobals,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__guardedLoad = guardedLoad;`, context, { filename: 'common.js' });
    return context.__guardedLoad;
}

test('形态1 abort 型：发起前 abort 旧代 → 重建同代 AC → ++token', () => {
    const guardedLoad = loadCommon();
    const host = { _loadToken: 0, _loadAbort: null };
    // 旧代在途：isLive 前先构造第一代
    const g1 = guardedLoad(host, { abortable: true });
    assert.equal(g1.token, 1);
    assert.ok(host._loadAbort, 'abort 型必须创建 AbortController');
    assert.equal(g1.signal, host._loadAbort.signal, 'signal 与宿主 AC 同代');
    assert.equal(host._loadToken, 1);

    // 第二代入列：旧 AC 被中止、宿主指向新 AC、令牌自增
    const oldAc = host._loadAbort;
    const g2 = guardedLoad(host, { abortable: true });
    assert.equal(g2.token, 2);
    assert.notEqual(host._loadAbort, oldAc, '新一代重建 AbortController');
    assert.equal(oldAc.signal.aborted, true, '旧代在途请求被真正中止');
    assert.equal(g2.signal, host._loadAbort.signal);
});

test('形态1b abort 型降级：AbortController 缺失时退化为纯世代（对齐先例 typeof 守卫）', () => {
    const guardedLoad = loadCommon({ AbortController: undefined });
    const host = { _loadToken: 5, _loadAbort: null };
    const g = guardedLoad(host, { abortable: true });
    assert.equal(g.token, 6, '无 AC 环境仍自增令牌');
    assert.equal(host._loadAbort, null, '不创建 AbortController');
    assert.equal(g.signal, undefined, 'signal 恒为 undefined（先例 ac ? ac.signal : undefined）');
    assert.equal(g.isLive(), true);
    host._loadToken = 7;
    assert.equal(g.isLive(), false);
});

test('形态2 纯世代型：不传 abortable 只 ++token，不触碰 AbortController', () => {
    const guardedLoad = loadCommon();
    const host = { _loadToken: 0, _loadAbort: 'sentinel' };
    const g = guardedLoad(host); // popular.js load() 先例：不传 opts
    assert.equal(g.token, 1);
    assert.equal(host._loadToken, 1);
    assert.equal(host._loadAbort, 'sentinel', '纯世代型绝不创建/中止 AbortController');
    assert.equal(typeof g.isLive, 'function');
});

test('形态3 过期丢弃：新一代入列后旧代 isLive() 为假（popular/detail 比对先例）', () => {
    const guardedLoad = loadCommon();
    const host = { _loadToken: 0 };
    const g1 = guardedLoad(host);
    assert.equal(g1.isLive(), true, '仅当令牌仍最新时存活');
    const g2 = guardedLoad(host); // 模拟快速切换：新请求入列
    assert.equal(g2.isLive(), true);
    assert.equal(g1.isLive(), false, '旧响应/旧 toast 据此丢弃，不覆盖新视图');
    // 手动作废（detail _restore()/openBangumi 的宿主侧 ++gen 先例）：同样使旧代过期
    host._loadToken++;
    assert.equal(g2.isLive(), false, '宿主侧自增同样作废在途世代');
});

test('形态4 异常清理：请求抛错不改令牌状态，isLive 判定不受污染（detail load 先例）', async () => {
    // L52 契约文档用例（非行为交互）：guardedLoad 不包裹宿主 run 体内联函数，也不接受
    // 回调——异常清理由宿主侧 finally（遮罩归还）负责，本用例只锁「异常路径不触碰令牌
    // 状态」这一语义契约。真实交互覆盖见各宿主测试（home-detail/timeline/popular 的
    // 重入/世代断言）；下方 109-111 行的 gRetry 失效断言才是本文件的行为验证。
    const guardedLoad = loadCommon();
    const host = { _loadToken: 0 };
    const g = guardedLoad(host);
    // 模拟宿主 run 体内抛错（detail load 的 doAction 异常路径）：run 为测试本地函数，
    // 与 guardedLoad 无真实交互，其抛错不影响 host 令牌——守卫状态零污染
    const run = async () => { throw new Error('net down'); };
    await assert.rejects(run());
    assert.equal(host._loadToken, g.token, '异常不自增/回退令牌——守卫状态零污染');
    assert.equal(g.isLive(), true, '同一代内失败后 isLive 仍存活（finally 归还遮罩靠它）');
    // 重试路径（A-03 先例）：重入 guardedLoad 自增 → 旧代失效
    const gRetry = guardedLoad(host);
    assert.equal(gRetry.token, g.token + 1);
    assert.equal(g.isLive(), false);
});

test('timeline.js 真源收口回归：_nextLoadToken 行为与原实现一致（abort 旧代 + 自增）', () => {
    const source = fs.readFileSync(TIMELINE_SRC, 'utf8');
    const context = {
        console, Date, Math, JSON, String, Number, Array, Map, Set, parseInt, AbortController,
        $: () => ({ on() { return this; }, off() { return this; }, find() { return { on() {} }; }, length: 0 }),
        window: { on() { return this; }, addEventListener() {} },
        document: { addEventListener() {}, documentElement: { classList: { toggle() {} } }, body: { style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {} } } },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${fs.readFileSync(COMMON_SRC, 'utf8')}\n;${source}\n;globalThis.__T = Timeline;`, context, { filename: 'timeline.js' });
    const T = context.__T;
    T._loadToken = 0;
    T._loadAbort = null;
    const t1 = T._nextLoadToken();
    assert.equal(t1, 1);
    assert.ok(T._loadAbort);
    const oldAc = T._loadAbort;
    const t2 = T._nextLoadToken();
    assert.equal(t2, 2);
    assert.notEqual(T._loadAbort, oldAc);
    assert.equal(oldAc.signal.aborted, true, '切季度中止旧代在途请求（原语义保持）');
    assert.equal(T._loadToken, 2);
});

test('home.js 同构 sanity：guardedLoad 连续调用令牌单调递增（loadCategory/搜索共用口径）', () => {
    const guardedLoad = loadCommon();
    const host = { _loadToken: 100, _loadAbort: null };
    const tokens = [1, 2, 3].map(() => guardedLoad(host, { abortable: true }).token);
    assert.deepEqual(tokens, [101, 102, 103]);
});

test('L31 未初始化宿主兜底：_loadToken 缺失时自增从 1 起步，isLive 不因 NaN 恒假', () => {
    const guardedLoad = loadCommon();
    // 宿主完全未声明 _loadToken（公共 API 的静默脚枪场景）
    const host = {};
    const g1 = guardedLoad(host);
    assert.equal(g1.token, 1, 'undefined 兜底为 0 后 +1，而非 NaN');
    assert.equal(host._loadToken, 1, '宿主令牌同步落位（后续宿主侧比对可用）');
    assert.equal(g1.isLive(), true, '新代必须存活——NaN 语义下会恒假');
    const g2 = guardedLoad(host);
    assert.equal(g2.token, 2);
    assert.equal(g1.isLive(), false, '换代后旧代照常过期');
    assert.equal(g2.isLive(), true);
    // 宿主令牌被外部置 null（异常清理/重置）同样不产生 NaN
    host._loadToken = null;
    const g3 = guardedLoad(host);
    assert.equal(g3.token, 1);
    assert.equal(g3.isLive(), true);
});
