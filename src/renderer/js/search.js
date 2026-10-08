/**
 * search.js — 搜索页：聚合搜索 / Kazumi 源 / 以图搜番
 *
 * 「聚合搜索」与「Kazumi 源」是两个完全独立的页面（各自的关键词输入、进度条、
 * 来源筛选行、结果容器与搜索状态互不干扰，切页签不丢结果）。实现上用
 * createSearchPage 工厂按页签各实例化一份控制器（Search.agg / Search.kz），
 * Search 门面对外保持原接口（init/focus/onViewShown/stop），app.js 等无需感知拆分。
 *
 * 聚合搜索走 SSE 端点 GET /search/stream?word=，后端每个源完成即推一条 data：
 *   data: {"source": key, "name": 名称, "list": [...]}
 * 全部结束发 event: done。逐源流式追加渲染；结果项点击进详情。
 * 来源筛选：每收到一个源生成一枚筛选标签，点击只看该源结果。
 * 分页（T38）：「全部」视图每组限显前 20 条（无分页器，超出的点上
 * 方来源标签进单源视图）；单源视图启用统一分页器，按设置条数翻
 * 看该源全部结果；数据已由 SSE 一次给全，纯前端切片，避免千百条撑爆 DOM。
 * Kazumi 源页签独立走 /search/kazumi-stream SSE（2.3，T73 边搜边加载）。
 */
/* global $, apiUrl, escHtml, warnToast, Detail, vodCard, vodCoverImg, renderPagerBox, pageSizeOf, fillMissingCovers, abortCoverFill, getCachedCover, showLoading, hideLoading, doAction, Kazumi, fitVodTitles, renderStatusBar, openDialog, closeDialog, errorTextOf, localCacheGet, localCacheSet, UIState, playCardsEnter, FavHub, Timeline, bangumiEpBadge, BangumiSearch, DetailSnap, Home, prefetchDetail, SettingsSnapshot, loadBlockWords, filterBlocked, onBlockWordsChange */

const SEARCH_PAGE_SIZE = 24; // 兜底值；实际每页条数取「搜索页每页条数」设置（T39，默认 24）

/** 详情快照写入（纯优化路径，永不抛错）。
 *  DetailSnap 由 detail-snap.js 以 root.DetailSnap 挂载、Home 是 home.js 顶层
 *  const——任一缺席都会在下方的 Detail.open / openBangumiInfoPage 之前抛
 *  ReferenceError/TypeError，把「打开详情」主流程打断。写快照失败一律静默。 */
function _snapPutSearch(site, id, $el) {
    try {
        if (typeof DetailSnap === 'undefined' || !DetailSnap.put) return false;
        if (typeof Home === 'undefined' || typeof Home._snapFieldsFromCard !== 'function') return false;
        return DetailSnap.put(site, id, Home._snapFieldsFromCard($el));
    } catch (e) { return false; }
}

// ---- 搜索结果快照（页面状态持久化：切页/重启不回初始态）----
// 搜索结束后把本次分组结果限量落盘（cache.js TTL 层），下次进入搜索页且无在途/
// 已有结果时静默重建，免去重新输入关键词 + 重等 SSE 流。严格限量控体积：
// 快照是体验优化而非完整历史，超出上限的源/条目直接不收录。
const SEARCH_SNAP_KEY_PREFIX = 'search::snap::'; // cache.js 键前缀（按页签 mode 区分）
const SEARCH_SNAP_TTL = 30 * 60 * 1000;          // 快照有效期 30 分钟
const SEARCH_SNAP_MAX_GROUPS = 30;               // 快照最多收录源分组数
const SEARCH_SNAP_MAX_ITEMS = 200;               // 每组最多收录条数
// L39 容量上限：30 组 × 200 条 = 6000 条源返回 vod 原样收录（未裁剪大字段，
// vod_play_url/vod_content 单条可达数百字节~数 KB），最坏可数 MB。cache.js 大池
// 上限同为 3MB（MAX_BYTES_BIG）：need 超限静默拒收（false），2~3MB 区间则会被
// 接收但挤占大池、按 t 淘汰其他大条目（各源 home feed 缓存等）。这里在写侧
// 预检同阈值：超限不写（快照是体验优化非完整历史）并一次性 warn 诊断（平时
// 静默不影响主流程；真发生说明源返回异常膨胀，值得留痕）。取舍得失：放弃
// 「巨型快照部分收录」，换大池内 feed 缓存不被单条快照清场。
const SEARCH_SNAP_MAX_BYTES = 3 * 1024 * 1024;   // 与 cache.js 大池 MAX_BYTES_BIG 对齐
let SEARCH_SNAP_OVERSIZE_WARNED = false;         // 超限 warn 只发一次（避免每次搜索刷屏）

/**
 * 创建一个页签专属的搜索控制器（聚合 / Kazumi 源 各一份）。
 * @param {Object} cfg { mode:'aggregate'|'kazumi', stab, gidPrefix,
 *   keywordSel, goSel, filtersSel, statusSel, resultsSel }
 */
function createSearchPage(cfg) {
    return {
        cfg,
        es: null,
        _inited: false,
        _searchToken: 0, // M-30a：搜索令牌（run 自增；旧词在途回调据此丢弃）
        _size: 0,        // 本次搜索生效的每页条数（run 时按设置解析一次）
        _curSrc: '',     // 当前筛选源（空 = 「全部」视图，限显前 20 条）
        _grpSeq: 0,      // 分组 id 自增序号（gid 带 cfg.gidPrefix 前缀，双面板 DOM id 不冲突）
        _grpLists: {},   // gid → { src, list }（SSE 已给全量，纯前端切片翻页）
        _grpRendered: {}, // gid → { mode: 'all'|'single', page }：切源时判断是否已按目标模式渲染，避免重绘销毁已加载图片
        _statusShown: false,    // 进度条是否已显示（T82：首个结果或超 1s 才显示，避免快速搜索闪现）
        _statusTimer: null,     // 1s 延迟显示定时器
        _statusDoneTimer: null, // 完成态 1.5s 隐藏定时器
        _lastStatus: null,      // 最近一次进度状态（延迟显示到点后渲染用）
        _colStateMap: null,     // 共享收藏映射（Timeline.getColStateMap 懒加载，徽标行注入用）
        _colMapLoading: false,  // 映射在途标记（并发渲染只触发一次懒加载）

        /** 本控制器所属页签当前是否可见（决定进度条能否显示，T83 泛化：离开本页签一律不显示）。 */
        _stabVisible() {
            return typeof Search !== 'undefined' && Search._stab === cfg.stab;
        },

        init() {
            if (this._inited) return;
            this._inited = true;
            $(cfg.goSel).on('click', () => this.run());
            $(cfg.keywordSel).on('keydown', (e) => {
                if (e.key === 'Enter') { e.target.blur(); this.run(); }
            });
            this._bindResultCardClick();
            this._bindSrcFilterTabs();
            // 订阅收藏变更：详情页改收藏后回搜索页，重读映射并补挂徽标（对齐时间表/推荐页）
            if (typeof FavHub !== 'undefined' && FavHub.onChanged) {
                this._unsubFav = FavHub.onChanged(() => this.refreshBadges());
            }
            // 全局番剧屏蔽：词表/开关变更时就地重算已渲染的分组（不重新发请求）。
            // 分组的 raw 存着未过滤原始结果，重算后：整组被屏蔽干净 → 撤掉分组卡与
            // 来源标签；条数变化 → 按当前页码重绘网格并更新计数。
            if (typeof onBlockWordsChange === 'function') {
                // invalidateBlockWords 只置脏并广播、不重读词表——重绘前先 await
                // loadBlockWords() 让新词表穿透缓存，否则就地重算仍按旧词表过滤。
                onBlockWordsChange(async () => {
                    await loadBlockWords();
                    if (this._inited) this._repaintBlocked();
                });
            }
            // 首搜前把词表读进内存：否则第一次搜索按「无屏蔽」渲染
            if (typeof loadBlockWords === 'function') loadBlockWords();
        },

        /** 屏蔽词变更后重算全部分组（就地、无网络）。 */
        _repaintBlocked() {
            Object.keys(this._grpLists).forEach((gid) => {
                const grp = this._grpLists[gid];
                if (!grp) return;
                const raw = Array.isArray(grp.raw) ? grp.raw : grp.list;
                const kept = (typeof filterBlocked === 'function') ? filterBlocked(raw) : raw;
                // gid 不作 DOM id：分组卡按 data-id 网格定位（`#${gid}` 恒空集死查询已删）
                const $grp = $(`${cfg.resultsSel} .src-group`).filter(function () {
                    return $(this).find(`#${gid}-grid`).length > 0;
                });
                if (!kept.length) {
                    // 整组被屏蔽干净：撤掉分组卡与对应的来源筛选标签
                    delete this._grpLists[gid];
                    $grp.remove();
                    $(cfg.filtersSel + ' .class-tab').filter(`[data-src="${CSS.escape(String(grp.src))}"]`).remove();
                    // 显式回「全部」标签（data-src=""）：被删的可能正是当前活动标签，
                    // 点 .active 会取空集失效，且点中的也未必是「全部」视图
                    const $allTab = $(cfg.filtersSel + ' .class-tab').filter('[data-src=""]').first();
                    if ($allTab.length && !$allTab.hasClass('active')) $allTab.trigger('click');
                    return;
                }
                grp.list = kept;
                $(`#${gid}-grid`).closest('.src-group').find('.src-count').text(String(kept.length));
                $(cfg.filtersSel + ' .class-tab').filter(`[data-src="${CSS.escape(String(grp.src))}"]`)
                    .text(`${grp.name || grp.src}（${kept.length}）`);
                this._paintGrp(gid, 1);
            });
            // 全部分组都被屏蔽干净 → 显示空态（与搜索无结果同款文案）。
            // 尚未发起过搜索时不得注入（改屏蔽词会误覆盖未搜索的空容器）。
            if (this._searchToken && !Object.keys(this._grpLists).length) $(cfg.resultsSel).html('<div class="tip-line">无结果</div>');
        },

        /** 收藏变更后刷新徽标：重读映射并补挂当前全部分组网格。 */
        async refreshBadges() {
            if (typeof Timeline === 'undefined' || !Timeline.getColStateMap) return;
            this._colStateMap = await Timeline.getColStateMap();
            Object.keys(this._grpLists).forEach((gid) => this._paintGrpFavBadges(gid));
        },

        /** 懒加载共享收藏映射（Timeline.getColStateMap：三页共享三级缓存，零重复请求）。
         *  只在首渲触发一次；到手后补挂所有已渲染分组。 */
        _ensureColStateMap() {
            if (this._colMapLoading || typeof Timeline === 'undefined' || !Timeline.getColStateMap) return;
            this._colMapLoading = true;
            Timeline.getColStateMap().then((map) => {
                this._colMapLoading = false;
                this._colStateMap = map;
                Object.keys(this._grpLists).forEach((gid) => this._paintGrpFavBadges(gid));
            }).catch(() => { this._colMapLoading = false; /* 收藏映射重建失败静默 */ });
        },

        /** 给单个分组网格补挂收藏徽标行（Timeline 徽章管线）。
         *  CatVod 卡 data-id 为源内 id（非 Bangumi subject id）不命中映射——
         *  CatVod 卡不出收藏徽标。
         *  Kazumi 卡 data-id 也是播放源串（类名 vod-card kazumi-card），Timeline
         *  侧按 `.bangumi-card[data-id]` 定位必然失配——这里按片名反查出 subject id
         *  后，把卡片 .vod-cover 节点引用（el）随条目传给 Timeline._attachFavBadges
         *  （el 双定位口径）：Timeline 直接用引用挂徽标，不再依赖选择器；条目顺序
         *  与 _paintGrp 渲染顺序一致（同为 grp.list 切片），按片名一一配对。 */
        _paintGrpFavBadges(gid) {
            if (typeof Timeline === 'undefined' || !Timeline._attachFavBadges) return;
            const grp = this._grpLists[gid];
            if (!grp || !this._colStateMap || !this._colStateMap.size) return;
            const gridEl = $(`#${gid}-grid`);
            const isKazumi = String(grp.src).startsWith('kazumi:');
            const items = grp.list.map((v) => {
                let id = v.vod_id;
                if (isKazumi) {
                    // 片名 → subject id（匹配缓存命中才有 id；缺缓存时不出徽标，
                    // 由封面补拉管线建立缓存后的下一次渲染/刷新补上）
                    id = '';
                    const name = String(v.name || '').trim();
                    const m = (name && typeof Kazumi !== 'undefined' && Kazumi.getCachedBangumiMatch)
                        ? Kazumi.getCachedBangumiMatch(name) : null;
                    if (m && m.id) id = String(m.id);
                    if (id) {
                        // 按片名定位本卡（_paintGrp 渲染顺序与 grp.list 一致）：
                        // 把封面节点直接交给 Timeline，绕开 data-id 选择器双失配。
                        // 选择器值用「原始片名 + CSS.escape」：属性选择器匹配的是 DOM
                        // 解码后的原值，escHtml 后的串反而永不命中（对齐 _retireVerifiedTab 口径）
                        const rawName = String(v.name || '');
                        const $card = gridEl.find(`.vod-card.kazumi-card[data-name="${CSS.escape(rawName)}"] .vod-cover`);
                        if ($card.length) return { id, el: $card };
                    }
                }
                return { id: String(id || '') };
            });
            Timeline._attachFavBadges(gridEl, items, this._colStateMap);
        },

        /** 结果卡片点击 → 详情（Kazumi 结果先匹配 Bangumi 元数据进二级详情页）。 */
        _bindResultCardClick() {
            $(cfg.resultsSel).on('click', '.vod-card', (e) => {
                const el = $(e.currentTarget);
                const src = String(el.data('source') || '');
                // Kazumi 结果：自动匹配 Bangumi 元数据，匹配成功进 Bangumi 详情页。
                // kazumiOrigin（site=kazumi:规则名 + 结果 src）随详情页携带：详情页
                // 「开始观看」默认回到该源直接解析剧集，免重新全源检索。
                if (src.startsWith('kazumi:') && typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    const name = el.data('name') || '';
                    const kazumiOrigin = { site: src, src: String(el.data('id') || '') };
                    const fallback = () => Kazumi.openSourceDialog(name, src, kazumiOrigin.src);
                    // T73 优化：封面补拉时已缓存 Bangumi 匹配（含 id）→ 直接进二级详情页，
                    // 免一次重复搜索，且封面与详情保证同一部番（不因两次搜索首条不同而错位）。
                    let cachedMatch = null;
                    if (name && typeof Kazumi.getCachedBangumiMatch === 'function') cachedMatch = Kazumi.getCachedBangumiMatch(name);
                    if (cachedMatch && cachedMatch.id && typeof Kazumi.openBangumiInfoPage === 'function') {
                        // A-01（Bangumi 快照写入侧）：Kazumi 结果经缓存匹配进 Bangumi 详情，
                        // 卡片封面随快照垫场 hero（site='' 同 openBangumi 口径）
                        if (typeof DetailSnap !== 'undefined' && DetailSnap.put) {
                            _snapPutSearch('', String(cachedMatch.id), el);
                        }
                        Kazumi.openBangumiInfoPage(cachedMatch.id, kazumiOrigin);
                        return;
                    }
                    if (name && typeof Kazumi.bangumiSearch === 'function') {
                        Kazumi.bangumiSearch(name).then((bgmResults) => {
                            // 与 getBangumiMatch 同款挑选：首个带 images 的结果。直接取 [0] 时
                            // 首条无图会回填 {id, cover:''} 残缺条目（id 还可能与补拉路径不同部）
                            const r0 = (bgmResults || []).find((r) => r && r.id && r.images
                                && (r.images.large || r.images.common || r.images.medium));
                            if (r0) {
                                // 回填缓存（补 id 后下次免搜）；评分/排名/日期随条目带入，
                                // 搜索页 Kazumi 卡对齐 Bangumi 卡备注/角标展示（bangumiCard 同款）
                                if (typeof Kazumi.cacheBangumiMatch === 'function') {
                                    Kazumi.cacheBangumiMatch(name, r0.id, bangumiCover(r0.images, 'card'), {
                                        score: (r0.rating && r0.rating.score) || 0,
                                        rank: (r0.rating && r0.rating.rank) || 0,
                                        air_date: r0.air_date || r0.date || '',
                                    });
                                }
                                if (typeof Kazumi.openBangumiInfoPage === 'function') {
                                    // A-01（Bangumi 快照写入侧）：现场搜索匹配进详情，同快照口径
                                    if (typeof DetailSnap !== 'undefined' && DetailSnap.put) {
                                        _snapPutSearch('', String(r0.id), el);
                                    }
                                    Kazumi.openBangumiInfoPage(r0.id, kazumiOrigin);
                                }
                                else fallback();
                            } else {
                                fallback();
                            }
                        }).catch(() => fallback());
                        return;
                    }
                    fallback();
                    return;
                }
                // A-01 写入侧：CatVod 结果卡快照（封面可能已由补拉管线回填 DOM，fire-and-forget）。
                // 与上方 Kazumi 分支同口径守卫：DetailSnap/Home 缺席时静默跳过，
                // 不得在 Detail.open 之前抛错把主流程打断。
                _snapPutSearch(src, el.data('id'), el);
                Detail.open(src, el.data('id'), el.data('name'));
            });
            // 详情意图预取（同 home.js）：悬停/触摸提前拉 detailContent，点击时
            // 简介与线路多半已在缓存。只预取 CatVod 卡（kazumi 卡走 Bangumi 匹配链，
            // 预取无消费路径）。
            if (typeof prefetchDetail === 'function') {
                let prefetchLast = '';
                $(cfg.resultsSel)
                    .on('mouseover', '.vod-card', (e) => {
                        const el = $(e.currentTarget);
                        const src = String(el.data('source') || '');
                        const id = String(el.data('id') || '');
                        if (!id || !src || src.startsWith('kazumi:') || src === 'bangumi') return;
                        const pkey = src + '|' + id;
                        if (pkey === prefetchLast) return;
                        prefetchLast = pkey;
                        prefetchDetail(src, id);
                    })
                    .on('pointerdown', '.vod-card', (e) => {
                        const el = $(e.currentTarget);
                        const src = String(el.data('source') || '');
                        const id = String(el.data('id') || '');
                        if (id && src && !src.startsWith('kazumi:') && src !== 'bangumi') prefetchDetail(src, id);
                    });
            }
        },

        /** 来源筛选标签：全部（限显前 20 条）/ 单源（分页看全部）。 */
        _bindSrcFilterTabs() {
            $(cfg.filtersSel).on('click', '.class-tab', (e) => {
                const el = $(e.currentTarget);
                $(cfg.filtersSel + ' .class-tab').removeClass('active');
                el.addClass('active');
                const cur = String(el.data('src') || '');
                this._curSrc = cur;
                const targetMode = cur ? 'single' : 'all';
                // T39 修复：jQuery each 内 this 是 DOM 元素，不能 .bind(this)（此前导致点源不筛选）
                $(cfg.resultsSel + ' .src-group').each(function () {
                    $(this).toggle(!cur || String($(this).data('source')) === cur);
                });
                // 只重绘「可见且渲染模式未达目标/网格为空」的分组；已按目标模式渲染的保留原 DOM
                // （图片不销毁重载，解决切源后图片缓慢重新加载）；隐藏组一律不重绘。
                const needsPaint = [];
                Object.keys(this._grpLists).forEach((gid) => {
                    const grp = this._grpLists[gid];
                    if (!grp || (cur && grp.src !== cur)) return;
                    const st = this._grpRendered[gid];
                    if (st && st.mode === targetMode && $(`#${gid}-grid`).children('.vod-card').length) return;
                    needsPaint.push(gid);
                });
                if (needsPaint.length) {
                    // T69：切源先中止旧封面补拉，避免旧的慢补拉占用并发额度拖慢新可见封面
                    if (typeof abortCoverFill === 'function') abortCoverFill();
                    needsPaint.forEach((gid) => this._paintGrp(gid, 1));
                } else {
                    // 无重绘：可见分组缺位封面续拉一次（不中止既有补拉，图片已加载的直接保留）
                    Object.keys(this._grpLists).forEach((gid) => {
                        const grp = this._grpLists[gid];
                        if (grp && (!cur || grp.src === cur)) fillMissingCovers(`#${gid}-grid`, null, {
                            concurrency: this.es ? 3 : 6, eager: !this.es, poolKey: 'search', retryDelay: 65000,
                        });
                    });
                }
            });
        },

        stop() {
            if (this.es) { try { this.es.close(); } catch (e) { /* ignore */ } this.es = null; }
            // T82：重置进度条状态并隐藏
            this._statusShown = false;
            clearTimeout(this._statusTimer);
            clearTimeout(this._statusDoneTimer);
            this._lastStatus = null;
            $(cfg.statusSel).hide();
        },

        /** 搜索进度提示（T74/T82）：spinner + 进度条 + 计数，替代纯文字。
         *  显示逻辑同首页：有首个结果(recv>0)或超 1s 才显示（避免快速搜索闪现）；完成态约 1.5s 后淡出隐藏。
         *  渲染走 renderStatusBar——spinner 元素稳定不重建，旋转动画不卡顿。
         *  仅当本页签处于激活状态才显示（切到其他页签时搜索仍在后台跑，但状态不显示，T83 泛化）。 */
        _setStatus(text, opts) {
            const el = $(cfg.statusSel);
            if (!el.length) return;
            const o = opts || {};
            const isDone = !!o.done;
            this._lastStatus = o;
            // 显示时机：非完成态且有首个结果才立即显示；recv=0 时等 1s（快速搜索不闪现）。
            if (!this._statusShown && !isDone) {
                if (o.recv > 0) {
                    this._statusShown = true;
                    clearTimeout(this._statusTimer);
                    if (this._stabVisible()) el.show();
                } else {
                    if (!this._statusTimer) {
                        this._statusTimer = setTimeout(() => {
                            if (!this._statusShown) {
                                this._statusShown = true;
                                renderStatusBar(el, this._lastStatus);
                                if (this._stabVisible()) el.show();
                            }
                        }, 1000);
                    }
                    el.hide();
                    return;
                }
            }
            if (isDone) {
                clearTimeout(this._statusTimer);
                if (this._statusShown) {
                    renderStatusBar(el, o);
                    clearTimeout(this._statusDoneTimer);
                    this._statusDoneTimer = setTimeout(() => {
                        $(cfg.statusSel).hide();
                        this._statusShown = false;
                    }, 1500);
                } else {
                    // 快速搜索未显示过：完成态的「失败/不可用」类提示仍需让用户看到，
                    // 否则功能失败但用户什么都收不到（之前这里只 el.hide()）。
                    // 「无结果/完成」属正常终态不打扰；错误/不可用类文本走 warnToast。
                    el.hide();
                    if (o.warnText) warnToast(o.warnText);
                }
                return;
            }
            renderStatusBar(el, o);
        },

        async run() {
            const word = $(cfg.keywordSel).val().trim();
            if (!word) { warnToast('请输入关键字'); return; }
            this._saveWord(word); // 持久化本页签关键词（切页/重启回填搜索框）
            const myToken = ++this._searchToken; // M-30a：搜索令牌——旧词在途回调不作数
            // T39：每页条数取「搜索页」单独设置（默认 24）
            this._size = (await pageSizeOf('pageSizeSearch')) || SEARCH_PAGE_SIZE;
            if (myToken !== this._searchToken) return; // await 期间已有新搜索发起：旧词作废，不得覆盖新词状态
            this.stop();
            $(cfg.resultsSel).empty();
            this._grpLists = {}; // 新搜索：重置分组数据
            this._grpSeq = 0;
            this._curSrc = '';
            this._grpRendered = {}; // 新搜索：重置分组渲染状态
            // 新搜索从顶部开始浏览：清掉视图级滚动记忆并立即滚顶（app.js 返回时不再恢复旧位置）
            if (typeof App !== 'undefined' && App._scrollPos) App._scrollPos.search = 0;
            $('#view-search').scrollTop(0);
            // 重置来源筛选栏（默认「全部」）
            $(cfg.filtersSel).html('<span class="class-tab active" data-src="">全部</span>').show();
            // T74：立即显示带 spinner 的进度提示（首个源到达前无空档）
            this._setStatus('正在搜索…', { recv: 0, items: 0 });

            // Kazumi 源页签：只走规则引擎流式搜索，不走聚合 SSE
            if (cfg.mode === 'kazumi') {
                await this._runKazumi(word);
                return;
            }

            const url = apiUrl('/search/stream?word=' + encodeURIComponent(word));
            const es = new EventSource(url);
            this.es = es;
            let recv = 0;   // 已收到的源（含空源/失败源，驱动进度条）
            let shown = 0;  // 有结果的源（渲染分组数）
            let items = 0;
            let total = 0;  // 总源数（meta 事件给出，供确定进度条）
            let kazumiDone = false;

            // meta：后端先推总源数，进度条即可确定填充
            es.addEventListener('meta', (ev) => {
                try { const m = JSON.parse(ev.data); if (m.total) total = m.total; } catch (e) { /* ignore */ }
            });

            es.onmessage = (ev) => {
                let payload;
                try { payload = JSON.parse(ev.data); } catch (e) { return; }
                recv += 1; // T74：每收到一个源（无论空/失败）都推进进度
                const list = payload.list || [];
                // 屏蔽在 renderGroup 内收口：整组被屏蔽干净时不计入「有结果的源」
                const keptN = list.length ? (this.renderGroup(payload, list) || 0) : 0;
                if (keptN) { shown += 1; items += keptN; }
                this._setStatus('正在搜索…', { recv, total, items });
            };

            const finish = () => {
                es.close();
                this.es = null;
                kazumiDone = true;
                this._setStatus(items ? `完成：${shown} 个源 · ${items} 条结果` : '无结果', { recv, total, items, done: true });
                if (!items) $(cfg.resultsSel).html('<div class="tip-line">无结果</div>');
                this._fillAllCovers();
                this._saveSnapshot(); // 结果快照落盘（切页/重启进搜索页可静默还原）
            };

            es.addEventListener('done', finish);

            es.onerror = () => {
                // 服务端 done 后关闭连接也会触发 error；若已收到结果则视为正常结束
                if (this.es === null) return;
                if (!shown) { es.close(); this.es = null; kazumiDone = true; this._setStatus('搜寻失败', { recv, total, done: true }); warnToast('搜寻失败'); }
                else finish();
            };

            // Kazumi 聚合搜索（与 CatVod SSE 并行；kimi UI 设计，glm5.2 后端端点）
            if (typeof Kazumi !== 'undefined' && Kazumi.hasEnabledRules && Kazumi.hasEnabledRules()) {
                Kazumi.aggregateSearch(word).then((results) => {
                    if (myToken !== this._searchToken) return; // M-30a：旧词在途回调丢弃，防混入新词结果页
                    if (!results || !results.length) return;
                    if (this._curSrc) return; // 已切到单源筛选，不追加 Kazumi 结果
                    results.forEach((r) => {
                        const data = r.data || [];
                        const payload = { source: 'kazumi:' + r.pluginName, name: r.pluginName };
                        // T60：只统计「屏蔽过滤后仍有结果」的源，计数与卡片数一致
                        const keptN = data.length ? (this.renderGroup(payload, data) || 0) : 0;
                        if (keptN) { shown += 1; items += keptN; }
                    });
                    // 已结束时更新为最终状态（含 Kazumi 结果）
                    this._setStatus(items ? `完成：${shown} 个源 · ${items} 条结果` : '无结果',
                        { recv, total, items, done: kazumiDone });
                    if (kazumiDone && !items) $(cfg.resultsSel).html('<div class="tip-line">无结果</div>');
                }).catch(() => { /* Kazumi 搜索失败不影响 CatVod 结果 */ });
            }
        },

        /** 搜索结束后提高并发并补完整个当前页面；可见卡仍优先。 */
        _fillAllCovers() {
            Object.keys(this._grpLists).forEach((gid) => fillMissingCovers(
                `#${gid}-grid`, null, { concurrency: 6, eager: true, poolKey: 'search', retryDelay: 65000 }));
        },

        /** Kazumi 规则源流式搜索（Kazumi 源页签专用，T73 边搜边加载）：走 SSE 流式端点，
         *  每个规则源完成即推一条 data 渲染刷新，不再等全部源结束才显示。
         *  验证码源单独提示分组。进度条按启用规则数确定。 */
        async _runKazumi(word) {
            // 已知可检索规则数 → 确定进度条（已判定失效的源 validity === 'invalid'
            // 不参与检索，不计入总数；后端 /search/kazumi-stream 同步跳过）
            const rules = (typeof Kazumi !== 'undefined' && Kazumi._rules)
                ? Kazumi._rules.filter((r) => r.enabled !== false && r.validity !== 'invalid') : [];
            const total = rules.length;
            this._setStatus('正在检索 Kazumi 规则源…', { recv: 0, total, items: 0 });
            try {
                if (typeof Kazumi === 'undefined' || !Kazumi.hasEnabledRules) { this._setStatus('Kazumi 引擎不可用', { done: true, warnText: 'Kazumi 引擎不可用' }); return; }
                if (!Kazumi.hasEnabledRules()) { this._setStatus('尚未启用任何 Kazumi 规则', { done: true, warnText: '尚未启用任何 Kazumi 规则' }); return; }
            } catch (e) { /* ignore */ }
            let recv = 0;
            let shown = 0;
            let items = 0;
            // 验证码视觉 LLM 凭据随查询串传入（仅用于后端 ocrAvailable 探测与
            // 后续 solve 动作，检索本身零 LLM 请求；不配置时省略参数）。
            // 安全：captchaLLMKey 不随 URL 传输——EventSource 只能走 GET，完整
            // 查询串会被 uvicorn 访问日志原样记录，密钥会落进明文日志。
            // 方法在门面对象 Search 上（本处 this 是页签控制器），必须显式取。
            let llmQ = '';
            try {
                const llmP = await Search._captchaLlmParams();
                const { captchaLLMKey, ...safeLlm } = llmP; // eslint-disable-line no-unused-vars
                const qs = new URLSearchParams(safeLlm).toString();
                if (qs) llmQ = '&' + qs;
            } catch (e) { /* 读设置失败按未配置处理 */ }
            const es = new EventSource(apiUrl('/search/kazumi-stream?word=' + encodeURIComponent(word) + llmQ));
            this.es = es;
            es.onmessage = (ev) => {
                let payload;
                try { payload = JSON.parse(ev.data); } catch (e) { return; }
                recv += 1;
                if (payload.captcha) { this._renderKazumiCaptcha(payload); }
                const list = payload.list || [];
                // 屏蔽在 renderGroup 内收口：整组被屏蔽干净时按「该源无结果」处理
                const keptN = list.length ? (this.renderGroup(payload, list) || 0) : 0;
                if (keptN) { shown += 1; items += keptN; }
                // 已验证但无结果的源：非验证问题（该源没收录此词），把「已验证·搜索中…」
                // tab 收尾为「已验证·无结果」，不再静默消失
                if (payload.source && !list.length && !payload.captcha
                    && payload.status && payload.status !== 'error') {
                    this._retireVerifiedTab(String(payload.source.slice(7)));
                }
                this._setStatus('正在检索…', { recv, total, items });
            };
            es.addEventListener('done', () => {
                es.close();
                this.es = null;
                this._setStatus(items ? `完成：${shown} 个源 · ${items} 条结果` : '所有 Kazumi 规则源均未找到结果',
                    { recv, total, items, done: true });
                if (!items) $(cfg.resultsSel).html('<div class="tip-line">所有 Kazumi 规则源均未找到结果</div>');
                this._fillAllCovers();
                this._saveSnapshot(); // 结果快照落盘（切页/重启进搜索页可静默还原）
            });
            es.onerror = () => {
                if (this.es === null) return;
                es.close();
                this.es = null;
                if (!shown) { this._setStatus('Kazumi 搜索失败', { recv, total, done: true }); warnToast('Kazumi 搜索失败'); }
                else { this._setStatus(`完成：${shown} 个源 · ${items} 条结果`, { recv, total, items, done: true }); this._saveSnapshot(); }
            };
        },

        /** 验证码源提示：tab 进来源筛选分类区（不占影片卡区域），点击先尝试
         *  自动识别解题，失败回落验证窗口。同源去重（SSE 重复推送不叠加）。 */
        _renderKazumiCaptcha(payload) {
            const src = String(payload.source || '');
            const name = String(payload.name || src.slice(7) || '验证码源');
            // plugin 仅用于 HTML 插值（属性位）；选择器定位一律用「原始值 + CSS.escape」：
            // 属性选择器匹配的是 DOM 解码后的原值，escHtml 后的串含 &/'/" 时永不命中
            // （去重恒空 → SSE 重复推送叠加 tab；click 绑定落空）。与 _retireVerifiedTab
            // 的原始值口径保持一致。
            const rawPlugin = src.slice(7);
            const plugin = escHtml(rawPlugin);
            const $tabs = $(cfg.filtersSel);
            if ($tabs.find(`.kazumi-captcha-tab[data-captcha-src="${CSS.escape(rawPlugin)}"]`).length) return;
            const autoHint = payload.ocrAvailable ? ' ⚡可自动' : '';
            $tabs.append(`<span class="class-tab kazumi-captcha-tab" data-captcha-url="${escHtml(payload.captchaUrl || '')}" data-captcha-src="${plugin}" data-captcha-name="${escHtml(name)}" title="${escHtml(name)}：点击尝试自动识别，失败后打开验证窗口手动输入" tabindex="0">${escHtml(name)} 需验证${autoHint}</span>`);
            $tabs.find(`.kazumi-captcha-tab[data-captcha-src="${CSS.escape(rawPlugin)}"]`).on('click', (e) => {
                const $tab = $(e.currentTarget);
                const url = String($tab.data('captcha-url') || '');
                const pluginName = String($tab.data('captcha-src') || '');
                const fallback = () => this._openCaptchaFallback(url);
                if ($tab.hasClass('solving')) return;
                // 自动解题：后端取图→识别→提交→复验；成功后直接重搜
                if (pluginName && typeof doAction === 'function') {
                    $tab.addClass('solving').text(`${$tab.data('captcha-name')} 识别中…`);
                    // LLM 凭据异步取（非 async 回调：测试 VM 沙箱不支持函数体 await），
                    // 取到后再发 solve；读失败按未配置处理。
                    // 方法挂在门面对象 Search 上（本处 this 是页签控制器，取不到），
                    // 必须显式取且要判存在——直接在实参位置调用会在 Promise.resolve
                    // 求值前同步抛 TypeError，后面的 .catch 接不住，自动解题会永久
                    // 停在「识别中…」且不回落人工窗口。
                    const llmGetter = (typeof Search !== 'undefined' && Search._captchaLlmParams)
                        ? Search._captchaLlmParams.bind(Search) : null;
                    Promise.resolve(llmGetter ? llmGetter() : {}).catch(() => ({})).then((llmP) => {
                        return doAction('kazumiCaptchaSolve', { plugin: pluginName, ...llmP }, '/kazumi/action', 60000);
                    }).then((rsp) => {
                        if (rsp && rsp.result && rsp.result.ok) {
                            // 验证通过：tab 转为「已验证」态（成功样式），重搜后由真实结果接管；
                            // 若该源对这个词无收录（重搜无结果），保留「已验证·无结果」提示而非消失
                            $tab.removeClass('kazumi-captcha-tab solving').addClass('verified-empty')
                                .text(`${$tab.data('captcha-name')} 已验证·搜索中…`);
                            warnToast('验证码自动识别成功，正在重新搜索');
                            if (typeof this.run === 'function') this.run();
                        } else if (url) {
                            $tab.removeClass('solving').text(`${$tab.data('captcha-name')} 需手动`);
                            fallback();
                        } else {
                            const reason = rsp && rsp.result && rsp.result.reason;
                            $tab.removeClass('solving')
                                .text(`${$tab.data('captcha-name')} 失败${reason ? '（' + escHtml(String(reason)) + '）' : ''}`);
                        }
                    }).catch(() => {
                        $tab.removeClass('solving').text(`${$tab.data('captcha-name')} 需手动`);
                        fallback();
                    });
                    return;
                }
                fallback();
            });
        },

        /** 已验证源的收尾：重搜有结果 → tab 移除；仍无结果 → 变灰「已验证·无结果」。 */
        _retireVerifiedTab(pluginName) {
            const $tabs = $(cfg.filtersSel);
            const $tab = $tabs.find(`.verified-empty[data-captcha-src="${CSS.escape(pluginName)}"]`);
            if (!$tab.length) return;
            $tab.text(`${$tab.data('captcha-name')} 已验证·无结果`);
        },

        /** 自动解题失败回落：打开人工验证窗口，完成后重新搜索。 */
        _openCaptchaFallback(url) {
            if (url && typeof Kazumi !== 'undefined' && Kazumi._openCaptchaWindow) {
                Kazumi._openCaptchaWindow(url, () => { if (typeof this.run === 'function') this.run(); });
            } else {
                warnToast('该源暂无验证链接');
            }
        },

        /**
         * 渲染一个来源的搜索结果（聚合 SSE / Kazumi 聚合 / Kazumi 流式 / 快照还原 共用）。
         * 全局番剧屏蔽在此统一收口：标题命中屏蔽词的条目在进入分组前就被剔除，
         * 因此计数、分组卡、快照、分页全部只看到「过滤后」的结果——被屏蔽的番剧
         * 既不占位也不进快照，不会出现「结果数 10 但只显示 8 张卡」的错位。
         * @returns 过滤后的条数（0 表示整组被屏蔽干净，调用方按「该源无结果」处理）
         */
        renderGroup(payload, list) {
            const box = $(cfg.resultsSel);
            const src = payload.source || '';
            // 屏蔽过滤：Kazumi 结果用 name 字段、CatVod 结果用 vod_name
            const kept = (typeof filterBlocked === 'function')
                ? filterBlocked(Array.isArray(list) ? list : []) : (Array.isArray(list) ? list : []);
            const total = kept.length;
            // T60：无搜索结果的源不再显示（不出分组卡、不出来源筛选标签）
            if (!total) return 0;
            const head = `<div class="src-group" data-source="${escHtml(src)}"><div class="src-head">${escHtml(payload.name || src)} <span class="src-count">${total}</span></div>`;
            // 来源筛选标签：带结果数，点击只看该源
            $(cfg.filtersSel).append(`<span class="class-tab" data-src="${escHtml(src)}" title="只看该源的结果">${escHtml(payload.name || src)}（${total}）</span>`);
            // 组内分页：数据已全量在手，纯前端切片，统一分页器驱动
            const gid = cfg.gidPrefix + (this._grpSeq++);
            // name 一并记录：结果快照恢复时 renderGroup 需要展示名（_grpLists 原本只有 src/list）
            // raw 保留未过滤的原始结果：屏蔽词增删后就地重算（删词/关开关要能恢复显示）
            this._grpLists[gid] = { src, list: kept, raw: Array.isArray(list) ? list : kept, name: payload.name || src };
            box.append(head + `<div class="vod-grid" id="${gid}-grid"></div><div class="src-hint tip-line" id="${gid}-hint" style="display:none"></div><div class="pager" id="${gid}-pager"></div></div>`);
            this._paintGrp(gid, 1);
            // T41 修复：搜索进行中已切到单源视图时，新到达的组要立即按筛选隐藏
            //（此前后到的组直接按「全部」模式追加，往下滑会看到其他源的影片）
            if (this._curSrc && src !== this._curSrc) box.children('.src-group').last().hide();
            return total;
        },

        /**
         * 分组渲染（T38）：「全部」视图每组限显前 SEARCH_PAGE_SIZE 条不出分页器
         * （优先按源分类浏览）；点来源标签进单源视图后启用分页器翻看全部。
         */
        _paintGrp(gid, page) {
            const grp = this._grpLists[gid];
            if (!grp) return;
            const focused = this._curSrc && grp.src === this._curSrc;
            const size = this._size || SEARCH_PAGE_SIZE;
            const pagecount = focused ? Math.ceil(grp.list.length / size) : 1;
            const slice = grp.list.slice((page - 1) * size, page * size);
            const cards = slice.map((v) => {
                // Kazumi 结果无源封面：命中 Bangumi 封面缓存直接显示，未命中用占位图并标
                // data-cover-missing，由 fillMissingCovers 后台按片名从 Bangumi 拉取补上（T73）。
                // 封面多级兜底：官方 lain.bgm.tv 优先，加载失败自动换镜像 lain.{镜像根域名}（T76）。
                if (String(grp.src).startsWith('kazumi:')) {
                    const meta = (typeof Kazumi !== 'undefined' && Kazumi.getCachedBangumiMatch)
                        ? Kazumi.getCachedBangumiMatch(v.name) : null;
                    const cover = (meta && meta.cover) || '';
                    const coverHtml = cover ? bangumiCoverImg(cover, true) : vodCoverImg('', true);
                    // 备注/角标对齐 Bangumi 搜索卡（bangumiCard）：⭐评分 · 播出日期备注行 +
                    // #N 排名角标；缓存未命中（占位图阶段）时无数据，由补拉管线带上后重绘。
                    const score = (meta && meta.score) ? `⭐${escHtml(String(meta.score))}` : '';
                    const air = (meta && meta.air_date) ? escHtml(String(meta.air_date)) : '';
                    const rank = (meta && meta.rank)
                        ? `<span class="bangumi-rank-badge" title="Bangumi 排名 #${escHtml(String(meta.rank))}">#${escHtml(String(meta.rank))}</span>` : '';
                    // 总话数徽章（对齐时间表/推荐卡）：缓存匹配带 eps 时渲染「N话」，
                    // title 含完结判定（放送已完结 · 共 N 话，bangumiEpBadge 共享推算）；
                    // 无数据不渲染，由补拉管线重绘时带上
                    const epBadge = bangumiEpBadge(meta && meta.eps, meta && meta.air_date);
                    // 源徽章入左下徽标行（对齐时间表/推荐卡布局：话数徽章行首 +
                    // 源徽章在其右侧并排），不再是左上角独立徽章
                    return `<div class="vod-card kazumi-card" data-id="${escHtml(v.src)}" data-name="${escHtml(v.name)}" data-source="${escHtml(grp.src)}" tabindex="0">
                        <div class="vod-cover">${rank}${coverHtml}<div class="vod-fav-row"><span class="kazumi-badge">${escHtml(grp.src.slice(7))}</span>${epBadge}</div></div>
                        <div class="vod-name" title="${escHtml(v.name)}">${escHtml(truncateTitle(v.name))}</div>
                        <div class="vod-remarks">${escHtml([score, air].filter(Boolean).join(' · ') || 'Kazumi 规则源')}</div>
                    </div>`;
                }
                // T59：搜索当前页封面立即加载（eager），不再等懒加载触发；已补拉过的封面直接复用缓存，避免重绘后占位+重复请求
                const item = { ...v };
                // 审查3.6：getCachedCover 内存未命中时同步读穿 localStorage（common.js
                // _coverPersistGet → cache.js localCacheGet）。量级评估：该穿透读只取
                // 单条 ~150B 的封面 URL 字符串（一次 getItem + JSON.parse，微秒级；
                // 不涉及图片字节——图片本体经 <img> 异步加载），每分组首屏至多 24 次，
                // 开销与一次 innerHTML 写入同量级，不值得为省它改成「占位 + 微任务
                // 预热 + 命中后本帧二次刷新」的异步方案（多一次重排、要挂去重与销毁
                // 守卫）。首渲后真正耗时的缺图网络补拉已由 fillMissingCovers 异步承担。
                if (!item.vod_pic) item.vod_pic = getCachedCover(grp.src, v.vod_id);
                const html = vodCard(item, null, true);
                return html.replace('class="vod-card"', `class="vod-card" data-source="${escHtml(grp.src)}"`);
            }).join('');
            $(`#${gid}-grid`).html(cards);
            // T74 收尾：按当前列宽把标题 JS 截到恰好两行（DOM 不保留超行文字）
            fitVodTitles(`#${gid}-grid`);
            // 收藏徽标行（对齐时间表/推荐卡）：映射在手即挂；首渲触发懒加载
            this._ensureColStateMap();
            this._paintGrpFavBadges(gid);
            // 入场错峰：每个来源组各自独立错峰入场（common.js playCardsEnter，glass 模式下 CSS 端自动跳过）
            playCardsEnter(`#${gid}-grid`);
            // 记录本组渲染模式/页码，供切源时判断是否可保留 DOM（不销毁已加载图片）
            this._grpRendered[gid] = { mode: focused ? 'single' : 'all', page: focused ? page : 1 };
            // 每个来源到达后立即低并发补视口附近封面；全部来源结束后提升到 6 并补齐当前页。
            fillMissingCovers(`#${gid}-grid`, null, {
                concurrency: this.es ? 3 : 6,
                eager: !this.es,
                poolKey: 'search',
                retryDelay: 65000,
            });
            $(`#${gid}-hint`).text(`仅显示前 ${size} 条 · 点上方来源标签分页看全部`).toggle(!focused && grp.list.length > size);
            renderPagerBox($(`#${gid}-pager`), focused
                ? { page, pagecount, onJump: (pg) => this._paintGrp(gid, pg) }
                : { page: 1, pagecount: 1 });
        },

        /** 持久化本页签关键词（UIState；ui-state.js 未加载的沙箱环境静默跳过）。 */
        _saveWord(word) {
            try {
                if (typeof UIState === 'undefined' || !UIState.get || !UIState.set) return;
                const st = UIState.get('search') || {};
                st.words = (st.words && typeof st.words === 'object') ? st.words : {};
                st.words[cfg.stab] = String(word || '');
                if (typeof Search !== 'undefined' && Search._stab) st.stab = Search._stab;
                UIState.set('search', st);
            } catch (e) { /* 持久化失败不影响搜索 */ }
        },

        /** 结果快照落盘（限量限时）：切页/重启后进搜索页可静默还原上一次结果。
         *  空结果/验证码提示组（list 为空）不收录；超出 SEARCH_SNAP_MAX_GROUPS 的组丢弃。
         *  快照属于「页面状态记忆」功能：总开关关闭时不写（cache.js 键与 UIState 分离，需单独把门）。 */
        _saveSnapshot() {
            try {
                if (typeof UIState === 'undefined' || !UIState.isEnabled || !UIState.isEnabled()) return;
                if (typeof localCacheSet !== 'function') return;
                const groups = [];
                Object.keys(this._grpLists).forEach((gid) => {
                    const grp = this._grpLists[gid];
                    if (!grp || !grp.src || !Array.isArray(grp.list) || !grp.list.length) return;
                    if (groups.length >= SEARCH_SNAP_MAX_GROUPS) return;
                    groups.push({
                        src: String(grp.src),
                        name: String(grp.name || grp.src),
                        list: grp.list.slice(0, SEARCH_SNAP_MAX_ITEMS),
                    });
                });
                if (!groups.length) return;
                // B-10：快照最多 30 组 × 200 条（未裁剪源 vod 原样收录，最坏可达数 MB）
                // 显式落大池（yuki_bigcache::），与小池高频条目独立记账互不挤占
                //（优化.md 轻量方案裁决）。写侧预检体积：超 SEARCH_SNAP_MAX_BYTES（与
                // cache.js 大池上限对齐）时不落盘——cache.js 本会静默拒收（need >
                // maxBytes 先行拒绝不触发淘汰），这里补一次性 warn 留痕便于诊断；
                // 2~3MB 区间的快照则照常写入（LRU 按 t 淘汰自愈，见常量处取舍注释）。
                try {
                    const bytes = SEARCH_SNAP_KEY_PREFIX.length + JSON.stringify({ ts: Date.now(), groups }).length;
                    if (bytes > SEARCH_SNAP_MAX_BYTES) {
                        if (!SEARCH_SNAP_OVERSIZE_WARNED) {
                            SEARCH_SNAP_OVERSIZE_WARNED = true;
                            console.warn(`[search] 结果快照超限不落盘：key=${SEARCH_SNAP_KEY_PREFIX + cfg.mode} 约 ${Math.round(bytes / 1024)}KB（阈值 ${SEARCH_SNAP_MAX_BYTES / 1024 / 1024}MB，30 组×200 条源原样收录的最坏场景）`);
                        }
                        return;
                    }
                } catch (e2) { /* 估算失败照常尝试写入（cache.js 侧仍有兜底拒绝） */ }
                localCacheSet(SEARCH_SNAP_KEY_PREFIX + cfg.mode,
                    { ts: Date.now(), groups }, SEARCH_SNAP_TTL, { pool: 'big' });
            } catch (e) { /* 快照失败不影响主流程 */ }
        },

        /** 首次进入且无在途/已有结果时：用落盘快照静默重建分组与来源筛选行
         *  （复用 renderGroup 正常渲染链路，不弹进度条、不发网络请求）。
         *  总开关关闭时不还原（旧快照保留在盘，重开开关后仍可用）。 */
        async _restoreSnapshotOnce() {
            if (this.es || Object.keys(this._grpLists).length) return; // 在途搜索或已有结果不覆盖
            if (typeof UIState === 'undefined' || !UIState.isEnabled || !UIState.isEnabled()) return;
            if (typeof localCacheGet !== 'function') return;
            let snap = null;
            try { snap = localCacheGet(SEARCH_SNAP_KEY_PREFIX + cfg.mode); } catch (e) { return; }
            if (!snap || !Array.isArray(snap.groups)) return;
            const valid = snap.groups.filter((g) => g && g.src && Array.isArray(g.list) && g.list.length);
            if (!valid.length) return;
            // 快照令牌（L32 同型竞态守卫）：上方是同步检查，但下面的 pageSizeOf await
            // 之间存在宏任务窗口——期间用户点「搜索」会发起 run()（empty 容器 + 自增
            // _searchToken + _grpLists 清空重置），慢到的 restore 继续执行会把旧快照
            // 分组渲染进新搜索刚清空的容器。restore 前/渲染前重读令牌，与 run() 里
            // ++this._searchToken 的初始值比较：不等说明窗口内已有新搜索，放弃还原。
            const tokenAtStart = this._searchToken;
            this._size = (await pageSizeOf('pageSizeSearch')) || SEARCH_PAGE_SIZE;
            if (this._searchToken !== tokenAtStart || this.es
                || Object.keys(this._grpLists).length) return; // 窗口内有新搜索/已有结果：旧快照不得覆盖
            // 重置来源筛选栏为「全部」后逐组重放（renderGroup 会追加各自的筛选标签）
            $(cfg.filtersSel).html('<span class="class-tab active" data-src="">全部</span>').show();
            this._curSrc = '';
            valid.forEach((g) => this.renderGroup({ source: g.src, name: g.name }, g.list));
            this._fillAllCovers(); // 与搜索结束同参数补齐当前可见封面
        },

        /** 进入搜索页（app.js showView 调用）：重读「每页影片数量-搜索」设置，
         *  条数变化且页面上已有结果时立即按新条数重绘各分组（T39 补遗——搜索结果
         *  常驻不随视图切换销毁，此前改完设置要重新搜索一次才生效）。
         *  条数未变时对可见分组续拉一次缺位封面：Kazumi/Bangumi 负缓存 60s 过期后，
         *  这里是「离开再进搜索页」场景下唯一的重试触发点，否则一直停在占位图。 */
        async onViewShown() {
            await this._restoreSnapshotOnce(); // 无结果时先尝试快照还原（有结果则 no-op）
            const size = (await pageSizeOf('pageSizeSearch')) || SEARCH_PAGE_SIZE;
            const sizeChanged = this._size && size !== this._size;
            this._size = size;
            if (!Object.keys(this._grpLists).length) return;
            if (sizeChanged) {
                // 单源视图回第 1 页按新条数切片；封面均有缓存（_coverCache/Bangumi 匹配缓存），重绘无闪烁
                Object.keys(this._grpLists).forEach((gid) => this._paintGrp(gid, 1));
                return;
            }
            Object.keys(this._grpLists).forEach((gid) => {
                const grp = this._grpLists[gid];
                if (grp && (!this._curSrc || grp.src === this._curSrc)) fillMissingCovers(`#${gid}-grid`, null, {
                    concurrency: this.es ? 3 : 6, eager: !this.es, poolKey: 'search', retryDelay: 65000,
                });
            });
        },
    };
}

const Search = {
    _stab: 'aggregate', // 当前激活页签：aggregate | kazumi | bangumi | image
    agg: null,          // 聚合搜索页控制器（独立面板/状态）
    kz: null,           // Kazumi 源页控制器（独立面板/状态）

    /**
     * 验证码视觉 LLM 请求参数（settings → 请求字段的唯一汇聚点）。
     * settings 缺省时读一次设置快照。启用且 base/model 齐全才返回字段对象，
     * 否则空对象（solve doAction 的 kv / SSE 查询串直接展开合并）。
     * captchaLLMPrefer 一并带上：后端 solve 据此决定「先 LLM 还是先小模型」
     * 的识别次序（默认关=先小模型，见 kazumi/captcha.py）。本查询串会被
     * uvicorn 访问日志记录，故只允许非敏感的开关位随行——key 属凭据，已在
     * 下方 SSE 组装处显式剔除（见 llmQ）。
     */
    async _captchaLlmParams(settings) {
        const s = settings || await SettingsSnapshot.get();
        if (s.captchaLLMEnable !== true) return {};
        const base = String(s.captchaLLMBase || '').trim();
        const model = String(s.captchaLLMModel || '').trim();
        if (!base || !model) return {};
        return {
            captchaLLMBase: base,
            captchaLLMModel: model,
            captchaLLMKey: String(s.captchaLLMKey || '').trim(),
            captchaLLMPrefer: s.captchaLLMPrefer === true ? '1' : '0',
        };
    },

    init() {
        if (this.agg) return;
        // 聚合搜索沿用历史元素 id（外部引用零改动）；Kazumi 源启用 km- 前缀的新元素组
        this.agg = createSearchPage({
            mode: 'aggregate', stab: 'aggregate', gidPrefix: 'ag-sg',
            keywordSel: '#search-keyword', goSel: '#search-go',
            filtersSel: '#search-filters', statusSel: '#search-status', resultsSel: '#search-results',
        });
        this.kz = createSearchPage({
            mode: 'kazumi', stab: 'kazumi', gidPrefix: 'km-sg',
            keywordSel: '#kazumi-search-keyword', goSel: '#kazumi-search-go',
            filtersSel: '#kazumi-search-filters', statusSel: '#kazumi-search-status', resultsSel: '#kazumi-search-results',
        });
        this.agg.init();
        this.kz.init();
        // 页签切换：四个页签各自面板互斥可见（聚合/Kazumi 不再共用一套容器）
        $('#search-tabs').on('click', '.class-tab', (e) => {
            const el = $(e.currentTarget);
            $('#search-tabs .class-tab').removeClass('active');
            el.addClass('active');
            this._stab = String(el.data('stab') || 'aggregate');
            this._saveShell(); // 页签持久化（切页/重启回到上次的搜索页签）
            const isImage = this._stab === 'image';
            const isBangumi = this._stab === 'bangumi';
            const isAgg = this._stab === 'aggregate';
            const isKaz = this._stab === 'kazumi';
            $('#aggregate-search-panel').toggle(isAgg);
            $('#kazumi-search-panel').toggle(isKaz);
            $('#image-search-panel').toggle(isImage);
            $('#image-search-results').toggle(isImage);
            $('#bangumi-search-panel').toggle(isBangumi);
            if (isBangumi && typeof BangumiSearch !== 'undefined') {
                BangumiSearch.init();
                $('#bgm-search-keyword').trigger('focus');
            } else if (isAgg) {
                $('#search-keyword').trigger('focus');
            } else if (isKaz) {
                $('#kazumi-search-keyword').trigger('focus');
            }
        });
        this._initImageSearch();
    },

    /** 聚焦当前页签的搜索框（app.js showView('search') 时调用）。 */
    focus() {
        if (this._stab === 'bangumi') { $('#bgm-search-keyword').trigger('focus'); return; }
        if (this._stab === 'kazumi') { $('#kazumi-search-keyword').trigger('focus'); return; }
        $('#search-keyword').trigger('focus');
    },

    /** 页签/关键词持久化（ui-state.js 未加载的沙箱环境静默跳过）。
     *  words 由各页签控制器 _saveWord 增量维护，这里只整体透传保留。 */
    _saveShell() {
        try {
            if (typeof UIState === 'undefined' || !UIState.get || !UIState.set) return;
            const prev = UIState.get('search') || {};
            UIState.set('search', { stab: this._stab, words: prev.words || {} });
        } catch (e) { /* 持久化失败不影响主流程 */ }
    },

    /** 首次进入搜索视图时恢复持久化的页签与各页签关键词（切页/重启不回初始态）。
     *  仅一次：之后以用户实际操作为准，不再反向覆盖。 */
    _restoreShellOnce() {
        if (this._shellRestored) return;
        this._shellRestored = true;
        let st = null;
        try { st = (typeof UIState !== 'undefined' && UIState.get) ? UIState.get('search') : null; } catch (e) { st = null; }
        if (!st) return;
        const words = (st.words && typeof st.words === 'object') ? st.words : {};
        // 关键词回填（聚合/Kazumi/Bangumi 输入框；无记录的不动）
        try {
            if (words.aggregate) $('#search-keyword').val(String(words.aggregate));
            if (words.kazumi) $('#kazumi-search-keyword').val(String(words.kazumi));
            if (words.bangumi) $('#bgm-search-keyword').val(String(words.bangumi));
        } catch (e) { /* 回填失败不影响展示 */ }
        // 页签还原：激活目标 tab（复用点击链路，面板互斥/聚焦逻辑一并生效）
        const stab = ['aggregate', 'kazumi', 'bangumi', 'image'].indexOf(st.stab) >= 0 ? st.stab : '';
        if (stab && stab !== this._stab) {
            const $tab = $(`#search-tabs .class-tab[data-stab="${stab}"]`);
            if ($tab.length) $tab.trigger('click');
        }
    },

    onViewShown() {
        this._restoreShellOnce(); // 首次切入恢复页签/关键词（仅一次）
        if (this.agg) this.agg.onViewShown();
        if (this.kz) this.kz.onViewShown();
        if (typeof BangumiSearch !== 'undefined' && BangumiSearch.onViewShown) BangumiSearch.onViewShown(); // 每页条数变更后重拉（服务端分页）
    },

    stop() {
        if (this.agg) this.agg.stop();
        if (this.kz) this.kz.stop();
    },

    /** 以图搜番（2.3）：选择本地图片或粘贴 URL → trace.moe 识别 → 结果卡片。 */
    _initImageSearch() {
        $('#image-search-pick').on('click', () => $('#image-search-file').trigger('click'));
        $('#image-search-file').on('change', (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            this._pendingImage = f;
            $('#image-search-preview').text(`已选择：${f.name}（≤25MB）`).show();
        });
        $('#image-search-go').on('click', async () => {
            const url = $('#image-search-url').val().trim();
            // 有 URL 时优先 URL，避免残留的已选文件覆盖 URL 搜索
            const file = url ? null : this._pendingImage;
            if (!url && !file) { warnToast('请选择图片或粘贴图片 URL'); return; }
            if (typeof Kazumi === 'undefined' || !Kazumi.imageSearch) { warnToast('以图搜番不可用'); return; }
            showLoading();
            try {
                let out;
                if (file) out = await Kazumi.imageSearch(file);
                else out = await Kazumi.imageSearch(url);
                hideLoading();
                if (out && out.error) warnToast('以图搜番失败：' + errorTextOf(out.error));
                this._renderImageResults((out && out.results) || []);
            } catch (e) {
                hideLoading();
                warnToast('以图搜番失败');
            } finally {
                // 用掉即清：下次搜索需重新选择文件
                this._pendingImage = null;
                $('#image-search-preview').hide().text('');
            }
        });
    },

    /** 渲染以图搜番结果卡片（标题/缩略图/集数/相似度/时间区间）。 */
    _renderImageResults(results) {
        const box = $('#image-search-results').empty().show();
        if (!results || !results.length) {
            box.html('<div class="tip-line">未识别到番剧</div>');
            return;
        }
        const grid = $('<div class="vod-grid"></div>').appendTo(box);
        results.forEach((r) => {
            // 对齐 Kazumi ImageSearchModule：anilist 字段包含完整元数据
            const anilist = r.anilist || {};
            const anilistTitle = anilist.title || {};
            const title = anilistTitle.chinese || anilistTitle.native || anilistTitle.romaji || (r.filename || '未知番剧');
            const ep = r.episode ? `第 ${r.episode} 集` : '';
            const sim = (typeof r.similarity === 'number') ? `相似度 ${Math.round(r.similarity * 100)}%` : '';
            const from = (r.from !== undefined && r.to !== undefined)
                ? `${Math.floor(r.from / 60)}:${String(Math.floor(r.from % 60)).padStart(2, '0')}-${Math.floor(r.to / 60)}:${String(Math.floor(r.to % 60)).padStart(2, '0')}`
                : '';
            // T74 封面多级兜底：AniList 封面（清晰竖版）→ trace.moe 匹配帧（api.trace.moe 必然可达，且展示命中场景）→ 占位图。
            // 原 onerror 直接隐藏 img 会在 AniList 被墙/慢时留灰底空框 =「图片显示不正常」。
            const anilistCover = (anilist.coverImage && (anilist.coverImage.large || anilist.coverImage.medium)) || '';
            const img = vodCoverChain([anilistCover, r.image || ''], true);
            const meta = [title, ep, sim, from].filter(Boolean).join(' · ');
            grid.append(`<div class="vod-card image-search-result" data-name="${escHtml(title)}" tabindex="0">
                <div class="vod-cover">${img || vodCoverImg('')}</div>
                <div class="vod-name" title="${escHtml(meta)}">${escHtml(meta)}</div>
                <div class="vod-remarks">以图搜番</div>
            </div>`);
        });
        // T74 收尾：按当前列宽把标题 JS 截到恰好两行（DOM 不保留超行文字）
        fitVodTitles(grid);
        // 入场错峰：识别结果一次性渲染完再整体错峰入场（common.js playCardsEnter）
        playCardsEnter(grid);
        // 点结果回填 Kazumi 源页关键词并切到该页签搜索（从 Kazumi 规则源找片源；
        // 两页签结果相互独立，不影响聚合搜索页已有内容）
        grid.on('click', '.image-search-result', (e) => {
            const name = String($(e.currentTarget).data('name') || '');
            $('#kazumi-search-keyword').val(name);
            $('#search-tabs .class-tab[data-stab="kazumi"]').trigger('click');
            if (this.kz) this.kz.run();
        });
    },
};

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.search = Search;
}(typeof window !== 'undefined' ? window : globalThis));
