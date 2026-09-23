// 白盒单元测试：pan-qr-window.js —— 夸克网盘扫码登录窗口
//
// 模块在主进程 require('electron') 顶格取 BrowserWindow，无法在纯 Node 下直接 require。
// 这里沿用 parse-window-pool.test.js 的思路：把源码读进 vm 沙箱，用 require 钩子注入
// 假 BrowserWindow / 假 session / 假 app-icon，全程不创建真实 Electron 窗口、不出网。
// 沙箱额外把私有函数（collectCookies / isLoggedIn / denyAllPermissions）挂到 __I 上，
// 并暴露 peek() 读取模块级状态（win / opening / settled / pollTimer / startedAt），
// 以便白盒断言窗口生命周期与 settle 单次性。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'main', 'pan-qr-window.js');
const SOURCE = fs.readFileSync(SRC, 'utf8');

/** 让出若干轮宏任务，等 openLoginWindow 里的 await clearStorageData 落地 */
async function flush(n) {
    for (let i = 0; i < (n || 6); i++) await new Promise((r) => setImmediate(r));
}

/** 给 Promise 挂空 catch：避免「预期 reject」的用例触发 unhandledRejection 噪声 */
function guard(p) { p.catch(() => { }); return p; }

/**
 * 在全新 vm 沙箱里装载 pan-qr-window.js（每个用例一份，模块级状态天然复位）。
 * @param {object} [opts] sessionWithPerm=false 时模拟不支持 setPermissionRequestHandler 的旧 session
 */
function loadPanQr(opts) {
    const o = opts || {};
    const st = {
        clock: 1000,
        cookies: [],
        cookieGetThrows: false,
        clearCalls: 0,
        clearStorageDataThrows: false,
        pendingClear: null,       // 注入挂起的 clearStorageData（模拟异步间隙）
        crashOnMenu: false,       // setMenuBarVisibility 抛错（模拟建窗后初始化失败）
        destroyThrows: false,
        windows: [],
        external: [],
        partitions: [],
        intervals: [],
        cleared: [],
        logs: [],
        warns: [],
        permissionHandler: null,
    };

    class FakeWindow {
        constructor(winOpts) {
            this.opts = winOpts || {};
            this.destroyCalls = 0;
            this.menuCalls = [];
            this.loaded = null;
            this.handlers = {};
            this.wcHandlers = {};
            this.openHandler = null;
            const self = this;
            this.webContents = {
                setWindowOpenHandler(fn) { self.openHandler = fn; },
                on(ev, fn) { self.wcHandlers[ev] = fn; },
            };
            st.windows.push(this);
        }
        setMenuBarVisibility(v) {
            this.menuCalls.push(v);
            if (st.crashOnMenu) throw new Error('menu boom');
        }
        loadURL(u, extra) { this.loaded = { url: u, opts: extra || null }; }
        on(ev, fn) { this.handlers[ev] = fn; }
        emit(ev, ...args) { const fn = this.handlers[ev]; if (fn) fn(...args); }
        emitWc(ev, ...args) { const fn = this.wcHandlers[ev]; if (fn) fn(...args); }
        destroy() {
            this.destroyCalls++;
            if (st.destroyThrows) throw new Error('destroy boom');
        }
    }

    const ICON = { __icon: true };
    const sesObj = {
        clearStorageData: async () => {
            st.clearCalls++;
            if (st.pendingClear) return st.pendingClear; // 挂起，由用例控制何时完成
            if (st.clearStorageDataThrows) throw new Error('clearStorageData boom');
            return undefined;
        },
        cookies: {
            get: async () => {
                if (st.cookieGetThrows) throw new Error('cookies boom');
                return st.cookies;
            },
        },
    };
    if (o.sessionWithPerm !== false) {
        sesObj.setPermissionRequestHandler = (fn) => { st.permissionHandler = fn; };
    }

    const ctx = {
        console: {
            log: (...a) => st.logs.push(a.map(String).join(' ')),
            warn: (...a) => st.warns.push(a.map(String).join(' ')),
            error: (...a) => st.warns.push(a.map(String).join(' ')),
        },
        Date: { now: () => st.clock },
        setInterval: (fn, ms) => { st.intervals.push({ fn, ms }); return st.intervals.length; },
        clearInterval: (id) => { st.cleared.push(id); },
        module: { exports: {} },
        require(name) {
            if (name === 'electron') {
                return {
                    BrowserWindow: FakeWindow,
                    session: { fromPartition: (p) => { st.partitions.push(p); return sesObj; } },
                    shell: { openExternal: async (u) => { st.external.push(u); } },
                };
            }
            if (name === './app-icon') return { windowIcon: () => ICON };
            if (name === 'path') return { join: (...a) => a.join('/'), resolve: (...a) => a.join('/') };
            throw new Error(`unexpected dependency: ${name}`);
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(
        `${SOURCE}\n;globalThis.__I = { collectCookies, isLoggedIn, denyAllPermissions,`
        + ' peek: () => ({ win: win ? 1 : 0, opening, settled, poll: pollTimer ? 1 : 0, startedAt }) };',
        ctx, { filename: 'pan-qr-window.js' },
    );
    return { mod: ctx.module.exports, I: ctx.__I, st, ICON };
}

/** 便捷：开窗并等到窗口创建完成 */
async function openReady(opt) {
    const env = loadPanQr(opt);
    const p = guard(env.mod.openLoginWindow());
    await flush();
    env.p = p;
    return env;
}

// ---------------------------------------------------------------- 建窗生命周期

test('openLoginWindow：已开窗口时二次调用抛「登录窗口已打开」，不重复建窗', async () => {
    const { mod, st } = await openReady();
    assert.equal(st.windows.length, 1);
    await assert.rejects(() => mod.openLoginWindow(), /登录窗口已打开/);
    assert.equal(st.windows.length, 1, '第二次调用不得再建窗');
    mod.closeLoginWindow();
});

test('openLoginWindow：clearStorageData 未完成的守卫间隙内并发调用同样被拒（防二次建窗）', async () => {
    const { mod, st, I } = loadPanQr();
    let release;
    st.pendingClear = new Promise((r) => { release = r; });
    const p = guard(mod.openLoginWindow());
    await flush();
    assert.equal(st.windows.length, 0, '旧会话未清理完前不得建窗');
    assert.equal(I.peek().opening, true, '守卫 opening 必须为真');
    await assert.rejects(() => mod.openLoginWindow(), /登录窗口已打开/);

    release();
    await flush();
    assert.equal(st.windows.length, 1, '清理完成后继续建窗');
    mod.closeLoginWindow();
    await assert.rejects(() => p, /登录已取消/);
});

test('openLoginWindow：每次开窗前先清一次旧会话（clearStorageData 先于建窗）', async () => {
    const { st } = await openReady();
    assert.equal(st.clearCalls, 1, '必须清掉上次登录遗留的 __puus/__pus');
    assert.ok(st.partitions.includes('quark-pan-login'), '清的是 quark-pan-login partition');
});

test('openLoginWindow：clearStorageData 抛异常仅 warn，登录流程照常继续', async () => {
    const env = loadPanQr();
    env.st.clearStorageDataThrows = true;
    const p = guard(env.mod.openLoginWindow());
    await flush();
    assert.equal(env.st.windows.length, 1, '清理失败也要继续建窗');
    assert.ok(env.st.warns.some((w) => w.includes('clearStorageData failed')),
        '失败应记 warn 供排查');
    // 会话清理失败不影响正常的扫码登录判定
    env.st.cookies = [{ name: '__puus', value: 'U2', domain: '.quark.cn' }];
    await env.st.intervals[0].fn();
    const r = await p;
    assert.equal(r.cookies, '__puus=U2');
    assert.equal(env.st.windows[0].destroyCalls, 1, '登录成功照常关窗');
});

test('建窗参数：隔离+沙箱+拼写检查关闭+指定 partition+窗口图标', async () => {
    const { st, ICON } = await openReady();
    const w = st.windows[0];
    assert.equal(w.opts.width, 460);
    assert.equal(w.opts.height, 700);
    assert.equal(w.opts.title, '夸克网盘扫码登录');
    assert.equal(w.opts.backgroundColor, '#f3f6fe');
    assert.equal(w.opts.autoHideMenuBar, true);
    assert.equal(w.opts.icon, ICON, '图标走 app-icon.windowIcon()（预缩多表示）');
    const wp = w.opts.webPreferences;
    assert.equal(wp.partition, 'quark-pan-login', '必须用独立 partition 隔离登录会话');
    assert.equal(wp.contextIsolation, true, '远程官方页面必须上下文隔离');
    assert.equal(wp.nodeIntegration, false, '远程页面不得有 node 能力');
    assert.equal(wp.sandbox, true, '远程页面必须沙箱');
    assert.equal(wp.spellcheck, false);
    assert.deepEqual(w.menuCalls, [false], '需隐藏菜单栏');
});

test('loadURL：加载官方落地页并伪装桌面 Chrome UA', async () => {
    const { st } = await openReady();
    assert.equal(st.windows[0].loaded.url, 'https://pan.quark.cn/');
    assert.match(st.windows[0].loaded.opts.userAgent, /Chrome\/131\.0\.0\.0/, 'UA 需为桌面 Chrome');
    assert.match(st.windows[0].loaded.opts.userAgent, /Windows NT 10\.0/);
});

// ---------------------------------------------------------------- 权限 / 外链 / 加载失败

test('denyAllPermissions：注册全拒处理器，任何权限回调 false（P2-12）', async () => {
    const { st } = await openReady();
    assert.equal(typeof st.permissionHandler, 'function', '必须注册权限处理器');
    let granted = null;
    st.permissionHandler({}, 'clipboard-read', (v) => { granted = v; });
    assert.equal(granted, false, '剪贴板读取等权限一律拒绝');
    st.permissionHandler({}, 'notifications', (v) => { granted = v; });
    assert.equal(granted, false);
});

test('denyAllPermissions：callback 抛异常（会话销毁竞态）被吞掉，不冒泡', async () => {
    const { st } = await openReady();
    assert.doesNotThrow(() => st.permissionHandler({}, 'media', () => { throw new Error('session gone'); }),
        'callback 抛错属竞态，必须忽略');
});

test('denyAllPermissions：session 缺失/不支持权限处理器时不抛错', async () => {
    const env = loadPanQr({ sessionWithPerm: false });
    assert.doesNotThrow(() => env.I.denyAllPermissions({}), '无该方法的 session 静默返回');
    assert.doesNotThrow(() => env.I.denyAllPermissions(null), 'null session 静默返回');
    const p = guard(env.mod.openLoginWindow());
    await flush();
    assert.equal(env.st.windows.length, 1, '旧 session 不支持权限处理器也应能正常建窗');
    // 未注册权限处理器 → 走 Chromium 默认放行，故本用例只锁定「不崩溃」这一退让行为
    assert.equal(env.st.permissionHandler, null);
    env.mod.closeLoginWindow();
    await assert.rejects(() => p, /登录已取消/);
});

// 注：handler 的返回值由 vm 沙箱内构造，跨 realm 的对象原型与宿主线程不同，
// 不能用 assert.deepStrictEqual 比对对象本体，改为逐字段断言。
test('setWindowOpenHandler：http(s) 外链走系统浏览器且拒绝开窗，非 http(s) 不开外链', async () => {
    const { st } = await openReady();
    const w = st.windows[0];
    assert.equal(w.openHandler({ url: 'https://pan.quark.cn/terms' }).action, 'deny');
    assert.equal(w.openHandler({ url: 'http://a.test/x' }).action, 'deny');
    assert.deepEqual(st.external, ['https://pan.quark.cn/terms', 'http://a.test/x']);

    assert.equal(w.openHandler({ url: 'javascript:alert(1)' }).action, 'deny',
        '任何外链请求一律不允许在新窗口打开');
    assert.equal(st.external.length, 2, '非 http(s) 不得交给系统浏览器');
});

test('did-fail-load：业务错误码记 warn，-3（ERR_ABORTED，主动中断）静默', async () => {
    const { st } = await openReady();
    const w = st.windows[0];
    w.emitWc('did-fail-load', {}, -3, 'ERR_ABORTED');
    assert.deepEqual(st.warns, [], '-3 是关闭/跳转导致的正常中断，不应刷日志');
    w.emitWc('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED');
    assert.equal(st.warns.length, 1);
    assert.match(st.warns[0], /load fail/);
    assert.match(st.warns[0], /-102/);
});

test('did-fail-load：已 settle 后不再记 warn（登录已结束）', async () => {
    const { st, mod, p } = await openReady();
    mod.closeLoginWindow();
    await assert.rejects(() => p, /登录已取消/);
    st.windows[0].emitWc('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED');
    assert.deepEqual(st.warns, [], 'settle 之后的加载失败无需提示');
});

// ---------------------------------------------------------------- 轮询 / 登录判定

test('轮询：命中 __puus 才 resolve，返回 quark/uc Cookie 串并关窗', async () => {
    const { st, I, p } = await openReady();
    assert.equal(st.intervals.length, 1, '应只起一个轮询定时器');
    assert.equal(st.intervals[0].ms, 1000, '轮询周期 1s');
    st.cookies = [
        { name: '__puus', value: 'U1', domain: '.quark.cn' },
        { name: 'b-user-id', value: 'B1', domain: '.quark.cn' },
        { name: 'other', value: 'X', domain: 'example.com' },
    ];
    await st.intervals[0].fn();
    const result = await p;
    assert.equal(result.cookies, '__puus=U1; b-user-id=B1', '只收 quark.cn/uc.cn 域 Cookie');
    assert.equal(st.windows[0].destroyCalls, 1, '登录成功必须关窗');
    assert.equal(I.peek().win, 0, 'win 复位为 null');
    assert.ok(st.cleared.length >= 1, '轮询定时器必须停掉');
    assert.ok(st.logs.some((l) => l.includes('login ok')), '成功要打日志');
});

test('轮询：只有 __pus 不算登录成功，不 resolve 也不关窗', async () => {
    const { st, p } = await openReady();
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    st.cookies = [{ name: '__pus', value: 'P1', domain: '.quark.cn' }];
    await st.intervals[0].fn();
    await flush();
    assert.equal(done, false, '__pus 只是兜底，收割太早会被 drive-pc 判定 guest');
    assert.equal(st.windows[0].destroyCalls, 0, '未登录不得关窗');
});

test('轮询：cookies.get 抛异常被吞掉（单次轮询错误不影响后续）', async () => {
    const { st, p, I } = await openReady();
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    st.cookieGetThrows = true;
    await st.intervals[0].fn();
    await flush();
    assert.equal(done, false, '单次轮询异常不得 settle');
    assert.equal(st.intervals.length, 1, '定时器仍在跑（未被异常打断）');

    // 下一次轮询恢复正常即应成功
    st.cookieGetThrows = false;
    st.cookies = [{ name: '__puus', value: 'U9', domain: '.quark.cn' }];
    await st.intervals[0].fn();
    const r = await p;
    assert.equal(r.cookies, '__puus=U9');
    assert.equal(I.peek().win, 0);
});

test('轮询超时：超过 5 分钟 reject「登录超时」并自动关窗（边界前后各一次）', async () => {
    const { st, p } = await openReady();
    let rejected = null;
    p.then(() => { }, (e) => { rejected = e; });

    st.clock += 5 * 60 * 1000;      // 恰好等于 MAX_WAIT_MS：> 判定不触发
    await st.intervals[0].fn();
    await flush();
    assert.equal(rejected, null, '恰好 5 分钟不算超时');
    assert.equal(st.windows[0].destroyCalls, 0);

    st.clock += 1;                  // 越过阈值
    await st.intervals[0].fn();
    await assert.rejects(() => p, /登录超时（5 分钟），请重试/);
    assert.equal(st.windows[0].destroyCalls, 1, '超时必须关窗');
});

test('登录成功后状态复位：可以再次打开第二个登录窗口', async () => {
    const { st, mod, p } = await openReady();
    st.cookies = [{ name: '__puus', value: 'U1', domain: '.quark.cn' }];
    await st.intervals[0].fn();
    await p;
    assert.equal(st.windows[0].destroyCalls, 1);

    const p2 = guard(mod.openLoginWindow());
    await flush();
    assert.equal(st.windows.length, 2, '二次登录必须能重新建窗');
    assert.equal(st.clearCalls, 2, '二次登录同样先清会话');
    mod.closeLoginWindow();
    await assert.rejects(() => p2, /登录已取消/);
});

// ---------------------------------------------------------------- 关闭 / settle 单次性

test('closeLoginWindow：空状态（从未开窗）调用不抛错、无副作用', async () => {
    const { mod, st, I } = loadPanQr();
    assert.doesNotThrow(() => mod.closeLoginWindow());
    assert.equal(st.windows.length, 0);
    assert.deepEqual(st.cleared, [], '没有定时器可清');
    assert.equal(I.peek().win, 0);
    assert.equal(I.peek().settled, true, '无回调时 settle 也只标记状态（resolveCb/rejectCb 为 null 不报错）');
    assert.doesNotThrow(() => mod.closeLoginWindow(), '重复调用幂等');
    // 状态标记后仍可正常开窗：openLoginWindow 内部会重置 settled
    const p = guard(mod.openLoginWindow());
    await flush();
    assert.equal(st.windows.length, 1);
    mod.closeLoginWindow();
    await assert.rejects(() => p, /登录已取消/);
});

test('closeLoginWindow 幂等：连续多次只 reject 一次、只 destroy 一次', async () => {
    const { mod, st, p } = await openReady();
    let rejects = 0;
    p.catch(() => { rejects++; });
    mod.closeLoginWindow();
    mod.closeLoginWindow();
    mod.closeLoginWindow();
    await flush();
    assert.equal(rejects, 1, 'settle 必须单次生效');
    assert.equal(st.windows[0].destroyCalls, 1, 'win 置空后不再重复 destroy');
    await assert.rejects(() => p, /登录已取消/);
});

test('closeLoginWindow 之后窗口再发 closed：不会二次 reject', async () => {
    const { mod, st, p } = await openReady();
    let rejects = 0;
    p.catch(() => { rejects++; });
    mod.closeLoginWindow();
    await flush();
    st.windows[0].emit('closed');   // 真实 Electron 里 destroy 后仍会触发 closed
    await flush();
    assert.equal(rejects, 1, '已 settle 后 closed 回调不得再 reject');
});

test('用户手动关窗（closed 事件）：win 复位并 reject「登录窗口已关闭」', async () => {
    const { st, I, p } = await openReady();
    assert.equal(I.peek().win, 1);
    st.windows[0].emit('closed');
    assert.equal(I.peek().win, 0, 'closed 回调必须把模块级 win 置空');
    await assert.rejects(() => p, /登录窗口已关闭/);
    assert.ok(st.cleared.length >= 1, '关窗要停掉轮询');
});

test('closeLoginWindow：destroy 抛异常被吞掉，win 仍复位', async () => {
    const { mod, st, I, p } = await openReady();
    st.destroyThrows = true;
    assert.doesNotThrow(() => mod.closeLoginWindow(), 'destroy 异常不得冒泡');
    assert.equal(I.peek().win, 0, '即便 destroy 抛错也要复位 win');
    await assert.rejects(() => p, /登录已取消/);
});

test('closeLoginWindow：会停掉轮询定时器（stopPoll），登录流程不再推进', async () => {
    const { mod, st, I } = await openReady();
    assert.equal(I.peek().poll, 1, '开窗后应有轮询定时器');
    mod.closeLoginWindow();
    assert.equal(I.peek().poll, 0, 'stopPoll 必须清掉 pollTimer');
    assert.deepEqual(st.cleared, [1], '同一个定时器 id 被 clearInterval');
});

// ---------------------------------------------------------------- 私有函数直测

test('collectCookies：只收 quark.cn / uc.cn（域名大小写不敏感），get 失败返回空串', async () => {
    const { st, I } = loadPanQr();
    st.cookies = [
        { name: 'a', value: '1', domain: '.quark.cn' },
        { name: 'b', value: '2', domain: 'PAN.QUARK.CN' },
        { name: 'c', value: '3', domain: '.uc.cn' },
        { name: 'd', value: '4', domain: 'example.com' },
    ];
    assert.equal(await I.collectCookies(), 'a=1; b=2; c=3');
    st.cookieGetThrows = true;
    assert.equal(await I.collectCookies(), '', '收割失败返回空串而非抛错');
});

test('isLoggedIn：必须含 __puus；cookies.get 抛错返回 false', async () => {
    const { st, I } = loadPanQr();
    assert.equal(await I.isLoggedIn(), false, '空 Cookie 未登录');
    st.cookies = [{ name: '__pus', value: 'P', domain: '.quark.cn' }];
    assert.equal(await I.isLoggedIn(), false, '__pus 不足以判定登录完成');
    st.cookies = [{ name: '__puus', value: 'U', domain: '.quark.cn' }];
    assert.equal(await I.isLoggedIn(), true);
    st.cookieGetThrows = true;
    assert.equal(await I.isLoggedIn(), false, 'session 异常时按未登录处理（fail-closed）');
});

// ---------------------------------------------------------------- 缺陷修复验证（A1）

test('A1 修复：建窗后初始化抛异常 → win 销毁复位，后续登录可重试', async () => {
    const env = loadPanQr();
    env.st.crashOnMenu = true;   // 模拟 setMenuBarVisibility 抛错
    const p = guard(env.mod.openLoginWindow());
    await assert.rejects(() => p, /menu boom/, '异常经 Promise executor 转成 reject');
    await flush();
    // A1 修复钉：之前 win 残留为 1（窗口泄漏），后续 openLoginWindow 永久报「已打开」
    // 只能重启应用。现在初始化失败时兜底 destroy + 复位 win，下次调用可正常重试。
    assert.equal(env.I.peek().win, 0, 'win 已被复位（不再残留）');
    assert.equal(env.I.peek().opening, false, 'finally 已解除守卫');
    // 后续调用应能重试（不再被残留的 win 卡住）——把桩恢复正常后应能成功建窗
    env.st.crashOnMenu = false;
    const retry = guard(env.mod.openLoginWindow());
    await flush();
    // 第二次调用应当成功进入轮询阶段（不再报「已打开」）
    assert.equal(env.I.peek().win, 1, '重试应能重新建窗');
    env.mod.closeLoginWindow();  // 兜底清理
    await assert.rejects(() => retry, /登录已取消|登录窗口已关闭/);
});
