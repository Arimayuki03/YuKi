// 组件测试：RM-1 番剧子目录 — hls-downloader 目录迁移保持两级结构、任务级 dir 支持
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HlsDownloader = require('../../src/main/hls-downloader');

/** 建临时根目录，测试结束自动清理。 */
function tmpRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-dl-layout-'));
    return {
        root,
        cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* ignore */ } },
    };
}

test('hls migrateDir: 番剧子目录产物随迁保持两级结构（已完成任务）', () => {
    const t = tmpRoot();
    try {
        const oldDir = path.join(t.root, 'old');
        const newDir = path.join(t.root, 'new');
        const dest = path.join(oldDir, '番剧A', '第01集.mp4');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'data');
        const h = new HlsDownloader();
        h.dir = oldDir;
        h._pump = () => {};
        h._tasks.set('t1', { gid: 't1', name: '第01集.mp4', status: 'complete', _dest: dest, files: [dest] });
        const moved = h.migrateDir(newDir);
        assert.equal(moved, 1);
        const newDest = path.join(newDir, '番剧A', '第01集.mp4');
        assert.ok(fs.existsSync(newDest), '产物应落在 <新目录>/<番剧名>/ 下');
        assert.equal(h._tasks.get('t1')._dest, newDest);
        assert.deepEqual(h._tasks.get('t1').files, [newDest]);
        assert.ok(fs.existsSync(path.join(newDir, '番剧A')), '番剧子目录本身应随迁');
    } finally { t.cleanup(); }
});

test('hls migrateDir: 在途任务分片目录同入子目录并重新排队（断点续传路径保持）', () => {
    const t = tmpRoot();
    try {
        const oldDir = path.join(t.root, 'old');
        const newDir = path.join(t.root, 'new');
        const dest = path.join(oldDir, '番剧B', '第02集.mp4');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'partial');
        const segsDir = `${dest}.hls-1-x.segs`;
        fs.mkdirSync(segsDir, { recursive: true });
        fs.writeFileSync(path.join(segsDir, 'seg0.ts'), 's');
        const h = new HlsDownloader();
        h.dir = oldDir;
        h._pump = () => {};
        h._tasks.set('t2', {
            gid: 'hls-1-x', name: '第02集.mp4', status: 'active', _dest: dest, files: [dest],
            _segsDir: segsDir, _gen: 0, _proc: null, _speedTimer: null, _adTemp: null,
        });
        h.migrateDir(newDir);
        const task = h._tasks.get('t2');
        const newDest = path.join(newDir, '番剧B', '第02集.mp4');
        assert.equal(task._dest, newDest);
        assert.ok(fs.existsSync(newDest), '半成品随迁');
        assert.equal(task._segsDir, `${newDest}.hls-1-x.segs`);
        assert.ok(fs.existsSync(task._segsDir), '分片目录随迁（断点续传）');
        assert.equal(task.status, 'waiting', '在途任务应重新排队');
        assert.ok(h._pending.includes(task));
        // 继续时 ffmpeg 合并产物落在同一子目录（dest 已指向子目录）
        assert.equal(path.dirname(task._dest), path.join(newDir, '番剧B'));
    } finally { t.cleanup(); }
});

test('hls migrateDir: 旧目录外/无旧目录的任务回退按 basename 平铺（兼容存量行为）', () => {
    const t = tmpRoot();
    try {
        const newDir = path.join(t.root, 'new');
        const outside = path.join(t.root, 'elsewhere', 'flat.mp4');
        fs.mkdirSync(path.dirname(outside), { recursive: true });
        fs.writeFileSync(outside, 'x');
        const h = new HlsDownloader();
        h.dir = ''; // 未初始化场景
        h._pump = () => {};
        h._tasks.set('t3', { gid: 't3', name: 'flat.mp4', status: 'complete', _dest: outside, files: [outside] });
        h.migrateDir(newDir);
        assert.ok(fs.existsSync(path.join(newDir, 'flat.mp4')), '应平铺到新目录根部');
        assert.equal(h._tasks.get('t3')._dest, path.join(newDir, 'flat.mp4'));
    } finally { t.cleanup(); }
});

test('hls add: 接受任务级 dir 参数，产物与任务 dir 字段落子目录（引擎目录不受影响）', () => {
    // ffmpeg 缺失的环境跳过（add 首行即校验；CI 离线环境可能未准备二进制）
    let bin = null;
    try { bin = require('../../src/main/ffmpeg').findFfmpeg(); } catch (e) { /* ignore */ }
    if (!bin) return;
    const t = tmpRoot();
    try {
        const engineDir = path.join(t.root, 'engine');
        const seriesDir = path.join(t.root, 'engine', '番剧C');
        const h = new HlsDownloader();
        h.setDir(engineDir);
        h._pump = () => {}; // 不实际启动下载进程
        const gid = h.add({ url: 'https://example.com/a.m3u8', out: '第03集.mp4', dir: seriesDir });
        const task = h._tasks.get(gid);
        assert.equal(task.dir, seriesDir);
        assert.equal(task.files[0], path.join(seriesDir, '第03集.mp4'));
        assert.equal(h.dir, engineDir, '引擎全局目录不被任务级 dir 改写');
    } finally { t.cleanup(); }
});
