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

/** 读系统代理 → 'http://host:port' | ''。优先环境变量 HTTPS_PROXY/HTTP_PROXY。 */
function getProxyUrl() {
    if (_cached !== null && Date.now() - _cacheAt < TTL) return _cached;
    let url = '';
    const envP = process.env.HTTPS_PROXY || process.env.https_proxy
        || process.env.HTTP_PROXY || process.env.http_proxy;
    if (envP) url = /^https?:\/\//i.test(envP) ? envP : `http://${envP}`;
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

module.exports = { getProxyUrl, proxyEnv, proxyFetch };
