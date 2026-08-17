/**
 * home.js — 首页（Phase 2）
 *
 * 数据链路：GET /sites 取站点列表 → doAction('homeContent', {site}) 取
 * 分类(class)与推荐位(list) → 点分类走 categoryContent 分页。
 * 卡片点击交给 Detail.open()。
 */
/* global $, doAction, getJson, escHtml, normalizePic, warnToast, showLoading, hideLoading, Detail, renderPagerBox, pageSizeOf, fillMissingCovers, fitVodTitles, renderStatusBar, localCacheGet, localCacheSet */

// T60：分类空态探测结果新鲜期（该源上次探测完成后在此窗口内不再重复探测，防每次启动全量重探）
const EMPTY_CLS_TTL = 24 * 3600 * 1000;
// 站点列表 / 首页分类(class) 本地缓存：冷启动先用缓存即时渲染源下拉与分类标签，后台再拉网络刷新。
// 站点列表变动不频繁（配置载入才变），分类结构基本稳定，故用较宽 TTL；数据以网络结果为准（命中仅提前上屏）。
const SITES_CACHE_KEY = 'home::sites::v1';
const SITES_CACHE_TTL = 30 * 60 * 1000;              // 站点列表 30 分钟
const HOME_CLASS_CACHE_PREFIX = 'home::class::v1::'; // + site → 该源分类标签列表
const HOME_CLASS_CACHE_TTL = 30 * 60 * 1000;         // 首页分类 30 分钟
// 首页「全部」feed 持久化缓存：冷启动网络返回前先以旧内容上屏（TTL 30 分钟）
const HOME_FEED_CACHE_PREFIX = 'home::feed::v1::';   // + site → { ts, pagecount, items[] }
const HOME_FEED_CACHE_TTL = 30 * 60 * 1000;

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
    _pageSizeDirty: false, // 每页条数在设置里被改过：回到首页视图时按新条数自动重载（T80）
    _loadToken: 0, // 加载令牌：切源/切分类后旧拉取自动作废
    _probeToken: 0, // 探测世代：源集合变更（配置重载）后旧探测结果作废
    _emptyCls: {},   // T60：site → Set<空分类 type_id>（探测确认无影片的分类，持久化）
    _clsProbed: {},  // T60：site → 本会话完整探测是否已完成（同源只探一次）
    _okCls: {},      // T60：site → Set<tid> 已确认有内容的分类（持久化；重试跳过）
    _clsBusy: {},    // T60：site → 探测在途（防并发重复探测）
    _clsStarted: {}, // T60：site → 已发起首次探测（或从持久化载入且数据新鲜），之后只探未知分类
    _clsTs: {},      // T60：site → 上次完整探测完成的时间戳（EMPTY_CLS_TTL 内不重复探测）
    _probingAll: false, // T60：全源后台探测是否在途（防并发重复扫描）
    _probeBar: null,    // T81：首页探测进度条 { total, done, active, shown, showTimer, doneTimer }

    async init() {
        if (this._inited) return;
        this._inited = true;
        $('#site-select').on('change', () => {
            this._cacheDropSite(this.site); // 切源时清理旧源的页缓存
            this.site = $('#site-select').val();
            this.loadHome();
        });
        // 窗口拉伸放大：卡片数不够铺满时自动补拉（防抖）
        $(window).on('resize', () => {
            clearTimeout(this._resizeT);
            this._resizeT = setTimeout(() => this._onResize(), 400);
        });
        $('#home-refresh').on('click', () => {
            if (this.mode === 'home') this.loadHome(this.page || 1);
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
        this._prerenderFromCache();        // 冷启动即时上屏：网络返回前先用缓存渲染源下拉 + 分类标签
        await this.loadSites();
    },

    /** 冷启动即时上屏：用本地缓存的站点列表 + 当前源分类标签预渲染，避免等 /sites & homeContent 网络。
     *  仅在尚无数据时填充；loadSites/loadHome 网络返回后会以最新结果覆盖（缓存只提前呈现骨架）。 */
    _prerenderFromCache() {
        if (typeof localCacheGet !== 'function') return;
        try {
            const sites = localCacheGet(SITES_CACHE_KEY);
            if (Array.isArray(sites) && sites.length && !this._allSites.length) {
                this._allSites = sites;
                this.sites = sites.slice();
                if (!this.site || !this.sites.some((s) => s.key === this.site)) this.site = this.sites[0].key;
                this._renderSiteSelect();
                $('#site-select').val(this.site);
                const cls = this._loadClassCache(this.site);
                if (Array.isArray(cls) && cls.length) { this.classes = cls; this.renderClass(''); }
            }
        } catch (e) { /* 预渲染失败不影响正常网络加载 */ }
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
        // T77：配置/源集合变更 → 作废分类内容缓存（页缓存 + 合并窗口），回到页面立即生效
        this.invalidatePageCaches();
        let all = [];
        try {
            const st = await getJson('/sites');
            all = (st && st.sites) || [];
        } catch (e) { all = []; }
        // 网络成功且非空时刷新站点列表缓存（空结果不覆盖，防后端瞬时异常清掉可用缓存）
        if (all.length && typeof localCacheSet === 'function') {
            try { localCacheSet(SITES_CACHE_KEY, all, SITES_CACHE_TTL); } catch (e) { /* 缓存失败忽略 */ }
        }
        // 网络失败（all 空）时：若已有缓存预渲染的站点，保留其展示，不重置探测/屏蔽、不清空页面
        // （否则冷启动预渲染 + 瞬时网络异常会误清 blockedSites 并显示「尚未载入配置」）。
        if (!all.length && this._allSites.length) {
            return;
        }
        // 源集合变更（配置自动重载后 key 集不同，多仓漂移常见）：旧探测/屏蔽记录
        // 不再适用。但**保留全部持久化状态**（probedSites/blockedSites/空分类结果
        // 及其内存镜像 _emptyCls/_okCls/_clsTs/_clsStarted）：它们按源 key 复用——
        // 已探测/已屏蔽的 key 直接跳过（24h 新鲜期内零网络请求），仅新出现的 key
        // 需要探测。此前每次 sig 变化都清空记录，导致多仓每次返回不同仓时每次
        // 重启全量重探，且用户手动屏蔽的源被悄悄恢复（T25 的顾虑由「新 key 自然
        // 全探」满足，无需清空旧记录）。
        const sig = all.map((s) => s.key).join('|');
        if (this._allSites.length && sig !== this._allSites.map((s) => s.key).join('|')) {
            this._probeToken++; // 进行中的旧探测写入前校验世代，结果丢弃
            this._probing = false; // 释放锁，允许对新集合重新发起探测
            this._clsProbed = {};
            this._clsBusy = {};
            this._probingAll = false; // 全源探测在途锁随源集合变更释放
        }
        this._allSites = all;
        const blocked = await this._getBlocked();
        this.sites = all.filter((s) => blocked.indexOf(s.key) < 0);
        this._renderSiteSelect();
        if (!this.sites.length) {
            $('#home-class').empty();
            $('#home-grid').html('<div class="tip-line">尚未载入任何配置。请到“设置 → 源设置”，粘贴配置 URL 或 JSON 后点“载入配置”。</div>');
            $('#home-pager').empty();
            return;
        }
        if (!this.sites.some((s) => s.key === this.site)) this.site = this.sites[0].key;
        $('#site-select').val(this.site);
        await this.loadHome();
        // 首屏就绪后后台探测未探测过的源，自动屏蔽无内容源
        this._probeSites();
        // T60：后台为所有源补齐分类空态探测（切换任意源即可直接过滤空分类）
        this._probeAllClasses();
    },

    _renderSiteSelect() {
        const sel = $('#site-select').empty();
        if (!this.sites.length) {
            sel.append('<option value="">（无站点 · 请先在设置→源设置载入）</option>');
            return;
        }
        // T65：站点选项拼串一次性写入
        sel.append(this.sites.map((s) => `<option value="${escHtml(s.key)}">${escHtml(s.name || s.key)}</option>`).join(''));
    },

    async _getBlocked() {        try {
            const s = (await window.vpc.settingsGet()) || {};
            return Array.isArray(s.blockedSites) ? s.blockedSites : [];
        } catch (e) { return []; }
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

    /**
     * 后台探测无内容源：homeContent 推荐位有内容 → 通过；推荐位空则
     * 逐个检查分类（T40：任一分类有资源即视为可用，不屏蔽；全部分类
     * 为空或出错才记入 blockedSites）。并发 4，只探测未探测过的源，
     * 结果持久化（可在源配置里恢复）。
     */
    async _probeSites() {
        if (this._probing || !this._allSites.length) return;
        this._probing = true;
        const token = this._probeToken; // 写入前校验：期间配置重载换源则丢弃本轮结果
        let started = false; // 进度条是否计入本轮（T81）
        try {
            const s = (await window.vpc.settingsGet()) || {};
            const probed = {};
            (Array.isArray(s.probedSites) ? s.probedSites : []).forEach((k) => { probed[k] = 1; });
            const blocked = new Set(Array.isArray(s.blockedSites) ? s.blockedSites : []);
            const before = blocked.size; // toast 只报本轮新增屏蔽数，不含历史累计
            const pending = this._allSites.filter((x) => !probed[x.key]);
            if (!pending.length) return;
            started = this._startProbe(pending.length);
            let idx = 0, changed = false;
            const probeOne = async (site) => {
                probed[site.key] = 1;
                let ok = false;
                try {
                    const d = await doAction('homeContent', { site: site.key, filter: 'false' }, null, 60000);
                    // T40 放宽：首页推荐位有内容，或配置了分类结构（class 非空）即视为可用。
                    // 分类探测易受站点临时故障/蜘蛛内部错误误伤（如 Bili 系分类接口风控），
                    // 不再仅因分类为空或出错就自动屏蔽；失效源由用户手动屏蔽或换源。
                    const hasList = ((d && d.list) || []).length > 0;
                    const hasClass = Array.isArray(d && d.class) && d.class.length > 0;
                    if (hasList || hasClass) {
                        ok = true;
                    } else {
                        // 无 list 且无 class：逐个分类再确认（兼容依赖分类内容的源）
                        const cls = (d && d.class) || [];
                        for (let i = 0; i < cls.length && !ok; i++) {
                            const tid = String(cls[i].type_id != null ? cls[i].type_id : '');
                            try {
                                const c = await doAction('categoryContent', {
                                    site: site.key, tid, pg: '1', filter: 'false', extend: '{}',
                                }, null, 60000);
                                if (((c && c.list) || []).length) ok = true;
                            } catch (e) { /* 该分类出错跳过，继续看其他分类 */ }
                        }
                    }
                } catch (e) { /* 推荐位获取失败视为无内容，继续按分类判断 */ }
                if (!ok) { blocked.add(site.key); changed = true; }
                this._probeOneDone(); // T81：单个源探测完成
            };
            const worker = async () => {
                while (idx < pending.length) { await probeOne(pending[idx++]); }
            };
            await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
            if (token !== this._probeToken) return; // 源集合已换（配置重载），旧结果不再适用
            await window.vpc.settingsSet('probedSites', Object.keys(probed));
            if (changed) {
                await window.vpc.settingsSet('blockedSites', Array.from(blocked));
                // 刷新下拉（不打断当前选中源）；当前源被屏蔽则切到第一个可用源
                const cur = this.site;
                this.sites = this._allSites.filter((x) => !blocked.has(x.key));
                this._renderSiteSelect();
                if (this.sites.length && !this.sites.some((x) => x.key === cur)) {
                    this._cacheDropSite(cur); // 程序切源同样清理旧源缓存
                    this.site = this.sites[0].key;
                    $('#site-select').val(this.site);
                    this.loadHome();
                } else if (this.sites.length) {
                    $('#site-select').val(cur);
                }
                warnToast(`已自动屏蔽 ${blocked.size - before} 个无内容源（可在源配置里恢复）`);
            }
        } catch (e) { /* 探测异常不影响主流程 */ } finally {
            this._probing = false;
            if (started) this._endProbe(); // T81：一段探测完成
        }
    },

    /**
     * 「全部」标签：所有页统一用源总览内容 feed（homeVideoContent，跨分类最新/全部），
     * 合并源页填满每页条数、可一直翻页（T76/T78：第 1 页也走 feed，保证严格按设置条数显示）。
     * 源不支持 homeVideoContent（feed 空）时，第 1 页回退自适应首页（推荐位 + 分类铺满）。
     */
    async loadHome(pg) {
        if (!this.site) return;
        this.mode = 'home';
        this.tid = '';
        this.page = pg || 1;
        this._pageSizeDirty = false; // 完整重载后清除脏标记
        $('#home-search').val(''); // 退出搜索态
        const token = ++this._loadToken;
        const size = await this._pageSize();
        if (token !== this._loadToken) return;
        $('#home-pager').empty();
        showLoading();
        try {
            // 冷启动即时上屏：先用缓存的分类标签渲染（避免空标签栏闪现），网络返回后以最新结果覆盖
            const cachedCls = this._loadClassCache(this.site);
            if (cachedCls && cachedCls.length && !this.classes.length) {
                this.classes = cachedCls;
                this.renderClass('');
            }
            // 首屏并行：homeContent（分类+推荐位）与「全部」feed 同时发起，
            // feed 先返回时先渲染，分类返回后再刷新分类栏（T77 并行提速）
            const [data, feedItems] = await Promise.all([
                doAction('homeContent', { site: this.site, filter: 'false' }),
                this._fetchHomeFeed(this.page, size),
            ]);
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
        this._probeClasses();
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
        if (pg === 1 && !this._catWin.has(site + '|__all__') && !this._homeCacheBooted) {
            const boot = this._cacheHomeGet(site);
            if (boot && boot.items.length) {
                this._homeList = boot.items.slice(0, size);
                if (boot.pagecount > 0) this.pagecount = boot.pagecount;
                this.renderGrid(this._homeList);
                this.renderPager();
            }
            this._homeCacheBooted = true; // 只引导一次（网络返回后以最新覆盖）
        }
        const win = this._catWinGet(site, '__all__');
        const need = pg * size; // 累计需覆盖到该页末尾
        let guard = 0;
        while (win.items.length < need && guard++ < 200) {
            const data = await doAction('homeVideoContent', { site, pg: String(win.sourcePg + 1) });
            if (token !== this._loadToken || site !== this.site) return; // M-30b：切源即中止
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
        const emptySet = this._emptyCls[this.site] || null;
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
     * ③结果持久化 localStorage（vpc_home_empty_classes），再次载入该源首屏即过滤、无闪现
     * ④仅在仍停留在该源时重渲分类栏，避免覆盖其他源的栏。
     */
    async _probeClassesFor(site, cls) {
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
                    // 结果按 site 键隔离记录，不随 token/当前站点变化丢弃（中断不丢进度）
                    if (((d && d.list) || []).length) {
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
        if (this._probingAll || !this._allSites.length) return;
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
            const raw = localStorage.getItem('vpc_home_empty_classes');
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
            localStorage.setItem('vpc_home_empty_classes', JSON.stringify(out));
        } catch (e) { /* 持久化失败不影响主流程 */ }
    },

    /** 空分类探测结果持久化：清空（源集合变更时调用）。 */
    _clearPersistedEmptyClasses() {
        try { localStorage.removeItem('vpc_home_empty_classes'); } catch (e) { /* ignore */ }
    },

    renderGrid(list, error) {
        const grid = $('#home-grid').empty();
        if (!list.length) {
            const why = error ? `（${String(error).slice(0, 100)}）` : '';
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
    root.VPC = root.VPC || {};
    root.VPC.home = Home;
}(typeof window !== 'undefined' ? window : globalThis));
