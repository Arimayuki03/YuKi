/**
 * system-proxy.js — 系统代理探测（Windows WinINET 注册表 + 环境变量）
 *
 * 部分网络环境下外网须经本机代理客户端（如 Clash 混合端口）才可达；
 * 下载引擎（aria2c/ffmpeg）默认不读系统代理，需显式注入：
 * - aria2c：启动参数 --http-proxy/--https-proxy（downloader.js）
 * - ffmpeg：http_proxy/https_proxy 环境变量（hls-downloader.js）
 * - 主进程 fetch（m3u8 时长探测等）：经 Electron net.fetch
 *   （Chromium 网络栈自动跟随 WinINET 系统代理），无代理时回落 global fetch。
 */
const { execSync } = require('child_process');

let _cached = null;   // null=未探测；''=无代理；其余为代理 URL
let _cacheAt = 0;     // 用户可能随时开关系统代理，缓存加短 TTL 保持跟随
const TTL = 5000;

// 手动代理来源（由 index.js 在 settings 初始化后注入）：fn() → settings 实例
let _manualSource = null;

/** 解析/校验/规范化代理地址（仿 Kazumi ProxyUtils.parseProxyUrl + SystemProxyService._parseHostPort）：
 *  支持的格式：
 *  - http://127.0.0.1:7890 / https://127.0.0.1:7890
 *  - socks5://127.0.0.1:7890 / socks://127.0.0.1:7890
 *  - 裸 host:port：127.0.0.1:7890
 *  - IPv6：[::1]:7890
 *  规则：剥离 scheme → 端口必须为 1..65535 且为数字 → host 非空。
 *  返回规范化 URL（http/https/裸 → http://host:port；socks → socks5://host:port）；非法返回 ''。 */
function formatAndValidateProxyUrl(input) {
    if (typeof input !== 'string') return '';
    let url = input.trim();
    if (!url) return '';
    let proto = 'http';
    const m = /^(https?|socks5?):\/\//i.exec(url);
    if (m) {
        proto = m[1].toLowerCase() === 'socks' || m[1].toLowerCase() === 'socks5' ? 'socks5' : 'http';
        url = url.slice(m[0].length);
    }
    // 分离 host 与 port：IPv6 用 ] 定位，否则取最后一个 ':'（端口可能缺失）
    let host = url;
    let portStr = '';
    const closeB = url.indexOf(']');
    if (closeB >= 0) {
        host = url.slice(0, closeB + 1);
        const rest = url.slice(closeB + 1);
        if (rest.startsWith(':')) portStr = rest.slice(1);
        else if (rest) return '';
    } else {
        const idx = url.lastIndexOf(':');
        if (idx >= 0) {
            host = url.slice(0, idx);
            portStr = url.slice(idx + 1);
        }
    }
    host = host.replace(/^\[|\]$/g, '').trim();
    if (!host) return '';
    // IPv6 字面量（含 ':'）输出时必须保留方括号
    const hostOut = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    let port = 0;
    if (portStr) {
        port = Number(portStr);
        if (!Number.isInteger(port)) return '';
    }
    if (!portStr || port < 1 || port > 65535) return ''; // 必须显式端口且落在有效范围
    return proto === 'socks5' ? `socks5://${hostOut}:${port}` : `http://${hostOut}:${port}`;
}

/** 注册手动代理来源（settings 就绪后调用）。 */
function setManualProxySource(fn) { _manualSource = typeof fn === 'function' ? fn : null; }

/** 用力配置的手动代理（设置里 proxyEnable + proxyUrl，校验通过才返回）。 */
function getManualProxyUrl() {
    if (!_manualSource) return '';
    try {
        const s = _manualSource();
        if (!s || s.get('proxyEnable') !== true) return '';
        const url = formatAndValidateProxyUrl(s.get('proxyUrl') || '');
        return url;
    } catch (e) { return ''; }
}

/** 使代理缓存失效（保存手动代理后调用，避免 TTL 内读到旧值）。 */
function invalidateCache() { _cached = null; _cacheAt = 0; }

/** 取生效中的代理 → 'http://host:port' | 'socks5://host:port' | ''。
 *  优先级：手动配置代理（校验通过） > 系统代理/WinINET/环境变量。 */
function getProxyUrl() {
    if (_cached !== null && Date.now() - _cacheAt < TTL) return _cached;
    let url = getManualProxyUrl();
    if (!url) {
        const envP = process.env.HTTPS_PROXY || process.env.https_proxy
            || process.env.HTTP_PROXY || process.env.http_proxy;
        if (envP) url = formatAndValidateProxyUrl(envP) || (/^https?:\/\//i.test(envP) ? envP : `http://${envP}`);
        if (!url && process.platform === 'win32') {
            try {
                const reg = 'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"';
                const en = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(
                    execSync(`${reg} /v ProxyEnable`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
                if (en && parseInt(en[1], 16) === 1) {
                    const sv = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(
                        execSync(`${reg} /v ProxyServer`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
                    if (sv) {
                        let s = sv[1];
                        // 「http=host:port;https=host:port」分协议形式：取 https 段
                        if (s.includes('=')) {
                            const m = /https?=([^;]+)/i.exec(s);
                            if (m) s = m[1];
                        }
                        url = /^https?:\/\//i.test(s) ? s : `http://${s}`;
                    }
                }
            } catch (e) { /* 无系统代理 */ }
        }
    }
    _cached = url;
    _cacheAt = Date.now();
    return url;
}

/** 子进程注入用的代理环境变量；无代理返回空对象。 */
function proxyEnv() {
    const url = getProxyUrl();
    return url
        ? { http_proxy: url, https_proxy: url, HTTP_PROXY: url, HTTPS_PROXY: url }
        : {};
}

/**
 * 走系统代理的 fetch：有代理时用 Electron net.fetch（Chromium 栈自动跟随
 * WinINET 代理与分流规则），无代理或不可用时回落 global fetch 直连。
 */
async function proxyFetch(url, opts = {}) {
    if (getProxyUrl()) {
        try {
            const { net } = require('electron');
            if (net && typeof net.fetch === 'function') return await net.fetch(url, opts);
        } catch (e) { /* 回落直连 */ }
    }
    return fetch(url, opts);
}

module.exports = { getProxyUrl, proxyEnv, proxyFetch, formatAndValidateProxyUrl, setManualProxySource, invalidateCache };
