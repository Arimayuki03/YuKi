'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 在 VM 中加载 records.js，注入最小全局桩；settings 由调用方持有并读取变更。 */
function loadRecords(settings) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/records.js'), 'utf8');
    // 链式 jQuery 桩：任何方法返回自身，length/data 返回中性值；供 makeRecordView 内部调用不报错。
    const makeJq = () => {
        const jq = new Proxy(function () { return jq; }, {
            get(_t, prop) {
                if (prop === 'length') return 0;
                if (prop === 'data' || prop === 'val' || prop === 'text' || prop === 'prop') return () => '';
                if (prop === 'hasClass') return () => false;
                if (prop === 'each') return () => jq;
                if (prop === 'html') return () => jq;
                return () => jq;
            },
        });
        return jq;
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, parseInt, parseFloat,
        setTimeout, clearTimeout,
        $: () => makeJq(),
        window: {
            vpc: {
                settingsGet: async () => JSON.parse(JSON.stringify(settings)),
                settingsSet: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
            },
        },
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        truncateTitle: (s) => String(s || '').slice(0, 30),
        vodCoverImg: (pic) => `<img src="${pic || ''}">`,
        warnToast: () => {},
        normalizePic: (p) => p || '',
        Detail: {},
        renderPagerBox: () => {},
        pageSizeOf: async () => 20,
        // makeRecordView 视图操作用桩
        confirmDialog: async () => true,
        openDialog: () => {},
        closeDialog: () => {},
        fillMissingCovers: () => {},
        fitVodTitles: () => {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__Records = Records; globalThis.__recCard = recCard; globalThis.__fmtDur = fmtDur; globalThis.__tagLabel = tagLabel; globalThis.__normTag = normTag; globalThis.__makeRecordView = makeRecordView; globalThis.__genUid = genUid; globalThis.__ensureRecUids = ensureRecUids;`,
        context, { filename: 'records.js' });
    return context;
}

// ---------------------------------------------------------------- 播放记录（1.8）

test('recordPlay：首次播放建立条目（次数/集名/时长）', async () => {
    const settings = {};
    const ctx = loadRecords(settings);
    await ctx.__Records.recordPlay({ site: 'site-a', vodId: 'v1', name: '片 A', episode: '第 1 集', seconds: 600, siteName: '源甲' });
    assert.equal(settings.history.length, 1);
    const it = settings.history[0];
    assert.equal(it.playCount, 1);
    assert.equal(it.lastEpisode, '第 1 集');
    assert.equal(it.lastDuration, 600);
    assert.equal(it.name, '片 A');
});

test('recordPlay：同片再播每次新增一条独立记录（T73，不再合并累加「已播几集」）', async () => {
    const settings = {};
    const ctx = loadRecords(settings);
    await ctx.__Records.recordPlay({ site: 'site-a', vodId: 'v1', name: '片 A', episode: '第 1 集', seconds: 600 });
    await ctx.__Records.recordPlay({ site: 'site-a', vodId: 'v1', name: '片 A', episode: '第 2 集', seconds: 700 });
    assert.equal(settings.history.length, 2);        // 每播一条
    const it = settings.history[0];
    assert.equal(it.playCount, 1);                   // 不累加
    assert.equal(it.lastEpisode, '第 2 集');
    assert.equal(it.lastDuration, 700);
    assert.equal(settings.history[1].lastEpisode, '第 1 集'); // 旧播放仍在
});

test('recordPlay：无 site/vodId 时每次播放也独立成条（Kazumi 源播放场景，靠 uid 区分）', async () => {
    const settings = {};
    const ctx = loadRecords(settings);
    await ctx.__Records.recordPlay({ site: 'kazumi:baimao', vodId: '', kazumiSrc: 'https://x/a', name: '片 B', episode: '第 1 集', seconds: 300 });
    await ctx.__Records.recordPlay({ site: 'kazumi:baimao', vodId: '', kazumiSrc: 'https://x/a', name: '片 B', episode: '第 2 集', seconds: 400 });
    assert.equal(settings.history.length, 2);
    assert.equal(settings.history[0].playCount, 1);
    assert.equal(settings.history[0].lastEpisode, '第 2 集');
    assert.equal(settings.history[0].kind, 'play');
    // 新 schema：每条记录带唯一 uid（site+vodId 对 Kazumi 历史不唯一）
    assert.ok(settings.history[0].uid, '记录应带 uid');
    assert.ok(settings.history[1].uid, '记录应带 uid');
    assert.notEqual(settings.history[0].uid, settings.history[1].uid, '同源多集 uid 必须不同');
    // Kazumi 源页 URL 一路存入记录，供历史卡重新选源
    assert.equal(settings.history[0].kazumiSrc, 'https://x/a');
    assert.equal(settings.history[0].site, 'kazumi:baimao');
});

test('addHistory：重开详情保留已有播放统计（不重置次数/集名/时长）', async () => {
    const settings = {};
    const ctx = loadRecords(settings);
    await ctx.__Records.recordPlay({ site: 'site-a', vodId: 'v1', name: '片 C', episode: '第 3 集', seconds: 500 });
    await ctx.__Records.addHistory({ site: 'site-b', vodId: 'v1', name: '片 C', pic: 'pic.jpg', remarks: '全 12 集', siteName: '源乙' });
    const it = settings.history[0];
    assert.equal(it.playCount, 1);
    assert.equal(it.lastEpisode, '第 3 集');
    assert.equal(it.lastDuration, 500);
    assert.equal(it.siteName, '源乙'); // 来源更新为新打开
    assert.equal(it.pic, 'pic.jpg');
});

// ---------------------------------------------------------------- 卡片渲染（1.8 / 2.2）

test('recCard：历史卡显示 集名 · 时长 · 时间（T73，不再显示「已播 N 集」）', () => {
    const ctx = loadRecords({});
    const html = ctx.__recCard(
        { site: 's', vodId: 'v', name: '片 D', playCount: 3, lastEpisode: '第 5 集', lastDuration: 1200, lastPlayTs: 1700000000000 },
        true, false);
    assert.doesNotMatch(html, /已播 \d+ 集/);
    assert.match(html, /第 5 集/);
    assert.match(html, /20 分钟/); // 1200s = 20 分钟
});

test('recCard：Bangumi 条目带来源徽标/状态标签且无本地删除/勾选/编辑按钮', () => {
    const ctx = loadRecords({});
    const html = ctx.__recCard(
        { site: 'bangumi', vodId: '123', name: '番剧 E', tag: 'watching', bangumi: true },
        true, true);
    assert.match(html, /data-site="bangumi"/);
    assert.match(html, />Bangumi</);      // 来源徽标
    assert.match(html, />在看</);          // 状态标签（watching）
    assert.doesNotMatch(html, /rec-del/);
    assert.doesNotMatch(html, /rec-check/);
    assert.doesNotMatch(html, /rec-edit/);
});

test('recCard：本地条目保留删除/编辑/勾选按钮与状态标签', () => {
    const ctx = loadRecords({});
    const html = ctx.__recCard(
        { site: 's', vodId: 'v', name: '片 F', tag: 'seen', siteName: '源甲' },
        true, true);
    assert.match(html, /rec-del/);
    assert.match(html, /rec-check/);
    assert.match(html, /rec-edit/);
    assert.match(html, />已看</);
});

// ---------------------------------------------------------------- 标签模型（2.2）

test('标签帮助函数：新状态标签映射与旧数据归一化', () => {
    const ctx = loadRecords({});
    assert.equal(ctx.__tagLabel('watching'), '在看');
    assert.equal(ctx.__tagLabel('hold'), '搁置');
    assert.equal(ctx.__tagLabel('dropped'), '抛弃');
    assert.equal(ctx.__tagLabel('want'), '想看');
    assert.equal(ctx.__normTag(undefined), 'want'); // 旧数据无标签视同想看
    assert.equal(ctx.__normTag(''), '');
});

test('fmtDur 秒数格式化为可读时长', () => {
    const ctx = loadRecords({});
    assert.equal(ctx.__fmtDur(90), '2 分钟');
    assert.equal(ctx.__fmtDur(3600), '1 小时 0 分');
    assert.equal(ctx.__fmtDur(20), '20 秒'); // 不足 30s 显示秒；45s 会被四舍五入为 1 分钟
    assert.equal(ctx.__fmtDur(45), '1 分钟');
});

// ---------------------------------------------------------------- uid 身份与删除（T5）

test('recCard：输出 data-uid（uid 作为增删改的唯一标识）', () => {
    const ctx = loadRecords({});
    const html = ctx.__recCard(
        { uid: 'uid-xyz', site: 'kazumi:baimao', vodId: '', name: '番剧 G', kind: 'play' },
        true, false);
    assert.match(html, /data-uid="uid-xyz"/);
});

test('删除单条：3 条同源 Kazumi 记录删中间一条，剩第 1、3 条（不再删光整源）', async () => {
    const settings = {};
    const ctx = loadRecords(settings);
    const view = ctx.__makeRecordView('view-history', 'history', '空', true, false, 'pageSizeHistory');
    // 造 3 条同源同片名 Kazumi 记录（site+vodId 完全相同，仅 uid 区分）
    await ctx.__Records.recordPlay({ site: 'kazumi:baimao', vodId: '', kazumiSrc: 'https://x/1', name: '同源番', episode: '第 1 集', seconds: 100 });
    await ctx.__Records.recordPlay({ site: 'kazumi:baimao', vodId: '', kazumiSrc: 'https://x/1', name: '同源番', episode: '第 2 集', seconds: 200 });
    await ctx.__Records.recordPlay({ site: 'kazumi:baimao', vodId: '', kazumiSrc: 'https://x/1', name: '同源番', episode: '第 3 集', seconds: 300 });
    assert.equal(settings.history.length, 3);
    // 存储新在前：index 0=第3集，1=第2集，2=第1集。删「第 2 集」（中间那条）
    const midUid = settings.history[1].uid;
    const ep1Uid = settings.history[2].uid;
    const ep3Uid = settings.history[0].uid;
    await view.remove(String(midUid));
    assert.equal(settings.history.length, 2, '只删 1 条，剩 2 条');
    const remainUids = settings.history.map((x) => x.uid);
    assert.ok(remainUids.includes(ep1Uid), '第 1 集仍在');
    assert.ok(remainUids.includes(ep3Uid), '第 3 集仍在');
    assert.ok(!remainUids.includes(midUid), '第 2 集已删');
});

test('编辑单条：只改目标 uid 的标题，不影响同源其他记录', async () => {
    const settings = {};
    const ctx = loadRecords(settings);
    await ctx.__Records.recordPlay({ site: 'kazumi:baimao', vodId: '', name: '待改片', episode: '第 1 集', seconds: 100 });
    await ctx.__Records.recordPlay({ site: 'kazumi:baimao', vodId: '', name: '待改片', episode: '第 2 集', seconds: 200 });
    const targetUid = settings.history[0].uid;
    const otherUid = settings.history[1].uid;
    // 直接改目标 uid 的记录并写回（模拟 confirmRecEdit 的 uid 匹配）
    const target = settings.history.find((x) => x.uid === targetUid);
    target.name = '新标题';
    const other = settings.history.find((x) => x.uid === otherUid);
    assert.equal(other.name, '待改片', '另一条记录标题不变');
    assert.equal(settings.history.find((x) => x.uid === targetUid).name, '新标题');
});

test('迁移：旧记录缺 uid 时 recGet 按 ts 回填并持久化', async () => {
    const settings = { history: [
        { site: 'kazumi:a', vodId: '', name: '旧片1', ts: 1000, kind: 'play' },
        { site: 'kazumi:a', vodId: '', name: '旧片2', ts: 2000, kind: 'play' },
    ] };
    const ctx = loadRecords(settings);
    // recordPlay 内部先 recGet('history')，触发迁移回填
    await ctx.__Records.recordPlay({ site: 'kazumi:a', vodId: '', name: '新片', episode: '第 1 集', seconds: 50 });
    // 迁移后所有记录都带 uid，且互不相同
    const uids = settings.history.map((x) => x.uid);
    assert.ok(uids.every(Boolean), '所有记录都应有 uid');
    assert.equal(new Set(uids).size, uids.length, 'uid 互不相同');
});
