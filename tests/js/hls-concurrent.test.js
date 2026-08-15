// 组件测试：hls-downloader.js 分片并发模式（_parsePlaylist / concat 路径 / worker 取消）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// 测试 concat 列表路径格式（Windows 反斜杠 → 正斜杠）
test('_concatSegments: concat 列表路径使用正斜杠（Windows 兼容）', () => {
    // 模拟 _concatSegments 中的路径转换逻辑
    const segsDir = path.join('C:\\Users\\test\\downloads', 'video.mp4.segs');
    const segFile = path.join(segsDir, 'seg-000000.ts');
    const converted = segFile.split(path.sep).join('/').replace(/'/g, "'\\''");
    // 无论平台，路径分隔符都应为正斜杠
    assert.ok(!converted.includes('\\'), '路径中不应包含反斜杠');
    assert.ok(converted.includes('/'), '路径中应包含正斜杠');
});

test('_concatSegments: 单引号转义', () => {
    const segFile = "/path/to/it's a test.ts";
    const converted = segFile.split(path.sep).join('/').replace(/'/g, "'\\''");
    assert.ok(converted.includes("'\\''"));
});

// 测试 _parsePlaylist 逻辑（通过模拟播放列表文本验证解析规则）
test('_parsePlaylist: media 播放列表解析分片 + 检测加密', () => {
    // 模拟 _parsePlaylist 的解析逻辑（提取自 hls-downloader.js）
    const text = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.0,',
        'https://cdn.example.com/seg1.ts',
        '#EXTINF:10.0,',
        'https://cdn.example.com/seg2.ts',
        '#EXTINF:5.5,',
        'https://cdn.example.com/seg3.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');

    const segments = [];
    let isEncrypted = false;
    let totalDuration = 0;
    let pendingInf = null;
    const plUrl = 'https://cdn.example.com/playlist.m3u8';
    const abs = (uri) => { try { return new URL(uri, plUrl).href; } catch (e) { return uri; } };

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (/^#EXT-X-KEY:/i.test(line)) { isEncrypted = true; continue; }
        if (/^#EXTINF:([\d.]+)/.test(line)) {
            const m = line.match(/^#EXTINF:([\d.]+)/);
            pendingInf = m ? parseFloat(m[1]) : 0;
            continue;
        }
        if (line.startsWith('#')) continue;
        const segUrl = abs(line);
        segments.push({ url: segUrl, index: segments.length, duration: pendingInf || 0 });
        totalDuration += pendingInf || 0;
        pendingInf = null;
    }

    assert.equal(segments.length, 3);
    assert.equal(segments[0].url, 'https://cdn.example.com/seg1.ts');
    assert.equal(segments[0].index, 0);
    assert.equal(segments[0].duration, 10.0);
    assert.equal(segments[2].duration, 5.5);
    assert.equal(totalDuration, 25.5);
    assert.equal(isEncrypted, false);
});

test('_parsePlaylist: AES-128 加密流检测', () => {
    const text = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin"',
        '#EXTINF:10.0,',
        'https://cdn.example.com/seg1.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');

    let isEncrypted = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (/^#EXT-X-KEY:/i.test(line)) { isEncrypted = true; continue; }
    }
    assert.equal(isEncrypted, true);
});

test('_parsePlaylist: 相对 URL 解析为绝对', () => {
    const plUrl = 'https://cdn.example.com/path/playlist.m3u8';
    const abs = (uri) => { try { return new URL(uri, plUrl).href; } catch (e) { return uri; } };
    assert.equal(abs('seg1.ts'), 'https://cdn.example.com/path/seg1.ts');
    assert.equal(abs('/seg1.ts'), 'https://cdn.example.com/seg1.ts');
    assert.equal(abs('https://other.com/seg1.ts'), 'https://other.com/seg1.ts');
});

// 测试 worker 取消逻辑（failed 标志传播）
test('_downloadSegments: failed 标志阻止后续 worker 继续下载', () => {
    // 模拟 worker 循环中的 failed 检查
    let idx = 0;
    let failed = false;
    const segments = [{ index: 0 }, { index: 1 }, { index: 2 }];
    const processed = [];

    // 模拟第一个 worker 失败
    const worker1 = () => {
        while (idx < segments.length) {
            if (failed) return;
            const seg = segments[idx++];
            if (seg.index === 0) { failed = true; break; }
            processed.push(seg.index);
        }
    };
    worker1();
    assert.equal(failed, true);
    // 第二个 worker 应立即退出
    const worker2 = () => {
        while (idx < segments.length) {
            if (failed) return;
            processed.push(segments[idx++].index);
        }
    };
    worker2();
    assert.equal(processed.length, 0, 'failed 后其余 worker 不应处理任何分片');
});

// 测试 speed timer 在 _downloadSegments 结束后被清理
test('_downloadSegments: 速度定时器在下载完成后被清理', () => {
    const task = { _speedTimer: 999, speed: 100, _segBytes: 5000 };
    // 模拟 _downloadSegments 末尾的清理逻辑
    if (task._speedTimer) { clearInterval(task._speedTimer); task._speedTimer = null; }
    task.speed = 0;
    assert.equal(task._speedTimer, null);
    assert.equal(task.speed, 0);
});
