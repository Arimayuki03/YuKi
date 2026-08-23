/**
 * app-icon.js — 应用窗口图标（多表示 nativeImage）
 *
 * 背景：不设置 icon 的 BrowserWindow 回落到 exe 图标，而打包 exe 的图标由
 * electron-builder 从 1024px 像素画 assets/icon.png 平滑插值缩出，小尺寸下
 * 像素画细线条被糊掉/丢失（表现为窗口图标「残缺」）。assets/tray/ 下是
 * make-tray-icons.ps1 最近邻预缩的 16/20/24/32px 硬边产物（托盘在用，完好），
 * 此处复用同一组产物按 DPI 组多表示图，大尺寸回退原图。
 */
const path = require('path');
const fs = require('fs');

/** 返回供 BrowserWindow icon 选项使用的 nativeImage；资源缺失时返回 undefined（回落 exe 图标）。 */
function windowIcon() {
    try {
        const { app, nativeImage } = require('electron');
        const root = app.getAppPath();
        const img = nativeImage.createEmpty();
        const reps = [
            [path.join(root, 'assets', 'tray', 'tray-16.png'), 1],
            [path.join(root, 'assets', 'tray', 'tray-20.png'), 1.25],
            [path.join(root, 'assets', 'tray', 'tray-24.png'), 1.5],
            [path.join(root, 'assets', 'tray', 'tray-32.png'), 2],
            [path.join(root, 'assets', 'icon.png'), 1],
        ];
        let loaded = 0;
        for (const [p, scale] of reps) {
            if (!fs.existsSync(p)) continue;
            img.addRepresentation({ scaleFactor: scale, buffer: fs.readFileSync(p) });
            loaded++;
        }
        if (loaded > 0 && !img.isEmpty()) return img;
    } catch (e) { /* 资源异常时回落 exe 图标 */ }
    return undefined;
}

module.exports = { windowIcon };
