// 部件测试：system-proxy.js 代理探测/规范化（白盒）
// 注入策略：
// - child_process.execSync 在 require 前替换成桩，彻底切断 reg query 真实执行（不出网、不碰注册表）
// - electron 用 require.cache 占位模块替换，驱动 net.fetch 分支；globalThis.fetch 全程假实现
// - TTL 用 t.mock.timers 的 Date 时间旅行（不真等 5 秒）
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');

const REAL_EXEC_SYNC = cp.execSync;
const REAL_FETCH = globalThis.fetch;
const ELECTRON_ID = require.resolve('electron');
const REAL_ELECTRON_CACHE = require.cache[ELECTRON_ID];

/** getProxyUrl() 会读这 4 个环境变量且优先级高于注册表探测；开发/CI 机一旦设置就会让「无代理」断言失败。 */
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
let savedProxyEnv = null;
function clearProxyEnv() {
    savedProxyEnv = {};
    for (const k of PROXY_ENV_KEYS) {
        savedProxyEnv[k] = process.env[k];
        delete process.env[k];
    }
}
function restoreProxyEnv() {
    if (!savedProxyEnv) return;
    for (const k of PROXY_ENV_KEYS) {
        if (savedProxyEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedProxyEnv[k];
    }
    savedProxyEnv = null;
}

/** 注册表探测桩：默认「无系统代理」——任何真实 execSync 都是测试事故，直接抛错。 */
let regImpl = () => { throw new Error('[test] 禁止真实 execSync：注册表探测未打桩'); };
cp.execSync = (cmd, opts) => regImpl(cmd, opts);

const PROXY = require('../../src/main/system-proxy');
const {
    getProxyUrl, proxyEnv, proxyFetch,
    formatAndValidateProxyUrl, setManualProxySource, invalidateCache,
} = PROXY;

/** 造一个 settings 替身：proxyEnable（true/false）、proxyUrl（字符串）。 */
function settings(enable, url) {
    return { get: (k) => (k === 'proxyEnable' ? enable : k === 'proxyUrl' ? url : undefined) };
}

/** 让「系统代理」走注册表桩：ProxyEnable=1 + ProxyServer=<server>。 */
function withRegistryProxy(server) {
    regImpl = (cmd) => (
        /\/v\s+ProxyEnable/i.test(cmd) ? '    ProxyEnable    REG_DWORD    0x1\n'
            : `    ProxyServer    REG_SZ    ${server}\n`);
}

beforeEach(() => {
    regImpl = () => { throw new Error('[test] 禁止真实 execSync：注册表探测未打桩'); };
    clearProxyEnv();              // 切断宿主代理环境对 getProxyUrl 的污染
    setManualProxySource(null);   // 每个用例从「无手动代理」起步
    invalidateCache();            // 每个用例从「未探测」起步，隔离彼此
});

afterEach(() => {
    regImpl = () => { throw new Error('[test] 禁止真实 execSync：注册表探测未打桩'); };
    restoreProxyEnv();
    setManualProxySource(null);
    invalidateCache();
    if (REAL_FETCH) globalThis.fetch = REAL_FETCH; else delete globalThis.fetch;
    restoreElectron(REAL_ELECTRON_CACHE);
    // 注意：模块顶层的 cp.execSync 替换（require 前那一行）是有意的进程级打桩，
    // 依赖 node --test 默认的按文件子进程隔离；本 afterEach 无需再"还原"，
    // 之前的 `cp.execSync = REAL_EXEC_SYNC` 是死代码——紧跟的下一行会立即覆盖回去。
});

/** 用假模块占位 require('electron')；传 null 恢复真实模块。 */
function stubElectron(exportsOrThrow) {
    if (exportsOrThrow === null) return restoreElectron(REAL_ELECTRON_CACHE);
    require.cache[ELECTRON_ID] = {
        id: ELECTRON_ID, filename: ELECTRON_ID, loaded: true,
        exports: exportsOrThrow && exportsOrThrow.__throws
            ? Object.defineProperty({}, 'net', { get() { throw exportsOrThrow.__throws; } })
            : exportsOrThrow,
    };
    return undefined;
}
function restoreElectron(saved) {
    if (saved) require.cache[ELECTRON_ID] = saved;
    else delete require.cache[ELECTRON_ID];
}

// ─────────────────────────────────────────────────────────────────────────────
// formatAndValidateProxyUrl：纯函数等价类 + 边界
// ─────────────────────────────────────────────────────────────────────────────

test('formatAndValidateProxyUrl：http 带端口规范化为 http://host:port', () => {
    assert.equal(formatAndValidateProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
    assert.equal(formatAndValidateProxyUrl('http://proxy.example.com:8080'), 'http://proxy.example.com:8080');
});

test('formatAndValidateProxyUrl：https 前缀统一降级为 http://（注释与实现一致：https 也走 http 出口）', () => {
    // 关键：https:// 与非 socks 前缀一律按 http 处理，只保留 host:port
    assert.equal(formatAndValidateProxyUrl('https://127.0.0.1:7890'), 'http://127.0.0.1:7890');
    assert.equal(formatAndValidateProxyUrl('HTTPS://PROXY.EXAMPLE.COM:8080'), 'http://PROXY.EXAMPLE.COM:8080');
});

test('formatAndValidateProxyUrl：socks5/socks 前缀统一为 socks5://', () => {
    assert.equal(formatAndValidateProxyUrl('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
    assert.equal(formatAndValidateProxyUrl('socks://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
    assert.equal(formatAndValidateProxyUrl('SOCKS5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
});

test('formatAndValidateProxyUrl：缺省前缀自动补全 http://', () => {
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890');
    assert.equal(formatAndValidateProxyUrl('proxy.example.com:8080'), 'http://proxy.example.com:8080');
});

test('formatAndValidateProxyUrl：首尾空白 trim 后仍可解析', () => {
    assert.equal(formatAndValidateProxyUrl('  http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
    assert.equal(formatAndValidateProxyUrl('http://127.0.0.1:7890  '), 'http://127.0.0.1:7890');
    assert.equal(formatAndValidateProxyUrl(' socks5://127.0.0.1:1080 '), 'socks5://127.0.0.1:1080');
});

test('formatAndValidateProxyUrl：非法协议 ftp:// 不剥离 scheme，整体被当作 host（当前行为）', () => {
    // 正则只认 http/https/socks/socks5，故 ftp:// 原样保留；因含 ':' 又被当作 IPv6 字面量补括号
    const out = formatAndValidateProxyUrl('ftp://127.0.0.1:21');
    assert.equal(out, 'http://[ftp://127.0.0.1]:21');
});

test('formatAndValidateProxyUrl：空串/空白/换行一律返回空', () => {
    assert.equal(formatAndValidateProxyUrl(''), '');
    assert.equal(formatAndValidateProxyUrl('   '), '');
    assert.equal(formatAndValidateProxyUrl('\n\t '), '');
});

test('formatAndValidateProxyUrl：null/undefined/数字/布尔/对象/数组等非字符串一律返回空', () => {
    for (const v of [null, undefined, 123, 0, true, {}, [], NaN, Symbol('x')]) {
        assert.equal(formatAndValidateProxyUrl(v), '', `入参 ${String(v)} 应返回空`);
    }
});

test('formatAndValidateProxyUrl：端口下边界 0 与负数判非法', () => {
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:0'), '');
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:-1'), '');
});

test('formatAndValidateProxyUrl：端口合法边界 1 与 65535 通过', () => {
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:1'), 'http://127.0.0.1:1');
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:65535'), 'http://127.0.0.1:65535');
});

test('formatAndValidateProxyUrl：端口上越界 65536 及以上判非法', () => {
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:65536'), '');
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:99999'), '');
});

test('formatAndValidateProxyUrl：端口非数字（NaN/Infinity/字母）判非法', () => {
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:NaN'), '');
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:Infinity'), '');
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:TRUE'), '');
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:80a'), '');
});

test('formatAndValidateProxyUrl：端口小数判非法；整值小数（65535.0）被 Number 接受', () => {
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:7890.5'), '');
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:65535.0'), 'http://127.0.0.1:65535');
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:1e3'), 'http://127.0.0.1:1000'); // 指数写法 → 1000
});

test('formatAndValidateProxyUrl：缺失端口判非法（注释要求显式端口）', () => {
    assert.equal(formatAndValidateProxyUrl('127.0.0.1'), '');
    assert.equal(formatAndValidateProxyUrl('http://proxy.example.com'), '');
    assert.equal(formatAndValidateProxyUrl('[::1]'), '');
});

test('formatAndValidateProxyUrl：host 缺失（:8080）判非法', () => {
    assert.equal(formatAndValidateProxyUrl(':8080'), '');
    assert.equal(formatAndValidateProxyUrl('http://:8080'), '');
});

test('formatAndValidateProxyUrl：含空格 → host 内部空格不清除（端口段空格被 Number 吃掉）', () => {
    // Number(' 8080') === 8080，故「host: 8080」仍被判为合法
    assert.equal(formatAndValidateProxyUrl('127.0.0.1: 8080'), 'http://127.0.0.1:8080');
    // host 内部的空格原样保留（实现不做 host 白名单校验）
    assert.equal(formatAndValidateProxyUrl('local host:8080'), 'http://local host:8080');
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:78 90'), '');   // Number('78 90') → NaN
});

test('formatAndValidateProxyUrl：带路径/查询串/锚点一律判非法（端口段非纯数字）', () => {
    assert.equal(formatAndValidateProxyUrl('http://127.0.0.1:7890/p'), '');
    assert.equal(formatAndValidateProxyUrl('http://127.0.0.1:7890?q=1'), '');
    assert.equal(formatAndValidateProxyUrl('http://127.0.0.1:7890#f'), '');
    assert.equal(formatAndValidateProxyUrl('http://127.0.0.1:7890/p?q=1'), '');
});

test('formatAndValidateProxyUrl：IPv6 带方括号原样规范化', () => {
    assert.equal(formatAndValidateProxyUrl('[::1]:7890'), 'http://[::1]:7890');
    assert.equal(formatAndValidateProxyUrl('[2001:db8::1]:8080'), 'http://[2001:db8::1]:8080');
    assert.equal(formatAndValidateProxyUrl('http://[::ffff:127.0.0.1]:7890'), 'http://[::ffff:127.0.0.1]:7890');
    assert.equal(formatAndValidateProxyUrl('socks5://[::1]:1080'), 'socks5://[::1]:1080');
});

test('formatAndValidateProxyUrl：裸 IPv6（无括号）输出时自动补方括号', () => {
    assert.equal(formatAndValidateProxyUrl('::1:7890'), 'http://[::1]:7890');
    assert.equal(formatAndValidateProxyUrl('2001:db8::1:8080'), 'http://[2001:db8::1]:8080');
});

test('formatAndValidateProxyUrl：IPv6 方括号后跟非端口内容判非法', () => {
    assert.equal(formatAndValidateProxyUrl('[::1]/p'), '');
    assert.equal(formatAndValidateProxyUrl('[::1]x:80'), '');
    assert.equal(formatAndValidateProxyUrl('[[::1]]:80'), '');
});

test('formatAndValidateProxyUrl：user:pass@ 用户信息被当成 IPv6 处理（当前行为：加方括号而非剔除）', () => {
    // 实现把「含冒号且非 [ 开头」一律当 IPv6 字面量补括号，userinfo 未被识别
    assert.equal(formatAndValidateProxyUrl('http://user:pass@127.0.0.1:7890'), 'http://[user:pass@127.0.0.1]:7890');
    assert.equal(formatAndValidateProxyUrl('socks5://user:pw@127.0.0.1:1080'), 'socks5://[user:pw@127.0.0.1]:1080');
    // 只有 user 无冒号密码时是「http://user@host:port」形态
    assert.equal(formatAndValidateProxyUrl('http://user@127.0.0.1:8080'), 'http://user@127.0.0.1:8080');
});

test('formatAndValidateProxyUrl：Unicode 主机名原样保留（实现不做 IDN/ASCII 校验）', () => {
    assert.equal(formatAndValidateProxyUrl('http://例え.com:8080'), 'http://例え.com:8080');
    assert.equal(formatAndValidateProxyUrl('http://代理.中国:7890'), 'http://代理.中国:7890');
});

test('formatAndValidateProxyUrl：全角数字端口 Number 判 NaN → 非法', () => {
    assert.equal(formatAndValidateProxyUrl('１２７.０.０.１:７８９０'), '');
});

test('formatAndValidateProxyUrl：端口前导零被归一（00080 → 80）', () => {
    assert.equal(formatAndValidateProxyUrl('http://127.0.0.1:00080'), 'http://127.0.0.1:80');
    assert.equal(formatAndValidateProxyUrl('127.0.0.1:007890'), 'http://127.0.0.1:7890');
});

test('formatAndValidateProxyUrl：畸形 scheme（:// 无协议名）不剥离，整体当 host', () => {
    const out = formatAndValidateProxyUrl('://127.0.0.1:8080');
    assert.notEqual(out, '');
    assert.ok(out.startsWith('http://[://'), `实际：${out}`);
});

test('formatAndValidateProxyUrl：幂等——已规范化的 URL 再解析结果不变', () => {
    const once = formatAndValidateProxyUrl('127.0.0.1:7890');
    assert.equal(once, 'http://127.0.0.1:7890');
    assert.equal(formatAndValidateProxyUrl(once), once);
    const s = formatAndValidateProxyUrl('socks://[::1]:1080');
    assert.equal(formatAndValidateProxyUrl(s), s);
});

// ─────────────────────────────────────────────────────────────────────────────
// getProxyUrl / invalidateCache：缓存与优先级
// ─────────────────────────────────────────────────────────────────────────────

test('getProxyUrl：无手动代理且注册表探测失败 → 返回空串', () => {
    regImpl = () => { throw new Error('reg query 失败（无系统代理）'); };
    invalidateCache();
    assert.equal(getProxyUrl(), '');
});

test('getProxyUrl：注册表 ProxyEnable=0x1 且 ProxyServer 有值 → 返回 http://host:port', () => {
    withRegistryProxy('127.0.0.1:7890');
    invalidateCache();
    assert.equal(getProxyUrl(), 'http://127.0.0.1:7890');
});

test('getProxyUrl：注册表「http=..;https=..」分协议形式——注释称取 https 段，实测取到 http 段', () => {
    // 现状：正则 /https?=([^;]+)/i 会先命中「http=」，故拿到 7890（http 段），而非注释所说的 https 段
    withRegistryProxy('http=127.0.0.1:7890;https=127.0.0.1:7891');
    invalidateCache();
    assert.equal(getProxyUrl(), 'http://127.0.0.1:7890');
});

test('getProxyUrl：分协议形式只剩 https= 段时取该段', () => {
    withRegistryProxy('https=127.0.0.1:7891');
    invalidateCache();
    assert.equal(getProxyUrl(), 'http://127.0.0.1:7891');
});

test('getProxyUrl：ProxyEnable=0 → 不读 ProxyServer，返回空', () => {
    regImpl = (cmd) => (
        /\/v\s+ProxyEnable/i.test(cmd) ? '    ProxyEnable    REG_DWORD    0x0\n'
            : '    ProxyServer    REG_SZ    127.0.0.1:7890\n');
    invalidateCache();
    assert.equal(getProxyUrl(), '');
});

test('getProxyUrl：缓存命中——TTL 内探测桩不再被调用', (t) => {
    let calls = 0;
    regImpl = (cmd) => {
        calls++;
        return /\/v\s+ProxyEnable/i.test(cmd) ? '    ProxyEnable    REG_DWORD    0x1\n'
            : '    ProxyServer    REG_SZ    127.0.0.1:7890\n';
    };
    t.mock.timers.enable({ apis: ['Date'] });
    try {
        invalidateCache();
        assert.equal(getProxyUrl(), 'http://127.0.0.1:7890');
        assert.equal(calls, 2, '首次探测应各查一次 ProxyEnable/ProxyServer');
        assert.equal(getProxyUrl(), 'http://127.0.0.1:7890');
        assert.equal(getProxyUrl(), 'http://127.0.0.1:7890');
        assert.equal(calls, 2, 'TTL 内重复调用不应再触发探测');
    } finally {
        t.mock.timers.reset();
    }
});

test('getProxyUrl：TTL=5000ms 边界——4999ms 命中缓存，5001ms 重新探测', (t) => {
    let calls = 0;
    regImpl = (cmd) => {
        calls++;
        return /\/v\s+ProxyEnable/i.test(cmd) ? '    ProxyEnable    REG_DWORD    0x1\n'
            : '    ProxyServer    REG_SZ    127.0.0.1:7890\n';
    };
    t.mock.timers.enable({ apis: ['Date'] });
    try {
        invalidateCache();
        getProxyUrl();
        assert.equal(calls, 2);
        t.mock.timers.tick(4999);
        getProxyUrl();
        assert.equal(calls, 2, '4999ms 仍在 TTL 内 → 命中缓存');
        t.mock.timers.tick(2);                 // 累计 5001ms，越过 TTL
        getProxyUrl();
        assert.equal(calls, 4, '越过 TTL 应重新探测');
    } finally {
        t.mock.timers.reset();
    }
});

test('invalidateCache：手动失效后立刻重新探测（不等 TTL）', (t) => {
    let calls = 0;
    regImpl = (cmd) => {
        calls++;
        return /\/v\s+ProxyEnable/i.test(cmd) ? '    ProxyEnable    REG_DWORD    0x1\n'
            : '    ProxyServer    REG_SZ    127.0.0.1:7890\n';
    };
    t.mock.timers.enable({ apis: ['Date'] });
    try {
        invalidateCache();
        getProxyUrl();
        assert.equal(calls, 2);
        invalidateCache();                     // 时间未推进，仅失效缓存
        getProxyUrl();
        assert.equal(calls, 4, 'invalidateCache 后应立刻重新探测');
    } finally {
        t.mock.timers.reset();
    }
});

test('getProxyUrl：手动代理优先于注册表探测（探测桩一次都不该被调用）', () => {
    let regCalls = 0;
    regImpl = () => { regCalls++; throw new Error('不应走到注册表'); };
    setManualProxySource(() => settings(true, '127.0.0.1:7890'));
    invalidateCache();
    assert.equal(getProxyUrl(), 'http://127.0.0.1:7890');
    assert.equal(regCalls, 0, '手动代理有效时不应触发系统探测');
});

test('getProxyUrl：手动 proxyEnable 非严格 true（字符串 "true"/数字 1）视为关闭', () => {
    regImpl = () => { throw new Error('no reg'); };
    setManualProxySource(() => settings('true', '127.0.0.1:7890'));
    invalidateCache();
    assert.equal(getProxyUrl(), '');
    setManualProxySource(() => settings(1, '127.0.0.1:7890'));
    invalidateCache();
    assert.equal(getProxyUrl(), '');
});

test('getProxyUrl：手动代理开启但 URL 非法 → 回落到系统探测', () => {
    withRegistryProxy('127.0.0.1:7890');
    setManualProxySource(() => settings(true, '这不是代理'));
    invalidateCache();
    assert.equal(getProxyUrl(), 'http://127.0.0.1:7890', '手动 URL 校验失败应回落系统代理');
});

test('getProxyUrl：手动来源抛异常被吞掉，不影响主流程', () => {
    withRegistryProxy('127.0.0.1:7890');
    setManualProxySource(() => { throw new Error('settings 未就绪'); });
    invalidateCache();
    assert.equal(getProxyUrl(), 'http://127.0.0.1:7890');
});

test('setManualProxySource：非函数入参一律清空（null/undefined/字符串/对象）', () => {
    regImpl = () => { throw new Error('no reg'); };
    for (const v of [null, undefined, 'fn', 42, {}]) {
        setManualProxySource(v);
        invalidateCache();
        assert.equal(getProxyUrl(), '', `入参 ${String(v)} 应被当作「无手动来源」`);
    }
});

test('getProxyUrl：环境变量 HTTPS_PROXY 优先于注册表', () => {
    withRegistryProxy('10.0.0.1:3128');
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    try {
        invalidateCache();
        assert.equal(getProxyUrl(), 'http://127.0.0.1:7890');
    } finally {
        if (saved === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = saved;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// proxyEnv：子进程注入用环境变量
// ─────────────────────────────────────────────────────────────────────────────

test('proxyEnv：有代理时返回四个键（http_proxy/https_proxy/HTTP_PROXY/HTTPS_PROXY）且值相同', () => {
    setManualProxySource(() => settings(true, '127.0.0.1:7890'));
    invalidateCache();
    const env = proxyEnv();
    assert.deepEqual(Object.keys(env).sort(), ['HTTPS_PROXY', 'HTTP_PROXY', 'http_proxy', 'https_proxy']);
    assert.equal(env.http_proxy, 'http://127.0.0.1:7890');
    assert.equal(env.https_proxy, 'http://127.0.0.1:7890');
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
});

test('proxyEnv：socks5 代理原样透传给四个键', () => {
    setManualProxySource(() => settings(true, 'socks5://127.0.0.1:1080'));
    invalidateCache();
    const env = proxyEnv();
    assert.equal(env.http_proxy, 'socks5://127.0.0.1:1080');
    assert.equal(env.HTTPS_PROXY, 'socks5://127.0.0.1:1080');
});

test('proxyEnv：无代理时返回空对象（不污染子进程 env）', () => {
    regImpl = () => { throw new Error('no reg'); };
    invalidateCache();
    const env = proxyEnv();
    assert.deepEqual(env, {});
    assert.equal(Object.keys(env).length, 0, '空对象才能保证 {...process.env, ...proxyEnv()} 不注入脏键');
});

test('proxyEnv：不会修改 process.env 本体', () => {
    setManualProxySource(() => settings(true, '127.0.0.1:7890'));
    invalidateCache();
    const before = Object.keys(process.env).length;
    const beforeHttps = process.env.HTTPS_PROXY;
    proxyEnv();
    assert.equal(Object.keys(process.env).length, before, 'process.env 键数不应变化');
    assert.equal(process.env.HTTPS_PROXY, beforeHttps);
});

// ─────────────────────────────────────────────────────────────────────────────
// proxyFetch：假 fetch 驱动，无真实出网
// ─────────────────────────────────────────────────────────────────────────────

test('proxyFetch：无代理 → 走 global fetch，url 与 opts 原样透传', async () => {
    regImpl = () => { throw new Error('no reg'); };
    invalidateCache();
    const seen = [];
    globalThis.fetch = async (...a) => { seen.push(a); return { tag: 'global' }; };
    const opts = { headers: { 'User-Agent': 'yuki-test' }, method: 'GET' };
    const res = await proxyFetch('http://example.invalid/a.m3u8', opts);
    assert.deepEqual(res, { tag: 'global' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 'http://example.invalid/a.m3u8');
    assert.strictEqual(seen[0][1], opts, 'opts 应原样透传（同一引用）');
});

test('proxyFetch：无代理且省略 opts → 补默认空对象，不会把 undefined 传给 fetch', async () => {
    regImpl = () => { throw new Error('no reg'); };
    invalidateCache();
    const seen = [];
    globalThis.fetch = async (...a) => { seen.push(a); return { ok: true }; };
    await proxyFetch('http://example.invalid/b');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0][1], {});
});

test('proxyFetch：有代理且 electron net.fetch 可用 → 走 net.fetch 且不回落 global fetch', async () => {
    setManualProxySource(() => settings(true, '127.0.0.1:7890'));
    invalidateCache();
    const netSeen = [];
    let globalCalled = 0;
    stubElectron({ net: { fetch: async (...a) => { netSeen.push(a); return { tag: 'net' }; } } });
    globalThis.fetch = async () => { globalCalled++; throw new Error('不应回落 global fetch'); };
    const res = await proxyFetch('http://example.invalid/c', { method: 'POST' });
    assert.deepEqual(res, { tag: 'net' });
    assert.equal(netSeen.length, 1);
    assert.equal(netSeen[0][0], 'http://example.invalid/c');
    assert.deepEqual(netSeen[0][1], { method: 'POST' });
    assert.equal(globalCalled, 0);
});

test('proxyFetch：electron 存在但无 net.fetch → 回落 global fetch', async () => {
    setManualProxySource(() => settings(true, '127.0.0.1:7890'));
    invalidateCache();
    let globalCalled = 0;
    stubElectron({ net: {} });                       // net.fetch 缺失
    globalThis.fetch = async () => { globalCalled++; return { tag: 'fallback' }; };
    const res = await proxyFetch('http://example.invalid/d');
    assert.deepEqual(res, { tag: 'fallback' });
    assert.equal(globalCalled, 1);
});

test('proxyFetch：require("electron") 抛异常（渲染/纯 Node 环境）→ 回落 global fetch', async () => {
    setManualProxySource(() => settings(true, '127.0.0.1:7890'));
    invalidateCache();
    let globalCalled = 0;
    stubElectron({ __throws: new Error('electron 不可用') });
    globalThis.fetch = async () => { globalCalled++; return { tag: 'fallback2' }; };
    const res = await proxyFetch('http://example.invalid/e');
    assert.deepEqual(res, { tag: 'fallback2' });
    assert.equal(globalCalled, 1);
});

test('proxyFetch：net.fetch 拒绝 → 静默回落 global fetch（不向上抛 net 的错误）', async () => {
    setManualProxySource(() => settings(true, '127.0.0.1:7890'));
    invalidateCache();
    let globalCalled = 0;
    stubElectron({ net: { fetch: async () => { throw new Error('net boom'); } } });
    globalThis.fetch = async () => { globalCalled++; return { tag: 'recovered' }; };
    const res = await proxyFetch('http://example.invalid/f');
    assert.deepEqual(res, { tag: 'recovered' });
    assert.equal(globalCalled, 1);
});

test('proxyFetch：两条路都失败 → 错误向上传播给调用方', async () => {
    setManualProxySource(() => settings(true, '127.0.0.1:7890'));
    invalidateCache();
    stubElectron({ net: { fetch: async () => { throw new Error('net boom'); } } });
    globalThis.fetch = async () => { throw new Error('直连也失败：DNS 解析失败'); };
    await assert.rejects(
        () => proxyFetch('http://example.invalid/g'),
        (e) => { assert.equal(e.message, '直连也失败：DNS 解析失败'); return true; },
    );
});

test('proxyFetch：无代理时 global fetch 拒绝 → 错误同样传播', async () => {
    regImpl = () => { throw new Error('no reg'); };
    invalidateCache();
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(() => proxyFetch('http://example.invalid/h'), /offline/);
});

test('proxyFetch：代理状态沿 getProxyUrl 缓存一致（第二次调用不再重复探测）', async () => {
    let regCalls = 0;
    regImpl = (cmd) => {
        regCalls++;
        return /\/v\s+ProxyEnable/i.test(cmd) ? '    ProxyEnable    REG_DWORD    0x1\n'
            : '    ProxyServer    REG_SZ    127.0.0.1:7890\n';
    };
    invalidateCache();
    const netSeen = [];
    stubElectron({ net: { fetch: async (...a) => { netSeen.push(a[0]); return { ok: true }; } } });
    await proxyFetch('http://example.invalid/i1');
    await proxyFetch('http://example.invalid/i2');
    assert.deepEqual(netSeen, ['http://example.invalid/i1', 'http://example.invalid/i2']);
    assert.equal(regCalls, 2, '两次 fetch 共享同一次探测结果（TTL 内缓存）');
});
