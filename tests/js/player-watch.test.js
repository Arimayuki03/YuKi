'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

function loadPlayer(settings) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/player.js'), 'utf8');
    const jqueryStub = () => ({
        on() { return this; },
        text() { return ''; },
        show() { return this; },
        hide() { return this; },
    });
    const context = {
        console,
        Map,
        Set,
        Promise,
        Date,
        Math,
        JSON,
        String,
        Array,
        parseInt,
        parseFloat,
        setTimeout,
        clearTimeout,
        $: jqueryStub,
        window: {
            vpc: {
                settingsGet: async () => JSON.parse(JSON.stringify(settings)),
                settingsSet: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
            },
        },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testPlayer = Player;`, context, { filename: 'player.js' });
    return context.__testPlayer;
}

test('观看统计按 sessionId 使用起播时元信息并串行保存', async () => {
    const settings = {};
    const player = loadPlayer(settings);
    player._curMeta = { site: 'site-a', vodId: 'vod-a', title: '影片 A', subtitle: '第 1 集' };
    player._rememberSession({ ok: true, sessionId: 101 });
    player._curMeta = { site: 'site-b', vodId: 'vod-b', title: '影片 B', subtitle: '第 2 集' };
    player._rememberSession({ ok: true, sessionId: 102 });

    player._recordWatch({ sessionId: 101, pos: 30, duration: 60 });
    player._recordWatch({ sessionId: 102, pos: 45, duration: 90 });
    await player._watchWrite;

    assert.equal(settings.watchStats.totalSeconds, 75);
    assert.equal(settings.watchStats.sessionCount, 2);
    assert.equal(settings.watchStats.titles['影片 A'], 1);
    assert.equal(settings.watchStats.titles['影片 B'], 1);
    assert.equal(settings.recentWatches.length, 2);
    assert.equal(settings.recentWatches[0].name, '影片 B');
    assert.equal(settings.recentWatches[1].name, '影片 A');
    assert.equal(settings.recentWatches[1].percent, 50);
});

test('未知或重复退出事件不会写入观看统计', async () => {
    const settings = {};
    const player = loadPlayer(settings);
    player._curMeta = { title: '影片 A' };
    player._rememberSession({ ok: true, sessionId: 201 });
    player._recordWatch({ sessionId: 999, pos: 30, duration: 60 });
    player._recordWatch({ sessionId: 201, pos: 20, duration: 40 });
    player._recordWatch({ sessionId: 201, pos: 20, duration: 40 });
    await player._watchWrite;
    assert.equal(settings.watchStats.sessionCount, 1);
});

test('断流重连同一观看链只补增量，观看次数不重复', async () => {
    const settings = {};
    const player = loadPlayer(settings);
    player._curMeta = { site: 'site-a', vodId: 'vod-a', title: '影片 A', subtitle: '第 1 集' };
    player._rememberSession({ ok: true, sessionId: 301 });
    const chainId = player._watchSessions.get(301).chainId;
    player._recordWatch({ sessionId: 301, pos: 30, duration: 120 });
    await player._watchWrite;
    assert.equal(settings.watchStats.totalSeconds, 30);
    assert.equal(settings.watchStats.sessionCount, 1);
    // 主进程断流重连：新会话沿用旧观看链元信息
    player._adoptSession({ sessionId: 302 });
    assert.equal(player._watchSessions.get(302).chainId, chainId);
    player._recordWatch({ sessionId: 302, pos: 60, duration: 120 });
    await player._watchWrite;
    // 第二次退出只补 (60-30)=30s，不再是 30+60；观看次数仍为 1
    assert.equal(settings.watchStats.totalSeconds, 60);
    assert.equal(settings.watchStats.sessionCount, 1);
    assert.equal(settings.watchStats.titles['影片 A'], 1);
    assert.equal(settings.recentWatches.length, 1);
    assert.equal(settings.recentWatches[0].seconds, 60);
    assert.equal(settings.recentWatches[0].percent, 50);
});

test('断流重连进度回退或持平不叠加', async () => {
    const settings = {};
    const player = loadPlayer(settings);
    player._curMeta = { title: '影片 B' };
    player._rememberSession({ ok: true, sessionId: 401 });
    player._recordWatch({ sessionId: 401, pos: 60, duration: 120 });
    await player._watchWrite;
    player._adoptSession({ sessionId: 402 });
    player._recordWatch({ sessionId: 402, pos: 40, duration: 120 }); // 回退
    await player._watchWrite;
    assert.equal(settings.watchStats.totalSeconds, 60);
    assert.equal(settings.watchStats.sessionCount, 1);
    assert.equal(settings.recentWatches[0].seconds, 60);
});

test('观看链跨会话去重：重连会话不再新增标题次数', async () => {
    const settings = {};
    const player = loadPlayer(settings);
    player._curMeta = { title: '影片 C' };
    player._rememberSession({ ok: true, sessionId: 501 });
    player._recordWatch({ sessionId: 501, pos: 30, duration: 90 });
    await player._watchWrite;
    player._adoptSession({ sessionId: 502 });
    player._recordWatch({ sessionId: 502, pos: 80, duration: 90 });
    await player._watchWrite;
    assert.equal(settings.watchStats.titles['影片 C'], 1);
    assert.equal(settings.watchStats.sessionCount, 1);
    assert.equal(settings.watchStats.totalSeconds, 80);
});

test('ended 按会话归属：旧会话 ended 不误判新会话「看完」', () => {
    const settings = {};
    const player = loadPlayer(settings);
    player._session = 601;
    player._onEnded({ sessionId: 601 }); // 当前集播完
    assert.equal(player._isDone({ sessionId: 601, pos: null, duration: null }), true);
    // 新集起播：play() 会重置全局 ended 时间戳与会话记录
    player._endedAt = 0;
    player._endedSessions.clear();
    player._session = 602;
    player._onEnded({ sessionId: 601 }); // 旧会话延迟 ended（全局兜底不受污染）
    assert.equal(player._isDone({ sessionId: 602, pos: null, duration: null }), false);
    // 当前会话收到 ended 后判定看完
    player._onEnded({ sessionId: 602 });
    assert.equal(player._isDone({ sessionId: 602, pos: null, duration: null }), true);
});

test('isDone：有进度时按剩余时长判定', () => {
    const settings = {};
    const player = loadPlayer(settings);
    assert.equal(player._isDone({ sessionId: 701, pos: 95, duration: 100 }), true);  // 剩 5s
    assert.equal(player._isDone({ sessionId: 702, pos: 50, duration: 100 }), false); // 剩 50s
    assert.equal(player._isDone({ sessionId: 703, pos: null, duration: null }), false);
});

test('pos 缺失（IPC 未观测到进度）仍计一次观看次数/部数，秒数不计', async () => {
    const settings = {};
    const player = loadPlayer(settings);
    player._curMeta = { site: 'site-a', vodId: 'vod-a', title: '影片 A', subtitle: '第 1 集' };
    player._rememberSession({ ok: true, sessionId: 801 });
    player._recordWatch({ sessionId: 801, pos: null, duration: null });
    await player._watchWrite;
    assert.equal(settings.watchStats.sessionCount, 1);
    assert.equal(settings.watchStats.titles['影片 A'], 1);
    assert.equal(settings.watchStats.totalSeconds, 0);
    assert.equal(settings.recentWatches.length, 1);
    assert.equal(settings.recentWatches[0].seconds, 0);
});

test('pos 缺失的短播不误计：pos=0（明确观测到 0 秒）仍按短播过滤', async () => {
    const settings = {};
    const player = loadPlayer(settings);
    player._curMeta = { title: '影片 B' };
    player._rememberSession({ ok: true, sessionId: 802 });
    player._recordWatch({ sessionId: 802, pos: 0, duration: 100 });
    await player._watchWrite;
    assert.equal(settings.watchStats, undefined); // 未产生统计
    assert.equal(settings.recentWatches, undefined);
});

test('用户主动关闭播放器（quit）终止连播链，不自动播下一集', async () => {
    const settings = {};
    const player = loadPlayer(settings);
    player._curMeta = { title: '影片 A' };
    player._rememberSession({ ok: true, sessionId: 901 });
    player._session = 901;
    player._playToken = 5; // 起播令牌（不变化，模拟未另起播放）
    player._seq = { site: 's', flag: 'f', title: '影片 A', episodes: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }], index: 0 };
    await player._onExit({ sessionId: 901, pos: 30, duration: 120, quit: true });
    assert.equal(player._seq, null); // quit → 终止连播链，不推进下一集
});

test('断流退出（未看完、非 quit、媒体直链）保留连播链等待主进程重连', async () => {
    const settings = {};
    const player = loadPlayer(settings);
    player._curMeta = { title: '影片 C' };
    player._rememberSession({ ok: true, sessionId: 902 });
    player._session = 902;
    player._playToken = 6;
    player._lastUrl = 'https://x.example.com/ep1.mp4';
    player._seq = { site: 's', flag: 'f', title: '影片 C', episodes: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }], index: 0 };
    await player._onExit({ sessionId: 902, pos: 30, duration: 120, quit: false });
    assert.ok(player._seq); // 断流等待主进程重连，链保留
});

test('_awaitTimeout：解析 IPC 挂起时超时返回 null（loading 不会卡死）', async () => {
    const player = loadPlayer({});
    const never = new Promise(() => { /* 永不 resolve，模拟 IPC 挂起 */ });
    const start = Date.now();
    const r = await player._awaitTimeout(never, 60);
    assert.equal(r, null);
    assert.ok(Date.now() - start >= 50, '应在超时后返回');
    // 正常 promise 不受影响
    const ok = await player._awaitTimeout(Promise.resolve({ ok: true }), 60);
    assert.deepEqual(ok, { ok: true });
});
