/**
 * player.js — 播放入口（Phase 4，Phase 7 加 VIP 解析）
 *
 * 流程：playerContent 取真实地址 →
 *   parse=1：后台自动解析（配置 parses 接口优先，失败后隐藏窗口直开
 *   链接抓媒体请求），解出直链后自动拉起 mpv，全程无需手动操作；
 *   mpv 缺失：<video> 预览兜底（m3u8 等 HLS 直链提示需 mpv）。
 *
 * 自动连播（统一由渲染层驱动，直链/解析源同一套逻辑）：
 *   每次只交 mpv 单集；mpv 播完自然退出（yuki:player-exit 附带进度），
 *   渲染层判定「看完」（剩余<8s 或刚收到 ended）且队列还有下一集时，
 *   自动解析并起播下一集；用户提前关闭 mpv 则终止连播链。
 */
/* global $, doAction, getJson, createRuntimeId, warnToast, showLoading, hideLoading, openDialog, closeDialog, Kazumi, Records, openSettingsPanel */

// 媒体直链后缀：已是直链则无需解析（share/播放页等才需解析）
const DIRECT_MEDIA_RE = /\.(m3u8|mp4|flv|mov|mkv|webm|ts)(\?|#|$)/i;

function mergePlayHeaders(...sources) {
    const out = {};
    const keys = new Map();
    for (const source of sources) {
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
    _nativeRecorded: new Map(), // 原生队列 sessionId → 已逐集记过账的 playlistPos 集合（exit 补记当前集时去重）
    _lastExitedWatch: null, // 断流退出后主进程重连时复用上一会话元信息
    _currentPlayback: null, // 原始 playerContent 参数；断流时必须重新解析，不能复用 CDN URL
    _reconnectAttempts: 0,  // 每个原始播放请求最多自动刷新一次
    _reconnectInProgress: false,
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
        if (window.yuki && window.yuki.onPlayerEnded) {
            window.yuki.onPlayerEnded((info) => this._onEnded(info));
            window.yuki.onPlayerExit((info) => this._onExit(info));
            if (window.yuki.onPlayerSession) {
                window.yuki.onPlayerSession((info) => this._adoptSession(info));
            }
            if (window.yuki.onEpisodeSkip) {
                window.yuki.onEpisodeSkip((info) => this._onEpisodeSkip(info));
            }
        }
    },

    /** 单集播完（end-file eof，附会话号）：按会话记录时间戳；旧集延迟 ended 不误判新集。 */
    _onEnded(info) {
        // 队列记账诊断：无条件打印事件关键字段，定位 nativeQueue/playlistPos 断点
        console.log(`[队列记账?] sid=${info && info.sessionId} native=${!!(info && info.nativeQueue)} ` +
            `pos=${info && info.playlistPos} wall=${info && info.itemWallSec} queueLen=${info && info.queueLen}`);
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
        // 原生多集队列（静态直链批量）：连播由 mpv 进程内推进，进程不会逐集退出，
        // 观看统计/历史改为逐集在 ended 记账——口径与旧的逐集会话一致（<15s 短播不计、
        // 每集一条历史、集名取当集）。未看完的当前集在最终 exit 补记（见 _onExit）。
        if (info && info.nativeQueue && typeof info.playlistPos === 'number' && info.playlistPos >= 0) {
            const meta = (typeof sid === 'number') ? this._watchSessions.get(sid) : null;
            const wall = (typeof info.itemWallSec === 'number') ? info.itemWallSec : null;
            const watched = (wall != null) ? wall
                : ((typeof info.pos === 'number') ? info.pos : null);
            // 诊断：队列逐集记账的四个前提（会话元信息/时长门槛）任一不满足都会静默跳过
            console.log(`[队列记账] pos=${info.playlistPos} wall=${wall} meta=${!!meta} watched=${watched}`);
            if (meta && typeof watched === 'number' && watched >= 15) {
                const names = Array.isArray(meta.nativeEpisodes) ? meta.nativeEpisodes : [];
                const snapshot = { ...meta, subtitle: names[info.playlistPos] || meta.subtitle || '' };
                // 每集必须开独立观看链：chainId 的链内去重是给「断流重连重播同一集」用的，
                // 整季共用一条链时第 2 集起 pos 不高于链内最大值 → 时长增量被扣成 0、
                // 次数只计一次（表现为看一整季统计只多约一集）。逐集独立后口径回归旧逐集会话；
                // 时长走 progress.wallWatched（= 本集墙钟 itemWallSec，与旧单集会话同通道），
                // 缺失时 _writeWatch 自动回退 pos 增量。
                snapshot.chainId = ++this._watchChain;
                const progress = {
                    pos: (typeof info.pos === 'number') ? info.pos : null,
                    duration: (typeof info.duration === 'number') ? info.duration : null,
                    fullscreen: info.fullscreen, speed: info.speed,
                    wallWatched: (wall != null && wall > 0) ? wall : undefined,
                };
                // 记录该下标已记账：exit 补记当前集时据此去重（末集自然播完后的退出不重复计）
                if (typeof sid === 'number') {
                    let recorded = this._nativeRecorded.get(sid);
                    if (!recorded) {
                        recorded = new Set();
                        this._nativeRecorded.set(sid, recorded);
                        if (this._nativeRecorded.size > 64) {
                            const oldest = this._nativeRecorded.keys().next().value;
                            this._nativeRecorded.delete(oldest);
                        }
                    }
                    recorded.add(info.playlistPos);
                }
                this._watchWrite = this._watchWrite
                    .catch(() => { /* 上一次失败不阻塞后续统计 */ })
                    .then(() => this._writeWatch(progress, snapshot, watched));
                // 收藏观看进度：原生队列进程不逐集退出，_onExit 的进度更新走不到，
                // 改为逐集在 ended 更新（口径与旧逐集会话一致）
                this._updateFavProgress(snapshot, info.playlistPos,
                    (typeof info.pos === 'number') ? info.pos : 0,
                    (typeof info.duration === 'number') ? info.duration : 0);
            }
        }
    },

    /** 收藏条目观看进度更新（仅带 vodId 的 CatVod 源生效）；fire-and-forget 不影响播放。 */
    _updateFavProgress(meta, playlistPos, pos, duration) {
        if (!meta || !meta.vodId) return;
        if (typeof Favorites === 'undefined' || !Favorites.updateProgress) return;
        try {
            const percent = (duration > 0) ? Math.min(100, Math.round((pos / duration) * 100)) : 0;
            Favorites.updateProgress(meta.site, meta.vodId, {
                currentEp: playlistPos + 1,
                totalEps: meta.totalEps || 0,
                percent,
                ts: Date.now(),
            }).catch(() => { /* 进度更新失败不影响播放 */ });
        } catch (e) { /* 进度更新失败不影响播放 */ }
    },

    /** 原生队列退出补记「正在看的这一集」（eof 未触发的当前集）。
     *  口径与旧逐集会话的 pos 回退一致：watched=pos，≥15s 才计；该下标若已在 ended
     *  记过账（如末集自然播完后的退出）则跳过防重复。会话级墙钟跨集不可分摊，
     *  故不用 exit 的 wallWatched。 */
    _recordNativePartial(info) {
        const sid = (info && typeof info.sessionId === 'number') ? info.sessionId : 0;
        const meta = sid ? this._watchSessions.get(sid) : null;
        if (!meta) return;
        const p = (info && typeof info.playlistPos === 'number' && info.playlistPos >= 0)
            ? info.playlistPos : -1;
        if (p < 0) return;
        const recorded = this._nativeRecorded.get(sid);
        if (recorded && recorded.has(p)) return;
        const watched = (typeof info.pos === 'number') ? info.pos : null;
        if (typeof watched !== 'number' || watched < 15) return;
        const names = Array.isArray(meta.nativeEpisodes) ? meta.nativeEpisodes : [];
        const snapshot = { ...meta, subtitle: names[p] || meta.subtitle || '' };
        snapshot.chainId = ++this._watchChain; // 独立观看链（同 _onEnded 逐集口径）
        const progress = {
            pos: watched,
            duration: (typeof info.duration === 'number') ? info.duration : null,
            fullscreen: info.fullscreen, speed: info.speed,
        };
        this._watchWrite = this._watchWrite
            .catch(() => { /* 上一次失败不阻塞后续统计 */ })
            .then(() => this._writeWatch(progress, snapshot, watched));
        this._updateFavProgress(snapshot, p, watched,
            (typeof info.duration === 'number') ? info.duration : 0);
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

    /** 上/下集快捷键（逐集会话）：按当前线路推进或回退一集；原生队列由主进程直跳。 */
    async _onEpisodeSkip({ dir } = {}) {
        const d = Number(dir) || 0;
        if (!d) return;
        const seq = this._seq || (this._currentPlayback
            && Array.isArray(this._currentPlayback.episodes)
            && this._currentPlayback.episodes.length > 1
            ? {
                site: this._currentPlayback.site, flag: this._currentPlayback.flag,
                title: this._currentPlayback.title,
                episodes: this._currentPlayback.episodes,
                index: this._currentPlayback.epIndex || 0,
                vodId: this._currentPlayback.vodId,
                kazumiSrc: this._currentPlayback.kazumiSrc || '',
            }
            : null);
        if (!seq) { warnToast('当前播放没有可切换的剧集列表'); return; }
        const nextIndex = (Number(seq.index) || 0) + d;
        const next = seq.episodes[nextIndex];
        if (!next) { warnToast(d > 0 ? '已经是最后一集' : '已经是第一集'); return; }
        warnToast(`${d > 0 ? '下一' : '上一'}集：${next.name || ''}`);
        this._playToken += 1;
        this.play(seq.site, seq.flag, next.url, seq.title, next.name,
            seq.episodes, nextIndex, seq.kazumiSrc);
    },

    /**
     * mpv 进程退出：连播核心驱动点。
     * 「看完」判定：退出时剩余时长 <8s；进度取不到（IPC 已断）时，
     * 10s 内收到过 ended 事件同样视为看完。提前关闭 → 终止连播链。
     */
    async _onExit(info) {
        // 原生多集队列：已看完的各集已在 ended 记账（_onEnded）；退出时补记「正在看的
        // 这一集」——eof 未触发（中途关窗/断流退出是常态用法），漏记会让历史、最近观看
        // 和统计在该场景下完全不更新。不再按整条会话重复计账、不断流重连（重连会从列表头
        // 重播）、不推进渲染层连播链。
        if (info && info.nativeQueue) {
            this._recordNativePartial(info);
            this._seq = null;
            this._currentPlayback = null;
            this._reconnectInProgress = false;
            if (info && typeof info.sessionId === 'number') {
                this._watchSessions.delete(info.sessionId);
                this._nativeRecorded.delete(info.sessionId);
            }
            return;
        }
        // 观看统计（「我的」页）：任何 mpv 会话真实退出都累计时长/次数，与连播链无关
        this._recordWatch(info);
        // 非当前会话的退出（切集时被杀旧进程的延迟退出/本地播放）不驱动连播
        if (info && typeof info.sessionId === 'number' && info.sessionId && info.sessionId !== this._session) return;
        const token = this._playToken;
        const done = this._isDone(info);
        if (info && info.quit) {
            this._seq = null;
            this._currentPlayback = null;
            this._reconnectInProgress = false;
            return;
        }
        const canRefresh = !done && this._currentPlayback && this._reconnectAttempts < 1
            && typeof info.pos === 'number' && typeof info.duration === 'number' && info.duration > 0
            && info.pos >= 15 && (info.duration - info.pos) >= 8;
        if (canRefresh) {
            this._reconnectAttempts += 1;
            this._reconnectInProgress = true;
            const retry = { ...this._currentPlayback };
            warnToast('播放被中断，正在刷新播放地址并重连…');
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (token !== this._playToken || !this._currentPlayback) {
                this._reconnectInProgress = false;
                return;
            }
            const result = await this.play(retry.site, retry.flag, retry.id, retry.title,
                retry.subtitle, retry.episodes, retry.epIndex, retry.kazumiSrc,
                { reconnectAttempt: 1 });
            this._reconnectInProgress = false;
            if (!result || !result.ok) this._seq = null;
            return;
        }
        const seq = this._seq;
        if (!seq) return;
        // 播放途中关掉连播开关则不再推进
        let autoNext = true;
        try { autoNext = ((await window.yuki.settingsGet()) || {}).autoNext !== false; } catch (e) { /* 读失败默认连播 */ }
        if (!autoNext) { this._seq = null; return; }
        // 等待期间用户已手动起播新内容：旧进程的退出不再驱动连播
        if (token !== this._playToken) return;
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
        if (!done) {
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
            s = (await window.yuki.settingsGet()) || {};
            if (s.watchStatsEnabled === false) return;
            // 隐身模式：不写观看统计/最近观看/播放历史（本地文件与下载播放路径均有此判断，
            // 此前唯独主播放链路漏掉，导致隐身模式下历史照常累积）
            if (window._incognito) return;
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
            if (!alreadyCounted || addSeconds > 0) await window.yuki.settingsSet('watchStats', stats);
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
            await window.yuki.settingsSet('recentWatches', rw);
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
                if (cancelContext && window.yuki && window.yuki.cancelRuntime) {
                    Promise.resolve(window.yuki.cancelRuntime(cancelContext)).catch(() => {});
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
        const reconnectMeta = this._reconnectInProgress && this._lastExitedWatch
            ? this._lastExitedWatch.meta : null;
        const meta = { ...(reconnectMeta || this._curMeta || {}) };
        // 断流刷新后的新 mpv 会话沿用旧观看链；普通显式起播开新链。
        if (typeof meta.chainId !== 'number') meta.chainId = ++this._watchChain;
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
        // 原生多集队列：缓存逐集集名表。mpv 的 playlistPos 即所传列表下标（整表装载、
        // 仅起点可选），ended 逐集记账时据此取「当集名」写入历史，替代会话级 subtitle。
        if (result.nativeQueue && this._currentPlayback && Array.isArray(this._currentPlayback.episodes)) {
            meta.nativeEpisodes = this._currentPlayback.episodes.map((e) => String((e && e.name) || ''));
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
            const s = (await window.yuki.settingsGet()) || {};
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
    async play(site, flag, id, title, subtitle, episodes, epIndex, kazumiSrc, runtimeOpts = {}) {
        // 新起播占令牌：任何在途的旧进程 exit 处理随后发现令牌变化即放弃连播推进
        this._playToken += 1;
        const reconnectAttempt = Number(runtimeOpts.reconnectAttempt || 0);
        if (!reconnectAttempt) {
            this._reconnectAttempts = 0;
            this._reconnectInProgress = false;
        }
        this._currentPlayback = String(site).startsWith('kazumi:') ? null
            : { site, flag, id, title, subtitle, episodes, epIndex, kazumiSrc };
        const previousTrace = this._playContext;
        if (previousTrace && window.yuki.cancelRuntime) {
            window.yuki.cancelRuntime(previousTrace).catch(() => {});
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
        try { autoNext = ((await window.yuki.settingsGet()) || {}).autoNext !== false; } catch (e) { /* 读设置失败默认连播 */ }
        // 元信息必须先于原生队列分支装配：队列会话经 _rememberSession 读取 _curMeta
        // （观看统计/最近观看/历史都依赖它），放在分支之后会导致整季会话元信息为空。
        let vodId = '';
        try {
            if (!String(site).startsWith('kazumi:') && typeof Detail !== 'undefined' && Detail.vodId) vodId = Detail.vodId;
        } catch (e) { /* ignore */ }
        this._curMeta = { site, title, subtitle: subtitle || '', vodId, kazumiSrc: kazumiSrc || '',
            totalEps: (Array.isArray(episodes) ? episodes.length : 0) };
        // 尝试从当前视图取 vodId（详情页连播时记录观看进度）。仅 CatVod 源使用 Detail.vodId：
        // Kazumi 源从弹窗直接起播，Detail.vodId 可能残留上一次 CatVod 详情的 id，须隔离（T4）。
        // （vodId 已在上方声明并赋值，此处不再重复声明——曾因重复 let 引发 SyntaxError。）
        // 原生整季队列：整季以本地代理地址装载进 mpv 播放列表——右键菜单可见可切、
        // 同进程连播推进；代理在 mpv 打开每集时才解析（直链零过期）。
        // 排除项：网盘类源仅针对 CatVod（夸克等解析慢且依赖 Cookie 会话）；
        // Kazumi 是番剧规则引擎——规则名含「ali/移动」等子串会被误伤，故不做网盘过滤。
        // 边下边播开启时不走原生队列：下载需要真实直链，逐集链路才能同步入队
        // 边下边播与原生队列兼容：代理每解析成功一集，主进程即静默入队下载
        // （集名含 Bangumi 名，去重键与手动一致）；队列起播失败仍回退本链路兜底。
        // 外部主播放器（VLC/PotPlayer）同样走队列且**必须走**，并启用代理管道
        // （pipe）：PotPlayer 对 302 后的 CDN 直连无法可靠携带鉴权头（命令行开关在
        // 闭源解析器上不可靠、也不支持 #EXTVLCOPT），管道模式由代理在上游注入会话头、
        // HLS 清单重写回本地分片端点——播放器只与 127.0.0.1 通信。内置 mpv 不开管道：
        // 全局 --http-header-fields 已覆盖重定向后的每个请求，302 零拷贝直连。
        // 连播由 PotPlayer/VLC 对导入 m3u 的原生列表推进；下方 launched 视同起播成功，
        // 杜绝回退二次 spawn 弹双窗口。
        let externalPrimary = false;
        try { externalPrimary = ((await window.yuki.playerConfig()) || {}).mode === 'external'; } catch (e) { /* 读失败按内置处理 */ }
        if (autoNext && Array.isArray(episodes) && episodes.length > 1 && window.yuki.buildPlaylist) {
            const isKazumi = String(site || '').startsWith('kazumi:');
            if (this._playContext === trace && !playAbort.signal.aborted) showLoading('构建播放列表…');
            const vip = await this.getVipFlags().catch(() => []);
            // Kazumi：确保 Bangumi 分集缓存就绪（未打开过分集页签时按详情页 subjectId 拉取一次），
            // 集名优先级 = Bangumi（集数+名称）→ 规则 identifier → 第N集
            if (isKazumi && typeof Kazumi !== 'undefined' && typeof Kazumi.bangumiEpisodes === 'function') {
                const subj = (typeof Detail !== 'undefined' && Detail._bgmId) || null;
                const cacheOk = Kazumi._bgmEpsCache && Kazumi._bgmEpsCache.subjectId === subj
                    && Array.isArray(Kazumi._bgmEpsCache.eps) && Kazumi._bgmEpsCache.eps.length;
                if (subj && !cacheOk) {
                    await Kazumi.bangumiEpisodes(subj).then((data) => {
                        const list = (data && data.data) || [];
                        Kazumi._bgmEpsCache = {
                            subjectId: subj,
                            eps: list
                                .filter((ep) => ep && (ep.type == null || ep.type === 0))
                                .map((ep) => ({
                                    no: String(ep.ep || ep.sort || ''),
                                    name: String(ep.name_cn || ep.name || ''),
                                })),
                        };
                    }).catch(() => { /* 拉取失败走 identifier 兜底 */ });
                    if (Kazumi._bgmEpsCache && Kazumi._bgmEpsCache.eps.length) {
                        console.log('[Kazumi] Bangumi 分集示例：', JSON.stringify(Kazumi._bgmEpsCache.eps[0]));
                    }
                }
            }
            // 集名富化：Bangumi（集数+名称）优先，规则 identifier 兜底——必须在
            // 自动拉取之后执行，否则首次播放时缓存未就绪会全部落到第N集。
            const bgmList = (isKazumi && typeof Kazumi !== 'undefined'
                && Kazumi._bgmEpsCache && Array.isArray(Kazumi._bgmEpsCache.eps))
                ? Kazumi._bgmEpsCache.eps : null;
            const qEps = episodes.map((e, i) => {
                let orig = String((e && e.name) || '');
                // 净化：规则/抓流链路把临时文件名当集名时回落「第N集」
                if (/\.(m3u8?|mp4|mkv|ts|flv)$/i.test(orig.trim())) orig = '';
                const b = bgmList && bgmList[i];
                let nm = orig || `第${i + 1}集`;
                if (b && (b.no || b.name)) {
                    nm = b.no ? `${b.no} ${b.name || orig}`.trim() : (b.name || orig);
                }
                return { id: String((e && (e.url ?? e.id)) || ''), name: nm };
            });
            // Kazumi 预热可能包含隐藏窗口抓流（数秒），竞速窗口相应放宽
            const built = await Promise.race([
                window.yuki.buildPlaylist({
                kind: isKazumi ? 'kazumi' : 'catvod',
                title: String(title || ''),
                site: String(site || ''), flag: String(flag || ''),
                pluginName: isKazumi ? String(site).slice(7) : '',
                vipFlags: JSON.stringify(vip || []),
                eps: qEps,
                start: epIndex || 0,
                // 外部主播放器会话：数据面走代理管道（见上方注）
                pipe: externalPrimary || undefined,
                }).catch(() => null),
                new Promise((res) => setTimeout(() => res(null), 20000)),
            ]).catch(() => null);
            if (built && built.ok && Array.isArray(built.entries)
                && built.entries.length === episodes.length) {
                this._seq = null;
                this._currentPlayback = null;
                const entry = built.entries[built.startIndex] || built.entries[0];
                // 加载文案推进：建表是瞬时的，真正的等待发生在首集解析——别让文案停在「构建播放列表」
                if (this._playContext === trace && !playAbort.signal.aborted) {
                    showLoading(`正在打开 ${entry.title || '第1集'}…`);
                }
                const r = await this._playDirect(entry.url, {
                    // 副标题置空：队列会话的 OSD 标题只显示片名——每集集名由 m3u 的
                    // EXTINF 进入 media-title（窗口标题/切集 OSD 自动跟随），避免
                    // osd-playing-msg 在每次装载时都弹「第01集」的陈旧集名。
                    title, subtitle: '', site, vodId,
                    totalEps: episodes.length,
                    playlist: built.entries, epIndex: epIndex || 0,
                    // Kazumi 预热产出的规则头：全局注入，保证清单+分片都带 Referer/UA
                    header: built.headers || undefined,
                    skipProbe: true, source: 'queue', quietFail: true,
                    speed: carrySpeed, fullscreen: carryFullscreen,
                    // 不挂 requestId/playSessionId：起播后数秒内的杂散 cancelRuntime
                    // （详情页重复触发等）曾把已成功解析的原生队列误杀为 play-cancelled；
                    // 用户主动关闭仍经 mpv.stop() 生效，与此通道无关。
                    requestId: '', playSessionId: '',
                }).catch((e) => ({ ok: false, reason: String(e) }));
                // 外部主播放器：yuki:play 固定返回 ok:false+launched（无 file-loaded 可验证）。
                // launched 即已 spawn 成功，必须在此收口返回——若按失败继续走下方回退，
                // 会再 spawn 一次外部播放器弹出双窗口（用户实测）。
                if (r && (r.ok || r.launched)) {
                    // 逐集历史需要集名表：把 entries 标题挂到本会话的观看元信息上
                    if (typeof r.sessionId === 'number') {
                        const wm = this._watchSessions.get(r.sessionId);
                        if (wm) wm.nativeEpisodes = built.entries.map((e) => e.title);
                    }
                    return r;
                }
                // 队列起播失败（首集解析超时/不支持等）：静默回退逐集链路，下次点击自动重试。
                // page 型线路的拉黑由主进程按 parse=1 精确判定（见 yuki:playlist-build）。
            } else {
                // 原生播放列表构建失败：同样静默回退下方逐集连播，无需提示。
            }
        }
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
            // 同步缓存未命中（规则站片名与 Bangumi 官方名不一致等）→ 异步补拉一次：
            // 播放结束时 _writeWatch 再读缓存即可拿到封面，历史卡不再存空 pic
            if (!this._curMeta.pic && Kazumi.getBangumiCover) {
                Kazumi.getBangumiCover(title).catch(() => { /* 失败不影响播放 */ });
            }
        }

        // Kazumi 源分支（kimi UI）：site 为 kazumi:规则名 时走规则引擎解析
        if (String(site).startsWith('kazumi:')) {
            return await this._playKazumi(site, flag, id, title, subtitle, episodes, epIndex,
                carrySpeed, carryFullscreen, trace, playAbort.signal);
        }

        const updatePlayState = (stageName) => {
            if (this._playContext !== trace || playAbort.signal.aborted) return;
            showLoading(`播放进度：${stageName}…`);
        };

        updatePlayState('获取播放地址');
        let rsp;
        try {
            const vipFlags = await this.getVipFlags();
            rsp = await doAction('playerContent', {
                site, flag, id, vipFlags: JSON.stringify(vipFlags),
                refresh: reconnectAttempt ? '1' : '0',
            }, null, { requestId: trace.requestId, playSessionId: trace.playSessionId,
                signal: playAbort.signal, timeoutMs: 30000 });
        } catch (e) {
            hideLoading();
            this._seq = null;
            if (playAbort.signal.aborted) {
                return { ok: false, reason: 'play-cancelled', ...trace };
            }
            // U6.4：自动回退尝试同影片其他线路
            const fb = await this._tryFallbackRoute({ site, flag, id, title, subtitle, episodes, epIndex, kazumiSrc }, '获取播放地址失败', trace);
            if (fb && fb.ok) return fb;
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
            const fb = await this._tryFallbackRoute({ site, flag, id, title, subtitle, episodes, epIndex, kazumiSrc }, message, trace);
            if (fb && fb.ok) return fb;
            warnToast(message);
            const isPan = String(site).toLowerCase().includes('pan') || String(data.url || '').includes('quark');
            this._showDialog(title, subtitle, '', '', message, null, {
                canRetry: true,
                suggestCookie: isPan || message.includes('Cookie'),
                rawDiagnostics: { site, flag, id, error: data.error, requestId: trace.requestId },
            });
            return {
                ok: false,
                reason: (runtimeError && runtimeError.code) || 'play-error',
                error: message,
                requestId: data.requestId || trace.requestId,
                playSessionId: data.playSessionId || trace.playSessionId,
            };
        }
        const rawUrl = String(data.url || '').trim();
        updatePlayState('选择解析线路');
        const route = await this._resolvePlayerRoute(data, rawUrl, { site, flag });
        if (!route.ok) {
            this._seq = null;
            const note = route.reason || '播放地址为空';
            const fb = await this._tryFallbackRoute({ site, flag, id, title, subtitle, episodes, epIndex, kazumiSrc }, note, trace);
            if (fb && fb.ok) return fb;
            this._showDialog(title, subtitle, '', rawUrl, note, data.header, {
                canRetry: true,
                rawDiagnostics: { site, flag, id, routeReason: note, requestId: trace.requestId },
            });
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
            this._showDialog(title, subtitle, '', url, note, playHeader, {
                canRetry: false,
                rawDiagnostics: { site, flag, id, drm: true, requestId: trace.requestId },
            });
            return { ok: false, reason: 'drm-not-supported', requestId: trace.requestId,
                playSessionId: trace.playSessionId };
        }

        // parse=1：后台自动解析出直链并起播（单集；下一集由 _onExit 连播推进）
        if (parse === 1) {
            // 已是媒体直链则无需解析（部分源 parse 标记不准）
            if (DIRECT_MEDIA_RE.test(url.split('?')[0])) {
                updatePlayState('启动播放器');
                return await this._playDirect(url, {
                    title, subtitle, flag, header: playHeader,
                    speed: carrySpeed, fullscreen: carryFullscreen,
                    format: data.format, subs: data.subs, position: data.position,
                    skipProbe: !!data.skipProbe, source: site, site,
                    ...trace,
                });
            }
            updatePlayState('选择解析线路');
            let resolved = null;
            try { resolved = await this._awaitTimeout(
                window.yuki.resolveParse(url, route.parsers, { ...trace, ...(route.context || {}) }),
                15000, trace); } catch (e) { /* 解析异常 */ }
            if (!(resolved && resolved.ok)) {
                // captureDirect 兜底：无解析接口时缩短超时，避免用户等太久
                const fallbackMs = (resolved && resolved.reason === 'no-parses') ? 10000 : 15000;
                try {
                    const cap = await this._awaitTimeout(
                        window.yuki.captureDirect(url, false,
                            { ...trace, ...(route.context || {}), header: playHeader }), fallbackMs, trace);
                    if (cap && cap.ok) resolved = cap;
                } catch (e) { /* 抓取异常 */ }
            }
            hideLoading();
            if (resolved && resolved.ok) {
                updatePlayState('验证媒体');
                try {
                    const mergedHeader = mergePlayHeaders(playHeader, resolved.header);
                    updatePlayState('启动播放器');
                    // playUrl 无内置超时：主进程侧任一子步骤挂起都会让 loading 永转，
                    // 这里统一竞速兜底（mpv 起播上限 30s + 边下边播注册余量）。
                    const r = await this._awaitTimeout(window.yuki.playUrl(resolved.url, {
                        title, subtitle, flag, header: mergedHeader, speed: carrySpeed, fullscreen: carryFullscreen,
                        format: data.format, subs: data.subs, position: data.position,
                        skipProbe: !!(data.skipProbe || resolved.probed), source: site, site,
                        ...trace,
                    }), 45000, trace);
                    if (r && r.ok) {
                        updatePlayState('已加载');
                        hideLoading();
                        return this._mpvSuccess(r, resolved.url, `解析成功（${resolved.via || ''}），已在 mpv 播放`);
                    }
                    if (r && r.launched) { this._seq = null; hideLoading(); this._mpvToast(r, ''); return r; }
                    if (r && !r.ok) {
                        hideLoading();
                        return this._mpvFailure(r, {
                            title, subtitle, url: resolved.url, header: mergedHeader,
                            prefix: '解析成功但 mpv 未能开始播放',
                        });
                    }
                } catch (e) { /* 播放异常走兜底 */ }
            }
            hideLoading();
            const note = (resolved && resolved.reason === 'no-parses') || (data.warning && data.warning.code === 'L4_PARSE_UNAVAILABLE')
                ? '当前配置未含解析接口：请在”设置 → 源设置”载入含 parses 的配置后重试'
                : `解析失败：${(resolved && resolved.reason) || '未知错误'}`;
            this._seq = null; // 本集未起播，连播链终止
            const fb = await this._tryFallbackRoute({ site, flag, id, title, subtitle, episodes, epIndex, kazumiSrc }, note, trace);
            if (fb && fb.ok) return fb;
            const dlgUrl = (resolved && resolved.ok && resolved.url) ? resolved.url : url;
            const dlgHeader = (resolved && resolved.ok)
                ? mergePlayHeaders(playHeader, resolved.header) : playHeader;
            this._showDialog(title, subtitle, '', dlgUrl, note, dlgHeader, {
                canRetry: true,
                rawDiagnostics: { site, flag, id, note, warning: data.warning,
                    requestId: trace.requestId },
            });
            return { ok: false, reason: note, url: dlgUrl, requestId: trace.requestId,
                playSessionId: trace.playSessionId };
        }

        // 直链源：单集交 mpv
        updatePlayState('验证媒体');
        try {
            updatePlayState('启动播放器');
            // playUrl 竞速兜底（同上：防主进程侧挂起导致 loading 永转）
            const r = await this._awaitTimeout(window.yuki.playUrl(url, {
                title, subtitle, flag, parse, header: playHeader,
                speed: carrySpeed, fullscreen: carryFullscreen,
                format: data.format, subs: data.subs, position: data.position,
                skipProbe: !!data.skipProbe, source: site, site,
                ...trace,
            }), 45000, trace);
            if (r && r.ok) {
                updatePlayState('已加载');
                hideLoading();
                return this._mpvSuccess(r, url, '已在 mpv 窗口播放');
            }
            if (r && r.launched) { this._seq = null; hideLoading(); this._mpvToast(r, ''); return r; }
            if (r && !r.ok) {
                hideLoading();
                return this._mpvFailure(r, { title, subtitle, url, header: playHeader });
            }
        } catch (e) { /* IPC 异常，走预览兜底 */ }
        hideLoading();
        this._seq = null;

        const fb = await this._tryFallbackRoute({ site, flag, id, title, subtitle, episodes, epIndex, kazumiSrc }, 'mpv 播放失败', trace);
        if (fb && fb.ok) return fb;

        // HTML5 预览兜底（m3u8/parse=1 不给内嵌地址，只留复制）
        const isHls = /\.m3u8(\?|$)/i.test(url);
        const note = parse === 1
            ? '该线路需要解析接口（parse=1）'
            : (isHls ? 'HLS(m3u8) 链接浏览器无法直播，建议安装 mpv 后重试' : '');
        this._showDialog(title, subtitle, (isHls || parse === 1) ? '' : url, url, note, playHeader, {
            canRetry: true,
            suggestMpv: isHls,
            rawDiagnostics: { site, flag, id, isHls, parse, requestId: trace.requestId },
        });
        return { ok: false, reason: 'mpv-play-failed', url, requestId: trace.requestId,
            playSessionId: trace.playSessionId };
    },

    /** U6.4 自动回退：当前线路失败时尝试同影片其他可用线路（受次数和总时间限制） */
    async _tryFallbackRoute(currentPlayback, reason, trace) {
        if (!currentPlayback || this._fallbackActive) return null;
        let s = {};
        try { s = (await window.yuki.settingsGet()) || {}; } catch (e) { /* default settings */ }
        // R8.1 功能开关 auto_line_fallback（支持 autoLineFallback / autoFallbackRoute）
        if (s.autoLineFallback === false || s.autoFallbackRoute === false) return null;

        const maxRetries = 2;
        if (!this._fallbackAttempts) this._fallbackAttempts = 0;
        if (this._fallbackAttempts >= maxRetries) {
            this._fallbackAttempts = 0;
            return null;
        }

        // 尝试从 Detail 获取当前影片的其他线路（支持 CatVod 线路与 Kazumi 规则源的备用线路）
        let sources = [];
        let curSourceIdx = -1;
        if (typeof Detail !== 'undefined' && Array.isArray(Detail.sources) && Detail.sources.length > 1) {
            sources = Detail.sources;
            curSourceIdx = Detail.activeSource;
        } else if (String(currentPlayback.site || '').startsWith('kazumi:') && Array.isArray(currentPlayback.episodes) && currentPlayback.episodes.length) {
            // Kazumi 源同规则同集备用
            sources = [{ from: currentPlayback.flag || '默认', episodes: currentPlayback.episodes }];
            curSourceIdx = 0;
        }
        if (!sources.length || sources.length <= 1) return null;

        const nextSourceIdx = (curSourceIdx + 1) % sources.length;
        if (nextSourceIdx === curSourceIdx) return null;

        const candidate = sources[nextSourceIdx];
        if (!candidate || !Array.isArray(candidate.episodes) || !candidate.episodes.length) return null;

        // 对齐同集（按序号 epIndex 匹配，不跨影片盲目匹配）
        const targetEpIndex = currentPlayback.epIndex || 0;
        const nextEp = candidate.episodes[targetEpIndex] || candidate.episodes[0];
        if (!nextEp) return null;

        this._fallbackAttempts += 1;
        this._fallbackActive = true;
        warnToast(`当前线路失败（${reason}），正在自动尝试备用线路「${candidate.from || '线路' + (nextSourceIdx + 1)}」…`);

        try {
            if (typeof Detail !== 'undefined') Detail.activeSource = nextSourceIdx;
            const res = await this.play(
                currentPlayback.site,
                candidate.from,
                nextEp.url || nextEp.id,
                currentPlayback.title,
                nextEp.name || currentPlayback.subtitle,
                candidate.episodes,
                targetEpIndex,
                currentPlayback.kazumiSrc
            );
            this._fallbackActive = false;
            if (res && (res.ok || res.launched)) {
                this._fallbackAttempts = 0;
                if (res.ok) warnToast(`已自动切换到备用线路「${candidate.from}」`);
                return res;
            }
        } catch (e) {
            this._fallbackActive = false;
        }
        return null;
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
            const rawFlags = state && state.flags;
            let flags;
            if (Array.isArray(rawFlags)) {
                flags = rawFlags;
            } else if (typeof rawFlags === 'string') {
                flags = rawFlags.split(',');
            } else {
                flags = [];
            }
            this._vipFlags = flags.filter((v) => v !== null && v !== undefined)
                .map((v) => {
                    if (typeof v === 'string') return v.trim();
                    if (typeof v === 'object') {
                        return String(v.name || v.key || v.flag || '').trim();
                    }
                    return String(v).trim();
                })
                .filter(Boolean);
            this._vipFlagsAt = now;
        } catch (e) {
            this._vipFlags = [];
            this._vipFlagsAt = now;
        }
        return this._vipFlags.slice();
    },

    /** 判断是否本机 go-proxy 网盘取流地址（127.0.0.1/localhost 的 /proxy，
     *  带 do=pan 取流参数或 url= 裸直链转发参数）。这类地址已由本地代理
     *  附上网盘凭据，是就绪的直连流。 */
    _isLocalGoProxyStreamUrl(url) {
        try {
            const u = new URL(String(url));
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
            const host = String(u.hostname).replace(/^\[|\]$/g, '');
            if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
            if (!/\/proxy$/.test(u.pathname)) return false;
            return u.searchParams.get('do') === 'pan' || u.searchParams.has('url');
        } catch (e) { /* 非法 URL 按非本地流处理 */ return false; }
    },

    /** 对齐 FongMi ParseJob.setParse 的 json:/parse:<name> 选择语义。 */
    async _resolvePlayerRoute(data, rawUrl, playback = {}) {
        if (!rawUrl) return { ok: false, reason: data.error || '播放地址为空' };
        // 本地 go-proxy 取流地址绝不进外部解析线路：解析站无法处理本地代理
        // 地址（必然失败），还会把分享 token/fileToken 泄露给第三方。
        if (this._isLocalGoProxyStreamUrl(rawUrl)) {
            return {
                ok: true,
                url: rawUrl,
                parse: 0,
                context: { site: playback.site || '', flag: String(data.flag || playback.flag || '') },
            };
        }
        const playUrl = String(data.playUrl || '').trim();
        const state = await getJson('/sites').catch(() => ({}));
        const parses = state && Array.isArray(state.parses) ? state.parses : [];
        const configFlags = state && Array.isArray(state.flags) ? state.flags.map(String) : [];
        const resultFlag = String(data.flag || playback.flag || '');
        const context = { site: playback.site || '', flag: resultFlag };
        if (/^json:/i.test(playUrl)) {
            const parserUrl = playUrl.slice(5).trim();
            if (!/^https?:\/\//i.test(parserUrl)) return { ok: false, reason: 'json 解析器地址无效' };
            return { ok: true, url: rawUrl, parse: 1, context,
                parsers: [{ url: parserUrl, type: 1, name: 'json' }] };
        }
        if (/^parse:/i.test(playUrl)) {
            const name = playUrl.slice(6).trim();
            const parser = parses.find((item) => {
                if (!item || typeof item !== 'object') return false;
                const names = [item.name, item.id, item.key, item.flag]
                    .filter((v) => v !== undefined && v !== null).map(String);
                return names.includes(name);
            });
            if (!parser || (!parser.url && parseInt(parser.type, 10) !== 4)) {
                return { ok: false, reason: `解析器不存在：${name}` };
            }
            return { ok: true, url: rawUrl, parse: 1,
                parsers: parseInt(parser.type, 10) === 4 ? parses : [parser],
                context: { ...context, parserName: name } };
        }
        const parseValue = parseInt(data.parse, 10);
        const jx = parseInt(data.jx, 10) === 1;
        const flagSelectsParser = !playUrl && !!resultFlag && configFlags.includes(resultFlag);
        if (playUrl) {
            return { ok: true, url: rawUrl, parse: 1, context,
                parsers: [{ name: 'playUrl', type: 0, url: playUrl,
                    header: data.header || {} }] };
        }
        return {
            ok: true,
            url: rawUrl,
            parse: (parseValue === 1 || jx || flagSelectsParser) ? 1 : 0,
            parsers: (parseValue === 1 || jx || flagSelectsParser) ? parses : undefined,
            context,
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
        const url = String(result.url || meta.url || '');
        const labels = {
            'mpv-missing': '未检测到 mpv，请在设置中安装或指定播放器',
            'mpv-spawn-failed': 'mpv 启动失败',
            'mpv-start-timeout': 'mpv 已启动，但在 30 秒内没有加载媒体',
            'mpv-exited-before-playback': 'mpv 已退出，媒体尚未开始播放',
            'mpv-exited': 'mpv 未能保持运行',
            'play-failed': '当前线路播放失败',
            'play-cancelled': '播放请求已被新的播放操作取消',
            'media-probe-html-response': '媒体地址返回了 HTML 页面，已拒绝交给播放器',
            'media-probe-login-page': '媒体地址跳转到登录页，已拒绝交给播放器',
            'media-probe-json-error': '媒体地址返回接口错误，已拒绝交给播放器',
            'media-probe-http-403': '媒体地址返回 403，Cookie 或签名可能已过期',
            'media-probe-not-media': '媒体地址不是可识别的音视频内容，已拒绝交给播放器',
            'media-probe-network-error': '媒体地址网络请求失败（连接被拒/DNS/代理异常）',
            'media-probe-expired-url': '媒体地址签名已过期',
            'media-probe-probe-timeout': '媒体地址探测超时',
            'media-probe-probe-cancelled': '媒体地址探测已取消',
        };
        let reason = String(result.reason || 'mpv-play-failed');
        // 起播失败后的补探测（主进程 postProbe）比 mpv 收尾日志更可操作：
        // 死链/风控页直接按探测原因给文案（如「媒体地址返回 HTTP 404」）
        if (result.postProbe) reason = `media-probe-${String(result.postProbe).split('/')[0]}`;
        let note = labels[reason];
        if (!note) {
            const httpMatch = /^media-probe-http-(\d{3})$/.exec(reason);
            note = httpMatch
                ? `媒体地址返回 HTTP ${httpMatch[1]}（链接可能已失效或被站点拦截）`
                : `mpv 播放失败：${reason}`;
        }
        const detail = String(result.error || '').replace(/\s+/g, ' ').trim();
        if (detail) note += `：${detail.slice(-240)}`;
        // 静默退出（无补探测、无日志可提取）：常见于旧版内置/自装 mpv 的行为差异，
        // 给出可操作的下一步而不是干巴巴的「mpv 已退出」
        if (reason === 'mpv-exited-before-playback' && !detail && !result.postProbe) {
            note += '（未捕获到具体原因：可在 设置 → 组件状态 更新内置播放器后重试，或换其它线路播放）';
        }
        if (meta.prefix && reason !== 'mpv-missing') note = `${meta.prefix}：${note}`;
        // 网盘本地取流失败按两类给可操作引导：Cookie 缺失/过期（上游 401/14001，
        // 未登录时后端快速失败）→ 扫码重登；已登录仍失败多为夸克侧直链被拒
        // （412 风控/权益异常或边缘故障，实测 API 正常但所有新签直链 412）→
        // 重新扫码刷新会话 + 稍后重试/换线路，不能笼统断言「未登录」。
        const panStreamFailed = this._isLocalGoProxyStreamUrl(url)
            && /(?:^|[?&])do=pan(?:&|$)/.test(String(url));
        if (panStreamFailed && reason !== 'play-cancelled') {
            note = note.includes('Cookie')
                ? note
                : `${note}（网盘资源常见原因：夸克 Cookie 缺失或过期——请在设置中重新扫码；若已登录仍失败，多为夸克侧直链被拒（风控），请重新扫码后再试或稍后换线路播放）`;
        }
        // 旧请求等待起播期间用户可能已经点了新剧集；旧请求返回取消时不能
        // 清掉新请求刚建立的连播上下文，也不能弹出旧地址的失败窗口。
        if (reason === 'play-cancelled') return { ...result, reason, url };
        this._seq = null;
        if (reason === 'mpv-missing' && !this._mpvMissingToastShown) {
            this._mpvMissingToastShown = true;
            warnToast('未检测到 mpv：执行 node scripts/download-binaries.js 安装后重启');
        }
        this._showDialog(meta.title, meta.subtitle, meta.previewUrl || '', url, note,
            meta.header || null, panStreamFailed ? { suggestCookie: true } : undefined);
        return { ...result, reason, url };
    },

    /** 起播成功提示；外部播放器模式 | 开启 Anime4K/边下边播时额外标注状态。 */
    _mpvToast(r, msg) {
        if (r && r.viaExternal) {
            warnToast(r.headerDropped
                ? '外部播放器不支持所需请求头，已降级启动但可能无法播放'
                : '已交外部播放器播放');
            return;
        }
        const extra = [];
        if (r && r.anime4k) extra.push(`Anime4K 超分已生效（${r.anime4kModeLabel || '均衡'}）`);
        if (r && r.simulDl) extra.push('已同步加入后台下载');
        warnToast(extra.length ? `${msg}（${extra.join('，')}）` : msg);
    },

    /**
     * Kazumi 源播放（kimi UI 设计，glm5.2 实现逻辑）：
     * 1. 调 /kazumi/action do=kazumiResolve 取播放页 URL 与规则 headers
     * 2. 调 window.yuki.captureDirect 抓真实视频流（隐藏 BrowserWindow 拦截 m3u8/mp4）
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
            const legacyEnabled = (await window.yuki.settingsGet().catch(() => ({})))?.legacyParser !== false;
            const legacy = legacyEnabled && !!data.useLegacyParser;
            // 步骤 2：captureDirect 抓真实流（主进程隐藏窗口；旧解析器规则走 iframe src 监听）
            try {
                const cap = await this._awaitTimeout(
                    window.yuki.captureDirect(pageUrl, legacy, trace), 15000, trace);
                if (cap && cap.ok) resolved = { url: cap.url, header: { ...header, ...(cap.header || {}) } };
            } catch (e) { /* 抓取异常 */ }
        } catch (e) { /* 解析异常 */ }
        hideLoading();
        if (resolved && resolved.ok !== false && resolved.url) {
            try {
                // playUrl 竞速兜底：此处 loading 已隐藏，但 IPC 挂死仍会让调用方
                // （详情页/连播推进）永久等待，统一 45s 上限。
                const r = await this._awaitTimeout(window.yuki.playUrl(resolved.url, {
                    title, subtitle, flag, header: resolved.header, speed: carrySpeed, fullscreen: carryFullscreen,
                    ...trace,
                }), 45000, trace);
                if (r && r.ok) return this._mpvSuccess(r, resolved.url, `Kazumi 源「${pluginName}」已在 mpv 播放`);
                if (r && r.launched) { this._seq = null; hideLoading(); this._mpvToast(r, ''); return r; }
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

    /** 直链直接交 mpv（parse=1 但地址已是媒体直链时的快路径）。
     *  入口处 updatePlayState 已 showLoading（「启动播放器」），因此每个出口——
     *  成功 / 外部播放器已接管(launched) / 失败 / 异常兜底弹窗——都必须 hideLoading，
     *  否则网盘类 parse=1 直链源会一直转圈（外部播放器模式下 launched 返回同样卡死）。 */
    async _playDirect(url, meta) {
        try {
            const r = await this._awaitTimeout(window.yuki.playUrl(url, meta), 45000,
                { requestId: meta.requestId || '', playSessionId: meta.playSessionId || '' });
            if (r && r.ok) {
                hideLoading();
                return this._mpvSuccess(r, url, '已在 mpv 窗口播放');
            }
            if (r && r.launched) {
                this._seq = null;
                hideLoading();
                this._mpvToast(r, '');
                return r;
            }
            if (r) {
                hideLoading();
                // 原生队列静默降级：失败弹窗交给回退后的逐集链路处理，避免双弹窗/空弹窗
                if (meta.quietFail) return { ok: false, ...r };
                return this._mpvFailure(r, { ...meta, url });
            }
            // playUrl IPC 超时（r 为 null）：主进程可能仍会稍后接管播放，
            // 这里按失败收尾并保证 loading 不悬挂。
        } catch (e) { /* IPC 异常 */ }
        hideLoading();
        this._seq = null;
        this._showDialog(meta.title, meta.subtitle, '', url,
            '播放器启动超时或异常，请重试或更换线路', meta.header || null);
        return { ok: false, reason: 'mpv-play-failed', url,
            requestId: meta.requestId || '', playSessionId: meta.playSessionId || '' };
    },

    _close() {
        const v = document.getElementById('player-video');
        if (v) { try { v.pause(); } catch (e) { /* ignore */ } v.removeAttribute('src'); v.load(); }
        closeDialog('playerDialog');
    },

    _showDialog(title, subtitle, previewUrl, copyUrl, note, header, failureDetails = null) {
        $('#player-title').text((title || '播放') + (subtitle ? ' · ' + subtitle : ''));
        $('#player-note').text(note || '');
        $('#player-note').toggle(!!note);
        $('#player-url').text(copyUrl || '');
        $('#player-preview').toggle(!!previewUrl);
        // 外部播放器出口：仅在有可播地址时可用；记录该地址与解析出的 Referer/UA 头供起播用
        $('#player-external').toggle(!!copyUrl);
        this._extUrl = copyUrl || '';
        this._extHeader = (header && typeof header === 'object') ? header : null;
        this._lastFailureDetails = failureDetails;

        let extraActions = $('#player-failure-actions');
        if (!extraActions.length) {
            $('#playerDialog .md-dialog-body').append('<div id="player-failure-actions" style="margin-top:12px;display:none;flex-direction:column;gap:8px;"></div>');
            extraActions = $('#player-failure-actions');
        }
        if (failureDetails) {
            extraActions.empty().show();
            const actionRow = $('<div style="display:flex;gap:8px;flex-wrap:wrap;"></div>').appendTo(extraActions);
            if (failureDetails.canRetry) {
                $('<button class="md-btn md-btn-sm md-btn-tonal">重试当前线路</button>').on('click', () => {
                    this._close();
                    if (this._currentPlayback) {
                        const p = this._currentPlayback;
                        this.play(p.site, p.flag, p.id, p.title, p.subtitle, p.episodes, p.epIndex, p.kazumiSrc);
                    }
                }).appendTo(actionRow);
            }
            if (failureDetails.suggestCookie) {
                $('<button class="md-btn md-btn-sm md-btn-tonal">配置网盘 Cookie</button>').on('click', () => {
                    this._close();
                    if (typeof openSettingsPanel === 'function') openSettingsPanel('pan');
                }).appendTo(actionRow);
            }
            if (failureDetails.suggestMpv) {
                $('<button class="md-btn md-btn-sm md-btn-tonal">安装/指定 mpv</button>').on('click', () => {
                    this._close();
                    if (typeof openSettingsPanel === 'function') openSettingsPanel('player');
                }).appendTo(actionRow);
            }
            if (failureDetails.rawDiagnostics) {
                $('<button class="md-btn md-btn-sm md-btn-tonal">复制技术诊断详情</button>').on('click', () => {
                    const sanitized = JSON.stringify(failureDetails.rawDiagnostics, null, 2);
                    navigator.clipboard.writeText(sanitized);
                    warnToast('已复制脱敏技术详情');
                }).appendTo(actionRow);
            }
        } else {
            extraActions.hide();
        }

        const v = document.getElementById('player-video');
        if (v) {
            v.removeAttribute('src');
            $('#player-video').hide();
        }
        openDialog('playerDialog');
    },

    /** 把当前弹窗地址交外部播放器（VLC/PotPlayer/mpv/系统默认）。带解析出的 Referer/UA 头，
     *  header 无法随播放器命令行传递时（PotPlayer/系统默认）给出降级告警。 */
    async _openExternal() {
        const url = this._extUrl || $('#player-url').text();
        if (!url) { warnToast('没有可播放的地址'); return; }
        let r;
        try {
            r = await window.yuki.externalPlayer(url, { header: this._extHeader || undefined });
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
    root.YUKI = root.YUKI || {};
    root.YUKI.player = Player;
}(typeof window !== 'undefined' ? window : globalThis));
