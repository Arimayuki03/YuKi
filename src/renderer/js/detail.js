/**
 * detail.js — 统一详情页（合并 CatVod 与 Bangumi 详情，仿 Kazumi InfoPage 设计）
 *
 * 布局：
 *  - 头部：封面 + 标题/元信息 + 收藏/标记按钮
 *  - 页签：概览 | 吐槽 | 角色 | 关联 | 制作人员
 *  - 概览：可收起简介 + 播放源/选集
 *  - 其他页签：Bangumi 数据（仅当匹配到 Bangumi 时显示）
 */
/* global $, doAction, escHtml, stripHtml, normalizePic, warnToast, showLoading, hideLoading, registerEsc, openDialog, closeDialog, App, Player, Records, abortCoverFill, Kazumi */

const DETAIL_TABS = ['概览', '吐槽', '角色', '关联', '制作人员'];

/** 详情内容缓存（T74）：site|vodId → {ts, vod}，10 分钟 TTL，重复打开详情免重新拉取。 */
const DETAIL_CACHE_TTL = 10 * 60 * 1000;
const _detailCache = new Map();

const Detail = {
    site: '',
    vodId: '',
    backView: 'home',
    sources: [],
    activeSource: 0,
    _epDesc: false,
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

    init() {
        if (this._escBound) return;
        this._escBound = true;
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
            .on('click', '#detail-fav', () => this.toggleFav())
            .on('click', '#detail-tag-want', () => this.setTag('want'))
            .on('click', '#detail-tag-seen', () => this.setTag('seen'))
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
                } else if (await Kazumi.setBangumiCollection(id, val)) {
                    Kazumi._applyBangumiColState(id);
                }
            })
            // 开始观看（Kazumi 源，Bangumi-only 详情）
            .on('click', '#detail-kazumi-start', () => {
                if (typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    Kazumi.openSourceDialog(this.vodName || '', 'kazumi', '');
                }
            })
            // 标签点击：跳搜索页按标签搜索
            .on('click', '.kazumi-tag', (e) => {
                const tag = String($(e.currentTarget).data('tag') || '');
                if (!tag || typeof App === 'undefined' || !App.showView) return;
                App.showView('search');
                if (typeof Search !== 'undefined' && Search.run) {
                    $('#search-keyword').val(tag);
                    Search.run();
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
        this.backView = App.currentView === 'detail' ? this.backView : App.currentView;
        this.site = site;
        this.vodId = vodId;
        this.vodName = fallbackName || '';
        this._bgmInfo = null;
        this._bgmId = null;
        this._comments = [];
        this._characters = [];
        this._staff = [];
        this._relations = [];
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
        this.backView = App.currentView === 'detail' ? this.backView : App.currentView;
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

    back() {
        App.showView(this.backView || 'home');
    },

    /** CatVod 详情页自动匹配 Bangumi 数据开关（T74：设置 → 源设置，默认关）。 */
    async _catvodBgmMatchEnabled() {
        try {
            const s = (await window.vpc.settingsGet()) || {};
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
            // T74：命中缓存直接复用，避免重复打开重复拉详情
            const cacheKey = String(this.site) + '|' + String(this.vodId);
            let vod = null;
            const hit = _detailCache.get(cacheKey);
            if (hit && Date.now() - hit.ts < DETAIL_CACHE_TTL) {
                vod = hit.vod;
            } else {
                const data = await doAction('detailContent', { site: this.site, ids: JSON.stringify([this.vodId]) });
                vod = (data && data.list && data.list[0]) || null;
                if (vod) {
                    _detailCache.set(cacheKey, { ts: Date.now(), vod });
                    if (_detailCache.size > 200) { // 防无限增长，淘汰最旧
                        const oldest = _detailCache.keys().next().value;
                        _detailCache.delete(oldest);
                    }
                }
            }
            if (!vod) { $('#detail-body').html('<div class="tip-line">未取得详情</div>'); return; }
            if (vod.vod_name) this.vodName = vod.vod_name;
            this._vod = vod;
            if (typeof Records !== 'undefined' && !window._incognito) {
                Records.addHistory({
                    site: this.site, vodId: this.vodId,
                    name: vod.vod_name || this.vodName, pic: vod.vod_pic, remarks: vod.vod_remarks,
                    siteName: this._siteName(this.site),
                });
            }
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
        return bits.map(escHtml).join(' · ');
    },

    render() {
        this._lastVod = this._vod || null;
        const vod = this._vod;
        const bgm = this._bgmInfo;
        const hasBgm = !!this._bgmId;
        const cover = bgm && bgm.images && (bgm.images.large || bgm.images.common || bgm.images.medium)
            ? (bgm.images.large || bgm.images.common || bgm.images.medium)
            : (vod && vod.vod_pic) || '';
        const name = bgm ? (bgm.name_cn || bgm.name || (vod && vod.vod_name) || this.vodName) : ((vod && vod.vod_name) || this.vodName);
        const meta = bgm
            ? [bgm.date, bgm.rating && bgm.rating.score ? `评分 ${bgm.rating.score}` : ''].filter(Boolean).join(' · ')
            : this.metaLine(vod || {});
        let html = `
        <div class="detail-head">
            <div class="detail-cover">${vodCoverImg(cover)}</div>
            <div class="detail-info">
                <div class="detail-title">${escHtml(name)}</div>
                <div class="detail-meta">${escHtml(meta)}</div>
                ${vod && vod.vod_director ? `<div class="detail-sub">导演：${escHtml(vod.vod_director)}</div>` : ''}
                ${vod && vod.vod_actor ? `<div class="detail-sub">演员：${escHtml(vod.vod_actor)}</div>` : ''}
                <div class="detail-actions">
                    ${vod ? `<button id="detail-fav" class="md-btn md-btn-tonal md-btn-sm">☆ 收藏</button>
                    <button id="detail-tag-want" class="md-btn md-btn-tonal md-btn-sm">想看</button>
                    <button id="detail-tag-seen" class="md-btn md-btn-tonal md-btn-sm">已看</button>` : ''}
                    ${hasBgm ? this._bangumiColHtml(bgm) : ''}
                </div>
            </div>
        </div>`;
        // 页签栏
        const tabs = DETAIL_TABS.map((t) => `<span class="detail-tab ${t === this._activeTab ? 'active' : ''}" data-tab="${t}">${t}</span>`).join('');
        html += `<div class="detail-tabs class-tabs">${tabs}</div>`;
        html += `<div id="detail-tab-content"></div>`;
        $('#detail-body').html(html);
        this._refreshFavBtn();
        this._refreshTagBtns();
        this._renderTabContent();
        // 后台加载 Bangumi 补充数据
        if (hasBgm) {
            this._loadBgmExtra();
            if (typeof Kazumi !== 'undefined' && Kazumi._applyBangumiColState) {
                Kazumi._applyBangumiColState(this._bgmId); // 高亮当前收藏状态
            }
        }
    },

    /** Bangumi 收藏按钮组 + 「开始观看」（统一详情页，T74）。 */
    _bangumiColHtml(bgm) {
        if (!bgm || !bgm.id) return '';
        const hasRules = typeof Kazumi !== 'undefined' && Kazumi.hasEnabledRules && Kazumi.hasEnabledRules();
        let h = `<div class="kazumi-bangumi-colrow">
            <span class="tip-line pad0">Bangumi 收藏（点击即同步）</span>
            <div class="kazumi-col-btns" data-id="${escHtml(bgm.id)}">
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="-1">未收藏</button>
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="1">想看</button>
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="3">在看</button>
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="2">看过</button>
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="4">搁置</button>
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="5">抛弃</button>
            </div>
        </div>`;
        if (hasRules) {
            h += `<div class="kazumi-watch-row" style="margin-top:10px;">
                <button id="detail-kazumi-start" class="md-btn md-btn-filled md-btn-sm">▶ 开始观看（Kazumi 源）</button>
                <span class="tip-line pad0">从 Kazumi 规则源搜索本片并选源播放</span>
            </div>`;
        }
        return h;
    },

    _renderTabContent() {
        const box = $('#detail-tab-content');
        if (this._activeTab === '概览') this._renderOverview();
        else if (this._activeTab === '吐槽') this._renderComments();
        else if (this._activeTab === '角色') this._renderCharacters();
        else if (this._activeTab === '关联') this._renderRelations();
        else if (this._activeTab === '制作人员') this._renderStaff();
    },

    _switchTab(tab) {
        if (tab === this._activeTab) return;
        this._activeTab = tab;
        $('#detail-body .detail-tab').removeClass('active');
        $(`#detail-body .detail-tab[data-tab="${tab}"]`).addClass('active');
        this._renderTabContent();
    },

    _renderOverview() {
        const vod = this._vod;
        const bgm = this._bgmInfo;
        let html = '';
        // 简介（可收起）
        const descText = bgm ? (bgm.summary || '') : stripHtml((vod && vod.vod_content) || '');
        if (descText) {
            const collapsed = this._descCollapsed && descText.length > 120;
            const shortText = collapsed ? escHtml(descText.slice(0, 120)) + '…' : escHtml(descText);
            html += `<div class="detail-desc-wrap">
                <div class="detail-desc-label">简介</div>
                <div class="detail-desc ${collapsed ? 'collapsed' : ''}">${shortText}</div>
                ${descText.length > 120 ? `<button id="detail-desc-toggle" class="md-btn md-btn-sm md-btn-tonal" style="margin-top:4px;font-size:12px;">${collapsed ? '展开全部' : '收起'}</button>` : ''}
            </div>`;
        }
        // Bangumi 标签
        if (bgm && Array.isArray(bgm.tags) && bgm.tags.length) {
            const chips = bgm.tags.slice(0, 13).map((t) => {
                const tn = (t && typeof t === 'object') ? (t.name || '') : t;
                return tn ? `<span class="kazumi-tag" data-tag="${escHtml(tn)}">${escHtml(tn)}</span>` : '';
            }).filter(Boolean).join('');
            if (chips) html += `<div class="bangumi-info-tags"><div class="kazumi-tags-wrap">${chips}</div></div>`;
        }
        if (!this.sources.length) {
            // Bangumi-only（无 CatVod 源）：开始观看 + Bangumi 分集
            if (bgm && this._bgmId) {
                html += `<div class="kazumi-watch-row" style="margin-top:12px;">
                    <button id="detail-kazumi-start" class="md-btn md-btn-filled md-btn-sm">▶ 开始观看（Kazumi 源）</button>
                    <span class="tip-line pad0">从 Kazumi 规则源搜索本片并选源播放</span>
                </div>`;
                html += '<div class="tip-line pad0" style="margin:14px 0 8px;">分集（点击从 Kazumi 规则源选源播放）</div>';
                html += '<div id="bgm-ep-list" class="ep-grid"></div>';
                $('#detail-tab-content').html(html);
                this._renderBgmEpisodes();
                return;
            }
            html += '<div class="tip-line" style="margin-top:12px;">该视频暂无播放源</div>';
            if (typeof Kazumi !== 'undefined' && Kazumi.hasEnabledRules && Kazumi.hasEnabledRules()) {
                html += `<div class="kazumi-entry tip-line" style="margin-top:12px;">
                    <span>没有想看的源？</span>
                    <button id="detail-kazumi-src" class="md-btn md-btn-tonal md-btn-sm">试试 Kazumi 规则源</button>
                </div>`;
            }
            $('#detail-tab-content').html(html);
            return;
        }
        // 播放源
        html += `<div class="play-srcs" style="margin-top:12px;">${this.sources.map((s, i) =>
            `<span class="play-src ${i === this.activeSource ? 'active' : ''}" data-idx="${i}">${escHtml(s.from)} (${s.episodes.length})</span>`).join('')}</div>`;
        if (typeof Kazumi !== 'undefined' && Kazumi.hasEnabledRules && Kazumi.hasEnabledRules()) {
            html += `<div class="kazumi-entry tip-line" style="margin-bottom:12px;">
                <span>没有想看的源？</span>
                <button id="detail-kazumi-src" class="md-btn md-btn-tonal md-btn-sm">试试 Kazumi 规则源</button>
            </div>`;
        }
        html += `<div class="ep-dl-bar">
            <label class="ep-dl-check-all"><input type="checkbox" id="ep-check-all">全选</label>
            <span class="dl-spacer"></span>
            <span class="ep-dl-count" id="ep-dl-count"></span>
            <button id="ep-order" class="md-btn md-btn-tonal md-btn-sm"></button>
            <button id="ep-play-selected" class="md-btn md-btn-tonal md-btn-sm">▶ 播放勾选集</button>
            <button id="ep-dl-selected" class="md-btn md-btn-tonal md-btn-sm">⬇ 下载勾选集</button>
        </div>`;
        html += `<div class="ep-toolbar"><span class="ep-count" id="ep-count"></span></div>`;
        html += '<div id="ep-list" class="ep-grid"></div>';
        $('#detail-tab-content').html(html);
        this.renderEpisodes();
    },

    /** 渲染 Bangumi 分集（统一详情页 Bangumi-only 概览用，T74）：点击从 Kazumi 源选源播放。 */
    async _renderBgmEpisodes() {
        const box = $('#bgm-ep-list');
        if (!box.length || !this._bgmId || typeof Kazumi === 'undefined') return;
        box.html('<div class="tip-line">载入中…</div>');
        try {
            const data = await Kazumi.bangumiEpisodes(this._bgmId);
            const list = (data && data.data) || [];
            box.html(list.length
                ? list.map((ep) => `<div class="kazumi-detail-ep" tabindex="0">
                    <span class="kazumi-detail-ep-no">${escHtml(ep.sort || ep.ep || '')}</span>
                    <span class="kazumi-detail-ep-name">${escHtml(ep.name_cn || ep.name || '')}</span>
                    <span class="kazumi-detail-ep-type">${escHtml(ep.type === 1 ? 'SP' : ep.type === 2 ? 'OP' : ep.type === 3 ? 'ED' : '')}</span>
                </div>`).join('')
                : '<div class="tip-line">暂无分集信息</div>');
            box.find('.kazumi-detail-ep').on('click', () => {
                const title = this.vodName || '';
                if (title && typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) {
                    Kazumi.openSourceDialog(title, 'kazumi', '');
                }
            });
        } catch (e) {
            box.html('<div class="tip-line">分集载入失败</div>');
        }
    },

    _renderComments() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (!this._comments.length) { box.html('<div class="tip-line">加载中…</div>'); return; }
        box.html(this._comments.map((c) => `<div class="detail-comment">
            <div class="detail-comment-user">${escHtml((c.user && c.user.nickname) || c.username || '')}</div>
            <div class="detail-comment-text">${escHtml(c.comment || '')}</div>
            <div class="detail-comment-time">${escHtml(c.updated_at || '')}</div>
        </div>`).join('') || '<div class="tip-line">暂无吐槽</div>');
    },

    _renderCharacters() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (!this._characters.length) { box.html('<div class="tip-line">加载中…</div>'); return; }
        box.html(this._characters.map((c) => `<div class="detail-char">
            <img class="detail-char-avatar" src="${escHtml((c.images && c.images.medium) || '')}" referrerpolicy="no-referrer" onerror="this.style.display='none'">
            <div class="detail-char-info">
                <div class="detail-char-name">${escHtml(c.name || '')}</div>
                <div class="detail-char-role">${escHtml(c.relation || '')}</div>
            </div>
        </div>`).join('') || '<div class="tip-line">暂无角色信息</div>');
    },

    _renderStaff() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (!this._staff.length) { box.html('<div class="tip-line">加载中…</div>'); return; }
        box.html(this._staff.map((s) => `<div class="detail-staff">
            <span class="detail-staff-name">${escHtml(s.name || '')}</span>
            <span class="detail-staff-jobs">${escHtml((s.jobs || []).join(' / '))}</span>
        </div>`).join('') || '<div class="tip-line">暂无制作人员信息</div>');
    },

    _renderRelations() {
        const box = $('#detail-tab-content');
        if (!this._bgmId) { box.html('<div class="tip-line">未匹配到 Bangumi 数据</div>'); return; }
        if (!this._relations.length) { box.html('<div class="tip-line">加载中…</div>'); return; }
        box.html(this._relations.map((r) => `<div class="detail-relation">
            <span class="detail-relation-type">${escHtml(r.relation || '')}</span>
            <span class="detail-relation-name">${escHtml(r.name_cn || r.name || '')}</span>
        </div>`).join('') || '<div class="tip-line">暂无关联番剧</div>');
    },

    async _loadBgmExtra() {
        if (!this._bgmId || typeof Kazumi === 'undefined') return;
        try {
            const [comments, chars, staff, relations] = await Promise.all([
                Kazumi.bangumiComments(this._bgmId, 20, 0).catch(() => []),
                Kazumi.bangumiCharacters(this._bgmId).catch(() => []),
                Kazumi.bangumiStaff(this._bgmId).catch(() => []),
                Kazumi.bangumiRelations(this._bgmId).catch(() => []),
            ]);
            this._comments = comments || [];
            this._characters = chars || [];
            this._staff = staff || [];
            this._relations = relations || [];
            if (this._activeTab === '吐槽') this._renderComments();
            else if (this._activeTab === '角色') this._renderCharacters();
            else if (this._activeTab === '关联') this._renderRelations();
            else if (this._activeTab === '制作人员') this._renderStaff();
        } catch (e) { /* Bangumi 数据加载失败 */ }
    },

    _siteName(key) {
        try {
            const all = (typeof Home !== 'undefined' && Home._allSites) || [];
            const s = all.find((x) => x.key === key);
            return (s && s.name) || key;
        } catch (e) { return key; }
    },

    async _refreshFavBtn() {
        if (typeof Records === 'undefined') return;
        const fav = await Records.isFavorite(this.site, this.vodId);
        $('#detail-fav').text(fav ? '★ 已收藏（点击取消）' : '☆ 收藏');
    },

    async _refreshTagBtns() {
        if (typeof Records === 'undefined') return;
        const tag = await Records.getFavTag(this.site, this.vodId);
        $('#detail-tag-want').toggleClass('tag-active', tag === 'want');
        $('#detail-tag-seen').toggleClass('tag-active', tag === 'seen');
    },

    async setTag(tag) {
        if (typeof Records === 'undefined') return;
        const vod = this._lastVod;
        if (!vod) return;
        const cur = await Records.getFavTag(this.site, this.vodId);
        const next = (cur === tag) ? '' : tag;
        await Records.setFavTag({
            site: this.site, vodId: this.vodId,
            name: this._bgmInfo ? (this._bgmInfo.name_cn || this._bgmInfo.name || vod.vod_name || this.vodName) : (vod.vod_name || this.vodName),
            pic: this._bgmInfo && this._bgmInfo.images ? (this._bgmInfo.images.large || this._bgmInfo.images.common || this._bgmInfo.images.medium || vod.vod_pic) : (vod.vod_pic || ''),
            remarks: vod.vod_remarks || '',
            siteName: this._siteName(this.site),
        }, next);
        if (next === '') warnToast('已取消想看/已看标记');
        else warnToast(next === 'seen' ? '已标记为已看（并加入收藏）' : '已标记为想看（并加入收藏）');
        this._refreshFavBtn();
        this._refreshTagBtns();
    },

    async toggleFav() {
        const vod = this._lastVod;
        if (!vod || typeof Records === 'undefined') return;
        const added = await Records.toggleFavorite({
            site: this.site, vodId: this.vodId,
            name: this._bgmInfo ? (this._bgmInfo.name_cn || this._bgmInfo.name || vod.vod_name || this.vodName) : (vod.vod_name || this.vodName),
            pic: this._bgmInfo && this._bgmInfo.images ? (this._bgmInfo.images.large || this._bgmInfo.images.common || this._bgmInfo.images.medium || vod.vod_pic) : (vod.vod_pic || ''),
            remarks: vod.vod_remarks || '',
            siteName: this._siteName(this.site),
        });
        warnToast(added ? '已收藏，可在“我的 → 我的收藏”查看' : '已取消收藏');
        this._refreshFavBtn();
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
            const s = (await window.vpc.settingsGet()) || {};
            const map = (s.lastSourceMap && typeof s.lastSourceMap === 'object') ? s.lastSourceMap : {};
            map[`${this.site}|${this.vodId}`] = this.activeSource;
            await window.vpc.settingsSet('lastSourceMap', map);
        } catch (e) { /* 保存失败不影响主流程 */ }
    },

    async _restoreLastSource() {
        if (!this.site || !this.vodId) return;
        try {
            const s = (await window.vpc.settingsGet()) || {};
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
        const startSrc = this.activeSource;
        let tried = 0;
        while (tried < this.sources.length) {
            const curSrc = this.sources[this.activeSource];
            const curEp = curSrc.episodes[idx];
            if (!curEp) { this._advanceSource(); tried++; continue; }
            if (tried > 0) {
                warnToast(`线路「${curSrc.from}」尝试中…`);
                $('#detail-tab-content .play-src').removeClass('active');
                $(`#detail-tab-content .play-src[data-idx="${this.activeSource}"]`).addClass('active');
                this.renderEpisodes();
                this._saveLastSource();
            }
            const result = await Player.play(
                this.site, curSrc.from, curEp.url,
                this.vodName || '', curEp.name,
                curSrc.episodes, idx,
            );
            if (result && result.ok) return;
            if (result && result.reason === 'mpv-missing') return;
            this._advanceSource();
            tried++;
        }
        warnToast(`全部 ${this.sources.length} 条线路均播放失败`);
        if (this.activeSource !== startSrc) this.selectSource(startSrc);
    },

    _advanceSource() {
        if (this.sources.length <= 1) return;
        this.activeSource = (this.activeSource + 1) % this.sources.length;
    },

    toggleEpOrder() {
        this._epDesc = !this._epDesc;
        this.renderEpisodes();
    },

    renderEpisodes() {
        const src = this.sources[this.activeSource];
        const box = $('#ep-list').empty();
        if (!src) return;
        $('#ep-count').text(`共 ${src.episodes.length} 集`);
        $('#ep-order').text(this._epDesc ? '⇅ 切正序' : '⇅ 切倒序');
        const order = src.episodes.map((_, i) => i);
        if (this._epDesc) order.reverse();
        order.forEach((i) => {
            const ep = src.episodes[i];
            box.append(`<button class="ep-btn" data-idx="${i}" title="${escHtml(ep.url)}">` +
                `<span class="ep-check" data-idx="${i}" title="勾选后可批量播放/下载"></span>` +
                `<span class="ep-name">${escHtml(ep.name)}</span>` +
                `<span class="ep-dl-one" data-idx="${i}" title="下载本集">⬇</span></button>`);
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
        const firstIdx = idxs[0];
        const startSrc = this.activeSource;
        let tried = 0;
        let ok = false;
        while (tried < this.sources.length) {
            const curSrc = this.sources[this.activeSource];
            const curEp = curSrc.episodes[firstIdx];
            if (!curEp) { this._advanceSource(); tried++; continue; }
            if (tried > 0) {
                warnToast(`线路「${curSrc.from}」尝试中…`);
                $('#detail-tab-content .play-src').removeClass('active');
                $(`#detail-tab-content .play-src[data-idx="${this.activeSource}"]`).addClass('active');
                this.renderEpisodes();
                this._saveLastSource();
            }
            const eps = idxs.map((i) => curSrc.episodes[i]).filter(Boolean);
            if (!eps.length) { this._advanceSource(); tried++; continue; }
            const first = eps[0];
            let autoNext = true;
            try { autoNext = ((await window.vpc.settingsGet()) || {}).autoNext !== false; } catch (e) { /* 读失败默认连播 */ }
            if (eps.length > 1) {
                warnToast(autoNext ? `已加入播放列表 ${eps.length} 集，将自动连播` : '自动连播已关闭，仅播放勾选的第一集');
            }
            const result = await Player.play(this.site, curSrc.from, first.url, this.vodName || '', first.name, eps, 0);
            if (result && result.ok) { ok = true; break; }
            if (result && result.reason === 'mpv-missing') break;
            this._advanceSource();
            tried++;
        }
        if (!ok && this.activeSource !== startSrc) this.selectSource(startSrc);
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
            const ext = isM3u8 ? '.mp4' : (r.url.split('?')[0].match(/\.(mp4|flv|mov|mkv|webm|avi|ts)$/i) || [''])[0];
            const out = `${this.vodName || '视频'} - ${ep.name}${ext}`;
            try {
                const res = await window.vpc.download.control(isM3u8 ? 'addHls' : 'add', { uri: r.url, out, header: r.header });
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
            const rsp = await doAction('playerContent', {
                site: this.site, flag, id: url, vipFlags: JSON.stringify([]),
            });
            const data = (rsp && typeof rsp === 'object') ? rsp : {};
            const u = data.url || url;
            if (parseInt(data.parse, 10) !== 1) return { url: u };
            if (/\.(mp4|flv|mov|mkv|webm|ts|m3u8)(\?|#|$)/i.test(u.split('?')[0])) return { url: u };
            const r = await window.vpc.resolveParse(u);
            if (r && r.ok) return { url: r.url, header: r.header };
        } catch (e) { /* 单集失败不阻断批量 */ }
        return null;
    },
};