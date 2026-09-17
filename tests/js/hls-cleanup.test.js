// 组件测试：hls-downloader.js ffmpeg 进程登记与 cleanup() 退出收敛
// 编排层：本文件只负责把两个实现用例分发到隔离子进程执行——
//  - mock 用例：桩掉 child_process 后加载模块，验证 spawn 登记 / 全杀 / 幂等；
//  - real 用例：用 vendor ffmpeg 跑一次真实 _spawn（慢速流），验证 cleanup
//    能立即收敛在跑的 ffmpeg（asyncExit 钩子验证）。
// （实现与断言在同目录 hls-cleanup-impl.test.js，经 --test-name-pattern 只选中目标用例。）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const IMPL = path.join(__dirname, 'hls-cleanup-impl.test.js');
const FFMPEG = path.join(__dirname, '..', '..', 'vendor', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

function runImpl(pattern, extraEnv) {
    // 剔除父进程残留的 node:test 运行环境，避免子进程被父 runner 吞掉（run() 递归告警）
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith('NODE_TEST') || k.startsWith('NODE_V8_COVERAGE')) continue;
        env[k] = v;
    }
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-name-pattern', pattern, IMPL], {
        encoding: 'utf8',
        env: { ...env, ...extraEnv },
        windowsHide: true,
    });
    const out = String(r.stdout) + String(r.stderr);
    // name-pattern 命中 0 个用例时 node --test 以失败码退出且无 pass 输出 —— 属于编排错误
    const pass = /(?:ℹ|#)\s*pass\s+(\d+)/.exec(out);
    assert.ok(pass && parseInt(pass[1], 10) >= 1, `impl 子进程应至少通过 1 个用例（pattern=${pattern}）\n${out}`);
    const m = /(?:ℹ|#)\s*fail\s+(\d+)/.exec(out);
    assert.equal(m ? m[1] : '0', '0', `impl 用例不应失败（pattern=${pattern}）\n${out}`);
}

test('hls cleanup: spawn 被登记、cleanup 全杀全部存活进程且幂等（mock child_process）', () => {
    runImpl('\\[mock\\]', { HLS_CLEANUP_MOCK: '1' });
});

test('hls cleanup: 真实 _spawn 登记在跑的 ffmpeg，cleanup 立即收敛不落地成品（asyncExit）', { timeout: 60000 }, () => {
    if (!require('node:fs').existsSync(FFMPEG)) return; // 无 vendor ffmpeg 的环境跳过（impl 同样跳过）
    // impl 用例含 stall 服务器 + 5s 存活轮询 + 2s respawn 观察（自身 timeout 45s），
    // 父级 30s 已不够——提高到 60s 给子进程留余量
    runImpl('\\[real\\]', { HLS_CLEANUP_REAL: '1', HLS_CLEANUP_FFMPEG: FFMPEG });
});
