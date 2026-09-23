/**
 * 渲染层三模块白盒单元测试：my.js（我的页）/ about.js（关于页）/ ui-state.js（UI 状态持久化）。
 *
 * 三个源文件都不是 CommonJS：用 fs.readFileSync + node:vm 在注入全局桩的上下文里加载，
 * 再从上下文句柄上取 My / About / UIState。桩提供：document、window、$（jQuery 链式桩）、
 * console、window.yuki.* IPC 假实现（收藏列表 / 观看记录 / 设置读写由用例注入）。
 * my.js 依赖的收藏网格直接用 records.js 的真实 makeRecordView（配可观测的卡片集合桩），
 * 以便覆盖渲染条数、字段映射、分页钳制、搜索过滤与多选删除的真实分支。
 *
 * 纪律：只读 src/，不修改源文件；发现疑似缺陷仅在注释里标注，不修源码。
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const MY_SRC = read('src/renderer/js/my.js');
const ABOUT_SRC = read('src/renderer/js/about.js');
const UISTATE_SRC = read('src/renderer/js/ui-state.js');
const RECORDS_SRC = read('src/renderer/js/records.js');

/** 与 common.js escHtml 一致（含 &#39;，防单引号属性闭合注入）。 */
function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** localStorage 内存实现；throwSet 可模拟 QuotaExceededError。 */
function makeLocalStorage(opts = {}) {
    const m = new Map();
    return {
        map: m,
        getItem(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
        setItem(k, v) {
            if (opts.throwSet) throw new Error('QuotaExceededError');
            m.set(String(k), String(v));
        },
        removeItem(k) { m.delete(String(k)); },
        get length() { return m.size; },
    };
}

/**
 * jQuery 链式桩：按选择器记录 html()/text()/css()/toggle() 写入，供渲染结果断言；
 * on() 记录事件委托，供点击分支测试直接取 handler 调用。
 */
function makeJqRecorder() {
    const html = new Map();
    const text = new Map();
    const css = new Map();
    const handlers = [];
    const toggled = [];
    const props = new Map();

    function chain(sel) {
        const key = String(sel);
        const o = {
            _sel: key,
            on(...args) {
                handlers.push({
                    sel: key,
                    event: args[0],
                    selector: args.length > 2 ? args[1] : null,
                    fn: args[args.length - 1],
                });
                return o;
            },
            off() { return o; },
            html(s) { if (s !== undefined) html.set(key, String(s)); return o; },
            text(s) { if (s !== undefined) text.set(key, String(s)); return o; },
            css(k, v) { if (v !== undefined) css.set(`${key}|${k}`, String(v)); return o; },
            prop(k, v) { if (v !== undefined) props.set(`${key}|${k}`, v); return o; },
            toggle(v) { toggled.push(v); return o; },
            empty() { html.set(key, ''); return o; },
            data() { return ''; },
            attr() { return ''; },
            val() { return ''; },
            length: 0,
            hasClass() { return false; },
            each() { return o; },
            find() { return o; },
            closest() { return o; },
            addClass() { return o; },
            removeClass() { return o; },
            toggleClass() { return o; },
            append() { return o; },
            scrollTop() { return o; },
            show() { return o; },
            hide() { return o; },
        };
        return o;
    }
    const $ = (sel) => chain(sel === undefined || sel === null ? '' : sel);
    return {
        $,
        html: (sel) => html.get(String(sel)) || '',
        text: (sel) => text.get(String(sel)) || '',
        css: (sel, prop) => css.get(`${String(sel)}|${prop}`) || '',
        prop: (sel, k) => props.get(`${String(sel)}|${k}`),
        toggled,
        handlers,
    };
}

/**
 * 加载 my.js 到隔离 VM。返回 My 句柄与观测器（jQuery 写入记录、IPC 日志、Toast、缓存调用）。
 * opts.settings：settingsGet 返回的假设置；opts.extra 覆盖任意全局桩。
 */
function loadMy(opts = {}) {
    const settings = JSON.parse(JSON.stringify(opts.settings || {}));
    const jq = makeJqRecorder();
    const views = {};
    const calls = { actions: [], set: [], toasts: [] };
    const bgm = { get: 0, set: 0, del: 0, setArgs: [] };
    let persist = opts.persist === undefined ? undefined : opts.persist;

    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout,
        document: {},
        $: jq.$,
        // window.yuki：收藏/观看记录/设置读取由注入的 settings 提供
        window: {
            yuki: {
                settingsGet: async () => JSON.parse(JSON.stringify(settings)),
                settingsSet: opts.settingsSet || (async (k, v) => {
                    calls.set.push({ key: k, value: JSON.parse(JSON.stringify(v)) });
                    settings[k] = JSON.parse(JSON.stringify(v));
                }),
            },
        },
        escHtml,
        warnToast: (m) => calls.toasts.push(String(m)),
        confirmDialog: async () => (opts.confirm !== undefined ? opts.confirm : true),
        doAction: async (...args) => { calls.actions.push(args); return (opts.doAction || (async () => ({ items: [] })))(...args); },
        openDialog: () => {},
        closeDialog: () => {},
        // records.js makeRecordView 桩：记录 init/enter/render 调用，_extra 真实挂载
        makeRecordView: (viewName, storeKey, emptyTip) => {
            const view = {
                viewName, storeKey, emptyTip,
                _inited: false, _extra: null, entered: 0, rendered: 0,
                init() { this._inited = true; },
                async enter() { this.entered++; await this.render(); },
                async render() { this.rendered++; if (this._extra) await this._extra(); },
            };
            views[viewName] = view;
            return view;
        },
        localCacheGet: () => { bgm.get++; return (Array.isArray(persist) ? persist : null); },
        localCacheSet: (k, v, ttl) => { bgm.set++; bgm.setArgs.push({ k, v, ttl }); persist = v; },
        localCacheDel: () => { bgm.del++; persist = undefined; },
        bangumiCover: (images, size) => {
            if (typeof images === 'string') return images || '';
            if (!images || typeof images !== 'object') return '';
            const chains = {
                detail: ['large', 'common', 'medium', 'small', 'grid'],
                card: ['common', 'medium', 'large', 'small', 'grid'],
            };
            for (const k of (chains[size] || chains.card)) if (images[k]) return images[k];
            return '';
        },
    };
    Object.assign(context, opts.extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${MY_SRC}\n;globalThis.__My = My; globalThis.__KEY = MY_BGMCOL_KEY;`,
        context, { filename: 'my.js' });
    return { My: context.__My, key: context.__KEY, jq, calls, settings, bgm, views };
}

/** 加载 ui-state.js（localStorage 由用例注入）。 */
function loadUIState(ls) {
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        setTimeout, clearTimeout,
        localStorage: ls,
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${UISTATE_SRC}\n;globalThis.__UIState = UIState;`, context, { filename: 'ui-state.js' });
    return context.__UIState;
}

/** 加载 about.js；版本 IPC 与 navigator 由 opts 控制。 */
function loadAbout(opts = {}) {
    const jq = makeJqRecorder();
    const calls = { version: 0 };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        parseInt, parseFloat, setTimeout, clearTimeout,
        document: {},
        $: jq.$,
        navigator: opts.navigator === undefined
            ? { userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36' }
            : opts.navigator,
        window: {
            yuki: {
                appVersion: async () => {
                    calls.version++;
                    if (opts.versionFail) throw new Error('ipc down');
                    return opts.version === undefined ? null : opts.version;
                },
            },
        },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${ABOUT_SRC}\n;globalThis.__About = About;`, context, { filename: 'about.js' });
    return { About: context.__About, jq, calls };
}

describe('ui-state', () => {

    // ---- ui-state.js（UI 状态持久化，77 行）

    test('ui-state：set/get 往返一致（对象快照原样存回）', () => {
        const UIState = loadUIState(makeLocalStorage());
        const snap = { tab: 'favorites', page: 3, kw: '碧蓝' };
        assert.equal(UIState.set('my', snap), true, '写入应返回 true');
        assert.deepEqual(UIState.get('my'), snap, '读回的对象应与写入快照等价');
    });

    test('ui-state：未知 key 读取返回 null（不是 undefined，也不抛错）', () => {
        const UIState = loadUIState(makeLocalStorage());
        assert.equal(UIState.get('never-written'), null);
        assert.equal(UIState.get('my'), null, '未存过「我的」状态时应为 null');
    });

    test('ui-state：写入为整体覆盖式快照，旧字段不残留', () => {
        const UIState = loadUIState(makeLocalStorage());
        UIState.set('search', { tab: 'all', kw: 'A', page: 2 });
        UIState.set('search', { tab: 'bangumi' });
        assert.deepEqual(UIState.get('search'), { tab: 'bangumi' }, 'page/kw 不应残留');
    });

    test('ui-state：损坏 JSON 读取返回 null 并惰性删除该键（自愈）', () => {
        const ls = makeLocalStorage();
        ls.setItem('yuki_uistate::my', '{broken json');
        const UIState = loadUIState(ls);
        assert.equal(UIState.get('my'), null, '损坏数据应降级为 null');
        assert.equal(ls.getItem('yuki_uistate::my'), null, '损坏条目应被惰性删除');
    });

    test('ui-state：非对象 JSON（数字/字符串/null）读取一律返回 null', () => {
        const ls = makeLocalStorage();
        ls.setItem('yuki_uistate::home', '42');
        ls.setItem('yuki_uistate::live', '"str"');
        ls.setItem('yuki_uistate::tv', 'null');
        const UIState = loadUIState(ls);
        assert.equal(UIState.get('home'), null);
        assert.equal(UIState.get('live'), null);
        assert.equal(UIState.get('tv'), null);
    });

    test('ui-state：set 拒绝非法入参（空 key / 非对象 value）返回 false 且不动存储', () => {
        const ls = makeLocalStorage();
        const UIState = loadUIState(ls);
        assert.equal(UIState.set('', { a: 1 }), false, '空 key 拒绝');
        assert.equal(UIState.set(null, { a: 1 }), false, 'null key 拒绝');
        assert.equal(UIState.set('my', null), false, 'null value 拒绝');
        assert.equal(UIState.set('my', undefined), false, 'undefined value 拒绝');
        assert.equal(UIState.set('my', 'string'), false, '字符串 value 拒绝');
        assert.equal(UIState.set('my', 7), false, '数字 value 拒绝');
        assert.equal(ls.length, 0, '非法写入不应落盘');
    });

    test('ui-state：get/del 容错遍历全部非法入参（空/null/undefined/数字/NaN）不抛错', () => {
        const UIState = loadUIState(makeLocalStorage());
        UIState.set('my', { tab: 'stats' });
        for (const bad of ['', null, undefined, 0, NaN, {}, []]) {
            assert.doesNotThrow(() => UIState.get(bad), `get(${String(bad)}) 不应抛错`);
            assert.doesNotThrow(() => UIState.del(bad), `del(${String(bad)}) 不应抛错`);
        }
    });

    test('ui-state：del 只删指定页，其他页状态不受影响', () => {
        const UIState = loadUIState(makeLocalStorage());
        UIState.set('my', { tab: 'stats' });
        UIState.set('home', { page: 2 });
        UIState.del('my');
        assert.equal(UIState.get('my'), null, '被删页应读不到');
        assert.deepEqual(UIState.get('home'), { page: 2 }, '其他页状态应完好');
    });

    test('ui-state：状态复位——del 后重读为 null，可重新写入并读回', () => {
        const UIState = loadUIState(makeLocalStorage());
        UIState.set('timeline', { week: 3, favFilter: true });
        UIState.del('timeline');
        assert.equal(UIState.get('timeline'), null, '复位后应为 null');
        UIState.set('timeline', { week: 1 });
        assert.deepEqual(UIState.get('timeline'), { week: 1 }, '复位后应可重新写入');
    });

    test('ui-state：总开关关闭后 get/set 空转，已有数据保留且重开即恢复', () => {
        const UIState = loadUIState(makeLocalStorage());
        UIState.set('my', { tab: 'favorites' });
        UIState.setEnabled(false);
        assert.equal(UIState.isEnabled(), false);
        assert.equal(UIState.get('my'), null, '关闭后读取返回 null（各页回退初始态）');
        assert.equal(UIState.set('my', { tab: 'stats' }), false, '关闭后写入返回 false');
        UIState.setEnabled(true);
        assert.equal(UIState.isEnabled(), true);
        assert.deepEqual(UIState.get('my'), { tab: 'favorites' }, '重开后原状态应原样恢复');
    });

    test('ui-state：总开关关闭时 del 仍可执行（清理动作不受开关限制）', () => {
        const UIState = loadUIState(makeLocalStorage());
        UIState.set('search', { tab: 'all' });
        UIState.setEnabled(false);
        UIState.del('search');
        UIState.setEnabled(true);
        assert.equal(UIState.get('search'), null, 'del 应始终生效');
    });

    test('ui-state：setEnabled 只有 false 关闭，其余真值/假值一律保持开启', () => {
        const UIState = loadUIState(makeLocalStorage());
        assert.equal(UIState.isEnabled(), true, '默认开启');
        UIState.setEnabled(0);
        assert.equal(UIState.isEnabled(), true, '0 非 false，语义上仍开启');
        UIState.setEnabled(null);
        assert.equal(UIState.isEnabled(), true);
        UIState.setEnabled(false);
        assert.equal(UIState.isEnabled(), false);
        UIState.setEnabled(true);
        assert.equal(UIState.isEnabled(), true);
    });

    test('ui-state：命名空间隔离 yuki_uistate::，与 yuki_cache:: 互不干扰', () => {
        const ls = makeLocalStorage();
        ls.setItem('yuki_cache::home', '{"v":1}');
        const UIState = loadUIState(ls);
        UIState.set('home', { page: 5 });
        assert.ok(ls.getItem('yuki_uistate::home'), '状态应写在 ui-state 命名空间下');
        assert.equal(ls.getItem('yuki_cache::home'), '{"v":1}', '缓存命名空间不应被改动');
        UIState.del('home');
        assert.equal(ls.getItem('yuki_cache::home'), '{"v":1}', '删除 UI 状态不得误删缓存');
    });

    test('ui-state：localStorage 缺失 / setItem 抛错时静默降级，不抛异常', () => {
        const UIState = loadUIState(makeLocalStorage({ throwSet: true }));
        assert.equal(UIState.set('my', { tab: 'a' }), false, '写入失败应返回 false');
        assert.doesNotThrow(() => UIState.get('my'), '读取失败不得抛错');
        const noLs = loadUIState(null);
        assert.equal(noLs.set('my', { a: 1 }), false, '无 localStorage 时写入返回 false');
        assert.equal(noLs.get('my'), null, '无 localStorage 时读取返回 null');
        assert.doesNotThrow(() => noLs.del('my'), '无 localStorage 时删除不得抛错');
    });

    test('ui-state：全局 UIState 与 YUKI.uiState 暴露同一套五个 API', () => {
        const context = {
            console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
            setTimeout, clearTimeout, localStorage: makeLocalStorage(),
        };
        context.window = context;
        context.globalThis = context;
        vm.createContext(context);
        vm.runInContext(UISTATE_SRC, context, { filename: 'ui-state.js' });
        for (const n of ['get', 'set', 'del', 'isEnabled', 'setEnabled']) {
            assert.equal(typeof context.UIState[n], 'function', `UIState.${n} 应为函数`);
            assert.equal(typeof context.YUKI.uiState[n], 'function', `YUKI.uiState.${n} 应为函数`);
        }
        assert.equal(context.UIState.get, context.YUKI.uiState.get, '两者应共享同一实现');
    });


});

describe('about', () => {

    // ---- about.js（关于页，37 行）

    test('about：版本号经 yuki:app-version 读取后写进 #about-version', async () => {
        const { About, jq, calls } = loadAbout({ version: '0.2.5' });
        await About.enter();
        assert.equal(calls.version, 1, 'enter 应触发一次版本 IPC');
        assert.equal(jq.text('#about-version'), '0.2.5', '应渲染后端返回的真实版本号');
    });

    test('about：_inited 守卫——重复 enter 不重复初始化，但每次都重拉版本', async () => {
        const { About, calls } = loadAbout({ version: '1.0.0' });
        assert.equal(About._inited, false, '初始未初始化');
        await About.enter();
        assert.equal(About._inited, true);
        assert.equal(About._inited, true);
        await About.enter();
        await About.enter();
        assert.equal(calls.version, 3, '每次 enter 都应重新拉取最新版本号');
    });

    test('about：版本号缺失（IPC 返回 null）时用 UA 里的 Chrome 主版本兜底占位', async () => {
        const { About, jq } = loadAbout({ version: null, navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36' } });
        await About.enter();
        assert.equal(jq.text('#about-version'), '0.2.x-Chrome.140', '应拼出含 Chrome 主版本的占位串');
    });

    test('about：IPC 抛异常走同一兜底路径，不向上冒泡中断渲染', async () => {
        const { About, jq } = loadAbout({ versionFail: true, navigator: { userAgent: 'Chrome/120' } });
        await assert.doesNotReject(About.enter(), 'IPC 失败不应 reject');
        assert.equal(jq.text('#about-version'), '0.2.x-Chrome.120', '异常应落到 UA 兜底');
    });

    test('about：UA 里没有 Chrome 字样时占位串用问号（不硬编码版本号）', async () => {
        const { About, jq } = loadAbout({ version: null, navigator: { userAgent: 'YuKiElectron/1.0' } });
        await About.enter();
        assert.equal(jq.text('#about-version'), '0.2.x-Chrome.?', '无 Chrome 时用 ? 占位');
    });

    test('about：navigator 完全缺失（沙箱）也不崩，仍产出占位版本串', async () => {
        const { About, jq } = loadAbout({ version: null, navigator: undefined });
        await assert.doesNotReject(About.enter(), 'navigator 缺失不得抛错');
        assert.match(jq.text('#about-version'), /^0\.2\.x-Chrome\./, '应仍产出兜底串');
    });

    test('about：UA 为空字符串不崩，占位串退回问号', async () => {
        const { About, jq } = loadAbout({ version: null, navigator: { userAgent: '' } });
        await About.enter();
        assert.equal(jq.text('#about-version'), '0.2.x-Chrome.?');
    });

    test('about：版本号用 .text() 写入而非 .html()（远端字段不可注入 DOM）', async () => {
        const payload = '<img src=x onerror="alert(1)">0.9.9';
        const { About, jq } = loadAbout({ version: payload });
        await About.enter();
        assert.equal(jq.text('#about-version'), payload, '原文经 text() 写入（DOM 侧按纯文本处理）');
        assert.equal(jq.html('#about-version'), '', '不应走 html() 通道');
    });

    test('about：Chrome 主版本只取 UA 首个匹配且仅数字（防 UA 污染版本号）', async () => {
        const { About, jq } = loadAbout({ version: null, navigator: { userAgent: 'Mozilla Chrome/14 Chrome/999 Safari' } });
        await About.enter();
        assert.equal(jq.text('#about-version'), '0.2.x-Chrome.14', '应取第一个 Chrome 版本号');
    });


});

describe('my', () => {

    // ---- my.js（我的页，480 行）
    // —— 纯函数层（时长/片名归一化）

    test('my：_fmtDur 秒数格式化为「X 小时 Y 分」/「Y 分钟」/「Y 秒」', () => {
        const { My } = loadMy();
        assert.equal(My._fmtDur(0), '0 秒');
        assert.equal(My._fmtDur(20), '20 秒');
        assert.equal(My._fmtDur(45), '45 秒', 'my.js 先取整再拆时分秒，45s 仍归为秒（与 records.js 不同）');
        assert.equal(My._fmtDur(60), '1 分钟');
        assert.equal(My._fmtDur(600), '10 分钟');
        assert.equal(My._fmtDur(3600), '1 小时 0 分');
        assert.equal(My._fmtDur(7325), '2 小时 2 分');
    });

    test('my：_fmtDur 非法入参（负/null/NaN）不崩且钳到非负', () => {
        const { My } = loadMy();
        assert.equal(My._fmtDur(-100), '0 秒', '负数钳到 0');
        assert.equal(My._fmtDur(null), '0 秒');
        assert.equal(My._fmtDur(undefined), '0 秒');
        assert.equal(My._fmtDur(NaN), '0 秒');
        // 疑似缺陷（my.js:433）：非数值字符串不被 `sec || 0` 兜住（'abc' 为真值），
        // Math.round('abc') = NaN 后原样输出「NaN 秒」；此处白盒记录实际行为，便于修复后改写断言。
        assert.equal(My._fmtDur('abc'), 'NaN 秒', '非数值字符串会输出「NaN 秒」（见报告：疑似缺陷）');
    });

    test('my：_fmtDurCompact 紧凑时长（图表气泡）——整小时不带分', () => {
        const { My } = loadMy();
        assert.equal(My._fmtDurCompact(3600), '1小时');
        assert.equal(My._fmtDurCompact(3720), '1时2分');
        assert.equal(My._fmtDurCompact(120), '2分钟');
        assert.equal(My._fmtDurCompact(30), '30秒');
        assert.equal(My._fmtDurCompact(-5), '0秒');
    });

    test('my：_normTitle 归一化去空白与分隔符并转小写（用于合并近似重复片名）', () => {
        const { My } = loadMy();
        assert.equal(My._normTitle('碧蓝之海 第三季'), '碧蓝之海第三季');
        assert.equal(My._normTitle('碧蓝之海第三季'), '碧蓝之海第三季');
        assert.equal(My._normTitle('Grand Blue'), 'grandblue');
        assert.equal(My._normTitle(''), '');
        assert.equal(My._normTitle(null), '');
        assert.equal(My._normTitle(undefined), '');
    });

    // —— 观看统计渲染

    const statsFixture = {
        watchStats: {
            totalSeconds: 7325,            // 2 小时 2 分
            sessionCount: 12,
            titles: { '碧蓝之海 第三季': 5, '碧蓝之海第三季': 3, '葬送的芙莉莲': 9, '': 4 },
            daily: { '2026-09-21': 3600, '2026-09-20': 1800, 'bad-key': 60 },
            bySite: { '源甲': 4000, '源乙': 3325 },
        },
    };

    test('my：_renderStats 顶部四项磁贴（时长/次数/部数/近 30 天）按字段渲染', () => {
        const { My, jq } = loadMy({ settings: statsFixture });
        My._renderStats(statsFixture.watchStats, []);
        assert.equal(jq.text('#my-stat-hours'), '2 小时 2 分', '累计时长取 totalSeconds');
        assert.equal(jq.text('#my-stat-sessions'), '12', '观看次数取 sessionCount');
        assert.equal(jq.text('#my-stat-titles'), '4', '观看部数 = titles 键数');
        assert.equal(jq.text('#my-stat-week'), '1 小时 31 分', '近 30 天 = daily 之和（含非法日期键的 60s）');
    });

    test('my：_renderStats 空/null 统计不崩，磁贴全部归零', () => {
        const { My, jq } = loadMy();
        assert.doesNotThrow(() => My._renderStats(null, []));
        assert.equal(jq.text('#my-stat-hours'), '0 秒');
        assert.equal(jq.text('#my-stat-sessions'), '0');
        assert.equal(jq.text('#my-stat-titles'), '0');
        assert.equal(jq.text('#my-stat-week'), '0 秒');
        My._renderStats({}, null);
        assert.equal(jq.text('#my-stat-hours'), '0 秒', 'history 传 null 也不崩');
    });

    test('my：_renderStats 近 7 天条形图固定 7 根柱，最后一根标记为今天', () => {
        const { My, jq } = loadMy({ settings: statsFixture });
        My._renderStats(statsFixture.watchStats, []);
        const html = jq.html('#my-stats-daily');
        assert.equal((html.match(/class="my-bar-col/g) || []).length, 7, '应固定 7 根柱（含今天）');
        assert.equal((html.match(/my-bar-col is-today/g) || []).length, 1, '仅最后一根为 is-today');
        assert.match(html, /height:2%/, '零值柱应保留 2% 短柱占位');
    });

    test('my：_renderWeekday 按星期聚合 daily，非法日期键被跳过且不产出 NaN', () => {
        const { My, jq } = loadMy();
        // 2026-09-21 = 周一(idx 0)，2026-09-24 = 周四(idx 3)；'bad' 段数不足、'abcd-ef-gh' 解析为 NaN
        My._renderWeekday({ '2026-09-21': 3600, '2026-09-24': 60, 'bad': 999, 'abcd-ef-gh': 999 });
        const html = jq.html('#my-stats-weekday');
        assert.equal((html.match(/class="my-bar-col"/g) || []).length, 7, '固定 7 根星期柱');
        assert.match(html, /周一 1 小时 0 分/, '周一累计 3600s');
        assert.match(html, /周四 1 分钟/, '周四累计 60s');
        assert.doesNotMatch(html, /NaN/, '非法日期键不得产出 NaN');
        assert.doesNotMatch(html, /16 分钟|999/, '非法日期键的 999s 不得计入任何桶');
        assert.match(html, /height:2%/, '零值星期柱保留 2% 短柱占位');
    });

    test('my：_renderSource 优先用 bySite，标题标注「累计」口径', () => {
        const { My, jq } = loadMy();
        My._renderSource(statsFixture.watchStats, [{ kind: 'play', lastDuration: 9999, siteName: '干扰源' }]);
        assert.equal(jq.text('#my-stats-source-tip'), '分来源统计（累计·时长）');
        const rows = jq.html('#my-stats-source');
        assert.match(rows, /源甲/, 'bySite 的键应出现');
        assert.match(rows, /1 小时 6 分/, '4000s → 1 小时 6 分');
        assert.doesNotMatch(rows, /干扰源/, '有 bySite 时不回退 history');
    });

    test('my：_renderSource 无 bySite 时回退 history 最近播放并明示口径', () => {
        const { My, jq } = loadMy();
        const history = [
            { kind: 'play', lastDuration: 600, siteName: '源丙' },
            { kind: 'play', lastDuration: 300, siteName: '源丙' },   // 同源累加 → 900s
            { kind: 'play', lastDuration: 0, siteName: '零时长源' },   // sec<=0 跳过
            { kind: 'open', lastDuration: 5000, siteName: '非播放源' }, // 非播放跳过
            null,                                                      // null 条目不崩
            { kind: 'play', lastDuration: 120 },                       // 无来源 → 未知来源
        ];
        My._renderSource(null, history);
        assert.equal(jq.text('#my-stats-source-tip'), '分来源统计（最近 200 次播放·时长）');
        const rows = jq.html('#my-stats-source');
        const labels = [...rows.matchAll(/class="my-rank-name"[^>]*>([^<]*)</g)].map((m) => m[1]);
        const vals = [...rows.matchAll(/class="my-rank-val">([^<]*)</g)].map((m) => m[1]);
        assert.equal(labels[0], '源丙', '按累计时长降序，源丙居首');
        assert.equal(vals[0], '15 分钟', '同源累加 600+300=900s → 15 分钟');
        assert.ok(labels.includes('未知来源'), '缺 siteName/site 归为未知来源');
        assert.equal(vals[labels.indexOf('未知来源')], '2 分钟', '未知来源 120s = 2 分钟');
        assert.ok(!labels.includes('零时长源'), 'lastDuration<=0 的记录应跳过');
        assert.ok(!labels.includes('非播放源'), '非 play 记录应跳过');
    });

    test('my：_renderSource 空来源数据渲染「暂无数据」空态而非空白', () => {
        const { My, jq } = loadMy();
        My._renderSource(null, []);
        assert.match(jq.html('#my-stats-source'), /my-stats-empty/);
        assert.match(jq.html('#my-stats-source'), /暂无数据/);
    });

    test('my：_renderTop 最常观看按归一化合并近似重复片名后再按次数降序', () => {
        const { My, jq } = loadMy();
        // 「碧蓝之海 第三季」(5) + 「碧蓝之海第三季」(3) 合并为 8；芙莉莲 9 居首；空标题条目被丢弃
        My._renderTop(statsFixture.watchStats);
        const html = jq.html('#my-stats-top');
        const names = [...html.matchAll(/class="my-rank-name"[^>]*>([^<]*)</g)].map((m) => m[1]);
        assert.equal(names[0], '葬送的芙莉莲', '次数最多的排第一（9 次）');
        assert.ok(names.includes('碧蓝之海 第三季'), '显示名取更长的变体');
        assert.ok(!names.includes('碧蓝之海第三季'), '近似重复键应被合并，只剩一条');
        assert.match(html, /8 次/, '合并后为 5+3=8 次');
        assert.doesNotMatch(html, /4 次/, '空标题条目应被丢弃');
    });

    test('my：_renderTop 超过 10 条只取前 10 并带名次徽章，无 stats 走空态', () => {
        const { My, jq } = loadMy();
        const titles = {};
        for (let i = 0; i < 25; i++) titles[`片 ${i}`] = i + 1;
        My._renderTop({ titles });
        assert.equal((jq.html('#my-stats-top').match(/my-rank-row/g) || []).length, 10, '榜单应截断到前 10');
        assert.match(jq.html('#my-stats-top'), /my-rank-idx">1</, '行首带名次徽章');
        My._renderTop(null);
        assert.match(jq.html('#my-stats-top'), /暂无数据/, '无 stats 走空态');
    });

    test('my：片名与来源名经 escHtml 转义，注入串不产出可执行标签', () => {
        const { My, jq } = loadMy();
        My._renderTop({ titles: { '<img src=x onerror=alert(1)>': 3 } });
        My._renderSource(null, [{ kind: 'play', lastDuration: 60, siteName: '<script>bad()</script>' }]);
        const top = jq.html('#my-stats-top');
        const src = jq.html('#my-stats-source');
        assert.doesNotMatch(top, /<img src=x onerror/, '最常观看片名应转义');
        assert.match(top, /&lt;img src=x onerror=alert\(1\)&gt;/, '转义实体应可见');
        assert.doesNotMatch(src, /<script>bad/, '来源名应转义');
    });

    // —— 页签与视图切换

    test('my：selectTab 合法页签切换写盘 UIState 并开关对应面板', () => {
        const saved = [];
        const { My, jq } = loadMy({ extra: { UIState: { get: () => null, set: (k, v) => saved.push([k, JSON.parse(JSON.stringify(v))]) } } });
        My.selectTab('favorites', false);
        assert.equal(My._tab, 'favorites');
        assert.deepEqual(saved, [['my', { tab: 'favorites' }]], '应把活动页签存档');
        assert.deepEqual(jq.toggled, [false, true], 'stats 面板关、favorites 面板开');
    });

    test('my：selectTab 非法页签/空值/数字一律钳回 stats（不崩不越界）', () => {
        const { My } = loadMy();
        for (const bad of ['nope', '', null, undefined, 0, 42, ['favorites']]) {
            My.selectTab(bad, false);
            assert.equal(My._tab, 'stats', `selectTab(${String(bad)}) 应回落到 stats`);
        }
    });

    test('my：selectTab 在 UIState 未加载时静默降级（切换本身照常完成）', () => {
        const { My } = loadMy();
        assert.doesNotThrow(() => My.selectTab('favorites', false), 'UIState 缺失不得抛错');
        assert.equal(My._tab, 'favorites', '缺 UIState 也照样切换');
    });

    test('my：_viewState 无 UIState / UIState.get 抛错均返回 null 不崩', () => {
        const { My } = loadMy();
        assert.equal(My._viewState(), null, 'UIState 未定义应返回 null');
        const h = loadMy({ extra: { UIState: { get: () => { throw new Error('boom'); } } } });
        assert.equal(h.My._viewState(), null, 'get 抛错应被吞掉并返回 null');
    });

    test('my：enter 无显式页签时恢复持久化的活动页签（切页/重启不回初始态）', async () => {
        const { My } = loadMy({ extra: { UIState: { get: () => ({ tab: 'favorites' }), set: () => {} } } });
        await My.enter();
        assert.equal(My._tab, 'favorites', '应从存档恢复到 favorites 而非初始 stats');
    });

    test('my：enter 显式页签优先于存档页签（App.showView 路由友好）', async () => {
        const { My } = loadMy({ extra: { UIState: { get: () => ({ tab: 'favorites' }), set: () => {} } } });
        await My.enter('stats');
        assert.equal(My._tab, 'stats', '显式入参应覆盖存档');
    });

    test('my：render 走 favorites 页签时进入收藏视图而非渲染统计', async () => {
        const { My, views } = loadMy({ settings: statsFixture });
        My.init();
        My.selectTab('favorites', false);
        await My.render();
        assert.equal(views['my-favorites'].entered, 1, '收藏页签应 enter 收藏视图');
    });

    test('my：render 走 stats 页签时渲染统计并触发收藏分类计数', async () => {
        const { My, jq } = loadMy({ settings: statsFixture });
        My.init();
        My.selectTab('stats', false);
        await My.render();
        assert.equal(jq.text('#my-stat-hours'), '2 小时 2 分', '应渲染统计磁贴');
        assert.match(jq.html('#my-stats-collections'), /my-stats-coll-total/, '应渲染收藏分类合计块');
    });

    test('my：render 兼容畸形设置（watchStats 为 null / history 非数组 / favorites 为 null）', async () => {
        const h = loadMy({ settings: { watchStats: null, history: 'not-array', favorites: null } });
        h.My.init();
        await assert.doesNotReject(h.My.render(), '非法 history/favorites 不得 reject');
        assert.equal(h.jq.text('#my-stat-hours'), '0 秒', '缺失统计应显示 0');
    });

    // —— 收藏分类计数（_renderCollections）

    test('my：_renderCollections 本地收藏按 tag 计数，五个分类槽位齐全', async () => {
        const favs = [
            { uid: 'u1', site: 'a', vodId: '1', tag: 'watching' },
            { uid: 'u2', site: 'a', vodId: '2', tag: 'want' },
            { uid: 'u3', site: 'a', vodId: '3', tag: 'seen' },
            { uid: 'u4', site: 'a', vodId: '4', tag: 'dropped' },
            { uid: 'u5', site: 'a', vodId: '5', tag: 'hold' },
        ];
        const { My, jq } = loadMy({ settings: { favorites: favs } });
        await My._renderCollections(favs);
        const html = jq.html('#my-stats-collections');
        assert.match(html, /合计 <strong>5<\/strong> 部/);
        for (const label of ['在看', '想看', '看过', '抛弃', '搁置']) {
            assert.match(html, new RegExp(`>${label}<`), `应渲染「${label}」分类槽位`);
        }
    });

    test('my：_renderCollections 缺 tag 的旧数据视同想看，未知 tag 被跳过', async () => {
        const favs = [
            { uid: 'u1', vodId: '1' },                 // 无 tag
            { uid: 'u2', vodId: '2', tag: null },      // tag 为 null
            { uid: 'u3', vodId: '3', tag: 'unknown' }, // 未知标签
        ];
        const { My, jq } = loadMy();
        await My._renderCollections(favs);
        const html = jq.html('#my-stats-collections');
        assert.match(html, /合计 <strong>2<\/strong> 部/, '无 tag 与 null tag 视同 want，unknown 跳过');
        assert.match(html, /my-stats-coll-num">2</, 'want 计数为 2');
    });

    test('my：_renderCollections 同一 bangumiId 的本地与远端条目按 ID 去重防双计', async () => {
        const localFavs = [
            { uid: 'l1', site: 'bangumi', vodId: '999', bangumiId: '999', tag: 'watching' },
            { uid: 'l2', site: 'bangumi', vodId: '888', bangumiId: '888', tag: 'want' },
            { uid: 'l3', site: 'cspby', vodId: 'v1', tag: 'seen' },
        ];
        const { My, jq } = loadMy();
        My._bgmCache = [
            { vodId: '999', tag: 'watching' },   // 与本地 l1 同 ID → 去重
            { vodId: '777', tag: 'want' },       // 仅远端
        ];
        await My._renderCollections(localFavs);
        assert.match(jq.html('#my-stats-collections'), /合计 <strong>4<\/strong> 部/, '本地 3 + 远端去重后 1 = 4');
    });

    test('my：_renderCollections 合并远端 Bangumi 收藏，type→tag 映射与未知 tag 跳过', async () => {
        const { My, jq } = loadMy();
        My._bgmCache = [
            { vodId: 'A', tag: 'want' },
            { vodId: 'B', tag: 'seen' },
            { vodId: 'C', tag: 'watching' },
            { vodId: 'D', tag: 'hold' },
            { vodId: 'E', tag: 'dropped' },
            { vodId: 'F', tag: 'nope' },   // 未知 → 跳过
            { vodId: 'G', tag: 1 },        // 遗留数值 type：1 → want
        ];
        await My._renderCollections([]);
        const html = jq.html('#my-stats-collections');
        assert.match(html, /合计 <strong>6<\/strong> 部/, '未知 tag 不计入，数值 type 需映射');
        for (const label of ['在看', '想看', '看过', '抛弃', '搁置']) {
            assert.match(html, new RegExp(`>${label}<`), `应渲染「${label}」`);
        }
    });

    test('my：_renderCollections 畸形入参（null 条目/整表为 null/非数组）不崩', async () => {
        const { My, jq } = loadMy();
        const favs = [null, undefined, { uid: 'x' }, { uid: 'y', vodId: 'z', tag: 'want' }];
        await assert.doesNotReject(My._renderCollections(favs), '脏条目不得 reject');
        assert.match(jq.html('#my-stats-collections'), /合计 <strong>2<\/strong> 部/, 'null/undefined 条目被跳过');
        await assert.doesNotReject(My._renderCollections(null), '整表为 null 不崩');
        await assert.doesNotReject(My._renderCollections('string'), '非数组入参（forEach 抛错）应被内部 catch 吞掉');
    });

    // —— 清空统计：确认回调的两种结果 + 写盘失败兜底

    test('my：清空统计——确认后写回全零 watchStats 并重渲空统计页', async () => {
        const h = loadMy({ settings: statsFixture, confirm: true });
        h.My.init();
        const handler = h.jq.handlers.find((x) => x.sel === '#my-stats-clear');
        assert.ok(handler, '应绑定 #my-stats-clear 点击');
        await handler.fn();
        const written = h.calls.set[h.calls.set.length - 1];
        assert.equal(written.key, 'watchStats');
        assert.deepEqual(written.value, { totalSeconds: 0, sessionCount: 0, titles: {}, daily: {}, bySite: {} });
        assert.equal(h.jq.text('#my-stat-hours'), '0 秒', '清空后应立即重渲为空');
        assert.ok(h.calls.toasts.some((t) => t.includes('已清空播放统计')), '应提示已清空');
    });

    test('my：清空统计——取消确认时不写盘、不重渲、不提示成功', async () => {
        const h = loadMy({ settings: statsFixture, confirm: false });
        h.My.init();
        const handler = h.jq.handlers.find((x) => x.sel === '#my-stats-clear');
        await handler.fn();
        assert.equal(h.calls.set.length, 0, '取消后不得写盘');
        assert.ok(!h.calls.toasts.some((t) => t.includes('已清空播放统计')), '不应弹出成功提示');
    });

    test('my：清空统计写盘失败时提示「清空失败」而不向上抛出', async () => {
        const h = loadMy({
            settings: statsFixture,
            confirm: true,
            settingsSet: async () => { throw new Error('disk full'); },
        });
        h.My.init();
        const handler = h.jq.handlers.find((x) => x.sel === '#my-stats-clear');
        await assert.doesNotReject(handler.fn(), '写盘失败不得冒泡');
        assert.ok(h.calls.toasts.includes('清空失败'), '应提示清空失败');
    });

    // —— Bangumi 收藏拉取与缓存

    test('my：_getBangumiItems 无 Token 时返回空数组且不写持久缓存（防空列表永久落盘）', async () => {
        const h = loadMy();
        const out = await h.My._getBangumiItems(true);
        assert.ok(Array.isArray(out), '应返回数组');
        assert.equal(out.length, 0, '无 Token 应返回空数组');
        assert.equal(h.bgm.set, 0, '无 Token 不得写持久缓存');
    });

    test('my：_getBangumiItems 命中持久缓存时不发网络请求', async () => {
        const h = loadMy({ persist: [{ vodId: '1', name: '缓存番' }] });
        const out = await h.My._getBangumiItems();
        assert.equal(out.length, 1);
        assert.equal(h.calls.actions.length, 0, '命中缓存不应触发 doAction');
        assert.equal(h.bgm.get, 1);
    });

    test('my：_getBangumiItems force 绕过持久缓存重拉，字段映射与回写均正确', async () => {
        const items = [{ subject_id: 9, subject: { name_cn: '番九', images: { common: 'https://x/9.jpg' } }, type: 3, rate: 8, comment: '神作' }];
        const h = loadMy({ doAction: async () => ({ items }), extra: { Kazumi: { _getBangumiToken: async () => 'tok' } } });
        const out = await h.My._getBangumiItems(true);
        assert.equal(h.calls.actions.length, 1, 'force 应强制发一次请求');
        assert.equal(h.calls.actions[0][0], 'kazumiBangumiCollections', '应走 Bangumi 收藏接口');
        assert.equal(out.length, 1);
        assert.equal(out[0].vodId, '9', 'subject_id 映射为 vodId');
        assert.equal(out[0].name, '番九', '优先取 name_cn');
        assert.equal(out[0].tag, 'watching', 'type 3 → watching');
        assert.equal(out[0].site, 'bangumi', '来源标记为 bangumi');
        assert.equal(out[0].pic, 'https://x/9.jpg', '封面取 subject.images');
        assert.equal(out[0].myRate, 8, 'rate 透传');
        assert.equal(out[0].myComment, '神作', 'comment 透传');
        assert.equal(h.bgm.set, 1, 'force 拉到应回写持久缓存');
        assert.ok(Array.isArray(h.My._bgmCache), '应回填内存缓存');
    });

    test('my：_getBangumiItems 连续 force 复用同一在途请求（只发一次网络）', async () => {
        let n = 0;
        const h = loadMy({
            doAction: async () => { n++; await new Promise((r) => setTimeout(r, 10)); return { items: [{ subject_id: 1, subject: { name_cn: '番' }, type: 1 }] }; },
            extra: { Kazumi: { _getBangumiToken: async () => 'tok' } },
        });
        const [a, b, c] = await Promise.all([
            h.My._getBangumiItems(true),
            h.My._getBangumiItems(true),
            h.My._getBangumiItems(true),
        ]);
        assert.equal(n, 1, '连续 force 应合并为一次请求');
        assert.equal(a, b);
        assert.equal(b, c, '三次调用应拿到同一结果引用');
    });

    test('my：_getBangumiItems 网络失败时回退持久缓存而非空白', async () => {
        const h = loadMy({ persist: [{ vodId: 'cached', name: '缓存番' }], doAction: async () => { throw new Error('net down'); }, extra: { Kazumi: { _getBangumiToken: async () => 'tok' } } });
        const out = await h.My._getBangumiItems(true);
        assert.equal(out.length, 1, '失败应回退到持久缓存');
        assert.equal(out[0].vodId, 'cached');
    });

    test('my：_getBangumiItems 网络失败且无缓存时返回空数组不抛错', async () => {
        const h = loadMy({ doAction: async () => { throw new Error('net down'); }, extra: { Kazumi: { _getBangumiToken: async () => 'tok' } } });
        const out = await h.My._getBangumiItems(true);
        assert.ok(Array.isArray(out), '应返回数组');
        assert.equal(out.length, 0, '无缓存可用应返回空数组');
    });

    test('my：Bangumi 条目缺 subject/name 时用 subject N 占位，输出不含 undefined', async () => {
        const h = loadMy({
            doAction: async () => ({ items: [{ subject_id: 55, type: 2 }, { type: 1, name: '裸名' }] }),
            extra: { Kazumi: { _getBangumiToken: async () => 'tok' } },
        });
        const out = await h.My._getBangumiItems(true);
        assert.equal(out[0].name, 'subject 55', '缺 name 时用 subject_id 占位');
        assert.equal(out[0].tag, 'seen', 'type 2 → seen');
        assert.equal(out[1].vodId, '', '缺 subject_id 时 vodId 为空串（由 mergeExtraRecords 过滤）');
        assert.ok(!JSON.stringify(out).includes('undefined'), '输出串不得含 undefined');
    });

    test('my：Bangumi rate 越界（0 / >10）与非数值不进 myRate（避免渲染错误徽章）', async () => {
        const h = loadMy({
            doAction: async () => ({ items: [
                { subject_id: 1, subject: { name_cn: 'A' }, type: 1, rate: 0 },
                { subject_id: 2, subject: { name_cn: 'B' }, type: 1, rate: 42 },
                { subject_id: 3, subject: { name_cn: 'C' }, type: 1, rate: 'abc' },
                { subject_id: 4, subject: { name_cn: 'D' }, type: 1, rate: 7 },
            ] }),
            extra: { Kazumi: { _getBangumiToken: async () => 'tok' } },
        });
        const out = await h.My._getBangumiItems(true);
        assert.equal(out[0].myRate, null, 'rate=0 视为未评分');
        assert.equal(out[1].myRate, null, 'rate>10 越界弃用');
        assert.equal(out[2].myRate, null, '非数值弃用');
        assert.equal(out[3].myRate, 7, '合法评分透传');
    });

    test('my：_saveBgmCol 拒绝非数组入参，合法数组以 ttl=0（永不过期）落盘', () => {
        const h = loadMy();
        assert.doesNotThrow(() => h.My._saveBgmCol(null));
        assert.doesNotThrow(() => h.My._saveBgmCol('str'));
        assert.doesNotThrow(() => h.My._saveBgmCol(undefined));
        assert.equal(h.bgm.set, 0, '非数组不得写缓存');
        h.My._saveBgmCol([{ vodId: '1' }]);
        assert.equal(h.bgm.set, 1, '数组应写入');
        assert.equal(h.bgm.setArgs[0].ttl, 0, '账号收藏缓存无 TTL');
        assert.equal(h.bgm.setArgs[0].k, 'my::bgmcol::v1', '持久键名带版本后缀');
    });

    test('my：refreshBangumi 作废内存+持久缓存后强制重拉最新数据', async () => {
        const h = loadMy({ doAction: async () => ({ items: [{ subject_id: 7, subject: { name_cn: '新番' }, type: 1 }] }), extra: { Kazumi: { _getBangumiToken: async () => 'tok' } } });
        const out = await h.My.refreshBangumi();
        assert.equal(h.bgm.del, 1, '应删持久缓存（修复「设置页同步后收藏页不刷新」）');
        assert.equal(out.length, 1);
        assert.equal(out[0].name, '新番');
    });

    // —— init / FavHub 订阅 / 同步进度

    test('my：init 幂等——重复 init 复用同一收藏视图且不重复订阅', () => {
        const FavHub = { n: 0, onChanged() { this.n++; return () => {}; } };
        const h = loadMy({ extra: { FavHub } });
        h.My.init();
        const first = h.views['my-favorites'];
        h.My.init();
        h.My.init();
        assert.equal(h.views['my-favorites'], first, '收藏视图应复用同一个实例');
        assert.equal(FavHub.n, 1, '只订阅一次');
        assert.equal(h.My._inited, true);
    });

    test('my：favorites 视图挂载了 _extra 数据源（Bangumi 收藏并入网格）', async () => {
        const { My, views } = loadMy();
        My.init();
        assert.equal(typeof views['my-favorites']._extra, 'function', '_extra 应为异步数据源函数');
        await assert.doesNotReject(views['my-favorites']._extra(), '_extra 调用不应抛错');
    });

    test('my：FavHub 变更时不在「我的」页——只置脏并重拉，不重渲染', async () => {
        const subs = [];
        // 测试桩自行提供 await 屏障：生产行为是同步派发（records.js 的 changed()
        // 是 for 循环逐个 try/catch，不 await 回调），订阅回调内部异步落定。
        // 之前用 `setTimeout(10ms)` 做"等落定"屏障，是对真实定时器时序的隐式依赖，
        // 事件循环停顿超过 10ms 时会偶发失败。await 桩仅用于测试确定性，
        // 不代表生产 hub 已改为 await 语义。
        const FavHub = {
            onChanged(cb) { subs.push(cb); return () => {}; },
            async changed(m) { await Promise.all(subs.slice().map((cb) => Promise.resolve(cb(m)))); },
        };
        const h = loadMy({ extra: { FavHub } });
        h.My.init();
        assert.equal(subs.length, 1, 'init 应订阅一次收藏变更');
        h.My.selectTab('favorites', false);
        const before = h.views['my-favorites'].rendered;
        await FavHub.changed({});
        assert.equal(h.My._dirty, true, '不在本页应置脏（App 未定义 → 视为不在本页）');
        assert.equal(h.views['my-favorites'].rendered, before, '不应重渲染');
        assert.equal(h.bgm.del, 1, '应作废持久缓存');
    });

    test('my：FavHub 变更时位于「我的→收藏」页——立即重渲染收藏网格', async () => {
        const subs = [];
        const FavHub = {
            onChanged(cb) { subs.push(cb); return () => {}; },
            async changed(m) { await Promise.all(subs.slice().map((cb) => Promise.resolve(cb(m)))); },
        };
        const h = loadMy({ extra: { FavHub, App: { currentView: 'my' } } });
        h.My.init();
        h.My.selectTab('favorites', false);
        const before = h.views['my-favorites'].rendered;
        await FavHub.changed({});
        assert.equal(h.views['my-favorites'].rendered, before + 1, '应重渲染一次收藏网格');
        assert.notEqual(h.My._dirty, true, '在本页重渲后不应置脏');
    });

    test('my：FavHub 变更时位于「我的→统计」页——走 My.render 刷新收藏部数', async () => {
        const subs = [];
        const FavHub = {
            onChanged(cb) { subs.push(cb); return () => {}; },
            async changed(m) { await Promise.all(subs.slice().map((cb) => Promise.resolve(cb(m)))); },
        };
        const h = loadMy({ settings: statsFixture, extra: { FavHub, App: { currentView: 'my' } } });
        h.My.init();
        h.My.selectTab('stats', false);
        await FavHub.changed({});
        assert.equal(h.jq.text('#my-stat-hours'), '2 小时 2 分', '统计页应被重渲');
        assert.match(h.jq.html('#my-stats-collections'), /my-stats-coll-total/, '收藏分类块应同步刷新');
    });

    test('my：同步按钮无 Bangumi Token 时提示先配置 Token 且不发起同步', async () => {
        const h = loadMy({ extra: { Kazumi: { _getBangumiToken: async () => '' } } });
        h.My.init();
        const handler = h.jq.handlers.find((x) => x.sel === '#my-favorites-bgm-sync');
        assert.ok(handler, '应绑定同步按钮');
        await handler.fn();
        assert.ok(h.calls.toasts.some((t) => t.includes('保存 Token')), '应提示先保存 Token');
        assert.equal(h.calls.actions.length, 0, '无 Token 不应发起网络请求');
    });

    test('my：同步进度条百分比钳制（超额取 100，total=0 取 0，计数文本同步）', () => {
        const { My, jq } = loadMy();
        My._openSyncProgress();
        assert.equal(jq.text('#bgm-sync-progress-text'), '准备同步 Bangumi 状态…');
        My._updateSyncProgress(1, 3, '上传本地收藏');
        assert.equal(jq.css('#bgmSyncProgressDialog .ss-fill', 'width'), '33%');
        assert.equal(jq.text('#bgm-sync-progress-count'), '1 / 3');
        My._updateSyncProgress(5, 4, '');
        assert.equal(jq.css('#bgmSyncProgressDialog .ss-fill', 'width'), '100%', '超额应钳到 100%');
        My._updateSyncProgress(0, 0, '拉取 Bangumi 收藏');
        assert.equal(jq.css('#bgmSyncProgressDialog .ss-fill', 'width'), '0%', 'total=0 时为 0%');
        assert.equal(jq.text('#bgm-sync-progress-count'), '', 'total=0 时不显示计数');
        assert.doesNotThrow(() => My._closeSyncProgress(), '关闭进度框不应抛错');
    });

    // ---- my.js 收藏网格：加载真实 records.js makeRecordView

    /**
     * 在 VM 中加载真实 records.js，取出 makeRecordView 构造「我的→收藏」视图；
     * jQuery 桩额外模拟卡片勾选集合，使全选/反选/勾选删除走源码真实分支。
     */
    function loadFavView(opts = {}) {
        const settings = { favorites: JSON.parse(JSON.stringify(opts.favorites || [])), history: [] };
        const jq = makeJqRecorder();
        const toasts = [];
        const confirms = [];
        const sets = [];
        const ui = { text: new Map(), prop: new Map() };
        const cards = []; // 卡片对象（同时充当 $(this) 的 DOM 桩）

        function makeCard(uid, bgm, id) {
            return {
                uid, bgm: !!bgm, id, checked: false, sel: false,
                data(k) {
                    if (k === 'bgm') return this.bgm ? '1' : '';
                    if (k === 'uid') return this.uid || '';
                    if (k === 'id') return this.id || '';
                    return '';
                },
                hasClass(c) { return c === 'checked' ? this.checked : false; },
                toggleClass(c, force) {
                    const on = force === undefined ? !this[c] : !!force;
                    if (c === 'checked') this.checked = on;
                    if (c === 'sel') this.sel = on;
                    return this;
                },
                removeClass(c) { if (c === 'checked') this.checked = false; if (c === 'sel') this.sel = false; return this; },
                addClass() { return this; },
                closest() { return this; },
                find() { return this; },
                each() { return this; },
                on() { return this; },
                off() { return this; },
                prop() { return this; },
                text() { return this; },
                html() { return this; },
                empty() { return this; },
                css() { return this; },
                toggle() { return this; },
                val() { return ''; },
                length: 1,
            };
        }

        function collection(items) {
            return {
                length: items.length,
                each(fn) { items.forEach((it, i) => fn.call(it, i, it)); return this; },
                toggleClass(c, force) { items.forEach((it) => it.toggleClass(c, force)); return this; },
                removeClass(c) { items.forEach((it) => it.removeClass(c)); return this; },
                addClass() { return this; },
                prop() { return this; },
                text() { return this; },
                html() { return this; },
                empty() { return this; },
                on() { return this; },
                off() { return this; },
                data() { return ''; },
                hasClass() { return false; },
                find() { return this; },
                closest() { return this; },
                val() { return ''; },
                toggle() { return this; },
            };
        }

        function selObj(sel) {
            const key = String(sel);
            const o = {
                on(...args) { jq.handlers.push({ sel: key, event: args[0], fn: args[args.length - 1] }); return o; },
                off() { return o; },
                html(s) { if (s !== undefined) jq.$(key).html(s); return o; },
                text(s) { if (s !== undefined) { jq.$(key).text(s); ui.text.set(key, String(s)); } return o; },
                empty() { jq.$(key).empty(); return o; },
                prop(k, v) { if (v !== undefined) ui.prop.set(`${key}|${k}`, v); return o; },
                toggle(v) { jq.toggled.push(v); return o; },
                toggleClass() { return o; },
                addClass() { return o; },
                removeClass() { return o; },
                data() { return ''; },
                attr() { return ''; },
                val() { return ''; },
                length: 0,
                hasClass() { return false; },
                each() { return o; },
                find() { return o; },
                closest() { return o; },
                css() { return o; },
                append() { return o; },
                scrollTop() { return o; },
                show() { return o; },
                hide() { return o; },
            };
            return o;
        }

        const $ = (sel) => {
            if (sel && typeof sel === 'object') return sel;             // $(this) → 卡片自身
            const s = String(sel === undefined || sel === null ? '' : sel);
            if (s === '#my-favorites-grid .rec-check.checked') return collection(cards.filter((c) => c.checked));
            if (s === '#my-favorites-grid .rec-check') return collection(cards);
            if (s === '#my-favorites-grid .vod-card') return collection(cards);
            return selObj(s);
        };

        const context = {
            console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
            parseInt, parseFloat, isNaN, setTimeout, clearTimeout,
            document: {},
            $,
            window: { yuki: {
                settingsGet: async () => JSON.parse(JSON.stringify(settings)),
                settingsSet: async (k, v) => { sets.push({ key: k, value: JSON.parse(JSON.stringify(v)) }); settings[k] = JSON.parse(JSON.stringify(v)); },
            } },
            escHtml,
            warnToast: (m) => toasts.push(String(m)),
            confirmDialog: async (msg) => {
                confirms.push(String(msg));
                const has = Object.prototype.hasOwnProperty.call(opts, 'confirm');
                return has ? opts.confirm : true;
            },
            openDialog: () => {}, closeDialog: () => {},
            Detail: { open: () => {} },
            Timeline: { refreshAfterFavoriteChange: () => {} },
            pageSizeOf: async () => (opts.pageSize || 20),
            renderPagerBox: () => {},
            fillMissingCovers: () => {}, fitVodTitles: () => {}, playCardsEnter: () => {},
            normalizePic: (p) => p || '',
            vodCoverImg: (pic) => `<img src="${pic || ''}">`,
            vodCoverChain: (list) => `<img src="${list[0] || ''}">`,
            bangumiCoverImg: (pic) => `<img src="${pic || ''}">`,
            bangumiCover: (images) => (typeof images === 'string' ? images : ((images && (images.common || images.large)) || '')),
            bangumiResizeUrl: (u) => u,
            bangumiMirrorUrl: () => '',
            isBangumiCoverUrl: () => false,
            truncateTitle: (s) => String(s || '').slice(0, 60),
            showLoading: () => {}, hideLoading: () => {}, localPlayToast: () => {},
            localThumbUrl: () => '',
        };
        context.globalThis = context;
        vm.createContext(context);
        vm.runInContext(`${RECORDS_SRC}\n;globalThis.__makeRecordView = makeRecordView;`, context, { filename: 'records.js' });
        const view = context.__makeRecordView('my-favorites', 'favorites', '暂无收藏。打开影片详情页点“收藏”按钮即可添加。', true, true, 'pageSizeFavorites', '#my-panel-favorites');

        /** 渲染后把 grid HTML 解析回卡片对象（按 uid/id 保留勾选态）。 */
        function syncCards() {
            const html = jq.html('#my-favorites-grid');
            const chunks = html.split('<div class="vod-card"').slice(1);
            const old = new Map(cards.map((c) => [`${c.bgm ? 'b' : 'l'}:${c.uid || c.id}`, c.checked]));
            cards.length = 0;
            for (const chunk of chunks) {
                const uid = (chunk.match(/data-uid="([^"]*)"/) || [])[1] || '';
                const id = (chunk.match(/data-id="([^"]*)"/) || [])[1] || '';
                const bgm = /data-bgm="1"/.test(chunk);
                const card = makeCard(uid, bgm, id);
                card.checked = old.get(`${bgm ? 'b' : 'l'}:${uid || id}`) || false;
                cards.push(card);
            }
            view._syncSelBar(); // 用最新卡片集合刷新按钮文案
        }

        const render = async () => { await view.render(); syncCards(); };
        return { view, render, cards, jq, toasts, confirms, sets, settings, ui, handlers: jq.handlers };
    }

    /** 从 grid HTML 中解析每张卡的关键 data-* 属性。 */
    function parseCards(html) {
        return [...html.matchAll(/<div class="vod-card"([^>]*)>/g)].map((m) => {
            const attrs = m[1];
            const pick = (k) => (attrs.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
            return { uid: pick('data-uid'), site: pick('data-site'), id: pick('data-id') };
        });
    }

    test('my：收藏渲染条数与字段映射——5 条收藏渲染 5 张卡，uid/site/id 逐条对应', async () => {
        const favorites = [
            { uid: 'u1', site: 'cspby', siteName: '源甲', vodId: '101', name: '片甲', tag: 'want' },
            { uid: 'u2', site: 'cspby', siteName: '源甲', vodId: '102', name: '片乙', tag: 'seen' },
            { uid: 'u3', site: 'kazumi:a', vodId: '103', name: '片丙', tag: 'watching' },
            { uid: 'u4', site: 'local', vodId: 'C:\\v.mp4', name: '本地片' },
            { uid: 'u5', site: 'download', vodId: 'D:\\v.mkv', name: '下载片' },
        ];
        const h = loadFavView({ favorites, pageSize: 20 });
        await h.render();
        const html = h.jq.html('#my-favorites-grid');
        const cards = parseCards(html);
        assert.equal(cards.length, 5, '应渲染 5 张卡');
        assert.deepEqual(cards.map((c) => c.uid), ['u1', 'u2', 'u3', 'u4', 'u5'], 'data-uid 逐条映射且顺序不变');
        assert.equal(cards[0].site, 'cspby', 'data-site 映射正确');
        assert.match(html, /data-local-path="C:\\v\.mp4"/, '本地卡带 data-local-path');
        assert.match(html, /data-local-path="D:\\v\.mkv"/, '下载卡带 data-local-path');
    });

    test('my：收藏卡字段映射——片名/来源徽标/勾选框/删除/标签齐全', async () => {
        const h = loadFavView({ favorites: [{ uid: 'u1', site: 'cspby', siteName: '源甲', vodId: '1', name: '片名甲', remarks: 'HD' }] });
        await h.render();
        const html = h.jq.html('#my-favorites-grid');
        assert.match(html, /片名甲/, '片名应渲染');
        assert.match(html, /源：源甲/, '来源徽标应渲染');
        assert.match(html, /rec-check/, '收藏卡应带勾选框（多选）');
        assert.match(html, /rec-del/, '收藏卡应带删除按钮');
        assert.match(html, /rec-tag/, '收藏卡应带状态标签');
    });

    test('my：片名注入串进卡片时经 escHtml，不产出可执行标签', async () => {
        const h = loadFavView({ favorites: [{ uid: 'u1', site: 'a', vodId: '1', name: '<img src=x onerror=alert(1)>' }] });
        await h.render();
        const html = h.jq.html('#my-favorites-grid');
        assert.doesNotMatch(html, /<img src=x onerror/, '原始注入标签不得出现');
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, '应转义为实体');
    });

    test('my：空收藏渲染空态引导文案并清空分页器（非空收藏引导）', async () => {
        const h = loadFavView({ favorites: [] });
        await h.render();
        const html = h.jq.html('#my-favorites-grid');
        assert.match(html, /tip-line/, '应渲染空态提示行');
        assert.match(html, /暂无收藏/, '空态应给出引导文案');
        assert.equal(h.jq.html('#my-favorites-pager'), '', '空列表应清空分页器');
    });

    test('my：缺字段的畸形收藏（无 uid / 只有 uid）不崩且仍渲染卡片', async () => {
        const h = loadFavView({ favorites: [{ site: 'a', vodId: '2' }, { uid: 'u3' }] });
        await assert.doesNotReject(h.render(), '缺字段条目不得 reject');
        assert.equal(parseCards(h.jq.html('#my-favorites-grid')).length, 2, '两条都应渲染');
    });

    test('my：搜索关键词大小写不敏感（大写/小写/混写均命中同一条）', async () => {
        const h = loadFavView({ favorites: [
            { uid: 'u1', site: 'a', vodId: '1', name: 'Grand Blue' },
            { uid: 'u2', site: 'a', vodId: '2', name: '葬送的芙莉莲' },
        ] });
        await h.render();
        for (const raw of ['grand', 'GRAND', 'Grand', 'GrAnD']) {
            h.view._q = raw.toLowerCase();
            await h.render();
            const cards = parseCards(h.jq.html('#my-favorites-grid'));
            assert.equal(cards.length, 1, `关键字「${raw}」应命中 1 条`);
            assert.equal(cards[0].uid, 'u1');
        }
    });

    test('my：搜索空串（清空关键字）恢复全部条目', async () => {
        const h = loadFavView({ favorites: [
            { uid: 'u1', site: 'a', vodId: '1', name: 'AAA' },
            { uid: 'u2', site: 'a', vodId: '2', name: 'BBB' },
        ] });
        h.view._q = 'aaa';
        await h.render();
        assert.equal(parseCards(h.jq.html('#my-favorites-grid')).length, 1);
        h.view._q = '';
        await h.render();
        assert.equal(parseCards(h.jq.html('#my-favorites-grid')).length, 2, '空串应不过滤');
    });

    test('my：搜索无匹配时显示「没有匹配的记录」而非空收藏引导文案', async () => {
        const h = loadFavView({ favorites: [{ uid: 'u1', site: 'a', vodId: '1', name: 'AAA' }] });
        h.view._q = 'zzz';
        await h.render();
        const html = h.jq.html('#my-favorites-grid');
        assert.match(html, /没有匹配的记录/, '有过滤条件时空态文案应切换');
        assert.doesNotMatch(html, /暂无收藏/);
    });

    test('my：搜索同时匹配片名/备注/来源名三个字段', async () => {
        const h = loadFavView({ favorites: [
            { uid: 'u1', site: 'a', siteName: '源甲', vodId: '1', name: '片X', remarks: '备注关键词' },
            { uid: 'u2', site: 'b', siteName: '源乙', vodId: '2', name: '片Y' },
            { uid: 'u3', site: 'c', vodId: '3', name: '片Z' },
        ] });
        h.view._q = '备注关键词';
        await h.render();
        assert.equal(parseCards(h.jq.html('#my-favorites-grid'))[0].uid, 'u1', '应按 remarks 命中');
        h.view._q = '源乙';
        await h.render();
        assert.equal(parseCards(h.jq.html('#my-favorites-grid'))[0].uid, 'u2', '应按 siteName 命中');
    });

    test('my：分页钳制——越界页码（99）被钳到末页且末页只剩余数', async () => {
        const favorites = Array.from({ length: 25 }, (_, i) => ({ uid: `u${i}`, site: 'a', vodId: String(i), name: `片${i}` }));
        const h = loadFavView({ favorites, pageSize: 10 });
        h.view._page = 99;
        await h.render();
        assert.equal(h.view._page, 3, '越界页应钳到末页 3');
        const cards = parseCards(h.jq.html('#my-favorites-grid'));
        assert.equal(cards.length, 5, '末页只剩 5 条');
        assert.equal(cards[0].uid, 'u20', '末页切片起点正确');
    });

    test('my：分页钳制——非法页码（0/负数/NaN/null）一律回到首页', async () => {
        const favorites = Array.from({ length: 25 }, (_, i) => ({ uid: `u${i}`, site: 'a', vodId: String(i), name: `片${i}` }));
        const h = loadFavView({ favorites, pageSize: 10 });
        for (const bad of [0, -5, null]) {
            h.view._page = bad;
            await h.render();
            assert.equal(h.view._page, 1, `page=${String(bad)} 应钳回首页`);
            const cards = parseCards(h.jq.html('#my-favorites-grid'));
            assert.equal(cards.length, 10, `page=${String(bad)} 首页应渲染 10 条`);
            assert.equal(cards[0].uid, 'u0');
        }
        // 疑似缺陷（records.js:690）：page=NaN 时 Math.max(1, NaN)=NaN，钳制失效，
        // 后续 slice(NaN, NaN) 得到空数组 → 渲染出「暂无收藏」空态（列表非空却空屏）。
        h.view._page = NaN;
        await h.render();
        assert.ok(Number.isNaN(h.view._page), 'page=NaN 时钳制失效（见报告：疑似缺陷）');
        assert.equal(h.jq.html('#my-favorites-grid'), '', '表现为非空列表被渲染成完全空白的网格');
    });

    test('my：分页首页只渲染第一页内容（不泄漏后续条目）', async () => {
        const favorites = Array.from({ length: 25 }, (_, i) => ({ uid: `u${i}`, site: 'a', vodId: String(i), name: `片${i}` }));
        const h = loadFavView({ favorites, pageSize: 10 });
        h.view._page = 1;
        await h.render();
        const cards = parseCards(h.jq.html('#my-favorites-grid'));
        assert.equal(cards.length, 10);
        assert.deepEqual(cards.map((c) => c.uid), ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9']);
    });

    test('my：不足一页时页码钳回 1（pagecount=1，无分页器）', async () => {
        const favorites = Array.from({ length: 3 }, (_, i) => ({ uid: `u${i}`, site: 'a', vodId: String(i), name: `片${i}` }));
        const h = loadFavView({ favorites, pageSize: 20 });
        h.view._page = 7;
        await h.render();
        assert.equal(h.view._page, 1, '总页数不足时应钳回第 1 页');
    });

    test('my：输入搜索关键字时页码立即回到第 1 页（避免停在空页）', async () => {
        const favorites = Array.from({ length: 25 }, (_, i) => ({ uid: `u${i}`, site: 'a', vodId: String(i), name: `片${i}` }));
        const h = loadFavView({ favorites, pageSize: 10 });
        h.view._page = 3;
        await h.render();
        assert.equal(h.view._page, 3);
        h.view.init();
        const input = h.handlers.find((x) => x.sel === '#my-favorites-search' && x.event === 'input');
        assert.ok(input, '应绑定搜索框 input 事件');
        input.fn({ currentTarget: { value: '片1' } });
        assert.equal(h.view._page, 1, '输入关键字应立即回到第 1 页');
        assert.equal(h.view._q, '片1', '关键字应已小写化存好');
    });

    // —— 多选删除：选中集合管理 + 删除确认回调三种结果

    test('my：多选全选——勾选全部卡片，计数文案与全选框同步为已选', async () => {
        const favorites = Array.from({ length: 3 }, (_, i) => ({ uid: `u${i}`, site: 'a', vodId: String(i), name: `片${i}` }));
        const h = loadFavView({ favorites });
        h.view.init();
        await h.render();
        const checkall = h.handlers.find((x) => x.sel === '#my-favorites-checkall' && x.event === 'change');
        assert.ok(checkall, '收藏页应绑定全选框 change');
        checkall.fn({ currentTarget: { checked: true } });
        assert.deepEqual(h.cards.map((c) => c.checked), [true, true, true], '全选应勾选所有卡片');
        assert.deepEqual(h.cards.map((c) => c.sel), [true, true, true], '卡片应同步 sel 高亮');
        assert.equal(h.ui.text.get('#my-favorites-delchecked'), '删除勾选（3）', '按钮应显示勾选数');
        assert.equal(h.ui.prop.get('#my-favorites-checkall|checked'), true, '全选框应保持选中态');
    });

    test('my：多选反选（取消全选）——清空所有勾选，按钮文案回到「删除勾选」', async () => {
        const favorites = Array.from({ length: 3 }, (_, i) => ({ uid: `u${i}`, site: 'a', vodId: String(i), name: `片${i}` }));
        const h = loadFavView({ favorites });
        h.view.init();
        await h.render();
        const checkall = h.handlers.find((x) => x.sel === '#my-favorites-checkall' && x.event === 'change');
        checkall.fn({ currentTarget: { checked: true } });
        checkall.fn({ currentTarget: { checked: false } });
        assert.deepEqual(h.cards.map((c) => c.checked), [false, false, false], '取消全选应清空勾选');
        assert.deepEqual(h.cards.map((c) => c.sel), [false, false, false], 'sel 高亮应一并清除');
        assert.equal(h.ui.text.get('#my-favorites-delchecked'), '删除勾选', '无勾选时按钮不显示计数');
        assert.equal(h.ui.prop.get('#my-favorites-checkall|checked'), false);
    });

    test('my：退出多选模式——清空勾选、复位工具栏与全选框', async () => {
        const favorites = Array.from({ length: 2 }, (_, i) => ({ uid: `u${i}`, site: 'a', vodId: String(i), name: `片${i}` }));
        const h = loadFavView({ favorites });
        h.view.init();
        await h.render();
        h.view.toggleSelectMode();
        assert.equal(h.view._selectMode, true, '应进入多选模式');
        assert.equal(h.ui.text.get('#my-favorites-multidel'), '退出多选', '进入后按钮文案切换');
        const checkall = h.handlers.find((x) => x.sel === '#my-favorites-checkall' && x.event === 'change');
        checkall.fn({ currentTarget: { checked: true } });
        assert.equal(h.cards.filter((c) => c.checked).length, 2);
        h.view.toggleSelectMode();
        assert.equal(h.view._selectMode, false, '应退出多选模式');
        assert.deepEqual(h.cards.map((c) => c.checked), [false, false], '退出应清空所有勾选');
        assert.deepEqual(h.cards.map((c) => c.sel), [false, false]);
        assert.equal(h.ui.text.get('#my-favorites-multidel'), '多选', '退出后按钮文案复位');
        assert.equal(h.ui.prop.get('#my-favorites-checkall|checked'), false, '全选框应复位');
    });

    test('my：删除确认回调——未勾选任何条目时不弹确认、不写盘，只提示先勾选', async () => {
        const favorites = [{ uid: 'u1', site: 'a', vodId: '1', name: '片1' }];
        const h = loadFavView({ favorites });
        h.view.init();
        await h.render();
        await h.view.removeChecked();
        assert.equal(h.confirms.length, 0, '无勾选不应弹出确认框');
        assert.equal(h.sets.length, 0, '不应写盘');
        assert.ok(h.toasts.some((t) => t.includes('请先勾选')), '应提示先勾选');
    });

    test('my：删除确认回调——确认后按 uid 删除勾选项并写盘、退出多选、提示成功', async () => {
        const favorites = [
            { uid: 'u1', site: 'a', vodId: '1', name: '片1' },
            { uid: 'u2', site: 'a', vodId: '2', name: '片2' },
            { uid: 'u3', site: 'a', vodId: '3', name: '片3' },
        ];
        const h = loadFavView({ favorites, confirm: true });
        h.view.init();
        await h.render();
        h.view._selectMode = true;
        const checkall = h.handlers.find((x) => x.sel === '#my-favorites-checkall' && x.event === 'change');
        checkall.fn({ currentTarget: { checked: false } });
        h.cards[0].checked = true; // 只勾第 1 条
        h.cards[2].checked = true; // 与第 3 条
        await h.view.removeChecked();
        assert.equal(h.confirms.length, 1, '应弹出一次确认框');
        assert.match(h.confirms[0], /删除勾选的 2 条记录？/, '确认文案应带勾选条数');
        const remain = h.settings.favorites.map((f) => f.uid);
        assert.deepEqual(remain, ['u2'], '只保留未勾选的第 2 条');
        assert.equal(h.view._selectMode, false, '删除后应退出多选模式');
        assert.ok(h.toasts.some((t) => t === '已删除 2 条'), '应提示删除条数');
    });

    test('my：删除确认回调——取消确认时不删除、不写盘', async () => {
        const favorites = [
            { uid: 'u1', site: 'a', vodId: '1', name: '片1' },
            { uid: 'u2', site: 'a', vodId: '2', name: '片2' },
        ];
        const h = loadFavView({ favorites, confirm: false });
        h.view.init();
        await h.render();
        h.view._selectMode = true;
        h.cards[0].checked = true;
        await h.view.removeChecked();
        assert.equal(h.confirms.length, 1, '应弹出确认框');
        assert.equal(h.settings.favorites.length, 2, '取消后两条都还在');
        assert.ok(!h.sets.some((s) => s.value.length === 1), '不应写回被删后的列表');
        assert.ok(!h.toasts.some((t) => t.startsWith('已删除')), '不应提示删除成功');
    });

    test('my：删除确认回调——勾选项里混入 Bangumi 条目时只删本地、远端原样保留', async () => {
        const favorites = [
            { uid: 'u1', site: 'a', vodId: '1', name: '本地片' },
            { uid: 'u2', site: 'a', vodId: '2', name: '另一本地片' },
        ];
        const h = loadFavView({ favorites, confirm: true });
        h.view.init();
        h.view._extra = async () => [{ site: 'bangumi', vodId: '77', name: '远端番', tag: 'want', bangumi: true }];
        await h.render();
        assert.equal(h.cards.length, 3, '本地 2 条 + 远端 1 条');
        h.view._selectMode = true;
        h.cards.forEach((c) => { c.checked = true; }); // 全勾（含 Bangumi）
        await h.view.removeChecked();
        assert.match(h.confirms[0], /删除勾选的 2 条记录？/, '确认条数应只统计本地条目');
        assert.deepEqual(h.settings.favorites.map((f) => f.uid), [], '两条本地收藏应被删除');
        assert.ok(h.toasts.some((t) => t === '已删除 2 条'), '提示的条数也只算本地');
    });

    test('my：删除确认回调——只勾 Bangumi 条目时直接跳过（不弹确认），本地条目不受影响', async () => {
        const favorites = [{ uid: 'u1', site: 'a', vodId: '1', name: '本地片' }];
        const h = loadFavView({ favorites });
        h.view.init();
        // 混入一条远端 Bangumi 条目，走 _extra 合并进网格
        h.view._extra = async () => [{ site: 'bangumi', vodId: '77', name: '远端番', tag: 'want', bangumi: true }];
        await h.render();
        const bgmCard = h.cards.find((c) => c.bgm);
        assert.ok(bgmCard, 'Bangumi 条目应出现在网格里');
        h.view._selectMode = true;
        h.cards.forEach((c) => { c.checked = c.bgm; }); // 只勾 Bangumi 条目
        await h.view.removeChecked();
        assert.equal(h.confirms.length, 0, 'Bangumi 条目不参与删除，不应弹确认');
        assert.equal(h.settings.favorites.length, 1, '本地收藏原样保留');
        assert.ok(h.toasts.some((t) => t.includes('Bangumi 条目不支持删除')), '应提示 Bangumi 条目不支持删除');
    });

    test('my：删除确认回调——单条删除（卡片 ✕）确认后按 uid 精确移除目标', async () => {
        const favorites = [
            { uid: 'u1', site: 'a', vodId: '1', name: '片1' },
            { uid: 'u2', site: 'a', vodId: '2', name: '片2' },
            { uid: 'u3', site: 'a', vodId: '3', name: '片3' },
        ];
        const h = loadFavView({ favorites, confirm: true });
        await h.view.remove('u2');
        assert.deepEqual(h.settings.favorites.map((f) => f.uid), ['u1', 'u3'], '只删目标 uid，其余不动');
        assert.match(h.confirms[0], /确定删除「片2」？/, '确认文案应带片名');
    });

    test('my：删除不存在的 uid 时不写盘、不误删（并发删除竞态兜底）', async () => {
        const favorites = [{ uid: 'u1', site: 'a', vodId: '1', name: '片1' }];
        const h = loadFavView({ favorites, confirm: true });
        await h.view.remove('ghost-uid');
        assert.equal(h.settings.favorites.length, 1, '原收藏应完好');
        assert.match(h.confirms[0], /确定删除「此记录」？/, '找不到条目时用「此记录」兜底文案');
    });

    test('my：删除确认回调——确认框返回假值（null/0/空串/undefined）一律按取消处理', async () => {
        const favorites = [{ uid: 'u1', site: 'a', vodId: '1', name: '片1' }];
        for (const falsy of [null, 0, '', undefined, false]) {
            const h = loadFavView({ favorites, confirm: falsy });
            await h.view.remove('u1');
            assert.equal(h.settings.favorites.length, 1, `confirmDialog 返回 ${String(falsy)} 时应视为取消`);
        }
    });

    test('my：删除确认回调——确认框返回真值即执行删除（不区分 true/1/对象）', async () => {
        const favorites = [{ uid: 'u1', site: 'a', vodId: '1', name: '片1' }];
        for (const truthy of [true, 1, 'yes', { ok: 1 }]) {
            const h = loadFavView({ favorites, confirm: truthy });
            await h.view.remove('u1');
            assert.equal(h.settings.favorites.length, 0, `confirmDialog 返回 ${String(truthy)} 时应执行删除`);
        }
    });

    test('my：本地/下载文件记录也能按 uid 勾选删除（同走 removeChecked）', async () => {
        const favorites = [
            { uid: 'u1', site: 'local', vodId: 'C:\\a.mp4', name: '本地视频' },
            { uid: 'u2', site: 'download', vodId: 'D:\\b.mkv', name: '下载视频' },
            { uid: 'u3', site: 'a', vodId: '3', name: '在线片' },
        ];
        const h = loadFavView({ favorites, confirm: true });
        h.view.init();
        await h.render();
        assert.equal(h.cards.length, 3, '本地/下载/在线三类条目都应渲染');
        h.view._selectMode = true;
        h.cards[0].checked = true;
        h.cards[1].checked = true;
        await h.view.removeChecked();
        assert.deepEqual(h.settings.favorites.map((f) => f.uid), ['u3'], '两条本地/下载记录被删除，在线片保留');
    });


});
