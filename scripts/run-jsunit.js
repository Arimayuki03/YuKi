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
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
