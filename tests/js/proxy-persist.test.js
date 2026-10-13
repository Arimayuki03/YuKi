/**
 * 设置页「网络代理」地址持久化 单元测试（用户反馈：代理网址关闭后再打开要还在）
 *
 * 覆盖三块：
 *  ① 渲染层纯函数（panels.js 顶部「网络代理」段）：parseProxyUrl 的 scheme/格式校验、
 *     sanitizeProxyDraft 归一化、shouldRefillProxyInput 回填守卫、makeDraftSaver 防抖节流；
 *  ② 渲染层接线：输入即防抖落盘（persistOnly，不应用）、失焦立即落盘、关闭开关带当前网址
 *     （不再写死空串把记录抹掉）、异步回填不覆盖用户已输入内容、提示行文案；
 *  ③ 主进程 yuki:set-proxy handler（vm 加载真实 index.js，不启动 Electron 应用本体）：
 *     地址记录落盘（settings.json 真实文件校验）、关闭不清空、草稿通道零副作用、
 *     同时钉住既有能力（env 注入 / NO_PROXY / session 代理 / 后端重启语义）。
 *
 * 加载范式：渲染层照抄 tests/js/captcha-probe-ui.test.js（经典脚本 + jQuery 桩 + vm 沙箱）；
 * 主进程照抄 tests/js/ipc-handlers-blackbox.test.js（electron 桩 + 模块缓存替换）。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const PANELS_SRC = fs.readFileSync(path.join(ROOT, 'src/renderer/js/panels.js'), 'utf8');
// 设置回填的收尾是 `.catch(() => { })` —— 它会把回填链里的任何异常静默吞掉，
// 于是「回填没跑到代理那一行」在测试里表现为「值没写上」而无从定位。
// 沙箱内把它换成记录异常（只改 catch 分支，成功路径一字不动），
// 让 fill 相关用例能断言「回填链本身没有炸」。
const PANELS_SRC_DIAG = PANELS_SRC.replace(
    /(updateBlockedLine\(s\);)\s*\}\)\.catch\(\(\) => \{ \}\);/,
    '$1\r\n    }).catch((e) => { globalThis.__fillError = e; });'
);
if (PANELS_SRC_DIAG === PANELS_SRC) throw new Error('[harness] 回填 catch 锚点变更：诊断替换失效，请更新正则');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const MAIN_INDEX = path.join(ROOT, 'src', 'main', 'index.js');
const read = (p) => fs.readFileSync(p, 'utf8');
/** 真实 common.js 上下文（惰性装载一次：屏蔽词归一化等回填链前置调用取真实现） */
const COMMON = loadCommonCtx();

// ==================================================================
// A. 渲染层：vm 沙箱加载 panels.js
// ==================================================================

/**
 * 装载真实 common.js 并取其全局真实现（做法同 tests/js/records.test.js 的反 mock 漂移）：
 * 设置回填链的前置调用（屏蔽词归一化等）若用桩，会把「回填链异常」与「桩不准」
 * 混成同一个失败现象——本文件的 fill 用例要断言回填链本身没有异常。
 */
function loadCommonCtx() {
    const ctx = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout, URL, URLSearchParams, Error, RegExp,
        Symbol, WeakMap, WeakSet, Function, AbortController,
        document: { addEventListener() { }, documentElement: { classList: { contains: () => false, toggle() { } } } },
        $: () => ({ on() { return this; } }),
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer/js/common.js'), 'utf8'), ctx, { filename: 'common.js' });
    return ctx;
}

/**
 * 加载 panels.js 并调用 initSettingsPanel()，返回被捕获的处理器与观测点。
 * @param {object} o { settings: 初始快照 | null(挂起直到 resolveSettings), testProxy: 桩返回 }
 */
function loadPanels(o) {
    const opts = o || {};
    const recs = [];                 // 每个 $(sel) 的记录（handlers/prop/text 等）
    const vals = new Map();          // 输入框值（$(sel).val() 读写共用）
    const setProxyCalls = [];
    const settingsSets = [];
    const testProxyCalls = [];
    const toasts = [];
    const timers = [];               // 假定时器队列（生产代码用的沙箱 setTimeout）

    function makeEl() {
        return {
            style: {}, dataset: {}, value: '', checked: false, textContent: '', disabled: false,
            classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
            addEventListener() { }, removeEventListener() { }, setAttribute() { },
            getAttribute: () => null, removeAttribute() { }, appendChild() { }, remove() { },
            focus() { }, blur() { }, click() { }, scrollIntoView() { },
            getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 }),
        };
    }

    function jq(sel) {
        let rec = recs.find((r) => r.sel === sel);
        if (!rec) { rec = { sel, text: [], prop: {}, css: [], handlers: {} }; recs.push(rec); }
        const api = {
            __rec: rec, length: 1,
            text(v) { rec.text.push(String(v)); return api; },
            html(v) { rec.text.push(String(v)); return api; },
            prop(k, v) {
                if (v === undefined) {
                    if (k === 'checked') return rec.prop.checked === undefined ? false : rec.prop.checked;
                    if (k === 'hidden') return rec.prop.hidden === undefined ? false : rec.prop.hidden;
                    return rec.prop[k];
                }
                rec.prop[k] = v; return api;
            },
            val(v) {
                if (v === undefined) return vals.has(sel) ? vals.get(sel) : '';
                vals.set(sel, String(v)); return api;
            },
            css(k, v) { rec.css.push([k, v]); return api; },
            attr() { return api; }, removeAttr() { return api; },
            on(ev, fn) { (rec.handlers[ev] = rec.handlers[ev] || []).push(fn); return api; },
            off() { return api; }, toggle(v) { rec.toggleArgs = rec.toggleArgs || []; rec.toggleArgs.push(v); return api; },
            show() { return api; }, hide() { return api; },
            addClass() { return api; }, removeClass() { return api; }, find() { return api; },
            each() { return api; }, filter() { return api; }, data() { return ''; },
            append() { return api; }, appendTo() { return api; }, empty() { return api; },
            scrollTop() { return api; }, remove() { return api; }, focus() { return api; },
            blur() { return api; }, trigger() { return api; }, closest() { return api; },
            parent() { return api; }, children() { return api; }, eq() { return api; },
        };
        api[0] = makeEl();
        return api;
    }

    let resolveSettings = null;
    const settingsPromise = opts.settings === undefined
        ? new Promise((r) => { resolveSettings = r; })          // 由用例控制 resolve 时机（模拟异步回填）
        : Promise.resolve(opts.settings);
    const yuki = {
        setProxy: async (kv) => { setProxyCalls.push({ ...kv }); return { ok: true, persisted: true }; },
        testProxy: async (kv) => {
            testProxyCalls.push({ ...kv });
            if (opts.testProxy) return opts.testProxy(kv);
            return { ok: true, statusCode: 204, elapsedMs: 5, proxy: kv.proxyUrl, testHost: 'x', viaTunnel: false, viaSocks: false };
        },
        settingsSet: async (k, v) => { settingsSets.push([k, v]); return true; },
        settingsGet: () => settingsPromise,
        settingsReset: async () => ({}),
        onUpdateState: () => { },
        checkForUpdates: async () => ({}),
        appVersion: async () => '0.0.0-test',
        playerConfig: async () => ({ mode: 'builtin', available: true, path: '' }),
        getLogs: async () => [],
        assetStatus: async () => ({
            ffmpeg: { ready: true }, mpv: { ready: true }, aria2: { ready: false },
            anime4k: { ready: true }, java: { ready: false },
        }),
    };
    const yukiProxy = new Proxy(yuki, {
        get(t, k) { if (k in t) return t[k]; return () => Promise.resolve({}); },
        has: () => true,
    });

    const ctx = {
        $: jq, jQuery: jq,
        console, Promise, JSON, Date, Math, String, Number, Object,
        Array, Boolean, RegExp, Error, isNaN, parseInt, parseFloat, encodeURIComponent,
        // 假定时器：防抖节流必须可控（不真等 500ms），只记账不自动触发
        setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
        clearTimeout: (h) => { if (h) h.cleared = true; },
        document: {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() { }, remove() { } }, setAttribute() { } }),
            addEventListener() { }, removeEventListener() { }, body: { appendChild() { } },
        },
        window: { yuki: yukiProxy, _cfgHistoryCache: undefined, addEventListener() { }, removeEventListener() { } },
        escHtml: (s) => String(s), escPath: (s) => String(s),
        // common.js 真实现（回填链前置调用，见 loadCommonCtx）
        normalizeBlockWords: COMMON.normalizeBlockWords,
        normalizeBlockText: COMMON.normalizeBlockText,
        invalidateBlockWords: COMMON.invalidateBlockWords,
        warnToast: (m) => { toasts.push(String(m)); }, showLoading: () => { }, hideLoading: () => { },
        openDialog: () => { }, closeDialog: () => { }, confirmDialog: async () => true,
        registerEsc: () => { }, createRuntimeId: (p) => `${p}-test`, fmtSize: (b) => `${b}B`,
        getJson: async () => ({}), localPlayToast: () => { }, toFileUrl: (p) => `file:///${p}`,
        applySkin: () => { }, applyMisansFont: async () => { }, CSS: { escape: (s) => String(s) },
        refreshCacheDirLine: () => { }, refreshDlDirLine: () => { }, updateBlockedLine: () => { },
        doAction: async () => ({ code: 200 }),
        AdSkip: { clearAllOpEd: () => 0 }, Player: {}, UIState: {}, Home: {}, Live: {},
        Downloads: {}, About: {}, YukiTranslate: {}, apiUrl: (p) => `http://x${p}`,
        replayClass: () => { }, STAGGER_STEP_MS: 0, STAGGER_MAX_IDX: 0,
        AbortSignal: { timeout: () => ({}) },
    };
    ctx.globalThis = ctx;
    ctx.window.document = ctx.document;
    vm.createContext(ctx);
    vm.runInContext(PANELS_SRC_DIAG + `
;globalThis.__init = initSettingsPanel;
;globalThis.__parseProxyUrl = parseProxyUrl;
;globalThis.__sanitizeProxyDraft = sanitizeProxyDraft;
;globalThis.__shouldRefill = shouldRefillProxyInput;
;globalThis.__isPrivate = isPrivateProxyHost;
;globalThis.__reasonText = proxyReasonText;
;globalThis.__fieldsVisible = proxyFieldsVisible;
;globalThis.__makeDraftSaver = makeDraftSaver;`, ctx, { filename: 'panels.js' });
    ctx.__init();
    /** 回填链异常（见 PANELS_SRC_DIAG 注释）：断言文案里带出来，避免「没回填」被误判为业务行为 */
    const fillError = () => (ctx.__fillError ? (ctx.__fillError.stack || String(ctx.__fillError)) : '');

    const recOf = (sel) => recs.find((r) => r.sel === sel);
    const handler = (sel, ev) => {
        const r = recOf(sel);
        return r && r.handlers[ev] && r.handlers[ev][0];
    };
    /** 模拟用户输入：写值 + 触发 input（生产代码在 input 上做防抖落盘） */
    const type = (sel, v) => {
        vals.set(sel, v);
        const h = handler(sel, 'input');
        if (h) h.call({ value: v });
    };
    /** 模拟失焦：触发 change（生产代码在 change 上立即落盘） */
    const blur = (sel) => {
        const h = handler(sel, 'change');
        if (h) h.call({ value: vals.get(sel) || '' });
    };
    /** 触发假定时器（跑防抖落盘） */
    const runTimers = () => { for (const h of timers.splice(0)) if (!h.cleared) h.fn(); };

    return {
        ctx, recs, recOf, handler, type, blur, runTimers, vals, fillError,
        setProxyCalls, settingsSets, testProxyCalls, toasts, timers,
        getVal: (sel) => (vals.has(sel) ? vals.get(sel) : ''),
        setVal: (sel, v) => vals.set(sel, String(v)),
        resolveSettings: (s) => { if (resolveSettings) resolveSettings(s); },
    };
}

// ---------------------------------------------------------------- ① 纯函数

test('parseProxyUrl：http/https/socks5 与裸 host:port 归一化，环回/私网标记但放行', () => {
    const h = loadPanels({ settings: {} });
    const p = h.ctx.__parseProxyUrl;
    const ok = (raw, want) => {
        const r = p(raw);
        assert.equal(r.ok, true, `${raw} 应通过：${r.reason}`);
        assert.equal(r.normalized, want, `${raw} 归一化`);
        return r;
    };
    ok('127.0.0.1:7890', 'http://127.0.0.1:7890');
    ok('http://127.0.0.1:7890', 'http://127.0.0.1:7890');
    ok('  https://proxy.local:8443  ', 'https://proxy.local:8443');
    ok('socks5://127.0.0.1:1080', 'socks5://127.0.0.1:1080');
    ok('socks://127.0.0.1:1080', 'socks5://127.0.0.1:1080');
    ok('[::1]:7890', 'http://[::1]:7890');
    ok('::1:7890', 'http://[::1]:7890');
    ok('user:pass@proxy.test:8080', 'http://user:pass@proxy.test:8080');
    // 环回/私网：本场景必须放行（Clash/v2ray 监听 127.0.0.1 是最主流用法），仅打标记供 UI 提示
    assert.equal(p('127.0.0.1:7890').privateHost, true);
    assert.equal(p('localhost:7890').privateHost, true);
    assert.equal(p('[::1]:7890').privateHost, true);
    assert.equal(p('192.168.1.5:7890').privateHost, true);
    assert.equal(p('10.1.2.3:7890').privateHost, true);
    assert.equal(p('172.20.1.1:7890').privateHost, true);
    assert.equal(p('172.32.1.1:7890').privateHost, false, '172.32 已出 172.16/12 私网段');
    assert.equal(p('proxy.example.com:7890').privateHost, false);
    assert.equal(p('user:pass@proxy.test:8080').hasUserinfo, true);
});

test('parseProxyUrl：非 http/https/socks5 的 scheme 与非法格式一律拒绝并给出原因', () => {
    const h = loadPanels({ settings: {} });
    const p = h.ctx.__parseProxyUrl;
    const cases = [
        ['', 'empty'],
        ['   ', 'empty'],
        ['ftp://127.0.0.1:7890', 'scheme'],
        ['file:///etc/passwd', 'scheme'],
        ['javascript:alert(1)', 'scheme'],
        ['data:text/html,x', 'scheme'],
        ['https:/127.0.0.1:7890', 'scheme'],
        ['http://127.0.0.1', 'port'],          // 缺端口
        ['127.0.0.1', 'port'],
        ['127.0.0.1:0', 'port'],
        ['127.0.0.1:65536', 'port'],
        ['127.0.0.1:abc', 'port'],
        ['http://:7890', 'host'],
        ['http://127.0.0.1:7890\nHost: evil', 'chars'],   // 换行 => 日志/env 注入风险
        ['http://127.0.0.1:78\t90', 'chars'],             // 内部制表符（内部空白一律拒）
        ['http://127.0.0.1:7890 extra', 'chars'],         // 内部空格
        ['x'.repeat(600), 'too-long'],
        [null, 'chars'],
    ];
    for (const [raw, reason] of cases) {
        const r = p(raw);
        assert.equal(r.ok, false, `${JSON.stringify(raw)} 应被拒绝`);
        assert.equal(r.reason, reason, `${JSON.stringify(raw)} 的原因`);
        assert.equal(r.normalized, '');
        assert.equal(typeof h.ctx.__reasonText(r.reason), 'string');
    }
});

test('sanitizeProxyDraft：去空白/剔控制字符/截断超长，空与非串归零（不清既有记录）', () => {
    const h = loadPanels({ settings: {} });
    const s = h.ctx.__sanitizeProxyDraft;
    assert.equal(s('  127.0.0.1:7890  '), '127.0.0.1:7890');
    assert.equal(s('127.0.0.1:789\r\n'), '127.0.0.1:789', '控制字符剔除而非整串拒绝');
    assert.equal(s('127.0.0.1:78\u00009'), '127.0.0.1:789');
    assert.equal(s(''), '');
    assert.equal(s('   '), '');
    assert.equal(s(null), '');
    assert.equal(s(undefined), '');
    assert.equal(s(123), '');
    assert.equal(s('x'.repeat(600)).length, 512);
    // 半截输入必须能存住（「填了没保存就关应用」正是要救的场景）
    assert.equal(s('127.0.0.1:'), '127.0.0.1:');
});

test('shouldRefillProxyInput：用户已编辑或框非空时不回填', () => {
    const h = loadPanels({ settings: {} });
    const f = h.ctx.__shouldRefill;
    assert.equal(f('', 'http://127.0.0.1:7890', false), true, '空框未编辑 => 回填');
    assert.equal(f('', '', false), false, '无可回填值 => 不写');
    assert.equal(f('', 'http://x:1', true), false, '用户已编辑 => 不回填（防异步覆盖）');
    assert.equal(f('http://new:1', 'http://old:2', false), false, '框非空 => 不覆盖');
    assert.equal(f(null, 'http://x:1', false), true, 'null 视作空');
});

test('proxyFieldsVisible：启用必展开；未启用但有地址记录也展开（记录不再被折叠藏起来）', () => {
    const h = loadPanels({ settings: {} });
    const f = h.ctx.__fieldsVisible;
    assert.equal(f(true, ''), true, '启用时必展开');
    assert.equal(f(false, '127.0.0.1:7890'), true, '未启用但有记录 => 展开（用户要能看到上次的网址）');
    assert.equal(f(false, ''), false, '无记录 => 随开关收起');
    assert.equal(f(false, '   '), false, '空白不算记录');
    assert.equal(f(false, ' 127.0.0.1:1 '), true);
});

test('makeDraftSaver：防抖合并只落末值，flush 立即落盘，cancel 丢弃', () => {
    const h = loadPanels({ settings: {} });
    const writes = [];
    const timers = [];
    const saver = h.ctx.__makeDraftSaver({
        delay: 500,
        write: (v) => { writes.push(v); return v; },
        setTimer: (fn) => { const t = { fn, cleared: false }; timers.push(t); return t; },
        clearTimer: (t) => { if (t) t.cleared = true; },
    });
    saver.schedule('a');
    saver.schedule('ab');
    saver.schedule('abc');
    assert.deepEqual(writes, [], '未到点不落盘');
    assert.equal(saver.pendingValue(), 'abc');
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
    assert.deepEqual(writes, ['abc'], '合并为一次且只落末值');
    saver.schedule('z');
    assert.equal(saver.flush(), 'z');
    assert.deepEqual(writes, ['abc', 'z'], 'flush 立即落盘');
    saver.schedule('nope');
    saver.cancel();
    assert.equal(saver.pendingValue(), null);
    assert.equal(saver.flush(), null);
    assert.deepEqual(writes, ['abc', 'z'], 'cancel 后不再落盘');
});

// ---------------------------------------------------------------- ② 渲染层接线

test('index.html：代理区块有提示行（hidden 初值由处理器揭掉），无内联脚本/内联事件', () => {
    assert.match(HTML_SRC, /id="set_proxy_hint"[^>]*\shidden/, '提示行初始 hidden');
    assert.match(HTML_SRC, /id="set_proxy_url"/);
    assert.match(HTML_SRC, /id="set_proxy_test_url"/);
    assert.doesNotMatch(HTML_SRC, /id="set_proxy_(url|hint)"[^>]*\son[a-z]+=/i, '禁止内联事件属性（CSP）');
});

test('输入即防抖落盘：连续敲键只发一次 persistOnly（只记地址，不重启后端）', () => {
    const h = loadPanels({ settings: {} });
    h.type('#set_proxy_url', '127.0.0.1:7');
    h.type('#set_proxy_url', '127.0.0.1:78');
    h.type('#set_proxy_url', '127.0.0.1:7890');
    assert.equal(h.setProxyCalls.length, 0, '防抖窗口内不落盘');
    h.runTimers();
    assert.equal(h.setProxyCalls.length, 1, '合并为一次落盘');
    assert.deepEqual(h.setProxyCalls[0], { url: '127.0.0.1:7890', persistOnly: true },
        '草稿通道必须带 persistOnly 且不带 enable（不带 enable 才不会走「应用代理」分支）');
});

test('失焦立即落盘（change 收口）：缩小「敲完立刻关应用」的丢失窗口', () => {
    const h = loadPanels({ settings: {} });
    h.type('#set_proxy_url', 'http://127.0.0.1:7897');
    h.blur('#set_proxy_url');
    assert.equal(h.setProxyCalls.length, 1);
    assert.equal(h.setProxyCalls[0].persistOnly, true);
    h.runTimers();
    assert.equal(h.setProxyCalls.length, 1, 'flush 后定时器已撤，不重复落盘');
});

test('清空输入框不落盘（空草稿不清既有记录）', () => {
    const h = loadPanels({ settings: {} });
    h.type('#set_proxy_url', '');
    h.runTimers();
    h.blur('#set_proxy_url');
    assert.equal(h.setProxyCalls.length, 0, '空值不得下发（否则等于抹掉记录）');
});

test('测试地址也输入即落盘（proxyTestUrl 白名单键，无副作用）', () => {
    const h = loadPanels({ settings: {} });
    h.type('#set_proxy_test_url', 'https://cp.cloudflare.com');
    h.runTimers();
    const hits = h.settingsSets.filter(([k]) => k === 'proxyTestUrl');
    assert.equal(hits.length, 1);
    assert.equal(hits[0][1], 'https://cp.cloudflare.com');
});

test('关闭代理开关：带上当前网址，不再写死空串把记录抹掉（回归：关闭后再打开就没了）', async () => {
    const h = loadPanels({ settings: {} });
    await new Promise((r) => setTimeout(r, 0));   // 先让初始化回填落地（真实时序：回填早于用户操作）
    h.setVal('#set_proxy_url', '127.0.0.1:7890');
    const onChange = h.handler('#set_proxy_enable', 'change');
    assert.ok(onChange, '#set_proxy_enable 应已绑定 change 处理器');
    await onChange.call({ checked: false });
    assert.equal(h.setProxyCalls.length, 1);
    assert.equal(h.setProxyCalls[0].enable, false);
    assert.equal(h.setProxyCalls[0].url, '127.0.0.1:7890', '必须带上当前网址（空串=清空记录）');
    const fields = h.recOf('#proxy_fields');
    assert.deepEqual(fields.toggleArgs.slice(-1), [true], '关闭时表单不收起（记录还要看得见）');
    assert.match(h.toasts[h.toasts.length - 1] || '', /代理已关闭/);
});

test('启用方向只展开表单，不下发（启用仍走「保存代理」+连通性测试）', async () => {
    const h = loadPanels({ settings: {} });
    const onChange = h.handler('#set_proxy_enable', 'change');
    await onChange.call({ checked: true });
    assert.equal(h.setProxyCalls.length, 0);
});

test('异步回填不覆盖用户已输入内容（settingsGet 慢于用户敲键）', () => {
    const h = loadPanels({});                       // settings 由用例控制 resolve
    h.type('#set_proxy_url', 'http://new:9999');    // 用户先输入（置 dirty）
    h.resolveSettings({ proxyUrl: 'http://old:1111', proxyEnable: true, proxyTestUrl: 'https://t' });
    return new Promise((r) => setTimeout(r, 0)).then(() => {
        assert.equal(h.getVal('#set_proxy_url'), 'http://new:9999', '用户输入优先于异步快照');
        assert.notEqual(h.ctx.window.yuki, null);
    });
});

test('空框时回填持久化地址（关闭应用再打开的可见性）', async () => {
    const h = loadPanels({ settings: { proxyUrl: 'http://127.0.0.1:7897', proxyEnable: false } });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(h.fillError(), '', '回填链不得有异常（异常会被 .catch 吞掉，表现为「值没回填」）');
    assert.equal(h.getVal('#set_proxy_url'), 'http://127.0.0.1:7897', '重启后应看到上次的网址');
    // 关闭态但有记录：表单必须展开，否则记录被折叠在开关后面，用户仍然「看不到上次的记录」
    const fields = h.recOf('#proxy_fields');
    assert.deepEqual(fields.toggleArgs.slice(-1), [true], '未启用但有记录 => 表单展开');
    // 回填后提示行应解释「环回地址已放行」（放行但告知的取舍）
    const hint = h.recOf('#set_proxy_hint');
    assert.ok(hint, '#set_proxy_hint 应被写入');
    assert.match(hint.text[hint.text.length - 1] || '', /环回\/私网/);
    assert.equal(hint.prop.hidden, false, '提示行必须显式揭掉 hidden');
});

test('回填含凭据地址：提示但不拒绝（按既有习惯放行，凭据风险交 UI 说明）', async () => {
    const h = loadPanels({ settings: { proxyUrl: 'http://u:p@proxy.test:8080' } });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(h.fillError(), '');
    const hint = h.recOf('#set_proxy_hint');
    assert.match(hint.text[hint.text.length - 1] || '', /用户名\/密码/);
});

test('提示行：输入中不报「无效」（防抖不打扰），失焦才给无效原因', () => {
    const h = loadPanels({ settings: {} });
    h.type('#set_proxy_url', 'ftp://x:1');           // input：只给正向提示
    const hint = h.recOf('#set_proxy_hint');
    assert.equal(hint.text[hint.text.length - 1] || '', '', '输入过程不弹无效');
    h.blur('#set_proxy_url');
    assert.match(hint.text[hint.text.length - 1] || '', /地址无效/);
    assert.equal(hint.prop.hidden, false);
});

test('测试代理：非法地址本地短路（不发 IPC，给可读原因）', async () => {
    const h = loadPanels({ settings: {} });
    const click = h.handler('#set_proxy_test', 'click');
    h.setVal('#set_proxy_url', 'ftp://x:1');
    await click.call({});
    assert.equal(h.testProxyCalls.length, 0, '非法地址不得发起连通性测试');
    assert.match(h.toasts[h.toasts.length - 1] || '', /地址无效/);
});

test('测试代理：合法地址照常走 yuki.testProxy（既有连通性测试能力不回归）', async () => {
    const h = loadPanels({ settings: {} });
    const click = h.handler('#set_proxy_test', 'click');
    h.type('#set_proxy_url', '127.0.0.1:7890');
    h.setVal('#set_proxy_test_url', 'https://cp.cloudflare.com');
    await click.call({});
    assert.equal(h.testProxyCalls.length, 1);
    assert.equal(h.testProxyCalls[0].proxyUrl, '127.0.0.1:7890');
    assert.equal(h.testProxyCalls[0].url, 'https://cp.cloudflare.com');
    // 点测试即确认要用的地址：草稿立即落盘
    assert.equal(h.setProxyCalls.filter((c) => c.persistOnly).length, 1);
});

test('保存代理：启用态先本地格式校验，非法不发连通性测试', async () => {
    const h = loadPanels({ settings: {} });
    const click = h.handler('#set_proxy_save', 'click');
    h.setVal('#set_proxy_url', 'http://127.0.0.1');   // 缺端口
    h.recOf('#set_proxy_enable').prop.checked = true;
    await click.call({});
    assert.equal(h.testProxyCalls.length, 0);
    assert.equal(h.setProxyCalls.length, 0);
    assert.match(h.toasts[h.toasts.length - 1] || '', /地址无效/);
});

test('保存代理：连通性测试失败不启用（既有门保持）', async () => {
    const h = loadPanels({ settings: {}, testProxy: () => ({ ok: false, reason: 'ECONNREFUSED' }) });
    const click = h.handler('#set_proxy_save', 'click');
    h.setVal('#set_proxy_url', '127.0.0.1:7890');
    h.recOf('#set_proxy_enable').prop.checked = true;
    await click.call({});
    assert.equal(h.testProxyCalls.length, 1);
    assert.equal(h.setProxyCalls.length, 0, '测试失败不得下发 setProxy');
    const res = h.recOf('#set_proxy_test_result');
    assert.match(res.text[res.text.length - 1] || '', /启用失败/);
});

test('保存代理：未启用时只记地址（文案与语义一致，不再报「已应用」）', async () => {
    const h = loadPanels({ settings: {} });
    const click = h.handler('#set_proxy_save', 'click');
    h.setVal('#set_proxy_url', '127.0.0.1:7890');
    h.recOf('#set_proxy_enable').prop.checked = false;
    await click.call({});
    assert.equal(h.testProxyCalls.length, 0, '未启用不做连通性测试（既有语义）');
    assert.deepEqual(h.setProxyCalls[0], { url: '127.0.0.1:7890', enable: false });
    assert.match(h.toasts[h.toasts.length - 1] || '', /已保存（代理未启用）/);
});

// ==================================================================
// B. 主进程：vm 加载 index.js，直接调 handler（不启动 Electron 应用本体）
// ==================================================================

/** electron 桩：收集 handle 注册，记录 session.setProxy 调用。 */
function makeElectronStub(tmpRoot, rec) {
    const handlers = new Map();
    const app = {
        isPackaged: false,
        whenReady: () => Promise.resolve(),
        on: () => {},
        getPath: (name) => (name === 'userData' ? path.join(tmpRoot, 'userData') : path.join(tmpRoot, String(name || 'misc'))),
        quit: () => {}, exit: () => {}, relaunch: () => {},
        getVersion: () => '0.0.0-test', getAppPath: () => ROOT,
        requestSingleInstanceLock: () => true,
    };
    const webContents = { send: () => {}, on: () => {}, setWindowOpenHandler: () => {} };
    const BrowserWindow = class {
        constructor() { this.webContents = webContents; }
        on() { return this; }
        setMenuBarVisibility() { } loadFile() { } isDestroyed() { return false; }
        isMinimized() { return false; } restore() { } show() { } focus() { } hide() { }
        minimize() { } maximize() { } unmaximize() { } isMaximized() { return false; } close() { }
    };
    BrowserWindow.getAllWindows = () => [];
    const electron = {
        app, BrowserWindow,
        ipcMain: { handle: (ch, fn) => { handlers.set(ch, fn); }, on: () => {} },
        dialog: {
            showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
            showMessageBox: async () => ({ response: 1 }), showMessageBoxSync: () => 1,
        },
        Notification: class { constructor() { } show() { } },
        nativeImage: { createEmpty: () => ({ isEmpty: () => true, addRepresentation() { }, resize() { return this; }, createFromPath: () => ({}) }) },
        Tray: class { constructor() { } setToolTip() { } setContextMenu() { } on() { } },
        Menu: { buildFromTemplate: () => ({}) },
        session: { defaultSession: { setProxy: async (o) => { rec.sessionProxies.push({ ...o }); } }, fromPartition: () => ({ getCacheSize: async () => 0, clearCache: async () => {} }) },
        shell: { openPath: async () => '', openExternal: async () => {} },
    };
    return { electron, handlers };
}

/** vm 加载 index.js（electron / 有副作用服务模块全部换桩），返回 handlers 与观测点。 */
function loadMainIndex(tmpRoot) {
    const rec = { bridgeStarts: 0, bridgeStops: 0, sessionProxies: [] };
    const stub = makeElectronStub(tmpRoot, rec);
    const timerFence = { timers: new Set(), setTimeout: (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); timerFence.timers.add(t); return t; }, setInterval: (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); timerFence.timers.add(t); return t; }, clear: () => { for (const t of timerFence.timers) { try { clearTimeout(t); } catch (e) { } try { clearInterval(t); } catch (e) { } } timerFence.timers.clear(); } };
    // process 桩：env 用克隆（handler 真写 env 不污染宿主），并暴露给用例断言
    const processStub = {
        platform: process.platform, arch: process.arch, versions: process.versions,
        resourcesPath: process.resourcesPath, cwd: process.cwd.bind(process),
        nextTick: process.nextTick.bind(process), hrtime: process.hrtime && process.hrtime.bind(process),
        env: Object.assign({}, process.env),
        on() { }, once() { }, off() { }, removeListener() { }, removeAllListeners() { },
        exit(code) { throw new Error(`[test] 不应调用 process.exit(${code})`); },
        kill() { }, abort() { },
        stdout: process.stdout, stderr: process.stderr, stdin: process.stdin,
        pid: process.pid, ppid: process.ppid, argv: process.argv,
        execPath: process.execPath, execArgv: process.execArgv,
    };
    const sandbox = {
        console: { log() { }, warn() { }, error() { }, info() { }, debug() { } },
        setTimeout: timerFence.setTimeout, clearTimeout,
        setInterval: timerFence.setInterval, clearInterval, setImmediate,
        queueMicrotask, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
        Buffer, process: processStub, structuredClone, Reflect, Proxy, Symbol, Error, TypeError, RangeError,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.createContext(sandbox);

    const hostModule = require('module');
    const resolved = require.resolve(MAIN_INDEX);
    const newModule = new hostModule(resolved, null);
    newModule.paths = hostModule._nodeModulePaths(path.dirname(resolved));
    newModule.filename = resolved;
    sandbox.require = (name) => (name === 'electron' ? stub.electron : newModule.require(name));
    sandbox.__filename = resolved;
    sandbox.__dirname = path.dirname(resolved);
    const serviceStubs = {
        './python-bridge': class {
            constructor() { this._env = {}; }
            on() { }
            get extraEnv() { return this._env; }
            set extraEnv(v) { this._env = v || {}; }
            start() { rec.bridgeStarts += 1; }
            stop() { rec.bridgeStops += 1; }
            getInfo() { return {}; }
            async cancelRuntime() { return { ok: true }; }
        },
        './push-server': class { constructor() { } on() { } start() { return Promise.resolve(0); } stop() { } info() { return { ip: '127.0.0.1', port: 0, token: 'stub' }; } },
        './logger': {
            RotatingLogWriter: class { constructor() { } write() { } resetSize() { } },
            installConsoleLogger: () => ({ write() { } }),
            readRecentLogs: () => ({ ok: true, logs: [], total: 0 }),
            clearLogs: () => ({ ok: true }),
            setLogLevel: () => { }, getLogLevel: () => 'INFO',
            startScheduledLogCleanup: () => { }, stopScheduledLogCleanup: () => { },
        },
        './downloader': class { constructor() { this.concurrency = 3; this.split = 5; this.dir = ''; } isAvailable() { return false; } async setConcurrency(n) { return n | 0; } async setSplit(n) { return n | 0; } stop() { } on() { } },
        './mpv-player': class {
            constructor() { this.binary = ''; this.playing = false; }
            isAvailable() { return false; } stop() { } command() { return Promise.resolve(); } on() { }
            getTimePos() { return null; } setPause() { return Promise.resolve(); } resetBinary() { }
            setCustomPath() { return false; } loadDanmakuBatch() { return 0; }
        },
        // 启动后台会调 ensureFfmpeg()（lock 里有真实下载 URL）——桩掉，保证本文件零网络依赖
        './ffmpeg': { ensureFfmpeg: () => Promise.resolve(false), isEnsuring: () => false, thumb: () => null, urlThumb: () => null },
        './syncplay-client': class { constructor() { this.connected = false; } on() { } connect() { return Promise.reject(new Error('stub')); } disconnect() { } sendState() { } sendFile() { } sendChat() { } },
        './dlna-caster': class { constructor() { } on() { } search() { return Promise.reject(new Error('stub')); } cast() { return Promise.reject(new Error('stub')); } stop() { return Promise.resolve(); } },
        './parse-window': class { constructor() { } async resolve() { return { ok: false, reason: 'stub' }; } async captureDirect() { return { ok: false, reason: 'stub' }; } async captchaVerify() { return { ok: true }; } },
        './pan-qr-window': { openLoginWindow: async () => ({ ok: false }), closeLoginWindow: () => { } },
        './updater': { setupAutoUpdater: () => ({ enabled: false }), createUpdaterController: () => ({}) },
        './misans': { ensureMisans: () => Promise.resolve(true), fontCssUrls: () => [], readyCssPaths: () => [] },
        './app-icon': { windowIcon: () => undefined },
    };
    const preset = (request, exportsValue) => {
        const key = hostModule._resolveFilename(request, newModule);
        const m = new hostModule(key, null);
        m.exports = exportsValue;
        m.loaded = true;
        hostModule._cache[key] = m;
        return key;
    };
    const stubKeys = [preset('electron', stub.electron)];
    for (const [req, impl] of Object.entries(serviceStubs)) stubKeys.push(preset(req, impl));
    try {
        vm.runInContext(read(MAIN_INDEX), sandbox, { filename: 'index.js', breakOnSigint: false });
        newModule.loaded = true;
    } finally {
        for (const key of stubKeys) {
            const existing = hostModule._cache[key];
            if (existing && stubKeys.includes(key)) delete hostModule._cache[key];
        }
    }
    return { sandbox, handlers: stub.handlers, rec, timerFence };
}

async function bootEnv() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-proxyp-'));
    fs.mkdirSync(path.join(tmpRoot, 'userData', 'downloads'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'downloads'), { recursive: true });
    const loaded = loadMainIndex(tmpRoot);
    await new Promise((r) => setImmediate(r));   // app.whenReady().then 注册 handler 需一个微任务轮
    const settingsFile = path.join(tmpRoot, 'userData', 'settings.json');
    return {
        tmpRoot, settingsFile,
        process: loaded.sandbox.process, rec: loaded.rec,
        // 基线快照：启动流程本身会 start 一次后端、注入一次 NO_PROXY（proxyEnable 非 true），
        // 故所有「零副作用」断言都用「前后差值」而不是绝对值
        base: {
            bridgeStarts: loaded.rec.bridgeStarts,
            bridgeStops: loaded.rec.bridgeStops,
            sessionProxies: loaded.rec.sessionProxies.length,
            env: { ...loaded.sandbox.process.env },
        },
        setProxy: loaded.handlers.get('yuki:set-proxy'),
        readSettings: () => {
            try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { return {}; }
        },
        dispose: () => { loaded.timerFence.clear(); fs.rmSync(tmpRoot, { recursive: true, force: true }); },
    };
}

test('主进程：填了地址但没点保存（草稿通道）也落盘，且不重启后端/不注入 env/不动 session', async () => {
    const env = await bootEnv();
    try {
        // 启动逻辑（proxyEnable 非 true 分支）本就会注入 NO_PROXY='*' 并 start 一次后端，
        // 故用「前后快照比对」断言草稿通道零副作用，而不是断言某个键为空
        const r = await env.setProxy(null, { url: '127.0.0.1:7890', persistOnly: true });
        assert.equal(r.ok, true);
        assert.equal(r.persisted, true);
        assert.equal(env.readSettings().proxyUrl, '127.0.0.1:7890', '草稿必须写进 settings.json');
        assert.equal(env.readSettings().proxyEnable, undefined, '草稿不得开启代理');
        assert.deepEqual({ ...env.process.env }, env.base.env, '草稿不得改动任何代理环境变量');
        assert.equal(env.rec.sessionProxies.length, env.base.sessionProxies, '草稿不得改 session 代理');
        assert.equal(env.rec.bridgeStarts, env.base.bridgeStarts, '草稿不得重启后端（每次敲键重启会打断播放/下载）');
    } finally { env.dispose(); }
});

test('主进程：关闭开关再打开仍能看到网址（关闭不再把 proxyUrl 写空）', async () => {
    const env = await bootEnv();
    try {
        await env.setProxy(null, { url: 'http://127.0.0.1:7890', enable: true });
        assert.equal(env.readSettings().proxyUrl, 'http://127.0.0.1:7890');
        // 关闭：带当前网址（渲染层新行为）
        const off = await env.setProxy(null, { url: 'http://127.0.0.1:7890', enable: false });
        assert.equal(off.ok, true);
        assert.equal(env.readSettings().proxyEnable, false);
        assert.equal(env.readSettings().proxyUrl, 'http://127.0.0.1:7890', '关闭后记录必须保留');
        // 关闭：不带网址（旧渲染层/其它调用方）也不得抹掉记录
        const off2 = await env.setProxy(null, { url: '', enable: false });
        assert.equal(off2.ok, true);
        assert.equal(env.readSettings().proxyUrl, 'http://127.0.0.1:7890', '空值=不改动记录');
        // 关闭态下改地址（保存未启用）：记录更新且不应用
        await env.setProxy(null, { url: 'http://127.0.0.1:7891', enable: false });
        assert.equal(env.readSettings().proxyUrl, 'http://127.0.0.1:7891');
        assert.equal(env.process.env.HTTP_PROXY, env.base.env.HTTP_PROXY, '未启用不得注入代理 env');
    } finally { env.dispose(); }
});

test('主进程：代理启用态下草稿被忽略（半截地址不得落盘成为下次启动的生效值）', async () => {
    const env = await bootEnv();
    try {
        await env.setProxy(null, { url: 'http://127.0.0.1:7890', enable: true });
        const r = await env.setProxy(null, { url: '127.0.0.1:78', persistOnly: true });
        assert.equal(r.persisted, false);
        assert.equal(env.readSettings().proxyUrl, 'http://127.0.0.1:7890', '生效态记录不被草稿覆盖');
    } finally { env.dispose(); }
});

test('主进程：启用语义保持（env 注入 + 清 NO_PROXY + session 规则 + 重启后端）', async () => {
    const env = await bootEnv();
    try {
        const off = await env.setProxy(null, { url: '', enable: false });
        assert.equal(off.ok, true);
        assert.equal(env.process.env.NO_PROXY, '*', '关闭分支注入强制直连信号（v0.3.1 行为）');
        assert.equal(env.process.env.no_proxy, '*');
        assert.deepEqual(env.rec.sessionProxies[env.rec.sessionProxies.length - 1], { mode: 'system' });
        const on = await env.setProxy(null, { url: '127.0.0.1:7890', enable: true });
        assert.equal(on.ok, true);
        assert.equal(env.process.env.HTTP_PROXY, 'http://127.0.0.1:7890');
        assert.equal(env.process.env.HTTPS_PROXY, 'http://127.0.0.1:7890');
        assert.equal(env.process.env.NO_PROXY, undefined, '再启用必须清除 NO_PROXY 残留');
        assert.equal(env.process.env.no_proxy, undefined);
        assert.deepEqual(env.rec.sessionProxies[env.rec.sessionProxies.length - 1], { proxyRules: 'http://127.0.0.1:7890' });
        assert.ok(env.rec.bridgeStarts >= 2 && env.rec.bridgeStops >= 2, '每次应用都应重启后端使 requests 生效');
    } finally { env.dispose(); }
});

test('主进程：socks5 走系统代理分支（Electron 不支持 socks 直设，既有行为）', async () => {
    const env = await bootEnv();
    try {
        await env.setProxy(null, { url: 'socks5://127.0.0.1:1080', enable: true });
        assert.equal(env.process.env.HTTP_PROXY, 'socks5://127.0.0.1:1080');
        assert.deepEqual(env.rec.sessionProxies[env.rec.sessionProxies.length - 1], { mode: 'system' });
    } finally { env.dispose(); }
});

test('主进程：非法地址启用被拒且零副作用（scheme/格式/换行/超长/端口越界）', async () => {
    const env = await bootEnv();
    try {
        for (const bad of ['ftp://127.0.0.1:7890', 'file:///etc/passwd', 'javascript:alert(1)',
            'http://127.0.0.1', '127.0.0.1:0', '127.0.0.1:65536', 'http://127.0.0.1:7890\nx',
            'x'.repeat(600)]) {
            const r = await env.setProxy(null, { url: bad, enable: true });
            assert.equal(r.ok, false, `${JSON.stringify(bad.slice(0, 40))} 应被拒`);
            assert.equal(typeof r.reason, 'string');
        }
        assert.equal(env.process.env.HTTP_PROXY, env.base.env.HTTP_PROXY, '被拒的地址不得注入 env');
        assert.equal(env.rec.sessionProxies.length, env.base.sessionProxies);
        assert.equal(env.rec.bridgeStarts, env.base.bridgeStarts, '被拒不得重启后端');
        assert.equal(env.readSettings().proxyEnable, undefined, '被拒不得落盘 proxyEnable');
        assert.equal(env.readSettings().proxyUrl, undefined);
    } finally { env.dispose(); }
});

test('主进程：控制字符/超长草稿被清洗后落盘（不把换行写进设置与日志）', async () => {
    const env = await bootEnv();
    try {
        await env.setProxy(null, { url: '127.0.0.1:789\r\n', persistOnly: true });
        assert.equal(env.readSettings().proxyUrl, '127.0.0.1:789', '控制字符剔除');
        await env.setProxy(null, { url: `${'y'.repeat(600)}`, persistOnly: true });
        assert.equal(env.readSettings().proxyUrl.length, 512, '超长截断');
    } finally { env.dispose(); }
});

test('主进程：preload 契约面未被污染（setProxy 仍单参透传 opts）', () => {
    const preload = read(path.join(ROOT, 'src/preload/preload.js'));
    assert.match(preload, /setProxy: \(opts\) => ipcRenderer\.invoke\('yuki:set-proxy', opts\)/);
});
