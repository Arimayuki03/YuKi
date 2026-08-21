const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RotatingLogWriter, readRecentLogs, clearLogs, redactSecrets, setLogLevel, startScheduledLogCleanup, stopScheduledLogCleanup } = require('../../src/main/logger');

test('logger redacts common secrets', () => {
    const input = 'GET /x?token=abc&name=n Authorization: Bearer xyz Cookie: sid=secret';
    const out = redactSecrets(input);
    assert.doesNotMatch(out, /abc|xyz|sid=secret/);
    assert.match(out, /\[REDACTED\]/);
});

test('rotating writer keeps UTF-8 logs readable and newest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-log-test-'));
    try {
        const file = path.join(dir, 'electron-main.log');
        const writer = new RotatingLogWriter(file, { maxBytes: 90, backups: 2 });
        writer.write('INFO', '第一条日志');
        writer.write('INFO', '第二条日志会触发轮转');
        writer.write('ERROR', '第三条日志');
        const result = readRecentLogs(dir, 1, 50);
        assert.equal(result.ok, true);
        assert.ok(result.total >= 3);
        assert.match(result.logs[0].line, /第三条日志/);
        assert.ok(fs.readdirSync(dir).some((name) => name.endsWith('.log.1')));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('clearLogs 只清日志文件，保留其它文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-log-clear-'));
    try {
        fs.writeFileSync(path.join(dir, 'electron-main.log'), 'hello');
        fs.writeFileSync(path.join(dir, 'electron-main.log.1'), 'old');
        fs.writeFileSync(path.join(dir, 'electron-main.log.2'), 'older');
        fs.writeFileSync(path.join(dir, 'settings.json'), 'keep-me');
        const r = clearLogs(dir);
        assert.equal(r.ok, true);
        assert.equal(r.removed, 3); // 3 个 .log* 文件被清
        assert.ok(!fs.existsSync(path.join(dir, 'electron-main.log')));
        assert.ok(fs.existsSync(path.join(dir, 'settings.json'))); // 非日志文件保留
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('setLogLevel 过滤低于当前级别的日志（级别设置有效）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-log-level-'));
    try {
        setLogLevel('WARN');
        assert.equal(require('../../src/main/logger').getLogLevel(), 'WARN');
        const writer = new RotatingLogWriter(path.join(dir, 'm.log'));
        writer.write('DEBUG', 'debug-dropped');
        writer.write('INFO', 'info-dropped');
        writer.write('WARN', 'warn-kept');
        writer.write('ERROR', 'error-kept');
        const content = fs.readFileSync(path.join(dir, 'm.log'), 'utf8');
        assert.doesNotMatch(content, /debug-dropped|info-dropped/);
        assert.match(content, /warn-kept/);
        assert.match(content, /error-kept/);
    } finally {
        setLogLevel('INFO'); // 恢复模块默认，避免影响其它测试
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('定时清理：已逾期时启动立即补清并持久化时间戳（跨重启周期生效）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-log-sched-'));
    try {
        fs.writeFileSync(path.join(dir, 'electron-main.log'), 'stale');
        let last = Date.now() - 8 * 24 * 3600 * 1000; // 上次清理在 8 天前，周期 7 天 → 已逾期
        let cleanedAt = 0;
        startScheduledLogCleanup(dir, 7 * 24 * 3600 * 1000, true, {
            getLastCleanup: () => last,
            markCleaned: (ts) => { cleanedAt = ts; last = ts; },
        });
        assert.ok(cleanedAt > 0, '逾期应立即补清一次');
        assert.ok(!fs.existsSync(path.join(dir, 'electron-main.log')));
    } finally {
        stopScheduledLogCleanup();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('定时清理：长周期(90天>24.8天计时器上限)不被钳位成 1ms 立即触发', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-log-sched2-'));
    try {
        fs.writeFileSync(path.join(dir, 'a.log'), 'x');
        let calls = 0;
        // 刚清理过（未逾期）：旧实现 delay 被钳成 1ms 会立刻清空；新实现不应触发
        startScheduledLogCleanup(dir, 90 * 24 * 3600 * 1000, true, {
            getLastCleanup: () => Date.now(),
            markCleaned: () => { calls++; },
        });
        assert.equal(calls, 0, '未到期不得触发清理');
        assert.ok(fs.existsSync(path.join(dir, 'a.log')), '日志文件未被提前清空');
    } finally {
        stopScheduledLogCleanup();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('定时清理：enabled=false 或周期<=0 不启动、不触发持久化钩子', () => {
    let calls = 0;
    const hooks = { getLastCleanup: () => 0, markCleaned: () => { calls++; } };
    startScheduledLogCleanup(os.tmpdir(), 7 * 24 * 3600 * 1000, false, hooks);
    startScheduledLogCleanup(os.tmpdir(), 0, true, hooks);
    assert.equal(calls, 0);
});
