/**
 * timeline.js — 番剧时间表（Bangumi 每日放送 + 历史季度检索，对齐 Kazumi TimelinePage）
 *
 * 数据链路：
 *   - 本周在播：POST /kazumi/action do=kazumiBangumiCalendar → 星期桶 [{weekday:{id}, items}]
 *   - 历史季度：do=kazumiBangumiSeason(start,end) → 同形状星期桶（v0/search/subjects 按 air_date 过滤分桶）
 * 功能：近 20 年季节索引、排序（热度/评分/播出时间）、收藏过滤（token 降级）、评分/排名展示。
 * 卡片点击进二级详情弹窗（Kazumi.openBangumiDetail）。
 */
/* global $, doAction, escHtml, warnToast, showLoading, hideLoading, renderPagerBox, pageSizeOf, bangumiCard, Kazumi, fitVodTitles, recGet, FavHub, localCacheGet, localCacheSet */

const SEASON_NAMES = { 1: '冬季', 2: '春季', 3: '夏季', 4: '秋季' };
const SEASON_MONTH_START = { 1: '01-01', 2: '04-01', 3: '07-01', 4: '10-01' };
const SEASON_YEARS = 20; // 季节索引回溯年数（对齐 Kazumi 时间机器）
// 番剧时间表（放送星期桶）本地缓存：按季度键落盘，切季度/重进即时上屏后台静默刷新。
// 本周在播时效性较强（10min），历史季度基本不变（6h）。
const TIMELINE_CACHE_PREFIX = 'timeline::sched::v1::';
const TIMELINE_TTL_CURRENT = 10 * 60 * 1000;      // 本周在播 10 分钟
const TIMELINE_TTL_SEASON = 6 * 60 * 60 * 1000;   // 历史季度 6 小时
const TIMELINE_COL_TTL = 5 * 60 * 1000;           // Bangumi 账号收藏集合内存缓存 5 分钟（My 同步后作废）

const Timeline = {
    _inited: false,
    _calendar: [],      // 当前载入的星期桶数据 [{weekday:{id}, items:[...]}]
    _weekday: ((new Date().getDay() + 6) % 7) + 1, // 默认今天（1=周一..7=周日）
    _mode: 'current',   // current=本周在播 | season=历史季度
    _season: 'current', // 季度键（YYYYQn）或 'current'
    _sort: 'heat',      // heat | rating | date
    _page: 1,
    _pageSize: 20,
    // 收藏过滤（需 Bangumi token；无 token 时 _colAvailable=false 且隐藏过滤行）
    _colAvailable: false,
    _colSets: { dropped: new Set(), watched: new Set(), watching: new Set() },
    _filters: { dropped: false, watched: false, onlyWatching: false },
    // Bangumi 账号收藏集合内存缓存（避免每次进入时间表都分页拉全量；本地收藏仍每次重读合并）
    _colCache: null,
    _colCacheToken: '',
    _colCacheTs: 0,

    async init() {
        if (this._inited) return;
        this._inited = true;
        // 订阅收藏变更（Kazumi CollectController 模式）：详情页/收藏页任何收藏状态变更后，
        // FavHub.changed 广播，此处重读收藏并重渲染过滤集合。
        if (typeof FavHub !== 'undefined' && FavHub.onChanged) {
            this._unsubFav = FavHub.onChanged(() => {
                if (this._colAvailable && this._inited) this.refreshAfterFavoriteChange();
            });
        }
        this._buildSeasonOptions();
        $('#timeline-refresh').on('click', () => this.load());
        $('#timeline-grid').on('click keydown', '.bangumi-card', (e) => {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            if (e.type === 'keydown') e.preventDefault();
            const id = String($(e.currentTarget).data('id') || '');
            if (id && typeof Kazumi !== 'undefined' && Kazumi.openBangumiInfoPage) {
                Kazumi.openBangumiInfoPage(id);
            }
        });
        $('#timeline-weekdays').on('click', '.class-tab', (e) => {
            const wd = parseInt($(e.currentTarget).data('weekday'), 10);
            if (wd >= 1 && wd <= 7) {
                this._weekday = wd;
                this._page = 1;
                this._renderWeekdays();
                this._renderGrid();
            }
        });
        $('#timeline-season').on('change', () => {
            this._season = $('#timeline-season').val() || 'current';
            this._page = 1;
            this.load();
        });
        $('#timeline-sort').on('change', () => {
            this._sort = $('#timeline-sort').val() || 'heat';
            this._page = 1;
            this._renderGrid();
        });
        $('#timeline-filters').on('click', '.timeline-filter-chip', (e) => {
            const el = $(e.currentTarget);
            if (!this._colAvailable) return;
            const key = String(el.data('filter') || '');
            if (!(key in this._filters)) return;
            this._filters[key] = !this._filters[key];
            el.toggleClass('active', this._filters[key]);
            this._page = 1;
            this._renderGrid();
        });
        // 保存过滤 chip 的原始 title，供禁用/启用态切换还原
        $('#timeline-filters .timeline-filter-chip').each(function () { $(this).attr('data-tip', $(this).attr('title')); });
        // 先按当前（默认禁用）态即时展示过滤行，避免筛选按钮在收藏数据异步拉取完成前「消失一会」；
        // _loadColSets 完成后会再调 _setColAvailable 更新为可用态（此前只在异步回调里首次 show，导致延迟出现）。
        this._setColAvailable(this._colAvailable);
        // 收藏过滤数据（异步，不阻塞首屏）
        this._loadColSets();
        await this.load();
    },

    // ---------------------------------------------------------------- 季节索引

    /** 季度键 → 日期区间 {start,end}（YYYY-MM-DD，end 为下季首日，用于 air_date [start,end) 过滤）。 */
    _seasonRange(key) {
        const m = String(key).match(/^(\d{4})Q([1-4])$/);
        if (!m) return null;
        const year = parseInt(m[1], 10);
        const q = parseInt(m[2], 10);
        const start = `${year}-${SEASON_MONTH_START[q]}`;
        const end = q === 4 ? `${year + 1}-01-01` : `${year}-${SEASON_MONTH_START[q + 1]}`;
        return { start, end };
    },

    /** 季度键 → 展示标签（如「2026年夏季新番」）。 */
    _seasonLabel(key) {
        const m = String(key).match(/^(\d{4})Q([1-4])$/);
        if (!m) return String(key);
        return `${m[1]}年${SEASON_NAMES[parseInt(m[2], 10)]}新番`;
    },

    /** 生成近 SEASON_YEARS 年季节选项（最新在前），按年分组；首项「本周（在播）」。 */
    _buildSeasonOptions() {
        const sel = $('#timeline-season').empty();
        sel.append('<option value="current" selected>本周（在播）</option>');
        const now = new Date();
        let y = now.getFullYear();
        let q = Math.ceil((now.getMonth() + 1) / 3);
        // 线性回溯：当前季往前 SEASON_YEARS*4 个季度
        const byYear = new Map();
        for (let i = 0; i < SEASON_YEARS * 4; i++) {
            const key = `${y}Q${q}`;
            if (!byYear.has(y)) byYear.set(y, []);
            byYear.get(y).push(key);
            q--; if (q < 1) { q = 4; y--; }
        }
        for (const year of [...byYear.keys()].sort((a, b) => b - a)) {
            const group = $(`<optgroup label="${year}年"></optgroup>`);
            // T65：季节选项拼串一次性写入
            group.html(byYear.get(year).map((key) => `<option value="${key}">${this._seasonLabel(key)}</option>`).join(''));
            sel.append(group);
        }
    },

    // ---------------------------------------------------------------- 收藏过滤

    /** 拉取 Bangumi 收藏构建过滤集合（需 token；失败/无 token 时禁用过滤）。
     *  分页拉全量（API 单页上限 100）。另合并本地收藏（favorites 里带 bangumiId 且 tag 命中的项），
     *  这样即便未登录 Bangumi 账号、只在本地标记了「在看/看过/抛弃」也能正常筛选（用户反馈的核心问题）。 */
    async _loadColSets() {
        // Bangumi 账号收藏拉取失败不应连累本地标记（拆成独立 try）
        let all = [];
        let token = '';
        try {
            token = (typeof Kazumi !== 'undefined' && Kazumi._getBangumiToken) ? await Kazumi._getBangumiToken() : '';
            if (token) {
                // Bangumi 账号收藏在会话内很少变动（仅 My 同步时）：命中未过期缓存直接复用，
                // 免去每次进入时间表都分页拉 100-500 条。本地收藏仍每次重读合并（见下方），
                // 故详情页/收藏页改本地标记后过滤依旧实时生效。缓存在 My 同步后由 invalidateColCache 作废。
                if (this._colCache && this._colCacheToken === token && Date.now() - this._colCacheTs < TIMELINE_COL_TTL) {
                    all = this._colCache;
                } else {
                    for (let offset = 0; offset < 500; offset += 100) {
                        const rsp = await doAction('kazumiBangumiCollections', { token, limit: 100, offset }, '/kazumi/action');
                        const items = (rsp && rsp.items) || [];
                        all = all.concat(items);
                        if (items.length < 100) break;
                    }
                    this._colCache = all;
                    this._colCacheToken = token;
                    this._colCacheTs = Date.now();
                }
            }
        } catch (e) { /* Bangumi 拉取失败时仅用本地集合 */ }
        this._colSets = this._buildColSets(all);
        await this._mergeLocalCollections(this._colSets);
        // 只要有本地标记或 Bangumi 账号任一可用即启用过滤
        const hasAny = this._colSets.watching.size || this._colSets.watched.size || this._colSets.dropped.size || !!token;
        this._setColAvailable(!!hasAny);
        // 收藏集合异步拉取晚于首屏——载入后若有过滤开启则重渲染使其生效
        if (this._filters.onlyWatching || this._filters.dropped || this._filters.watched) this._renderGrid();
    },

    /** 进入时间表时重建收藏过滤集合并重渲染（对齐 Kazumi TimelinePage 每次 build 实时读收藏的做法）。
     *  修复：_colSets 原为首次 init 快照，详情页/收藏页改状态后筛选仍用旧数据。 */
    async refreshCollections() {
        await this._loadColSets();
        this._renderGrid();
    },

    /** 状态变更后的即时同步（详情页/收藏页删改收藏后调用）：重读本地收藏并重渲染。
     *  _loadColSets 每次都会重读 favorites 存储，天然拿到最新 tag/bangumiId，无需缓存失效。 */
    async refreshAfterFavoriteChange() {
        // 收藏变更（可能含开启自动同步后上传到 Bangumi 账号）：作废账号收藏缓存强制重拉，
        // 保证过滤集合与账号状态一致；视图普通再进入（refreshCollections）仍走缓存免重复拉。
        this._colCache = null;
        await this._loadColSets();
        if (this._colAvailable) this._renderGrid();
    },

    /** 作废 Bangumi 账号收藏内存缓存（My 页同步账号收藏后调用，使时间表过滤下次重拉最新）。 */
    invalidateColCache() {
        this._colCache = null;
        this._colCacheToken = '';
        this._colCacheTs = 0;
    },

    /** 合并本地收藏（records.js favorites）里带 bangumiId 的项到过滤集合，按 tag 归类。
     *  tag：watching=在看 seen=看过 dropped=抛弃（与 records.js TAG_ORDER 一致）。 */
    async _mergeLocalCollections(sets) {
        try {
            if (typeof recGet !== 'function') return;
            const favs = await recGet('favorites');
            (favs || []).forEach((f) => {
                if (!f) return;
                // 本地收藏的 Bangumi subject id：优先 bangumiId，其次 site==='bangumi' 时的 vodId
                const id = String(f.bangumiId || (String(f.site) === 'bangumi' ? f.vodId : '') || '');
                if (!id) return;
                const tag = f.tag || '';
                if (tag === 'watching') sets.watching.add(id);
                else if (tag === 'seen') sets.watched.add(id);
                else if (tag === 'dropped') sets.dropped.add(id);
            });
        } catch (e) { /* 本地合并失败不影响 Bangumi 集合 */ }
    },

    _setColAvailable(av) {
        this._colAvailable = av;
        const chips = $('#timeline-filters .timeline-filter-chip');
        if (av) {
            chips.removeClass('disabled').each(function () {
                const tip = $(this).attr('data-tip');
                if (tip) $(this).attr('title', tip);
            });
        } else {
            chips.addClass('disabled').attr('title', '需在详情页标记「在看」或配置 Bangumi Token 后使用');
        }
        $('#timeline-filters').show(); // 始终展示；未可用时置灰并提示如何启用
    },

    /** 由 Bangumi 收藏条目构建过滤集合（抛弃/看过/在看）。
     *  兼容 subject id 与 type 的多种形态：官方 v0 条目为顶层 subject_id + type，
     *  镜像/部分响应只在嵌套 subject.id 暴露 id，且 type 可能为字符串——
     *  统一取 subject_id||subject.id||id 并把 type 转 Number 比较，否则集合恒空、过滤失效。 */
    _buildColSets(items) {
        const sets = { dropped: new Set(), watched: new Set(), watching: new Set() };
        (items || []).forEach((it) => {
            if (!it) return;
            const subj = it.subject || {};
            const id = String(it.subject_id || subj.id || it.id || '');
            if (!id) return;
            const type = Number(it.type);
            // Bangumi 收藏 type：1想看 2看过 3在看 4搁置 5抛弃
            if (type === 5) sets.dropped.add(id);
            else if (type === 2) sets.watched.add(id);
            else if (type === 3) sets.watching.add(id);
        });
        return sets;
    },

    /** 按启用的收藏过滤裁剪列表（_colAvailable=false 时原样返回）。
     *  item id 兼容顶层 id 与嵌套 subject.id（与 _buildColSets 取 id 口径一致）。 */
    _applyFilters(list) {
        if (!this._colAvailable) return list;
        const { dropped, watched, watching } = this._colSets;
        const idOf = (it) => String((it && (it.id || (it.subject && it.subject.id))) || '');
        let out = list;
        if (this._filters.onlyWatching) {
            out = out.filter((it) => watching.has(idOf(it)));
        } else {
            if (this._filters.dropped) out = out.filter((it) => !dropped.has(idOf(it)));
            if (this._filters.watched) out = out.filter((it) => !watched.has(idOf(it)));
        }
        return out;
    },

    // ---------------------------------------------------------------- 排序

    /** 按当前 _sort 排序（返回新数组）：heat=热度票数降序，rating=评分降序，date=播出时间升序。 */
    _sortItems(list) {
        const arr = list.slice();
        const num = (it, path) => {
            const r = it.rating || {};
            return Number(r[path]) || 0;
        };
        if (this._sort === 'rating') arr.sort((a, b) => num(b, 'score') - num(a, 'score'));
        else if (this._sort === 'date') arr.sort((a, b) => String(a.air_date || '').localeCompare(String(b.air_date || '')));
        else arr.sort((a, b) => num(b, 'total') - num(a, 'total'));
        return arr;
    },

    // ---------------------------------------------------------------- 数据加载

    async load() {
        if (this._season === 'current') await this._loadCurrent();
        else await this._loadSeason(this._season);
    },

    /** 缓存键：本周在播固定 'current'，历史季度按季度键区分。 */
    _cacheKey() {
        return TIMELINE_CACHE_PREFIX + (this._season === 'current' ? 'current' : String(this._season));
    },

    /** 命中未过期缓存立即上屏（返回 true 表示已用缓存渲染）。 */
    _tryCache() {
        if (typeof localCacheGet !== 'function') return false;
        const d = localCacheGet(this._cacheKey());
        if (!d || !Array.isArray(d.calendar) || !d.calendar.length) return false;
        this._calendar = d.calendar;
        this._renderWeekdays();
        this._renderGrid();
        return true;
    },

    /** 写入成功非空的星期桶数据（空结果不缓存）。 */
    _saveCache(current) {
        if (typeof localCacheSet !== 'function') return;
        if (!Array.isArray(this._calendar) || !this._calendar.length) return;
        const ttl = current ? TIMELINE_TTL_CURRENT : TIMELINE_TTL_SEASON;
        localCacheSet(this._cacheKey(), { calendar: this._calendar }, ttl);
    },

    async _loadCurrent() {
        this._mode = 'current';
        // 命中缓存即时上屏，后台静默刷新（不弹 loading，不打断已见内容）
        const hit = this._tryCache();
        if (!hit) showLoading();
        try {
            const rsp = await doAction('kazumiBangumiCalendar', {}, '/kazumi/action');
            const cal = (rsp && rsp.calendar) || [];
            if (cal.length) {
                this._calendar = cal;
                this._renderWeekdays();
                this._renderGrid();
                this._saveCache(true);
            } else if (!hit) {
                this._calendar = cal;
                this._renderWeekdays();
                this._renderGrid();
            }
        } catch (e) {
            if (!hit) warnToast('时间表载入失败');
        } finally {
            if (!hit) hideLoading();
        }
    },

    async _loadSeason(key) {
        const range = this._seasonRange(key);
        if (!range) { this._loadCurrent(); return; }
        this._mode = 'season';
        const hit = this._tryCache();
        if (!hit) showLoading();
        try {
            const rsp = await doAction('kazumiBangumiSeason', { start: range.start, end: range.end }, '/kazumi/action');
            const cal = (rsp && rsp.calendar) || [];
            if (cal.length) {
                this._calendar = cal;
                this._renderWeekdays();
                this._renderGrid();
                this._saveCache(false);
            } else if (!hit) {
                this._calendar = cal;
                this._renderWeekdays();
                this._renderGrid();
            }
        } catch (e) {
            if (!hit) warnToast('该季度数据载入失败');
        } finally {
            if (!hit) hideLoading();
        }
    },

    // ---------------------------------------------------------------- 渲染

    _renderWeekdays() {
        const names = ['一', '二', '三', '四', '五', '六', '日'];
        const box = $('#timeline-weekdays').empty();
        for (let i = 1; i <= 7; i++) {
            const day = this._calendar.find((d) => d.weekday && d.weekday.id === i);
            const count = (day && day.items) ? day.items.length : 0;
            box.append(`<span class="class-tab ${i === this._weekday ? 'active' : ''}" data-weekday="${i}">周${names[i - 1]}${count ? ` (${count})` : ''}</span>`);
        }
    },

    async _renderGrid() {
        const size = await pageSizeOf('pageSizeHome');
        this._pageSize = size;
        const day = this._calendar.find((d) => d.weekday && d.weekday.id === this._weekday);
        let items = (day && day.items) || [];
        items = this._applyFilters(items);
        items = this._sortItems(items);
        const pagecount = Math.max(1, Math.ceil(items.length / size));
        this._page = Math.min(Math.max(1, this._page), pagecount);
        const slice = items.slice((this._page - 1) * size, this._page * size);
        const grid = $('#timeline-grid').empty();
        if (!slice.length) {
            grid.html('<div class="tip-line">该日暂无番剧更新</div>');
        } else {
            grid.html(slice.map((item) => this._renderCard(item)).join(''));
            // T74 收尾：按当前列宽把标题 JS 截到恰好两行（DOM 不保留超行文字）
            fitVodTitles(grid);
        }
        renderPagerBox($('#timeline-pager'), {
            page: this._page,
            pagecount,
            onJump: (pg) => { this._page = pg; this._renderGrid(); },
        });
    },

    _renderCard(item) {
        return bangumiCard(item);
    },
};

(function (root) {
    root.VPC = root.VPC || {};
    root.VPC.timeline = Timeline;
}(typeof window !== 'undefined' ? window : globalThis));
