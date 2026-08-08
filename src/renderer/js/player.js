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
/* global $, doAction, warnToast, showLoading, hideLoading, openDialog, closeDialog, Kazumi */

// 媒体直链后缀：已是直链则无需解析（share/播放页等才需解析）
const DIRECT_MEDIA_RE = /\.(m3u8|mp4|flv|mov|mkv|webm|ts)(\?|#|$)/i;

const Player = {
    _mpvMissingToastShown: false,
    _seq: null,      // 连播上下文 {site, flag, title, episodes, index}（mpv 退出后推进）
    _endedAt: 0,     // 最近一次 ended（单集播完）时间戳，退出进度取不到时作「看完」兜底判据
    _playToken: 0,   // 起播令牌：exit 处理期间又发起新播放则放弃推进（防旧进程延迟退出误连播）
    _session: 0,     // 当前起播会话号（主进程 playUrl 返回；exit 事件据此匹配归属）
    _lastUrl: '',    // 最近一次交给 mpv 的地址（断流重连条件需媒体直链判定）
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
        // mpv 事件：ended 记录「播完」时间戳；exit 附退出进度，驱动连播推进；
        // session 事件：断流重连后同步新会话号，重连集播完仍可继续连播
        if (window.vpc && window.vpc.onPlayerEnded) {
            window.vpc.onPlayerEnded((info) => this._onEnded(info));
            window.vpc.onPlayerExit((info) => this._onExit(info));
            if (window.vpc.onPlayerSession) {
                window.vpc.onPlayerSession((info) => {
                    if (info && typeof info.sessionId === 'number') this._session = info.sessionId;
                });
            }
        }
    },

    /** 单集播完（end-file eof）：记时间戳；mpv 单集模式下随后即退出进程。 */
    _onEnded() {
        this._endedAt = Date.now();
    },

    /**
     * mpv 进程退出：连播核心驱动点。
     * 「看完」判定：退出时剩余时长 <8s；进度取不到（IPC 已断）时，
     * 10s 内收到过 ended 事件同样视为看完。提前关闭 → 终止连播链。
     */
    async _onExit(info) {
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
        let done;
        if (info && typeof info.pos === 'number' && typeof info.duration === 'number' && info.duration > 0) {
            done = (info.duration - info.pos) < 8;
        } else {
            done = (Date.now() - this._endedAt) < 10000;
        }
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
        this.play(seq.site, seq.flag, next.url, seq.title, next.name, seq.episodes, seq.index + 1);
    },

    /**
     * @param site   站点 key
     * @param flag   线路名
     * @param id     集地址（播放前原始值）
     * @param title  视频名（弹窗标题用）
     * @param subtitle 集名
     * @param episodes 当前线路全部集 [{name,url}]（连播队列用）
     * @param epIndex  当前集在 episodes 中的下标
     * @returns {ok: boolean, reason?: string} 起播结果
     */
    async play(site, flag, id, title, subtitle, episodes, epIndex) {
        // 新起播占令牌：任何在途的旧进程 exit 处理随后发现令牌变化即放弃连播推进
        this._playToken += 1;
        // 连播延续的倍速/全屏（仅连播自动推进时非空，手动起播为 null）
        const carrySpeed = this._carrySpeed;
        const carryFullscreen = this._carryFullscreen;
        this._carrySpeed = null;
        this._carryFullscreen = null;
        // 连播开关 + 上下文：从当前集起按序排队，mpv 退出后由 _onExit 推进
        let autoNext = true;
        try { autoNext = ((await window.vpc.settingsGet()) || {}).autoNext !== false; } catch (e) { /* 读设置失败默认连播 */ }
        this._seq = (autoNext && Array.isArray(episodes) && (epIndex || 0) + 1 < episodes.length)
            ? { site, flag, title, episodes, index: epIndex || 0 }
            : null;

        // Kazumi 源分支（kimi UI）：site 为 kazumi:规则名 时走规则引擎解析
        if (String(site).startsWith('kazumi:')) {
            return await this._playKazumi(site, flag, id, title, subtitle, episodes, epIndex, carrySpeed, carryFullscreen);
        }

        showLoading();
        let rsp;
        try {
            rsp = await doAction('playerContent', {
                site, flag, id, vipFlags: JSON.stringify([]),
            });
        } catch (e) {
            hideLoading();
            this._seq = null;
            warnToast('取播放地址失败');
            return { ok: false, reason: '取播放地址失败' };
        }
        hideLoading();
        const data = (rsp && typeof rsp === 'object') ? rsp : {};
        const url = data.url || id;
        const parse = parseInt(data.parse, 10) || 0;

        // parse=1：后台自动解析出直链并起播（单集；下一集由 _onExit 连播推进）
        if (parse === 1) {
            // 已是媒体直链则无需解析（部分源 parse 标记不准）
            if (DIRECT_MEDIA_RE.test(url.split('?')[0])) {
                return await this._playDirect(url, { title, subtitle, flag, speed: carrySpeed, fullscreen: carryFullscreen });
            }
            showLoading();
            warnToast('正在后台解析播放地址…');
            let resolved = null;
            try { resolved = await window.vpc.resolveParse(url); } catch (e) { /* 解析异常 */ }
            // parses 接口缺失或全部失败：隐藏窗口直开链接抓页面自身播放器的媒体请求
            if (!(resolved && resolved.ok)) {
                try {
                    const cap = await window.vpc.captureDirect(url);
                    if (cap && cap.ok) resolved = cap;
                } catch (e) { /* 抓取异常 */ }
            }
            hideLoading();
            if (resolved && resolved.ok) {
                try {
                    const r = await window.vpc.playUrl(resolved.url, {
                        title, subtitle, flag, header: resolved.header, speed: carrySpeed, fullscreen: carryFullscreen,
                    });
                    if (r && r.ok) { this._session = r.sessionId || 0; this._lastUrl = resolved.url; this._mpvToast(r, `解析成功（${resolved.via || ''}），已在 mpv 播放`); return { ok: true }; }
                    if (r && r.reason === 'mpv-missing') { warnToast('解析成功但未安装 mpv，无法播放直链'); return { ok: false, reason: 'mpv-missing' }; }
                } catch (e) { /* 播放异常走兜底 */ }
            }
            const note = resolved && resolved.reason === 'no-parses'
                ? '当前配置未含解析接口：请在”设置 → 源设置”载入含 parses 的配置后重试'
                : `解析失败：${(resolved && resolved.reason) || '未知错误'}`;
            this._seq = null; // 本集未起播，连播链终止
            this._showDialog(title, subtitle, '', url, note);
            return { ok: false, reason: note };
        }

        // 直链源：单集交 mpv（连播由渲染层在 mpv 退出后推进，不再依赖 mpv 队列）
        try {
            const r = await window.vpc.playUrl(url, { title, subtitle, flag, parse, speed: carrySpeed, fullscreen: carryFullscreen });
            if (r && r.ok) { this._session = r.sessionId || 0; this._lastUrl = url; this._mpvToast(r, '已在 mpv 窗口播放'); return { ok: true }; }
            if (r && r.reason === 'mpv-missing' && !this._mpvMissingToastShown) {
                this._mpvMissingToastShown = true;
                warnToast('未检测到 mpv：执行 node scripts/download-binaries.js 安装后重启');
            }
        } catch (e) { /* IPC 异常，走预览兜底 */ }
        this._seq = null;

        // HTML5 预览兜底（m3u8/parse=1 不给内嵌地址，只留复制）
        const isHls = /\.m3u8(\?|$)/i.test(url);
        const note = parse === 1
            ? '该线路需要解析接口（parse=1）'
            : (isHls ? 'HLS(m3u8) 链接浏览器无法直播，建议安装 mpv 后重试' : '');
        this._showDialog(title, subtitle, (isHls || parse === 1) ? '' : url, url, note);
        return { ok: false, reason: 'mpv-missing' };
    },

    /** mpv 起播成功提示；开启 Anime4K/边下边播时额外标注状态（便于确认开关生效）。 */
    _mpvToast(r, msg) {
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
    async _playKazumi(site, flag, id, title, subtitle, episodes, epIndex, carrySpeed, carryFullscreen) {
        const pluginName = String(site).slice(7); // 去掉 kazumi: 前缀
        if (!pluginName) { this._seq = null; return { ok: false, reason: '规则名为空' }; }
        showLoading();
        warnToast('正在解析 Kazumi 源播放地址…');
        let resolved = null;
        try {
            // 步骤 1：取播放页与规则 headers（glm5.2 后端端点）
            const rsp = await doAction('kazumiResolve', { pluginName, url: id }, '/kazumi/action');
            const data = (rsp && typeof rsp === 'object') ? rsp : {};
            const pageUrl = data.pageUrl || id;
            const header = {};
            if (data.userAgent) header['User-Agent'] = data.userAgent;
            if (data.referer) header['Referer'] = data.referer;
            // 步骤 2：captureDirect 抓真实流（主进程隐藏窗口）
            try {
                const cap = await window.vpc.captureDirect(pageUrl);
                if (cap && cap.ok) resolved = { url: cap.url, header: { ...header, ...(cap.header || {}) } };
            } catch (e) { /* 抓取异常 */ }
        } catch (e) { /* 解析异常 */ }
        hideLoading();
        if (resolved && resolved.ok !== false && resolved.url) {
            try {
                const r = await window.vpc.playUrl(resolved.url, {
                    title, subtitle, flag, header: resolved.header, speed: carrySpeed, fullscreen: carryFullscreen,
                });
                if (r && r.ok) { this._session = r.sessionId || 0; this._lastUrl = resolved.url; this._mpvToast(r, `Kazumi 源「${pluginName}」已在 mpv 播放`); return { ok: true }; }
                if (r && r.reason === 'mpv-missing') { warnToast('解析成功但未安装 mpv，无法播放直链'); return { ok: false, reason: 'mpv-missing' }; }
            } catch (e) { /* 播放异常走兜底 */ }
        }
        this._seq = null; // 本集未起播，连播链终止
        const note = resolved && resolved.reason ? `Kazumi 源解析失败：${resolved.reason}` : 'Kazumi 源未解析到可播放地址';
        this._showDialog(title, subtitle, '', id, note);
        return { ok: false, reason: note };
    },

    /** 直链直接交 mpv（parse=1 但地址已是媒体直链时的快路径）。 */
    async _playDirect(url, meta) {
        try {
            const r = await window.vpc.playUrl(url, meta);
            if (r && r.ok) { this._session = r.sessionId || 0; this._lastUrl = url; this._mpvToast(r, '已在 mpv 窗口播放'); return { ok: true }; }
            if (r && r.reason === 'mpv-missing') warnToast('未检测到 mpv：执行 node scripts/download-binaries.js 安装后重启');
        } catch (e) { /* IPC 异常 */ }
        this._showDialog(meta.title, meta.subtitle, '', url, '');
        return { ok: false, reason: 'mpv-missing' };
    },

    _close() {
        const v = document.getElementById('player-video');
        if (v) { try { v.pause(); } catch (e) { /* ignore */ } v.removeAttribute('src'); v.load(); }
        closeDialog('playerDialog');
    },

    _showDialog(title, subtitle, previewUrl, copyUrl, note) {
        $('#player-title').text((title || '播放') + (subtitle ? ' · ' + subtitle : ''));
        $('#player-note').text(note || '');
        $('#player-note').toggle(!!note);
        $('#player-url').text(copyUrl || '');
        $('#player-preview').toggle(!!previewUrl);
        const v = document.getElementById('player-video');
        v.removeAttribute('src');
        $('#player-video').hide();
        openDialog('playerDialog');
    },
};
