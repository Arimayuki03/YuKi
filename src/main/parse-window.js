/**
 * parse-window.js — VIP 解析隐藏窗口（Phase 7.3）
 *
 * 对齐原版 assets/parse.html 的 iframe 聚合思路，PC 化：
 * - type=1 JSON 解析：直接 GET 接口（parse url 拼接目标地址），取返回 JSON 的 url
 * - 其余（iframe 型）：隐藏 BrowserWindow 加载 `<parse.url><目标url>`，
 *   用 session webRequest 捕获解析页加载出的媒体直链（.m3u8/.mp4/... 或
 *   resourceType=media），顺带抓 Referer 头交给 mpv
 * - parses 列表来自后端 /sites（config 系统已存），也可注入（测试用）
 * - 每个解析接口 20s 超时，按序尝试，首个成功即返回
 */
const { BrowserWindow } = require('electron');

const MEDIA_EXT = /\.(m3u8|mp4|flv|mov|mkv|webm|ts)(\?|#|$)/i;
const IFRAME_TIMEOUT = 20000;

class ParseWindow {
    /** @param getInfo 返回 { base, token } 的后端信息提供函数 */
    constructor(getInfo) {
        this.getInfo = getInfo;
    }

    /** 取 config 里的 parses（后端 /sites）。 */
    async _fetchParses() {
        const info = this.getInfo && this.getInfo();
        if (!info || !info.base) return [];
        try {
            const rsp = await fetch(`${info.base}/sites?token=${info.token}`,
                { signal: AbortSignal.timeout(5000) });
            const data = await rsp.json();
            return Array.isArray(data.parses) ? data.parses : [];
        } catch (e) { return []; }
    }

    /**
     * 解析目标地址为可播直链。
     * @returns {{ok:true, url:string, header?:object, via?:string} | {ok:false, reason:string}}
     */
    async resolve(targetUrl, parsesOverride) {
        if (!/^https?:\/\//i.test(String(targetUrl || ''))) {
            return { ok: false, reason: 'bad target url' };
        }
        const parses = parsesOverride || await this._fetchParses();
        const list = (parses || []).filter((p) => p && p.url);
        if (!list.length) return { ok: false, reason: 'no-parses' };

        // type=1 JSON 解析优先（无需窗口，快）
        for (const p of list.filter((x) => parseInt(x.type, 10) === 1)) {
            const r = await this._tryJson(p, targetUrl);
            if (r) return r;
        }
        // iframe 型逐个尝试
        for (const p of list.filter((x) => parseInt(x.type, 10) !== 1)) {
            const r = await this._tryIframe(p, targetUrl, IFRAME_TIMEOUT);
            if (r) return r;
        }
        return { ok: false, reason: 'resolve-failed' };
    }

    /** type=1：GET parse.url+target，解析返回 JSON 里的直链（兼容多种字段名与 header 附带）。 */
    async _tryJson(parse, targetUrl) {
        try {
            const api = parse.url + targetUrl;
            const rsp = await fetch(api, { signal: AbortSignal.timeout(15000) });
            const data = await rsp.json();
            const d = data && data.data && typeof data.data === 'object' ? data.data : {};
            const url = data && (data.url || d.url || data.vurl || d.vurl || data.play_url || d.play_url);
            // 解出的是播放页（.html）而非媒体直链，视为失败交给下一种方式
            if (url && /^https?:\/\//i.test(url) && !/\.html?(\?|$)/i.test(url)) {
                const header = {};
                const referer = (data.header && data.header.Referer) || data.referer || d.referer;
                const ua = (data.header && (data.header['User-Agent'] || data.header.ua)) || data.ua;
                if (referer) header.Referer = referer;
                if (ua) header['User-Agent'] = ua;
                return { ok: true, url, header, via: parse.name || 'json' };
            }
        } catch (e) { /* 下一个接口 */ }
        return null;
    }

    /** iframe 型：隐藏窗口加载解析页，webRequest 捕获媒体直链。 */
    _tryIframe(parse, targetUrl, timeout) {
        return this._capture({ url: parse.url + targetUrl, via: parse.name || parse.url, timeout });
    }

    /**
     * 直开页面抓媒体直链（推送的 share/播放页等非直链 URL）：
     * 隐藏窗口直接加载目标页，捕获其播放器发起的媒体请求。
     */
    captureDirect(url, timeout = IFRAME_TIMEOUT) {
        return this._capture({ url, via: 'page', timeout });
    }

    /** 隐藏窗口加载 url，webRequest 捕获媒体直链（_tryIframe/captureDirect 共用）。 */
    _capture({ url, via, timeout }) {
        return new Promise((resolve) => {
            let win;
            try {
                win = new BrowserWindow({
                    show: false, width: 800, height: 600,
                    webPreferences: {
                        partition: 'parse',       // 独立 session，不污染主窗口
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: true,
                    },
                });
            } catch (e) { return resolve(null); }

            const ses = win.webContents.session;
            let settled = false;
            const finish = (r) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { ses.webRequest.onBeforeRequest(null); } catch (e) { /* ignore */ }
                try { win.destroy(); } catch (e) { /* ignore */ }
                resolve(r);
            };
            const timer = setTimeout(() => finish(null), timeout);

            const isMedia = (details) => {
                if (details.resourceType === 'media') return true;
                try {
                    const u = new URL(details.url);
                    return MEDIA_EXT.test(u.pathname);
                } catch (e) { return false; }
            };
            ses.webRequest.onBeforeRequest((details, cb) => {
                if (isMedia(details)) {
                    const h = details.requestHeaders || {};
                    const referer = h.Referer || h.referer;
                    finish({
                        ok: true, url: details.url,
                        header: referer ? { Referer: referer } : {},
                        via,
                    });
                }
                cb({});
            });

            win.loadURL(url).catch(() => { /* 加载失败等超时 */ });
        });
    }
}

module.exports = ParseWindow;
