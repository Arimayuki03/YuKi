/**
 * popular.js — Kazumi 首页推荐（Bangumi 趋势/标签榜单，对齐 Kazumi PopularPage，T62）
 *
 * 数据链路：
 *   - 趋势：POST /kazumi/action do=kazumiBangumiTrends(limit,offset) → {trends,total}
 *   - 标签：POST /kazumi/action do=kazumiBangumiListByTag(tag,limit,offset) → {items,total}
 * 标签筛选仿 Kazumi PopularPage：下拉菜单选择预设标签，选定后服务端拉取该标签番剧。
 * 卡片复用 common.js bangumiCard；点击进二级详情页（Kazumi.openBangumiInfoPage）。
 */
/* global $, doAction, warnToast, showLoading, hideLoading, renderPagerBox, pageSizeOf, bangumiCard, bangumiNetGuide, escHtml, Kazumi, fitVodTitles, localCacheGet, localCacheSet, localCacheDel, UIState, playCardsEnter */

// 对齐 Kazumi constants.dart defaultAnimeTags
const POPULAR_TAGS = [
  '日常', '原创', '校园', '搞笑', '奇幻', '百合', '恋爱',
  '悬疑', '热血', '后宫', '机战', '轻改', '偶像', '治愈', '异世界',
];

// 推荐（热门番组）数据本地缓存：切推荐页即时显示、无首次网络等待；标签页不缓存
// 迁移到 cache.js TTL 层（版本键防旧结构污染）：命中未过期缓存立即上屏，30min 后视为陈旧强制刷新。
const POPULAR_CACHE_KEY = 'popular::trends::v2';
const POPULAR_CACHE_TTL = 30 * 60 * 1000; // 30 分钟

const Popular = {
    _inited: false,
    _items: [],
    _total: 0,
    _page: 1,
    _size: 24,
    _loading: false,
    _tag: '', // 当前选中标签（空=趋势/热门番组）

    init() {
        if (this._inited) return;
        this._inited = true;
        $('#popular-refresh').on('click', () => this.load(1));
        $('#popular-grid').on('click keydown', '.bangumi-card', (e) => {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            if (e.type === 'keydown') e.preventDefault();
            const id = String($(e.currentTarget).data('id') || '');
            if (id && typeof Kazumi !== 'undefined' && Kazumi.openBangumiInfoPage) {
                Kazumi.openBangumiInfoPage(id);
            }
        });
        const tagSelect = $('#popular-tags');
        tagSelect.html('<option value="">热门番组</option>'
            + POPULAR_TAGS.map((t) => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join(''));
        tagSelect.on('change', (e) => {
            const tag = String(e.currentTarget.value || '');
            if (tag === this._tag) return;
            this._tag = tag;
            this._saveView(); // 标签切换即存档（load 内会再补一次带最新页码的快照）
            this.load(1);
        });
    },

    /** 页面选择态持久化（切页/重启不回初始态）：记录当前标签与页码。
     *  ui-state.js 未加载的测试沙箱环境静默降级为不持久化。 */
    _viewState() {
        try { return (typeof UIState !== 'undefined' && UIState.get) ? UIState.get('popular') : null; } catch (e) { return null; }
    },
    _saveView() {
        try {
            if (typeof UIState === 'undefined' || !UIState.set) return;
            UIState.set('popular', { tag: this._tag || '', page: this._page || 1 });
        } catch (e) { /* 持久化失败不影响主流程 */ }
    },

    /**
     * 视图切入：内存无数据时优先用本地缓存立即上屏（热门番组），后台再静默刷新；
     * 无缓存才等网络。会话内已加载过则直接复用（瞬间切换）。
     * 持久化恢复（切页/重启不回初始态）：有存档标签时直接回到该标签视图
     * （标签页无内容缓存，按存档页码重新拉取）；热门番组命中缓存时也恢复存档页码。
     */
    async enter() {
        this.init();
        if (!this._items.length) {
            const st = this._viewState();
            if (st && st.tag && POPULAR_TAGS.indexOf(String(st.tag)) >= 0) {
                this._tag = String(st.tag);
                this._setTagSelect(this._tag);
                await this.load(Number(st.page) || 1);
                return;
            }
            const cached = this._loadCache();
            if (cached && Array.isArray(cached.items) && cached.items.length) {
                this._tag = '';
                this._items = cached.items;
                this._total = cached.total || 0;
                this._page = Math.max(1, Number(st && st.page) || 1); // 恢复上次页码（默认第 1 页）
                this._setTagSelect('');
                this._renderGrid();
                this._renderPager();
                this.load(this._page, true); // 静默后台刷新，不阻塞切换
                return;
            }
            await this.load((st && Number(st.page)) || 1);
            return;
        }
        const size = await this._pageSize();
        if (size !== this._size) {
            this._size = size;
            await this.load(this._page || 1);
        }
    },

    /** 启动时后台预载（填充内存 + 刷新缓存），点开推荐页即时显示。 */
    preload() {
        this.init();
        if (!this._items.length) this.load(1, true);
    },

    /**
     * 拉取当前视图数据。silent=true（预载/后台刷新）时不弹 loading/toast，
     * 不打断用户已看到的缓存内容。成功且为热门番组时写本地缓存。
     */
    async load(page, silent) {
        if (this._loading) return;
        this._loading = true;
        this._size = await this._pageSize();
        this._page = Math.max(1, page || 1);
        this._saveView(); // 页码存档（标签/翻页共用此入口）
        if (!silent) showLoading();
        try {
            const offset = (this._page - 1) * this._size;
            if (this._tag) {
                const rsp = await doAction('kazumiBangumiListByTag', { tag: this._tag, limit: this._size, offset }, '/kazumi/action');
                this._items = (rsp && rsp.items) || [];
                this._total = (rsp && rsp.total) || 0;
            } else {
                const rsp = await doAction('kazumiBangumiTrends', { limit: this._size, offset }, '/kazumi/action');
                this._items = (rsp && rsp.trends) || [];
                this._total = (rsp && rsp.total) || 0;
            }
            this._renderGrid();
            this._renderPager();
            if (!this._items.length) $('#popular-status').text('暂无数据').show();
            else $('#popular-status').hide();
            this._saveCache(); // 仅缓存热门番组（推荐页落地视图），内部按 _tag 守卫
        } catch (e) {
            if (!silent) warnToast('推荐载入失败');
            // 载入失败且当前无内容：同样落到网络/镜像引导空态（多为无法直连 Bangumi）
            if (!this._items.length) this._renderGrid();
        } finally {
            if (!silent) hideLoading();
            this._loading = false;
        }
    },

    _loadCache() {
        try {
            // 优先 cache.js TTL 层（自带过期），不可用时回退裸 localStorage（兼容测试沙箱）
            if (typeof localCacheGet === 'function') {
                const d = localCacheGet(POPULAR_CACHE_KEY);
                if (!d || !Array.isArray(d.items) || !d.items.length) return null;
                return d;
            }
            const raw = localStorage.getItem(POPULAR_CACHE_KEY);
            if (!raw) return null;
            const d = JSON.parse(raw);
            if (!d || !Array.isArray(d.items) || !d.items.length) return null;
            return d;
        } catch (e) { return null; }
    },

    _saveCache() {
        if (this._tag !== '') return; // 仅缓存热门番组（推荐页落地视图），标签视图不覆盖
        if (!this._items.length) return; // 只缓存成功非空结果，绝不缓存空/错误
        const payload = { ts: Date.now(), total: this._total, items: this._items };
        try {
            if (typeof localCacheSet === 'function') {
                localCacheSet(POPULAR_CACHE_KEY, payload, POPULAR_CACHE_TTL);
                return;
            }
            localStorage.setItem(POPULAR_CACHE_KEY, JSON.stringify(payload));
        } catch (e) { /* 缓存失败忽略 */ }
    },

    async _pageSize() {
        if (typeof pageSizeOf !== 'function') return 24;
        const size = await pageSizeOf('pageSizePopular');
        // 与后端单次拉取上限一致（≤120）：趋势接口单页钳制 ≤50、标签搜索单页 ≤100，
        // 超出部分由后端翻页聚合补足（页间限速防风控），过大的设置值在此钳到 120。
        return size > 0 ? Math.min(size, 120) : 20;
    },

    _setTagSelect(tag) {
        if (typeof document === 'undefined') return;
        const select = document.getElementById('popular-tags');
        if (select) select.value = tag;
    },

    _renderGrid() {
        const grid = $('#popular-grid').empty();
        if (!this._items.length) {
            // 空态引导：多为网络无法访问 Bangumi，指引开启镜像并附隐私说明
            grid.html(bangumiNetGuide());
            return;
        }
        grid.html(this._items.map((item) => bangumiCard(item)).join(''));
        // T74 收尾：按当前列宽把标题 JS 截到恰好两行（DOM 不保留超行文字）
        fitVodTitles(grid);
        // 入场错峰：整格重写后重触发（common.js playCardsEnter，glass 模式下 CSS 端自动跳过）
        playCardsEnter(grid);
    },

    _renderPager() {
        const pagecount = this._total > 0 ? Math.ceil(this._total / this._size) : (this._items.length ? 1 : 0);
        renderPagerBox($('#popular-pager'), {
            page: this._page,
            pagecount,
            // 翻页后滚回视图顶部（与首页 loadCategory 一致）
            onJump: (pg) => { $('#view-popular').scrollTop(0); this.load(pg); },
        });
    },
};

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.popular = Popular;
}(typeof window !== 'undefined' ? window : globalThis));
