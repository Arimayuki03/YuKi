'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

// 与 player-watch.test.js 同款加载器：vm 隔离执行渲染层 player.js
function loadPlayer(settings, extras = {}) {
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
        warnToast() {},
        $: jqueryStub,
        window: {
            yuki: {
                settingsGet: async () => JSON.parse(JSON.stringify(settings)),
                settingsSet: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
            },
        },
    };
    if (extras.yuki) Object.assign(context.window.yuki, extras.yuki);
    if (extras.Records) context.Records = extras.Records;
    if (extras.Kazumi) context.Kazumi = extras.Kazumi;
    if (extras.Detail) context.Detail = extras.Detail;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testPlayer = Player;`, context, { filename: 'player.js' });
    return context.__testPlayer;
}

/** 与 _writeWatch 内部一致的本地日期键（YYYY-MM-DD）。 */
function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

test('_rememberExtSession：viaExternal+sessionId 才登记，元信息挂独立观看链', () => {
    const player = loadPlayer({});
    player._curMeta = { site: 'site-a', vodId: 'vod-a', title: '影片 X', subtitle: '第01集', totalEps: 12 };
    // 非 external 响应 / 坏会话号 / 缺标题 一律拒绝登记
    assert.equal(player._rememberExtSession({ ok: true, sessionId: 1 }), false);
    assert.equal(player._rememberExtSession({ viaExternal: true }), false);
    assert.equal(player._rememberExtSession({ viaExternal: true, sessionId: 0 }), false);
    const keep = player._curMeta;
    player._curMeta = {};
    assert.equal(player._rememberExtSession({ viaExternal: true, sessionId: 2 }), false);
    player._curMeta = keep;
    assert.equal(player._rememberExtSession({ viaExternal: true, sessionId: 7 }), true);
    const meta = player._watchSessions.get(7);
    assert.ok(meta);
    assert.equal(meta.chainId, 1); // 独立观看链从 1 起分配
    assert.equal(meta.title, '影片 X');
    // 不写 _session：外部会话不参与 mpv 连播判定
});

test('外部播放退出 ≥15s 按墙钟计入统计/最近观看/历史，<15s 过滤', async () => {
    const recorded = [];
    const settings = {};
    const player = loadPlayer(settings, { Records: { recordPlay: async (v) => recorded.push(v) } });
    player._curMeta = { site: 'site-a', vodId: 'vod-a', title: '影片 X', subtitle: '第01集', totalEps: 12 };
    player._rememberExtSession({ viaExternal: true, sessionId: 7 });

    // 未登记的会话号直接忽略
    player._onExtPlayerExit({ sessionId: 999, wallSec: 100 });
    // 短播过滤（VLC 单实例秒退转交等）：不计次也不计时长
    player._rememberExtSession({ viaExternal: true, sessionId: 8 });
    player._onExtPlayerExit({ sessionId: 8, wallSec: 5 });
    await player._watchWrite;
    assert.equal(settings.watchStats, undefined);
    assert.deepEqual(recorded, []);

    // 正常退出：90s 全额累计、计一次数
    player._onExtPlayerExit({ sessionId: 7, wallSec: 90 });
    await player._watchWrite;
    assert.equal(settings.watchStats.totalSeconds, 90);
    assert.equal(settings.watchStats.sessionCount, 1);
    assert.equal(settings.watchStats.titles['影片 X'], 1);
    assert.equal(settings.watchStats.daily[todayKey()], 90);
    assert.equal(settings.watchStats.bySite['site-a'], 90);
    // 最近观看：位置不可知 → percent 如实为 0
    assert.equal(settings.recentWatches[0].name, '影片 X');
    assert.equal(settings.recentWatches[0].remarks, '第01集');
    assert.equal(settings.recentWatches[0].percent, 0);
    // 历史：一条 kind=play 记录，集名与墙钟时长落账
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].name, '影片 X');
    assert.equal(recorded[0].episode, '第01集');
    assert.equal(recorded[0].seconds, 90);
    assert.equal(recorded[0].totalEps, 12);

    // 第二条外部会话各自累加（kill 收敛后的新旧会话分别结清场景）
    player._curMeta = { site: 'site-b', vodId: '', title: '影片 Y', subtitle: '' };
    player._rememberExtSession({ viaExternal: true, sessionId: 9 });
    player._onExtPlayerExit({ sessionId: 9, wallSec: 30 });
    await player._watchWrite;
    assert.equal(settings.watchStats.totalSeconds, 120);
    assert.equal(settings.watchStats.sessionCount, 2);
});
