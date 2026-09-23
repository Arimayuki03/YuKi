'use strict';
/**
 * player-internals.test.js —— 渲染层播放器相关模块的**白盒**分支补充单测。
 *
 * 覆盖对象：src/renderer/js/player.js / ad-skip.js / bgm-rate.js
 *
 * 与既有测试的互补定位（不重复已有断言，只补未覆盖分支）：
 *   - player-watch.test.js：观看统计 / 连播推进 / 重连的**主流程**；
 *     本文件补纯函数 mergePlayHeaders / isPanQueueSource 的入参矩阵，
 *     以及 _onExit 重连判定的边界（起播即失败 / 中段断流 / 二次不重连）。
 *   - player-contract.test.js：_resolvePlayerRoute 路由；本文件不重复。
 *   - ad-skip.test.js：OP/ED 存储闭环与 play() 集成；本文件补
 *     _adSkip() 依赖获取、_onPreviewTick 进度监听与重复触发抑制、
 *     以及 AdSkip 决策函数在非法/边界入参下的取值。
 *   - bgm-rate.test.js：clampRate / payload 契约 / 防重入 / closeDialog 递归；
 *     本文件补 fetchCurrent 三条分支、submit 的失败重试与错误提示通道、
 *     越界脏值不落后端、XSS 通道、_pickRate/_clearRate 星级状态机、
 *     injectCardActions 幂等性。
 *
 * 渲染层脚本非 CommonJS：一律 fs.readFileSync + node:vm 注入全局桩加载。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer', 'js');
const readSrc = (name) => fs.readFileSync(path.join(RENDERER, name), 'utf8');

const PLAYER_SRC = readSrc('player.js');
const ADSKIP_SRC = readSrc('ad-skip.js');
const BGMRATE_SRC = readSrc('bgm-rate.js');

/** vm 沙箱里创建的对象跨 realm：node:assert/strict 的 deepEqual 会因原型不同而失败，
 *  统一经 JSON 往返回宿主 realm 再比较（只用于纯数据对象）。 */
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

// ─────────────────────────────────────────────────────────────── 全局桩工厂

/** 链式 jQuery 桩：记录 text/html/append/prop/show/hide 调用，供白盒断言。 */
function createJq(sink) {
    const mk = (sel) => {
        const api = {
            length: 0,
            on(evt, a, b) {
                sink.handlers.push({
                    sel: typeof sel === 'string' ? sel : '<el>',
                    evt,
                    delegate: typeof a === 'string' ? a : '',
                    fn: typeof a === 'function' ? a : b,
                });
                return api;
            },
            text(v) { if (v !== undefined) sink.texts.push({ sel, v: String(v) }); return api; },
            html(v) { if (v !== undefined) sink.htmls.push({ sel, v: String(v) }); return api; },
            val(v) {
                if (v === undefined) return (sink.vals[sel] === undefined ? '' : sink.vals[sel]);
                sink.vals[sel] = v;
                return api;
            },
            prop(k, v) { sink.props.push({ sel, k, v }); return api; },
            append(v) { if (v !== undefined) sink.appends.push({ sel, v: String(v) }); return api; },
            appendTo() { return api; },
            show() { sink.shows.push(sel); return api; },
            hide() { sink.hides.push(sel); return api; },
            toggle() { return api; },
            trigger() { return api; },
            empty() { return api; },
            each(fn) { (sink.eachItems || []).forEach((it, i) => fn.call(it, i, it)); return api; },
            find(sub) {
                const sub2 = mk(sub);
                sub2.length = (sink.findLength[sub] === undefined) ? 0 : sink.findLength[sub];
                sub2.each = (fn) => {
                    (sink.findItems[sub] || []).forEach((it, i) => fn.call(it, i, it));
                    return sub2;
                };
                return sub2;
            },
            data(k) { return (sink.dataVals[k] === undefined) ? '' : sink.dataVals[k]; },
            remove() { return api; },
            addClass() { return api; },
            removeClass() { return api; },
            css() { return api; },
            attr() { return api; },
            pause() { return api; },
            removeAttribute() { return api; },
            load() { return api; },
            play() { return Promise.resolve(); },
        };
        return api;
    };
    return mk;
}

function newSink() {
    return {
        handlers: [], texts: [], htmls: [], props: [], appends: [],
        shows: [], hides: [], vals: {}, dataVals: {},
        findLength: {}, findItems: {}, eachItems: [],
        toasts: [], dialogs: [], closes: [], loadings: [],
        videoEl: null,
    };
}

/** 渲染层 window.yuki 假实现：默认全部安全降级，调用方按需覆盖。 */
function makeYuki(settings, extra = {}) {
    return Object.assign({
        settingsGet: async () => JSON.parse(JSON.stringify(settings)),
        settingsSet: async (k, v) => { settings[k] = JSON.parse(JSON.stringify(v)); },
        playUrl: async (url) => ({ ok: true, sessionId: 1, url }),
        playerControl: async () => ({ ok: false }),
        playerConfig: async () => ({ mode: 'internal' }),
        buildPlaylist: async () => ({ ok: false }),
        cancelRuntime: async () => ({}),
        resolveParse: async () => ({ ok: false }),
        captureDirect: async () => ({ ok: false }),
        externalPlayer: async () => ({ ok: false }),
        onPlayerEnded() {}, onPlayerExit() {}, onEpisodeSkip() {}, onExternalPlayerExit() {},
    }, extra);
}

/**
 * 在 VM 中加载 player.js（可选先加载 ad-skip.js 提供 AdSkip 依赖）。
 * @returns {{ player, ctx, sink, settings, yuki, AdSkip }}
 */
function loadPlayer(opts = {}) {
    const settings = opts.settings || {};
    const sink = opts.sink || newSink();
    const yuki = makeYuki(settings, opts.yuki);
    const documentStub = {
        addEventListener() {},
        getElementById: (id) => (id === 'player-video' ? sink.videoEl : null),
        querySelector: () => null,
    };
    const context = {
        console,
        Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        parseInt, parseFloat, isNaN,
        setTimeout, clearTimeout, setImmediate,
        URL, AbortController, RegExp, Error,
        document: documentStub,
        navigator: { clipboard: { writeText: async () => {} } },
        createRuntimeId: (p) => `${p}-t-${Math.random().toString(36).slice(2)}`,
        showLoading: (m) => sink.loadings.push(String(m)),
        hideLoading: () => sink.loadings.push('__hide__'),
        openDialog: (id) => sink.dialogs.push(id),
        closeDialog: (id) => sink.closes.push(id),
        warnToast: (m) => sink.toasts.push(String(m)),
        getJson: async () => ({ flags: [], parses: [] }),
        doAction: opts.doAction || (async () => ({ url: 'http://cdn.example/v.m3u8', parse: 0, header: {} })),
        $: createJq(sink),
        __sink: sink,
    };
    Object.assign(context, opts.globals || {});
    context.window = context;   // 自引用：window.yuki 与裸标识符 yuki 双通道
    context.yuki = yuki;
    const storeBacking = opts.storeBacking || new Map();
    context.localStorage = {
        getItem: (k) => (storeBacking.has(k) ? storeBacking.get(k) : null),
        setItem: (k, v) => storeBacking.set(k, String(v)),
        removeItem: (k) => storeBacking.delete(k),
    };
    context.globalThis = context;
    vm.createContext(context);
    const prelude = opts.withAdSkip === false ? '' : `${ADSKIP_SRC}\n`;
    vm.runInContext(
        `${prelude}${PLAYER_SRC}\n;`
        + 'globalThis.__Player = Player;'
        + 'globalThis.__mergePlayHeaders = mergePlayHeaders;'
        + 'globalThis.__isPanQueueSource = isPanQueueSource;'
        + 'globalThis.__adSkip = _adSkip;'
        + 'globalThis.__DIRECT_MEDIA_RE = DIRECT_MEDIA_RE;',
        context, { filename: 'player.js' });
    return { player: context.__Player, ctx: context, sink, settings, yuki, storeBacking, AdSkip: context.AdSkip };
}

/** 单独加载 ad-skip.js（store 可注入为 null 模拟 localStorage 不可用）。 */
function loadAdSkip(opts = {}) {
    const backing = opts.storeBacking || new Map();
    const localStorageStub = opts.localStorage === null ? null : {
        getItem: (k) => (backing.has(k) ? backing.get(k) : null),
        setItem: (k, v) => backing.set(k, String(v)),
        removeItem: (k) => backing.delete(k),
    };
    const context = {
        console, Date, JSON, Math, Object, Number, String, Array, RegExp,
        localStorage: localStorageStub,
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(ADSKIP_SRC, context, { filename: 'ad-skip.js' });
    return { AdSkip: context.AdSkip, backing, ctx: context };
}

/**
 * 加载 bgm-rate.js（可注入 doAction / Kazumi / closeDialog 等）。
 * @returns {{ R, ctx, sink, calls }}
 */
function loadBgmRate(overrides = {}) {
    const sink = overrides.sink || newSink();
    const calls = { doAction: [], close: [], open: [] };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        setTimeout, clearTimeout, RegExp, Error,
        $: createJq(sink),
        doAction: async (...args) => {
            calls.doAction.push(args);
            return (overrides.doActionResponse !== undefined)
                ? overrides.doActionResponse
                : { code: 200, result: { uploaded: 1, failed: 0, results: [{ subjectId: '42', ok: true, msg: 'ok' }] } };
        },
        warnToast: (m) => sink.toasts.push(String(m)),
        escHtml: (s) => String(s),
        openDialog: (id) => { calls.open.push(id); sink.dialogs.push(id); },
        closeDialog: (id) => { calls.close.push(id); sink.closes.push(id); },
        FavHub: { changed: () => { calls.favChanged = (calls.favChanged || 0) + 1; } },
        Kazumi: overrides.Kazumi || { _getBangumiToken: async () => 'tok' },
    };
    if (overrides.noKazumi) delete context.Kazumi;
    Object.assign(context, overrides.globals || {});
    if (overrides.doActionImpl) context.doAction = async (...args) => { calls.doAction.push(args); return overrides.doActionImpl(...args); };
    context.globalThis = context;
    context.window = context;   // bgm-rate.js 尾部 IIFE 走 window 分支
    vm.createContext(context);
    vm.runInContext(`${BGMRATE_SRC}\n;globalThis.__R = BgmRate;`, context, { filename: 'bgm-rate.js' });
    return { R: context.__R, ctx: context, sink, calls };
}

// ═══════════════════════════════════════════════════════════ player.js

describe('player', () => {

    test('_adSkip：AdSkip 缺失（单测只加载 player.js）返回 null，OP/ED 入口整体禁用', () => {
        const { ctx } = loadPlayer({ withAdSkip: false });
        assert.equal(ctx.__adSkip(), null, 'AdSkip 未定义时必须返回 null 而非抛错');
        // 同一沙箱里 AdSkip 全局也应未定义（typeof 判空路径）
        assert.equal(typeof ctx.AdSkip, 'undefined');
    });

    test('_adSkip：AdSkip 已加载时返回同一模块实例（含决策函数）', () => {
        const { ctx, AdSkip } = loadPlayer();
        assert.equal(ctx.__adSkip(), AdSkip);
        assert.equal(typeof AdSkip.decideEdAction, 'function');
        assert.equal(typeof AdSkip.resolveAutoOpSec, 'function');
    });

    test('mergePlayHeaders：后来源覆盖前来源同名头（大小写不敏感归一）', () => {
        const { ctx } = loadPlayer();
        const out = plain(ctx.__mergePlayHeaders(
            { Referer: 'https://a.example' },
            { referer: 'https://b.example' }));
        assert.deepEqual(out, { referer: 'https://b.example' },
            '后来者胜，且保留后来者自身的键大小写');
    });

    test('mergePlayHeaders：同一来源内大小写不同的键去重，保留首次出现的写法', () => {
        const { ctx } = loadPlayer();
        const out = plain(ctx.__mergePlayHeaders({ 'X-Token': '1' }, { 'x-token': '2' }));
        assert.deepEqual(Object.keys(out), ['x-token']);
        assert.equal(out['x-token'], '2');
        // 反向顺序：保留首个来源的原始大小写
        const out2 = plain(ctx.__mergePlayHeaders({ 'x-token': '1' }, { 'X-Token': '2' }));
        assert.deepEqual(Object.keys(out2), ['X-Token']);
        assert.equal(out2['X-Token'], '2');
    });

    test('mergePlayHeaders：空值（null/undefined/空串）与空白键一律剔除', () => {
        const { ctx } = loadPlayer();
        const out = plain(ctx.__mergePlayHeaders({
            'X-A': null, 'X-B': undefined, 'X-C': '', 'X-D': 'ok',
            '   ': 'blank-key', 'X-E': 'keep',
        }));
        assert.deepEqual(out, { 'X-D': 'ok', 'X-E': 'keep' });
    });

    test('mergePlayHeaders：键首尾空白被 trim 后归一（" X-F " 与 "X-F" 同键）', () => {
        const { ctx } = loadPlayer();
        const out = plain(ctx.__mergePlayHeaders({ ' X-F ': '1' }, { 'X-F': '2' }));
        assert.deepEqual(Object.keys(out), ['X-F']);
        assert.equal(out['X-F'], '2');
    });

    test('mergePlayHeaders：undefined / null / 非对象入参被静默跳过', () => {
        const { ctx } = loadPlayer();
        assert.deepEqual(plain(ctx.__mergePlayHeaders()), {});
        assert.deepEqual(plain(ctx.__mergePlayHeaders(undefined, null)), {});
        assert.deepEqual(plain(ctx.__mergePlayHeaders(0, 'str', true, 42)), {},
            '数字/字符串/布尔不是对象，整项跳过');
        assert.deepEqual(plain(ctx.__mergePlayHeaders([{ 'X-A': '1' }])), { '0': '[object Object]' },
            '数组不是头表：索引被当键、元素被 String() 强转（调用方不应传数组，此处锁死行为）');
        assert.deepEqual(plain(ctx.__mergePlayHeaders(['X-A'])), { '0': 'X-A' });
        assert.deepEqual(plain(ctx.__mergePlayHeaders({ 'X-A': '1' }, null, { 'X-B': '2' })),
            { 'X-A': '1', 'X-B': '2' }, '中间的 null 不影响其余来源');
    });

    test('mergePlayHeaders：敏感头（Referer/User-Agent/Cookie）照常合并且值强转为字符串', () => {
        const { ctx } = loadPlayer();
        const out = plain(ctx.__mergePlayHeaders(
            { Referer: 'https://site.example', 'User-Agent': 'UA/1.0' },
            { Cookie: 'sid=abc', 'X-Num': 42, 'X-Bool': false, 'X-Zero': 0 }));
        assert.deepEqual(out, {
            Referer: 'https://site.example',
            'User-Agent': 'UA/1.0',
            Cookie: 'sid=abc',
            'X-Num': '42',
            'X-Bool': 'false',
            'X-Zero': '0',
        }, '非字符串值经 String() 强转；0/false 不是空值，必须保留');
    });

    test('mergePlayHeaders：合并不修改任何入参对象（纯函数，返回新对象）', () => {
        const { ctx } = loadPlayer();
        const a = { Referer: 'https://a.example' };
        const b = { referer: 'https://b.example', 'X-Extra': '1' };
        const beforeA = JSON.stringify(a);
        const beforeB = JSON.stringify(b);
        const out = ctx.__mergePlayHeaders(a, b);
        assert.equal(JSON.stringify(a), beforeA, '入参 a 不得被改写');
        assert.equal(JSON.stringify(b), beforeB, '入参 b 不得被改写');
        assert.equal(out.referer, 'https://b.example');
        assert.notEqual(out, a);
        assert.notEqual(out, b);
        // 交叉验证：合并结果按引用读取仍是原始值（未被后续合并污染）
        const out2 = ctx.__mergePlayHeaders(a, b);
        assert.equal(JSON.stringify(out2), JSON.stringify(out), '重复合并结果稳定（幂等）');
        assert.equal(a.Referer, 'https://a.example');
    });

    test('isPanQueueSource：空站点 / 空线路 / 空集目一律不算网盘源', () => {
        const { ctx } = loadPlayer();
        const f = ctx.__isPanQueueSource;
        assert.equal(f('', '', []), false);
        assert.equal(f('', '', null), false);
        assert.equal(f('csp_demo', '', []), false);
        assert.equal(f('', '剧情', []), false);
        assert.equal(f(undefined, undefined, undefined), false);
    });

    test('isPanQueueSource：集目 id/url 命中网盘特征即算（站点名干净也拦）', () => {
        const { ctx } = loadPlayer();
        const f = ctx.__isPanQueueSource;
        assert.equal(f('csp_clean', '剧情',
            [{ name: '第1集', url: 'https://pan.quark.cn/s/abc' }]), true);
        // 集目只有 id（无 url）：id ?? url 回退生效
        assert.equal(f('csp_clean', '剧情',
            [{ name: '第1集', id: 'http://127.0.0.1:9978/proxy?do=pan&site=quark' }]), true);
        // 混合集目：任一集命中即整源算网盘（宁可保守不建队）
        assert.equal(f('csp_clean', '剧情',
            [{ name: '第1集', url: '/detail/1' }, { name: '第2集', url: 'https://pan.baidu.com/s/x' }]), true);
    });

    test('isPanQueueSource：普通词（company/japan/ep115/第123集）不误伤；Kazumi 源一律豁免', () => {
        const { ctx } = loadPlayer();
        const f = ctx.__isPanQueueSource;
        assert.equal(f('company', 'japan', [{ url: 'ep115' }]), false,
            'pan/ali 需两侧不与字母相邻、115 需前不邻字母数字后不邻数字');
        // Kazumi 规则引擎豁免：规则名含「移动/ali」等子串不得误伤
        assert.equal(f('kazumi:移动番剧', '', [{ url: 'https://pan.quark.cn/s/x' }]), false);
        assert.equal(f('kazumi:阿里嘎多', 'ali', [{ url: 'ep1' }]), false);
    });

    test('isPanQueueSource：非数组 episodes 退化为不扫描集目，仅按 site|flag 判定', () => {
        const { ctx } = loadPlayer();
        const f = ctx.__isPanQueueSource;
        assert.equal(f('csp_clean', '剧情', { url: 'https://pan.quark.cn/s/x' }), false,
            '对象入参不是数组 → epsText 为空串，只看 site|flag');
        assert.equal(f('csp_clean', '剧情', 'https://pan.quark.cn/s/x'), false,
            '字符串入合同理');
        assert.equal(f('csp_clean', '夸克云盘', null), true, 'flag 命中仍然生效');
    });

    test('isPanQueueSource 与主进程 isPanQueueRequest 判定口径一致（同源 PAN_SOURCE_RE 逐例比对）', () => {
        // 主进程模块是 CommonJS，可直接 require 拿真实实现做交叉验证
        const { isPanQueueRequest, PAN_SOURCE_RE } = require(path.join(ROOT, 'src', 'main', 'pan-source.js'));
        const { ctx } = loadPlayer();
        const f = ctx.__isPanQueueSource;
        // 渲染层的正则字面量必须与主进程常量逐字符等价（两处手工同步，靠此用例锁死漂移）
        const rendererReSource = /return (?<body>\/(?<!\\).*?\/i)\.test\(/.exec(PLAYER_SRC);
        assert.ok(rendererReSource, 'player.js 的 isPanQueueSource 应以内联正则调用 .test()');
        // 在干净上下文里取该正则字面量的 source（避免 eval），与主进程常量逐字符比对
        const rendererSource = vm.runInNewContext(`(${rendererReSource.groups.body}).source`);
        assert.equal(rendererSource, PAN_SOURCE_RE.source,
            '渲染层正则与主进程 PAN_SOURCE_RE 必须逐字符一致（改动须两处同步）');
        const cases = [
            ['csp_QuarkPan', 'Quark云盘', [{ id: 'fid1' }]],
            ['csp_clean', '剧情', [{ id: 'https://pan.quark.cn/s/abc' }]],
            ['csp_clean', '剧情', [{ id: 'http://127.0.0.1:9978/proxy?do=pan&site=quark&shareId=s1' }]],
            ['csp_douban', '剧情', [{ id: '/detail/1' }]],
            ['company', 'japan', [{ id: 'ep115' }]],
            ['csp_ali', '剧情', [{ id: 'ep1' }]],
            ['云盘资源', '夸克云盘', [{ id: 'fid' }]],
            ['site_a', '第123集', [{ id: 'x' }]],
            ['site_a', '天翼云盘', [{ id: 'x' }]],
            ['site_a', '', []],
        ];
        for (const [site, flag, eps] of cases) {
            // 渲染层按 (site, flag, episodes)，主进程按 {kind, site, flag, eps}
            const rendererVerdict = f(site, flag, eps.map((e) => ({ id: e.id, url: e.id })));
            const mainVerdict = isPanQueueRequest({ kind: 'catvod', site, flag, eps: eps.map((e) => ({ id: e.id })) });
            assert.equal(rendererVerdict, mainVerdict,
                `口径不一致：site=${site} flag=${flag} → 渲染层=${rendererVerdict} 主进程=${mainVerdict}`);
        }
        // ── 口径漂移点（已确认存在，用断言固化现状，见报告）──
        // ① 纯数字集号 115/123：CJK 边界不生效 → 误判网盘（第123集/é集目 id=115）
        assert.equal(isPanQueueRequest({ kind: 'catvod', site: 'csp_demo', flag: '剧情', eps: [{ id: '115' }] }), true,
            '纯数字集号 115 被判为网盘（已知误伤）');
        assert.equal(f('csp_demo', '剧情', [{ id: '115' }]), true, '渲染层同主进程：同样误判');
        assert.equal(f('csp_demo', '剧情', [{ id: '114' }]), false, '114 不命中（只有 115/123 两个数字被拦）');
        // ② 主进程只看 eps[].id，渲染层按 url ?? id —— 只有 url 的集目两者判定相反
        assert.equal(f('csp_demo', '剧情', [{ url: 'https://pan.quark.cn/s/x' }]), true, '渲染层认 url');
        assert.equal(isPanQueueRequest({ kind: 'catvod', site: 'csp_demo', flag: '剧情', eps: [{ url: 'https://pan.quark.cn/s/x' }] }), false,
            '主进程只认 id → 同数据判定相反（口径漂移）');
        // 正则常量本身必须同源（含中文强特征）
        assert.match(String(PAN_SOURCE_RE.source), /夸克/);
    });

    test('_onPreviewTick：进入提前窗口时 seek 到片尾起点并提示「已自动跳过」', () => {
        const storeBacking = new Map();
        const { player, sink, AdSkip } = loadPlayer({ storeBacking });
        AdSkip.recordOpEd('番剧P', '线路A', 'ed', 1200);
        player._curMeta = { site: 's', title: '番剧P', flag: '线路A' };
        sink.videoEl = { currentTime: 1196, duration: 1400 };   // ed=1200，lead=5 → [1195,1200)
        player._onPreviewTick();
        assert.equal(sink.videoEl.currentTime, 1200, '应 seek 到记录的片尾起点');
        assert.ok(sink.toasts.some((t) => t.includes('已自动跳过')), '应提示已自动跳过');
    });

    test('_onPreviewTick：同一次会话只跳一次（seek 抖动不循环）', () => {
        const storeBacking = new Map();
        const { player, sink, AdSkip } = loadPlayer({ storeBacking });
        AdSkip.recordOpEd('番剧Q', '线路A', 'ed', 1200);
        player._curMeta = { site: 's', title: '番剧Q', flag: '线路A' };
        sink.videoEl = { currentTime: 1196, duration: 1400 };
        player._onPreviewTick();
        const seekCountBefore = sink.toasts.filter((t) => t.includes('已自动跳过')).length;
        // seek 后 currentTime 已越过 ed+lead：再 tick 不应重复跳
        player._onPreviewTick();
        player._onPreviewTick();
        assert.equal(sink.toasts.filter((t) => t.includes('已自动跳过')).length, seekCountBefore,
            '_opEdEdFired 守卫：每集只跳一次');
        assert.equal(player._opEdEdFired, true);
    });

    test('_onPreviewTick：接近但未到提前窗口只提示一次「即将进入片尾」', () => {
        const storeBacking = new Map();
        const { player, sink, AdSkip } = loadPlayer({ storeBacking });
        AdSkip.recordOpEd('番剧R', '线路A', 'ed', 1200);
        player._curMeta = { site: 's', title: '番剧R', flag: '线路A' };
        sink.videoEl = { currentTime: 1180, duration: 1400 };   // [ed-30, ed-5) → toast
        player._onPreviewTick();
        player._onPreviewTick();
        player._onPreviewTick();
        assert.equal(sink.toasts.filter((t) => t === '即将进入片尾').length, 1,
            '_opEdEdToasted 守卫：提示只弹一次');
        assert.equal(sink.videoEl.currentTime, 1180, 'toast 阶段不得 seek');
    });

    test('_onPreviewTick：opEdSkip 开关关闭 / AdSkip 缺失 / 无片尾记录时全部静默', () => {
        const storeBacking = new Map();
        const { player, sink, AdSkip } = loadPlayer({ storeBacking });
        AdSkip.recordOpEd('番剧S', '线路A', 'ed', 1200);
        player._curMeta = { site: 's', title: '番剧S', flag: '线路A' };
        sink.videoEl = { currentTime: 1196, duration: 1400 };
        player._opEdSkipEnabled = false;
        player._onPreviewTick();
        assert.equal(sink.videoEl.currentTime, 1196, '开关关闭不 seek');
        assert.equal(sink.toasts.length, 0);

        // 恢复开关但无片尾记录（只有片头）：不动作
        player._opEdSkipEnabled = true;
        AdSkip.recordOpEd('番剧T', '线路A', 'op', 90);
        player._curMeta = { site: 's', title: '番剧T', flag: '线路A' };
        player._onPreviewTick();
        assert.equal(sink.videoEl.currentTime, 1196);
        assert.equal(sink.toasts.length, 0);
    });

    test('_onExit：起播即失败（endReason=error 且零进度）只自动 refresh 重解析一次', async () => {
        const { player, sink } = loadPlayer();
        const playArgs = [];
        player.play = async (...args) => { playArgs.push(args); return { ok: true }; };
        player._session = 7;
        player._currentPlayback = { site: 's', flag: 'f', id: 'e1', title: 'T',
            subtitle: '第1集', episodes: [], epIndex: 0 };
        await player._onExit({ sessionId: 7, endReason: 'error', pos: 2, duration: 1200 });
        assert.equal(playArgs.length, 1, '起播即失败应触发一次重解析');
        assert.equal(playArgs[0][8].reconnectAttempt, 1, 'runtimeOpts 必须带 reconnectAttempt=1');
        assert.ok(sink.toasts.some((t) => t.includes('播放地址可能已失效')), '应提示地址可能失效');
        assert.equal(player._reconnectAttempts, 1);
    });

    test('_onExit：中段断流（pos≥15 且剩余≥8s）按「被中断」文案刷新重连', async () => {
        const { player, sink } = loadPlayer();
        const playArgs = [];
        player.play = async (...args) => { playArgs.push(args); return { ok: true }; };
        player._session = 7;
        player._currentPlayback = { site: 's', flag: 'f', id: 'e1', title: 'T',
            subtitle: '第1集', episodes: [], epIndex: 0 };
        await player._onExit({ sessionId: 7, pos: 100, duration: 1200 });
        assert.equal(playArgs.length, 1);
        assert.ok(sink.toasts.some((t) => t.includes('播放被中断')), '中段断流走「被中断」文案');
    });

    test('_onExit：已看完 / 用户主动关闭 / 已重连过一次 都不再重连', async () => {
        const mk = () => {
            const loaded = loadPlayer();
            const playArgs = [];
            loaded.player.play = async (...args) => { playArgs.push(args); return { ok: true }; };
            loaded.player._session = 7;
            loaded.player._currentPlayback = { site: 's', flag: 'f', id: 'e1', title: 'T',
                subtitle: '第1集', episodes: [], epIndex: 0 };
            return { ...loaded, playArgs };
        };
        // ① 看完（剩余 <8s）：done=true 直接收口
        const a = mk();
        await a.player._onExit({ sessionId: 7, pos: 1199, duration: 1200 });
        assert.equal(a.playArgs.length, 0, '看完不重连');
        // ② 用户主动关闭（quit）：连播链终止且不重连
        const b = mk();
        await b.player._onExit({ sessionId: 7, quit: true, pos: 100, duration: 1200 });
        assert.equal(b.playArgs.length, 0, '主动关闭不重连');
        assert.equal(b.player._seq, null);
        // ③ 已重连过一次：_reconnectAttempts 上限生效
        const c = mk();
        c.player._reconnectAttempts = 1;
        await c.player._onExit({ sessionId: 7, pos: 100, duration: 1200 });
        assert.equal(c.playArgs.length, 0, '第二次断流不再自动重连（上限 1 次）');
    });

    test('_onEpisodeSkip：无方向 / 无剧集列表 / 越界 三种情形各自给出明确提示且不发起播放', async () => {
        const { player, sink } = loadPlayer();
        const playArgs = [];
        player.play = async (...args) => { playArgs.push(args); };
        // ① dir=0 / dir 非法：静默返回
        await player._onEpisodeSkip({ dir: 0 });
        await player._onEpisodeSkip({});
        await player._onEpisodeSkip();
        assert.equal(playArgs.length, 0);
        assert.equal(sink.toasts.length, 0, 'dir 为 0 时静默返回，不打扰用户');
        // ② 无任何剧集上下文
        await player._onEpisodeSkip({ dir: 1 });
        assert.equal(sink.toasts.length, 1);
        assert.match(sink.toasts[0], /没有可切换的剧集列表/);
        // ③ 越界：末集再下一集 / 首集再上一集
        const eps = [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }, { name: '第3集', url: 'u3' }];
        player._seq = { site: 's', flag: 'f', title: 'T', episodes: eps, index: 2, kazumiSrc: '' };
        await player._onEpisodeSkip({ dir: 1 });
        assert.match(sink.toasts[sink.toasts.length - 1], /已经是最后一集/);
        player._seq.index = 0;
        await player._onEpisodeSkip({ dir: -1 });
        assert.match(sink.toasts[sink.toasts.length - 1], /已经是第一集/);
        assert.equal(playArgs.length, 0, '越界一律不起播');
    });

    test('_onEpisodeSkip：正常切集按 _seq 推进（下一集/上一集），无 _seq 时回退 _currentPlayback', async () => {
        const { player, sink } = loadPlayer();
        const playArgs = [];
        player.play = async (...args) => { playArgs.push(args); };
        const eps = [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }];
        player._seq = { site: 's', flag: 'f', title: 'T', episodes: eps, index: 0, kazumiSrc: '' };
        await player._onEpisodeSkip({ dir: 1 });
        assert.equal(playArgs.length, 1);
        assert.deepEqual(plain(playArgs[0].slice(0, 8)),
            ['s', 'f', 'u2', 'T', '第2集', eps, 1, ''], '应推进到第 2 集');
        assert.ok(sink.toasts.some((t) => t.includes('下一集：第2集')));

        // 无 _seq：从 _currentPlayback 重建上下文（多集才可用）
        playArgs.length = 0;
        player._seq = null;
        player._currentPlayback = { site: 's2', flag: 'f2', title: 'T2', epIndex: 1,
            episodes: eps, kazumiSrc: 'kz' };
        await player._onEpisodeSkip({ dir: -1 });
        assert.equal(playArgs.length, 1);
        assert.equal(playArgs[0][2], 'u1', '上一集回退到 index 0');
        assert.equal(playArgs[0][7], 'kz', 'kazumiSrc 随上下文透传');
        // 单集 _currentPlayback 不构造成可切换上下文
        playArgs.length = 0;
        player._currentPlayback.episodes = [{ name: '第1集', url: 'u1' }];
        await player._onEpisodeSkip({ dir: 1 });
        assert.equal(playArgs.length, 0);
        assert.ok(sink.toasts.some((t) => t.includes('没有可切换的剧集列表')));
    });
});

// ═══════════════════════════════════════════════════════════ ad-skip.js

describe('ad-skip', () => {

    test('_clampSec（经 decideStartSec 观测）：0/负数/超 1 小时/非数 一律判为不可信', () => {
        const { AdSkip } = loadAdSkip();
        assert.equal(AdSkip.decideStartSec(0, null), 0, '0 秒不是有效片头');
        assert.equal(AdSkip.decideStartSec(-3, null), 0);
        assert.equal(AdSkip.decideStartSec(4000, null), 0, '超过 1 小时判为误登记');
        assert.equal(AdSkip.decideStartSec('abc', null), 0);
        assert.equal(AdSkip.decideStartSec(NaN, null), 0);
        assert.equal(AdSkip.decideStartSec(Infinity, null), 0);
        assert.equal(AdSkip.decideStartSec(null, null), 0);
        // 边界：3600 恰好合法，3600.6 四舍五入后越界
        assert.equal(AdSkip.decideStartSec(3600, null), 3600);
        assert.equal(AdSkip.decideStartSec(3600.6, null), 0);
        // 0.4 → round 0 非法；0.6 → round 1 合法
        assert.equal(AdSkip.decideStartSec(0.4, null), 0);
        assert.equal(AdSkip.decideStartSec(0.6, null), 1);
        // 字符串数字与小数四舍五入
        assert.equal(AdSkip.decideStartSec('90', null), 90);
        assert.equal(AdSkip.decideStartSec(89.6, null), 90);
    });

    test('decideStartSec：正片保护带边界（op 与片尾至少隔 30s）与时长形态处理', () => {
        const { AdSkip } = loadAdSkip();
        assert.equal(AdSkip.decideStartSec(1369, 1400), 1369, '距片尾 31s：应用');
        assert.equal(AdSkip.decideStartSec(1370, 1400), 0, '距片尾恰好 30s：宁可从头播');
        assert.equal(AdSkip.decideStartSec(1371, 1400), 0);
        assert.equal(AdSkip.decideStartSec(1399, 1400), 0, 'op≈片长：误登记');
        // 时长为 0 / 负数 / NaN：保护带校验不适用（视为时长未知）
        assert.equal(AdSkip.decideStartSec(90, 0), 90);
        assert.equal(AdSkip.decideStartSec(90, -5), 90);
        assert.equal(AdSkip.decideStartSec(90, NaN), 90);
        assert.equal(AdSkip.decideStartSec(90, undefined), 90);
    });

    test('decideEdAction：窗口边界逐点校验（ed-margin / ed-lead / ed 本身）', () => {
        const { AdSkip } = loadAdSkip();
        // ed=1200, dur=1400：margin=30 → 动作区间 [1170, 1205)；lead=5 → skip 区间 [1195,1205)
        assert.equal(AdSkip.decideEdAction(1169, 1400, 1200), null, '离片尾还远：不动作');
        assert.equal(AdSkip.decideEdAction(1170, 1400, 1200), 'toast', '进入距片尾 30s 内：提示');
        assert.equal(AdSkip.decideEdAction(1194, 1400, 1200), 'toast');
        assert.equal(AdSkip.decideEdAction(1195, 1400, 1200), 'skip', '提前量窗口起点：跳');
        assert.equal(AdSkip.decideEdAction(1199, 1400, 1200), 'skip');
        assert.equal(AdSkip.decideEdAction(1200, 1400, 1200), 'skip', '恰好到片尾点仍跳');
        assert.equal(AdSkip.decideEdAction(1204, 1400, 1200), 'skip');
        assert.equal(AdSkip.decideEdAction(1205, 1400, 1200), null, '已越过 ed+lead：不再动作');
        assert.equal(AdSkip.decideEdAction(1399, 1400, 1200), null);
    });

    test('decideEdAction：ed 位置可信度闸门（离片头≥margin、离片尾≥10s）与短片保护', () => {
        const { AdSkip } = loadAdSkip();
        assert.equal(AdSkip.decideEdAction(20, 1400, 20), null, 'ed < margin(30)：误登记');
        assert.equal(AdSkip.decideEdAction(29, 1400, 29), null);
        assert.equal(AdSkip.decideEdAction(30, 1400, 30), 'skip', 'ed 恰好 = margin 才可用');
        assert.equal(AdSkip.decideEdAction(1391, 1400, 1391), null, 'ed > dur-10（≈片长）：误登记');
        assert.equal(AdSkip.decideEdAction(1386, 1400, 1391), null);
        // ed == dur-10 恰好放行：动作区间 [ed-margin, ed+lead) = [1360, 1395)
        assert.equal(AdSkip.decideEdAction(1380, 1400, 1390), 'toast');
        assert.equal(AdSkip.decideEdAction(1386, 1400, 1390), 'skip');
        // 短片保护：dur < guardSec(300) 不跳片尾
        assert.equal(AdSkip.decideEdAction(180, 200, 150), null);
        assert.equal(AdSkip.decideEdAction(280, 299, 270), null);
        // 恰好 300s：保护带放开（ed 需同时满足离片尾 ≥10s → ed ≤ 290）
        assert.equal(AdSkip.decideEdAction(269, 300, 270), 'skip');
    });

    test('decideEdAction：自定义 leadSec / guardSec / marginSec 生效，非法位置与时长一律 null', () => {
        const { AdSkip } = loadAdSkip();
        // 放大提前量：leadSec=20 → skip 区间 [1180, 1220)
        assert.equal(AdSkip.decideEdAction(1180, 1400, 1200, { leadSec: 20 }), 'skip');
        assert.equal(AdSkip.decideEdAction(1179, 1400, 1200, { leadSec: 20 }), 'toast');
        // 收紧 margin：marginSec=10 → 动作区间 [1190, ed+lead)
        assert.equal(AdSkip.decideEdAction(1191, 1400, 1200, { marginSec: 10 }), 'toast');
        assert.equal(AdSkip.decideEdAction(1189, 1400, 1200, { marginSec: 10 }), null, '区间外不动作');
        // 抬高 guard：guardSec=700 → 1400s 片长仍可用；600s 长片被挡
        assert.equal(AdSkip.decideEdAction(1196, 1400, 1200, { guardSec: 700 }), 'skip');
        assert.equal(AdSkip.decideEdAction(580, 600, 580, { guardSec: 700 }), null);
        // ed 非法值
        assert.equal(AdSkip.decideEdAction(1196, 1400, null), null);
        assert.equal(AdSkip.decideEdAction(1196, 1400, 'abc'), null);
        assert.equal(AdSkip.decideEdAction(1196, 1400, 0), null);
        // pos / dur 非法
        assert.equal(AdSkip.decideEdAction(-1, 1400, 1200), null);
        assert.equal(AdSkip.decideEdAction('abc', 1400, 1200), null);
        assert.equal(AdSkip.decideEdAction(undefined, 1400, 1200), null);
        assert.equal(AdSkip.decideEdAction(1196, 0, 1200), null);
        assert.equal(AdSkip.decideEdAction(1196, 'abc', 1200), null);
        assert.equal(AdSkip.decideEdAction(1196, null, 1200), null);
        // opts=null / 空对象：走默认 lead=5 / guard=300 / margin=30
        assert.equal(AdSkip.decideEdAction(1180, 1400, 1200, null), 'toast', 'opts=null 走默认参数');
        assert.equal(AdSkip.decideEdAction(1180, 1400, 1200, {}), 'toast', 'opts={} 同样走默认');
        assert.equal(AdSkip.decideEdAction(1196, 1400, 1200, { leadSec: 'x' }), 'skip',
            'leadSec 非数字 → 回退默认 5');
    });

    test('存储损坏 / 非 JSON / 结构不合法：一律退化为空库，不抛错影响播放', () => {
        const bad = new Map();
        bad.set('yuki_oped_skip_v1', '{not json');
        const a = loadAdSkip({ storeBacking: bad });
        assert.deepEqual(plain(a.AdSkip._load()), { byKey: {} });
        assert.equal(a.AdSkip.getOpEd('X', 'Y'), null);
        assert.equal(a.AdSkip.findSiblingOpEd('X', 'Y'), null);
        assert.equal(a.AdSkip.resolveAutoOpSec('X', 'Y', null), 0);

        const wrong = new Map();
        wrong.set('yuki_oped_skip_v1', JSON.stringify({ byKey: 'not-an-object' }));
        const b = loadAdSkip({ storeBacking: wrong });
        assert.deepEqual(plain(b.AdSkip._load()), { byKey: {} });

        const arr = new Map();
        arr.set('yuki_oped_skip_v1', '[1,2,3]');
        const c = loadAdSkip({ storeBacking: arr });
        assert.deepEqual(plain(c.AdSkip._load()), { byKey: {} }, '数组 JSON 也不是合法库');
        // 读取路径不污染播放：登记仍可正常写入（覆盖损坏数据）
        assert.ok(c.AdSkip.recordOpEd('番剧C', '线路A', 'op', 60));
        assert.equal(c.AdSkip.getOpEd('番剧C', '线路A').op, 60);
    });

    test('localStorage 不可用（隐私模式）：读写全部静默失败，决策路径仍返回安全值', () => {
        const { AdSkip } = loadAdSkip({ localStorage: null });
        assert.deepEqual(plain(AdSkip._load()), { byKey: {} });
        assert.equal(AdSkip._save({ byKey: {} }), false, '无存储时保存返回 false');
        assert.equal(AdSkip.getOpEd('番剧L', '线路A'), null);
        assert.equal(AdSkip.resolveAutoOpSec('番剧L', '线路A', null), 0, '无存储 → 从头播');
        assert.equal(AdSkip.findSiblingHint('番剧L', '线路A'), null);
        assert.equal(AdSkip.decideEdAction(1196, 1400, 1200), 'skip', '纯决策函数不依赖存储');
        // 登记在无存储下仍返回记录对象（内存语义），不抛错
        const rec = AdSkip.recordOpEd('番剧L', '线路A', 'op', 60);
        assert.ok(rec && rec.op === 60);
        assert.equal(AdSkip.getOpEd('番剧L', '线路A'), null, '未持久化，下次读为空');
    });

    test('两个独立沙箱（不同 localStorage backing）记录互不串台', () => {
        const a = loadAdSkip();
        const b = loadAdSkip();
        a.AdSkip.recordOpEd('番剧A', '线路A', 'op', 60);
        assert.equal(a.AdSkip.getOpEd('番剧A', '线路A').op, 60);
        assert.equal(b.AdSkip.getOpEd('番剧A', '线路A'), null, '沙箱 B 不应看到沙箱 A 的记录');
        // 同一沙箱内 _load(store) 显式传 store 时按传入 store 读取
        const other = new Map([['yuki_oped_skip_v1', JSON.stringify({ byKey: { '番剧B|线路A': { op: 30, ed: null, ts: 1 } } })]]);
        assert.equal(a.AdSkip.getOpEd('番剧B', '线路A', {
            getItem: (k) => (other.has(k) ? other.get(k) : null),
            setItem: () => {}, removeItem: () => {},
        }).op, 30, '显式 store 注入生效');
    });

    test('resolveAutoOpSec：只信任「片名+线路」同键记录，跨线路值绝不自动套用', () => {
        const { AdSkip } = loadAdSkip();
        AdSkip.recordOpEd('番剧Z', '线路1', 'op', 90);
        AdSkip.recordOpEd('番剧Z', '线路2', 'op', 95);
        assert.equal(AdSkip.resolveAutoOpSec('番剧Z', '线路1', null), 90);
        assert.equal(AdSkip.resolveAutoOpSec('番剧Z', '线路2', null), 95);
        assert.equal(AdSkip.resolveAutoOpSec('番剧Z', '线路3', null), 0, '兄弟线路值不自动应用');
        // 时长已知时也只按同键判定
        assert.equal(AdSkip.resolveAutoOpSec('番剧Z', '线路1', 1400), 90);
        // 只有片尾记录的同键条目：不产生片头起播位
        AdSkip.recordOpEd('番剧Y', '线路1', 'ed', 1200);
        assert.equal(AdSkip.resolveAutoOpSec('番剧Y', '线路1', 1400), 0);
        // 完全无记录
        assert.equal(AdSkip.resolveAutoOpSec('番剧W', '线路1', 1400), 0);
    });

    test('findSiblingHint：兄弟线路只有片尾记录时不构成片头提示；片头值非法同样不提示', () => {
        const { AdSkip, backing } = loadAdSkip();
        // 手工塞入脏数据：兄弟线路 op 为 0 / 4000（不可信值）
        backing.set('yuki_oped_skip_v1', JSON.stringify({
            byKey: {
                '番剧D|线路2': { op: 0, ed: 1200, ts: 5 },
                '番剧E|线路2': { op: 4000, ed: null, ts: 5 },
                '番剧F|线路2': { op: null, ed: 1200, ts: 5 },
            },
        }));
        assert.equal(AdSkip.findSiblingHint('番剧D', '线路1'), null, 'op=0 不可信');
        assert.equal(AdSkip.findSiblingHint('番剧E', '线路1'), null, 'op 超 1 小时不可信');
        assert.equal(AdSkip.findSiblingHint('番剧F', '线路1'), null, '只有片尾记录不构成片头提示');
        // findSiblingOpEd 仍返回该记录（提示来源与自动决策两条通道分离）
        assert.ok(AdSkip.findSiblingOpEd('番剧F', '线路1'));
        assert.equal(AdSkip.findSiblingOpEd('番剧F', '线路1').flag, '线路2');
    });

    test('opEdKey：trim 归一化、| 转全角防键段碰撞、空标题拒绝', () => {
        const { AdSkip } = loadAdSkip();
        assert.equal(AdSkip.opEdKey('  番剧  ', ' 线路 '), '番剧|线路');
        assert.equal(AdSkip.opEdKey('A|B', 'C'), 'A／B|C');
        assert.equal(AdSkip.opEdKey('A', 'B|C'), 'A|B／C');
        assert.notEqual(AdSkip.opEdKey('A|B', 'C'), AdSkip.opEdKey('A', 'B|C'));
        assert.equal(AdSkip.opEdKey('', ''), '|');
        // 全空键：recordOpEd / getOpEd 均拒绝
        assert.equal(AdSkip.recordOpEd('', '', 'op', 60), null);
        assert.equal(AdSkip.getOpEd('', ''), null);
        assert.equal(AdSkip.getOpEd(null, undefined), null);
        // 非字符串入参也能安全成键
        assert.equal(AdSkip.opEdKey(123, 456), '123|456');
    });
});

// ═══════════════════════════════════════════════════════════ bgm-rate.js

describe('bgm-rate', () => {

    test('评分提交参数构造：单条透传数组 + token 通道 + 端点路径', async () => {
        const { R, calls, sink } = loadBgmRate();
        sink.vals['#bgm-rate-comment'] = '好看';   // submit 从对话框文本框读吐槽（单一事实来源）
        R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '好看' };
        const ok = await R.submit();
        assert.equal(ok, true);
        assert.equal(calls.doAction.length, 1);
        const [action, body, endpoint] = calls.doAction[0];
        assert.equal(action, 'kazumiBangumiSyncApply');
        assert.equal(endpoint, '/kazumi/action');
        assert.equal(body.token, 'tok');
        const uploads = JSON.parse(body.uploads);
        assert.equal(uploads.length, 1, '必须是单条数组（单条透传语义）');
        assert.deepEqual(uploads[0], { subjectId: '42', type: -1, rate: 8, comment: '好看' });
        assert.equal(calls.favChanged, 1, '成功后广播 FavHub.changed');
    });

    test('评分范围校验：越界钳到边界、非数字置 null、空值不进 payload（脏值绝不落后端）', async () => {
        const mk = () => {
            const loaded = loadBgmRate();
            loaded.R._ctx = { subjectId: '42', name: 'X', rate: null, comment: '' };
            return loaded;
        };
        // 越界上界 12 → 10
        let a = mk();
        a.R._ctx.rate = 12;
        await a.R.submit();
        assert.equal(JSON.parse(a.calls.doAction[0][1].uploads)[0].rate, 10);
        // 越界下界 -5 → 0（0=清除评分，必须出现在 payload）
        let b = mk();
        b.R._ctx.rate = -5;
        await b.R.submit();
        assert.equal(JSON.parse(b.calls.doAction[0][1].uploads)[0].rate, 0);
        // 非数字 'abc' → null：评分键不进 payload
        let c = mk();
        c.R._ctx.rate = 'abc';
        c.sink.vals['#bgm-rate-comment'] = '仅吐槽';
        await c.R.submit();
        const itemC = JSON.parse(c.calls.doAction[0][1].uploads)[0];
        assert.equal('rate' in itemC, false, '非数字评分不得写入 payload');
        assert.equal(itemC.comment, '仅吐槽');
        // 空评分 + 空吐槽 → 不发请求，提示无需提交
        let d = mk();
        d.R._ctx.rate = null;
        d.sink.vals['#bgm-rate-comment'] = '   ';
        const r = await d.R.submit();
        assert.equal(r, false);
        assert.equal(d.calls.doAction.length, 0, '无改动不提交');
        assert.ok(d.sink.toasts.some((t) => t.includes('无需提交')));
        // 小数四舍五入
        let e = mk();
        e.R._ctx.rate = 7.6;
        await e.R.submit();
        assert.equal(JSON.parse(e.calls.doAction[0][1].uploads)[0].rate, 8);
    });

    test('rate=0（清除评分）与吐槽同提交：payload 含 rate:0，文案优先播报「已清除评分」', async () => {
        const { R, calls, sink } = loadBgmRate();
        sink.vals['#bgm-rate-comment'] = '弃了';
        R._ctx = { subjectId: '42', name: 'X', rate: 0, comment: '弃了' };
        const ok = await R.submit();
        assert.equal(ok, true);
        const item = JSON.parse(calls.doAction[0][1].uploads)[0];
        assert.equal(item.rate, 0, '0 分必须显式进入 payload（官方 0=清除评分）');
        assert.equal(item.comment, '弃了');
        assert.ok(sink.toasts.includes('已清除评分'), '0 分文案为「已清除评分」');
        assert.ok(!sink.toasts.some((t) => t.startsWith('已评分：')), '不得误报为「已评分」');
    });

    test('仅吐槽（rate=null）单条透传：payload 不含 rate 键，成功文案为「吐槽已提交」', async () => {
        const { R, calls, sink } = loadBgmRate();
        R._ctx = { subjectId: '42', name: 'X', rate: null, comment: '' };
        sink.vals['#bgm-rate-comment'] = '  期待第二季  ';
        const ok = await R.submit();
        assert.equal(ok, true);
        const item = JSON.parse(calls.doAction[0][1].uploads)[0];
        assert.deepEqual(plain(item), { subjectId: '42', type: -1, comment: '期待第二季' },
            'rate 为 null 时不得写 rate 键；吐槽首尾空白被 trim');
        assert.ok(sink.toasts.includes('吐槽已提交'));
    });

    test('未登录兜底：Kazumi 缺失 / _getBangumiToken 缺失 / 返回空 Token 都不发请求并提示保存 Token', async () => {
        // ① Kazumi 全局不存在
        const a = loadBgmRate({ noKazumi: true });
        a.R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
        assert.equal(await a.R.submit(), false);
        assert.equal(a.calls.doAction.length, 0, '无 Token 通道不得发起请求');
        assert.ok(a.sink.toasts.some((t) => t.includes('保存 Token')));
        // ② Kazumi 存在但无 _getBangumiToken
        const b = loadBgmRate({ Kazumi: {} });
        b.R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
        assert.equal(await b.R.submit(), false);
        assert.equal(b.calls.doAction.length, 0);
        assert.ok(b.sink.toasts.some((t) => t.includes('保存 Token')));
        // ③ Token 为空串
        const c = loadBgmRate({ Kazumi: { _getBangumiToken: async () => '' } });
        c.R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
        assert.equal(await c.R.submit(), false);
        assert.equal(c.calls.doAction.length, 0);
        // 三种形态都复位了按钮与在途标记
        assert.equal(c.R._inFlightId, '', 'finally 必须复位 _inFlightId');
        assert.deepEqual(c.sink.props.filter((p) => p.k === 'disabled').map((p) => p.v), [true, false]);
    });

    test('失败重试：提交失败后 _inFlightId 复位，同一条目可再次提交（不被永久锁死）', async () => {
        let n = 0;
        const { R, calls } = loadBgmRate({
            doActionImpl: async () => {
                n += 1;
                return { code: 400, result: { uploaded: 0, failed: 1,
                    results: [{ subjectId: '42', ok: false, msg: n === 1 ? 'boom' : '' }] } };
            },
        });
        R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
        const first = await R.submit();
        assert.equal(first, false);
        assert.equal(R._inFlightId, '', '失败后必须复位在途标记');
        const second = await R.submit();
        assert.equal(second, false, '第二次仍按后端返回失败');
        assert.equal(calls.doAction.length, 2, '失败不阻断后续重试');
        // submit 无上下文（对话框未打开）时直接 false，不发请求
        const noCtx = loadBgmRate({ doActionImpl: async () => { throw new Error('should not be called'); } });
        assert.equal(await noCtx.R.submit(), false, '无 _ctx 时直接返回 false');
        assert.equal(noCtx.calls.doAction.length, 0, '无 _ctx 不得发起请求');
    });

    test('错误提示通道：非 401 失败把后端 msg 同时写进 status 与 toast', async () => {
        const { R, sink } = loadBgmRate({
            doActionImpl: async () => ({ code: 400, result: { uploaded: 0, failed: 1,
                results: [{ subjectId: '42', ok: false, msg: 'subject not found' }] } }),
        });
        R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
        assert.equal(await R.submit(), false);
        const statusTexts = sink.texts.filter((t) => t.sel === '#bgm-rate-status').map((t) => t.v);
        assert.ok(statusTexts.includes('提交失败：subject not found'), 'status 区显示后端原因');
        assert.ok(sink.toasts.includes('提交失败：subject not found'), 'toast 同步后端原因');
        // 401 单独给可操作指引（与既有测试互补：此处断言 status 文案而非仅 toast）
        const s401 = loadBgmRate({
            doActionImpl: async () => ({ code: 400, result: { uploaded: 0, failed: 1,
                results: [{ subjectId: '42', ok: false, msg: 'POST -> 401' }] } }),
        });
        s401.R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
        await s401.R.submit();
        const t401 = s401.sink.texts.filter((t) => t.sel === '#bgm-rate-status').map((t) => t.v);
        assert.ok(t401.some((v) => v.includes('Token 无效')), '401 走专用 status 文案');
        assert.ok(!t401.some((v) => v.startsWith('提交失败：POST')), '401 不复用通用失败文案');
    });

    test('网络异常（doAction reject）不崩：返回 false、提示网络错误、按钮与在途标记均复位', async () => {
        const { R, sink } = loadBgmRate({
            doActionImpl: async () => { throw new Error('ECONNRESET'); },
        });
        R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
        const r = await R.submit();
        assert.equal(r, false, '异常被吞掉，绝不向上抛');
        assert.ok(sink.toasts.includes('提交失败：网络错误'));
        assert.ok(sink.texts.some((t) => t.sel === '#bgm-rate-status' && t.v === '提交失败：网络错误'));
        assert.equal(R._inFlightId, '', 'finally 复位 _inFlightId');
        assert.deepEqual(sink.props.filter((p) => p.k === 'disabled').map((p) => p.v), [true, false],
            '提交按钮发送前禁用、finally 复位');
        // 无 _ctx 时（对话框未打开）submit 直接 false，不触碰 DOM
        R._ctx = null;
        assert.equal(await R.submit(), false);
    });

    test('XSS 转义：条目名与吐槽只经 .text() 落地，绝不进 .html() 通道', () => {
        const { R, sink } = loadBgmRate();
        const evil = '<img src=x onerror=alert(1)>"><script>bad()</script>';
        R._ctx = { subjectId: '42', name: evil, rate: 8, comment: evil };
        R._renderDialog();
        // 名称走 text（DOM テキスト节点 inherently 安全）
        assert.ok(sink.texts.some((t) => t.sel === '#bgm-rate-name' && t.v === evil),
            '名称必须经 text() 落地');
        // 任何 html 通道都不得携带恶意串
        const htmlBlob = sink.htmls.map((h) => h.v).join('');
        assert.ok(!htmlBlob.includes('onerror'), 'html 通道不得包含事件处理器串');
        assert.ok(!htmlBlob.includes('<script'), 'html 通道不得包含脚本标签');
        assert.ok(!htmlBlob.includes(evil), 'html 通道不得原样输出用户数据');
        // 吐槽经 val() 落地（不是 innerHTML）
        assert.equal(sink.vals['#bgm-rate-comment'], evil);
        // 星级行的 html 只含固定模板
        assert.equal(sink.htmls.filter((h) => h.sel === '#bgm-rate-stars').length, 1);
    });

    test('fetchCurrent：缓存命中直接返回（myRate=0 也算有效评分，不被 || 吃掉）', async () => {
        const { R, calls } = loadBgmRate();
        assert.deepEqual(plain(await R.fetchCurrent('42', { myRate: 8, myComment: '神作' })),
            { rate: 8, comment: '神作' });
        // 关键分支：myRate === 0（清除过的评分）必须命中缓存而非回落到后端
        assert.deepEqual(plain(await R.fetchCurrent('42', { myRate: 0 })), { rate: 0, comment: '' });
        // 越界缓存值被钳制
        assert.deepEqual(plain(await R.fetchCurrent('42', { myRate: 99 })), { rate: 10, comment: '' });
        assert.deepEqual(plain(await R.fetchCurrent('42', { myRate: 'abc' })), { rate: null, comment: '' });
        assert.equal(calls.doAction.length, 0, '缓存命中不得回查后端');
    });

    test('fetchCurrent：无缓存时按 subjectId 查后端，未收藏/异常一律降级为无评分', async () => {
        // 命中收藏
        const a = loadBgmRate({
            doActionImpl: async (action, body) => {
                a.lastArgs = [action, body];
                return { collection: { rate: 7, comment: '还行' } };
            },
        });
        assert.deepEqual(plain(await a.R.fetchCurrent('42', {})), { rate: 7, comment: '还行' });
        assert.equal(a.lastArgs[0], 'kazumiBangumiCollectionGet');
        assert.equal(a.lastArgs[1].id, '42');
        // 未收藏（collection 为空）
        const b = loadBgmRate({ doActionImpl: async () => ({}) });
        assert.deepEqual(plain(await b.R.fetchCurrent('42', {})), { rate: null, comment: '' });
        // 后端抛错
        const c = loadBgmRate({ doActionImpl: async () => { throw new Error('500'); } });
        assert.deepEqual(plain(await c.R.fetchCurrent('42', {})), { rate: null, comment: '' });
    });

    test('fetchCurrent：无 Token / 空 subjectId / Kazumi 缺失 直接返回空，不查后端', async () => {
        const a = loadBgmRate({ Kazumi: { _getBangumiToken: async () => '' },
            doActionImpl: async () => { throw new Error('should not be called'); } });
        assert.deepEqual(plain(await a.R.fetchCurrent('42', {})), { rate: null, comment: '' });
        const b = loadBgmRate({ noKazumi: true,
            doActionImpl: async () => { throw new Error('should not be called'); } });
        assert.deepEqual(plain(await b.R.fetchCurrent('42', {})), { rate: null, comment: '' });
        const c = loadBgmRate({ doActionImpl: async () => { throw new Error('should not be called'); } });
        assert.deepEqual(plain(await c.R.fetchCurrent('', {})), { rate: null, comment: '' });
        assert.deepEqual(plain(await c.R.fetchCurrent('   ', {})), { rate: null, comment: '' });
    });

    test('openRateDialog：缺 subjectId 直接 resolve(false) 并提示；同条目在途时不重复弹窗', async () => {
        const { R, sink, calls } = loadBgmRate();
        const r1 = await R.openRateDialog({});
        assert.equal(r1, false);
        assert.ok(sink.toasts.some((t) => t.includes('缺少 Bangumi 条目 ID')));
        assert.equal(calls.open.length, 0, '未开对话框');
        // 空白 subjectId 同缺参
        assert.equal(await R.openRateDialog({ subjectId: '   ' }), false);
        // 在途：不弹窗、不覆盖上下文
        R._inFlightId = '42';
        R._ctx = { subjectId: '99', name: '旧' };
        const r2 = await R.openRateDialog({ subjectId: '42', name: '新' });
        assert.equal(r2, false);
        assert.ok(sink.toasts.some((t) => t.includes('正在提交中')));
        assert.equal(R._ctx.subjectId, '99', '在途时不得覆盖现有上下文');
        assert.equal(calls.open.length, 0);
    });

    test('星级状态机 _pickRate / _clearRate：选中、同值取消置 0、清除后标签为「未评分」', () => {
        const { R, sink } = loadBgmRate();
        R._ctx = { subjectId: '42', name: 'X', rate: 8, comment: '' };
        // 选中 3 分
        R._pickRate(3);
        assert.equal(R._ctx.rate, 3);
        let stars = sink.htmls.filter((h) => h.sel === '#bgm-rate-stars').pop().v;
        assert.equal((stars.match(/bgm-rate-star active/g) || []).length, 3, '前 3 颗星高亮');
        assert.equal(sink.texts.filter((t) => t.sel === '#bgm-rate-label').pop().v, '3 分 · 差');
        // 再点同值 → 取消（置 0 = 清除评分）
        R._pickRate(3);
        assert.equal(R._ctx.rate, 0, '再点同一分值取消评分');
        assert.equal(sink.texts.filter((t) => t.sel === '#bgm-rate-label').pop().v, '未评分');
        // 选 10 分后清除
        R._pickRate(10);
        assert.equal(R._ctx.rate, 10);
        stars = sink.htmls.filter((h) => h.sel === '#bgm-rate-stars').pop().v;
        assert.equal((stars.match(/bgm-rate-star active/g) || []).length, 10);
        R._clearRate();
        assert.equal(R._ctx.rate, 0);
        stars = sink.htmls.filter((h) => h.sel === '#bgm-rate-stars').pop().v;
        assert.equal((stars.match(/bgm-rate-star active/g) || []).length, 0, '清除后无高亮星');
        // _ctx 为空时两个入口都静默返回（不抛错）
        R._ctx = null;
        R._pickRate(5);
        R._clearRate();
        assert.equal(R._ctx, null);
    });

    test('injectCardActions：Bangumi 卡注入评分按钮（幂等），且不插值任何用户数据', () => {
        const { R, sink } = loadBgmRate();
        sink.dataVals.id = '42';
        sink.findItems['.vod-card[data-site="bangumi"]'] = [{ __n: 1 }, { __n: 2 }];
        R.injectCardActions({ find: (s) => {
            const api = { find: (s2) => ({ length: sink.findLength[s2] === undefined ? 0 : sink.findLength[s2],
                each: (fn) => { (sink.findItems[s2] || []).forEach((it, i) => fn.call(it, i, it)); return api; } }) };
            api.each = (fn) => { (sink.findItems[s] || []).forEach((it, i) => fn.call(it, i, it)); return api; };
            return api;
        } });
        assert.equal(sink.appends.length, 2, '两张 Bangumi 卡各注入一次');
        assert.ok(sink.appends.every((a) => a.v.includes('rec-bgm-rate')));
        assert.ok(sink.appends.every((a) => !a.v.includes('42')), '注入的 HTML 不得插值卡片数据');
        // 幂等：已有徽章（find length=1）则跳过
        sink.appends.length = 0;
        sink.findLength['.rec-bgm-rate'] = 1;
        R.injectCardActions({ find: (s) => {
            const api = { find: (s2) => ({ length: sink.findLength[s2] === undefined ? 0 : sink.findLength[s2],
                each: (fn) => { (sink.findItems[s2] || []).forEach((it, i) => fn.call(it, i, it)); return api; } }) };
            api.each = (fn) => { (sink.findItems[s] || []).forEach((it, i) => fn.call(it, i, it)); return api; };
            return api;
        } });
        assert.equal(sink.appends.length, 0, '已有按钮的卡片不得重复注入');
        // 无 id 的卡片跳过
        sink.appends.length = 0;
        sink.findLength['.rec-bgm-rate'] = 0;
        sink.dataVals.id = '';
        R.injectCardActions({ find: (s) => {
            const api = { find: (s2) => ({ length: sink.findLength[s2] === undefined ? 0 : sink.findLength[s2],
                each: (fn) => { (sink.findItems[s2] || []).forEach((it, i) => fn.call(it, i, it)); return api; } }) };
            api.each = (fn) => { (sink.findItems[s] || []).forEach((it, i) => fn.call(it, i, it)); return api; };
            return api;
        } });
        assert.equal(sink.appends.length, 0, '无 subjectId 的卡片跳过');
        // 非 jQuery 容器（无 find）：静默返回
        R.injectCardActions(null);
        R.injectCardActions({});
        assert.ok(true, '以上两条非 jQuery 容器调用均未抛错（提前 return）');
    });
});
