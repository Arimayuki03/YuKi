const test = require('node:test');
const assert = require('node:assert/strict');
const HlsDownloader = require('../../src/main/hls-downloader');

/** 构造仅含调度字段的假任务（不触碰 ffmpeg/网络）。 */
const fakeTask = (gid, status) => ({
    gid, name: gid, status,
    url: 'https://example.com/x.m3u8', header: null, percent: 0,
});

test('hls 任务队列: maxActive 默认 3 且钳制到 1-10（并发任务数上限）', () => {
    const h = new HlsDownloader();
    assert.equal(h.maxActive, 3);
    h.setMaxActive(0);
    assert.equal(h.maxActive, 1);
    h.setMaxActive(99);
    assert.equal(h.maxActive, 10);
    h.setMaxActive(5);
    assert.equal(h.maxActive, 5);
});

test('hls 任务队列: _activeCount 仅统计 active 任务（waiting 不占运行槽位语义由调用方保证）', () => {
    const h = new HlsDownloader();
    h._tasks.set('a', fakeTask('a', 'active'));
    h._tasks.set('b', fakeTask('b', 'waiting'));
    h._tasks.set('c', fakeTask('c', 'complete'));
    h._tasks.set('d', fakeTask('d', 'error'));
    assert.equal(h._activeCount(), 1);
});

test('hls 任务队列: _pump 对空队列安全，跳过非 waiting 残留且不启动下载', () => {
    const h = new HlsDownloader();
    h._pump(); // 空 pending：无操作、不抛错

    const ghostRemoved = fakeTask('ghost-removed', 'removed');
    const ghostActive = fakeTask('ghost-active', 'active');
    h._pending.push(ghostRemoved, ghostActive);
    h.setMaxActive(2); // 触发 _pump 补位
    assert.equal(h._pending.length, 0); // 残留引用已出队丢弃
    assert.equal(ghostRemoved.status, 'removed'); // 未被启动（仍为终态）
    assert.equal(ghostActive.status, 'active'); // 未被二次启动
});

test('hls 任务队列: 终态事件挂钩注册（completed/error 释放槽位触发补位）', () => {
    const h = new HlsDownloader();
    assert.ok(h.listenerCount('completed') >= 1);
    assert.ok(h.listenerCount('error') >= 1);
});

test('hls pause/unpause: 活跃任务杀进程转 paused、代数 +1、出 pending；unpause 重新入队', () => {
    const h = new HlsDownloader();
    h.dir = process.cwd(); // 避免未初始化时 join 到默认路径
    // 桩 _pump：暂停释放的槽位补位、继续后的启动均不在此单测职责内（由 _run/_runConcurrent 测试覆盖）
    h._pump = () => {};
    // 用代理对象代替真实进程：kill 是空函数
    const t = { ...fakeTask('hls-p1', 'active'), _gen: 0, _proc: { kill: () => {} }, _speedTimer: null, _pending: [] };
    h._tasks.set('hls-p1', t);
    // 活跃任务暂停：状态转 paused、代数自增、进程句柄清空
    assert.equal(h.pause('hls-p1'), true);
    assert.equal(t.status, 'paused');
    assert.equal(t._gen, 1);
    assert.equal(t._proc, null);
    // 非进行中任务暂停返回 false（不误改状态）
    assert.equal(h.pause('hls-p1'), false);
    // unpause：状态回 waiting 并入队 pending（_pump 已桩，不会被提升为 active）
    assert.equal(h.unpause('hls-p1'), true);
    assert.equal(t.status, 'waiting');
    assert.ok(h._pending.includes(t));
    // 非 paused 任务 unpause 返回 false
    assert.equal(h.unpause('hls-p1'), false);
    h._pending.length = 0;
    h._tasks.delete('hls-p1');
});

test('hls pause/unpause: waiting 任务暂停直接出队，不构造进程句柄', () => {
    const h = new HlsDownloader();
    h._pump = () => {};
    const w = { ...fakeTask('hls-w1', 'waiting'), _gen: 0, _proc: null, _speedTimer: null };
    h._tasks.set('hls-w1', w);
    h._pending.push(w);
    assert.equal(h.pause('hls-w1'), true);
    assert.equal(w.status, 'paused');
    assert.equal(h._pending.length, 0); // 已从等待队列移除
    h._tasks.delete('hls-w1');
});

test('hls pauseAll/unpauseAll: 遍历全部任务，返回暂停/唤醒数量', () => {
    const h = new HlsDownloader();
    h.dir = process.cwd();
    h._pump = () => {};
    const mk = (gid, status) => {
        const t = { ...fakeTask(gid, status), _gen: 0, _proc: status === 'active' ? { kill: () => {} } : null, _speedTimer: null };
        h._tasks.set(gid, t);
        if (status === 'waiting') h._pending.push(t);
        return t;
    };
    mk('a', 'active');
    mk('b', 'waiting');
    mk('c', 'paused');
    mk('d', 'complete');
    assert.equal(h.pauseAll(), 2); // a、b 被暂停；c 已暂停、d 已完成不计
    assert.equal(h._tasks.get('a').status, 'paused');
    assert.equal(h._tasks.get('b').status, 'paused');
    // unpauseAll 只唤醒 paused 任务
    assert.equal(h.unpauseAll(), 3); // a、b、c 全部转 waiting
    assert.equal(h._tasks.get('c').status, 'waiting');
    h._pending.length = 0;
    for (const k of [...h._tasks.keys()]) h._tasks.delete(k);
});

test('hls migrateDir: paused 任务保留暂停状态、不重新入队（分片已随迁，继续时续传）', () => {
    const h = new HlsDownloader();
    h.dir = process.cwd();
    h._pump = () => {};
    // 用 mock move 避免真实文件系统操作
    const fs = require('fs');
    const origRename = fs.renameSync;
    const origExists = fs.existsSync;
    const origStat = fs.statSync;
    const origCp = fs.cpSync;
    const origRm = fs.rmSync;
    fs.renameSync = () => { throw new Error('EXDEV-mock'); };
    fs.existsSync = () => false;
    fs.statSync = () => { throw new Error('ENOENT-mock'); };
    fs.cpSync = () => {};
    fs.rmSync = () => {};
    try {
        const p = { ...fakeTask('hls-mig', 'paused'), _gen: 0, _proc: null, _speedTimer: null,
            _dest: '/old/video.mp4', _segsDir: '/old/video.mp4.hls-mig.segs', files: ['/old/video.mp4'],
            _adTemp: null, _input: null, _retried: false, _transcodeRetried: false };
        h._tasks.set('hls-mig', p);
        h.migrateDir('/new');
        assert.equal(p.status, 'paused', 'paused 任务保持暂停，不重新入队');
        assert.equal(h._pending.length, 0);
        // path.join 在 win32 用反斜杠；按平台归一化比较
        const path = require('path');
        assert.equal(p._dest, path.join('/new', 'video.mp4'));
        assert.equal(p._segsDir, path.join('/new', 'video.mp4.hls-mig.segs'));
        // 活跃任务迁移后应重新入队（断点续传）
        const a = { ...fakeTask('hls-mig2', 'active'), _gen: 0, _proc: null, _speedTimer: null,
            _dest: '/old/v2.mp4', _segsDir: '/old/v2.mp4.hls-mig2.segs', files: ['/old/v2.mp4'],
            _adTemp: null, _input: null, _retried: false, _transcodeRetried: false };
        h._tasks.set('hls-mig2', a);
        h.migrateDir('/new2');
        assert.equal(a.status, 'waiting');
        assert.ok(h._pending.includes(a));
    } finally {
        fs.renameSync = origRename;
        fs.existsSync = origExists;
        fs.statSync = origStat;
        fs.cpSync = origCp;
        fs.rmSync = origRm;
    }
    h._pending.length = 0;
    for (const k of [...h._tasks.keys()]) h._tasks.delete(k);
});
