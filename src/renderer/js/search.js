/**
 * search.js — 多源聚合搜索（Phase 2）
 *
 * 走 SSE 端点 GET /search/stream?word=，后端每个源完成即推一条 data：
 *   data: {"source": key, "name": 名称, "list": [...]}
 * 全部结束发 event: done。逐源流式追加渲染；结果项点击进详情。
 * 来源筛选：每收到一个源生成一枚筛选标签，点击只看该源结果。
 * 分页（T38）：「全部」视图每组限显前 20 条（无分页器，超出的点上
 * 方来源标签进单源视图）；单源视图启用统一分页器，每页 20 条翻
 * 看该源全部结果；数据已由 SSE 一次给全，纯前端切片，避免千百条撑爆 DOM。
 */
/* global $, apiUrl, escHtml, warnToast, Detail, vodCard, vodCoverImg, renderPagerBox, pageSizeOf, fillMissingCovers, abortCoverFill, getCachedCover, showLoading, hideLoading, doAction, Kazumi, fitVodTitles, renderStatusBar, openDialog, closeDialog, errorTextOf */

const SEARCH_PAGE_SIZE = 20; // 兜底值；实际每页条数取「搜索页每页条数」设置（T39）

const Search = {
    es: null,
    _inited: false,
    _searchToken: 0, // M-30a：搜索令牌（run 自增；旧词在途回调据此丢弃）
    _size: 0,        // 本次搜索生效的每页条数（run 时按设置解析一次）
    _curSrc: '',     // 当前筛选源（空 = 「全部」视图，限显前 20 条）
    _grpSeq: 0,      // 分组 id 自增序号（分页容器唯一定位）
    _grpLists: {},   // gid → { src, list }（SSE 已给全量，纯前端切片翻页）
    _grpRendered: {}, // gid → { mode: 'all'|'single', page }：切源时判断是否已按目标模式渲染，避免重绘销毁已加载图片
    _stab: 'aggregate', // 搜索页签：aggregate=聚合搜索 | kazumi=Kazumi 源 | image=以图搜番（2.3）
    _statusShown: false,    // 进度条是否已显示（T82：首个结果或超 1s 才显示，避免快速搜索闪现）
    _statusTimer: null,     // 1s 延迟显示定时器
    _statusDoneTimer: null, // 完成态 1.5s 隐藏定时器
    _lastStatus: null,      // 最近一次进度状态（延迟显示到点后渲染用）

    init() {
        if (this._inited) return;
        this._inited = true;
        $('#search-go').on('click', () => this.run());
        $('#search-keyword').on('keydown', (e) => {
            if (e.key === 'Enter') { e.target.blur(); this.run(); }
        });
        // 页签切换（2.3）：聚合 / Kazumi 源 / Bangumi / 以图搜番
        $('#search-tabs').on('click', '.class-tab', (e) => {
            const el = $(e.currentTarget);
            $('#search-tabs .class-tab').removeClass('active');
            el.addClass('active');
            this._stab = String(el.data('stab') || 'aggregate');
            const isImage = this._stab === 'image';
            const isBangumi = this._stab === 'bangumi';
            const isAgg = !isImage && !isBangumi;
            $('#search-bar-agg').toggle(isAgg);
            $('#image-search-panel').toggle(isImage);
            $('#image-search-results').toggle(isImage);
            $('#bangumi-search-panel').toggle(isBangumi);
            $('#search-filters, #search-results').toggle(isAgg);
            // T83：#search-status 只在有进行中的搜索状态时才随页签显示，避免切页签凭空出现并常驻
            $('#search-status').toggle(isAgg && this._statusShown);
            if (isBangumi && typeof BangumiSearch !== 'undefined') {
                BangumiSearch.init();
                $('#bgm-search-keyword').trigger('focus');
            } else if (isAgg) {
                $('#search-keyword').trigger('focus');
            }
        });
        this._initImageSearch();
        $('#search-results').on('click', '.vod-card', (e) => {
            const el = $(e.currentTarget);
            const src = String(el.data('source') || '');
            // Kazumi 结果：自动匹配 Bangumi 元数据，匹配成功进 Bangumi 详情页
            if (src.startsWith('kazumi:') && typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                const name = el.data('name') || '';
                const fallback = () => Kazumi.openSourceDialog(name, src, el.data('id') || '');
                // T73 优化：封面补拉时已缓存 Bangumi 匹配（含 id）→ 直接进二级详情页，
                // 免一次重复搜索，且封面与详情保证同一部番（不因两次搜索首条不同而错位）。
                let cachedMatch = null;
                if (name && typeof Kazumi.getCachedBangumiMatch === 'function') cachedMatch = Kazumi.getCachedBangumiMatch(name);
                if (cachedMatch && cachedMatch.id && typeof Kazumi.openBangumiInfoPage === 'function') {
                    Kazumi.openBangumiInfoPage(cachedMatch.id);
                    return;
                }
                if (name && typeof Kazumi.bangumiSearch === 'function') {
                    Kazumi.bangumiSearch(name).then((bgmResults) => {
                        if (bgmResults && bgmResults.length && bgmResults[0].id) {
                            // 回填缓存（补 id 后下次免搜）
                            if (typeof Kazumi.cacheBangumiMatch === 'function') {
                                const r0 = bgmResults[0];
                                const cv = bangumiCover(r0.images, 'card');   // 网格卡封面缓存（T75）
                                Kazumi.cacheBangumiMatch(name, r0.id, cv);
                            }
                            const id = bgmResults[0].id;
                            if (typeof Kazumi.openBangumiInfoPage === 'function') Kazumi.openBangumiInfoPage(id);
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
            Detail.open(src, el.data('id'), el.data('name'));
        });
        // 来源筛选标签：全部（限显前 20 条）/ 单源（分页看全部）
        $('#search-filters').on('click', '.class-tab', (e) => {
            const el = $(e.currentTarget);
            $('#search-filters .class-tab').removeClass('active');
            el.addClass('active');
            const cur = String(el.data('src') || '');
            this._curSrc = cur;
            const targetMode = cur ? 'single' : 'all';
            // T39 修复：jQuery each 内 this 是 DOM 元素，不能 .bind(this)（此前导致点源不筛选）
            $('#search-results .src-group').each(function () {
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
                        concurrency: this.es ? 3 : 6, eager: !this.es, poolKey: 'search',
                    });
                });
            }
        });
    },

    focus() {
        $('#search-keyword').trigger('focus');
    },

    stop() {
        if (this.es) { try { this.es.close(); } catch (e) { /* ignore */ } this.es = null; }
        // T82：重置进度条状态并隐藏
        this._statusShown = false;
        clearTimeout(this._statusTimer);
        clearTimeout(this._statusDoneTimer);
        this._lastStatus = null;
        $('#search-status').hide();
    },

    /** 搜索进度提示（T74）：spinner + 进度条 + 计数，替代纯文字；空档也有即时视觉反馈。 */
    /**
     * 搜索进度提示（T74/T82）：spinner + 进度条 + 计数，替代纯文字。
     * 显示逻辑同首页：有首个结果(recv>0)或超 1s 才显示（避免快速搜索闪现）；完成态约 1.5s 后淡出隐藏。
     * 渲染走 renderStatusBar——spinner 元素稳定不重建，旋转动画不卡顿。
     */
    _setStatus(text, opts) {
        const el = $('#search-status');
        if (!el.length) return;
        const o = opts || {};
        const isDone = !!o.done;
        this._lastStatus = o;
        // 显示时机：非完成态且有首个结果才立即显示；recv=0 时等 1s（快速搜索不闪现）。
        // 切到「以图搜番」页签时搜索仍在后台跑，但状态不显示（T83）。
        if (!this._statusShown && !isDone) {
            if (o.recv > 0) {
                this._statusShown = true;
                clearTimeout(this._statusTimer);
                if (this._stab !== 'image') el.show();
            } else {
                if (!this._statusTimer) {
                    this._statusTimer = setTimeout(() => {
                        if (!this._statusShown) {
                            this._statusShown = true;
                            renderStatusBar($('#search-status'), this._lastStatus);
                            if (this._stab !== 'image') $('#search-status').show();
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
                    $('#search-status').hide();
                    this._statusShown = false;
                }, 1500);
            } else {
                el.hide(); // 快速搜索未显示过：不闪现完成态
            }
            return;
        }
        renderStatusBar(el, o);
    },

    async run() {
        const word = $('#search-keyword').val().trim();
        if (!word) { warnToast('请输入关键字'); return; }
        const myToken = ++this._searchToken; // M-30a：搜索令牌——旧词在途回调不作数
        // T39：每页条数取「搜索页」单独设置（默认 20）
        this._size = (await pageSizeOf('pageSizeSearch')) || SEARCH_PAGE_SIZE;
        this.stop();
        $('#search-results').empty();
        this._grpLists = {}; // 新搜索：重置分组数据
        this._grpSeq = 0;
        this._curSrc = '';
        this._grpRendered = {}; // 新搜索：重置分组渲染状态
        // 重置来源筛选栏（默认「全部」）
        $('#search-filters').html('<span class="class-tab active" data-src="">全部</span>').show();
        // T74：立即显示带 spinner 的进度提示（首个源到达前无空档）
        this._setStatus('正在搜索…', { recv: 0, items: 0 });

        // Kazumi 源页签：只走规则引擎搜索，不走 SSE
        if (this._stab === 'kazumi') {
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
            if (list.length) { shown += 1; items += list.length; this.renderGroup(payload, list); }
            this._setStatus('正在搜索…', { recv, total, items });
        };

        const finish = () => {
            es.close();
            this.es = null;
            kazumiDone = true;
            this._setStatus(items ? `完成：${shown} 个源 · ${items} 条结果` : '无结果', { recv, total, items, done: true });
            if (!items) $('#search-results').html('<div class="tip-line">无结果</div>');
            this._fillAllCovers();
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
                    this.renderGroup(payload, data);
                    if (data.length) { shown += 1; items += data.length; } // T60：只统计有结果的源
                });
                // 已结束时更新为最终状态（含 Kazumi 结果）
                this._setStatus(items ? `完成：${shown} 个源 · ${items} 条结果` : '无结果',
                    { recv, total, items, done: kazumiDone });
                if (kazumiDone && !items) $('#search-results').html('<div class="tip-line">无结果</div>');
            }).catch(() => { /* Kazumi 搜索失败不影响 CatVod 结果 */ });
        }
    },

    /** 搜索结束后提高并发并补完整个当前页面；可见卡仍优先。 */
    _fillAllCovers() {
        Object.keys(this._grpLists).forEach((gid) => fillMissingCovers(
            `#${gid}-grid`, null, { concurrency: 6, eager: true, poolKey: 'search' }));
    },

    /** Kazumi 源专属搜索（2.3，T73 边搜边加载）：走 SSE 流式端点，每个规则源完成即推一条 data 渲染刷新，
     *  不再等全部源结束才显示。验证码源单独提示分组。进度条按启用规则数确定。 */
    async _runKazumi(word) {
        this.stop();
        // 已知启用规则数 → 确定进度条
        const rules = (typeof Kazumi !== 'undefined' && Kazumi._rules) ? Kazumi._rules.filter((r) => r.enabled !== false) : [];
        const total = rules.length;
        this._setStatus('正在检索 Kazumi 规则源…', { recv: 0, total, items: 0 });
        try {
            if (typeof Kazumi === 'undefined' || !Kazumi.hasEnabledRules) { this._setStatus('Kazumi 引擎不可用', { done: true }); return; }
            if (!Kazumi.hasEnabledRules()) { this._setStatus('尚未启用任何 Kazumi 规则', { done: true }); return; }
        } catch (e) { /* ignore */ }
        let recv = 0;
        let shown = 0;
        let items = 0;
        const es = new EventSource(apiUrl('/search/kazumi-stream?word=' + encodeURIComponent(word)));
        this.es = es;
        es.onmessage = (ev) => {
            let payload;
            try { payload = JSON.parse(ev.data); } catch (e) { return; }
            recv += 1;
            if (payload.captcha) { this._renderKazumiCaptcha(payload); }
            const list = payload.list || [];
            if (list.length) { shown += 1; items += list.length; this.renderGroup(payload, list); }
            this._setStatus('正在检索…', { recv, total, items });
        };
        es.addEventListener('done', () => {
            es.close();
            this.es = null;
            this._setStatus(items ? `完成：${shown} 个源 · ${items} 条结果` : '所有 Kazumi 规则源均未找到结果',
                { recv, total, items, done: true });
            if (!items) $('#search-results').html('<div class="tip-line">所有 Kazumi 规则源均未找到结果</div>');
            this._fillAllCovers();
        });
        es.onerror = () => {
            if (this.es === null) return;
            es.close();
            this.es = null;
            if (!shown) { this._setStatus('Kazumi 搜索失败', { recv, total, done: true }); warnToast('Kazumi 搜索失败'); }
            else this._setStatus(`完成：${shown} 个源 · ${items} 条结果`, { recv, total, items, done: true });
        };
    },

    /** 渲染验证码源提示分组（点击打开验证窗口，T73；后续 #11 弹窗验证完善）。 */
    _renderKazumiCaptcha(payload) {
        const box = $('#search-results');
        const src = String(payload.source || '');
        const name = String(payload.name || src.slice(7) || '验证码源');
        const gid = 'sg' + (this._grpSeq++);
        this._grpLists[gid] = { src, list: [] };
        this._grpRendered[gid] = { mode: 'all', page: 1 };
        box.append(`<div class="src-group" data-source="${escHtml(src)}">
            <div class="src-head">${escHtml(name)} <span class="src-count" style="color:var(--md-error)">需验证</span></div>
            <div class="kazumi-captcha-line" data-captcha-url="${escHtml(payload.captchaUrl || '')}" title="点击打开验证窗口，完成后重新搜索" tabindex="0">该源需要验证码验证 · 点击尝试</div>
        </div>`);
        box.find(`.src-group[data-source="${escHtml(src)}"] .kazumi-captcha-line`).on('click', (e) => {
            const url = String($(e.currentTarget).data('captcha-url') || '');
            if (url && typeof Kazumi !== 'undefined' && Kazumi._openCaptchaWindow) {
                Kazumi._openCaptchaWindow(url, () => { if (typeof this.run === 'function') this.run(); });
            } else {
                warnToast('该源暂无验证链接');
            }
        });
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
        // 点结果回填搜索词并默认切到 Kazumi 源页签搜索（从 Kazumi 规则源找片源）
        grid.on('click', '.image-search-result', (e) => {
            const name = String($(e.currentTarget).data('name') || '');
            $('#search-keyword').val(name);
            $('#search-tabs .class-tab[data-stab="kazumi"]').trigger('click');
            this.run();
        });
    },

    renderGroup(payload, list) {
        const box = $('#search-results');
        const src = payload.source || '';
        const total = list.length;
        // T60：无搜索结果的源不再显示（不出分组卡、不出来源筛选标签）
        if (!total) return;
        const head = `<div class="src-group" data-source="${escHtml(src)}"><div class="src-head">${escHtml(payload.name || src)} <span class="src-count">${total}</span></div>`;
        // 来源筛选标签：带结果数，点击只看该源
        $('#search-filters').append(`<span class="class-tab" data-src="${escHtml(src)}" title="只看该源的结果">${escHtml(payload.name || src)}（${total}）</span>`);
        // 组内分页：数据已全量在手，纯前端切片，统一分页器驱动
        const gid = 'sg' + (this._grpSeq++);
        this._grpLists[gid] = { src, list };
        box.append(head + `<div class="vod-grid" id="${gid}-grid"></div><div class="src-hint tip-line" id="${gid}-hint" style="display:none"></div><div class="pager" id="${gid}-pager"></div></div>`);
        this._paintGrp(gid, 1);
        // T41 修复：搜索进行中已切到单源视图时，新到达的组要立即按筛选隐藏
        //（此前后到的组直接按「全部」模式追加，往下滑会看到其他源的影片）
        if (this._curSrc && src !== this._curSrc) box.children('.src-group').last().hide();
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
            // 封面多级兜底：官方 lain.bgm.tv 优先，加载失败自动换镜像 lain.bangumi.pro（T76）。
            if (String(grp.src).startsWith('kazumi:')) {
                let cover = '';
                if (typeof Kazumi !== 'undefined' && Kazumi.getCachedBangumiCover) cover = Kazumi.getCachedBangumiCover(v.name) || '';
                const coverHtml = cover ? bangumiCoverImg(cover, true) : vodCoverImg('', true);
                return `<div class="vod-card kazumi-card" data-id="${escHtml(v.src)}" data-name="${escHtml(v.name)}" data-source="${escHtml(grp.src)}" tabindex="0">
                    <div class="vod-cover"><div class="kazumi-badge">${escHtml(grp.src.slice(7))}</div>${coverHtml}</div>
                    <div class="vod-name" title="${escHtml(v.name)}">${escHtml(truncateTitle(v.name))}</div>
                    <div class="vod-remarks">Kazumi 规则源</div>
                </div>`;
            }
            // T59：搜索当前页封面立即加载（eager），不再等懒加载触发；已补拉过的封面直接复用缓存，避免重绘后占位+重复请求
            const item = { ...v };
            if (!item.vod_pic) item.vod_pic = getCachedCover(grp.src, v.vod_id);
            const html = vodCard(item, null, true);
            return html.replace('class="vod-card"', `class="vod-card" data-source="${escHtml(grp.src)}"`);
        }).join('');
        $(`#${gid}-grid`).html(cards);
        // T74 收尾：按当前列宽把标题 JS 截到恰好两行（DOM 不保留超行文字）
        fitVodTitles(`#${gid}-grid`);
        // 记录本组渲染模式/页码，供切源时判断是否可保留 DOM（不销毁已加载图片）
        this._grpRendered[gid] = { mode: focused ? 'single' : 'all', page: focused ? page : 1 };
        // 每个来源到达后立即低并发补视口附近封面；全部来源结束后提升到 6 并补齐当前页。
        fillMissingCovers(`#${gid}-grid`, null, {
            concurrency: this.es ? 3 : 6,
            eager: !this.es,
            poolKey: 'search',
        });
        $(`#${gid}-hint`).text(`仅显示前 ${size} 条 · 点上方来源标签分页看全部`).toggle(!focused && grp.list.length > size);
        renderPagerBox($(`#${gid}-pager`), focused
            ? { page, pagecount, onJump: (pg) => this._paintGrp(gid, pg) }
            : { page: 1, pagecount: 1 });
    },
};

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.search = Search;
}(typeof window !== 'undefined' ? window : globalThis));
