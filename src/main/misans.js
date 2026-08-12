/**
 * misans.js — MiSans 内置 UI 字体（打包内置，无运行时下载，T61）
 *
 * 字体源：vendor/misans/MiSans-{Regular,Bold}.min.css + 分片 woff2
 * （随包内置于 extraResources vendor/；子集化按 unicode-range 分片，
 *  浏览器只加载用到的分片，总 ~4MB 两字重：Regular 正文 / Bold 标题）。
 * 本地缺失时可 `node scripts/download-binaries.js misans` 手动补齐（开发用）。
 *
 * - fontCssUrls()：已就绪时返回各字重 CSS 的 file:// URL，渲染层注入 <link>；
 *   未就绪返回空数组（回退系统字体，不影响使用）。
 * - ensureMisans()：仅探测内置字体是否就绪（不做运行时下载），返回 Promise<boolean>。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// 打包后 extraResources 放在 resources/，vendor 从该处读取
const ROOT = (() => {
    try {
        const { app } = require('electron');
        return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
    } catch (e) { return path.join(__dirname, '..', '..'); }
})();
const DIR = path.join(ROOT, 'vendor', 'misans');
// 不引入 Medium：避免 400 正文命中 380 Medium 而非 330 Regular
const WEIGHTS = ['Regular', 'Bold'];

/** 已就绪的 MiSans CSS 文件路径（存在且非空，避免损坏/空文件视为就绪）。 */
function readyCssPaths() {
    const out = [];
    for (const w of WEIGHTS) {
        const p = path.join(DIR, `MiSans-${w}.min.css`);
        try { if (fs.existsSync(p) && fs.statSync(p).size > 1024) out.push(p); } catch (e) { /* ignore */ }
    }
    return out;
}

/** 渲染层 <link> 用的 CSS file:// URL 列表（未就绪返回空数组）。 */
function fontCssUrls() {
    return readyCssPaths().map((p) => pathToFileURL(p).href);
}

/** 内置字体就绪探测（打包内置，无运行时下载）：返回是否就绪。 */
function ensureMisans() {
    const ready = readyCssPaths().length > 0;
    if (!ready) console.log('[misans] 内置字体未就绪，回退系统字体');
    return Promise.resolve(ready);
}

module.exports = { ensureMisans, fontCssUrls, readyCssPaths };
