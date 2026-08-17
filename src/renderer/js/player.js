/**
 * player.js — 播放入口（Phase 4，Phase 7 加 VIP 解析）
 *
 * 流程：playerContent 取真实地址 →
 *   parse=1：后台自动解析（配置 parses 接口优先，失败后隐藏窗口直开
 *   链接抓媒体请求），解出直链后自动拉起 mpv，全程无需手动操作；
 *   mpv 缺失：<video> 预览兜底（m3u8 等 HLS 直链提示需 mpv）。
 *
 * 自动连播（统一由渲染层驱动，直链/解析源同一套逻辑）：
 *   每次只交 mpv 单集；mpv 播完自然退出（vpc:player-exit 附带进度），
 *   渲染层判定「看完」（剩余<8s 或刚收到 ended）且队列还有下一集时，
 *   自动解析并起播下一集；用户提前关闭 mpv 则终止连播链。
 */
/* global $, doAction, getJson, createRuntimeId, warnToast, showLoading, hideLoading, openDialog, closeDialog, Kazumi, Records */

// 媒体直链后缀：已是直链则无需解析（share/播放页等才需解析）
const DIRECT_MEDIA_RE = /\.(m3u8|mp4|flv|mov|mkv|webm|ts)(\?|#|$)/i;

const Player = {
    _mpvMissingToastShown: false,
    _playAbort: null,
    _playContext: null,
    _vipFlags: null,
    _vipFlagsAt: 0,
    _seq: null,      // 连播上下文 {site, flag, title, episodes, index}（mpv 退出后推进）
    _endedAt: 0,     // 最近一次 ended（单集播完）时间戳，无会话号时的「看完」兜底判据
    _endedSessions: new Map(), // sessionId → ended 时间戳；退出判定按会话匹配，旧集 ended 不误判新集
    _playToken: 0,   // 起播令牌：exit 处理期间又发起新播放则放弃推进（防旧进程延迟退出误连播）
    _session: 0,     // 当前起播会话号（主进程 playUrl 返回；exit 事件据此匹配归属）
    _lastUrl: '',    // 最近一次交给 mpv 的地址（断流重连条件需媒体直链判定）
    _curMeta: null,  // 最近一次成功起播的元信息 {site, title, subtitle, vodId}（观看统计/最近观看用）
    _watchSessions: new Map(), // sessionId → 起播时元信息；旧会话退出不会读取到新影片信息
    _watchWrite: Promise.resolve(), // 统计写入串行队列，避免快速切集相互覆盖
    _watchChain: 0,          // 观看链序号：显式起播开新链；断流重连经 player-session 复用旧链
    _watchChainMax: new Map(), // chainId → 该链已累计的最大 pos（重连只补增量，不重复累计）
    _watchChainCounted: new Set(), // 已计过观看次数/部数的链（重连会话不再 +1 次数）
    _lastExitedWatch: null, // 断流退出后主进程重连时复用上一会话元信息
    _carrySpeed: null,       // 连播时从上一集延续的倍速
    _carryFullscreen: null,  // 连播时从上一集延续的全屏状态

    init() {
        $('#player-close').on('click', () => this._close());
        $('#player-copy').on('click', () => {
            const url = $('#player-url').text();
            if (!url) return;
            if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => { });
            warnToast('已复制');
        });
        $('#player-preview').on('click', () => {
            const url = $('#player-url').text();
            if (!url) return;
            const v = document.getElementById('player-video');
            v.src = url;
            $('#player-video').show();
            v.play().catch(() => { /* 部分源不支持内嵌预览 */ });
        });
        // 外部播放器：把当前弹窗地址（含解析出的 Referer/UA 头）交给 VLC/PotPlayer/mpv 或系统默认程序。
        // mpv 缺失或线路全失败时的兜底出口，不影响内置 mpv 主链路。
        $('#player-external').on('click', () => this._openExternal());
        // mpv 事件：ended 记录「播完」时间戳；exit 附退出进度，驱动连播推进；
        // session 事件：断流重连后同步新会话号，重连集播完仍可继续连播
        if (window.vpc && window.vpc.onPlayerEnded) {
            window.vpc.onPlayerEnded((info) => this._onEnded(info));
            window.vpc.onPlayerExit((info) => this._onExit(info));
            if (window.vpc.onPlayerSession) {
                window.vpc.onPlayerSession((info) => this._adoptSession(info));
            }
        }
    },

    /** 单集播完（end-file eof，附会话号）：按会话记录时间戳；旧集延迟 ended 不误判新集。 */
    _onEnded(info) {
        const now = Date.now();
        const sid = (info && typeof info.sessionId === 'number') ? info.sessionId : 0;
        if (sid) {
            this._endedSessions.set(sid, now);
            if (this._endedSessions.size > 64) {
                const oldest = this._endedSessions.keys().next().value;
                this._endedSessions.delete(oldest);
            }
        }
        // 仅当前会话（或无会话号的旧协议事件）才更新全局兜底时间戳，旧会话 ended 不污染
        if (!sid || sid === this._session) this._endedAt = now;
    },

    /** 断流重连：主进程用新会话号重播本集，渲染层把新会话并入旧观看链（元信息含 chainId）。 */
    _adoptSession(info) {
        if (!info || typeof info.sessionId !== 'number') return;
        const previous = this._session;
        const previousMeta = this._lastExitedWatch && this._lastExitedWatch.sessionId === previous
            ? this._lastExitedWatch.meta
            : null;
        const meta = this._watchSessions.get(previous) || previousMeta || this._curMeta;
        this._session = info.sessionId;
        if (meta) {
            if (typeof meta.chainId !== 'number') meta.chainId = ++this._watchChain;
            this._watchSessions.set(info.sessionId, { ...meta });
        }
    },

    /** 「看完」判定：退出时剩余 <8s 视为播完；进度取不到（IPC 已断）时按会话匹配 ended（10s 内），
     *  无会话号再退回全局兜底。判定会消耗该会话的 ended 记录。 */
    _isDone(info) {
        if (info && typeof info.pos === 'number' && typeof info.duration === 'number' && info.duration > 0) {
            return (info.duration - info.pos) < 8;
        }
        const sid = (info && typeof info.sessionId === 'number') ? info.sessionId : 0;
        const endedAt = (sid && this._endedSessions.has(sid)) ? this._endedSessions.get(sid) : this._endedAt;
        if (sid) this._endedSessions.delete(sid);
        return (Date.now() - endedAt) < 10000;
    },

    /**
     * mpv 进程退出：连播核心驱动点。
     * 「看完」判定：退出时剩余时长 <8s；进度取不到（IPC 已断）时，
     * 10s 内收到过 ended 事件同样视为看完。提前关闭 → 终止连播链。
     */
    async _onExit(info) {
        // 观看统计（「我的」页）：任何 mpv 会话真实退出都累计时长/次数，与连播链无关
        this._recordWatch(info);
        const seq = this._seq;
        if (!seq) return;
        // 非当前会话的退出（切集时被杀旧进程的延迟退出/本地播放）不驱动连播
        if (info && typeof info.sessionId === 'number' && info.sessionId && info.sessionId !== this._session) return;
        const token = this._playToken;
        // 播放途中关掉连播开关则不再推进
        let autoNext = true;
        try { autoNext = ((await window.vpc.settingsGet()) || {}).autoNext !== false; } catch (e) { /* 读失败默认连播 */ }
        if (!autoNext) { this._seq = null; return; }
        // 等待期间用户已手动起播新内容：旧进程的退出不再驱动连播
        if (token !== this._playToken) return;
        const done = this._isDone(info);
        // 观看进度追踪：更新收藏条目的观看进度（仅当 seq 含 vodId 时）
        if (seq.vodId && typeof Favorites !== 'undefined' && Favorites.updateProgress) {
            try {
                const percent = (info && typeof info.pos === 'number' && typeof info.duration === 'number' && info.duration > 0)
                    ? (info.pos / info.duration) * 100
                    : 0;
                await Favorites.updateProgress(seq.site, seq.vodId, {
                    currentEp: seq.index + 1,
                    totalEps: seq.episodes.length,
                    percent,
                    ts: Date.now(),
                });
            } catch (e) { /* 进度更新失败不影响播放 */ }
        }
        // 用户主动关闭播放器（主进程按 end-file reason=quit/stop 或 stop() 判定）：
        // 不等待断流重连、不自动连播，终止当前链
        if (info && info.quit) { this._seq = null; return; }
        if (!done) {
            // 断流场景（开播≥15s 且剩余≥8s 的媒体直链）：主进程会自动重播本集一次，
            // 保留连播链等待重连后的新会话；其余情形视为用户提前关闭，终止连播
            const canStallRetry = typeof info.pos === 'number' && typeof info.duration === 'number' && info.duration > 0
                && info.pos >= 15 && (info.duration - info.pos) >= 8
                && this._lastUrl && DIRECT_MEDIA_RE.test(String(this._lastUrl).split('?')[0]);
            if (canStallRetry) return;
            this._seq = null;
            return;
        }
        const next = seq.episodes[seq.index + 1];
        if (!next) { this._seq = null; return; }
        warnToast(`本集播完，自动播放下一集《${next.name}》`);
        // 延续上一集的全屏状态和播放倍速
        this._carrySpeed = (info && typeof info.speed === 'number') ? info.speed : null;
        this._carryFullscreen = (info && typeof info.fullscreen === 'boolean') ? info.fullscreen : null;
        this._playToken += 1; // 自推进也占令牌，避免与新起播竞态
        this.play(seq.site, seq.flag, next.url, seq.title, next.name, seq.episodes, seq.index + 1, seq.kazumiSrc);
    },

    /** 观看统计埋点（「我的」页）：mpv 退出时累计**播放器运行时长**（墙钟，info.wallWatched = 打开播放器后运行了多久）、
     *  次数/每日分布，并更新最近观看列表。fire-and-forget（不阻塞连播推进）。
     *  运行时长 <15s 的短播不计入（避免误触/秒开被统计）。 */
    _recordWatch(info) {
        if (!info || typeof info.sessionId !== 'number') return;
        const meta = this._watchSessions.get(info.sessionId);
        if (!meta) return;
        this._lastExitedWatch = { sessionId: info.sessionId, meta: { ...meta } };
        this._watchSessions.delete(info.sessionId);
        // 短播过滤：以播放器运行时长为准（wallWatched）；缺失时退回 pos 兼容旧协议
        const watched = (typeof info.wallWatched === 'number') ? info.wallWatched
            : ((typeof info.pos === 'number') ? info.pos : null);
        if (typeof watched === 'number' && watched < 15) return;
        const snapshot = { ...meta };
        const progress = { ...info };
        this._watchWrite = this._watchWrite
            .catch(() => { /* 上一次失败不阻塞后续统计 */ })
            .then(() => this._writeWatch(progress, snapshot, watched));
    },

    async _writeWatch(info, meta, watched) {
        let s = {};
        try {
            s = (await window.vpc.settingsGet()) || {};
            if (s.watchStatsEnabled === false) return;
        } catch (e) { /* 默认统计 */ }
        const title = meta.title || '未知影片';
        // 封面/来源尽量从详情页取（无则留空，最近观看卡片走占位图）
        let pic = meta.pic || '';
        let siteName = meta.siteName || '';
        // Kazumi 源使用自身元数据，不混用 Detail._lastVod 的封面/源名
        if (!String(meta.site).startsWith('kazumi:')) {
            try {
                if (typeof Detail !== 'undefined' && Detail.site) {
                    siteName = siteName || (Detail._siteName ? Detail._siteName(Detail.site) : '');
                    if (!pic && Detail._lastVod) pic = Detail._lastVod.vod_pic || '';
                }
            } catch (e) { /* ignore */ }
        }
        try {
            // 位置（进度条位置）：用于最近观看 percent；可被拖动，不用于时长累计
            const pos = (typeof info.pos === 'number' && info.pos > 0) ? Math.round(info.pos) : 0;
            const chainId = meta.chainId;
            const prevMax = (typeof chainId === 'number') ? (this._watchChainMax.get(chainId) || 0) : 0;
            const alreadyCounted = (typeof chainId === 'number') && this._watchChainCounted.has(chainId);
            // 观看时长累计：
            //  - 有 wallWatched（播放器运行时长=墙钟，mpv 退出时上报）：直接累加本次会话运行秒数，
            //    即「打开播放器后运行了多久」。断流重连的新会话本就是独立运行时段，各自累加即正确。
            //  - 无 wallWatched（旧协议/边缘）：回退按 pos 的观看链去重（同链只补增量，防重连重复计）。
            const hasWall = typeof info.wallWatched === 'number' && info.wallWatched > 0;
            const addSeconds = hasWall
                ? Math.round(info.wallWatched)
                : (alreadyCounted ? Math.max(0, pos - prevMax) : pos);
            const bestPos = Math.max(prevMax, pos);
            if (typeof chainId === 'number') {
                this._watchChainMax.set(chainId, bestPos);
                this._watchChainCounted.add(chainId);
                // 防 Map 无限增长：只保留最近 128 条观看链
                if (this._watchChainMax.size > 128) {
                    const oldest = this._watchChainMax.keys().next().value;
                    this._watchChainMax.delete(oldest);
                    this._watchChainCounted.delete(oldest);
                }
            }
            // ---- 观看统计 ----
            const stats = s.watchStats || { totalSeconds: 0, sessionCount: 0, titles: {}, daily: {} };
            const now = new Date();
            const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            // 次数/部数：该链未计过则计一次（含 pos 缺失但仍真实播放的会话；短播已在 _recordWatch 过滤）
            if (!alreadyCounted) {
                stats.sessionCount = (stats.sessionCount || 0) + 1;
                if (!stats.titles) stats.titles = {};
                stats.titles[title] = (stats.titles[title] || 0) + 1;
            }
            if (addSeconds > 0) {
                stats.totalSeconds = (stats.totalSeconds || 0) + addSeconds;
                if (!stats.daily) stats.daily = {};
                stats.daily[day] = (stats.daily[day] || 0) + addSeconds;
                // 只保留近 30 天的每日分布（防无限增长）
                const days = Object.keys(stats.daily).sort();
                while (days.length > 30) { const oldest = days.shift(); delete stats.daily[oldest]; }
                // 分来源累计（全量，向后兼容：缺字段视为空对象）。以 siteName 优先、退回 site 归类。
                const srcKey = String(siteName || meta.site || '未知来源');
                if (!stats.bySite) stats.bySite = {};
                stats.bySite[srcKey] = (stats.bySite[srcKey] || 0) + addSeconds;
            }
            // 有实际变化（新计链 或 补了秒数）才写盘
            if (!alreadyCounted || addSeconds > 0) await window.vpc.settingsSet('watchStats', stats);
            // ---- 最近观看（有 vodId 按 site|vodId 去重合并，无则按标题追加展示；进度取链内最新） ----
            const rw = Array.isArray(s.recentWatches) ? s.recentWatches : [];
            const percent = (info.duration > 0) ? Math.min(100, Math.round(bestPos / info.duration * 100)) : 0;
            const entry = {
                site: meta.site || '', vodId: meta.vodId || '',
                name: title, pic: pic || '', remarks: meta.subtitle || '',
                siteName, seconds: bestPos, percent, ts: Date.now(),
            };
            const key = String(meta.site || '') + '|' + String(meta.vodId || '');
            const idx = (key && key !== '|')
                ? rw.findIndex((x) => String(x.site) + '|' + String(x.vodId) === key)
                : rw.findIndex((x) => String(x.name) === title);
            if (idx >= 0) rw.splice(idx, 1);
            rw.unshift(entry);
            if (rw.length > 50) rw.length = 50;
            await window.vpc.settingsSet('recentWatches', rw);
            // 历史记录：每次真实播放结束更新一次（总集数 + 最近集/时长/时间），由 records.js 持久化
            if (typeof Records !== 'undefined' && Records.recordPlay) {
                // Kazumi 源无源封面：优先从 Bangumi 缓存取封面，避免历史卡首帧空白
                let recordPic = pic || '';
                if (!recordPic && String(meta.site || '').startsWith('kazumi:') &&
                    typeof Kazumi !== 'undefined' && Kazumi.getCachedBangumiCover) {
                    recordPic = Kazumi.getCachedBangumiCover(title) || '';
                }
                await Records.recordPlay({
                    site: meta.site || '', vodId: meta.vodId || '',
                    kazumiSrc: meta.kazumiSrc || '',
                    name: title, pic: recordPic, remarks: meta.subtitle || '',
                    siteName, episode: meta.subtitle || '', seconds: watched,
                    totalEps: meta.totalEps || 0,
                });
            }
        } catch (e) { /* 统计保存失败不影响播放 */ }
    },

    /** 解析类 IPC 加超时兜底：偶发挂起（解析窗口/槽位卡住）时在 ms 后返回 null，
     *  保证调用方必然往下走到 hideLoading，播放 loading 永不卡死。 */
    _awaitTimeout(promise, ms = 15000, cancelContext = null) {
        let timer = null;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => {
                // Returning null keeps the renderer responsive, but the
                // abandoned main-process parse must also release its hidden
                // window/slot.  The requestId scopes cancellation to this
                // play session.
                if (cancelContext && window.vpc && window.vpc.cancelRuntime) {
                    Promise.resolve(window.vpc.cancelRuntime(cancelContext)).catch(() => {});
                }
                resolve(null);
            }, ms);
        });
        return Promise.race([
            Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
            timeout,
        ]);
    },

    /** 成功起播后把会话号与当时影片元信息绑定，供延迟 exit 安全读取。 */
    _rememberSession(result) {
        if (!result || !result.ok || typeof result.sessionId !== 'number') return;
        this._session = result.sessionId;
        const meta = { ...(this._curMeta || {}) };
        // 观看链：显式起播一律开新链；断流重连经 player-session 事件复用旧链元信息
        meta.chainId = ++this._watchChain;
        // Kazumi 源不使用 Detail._lastVod 的封面/源名，用自身数据
        if (String(meta.site).startsWith('kazumi:')) {
            meta.siteName = meta.siteName || String(meta.site).slice(7);
        } else {
            try {
                if (typeof Detail !== 'undefined' && Detail.site) {
                    meta.siteName = meta.siteName || (Detail._siteName ? Detail._siteName(Detail.site) : '');
                    if (!meta.pic && Detail._lastVod) meta.pic = Detail._lastVod.vod_pic || '';
                }
            } catch (e) { /* ignore */ }
        }
        this._watchSessions.set(result.sessionId, meta);
        // 自动加载弹幕（方案 A，默认关）：起播成功后按片名+集数从弹弹 play 拉整集弹幕推给 mpv。
        // fire-and-forget，不阻塞起播；失败/匹配不到静默跳过。
        this._maybeLoadDanmaku(meta);
    },

    /** 自动加载弹幕：读设置开关，开启且有片名时调 Kazumi.loadDanmaku（转 ASS 推 mpv）。 */
    async _maybeLoadDanmaku(meta) {
        try {
            if (typeof Kazumi === 'undefined' || !Kazumi.loadDanmaku) return;
            const s = (await window.vpc.settingsGet()) || {};
            if (!s.danmakuEnable) return;
            const title = (meta && meta.title) || '';
            if (!title) return;
            // 集数：从「第N集/N」形式的 subtitle 提取，缺省第 1 集
            let ep = 1;
            const sub = String((meta && meta.subtitle) || '');
            const m = sub.match(/(\d+)/);
            if (m) ep = parseInt(m[1], 10) || 1;
            const n = await Kazumi.loadDanmaku(title, ep);
            if (n > 0) warnToast(`已加载 ${n} 条弹幕`);
        } catch (e) { /* 弹幕加载失败不影响播放 */ }
    },

    /**
     * @param site   站点 key
     * @param flag   线路名
     * @param id     集地址（播放前原始值）
     * @param title  视频名（弹窗标题用）
     * @param subtitle 集名
     * @param episodes 当前线路全部集 [{name,url}]（连播队列用）
     * @param epIndex  当前集在 episodes 中的下标
     * @param kazumiSrc Kazumi 番剧源页 URL（仅 kazumi: 源；写入历史记录供历史卡重新选源）
     * @returns {ok: boolean, reason?: string} 起播结果
     */
    async play(site, flag, id, title, subtitle, episodes, epIndex, kazumiSrc) {
        // 新起播占令牌：任何在途的旧进程 exit 处理随后发现令牌变化即放弃连播推进
        this._playToken += 1;
        const previousTrace = this._playContext;
        if (previousTrace && window.vpc.cancelRuntime) {
            window.vpc.cancelRuntime(previousTrace).catch(() => {});
        }
        if (this._playAbort) this._playAbort.abort();
        const playAbort = new AbortController();
        const trace = {
            requestId: createRuntimeId('play'),
            playSessionId: createRuntimeId('session'),
        };
        this._playAbort = playAbort;
        this._playContext = trace;
        // 清除上一次失败线路残留的错误弹窗：多线路重试/连播时，前一线路失败会弹 playerDialog
        // （如「当前配置未含解析接口」），若后续线路成功起播 mpv 却不关旧弹窗，就会出现
        // 「已在 mpv 播放，却仍显示解析失败弹窗」的错位（用户报告的 bug）。新一次起播先关掉。
        this._close();
        // 新集起播清掉上一集的 ended 时间戳/会话记录：IPC 断开且无 pos 时不再误判「看完」
        this._endedAt = 0;
        this._endedSessions.clear();
        // 连播延续的倍速/全屏（仅连播自动推进时非空，手动起播为 null）
        const carrySpeed = this._carrySpeed;
        const carryFullscreen = this._carryFullscreen;
        this._carrySpeed = null;
        this._carryFullscreen = null;
        // 连播开关 + 上下文：从当前集起按序排队，mpv 退出后由 _onExit 推进
        let autoNext = true;
        try { autoNext = ((await window.vpc.settingsGet()) || {}).autoNext !== false; } catch (e) { /* 读设置失败默认连播 */ }
        // 尝试从当前视图取 vodId（详情页连播时记录观看进度）。仅 CatVod 源使用 Detail.vodId：
        // Kazumi 源从弹窗直接起播，Detail.vodId 可能残留上一次 CatVod 详情的 id，须隔离（T4）。
        let vodId = '';
        try {
            if (!String(site).startsWith('kazumi:') && typeof Detail !== 'undefined' && Detail.vodId) vodId = Detail.vodId;
        } catch (e) { /* ignore */ }
        this._seq = (autoNext && Array.isArray(episodes) && (epIndex || 0) + 1 < episodes.length)
            ? { site, flag, title, episodes, index: epIndex || 0, vodId, kazumiSrc: kazumiSrc || '' }
            : null;
        // 记录本次播放元信息（观看统计 / 最近观看用；断流重连与单集播放同样可累计）
        this._curMeta = { site, title, subtitle: subtitle || '', vodId, kazumiSrc: kazumiSrc || '',
            totalEps: (Array.isArray(episodes) ? episodes.length : 0) };
        // Kazumi 源封面持久化：起播时同步把 Bangumi 封面缓存落进本次播放元信息，
        // 历史/最近观看卡重启后仍能显示封面（Bangumi 缓存本身就是 localStorage 持久化的）。
        if (String(site).startsWith('kazumi:') && typeof Kazumi !== 'undefined' && Kazumi.getCachedBangumiCover) {
            this._curMeta.pic = Kazumi.getCachedBangumiCover(title) || '';
        }

        // Kazumi 源分支（kimi UI）：site 为 kazumi:规则名 时走规则引擎解析
        if (String(site).startsWith('kazumi:')) {
            return await this._playKazumi(site, flag, id, title, subtitle, episodes, epIndex,
                carrySpeed, carryFullscreen, trace, playAbort.signal);
        }

        showLoading();
        let rsp;
        try {
            const vipFlags = await this.getVipFlags();
            rsp = await doAction('playerContent', {
                site, flag, id, vipFlags: JSON.stringify(vipFlags),
            }, null, { requestId: trace.requestId, playSessionId: trace.playSessionId,
                signal: playAbort.signal, timeoutMs: 30000 });
        } catch (e) {
            hideLoading();
            this._seq = null;
            if (playAbort.signal.aborted) {
                return { ok: false, reason: 'play-cancelled', ...trace };
            }
            warnToast('取播放地址失败');
            return { ok: false, reason: '取播放地址失败', ...trace };
        }
        hideLoading();
        const data = (rsp && typeof rsp === 'object') ? rsp : {};
        // jar 蜘蛛失败（如网盘 Cookie 无效/分享失效）时后端会附 error 原因，直接提示不再尝试解析
        if (data.error) {
            this._seq = null;
            const runtimeError = (data.error && typeof data.error === 'object') ? data.error : null;
            const message = runtimeError ? String(runtimeError.message || runtimeError.code || '播放运行时失败') : String(data.error);
            warnToast(message);
            return {
                ok: false,
                reason: (runtimeError && runtimeError.code) || 'play-error',
                error: message,
                requestId: data.requestId || trace.requestId,
                playSessionId: data.playSessionId || trace.playSessionId,
            };
        }
        const rawUrl = String(data.url || '').trim();
        const route = await this._resolvePlayerRoute(data, rawUrl);
        if (!route.ok) {
            this._seq = null;
            const note = route.reason || '播放地址为空';
            this._showDialog(title, subtitle, '', rawUrl, note, data.header);
            return { ok: false, reason: note, requestId: trace.requestId,
                playSessionId: trace.playSessionId };
        }
        const url = route.url;
        const parse = route.parse;
        const playHeader = (data.header && typeof data.header === 'object') ? data.header : {};

        // mpv 没有 Android ExoPlayer 的 Widevine/PlayReady 设备 DRM 能力。
        if (data.drm) {
            this._seq = null;
            const note = '该播放源需要 DRM，桌面版 mpv 暂不支持';
            this._showDialog(title, subtitle, '', url, note, playHeader);
            return { ok: false, reason: 'drm-not-supported', requestId: trace.requestId,
                playSessionId: trace.playSessionId };
        }

        // parse=1：后台自动解析出直链并起播（单集；下一集由 _onExit 连播推进）
        if (parse === 1) {
            // 已是媒体直链则无需解析（部分源 parse 标记不准）
            if (DIRECT_MEDIA_RE.test(url.split('?')[0])) {
                return await this._playDirect(url, {
                    title, subtitle, flag, header: playHeader,
                    speed: carrySpeed, fullscreen: carryFullscreen,
                    format: data.format, subs: data.subs, position: data.position,
                    ...trace,
                });
            }
            showLoading();
            warnToast('正在后台解析播放地址…');
            let resolved = null;
            try { resolved = await this._awaitTimeout(
                window.vpc.resolveParse(url, route.parsers, trace), 15000, trace); } catch (e) { /* 解析异常 */ }
            if (!(resolved && resolved.ok)) {
                // captureDirect 兜底：无解析接口时缩短超时，避免用户等太久
                const fallbackMs = (resolved && resolved.reason === 'no-parses') ? 10000 : 15000;
                try {
                    const cap = await this._awaitTimeout(
                        window.vpc.captureDirect(url, false, trace), fallbackMs, trace);
                    if (cap && cap.ok) resolved = cap;
                } catch (e) { /* 抓取异常 */ }
            }
            hideLoading();
            if (resolved && resolved.ok) {
                try {
                    const mergedHeader = { ...playHeader, ...(resolved.header || {}) };
                    const r = await window.vpc.playUrl(resolved.url, {
                        title, subtitle, flag, header: mergedHeader, speed: carrySpeed, fullscreen: carryFullscreen,
                        format: data.format, subs: data.subs, position: data.position,
                        ...trace,
                    });
                    if (r && r.ok) return this._mpvSuccess(r, resolved.url, `解析成功（${resolved.via || ''}），已在 mpv 播放`);
                    if (r && !r.ok) {
                        return this._mpvFailure(r, {
                            title, subtitle, url: resolved.url, header: mergedHeader,
                            prefix: '解析成功但 mpv 未能开始播放',
                        });
                    }
                } catch (e) { /* 播放异常走兜底 */ }
            }
            const note = resolved && resolved.reason === 'no-parses'
                ? '当前配置未含解析接口：请在”设置 → 源设置”载入含 parses 的配置后重试'
                : `解析失败：${(resolved && resolved.reason) || '未知错误'}`;
            this._seq = null; // 本集未起播，连播链终止
            // 解析成功但 mpv 播放失败时，把解出的直链+头交给弹窗，用户可转外部播放器
            const dlgUrl = (resolved && resolved.ok && resolved.url) ? resolved.url : url;
            const dlgHeader = (resolved && resolved.ok)
                ? { ...playHeader, ...(resolved.header || {}) } : playHeader;
            this._showDialog(title, subtitle, '', dlgUrl, note, dlgHeader);
            return { ok: false, reason: note, url: dlgUrl, requestId: trace.requestId,
                playSessionId: trace.playSessionId };
        }

        // 直链源：单集交 mpv（连播由渲染层在 mpv 退出后推进，不再依赖 mpv 队列）
        try {
            const r = await window.vpc.playUrl(url, {
                title, subtitle, flag, parse, header: playHeader,
                speed: carrySpeed, fullscreen: carryFullscreen,
                format: data.format, subs: data.subs, position: data.position,
                ...trace,
            });
            if (r && r.ok) return this._mpvSuccess(r, url, '已在 mpv 窗口播放');
            if (r && !r.ok) return this._mpvFailure(r, { title, subtitle, url, header: playHeader });
        } catch (e) { /* IPC 异常，走预览兜底 */ }
        this._seq = null;

        // HTML5 预览兜底（m3u8/parse=1 不给内嵌地址，只留复制）
        const isHls = /\.m3u8(\?|$)/i.test(url);
        const note = parse === 1
            ? '该线路需要解析接口（parse=1）'
            : (isHls ? 'HLS(m3u8) 链接浏览器无法直播，建议安装 mpv 后重试' : '');
        this._showDialog(title, subtitle, (isHls || parse === 1) ? '' : url, url, note, playHeader);
        return { ok: false, reason: 'mpv-play-failed', url, requestId: trace.requestId,
            playSessionId: trace.playSessionId };
    },

    /**
     * CatVod/FongMi 配置顶层 flags 会作为 playerContent 的 vipFlags 传给
     * Spider。旧版 PC 固定传空数组，夸克/解析类 JAR 因此拿不到线路白名单。
     * 结果缓存 30 秒，配置热更新后自然刷新，不把完整配置写入播放记录。
     */
    async getVipFlags() {
        const now = Date.now();
        if (Array.isArray(this._vipFlags) && now - this._vipFlagsAt < 30000) {
            return this._vipFlags.slice();
        }
        try {
            const state = await getJson('/sites');
            const flags = state && Array.isArray(state.flags) ? state.flags : [];
            this._vipFlags = flags.filter((v) => v !== null && v !== undefined).map((v) => String(v));
            this._vipFlagsAt = now;
        } catch (e) {
            this._vipFlags = [];
            this._vipFlagsAt = now;
        }
        return this._vipFlags.slice();
    },

    /** 对齐 FongMi ParseJob.setParse 的 json:/parse:<name> 选择语义。 */
    async _resolvePlayerRoute(data, rawUrl) {
        if (!rawUrl) return { ok: false, reason: data.error || '播放地址为空' };
        const playUrl = String(data.playUrl || '').trim();
        if (/^json:/i.test(playUrl)) {
            const parserUrl = playUrl.slice(5).trim();
            if (!/^https?:\/\//i.test(parserUrl)) return { ok: false, reason: 'json 解析器地址无效' };
            return { ok: true, url: rawUrl, parse: 1,
                parsers: [{ url: parserUrl, type: 1, name: 'json' }] };
        }
        if (/^parse:/i.test(playUrl)) {
            const name = playUrl.slice(6).trim();
            const state = await getJson('/sites').catch(() => ({}));
            const parses = state && Array.isArray(state.parses) ? state.parses : [];
            const parser = parses.find((item) => {
                if (!item || typeof item !== 'object') return false;
                const names = [item.name, item.id, item.key, item.flag]
                    .filter((v) => v !== undefined && v !== null).map(String);
                return names.includes(name);
            });
            if (!parser || !parser.url) return { ok: false, reason: `解析器不存在：${name}` };
            return { ok: true, url: rawUrl, parse: 1, parsers: [parser] };
        }
        return {
            ok: true,
            url: playUrl ? playUrl + rawUrl : rawUrl,
            parse: parseInt(data.parse, 10) === 1 ? 1 : 0,
        };
    },

    resetVipFlags() {
        this._vipFlags = null;
        this._vipFlagsAt = 0;
    },

    /**
     * 主进程只有在 mpv 真正加载媒体后才会返回 ok=true；统一保留实际地址，
     * 让上层调用方和断流重连都使用最终交给 mpv 的 URL。
     */
    _mpvSuccess(r, fallbackUrl, msg) {
        const result = { ...(r || {}), ok: true, url: (r && r.url) || fallbackUrl || '' };
        this._rememberSession(result);
        this._lastUrl = result.url;
        this._mpvToast(result, msg);
        return result;
    },

    /** mpv 已启动但媒体未加载/进程退出时的统一反馈；弹窗始终保留可复制地址。 */
    _mpvFailure(r, meta = {}) {
        const result = (r && typeof r === 'object') ? { ...r, ok: false } : { ok: false };
        if (meta.requestId && !result.requestId) result.requestId = meta.requestId;
        if (meta.playSessionId && !result.playSessionId) result.playSessionId = meta.playSessionId;
        const reason = String(result.reason || 'mpv-play-failed');
        const url = String(result.url || meta.url || '');
        const labels = {
            'mpv-missing': '未检测到 mpv，请在设置中安装或指定播放器',
            'mpv-spawn-failed': 'mpv 启动失败',
            'mpv-start-timeout': 'mpv 已启动，但在 30 秒内没有加载媒体',
            'mpv-exited-before-playback': 'mpv 已退出，媒体尚未开始播放',
            'mpv-exited': 'mpv 未能保持运行',
            'play-failed': '当前线路播放失败',
            'play-cancelled': '播放请求已被新的播放操作取消',
        };
        let note = labels[reason] || `mpv 播放失败：${reason}`;
        const detail = String(result.error || '').replace(/\s+/g, ' ').trim();
        if (detail) note += `：${detail.slice(-240)}`;
        if (meta.prefix && reason !== 'mpv-missing') note = `${meta.prefix}：${note}`;
        // 旧请求等待起播期间用户可能已经点了新剧集；旧请求返回取消时不能
        // 清掉新请求刚建立的连播上下文，也不能弹出旧地址的失败窗口。
        if (reason === 'play-cancelled') return { ...result, reason, url };
        this._seq = null;
        if (reason === 'mpv-missing' && !this._mpvMissingToastShown) {
            this._mpvMissingToastShown = true;
            warnToast('未检测到 mpv：执行 node scripts/download-binaries.js 安装后重启');
        }
        this._showDialog(meta.title, meta.subtitle, meta.previewUrl || '', url, note, meta.header || null);
        return { ...result, reason, url };
    },

    /** 起播成功提示；外部播放器模式 | 开启 Anime4K/边下边播时额外标注状态。 */
    _mpvToast(r, msg) {
        if (r && r.viaExternal) {
            warnToast('已交外部播放器播放');
            return;
        }
        const extra = [];
        if (r && r.anime4k) extra.push('Anime4K 超分已生效');
        if (r && r.simulDl) extra.push('已同步加入后台下载');
        warnToast(extra.length ? `${msg}（${extra.join('，')}）` : msg);
    },

    /**
     * Kazumi 源播放（kimi UI 设计，glm5.2 实现逻辑）：
     * 1. 调 /kazumi/action do=kazumiResolve 取播放页 URL 与规则 headers
     * 2. 调 window.vpc.captureDirect 抓真实视频流（隐藏 BrowserWindow 拦截 m3u8/mp4）
     * 3. 抓到直链后与规则 headers 合并交 mpv 播放
     * 4. 连播上下文与 CatVod 源共用同一套渲染层驱动机制
     */
    async _playKazumi(site, flag, id, title, subtitle, episodes, epIndex, carrySpeed, carryFullscreen,
        trace, signal) {
        const pluginName = String(site).slice(7); // 去掉 kazumi: 前缀
        if (!pluginName) { this._seq = null; return { ok: false, reason: '规则名为空' }; }
        showLoading();
        warnToast('正在解析 Kazumi 源播放地址…');
        let resolved = null;
        try {
            // 步骤 1：取播放页与规则 headers（glm5.2 后端端点）
            const rsp = await doAction('kazumiResolve', { pluginName, url: id }, '/kazumi/action', {
                requestId: trace.requestId, playSessionId: trace.playSessionId,
                signal, timeoutMs: 30000,
            });
            const data = (rsp && typeof rsp === 'object') ? rsp : {};
            const pageUrl = data.pageUrl || id;
            const header = {};
            if (data.userAgent) header['User-Agent'] = data.userAgent;
            if (data.referer) header['Referer'] = data.referer;
            const legacy = !!data.useLegacyParser;
            // 步骤 2：captureDirect 抓真实流（主进程隐藏窗口；旧解析器规则走 iframe src 监听）
            try {
                const cap = await this._awaitTimeout(
                    window.vpc.captureDirect(pageUrl, legacy, trace), 15000, trace);
                if (cap && cap.ok) resolved = { url: cap.url, header: { ...header, ...(cap.header || {}) } };
            } catch (e) { /* 抓取异常 */ }
        } catch (e) { /* 解析异常 */ }
        hideLoading();
        if (resolved && resolved.ok !== false && resolved.url) {
            try {
                const r = await window.vpc.playUrl(resolved.url, {
                    title, subtitle, flag, header: resolved.header, speed: carrySpeed, fullscreen: carryFullscreen,
                    ...trace,
                });
                if (r && r.ok) return this._mpvSuccess(r, resolved.url, `Kazumi 源「${pluginName}」已在 mpv 播放`);
                if (r && !r.ok) {
                    return this._mpvFailure(r, {
                        title, subtitle, url: resolved.url, header: resolved.header,
                        prefix: 'Kazumi 已解析出地址，但 mpv 未能开始播放',
                    });
                }
            } catch (e) { /* 播放异常走兜底 */ }
        }
        this._seq = null; // 本集未起播，连播链终止
        const note = resolved && resolved.reason ? `Kazumi 源解析失败：${resolved.reason}` : 'Kazumi 源未解析到可播放地址';
        // 抓到直链但 mpv 播放失败时，把直链+规则头交给弹窗供转外部播放器
        const dlgUrl = (resolved && resolved.url) ? resolved.url : id;
        const dlgHeader = (resolved && resolved.url) ? resolved.header : null;
        this._showDialog(title, subtitle, '', dlgUrl, note, dlgHeader);
        return { ok: false, reason: note, url: dlgUrl };
    },

    /** 直链直接交 mpv（parse=1 但地址已是媒体直链时的快路径）。 */
    async _playDirect(url, meta) {
        try {
            const r = await window.vpc.playUrl(url, meta);
            if (r && r.ok) return this._mpvSuccess(r, url, '已在 mpv 窗口播放');
            if (r && !r.ok) return this._mpvFailure(r, { ...meta, url });
        } catch (e) { /* IPC 异常 */ }
        this._showDialog(meta.title, meta.subtitle, '', url, '', meta.header || null);
        return { ok: false, reason: 'mpv-play-failed', url,
            requestId: meta.requestId || '', playSessionId: meta.playSessionId || '' };
    },

    _close() {
        const v = document.getElementById('player-video');
        if (v) { try { v.pause(); } catch (e) { /* ignore */ } v.removeAttribute('src'); v.load(); }
        closeDialog('playerDialog');
    },

    _showDialog(title, subtitle, previewUrl, copyUrl, note, header) {
        $('#player-title').text((title || '播放') + (subtitle ? ' · ' + subtitle : ''));
        $('#player-note').text(note || '');
        $('#player-note').toggle(!!note);
        $('#player-url').text(copyUrl || '');
        $('#player-preview').toggle(!!previewUrl);
        // 外部播放器出口：仅在有可播地址时可用；记录该地址与解析出的 Referer/UA 头供起播用
        $('#player-external').toggle(!!copyUrl);
        this._extUrl = copyUrl || '';
        this._extHeader = (header && typeof header === 'object') ? header : null;
        const v = document.getElementById('player-video');
        v.removeAttribute('src');
        $('#player-video').hide();
        openDialog('playerDialog');
    },

    /** 把当前弹窗地址交外部播放器（VLC/PotPlayer/mpv/系统默认）。带解析出的 Referer/UA 头，
     *  header 无法随播放器命令行传递时（PotPlayer/系统默认）给出降级告警。 */
    async _openExternal() {
        const url = this._extUrl || $('#player-url').text();
        if (!url) { warnToast('没有可播放的地址'); return; }
        let r;
        try {
            r = await window.vpc.externalPlayer(url, { header: this._extHeader || undefined });
        } catch (e) { warnToast('调用外部播放器失败'); return; }
        if (r && r.ok) {
            if (r.via === 'system-default') warnToast('已交系统默认程序打开');
            else warnToast(`已交外部播放器打开${r.headerDropped ? '（该播放器无法传递鉴权头，若播放失败请改用 VLC/mpv）' : ''}`);
            return;
        }
        const reason = r && r.reason;
        if (reason === 'need-header-player') {
            warnToast('该地址需鉴权头，系统默认播放器无法传递：请在 设置 → 组件状态 指定 VLC/mpv 作为外部播放器');
        } else if (reason === 'no-external-player') {
            warnToast('未找到可用的外部播放器：请在 设置 → 组件状态 指定 VLC/PotPlayer/mpv 路径');
        } else {
            warnToast('外部播放器打开失败：' + (reason || '未知错误'));
        }
    },
};

(function (root) {
    root.VPC = root.VPC || {};
    root.VPC.player = Player;
}(typeof window !== 'undefined' ? window : globalThis));
