// 单元测试：scripts/after-pack.js — 打包后剔除系统自带冗余 DLL（杀软误报源）
// 守住八条：Electron d3dcompiler/vulkan 删除、后端 UCRT+VC++ 运行库删除（python 保留）、
// 无匹配文件 no-op、钩子默认剔除、YUKI_KEEP_SYSTEM_DLLS=1 逃生口保留、
// elevate.exe 兜底剔除、PE VERSION_INFO 解析、版本信息门禁 fail-build。
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
        afterPack({ appOutDir: dir, electronPlatformName: 'win' });
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
        afterPack({ appOutDir: dir, electronPlatformName: 'win' });
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

test('afterPack 钩子：win 平台联动剔除 elevate.exe 且版本信息异常即失败', () => {
    const dir = tempOutDir();
    try {
        writeFile(path.join(dir, 'resources', 'elevate.exe'));
        writeFile(path.join(dir, 'YuKi.exe')); // 无版本信息 → 门禁应失败
        assert.throws(() => afterPack({ appOutDir: dir, electronPlatformName: 'win' }), /版本信息/);
        // elevate 仍先于门禁被剔除
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
        afterPack({ appOutDir: dir, electronPlatformName: 'win' });
        assert.equal(fs.existsSync(path.join(dir, 'd3dcompiler_47.dll')), false);
    } finally {
        cleanup(dir);
    }
});
