/**
 * timeline.js — 番剧时间表（Bangumi 每日放送 + 历史季度检索，对齐 Kazumi TimelinePage）
 *
 * 数据链路：
 *   - 本周在播：POST /kazumi/action do=kazumiBangumiCalendar → 星期桶 [{weekday:{id}, items}]
 *   - 历史季度：do=kazumiBangumiSeason(start,end) → 同形状星期桶（v0/search/subjects 按 air_date 过滤分桶）
 * 功能：近 20 年季节索引、排序（热度/评分/播出时间）、收藏过滤（token 降级）、评分/排名展示、
 *       封面徽标行（话数徽章 + 主要分类徽标 + 悬停收藏状态徽标，六态默认隐藏）。
 * 卡片点击进二级详情弹窗（Kazumi.openBangumiInfoPage）。
 */
/* global $, doAction, escHtml, warnToast, renderPagerBox, pageSizeOf, bangumiCard, bangumiNetGuide, Kazumi, fitVodTitles, playCardsEnter, recGet, FavHub, localCacheGet, localCacheSet, localCacheDel, UIState, showLoading, hideLoading, DetailSnap, Home, guardedLoad, loadBlockWords, filterBlocked, onBlockWordsChange */

const SEASON_NAMES = { 1: '冬季', 2: '春季', 3: '夏季', 4: '秋季' };
const SEASON_MONTH_START = { 1: '01-01', 2: '04-01', 3: '07-01', 4: '10-01' };
const SEASON_YEARS = 20; // 季节索引回溯年数（对齐 Kazumi 时间机器）
// 番剧时间表（放送星期桶）本地缓存：按季度键落盘，切季度/重进即时上屏后台静默刷新。
// 本周在播时效性较强（10min），历史季度基本不变（6h）。
const TIMELINE_CACHE_PREFIX = 'timeline::sched::v1::';
const TIMELINE_TTL_CURRENT = 10 * 60 * 1000;      // 本周在播 10 分钟
const TIMELINE_TTL_SEASON = 6 * 60 * 60 * 1000;   // 历史季度 6 小时
const TIMELINE_COL_TTL = 5 * 60 * 1000;           // Bangumi 账号收藏集合内存缓存 5 分钟（My 同步后作废）
// 账号收藏集合持久缓存（版本键防旧结构污染）：只存纯条目数组（_colCache 的 JSON 快照），
// 重启应用后首开时间表即可即时上屏过滤集合，免去白屏等待分页拉取。TTL 对齐 popular 30min；
// My 页同步账号收藏后 invalidateColCache 会连持久层一并作废，保证过滤与账号状态一致。
const TIMELINE_COL_PERSIST_KEY = 'timeline::collections::v1';
const TIMELINE_COL_PERSIST_TTL = 30 * 60 * 1000;  // 30 分钟
// Bangumi 单批详情 id 上限（后端 server.py kazumiBangumiInfoBatch 与
// plugin_manager.bangumi_info_batch 均按 [:60] 静默截断，前端必须同口径分批）。
const BGM_INFO_BATCH_MAX = 60;

// ---------------------------------------------------------------- 番剧「主要分类」识别表
// 用途：时间表封面卡片的中部徽标（集数徽标与收藏徽标之间）取「哪个标签作为主要分类」。
// 形态：[规范分类名, [站内常见写法（别名）…]]，表序 = 并列 count 时的优先级
// （越靠前越常见），保证同 count 的取值确定、可单测。
//
// 来源与取舍（本环境无外网，未能联网抓取：表由仓库内既有 Bangumi 标签口径归纳：
// ① popular.js POPULAR_TAGS 与 index.html #bgm-tag-presets 的 15 项「对齐上游
//    Kazumi defaultAnimeTags」清单（既有已验证的主流题材集合）；
// ② 该清单基础上补齐同义写法与站内常见题材：异世界/轮回/穿越/超能力/魔法少女/
//    末世/家庭/美食/职场/战争/耽美/逆后宫/恐怖/推理/动作/冒险/战斗/青春/历史/偶像）。
// 明确排除、且注释留痕的「非类型」标签（放进来必然把徽标选成元信息——这类标签在
// 每个条目上都存在且 count 往往最高，如 TV/日本 常是第一二名）：
//   · 媒介/放送形式：TV / OVA / OAD / ONA / WEB / 剧场版 / 剧场版动画 / 泡面番 /
//     短片 / 3D（泡面番是时长规格不是题材，用户口径同此）；
//   · 地域：日本 / 中国 / 国产 / 欧美 / 韩国；
//   · 放送季与年份：2026年10月 / 2025年1月 之类（逐季变动，不构成分类）；
//   · 来源：漫画改 / 漫改 / 轻小说改 / 轻改 / 游戏改 / 小说改 / 原创；
//   · 连载状态：连载 / 完结 / 续作 / 第N季 / 系列；
//   · 受众人群：女性向 / 男性向 / 子供向 / 少年漫 / 少女漫；
//   · 分级：里番 / R-18 / NSFW；
//   · 制作方 / 声优 / 系列名（芳文社 / 京阿尼 / 高达 …）：无法穷举；白名单只认
//     列出项，这类标签天然不会命中；
//   · 情绪与玩梗 fan 标签（致郁 / 催泪 / 猎奇 / 废萌）与音乐子类型（摇滚 / 爵士）：
//     与「类型/题材」不同层级或过于具体，宁缺毋滥（有「音乐」档兜住音乐番）。
// 别名归一示例：爱情→恋爱、喜剧/幽默→搞笑、SF/科学幻想→科幻、魔法/幻想→奇幻、
// 机甲/机器人→机战、竞技/体育→运动、轻百合→百合、时间旅行→穿越、时间循环→轮回。
// 无命中（典型：只有 TV/日本/2026年10月 这类元信息标签的冷门条目）→ 不显示徽标，
// 绝不回退「TV」——这是用户明确要求的降级行为。
const MAIN_TAG_TABLE = [
    ['恋爱', ['恋爱', '爱情', '恋爱喜剧']],
    ['搞笑', ['搞笑', '喜剧', '幽默', '欢乐', '沙雕']],
    ['日常', ['日常']],
    ['校园', ['校园', '学院', '学园', '学校', '社团']],
    ['奇幻', ['奇幻', '幻想', '魔幻', '魔法', '剑与魔法']],
    ['科幻', ['科幻', 'SF', '科学幻想', '硬科幻', '软科幻', '赛博朋克']],
    ['异世界', ['异世界', '异界', '转生']],
    ['热血', ['热血', '燃']],
    ['战斗', ['战斗', '对战']],
    ['动作', ['动作']],
    ['冒险', ['冒险', '探险']],
    ['悬疑', ['悬疑', '惊悚']],
    ['推理', ['推理', '侦探', '刑侦']],
    ['恐怖', ['恐怖', '丧尸', '僵尸']],
    ['机战', ['机战', '机甲', '机器人']],
    ['运动', ['运动', '竞技', '体育']],
    ['音乐', ['音乐', '乐队']],
    ['偶像', ['偶像']],
    ['治愈', ['治愈', '温馨', '治愈系']],
    ['百合', ['百合', '轻百合', 'GL']],
    ['耽美', ['耽美', 'BL', '蔷薇']],
    ['后宫', ['后宫']],
    ['逆后宫', ['逆后宫']],
    ['历史', ['历史']],
    ['战争', ['战争', '军事', '军武']],
    ['青春', ['青春', '成长']],
    ['家庭', ['家庭', '亲子', '亲情']],
    ['美食', ['美食', '料理']],
    ['职场', ['职场', '工作']],
    ['穿越', ['穿越', '时间旅行', '时空穿越']],
    ['轮回', ['轮回', '时间轮回', '循环', '时间循环']],
    ['超能力', ['超能力', '异能', '超自然']],
    ['魔法少女', ['魔法少女']],
    ['末世', ['末世', '末日', '废土']],
];
// 别名 → { category: 规范名, order: 表序 }。原始词与全小写词都建键：
// 站内 ASCII 标签大小写写法混用（SF/sf、GL/gl、BL/bl），不建小写键会漏命中。
const MAIN_TAG_LOOKUP = (() => {
    const m = new Map();
    MAIN_TAG_TABLE.forEach(([category, aliases], order) => {
        aliases.forEach((alias) => {
            if (!m.has(alias)) m.set(alias, { category, order });
            const lower = alias.toLowerCase();
            if (lower !== alias && !m.has(lower)) m.set(lower, { category, order });
        });
    });
    return m;
})();

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
    // 封面悬停收藏徽标的 id→type 映射：收集全部六态（过滤三桶只收 看过/在看/抛弃，
    // 想看/搁置不建桶），_loadColSets 构建后由 _renderGrid 注入徽标；空 Map 表示无收藏数据
    _colStateMap: new Map(),
    // Bangumi 账号收藏集合内存缓存（避免每次进入时间表都分页拉全量；本地收藏仍每次重读合并）
    _colCache: null,
    _colCacheToken: '',
    _colCacheTs: 0,
    _colStatePending: null, // getColStateMap 在途 Promise：并发页面共享一次拉取
    // 无缓存命中时的加载遮罩状态（防闪现：延迟弹出，快响应直接上屏不闪）
    _maskTimer: null,
    _maskShown: false,
    _loadToken: 0,      // 加载令牌：快速切季度后旧响应不得覆盖新数据（对齐 home.js）
    _loadAbort: null,   // 与 _loadToken 同代的 AbortController：切季度中止在途请求
    // 整页条目详情批量结果的单槽缓存 { key: 排序后 id 串, promise: Promise<Map<id,info>> }：
    // 同一页的 tags 徽标与话数徽章共享一次回源；换集合即换键自然作废（见 _fetchInfos）
    _infosMemo: null,

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
        // 全局番剧屏蔽：词表/开关变更时就地重渲染（_calendar 保留原始数据，零网络请求）。
        // invalidateBlockWords 只置脏并广播、不重读词表——重绘前先 await
        // loadBlockWords() 让新词表穿透缓存，否则仍按旧词表过滤。
        if (typeof onBlockWordsChange === 'function') {
            onBlockWordsChange(async () => {
                await loadBlockWords();
                if (this._inited) this._renderGrid();
            });
            await loadBlockWords(); // 首渲前读入词表，避免第一帧闪现被屏蔽的番剧
        }
        this._buildSeasonOptions();
        $('#timeline-refresh').on('click', () => this.load());
        $('#timeline-grid').on('click keydown', '.bangumi-card', (e) => {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            if (e.type === 'keydown') e.preventDefault();
            const id = String($(e.currentTarget).data('id') || '');
            if (id && typeof Kazumi !== 'undefined' && Kazumi.openBangumiInfoPage) {
                // A-01 写入侧：Bangumi 卡快照（site='' 对齐 openBangumi 的 this.site 口径）。
                // 快照是纯优化：DetailSnap/Home 任一缺席都不得阻断下方
                // openBangumiInfoPage 主流程（同仓其余写入点同此守卫口径）
                if (typeof DetailSnap !== 'undefined' && DetailSnap.put
                    && typeof Home !== 'undefined' && typeof Home._snapFieldsFromCard === 'function') {
                    DetailSnap.put('', id, Home._snapFieldsFromCard($(e.currentTarget)));
                }
                Kazumi.openBangumiInfoPage(id);
            }
        });
        $('#timeline-weekdays').on('click', '.class-tab', (e) => {
            const wd = parseInt($(e.currentTarget).data('weekday'), 10);
            if (wd >= 1 && wd <= 7) {
                this._weekday = wd;
                this._page = 1;
                this._saveView(); // 选择态存档（切页/重启不回初始态）
                this._renderWeekdays();
                this._renderGrid();
            }
        });
        $('#timeline-season').on('change', () => {
            this._season = $('#timeline-season').val() || 'current';
            this._page = 1;
            this._saveView();
            this.load();
        });
        $('#timeline-sort').on('change', () => {
            this._sort = $('#timeline-sort').val() || 'heat';
            this._page = 1;
            this._saveView();
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
            this._saveView();
            this._renderGrid();
        });
        // 保存过滤 chip 的原始 title，供禁用/启用态切换还原
        $('#timeline-filters .timeline-filter-chip').each(function () { $(this).attr('data-tip', $(this).attr('title')); });
        // 先按当前（默认禁用）态即时展示过滤行，避免筛选按钮在收藏数据异步拉取完成前「消失一会」；
        // _loadColSets 完成后会再调 _setColAvailable 更新为可用态（此前只在异步回调里首次 show，导致延迟出现）。
        this._setColAvailable(this._colAvailable);
        this._restoreView(); // 恢复持久化的星期/季度/排序/过滤/页码（含控件选中态），随后 load() 按存档拉取
        // 收藏过滤数据（异步，不阻塞首屏）
        this._loadColSets();
        await this.load();
    },

    /** 每次切入视图调用（对齐 live.js enter）：重读每页条数，变了就地重排。
     *  必须活在这里而不是 init()——init() 首行 `_inited` 守卫使首次之后直接
     *  return，而首次执行时上一行 `await this.load()` 刚用同一个 pageSizeOf
     *  赋过 this._pageSize，比对恒等；两段合起来让「改完设置回到时间表即生效」
     *  从未真正生效。App 切入视图时调用本方法（app.js timeline 分支）。 */
    async enter() {
        if (!this._inited) return; // 首次由 init() 的 load() 负责
        if (!this._calendar || !this._calendar.length) return;
        const size = await pageSizeOf('pageSizeHome');
        if (size === this._pageSize) return;
        this._pageSize = size;
        this._page = 1;
        this._renderGrid();
    },

    /** 页面选择态持久化（切页/重启不回初始态）：星期/季度/排序/收藏过滤/页码。
     *  ui-state.js 未加载的测试沙箱环境静默降级为不持久化。 */
    _viewState() {
        try { return (typeof UIState !== 'undefined' && UIState.get) ? UIState.get('timeline') : null; } catch (e) { return null; }
    },
    _saveView() {
        try {
            if (typeof UIState === 'undefined' || !UIState.set) return;
            UIState.set('timeline', {
                weekday: this._weekday,
                season: this._season,
                sort: this._sort,
                filters: {
                    dropped: !!this._filters.dropped,
                    watched: !!this._filters.watched,
                    onlyWatching: !!this._filters.onlyWatching,
                },
                page: this._page || 1,
            });
        } catch (e) { /* 持久化失败不影响主流程 */ }
    },

    /** init 时恢复存档并同步下拉/筛选 chip 的选中态（数据层恢复先行，控件缺失时仅跳过 UI 同步）。 */
    _restoreView() {
        const st = this._viewState();
        if (!st) return;
        if (st.weekday >= 1 && st.weekday <= 7) this._weekday = Number(st.weekday);
        if (st.season === 'current' || /^\d{4}Q[1-4]$/.test(String(st.season))) this._season = String(st.season);
        if (['heat', 'rating', 'date'].indexOf(st.sort) >= 0) this._sort = String(st.sort);
        const f = (st.filters && typeof st.filters === 'object') ? st.filters : {};
        this._filters = { dropped: !!f.dropped, watched: !!f.watched, onlyWatching: !!f.onlyWatching };
        this._page = Math.max(1, Number(st.page) || 1);
        try {
            $('#timeline-season').val(this._season);
            $('#timeline-sort').val(this._sort);
            const filters = this._filters;
            $('#timeline-filters .timeline-filter-chip').each(function () {
                $(this).toggleClass('active', !!filters[String($(this).data('filter') || '')]);
            });
        } catch (e) { /* 控件缺失不影响数据层恢复 */ }
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

    /** 单个季度选项 HTML。key 走 UIState 存档恢复路径时可能非标准格式，
     *  进 value 属性位/文本位前必须 escHtml（#11，XSS 回归的转义汇点）。 */
    _seasonOptionHtml(key) {
        return `<option value="${escHtml(key)}">${escHtml(this._seasonLabel(key))}</option>`;
    },

    /** 生成近 SEASON_YEARS 年季节选项（最新在前），按年分组；首项「本周（在播）」。
     *  now 可注入（测试钉死季度枚举），缺省取当前时间，行为不变。 */
    _buildSeasonOptions(now = new Date()) {
        const sel = $('#timeline-season').empty();
        sel.append('<option value="current" selected>本周（在播）</option>');
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
            // #11：year 源自本地枚举（数字），进属性位前仍转义兜底
            const group = $(`<optgroup label="${escHtml(String(year))}年"></optgroup>`);
            // T65：季节选项拼串一次性写入
            group.html(byYear.get(year).map((key) => this._seasonOptionHtml(key)).join(''));
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
                    // 内存 miss（首次/过期）：回退持久缓存兜底上屏（重启应用后免去首开白屏等待）。
                    // 持久数据是上次账号收藏的 JSON 快照，恢复时连同 token/ts 一起还原，保持
                    // _colCacheToken/_colCacheTs 世代校验语义不变（token 变了自然判 miss）。
                    const persisted = this._loadPersistedColSets();
                    if (persisted && persisted.token === token && Array.isArray(persisted.items) && persisted.items.length) {
                        all = persisted.items;
                        this._colCache = all;
                        this._colCacheToken = token;
                        // 内存 age 直接继承持久快照的真实年龄（修复：原取 30min-age 的补数
                        // 方向倒挂——刚落盘的快照被立即判过期，25min 以上的旧快照反而命中）。
                        // 新快照（age<5min）在剩余内存寿命内由内存直接命中；age≥5min 则内存
                        // 判过期，由持久兜底继续零网络上屏，直到 30min 持久 TTL 耗尽才走网络
                        // 重拉刷新（账号收藏在本机变更时另有 invalidateColCache 双清路径）。
                        this._colCacheTs = Date.now() - persisted.ageMs;
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
                        // 网络拉取成功的同时落盘（内部只缓存非空结果；失败静默不影响主流程）
                        this._savePersistedColSets(all, token);
                    }
                }
            }
        } catch (e) { /* Bangumi 拉取失败时仅用本地集合 */ }
        this._colSets = this._buildColSets(all);
        // 悬停收藏徽标映射：与过滤三桶同源构建（账号收藏 + 本地标记合并后），
        // 收录全部六态；先重建映射（覆盖旧态，防翻页/刷新残留 stale 徽标）。
        this._colStateMap = this._buildColStateMap(all);
        // 本地收藏一次读取共享给两处合并（recGet 每次都全量 settingsGet，勿重复 IPC）
        const favs = await this._readLocalFavorites();
        await this._mergeLocalCollections(this._colSets, favs);
        await this._mergeLocalStates(this._colStateMap, favs);
        // 首屏渲染先于收藏数据就绪的场景：映射到手后补挂当前网格的徽标行
        //（网格未渲染/为空时 _lastSlice 为空数组，零操作）
        this._attachFavBadges($('#timeline-grid'), this._lastSlice || []);
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

    /** 跨页面共享的收藏状态映射（推荐/搜索页徽标管线复用入口）。
     *  账号收藏复用 _loadColSets 的既有三级缓存（内存 5min + 持久 30min + 网络），
     *  各页面间不重复拉取；本地标记每次重读（低开销 settingsGet）。并发调用共享
     *  同一在途 Promise；映射为快照副本（调用方持有后不随 invalidate 失效，但
     *  FavHub 广播路径会重新拉取并补挂各页面网格）。
     *  返回 Map（id → type 1..5）；无任何收藏数据时为空 Map。 */
    getColStateMap() {
        // 在途请求共享：同一时刻多页进入只发一次网络
        if (this._colStatePending) return this._colStatePending;
        this._colStatePending = (async () => {
            // _loadColSets 尾部的时间表网格补挂（$ 选择器）在宿主缺失时可能抛错，
            // 但收藏数据本身已就绪——单独隔离，避免连带共享入口返回空映射
            try { await this._loadColSets(); } catch (e) { /* 时间表网格补挂失败不影响映射 */ }
            this._colStatePending = null;
            return this._colStateMap;
        })().catch(() => { this._colStatePending = null; return new Map(); });
        return this._colStatePending;
    },

    /** 状态变更后的即时同步（详情页/收藏页删改收藏后调用）：重读本地收藏并重渲染。
     *  _loadColSets 每次都会重读 favorites 存储，天然拿到最新 tag/bangumiId，无需缓存失效。 */
    async refreshAfterFavoriteChange() {
        // 收藏变更（可能含开启自动同步后上传到 Bangumi 账号）：作废账号收藏缓存强制重拉，
        // 保证过滤集合与账号状态一致。必须走 invalidateColCache 双清（内存 + 持久层）：
        // 只清内存的话，持久兜底（token 未变、30min 内）会命中旧快照，跨设备经
        // Bangumi 同步的服务端变化最长 30 分钟不可见。
        this.invalidateColCache();
        await this._loadColSets();
        if (this._colAvailable) this._renderGrid();
    },

    /** 作废 Bangumi 账号收藏内存缓存（My 页同步账号收藏后调用，使时间表过滤下次重拉最新）。
     *  持久层存的是同一份账号收藏快照，须一并删除——否则重启后持久兜底仍用同步前的旧数据过滤。 */
    invalidateColCache() {
        this._colCache = null;
        this._colCacheToken = '';
        this._colCacheTs = 0;
        // cache.js 未加载的测试沙箱环境静默降级
        if (typeof localCacheDel === 'function') {
            try { localCacheDel(TIMELINE_COL_PERSIST_KEY); } catch (e) { /* 缓存失败不影响主流程 */ }
        }
    },

    /** 读账号收藏持久缓存：返回 { items, token, ageMs } 或 null（未命中/过期/损坏/缓存层不可用）。
     *  只信 cache.js TTL 层的过期判定；token 一并校验（调用方还需与当前 token 比对，防换号串数据）。 */
    _loadPersistedColSets() {
        if (typeof localCacheGet !== 'function') return null;
        try {
            const d = localCacheGet(TIMELINE_COL_PERSIST_KEY);
            if (!d || typeof d !== 'object' || !Array.isArray(d.items) || !d.items.length) return null;
            const ageMs = Math.max(0, Date.now() - Number(d.ts) || 0);
            if (ageMs > TIMELINE_COL_PERSIST_TTL) return null;
            return { items: d.items, token: String(d.token || ''), ageMs };
        } catch (e) { return null; }
    },

    /** 写账号收藏持久缓存（只缓存成功非空结果；失败静默——缓存是优化，不影响主流程）。 */
    _savePersistedColSets(items, token) {
        if (typeof localCacheSet !== 'function') return;
        if (!Array.isArray(items) || !items.length) return; // 只缓存成功非空结果，绝不缓存空/错误
        try { localCacheSet(TIMELINE_COL_PERSIST_KEY, { ts: Date.now(), token: String(token || ''), items }, TIMELINE_COL_PERSIST_TTL); } catch (e) { /* ignore */ }
    },

    /** 合并本地收藏（records.js favorites）里带 bangumiId 的项到过滤集合，按 tag 归类。
     *  tag：watching=在看 seen=看过 dropped=抛弃（与 records.js TAG_ORDER 一致）。
     *  favs 可传入预读的收藏列表（与 _mergeLocalStates 共享一次读取），缺省自读。 */
    async _mergeLocalCollections(sets, favs) {
        try {
            if (typeof recGet !== 'function') return;
            const list = Array.isArray(favs) ? favs : await recGet('favorites');
            (list || []).forEach((f) => {
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

    /** 由 Bangumi 收藏条目构建「悬停收藏徽标」id→态映射。与 _buildColSets 同构
     *  （同一套 id 兼容口径：subject_id||subject.id||id、type 统一 Number），但收录
     *  全部六态——1想看 2看过 3在看 4搁置 5抛弃（过滤桶只收 2/3/5，想看/搁置不参与筛选
     *  但徽标要如实展示）。循环遍历一次产出，不单独再拉网络。 */
    _buildColStateMap(items) {
        const map = new Map();
        (items || []).forEach((it) => {
            if (!it) return;
            const subj = it.subject || {};
            const id = String(it.subject_id || subj.id || it.id || '');
            if (!id) return;
            const type = Number(it.type);
            if (type >= 1 && type <= 5) map.set(id, type);
        });
        return map;
    },

    /** 合并本地收藏 tag 到徽标映射（want=想看 seen=看过 watching=在看 hold=搁置
     *  dropped=抛弃，与 records.js TAG_LABEL 一致）。账号收藏优先：已有账号态的
     *  条目不被本地标记覆盖（账号是事实源，本地可能落后于上次同步）。
     *  favs 可传入预读的收藏列表（与 _mergeLocalCollections 共享一次读取），缺省自读。 */
    async _mergeLocalStates(map, favs) {
        try {
            if (typeof recGet !== 'function') return;
            const list = Array.isArray(favs) ? favs : await recGet('favorites');
            const tag2type = { want: 1, seen: 2, watching: 3, hold: 4, dropped: 5 };
            (list || []).forEach((f) => {
                if (!f) return;
                // 本地收藏的 Bangumi subject id：优先 bangumiId，其次 site==='bangumi' 时的 vodId
                const id = String(f.bangumiId || (String(f.site) === 'bangumi' ? f.vodId : '') || '');
                if (!id) return;
                const type = tag2type[f.tag];
                if (type && !map.has(id)) map.set(id, type);
            });
        } catch (e) { /* 本地合并失败不影响 Bangumi 映射 */ }
    },

    /** 读本地收藏 favorites（recGet 不可用时静默返回空列表）。 */
    async _readLocalFavorites() {
        try { return (typeof recGet === 'function') ? await recGet('favorites') : []; } catch (e) { return []; }
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
     *  item id 兼容顶层 id 与嵌套 subject.id（与 _buildColSets 取 id 口径一致）。
     *  全局番剧屏蔽在此一并生效（先屏蔽后收藏过滤）：_calendar 始终保留原始数据，
     *  删掉屏蔽词后无需重新请求即可恢复显示。 */
    _applyFilters(list) {
        let out = (typeof filterBlocked === 'function')
            ? filterBlocked(list, (it) => String((it && (it.name_cn || it.name)) || '')) : list;
        if (!this._colAvailable) return out;
        const { dropped, watched, watching } = this._colSets;
        const idOf = (it) => String((it && (it.id || (it.subject && it.subject.id))) || '');
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

    /** 加载遮罩（对齐 Home 防闪现模式）：延迟 300ms 弹出，仅真正进入网络等待才可见；
     *  数据上屏/失败后收起。缓存在手时不弹（即时上屏，后台静默刷新不打断已见内容）。
     *  token 归属校验：快速切季度时旧请求的 finally 只撤自己那一轮的遮罩，
     *  不会提前隐藏新请求的加载态。 */
    _showLoadMask(token) {
        this._hideLoadMask(token);
        this._maskTimer = setTimeout(() => {
            if (token !== this._loadToken) return; // 已换代：不再弹本轮遮罩
            this._maskTimer = null; this._maskShown = true; showLoading();
        }, 300);
    },
    _hideLoadMask(token) {
        if (token != null && token !== this._loadToken) return; // 非本轮请求：不动共享遮罩状态
        if (this._maskTimer) { clearTimeout(this._maskTimer); this._maskTimer = null; }
        if (this._maskShown) { this._maskShown = false; hideLoading(); }
    },

    /** 新一代加载令牌（A-31 收口到 common.js guardedLoad，原 _nextLoadToken 先例）：
     *  作废旧世代并中止在途请求，快速切季度后旧响应/旧 toast 不再覆盖新数据、新遮罩。 */
    _nextLoadToken() {
        const g = guardedLoad(this, { abortable: true }); // abort 型（本文件/home.js 同源语义）
        return g.token;
    },

    async load() {
        const token = this._nextLoadToken();
        if (this._season === 'current') await this._loadCurrent(token);
        else await this._loadSeason(this._season, token);
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

    async _loadCurrent(token) {
        this._mode = 'current';
        // 命中缓存即时上屏，后台静默刷新；无缓存才弹加载遮罩（延迟弹出防闪现）
        const hit = this._tryCache();
        if (!hit) this._showLoadMask(token);
        try {
            const ac = this._loadAbort; // 与令牌同代：切季度时中止在途请求
            const rsp = await doAction('kazumiBangumiCalendar', {}, '/kazumi/action', { signal: ac ? ac.signal : undefined });
            if (token !== this._loadToken) return; // 快速切季度：旧响应作废，不得覆盖新数据
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
            if (token !== this._loadToken) return; // 已换代：旧请求的失败提示不弹
            if (!hit) warnToast('时间表载入失败');
            // 无缓存兜底且日历为空：渲染网络/镜像引导空态（多为无法直连 Bangumi）
            if (!hit && !this._calendar.length) this._renderGrid();
        } finally {
            if (!hit) this._hideLoadMask(token);
        }
    },

    async _loadSeason(key, token) {
        const range = this._seasonRange(key);
        if (!range) { this._loadCurrent(token); return; }
        this._mode = 'season';
        const hit = this._tryCache();
        if (!hit) this._showLoadMask(token);
        try {
            const ac = this._loadAbort; // 与令牌同代：切季度时中止在途请求
            const rsp = await doAction('kazumiBangumiSeason', { start: range.start, end: range.end }, '/kazumi/action', { signal: ac ? ac.signal : undefined });
            if (token !== this._loadToken) return; // 快速切季度：旧响应作废，不得覆盖新数据
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
            if (token !== this._loadToken) return; // 已换代：旧请求的失败提示不弹
            if (!hit) warnToast('该季度数据载入失败');
            // 无缓存兜底且日历为空：渲染网络/镜像引导空态
            if (!hit && !this._calendar.length) this._renderGrid();
        } finally {
            if (!hit) this._hideLoadMask(token);
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
        this._lastSlice = slice; // 存当前页条目：收藏映射异步就绪后补挂徽标行用
        const grid = $('#timeline-grid').empty();
        if (!this._calendar.length) {
            // 日历整体为空：多为网络无法访问 Bangumi，落到网络/镜像引导空态
            grid.html(bangumiNetGuide());
        } else if (!slice.length) {
            grid.html('<div class="tip-line">该日暂无番剧更新</div>');
        } else {
            grid.html(slice.map((item) => this._renderCard(item)).join(''));
            // T74 收尾：按当前列宽把标题 JS 截到恰好两行（DOM 不保留超行文字）
            fitVodTitles(grid);
            // 入场错峰：整格重写后重触发（common.js playCardsEnter，glass 模式下 CSS 端自动跳过）
            playCardsEnter(grid);
            // 封面徽标行（话数徽章常驻 + 主要分类徽标 + 收藏徽标悬停显形，样式见 .vod-fav-row）：
            // 需在 _attachEpBadges 之前挂行——话数徽章补拉回来后 prepend 进同一行。
            this._attachFavBadges(grid, slice);
            // 封面左下角进度徽章（排名徽章 #N 的对角）：补拉条目详情拿总话数（bangumiInfo
            // 30 分钟缓存，同条目跨页/跨视图复用），放送完结→「N话」；连载中→「N/总话数」。
            this._attachEpBadges(grid, slice).catch(() => { /* 徽章补齐失败不外溢成全局未捕获 */ });
            // 主要分类徽标（集数徽标与收藏徽标之间）：与话数徽章共用同一批详情
            //（_fetchInfos 同一渲染代次内共享在途请求），首屏不等它——卡片先上屏，
            // 徽标后到；补齐失败静默（不外溢、不空占位）。
            this._attachTagBadges(grid, slice).catch(() => { /* 分类徽标补齐失败静默 */ });
        }
        renderPagerBox($('#timeline-pager'), {
            page: this._page,
            pagecount,
            onJump: (pg) => { this._page = pg; this._saveView(); this._renderGrid(); },
        });
    },

    _renderCard(item) {
        return bangumiCard(item);
    },

    /** 取「番剧主要分类」纯函数（可单测，无副作用）：输入 Bangumi tags
     *  （`[{name,count}]`，退化写法如裸字符串数组也兼容），输出 `{tag, category}`
     *  或 `''`（无任何类型标签命中 → 不显示徽标）。
     *  规则（用户口径「标签最多的一种分类，只用一个」）：
     *   · 只在 MAIN_TAG_TABLE 白名单内取候选（非类型标签天然不命中，见该表注释）；
     *   · count 取最高者（count 缺失/非数字按 0，字符串数字转数值）；
     *   · count 并列 → 白名单优先级（表序，即站内常见度）→ 名称字典序，保证确定；
     *   · 展示名为归一后的分类名（如别名「爱情」→「恋爱」），宽度可控；
     *     tag 保留命中时的原始写法，供 title 提示。
     *  入参非数组 → ''（调用方数据缺失/畸形时静默降级）。 */
    pickMainTag(tags) {
        if (!Array.isArray(tags)) return '';
        let best = null;
        for (const raw of tags) {
            const isObj = raw && typeof raw === 'object';
            const rawName = isObj ? raw.name : raw;
            const name = String(rawName == null ? '' : rawName).trim();
            if (!name) continue;
            const hit = MAIN_TAG_LOOKUP.get(name) || MAIN_TAG_LOOKUP.get(name.toLowerCase());
            if (!hit) continue;
            const n = isObj ? Number(raw.count) : 0;
            const count = Number.isFinite(n) ? n : 0;
            if (!best
                || count > best.count
                || (count === best.count && (hit.order < best.order
                    || (hit.order === best.order && name < best.tag)))) {
                best = { tag: name, category: hit.category, count, order: hit.order };
            }
        }
        return best ? { tag: best.tag, category: best.category } : '';
    },

    /** 整页条目详情批量补齐（话数徽章与主要分类徽标共用的唯一回源口）：
     *  复用 Kazumi.bangumiInfoBatch（两级 30 分钟缓存：前端 localStorage 逐 id +
     *  后端磁盘逐 id，两级都 miss 才网络并发回源），不新增接口、不逐卡请求。
     *  · ids 去重后按 BGM_INFO_BATCH_MAX 分批：后端对单批 >60 静默截断，不分批
     *    第 61 条起永远拿不到数据（话数徽章此前同此隐患，此处一并收口）；
     *  · 分批串行，避免一次涌出多包并发请求；
     *  · 同一渲染代次内按「排序后的 id 集合」共享在途 Promise：_attachEpBadges
     *    与 _attachTagBadges 因此只回源一次（零重复请求），且两者入参集合相同；
     *  · 任一批失败静默（保留已拿到的部分）：徽标缺失好过拖垮列表渲染。
     *  返回 Map<id, info>（缺值 id 不入 Map）。 */
    _fetchInfos(ids) {
        const uniq = [];
        const seen = new Set();
        for (const raw of (ids || [])) {
            const id = String(raw == null ? '' : raw).trim();
            if (id && !seen.has(id)) { seen.add(id); uniq.push(id); }
        }
        if (!uniq.length) return Promise.resolve(new Map());
        const key = uniq.slice().sort().join(',');
        if (this._infosMemo && this._infosMemo.key === key) return this._infosMemo.promise;
        const promise = (async () => {
            const out = new Map();
            for (let i = 0; i < uniq.length; i += BGM_INFO_BATCH_MAX) {
                const part = uniq.slice(i, i + BGM_INFO_BATCH_MAX);
                let batch = null;
                try {
                    batch = (typeof Kazumi !== 'undefined' && Kazumi.bangumiInfoBatch)
                        ? await Kazumi.bangumiInfoBatch(part)
                        : null;
                } catch (e) { /* 单批失败：保留已到的部分，徽标缺失优于列表卡死 */ }
                if (batch) for (const [id, info] of Object.entries(batch)) if (info) out.set(id, info);
            }
            return out;
        })();
        this._infosMemo = { key, promise };
        promise.then((m) => {
            // 全空结果不驻留（网络失败/后端无数据）：同一集合下次渲染重试，
            // 否则一次抖动会在本会话内把该页徽标永久钉成缺失。
            if (m.size === 0 && this._infosMemo && this._infosMemo.promise === promise) this._infosMemo = null;
        });
        return promise;
    },

    /** 主要分类徽标（封面徽标行中部，插入位置见 _insertTagBadge）：
     *  · 条目自带 tags（季度检索走 v0/search/subjects，响应自带 tags）→ 就地取材零网络；
     *  · 其余（本周在播日历条目无 tags）合并成 _fetchInfos 批量回源——与话数徽章
     *    共享同一批数据与缓存，不重复请求；
     *  · 无命中/补齐失败 → 不产生任何节点（绝不空占位、绝不回退 TV）。
     *  与话数徽章一样是「先渲染卡片、徽标后到」的异步补挂，不阻塞首屏。 */
    async _attachTagBadges(grid, items) {
        const picked = new Map(); // id → { tag, category }（先收集再统一落 DOM，避免半量插入）
        const needFetch = [];
        for (const it of (items || [])) {
            const id = String((it && (it.id || (it.subject && it.subject.id))) || '');
            if (!id) continue;
            if (Array.isArray(it.tags) && it.tags.length) {
                const p = this.pickMainTag(it.tags);
                if (p) picked.set(id, p);
                continue;
            }
            needFetch.push(id);
        }
        if (needFetch.length) {
            const infos = await this._fetchInfos(needFetch);
            for (const [id, info] of infos) {
                const p = this.pickMainTag(info && info.tags);
                if (p) picked.set(id, p);
            }
        }
        picked.forEach((p, id) => this._insertTagBadge(grid, id, p));
    },

    /** 把分类徽标插进封面徽标行，DOM 顺序必须是「集数徽标 → 分类徽标 → 收藏徽标」
     *  （用户指定的位置）。三种落位场景：
     *  · 行已存在（收藏徽标先挂 / bangumiCard 直出话数徽章）→ 插到 .vod-fav-badge
     *    之前（收藏徽标的悬停显形（塌缩 → 展开）动画不受影响）；行内暂无收藏徽标
     *    时追加到行尾，后续插入的位置天然仍在其左侧。
     *  · 行不存在（未收藏且话数徽章还没补上来）→ 自建行，并把已直挂 .vod-cover
     *    的话数/源徽章吸回行首（与 _attachFavBadges 同款口径）：两枚徽章都是
     *    absolute 定位在同一坐标，不归行会同位重叠。
     *  重挂去重：先删同卡既有分类徽标，防重复调用叠标签。 */
    _insertTagBadge(grid, id, pick) {
        const $card = grid.find(`.bangumi-card[data-id="${id}"] .vod-cover`);
        if (!$card.length) return;
        // 原始标签与规范分类不同（别名命中）时在 title 里附上原始写法，便于核对取值来源
        const tip = pick.tag === pick.category
            ? `Bangumi 主要分类：${pick.category}`
            : `Bangumi 主要分类：${pick.category}（标签「${pick.tag}」）`;
        const html = `<span class="timeline-tag-badge" title="${escHtml(tip)}">${escHtml(pick.category)}</span>`;
        $card.find('.timeline-tag-badge').remove();
        const $row = $card.find('.vod-fav-row');
        if ($row.length) {
            const $fav = $row.find('.vod-fav-badge');
            if ($fav.length) $fav.before(html);
            else $row.append(html);
            return;
        }
        const $oldEp = $card.find('.timeline-ep-badge');
        let epHtml = ($oldEp.length && $oldEp[0] && $oldEp[0].outerHTML) ? $oldEp[0].outerHTML : '';
        if (!epHtml) {
            const $oldEps = $card.find('.rec-eps');
            if ($oldEps.length && $oldEps[0] && $oldEps[0].outerHTML) epHtml = $oldEps[0].outerHTML;
        }
        const $oldKz = $card.find('.kazumi-badge');
        const kzHtml = ($oldKz.length && $oldKz[0] && $oldKz[0].outerHTML) ? $oldKz[0].outerHTML : '';
        $oldEp.remove();
        $card.find('.rec-eps').remove();
        $oldKz.remove();
        $card.append(`<div class="vod-fav-row">${kzHtml}${epHtml}${html}</div>`);
    },

    /** 封面左下角徽标行：挂 .vod-fav-row 容器（话数徽章常驻其行首），仅当前页里
     *  存在收藏态的条目注入 .vod-fav-badge 收藏徽标（默认塌缩隐藏，悬停时从话数
     *  徽章右侧滑入展开）。同步执行（映射内存即得，无网络）；映射为空时零 DOM 改动。
     *  文案对齐 records.js 的收藏标签语义（想看/在看/看过/搁置/抛弃），样式对齐
     *  「我的」收藏卡 .rec-tag（CSS 端定义）。
     *  mapState 可选传入外部 id→type 映射（推荐页复用徽章管线时带自己的映射）；
     *  缺省读时间表自身的 _colStateMap。
     *  卡片定位双口径：条目缺省按 `.bangumi-card[data-id]` 选择器定位（时间表/
     *  推荐页的卡片 data-id 即 Bangumi subject id）；条目可带 el（jQuery 引用，
     *  指向该卡 .vod-cover 节点）——搜索页 Kazumi 卡的 data-id 是播放源串而非
     *  subject id、类名也是 vod-card kazumi-card，选择器双失配，复用方（search.js）
     *  反查 subject id 后把自己定位好的封面节点直接传入，彻底绕开选择器失配。 */
    _attachFavBadges(grid, items, mapState) {
        const map = mapState || this._colStateMap;
        if (!map || !map.size) return;
        // type → [文案, 着色类]（1想看 2看过 3在看 4搁置 5抛弃，与 records.js TAG_LABEL 一致）
        const FAV = { 1: ['想看', 'want'], 2: ['看过', 'seen'], 3: ['在看', 'watching'], 4: ['搁置', 'hold'], 5: ['抛弃', 'dropped'] };
        items.forEach((it) => {
            const id = String((it && (it.id || (it.subject && it.subject.id))) || '');
            const type = id ? map.get(id) : 0;
            if (!type) return; // 未收藏：不渲染徽标行（悬停无元素可显示）
            const meta = FAV[type] || FAV[1];
            // 定位：优先条目自带的 el 引用（搜索 Kazumi 卡），缺省走 data-id 选择器
            const $card = (it && it.el && it.el.length) ? it.el : grid.find(`.bangumi-card[data-id="${id}"] .vod-cover`);
            if (!$card.length) return;
            // 重挂场景（FavHub 广播 / 映射重建后补挂）必须保住既有话数徽章：
            // 行容器里的话数徽章随 remove() 一起销毁，先取 HTML、删行重建后吸回行首，
            // 否则「详情页同步收藏 → 返回推荐页」时收藏卡片的话数徽章集体消失。
            // .rec-eps（bangumiCard 直出/搜索卡）与 .timeline-ep-badge（异步补挂）
            // 两种形态都要吸——二者不会并存（重挂前先归一为行内首项）。
            const $oldEp = $card.find('.timeline-ep-badge');
            let oldEpHtml = ($oldEp.length && $oldEp[0] && $oldEp[0].outerHTML) ? $oldEp[0].outerHTML : '';
            if (!oldEpHtml) {
                const $oldEps = $card.find('.rec-eps');
                if ($oldEps.length && $oldEps[0] && $oldEps[0].outerHTML) oldEpHtml = $oldEps[0].outerHTML;
            }
            // 源徽章（.kazumi-badge，搜索页 Kazumi 卡行内常驻）同模式吸回：
            // 删行重建会把行内这枚徽章连带删除，先取 outerHTML 备份，新行挂上后
            // 与话数徽章一起回归行内（时间表/推荐页无此徽章，取空串零影响）。
            const $oldKz = $card.find('.kazumi-badge');
            const kzHtml = ($oldKz.length && $oldKz[0] && $oldKz[0].outerHTML) ? $oldKz[0].outerHTML : '';
            // 分类徽标（.timeline-tag-badge，时间表卡）同模式吸回：它也是行内成员，
            // 删行重建会连带销毁（同步收藏返回后徽标成批消失），且必须回到
            // 「收藏徽标之前」的指定位置（下方 before 插回，不随话数徽章 prepend）。
            const $oldTag = $card.find('.timeline-tag-badge');
            const tagHtml = ($oldTag.length && $oldTag[0] && $oldTag[0].outerHTML) ? $oldTag[0].outerHTML : '';
            $oldTag.remove(); // 兜底：万一它不在行内（直挂封面），先摘除，避免下方插回时重复
            $card.find('.vod-fav-row').remove();
            // bangumiCard 直出的话数徽章可能直挂 .vod-cover（无行）：一并吸进行内
            const $staleEps = $card.find('.rec-eps');
            if ($staleEps.length && $staleEps[0] && $staleEps[0].outerHTML && !oldEpHtml) {
                oldEpHtml = $staleEps[0].outerHTML;
            }
            $staleEps.remove();
            $card.append(`<div class="vod-fav-row"><span class="vod-fav-badge vod-fav-${meta[1]}">${meta[0]}</span></div>`);
            // 话数徽章/源徽章吸回行首（优先复用刚保住的既有徽章；收藏数据晚于首屏
            // 时徽章直挂封面，同位重叠问题也在此一并吸附归行）
            if (oldEpHtml || kzHtml) {
                $oldEp.remove();
                $staleEps.remove();
                $oldKz.remove();
                $card.find('.vod-fav-row').prepend(kzHtml + oldEpHtml);
            }
            // 分类徽标插回收藏徽标之前（行内序：源徽章 → 话数徽章 → 分类徽标 → 收藏徽标）
            if (tagHtml) {
                const $newRow = $card.find('.vod-fav-row');
                const $fav = $newRow.find('.vod-fav-badge');
                if ($fav.length) $fav.before(tagHtml);
                else $newRow.append(tagHtml);
            }
        });
    },

    /** 封面左下角话数徽章（bangumi-rank-badge 的对角）：完结态分两式——
     *  已完结显示「N话」（对齐 Bangumi 搜索卡徽章口径），连载中显示
     *  「N/总话数」（N=当前已播出话数，按每周一话从放送日推算；无总话数的条目
     *  不显示）。整页缺总话数的条目合并成一次 _fetchInfos 批量回源（复用
     *  Kazumi.bangumiInfoBatch：前端 localStorage 逐 id + 后端磁盘逐 id 双层
     *  30 分钟缓存，页内切换/重复开页零网络；并与「主要分类徽标」共享同一次请求），
     *  徽章就绪一枚挂一枚；换页/切周时由 grid 重渲染自然作废。
     *  快捷分支：条目已带 eps/air_date 字段（推荐页趋势/榜单接口响应自带）时直接用，
     *  整页免回源（复用方 传 itemsFull=true 声明条目完整）；时间表日历/搜索条目
     *  无总话数的部分仍走批量补拉。 */
    async _attachEpBadges(grid, items, itemsFull) {
        const byId = new Map();
        for (const it of items) {
            const id = String((it && (it.id || (it.subject && it.subject.id))) || '');
            if (id) byId.set(id, it);
        }
        // 快捷分支可就地取材的条目；其余（含 itemsFull 但条目缺 eps 的兜底）走批量
        const direct = [];
        const needFetch = [];
        for (const [id, it] of byId) {
            if (itemsFull && (Number(it.eps || it.total_episodes) || 0) > 0) direct.push(id);
            else needFetch.push(id);
        }
        const infos = new Map();
        for (const id of direct) infos.set(id, byId.get(id));
        if (needFetch.length) {
            // 批量详情走 _fetchInfos：与「主要分类徽标」同一渲染代次共享在途请求
            //（同页只回源一次），并统一按后端单批 60 上限分批，避免超限被静默截断。
            for (const [id, info] of await this._fetchInfos(needFetch)) infos.set(id, info);
        }
        for (const [id, info] of infos) {
            const eps = Number(info.eps || info.total_episodes) || 0;
            if (!eps) continue;
            // 已播出话数：放送日 + 7 天/话推算（clamp 到 [1, eps]）；日期缺失按全量已播
            const dateStr = String(info.date || info.air_date || '');
            const m = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
            let aired = eps;
            if (m) {
                const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
                if (!Number.isNaN(start.getTime())) {
                    aired = Math.min(eps, Math.max(0, Math.floor((Date.now() - start.getTime()) / (7 * 86400000)) + 1));
                }
            }
            // 完结判定与详情页口径一致：放送日 + eps 周 + 3 天余量
            const finished = m
                ? Date.now() > (new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() + eps * 7 * 86400000 + 3 * 86400000)
                : false;
            // 已完结 → 徽章文本为总话数「12话」（与搜索卡 .rec-eps 同款）；
            // 连载中 →「N/总话数」
            const badge = finished
                ? `<span class="detail-progress-badge timeline-ep-badge" title="放送已完结 · 共 ${eps} 话">${eps}话</span>`
                : `<span class="detail-progress-badge timeline-ep-badge" title="已播出 ${Math.max(aired, 0)} 话 / 共 ${eps} 话">${Math.max(aired, 0)}/${eps}</span>`;
            const $card = grid.find(`.bangumi-card[data-id="${id}"] .vod-cover`);
            if (!$card.length) continue;
            $card.find('.timeline-ep-badge').remove();
            // 徽标行容器（_attachFavBadges 建 / bangumiCard 直出）：话数徽章 prepend
            // 行首常驻，收藏徽标在其右侧（悬停滑入显形）。行内已有 .rec-eps 直出徽章
            // （搜索响应自带 eps）时跳过补挂，避免同一行出现两枚话数徽章。
            const $row = $card.find('.vod-fav-row');
            if ($row.length) {
                if (!$row.find('.rec-eps').length) $row.prepend(badge);
            } else {
                $card.append(badge);
            }
        }
    },
};

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.timeline = Timeline;
}(typeof window !== 'undefined' ? window : globalThis));
