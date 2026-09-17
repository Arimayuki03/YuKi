// 组件测试：parse-window.js 解析池槽位泄漏回归（严重 bug #1）
// 旧实现 _release 在有 waiter 时直接唤醒但不归还槽位：take 是零参闭包，被唤醒后
// 从空池 shift 得 undefined 并自我重新排队——每次「有等待者的释放」永久丢 1 个槽位。
// POOL_SIZE=3，一波 4 并发后 yuki:parse/capture-direct/captchaVerify 全部永久
// pending，须重启应用。修复要求：release 必须先把槽位还回池，再唤醒 waiter。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 泄漏的表现是永久 pending：给被测 Promise 挂 1s 超时哨兵，回归时快速报错而非卡死。 */
function withGuard(promise, label) {
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(
                new Error(`${label}: 1000ms 未完成，解析池槽位泄漏导致永久 pending`)), 1000);
            if (typeof timer.unref === 'function') timer.unref();
        }),
    ]);
}

/** 在 vm 沙箱里装载 parse-window.js（electron/app-icon 全部替身），记录创建的窗口 */
function loadParseWindow() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/main/parse-window.js'), 'utf8');
    const created = [];
    class FakeWindow {
        constructor(opts) {
            this.opts = opts || {};
            this.destroyed = false;
            this.loaded = null;
            this.webContents = {
                session: {
                    cookies: { get: () => Promise.resolve([]) },
                    webRequest: { onBeforeRequest() { }, onBeforeSendHeaders() { } },
                },
                setMaxListeners() { },
                on() { },
                setWindowOpenHandler() { },
                executeJavaScript: () => Promise.resolve([]),
            };
            created.push(this);
        }
        on() { }
        loadURL(u) { this.loaded = u; return Promise.resolve(); }
        destroy() { this.destroyed = true; }
    }
    const context = {
        console, Promise, Set, Map, Number, String, Array, Date, Math, Buffer, URL, URLSearchParams,
        setTimeout, clearTimeout, setInterval, clearInterval,
        AbortController, AbortSignal, fetch: async () => ({ ok: true, json: async () => ({}) }),
        module: { exports: {} },
        require(name) {
            if (name === 'electron') {
                return { BrowserWindow: FakeWindow, shell: { openExternal: () => Promise.resolve() } };
            }
            if (name === './app-icon') return { windowIcon: () => null };
            if (name === './async-session') return {
                AsyncSingleFlight: class { run(_key, factory) { return factory(); } },
            };
            throw new Error(`unexpected dependency: ${name}`);
        },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__ParseWindow = ParseWindow;`, context,
        { filename: 'parse-window.js' });
    return { ParseWindow: context.__ParseWindow, created };
}

test('POOL_SIZE=3 下 4 个任务并发获取：释放唤醒 waiter 时槽位不丢', async () => {
    const { ParseWindow } = loadParseWindow();
    const window = new ParseWindow(() => ({}));

    // 前 3 个直接拿槽，第 4 个进入 waiter 队列
    const acquired = [];
    const pendings = [];
    for (let i = 0; i < 4; i++) pendings.push(window._acquire().then((slot) => acquired.push(slot)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(acquired.length, 3, 'POOL_SIZE=3：前 3 个任务直接拿到槽位');
    assert.equal(window._waiters.length, 1, '第 4 个任务应进入 waiter 队列');

    // 依次释放：第一次即命中「有等待者的释放」路径（泄漏点）
    for (const slot of [...acquired]) window._release(slot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(acquired.length, 4, 'waiter 被唤醒后必须拿到归还的槽位，不能重新排队');

    // waiter 持有的槽位也释放后，池必须回到满 3
    window._release(await pendings[3]);
    assert.equal(window._slots.length, 3, '全部释放后池容量必须恢复满 3（泄漏实现会枯竭）');
    assert.equal(window._waiters.length, 0, '不应有 waiter 残留');
});

test('多轮超载（每轮 6 并发 > 3 槽）交替释放后池容量不枯竭', async () => {
    const { ParseWindow } = loadParseWindow();
    const window = new ParseWindow(() => ({}));
    for (let round = 1; round <= 5; round++) {
        const task = (ms) => window._acquire().then((slot) =>
            new Promise((resolve) => setTimeout(resolve, ms)).then(() => window._release(slot)));
        await withGuard(Promise.all([task(10), task(5), task(15), task(8), task(12), task(6)]),
            `第 ${round} 轮任务`);
        assert.equal(window._slots.length, 3, `第 ${round} 轮结束后池容量必须恢复满 3`);
        assert.equal(window._waiters.length, 0, `第 ${round} 轮结束后不应有 waiter 残留`);
    }
});

test('capture-direct 一波 4 并发（> 3 槽）全部返回且池恢复满槽', async () => {
    const { ParseWindow, created } = loadParseWindow();
    const window = new ParseWindow(() => ({}));
    const urls = [1, 2, 3, 4].map((i) => `https://media.test/page-${i}`);
    const results = await withGuard(Promise.all(
        urls.map((u) => window.captureDirect(u, 30))), 'capture-direct 并发');
    assert.equal(results.length, 4, '4 个捕获都必须返回（此处超时返回 null），不能永久 pending');
    assert.equal(created.length, 4, '4 个任务都应实际开窗（第 4 个等第 1 个释放后开）');
    assert.ok(created.every((win) => win.destroyed), '窗口收尾必须销毁');
    assert.equal(window._slots.length, 3, '全部完成后池容量必须恢复满 3');
    assert.equal(window._waiters.length, 0);
});

test('captchaVerify 一波 4 并发（> 3 槽）全部返回且池恢复满槽', async () => {
    const { ParseWindow, created } = loadParseWindow();
    const window = new ParseWindow(() => ({}));
    const results = await withGuard(Promise.all([1, 2, 3, 4].map((i) =>
        window.captchaVerify(`https://site.test/captcha-${i}`, 20))), 'captchaVerify 并发');
    assert.equal(results.length, 4);
    for (const r of results) assert.equal(r && r.ok, true, '超时应视为验证完成');
    assert.ok(created.every((win) => win.destroyed), '窗口收尾必须销毁');
    assert.equal(window._slots.length, 3, '全部完成后池容量必须恢复满 3');
    assert.equal(window._waiters.length, 0);
});
