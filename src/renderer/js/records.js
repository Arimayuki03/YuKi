/**
 * records.js — 收藏与播放历史
 *
 * 数据存 settings（favorites / history），条目 {site, siteName, vodId, name, pic, remarks, ts}，
 * 最新在前，上限 200 条。详情页打开时自动记入历史；收藏在详情页手动切换。
 * 两个视图共用网格渲染（recCard），卡片 ✕ 可单条移除；历史页保留一键清空（T40 起收藏页无清空）。
 * 两页均支持搜索（片名/备注/源）；收藏额外带「想看/已看」标签（tag：want/seen，默认 want）。
 */
/* global $, escHtml, normalizePic, warnToast, Detail, renderPagerBox, pageSizeOf */

async function recGet(key) {
    try {
        const s = (await window.vpc.settingsGet()) || {};
        return Array.isArray(s[key]) ? s[key] : [];
    } catch (e) { return []; }
}

async function recSet(key, list) {
    try { await window.vpc.settingsSet(key, list); } catch (e) { /* 保存失败不影响主流程 */ }
}

const Records = {
    /** 详情页打开时记入历史（按片名去重合并：同名影片只保留一条，新来源信息覆盖旧条目后置顶）。
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
            // 同名条目：更新来源信息为最新打开的那个，时间戳刷新并置顶
            const old = list.splice(idx, 1)[0];
            list.unshift({
                site: v.site || old.site,
                siteName: v.siteName || old.siteName,
                vodId: v.vodId || old.vodId,
                name: old.name,   // 保留原标题（显示名不变）
                pic: v.pic || old.pic,
                remarks: v.remarks || old.remarks,
                ts: Date.now(),
            });
        } else {
            list.unshift({ site: v.site, siteName: v.siteName || '', vodId: v.vodId, name: v.name || '', pic: v.pic || '', remarks: v.remarks || '', ts: Date.now() });
        }
        if (list.length > 200) list = list.slice(0, 200);
        await recSet('history', list);
    },

    async isFavorite(site, vodId) {
        const list = await recGet('favorites');
        return list.some((x) => String(x.site) === String(site) && String(x.vodId) === String(vodId));
    },

    /** 切换收藏状态，返回 true=已收藏。 */
    async toggleFavorite(v) {
        let list = await recGet('favorites');
        const idx = list.findIndex((x) => String(x.site) === String(v.site) && String(x.vodId) === String(v.vodId));
        let added = false;
        if (idx >= 0) {
            list.splice(idx, 1);
        } else {
            list.unshift({ site: v.site, siteName: v.siteName || '', vodId: v.vodId, name: v.name || '', pic: v.pic || '', remarks: v.remarks || '', tag: 'want', ts: Date.now() });
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
            it = { site: v.site, siteName: v.siteName || '', vodId: v.vodId, name: v.name || '', pic: v.pic || '', remarks: v.remarks || '', tag, ts: Date.now() };
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

/** 收藏/历史共用卡片（带 site 标识、移除/编辑按钮与多选勾选框；editable 时附编辑按钮；withTags 时封面左上角加想看/已看标签，无标签不显示）。 */
function recCard(v, editable, withTags) {
    const tag = normTag(v.tag);
    return `<div class="vod-card" data-site="${escHtml(v.site)}" data-id="${escHtml(v.vodId)}" data-name="${escHtml(v.name)}" tabindex="0">
        <span class="rec-check" data-site="${escHtml(v.site)}" data-id="${escHtml(v.vodId)}" title="勾选后可批量删除"></span>
        ${withTags && tag ? `<span class="rec-tag ${tag === 'seen' ? 'seen' : ''}" data-site="${escHtml(v.site)}" data-id="${escHtml(v.vodId)}" title="点击循环切换：想看→已看→取消">${tag === 'seen' ? '已看' : '想看'}</span>` : ''}
        <button class="rec-del" data-site="${escHtml(v.site)}" data-id="${escHtml(v.vodId)}" title="移除">✕</button>
        ${editable ? `<button class="rec-edit" data-site="${escHtml(v.site)}" data-id="${escHtml(v.vodId)}" title="编辑标题">✎</button>` : ''}
        <div class="vod-cover">${vodCoverImg(v.pic)}${v.siteName ? `<span class="rec-site" title="来源：${escHtml(v.siteName)}">源：${escHtml(v.siteName)}</span>` : ''}</div>
        <div class="vod-name" title="${escHtml(v.name)}">${escHtml(v.name)}</div>
        <div class="vod-remarks">${escHtml(v.remarks || '')}</div>
    </div>`;
}

// ---- 编辑记录（改显示标题）：两视图共用一个对话框 ----
let _editCtx = null;

function openRecEdit(storeKey, site, vodId, name, renderFn) {
    _editCtx = { storeKey, site, vodId, renderFn };
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
    const it = list.find((x) => String(x.site) === ctx.site && String(x.vodId) === ctx.vodId);
    if (!it) { warnToast('记录不存在，可能已被删除'); return; }
    it.name = name;
    await recSet(ctx.storeKey, list);
    if (ctx.renderFn) await ctx.renderFn();
    warnToast('已保存');
}

/** 视图工厂：收藏与历史结构一致，仅存储键与空态文案不同；editable 开启卡片编辑按钮；withTags 开启想看/已看标签（仅收藏）；pageSizeKey 为各自的每页条数设置键（T39）。多选（T40）：收藏支持批量删除/标记想看/标记已看且保留全选；历史仅批量删除且无全选；清空按钮仅历史保留。 */
function makeRecordView(viewName, storeKey, emptyTip, editable, withTags, pageSizeKey) {
    return {
        _inited: false,
        _selectMode: false, // 多选删除模式：卡片点击改为切换勾选
        _q: '',   // 搜索关键字（片名/备注/源，不区分大小写）
        _tag: '', // 标签筛选（want/seen，空=全部；仅 withTags 视图生效）
        _page: 1, // 客户端分页当前页（T6：超过每页条数时分页展示）

        init() {
            if (this._inited) return;
            this._inited = true;
            $(`#${viewName}`)
                .on('click', '.rec-del', (e) => {
                    e.stopPropagation();
                    const el = $(e.currentTarget);
                    this.remove(String(el.data('site')), String(el.data('id')));
                })
                .on('click', '.rec-edit', (e) => {
                    e.stopPropagation();
                    const el = $(e.currentTarget);
                    this.edit(String(el.data('site')), String(el.data('id')));
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
                // 批量标记想看/已看（T40）
                $(`#${viewName}-tagwant`).on('click', () => this.tagChecked('want'));
                $(`#${viewName}-tagseen`).on('click', () => this.tagChecked('seen'));
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
                // 卡片标签点击：想看 → 已看 → 取消（三态循环）
                $(`#${viewName}`).on('click', '.rec-tag', (e) => {
                    e.stopPropagation();
                    const el = $(e.currentTarget);
                    this.toggleTag(String(el.data('site')), String(el.data('id')));
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
            slice.forEach((v) => grid.append(recCard(v, editable, withTags)));
            renderPagerBox($(`#${viewName}-pager`), {
                page: this._page,
                pagecount,
                onJump: (pg) => { this._page = pg; this.render(); },
            });
            this._syncSelBar();
        },

        /** 循环切换标签（仅收藏）：想看→已看→取消→想看；写回存储后重渲染。 */
        async toggleTag(site, vodId) {
            const list = await recGet(storeKey);
            const it = list.find((x) => String(x.site) === site && String(x.vodId) === vodId);
            if (!it) return;
            const cur = normTag(it.tag);
            it.tag = cur === 'want' ? 'seen' : (cur === 'seen' ? '' : 'want');
            await recSet(storeKey, list);
            await this.render();
            warnToast(it.tag === 'seen' ? '已标记为已看' : (it.tag === 'want' ? '已标记为想看' : '已取消想看/已看标记'));
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
            if (withTags) $(`#${viewName}-tagwant, #${viewName}-tagseen`).toggle(this._selectMode);
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
                keys[String($(this).data('site')) + '|' + String($(this).data('id'))] = 1;
            });
            const n = Object.keys(keys).length;
            if (!n) { warnToast('请先勾选要标记的条目'); return; }
            const list = await recGet(storeKey);
            list.forEach((x) => {
                if (keys[String(x.site) + '|' + String(x.vodId)]) x.tag = tag;
            });
            await recSet(storeKey, list);
            this._selectMode = false;
            this._syncSelToolbar();
            await this.render();
            warnToast(`已将 ${n} 条标记为${tag === 'seen' ? '已看' : '想看'}`);
        },

        /** 批量删除勾选项。 */
        async removeChecked() {
            const keys = {};
            $(`#${viewName}-grid .rec-check.checked`).each(function () {
                keys[String($(this).data('site')) + '|' + String($(this).data('id'))] = 1;
            });
            const n = Object.keys(keys).length;
            if (!n) { warnToast('请先勾选要删除的条目'); return; }
            if (!await confirmDialog(`删除勾选的 ${n} 条记录？`, { okText: '删除' })) return;
            let list = await recGet(storeKey);
            list = list.filter((x) => !keys[String(x.site) + '|' + String(x.vodId)]);
            await recSet(storeKey, list);
            this._selectMode = false;
            this._syncSelToolbar();
            await this.render();
            warnToast(`已删除 ${n} 条`);
        },

        /** 编辑标题：找到条目后弹对话框。 */
        async edit(site, vodId) {
            const list = await recGet(storeKey);
            const it = list.find((x) => String(x.site) === site && String(x.vodId) === vodId);
            if (!it) return;
            openRecEdit(storeKey, site, vodId, it.name, () => this.render());
        },

        async remove(site, vodId) {
            let list = await recGet(storeKey);
            const it = list.find((x) => String(x.site) === site && String(x.vodId) === vodId);
            const name = it ? it.name : '此记录';
            if (!await confirmDialog(`确定删除「${name}」？`, { okText: '删除' })) return;
            list = list.filter((x) => !(String(x.site) === site && String(x.vodId) === vodId));
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
