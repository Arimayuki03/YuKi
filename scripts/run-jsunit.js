#!/usr/bin/env node
// run-jsunit.js — 跨平台执行 node --test，避免 shell glob / Node 版本差异
// 背景：CI Windows 上 `node --test tests/js/*.test.js` 会报 Could not find 'D:\a\YuKi\YuKi\tests\js\*.test.js'
// 原因：cmd/PowerShell 不展开 glob，且 Node 20/24 对 glob/目录参数行为不一致
// 方案：用 fs 枚举显式文件列表，再 spawn node --test，完全不依赖 shell 展开

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'tests', 'js');
let entries;
try {
  entries = fs.readdirSync(dir, { withFileTypes: true });
} catch (e) {
  console.error(`[run-jsunit] 无法读取 ${dir}: ${e.message}`);
  process.exit(1);
}

const files = entries
  .filter((d) => d.isFile() && d.name.endsWith('.test.js'))
  .map((d) => path.join(dir, d.name))
  .sort();

if (files.length === 0) {
  console.error(`[run-jsunit] 未找到测试文件: ${dir}/*.test.js`);
  process.exit(1);
}

console.log(`[run-jsunit] 发现 ${files.length} 个测试文件，执行 node --test ...`);
// 捕获输出以便解析汇总行（stdio 仍逐行透传到本进程 stdout/stderr，日志观感不变）。
// 动机：环境不满足而跳过的用例如果以「通过」形态计入，全绿就成了假信号——
// 解析 skipped 并显式告警，让覆盖缺口在 CI 日志里一眼可见。
// maxBuffer 必须显式放大：改为捕获输出后，spawnSync 默认只有 1MB，node --test 的
// TAP 汇总在 500+ 用例下可能超限 → 子进程被 kill、result.status 变 null → 误判失败。
// 原先的 stdio:'inherit' 没有这个上限，所以这一步是本次改动引入的新约束。
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (result.error) {
    console.error(`[run-jsunit] 子进程执行异常: ${result.error.message}`);
    process.exit(1);
}
const out = (result.stdout || '') + (result.stderr || '');
if (out) process.stdout.write(out);

const skipped = Number((/\bskipped\s+(\d+)/.exec(out) || [])[1] || 0);
const todo = Number((/\btodo\s+(\d+)/.exec(out) || [])[1] || 0);
if (skipped > 0) {
    console.warn(`[run-jsunit] [warn] 有 ${skipped} 个用例被跳过：通过数不含它们，`
        + '但被跳过意味着这部分行为本次完全没有被验证（常见原因：vendor 二进制缺失 / 非目标平台）。');
}
if (todo > 0) console.warn(`[run-jsunit] [warn] 有 ${todo} 个 todo 用例（尚未实现）`);
process.exit(result.status ?? 1);
