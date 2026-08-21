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
