/**
 * home.js — 首页（Phase 2）
 *
 * 数据链路：GET /sites 取站点列表 → doAction('homeContent', {site}) 取
 * 分类(class)与推荐位(list) → 点分类走 categoryContent 分页。
 * 卡片点击交给 Detail.open()。
 */
/* global $, doAction, getJson, escHtml, normalizePic, warnToast, showLoading, hideLoading, Detail, renderPagerBox, pageSizeOf, fillMissingCovers, fitVodTitles, renderStatusBar, localCacheGet, localCacheSet, errorTextOf */

// T60：分类空态探测结果新鲜期（该源上次探测完成后在此窗口内不再重复探测，防每次启动全量重探）
const EMPTY_CLS_TTL = 24 * 3600 * 1000;
// 屏蔽源探测的分类确认参数：推荐位为空时逐个分类拉第 1 页确认是否有内容
const PROBE_CAT_CONCURRENCY = 4; // 单源分类探测并发
const PROBE_CAT_LIMIT = 24;      // 单源最多检查的分类数（异常源护栏）
const PROBE_CAT_TIMEOUT = 20000; // 分类探测单请求超时：短于源级 60s，控制最坏耗时
// 源级探测的失败容忍与复查节奏：
// 「证据不足」（失败包络/超时/内嵌 error，以及首轮确认的空结果）不下结论，但每轮
// 探测含一次 3s 后的二次确认；连续 PROBE_FAIL_LIMIT 轮（共 2×N 次尝试）都拿不到
// 任何响应的是死源、都确认全空的是无内容源——不设此阈值它们会永远留在列表里
// （每次启动重探、每次失败、永不屏蔽）。连败计数只在当前会话内累加（init 清跨会话
// 欠账），死源/空源收敛由同会话补探第二轮保证。
// 已得出结论的源按 PROBE_RECHECK_TTL 复查：内容失效自动补屏蔽，被屏蔽源恢复
// 内容自动解除（僵尸源复活）。
const PROBE_FAIL_LIMIT = 2;                      // 连续 N 轮（各含二次确认）无响应 → 按死源屏蔽
const PROBE_RETRY_DELAY = 3000;                  // 轮内对失败源的二次确认间隔（滤掉瞬时抖动）
const PROBE_ROUND2_DELAY = 30000;                // 一轮结束后仍有证据不足源时的补探间隔（会话内自终止）
const PROBE_RECHECK_TTL = 7 * 24 * 3600 * 1000;  // 已结论源的复查周期
// 后台全量轮的节奏：死源（死镜像 jar/ext）单次尝试就能挂满整个 deadline，如果
// 并发低、超时长，一轮要跑十来分钟才能轮到列表后面的源——用户只能手动切源触发
// 探测，体验差。提速组合：并发 8 + 分级超时（首轮 20s 快速分类，二次确认 45s
// 给慢源一次长机会）。绝大多数源 <5s 出结果；真需要 >45s 才响应的源连续两轮
// 4 次尝试全部超时才会按死源屏蔽，且复查期会自动复活，误杀面很小。
const PROBE_SITE_CONCURRENCY = 8;   // 源级探测并发
const PROBE_FAST_TIMEOUT = 20000;   // 首轮探测 deadline（快速分类）
const PROBE_SLOW_TIMEOUT = 45000;   // 轮内二次确认 deadline（慢源长机会）
// 配置就绪后探测轮的延迟启动：站点列表/首页 feed 刚上屏就拉起 8 并发探测，
// 会与首屏内容请求抢后端、探测进度条也压在用户正看的页面上。先让首屏
// 稳定几秒再后台开跑；手动切源触发的探测不受此延迟（要即时反馈）。
const PROBE_START_DELAY = 8000;
// 站点列表 / 首页分类(class) 本地缓存：冷启动先用缓存即时渲染源下拉与分类标签，后台再拉网络刷新。
// 站点列表只在配置载入时才变，且每次启动 /sites 都会重拉并覆盖缓存（缓存只提前
// 呈现骨架），所以 TTL 给到 7 天——隔天/隔周重启也能秒开真实站点列表，而不是
// 先闪一段内置示例源。分类结构基本稳定，同样给长 TTL。
const SITES_CACHE_KEY = 'home::sites::v1';
const SITES_CACHE_TTL = 7 * 24 * 3600 * 1000;      // 站点列表 7 天
const HOME_CLASS_CACHE_PREFIX = 'home::class::v1::'; // + site → 该源分类标签列表
const HOME_CLASS_CACHE_TTL = 24 * 3600 * 1000;       // 首页分类 24 小时
/** 内置示例源（后端 load_default_sites 的兜底站点 key）：它出现在 /sites 里说明
 *  当前没有可用配置（恢复/导入未完成），不是用户内容——不缓存、不预渲染。 */
function isDemoOnlySites(list) {
    return Array.isArray(list) && list.length > 0 && list.every((s) => s && s.key === 'demo');
}
// 首页「全部」feed 持久化缓存：冷启动网络返回前先以旧内容上屏（TTL 2 小时；
// 网络返回后以最新覆盖，TTL 只决定「多久以内的旧内容可用于即时上屏」）
const HOME_FEED_CACHE_PREFIX = 'home::feed::v1::';   // + site → { ts, pagecount, items[] }
const HOME_FEED_CACHE_TTL = 2 * 60 * 60 * 1000;

/**
 * doAction 失败响应识别：后端 spider 出错/超时/风控时返回 RuntimeResponse
 * 失败包络 {ok:false, error:{code,...}}（HTTP 非 2xx，但 fetch 对非 2xx 不抛
 * 异常，doAction 原样返回解析结果）；响应体非 JSON 时返回原始字符串。
 * 这些一律不能作为「无内容」的证据——否则慢源（后端 homeContent 默认 15s
 * deadline 先于渲染层超时掐断）、瞬时故障源会被误判成僵尸源而屏蔽。
 */
function actionResponseFailed(d) {
    if (!d || typeof d !== 'object') return true; // 原始文本 / 空响应
    if (d.ok === false) return true;              // 失败包络
    return !!d.error;                             // 兜底：任何内嵌 error 字段
}

/**
 * 探测结论的内容指纹：多仓合并下不同仓常用同名 site key 指向不同站点
 * （api/spider 不同）。探测/屏蔽持久化记录（probeFp）按 key 附带该指纹，
 * 读取时指纹不一致即作废旧结论——否则旧仓的「屏蔽」会继续隐藏合并后
 * 同 key 的可用源，旧的「已探过」也会让新内容漏探。
 */
function siteProbeFp(s) {
    return [(s && s.api) ? String(s.api) : '', (s && s.spiderType) ? String(s.spiderType) : ''].join('|');
}

const Home = {
    sites: [],
    _allSites: [],     // 未过滤的全量站点（探测用）
    site: '',
    classes: [],
    tid: '',
    page: 1,
    pagecount: 1,
    mode: 'home',        // 'home' | 'category'
    _inited: false,
    _probing: false,
    // 首页自适应填充状态：推荐位为基底，逐页拉首个分类去重追加
    _homeList: [],
    _fillTid: '',
    _fillPg: 0,
    _fillSeen: {},
    // 分类/搜索模式：一页一次请求的标准分页（T6），页级 LRU 缓存 + 命中后台静默刷新
    _catItems: [],
    searchWord: '',
    _pageCache: null,   // 懒初始化 Map：key site|tid → { pagecount, pages: Map<pg, list> }
    _catWin: new Map(), // 分类源页合并窗口：key site|tid → { items, seen, sourcePg, total, perPage }（T75 多源页合并填满每页条数）
    _homeCacheBooted: false, // 首页 feed 持久化缓存只引导一次（网络返回后以最新覆盖）
    _feedCacheBooted: false, // 本次 loadHome 是否已用持久化 feed 缓存即时上屏（上屏后提前撤全局遮罩）
    _pageSizeDirty: false, // 每页条数在设置里被改过：回到首页视图时按新条数自动重载（T80）
    _loadToken: 0, // 加载令牌：切源/切分类后旧拉取自动作废
    _sitesLoadToken: 0, // 配置刷新令牌：旧的站点列表请求不得覆盖新配置
    _probeToken: 0, // 探测世代：源集合变更（配置重载）后旧探测结果作废
    _emptyCls: {},   // T60：site → Set<空分类 type_id>（探测确认无影片的分类，持久化）
    _clsProbed: {},  // T60：site → 本会话完整探测是否已完成（同源只探一次）
    _okCls: {},      // T60：site → Set<tid> 已确认有内容的分类（持久化；重试跳过）
    _clsBusy: {},    // T60：site → 探测在途（防并发重复探测）
    _clsStarted: {}, // T60：site → 已发起首次探测（或从持久化载入且数据新鲜），之后只探未知分类
    _clsTs: {},      // T60：site → 上次完整探测完成的时间戳（EMPTY_CLS_TTL 内不重复探测）
    _probingAll: false, // T60：全源后台探测是否在途（防并发重复扫描）
    _probeBar: null,    // T81：首页探测进度条 { total, done, active, shown, showTimer, doneTimer }
    _autoProbeEnabled: true, // 源自动检测开关；兼容旧配置默认开启
    _probeRetryDelayMs: PROBE_RETRY_DELAY, // 轮内二次确认间隔（测试可注入 0）
    _probeRound2DelayMs: PROBE_ROUND2_DELAY, // 同会话补探第二轮间隔（测试可注入 0）
    _probeStartDelayMs: PROBE_START_DELAY, // 配置就绪后探测轮的延迟启动（测试可注入 0）
    _probeStartTimer: null, // 延迟探测定时器（新一轮 loadSites 重排）
    _probeRound2Timer: null, // 证据不足源补测定时器（PROBE_ROUND2_DELAY 后自终止一轮）
    _probeRound2Keys: [],   // 待补测源 key（调度时合并去重，触发时取走清空）
    _configPending: false,  // 配置恢复/导入进行中（后端还没有站点）：刷新/搜索/分类请求必然落空
    _userRefresh: false,    // 本次 loadHome 由刷新按钮触发（失败保留内容时给用户反馈）

    async init() {
        if (this._inited) return;
        this._inited = true;
        $('#site-select').on('change', () => {
            this._cacheDropSite(this.site); // 切源时清理旧源的页缓存
            this.site = $('#site-select').val();
            this.loadHome();
            // 用户主动切到某源 = 对它投了注意力：立即探测该源（仅未出结论/已过复查期的）。
            // 死源/空源在用户翻看的当下就推进连败计数，不必等下次启动的整轮扫描。
            if (this._autoProbeEnabled) this._probeSites(this.site);
        });
        // 窗口拉伸放大：卡片数不够铺满时自动补拉（防抖）
        $(window).on('resize', () => {
            clearTimeout(this._resizeT);
            this._resizeT = setTimeout(() => this._onResize(), 400);
        });
        $('#home-refresh').on('click', () => {
            const busy = this._configBusyText();
            if (busy) { warnToast(busy); return; } // 恢复窗口期：请求必然落空，直接提示
            if (this.mode === 'home') this.loadHome(this.page || 1, { userRefresh: true });
            else if (this.mode === 'search') this.searchCurrent(this.page);
            else this.loadCategory(this.tid, this.page, true); // 刷新绕过缓存重拉当前页
        });
        // 当前源搜索：回车触发；清空后回车回首页
        $('#home-search').on('keydown', (e) => {
            if (e.key === 'Enter') this.searchCurrent();
        });
        $('#home-class').on('click', '.class-tab', (e) => {
            const tid = String($(e.currentTarget).data('tid'));
            $('#home-class .class-tab').removeClass('active');
            $(e.currentTarget).addClass('active');
            if (tid === '') { this.loadHome(); } else { this.loadCategory(tid, 1); }
        });
        $('#home-grid').on('click', '.vod-card', (e) => {
            const el = $(e.currentTarget);
            Detail.open(this.site, el.data('id'), el.data('name'));
        });
        this._loadPersistedEmptyClasses(); // T60：载入持久化空分类结果，首屏即隐藏空分类（无闪现）
        await this._resetSessionEvidence(); // 连败计数只算本会话：清掉上次会话遗留的欠账
        // 预渲染前先取屏蔽列表：缓存列表是 /sites 原始输出，含已屏蔽源——不过滤
        // 会把屏蔽源重新放进下拉并自动选中（曾因此把已屏蔽的空源选为当前源，
        // 启动即对它发请求，后端恢复窗口期全是 L2_SITE_NOT_FOUND）。
        // 屏蔽记录按内容指纹校验后生效（_validBlocked）：合并/换主导致同名 key
        // 指向不同站点时，旧屏蔽不得隐藏新源。
        const bootSettings = await this._getSourceSettings();
        const blocked = await this._getBlocked(bootSettings);
        this._prerenderFromCache(blocked, bootSettings); // 冷启动即时上屏：网络返回前先用缓存渲染源下拉 + 分类标签
        await this.loadSites();
    },

    /** 冷启动即时上屏：用本地缓存的站点列表 + 当前源分类标签预渲染，避免等 /sites & homeContent 网络。
     *  仅在尚无数据时填充；loadSites/loadHome 网络返回后会以最新结果覆盖（缓存只提前呈现骨架）。
     *  过滤规则与 loadSites 一致（屏蔽源/Android/不展示），demo-only 缓存（历史坏会话把
     *  内置示例源当站点列表写进去过）不算数。blocked 为屏蔽源 key 列表。 */
    _prerenderFromCache(blocked, settings) {
        if (typeof localCacheGet !== 'function') return;
        try {
            const sites = localCacheGet(SITES_CACHE_KEY);
            if (!Array.isArray(sites) || !sites.length || isDemoOnlySites(sites) || this._allSites.length) return;
            const hiddenSet = new Set(this._validBlocked(sites, blocked, settings));
            const visible = sites.filter((s) => {
                if (hiddenSet.has(s.key)) return false;
                const isAndroid = s.runtime === 'android' || (s.lastError && s.lastError.code === 'L2_SITE_REQUIRES_ANDROID');
                if (isAndroid) return false;
                if (s.state === 'unsupported' || s.runtime === 'unsupported') return false;
                return true;
            });
            if (!visible.length) return; // 全部被屏蔽/隐藏：不预渲染，等网络刷新给引导态
            this._allSites = sites;      // 探测用全量（与 loadSites 的 _allSites 语义一致）
            this.sites = visible;
            if (!this.site || !this.sites.some((s) => s.key === this.site)) this.site = this.sites[0].key;
            this._renderSiteSelect();
            $('#site-select').val(this.site);
            const cls = this._loadClassCache(this.site);
            if (Array.isArray(cls) && cls.length) { this.classes = cls; this.renderClass(''); }
        } catch (e) { /* 预渲染失败不影响正常网络加载 */ }
    },

    /** 本地是否有可即时上屏的站点列表缓存（app.js 启动时据此决定是否阻塞等配置重载）。 */
    hasSiteCache() {
        if (typeof localCacheGet !== 'function') return false;
        try {
            const sites = localCacheGet(SITES_CACHE_KEY);
            return Array.isArray(sites) && sites.length > 0 && !isDemoOnlySites(sites);
        } catch (e) { return false; }
    },

    /** 读取某源缓存的分类标签列表（未命中/过期返回 null）。 */
    _loadClassCache(site) {
        if (typeof localCacheGet !== 'function' || !site) return null;
        try {
            const cls = localCacheGet(HOME_CLASS_CACHE_PREFIX + site);
            return Array.isArray(cls) ? cls : null;
        } catch (e) { return null; }
    },

    /** 写入某源分类标签缓存（空列表不缓存，避免异常源污染下次预渲染）。 */
    _saveClassCache(site, classes) {
        if (typeof localCacheSet !== 'function' || !site || !Array.isArray(classes) || !classes.length) return;
        try { localCacheSet(HOME_CLASS_CACHE_PREFIX + site, classes, HOME_CLASS_CACHE_TTL); } catch (e) { /* 缓存失败忽略 */ }
    },

    async loadSites() {
        const sitesLoadToken = ++this._sitesLoadToken;
        const isCurrentSitesLoad = () => sitesLoadToken === this._sitesLoadToken;
        // 配置切换时让正在进行的旧首页请求立即失效，避免旧内容回写。
        this._loadToken++;
        // 先读取开关，再拉取源列表：即使 /sites 瞬时失败，也要保证关闭自动检测时
        // 不会继续使用历史 blockedSites 过滤源。
        const settings = await this._getSourceSettings();
        if (!isCurrentSitesLoad()) return;
        this.setAutoProbeEnabled(settings.sourceAutoDetect !== false);
        // 换仓（配置源 URL 变化）→ 重置探测/屏蔽状态。探测/屏蔽/空分类记录全部按源
        // key 复用，而不同仓常存在同名 key——旧仓的结论会张冠李戴地套在新仓同名源上
        // （已屏蔽的误隐藏、已「探过」的漏探），表现为换仓后无法屏蔽无影视的源。以
        // lastConfigUrl 为仓标识持久化 probeSourceUrl：不一致即清空按 key 的持久化
        // 记录与内存镜像（含 localStorage 空分类缓存），新仓所有源从零全量探测；
        // 同仓重启则原样保留（多仓漂移仍由下方 key 集签名处理）。边界：粘贴 JSON
        // 配置不更新 lastConfigUrl，此场景不做重置（仅识别 URL 换仓）。
        const cfgUrl = typeof settings.lastConfigUrl === 'string' ? settings.lastConfigUrl : '';
        const probedUrl = typeof settings.probeSourceUrl === 'string' ? settings.probeSourceUrl : '';
        if (probedUrl !== cfgUrl) {
            this._probeToken++; // 在途旧探测写入前校验世代，结果丢弃
            clearTimeout(this._probeStartTimer);
            this._probeStartTimer = null;
            this._cancelProbeRound2(); // 补测轮随换仓作废
            this._probing = false;     // 释放锁，允许对新仓重新发起探测
            this._probingAll = false;
            this._clsProbed = {};
            this._clsBusy = {};
            try {
                await window.yuki.settingsSet('probeSourceUrl', cfgUrl);
                await window.yuki.settingsSet('blockedSites', []);
                await window.yuki.settingsSet('blockedReason', {});
                await window.yuki.settingsSet('probedSites', []);
                await window.yuki.settingsSet('probedAt', {});
                await window.yuki.settingsSet('probeFailStreak', {});
                await window.yuki.settingsSet('probeFp', {});
            } catch (e) { /* 持久化失败不影响本次展示过滤 */ }
            // 空分类结果同样按 site key 复用：清内存镜像 + localStorage，新仓重新探测分类
            this._emptyCls = {};
            this._okCls = {};
            this._clsTs = {};
            this._clsStarted = {};
            this._clearPersistedEmptyClasses();
            settings.blockedSites = []; // 本次 loadSites 后续的屏蔽过滤直接用清空后的列表
        }
        // T77：配置/源集合变更 → 作废分类内容缓存（页缓存 + 合并窗口），回到页面立即生效
        this.invalidatePageCaches();
        let all = [];
        try {
            const st = await getJson('/sites');
            all = (st && st.sites) || [];
        } catch (e) { all = []; }
        if (!isCurrentSitesLoad()) return;
        // 网络成功且非空时刷新站点列表缓存（空结果不覆盖，防后端瞬时异常清掉可用缓存；
        // demo-only 也不覆盖/写入——那是恢复/导入未完成时的内置兜底，不是用户内容，
        // 缓存它会让下次启动预渲染出「示例源」）
        if (all.length && !isDemoOnlySites(all) && typeof localCacheSet === 'function') {
            try { localCacheSet(SITES_CACHE_KEY, all, SITES_CACHE_TTL); } catch (e) { /* 缓存失败忽略 */ }
        }
        // 网络失败（all 空）时：若已有缓存预渲染的站点，保留其展示，不重置探测/屏蔽、不清空页面
        // （否则冷启动预渲染 + 瞬时网络异常会误清 blockedSites 并显示「尚未载入配置」）。
        // demo-only 同理：那是「恢复/导入未完成」的内置兜底，若已有真实站点展示
        // （预渲染或上一次刷新），不能让示例源把它顶掉——恢复完成后 configTask
        // 守望/重载事件会重新拉 /sites 覆盖。
        if ((!all.length || isDemoOnlySites(all)) && this._allSites.length && !isDemoOnlySites(this._allSites)) {
            // 开关刚关闭时，即使 /sites 本轮失败，也要立刻取消历史 blockedSites 过滤。
            const blocked = this._validBlocked(this._allSites, await this._getBlocked(settings), settings);
            if (!isCurrentSitesLoad()) return;
            this._configPending = true; // 恢复未完成：站点请求会打空，刷新/搜索入口先提示
            this.sites = this._allSites.filter((s) => blocked.indexOf(s.key) < 0);
            this._renderSiteSelect();
            return;
        }
        // 源集合变更（配置自动重载后 key 集不同，多仓漂移常见）：旧探测/屏蔽记录
        // 不再适用。但**保留全部持久化状态**（probedSites/blockedSites/空分类结果
        // 及其内存镜像 _emptyCls/_okCls/_clsTs/_clsStarted）：它们按源 key 复用——
        // 已探测/已屏蔽的 key 直接跳过（24h 新鲜期内零网络请求），仅新出现的 key
        // 需要探测。此前每次 sig 变化都清空记录，导致多仓每次返回不同仓时每次
        // 重启全量重探，且用户手动屏蔽的源被悄悄恢复（T25 的顾虑由「新 key 自然全探」满足，无需清空旧记录）。
        // 恢复/导入进行中（demo-only 且任务 loading）：示例源不是用户内容——不播
        // demo、不探测，首页显示恢复提示；完成后 configTask 守望/重载事件会重新
        // loadSites 上真实站点。
        if (isDemoOnlySites(all)) {
            let busy = false;
            try { const t = await doAction('configTask', {}); busy = !!(t && t.status === 'loading'); } catch (e) { /* 后端瞬断按无配置处理 */ }
            if (busy) {
                if (!isCurrentSitesLoad()) return;
                this._configPending = true; // 恢复进行中：站点请求会打空，入口先提示
                $('#home-class').empty();
                $('#home-grid').html('<div class="tip-line">正在恢复上次的配置，完成后自动刷新…</div>');
                $('#home-pager').empty();
                return;
            }
            // 任务不在跑：真·首次运行（无任何配置），继续走示例源引导
        }
        const sig = all.map((s) => s.key).join('|');
        if (this._allSites.length && sig !== this._allSites.map((s) => s.key).join('|')) {
            this._probeToken++; // 进行中的旧探测写入前校验世代，结果丢弃
            this._probing = false; // 释放锁，允许对新集合重新发起探测
            this._clsProbed = {};
            this._clsBusy = {};
            this._cancelProbeRound2(); // 补测轮随源集合变更作废（token 校验兜底）
            this._probingAll = false; // 全源探测在途锁随源集合变更释放
        }
        if (!isCurrentSitesLoad()) return;
        this._allSites = all;
        this._configPending = false; // 真实站点已就绪：解除恢复期入口拦截
        // 关闭自动检测时暂时忽略历史自动屏蔽记录；重新打开后仍可按原记录过滤，
        // 用户可通过“恢复被屏蔽的源”清除这些记录。屏蔽记录先按内容指纹校验：
        // 合并/主仓漂移后同名 key 指向不同站点时，旧屏蔽不再隐藏新源。
        const blocked = this._validBlocked(all, await this._getBlocked(settings), settings);
        if (!isCurrentSitesLoad()) return;
        // U6.2 健康站点展示规则：
        // 1. healthy / degraded / half-open 正常展示；
        // 2. Android-only / unsupported 固定隐藏，诊断页保留；
        // 3. circuit-open 可展示置灰态或受控重试。
        this.sites = all.filter((s) => {
            if (blocked.indexOf(s.key) >= 0) return false;
            const isAndroid = s.runtime === 'android' || (s.lastError && s.lastError.code === 'L2_SITE_REQUIRES_ANDROID');
            if (isAndroid) return false;
            if (s.state === 'unsupported' || s.runtime === 'unsupported') return false;
            return true;
        });
        this._renderSiteSelect();
        if (!this.sites.length) {
            $('#home-class').empty();
            $('#home-grid').html('<div class="tip-line">尚未载入任何配置。请到“设置 → 源设置”，粘贴配置 URL 或 JSON 后点“载入配置”。</div>');
            $('#home-pager').empty();
            return;
        }
        if (!this.sites.some((s) => s.key === this.site)) this.site = this.sites[0].key;
        $('#site-select').val(this.site);
        if (!isCurrentSitesLoad()) return;
        await this.loadHome();
        if (!isCurrentSitesLoad()) return;
        if (this._autoProbeEnabled) {
            // 探测延迟启动：先让首页 feed/分类上屏（避免 8 并发探测与首屏内容
            // 请求抢后端、进度条压在刚刷出的页面上），数秒后再后台开跑。
            // 一轮全量（当前源置顶）+ 分类空态探测；新一轮 loadSites 会重排。
            clearTimeout(this._probeStartTimer);
            const token = this._probeToken;
            this._probeStartTimer = setTimeout(() => {
                this._probeStartTimer = null;
                if (token !== this._probeToken || !this._autoProbeEnabled) return;
                this._probeSites();
                this._probeAllClasses();
            }, this._probeStartDelayMs);
        }
    },
    _renderSiteSelect() {
        const sel = $('#site-select').empty();
        if (!this.sites.length) {
            sel.append('<option value="">（无可用站点 · 请在设置→源设置载入可移植源）</option>');
            return;
        }
        const nowSec = Date.now() / 1000;
        const optionsHtml = this.sites.map((s) => {
            const isDegraded = s.state === 'degraded' || s.state === 'credentials_required' || s.is_pan;
            const isCircuitOpen = s.state === 'circuit-open' || (s.circuitOpenUntil && s.circuitOpenUntil / 1000 > nowSec);
            let tag = '';
            if (isCircuitOpen) {
                const remain = Math.max(0, Math.ceil((s.circuitOpenUntil / 1000) - nowSec));
                tag = ` [熔断保护 ${remain}s]`;
            } else if (isDegraded) {
                tag = ' [降级·需Cookie/解析]';
            }
            return `<option value="${escHtml(s.key)}">${escHtml(s.name || s.key)}${tag}</option>`;
        }).join('');
        sel.append(optionsHtml);
    },

    async _getSourceSettings() {
        try { return (await window.yuki.settingsGet()) || {}; } catch (e) { return {}; }
    },

    /** 配置恢复/导入进行中的提示文案（空串 = 后端就绪）。
     *  恢复窗口期（最长 ~45s）后端只有示例源，站点请求必然 L2_SITE_NOT_FOUND——
     *  刷新/搜索/点分类若照常发请求，失败回来会把已显示的缓存内容翻成
     *  「暂无内容」，误导用户以为源没内容。 */
    _configBusyText() {
        return this._configPending ? '正在恢复上次的配置，完成后自动刷新，请稍候' : '';
    },

    /** 设置自动检测状态并使进行中的一轮探测失效。 */
    setAutoProbeEnabled(enabled) {
        const next = enabled !== false;
        if (this._autoProbeEnabled === next) return;
        this._autoProbeEnabled = next;
        this._probeToken++;
    },

    /**
     * 会话级证据重置：probeFailStreak 只反映「当前会话内的连续无响应」，跨会话不累加。
     * 上次会话冷启动争用留下的连败计数若带进本次会话，源会带着欠账开局——指纹迁移/
     * 换仓触发的全量重探里，一轮失败就直接越过 PROBE_FAIL_LIMIT 把慢但可用的源按死源
     * 屏蔽（R15 回归修正）。死源收敛由同会话补探第二轮保证，无需跨会话计数。
     */
    async _resetSessionEvidence() {
        try {
            const s = await window.yuki.settingsGet();
            const streak = s && s.probeFailStreak;
            if (streak && typeof streak === 'object' && !Array.isArray(streak) && Object.keys(streak).length) {
                await window.yuki.settingsSet('probeFailStreak', {});
            }
        } catch (e) { /* 读取失败不影响启动 */ }
    },

    async _getBlocked(settings) {
        const s = settings || await this._getSourceSettings();
        if (s.sourceAutoDetect === false) return [];
        return Array.isArray(s.blockedSites) ? s.blockedSites : [];
    },

    /**
     * 屏蔽记录按 key 持久化，但结论附带内容指纹（probeFp，见 siteProbeFp）：
     * 仅当指纹与当前站点内容一致时才继续屏蔽——多仓合并/主仓漂移会让同名
     * key 指向不同 api/spider 的站点，旧「屏蔽」不得隐藏新内容。旧版本数据
     * 无指纹：视为失效（该源恢复展示并重探，顺带自愈历史误屏蔽）。
     * 返回仍然有效的被屏蔽 key 列表。
     */
    _validBlocked(sitesList, blockedArr, settings) {
        const raw = Array.isArray(blockedArr) ? blockedArr : [];
        if (!raw.length || !Array.isArray(sitesList) || !sitesList.length) return [];
        const fpMap = (settings && settings.probeFp && typeof settings.probeFp === 'object' &&
            !Array.isArray(settings.probeFp)) ? settings.probeFp : {};
        const byKey = {};
        sitesList.forEach((x) => { if (x && x.key) byKey[x.key] = x; });
        return raw.filter((k) => {
            const s = byKey[k];
            return !!s && fpMap[k] === siteProbeFp(s);
        });
    },

    // ------------------------------------------------ 首页探测进度条（T81）

    /** 开始一段探测并计入总进度（total<=0 不计入）。合并源级 + 分类探测为一条总进度。 */
    _startProbe(total) {
        if (total <= 0) return false;
        if (!this._probeBar) {
            this._probeBar = { total: 0, done: 0, active: 0, shown: false, showTimer: null, doneTimer: null };
        }
        const b = this._probeBar;
        b.total += total;
        b.active += 1;
        clearTimeout(b.doneTimer); // 新一轮探测打断「已完成」倒计时
        if (!b.showTimer) {
            // 超过约 1 秒仍未完成才显示进度条（避免快速探测闪现）
            b.showTimer = setTimeout(() => {
                const bb = this._probeBar;
                if (bb && !bb.shown && bb.done < bb.total) { bb.shown = true; this._updateProbeBar(false); }
            }, 1000);
        }
        return true;
    },

    /** 一段探测完成：全部探测结束后，若进度条已显示则展示「已完成」并延迟隐藏。 */
    _endProbe() {
        const b = this._probeBar;
        if (!b) return;
        b.active -= 1;
        if (b.active <= 0) {
            clearTimeout(b.showTimer);
            if (b.shown) {
                b.done = b.total;
                this._updateProbeBar(true);
                b.doneTimer = setTimeout(() => {
                    if (this._probeBar) { this._probeBar = null; this._hideProbeBar(); }
                }, 1500);
            } else {
                this._probeBar = null; // 未显示过就不显示
            }
        }
    },

    /** 单个探测单元完成（源级按源、分类级按源）。 */
    _probeOneDone() {
        const b = this._probeBar;
        if (!b) return;
        b.done += 1;
        if (b.shown) this._updateProbeBar(false);
    },

    /** 渲染进度条（done=true 走「已完成」态）。复用 renderStatusBar——spinner 稳定不重建。 */
    _updateProbeBar(done) {
        const b = this._probeBar;
        const el = $('#home-probe-bar');
        if (!el.length || !b) return;
        const isDone = !!done || (b.total > 0 && b.done >= b.total);
        renderStatusBar(el, { text: isDone ? '已完成' : '正在探测源…', recv: b.done, total: b.total, done: isDone });
        el.show();
    },

    _hideProbeBar() {
        $('#home-probe-bar').hide().empty();
    },

    /** 配置恢复/导入进度条：由 app.js 的 configTask 轮询驱动（loading 时显示，结束隐藏）。
     *  后端 progress：stage restoring(恢复缓存)/fetch(取子仓)/build(检测站点)，
     *  current/total 按「实际完成的站点数」上报（队头挂死时进度仍然前进）。 */
    renderRestoreProgress(task) {
        const el = $('#home-restore-bar');
        if (!el.length) return;
        const loading = !!(task && task.status === 'loading');
        if (!loading) { el.hide().empty(); return; }
        const p = (task && task.progress) || {};
        const stageText = {
            restoring: '正在恢复上次的配置',
            fetch: '获取仓库',
            build: '检测站点',
            merge: '合并多仓站点',
        }[p.stage] || '正在载入配置';
        const current = Number(p.current || 0);
        const total = Number(p.total || 0);
        renderStatusBar(el, { text: stageText, recv: current, total, done: false });
        el.show();
    },

    /**
     * 后台探测无内容源：只有真实内容才算可用——homeContent 推荐位(list)
     * 非空，或至少一个分类拉到资源。推荐位为空时逐个分类确认，全部分类
     * 均确认无内容才记入 blockedSites（仅有 class 结构不代表有内容）。
     *
     * 失败不误杀、死源不漏杀：
     * - 失败包络/超时/首轮确认空 = 证据不足，轮内隔 PROBE_RETRY_DELAY 二次确认一次；
     * - 连续 PROBE_FAIL_LIMIT 轮无响应 → 按死源屏蔽；连续两轮确认全空 → 按无内容屏蔽。
     *   连败计数只在当前会话内累加（init 时清跨会话欠账，_resetSessionEvidence），
     *   同会话由补探第二轮收敛——上次冷启动慢留下的旧计数不得让本次一轮就越限，
     *   否则指纹迁移/换仓引发的全量重探会把有影片的慢源批量误杀（R15 回归修正）；
     * - 全量轮结束时仍有未达阈值的证据不足源 → 隔 PROBE_ROUND2_DELAY 同会话自动补探
     *   第二轮（只探这批源，自终止），连败达标即在本次会话内按死源屏蔽；
     * - 已结论源按 PROBE_RECHECK_TTL 复查：内容失效补屏蔽，屏蔽源恢复内容自动解除；
     * - 分类出错本轮不下结论，留待下次重试。并发 4，结果持久化（可在源配置里恢复）。
     *
     * onlySite：'' = 全量轮；单个 key = 单源探测；key 数组 = 补测轮（opts.round2 标记）。
     */
    async _probeSites(onlySite = '', opts = {}) {
        if (!this._autoProbeEnabled || this._probing || !this._allSites.length) return;
        this._probing = true;
        const token = this._probeToken; // 写入前校验：期间配置重载换源则丢弃本轮结果
        let started = false; // 进度条是否计入本轮（T81）
        try {
            const s = (await window.yuki.settingsGet()) || {};
            if (s.sourceAutoDetect === false || !this._autoProbeEnabled) return;
            const probed = {};
            (Array.isArray(s.probedSites) ? s.probedSites : []).forEach((k) => { probed[k] = 1; });
            const blocked = new Set(Array.isArray(s.blockedSites) ? s.blockedSites : []);
            const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
            const probedAt = obj(s.probedAt);        // key → 结论时间戳（复查调度）
            const streak = obj(s.probeFailStreak);   // key → 连续无响应轮数
            const reason = obj(s.blockedReason);     // key → 'empty'（无内容）/ 'dead'（连续无响应）
            const fpMap = obj(s.probeFp);            // key → 结论时的内容指纹（siteProbeFp）
            let dirty = false;
            let changed = false, newBlocked = 0, blockedDead = 0, revived = 0;
            // 内容指纹守卫（换仓重置的细粒度补充）：多仓合并/主仓漂移会让同名 key
            // 指向不同 api/spider 的站点。结论指纹与当前内容不符（含旧版本数据没有
            // 指纹，无法证明内容未变）即作废——否则旧仓的「屏蔽」会继续隐藏合并后
            // 同 key 的可用源、旧的「已探过」会让新内容漏探。作废的屏蔽源当场恢复
            // 展示（并入 revived 统计），并在本轮结束时随其他状态一并回写清理。
            {
                const byKey = {};
                this._allSites.forEach((x) => { byKey[x.key] = x; });
                Object.keys(byKey).forEach((k) => {
                    if (fpMap[k] === siteProbeFp(byKey[k])) return;
                    if (probed[k]) { delete probed[k]; delete probedAt[k]; dirty = true; }
                    if (streak[k]) { delete streak[k]; dirty = true; }
                    if (reason[k]) { delete reason[k]; dirty = true; }
                    if (blocked.delete(k)) { revived++; changed = true; }
                });
            }
            // 迁移：旧数据只有 probedSites 数组。补「现在」作结论时间，避免升级后
            // 首次启动把全部历史源当成过期源一次性重探；之后各自按 TTL 到期复查。
            Object.keys(probed).forEach((k) => {
                if (!probedAt[k]) { probedAt[k] = Date.now(); dirty = true; }
            });
            const isStale = (k) => !probedAt[k] || (Date.now() - probedAt[k]) > PROBE_RECHECK_TTL;
            // 待探测 = 从未探过，或结论已过期（含被屏蔽源：复查到内容即自动解除）
            const wanted = (k) => !onlySite ||
                (Array.isArray(onlySite) ? onlySite.indexOf(k) >= 0 : k === onlySite);
            const pending = this._allSites.filter((x) =>
                ((!probed[x.key] || isStale(x.key)) && wanted(x.key)));
            if (!pending.length) {
                if (dirty) await window.yuki.settingsSet('probedAt', probedAt);
                return;
            }
            if (!onlySite && pending.length > 1 && this.site) {
                // 全量轮把当前源置顶：首屏反馈优先，其余源在同轮并发补全——
                // 不再「先串行探完当前源、再起全量轮」（死源会把全量轮拖到几分钟后）
                pending.sort((a, b) => (b.key === this.site) - (a.key === this.site));
            }
            started = this._startProbe(pending.length);
            let idx = 0;
            const unknowns = []; // 本轮证据不足：轮末二次确认
            const round2Candidates = []; // 二次确认仍失败且未达屏蔽阈值：30s 后同会话补探第二轮
            const conclude = (site) => {
                probed[site.key] = 1;
                probedAt[site.key] = Date.now();
                fpMap[site.key] = siteProbeFp(site); // 结论与内容绑定，内容变更后自动失效
                delete streak[site.key];
                // 复查发现屏蔽源恢复内容：自动解除（僵尸源复活）
                if (blocked.delete(site.key)) { revived++; changed = true; }
                delete reason[site.key];
                dirty = true;
            };
            const markEmpty = (site) => {
                // 确认空与失败包络同走连败阈值：单轮空响应可能是软限流/数据预热，
                // 直接屏蔽会误杀有影片的源；连续两轮确认全空才按无内容屏蔽。
                streak[site.key] = (streak[site.key] || 0) + 1;
                fpMap[site.key] = siteProbeFp(site);
                if (streak[site.key] >= PROBE_FAIL_LIMIT) {
                    delete streak[site.key];
                    probed[site.key] = 1;
                    probedAt[site.key] = Date.now();
                    if (!blocked.has(site.key)) { blocked.add(site.key); newBlocked++; changed = true; }
                    reason[site.key] = 'empty';
                } else {
                    // 未达阈值：本轮不下结论。同会话稍后自动补探第二轮（_scheduleProbeRound2）。
                    round2Candidates.push(site);
                }
                dirty = true;
            };
            const markUnknown = (site) => {
                streak[site.key] = (streak[site.key] || 0) + 1;
                fpMap[site.key] = siteProbeFp(site); // 连败计数同样与内容绑定，内容变更后作废
                if (streak[site.key] >= PROBE_FAIL_LIMIT) {
                    // 连续多轮完全无响应（首页+分类全部失败包络/超时）：实际死源，
                    // 不设阈值会永远留在列表里。按死源屏蔽，解除入口同无内容源。
                    delete streak[site.key];
                    probed[site.key] = 1;
                    probedAt[site.key] = Date.now();
                    if (!blocked.has(site.key)) { blocked.add(site.key); newBlocked++; changed = true; }
                    reason[site.key] = 'dead';
                    blockedDead++;
                } else {
                    // 未达阈值：本轮不下结论。同会话稍后自动补探第二轮（_scheduleProbeRound2），
                    // 不必等下次启动的整轮扫描就能收敛到「连续无响应 → 死源屏蔽」。
                    round2Candidates.push(site);
                }
                dirty = true;
            };
            const probeOne = async (site, firstPass) => {
                let verdict; // 'ok' | 'empty' | 'unknown'
                // 分级超时：首轮 20s 快速分类（绝大多数源秒回，死源快速进入连败计数）；
                // 二次确认 45s 给慢源一次长机会。渲染层 fetch 超时比 deadline 略宽。
                const deadline = firstPass ? PROBE_FAST_TIMEOUT : PROBE_SLOW_TIMEOUT;
                try {
                    const d = await doAction('homeContent', { site: site.key, filter: 'false', deadlineMs: deadline }, null, deadline + 5000);
                    if (((d && d.list) || []).length > 0) {
                        // 真实内容优先于错误：部分源返回 list 的同时内嵌 error/warning
                        //（jar 蜘蛛部分线路失败），有影片就是可用源，不能按失败计。
                        verdict = 'ok';
                    } else if (actionResponseFailed(d)) {
                        // 失败包络（spider 异常/超时/风控）或内嵌 error 且无内容：证据不足
                        verdict = 'unknown';
                    } else {
                        // 推荐位为空：逐个分类确认。任一分类有内容即可用；
                        // 全部分类都确认返回空才屏蔽；分类出错则证据不足。
                        const v = await this._probeSiteCategories(site.key, d && d.class);
                        verdict = v === 'ok' ? 'ok' : (v === 'unknown' ? 'unknown' : 'empty');
                    }
                } catch (e) { verdict = 'unknown'; }
                if ((verdict === 'unknown' || verdict === 'empty') && firstPass) {
                    unknowns.push(site); // 首轮不下结论：失败包络与空结果都给慢超时二次确认
                } else {
                    if (verdict === 'unknown') markUnknown(site);
                    else if (verdict === 'empty') markEmpty(site);
                    else conclude(site);
                    this._probeOneDone(); // T81：单个源探测完成（每源只计一次）
                }
            };
            const worker = async () => {
                while (idx < pending.length) { await probeOne(pending[idx++], true); }
            };
            await Promise.all(Array.from({ length: Math.min(PROBE_SITE_CONCURRENCY, pending.length) }, worker));
            // 轮内二次确认：滤掉瞬时抖动；仍无响应才计入连败
            if (unknowns.length) {
                await new Promise((r) => setTimeout(r, this._probeRetryDelayMs));
                let ridx = 0;
                const retryWorker = async () => {
                    while (ridx < unknowns.length) { await probeOne(unknowns[ridx++], false); }
                };
                await Promise.all(Array.from({ length: Math.min(PROBE_SITE_CONCURRENCY, unknowns.length) }, retryWorker));
            }
            if (token !== this._probeToken || !this._autoProbeEnabled) return; // 源集合/开关已变更，旧结果不再适用
            if (dirty) {
                // 按当前源集合裁剪持久化状态：离场源（多仓漂移）的记录不无限累积
                const liveKeys = new Set(this._allSites.map((x) => x.key));
                blocked.forEach((k) => liveKeys.add(k));
                const pick = (m) => {
                    const out = {};
                    Object.keys(m).forEach((k) => { if (liveKeys.has(k)) out[k] = m[k]; });
                    return out;
                };
                await window.yuki.settingsSet('probedSites', Object.keys(probed).filter((k) => liveKeys.has(k)));
                await window.yuki.settingsSet('probedAt', pick(probedAt));
                await window.yuki.settingsSet('probeFailStreak', pick(streak));
                await window.yuki.settingsSet('blockedReason', pick(reason));
                await window.yuki.settingsSet('probeFp', pick(fpMap));
            }
            if (changed) {
                await window.yuki.settingsSet('blockedSites', Array.from(blocked));
                // 刷新下拉（不打断当前选中源）；当前源被屏蔽则切到第一个可用源
                // 复用 loadSites 的健康过滤，避免探后把 Android 等隐藏源重新放出
                const cur = this.site;
                this.sites = this._allSites.filter((x) => {
                    if (blocked.has(x.key)) return false;
                    const isAndroid = x.runtime === 'android' || (x.lastError && x.lastError.code === 'L2_SITE_REQUIRES_ANDROID');
                    if (isAndroid) return false;
                    if (x.state === 'unsupported' || x.runtime === 'unsupported') return false;
                    return true;
                });
                this._renderSiteSelect();
                if (this.sites.length && !this.sites.some((x) => x.key === cur)) {
                    this._cacheDropSite(cur); // 程序切源同样清理旧源缓存
                    this.site = this.sites[0].key;
                    $('#site-select').val(this.site);
                    this.loadHome();
                } else if (this.sites.length) {
                    $('#site-select').val(cur);
                }
                const parts = [];
                if (newBlocked) {
                    parts.push(`已自动屏蔽 ${newBlocked} 个无内容源`);
                    if (blockedDead) parts.push(`其中 ${blockedDead} 个连续探测无响应`);
                }
                if (revived) parts.push(`恢复 ${revived} 个源`);
                parts.push('可在源配置里恢复');
                warnToast(parts.join('，'));
            }
            // 同会话补探第二轮：全量轮结束时仍有「证据不足且未达屏蔽阈值」的源 → 隔
            // PROBE_ROUND2_DELAY 只补测这批源；补测轮内连败达到阈值即本次会话内按死源
            // 屏蔽（不必等下次启动）。补测轮自身不再续期（自终止），换仓/关开关作废。
            if (!opts.round2 && !onlySite && round2Candidates.length &&
                token === this._probeToken && this._autoProbeEnabled) {
                this._scheduleProbeRound2(round2Candidates);
            }
        } catch (e) { /* 探测异常不影响主流程 */ } finally {
            this._probing = false;
            if (started) this._endProbe(); // T81：一段探测完成
        }
    },

    /** 证据不足源的同会话补测调度：合并待测 key（去重、裁剪到当前源集合），隔
     *  _probeRound2DelayMs 只补测这批源；到点校验探测世代与开关后取走目标一次性执行
     *  （不滚动续期 → 自终止）。换仓/关开关会主动取消定时器或使其到点即弃。 */
    _scheduleProbeRound2(sites) {
        const live = new Set(this._allSites.map((x) => x.key));
        sites.forEach((s) => {
            if (live.has(s.key) && this._probeRound2Keys.indexOf(s.key) < 0) {
                this._probeRound2Keys.push(s.key);
            }
        });
        if (!this._probeRound2Keys.length) return;
        clearTimeout(this._probeRound2Timer);
        const token = this._probeToken;
        this._probeRound2Timer = setTimeout(() => {
            this._probeRound2Timer = null;
            const keys = this._probeRound2Keys.splice(0); // 取走即清空：补测轮不续期
            if (!keys.length || token !== this._probeToken || !this._autoProbeEnabled) return;
            this._probeSites(keys, { round2: true });
        }, this._probeRound2DelayMs);
        if (this._probeRound2Timer && typeof this._probeRound2Timer.unref === 'function') {
            this._probeRound2Timer.unref(); // Node 测试环境：不阻止进程退出
        }
    },

    /** 取消在途的证据不足源补测定时器并清空待测目标。 */
    _cancelProbeRound2() {
        clearTimeout(this._probeRound2Timer);
        this._probeRound2Timer = null;
        this._probeRound2Keys = [];
    },

    /**
     * 逐个分类确认某源是否有内容（首页推荐位为空时调用）。
     * 并发拉分类第 1 页，任一分类有资源即提前结束；
     * 有出错分类时返回 'unknown'（本轮不下结论），避免把临时故障源误屏蔽。
     * 返回 'ok'（有内容）/ 'empty'（全部已查分类确认无内容）/ 'unknown'（证据不足）。
     */
    async _probeSiteCategories(siteKey, cls) {
        const seen = new Set();
        const tids = [];
        (Array.isArray(cls) ? cls : []).forEach((c) => {
            const tid = String(c && c.type_id != null ? c.type_id : '');
            if (tid !== '' && !seen.has(tid)) { seen.add(tid); tids.push(tid); }
        });
        // 上限护栏：异常源分类再多也只查前 N 个，防止拖垮后台探测
        const targets = tids.slice(0, PROBE_CAT_LIMIT);
        if (!targets.length) return 'empty'; // 无分类可查且推荐位为空 → 确认无内容
        let idx = 0, hasContent = false, errored = 0;
        const worker = async () => {
            while (idx < targets.length && !hasContent) {
                const tid = targets[idx++];
                try {
                    const c = await doAction('categoryContent', {
                        site: siteKey, tid, pg: '1', filter: 'false', extend: '{}',
                        deadlineMs: PROBE_CAT_TIMEOUT,
                    }, null, PROBE_CAT_TIMEOUT);
                    if (((c && c.list) || []).length) {
                        // 内容优先于错误：带内嵌 error 但返回了影片 → 该分类可用
                        hasContent = true; return;
                    }
                    // 失败包络（spider 异常/超时）≠ 该分类确认无内容：按出错处理，
                    // 不参与「全部分类皆空」结论，避免故障源被误屏蔽
                    if (actionResponseFailed(c)) { errored++; }
                } catch (e) { errored++; } // 该分类出错：记为未判定，不参与「全空」结论
            }
        };
        await Promise.all(Array.from({ length: Math.min(PROBE_CAT_CONCURRENCY, targets.length) }, worker));
        if (hasContent) return 'ok';
        return errored ? 'unknown' : 'empty';
    },

    /**
     * 「全部」标签：所有页统一用源总览内容 feed（homeVideoContent，跨分类最新/全部），
     * 合并源页填满每页条数、可一直翻页（T76/T78：第 1 页也走 feed，保证严格按设置条数显示）。
     * 源不支持 homeVideoContent（feed 空）时，第 1 页回退自适应首页（推荐位 + 分类铺满）。
     */
    async loadHome(pg, opts) {
        if (!this.site) return;
        this.mode = 'home';
        this.tid = '';
        this.page = pg || 1;
        this._userRefresh = !!(opts && opts.userRefresh); // 刷新按钮触发：失败保留内容时提示
        this._pageSizeDirty = false; // 完整重载后清除脏标记
        $('#home-search').val(''); // 退出搜索态
        const token = ++this._loadToken;
        const size = await this._pageSize();
        if (token !== this._loadToken) return;
        $('#home-pager').empty();
        showLoading();
        this._feedCacheBooted = false;
        try {
            // 冷启动即时上屏：先用缓存的分类标签渲染（避免空标签栏闪现），网络返回后以最新结果覆盖
            const cachedCls = this._loadClassCache(this.site);
            if (cachedCls && cachedCls.length && !this.classes.length) {
                this.classes = cachedCls;
                this.renderClass('');
            }
            // 首屏并行：homeContent（分类+推荐位）与「全部」feed 同时发起，
            // feed 先返回时先渲染，分类返回后再刷新分类栏（T77 并行提速）
            const pFirstScreen = Promise.all([
                doAction('homeContent', { site: this.site, filter: 'false' }),
                this._fetchHomeFeed(this.page, size),
            ]);
            // 持久化 feed 缓存已即时上屏 → 提前撤掉全局遮罩（遮罩会挡住缓存画面，
            // 慢源网络期间用户被迫看转圈）；网络返回后令牌校验通过才静默覆盖。
            if (this._feedCacheBooted) hideLoading();
            const [data, feedItems] = await pFirstScreen;
            if (token !== this._loadToken) return;
            if (data && Array.isArray(data.class)) {
                this.classes = data.class;
                this._saveClassCache(this.site, this.classes);
            }
            this.renderClass('');
            // 内容：源总览 feed（合并源页填满每页条数）
            if (this.page === 1 && !feedItems.length) {
                // 源无「全部」feed：回退自适应首页（推荐位 + 分类铺满）
                this._homeList = ((data && data.list) || []).slice();
                this._fillTid = this.classes.length
                    ? String(this.classes[0].type_id != null ? this.classes[0].type_id : '')
                    : '';
                this._fillPg = 0;
                this._fillSeen = {};
                this._homeList.forEach((v) => { this._fillSeen[v.vod_id + '|' + v.vod_name] = 1; });
                this._extendHome(token);
                this.pagecount = 1;
            }
            this.renderGrid(this._homeList);
            this.renderPager();
            $('#view-home').scrollTop(0);
        } catch (e) {
            warnToast(this.page > 1 ? '全部载入失败' : '首页载入失败');
        } finally {
            hideLoading();
        }
        // T60：后台探测分类，隐藏无影片的分类（不阻塞首屏；结果不丢进度，见 _probeClasses）
        if (this._autoProbeEnabled) this._probeClasses();
    },

    /**
     * T76：「全部」总览 feed：合并多个 homeVideoContent 源页，取当前页 [ (pg-1)*size, pg*size )。
     * 复用 _catWin 合并窗口（key `site|__all__`），翻页只补拉缺失源页；总页数 = ceil(源总量/每页条数)。
     * 冷启动（无合并窗口且在首页第 1 页）时优先重建本地持久化 feed 缓存，网络返回前即可上屏。
     */
    async _fetchHomeFeed(pg, size) {
        const site = this.site;          // M-30b：快照本次加载的源与令牌
        const token = this._loadToken;
        // 冷启动加速：仅当首次进入、无内存窗口时，尝试用本地持久化缓存用旧 feed 先渲染
        this._feedCacheBooted = false;
        if (pg === 1 && !this._catWin.has(site + '|__all__') && !this._homeCacheBooted) {
            const boot = this._cacheHomeGet(site);
            if (boot && boot.items.length) {
                this._homeList = boot.items.slice(0, size);
                if (boot.pagecount > 0) this.pagecount = boot.pagecount;
                this.renderGrid(this._homeList);
                this.renderPager();
                this._feedCacheBooted = true; // 已即时上屏：loadHome 据此提前撤全局遮罩
            }
            this._homeCacheBooted = true; // 只引导一次（网络返回后以最新覆盖）
        }
        const win = this._catWinGet(site, '__all__');
        const need = pg * size; // 累计需覆盖到该页末尾
        let guard = 0;
        let fetchFailed = false; // 失败包络≠无内容（配置恢复中当前源还不在后端等）
        while (win.items.length < need && guard++ < 200) {
            const data = await doAction('homeVideoContent', { site, pg: String(win.sourcePg + 1) });
            if (token !== this._loadToken || site !== this.site) return; // M-30b：切源即中止
            if (actionResponseFailed(data)) { fetchFailed = true; break; }
            const list = (data && data.list) || [];
            if (!list.length) break;
            if (data && data.total > 0) win.total = data.total;
            const pc = parseInt(data && data.pagecount, 10);
            if (pc > 0 && !win.total) win.total = pc * ((data && data.limit) || win.perPage);
            if (data && data.limit > 0) win.perPage = data.limit;
            let added = 0;
            list.forEach((v) => {
                if (v && v.vod_id != null && !win.seen.has(v.vod_id)) {
                    win.seen.add(v.vod_id); win.items.push(v); added++;
                }
            });
            win.sourcePg += 1;
            if (!added) { break; /* 全是重复，已拉空 */ }
        }
        // 网络失败（失败包络）且一条新数据都没拿到：保留当前已显示的内容——冷启动
        // 缓存上屏、或刷新前的旧内容。「暂不可用」不是「没有内容」，不能翻成
        // 「暂无内容」；恢复完成后 configTask 守望/重载事件会重新 loadHome 刷新。
        if (fetchFailed && !win.items.length && this._homeList.length) {
            if (this._userRefresh) warnToast('源暂不可用，已保留当前显示');
            return this._homeList;
        }
        this._homeList = win.items.slice((pg - 1) * size, pg * size);
        if (win.total > 0) {
            this.pagecount = Math.max(1, Math.ceil(win.total / size));
        } else if (win.items.length < need) {
            this.pagecount = Math.max(1, Math.ceil(win.items.length / size)); // 源已拉空，按实际条数
        } else {
            this.pagecount = Math.max(this.pagecount || 1, pg + 1); // 未知总量：暂允试下一页
        }
        this._cachePut(site, '__all__', pg, this._homeList, this.pagecount);
        // 持久化首页 feed 缓存（仅第 1 页、有内容时写入，下次冷启动直接上屏）
        this._cacheHomePut(site, this._homeList, this.pagecount);
        return this._homeList;
    },

    /** 本地持久化首页 feed（key: home::feed::v1::<site>，TTL 30min）：冷启动网络返回前先呈现旧内容。 */
    _cacheHomeGet(site) {
        try {
            if (typeof localCacheGet !== 'function') return null;
            const d = localCacheGet(HOME_FEED_CACHE_PREFIX + site);
            if (!d || !Array.isArray(d.items) || !d.items.length) return null;
            return d;
        } catch (e) { return null; }
    },
    _cacheHomePut(site, items, pagecount) {
        try {
            if (typeof localCacheSet !== 'function' || !site || !Array.isArray(items) || !items.length) return;
            localCacheSet(HOME_FEED_CACHE_PREFIX + site, { ts: Date.now(), pagecount, items: items.slice(0, 60) }, HOME_FEED_CACHE_TTL);
        } catch (e) { /* 缓存失败忽略 */ }
    },

    /** 铺满首页的目标卡片数（T39：跟随「首页每页条数」设置，默认 20）。 */
    async _adaptiveTarget() {
        return await pageSizeOf('pageSizeHome');
    },

    /**
     * 铺满首页目标卡片数：逐个分类逐页拉内容去重追加，每拉到一批立即增量渲染，
     * 直到达到每页条数目标。原只填 classes[0]——首个分类内容少/为空时首页填不满
     * 设置条数（如 量子资源 首个分类「电影片」仅 1 条），现自动换下一个分类（T75）。
     */
    async _extendHome(token) {
        if (!this.classes.length) return;
        const target = await this._adaptiveTarget();
        let guard = 0; // 总请求护栏：目标越大允许请求越多，防异常源无限循环
        while (this._homeList.length < target && guard++ < Math.max(60, target * 2)) {
            this._fillPg += 1;
            let items = [];
            try {
                const data = await doAction('categoryContent', {
                    site: this.site, tid: this._fillTid, pg: String(this._fillPg), filter: 'false', extend: '{}',
                });
                items = (data && data.list) || [];
            } catch (e) { items = []; }
            if (token !== this._loadToken) return; // 已切源/切分类，旧拉取作废
            const fresh = [];
            items.forEach((v) => {
                const k = v.vod_id + '|' + v.vod_name;
                if (!this._fillSeen[k]) { this._fillSeen[k] = 1; this._homeList.push(v); fresh.push(v); }
            });
            if (fresh.length) this._appendGrid(fresh);
            // 该分类下一页；空页/短页（内容少无助于填满）或单分类拉满 3 页 → 换下一个分类
            const shortPage = items.length > 0 && items.length < 10;
            if (!items.length || shortPage || this._fillPg >= 3) {
                const idx = this.classes.findIndex((c) => String(c.type_id != null ? c.type_id : '') === this._fillTid);
                if (idx < 0) break; // 分类列表已变化，无从推进
                const next = this.classes[idx + 1];
                if (!next) break; // 全部分类耗尽
                this._fillTid = String(next.type_id != null ? next.type_id : '');
                this._fillPg = 0;
            }
        }
    },

    /** 增量追加卡片（渐进加载；列表为“暂无内容”占位时先清掉）。 */
    _appendGrid(items) {
        const grid = $('#home-grid');
        if (grid.children('.tip-line').length) grid.empty();
        // T65：新增卡片拼串后单次 append（替代逐条 append）
        grid.append(items.map((v) => vodCard(v, this.site)).join(''));
        // T74 收尾：按当前列宽把标题 JS 截到恰好两行（DOM 不保留超行文字）
        fitVodTitles(grid);
        this._fillCovers();
    },

    /** 列表无封面但详情有的卡片：后台逐个从 detailContent 补拉封面（T42）；
     *  绑定当前加载令牌，切源/切分类/切页后旧补拉自动中止。 */
    _fillCovers() {
        const token = this._loadToken;
        fillMissingCovers('#home-grid', () => token === this._loadToken);
    },

    /** 窗口放大后卡片不够铺满：首页推荐位继续补拉（沿用当前加载令牌）。 */
    async _onResize() {
        const token = this._loadToken;
        if (this.mode === 'home') {
            if (!this._homeList.length || this._homeList.length >= (await this._adaptiveTarget())) return;
            await this._extendHome(token);
        }
    },

    /**
     * 分类分页（T6 重设计）：一页一次请求，截断到每页条数后渲染标准分页器。
     * 缓存命中立即渲染并后台静默重拉；force（刷新按钮）绕过缓存。
     */
    async loadCategory(tid, pg, force) {
        if (!this.site) return;
        const busy = this._configBusyText();
        if (busy) { warnToast(busy); return; } // 恢复窗口期：分类请求必然落空
        this.mode = 'category';
        this.tid = tid;
        this.page = pg || 1;
        $('#home-search').val(''); // 切分类退出搜索态
        const token = ++this._loadToken;
        const size = await this._pageSize();
        if (token !== this._loadToken) return;
        if (force) {
            this._cacheDropPage(this.site, tid, this.page);
            this._catWinDelete(this.site, tid); // 强制刷新丢弃合并窗口，重新拉取
        }
        const cached = force ? null : this._cacheGet(this.site, tid, this.page);
        if (cached) {
            // 命中缓存：立即上屏，后台静默刷新（内容变化才重渲染）
            if (cached.pagecount > 0) this.pagecount = cached.pagecount;
            this._catItems = cached.list;
            this.renderGrid(this._catItems, this._catError);
            this.renderPager();
            $('#view-home').scrollTop(0);
            this._refreshCatPage(token, tid, this.page, size);
            return;
        }
        showLoading();
        try {
            await this._fetchCat(tid, this.page, size);
            if (token !== this._loadToken) return;
            this.renderGrid(this._catItems, this._catError);
            this.renderPager();
            // 切页后回到顶部
            $('#view-home').scrollTop(0);
        } catch (e) {
            warnToast('分类载入失败');
        } finally {
            hideLoading();
        }
    },

    /** 生效的每页条数（T39：首页单独设置 pageSizeHome，默认 20）。 */
    async _pageSize() {
        return await pageSizeOf('pageSizeHome');
    },

    /**
     * 拉取分类页并更新 pagecount 与缓存（T75：合并多个源页填满「每页条数」）。
     * 源每页通常 ~20 条，设置超过源页大小时连续拉取后续源页合并，保证一页显示
     * 足量影片。合并结果按 site|tid 累积在 _catWin 窗口（LRU，超限淘汰），
     * 前进/后退翻页复用已拉数据不再重复请求。
     */
    async _fetchCat(tid, pg, size) {
        const site = this.site;          // M-30b：快照本次加载的源与令牌
        const token = this._loadToken;
        const win = this._catWinGet(site, tid);
        const need = pg * size; // 累计需覆盖到的条数
        let guard = 0;
        this._catError = '';
        while (win.items.length < need && guard++ < 200) {
            const data = await doAction('categoryContent', {
                site, tid, pg: String(win.sourcePg + 1), filter: 'false', extend: '{}',
            });
            if (token !== this._loadToken || site !== this.site) return; // M-30b：切源即中止，旧窗口作废
            const list = (data && data.list) || [];
            if (data && data.error) this._catError = data.error; // jar 蜘蛛调用失败原因（后端附加）
            if (!list.length) break; // 源已拉空
            if (data && data.total > 0) win.total = data.total;
            const pc = parseInt(data && data.pagecount, 10);
            if (pc > 0 && !win.total) win.total = pc * ((data && data.limit) || win.perPage);
            if (data && data.limit > 0) win.perPage = data.limit;
            let added = 0;
            list.forEach((v) => {
                if (v && v.vod_id != null && !win.seen.has(v.vod_id)) {
                    win.seen.add(v.vod_id); win.items.push(v); added++;
                }
            });
            win.sourcePg += 1;
            if (!added) { break; /* 全是重复，已拉空 */ }
        }
        this._catItems = win.items.slice((pg - 1) * size, pg * size);
        let pagecount;
        if (win.total > 0) {
            pagecount = Math.max(1, Math.ceil(win.total / size)); // 应用页数 = ceil(源总量 / 每页条数)
        } else if (win.items.length < need) {
            pagecount = Math.max(1, Math.ceil(win.items.length / size)); // 源已拉空，按实际条数
        } else {
            pagecount = Math.max(this.pagecount || 1, pg + 1); // 未知总量：暂允试下一页
        }
        this.pagecount = pagecount;
        this._cachePut(site, tid, pg, this._catItems, pagecount);
    },

    /** 缓存命中后的后台静默重拉：令牌有效且仍在该页时才可能更新画面（重拉前清窗口取最新）。 */
    async _refreshCatPage(token, tid, pg, size) {
        try {
            const before = JSON.stringify(this._catItems.map((v) => v.vod_id));
            this._catWinDelete(this.site, tid); // 丢弃合并窗口，重新拉取最新
            await this._fetchCat(tid, pg, size);
            if (token !== this._loadToken || this.mode !== 'category' || this.tid !== tid || this.page !== pg) return;
            if (JSON.stringify(this._catItems.map((v) => v.vod_id)) !== before) this.renderGrid(this._catItems, this._catError);
            this.renderPager();
        } catch (e) { /* 刷新失败不影响缓存展示 */ }
    },

    // ------------------------------------------------------------ 页缓存（LRU）

    _cacheMap() {
        if (!this._pageCache) this._pageCache = new Map();
        return this._pageCache;
    },

    /** 命中同时把条目移到队尾（LRU）；未命中返回 null。 */
    _cacheGet(site, tid, pg) {
        const m = this._cacheMap();
        const key = site + '|' + tid;
        const e = m.get(key);
        if (!e || !e.pages.has(pg)) return null;
        m.delete(key); m.set(key, e);
        return { list: e.pages.get(pg), pagecount: e.pagecount };
    },

    /** 写入页缓存：每分类最多 10 页、全局最多 32 个分类，超限淘汰最旧。 */
    _cachePut(site, tid, pg, list, pagecount) {
        const m = this._cacheMap();
        const key = site + '|' + tid;
        let e = m.get(key);
        if (e) m.delete(key);
        else e = { pagecount: 1, pages: new Map() };
        e.pagecount = pagecount;
        e.pages.set(pg, list);
        if (e.pages.size > 10) e.pages.delete(e.pages.keys().next().value);
        m.set(key, e);
        if (m.size > 32) m.delete(m.keys().next().value);
    },

    _cacheDropPage(site, tid, pg) {
        const e = this._cacheMap().get(site + '|' + tid);
        if (e) e.pages.delete(pg);
    },

    _cacheDropSite(site) {
        const m = this._cacheMap();
        for (const k of Array.from(m.keys())) {
            if (k.indexOf(site + '|') === 0) m.delete(k);
        }
        // 合并窗口同样按 site 清理
        for (const k of Array.from(this._catWin.keys())) {
            if (k.indexOf(site + '|') === 0) this._catWin.delete(k);
        }
    },

    // ------------------------------------------------------------ 分类合并窗口（T75）

    /** 取 site|tid 的源页合并窗口（懒建 + LRU：命中移到队尾，超 32 分类淘汰最旧）。 */
    _catWinGet(site, tid) {
        const key = site + '|' + tid;
        let w = this._catWin.get(key);
        if (!w) {
            w = { items: [], seen: new Set(), sourcePg: 0, total: 0, perPage: 20 };
            this._catWin.set(key, w);
            if (this._catWin.size > 32) this._catWin.delete(this._catWin.keys().next().value);
        } else {
            this._catWin.delete(key); this._catWin.set(key, w);
        }
        return w;
    },

    /** 删除指定 site|tid 的合并窗口（强制刷新时丢弃重拉）。 */
    _catWinDelete(site, tid) {
        this._catWin.delete(site + '|' + tid);
    },

    /**
     * T77：作废分类内容缓存（页缓存 + 合并窗口）。配置重载/源变更/改每页条数后调用，
     * 使「回到页面立即生效」，无需手动刷新。
     */
    invalidatePageCaches() {
        this._pageCache = null;
        this._catWin = new Map();
        this._pageSizeDirty = true; // 标记：回到首页视图时按新条数重载（T80）
    },

    /**
     * T80：回到首页视图时调用——设置里改过每页条数则按当前模式用新条数重载，
     * 无需手动切换页面/点刷新。
     */
    onViewShown() {
        if (!this._pageSizeDirty) return;
        this._pageSizeDirty = false;
        if (this.mode === 'category') this.loadCategory(this.tid, this.page || 1);
        else if (this.mode === 'search') this.searchCurrent(this.page || 1);
        else this.loadHome(this.page || 1);
    },

    /** 当前源搜索：走站点自身 searchContent（CMS 源 wd 参数），仅搜当前选中源。
     *  支持真分页（pg 参数）；输入清空后回车回到首页推荐位。 */
    async searchCurrent(pg) {
        const wd = String($('#home-search').val() || '').trim();
        if (!wd) { if (this.mode === 'search') this.loadHome(); return; }
        if (!this.site) return;
        const busy = this._configBusyText();
        if (busy) { warnToast(busy); return; } // 恢复窗口期：搜索必然落空，保留当前内容
        const freshSearch = this.mode !== 'search' || this.searchWord !== wd; // 从其他模式进入/换词 = 新一轮搜索
        this.mode = 'search';
        this.searchWord = wd;
        this.page = pg || 1;
        const token = ++this._loadToken;
        showLoading();
        try {
            const size = await this._pageSize();
            const data = await doAction('searchContent', { site: this.site, word: wd, quick: '0', pg: String(this.page) });
            if (token !== this._loadToken) return;
            if (actionResponseFailed(data)) {
                // 失败包络（源故障/超时）≠「未找到」：不能把页面翻成误导性的空结果
                $('#home-class .class-tab').removeClass('active');
                $('#home-grid').html('<div class="tip-line">源暂不可用，请稍后重试</div>');
                $('#home-pager').empty();
                return;
            }
            $('#home-class .class-tab').removeClass('active');
            const raw = (data && data.list) || [];
            const pc = parseInt(data && data.pagecount, 10);
            if (pc > 0) this.pagecount = pc;
            else if (!raw.length) this.pagecount = Math.max(1, this.page - 1);
            else {
                // 源不返回 pagecount（CMS/多数 jar 源）：以「本页是否出现新条目」判断能否继续翻页。
                // 伪分页源每页返回同一批结果时页码立即停止增长，避免分页器页码无限增加；
                // 换词/换源/重新搜索时重置已见记录。
                const key = this.site + '|' + wd;
                if (freshSearch || !this._searchSeen || this._searchSeen.key !== key) {
                    this._searchSeen = { key, ids: new Set(), maxFresh: 0 };
                    this.pagecount = 1; // 新一轮搜索丢弃旧页码，防残留巨值
                }
                const ids = this._searchSeen.ids;
                let added = 0;
                raw.forEach((v) => {
                    if (v && v.vod_id != null && !ids.has(v.vod_id)) { ids.add(v.vod_id); added++; }
                });
                if (added) {
                    if (this.page > this._searchSeen.maxFresh) this._searchSeen.maxFresh = this.page;
                    this.pagecount = Math.max(this.pagecount || 1, this.page + 1);
                } else {
                    // 无新增：页码钉在「最后有内容的页 + 1」，不随当前页增长，回看也不回缩
                    this.pagecount = Math.max(this.pagecount || 1, this._searchSeen.maxFresh + 1);
                }
            }
            const list = raw.slice(0, size);
            if (list.length) this.renderGrid(list);
            else $('#home-grid').html(`<div class="tip-line">当前源未找到与「${escHtml(wd)}」相关的内容</div>`);
            this.renderPager();
        } catch (e) {
            warnToast('搜索失败');
        } finally {
            hideLoading();
        }
    },

    renderClass(activeTid) {
        const box = $('#home-class').empty();
        // 关闭自动检测时不应用历史分类空态结果，避免“关了开关但分类仍被隐藏”。
        const emptySet = this._autoProbeEnabled ? (this._emptyCls[this.site] || null) : null;
        // T65：分类标签拼串一次性写入（替代逐个 append）
        const tabs = [`<span class="class-tab ${activeTid === '' ? 'active' : ''}" data-tid="">全部</span>`];
        this.classes.forEach((c) => {
            const tidStr = String(c.type_id != null ? c.type_id : '');
            // T60：探测确认为空（无影片）的分类不显示；当前激活分类除外，避免选中项消失
            if (emptySet && emptySet.has(tidStr) && String(c.type_id) !== String(activeTid)) return;
            tabs.push(`<span class="class-tab ${activeTid === c.type_id ? 'active' : ''}" data-tid="${escHtml(c.type_id)}">${escHtml(c.type_name)}</span>`);
        });
        box.html(tabs.join(''));
    },

    /** 当前选中源的空分类探测入口（loadHome 触发）。 */
    async _probeClasses() {
        await this._probeClassesFor(this.site, this.classes.slice());
    },

    /**
     * T60：后台探测指定源的各分类是否有影片，空分类从分类栏隐藏（并发 6，出错保留分类）。
     * 加固：①结果不随 token/换源丢弃——按 site 键隔离记录，中断/换源不丢进度，
     * 任一轮完整探测即全部分类；unclassified===0 才标记完成，出错留待下次载入重试
     * ②首次全量探测（含上次持久化判空的分类，内容可能已恢复），重试只探测未知状态分类
     * ③结果持久化 localStorage（yuki_home_empty_classes），再次载入该源首屏即过滤、无闪现
     * ④仅在仍停留在该源时重渲分类栏，避免覆盖其他源的栏。
     */
    async _probeClassesFor(site, cls) {
        if (!this._autoProbeEnabled) return;
        if (this._clsProbed[site] || this._clsBusy[site]) return;
        if (!cls.length) return;
        if (!this._okCls[site]) this._okCls[site] = new Set();
        if (!this._emptyCls[site]) this._emptyCls[site] = new Set();
        const okSet = this._okCls[site];
        const emptySet = this._emptyCls[site];
        this._clsBusy[site] = true;
        try {
            let pending;
            if (this._clsStarted[site]) {
                pending = cls.filter((c) => {
                    const t = String(c.type_id != null ? c.type_id : '');
                    return !okSet.has(t) && !emptySet.has(t);
                });
                if (!pending.length) {
                    // 数据新鲜且分类齐全：无需重复探测，直接确认完成并刷新时间戳
                    this._clsProbed[site] = true;
                    this._clsTs[site] = Date.now();
                    this._persistEmptyClasses();
                    return;
                }
            } else {
                this._clsStarted[site] = true;
                pending = cls;
            }
            let changed = false;
            let unclassified = 0; // 出错未判定的分类数：有出错则本次不标记完成，下次载入重试
            let idx = 0;
            const probeOne = async (c) => {
                const tid = String(c.type_id != null ? c.type_id : '');
                try {
                    const d = await doAction('categoryContent', { site, tid, pg: '1', filter: 'false', extend: '{}' });
                    // 失败包络（spider 异常/超时）≠ 空分类：不判空也不判有内容，留给重试，
                    // 避免把实际有影片的分类从分类栏误隐藏
                    if (actionResponseFailed(d)) { unclassified++; }
                    // 结果按 site 键隔离记录，不随 token/当前站点变化丢弃（中断不丢进度）
                    else if (((d && d.list) || []).length) {
                        okSet.add(tid);
                        if (emptySet.delete(tid)) changed = true; // 曾判空、现恢复内容 → 重新显示
                    } else if (!emptySet.has(tid)) {
                        emptySet.add(tid); changed = true;
                    }
                } catch (e) { unclassified++; } // 出错不判空也不判有内容，留给重试
            };
            const worker = async () => { while (idx < pending.length) { await probeOne(pending[idx++]); } };
            await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker));
            this._persistEmptyClasses(); // 落盘（含中断前的部分确认，下次启动也有收获）
            if (unclassified === 0) {
                this._clsProbed[site] = true; // 全部分类确认后才标记完成
                this._clsTs[site] = Date.now(); // 刷新新鲜期
            }
            // 仅在仍停留该源时重渲分类栏（保持当前激活项），避免覆盖其他源的栏
            if (this.site === site && changed) this.renderClass(this.mode === 'category' ? this.tid : '');
        } finally {
            this._clsBusy[site] = false;
        }
    },

    /**
     * T60：后台为所有未探测分类的源补齐类别空态探测（站点级并发 2，轻量慢跑），
     * 使切换任意源时即可直接过滤空分类、无闪现；结果逐源落盘持久化。
     * 配置重载（源集合变更）后本轮作废，由 loadSites 重新发起。
     */
    async _probeAllClasses() {
        if (!this._autoProbeEnabled || this._probingAll || !this._allSites.length) return;
        this._probingAll = true;
        const token = this._probeToken;
        let started = false; // 进度条是否计入本轮（T81）
        try {
            const pending = this.sites.filter((s) => {
                if (this._clsProbed[s.key] || this._clsBusy[s.key]) return false;
                // 数据新鲜（TTL 内已完整探测）跳过，避免每次启动全量重探；过期/缺失才补探
                if (this._clsTs[s.key] && (Date.now() - this._clsTs[s.key]) < EMPTY_CLS_TTL) return false;
                return true;
            });
            if (!pending.length) return;
            started = this._startProbe(pending.length);
            let idx = 0;
            const sweepOne = async (site) => {
                try {
                    const d = await doAction('homeContent', { site: site.key, filter: 'false' });
                    if (token !== this._probeToken) return; // 配置已重载，旧结果作废
                    const cls = (d && d.class) || [];
                    if (cls.length && !this._clsProbed[site.key]) await this._probeClassesFor(site.key, cls);
                } catch (e) { /* 单源探测失败跳过，切到该源时再补探 */ }
                this._probeOneDone(); // T81：单个源分类探测完成
            };
            const worker = async () => { while (idx < pending.length) { await sweepOne(pending[idx++]); } };
            await Promise.all(Array.from({ length: Math.min(2, pending.length) }, worker));
        } finally {
            this._probingAll = false;
            if (started) this._endProbe(); // T81：一段探测完成
        }
    },

    /** 空分类探测结果持久化：从 localStorage 载入（含时间戳与有内容分类）。
     *  数据新鲜（EMPTY_CLS_TTL 内）则置 _clsStarted[site]，首次探测只补未知分类；
     *  过期/缺失则重新全量探测。兼容旧格式 { site: [tids] }（视为过期）。 */
    _loadPersistedEmptyClasses() {
        try {
            const raw = localStorage.getItem('yuki_home_empty_classes');
            if (!raw) return;
            const data = JSON.parse(raw);
            for (const site of Object.keys(data)) {
                const v = data[site];
                const isNew = v && typeof v === 'object' && !Array.isArray(v);
                const ts = isNew ? (v.ts || 0) : 0;
                const empty = isNew ? (v.empty || []) : v || [];
                const ok = isNew ? (v.ok || []) : [];
                if (Array.isArray(empty) && empty.length) this._emptyCls[site] = new Set(empty);
                if (Array.isArray(ok) && ok.length) this._okCls[site] = new Set(ok);
                this._clsTs[site] = ts;
                if (Date.now() - ts < EMPTY_CLS_TTL) this._clsStarted[site] = true; // 新鲜：首次只探未知
            }
        } catch (e) { /* 损坏数据忽略，重新探测 */ }
    },

    /** 空分类探测结果持久化：写入 localStorage（空/有内容分类 + 探测时间戳）。 */
    _persistEmptyClasses() {
        try {
            const out = {};
            for (const site of Object.keys(this._emptyCls)) {
                const empty = this._emptyCls[site] ? Array.from(this._emptyCls[site]) : [];
                const ok = this._okCls[site] ? Array.from(this._okCls[site]) : [];
                if (empty.length || ok.length) out[site] = { ts: Date.now(), empty, ok };
            }
            localStorage.setItem('yuki_home_empty_classes', JSON.stringify(out));
        } catch (e) { /* 持久化失败不影响主流程 */ }
    },

    /** 空分类探测结果持久化：清空（源集合变更时调用）。 */
    _clearPersistedEmptyClasses() {
        try { localStorage.removeItem('yuki_home_empty_classes'); } catch (e) { /* ignore */ }
    },

    renderGrid(list, error) {
        const grid = $('#home-grid').empty();
        if (!list.length) {
            const why = error ? `（${errorTextOf(error, 100)}）` : '';
            grid.html(`<div class="tip-line">暂无内容${why}</div>`);
            return;
        }
        // T65：拼串一次性写入，替代逐条 append（减少 N 次 DOM 重排）
        grid.html(list.map((v) => vodCard(v, this.site)).join(''));
        // T74 收尾：按当前列宽把标题 JS 截到恰好两行（DOM 不保留超行文字）
        fitVodTitles(grid);
        this._fillCovers();
    },

    /** 统一分页器（common.js renderPagerBox）：搜索/分类模式共用，跳页回调按模式分发。 */
    renderPager() {
        renderPagerBox($('#home-pager'), {
            page: this.page,
            pagecount: this.pagecount,
            onJump: (pg) => {
                if (this.mode === 'search') this.searchCurrent(pg);
                else if (this.mode === 'home') this.loadHome(pg); // 「全部」翻页（T76）
                else this.loadCategory(this.tid, pg);
            },
        });
    },
};

// 复用于 search.js 的卡片渲染（封面标签由 common.js vodCoverImg 统一生成，T31；
// src 参数写入 data-source 供 T42 封面补拉定位源；eager=true 封面立即加载，T59）
function vodCard(v, src, eager) {
    const name = String(v.vod_name || '');
    return `<div class="vod-card" data-id="${escHtml(v.vod_id)}" data-name="${escHtml(name)}"${src != null ? ` data-source="${escHtml(src)}"` : ''} tabindex="0">
        <div class="vod-cover">${vodCoverImg(v.vod_pic, eager)}</div>
        <div class="vod-name" title="${escHtml(name)}">${escHtml(truncateTitle(name))}</div>
        <div class="vod-remarks">${escHtml(v.vod_remarks || '')}</div>
    </div>`;
}

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.home = Home;
}(typeof window !== 'undefined' ? window : globalThis));
