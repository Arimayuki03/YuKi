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
 *
 * 增强（T46）：
 * - 视频源解析池：固定 3 个独立 partition（parse-0/1/2），并发解析互不冲突
 *   （session.webRequest 每 session 仅一份，共用一个 partition 时后注册的
 *    onBeforeRequest 会覆盖前一个 → 并发丢失媒体请求；分槽隔离后各自独立）
 * - Cookie 持久化：解析/验证会话产生的 Cookie 读回推给后端 CookieJar，
 *   规则引擎发请求自动带上，重启后无需重新验证
 */
const { BrowserWindow } = require('electron');

const MEDIA_EXT = /\.(m3u8|mp4|flv|mov|mkv|webm|ts)(\?|#|$)/i;
const IFRAME_TIMEOUT = 20000;
const POOL_SIZE = 3; // 解析池并发窗口数

class ParseWindow {
    /** @param getInfo 返回 { base, token } 的后端信息提供函数 */
    constructor(getInfo) {
        this.getInfo = getInfo;
        this._slots = [];   // 空闲槽位（分区名 parse-0..POOL_SIZE-1）
        this._waiters = [];
        for (let i = 0; i < POOL_SIZE; i++) this._slots.push(i);
    }

    // ------------------------------------------------------------ 解析池

    _acquire() {
        return new Promise((resolve) => {
            const take = () => {
                const s = this._slots.shift();
                if (s !== undefined) resolve(s);
                else this._waiters.push(take);
            };
            take();
        });
    }

    _release(slot) {
        const w = this._waiters.shift();
        if (w) w();
        else this._slots.push(slot);
    }

    // ------------------------------------------------------------ Cookie 推送

    /** 把解析会话产生的 Cookie 按域名推给后端 CookieJar 持久化（fire-and-forget）。 */
    _pushCookies(cookies) {
        if (!cookies || !cookies.length) return;
        try {
            const info = this.getInfo && this.getInfo();
            if (!info || !info.base) return;
            const byDomain = {};
            for (const c of cookies) {
                if (!c || !c.name) continue;
                const host = String(c.domain || '').replace(/^\./, '').toLowerCase().replace(/:\d+$/, '');
                if (!host) continue;
                (byDomain[host] = byDomain[host] || []).push({ name: c.name, value: c.value });
            }
            for (const [domain, list] of Object.entries(byDomain)) {
                const body = new URLSearchParams({
                    do: 'kazumiCookieSet', domain, cookies: JSON.stringify(list),
                });
                fetch(`${info.base}/kazumi/action?token=${encodeURIComponent(info.token || '')}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body,
                }).catch(() => { /* 推送失败不影响解析 */ });
            }
        } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------ 解析

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

    /** 隐藏窗口加载 url，webRequest 捕获媒体直链（_tryIframe/captureDirect 共用）。
     *  从解析池取一个独立 partition 槽位，并发捕获互不干扰。 */
    _capture({ url, via, timeout }) {
        return this._acquire().then((slot) => new Promise((resolve) => {
            let win;
            try {
                win = new BrowserWindow({
                    show: false, width: 800, height: 600,
                    webPreferences: {
                        partition: `parse-${slot}`, // 独立槽位会话：并发解析不冲突
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: true,
                    },
                });
            } catch (e) { this._release(slot); return resolve(null); }

            const ses = win.webContents.session;
            let settled = false;
            const done = (r) => {
                try { win.destroy(); } catch (e) { /* ignore */ }
                this._release(slot);
                resolve(r);
            };
            const finish = (r) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { ses.webRequest.onBeforeRequest(null); } catch (e) { /* ignore */ }
                // 先读会话 Cookie 再销毁窗口（session 随最后窗口关闭销毁）；推给后端持久化
                ses.cookies.get({}).then((cookies) => {
                    this._pushCookies(cookies);
                    done(r);
                }).catch(() => done(r));
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
        }));
    }
}

module.exports = ParseWindow;
