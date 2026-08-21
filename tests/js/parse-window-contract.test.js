'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

function loadParseWindow(fetchImpl = async () => ({ ok: true, json: async () => ({}) }), timers = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/main/parse-window.js'), 'utf8');
    const context = {
        console, Promise, Set, Map, Number, String, Array, Date, Math, Buffer, URL, URLSearchParams,
        setTimeout: timers.setTimeout || setTimeout,
        clearTimeout: timers.clearTimeout || clearTimeout,
        setInterval: timers.setInterval || setInterval,
        clearInterval: timers.clearInterval || clearInterval,
        AbortController, AbortSignal, fetch: fetchImpl,
        module: { exports: {} },
        require(name) {
            if (name === 'electron') return { BrowserWindow: class {} };
            if (name === './async-session') return {
                AsyncSingleFlight: class {
                    run(_key, factory) { return factory(); }
                },
            };
            throw new Error(`unexpected dependency: ${name}`);
        },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__ParseWindow = ParseWindow;`, context,
        { filename: 'parse-window.js' });
    return context.__ParseWindow;
}

test('type=4 super parser runs eligible type 0/1 concurrently but returns configured priority', async () => {
    const ParseWindow = loadParseWindow();
    const window = new ParseWindow(() => ({}));
    const calls = [];
    window._tryParser = async (parser) => {
        calls.push(parser.name);
        await new Promise((resolve) => setTimeout(resolve, parser.delay || 0));
        return parser.ok ? { ok: true, url: `https://cdn.test/${parser.name}.m3u8` } : null;
    };
    const result = await window.resolve('https://site.test/episode', [
        { name: 'super', type: 4, priority: 0 },
        { name: 'slow-high', type: 1, url: 'https://jx.test/a?url=', priority: 1, delay: 20, ok: true,
            ext: { flag: ['vip'] } },
        { name: 'fast-low', type: 0, url: 'https://jx.test/b?url=', priority: 10, delay: 0, ok: true,
            ext: { flag: ['vip'] } },
    ], false, null, { flag: 'vip' });
    assert.equal(result.url, 'https://cdn.test/slow-high.m3u8');
    assert.deepEqual(calls.sort(), ['fast-low', 'slow-high']);
});

test('flag whitelist is a preference: unlisted flag still tries every parser', async () => {
    const ParseWindow = loadParseWindow();
    const window = new ParseWindow(() => ({}));
    const calls = [];
    window._tryParser = async (parser) => {
        calls.push(parser.name);
        return parser.name === 'vip-only' ? { ok: true, url: 'https://cdn.test/vip-only.m3u8' } : null;
    };
    // 线路 m3u8 没有任何解析器点名，上游 VodConfig.getParses(type, flag) 会退回全部
    // 解析器（filter.isEmpty() ? items : filter），不能直接返回 no-matching-parser。
    const result = await window.resolve('https://site.test/episode', [
        { name: 'vip-only', type: 1, url: 'https://jx.test/a?url=', ext: { flag: ['vip'] } },
    ], false, null, { flag: 'm3u8' });
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://cdn.test/vip-only.m3u8');
    assert.deepEqual(calls, ['vip-only']);
});

test('flag whitelist still wins when a parser declares the current flag', async () => {
    const ParseWindow = loadParseWindow();
    const window = new ParseWindow(() => ({}));
    const calls = [];
    window._tryParser = async (parser) => {
        calls.push(parser.name);
        return { ok: true, url: `https://cdn.test/${parser.name}.m3u8` };
    };
    const result = await window.resolve('https://site.test/episode', [
        { name: 'vip-only', type: 1, url: 'https://jx.test/a?url=', ext: { flag: ['vip'] } },
        { name: 'm3u8-only', type: 1, url: 'https://jx.test/b?url=', ext: { flag: ['m3u8'] } },
    ], false, null, { flag: 'm3u8' });
    assert.equal(result.url, 'https://cdn.test/m3u8-only.m3u8');
    assert.deepEqual(calls, ['m3u8-only']);
});

test('explicit parser priority can put an iframe parser before JSON', async () => {
    const ParseWindow = loadParseWindow();
    const window = new ParseWindow(() => ({}));
    const calls = [];
    window._tryParser = async (parser) => {
        calls.push(parser.name);
        return parser.name === 'preferred' ? { ok: true, url: 'https://cdn.test/preferred.mp4' } : null;
    };
    const result = await window.resolve('https://site.test/episode', [
        { name: 'json-default', type: 1, url: 'https://jx.test/?url=' },
        { name: 'preferred', type: 0, priority: -1, url: 'https://jx2.test/?url=' },
    ]);
    assert.equal(result.url, 'https://cdn.test/preferred.mp4');
    assert.deepEqual(calls, ['preferred']);
});

test('JSON parser cancellation aborts the in-flight request and returns promptly', async () => {
    const fetchImpl = (_url, options = {}) => new Promise((_resolve, reject) => {
        const fail = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
        };
        if (options.signal && options.signal.aborted) fail();
        else if (options.signal) options.signal.addEventListener('abort', fail, { once: true });
    });
    const ParseWindow = loadParseWindow(fetchImpl);
    const window = new ParseWindow(() => ({}));
    const abort = { requested: false };
    const started = Date.now();
    const pending = window._tryJson({ type: 1, url: 'https://jx.test/?url=', name: 'json' },
        'https://site.test/episode', abort);
    setTimeout(() => { abort.requested = true; }, 10);
    const result = await pending;
    assert.equal(result, null);
    assert.ok(Date.now() - started < 1000, '取消不能等待 15 秒 JSON deadline');
});

test('type=0 routes only through BrowserWindow capture with parser headers', async () => {
    const ParseWindow = loadParseWindow();
    const window = new ParseWindow(() => ({}));
    let captured;
    window._capture = async (options) => { captured = options; return { ok: true, url: 'https://cdn.test/a.mp4' }; };
    const result = await window.resolve('https://site.test/episode', [{
        name: 'web', type: 0, url: 'https://jx.test/?url=',
        ext: { header: { Referer: 'https://jx.test/' } },
    }]);
    assert.equal(result.ok, true);
    assert.equal(captured.url, 'https://jx.test/?url=https://site.test/episode');
    assert.equal(captured.headers.Referer, 'https://jx.test/');
});

test('type=1 accepts nested JSON and merges Cookie/Origin/Auth/UA without case duplicates', async () => {
    const ParseWindow = loadParseWindow(async (_url, options) => {
        assert.equal(options.headers.Cookie, 'parser=1');
        return { ok: true, json: async () => ({ data: { result: {
            url: 'https://cdn.test/nested.m3u8',
            headers: { cookie: 'result=2', Origin: 'https://media.test',
                authorization: 'Bearer token', 'user-agent': 'result-agent' },
        } } }) };
    });
    const window = new ParseWindow(() => ({}));
    const result = await window.resolve('https://site.test/episode', [{
        name: 'json', type: 1, url: 'https://jx.test/?url=', header: { Cookie: 'parser=1' },
    }]);
    assert.equal(result.url, 'https://cdn.test/nested.m3u8');
    assert.equal(Object.keys(result.header).filter((key) => key.toLowerCase() === 'cookie').length, 1);
    assert.equal(result.header.cookie, 'result=2');
    assert.equal(result.header.authorization, 'Bearer token');
});

test('type=2 posts Json extension context to portable JAR endpoint', async () => {
    const calls = [];
    const ParseWindow = loadParseWindow(async (url, options) => {
        calls.push({ url, body: String(options.body || '') });
        return { ok: true, json: async () => ({
            url: 'https://cdn.test/ext.mp4', header: { Referer: 'https://ext.test/' },
        }) };
    });
    const window = new ParseWindow(() => ({ base: 'http://127.0.0.1:1234', token: 'local' }));
    const result = await window.resolve('https://site.test/episode', [
        { name: 'ext', type: 2, url: 'Demo', priority: 0 },
        { name: 'json', type: 1, url: 'https://jx.test/?url=', priority: 10,
            ext: { header: { Referer: 'https://jx.test/' } } },
    ], false, null, { site: 'jar-site', requestId: 'req-1', playSessionId: 'play-1' });
    assert.equal(result.url, 'https://cdn.test/ext.mp4');
    assert.match(calls[0].body, /do=parseExt/);
    assert.match(calls[0].body, /site=jar-site/);
    assert.match(calls[0].body, /jxs=/);
});

test('type=2 error returns the next parser result instead of leaving a failed window', async () => {
    const ParseWindow = loadParseWindow(async (url) => {
        if (url.includes('/action')) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ url: 'https://cdn.test/fallback.mp4' }) };
    });
    const window = new ParseWindow(() => ({ base: 'http://127.0.0.1:1234', token: 'local' }));
    const result = await window.resolve('https://site.test/episode', [
        { name: 'ext', type: 2, url: 'Missing', priority: 0 },
        { name: 'json', type: 1, url: 'https://jx.test/?url=', priority: 1 },
    ], false, null, { site: 'jar-site' });
    assert.equal(result.url, 'https://cdn.test/fallback.mp4');
    assert.equal(window._slots.length, 3);
});

test('type=2 timeout aborts the backend request and releases its timer', async () => {
    const fetchImpl = (_url, options = {}) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(
            new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    const shortDeadline = (fn, ms, ...args) => setTimeout(fn, ms === 15000 ? 10 : ms, ...args);
    const ParseWindow = loadParseWindow(fetchImpl, { setTimeout: shortDeadline });
    const window = new ParseWindow(() => ({ base: 'http://127.0.0.1:1234', token: 'local' }));
    const started = Date.now();
    const result = await window._tryJsonExt({ type: 2, url: 'Demo' },
        'https://site.test/episode', [], null, { site: 'jar-site' });
    assert.equal(result, null);
    assert.ok(Date.now() - started < 1000);
});

test('type=2 cancellation aborts the backend request before its deadline', async () => {
    const fetchImpl = (_url, options = {}) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(
            new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    const ParseWindow = loadParseWindow(fetchImpl);
    const window = new ParseWindow(() => ({ base: 'http://127.0.0.1:1234', token: 'local' }));
    const abort = { requested: false };
    const started = Date.now();
    const pending = window._tryJsonExt({ type: 2, url: 'Demo' },
        'https://site.test/episode', [], abort, { site: 'jar-site' });
    setTimeout(() => { abort.requested = true; }, 10);
    const result = await pending;
    assert.equal(result, null);
    assert.ok(Date.now() - started < 1000);
});
