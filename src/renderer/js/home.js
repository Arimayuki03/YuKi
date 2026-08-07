/**
 * home.js — 首页（Phase 2）
 *
 * 数据链路：GET /sites 取站点列表 → doAction('homeContent', {site}) 取
 * 分类(class)与推荐位(list) → 点分类走 categoryContent 分页。
 * 卡片点击交给 Detail.open()。
 */
/* global $, doAction, getJson, escHtml, normalizePic, warnToast, showLoading, hideLoading, Detail, listPageSize, renderPagerBox */

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
    _loadToken: 0, // 加载令牌：切源/切分类后旧拉取自动作废

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
            if (this.mode === 'home') this.loadHome();
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
        await this.loadSites();
    },

    async loadSites() {
        let all = [];
        try {
            const st = await getJson('/sites');
            all = (st && st.sites) || [];
        } catch (e) { all = []; }
        this._allSites = all;
        const blocked = await this._getBlocked();
        this.sites = all.filter((s) => blocked.indexOf(s.key) < 0);
        this._renderSiteSelect();
        if (!this.sites.length) {
            $('#home-class').empty();
            $('#home-grid').html('<div class="tip-line">尚未载入任何配置。请到“工具面板 → 源配置”，粘贴配置 URL 或 JSON 后点“载入配置”。</div>');
            $('#home-pager').empty();
            return;
        }
        if (!this.sites.some((s) => s.key === this.site)) this.site = this.sites[0].key;
        $('#site-select').val(this.site);
        await this.loadHome();
        // 首屏就绪后后台探测未探测过的源，自动屏蔽无内容源
        this._probeSites();
    },

    _renderSiteSelect() {
        const sel = $('#site-select').empty();
        if (!this.sites.length) {
            sel.append('<option value="">（无站点 · 请先在工具面板→源配置载入）</option>');
            return;
        }
        this.sites.forEach((s) => sel.append(`<option value="${escHtml(s.key)}">${escHtml(s.name || s.key)}</option>`));
    },

    async _getBlocked() {
        try {
            const s = (await window.vpc.settingsGet()) || {};
            return Array.isArray(s.blockedSites) ? s.blockedSites : [];
        } catch (e) { return []; }
    },

    /**
     * 后台探测无内容源：homeContent 推荐位有内容 → 通过；推荐位空则
     * 复查首个分类 categoryContent；仍为空或出错 → 记入 blockedSites。
     * 并发 4，只探测未探测过的源，结果持久化（可在源配置里恢复）。
     */
    async _probeSites() {
        if (this._probing || !this._allSites.length) return;
        this._probing = true;
        try {
            const s = (await window.vpc.settingsGet()) || {};
            const probed = {};
            (Array.isArray(s.probedSites) ? s.probedSites : []).forEach((k) => { probed[k] = 1; });
            const blocked = new Set(Array.isArray(s.blockedSites) ? s.blockedSites : []);
            const before = blocked.size; // toast 只报本轮新增屏蔽数，不含历史累计
            const pending = this._allSites.filter((x) => !probed[x.key]);
            if (!pending.length) return;
            let idx = 0, changed = false;
            const probeOne = async (site) => {
                probed[site.key] = 1;
                let ok = false;
                try {
                    const d = await doAction('homeContent', { site: site.key, filter: 'false' });
                    if (((d && d.list) || []).length) ok = true;
                    else {
                        const cls = (d && d.class) || [];
                        if (cls.length) {
                            const tid = String(cls[0].type_id != null ? cls[0].type_id : '');
                            const c = await doAction('categoryContent', {
                                site: site.key, tid, pg: '1', filter: 'false', extend: '{}',
                            });
                            if (((c && c.list) || []).length) ok = true;
                        }
                    }
                } catch (e) { /* 探测失败视为无内容 */ }
                if (!ok) { blocked.add(site.key); changed = true; }
            };
            const worker = async () => {
                while (idx < pending.length) { await probeOne(pending[idx++]); }
            };
            await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
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
        }
    },

    async loadHome() {
        if (!this.site) return;
        this.mode = 'home';
        this.tid = '';
        this.pagecount = 1;
        $('#home-search').val(''); // 退出搜索态
        const token = ++this._loadToken;
        showLoading();
        try {
            const data = await doAction('homeContent', { site: this.site, filter: 'false' });
            this.classes = (data && data.class) || [];
            this.renderClass('');
            // 推荐位通常只有 ~20 条：先展示首屏，后台再逐页补充分类内容铺满
            this._homeList = ((data && data.list) || []).slice();
            this._fillTid = this.classes.length
                ? String(this.classes[0].type_id != null ? this.classes[0].type_id : '')
                : '';
            this._fillPg = 0;
            this._fillSeen = {};
            this._homeList.forEach((v) => { this._fillSeen[v.vod_id + '|' + v.vod_name] = 1; });
            this.renderGrid(this._homeList);
            $('#home-pager').empty();
        } catch (e) {
            warnToast('首页载入失败');
        } finally {
            hideLoading();
        }
        // 渐进填充：不阻塞首屏，避免转圈时间过长
        this._extendHome(token);
    },

    /** 估算铺满可视区需要的卡片数（列数×行数，下限 36 上限 120，控制单次拉取总量）。 */
    _adaptiveTarget() {
        try {
            const grid = document.getElementById('home-grid');
            const w = (grid && grid.clientWidth) || window.innerWidth;
            const top = grid ? grid.getBoundingClientRect().top : 0;
            // 列宽 140 + 间距 16；行高 ≈ 封面 + 两行文字 ≈ 285
            const cols = Math.max(3, Math.floor((w + 16) / 156));
            const rows = Math.max(3, Math.ceil((window.innerHeight - top + 285) / 285));
            return Math.min(120, Math.max(36, cols * rows));
        } catch (e) { return 36; }
    },

    /** 逐页拉首个分类内容去重追加，每拉到一批立即增量渲染（上限 3 页）。 */
    async _extendHome(token) {
        if (!this._fillTid) return;
        let guard = 0;
        while (this._homeList.length < this._adaptiveTarget()
            && this._fillPg < 3 && guard++ < 3) {
            this._fillPg += 1;
            let items = [];
            try {
                const data = await doAction('categoryContent', {
                    site: this.site, tid: this._fillTid, pg: String(this._fillPg), filter: 'false', extend: '{}',
                });
                items = (data && data.list) || [];
            } catch (e) { break; }
            if (token !== this._loadToken) return; // 已切源/切分类，旧拉取作废
            if (!items.length) break;
            const fresh = [];
            items.forEach((v) => {
                const k = v.vod_id + '|' + v.vod_name;
                if (!this._fillSeen[k]) { this._fillSeen[k] = 1; this._homeList.push(v); fresh.push(v); }
            });
            if (fresh.length) this._appendGrid(fresh);
        }
    },

    /** 增量追加卡片（渐进加载；列表为“暂无内容”占位时先清掉）。 */
    _appendGrid(items) {
        const grid = $('#home-grid');
        if (grid.children('.tip-line').length) grid.empty();
        items.forEach((v) => grid.append(vodCard(v)));
    },

    /** 窗口放大后卡片不够铺满：首页推荐位继续补拉（沿用当前加载令牌）。 */
    async _onResize() {
        const token = this._loadToken;
        if (this.mode === 'home') {
            if (!this._homeList.length || this._homeList.length >= this._adaptiveTarget()) return;
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
        if (force) this._cacheDropPage(this.site, tid, this.page);
        const cached = force ? null : this._cacheGet(this.site, tid, this.page);
        if (cached) {
            // 命中缓存：立即上屏，后台静默刷新（内容变化才重渲染）
            if (cached.pagecount > 0) this.pagecount = cached.pagecount;
            this._catItems = cached.list;
            this.renderGrid(this._catItems);
            this.renderPager();
            $('#view-home').scrollTop(0);
            this._refreshCatPage(token, tid, this.page, size);
            return;
        }
        showLoading();
        try {
            await this._fetchCat(tid, this.page, size);
            if (token !== this._loadToken) return;
            this.renderGrid(this._catItems);
            this.renderPager();
            // 切页后回到顶部
            $('#view-home').scrollTop(0);
        } catch (e) {
            warnToast('分类载入失败');
        } finally {
            hideLoading();
        }
    },

    /** 生效的每页条数：设置值优先，空（自动）回退窗口自适应铺满估算。 */
    async _pageSize() {
        const n = await listPageSize();
        return n > 0 ? n : this._adaptiveTarget();
    },

    /**
     * 拉取单页并更新 pagecount 与缓存。
     * pagecount 策略：源返回有效值直接采用；无 pagecount 的源有内容时暂报
     * 还有下一页（pg+1），拉到空页再修正（部分源 list 短于显示条数，短页不能当末页）。
     */
    async _fetchCat(tid, pg, size) {
        const data = await doAction('categoryContent', {
            site: this.site, tid, pg: String(pg), filter: 'false', extend: '{}',
        });
        const raw = (data && data.list) || [];
        const pc = parseInt(data && data.pagecount, 10);
        let pagecount;
        if (pc > 0) pagecount = pc;
        else if (!raw.length) pagecount = Math.max(1, pg - 1); // 空页：上一页即末页
        else pagecount = Math.max(this.pagecount || 1, pg + 1); // 无 pagecount：暂允试下一页
        this.pagecount = pagecount;
        this._catItems = raw.slice(0, size);
        this._cachePut(this.site, tid, pg, this._catItems, pagecount);
    },

    /** 缓存命中后的后台静默重拉：令牌有效且仍在该页时才可能更新画面。 */
    async _refreshCatPage(token, tid, pg, size) {
        try {
            const before = JSON.stringify(this._catItems.map((v) => v.vod_id));
            await this._fetchCat(tid, pg, size);
            if (token !== this._loadToken || this.mode !== 'category' || this.tid !== tid || this.page !== pg) return;
            if (JSON.stringify(this._catItems.map((v) => v.vod_id)) !== before) this.renderGrid(this._catItems);
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
    },

    /** 当前源搜索：走站点自身 searchContent（CMS 源 wd 参数），仅搜当前选中源。
     *  支持真分页（pg 参数）；输入清空后回车回到首页推荐位。 */
    async searchCurrent(pg) {
        const wd = String($('#home-search').val() || '').trim();
        if (!wd) { if (this.mode === 'search') this.loadHome(); return; }
        if (!this.site) return;
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
            else this.pagecount = Math.max(this.pagecount || 1, this.page + 1);
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
        box.append(`<span class="class-tab ${activeTid === '' ? 'active' : ''}" data-tid="">全部</span>`);
        this.classes.forEach((c) => {
            box.append(`<span class="class-tab ${activeTid === c.type_id ? 'active' : ''}" data-tid="${escHtml(c.type_id)}">${escHtml(c.type_name)}</span>`);
        });
    },

    renderGrid(list) {
        const grid = $('#home-grid').empty();
        if (!list.length) { grid.html('<div class="tip-line">暂无内容</div>'); return; }
        list.forEach((v) => {
            grid.append(vodCard(v));
        });
    },

    /** 统一分页器（common.js renderPagerBox）：搜索/分类模式共用，跳页回调按模式分发。 */
    renderPager() {
        renderPagerBox($('#home-pager'), {
            page: this.page,
            pagecount: this.pagecount,
            onJump: (pg) => {
                if (this.mode === 'search') this.searchCurrent(pg);
                else this.loadCategory(this.tid, pg);
            },
        });
    },
};

// 复用于 search.js 的卡片渲染
/**
 * 无封面/拉取失败统一兜底图：独立设计的资产文件
 * （assets/cover-fallback.svg，渐变底 + 胶片齿孔 + 播放标志）。
 */
function vodPlaceholder() {
    return 'assets/cover-fallback.svg';
}

/**
 * 封面淡入（T14）：img 初始 opacity:0，加载完成加 loaded 过渡显现，
 * 避免加载完成瞬间突然弹出/换兜底图时的闪烁；complete 检查兼容缓存命中时
 * load 事件可能先于属性挂载触发的情况。
 */
function coverFadeIn(img) {
    if (img.complete && img.naturalWidth) { img.classList.add('loaded'); return; }
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
}

function vodCard(v) {
    // referrerpolicy=no-referrer：大量图床带防盗链，不带 Referer 才能取到封面
    const pic = normalizePic(v.vod_pic) || vodPlaceholder();
    return `<div class="vod-card" data-id="${escHtml(v.vod_id)}" data-name="${escHtml(v.vod_name)}" tabindex="0">
        <div class="vod-cover"><img src="${escHtml(pic)}" alt="" loading="lazy" referrerpolicy="no-referrer" onload="coverFadeIn(this)" onerror="this.onerror=null;this.src='${vodPlaceholder()}'"></div>
        <div class="vod-name" title="${escHtml(v.vod_name)}">${escHtml(v.vod_name)}</div>
        <div class="vod-remarks">${escHtml(v.vod_remarks || '')}</div>
    </div>`;
}
