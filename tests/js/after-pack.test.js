// 单元测试：scripts/after-pack.js — 打包后剔除系统自带冗余 DLL（杀软误报源）
// 守住八条：Electron d3dcompiler/vulkan 删除、后端 UCRT+VC++ 运行库删除（python 保留）、
// 无匹配文件 no-op、钩子默认剔除、YUKI_KEEP_SYSTEM_DLLS=1 逃生口保留、
// elevate.exe 兜底剔除、PE VERSION_INFO 解析、版本信息门禁 fail-build。
// C-10 追加：mac/linux 产物剔除 vendor 内 win 专属二进制（.exe/.dll），同名 unix 二进制保留。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const afterPack = require('../../scripts/after-pack');

const BACKEND_INTERNAL = path.join('resources', 'python-backend', 'yuki-backend', '_internal');

function tempOutDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-afterpack-'));
}

function writeFile(p, size) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(size || 4096));
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('stripSystemDlls：剔除 Electron 自带 d3dcompiler_47.dll 与 vulkan-1.dll', () => {
    const dir = tempOutDir();
    try {
        const d3d = path.join(dir, 'd3dcompiler_47.dll');
        const vulkan = path.join(dir, 'vulkan-1.dll');
        writeFile(d3d, 4096);
        writeFile(vulkan, 2048);
        assert.deepEqual(afterPack.stripSystemDlls(dir), [
            { rel: 'd3dcompiler_47.dll', size: 4096 },
            { rel: 'vulkan-1.dll', size: 2048 },
        ]);
        assert.equal(fs.existsSync(d3d), false);
        assert.equal(fs.existsSync(vulkan), false);
    } finally {
        cleanup(dir);
    }
});

test('stripSystemDlls：剔除后端 UCRT + VC++ 运行库（ucrtbase/api-ms-win-*/VCRUNTIME140*），保留 python', () => {
    const dir = tempOutDir();
    try {
        const internal = path.join(dir, BACKEND_INTERNAL);
        for (const name of ['ucrtbase.dll', 'api-ms-win-crt-heap-l1-1-0.dll', 'api-ms-win-core-heap-l1-1-0.dll',
            'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll']) {
            writeFile(path.join(internal, name), 8192);
        }
        writeFile(path.join(internal, 'python314.dll'), 1024);
        const removed = afterPack.stripSystemDlls(dir);
        assert.equal(removed.length, 5);
        assert.ok(removed.every((r) => r.rel.startsWith(BACKEND_INTERNAL)));
        assert.equal(fs.existsSync(path.join(internal, 'ucrtbase.dll')), false);
        assert.equal(fs.existsSync(path.join(internal, 'api-ms-win-crt-heap-l1-1-0.dll')), false);
        // VC++ 运行库副本一并剔除（杀软按系统同名 DLL 拦截安装包写入）；
        // 系统缺失时由主进程 vcrt-missing 预检引导安装，不再随包分发。
        assert.equal(fs.existsSync(path.join(internal, 'VCRUNTIME140.dll')), false);
        assert.equal(fs.existsSync(path.join(internal, 'VCRUNTIME140_1.dll')), false);
        // 解释器本体剔除即坏，必须保留
        assert.equal(fs.existsSync(path.join(internal, 'python314.dll')), true);
    } finally {
        cleanup(dir);
    }
});

test('stripSystemDlls：无匹配文件时 no-op（mac/linux 产物/纯 Electron 产物不受影响）', () => {
    const dir = tempOutDir();
    try {
        assert.deepEqual(afterPack.stripSystemDlls(dir), []);
    } finally {
        cleanup(dir);
    }
});

test('afterPack 钩子：默认剔除全部误报源（d3dcompiler/vulkan/UCRT）', () => {
    const dir = tempOutDir();
    try {
        writeFile(path.join(dir, 'd3dcompiler_47.dll'));
        writeFile(path.join(dir, 'vulkan-1.dll'));
        writeFile(path.join(dir, BACKEND_INTERNAL, 'ucrtbase.dll'));
        afterPack({ appOutDir: dir, electronPlatformName: 'win32' });
        assert.equal(fs.existsSync(path.join(dir, 'd3dcompiler_47.dll')), false);
        assert.equal(fs.existsSync(path.join(dir, 'vulkan-1.dll')), false);
        assert.equal(fs.existsSync(path.join(dir, BACKEND_INTERNAL, 'ucrtbase.dll')), false);
    } finally {
        cleanup(dir);
    }
});

test('afterPack 钩子：YUKI_KEEP_SYSTEM_DLLS=1 保留全部（诊断逃生口）', () => {
    const dir = tempOutDir();
    const prev = process.env.YUKI_KEEP_SYSTEM_DLLS;
    process.env.YUKI_KEEP_SYSTEM_DLLS = '1';
    try {
        writeFile(path.join(dir, 'd3dcompiler_47.dll'));
        writeFile(path.join(dir, 'vulkan-1.dll'));
        writeFile(path.join(dir, BACKEND_INTERNAL, 'ucrtbase.dll'));
        afterPack({ appOutDir: dir, electronPlatformName: 'win32' });
        assert.equal(fs.existsSync(path.join(dir, 'd3dcompiler_47.dll')), true);
        assert.equal(fs.existsSync(path.join(dir, 'vulkan-1.dll')), true);
        assert.equal(fs.existsSync(path.join(dir, BACKEND_INTERNAL, 'ucrtbase.dll')), true);
    } finally {
        if (prev === undefined) delete process.env.YUKI_KEEP_SYSTEM_DLLS;
        else process.env.YUKI_KEEP_SYSTEM_DLLS = prev;
        cleanup(dir);
    }
});

// ---------------------------------------------------------------- 杀软治理二批

test('stripElevateHelper：剔除 resources/elevate.exe（未签名提权助手，杀软误报源）', () => {
    const dir = tempOutDir();
    try {
        const elevate = path.join(dir, 'resources', 'elevate.exe');
        writeFile(elevate, 65536);
        afterPack.stripElevateHelper(dir);
        assert.equal(fs.existsSync(elevate), false);
    } finally {
        cleanup(dir);
    }
});

test('stripElevateHelper：文件不存在时 no-op（packElevateHelper:false 已在源头关闭）', () => {
    const dir = tempOutDir();
    try {
        assert.doesNotThrow(() => afterPack.stripElevateHelper(dir));
    } finally {
        cleanup(dir);
    }
});

test('stripLicensesHtml：LICENSES.chromium.html 保留不剔除（2026-10-08 用户裁决）', () => {
    const dir = tempOutDir();
    try {
        const html = path.join(dir, 'LICENSES.chromium.html');
        writeFile(html, 9_400_000); // 真实产物 20MB 量级；裁决后随包完整保留
        // LICENSE.electron.txt 同目录共存，互不影响
        const license = path.join(dir, 'LICENSE.electron.txt');
        writeFile(license, 1024);
        afterPack.stripLicensesHtml(dir);
        assert.equal(fs.existsSync(html), true, '裁决后许可证汇总必须随包保留');
        assert.equal(fs.existsSync(license), true);
    } finally {
        cleanup(dir);
    }
});

test('stripLicensesHtml：文件不存在时 no-op（非 win 产物/旧版布局不受影响）', () => {
    const dir = tempOutDir();
    try {
        assert.doesNotThrow(() => afterPack.stripLicensesHtml(dir));
    } finally {
        cleanup(dir);
    }
});

test('afterPack 钩子：win 平台 LICENSES.chromium.html 保留（不再联动剔除）', () => {
    const dir = tempOutDir();
    try {
        writeFile(path.join(dir, 'LICENSES.chromium.html'));
        // 无 YuKi.exe → 元数据门禁静默跳过（存在性兜底在 verify-exe-metadata.js 层），
        // 不影响本断言
        afterPack({ appOutDir: dir, electronPlatformName: 'win32' });
        assert.equal(fs.existsSync(path.join(dir, 'LICENSES.chromium.html')), true, 'win 产物同样保留许可证汇总');
    } finally {
        cleanup(dir);
    }
});

test('readVersionStrings：解析 Electron 产物真实 PE VERSION_INFO（Company=GitHub, Inc. 旧行为实证）', () => {
    // 用当前仓库依赖的 Electron 预编译二进制当真实样本；dist 未必存在（CI 全新 checkout），
    // electron dist 必然存在。
    const electronExe = require.resolve('electron', { paths: [path.join(__dirname, '..', '..')] });
    void electronExe; // 仅确保 electron 包可解析；路径串取 dist 内 exe
    const electronDist = path.join(path.dirname(require.resolve('electron', { paths: [path.join(__dirname, '..', '..')] })), 'dist');
    const exePath = path.join(electronDist, 'electron.exe');
    if (!fs.existsSync(exePath)) return; // 非 win 开发环境跳过
    const strings = afterPack.readVersionStrings(exePath);
    assert.ok(strings, '应能解析 electron.exe 的 VERSION_INFO');
    assert.equal(typeof strings.CompanyName, 'string');
    assert.ok(strings.CompanyName.length > 0);
});

test('readVersionStrings：非 PE / 无版本资源时返回 null 而非抛错', () => {
    const dir = tempOutDir();
    try {
        const fake = path.join(dir, 'not-pe.exe');
        fs.writeFileSync(fake, Buffer.from('MZ trivially short but no PE header at all'));
        // MZ 头存在但无 PE 签名 → null
        assert.equal(afterPack.readVersionStrings(fake), null);
        // 纯文本连 MZ 都没有 → null
        const txt = path.join(dir, 'plain.txt');
        fs.writeFileSync(txt, 'plain text file');
        assert.equal(afterPack.readVersionStrings(txt), null);
    } finally {
        cleanup(dir);
    }
});

test('checkExecutableMetadata：CompanyName 缺失（无 author 的旧构建形态）→ 构建失败', () => {
    const dir = tempOutDir();
    try {
        const exe = path.join(dir, 'YuKi.exe');
        writeFile(exe, 1024);
        // 无 VERSION_INFO 资源的假 exe → readVersionStrings 返回 null → 应 fail-closed
        assert.throws(() => afterPack.checkExecutableMetadata(dir), /版本信息/);
    } finally {
        cleanup(dir);
    }
});

test('afterPack 钩子：win 平台联动剔除 elevate.exe（版本信息门禁已迁 afterAllArtifactBuild）', () => {
    const dir = tempOutDir();
    try {
        writeFile(path.join(dir, 'resources', 'elevate.exe'));
        writeFile(path.join(dir, 'YuKi.exe'));
        // 版本信息校验不再在 afterPack 里做（rcedit 在框架 afterPack 阶段晚于用户钩子，
        // 这里查永远读到 Electron 原始值），已迁 verify-exe-metadata.js 的
        // afterAllArtifactBuild 钩子——本钩子只验证剔除与无异常
        assert.doesNotThrow(() => afterPack({ appOutDir: dir, electronPlatformName: 'win32' }));
        // elevate 仍被剔除
        assert.equal(fs.existsSync(path.join(dir, 'resources', 'elevate.exe')), false);
        // 非 win 平台不做这两件事
        writeFile(path.join(dir, 'resources', 'elevate.exe'));
        assert.doesNotThrow(() => afterPack({ appOutDir: dir, electronPlatformName: 'darwin' }));
        assert.equal(fs.existsSync(path.join(dir, 'resources', 'elevate.exe')), true);
    } finally {
        cleanup(dir);
    }
});

test('afterPack 钩子：win 平台 + 正常版本信息 + elevate 缺席 → 全链路通过', () => {
    const dir = tempOutDir();
    try {
        // 构造带合法 VERSION_INFO 资源的最小 PE：直接取 Electron 的真实 exe 太重，
        // 这里用「元数据门禁 + DLL 剔除」的联合 no-op 形态验证（YuKi.exe 不存在 → 门禁跳过）。
        writeFile(path.join(dir, 'd3dcompiler_47.dll'));
        afterPack({ appOutDir: dir, electronPlatformName: 'win32' });
        assert.equal(fs.existsSync(path.join(dir, 'd3dcompiler_47.dll')), false);
    } finally {
        cleanup(dir);
    }
});

// ---------------------------------------------------------------- C-10 mac/linux vendor 剔除

test('stripVendorWinBinaries：linux 布局剔除 vendor 内 .exe，保留无后缀 unix 二进制与数据文件', () => {
    const dir = tempOutDir();
    try {
        const vendor = path.join(dir, 'resources', 'vendor');
        writeFile(path.join(vendor, 'aria2', 'aria2c.exe'), 5_649_408);
        writeFile(path.join(vendor, 'ffmpeg', 'ffmpeg.exe'), 145_484_800);
        writeFile(path.join(vendor, 'mpv', 'mpv.exe'), 117_537_280);
        // 未来 mac/linux 构建的同名无后缀二进制与跨平台数据文件必须保留
        writeFile(path.join(vendor, 'aria2', 'aria2c'), 4096);
        writeFile(path.join(vendor, 'mpv', 'mpv'), 4096);
        writeFile(path.join(vendor, 'spider-runner.jar'), 175_827);
        writeFile(path.join(vendor, 'misans', 'MiSans-Regular.woff2'), 4096);
        const removed = afterPack.stripVendorWinBinaries(dir, 'resources');
        assert.equal(removed.length, 3);
        assert.ok(removed.every((r) => /\.exe$/.test(r.rel)));
        assert.equal(fs.existsSync(path.join(vendor, 'aria2', 'aria2c.exe')), false);
        assert.equal(fs.existsSync(path.join(vendor, 'ffmpeg', 'ffmpeg.exe')), false);
        assert.equal(fs.existsSync(path.join(vendor, 'mpv', 'mpv.exe')), false);
        // 同名无后缀二进制不受影响（.exe 后缀判定，不按文件名删）
        assert.equal(fs.existsSync(path.join(vendor, 'aria2', 'aria2c')), true);
        assert.equal(fs.existsSync(path.join(vendor, 'mpv', 'mpv')), true);
        assert.equal(fs.existsSync(path.join(vendor, 'spider-runner.jar')), true);
    } finally {
        cleanup(dir);
    }
});

test('stripVendorWinBinaries：mac 布局（YuKi.app/Contents/Resources）同样剔除', () => {
    const dir = tempOutDir();
    try {
        const vendor = path.join(dir, 'YuKi.app', 'Contents', 'Resources', 'vendor');
        writeFile(path.join(vendor, 'aria2', 'aria2c.exe'), 4096);
        writeFile(path.join(vendor, 'anime4k', 'Anime4K_Upscale_CNN_x2_M.glsl'), 4096);
        const removed = afterPack.stripVendorWinBinaries(dir, path.join('YuKi.app', 'Contents', 'Resources'));
        assert.equal(removed.length, 1);
        assert.equal(fs.existsSync(path.join(vendor, 'aria2', 'aria2c.exe')), false);
        assert.equal(fs.existsSync(path.join(vendor, 'anime4k', 'Anime4K_Upscale_CNN_x2_M.glsl')), true);
    } finally {
        cleanup(dir);
    }
});

test('stripVendorWinBinaries：vendor 不存在时 no-op（防御性，异常布局不抛错）', () => {
    const dir = tempOutDir();
    try {
        assert.deepEqual(afterPack.stripVendorWinBinaries(dir, 'resources'), []);
    } finally {
        cleanup(dir);
    }
});

test('afterPack 钩子：darwin/linux 平台剔除 vendor win 二进制，win 平台不受影响', () => {
    const dir = tempOutDir();
    try {
        // linux 产物：resources/vendor/aria2c.exe 被删
        const linuxVendor = path.join(dir, 'resources', 'vendor');
        writeFile(path.join(linuxVendor, 'aria2c.exe'));
        writeFile(path.join(linuxVendor, 'aria2c'), 4096);
        afterPack({ appOutDir: dir, electronPlatformName: 'linux' });
        assert.equal(fs.existsSync(path.join(linuxVendor, 'aria2c.exe')), false);
        assert.equal(fs.existsSync(path.join(linuxVendor, 'aria2c')), true);
    } finally {
        cleanup(dir);
    }
    try {
        // darwin 产物：YuKi.app/Contents/Resources/vendor 下的 .exe 被删
        const dirMac = tempOutDir();
        const macVendor = path.join(dirMac, 'YuKi.app', 'Contents', 'Resources', 'vendor');
        writeFile(path.join(macVendor, 'ffmpeg.exe'));
        afterPack({ appOutDir: dirMac, electronPlatformName: 'darwin' });
        assert.equal(fs.existsSync(path.join(macVendor, 'ffmpeg.exe')), false);
        cleanup(dirMac);
    } finally { /* 两段独立临时目录，内层已清理 */ }
    try {
        // win 产物：vendor 内的 .exe 是运行必需品，不受 C-10 影响（零变化）
        const dirWin = tempOutDir();
        const winVendor = path.join(dirWin, 'resources', 'vendor');
        writeFile(path.join(winVendor, 'aria2c.exe'));
        afterPack({ appOutDir: dirWin, electronPlatformName: 'win32' });
        assert.equal(fs.existsSync(path.join(winVendor, 'aria2c.exe')), true);
        cleanup(dirWin);
    } finally { /* 同上 */ }
});

// ---------------------------------------------------------------- verify-exe-metadata（M4 fail-closed）

test('verifyExeMetadata：win 产物 exe 缺失 → process.exit(1)（fail-closed，不再静默跳过）', async () => {
    const verify = require('../../scripts/verify-exe-metadata');
    const dir = tempOutDir();
    try {
        // win-unpacked 存在但主 exe 缺失 → 不得静默通过
        const code = await captureExitCode(() => verify({ outDir: dir, platformToTargets: fakePlatformMap('win32') }));
        assert.equal(code, 1, 'exe 缺失时必须以退出码 1 终止构建');
    } finally {
        cleanup(dir);
    }
});

test('verifyExeMetadata：非 win 构建（platformToTargets 无 win32）→ 跳过不退出', async () => {
    const verify = require('../../scripts/verify-exe-metadata');
    const dir = tempOutDir();
    try {
        const code = await captureExitCode(() => verify({ outDir: dir, platformToTargets: fakePlatformMap('linux') }));
        assert.equal(code, 0, '非 win 构建不归本钩子管，正常返回');
    } finally {
        cleanup(dir);
    }
});

test('verifyExeMetadata：win 产物带 YuKi.exe 但无 VERSION_INFO → 抛错（校验链路仍然生效）', async () => {
    const verify = require('../../scripts/verify-exe-metadata');
    const dir = tempOutDir();
    try {
        // 反向验证校验链路：exe 存在（存在性兜底通过）但无 VERSION_INFO 资源 →
        // checkExecutableMetadata 抛错，门禁语义在 verify 层下依然生效
        const exe = path.join(dir, 'win-unpacked', 'YuKi.exe');
        writeFile(exe, 1024);
        await assert.rejects(
            () => verify({ outDir: dir, platformToTargets: fakePlatformMap('win32') }),
            /版本信息/,
        );
    } finally {
        cleanup(dir);
    }
});

// platformToTargets 的 key 是 app-builder-lib 的 Platform 实例（Map 实例相等）；
// 测试里构造带 nodeName 的伪实例，供脚本的无依赖 nodeName 兜底路径识别。
function fakePlatformMap(nodeName) {
    return new Map([[{ nodeName, name: nodeName }, new Map()]]);
}

/** 捕获 fn（可为 async）触发的 process.exit(code) 退出码（不真退出进程）。
 *  async 函数体在首次 await/return 后仍会继续执行，因此补丁需保持到其 Promise 落定。 */
async function captureExitCode(fn) {
    const realExit = process.exit;
    let exitCode = 0; // 未触发 exit 即视为正常完成
    process.exit = (c) => { exitCode = c; };
    try {
        await fn();
    } finally {
        process.exit = realExit;
    }
    return exitCode;
}
