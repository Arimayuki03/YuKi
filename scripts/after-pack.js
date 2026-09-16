/**
 * after-pack.js — electron-builder afterPack 钩子：剔除「系统自带冗余 DLL」（杀软误报源）
 *
 * 三类已知误报，均为运行时不依赖包内副本的文件：
 * 1. Electron 自带 d3dcompiler_47.dll（产物根）——360 等报「程序试图修改关键程序 DLL」；
 * 2. PyInstaller 后端捆绑的 UCRT（resources/python-backend/yuki-backend/_internal/ 下的
 *    ucrtbase.dll 与 api-ms-win-*.dll 转发器）——同为关键系统 DLL 名，同样的误报路径。
 *    Win10+ 上 API Set 由系统加载器直接解析到 System32，包内副本仅为 Win7/8 兼容存在
 *    （Electron 31 本就不支持 Win7/8）；VCRUNTIME140*.dll 系统不保证自带，必须保留。
 * 3. Electron 自带 vulkan-1.dll（产物根）——Windows 上 Chromium/ANGLE 默认走 D3D11，
 *    仅显式 --use-angle=vulkan 时才用到（应用代码零引用）；火绒等按「系统同名 DLL 落盘」
 *    规则拦截未签名安装包的写入，属可剔除的误报面。
 *
 * 逃生口：YUKI_KEEP_SYSTEM_DLLS=1 npx electron-builder --win 保留全部（诊断对比用）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// d3dcompiler/vulkan：Electron 运行时文件名固定在产物根；UCRT：PyInstaller onedir
// （v6 布局）固定落在 _internal 根，无需递归子目录。
const BACKEND_INTERNAL = path.join('resources', 'python-backend', 'yuki-backend', '_internal');
const ROOT_NAMES = ['d3dcompiler_47.dll', 'vulkan-1.dll'];
const UCRT_RE = /^(ucrtbase\.dll|api-ms-win-.+\.dll)$/i;

/** 剔除产物中的系统自带冗余 DLL，返回 [{rel, size}]；无匹配文件时为空数组（no-op，兼容 mac/linux）。 */
function stripSystemDlls(appOutDir) {
    const removed = [];
    for (const name of ROOT_NAMES) {
        const dll = path.join(appOutDir, name);
        if (fs.existsSync(dll)) {
            const size = fs.statSync(dll).size;
            fs.rmSync(dll);
            removed.push({ rel: name, size });
        }
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
