/**
 * about.js — 设置 → 关于分类（T46）
 *
 * 展示应用标识与致谢（版本号来自主进程 yuki:app-version）。
 */
/* global $ */

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
        let version = null;
        try { version = await window.yuki.appVersion(); } catch (e) { /* 使用内置版本兜底 */ }
        $('#about-version').text(version || '0.2.1');
    },
};

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.about = About;
}(typeof window !== 'undefined' ? window : globalThis));
