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
// 超时上限（毫秒）：任一用例挂死时强杀子进程，防止 CI 永久挂起。
// 默认 600s（全量 500+ 用例实测远小于此）；可用 JSUNIT_TIMEOUT_MS 环境变量覆盖。
const timeoutMs = Number(process.env.JSUNIT_TIMEOUT_MS) || 600000;
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
if (result.error && (result.error.code === 'ETIMEDOUT' || result.error.code === 'ABORT_ERR')) {
    // Node v24 实测超时为 ETIMEDOUT（signal SIGTERM / status null）；旧版曾有 ABORT_ERR
    console.error(`[run-jsunit] 测试超时（${timeoutMs}ms），子进程已被终止。`
        + '若有用例挂死，可用 JSUNIT_TIMEOUT_MS 调大上限排查。');
    // 超时时已捕获的输出（stdout/stderr）是定位挂死用例的唯一线索：最后一条
    // TAP/spec 行通常就是卡住的用例。直接丢弃会让 CI 日志只剩一行超时告警，
    // 无法排查——先完整回放再退出（R9-M1）。
    const timedOut = (result.stdout || '') + (result.stderr || '');
    if (timedOut) process.stdout.write(timedOut);
    else console.error('[run-jsunit] 超时前未捕获到任何测试输出。');
    process.exit(1);
}
if (result.error) {
    console.error(`[run-jsunit] 子进程执行异常: ${result.error.message}`);
    process.exit(1);
}
const out = (result.stdout || '') + (result.stderr || '');
if (out) process.stdout.write(out);

// P3-24(f)：汇总行锚定——只匹配独立成行的汇总（spec reporter 的 'ℹ skipped N'
// / TAP reporter 的 '# skipped N'，本仓 Node v24 在 spawnSync 捕获输出下默认 spec），
// 用例名本身含 "skipped 2" 之类字样时不再误匹配——未锚定的 \b 正则会命中输出中
// 任意位置（如子测试名、断言消息）。两种格式都要求「行首符号 + skipped + 数字 +
// 行尾」，用例名行因前缀/后缀不符被排除。
const skipped = Number((/^ℹ skipped (\d+)\s*$/m.exec(out) || /^# skipped (\d+)\s*$/m.exec(out) || [])[1] || 0);
const todo = Number((/^ℹ todo (\d+)\s*$/m.exec(out) || /^# todo (\d+)\s*$/m.exec(out) || [])[1] || 0);
if (skipped > 0) {
    console.warn(`[run-jsunit] [warn] 有 ${skipped} 个用例被跳过：通过数不含它们，`
        + '但被跳过意味着这部分行为本次完全没有被验证（常见原因：vendor 二进制缺失 / 非目标平台）。');
}
if (todo > 0) console.warn(`[run-jsunit] [warn] 有 ${todo} 个 todo 用例（尚未实现）`);
process.exit(result.status ?? 1);
