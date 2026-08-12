/**
 * popular.js — Kazumi 首页推荐（Bangumi 趋势/标签榜单，对齐 Kazumi PopularPage，T62）
 *
 * 数据链路：
 *   - 趋势：POST /kazumi/action do=kazumiBangumiTrends(limit,offset) → {trends,total}
 *   - 标签：POST /kazumi/action do=kazumiBangumiListByTag(tag,limit,offset) → {items,total}
 * 标签筛选仿 Kazumi PopularPage：下拉菜单选择预设标签，选定后服务端拉取该标签番剧。
 * 卡片复用 common.js bangumiCard；点击进二级详情页（Kazumi.openBangumiInfoPage）。
 */
/* global $, doAction, warnToast, showLoading, hideLoading, renderPagerBox, pageSizeOf, bangumiCard, escHtml, Kazumi, fitVodTitles */

// 对齐 Kazumi constants.dart defaultAnimeTags
const POPULAR_TAGS = [
  '日常', '原创', '校园', '搞笑', '奇幻', '百合', '恋爱',
  '悬疑', '热血', '后宫', '机战', '轻改', '偶像', '治愈', '异世界',
];

// 推荐（热门番组）数据本地缓存：切推荐页即时显示、无首次网络等待；标签页不缓存
const POPULAR_CACHE_KEY = 'popular_cache';

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
            this.load(1);
        });
    },

    /**
     * 视图切入：内存无数据时优先用本地缓存立即上屏（热门番组），后台再静默刷新；
     * 无缓存才等网络。会话内已加载过则直接复用（瞬间切换）。
     */
    async enter() {
        this.init();
        if (!this._items.length) {
            const cached = this._loadCache();
            if (cached && Array.isArray(cached.items) && cached.items.length) {
                this._tag = '';
                this._items = cached.items;
                this._total = cached.total || 0;
                this._setTagSelect('');
                this._renderGrid();
                this._renderPager();
                this.load(1, true); // 静默后台刷新，不阻塞切换
                return;
            }
            await this.load(1);
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
        } finally {
            if (!silent) hideLoading();
            this._loading = false;
        }
    },

    _loadCache() {
        try {
            const raw = localStorage.getItem(POPULAR_CACHE_KEY);
            if (!raw) return null;
            const d = JSON.parse(raw);
            if (!d || !Array.isArray(d.items) || !d.items.length) return null;
            return d;
        } catch (e) { return null; }
    },

    _saveCache() {
        if (this._tag !== '') return; // 仅缓存热门番组（推荐页落地视图），标签视图不覆盖
        try {
            localStorage.setItem(POPULAR_CACHE_KEY, JSON.stringify({
                ts: Date.now(),
                total: this._total,
                items: this._items,
            }));
        } catch (e) { /* 缓存失败忽略 */ }
    },

    async _pageSize() {
        if (typeof pageSizeOf !== 'function') return 24;
        const size = await pageSizeOf('pageSizePopular');
        return size > 0 && size <= 50 ? size : 20;
    },

    _setTagSelect(tag) {
        if (typeof document === 'undefined') return;
        const select = document.getElementById('popular-tags');
        if (select) select.value = tag;
    },

    _renderGrid() {
        const grid = $('#popular-grid').empty();
        if (!this._items.length) {
            grid.html('<div class="tip-line">暂无数据</div>');
            return;
        }
        grid.html(this._items.map((item) => bangumiCard(item)).join(''));
        // T74 收尾：按当前列宽把标题 JS 截到恰好两行（DOM 不保留超行文字）
        fitVodTitles(grid);
    },

    _renderPager() {
        const pagecount = this._total > 0 ? Math.ceil(this._total / this._size) : (this._items.length ? 1 : 0);
        renderPagerBox($('#popular-pager'), {
            page: this._page,
            pagecount,
            onJump: (pg) => this.load(pg),
        });
    },
};
