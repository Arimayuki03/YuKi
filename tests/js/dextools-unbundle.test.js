'use strict';
// 杀软误报治理（Q9，2026-09-26）：dex-tools / dexdeps 移出安装包。
// 根因：dex-tools 的 d2j-*.bat 命名（apk-sign/decrypt-string/baksmali 等）是杀软
// 「HackTool/Riskware」类静态启发式的教科书特征——即使从不运行，安装器把
// 300MB 文件树展开到用户可写目录时也会被全盘扫描命中（v0.2.5 安装被拦的
// 具体诱因之一）。
// 方案：extraResources 排除 + 双获取途径（download-binaries.js dextools 槽位 /
// jar_bridge 运行时按需下载到缓存目录）。本文件锁定三件事：
// 1) package.json 的排除 filter 存在且语义正确；
// 2) download-binaries.js 的 dextools 槽位存在且带 sha256 强校验（不进 all）；
// 3) jar_bridge 的按需解析顺序（vendor 优先 → 缓存目录，缺失不炸、抛契约错误）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('package.json：extraResources 排除 dex-tools 与 dexdeps（安装包不再携带 HackTool 特征）', () => {
    const pkg = JSON.parse(read('package.json'));
    const vendorRes = (pkg.build && pkg.build.extraResources || [])
        .find((r) => r.from === 'vendor');
    assert.ok(vendorRes, '应存在 vendor extraResources 配置');
    const filter = vendorRes.filter || [];
    // electron-builder filter 语义：!pattern 为排除；目录排除需同时覆盖「目录本身」与「目录内所有文件」
    for (const excl of ['!dex-tools/**', '!dex-tools', '!dexdeps/**', '!dexdeps']) {
        assert.ok(filter.includes(excl), `vendor filter 应含 ${excl}（实际：${JSON.stringify(filter)}）`);
    }
});

test('download-binaries.js：dextools 槽位存在，zip 与 dexdeps 全部 sha256 锁定', () => {
    const src = read('scripts/download-binaries.js');
    // 槽位与导出
    assert.ok(/async function downloadDextools\(/.test(src), '应有 downloadDextools 槽位');
    assert.ok(/async function downloadDexdeps\(/.test(src), '应有 downloadDexdeps 槽位');
    assert.match(src, /module\.exports = \{[^}]*downloadDextools[^}]*\}/, '应导出 downloadDextools（主进程一键补装可复用）');
    // zip 强校验（对 pxb1988/dex2jar v2.4 官方 release 实证）
    assert.match(src, /DEX_TOOLS_SHA256 = '([a-f0-9]{64})'/, 'dex-tools zip 应锁定 sha256');
    assert.match(src, /fetchVerified\(\[ghProxy\(DEX_TOOLS_URL\), DEX_TOOLS_URL\]/,
        '下载应走镜像+直连双源并逐候选校验');
    // dexdeps：五个 jar 逐个锁 sha256（Maven Central 官方产物）
    const depCount = (src.match(/'[a-z0-9-]+\.jar',\s*'[^']+',\s*\n\s*'[a-f0-9]{64}'/g) || []).length;
    assert.ok(depCount >= 5, `dexdeps 五个 jar 应逐一锁定 sha256（实际 ${depCount} 个）`);
    // 不进 all：按需获取（CI 打包不预置），只有显式 dextools 参数才拉。
    // 检查方式：main() 的 all 分支行列表里没有 dextools 槐位。
    const mainBody = (src.match(/async function main\(\) \{[\s\S]*?\n\}/) || [''])[0];
    const allLines = mainBody.split('\n').filter((l) => l.includes("=== 'all'"));
    assert.ok(allLines.length >= 1, '应存在 all 分支');
    assert.ok(allLines.every((l) => !l.includes('Dextools') && !l.includes('dextools')),
        `all 分支不得包含 dextools（按需获取语义）：${allLines.join(' | ')}`);
    assert.match(src, /what === 'dextools'/, '应支持显式 dextools 参数');
});

test('jar_bridge.py：vendor 优先 → 缓存目录按需下载 → 失败抛契约错误（不静默不崩溃）', () => {
    const src = read('python-backend/jar_bridge.py');
    // 解析函数与顺序
    assert.match(src, /def _dex2jar_jar\(\)/, '应有 _dex2jar_jar 解析函数');
    assert.match(src, /def _dexdeps_dir\(\)/, '应有 _dexdeps_dir 解析函数');
    // 解析顺序：_dex2jar_jar 函数体内先 vendor 后按需下载
    const fnBody = (src.match(/def _dex2jar_jar\(\):[\s\S]*?(?=\ndef |\nclass )/) || [''])[0];
    assert.ok(fnBody.includes('_locate_dex2jar(hoststate.vendor_dir())'),
        '_dex2jar_jar 应先解析 vendor 目录');
    assert.ok(fnBody.includes('_download_dextools_on_demand'),
        '_dex2jar_jar vendor 缺失时应触发按需下载');
    assert.ok(fnBody.indexOf('_locate_dex2jar(hoststate.vendor_dir())')
        < fnBody.indexOf('_download_dextools_on_demand()'),
        '解析顺序应为 vendor 优先、按需下载兜底');
    // 下载：sha256 校验 + 镜像回退 + 线程安全
    assert.match(src, /DEX_TOOLS_SHA256/, '按需下载应校验 sha256');
    assert.match(src, /DEX_TOOLS_URLS = \[/, '应有多源候选（直连+镜像）');
    assert.match(src, /_dex_tools_lock = threading\.Lock\(\)/, '下载应有线程锁（并发站点共享）');
    // 缺失路径：仍走 RuntimeContractError 契约（原有语义不变），不静默返回坏 jar
    assert.match(src, /dex2jar tools not found for converting DEX jar/,
        '下载失败时应抛 L3_RUNTIME_INIT_FAILED 契约错误');
    // 消费点改造：转换与 deps 目录都经解析函数（不再用模块级常量）
    assert.ok(!/DEX2JAR_JAR\s*=/.test(src), '模块级 DEX2JAR_JAR 常量应删除（改为函数解析）');
    assert.ok(!/DEXDEPS_DIR\s*=/.test(src), '模块级 DEXDEPS_DIR 常量应删除（改为函数解析）');
});
