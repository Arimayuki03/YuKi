/**
 * detail.js — 统一详情页（合并 CatVod 与 Bangumi 详情，仿 Kazumi InfoPage 设计）
 *
 * 布局：
 *  - 头部：封面 + 标题/元信息 + 收藏/标记按钮
 *  - 页签：概览 | 分集 | 角色 | 吐槽 | 制作 | 关联
 *  - 概览：可收起简介 + 播放源/选集
 *  - 其他页签：Bangumi 数据（仅当匹配到 Bangumi 时显示）
 */
/* global $, doAction, escHtml, stripHtml, normalizePic, warnToast, showLoading, hideLoading, registerEsc, openDialog, closeDialog, App, Player, Records, abortCoverFill, Kazumi, FavHub, bangumiCover, localCacheGet, localCacheSet */

const DETAIL_TABS = ['概览', '分集', '角色', '吐槽', '制作', '关联'];

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
    _commentDesc: false,    // 吐槽排序（false=按接口默认顺序，true=倒序）
    _commentLimit: 20,      // 吐槽当前展示条数（下拉加载递增）
    _charCommentDesc: false,
    _escBound: false,
    _lastVod: null,
    _vod: null,
    _bgmInfo: null,      // Bangumi 匹配到的信息
    _bgmId: null,         // Bangumi subject ID
    _activeTab: '概览',
    _descCollapsed: true, // 简介收起状态
    _comments: [],
    _characters: [],
    _staff: [],
    _relations: [],
    _bgmExtraLoaded: false,
    _bgmExtraGen: 0,     // Bangumi 补充数据加载世代：每次导航/重载自增，作废在途的旧 subject 异步结果

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
            // Kazumi 源弹窗
            .on('click', '#detail-kazumi-src', () => {
                if (typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    Kazumi.openSourceDialog(this.vodName || '', this.site, this.vodId);
                }
            })
            // Bangumi 收藏同步（统一详情页 T74）
            .on('click', '.kazumi-col-btn', async (e) => {
                const btn = $(e.currentTarget);
                const id = String(btn.closest('.kazumi-col-btns').data('id') || '');
                const val = parseInt(btn.data('type'), 10);
                const nm = this.vodName || '';
                if (!id || typeof Kazumi === 'undefined') return;
                if (val < 0) {
                    if (await Kazumi.removeBangumiCollection(id, nm)) Kazumi._applyBangumiColState(id);
                    // 同步移除本地收藏（时间表筛选依赖 bangumiId）
                    if (typeof Records !== 'undefined' && this._bgmId) {
                        const fav = await Records.isFavorite('bangumi', id);
                        if (fav) await Records.toggleFavorite({ site: 'bangumi', vodId: id, name: nm, bangumiId: id });
                    }
                } else if (await Kazumi.setBangumiCollection(id, val)) {
                    Kazumi._applyBangumiColState(id);
                    // 同步写入本地收藏（时间表筛选依赖 favorites 中的 bangumiId）
                    if (typeof Records !== 'undefined') {
                        const tagMap = { 1: 'want', 2: 'seen', 3: 'watching', 4: 'hold', 5: 'dropped' };
                        const tag = tagMap[val] || 'want';
                        const pic = (this._bgmInfo && this._bgmInfo.images && bangumiCover(this._bgmInfo.images, 'card')) || '';
                        await Records.setFavTag({ site: 'bangumi', vodId: id, name: nm, pic, siteName: 'Bangumi', bangumiId: id }, tag);
                    }
                }
                // 收藏变更由 Favorites.changed（recSet 内触发）统一广播：
                // 详情页收藏按钮、我的收藏页、时间表过滤集合据此自动刷新。
            })
            // 开始观看（Kazumi 源，Bangumi-only 详情）
            .on('click', '#detail-kazumi-start', () => {
                if (typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    Kazumi.openSourceDialog(this.vodName || '', 'kazumi', '');
                }
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
        this._bgmExtraLoaded = false;
        this._activeTab = '概览';
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
        this._bgmExtraLoaded = false;
        this._activeTab = '概览';
        App.showView('detail');
        showLoading();
        $('#detail-body').html('<div class="tip-line">正在载入详情…</div>');
        try {
            this._bgmInfo = await Kazumi.bangumiInfo(subjectId); // 30 分钟缓存
            if (!this._bgmInfo) { warnToast('Bangumi 详情载入失败'); hideLoading(); this.back(); return; }
            if (!this.vodName) this.vodName = this._bgmInfo.name_cn || this._bgmInfo.name || '';
            this.sources = []; // 无 CatVod 线路
            this.render();
        } catch (e) {
            warnToast('Bangumi 详情载入失败');
            this.back();
        } finally {
            hideLoading();
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
        this._bgmExtraGen++; // 作废在途的上一部番剧补充数据加载，防返回后旧结果叠加渲染（多余卡片/闪烁）
        this._comments = [];
        this._characters = [];
        this._staff = [];
        this._relations = [];
        this._bgmExtraLoaded = false;
        App.showView('detail');
        this.render();
        if (this._bgmId) this._loadBgmExtra();
        return true;
    },

    back() {
        // 嵌套跳转回退：优先从栈上恢复上一详情页（关联→新详情→返回原详情），
        // 栈空时再回到外部进入视图（home/search/timeline 等）。
        if (this._backStack && this._backStack.length) {
            const prev = this._backStack.pop();
            if (this._restore(prev)) return;
        }
        App.showView(this.backView || 'home');
    },

    /** CatVod 详情页自动匹配 Bangumi 数据开关（T74：设置 → 源设置，默认关）。 */
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
            if (!vod) {
                const err = data && data.error ? `（${String(data.error).slice(0, 120)}）` : '';
                $('#detail-body').html(`<div class="tip-line">未取得详情${err}</div>`);
                return;
            }
            if (vod.vod_name) this.vodName = vod.vod_name;
            this._vod = vod;
            this.sources = this.parsePlay(vod);
            this.activeSource = 0;
            await this._restoreLastSource();
            // 自动匹配 Bangumi（T74 开关：设置 → 源设置「详情页自动匹配 Bangumi 数据」，默认关）
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
            this.render();
        } catch (e) {
            $('#detail-body').html('<div class="tip-line">详情载入失败</div>');
            warnToast('详情载入失败');
        } finally {
            hideLoading();
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

    render() {
        this._lastVod = this._vod || null;
        const vod = this._vod;
        const bgm = this._bgmInfo;
        const hasBgm = !!this._bgmId;
        // 详情封面使用 detail 变体；bgm 无封面时回落源封面 vod_pic。
        const cover = (bgm && bgm.images && bangumiCover(bgm.images, 'detail'))
            || (vod && vod.vod_pic) || '';
        const name = bgm ? (bgm.name_cn || bgm.name || (vod && vod.vod_name) || this.vodName) : ((vod && vod.vod_name) || this.vodName);
        const meta = bgm
            ? [bgm.date || bgm.air_date ? `放送 ${bgm.date || bgm.air_date}` : '', bgm.platform, bgm.type_name].filter(Boolean).join(' · ')
            : this.metaLine(vod || {});
        const people = [
            vod && vod.vod_director ? `导演：${escHtml(vod.vod_director)}` : '',
            vod && vod.vod_actor ? `演员：${escHtml(vod.vod_actor)}` : '',
        ].filter(Boolean).join('<span class="detail-people-sep">·</span>');
        const localActions = vod ? this._localColHtml() : '';
        let html = `
        <div class="detail-head detail-hero ${hasBgm ? 'detail-hero-bangumi' : 'detail-hero-catvod'}">
            <div class="detail-cover detail-hero-cover">${vodCoverImg(cover, true)}</div>
            <div class="detail-info detail-hero-info">
                <div class="detail-kicker">${hasBgm ? 'BANGUMI 详情' : '影片详情'}</div>
                <h1 class="detail-title">${escHtml(name)}</h1>
                <div class="detail-meta">${escHtml(meta || '暂无更多信息')}</div>
                ${people ? `<div class="detail-people">${people}</div>` : ''}
                ${hasBgm ? this._bangumiStatsHtml(bgm) : `<div class="detail-catvod-facts">
                    <span class="detail-fact-label">播放信息</span>
                    <span class="detail-fact-value">${this.sources.length ? `${this.sources.length} 条线路 · 共 ${this.sources[0].episodes.length} 集` : '暂无播放线路'}</span>
                </div>`}
                <div class="detail-hero-actions">
                    ${localActions}
                    ${hasBgm ? this._bangumiColHtml(bgm) : ''}
                </div>
            </div>
        </div>`;
        // 页签栏
        const tabs = DETAIL_TABS.map((t) => `<span class="detail-tab ${t === this._activeTab ? 'active' : ''}" data-tab="${t}" role="tab" aria-selected="${t === this._activeTab ? 'true' : 'false'}">${t}</span>`).join('');
        html += `<div class="detail-tabs class-tabs" role="tablist" aria-label="详情内容">${tabs}</div>`;
        html += `<div id="detail-tab-content" class="detail-content" role="tabpanel"></div>`;
        $('#detail-body').html(html);
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

    /** 本地收藏按钮组（CatVod 源）：对齐 Bangumi 六态收藏样式（未收藏/想看/在看/看过/搁置/抛弃），点击即收藏并标记。 */
    _localColHtml() {
        return `<div class="kazumi-bangumi-colrow detail-local-colrow">
            <div class="detail-action-copy"><span class="detail-action-label">我的收藏</span><span class="tip-line pad0">点击状态即可收藏并标记</span></div>
            <div class="detail-col-btns detail-local-col-btns">
                <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="">未收藏</button>
                <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="want">想看</button>
                <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="watching">在看</button>
                <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="seen">看过</button>
                <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="hold">搁置</button>
                <button type="button" class="md-btn md-btn-sm detail-col-btn" data-tag="dropped">抛弃</button>
            </div>
        </div>`;
    },

    /** Bangumi 评分摘要：评分、星级、排名与 1-10 分人数分布共用一组 hero 指标。 */
    _bangumiStatsHtml(bgm) {
        const rating = (bgm && bgm.rating) || {};
        const score = Number(rating.score) || 0;
        const votes = Number(rating.total) || 0;
        const rank = Number(rating.rank) || 0;
        const stars = score
            ? `<span class="bi-stars" aria-label="${escHtml(String(score))} 分（满分 10 分）"><span class="bi-stars-bg">★★★★★</span><span class="bi-stars-fill" style="width:${Math.round(Math.max(0, Math.min(10, score)) * 10)}%">★★★★★</span></span>`
            : '<span class="detail-score-empty">暂无评分</span>';
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
        </div>`;
    },

    /** Bangumi 收藏按钮组 + 「开始观看」（统一详情页，T74）。 */
    _bangumiColHtml(bgm) {
        if (!bgm || !bgm.id) return '';
        const hasRules = typeof Kazumi !== 'undefined' && Kazumi.hasEnabledRules && Kazumi.hasEnabledRules();
        let h = `<div class="kazumi-bangumi-colrow">
            <div class="detail-action-copy"><span class="detail-action-label">Bangumi 收藏</span><span class="tip-line pad0">点击状态即可同步到账号</span></div>
            <div class="kazumi-col-btns" data-id="${escHtml(bgm.id)}">
                <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="-1">未收藏</button>
                <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="1">想看</button>
                <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="3">在看</button>
                <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="2">看过</button>
                <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="4">搁置</button>
                <button type="button" class="md-btn md-btn-sm kazumi-col-btn" data-type="5">抛弃</button>
            </div>
        </div>`;
        if (hasRules) {
            h += `<div class="kazumi-watch-row detail-watch-row detail-watch-row-plain">
                <button type="button" id="detail-kazumi-start" class="md-btn md-btn-filled md-btn-sm"><span class="detail-button-mark">▶</span>开始观看</button>
            </div>`;
        }
        return h;
    },

    _renderTabContent() {
        if (this._activeTab === '概览') this._renderOverview();
        else if (this._activeTab === '分集') this._renderEpisodes();
        else if (this._activeTab === '角色') this._renderCharacters();
        else if (this._activeTab === '制作') this._renderStaff();
        else if (this._activeTab === '吐槽') this._renderComments();
        else if (this._activeTab === '关联') this._renderRelations();
    },

    _switchTab(tab) {
        if (tab === this._activeTab) return;
        this._activeTab = tab;
        $('#detail-body .detail-tab').removeClass('active').attr('aria-selected', 'false');
        $(`#detail-body .detail-tab[data-tab="${tab}"]`).addClass('active').attr('aria-selected', 'true');
        this._renderTabContent();
    },

    _renderOverview() {
        const vod = this._vod;
        const bgm = this._bgmInfo;
        let html = '';
        // 简介（可收起）：CSS 用 -webkit-line-clamp 三行截断，展开显示全文；阈值放宽避免短简介出现无谓按钮
        const descText = bgm ? stripHtml(bgm.summary || '') : stripHtml((vod && vod.vod_content) || '');
        if (descText) {
            const canCollapse = descText.length > 140;
            const collapsed = this._descCollapsed && canCollapse;
            html += `<section class="detail-overview-card detail-desc-wrap">
                <div class="detail-section-heading">简介</div>
                <div class="detail-desc ${collapsed ? 'collapsed' : ''}">${escHtml(descText)}</div>
                ${canCollapse ? `<button type="button" id="detail-desc-toggle" class="md-btn md-btn-sm md-btn-tonal detail-desc-toggle">${collapsed ? '展开全部' : '收起'}</button>` : ''}
            </section>`;
        }
        // Bangumi 标签（含用户标记数量 t.count，仿 Kazumi ActionChip：标签名 + 主色数量）
        if (bgm && Array.isArray(bgm.tags) && bgm.tags.length) {
            const chips = bgm.tags.slice(0, 13).map((t) => {
                if (t && typeof t === 'object') {
                    const tn = t.name || '';
                    const cnt = (t.count != null) ? Number(t.count) : 0;
                    if (!tn) return '';
                    return `<span class="kazumi-tag" data-tag="${escHtml(tn)}" title="共 ${cnt} 人标记">${escHtml(tn)} <span class="kazumi-tag-count">${cnt}</span></span>`;
                }
                const tn = String(t || '');
                return tn ? `<span class="kazumi-tag" data-tag="${escHtml(tn)}">${escHtml(tn)}</span>` : '';
            }).filter(Boolean).join('');
            if (chips) html += `<section class="detail-overview-card bangumi-info-tags"><div class="detail-section-heading">标签</div><div class="kazumi-tags-wrap">${chips}</div></section>`;
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
        const n = $('#bgm-ep-list .ep-check.checked').length;
        if (!n) { warnToast('请先勾选要播放的集'); return; }
        const title = this.vodName || '';
        if (title && typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
            Kazumi.openSourceDialog(title, 'kazumi', '');
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

    _renderComments(append) {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (!this._bgmExtraLoaded) { box.html('<div class="tip-line">加载中…</div>'); return; }
        const list = this._commentDesc ? this._comments.slice().reverse() : this._comments;
        const rows = list.map((c) => {
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
                        ${ra ? `<img class="detail-comment-avatar" src="${escHtml(ra)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'">` : ''}
                        <span class="detail-comment-user">${escHtml(ru)}</span><span class="detail-comment-time">${escHtml(rtime)}</span>
                    </div>
                    <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof rt === 'string' ? rt : '')}</div>
                </div>`;
            }).join('')}</div>` : '';
            return `<div class="detail-comment">
                <div class="detail-comment-head">
                    ${avatar ? `<img class="detail-comment-avatar" src="${escHtml(avatar)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'">` : ''}
                    <span class="detail-comment-user">${escHtml(user)}</span>${rate ? `<span class="detail-comment-rate">★ ${escHtml(String(rate))}</span>` : ''}<span class="detail-comment-time">${escHtml(time)}</span>
                </div>
                <div class="detail-comment-text">${Detail._renderCommentBBCode(typeof text === 'string' ? text : '')}</div>
                ${repliesHtml}
            </div>`;
        }).join('');
        const foot = this._commentAllLoaded
            ? (this._comments.length ? '<div class="tip-line detail-comment-end">没有更多了</div>' : '')
            : '<div class="tip-line detail-comment-more">下拉加载更多…</div>';
        box.html(`<div class="detail-comment-toolbar">
                <span class="detail-comment-count">共 ${this._comments.length} 条${this._commentAllLoaded ? '' : '+'}</span>
                <button type="button" id="detail-comment-order" class="md-btn md-btn-tonal md-btn-sm">${this._commentDesc ? '⇅ 切正序' : '⇅ 切倒序'}</button>
            </div>
            <div id="detail-comment-scroll" class="detail-comment-scroll">${rows || '<div class="tip-line">暂无吐槽</div>'}${foot}</div>`);
        $('#detail-comment-order').on('click', () => { this._commentDesc = !this._commentDesc; this._renderComments(); });
        // 滚动到底部续拉（无条数上限）
        const sc = document.getElementById('detail-comment-scroll');
        if (sc) {
            sc.addEventListener('scroll', () => {
                if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 40) this._loadMoreComments();
            });
        }
    },

    /** 评论时间：兼容 Unix 秒/毫秒时间戳与字符串。 */
    _fmtCommentTime(ts) {
        if (!ts) return '';
        if (typeof ts === 'string' && !/^\d+$/.test(ts)) return ts;
        let n = Number(ts);
        if (!n) return '';
        if (n < 1e12) n *= 1000; // 秒 → 毫秒
        const d = new Date(n);
        if (isNaN(d.getTime())) return '';
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
        const cards = this._characters.slice().map((c) => {
            const orig = c.name || '';
            const cn = c.name_cn || '';
            const mainName = cn || orig;
            const subName = (cn && orig && cn !== orig) ? orig : ''; // 中文名打头，原名作副行（相同则不重复）
            return {
                role: String(c.relation || c.role_name || ''),
                html: `<div class="detail-char-card" data-char-id="${escHtml(c.id || '')}" tabindex="0" title="点击查看人物详情与吐槽">
                    <div class="detail-char-avatar-wrap">${(c.images && (c.images.medium || c.images.grid))
                        ? `<img class="detail-char-avatar" src="${escHtml(c.images.medium || c.images.grid)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.closest('.detail-char-avatar-wrap').classList.add('noimg');this.remove()">`
                        : '<span class="detail-char-noimg">🎭</span>'}</div>
                    <div class="detail-char-name">${escHtml(mainName)}</div>
                    ${subName ? `<div class="detail-char-name-cn">${escHtml(subName)}</div>` : ''}
                    <div class="detail-char-role">${escHtml(c.relation || c.role_name || '')}</div>
                </div>`,
            };
        });
        cards.sort((a, b) => roleWeight(a.role) - roleWeight(b.role));
        box.html(`<div class="detail-char-grid">${cards.map((x) => x.html).join('')}</div>`);
        box.find('.detail-char-card').on('click', (e) => {
            e.stopPropagation(); // 避免冒泡到 kazumi.js 的 #detail-body img 放大浮层
            const cid = String($(e.currentTarget).data('char-id') || '');
            if (cid) this._openCharacterDetail(cid);
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
        const list = (this._charComments || []).slice();
        if (this._charCommentDesc) list.reverse();
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

    _renderStaff() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (!this._bgmExtraLoaded) { box.html('<div class="tip-line">加载中…</div>'); return; }
        // 按制作职位重要性从左到右排序（稳定排序：同权重保留接口原有顺序）。
        const sorted = this._staff
            .map((s, i) => ({ s, i, rank: Detail._staffJobRank(s.jobs || s.relation) }))
            .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
            .map((x) => x.s);
        box.html(sorted.length ? `<div class="detail-staff-grid">${sorted.map((s) => {
            const jobs = (s.jobs || (s.relation ? [s.relation] : [])).join(' / ');
            // 中文名优先显示（若存在），否则用原名；副标题展示另一个名字。
            const cn = s.name_cn || (s.infobox && Detail._pickCharNameCn({ infobox: s.infobox })) || '';
            const orig = s.name || '';
            const mainName = cn || orig;
            const subName = (cn && orig && cn !== orig) ? orig : '';
            const img = (s.images && (s.images.medium || s.images.grid || s.images.small)) || '';
            return `<div class="detail-staff">
                ${img ? `<img class="detail-staff-avatar" src="${escHtml(img)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'">` : '<span class="detail-staff-noimg">👤</span>'}
                <div class="detail-staff-info">
                    <span class="detail-staff-jobs">${escHtml(jobs)}</span>
                    <span class="detail-staff-name">${escHtml(mainName)}</span>
                    ${subName ? `<span class="detail-staff-subname">${escHtml(subName)}</span>` : ''}
                </div>
            </div>`;
        }).join('')}</div>` : '<div class="tip-line">暂无制作人员信息</div>');
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
                <div class="detail-relation-poster">${img ? `<img src="${escHtml(img)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.closest('.detail-relation-poster').classList.add('noimg');this.remove()">` : '<span class="detail-relation-noimg">🎬</span>'}</div>
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
            this._characters = Array.isArray(cached.characters) ? cached.characters : [];
            this._staff = Array.isArray(cached.staff) ? cached.staff : [];
            this._relations = Array.isArray(cached.relations) ? cached.relations : [];
            this._bgmExtraLoaded = true;
            if (this._activeTab === '吐槽') this._renderComments();
            else if (this._activeTab === '角色') this._renderCharacters();
            else if (this._activeTab === '关联') this._renderRelations();
            else if (this._activeTab === '制作') this._renderStaff();
            return;
        }
        try {
            const [comments, chars, staff, relations] = await Promise.all([
                Kazumi.bangumiComments(this._bgmId, 100, 0).catch(() => []),
                Kazumi.bangumiCharacters(this._bgmId).catch(() => []),
                Kazumi.bangumiStaff(this._bgmId).catch(() => []),
                Kazumi.bangumiRelations(this._bgmId).catch(() => []),
            ]);
            // 关键修复：并发拉取期间若已导航到别的番剧（点关联卡片/返回），本轮结果作废，
            // 否则会把上一部/下一部的关联/角色数据写进当前状态并叠加渲染，出现多余卡片与闪烁。
            if (gen !== this._bgmExtraGen) return;
            this._comments = comments || [];
            this._commentOffset = this._comments.length;   // 已加载偏移，供下拉续拉
            this._commentAllLoaded = this._comments.length < 100;
            this._characters = chars || [];
            this._staff = staff || [];
            this._relations = relations || [];
            this._bgmExtraLoaded = true;
            // 落盘持久缓存（四类合并为一条；空 bundle 不缓存，交 _detailCacheSet 的空值守卫处理）
            if (this._comments.length || this._characters.length || this._staff.length || this._relations.length) {
                _detailCacheSet(DETAIL_BGMEXTRA_CACHE_PREFIX, cacheKey, {
                    comments: this._comments, characters: this._characters,
                    staff: this._staff, relations: this._relations,
                }, DETAIL_BGMEXTRA_TTL);
            }
            if (this._activeTab === '吐槽') this._renderComments();
            else if (this._activeTab === '角色') this._renderCharacters();
            else if (this._activeTab === '关联') this._renderRelations();
            else if (this._activeTab === '制作') this._renderStaff();
        } catch (e) { /* Bangumi 数据加载失败 */ }
    },

    /** 下拉续拉更多吐槽（无条数上限，滚到底部继续加载）。 */
    async _loadMoreComments() {
        if (this._commentAllLoaded || this._commentLoading || !this._bgmId || typeof Kazumi === 'undefined') return;
        this._commentLoading = true;
        const gen = this._bgmExtraGen; // M-30c：评论续拉世代守卫
        try {
            const more = await Kazumi.bangumiComments(this._bgmId, 100, this._commentOffset || 0).catch(() => []);
            if (gen !== this._bgmExtraGen) return; // 已切到其他番剧，旧评论丢弃
            if (more && more.length) {
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
        $('#detail-body .detail-col-btn').removeClass('active');
        $(`#detail-body .detail-col-btn[data-tag="${cur}"]`).addClass('active');
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
                const res = await window.yuki.download.control(isM3u8 ? 'addHls' : 'add', { uri: r.url, out, header: r.header });
                if (res && res.ok) added++;
                else if (res && res.reason === 'ffmpeg-downloading') ffmpegDownloading = true;
                else if (res && res.reason === 'ffmpeg-missing') ffmpegMissing = true;
                else failed++;
            } catch (e) { failed++; }
        }
        hideLoading();
        const bits = [];
        if (added) bits.push(`已加入下载 ${added} 集，可在“下载”页查看`);
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
