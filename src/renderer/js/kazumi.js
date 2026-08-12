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
/* global $, doAction, escHtml, warnToast, showLoading, hideLoading, openDialog, closeDialog, confirmDialog, Player, Detail, Favorites, HistoryView, My, App, Search, recGet, recSet, renderStatusBar */

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
        $('#kazumi_bgm_cover_clear').on('click', () => this.clearBangumiCoverCache());
        $('#kazumi_rule_add').on('click', () => this.importRule());
        $('#kazumi_rule_paste').on('click', () => this.importFromClipboard());
        $('#kazumi_rule_clear').on('click', () => $('#kazumi_rule_json').val(''));
        $('#kazumi_rule_shop').on('click', () => this.openShopDialog());
        $('#kazumi_rule_editor').on('click', () => this.openEditorDialog());
        $('#kazumi_rule_check').on('click', () => this.checkValidity());
        $('#kazumi_rule_update').on('click', () => this.batchUpdate());
        $('#kazumi_cookie_view').on('click', () => this.viewCookies());
        $('#kazumi_cookie_clear').on('click', () => this.clearCookies());
        // Bangumi 同步（需 token）
        $('#bangumi_token_save').on('click', () => this.saveBangumiToken());
        $('#bangumi_test').on('click', () => this.testBangumi());
        $('#bangumi_sync_now').on('click', () => this.syncBangumiNow());
        $('#bangumi_sync_priority').on('change', function () { window.vpc.settingsSet('bangumiSyncPriority', this.value); });
        $('#bangumi_immediate_toast').on('change', function () { window.vpc.settingsSet('bangumiImmediateSyncToastEnable', this.checked); });
        // 选源弹窗关闭时清理 SSE 流与状态（T74：避免关闭后连接挂到 done）
        $('#kazumiSourceDialog').on('click', '.md-dialog-btn', () => {
            this._closeDlgStream();
            this._dlgState = null;
        });
        // T71：详情页图片点击放大（复用 detail.js cover-float 全屏浮层，滚轮缩放）
        $('#detail-body').on('click', 'img', (e) => {
            const src = $(e.currentTarget).attr('src');
            if (src && typeof Detail !== 'undefined' && Detail._openCoverFloat) Detail._openCoverFloat(src);
        });
        this._prefillBangumiToken();
        this._prefillWebdav();
        this._prefillMirror();
        // 镜像开关（4.1）：变更即应用并持久化
        $('#set_bangumi_mirror').on('change', function () {
            const on = this.checked;
            window.vpc.settingsSet('enableBangumiProxy', on);
            doAction('kazumiSetMirror', { bangumi: on ? '1' : '0' }, '/kazumi/action').catch(() => { });
        });
        $('#set_git_mirror').on('change', function () {
            const on = this.checked;
            window.vpc.settingsSet('enableGitProxy', on);
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
        // WebDAV 同步（3.2 对齐 Kazumi：主开关 + 子开关 + 保存/同步/恢复）
        $('#webdav_sync').on('click', () => this.webdavSyncUI());
        $('#webdav_restore').on('click', () => this.webdavRestoreUI());
        $('#webdav_save').on('click', () => this.webdavSaveUI());
        $('#webdav_enable').on('change', function () {
            const on = this.checked;
            window.vpc.settingsSet('webDavEnable', on);
            if (!on) {
                $('#webdav_enable_history').prop('checked', false);
                $('#webdav_enable_collect').prop('checked', false);
                window.vpc.settingsSet('webDavEnableHistory', false);
                window.vpc.settingsSet('webDavEnableCollect', false);
            }
        });
        $('#webdav_enable_history').on('change', function () { window.vpc.settingsSet('webDavEnableHistory', this.checked); });
        $('#webdav_enable_collect').on('change', function () { window.vpc.settingsSet('webDavEnableCollect', this.checked); });
        this.refreshRuleList();
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
            // 编辑现有规则
            const rsp = await doAction('kazumiList', {}, '/kazumi/action');
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

    /** 读取设置里的 Bangumi token。 */
    async _getBangumiToken() {
        try { const s = (await window.vpc.settingsGet()) || {}; return s.bangumiToken || ''; } catch (e) { return ''; }
    },

    /** 回填 token 输入框（设置已保存过时展示）与同步选项。 */
    async _prefillBangumiToken() {
        const t = await this._getBangumiToken();
        if (t) $('#bangumi_token').val(t);
        try {
            const s = (await window.vpc.settingsGet()) || {};
            if (s.bangumiSyncPriority !== undefined && s.bangumiSyncPriority !== null) $('#bangumi_sync_priority').val(String(s.bangumiSyncPriority));
            $('#bangumi_immediate_toast').prop('checked', s.bangumiImmediateSyncToastEnable !== false);
        } catch (e) { /* 读取失败不阻塞 */ }
    },

    /** 回填 WebDAV 配置（地址/账号/密码 + 主/子开关）到设置页。 */
    async _prefillWebdav() {
        try {
            const s = (await window.vpc.settingsGet()) || {};
            if (s.webDavUrl) $('#webdav_url').val(s.webDavUrl);
            if (s.webDavUsername) $('#webdav_username').val(s.webDavUsername);
            if (s.webDavPassword) $('#webdav_password').val(s.webDavPassword);
            $('#webdav_enable').prop('checked', !!s.webDavEnable);
            $('#webdav_enable_history').prop('checked', s.webDavEnableHistory !== false);
            $('#webdav_enable_collect').prop('checked', s.webDavEnableCollect !== false);
        } catch (e) { /* 读取失败不阻塞 */ }
    },

    /** 回填镜像开关，并把已保存的镜像状态应用到后端。 */
    async _prefillMirror() {
        try {
            const s = (await window.vpc.settingsGet()) || {};
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

    /** 保存 token 到 settings（仅本机）。 */
    async saveBangumiToken() {
        const token = $('#bangumi_token').val().trim();
        if (!token) { warnToast('请输入 Bangumi Access Token'); return; }
        await window.vpc.settingsSet('bangumiToken', token);
        warnToast('Token 已保存');
        this.testBangumi();
    },

    /** 测试连接：GET /v0/me 显示用户名。 */
    async testBangumi() {
        const token = $('#bangumi_token').val().trim() || await this._getBangumiToken();
        if (!token) { warnToast('请先保存 Bangumi Token'); return; }
        try {
            const rsp = await doAction('kazumiBangumiMe', { token }, '/kazumi/action');
            const me = (rsp && rsp.me) || null;
            const status = $('#bangumi_status');
            if (me && me.username) {
                status.text(`连接成功：${me.nickname || me.username}（ID ${me.id}）`).show();
            } else {
                status.text('连接失败：Token 无效或网络不可达').show();
            }
        } catch (e) { warnToast('测试连接失败'); }
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
                        const st = (await window.vpc.settingsGet()) || {};
                        if (st.bangumiImmediateSyncToastEnable !== false) warnToast('已同步到 Bangumi');
                    } catch (e) { warnToast('已同步到 Bangumi'); }
                }
                return true;
            }
            if (!this._bgmBatchActive) warnToast('同步失败：' + ((rsp && rsp.msg) || '未知错误'));
            return false;
        } catch (e) { if (!this._bgmBatchActive) warnToast('同步失败'); return false; }
    },

    /**
     * 批量把聚合源/本地收藏单向上传到 Bangumi 账号（仅新增/更新，绝不删除）。
     *
     * 取 favorites 中 site !== 'bangumi' 的项，逐条串行上传：
     *   1. subject id 优先取已回写的 bangumiId，否则按片名取首个 Bangumi 匹配（getBangumiMatch）；
     *   2. tag 经 _favTagToBangumiType 映射为 Bangumi 收藏类型（1-5），无 tag 视同「想看」；
     *   3. 调 setBangumiCollection 幂等 set（不读远端集合——远端硬上限 100 无分页，>100 会截断，
     *      按本地 tag 直接 set 更稳；也天然避免误判「已存在」）；
     *   4. 解析到的 id 回写该收藏项 bangumiId，重复同步不再重算匹配。
     *
     * 串行原因：后端每条 update 都会重置用户名缓存并最多尝试 8 种组合（plugin_manager.py:863-884），
     * 无法在渲染端缓存用户名，故只能串行并接受延迟；大批量收藏会较慢，属预期。
     * 单条失败（匹配不到 / set 失败 / 抛错）不中断整批。
     *
     * @param onProgress 可选 (done, total) => void，用于 UI 进度展示。
     * @returns {Promise<{uploaded:number, skipped:number, failed:number, total:number}|null>} 无 Token 返回 null。
     */
    async uploadFavoritesToBangumi(onProgress) {
        const token = await this._getBangumiToken();
        if (!token) { warnToast('请先在 设置 → Kazumi 规则 → Bangumi 同步 保存 Token'); return null; }
        let favorites = [];
        try { favorites = await recGet('favorites'); } catch (e) { favorites = []; }
        const targets = (favorites || []).filter((f) => f && f.site !== 'bangumi' && f.name);
        const total = targets.length;
        let uploaded = 0, skipped = 0, failed = 0;
        const idWriteback = new Map(); // uid → bangumiId：结束后统一回写，避免逐条读写整表
        this._bgmBatchActive = true;
        try {
            for (let i = 0; i < targets.length; i++) {
                const f = targets[i];
                try {
                    const type = this._favTagToBangumiType[f.tag || 'want'] || 1;
                    let subjectId = Number(f.bangumiId) || 0;
                    if (!subjectId) {
                        const m = await this.getBangumiMatch(f.name);
                        subjectId = (m && Number(m.id)) || 0;
                    }
                    if (!subjectId) {
                        skipped++; // 匹配不到 Bangumi subject，跳过
                    } else if (await this.setBangumiCollection(subjectId, type)) {
                        uploaded++;
                        if (f.uid && String(f.bangumiId || '') !== String(subjectId)) idWriteback.set(f.uid, String(subjectId));
                    } else {
                        failed++;
                    }
                } catch (e) {
                    failed++; // 单条异常不中断整批
                }
                if (typeof onProgress === 'function') { try { onProgress(i + 1, total); } catch (e) { /* 进度回调错误忽略 */ } }
            }
        } finally {
            this._bgmBatchActive = false;
        }
        // 统一回写 bangumiId：重读最新收藏按 uid 匹配，避免覆盖同步期间的其他改动
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
            } catch (e) { /* 回写失败不影响上传结果 */ }
        }
        return { uploaded, skipped, failed, total };
    },

    /** 立即同步：拉取 Bangumi 收藏并刷新「我的收藏」合并网格（复用 My 的缓存刷新）。 */
    async syncBangumiNow() {
        const token = await this._getBangumiToken();
        if (!token) { warnToast('请先保存 Bangumi Token'); return; }
        showLoading();
        try {
            const rsp = await doAction('kazumiBangumiCollections', { token, limit: 100 }, '/kazumi/action');
            const n = ((rsp && rsp.items) || []).length;
            hideLoading();
            if (typeof My !== 'undefined' && My) {
                My._bgmCache = null;
                if (My._favorites) await My._favorites.render();
            }
            warnToast(`已同步 Bangumi 收藏（${n} 条）`);
        } catch (e) {
            hideLoading();
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
                warnToast(`检测完成：有效 ${valid} · 失效 ${invalid}${captcha ? ` · 需验证 ${captcha}` : ''}`);
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
                    // 旧版仅封面格式 [name, url] 迁移：无 id，点击时仍会补搜一次并回填
                    if (v) this._bgmMatchCache.set(kv[0], { id: 0, cover: v });
                } else if (v && (v.id || v.cover)) {
                    this._bgmMatchCache.set(kv[0], { id: Number(v.id) || 0, cover: v.cover || '' });
                }
            });
        } catch (e) { /* 损坏则忽略 */ }
    },

    /** 持久化匹配缓存（无 id 且无封面的空结果不落盘：下次会话可重试；只留最近 500 条防无限增长）。 */
    _saveBgmMatchCache() {
        try {
            const entries = [];
            for (const [k, v] of this._bgmMatchCache) {
                if (v && (v.id || v.cover)) entries.push([k, v]);
            }
            localStorage.setItem('kazumi_bgm_cover', JSON.stringify(entries.slice(-500)));
        } catch (e) { /* quota 溢出忽略 */ }
    },

    /** 清空 Bangumi 匹配缓存（内存 + localStorage；设置页按钮，封面匹配错误时手动重置）。 */
    clearBangumiCoverCache() {
        this._bgmMatchCache = new Map();
        this._bgmMatchInflight.clear();
        try { localStorage.removeItem('kazumi_bgm_cover'); } catch (e) { /* ignore */ }
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
     * 命中缓存直接返回；同片名在途搜索只发一次请求；无匹配缓存空对象，
     * 会话内重绘/切源/点击不再反复打 API。
     */
    async getBangumiMatch(name) {
        const key = String(name || '').trim();
        if (!key) return null;
        if (this._bgmMatchCache.has(key)) return this._bgmMatchCache.get(key);
        if (this._bgmMatchInflight.has(key)) return this._bgmMatchInflight.get(key);
        const p = (async () => {
            let match = { id: 0, cover: '' };
            try {
                const results = await this.bangumiSearch(key, 5);
                const first = (results || []).find((r) => r && r.images
                    && (r.images.large || r.images.common || r.images.medium));
                if (first) {
                    match = {
                        id: Number(first.id) || 0,
                        cover: first.images.large || first.images.common || first.images.medium || '',
                    };
                }
            } catch (e) { /* 搜索失败按空匹配 */ }
            this._bgmMatchCache.set(key, match);
            this._saveBgmMatchCache();
            this._bgmMatchInflight.delete(key);
            return match;
        })();
        this._bgmMatchInflight.set(key, p);
        return p;
    },

    /** 记录一次 Bangumi 匹配（点击搜索结果回填缓存，补 id 或封面后下次免搜；幂等）。 */
    cacheBangumiMatch(name, id, cover) {
        const key = String(name || '').trim();
        if (!key || !id) return;
        const cur = this.getCachedBangumiMatch(key) || {};
        const m = { id: Number(id) || cur.id || 0, cover: cover || cur.cover || '' };
        this._bgmMatchCache.set(key, m);
        this._saveBgmMatchCache();
    },

    /** Bangumi 番剧详情。30 分钟 TTL 缓存（T74：详情页/弹窗/二级页重复打开免重复请求）。 */
    _bgmInfoCache: new Map(),
    async bangumiInfo(subjectId) {
        const key = String(subjectId);
        if (key) {
            const hit = this._bgmInfoCache.get(key);
            if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return hit.info;
        }
        try {
            const rsp = await doAction('kazumiBangumiInfo', { id: subjectId }, '/kazumi/action');
            const info = (rsp && rsp.info) || null;
            if (info && key) {
                this._bgmInfoCache.set(key, { ts: Date.now(), info });
                if (this._bgmInfoCache.size > 100) { // 防无限增长，淘汰最旧
                    const oldest = this._bgmInfoCache.keys().next().value;
                    this._bgmInfoCache.delete(oldest);
                }
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

    /** Bangumi 单个角色详情。 */
    async bangumiCharacter(characterId) {
        try {
            const rsp = await doAction('kazumiBangumiCharacter', { id: characterId }, '/kazumi/action');
            return (rsp && rsp.info) || null;
        } catch (e) {
            return null;
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

    /** Bangumi 番剧评论。 */
    async bangumiComments(subjectId, limit, offset) {
        try {
            const rsp = await doAction('kazumiBangumiComments', { id: subjectId, limit: limit || 20, offset: offset || 0 }, '/kazumi/action');
            return (rsp && rsp.comments) || [];
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
    async openSourceDialog(title, site, src) {
        if (!this.hasEnabledRules()) { warnToast('尚未启用任何 Kazumi 规则'); return; }
        const token = ++this._dlgToken;
        $('#kazumi-dialog-title').text('选择播放源');
        openDialog('kazumiSourceDialog');

        // 来自搜索结果（kazumi: 前缀）→ 直接解析该源剧集
        if (String(site).startsWith('kazumi:') && src) {
            const pluginName = String(site).slice(7);
            await this._loadChapters(pluginName, src, title, token);
            return;
        }

        // 初始化源状态：每启用规则一张卡（pending）
        const plugins = {};
        this._rules.filter((r) => r.enabled !== false).forEach((r) => {
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
            await window.vpc.captchaVerify(url);
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
            const cover = (info.images && (info.images.large || info.images.common || info.images.medium)) || '';
            const summary = (info.summary || '').slice(0, 200);
            const score = info.rating && info.rating.score ? `评分 ${info.rating.score}` : '';
            const meta = [info.date, score, info.platform].filter(Boolean).join(' · ');
            const banner = `<div class="kazumi-bangumi-banner" data-bangumi-id="${info.id}" data-bangumi-name="${escHtml(info.name_cn || info.name || title)}">
                ${cover ? `<img class="kazumi-bangumi-cover" src="${escHtml(cover)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
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

    /** 渲染 Bangumi 完整详情到弹窗容器 #kazumi-dialog-body（选源弹窗内「查看详情」预览用；正式入口为统一详情页）。 */
    async _renderBangumiDetail(info, token, $box) {
        const box = $box || $('#kazumi-dialog-body');
        const name = info.name_cn || info.name || '';
        const cover = (info.images && (info.images.large || info.images.common || info.images.medium)) || '';
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
                ${cover ? `<div class="bangumi-info-cover"><img src="${escHtml(cover)}" referrerpolicy="no-referrer" onerror="this.style.display='none'"></div>` : ''}
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
        // 开始观看：打开 Kazumi 源弹窗
        box.on('click', '.kazumi-start-watch', (e) => {
            if (token !== this._dlgToken) return;
            const title = this._curBangumiName || '';
            if (title && typeof this.openSourceDialog === 'function') this.openSourceDialog(title, 'kazumi', '');
        });
        // 收藏状态按钮：点击即同步；「未收藏」删除收藏
        box.on('click', '.kazumi-col-btn', async (e) => {
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
        // 标签点击：跳搜索页按标签搜索
        box.on('click', '.kazumi-tag', (e) => {
            if (token !== this._dlgToken) return;
            const tag = String($(e.currentTarget).data('tag') || '');
            if (!tag) return;
            if (typeof App !== 'undefined' && App.showView) App.showView('search');
            $('#search-keyword').val(tag);
            if (typeof Search !== 'undefined' && Search.run) Search.run();
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
                box.html(list.length
                    ? '<div class="tip-line pad0" style="margin-bottom:8px;">点击集数 → 从 Kazumi 规则源选源播放</div>'
                      + list.map((ep) => `<div class="kazumi-detail-ep" tabindex="0">
                        <span class="kazumi-detail-ep-no">${ep.sort || ep.ep || ''}</span>
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
                            <div class="kazumi-detail-char-name">${escHtml(c.name || '')}</div>
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
                box.html(list.length
                    ? list.map((s) => `<div class="kazumi-detail-staff">
                        <span class="kazumi-detail-staff-name">${escHtml(s.name || '')}</span>
                        <span class="kazumi-detail-staff-job">${escHtml((s.jobs || []).join(' / '))}</span>
                    </div>`).join('')
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
            const img = (info.images && (info.images.large || info.images.medium || info.images.small)) || '';
            const metaBits = [
                info.blood_type ? '血型 ' + info.blood_type : '',
                info.birth_month ? `${info.birth_month}月${info.birth_day || ''}日` : '',
                info.gender ? '性别 ' + info.gender : '',
                info.height ? '身高 ' + info.height + 'cm' : '',
                info.weight ? '体重 ' + info.weight + 'kg' : '',
            ].filter(Boolean).join(' · ');
            box.html(`<div class="kazumi-char-detail">
                <button class="md-btn md-btn-sm md-btn-tonal kazumi-char-back">← 返回角色列表</button>
                ${img ? `<img class="kazumi-char-img" src="${escHtml(img)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
                <div class="kazumi-char-name">${escHtml(info.name || '')}</div>
                <div class="kazumi-char-meta">${escHtml(metaBits)}</div>
                ${info.summary ? `<div class="kazumi-char-summary">${escHtml(typeof stripHtml === 'function' ? stripHtml(info.summary) : info.summary)}</div>` : ''}
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
        const box = $('#kazumi-dialog-body');
        let html = `<div class="kazumi-road-toolbar">
            <button class="md-btn md-btn-tonal md-btn-sm kazumi-road-back">← 返回选源</button>
            <span class="kazumi-plugin-head">${escHtml(pluginName)} · ${escHtml(title)}</span>
        </div>`;
        roads.forEach((road, ri) => {
            const eps = (road.data || []).map((url, ei) => {
                const name = (road.identifier || [])[ei] || `第${ei + 1}集`;
                return `<button class="ep-btn kazumi-ep-btn" data-plugin="${escHtml(pluginName)}" data-url="${escHtml(url)}" data-name="${escHtml(name)}" data-flag="${escHtml(road.name)}">
                    <span class="ep-name">${escHtml(name)}</span>
                </button>`;
            }).join('');
            html += `<div class="kazumi-road-group">
                <div class="kazumi-road-name">${escHtml(road.name)}（${(road.data || []).length} 集）</div>
                <div class="ep-grid">${eps}</div>
            </div>`;
        });
        box.html(html);
        // 返回选源列表（保留已搜到的状态）
        box.find('.kazumi-road-back').on('click', () => {
            if (token !== this._dlgToken) return;
            this._backToSources();
        });
        // 绑定点击：播放剧集
        box.find('.kazumi-ep-btn').on('click', (e) => {
            if (token !== this._dlgToken) return;
            const el = $(e.currentTarget);
            const pluginName = String(el.data('plugin') || '');
            const url = String(el.data('url') || '');
            const name = String(el.data('name') || '');
            const flag = String(el.data('flag') || '');
            // 组装连播 episodes（glm5.2 播放链路）
            const road = roads.find((r) => r.name === flag);
            const episodes = road ? (road.data || []).map((u, i) => ({ name: (road.identifier || [])[i] || `第${i + 1}集`, url: u })) : [{ name, url }];
            const epIndex = episodes.findIndex((ep) => ep.url === url);
            closeDialog('kazumiSourceDialog');
            Player.play('kazumi:' + pluginName, flag, url, title, name, episodes, Math.max(0, epIndex), src || '');
        });
        // 弹幕入口（kimi UI）：播放时自动加载弹幕
        box.find('.kazumi-ep-btn').on('contextmenu', (e) => {
            e.preventDefault();
            const el = $(e.currentTarget);
            const name = String(el.data('name') || '');
            warnToast(`弹幕功能开发中：${name}`);
        });
    },
};

// ---------------------------------------------------------------- 弹幕（弹弹 play）

/** 弹幕开关与加载（播放 Kazumi 源时自动调用）。 */
Kazumi.loadDanmaku = async function (title, episode) {
    try {
        // 步骤 1：搜索 DanDanBangumiID
        const searchRsp = await doAction('kazumiDanmakuSearch', { title }, '/kazumi/action');
        const animes = (searchRsp && searchRsp.results) || [];
        if (!animes.length) { console.log('[kazumi] danmaku: no match for', title); return; }
        // 取相似度最高的结果
        const best = animes[0];
        const bangumiId = best.animeId || best.bangumiId || 0;
        if (!bangumiId) return;
        // 步骤 2：获取分集弹幕 ID
        const epRsp = await doAction('kazumiDanmakuEpisode', { bangumiId, episode }, '/kazumi/action');
        const episodeId = (epRsp && epRsp.episodeId) || 0;
        if (!episodeId) return;
        // 步骤 3：拉取弹幕
        const commentsRsp = await doAction('kazumiDanmakuComments', { episodeId }, '/kazumi/action');
        const comments = (commentsRsp && commentsRsp.comments) || [];
        console.log('[kazumi] danmaku loaded:', comments.length, 'comments for', title, 'ep', episode);
        // TODO：渲染弹幕（需弹幕渲染引擎，当前 mpv 独立窗口无法直接渲染）
        return comments;
    } catch (e) {
        console.warn('[kazumi] danmaku load failed:', e);
        return [];
    }
};

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

/** WebDAV 同步：上传收藏/历史/规则到远程；按子开关（收藏/历史）决定包含哪些数据。 */
Kazumi.webdavSync = async function (url, username, password) {
    try {
        const s = (await window.vpc.settingsGet()) || {};
        const data = { kazumiRules: this._rules || [] };
        if (s.webDavEnableCollect !== false) data.favorites = s.favorites || [];
        if (s.webDavEnableHistory !== false) data.history = s.history || [];
        const rsp = await doAction('kazumiWebdavSync', {
            url, username, password, data: JSON.stringify(data),
        }, '/kazumi/action');
        return rsp && rsp.code === 200;
    } catch (e) {
        warnToast('WebDAV 同步失败');
        return false;
    }
};

/** WebDAV 恢复：从远程下载收藏/历史/规则；仅恢复子开关启用的数据。 */
Kazumi.webdavRestore = async function (url, username, password) {
    try {
        const s = (await window.vpc.settingsGet()) || {};
        const names = ['kazumiRules'];
        if (s.webDavEnableCollect !== false) names.unshift('favorites');
        if (s.webDavEnableHistory !== false) names.unshift('history');
        const rsp = await doAction('kazumiWebdavRestore', {
            url, username, password, names: JSON.stringify(names),
        }, '/kazumi/action');
        if (rsp && rsp.code === 200 && rsp.data) {
            const d = rsp.data;
            if (d.favorites) await window.vpc.settingsSet('favorites', d.favorites);
            if (d.history) await window.vpc.settingsSet('history', d.history);
            if (d.kazumiRules) {
                // 规则逐个导入
                for (const rule of d.kazumiRules) {
                    await doAction('kazumiAdd', { json: JSON.stringify(rule) }, '/kazumi/action');
                }
                await this.refreshRuleList();
            }
            warnToast('WebDAV 恢复完成');
            return true;
        }
        return false;
    } catch (e) {
        warnToast('WebDAV 恢复失败');
        return false;
    }
};

/** WebDAV 保存配置：持久化地址/账号/密码与开关（不联网，同步/恢复按钮做实际操作）。 */
Kazumi.webdavSaveUI = async function () {
    const url = $('#webdav_url').val().trim();
    const username = $('#webdav_username').val().trim();
    const password = $('#webdav_password').val();
    if (!url) { warnToast('请输入 WebDAV 地址'); return; }
    window.vpc.settingsSet('webDavUrl', url);
    window.vpc.settingsSet('webDavUsername', username);
    window.vpc.settingsSet('webDavPassword', password);
    warnToast('WebDAV 配置已保存');
};

/** WebDAV 同步 UI 入口。 */
Kazumi.webdavSyncUI = async function () {
    const url = $('#webdav_url').val().trim();
    const username = $('#webdav_username').val().trim();
    const password = $('#webdav_password').val();
    if (!url) { warnToast('请输入 WebDAV 地址'); return; }
    showLoading();
    const ok = await this.webdavSync(url, username, password);
    hideLoading();
    warnToast(ok ? 'WebDAV 同步完成' : 'WebDAV 同步失败');
};

/** WebDAV 恢复 UI 入口。 */
Kazumi.webdavRestoreUI = async function () {
    const url = $('#webdav_url').val().trim();
    const username = $('#webdav_username').val().trim();
    const password = $('#webdav_password').val();
    if (!url) { warnToast('请输入 WebDAV 地址'); return; }
    if (!await confirmDialog('从云端恢复将覆盖本地收藏、历史与规则，继续？', { okText: '恢复' })) return;
    showLoading();
    const ok = await this.webdavRestore(url, username, password);
    hideLoading();
    if (ok) {
        // 刷新收藏/历史视图（收藏入口已并入「我的」页签，同时刷新新面板）
        if (typeof Favorites !== 'undefined' && Favorites.render) Favorites.render();
        if (typeof HistoryView !== 'undefined' && HistoryView.render) HistoryView.render();
        if (typeof My !== 'undefined' && My._inited && My._favorites && My._favorites.render) My._favorites.render();
    }
};
