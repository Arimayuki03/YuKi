/**
 * kazumi.js — Kazumi 规则引擎前端模块
 *
 * 职责：规则管理（设置页导入/列表/删除/开关）、详情页 Kazumi 源弹窗、
 * 聚合搜索合并 Kazumi 结果。
 * 后端端点：POST /kazumi/action（与 CatVod /action 物理隔离）。
 * 播放链路：kazumi:规则名 前缀源 → kazumiResolve → captureDirect → mpv。
 *
 * 分工：kimi 负责 UI 布局/样式/交互，glm5.2 负责后端 API 与数据逻辑。
 */
/* global $, doAction, escHtml, warnToast, showLoading, hideLoading, openDialog, closeDialog, confirmDialog, Player, Detail, Favorites, HistoryView, My, App, Search, recGet, recSet, renderStatusBar, bangumiCard, fitVodTitles, bangumiCover, stripHtml, apiUrl, localCacheGet, localCacheSet, localCacheDel, _coverCache, setBangumiMirrorRoot, bangumiWebFollowMirror, SettingsSnapshot */

const Kazumi = {
    _rules: [],        // 已安装规则缓存（kazumiList 拉取）
    _rulesLoaded: false,
    _dlgToken: 0,      // 弹窗操作令牌：防过期回调（关闭后旧回调作废）
    _dlgStream: null,  // 选源弹窗 SSE 流（关闭时清理）
    _dlgState: null,   // 选源弹窗状态 {title, token, keyword, plugins, expanded}
    _inited: false,    // 事件只绑定一次；唯一入口由 app.js 在后端就绪后调用

    /**
     * 验证码视觉 LLM 请求字段（设置 → kazumiCaptchaSolve 表单的唯一汇聚点；
     * 与 Search._captchaLlmParams 同口径但独立实现——search.js 与 kazumi.js
     * 是两个互不依赖的页面模块，抽公共层反而引入加载顺序耦合）。
     * 启用且 base/model 齐全才返回字段，否则空对象。key 明文随请求传后端不落盘。
     * captchaLLMPrefer 一并带上：后端 solve 据此决定「先 LLM 还是先小模型」
     * 的识别次序（默认关=先小模型，见 kazumi/captcha.py）。
     */
    async _captchaLlmParams(settings) {
        const s = settings || (typeof SettingsSnapshot !== 'undefined'
            ? await SettingsSnapshot.get() : (await window.yuki.settingsGet()) || {});
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

    // ---------------------------------------------------------------- 规则管理（设置页）

    /** 初始化设置页 Kazumi 板块（app.js bootstrap 时调用一次）。 */
    init() {
        if (this._inited) return;
        this._inited = true;
        this._loadBgmMatchCache(); // 搜索页 Kazumi 结果封面缓存（name → Bangumi 匹配）
        // 启动时按设置自动同步 Bangumi 收藏（开关默认关；后端就绪后异步执行，不阻塞首屏）
        (async () => {
            try {
                const s = (await window.yuki.settingsGet()) || {};
                if (s.bangumiAutoSyncOnStart === true) this.syncBangumiNow().catch(() => { /* 启动自动同步失败静默 */ });
            } catch (e) { /* 读设置失败不阻塞 */ }
        })();
        $('#kazumi_bgm_cover_clear').on('click', () => this.clearBangumiCoverCache());
        $('#kazumi_rule_add').on('click', () => this.importRule());
        $('#kazumi_rule_paste').on('click', () => this.importFromClipboard());
        $('#kazumi_rule_clear').on('click', () => $('#kazumi_rule_json').val(''));
        $('#kazumi_rule_shop').on('click', () => this.openShopDialog());
        $('#kazumi_rule_editor').on('click', () => this.openEditorDialog());
        $('#kazumi_rule_check').on('click', () => this.checkValidity());
        $('#kazumi_rule_update').on('click', () => this.batchUpdate());
        // 批量管理（任务2）：入口按钮为开关（已在批量模式时再点是退出，
        // 而不是重新进入——重新进入会清空已勾选项，避免这种误操作）
        $('#kazumi_rule_batch').on('click', () => this.toggleBatchMode());
        $('#kazumi_batch_all').on('click', () => this._batchApply('all'));
        $('#kazumi_batch_invert').on('click', () => this._batchApply('invert'));
        $('#kazumi_batch_clear').on('click', () => this._batchApply('clear'));
        $('#kazumi_batch_update').on('click', () => this.batchUpdateSelected());
        $('#kazumi_batch_del').on('click', () => this.batchRemoveSelected());
        $('#kazumi_batch_exit').on('click', () => this.exitBatchMode());
        // 启动时自动检查规则更新（开关默认关）
        $('#set_kazumi_autoupdate').on('change', function () {
            window.yuki.settingsSet('kazumiAutoUpdateOnStart', this.checked);
            warnToast(this.checked ? '已开启启动时自动检查规则更新' : '已关闭启动时自动检查规则更新');
        });
        $('#kazumi_cookie_view').on('click', () => this.viewCookies());
        $('#kazumi_cookie_clear').on('click', () => this.clearCookies());
        // Bangumi 同步（需 token）
        $('#bangumi_token_save').on('click', () => this.saveBangumiToken());
        $('#bangumi_test').on('click', () => this.testBangumi());
        $('#bangumi_sync_now').on('click', () => this.syncBangumiNow());
        $('#bangumi_sync_priority').on('change', function () { window.yuki.settingsSet('bangumiSyncPriority', this.value); });
        $('#bangumi_immediate_toast').on('change', function () { window.yuki.settingsSet('bangumiImmediateSyncToastEnable', this.checked); });
        // Bangumi 自动同步开关：收藏状态变动 / 启动时
        $('#set_bangumi_autosync_status').on('change', function () {
            window.yuki.settingsSet('bangumiAutoSyncStatus', this.checked);
            warnToast(this.checked ? '已开启收藏状态自动同步到 Bangumi' : '已关闭收藏状态自动同步');
        });
        $('#set_bangumi_autosync_on_start').on('change', function () {
            window.yuki.settingsSet('bangumiAutoSyncOnStart', this.checked);
            warnToast(this.checked ? '已开启启动时自动同步 Bangumi 收藏' : '已关闭启动时自动同步');
        });
        // RM-5：看完自动上报观看进度（分集看过 + 收藏在看/看过联动）
        $('#set_bangumi_progress_sync').on('change', function () {
            window.yuki.settingsSet('bangumiProgressSync', this.checked);
            warnToast(this.checked ? '已开启看完自动上报 Bangumi 观看进度' : '已关闭观看进度自动上报');
        });
        // 弹幕（弹弹 play）凭据：回填 + 保存（保存后主进程重启后端注入环境变量）
        this._prefillDandan();
        $('#set_dandan_save').on('click', async () => {
            const appid = $('#set_dandan_appid').val().trim();
            const secret = $('#set_dandan_secret').val().trim();
            await window.yuki.settingsSet('dandanAppId', appid);
            await window.yuki.settingsSet('dandanAppSecret', secret);
            try {
                if (window.yuki.setDandan) { await window.yuki.setDandan({ appid, secret }); warnToast('弹幕凭据已保存，后端重启中…'); }
                else warnToast('弹幕凭据已保存');
            } catch (e) { warnToast('保存失败'); }
        });
        // 选源弹窗关闭时清理 SSE 流与状态（T74：避免关闭后连接挂到 done）
        $('#kazumiSourceDialog').on('click', '.md-dialog-btn', () => {
            this._onSourceDlgClosed();
        });
        // 关闭路径统一收口：Esc（dispatchEsc 直接 closeDialog，不经按钮回调）与
        // 程序化关闭（选集播放/批量下载）都观察不到上面的 click，改为观察弹窗
        // 真正隐藏（退场动画后 display:none）兜底清理，防止 EventSource 残留连接
        if (typeof document !== 'undefined' && typeof MutationObserver === 'function') {
            const dlgEl = document.getElementById('kazumiSourceDialog');
            if (dlgEl) {
                new MutationObserver(() => {
                    if (dlgEl.style.display === 'none' && !dlgEl.classList.contains('dlg-out')) this._onSourceDlgClosed();
                }).observe(dlgEl, { attributes: true, attributeFilter: ['style', 'class'] });
            }
        }
        // T71：详情页图片点击放大（复用 detail.js cover-float 全屏浮层，滚轮缩放）
        $('#detail-body').on('click', 'img', (e) => {
            // 角色卡头像点击应打开人物详情（由 detail.js 处理），不触发封面放大
            if ($(e.currentTarget).closest('.detail-char-card').length) return;
            const src = $(e.currentTarget).attr('src');
            if (src && typeof Detail !== 'undefined' && Detail._openCoverFloat) Detail._openCoverFloat(src);
        });
        this._prefillBangumiToken();
        this._prefillWebdav();
        this._prefillMirror();
        this._prefillKazumiAutoUpdate();
        // 镜像开关（4.1）：变更即应用并持久化
        $('#set_bangumi_mirror').on('change', function () {
            const on = this.checked;
            window.yuki.settingsSet('enableBangumiProxy', on);
            $('#bangumi_mirror_fields').toggle(on); // 未开镜像时收起根域名配置
            doAction('kazumiSetMirror', { bangumi: on ? '1' : '0' }, '/kazumi/action').catch(() => { });
        });
        $('#set_git_mirror').on('change', function () {
            const on = this.checked;
            window.yuki.settingsSet('enableGitProxy', on);
            doAction('kazumiSetMirror', { git: on ? '1' : '0' }, '/kazumi/action').catch(() => { });
        });
        // 「↗ Bangumi 页」条目页跳转跟随镜像：纯渲染层跳转目标选择，不经后端。
        // 开启后 detail.js 点击按钮走 bangumiWebUrl → bgm.{镜像根域名}（镜像根域名
        // 变更即时生效）；关闭始终官方 bgm.tv（镜像站与官方登录态不互通）。
        $('#set_bangumi_web_mirror').on('change', function () {
            bangumiWebFollowMirror = this.checked;
            window.yuki.settingsSet('enableBangumiWebMirror', bangumiWebFollowMirror);
        });
        // 手动替换 Bangumi 镜像根域名（镜像站域名失效时救急）：归一化校验后
        // 存 settings + 更新 common.js 全局（封面兜底链即时生效）+ 同步后端；
        // 清空保存视为恢复默认 bangumi.vip，非法格式报错并保持原值
        $('#set_bangumi_mirror_root_save').on('click', async () => {
            const raw = $('#set_bangumi_mirror_root').val().trim();
            const norm = raw ? setBangumiMirrorRoot(raw) : setBangumiMirrorRoot('bangumi.vip');
            if (!norm) { warnToast('镜像域名格式不正确（示例：bangumi.vip）'); return; }
            $('#set_bangumi_mirror_root').val(norm);
            window.yuki.settingsSet('bangumiMirrorRoot', norm);
            const rsp = await doAction('kazumiSetMirror', { root: norm }, '/kazumi/action').catch(() => null);
            if (rsp && rsp.code === 200) warnToast(`Bangumi 镜像域名已保存：${norm}（api.bgm.tv → api.${norm}）`);
            else warnToast('镜像域名保存失败：后端不可达或域名格式不正确');
        });
        // ---- 规则行交互（删除/编辑/启停/手动排序/拖拽/批量勾选）----
        // 批量模式下这些按钮在渲染时就带 disabled（视觉禁用），这里再按状态兜底：
        // 键盘可达路径（Enter）与渲染竞态下的点击都不会误触删除/启停/排序
        $('#kazumi_rule_list').on('click', '.kazumi-rule-del', (e) => {
            if (this._batchMode) return;
            const name = String($(e.currentTarget).data('name') || '');
            if (name) this.removeRule(name);
        });
        $('#kazumi_rule_list').on('click', '.kazumi-rule-edit', (e) => {
            if (this._batchMode) return;
            const name = String($(e.currentTarget).data('name') || '');
            if (name) this.openEditorDialog(name);
        });
        $('#kazumi_rule_list').on('change', '.kazumi-rule-toggle', (e) => {
            if (this._batchMode) return;
            const name = String($(e.currentTarget).data('name') || '');
            const enabled = !!e.currentTarget.checked;
            if (name) this.toggleRule(name, enabled);
        });
        // 批量勾选：只认原生复选框（卡片本体不绑定 click，避免点空白区误选）
        $('#kazumi_rule_list').on('change', '.kazumi-rule-checkbox', (e) => {
            this._batchCheckboxChanged(e.currentTarget);
        });
        // 手动排序（2.5，仿 Kazumi ReorderableListView）：上移/下移按钮 + 拖拽。
        // 上移/下移保留为键盘/无鼠标场景的排序通道，与拖拽共用同一顺序计算与保存通道
        $('#kazumi_rule_list').on('click', '.kazumi-rule-move', (e) => {
            if (this._batchMode) return;
            const name = String($(e.currentTarget).data('name') || '');
            const dir = parseInt($(e.currentTarget).data('dir'), 10) || 0;
            if (name && dir) this.moveRule(name, dir);
        });
        // 拖拽排序：dragover/drop 委托在容器（不是行）上——只有容器能覆盖
        // 「行间空隙 / 最后一行下方 / 列表空白区」这些落点；插入位置用行上的
        // before/after 类画指示线，不插占位节点（避免拖拽期 flex 重排抖动）
        $('#kazumi_rule_list')
            .on('dragstart', '.kazumi-rule-row', (e) => {
                if (this._batchMode) { e.preventDefault(); return; } // 批量模式禁用拖拽
                const name = String($(e.currentTarget).data('name') || '');
                if (!name) { e.preventDefault(); return; }
                this._dragName = name;
                const dt = (e.originalEvent || e).dataTransfer;
                if (dt) {
                    try {
                        dt.effectAllowed = 'move';
                        dt.setData('text/plain', name); // Firefox/部分环境不设数据不启动拖拽
                    } catch (err) { /* dataTransfer 只读环境（测试桩）忽略 */ }
                }
                // 半透明/浮起视觉延后一帧再加类：Chromium 在 dragstart 同步改样式会把
                // 拖拽影子一起拍成半透明（拖起来像没抓到手）
                const row = e.currentTarget;
                this._dragTimer = setTimeout(() => $(row).addClass('dragging'), 0);
            })
            .on('dragover', (e) => {
                if (!this._dragName || this._batchMode) return;
                e.preventDefault(); // 不 preventDefault 不会触发 drop
                const dt = (e.originalEvent || e).dataTransfer;
                if (dt) { try { dt.dropEffect = 'move'; } catch (err) { /* ignore */ } }
                this._updateDropIndicator(this._dropGapFromEvent(e));
            })
            .on('drop', (e) => {
                if (!this._dragName || this._batchMode) return;
                e.preventDefault();
                const dragName = this._dragName;
                const gap = this._dropGapFromEvent(e);
                this._endDragVisual();
                this.dropRuleAt(dragName, gap);
            })
            .on('dragleave', (e) => {
                // 拖出列表时清掉指示线；relatedTarget 仍在列表内（行与行之间移动，
                // 容器边界不真正离开）不清，否则指示线会随鼠标在行间闪烁
                const to = (e.originalEvent && e.originalEvent.relatedTarget) || null;
                const host = document.getElementById('kazumi_rule_list');
                if (to && host && host.contains(to)) return;
                this._updateDropIndicator(null);
            })
            .on('dragend', '.kazumi-rule-row', () => this._endDragVisual());
        // WebDAV 同步（3.2 对齐 Kazumi：主开关 + 子开关 + 保存/测试/同步/恢复）
        $('#webdav_sync').on('click', () => this.webdavSyncUI());
        $('#webdav_restore').on('click', () => this.webdavRestoreUI());
        $('#webdav_test').on('click', () => this.webdavTestUI());
        $('#webdav_save').on('click', () => this.webdavSaveUI());
        $('#webdav_enable').on('change', function () {
            const on = this.checked;
            window.yuki.settingsSet('webDavEnable', on);
            $('#webdav_fields').toggle(on); // 主开关关闭时收起全部子开关与配置表单
            if (!on) {
                $('#webdav_enable_history').prop('checked', false);
                $('#webdav_enable_collect').prop('checked', false);
                $('#webdav_enable_settings').prop('checked', false);
                $('#webdav_enable_stats').prop('checked', false);
                $('#webdav_enable_rules').prop('checked', false);
                $('#webdav_auto_enable').prop('checked', false);
                $('#webdav_startup_pull').prop('checked', false);
                $('#webdav_auto_fields').hide(); // 联动关闭定时同步时一并收起间隔选择
                window.yuki.settingsSet('webDavEnableHistory', false);
                window.yuki.settingsSet('webDavEnableCollect', false);
                window.yuki.settingsSet('webDavEnableSettings', false);
                window.yuki.settingsSet('webDavEnableStats', false);
                window.yuki.settingsSet('webDavEnableRules', false);
                window.yuki.settingsSet('webDavAutoEnable', false);
                window.yuki.settingsSet('webDavStartupPull', false);
            } else {
                // 重开主开关（或首次启用）：子开关此刻必然全灭——关闭时被清空、新装时静态
                // 标记也没有 checked——用户会落进"已启用但没有任何同步内容"的死角：
                // 点同步只得到「未选择任何内容」，看起来像功能坏了。启用即补一份可用默认：
                // 五项**内容**全选并落盘；自动同步/启动恢复属自动化行为，仍留给用户显式开启
                // （不替他决定定时与启动即拉取）。只在"全都没选"时兜底，不覆盖已有选择。
                const hasAny = $('#webdav_enable_history').prop('checked')
                    || $('#webdav_enable_collect').prop('checked')
                    || $('#webdav_enable_settings').prop('checked')
                    || $('#webdav_enable_stats').prop('checked')
                    || $('#webdav_enable_rules').prop('checked');
                if (!hasAny) {
                    const contentKeys = [
                        ['#webdav_enable_history', 'webDavEnableHistory'],
                        ['#webdav_enable_collect', 'webDavEnableCollect'],
                        ['#webdav_enable_settings', 'webDavEnableSettings'],
                        ['#webdav_enable_stats', 'webDavEnableStats'],
                        ['#webdav_enable_rules', 'webDavEnableRules'],
                    ];
                    for (const [sel, key] of contentKeys) {
                        $(sel).prop('checked', true);
                        window.yuki.settingsSet(key, true);
                    }
                }
            }
            Kazumi.scheduleWebdavAutoSync(); // 主开关关闭联动停表，重开恢复调度
        });
        $('#webdav_enable_history').on('change', function () { window.yuki.settingsSet('webDavEnableHistory', this.checked); });
        $('#webdav_enable_collect').on('change', function () { window.yuki.settingsSet('webDavEnableCollect', this.checked); });
        $('#webdav_enable_settings').on('change', function () { window.yuki.settingsSet('webDavEnableSettings', this.checked); });
        $('#webdav_enable_stats').on('change', function () { window.yuki.settingsSet('webDavEnableStats', this.checked); });
        $('#webdav_enable_rules').on('change', function () { window.yuki.settingsSet('webDavEnableRules', this.checked); });
        $('#webdav_ssl_skip').on('change', function () { window.yuki.settingsSet('webDavSslSkip', this.checked); });
        $('#webdav_startup_pull').on('change', function () { window.yuki.settingsSet('webDavStartupPull', this.checked); });
        // 密码显隐：type=password ⇄ text（与网盘 Cookie 眼睛按钮同款交互）
        $('#webdav_pwd_eye').on('click', function () {
            const $p = $('#webdav_password');
            const show = $p.attr('type') === 'password';
            $p.attr('type', show ? 'text' : 'password');
            this.textContent = show ? '🙈' : '👁️';
        });
        // Bangumi Token 显隐：与 WebDAV 密码框同款猴子/眼镜切换。
        // review01 L23：初始态按密文相位把图标校准为 👁️（与 #webdav_pwd_eye 初始值
        // 同相位）——index.html 里误写初始 🙈，导致首次点击（切明文）图标零变化；
        // 点击处理本身按 input type 实时推算相位，无需改动。
        $('#bangumi_token_eye').text('👁️');
        $('#bangumi_token_eye').on('click', function () {
            const $p = $('#bangumi_token');
            const show = $p.attr('type') === 'password';
            $p.attr('type', show ? 'text' : 'password');
            this.textContent = show ? '🙈' : '👁️';
        });
        // 定时自动同步：开关/间隔变更即时重排调度（无需重启）
        $('#webdav_auto_enable').on('change', function () {
            window.yuki.settingsSet('webDavAutoEnable', this.checked);
            $('#webdav_auto_fields').toggle(this.checked); // 未开启定时同步时收起间隔与状态行
            Kazumi.scheduleWebdavAutoSync();
        });
        $('#webdav_auto_interval').on('change', function () {
            window.yuki.settingsSet('webDavAutoMinutes', parseInt(this.value, 10) || 60);
            Kazumi.scheduleWebdavAutoSync();
        });
        this.refreshRuleList();
        this.scheduleWebdavAutoSync(); // 启动即挂载定时同步（内部读持久化设置决定是否生效）
        this.scheduleWebdavStartupPull(); // 启动拉取：延迟静默执行，开关未开则空转
    },

    /** 拉取规则列表并渲染。 */
    async refreshRuleList() {
        try {
            const rsp = await doAction('kazumiList', {}, '/kazumi/action');
            this._rules = (rsp && rsp.list) || [];
            this._rulesLoaded = true;
        } catch (e) {
            this._rules = [];
            this._rulesLoaded = false;
        }
        this._renderRuleList();
    },

    _renderRuleList() {
        const box = $('#kazumi_rule_list');
        $('#kazumi_rule_count').text(this._rules.length);
        const batch = !!this._batchMode;
        box.toggleClass('batch-mode', batch);
        // 整表重渲意味着行节点被替换：拖拽中的 from 索引随之失效（列表可能已被
        // 检测/更新/增删改过），此处直接作废本次拖拽——drop 会静默放弃，
        // 不会用旧索引把规则挪错位（宁可不排序，也不产生重复/丢失）
        if (this._dragName) this._endDragVisual();
        // 选集与当前列表求交后再渲染：检测/更新/删除完成都会走到这里，被删掉的
        // 规则不能留在选中集里，否则「已选 N 项」是假的、批量操作会对着不存在的
        // 名字发请求
        if (batch) this._batchSel = this._batchReconcile(this._batchSel, this._rules.map((r) => r.name));
        this._renderBatchBar();
        if (!this._rules.length) {
            box.html('<div class="tip-line">尚未导入任何 Kazumi 规则。</div>');
            return;
        }
        box.html(this._rules.map((r) => {
            const name = String(r.name || '');
            const validInfo = this._validityLabel(r.validity);
            const times = [r.installed_at ? '安装 ' + r.installed_at : '',
                           r.updated_at && r.updated_at !== r.installed_at ? '更新 ' + r.updated_at : '']
                .filter(Boolean).join(' · ');
            // 源网站（任务3）：优先自带来源，其次 referer，最后站点 URL 的域名
            const src = this._ruleSourceLabel(r);
            const checked = batch && this._batchSel.has(name);
            const dis = batch ? ' disabled' : ''; // 批量模式下卡片按钮禁用，勾选不会误触
            return `
            <div class="history-item kazumi-rule-row${checked ? ' kazumi-rule-checked' : ''}" draggable="${batch ? 'false' : 'true'}" data-name="${escHtml(name)}">
                ${batch ? `<label class="kazumi-rule-check" title="选择该规则">
                    <input type="checkbox" class="kazumi-rule-checkbox" data-name="${escHtml(name)}"${checked ? ' checked' : ''}>
                </label>` : ''}
                <button class="history-btn kazumi-rule-move" data-name="${escHtml(name)}" data-dir="-1" title="上移"${dis}>↑</button>
                <button class="history-btn kazumi-rule-move" data-name="${escHtml(name)}" data-dir="1" title="下移"${dis}>↓</button>
                <div class="kazumi-rule-main">
                    <span class="kazumi-rule-name" title="${escHtml(name)} v${escHtml(r.version || '')}">${escHtml(name)} <span class="kazumi-subver">v${escHtml(r.version || '')}</span></span>
                    ${src ? `<span class="kazumi-rule-source" title="来源：${escHtml(src.title)}">来源 ${escHtml(src.text)}</span>` : ''}
                    ${times ? `<span class="kazumi-rule-times">${escHtml(times)}</span>` : ''}
                </div>
                ${validInfo ? `<span class="kazumi-validity ${validInfo.cls}" title="${escHtml(validInfo.label)}">${escHtml(validInfo.label)}</span>` : ''}
                <button class="history-btn kazumi-rule-edit" data-name="${escHtml(name)}" title="编辑规则"${dis}>✎</button>
                <label class="md-switch">
                    <input type="checkbox" class="kazumi-rule-toggle" data-name="${escHtml(name)}" ${r.enabled !== false ? 'checked' : ''}${dis}>
                    <span class="md-switch-track"></span>
                </label>
                <button class="history-btn kazumi-rule-del" data-name="${escHtml(name)}" title="删除该规则"${dis}>✕</button>
            </div>`;
        }).join(''));
    },

    // ---------------------------------------------------------------- 排序 / 来源 / 批量选择纯函数
    // （排序、域名提取、批量选择三处状态计算都做成纯函数：边界只有一处定义，可单测）

    /**
     * 数组移动（插入语义：结果中该元素位于索引 to）。to 越界夹到 [0, n-1]；
     * from 越界/非整数、from === to、非数组输入都返回原列表浅拷贝（无副作用）。
     * 上移/下移与拖拽落位共用，保证「拖到自己/越界」在任何路径下都安全。
     */
    _moveItem(list, from, to) {
        const arr = Array.isArray(list) ? list.slice() : [];
        if (!Number.isInteger(from) || !Number.isInteger(to)) return arr;
        if (from < 0 || from >= arr.length) return arr;
        const dst = Math.max(0, Math.min(arr.length - 1, to));
        if (dst === from) return arr;
        const [moved] = arr.splice(from, 1);
        arr.splice(dst, 0, moved);
        return arr;
    },

    /**
     * 拖拽落点间隙（几何纯函数）：gap = 指针位于多少行「中线」之下，取值 0..n，
     * gap===n 表示落在最后一行下方（列表末尾）。
     * rects[i] 取 {top, height}；无效项跳过。指针非法或全部矩形非法返回 null，
     * 调用方放弃落位——宁可不排序，也不用坏索引打乱顺序。
     */
    _dropGapFromRects(rects, y) {
        const list = Array.isArray(rects) ? rects : [];
        const py = Number(y);
        if (!Number.isFinite(py)) return null;
        let gap = 0;
        let valid = 0;
        for (const r of list) {
            if (!r || !Number.isFinite(Number(r.top)) || !Number.isFinite(Number(r.height))) continue;
            valid++;
            if (py > Number(r.top) + Number(r.height) / 2) gap++;
        }
        if (!valid && list.length) return null;
        return gap;
    },

    /**
     * 落点间隙 → 移动目标索引：移除 from 会使其后的间隙整体左移一格
     * （gap > from ⇒ gap-1），gap ≤ from 时目标即 gap（含 gap===from 的原地落位）。
     * from 非法（拖拽期间规则已被删/列表已刷新）返回 -1，调用方放弃。
     */
    _dropTargetIndex(from, gap, length) {
        const n = Number.isInteger(length) && length > 0 ? length : 0;
        if (!n || !Number.isInteger(from) || from < 0 || from >= n) return -1;
        const g = Math.max(0, Math.min(n, Number.isInteger(gap) ? gap : from));
        return g > from ? g - 1 : g;
    },

    /** 是否为同一规则集合的排列（长度 + 名称多重集一致），防竞态下丢/重规则。 */
    _sameRuleSet(a, b) {
        const x = Array.isArray(a) ? a : [];
        const y = Array.isArray(b) ? b : [];
        if (x.length !== y.length) return false;
        const key = (r) => String((r && r.name) || '');
        const sx = x.map(key).sort();
        const sy = y.map(key).sort();
        return sx.every((v, i) => v === sy[i]);
    },

    /**
     * 从 URL 文本提取站点主机名（纯函数）：支持完整 URL / 协议相对 //host /
     * 无协议 host/path、带端口、认证信息、路径、查询、片段、占位符（{keyword}）。
     * 仅 http/https（或无协议）视为合法站点；其它 scheme（javascript:/data:/
     * mailto: 等）与非域名（含空格、非法字符、缺域名点）返回 ''——宁可不显示，
     * 也不用垃圾文本占卡片。去 www. 前缀并统一小写，便于卡片紧凑展示。
     * 已知限制：中文等非 ASCII 域名（需 punycode）与 IPv6 字面量不识别。
     */
    _extractHost(raw) {
        const s = String(raw == null ? '' : raw).trim();
        if (!s) return '';
        // scheme 判定分两层：
        // 1) `scheme://` 形态只有 http/https 可视作站点，其余（thunder:// 等）拒绝；
        // 2) 无 `//` 时冒号通常不是协议——`host:8080`（端口）与 `user:pw@host`（凭据）
        //    都是合法无协议写法，只有「冒号后既非数字、又不含 @」的形态才按未知
        //    scheme 拒绝（javascript:alert(1) / data:text/... / about:blank 等）；
        // 3) 带 @ 的形态里再显式拒绝已知非站点 scheme（mailto:a@b.com 会被
        //    「凭据」规则误读成 b.com）。未知 scheme + @ 仍可能被误读，但输入来自
        //    规则字段（baseURL/referer），出错只影响展示文本。
        const withSlashes = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
        if (withSlashes && !/^https?$/i.test(withSlashes[1])) return '';
        const bare = /^([a-z][a-z0-9+.-]*):([^/]*)/i.exec(s);
        if (!withSlashes && bare) {
            const after = bare[2];
            if (!/^\d/.test(after) && !after.includes('@')) return '';
            if (after.includes('@') && /^(javascript|data|mailto|tel|file|about|blob|chrome|view-source|ftp|ws|wss|magnet|thunder|ed2k|smb|ssh|sftp|irc|urn|intent)$/i.test(bare[1])) return '';
        }
        let rest = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/\//, '');
        rest = rest.split(/[/?#]/)[0];      // 去路径/查询/片段（{keyword} 占位符随之丢弃）
        rest = rest.split('@').pop() || ''; // 去 user:pass@
        rest = rest.replace(/:\d+$/, '');   // 去端口
        rest = rest.replace(/^www\./i, '');
        rest = rest.toLowerCase();
        if (rest === 'localhost') return rest;
        if (rest.length > 253) return '';
        return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(rest) ? rest : '';
    },

    /**
     * 规则卡片「源网站」展示值（纯函数）：自带来源 → referer → 站点 URL
     * （baseURL、searchURL）取域名；全缺/非法返回 null（卡片不渲染该行）。
     * 字段可用性（已核实后端 kazumi/plugin_manager.list_all）：list 只回
     * name/version/enabled/api/baseURL/searchURL/installed_at/updated_at/validity，
     * 既无 source/homepage 也无 referer——所以现阶段实际展示 baseURL 域名；
     * 后端将来补字段时无需改前端即可自动优先展示（见报告「需 lead 协调」）。
     */
    _ruleSourceLabel(rule) {
        const r = rule || {};
        const rawSource = r.source;
        const text = (typeof rawSource === 'string' || typeof rawSource === 'number')
            ? String(rawSource).trim() : '';
        if (text) {
            // 自带来源可能是任意文本（非 URL），原样展示并整串放进 title
            return { text: text.length > 80 ? text.slice(0, 80) + '…' : text, title: text, from: 'source' };
        }
        const homepage = String(r.homepage || r.homePage || '').trim();
        if (homepage) {
            const host = this._extractHost(homepage);
            if (host) return { text: host, title: homepage, from: 'homepage' };
        }
        const referer = String(r.referer || '').trim();
        if (referer) {
            const host = this._extractHost(referer);
            if (host) return { text: host, title: referer, from: 'referer' };
        }
        for (const field of ['baseURL', 'searchURL']) {
            const value = String(r[field] || '').trim();
            if (!value) continue;
            const host = this._extractHost(value);
            if (host) return { text: host, title: value, from: field };
        }
        return null;
    },

    /**
     * 批量选择集合运算（纯函数）：reconcile 把选集收窄到当前仍存在的名称，
     * 列表刷新/规则被删后不残留幽灵选中项。Set 比较在下游只做 has/forEach，
     * 因此这里统一返回新 Set（不改入参）。
     */
    _batchReconcile(selected, names) {
        const universe = new Set((Array.isArray(names) ? names : []).map((n) => String(n || '')));
        const out = new Set();
        if (selected && typeof selected.forEach === 'function') {
            selected.forEach((n) => { const key = String(n == null ? '' : n); if (key && universe.has(key)) out.add(key); });
        }
        return out;
    },

    /** 选集开关一项（纯函数，返回新集合；空名称忽略）。 */
    _batchToggle(selected, name, on) {
        const out = new Set();
        if (selected && typeof selected.forEach === 'function') selected.forEach((n) => out.add(String(n == null ? '' : n)));
        const key = String(name == null ? '' : name);
        if (!key) return out;
        if (on === false) out.delete(key);
        else out.add(key);
        return out;
    },

    /** 反选（纯函数，返回新集合）：以当前列表为全集，未选中的选中、已选中的取消。 */
    _batchInvert(selected, names) {
        const universe = new Set((Array.isArray(names) ? names : []).map((n) => String(n || '')));
        const picked = (selected && typeof selected.has === 'function') ? selected : new Set();
        const out = new Set();
        universe.forEach((n) => { if (!picked.has(n)) out.add(n); });
        return out;
    },

    /** 有效性徽标：unknown 不显示，valid 绿，invalid 红，captcha 橙。 */
    _validityLabel(validity) {
        if (!validity || validity === 'unknown') return null;
        const map = {
            valid: { label: '有效', cls: 'kazumi-validity-valid' },
            invalid: { label: '失效', cls: 'kazumi-validity-invalid' },
            captcha: { label: '需验证', cls: 'kazumi-validity-captcha' },
        };
        return map[validity] || null;
    },

    /** 导入规则：解析 JSON 或 kazumi:// 链接，校验后调 kazumiAdd。 */
    async importRule() {
        const raw = $('#kazumi_rule_json').val().trim();
        if (!raw) { warnToast('请粘贴规则 JSON 或 kazumi:// 链接'); return; }
        let json = raw;
        if (raw.startsWith('kazumi://')) {
            try {
                json = atob(raw.slice(9));
            } catch (e) { warnToast('kazumi:// 链接解码失败'); return; }
        }
        let rule;
        try { rule = JSON.parse(json); } catch (e) { warnToast('JSON 解析失败，请检查规则内容'); return; }
        // 前端基础校验（glm5.2 后端还有完整校验）
        if (!rule.name || !String(rule.name).trim()) { warnToast('规则缺少 name 字段'); return; }
        if (parseInt(rule.api, 10) > 8) { warnToast('规则 API 版本过高（当前支持小于等于 8）'); return; }
        showLoading();
        try {
            const rsp = await doAction('kazumiAdd', { json: JSON.stringify(rule) }, '/kazumi/action');
            hideLoading();
            if (rsp && rsp.code === 200) {
                warnToast(`规则「${rule.name}」导入成功`);
                $('#kazumi_rule_json').val('');
                this.refreshRuleList();
            } else {
                warnToast('导入失败：' + ((rsp && rsp.msg) || '未知错误'));
            }
        } catch (e) {
            hideLoading();
            warnToast('导入失败');
        }
    },

    /** 从剪贴板导入。 */
    async importFromClipboard() {
        try {
            const text = await navigator.clipboard.readText();
            if (text) $('#kazumi_rule_json').val(text);
            this.importRule();
        } catch (e) { warnToast('读取剪贴板失败'); }
    },

    // ---------------------------------------------------------------- 规则编辑器

    /** 打开规则编辑器弹窗（新建或编辑现有规则）。 */
    async openEditorDialog(ruleName) {
        let rule = null;
        if (ruleName) {
            // 编辑现有规则。L-27：后端异常给出提示并中止——原先裸 await 抛错
            // 导致编辑弹窗静默打不开
            let rsp = null;
            try {
                rsp = await doAction('kazumiList', {}, '/kazumi/action');
            } catch (e) {
                warnToast('规则列表读取失败，请检查后端服务');
                return;
            }
            const list = (rsp && rsp.list) || [];
            const item = list.find((r) => r.name === ruleName);
            if (item) {
                // 拉取完整规则 JSON
                try {
                    const full = await doAction('kazumiGet', { name: ruleName }, '/kazumi/action');
                    rule = (full && full.rule) || null;
                } catch (e) { /* 取详情失败用基础信息 */ }
            }
        }
        this._renderEditor(rule);
        openDialog('kazumiEditorDialog');
    },

    _renderEditor(rule) {
        const isNew = !rule;
        rule = rule || {
            api: '8', type: 'anime', name: '', version: '1.0',
            muliSources: true, useWebview: true, useNativePlayer: true,
            usePost: false, useLegacyParser: false, adBlocker: false,
            userAgent: '', baseURL: '', searchURL: '',
            searchList: '', searchName: '', searchResult: '',
            chapterRoads: '', chapterResult: '', referer: '',
            searchMode: 'xpath', chapterMode: 'xpath',
            searchApiConfig: {}, chapterApiConfig: {},
            antiCrawlerConfig: {}, enabled: true,
        };
        $('#kazumi-editor-title').text(isNew ? '新建规则' : `编辑规则 · ${rule.name}`);
        // 填充表单
        $('#editor_name').val(rule.name);
        $('#editor_version').val(rule.version);
        $('#editor_baseURL').val(rule.baseURL);
        $('#editor_searchURL').val(rule.searchURL);
        $('#editor_searchList').val(rule.searchList);
        $('#editor_searchName').val(rule.searchName);
        $('#editor_searchResult').val(rule.searchResult);
        $('#editor_chapterRoads').val(rule.chapterRoads);
        $('#editor_chapterResult').val(rule.chapterResult);
        $('#editor_referer').val(rule.referer);
        $('#editor_userAgent').val(rule.userAgent);
        $('#editor_searchMode').val(rule.searchMode || 'xpath');
        $('#editor_chapterMode').val(rule.chapterMode || 'xpath');
        $('#editor_usePost').prop('checked', !!rule.usePost);
        $('#editor_useLegacyParser').prop('checked', !!rule.useLegacyParser);
        $('#editor_adBlocker').prop('checked', !!rule.adBlocker);
        // 绑定保存/测试
        $('#kazumi-editor-save').off('click').on('click', () => this.saveEditorRule(isNew));
        $('#kazumi-editor-test').off('click').on('click', () => this.testEditorRule());
    },

    _collectEditorRule() {
        return {
            api: '8',
            type: 'anime',
            name: $('#editor_name').val().trim(),
            version: $('#editor_version').val().trim() || '1.0',
            muliSources: true,
            useWebview: true,
            useNativePlayer: true,
            usePost: $('#editor_usePost').prop('checked'),
            useLegacyParser: $('#editor_useLegacyParser').prop('checked'),
            adBlocker: $('#editor_adBlocker').prop('checked'),
            userAgent: $('#editor_userAgent').val().trim(),
            baseURL: $('#editor_baseURL').val().trim(),
            searchURL: $('#editor_searchURL').val().trim(),
            searchList: $('#editor_searchList').val().trim(),
            searchName: $('#editor_searchName').val().trim(),
            searchResult: $('#editor_searchResult').val().trim(),
            chapterRoads: $('#editor_chapterRoads').val().trim(),
            chapterResult: $('#editor_chapterResult').val().trim(),
            referer: $('#editor_referer').val().trim(),
            searchMode: $('#editor_searchMode').val(),
            chapterMode: $('#editor_chapterMode').val(),
            searchApiConfig: {},
            chapterApiConfig: {},
            antiCrawlerConfig: {},
            enabled: true,
        };
    },

    async saveEditorRule(isNew) {
        const rule = this._collectEditorRule();
        if (!rule.name) { warnToast('规则名称不能为空'); return; }
        showLoading();
        try {
            const rsp = await doAction('kazumiAdd', { json: JSON.stringify(rule) }, '/kazumi/action');
            hideLoading();
            if (rsp && rsp.code === 200) {
                warnToast(`规则「${rule.name}」${isNew ? '创建' : '保存'}成功`);
                closeDialog('kazumiEditorDialog');
                this.refreshRuleList();
            } else {
                warnToast('保存失败：' + ((rsp && rsp.msg) || '未知错误'));
            }
        } catch (e) {
            hideLoading();
            warnToast('保存失败');
        }
    },

    async testEditorRule() {
        const rule = this._collectEditorRule();
        if (!rule.name) { warnToast('规则名称不能为空'); return; }
        const keyword = $('#editor_test_keyword').val().trim() || '测试';
        showLoading();
        try {
            // 先临时保存再测试
            await doAction('kazumiAdd', { json: JSON.stringify(rule) }, '/kazumi/action');
            const rsp = await doAction('kazumiSearch', { keyword }, '/kazumi/action');
            hideLoading();
            const results = (rsp && rsp.results) || [];
            const myResult = results.find((r) => r.pluginName === rule.name);
            if (myResult && myResult.data && myResult.data.length) {
                warnToast(`测试成功：找到 ${myResult.data.length} 条结果`);
            } else if (myResult && myResult.captcha) {
                warnToast('测试：该源需要验证码验证');
            } else {
                warnToast('测试：未找到结果（请检查规则或关键字）');
            }
        } catch (e) {
            hideLoading();
            warnToast('测试失败');
        }
    },

    // ---------------------------------------------------------------- 在线规则商店

    /** 规则商店 catalog 缓存（避免安装后重复拉取） */
    _shopCatalog: null,

    /** 打开规则商店弹窗。 */
    async openShopDialog() {
        openDialog('kazumiShopDialog');
        $('#kazumi-shop-body').html('<div class="tip-line">正在加载规则商店…</div>');
        try {
            // 有缓存且未过期（5 分钟）则直接用
            if (this._shopCatalog && this._shopCatalog._ts && Date.now() - this._shopCatalog._ts < 300000) {
                this._renderShopCatalog(this._shopCatalog);
                return;
            }
            const rsp = await doAction('kazumiShopCatalog', {}, '/kazumi/action');
            const catalog = (rsp && rsp.catalog) || [];
            if (!catalog.length) {
                $('#kazumi-shop-body').html('<div class="tip-line">规则商店为空或加载失败</div>');
                return;
            }
            catalog._ts = Date.now();
            this._shopCatalog = catalog;
            this._renderShopCatalog(catalog);
        } catch (e) {
            $('#kazumi-shop-body').html('<div class="tip-line">规则商店加载失败</div>');
        }
    },

    _renderShopCatalog(catalog) {
        const box = $('#kazumi-shop-body');
        const installed = new Set(this._rules.map((r) => r.name.toLowerCase()));
        const items = Array.isArray(catalog) ? catalog : (catalog.items || []);
        box.html(items.map((item) => {
            const name = item.name || '';
            const version = item.version || '';
            const isInstalled = installed.has(name.toLowerCase());
            return `<div class="kazumi-shop-item" data-name="${escHtml(name)}">
                <div class="kazumi-shop-info">
                    <div class="kazumi-shop-name">${escHtml(name)} <span style="color:var(--md-on-surface-variant);font-size:11px">v${escHtml(version)}</span></div>
                    <div class="kazumi-shop-desc">${escHtml(item.description || item.baseURL || '')}</div>
                </div>
                <button class="md-btn md-btn-tonal md-btn-sm kazumi-shop-install" data-name="${escHtml(name)}" ${isInstalled ? 'disabled' : ''}>
                    ${isInstalled ? '已安装' : '安装'}
                </button>
            </div>`;
        }).join(''));
        box.find('.kazumi-shop-install').on('click', async (e) => {
            const name = String($(e.currentTarget).data('name') || '');
            if (!name) return;
            showLoading();
            try {
                const rsp = await doAction('kazumiShopInstall', { name }, '/kazumi/action');
                hideLoading();
                if (rsp && rsp.code === 200) {
                    warnToast(`规则「${name}」安装成功`);
                    await this.refreshRuleList();
                    // 仅刷新安装按钮状态，不重新拉 catalog
                    $(e.currentTarget).text('已安装').prop('disabled', true);
                } else {
                    warnToast('安装失败：' + ((rsp && rsp.msg) || '未知错误'));
                }
            } catch (e2) {
                hideLoading();
                warnToast('安装失败');
            }
        });
    },

    /** 删除规则（confirmDialog 二次确认）。 */
    async removeRule(name) {
        if (!await confirmDialog(`删除规则「${name}」？`, { okText: '删除' })) return;
        const r = await this._removeRuleDirect(name);
        if (r.ok) {
            warnToast('已删除');
            this.refreshRuleList();
        } else {
            warnToast('删除失败：' + r.msg);
        }
    },

    /**
     * 单条删除通道（不含确认框）：单条删除与批量删除共用同一后端调用，
     * 批量场景由调用方先做一次「删除 N 条」的二次确认。后端 kazumiRemove
     * 每次只接受一个 name，故批量删除按最小请求数语义逐条串行调用。
     */
    async _removeRuleDirect(name) {
        try {
            const rsp = await doAction('kazumiRemove', { name }, '/kazumi/action');
            if (rsp && rsp.code === 200) return { ok: true, msg: '' };
            return { ok: false, msg: (rsp && rsp.msg) || '未知错误' };
        } catch (e) { return { ok: false, msg: '请求失败' }; }
    },

    /** 启用/禁用规则。 */
    async toggleRule(name, enabled) {
        try {
            const rsp = await doAction('kazumiToggle', { name, enabled: enabled ? '1' : '0' }, '/kazumi/action');
            if (rsp && rsp.code === 200) {
                warnToast(enabled ? `已启用「${name}」` : `已禁用「${name}」`);
            } else {
                warnToast('操作失败');
                this.refreshRuleList(); // 失败回滚 UI
            }
        } catch (e) {
            warnToast('操作失败');
            this.refreshRuleList();
        }
    },

    /** 上移/下移一条规则（步长 dir；顺序计算走 _moveItem，2.5）。 */
    async moveRule(name, dir) {
        const idx = this._rules.findIndex((r) => r.name === name);
        const to = idx + (parseInt(dir, 10) || 0);
        // 首/尾越界直接返回（不产生请求），与手动拖到列表首尾是同一条边界口径
        if (idx < 0 || to < 0 || to >= this._rules.length) return;
        await this._applyRuleOrder(this._moveItem(this._rules, idx, to));
    },

    /** 读取列表行几何（顺序即渲染顺序，与 _rules 一致）。 */
    _dragRowRects() {
        const rects = [];
        $('#kazumi_rule_list .kazumi-rule-row').each(function () {
            const r = this.getBoundingClientRect ? this.getBoundingClientRect() : null;
            rects.push(r ? { top: r.top, height: r.height } : null);
        });
        return rects;
    },

    /** 由拖拽事件取落点间隙（DOM 几何 + 指针 Y 交给纯函数算）。 */
    _dropGapFromEvent(e) {
        const oe = (e && e.originalEvent) || e || {};
        return this._dropGapFromRects(this._dragRowRects(), Number(oe.clientY));
    },

    /** 插入位置指示线：gap 落在第 g 行上方；gap===n 画在最后一行下方。 */
    _updateDropIndicator(gap) {
        const rows = $('#kazumi_rule_list .kazumi-rule-row');
        if (gap === null || gap === undefined) { rows.removeClass('kazumi-drop-before kazumi-drop-after'); this._dropGap = null; return; }
        if (gap === this._dropGap) return; // dragover 高频触发，落点没变就不动 DOM
        this._dropGap = gap;
        rows.removeClass('kazumi-drop-before kazumi-drop-after');
        if (!rows.length) return;
        if (gap >= rows.length) rows.eq(rows.length - 1).addClass('kazumi-drop-after');
        else rows.eq(gap).addClass('kazumi-drop-before');
    },

    /** 结束拖拽：清定时器、拖拽态与指示线（dragend/drop/取消统一收口）。 */
    _endDragVisual() {
        if (this._dragTimer) { clearTimeout(this._dragTimer); this._dragTimer = null; }
        this._dragName = null;
        this._dropGap = null;
        $('#kazumi_rule_list .kazumi-rule-row').removeClass('dragging kazumi-drop-before kazumi-drop-after');
    },

    /**
     * 拖拽落位：gap 为落点间隙（0..n）。从当前 _rules 现场求 from/to——
     * 拖拽期间列表可能已被刷新（检测/更新完成），索引一律以最新列表为准；
     * from 找不到（规则被删）或落位后位置不变时静默返回，不产生副作用。
     */
    async dropRuleAt(dragName, gap) {
        const from = this._rules.findIndex((r) => r.name === dragName);
        if (!dragName || from < 0) return;
        const to = this._dropTargetIndex(from, gap, this._rules.length);
        if (to < 0 || to === from) return;
        await this._applyRuleOrder(this._moveItem(this._rules, from, to));
    },

    /**
     * 按新顺序应用并持久化：一次 kazumiReorder（names 全量数组，后端一次落盘）
     * + 乐观更新 + 失败回滚。写前校验新序与当前列表同集合——竞态下基于旧索引
     * 算出的排列若会丢/重规则，直接放弃并回到当前真实列表。
     */
    async _applyRuleOrder(arr) {
        const prev = this._rules.slice();
        if (!this._sameRuleSet(prev, arr)) { this._renderRuleList(); return; }
        this._rules = arr;
        this._renderRuleList();
        try {
            const rsp = await doAction('kazumiReorder', { names: JSON.stringify(arr.map((r) => r.name)) }, '/kazumi/action');
            if (!rsp || rsp.code !== 200) { warnToast('排序保存失败'); this._rules = prev; this._renderRuleList(); }
        } catch (e) { warnToast('排序保存失败'); this._rules = prev; this._renderRuleList(); }
    },

    // ---------------------------------------------------------------- 批量管理（任务2）

    // 批量模式状态：_batchSel 初值用 null 而不是 new Set()——对象字面量在脚本
    // 加载期求值，极简 vm 沙箱（既有单测桩未提供全局 Set）会在这里直接抛错
    _batchMode: false,
    _batchSel: null,

    /** 进入批量管理（无规则时无意义，直接提示）。 */
    enterBatchMode() {
        if (!this._rules.length) { warnToast('当前没有已导入的规则'); return; }
        this._batchMode = true;
        this._batchSel = new Set();
        this._renderRuleList();
    },

    /** 退出批量管理：清空选择、恢复普通交互（卡片按钮/拖拽）。 */
    exitBatchMode() {
        this._batchMode = false;
        this._batchSel = new Set();
        this._renderRuleList();
    },

    /** 入口按钮开关：已在批量模式时再点即退出（不重新进入，避免误清空勾选）。 */
    toggleBatchMode() {
        if (this._batchMode) this.exitBatchMode();
        else this.enterBatchMode();
    },

    /** 批量操作条与入口按钮状态（模式 + 选中数联动）。 */
    _renderBatchBar() {
        const n = this._batchSel ? this._batchSel.size : 0;
        $('#kazumi_batch_ops').toggle(!!this._batchMode);
        $('#kazumi_rule_batch').toggleClass('active', !!this._batchMode);
        $('#kazumi_batch_count').text(`已选 ${n} 项`);
        // 0 选中时批量操作无意义：禁用而不是弹提示，避免误点出确认框
        $('#kazumi_batch_update, #kazumi_batch_del').prop('disabled', n === 0);
    },

    /** 操作条入口（全选 / 反选 / 清空选择），整表重渲以同步勾选框。 */
    _batchApply(mode) {
        const names = this._rules.map((r) => r.name);
        if (mode === 'all') this._batchSel = new Set(names.map((n) => String(n || '')));
        else if (mode === 'invert') this._batchSel = this._batchInvert(this._batchSel, names);
        else this._batchSel = new Set();
        this._renderRuleList();
    },

    /** 勾选框变更：只更新选中集与该行高亮（不整表重渲，保留键盘焦点）。 */
    _batchCheckboxChanged(el) {
        const name = String($(el).data('name') || '');
        if (!name) return;
        this._batchSel = this._batchToggle(this._batchSel, name, !!(el && el.checked));
        $(el).closest('.kazumi-rule-row').toggleClass('kazumi-rule-checked', this._batchSel.has(name));
        this._renderBatchBar();
    },

    /** 选中项名称（按列表顺序，保证批量请求顺序稳定）。 */
    _batchSelectedNames() {
        return this._rules.filter((r) => this._batchSel && this._batchSel.has(String(r.name || '')))
            .map((r) => String(r.name || ''));
    },

    /** 批量更新选中项：复用 batchUpdate 的子集通道；启动成功才退出批量模式。 */
    async batchUpdateSelected() {
        const names = this._batchSelectedNames();
        if (!names.length) { warnToast('请先勾选要更新的规则'); return; }
        const started = await this.batchUpdate(names);
        if (started) this.exitBatchMode();
    },

    /**
     * 批量删除选中项：一次二次确认（写明条数）+ 复用单条删除通道逐条执行。
     * 逐条而不是并发：后端每条 remove 都会落盘一次，串行避免写文件竞争；
     * 名字里含逗号的规则无法走批量更新（后端按逗号切分），删除不受此限制。
     */
    async batchRemoveSelected() {
        const names = this._batchSelectedNames();
        if (!names.length) { warnToast('请先勾选要删除的规则'); return; }
        if (!await confirmDialog(`将删除选中的 ${names.length} 条规则，删除后无法恢复，确认继续？`,
            { okText: `删除 ${names.length} 条` })) return;
        let ok = 0;
        let fail = 0;
        for (const name of names) {
            const done = await this._removeRuleDirect(name);
            if (done.ok) ok++; else fail++;
        }
        warnToast(`批量删除完成：成功 ${ok} 条${fail ? ` · 失败 ${fail} 条` : ''}`, { summary: true });
        this.exitBatchMode();          // 退出批量模式（清空选择、恢复普通交互）
        await this.refreshRuleList();  // 再拉真实列表，校正计数与顺序
    },

    // ---------------------------------------------------------------- 有效性检测 / 批量更新

    /** 查看已持久化的 Cookie（按域名分组统计）。 */
    async viewCookies() {
        try {
            const rsp = await doAction('kazumiCookieList', {}, '/kazumi/action');
            const cookies = (rsp && rsp.cookies) || {};
            const count = (rsp && rsp.count) || 0;
            const box = $('#kazumi-cookie-list');
            if (!count) {
                box.html('<div class="tip-line pad0">当前没有已保存的 Cookie。</div>');
            } else {
                const rows = Object.keys(cookies).map((domain) => {
                    const list = Array.isArray(cookies[domain]) ? cookies[domain] : [];
                    return `<div class="history-item"><span class="history-url">${escHtml(domain)}（${list.length} 个）</span></div>`;
                }).join('');
                box.html(`<div class="tip-line pad0">共保存 ${count} 个 Cookie，按域名分组如下：</div>${rows}`);
            }
            openDialog('kazumiCookieDialog');
        } catch (e) { warnToast('查询 Cookie 失败'); }
    },

    /** 清除全部持久化 Cookie（验证码源之后可能需重新验证）。 */
    async clearCookies() {
        if (!await confirmDialog('清除所有已保存的 Cookie？之后验证码源可能需重新验证。', { okText: '清除' })) return;
        try {
            const rsp = await doAction('kazumiCookieClear', {}, '/kazumi/action');
            if (rsp && rsp.code === 200) warnToast('已清除 Cookie');
            else warnToast('清除失败');
        } catch (e) { warnToast('清除失败'); }
    },

    // ---------------------------------------------------------------- Bangumi 同步

    /** 规范化 Token：去空白、兼容用户粘贴的 `Bearer xxx` 全头。 */
    _normalizeToken(raw) {
        let t = String(raw || '').trim();
        if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, '').trim();
        return t;
    },

    /** 读取设置里的 Bangumi token（自动规范化）。 */
    async _getBangumiToken() {
        try { const s = (await window.yuki.settingsGet()) || {}; return this._normalizeToken(s.bangumiToken || ''); } catch (e) { return ''; }
    },

    /** 同步优先级取值归一化（与后端 PluginManager.normalize_sync_priority 同一套白名单口径）：
     *  新值 local/remote/newest；旧版下拉落盘的是 '0'/'1'，按语义迁移，老用户设置既不能丢也不能反转。
     *  非法/缺失回落 'local'（= 改动前的既有行为，老用户语义不变）。 */
    _normalizeSyncPriority(v) {
        const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
        if (s === 'local' || s === 'remote' || s === 'newest') return s;
        if (s === '0') return 'local';   // 旧下拉：'0' = 本地优先
        if (s === '1') return 'remote';  // 旧下拉：'1' = Bangumi 优先
        return 'local';
    },

    /** 上次同步完成时间，供后端「本地自上次同步未改动 → 远端胜」的增量判定使用。
     *  当前没有任何写入方：主进程 SETTINGS_SET_ALLOWED 白名单未放行 bangumiLastSyncAt，
     *  渲染层写入会被静默忽略（src/main/index.js），故这里读不到就回 null，后端按
     *  「无历史同步时间」处理（不猜值）。待 lead 在白名单放行并在同步成功后写入，本函数自动生效。 */
    async _getLastSyncAt(settings) {
        try {
            const s = settings || (await window.yuki.settingsGet()) || {};
            const v = s.bangumiLastSyncAt;
            if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
            if (typeof v === 'string' && v.trim()) return v;  // ISO 字符串原样透传，由后端解析
            return null;
        } catch (e) { return null; }
    },

    /** 回填 token 输入框（设置已保存过时展示）与同步选项。 */
    async _prefillBangumiToken() {
        const t = await this._getBangumiToken();
        if (t) $('#bangumi_token').val(t);
        try {
            const s = (await window.yuki.settingsGet()) || {};
            const prio = this._normalizeSyncPriority(s.bangumiSyncPriority);
            $('#bangumi_sync_priority').val(prio);
            // 旧值（'0'/'1'）读到即迁移落盘：否则每次开设置页都要再迁一次，
            // 且用户只要不动下拉就一直留着死值（读侧虽已兼容，但库里长期是两种口径）
            if (s.bangumiSyncPriority !== undefined && s.bangumiSyncPriority !== null
                && String(s.bangumiSyncPriority).trim().toLowerCase() !== prio) {
                try { window.yuki.settingsSet('bangumiSyncPriority', prio); } catch (e) { /* 迁移失败不阻塞 */ }
            }
            $('#bangumi_immediate_toast').prop('checked', s.bangumiImmediateSyncToastEnable !== false);
            $('#set_bangumi_autosync_status').prop('checked', s.bangumiAutoSyncStatus === true);
            $('#set_bangumi_autosync_on_start').prop('checked', s.bangumiAutoSyncOnStart === true);
            $('#set_bangumi_progress_sync').prop('checked', s.bangumiProgressSync === true);
        } catch (e) { /* 读取失败不阻塞 */ }
    },

    /** 回填弹弹 play 弹幕凭据到设置页。 */
    async _prefillDandan() {
        try {
            const s = (await window.yuki.settingsGet()) || {};
            if (s.dandanAppId) $('#set_dandan_appid').val(s.dandanAppId);
            if (s.dandanAppSecret) $('#set_dandan_secret').val(s.dandanAppSecret);
        } catch (e) { /* 读取失败不阻塞 */ }
    },

    /** 回填 WebDAV 配置（地址/账号/密码 + 主/子开关）到设置页。 */
    async _prefillWebdav() {
        try {
            const s = (await window.yuki.settingsGet()) || {};
            if (s.webDavUrl) $('#webdav_url').val(s.webDavUrl);
            if (s.webDavUsername) $('#webdav_username').val(s.webDavUsername);
            if (s.webDavPassword) $('#webdav_password').val(s.webDavPassword);
            if (s.webDavRemoteDir) $('#webdav_remote_dir').val(s.webDavRemoteDir);
            $('#webdav_enable').prop('checked', !!s.webDavEnable);
            $('#webdav_fields').toggle(!!s.webDavEnable); // 主开关关闭时保持收起
            $('#webdav_enable_history').prop('checked', s.webDavEnableHistory !== false);
            $('#webdav_enable_collect').prop('checked', s.webDavEnableCollect !== false);
            $('#webdav_enable_settings').prop('checked', s.webDavEnableSettings !== false);
            $('#webdav_enable_stats').prop('checked', s.webDavEnableStats !== false);
            $('#webdav_enable_rules').prop('checked', s.webDavEnableRules !== false);
            $('#webdav_ssl_skip').prop('checked', !!s.webDavSslSkip);
            $('#webdav_startup_pull').prop('checked', !!s.webDavStartupPull);
            $('#webdav_auto_enable').prop('checked', !!s.webDavAutoEnable);
            $('#webdav_auto_fields').toggle(!!s.webDavAutoEnable); // 定时同步未开启时收起间隔
            if (s.webDavAutoMinutes) $('#webdav_auto_interval').val(String(s.webDavAutoMinutes));
        } catch (e) { /* 读取失败不阻塞 */ }
    },

    /** 回填镜像开关与镜像根域名，并把已保存的镜像状态应用到后端与 common.js 全局。 */
    async _prefillMirror() {
        try {
            const s = (await window.yuki.settingsGet()) || {};
            $('#set_bangumi_mirror').prop('checked', !!s.enableBangumiProxy);
            $('#bangumi_mirror_fields').toggle(!!s.enableBangumiProxy); // 镜像未开启时保持收起
            $('#set_git_mirror').prop('checked', !!s.enableGitProxy);
            // 条目页跳转跟随镜像：回填开关 + common.js 全局（detail.js 跳转即时按此取域）
            bangumiWebFollowMirror = s.enableBangumiWebMirror === true;
            $('#set_bangumi_web_mirror').prop('checked', bangumiWebFollowMirror);
            // 镜像根域名：settings 无值（未设置过）保持默认；后端启动时也从
            // mirror.json 自恢复，这里再同步一次保证双端一致（含封面兜底链）
            const root = setBangumiMirrorRoot(s.bangumiMirrorRoot || 'bangumi.vip');
            $('#set_bangumi_mirror_root').val(root || 'bangumi.vip');
            doAction('kazumiSetMirror', {
                bangumi: s.enableBangumiProxy ? '1' : '0',
                git: s.enableGitProxy ? '1' : '0',
                root: root || 'bangumi.vip',
            }, '/kazumi/action').catch(() => { });
        } catch (e) { /* 读取失败不阻塞 */ }
    },

    /** 回填启动时自动检查规则更新开关，并在开启时启动一次后台批量更新。 */
    async _prefillKazumiAutoUpdate() {
        try {
            const s = (await window.yuki.settingsGet()) || {};
            $('#set_kazumi_autoupdate').prop('checked', s.kazumiAutoUpdateOnStart === true);
            // 启动时自动检查更新（开关开启 + 本次会话尚未执行过）
            if (s.kazumiAutoUpdateOnStart === true && !this._autoUpdateStarted) {
                this._autoUpdateStarted = true;
                // 静默触发批量更新：不弹确认框，直接后台拉取并更新
                doAction('kazumiBatchUpdate', {}, '/kazumi/action').then((rsp) => {
                    if (!rsp || !rsp.started) return; // 已有任务在跑则跳过
                    this._pollTask('kazumiUpdateStatus', () => {
                        this.refreshRuleList();
                    }, '启动检查更新');
                }).catch(() => { /* 启动检查失败静默 */ });
            }
        } catch (e) { /* 读取失败不阻塞 */ }
    },

    /** 保存 token 到 settings（仅本机）。 */
    async saveBangumiToken() {
        const raw = $('#bangumi_token').val().trim();
        const token = this._normalizeToken(raw);
        if (!token) { warnToast('请输入 Bangumi Access Token'); return; }
        if (token !== raw.trim()) $('#bangumi_token').val(token);
        try {
            await window.yuki.settingsSet('bangumiToken', token);
        } catch (e) {
            warnToast('Token 保存失败');
            return;
        }
        warnToast('Token 已保存');
        this.testBangumi();
    },

    /** 测试连接：GET /v0/me 显示用户名（reason 区分 token 无效与网络/镜像故障）。 */
    async testBangumi() {
        const raw = $('#bangumi_token').val().trim() || await this._getBangumiToken();
        const token = this._normalizeToken(raw);
        if (!token) { warnToast('请先保存 Bangumi Token'); return; }
        try {
            const rsp = await doAction('kazumiBangumiMe', { token }, '/kazumi/action');
            const me = (rsp && rsp.me) || null;
            const status = $('#bangumi_status');
            if (me && me.username) {
                status.text(`连接成功：${me.nickname || me.username}（ID ${me.id}）`).show();
            } else if (rsp && rsp.reason === 'network') {
                status.text('连接失败：网络或镜像故障（已自动切换官方/镜像源重试仍失败），请检查网络后重试，或在设置中更换 Bangumi 镜像域名').show();
                warnToast('Bangumi 连接失败：网络/镜像故障，请稍后重试');
            } else {
                status.text('连接失败：Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取').show();
                warnToast('Bangumi Token 无效或已过期（401），请在 https://bgm.tv/settings/token 重新获取');
            }
        } catch (e) { warnToast('测试连接失败，请检查网络或 Token'); }
    },

    /** 删除某条 Bangumi 收藏；返回是否成功（详情弹窗据此刷新状态）。 */
    async removeBangumiCollection(subjectId, name) {
        if (!await confirmDialog(`从 Bangumi 收藏中删除「${name}」？`, { okText: '删除' })) return false;
        const token = await this._getBangumiToken();
        try {
            const rsp = await doAction('kazumiBangumiCollectionDel', { token, id: subjectId }, '/kazumi/action');
            if (rsp && rsp.code === 200) {
                warnToast('已删除收藏');
                this._bgmColCacheDel(String(subjectId)); // 删除成功同步作废本地缓存
                return true;
            }
            warnToast('删除失败：' + ((rsp && rsp.msg) || '未知错误'));
            return false;
        } catch (e) { warnToast('删除失败'); return false; }
    },

    /** 批量上传期间抑制 setBangumiCollection 的单条 toast（成功/失败均静默，由批量函数汇总提示）。 */
    _bgmBatchActive: false,

    /** 收藏标签 → Bangumi 收藏类型（1想看 2看过 3在看 4搁置 5抛弃）。
     *  注意：后端 plugin_manager.py:858 docstring 写的是 0-4，实际透传 int 且应传 1-5，注释有误。 */
    _favTagToBangumiType: { want: 1, seen: 2, watching: 3, hold: 4, dropped: 5 },

    /** 设置某 subject 的收藏类型（详情弹窗追番按钮用）。
     *  opts.quiet：静默成功（进度自动上报联动用，不打断观看）。 */
    async setBangumiCollection(subjectId, type, opts = {}) {
        const token = await this._getBangumiToken();
        if (!token) { if (!this._bgmBatchActive) warnToast('请先在设置 → Kazumi 规则 → Bangumi 同步中保存 Token'); return false; }
        try {
            const rsp = await doAction('kazumiBangumiCollectionSet', { token, id: subjectId, type }, '/kazumi/action');
            if (rsp && rsp.code === 200) {
                // 即时同步提示开关（bangumiImmediateSyncToastEnable，默认开）；批量上传内抑制单条提示
                if (!this._bgmBatchActive && !(opts && opts.quiet)) {
                    try {
                        const st = (await window.yuki.settingsGet()) || {};
                        if (st.bangumiImmediateSyncToastEnable !== false) warnToast('已同步到 Bangumi');
                    } catch (e) { warnToast('已同步到 Bangumi'); }
                }
                // 乐观更新本地收藏缓存：type 立即生效；ep_status 沿用旧值（打点接口另行更新），
                // 下次打开详情页直接命中缓存显示最新状态。合并前校验旧条目 token：
                // 换号后旧账号的 ep_status/rate/comment 不能借乐观写入带到新账号缓存里
                const prev = this._bgmColCacheRead(String(subjectId));
                const prevCol = (prev && typeof prev === 'object' && prev.col
                    && prev.token === String(token)) ? prev.col : null;
                this._bgmColCacheWrite(String(subjectId), { ...(prevCol || {}), type }, token);
                return true;
            }
            if (!this._bgmBatchActive && !(opts && opts.quiet)) {
                const msg = (rsp && rsp.msg) || '未知错误';
                // 401 鉴权失败给出可操作指引，其余保持原样
                if (String(msg).includes('401') || String(msg).includes('Token 无效') || String(msg).includes('token')) {
                    warnToast('Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取');
                } else {
                    warnToast('同步失败：' + msg);
                }
            }
            return false;
        } catch (e) { if (!this._bgmBatchActive) warnToast('同步失败'); return false; }
    },

    /**
     * 收藏状态变动自动同步（单条，后台静默）：
     * 由 Records.toggleFavorite / Records.setFavTag 在开关「收藏状态变动自动同步」开启时调用。
     * 思路与 uploadFavoritesToBangumi 单条一致：拿 bangumiId 或按片名匹配 → setBangumiCollection。
     * @param {object} f 收藏项 {tag, name, bangumiId, site, ...}
     */
    async _autoSyncFavItem(f) {
        if (!f || f.site === 'bangumi' || !f.name) return;
        const token = await this._getBangumiToken();
        if (!token) return; // 无 Token 静默跳过（设置页有显式提示）
        const type = this._favTagToBangumiType[f.tag || 'want'] || 1;
        let subjectId = Number(f.bangumiId) || 0;
        if (!subjectId) {
            const m = await this.getBangumiMatch(f.name);
            subjectId = (m && Number(m.id)) || 0;
        }
        if (!subjectId) return; // 匹配不到 Bangumi subject，静默跳过
        await this.setBangumiCollection(subjectId, type);
    },

    // ---------------------------------------------------------------- Bangumi 观看进度自动上报（RM-5）

    /** 分集列表缓存：subjectId → { eps, ts }（10 分钟 TTL，连播逐集上报免重复拉取）。 */
    _bgmEpCache: new Map(),
    _bgmEpCacheTTL: 10 * 60 * 1000,

    /** 上报串行链：同一账号的打点/收藏联动按序执行，避免连播逐集并发交错。 */
    _bgmProgressChain: Promise.resolve(),

    /** 上次失败提醒时间戳：失败 toast 5 分钟内不重复（Token 失效时连播逐集不刷屏）。 */
    _bgmProgressLastFailToast: 0,

    /** 看完一集自动上报的准入判定：仅在线源（CatVod 带 vodId / kazumi: 源）。
     *  直链（title 是 URL 文件名）、本地/下载文件、Bangumi 自身条目不做片名匹配，防误标。 */
    _bgmProgressEligible(meta) {
        if (!meta || !meta.title) return false;
        const site = String(meta.site || '');
        if (!site || site === 'direct' || site === 'local' || site === 'download' || site === 'bangumi') return false;
        if (site.startsWith('kazumi:')) return true;
        return !!meta.vodId;
    },

    /** 从集名解析集数：第N集/第N话、Episode N、EP N、S01E02、纯数字、前导数字；「第一季」这类无集后缀的不误判。
     *  特典/花絮/OVA 等番外集名不做数字推断（返回 0，交给分集名精确兜底），防把同号正片错标看过。
     *  返回数字（支持 7.5 这类番外集号），解析不到返回 0。 */
    _bgmParseEpNumber(name) {
        const s = String(name || '').trim();
        if (!s) return 0;
        // 番外关键词直接放弃数字推断（宁缺勿错）：「特典 01」「SP 1」解析出集号会命中
        // 同号正片导致错标；拉丁关键词用词边界匹配，避免 Whisper 之类普通单词误伤。
        if (/特典|花絮|番外|预告|特别篇|特別篇|\b(?:sp|ova|oad|ncop|nced|pv|menu)\b/i.test(s)) return 0;
        let m = s.match(/第\s*(\d+(?:\.\d+)?)\s*[集话話]/);
        if (m) return parseFloat(m[1]) || 0;
        m = s.match(/episode\s*[.\-_:：]?\s*(\d+(?:\.\d+)?)/i);
        if (m) return parseFloat(m[1]) || 0;
        // SxxExx（S01E02/S1-E2）：E 前是数字，通用 EP 分支的前置边界拦不住，单独识别；
        // SP1 这类特典名 S 后无数字不会误入本分支
        m = s.match(/(?:^|[^\dA-Za-z])S\s*\d{1,3}\s*[.\-_]?\s*E\s*(\d+(?:\.\d+)?)(?:\s*$|[^\d])/i);
        if (m) return parseFloat(m[1]) || 0;
        m = s.match(/(?:^|[^\dA-Za-z])EP?\s*[.\-_:：]?\s*(\d+(?:\.\d+)?)(?:\s*$|[^\d])/i);
        if (m) return parseFloat(m[1]) || 0;
        m = s.match(/^(\d+(?:\.\d+)?)$/);
        if (m) return parseFloat(m[1]) || 0;
        m = s.match(/^[「『\[\(]?\s*(\d+(?:\.\d+)?)\s*[」』\]\)]?\s*\D/);
        if (m) return parseFloat(m[1]) || 0;
        return 0;
    },

    /**
     * 看完一集 → Bangumi 观看进度自动上报（fire-and-forget，由 Player 在「看完」时调用）：
     *   1. 该集在 Bangumi 标记「看过」（分集收藏批量端点，服务端重算条目完成度）；
     *   2. 收藏联动：未收藏/想看 → 自动「在看」；看完全部本篇集 → 自动「看过」（搁置/抛弃不动）。
     * 开关 bangumiProgressSync（默认关）；无 Token / 匹配不到条目或分集全程静默跳过；
     * 失败 5 分钟内只提醒一次，不阻塞播放。
     * @param {object} meta {site, title, subtitle(集名), vodId, kazumiSrc}
     * @param {number} epIndex 当前集下标（从 0 起，仅用于诊断日志）
     */
    reportWatchProgress(meta, epIndex) {
        if (!this._bgmProgressEligible(meta)) return;
        this._bgmProgressChain = this._bgmProgressChain.catch(() => { /* 上一次失败不阻塞本集 */ })
            .then(() => this._bgmProgressApply(meta, Number(epIndex) || 0))
            .catch(() => { /* 链内任何异常都吞掉：进度上报绝不影响播放 */ });
    },

    async _bgmProgressApply(meta, epIndex) {
        const s = (await window.yuki.settingsGet()) || {};
        if (s.bangumiProgressSync !== true) return; // 默认关
        const token = await this._getBangumiToken();
        if (!token) return; // 无 Token 静默跳过（设置页有显式开关与说明）
        const title = String(meta.title || '').trim();
        const sub = String(meta.subtitle || '').trim();
        const match = await this.getBangumiMatch(title);
        const subjectId = (match && Number(match.id)) || 0;
        if (!subjectId) return; // 匹配不到 Bangumi 条目，静默跳过
        // 分集解析：集数优先（ep 精确匹配），其次集名精确匹配；都不中则跳过（宁缺勿错标）
        let eps = null;
        const cached = this._bgmEpCache.get(subjectId);
        if (cached && (Date.now() - cached.ts) < this._bgmEpCacheTTL) eps = cached.eps;
        if (!eps) {
            // bangumiEpisodes 返回后端透传的 Bangumi /v0/episodes 包装对象 {data, total}，
            // 须取 .data（detail/player 页签同口径）；直接当数组用会在 .filter 抛 TypeError
            // 被外层静默吞掉，整条上报链路零生效。数组形状也兜住，防后端将来直接透传列表。
            const wrap = await this.bangumiEpisodes(subjectId);
            const list = Array.isArray(wrap) ? wrap
                : (wrap && Array.isArray(wrap.data)) ? wrap.data : null;
            if (list === null) {
                // 拉取失败不写缓存：空表毒化 10 分钟会让连播后续每集都静默跳过；本集跳过、下次重试
                eps = [];
            } else {
                eps = list;
                this._bgmEpCache.set(subjectId, { eps, ts: Date.now() });
                if (this._bgmEpCache.size > 32) {
                    const oldest = this._bgmEpCache.keys().next().value;
                    this._bgmEpCache.delete(oldest);
                }
            }
        }
        const mainEps = eps.filter((e) => Number(e && e.type) === 0);
        if (!mainEps.length) return;
        const num = this._bgmParseEpNumber(sub);
        let ep = null;
        if (num > 0) ep = mainEps.find((e) => Number(e.ep) === num) || null;
        if (!ep && sub) {
            const norm = (x) => String(x || '').trim().toLowerCase();
            ep = mainEps.find((e) => (e.name_cn && norm(e.name_cn) === norm(sub))
                || (e.name && norm(e.name) === norm(sub))) || null;
        }
        if (!ep || !ep.id) {
            console.log(`[RM-5] 进度上报跳过：匹配不到分集（${title} · ${sub || '无集名'} · epIndex ${epIndex}）`);
            return;
        }
        // 名称兜底命中时用该分集自身集号参与「最后一集」判定（集名无数字也能联动看过）
        const resolvedNum = num > 0 ? num : (Number(ep.ep) || 0);
        const rsp = await doAction('kazumiBangumiEpisodeWatched', {
            token, subjectId, episodeIds: JSON.stringify([ep.id]),
        }, '/kazumi/action');
        if (!rsp || rsp.code !== 200) {
            this._bgmProgressFailToast((rsp && rsp.msg) || '未知错误');
            return;
        }
        // 打点成功：乐观更新本地收藏缓存的 ep_status（看到第 N 话），详情页进度行直接可用。
        // 远端 ep_status 取 max(旧值, 本集号)；缓存不存在（未查过收藏）则跳过，等详情页回源。
        try {
            const cached = this._bgmColCacheRead(String(subjectId));
            if (cached && typeof cached === 'object' && cached.col && cached.token === String(token)) {
                const prevEp = Number(cached.col.ep_status) || 0;
                cached.col.ep_status = Math.max(prevEp, resolvedNum);
                cached.ts = Date.now();
                this._bgmColCacheWrite(String(subjectId), cached.col, token);
            }
        } catch (e) { /* 缓存更新失败不影响打点 */ }
        // 收藏联动（全部静默）：未收藏/想看 → 在看；最后一集看完且远端本篇全部看过 → 看过
        try {
            const col = await this.getBangumiCollection(subjectId);
            const colType = col ? Number(col.type) : NaN;
            if (!col || colType === 1) {
                await this.setBangumiCollection(subjectId, 3, { quiet: true });
            }
            const isLastMain = resolvedNum > 0 && resolvedNum >= Math.max(...mainEps.map((e) => Number(e.ep) || 0));
            if (isLastMain) {
                // 仅「在看」（含刚联动成在看）才检查升级看过；已看过/搁置/抛弃/type 异常一律不动
                const curType = (!col || colType === 1) ? 3 : colType;
                if (curType === 3) {
                    const epRsp = await doAction('kazumiBangumiEpisodeCollections', { token, subjectId }, '/kazumi/action');
                    const items = (epRsp && epRsp.items) || null;
                    if (items) {
                        const watched = new Set(items.filter((it) => Number(it.type) === 2).map((it) => Number(it.episode_id)));
                        if (mainEps.every((e) => watched.has(Number(e.id)))) {
                            await this.setBangumiCollection(subjectId, 2, { quiet: true });
                        }
                    }
                }
            }
        } catch (e) { /* 联动失败不影响打点结果 */ }
    },

    /** 上报失败提醒（5 分钟节流）。 */
    _bgmProgressFailToast(msg) {
        const now = Date.now();
        if (now - this._bgmProgressLastFailToast < 300000) return;
        this._bgmProgressLastFailToast = now;
        const m = String(msg || '');
        if (m.includes('401') || m.includes('Token 无效')) {
            warnToast('Bangumi Token 无效或已过期（401），观看进度未上报，请重新获取 Token');
        } else {
            warnToast('Bangumi 观看进度上报失败：' + m);
        }
    },

    /**
     * 批量把聚合源/本地收藏单向上传到 Bangumi 账号（仅新增/更新，绝不删除）。
     *
     * 任务六 6.1（Kazumi 同步管线）：
     *   1. 渲染端先把每条本地收藏解析出 Bangumi subjectId（优先 bangumiId，否则按片名 getBangumiMatch）
     *      与收藏类型（_favTagToBangumiType 1-5）、ts；无法解析 id 的计入 skipped；
     *   2. 一次调 kazumiBangumiSync：后端分页拉远端【全量】收藏做三方合并，返回 plan
     *      {upload,pull,conflict,skipped}——已同步一致 / 未改动的冲突在后端去重，天然增量；
     *   3. 调 kazumiBangumiSyncApply：后端 ThreadPoolExecutor(max_workers=3) + 250ms/请求 限速并发上传；
     *   4. 解析到的 id 统一回写各收藏项 bangumiId，重复同步免重算匹配。
     *
     * 相比旧串行逐条 set（每条重置用户名缓存 + 8 组合兜底），本管线：远端只拉一次、上传有界并发、
     * 用户名只解析一次，大批量收藏显著提速。单条失败不中断整批。
     *
     * 同步优先级（设置项 bangumiSyncPriority）在这里被真正消费：'local'/'remote'/'newest'
     * 原样传给后端做冲突裁决；'newest'（最新修改时间优先）下后端按「本地 ts vs 远端 updated_at」
     * 判较新者，远端较新的条目会被写回本地收藏标签（覆盖本地展示/状态），
     * 明细（谁胜/依据/双方时间）在控制台 [bangumi-sync] 日志里可查。
     * 此前这里硬编码 priority:'local' 且从不传 lastSyncAt，设置页下拉是个死开关。
     *
     * @param onProgress 可选 (done, total) => void，用于 UI 进度展示（契约不变）。
     * @returns {Promise<{uploaded:number, skipped:number, failed:number, total:number,
     *   conflicts:number, byNewest:number, remoteOverridden:number, priority:string}|null>} 无 Token 返回 null。
     */
    async uploadFavoritesToBangumi(onProgress) {
        const token = await this._getBangumiToken();
        if (!token) { warnToast('请先在 设置 → Kazumi 规则 → Bangumi 同步 保存 Token'); return null; }
        let favorites = [];
        try { favorites = await recGet('favorites'); } catch (e) { favorites = []; }
        const targets = (favorites || []).filter((f) => f && f.site !== 'bangumi' && f.name);
        const total = targets.length;
        if (!total) return { uploaded: 0, skipped: 0, failed: 0, total: 0 };
        // 阶段 A：解析每条收藏的 subjectId + type（进度用于「匹配」阶段），无法匹配计 skipped
        const localFavs = [];
        const idWriteback = new Map(); // uid → bangumiId：结束后统一回写
        const uidSubject = new Map();  // uid → subjectId：「远端较新」时按 uid 反查本地记录回写标签
        let resolveSkipped = 0;
        for (let i = 0; i < targets.length; i++) {
            const f = targets[i];
            try {
                const type = this._favTagToBangumiType[f.tag || 'want'] || 1;
                let subjectId = Number(f.bangumiId) || 0;
                if (!subjectId) {
                    const m = await this.getBangumiMatch(f.name);
                    subjectId = (m && Number(m.id)) || 0;
                }
                if (subjectId) {
                    localFavs.push({ subjectId: String(subjectId), type, ts: Number(f.ts) || 0, name: f.name });
                    if (f.uid) uidSubject.set(f.uid, String(subjectId));
                    if (f.uid && String(f.bangumiId || '') !== String(subjectId)) idWriteback.set(f.uid, String(subjectId));
                } else {
                    resolveSkipped++; // 匹配不到 Bangumi subject
                }
            } catch (e) { resolveSkipped++; }
            if (typeof onProgress === 'function') { try { onProgress(i + 1, total); } catch (e) { /* ignore */ } }
        }
        // 统一回写 bangumiId（重读最新表按 uid 匹配，避免覆盖同步期间其他改动）
        if (idWriteback.size) {
            try {
                const list = await recGet('favorites');
                let changed = false;
                (list || []).forEach((it) => {
                    if (it && it.uid && idWriteback.has(it.uid) && String(it.bangumiId || '') !== idWriteback.get(it.uid)) {
                        it.bangumiId = idWriteback.get(it.uid);
                        changed = true;
                    }
                });
                if (changed) await recSet('favorites', list);
            } catch (e) { /* 回写失败不影响上传 */ }
        }
        // 阶段 B：一次调后端生成三方合并计划（远端全量分页拉取在后端完成）。
        // 优先级/上次同步时间在这里读设置：此前硬编码 priority:'local' 且从不传 lastSyncAt，
        // 设置页下拉完全没被消费（死开关）。
        const settings = await (async () => { try { return (await window.yuki.settingsGet()) || {}; } catch (e) { return {}; } })();
        const priority = this._normalizeSyncPriority(settings.bangumiSyncPriority);
        const lastSyncAt = await this._getLastSyncAt(settings);
        let plan = null;
        try {
            const rsp = await doAction('kazumiBangumiSync', {
                token, favorites: JSON.stringify(localFavs), priority,
                // 无落盘时间时传空串：URLSearchParams 会把 null 序列化成 "null"，后端只认空/缺失
                lastSyncAt: (lastSyncAt === null || lastSyncAt === undefined) ? '' : lastSyncAt,
            }, '/kazumi/action');
            plan = (rsp && rsp.plan) || null;
        } catch (e) { plan = null; }
        if (!plan) return { uploaded: 0, skipped: resolveSkipped, failed: localFavs.length, total };
        if (plan.error) {
            const msg = String(plan.error);
            if (msg.includes('401') || msg.includes('Token 无效') || msg.includes('token')) {
                warnToast('Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取');
            } else {
                warnToast('同步计划失败：' + msg);
            }
            return { uploaded: 0, skipped: resolveSkipped, failed: localFavs.length, total, error: plan.error };
        }
        // 冲突裁决结果：至少让「本次哪些条目按最新时间裁决」在控制台/日志可查（不为它新增大 UI）。
        const conflicts = Array.isArray(plan.conflict) ? plan.conflict : [];
        const resolvedByNewest = conflicts.filter((c) => c && c.resolvedBy === 'newest');
        const remoteWon = resolvedByNewest.filter((c) => c && c.resolved === 'remote');
        const conflictStats = {
            conflicts: conflicts.length, byNewest: resolvedByNewest.length,
            remoteOverridden: 0, priority,
        };
        if (conflicts.length) {
            console.log(`[bangumi-sync] 冲突 ${conflicts.length} 条 · 按最新时间裁决 ${resolvedByNewest.length} 条 · 优先级 ${priority}`);
            conflicts.forEach((c) => {
                if (!c) return;
                const localTime = (c.localTsSec === null || c.localTsSec === undefined) ? '无时间' : String(c.localTsSec);
                const remoteTime = (c.remoteUpdatedAt === undefined || c.remoteUpdatedAt === null) ? '无时间' : String(c.remoteUpdatedAt);
                console.log(`[bangumi-sync] ${c.name || c.subjectId}：本地 type=${c.localType}(${localTime}) ↔ Bangumi type=${c.remoteType}(${remoteTime}) → ${c.resolved === 'local' ? '本地胜' : 'Bangumi 胜'} via ${c.resolvedBy}`);
            });
        }
        // 「最新时间优先」判定远端较新的条目：把远端收藏类型覆盖回本地收藏标签（本地展示/状态跟随远端）。
        // 只回写 resolvedBy==='newest' 的条目——priority=local/remote 的既有语义保持不动，不扩大改动面。
        // 不动 ts：它是「用户本地改动时间」，这里写的是同步下行状态；写完 type 已一致，不会反复触发。
        if (remoteWon.length) {
            const TYPE_TAG = { 1: 'want', 2: 'seen', 3: 'watching', 4: 'hold', 5: 'dropped' };
            const wonBySid = new Map(remoteWon.map((c) => [String(c.subjectId), c]));
            try {
                const list = await recGet('favorites'); // 重读最新表，避免覆盖同步期间其他改动
                let changed = 0;
                (list || []).forEach((it) => {
                    if (!it || !it.uid) return;
                    const hit = wonBySid.get(uidSubject.get(it.uid));
                    const tag = hit && TYPE_TAG[Number(hit.remoteType)];
                    if (!tag || it.tag === tag) return;
                    it.tag = tag;
                    changed++;
                });
                if (changed) {
                    await recSet('favorites', list);
                    console.log(`[bangumi-sync] 已按最新时间把 ${changed} 条本地收藏标签改为 Bangumi 端状态`);
                }
                conflictStats.remoteOverridden = changed;
            } catch (e) { /* 回写失败不影响上传结果 */ }
        }
        const uploads = plan.upload || [];
        const planSkipped = Number(plan.skipped) || 0;
        if (!uploads.length) {
            return { uploaded: 0, skipped: resolveSkipped + planSkipped, failed: 0, total, ...conflictStats };
        }
        // 阶段 C：并发上传（后端 max_workers=3 + 限速）。进度切到「上传」阶段。
        if (typeof onProgress === 'function') { try { onProgress(0, uploads.length); } catch (e) { /* ignore */ } }
        let uploaded = 0, failed = 0;
        let applyError = '';
        try {
            const rsp = await doAction('kazumiBangumiSyncApply', {
                token, uploads: JSON.stringify(uploads),
            }, '/kazumi/action');
            const result = (rsp && rsp.result) || {};
            uploaded = Number(result.uploaded) || 0;
            failed = Number(result.failed) || 0;
            applyError = String(result.error || '');
            if (applyError && (applyError.includes('401') || applyError.includes('Token 无效'))) {
                warnToast('Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取');
            } else if (failed && result.results) {
                const firstFail = (result.results || []).find((r) => !r.ok);
                const m = firstFail ? String(firstFail.msg || '') : '';
                if (m.includes('401') || m.includes('Token 无效')) {
                    warnToast('Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取');
                }
            }
        } catch (e) { failed = uploads.length; }
        if (typeof onProgress === 'function') { try { onProgress(uploads.length, uploads.length); } catch (e) { /* ignore */ } }
        return { uploaded, skipped: resolveSkipped + planSkipped, failed, total, error: applyError, ...conflictStats };
    },

    /** 立即同步：拉取 Bangumi 收藏并刷新「我的收藏」合并网格（复用 My 的缓存刷新）。
     *  弹出进度对话框：先上传本地收藏（带 onProgress），再拉取远端，全过程可见进度。 */
    async syncBangumiNow() {
        const token = await this._getBangumiToken();
        if (!token) { warnToast('请先保存 Bangumi Token'); return; }
        // 弹出进度对话框（仿 Kazumi _BangumiSyncProgressDialog）
        if (typeof My !== 'undefined' && My._openSyncProgress) My._openSyncProgress();
        else showLoading();
        try {
            // 阶段 1：上传本地可匹配收藏（带 onProgress 进度回调）
            let up = null;
            if (typeof My !== 'undefined' && My._updateSyncProgress) My._updateSyncProgress(0, 0, '上传本地收藏');
            try {
                up = await this.uploadFavoritesToBangumi((done, total) => {
                    if (typeof My !== 'undefined' && My._updateSyncProgress) My._updateSyncProgress(done, total, '上传本地收藏');
                });
            } catch (e) { up = null; }
            // Token 401 时直接提示并结束，避免无意义拉取远端
            if (up && up.error && (String(up.error).includes('401') || String(up.error).includes('Token 无效'))) {
                if (typeof My !== 'undefined' && My._closeSyncProgress) My._closeSyncProgress();
                else hideLoading();
                return;
            }
            // 阶段 2：拉取 Bangumi 远端【全量】收藏（all=1 分页，>100 也完整）
            if (typeof My !== 'undefined' && My._updateSyncProgress) My._updateSyncProgress(0, 0, '拉取 Bangumi 收藏');
            const rsp = await doAction('kazumiBangumiCollections', { token, all: 1 }, '/kazumi/action');
            const n = ((rsp && rsp.items) || []).length;
            // 与收藏页同步按钮同款语义：作废「我的收藏」持久缓存并强制重拉，再重渲染。
            // 此前只清内存缓存就 render()，_extra() 非 force 命中 localStorage 旧缓存，
            // 设置页同步后收藏页永远显示旧数据，必须去收藏页再点一次同步。
            if (typeof My !== 'undefined' && My) {
                if (My.refreshBangumi) await My.refreshBangumi();
                else My._bgmCache = null;
                if (My._favorites) await My._favorites.render();
            }
            if (typeof My !== 'undefined' && My._closeSyncProgress) My._closeSyncProgress();
            else hideLoading();
            const upMsg = up ? `上传 ${up.uploaded} · 跳过 ${up.skipped}${up.failed ? ` · 失败 ${up.failed}` : ''}` : '';
            // 冲突裁决摘要：只在本次确实发生「最新时间优先」裁决时才追加，日常同步文案不变长
            const newestMsg = (up && up.byNewest)
                ? ` · 最新时间裁决 ${up.byNewest}${up.remoteOverridden ? `（Bangumi 覆盖本地 ${up.remoteOverridden}）` : ''}`
                : '';
            warnToast(`已同步 Bangumi 收藏（${n} 条）${upMsg ? '；' + upMsg : ''}${newestMsg}`, { summary: true });
        } catch (e) {
            if (typeof My !== 'undefined' && My._closeSyncProgress) My._closeSyncProgress();
            else hideLoading();
            warnToast('同步失败');
        }
    },

    /** 单条收藏状态本地缓存（cache.js localStorage 持久）：key 不含 token
     *  （token 存值内、读侧比对防换号串数据）；值 {col, ts, token}。
     *  读：详情页 _applyBangumiColState 每次打开都查，命中直接上屏免网络等待；
     *  写：get 回源后写入（null 走短负缓存），set/remove/ep watched 成功后同步
     *  更新/作废对应条目。 */
    _bgmColCacheTTL: 6 * 60 * 60 * 1000,
    _bgmColCacheNegTTL: 60 * 1000,
    _bgmColCacheKey(subjectId) {
        return 'detail::bgmcol::v1::' + String(subjectId);
    },
    _bgmColCacheRead(subjectId) {
        if (typeof localCacheGet !== 'function') return undefined; // undefined=缓存不可用
        try {
            const hit = localCacheGet(this._bgmColCacheKey(subjectId));
            if (!hit || typeof hit !== 'object') return null; // null=未命中
            return hit; // {col, ts, token}
        } catch (e) { return null; }
    },
    _bgmColCacheWrite(subjectId, col, token, ttl) {
        if (typeof localCacheSet !== 'function') return;
        try { localCacheSet(this._bgmColCacheKey(subjectId), { col, ts: Date.now(), token: String(token || '') }, ttl || this._bgmColCacheTTL); } catch (e) { /* 缓存失败忽略 */ }
    },
    _bgmColCacheDel(subjectId) {
        if (typeof localCacheDel !== 'function') return;
        try { localCacheDel(this._bgmColCacheKey(subjectId)); } catch (e) { /* ignore */ }
    },

    /** 查询某 subject 的收藏状态（返回 {type, ep_status...} 或 null）。
     *  先读本地缓存（未过期且 token 一致）：详情页打开即上屏，零网络等待；
     *  未命中才回源 GET，回源成功后写缓存。opts.force 时跳过缓存强制回源
     *  （写操作后核对、详情页后台对账用），回源成功后回写缓存。 */
    async getBangumiCollection(subjectId, opts = {}) {
        const token = await this._getBangumiToken();
        if (!token) return null;
        const key = String(subjectId);
        if (!opts.force) {
            const hit = this._bgmColCacheRead(key);
            if (hit && typeof hit === 'object' && hit.token === String(token)
                && (Date.now() - Number(hit.ts || 0)) < this._bgmColCacheTTL) {
                return (hit.col === undefined || hit.col === null) ? null : hit.col;
            }
        }
        try {
            const rsp = await doAction('kazumiBangumiCollectionGet', { token, id: subjectId }, '/kazumi/action');
            const col = (rsp && rsp.collection) || null;
            if (col) {
                this._bgmColCacheWrite(key, col, token);
            } else {
                // null 可能是「未收藏」也可能是上游 401/网络失败（服务端不可区分）：
                // 只允许短负缓存，防止一次瞬时失败把「未收藏」冻结整段 TTL
                this._bgmColCacheWrite(key, null, token, this._bgmColCacheNegTTL);
            }
            return col;
        } catch (e) { return null; }
    },

    /** 查询并回填详情页/弹窗里某 subject 的 Bangumi 收藏状态（高亮对应按钮）。
     *  P3-17：data-id 写入侧是 escHtml(原始值)（HTML 属性内安全），DOM 解码后的
     *  属性值即原始值；反查选择器必须用 CSS.escape(原始值) 才与之匹配——拼 escHtml
     *  后的串会在 id 含 &/'/"/<> 时失配，且未转义 \ 与 ] 直接构成非法选择器。
     *  详情页单按钮模式（detail.js）：同步把当前状态文案写到 #detail-col-current，
     *  并把收藏接口回传的 ep_status（看到第 N 话）显示到统计区底部 .detail-watch-progress
     *  进度行。opts.force：跳过 6h 收藏缓存强制回源（详情页打开时的进度对账用——缓存里的
     *  ep_status 可能落后于远端：他设备打点、或上次打点成功但未走缓存更新路径），
     *  拉到新数据回写缓存后重算进度行。进度行选择器是全局 $('.detail-watch-progress')，
     *  写入前以 isCurDetail（Detail._bgmId 与 sid 归一比对）限定仅当前详情页可写，
     *  防止弹窗等场景把别的条目进度写到当前页 .detail-watch-progress 上。 */
    async _applyBangumiColState(subjectId, opts = {}) {
        const sid = String(subjectId);
        const col = await this.getBangumiCollection(sid, opts);
        const sel = CSS.escape(sid);
        const wrap = $(`.kazumi-col-btns[data-id="${sel}"]`);
        if (!wrap.length) return;
        wrap.find('.kazumi-col-btn').removeClass('active');
        // type 可能为数字或字符串（不同 API/镜像响应形态）；统一 Number 归一，
        // 否则字符串 type 会走 -1 分支导致设置成功后按钮不高亮，用户误判为「失败」。
        const t = col ? Number(col.type) : NaN;
        const cur = Number.isFinite(t) ? t : -1;
        wrap.find(`.kazumi-col-btn[data-type="${CSS.escape(String(cur))}"]`).addClass('active');
        // 详情页收藏单按钮：仅当前详情页的 subject 才写（弹窗路径复用本方法时不串档）
        const labels = { '-1': '未收藏', 1: '想看', 2: '看过', 3: '在看', 4: '搁置', 5: '抛弃' };
        const single = $('#detail-col-current');
        const isCurDetail = (typeof Detail === 'undefined') || !Detail._bgmId
            || String(Detail._bgmId) === sid;
        if (single.length && isCurDetail) {
            single.find('.detail-col-label').text(labels[cur] || '未收藏');
            // 状态图标随文案同口径切换（图标映射在 detail.js，跨文件复用）
            if (typeof Detail !== 'undefined' && Detail._colStateIcon) {
                single.find('.detail-col-state-svg').replaceWith(Detail._colStateIcon(cur));
            }
            single.attr('data-type', String(cur));
            single.toggleClass('active', cur >= 1);
        }
        // 观看进度条（统计区底部整行，方案 C）：ep_status（看到第几话，0=未看）+
        // 总话数（_bgmInfo.eps）→ 条宽百分比 + 文案。限定当前详情页的 subject；
        // 无进度/未收藏时整条隐藏（填 0 宽 + 文案清空 + display:none）。
        const progress = $('.detail-watch-progress');
        if (progress.length && isCurDetail) {
            const epsTotal = Number((typeof Detail !== 'undefined' && Detail._bgmInfo && (Detail._bgmInfo.eps || Detail._bgmInfo.total_episodes)) || 0);
            const watched = col ? (Number(col.ep_status) || 0) : 0;
            if (watched > 0) {
                const pct = epsTotal > 0 ? Math.min(100, Math.round(watched / epsTotal * 100)) : 0;
                progress.find('.detail-watch-progress-fill').css('width', pct + '%');
                // 文案精简（用户口径）：1/12；无总话数时 N/?
                progress.find('.detail-watch-progress-text').text(epsTotal > 0 ? `${watched}/${epsTotal}` : `${watched}/?`);
                progress.show();
            } else {
                progress.find('.detail-watch-progress-fill').css('width', '0%');
                progress.find('.detail-watch-progress-text').text('');
                progress.hide();
            }
        }
        // （Detail._bgmColCache 死写已移除：全仓库无读者，弹窗路径复用前不得
        //   把弹窗条目状态写到当前详情页 DOM 上）
    },

    /** 检测规则有效性：后台并发搜索测试关键词，标记 valid/invalid。 */
    async checkValidity() {
        try {
            const rsp = await doAction('kazumiCheckValidity', {}, '/kazumi/action');
            if (!rsp || !rsp.started) { warnToast('已有检测正在运行'); return; }
            warnToast('正在检测规则有效性…');
            this._pollTask('kazumiValidityStatus', (s) => {
                const results = s.results || [];
                const valid = results.filter((r) => r.validity === 'valid').length;
                const invalid = results.filter((r) => r.validity === 'invalid').length;
                const captcha = results.filter((r) => r.validity === 'captcha').length;
                warnToast(`检测完成：有效 ${valid} · 失效 ${invalid}${captcha ? ` · 需验证 ${captcha}` : ''}`, { summary: true });
                this.refreshRuleList();
            }, '检测有效性');
        } catch (e) {
            warnToast('检测启动失败');
        }
    },

    /**
     * 批量更新：从商店拉取规则最新版（4 并发，后端实现）。
     * names 缺省 = 原入口行为（全部已安装规则，确认文案保持不变）；
     * 传名称数组 = 只更新子集（批量管理选中项；后端 kazumiBatchUpdate 的
     * names 逗号分隔协议），确认文案写明条数。
     * 返回是否成功启动，调用方（批量管理）据此决定是否退出批量模式。
     */
    async batchUpdate(names) {
        const subset = Array.isArray(names) ? names.map((n) => String(n == null ? '' : n).trim()).filter(Boolean) : [];
        const scope = subset.length ? `选中的 ${subset.length} 条` : '所有已安装';
        if (!await confirmDialog(`将从规则商店批量检查并更新${scope}规则，继续？`, { okText: '更新' })) return false;
        try {
            const rsp = await doAction('kazumiBatchUpdate', subset.length ? { names: subset.join(',') } : {}, '/kazumi/action');
            if (!rsp || !rsp.started) { warnToast('已有批量更新正在运行'); return false; }
            warnToast('正在批量更新规则…');
            this._pollTask('kazumiUpdateStatus', (s) => {
                const results = s.results || [];
                const updated = results.filter((r) => r.updated).length;
                const upToDate = results.filter((r) => r.ok && !r.updated).length;
                const failed = results.filter((r) => !r.ok).length;
                warnToast(`更新完成：更新 ${updated} · 已最新 ${upToDate}${failed ? ` · 失败 ${failed}` : ''}`);
                this.refreshRuleList();
            }, '批量更新');
            return true;
        } catch (e) {
            warnToast('批量更新启动失败');
            return false;
        }
    },

    /** 轮询后台任务状态直至结束（running=false），回调收到最终状态。
     *  运行期间用 renderStatusBar 驱动进度条（后端返回 done/total 时显示 N/M，否则退化为不确定态）；
     *  完成后短暂显示完成态再隐藏。label 用作进度条文字（如「检测有效性」「批量更新」）。 */
    _pollTask(statusDo, onDone, label) {
        const el = $('#kazumi_rule_task');
        const text = label || '任务进行中';
        const bar = (opts) => { if (el.length) { renderStatusBar(el, opts); el.show(); } };
        const hide = () => { if (el.length) el.hide(); };
        const iv = setInterval(async () => {
            try {
                const rsp = await doAction(statusDo, {}, '/kazumi/action');
                if (!rsp) return;
                if (rsp.running) {
                    // done/total 由后端逐条累加暴露；缺失时 total=0 → 不确定态进度条
                    bar({ text, recv: rsp.done || 0, total: rsp.total || 0 });
                    return;
                }
                clearInterval(iv);
                // 完成态：满条显示片刻再隐藏（与首页探测条一致的收尾体验）
                bar({ text: `${text}完成`, done: true, total: rsp.total || 0 });
                setTimeout(hide, 1500);
                if (onDone) onDone(rsp);
            } catch (e) {
                clearInterval(iv);
                hide();
                warnToast('任务查询失败');
            }
        }, 1200);
    },

    /** 是否存在已启用规则（详情页/搜索页据此显示入口）。 */
    hasEnabledRules() {
        return this._rulesLoaded && this._rules.some((r) => r.enabled !== false);
    },

    // ---------------------------------------------------------------- 聚合搜索

    /** 聚合搜索全部启用规则（search.js 调用；glm5.2 后端端点）。 */
    async aggregateSearch(keyword) {
        try {
            const rsp = await doAction('kazumiSearch', { keyword }, '/kazumi/action');
            return (rsp && rsp.results) || [];
        } catch (e) {
            return [];
        }
    },

    // ---------------------------------------------------------------- Bangumi 元数据

    /** Bangumi 番剧搜索（用于详情页元数据补全）。 */
    async bangumiSearch(keyword) {
        try {
            const rsp = await doAction('kazumiBangumiSearch', { keyword, limit: 5 }, '/kazumi/action');
            return (rsp && rsp.results) || [];
        } catch (e) {
            return [];
        }
    },

    // ---------------------------------------------------------------- Bangumi 封面缓存（搜索页 Kazumi 结果）

    /** name → Bangumi 首个匹配 {id, cover} 缓存（内存 Map + localStorage 持久化）。 */
    _bgmMatchCache: new Map(),
    /** name → Promise：同片名并发搜索去重，只发一次 API。 */
    _bgmMatchInflight: new Map(),

    /** 从 localStorage 加载匹配缓存（Kazumi.init 时调用一次；数据损坏按空缓存处理）。 */
    _loadBgmMatchCache() {
        this._bgmMatchCache = new Map();
        try {
            const raw = localStorage.getItem('kazumi_bgm_cover');
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return;
            arr.forEach((kv) => {
                if (!Array.isArray(kv) || !kv[0]) return;
                const v = kv[1];
                if (typeof v === 'string') {
                    // 旧版仅封面格式 [name, url] 迁移：无 id，点击时仍会补搜一次并回填。
                    // 旧缓存存的是 large URL，网格卡用会在 1080p 降采样锯齿（T75）→ 迁移到 card 变体。
                    if (v) this._bgmMatchCache.set(kv[0], { id: 0, cover: this._migrateCover(v) });
                } else if (v && v.id && v.cover) {
                    // 只接纳完整条目：id 无封面的残缺条目（搜索点击回填产生）不加载，
                    // 让 getBangumiMatch 按 id 拉详情自愈，不再被旧缓存永久卡死。
                    // 卡片展示字段（评分/排名/日期）随条目透传；远端可控数值读侧重归一
                    //（写侧 cacheBangumiMatch/_bgmMetaOf 已归一，此处兜旧版本脏数据）。
                    const meta = this._bgmMetaOf(v);
                    this._bgmMatchCache.set(kv[0], {
                        id: Number(v.id) || 0,
                        cover: this._migrateCover(v.cover || ''),
                        ...meta,
                    });
                }
            });
        } catch (e) { /* 损坏则忽略 */ }
    },

    /** 旧缓存封面迁移（T75）：历史存的是 large 尺寸 lain.bgm.tv URL，网格卡用会在 1080p
     *  降采样锯齿。用共享 bangumiCover(string) 走路径段替换降级到 common；非该格式原样返回。 */
    _migrateCover(url) {
        return (typeof bangumiCover === 'function') ? bangumiCover(String(url || ''), 'card') : String(url || '');
    },

    /** 从 Bangumi 条目提取卡片展示字段（评分/排名/播出日期）：搜索页 Kazumi 卡
     *  对齐 Bangumi 搜索卡样式（bangumiCard）所消费的最小字段集。远端可控数值
     *  一律 Number 归一（对齐 #11 防御口径），无值落 0/空串不渲染。
     *  写侧 cacheBangumiMatch 存扁平字段（score/rank/air_date 在条目顶层而非
     *  rating 下），读侧归一须兼容两种形态，否则重启后评分/排名被清零回写。 */
    _bgmMetaOf(item) {
        const rating = (item && item.rating && typeof item.rating === 'object') ? item.rating : {};
        const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
        return {
            score: num(rating.score) || num(item && item.score),
            rank: num(rating.rank) || num(item && item.rank),
            air_date: String((item && (item.air_date || item.date)) || ''),
            // 总话数：搜索页 Kazumi 卡补集数徽章（对齐时间表/推荐卡话数徽章）用
            eps: num(item && (item.eps || item.total_episodes)),
        };
    },

    /** 持久化匹配缓存（无 id 且无封面的空结果不落盘：下次会话可重试；只留最近 500 条防无限增长）。
     *  只持久化 id+封面齐全的完整条目——缺封面的残缺条目（点击回填时首条结果无 images）
     *  落盘会在重启后继续占位且 60s 负缓存救不了它，历史上这正是「封面永久丢失」的根源。 */
    _saveBgmMatchCache() {
        try {
            const entries = [];
            for (const [k, v] of this._bgmMatchCache) {
                if (v && v.id && v.cover) entries.push([k, v]);
            }
            localStorage.setItem('kazumi_bgm_cover', JSON.stringify(entries.slice(-500)));
        } catch (e) { /* quota 溢出忽略 */ }
    },

    /** 清空 Bangumi 匹配缓存（内存 + localStorage + 全局补拉缓存；设置页按钮，封面匹配错误时手动重置）。 */
    async clearBangumiCoverCache() {
        if (!await confirmDialog('确定清空 Bangumi 封面缓存？清空后需重新搜索才会重新拉取封面。', { okText: '清空' })) return;
        this._bgmMatchCache = new Map();
        this._bgmMatchInflight.clear();
        try { localStorage.removeItem('kazumi_bgm_cover'); } catch (e) { /* ignore */ }
        // 全局封面补拉缓存（common.js _coverCache）一并清空：否则列表重绘仍直接
        // 复用已缓存的旧封面 URL，表现为「清理后封面不刷新」
        try { if (typeof _coverCache !== 'undefined' && typeof _coverCache.clear === 'function') _coverCache.clear(); } catch (e) { /* ignore */ }
        warnToast('已清空 Bangumi 封面缓存，重新搜索即刷新');
    },

    /** 同步取已缓存 Bangumi 匹配（渲染/点击复用，避免重复搜索）；未命中或空匹配返回 null。 */
    getCachedBangumiMatch(name) {
        const key = String(name || '').trim();
        if (!key) return null;
        const m = this._bgmMatchCache.get(key);
        return (m && (m.id || m.cover)) ? m : null;
    },

    /** 同步取已缓存封面（渲染时直接复用，避免占位→补拉闪烁）；未命中返回 ''。 */
    getCachedBangumiCover(name) {
        const m = this.getCachedBangumiMatch(name);
        return (m && m.cover) || '';
    },

    /** 兼容 common.js 补拉池：只取封面 URL。 */
    async getBangumiCover(name) {
        const m = await this.getBangumiMatch(name);
        return (m && m.cover) || '';
    },

    /**
     * 按片名从 Bangumi 拉取首个匹配 {id, cover} 并缓存（搜索页 Kazumi 结果补封面用）。
     * 命中缓存直接返回；同片名在途搜索只发一次请求。id+封面齐全的匹配长期缓存；
     * 空匹配/缺封面条目只做 60s 短期负缓存——此前空对象在整个会话内不再重试，且
     * 搜索页点击回填的 {id, cover:''} 残缺条目（首条结果无 images 时产生）被当成
     * 完整命中永久短路，历史页 kazumi 封面一次失败后只能去设置清缓存。现改为：
     * 完整命中要求 id 与 cover 都有；缺封面但带 id 的条目先按 id 拉详情补图，
     * 失败再按片名重搜。
     */
    async getBangumiMatch(name) {
        const key = String(name || '').trim();
        if (!key) return null;
        const cached = this._bgmMatchCache.get(key);
        if (cached && cached.id && cached.cover) return cached;
        if (cached && cached.negAt && (Date.now() - cached.negAt) < 60000) return cached;
        if (cached) this._bgmMatchCache.delete(key); // 过期负缓存/残缺条目：删除后重新拉取
        if (this._bgmMatchInflight.has(key)) return this._bgmMatchInflight.get(key);
        const p = (async () => {
            let match = { id: 0, cover: '' };
            try {
                // 残缺条目自愈：旧缓存有 id 无封面时按 id 拉详情取 images，
                // 免按片名重搜（两次搜索首条可能不同部，导致封面与详情错位）
                if (cached && cached.id) {
                    try {
                        const info = await this.bangumiInfo(cached.id);
                        if (info && info.id) {
                            const cv = bangumiCover(info.images, 'card');
                            if (cv) match = { id: Number(info.id) || 0, cover: cv, ...this._bgmMetaOf(info) };
                        }
                    } catch (e) { /* 详情失败回退按名重搜 */ }
                }
                if (!(match.id && match.cover)) {
                    const results = await this.bangumiSearch(key, 5);
                    const first = (results || []).find((r) => r && r.images
                        && (r.images.large || r.images.common || r.images.medium));
                    if (first) {
                        match = {
                            // 缓存供卡片补封面用（records/search/补拉均为网格卡）→ 存 card 尺寸变体，
                            // 避免 1080p 用 large 大幅降采样出现锯齿（T75）。
                            id: Number(first.id) || 0,
                            cover: bangumiCover(first.images, 'card'),
                            // 卡片展示字段（评分/排名/播出日期）：搜索页 Kazumi 卡对齐
                            // Bangumi 搜索卡样式（⭐评分 · 日期备注 + #N 排名角标）所必需
                            ...this._bgmMetaOf(first),
                        };
                    }
                }
            } catch (e) { /* 搜索失败按空匹配 */ }
            if (!(match.id && match.cover)) match = { id: 0, cover: '', negAt: Date.now() };
            this._setBgmMatch(key, match);
            this._saveBgmMatchCache();
            this._bgmMatchInflight.delete(key);
            return match;
        })();
        this._bgmMatchInflight.set(key, p);
        return p;
    },

    /** 记录一次 Bangumi 匹配（点击搜索结果回填缓存，补 id 或封面后下次免搜；幂等）。
     *  cover 允许为空（首条结果无 images）：条目只在内存中，getBangumiMatch 会按
     *  id 拉详情自愈补图，且不会被 _saveBgmMatchCache 持久化成毒缓存。
     *  meta 可选携带评分/排名/播出日期展示字段（搜索页点击路径由 r0 直接展开传入），
     *  缺省时保留既有值不回退（补 id 后按 id 拉详情自愈路径会一并补齐）。 */
    cacheBangumiMatch(name, id, cover, meta) {
        const key = String(name || '').trim();
        if (!key || !id) return;
        const cur = this.getCachedBangumiMatch(key) || {};
        const m = { id: Number(id) || cur.id || 0, cover: cover || cur.cover || '' };
        const metaNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
        const mt = (meta && typeof meta === 'object') ? meta : {};
        m.score = metaNum(mt.score) || metaNum(cur.score) || 0;
        m.rank = metaNum(mt.rank) || metaNum(cur.rank) || 0;
        m.air_date = String(mt.air_date || cur.air_date || '');
        m.eps = metaNum(mt.eps) || metaNum(cur.eps) || 0;
        this._setBgmMatch(key, m);
        this._saveBgmMatchCache();
    },

    /** 写入 Bangumi 匹配缓存并守容量上限（Map 插入序即淘汰序）。
     *  回归背景（2026-09 审查）：持久化侧一直有 slice(-500) 截断，内存 Map 却只 set
     *  不淘汰——长时间会话里浏览/搜索越多增长越多。同文件其它缓存都做了容量控制
     *  （_bgmEpCache > 32、common.js _coverCache > 2000、records.js _localCoverCap 500），
     *  这是唯一漏掉的一个。上限与持久化侧的 500 对齐，避免内存里留一批永远不会被存盘的条目。 */
    _setBgmMatch(key, match) {
        this._bgmMatchCache.set(key, match);
        const BGM_MATCH_CAP = 500;
        while (this._bgmMatchCache.size > BGM_MATCH_CAP) {
            const oldest = this._bgmMatchCache.keys().next();
            if (oldest.done) break;
            this._bgmMatchCache.delete(oldest.value);
        }
    },

    /** Bangumi 番剧详情。30 分钟 TTL 缓存（T74：详情页/弹窗/二级页重复打开免重复请求）。
     *  迁移到 localStorage 持久缓存（cache.js），重启仍即时上屏；纳入设置页「清理缓存」。 */
    _bgmInfoCacheKey(subjectId) { return 'detail::bgminfo::v1::' + String(subjectId); },

    /** 同步窥探 bangumiInfo 的 localStorage 缓存（不回源）：openBangumi 据此判断
     *  「缓存命中即毫秒级出完整版面」从而跳过快照半渲染（与 CatVod 路径 open() 读
     *  详情 vod 缓存命中即跳快照同一口径）。与 bangumiInfo 的读路径同键同净化，
     *  仅供存在性判断，不把结果交给调用方使用（权威数据仍由 bangumiInfo 返回）。 */
    peekCachedBangumiInfo(subjectId) {
        const key = String(subjectId || '');
        if (!key || typeof localCacheGet !== 'function') return false;
        try {
            const hit = this._sanitizeBangumiInfo(localCacheGet(this._bgmInfoCacheKey(key)));
            return !!(hit && hit.id);
        } catch (e) { return false; }
    },
    /**
     * Bangumi info 净化（安全审查 P2-3 放大项）：后端对 Bangumi 镜像响应原样透传、
     * 无字段校验，恶意镜像可借 info 携带注入 payload；此缓存写入 localStorage 存
     * 30 分钟，切回官方源后恶意内容仍会短暂回灌渲染。持久化前按字段白名单净化：
     * 只保留渲染链路实际消费的字段，字符串字段存原文（所有渲染消费点均经 escHtml
     * 或 stripHtml，此处转义会双重转义），数值字段一律 Number 归一（字符串形态的
     * payload 直接丢失），未知字段丢弃。读写两侧都过净化：读侧兜底旧版本写入的
     * 未净化缓存条目。
     */
    _sanitizeBangumiInfo(info) {
        if (!info || typeof info !== 'object') return null;
        const str = (v) => (v == null ? '' : String(v));
        const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
        const images = (info.images && typeof info.images === 'object') ? info.images : {};
        const rating = (info.rating && typeof info.rating === 'object') ? info.rating : {};
        const count = (rating.count && typeof rating.count === 'object') ? rating.count : {};
        const out = {
            id: num(info.id),
            name: str(info.name),
            name_cn: str(info.name_cn),
            date: str(info.date),
            air_date: str(info.air_date),
            platform: str(info.platform),
            type_name: str(info.type_name),
            summary: str(info.summary),
            images: {},
            rating: { score: num(rating.score), total: num(rating.total), rank: num(rating.rank), count: {} },
            tags: [],
            // 头部增强字段：总话数（eps/total_episodes 同义，兼容两种口径）与
            // 收藏人数统计 {wish,collect,doing,on_hold,dropped}（Kazumi InfoPage 同款）
            eps: num(info.eps !== null && info.eps !== undefined ? info.eps : info.total_episodes),
            total_episodes: num(info.total_episodes !== null && info.total_episodes !== undefined ? info.total_episodes : info.eps),
            collection: {},
        };
        if (info.collection && typeof info.collection === 'object') {
            for (const k of ['wish', 'collect', 'doing', 'on_hold', 'dropped']) {
                const v = num(info.collection[k]);
                if (v > 0) out.collection[k] = v;
            }
        }
        for (const k of ['large', 'common', 'medium', 'small', 'grid']) {
            if (images[k]) out.images[k] = str(images[k]);
        }
        for (let i = 1; i <= 10; i++) {
            const v = num(count[i] != null ? count[i] : count[String(i)]);
            if (v > 0) out.rating.count[i] = v;
        }
        if (Array.isArray(info.tags)) {
            for (const t of info.tags.slice(0, 64)) {
                if (t && typeof t === 'object' && t.name) out.tags.push({ name: str(t.name), count: num(t.count) });
                else if (t && typeof t !== 'object' && str(t).trim()) out.tags.push(str(t));
            }
        }
        return out;
    },
    async bangumiInfo(subjectId) {
        const key = String(subjectId);
        if (key && typeof localCacheGet === 'function') {
            try { const hit = this._sanitizeBangumiInfo(localCacheGet(this._bgmInfoCacheKey(key))); if (hit && hit.id) return hit; } catch (e) { /* ignore */ }
        }
        try {
            const rsp = await doAction('kazumiBangumiInfo', { id: subjectId }, '/kazumi/action');
            const info = this._sanitizeBangumiInfo((rsp && rsp.info) || null);
            if (info && info.id && key && typeof localCacheSet === 'function') {
                try { localCacheSet(this._bgmInfoCacheKey(key), info, 30 * 60 * 1000); } catch (e) { /* 缓存失败忽略 */ }
            }
            return info;
        } catch (e) {
            return null;
        }
    },

    /** 批量番剧详情（封面话数徽章整页一次往返）：ids 去重后先过 localStorage
     *  逐 id 缓存（键/净化/TTL 与单条 bangumiInfo 完全一致，缓存命中零网络），
     *  缺失部分合并成一次 kazumiBangumiInfoBatch（后端再逐 id 复用磁盘缓存 +
     *  并发回源）。同一帧内重复调用共享同一在途 Promise（防并发重复打包请求）；
     *  单条失败/缺值为 null 不拖垮整批。 */
    async bangumiInfoBatch(subjectIds) {
        const uniq = [];
        const seen = new Set();
        for (const raw of (subjectIds || [])) {
            const id = String(raw || '').trim();
            if (id && !seen.has(id)) { seen.add(id); uniq.push(id); }
        }
        if (!uniq.length) return {};
        const out = {};
        const missing = [];
        for (const id of uniq) {
            if (typeof localCacheGet === 'function') {
                try {
                    const hit = this._sanitizeBangumiInfo(localCacheGet(this._bgmInfoCacheKey(id)));
                    if (hit && hit.id) { out[id] = hit; continue; }
                } catch (e) { /* 缓存读失败走回源 */ }
            }
            missing.push(id);
        }
        if (!missing.length) return out;
        const batchKey = missing.join(',');
        // 在途去重：同帧多个调用方（换页连点/多网格）共享同一次批量请求
        this._bgmInfoBatchPending = this._bgmInfoBatchPending || new Map();
        let pending = this._bgmInfoBatchPending.get(batchKey);
        if (!pending) {
            pending = doAction('kazumiBangumiInfoBatch', { ids: batchKey }, '/kazumi/action')
                .then((rsp) => {
                    const raw = (rsp && rsp.infos) || {};
                    const clean = {};
                    for (const id of missing) {
                        const info = this._sanitizeBangumiInfo(raw[id] || null);
                        clean[id] = info;
                        if (info && info.id && typeof localCacheSet === 'function') {
                            try { localCacheSet(this._bgmInfoCacheKey(id), info, 30 * 60 * 1000); } catch (e) { /* 忽略 */ }
                        }
                    }
                    return clean;
                })
                .finally(() => { this._bgmInfoBatchPending.delete(batchKey); });
            this._bgmInfoBatchPending.set(batchKey, pending);
        }
        const fetched = await pending.catch(() => ({})); // 网络失败：吞掉，保底返回缓存命中部分
        return Object.assign(out, fetched);
    },

    /** Bangumi 分集缓存键（独立前缀，对齐 kazumi_bgm_cover 命名习惯）。 */
    _bgmEpsLsKey(subjectId) { return 'kazumi_bgm_eps::' + String(subjectId); },

    /** Bangumi 分集信息。localStorage 持久缓存（cache.js）30 分钟（对齐 bangumiInfo
     *  缓存口径）：「分集」页签/起播补拉重复进出免重拉，二次打开秒出。
     *  - 命中后校验形态（后端透传 Bangumi /v0/episodes 包装对象 {data,total}，或裸数组），
     *    畸形缓存丢弃走网络；
     *  - 网络成功返回才落缓存（失败 resolve(null) 不写），resolve/reject 语义与加缓存前完全一致。
     *    注意：{code:200, episodes:{data:[],total:0}} 空包装是后端透传的合法数据（真实无分集条目），
     *    会随 30min TTL 正常落盘——这是缓存行为而非毒化；消费侧（分集页签/起播集名）对空 data 均有兜底。 */
    async bangumiEpisodes(subjectId) {
        const key = String(subjectId);
        if (key && typeof localCacheGet === 'function') {
            try {
                const hit = localCacheGet(this._bgmEpsLsKey(key));
                if (Array.isArray(hit) || (hit && Array.isArray(hit.data))) return hit;
            } catch (e) { /* ignore */ }
        }
        try {
            const rsp = await doAction('kazumiBangumiEpisodes', { id: subjectId }, '/kazumi/action');
            const eps = (rsp && rsp.episodes) || null;
            if (eps && key && typeof localCacheSet === 'function') {
                try { localCacheSet(this._bgmEpsLsKey(key), eps, 30 * 60 * 1000); } catch (e) { /* 缓存失败忽略 */ }
            }
            return eps;
        } catch (e) {
            return null;
        }
    },

    /** Bangumi 番剧角色信息。 */
    async bangumiCharacters(subjectId) {
        try {
            const rsp = await doAction('kazumiBangumiCharacters', { id: subjectId }, '/kazumi/action');
            return (rsp && rsp.characters) || [];
        } catch (e) {
            return [];
        }
    },

    /** Bangumi 单个角色详情。localStorage 持久缓存（cache.js）30 分钟：角色详情浮层重复打开免重拉。 */
    async bangumiCharacter(characterId) {
        const key = String(characterId);
        if (key && typeof localCacheGet === 'function') {
            try { const hit = localCacheGet('detail::char::v1::' + key); if (hit) return hit; } catch (e) { /* ignore */ }
        }
        try {
            const rsp = await doAction('kazumiBangumiCharacter', { id: characterId }, '/kazumi/action');
            const info = (rsp && rsp.info) || null;
            if (info && key && typeof localCacheSet === 'function') {
                try { localCacheSet('detail::char::v1::' + key, info, 30 * 60 * 1000); } catch (e) { /* 缓存失败忽略 */ }
            }
            return info;
        } catch (e) {
            return null;
        }
    },

    /** Bangumi 番剧评论（吐槽）。返回 {list, total}：list 为评论数组（字段
     *  {user:{nickname}, comment, updatedAt} 保留原样交前端渲染），total 为该条目
     *  吐槽总数（来自 next.bgm 响应，与 limit/offset 无关；后端兼容旧裸数组/失败
     *  形态，缺省回退已加载数）。旧调用方直接消费数组时用 .list。 */
    async bangumiComments(subjectId, limit, offset) {
        try {
            const rsp = await doAction('kazumiBangumiComments', { id: subjectId, limit: limit || 20, offset: offset || 0 }, '/kazumi/action');
            const c = (rsp && rsp.comments);
            if (c && typeof c === 'object' && !Array.isArray(c)) {
                const list = Array.isArray(c.list) ? c.list : Array.isArray(c.data) ? c.data : [];
                const total = Number(c.total) || 0;
                return { list, total: Math.max(total, list.length) };
            }
            // 旧后端/直连形态：数组或 {data:[...]} 包装，无独立 total
            const list = Array.isArray(c) ? c
                : (c && Array.isArray(c.data)) ? c.data
                    : (c && Array.isArray(c.list)) ? c.list : [];
            return { list, total: list.length };
        } catch (e) {
            return { list: [], total: 0 };
        }
    },

    /** Bangumi 分集评论（选集讨论）。归一化为数组（同 bangumiComments 口径）；
     *  字段 {user:{nickname}, content, createdAt, replies[]}。
     *  localStorage 持久缓存（cache.js）10 分钟：与后端 kazumiBangumiEpisodeComments
     *  的 TTL 同级，切集往返免重复整段请求。 */
    async bangumiEpisodeComments(episodeId) {
        const key = String(episodeId);
        if (key && typeof localCacheGet === 'function') {
            try {
                const hit = localCacheGet('detail::epcmt::v1::' + key);
                if (Array.isArray(hit)) return hit;
            } catch (e) { /* ignore */ }
        }
        try {
            const rsp = await doAction('kazumiBangumiEpisodeComments', { episodeId: key }, '/kazumi/action');
            const c = (rsp && rsp.comments);
            let list = [];
            if (Array.isArray(c)) list = c;
            else if (c && Array.isArray(c.data)) list = c.data;
            else if (c && Array.isArray(c.list)) list = c.list;
            if (list.length && key && typeof localCacheSet === 'function') {
                try { localCacheSet('detail::epcmt::v1::' + key, list, 10 * 60 * 1000); } catch (e) { /* 缓存失败忽略 */ }
            }
            return list;
        } catch (e) {
            return [];
        }
    },

    /** Bangumi 角色吐槽。归一化为数组（同 bangumiComments）；字段 {user:{nickname}, content, createdAt}。
     *  localStorage 持久缓存（cache.js）30 分钟：角色详情浮层「吐槽」页签重复打开免重拉。 */
    async bangumiCharacterComments(characterId) {
        const key = String(characterId);
        if (key && typeof localCacheGet === 'function') {
            try { const hit = localCacheGet('detail::charcmt::v1::' + key); if (Array.isArray(hit)) return hit; } catch (e) { /* ignore */ }
        }
        try {
            const rsp = await doAction('kazumiBangumiCharacterComments', { id: characterId }, '/kazumi/action');
            const c = (rsp && rsp.comments);
            let list = [];
            if (Array.isArray(c)) list = c;
            else if (c && Array.isArray(c.data)) list = c.data;
            else if (c && Array.isArray(c.list)) list = c.list;
            if (list.length && key && typeof localCacheSet === 'function') {
                try { localCacheSet('detail::charcmt::v1::' + key, list, 30 * 60 * 1000); } catch (e) { /* 缓存失败忽略 */ }
            }
            return list;
        } catch (e) {
            return [];
        }
    },

    /** Bangumi 番剧制作人员。 */
    async bangumiStaff(subjectId) {
        try {
            const rsp = await doAction('kazumiBangumiStaff', { id: subjectId }, '/kazumi/action');
            return (rsp && rsp.staff) || [];
        } catch (e) {
            return [];
        }
    },

    /** Bangumi 番剧关联（前传/续作链）。 */
    async bangumiRelations(subjectId) {
        try {
            const rsp = await doAction('kazumiBangumiRelations', { id: subjectId }, '/kazumi/action');
            return (rsp && rsp.relations) || [];
        } catch (e) {
            return [];
        }
    },

    // ---------------------------------------------------------------- 详情页 Kazumi 源弹窗

    /**
     * 打开 Kazumi 源弹窗（detail.js / search.js 调用）。
     * 对齐 Kazumi SourceSheet（T74）：并发流式搜索全部启用源（复用 /search/kazumi-stream SSE），
     * 每源一张卡片带状态徽标（检索中/N 条/需验证/失败/无结果），首个有结果源自动展开；
     * 点结果行解析选集播放；空/失败/验证码源卡内补救操作（重试/别名/手动检索/浏览器打开）。
     * 「别名检索」：手动检索里换词搜出结果的关键词会沉淀成该番剧的别名，标题轮一个
     * 可用源都没有时按别名顺序重试（见下方 _alias* 一组）。调用方可传 opts.subjectId
     * 用 Bangumi id 做别名键（更稳）；不传则按片名归一化做键。
     * @param title 影片名
     * @param site  来源标识（kazumi:规则名 或 CatVod site key）
     * @param src    Kazumi 搜索结果链接（kazumi: 前缀时作为默认选中，直接解析该源）
     * @param opts  { subjectId?, downloadEpisodes?, downloadIndexes?, downloadTitle?, playIndexes? }
     */
    async openSourceDialog(title, site, src, opts) {
        if (!this.hasEnabledRules()) { warnToast('尚未启用任何 Kazumi 规则'); return; }
        const token = ++this._dlgToken;
        // 下载模式：从 Bangumi 分集多选下载而来，选定源+线路后按集号批量下载而非播放
        this._dlDownloadMode = (opts && Array.isArray(opts.downloadEpisodes) && opts.downloadEpisodes.length)
            ? { episodes: opts.downloadEpisodes.map(String), indexes: Array.isArray(opts.downloadIndexes) ? opts.downloadIndexes.slice() : null, title: opts.downloadTitle || title }
            : null;
        // 勾选集播放模式（Bangumi 分集页签勾选播放而来）：选定源+线路后，
        // 播放器队列只包含勾选下标的子集（按线路集数下标过滤）
        this._playSubset = (opts && Array.isArray(opts.playIndexes) && opts.playIndexes.length)
            ? { indexes: opts.playIndexes.slice() }
            : null;
        $('#kazumi-dialog-title').text(this._dlDownloadMode ? '选择下载源' : '选择播放源');
        openDialog('kazumiSourceDialog');

        // 来自搜索结果（kazumi: 前缀）→ 直接解析该源剧集。同时预建全源选源状态
        // （全部 pending、不启动流式检索）：选集视图「← 返回选源」有处可回
        // （回全源卡片列表再点「重新检索/手动检索」），单源重查结果也能正常上卡。
        if (String(site).startsWith('kazumi:') && src) {
            const pluginName = String(site).slice(7);
            const plugins = Object.create(null);
            this._rules.filter((r) => r.enabled !== false && r.validity !== 'invalid').forEach((r) => {
                plugins[r.name] = { status: 'pending', results: [], captchaUrl: '', msg: '', searching: false };
            });
            const st = { title, token, keyword: title, plugins, expanded: pluginName };
            this._dlgState = st;
            // 直达分支不检索，但别名状态照常预热：选集视图「← 返回选源」后头部计数
            // 与别名管理入口才有数据。不 await：别让 settingsGet 挡剧集解析。
            this._aliasPrepare(st, opts);
            await this._loadChapters(pluginName, src, title, token);
            return;
        }

        // 初始化源状态：每张可用规则一张卡（pending）；已判定失效的源（validity === 'invalid'）
        // 不建卡即在选源弹窗中隐藏，后端 /search/kazumi-stream 同步跳过该类源。
        // 字典用无原型对象：规则名（即键）来自外部规则文件，名为 "__proto__" 时
        // 普通对象 {} 赋值会污染 Object.prototype，Object.create(null) 不受影响
        const plugins = Object.create(null);
        this._rules.filter((r) => r.enabled !== false && r.validity !== 'invalid').forEach((r) => {
            plugins[r.name] = { status: 'pending', results: [], captchaUrl: '', msg: '', searching: false };
        });
        const st = { title, token, keyword: title, plugins, expanded: null };
        this._dlgState = st;
        // 别名表异步预热（不 await：settingsGet 是 IPC，不能让选源首屏等它）。
        // 标题轮至少要跑一轮源站网络往返，别名状态通常早就绪；st.aliasReady
        // 是回落决策处的握手点，真慢了也只是把决策等到它到为止，不会漏。
        this._aliasPrepare(st, opts);
        this._renderSourceSheet();

        // 第一轮：按原标题检索全部启用源。有别名也绝不跳过标题——别名可能过期/
        // 是错译名，顶替标题会让本来能命中的整页直接空白；别名只做标题无果时的兜底。
        this._startDlgSearch(st, token, title, 0);
    },

    /** 关闭选源弹窗的 SSE 流。 */
    _closeDlgStream() {
        if (this._dlgStream) { try { this._dlgStream.close(); } catch (e) { /* ignore */ } this._dlgStream = null; }
    },

    /**
     * 选源弹窗关闭统一钩子：清 SSE 流 + 弹窗状态。弹窗的全部关闭路径
     * （「关闭」按钮 / Esc / 选集播放 / 批量下载的程序化 closeDialog）都收口到这里。
     * 幂等：SSE done/onerror 提前清理后重复调用无副作用。
     */
    _onSourceDlgClosed() {
        this._closeDlgStream();
        this._dlgState = null;
    },

    // ---------------------------------------------------------------- 别名检索

    /**
     * 「别名检索」数据与策略。用户在「手动检索」里换词搜出结果后，那个词被沉淀成
     * 该番剧的别名（settings 键 kazumiAliasMap，随设置持久化）；下次打开选源弹窗时
     * 先按原标题检索，**标题轮一个可用源都没有**才顺序拿别名重试。
     *
     * 为什么不跳过标题直接用别名：别名可能过期/是错译名，有别名就顶替标题会让本来
     * 能命中的整页变空白；别名只是标题失败的兜底，标题检索的既有行为完全不变。
     *
     * 键的取舍：优先 `bgm:<subjectId>`——仅当调用方经 opts.subjectId 显式传入才用；
     * 否则 `t:<归一化片名>`。不自动去抓当前详情页的 _bgmId：历史/搜索页直接开选源
     * 弹窗时，当前详情页可能还停在别的作品（Detail._bgmId 残留），会把 A 番的别名
     * 记到 B 番头上；片名键最差只是同一部番的不同译名各存一份别名，不会串味。
     */
    _aliasKeyOf(title, subjectId) {
        const raw = String(subjectId == null ? '' : subjectId).trim();
        if (/^\d+$/.test(raw) && Number(raw) > 0) return 'bgm:' + raw;
        return 't:' + this._aliasNormTitle(title);
    },

    /** 片名归一化（仅用于键与相等比较）：压空白 + 去首尾 + 拉丁字母小写。 */
    _aliasNormTitle(title) {
        return String(title == null ? '' : title).replace(/\s+/g, ' ').trim().toLowerCase();
    },

    /** 别名归一化（展示与检索都用它）：压空白 + 去首尾，保留用户输入的大小写。 */
    _aliasNorm(alias) {
        return String(alias == null ? '' : alias).replace(/\s+/g, ' ').trim();
    },

    /** 别名可用性：非空、≤60 字符、无控制字符（防超长/换行把设置文件与弹窗文案打脏）。 */
    _aliasValid(alias) {
        if (!alias || alias.length > 60) return false;
        return !/[\u0000-\u001f\u007f]/.test(alias);
    },

    /** 数值容错：非有限数一律回落 fallback（settings 可能被手改/被旧版本写成 null 字符串）。 */
    _aliasNum(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    },

    /** 单番别名列表清洗：字符串/对象两种形态都收，去重（大小写不敏感），上限 8 条
     *  （靠前的条目优先被尝试，溢出丢尾部）。脏数据一律丢，绝不抛错——别名是增强
     *  能力，settings 里任何形态的垃圾都不该把选源弹窗打挂。
     *  只认字符串本身的项：数字/布尔/null 不 `String()` 强转，否则 [42] 会变成
     *  一个别名「42」被真的拿去检索。 */
    _aliasSanitizeList(raw) {
        const src = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
        const out = [];
        const seen = new Set();
        for (const item of src) {
            if (out.length >= 8) break;
            const obj = (item && typeof item === 'object') ? item : null;
            const alias = obj ? (typeof obj.alias === 'string' ? this._aliasNorm(obj.alias) : '')
                : (typeof item === 'string' ? this._aliasNorm(item) : '');
            if (!this._aliasValid(alias)) continue;
            const low = alias.toLowerCase();
            if (seen.has(low)) continue;
            seen.add(low);
            out.push({
                alias,
                ts: this._aliasNum(obj && obj.ts, 0),
                hits: Math.max(0, Math.trunc(this._aliasNum(obj && obj.hits, 0))),
            });
        }
        return out;
    },

    /** 键数量上限（LRU）：按每个键下最大的 ts 排序，保留最新的 limit 个。别名表
     *  随使用无界增长（每个搜过的番一个键），落盘前收敛，settings.json 不会膨胀。 */
    _aliasTrimMap(map, limit) {
        const keys = Object.keys(map);
        if (keys.length <= limit) return map;
        const rank = keys.map((k) => {
            const list = Array.isArray(map[k]) ? map[k] : [];
            return { k, ts: list.reduce((m, it) => Math.max(m, this._aliasNum(it && it.ts, 0)), 0) };
        });
        rank.sort((a, b) => b.ts - a.ts); // V8 的 sort 稳定：同 ts 保持原插入序
        const out = {};
        rank.slice(0, limit).forEach((r) => { out[r.k] = map[r.k]; });
        return out;
    },

    /** 别名表清洗 + 规模上限（500 个番剧键）。读侧兜底：旧版本/手改/WebDAV 合并
     *  进来的任意形态都按「不认识就丢」处理，返回新对象，不动 settings 原值。 */
    _aliasSanitizeMap(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
        Object.keys(raw).forEach((k) => {
            if (!/^(bgm:\d+|t:.+)$/.test(k)) return; // 键形态不认识：丢（防任意键注入设置文件）
            const list = this._aliasSanitizeList(raw[k]);
            if (list.length) out[k] = list;
        });
        return this._aliasTrimMap(out, 500);
    },

    /**
     * 检索候选词：原标题永远第一顺位（见上方「别名不顶替标题」），随后按别名表
     * 顺序（表内顺序 = 优先级，新沉淀置顶）去重、最多再取 3 个。
     * 为什么截断到 3：每轮都是「一个词打全部启用源」，别名轮最多再拉 3 轮；
     * 不设上限时一条脏别名表能把一次选源变成十几轮请求，且后端搜索线程池是
     * 全局共享（16 线程），会把其它页面的检索一起拖慢。
     */
    _aliasCandidates(title, aliases) {
        const words = [];
        const out = [];
        const seen = new Set();
        const push = (w) => {
            const v = this._aliasNorm(w);
            if (!this._aliasValid(v)) return false;
            const low = v.toLowerCase();
            if (seen.has(low)) return false;
            seen.add(low);
            words.push(v);
            return true;
        };
        push(title); // 标题非法/为空时不占位，也不会混进 aliases
        const list = Array.isArray(aliases) ? aliases : [];
        for (const a of list) {
            if (out.length >= 3) break;
            const v = this._aliasNorm(a && typeof a === 'object' ? a.alias : a);
            if (push(v)) out.push(v);
        }
        return { words, aliases: out };
    },

    /** 新增别名：新词置顶（最近搜出来的词最可能仍是对的）；已存在的只更新 ts，
     *  不重排——用户手动排过的优先级不该被一次重复命中打乱。上限 8 条丢尾部。 */
    _aliasUpsert(list, alias, ts) {
        const v = this._aliasNorm(alias);
        if (!this._aliasValid(v)) return this._aliasSanitizeList(list);
        const out = this._aliasSanitizeList(list);
        const low = v.toLowerCase();
        const i = out.findIndex((it) => it.alias.toLowerCase() === low);
        if (i >= 0) { out[i] = { ...out[i], ts: this._aliasNum(ts, out[i].ts) }; return out; }
        out.unshift({ alias: v, ts: this._aliasNum(ts, 0), hits: 0 });
        return out.slice(0, 8);
    },

    /** 删除别名（大小写不敏感）。 */
    _aliasRemoveItem(list, alias) {
        const low = this._aliasNorm(alias).toLowerCase();
        return this._aliasSanitizeList(list).filter((it) => it.alias.toLowerCase() !== low);
    },

    /** 设为优先：移到表首 = 下次检索最先尝试（表内顺序即尝试顺序）。 */
    _aliasPromoteItem(list, alias) {
        const low = this._aliasNorm(alias).toLowerCase();
        const clean = this._aliasSanitizeList(list);
        const hit = clean.find((it) => it.alias.toLowerCase() === low);
        if (!hit) return clean;
        return [hit, ...clean.filter((it) => it.alias.toLowerCase() !== low)];
    },

    /** 该词是否为「别名轮词」（与原标题归一化后不同）：合并策略、命中标注、
     *  别名计数都以它为准，保证标题轮行为与改造前逐字一致。 */
    _isAliasWord(st, word) {
        const w = this._aliasNorm(word);
        if (!w || !st || !st.title) return false;
        return w.toLowerCase() !== this._aliasNormTitle(st.title);
    },

    /**
     * 是否该把这次手动检索词沉淀为别名：与原标题不同（归一化比较）+ 词合法 +
     * 该次检索确实产出了可用源。失败/空结果的词绝不入表——否则一次错别字会被
     * 永久记住，之后每次检索都替用户"重试"这个错词，越修越乱。
     */
    _aliasShouldRecord(title, word, usable) {
        if (!usable) return false;
        const w = this._aliasNorm(word);
        if (!this._aliasValid(w)) return false;
        return w.toLowerCase() !== this._aliasNormTitle(title);
    },

    /** 读别名表（容错解析，任何异常 = 空表）。不做会话级内存缓存：settings 是
     *  WebDAV 恢复/其它窗口也会改的唯一真相，每次开弹窗读一次（一个 IPC）比
     *  读回过期内存表更安全，代价相对随后的全源网络检索可忽略。 */
    async _aliasLoadMap() {
        try {
            if (!window.yuki || typeof window.yuki.settingsGet !== 'function') return {};
            const s = (await window.yuki.settingsGet()) || {};
            return this._aliasSanitizeMap(s.kazumiAliasMap);
        } catch (e) { return {}; }
    },

    /** 别名表落盘（整表写；本键只有本模块写）。失败返回 false，调用方只做轻提示。 */
    async _aliasPersist(map) {
        try {
            if (!window.yuki || typeof window.yuki.settingsSet !== 'function') return false;
            // 写侧也收敛一次键数：读侧 sanitize 只保证开弹窗那一刻的规模，长会话里
            // 逐个新番加键会慢慢越过上限，落盘前统一按 LRU 截到 500
            await window.yuki.settingsSet('kazumiAliasMap', this._aliasTrimMap(map, 500));
            return true;
        } catch (e) { return false; }
    },

    /**
     * 初始化弹窗的别名状态（不 await，见 openSourceDialog 注释）。
     * st.aliasReady 是标题轮结束时的握手点；st.aliasMap 保存本次会话的清洗后整表，
     * 增删改都在它上面做读-改-写，避免"读一次写一次"把并发写丢失。
     */
    _aliasPrepare(st, opts) {
        if (!st) return Promise.resolve();
        st.aliasKey = this._aliasKeyOf(st.title, opts && opts.subjectId);
        st.aliases = [];
        st.aliasMap = {};
        st.aliasChain = [];
        st.aliasTry = 0;
        st.attempt = 0;
        st.aliasPhase = false;
        st.aliasEdit = false;
        st.aliasHitWords = [];
        const ready = (async () => {
            const map = await this._aliasLoadMap();
            const list = this._aliasSanitizeList(map[st.aliasKey]);
            st.aliasMap = map;
            st.aliases = list;
            st.aliasChain = this._aliasCandidates(st.title, list).aliases;
        })().catch(() => { /* 别名载入失败按「无别名」处理 */ });
        st.aliasReady = ready;
        return ready;
    },

    /**
     * 起一轮整词检索（SSE）：一个 word 打全部启用源。attempt=0 标题轮，>0 别名轮。
     * 每轮一个 word，与服务端「整词索引 + 单源缓存重放」的粒度对齐：别名轮若正是
     * 用户此前手动检索过的那个词，后端直接重放缓存行（零网络请求，秒回）。
     * 故意不碰 DOM（除状态重置）：别名轮的整页重绘由 _maybeTryAlias 负责，
     * 标题轮的首屏由 openSourceDialog 负责。
     */
    _startDlgSearch(st, token, word, attempt) {
        this._closeDlgStream();
        st.keyword = word;
        st.attempt = attempt || 0;
        st.aliasPhase = st.attempt > 0;
        Object.keys(st.plugins).forEach((n) => {
            const p = st.plugins[n];
            p.searching = false;
            p.status = 'pending';
            p.results = [];
            p.captchaUrl = '';
            p.msg = '';
            p.solveHint = '';
            p.hitWord = '';
        });
        const es = new EventSource(apiUrl('/search/kazumi-stream?word=' + encodeURIComponent(word)));
        this._dlgStream = es;
        es.onmessage = (ev) => {
            let payload;
            try { payload = JSON.parse(ev.data); } catch (e) { return; }
            if (token !== this._dlgToken) return;
            this._applySourceResult(payload, word);
        };
        const finish = () => {
            if (token !== this._dlgToken) return;
            // 同一轮可能先 done 再收到关闭流触发的 onerror：只在「当前流仍是本轮」
            // 时收尾，别名轮已启动后上一轮的迟到事件全部作废
            if (this._dlgStream !== es) return;
            this._closeDlgStream();
            this._maybeTryAlias(st, token);
        };
        es.addEventListener('done', finish);
        es.onerror = () => { finish(); };
    },

    /** 本轮可用源数（状态 success 且至少 1 条结果）。 */
    _usableCount(st) {
        return Object.keys(st.plugins)
            .filter((n) => st.plugins[n].status === 'success' && (st.plugins[n].results || []).length)
            .length;
    },

    /**
     * 是否回落到别名：本轮可用源为 0（有结果就该收工，多打一轮纯属浪费），且不是
     * 「全源 error」——整层网络/后端故障换任何词都不会好，白白把失败请求翻几倍。
     * noresult / captcha / 混合结果都算「值得换词一试」。
     */
    _aliasFallbackWanted(st) {
        const names = Object.keys(st.plugins);
        if (!names.length) return false;
        const sts = names.map((n) => st.plugins[n].status);
        if (sts.some((s) => s === 'pending')) return false;
        if (this._usableCount(st) > 0) return false;
        return !sts.every((s) => s === 'error');
    },

    /**
     * 一轮检索结束后的去向：还有可用别名就换词再试，否则收尾。
     * 顺序试而非并行——命中即停，最坏 3 轮；并行会把「第一个别名就命中」也变成
     * 3 倍请求，源站与后端共享搜索池都吃不消（且结果合并反而更难解释）。
     */
    async _maybeTryAlias(st, token) {
        if (token !== this._dlgToken || this._dlgState !== st) return;
        const hit = this._usableCount(st);
        try { await st.aliasReady; } catch (e) { /* 别名载入失败 = 无别名 */ }
        if (token !== this._dlgToken || this._dlgState !== st) return;
        if (hit > 0) this._aliasNoteHit(st, st.keyword); // 命中计数（只对别名轮有意义）
        const next = (st.aliasChain || [])[st.aliasTry || 0];
        if (!next || hit > 0 || !this._aliasFallbackWanted(st)) {
            st.aliasPhase = false;
            this._aliasFlush(st); // 本轮命中的别名计数一次性落盘
            this._updateSheetHeader();
            return;
        }
        st.aliasTry = (st.aliasTry || 0) + 1;
        this._aliasFlush(st); // 上一轮若有命中先计数落盘（一次检索最多写一次 settings）
        this._startDlgSearch(st, token, next, st.aliasTry);
        this._renderSourceSheet(); // 整页重绘：所有卡回到「检索中」+ 头部标出别名词
    },

    /** 记下「这个词这轮搜出了可用源」（只有别名轮的词需要计数；内存累积，
     *  链路收尾时一次落盘——逐源写 settings 会把 IPC 打爆）。 */
    _aliasNoteHit(st, word) {
        if (!st || !Array.isArray(st.aliasChain) || st.aliasChain.indexOf(word) < 0) return;
        if (!st.aliasHitWords) st.aliasHitWords = [];
        if (st.aliasHitWords.indexOf(word) < 0) st.aliasHitWords.push(word);
    },

    /** 别名命中计数落盘（一次检索最多写一次）。失败静默：丢一次计数无伤大雅。 */
    _aliasFlush(st) {
        const words = st && st.aliasHitWords;
        if (!words || !words.length) return;
        const map = st.aliasMap || {};
        let list = this._aliasSanitizeList(map[st.aliasKey]);
        const now = Date.now();
        words.forEach((w) => {
            const low = String(w).toLowerCase();
            list = list.map((it) => (it.alias.toLowerCase() === low
                ? { ...it, hits: it.hits + 1, ts: now } : it));
        });
        if (list.length) map[st.aliasKey] = list;
        st.aliasMap = map;
        st.aliases = list;
        st.aliasHitWords = [];
        this._aliasPersist(map);
    },

    /** 别名管理面板（选源弹窗内）：查看/添加/删除/设为优先，操作即时落盘。 */
    _aliasPanelHtml(st) {
        const list = st.aliases || [];
        const chips = list.length
            ? list.map((a, i) => `<span class="kazumi-alias-chip">
                    <span class="kazumi-alias-chip-txt" title="${escHtml(a.alias)}">${escHtml(a.alias)}</span>
                    ${a.hits ? `<span class="kazumi-alias-hits" title="别名检索命中次数">${a.hits}</span>` : ''}
                    ${i ? '<button class="kazumi-alias-act" data-alias-action="front" data-alias="' + escHtml(a.alias) + '" title="设为优先（下次检索最先尝试这个别名）">↑</button>' : '<span class="kazumi-alias-first" title="已是最优先">优先</span>'}
                    <button class="kazumi-alias-act" data-alias-action="del" data-alias="${escHtml(a.alias)}" title="删除该别名">×</button>
                </span>`).join('')
            : '<span class="tip-line">暂无别名。在源卡「手动检索」里换个关键词搜出结果后，会自动记成别名。</span>';
        return `<div class="kazumi-alias-panel">
            <div class="kazumi-alias-head">别名检索<span class="kazumi-alias-sub">标题没有可用结果时按顺序自动重试，最多 ${this._aliasCandidates(st.title, st.aliases).aliases.length} 个</span></div>
            <div class="kazumi-alias-chips">${chips}</div>
            <div class="kazumi-alias-add">
                <input class="md-input kazumi-alias-input" type="text" maxlength="60" placeholder="添加别名，回车确认" />
                <button class="md-btn md-btn-tonal md-btn-sm kazumi-alias-add-btn">添加</button>
            </div>
        </div>`;
    },

    /** 从面板添加别名（输入框 → 校验 → 入库）。 */
    _aliasAddFromPanel(st) {
        const v = this._aliasNorm($('#kazumi-dialog-body .kazumi-alias-input').val());
        if (!this._aliasValid(v)) { warnToast('别名需为 1-60 个字符'); return; }
        if (v.toLowerCase() === this._aliasNormTitle(st.title)) { warnToast('别名与标题相同，无需添加'); return; }
        this._aliasMutate(st, 'add', v);
        warnToast(`已添加别名「${v}」`);
    },

    /** 别名管理操作（add/del/front）：改内存表 → 立即落盘 → 重绘面板。
     *  即时持久化（不做「保存」按钮）：别名是随手维护的小数据，操作即生效最省心。 */
    _aliasMutate(st, op, alias) {
        if (!st || !alias) return;
        const map = st.aliasMap || {};
        // 表里没有该键时回落到 st.aliases（面板渲染用的同一份列表）：两者理论上
        // 同步，但这里不赌状态一致性——读空了会把「删除」点成 NO-OP、把「置顶」
        // 点成清空。
        let list = this._aliasSanitizeList(map[st.aliasKey] || st.aliases);
        if (op === 'add') list = this._aliasUpsert(list, alias, Date.now());
        else if (op === 'del') list = this._aliasRemoveItem(list, alias);
        else if (op === 'front') list = this._aliasPromoteItem(list, alias);
        else return;
        if (list.length) map[st.aliasKey] = list; else delete map[st.aliasKey];
        st.aliasMap = map;
        st.aliases = list;
        st.aliasChain = this._aliasCandidates(st.title, list).aliases;
        this._aliasPersist(map);
        this._renderSourceSheet();
    },

    /** 手动检索成功后的别名沉淀：置顶 + 落盘 + 刷新头部/该卡（不重绘整页——
     *  用户可能已点进选集视图，整页重绘会把人家拽回源列表）。 */
    _aliasRecord(st, word, pluginName) {
        if (!st || this._dlgState !== st) return; // 弹窗已关/已换：丢弃
        if (!this._aliasShouldRecord(st.title, word, 1)) return;
        const map = st.aliasMap || {};
        const list = this._aliasUpsert(this._aliasSanitizeList(map[st.aliasKey] || st.aliases), word, Date.now());
        if (!list.length) return;
        map[st.aliasKey] = list;
        st.aliasMap = map;
        st.aliases = list;
        st.aliasChain = this._aliasCandidates(st.title, list).aliases;
        this._aliasPersist(map).then((ok) => {
            if (ok) warnToast(`已把「${this._aliasNorm(word)}」记为别名，标题无结果时自动重试`);
        });
        if ($('#kazumi-dialog-body .kazumi-sheet-head').length) {
            this._updateSheetHeader();
            if (pluginName) this._renderSourceCard(pluginName);
        }
    },

    /** 结果合并（别名轮用）：按 源页URL+标题 去重，保留原标题轮的条目顺序，
     *  别名新条目追加在后——用户能同时看到"哪个词搜到哪条"。 */
    _mergeResults(prev, next) {
        const out = Array.isArray(prev) ? prev.slice() : [];
        const seen = new Set(out.map((it) => this._resultKey(it)));
        (Array.isArray(next) ? next : []).forEach((it) => {
            const k = this._resultKey(it);
            if (seen.has(k)) return;
            seen.add(k);
            out.push(it);
        });
        return out;
    },

    _resultKey(it) {
        return String((it && it.src) || '') + '\u0000' + String((it && it.name) || '');
    },

    /** 应用一条源搜索结果到弹窗状态并刷新对应卡片。
     *  word 为该结果所属检索轮次的整词（缺省取当前轮次词）：别名轮要按词标注命中来源，
     *  并且不覆盖原标题轮已搜到的结果。 */
    _applySourceResult(payload, word) {
        const st = this._dlgState;
        if (!st) return;
        const name = String(payload.name || '');
        if (!name || !st.plugins[name]) return;
        const p = st.plugins[name];
        const w = this._aliasNorm(word || st.keyword || '');
        const isAlias = this._isAliasWord(st, w);
        // 别名轮结果不覆盖原标题轮的好结果（真出现同源两轮都有结果时按 源+标题 去重
        // 追加）：换词重试只为「补空缺」，不能把已搜到的条目换成新词的子集。
        const keep = isAlias && p.status === 'success' && (p.results || []).length > 0;
        if (payload.captcha) {
            if (!keep) { p.status = 'captcha'; p.captchaUrl = payload.captchaUrl || ''; p.results = []; }
        } else if (payload.error) {
            if (!keep) { p.status = 'error'; p.msg = payload.msg || ''; p.results = []; }
        } else if (payload.status === 'noresult' || !(payload.list || []).length) {
            if (!keep) { p.status = 'noresult'; p.results = []; }
        } else {
            const list = payload.list || [];
            p.results = keep ? this._mergeResults(p.results, list) : list;
            p.status = p.results.length ? 'success' : 'noresult';
        }
        // 命中词标注：卡片上标出「别名「x」」，用户能一眼分清哪条是换词换来的
        p.hitWord = (p.status === 'success' && isAlias) ? w : '';
        p.searching = false;
        if (p.status === 'success' && !st.expanded) st.expanded = name; // 自动展开首个有结果源
        this._renderSourceCard(name);
        this._updateSheetHeader();
    },

    /** 单源重查（重试/别名/手动检索/验证后重试）。
     *  返回 {ok, status}：ok=这次真查到了可用源。手动检索据此沉淀别名
     *  （失败的词不入别名表）；其余调用方忽略返回值，行为不变。 */
    async _queryPlugin(keyword, pluginName, token) {
        const st = this._dlgState;
        if (!st) return { ok: false, status: 'stale' };
        const p = st.plugins[pluginName];
        if (!p) return { ok: false, status: 'stale' };
        // 命中词标注在重查前定：结果属于哪个词与查询结果无关，先算好免得
        // 中间分支提前 return 时漏标
        const isAlias = this._isAliasWord(st, keyword);
        p.searching = true;
        p.status = 'pending';
        this._renderSourceCard(pluginName);
        try {
            // refresh=1：重试/重新检索/手动检索/验证后重查都是用户显式动作，
            // 必须实时查源，不能被会话缓存挡住（否则「点了没反应」/验证白做）；
            // 后端跳过读缓存但仍照常回写。
            const rsp = await doAction('kazumiSearch', { keyword, plugin: pluginName, refresh: '1' }, '/kazumi/action');
            if (token !== this._dlgToken) return { ok: false, status: 'stale' };
            const r = ((rsp && rsp.results) || []).find((x) => x.pluginName === pluginName) || null;
            if (!r) { p.status = 'noresult'; p.results = []; }
            else if (r.captcha) { p.status = 'captcha'; p.captchaUrl = r.captchaUrl || ''; p.results = []; }
            else if (r.error) { p.status = 'error'; p.msg = r.msg || ''; p.results = []; }
            else { p.status = (r.data && r.data.length) ? 'success' : 'noresult'; p.results = r.data || []; }
        } catch (e) {
            if (token !== this._dlgToken) return { ok: false, status: 'stale' };
            p.status = 'error'; p.msg = '查询失败'; p.results = [];
        }
        p.hitWord = (p.status === 'success' && isAlias) ? this._aliasNorm(keyword) : '';
        p.searching = false;
        if (p.status === 'success' && !st.expanded) st.expanded = pluginName;
        this._renderSourceCard(pluginName);
        this._updateSheetHeader();
        return { ok: p.status === 'success' && (p.results || []).length > 0, status: p.status };
    },

    /** 渲染整个选源弹窗（头部 + 别名管理面板 + 全部源卡片）。 */
    _renderSourceSheet() {
        const st = this._dlgState;
        if (!st) return;
        const box = $('#kazumi-dialog-body');
        let html = this._sheetHeaderHtml(st);
        if (st.aliasEdit) html += this._aliasPanelHtml(st);
        const names = Object.keys(st.plugins);
        if (!names.length) html += '<div class="tip-line">尚未启用任何 Kazumi 规则</div>';
        names.forEach((n) => { html += this._sourceCardHtml(n, st.plugins[n], st.expanded === n); });
        box.html(html);
        this._bindSheetEvents();
    },

    /** 仅重绘某张源卡片（保持其余不动）。 */
    _renderSourceCard(name) {
        const st = this._dlgState;
        if (!st || !st.plugins[name]) return;
        const $card = $('#kazumi-dialog-body .kazumi-src-card').filter(function () {
            return $(this).data('plugin') === name;
        });
        if (!$card.length) return;
        const html = this._sourceCardHtml(name, st.plugins[name], st.expanded === name);
        $card.replaceWith(html);
        this._bindSheetEvents();
    },

    /** 弹窗头部：标题 + 进度（检索中 X/Y 或 共 N 条）+ 别名管理入口。
     *  标题用原标题（st.title）而非当前检索词：别名轮时另起一条提示标出
     *  「这一轮在用哪个别名」，用户才能分清"还是原标题在检索"和"换词了"。 */
    _sheetHeaderHtml(st) {
        const names = Object.keys(st.plugins);
        const done = names.filter((n) => st.plugins[n].status !== 'pending').length;
        const found = names.reduce((s, n) => s + (st.plugins[n].results || []).length, 0);
        const busy = done < names.length;
        const aliasN = (st.aliases || []).length;
        const chainN = (st.aliasChain || []).length;
        const aliasTip = st.aliasPhase
            ? `<span class="kazumi-alias-hit">别名「${escHtml(st.keyword)}」 ${Math.min(st.aliasTry || 1, chainN)}/${chainN}</span>`
            : '';
        return `<div class="kazumi-sheet-head">
            <div class="kazumi-sheet-title">「${escHtml(st.title || st.keyword)}」</div>
            ${aliasTip}
            <div class="kazumi-sheet-progress">${busy ? `检索中 ${done}/${names.length}` : `共 ${found} 条结果`}</div>
            <button class="md-btn md-btn-tonal md-btn-sm kazumi-alias-toggle" title="别名检索：标题没有可用结果时按别名自动重试；可在这里增删/排序">别名${aliasN ? ` ${aliasN}` : ''}</button>
        </div>`;
    },

    /** 更新头部进度（不重建列表）。 */
    _updateSheetHeader() {
        const st = this._dlgState;
        if (!st) return;
        const box = $('#kazumi-dialog-body');
        const $head = box.find('.kazumi-sheet-head');
        if ($head.length) $head.replaceWith(this._sheetHeaderHtml(st));
    },

    /** 状态 → 徽标。 */
    _statusBadge(p) {
        const map = {
            pending: { text: '检索中', cls: 'kazumi-status-pending' },
            success: { text: `${p.results.length} 条`, cls: 'kazumi-status-ok' },
            noresult: { text: '无结果', cls: 'kazumi-status-muted' },
            captcha: { text: '需验证', cls: 'kazumi-status-captcha' },
            error: { text: '检索失败', cls: 'kazumi-status-error' },
        };
        const m = map[p.status] || map.pending;
        return `<span class="kazumi-status ${m.cls}">${m.text}</span>`;
    },

    /** 源卡补救操作按钮组。 */
    _sourceActionsHtml(name, p) {
        const btn = (action, label) => `<button class="md-btn md-btn-tonal md-btn-sm kazumi-src-action" data-action="${action}" data-plugin="${escHtml(name)}">${label}</button>`;
        let actions = '';
        if (p.status === 'captcha' && p.captchaUrl) actions += btn('captcha', '进行验证');
        if (p.status === 'error') actions += btn('retry', '重试');
        if (p.status === 'success') actions += btn('retry', '重新检索');
        actions += btn('manual', '手动检索');
        actions += btn('browser', '浏览器打开');
        return actions;
    },

    /** 单张源卡片 HTML。 */
    _sourceCardHtml(name, p, open) {
        const head = `<div class="kazumi-src-card" data-plugin="${escHtml(name)}">
            <div class="kazumi-src-row" tabindex="0" title="点击展开/收起">
                <span class="kazumi-src-name">${escHtml(name)}</span>
                ${p.hitWord ? `<span class="kazumi-alias-hit" title="该结果由别名检索命中">别名「${escHtml(p.hitWord)}」</span>` : ''}
                ${this._statusBadge(p)}
                <span class="kazumi-src-chev">${open ? '▾' : '▸'}</span>
            </div>`;
        let body = '';
        if (open) {
            if (p.searching || p.status === 'pending') {
                body = `<div class="kazumi-src-body"><div class="tip-line">${escHtml(p.solveHint || '检索中…')}</div></div>`;
            } else if (p.status === 'success') {
                const items = p.results.map((it) => `
                    <div class="kazumi-result-item" data-plugin="${escHtml(name)}" data-src="${escHtml(it.src)}" data-name="${escHtml(it.name)}">
                        <span class="kazumi-result-name">${escHtml(it.name)}</span>
                        <span class="kazumi-result-src">${escHtml(it.src)}</span>
                    </div>`).join('');
                body = `<div class="kazumi-src-body"><div class="kazumi-result-list">${items}</div>
                    <div class="kazumi-src-actions">${this._sourceActionsHtml(name, p)}</div></div>`;
            } else {
                const hint = p.status === 'captcha' ? '该源需要验证码验证'
                    : p.status === 'error' ? '该源检索失败'
                    : '该源未找到结果';
                body = `<div class="kazumi-src-body">
                    <div class="tip-line">${escHtml(hint)}${p.msg ? '：' + escHtml(p.msg) : ''}</div>
                    <div class="kazumi-src-actions">${this._sourceActionsHtml(name, p)}</div>
                </div>`;
            }
        }
        return head + body + '</div>';
    },

    /** 绑定源卡交互（展开/结果行/补救操作），事件委托到弹窗容器避免重复绑定。 */
    _bindSheetEvents() {
        const box = $('#kazumi-dialog-body');
        const st = this._dlgState;
        if (!st) return;
        const token = st.token;
        box.off('.ks').on('click.ks', '.kazumi-src-row', (e) => {
            if (token !== this._dlgToken) return;
            const name = String($(e.currentTarget).closest('.kazumi-src-card').data('plugin') || '');
            if (!name) return;
            st.expanded = (st.expanded === name) ? null : name;
            this._renderSourceCard(name);
        });
        box.on('click.ks', '.kazumi-result-item', (e) => {
            if (token !== this._dlgToken) return;
            const el = $(e.currentTarget);
            const pluginName = String(el.data('plugin') || '');
            const src = String(el.data('src') || '');
            const name = String(el.data('name') || '');
            this._openSearchItem(pluginName, src, name, token);
        });
        box.on('click.ks', '.kazumi-src-action', (e) => {
            if (token !== this._dlgToken) return;
            e.stopPropagation();
            const pluginName = String($(e.currentTarget).data('plugin') || '');
            const action = String($(e.currentTarget).data('action') || '');
            this._handleSourceAction(action, pluginName, token);
        });
        // 别名管理（头部入口 + 面板内增删/置顶）：委托挂在稳定的 body 上，
        // 头部/卡片重绘不丢绑定；头部开关不重绘整页也无妨（面板由整页重绘带出）。
        box.on('click.ks', '.kazumi-alias-toggle', (e) => {
            if (token !== this._dlgToken) return;
            e.stopPropagation();
            st.aliasEdit = !st.aliasEdit;
            this._renderSourceSheet();
        });
        box.on('click.ks', '.kazumi-alias-act', (e) => {
            if (token !== this._dlgToken) return;
            e.stopPropagation();
            const el = $(e.currentTarget);
            const act = String(el.data('aliasAction') || '');
            const alias = String(el.data('alias') || '');
            this._aliasMutate(st, act, alias);
            // 面板重绘本身就是反馈（chip 消失/换位），再补一句 toast 说明这次操作生效了
            if (act === 'del') warnToast(`已删除别名「${alias}」`);
            else if (act === 'front') warnToast(`「${alias}」已设为优先`);
        });
        box.on('click.ks', '.kazumi-alias-add-btn', (e) => {
            if (token !== this._dlgToken) return;
            e.stopPropagation();
            this._aliasAddFromPanel(st);
        });
        box.on('keydown.ks', '.kazumi-alias-input', (e) => {
            if (token !== this._dlgToken) return;
            if (e.key !== 'Enter') return;
            e.preventDefault();
            this._aliasAddFromPanel(st);
        });
    },

    /** 点结果行：显示「获取中」，解析剧集线路 → 选集视图；失败回选源。 */
    async _openSearchItem(pluginName, src, name, token) {
        $('#kazumi-dialog-body').html('<div class="tip-line">正在解析剧集线路…</div>');
        try {
            const rsp = await doAction('kazumiChapters', { pluginName, src }, '/kazumi/action');
            if (token !== this._dlgToken) return;
            const roads = (rsp && rsp.roads) || [];
            if (!roads.length && rsp && rsp.captcha) {
                // 章节页撞验证码：自动解题（同搜索环节的 solve），成功后重试解析
                await this._solveChapterCaptcha(pluginName, name, token, src);
                return;
            }
            if (!roads.length) { this._backToSources(); warnToast('未解析到剧集线路'); return; }
            this._renderChapterRoads(pluginName, roads, name, token, src);
        } catch (e) {
            if (token !== this._dlgToken) return;
            this._backToSources();
            warnToast('剧集解析失败');
        }
    },

    /** 章节页验证码自动解题：solve 成功 → 重试解析；失败/无能力 → 人工验证窗口
     *  （验证会话按站点生效，验证后重试解析）。 */
    async _solveChapterCaptcha(pluginName, name, token, src) {
        $('#kazumi-dialog-body').html('<div class="tip-line">剧集页需要验证码，正在自动识别…</div>');
        let solved = false;
        try {
            const llmP = await this._captchaLlmParams().catch(() => ({}));
            const rsp = await doAction('kazumiCaptchaSolve', { plugin: pluginName, ...llmP }, '/kazumi/action', 60000);
            solved = !!(rsp && rsp.result && rsp.result.ok);
        } catch (e) { /* 走人工回落 */ }
        if (token !== this._dlgToken) return;
        if (solved) {
            await this._openSearchItem(pluginName, src, name, token);
            return;
        }
        // 回落人工验证窗口：验证完成后重试解析
        const captchaRsp = await doAction('kazumiChapters', { pluginName, src }, '/kazumi/action').catch(() => null);
        const captchaUrl = (captchaRsp && captchaRsp.captchaUrl) || '';
        if (captchaUrl) {
            this._openCaptchaWindow(captchaUrl, () => { this._openSearchItem(pluginName, src, name, token); });
        } else {
            this._backToSources();
            warnToast('该源需要验证码，暂无自动识别能力');
        }
    },

    /** 从选集视图返回选源列表（保留已搜到的状态）。 */
    _backToSources() {
        if (this._dlgState) this._renderSourceSheet();
    },

    /** 源卡补救操作分发。 */
    async _handleSourceAction(action, pluginName, token) {
        const st = this._dlgState;
        if (!st) return;
        const keyword = st.keyword;
        if (action === 'retry') {
            await this._queryPlugin(keyword, pluginName, token);
        } else if (action === 'captcha') {
            await this._solveSourceCaptcha(pluginName, token, keyword);
        } else if (action === 'manual') {
            this._showKeywordDialog(pluginName, token, '手动检索');
        } else if (action === 'browser') {
            this._openPluginSearchPage(pluginName, keyword);
        }
    },

    /** 源卡「进行验证」：先自动识别解题（与搜索页验证码标签/章节页同口径），
     *  成功直接重查该源；失败/无能力回落人工验证窗口（原路径始终可用）。
     *  solve 端点不依赖 captchaUrl——后端按规则 captchaImage XPath 或 MacCMS
     *  约定端点自行取图，故无链接也先试自动，仅「自动失败且无链接」才提示无入口。 */
    async _solveSourceCaptcha(pluginName, token, keyword) {
        const st = this._dlgState;
        if (!st) return;
        const p = st.plugins[pluginName];
        if (!p) return;
        const url = p.captchaUrl || '';
        // 识别中占位：卡片体收敛为提示行（操作按钮随 body 消失，天然防连点）
        p.searching = true;
        p.solveHint = '正在自动识别验证码…';
        this._renderSourceCard(pluginName);
        let solved = false;
        try {
            const llmP = await this._captchaLlmParams().catch(() => ({}));
            const rsp = await doAction('kazumiCaptchaSolve', { plugin: pluginName, ...llmP }, '/kazumi/action', 60000);
            solved = !!(rsp && rsp.result && rsp.result.ok);
        } catch (e) { /* 网络异常等按失败口径走人工回落 */ }
        if (token !== this._dlgToken) return;
        p.solveHint = '';
        p.searching = false;
        this._renderSourceCard(pluginName);
        if (solved) {
            await this._queryPlugin(keyword, pluginName, token);
        } else if (url) {
            this._openCaptchaWindow(url, () => this._queryPlugin(keyword, pluginName, token));
        } else {
            warnToast('自动识别失败，且该源暂无验证链接');
        }
    },

    /**
     * 手动检索：弹关键词输入框，重查该源；搜出可用源的关键词会沉淀成别名。
     *
     * 关窗判定（交互修复）：只有「按下与释放都落在遮罩本身」才算点击外部关闭。
     * 旧实现只看 click 的 e.target——click 事件的 target 是 mousedown 与 mouseup 的
     * 最近公共祖先：在弹窗里的标题/输入框上按下、把选中文本拖到弹窗外的遮罩上松手时，
     * 公共祖先正好是遮罩（弹窗是遮罩的子节点），于是"拖选结束"被误判成"点了外部"
     * 直接关窗（用户报告：选中标题拖到窗口外，手动检索弹窗自动关闭）。
     * 现在改为记录按下起点：只有起点和终点都在遮罩上的完整点击才关窗；从弹窗内部
     * 起始的拖选无论在哪里松手都不关（拖选输入框文本、快速双击同理不受影响）。
     * 另补 Esc = 关闭本弹窗（capture 阶段消费：否则 app.js 的全局 Esc 会派发给
     * dispatchEsc 把下面的选源弹窗一起关掉，留下一个孤立的输入框）。
     */
    _showKeywordDialog(pluginName, token, title) {
        const kw = this._dlgState ? this._dlgState.keyword : '';
        const dlg = $('<div class="md-dialog-overlay" style="display:flex">'
            + '<div class="md-dialog">'
            + `<div class="md-dialog-title">${escHtml(title || '手动检索')} · ${escHtml(pluginName)}</div>`
            + '<div class="md-dialog-body"><div class="md-field"><input id="kazumi-kw-input" class="md-input" type="text" value="' + escHtml(kw) + '" placeholder="输入关键词，回车确认" /></div></div>'
            + '<div class="md-dialog-actions">'
            + '<button class="md-dialog-btn" id="kazumi-kw-cancel">取消</button>'
            + '<button class="md-dialog-btn md-dialog-btn-primary" id="kazumi-kw-ok">确认</button>'
            + '</div></div></div>').appendTo(document.body);
        let downOnScrim = false; // 按下起点是否落在遮罩本身（见方法注释）
        let onEsc = null;
        const close = () => {
            if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function' && onEsc) {
                document.removeEventListener('keydown', onEsc, true);
            }
            dlg.remove();
        };
        onEsc = (e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation(); // 别让全局 Esc 派发再去关下面的选源弹窗
            close();
        };
        const submit = () => {
            const v = String(dlg.find('#kazumi-kw-input').val() || '').trim();
            if (!v) { warnToast('请输入关键词'); return; }
            const st = this._dlgState;
            close();
            const done = this._queryPlugin(v, pluginName, token);
            // 别名沉淀：换词且真搜出可用源才记（失败/空结果的词入表，之后每次检索
            // 都替用户重试这个错词，越修越乱）
            if (done && typeof done.then === 'function') {
                done.then((r) => { if (r && r.ok) this._aliasRecord(st, v, pluginName); }).catch(() => { });
            }
        };
        dlg.on('mousedown', (e) => { downOnScrim = (e.button === 0 && e.target === dlg[0]); });
        dlg.on('mouseup', (e) => {
            if (e.button !== 0) return;
            const wasOnScrim = downOnScrim && e.target === dlg[0];
            downOnScrim = false; // 任何一次释放都复位：残留状态会让下一次点击误判
            if (wasOnScrim) close();
        });
        dlg.find('#kazumi-kw-cancel').on('click', close);
        dlg.find('#kazumi-kw-ok').on('click', submit);
        dlg.find('#kazumi-kw-input').on('keydown', (e) => { if (e.key === 'Enter') submit(); }).trigger('focus').select();
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('keydown', onEsc, true);
        }
    },

    /** 浏览器打开源的搜索页。 */
    _openPluginSearchPage(pluginName, keyword) {
        const rule = this._rules.find((r) => r.name === pluginName);
        if (!rule) { warnToast('未找到该源规则'); return; }
        const raw = String(rule.searchURL || '').replace('@keyword', encodeURIComponent(keyword || ''));
        if (/^https?:\/\//i.test(raw)) window.open(raw, '_blank'); // 主进程 setWindowOpenHandler 转系统浏览器
        else warnToast('该源未配置搜索地址');
    },

    /** 打开验证码验证窗口（T73）：可见窗口供用户填写验证码，关闭时主进程收割 Cookie 交给后端，
     *  验证完成后由调用方重新搜索（下次搜索自动带上 Cookie）。 */
    async _openCaptchaWindow(url, onDone) {
        if (!url) return;
        warnToast('已打开验证码验证窗口，完成后关闭窗口即可');
        try {
            await window.yuki.captchaVerify(url);
            warnToast('验证码窗口已关闭，Cookie 已保存');
            if (typeof onDone === 'function') onDone();
        } catch (e) {
            warnToast('验证窗口打开失败');
        }
    },

    // ---------------------------------------------------------------- Bangumi 完整详情弹窗

    /** 打开 Bangumi 番剧完整详情弹窗（概览/分集/角色/评论/关联/制作人员）。 */
    async openBangumiDetail(subjectId) {
        const token = ++this._dlgToken;
        $('#kazumi-dialog-title').text('番剧详情');
        $('#kazumi-dialog-body').html('<div class="tip-line">正在载入详情…</div>');
        openDialog('kazumiSourceDialog');
        try {
            const info = await this.bangumiInfo(subjectId);
            // 拆分守卫：token 失效 = 弹窗已被更新操作（重开/关详情）接管，
            // 绝不能动 DOM 覆盖新内容；info 为空 = 本次请求确实失败，才提示载入失败
            if (token !== this._dlgToken) return;
            if (!info) {
                $('#kazumi-dialog-body').html('<div class="tip-line">详情载入失败</div>');
                return;
            }
            await this._renderBangumiDetail(info, token);
        } catch (e) {
            if (token !== this._dlgToken) return;
            $('#kazumi-dialog-body').html('<div class="tip-line">详情载入失败</div>');
        }
    },

    /**
     * 打开 Bangumi 番剧详情（T74 统一详情页）：复用 #view-detail，Bangumi-only 自适应渲染。
     * @param {string} subjectId Bangumi subject id
     * @param {{site?:string, src?:string}} [kazumiOrigin] Kazumi 搜索结果进入时携带的
     *   默认源（site=kazumi:规则名 + 源页 URL）：详情页「开始观看」据此直达该源
     *   解析剧集，免重新全源检索；其他入口不传则维持全源选源弹窗。
     */
    async openBangumiInfoPage(subjectId, kazumiOrigin) {
        const curView = (typeof App !== 'undefined' && App.currentView) ? App.currentView : 'home';
        if (curView && curView !== 'detail') this._infoReferrer = curView;
        if (typeof Detail !== 'undefined' && Detail.openBangumi) {
            await Detail.openBangumi(subjectId, '', kazumiOrigin);
        }
    },

    // ---------------------------------------------------------------- Bangumi 标签精确筛选（任务四 4.2）

    /**
     * 详情页标签点击入口：按 Bangumi 标签精确筛选番剧。
     * 跳转到搜索页「Bangumi」页签并以 tag: 过滤搜索（与搜索功能物理联动，任务四 4.2）。
     * @param {string} tagName 标签名（如「治愈」「原创」）
     */
    async openBangumiTagResult(tagName) {
        const tag = String(tagName || '').trim();
        if (!tag) return;
        if (typeof BangumiSearch !== 'undefined' && BangumiSearch.openWithTag) {
            BangumiSearch.openWithTag(tag);
        }
    },

    /** 渲染 Bangumi 完整详情到弹窗容器 #kazumi-dialog-body（选源弹窗内「查看详情」预览用；正式入口为统一详情页）。 */
    async _renderBangumiDetail(info, token, $box) {
        const box = $box || $('#kazumi-dialog-body');
        const name = info.name_cn || info.name || '';
        const cover = bangumiCover(info.images, 'card');   // 信息卡封面渲染 150px（T75）
        const rating = info.rating || {};
        const score = rating.score || 0;
        const votes = rating.total || 0;
        const rank = rating.rank || 0;
        const airDate = info.date || info.air_date || '';
        // 星级：score 满分 10 → 5 星填充比例
        const starFrac = Math.max(0, Math.min(1, Number(score) / 10));
        const starsHtml = score
            ? `<span class="bi-stars"><span class="bi-stars-bg">★★★★★</span><span class="bi-stars-fill" style="width:${Math.round(starFrac * 100)}%">★★★★★</span></span>`
            : '';
        // 评分透视柱状图：rating.count 为 {1..10: 人数} 分布
        let histHtml = '';
        const cnt = rating.count;
        if (cnt && typeof cnt === 'object') {
            const vals = [];
            for (let i = 1; i <= 10; i++) vals.push(Number(cnt[i] || cnt[String(i)] || 0));
            if (vals.some((v) => v > 0)) {
                const maxV = Math.max(1, ...vals);
                histHtml = `<div class="bi-hist" title="评分透视（1-10 分人数分布）">` + vals.map((v, i) =>
                    `<div class="bi-hist-col"><div class="bi-hist-bar" style="height:${Math.round(v / maxV * 100)}%" title="${i + 1} 分：${v} 人"></div><span class="bi-hist-lb">${i + 1}</span></div>`
                ).join('') + `</div>`;
            }
        }
        // 顶部信息卡（仿 Kazumi InfoPage：标题 + 封面/放送日期/评分星级/排名/评分透视）
        let html = `<div class="bangumi-info-card" style="margin-bottom:16px;">
            <div class="bangumi-info-title">${escHtml(name)}</div>
            <div class="bangumi-info-row">
                ${cover ? `<div class="bangumi-info-cover"><img src="${escHtml(cover)}" referrerpolicy="no-referrer" data-fb-src="${escHtml(bangumiMirrorUrl(cover))}"></div>` : ''}
                <div class="bangumi-info-meta">
                    <div class="bi-label">放送开始</div>
                    <div class="bi-value">${escHtml(airDate || '—')}</div>
                    <div class="bi-label">${votes ? `${votes} 人评分` : '评分'}</div>
                    <div class="bi-value bi-score">${score ? `${score} ${starsHtml}` : '—'}</div>
                    <div class="bi-label">Bangumi Ranked</div>
                    <div class="bi-value">${rank ? `#${rank}` : '—'}</div>
                </div>
                ${histHtml}
            </div>
            ${info.summary ? `<div class="bangumi-info-summary">${escHtml(typeof stripHtml === 'function' ? stripHtml(info.summary) : info.summary)}</div>` : ''}
            ${this._renderInfoTags(info.tags)}
        </div>`;
        // 开始观看（修复二级页不能播放：打开 Kazumi 源弹窗选源播放）
        html += `<div class="kazumi-watch-row">
            <button class="md-btn md-btn-filled md-btn-sm kazumi-start-watch">▶ 开始观看</button>
            <span class="tip-line pad0">从 Kazumi 规则源搜索本片并选择播放</span>
        </div>`;
        // Bangumi 收藏状态按钮（仿 Kazumi CollectButton，点击即同步）
        html += `<div class="kazumi-bangumi-colrow">
            <span class="tip-line pad0">Bangumi 收藏（点击即同步）</span>
            <div class="kazumi-col-btns" data-id="${escHtml(String(info.id))}">
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="-1">未收藏</button>
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="1">想看</button>
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="3">在看</button>
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="2">看过</button>
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="4">搁置</button>
                <button class="md-btn md-btn-sm kazumi-col-btn" data-type="5">抛弃</button>
            </div>
        </div>`;
        // 页签导航（class 化，避免弹窗/二级页双实例 id 冲突）
        html += `<div class="class-tabs bangumi-detail-tabs" style="margin-bottom:12px;">
            <span class="class-tab active" data-tab="episodes">分集</span>
            <span class="class-tab" data-tab="characters">角色</span>
            <span class="class-tab" data-tab="staff">制作</span>
            <span class="class-tab" data-tab="comments">评论</span>
            <span class="class-tab" data-tab="relations">关联</span>
        </div>`;
        html += '<div class="bangumi-detail-content" style="max-height:40vh;overflow-y:auto;"></div>';
        box.html(html);
        const $content = box.find('.bangumi-detail-content');
        this._curSubjectId = info.id;
        this._curBangumiName = name;
        // 回填当前收藏状态（异步，不阻塞）
        this._applyBangumiColState(info.id);
        // L-26：box 为常驻容器，先清上一轮弹窗的 .kbd 委托再绑定，
        // 否则反复打开详情弹窗会无限累积 click 监听器（内存泄漏）
        box.off('.kbd');
        // 开始观看：打开 Kazumi 源弹窗
        box.on('click.kbd', '.kazumi-start-watch', (e) => {
            if (token !== this._dlgToken) return;
            const title = this._curBangumiName || '';
            if (title && typeof this.openSourceDialog === 'function') this.openSourceDialog(title, 'kazumi', '');
        });
        // 收藏状态按钮：点击即同步；「未收藏」删除收藏
        box.on('click.kbd', '.kazumi-col-btn', async (e) => {
            if (token !== this._dlgToken) return;
            const btn = $(e.currentTarget);
            const id = String(btn.closest('.kazumi-col-btns').data('id') || '');
            const val = parseInt(btn.data('type'), 10);
            const nm = this._curBangumiName || '';
            if (!id) { warnToast('收藏操作失败：缺少 Bangumi ID'); return; }
            if (val < 0) {
                if (await this.removeBangumiCollection(id, nm)) this._applyBangumiColState(id);
            } else if (await this.setBangumiCollection(id, val, { quiet: true })) {
                this._applyBangumiColState(id);
            } else if (!this._bgmBatchActive) {
                // review01 L35 同源补漏：失败时统一在此弹一次提示（setBangumiCollection 调用处传 quiet:true 静默，避免双 toast）
                warnToast('收藏同步失败');
            }
        });
        // 标签点击：按 Bangumi 标签精确筛选番剧（非关键词搜索，任务四 4.2）
        box.on('click.kbd', '.kazumi-tag', (e) => {
            if (token !== this._dlgToken) return;
            const tag = String($(e.currentTarget).data('tag') || '');
            if (!tag) return;
            if (this.openBangumiTagResult) this.openBangumiTagResult(tag);
        });
        // 标签「展开全部/收起」：只替换标签区块（info.tags 在闭包里），委托不受影响
        box.on('click.kbd', '.kazumi-tags-toggle', (e) => {
            if (token !== this._dlgToken) return;
            const expanded = String($(e.currentTarget).data('tags-expanded')) === '1';
            $(e.currentTarget).closest('.bangumi-info-tags').replaceWith(this._renderInfoTags(info.tags, !expanded));
        });
        // 默认载入分集
        await this._loadBangumiTab(info.id, 'episodes', token, $content);
        // 页签切换
        box.find('.bangumi-detail-tabs').on('click', '.class-tab', async (e) => {
            if (token !== this._dlgToken) return;
            const tab = String($(e.currentTarget).data('tab') || '');
            box.find('.bangumi-detail-tabs .class-tab').removeClass('active');
            $(e.currentTarget).addClass('active');
            await this._loadBangumiTab(info.id, tab, token, $content);
        });
    },

    /** 渲染简介区标签（info.tags: [{name,count}]），点击跳搜索。
     *  默认展示前 13 个，超出折叠到「展开全部（N）」；展开/收起只重渲染标签区，
     *  完整对齐 bgm.tv 条目页标签全集（截断的恰是标记人数最少的冷门标签）。 */
    _renderInfoTags(tags, expanded) {
        if (!Array.isArray(tags) || !tags.length) return '';
        const shown = expanded ? tags : tags.slice(0, 13);
        const chips = shown.map((t) => {
            const tn = (t && typeof t === 'object') ? (t.name || '') : t;
            return tn ? `<span class="kazumi-tag" data-tag="${escHtml(tn)}">${escHtml(tn)}</span>` : '';
        }).filter(Boolean).join('');
        if (!chips) return '';
        let toggle = '';
        if (tags.length > 13) {
            toggle = `<button type="button" class="kazumi-tags-toggle" data-tags-expanded="${expanded ? '1' : '0'}">${expanded ? '收起' : `展开全部（${tags.length - 13}）`}</button>`;
        }
        return `<div class="bangumi-info-tags"><span class="tip-line pad0">标签</span><div class="kazumi-tags-wrap">${chips}${toggle}</div></div>`;
    },

    async _loadBangumiTab(subjectId, tab, token, $content) {
        const box = $content || $('.bangumi-detail-content').first();
        box.html('<div class="tip-line">载入中…</div>');
        try {
            if (tab === 'episodes') {
                const data = await this.bangumiEpisodes(subjectId);
                if (token !== this._dlgToken) return;
                const list = (data && data.data) || [];
                // 缓存 Bangumi 分集（正片优先）：起播时按序号对齐，播放器标题用
                // 「集数 + 名称」；未加载过分集页签时由规则 identifier 兜底。
                this._bgmEpsCache = {
                    subjectId,
                    eps: list
                        .filter((ep) => ep && (ep.type == null || ep.type === 0))
                        .map((ep) => ({
                            no: String(ep.ep || ep.sort || ''),
                            name: String(ep.name_cn || ep.name || ''),
                        })),
                };
                box.html(list.length
                    ? '<div class="tip-line pad0" style="margin-bottom:8px;">点击集数 → 从 Kazumi 规则源选源播放</div>'
                      + list.map((ep) => `<div class="kazumi-detail-ep" tabindex="0">
                        <span class="kazumi-detail-ep-no">${escHtml(String(ep.sort || ep.ep || ''))}</span>
                        <span class="kazumi-detail-ep-name">${escHtml(ep.name_cn || ep.name || '')}</span>
                        <span class="kazumi-detail-ep-type">${escHtml(ep.type === 1 ? 'SP' : ep.type === 2 ? 'OP' : ep.type === 3 ? 'ED' : '')}</span>
                    </div>`).join('')
                    : '<div class="tip-line">暂无分集信息</div>');
                // 修复二级页不能播放：点击集数打开 Kazumi 源弹窗选源播放
                box.find('.kazumi-detail-ep').on('click', () => {
                    if (token !== this._dlgToken) return;
                    const title = this._curBangumiName || '';
                    if (title && typeof this.openSourceDialog === 'function') this.openSourceDialog(title, 'kazumi', '');
                });
            } else if (tab === 'characters') {
                const list = await this.bangumiCharacters(subjectId);
                if (token !== this._dlgToken) return;
                box.html(list.length
                    ? '<div class="tip-line pad0" style="margin-bottom:8px;">点击角色查看详情</div>'
                      + list.map((c) => {
                        // CV 文案复用 Detail 的提取助手（actors 数组/actor 字符串兼容）
                        const cv = (typeof Detail !== 'undefined' && Detail._charCvText) ? Detail._charCvText(c) : '';
                        return `<div class="kazumi-detail-char" data-char-id="${escHtml(c.id)}" tabindex="0">
                        <img class="kazumi-detail-avatar" src="${escHtml((c.images && c.images.medium) || '')}" referrerpolicy="no-referrer" onerror="this.style.display='none'">
                        <div class="kazumi-detail-char-info">
                            <div class="kazumi-detail-char-name">${escHtml(c.name_cn || c.name || '')}</div>
                            ${cv ? `<div class="kazumi-detail-char-cv">CV：${escHtml(cv)}</div>` : ''}
                            <div class="kazumi-detail-char-role">${escHtml(c.role_name || '')}</div>
                        </div>
                        <span class="kazumi-detail-char-more">详情 ›</span>
                    </div>`;
                    }).join('')
                    : '<div class="tip-line">暂无角色信息</div>');
                // 角色点击进详情（资料/简介）
                box.find('.kazumi-detail-char').on('click', async (e) => {
                    if (token !== this._dlgToken) return;
                    const cid = String($(e.currentTarget).data('char-id') || '');
                    if (cid) await this._openCharacterDetail(cid, token, box);
                });
            } else if (tab === 'staff') {
                const list = await this.bangumiStaff(subjectId);
                if (token !== this._dlgToken) return;
                // 按制作职位重要性从左到右排序（稳定排序：同权重保留接口原有顺序）。
                const sorted = (typeof Detail !== 'undefined' && Detail._staffJobRank)
                    ? list.map((s, i) => ({ s, i, rank: Detail._staffJobRank(s.jobs || s.relation) }))
                        .sort((a, b) => (a.rank - b.rank) || (a.i - b.i)).map((x) => x.s)
                    : list;
                box.html(sorted.length
                    ? sorted.map((s) => {
                        // 中文名优先显示，原名作为副标题（若不同）。
                        const cn = s.name_cn || (typeof Detail !== 'undefined' && Detail._pickCharNameCn ? Detail._pickCharNameCn({ infobox: s.infobox }) : '') || '';
                        const orig = s.name || '';
                        const mainName = cn || orig;
                        const subName = (cn && orig && cn !== orig) ? orig : '';
                        return `<div class="kazumi-detail-staff">
                        <span class="kazumi-detail-staff-name">${escHtml(mainName)}${subName ? ` <span class="kazumi-detail-staff-subname">${escHtml(subName)}</span>` : ''}</span>
                        <span class="kazumi-detail-staff-job">${escHtml((s.jobs || []).join(' / '))}</span>
                    </div>`;
                    }).join('')
                    : '<div class="tip-line">暂无制作人员信息</div>');
            } else if (tab === 'comments') {
                const { list } = await this.bangumiComments(subjectId, 20, 0);
                if (token !== this._dlgToken) return;
                box.html(list.length
                    ? list.map((c) => `<div class="kazumi-detail-comment">
                        <div class="kazumi-detail-comment-user">${escHtml((c.user && c.user.nickname) || c.username || '')}</div>
                        <div class="kazumi-detail-comment-text">${escHtml(c.comment || '')}</div>
                        <div class="kazumi-detail-comment-time">${escHtml(c.updated_at || '')}</div>
                    </div>`).join('')
                    : '<div class="tip-line">暂无评论</div>');
            } else if (tab === 'relations') {
                const list = await this.bangumiRelations(subjectId);
                if (token !== this._dlgToken) return;
                box.html(list.length
                    ? list.map((r) => `<div class="kazumi-detail-rel">
                        <span class="kazumi-detail-rel-type">${escHtml(r.relation || '')}</span>
                        <span class="kazumi-detail-rel-name">${escHtml(r.name_cn || r.name || '')}</span>
                    </div>`).join('')
                    : '<div class="tip-line">暂无关联番剧</div>');
            }
        } catch (e) {
            if (token !== this._dlgToken) return;
            box.html('<div class="tip-line">载入失败</div>');
        }
    },

    /** 角色详情：在 tab 内容区展示资料（大图/基本信息/简介），带返回角色列表（仿 Kazumi CharacterPage）。 */
    async _openCharacterDetail(characterId, token, $content) {
        const box = $content || $('.bangumi-detail-content').first();
        box.html('<div class="tip-line">载入中…</div>');
        try {
            const info = await this.bangumiCharacter(characterId);
            if (token !== this._dlgToken) return;
            if (!info) { box.html('<div class="tip-line">角色详情载入失败</div>'); return; }
            const img = bangumiCover(info.images, 'card');   // 角色详情图（T75）
            // 角色中文名：Bangumi 角色接口无独立 name_cn，通常嵌在 infobox 别名项里，提取展示。
            const charNameCn = (typeof Detail !== 'undefined' && Detail._pickCharNameCn) ? Detail._pickCharNameCn(info) : '';
            // 基本信息：名称类字段（简体中文名 → 第二中文名 → 日文名 → 别名…）排到最前，其余跟随
            const infoStr = (typeof Detail !== 'undefined' && Detail._buildCharInfoStr)
                ? Detail._buildCharInfoStr(info) : '';
            const metaBits = [
                info.blood_type ? '血型 ' + info.blood_type : '',
                info.birth_month ? `${info.birth_month}月${info.birth_day || ''}日` : '',
                info.height ? '身高 ' + info.height + 'cm' : '',
                info.weight ? '体重 ' + info.weight + 'kg' : '',
            ].filter(Boolean).join(' · ');
            box.html(`<div class="kazumi-char-detail">
                <button class="md-btn md-btn-sm md-btn-tonal kazumi-char-back">← 返回角色列表</button>
                ${img ? `<img class="kazumi-char-img" src="${escHtml(img)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
                <div class="kazumi-char-name">${escHtml(info.name || '')}</div>
                ${charNameCn && charNameCn !== (info.name || '') ? `<div class="kazumi-char-name-cn">${escHtml(charNameCn)}</div>` : ''}
                <div class="kazumi-char-meta">${escHtml(metaBits)}</div>
                ${infoStr ? `<div class="detail-section-heading">基本信息</div><div class="kazumi-char-summary">${escHtml(infoStr)}</div>` : ''}
                ${info.summary ? `<div class="detail-section-heading">角色简介</div><div class="kazumi-char-summary">${escHtml(typeof stripHtml === 'function' ? stripHtml(info.summary) : info.summary)}</div>` : ''}
            </div>`);
            box.find('.kazumi-char-back').on('click', async () => {
                if (token !== this._dlgToken) return;
                await this._loadBangumiTab(this._curSubjectId, 'characters', token, box);
            });
        } catch (e) {
            if (token !== this._dlgToken) return;
            box.html('<div class="tip-line">角色详情载入失败</div>');
        }
    },

    /** 解析剧集线路（kazumiChapters）。 */
    async _loadChapters(pluginName, src, title, token) {
        $('#kazumi-dialog-body').html('<div class="tip-line">正在解析剧集线路…</div>');
        try {
            const rsp = await doAction('kazumiChapters', { pluginName, src }, '/kazumi/action');
            if (token !== this._dlgToken) return;
            const roads = (rsp && rsp.roads) || [];
            if (!roads.length) {
                $('#kazumi-dialog-body').html('<div class="tip-line">未解析到剧集线路</div>');
                return;
            }
            this._renderChapterRoads(pluginName, roads, title, token, src);
        } catch (e) {
            if (token !== this._dlgToken) return;
            $('#kazumi-dialog-body').html('<div class="tip-line">剧集解析失败</div>');
        }
    },

    /** 渲染线路与剧集列表。src 为番剧源页 URL，写入历史记录供历史卡重新选源（T4）。 */
    _renderChapterRoads(pluginName, roads, title, token, src) {
        // 剧集展示顺序（会话级记忆，跨弹窗保留）：false=正序（源站原始顺序），true=倒序。
        // 只影响展示——roads 原始数组不反转，Bangumi 分集多选下载按下标定位、
        // 勾选集子集过滤、连播队列方向均不受影响；点任意集仍从该集起按原顺序连播。
        if (typeof this._chapterEpsDesc !== 'boolean') this._chapterEpsDesc = false;
        const box = $('#kazumi-dialog-body');
        let html = `<div class="kazumi-road-toolbar">
            <button class="md-btn md-btn-tonal md-btn-sm kazumi-road-back">← 返回选源</button>
            <span class="kazumi-plugin-head">${escHtml(pluginName)} · ${escHtml(title)}</span>
            <span class="kazumi-road-toolbar-spacer"></span>
            <button class="md-btn md-btn-tonal md-btn-sm kazumi-eps-order" title="${this._chapterEpsDesc ? '切换为正序（第1集在前）' : '切换为倒序（最后一集在前）'}">${this._chapterEpsDesc ? '↑ 正序' : '↓ 倒序'}</button>
        </div>`;
        roads.forEach((road, ri) => {
            // 先按原始下标组装 {url,name}，再按需整体倒转展示：集名回落仍以原始集号为基准
            const items = (road.data || []).map((url, ei) => ({
                url, name: (road.identifier || [])[ei] || `第${ei + 1}集`,
            }));
            if (this._chapterEpsDesc) items.reverse();
            const eps = items.map((it) => `<button class="ep-btn kazumi-ep-btn" data-plugin="${escHtml(pluginName)}" data-url="${escHtml(it.url)}" data-name="${escHtml(it.name)}" data-flag="${escHtml(road.name)}">
                    <span class="ep-name">${escHtml(it.name)}</span>
                    <span class="ep-dl-one kazumi-ep-dl" data-url="${escHtml(it.url)}" data-name="${escHtml(it.name)}" data-flag="${escHtml(road.name)}" title="下载本集">⬇</span>
                </button>`).join('');
            html += `<div class="kazumi-road-group">
                <div class="kazumi-road-name">${escHtml(road.name)}（${(road.data || []).length} 集）</div>
                <div class="ep-grid">${eps}</div>
            </div>`;
        });
        box.html(html);
        // 下载模式（Bangumi 分集多选下载而来）：置顶提示，点任意线路 = 从该线路批量下载所有勾选集。
        if (this._dlDownloadMode) {
            const dm = this._dlDownloadMode;
            $('<div class="kazumi-dl-mode-bar tip-line">已进入下载模式：点击任意线路的任意集，即从该线路批量下载已勾选的 '
                + dm.episodes.length + ' 集（第 ' + escHtml(dm.episodes.join('、')) + ' 集）。</div>')
                .insertAfter(box.find('.kazumi-road-toolbar'));
        }
        // 返回选源列表（保留已搜到的状态）
        box.find('.kazumi-road-back').on('click', () => {
            if (token !== this._dlgToken) return;
            this._backToSources();
        });
        // 剧集顺序切换：翻转展示方向后整体重渲染（roads 原始数据不变，重渲染幂等）
        box.find('.kazumi-eps-order').on('click', () => {
            if (token !== this._dlgToken) return;
            this._chapterEpsDesc = !this._chapterEpsDesc;
            this._renderChapterRoads(pluginName, roads, title, token, src);
        });
        // 下载本集：从当前 Kazumi 源解析真实直链后加入下载队列（阻止冒泡避免触发播放）
        // 下载模式下点击 ⬇ 也应批量下载勾选集（而非只下载本集），与点击集主体行为一致
        box.find('.kazumi-ep-dl').on('click', (e) => {
            e.stopPropagation();
            if (token !== this._dlgToken) return;
            const el = $(e.currentTarget);
            if (this._dlDownloadMode) {
                const road = roads.find((r) => r.name === String(el.data('flag') || ''));
                this._downloadKazumiEpisodesFromRoad(pluginName, road, this._dlDownloadMode);
                return;
            }
            this._downloadKazumiEp(pluginName, String(el.data('url') || ''), String(el.data('name') || ''), title);
        });
        // 绑定点击：下载模式=从该线路批量下载所有勾选集，否则播放剧集
        box.find('.kazumi-ep-btn').on('click', (e) => {
            if (token !== this._dlgToken) return;
            const el = $(e.currentTarget);
            const pluginName = String(el.data('plugin') || '');
            const url = String(el.data('url') || '');
            const name = String(el.data('name') || '');
            const flag = String(el.data('flag') || '');
            const road = roads.find((r) => r.name === flag);
            if (this._dlDownloadMode) {
                // 从当前线路按勾选集号批量下载（修复此前只下载点击那一集的 bug）
                this._downloadKazumiEpisodesFromRoad(pluginName, road, this._dlDownloadMode);
                return;
            }
            // 组装连播 episodes（glm5.2 播放链路）
            // 集名优先级：Bangumi 分集（集数+名称，按序号对齐）→ 规则 identifier → 第N集
            const bgmEps = (this._bgmEpsCache && Array.isArray(this._bgmEpsCache.eps))
                ? this._bgmEpsCache.eps : null;
            const episodes = road ? (road.data || []).map((u, i) => {
                let nm = (road.identifier || [])[i] || `第${i + 1}集`;
                const b = bgmEps && bgmEps[i];
                // Bangumi 只有集号没名时，名部分回落规则 identifier，不再整条丢弃
                if (b && (b.no || b.name)) {
                    const ident2 = (road.identifier || [])[i] || '';
                    nm = b.no ? `${b.no} ${b.name || ident2}`.trim() : (b.name || ident2);
                }
                return { name: nm, url: u };
            }) : [{ name, url }];
            const epIndex = episodes.findIndex((ep) => ep.url === url);
            // 勾选集播放：把整条线路过滤成勾选子集（保持原顺序），点击的集必须
            // 在子集内——从它的子集位置开始连播；队列/标题随之只含勾选集。
            let playEpisodes = episodes;
            let playIdx = Math.max(0, epIndex);
            if (this._playSubset && Array.isArray(this._playSubset.indexes) && road) {
                const want = new Set(this._playSubset.indexes);
                const subset = episodes.filter((_, i) => want.has(i));
                if (subset.length) {
                    playEpisodes = subset;
                    const hit = subset.findIndex((ep) => ep.url === url);
                    playIdx = hit >= 0 ? hit : 0;
                }
            }
            // 选集播放：先走统一关闭钩子（清 SSE 流），再进播放器
            this._onSourceDlgClosed();
            closeDialog('kazumiSourceDialog');
            Player.play('kazumi:' + pluginName, flag, url, title, name, playEpisodes, Math.max(0, playIdx), src || '');
        });
        // 弹幕入口（kimi UI）：播放时自动加载弹幕
        box.find('.kazumi-ep-btn').on('contextmenu', (e) => {
            e.preventDefault();
            const el = $(e.currentTarget);
            const name = String(el.data('name') || '');
            warnToast(`弹幕功能开发中：${name}`);
        });
    },

    /** 从指定线路按勾选集批量下载（Bangumi 分集多选下载）：优先按 0 基下标定位（downloadIndexes），
     *  退回按集号文本匹配 identifier。修复此前只下载点击那一集、或集号匹配不到只下 1 集的 bug。 */
    async _downloadKazumiEpisodesFromRoad(pluginName, road, dlMode) {
        if (!road || !road.data || !road.data.length) { warnToast('该线路无可下载的集'); return; }
        const title = (dlMode && dlMode.title) || '';
        const idents = road.identifier || [];
        const targets = [];
        const usedUrls = new Set();
        // 首选：按下标直接取（Bangumi 分集顺序与线路集顺序通常一致，最可靠）
        if (dlMode && Array.isArray(dlMode.indexes) && dlMode.indexes.length) {
            dlMode.indexes.forEach((i) => {
                if (i >= 0 && i < road.data.length) {
                    const u = road.data[i];
                    if (!usedUrls.has(u)) { usedUrls.add(u); targets.push({ url: u, name: idents[i] || `第${i + 1}集` }); }
                }
            });
        }
        // 补充：按下标未匹配到全部时，按集号文本匹配 identifier 的数字补齐缺失的集
        if (dlMode && dlMode.episodes && dlMode.episodes.length && targets.length < dlMode.episodes.length) {
            const wantNos = new Set((dlMode.episodes || []).map((x) => String(x)));
            (road.data || []).forEach((u, i) => {
                if (usedUrls.has(u)) return;
                const ident = String(idents[i] || '');
                const m = ident.match(/\d+/);
                const identNo = m ? m[0] : '';
                if (wantNos.has(identNo) || wantNos.has(String(i + 1))) {
                    usedUrls.add(u);
                    targets.push({ url: u, name: ident || `第${i + 1}集` });
                }
            });
        }
        if (!targets.length) { warnToast('未能在该线路匹配到勾选的集'); return; }
        this._onSourceDlgClosed(); // 批量下载同样先清 SSE 流再关弹窗
        closeDialog('kazumiSourceDialog');
        this._dlDownloadMode = null;
        warnToast(`开始解析并下载 ${targets.length} 集…`);
        let ok = 0, fail = 0, skipped = 0;
        for (const t of targets) {
            const r = await this._downloadKazumiEp(pluginName, t.url, t.name, title, true);
            if (r === 'skipped') skipped++;
            else if (r) ok++;
            else fail++;
        }
        const bits = [`下载已加入 ${ok} 集`];
        if (skipped) bits.push(`${skipped} 集已在队列/已下载，跳过`);
        if (fail) bits.push(`${fail} 集失败`);
        warnToast(`${bits.join('，')}，可在“下载”页查看`);
    },

    /** 下载 Kazumi 源单集：解析真实直链后交下载引擎（m3u8 走 addHls 合成 mp4）。
     *  silent=true 时不弹单条 toast（批量下载用）；返回 true=已加入、'skipped'=同源同集
     *  去重跳过、false=失败。
     *  ep* 去重上下文与播放链同源（Player.play 的 site='kazumi:规则名'、title=剧名、
     *  subtitle=集名），手动下载与边下边播共用「站点|剧名|集名」key。 */
    async _downloadKazumiEp(pluginName, url, name, title, silent) {
        if (!pluginName || !url) { if (!silent) warnToast('下载参数缺失'); return false; }
        if (!silent) showLoading();
        try {
            const rsp = await doAction('kazumiResolve', { pluginName, url }, '/kazumi/action');
            const data = (rsp && typeof rsp === 'object') ? rsp : {};
            const pageUrl = data.pageUrl || url;
            const header = {};
            if (data.userAgent) header['User-Agent'] = data.userAgent;
            if (data.referer) header['Referer'] = data.referer;
            const legacyEnabled = (await window.yuki.settingsGet().catch(() => ({})))?.legacyParser !== false;
            const legacy = legacyEnabled && !!data.useLegacyParser;
            let resolved = null;
            try {
                const cap = await window.yuki.captureDirect(pageUrl, legacy);
                if (cap && cap.ok) resolved = { url: cap.url, header: { ...header, ...(cap.header || {}) } };
            } catch (e) { /* 抓取异常 */ }
            if (!silent) hideLoading();
            if (!resolved || !resolved.url) { if (!silent) warnToast(`「${name}」未解析到可下载地址`); return false; }
            const clean = resolved.url.split('?')[0];
            const isM3u8 = /\.m3u8(\?|#|$)/i.test(clean);
            // 无法从 URL 识别扩展名时默认 .mp4（多数流媒体直链无标准后缀）
            const ext = isM3u8 ? '.mp4' : (clean.match(/\.(mp4|flv|mov|mkv|webm|avi|ts)$/i) || [''])[0] || '.mp4';
            const out = `${title || '视频'} - ${name}${ext}`;
            const res = await window.yuki.download.control(isM3u8 ? 'addHls' : 'add', {
                uri: resolved.url, out, header: resolved.header,
                epSite: 'kazumi:' + pluginName, epVodName: title || '', epName: name || '',
            });
            if (res && res.ok) { if (!silent) warnToast(`已加入下载「${name}」，可在“下载”页查看`); return true; }
            // 去重命中：不算失败，批量路径按 skipped 计数
            if (res && res.reason === 'already-downloading') { if (!silent) warnToast(`「${name}」已在下载队列，跳过重复下载`); return 'skipped'; }
            if (res && res.reason === 'already-done') { if (!silent) warnToast(`「${name}」已下载过，无需重复下载`); return 'skipped'; }
            if (!silent) {
                if (res && res.reason === 'ffmpeg-downloading') warnToast('ffmpeg 正在后台下载，完成后重试即可');
                else if (res && res.reason === 'ffmpeg-missing') warnToast('ffmpeg 未就绪，m3u8 暂无法合成');
                else warnToast('加入下载失败');
            }
            return false;
        } catch (e) {
            if (!silent) { hideLoading(); warnToast('下载解析失败'); }
            return false;
        }
    },
};

// ---------------------------------------------------------------- 弹幕（弹弹 play）

/** 弹幕加载（方案 A）：按片名+集数从弹弹 play 拉整集弹幕，转推给 mpv（ASS + sub-reload）。
 *  返回装载条数；匹配不到/失败返回 0。episode 为集序号（从 1 起）。 */
Kazumi.loadDanmaku = async function (title, episode) {
    try {
        // 步骤 1：搜索 DanDanBangumiID
        const searchRsp = await doAction('kazumiDanmakuSearch', { title }, '/kazumi/action');
        const animes = (searchRsp && searchRsp.results) || [];
        if (!animes.length) { console.log('[kazumi] danmaku: no match for', title); return 0; }
        // 取相似度最高的结果
        const best = animes[0];
        const bangumiId = best.animeId || best.bangumiId || 0;
        if (!bangumiId) return 0;
        // 步骤 2：获取分集弹幕 ID
        const epRsp = await doAction('kazumiDanmakuEpisode', { bangumiId, episode: episode || 1 }, '/kazumi/action');
        const episodeId = (epRsp && epRsp.episodeId) || 0;
        if (!episodeId) return 0;
        // 步骤 3：拉取弹幕
        const commentsRsp = await doAction('kazumiDanmakuComments', { episodeId }, '/kazumi/action');
        const comments = (commentsRsp && commentsRsp.comments) || [];
        if (!comments.length) { console.log('[kazumi] danmaku: 0 comments for', title, 'ep', episode); return 0; }
        // 步骤 4：转 ASS 推给 mpv（方案 A：起播后一次性装载整集弹幕）
        let count = 0;
        if (window.yuki && window.yuki.loadDanmaku) {
            const r = await window.yuki.loadDanmaku(comments);
            count = (r && r.ok) ? (r.count || 0) : 0;
        }
        console.log('[kazumi] danmaku loaded:', count, 'of', comments.length, 'for', title, 'ep', episode);
        return count;
    } catch (e) {
        console.warn('[kazumi] danmaku load failed:', e);
        return 0;
    }
};

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.kazumi = Kazumi;
}(typeof window !== 'undefined' ? window : globalThis));

// ---------------------------------------------------------------- 以图搜番（trace.moe）

/** 以图搜番：上传图片或粘贴图片 URL，调 trace.moe 识别番剧。返回 {results, error}。 */
Kazumi.imageSearch = async function (imageFile) {
    try {
        if (typeof imageFile === 'string' && /^https?:\/\//i.test(imageFile)) {
            // URL：后端下载图片字节后上传识别（trace.moe URL 直传被 403 拦截，T74）
            const rsp = await doAction('kazumiImageSearch', { url: imageFile }, '/kazumi/action');
            return { results: (rsp && rsp.results) || [], error: (rsp && rsp.error) || '' };
        }
        // 文件上传（File 对象转 base64）
        if (imageFile instanceof File) {
            const b64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(imageFile);
            });
            const rsp = await doAction('kazumiImageSearch', { base64: b64 }, '/kazumi/action');
            return { results: (rsp && rsp.results) || [], error: (rsp && rsp.error) || '' };
        }
        return { results: [], error: '请提供图片 URL 或选择图片文件' };
    } catch (e) {
        return { results: [], error: '以图搜番失败' };
    }
};

// ---------------------------------------------------------------- WebDAV 同步

/**
 * 设置同步排除项：不参与「设置同步」上传/覆盖。
 * - favorites/history/watchStats：各自独立文件，由子开关单独控制；
 * - webDavUrl/Username/Password：凭据不随快照走，避免覆盖本机 WebDAV 配置；
 * - bangumiToken/dandanAppSecret：凭据类键（与主进程 settings.js SENSITIVE_KEYS
 *   同级别），同步到远端 WebDAV 即把账号凭据明文交给服务器管理员，绝不随快照走；
 * - cacheDir/dlDir/wallpaper：本机绝对路径，跨设备无意义；
 * - settingsCat：纯本机界面记忆。
 * - webDavRestoreBackup：恢复前的本机备份快照，体积大且仅本机有意义
 * 注意 watchProgress（通用观看进度表，records.js 维护）不在排除表内——它是用户数据，
 * 理应随「设置同步」快照通道上传/恢复（恢复侧经 WEBDAV_RESTORE_ALLOWED 显式放行）；
 * favorites/history/watchStats 则走各自独立文件通道，不经此快照。
 */
const WEBDAV_SETTINGS_EXCLUDE = new Set([
    'favorites', 'history', 'watchStats',
    'webDavUrl', 'webDavUsername', 'webDavPassword',
    // webDav* 其余键同理（本版补齐）：远程目录/证书跳过/定时同步/启动拉取/子开关
    // 都是「本机同步哪些内容、怎么连远端」的机器绑定配置。随云端快照走等于让拿到
    // 快照的人改写本机连接行为——恢复后自动开始往云端上传、把数据写去另一个远程
    // 目录、或替本机决定"以后同步设置/规则"。WebDAV 自身配置只由设置页写入，
    // 永不随同步往返（恢复允许表也不含这些键）。
    'webDavRemoteDir', 'webDavSslSkip', 'webDavStartupPull',
    'webDavAutoEnable', 'webDavAutoMinutes',
    'webDavEnable', 'webDavEnableCollect', 'webDavEnableHistory',
    'webDavEnableRules', 'webDavEnableSettings', 'webDavEnableStats',
    'bangumiToken', 'dandanAppSecret',
    // bangumiLastSyncAt：「最新修改时间优先」同步的裁决基准 = 本机与远端上次对齐的
    // 时刻。跨设备恢复它会让另一台机器的增量判定错位（明明没同步过却以为已对齐，
    // 于是跳过本该上传的改动），属机器相关键：上传与恢复双向排除。
    'bangumiLastSyncAt',
    // 本机绝对路径（cacheDir/dlDir/wallpaper 同口径）：换台机器必然无意义，
    // 播放器路径尤其会把另一端的起播指向不存在的可执行文件。
    'mpvPath', 'externalPlayerPath',
    // 首启状态与日志清理水位：只对本机这一次安装有意义
    'onboarded', 'logLastCleanupAt',
    'cacheDir', 'dlDir', 'wallpaper', 'settingsCat',
    'webDavRestoreBackup', // 恢复前的本机备份快照，体积大且仅本机有意义
    // LLM 凭据：与 bangumiToken 同级别，绝不随设置快照上传远端。
    // 上传侧漏排的后果是明文密钥进用户自托管 WebDAV（可能还是自签名证书通道）；
    // 恢复侧 WEBDAV_RESTORE_ALLOWED 本就未放行 key，说明上传侧是遗漏而非设计。
    // 注：*Base（服务地址）不在此列——它不是本机绑定键，保留上传便于诊断；
    // 恢复侧照样不放行（见 WEBDAV_RESTORE_ALLOWED 里 captchaLLMBase 的说明）。
    'translateLLMKey', 'captchaLLMKey',
]);

/** 构建「设置同步」快照：全量设置剔除排除项后的浅拷贝。 */
Kazumi._webdavSettingsSnapshot = function (s) {
    const snap = {};
    for (const k of Object.keys(s || {})) {
        if (!WEBDAV_SETTINGS_EXCLUDE.has(k)) snap[k] = s[k];
    }
    return snap;
};

/**
 * 「从云端恢复」的设置键允许表（P2-5）：只恢复纯数据键——播放/界面偏好与
 * 观看辅助数据，跨设备迁移动作本来就要的就是这些。显式排除（默认拒绝）：
 * - 凭据：bangumiToken/dandanAppSecret/dandanAppId（与上传侧排除表同级别）；
 * - URL/路径类：lastConfigUrl/configHistory（启动自动重载/历史直连的配置源，
 *   静默恢复改写即加载恶意源）、probeSourceUrl（lastConfigUrl 的仓标识副本）、
 *   proxyUrl/proxyTestUrl、cacheDir/dlDir/wallpaper（本机绝对路径）、
 *   webDav* 本组自引用键（避免恢复过程改写正在使用的同步配置）、
 *   bangumiMirrorRoot（镜像域名，恢复后会话直连攻击者域名）；
 * - 本机态：settingsCat/webDavRestoreBackup（只增不减的本地备份）。
 * 新增跨设备可迁移的偏好键时须显式加入此表。
 *
 * 与 WEBDAV_SETTINGS_EXCLUDE 的一致性口径（本版核对过的三条）：
 * 1. 两表交集必须为空——交集非空即「既不上传又能恢复」的死键，或「不该上传却
 *    被恢复」；单测 webdav-sync-payload 里有这条断言；
 * 2. 排除表里的键（凭据/URL/路径/webDav* 自身/机器态）一律不进本表；
 * 3. 本表允许 → 主进程 SETTINGS_SET_ALLOWED 必须放行（否则 settingsSet 被静默
 *    ignored，恢复看着成功实则没落盘，H-1 同类）。已在 tests/js 单测里断言。
 */
const WEBDAV_RESTORE_ALLOWED = new Set([
    // 观看行为
    'resumePos', 'autoNext', 'autoLineFallback', 'autoUpdate', 'updateNotify',
    'danmakuEnable', 'dlNotify', 'dlSeriesFolder', 'simulDownload', 'hlsAdFilter',
    'mediaProbe', 'anime4k', 'anime4kMode', 'bgPlay', 'incognito', 'errorToast',
    // 播放器偏好
    'playerVolume', 'playerSpeed', 'playerAlang', 'playerSlang', 'playerHotkeys',
    // 界面/外观（不含 wallpaper：本机绝对路径）
    'theme', 'customTheme', 'colorMode', 'fontSize', 'textSize', 'textColor',
    'glass', 'animEnabled', 'wallpaperDim', 'wallpaperAdjust', 'useMisansFont',
    'navCollapsed', 'startupView', 'closeAction', 'systemTitleBar',
    'uiStateMemory',
    // 数据/探针纯数据键
    'blockedReason', 'blockedSites', 'probedSites', 'probedAt', 'probeFp',
    'probeFailStreak', 'lastSourceMap', 'recentWatches', 'watchStatsEnabled',
    'watchProgress', // 通用观看进度表（records.js 维护，随设置快照通道同步/恢复）
    'sourceAutoDetect', 'catvodBgmMatch', 'legacyParser', 'customLives',
    // 全局番剧屏蔽：纯偏好数据（无 URL/路径/凭据），跨设备迁移合情合理
    'blockWords', 'blockWordsEnable',
    'liveProbeCache', 'enableBangumiProxy', 'enableBangumiWebMirror', 'enableGitProxy',
    // 各列表页每页条数
    'pageSizeFavorites', 'pageSizeHistory', 'pageSizeHome', 'pageSizeLive',
    'pageSizePopular', 'pageSizeSearch',
    // Bangumi 同步偏好（仅开关，token 绝不恢复）
    'bangumiAutoSyncOnStart', 'bangumiAutoSyncStatus', 'bangumiImmediateSyncToastEnable',
    'bangumiProgressSync', 'bangumiSyncPriority',
    // 验证码视觉 LLM 配置：仅恢复开关与模型名。captchaLLMBase 属 URL 类键
    // （与 bangumiMirrorRoot/proxyUrl 同口径，见本表上方注释）——恢复后本机会
    // 把 safeStorage 解密的 captchaLLMKey 以 Bearer 发往该地址并附带验证码图片，
    // 云端快照即可劫持本机凭据，故不予恢复，base 由用户在本机重新填写。
    'captchaLLMEnable', 'captchaLLMModel', 'captchaLLMPrefer',
    // ── 本版新增（同步内容对齐软件最新数据模型）──
    // 搜索历史（search-history.js，[{word,source,ts}]）：纯用户数据，跨设备迁移
    // 正是「我搜过什么」的正当诉求，纳入。
    'searchHistory',
    // Kazumi 别名检索表（kazumi.js，键 t:<片名>/bgm:<id> → [{alias,ts,hits}]）：
    // 用户手工/半自动沉淀的检索词，属纯用户数据；已在写侧收敛到 500 键，体量可控。
    'kazumiAliasMap',
    // 收藏/历史页的排序与筛选偏好（records.js）：纯界面偏好。选择纳入——属用户配置、
    // 体量小（一个字符串 + 一个小对象），且「我习惯按评分排序、只看某源」在换机后
    // 仍然成立；不含 URL/路径/凭据，无恢复风险。
    'favoritesSort', 'favoritesFilter', 'historySort', 'historyFilter',
    // ── 补漏：此前上传了却恢复不了的纯偏好键 ──
    // 这类键不在允许表时表现为「云端有值、恢复后开关不生效」，与 H-1（开关静默
    // ignored）同类；均为无 URL/无凭据的本地偏好，恢复无风险。
    'opEdSkip', 'opEdSave',              // 智能跳过片头/片尾与登记开关（记录在 localStorage，见报告）
    'translateEnable', 'translateTrigger', 'translateTarget', // 划词翻译偏好（LLM key 绝不恢复）
    'translateLLMEnable', 'translateLLMModel',                // 翻译 LLM 开关/模型名（base 属 URL 类，不放行）
    'kazumiAutoUpdateOnStart',           // 启动自动更新规则
]);

/**
 * 恢复值的形态表：只对「形态错了会真出错」的键做硬校验——数组键拿到对象会让
 * .map/.filter/.length 直接抛 TypeError 或渲染出空白页；对象键拿到标量则取不到字段。
 * 未列出的键按「标量槽位」处理：收到数组/对象即跳过（标量键拿到容器必然是脏数据），
 * null/字符串/数字/布尔一律放行。
 * 取舍：宁可少拦（云端脏值最多让该项回落默认值）也不误拦——误拦等于用户数据静默
 * 不恢复，比放行更伤。favorites/history 不在此表：它们走独立文件通道，调用方已用
 * Array.isArray 判定；configHistory 等 URL 类键本身不进允许表（在拒绝表），无需形态表。
 */
const WEBDAV_RESTORE_ARRAY_KEYS = new Set([
    'searchHistory', 'blockWords', 'recentWatches',
    'probedSites', 'customLives',
]);
const WEBDAV_RESTORE_OBJECT_KEYS = new Set([
    'watchStats', 'watchProgress', 'lastSourceMap', 'liveProbeCache',
    'kazumiAliasMap', 'favoritesFilter', 'historyFilter', 'playerHotkeys',
    'blockedReason', 'probedAt', 'probeFp',
]);

/** 值类型的中文名（恢复报告里的可诊断原因用）。 */
function webdavTypeName(v) {
    if (v === null || v === undefined) return '空值';
    if (Array.isArray(v)) return '数组';
    if (typeof v === 'object') return '对象';
    if (typeof v === 'string') return '字符串';
    if (typeof v === 'number') return '数字';
    if (typeof v === 'boolean') return '布尔';
    return typeof v;
}

/** 内网/本机/局域网主机名判定（仅用于提示文案，不参与放行/拦截决策）。 */
function isPrivateWebdavHost(host) {
    const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!h) return false;
    if (h === 'localhost' || h.endsWith('.localhost')
        || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home')) return true;
    if (h.indexOf(':') >= 0) { // IPv6：回环 ::1 / 链路本地 fe80:: / 唯一本地 fc00::、fd00::
        return h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd');
    }
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 127 || a === 10 || (a === 192 && b === 168)
        || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a === 0;
}

/**
 * WebDAV 地址前置校验：返回 {ok, reason, hint}。渲染层是第一道，后端
 * _webdav_url_guard 是第二道（同一语义，见 plugin_manager）。
 * reason 是可直接弹给用户的完整中文句子（失败时调用方直接展示，不再套前缀）。
 *
 * 只允许 http/https：file://、dict://、gopher:// 在后端 requests 里没有适配器，
 * 放行只会抛出英文 InvalidSchema（"No connection adapters were found"），用户
 * 完全不知道错在哪；这里先给中文原因，省掉一次注定失败的往返。
 *
 * 内网/环回/保留地址一律**放行**——自建 NAS/内网 WebDAV 正是本功能的主流用法，
 * 拦掉等于砍功能——只把可理解的提示放在 hint 里（不是拒绝理由，故与 ok 分开）。
 */
Kazumi._webdavUrlCheck = function (raw) {
    const url = String(raw || '').trim();
    if (!url) return { ok: false, reason: '请输入 WebDAV 地址', hint: '' };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
        return { ok: false, reason: 'WebDAV 地址缺少协议前缀，请以 http:// 或 https:// 开头', hint: '' };
    }
    let u = null;
    try {
        u = new URL(url);
    } catch (e) {
        return { ok: false, reason: 'WebDAV 地址格式不正确，请检查是否有多余字符（如空格、中文标点）', hint: '' };
    }
    const scheme = String(u.protocol || '').replace(':', '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
        return { ok: false, reason: `WebDAV 地址只支持 http/https，当前为 ${scheme}://（file://、ftp://、dict:// 等协议不被支持）`, hint: '' };
    }
    if (!u.hostname) return { ok: false, reason: 'WebDAV 地址缺少主机名（例如 https://nas.example/dav）', hint: '' };
    let hint = '';
    if (isPrivateWebdavHost(u.hostname)) {
        hint = '内网/本机地址：只在你信任的网络内可达，请确认这是你的 NAS 或自建服务';
    } else if (scheme === 'http') {
        hint = '明文 http 传输：账号密码与同步数据在网络上可见，建议改用 https';
    }
    return { ok: true, hint: hint };
};

/**
 * 「已知但**故意**不恢复」的设置键（默认拒绝的第二档）。
 *
 * 为什么需要第三张表：云端快照是「全量设置减去排除表」，所以自己的新备份里必然带着
 * 一批「知道、但就是不恢复」的键（凭据/URL/本机路径…）。若把这些都算作「未知键」，
 * 每次恢复都会冒出「N 项本机不识别已忽略」的提示——把正常的默认拒绝说成异常，
 * 用户会以为备份坏了。分档后：本表 = 静默忽略（只进明细日志），真正的未知键
 * （旧版遗留键、更高版本新增键）才计数上报。
 *
 * 各档判定顺序：WEBDAV_RESTORE_ALLOWED → 本表 → 都不在 = 未知（计入报告）。
 */
const WEBDAV_RESTORE_DENIED = new Set([
    // 凭据类（与上传侧排除表同级别：dandanAppId 是应用标识，同属凭据包）
    'bangumiToken', 'dandanAppSecret', 'dandanAppId', 'translateLLMKey', 'captchaLLMKey',
    // URL / 配置源类：恢复即等于让云端快照改写本机的连接目标
    // （lastConfigUrl 会在下次启动自动加载该配置源；LLM base 会把本机凭据发往该地址）
    'lastConfigUrl', 'configHistory', 'probeSourceUrl', 'proxyUrl', 'proxyTestUrl',
    'bangumiMirrorRoot', 'translateLLMBase', 'captchaLLMBase',
    // 代理开关：URL 不恢复而开关恢复，等于把本机流量导去一个由别处决定的目标
    // （且写入会即时重启后端），故一并拒绝
    'proxyEnable',
    // 本机绝对路径 / 本机状态
    'cacheDir', 'dlDir', 'wallpaper', 'settingsCat', 'webDavRestoreBackup',
    'mpvPath', 'externalPlayerPath', 'onboarded', 'logLastCleanupAt', 'bangumiLastSyncAt',
    // WebDAV 自身配置（本机怎么连远端，见上传侧排除表同组注释）。
    // 与本表/排除表的重叠是有意的：这些键不会被自己的快照携带（上传侧已排除），
    // 列在这里是为了让「外来/被篡改快照」携带它们时同样静默拒绝，
    // 而不是被当成「未知键」冒进提示里。
    'webDavUrl', 'webDavUsername', 'webDavPassword', 'webDavRemoteDir', 'webDavSslSkip',
    'webDavStartupPull', 'webDavAutoEnable', 'webDavAutoMinutes',
    'webDavEnable', 'webDavEnableCollect', 'webDavEnableHistory',
    'webDavEnableRules', 'webDavEnableSettings', 'webDavEnableStats',
    // 下载/日志/性能类：与另一台机器的带宽、磁盘、调试需求强相关，不做跨设备搬运
    'dlConcurrency', 'dlSplitConcurrency', 'panFastPath',
    'logLevel', 'logAutoCleanup', 'logCleanupDays',
]);

/** 恢复值形态判定：返回 '' 表示可用，否则返回可诊断的中文原因（供恢复报告用）。 */
Kazumi._webdavValueIssue = function (key, val) {
    const k = String(key);
    if (WEBDAV_RESTORE_ARRAY_KEYS.has(k) && !Array.isArray(val)) {
        return `期望数组，实际是${webdavTypeName(val)}`;
    }
    if (WEBDAV_RESTORE_OBJECT_KEYS.has(k) && (!val || typeof val !== 'object' || Array.isArray(val))) {
        return `期望对象，实际是${webdavTypeName(val)}`;
    }
    if (!WEBDAV_RESTORE_ARRAY_KEYS.has(k) && !WEBDAV_RESTORE_OBJECT_KEYS.has(k)
        && val !== null && typeof val === 'object') {
        return `期望单值，实际是${webdavTypeName(val)}`;
    }
    return '';
};

/** 比较两个值是否「JSON 等价」（备份差异判定用；循环引用等异常一律按不同处理）。 */
Kazumi._webdavSameJson = function (a, b) {
    try {
        return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    } catch (e) {
        return false;
    }
};

/** WebDAV 同步：上传收藏/历史/规则/设置/观看统计到远程；按子开关决定包含哪些数据。
 *  webDavSslSkip 开启时通知后端跳过证书校验（自签名服务器）；
 *  remoteDirOverride 未传时用已保存的 webDavRemoteDir（自动同步走此路径）。
 *  载荷版本标识（_meta.json）由后端生成——单一真相在 plugin_manager，渲染层不需要
 *  知道版本号，只需在恢复时读回 schemaVersion 用于提示。 */
Kazumi.webdavSync = async function (url, username, password, remoteDirOverride) {
    try {
        // 程序化入口（自动同步/启动拉取）持的是持久化设置，可能是历史遗留的非法地址：
        // 这里先拦一次，省掉一次注定失败的往返（UI 入口已先校验，不会重复提示）
        const urlCheck = this._webdavUrlCheck(url);
        if (!urlCheck.ok) { warnToast(urlCheck.reason); return false; }
        const s = (await window.yuki.settingsGet()) || {};
        const data = {};
        // _rulesLoaded 只在 kazumiList 成功返回后置 true（失败时 _rules 被清空为 []）。
        // 启动瞬时失败期间的自动同步若不设防，会把「空规则」当真实列表上传，覆盖云端规则备份。
        if (s.webDavEnableRules !== false) {
            if (!this._rulesLoaded) {
                warnToast('规则列表尚未加载完成，本次同步已取消（避免空规则覆盖云端备份）');
                // 返回 'skip' 区分「守卫跳过」与真实失败：调用方对跳过静默处理，
                // 不再补发误导性的「WebDAV 同步失败」toast/失败状态
                return 'skip';
            }
            data.kazumiRules = this._rules || [];
        }
        if (s.webDavEnableCollect !== false) data.favorites = s.favorites || [];
        if (s.webDavEnableHistory !== false) data.history = s.history || [];
        if (s.webDavEnableSettings !== false) data.settings = this._webdavSettingsSnapshot(s);
        if (s.webDavEnableStats !== false) data.watchStats = s.watchStats
            || { totalSeconds: 0, sessionCount: 0, titles: {}, daily: {}, bySite: {} };
        if (!Object.keys(data).length) { warnToast('未选择任何要同步的内容，请先开启子开关'); return false; }
        const rsp = await doAction('kazumiWebdavSync', {
            url, username, password, data: JSON.stringify(data),
            sslVerify: s.webDavSslSkip ? '0' : '1',
            remoteDir: remoteDirOverride !== undefined ? remoteDirOverride : (s.webDavRemoteDir || ''),
        }, '/kazumi/action');
        return rsp && rsp.code === 200;
    } catch (e) {
        warnToast('WebDAV 同步失败');
        return false;
    }
};

/** WebDAV 恢复：从远程下载收藏/历史/规则/设置/观看统计；仅恢复子开关启用的数据。 */
Kazumi.webdavRestore = async function (url, username, password, remoteDirOverride) {
    try {
        // 同 webdavSync：程序化入口（启动静默恢复）先拦非法地址
        const urlCheck = this._webdavUrlCheck(url);
        if (!urlCheck.ok) { warnToast(urlCheck.reason); return false; }
        const s = (await window.yuki.settingsGet()) || {};
        const names = [];
        if (s.webDavEnableRules !== false) names.push('kazumiRules');
        if (s.webDavEnableCollect !== false) names.unshift('favorites');
        if (s.webDavEnableHistory !== false) names.unshift('history');
        if (s.webDavEnableSettings !== false) names.push('settings');
        if (s.webDavEnableStats !== false) names.push('watchStats');
        if (!names.length) { warnToast('未选择任何要恢复的内容，请先开启子开关'); return false; }
        const rsp = await doAction('kazumiWebdavRestore', {
            url, username, password, names: JSON.stringify(names),
            sslVerify: s.webDavSslSkip ? '0' : '1',
            remoteDir: remoteDirOverride !== undefined ? remoteDirOverride : (s.webDavRemoteDir || ''),
        }, '/kazumi/action');
        const d = (rsp && typeof rsp === 'object') ? rsp.data : null;
        // 云端版本标识（本版新增）：schemaVersion=1 = 旧版备份（云端没有 _meta.json），
        // 2 = 本版。读不到/字段非法一律按 1 处理——用户的历史备份必须能继续恢复。
        const cloudMeta = (rsp && typeof rsp === 'object' && rsp.meta && typeof rsp.meta === 'object') ? rsp.meta : {};
        const cloudWarnings = (rsp && typeof rsp === 'object' && Array.isArray(rsp.warnings)) ? rsp.warnings : [];
        const schemaVersion = Number(cloudMeta.schemaVersion) || 1;
        // 空数据/失败都必须走失败提示：后端失败返回 {code:500,msg}，此前空对象 {} 是
        // truthy 被当成功——网址输错时提示「恢复完成」实际什么都没恢复
        const gotAny = d && (d.favorites || d.history || d.kazumiRules || d.settings || d.watchStats);
        if (rsp && rsp.code === 200 && gotAny) {
            // 恢复报告：跳过了什么、为什么。计数进 toast（明细刷屏），键名与原因进
            // console 与 _lastWebdavRestoreReport（排障/单测读取）
            const report = { schemaVersion: schemaVersion, skipped: [], denied: [], ignored: [], failed: [], warnings: cloudWarnings };
            // 覆盖前备份：恢复直接覆盖本机数据且不可撤销，先把将被覆盖且有差异的
            // 本地原值存到 webDavRestoreBackup（仅本机、不参与同步快照），供误恢复后找回。
            // 本版把设置通道的允许键全部纳入——此前只存 favorites/history/watchStats/
            // watchProgress 四个，其余键被恢复改坏后无从找回（备份本身体量很小）。
            const backup = { ts: Date.now() };
            // watchProgress 走 settings 快照通道（云端新值在 d.settings 内，不在顶层 d[k]），
            // 其余键为独立通道（云端新值在 d[k]）；备份逻辑统一从对应通道取「云端新值」
            ['favorites', 'history', 'watchStats', 'watchProgress'].forEach((k) => {
                const incoming = (k === 'watchProgress') ? d.settings && d.settings[k] : d[k];
                if (incoming && !this._webdavSameJson(s[k], incoming)) backup[k] = s[k] ?? null;
            });
            if (d.kazumiRules && (this._rules || []).length) backup.kazumiRules = this._rules;
            if (d.settings) {
                for (const [key, val] of Object.entries(d.settings)) {
                    if (!WEBDAV_RESTORE_ALLOWED.has(key)) continue; // 不落盘的键无需备份
                    if (this._webdavSameJson(s[key], val)) continue; // 无差异不占体积
                    backup[key] = (s && Object.prototype.hasOwnProperty.call(s, key)) ? s[key] : null;
                }
            }
            const backedUp = Object.keys(backup).length > 1;
            if (backedUp) await window.yuki.settingsSet('webDavRestoreBackup', backup);
            // 收藏/历史改走 recSet：写 settings 的同时经 FavHub.changed 广播给订阅者
            // （详情页收藏按钮/我的页/时间表），否则恢复后订阅者仍持有旧数据。
            // watchStats 无订阅者（FavHub 只认 favorites），保持 settingsSet 即可。
            // 每个通道独立判形态 + 独立 try/catch：单个键类型不符或写失败只记账跳过，
            // 绝不拖垮其余键（规则导入尤其不能被坏掉的收藏数组连坐）。
            if (d.favorites !== undefined) {
                if (!Array.isArray(d.favorites)) report.skipped.push(`favorites（期望数组，实际是${webdavTypeName(d.favorites)}）`);
                else {
                    try { await recSet('favorites', d.favorites); } catch (e) { report.failed.push('favorites'); }
                }
            }
            if (d.history !== undefined) {
                if (!Array.isArray(d.history)) report.skipped.push(`history（期望数组，实际是${webdavTypeName(d.history)}）`);
                else {
                    try { await recSet('history', d.history); } catch (e) { report.failed.push('history'); }
                }
            }
            if (d.watchStats !== undefined) {
                const wsIssue = this._webdavValueIssue('watchStats', d.watchStats);
                if (wsIssue) report.skipped.push(`watchStats（${wsIssue}）`);
                else {
                    try { await window.yuki.settingsSet('watchStats', d.watchStats); } catch (e) { report.failed.push('watchStats'); }
                }
            }
            if (d.kazumiRules !== undefined) {
                // 非 Array 不当格式错误整批失败（此前 warnToast 后 return false 会让
                // 同一次恢复里的设置键一起被丢掉），改为跳过并记账，其余键照常恢复
                if (!Array.isArray(d.kazumiRules)) {
                    report.skipped.push(`kazumiRules（期望数组，实际是${webdavTypeName(d.kazumiRules)}）`);
                } else {
                    // 规则逐个导入：单条损坏只跳过计数，不再中断整批
                    let okRules = 0, failRules = 0;
                    for (const rule of d.kazumiRules) {
                        try {
                            const r = await doAction('kazumiAdd', { json: JSON.stringify(rule) }, '/kazumi/action');
                            if (r && r.code === 200) okRules++; else failRules++;
                        } catch (err) { failRules++; }
                    }
                    await this.refreshRuleList();
                    if (failRules) warnToast(`规则导入完成：${okRules} 成功，${failRules} 条失败已跳过`);
                }
            }
            let needRestartHint = false;
            if (d.settings) {
                // 设置快照逐键写回。P2-5：改显式允许表——云端快照是攻击者可控的
                // 数据源（任何拿到 WebDAV 账号的人都能改写），此前「仅剔除排除项」
                // 意味着新出现的 URL/路径/开关类键默认放行；启动 5s 静默恢复
                // （scheduleWebdavStartupPull）走同一入口，可无感改写 lastConfigUrl
                // 等键（下次启动自动加载恶意配置源）。只恢复纯数据键：凭据、URL/
                // 路径、以及不在表内的未知键一律不落本机（默认拒绝）。
                for (const [key, val] of Object.entries(d.settings)) {
                    if (!WEBDAV_RESTORE_ALLOWED.has(key)) {
                        // 已知但故意不恢复的键（凭据/URL/本机路径/机器态/webDav*）→ 静默
                        // 记账，不进 toast：这是设计内的默认拒绝，不是异常。排除表里的键
                        // 正常不会出现在自己的快照里，一并归此档以覆盖外来/被篡改快照。
                        if (WEBDAV_RESTORE_DENIED.has(key) || WEBDAV_SETTINGS_EXCLUDE.has(key)) {
                            report.denied.push(key);
                            continue;
                        }
                        // 真正的未知键（旧版遗留键/更高版本新增键）→ 明确忽略并计入报告：
                        // 静默丢弃会让用户以为「云端就没有这项数据」，报告才能解释差异
                        report.ignored.push(key);
                        continue;
                    }
                    // 类型/结构不符 → 跳过该键并记原因，继续恢复其余键（单键失败不拖垮整批）
                    const issue = this._webdavValueIssue(key, val);
                    if (issue) { report.skipped.push(`${key}（${issue}）`); continue; }
                    try {
                        // 缺键不算问题：本循环只遍历云端携带的键，云端没带的键保持本地现状
                        // （绝不用 undefined 覆盖本地值）
                        const res = await window.yuki.settingsSet(key, val);
                        // 主进程白名单未放行时静默返回 {ignored:true}（H-1 同类的静默失败），
                        // 这里显式升级为「写入失败」报告，否则表现为「恢复成功但开关没变」
                        if (res && res.ignored) { report.failed.push(`${key}（主进程未放行该设置键）`); continue; }
                    } catch (e) {
                        report.failed.push(key);
                        continue;
                    }
                    // 触发重启提示的键（真实键名，与 index.js setProxy/setPanFastPath 一致）：
                    // 代理键经 setProxy 写入时已即时重启后端，但恢复流程只写 settings，
                    // 环境变量/会话代理不会重建，故仍需提示重启；playerHotkeys 需重建快捷键。
                    if (['playerHotkeys', 'proxyEnable', 'proxyUrl'].indexOf(key) >= 0) needRestartHint = true;
                }
                // 本循环是「程序化 settingsSet」，不产生 DOM change → 不会触发
                // settings-snapshot.js 的 document 冒泡委托失效快照。而 player.js
                // 的起播主链路（autoNext 等）已改读长驻快照，缺这一步会最长 90s
                // 读到恢复前的旧值（典型：启动 5s 静默恢复把云端「关闭连播」写回，
                // 用户随后起播仍继续自动连播）。同先例：live.js:398、detail.js:3968。
                if (typeof SettingsSnapshot !== 'undefined' && SettingsSnapshot.invalidate) {
                    try { SettingsSnapshot.invalidate(); } catch (e) { /* 失效失败不影响恢复结果 */ }
                }
                // 外观类设置即时重放（主题/缩放/字体等），其余多数在使用时读取自然生效
                if (typeof applySkin === 'function') applySkin(d.settings);
            }
            // 报告落 console（明细含键名，toast 只放计数防刷屏）；同时挂到实例上供
            // 排障/单测读取，不改变 true/false 返回契约（调用方按真值判成功）。
            // 默认拒绝的键单独用 log：那是设计内的，不该出现在 warn 里让人误以为出错。
            this._lastWebdavRestoreReport = report;
            if (report.skipped.length || report.ignored.length || report.failed.length || report.warnings.length) {
                console.warn('[webdav] 恢复明细', report);
            } else if (report.denied.length) {
                console.log('[webdav] 已按默认拒绝跳过（设计内）', report.denied);
            }
            const notes = [];
            if (schemaVersion === 1) notes.push('云端为旧版备份（无版本标识），已按 v1 兼容恢复');
            if (backedUp) notes.push('覆盖前的本机数据已自动备份');
            if (report.skipped.length) notes.push(`${report.skipped.length} 项类型不符已跳过`);
            if (report.ignored.length) notes.push(`${report.ignored.length} 项本机不识别已忽略`);
            if (report.failed.length) notes.push(`${report.failed.length} 项写入失败`);
            if (needRestartHint) notes.push('部分设置重启应用后完全生效');
            warnToast(`WebDAV 恢复完成${notes.length ? `（${notes.join('，')}）` : ''}`);
            return true;
        }
        warnToast(`WebDAV 恢复失败${rsp && rsp.msg ? `：${rsp.msg}` : '（云端无数据或地址/账号有误）'}`);
        return false;
    } catch (e) {
        warnToast(`WebDAV 恢复失败${e && e.message ? `：${e.message}` : ''}`);
        return false;
    }
};

/** WebDAV 保存配置：持久化地址/账号/密码/远程目录与开关（不联网，同步/恢复按钮做实际操作）。 */
Kazumi.webdavSaveUI = async function () {
    const url = $('#webdav_url').val().trim();
    const username = $('#webdav_username').val().trim();
    const password = $('#webdav_password').val();
    const remoteDir = $('#webdav_remote_dir').val().trim();
    // 保存前先校验：非法 scheme 存进去只会让后续同步/恢复逐一失败（且错误信息
    // 来自 requests，指向性差），在这里就给出中文原因
    const check = this._webdavUrlCheck(url);
    if (!check.ok) { warnToast(check.reason); return; }
    window.yuki.settingsSet('webDavUrl', url);
    window.yuki.settingsSet('webDavUsername', username);
    window.yuki.settingsSet('webDavPassword', password);
    window.yuki.settingsSet('webDavRemoteDir', remoteDir);
    warnToast(`WebDAV 配置已保存${check.hint ? `（${check.hint}）` : ''}`);
};

/** 手动同步/恢复后在状态行记录时间（与自动同步共用同一状态行）。 */
Kazumi._markWebdavTime = function (ok) {
    const $st = $('#webdav_auto_status');
    if (!$st.length) return;
    $st.text(ok ? `上次同步：${new Date().toTimeString().slice(0, 5)}` : '');
};

/** WebDAV 同步 UI 入口。 */
Kazumi.webdavSyncUI = async function () {
    const url = $('#webdav_url').val().trim();
    const username = $('#webdav_username').val().trim();
    const password = $('#webdav_password').val();
    const remoteDir = $('#webdav_remote_dir').val().trim();
    const check = this._webdavUrlCheck(url);
    if (!check.ok) { warnToast(check.reason); return; }
    if (check.hint) console.log(`[webdav] ${check.hint}`);
    showLoading();
    const ok = await this.webdavSync(url, username, password, remoteDir);
    hideLoading();
    if (ok === 'skip') return; // 规则未加载守卫：仅提示不判失败，不再补「同步失败」toast
    this._markWebdavTime(ok);
    warnToast(ok ? 'WebDAV 同步完成' : 'WebDAV 同步失败');
};

/** WebDAV 恢复 UI 入口。 */
Kazumi.webdavRestoreUI = async function () {
    const url = $('#webdav_url').val().trim();
    const username = $('#webdav_username').val().trim();
    const password = $('#webdav_password').val();
    const remoteDir = $('#webdav_remote_dir').val().trim();
    const check = this._webdavUrlCheck(url);
    if (!check.ok) { warnToast(check.reason); return; }
    if (check.hint) console.log(`[webdav] ${check.hint}`);
    if (!await confirmDialog('从云端恢复将覆盖本地收藏、历史与规则（覆盖前会自动备份本机数据），继续？', { okText: '恢复' })) return;
    showLoading();
    const ok = await this.webdavRestore(url, username, password, remoteDir);
    hideLoading();
    this._markWebdavTime(ok);
    if (ok) {
        // 刷新收藏/历史视图（收藏入口已并入「我的」页签，同时刷新新面板）
        if (typeof Favorites !== 'undefined' && Favorites.render) Favorites.render();
        if (typeof HistoryView !== 'undefined' && HistoryView.render) HistoryView.render();
        if (typeof My !== 'undefined' && My._inited && My._favorites && My._favorites.render) My._favorites.render();
    }
};

/** WebDAV 测试连接：探测服务器与同步目录可达性，失败显示具体原因（认证/证书/网络）。 */
Kazumi.webdavTestUI = async function () {
    const url = $('#webdav_url').val().trim();
    const username = $('#webdav_username').val().trim();
    const password = $('#webdav_password').val();
    const remoteDir = $('#webdav_remote_dir').val().trim();
    const check = this._webdavUrlCheck(url);
    if (!check.ok) { warnToast(check.reason); return; }
    showLoading();
    let rsp = null;
    try {
        rsp = await doAction('kazumiWebdavTest', {
            url, username, password, remoteDir,
            sslVerify: $('#webdav_ssl_skip').prop('checked') ? '0' : '1',
        }, '/kazumi/action');
    } catch (e) { /* 下方统一处理 */ }
    hideLoading();
    // 后端 note：地址提示（内网/明文 http/地址内嵌凭据），成功时一并展示——
    // 内网地址属正常用法，提示只需要让用户确认连的是哪类地址
    const note = (rsp && rsp.note) ? String(rsp.note) : check.hint;
    if (rsp && rsp.code === 200) warnToast(`WebDAV 连接正常，地址与账号可用${note ? `（${note}）` : ''}`);
    else warnToast(`连接失败${rsp && rsp.msg ? `：${String(rsp.msg).slice(0, 120)}` : ''}`);
};

// ---------------------------------------------------------------- WebDAV 启动时自动恢复

/**
 * 启动时从云端拉取：延迟 5 秒静默执行一次「从云端恢复」（多设备场景先取云端数据）。
 * 生效条件：主开关 + 启动拉取开关均已开启且已保存地址；读持久化设置而非 DOM。
 * 失败仅 toast 提示一次，不影响正常使用，也不重试（避免启动期网络未就绪时反复报错）。
 * P3-24：timer id 存 _webdavStartupPullTimer——本函数在每次 init 都会被调用一次，
 * 游离 timer 会在 5s 窗口内重复触发静默恢复（覆盖用户刚改完的本机数据）；
 * 重复调度前先清掉旧的，避免叠加。
 */
Kazumi._webdavStartupPullTimer = null;
Kazumi.scheduleWebdavStartupPull = async function () {
    if (this._webdavStartupPullTimer) { clearTimeout(this._webdavStartupPullTimer); this._webdavStartupPullTimer = null; }
    this._webdavStartupPullTimer = setTimeout(async () => {
        this._webdavStartupPullTimer = null;
        try {
            const s = (await window.yuki.settingsGet()) || {};
            if (!s.webDavEnable || !s.webDavStartupPull || !s.webDavUrl) return;
            const ok = await this.webdavRestore(s.webDavUrl, s.webDavUsername || '', s.webDavPassword || '');
            if (ok) {
                if (typeof Favorites !== 'undefined' && Favorites.render) Favorites.render();
                if (typeof HistoryView !== 'undefined' && HistoryView.render) HistoryView.render();
                if (typeof My !== 'undefined' && My._inited && My._favorites && My._favorites.render) My._favorites.render();
            }
        } catch (e) { /* 启动拉取异常静默跳过 */ }
    }, 5000);
};

// ---------------------------------------------------------------- WebDAV 定时自动同步

/**
 * 定时自动同步调度：setTimeout 链式轮转（避免 setInterval 漂移，间隔/开关变更即重排）。
 * 生效条件：主开关 + 自动开关均已开启且已保存地址；读持久化设置而非 DOM 输入，
 * 因此无需打开设置页即可在应用启动后按周期上传。
 */
Kazumi.scheduleWebdavAutoSync = async function () {
    if (this._webdavAutoTimer) { clearTimeout(this._webdavAutoTimer); this._webdavAutoTimer = null; }
    let s = {};
    try { s = (await window.yuki.settingsGet()) || {}; } catch (e) { return; }
    if (!s.webDavEnable || !s.webDavAutoEnable || !s.webDavUrl) {
        const $st = $('#webdav_auto_status');
        if ($st.length) $st.text('');
        return;
    }
    const minutes = parseInt(s.webDavAutoMinutes, 10) || 60;
    this._webdavAutoTimer = setTimeout(() => { this._webdavAutoTick(); }, minutes * 60 * 1000);
};

/** 自动同步单次执行：静默上传（不弹 loading），成功仅更新状态行，失败才 toast 提醒。 */
Kazumi._webdavAutoTick = async function () {
    this._webdavAutoTimer = null;
    try {
        const s = (await window.yuki.settingsGet()) || {};
        const ok = await this.webdavSync(s.webDavUrl || '', s.webDavUsername || '', s.webDavPassword || '');
        if (ok !== 'skip') {
            // 'skip' = 规则未加载守卫跳过：静默轮转下一轮，不算失败
            const time = new Date().toTimeString().slice(0, 5);
            const $st = $('#webdav_auto_status');
            if ($st.length) $st.text(ok ? `上次自动同步：${time}` : '上次自动同步失败');
            if (!ok) warnToast('WebDAV 自动同步失败，请检查地址与账号');
        }
    } catch (e) { /* 本轮异常静默跳过，链路继续下一轮 */ }
    await this.scheduleWebdavAutoSync();
};
