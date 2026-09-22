/**
 * bgm-rate.js — Bangumi 评分/吐槽对话框（对齐 Kazumi 的评分与吐槽能力）
 *
 * 入口（本模块只提供 openRateDialog，不自带入口 UI）：
 *   - bangumi-search.js 搜索结果卡片操作条「评分/吐槽」；
 *   - my.js 收藏条目操作条「评分/吐槽」。
 * 数据通道：POST /v0/users/-/collections/{subject_id}（body 可选 type/rate/comment，
 * 对齐官方 OpenAPI UserSubjectCollectionModifyPayload：rate 0-10 整数、0=清除评分）。
 * server.py 不新增 do —— 复用 kazumiBangumiSyncApply 端点单条透传（type<1 表示不动收藏）。
 * 提交成功后 FavHub.changed 广播，my.js 自动作废 Bangumi 收藏缓存并重拉。
 *
 * 纯逻辑函数（clampRate / starsFor / fmtRateLabel / buildRatingPayload）导出到
 * YUKI.bgmRate 供 tests/js/bgm-rate.test.js 在 VM 中直接单测。
 */
/* global $, doAction, warnToast, openDialog, closeDialog, FavHub, Kazumi */

// 模块加载时保存的原始 closeDialog（common.js 顶层函数声明）。_close 关闭对话框时
// 直调它而非全局符号：全局符号已被底部 IIFE 包装，wrapped 检测到挂起的 _resolve 会
// 再次回调 _close，二者互相递归（RangeError：对话框永不隐藏、Promise 永不 resolve，
// 提交成功的异常还会被 submit 的 catch 误报成「提交失败：网络错误」）。
let origCloseDialog = null;

const BgmRate = {
    // 提交防抖：同一 subject 在途时不重复弹窗提交
    _inFlightId: '',
    // 当前对话框上下文（subjectId/name/当前评分）
    _ctx: null,

    /**
     * 补查某条目的当前评分/吐槽（GET /v0/users/{u}/collections/{subject_id}，
     * UserSubjectCollection 含 rate/comment；收藏列表端点不回传这两字段）。
     * cached 命中（myRate 非 null）直接返回不重查；未收藏/无 token/失败 → {rate:null, comment:''}。
     */
    async fetchCurrent(subjectId, cached) {
        const none = { rate: null, comment: '' };
        if (cached && (cached.myRate === 0 || cached.myRate)) {
            return { rate: this.clampRate(cached.myRate), comment: String(cached.myComment || '') };
        }
        const token = (typeof Kazumi !== 'undefined' && Kazumi._getBangumiToken)
            ? await Kazumi._getBangumiToken() : '';
        if (!token || !String(subjectId || '').trim()) return none;
        try {
            const rsp = await doAction('kazumiBangumiCollectionGet', { token, id: subjectId }, '/kazumi/action');
            const col = (rsp && rsp.collection) || null;
            if (!col) return none; // 未收藏（404）或失败：按无评分处理
            return { rate: this.clampRate(col.rate), comment: String(col.comment || '') };
        } catch (e) {
            return none;
        }
    },

    /**
     * 给收藏网格容器里的 Bangumi 卡注入「评分」操作按钮（幂等：已有则跳过）。
     * Bangumi 收藏卡由 records.js recCard 渲染（本文件不改动它），这里在渲染后
     * 按 data-site="bangumi" 定位补挂操作徽标（对齐 rec-check/rec-tag 的定位方式）。
     */
    injectCardActions($grid) {
        if (!$grid || !$grid.find) return;
        $grid.find('.vod-card[data-site="bangumi"]').each((_, el) => {
            const $card = $(el);
            if ($card.find('.rec-bgm-rate').length) return;
            const sid = String($card.data('id') || '');
            if (!sid) return;
            $card.append('<button type="button" class="rec-bgm-rate" title="评分 / 吐槽（同步到 Bangumi）">★ 评分</button>');
        });
    },

    /** 评分钳制：非法输入转 null（无评分）；0-10 之外钳到边界。
     *  0 语义 = 清除评分（官方 API 约定），合法保留。 */
    clampRate(v) {
        if (v === null || v === undefined || v === '') return null;
        let n = Number(v);
        if (!Number.isFinite(n)) return null;
        n = Math.round(n);
        if (n < 0) return 0;
        if (n > 10) return 10;
        return n;
    },

    /** 分值 → 星级展示串（5 星制，半星向下取）：8→★★★★☆，null→'☆☆☆☆☆'。 */
    starsFor(rate) {
        const n = this.clampRate(rate) || 0;
        const full = Math.floor(n / 2);
        const half = (n % 2) >= 1;
        const fullStr = '★'.repeat(full);
        const rest = '☆'.repeat(5 - full - (half ? 1 : 0));
        return fullStr + (half ? '⯨' : '') + rest;
    },

    /** 分值 → 对话框展示标签：null/0→'未评分'，否则「8 分 / 神作」风格。 */
    fmtRateLabel(rate) {
        const n = this.clampRate(rate);
        if (!n) return '未评分';
        const labels = {
            1: '不忍直视', 2: '很差', 3: '差', 4: '较差', 5: '不过不去',
            6: '还行', 7: '推荐', 8: '力荐', 9: '神作', 10: '超神作',
        };
        return `${n} 分 · ${labels[n] || ''}`;
    },

    /** 构造 kazumiBangumiSyncApply 单条透传 payload（纯函数，单测覆盖）。
     *  rate==null 且 comment 为空 → 返回 null（无改动不提交）。
     *  type=-1 语义：不动收藏类型（后端 body 不含有效 type 键）。 */
    buildRatingPayload(subjectId, rate, comment) {
        const sid = String(subjectId || '').trim();
        if (!sid) return null;
        const r = this.clampRate(rate);
        const c = String(comment || '').trim();
        if (r === null && !c) return null;
        const item = { subjectId: sid, type: -1 };
        if (r !== null) item.rate = r;
        if (c) item.comment = c;
        return item;
    },

    /**
     * 打开评分/吐槽对话框。
     * @param {object} opts { subjectId, name, rate(当前评分，可空), comment(当前吐槽，可空) }
     * @returns {Promise<boolean>} 提交成功 true；取消/失败 false
     */
    openRateDialog(opts) {
        opts = opts || {};
        const sid = String(opts.subjectId || '').trim();
        if (!sid) { warnToast('缺少 Bangumi 条目 ID'); return Promise.resolve(false); }
        if (this._inFlightId === sid) { warnToast('该条目的评分正在提交中…'); return Promise.resolve(false); }
        // 对话框已打开时再次调用：先按取消复位旧会话（旧 Promise 立即 resolve(false)），
        // 避免旧 Promise 悬挂、其 _resolve 被新会话覆盖后永不 settle
        if (this._resolve) this._close(false);
        this._ctx = {
            subjectId: sid,
            name: String(opts.name || ''),
            rate: this.clampRate(opts.rate),
            comment: String(opts.comment || ''),
        };
        this._renderDialog();
        return new Promise((resolve) => {
            this._resolve = resolve;
            openDialog('bgmRateDialog');
            // 初始焦点：评分已有时聚焦吐槽框，否则聚焦提交键（键盘友好）
            if (this._ctx.rate !== null) $('#bgm-rate-comment').trigger('focus');
            else $('#bgm-rate-submit').trigger('focus');
        });
    },

    /** 渲染对话框内容（按 _ctx）：星级选择器 + 当前评分标签 + 吐槽文本框。 */
    _renderDialog() {
        const c = this._ctx || {};
        const name = c.name || '未命名条目';
        $('#bgm-rate-name').text(name);
        // 星级按钮：1-10 分，点击即选；当前分及以下高亮
        const stars = [];
        for (let i = 1; i <= 10; i++) {
            const active = c.rate !== null && i <= c.rate;
            stars.push(`<button type="button" class="bgm-rate-star${active ? ' active' : ''}" data-rate="${i}"
                title="${i} 分" aria-label="${i} 分">★</button>`);
        }
        $('#bgm-rate-stars').html(stars.join(''));
        $('#bgm-rate-label').text(this.fmtRateLabel(c.rate));
        $('#bgm-rate-comment').val(c.comment || '');
        $('#bgm-rate-status').text('').hide();
    },

    /** 星级点击：选中 ≤rate 的星（离散 10 档）；再点同一分值取消评分（置为 0=清除）。 */
    _pickRate(val) {
        const c = this._ctx;
        if (!c) return;
        c.rate = (c.rate === val) ? 0 : val;
        this._renderDialog();
    },

    /** 清除评分（0=删除评分，官方语义）：星级全部熄灭，标签显示「未评分」。 */
    _clearRate() {
        const c = this._ctx;
        if (!c) return;
        c.rate = 0;
        this._renderDialog();
    },

    /** 收集对话框当前输入并提交（kazumiBangumiSyncApply 单条透传）。
     *  评分单一事实来源是 _ctx.rate（_pickRate/_clearRate 维护）：0=清除评分必须
     *  进入 payload，不能从「active 星级」反推——0 分时无 active 星会误判成不修改。
     *  防重入：入口即占位 _inFlightId（先于任何 await），同一 subject 在途时
     *  忽略重复触发，杜绝连点并发多个 PATCH；提交按钮同步禁用、finally 复位。 */
    async submit() {
        const c = this._ctx;
        if (!c) return false;
        // 同一条目已在途：直接忽略本次触发（连点/程序重复调用）
        if (this._inFlightId === c.subjectId) return false;
        this._inFlightId = c.subjectId;
        // 发送前禁用提交按钮：同步封死首个 await 前的连点窗口
        const $submit = $('#bgm-rate-submit').prop('disabled', true);
        const status = $('#bgm-rate-status');
        try {
            const rate = this.clampRate(c.rate);   // null=不修改；0=清除评分
            const comment = String($('#bgm-rate-comment').val() || '').trim();
            const item = this.buildRatingPayload(c.subjectId, rate, comment);
            if (!item) { warnToast('评分与吐槽均为空，无需提交'); return false; }
            const token = (typeof Kazumi !== 'undefined' && Kazumi._getBangumiToken)
                ? await Kazumi._getBangumiToken() : '';
            if (!token) {
                warnToast('请先在 设置 → Kazumi 规则 → Bangumi 同步 保存 Token');
                return false;
            }
            status.text('提交中…').show();
            const rsp = await doAction('kazumiBangumiSyncApply', {
                token, uploads: JSON.stringify([item]),
            }, '/kazumi/action');
            const r = rsp && rsp.result;
            const one = r && Array.isArray(r.results) ? r.results[0] : null;
            if (rsp && rsp.code === 200 && one && one.ok) {
                // 成功文案：0=清除评分（官方语义），不能显示「已评分：未评分」
                if (item.rate === 0) warnToast('已清除评分');
                else warnToast(item.rate !== undefined ? `已评分：${this.fmtRateLabel(item.rate)}` : '吐槽已提交');
                // 广播收藏变更：my.js 作废 Bangumi 收藏缓存重拉（评分/吐槽在收藏接口里回传）
                if (typeof FavHub !== 'undefined' && FavHub.changed) FavHub.changed();
                this._close(true);
                return true;
            }
            const msg = (one && one.msg) || (rsp && rsp.msg) || '未知错误';
            // 401 鉴权失败给可操作指引（对齐 setBangumiCollection 的提示模式）
            if (String(msg).includes('401') || String(msg).includes('Token 无效')) {
                status.text('Token 无效或已过期，请重新获取').show();
                warnToast('Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取');
            } else {
                status.text('提交失败：' + msg).show();
                warnToast('提交失败：' + msg);
            }
            return false;
        } catch (e) {
            status.text('提交失败：网络错误').show();
            warnToast('提交失败：网络错误');
            return false;
        } finally {
            this._inFlightId = '';
            $submit.prop('disabled', false);   // 复位提交按钮（含提前返回路径）
        }
    },

    /** 关闭对话框并 resolve 打开时的 Promise（submitted=是否已成功提交）。
     *  直调模块加载时保存的原始 closeDialog：全局符号已被 wrapped 覆写，
     *  若走全局符号，wrapped 见到挂起的 _resolve 会再次回调 _close → 无限递归。 */
    _close(submitted) {
        (origCloseDialog || closeDialog)('bgmRateDialog');
        const r = this._resolve;
        this._resolve = null;
        this._ctx = null;
        if (r) r(!!submitted);
    },
};

/** 对话框静态控件事件绑定（委托一次；DOM 常驻 index.html，控件 id 固定）。 */
(function bindBgmRateDialog() {
    if (typeof window === 'undefined' || !window.$) return;
    // 星级点击 → 选中/取消（委托在常驻的星级行容器上）
    $('#bgm-rate-stars').on('click', '.bgm-rate-star', (e) => {
        const val = Number($(e.currentTarget).data('rate') || 0);
        if (val >= 1 && typeof BgmRate !== 'undefined') BgmRate._pickRate(val);
    });
    // 清除评分：置 0（官方 0=删除评分语义）
    $('#bgm-rate-clear').on('click', () => {
        if (typeof BgmRate !== 'undefined') BgmRate._clearRate();
    });
    // 提交
    $('#bgm-rate-submit').on('click', () => {
        if (typeof BgmRate !== 'undefined') BgmRate.submit();
    });
    // 取消 / Esc 关闭走 closeDialog（common.js dialogStack 统一派发）→ resolve(false)
    $('#bgm-rate-cancel').on('click', () => {
        if (typeof BgmRate !== 'undefined') BgmRate._close(false);
    });
    // Esc/overlay 关闭（closeDialog('bgmRateDialog')）时若有挂起 Promise 按取消处理。
    // 包装 closeDialog 与 confirmDialog 同款兜底（防 Promise 挂死）。
    // 注意：本模块 common.js 之后 defer 加载，顶层函数声明已就绪，origClose 必非空。
    const origClose = (typeof closeDialog === 'function') ? closeDialog : null;
    if (origClose && !origClose._bgmRateWrapped) {
        const wrapped = function (id) {
            if (id === 'bgmRateDialog' && typeof BgmRate !== 'undefined' && BgmRate._resolve) {
                BgmRate._close(false);
                return;
            }
            return origClose(id);
        };
        wrapped._bgmRateWrapped = true;
        // common.js 的 dialogStack 派发引用的是全局 closeDialog 符号，覆写全局
        try { window.closeDialog = wrapped; } catch (e) { /* 严格模式下失败则跳过包装 */ }
        // _close 专用：记录未包装的原始引用，关闭时直调以断开与 wrapped 的互相递归
        origCloseDialog = origClose;
    }
}());

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.bgmRate = BgmRate;
    // 渲染层无模块系统，暴露全局供 bangumi-search.js / my.js 调用
    root.BgmRate = BgmRate;
}(typeof window !== 'undefined' ? window : globalThis));
