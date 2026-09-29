/**
 * bgm-rate.js — Bangumi 评分/吐槽/打标签对话框（对齐 Kazumi 的评分与吐槽能力）
 *
 * 入口（本模块只提供 openRateDialog，不自带入口 UI）：
 *   - detail.js 详情页 hero 操作行「评分 / 吐槽」按钮（批注笔图标）（T80）；
 *   - bangumi-search.js 搜索结果卡片操作条「评分/吐槽」。
 * 数据通道：POST /v0/users/-/collections/{subject_id}（body 可选 type/rate/comment/tags，
 * 对齐官方 OpenAPI UserSubjectCollectionModifyPayload：rate 0-10 整数、0=清除评分；
 * tags 为个人标签字符串数组——对齐 Kazumi rating_review_dialog：最多 10 个、单个 ≤10 字）。
 * server.py 不新增 do —— 复用 kazumiBangumiSyncApply 端点单条透传（type<1 表示不动收藏）。
 * 提交成功后 FavHub.changed 广播，my.js 自动作废 Bangumi 收藏缓存并重拉；
 * 当前详情页匹配该条目时另触发吐槽乐观刷新（Detail.onBgmCommentSubmitted）。
 *
 * 纯逻辑函数（clampRate / starsFor / fmtRateLabel / normalizeTagInput /
 * buildRatingPayload）导出到 YUKI.bgmRate 供 tests/js/bgm-rate.test.js 在 VM 中直接单测。
 */
/* global $, doAction, warnToast, openDialog, closeDialog, FavHub, Kazumi, Detail, escHtml */

// 模块加载时保存的原始 closeDialog（common.js 顶层函数声明）。_close 关闭对话框时
// 直调它而非全局符号：全局符号已被底部 IIFE 包装，wrapped 检测到挂起的 _resolve 会
// 再次回调 _close，二者互相递归（RangeError：对话框永不隐藏、Promise 永不 resolve，
// 提交成功的异常还会被 submit 的 catch 误报成「提交失败：网络错误」）。
let origCloseDialog = null;

// 标签客户端边界（对齐 Kazumi rating_review_dialog：_maxTags=10 / _maxTagLength=10）
const BGM_RATE_MAX_TAGS = 10;
const BGM_RATE_TAG_MAX_LEN = 10;
// 热门标签默认展示数；超出折叠到「更多」按钮后面（对齐 Kazumi 默认 6 个 + 展开收起）
const BGM_RATE_POPULAR_TAGS = 6;
// 悬停离开后延迟收起面板的毫秒数：容忍按钮与面板间的空隙，避免移动指针时闪烁
const BGM_RATE_KAMOJI_HIDE_DELAY = 150;
// 颜文字清单（纯文本，可直接进 Bangumi 吐槽；按情绪分组排列，避免让人犯尴尬症的高频网络梗）
const BGM_RATE_KAMOJI = [
    // 开心/兴奋
    '(￣▽￣)', 'ヾ(≧▽≦*)o', '(๑•̀ㅂ•́)و✧', '٩(◕‿◕｡)۶', '(≧∇≦)ﾉ',
    '(☆ω☆)', '(o°▽°)o', '(・∀・)', '(•‿•)',
    // 爱/萌
    'ヾ(´︶`♡)ﾉ', '♪(^∇^*)', '(๑´ㅂ`๑)', '(ฅ´ω`ฅ)', '(๑¯◡¯๑)',
    '(づ￣ ³￣)づ', '( ˘ ³˘)♥', '(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧', '(･ω≦)☆', '(ﾉ´ヮ`)ﾉ*: ･ﾟ',
    // 无语/淡定
    '(´･ω･`)', '（ ´∀｀）', '(－_－) zzZ', '(¬_¬ )', '(→_→)', '( ˘•ω•˘ )',
    '(σﾟｰﾟ)σ', '(⌐■_■)', '( ͡° ͜ʖ ͡°)', '¯\\_(ツ)_/¯',
    // 流泪/伤心
    '(´;ω;`)', '「T^T」', '(ಥ﹏ಥ)', '(╥﹏╥)', '(｡•́︿•̀｡)', 'Orz',
    // 震惊/暴走
    'Σ(っ °Д °;)っ', '(╯°□°）╯︵ ┻━┻', '(⊙_⊙)', '(ﾟДﾟ)', '(ノ°益°)ノ', '(＞﹏＜)', '(ง •_•)ง',
];

const BgmRate = {
    // 提交防抖：同一 subject 在途时不重复弹窗提交
    _inFlightId: '',
    // 当前对话框上下文（subjectId/name/当前评分/当前吐槽/标签状态）
    _ctx: null,
    // 热门标签展开态：每次打开对话框重置为收起
    _showAllPopular: false,
    // 颜文字面板展开态：悬停展开/离开收起；点击按钮钉住（pin），点面板外才收起
    _kamojiOpen: false,
    _kamojiPinned: false,
    // 悬停收起的延时器句柄
    _kamojiHideTimer: 0,

    /**
     * 补查某条目的当前评分/吐槽/标签（GET /v0/users/{u}/collections/{subject_id}，
     * UserSubjectCollection 含 rate/comment/tags；收藏列表端点不回传这三字段）。
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
            return { rate: this.clampRate(col.rate), comment: String(col.comment || ''), tags: this.normalizeTags(col.tags) };
        } catch (e) {
            return none;
        }
    },

    /**
     * 入口 UI：详情页 hero 操作行 #detail-bgm-rate（detail.js 渲染 + 委托）。
     * （T80 前的收藏卡封面注入入口 injectCardActions 与 my.js 的 .rec-bgm-rate
     * document 委托已随卡片按钮移除而删除。）
     */

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

    /** 标签数组归一化（展示/状态共用）：字符串数组 → 去空白、剔空、保序去重；
     *  官方/next 返回的标签项可能是 {name} 对象（同 Kazumi BangumiInterest.fromJson 兼容）。 */
    normalizeTags(list) {
        if (!Array.isArray(list)) return [];
        const seen = new Set();
        const out = [];
        for (const t of list) {
            const name = (t && typeof t === 'object') ? String(t.name || '') : String(t || '');
            const s = name.trim();
            if (!s || seen.has(s)) continue;
            seen.add(s);
            out.push(s);
        }
        return out.slice(0, BGM_RATE_MAX_TAGS);
    },

    /** 自定义标签输入校验（对齐 Kazumi _addCustomTag 的错误口径）。
     *  返回 {ok, tag, msg}：空串/超长/重复/超上限分别给出可操作提示。 */
    normalizeTagInput(raw, selected) {
        const t = String(raw || '').trim();
        if (!t) return { ok: false, tag: '', msg: '请输入标签' };
        if (t.length > BGM_RATE_TAG_MAX_LEN) return { ok: false, tag: '', msg: `标签最多 ${BGM_RATE_TAG_MAX_LEN} 字` };
        if ((selected || []).includes(t)) return { ok: false, tag: '', msg: '标签已添加' };
        if ((selected || []).length >= BGM_RATE_MAX_TAGS) return { ok: false, tag: '', msg: `最多 ${BGM_RATE_MAX_TAGS} 个标签` };
        return { ok: true, tag: t, msg: '' };
    },

    /** 构造 kazumiBangumiSyncApply 单条透传 payload（纯函数，单测覆盖）。
     *  rate==null 且 comment 为空且 tags 为空数组 → 返回 null（无改动不提交）。
     *  tags 语义：undefined=不修改；数组（含空数组=清除全部标签）随 payload 提交。
     *  type=-1 语义：不动收藏类型（后端 body 不含有效 type 键）。 */
    buildRatingPayload(subjectId, rate, comment, tags) {
        const sid = String(subjectId || '').trim();
        if (!sid) return null;
        const r = this.clampRate(rate);
        const c = String(comment || '').trim();
        const hasTags = Array.isArray(tags);
        if (r === null && !c && !hasTags) return null;
        const item = { subjectId: sid, type: -1 };
        if (r !== null) item.rate = r;
        if (c) item.comment = c;
        if (hasTags) item.tags = this.normalizeTags(tags);
        return item;
    },

    /**
     * 打开评分/吐槽/标签对话框。
     * @param {object} opts { subjectId, name, rate(当前评分，可空), comment(当前吐槽，可空),
     *   tags(当前个人标签数组，可空), popularTags(条目标签数组做热门建议，可空) }
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
        this._showAllPopular = false;
        this._kamojiPinned = false;
        this._kamojiOpen = false;
        // 状态复位必须同步 DOM（面板/按钮是 index.html 常驻元素，重开不重建）：
        // 上一会话钉住展开后走 Esc 关闭（_close 不收面板），残影 .open/.active 与
        // aria-expanded=true 需在此清掉——点外收起守卫见 _kamojiOpen=false 会提前返回，
        // 残影只能靠悬停清除，故开窗前主动同步。
        this._kamojiSync();
        const initTags = this.normalizeTags(opts.tags);
        this._ctx = {
            subjectId: sid,
            name: String(opts.name || ''),
            rate: this.clampRate(opts.rate),
            comment: String(opts.comment || ''),
            // 当前个人标签（收藏接口回传）：对话框内可增删，提交时整体覆盖
            tags: initTags.slice(),
            // 初始标签快照：脏检查用（一致则 payload 不带 tags 键，不动远端标签）
            tagsInit: initTags,
            // 热门建议 = 条目公共标签（用户没选的不展示计数徽标，纯名展示）
            popularTags: this.normalizeTags(opts.popularTags),
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

    /** 渲染对话框内容（按 _ctx）：星级选择器 + 当前评分标签 + 吐槽文本框 + 标签编辑区。
     *  opts.preserveTagInput：重渲时保留自定义标签输入框草稿（星级交互触发的重渲）。 */
    _renderDialog(opts = {}) {
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
        this._renderKamoji();
        this._renderTags({ preserveInput: !!opts.preserveTagInput });
        $('#bgm-rate-status').text('').hide();
    },

    /** 标签区渲染：已选 chips（可删）+ 热门建议（点击增删）+ 自定义输入。
     *  opts.preserveInput：保留输入框草稿——星级点击/清除评分会触发整对话框
     *  重渲，无此参数时用户正在输入的自定义标签会被静默清掉。 */
    _renderTags(opts = {}) {
        const c = this._ctx;
        if (!c) return;
        const selected = c.tags || [];
        $('#bgm-rate-tags-count').text(`${selected.length} / ${BGM_RATE_MAX_TAGS}`);
        // 已选标签 chips：点 × 整体移除
        const sel = selected.map((t) =>
            `<span class="bgm-rate-tag-chip" data-tag="${escHtmlAttr(t)}">${escHtml(t)}<button type="button"
                class="bgm-rate-tag-remove" data-tag="${escHtmlAttr(t)}" title="移除标签 ${escHtml(t)}" aria-label="移除标签 ${escHtml(t)}">×</button></span>`).join('');
        $('#bgm-rate-tags-selected').html(sel || '<span class="bgm-rate-tags-empty">未添加标签</span>');
        // 热门标签：条目公共标签做建议；点击在已选里增删（toggle）；默认 6 个，更多展开
        const popular = c.popularTags || [];
        let pop = popular.slice(0, this._showAllPopular ? popular.length : BGM_RATE_POPULAR_TAGS)
            .map((t) => {
                const active = selected.includes(t);
                return `<button type="button" class="bgm-rate-tag-pop${active ? ' active' : ''}" data-tag="${escHtmlAttr(t)}">${escHtml(t)}</button>`;
            }).join('');
        if (popular.length > BGM_RATE_POPULAR_TAGS) {
            pop += `<button type="button" id="bgm-rate-tags-more" class="bgm-rate-tag-more">${this._showAllPopular ? '收起' : `更多（${popular.length - BGM_RATE_POPULAR_TAGS}）`}</button>`;
        }
        $('#bgm-rate-tags-popular').html(pop);
        if (!opts.preserveInput) $('#bgm-rate-tag-input').val('');
        this._hideTagError();
    },

    /** 颜文字悬浮面板渲染：全量清单渲染进面板网格（面板本身负责显隐，内容不重建），
     *  点击项插入正文光标处。 */
    _renderKamoji() {
        const grid = BGM_RATE_KAMOJI
            .map((k) => `<button type="button" class="bgm-rate-kamoji" data-kamoji="${escHtmlAttr(k)}" title="插入 ${escHtmlAttr(k)}">${escHtml(k)}</button>`).join('');
        $('#bgm-rate-kamoji-panel').html(grid);
    },

    /** 颜文字面板显隐状态机（状态以 DOM class 为单一事实来源，跨会话重置靠 openRateDialog 归零）：
     *  - 悬停按钮/面板：展开（清除收起延时器）；
     *  - 离开：若已钉住（点击过按钮）则保持，否则 150ms 后收起（容忍指针跨越间隙）；
     *  - 点击按钮：toggle 钉住态——已开则立即收起，未开则展开并钉住（触屏/键盘路径）；
     *  - 点击面板外：解除钉住并收起。 */
    _kamojiSync() {
        $('#bgm-rate-kamoji-panel').toggleClass('open', !!this._kamojiOpen);
        $('#bgm-rate-kamoji-btn').toggleClass('active', !!this._kamojiOpen);
        $('#bgm-rate-kamoji-btn').attr('aria-expanded', !!this._kamojiOpen); // 展开态同步到无障碍属性（HTML 静态写死 false）
    },
    _kamojiHoverIn() {
        clearTimeout(this._kamojiHideTimer);
        this._kamojiHideTimer = 0;
        this._kamojiOpen = true;
        this._kamojiSync();
    },
    _kamojiHoverOut() {
        if (this._kamojiPinned) return;
        clearTimeout(this._kamojiHideTimer);
        this._kamojiHideTimer = setTimeout(() => {
            this._kamojiOpen = false;
            this._kamojiSync();
        }, BGM_RATE_KAMOJI_HIDE_DELAY);
    },
    _kamojiTogglePin() {
        clearTimeout(this._kamojiHideTimer);
        this._kamojiHideTimer = 0;
        this._kamojiPinned = !this._kamojiOpen;
        this._kamojiOpen = !this._kamojiOpen;
        this._kamojiSync();
    },
    _kamojiDismiss() {
        clearTimeout(this._kamojiHideTimer);
        this._kamojiHideTimer = 0;
        this._kamojiPinned = false;
        if (this._kamojiOpen) {
            this._kamojiOpen = false;
            this._kamojiSync();
        }
    },

    /** 颜文字插入：写入吐槽正文光标处（无选区/未聚焦时追加到文末），保持原有文本。 */
    _insertKamoji(k) {
        const s = String(k || '');
        if (!s) return;
        const $ta = $('#bgm-rate-comment');
        const cur = String($ta.val() || '');
        const pos = Number($ta.prop('selectionStart'));
        const next = (Number.isFinite(pos))
            ? cur.slice(0, pos) + s + cur.slice(Number($ta.prop('selectionEnd') || pos))
            : cur + s;
        $ta.val(next);
        if (typeof document !== 'undefined' && document.activeElement !== $ta[0]) $ta.trigger('focus');
    },

    /** 展示标签操作错误提示（自动清除输入框尾随错误状态；不抛 toast，保持对话框内反馈）。 */
    _showTagError(msg) {
        $('#bgm-rate-tag-error').text(String(msg || '')).show();
    },

    _hideTagError() {
        $('#bgm-rate-tag-error').text('').hide();
    },

    /** 热门/自定义标签 toggle：已选移除、未选追加（达上限报错）。 */
    _toggleTag(tag) {
        const c = this._ctx;
        if (!c) return;
        const t = String(tag || '').trim();
        if (!t) return;
        const idx = (c.tags || []).indexOf(t);
        if (idx >= 0) {
            c.tags.splice(idx, 1);
        } else {
            const v = this.normalizeTagInput(t, c.tags);
            if (!v.ok) { this._showTagError(v.msg); return; }
            c.tags.push(v.tag);
        }
        this._renderTags();
    },

    /** 星级点击：选中 ≤rate 的星（离散 10 档）；再点同一分值取消评分（置为 0=清除）。
     *  重渲保留输入框草稿（用户先打标签后调星级是常见顺序）。 */
    _pickRate(val) {
        const c = this._ctx;
        if (!c) return;
        c.rate = (c.rate === val) ? 0 : val;
        this._renderDialog({ preserveTagInput: true });
    },

    /** 清除评分（0=删除评分，官方语义）：星级全部熄灭，标签显示「未评分」。 */
    _clearRate() {
        const c = this._ctx;
        if (!c) return;
        c.rate = 0;
        this._renderDialog({ preserveTagInput: true });
    },

    /** 收集对话框当前输入并提交（kazumiBangumiSyncApply 单条透传）。
     *  评分单一事实来源是 _ctx.rate（_pickRate/_clearRate 维护）：0=清除评分必须
     *  进入 payload，不能从「active 星级」反推——0 分时无 active 星会误判成不修改。
     *  标签单一事实来源是 _ctx.tags：与打开时的初始标签有差异（或对话框内从未选过
     *  但当前有值）才随 payload 提交，避免纯评分提交意外把远端标签清空。
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
            // 标签脏检查：初始 tags 快照在 _ctx.tagsInit；一致则不带 tags 键（不修改）。
            // 输入框里的未确认草稿不参与提交（与 Kazumi 一致：提交时若有草稿先尝试入列）。
            const draft = String($('#bgm-rate-tag-input').val() || '').trim();
            if (draft) {
                const v = this.normalizeTagInput(draft, c.tags);
                if (!v.ok) {
                    // 草稿有误（重复/超限/超长）只提示，不阻断主提交——删掉无关输入
                    // 才能交评分是反直觉边界（对齐 Kazumi：草稿失败仅提示）
                    this._showTagError(`标签草稿未入列：${v.msg}`);
                } else {
                    c.tags.push(v.tag);
                    this._renderTags();
                }
            }
            const tagsDirty = JSON.stringify(c.tags || []) !== JSON.stringify(c.tagsInit || []);
            const item = this.buildRatingPayload(c.subjectId, rate, comment, tagsDirty ? (c.tags || []) : undefined);
            if (!item) { warnToast('评分、吐槽与标签均为空，无需提交'); return false; }
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
                // 成功文案：0=清除评分（官方语义）；仅标签变更不得误报「吐槽已提交」
                if (item.rate === 0) warnToast('已清除评分');
                else if (item.rate !== undefined) warnToast(`已评分：${this.fmtRateLabel(item.rate)}`);
                else if (item.tags !== undefined && !item.comment) warnToast('标签已更新');
                else warnToast('吐槽已提交');
                // 广播收藏变更：my.js 作废 Bangumi 收藏缓存重拉（评分/吐槽在收藏接口里回传）
                if (typeof FavHub !== 'undefined' && FavHub.changed) FavHub.changed();
                // T80：详情页提交后立即刷新吐槽数据——乐观插入 + 清缓存后台重拉合并
                // （next.bgm 索引延迟由乐观行兜底，重拉到达后按正文匹配去重）。
                // 仅当前详情页匹配该 subject 时生效（Detail 内部自判 _bgmId）。
                if (typeof Detail !== 'undefined' && Detail.onBgmCommentSubmitted) {
                    try { Detail.onBgmCommentSubmitted({ subjectId: c.subjectId, rate: item.rate, comment: item.comment }); }
                    catch (e) { /* 刷新失败不影响提交流程 */ }
                }
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

// 标签名进 data-* 属性与文本节点前的 HTML 转义。优先用 common.js 的 escHtml；
// VM 单测环境无该全局时兜底内联实现（与 common.js 同口径：& < > " ' 全转）。
function escHtmlAttr(s) {
    if (typeof escHtml === 'function') return escHtml(s);
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

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
    // 颜文字：悬停按钮/面板展开、离开延时收起；点击按钮钉住（触屏/键盘路径）；
    // 面板项点击插入正文光标处（面板保持打开，便于连续插入）
    $('#bgm-rate-kamoji-btn').on('mouseenter', () => {
        if (typeof BgmRate !== 'undefined') BgmRate._kamojiHoverIn();
    });
    $('#bgm-rate-kamoji-btn').on('mouseleave', () => {
        if (typeof BgmRate !== 'undefined') BgmRate._kamojiHoverOut();
    });
    $('#bgm-rate-kamoji-btn').on('click', (e) => {
        e.stopPropagation();
        if (typeof BgmRate !== 'undefined') BgmRate._kamojiTogglePin();
    });
    $('#bgm-rate-kamoji-panel').on('mouseenter', () => {
        if (typeof BgmRate !== 'undefined') BgmRate._kamojiHoverIn();
    });
    $('#bgm-rate-kamoji-panel').on('mouseleave', () => {
        if (typeof BgmRate !== 'undefined') BgmRate._kamojiHoverOut();
    });
    // 面板点击只对条目生效（stopPropagation 防触发面板外 dismiss 的 document 委托）
    $('#bgm-rate-kamoji-panel').on('click', '.bgm-rate-kamoji', (e) => {
        e.stopPropagation();
        if (typeof BgmRate !== 'undefined') BgmRate._insertKamoji($(e.currentTarget).data('kamoji') || '');
    });
    // 点击对话框内面板以外的区域：收起钉住的面板（document 委托，容器常驻 DOM）。
    // document 全局在 VM 单测沙箱缺席——guarded，缺席时跳过该兜底（不影响悬停/钉住路径）
    if (typeof document !== 'undefined' && document) {
        $(document).on('click', (e) => {
            if (typeof BgmRate === 'undefined' || !BgmRate._kamojiOpen) return;
            const t = e.target;
            const $panel = $('#bgm-rate-kamoji-panel');
            const inPanel = $panel[0] && $panel[0].contains ? $panel[0].contains(t) : false;
            if (!inPanel) BgmRate._kamojiDismiss();
        });
    }
    // 已选标签 chips：点 × 移除（委托）
    $('#bgm-rate-tags-selected').on('click', '.bgm-rate-tag-remove', (e) => {
        e.stopPropagation();
        if (typeof BgmRate !== 'undefined') BgmRate._toggleTag($(e.currentTarget).data('tag') || '');
    });
    // 热门标签：点击 toggle 选择（委托）；「更多」展开收起
    $('#bgm-rate-tags-popular').on('click', '.bgm-rate-tag-pop', (e) => {
        if (typeof BgmRate !== 'undefined') BgmRate._toggleTag($(e.currentTarget).data('tag') || '');
    });
    $('#bgm-rate-tags-popular').on('click', '#bgm-rate-tags-more', (e) => {
        e.stopPropagation();
        if (typeof BgmRate !== 'undefined') {
            BgmRate._showAllPopular = !BgmRate._showAllPopular;
            BgmRate._renderTags();
        }
    });
    // 自定义标签：添加按钮 + 回车快捷添加
    $('#bgm-rate-tag-add').on('click', () => {
        if (typeof BgmRate !== 'undefined') BgmRate._toggleTag($('#bgm-rate-tag-input').val() || '');
    });
    $('#bgm-rate-tag-input').on('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (typeof BgmRate !== 'undefined') BgmRate._toggleTag($('#bgm-rate-tag-input').val() || '');
        }
    });
    // 吐槽框自定义纵向拉伸（原生 resize 把手是右下角斜纹三角、与滚动条重叠难看）：
    // 指针按住把手拖拽 → 按 dy 实时改 textarea 高度，钳制 84~240px（同 CSS min/max）。
    // Pointer Events 兼容触屏；setPointerCapture 保证指针滑出把手也持续跟踪。
    // document 全局在 VM 单测沙箱缺席——guarded，缺席时跳过（输入框固定初始高度）。
    if (typeof document !== 'undefined' && document) {
        const MIN_H = 84, MAX_H = 240;
        $('#bgm-rate-comment-resize').on('pointerdown', (e) => {
            const ta = document.getElementById('bgm-rate-comment');
            const handle = e.currentTarget;
            if (!ta) return;
            e.preventDefault();
            const startY = e.clientY;
            const startH = ta.getBoundingClientRect().height || MIN_H;
            try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 无 capture 环境降级 */ }
            handle.classList.add('dragging');
            const onMove = (ev) => {
                const next = Math.min(MAX_H, Math.max(MIN_H, Math.round(startH + ev.clientY - startY)));
                ta.style.height = next + 'px';
            };
            const onUp = (ev) => {
                handle.classList.remove('dragging');
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
                try { handle.releasePointerCapture(ev.pointerId); } catch (err) { /* 已释放则忽略 */ }
            };
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        });
    }
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
    // 单测/复用导出（纯常量口径与实现一致）
    BgmRate.MAX_TAGS = BGM_RATE_MAX_TAGS;
    BgmRate.TAG_MAX_LEN = BGM_RATE_TAG_MAX_LEN;
    BgmRate.KAMOJI = BGM_RATE_KAMOJI;
    BgmRate.KAMOJI_HIDE_DELAY = BGM_RATE_KAMOJI_HIDE_DELAY;
}(typeof window !== 'undefined' ? window : globalThis));
