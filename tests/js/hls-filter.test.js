// 组件测试：hls-downloader.js 广告过滤纯函数（filterAdSegments / isAdUri）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Hls = require('../../src/main/hls-downloader');

const { filterAdSegments, isAdUri } = Hls;

test('isAdUri: 命中广告路径特征', () => {
    assert.equal(isAdUri('https://cdn.example.com/ad/pre.mp4'), true);
    assert.equal(isAdUri('https://cdn.example.com/ads/seg1.ts'), true);
    assert.equal(isAdUri('https://cdn.example.com/adbreak/x.ts'), true);
    assert.equal(isAdUri('https://cdn.example.com/hls/adsegment1.ts'), true);
});

test('isAdUri: 普通内容不误判', () => {
    assert.equal(isAdUri('https://cdn.example.com/hls/seg1.ts'), false);
    assert.equal(isAdUri('https://cdn.example.com/adventure/ep1.ts'), false);
    assert.equal(isAdUri(''), false);
});

test('filterAdSegments: CUE-OUT/CUE-IN 之间的分段剔除', () => {
    const pl = [
        '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.0,', 'seg0.ts',
        '#EXT-X-CUE-OUT:30',
        '#EXTINF:10.0,', 'ad1.ts',
        '#EXTINF:10.0,', 'ad2.ts',
        '#EXT-X-CUE-IN',
        '#EXTINF:10.0,', 'seg1.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const { filtered, removed } = filterAdSegments(pl, 'https://cdn.example.com/playlist.m3u8');
    assert.equal(removed, 2);
    assert.ok(!filtered.includes('ad1.ts'), '广告分段 ad1 应被剔除');
    assert.ok(!filtered.includes('ad2.ts'), '广告分段 ad2 应被剔除');
    assert.ok(filtered.includes('seg0.ts'));
    assert.ok(filtered.includes('seg1.ts'));
    assert.ok(filtered.includes('#EXT-X-ENDLIST'));
    assert.ok(!filtered.includes('CUE-OUT'));
});

test('filterAdSegments: 相对分段地址解析为绝对地址', () => {
    const pl = ['#EXTM3U', '#EXTINF:10.0,', 'seg/1.ts', '#EXT-X-ENDLIST'].join('\n');
    const { filtered } = filterAdSegments(pl, 'https://cdn.example.com/hls/main.m3u8');
    assert.ok(filtered.includes('https://cdn.example.com/hls/seg/1.ts'), '应补全为绝对地址');
});

test('filterAdSegments: EXT-X-KEY 相对地址改写为绝对（AES 加密流）', () => {
    const pl = [
        '#EXTM3U', '#EXT-X-VERSION:3',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
        '#EXTINF:10.0,', 'seg0.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const { filtered } = filterAdSegments(pl, 'https://cdn.example.com/hls/main.m3u8');
    assert.ok(filtered.includes('URI="https://cdn.example.com/hls/key.bin"'), 'KEY URI 应绝对化');
    assert.ok(filtered.includes('seg0.ts'));
});

test('filterAdSegments: 无广告时不删任何分段', () => {
    const pl = [
        '#EXTM3U', '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.0,', 'a.ts',
        '#EXTINF:10.0,', 'b.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const { removed, filtered } = filterAdSegments(pl, 'https://cdn.example.com/main.m3u8');
    assert.equal(removed, 0);
    assert.ok(filtered.includes('a.ts') && filtered.includes('b.ts'));
});

test('filterAdSegments: 空输入安全返回', () => {
    const { filtered, removed } = filterAdSegments('', 'https://cdn.example.com/main.m3u8');
    assert.equal(removed, 0);
    assert.equal(filtered, '');
});
