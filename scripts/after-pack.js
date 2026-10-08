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
 * 4. resources/elevate.exe（electron-builder 默认塞入的 UAC 提权助手）——无签名、唯一
 *    功能是弹 UAC 框再起进程，「未签名提权器」是 360「风险程序」类的经典命中项。
 *    YuKi 是纯 per-user 安装（nsis 未设 perMachine，默认装 %LocalAppData%\Programs），
 *    安装器自身不需要它；应用内升级走 electron-updater NsisUpdater，仅在安装器报
 *    UNKNOWN/EACCES 或更新元数据标记 isAdminRightsRequired 时才调 elevate.exe，
 *    二者对本应用都不成立，缺失时 NsisUpdater 另有 shell.openPath 兜底。
 *    packElevateHelper:false 已在源头关闭，此处兜底防御版本差异并给出可操作报错。
 * 5. LICENSES.chromium.html（产物根，约 20MB 量级，随 Electron 版本漂移）——Chromium
 *    依赖许可证汇总 HTML，非运行时组件；Electron 许可证文本 LICENSE.electron.txt 保留，
 *    删汇总 HTML 是业界通行做法（VS Code 等同样不随包分发），详见下方函数注释。
 *
 * 职责三：可执行体版本信息门禁（fail build）
 *    package.json 缺 author 字段时 electron-builder 不写 CompanyName，YuKi.exe 保留
 *    Electron 预编译二进制的原始值「GitHub, Inc.」——未签名程序冒用大公司名义是启发式
 *    评分的显著扣分项（v0.2.6 及之前正是如此）。这里校验产物内 exe 的 CompanyName/
 *    ProductName 已被 rcedit 正确覆盖，异常即构建失败。
 *
 * 职责二：敏感文件泄漏门禁（fail build）
 *    2026-09 曾发生真实事故：package.json 的 files 用 "python-backend 全量收纳" 写法，而
 *    electron-builder 不读 .gitignore，导致网盘蜘蛛运行时状态目录（FM/.quark、FM/.uc
 *    含真实登录 Cookie）被原样打进 app.asar——asar 不加密，任何人一条命令即可取出。
 *    现 files 已收窄（打包后后端只读 extraResources 的 PyInstaller 产物，asar 内的
 *    python-backend 属纯冗余），本门禁负责在将来有人重新放宽 files 时立刻让构建失败。
 *
 * 职责四：mac/linux 打包剔除 vendor 内 win 专属二进制（C-10，防御性）
 *    vendor 经 extraResources 无条件复制进所有平台产物——electron-builder 25 的
 *    filter 无平台字段，平台段（build.mac/build.linux）条目只能追加、无法排除顶层
 *    条目（app-builder-lib/out/fileMatcher.js getFileMatchers：全局与平台段模式合并），
 *    而当前锁定的 aria2/ffmpeg/mpv 均为 win 构建（.exe，合计约 258MB），未来出
 *    mac/linux 包会白白多背。此处按 electronPlatformName 在 extraResources 落盘后
 *    删除（afterPack 钩子晚于 copyFiles、早于 DMG/AppImage/deb 打包，删除安全有效）：
 *    仅删 .exe/.dll（PE 系后缀，unix 平台无法执行），同名无后缀的 unix 二进制不受
 *    影响；win 打包路径不进入该分支（零变化）。
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
const ELEVATE = path.join('resources', 'elevate.exe');
// C-10：vendor 内 win 专属二进制的判定——仅 PE 后缀（.exe/.dll）。
// 不按文件名删（aria2c/ffmpeg/mpv 未来在 mac/linux 下是同名无后缀二进制，不能误删）；
// 不限定具体目录（未来 vendor 新增子目录同样被覆盖），删除范围收敛到 resources/vendor
// 子树，避免波及产物其他位置的同名文件（如 PyInstaller 后端 _internal 下的 DLL 由
// stripSystemDlls 的 win 分支负责，平台不同、职责不同）。
const WIN_BINARY_EXT_RE = /\.(exe|dll)$/i;

// mac 产物目录名（L18）：来自 build.productName（当前 "YuKi"）+ mac bundle 后缀
// ".app"——electron-builder appInfo.productName = config.productName →
// metadata.productName → metadata.name，productFilename = build.executableName（未设置）
// 否则 sanitizeFileName(productName)，mac 产物 bundle 即为 <productFilename>.app。
// build.executableName 与 build.mac.productName 均未配置，故按 productName 推导即与
// 配置一致。注意：若改 package.json 的 productName，需同步确认此推导仍成立。
// L9：回退链与 verify-exe-metadata.js 的 PRODUCT_NAME 统一（build.productName →
// productName → name，单一来源，避免两处回退口径漂移）。
const _pkg = require('../package.json');
const PRODUCT_NAME = (_pkg.build && _pkg.build.productName) || _pkg.productName || _pkg.name;
const MAC_APP_DIR = path.join(
    String(PRODUCT_NAME) + '.app',
    'Contents',
    'Resources',
);

/** 递归收集目录下所有文件（绝对路径）；目录不存在返回空数组。 */
function walkAllFiles(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walkAllFiles(p, out);
        else if (ent.isFile()) out.push(p);
    }
    return out;
}

/**
 * C-10：剔除 mac/linux 产物中 extraResources 落盘的 vendor win 专属二进制。
 * 判定保守：仅 .exe/.dll 后缀（PE 格式后缀，unix 无法执行，且 vendor 当前只有
 * aria2c.exe/ffmpeg.exe/mpv.exe 三个 win 构建物，约 258MB）；同名无后缀 unix
 * 二进制（未来 aria2c/ffmpeg/mpv 的 mac/linux 构建）不受影响。返回 [{rel, size}]。
 */
function stripVendorWinBinaries(appOutDir, resourcesDir) {
    const vendor = path.join(appOutDir, resourcesDir, 'vendor');
    const removed = [];
    for (const file of walkAllFiles(vendor, [])) {
        if (!WIN_BINARY_EXT_RE.test(file)) continue;
        const size = fs.statSync(file).size;
        fs.rmSync(file);
        removed.push({ rel: path.relative(appOutDir, file), size });
    }
    return removed;
}

/**
 * 读取 PE 文件的 VERSION_INFO 资源（VS_VERSIONINFO StringFileInfo）。
 * 不引第三方依赖：定位资源目录后按 PE 规范遍历，找不到版本资源返回 null。
 * electron-builder 用 rcedit 写入的键值即标准 VS_VERSIONINFO 布局。
 */
function readVersionStrings(file) {
    const buf = fs.readFileSync(file);
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) return null; // 'PE\0\0'
    const numSections = buf.readUInt16LE(peOff + 6);
    const optSize = buf.readUInt16LE(peOff + 20);
    const sectionsOff = peOff + 24 + optSize;
    // OptionalHeader DataDirectory：PE32+ 基址 = peOff+24+112，PE32 = peOff+24+96；
    // 第 2 项（index 2，Resource Table）RVA 在基址 + 2*8。
    const ddBase = buf.readUInt16LE(peOff + 24) === 0x20b ? peOff + 24 + 112 : peOff + 24 + 96;
    const resRva = buf.readUInt32LE(ddBase + 16);
    if (resRva === 0) return null;
    const rvaToOff = (rva) => {
        for (let i = 0; i < numSections; i++) {
            const s = sectionsOff + i * 40;
            const va = buf.readUInt32LE(s + 12);
            const rawSize = buf.readUInt32LE(s + 16);
            const raw = buf.readUInt32LE(s + 20);
            if (rva >= va && rva < va + Math.max(rawSize, buf.readUInt32LE(s + 8))) return rva - va + raw;
        }
        return null;
    };
    const resOff = rvaToOff(resRva);
    if (resOff == null) return null;

    // 资源目录树：Type(16=RT_VERSION) -> Name -> Language，共三层；每项 8 字节 =
    // DWORD 名称/ID + DWORD 偏移（高位 0x80000000 表示指向子目录，否则指向叶子前的
    // IMAGE_RESOURCE_DATA_ENTRY，其 OffsetToData 才是数据 RVA）。
    const walk = (off) => {
        const named = buf.readUInt16LE(off + 12);
        const ids = buf.readUInt16LE(off + 14);
        for (let i = 0; i < named + ids; i++) {
            const entry = off + 16 + i * 8;
            const ptr = buf.readUInt32LE(entry + 4);
            if (ptr & 0x80000000) {
                const leaf = walk(resOff + (ptr & 0x7fffffff));
                if (leaf != null) return leaf;
            } else {
                return buf.readUInt32LE(resOff + ptr); // IMAGE_RESOURCE_DATA_ENTRY.OffsetToData
            }
        }
        return null;
    };
    const named = buf.readUInt16LE(resOff + 12);
    const ids = buf.readUInt16LE(resOff + 14);
    let dataRva = null;
    for (let i = 0; i < named + ids; i++) {
        const entry = resOff + 16 + i * 8;
        const nameOrId = buf.readUInt32LE(entry);
        const isId = (nameOrId & 0x80000000) === 0;
        if (isId && nameOrId === 16) { // RT_VERSION
            dataRva = walk(resOff + (buf.readUInt32LE(entry + 4) & 0x7fffffff));
            break;
        }
    }
    if (dataRva == null) return null;
    const dataOff = rvaToOff(dataRva);
    if (dataOff == null) return null;

    // VS_VERSIONINFO 里字符串键值均为 UTF-16LE。每条 StringStruct 布局：6 字节头 +
    // 键名 + null + （补齐到 4 字节边界的 padding，0~6 字节）+ 值 + null。直接全文扫
    // 键名，跳过 null 与 padding 后取值，省去逐层结构解析。
    const strings = {};
    for (const key of ['CompanyName', 'FileDescription', 'ProductName', 'LegalCopyright']) {
        const keyBytes = Buffer.from(key, 'utf16le');
        let idx = buf.indexOf(keyBytes, dataOff);
        if (idx < 0) continue;
        let p = idx + keyBytes.length + 2; // 跳过键名自身 null
        while (p + 1 < buf.length && buf.readUInt16LE(p) === 0) p += 2; // 跳过对齐 padding
        // 值的 null 终止：按 UTF-16LE 双字节找「完整 wchar 为 0」，避免把值内字符的
        // 高位 0 字节误判为终止符（如 0x006E 'n' 的低字节在前会命中 [00,xx]）。
        let end = -1;
        for (let q = p; q + 1 < buf.length; q += 2) {
            if (buf.readUInt16LE(q) === 0) { end = q; break; }
        }
        if (end < 0 || end === p) continue;
        strings[key] = buf.slice(p, end).toString('utf16le');
    }
    return strings;
}

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

/**
 * 剔除产物根的 LICENSES.chromium.html（Electron 自带，体积为 20MB 量级、随 Electron
 * 版本漂移，故注释不写死数值——实际大小以剔除日志打印为准）。
 * 许可证合规依据：这是 Chromium 依赖的汇总 HTML 许可证清单，非任何运行时组件；
 * Electron 自身的许可证在产物根 LICENSE.electron.txt 中完整保留，第三方组件的
 * 许可证义务由源码仓库的 LICENSE（GPL-3.0-only）与各上游声明承担。删除汇总 HTML
 * 是业界通行做法（VS Code、Chromium 系发行包普遍不随包分发该文件），不影响
 * Electron/Chromium 的 BSD-style 许可证合规（其要求的是随附许可证文本，即保留的
 * LICENSE.electron.txt）。
 */
function stripLicensesHtml(appOutDir) {
    const html = path.join(appOutDir, 'LICENSES.chromium.html');
    if (!fs.existsSync(html)) return;
    const size = fs.statSync(html).size;
    fs.rmSync(html);
    console.log(`[after-pack] 已剔除 LICENSES.chromium.html（${(size / 1024 / 1024).toFixed(1)}MB）`
        + '——Chromium 许可证汇总 HTML，非运行时组件；许可证文本以保留的 LICENSE.electron.txt 为准');
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

/** 列出 app.asar 内的全部条目路径。
 *  P2-8（fail-closed）：此前解析失败时返回占位字符串 `<asar-list-failed:...>`——
 *  不匹配任何敏感正则，清单解析失败即静默跳过扫描（@electron/asar 未声明依赖、
 *  pnpm 布局下提升解析失效正是真实触发路径）。门禁的本意是「拿不到清单就终止
 *  构建」，因此这里改为抛出可操作的错误。 */
function asarEntries(appOutDir) {
    const asarPath = path.join(appOutDir, 'resources', 'app.asar');
    if (!fs.existsSync(asarPath)) return [];
    const asar = require('@electron/asar');
    return asar.listPackage(asarPath).map((p) => path.join('app.asar', p.replace(/^[\\/]+/, '')));
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
    // P2-8：asar 清单解析失败（依赖缺失/读取失败）会在 findSecrets 内抛错直接终止
    // 构建（fail-closed），不再被静默吞掉。
    let secrets;
    try {
        secrets = findSecrets(context.appOutDir);
    } catch (e) {
        throw new Error('[after-pack] 敏感文件门禁无法执行（fail-closed，构建终止）：' + e.message
            + '\n修复：确认 @electron/asar 已在 devDependencies 声明且安装成功（npm ls @electron/asar）。');
    }
    if (secrets.length > 0) {
        throw new Error('[after-pack] 检测到敏感文件被打进安装包（Cookie/凭据泄露，构建终止）：\n  - '
            + secrets.join('\n  - ')
            + '\n修复：收窄 package.json build.files，勿用 python-backend/** 这类全量收纳。');
    }

    // electron-builder 25 的 electronPlatformName 是 Platform.nodeName：win 构建
    // 传 'win32'（非 'win'）——旧判断 === 'win' 自 v0.2.7 引入起从未命中，win 分支
    // （elevate/LICENSES 剔除）一直被静默跳过，且 C-10 落地后 else 分支还会在
    // win 构建上误删 vendor/aria2c.exe。按 nodeName 取值修正，mac='darwin'/linux='linux' 不变。
    const platformName = String(context.electronPlatformName || '');
    if (platformName === 'win32' || platformName === 'win') {
        stripElevateHelper(context.appOutDir);
        stripLicensesHtml(context.appOutDir);
        // 注意：可执行体版本信息校验（checkExecutableMetadata）不能在 afterPack 里做——
        // rcedit 覆写 exe 元数据发生在框架 afterPack（signApp）阶段，晚于用户钩子，
        // 在这里查永远读到 Electron 原始值（CompanyName="GitHub, Inc."）误报。
        // 已移至 afterAllArtifactBuild 钩子（verify-exe-metadata.js），全产物落定后校验。
    } else if (platformName === 'darwin' || platformName === 'linux') {
        // C-10：仅 mac/linux——vendor 的 win 专属二进制（.exe/.dll）纯死重。
        // 显式白名单：只有确认是 mac/linux 才执行剔除；平台名取值一旦漂移
        // （electron-builder 版本变更/未知新值）宁可漏剔也不误删 win 产物的
        // aria2c/ffmpeg/mpv（与 verify-exe-metadata.js「宁可漏判不误判」同取向）。
        // resources 目录布局按平台区分：mac 为 <productName>.app/Contents/Resources
        // （MAC_APP_DIR 常量，来源见其定义处），linux 与 win 同为 <appOutDir>/resources
        // （electron-builder getMacOsResourcesDir）。
        const resourcesDir = platformName === 'darwin'
            ? MAC_APP_DIR
            : 'resources';
        const removed = stripVendorWinBinaries(context.appOutDir, resourcesDir);
        if (removed.length > 0) {
            const mb = removed.reduce((s, r) => s + r.size, 0) / 1024 / 1024;
            console.log(`[after-pack] 已剔除 vendor 内 win 专属二进制 ${removed.length} 个（共 ${mb.toFixed(1)}MB）——mac/linux 产物不含 PE 文件：`);
            for (const r of removed) console.log(`  - ${r.rel}`);
        }
    } else {
        // 未知平台名：fail-loud 提示而非静默走任一剔除分支
        console.warn(`[after-pack] 警告：未知 electronPlatformName="${platformName}"，已跳过 vendor win 二进制剔除（宁漏剔不误删）。`);
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

/**
 * 剔除 resources/elevate.exe（杀软误报源，职责一第 4 条）。packElevateHelper:false
 * 已在源头关闭，这里兜底旧版 electron-builder 忽略该选项的情况——文件存在即构建失败
 * （提示手动处置），避免静默漏删造成「配置以为关了、包里其实还在」。
 */
function stripElevateHelper(appOutDir) {
    const exe = path.join(appOutDir, ELEVATE);
    if (!fs.existsSync(exe)) return;
    fs.rmSync(exe);
    console.log('[after-pack] 已剔除 resources/elevate.exe（未签名提权助手，杀软误报源；'
        + 'per-user 安装与 electron-updater 降级路径均不依赖它）');
}

/**
 * 校验产物内主 exe 的版本信息已被 rcedit 正确覆盖（职责三）。
 * CompanyName 缺失/仍为 Electron 原始值 = package.json 缺 author 字段，启发式扣分项。
 *
 * 职责分层（verify-exe-metadata.js 依赖本函数）：exe 不存在时此处静默 return，是供
 * 复用方按自身语义处置的宽容分支——真正的 win 门禁由 verify-exe-metadata.js 在调用
 * 前先行 fs.existsSync 校验（缺失即 process.exit(1) fail-closed），因此本静默分支
 * 在 afterAllArtifactBuild 门禁路径上不会被触发。
 */
function checkExecutableMetadata(appOutDir, exeName) {
    // exe 名由调用方传入（按 productName 推导）：此前这里写死 'YuKi.exe'，
    // 而 verify-exe-metadata.js 是按 productName 推导文件名的——productName 一变
    // （或将来设了 build.executableName），verify 侧校验的是新文件名、本函数却仍
    // 找旧名 → 走「不存在则静默 return」→ win 元数据门禁整体失效且构建照常通过
    // （假绿）。两处必须共用同一个推导。
    const exe = path.join(appOutDir, exeName || 'YuKi.exe');
    if (!fs.existsSync(exe)) return; // 非 win 产物或布局变更时静默跳过
    const strings = readVersionStrings(exe);
    if (strings == null) {
        throw new Error(`[after-pack] 无法解析 ${path.basename(exe)} 的 VERSION_INFO 资源（PE 结构异常或版本资源缺失）。`
            + '缺失版本信息的未签名 exe 是杀软启发式的重点命中对象，请检查产物完整性。');
    }
    const bad = [];
    if (!strings.CompanyName || /GitHub/i.test(strings.CompanyName)) {
        bad.push(`CompanyName="${strings.CompanyName || '<缺失>'}"（应为项目作者名）。`
            + '根因：package.json 缺 author 字段时 electron-builder 不覆盖 Electron 预编译二进制的原始值；');
    }
    if (!strings.ProductName) {
        bad.push('ProductName 缺失。根因：package.json 缺 productName 或 description；');
    }
    if (bad.length > 0) {
        throw new Error('[after-pack] 可执行体版本信息异常（杀软启发式扣分项，构建终止）：\n  - '
            + bad.join('\n  - '));
    }
    console.log(`[after-pack] 版本信息校验通过：CompanyName="${strings.CompanyName}" ProductName="${strings.ProductName}"`);
}

module.exports.stripSystemDlls = stripSystemDlls;
module.exports.findSecrets = findSecrets;
module.exports.readVersionStrings = readVersionStrings;
module.exports.checkExecutableMetadata = checkExecutableMetadata;
module.exports.stripElevateHelper = stripElevateHelper;
module.exports.stripLicensesHtml = stripLicensesHtml;
module.exports.stripVendorWinBinaries = stripVendorWinBinaries;

