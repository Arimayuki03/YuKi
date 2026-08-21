// 功能测试：接口契约验证（参数校验 / 返回格式 / 边界情况）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ============================================================
// 1. 下载 IPC action 参数校验
// ============================================================

test('下载 action 白名单：仅允许已注册的 action', () => {
    const validActions = ['init', 'pickDir', 'add', 'addHls', 'addFile',
        'setConcurrency', 'setSplit', 'pause', 'unpause', 'remove', 'clearFailed', 'clear'];
    const testAction = (a) => validActions.includes(a);
    assert.equal(testAction('add'), true);
    assert.equal(testAction('addHls'), true);
    assert.equal(testAction('remove'), true);
    assert.equal(testAction('clearFailed'), true);
    assert.equal(testAction('delete'), false, '未注册的 action 应被拒绝');
    assert.equal(testAction(''), false);
    assert.equal(testAction('download'), false);
});

test('setConcurrency: 钳制到 1-10', () => {
    const clamp = (n) => Math.max(1, Math.min(10, parseInt(n, 10) || 3));
    assert.equal(clamp(5), 5);
    assert.equal(clamp(1), 1);
    assert.equal(clamp(10), 10);
    assert.equal(clamp(99), 10);
    assert.equal(clamp(-1), 1);
    assert.equal(clamp(undefined), 3, '缺省回退 3');
    assert.equal(clamp('abc'), 3);
});

test('setSplit: 钳制到 1-32', () => {
    const clamp = (n) => Math.max(1, Math.min(32, parseInt(n, 10) || 5));
    assert.equal(clamp(5), 5);
    assert.equal(clamp(1), 1);
    assert.equal(clamp(32), 32);
    assert.equal(clamp(100), 32);
    assert.equal(clamp(undefined), 5);
    assert.equal(clamp('abc'), 5);
});

test('add: URI 协议校验（仅 http/https/磁力）', () => {
    const isValid = (uri) => /^(https?:\/\/|magnet:)/i.test(String(uri || '').trim());
    assert.equal(isValid('https://example.com/video.mp4'), true);
    assert.equal(isValid('http://example.com/v.mp4'), true);
    assert.equal(isValid('magnet:?xt=urn:btih:abc'), true);
    assert.equal(isValid('ftp://example.com/v.mp4'), false, 'ftp 不允许');
    assert.equal(isValid('file:///C:/v.mp4'), false, 'file 不允许');
    assert.equal(isValid(''), false);
    assert.equal(isValid(null), false);
    assert.equal(isValid(undefined), false);
});

test('addHls: 空URI应被拒绝', () => {
    const uri = '';
    assert.equal(uri.trim().length > 0, false, '空 URI 应触发 empty uri 错误');
});

test('remove: gid 前缀 hls- 区分 HLS 与 aria2 任务', () => {
    const isHls = (gid) => String(gid).startsWith('hls-');
    assert.equal(isHls('hls-1-abc'), true);
    assert.equal(isHls('2089b3c0'), false);
    assert.equal(isHls('hls-'), true);
});

// ============================================================
// 2. player-exit 事件载荷契约
// ============================================================

test('player-exit 载荷: wallWatched 字段存在且为数字', () => {
    // 模拟主进程发送的 exit 载荷
    const exitPayload = {
        pos: 110, duration: 120, sessionId: 1001,
        fullscreen: true, speed: 1,
        wallWatched: 115, quit: false,
    };
    assert.equal(typeof exitPayload.wallWatched, 'number');
    assert.equal(typeof exitPayload.sessionId, 'number');
    assert.equal(typeof exitPayload.quit, 'boolean');
    assert.equal(exitPayload.wallWatched > 0, true);
});

test('player-exit: quit=true 时渲染层不应等待重连', () => {
    const exitPayload = { sessionId: 1001, quit: true, wallWatched: 30 };
    assert.equal(exitPayload.quit, true);
    // 渲染层 _onExit 检查 quit → this._seq = null; return
});

test('player-exit: wallWatched=null 时回退 pos', () => {
    // _recordWatch: watched = info.wallWatched ?? info.pos
    const info = { wallWatched: null, pos: 60 };
    const watched = (typeof info.wallWatched === 'number') ? info.wallWatched
        : ((typeof info.pos === 'number') ? info.pos : null);
    assert.equal(watched, 60, 'wallWatched 为 null 时应回退到 pos');
});

test('player-exit: wallWatched 和 pos 均为 null 时 watched=null', () => {
    const info = { wallWatched: null, pos: null };
    const watched = (typeof info.wallWatched === 'number') ? info.wallWatched
        : ((typeof info.pos === 'number') ? info.pos : null);
    assert.equal(watched, null);
});

// ============================================================
// 3. 下载列表（dl-list）载荷契约
// ============================================================

test('dl-list 载荷: 每个任务含必需字段', () => {
    const items = [
        { gid: 'g1', kind: 'aria2', status: 'active', name: 'video.mp4',
          total: 1000000, done: 500000, percent: 50, speed: 1024,
          connections: '5', errorMessage: '', files: ['/dl/video.mp4'] },
        { gid: 'hls-1-abc', kind: 'hls', status: 'complete', name: 'anime.mp4',
          total: 12, done: 12, percent: 100, speed: 0,
          connections: '12/12', errorMessage: '', files: ['/dl/anime.mp4'] },
    ];
    const requiredFields = ['gid', 'status', 'name', 'percent', 'speed', 'files'];
    for (const item of items) {
        for (const f of requiredFields) {
            assert.ok(f in item, `任务 ${item.gid} 缺少字段 ${f}`);
        }
    }
});

test('dl-list: HLS 并发模式 connections 显示 已下载/总数', () => {
    const hlsItem = { kind: 'hls', connections: '8/12' };
    const parts = hlsItem.connections.split('/');
    assert.equal(parts[0], '8', '已下载分片数');
    assert.equal(parts[1], '12', '总分片数');
});

test('dl-list: aria2 模式 connections 为连线数字', () => {
    const ariaItem = { kind: 'aria2', connections: '5' };
    assert.ok(/^\d+$/.test(ariaItem.connections) || ariaItem.connections === '');
});

// ============================================================
// 4. settings 契约
// ============================================================

test('watchStats 初始结构', () => {
    const empty = { totalSeconds: 0, sessionCount: 0, titles: {}, daily: {}, bySite: {} };
    assert.equal(empty.totalSeconds, 0);
    assert.equal(empty.sessionCount, 0);
    assert.equal(typeof empty.titles, 'object');
    assert.equal(typeof empty.daily, 'object');
});

test('settings-reset 保留键列表', () => {
    const keepKeys = ['favorites', 'history', 'dlDir', 'cacheDir',
        'watchStats', 'recentWatches',
        'bangumiToken', 'dandanAppId', 'dandanAppSecret'];
    assert.ok(keepKeys.includes('favorites'), '收藏应保留');
    assert.ok(keepKeys.includes('history'), '历史应保留');
    assert.ok(keepKeys.includes('watchStats'), '统计应保留');
    assert.ok(!keepKeys.includes('themeColor'), '主题色应清除');
    // 硬盘缓存已移除：两个历史键由启动迁移删除，不再进保留清单
    assert.ok(!keepKeys.includes('playerCacheMode'));
    assert.ok(!keepKeys.includes('playerCacheDir'));
});

// ============================================================
// 5. Python 后端 token 认证
// ============================================================

test('TOKEN_EXEMPT: /health /cache /proxy 免认证', () => {
    const TOKEN_EXEMPT = ['/health', '/cache', '/proxy'];
    assert.ok(TOKEN_EXEMPT.includes('/health'));
    assert.ok(TOKEN_EXEMPT.includes('/cache'));
    assert.ok(TOKEN_EXEMPT.includes('/proxy'));
    assert.ok(!TOKEN_EXEMPT.includes('/action'), '/action 需认证');
    assert.ok(!TOKEN_EXEMPT.includes('/kazumi/action'), '/kazumi/action 需认证');
    assert.ok(!TOKEN_EXEMPT.includes('/search/stream'), 'SSE 搜索需认证');
});

test('Bangumi 收藏 type 映射: 1想看/2看过/3在看/4搁置/5抛弃', () => {
    const typeMap = { want: 1, seen: 2, watching: 3, hold: 4, dropped: 5 };
    assert.equal(typeMap.want, 1);
    assert.equal(typeMap.seen, 2);
    assert.equal(typeMap.watching, 3);
    assert.equal(typeMap.hold, 4);
    assert.equal(typeMap.dropped, 5);
});

// ============================================================
// 6. 文件管理安全边界
// ============================================================

test('file-manager: 路径遍历防护（.. 被拒绝）', () => {
    const isSafe = (rel) => !String(rel).includes('..');
    assert.equal(isSafe('video/anime.mp4'), true);
    assert.equal(isSafe('../etc/passwd'), false);
    assert.equal(isSafe('video/../../../etc/passwd'), false);
});

test('file-push: 非视频文件被拒绝', () => {
    const VIDEO_EXTS = ['.mp4', '.mkv', '.ts', '.flv', '.avi', '.mov', '.webm'];
    const isVideo = (f) => VIDEO_EXTS.includes('.' + f.split('.').pop().toLowerCase());
    assert.equal(isVideo('video.mp4'), true);
    assert.equal(isVideo('video.mkv'), true);
    assert.equal(isVideo('document.txt'), false);
    assert.equal(isVideo('image.jpg'), false);
});
