const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RotatingLogWriter, readRecentLogs, clearLogs, redactSecrets } = require('../../src/main/logger');

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
