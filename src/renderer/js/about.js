/**
 * about.js — 「关于」页面（独立视图，T46）
 *
 * 展示应用标识、技术栈、致谢与系统信息（版本 + Electron/Chromium/Node/V8）。
 * 视图进入时渲染（数据来自主进程 vpc:app-info / vpc:app-version）。
 */
/* global $, escHtml */

const About = {
    _inited: false,

    init() {
        if (this._inited) return;
        this._inited = true;
    },

    async enter() {
        this.init();
        await this.render();
    },

    async render() {
        try { $('#about-version').text(await window.vpc.appVersion()); } catch (e) { /* 取版本失败留占位 */ }
        let info = null;
        try { info = await window.vpc.appInfo(); } catch (e) { /* ignore */ }
        if (!info) return;
        const rows = [
            ['操作系统', `${info.platform} · ${info.arch}`],
            ['Electron', info.electron || ''],
            ['Chromium', info.chromium || ''],
            ['Node.js', info.node || ''],
            ['V8', info.v8 || ''],
        ].filter(([, v]) => v && String(v).trim());
        $('#about-sysinfo').html(rows.map(([k, v]) =>
            `<div class="about-row"><span>${escHtml(k)}</span><span>${escHtml(v)}</span></div>`).join(''));
    },
};
