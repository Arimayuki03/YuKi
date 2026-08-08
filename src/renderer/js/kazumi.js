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
/* global $, doAction, escHtml, warnToast, showLoading, hideLoading, openDialog, closeDialog, confirmDialog, Player */

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
        $('#kazumi_rule_list').on('click', '.kazumi-rule-del', (e) => {
            const name = String($(e.currentTarget).data('name') || '');
            if (name) this.removeRule(name);
        });
        $('#kazumi_rule_list').on('change', '.kazumi-rule-toggle', (e) => {
            const name = String($(e.currentTarget).data('name') || '');
            const enabled = !!e.currentTarget.checked;
            if (name) this.toggleRule(name, enabled);
        });
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

    /** 渲染搜索结果（按规则分组）。 */
    _renderSearchResults(results, title, token) {
        const box = $('#kazumi-dialog-body');
        let html = '';
        results.forEach((r) => {
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
        box.find('.kazumi-result-item').on('click', (e) => {
            if (token !== this._dlgToken) return;
            const el = $(e.currentTarget);
            const pluginName = String(el.data('plugin') || '');
            const src = String(el.data('src') || '');
            const name = String(el.data('name') || '');
            this._loadChapters(pluginName, src, name, token);
        });
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
    },
};

// 启动时自动初始化（设置页板块存在才绑定）
$(function () {
    if ($('#kazumi_rule_json').length) Kazumi.init();
});
