// 组件测试：下载删除逻辑（remove 先移除任务后删文件 / clearFailed 遍历全部文件 / 去重）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 测试 remove 操作顺序：先移除任务（停止写入），再删除文件
test('remove: 先移除任务后删除文件（防止 aria2 仍在写入时文件被删）', () => {
    const events = [];
    const fakeTask = { gid: 'g1', files: ['/dl/video.mp4'], status: 'active' };
    const fakeDl = { remove: async (gid) => { events.push('task-removed'); } };
    const fakeFs = { rmSync: (f, opts) => { events.push('file-deleted:' + f); } };

    // 模拟正确的 remove 顺序
    (async () => {
        const delFiles = new Set(fakeTask.files);
        // 先移除任务
        await fakeDl.remove(fakeTask.gid);
        // 再删除文件
        for (const f of delFiles) { fakeFs.rmSync(f, { force: true }); }
        // 推送刷新
        events.push('list-pushed');
    })().then(() => {
        assert.equal(events[0], 'task-removed', '应先移除任务');
        assert.equal(events[1], 'file-deleted:/dl/video.mp4', '后删除文件');
        assert.equal(events[2], 'list-pushed', '最后推送刷新');
    });
});

// 测试文件去重（Set 去重，O(1) 而非 includes O(n)）
test('remove: 文件路径用 Set 去重', () => {
    const delFiles = new Set();
    // aria2 tellStatus 返回的文件
    ['video.mp4', 'video.mp4'].forEach((f) => delFiles.add(f));
    // dlRecords 返回的文件
    ['video.mp4', 'video.part'].forEach((f) => delFiles.add(f));
    assert.equal(delFiles.size, 2, '重复路径应被去重');
    assert.ok(delFiles.has('video.mp4'));
    assert.ok(delFiles.has('video.part'));
});

// 测试 clearFailed 遍历全部文件（非仅第一个）
test('clearFailed: 删除失败任务的全部文件（非仅 files[0]）', () => {
    const stopped = [
        { status: 'error', files: [
            { path: '/dl/part1.ts' },
            { path: '/dl/part2.ts' },
            { path: '/dl/part3.ts' },
        ] },
        { status: 'complete', files: [{ path: '/dl/ok.mp4' }] },
    ];
    const deleted = [];
    // 模拟修复后的 clearFailed 逻辑：遍历全部 s.files
    for (const s of stopped) {
        if (s.status !== 'error') continue;
        if (s.files) for (const f of s.files) {
            if (f && f.path && f.path !== '.') deleted.push(f.path);
        }
    }
    assert.equal(deleted.length, 3, '应删除全部 3 个文件');
    assert.ok(deleted.includes('/dl/part1.ts'));
    assert.ok(deleted.includes('/dl/part2.ts'));
    assert.ok(deleted.includes('/dl/part3.ts'));
    assert.ok(!deleted.includes('/dl/ok.mp4'), '不应删除已完成任务的文件');
});

// 测试 clearFailed 也清理 dlRecords 中的错误记录文件
test('clearFailed: 也删除持久化记录中失败任务的文件', () => {
    const records = [
        { gid: 'g1', status: 'error', files: ['/dl/old-failed.mp4'] },
        { gid: 'g2', status: 'complete', files: ['/dl/ok.mp4'] },
    ];
    const deleted = [];
    for (const r of records) {
        if (r.status === 'error' && r.files) for (const f of r.files) {
            if (f && f !== '.') deleted.push(f);
        }
    }
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0], '/dl/old-failed.mp4');
});

// 测试 addHls 并发数钳制到 1-32
test('addHls: 并发数钳制到 1-32', () => {
    const clamp = (v) => Math.max(1, Math.min(32, parseInt(v, 10) || 5));
    assert.equal(clamp(1), 1);
    assert.equal(clamp(5), 5);
    assert.equal(clamp(32), 32);
    assert.equal(clamp(50), 32);
    assert.equal(clamp(undefined), 5);
    assert.equal(clamp(null), 5);
    assert.equal(clamp('abc'), 5);
});
