/**
 * bangumi-search.js — Bangumi 影片搜索 + 筛选（功能复刻 Kazumi SearchPage）
 *
 * 搜索页第 4 个页签「Bangumi」。复用 Kazumi 的查询语法 + 筛选工作台：
 *   - 关键词、标签（tag: AND 语义）、排序（heat/rank/score/match）、
 *     季度/日期区间（season:/date:）、排名区间（rank:）、评分区间（score:）、放送星期（weekday:）
 * 语法与筛选状态双向映射（SearchParser），与详情页标签跳转联动：
 *   详情页点 Bangumi 标签 → BangumiSearch.openWithTag(tag) → 切到本页签并以 tag: 过滤搜索。
 * 后端走 POST /kazumi/action do=kazumiBangumiSearchFilter（对齐 Kazumi buildBangumiSearchParams）。
 */
/* global $, doAction, warnToast, showLoading, hideLoading, escHtml, bangumiCard, fitVodTitles, renderPagerBox, pageSizeOf, openDialog, closeDialog, App */

// 对齐 Kazumi constants.dart defaultAnimeTags
const BANGUMI_SEARCH_TAGS = [
    '日常', '原创', '校园', '搞笑', '奇幻', '百合', '恋爱',
    '悬疑', '热血', '后宫', '机战', '轻改', '偶像', '治愈', '异世界',
];

// ============================================================
// SearchParser — 查询语法 ↔ 筛选状态双向映射（复刻 Kazumi lib/utils/search_parser.dart）
// ============================================================

/** YYYY-MM-DD 格式化（对齐 Kazumi formatDateTime）。 */
function bgmFormatDate(d) {
    const y = String(d.getFullYear()).padStart(4, '0');
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

const BangumiSearchParser = {
    _fieldNames: 'id|tag|sort|season|date|rank|score|weekday|nsfw',

    _re: {
        id: /id:(\d+)/i,
        tag: /(?:^|\s)tag:([^\s]+?)(?=(?:id|tag|sort|season|date|rank|score|weekday|nsfw):|\s|$)/gi,
        sort: /sort:([\w-]+)/i,
        season: /season:(\d{4}Q[1-4])/i,
        date: /date:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/i,
        rank: /rank:(\d*)\.\.(\d*)/i,
        score: /score:(\d+(?:\.\d+)?)?\.\.(\d+(?:\.\d+)?)?/i,
        weekday: /weekday:([1-7](?:,[1-7])*)/i,
    },

    /** 剔除所有 field:value 词元的正则（提取纯关键词用）。 */
    _tokenRe() {
        const f = this._fieldNames;
        return new RegExp(`(?:^|\\s)?(?:${f}):[^\\s]*?(?=(?:\\s|$)|(?:${f}):)`, 'gi');
    },

    parseId(q) {
        const m = q.match(this._re.id);
        return m ? m[1] : '';
    },

    parseTags(q) {
        const out = [];
        const re = new RegExp(this._re.tag.source, 'gi');
        let m;
        while ((m = re.exec(q)) !== null) {
            const t = (m[1] || '').trim();
            if (t && out.indexOf(t) < 0) out.push(t);
        }
        return out;
    },

    parseSort(q) {
        const m = q.match(this._re.sort);
        return m ? m[1] : '';
    },

    parseSeason(q) {
        const m = q.match(this._re.season);
        return m ? m[1].toUpperCase() : '';
    },

    parseDateRange(q) {
        const m = q.match(this._re.date);
        return m ? { start: m[1], end: m[2] } : null;
    },

    parseRankRange(q) {
        const m = q.match(this._re.rank);
        if (!m) return null;
        const min = m[1] !== '' ? parseInt(m[1], 10) : null;
        const max = m[2] !== '' ? parseInt(m[2], 10) : null;
        return (min != null || max != null) ? { min, max } : null;
    },

    parseScoreRange(q) {
        const m = q.match(this._re.score);
        if (!m) return null;
        const min = (m[1] !== undefined && m[1] !== '') ? parseFloat(m[1]) : null;
        const max = (m[2] !== undefined && m[2] !== '') ? parseFloat(m[2]) : null;
        return (min != null || max != null) ? { min, max } : null;
    },

    parseWeekdays(q) {
        const m = q.match(this._re.weekday);
        if (!m || !m[1]) return [];
        const set = [];
        m[1].split(',').forEach((s) => {
            const n = parseInt(s, 10);
            if (n >= 1 && n <= 7 && set.indexOf(n) < 0) set.push(n);
        });
        return set.sort((a, b) => a - b);
    },

    parseKeywords(q) {
        return q.replace(this._tokenRe(), ' ').replace(/\s+/g, ' ').trim();
    },

    /** query 字符串 → 筛选状态对象。 */
    toFilterState(query) {
        const q = String(query || '');
        return {
            id: this.parseId(q),
            keyword: this.parseKeywords(q),
            tags: this.parseTags(q),
            sort: this.parseSort(q) || 'heat',
            season: this.parseSeason(q),
            dateRange: this.parseDateRange(q),
            rankRange: this.parseRankRange(q),
            scoreRange: this.parseScoreRange(q),
            weekdays: this.parseWeekdays(q),
        };
    },

    /** 筛选状态 → query 字符串（与 toFilterState 互逆，用于回填搜索框与去重比较）。 */
    fromFilterState(state) {
        const s = state || {};
        if (s.id) return `id:${s.id}`;
        const tokens = [];
        const kw = (s.keyword || '').trim();
        if (kw) tokens.push(kw);
        (s.tags || []).forEach((tag) => {
            const t = (tag || '').trim();
            if (t) tokens.push(`tag:${t}`);
        });
        if (s.sort && s.sort !== 'heat') tokens.push(`sort:${s.sort}`);
        if (s.season) {
            tokens.push(`season:${s.season}`);
        } else if (s.dateRange && s.dateRange.start && s.dateRange.end) {
            tokens.push(`date:${s.dateRange.start}..${s.dateRange.end}`);
        }
        if (s.rankRange && (s.rankRange.min != null || s.rankRange.max != null)) {
            tokens.push(`rank:${s.rankRange.min != null ? s.rankRange.min : ''}..${s.rankRange.max != null ? s.rankRange.max : ''}`);
        }
        if (s.scoreRange && (s.scoreRange.min != null || s.scoreRange.max != null)) {
            tokens.push(`score:${bgmFmtNum(s.scoreRange.min)}..${bgmFmtNum(s.scoreRange.max)}`);
        }
        if (s.weekdays && s.weekdays.length) {
            const wd = Array.from(new Set(s.weekdays)).sort((a, b) => a - b);
            tokens.push(`weekday:${wd.join(',')}`);
        }
        return tokens.join(' ').trim();
    },

    /** season（YYYYQ[1-4]）→ 日期区间（对齐 Kazumi seasonToDateRange）。 */
    seasonToDateRange(season) {
        const m = /^(\d{4})Q([1-4])$/i.exec(season || '');
        if (!m) return null;
        const year = parseInt(m[1], 10);
        const quarter = parseInt(m[2], 10);
        const startMonth = (quarter - 1) * 3 + 1;
        // Kazumi: start = DateTime(year, startMonth-1, 1)（月份 1-based，startMonth-1 表示上月）
        // JS Date 月份 0-based：DateTime(y, startMonth-1, 1) → new Date(y, startMonth-2, 1)
        const start = new Date(year, startMonth - 2, 1);
        const end = new Date(year, startMonth + 1, 1);
        return { start: bgmFormatDate(start), end: bgmFormatDate(end) };
    },

    /** 状态的有效日期区间：显式 dateRange 优先，否则由 season 推导。 */
    effectiveDateRange(state) {
        const s = state || {};
        if (s.dateRange && s.dateRange.start && s.dateRange.end) return s.dateRange;
        if (!s.season) return null;
        return this.seasonToDateRange(s.season);
    },

    /** 是否含关键词以外的高级筛选（决定空关键词时是否仍发起搜索）。 */
    hasAdvancedFilters(state) {
        const s = state || {};
        return (s.tags && s.tags.length > 0)
            || (s.sort && s.sort !== 'heat')
            || !!s.season
            || !!s.dateRange
            || !!(s.rankRange && (s.rankRange.min != null || s.rankRange.max != null))
            || !!(s.scoreRange && (s.scoreRange.min != null || s.scoreRange.max != null))
            || (s.weekdays && s.weekdays.length > 0);
    },
};

/** score 序列化：整数去掉 .0（对齐 Kazumi SearchDoubleRange._formatDouble）。 */
function bgmFmtNum(v) {
    if (v == null) return '';
    const fixed = Number(v).toFixed(1);
    return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

const BANGUMI_SORT_LABELS = { heat: '热度', rank: '排名', score: '评分', match: '匹配' };
const BANGUMI_SEASON_LABELS = { 1: '冬季', 2: '春季', 3: '夏季', 4: '秋季' };
const BANGUMI_SEARCH_PAGE_SIZE = 20;

// ============================================================
// BangumiSearch — 搜索页「Bangumi」页签模块
// ============================================================

const BangumiSearch = {
    _inited: false,
    _state: null,       // 当前筛选状态（SearchParser 结构）
    _size: BANGUMI_SEARCH_PAGE_SIZE,
    _page: 1,
    _total: 0,
    _items: [],
    _loading: false,
    _reqToken: 0,       // 请求令牌：翻页/换筛选后旧回调作废

    init() {
        if (this._inited) return;
        this._inited = true;
        this._state = BangumiSearchParser.toFilterState('');

        $('#bgm-search-go').on('click', () => this._submitFromInput());
        $('#bgm-search-keyword').on('keydown', (e) => {
            if (e.key === 'Enter') { e.target.blur(); this._submitFromInput(); }
        });
        // 打开筛选工作台
        $('#bgm-search-filter-btn').on('click', () => this._openWorkbench());
        // 已生效筛选条 chip 删除
        $('#bgm-search-chips').on('click', '.bgm-chip-del', (e) => {
            const kind = String($(e.currentTarget).data('kind') || '');
            const value = String($(e.currentTarget).data('value') || '');
            this._removeFilter(kind, value);
        });
        // 结果卡片点击 → 二级详情页
        $('#bgm-search-results').on('click keydown', '.bangumi-card', (e) => {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            if (e.type === 'keydown') e.preventDefault();
            const id = String($(e.currentTarget).data('id') || '');
            if (id && typeof Kazumi !== 'undefined' && Kazumi.openBangumiInfoPage) {
                Kazumi.openBangumiInfoPage(id);
            }
        });
        this._initWorkbench();
    },

    /** 搜索框回车/点击：解析语法为筛选状态并搜索。 */
    _submitFromInput() {
        const raw = $('#bgm-search-keyword').val().trim();
        this._state = BangumiSearchParser.toFilterState(raw);
        this._setInputFromState();
        if (!raw && !BangumiSearchParser.hasAdvancedFilters(this._state)) {
            warnToast('请输入关键字或选择筛选条件');
            return;
        }
        this.load(1);
    },

    /** 把当前状态序列化回搜索框（规范化显示）。 */
    _setInputFromState() {
        $('#bgm-search-keyword').val(BangumiSearchParser.fromFilterState(this._state));
    },

    /** 详情页标签跳转入口：切到 Bangumi 页签并以 tag: 过滤搜索（功能联动核心）。 */
    openWithTag(tagName) {
        const tag = String(tagName || '').trim();
        if (!tag) return;
        // 切到搜索视图 + Bangumi 页签
        if (typeof App !== 'undefined' && App.showView) App.showView('search');
        $('#search-tabs .class-tab[data-stab="bangumi"]').trigger('click');
        this.init();
        // 仅按该标签筛选（清空其余条件，匹配 Kazumi 详情页标签跳转语义）
        this._state = BangumiSearchParser.toFilterState(`tag:${tag}`);
        this._setInputFromState();
        this.load(1);
    },

    /** 拉取当前筛选状态下的第 page 页结果。 */
    async load(page) {
        this._page = Math.max(1, page || 1);
        this._size = (await pageSizeOf('pageSizeSearch')) || BANGUMI_SEARCH_PAGE_SIZE;
        const token = ++this._reqToken;
        this._loading = true;
        this._renderChips();
        showLoading();
        $('#bgm-search-status').text('正在检索 Bangumi…').show();
        try {
            const s = this._state || {};
            // id 精确搜索：走详情，单条结果
            if (s.id) {
                const rsp = await doAction('kazumiBangumiInfo', { id: s.id }, '/kazumi/action');
                if (token !== this._reqToken) return;
                const info = rsp && rsp.info;
                this._items = info && info.id ? [info] : [];
                this._total = this._items.length;
                this._page = 1;
                this._renderGrid();
                this._renderPager();
                return;
            }
            const dateRange = BangumiSearchParser.effectiveDateRange(s) || {};
            const offset = (this._page - 1) * this._size;
            const rsp = await doAction('kazumiBangumiSearchFilter', {
                keyword: s.keyword || '',
                tags: (s.tags || []).join(','),
                sort: s.sort || 'heat',
                dateStart: dateRange.start || '',
                dateEnd: dateRange.end || '',
                rankMin: (s.rankRange && s.rankRange.min != null) ? s.rankRange.min : '',
                rankMax: (s.rankRange && s.rankRange.max != null) ? s.rankRange.max : '',
                scoreMin: (s.scoreRange && s.scoreRange.min != null) ? s.scoreRange.min : '',
                scoreMax: (s.scoreRange && s.scoreRange.max != null) ? s.scoreRange.max : '',
                weekdays: (s.weekdays || []).join(','),
                limit: this._size,
                offset,
            }, '/kazumi/action');
            if (token !== this._reqToken) return;
            this._items = (rsp && rsp.items) || [];
            this._total = (rsp && rsp.total) || 0;
            this._renderGrid();
            this._renderPager();
        } catch (e) {
            if (token !== this._reqToken) return;
            this._items = [];
            this._total = 0;
            $('#bgm-search-results').html('<div class="tip-line">检索失败，请稍后重试</div>');
            $('#bgm-search-pager').empty();
        } finally {
            if (token === this._reqToken) {
                this._loading = false;
                hideLoading();
                $('#bgm-search-status').hide();
            }
        }
    },

    _renderGrid() {
        const box = $('#bgm-search-results');
        if (!this._items.length) {
            box.html('<div class="tip-line">什么都没有找到 (;´༎ຶД༎ຶ`)</div>');
            return;
        }
        box.html(`<div class="vod-grid bangumi-search-grid">${this._items.map((it) => bangumiCard(it)).join('')}</div>`);
        if (typeof fitVodTitles === 'function') fitVodTitles(box.find('.bangumi-search-grid'));
    },

    _renderPager() {
        const pagecount = this._total > 0 ? Math.ceil(this._total / this._size) : (this._items.length ? 1 : 0);
        renderPagerBox($('#bgm-search-pager'), {
            page: this._page,
            pagecount,
            onJump: (pg) => { $('#view-search').scrollTop(0); this.load(pg); },
        });
    },

    /** 已生效筛选条件 chip（点 × 删除后立即重新搜索）。 */
    _renderChips() {
        const s = this._state || {};
        const chips = [];
        const mk = (kind, value, label) =>
            `<span class="bgm-chip">${escHtml(label)}<span class="bgm-chip-del" data-kind="${escHtml(kind)}" data-value="${escHtml(String(value))}" title="移除">×</span></span>`;
        (s.tags || []).forEach((t) => chips.push(mk('tag', t, `标签: ${t}`)));
        if (s.sort && s.sort !== 'heat') chips.push(mk('sort', '', `排序: ${BANGUMI_SORT_LABELS[s.sort] || s.sort}`));
        if (s.season) chips.push(mk('season', '', `季度: ${s.season}`));
        else if (s.dateRange) chips.push(mk('date', '', `日期: ${s.dateRange.start}..${s.dateRange.end}`));
        if (s.rankRange && (s.rankRange.min != null || s.rankRange.max != null)) {
            chips.push(mk('rank', '', `排名: ${s.rankRange.min != null ? s.rankRange.min : ''}..${s.rankRange.max != null ? s.rankRange.max : ''}`));
        }
        if (s.scoreRange && (s.scoreRange.min != null || s.scoreRange.max != null)) {
            chips.push(mk('score', '', `评分: ${bgmFmtNum(s.scoreRange.min)}..${bgmFmtNum(s.scoreRange.max)}`));
        }
        if (s.weekdays && s.weekdays.length) chips.push(mk('weekday', '', `星期: ${s.weekdays.join(',')}`));
        $('#bgm-search-chips').html(chips.join('')).toggle(chips.length > 0);
    },

    /** 删除单个筛选条件后重新搜索。 */
    _removeFilter(kind, value) {
        const s = this._state;
        if (!s) return;
        if (kind === 'tag') s.tags = (s.tags || []).filter((t) => t !== value);
        else if (kind === 'sort') s.sort = 'heat';
        else if (kind === 'season') { s.season = ''; s.dateRange = null; }
        else if (kind === 'date') s.dateRange = null;
        else if (kind === 'rank') s.rankRange = null;
        else if (kind === 'score') s.scoreRange = null;
        else if (kind === 'weekday') s.weekdays = [];
        this._setInputFromState();
        this.load(1);
    },

    // ---------------------------------------------------------------- 筛选工作台（复刻 Kazumi _SearchWorkbenchSheet）

    _draft: null, // 工作台草稿状态（应用时才写回 _state）

    /** 生成季度下拉选项（当前季度往前 20 年，对齐 Kazumi seasonOptions）。 */
    _seasonOptions() {
        const now = new Date();
        const opts = [];
        const curYear = now.getFullYear();
        for (let year = curYear; year >= curYear - 19; year--) {
            for (let q = 4; q >= 1; q--) {
                const d = new Date(year, (q - 1) * 3, 1);
                if (now > d) opts.push({ value: `${year}Q${q}`, label: `${year} ${BANGUMI_SEASON_LABELS[q]}` });
            }
        }
        return opts;
    },

    _initWorkbench() {
        const dlg = $('#bangumiFilterDialog');
        dlg.on('click', '.bgm-sort-seg', (e) => {
            const v = String($(e.currentTarget).data('sort') || 'heat');
            this._draft.sort = v;
            dlg.find('.bgm-sort-seg').removeClass('active');
            $(e.currentTarget).addClass('active');
        });
        dlg.on('click', '.bgm-tag-chip', (e) => {
            const tag = String($(e.currentTarget).data('tag') || '');
            if (!tag) return;
            const i = this._draft.tags.indexOf(tag);
            if (i >= 0) this._draft.tags.splice(i, 1);
            else this._draft.tags.push(tag);
            this._syncWorkbenchTags();
        });
        const addCustom = () => {
            const t = $('#bgm-tag-custom').val().trim();
            if (t && this._draft.tags.indexOf(t) < 0) {
                this._draft.tags.push(t);
                $('#bgm-tag-custom').val('');
                this._syncWorkbenchTags();
            }
        };
        dlg.on('click', '#bgm-tag-custom-add', addCustom);
        dlg.on('keydown', '#bgm-tag-custom', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } });
        dlg.on('click', '.bgm-draft-tag-del', (e) => {
            const t = String($(e.currentTarget).data('tag') || '');
            this._draft.tags = this._draft.tags.filter((x) => x !== t);
            this._syncWorkbenchTags();
        });
        dlg.on('change', '#bgm-season-select', (e) => {
            this._draft.season = String(e.currentTarget.value || '');
            if (this._draft.season) this._draft.dateRange = null;
            this._syncWorkbenchDate();
        });
        dlg.on('change', '#bgm-date-start, #bgm-date-end', () => {
            const start = $('#bgm-date-start').val();
            const end = $('#bgm-date-end').val();
            if (start && end) {
                this._draft.dateRange = { start, end };
                this._draft.season = '';
                $('#bgm-season-select').val('');
            }
        });
        dlg.on('change', '#bgm-score-toggle', (e) => {
            this._draft.scoreRange = e.currentTarget.checked ? { min: 7, max: 10 } : null;
            this._syncWorkbenchScore();
        });
        dlg.on('input', '#bgm-score-min, #bgm-score-max', () => {
            let min = parseFloat($('#bgm-score-min').val());
            let max = parseFloat($('#bgm-score-max').val());
            if (min > max) { const t = min; min = max; max = t; }
            this._draft.scoreRange = { min, max };
            $('#bgm-score-vals').text(`${bgmFmtNum(min)} - ${bgmFmtNum(max)}`);
        });
        dlg.on('change', '#bgm-rank-toggle', (e) => {
            this._draft.rankRange = e.currentTarget.checked ? { min: 1, max: 5000 } : null;
            this._syncWorkbenchRank();
        });
        dlg.on('input', '#bgm-rank-min, #bgm-rank-max', () => {
            let min = parseInt($('#bgm-rank-min').val(), 10);
            let max = parseInt($('#bgm-rank-max').val(), 10);
            if (min > max) { const t = min; min = max; max = t; }
            this._draft.rankRange = { min, max };
            $('#bgm-rank-vals').text(`${min} - ${max}`);
        });
        dlg.on('click', '.bgm-weekday-chip', (e) => {
            const wd = parseInt($(e.currentTarget).data('weekday'), 10);
            const i = this._draft.weekdays.indexOf(wd);
            if (i >= 0) this._draft.weekdays.splice(i, 1);
            else this._draft.weekdays.push(wd);
            this._draft.weekdays.sort((a, b) => a - b);
            $(e.currentTarget).toggleClass('active');
        });
        dlg.on('click', '#bgm-filter-reset', () => {
            this._draft = { id: '', keyword: this._draft.keyword, tags: [], sort: 'heat', season: '', dateRange: null, rankRange: null, scoreRange: null, weekdays: [] };
            this._renderWorkbench();
        });
        dlg.on('click', '#bgm-filter-apply', () => {
            this._state = Object.assign({}, this._draft);
            this._setInputFromState();
            closeDialog('bangumiFilterDialog');
            this.load(1);
        });
    },

    _openWorkbench() {
        const s = this._state || BangumiSearchParser.toFilterState('');
        this._draft = {
            id: s.id || '',
            keyword: s.keyword || '',
            tags: (s.tags || []).slice(),
            sort: s.sort || 'heat',
            season: s.season || '',
            dateRange: s.dateRange ? Object.assign({}, s.dateRange) : null,
            rankRange: s.rankRange ? Object.assign({}, s.rankRange) : null,
            scoreRange: s.scoreRange ? Object.assign({}, s.scoreRange) : null,
            weekdays: (s.weekdays || []).slice(),
        };
        this._renderWorkbench();
        openDialog('bangumiFilterDialog');
    },

    /** 用草稿状态刷新工作台各控件（打开/重置时全量渲染）。 */
    _renderWorkbench() {
        const d = this._draft;
        const dlg = $('#bangumiFilterDialog');
        dlg.find('.bgm-sort-seg').removeClass('active');
        dlg.find(`.bgm-sort-seg[data-sort="${d.sort || 'heat'}"]`).addClass('active');
        const seasonOpts = this._seasonOptions();
        $('#bgm-season-select').html('<option value="">不限季度</option>'
            + seasonOpts.map((o) => `<option value="${escHtml(o.value)}">${escHtml(o.label)}</option>`).join(''));
        $('#bgm-season-select').val(d.season || '');
        this._syncWorkbenchTags();
        this._syncWorkbenchDate();
        this._syncWorkbenchScore();
        this._syncWorkbenchRank();
        dlg.find('.bgm-weekday-chip').each(function () {
            const wd = parseInt($(this).data('weekday'), 10);
            $(this).toggleClass('active', d.weekdays.indexOf(wd) >= 0);
        });
    },

    _syncWorkbenchTags() {
        const d = this._draft;
        const dlg = $('#bangumiFilterDialog');
        dlg.find('.bgm-tag-chip').each(function () {
            const tag = String($(this).data('tag') || '');
            $(this).toggleClass('active', d.tags.indexOf(tag) >= 0);
        });
        const drafted = d.tags.map((t) =>
            `<span class="bgm-draft-tag">${escHtml(t)}<span class="bgm-draft-tag-del" data-tag="${escHtml(t)}" title="移除">×</span></span>`).join('');
        $('#bgm-draft-tags').html(drafted).toggle(d.tags.length > 0);
    },

    _syncWorkbenchDate() {
        const d = this._draft;
        $('#bgm-date-start').val(d.dateRange ? d.dateRange.start : '');
        $('#bgm-date-end').val(d.dateRange ? d.dateRange.end : '');
    },

    _syncWorkbenchScore() {
        const d = this._draft;
        const on = !!d.scoreRange;
        $('#bgm-score-toggle').prop('checked', on);
        $('#bgm-score-range-row').toggle(on);
        if (on) {
            $('#bgm-score-min').val(d.scoreRange.min != null ? d.scoreRange.min : 0);
            $('#bgm-score-max').val(d.scoreRange.max != null ? d.scoreRange.max : 10);
            $('#bgm-score-vals').text(`${bgmFmtNum(d.scoreRange.min)} - ${bgmFmtNum(d.scoreRange.max)}`);
        }
    },

    _syncWorkbenchRank() {
        const d = this._draft;
        const on = !!d.rankRange;
        $('#bgm-rank-toggle').prop('checked', on);
        $('#bgm-rank-range-row').toggle(on);
        if (on) {
            $('#bgm-rank-min').val(d.rankRange.min != null ? d.rankRange.min : 1);
            $('#bgm-rank-max').val(d.rankRange.max != null ? d.rankRange.max : 5000);
            $('#bgm-rank-vals').text(`${d.rankRange.min} - ${d.rankRange.max}`);
        }
    },
};

