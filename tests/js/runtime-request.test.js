'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { randomUUID } = require('crypto');

function loadCommon(fetchImpl) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/common.js'), 'utf8');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, parseInt, parseFloat,
        setTimeout, clearTimeout, URLSearchParams, AbortSignal, AbortController,
        crypto: { randomUUID },
        $: () => ({ on() { return this; } }),
        window: {}, document: {},
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        fetch: fetchImpl,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__doAction = doAction; globalThis.__createId = createRuntimeId;`,
        context, { filename: 'common.js' });
    return context;
}

test('RuntimeRequest 正常：requestId/playSessionId 写入 header 与 /action body', async () => {
    let captured = null;
    const ctx = loadCommon(async (url, options) => {
        captured = { url, options };
        return { text: async () => JSON.stringify({ ok: true }) };
    });
    const result = await ctx.__doAction('playerContent', { site: 'demo' }, null, {
        requestId: 'play-request-0001', playSessionId: 'play-session-0001', timeoutMs: 100,
    });
    const body = new URLSearchParams(captured.options.body);
    assert.equal(captured.options.headers['X-Request-Id'], 'play-request-0001');
    assert.equal(body.get('requestId'), 'play-request-0001');
    assert.equal(body.get('playSessionId'), 'play-session-0001');
    assert.equal(result.ok, true);
});

test('RuntimeRequest 异常：结构化 L3 错误保持对象，不退化成任意字符串', async () => {
    const payload = { requestId: 'play-error-0001', ok: false,
        error: { code: 'L3_RUNTIME_CALL_FAILED', stage: 'runtime', retryable: true } };
    const ctx = loadCommon(async () => ({ text: async () => JSON.stringify(payload) }));
    const result = await ctx.__doAction('playerContent', {}, null, {
        requestId: 'play-error-0001', timeoutMs: 100,
    });
    assert.equal(result.error.code, 'L3_RUNTIME_CALL_FAILED');
    assert.equal(typeof result.error, 'object');
});

function pendingFetch(_url, options) {
    return new Promise((_resolve, reject) => {
        const fail = () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); };
        if (options.signal.aborted) fail();
        else options.signal.addEventListener('abort', fail, { once: true });
    });
}

test('RuntimeRequest 超时：deadline signal 会终止 fetch', async () => {
    const ctx = loadCommon(pendingFetch);
    // Node 20 的 --test 等待用例期间不再持有活跃句柄，事件循环会先于
    // AbortSignal.timeout 的内部定时器耗尽（Node 24 无此问题），用例被误报为
    // cancelled。显式挂一个存活句柄，保证 deadline 定时器有机会触发。
    const keepalive = setTimeout(() => {}, 30_000);
    try {
        await assert.rejects(
            ctx.__doAction('homeContent', {}, null, { timeoutMs: 5 }),
            (error) => error && error.name === 'AbortError');
    } finally {
        clearTimeout(keepalive);
    }
});

test('RuntimeRequest 取消：上一播放动作 AbortController 可立即取消', async () => {
    const ctx = loadCommon(pendingFetch);
    const controller = new AbortController();
    const keepalive = setTimeout(() => {}, 30_000);
    try {
        const pending = ctx.__doAction('playerContent', {}, null, {
            requestId: 'play-cancel-0001', signal: controller.signal, timeoutMs: 1000,
        });
        controller.abort();
        await assert.rejects(pending, (error) => error && error.name === 'AbortError');
    } finally {
        clearTimeout(keepalive);
    }
});
