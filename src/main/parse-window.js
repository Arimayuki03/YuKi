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
const IFRAME_TIMEOUT = 12000;
const POOL_SIZE = 3; // 解析池并发窗口数

/** http(s) 且路径命中媒体扩展名 → 可交 mpv 的直链。 */
function isMediaUrl(u) {
    if (!/^https?:\/\//i.test(u)) return false;
    try { return MEDIA_EXT.test(new URL(u).pathname); } catch (e) { return false; }
}

/** 仅 http(s) 才允许交给隐藏窗口 loadURL；其余（畸形拼接如 demohttps://、
 *  或 intent://、magnet: 等非法/自定义 scheme）会被 Chromium 移交操作系统，
 *  弹出「用什么应用打开此链接」系统弹窗（T：解析视频弹 demohttps 系统弹窗根因）。 */
function isLoadableUrl(u) {
    return /^https?:\/\//i.test(String(u || ''));
}

function mergeHeaders(...sources) {
    const out = {};
    const keys = new Map();
    const queue = [...sources];
    while (queue.length) {
        let source = queue.shift();
        if (typeof source === 'string') {
            const text = source.trim();
            try { source = text && text[0] === '{' ? JSON.parse(text) : Object.fromEntries(
                text.split(/\r?\n/).filter((line) => line.includes(':'))
                    .map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]));
            } catch (e) { source = null; }
        }
        if (Array.isArray(source)) { queue.unshift(...source); continue; }
        if (!source || typeof source !== 'object') continue;
        for (const [rawKey, rawValue] of Object.entries(source)) {
            if (rawValue === null || rawValue === undefined || rawValue === '') continue;
            const key = String(rawKey).trim();
            if (!key) continue;
            const lower = key.toLowerCase();
            const old = keys.get(lower);
            if (old) delete out[old];
            keys.set(lower, key);
            out[key] = String(rawValue);
        }
    }
    return out;
}

function parserHeaders(parser) {
    const ext = parser && parser.ext && typeof parser.ext === 'object' ? parser.ext : {};
    return mergeHeaders(ext.header, ext.headers, parser && parser.header, parser && parser.headers);
}

function parserFlags(parser) {
    const ext = parser && parser.ext && typeof parser.ext === 'object' ? parser.ext : {};
    const raw = ext.flag !== undefined ? ext.flag
        : (parser && (parser.flag !== undefined ? parser.flag : parser.flags));
    if (Array.isArray(raw)) return raw.map(String);
    if (raw === null || raw === undefined || raw === '') return [];
    return String(raw).split(',').map((item) => item.trim()).filter(Boolean);
}

function matchesFlag(parser, flag) {
    const flags = parserFlags(parser);
    return !flags.length || !flag || flags.includes(String(flag));
}

function cookieHeaderForUrl(cookies, rawUrl) {
    let url;
    try { url = new URL(String(rawUrl || '')); } catch (e) { return ''; }
    const now = Date.now() / 1000;
    const pairs = [];
    for (const cookie of cookies || []) {
        if (!cookie || !cookie.name || cookie.expirationDate && cookie.expirationDate <= now) continue;
        const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
        const host = url.hostname.toLowerCase();
        if (domain && host !== domain && !host.endsWith(`.${domain}`)) continue;
        if (cookie.secure && url.protocol !== 'https:') continue;
        const path = String(cookie.path || '/');
        if (path && !url.pathname.startsWith(path)) continue;
        pairs.push(`${cookie.name}=${cookie.value || ''}`);
    }
    return pairs.join('; ');
}

function parserExtUrl(parser) {
    const url = String(parser && parser.url || '');
    const ext = parser && parser.ext && typeof parser.ext === 'object' ? parser.ext : {};
    if (!Object.keys(ext).length || !url.includes('?')) return url;
    const encoded = Buffer.from(JSON.stringify(ext), 'utf8').toString('base64url');
    const index = url.indexOf('?');
    return `${url.slice(0, index + 1)}cat_ext=${encoded}&${url.slice(index + 1)}`;
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
 *  记录到 window.__yuki_iframe_src（最后一次生效）。跨文档导航会重置 window，守卫防 SPA 重复挂载。 */
const JS_LEGACY_IFRAME = `(() => {
  if (window.__yuki_legacy_ready) return;
  window.__yuki_legacy_ready = true;
  window.__yuki_iframe_src = '';
  const capture = (f) => {
    try { const s = f && f.getAttribute && f.getAttribute('src'); if (s) window.__yuki_iframe_src = s; } catch (e) {}
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
const JS_GET_IFRAME_SRC = `(() => { try { return window.__yuki_iframe_src || ''; } catch (e) { return ''; } })()`;

class ParseWindow {
    /** @param getInfo 返回 { base, token } 的后端信息提供函数 */
    constructor(getInfo, probe) {
        this.getInfo = getInfo;
        this.probe = typeof probe === 'function' ? probe : null;
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
     * @param abort 可选取消标记 { requested }：置位后本次解析立即作废——
     *        停止后续接口尝试/窗口导航并释放解析池槽位（调用方 25s 安全超时用）。
     * @returns {{ok:true, url:string, header?:object, via?:string} | {ok:false, reason:string}}
     */
    async resolve(targetUrl, parsesOverride, legacy, abort, context = {}) {
        if (!/^https?:\/\//i.test(String(targetUrl || ''))) {
            return { ok: false, reason: 'bad target url' };
        }
        const parses = parsesOverride || await this._fetchParses();
        const list = (parses || []).filter((p) => p && (p.url || parseInt(p.type, 10) === 4));
        if (!list.length) return { ok: false, reason: 'no-parses' };

        // 显式 priority/order 优先；未声明时严格保持配置顺序。解析器 type
        // 决定执行引擎，不隐式改写用户配置的优先级。
        const ordered = list.map((parser, index) => ({ parser, index }))
            .sort((a, b) => {
                const rank = (item) => Number.isFinite(Number(item.parser.priority))
                    ? Number(item.parser.priority)
                    : (Number.isFinite(Number(item.parser.order)) ? Number(item.parser.order) : item.index);
                return rank(a) - rank(b) || a.index - b.index;
            });
        const selectedName = String(context.parserName || '');
        // ext.flag 只是**偏好**：上游 `VodConfig.getParses(type, flag)` 用
        // `filter.isEmpty() ? items : filter` 兜底，没有解析器声明这条线路时
        // 仍然按配置顺序试全部解析器，而不是直接放弃解析。
        const byFlag = ordered.filter(({ parser }) => matchesFlag(parser, context.flag));
        const selected = selectedName
            ? ordered.filter(({ parser }) => [parser.name, parser.id, parser.key]
                .filter((value) => value !== null && value !== undefined).map(String).includes(selectedName))
            : (byFlag.length ? byFlag : ordered);
        if (!selected.length) return { ok: false, reason: selectedName ? 'parser-not-found' : 'no-matching-parser' };
        for (const item of selected) {
            if (abort && abort.requested) return { ok: false, reason: 'aborted' };
            const type = parseInt(item.parser.type, 10);
            const raw = type === 4
                ? await this._trySuper(item.parser, ordered, targetUrl, legacy, abort, context)
                : await this._tryParser(item.parser, targetUrl, legacy, abort, context, ordered);
            const result = await this._validateResult(raw, item.parser, abort);
            if (result) return result;
        }
        return { ok: false, reason: 'resolve-failed' };
    }

    async _validateResult(result, parser, abort) {
        if (!result || !result.ok || !result.url) return null;
        if (result.probed || !this.probe || result.skipProbe || parser && parser.skipProbe) return result;
        if (abort && abort.requested) return null;
        const probed = await this.probe(result.url, {
            headers: result.header, timeoutMs: 8000,
        });
        if (!probed || !probed.ok || abort && abort.requested) return null;
        return { ...result, url: probed.finalUrl || result.url,
            header: mergeHeaders(result.header, probed.headers), probed: true };
    }

    async _trySuper(_parse, ordered, targetUrl, legacy, abort, context) {
        // type 4 聚合只跑 type 0/1 候选；flag 同样是偏好——没有候选声明这条线路
        // 时用全部 type 0/1 候选（对齐 `VodConfig.getParses(type, flag)`）。
        const pool = ordered.filter(({ parser }) => {
            const type = parseInt(parser.type, 10);
            return type === 0 || type === 1;
        });
        const flagged = pool.filter(({ parser }) => matchesFlag(parser, context.flag));
        const candidates = flagged.length ? flagged : pool;
        if (!candidates.length) return null;
        // JSON and Web parsers may execute concurrently, but selection waits
        // for all and walks priority order. A fast low-priority result cannot
        // steal a slow high-priority success.
        const results = await Promise.all(candidates.map(async ({ parser }) => {
            const raw = await this._tryParser(parser, targetUrl, legacy, abort, context, ordered);
            return this._validateResult(raw, parser, abort);
        }));
        for (let i = 0; i < candidates.length; i++) if (results[i]) return results[i];
        return null;
    }

    async _tryParser(parse, targetUrl, legacy, abort, context = {}, ordered = []) {
        const type = parseInt(parse.type, 10);
        if (type === 1) return this._tryJson(parse, targetUrl, abort);
        if (type === 2) return this._tryJsonExt(parse, targetUrl, ordered, abort, context);
        if (type !== 0) return null;
        if (!isLoadableUrl(String(parse.url || '') + targetUrl)) return null;
        return this._tryIframe(parse, targetUrl, IFRAME_TIMEOUT, legacy, abort, context);
    }

    _jsonPlayResult(data, parse) {
        if (!data || typeof data !== 'object') return null;
        const objects = [];
        const add = (value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value) || objects.includes(value)) return;
            objects.push(value);
        };
        add(data); add(data.data); add(data.result);
        if (data.data) { add(data.data.data); add(data.data.result); }
        if (data.result) { add(data.result.data); add(data.result.result); }
        let url = '';
        let owner = data;
        for (const object of objects) {
            const candidate = object.url || object.vurl || object.play_url || object.playUrl || object.src;
            if (candidate) { url = String(candidate); owner = object; break; }
        }
        if (!/^https?:\/\//i.test(url) || /\.html?(?:\?|$)/i.test(url)) return null;
        const headers = [];
        for (const object of objects) {
            headers.push(object.header, object.headers);
            const aliases = {};
            for (const [key, value] of Object.entries(object)) {
                const lower = key.toLowerCase();
                if (['user-agent', 'referer', 'origin', 'cookie', 'authorization'].includes(lower)) aliases[key] = value;
                if (lower === 'ua') aliases['User-Agent'] = value;
            }
            headers.push(aliases);
        }
        return {
            ok: true, url, header: mergeHeaders(parserHeaders(parse), ...headers),
            via: parse.name || 'json', parse: Number(owner.parse || data.parse || 0),
            jx: Number(owner.jx || data.jx || 0), skipProbe: !!(owner.skipProbe || data.skipProbe),
        };
    }

    /** type=1：GET parse.url+target，解析嵌套 JSON、headers 和重定向。 */
    async _tryJson(parse, targetUrl, abort) {
        let cancelPoll = null;
        let timeoutTimer = null;
        let controller = null;
        try {
            if (typeof AbortController === 'function') {
                controller = new AbortController();
                if (abort) {
                    cancelPoll = setInterval(() => {
                        if (abort.requested) controller.abort();
                    }, 50);
                }
            }
            let signal = controller ? controller.signal : undefined;
            if (controller && typeof AbortSignal !== 'undefined'
                && typeof AbortSignal.timeout === 'function') {
                const deadline = AbortSignal.timeout(15000);
                signal = typeof AbortSignal.any === 'function'
                    ? AbortSignal.any([controller.signal, deadline]) : controller.signal;
            } else if (controller) {
                timeoutTimer = setTimeout(() => controller.abort(), 15000);
            }
            if (abort && abort.requested) return null;
            const api = parse.url + targetUrl;
            const rsp = await fetch(api, { ...(signal ? { signal } : {}),
                headers: parserHeaders(parse), redirect: 'follow' });
            if (abort && abort.requested) return null;
            if (!rsp.ok) return null;
            const data = await rsp.json();
            if (abort && abort.requested) return null;
            return this._jsonPlayResult(data, parse);
        } catch (e) { /* 下一个接口；取消由调用方统一映射为 L4_PARSE_CANCELLED */
        } finally {
            if (cancelPoll) clearInterval(cancelPoll);
            if (timeoutTimer) clearTimeout(timeoutTimer);
        }
        return null;
    }

    /** type=2：调用当前 portable JAR 的 Json<key>.parse(jxs, url)。 */
    async _tryJsonExt(parse, targetUrl, ordered, abort, context) {
        const info = this.getInfo && this.getInfo();
        if (!info || !info.base || !context.site) return null;
        const jxs = {};
        for (const { parser } of ordered || []) {
            if (parseInt(parser.type, 10) === 1 && parser.name && parser.url) {
                jxs[String(parser.name)] = parserExtUrl(parser);
            }
        }
        const controller = new AbortController();
        const cancelPoll = abort ? setInterval(() => {
            if (abort.requested) controller.abort();
        }, 50) : null;
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const body = new URLSearchParams({
                do: 'parseExt', site: String(context.site), key: String(parse.url || ''),
                url: targetUrl, jxs: JSON.stringify(jxs),
                requestId: String(context.requestId || ''),
                playSessionId: String(context.playSessionId || ''),
            });
            const rsp = await fetch(`${info.base}/action?token=${encodeURIComponent(info.token || '')}`, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body, signal: controller.signal,
            });
            if (!rsp.ok || abort && abort.requested) return null;
            const data = await rsp.json();
            const result = this._jsonPlayResult(data, parse);
            if (!result) return null;
            // Extension parsers may return another page with parse/jx=1.
            if (result.parse === 1 || result.jx === 1) {
                const captured = await this._capture({ url: result.url, via: `${result.via}·web`,
                    timeout: IFRAME_TIMEOUT, legacy: false, abort, context,
                    headers: result.header });
                return captured ? { ...captured, header: mergeHeaders(result.header, captured.header) } : null;
            }
            return result;
        } catch (e) { return null;
        } finally {
            clearTimeout(timer);
            if (cancelPoll) clearInterval(cancelPoll);
        }
    }

    /** iframe 型：隐藏窗口加载解析页，webRequest 捕获媒体直链。 */
    _tryIframe(parse, targetUrl, timeout, legacy, abort, context) {
        return this._capture({ url: parse.url + targetUrl, via: parse.name || parse.url,
            timeout, legacy, abort, context, headers: parserHeaders(parse) });
    }

    /**
     * 直开页面抓媒体直链（推送的 share/播放页等非直链 URL）：
     * 隐藏窗口直接加载目标页，捕获其播放器发起的媒体请求。
     * legacy=true 时走旧解析器（useLegacyParser）：监听 iframe src 并跟随，直到命中媒体直链。
     * 同 key（legacy|url）并发调用经 AsyncSingleFlight 去重，只开一个窗口、共享结果。
     * @param abort 可选取消标记（resolve 同款）：置位后立即作废并释放槽位。
     *        注意单飞合并的并发调用共享同一窗口，任一调用方放弃即整体作废。
     */
    captureDirect(url, timeout = IFRAME_TIMEOUT, legacy, abort, context = {}) {
        if (!isLoadableUrl(url)) return Promise.resolve(null);
        const key = `${legacy ? 'L' : 'N'}|${context.playSessionId || ''}|${url}`;
        return this._captureFlight.run(key, () => this._capture({ url, via: 'page', timeout,
            legacy, abort, context, headers: context.header }));
    }

    /** 隐藏窗口加载 url，webRequest 捕获媒体直链（_tryIframe/captureDirect 共用）。
     *  从解析池取一个独立 partition 槽位，并发捕获互不干扰。
     *  legacy=true 走旧解析器：注入 MutationObserver 监听 iframe src，媒体直链即命中，
     *  非媒体页跟随加载（限深防环）；否则用 JS 轮询 <video>/<audio> 元素兜底。
     *  abort（可选）置位后立即 finish(null)：停止导航/轮询、销毁窗口并释放槽位。 */
    _capture({ url, via, timeout, legacy, abort, context = {}, headers = {} }) {
        return this._acquire().then((slot) => new Promise((resolve) => {
            let win;
            try {
                const sessionKey = String(context.playSessionId || context.requestId || Date.now())
                    .replace(/[^A-Za-z0-9_-]/g, '').slice(-48) || String(Date.now());
                win = new BrowserWindow({
                    show: false, width: 800, height: 600,
                    webPreferences: {
                        partition: `parse-${slot}-${sessionKey}`, // 每个播放会话独立；销毁窗口即清理
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: true,
                    },
                });
            } catch (e) { this._release(slot); return resolve(null); }

            const ses = win.webContents.session;
            // R5：隐藏窗口反复加载失败会累积 Electron 内部 did-stop-loading 监听器，放开上限抑制告警
            win.webContents.setMaxListeners(0);
            // 协议守卫：解析页里的跳转/新窗若是非 http(s) scheme（如广告跳 intent://、
            // 或畸形 demohttps://），Chromium 会移交系统 → 弹「打开方式」。一律拦截在窗口内。
            win.webContents.on('will-navigate', (ev, navUrl) => {
                if (!isLoadableUrl(navUrl)) { try { ev.preventDefault(); } catch (e) { /* ignore */ } }
            });
            win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            let settled = false;
            let initialLoadDone = false;  // 首个页面是否已成功加载（did-fail-load 快速失败判定用）
            let jsPoll = null;      // 视频元素轮询（非 legacy）
            let legacyPoll = null;  // iframe src 轮询（legacy）
            let abortPoll = null;   // 取消标记轮询（调用方放弃时立即作废）
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
                clearInterval(abortPoll);
                try { ses.webRequest.onBeforeRequest(null); } catch (e) { /* ignore */ }
                try { ses.webRequest.onBeforeSendHeaders(null); } catch (e) { /* ignore */ }
                // 先读会话 Cookie 再销毁窗口（session 随最后窗口关闭销毁）；推给后端持久化
                ses.cookies.get({}).then((cookies) => {
                    this._pushCookies(cookies);
                    if (r && r.url) {
                        const cookie = cookieHeaderForUrl(cookies, r.url);
                        const cookieHeader = cookie ? { Cookie: cookie } : {};
                        r = { ...r, header: mergeHeaders(headers, r.header, cookieHeader) };
                    }
                    done(r);
                }).catch(() => done(r));
            };
            const timer = setTimeout(() => finish(null), timeout);
            // 调用方放弃（25s 安全超时等）：轮询检测取消标记，命中即销毁窗口、释放槽位，
            // 不再等满 timeout 占着解析池
            if (abort) {
                abortPoll = setInterval(() => { if (abort.requested) finish(null); }, 100);
            }

            // R4：主框架加载失败（解析站死链/连接被拒）→ 秒级跳过该解析站，不必烧满 IFRAME_TIMEOUT。
            // 忽略：非主框架（页面内 iframe 失败）、ERR_ABORTED(-3，跟随加载/主动中断）、
            // 以及首帧已成功加载后的后续失败（legacy 跟随加载失败不误杀，交给轮询/超时兜底）。
            win.webContents.on('did-fail-load', (_e, errorCode, _desc, _vUrl, isMainFrame) => {
                if (settled) return;
                if (!isMainFrame || errorCode === -3 || initialLoadDone) return;
                finish(null);
            });

            const isMedia = (details) => {
                if (details.resourceType === 'media') return true;
                return isMediaUrl(details.url);
            };
            // onBeforeRequest 没有可靠的 requestHeaders；等到
            // onBeforeSendHeaders 再完成，确保 Cookie/Referer/Origin/Auth/UA
            // 与真正命中的媒体请求一致。
            ses.webRequest.onBeforeRequest((_details, cb) => cb({}));
            ses.webRequest.onBeforeSendHeaders((details, cb) => {
                const requestHeaders = details.requestHeaders || {};
                if (isMedia(details)) {
                    const mediaHeaders = {};
                    for (const [key, value] of Object.entries(requestHeaders)) {
                        if (['user-agent', 'referer', 'origin', 'cookie', 'authorization']
                            .includes(String(key).toLowerCase())) mediaHeaders[key] = value;
                    }
                    finish({ ok: true, url: details.url,
                        header: mergeHeaders(headers, mediaHeaders), via });
                }
                cb({ requestHeaders });
            });

            // 首帧加载完成：置位 initialLoadDone 后立即执行一次元素检测，比等 300ms 轮询快
            win.webContents.on('did-finish-load', () => {
                initialLoadDone = true;
                if (legacy) {
                    win.webContents.executeJavaScript(JS_LEGACY_IFRAME, true).catch(() => { });
                } else {
                    win.webContents.executeJavaScript(JS_POLL_VIDEO, true)
                        .then((srcs) => {
                            if (!Array.isArray(srcs) || settled) return;
                            for (const s of srcs) {
                                if (isMediaUrl(s) && s !== url) {
                                    finish({ ok: true, url: s, header: {}, via: `${via}·dom-ready` });
                                    return;
                                }
                            }
                        })
                        .catch(() => { /* 页面未就绪，等轮询 */ });
                }
            });

            if (legacy) {
                // 旧解析器（useLegacyParser）：监听 iframe src，媒体直链即命中；非媒体页跟随加载（限深防环）
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
                            // 非媒体页：跟随一次（防环 + 限深 + 仅 http(s)，畸形 scheme 不交系统）
                            if (isLoadableUrl(src) && src !== url && !followed.has(src) && depth < MAX_DEPTH) {
                                followed.add(src);
                                depth++;
                                win.loadURL(src).catch(() => { /* 跟随失败等超时 */ });
                            }
                        })
                        .catch(() => { /* 页面未就绪，下轮再试 */ });
                }, 300);
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
                }, 300);
            }

            const extraHeaders = Object.entries(mergeHeaders(headers))
                .map(([key, value]) => `${key}: ${value}`).join('\n');
            win.loadURL(url, extraHeaders ? { extraHeaders } : undefined)
                .catch(() => { /* 加载失败等超时 */ });
        }));
    }

    // ------------------------------------------------------------ 验证码验证

    /** 验证码源验证（T73）：可见窗口加载验证页供用户交互填写，关闭时收割会话 Cookie 推给后端持久化。
     *  验证通过后下次搜索自动带上 Cookie（rule_engine 搜索请求应用 cookie_jar）。返回 {ok:boolean}。 */
    captchaVerify(url, timeout = 180000) {
        return this._acquire().then((slot) => new Promise((resolve) => {
            let win;
            try {
                win = new BrowserWindow({
                    show: true, width: 900, height: 700,   // 可见窗口，用户可交互过验证
                    title: '验证码验证',
                    autoHideMenuBar: true,
                    icon: require('./app-icon').windowIcon(), // 预缩多表示图标（exe 图标插值缩会糊/残缺）
                    webPreferences: {
                        partition: `parse-${slot}`, // 独立槽位会话：与解析互不冲突
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: true,
                    },
                });
            } catch (e) { this._release(slot); return resolve({ ok: false }); }
            const ses = win.webContents.session;
            win.webContents.setMaxListeners(0);
            let settled = false;
            const done = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                // 先读会话 Cookie 再销毁窗口（session 随最后窗口关闭销毁）；推给后端持久化
                ses.cookies.get({}).then((cookies) => {
                    this._pushCookies(cookies);
                    try { win.destroy(); } catch (e) { /* ignore */ }
                    this._release(slot);
                    resolve({ ok });
                }).catch(() => {
                    try { win.destroy(); } catch (e) { /* ignore */ }
                    this._release(slot);
                    resolve({ ok });
                });
            };
            const timer = setTimeout(() => done(true), timeout); // 超时也尽力收 cookie
            win.on('closed', () => done(true)); // 用户关闭窗口即视为验证完成
            // 多步验证（输入→提交→跳转）每次加载完成都顺手收割一次 Cookie
            win.webContents.on('did-finish-load', () => {
                ses.cookies.get({}).then((cookies) => this._pushCookies(cookies)).catch(() => { });
            });
            // loadURL 在验证页发生跳转/重定向时会以 ERR_ABORTED 拒绝——这是正常导航，
            // 不能据此关闭窗口（否则用户还没填验证码窗口就自动消失）。仅记录，等用户手动关闭或超时。
            win.loadURL(url).catch((e) => {
                console.warn('[parse] captcha loadURL rejected (可能为跳转，忽略):', e && e.message);
            });
        }));
    }
}

module.exports = ParseWindow;
