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
 * - Range/Seek 由 mpv 直连上游完成，代理不占数据面带宽；Referer/UA 以「起始集
 *   预热」产出的会话头为准（register 返回给调用方：内置 mpv 注入全局头，
 *   外部播放器拼进启动开关），其余各集沿用同一会话头。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const TOKEN_RE = /^\/pl\/([A-Za-z0-9_-]{8,64})\/(\d{1,4})(?:\.[a-z0-9]{1,5})?$/i;
// 分片/子清单端点：/seg/<token>/<index>/<base64url(上游绝对地址)>
const SEG_RE = /^\/seg\/([A-Za-z0-9_-]{8,64})\/(\d{1,4})(?:\.[a-z0-9]{1,5})?\/([A-Za-z0-9_-]+)$/i;
const RESOLVE_TIMEOUT_MS = 12000;
const UPSTREAM_TIMEOUT_MS = 15000;
const MANIFEST_MAX_BYTES = 6 * 1024 * 1024;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 8;

/** base64url（URL 路径安全）：上游地址进路径用 */
function b64u(s) {
    return Buffer.from(String(s), 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
    return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** 从直链提取扩展名提示（PotPlayer 对无扩展名 URL 发 Icy-MetaData 当音频流处理，
 *  实测只出声音——代理地址需携带与内容一致的伪扩展名引导播放器走正确解码路径）。
 *  已知视频/清单扩展名照搬；无法识别时默认 .m3u8（带鉴权的在线直链绝大多数为 HLS）。 */
function hintExt(directUrl) {
    let ext = '';
    try { ext = path.extname(new URL(String(directUrl)).pathname).toLowerCase(); } catch (e) { /* 非法 URL 无提示 */ }
    return /^\.(m3u8?|mp4|m4v|mkv|flv|ts|webm|mov|avi)$/.test(ext) ? ext : '.m3u8';
}

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
        // 上游请求专用 agent（http/https 各一）：keep-alive 复用连接降低分片转发开销；
        // close() 时 destroy——全局默认 agent 的池化 socket 无法按实例回收，会让
        // 测试进程在所有用例结束后仍不退出（实测）。
        this.upAgents = {
            http: new http.Agent({ keepAlive: true, maxSockets: 16 }),
            https: new https.Agent({ keepAlive: true, maxSockets: 16 }),
        };
        // Node 解析层拒收（畸形头等）会默认回 400 且不进业务处理——必须留下现场才能定位。
        // 已知噪音源聚合计数：① PotPlayer 对含中文集名的条目先发未编码请求行
        // （HPE_INVALID_URL，随后自行编码重试成功）；② 播放器探测性断连
        // （ECONNRESET/ECONNABORTED）——同类连续错误只记首条与总数，避免刷屏。
        this._clientErrAggr = { sig: '', count: 0 };
        this.server.on('clientError', (err, socket) => {
            const sig = String((err && err.code) || err);
            const aggr = this._clientErrAggr;
            if (aggr.sig === sig) {
                aggr.count += 1;
            } else {
                if (aggr.count > 0) console.log(`[播放列表] clientError ${aggr.sig} ×${aggr.count}（同类已聚合）`);
                aggr.sig = sig;
                aggr.count = 1;
                console.warn('[播放列表] clientError:', sig, (err && err.message) || '');
            }
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
     * ctx: { kind?, site, flag, pluginName?, vipFlags(JSON 字符串), eps:[{id,name}], start, pipe?, headers? }
     * - kind='static'（静态直链会话）：eps[].id 即真实可播直链，不经后端解析；
     *   会话头从 ctx.headers 注入（上游鉴权由代理承担）。供外部播放器（PotPlayer
     *   命令行开关不可靠，实测会把开关拼进请求行）包管道用。
     * - pipe=true（外部主播放器会话）：条目不再 302，而是代理带会话头转发上游——
     *   HLS 清单重写回 /seg 分片端点，播放器只与 127.0.0.1 通信。PotPlayer/VLC 对
     *   重定向后的 CDN 直连无法可靠携带鉴权头（命令行开关在闭源解析器上不可靠、
     *   且不支持 #EXTVLCOPT），管道模式是唯一不依赖播放器头支持的通道。
     * - Kazumi 队列会先对起始集做一次预热解析（拿规则 Referer/UA），随 entries 一并返回：
     *   主进程把它设为全局 --http-header-fields，保证清单与分片请求都带规则头。
     */
    async register(ctx) {
        const eps = Array.isArray(ctx && ctx.eps)
            ? ctx.eps.filter((e) => e && String(e.id || '').trim())
                .map((e) => ({ id: String(e.id).trim(), name: String(e.name || ''), hint: String(e.hint || '') }))
            : [];
        if (!eps.length) return { ok: false, reason: 'empty queue' };
        const base = await this.basePromise;
        const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        const kind = (ctx.kind === 'kazumi' && this.captureDirect) ? 'kazumi'
            : (ctx.kind === 'static') ? 'static' : 'catvod';
        const start = Math.max(0, Math.min(eps.length - 1, Number(ctx.start) || 0));
        const sess = {
            token,              // 会话令牌（清单重写时拼 /seg 端点用）
            kind,
            site: String(ctx.site || ''), flag: String(ctx.flag || ''),
            pluginName: String(ctx.pluginName || ''),
            seriesTitle: String(ctx.title || ''),
            vipFlags: String(ctx.vipFlags || '[]'), eps, createdAt: Date.now(),
            headers: null,      // 会话级规则头（Kazumi 预热产出；全局头由此而来）
            cache: new Map(),   // index → 已解析直链（预热命中的集不再重复解析）
            pipe: !!ctx.pipe,   // 管道模式：数据面经本代理转发（外部播放器会话）
        };
        if (kind === 'static') {
            // 静态直链：会话头直接来自调用方；全部集目预填缓存（无需懒解析）
            sess.headers = (ctx.headers && typeof ctx.headers === 'object'
                && !Array.isArray(ctx.headers)) ? { ...ctx.headers } : null;
            // 记录解析上下文：page 线路直链签名时效短，播放中途 403/410 时可
            // 凭此上下文重解析刷新签名直链（时好时坏的根源修复，见 _reresolveEntry）。
            if (ctx.site || ctx.flag) sess.resolveCtx = { site: String(ctx.site || ''), flag: String(ctx.flag || ''), vipFlags: String(ctx.vipFlags || '') };
            for (let i = 0; i < eps.length; i++) {
                if (!/^https?:\/\//i.test(eps[i].id)) {
                    return { ok: false, reason: `static 直链非法（第 ${i + 1} 项）` };
                }
                sess.cache.set(i, eps[i].id);
            }
        }
        this.sessions.set(token, sess);
        while (this.sessions.size > MAX_SESSIONS) {
            this.sessions.delete(this.sessions.keys().next().value);
        }
        let headers = null;
        if (kind === 'static') {
            headers = sess.headers;
        } else if (kind === 'kazumi') {
            // Kazumi 预热**只做起始集**的轻量页面解析（kazumiResolve HTTP，秒级）：
            // 拿规则头 + 缓存页信息。绝不预热全部集目——1000 集的队列即使限流并行，
            // 注册耗时也会爆炸（渲染层 20s 竞速超时回退，实测灾难）；其余集目在
            // 播放器实际请求时按需解析（页信息+抓流），探测等待与单集成本一致。
            sess.pageCache = new Map(); // index → { ok, pageUrl, header, legacy }
            sess.kazumiInflight = new Map(); // index → Promise<page>（探测与预热合流）
            const page = await this._resolveKazumiPage(sess, start);
            if (!page.ok) {
                if (this.onEntryError) {
                    try { this.onEntryError({ index: start, reason: page.reason, sess }); } catch (e) { /* ignore */ }
                }
                return { ok: false, reason: page.reason };
            }
            sess.pageCache.set(start, page);
            if (page.header && Object.keys(page.header).length) {
                sess.headers = page.header;
                headers = page.header;
            }
        } else {
            // catvod 预热：首集同步解析（起播秒开 + data.header 提升为会话头）。
            // **其余集目后台异步预取（限流 4，fire-and-forget 不阻塞注册）**：
            // PotPlayer 打开 m3u 列表后会探测全部条目以计算剧集总时长——懒解析下
            // 每次探测触发一次 playerContent（2-5s），总时长随探测进度缓慢增长
            // （实测「打开视频后总时长要经过缓存慢慢增加」）。后台预取让后续探测
            // 即命中缓存，时长即时完整；注册路径零额外耗时，千级集数无压力
            // （预取失败静默——拉取时经 inflight 合流或现场重试）。
            const warm = await this._withRetry(() => this._resolve(sess, start));
            if (!warm.ok) {
                if (this.onEntryError) {
                    try { this.onEntryError({ index: start, reason: warm.reason, sess }); } catch (e) { /* ignore */ }
                }
                return { ok: false, reason: warm.reason };
            }
            sess.cache.set(start, warm.url);
            if (warm.header && typeof warm.header === 'object' && Object.keys(warm.header).length) {
                sess.headers = warm.header;
                headers = warm.header;
            }
            // catvod 列表总时长：PotPlayer 打开 m3u 会立即探测全部条目累加时长，
            // 懒解析下探测等待解析完成，总时长随缓冲慢慢增加（实测）。改为
            // **同步预取全部集目**（限流 4，并发等待），注册完成时全部直链已就绪，
            // 探测即命中 0ms，总时长打开即完整。8 集约 2 批 × 3s ≈ 6s 内完成；
            // 超长列表（>60 集）截断预取前 60 集，避免千集注册耗时爆炸。
            const hKeys2 = Object.keys(sess.headers || {}).map((k) => String(k).toLowerCase());
            const strongAuth2 = hKeys2.some((k) => ['referer', 'cookie', 'authorization'].includes(k));
            if (strongAuth2 && eps.length > 1) {
                sess.catvodInflight = new Map();
                const allRest = eps.map((_, i) => i).filter((i) => i !== start);
                // 超长列表截断：只预取前 60 集（含首集已完成的其余 59）
                const prefetchList = allRest.slice(0, 59);
                const pending = prefetchList.map((i) => {
                    const p = this._withRetry(() => this._resolve(sess, i));
                    sess.catvodInflight.set(i, p);
                    return p.then((r) => {
                        if (r.ok) sess.cache.set(i, r.url);
                    }).catch(() => {}).finally(() => sess.catvodInflight.delete(i));
                });
                // 等待全部预取完成再返回 entries，确保 PotPlayer 探测零等待
                await Promise.allSettled(pending);
            }
        }
        const entries = eps.map((e, i) => ({
            // 条目 URL **必须纯 ASCII**（序号+提示扩展名）：PotPlayer 发请求行时不
            // 编码非 ASCII 字符，含中文集名的地址会触发 HPE_INVALID_URL 拒收并诱发
            // 播放器开新窗口重试（实测双窗口）。集名显示由外部启动层的 m3u 文件
            // EXTINF 承担（文件内容不经过 HTTP，无编码问题）。
            url: `${base}/pl/${token}/${i}${sess.kind === 'static' ? (e.hint || hintExt(e.id)) : '.m3u8'}`,
            title: e.name,
        }));
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
        const rawPath = String(req.url || '').split('?')[0] || '';
        // 分片/子清单端点（管道模式）：解码上游地址 → 带会话头转发
        const seg = SEG_RE.exec(rawPath);
        if (seg) {
            const sess = this.sessions.get(seg[1]);
            const index = parseInt(seg[2], 10);
            let upstream = '';
            try { upstream = unb64u(seg[3]); } catch (e) { upstream = ''; }
            if (!sess || !(index >= 0 && index < sess.eps.length)
                || !/^https?:\/\//i.test(upstream) || !sess.pipe) {
                res.statusCode = 404; res.end();
                return;
            }
            await this._pipeRemote(sess, index, upstream, req, res);
            return;
        }
        const m = TOKEN_RE.exec(rawPath);
        const sess = m ? this.sessions.get(m[1]) : null;
        const index = m ? parseInt(m[2], 10) : -1;
        if (!sess || index < 0 || index >= sess.eps.length) {
            res.statusCode = 404; res.end();
            return;
        }
        // 预热命中的集直接回给播放器；其余按需解析后缓存。
        // 管道模式（外部播放器）：代理带会话头转发上游、清单重写回 /seg；
        // 直连模式（内置 mpv）：302 交给 CDN，mpv 以全局 --http-header-fields 自带鉴权，
        // 代理不占数据面带宽。
        if (sess.cache.has(index)) {
            this._notifyResolved(sess, index, sess.cache.get(index));
            await this._serveResolved(sess, index, sess.cache.get(index), req, res);
            return;
        }
        // static 会话的集目在 register 时已全量预填缓存；此处仅防御性兜底
        const resolved = (sess.kind === 'static')
            ? (/^https?:\/\//i.test(String(sess.eps[index].id))
                ? { ok: true, url: String(sess.eps[index].id) }
                : { ok: false, reason: 'static 直链非法' })
            : (sess.kind === 'kazumi')
                ? await this._withRetry(() => this._resolveKazumi(sess, index))
                : await this._resolveCatvodWithInflight(sess, index);
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
        await this._serveResolved(sess, index, resolved.url, req, res);
    }

    /**
     * 按解析结果回给 mpv：
     * - 本地文件（Kazumi 抓流产物 kazumi_stream_*.m3u8 等）：直接流式回传。
     *   302 会让 mpv 把本地 m3u8 当成「播放列表」二次展开——分片变条目、
     *   标题全是文件名；以 HLS Content-Type 回传则按直播流正常播放，
     *   分片地址仍是上游 CDN 绝对地址，不占数据面带宽。Range 透传保证 seek。
     * - 远程地址：302 跳转，mpv 直连 CDN。
     */
    async _serveResolved(sess, index, url, req, res) {
        const isLocal = /^(?:[a-z]:[\\/]|\\\\|file:\/\/)/i.test(url);
        if (!isLocal) {
            // 管道分流（按源生态差异化）：
            // - catvod / static（CMS 采集站 / page 包装）：**仅 Cookie/Authorization
            //   才走 pipe**，Referer/UA-only 一律 302 直连。实测 lzcdn31 等主 CDN
            //   仅 UA 即 200，Referer 多为规则作者冗余；直连可让 PotPlayer 拿到
            //   CDN 原始清单与分片（与 mpv 完全一致），拖动 seek 由 CDN 原生 Range
            //   支撑，避免代理重写引入的 DISCONTINUITY 重建与音画漂移。
            // - kazumi（规则引擎）：规则头就是防盗链配置（哪怕只有 UA），一律 pipe
            //   注入，不做直连冒险。
            const keys = Object.keys(sess.headers || {}).map((k) => String(k).toLowerCase());
            const strongAuth = keys.some((k) => ['cookie', 'authorization'].includes(k));
            const needAuth = sess.kind === 'kazumi' ? keys.length > 0 : strongAuth;
            if (sess.pipe && needAuth) {
                const st = await this._pipeRemote(sess, index, url, req, res);
                // 直链签名时效过期（上游 403/410）：PotPlayer 已在播放中或刚起播，
                // page 解析直链常带短时效 sign —— 时好时坏的根源。代理清该集缓存
                // 强制重解析（refresh=1）并用新直链重试一次，仅在响应尚未开始时
                // 触发且仅重试一次防循环。
                if ((st === 403 || st === 410) && !res.headersSent) {
                    console.log(`[播放列表] 第 ${index + 1} 集直链失效(${st})，重解析刷新…`);
                    const rr = await this._reresolveEntry(sess, index);
                    if (rr.ok && rr.url !== url) {
                        return this._pipeRemote(sess, index, rr.url, req, res);
                    }
                }
                return;
            }
            res.writeHead(302, { Location: url });
            res.end();
            return;
        }
        const localPath = url.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
        let stat = null;
        try { stat = fs.statSync(localPath); } catch (e) { /* 不存在的本地路径按 502 处理 */ }
        if (!stat || !stat.isFile()) {
            if (this.onEntryError) {
                try { this.onEntryError({ index, reason: '抓流产物已失效', sess }); } catch (e) { /* ignore */ }
            }
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('抓流产物已失效');
            return;
        }
        const type = /\.mp4$/i.test(localPath) ? 'video/mp4'
            : 'application/vnd.apple.mpegurl'; // .m3u8 → HLS 流
        // 管道模式下本地抓流清单同样重写：内部指向 CDN 的分片/密钥 URI 换回 /seg 端点，
        // 由代理带会话头取（绝对地址重写；相对地址基未知，维持原样——与旧行为一致）
        if (sess.pipe && type !== 'video/mp4') {
            let text = '';
            try { text = fs.readFileSync(localPath, 'utf8'); } catch (e) { /* 读失败按原样空清单 */ }
            const body = this._rewriteManifest(text.slice(0, MANIFEST_MAX_BYTES), null, sess, index, req);
            const buf = Buffer.from(body, 'utf8');
            res.writeHead(200, {
                'Content-Type': type, 'Cache-Control': 'no-store',
                'Content-Length': String(buf.length), // 定长完整清单（同 _pipeRemote 注释）
            });
            res.end(buf);
            return;
        }
        const range = String(req.headers.range || '');
        const headers = {
            'Content-Type': type,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
        };
        if (range && /^bytes=(\d*)-(\d*)/.test(range)) {
            const total = stat.size;
            const start = parseInt(RegExp.$1, 10) || 0;
            const end = RegExp.$2 ? Math.min(parseInt(RegExp.$2, 10), total - 1) : total - 1;
            headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
            headers['Content-Length'] = String(end - start + 1);
            res.writeHead(206, headers);
            fs.createReadStream(localPath, { start, end }).pipe(res);
            return;
        }
        headers['Content-Length'] = String(stat.size);
        res.writeHead(200, headers);
        fs.createReadStream(localPath).pipe(res);
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

    /** 解析失败自动重试一次：源站冷启动（DNS/TLS 握手）的瞬时抖动不应整队判死。
     *  结果带 noRetry 标记时跳过重试（如 Kazumi 隐藏窗口抓流失败——再等一轮
     *  只是双倍超时，渲染层 20s 竞速早已放弃本队列转走逐集链路）。 */
    async _withRetry(fn) {
        let last = { ok: false, reason: 'resolve failed' };
        for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) {
                if (last.noRetry) break;
                await new Promise((res) => setTimeout(res, 600));
            }
            last = await fn();
            if (last.ok) return last;
        }
        return last;
    }

    /** catvod 按需解析：与后台预取合流同一 promise（探测撞上预取时不重复请求）。 */
    async _resolveCatvodWithInflight(sess, index) {
        if (sess.catvodInflight && sess.catvodInflight.has(index)) {
            try { return await sess.catvodInflight.get(index); } catch (e) { /* 落到现场重试 */ }
        }
        return this._withRetry(() => this._resolve(sess, index));
    }

    /** Kazumi 第一段（轻量）：调后端 kazumiResolve 拿播放页 URL 与规则 headers。
     *  不做隐藏窗口抓流——注册路径只允许此段，抓流在第二段按需执行。 */
    async _resolveKazumiPage(sess, index) {
        const backend = this.getBackend() || null;
        if (!backend || !backend.base) return { ok: false, reason: '后端未就绪' };
        let pageUrl = sess.eps[index].id;
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
            return {
                ok: true, pageUrl, header, legacy: !!data.useLegacyParser,
            };
        } catch (e) {
            return { ok: false, reason: 'Kazumi 解析请求失败' };
        }
    }

    /** Kazumi 第二段：用页信息（优先取预热缓存/在途 promise）做隐藏窗口抓流拿真实流。 */
    async _resolveKazumi(sess, index) {
        let page = (sess.pageCache && sess.pageCache.get(index)) || null;
        if ((!page || !page.ok) && sess.kazumiInflight && sess.kazumiInflight.has(index)) {
            page = await sess.kazumiInflight.get(index); // 与并行预热合流，不重复请求
        }
        if (!page || !page.ok) {
            page = await this._resolveKazumiPage(sess, index);
            if (!page.ok) return { ok: false, reason: page.reason };
            if (!sess.pageCache) sess.pageCache = new Map();
            sess.pageCache.set(index, page);
        }
        try {
            const cap = await this.captureDirect(page.pageUrl, page.legacy);
            if (!cap || !cap.url) return { ok: false, reason: '未抓取到可播放地址', noRetry: true };
            return { ok: true, url: String(cap.url), header: { ...page.header, ...(cap.header || {}) } };
        } catch (e) {
            return { ok: false, reason: '抓取真实流失败', noRetry: true };
        }
    }

    /**
     * 管道转发（外部播放器会话的数据面）：带会话头请求上游，关键响应头回写，
     * Range 透传保证 seek。响应若为 HLS 清单则把内部 URI 重写回 /seg 端点后
     * 回给播放器——清单/子清单/分片/密钥全部经本代理，会话头全程生效。
     */
    /**
     * 管道转发（外部播放器会话的数据面）：带会话头请求上游。单管线边流边判——
     * 首块以 #EXTM3U 魔串判定 HLS 清单（缓冲全文、URI 重写回 /seg 后回给播放器），
     * 否则按原始字节直通（分片零缓冲）。绝不可「pause 后摘监听再重挂」：
     * 小体积响应的 EOF 会先于重挂到达，end 事件将永久丢失（实测挂死）。
     */
    async _pipeRemote(sess, index, upstreamUrl, req, res) {
        // 清单短时缓存：PotPlayer 拖动时会反复拉取同一媒体清单计算时长/分片映射，
        // 每次重取上游（367 分片、38 个 DISCONTINUITY 的大清单）引入 300-800ms 往返，
        // 拖动卡顿主因。缓存 8 秒内复用重写结果，拖动即时响应，音画重同步等待缩短。
        const cacheKey = `${sess.token}:${index}:${upstreamUrl}`;
        if (!sess._manifestCache) sess._manifestCache = new Map();
        const cached = sess._manifestCache.get(cacheKey);
        const now = Date.now();
        if (cached && now - cached.ts < 2000 && !String(req.headers.range || '')) {
            try {
                res.writeHead(200, {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Cache-Control': 'no-store',
                    'Content-Length': String(cached.buf.length),
                });
                res.end(cached.buf);
                return 200;
            } catch (e) { /* 缓存发送失败回落重取 */ }
        }
        const headers = {};
        // 只注入会话规则头；入站请求头一律不透传，避免把 127.0.0.1 上下文泄漏给源站
        Object.assign(headers, sess.headers || {});
        const range = String(req.headers.range || '');
        if (range) headers.Range = range;
        let rs;
        try { rs = await this._upstreamGet(upstreamUrl, headers, 2); }
        catch (e) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('upstream error');
            return 0;
        }
        const ct = String(rs.headers['content-type'] || '').toLowerCase();
        // 带 Range 的取流 / 非 200 / 明确的非清单类型 → 纯直通（清单只在整取时有意义）
        const forceRaw = !!range || rs.status !== 200
            || (!ct.includes('mpegurl') && !/\.m3u8?(?:$|\?)/i.test(rs.finalUrl));
        if (forceRaw) {
            this._passthrough(res, rs);
            // 返回上游状态码：403/410 通常是直链签名时效过期，调用方据此触发重解析
            return rs.status;
        }

        const chunks = [];
        let total = 0;
        let mode = 'detect'; // detect → manifest | raw
        await new Promise((resolve) => {
            rs.stream.on('data', (c) => {
                if (mode === 'detect') {
                    if (/^\s*#EXTM3U/.test(c.toString('utf8', 0, Math.min(c.length, 64)))) {
                        // 只记模式不写头：清单要整体重写并计算 Content-Length 后
                        // 统一 writeHead+end（writeHead 之后再 setHeader 会抛
                        // ERR_HTTP_HEADERS_SENT，响应悬挂——实测）
                        mode = 'manifest';
                    } else {
                        mode = 'raw';
                        this._passthrough(res, rs, c);
                        return;
                    }
                }
                total += c.length;
                if (total <= MANIFEST_MAX_BYTES) chunks.push(c);
                else rs.stream.destroy(); // 超限截断：异常大文件按已有内容处理
            });
            rs.stream.on('aborted', resolve);
            rs.stream.on('end', resolve);
            rs.stream.on('error', resolve);
        });
        if (mode !== 'manifest') { try { res.end(); } catch (e) { /* ignore */ } return rs.status; }
        const text = Buffer.concat(chunks).toString('utf8');
        const body = this._rewriteManifest(text, rs.finalUrl, sess, index, req);
        // 显式 Content-Length：PotPlayer 对无长度界定的清单会保守处理（时长渐进
        // 估算、暂停后停更）；定长完整清单让它一次性确认 VOD 总时长。
        const out = Buffer.from(body, 'utf8');
        try {
            // 写入缓存供拖动复用
            sess._manifestCache.set(cacheKey, { buf: out, ts: Date.now() });
            res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-store',
                'Content-Length': String(out.length),
            });
            res.end(out);
        } catch (e) {
            // 客户端中途断开（探测性连接常见）时 writeHead/end 抛错——连接已死无需处理
            console.log('[播放列表] 清单回写失败（客户端已断开）:', e.code || e.message);
        }
        return rs.status;
    }

    /** 响应直通：状态与关键头回写，可选的已读首块先行写入再接管管道。 */
    _passthrough(res, rs, preChunk) {
        if (!res.headersSent) {
            res.writeHead(rs.status || 502, {
                'Content-Type': rs.headers['content-type'] || 'video/mp4',
                'Accept-Ranges': rs.headers['accept-ranges'] || 'bytes',
                ...(rs.headers['content-range'] ? { 'Content-Range': rs.headers['content-range'] } : {}),
                ...(rs.headers['content-length'] ? { 'Content-Length': rs.headers['content-length'] } : {}),
                ...(rs.headers.location ? { Location: rs.headers.location } : {}),
            });
        }
        if (preChunk) res.write(preChunk);
        rs.stream.pipe(res);
    }

    /** 上游 GET：http/https 自适应，最多跟随 redirectsLeft 次 30x，超时销毁连接。 */
    _upstreamGet(urlStr, extraHeaders, redirectsLeft) {
        return new Promise((resolve, reject) => {
            let u;
            try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad upstream url')); }
            const mod = u.protocol === 'https:' ? https : http;
            const rq = mod.request({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method: 'GET',
                headers: extraHeaders,
                timeout: UPSTREAM_TIMEOUT_MS,
                agent: this.upAgents[u.protocol === 'https:' ? 'https' : 'http'],
            }, (rs) => {
                const loc = rs.headers.location;
                if ([301, 302, 303, 307, 308].includes(rs.statusCode) && loc && redirectsLeft > 0) {
                    rs.resume(); // 丢弃跳转页体
                    let next;
                    try { next = new URL(loc, u).toString(); } catch (e2) { return reject(new Error('bad redirect')); }
                    this._upstreamGet(next, extraHeaders, redirectsLeft - 1).then(resolve, reject);
                    return;
                }
                resolve({
                    status: rs.statusCode || 502,
                    headers: rs.headers,
                    stream: rs,
                    finalUrl: u.toString(),
                });
            });
            rq.on('timeout', () => rq.destroy(new Error('upstream timeout')));
            rq.on('error', reject);
            rq.end();
        });
    }

    /**
     * HLS 清单重写：行内 URI 与标签属性 URI="…" 全部解析为绝对地址后映射到
     * /seg/<token>/<index>/<b64url> 端点（数据:URI 原样保留）。baseUrl=null 时
     * （本地抓流产物）仅重写绝对地址，相对地址维持原样。
     */
    _rewriteManifest(text, baseUrl, sess, index, req) {
        const host = String((req && req.headers && req.headers.host) || '127.0.0.1');
        const segBase = `http://${host}/seg/${sess.token}/${index}/`;
        const mapUri = (raw) => {
            const t = String(raw || '').trim();
            if (!t || /^(data|blob):/i.test(t)) return '';
            let abs;
            try { abs = new URL(t, baseUrl || undefined); } catch (e) { return ''; }
            if (!/^https?:$/.test(abs.protocol)) return '';
            // 相对路径分片/子清单常不带签名 query（如 2000k/hls/mixed.m3u8），
            // 而 baseUrl（master）带 ?sign=。按 HLS 签名 CDN 约定继承 base query
            // 否则子清单/分片 403，播放器退化为 TS 探测（page 源 mpeg ts 根因）。
            if (!abs.search && baseUrl) {
                try { const b = new URL(baseUrl); if (b.search) abs.search = b.search; } catch (e2) { /* ignore */ }
            }
            return segBase + b64u(abs.toString());
        };
        return String(text || '').split(/\r?\n/).map((line) => {
            const s = line.trim();
            if (!s) return line;
            if (s.startsWith('#')) {
                // 标签行只动 URI 属性（EXT-X-KEY/MAP/MEDIA/I-FRAME-STREAM-INF 等通用）
                return line.replace(/URI="([^"]*)"/g, (m0, uri) => {
                    const mapped = mapUri(uri);
                    return mapped ? `URI="${mapped}"` : m0;
                });
            }
            const mapped = mapUri(s);
            return mapped || line;
        }).join('\n');
    }

    /** 直链失效时的重解析：清该集缓存，按 kind 重新解析并更新会话头（仅重试一次）。 */
    async _reresolveEntry(sess, index) {
        sess.cache.delete(index);
        if (sess.pageCache) sess.pageCache.delete(index);
        if (sess.catvodInflight) sess.catvodInflight.delete(index);
        let r;
        if (sess.kind === 'kazumi') {
            r = await this._withRetry(() => this._resolveKazumi(sess, index));
        } else if (sess.kind === 'static' && sess.resolveCtx) {
            // static（page 源包装）带上下文时走 catvod 刷新路径获取新签名直链
            const ctx = sess.resolveCtx;
            const tmpSess = { site: ctx.site || sess.site, flag: ctx.flag || sess.flag, vipFlags: ctx.vipFlags || sess.vipFlags, eps: sess.eps };
            r = await this._withRetry(() => this._resolve(tmpSess, index, '1'));
        } else {
            r = await this._withRetry(() => this._resolve(sess, index, '1'));
        }
        if (r.ok) {
            sess.cache.set(index, r.url);
            if (r.header && typeof r.header === 'object' && Object.keys(r.header).length) {
                sess.headers = { ...(sess.headers || {}), ...r.header };
            }
        }
        return r;
    }

    /** 调后端 playerContent 解析第 index 集；parse=1 / DRM / 空地址视为该集失败。 */
    async _resolve(sess, index, refresh = '0') {
        const backend = this.getBackend() || null;
        if (!backend || !backend.base) return { ok: false, reason: '后端未就绪' };
        const ep = sess.eps[index];
        const body = new URLSearchParams({
            do: 'playerContent', site: sess.site, flag: sess.flag,
            id: ep.id, vipFlags: sess.vipFlags || '[]', refresh,
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
        // data.header：源站返回的该集 Referer/UA 等——预热时提升为会话头（见 register 注）
        const header = (data.header && typeof data.header === 'object' && !Array.isArray(data.header))
            ? data.header : null;
        return { ok: true, url, header };
    }

    /**
     * 关闭代理并释放全部资源。兼容两种用法：
     * - close(cb)：节点式回调（cb 在服务器完全关闭后触发）；
     * - close()：返回 Promise（服务器完全关闭时 resolve）——测试/收尾可直接 await。
     * 必做清理：销毁上游 keep-alive agent 池、掐空闲入站连接、停会话清扫器。
     * （不销毁 agent 时，池化 socket 会同时阻塞 close 回调与进程退出，实测。）
     */
    close(done) {
        if (this.upAgents) {
            try { this.upAgents.http.destroy(); } catch (e) { /* ignore */ }
            try { this.upAgents.https.destroy(); } catch (e) { /* ignore */ }
        }
        if (typeof this.server.closeIdleConnections === 'function') {
            try { this.server.closeIdleConnections(); } catch (e) { /* ignore */ }
        }
        if (this.sweeper) clearInterval(this.sweeper);
        this.sessions.clear();
        const finish = () => { if (typeof done === 'function') done(); };
        return new Promise((resolve) => {
            try {
                this.server.close(() => { resolve(); finish(); });
            } catch (e) { resolve(); finish(); }
        });
    }
}

module.exports = { PlaylistProxy };

