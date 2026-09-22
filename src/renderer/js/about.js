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
        try { version = await window.yuki.appVersion(); } catch (e) { /* 走下方兜底 */ }
        // 兜底不硬编码版本号：yuki:app-version 通道失败时用 UA 里的 Chrome 主版本
        // 拼运行时占位串（如 Chrome/140.0 → 0.2.x-Chrome.140），避免随包过期失真
        if (!version) {
            const m = (navigator && navigator.userAgent || '').match(/Chrome\/(\d+)/);
            version = `0.2.x-Chrome.${m ? m[1] : '?'}`;
        }
        $('#about-version').text(version);
    },
};

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.about = About;
}(typeof window !== 'undefined' ? window : globalThis));
