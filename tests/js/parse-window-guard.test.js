// 组件测试：parse-window.js 验证码窗口的协议守卫
// 验证页可控于第三方站点：跳转/新窗若是 intent:// 等非 http(s) scheme，Chromium 会把它
// 移交操作系统弹「用什么应用打开」。守卫必须拦下，http(s) 新窗只转系统浏览器、不在窗内开。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 在 vm 沙箱里装载 parse-window.js（electron/app-icon 全部替身），返回类与调用记录 */
function loadParseWindow(openExternal) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/main/parse-window.js'), 'utf8');
    const created = [];
    const opened = [];
    class FakeWindow {
        constructor(opts) {
            this.opts = opts || {};
            this.destroyed = false;
            this.navHandlers = [];
            this.openHandler = null;
            this.closedHandlers = [];
            this.loaded = null;
            const self = this;
            this.webContents = {
                session: { cookies: { get: () => Promise.resolve([]) } },
                setMaxListeners() { },
                on(ev, cb) { if (ev === 'will-navigate') self.navHandlers.push(cb); },
                setWindowOpenHandler(fn) { self.openHandler = fn; },
            };
            created.push(this);
        }
        on(ev, cb) { if (ev === 'closed') this.closedHandlers.push(cb); }
        loadURL(u) { this.loaded = u; return Promise.resolve(); }
        destroy() { this.destroyed = true; }
    }
    const shell = {
        openExternal(u) {
            opened.push(u);
            return openExternal ? openExternal(u) : Promise.resolve();
        },
    };
    const context = {
        console, Promise, Set, Map, Number, String, Array, Date, Math, Buffer, URL, URLSearchParams,
        setTimeout, clearTimeout, setInterval, clearInterval,
        AbortController, AbortSignal, fetch: async () => ({ ok: true, json: async () => ({}) }),
        module: { exports: {} },
        require(name) {
            if (name === 'electron') return { BrowserWindow: FakeWindow, shell };
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
    return { ParseWindow: context.__ParseWindow, created, opened };
}

/** 跑一次 captchaVerify 到超时自然收尾，返回那个验证码窗口 */
async function openCaptcha(openExternal) {
    const { ParseWindow, created, opened } = loadParseWindow(openExternal);
    const pw = new ParseWindow(() => ({}));
    const res = await pw.captchaVerify('https://site.test/captcha', 10);
    assert.equal(res && res.ok, true, '超时也应视为验证完成并收割 Cookie');
    assert.equal(created.length, 1);
    const win = created[0];
    assert.equal(win.loaded, 'https://site.test/captcha');
    assert.ok(win.destroyed, '收尾必须销毁窗口（否则会话不释放）');
    return { win, opened };
}

test('验证码窗口按槽位隔离且关闭 Node 能力', async () => {
    const { win } = await openCaptcha();
    assert.equal(win.opts.show, true);
    const wp = win.opts.webPreferences || {};
    assert.match(String(wp.partition), /^parse-\d+$/);
    assert.equal(wp.contextIsolation, true);
    assert.equal(wp.nodeIntegration, false);
    assert.equal(wp.sandbox, true);
});

test('will-navigate：非 http(s) 跳转被 preventDefault，http(s) 放行', async () => {
    const { win } = await openCaptcha();
    assert.equal(win.navHandlers.length, 1);
    const nav = win.navHandlers[0];
    const tryNav = (url) => {
        let prevented = false;
        nav({ preventDefault() { prevented = true; } }, url);
        return prevented;
    };
    for (const bad of ['intent://scan/#Intent;end', 'magnet:?xt=urn:btih:x', 'demohttps://x.test/a',
        'javascript:alert(1)', 'file:///etc/passwd', '']) {
        assert.equal(tryNav(bad), true, `${bad || '(空)'} 应被拦下`);
    }
    for (const ok of ['https://site.test/step2', 'http://site.test/step2?a=1']) {
        assert.equal(tryNav(ok), false, `${ok} 应放行`);
    }
});

test('setWindowOpenHandler：一律 deny；非 http(s) 不外开，http(s) 交系统浏览器', async () => {
    const { win, opened } = await openCaptcha();
    assert.ok(typeof win.openHandler === 'function');
    for (const bad of ['intent://scan/#Intent;end', 'magnet:?xt=urn:btih:x', 'weixin://dl/pay']) {
        assert.equal(win.openHandler({ url: bad }).action, 'deny');
    }
    assert.deepEqual(opened, [], '非 http(s) 不得交给操作系统处理');

    assert.equal(win.openHandler({ url: 'https://ext.test/promo' }).action, 'deny',
        'http(s) 新窗也不在验证窗内打开');
    assert.deepEqual(opened, ['https://ext.test/promo']);
});

test('openExternal 失败被吞掉，不产生未处理拒绝', async () => {
    const { win, opened } = await openCaptcha(() => Promise.reject(new Error('no handler')));
    assert.equal(win.openHandler({ url: 'https://ext.test/x' }).action, 'deny');
    assert.deepEqual(opened, ['https://ext.test/x']);
    await new Promise((r) => setTimeout(r, 10));
});
