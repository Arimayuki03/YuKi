/**
 * about.js — 设置 → 关于分类（T46）
 *
 * 展示应用标识、技术栈、致谢与系统信息（版本 + Electron/Chromium/Node/V8）。
 * 分类进入时渲染（数据来自主进程 vpc:app-info / vpc:app-version）。
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
        let info = null;
        try { info = await window.vpc.appInfo(); } catch (e) { /* ignore */ }
        let version = info && info.version;
        if (!version) {
            try { version = await window.vpc.appVersion(); } catch (e) { /* 使用内置版本兜底 */ }
        }
        $('#about-version').text(version || '0.1.0');
        if (!info) return;
        const platform = [info.platform, info.arch].filter(Boolean).join(' · ');
        const rows = [
            ['操作系统', platform],
            ['Electron', info.electron || ''],
            ['Chromium', info.chromium || ''],
            ['Node.js', info.node || ''],
            ['V8', info.v8 || ''],
        ].filter(([, v]) => v && String(v).trim());
        $('#about-sysinfo').html(rows.map(([k, v]) =>
            `<div class="about-row"><span>${escHtml(k)}</span><span>${escHtml(v)}</span></div>`).join(''));
    },
};

(function (root) {
    root.VPC = root.VPC || {};
    root.VPC.about = About;
}(typeof window !== 'undefined' ? window : globalThis));
