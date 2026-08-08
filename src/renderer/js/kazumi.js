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
/* global $, doAction, escHtml, warnToast, showLoading, hideLoading, openDialog, closeDialog, confirmDialog, Player, Detail, Favorites, HistoryView */

const Kazumi = {
    _rules: [],        // 已安装规则缓存（kazumiList 拉取）
    _rulesLoaded: false,
    _dlgToken: 0,      // 弹窗操作令牌：防过期回调（关闭后旧回调作废）

    // ---------------------------------------------------------------- 规则管理（设置页）

    /** 初始化设置页 Kazumi 板块（app.js bootstrap 时调用一次）。 */
    init() {
        $('#kazumi_rule_add').on('click', () => this.importRule());
        $('#kazumi_rule_paste').on('click', () => this.importFromClipboard());
        $('#kazumi_rule_clear').on('click', () => $('#kazumi_rule_json').val(''));
        $('#kazumi_rule_shop').on('click', () => this.openShopDialog());
        $('#kazumi_rule_editor').on('click', () => this.openEditorDialog());
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
        // WebDAV 同步
        $('#webdav_sync').on('click', () => this.webdavSyncUI());
        $('#webdav_restore').on('click', () => this.webdavRestoreUI());
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
        box.html(this._rules.map((r) => `
            <div class="history-item">
                <span class="history-url" title="${escHtml(r.name)} v${escHtml(r.version || '')}">${escHtml(r.name)} <span style="color:var(--md-on-surface-variant);font-size:11px">v${escHtml(r.version || '')}</span></span>
                <button class="history-btn kazumi-rule-edit" data-name="${escHtml(r.name)}" title="编辑规则">✎</button>
                <label class="md-switch" style="margin:0;flex:none">
                    <input type="checkbox" class="kazumi-rule-toggle" data-name="${escHtml(r.name)}" ${r.enabled !== false ? 'checked' : ''}>
                    <span class="md-switch-track"></span>
                </label>
                <button class="history-btn kazumi-rule-del" data-name="${escHtml(r.name)}" title="删除该规则">✕</button>
            </div>`).join(''));
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

    /** 打开规则商店弹窗。 */
    async openShopDialog() {
        openDialog('kazumiShopDialog');
        $('#kazumi-shop-body').html('<div class="tip-line">正在加载规则商店…</div>');
        try {
            const rsp = await doAction('kazumiShopCatalog', {}, '/kazumi/action');
            const catalog = (rsp && rsp.catalog) || [];
            if (!catalog.length) {
                $('#kazumi-shop-body').html('<div class="tip-line">规则商店为空或加载失败</div>');
                return;
            }
            this._renderShopCatalog(catalog);
        } catch (e) {
            $('#kazumi-shop-body').html('<div class="tip-line">规则商店加载失败</div>');
        }
    },

    _renderShopCatalog(catalog) {
        const box = $('#kazumi-shop-body');
        const installed = new Set(this._rules.map((r) => r.name.toLowerCase()));
        box.html(catalog.map((item) => {
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
                    this.refreshRuleList();
                    this.openShopDialog(); // 刷新商店状态
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

    /** Bangumi 番剧详情。 */
    async bangumiInfo(subjectId) {
        try {
            const rsp = await doAction('kazumiBangumiInfo', { id: subjectId }, '/kazumi/action');
            return (rsp && rsp.info) || null;
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
     * @param title 影片名
     * @param site  来源标识（kazumi:规则名 或 CatVod site key）
     * @param src    Kazumi 搜索结果链接（kazumi: 前缀时作为默认选中）
     */
    async openSourceDialog(title, site, src) {
        if (!this.hasEnabledRules()) { warnToast('尚未启用任何 Kazumi 规则'); return; }
        const token = ++this._dlgToken;
        $('#kazumi-dialog-title').text(`Kazumi 规则源 · 《${title}》`);
        $('#kazumi-dialog-body').html('<div class="tip-line">正在查询规则源…</div>');
        openDialog('kazumiSourceDialog');

        // 若来自搜索结果（kazumi: 前缀），直接解析该源剧集
        if (String(site).startsWith('kazumi:') && src) {
            const pluginName = String(site).slice(7);
            await this._loadChapters(pluginName, src, title, token);
            return;
        }

        // 否则先聚合搜索全部规则
        try {
            const results = await this.aggregateSearch(title);
            if (token !== this._dlgToken) return;
            if (!results.length) {
                $('#kazumi-dialog-body').html('<div class="tip-line">所有规则源均未找到该影片</div>');
                return;
            }
            this._renderSearchResults(results, title, token);
        } catch (e) {
            if (token !== this._dlgToken) return;
            $('#kazumi-dialog-body').html('<div class="tip-line">规则源查询失败</div>');
        }
    },

    /** 渲染搜索结果（按规则分组），并异步补全 Bangumi 元数据（封面/简介）。 */
    _renderSearchResults(results, title, token) {
        const box = $('#kazumi-dialog-body');
        let html = '';
        results.forEach((r) => {
            // 验证码源标记（kimi UI）
            if (r.captcha) {
                html += `<div class="kazumi-plugin-group">
                    <div class="kazumi-plugin-head">${escHtml(r.pluginName)} <span class="src-count" style="color:var(--md-error)">需验证</span></div>
                    <div class="kazumi-result-list">
                        <div class="kazumi-result-item kazumi-captcha-item" data-plugin="${escHtml(r.pluginName)}" data-captcha-url="${escHtml(r.captchaUrl || '')}">
                            <span class="kazumi-result-name">该源需要验证码验证</span>
                            <span class="kazumi-result-src">点击打开验证页面，完成验证后自动重试</span>
                        </div>
                    </div>
                </div>`;
                return;
            }
            const items = (r.data || []).map((it) => `
                <div class="kazumi-result-item" data-plugin="${escHtml(r.pluginName)}" data-src="${escHtml(it.src)}" data-name="${escHtml(it.name)}">
                    <span class="kazumi-result-name">${escHtml(it.name)}</span>
                    <span class="kazumi-result-src">${escHtml(it.src)}</span>
                </div>`).join('');
            html += `<div class="kazumi-plugin-group">
                <div class="kazumi-plugin-head">${escHtml(r.pluginName)} <span class="src-count">${(r.data || []).length}</span></div>
                <div class="kazumi-result-list">${items || '<div class="tip-line">无结果</div>'}</div>
            </div>`;
        });
        box.html(html);
        // 绑定点击：进入剧集解析
        box.find('.kazumi-result-item:not(.kazumi-captcha-item)').on('click', (e) => {
            if (token !== this._dlgToken) return;
            const el = $(e.currentTarget);
            const pluginName = String(el.data('plugin') || '');
            const src = String(el.data('src') || '');
            const name = String(el.data('name') || '');
            this._loadChapters(pluginName, src, name, token);
        });
        // 绑定验证码点击：打开验证窗口
        box.find('.kazumi-captcha-item').on('click', (e) => {
            if (token !== this._dlgToken) return;
            const el = $(e.currentTarget);
            const url = String(el.data('captcha-url') || '');
            if (url) this._openCaptchaWindow(url);
        });
        // 异步补全 Bangumi 元数据（不阻塞交互）
        this._enrichBangumiMetadata(title, box, token);
    },

    /** 打开验证码验证窗口（隐藏 BrowserWindow，用户手动过验证）。 */
    _openCaptchaWindow(url) {
        // 复用现有 captureDirect 窗口机制（主进程隐藏窗口）
        // 打开后用户手动完成验证，窗口关闭后自动重试搜索
        warnToast('正在打开验证页面，请手动完成验证…');
        window.vpc.captureDirect(url).then(() => {
            warnToast('验证完成，请重新搜索');
        }).catch(() => {
            warnToast('验证窗口打开失败');
        });
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

    async _renderBangumiDetail(info, token) {
        const box = $('#kazumi-dialog-body');
        const cover = (info.images && (info.images.large || info.images.common || info.images.medium)) || '';
        const score = info.rating && info.rating.score ? info.rating.score : '';
        const votes = info.rating && info.rating.total ? `${info.rating.total} 人评分` : '';
        const meta = [info.date, score, votes, info.platform].filter(Boolean).join(' · ');
        // 顶部横幅
        let html = `<div class="kazumi-bangumi-banner" style="margin-bottom:16px;">
            ${cover ? `<img class="kazumi-bangumi-cover" src="${escHtml(cover)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
            <div class="kazumi-bangumi-info">
                <div class="kazumi-bangumi-title">${escHtml(info.name_cn || info.name || '')}</div>
                <div class="kazumi-bangumi-meta">${escHtml(meta)}</div>
                ${info.summary ? `<div class="kazumi-bangumi-summary">${escHtml(info.summary)}</div>` : ''}
            </div>
        </div>`;
        // 页签导航
        html += `<div class="class-tabs" id="bangumi-detail-tabs" style="margin-bottom:12px;">
            <span class="class-tab active" data-tab="episodes">分集</span>
            <span class="class-tab" data-tab="characters">角色</span>
            <span class="class-tab" data-tab="staff">制作</span>
            <span class="class-tab" data-tab="comments">评论</span>
            <span class="class-tab" data-tab="relations">关联</span>
        </div>`;
        html += '<div id="bangumi-detail-content" style="max-height:40vh;overflow-y:auto;"></div>';
        box.html(html);
        // 默认载入分集
        await this._loadBangumiTab(info.id, 'episodes', token);
        // 页签切换
        $('#bangumi-detail-tabs').on('click', '.class-tab', async (e) => {
            if (token !== this._dlgToken) return;
            const tab = String($(e.currentTarget).data('tab') || '');
            $('#bangumi-detail-tabs .class-tab').removeClass('active');
            $(e.currentTarget).addClass('active');
            await this._loadBangumiTab(info.id, tab, token);
        });
    },

    async _loadBangumiTab(subjectId, tab, token) {
        const box = $('#bangumi-detail-content');
        box.html('<div class="tip-line">载入中…</div>');
        try {
            if (tab === 'episodes') {
                const data = await this.bangumiEpisodes(subjectId);
                if (token !== this._dlgToken) return;
                const list = (data && data.data) || [];
                box.html(list.length
                    ? list.map((ep) => `<div class="kazumi-detail-ep">
                        <span class="kazumi-detail-ep-no">${ep.sort || ep.ep || ''}</span>
                        <span class="kazumi-detail-ep-name">${escHtml(ep.name_cn || ep.name || '')}</span>
                        <span class="kazumi-detail-ep-type">${escHtml(ep.type === 1 ? 'SP' : ep.type === 2 ? 'OP' : ep.type === 3 ? 'ED' : '')}</span>
                    </div>`).join('')
                    : '<div class="tip-line">暂无分集信息</div>');
            } else if (tab === 'characters') {
                const list = await this.bangumiCharacters(subjectId);
                if (token !== this._dlgToken) return;
                box.html(list.length
                    ? list.map((c) => `<div class="kazumi-detail-char">
                        <img class="kazumi-detail-avatar" src="${escHtml((c.images && c.images.medium) || '')}" referrerpolicy="no-referrer" onerror="this.style.display='none'">
                        <div class="kazumi-detail-char-info">
                            <div class="kazumi-detail-char-name">${escHtml(c.name || '')}</div>
                            <div class="kazumi-detail-char-role">${escHtml(c.role_name || '')}</div>
                        </div>
                    </div>`).join('')
                    : '<div class="tip-line">暂无角色信息</div>');
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
            this._renderChapterRoads(pluginName, roads, title, token);
        } catch (e) {
            if (token !== this._dlgToken) return;
            $('#kazumi-dialog-body').html('<div class="tip-line">剧集解析失败</div>');
        }
    },

    /** 渲染线路与剧集列表。 */
    _renderChapterRoads(pluginName, roads, title, token) {
        const box = $('#kazumi-dialog-body');
        let html = `<div class="kazumi-plugin-head">${escHtml(pluginName)} · ${escHtml(title)}</div>`;
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
            Player.play('kazumi:' + pluginName, flag, url, title, name, episodes, Math.max(0, epIndex));
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

/** 以图搜番：上传图片或粘贴图片 URL，调 trace.moe 识别番剧。 */
Kazumi.imageSearch = async function (imageFile) {
    try {
        if (typeof imageFile === 'string' && /^https?:\/\//i.test(imageFile)) {
            // URL 直接搜索
            const rsp = await doAction('kazumiImageSearch', { url: imageFile }, '/kazumi/action');
            return (rsp && rsp.results) || [];
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
            return (rsp && rsp.results) || [];
        }
        warnToast('请提供图片 URL 或选择图片文件');
        return [];
    } catch (e) {
        warnToast('以图搜番失败');
        return [];
    }
};

// ---------------------------------------------------------------- WebDAV 同步

/** WebDAV 同步：上传收藏/历史/规则到远程。 */
Kazumi.webdavSync = async function (url, username, password) {
    try {
        const s = (await window.vpc.settingsGet()) || {};
        const data = {
            favorites: s.favorites || [],
            history: s.history || [],
            kazumiRules: this._rules || [],
        };
        const rsp = await doAction('kazumiWebdavSync', {
            url, username, password, data: JSON.stringify(data),
        }, '/kazumi/action');
        return rsp && rsp.code === 200;
    } catch (e) {
        warnToast('WebDAV 同步失败');
        return false;
    }
};

/** WebDAV 恢复：从远程下载收藏/历史/规则。 */
Kazumi.webdavRestore = async function (url, username, password) {
    try {
        const rsp = await doAction('kazumiWebdavRestore', {
            url, username, password, names: JSON.stringify(['favorites', 'history', 'kazumiRules']),
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
        // 刷新收藏/历史视图
        if (typeof Favorites !== 'undefined' && Favorites.render) Favorites.render();
        if (typeof HistoryView !== 'undefined' && HistoryView.render) HistoryView.render();
    }
};

// 启动时自动初始化（设置页板块存在才绑定）
$(function () {
    if ($('#kazumi_rule_json').length) Kazumi.init();
});
