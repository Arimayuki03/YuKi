'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

function loadParseWindow(fetchImpl = async () => ({ json: async () => ({}) })) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/main/parse-window.js'), 'utf8');
    const context = {
        console, Promise, Set, Map, Number, String, Array, Date, Math,
        setTimeout, clearTimeout, setInterval, clearInterval,
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

test('type=4 parsers run concurrently but return the configured priority', async () => {
    const ParseWindow = loadParseWindow();
    const window = new ParseWindow(() => ({}));
    const calls = [];
    window._tryParser = async (parser) => {
        calls.push(parser.name);
        await new Promise((resolve) => setTimeout(resolve, parser.delay || 0));
        return parser.ok ? { ok: true, url: `https://cdn.test/${parser.name}.m3u8` } : null;
    };
    const result = await window.resolve('https://site.test/episode', [
        { name: 'slow-high', type: 4, url: 'https://jx.test/a?url=', priority: 1, delay: 20, ok: true },
        { name: 'fast-low', type: 4, url: 'https://jx.test/b?url=', priority: 10, delay: 0, ok: true },
    ]);
    assert.equal(result.url, 'https://cdn.test/slow-high.m3u8');
    assert.deepEqual(calls.sort(), ['fast-low', 'slow-high']);
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
