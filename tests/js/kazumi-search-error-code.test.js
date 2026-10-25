'use strict';
/**
 * Kazumi 源检索失败的**状态码提示**（用户要求：失败原因要有明确状态码）。
 *
 * 后端 server._classify_search_error 已把异常归一成 errCode（HTTP 403 / TIMEOUT /
 * NETWORK / PARSE / NOT_CACHED）；前端负责：
 *   ① 老备份/缓存重放没有 errCode 时按 msg 文本兜底推断（_inferErrCode）；
 *   ② 徽标与卡片正文把码渲染出来 + 一句可操作建议（_errCodeLabel / _errCodeHint）。
 * 本组测试锁这三段的映射口径，避免「后端给了码、前端不显示」。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/renderer/js/kazumi.js'), 'utf8');

/** 极简 jQuery 桩：kazumi.js 顶层只需要 $ 存在即可（本组只测纯方法）。 */
function loadKazumi() {
    const jq = () => {
        const api = {
            length: 0, on() { return api; }, off() { return api; }, html() { return api; },
            text() { return api; }, val() { return ''; }, prop() { return api; },
            addClass() { return api; }, removeClass() { return api; }, toggle() { return api; },
            attr() { return api; }, data() { return ''; }, css() { return api; },
            append() { return api; }, empty() { return api; }, find() { return api; },
            each() { return api; }, trigger() { return api; }, closest() { return api; },
        };
        return api;
    };
    const context = {
        console, Math, Date, JSON, String, Array, Object, Number, Map, Set, RegExp, Promise,
        setTimeout, clearTimeout, setInterval, clearInterval,
        $: jq, jQuery: jq,
        document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
        navigator: {}, location: { href: '' },
        escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        warnToast() {}, showLoading() {}, hideLoading() {}, confirmDialog: async () => true,
        doAction: async () => ({}), apiUrl: (p) => p, EventSource: function () { },
        localCacheGet: () => null, localCacheSet() {}, localCacheDel() {},
        registerEsc() {}, openDialog() {}, closeDialog() {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${SRC}\n;globalThis.__K = Kazumi;`, context, { filename: 'kazumi.js' });
    return context.__K;
}

test('_inferErrCode：旧数据（无 errCode）也能从 msg 文本推断出码', () => {
    const K = loadKazumi();
    assert.equal(K._inferErrCode('403 Client Error: Forbidden for url: https://x/1'), 'HTTP 403');
    assert.equal(K._inferErrCode('HTTP 502 Bad Gateway'), 'HTTP 502');
    assert.equal(K._inferErrCode('HTTPSConnectionPool: Read timed out. (read timeout=10)'), 'TIMEOUT');
    assert.equal(K._inferErrCode('NameResolutionError: failed to resolve'), 'NETWORK');
    assert.equal(K._inferErrCode("'NoneType' object has no attribute 'data'"), 'PARSE');
    assert.equal(K._inferErrCode(''), '');
    assert.equal(K._inferErrCode('某种没见过的错误'), '', '推断不出就留空，不瞎编');
});

test('_errCodeLabel：HTTP 码原样显示，其余给中文短标签', () => {
    const K = loadKazumi();
    assert.equal(K._errCodeLabel('HTTP 403'), 'HTTP 403');
    assert.equal(K._errCodeLabel('TIMEOUT'), '超时');
    assert.equal(K._errCodeLabel('NETWORK'), '网络');
    assert.equal(K._errCodeLabel('PARSE'), '解析失败');
    assert.equal(K._errCodeLabel('NOT_CACHED'), '未缓存');
    assert.equal(K._errCodeLabel(''), '');
});

test('_errCodeHint：给人话建议（403 提示防盗链/风控，404 提示规则失效…）', () => {
    const K = loadKazumi();
    assert.match(K._errCodeHint('HTTP 403'), /防盗链|风控/);
    assert.match(K._errCodeHint('HTTP 404'), /规则/);
    assert.match(K._errCodeHint('HTTP 429'), /限流/);
    assert.match(K._errCodeHint('HTTP 503'), /稍后|换源/);
    assert.match(K._errCodeHint('TIMEOUT'), /超时/);
    assert.match(K._errCodeHint('NETWORK'), /网络/);
    assert.match(K._errCodeHint('PARSE'), /规则/);
    assert.equal(K._errCodeHint(''), '');
});

test('源卡渲染：失败态带状态码胶囊 + 建议 + 原始错误（转义安全）', () => {
    const K = loadKazumi();
    K._dlgState = { token: 1 };
    const html = K._sourceCardHtml('源A', {
        status: 'error', msg: '源站拒绝访问（防盗链或风控）',
        errCode: 'HTTP 403', errRaw: '403 Client Error: <script>alert(1)</script>',
        results: [], hitWord: '',
    }, true);
    assert.match(html, /kazumi-err-code[^>]*>HTTP 403</, '状态码胶囊');
    assert.match(html, /kazumi-err-text[^>]*>该源检索失败：/, '失败说明');
    assert.match(html, /原始错误：/, '原始错误行');
    assert.ok(!/<script>/.test(html), '原始错误必须转义，不能注入标签');
    // 徽标也带码
    const badge = K._statusBadge({ status: 'error', errCode: 'HTTP 403', results: [] });
    assert.match(badge, /检索失败 · HTTP 403/);
    // 无码时退化为朴素文案（不显示空胶囊）
    const plain = K._sourceCardHtml('源B', { status: 'error', msg: '', results: [], hitWord: '' }, true);
    assert.ok(!plain.includes('kazumi-err-code'), '没有码就不渲染空胶囊');
});
