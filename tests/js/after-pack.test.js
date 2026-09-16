// 单元测试：scripts/after-pack.js — 打包后剔除系统自带冗余 DLL（杀软误报源）
// 守住五条：Electron d3dcompiler/vulkan 删除、后端 UCRT+VC++ 运行库删除（python 保留）、
// 无匹配文件 no-op、钩子默认剔除、YUKI_KEEP_SYSTEM_DLLS=1 逃生口保留。
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
