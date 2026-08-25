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
/* global $, doAction, escHtml, warnToast, showLoading, hideLoading, openDialog, closeDialog, confirmDialog, Player, Detail, Favorites, HistoryView, My, App, Search, recGet, recSet, renderStatusBar, bangumiCard, fitVodTitles, bangumiCover, stripHtml, apiUrl, localCacheGet, localCacheSet, _coverCache */

const Kazumi = {
    _rules: [],        // 已安装规则缓存（kazumiList 拉取）
    _rulesLoaded: false,
    _dlgToken: 0,      // 弹窗操作令牌：防过期回调（关闭后旧回调作废）
    _dlgStream: null,  // 选源弹窗 SSE 流（关闭时清理）
    _dlgState: null,   // 选源弹窗状态 {title, token, keyword, plugins, expanded}
    _inited: false,    // 事件只绑定一次；唯一入口由 app.js 在后端就绪后调用

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
            this._closeDlgStream();
            this._dlgState = null;
        });
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
            doAction('kazumiSetMirror', { bangumi: on ? '1' : '0' }, '/kazumi/action').catch(() => { });
        });
        $('#set_git_mirror').on('change', function () {
            const on = this.checked;
            window.yuki.settingsSet('enableGitProxy', on);
            doAction('kazumiSetMirror', { git: on ? '1' : '0' }, '/kazumi/action').catch(() => { });
        });
        $('#kazumi_rule_list').on('click', '.kazumi-rule-del', (e) => {
            const name = String($(e.currentTarget).data('name') || '');
            if (name) this.removeRule(name);
        });
        $('#kazumi_rule_list').on('click', '.kazumi-rule-edit', (e) => {
            const name = String($(e.currentTarget).data('name') || '');
            if (name) this.openEditorDialog(name);
        });
        $('#kazumi_rule_list').on('change', '.kazumi-rule-toggle', (e) => {
            const name = String($(e.currentTarget).data('name') || '');
            const enabled = !!e.currentTarget.checked;
            if (name) this.toggleRule(name, enabled);
        });
        // 手动排序（2.5，仿 Kazumi ReorderableListView）：上移/下移按钮 + 拖拽
        $('#kazumi_rule_list').on('click', '.kazumi-rule-move', (e) => {
            const name = String($(e.currentTarget).data('name') || '');
            const dir = parseInt($(e.currentTarget).data('dir'), 10) || 0;
            if (name && dir) this.moveRule(name, dir);
        });
        $('#kazumi_rule_list')
            .on('dragstart', '.kazumi-rule-row', (e) => {
                this._dragName = String($(e.currentTarget).data('name') || '');
                try { e.originalEvent.dataTransfer.effectAllowed = 'move'; } catch (err) { /* ignore */ }
            })
            .on('dragover', '.kazumi-rule-row', (e) => { e.preventDefault(); })
            .on('drop', '.kazumi-rule-row', (e) => {
                e.preventDefault();
                const targetName = String($(e.currentTarget).data('name') || '');
                this.dragRuleTo(this._dragName, targetName);
                this._dragName = null;
            });
        // WebDAV 同步（3.2 对齐 Kazumi：主开关 + 子开关 + 保存/测试/同步/恢复）
        $('#webdav_sync').on('click', () => this.webdavSyncUI());
        $('#webdav_restore').on('click', () => this.webdavRestoreUI());
        $('#webdav_test').on('click', () => this.webdavTestUI());
        $('#webdav_save').on('click', () => this.webdavSaveUI());
        $('#webdav_enable').on('change', function () {
            const on = this.checked;
            window.yuki.settingsSet('webDavEnable', on);
            if (!on) {
                $('#webdav_enable_history').prop('checked', false);
                $('#webdav_enable_collect').prop('checked', false);
                $('#webdav_enable_settings').prop('checked', false);
                $('#webdav_enable_stats').prop('checked', false);
                $('#webdav_enable_rules').prop('checked', false);
                $('#webdav_auto_enable').prop('checked', false);
                $('#webdav_startup_pull').prop('checked', false);
                window.yuki.settingsSet('webDavEnableHistory', false);
                window.yuki.settingsSet('webDavEnableCollect', false);
                window.yuki.settingsSet('webDavEnableSettings', false);
                window.yuki.settingsSet('webDavEnableStats', false);
                window.yuki.settingsSet('webDavEnableRules', false);
                window.yuki.settingsSet('webDavAutoEnable', false);
                window.yuki.settingsSet('webDavStartupPull', false);
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
            this.textContent = show ? '🙈' : '👁';
        });
        // 定时自动同步：开关/间隔变更即时重排调度（无需重启）
        $('#webdav_auto_enable').on('change', function () {
            window.yuki.settingsSet('webDavAutoEnable', this.checked);
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
        if (!this._rules.length) {
            box.html('<div class="tip-line">尚未导入任何 Kazumi 规则。</div>');
            return;
        }
        box.html(this._rules.map((r) => {
            const validInfo = this._validityLabel(r.validity);
            const times = [r.installed_at ? '安装 ' + r.installed_at : '',
                           r.updated_at && r.updated_at !== r.installed_at ? '更新 ' + r.updated_at : '']
                .filter(Boolean).join(' · ');
            return `
            <div class="history-item kazumi-rule-row" draggable="true" data-name="${escHtml(r.name)}">
                <button class="history-btn kazumi-rule-move" data-name="${escHtml(r.name)}" data-dir="-1" title="上移">↑</button>
                <button class="history-btn kazumi-rule-move" data-name="${escHtml(r.name)}" data-dir="1" title="下移">↓</button>
                <div class="kazumi-rule-main">
                    <span class="kazumi-rule-name" title="${escHtml(r.name)} v${escHtml(r.version || '')}">${escHtml(r.name)} <span class="kazumi-subver">v${escHtml(r.version || '')}</span></span>
                    ${times ? `<span class="kazumi-rule-times">${escHtml(times)}</span>` : ''}
                </div>
                ${validInfo ? `<span class="kazumi-validity ${validInfo.cls}" title="${escHtml(validInfo.label)}">${escHtml(validInfo.label)}</span>` : ''}
                <button class="history-btn kazumi-rule-edit" data-name="${escHtml(r.name)}" title="编辑规则">✎</button>
                <label class="md-switch">
                    <input type="checkbox" class="kazumi-rule-toggle" data-name="${escHtml(r.name)}" ${r.enabled !== false ? 'checked' : ''}>
                    <span class="md-switch-track"></span>
                </label>
                <button class="history-btn kazumi-rule-del" data-name="${escHtml(r.name)}" title="删除该规则">✕</button>
            </div>`;
        }).join(''));
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
        try {
            const rsp = await doAction('kazumiRemove', { name }, '/kazumi/action');
            if (rsp && rsp.code === 200) {
                warnToast('已删除');
                this.refreshRuleList();
            } else {
                warnToast('删除失败：' + ((rsp && rsp.msg) || '未知错误'));
            }
        } catch (e) { warnToast('删除失败'); }
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

    /** 上移/下移一条规则（改顺序并持久化，2.5）。 */
    async moveRule(name, dir) {
        const idx = this._rules.findIndex((r) => r.name === name);
        const target = idx + dir;
        if (idx < 0 || target < 0 || target >= this._rules.length) return;
        const arr = this._rules.slice();
        const [it] = arr.splice(idx, 1);
        arr.splice(target, 0, it);
        await this._applyRuleOrder(arr);
    },

    /** 拖拽落位：把拖动规则移到目标规则位置（持久化）。 */
    async dragRuleTo(dragName, targetName) {
        if (!dragName || dragName === targetName) return;
        const from = this._rules.findIndex((r) => r.name === dragName);
        const to = this._rules.findIndex((r) => r.name === targetName);
        if (from < 0 || to < 0) return;
        const arr = this._rules.slice();
        const [it] = arr.splice(from, 1);
        arr.splice(to, 0, it);
        await this._applyRuleOrder(arr);
    },

    /** 按新顺序应用并持久化：乐观更新 + 失败回滚。 */
    async _applyRuleOrder(arr) {
        const prev = this._rules.slice();
        this._rules = arr;
        this._renderRuleList();
        try {
            const rsp = await doAction('kazumiReorder', { names: JSON.stringify(arr.map((r) => r.name)) }, '/kazumi/action');
            if (!rsp || rsp.code !== 200) { warnToast('排序保存失败'); this._rules = prev; this._renderRuleList(); }
        } catch (e) { warnToast('排序保存失败'); this._rules = prev; this._renderRuleList(); }
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

    /** 回填 token 输入框（设置已保存过时展示）与同步选项。 */
    async _prefillBangumiToken() {
        const t = await this._getBangumiToken();
        if (t) $('#bangumi_token').val(t);
        try {
            const s = (await window.yuki.settingsGet()) || {};
            if (s.bangumiSyncPriority !== undefined && s.bangumiSyncPriority !== null) $('#bangumi_sync_priority').val(String(s.bangumiSyncPriority));
            $('#bangumi_immediate_toast').prop('checked', s.bangumiImmediateSyncToastEnable !== false);
            $('#set_bangumi_autosync_status').prop('checked', s.bangumiAutoSyncStatus === true);
            $('#set_bangumi_autosync_on_start').prop('checked', s.bangumiAutoSyncOnStart === true);
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
            $('#webdav_enable_history').prop('checked', s.webDavEnableHistory !== false);
            $('#webdav_enable_collect').prop('checked', s.webDavEnableCollect !== false);
            $('#webdav_enable_settings').prop('checked', s.webDavEnableSettings !== false);
            $('#webdav_enable_stats').prop('checked', s.webDavEnableStats !== false);
            $('#webdav_enable_rules').prop('checked', s.webDavEnableRules !== false);
            $('#webdav_ssl_skip').prop('checked', !!s.webDavSslSkip);
            $('#webdav_startup_pull').prop('checked', !!s.webDavStartupPull);
            $('#webdav_auto_enable').prop('checked', !!s.webDavAutoEnable);
            if (s.webDavAutoMinutes) $('#webdav_auto_interval').val(String(s.webDavAutoMinutes));
        } catch (e) { /* 读取失败不阻塞 */ }
    },

    /** 回填镜像开关，并把已保存的镜像状态应用到后端。 */
    async _prefillMirror() {
        try {
            const s = (await window.yuki.settingsGet()) || {};
            $('#set_bangumi_mirror').prop('checked', !!s.enableBangumiProxy);
            $('#set_git_mirror').prop('checked', !!s.enableGitProxy);
            if (s.enableBangumiProxy || s.enableGitProxy) {
                doAction('kazumiSetMirror', {
                    bangumi: s.enableBangumiProxy ? '1' : '0',
                    git: s.enableGitProxy ? '1' : '0',
                }, '/kazumi/action').catch(() => { });
            }
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

    /** 测试连接：GET /v0/me 显示用户名。 */
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
            if (rsp && rsp.code === 200) { warnToast('已删除收藏'); return true; }
            warnToast('删除失败：' + ((rsp && rsp.msg) || '未知错误'));
            return false;
        } catch (e) { warnToast('删除失败'); return false; }
    },

    /** 批量上传期间抑制 setBangumiCollection 的单条 toast（成功/失败均静默，由批量函数汇总提示）。 */
    _bgmBatchActive: false,

    /** 收藏标签 → Bangumi 收藏类型（1想看 2看过 3在看 4搁置 5抛弃）。
     *  注意：后端 plugin_manager.py:858 docstring 写的是 0-4，实际透传 int 且应传 1-5，注释有误。 */
    _favTagToBangumiType: { want: 1, seen: 2, watching: 3, hold: 4, dropped: 5 },

    /** 设置某 subject 的收藏类型（详情弹窗追番按钮用）。 */
    async setBangumiCollection(subjectId, type) {
        const token = await this._getBangumiToken();
        if (!token) { if (!this._bgmBatchActive) warnToast('请先在设置 → Kazumi 规则 → Bangumi 同步中保存 Token'); return false; }
        try {
            const rsp = await doAction('kazumiBangumiCollectionSet', { token, id: subjectId, type }, '/kazumi/action');
            if (rsp && rsp.code === 200) {
                // 即时同步提示开关（bangumiImmediateSyncToastEnable，默认开）；批量上传内抑制单条提示
                if (!this._bgmBatchActive) {
                    try {
                        const st = (await window.yuki.settingsGet()) || {};
                        if (st.bangumiImmediateSyncToastEnable !== false) warnToast('已同步到 Bangumi');
                    } catch (e) { warnToast('已同步到 Bangumi'); }
                }
                return true;
            }
            if (!this._bgmBatchActive) {
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
     * @param onProgress 可选 (done, total) => void，用于 UI 进度展示（契约不变）。
     * @returns {Promise<{uploaded:number, skipped:number, failed:number, total:number}|null>} 无 Token 返回 null。
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
        // 阶段 B：一次调后端生成三方合并计划（远端全量分页拉取在后端完成）
        let plan = null;
        try {
            const rsp = await doAction('kazumiBangumiSync', {
                token, favorites: JSON.stringify(localFavs), priority: 'local',
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
        const uploads = plan.upload || [];
        const planSkipped = Number(plan.skipped) || 0;
        if (!uploads.length) {
            return { uploaded: 0, skipped: resolveSkipped + planSkipped, failed: 0, total };
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
        return { uploaded, skipped: resolveSkipped + planSkipped, failed, total, error: applyError };
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
            warnToast(`已同步 Bangumi 收藏（${n} 条）${upMsg ? '；' + upMsg : ''}`, { summary: true });
        } catch (e) {
            if (typeof My !== 'undefined' && My._closeSyncProgress) My._closeSyncProgress();
            else hideLoading();
            warnToast('同步失败');
        }
    },

    /** 查询某 subject 的收藏状态（返回 {type} 或 null）。 */
    async getBangumiCollection(subjectId) {
        const token = await this._getBangumiToken();
        if (!token) return null;
        try {
            const rsp = await doAction('kazumiBangumiCollectionGet', { token, id: subjectId }, '/kazumi/action');
            return (rsp && rsp.collection) || null;
        } catch (e) { return null; }
    },

    /** 查询并回填详情页/弹窗里某 subject 的 Bangumi 收藏状态（高亮对应按钮）。 */
    async _applyBangumiColState(subjectId) {
        const col = await this.getBangumiCollection(subjectId);
        const wrap = $(`.kazumi-col-btns[data-id="${subjectId}"]`);
        if (!wrap.length) return;
        wrap.find('.kazumi-col-btn').removeClass('active');
        // type 可能为数字或字符串（不同 API/镜像响应形态）；统一 Number 归一，
        // 否则字符串 type 会走 -1 分支导致设置成功后按钮不高亮，用户误判为「失败」。
        const t = col ? Number(col.type) : NaN;
        const cur = Number.isFinite(t) ? t : -1;
        wrap.find(`.kazumi-col-btn[data-type="${cur}"]`).addClass('active');
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

    /** 批量更新：从商店拉取全部规则最新版，4 并发更新。 */
    async batchUpdate() {
        if (!await confirmDialog('将从规则商店批量检查并更新所有已安装规则，继续？', { okText: '更新' })) return;
        try {
            const rsp = await doAction('kazumiBatchUpdate', {}, '/kazumi/action');
            if (!rsp || !rsp.started) { warnToast('已有批量更新正在运行'); return; }
            warnToast('正在批量更新规则…');
            this._pollTask('kazumiUpdateStatus', (s) => {
                const results = s.results || [];
                const updated = results.filter((r) => r.updated).length;
                const upToDate = results.filter((r) => r.ok && !r.updated).length;
                const failed = results.filter((r) => !r.ok).length;
                warnToast(`更新完成：更新 ${updated} · 已最新 ${upToDate}${failed ? ` · 失败 ${failed}` : ''}`);
                this.refreshRuleList();
            }, '批量更新');
        } catch (e) {
            warnToast('批量更新启动失败');
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
                    // 让 getBangumiMatch 按 id 拉详情自愈，不再被旧缓存永久卡死
                    this._bgmMatchCache.set(kv[0], { id: Number(v.id) || 0, cover: this._migrateCover(v.cover || '') });
                }
            });
        } catch (e) { /* 损坏则忽略 */ }
    },

    /** 旧缓存封面迁移（T75）：历史存的是 large 尺寸 lain.bgm.tv URL，网格卡用会在 1080p
     *  降采样锯齿。用共享 bangumiCover(string) 走路径段替换降级到 common；非该格式原样返回。 */
    _migrateCover(url) {
        return (typeof bangumiCover === 'function') ? bangumiCover(String(url || ''), 'card') : String(url || '');
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
                            if (cv) match = { id: Number(info.id) || 0, cover: cv };
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
                        };
                    }
                }
            } catch (e) { /* 搜索失败按空匹配 */ }
            if (!(match.id && match.cover)) match = { id: 0, cover: '', negAt: Date.now() };
            this._bgmMatchCache.set(key, match);
            this._saveBgmMatchCache();
            this._bgmMatchInflight.delete(key);
            return match;
        })();
        this._bgmMatchInflight.set(key, p);
        return p;
    },

    /** 记录一次 Bangumi 匹配（点击搜索结果回填缓存，补 id 或封面后下次免搜；幂等）。
     *  cover 允许为空（首条结果无 images）：条目只在内存中，getBangumiMatch 会按
     *  id 拉详情自愈补图，且不会被 _saveBgmMatchCache 持久化成毒缓存。 */
    cacheBangumiMatch(name, id, cover) {
        const key = String(name || '').trim();
        if (!key || !id) return;
        const cur = this.getCachedBangumiMatch(key) || {};
        const m = { id: Number(id) || cur.id || 0, cover: cover || cur.cover || '' };
        this._bgmMatchCache.set(key, m);
        this._saveBgmMatchCache();
    },

    /** Bangumi 番剧详情。30 分钟 TTL 缓存（T74：详情页/弹窗/二级页重复打开免重复请求）。
     *  迁移到 localStorage 持久缓存（cache.js），重启仍即时上屏；纳入设置页「清理缓存」。 */
    _bgmInfoCacheKey(subjectId) { return 'detail::bgminfo::v1::' + String(subjectId); },
    async bangumiInfo(subjectId) {
        const key = String(subjectId);
        if (key && typeof localCacheGet === 'function') {
            try { const hit = localCacheGet(this._bgmInfoCacheKey(key)); if (hit) return hit; } catch (e) { /* ignore */ }
        }
        try {
            const rsp = await doAction('kazumiBangumiInfo', { id: subjectId }, '/kazumi/action');
            const info = (rsp && rsp.info) || null;
            if (info && key && typeof localCacheSet === 'function') {
                try { localCacheSet(this._bgmInfoCacheKey(key), info, 30 * 60 * 1000); } catch (e) { /* 缓存失败忽略 */ }
            }
            return info;
        } catch (e) {
            return null;
        }
    },

    /** Bangumi 番剧分集信息。 */
    async bangumiEpisodes(subjectId) {
        try {
            const rsp = await doAction('kazumiBangumiEpisodes', { id: subjectId }, '/kazumi/action');
            return (rsp && rsp.episodes) || null;
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

    /** Bangumi 番剧评论（吐槽）。归一化为数组：next.bgm /p1 返回 {data:[...],total} 或直接数组，
     *  统一取 data；字段 {user:{nickname}, comment, updatedAt} → 保留原样交前端渲染。 */
    async bangumiComments(subjectId, limit, offset) {
        try {
            const rsp = await doAction('kazumiBangumiComments', { id: subjectId, limit: limit || 20, offset: offset || 0 }, '/kazumi/action');
            const c = (rsp && rsp.comments);
            if (Array.isArray(c)) return c;
            if (c && Array.isArray(c.data)) return c.data;
            if (c && Array.isArray(c.list)) return c.list;
            return [];
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
     * @param title 影片名
     * @param site  来源标识（kazumi:规则名 或 CatVod site key）
     * @param src    Kazumi 搜索结果链接（kazumi: 前缀时作为默认选中，直接解析该源）
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

        // 来自搜索结果（kazumi: 前缀）→ 直接解析该源剧集
        if (String(site).startsWith('kazumi:') && src) {
            const pluginName = String(site).slice(7);
            await this._loadChapters(pluginName, src, title, token);
            return;
        }

        // 初始化源状态：每张可用规则一张卡（pending）；已判定失效的源（validity === 'invalid'）
        // 不建卡即在选源弹窗中隐藏，后端 /search/kazumi-stream 同步跳过该类源
        const plugins = {};
        this._rules.filter((r) => r.enabled !== false && r.validity !== 'invalid').forEach((r) => {
            plugins[r.name] = { status: 'pending', results: [], captchaUrl: '', msg: '', searching: false };
        });
        this._dlgState = { title, token, keyword: title, plugins, expanded: null };
        this._renderSourceSheet();

        // 并发流式搜索全部源
        this._closeDlgStream();
        const es = new EventSource(apiUrl('/search/kazumi-stream?word=' + encodeURIComponent(title)));
        this._dlgStream = es;
        es.onmessage = (ev) => {
            let payload;
            try { payload = JSON.parse(ev.data); } catch (e) { return; }
            if (token !== this._dlgToken) return;
            this._applySourceResult(payload);
        };
        const finish = () => {
            if (token !== this._dlgToken) return;
            this._closeDlgStream();
            this._updateSheetHeader();
        };
        es.addEventListener('done', finish);
        es.onerror = () => { if (token === this._dlgToken) finish(); };
    },

    /** 关闭选源弹窗的 SSE 流。 */
    _closeDlgStream() {
        if (this._dlgStream) { try { this._dlgStream.close(); } catch (e) { /* ignore */ } this._dlgStream = null; }
    },

    /** 应用一条源搜索结果到弹窗状态并刷新对应卡片。 */
    _applySourceResult(payload) {
        const st = this._dlgState;
        if (!st) return;
        const name = String(payload.name || '');
        if (!name || !st.plugins[name]) return;
        const p = st.plugins[name];
        if (payload.captcha) { p.status = 'captcha'; p.captchaUrl = payload.captchaUrl || ''; p.results = []; }
        else if (payload.error) { p.status = 'error'; p.msg = payload.msg || ''; p.results = []; }
        else if (payload.status === 'noresult' || !(payload.list || []).length) { p.status = 'noresult'; p.results = []; }
        else { p.status = 'success'; p.results = payload.list || []; }
        p.searching = false;
        if (p.status === 'success' && !st.expanded) st.expanded = name; // 自动展开首个有结果源
        this._renderSourceCard(name);
        this._updateSheetHeader();
    },

    /** 单源重查（重试/别名/手动检索/验证后重试）。 */
    async _queryPlugin(keyword, pluginName, token) {
        const st = this._dlgState;
        if (!st) return;
        const p = st.plugins[pluginName];
        if (!p) return;
        p.searching = true;
        p.status = 'pending';
        this._renderSourceCard(pluginName);
        try {
            const rsp = await doAction('kazumiSearch', { keyword, plugin: pluginName }, '/kazumi/action');
            if (token !== this._dlgToken) return;
            const r = ((rsp && rsp.results) || []).find((x) => x.pluginName === pluginName) || null;
            if (!r) { p.status = 'noresult'; p.results = []; }
            else if (r.captcha) { p.status = 'captcha'; p.captchaUrl = r.captchaUrl || ''; p.results = []; }
            else if (r.error) { p.status = 'error'; p.msg = r.msg || ''; p.results = []; }
            else { p.status = (r.data && r.data.length) ? 'success' : 'noresult'; p.results = r.data || []; }
        } catch (e) {
            if (token !== this._dlgToken) return;
            p.status = 'error'; p.msg = '查询失败'; p.results = [];
        }
        p.searching = false;
        if (p.status === 'success' && !st.expanded) st.expanded = pluginName;
        this._renderSourceCard(pluginName);
        this._updateSheetHeader();
    },

    /** 渲染整个选源弹窗（头部 + 全部源卡片）。 */
    _renderSourceSheet() {
        const st = this._dlgState;
        if (!st) return;
        const box = $('#kazumi-dialog-body');
        let html = this._sheetHeaderHtml(st);
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

    /** 弹窗头部：标题 + 进度（检索中 X/Y 或 共 N 条）。 */
    _sheetHeaderHtml(st) {
        const names = Object.keys(st.plugins);
        const done = names.filter((n) => st.plugins[n].status !== 'pending').length;
        const found = names.reduce((s, n) => s + (st.plugins[n].results || []).length, 0);
        const busy = done < names.length;
        return `<div class="kazumi-sheet-head">
            <div class="kazumi-sheet-title">「${escHtml(st.keyword)}」</div>
            <div class="kazumi-sheet-progress">${busy ? `检索中 ${done}/${names.length}` : `共 ${found} 条结果`}</div>
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
                ${this._statusBadge(p)}
                <span class="kazumi-src-chev">${open ? '▾' : '▸'}</span>
            </div>`;
        let body = '';
        if (open) {
            if (p.searching || p.status === 'pending') {
                body = '<div class="kazumi-src-body"><div class="tip-line">检索中…</div></div>';
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
    },

    /** 点结果行：显示「获取中」，解析剧集线路 → 选集视图；失败回选源。 */
    async _openSearchItem(pluginName, src, name, token) {
        $('#kazumi-dialog-body').html('<div class="tip-line">正在解析剧集线路…</div>');
        try {
            const rsp = await doAction('kazumiChapters', { pluginName, src }, '/kazumi/action');
            if (token !== this._dlgToken) return;
            const roads = (rsp && rsp.roads) || [];
            if (!roads.length) { this._backToSources(); warnToast('未解析到剧集线路'); return; }
            this._renderChapterRoads(pluginName, roads, name, token, src);
        } catch (e) {
            if (token !== this._dlgToken) return;
            this._backToSources();
            warnToast('剧集解析失败');
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
            const url = (st.plugins[pluginName] || {}).captchaUrl || '';
            if (url) this._openCaptchaWindow(url, () => this._queryPlugin(keyword, pluginName, token));
            else warnToast('该源暂无验证链接');
        } else if (action === 'manual') {
            this._showKeywordDialog(pluginName, token, '手动检索');
        } else if (action === 'browser') {
            this._openPluginSearchPage(pluginName, keyword);
        }
    },

    /** 手动检索：弹关键词输入框，重查该源。 */
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
        const close = () => dlg.remove();
        const submit = () => {
            const v = String(dlg.find('#kazumi-kw-input').val() || '').trim();
            if (!v) { warnToast('请输入关键词'); return; }
            close();
            this._queryPlugin(v, pluginName, token);
        };
        dlg.on('click', (e) => { if (e.target === dlg[0]) close(); });
        dlg.find('#kazumi-kw-cancel').on('click', close);
        dlg.find('#kazumi-kw-ok').on('click', submit);
        dlg.find('#kazumi-kw-input').on('keydown', (e) => { if (e.key === 'Enter') submit(); }).trigger('focus').select();
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

    /** Bangumi 元数据补全：搜索首个结果取详情，插入弹窗顶部。 */
    async _enrichBangumiMetadata(title, box, token) {
        try {
            const results = await this.bangumiSearch(title);
            if (token !== this._dlgToken || !results.length) return;
            const info = await this.bangumiInfo(results[0].id);
            if (token !== this._dlgToken || !info) return;
            const cover = bangumiCover(info.images, 'card');   // 弹窗横幅封面 80px（T75）
            const summary = (info.summary || '').slice(0, 200);
            const score = info.rating && info.rating.score ? `评分 ${info.rating.score}` : '';
            const meta = [info.date, score, info.platform].filter(Boolean).join(' · ');
            const banner = `<div class="kazumi-bangumi-banner" data-bangumi-id="${escHtml(String(info.id))}" data-bangumi-name="${escHtml(info.name_cn || info.name || title)}">
                ${cover ? `<img class="kazumi-bangumi-cover" src="${escHtml(cover)}" referrerpolicy="no-referrer" data-fb-src="${escHtml(bangumiMirrorUrl(cover))}">` : ''}
                <div class="kazumi-bangumi-info">
                    <div class="kazumi-bangumi-title">${escHtml(info.name_cn || info.name || title)}</div>
                    <div class="kazumi-bangumi-meta">${escHtml(meta)}</div>
                    ${summary ? `<div class="kazumi-bangumi-summary">${escHtml(summary)}…</div>` : ''}
                    <div class="kazumi-bangumi-actions">
                        <button class="md-btn md-btn-tonal md-btn-sm kazumi-bangumi-detail" data-id="${info.id}">查看详情</button>
                    </div>
                </div>
            </div>`;
            box.prepend(banner);
            // 绑定详情按钮：打开 Bangumi 完整详情弹窗
            box.find('.kazumi-bangumi-detail').on('click', (e) => {
                const id = parseInt($(e.currentTarget).data('id'), 10);
                if (id) this.openBangumiDetail(id);
            });
        } catch (e) { /* 元数据失败不影响源选择 */ }
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
            if (token !== this._dlgToken || !info) {
                $('#kazumi-dialog-body').html('<div class="tip-line">详情载入失败</div>');
                return;
            }
            await this._renderBangumiDetail(info, token);
        } catch (e) {
            if (token !== this._dlgToken) return;
            $('#kazumi-dialog-body').html('<div class="tip-line">详情载入失败</div>');
        }
    },

    /** 打开 Bangumi 番剧详情（T74 统一详情页）：复用 #view-detail，Bangumi-only 自适应渲染。 */
    async openBangumiInfoPage(subjectId) {
        const curView = (typeof App !== 'undefined' && App.currentView) ? App.currentView : 'home';
        if (curView && curView !== 'detail') this._infoReferrer = curView;
        if (typeof Detail !== 'undefined' && Detail.openBangumi) {
            await Detail.openBangumi(subjectId, '');
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
            <div class="kazumi-col-btns" data-id="${info.id}">
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
            if (!id) return;
            if (val < 0) {
                if (await this.removeBangumiCollection(id, nm)) this._applyBangumiColState(id);
            } else if (await this.setBangumiCollection(id, val)) {
                this._applyBangumiColState(id);
            }
        });
        // 标签点击：按 Bangumi 标签精确筛选番剧（非关键词搜索，任务四 4.2）
        box.on('click.kbd', '.kazumi-tag', (e) => {
            if (token !== this._dlgToken) return;
            const tag = String($(e.currentTarget).data('tag') || '');
            if (!tag) return;
            if (this.openBangumiTagResult) this.openBangumiTagResult(tag);
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

    /** 渲染简介区标签（info.tags: [{name,count}]），点击跳搜索。 */
    _renderInfoTags(tags) {
        if (!Array.isArray(tags) || !tags.length) return '';
        const chips = tags.slice(0, 13).map((t) => {
            const tn = (t && typeof t === 'object') ? (t.name || '') : t;
            return tn ? `<span class="kazumi-tag" data-tag="${escHtml(tn)}">${escHtml(tn)}</span>` : '';
        }).filter(Boolean).join('');
        if (!chips) return '';
        return `<div class="bangumi-info-tags"><span class="tip-line pad0">标签</span><div class="kazumi-tags-wrap">${chips}</div></div>`;
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
                      + list.map((c) => `<div class="kazumi-detail-char" data-char-id="${escHtml(c.id)}" tabindex="0">
                        <img class="kazumi-detail-avatar" src="${escHtml((c.images && c.images.medium) || '')}" referrerpolicy="no-referrer" onerror="this.style.display='none'">
                        <div class="kazumi-detail-char-info">
                            <div class="kazumi-detail-char-name">${escHtml(c.name_cn || c.name || '')}</div>
                            <div class="kazumi-detail-char-role">${escHtml(c.role_name || '')}</div>
                        </div>
                        <span class="kazumi-detail-char-more">详情 ›</span>
                    </div>`).join('')
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
                const list = await this.bangumiComments(subjectId, 20, 0);
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
 * - cacheDir/dlDir/wallpaper：本机绝对路径，跨设备无意义；
 * - settingsCat：纯本机界面记忆。
 */
const WEBDAV_SETTINGS_EXCLUDE = new Set([
    'favorites', 'history', 'watchStats',
    'webDavUrl', 'webDavUsername', 'webDavPassword',
    'cacheDir', 'dlDir', 'wallpaper', 'settingsCat',
    'webDavRestoreBackup', // 恢复前的本机备份快照，体积大且仅本机有意义
]);

/** 构建「设置同步」快照：全量设置剔除排除项后的浅拷贝。 */
Kazumi._webdavSettingsSnapshot = function (s) {
    const snap = {};
    for (const k of Object.keys(s || {})) {
        if (!WEBDAV_SETTINGS_EXCLUDE.has(k)) snap[k] = s[k];
    }
    return snap;
};

/** WebDAV 同步：上传收藏/历史/规则/设置/观看统计到远程；按子开关决定包含哪些数据。
 *  webDavSslSkip 开启时通知后端跳过证书校验（自签名服务器）；
 *  remoteDirOverride 未传时用已保存的 webDavRemoteDir（自动同步走此路径）。 */
Kazumi.webdavSync = async function (url, username, password, remoteDirOverride) {
    try {
        const s = (await window.yuki.settingsGet()) || {};
        const data = {};
        if (s.webDavEnableRules !== false) data.kazumiRules = this._rules || [];
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
        // 空数据/失败都必须走失败提示：后端失败返回 {code:500,msg}，此前空对象 {} 是
        // truthy 被当成功——网址输错时提示「恢复完成」实际什么都没恢复
        const gotAny = d && (d.favorites || d.history || d.kazumiRules || d.settings || d.watchStats);
        if (rsp && rsp.code === 200 && gotAny) {
            // 覆盖前备份：恢复直接覆盖本机数据且不可撤销，先把将被覆盖且有差异的
            // 本地原值存到 webDavRestoreBackup（仅本机、不参与同步快照），供误恢复后找回
            const backup = { ts: Date.now() };
            ['favorites', 'history', 'watchStats'].forEach((k) => {
                if (d[k] && JSON.stringify(s[k] ?? null) !== JSON.stringify(d[k])) backup[k] = s[k] ?? null;
            });
            if (d.kazumiRules && (this._rules || []).length) backup.kazumiRules = this._rules;
            const backedUp = Object.keys(backup).length > 1;
            if (backedUp) await window.yuki.settingsSet('webDavRestoreBackup', backup);
            if (d.favorites) await window.yuki.settingsSet('favorites', d.favorites);
            if (d.history) await window.yuki.settingsSet('history', d.history);
            if (d.watchStats) await window.yuki.settingsSet('watchStats', d.watchStats);
            if (d.kazumiRules) {
                // 规则逐个导入
                for (const rule of d.kazumiRules) {
                    await doAction('kazumiAdd', { json: JSON.stringify(rule) }, '/kazumi/action');
                }
                await this.refreshRuleList();
            }
            let needRestartHint = false;
            if (d.settings) {
                // 设置快照逐键写回（云端文件本身已剔除排除项，这里再兜底过滤一次）
                for (const [key, val] of Object.entries(d.settings)) {
                    if (WEBDAV_SETTINGS_EXCLUDE.has(key)) continue;
                    await window.yuki.settingsSet(key, val);
                    if (['playerHotkeys', 'proxyEnable', 'proxyUrl', 'panFastPath'].indexOf(key) >= 0) needRestartHint = true;
                }
                // 外观类设置即时重放（主题/缩放/字体等），其余多数在使用时读取自然生效
                if (typeof applySkin === 'function') applySkin(d.settings);
            }
            warnToast(`WebDAV 恢复完成${backedUp ? '（覆盖前的本机数据已自动备份）' : ''}${needRestartHint ? '，部分设置重启应用后完全生效' : ''}`);
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
    if (!url) { warnToast('请输入 WebDAV 地址'); return; }
    window.yuki.settingsSet('webDavUrl', url);
    window.yuki.settingsSet('webDavUsername', username);
    window.yuki.settingsSet('webDavPassword', password);
    window.yuki.settingsSet('webDavRemoteDir', remoteDir);
    warnToast('WebDAV 配置已保存');
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
    if (!url) { warnToast('请输入 WebDAV 地址'); return; }
    showLoading();
    const ok = await this.webdavSync(url, username, password, remoteDir);
    hideLoading();
    this._markWebdavTime(ok);
    warnToast(ok ? 'WebDAV 同步完成' : 'WebDAV 同步失败');
};

/** WebDAV 恢复 UI 入口。 */
Kazumi.webdavRestoreUI = async function () {
    const url = $('#webdav_url').val().trim();
    const username = $('#webdav_username').val().trim();
    const password = $('#webdav_password').val();
    const remoteDir = $('#webdav_remote_dir').val().trim();
    if (!url) { warnToast('请输入 WebDAV 地址'); return; }
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
    if (!url) { warnToast('请输入 WebDAV 地址'); return; }
    showLoading();
    let rsp = null;
    try {
        rsp = await doAction('kazumiWebdavTest', {
            url, username, password, remoteDir,
            sslVerify: $('#webdav_ssl_skip').prop('checked') ? '0' : '1',
        }, '/kazumi/action');
    } catch (e) { /* 下方统一处理 */ }
    hideLoading();
    if (rsp && rsp.code === 200) warnToast('WebDAV 连接正常，地址与账号可用');
    else warnToast(`连接失败${rsp && rsp.msg ? `：${String(rsp.msg).slice(0, 80)}` : ''}`);
};

// ---------------------------------------------------------------- WebDAV 启动时自动恢复

/**
 * 启动时从云端拉取：延迟 5 秒静默执行一次「从云端恢复」（多设备场景先取云端数据）。
 * 生效条件：主开关 + 启动拉取开关均已开启且已保存地址；读持久化设置而非 DOM。
 * 失败仅 toast 提示一次，不影响正常使用，也不重试（避免启动期网络未就绪时反复报错）。
 */
Kazumi.scheduleWebdavStartupPull = async function () {
    setTimeout(async () => {
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
        const time = new Date().toTimeString().slice(0, 5);
        const $st = $('#webdav_auto_status');
        if ($st.length) $st.text(ok ? `上次自动同步：${time}` : '上次自动同步失败');
        if (!ok) warnToast('WebDAV 自动同步失败，请检查地址与账号');
    } catch (e) { /* 本轮异常静默跳过，链路继续下一轮 */ }
    await this.scheduleWebdavAutoSync();
};
