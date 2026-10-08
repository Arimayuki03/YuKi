/**
 * 设置页「验证码视觉识别 → 测试识别」按钮 白盒单元测试。
 *
 * 覆盖对象（src/renderer/js/panels.js 的 #set_captcha_test 点击处理器）：
 *  - 未启用视觉大模型时：只报内置小模型，且**不带** LLM 凭据发起请求；
 *  - 启用时：按当前表单值（未保存也能测）经 do=kazumiCaptchaProbe 发请求；
 *  - 分级渲染：小模型只报可用性、不判对错；LLM 报连通/识别正确性/错误分类；
 *  - 内置探测图不可用 / 后端不可达：结果行必须给出结论，不得静默；
 *  - 按钮防重复点击：测试期间 disabled，结束恢复。
 *
 * 加载方式同 panels-local.test.js：panels.js 是经典脚本（非 CommonJS），用
 * node:vm 在注入全局桩的上下文里执行 initSettingsPanel()，从 jQuery 桩捕获
 * #set_captcha_test 的 click 处理器后直接触发。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const PANELS_SRC = fs.readFileSync(path.join(ROOT, 'src/renderer/js/panels.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

/**
 * 加载 panels.js 并捕获 #set_captcha_test 的 click 处理器。
 * @param {object} opts { doAction, form: {llmEnable, base, key, model} }
 */
function loadPanels(opts) {
    const o = opts || {};
    const recs = [];            // 每个 $(sel) 的记录
    const form = { llmEnable: false, prefer: false, base: '', key: '', model: '', ...(o.form || {}) };
    const doActions = [];

    /** DOM 元素桩：initSettingsPanel 里有若干 `$(sel)[0].addEventListener(...)` 的
     *  直接元素操作（壁纸调整弹窗等），jq 对象必须可按索引取出元素。 */
    function makeEl(sel) {
        return {
            sel, style: {}, dataset: {}, value: '', checked: false, textContent: '',
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
                    if (k === 'checked') {
                        // 两个验证码开关各按 id 回溯表单值（与 val() 的同源口径）
                        if (sel === '#set_captcha_llm_enable') return form.llmEnable;
                        if (sel === '#set_captcha_llm_prefer') return form.prefer;
                        return rec.prop[k];
                    }
                    return rec.prop[k];
                }
                rec.prop[k] = v; return api;
            },
            val(v) {
                if (v === undefined) {
                    if (sel === '#set_captcha_llm_base') return form.base;
                    if (sel === '#set_captcha_llm_key') return form.key;
                    if (sel === '#set_captcha_llm_model') return form.model;
                    return '';
                }
                return api;
            },
            css(k, v) { rec.css.push([k, v]); return api; },
            attr() { return api; }, removeAttr() { return api; },
            on(ev, fn) { (rec.handlers[ev] = rec.handlers[ev] || []).push(fn); return api; },
            off() { return api; }, toggle() { return api; }, show() { return api; }, hide() { return api; },
            addClass() { return api; }, removeClass() { return api; }, find() { return api; },
            each() { return api; }, filter() { return api; }, data() { return ''; },
            append() { return api; }, appendTo() { return api; }, empty() { return api; },
            scrollTop() { return api; }, remove() { return api; }, focus() { return api; },
            blur() { return api; }, trigger() { return api; }, closest() { return api; },
            parent() { return api; }, children() { return api; }, eq() { return api; },
        };
        api[0] = makeEl(sel);   // $(sel)[0]：取原生元素绑事件的写法
        return api;
    }

    // initSettingsPanel() 会绑定一整套设置控件（更新/日志/播放器/代理…），
    // 触达 window.yuki 上二十余个方法。本用例只关心验证码测试按钮，故用
    // Proxy 自动补桩，避免为每个无关接口写桩（漏一个就 TypeError 打断绑定，
    // 从而拿不到被测处理器）。
    const yukiBase = {
        settingsSet: async () => true,
        settingsGet: async () => ({}),
        settingsReset: async () => ({}),
        onUpdateState: () => { },
        checkForUpdates: async () => ({}),
        appVersion: async () => '0.0.0-test',
        playerConfig: async () => ({ mode: 'builtin', available: true, path: '' }),
        getLogs: async () => [],
        // refreshAssetStatus 会读 status.<key>.ready（真实主进程恒返回各组件对象）。
        // 必须返回完整形状：返回 {} 会让 s.ready 在 undefined 上取值 → 测试结束后的
        // 异步 rejection，与本用例被测逻辑无关却会污染整个文件的结果。
        assetStatus: async () => ({
            ffmpeg: { ready: true }, mpv: { ready: true }, aria2: { ready: false },
            anime4k: { ready: true }, java: { ready: false },
        }),
    };
    const yuki = new Proxy(yukiBase, {
        get(t, k) {
            if (k in t) return t[k];
            return () => Promise.resolve({});   // 未显式桩的 yuki.* 一律 no-op
        },
        has: () => true,
    });
    const ctx = {
        $: jq, jQuery: jq,
        console, setTimeout, clearTimeout, Promise, JSON, Date, Math, String, Number, Object,
        Array, Boolean, RegExp, Error, isNaN, parseInt, parseFloat, encodeURIComponent,
        document: {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => ({ style: {}, classList: { add() { }, remove() { } }, setAttribute() { } }),
            addEventListener() { }, removeEventListener() { }, body: { appendChild() { } },
        },
        window: { yuki, _cfgHistoryCache: undefined, addEventListener() { }, removeEventListener() { } },
        escHtml: (s) => String(s), escPath: (s) => String(s),
        warnToast: () => { }, showLoading: () => { }, hideLoading: () => { },
        openDialog: () => { }, closeDialog: () => { }, confirmDialog: async () => true,
        registerEsc: () => { }, createRuntimeId: (p) => `${p}-test`, fmtSize: (b) => `${b}B`,
        getJson: async () => ({}), localPlayToast: () => { }, toFileUrl: (p) => `file:///${p}`,
        applySkin: () => { }, applyMisansFont: async () => { }, CSS: { escape: (s) => String(s) },
        refreshCacheDirLine: () => { }, refreshDlDirLine: () => { }, updateBlockedLine: () => { },
        doAction: async (action, kv, p, t) => {
            doActions.push({ action, kv, path: p, timeout: t });
            if (o.doAction) return o.doAction({ action, kv, path: p, timeout: t });
            return { code: 200 };
        },
        AdSkip: { clearAllOpEd: () => 0 }, Player: {}, UIState: {}, Home: {}, Live: {},
        Downloads: {}, About: {}, YukiTranslate: {}, apiUrl: (p) => `http://x${p}`,
        replayClass: () => { }, STAGGER_STEP_MS: 0, STAGGER_MAX_IDX: 0,
        AbortSignal: { timeout: () => ({}) },
    };
    ctx.globalThis = ctx;
    ctx.window.document = ctx.document;
    vm.createContext(ctx);
    vm.runInContext(PANELS_SRC + '\n;globalThis.__init = initSettingsPanel;', ctx, { filename: 'panels.js' });
    ctx.__init();
    const rec = recs.find((r) => r.sel === '#set_captcha_test');
    const click = rec && rec.handlers.click && rec.handlers.click[0];
    const resultRec = () => recs.find((r) => r.sel === '#set_captcha_test_result');
    const resultText = () => {
        const r = resultRec();
        return r && r.text.length ? r.text[r.text.length - 1] : '';
    };
    // initSettingsPanel 自身初始化就会发若干 doAction（cacheSize / panCookie 等），
    // 故只按 action 名筛出本按钮发起的探测请求，避免断言被无关请求污染。
    const probeCalls = () => doActions.filter((c) => c.action === 'kazumiCaptchaProbe');
    return { click, doActions, probeCalls, resultText, resultRec, recs, rec };
}

/** 触发点击并等待处理器内所有 await 落地。 */
async function click(handler, btn) {
    await handler.call(btn || { disabled: false }, {});
}

const OK_CNN = { image: true, answer: '4821', cnn: { available: true, ms: 12, text: '1130', note: '分布外' } };

test('设置页存在「测试识别」按钮与结果行', () => {
    assert.match(HTML_SRC, /id="set_captcha_test"/);
    assert.match(HTML_SRC, /id="set_captcha_test_result"/);
    assert.match(HTML_SRC, /id="set_captcha_test_result"\s+hidden/, '结果行初始应为 hidden（显式揭掉）');
});

test('未启用视觉大模型：只测小模型，且不携带任何 LLM 凭据', async () => {
    const h = loadPanels({
        doAction: () => ({ code: 200, result: { ...OK_CNN, llm: { enabled: false } } }),
    });
    assert.ok(h.click, '#set_captcha_test 应已绑定 click 处理器');
    await click(h.click);
    const calls = h.probeCalls();
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.path, '/kazumi/action');
    // 跨 realm（cfg 在 vm 上下文里构造），deepStrictEqual 会因原型不同而失败，
    // 故比对条目而非对象身份
    assert.deepEqual(Object.keys(call.kv), [], '未启用兜底时不得携带凭据');
});

test('启用视觉大模型：按当前表单值（未保存也能测）传凭据', async () => {
    const h = loadPanels({
        form: { llmEnable: true, base: 'https://api.example/v1', key: 'sk-t', model: 'vlm-1' },
        doAction: () => ({ code: 200, result: { ...OK_CNN, llm: { enabled: true, ok: true, ms: 900, correct: true } } }),
    });
    await click(h.click);
    assert.equal(h.probeCalls().length, 1);
    const kv = h.probeCalls()[0].kv;
    assert.equal(kv.captchaLLMBase, 'https://api.example/v1');
    assert.equal(kv.captchaLLMKey, 'sk-t');
    assert.equal(kv.captchaLLMModel, 'vlm-1');
});

test('小模型段只报可用性，不判对错（合成图不在其训练分布内）', async () => {
    // 实测：仓库内权重在合成探测图上整图仅 ~9%（随机基线 10%），若在此判
    // 对错会稳定误报「识别失败」，误导用户以为配置有问题。
    const h = loadPanels({
        doAction: () => ({ code: 200, result: { ...OK_CNN, llm: { enabled: false } } }),
    });
    await click(h.click);
    const text = h.resultText();
    assert.match(text, /内置小模型/, '应报告内置小模型状态');
    assert.doesNotMatch(text, /小模型.*(识别错误|不正确|失败)/);
    assert.match(text, /分布外|不代表/, '应如实说明本图不在小模型训练分布内');
});

test('视觉大模型连通且识别正确', async () => {
    const h = loadPanels({
        form: { llmEnable: true, base: 'https://x/v1', model: 'm' },
        doAction: () => ({ code: 200, result: { ...OK_CNN, llm: { enabled: true, ok: true, ms: 880, correct: true } } }),
    });
    await click(h.click);
    const text = h.resultText();
    assert.match(text, /✓ 视觉大模型 · 880ms · 识别正确/);
    assert.ok(!/⚠/.test(text));
});

test('视觉大模型连通但读错：报⚠而非✗（连通是事实，读错是另一回事）', async () => {
    const h = loadPanels({
        form: { llmEnable: true, base: 'https://x/v1', model: 'm' },
        doAction: () => ({
            code: 200,
            result: { ...OK_CNN, llm: { enabled: true, ok: true, ms: 700, text: '0000', correct: false } },
        }),
    });
    await click(h.click);
    const text = h.resultText();
    assert.match(text, /⚠ 视觉大模型/);
    assert.match(text, /应为「4821」/, '应给出探测图答案供用户比对');
    assert.doesNotMatch(text, /✗ 视觉大模型/, '连通却读错不该报连接失败');
});

test('视觉大模型失败：错误码按分类回显（400=不支持图片输入等）', async () => {
    for (const [err, label] of [['auth', '鉴权失败'], ['rate_limit', '频率受限'],
        ['server', '服务端错误'], ['bad_request', '配置不完整'], ['network', '网络不可达']]) {
        const h = loadPanels({
            form: { llmEnable: true, base: 'https://x/v1', model: 'm' },
            doAction: () => ({ code: 200, result: { ...OK_CNN, llm: { enabled: true, ok: false, err } } }),
        });
        await click(h.click);
        const text = h.resultText();
        assert.match(text, /✗ 视觉大模型/, `err=${err} 应报失败`);
        assert.ok(text.includes(label) || text.includes(err), `err=${err} 应给出可读分类，实得：${text}`);
    }
});

test('「优先使用视觉大模型」开关存在且默认关闭', () => {
    assert.match(HTML_SRC, /id="set_captcha_llm_prefer"/);
    // 默认关闭的落点是回填处严格 === true（缺键/未持久化即关），而非 HTML 的
    // checked 属性——HTML 里不写 checked 只保证首次渲染的初值。
    // 断言回填表达式本身（不依赖引号风格，避免改引号就误报）：选择器后紧跟
    // prop('checked', s.captchaLLMPrefer === true)。
    assert.match(PANELS_SRC, /#set_captcha_llm_prefer["'`]\)?\.prop\(\s*["'`]checked["'`]\s*,\s*s\.captchaLLMPrefer === true/);
});

test('优先开关随测试请求下发：测试跑的就是线上会走的识别次序', async () => {
    // 后端 probe 按 captchaLLMPrefer 决定跑哪一级，前端必须把它带上——
    // 否则开关开了而测试仍按旧次序跑，结果会误导用户。
    const mk = () => ({ code: 200, result: { ...OK_CNN, llm: { enabled: true, ok: true, ms: 900, correct: true } } });
    const on = loadPanels({ form: { llmEnable: true, prefer: true, base: 'https://api.example/v1', model: 'vlm-1' }, doAction: mk });
    await click(on.click);
    assert.equal(on.probeCalls()[0].kv.captchaLLMPrefer, '1');

    const off = loadPanels({ form: { llmEnable: true, prefer: false, base: 'https://api.example/v1', model: 'vlm-1' }, doAction: mk });
    await click(off.click);
    assert.equal(off.probeCalls()[0].kv.captchaLLMPrefer, '0');
});

test('未启用兜底时不下发优先开关（无凭据即无该字段）', async () => {
    const h = loadPanels({
        form: { llmEnable: false, prefer: true },
        doAction: () => ({ code: 200, result: { ...OK_CNN, llm: { enabled: false } } }),
    });
    await click(h.click);
    assert.equal(Object.keys(h.probeCalls()[0].kv).includes('captchaLLMPrefer'), false);
});

test('内置探测图不可用：结果行给出结论而非静默', async () => {
    const h = loadPanels({ doAction: () => ({ code: 200, result: { image: false } }) });
    await click(h.click);
    assert.match(h.resultText(), /✗ 内置测试图不可用/);
});

test('后端不可达：结果行给出结论，不抛出', async () => {
    const h = loadPanels({ doAction: async () => { throw new Error('fetch failed'); } });
    await click(h.click);
    assert.match(h.resultText(), /后端不可达/);
});

test('测试期间禁用按钮，结束后恢复（防重复点击并发请求）', async () => {
    const btn = { disabled: false };
    let during = null;
    const h = loadPanels({
        doAction: async () => {
            during = btn.disabled;
            return { code: 200, result: { ...OK_CNN, llm: { enabled: false } } };
        },
    });
    await click(h.click, btn);
    assert.equal(during, true, '请求在途期间按钮应禁用');
    assert.equal(btn.disabled, false, '结束后必须恢复可用');
});

test('结果行必须显式揭掉 hidden（text/css 不改 display）', async () => {
    const h = loadPanels({ doAction: () => ({ code: 200, result: { ...OK_CNN, llm: { enabled: false } } }) });
    await click(h.click);
    const rec = h.resultRec();
    assert.equal(rec.prop.hidden, false, 'hidden 必须由处理器显式揭掉，否则「点了没反应」');
});
