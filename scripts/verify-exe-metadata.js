#!/usr/bin/env node
'use strict';
// verify-exe-metadata.js — afterAllArtifactBuild 钩子：可执行体版本信息门禁。
//
// 为什么不放在 afterPack（after-pack.js）：electron-builder 的 rcedit（覆写
// CompanyName/ProductName 等 VERSION_INFO）在框架 afterPack（signApp）阶段执行，
// 晚于用户 afterPack 钩子——在 afterPack 里查 exe 元数据永远读到 Electron 原始
// 值（CompanyName="GitHub, Inc."）误报。afterAllArtifactBuild 在全部产物（含
// NSIS 安装包）落定后才跑，是唯一能校验最终 exe 元数据的钩子点。
//
// 校验内容（杀软启发式扣分项，fail-closed）：
//   - CompanyName 缺失/仍为 Electron 原始 "GitHub, Inc." → package.json 缺 author
//     字段时 electron-builder 不覆盖预编译二进制的原始值；
//   - ProductName 缺失 → package.json 缺 productName/description。
// 实现复用 after-pack.js 的 readVersionStrings/checkExecutableMetadata（单一来源）。
//
// 职责分层（与 after-pack.js 的 checkExecutableMetadata 配合）：
//   - 本钩子（afterAllArtifactBuild）负责「win 产物必须存在且可校验」——exe 缺失
//     直接 fail-closed（构建终止），绝不静默跳过；
//   - after-pack.js 的 checkExecutableMetadata 内部对 exe 缺失静默 return，那是供
//     其他调用方复用的宽容语义（其注释已写明）；本钩子已在外面兜住存在性，静默
//     分支不会在本钩子路径上被触发。
//
// EPIPE 备注：fail-closed 的错误消息只走 console.error 的少量短行（非大量 stdout
// 写入），electron-builder 亦以子进程同步日志消费本钩子输出，exit(1) 无管道截断
// 风险；若未来在此输出大体积日志，应在最后一次 write 的回调里再 exit。

const fs = require('node:fs');
const path = require('node:path');
const { checkExecutableMetadata } = require('./after-pack.js');

// 与 electron-builder 配置一致的产物命名：build.productName（当前 "YuKi"，回退顶层
// productName/package name，与 electron-builder appInfo.productName 的取值优先级一致：
// config.productName → metadata.productName → metadata.name）→ sanitizeFileName 后即
// 产物目录名/主 exe 名（win-unpacked/YuKi.exe、mac 的 YuKi.app 等）。build.executableName
// 与 build.win.executableName 均未设置（productFilename：executableName 优先，否则
// sanitizedProductName），故按 productName 推导即可。
// 注意：若改 package.json 的 productName，需同步确认此推导仍成立。
const pkg = require('../package.json');
const PRODUCT_NAME = (pkg.build && pkg.build.productName) || pkg.productName || pkg.name;

// M28：与 electron-builder 的 sanitizeFileName 同口径归一化——把文件名非法字符
// （< > : " / \ | ? * 及 0x00-0x1F 控制字符）替换为 _，PRODUCT_NAME 须先过此函数
// 再参与 exe 名推导（此前直接取原值，productName 一旦含空格外非法字符即对不上
// electron-builder 的实际产物名，存在性校验必 fail-closed 误报）。
function sanitizeFileName(name) {
    return String(name).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
}
const EXE_BASE_NAME = sanitizeFileName(PRODUCT_NAME);

// M28：win 产物目录名（electron-builder WinPackager 的 appOutDir 惯例：<outDir>/win-unpacked）。
// 硬编码 'win-unpacked' 的前提是当前 win 目标仅 x64（package.json build.win.target.arch=['x64']，
// electron-builder 对 win-unpacked 目录名不掺 arch 后缀）；若未来加 ia32/arm64，
// 目录会变为 win-ia32-unpacked / win-arm64-unpacked，此处推导即失配——启动时校验
// 配置并打警告提醒同步本脚本（fail-open：只告警不中断，由存在性校验兜底报错）。
const WIN_UNPACKED_DIR = 'win-unpacked';
const _winTargets = (pkg.build && pkg.build.win && pkg.build.win.target) || [];
const _winArchs = _winTargets.flatMap((t) => (t && Array.isArray(t.arch)) ? t.arch : []);
if (_winArchs.some((a) => a && a !== 'x64')) {
    console.warn('[verify-exe-metadata] 警告：build.win.target.arch 已不再只有 x64，'
        + `win 产物目录名将带 arch 后缀（如 win-ia32-unpacked），本脚本硬编码的 "${WIN_UNPACKED_DIR}" 需同步调整。`);
}

// 平台判定：BuildResult.platformToTargets 的 key 是 app-builder-lib 的 Platform 实例
// （其 nodeName 属性固定为 'darwin'/'linux'/'win32'，见 Platform 枚举实现）。按 nodeName
// 识别 win32，不依赖 require('app-builder-lib')——脚本运行于 electron-builder 进程内，
// key 必带 nodeName；单测等环境下也能用同形状的伪实例构造（避免实例相等判断对依赖
// 的硬绑定）。宁可漏判为非 win 被下游报错，也绝不把 win 构建静默漏检——而本钩子的
// 判定是「存在 win32 即按 win 门禁走」，不会把 win 误判为非 win。
function isWindowsBuild(platformToTargets) {
    for (const key of platformToTargets.keys()) {
        // 用 app-builder-lib 的 Platform 真实字段：nodeName='win32'、name='win'。
        // 原兜底 `key.name === 'win32'` 恒为 false（Platform.WINDOWS 的 name 是
        // 'win'），是永不执行的死条件。
        if (key && (key.nodeName === 'win32' || key.name === 'win')) return true;
    }
    return false;
}

module.exports = async function verifyExeMetadata(buildResult) {
    // buildResult.outDir 是 electron-builder 的输出根（dist/）；win 产物布局为
    // dist/win-unpacked/<productName>.exe。非 win 构建 platformToTargets 里没有
    // win32 平台——本钩子只服务 win，直接返回（mac/linux 布局不同，不归本钩子管）。
    const platformToTargets = buildResult && buildResult.platformToTargets;
    // platformToTargets 缺失/结构变化时（electron-builder 版本差异、单测伪对象）
    // 必须显式 fail-closed：原写法 `if (platformToTargets && !isWindowsBuild(...))`
    // 在它缺失时会跳过 return、直接落到「按 win 处理」，报「未找到 win 产物主
    // exe」——对 mac/linux 构建是一条完全误导的定位信息。
    if (!platformToTargets) {
        console.error('[verify-exe-metadata] 无法从 buildResult.platformToTargets 判定构建平台（fail-closed，构建终止）。'
            + '\n修复：确认 electron-builder 版本返回了 platformToTargets，'
            + '或改用其他方式判定平台后再启用本钩子。');
        process.exit(1);
        return [];
    }
    if (!isWindowsBuild(platformToTargets)) {
        return [];
    }
    const appOutDir = path.join(String((buildResult && buildResult.outDir) || ''), WIN_UNPACKED_DIR);
    const exe = path.join(appOutDir, `${EXE_BASE_NAME}.exe`);
    // fail-closed（M4）：此前直接把 appOutDir 交给 checkExecutableMetadata，exe 不存在
    // 时其内部 fs.existsSync 为假即静默 return——win 门禁被整体跳过还宣称通过。这里
    // 先自行校验存在性，缺失即构建失败并指明缺失路径。
    if (!fs.existsSync(exe)) {
        console.error('[verify-exe-metadata] 未找到 win 产物主 exe（fail-closed，构建终止）：' + exe
            + '\n修复：确认 win 构建正常产出 win-unpacked 目录，且主 exe 名与 package.json '
            + 'productName 一致（改 productName 需同步 verify-exe-metadata.js 的推导）。');
        process.exit(1);
        return []; // 显式 return：stub 掉 process.exit 时（单测）不再依赖进程级副作用
    }
    // exe 名与 PRODUCT_NAME（经 sanitizeFileName 归一化）同源推导，一并传给
    // checkExecutableMetadata——此前它内部写死 'YuKi.exe'，productName 一变就走
    // 「不存在则静默 return」，门禁假绿。
    checkExecutableMetadata(appOutDir, `${EXE_BASE_NAME}.exe`);
    return []; // 不追加新产物
};
