/**
 * 白盒单元测试：章节页验证码自动解题 + 源卡「进行验证」自动解题（2026-09-29）。
 *
 * 链路：kazumiChapters 端点返回 {captcha:true, captchaUrl, ocrAvailable} →
 *   kazumi._openSearchItem 检测 → _solveChapterCaptcha:
 *     doAction('kazumiCaptchaSolve') 成功 → 重试 _openSearchItem；
 *     失败 → 回落 _openCaptchaWindow（人工窗口，验证后重试解析）。
 * 源卡：kazumi._handleSourceAction('captcha') → _solveSourceCaptcha:
 *     solve 成功 → _queryPlugin 重查该源；失败 → captchaUrl 在则回落人工窗口。
 *
 * 覆盖：captcha 响应触发 solve、solve 成功重试解析、solve 失败回落人工窗口、
 *       无验证链接提示、非 captcha 空结果不受影响；源卡 solve 成功重查 /
 *       失败回落人工窗口 / 无链接提示 / 识别中占位提示。
 *
 * 注意：kazumi.js 在 vm 沙箱里执行，其内部字面量对象是沙箱 realm 的
 * Object.prototype——assert.deepStrictEqual 校验原型，跨 realm 必失败。
 * 断言沙箱传出的对象时只能逐字段取原始值比较，不能整对象 deepEqual。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function loadKazumiHarness(doActionStub) {
    const source = read('src/renderer/js/kazumi.js');
    const ctx = {
        console, Map, Promise, Date, Math, JSON, String, Array, parseInt, parseFloat,
        setTimeout, clearTimeout, MutationObserver: function () { this.observe = () => {}; },
        $: () => {
            const n = { length: 1, on() { return n; }, off() { return n; }, val() { return ''; },
                text() { return n; }, html() { return n; }, show() { return n; }, hide() { return n; },
                empty() { return n; }, append() { return n; }, prop() { return n; }, toggle() { return n; } };
            return n;
        },
        openDialog: () => {}, closeDialog: () => {},
        escHtml: (s) => String(s),
        warnToast: (m) => { ctx.__toasts.push(String(m)); },
        apiUrl: (u) => u,
        EventSource: function () { this.close = () => {}; },
        window: { yuki: {} },
        doAction: doActionStub,
    };
    ctx.__toasts = [];
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(`${source}\n;globalThis.__testKazumi = Kazumi;`, ctx, { filename: 'kazumi.js' });
    const kazumi = ctx.__testKazumi;
    kazumi._dlgToken = 1; // 桩环境无对话框生命周期，固定 token 使守卫通过
    return { kazumi, ctx };
}

test('章节页验证码：captcha 响应触发自动 solve，成功后重试解析', async () => {
    let chaptersCalls = 0, solvePlugins = [];
    const { kazumi } = loadKazumiHarness((action, kv) => {
        if (action === 'kazumiChapters') {
            chaptersCalls += 1;
            // 第一次返回验证码态，重试后返回正常 roads
            return Promise.resolve(chaptersCalls === 1
                ? { code: 200, captcha: true, roads: [], captchaUrl: 'https://x.com/s?wd=', ocrAvailable: true }
                : { code: 200, roads: [{ name: '线路1', data: ['u1'], identifier: ['第1集'] }] });
        }
        if (action === 'kazumiCaptchaSolve') {
            solvePlugins.push(String(kv.plugin));
            // 后端契约：result 整体嵌套（solve 结果的 code 是 OCR 答案，平铺会覆盖
            // 信封 code==200），见 server.py kazumiCaptchaSolve 分支
            return Promise.resolve({ code: 200, result: { ok: true, code: '1234', attempts: 1 } });
        }
        return Promise.resolve({});
    });
    // 渲染剧集桩：记录调用
    let rendered = false;
    kazumi._renderChapterRoads = () => { rendered = true; };
    await kazumi._openSearchItem('p1', 'src1', '名词', 1);
    assert.deepEqual(solvePlugins, ['p1'], 'solve 应带 plugin');
    assert.equal(chaptersCalls, 2, 'solve 成功后应重试解析');
    assert.ok(rendered, '重试成功应渲染剧集');
});

test('章节页验证码：solve 失败回落人工验证窗口（验证后重试解析）', async () => {
    let chaptersCalls = 0, windowCalls = [];
    const { kazumi } = loadKazumiHarness((action) => {
        if (action === 'kazumiChapters') {
            chaptersCalls += 1;
            return Promise.resolve({ code: 200, captcha: true, roads: [], captchaUrl: 'https://x.com/s?wd=' });
        }
        if (action === 'kazumiCaptchaSolve') return Promise.resolve({ ok: false, reason: 'max_attempts' });
        return Promise.resolve({});
    });
    // 桩只记录打开动作，不触发 onDone：真实 onDone 会重试解析，而桩的 chapters
    // 恒返 captcha 态 → 「重试→solve→回落」无限循环，测试进程挂死
    kazumi._openCaptchaWindow = (url) => { windowCalls.push(String(url)); };
    await kazumi._openSearchItem('p1', 'src1', '名词', 1);
    assert.equal(chaptersCalls, 2, 'solve 失败后应重取验证链接（一次解析 + 一次回链接）');
    assert.deepEqual(windowCalls, ['https://x.com/s?wd='], '失败应打开人工验证窗口');
});

test('章节页验证码：无 captchaUrl 时提示不消失', async () => {
    let windowOpened = false;
    const { kazumi, ctx } = loadKazumiHarness((action) => {
        if (action === 'kazumiChapters') return Promise.resolve({ code: 200, captcha: true, roads: [] });
        if (action === 'kazumiCaptchaSolve') return Promise.resolve({ ok: false });
        return Promise.resolve({});
    });
    kazumi._openCaptchaWindow = () => { windowOpened = true; };
    let back = false;
    kazumi._backToSources = () => { back = true; };
    await kazumi._openSearchItem('p1', 'src1', '名词', 1);
    assert.ok(back, '应回选源列表');
    assert.ok(!windowOpened, '无验证链接不开人工窗口');
    assert.ok(ctx.__toasts.some((t) => t.includes('暂无自动识别能力')), '应有提示');
});

test('章节页非 captcha 空结果：不受影响（回选源 + 原提示）', async () => {
    let back = false;
    const { kazumi, ctx } = loadKazumiHarness(() => Promise.resolve({ code: 200, roads: [] }));
    kazumi._backToSources = () => { back = true; };
    await kazumi._openSearchItem('p1', 'src1', '名词', 1);
    assert.ok(back, '空结果仍回选源');
    assert.ok(ctx.__toasts.some((t) => t.includes('未解析到剧集线路')), '保留原提示');
});

// ---------------------------------------------------------------- 源卡「进行验证」

// 桩环境 $ 缺 filter/replaceWith，真实 _renderSourceCard 不可用；与既有用例
// 桩 _renderChapterRoads 同风格，桩掉渲染与重查，仅断言状态机。
function loadSourceSheetHarness(doActionStub, extra = {}) {
    const { kazumi, ctx } = loadKazumiHarness(doActionStub);
    kazumi._renderSourceCard = () => {};
    kazumi._queryPlugin = async () => {};
    kazumi._dlgState = {
        token: 1, keyword: '测试词', expanded: 'p1',
        plugins: Object.assign(Object.create(null), {
            p1: { status: 'captcha', results: [], captchaUrl: 'https://x.com/verify', msg: '', searching: false },
        }),
    };
    Object.assign(kazumi, extra);
    return { kazumi, ctx };
}

test('源卡进行验证：solve 成功后直接重查该源', async () => {
    let solvePlugin = '', queried = null;
    const { kazumi } = loadSourceSheetHarness((action, kv) => {
        if (action === 'kazumiCaptchaSolve') { solvePlugin = String(kv.plugin); return Promise.resolve({ code: 200, result: { ok: true, code: '1234', attempts: 1 } }); }
        return Promise.resolve({});
    }, {
        _queryPlugin: async (kw, name, token) => { queried = { kw, name, token }; },
    });
    await kazumi._handleSourceAction('captcha', 'p1', 1);
    assert.equal(solvePlugin, 'p1', 'solve 应带 plugin');
    assert.deepEqual(queried, { kw: '测试词', name: 'p1', token: 1 }, '成功后应重查该源');
    assert.equal(kazumi._dlgState.plugins.p1.searching, false, '重查前应解除识别中占位');
    assert.equal(kazumi._dlgState.plugins.p1.solveHint, '', '占位提示应清空');
});

test('源卡进行验证：solve 失败且 captchaUrl 在 → 回落人工验证窗口', async () => {
    let windowCalls = [], queried = null;
    const { kazumi } = loadSourceSheetHarness((action) => {
        if (action === 'kazumiCaptchaSolve') return Promise.resolve({ ok: false, reason: 'max_attempts' });
        return Promise.resolve({});
    }, {
        _openCaptchaWindow: function (url, onDone) { windowCalls.push(String(url)); onDone && onDone(); },
        _queryPlugin: async (kw, name, token) => { queried = { kw, name, token }; },
    });
    await kazumi._handleSourceAction('captcha', 'p1', 1);
    assert.deepEqual(windowCalls, ['https://x.com/verify'], '失败应打开人工验证窗口');
    assert.deepEqual(queried, { kw: '测试词', name: 'p1', token: 1 }, '人工验证完成后应重查');
});

test('源卡进行验证：solve 失败且无 captchaUrl → 提示不开窗口', async () => {
    let windowOpened = false, queried = false;
    const { kazumi, ctx } = loadSourceSheetHarness((action) => {
        if (action === 'kazumiCaptchaSolve') return Promise.resolve({ ok: false });
        return Promise.resolve({});
    }, {
        _openCaptchaWindow: () => { windowOpened = true; },
        _queryPlugin: async () => { queried = true; },
    });
    kazumi._dlgState.plugins.p1.captchaUrl = '';
    await kazumi._handleSourceAction('captcha', 'p1', 1);
    assert.ok(!windowOpened, '无验证链接不开人工窗口');
    assert.ok(!queried, '未验证成功不重查');
    assert.ok(ctx.__toasts.some((t) => t.includes('暂无验证链接')), '应有提示');
});

test('源卡进行验证：solve 请求异常按失败口径走人工回落', async () => {
    let windowCalls = [];
    const { kazumi } = loadSourceSheetHarness((action) => {
        if (action === 'kazumiCaptchaSolve') return Promise.reject(new Error('timeout'));
        return Promise.resolve({});
    }, {
        _openCaptchaWindow: function (url, onDone) { windowCalls.push(String(url)); onDone && onDone(); },
    });
    await kazumi._handleSourceAction('captcha', 'p1', 1);
    assert.deepEqual(windowCalls, ['https://x.com/verify'], '异常仍应回落人工窗口');
    assert.equal(kazumi._dlgState.plugins.p1.searching, false, '异常路径应解除占位');
    assert.equal(kazumi._dlgState.plugins.p1.solveHint, '', '异常路径应清空占位提示');
});

test('源卡进行验证：识别中置 searching 占位并清 solveHint', async () => {
    const { kazumi } = loadSourceSheetHarness(() => new Promise((resolve) => {
        const p = kazumi._dlgState.plugins.p1;
        assert.ok(p.searching, '识别中应置 searching 占位');
        assert.equal(p.solveHint, '正在自动识别验证码…', '应有占位提示文案');
        // 嵌套契约：solved = !!(rsp && rsp.result && rsp.result.ok)，平铺 ok 不被识别
        setTimeout(() => resolve({ code: 200, result: { ok: true, code: '1234', attempts: 1 } }), 5);
    }));
    await kazumi._handleSourceAction('captcha', 'p1', 1);
    assert.equal(kazumi._dlgState.plugins.p1.solveHint, '', '结束后占位提示应清空');
});
