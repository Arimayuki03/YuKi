/**
 * after-pack.js — electron-builder afterPack 钩子
 *
 * 职责一：剔除「系统自带冗余 DLL」（杀软误报源）
 *
 * 三类已知误报，均为运行时不依赖包内副本（或有主进程兜底）的文件：
 * 1. Electron 自带 d3dcompiler_47.dll（产物根）——360 等报「程序试图修改关键程序 DLL」；
 * 2. PyInstaller 后端捆绑的 UCRT 与 VC++ 运行库（resources/python-backend/yuki-backend/
 *    _internal/ 下的 ucrtbase.dll、api-ms-win-*.dll 转发器、VCRUNTIME140*.dll）——同为
 *    关键系统 DLL 名，未签名安装包向用户可写目录落盘这类文件是火绒/360 行为拦截的高频
 *    触发点。UCRT 在 Win10+ 由系统加载器直接解析到 System32（Electron 31 不支持 Win7/8）；
 *    VCRUNTIME140*.dll 系统不保证自带（VC++ 2015-2022 运行库），剔除后由主进程在启动
 *    后端前预检 System32 副本，缺失时弹窗引导安装官方运行库（见 python-bridge.js 的
 *    vcrt-missing 链路），而不是让杀软把整个安装过程拦成报错。
 * 3. Electron 自带 vulkan-1.dll（产物根）——Windows 上 Chromium/ANGLE 默认走 D3D11，
 *    仅显式 --use-angle=vulkan 时才用到（应用代码零引用）；火绒等按「系统同名 DLL 落盘」
 *    规则拦截未签名安装包的写入，属可剔除的误报面。
 *
 * 职责二：敏感文件泄漏门禁（fail build）
 *    2026-09 曾发生真实事故：package.json 的 files 用 "python-backend 全量收纳" 写法，而
 *    electron-builder 不读 .gitignore，导致网盘蜘蛛运行时状态目录（FM/.quark、FM/.uc
 *    含真实登录 Cookie）被原样打进 app.asar——asar 不加密，任何人一条命令即可取出。
 *    现 files 已收窄（打包后后端只读 extraResources 的 PyInstaller 产物，asar 内的
 *    python-backend 属纯冗余），本门禁负责在将来有人重新放宽 files 时立刻让构建失败。
 *
 * 逃生口：YUKI_KEEP_SYSTEM_DLLS=1 npx electron-builder --win 保留全部（诊断对比用）。
 *    注意：该开关只影响 DLL 剔除，**不影响**敏感文件门禁（泄密不可豁免）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// d3dcompiler/vulkan：Electron 运行时文件名固定在产物根；UCRT：PyInstaller onedir
// （v6 布局）通常落在 _internal 根，但 curl_cffi.libs/lxml 等子目录同样可能带同名
// DLL（依赖升级后即出现），因此必须递归遍历整棵 _internal。
const BACKEND_INTERNAL = path.join('resources', 'python-backend', 'yuki-backend', '_internal');
const ROOT_NAMES = ['d3dcompiler_47.dll', 'vulkan-1.dll'];
const UCRT_RE = /^(ucrtbase\.dll|api-ms-win-.+\.dll|vcruntime140(_1)?\.dll)$/i;

/** 递归收集目录下命中 re 的文件（绝对路径）。 */
function walkMatching(dir, re, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walkMatching(p, re, out);
        else if (ent.isFile() && re.test(ent.name)) out.push(p);
    }
    return out;
}

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
        for (const dll of walkMatching(internal, UCRT_RE, [])) {
            const size = fs.statSync(dll).size;
            fs.rmSync(dll);
            removed.push({ rel: path.relative(appOutDir, dll), size });
        }
    }
    return removed;
}

// ------------------------------------------------------------------ 敏感文件门禁

// 命中即判定为泄密：网盘蜘蛛运行态（Cookie）、测试运行态、以及通用凭据文件名。
const SECRET_NAME_RES = [
    /\.quark$/i,                       // FM/.quark —— 夸克登录 Cookie
    /\.uc$/i,                          // FM/.uc —— UC 网盘登录 Cookie
    /(^|[\\/])\.?pan_cookies\.json$/i, // DPAPI 加密的网盘 Cookie 库
    /(^|[\\/])cookies-[a-z0-9_]+$/i,   // 测试运行期的 cookie jar 夹具
    /(^|[\\/])\.?mt-login\//i,         // 蜘蛛登录态目录
];
// 只扫描产物里"不该出现用户数据"的位置；vendor/mpv 配置等不参与。
const SECRET_SCAN_ROOTS = ['resources'];

/** 列出 app.asar 内的全部条目路径（拿不到 asar 模块时回退裸文件名扫描，二者都覆盖）。 */
function asarEntries(appOutDir) {
    const asarPath = path.join(appOutDir, 'resources', 'app.asar');
    if (!fs.existsSync(asarPath)) return [];
    try {
        const asar = require('@electron/asar');
        return asar.listPackage(asarPath).map((p) => path.join('app.asar', p.replace(/^[\\/]+/, '')));
    } catch (e) {
        return [`<asar-list-failed:${e.message}>`];
    }
}

/** 收集产物中的敏感文件相对路径（含 asar 内部条目与 extraResources 落盘文件）。 */
function findSecrets(appOutDir) {
    const hits = [];
    for (const rel of asarEntries(appOutDir)) {
        if (SECRET_NAME_RES.some((re) => re.test(rel))) hits.push(rel);
    }
    for (const root of SECRET_SCAN_ROOTS) {
        const abs = path.join(appOutDir, root);
        // app.asar 本身是二进制容器，不做逐字节扫描（误报率高）；条目名已覆盖
        hits.push(...walkMatching(abs, /(^|[/\\])(\.quark|\.uc|pan_cookies\.json)$/, [])
            .map((p) => path.relative(appOutDir, p)));
    }
    return [...new Set(hits)];
}

/** package.json build.afterPack 指向本文件，context.appOutDir 为 win-unpacked 等产物目录。 */
module.exports = function afterPack(context) {
    // —— 门禁先行且不可豁免 ——
    const secrets = findSecrets(context.appOutDir);
    if (secrets.length > 0) {
        throw new Error('[after-pack] 检测到敏感文件被打进安装包（Cookie/凭据泄露，构建终止）：\n  - '
            + secrets.join('\n  - ')
            + '\n修复：收窄 package.json build.files，勿用 python-backend/** 这类全量收纳。');
    }

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
module.exports.findSecrets = findSecrets;

