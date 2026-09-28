/**
 * detail.js — 统一详情页（合并 CatVod 与 Bangumi 详情，仿 Kazumi InfoPage 设计）
 *
 * 布局：
 *  - 头部：封面 + 标题/元信息 + 收藏/标记按钮
 *  - 页签：概览 | 分集 | 选集讨论 | 吐槽 | 角色 | 制作 | 关联
 *  - 概览：可收起简介 + 播放源/选集
 *  - 其他页签：Bangumi 数据（仅当匹配到 Bangumi 时显示）
 */
/* global $, doAction, escHtml, stripHtml, normalizePic, warnToast, showLoading, hideLoading, registerEsc, openDialog, closeDialog, App, Player, Records, abortCoverFill, Kazumi, FavHub, bangumiCover, localCacheGet, localCacheSet, localCacheDel, BgmRate */

const DETAIL_TABS = ['概览', '分集', '选集讨论', '吐槽', '角色', '制作', '关联'];

/** 详情内容缓存（T74）：site|vodId → vod。迁移到 localStorage 持久缓存（cache.js），
 *  重复打开 / 重启即时上屏免重新拉取。TTL 见各写入点；纳入设置页「清理缓存」。 */
const DETAIL_CACHE_TTL = 10 * 60 * 1000;
const DETAIL_VOD_CACHE_PREFIX = 'detail::vod::v1::';       // + site|vodId → CatVod 详情
const DETAIL_BGMEXTRA_CACHE_PREFIX = 'detail::bgmextra::v1::'; // + bgmId → {comments,characters,staff,relations}
const DETAIL_BGMEXTRA_TTL = 30 * 60 * 1000;                // Bangumi 角色/制作/关联/吐槽 30 分钟

/** 读 localStorage 详情缓存（未命中/无 helper 返回 null）。 */
function _detailCacheGet(prefix, key) {
    if (typeof localCacheGet !== 'function' || !key) return null;
    try { return localCacheGet(prefix + key); } catch (e) { return null; }
}
/** 写 localStorage 详情缓存（空值不落盘，无 helper 静默跳过）。 */
function _detailCacheSet(prefix, key, value, ttl) {
    if (typeof localCacheSet !== 'function' || !key || value == null) return;
    try { localCacheSet(prefix + key, value, ttl); } catch (e) { /* 缓存失败忽略 */ }
}

const Detail = {
    site: '',
    vodId: '',
    backView: 'home',
    _backStack: [],   // 详情页内嵌跳转（如关联→新详情页）的回退栈，存上一详情页的恢复快照
    sources: [],
    activeSource: 0,
    _epDesc: false,
    _bgmEpDesc: false,
    _bgmSelectMode: false,  // Bangumi 分集多选模式（默认关，点「多选」显示勾选框+全选）
    _epSelectMode: false,   // CatVod 分集多选模式
    _commentDesc: true,     // 吐槽排序：false=正序（时间旧→新），true=倒序（时间新→旧，默认）
    _charFilter: 'main',    // 角色筛选：main=主角+配角（默认）/lead/support/minor/all
    _staffFilter: 'all',    // 制作职业筛选：_staffJobCategories 的 key（默认全部）
    _commentLimit: 20,      // 吐槽当前展示条数（下拉加载递增）
    _commentTotal: 0,       // 吐槽真实总数（next.bgm total，与分页无关；0=未知，回退已加载数）
    _charCommentDesc: true, // 角色吐槽排序默认倒序（同番剧吐槽）
    _epComments: [],        // 选集评论（当前选中集；next.bgm /p1/episodes/{id}/comments）
    _epCommentsEpisodeId: 0, // 当前集对应的 Bangumi episode_id（防集号歧义：SP/OP/ED 同号）
    _epCommentsDesc: true,  // 选集评论排序（同吐槽默认倒序）
    _epCommentsLoading: false,
    _epCommentsGen: 0,      // 选集评论加载世代：切换番剧/集数作废在途请求
    _escBound: false,
    _lastVod: null,
    _vod: null,
    _bgmInfo: null,      // Bangumi 匹配到的信息
    _bgmId: null,         // Bangumi subject ID
    _activeTab: '概览',
    _descCollapsed: true, // 简介折叠态（默认收起三行；点「展开全部」看全文）
    _tagsExpanded: false, // 概览 Bangumi 标签展开状态（默认只展示前 13 个，点「展开全部」看全部）
    _comments: [],
    _characters: [],
    _staff: [],
    _relations: [],
    _bgmEps: null,      // Bangumi 分集列表（分集/选集讨论页签共用；_renderBgmEpisodes/_ensureBgmEpisodes 写入）
    _bgmExtraLoaded: false,
    _bgmExtraGen: 0,     // Bangumi 补充数据加载世代：每次导航/重载自增，作废在途的旧 subject 异步结果
    _loadGen: 0,         // 详情主请求世代（P2-4）：load()/openBangumi() 共用同一详情页状态，
                         // 每次入口自增；await 返回后不一致即丢弃，防 A→B 乱序写出混合收藏条目

    init() {
        if (this._escBound) return;
        this._escBound = true;
        // 订阅收藏变更（Kazumi CollectButton 模式：状态变更后自动刷新按钮高亮）
        if (typeof FavHub !== 'undefined' && FavHub.onChanged) {
            this._unsubFav = FavHub.onChanged(() => {
                if (typeof App === 'undefined' || App.currentView !== 'detail') return;
                this._refreshLocalCol();
                // 同步刷新 Bangumi 收藏按钮高亮（如有匹配）
                if (this._bgmId && typeof Kazumi !== 'undefined' && Kazumi._applyBangumiColState) {
                    Kazumi._applyBangumiColState(this._bgmId);
                }
            });
        }
        $('#detail-back').on('click', () => this.back());
        $('#detail-body')
            .on('click', '.play-src', (e) => {
                const idx = parseInt($(e.currentTarget).data('idx'), 10);
                this.selectSource(idx);
            })
            .on('click', '.ep-btn', (e) => {
                const el = $(e.currentTarget);
                const idx = parseInt(el.data('idx'), 10);
                this._playEpisode(idx);
            })
            .on('click', '.detail-cover img', (e) => {
                this._openCoverFloat($(e.currentTarget).attr('src'));
            })
            .on('click', '.ep-check', (e) => {
                e.stopPropagation();
                $(e.currentTarget).toggleClass('checked');
                this._syncDlBar();
            })
            .on('click', '.ep-dl-one', (e) => {
                e.stopPropagation();
                const idx = parseInt($(e.currentTarget).data('idx'), 10);
                this._downloadEps(this.sources[this.activeSource], [idx]);
            })
            .on('change', '#ep-check-all', (e) => {
                $('#ep-list .ep-check').toggleClass('checked', e.currentTarget.checked);
                this._syncDlBar();
            })
            .on('click', '#ep-dl-selected', () => this.downloadSelected())
            .on('click', '#ep-order', () => this.toggleEpOrder())
            .on('click', '#ep-play-selected', () => this.playSelected())
            .on('click', '.detail-col-btn', (e) => {
                const tag = String($(e.currentTarget).data('tag') || '');
                this.setLocalCollection(tag);
                // 单按钮下拉模式：选中后收起六态列表（与 Bangumi 收藏菜单交互一致）
                $(e.currentTarget).closest('.detail-local-col-menu').hide();
            })
            // 标签切换
            .on('click', '.detail-tab', (e) => {
                const tab = String($(e.currentTarget).data('tab') || '');
                if (tab) this._switchTab(tab);
            })
            // 简介收起/展开
            .on('click', '#detail-desc-toggle', (e) => {
                e.stopPropagation();
                this._descCollapsed = !this._descCollapsed;
                this._renderOverview();
            })
            // Bangumi 标签展开全部/收起（仅切换展示数量，不动标签点击筛选）
            .on('click', '#detail-tags-toggle', (e) => {
                e.stopPropagation();
                this._tagsExpanded = !this._tagsExpanded;
                this._renderOverview();
            })
            // Kazumi 源弹窗
            .on('click', '#detail-kazumi-src', () => {
                if (typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    Kazumi.openSourceDialog(this.vodName || '', this.site, this.vodId);
                }
            })
            // Bangumi 收藏同步（统一详情页 T74）：六态列表内的状态按钮
            .on('click', '.kazumi-col-btn', async (e) => {
                const btn = $(e.currentTarget);
                // 单按钮模式：点击「当前状态」按钮（含内置箭头）= 展开六态列表
                if (btn.attr('id') === 'detail-col-current') {
                    const menu = btn.closest('.detail-col-wrap').find('.detail-col-menu');
                    const show = !menu.is(':visible');
                    $('.detail-col-menu').not(menu).hide();
                    menu.toggle(show);
                    e.stopPropagation();
                    return;
                }
                // 本地收藏单按钮（CatVod 源，Bangumi 同款交互）：展开六态列表
                if (btn.attr('id') === 'detail-local-col-current') {
                    const menu = btn.closest('.detail-local-col-wrap').find('.detail-local-col-menu');
                    const show = !menu.is(':visible');
                    $('.detail-col-menu').not(menu).hide();
                    menu.toggle(show);
                    e.stopPropagation();
                    return;
                }
                const id = String(btn.closest('.kazumi-col-btns').data('id') || '');
                const val = parseInt(btn.data('type'), 10);
                const nm = this.vodName || '';
                if (!id || typeof Kazumi === 'undefined') return;
                // 选中后收起弹出列表
                btn.closest('.detail-col-menu').hide();
                if (val < 0) {
                    if (await Kazumi.removeBangumiCollection(id, nm)) Kazumi._applyBangumiColState(id);
                    // 同步移除本地收藏（时间表筛选依赖 bangumiId）
                    if (typeof Records !== 'undefined' && this._bgmId) {
                        const fav = await Records.isFavorite('bangumi', id);
                        if (fav) await Records.toggleFavorite({ site: 'bangumi', vodId: id, name: nm, bangumiId: id, bangumi: true });
                    }
                } else if (await Kazumi.setBangumiCollection(id, val)) {
                    Kazumi._applyBangumiColState(id);
                    // 同步写入本地收藏（时间表筛选依赖 favorites 中的 bangumiId）
                    if (typeof Records !== 'undefined') {
                        const tagMap = { 1: 'want', 2: 'seen', 3: 'watching', 4: 'hold', 5: 'dropped' };
                        const tag = tagMap[val] || 'want';
                        const pic = (this._bgmInfo && this._bgmInfo.images && bangumiCover(this._bgmInfo.images, 'card')) || '';
                        await Records.setFavTag({ site: 'bangumi', vodId: id, name: nm, pic, siteName: 'Bangumi', bangumiId: id, bangumi: true }, tag);
                    }
                }
                // 收藏变更由 Favorites.changed（recSet 内触发）统一广播：
                // 详情页收藏按钮、我的收藏页、时间表过滤集合据此自动刷新。
            })
            // 收藏状态弹出列表：点其他区域收起（含本地收藏菜单，同一容器 class 口径）
            .on('click', (e) => {
                if (!$(e.target).closest('.detail-col-wrap').length) $('.detail-col-menu').hide();
            })
            // 跳源站网页（CatVod 详情，与「↗ Bangumi 页」同位）：URL 由 _siteWebUrl
            // 从站点 api 推导（scheme://host/），非 http(s) 不渲染按钮，此处双重校验
            .on('click', '#detail-catvod-web', () => {
                const u = this._siteWebUrl();
                if (!/^https?:\/\//i.test(u)) { warnToast('该源未配置网页地址'); return; }
                window.open(u, '_blank'); // 主进程转系统浏览器
            })
            // 开始观看（Kazumi 源，Bangumi-only 详情）
            .on('click', '#detail-kazumi-start', () => {
                if (typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    Kazumi.openSourceDialog(this.vodName || '', 'kazumi', '');
                }
            })
            // 评分/吐槽/标签（T80）：hero 操作行按钮 → BgmRate 对话框（打分+吐槽+标签合并提交）。
            // 预填当前评分/吐槽/标签（fetchCurrent 单条补查，收藏列表接口不回传这些字段）；
            // 热门标签建议取条目公共标签 _bgmInfo.tags（[{name,count}] → name 数组）。
            // 提交成功后 BgmRate 内部广播 FavHub.changed + 通知本页乐观刷新吐槽列表。
            .on('click', '#detail-bgm-rate', async () => {
                if (typeof BgmRate === 'undefined') { warnToast('评分组件未加载'); return; }
                const sid = String(this._bgmId || '');
                if (!sid) { warnToast('缺少 Bangumi 条目 ID'); return; }
                const cur = await BgmRate.fetchCurrent(sid, null);
                await BgmRate.openRateDialog({
                    subjectId: sid,
                    name: this.vodName || '',
                    rate: cur.rate,
                    comment: cur.comment,
                    tags: cur.tags,
                    popularTags: (this._bgmInfo && Array.isArray(this._bgmInfo.tags))
                        ? this._bgmInfo.tags.map((t) => (t && typeof t === 'object') ? t.name : t) : [],
                });
            })
            // 一键跳转 bgm.tv 条目页（系统浏览器）。URL 拼自 _bgmId（数字字符白名单校验，
            // 防注入）：openBangumi 详情必然有 _bgmId；CatVod 详情匹配到 Bangumi 时才有按钮。
            .on('click', '#detail-bgm-open', () => {
                const sid = String(this._bgmId || '');
                if (!sid || !/^\d+$/.test(sid)) { warnToast('缺少 Bangumi 条目 ID'); return; }
                window.open(`https://bgm.tv/subject/${sid}`, '_blank'); // 主进程转系统浏览器
            })
            // 开始播放（CatVod 源详情头部，与「开始观看」同位置）：打开线路+集数弹窗（T79）
            .on('click', '#detail-catvod-start', () => {
                this._catvodStartPlay();
            })
            // 标签点击：按 Bangumi 标签精确筛选番剧（非关键词搜索，任务四 4.2）
            .on('click', '.kazumi-tag', (e) => {
                const tag = String($(e.currentTarget).data('tag') || '');
                if (!tag) return;
                if (typeof Kazumi !== 'undefined' && Kazumi.openBangumiTagResult) {
                    Kazumi.openBangumiTagResult(tag);
                }
            });
        registerEsc(() => {
            if (App.currentView === 'detail') { this.back(); return true; }
            return false;
        });
        // CatVod 选源选集弹窗（T79）：委托挂在弹窗自身容器上——弹窗是 body 直属节点，
        // 不在 #detail-body 内部，挂在 #detail-body 的委托永远匹配不到（「点开弹窗
        // 无法操作」的根因）。点线路只切弹窗内展示；点集起播并关窗（多选/下载仍留
        // 在「分集」页签）。
        $('#catvod-play-dialog-body')
            .on('click', '.catvod-play-src', (e) => {
                const idx = parseInt($(e.currentTarget).data('idx'), 10);
                this._catvodDialogSelectSource(idx);
            })
            .on('click', '.catvod-ep-btn', (e) => {
                const idx = parseInt($(e.currentTarget).data('idx'), 10);
                closeDialog('catvodPlayDialog');
                this._playEpisode(idx);
            });
        // 页签栏吸顶位：尽量靠上。标准模式贴窗口顶（0）；无边框模式顶部 32px
        // 是窗口拖拽带（-webkit-app-region:drag 吞点击且层级更高），吸顶位压在
        // 其下 1px 处（33）。写入 CSS 变量供 .detail-tabs 的 sticky top 消费，
        // _stickTop() 与其保持同一数值来源。
        const stickTop = document.body.classList.contains('frameless') ? 33 : 0;
        document.documentElement.style.setProperty('--tabs-stick-top', stickTop + 'px');
        // 页签栏吸顶状态检测：功能栏滚到吸顶位后加 tabs-stuck，CSS 据此展开
        // 向上遮罩——滚动内容不再从功能栏上方穿过（需求：吸顶后上方不显示
        // 任何内容）。passive 监听每帧仅一次布局读取。
        const viewEl = document.getElementById('view-detail');
        if (viewEl && !this._stuckBound) {
            this._stuckBound = true;
            viewEl.addEventListener('scroll', () => {
                const bar = viewEl.querySelector('.detail-tabs');
                if (!bar) return;
                bar.classList.toggle('tabs-stuck', bar.getBoundingClientRect().top <= this._stickTop() + 1);
            }, { passive: true });
        }
    },

    /** 功能栏吸顶位（视口内 y）：标准模式贴窗口顶（0）；无边框模式顶部 32px
     *  拖拽带吞点击，压在其下 1px（33）。与 init 写入的 --tabs-stick-top 一致。 */
    _stickTop() {
        return document.body.classList.contains('frameless') ? 33 : 0;
    },

    open(site, vodId, fallbackName) {
        if (!site || !vodId) { warnToast('缺少站点或视频 ID'); return; }
        abortCoverFill();
        // 嵌套跳转（已在详情页时再打开新详情）：压栈当前快照，返回时恢复，而非跳回根视图。
        if (App.currentView === 'detail') {
            this._backStack.push(this._snapshot());
        } else {
            this._backStack = [];
            this.backView = App.currentView;
        }
        this.site = site;
        this.vodId = vodId;
        this.vodName = fallbackName || '';
        this._bgmInfo = null;
        this._bgmId = null;
        this._comments = [];
        this._characters = [];
        this._staff = [];
        this._relations = [];
        this._resetEpComments();
        this._bgmExtraLoaded = false;
        this._activeTab = '概览';
        // 多选状态不跨页面残留（T79）：单例标志此前退出详情后仍保留，重进任意
        // 详情页直接回到多选态；每次打开重置为普通模式
        this._bgmSelectMode = false;
        this._epSelectMode = false;
        App._detailOpening = true; // 标记「新开详情」：app.js 据此把详情记忆归属到来源分支（恢复展示不写）
        App.showView('detail');
        this.load();
    },

    /** 打开 Bangumi-only 详情（时间表/推荐/收藏/Bangumi 搜索进入，T74 统一详情页）。
     *  无 CatVod 源；以「开始观看」（Kazumi 规则源）为主播放入口。 */
    async openBangumi(subjectId, fallbackName) {
        if (!subjectId) { warnToast('缺少 Bangumi ID'); return; }
        if (typeof Kazumi === 'undefined') { warnToast('Kazumi 引擎不可用'); return; }
        abortCoverFill();
        // 嵌套跳转：已在详情页（如从关联页点番剧）时压栈快照，返回恢复上一详情页而非根视图。
        if (App.currentView === 'detail') {
            this._backStack.push(this._snapshot());
        } else {
            this._backStack = [];
            this.backView = App.currentView;
        }
        this.site = '';
        this.vodId = String(subjectId);
        this.vodName = fallbackName || '';
        // 清掉上一次 CatVod 详情残留的 vod（T4）：否则 toggleFav 会写出 site:'' 的错误收藏，
        // 且 _lastVod 残留会串入上一部影片的封面/源名。
        this._vod = null;
        this._lastVod = null;
        this._bgmInfo = null;
        this._bgmId = String(subjectId);
        this._comments = [];
        this._characters = [];
        this._staff = [];
        this._relations = [];
        this._resetEpComments();
        this._bgmExtraLoaded = false;
        this._activeTab = '概览';
        // 多选状态不跨页面残留（同 open()）
        this._bgmSelectMode = false;
        this._epSelectMode = false;
        App._detailOpening = true; // 标记「新开详情」：app.js 据此把详情记忆归属到来源分支（恢复展示不写）
        App.showView('detail');
        // P2-4：与 load() 共用同一世代变量（两者写同一份详情页状态），
        // 快速连续打开 CatVod 详情 ↔ Bangumi 详情时旧响应同样作废
        const gen = ++this._loadGen;
        showLoading();
        $('#detail-body').html('<div class="tip-line">正在载入详情…</div>');
        try {
            this._bgmInfo = await Kazumi.bangumiInfo(subjectId); // 30 分钟缓存
            if (gen !== this._loadGen) return; // 已切到别的详情，旧响应丢弃
            if (!this._bgmInfo) { warnToast('Bangumi 详情载入失败'); hideLoading(); this.back(); return; }
            if (!this.vodName) this.vodName = this._bgmInfo.name_cn || this._bgmInfo.name || '';
            this.sources = []; // 无 CatVod 线路
            this.render();
        } catch (e) {
            if (gen !== this._loadGen) return; // 已切到别的详情，旧错误不覆盖新页面
            warnToast('Bangumi 详情载入失败');
            this.back();
        } finally {
            if (gen === this._loadGen) hideLoading(); // 新请求的 loading 不被旧请求收尾
        }
    },

    /** 保存当前详情页关键状态，用于嵌套跳转的回退恢复（关联→新详情→返回原详情）。 */
    _snapshot() {
        return {
            site: this.site, vodId: this.vodId, vodName: this.vodName,
            _vod: this._vod, _bgmId: this._bgmId, _bgmInfo: this._bgmInfo,
            _activeTab: this._activeTab, sources: this.sources, activeSource: this.activeSource,
        };
    },

    /** 从快照恢复详情页：无需重拉，直接重渲染。返回 false 表示栈为空。 */
    async _restore(snapshot) {
        if (!snapshot) return false;
        Object.assign(this, snapshot);
        // 嵌套返回自增主请求世代：嵌套打开番剧（关联→新详情）期间旧详情的主请求
        // 仍在途，返回恢复后若不自增，慢响应会带着过期世代比对通过，把旧影片的
        // _vod/sources 覆盖到刚恢复的页面上（与 load()/openBangumi() 同一守卫口径）
        this._loadGen++;
        this._bgmExtraGen++; // 作废在途的上一部番剧补充数据加载，防返回后旧结果叠加渲染（多余卡片/闪烁）
        this._comments = [];
        this._characters = [];
        this._staff = [];
        this._relations = [];
        this._resetEpComments();
        this._bgmExtraLoaded = false;
        App.showView('detail');
        this.render();
        if (this._bgmId) this._loadBgmExtra();
        return true;
    },

    /** 嵌套跳转回退：优先从栈上恢复上一详情页（关联→新详情→返回原详情），
     *  栈空时再回到外部进入视图（home/search/timeline 等）。 */
    async back() {
        if (this._backStack && this._backStack.length) {
            const prev = this._backStack.pop();
            // _restore 是 async：必须 await 后判断结果，真值判断 Promise 恒真，守卫成死代码
            if (await this._restore(prev)) return;
        }
        App.showView(this.backView || 'home');
    },

    /** CatVod 详情页自动匹配 Bangumi 数据开关（T74：设置 → CatVod源设置，默认关）。 */
    async _catvodBgmMatchEnabled() {
        try {
            const s = (await window.yuki.settingsGet()) || {};
            return s.catvodBgmMatch === true;
        } catch (e) { return false; }
    },

    _openCoverFloat(src) {
        if (!src) return;
        let wrap = document.getElementById('cover-float');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'cover-float';
            wrap.innerHTML = '<img referrerpolicy="no-referrer" alt="">';
            document.body.appendChild(wrap);
            wrap.addEventListener('click', () => wrap.classList.remove('show'));
            wrap.addEventListener('wheel', (ev) => {
                ev.preventDefault();
                const img = wrap.firstChild;
                const cur = img.getBoundingClientRect().width;
                const next = Math.max(160, Math.min(window.innerWidth * 0.95, cur * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
                img.style.width = next + 'px';
            }, { passive: false });
            // 右键另存图片
            wrap.addEventListener('contextmenu', (ev) => {
                ev.preventDefault();
                const img = wrap.firstChild;
                const imgSrc = img.src;
                if (!imgSrc) return;
                // 获取文件名：从 URL 中提取，兜底用 timestamp
                let name = 'image';
                try { name = decodeURIComponent(imgSrc.split('/').pop().split('?')[0]) || 'image'; } catch (e) { /* ignore */ }
                if (!/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(name)) name += '.jpg';
                // 通过 fetch + Blob 保存（需后端 /proxy 或直链可访问）
                fetch(imgSrc, { mode: 'cors', credentials: 'omit' })
                    .then((r) => r.blob())
                    .then((blob) => {
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url; a.download = name;
                        document.body.appendChild(a); a.click(); a.remove();
                        URL.revokeObjectURL(url);
                        warnToast(`已保存图片：${name}`);
                    })
                    .catch(() => {
                        // fetch 失败时尝试直接用 URL 下载（浏览器会处理）
                        const a = document.createElement('a');
                        a.href = imgSrc; a.download = name; a.target = '_blank';
                        document.body.appendChild(a); a.click(); a.remove();
                        warnToast(`已尝试保存图片：${name}`);
                    });
            });
        }
        const img = wrap.firstChild;
        img.removeAttribute('style');
        img.src = src;
        wrap.classList.add('show');
    },

    async load() {
        // P2-4：主请求世代守卫——open() 只改引用不重置世代，快速 A→B 打开时
        // 慢的 A 响应回来若继续写状态会产出 site/vodId 取 B、vod_name/vod_pic
        // 取 A 的混合收藏条目。入口自增，await 返回后比对，不一致即丢弃。
        const gen = ++this._loadGen;
        showLoading();
        $('#detail-body').html('<div class="tip-line">载入中…</div>');
        try {
            // T74：命中缓存直接复用，避免重复打开重复拉详情（localStorage 持久缓存，重启仍有效）
            const cacheKey = String(this.site) + '|' + String(this.vodId);
            let vod = _detailCacheGet(DETAIL_VOD_CACHE_PREFIX, cacheKey);
            let data = null;
            if (!vod) {
                data = await doAction('detailContent', { site: this.site, ids: JSON.stringify([this.vodId]) });
                vod = (data && data.list && data.list[0]) || null;
                if (vod) _detailCacheSet(DETAIL_VOD_CACHE_PREFIX, cacheKey, vod, DETAIL_CACHE_TTL);
            }
            if (gen !== this._loadGen) return; // 已切到别的详情，旧响应丢弃
            if (!vod) {
                // #11：data.error 为第三方源回传内容，进 .html() 前必须 escHtml
                const err = data && data.error ? `（${escHtml(String(data.error).slice(0, 120))}）` : '';
                $('#detail-body').html(`<div class="tip-line">未取得详情${err}</div>`);
                return;
            }
            if (vod.vod_name) this.vodName = vod.vod_name;
            this._vod = vod;
            this.sources = this.parsePlay(vod);
            this.activeSource = 0;
            await this._restoreLastSource();
            // 自动匹配 Bangumi（T74 开关：设置 → CatVod源设置「详情页自动匹配 Bangumi 数据」，默认关）
            if (await this._catvodBgmMatchEnabled() && typeof Kazumi !== 'undefined') {
                try {
                    const name = vod.vod_name || this.vodName;
                    let match = null;
                    if (typeof Kazumi.getBangumiMatch === 'function') match = await Kazumi.getBangumiMatch(name);
                    else if (Kazumi.bangumiSearch) {
                        const bgmResults = await Kazumi.bangumiSearch(name);
                        if (bgmResults && bgmResults.length && bgmResults[0].id) match = { id: bgmResults[0].id };
                    }
                    if (match && match.id) {
                        this._bgmId = match.id;
                        this._bgmInfo = await Kazumi.bangumiInfo(this._bgmId);
                    }
                } catch (e) { /* Bangumi 匹配失败不影响详情 */ }
            }
            if (gen !== this._loadGen) return; // Bangumi 匹配期间已切走，丢弃旧结果
            this.render();
        } catch (e) {
            if (gen !== this._loadGen) return; // 已切到别的详情，旧错误不覆盖新页面
            $('#detail-body').html('<div class="tip-line">详情载入失败</div>');
            warnToast('详情载入失败');
        } finally {
            if (gen === this._loadGen) hideLoading(); // 新请求的 loading 不被旧请求收尾
        }
    },

    parsePlay(vod) {
        const froms = String(vod.vod_play_from || '').split('$$$').filter(Boolean);
        const urls = String(vod.vod_play_url || '').split('$$$');
        return froms.map((from, i) => ({
            from,
            episodes: String(urls[i] || '').split('#').filter(Boolean).map((e) => {
                const idx = e.indexOf('$');
                return idx > 0 ? { name: e.slice(0, idx), url: e.slice(idx + 1) } : { name: e, url: e };
            }),
        })).filter((s) => s.episodes.length);
    },

    metaLine(vod) {
        const bits = [vod.type_name, vod.vod_year, vod.vod_area, vod.vod_remarks].filter(Boolean);
        return bits.join(' · ');
    },

    /** 放送星期：从放送日期推算（subject 详情接口不含 air_weekday，日历接口才有）。
     *  非法/缺失日期返回空串。1=周一 … 7=周日（与 Bangumi air_weekday 口径一致）。 */
    _airWeekday(dateStr) {
        const s = String(dateStr || '').trim();
        const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (!m) return '';
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (Number.isNaN(d.getTime())) return '';
        return '周' + '日一二三四五六'[d.getDay()];
    },

    /** 总话数与完结态：eps>0 时返回 {eps, finished}。完结判定：Bangumi 无显式
     *  完结字段，以「有总话数 + 放送日期已过（今日 > 放送日 + eps 周）」近似——
     *  放送日期缺失时只显示总话数不显示完结。 */
    _episodesState(bgm) {
        const eps = Number(bgm && (bgm.eps || bgm.total_episodes)) || 0;
        if (!eps) return null;
        const dateStr = String((bgm && (bgm.date || bgm.air_date)) || '').trim();
        let finished = false;
        if (dateStr) {
            const m = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
            if (m) {
                const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
                if (!Number.isNaN(start.getTime())) {
                    // 每周更新一话：放送日 + eps 周后放完（留 3 天余量容忍拖更统计口径）
                    const end = start.getTime() + eps * 7 * 86400000 + 3 * 86400000;
                    finished = Date.now() > end;
                }
            }
        }
        return { eps, finished };
    },

    render() {
        this._lastVod = this._vod || null;
        const vod = this._vod;
        const bgm = this._bgmInfo;
        const hasBgm = !!this._bgmId;
        // 详情封面使用 detail 变体；bgm 无封面时回落源封面 vod_pic。
        const cover = (bgm && bgm.images && bangumiCover(bgm.images, 'detail'))
            || (vod && vod.vod_pic) || '';
        const name = bgm ? (bgm.name_cn || bgm.name || (vod && vod.vod_name) || this.vodName) : ((vod && vod.vod_name) || this.vodName);
        // 中文名为标题时，原名（日文/英文）作右下角小字副标题；同名则不重复展示
        const origName = (bgm && name !== bgm.name && bgm.name) ? bgm.name : '';
        const airWeek = bgm ? this._airWeekday(bgm.date || bgm.air_date) : '';
        // 话数进放送行：放送 2026-07-06 周一 · 12话 [已完结]（与话数同一行）。
        // 日期/星期/话数为服务端受控格式；platform/type_name 为远端字段需 escHtml，
        // 完结徽标的 span 依赖 meta 以 HTML 直拼，故各分段在此处分别转义。
        const epState = bgm ? this._episodesState(bgm) : null;
        const meta = bgm
            ? [
                bgm.date || bgm.air_date
                    ? escHtml(`放送 ${bgm.date || bgm.air_date}${airWeek ? ` ${airWeek}` : ''}${epState ? ` · ${epState.eps}话` : ''}`)
                        + (epState && epState.finished ? ' <span class="detail-eps-finished">已完结</span>' : '')
                    : '',
                bgm.platform ? escHtml(bgm.platform) : '',
                bgm.type_name ? escHtml(bgm.type_name) : '',
            ].filter(Boolean).join(' · ')
            // CatVod 分支：metaLine 各段是第三方 CMS 源回传字段（#11 口径），
            // 拼串后必须整体转义——插入点是 .html()，漏转义即 HTML 注入
            : escHtml(this.metaLine(vod || {}));
        const people = [
            vod && vod.vod_director ? `导演：${escHtml(vod.vod_director)}` : '',
            vod && vod.vod_actor ? `演员：${escHtml(vod.vod_actor)}` : '',
        ].filter(Boolean).join('<span class="detail-people-sep">·</span>');
        const localFrag = vod ? this._localColHtml() : '';
        // 封面进度徽章已删除（话数/完结信息在头部 meta 行展示，封面重复展示嫌挤）
        // 操作行布局对齐 Bangumi 范式：匹配到 Bangumi 时 Bangumi 操作行在上、
        // 本地收藏+网页按钮成行置下（两套收藏体系并存）；纯 CatVod 时单行
        // [▶ 开始播放][本地收藏 ▾][↗ 网页]（_catvodStartHtml 内嵌 localFrag）。
        const bgmColHtml = this._bangumiColHtml(bgm);
        const heroActions = bgmColHtml
            ? bgmColHtml + (localFrag
                ? `<div class="kazumi-watch-row detail-watch-row-plain">${localFrag}${this._catvodWebBtnHtml()}</div>`
                : '')
            : this._catvodStartHtml(localFrag);
        let html = `
        <div class="detail-head detail-hero ${hasBgm ? 'detail-hero-bangumi' : 'detail-hero-catvod'}">
            <div class="detail-cover detail-hero-cover">${vodCoverImg(cover, true)}</div>
            <div class="detail-info detail-hero-info">
                <div class="detail-kicker">${hasBgm ? 'BANGUMI 详情' : '影片详情'}</div>
                <h1 class="detail-title">${escHtml(name)}${origName ? `<span class="detail-title-orig">${escHtml(origName)}</span>` : ''}</h1>
                <div class="detail-meta">${meta || '暂无更多信息'}</div>
                ${people ? `<div class="detail-people">${people}</div>` : ''}
                ${hasBgm ? this._bangumiStatsHtml(bgm) : `<div class="detail-catvod-facts">
                    <span class="detail-fact-label">播放信息</span>
                    <span class="detail-fact-value">${this.sources.length ? `${this.sources.length} 条线路 · 共 ${this.sources[0].episodes.length} 集` : '暂无播放线路'}</span>
                </div>`}
                <div class="detail-hero-actions">${heroActions}</div>
            </div>
        </div>`;
        // 页签栏
        const tabs = DETAIL_TABS.map((t) => `<span class="detail-tab ${t === this._activeTab ? 'active' : ''}" data-tab="${t}" role="tab" aria-selected="${t === this._activeTab ? 'true' : 'false'}">${t}</span>`).join('');
        // 吸顶锚点哨兵：零高度静态元素紧贴页签栏前。不能用页签栏自身的
        // offsetTop 测吸顶锚点——Chromium 对已吸顶的 sticky 元素返回含粘性
        // 位移的布局位（滚得越深数值越虚增），会导致切页签永远停在原位。
        html += `<div id="detail-tabs-sentinel" aria-hidden="true"></div><div class="detail-tabs class-tabs" role="tablist" aria-label="详情内容">${tabs}</div>`;
        html += `<div id="detail-tab-content" class="detail-content" role="tabpanel"></div>`;
        // detail-page-anim：hero/页签/内容分级上浮入场（CSS 按非毛玻璃门控）。
        // innerHTML 替换不清除容器类，每次打开详情/嵌套返回都会重播一次入场动画。
        $('#detail-body').addClass('detail-page-anim').html(html);
        this._refreshLocalCol();
        this._renderTabContent();
        // 后台加载 Bangumi 补充数据
        if (hasBgm) {
            this._loadBgmExtra();
            if (typeof Kazumi !== 'undefined' && Kazumi._applyBangumiColState) {
                Kazumi._applyBangumiColState(this._bgmId); // 高亮当前收藏状态
            }
        }
    },

    /** 本地收藏按钮（CatVod 源）：与 Bangumi 收藏单按钮同款交互——按钮内含当前
     *  状态文案 + ▾ 箭头，点击弹出六态列表，选中即写本地收藏并收起。
     *  资源片段模式（只渲染按钮本体，不含行容器）：纯 CatVod 详情时由
     *  _catvodStartHtml 并入操作行；匹配 Bangumi 时 render() 补包一层行容器。
     *  按钮用独立 id #detail-local-col-current，避免与 Bangumi 收藏按钮
     *  #detail-col-current 的委托/高亮（kazumi.js _applyBangumiColState）互相干扰。 */
    _localColHtml() {
        return `<span class="detail-col-wrap detail-local-col-wrap">
            <button type="button" id="detail-local-col-current" class="md-btn md-btn-sm kazumi-col-btn" title="选择本地收藏状态">
                <span class="detail-col-label">未收藏</span><span class="detail-col-caret">▾</span>
            </button>
            <div class="detail-col-menu detail-local-col-menu" style="display:none;">
                <div class="kazumi-col-btns detail-local-col-btns">
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="">未收藏</button>
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="want">想看</button>
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="watching">在看</button>
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="seen">看过</button>
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="hold">搁置</button>
                    <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="dropped">抛弃</button>
                </div>
            </div>
        </span>`;
    },

    /** Bangumi 评分摘要：评分、星级、排名、1-10 分人数分布 + 收藏人数共用一组 hero 指标。
     *  （话数/完结已并入头部放送行，不在统计区重复展示。） */
    _bangumiStatsHtml(bgm) {
        const rating = (bgm && bgm.rating) || {};
        const score = Number(rating.score) || 0;
        const votes = Number(rating.total) || 0;
        const rank = Number(rating.rank) || 0;
        const stars = score
            ? `<span class="bi-stars" aria-label="${escHtml(String(score))} 分（满分 10 分）"><span class="bi-stars-bg">★★★★★</span><span class="bi-stars-fill" style="width:${Math.round(Math.max(0, Math.min(10, score)) * 10)}%">★★★★★</span></span>`
            : '<span class="detail-score-empty">暂无评分</span>';
        // 收藏人数（Bangumi collection 统计：想看/在看/看过）
        const col = (bgm && bgm.collection) || {};
        const fmt = (n) => escHtml(Number(n || 0).toLocaleString('zh-CN'));
        const colHtml = (col.wish || col.doing || col.collect)
            ? `<div class="detail-stat-collections">
                ${col.wish ? `<span class="detail-col-item" title="想看人数">⭐ 想看 ${fmt(col.wish)}</span>` : ''}
                ${col.doing ? `<span class="detail-col-item" title="在看人数">▶ 在看 ${fmt(col.doing)}</span>` : ''}
                ${col.collect ? `<span class="detail-col-item" title="看过人数">✓ 看过 ${fmt(col.collect)}</span>` : ''}
            </div>`
            : '';
        const count = rating.count;
        let histogram = '';
        if (count && typeof count === 'object') {
            const values = [];
            for (let i = 1; i <= 10; i++) values.push(Number(count[i] || count[String(i)] || 0));
            if (values.some((v) => v > 0)) {
                const max = Math.max(1, ...values);
                histogram = `<div class="bi-hist" title="评分分布（1-10 分人数）" aria-label="评分分布">${values.map((value, i) =>
                    `<div class="bi-hist-col"><div class="bi-hist-bar" style="height:${Math.max(4, Math.round(value / max * 100))}%" title="${i + 1} 分：${value} 人"></div><span class="bi-hist-lb">${i + 1}</span></div>`
                ).join('')}</div>`;
            }
        }
        return `<div class="detail-bgm-stats">
            <div class="detail-stat-score">
                <span class="detail-stat-label">评分</span>
                <div class="detail-stat-score-line"><strong>${score ? escHtml(String(score)) : '—'}</strong>${stars}</div>
                <span class="detail-stat-note">${votes ? `${escHtml(votes.toLocaleString('zh-CN'))} 人评分` : '暂无评分人数'}</span>
            </div>
            <div class="detail-stat-rank"><span class="detail-stat-label">Bangumi 排名</span><strong>${rank ? `#${escHtml(String(rank))}` : '—'}</strong>${rank ? '' : '<span class="detail-stat-note">暂无排名</span>'}</div>
            ${histogram}
            ${colHtml}
        </div>`;
    },

    /** Bangumi 操作行（统一详情页，T74/T80）。
     *  收藏单按钮（无独立容器）：按钮内含当前状态文案 + ▾ 箭头，点击弹出六态
     *  列表供选择，选中即同步 Bangumi 并收起；按钮置于「开始观看」右侧。
     *  「★ 评分 / 吐槽」恒在；「在 Bangumi 打开」转系统浏览器。
     *  观看进度行（看到第 N 话）由 _applyBangumiColState 回填。 */
    _bangumiColHtml(bgm) {
        if (!bgm || !bgm.id) return '';
        const hasRules = typeof Kazumi !== 'undefined' && Kazumi.hasEnabledRules && Kazumi.hasEnabledRules();
        const startBtn = hasRules
            ? `<button type="button" id="detail-kazumi-start" class="md-btn md-btn-filled md-btn-sm"><span class="detail-button-mark">▶</span>开始观看</button>`
            : '';
        return `<div class="kazumi-watch-row detail-watch-row-plain">
            ${startBtn}
            <span class="detail-col-wrap">
                <button type="button" id="detail-col-current" class="md-btn md-btn-sm kazumi-col-btn" data-type="-1" title="选择 Bangumi 收藏状态">
                    <span class="detail-col-label">未收藏</span><span class="detail-col-caret">▾</span>
                </button>
                <span class="detail-col-progress tip-line pad0" style="display:none;"></span>
                <div class="detail-col-menu" style="display:none;">
                    <div class="kazumi-col-btns" data-id="${escHtml(bgm.id)}">
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="-1">未收藏</button>
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="1">想看</button>
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="3">在看</button>
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="2">看过</button>
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="4">搁置</button>
                        <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="5">抛弃</button>
                    </div>
                </div>
            </span>
            <button type="button" id="detail-bgm-rate" class="md-btn md-btn-sm" title="评分 / 吐槽 / 标签（同步到 Bangumi）">★ 评分 / 吐槽</button>
            <button type="button" id="detail-bgm-open" class="md-btn md-btn-sm" title="在系统浏览器打开 bgm.tv 条目页">↗ Bangumi 页</button>
        </div>`;
    },

    /** CatVod 详情页 hero 操作行（无 Bangumi 匹配时）：[▶ 开始播放][本地收藏 ▾][↗ 网页]。
     *  「开始播放」与 Kazumi 源「开始观看」同位置/同样式（#detail-kazumi-start
     *  的视觉口径），点击打开选源选集弹窗（T79，对齐 Bangumi「开始观看」引导范式）；
     *  「↗ 网页」与 Bangumi 行「↗ Bangumi 页」同位置，跳源站网页（_siteWebUrl）。
     *  开始播放仅在有可用线路/选集时渲染（无线路时概览已有「暂无播放线路」提示）；
     *  localFrag 为 _localColHtml 的收藏按钮片段（始终并入本行）。 */
    _catvodStartHtml(localFrag) {
        const frag = localFrag || '';
        const src = this.sources[this.activeSource];
        const hasPlay = !!(this.sources.length && src && src.episodes.length);
        const webBtn = this._catvodWebBtnHtml();
        if (!hasPlay && !frag && !webBtn) return '';
        return `<div class="kazumi-watch-row detail-watch-row-plain">
            ${hasPlay ? `<button type="button" id="detail-catvod-start" class="md-btn md-btn-filled md-btn-sm"><span class="detail-button-mark">▶</span>开始播放</button>` : ''}
            ${frag}
            ${webBtn}
        </div>`;
    },

    /** 「↗ 网页」按钮（CatVod 源详情）：与 Bangumi 行「↗ Bangumi 页」同位置/同样式。
     *  仅在 _siteWebUrl 推导得出源站首页时渲染（spider 类源返回空 → 无按钮）。 */
    _catvodWebBtnHtml() {
        return this._siteWebUrl()
            ? `<button type="button" id="detail-catvod-web" class="md-btn md-btn-sm" title="在系统浏览器打开源站网页">↗ 网页</button>`
            : '';
    },

    /** 当前 CatVod 源的网页首页地址：由站点 api URL 推导（scheme://host[:port]/）。
     *  cms/jar 类源的 api 部署在源站域名下，跳其首页即「源站网页」；spider 类
     *  （js/py）api 可能只是资源地址，推导不出 http(s) 首页时返回空串（不渲染按钮）。
     *  仅拼 scheme+host，丢弃 path/query/credentials，URL 解析失败返回空串。 */
    _siteWebUrl() {
        try {
            const all = (typeof Home !== 'undefined' && Home._allSites) || [];
            const s = all.find((x) => x.key === this.site);
            const api = String((s && s.api) || '');
            if (!/^https?:\/\//i.test(api)) return '';
            const u = new URL(api);
            return `${u.protocol}//${u.host}/`;
        } catch (e) { return ''; }
    },

    /** 「开始播放」点击行为（T79）：打开「线路+集数」单页弹窗——线路与集数同屏，
     *  默认选中当前（lastSourceMap 记忆/第 0 条）线路，点任一集即起播并关窗。
     *  与 Bangumi「开始观看」→ openSourceDialog 的引导范式对齐；区别在于 catvod
     *  详情加载时线路与全集已同步在手（vod_play_from/vod_play_url），无需搜索步骤，
     *  因此单屏即可完成选择。弹窗内点线路只切弹窗内集数展示（activeSource 同步 +
     *  _saveLastSource 记忆），不动「分集」页签的 DOM；起播仍统一走 _playEpisode
     *  （Player.play 的队列/外部主播放器/失败换线路等行为对弹窗入口同样生效）。 */
    _catvodStartPlay() {
        const src = this.sources[this.activeSource];
        if (!this.sources.length || !src || !src.episodes.length) {
            warnToast('暂无可播放的线路或选集');
            return;
        }
        this._openCatvodPlayDialog();
    },

    /** 渲染并打开 CatVod 选源选集弹窗。 */
    _openCatvodPlayDialog() {
        const body = $('#catvod-play-dialog-body');
        if (!body.length) return;
        const cur = this.activeSource;
        const src = this.sources[cur];
        if (!src) return;
        $('#catvod-play-dialog-title').text(`选择线路与集数 · ${this.vodName || ''}`);
        // 线路按钮组：复用「分集」页签的 .play-src 视觉口径；弹窗内独立 data 域
        // （.catvod-play-src）避免与页签里的 .play-src 委托互相干扰。
        const srcBtns = this.sources.map((s, i) =>
            `<button type="button" class="play-src catvod-play-src ${i === cur ? 'active' : ''}" data-idx="${i}">${escHtml(s.from)} <span class="play-src-count">${s.episodes.length}</span></button>`).join('');
        // 集数网格：复用 .ep-btn 视觉口径（不含下载/勾选——弹窗只做选集起播），
        // 按 _epDesc 记忆的顺序展示，与「分集」页签口径一致。
        const order = src.episodes.map((_, i) => i);
        if (this._epDesc) order.reverse();
        const epBtns = order.map((i) => {
            const ep = src.episodes[i];
            return `<button type="button" class="ep-btn catvod-ep-btn" data-idx="${i}" title="${escHtml(ep.url)}"><span class="ep-name">${escHtml(ep.name)}</span></button>`;
        }).join('');
        body.html(`<div class="catvod-play-sheet">
            <div class="detail-source-label">线路</div>
            <div class="play-srcs">${srcBtns}</div>
            <div class="detail-source-label">集数</div>
            <div class="ep-grid catvod-play-eps">${epBtns}</div>
        </div>`);
        openDialog('catvodPlayDialog');
    },

    /** 弹窗内点线路：切弹窗集数展示并同步 activeSource + 记忆（lastSourceMap），
     *  不触碰「分集」页签 DOM（该页签下次渲染时按 activeSource 自然对齐）。 */
    _catvodDialogSelectSource(idx) {
        if (idx < 0 || idx >= this.sources.length || idx === this.activeSource) return;
        this.activeSource = idx;
        $('#catvod-play-dialog-body .catvod-play-src').removeClass('active');
        $(`#catvod-play-dialog-body .catvod-play-src[data-idx="${idx}"]`).addClass('active');
        // 换线路重渲染弹窗集数网格（每条线路的集名/集数独立）
        const src = this.sources[idx];
        const order = src.episodes.map((_, i) => i);
        if (this._epDesc) order.reverse();
        const epBtns = order.map((i) => {
            const ep = src.episodes[i];
            return `<button type="button" class="ep-btn catvod-ep-btn" data-idx="${i}" title="${escHtml(ep.url)}"><span class="ep-name">${escHtml(ep.name)}</span></button>`;
        }).join('');
        $('#catvod-play-dialog-body .catvod-play-eps').html(epBtns);
        this._saveLastSource();
    },

    _renderTabContent() {
        this._unbindCommentPageScroll(); // 离开吐槽页签时摘除页面滚动续拉监听
        if (this._activeTab === '概览') this._renderOverview();
        else if (this._activeTab === '分集') this._renderEpisodes();
        else if (this._activeTab === '角色') this._renderCharacters();
        else if (this._activeTab === '制作') this._renderStaff();
        else if (this._activeTab === '吐槽') this._renderComments();
        else if (this._activeTab === '选集讨论') this._renderEpComments();
        else if (this._activeTab === '关联') this._renderRelations();
    },

    _switchTab(tab) {
        if (tab === this._activeTab) return;
        this._activeTab = tab;
        $('#detail-body .detail-tab').removeClass('active').attr('aria-selected', 'false');
        $(`#detail-body .detail-tab[data-tab="${tab}"]`).addClass('active').attr('aria-selected', 'true');
        // 交换前先捕获吸顶区间状态：_swapTabContent 内的钳制可能中途改变滚动位，
        // 交换后再据捕获结果落位，避免落位被跳过
        const deep = this._isBelowTabsStick();
        this._swapTabContent(() => this._renderTabContent());
        // 吸顶状态下切页签：内容落到功能栏底边之下（含 24px 间距预留）。
        // 功能栏由 sticky 钉在原像素、上方被遮罩覆盖——唯一可见变化是栏下换装
        this._snapToTabsStick(deep);
    },

    /** 吸顶滚动位下限：哨兵布局顶 - 吸顶位。静态哨兵不受 sticky 粘性位移污染
     *  （已吸顶的元素自身 offsetTop 会包含位移，不可用）。-1 表示页签未挂载。 */
    _tabsStickFloor() {
        const sentinel = document.getElementById('detail-tabs-sentinel');
        return sentinel ? Math.max(0, sentinel.offsetTop - this._stickTop()) : -1;
    },

    /** 视口当前是否处于吸顶区间（切页签/数据到达前捕获，防中途钳制干扰）。 */
    _isBelowTabsStick() {
        const viewEl = document.getElementById('view-detail');
        const floor = this._tabsStickFloor();
        return !!(viewEl && floor >= 0 && viewEl.scrollTop >= floor);
    },

    /** 吸顶状态下让页签内容完整显示在功能栏之下（force=交换前已处于吸顶区间）。
     *  落位目标按渲染后的实测内容文档位反推：内容首行 = 吸顶位 + 功能栏实测
     *  高度 + 24px 间距预留——不依赖任何假定尺寸（功能栏高度/间距变化自校正），
     *  卡片不会被功能栏遮挡；结果与吸顶阈值取大以维持钉住态和遮罩覆盖。
     *  同步单帧赋值，无平滑动画即无中间位移。 */
    _snapToTabsStick(force) {
        const viewEl = document.getElementById('view-detail');
        const bar = viewEl && viewEl.querySelector('.detail-tabs');
        const contentEl = document.getElementById('detail-tab-content');
        if (!viewEl || !bar || !contentEl || !contentEl.isConnected) return;
        const floor = this._tabsStickFloor();
        if (!force && !(floor >= 0 && viewEl.scrollTop >= floor)) return;
        const contentDocY = contentEl.getBoundingClientRect().top
            - viewEl.getBoundingClientRect().top + viewEl.scrollTop;
        const target = Math.max(floor,
            contentDocY - (this._stickTop() + bar.offsetHeight + 24));
        const max = viewEl.scrollHeight - viewEl.clientHeight;
        viewEl.scrollTop = Math.max(0, Math.min(target, max));
    },

    /** 同步收敛滚动越界。innerHTML 替换后内容变矮时 Chromium 要到下一次布局才
     *  钳制 scrollTop，表现为先画一帧越界内容再跳回——页签「画面抖动」的来源之一。
     *  在同一帧内显式钳制即可消除该跳变（配合 #view-detail 的 overflow-anchor:none，
     *  滚动位置只由这里决定，避免浏览器锚定与高度过渡叠加二次位移）。 */
    _clampDetailScroll() {
        const viewEl = document.getElementById('view-detail');
        if (!viewEl) return;
        const max = viewEl.scrollHeight - viewEl.clientHeight;
        if (viewEl.scrollTop > max) viewEl.scrollTop = Math.max(0, max);
    },

    /** 页签内容交换：同步替换 + 滚动越界钳制 + 新内容轻量淡入。
     *  刻意不做高度补间——高度过渡会让页面其余板块随内容伸缩而位移（违背
     *  「点页签板块位置不变」），且毛玻璃下带 backdrop-filter 的卡片被逐帧
     *  改尺寸会反复重建模糊采样层，表现为撕裂闪烁（同 T54 成因）。
     *  动画仅保留新内容自身的淡入上浮（CSS 端按非毛玻璃门控）。 */
    _swapTabContent(renderFn) {
        renderFn(); // 各页签渲染器同步写 DOM
        this._clampDetailScroll();
        const box = document.getElementById('detail-tab-content');
        if (!box || !box.isConnected) return;
        box.classList.remove('tab-enter');
        void box.offsetWidth; // 强制 reflow 以重启动画
        box.classList.add('tab-enter');
    },

    _renderOverview() {
        const vod = this._vod;
        const bgm = this._bgmInfo;
        let html = '';
        // 简介（可收起）：默认收起三行（-webkit-line-clamp），点「展开全部」看全文；
        // 超三行简介显示切换按钮，极短简介（≤三行）不出按钮。
        const descText = bgm ? stripHtml(bgm.summary || '') : stripHtml((vod && vod.vod_content) || '');
        if (descText) {
            const overThreeLines = descText.length > 90; // 14px/24px 行高三行约 90 字
            const collapsed = overThreeLines && this._descCollapsed;
            html += `<section class="detail-overview-card detail-desc-wrap">
                <div class="detail-section-heading">简介</div>
                <div class="detail-desc ${collapsed ? 'collapsed' : ''}">${escHtml(descText)}</div>
                ${overThreeLines ? `<button type="button" id="detail-desc-toggle" class="md-btn md-btn-sm md-btn-tonal detail-desc-toggle">${collapsed ? '展开全部' : '收起'}</button>` : ''}
            </section>`;
        }
        // Bangumi 标签（含用户标记数量 t.count，仿 Kazumi ActionChip：标签名 + 主色数量）。
        // 默认全部展示（与简介同策略：默认分辨率下完整可见）；仅超长列表（>40 个）
        // 折叠到「收起」，标签点击筛选委托不受影响。
        if (bgm && Array.isArray(bgm.tags) && bgm.tags.length) {
            const overLong = bgm.tags.length > 40;
            const shown = (overLong && !this._tagsExpanded) ? bgm.tags.slice(0, 40) : bgm.tags;
            const chips = shown.map((t) => {
                if (t && typeof t === 'object') {
                    const tn = t.name || '';
                    const cnt = (t.count != null) ? Number(t.count) : 0;
                    if (!tn) return '';
                    return `<span class="kazumi-tag" data-tag="${escHtml(tn)}" title="共 ${cnt} 人标记">${escHtml(tn)} <span class="kazumi-tag-count">${cnt}</span></span>`;
                }
                const tn = String(t || '');
                return tn ? `<span class="kazumi-tag" data-tag="${escHtml(tn)}">${escHtml(tn)}</span>` : '';
            }).filter(Boolean).join('');
            if (chips) {
                let toggleBtn = '';
                if (overLong) {
                    toggleBtn = `<button type="button" id="detail-tags-toggle" class="kazumi-tags-toggle">${this._tagsExpanded ? '收起' : `展开全部（${bgm.tags.length - 40}）`}</button>`;
                }
                html += `<section class="detail-overview-card bangumi-info-tags"><div class="detail-section-heading">标签</div><div class="kazumi-tags-wrap">${chips}${toggleBtn}</div></section>`;
            }
        }
        if (!html) html = '<div class="detail-empty-state">暂无概览信息</div>';
        $('#detail-tab-content').html(`<div class="detail-overview-grid">${html}</div>`);
    },

    /** CatVod 线路/选集与 Bangumi-only 分集统一放在「分集」页签，避免概览区堆满播放控件。 */
    _renderEpisodes() {
        let html = '';
        if (!this.sources.length) {
            if (this._bgmId && this._bgmInfo) {
                html += `<section class="detail-episodes-panel detail-bgm-episodes-panel">
                    <div class="detail-section-head"><div><div class="detail-section-kicker">Bangumi 分集</div><h2 class="detail-section-title">选择集数</h2></div>
                        <span class="detail-head-actions">
                            <button type="button" id="bgm-ep-order" class="md-btn md-btn-tonal md-btn-sm">${this._bgmEpDesc ? '⇅ 切正序' : '⇅ 切倒序'}</button>
                            <button type="button" id="bgm-ep-multi" class="md-btn md-btn-tonal md-btn-sm">多选</button>
                        </span></div>
                    <div class="ep-dl-bar ${this._bgmSelectMode ? '' : 'ep-dl-bar-hidden'}">
                        <label class="ep-dl-check-all"><input type="checkbox" id="bgm-ep-check-all">全选</label>
                        <span class="dl-spacer"></span>
                        <span class="ep-dl-count" id="bgm-ep-dl-count"></span>
                        <button type="button" id="bgm-ep-play-selected" class="md-btn md-btn-tonal md-btn-sm">▶ 播放勾选集</button>
                        <button type="button" id="bgm-ep-dl-selected" class="md-btn md-btn-tonal md-btn-sm">⬇ 下载勾选集</button>
                    </div>
                    <div id="bgm-ep-list" class="ep-grid kazumi-episode-grid ${this._bgmSelectMode ? 'selecting' : ''}"></div>
                </section>`;
                $('#detail-tab-content').html(html);
                $('#bgm-ep-multi').on('click', () => {
                    this._bgmSelectMode = !this._bgmSelectMode;
                    $('#bgm-ep-multi').text(this._bgmSelectMode ? '退出多选' : '多选');
                    $('#detail-tab-content .ep-dl-bar').toggleClass('ep-dl-bar-hidden', !this._bgmSelectMode);
                    $('#bgm-ep-list').toggleClass('selecting', this._bgmSelectMode);
                    if (!this._bgmSelectMode) { $('#bgm-ep-list .ep-check').removeClass('checked'); $('#bgm-ep-check-all').prop('checked', false); this._syncBgmDlBar(); }
                });
                $('#bgm-ep-order').on('click', () => {
                    this._bgmEpDesc = !this._bgmEpDesc;
                    // 有缓存时仅按新顺序重排已渲染节点（append 已有节点 = 移动位置），
                    // 不重新请求网络、不重建 DOM，避免切换顺序时闪烁；
                    // 无缓存（首次/数据未加载）才走完整渲染。
                    if (this._bgmEps && this._bgmEps.length) this._reorderBgmEpisodes();
                    else this._renderBgmEpisodes();
                });
                $('#bgm-ep-check-all').on('change', (e) => {
                    $('#bgm-ep-list .ep-check').toggleClass('checked', e.currentTarget.checked);
                    this._syncBgmDlBar();
                });
                $('#bgm-ep-play-selected').on('click', () => this._playBgmSelected());
                $('#bgm-ep-dl-selected').on('click', () => this._downloadBgmSelected());
                this._renderBgmEpisodes();
                return;
            }
            html = '<div class="detail-empty-state">该视频暂无播放源</div>';
            if (typeof Kazumi !== 'undefined' && Kazumi.hasEnabledRules && Kazumi.hasEnabledRules()) {
                html += `<div class="kazumi-entry"><span>没有想看的源？</span><button type="button" id="detail-kazumi-src" class="md-btn md-btn-tonal md-btn-sm">试试 Kazumi 规则源</button></div>`;
            }
            $('#detail-tab-content').html(html);
            return;
        }

        html += `<section class="detail-episodes-panel">
            <div class="detail-section-head"><div><div class="detail-section-kicker">CatVod 播放源</div><h2 class="detail-section-title">线路与选集</h2></div>
                <span class="detail-head-actions">
                    <button type="button" id="ep-order" class="md-btn md-btn-tonal md-btn-sm">${this._epDesc ? '⇅ 切正序' : '⇅ 切倒序'}</button>
                    <button type="button" id="ep-multi" class="md-btn md-btn-tonal md-btn-sm">多选</button>
                </span></div>
            <div class="detail-source-label">线路</div>
            <div class="play-srcs">${this.sources.map((s, i) =>
                `<button type="button" class="play-src ${i === this.activeSource ? 'active' : ''}" data-idx="${i}">${escHtml(s.from)} <span class="play-src-count">${s.episodes.length}</span></button>`).join('')}</div>
            ${typeof Kazumi !== 'undefined' && Kazumi.hasEnabledRules && Kazumi.hasEnabledRules() ? `<div class="kazumi-entry"><span>没有想看的源？</span><button type="button" id="detail-kazumi-src" class="md-btn md-btn-tonal md-btn-sm">试试 Kazumi 规则源</button></div>` : ''}
            <div class="ep-dl-bar ${this._epSelectMode ? '' : 'ep-dl-bar-hidden'}">
                <label class="ep-dl-check-all"><input type="checkbox" id="ep-check-all">全选</label>
                <span class="dl-spacer"></span>
                <span class="ep-dl-count" id="ep-dl-count"></span>
                <button type="button" id="ep-play-selected" class="md-btn md-btn-tonal md-btn-sm">▶ 播放勾选集</button>
                <button type="button" id="ep-dl-selected" class="md-btn md-btn-tonal md-btn-sm">⬇ 下载勾选集</button>
            </div>
            <div id="ep-list" class="ep-grid ${this._epSelectMode ? 'selecting' : ''}"></div>
        </section>`;
        $('#detail-tab-content').html(html);
        $('#ep-multi').on('click', () => {
            this._epSelectMode = !this._epSelectMode;
            $('#ep-multi').text(this._epSelectMode ? '退出多选' : '多选');
            $('#detail-tab-content .ep-dl-bar').toggleClass('ep-dl-bar-hidden', !this._epSelectMode);
            $('#ep-list').toggleClass('selecting', this._epSelectMode);
            if (!this._epSelectMode) { $('#ep-list .ep-check').removeClass('checked'); $('#ep-check-all').prop('checked', false); this._syncDlBar(); }
        });
        this.renderEpisodes();
    },

    /** Bangumi 分集切换顺序：复用已渲染的 .bgm-ep-item 节点按新顺序重排，不重建 DOM。 */
    _reorderBgmEpisodes() {
        const box = $('#bgm-ep-list');
        if (!box.length || !Array.isArray(this._bgmEps)) return;
        $('#bgm-ep-order').text(this._bgmEpDesc ? '⇅ 切正序' : '⇅ 切倒序');
        const byIdx = {};
        box.children('.bgm-ep-item').each(function () {
            const idx = parseInt(this.getAttribute('data-idx'), 10);
            if (!Number.isNaN(idx)) byIdx[idx] = this;
        });
        // 节点数与缓存不一致（如数据刷新/切换源后残留）→ 回退完整渲染，避免错位
        if (Object.keys(byIdx).length !== this._bgmEps.length) {
            this._renderBgmEpisodes();
            return;
        }
        let view = this._bgmEps.map((ep, i) => ({ ep, i }));
        if (this._bgmEpDesc) view.reverse();
        view.forEach(({ i }) => {
            const el = byIdx[i];
            if (el) box.append(el); // append 已有节点 = 移动到末尾，按新顺序排列
        });
        this._syncBgmDlBar();
    },

    /** 渲染 Bangumi 分集（统一详情页）：勾选框多选（样式对齐非 Kazumi 详情页），点击集打开选源播放/下载。 */
    async _renderBgmEpisodes() {
        const box = $('#bgm-ep-list');
        if (!box.length || !this._bgmId || typeof Kazumi === 'undefined') return;
        $('#bgm-ep-order').text(this._bgmEpDesc ? '⇅ 切正序' : '⇅ 切倒序');
        box.html('<div class="tip-line">载入中…</div>');
        const gen = this._bgmExtraGen; // M-30c：分集加载世代守卫（防旧番分集写入新番）
        try {
            const data = await Kazumi.bangumiEpisodes(this._bgmId);
            if (gen !== this._bgmExtraGen) return; // 已切到别的番剧，旧分集丢弃
            let list = ((data && data.data) || []).slice();
            // 记录集序号（供下载按 sort 定位），倒序仅影响展示
            this._bgmEps = list;
            let view = list.map((ep, i) => ({ ep, i }));
            if (this._bgmEpDesc) view.reverse();
            box.html(view.length
                ? view.map(({ ep, i }) => {
                    const no = ep.sort || ep.ep || (i + 1);
                    const nm = ep.name_cn || ep.name || '';
                    const type = Number(ep.type) === 1 ? 'SP' : Number(ep.type) === 2 ? 'OP' : Number(ep.type) === 3 ? 'ED' : '';
                    return `<div class="kazumi-detail-ep bgm-ep-item" data-idx="${i}" tabindex="0">
                        <span class="ep-check" data-idx="${i}" title="勾选后可批量下载"></span>
                        <span class="kazumi-detail-ep-no">${escHtml(String(no))}</span>
                        <span class="kazumi-detail-ep-name">${escHtml(nm)}</span>
                        ${type ? `<span class="kazumi-detail-ep-type">${escHtml(type)}</span>` : ''}
                    </div>`;
                }).join('')
                : '<div class="tip-line">暂无分集信息</div>');
            // 分集异步回填使页签内容增高：同步钳制滚动，避免视口深处越界晚钳制跳动
            this._clampDetailScroll();
            // 勾选框：阻止冒泡，仅切换选中；点击集主体则打开选源播放
            box.find('.ep-check').on('click', (e) => {
                e.stopPropagation();
                $(e.currentTarget).toggleClass('checked');
                this._syncBgmDlBar();
            });
            box.find('.bgm-ep-item').on('click', (e) => {
                if ($(e.target).hasClass('ep-check')) return;
                const title = this.vodName || '';
                if (title && typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    Kazumi.openSourceDialog(title, 'kazumi', '');
                }
            });
            $('#bgm-ep-check-all').prop('checked', false);
            this._syncBgmDlBar();
        } catch (e) {
            box.html('<div class="tip-line">分集载入失败</div>');
        }
    },

    _syncBgmDlBar() {
        const n = $('#bgm-ep-list .ep-check.checked').length;
        $('#bgm-ep-dl-count').text(n ? `已勾选 ${n} 集` : '');
        $('#bgm-ep-dl-selected').text(n ? `⬇ 下载勾选集（${n}）` : '⬇ 下载勾选集');
        $('#bgm-ep-play-selected').text(n ? `▶ 播放勾选集（${n}）` : '▶ 播放勾选集');
    },

    /** Bangumi 分集播放勾选集：Bangumi-only 无直链，打开 Kazumi 选源弹窗选源播放。 */
    _playBgmSelected() {
        const idxs = $('#bgm-ep-list .ep-check.checked')
            .map(function () { return parseInt($(this).data('idx'), 10); })
            .get().sort((a, b) => a - b);
        if (!idxs.length) { warnToast('请先勾选要播放的集'); return; }
        const title = this.vodName || '';
        if (title && typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
            // 携带勾选下标：选源弹窗内选定源+线路后，播放器队列只包含勾选的子集
            Kazumi.openSourceDialog(title, 'kazumi', '', { playIndexes: idxs });
            warnToast(`选择 Kazumi 源与线路后将播放勾选的 ${idxs.length} 集`);
        }
    },

    /** Bangumi 分集多选下载：打开 Kazumi 选源弹窗，从选中源下载勾选集（弹窗内多选源+集完成实际下载）。 */
    async _downloadBgmSelected() {
        const idxs = $('#bgm-ep-list .ep-check.checked')
            .map(function () { return parseInt($(this).data('idx'), 10); })
            .get().sort((a, b) => a - b);
        if (!idxs.length) { warnToast('请先勾选要下载的集'); return; }
        const title = this.vodName || '';
        if (!title || typeof Kazumi === 'undefined' || !Kazumi.openSourceDialog) { warnToast('无法打开选源'); return; }
        // Bangumi-only 无直链，需先从 Kazumi 源解析：打开选源弹窗并带上「下载模式 + 目标集下标」，
        // 用户选定源+线路后由弹窗按下标批量解析下载（kazumi.js 处理）。用 0 基下标定位线路对应集，
        // 比按集号文本匹配更可靠（修复只下载一集的 bug）。
        const eps = idxs.map((i) => this._bgmEps[i]).filter(Boolean);
        const epNos = eps.map((ep, k) => ep.sort || ep.ep || (idxs[k] + 1));
        Kazumi.openSourceDialog(title, 'kazumi', '', { downloadEpisodes: epNos, downloadIndexes: idxs, downloadTitle: title });
        warnToast(`选择 Kazumi 源与线路后将下载勾选的 ${idxs.length} 集`);
    },

    /** 吐槽计数文案：优先真实总数（next.bgm total，一次给出，与分页无关）；
     *  未知（旧后端/失败/裸数组回退）时回退「已加载数 + 未全载时 + 号」的旧口径。
     *  已加载 >= 真实总数时不再显示「+」（全部在屏）。 */
    _commentCountText() {
        const loaded = this._comments.length;
        const total = Number(this._commentTotal) || 0;
        if (total > 0) return `共 ${total} 条`;
        return `共 ${loaded} 条${this._commentAllLoaded ? '' : '+'}`;
    },

    _renderComments(append) {
        // 页签落点守卫：续拉响应返回时用户可能已切到其他页签（制作/角色/关联等），
        // 此时绝不能把评论写进内容区——否则会整块覆盖该页签的卡片（表现为卡片
        // 「画面割裂」成评论列表，回顶/快速滚动时在途请求落地尤易复现）。
        // 数据已并入 _comments，下次进入吐槽页签自然完整渲染。
        if (this._activeTab !== '吐槽') return;
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (!this._bgmExtraLoaded) { box.html('<div class="tip-line">加载中…</div>'); return; }
        // 排序不依赖接口返回顺序（next.bgm 默认并非时间正序）：按评论时间显式排序，
        // false=正序（旧→新），true=倒序（新→旧），保证切换语义与按钮文案一致。
        const list = this._comments.slice().sort((a, b) => {
            const ta = Detail._commentTsMs(a.updatedAt || a.updated_at || a.createdAt || a.created_at || 0);
            const tb = Detail._commentTsMs(b.updatedAt || b.updated_at || b.createdAt || b.created_at || 0);
            return this._commentDesc ? tb - ta : ta - tb;
        });
        const keys = this._commentKeys(list);
        // 续拉增量分支：列表已在屏上时只插入新增行，不整表重绘。
        // 整表 box.html() 会重建全部头像 <img>（重新解码→闪烁）并造成滚动位置跳动。
        const listBox = append ? box.find('.detail-comment-list').first() : $();
        if (listBox.length && listBox.children('.detail-comment').length) {
            this._appendCommentRows(listBox[0], list, keys);
            box.find('.detail-comment-count')
                .text(this._commentCountText());
            this._updateCommentFooter(listBox[0]);
        } else {
            const rows = list.map((c, k) => Detail._commentRowHtml(c, keys[k])).join('');
            const foot = this._commentAllLoaded
                ? (this._comments.length ? '<div class="tip-line detail-comment-end">没有更多了</div>' : '')
                : '<div class="tip-line detail-comment-more">下拉加载更多…</div>';
            box.html(`<div class="detail-comment-toolbar">
                    <span class="detail-comment-count">${this._commentCountText()}</span>
                    <button type="button" id="detail-comment-order" class="md-btn md-btn-tonal md-btn-sm">${this._commentDesc ? '⇅ 切正序' : '⇅ 切倒序'}</button>
                </div>
                <div class="detail-comment-list">${rows || '<div class="tip-line">暂无吐槽</div>'}${foot}</div>`);
            $('#detail-comment-order').on('click', () => { this._commentDesc = !this._commentDesc; this._renderComments(); });
        }
        // 无内滚容器：与「制作」页签一致随详情页自然下延；滚动根（#view-detail）
        // 触底续拉（无条数上限）。每次渲染先解绑旧监听避免累积。
        this._unbindCommentPageScroll();
        const viewEl = document.getElementById('view-detail');
        if (viewEl && !this._commentAllLoaded) {
            this._onCommentPageScroll = () => {
                if (this._activeTab !== '吐槽') return;
                if (viewEl.scrollTop + viewEl.clientHeight >= viewEl.scrollHeight - 40) this._loadMoreComments();
            };
            viewEl.addEventListener('scroll', this._onCommentPageScroll);
        }
    },

    /**
     * 单条吐槽行 HTML（带 data-key 供增量更新做 DOM 复用）。
     * 从 _renderComments 抽出为纯函数：全量渲染与续拉增量插入共用同一模板。
     */
    _commentRowHtml(c, key) {
        const user = (c.user && (c.user.nickname || c.user.username)) || c.username || c.nickname || '';
        const avatar = (c.user && c.user.avatar && (c.user.avatar.medium || c.user.avatar.small || c.user.avatar.large))
            || c.avatar || '';
        const text = c.comment || c.content || '';
        const ts = c.updatedAt || c.updated_at || c.createdAt || c.created_at || 0;
        const time = Detail._fmtCommentTimeFull(ts);
        const rate = (c.rate || (c.comment && typeof c.comment === 'object' && c.comment.rate)) || 0;
        const replies = (Array.isArray(c.replies) && c.replies.length) ? c.replies : null;
        const repliesHtml = replies ? `<div class="detail-comment-replies">${replies.map((r) => {
            const ru = (r.user && (r.user.nickname || r.user.username)) || r.username || r.nickname || '';
            const ra = (r.user && r.user.avatar && (r.user.avatar.medium || r.user.avatar.small || r.user.avatar.large))
                || r.avatar || '';
            const rt = r.content || r.comment || '';
            const rts = r.createdAt || r.created_at || r.updatedAt || r.updated_at || 0;
            const rtime = Detail._fmtCommentTimeFull(rts);
            return `<div class="detail-comment-reply">
                    <div class="detail-comment-head">
                        ${ra ? `<img class="detail-comment-avatar" src="${escHtml(ra)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.style.display='none'">` : ''}
                        <span class="detail-comment-user">${escHtml(ru)}</span><span class="detail-comment-time">${escHtml(rtime)}</span>
                    </div>
                    <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof rt === 'string' ? rt : '')}</div>
                </div>`;
        }).join('')}</div>` : '';
        return `<div class="detail-comment"${key ? ` data-key="${escHtml(key)}"` : ''}>
                <div class="detail-comment-head">
                    ${avatar ? `<img class="detail-comment-avatar" src="${escHtml(avatar)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.style.display='none'">` : ''}
                    <span class="detail-comment-user">${escHtml(user)}</span>${rate ? `<span class="detail-comment-rate">★ ${escHtml(String(rate))}</span>` : ''}<span class="detail-comment-time">${escHtml(time)}</span>
                </div>
                <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof text === 'string' ? text : '')}</div>
                ${repliesHtml}
            </div>`;
    },

    /**
     * 吐槽稳定键：时间戳+用户+评分+正文长度+回复数。接口无评论 ID，用字段指纹代替；
     * 完全相同的重复条目按 _comments 原始顺序追加序号区分（与展示排序无关，跨渲染稳定）。
     * 返回与 list 对齐的 key 数组。
     */
    _commentKeys(list) {
        const base = (c) => [
            Detail._commentTsMs(c.updatedAt || c.updated_at || c.createdAt || c.created_at || 0),
            (c.user && (c.user.nickname || c.user.username)) || c.username || c.nickname || '',
            c.rate || 0,
            String(c.comment || c.content || '').length,
            Array.isArray(c.replies) ? c.replies.length : 0,
        ].join('|');
        const occ = new Map();
        const byObj = new Map();
        for (const c of this._comments) { // 原始数组顺序分配序号，不受当前排序方向影响
            const b = base(c);
            const n = (occ.get(b) || 0) + 1;
            occ.set(b, n);
            byObj.set(c, `${b}#${n}`);
        }
        return list.map((c) => byObj.get(c) || `${base(c)}#0`);
    },

    /**
     * 续拉增量插入：双指针把新排序结果合并进已渲染列表，只为新条目建节点，
     * 已有行（含头像）原样保留避免重载闪烁。旧列表是新列表的子集（数据只增不减）。
     */
    _appendCommentRows(container, list, keys) {
        const viewEl = document.getElementById('view-detail');
        // 锚点补偿避让：平滑回顶进行中、或视口已处首屏时跳过。
        // 回顶是用户明确的「去列表顶端」意图——正序模式下新续拉的更早评论本就属于顶端，
        // 此时应停在 scrollTop≈0 看新顶内容；若仍做锚点回拨会与回顶动画抢滚动条，造成画面割裂。
        const smoothToTop = !!(viewEl && viewEl._yukiSmoothTop);
        const nearTop = !!viewEl && viewEl.scrollTop <= viewEl.clientHeight;
        // 锚点：视口内第一可见行。若新行插在其上方，内容整体下移，事后按位移差回拨 scrollTop。
        let anchor = null;
        let anchorTop = 0;
        if (viewEl && !smoothToTop && !nearTop) {
            for (const el of container.querySelectorAll('.detail-comment')) {
                const r = el.getBoundingClientRect();
                if (r.bottom > 0) { anchor = el; anchorTop = r.top; break; }
            }
        }
        const existing = Array.from(container.querySelectorAll('.detail-comment'));
        const footEl = container.querySelector('.detail-comment-end, .detail-comment-more');
        const holder = document.createElement('div');
        let i = 0; // 指向尚未越过的旧行
        for (let k = 0; k < list.length; k++) {
            const key = keys[k];
            if (i < existing.length && existing[i].dataset.key === key) { i++; continue; }
            holder.innerHTML = Detail._commentRowHtml(list[k], key);
            const node = holder.firstElementChild;
            if (!node) continue;
            const ref = i < existing.length ? existing[i] : footEl; // 尾部提示行之前 / 列表末尾
            if (ref) container.insertBefore(node, ref); else container.appendChild(node);
            // 不推进 i：后续新条目仍可能排在同一旧行之前
        }
        // 滚动补偿：锚点行仍在文档中时，把它拉回原来的屏幕位置（上方插入场景）
        if (anchor && viewEl && anchor.isConnected) {
            const delta = anchor.getBoundingClientRect().top - anchorTop;
            if (Math.abs(delta) > 0.5) viewEl.scrollTop += delta;
        }
    },

    /** 原位更新列表尾部提示（下拉加载更多… ↔ 没更多了），不动已渲染的评论行。 */
    _updateCommentFooter(container) {
        const cur = container.querySelector('.detail-comment-end, .detail-comment-more');
        const want = this._commentAllLoaded
            ? (this._comments.length ? '<div class="tip-line detail-comment-end">没有更多了</div>' : '')
            : '<div class="tip-line detail-comment-more">下拉加载更多…</div>';
        if (!want) { if (cur) cur.remove(); return; }
        if (cur && cur.outerHTML === want) return;
        const holder = document.createElement('div');
        holder.innerHTML = want;
        const next = holder.firstElementChild;
        if (!next) return;
        if (cur) cur.replaceWith(next); else container.appendChild(next);
    },

    /** 解绑挂在详情页滚动根上的吐槽续拉监听（重渲染 / 切页签时调用）。 */
    _unbindCommentPageScroll() {
        const el = document.getElementById('view-detail');
        if (el && this._onCommentPageScroll) el.removeEventListener('scroll', this._onCommentPageScroll);
        this._onCommentPageScroll = null;
    },

    /**
     * 渲染评论正文的 BBCode（Bangumi 吐槽为 BBCode 文本）。
     * 重点修复：[quote][b]某人[/b] ...[/quote] 是「回复某人」的引用块，
     * 原来仅 escHtml 直出会露出裸标签。此处先转义 HTML，再把常用 BBCode
     * 转成安全的行内标签；未知标签一律剥除以免残留。
     */
    _renderCommentBBCode(raw) {
        if (typeof raw !== 'string' || !raw) return '';
        let s = escHtml(raw);
        // 引用块（回复某人）：[quote]...[/quote] → 缩进引用样式；支持嵌套外层
        s = s.replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi,
            (_m, inner) => `<span class="detail-comment-quote">${inner}</span>`);
        // 基础样式标签
        s = s.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '<strong>$1</strong>');
        s = s.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '<em>$1</em>');
        s = s.replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>');
        s = s.replace(/\[s\]([\s\S]*?)\[\/s\]/gi, '<s>$1</s>');
        s = s.replace(/\[mask\]([\s\S]*?)\[\/mask\]/gi, '<span class="detail-comment-mask">$1</span>');
        // 图片：[img]url[/img] → 表情/图片（限 http(s)）
        s = s.replace(/\[img\](https?:[^\[\]]+?)\[\/img\]/gi,
            '<img class="detail-comment-inline-img" src="$1" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display=\'none\'">');
        // 链接：[url=addr]text[/url] 与 [url]addr[/url]（限 http(s)，交主进程转系统浏览器）
        s = s.replace(/\[url=(https?:[^\]]+?)\]([\s\S]*?)\[\/url\]/gi,
            '<a href="$1" target="_blank" rel="noreferrer">$2</a>');
        s = s.replace(/\[url\](https?:[^\[\]]+?)\[\/url\]/gi,
            '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
        // 剥除其余不识别/带参数的 BBCode 标签（size/color 等），仅去标签保留内容
        s = s.replace(/\[\/?[a-z][a-z0-9]*(=[^\]]*)?\]/gi, '');
        // 换行还原
        s = s.replace(/\r?\n/g, '<br>');
        return s;
    },

    /** 评论时间（完整版）：YYYY-MM-DD HH:mm（用户要求：年月日 + 具体时间）。 */
    _fmtCommentTimeFull(ts) {
        if (!ts) return '';
        if (typeof ts === 'string' && !/^\d+$/.test(ts)) return ts;
        let n = Number(ts);
        if (!n) return '';
        if (n < 1e12) n *= 1000; // 秒 → 毫秒
        const d = new Date(n);
        if (isNaN(d.getTime())) return '';
        const pad = (x) => String(x).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    /** 评论时间 → 毫秒时间戳（排序用）：兼容 Unix 秒/毫秒、数字串与日期字符串，解析失败返回 0。 */
    _commentTsMs(ts) {
        if (!ts) return 0;
        if (typeof ts === 'string' && !/^\d+$/.test(ts)) {
            const d = new Date(ts);
            return isNaN(d.getTime()) ? 0 : d.getTime();
        }
        let n = Number(ts);
        if (!n) return 0;
        if (n < 1e12) n *= 1000; // 秒 → 毫秒
        return n;
    },

    /** 从角色 info 中提取中文名。优先级：
     *  1) 基本信息 infobox 里的「简体中文名」项（最准确）；
     *  2) 显式 name_cn 字段；
     *  3) infobox「别名」项里含「中文/简体」的值。
     *  infobox 可能为数组 [{key, value}] 或字符串（HTML）。 */
    _pickCharNameCn(info) {
        if (!info) return '';
        const ib = info.infobox;
        // 1) 基本信息里的「简体中文名」（精确 key 命中，优先级最高）
        if (Array.isArray(ib)) {
            for (const it of ib) {
                if (!it || typeof it !== 'object') continue;
                const k = String(it.key || '').trim();
                if (k === '简体中文名' || k === '简体中文' || k === '中文名') {
                    let v = it.value;
                    if (typeof v === 'string' && v.trim()) return v.trim();
                    if (Array.isArray(v)) {
                        const hit = v.find((x) => x && x.v);
                        if (hit && hit.v) return String(hit.v);
                    }
                }
            }
        }
        // 2) 显式 name_cn
        if (info.name_cn) return String(info.name_cn);
        if (!ib) return '';
        // 3) 别名项里的中文/简体值兜底
        if (Array.isArray(ib)) {
            for (const it of ib) {
                if (!it || typeof it !== 'object') continue;
                const k = String(it.key || '').toLowerCase();
                if (k === '别名' || k === 'alternate name' || k === 'alias') {
                    let v = it.value;
                    if (Array.isArray(v)) {
                        // [{k:'简体中文',v:'...'}] 形式
                        const cn = v.find((x) => x && (String(x.k || '').includes('中文') || String(x.k || '').includes('简体')));
                        if (cn && cn.v) return String(cn.v);
                        if (v[0] && v[0].v) return String(v[0].v);
                    }
                    if (typeof v === 'string') {
                        // "简体中文: 名称" 或纯名称
                        const m = v.match(/(?:简体)?中文\s*[:：]\s*([^\n;；\/、]+)/);
                        if (m) return m[1].trim();
                        return v.split(/[\n;；\/、]/)[0].trim();
                    }
                }
            }
        }
        return '';
    },

    /** 角色卡片 CV 文案：v0 接口 actors 为 [{name,name_cn?}]，部分镜像兼容 actor 字符串；
     *  多位 CV 用「/」连接，无 CV 返回空串（卡片不渲染该行）。 */
    _charCvText(c) {
        if (!c) return '';
        const names = (Array.isArray(c.actors) ? c.actors : [])
            .map((a) => (a && (a.name_cn || a.name)) ? String(a.name_cn || a.name).trim() : '')
            .filter(Boolean);
        if (names.length) return names.join(' / ');
        if (typeof c.actor === 'string' && c.actor.trim()) return c.actor.trim();
        return '';
    },

    /** 构建角色「基本信息」多行文本：名称类字段（简体中文名 → 第二中文名 → 日文名 → 别名 → 其它名）
     *  排到最前，其余 infobox 字段按原顺序跟随。数组值（如「别名」多条）展开为多行子项。
     *  infobox 项形如 {key, value}，value 可能是字符串或 [{k, v}]。 */
    _buildCharInfoStr(info) {
        if (!info || !Array.isArray(info.infobox)) return '';
        // 名称类字段展示优先级（越靠前越先展示）；未列出的字段按原顺序排在名称字段之后
        const NAME_ORDER = ['简体中文名', '第二中文名', '日文名', '别名', '英文名', '罗马字', '拼音', '昵称', '本名', '外文名'];
        const nameRank = (k) => {
            const i = NAME_ORDER.indexOf(k);
            return i === -1 ? NAME_ORDER.length + 1 : i;
        };
        // 保留原始顺序索引，供同优先级/非名称字段稳定排序
        const rows = info.infobox
            .map((it, idx) => ({ it, idx }))
            .filter(({ it }) => it && typeof it === 'object' && String(it.key || '').trim());
        rows.sort((a, b) => {
            const ra = nameRank(String(a.it.key).trim());
            const rb = nameRank(String(b.it.key).trim());
            if (ra !== rb) return ra - rb;
            return a.idx - b.idx; // 同级保持原顺序
        });
        const lines = [];
        for (const { it } of rows) {
            const key = String(it.key || '').trim();
            const v = it.value;
            if (Array.isArray(v)) {
                // 「别名」等多条：每条一行，子标签 k 存在时作「父key·子k」，否则仅父 key
                for (const x of v) {
                    if (!x || typeof x !== 'object' || !x.v) continue;
                    const sub = String(x.k || '').trim();
                    const label = sub ? `${key}·${sub}` : key;
                    lines.push(`${label}：${String(x.v).trim()}`);
                }
            } else if (typeof v === 'string' && v.trim()) {
                lines.push(`${key}：${v.trim()}`);
            }
        }
        return lines.join('\n');
    },

    _renderCharacters() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (!this._bgmExtraLoaded) { box.html('<div class="tip-line">加载中…</div>'); return; }
        if (!this._characters.length) { box.html('<div class="tip-line">暂无角色信息</div>'); return; }
        // 角色权重：主角在前（relation 优先，role_name 兜底），升序稳定排序
        const roleWeight = (role) => (
            /主角|MAIN|主役/i.test(role) ? 0
            : /配角|SUPPORT|次要/i.test(role) ? 1
            : /客串|CAME/i.test(role) ? 2
            : 3
        );
        // 角色筛选：main=主角+配角（默认），lead=主角，support=配角，minor=闲角（客串+其他），all=全部
        const FILTERS = [
            { key: 'main', label: '主要人物' },
            { key: 'lead', label: '主角' },
            { key: 'support', label: '配角' },
            { key: 'minor', label: '闲角' },
            { key: 'all', label: '全部' },
        ];
        if (!FILTERS.some((f) => f.key === this._charFilter)) this._charFilter = 'main';
        const cards = this._characters.slice().map((c) => {
            const orig = c.name || '';
            const cn = c.name_cn || '';
            const mainName = cn || orig;
            const subName = (cn && orig && cn !== orig) ? orig : ''; // 中文名打头，原名作副行（相同则不重复）
            const cv = this._charCvText(c);
            const role = String(c.relation || c.role_name || '');
            return {
                role,
                weight: roleWeight(role),
                html: `<div class="detail-char-card" data-char-id="${escHtml(c.id || '')}" tabindex="0" title="点击查看人物详情与吐槽">
                    <div class="detail-char-avatar-wrap">${(c.images && (c.images.medium || c.images.grid))
                        ? `<img class="detail-char-avatar" src="${escHtml(c.images.medium || c.images.grid)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.closest('.detail-char-avatar-wrap').classList.add('noimg');this.remove()">`
                        : '<span class="detail-char-noimg">🎭</span>'}</div>
                    <div class="detail-char-name">${escHtml(mainName)}</div>
                    ${subName ? `<div class="detail-char-name-cn">${escHtml(subName)}</div>` : ''}
                    ${cv ? `<div class="detail-char-cv">CV：${escHtml(cv)}</div>` : ''}
                    <div class="detail-char-role">${escHtml(role)}</div>
                </div>`,
            };
        });
        const matchFilter = (w) => {
            switch (this._charFilter) {
                case 'lead': return w === 0;
                case 'support': return w === 1;
                case 'minor': return w >= 2;
                case 'all': return true;
                default: return w <= 1; // main：主角 + 配角
            }
        };
        const shown = cards.filter((x) => matchFilter(x.weight));
        shown.sort((a, b) => a.weight - b.weight);
        const filterBar = `<div class="detail-filter-bar" role="tablist" aria-label="角色筛选">${FILTERS.map((f) =>
            `<span class="detail-filter-item ${f.key === this._charFilter ? 'active' : ''}" data-char-filter="${f.key}" role="tab" aria-selected="${f.key === this._charFilter}">${f.label}</span>`).join('')}</div>`;
        box.html(`${filterBar}${shown.length ? `<div class="detail-char-grid">${shown.map((x) => x.html).join('')}</div>` : '<div class="tip-line">该分类下暂无角色</div>'}`);
        box.find('.detail-char-card').on('click', (e) => {
            e.stopPropagation(); // 避免冒泡到 kazumi.js 的 #detail-body img 放大浮层
            const cid = String($(e.currentTarget).data('char-id') || '');
            if (cid) this._openCharacterDetail(cid);
        });
        box.find('[data-char-filter]').on('click', (e) => {
            this._charFilter = String($(e.currentTarget).data('char-filter') || 'main');
            this._renderCharacters();
        });
    },

    /** 人物详情浮层（仿 Kazumi CharacterPage）：资料 + 吐槽，两页签切换。 */
    async _openCharacterDetail(characterId) {
        if (typeof Kazumi === 'undefined') return;
        let wrap = document.getElementById('char-float');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'char-float';
            document.body.appendChild(wrap);
            wrap.addEventListener('click', (ev) => { if (ev.target === wrap) wrap.classList.remove('show'); });
        }
        wrap.innerHTML = '<div class="char-float-panel"><div class="tip-line">载入中…</div></div>';
        wrap.classList.add('show');
        const panel = wrap.firstChild;
        try {
            const [info, comments] = await Promise.all([
                Kazumi.bangumiCharacter(characterId).catch(() => null),
                Kazumi.bangumiCharacterComments(characterId).catch(() => []),
            ]);
            if (!info) { panel.innerHTML = '<div class="char-float-head"><button class="char-float-close">✕</button></div><div class="tip-line">角色详情载入失败</div>'; this._bindCharFloat(wrap); return; }
            const img = bangumiCover(info.images, 'card');
            // 角色中文名：Bangumi 角色接口 name 字段为原名（日文），无独立 name_cn 字段；
            // 中文名通常嵌在 infobox 的「别名:简体中文」项里，提取出来作为副标题展示。
            const charNameCn = Detail._pickCharNameCn(info);
            // 基本信息：把名称类字段（简体中文名 → 第二中文名 → 日文名 → 别名…）排到最前，
            // 其余字段按原顺序跟随；数组值（如「别名」多条）展开为多行。
            const infoStr = Detail._buildCharInfoStr(info);
            const metaBits = [
                info.blood_type ? '血型 ' + info.blood_type : '',
                info.height ? '身高 ' + info.height + 'cm' : '',
                info.weight ? '体重 ' + info.weight + 'kg' : '',
            ].filter(Boolean).join(' · ');
            const cmtList = (comments || []);
            this._charComments = cmtList;
            panel.innerHTML = `
                <div class="char-float-head">
                    <div class="char-float-title">
                        <span class="char-float-name-main">${escHtml(info.name || '人物')}</span>
                        ${charNameCn && charNameCn !== (info.name || '') ? `<span class="char-float-name-cn">${escHtml(charNameCn)}</span>` : ''}
                    </div>
                    <button class="char-float-close" title="关闭">✕</button>
                </div>
                <div class="char-float-tabs class-tabs">
                    <span class="class-tab active" data-ctab="info">资料</span>
                    <span class="class-tab" data-ctab="comments">吐槽（${cmtList.length}）</span>
                    <button type="button" class="md-btn md-btn-tonal md-btn-sm char-cmt-order" style="display:none;">${this._charCommentDesc ? '⇅ 切正序' : '⇅ 切倒序'}</button>
                </div>
                <div class="char-float-body">
                    <div class="char-float-pane" data-cpane="info">
                        <div class="char-float-info-row">
                            ${img ? `<img class="char-float-img" src="${escHtml(img)}" referrerpolicy="no-referrer" title="点击放大查看" onerror="this.style.display='none'">` : ''}
                            <div class="char-float-info-text">
                                ${metaBits ? `<div class="char-float-meta">${escHtml(metaBits)}</div>` : ''}
                                ${infoStr ? `<div class="detail-section-heading">基本信息</div><div class="char-float-summary">${escHtml(infoStr)}</div>` : ''}
                                ${info.summary ? `<div class="detail-section-heading">角色简介</div><div class="char-float-summary">${escHtml(stripHtml(info.summary))}</div>` : (infoStr ? '' : '<div class="tip-line">暂无角色简介</div>')}
                            </div>
                        </div>
                    </div>
                    <div class="char-float-pane" data-cpane="comments" style="display:none;">
                        <div class="char-float-cmt-list"></div>
                    </div>
                </div>`;
            this._bindCharFloat(wrap);
            this._renderCharComments(panel);
            // 人物大图点击放大（复用封面全屏浮层，滚轮缩放）
            const bigImg = (info.images && (info.images.large || info.images.medium)) || img;
            $(panel).find('.char-float-img').css('cursor', 'zoom-in').on('click', (ev) => {
                ev.stopPropagation();
                if (bigImg) this._openCoverFloat(bigImg);
            });
        } catch (e) {
            panel.innerHTML = '<div class="char-float-head"><button class="char-float-close">✕</button></div><div class="tip-line">角色详情载入失败</div>';
            this._bindCharFloat(wrap);
        }
    },

    _bindCharFloat(wrap) {
        const panel = wrap.firstChild;
        $(panel).find('.char-float-close').off('click').on('click', () => wrap.classList.remove('show'));
        $(panel).find('.char-float-tabs .class-tab').off('click').on('click', (e) => {
            const t = String($(e.currentTarget).data('ctab') || 'info');
            $(panel).find('.char-float-tabs .class-tab').removeClass('active');
            $(e.currentTarget).addClass('active');
            $(panel).find('.char-float-pane').each(function () {
                this.style.display = ($(this).data('cpane') === t) ? '' : 'none';
            });
            // 排序按钮仅在「吐槽」页签显示（与左侧两个页签在同一行齐平）
            $(panel).find('.char-cmt-order').css('display', t === 'comments' ? '' : 'none');
        });
        $(panel).find('.char-cmt-order').off('click').on('click', () => {
            this._charCommentDesc = !this._charCommentDesc;
            $(panel).find('.char-cmt-order').text(this._charCommentDesc ? '⇅ 切正序' : '⇅ 切倒序');
            this._renderCharComments(panel);
        });
    },

    /** 渲染角色吐槽列表（支持排序切换；含用户头像、回复与完整时间）。 */
    _renderCharComments(panel) {
        // 与番剧吐槽一致：按时间显式排序（false=正序旧→新，true=倒序新→旧），不依赖接口返回顺序。
        const list = (this._charComments || []).slice().sort((a, b) => {
            const ta = Detail._commentTsMs(a.createdAt || a.created_at || a.updatedAt || a.updated_at || 0);
            const tb = Detail._commentTsMs(b.createdAt || b.created_at || b.updatedAt || b.updated_at || 0);
            return this._charCommentDesc ? tb - ta : ta - tb;
        });
        const html = list.length ? list.map((c) => {
            const user = (c.user && (c.user.nickname || c.user.username)) || c.username || c.nickname || '';
            const avatar = (c.user && c.user.avatar && (c.user.avatar.medium || c.user.avatar.small || c.user.avatar.large))
                || c.avatar || '';
            const avatarBig = (c.user && c.user.avatar && (c.user.avatar.large || c.user.avatar.medium || c.user.avatar.small))
                || c.avatar || avatar;
            const text = c.content || c.comment || '';
            const time = Detail._fmtCommentTimeFull(c.createdAt || c.created_at || c.updatedAt || c.updated_at || 0);
            const replies = (Array.isArray(c.replies) && c.replies.length) ? c.replies : null;
            const repliesHtml = replies ? `<div class="detail-comment-replies">${replies.map((r) => {
                const ru = (r.user && (r.user.nickname || r.user.username)) || r.username || r.nickname || '';
                const ra = (r.user && r.user.avatar && (r.user.avatar.medium || r.user.avatar.small || r.user.avatar.large))
                    || r.avatar || '';
                const raBig = (r.user && r.user.avatar && (r.user.avatar.large || r.user.avatar.medium || r.user.avatar.small))
                    || r.avatar || ra;
                const rt = r.content || r.comment || '';
                const rtime = Detail._fmtCommentTimeFull(r.createdAt || r.created_at || r.updatedAt || r.updated_at || 0);
                return `<div class="detail-comment-reply">
                    <div class="detail-comment-head">
                        ${ra ? `<img class="detail-comment-avatar" src="${escHtml(ra)}" data-big="${escHtml(raBig)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'">` : ''}
                        <span class="detail-comment-user">${escHtml(ru)}</span><span class="detail-comment-time">${escHtml(rtime)}</span>
                    </div>
                    <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof rt === 'string' ? rt : '')}</div>
                </div>`;
            }).join('')}</div>` : '';
            return `<div class="detail-comment">
                <div class="detail-comment-head">
                    ${avatar ? `<img class="detail-comment-avatar" src="${escHtml(avatar)}" data-big="${escHtml(avatarBig)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'">` : ''}
                    <span class="detail-comment-user">${escHtml(user)}</span><span class="detail-comment-time">${escHtml(time)}</span>
                </div>
                <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof text === 'string' ? text : '')}</div>
                ${repliesHtml}
            </div>`;
        }).join('') : '<div class="tip-line">暂无吐槽</div>';
        $(panel).find('.char-float-cmt-list').html(html);
        // 吐槽用户头像点击放大（复用封面全屏浮层）：优先用 data-big 的大图
        $(panel).find('.char-float-cmt-list .detail-comment-avatar').css('cursor', 'zoom-in').off('click.avatar').on('click.avatar', (ev) => {
            ev.stopPropagation();
            const el = ev.currentTarget;
            const big = el.getAttribute('data-big') || el.getAttribute('src');
            if (big) Detail._openCoverFloat(big);
        });
    },

    /** 制作职位重要性排序权重：数字越小越靠前。命中越靠前的关键词优先级越高。
     *  未收录职位统一排到已知职位之后（保持接口原有相对顺序）。 */
    _staffJobRank(jobs) {
        // 职位重要性排序表（从高到低）。含「监督」类需列全，避免「音响监督」被泛化「监督」误吞：
        // 对每个职位取「最长匹配关键词」的权重，长关键词优先，保证专项监督不会被顶到导演级。
        const ORDER = [
            '原作', '导演', '总监督', '监督', '系列构成', '脚本', '剧本',
            '分镜', '演出', '角色设定', '人物设定', '总作画监督', '作画监督',
            '美术监督', '美术设计', '色彩设计', '摄影监督', '音响监督', '音乐',
            '剪辑', '主题歌', '动画制作', '制作',
        ];
        const arr = Array.isArray(jobs) ? jobs : (jobs ? [jobs] : []);
        let best = ORDER.length; // 未知职位排在末尾
        for (const j of arr) {
            const s = String(j || '');
            let matchIdx = -1;
            let matchLen = 0;
            // 取最长匹配关键词，避免「音响监督/总作画监督」被短词「监督」抢占高优先级。
            for (let i = 0; i < ORDER.length; i++) {
                if (s.includes(ORDER[i]) && ORDER[i].length > matchLen) {
                    matchLen = ORDER[i].length;
                    matchIdx = i;
                }
            }
            if (matchIdx >= 0 && matchIdx < best) best = matchIdx;
        }
        return best;
    },

    /** 制作人员职业分类（筛选用）：每类一组关键词，人员任一职位命中即归入该类。
     *  分类表即筛选条顺序；未命中任何类的人员在「全部」下照常展示。 */
    _staffJobCategories: [
        { key: 'all', label: '全部' },
        { key: 'director', label: '导演/监督', kw: /导演|监督|演出|分镜|コンテ/ },
        { key: 'script', label: '脚本/系列构成', kw: /脚本|剧本|系列构成|構成|编剧/ },
        { key: 'chara', label: '角色/作画', kw: /角色设计|人物设定|キャラ|作画|总作画|原画/ },
        { key: 'art', label: '美术/音乐', kw: /美术|色彩|背景|音乐|音响|主题歌|OP|ED/ },
        { key: 'produce', label: '制作/企划', kw: /制作|企划|原作|出品|动画制作|制片人|プロデューサー/ },
    ],

    _renderStaff() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (!this._bgmExtraLoaded) { box.html('<div class="tip-line">加载中…</div>'); return; }
        if (!this._staff.length) { box.html('<div class="tip-line">暂无制作人员信息</div>'); return; }
        // 职业分类筛选（默认全部）：key 归一化防脏值，选中类下只展示命中人员
        const cats = this._staffJobCategories;
        if (!cats.some((c) => c.key === this._staffFilter)) this._staffFilter = 'all';
        const jobArrOf = (s) => (Array.isArray(s.jobs) ? s.jobs : (s.jobs ? [s.jobs] : (s.relation ? [s.relation] : [])));
        const cur = cats.find((c) => c.key === this._staffFilter) || cats[0];
        const filtered = this._staff.filter((s) => {
            if (cur.key === 'all') return true;
            const jobs = jobArrOf(s).join(' ');
            return cur.kw.test(jobs);
        });
        // 按制作职位重要性从左到右排序（稳定排序：同权重保留接口原有顺序）。
        const sorted = filtered
            .map((s, i) => ({ s, i, rank: Detail._staffJobRank(s.jobs || s.relation) }))
            .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
            .map((x) => x.s);
        const filterBar = `<div class="detail-filter-bar" role="tablist" aria-label="制作人员职业筛选">${cats.map((c) =>
            `<span class="detail-filter-item ${c.key === this._staffFilter ? 'active' : ''}" data-staff-filter="${c.key}" role="tab" aria-selected="${c.key === this._staffFilter}">${c.label}</span>`).join('')}</div>`;
        box.html(`${filterBar}${sorted.length ? `<div class="detail-staff-grid">${sorted.map((s) => {
            // 与 _staffJobRank 同口径：jobs 兼容数组 / 字符串 / 空值——镜像源可能返回
            // 字符串形态，直接 .join 会抛 TypeError 导致整个制作页签渲染失败
            const jobs = jobArrOf(s).join(' / ');
            // 中文名优先显示（若存在），否则用原名；副标题展示另一个名字。
            const cn = s.name_cn || (s.infobox && Detail._pickCharNameCn({ infobox: s.infobox })) || '';
            const orig = s.name || '';
            const mainName = cn || orig;
            const subName = (cn && orig && cn !== orig) ? orig : '';
            const img = (s.images && (s.images.medium || s.images.grid || s.images.small)) || '';
            return `<div class="detail-staff">
                ${img ? `<img class="detail-staff-avatar" src="${escHtml(img)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.style.display='none'">` : '<span class="detail-staff-noimg">👤</span>'}
                <div class="detail-staff-info">
                    <span class="detail-staff-jobs">${escHtml(jobs)}</span>
                    <span class="detail-staff-name">${escHtml(mainName)}</span>
                    ${subName ? `<span class="detail-staff-subname">${escHtml(subName)}</span>` : ''}
                </div>
            </div>`;
        }).join('')}</div>` : '<div class="tip-line">该分类下暂无制作人员</div>'}`);
        box.find('[data-staff-filter]').on('click', (e) => {
            this._staffFilter = String($(e.currentTarget).data('staff-filter') || 'all');
            this._renderStaff();
        });
    },

    _renderRelations() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (!this._bgmExtraLoaded) { box.html('<div class="tip-line">加载中…</div>'); return; }
        box.html(this._relations.length ? `<div class="detail-relation-grid">${this._relations.map((r) => {
            const img = (r.images && (r.images.medium || r.images.grid || r.images.common || r.image)) || '';
            const name = r.name_cn || r.name || '';
            const subName = (r.name && r.name_cn && r.name !== r.name_cn) ? r.name : '';
            return `<div class="detail-relation" ${r.id ? `data-rel-id="${escHtml(r.id)}" tabindex="0"` : ''}>
                <div class="detail-relation-poster">${img ? `<img src="${escHtml(img)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.closest('.detail-relation-poster').classList.add('noimg');this.remove()">` : '<span class="detail-relation-noimg">🎬</span>'}</div>
                <div class="detail-relation-info">
                    <span class="detail-relation-type">${escHtml(r.relation || '')}</span>
                    <span class="detail-relation-name">${escHtml(name)}</span>
                    ${subName ? `<span class="detail-relation-subname">${escHtml(subName)}</span>` : ''}
                </div>
            </div>`;
        }).join('')}</div>` : '<div class="tip-line">暂无关联番剧</div>');
        box.find('.detail-relation[data-rel-id]').on('click', (e) => {
            const id = String($(e.currentTarget).data('rel-id') || '');
            if (id && typeof Kazumi !== 'undefined' && Kazumi.openBangumiInfoPage) Kazumi.openBangumiInfoPage(id);
        });
    },

    async _loadBgmExtra() {
        if (!this._bgmId || typeof Kazumi === 'undefined') return;
        const cacheKey = String(this._bgmId);
        const gen = ++this._bgmExtraGen; // 本次加载世代：导航/重载会自增，作废在途的旧 subject 结果
        // 命中 localStorage 持久缓存（角色/制作/关联/吐槽首屏 100 条）直接上屏，免四路并发网络
        const cached = _detailCacheGet(DETAIL_BGMEXTRA_CACHE_PREFIX, cacheKey);
        if (cached && typeof cached === 'object') {
            if (gen !== this._bgmExtraGen) return; // 已切到别的番剧，丢弃
            this._comments = Array.isArray(cached.comments) ? cached.comments : [];
            this._commentOffset = this._comments.length;
            this._commentAllLoaded = this._comments.length < 100;
            // 旧版本缓存无 total 字段：0 = 未知，计数文案回退已加载口径
            this._commentTotal = Number(cached.commentTotal) || 0;
            // 缓存里 total 只在首页请求时有意义（=远端总数）；续拉后的缓存快照
            // 同值写入，无碍。total 不大于已加载数且未全载时按未知处理更稳妥：
            // 全载判定已在 _commentAllLoaded，文案层 _commentCountText 自会处理
            this._characters = Array.isArray(cached.characters) ? cached.characters : [];
            this._staff = Array.isArray(cached.staff) ? cached.staff : [];
            this._relations = Array.isArray(cached.relations) ? cached.relations : [];
            this._bgmExtraLoaded = true;
            // 缓存数据上屏走淡入。仅限四个 Bangumi 页签触发重渲染（_activeTab
            // 必为其中之一，_renderTabContent 派发到同一渲染器）；不重渲染
            // 概览/分集，避免重置分集多选等交互状态。吸顶区间内数据落位后
            // 内容保持在功能栏之下可见
            if (['吐槽', '选集讨论', '角色', '关联', '制作'].includes(this._activeTab)) {
                const deep = this._isBelowTabsStick();
                this._swapTabContent(() => this._renderTabContent());
                this._snapToTabsStick(deep);
            }
            return;
        }
        try {
            const [commentsRes, chars, staff, relations] = await Promise.all([
                Kazumi.bangumiComments(this._bgmId, 100, 0).catch(() => ({ list: [], total: 0 })),
                Kazumi.bangumiCharacters(this._bgmId).catch(() => []),
                Kazumi.bangumiStaff(this._bgmId).catch(() => []),
                Kazumi.bangumiRelations(this._bgmId).catch(() => []),
            ]);
            // 关键修复：并发拉取期间若已导航到别的番剧（点关联卡片/返回），本轮结果作废，
            // 否则会把上一部/下一部的关联/角色数据写进当前状态并叠加渲染，出现多余卡片与闪烁。
            if (gen !== this._bgmExtraGen) return;
            const comments = (commentsRes && Array.isArray(commentsRes.list)) ? commentsRes.list : [];
            this._comments = comments;
            this._commentOffset = this._comments.length;   // 已加载偏移，供下拉续拉
            this._commentAllLoaded = this._comments.length < 100;
            this._commentTotal = Number(commentsRes && commentsRes.total) || 0; // 真实总数（远端 total）
            this._characters = chars || [];
            this._staff = staff || [];
            this._relations = relations || [];
            this._bgmExtraLoaded = true;
            // 落盘持久缓存（四类合并为一条；空 bundle 不缓存，交 _detailCacheSet 的空值守卫处理）
            if (this._comments.length || this._characters.length || this._staff.length || this._relations.length) {
                _detailCacheSet(DETAIL_BGMEXTRA_CACHE_PREFIX, cacheKey, {
                    comments: this._comments, characters: this._characters,
                    staff: this._staff, relations: this._relations,
                    commentTotal: this._commentTotal,
                }, DETAIL_BGMEXTRA_TTL);
            }
            // 网络数据到达后重绘：与缓存命中分支同语义——仅四个 Bangumi 页签
            // 走动画式交换（淡入，消除「加载中→数据」两段跳变）；吸顶区间内
            // 数据落位后内容保持在功能栏之下可见
            if (['吐槽', '选集讨论', '角色', '关联', '制作'].includes(this._activeTab)) {
                const deep = this._isBelowTabsStick();
                this._swapTabContent(() => this._renderTabContent());
                this._snapToTabsStick(deep);
            }
        } catch (e) { /* Bangumi 数据加载失败 */ }
    },

    /** 下拉续拉更多吐槽（无条数上限，滚到底部继续加载）。 */
    async _loadMoreComments() {
        if (this._commentAllLoaded || this._commentLoading || !this._bgmId || typeof Kazumi === 'undefined') return;
        this._commentLoading = true;
        const gen = this._bgmExtraGen; // M-30c：评论续拉世代守卫
        try {
            const moreRes = await Kazumi.bangumiComments(this._bgmId, 100, this._commentOffset || 0).catch(() => ({ list: [], total: 0 }));
            const more = (moreRes && Array.isArray(moreRes.list)) ? moreRes.list : [];
            if (gen !== this._bgmExtraGen) return; // 已切到其他番剧，旧评论丢弃
            // 续拉响应里仍带远端总数：刷新 _commentTotal（远端可能新增了吐槽）
            const resTotal = Number(moreRes && moreRes.total) || 0;
            if (resTotal > 0) this._commentTotal = resTotal;
            if (more.length) {
                this._comments = this._comments.concat(more);
                this._commentOffset = (this._commentOffset || 0) + more.length;
                if (more.length < 100) this._commentAllLoaded = true;
                this._renderComments(true);
            } else {
                this._commentAllLoaded = true;
            }
        } finally {
            this._commentLoading = false;
        }
    },

    /** 吐槽乐观刷新（T80）：评分/吐槽提交成功后调用。
     *  next.bgm.tv 评论接口有索引延迟，提交后立刻重拉未必包含新吐槽——先乐观插入
     *  本地行（「我的吐槽 · 刚刚」）保证立即可见，再清缓存后台重拉合并去重：
     *  稳定键（_commentKeys 的时间戳+用户+评分+正文指纹）不同，真实行到达后靠
     *  ts/用户/正文近似匹配替换乐观行，避免同一吐槽显示两遍。
     *  @param {object} opts { subjectId, rate, comment } 提交内容 */
    async onBgmCommentSubmitted(opts) {
        const o = opts || {};
        const sid = String(o.subjectId || this._bgmId || '');
        if (!sid || sid !== String(this._bgmId || '')) return; // 已导航到别的番剧
        const text = String(o.comment || '').trim();
        // 1) 乐观插入（有吐槽正文才有可插的行；纯评分无正文时跳过，仅刷新）
        if (text && Array.isArray(this._comments)) {
            const optimistic = {
                user: { nickname: '我的吐槽' },
                comment: text,
                createdAt: Date.now(),
                _optimistic: true, // 重拉合并时识别替换；排序键与真实行不同
            };
            if (o.rate) optimistic.rate = Number(o.rate) || 0;
            this._comments = this._comments.concat([optimistic]);
            this._renderComments();
        }
        // 2) 清 bgmextra 持久缓存（30 分钟 TTL 会把旧吐槽顶回来）+ 后台重拉合并。
        //    延迟 3s 再拉：给站点索引一点消化时间，降低「重拉结果不含新吐槽」概率。
        if (typeof localCacheDel === 'function') {
            try { localCacheDel(DETAIL_BGMEXTRA_CACHE_PREFIX + sid); } catch (e) { /* ignore */ }
        }
        setTimeout(() => {
            // 世代守卫：延迟期间导航离开/切换番剧则放弃
            if (String(this._bgmId || '') !== sid) return;
            this._bgmExtraLoaded = false;
            this._loadBgmExtra().then(() => this._mergeOptimisticComments(sid, text));
        }, 3000);
    },

    /** 重拉完成后合并乐观行：真实数据里已能匹配到同正文吐槽（站点索引已生效）时
     *  移除乐观占位行，避免重复；重拉结果仍不含（索引延迟未过）则保留乐观行。 */
    _mergeOptimisticComments(sid, text) {
        if (String(this._bgmId || '') !== sid) return;
        if (!Array.isArray(this._comments) || !this._comments.length) return;
        const hasOptimistic = this._comments.some((c) => c && c._optimistic);
        if (!hasOptimistic) return;
        const t = String(text || '').trim();
        const realMatch = t && this._comments.some((c) => c && !c._optimistic
            && String(c.comment || c.content || '').trim() === t);
        if (realMatch) {
            this._comments = this._comments.filter((c) => !(c && c._optimistic));
            this._renderComments();
        }
        // 未匹配：保留乐观行（下次进入详情页/再刷新时 _loadBgmExtra 重拉，
        // 新数据不含 _optimistic 标记，乐观行随整表替换自然消失——见 _loadBgmExtra 写入路径）
    },

    // ---------------------------------------------------------------- 选集讨论（对齐 Kazumi EpisodeCommentsView）

    /** 选集评论状态复位（打开/切换番剧/嵌套恢复时调用）：清空评论与选中集，
     *  自增世代作废在途的旧集评论请求；连带清空分集列表缓存（跨番剧防串档：
     *  _bgmEps 属于上一个番剧，留着会在选集讨论/分集页签闪出旧数据）。 */
    _resetEpComments() {
        this._epComments = [];
        this._epCommentsEpisodeId = 0;
        this._epCommentsLoading = false;
        this._epCommentsGen++;
        this._bgmEps = null;
    },

    /** 定位「选集讨论」页签应展示的集：优先用户上次选中的集（同番剧内切页签回来
     *  保持选择），否则取第 1 集。分集列表未加载时先拉取（后端 30 分钟缓存，开销小）。
     *  返回目标集对象（_bgmEps 项）或 null。 */
    async _ensureBgmEpisodes() {
        if (!this._bgmId || typeof Kazumi === 'undefined') return null;
        if (Array.isArray(this._bgmEps) && this._bgmEps.length) return this._bgmEps;
        // 守卫用 _bgmId 快照而非 _bgmExtraGen：同番剧吐槽提交后的 3 秒重拉会自增
        // _bgmExtraGen，借用它会误杀在途的分集请求（重进页签才恢复）
        const sid = String(this._bgmId);
        try {
            const data = await Kazumi.bangumiEpisodes(this._bgmId);
            if (String(this._bgmId || '') !== sid) return null; // 已切到别的番剧
            const list = ((data && data.data) || []).slice();
            // 直接写入 _bgmEps：分集页签若尚未打开，之后打开也直接复用（同一份数据）
            if (list.length) this._bgmEps = list;
            return list.length ? list : null;
        } catch (e) {
            return null;
        }
    },

    /** 「选集讨论」页签渲染：集数选择器 + 排序切换 + 评论列表（楼中楼缩进）。
     *  数据流：集列表（_bgmEps）→ 选中集 episode_id → kazumiBangumiEpisodeComments。
     *  无 token 权限要求（只读公开数据）；无 Bangumi 匹配/无分集时按空态展示。 */
    async _renderEpComments() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (typeof Kazumi === 'undefined') { box.html('<div class="tip-line">Kazumi 引擎不可用</div>'); return; }
        // 无分集数据：先拉分集列表（选集讨论与「分集」页签共用 _bgmEps 缓存）
        if (!(Array.isArray(this._bgmEps) && this._bgmEps.length)) {
            box.html('<div class="tip-line">载入分集列表中…</div>');
            const eps = await this._ensureBgmEpisodes();
            if (this._activeTab !== '选集讨论') return; // 等待期间已切页签
            if (!eps) { box.html('<div class="tip-line">暂无分集信息</div>'); return; }
        }
        // 选中集：上次选择 > 第 1 集。以 episode_id 为主键（防 SP/OP/ED 与正片同号歧义）。
        const eps = this._bgmEps;
        let cur = eps.find((ep) => ep && ep.id && Number(ep.id) === Number(this._epCommentsEpisodeId));
        if (!cur) {
            cur = eps.find((ep) => ep && Number(ep.type) === 0) || eps[0];
            this._epCommentsEpisodeId = Number(cur.id || 0);
        }
        this._renderEpCommentsShell(cur);
        this._loadEpComments(cur);
    },

    /** 页签骨架渲染：集数选择器（横向滚动 chips）+ 工具栏（排序）+ 评论列表容器。
     *  切集/切排序只重绘对应部分，不动列表骨架。 */
    _renderEpCommentsShell(cur) {
        const box = $('#detail-tab-content');
        const eps = this._bgmEps || [];
        const curId = Number((cur && cur.id) || 0);
        // 集数 chips：全部分集（含 SP/OP/ED，以 type 徽标区分）横排可滚，当前集高亮
        const chips = eps.map((ep, i) => {
            const eid = Number(ep && ep.id) || 0;
            const no = (ep && (ep.sort || ep.ep)) || (i + 1);
            const type = Number(ep && ep.type) === 1 ? 'SP' : Number(ep && ep.type) === 2 ? 'OP' : Number(ep && ep.type) === 3 ? 'ED' : '';
            return `<button type="button" class="ep-comments-chip${eid === curId ? ' active' : ''}" data-eid="${eid}"
                title="${escHtml(String((ep && (ep.name_cn || ep.name)) || ''))}">${escHtml(String(no))}${type ? `<i>${type}</i>` : ''}</button>`;
        }).join('');
        const curName = (cur && (cur.name_cn || cur.name)) || '';
        const curNo = (cur && (cur.sort || cur.ep)) || '?';
        box.html(`<div class="ep-comments-head">
                <div class="ep-comments-title">第 ${escHtml(String(curNo))} 集讨论<span class="ep-comments-sub">${escHtml(curName)}</span></div>
                <button type="button" id="ep-comments-order" class="md-btn md-btn-tonal md-btn-sm">${this._epCommentsDesc ? '⇅ 切正序' : '⇅ 切倒序'}</button>
            </div>
            <div class="ep-comments-chips">${chips}</div>
            <div class="ep-comments-list" id="ep-comments-list"><div class="tip-line">加载评论中…</div></div>`);
        box.find('#ep-comments-order').on('click', () => {
            this._epCommentsDesc = !this._epCommentsDesc;
            $('#ep-comments-order').text(this._epCommentsDesc ? '⇅ 切正序' : '⇅ 切倒序');
            this._renderEpCommentsList();
        });
        // 切集：更新选中态 + 标题，重拉评论（走后端 10 分钟 TTL 缓存）
        box.find('.ep-comments-chip').on('click', (e) => {
            const eid = Number($(e.currentTarget).data('eid') || 0);
            const ep = eps.find((x) => x && Number(x.id) === eid);
            if (!ep || eid === this._epCommentsEpisodeId) return;
            this._epCommentsEpisodeId = eid;
            box.find('.ep-comments-chip').removeClass('active');
            $(e.currentTarget).addClass('active');
            const nm = (ep.name_cn || ep.name) || '';
            box.find('.ep-comments-title').html(`第 ${escHtml(String(ep.sort || ep.ep || '?'))} 集讨论<span class="ep-comments-sub">${escHtml(nm)}</span>`);
            box.find('#ep-comments-list').html('<div class="tip-line">加载评论中…</div>');
            this._loadEpComments(ep);
        });
    },

    /** 拉取选中集的评论（世代守卫：切集/切番剧作废在途请求）。 */
    async _loadEpComments(ep) {
        const eid = Number((ep && ep.id) || this._epCommentsEpisodeId || 0);
        if (!eid || typeof Kazumi === 'undefined') return;
        const gen = ++this._epCommentsGen;
        this._epCommentsLoading = true;
        try {
            const list = await Kazumi.bangumiEpisodeComments(eid);
            if (gen !== this._epCommentsGen) return; // 已切集/切番剧，旧结果丢弃
            this._epComments = Array.isArray(list) ? list : [];
        } catch (e) {
            if (gen !== this._epCommentsGen) return;
            this._epComments = [];
        } finally {
            if (gen === this._epCommentsGen) this._epCommentsLoading = false;
        }
        if (this._activeTab !== '选集讨论') return; // 页签已切走：数据已并入状态，回来时自然渲染
        this._renderEpCommentsList();
    },

    /** 评论列表渲染（全量重绘；切集/切排序调用）。楼中楼 replies 缩进展示，
     *  与吐槽页签的行结构同款视觉（头像/昵称/时间/BBCode 正文）。 */
    _renderEpCommentsList() {
        const listBox = $('#ep-comments-list');
        if (!listBox.length) return;
        const list = (this._epComments || []).slice().sort((a, b) => {
            const ta = Detail._commentTsMs(a.createdAt || a.created_at || a.updatedAt || 0);
            const tb = Detail._commentTsMs(b.createdAt || b.created_at || b.updatedAt || 0);
            return this._epCommentsDesc ? tb - ta : ta - tb;
        });
        if (!list.length) {
            listBox.html('<div class="tip-line ep-comments-empty">本集还没有讨论</div>');
            return;
        }
        const rows = list.map((c) => {
            const user = (c.user && (c.user.nickname || c.user.username)) || '';
            const avatar = (c.user && c.user.avatar && (c.user.avatar.medium || c.user.avatar.small || c.user.avatar.large)) || '';
            const text = c.content || c.comment || '';
            const time = Detail._fmtCommentTimeFull(c.createdAt || c.created_at || 0);
            const replies = (Array.isArray(c.replies) && c.replies.length) ? c.replies : null;
            const repliesHtml = replies ? `<div class="detail-comment-replies">${replies.map((r) => {
                const ru = (r.user && (r.user.nickname || r.user.username)) || '';
                const ra = (r.user && r.user.avatar && (r.user.avatar.medium || r.user.avatar.small || r.user.avatar.large)) || '';
                const rt = r.content || r.comment || '';
                const rtime = Detail._fmtCommentTimeFull(r.createdAt || r.created_at || 0);
                return `<div class="detail-comment-reply">
                        <div class="detail-comment-head">
                            ${ra ? `<img class="detail-comment-avatar" src="${escHtml(ra)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.style.display='none'">` : ''}
                            <span class="detail-comment-user">${escHtml(ru)}</span><span class="detail-comment-time">${escHtml(rtime)}</span>
                        </div>
                        <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof rt === 'string' ? rt : '')}</div>
                    </div>`;
            }).join('')}</div>` : '';
            return `<div class="detail-comment">
                    <div class="detail-comment-head">
                        ${avatar ? `<img class="detail-comment-avatar" src="${escHtml(avatar)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.style.display='none'">` : ''}
                        <span class="detail-comment-user">${escHtml(user)}</span><span class="detail-comment-time">${escHtml(time)}</span>
                    </div>
                    <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof text === 'string' ? text : '')}</div>
                    ${repliesHtml}
                </div>`;
        }).join('');
        listBox.html(`<div class="ep-comments-count">共 ${list.length} 条讨论</div>${rows}`);
        // 切集/切排序后内容高度变化：同步钳制滚动防越界跳动
        this._clampDetailScroll();
    },

    _siteName(key) {
        try {
            const all = (typeof Home !== 'undefined' && Home._allSites) || [];
            const s = all.find((x) => x.key === key);
            return (s && s.name) || key;
        } catch (e) { return key; }
    },

    async _refreshLocalCol() {
        if (typeof Records === 'undefined') return;
        const fav = await Records.isFavorite(this.site, this.vodId);
        const tag = fav ? await Records.getFavTag(this.site, this.vodId) : '';
        const cur = fav ? (tag || 'want') : '';
        const labels = { want: '想看', watching: '在看', seen: '看过', hold: '搁置', dropped: '抛弃' };
        $('#detail-body .detail-col-btn').removeClass('active');
        $(`#detail-body .detail-col-btn[data-tag="${cur}"]`).addClass('active');
        // 单按钮同款同步（Bangumi 收藏按钮 #detail-col-current 的回填口径）：
        // 当前态文案写进按钮内 label；选中非空态时按钮高亮
        const single = $('#detail-local-col-current');
        if (single.length) {
            single.find('.detail-col-label').text(cur ? (labels[cur] || cur) : '未收藏');
            single.toggleClass('active', !!cur);
        }
    },

    /** 本地收藏六态设置（对齐 Bangumi 收藏交互）：空标签=移除收藏，其余=收藏并置状态。
     *  bangumiId 缺失时按片名搜索补齐（仅取 ID 供时间表筛选用，不替换封面/片名）。 */
    async setLocalCollection(tag) {
        const vod = this._lastVod;
        if (!vod || typeof Records === 'undefined') return;
        let bangumiId = (this._bgmId && String(this._bgmId)) || (this._bgmInfo && String(this._bgmInfo.id || '')) || '';
        // bangumiId 缺失时按片名搜索 Bangumi（仅取 ID 供时间表筛选用，不替换封面/片名）
        if (!bangumiId) {
            const name = vod.vod_name || this.vodName || '';
            if (name && typeof Kazumi !== 'undefined' && Kazumi.bangumiSearch) {
                try {
                    const bgmResults = await Kazumi.bangumiSearch(name);
                    if (bgmResults && bgmResults.length && bgmResults[0].id) {
                        bangumiId = String(bgmResults[0].id);
                    }
                } catch (e) { /* 匹配失败不影响收藏 */ }
            }
        }
        const entry = {
            site: this.site, vodId: this.vodId,
            name: vod.vod_name || this.vodName,
            pic: vod.vod_pic || '',
            remarks: vod.vod_remarks || '',
            siteName: this._siteName(this.site),
            bangumiId,
        };
        if (!tag) {
            const fav = await Records.isFavorite(this.site, this.vodId);
            if (fav) { await Records.toggleFavorite(entry); warnToast('已取消收藏'); }
        } else {
            await Records.setFavTag(entry, tag);
            const label = { want: '想看', watching: '在看', seen: '看过', hold: '搁置', dropped: '抛弃' }[tag] || tag;
            warnToast(`已收藏并标记为「${label}」`);
        }
                // 收藏变更由 FavHub.changed（recSet 内触发）统一广播：
                // 详情页收藏按钮（本对象订阅）、我的收藏页（My 订阅）、时间表据此自动刷新。
    },

    selectSource(idx) {
        if (idx < 0 || idx >= this.sources.length) return;
        this.activeSource = idx;
        $('#detail-tab-content .play-src').removeClass('active');
        $(`#detail-tab-content .play-src[data-idx="${idx}"]`).addClass('active');
        // 换线路先清空勾选：ep-btn 节点跨线路复用（renderEpisodes 只重排不重建），
        // 残留的 checked 会让批量播放/下载仍按旧线路的 data-idx 取新线路的集
        $('#detail-tab-content .ep-check').removeClass('checked');
        this.renderEpisodes();
        this._saveLastSource();
    },

    async _saveLastSource() {
        if (!this.site || !this.vodId) return;
        try {
            const s = (await window.yuki.settingsGet()) || {};
            const map = (s.lastSourceMap && typeof s.lastSourceMap === 'object') ? s.lastSourceMap : {};
            map[`${this.site}|${this.vodId}`] = this.activeSource;
            await window.yuki.settingsSet('lastSourceMap', map);
        } catch (e) { /* 保存失败不影响主流程 */ }
    },

    async _restoreLastSource() {
        if (!this.site || !this.vodId) return;
        try {
            const s = (await window.yuki.settingsGet()) || {};
            const map = (s.lastSourceMap && typeof s.lastSourceMap === 'object') ? s.lastSourceMap : {};
            const idx = map[`${this.site}|${this.vodId}`];
            if (typeof idx === 'number' && idx >= 0 && idx < this.sources.length) {
                this.activeSource = idx;
            }
        } catch (e) { /* 读取失败使用默认值 */ }
    },

    async _playEpisode(idx) {
        const src = this.sources[this.activeSource];
        if (!src) return;
        const ep = src.episodes[idx];
        if (!ep) return;
        // 播放失败只反馈当前线路的地址和错误，不自动切换其它线路；线路选择
        // 由用户手动完成，避免当前线路失败后悄悄播放了另一条线路。
        await Player.play(
            this.site, src.from, ep.url,
            this.vodName || '', ep.name,
            src.episodes, idx,
        );
    },

    toggleEpOrder() {
        this._epDesc = !this._epDesc;
        this.renderEpisodes();
    },

    renderEpisodes() {
        const src = this.sources[this.activeSource];
        const box = $('#ep-list');
        if (!src) return;
        $('#ep-order').text(this._epDesc ? '⇅ 切正序' : '⇅ 切倒序');
        const order = src.episodes.map((_, i) => i);
        if (this._epDesc) order.reverse();
        // 复用已渲染按钮按新顺序重排（append 已有节点 = 移动位置，不重建 DOM，
        // 避免切换顺序时列表清空重建导致的闪烁）；首次渲染或缺集才创建。
        const byIdx = {};
        box.children('.ep-btn').each(function () {
            const idx = parseInt(this.getAttribute('data-idx'), 10);
            if (!Number.isNaN(idx)) byIdx[idx] = this;
        });
        order.forEach((i) => {
            const ep = src.episodes[i];
            const existing = byIdx[i];
            if (existing) {
                box.append(existing);
                return;
            }
            box.append(`<button class="ep-btn" data-idx="${i}" title="${escHtml(ep.url)}">` +
                `<span class="ep-check" data-idx="${i}" title="勾选后可批量播放/下载"></span>` +
                `<span class="ep-name">${escHtml(ep.name)}</span>` +
                `<span class="ep-dl-one" data-idx="${i}" title="下载本集">⬇</span></button>`);
        });
        // 源切换后残留的多余按钮（如上一线路集数更多）清理掉
        const keep = new Set(order);
        box.children('.ep-btn').each(function () {
            const idx = parseInt(this.getAttribute('data-idx'), 10);
            if (!keep.has(idx)) $(this).remove();
        });
        $('#ep-check-all').prop('checked', false);
        this._syncDlBar();
    },

    _syncDlBar() {
        const n = $('#ep-list .ep-check.checked').length;
        $('#ep-dl-count').text(n ? `已勾选 ${n} 集` : '');
        $('#ep-dl-selected').text(n ? `⬇ 下载勾选集（${n}）` : '⬇ 下载勾选集');
        $('#ep-play-selected').text(n ? `▶ 播放勾选集（${n}）` : '▶ 播放勾选集');
    },

    async playSelected() {
        const src = this.sources[this.activeSource];
        if (!src) return;
        const idxs = $('#ep-list .ep-check.checked')
            .map(function () { return parseInt($(this).data('idx'), 10); })
            .get().sort((a, b) => a - b);
        if (!idxs.length) { warnToast('请先勾选要播放的集'); return; }
        const eps = idxs.map((i) => src.episodes[i]).filter(Boolean);
        if (!eps.length) { warnToast('当前线路没有对应剧集'); return; }
        const first = eps[0];
        let autoNext = true;
        try { autoNext = ((await window.yuki.settingsGet()) || {}).autoNext !== false; } catch (e) { /* 读失败默认连播 */ }
        if (eps.length > 1) {
            warnToast(autoNext ? `已加入播放列表 ${eps.length} 集，将自动连播` : '自动连播已关闭，仅播放勾选的第一集');
        }
        await Player.play(this.site, src.from, first.url, this.vodName || '', first.name, eps, 0);
    },

    downloadSelected() {
        const src = this.sources[this.activeSource];
        if (!src) return;
        const idxs = $('#ep-list .ep-check.checked')
            .map(function () { return parseInt($(this).data('idx'), 10); })
            .get().sort((a, b) => a - b);
        if (!idxs.length) { warnToast('请先勾选要下载的集'); return; }
        this._downloadEps(src, idxs);
    },

    async _downloadEps(src, idxs) {
        if (!src || !idxs.length) return;
        showLoading();
        let added = 0, ffmpegMissing = false, ffmpegDownloading = false, failed = 0;
        let skipDownloading = 0, skipDone = 0; // 同源同集去重：已在队列/已下载的集数
        for (const i of idxs) {
            const ep = src.episodes[i];
            if (!ep) continue;
            const r = await this._resolveDownloadUrl(src.from, ep.url);
            if (!r) { failed++; continue; }
            const isM3u8 = /\.m3u8(\?|#|$)/i.test(r.url.split('?')[0]);
            // 无法从 URL 识别扩展名时默认 .mp4（多数流媒体直链无标准后缀）
            const ext = isM3u8 ? '.mp4' : (r.url.split('?')[0].match(/\.(mp4|flv|mov|mkv|webm|avi|ts)$/i) || [''])[0] || '.mp4';
            const out = `${this.vodName || '视频'} - ${ep.name}${ext}`;
            try {
                // ep* 为同源同集去重上下文：与边下边播共用「站点|剧名|集名」key，
                // 命中重复任务/已完成文件时主进程直接跳过，不再重复下载
                const res = await window.yuki.download.control(isM3u8 ? 'addHls' : 'add', {
                    uri: r.url, out, header: r.header,
                    epSite: this.site || '', epVodName: this.vodName || '', epName: ep.name || '',
                });
                if (res && res.ok) added++;
                else if (res && res.reason === 'already-downloading') skipDownloading++;
                else if (res && res.reason === 'already-done') skipDone++;
                else if (res && res.reason === 'ffmpeg-downloading') ffmpegDownloading = true;
                else if (res && res.reason === 'ffmpeg-missing') ffmpegMissing = true;
                else failed++;
            } catch (e) { failed++; }
        }
        hideLoading();
        const bits = [];
        if (added) bits.push(`已加入下载 ${added} 集，可在“下载”页查看`);
        if (skipDownloading) bits.push(`${skipDownloading} 集已在下载队列，跳过重复下载`);
        if (skipDone) bits.push(`${skipDone} 集已下载过，无需重复下载`);
        if (ffmpegDownloading) bits.push('ffmpeg 正在后台自动下载（约 90MB），完成后重试即可');
        if (ffmpegMissing) bits.push('ffmpeg 未就绪，部分 m3u8 切片流暂无法合成（启动时后台下载中，请稍后重试）');
        if (failed) bits.push(`${failed} 集取不到下载地址`);
        warnToast(bits.join('；') || '没有可下载的集');
    },

    async _resolveDownloadUrl(flag, url) {
        try {
            const vipFlags = (typeof Player !== 'undefined' && Player.getVipFlags)
                ? await Player.getVipFlags() : [];
            const rsp = await doAction('playerContent', {
                site: this.site, flag, id: url, vipFlags: JSON.stringify(vipFlags),
            });
            const data = (rsp && typeof rsp === 'object') ? rsp : {};
            const u = data.url || url;
            const header = (data.header && typeof data.header === 'object') ? data.header : {};
            if (parseInt(data.parse, 10) !== 1) return { url: u, header };
            if (/\.(mp4|flv|mov|mkv|webm|ts|m3u8)(\?|#|$)/i.test(u.split('?')[0])) return { url: u, header };
            const r = await window.yuki.resolveParse(u);
            if (r && r.ok) return { url: r.url, header: { ...header, ...(r.header || {}) } };
            // page 型地址兜底：与播放链（player.js parse=1 分支）对齐——解析接口失败后
            // 用隐藏窗口嗅探页面自身播放器的媒体请求。此前手动下载缺这层兜底，page 源
            // 「播放可以、手动下载不了」（边下边播复用的是播放链已解析出的直链）。
            try {
                const cap = await window.yuki.captureDirect(u, false);
                if (cap && cap.ok && cap.url) {
                    return { url: cap.url, header: { ...header, ...(cap.header || {}) } };
                }
            } catch (e) { /* 嗅探失败按取不到地址 */ }
        } catch (e) { /* 单集失败不阻断批量 */ }
        return null;
    },
};

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.detail = Detail;
}(typeof window !== 'undefined' ? window : globalThis));
