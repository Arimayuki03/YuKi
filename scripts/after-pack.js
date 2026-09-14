/**
 * after-pack.js — electron-builder afterPack 钩子：剔除「系统自带冗余 DLL」（杀软误报源）
 *
 * 两类已知误报，均为 Win10+ 系统 System32 自带、包内副本纯属冗余的文件：
 * 1. Electron 自带 d3dcompiler_47.dll（产物根）——360 等报「程序试图修改关键程序 DLL」；
 * 2. PyInstaller 后端捆绑的 UCRT（resources/python-backend/yuki-backend/_internal/ 下的
 *    ucrtbase.dll 与 api-ms-win-*.dll 转发器）——同为关键系统 DLL 名，同样的误报路径。
 *    Win10+ 上 API Set 由系统加载器直接解析到 System32，包内副本仅为 Win7/8 兼容存在
 *    （Electron 31 本就不支持 Win7/8）；VCRUNTIME140*.dll 系统不保证自带，必须保留。
 *
 * 逃生口：YUKI_KEEP_SYSTEM_DLLS=1 npx electron-builder --win 保留全部（诊断对比用）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// d3dcompiler：Electron 运行时文件名固定在产物根；UCRT：PyInstaller onedir（v6 布局）
// 固定落在 _internal 根，无需递归子目录。
const BACKEND_INTERNAL = path.join('resources', 'python-backend', 'yuki-backend', '_internal');
const D3D_NAME = 'd3dcompiler_47.dll';
const UCRT_RE = /^(ucrtbase\.dll|api-ms-win-.+\.dll)$/i;

/** 剔除产物中的系统自带冗余 DLL，返回 [{rel, size}]；无匹配文件时为空数组（no-op，兼容 mac/linux）。 */
function stripSystemDlls(appOutDir) {
    const removed = [];
    const d3d = path.join(appOutDir, D3D_NAME);
    if (fs.existsSync(d3d)) {
        const size = fs.statSync(d3d).size;
        fs.rmSync(d3d);
        removed.push({ rel: D3D_NAME, size });
    }
    const internal = path.join(appOutDir, BACKEND_INTERNAL);
    if (fs.existsSync(internal)) {
        for (const name of fs.readdirSync(internal)) {
            const dll = path.join(internal, name);
            if (!UCRT_RE.test(name) || !fs.statSync(dll).isFile()) continue;
            const size = fs.statSync(dll).size;
            fs.rmSync(dll);
            removed.push({ rel: path.join(BACKEND_INTERNAL, name), size });
        }
    }
    return removed;
}

/** package.json build.afterPack 指向本文件，context.appOutDir 为 win-unpacked 等产物目录。 */
module.exports = function afterPack(context) {
    if (process.env.YUKI_KEEP_SYSTEM_DLLS === '1') {
        console.log('[after-pack] YUKI_KEEP_SYSTEM_DLLS=1：保留全部冗余系统 DLL（杀软可能误报）');
        return;
    }
    const removed = stripSystemDlls(context.appOutDir);
    if (removed.length > 0) {
        const mb = removed.reduce((s, r) => s + r.size, 0) / 1024 / 1024;
        console.log(`[after-pack] 已剔除 ${removed.length} 个系统自带冗余 DLL（共 ${mb.toFixed(1)}MB）——杀软误报源，运行时回退 System32：`);
        for (const r of removed) console.log(`  - ${r.rel}`);
    }
};

module.exports.stripSystemDlls = stripSystemDlls;
