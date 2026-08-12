/**
 * records.js — 收藏与播放历史
 *
 * 数据存 settings（favorites / history），条目 {site, siteName, vodId, name, pic, remarks, ts}，
 * 最新在前，上限 200 条。详情页打开时自动记入历史；收藏在详情页手动切换。
 * 两个视图共用网格渲染（recCard），卡片 ✕ 可单条移除；历史页保留一键清空（T40 起收藏页无清空）。
 * 两页均支持搜索（片名/备注/源）；收藏额外带「想看/已看」标签（tag：want/seen，默认 want）。
 */
/* global $, escHtml, normalizePic, warnToast, Detail, renderPagerBox, pageSizeOf, fitVodTitles */

async function recGet(key) {
    try {
        const s = (await window.vpc.settingsGet()) || {};
        const list = Array.isArray(s[key]) ? s[key] : [];
        // 迁移：历史/收藏记录缺 uid 时按 ts 回填并持久化，保证后续按 uid 匹配稳定
        if ((key === 'history' || key === 'favorites') && ensureRecUids(list)) {
            try { await window.vpc.settingsSet(key, list); } catch (e) { /* 迁移写盘失败不影响读取 */ }
        }
        return list;
    } catch (e) { return []; }
}

async function recSet(key, list) {
    try { await window.vpc.settingsSet(key, list); } catch (e) { /* 保存失败不影响主流程 */ }
}

// 记录唯一标识：site+vodId 对历史不唯一（同源多集、Kazumi 源 vodId 恒为空），
// 增删改一律按 uid 匹配。创建记录时生成，旧数据按 ts 回填（见 ensureRecUids）。
let _uidSeq = 0;
function genUid() {
    return `r${Date.now().toString(36)}-${(_uidSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 迁移：为缺 uid 的旧记录按 ts + 下标回填稳定 uid；有回填返回 true（调用方需持久化）。 */
function ensureRecUids(list) {
    let changed = false;
    list.forEach((it, i) => {
        if (it && !it.uid) { it.uid = `m${it.ts || 0}-${i}`; changed = true; }
    });
    return changed;
}

const Records = {
    /** 详情页打开时记入历史（按片名去重合并：同名影片只保留一条，新来源信息覆盖旧条目后置顶）。
     *  保留已有播放统计（playCount/lastPlayTs/lastEpisode/lastDuration），详情页打开不重置。
     *  隐身模式（设置页开关）下不记录。 */
    async addHistory(v) {
        if (!v || !v.name) return;
        let list = await recGet('history');
        const key = String(v.name || '').trim();
        if (!key) return;
        // 按片名去重（不区分大小写，合并跨源重复条目）
        const idx = list.findIndex((x) => {
            const xn = String(x.name || '').trim();
            return xn && xn.toLowerCase() === key.toLowerCase();
        });
        if (idx >= 0) {
            // 同名条目：更新来源信息为最新打开的那个，时间戳刷新并置顶；保留播放统计。
            // 跨引擎（CatVod / Kazumi）同名影片来源语义不同，须整体采用来访记录的引擎身份，
            // 不能用 `v.site || old.site` 逐字段回退——否则空 vodId / 空 kazumiSrc 会串入旧源信息。
            const old = list.splice(idx, 1)[0];
            list.unshift({
                uid: old.uid || genUid(),
                site: v.site !== undefined ? v.site : old.site,
                siteName: v.siteName !== undefined ? v.siteName : old.siteName,
                vodId: v.vodId !== undefined ? v.vodId : old.vodId,
                kazumiSrc: v.kazumiSrc !== undefined ? v.kazumiSrc : old.kazumiSrc,
                name: old.name,   // 保留原标题（显示名不变）
                pic: v.pic || old.pic,
                remarks: v.remarks || old.remarks,
                ts: Date.now(),
                kind: old.kind || 'view',   // 播放卡（play）被再次打开时保留播放身份
                playCount: old.playCount,
                lastPlayTs: old.lastPlayTs,
                lastEpisode: old.lastEpisode,
                lastDuration: old.lastDuration,
            });
        } else {
            list.unshift({ uid: genUid(), site: v.site, siteName: v.siteName || '', vodId: v.vodId, kazumiSrc: v.kazumiSrc || '', name: v.name || '', pic: v.pic || '', remarks: v.remarks || '', ts: Date.now(), kind: 'view' });
        }
        if (list.length > 200) list = list.slice(0, 200);
        await recSet('history', list);
    },

    /** 播放记录：每次真实播放新增一条独立历史（T73，不再累加「已播几集」）。
     *  先清掉同片名的「浏览」卡（详情页打开产生的 view 记录），避免「开→播」产生双卡；
     *  同片名多集各自成卡（播放日志），卡片显示 集名 · 时长 · 播放时间。
     *  player.js _writeWatch 在 mpv 退出时调用。 */
    async recordPlay(v) {
        if (!v || !v.name) return;
        let list = await recGet('history');
        const now = Date.now();
        const entry = {
            uid: genUid(),
            site: String(v.site || ''), siteName: v.siteName || '', vodId: String(v.vodId || ''),
            kazumiSrc: v.kazumiSrc || '',
            name: v.name, pic: v.pic || '', remarks: v.remarks || '',
            ts: now, kind: 'play',
            playCount: 1, lastPlayTs: now,
            lastEpisode: v.episode || '', lastDuration: Math.round(v.seconds || 0),
        };
        const key = String(v.name || '').trim().toLowerCase();
        list = list.filter((x) => String(x.name || '').trim().toLowerCase() !== key || x.kind === 'play');
        list.unshift(entry);
        if (list.length > 200) list = list.slice(0, 200);
        await recSet('history', list);
    },

    async isFavorite(site, vodId) {
        const list = await recGet('favorites');
        return list.some((x) => String(x.site) === String(site) && String(x.vodId) === String(vodId));
    },

    /** 切换收藏状态，返回 true=已收藏。第三方源收藏时自动匹配 Bangumi 元数据。 */
    async toggleFavorite(v) {
        let list = await recGet('favorites');
        const idx = list.findIndex((x) => String(x.site) === String(v.site) && String(x.vodId) === String(v.vodId));
        let added = false;
        if (idx >= 0) {
            list.splice(idx, 1);
        } else {
            let entry = { uid: genUid(), site: v.site, siteName: v.siteName || '', vodId: v.vodId, name: v.name || '', pic: v.pic || '', remarks: v.remarks || '', tag: 'want', ts: Date.now() };
            // 第三方源尝试匹配 Bangumi 元数据
            if (v.name && typeof Kazumi !== 'undefined' && Kazumi.bangumiSearch) {
                try {
                    const bgmResults = await Kazumi.bangumiSearch(v.name);
                    if (bgmResults && bgmResults.length && bgmResults[0].id) {
                        const info = await Kazumi.bangumiInfo(bgmResults[0].id);
                        if (info) {
                            const cover = (info.images && (info.images.large || info.images.common || info.images.medium)) || '';
                            entry.pic = cover || entry.pic;
                            entry.name = info.name_cn || info.name || entry.name;
                            entry.bangumiId = String(info.id || '');
                            entry.siteName = 'Bangumi · ' + (entry.siteName || '');
                        }
                    }
                } catch (e) { /* Bangumi 匹配失败不影响收藏 */ }
            }
            list.unshift(entry);
            added = true;
            if (list.length > 200) list = list.slice(0, 200);
        }
        await recSet('favorites', list);
        return added;
    },

    /** 查询收藏标签：未收藏返回 ''；已收藏无标签视同 want；显式取消过标签（''）返回 ''。 */
    async getFavTag(site, vodId) {
        const list = await recGet('favorites');
        const it = list.find((x) => String(x.site) === String(site) && String(x.vodId) === String(vodId));
        if (!it) return '';
        return (it.tag === undefined || it.tag === null) ? 'want' : it.tag;
    },

    /** 设置收藏标签（want/seen）：未收藏则先加入收藏再置标签。 */
    async setFavTag(v, tag) {
        let list = await recGet('favorites');
        let it = list.find((x) => String(x.site) === String(v.site) && String(x.vodId) === String(v.vodId));
        if (!it) {
            it = { uid: genUid(), site: v.site, siteName: v.siteName || '', vodId: v.vodId, name: v.name || '', pic: v.pic || '', remarks: v.remarks || '', tag, ts: Date.now() };
            list.unshift(it);
            if (list.length > 200) list = list.slice(0, 200);
        } else {
            it.tag = tag;
        }
        await recSet('favorites', list);
    },
};

/** 归一化标签：旧数据无 tag 视同 want；显式取消（''）保持无标签。 */
function normTag(t) { return (t === undefined || t === null) ? 'want' : t; }

// 收藏状态标签：''=无/未标记，want=想看，watching=在看，seen=已看(看过)，hold=搁置，dropped=抛弃。
// 与 Bangumi 收藏类型 1想看/2看过/3在看/4搁置/5抛弃 对应（见 my.js 合并逻辑）。
const TAG_LABEL = { want: '想看', watching: '在看', seen: '已看', hold: '搁置', dropped: '抛弃' };
const TAG_ORDER = ['want', 'watching', 'seen', 'hold', 'dropped']; // 标签循环切换顺序（→ 循环回 ''）

/** 标签 → 展示文案（未知标签回退「想看」）。 */
function tagLabel(t) { return TAG_LABEL[t] || '想看'; }

/** 秒数 → 可读时长（"X 分钟" / "X 小时 Y 分"）。 */
function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (h > 0) return `${h} 小时 ${m} 分`;
    if (m > 0) return `${m} 分钟`;
    return `${sec} 秒`;
}

/** 时间戳 → 本地时间串（YYYY-MM-DD HH:mm）。 */
function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 收藏/历史共用卡片（带 site 标识、移除/编辑按钮与多选勾选框；editable 时附编辑按钮；withTags 时封面左上角加状态标签）。
 *  历史卡按次记录（T73）：每次播放一条，显示 集名 · 时长 · 播放时间，不再显示「已播 N 集」。
 *  Kazumi 源历史卡无源封面：复用 Bangumi 封面缓存，未命中占位图标 data-cover-missing 供 fillMissingCovers 补拉。
 *  Bangumi 条目（v.bangumi）：无移除/编辑/勾选按钮，来源徽标显示「Bangumi」，点击进 Bangumi 二级详情页。 */
function recCard(v, editable, withTags) {
    const isBgm = !!v.bangumi;
    const tag = isBgm ? (v.tag || '') : normTag(v.tag);
    const progress = v.progress;
    const progressHtml = progress && progress.totalEps
        ? `<div class="rec-progress" title="观至第 ${progress.currentEp} 集 / 共 ${progress.totalEps} 集">
             <div class="rec-progress-bar" style="width:${Math.min(100, Math.round(progress.percent || 0))}%"></div>
           </div>`
        : '';
    // 封面：Kazumi 源历史卡无源封面，先复用 Bangumi 封面缓存（T73 补拉成功的结果）
    let pic = v.pic || '';
    if (!pic && String(v.site || '').startsWith('kazumi:') && typeof Kazumi !== 'undefined' && Kazumi.getCachedBangumiCover) {
        pic = Kazumi.getCachedBangumiCover(v.name) || '';
    }
    // 历史卡播放信息（T73）：播放卡显示 集名 · 时长 · 播放时间；浏览卡只显示打开时间
    const isPlay = v.kind === 'play' || (v.playCount || 0) > 0;
    const playInfo = isPlay
        ? `<div class="rec-playinfo" title="${fmtTime(v.ts)}${v.lastDuration ? ' 播放时长 ' + fmtDur(v.lastDuration) : ''}">${[v.lastEpisode ? escHtml(String(v.lastEpisode).slice(0, 14)) : '', v.lastDuration ? fmtDur(v.lastDuration) : '', fmtTime(v.ts)].filter(Boolean).join(' · ')}</div>`
        : (v.ts ? `<div class="rec-playinfo" title="${fmtTime(v.ts)}">${fmtTime(v.ts)}</div>` : '');
    const uid = escHtml(v.uid || '');
    const check = isBgm ? '' : `<span class="rec-check" data-uid="${uid}" data-site="${escHtml(v.site)}" data-id="${escHtml(v.vodId)}" title="勾选后可批量删除"></span>`;
    const tagBadge = withTags && tag
        ? (isBgm
            ? `<span class="rec-tag rec-tag-static" data-site="bangumi" title="Bangumi 收藏状态（在详情页修改）">${tagLabel(tag)}</span>`
            : `<span class="rec-tag ${tag === 'seen' ? 'seen' : ''}" data-uid="${uid}" data-site="${escHtml(v.site)}" data-id="${escHtml(v.vodId)}" title="点击循环切换：想看→在看→已看→搁置→抛弃→取消">${tagLabel(tag)}</span>`)
        : '';
    const del = isBgm ? '' : `<button class="rec-del" data-uid="${uid}" data-site="${escHtml(v.site)}" data-id="${escHtml(v.vodId)}" title="移除">✕</button>`;
    const edit = (editable && !isBgm) ? `<button class="rec-edit" data-uid="${uid}" data-site="${escHtml(v.site)}" data-id="${escHtml(v.vodId)}" title="编辑标题">✎</button>` : '';
    const srcBadge = isBgm
        ? `<span class="rec-site" title="Bangumi 收藏">Bangumi</span>`
        : (v.siteName ? `<span class="rec-site" title="来源：${escHtml(v.siteName)}">源：${escHtml(v.siteName)}</span>` : '');
    return `<div class="vod-card" data-uid="${uid}" data-site="${escHtml(isBgm ? 'bangumi' : v.site)}" data-source="${escHtml(v.site)}" data-id="${escHtml(v.vodId)}" data-kazumi-src="${escHtml(v.kazumiSrc || '')}" data-name="${escHtml(v.name)}" tabindex="0">
        ${check}
        ${tagBadge}
        ${del}
        ${edit}
        <div class="vod-cover">${vodCoverImg(pic)}${srcBadge}</div>
        <div class="vod-name" title="${escHtml(v.name)}">${escHtml(truncateTitle(v.name))}</div>
        <div class="vod-remarks">${escHtml(v.remarks || '')}</div>
        ${playInfo}
        ${progressHtml}
    </div>`;
}

// ---- 编辑记录（改显示标题）：两视图共用一个对话框 ----
let _editCtx = null;

function openRecEdit(storeKey, uid, name, renderFn) {
    _editCtx = { storeKey, uid, renderFn };
    $('#edit_rec_name').val(name || '');
    openDialog('editRecDialog');
}

function cancelRecEdit() {
    _editCtx = null;
    closeDialog('editRecDialog');
}

async function confirmRecEdit() {
    const ctx = _editCtx;
    cancelRecEdit();
    if (!ctx) return;
    const name = $('#edit_rec_name').val().trim();
    if (!name) { warnToast('标题不能为空'); return; }
    const list = await recGet(ctx.storeKey);
    const it = list.find((x) => String(x.uid) === ctx.uid);
    if (!it) { warnToast('记录不存在，可能已被删除'); return; }
    it.name = name;
    await recSet(ctx.storeKey, list);
    if (ctx.renderFn) await ctx.renderFn();
    warnToast('已保存');
}

/** 视图工厂：收藏与历史结构一致，仅存储键与空态文案不同；editable 开启卡片编辑按钮；withTags 开启想看/已看标签（仅收藏）；pageSizeKey 为各自的每页条数设置键（T39）。多选（T40）：收藏支持批量删除/标记想看/标记已看且保留全选；历史仅批量删除且无全选；清空按钮仅历史保留。containerSel 覆盖事件委托根（默认 #${viewName}，供「我的」页内嵌面板复用）。 */
function makeRecordView(viewName, storeKey, emptyTip, editable, withTags, pageSizeKey, containerSel) {
    const root = containerSel || `#${viewName}`;
    return {
        _inited: false,
        _selectMode: false, // 多选删除模式：卡片点击改为切换勾选
        _q: '',   // 搜索关键字（片名/备注/源，不区分大小写）
        _tag: '', // 标签筛选（want/watching/seen/hold/dropped，空=全部；仅 withTags 视图生效）
        _page: 1, // 客户端分页当前页（T6：超过每页条数时分页展示）
        _extra: null, // 可选异步扩展数据源（如 Bangumi 收藏），返回 [{site,name,pic,remarks,tag,bangumi,...}] 追加渲染

        init() {
            if (this._inited) return;
            this._inited = true;
            $(root)
                .on('click', '.rec-del', (e) => {
                    e.stopPropagation();
                    const el = $(e.currentTarget);
                    this.remove(String(el.data('uid')));
                })
                .on('click', '.rec-edit', (e) => {
                    e.stopPropagation();
                    const el = $(e.currentTarget);
                    this.edit(String(el.data('uid')));
                })
                // 多选勾选框：阻止冒泡避免与卡片点击重复切换
                .on('click', '.rec-check', (e) => {
                    e.stopPropagation();
                    const card = $(e.currentTarget).closest('.vod-card');
                    $(e.currentTarget).toggleClass('checked');
                    card.toggleClass('sel', $(e.currentTarget).hasClass('checked'));
                    this._syncSelBar();
                })
                .on('click', '.vod-card', (e) => {
                    const el = $(e.currentTarget);
                    // 选择模式下点卡片 = 切换勾选，不打开详情
                    if (this._selectMode) {
                        const chk = el.find('.rec-check');
                        chk.toggleClass('checked');
                        el.toggleClass('sel', chk.hasClass('checked'));
                        this._syncSelBar();
                        return;
                    }
                    // Bangumi 收藏条目点击进 Bangumi 二级详情页（非 CatVod 详情）
                    if (String(el.data('site')) === 'bangumi') {
                        const id = String(el.data('id') || '');
                        if (id && typeof Kazumi !== 'undefined' && Kazumi.openBangumiInfoPage) Kazumi.openBangumiInfoPage(id);
                        return;
                    }
                    // Kazumi 源记录：走规则引擎选源弹窗（对齐 search.js），需番剧源页 URL（kazumiSrc）
                    const source = String(el.data('source') || el.data('site') || '');
                    if (source.startsWith('kazumi:')) {
                        const name = String(el.data('name') || '');
                        const srcUrl = String(el.data('kazumi-src') || '');
                        if (typeof Kazumi !== 'undefined' && Kazumi.openSourceDialog) Kazumi.openSourceDialog(name, source, srcUrl);
                        else warnToast('Kazumi 引擎不可用');
                        return;
                    }
                    Detail.open(String(el.data('site')), String(el.data('id')), String(el.data('name')));
                });
            // 清空按钮仅历史页保留（T40：收藏页已删除该按钮）
            if ($(`#${viewName}-clear`).length) $(`#${viewName}-clear`).on('click', () => this.clear());
            // 多选工具栏：进入/退出选择模式；全选仅收藏页（T40：历史页已移除全选）
            $(`#${viewName}-multidel`).on('click', () => this.toggleSelectMode());
            if (withTags) {
                $(`#${viewName}-checkall`).on('change', (e) => {
                    $(`#${viewName}-grid .rec-check`).toggleClass('checked', e.currentTarget.checked);
                    $(`#${viewName}-grid .vod-card`).toggleClass('sel', e.currentTarget.checked);
                    this._syncSelBar();
                });
                // 批量标记状态（T40：想看/已看；2.2 扩展：在看/搁置/抛弃）
                $(`#${viewName}-tagwant`).on('click', () => this.tagChecked('want'));
                $(`#${viewName}-tagseen`).on('click', () => this.tagChecked('seen'));
                $(`#${viewName}-tagwatching`).on('click', () => this.tagChecked('watching'));
                $(`#${viewName}-taghold`).on('click', () => this.tagChecked('hold'));
                $(`#${viewName}-tagdropped`).on('click', () => this.tagChecked('dropped'));
            }
            $(`#${viewName}-delchecked`).on('click', () => this.removeChecked());
            // 搜索框：实时过滤当前列表（片名/备注/源名模糊匹配）；过滤条件变化回第一页
            $(`#${viewName}-search`).on('input', (e) => {
                this._q = String(e.currentTarget.value || '').trim().toLowerCase();
                this._page = 1;
                this.render();
            });
            if (withTags) {
                // 标签筛选：全部/想看/已看
                $(`#${viewName}-tags`).on('click', '.class-tab', (e) => {
                    const el = $(e.currentTarget);
                    $(`#${viewName}-tags .class-tab`).removeClass('active');
                    el.addClass('active');
                    this._tag = String(el.data('tag') || '');
                    this._page = 1;
                    this.render();
                });
                // 卡片标签点击：循环切换状态；Bangumi 条目标签只读（rec-tag-static）不切换。
                // 委托根用 root（containerSel），「我的→收藏」的 #my-favorites 元素不存在，
                // 面板实为 #my-panel-favorites；用 root 才能让收藏页标签点击生效。
                $(root).on('click', '.rec-tag', (e) => {
                    e.stopPropagation();
                    const el = $(e.currentTarget);
                    if (el.hasClass('rec-tag-static')) return;
                    this.toggleTag(String(el.data('uid')));
                });
            }
        },

        /** 视图切入时渲染最新列表。 */
        async enter() {
            this.init();
            await this.render();
        },

        async render() {
            let list = await recGet(storeKey);
            // 合并外部条目（Bangumi 收藏）：追加到本地收藏后，统一参与搜索/标签/分页
            if (this._extra) {
                try {
                    const extra = await this._extra();
                    if (Array.isArray(extra) && extra.length) list = list.concat(extra);
                } catch (e) { /* 合并失败不影响本地列表 */ }
            }
            // 搜索 + 标签过滤（不改存储顺序）
            if (this._q) list = list.filter((v) => `${v.name || ''}${v.remarks || ''}${v.siteName || ''}`.toLowerCase().includes(this._q));
            if (withTags && this._tag) list = list.filter((v) => normTag(v.tag) === this._tag);
            const grid = $(`#${viewName}-grid`).empty();
            grid.toggleClass('selecting', this._selectMode);
            if (!list.length) {
                if (this._selectMode) this.toggleSelectMode(); // 列表空时退出选择模式
                $(`#${viewName}-pager`).empty();
                grid.html(`<div class="tip-line">${(this._q || this._tag) ? '没有匹配的记录' : emptyTip}</div>`);
                return;
            }
            // 客户端分页（T39）：每页条数取本页单独设置（收藏/历史各自一项，默认 20），超过即出底部分页器
            const size = await pageSizeOf(pageSizeKey);
            const pagecount = Math.ceil(list.length / size);
            this._page = Math.min(Math.max(1, this._page), pagecount);
            const slice = list.slice((this._page - 1) * size, this._page * size);
            // T65：拼串一次性写入，替代逐条 append（减少 DOM 重排）
            grid.html(slice.map((v) => recCard(v, editable, withTags)).join(''));
            // T74 收尾：按当前列宽把标题 JS 截到恰好两行（DOM 不保留超行文字）
            fitVodTitles(grid);
            // 缺封面后台补拉（T73：历史/收藏 Kazumi 卡按片名从 Bangumi 拉封面并缓存，其余走 detailContent）
            if (typeof fillMissingCovers === 'function') {
                fillMissingCovers(`#${viewName}-grid`, null, { concurrency: 4, poolKey: 'rec-' + storeKey });
            }
            renderPagerBox($(`#${viewName}-pager`), {
                page: this._page,
                pagecount,
                onJump: (pg) => { this._page = pg; this.render(); },
            });
            this._syncSelBar();
        },

        /** 循环切换标签（仅本地收藏）：想看→在看→已看→搁置→抛弃→取消；写回存储后重渲染。 */
        async toggleTag(uid) {
            const list = await recGet(storeKey);
            const it = list.find((x) => String(x.uid) === uid);
            if (!it) return;
            const cur = normTag(it.tag);
            const i = TAG_ORDER.indexOf(cur);
            it.tag = (i >= 0) ? TAG_ORDER[(i + 1) % TAG_ORDER.length] : 'want';
            await recSet(storeKey, list);
            await this.render();
            warnToast(it.tag ? `已标记为${tagLabel(it.tag)}` : '已取消状态标记');
        },

        /** 进入/退出多选模式：切换卡片勾选框可见性与工具栏按钮。 */
        toggleSelectMode() {
            this._selectMode = !this._selectMode;
            $(`#${viewName}-grid`).toggleClass('selecting', this._selectMode);
            if (!this._selectMode) {
                $(`#${viewName}-grid .rec-check`).removeClass('checked');
                $(`#${viewName}-grid .vod-card`).removeClass('sel');
                $(`#${viewName}-checkall`).prop('checked', false);
            }
            this._syncSelToolbar();
            this._syncSelBar();
        },

        /** 工具栏按钮文案/可见性跟随选择模式（T40：收藏额外显标记按钮）。 */
        _syncSelToolbar() {
            $(`#${viewName}-multidel`).text(this._selectMode ? '退出多选' : '多选');
            $(`#${viewName}-checkall-wrap, #${viewName}-delchecked`).toggle(this._selectMode);
            if (withTags) $(`#${viewName}-tagwant, #${viewName}-tagseen, #${viewName}-tagwatching, #${viewName}-taghold, #${viewName}-tagdropped`).toggle(this._selectMode);
        },

        /** 勾选计数与按钮文案同步。 */
        _syncSelBar() {
            const n = $(`#${viewName}-grid .rec-check.checked`).length;
            const total = $(`#${viewName}-grid .rec-check`).length;
            $(`#${viewName}-delchecked`).text(n ? `删除勾选（${n}）` : '删除勾选');
            if (withTags) $(`#${viewName}-checkall`).prop('checked', total > 0 && n === total);
        },

        /** 批量标记勾选项想看/已看（仅收藏，T40）。 */
        async tagChecked(tag) {
            const keys = {};
            $(`#${viewName}-grid .rec-check.checked`).each(function () {
                keys[String($(this).data('uid'))] = 1;
            });
            const n = Object.keys(keys).length;
            if (!n) { warnToast('请先勾选要标记的条目'); return; }
            const list = await recGet(storeKey);
            list.forEach((x) => {
                if (keys[String(x.uid)]) x.tag = tag;
            });
            await recSet(storeKey, list);
            this._selectMode = false;
            this._syncSelToolbar();
            await this.render();
            warnToast(`已将 ${n} 条标记为${tagLabel(tag)}`);
        },

        /** 观看进度追踪：更新收藏条目的观看进度（仅收藏）。按 site|vodId 定位（条目级身份）。 */
        async updateProgress(site, vodId, progress) {
            const list = await recGet(storeKey);
            const it = list.find((x) => String(x.site) === site && String(x.vodId) === vodId);
            if (!it) return;
            it.progress = progress; // { currentEp, totalEps, percent, ts }
            it.ts = Date.now(); // 置顶
            await recSet(storeKey, list);
        },

        /** 获取收藏条目的观看进度。按 site|vodId 定位（条目级身份）。 */
        async getProgress(site, vodId) {
            const list = await recGet(storeKey);
            const it = list.find((x) => String(x.site) === site && String(x.vodId) === vodId);
            return it ? it.progress : null;
        },

        /** 批量删除勾选项。 */
        async removeChecked() {
            const keys = {};
            $(`#${viewName}-grid .rec-check.checked`).each(function () {
                keys[String($(this).data('uid'))] = 1;
            });
            const n = Object.keys(keys).length;
            if (!n) { warnToast('请先勾选要删除的条目'); return; }
            if (!await confirmDialog(`删除勾选的 ${n} 条记录？`, { okText: '删除' })) return;
            let list = await recGet(storeKey);
            list = list.filter((x) => !keys[String(x.uid)]);
            await recSet(storeKey, list);
            this._selectMode = false;
            this._syncSelToolbar();
            await this.render();
            warnToast(`已删除 ${n} 条`);
        },

        /** 编辑标题：找到条目后弹对话框。 */
        async edit(uid) {
            const list = await recGet(storeKey);
            const it = list.find((x) => String(x.uid) === uid);
            if (!it) return;
            openRecEdit(storeKey, uid, it.name, () => this.render());
        },

        async remove(uid) {
            let list = await recGet(storeKey);
            const it = list.find((x) => String(x.uid) === uid);
            const name = it ? it.name : '此记录';
            if (!await confirmDialog(`确定删除「${name}」？`, { okText: '删除' })) return;
            list = list.filter((x) => String(x.uid) !== uid);
            await recSet(storeKey, list);
            await this.render();
        },

        async clear() {
            if (!await confirmDialog(`确定清空全部${storeKey === 'favorites' ? '收藏' : '历史'}？此操作不可撤销。`, { okText: '清空' })) return;
            await recSet(storeKey, []);
            await this.render();
            warnToast('已清空');
        },
    };
}

const Favorites = makeRecordView('view-favorites', 'favorites', '暂无收藏。打开影片详情页点“收藏”按钮即可添加。', true, true, 'pageSizeFavorites');
const HistoryView = makeRecordView('view-history', 'history', '暂无播放历史。打开影片详情页会自动记录。', true, false, 'pageSizeHistory');
