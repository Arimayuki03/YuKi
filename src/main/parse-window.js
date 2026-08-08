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
const { AsyncSingleFlight } = require('./async-session');

const MEDIA_EXT = /\.(m3u8|mp4|flv|mov|mkv|webm|ts)(\?|#|$)/i;
const IFRAME_TIMEOUT = 20000;
const POOL_SIZE = 3; // 解析池并发窗口数

/** http(s) 且路径命中媒体扩展名 → 可交 mpv 的直链。 */
function isMediaUrl(u) {
    if (!/^https?:\/\//i.test(u)) return false;
    try { return MEDIA_EXT.test(new URL(u).pathname); } catch (e) { return false; }
}

/** 注入页面的轮询脚本：收集 <video>/<audio> 的媒体直链（含 <source> 子元素）。
 *  覆盖 webRequest 未命中的场景（如资源经 XHR/fetch 拉取、resourceType 非 media）。 */
const JS_POLL_VIDEO = `(() => {
  const out = [];
  try {
    for (const el of document.querySelectorAll('video,audio')) {
      const s = el.currentSrc || el.getAttribute('src') || '';
      if (s && out.indexOf(s) < 0) out.push(s);
      const src = el.querySelector('source[src]');
      if (src) {
        const ss = src.getAttribute('src');
        if (ss && out.indexOf(ss) < 0) out.push(ss);
      }
    }
  } catch (e) {}
  return out;
})()`;

/** 旧解析器（useLegacyParser）注入脚本：MutationObserver 监听 iframe src，
 *  记录到 window.__vpc_iframe_src（最后一次生效）。跨文档导航会重置 window，守卫防 SPA 重复挂载。 */
const JS_LEGACY_IFRAME = `(() => {
  if (window.__vpc_legacy_ready) return;
  window.__vpc_legacy_ready = true;
  window.__vpc_iframe_src = '';
  const capture = (f) => {
    try { const s = f && f.getAttribute && f.getAttribute('src'); if (s) window.__vpc_iframe_src = s; } catch (e) {}
  };
  try {
    document.querySelectorAll('iframe').forEach(capture);
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.attributeName === 'src' && m.target && m.target.tagName === 'IFRAME') capture(m.target);
        else if (m.addedNodes) m.addedNodes.forEach((n) => {
          if (n.tagName === 'IFRAME') capture(n);
          else if (n.querySelectorAll) n.querySelectorAll('iframe').forEach(capture);
        });
      }
    });
    mo.observe(document.documentElement || document.body,
      { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  } catch (e) {}
})()`;
const JS_GET_IFRAME_SRC = `(() => { try { return window.__vpc_iframe_src || ''; } catch (e) { return ''; } })()`;

class ParseWindow {
    /** @param getInfo 返回 { base, token } 的后端信息提供函数 */
    constructor(getInfo) {
        this.getInfo = getInfo;
        this._slots = [];   // 空闲槽位（分区名 parse-0..POOL_SIZE-1）
        this._waiters = [];
        for (let i = 0; i < POOL_SIZE; i++) this._slots.push(i);
        this._captureFlight = new AsyncSingleFlight(); // 同 URL 并发捕获去重合并
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
    async resolve(targetUrl, parsesOverride, legacy) {
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
            const r = await this._tryIframe(p, targetUrl, IFRAME_TIMEOUT, legacy);
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
    _tryIframe(parse, targetUrl, timeout, legacy) {
        return this._capture({ url: parse.url + targetUrl, via: parse.name || parse.url, timeout, legacy });
    }

    /**
     * 直开页面抓媒体直链（推送的 share/播放页等非直链 URL）：
     * 隐藏窗口直接加载目标页，捕获其播放器发起的媒体请求。
     * legacy=true 时走旧解析器（useLegacyParser）：监听 iframe src 并跟随，直到命中媒体直链。
     * 同 key（legacy|url）并发调用经 AsyncSingleFlight 去重，只开一个窗口、共享结果。
     */
    captureDirect(url, timeout = IFRAME_TIMEOUT, legacy) {
        const key = `${legacy ? 'L' : 'N'}|${url}`;
        return this._captureFlight.run(key, () => this._capture({ url, via: 'page', timeout, legacy }));
    }

    /** 隐藏窗口加载 url，webRequest 捕获媒体直链（_tryIframe/captureDirect 共用）。
     *  从解析池取一个独立 partition 槽位，并发捕获互不干扰。
     *  legacy=true 走旧解析器：注入 MutationObserver 监听 iframe src，媒体直链即命中，
     *  非媒体页跟随加载（限深防环）；否则用 JS 轮询 <video>/<audio> 元素兜底。 */
    _capture({ url, via, timeout, legacy }) {
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
            let jsPoll = null;      // 视频元素轮询（非 legacy）
            let legacyPoll = null;  // iframe src 轮询（legacy）
            const done = (r) => {
                try { win.destroy(); } catch (e) { /* ignore */ }
                this._release(slot);
                resolve(r);
            };
            const finish = (r) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearInterval(jsPoll);
                clearInterval(legacyPoll);
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
                return isMediaUrl(details.url);
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

            if (legacy) {
                // 旧解析器（useLegacyParser）：监听 iframe src，媒体直链即命中；非媒体页跟随加载（限深防环）
                win.webContents.on('did-finish-load', () => {
                    win.webContents.executeJavaScript(JS_LEGACY_IFRAME, true).catch(() => { });
                });
                const followed = new Set();
                let depth = 0;
                const MAX_DEPTH = 2;
                legacyPoll = setInterval(() => {
                    if (settled) return;
                    win.webContents.executeJavaScript(JS_GET_IFRAME_SRC, true)
                        .then((src) => {
                            if (!src || settled) return;
                            if (isMediaUrl(src) && src !== url) {
                                finish({ ok: true, url: src, header: {}, via: `${via}·iframe` });
                                return;
                            }
                            // 非媒体页：跟随一次（防环 + 限深）
                            if (/^https?:\/\//i.test(src) && src !== url && !followed.has(src) && depth < MAX_DEPTH) {
                                followed.add(src);
                                depth++;
                                win.loadURL(src).catch(() => { /* 跟随失败等超时 */ });
                            }
                        })
                        .catch(() => { /* 页面未就绪，下轮再试 */ });
                }, 800);
            } else {
                // JS 注入兜底（第二机制）：轮询页面 <video>/<audio> 元素拿媒体直链，
                // 覆盖 webRequest 未命中（资源经 XHR/fetch 拉取、resourceType 非 media）的场景。
                // 仅认 http(s) 媒体扩展名；blob:/data: 页面内地址 mpv 播不了，忽略。
                jsPoll = setInterval(() => {
                    win.webContents.executeJavaScript(JS_POLL_VIDEO, true)
                        .then((srcs) => {
                            if (!Array.isArray(srcs) || settled) return;
                            for (const s of srcs) {
                                if (isMediaUrl(s) && s !== url) {
                                    finish({ ok: true, url: s, header: {}, via: `${via}·页面媒体元素` });
                                    return;
                                }
                            }
                        })
                        .catch(() => { /* 页面未就绪/跨域限制，下轮再试 */ });
                }, 800);
            }

            win.loadURL(url).catch(() => { /* 加载失败等超时 */ });
        }));
    }
}

module.exports = ParseWindow;
