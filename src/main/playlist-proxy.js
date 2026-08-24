'use strict';
/**
 * playlist-proxy.js — 在线整季「原生播放列表」的本地按需解析代理。
 *
 * 背景：在线剧集的直链由源站懒解析且带签名时效（整季预解析既慢又会被风控，
 * 放进播放列表放到后面集数时早已过期），因此不能把真实直链交给 mpv 的原生
 * 播放列表。本模块把每一集映射成本地代理地址：
 *
 *     http://127.0.0.1:<port>/pl/<token>/<index>
 *
 * mpv 打开哪一集，代理才向后端 playerContent 解析哪一集，成功后 302 交给真实
 * CDN——直链零过期、整季在右键菜单/F8 可见可切、mpv 同进程连播推进。
 *
 * 边界（v1）：
 * - 仅支持 playerContent 直连源；parse=1（VIP 解析）/ DRM / 空地址的集目视为
 *   失败：返回 502 并回调 onEntryError（主进程 toast + 停止队列）；
 * - Range/Seek 由 mpv 直连上游完成，代理不占数据面带宽；各集差异化的
 *   Referer/UA 头暂不透传（同站各集通常一致，起播时全局 --http-header-fields 生效）。
 */
const http = require('http');
const { EventEmitter } = require('events');

const TOKEN_RE = /^\/pl\/([A-Za-z0-9_-]{8,64})\/(\d{1,4})$/;
const RESOLVE_TIMEOUT_MS = 12000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 8;

class PlaylistProxy extends EventEmitter {
    /**
     * @param {object} [opts]
     * @param {()=>({base:string,token:string}|null)} [opts.getBackend] 后端地址与令牌（惰性获取）
     * @param {({index:number, reason:string})=>void} [opts.onEntryError] 集目解析失败回调
     */
    constructor(opts = {}) {
        super();
        this.getBackend = typeof opts.getBackend === 'function' ? opts.getBackend : () => null;
        this.onEntryError = typeof opts.onEntryError === 'function' ? opts.onEntryError : null;
        this.fetchFn = opts.fetchFn || fetch; // 可注入（测试）
        // Kazumi 第二段解析：隐藏窗口抓真实流（index.js 注入 parseWin.captureDirect 适配）
        // 返回 {ok, url, header?}；注入才启用 Kazumi 分支。
        this.captureDirect = typeof opts.captureDirect === 'function' ? opts.captureDirect : null;
        this.sessions = new Map(); // token → 会话（catvod / kazumi 两种 kind）
        // insecureHTTPParser：mpv 会把全局 --http-header-fields 原样回放到本地代理，
        // 规则站返回的头值可能带尾随空格等"非严格合法"内容——宽容解析直接放行，
        // 避免整队被解析层 400 打死。仅绑定 127.0.0.1 且有 token 门控，风险可控。
        this.server = http.createServer({ insecureHTTPParser: true }, (req, res) => this._handle(req, res));
        // Node 解析层拒收（畸形头等）会默认回 400 且不进业务处理——必须留下现场才能定位
        this.server.on('clientError', (err, socket) => {
            console.warn('[播放列表] clientError:', (err && (err.code + ' ' + err.message)) || err);
            try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (e) { /* ignore */ }
        });
        // unref：代理不阻止进程退出（应用关闭/测试收尾不被常驻监听拖住）
        this.server.unref();
        this.basePromise = new Promise((resolve) => {
            this.server.listen(0, '127.0.0.1', () => {
                resolve(`http://127.0.0.1:${this.server.address().port}`);
            });
        });
        // 会话清理：TTL 过期即弃（播放器早已退出）；防长时间运行无限增长
        this.sweeper = setInterval(() => {
            const now = Date.now();
            for (const [tok, s] of this.sessions) {
                if (now - s.createdAt > SESSION_TTL_MS) this.sessions.delete(tok);
            }
        }, 30 * 60 * 1000);
        if (this.sweeper.unref) this.sweeper.unref();
    }

    /**
     * 登记一个整季队列，返回可直接放进 meta.playlist 的 entries。
     * ctx: { kind?, site, flag, pluginName?, vipFlags(JSON 字符串), eps:[{id,name}], start }
     * Kazumi 队列会先对起始集做一次预热解析（拿规则 Referer/UA），随 entries 一并返回：
     * 主进程把它设为全局 --http-header-fields，保证清单与分片请求都带规则头。
     */
    async register(ctx) {
        const eps = Array.isArray(ctx && ctx.eps)
            ? ctx.eps.filter((e) => e && String(e.id || '').trim())
                .map((e) => ({ id: String(e.id).trim(), name: String(e.name || '') }))
            : [];
        if (!eps.length) return { ok: false, reason: 'empty queue' };
        const base = await this.basePromise;
        const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        const kind = (ctx.kind === 'kazumi' && this.captureDirect) ? 'kazumi' : 'catvod';
        const start = Math.max(0, Math.min(eps.length - 1, Number(ctx.start) || 0));
        const sess = {
            kind,
            site: String(ctx.site || ''), flag: String(ctx.flag || ''),
            pluginName: String(ctx.pluginName || ''),
            seriesTitle: String(ctx.title || ''),
            vipFlags: String(ctx.vipFlags || '[]'), eps, createdAt: Date.now(),
            headers: null,      // 会话级规则头（Kazumi 预热产出；全局头由此而来）
            cache: new Map(),   // index → 已解析直链（预热命中的集不再重复解析）
        };
        this.sessions.set(token, sess);
        while (this.sessions.size > MAX_SESSIONS) {
            this.sessions.delete(this.sessions.keys().next().value);
        }
        let headers = null;
        if (kind === 'kazumi') {
            // 预热起始集：规则头必须在 mpv 启动前就绪（否则清单/分片裸连被拒）
            const warm = await this._withRetry(() => this._resolveKazumi(sess, start));
            if (!warm.ok) {
                if (this.onEntryError) {
                    try { this.onEntryError({ index: start, reason: warm.reason, sess }); } catch (e) { /* ignore */ }
                }
                return { ok: false, reason: warm.reason };
            }
            sess.headers = warm.header || {};
            sess.cache.set(start, warm.url);
            headers = sess.headers;
        }
        const entries = eps.map((e, i) => ({ url: `${base}/pl/${token}/${i}`, title: e.name }));
        return { ok: true, token, startIndex: start, entries, headers };
    }

    /** 会话级规则头（主进程起播时注入全局 --http-header-fields 用）。 */
    getSessionHeaders(token) {
        const s = this.sessions.get(String(token || ''));
        return (s && s.headers) || null;
    }

    _handle(req, res) {
        this._handleAsync(req, res).catch(() => {
            try { res.writeHead(502); res.end('proxy error'); } catch (e) { /* ignore */ }
        });
    }

    async _handleAsync(req, res) {
        const m = TOKEN_RE.exec(String(req.url || '').split('?')[0] || '');
        const sess = m ? this.sessions.get(m[1]) : null;
        const index = m ? parseInt(m[2], 10) : -1;
        if (!sess || index < 0 || index >= sess.eps.length) {
            res.statusCode = 404; res.end();
            return;
        }
        // 预热命中的集直接 302；其余按需解析后缓存。会话级规则头已提升为全局
        // --http-header-fields（register 预热产出），清单与分片都带规则头，
        // 因此所有条目统一轻量 302，代理不占数据面带宽。
        if (sess.cache.has(index)) {
            this._notifyResolved(sess, index, sess.cache.get(index));
            res.writeHead(302, { Location: sess.cache.get(index) });
            res.end();
            return;
        }
        const resolved = (sess.kind === 'kazumi')
            ? await this._withRetry(() => this._resolveKazumi(sess, index))
            : await this._withRetry(() => this._resolve(sess, index));
        console.log(`[播放列表] 第 ${index + 1} 集${resolved.ok
            ? `解析成功 → ${resolved.url.slice(0, 80)}`
            : `解析失败：${resolved.reason}`}`);
        if (!resolved.ok) {
            if (this.onEntryError) {
                try { this.onEntryError({ index, reason: resolved.reason, sess }); } catch (e) { /* ignore */ }
            }
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(resolved.reason);
            return;
        }
        sess.cache.set(index, resolved.url);
        this._notifyResolved(sess, index, resolved.url);
        res.writeHead(302, { Location: resolved.url });
        res.end();
    }

    /** 单集解析成功通知（边下边播入队等订阅方使用）。 */
    _notifyResolved(sess, index, url) {
        this.emit('entry-resolved', {
            index,
            url,
            title: (sess.eps[index] && sess.eps[index].name) || '',
            sess,
        });
    }

    /** 解析失败自动重试一次：源站冷启动（DNS/TLS 握手）的瞬时抖动不应整队判死。 */
    async _withRetry(fn) {
        let last = { ok: false, reason: 'resolve failed' };
        for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) await new Promise((res) => setTimeout(res, 600));
            last = await fn();
            if (last.ok) return last;
        }
        return last;
    }

    /** Kazumi 两段解析：kazumiResolve 拿播放页 → captureDirect（隐藏窗口）抓真实流。 */
    async _resolveKazumi(sess, index) {
        const backend = this.getBackend() || null;
        if (!backend || !backend.base) return { ok: false, reason: '后端未就绪' };
        let pageUrl = sess.eps[index].id;
        let legacy = false;
        const header = {};
        try {
            const body = new URLSearchParams({
                do: 'kazumiResolve', pluginName: sess.pluginName, url: pageUrl,
            }).toString();
            const rsp = await this.fetchFn(`${backend.base}/kazumi/action?token=${encodeURIComponent(backend.token || '')}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
            });
            const data = await rsp.json().catch(() => null);
            if (!data) return { ok: false, reason: 'Kazumi 规则返回异常' };
            pageUrl = String(data.pageUrl || pageUrl);
            if (data.userAgent) header['User-Agent'] = data.userAgent;
            if (data.referer) header.Referer = data.referer;
            legacy = !!data.useLegacyParser;
        } catch (e) {
            return { ok: false, reason: 'Kazumi 解析请求失败' };
        }
        try {
            const cap = await this.captureDirect(pageUrl, legacy);
            if (!cap || !cap.url) return { ok: false, reason: '未抓取到可播放地址' };
            return { ok: true, url: String(cap.url), header: { ...header, ...(cap.header || {}) } };
        } catch (e) {
            return { ok: false, reason: '抓取真实流失败' };
        }
    }

    /** 管道转发：带规则头请求上游，关键响应头回写，Range 透传（拖动 seek 可用）。 */
    _pipeUpstream(url, extraHeaders, req, res) {
        return new Promise((resolve) => {
            let u;
            try { u = new URL(url); } catch (e) {
                res.writeHead(502).end('bad upstream url');
                resolve({ ok: false, reason: '上游地址非法' });
                return;
            }
            const upstreamReq = http.request({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method: 'GET',
                headers: { ...extraHeaders, Range: req.headers.range || 'bytes=0-' },
            }, (upRes) => {
                res.writeHead(upRes.statusCode || 502, {
                    'Content-Type': upRes.headers['content-type'] || 'video/mp4',
                    'Accept-Ranges': upRes.headers['accept-ranges'] || 'bytes',
                    ...(upRes.headers['content-range'] ? { 'Content-Range': upRes.headers['content-range'] } : {}),
                    ...(upRes.headers['content-length'] ? { 'Content-Length': upRes.headers['content-length'] } : {}),
                });
                upRes.pipe(res);
                upRes.on('end', () => resolve({ ok: true }));
                upRes.on('error', () => resolve({ ok: false }));
            });
            upstreamReq.on('error', () => {
                try { res.writeHead(502); res.end('upstream error'); } catch (e) { /* ignore */ }
                resolve({ ok: false, reason: '上游连接失败' });
            });
            upstreamReq.end();
        });
    }

    /** 调后端 playerContent 解析第 index 集；parse=1 / DRM / 空地址视为该集失败。 */
    async _resolve(sess, index) {
        const backend = this.getBackend() || null;
        if (!backend || !backend.base) return { ok: false, reason: '后端未就绪' };
        const ep = sess.eps[index];
        const body = new URLSearchParams({
            do: 'playerContent', site: sess.site, flag: sess.flag,
            id: ep.id, vipFlags: sess.vipFlags || '[]', refresh: '0',
        }).toString();
        const rsp = await this.fetchFn(`${backend.base}/action?token=${encodeURIComponent(backend.token || '')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        });
        const data = await rsp.json().catch(() => null);
        if (!data || data.error) {
            const err = data && data.error;
            const reason = err ? String(err.message || err.code || '源返回错误') : '源返回错误';
            return { ok: false, reason };
        }
        if (data.drm) return { ok: false, reason: '需要 DRM，桌面版暂不支持' };
        const url = String(data.url || '').trim();
        if (!url) return { ok: false, reason: '播放地址为空' };
        if (Number(data.parse) === 1) return { ok: false, reason: '该集需 VIP 解析线路，原生连播暂不支持' };
        return { ok: true, url };
    }

    close() {
        try { this.server.close(); } catch (e) { /* ignore */ }
        if (this.sweeper) clearInterval(this.sweeper);
    }
}

module.exports = { PlaylistProxy };
