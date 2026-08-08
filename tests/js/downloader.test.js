// 组件测试：downloader.js 的 flatten（aria2 状态扁平化）纯函数
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Downloader = require('../../src/main/downloader');

test('flatten: 计算百分比', () => {
    const f = Downloader.flatten({
        gid: 'a', status: 'active',
        totalLength: '1000', completedLength: '250',
        downloadSpeed: '500', files: [{ path: 'C:\\v\\a.mp4' }],
    });
    assert.equal(f.percent, 25);
    assert.equal(f.total, 1000);
    assert.equal(f.done, 250);
    assert.equal(f.speed, 500);
    assert.equal(f.status, 'active');
});

test('flatten: BT 任务取 info name', () => {
    const f = Downloader.flatten({
        gid: 'b', status: 'complete',
        bittorrent: { info: { name: '番剧合集' } },
        totalLength: '0', completedLength: '0',
        files: [{ path: 'C:\\v\\x.mkv' }],
    });
    assert.equal(f.name, '番剧合集');
});

test('flatten: 无 BT 名取文件 basename', () => {
    const f = Downloader.flatten({
        gid: 'c', status: 'complete', files: [{ path: 'D:/dl/影片/第01集.mp4' }],
    });
    assert.equal(f.name, '第01集.mp4');
});

test('flatten: 无文件路径取 URL basename（解码）', () => {
    const f = Downloader.flatten({
        gid: 'd', status: 'waiting',
        files: [{ uris: [{ uri: 'https://example.com/%E8%A7%86%E9%A2%91.mp4?x=1' }] }],
    });
    assert.equal(f.name, '视频.mp4');
});

test('flatten: BT 连线数拼接为 conn/seed', () => {
    const f = Downloader.flatten({ gid: 'e', status: 'active', connections: '3', numSeeders: '7' });
    assert.equal(f.connections, '3/7');
});

test('flatten: 非 BT 用 connections 原值，缺省空串', () => {
    const f = Downloader.flatten({ gid: 'f', status: 'active', connections: '5' });
    assert.equal(f.connections, '5');
    const f2 = Downloader.flatten({ gid: 'g', status: 'active' });
    assert.equal(f2.connections, '');
});

test('flatten: errorMessage 缺省空串，files 过滤空路径', () => {
    const f = Downloader.flatten({ gid: 'h', status: 'error', files: [{ path: '' }, { path: 'D:/a.mp4' }] });
    assert.equal(f.errorMessage, '');
    assert.deepEqual(f.files, ['D:/a.mp4']);
});
