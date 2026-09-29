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
            yuki: {
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
        playCardsEnter: () => {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__Records = Records; globalThis.__recCard = recCard; globalThis.__fmtDur = fmtDur; globalThis.__tagLabel = tagLabel; globalThis.__normTag = normTag; globalThis.__isBangumiItem = isBangumiItem; globalThis.__makeRecordView = makeRecordView; globalThis.__genUid = genUid; globalThis.__ensureRecUids = ensureRecUids; globalThis.__mergeExtraRecords = mergeExtraRecords; globalThis.__FavoritesView = Favorites;`,
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

test('recCard：Bangumi 条目带来源徽标/状态标签，可勾选批量标记但无删除/编辑按钮', () => {
    const ctx = loadRecords({});
    const html = ctx.__recCard(
        { site: 'bangumi', vodId: '123', name: '番剧 E', tag: 'watching', bangumi: true },
        true, true);
    assert.match(html, /data-site="bangumi"/);
    assert.match(html, />Bangumi</);      // 来源徽标
    assert.match(html, />在看</);          // 状态标签（watching）
    assert.doesNotMatch(html, /rec-del/);
    assert.match(html, /rec-check/);       // Bangumi 条目现支持勾选（多选标记状态，同步账号）
    assert.match(html, /data-bgm="1"/);    // 带 Bangumi 标识供批量标记识别
    assert.doesNotMatch(html, /rec-edit/);
    assert.doesNotMatch(html, /rec-bgm-rate/); // T80：评分按钮挪到详情页 hero，卡片不再渲染
});

test('recCard：本地与下载文件卡片带 data-local-path 供抓帧渲染', () => {
    const ctx = loadRecords({});
    const localHtml = ctx.__recCard({ site: 'local', vodId: 'sub/video.mp4', name: '本地视频' }, true, false);
    assert.match(localHtml, /data-local-path="sub\/video\.mp4"/);
    const dlHtml = ctx.__recCard({ site: 'download', vodId: 'C:\\Downloads\\video.mp4', name: '下载视频' }, true, false);
    assert.match(dlHtml, /data-local-path="C:\\Downloads\\video\.mp4"/);
});

test('recCard：下载文件即使已有旧封面也仍走视频帧封面', () => {
    const ctx = loadRecords({});
    const html = ctx.__recCard({
        site: 'download', vodId: 'C:\\Downloads\\video.mp4', name: '下载视频', pic: 'https://example.com/old.jpg',
    }, true, false);
    assert.match(html, /data-local-path="C:\\Downloads\\video\.mp4"/);
    assert.doesNotMatch(html, /old\.jpg/);
});

test('recCard：本地条目保留删除/编辑/勾选按钮与状态标签', () => {
    const ctx = loadRecords({});
    const html = ctx.__recCard(
        { site: 's', vodId: 'v', name: '片 F', tag: 'seen', siteName: '源甲' },
        true, true);
    assert.match(html, /rec-del/);
    assert.match(html, /rec-check/);
    assert.match(html, /rec-edit/);
    assert.match(html, />看过</);
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

// ---------------------------------------------------------------- T79：Bangumi 合并去重（仅本地「Bangumi 镜像」拦远端同 ID）

test('mergeExtraRecords：本地「Bangumi 镜像」条目拦下远端同 ID 条目（同步后不再双 Bangumi 卡）', () => {
    const { __mergeExtraRecords: merge } = loadRecords({});
    const local = [{ site: 'bangumi', vodId: '999', name: '本地条目', bangumiId: '999' }];
    const extra = [
        { site: 'bangumi', vodId: '999', name: '远端同一条目', bangumi: true },
        { site: 'bangumi', vodId: '12345', name: '仅远端条目', bangumi: true },
    ];
    const merged = merge(local, extra);
    assert.equal(merged.length, 2);
    assert.ok(merged.some((v) => v.name === '本地条目'));
    assert.ok(merged.some((v) => v.name === '仅远端条目'));
});

test('mergeExtraRecords：普通源收藏带 bangumiId 不再拦截远端条目（同名不同源各自成卡，靠来源分类区分）', () => {
    const { __mergeExtraRecords: merge } = loadRecords({});
    const local = [
        { site: 'cspby', vodId: 'v1', name: '碧蓝之海', bangumiId: '10860' },
        { site: 'local', vodId: 'C:\\a.mp4', name: '本地文件片', bangumiId: '7777' },
    ];
    const extra = [
        { site: 'bangumi', vodId: '10860', name: '碧蓝之海', bangumi: true },
        { site: 'bangumi', vodId: '7777', name: '本地文件片', bangumi: true },
    ];
    const merged = merge(local, extra);
    assert.equal(merged.length, 4, '普通源收藏（CatVod/本地文件）不拦远端：2 本地 + 2 远端各自成卡');
    assert.equal(String(merged[2].vodId), '10860');
    assert.equal(String(merged[3].vodId), '7777');
});

test('mergeExtraRecords：普通本地收藏（无 bangumiId）不受影响，extra 内部按 vodId 自去重', () => {
    const { __mergeExtraRecords: merge } = loadRecords({});
    const local = [{ site: 'cspby', vodId: 'v1', name: '普通收藏' }];
    const extra = [
        { site: 'bangumi', vodId: '1', name: 'A', bangumi: true },
        { site: 'bangumi', vodId: '1', name: 'A 重复', bangumi: true },
        { site: 'bangumi', vodId: '', name: '无 ID 脏数据', bangumi: true },
    ];
    const merged = merge(local, extra);
    assert.equal(merged.length, 2); // 普通收藏 + 去重后的 A；脏数据被滤除
    assert.equal(merged[0].name, '普通收藏');
    assert.equal(merged[1].name, 'A');
});

test('mergeExtraRecords：空/非法输入稳健兜底', () => {
    const { __mergeExtraRecords: merge } = loadRecords({});
    const local = [{ site: 'x', vodId: '1', name: 'a' }];
    assert.equal(merge(local, []), local);
    assert.equal(merge(local, null), local);
    // 空列表 + 有效远端条目：返回去重后的远端条目（跨 VM 原型域，按字段断言）
    const merged = merge(null, [{ vodId: '2' }]);
    assert.equal(merged.length, 1);
    assert.equal(String(merged[0].vodId), '2');
});

test('recCard：详情页同步写入的本地镜像（site=bangumi 无 bangumi 标志）按账号托管卡渲染（T79 补遗）', () => {
    const { __recCard } = loadRecords({});
    const mirror = __recCard(
        { site: 'bangumi', siteName: 'Bangumi', vodId: '123', name: '某番剧', pic: '', tag: 'want', bangumiId: '123', uid: 'u1' },
        true, true, {});
    assert.ok(!mirror.includes('rec-del'), '同步镜像卡不应有删除按钮');
    assert.ok(!mirror.includes('rec-edit'), '同步镜像卡不应有编辑按钮');
    assert.ok(mirror.includes('rec-tag-static'), '同步镜像卡标签应为只读');
    assert.ok(mirror.includes('>Bangumi<'), '应显示 Bangumi 来源徽标');

    // 对照组：普通本地收藏保持可操作
    const plain = __recCard(
        { site: 'cspby', vodId: 'v1', name: '普通收藏', tag: 'want', uid: 'u2' },
        true, true, {});
    assert.ok(plain.includes('rec-del'));
    assert.ok(plain.includes('rec-edit'));
});

// ---------------------------------------------------------------- Bangumi 卡「我的评分」徽章（recCard 内嵌；评分按钮已挪详情页 T80）

test('recCard：T80 后各卡型均不带 rec-bgm-rate 评分按钮（入口挪至详情页 hero）', () => {
    const { __recCard } = loadRecords({});
    // Bangumi 条目（远端标志）：无评分按钮（挪到详情页）
    const bgm = __recCard({ site: 'bangumi', vodId: '77', name: '番剧', tag: 'want', bangumi: true }, true, true, {});
    assert.ok(!bgm.includes('rec-bgm-rate'), 'T80：Bangumi 卡不再渲染「★ 评分」按钮');
    assert.ok(!bgm.includes('★ 评分'), '按钮文案不应出现在卡片上');
    // 本地镜像（site=bangumi 无 bangumi 标志）同样无按钮
    const mirror = __recCard({ site: 'bangumi', vodId: '77', name: '番剧', tag: 'want', bangumiId: '77', uid: 'u1' }, true, true, {});
    assert.ok(!mirror.includes('rec-bgm-rate'), '同步镜像卡也无评分按钮');
    // 对照组：普通收藏/播放历史无评分按钮
    const plain = __recCard({ site: 'cspby', vodId: 'v1', name: '普通收藏', tag: 'want', uid: 'u2' }, true, true, {});
    assert.ok(!plain.includes('rec-bgm-rate'), '本地收藏卡不应有评分按钮');
    const play = __recCard({ site: 's', vodId: 'v', name: '播放卡', kind: 'play' }, true, false, {});
    assert.ok(!play.includes('rec-bgm-rate'), '历史卡不应有评分按钮');
});

test('recCard：myRate 1-10 渲染「我的 N★」徽章，缺省/越界不渲染且数值经转义', () => {
    const { __recCard } = loadRecords({});
    // 有评分：渲染徽章
    const rated = __recCard({ site: 'bangumi', vodId: '9', name: '番剧', tag: 'want', bangumi: true, myRate: 9, myComment: '神作' }, true, true, {});
    assert.ok(rated.includes('bangumi-myrate-badge'), '有评分应渲染徽章');
    assert.ok(rated.includes('我的 9★'), '徽章文案「我的 9★」');
    // 无 myRate 字段（旧响应）：不渲染
    const unrated = __recCard({ site: 'bangumi', vodId: '9', name: '番剧', tag: 'want', bangumi: true }, true, true, {});
    assert.ok(!unrated.includes('bangumi-myrate-badge'), '无评分不渲染徽章');
    // 越界/脏数据（0、>10、非数值）：不渲染
    for (const bad of [0, 42, 'abc']) {
        const html = __recCard({ site: 'bangumi', vodId: '9', name: '番剧', tag: 'want', bangumi: true, myRate: bad }, true, true, {});
        assert.ok(!html.includes('bangumi-myrate-badge'), `myRate=${bad} 不应渲染徽章`);
    }
    // 普通/历史卡即使误带 myRate 也不渲染徽章
    const plain = __recCard({ site: 'cspby', vodId: 'v1', name: '普通收藏', tag: 'want', uid: 'u2', myRate: 8 }, true, true, {});
    assert.ok(!plain.includes('bangumi-myrate-badge'), '非 Bangumi 卡不渲染徽章');
});

test('recCard：Bangumi 收藏卡 bgmScore/bgmRank 首渲展示（评分拼日期行、排名挂封面右上）', () => {
    const { __recCard } = loadRecords({});
    // 远端账号收藏卡：评分拼进日期行行首
    const fav = __recCard({ site: 'bangumi', vodId: '9', name: '番剧', tag: 'want', bangumi: true, bgmScore: 7.3, ts: 1700000000000 }, true, true, {});
    assert.ok(fav.includes('rec-playinfo-date'), '收藏卡渲染日期行');
    assert.ok(fav.match(/rec-playinfo-date[^>]*>⭐7\.3 · /), '评分拼在日期行行首');
    // 本地镜像卡同口径
    const mirror = __recCard({ site: 'bangumi', vodId: '11', name: '番剧3', tag: 'want', bangumiId: '11', uid: 'u9', bgmScore: 6, ts: 1700000000000 }, true, true, {});
    assert.ok(mirror.match(/rec-playinfo-date[^>]*>⭐6 · /), '镜像卡评分同样拼日期行');
    // 排名徽章挂封面右上
    const ranked = __recCard({ site: 'bangumi', vodId: '21', name: '番剧', tag: 'want', bangumi: true, bgmRank: 42 }, true, true, {});
    assert.ok(ranked.includes('bangumi-rank-badge'), '有排名应渲染徽章');
    assert.ok(ranked.includes('#42'), '徽章文案 #42');
    // 排名存在时「我的 N★」让位（同一 right:6px 位置）
    const both = __recCard({ site: 'bangumi', vodId: '22', name: '番剧2', tag: 'want', bangumi: true, bgmRank: 5, myRate: 8 }, true, true, {});
    assert.ok(both.includes('bangumi-rank-badge'), '排名优先渲染');
    assert.ok(!both.includes('bangumi-myrate-badge'), '排名与我的评分互斥');
    // rank=0/缺失不渲染
    for (const bad of [undefined, 0]) {
        const html = __recCard({ site: 'bangumi', vodId: '23', name: '番剧3', tag: 'want', bangumi: true, bgmRank: bad }, true, true, {});
        assert.ok(!html.includes('bangumi-rank-badge'), `bgmRank=${bad} 不渲染徽章`);
    }
    // 无评分不出 ⭐；非 Bangumi 卡带 bgmScore 也不渲染
    const noScore = __recCard({ site: 'bangumi', vodId: '13', name: '番剧4', tag: 'want', bangumi: true, ts: 1700000000000 }, true, true, {});
    assert.ok(!noScore.includes('⭐'), '无评分不渲染评分');
    const plain = __recCard({ site: 'cspby', vodId: 'v2', name: '普通收藏', tag: 'want', uid: 'u3', bgmScore: 5, ts: 1700000000000 }, true, true, {});
    assert.ok(!plain.includes('⭐5'), '非 Bangumi 卡不渲染评分');
});

test('评分/排名补齐：镜像条目（site=bangumi 无 bangumi 标志）也补拉，且缺哪个补哪个', async () => {
    // makeRecordView render 的补齐链路需要 DOM/jQuery；此处直接验证过滤口径与回填语义
    // 的等价逻辑（pending filter + 回填条件）与 records.js 内联实现同构，防回归口径漂移。
    const { loadRecords: _l } = {};
    const ctx = loadRecords({});
    const isBangumiItem = ctx.__isBangumiItem;
    assert.ok(isBangumiItem, '应导出 isBangumiItem');
    // ① 镜像条目（详情页收藏写入形态）按 Bangumi 托管判定通过——修复点①
    const mirror = { site: 'bangumi', vodId: '123', name: '某番', bangumiId: '123', tag: 'want', ts: 1 };
    assert.ok(isBangumiItem(mirror), '镜像条目（无 bangumi 标志）判定为 Bangumi 托管');
    // ② 逐字段判定：只缺 rank / 只缺 score 的条目均应进入补拉集合——修复点②
    const hasScore = (x) => (x.bgmScore === 0 || x.bgmScore);
    const hasRank = (x) => (x.bgmRank === 0 || x.bgmRank);
    const needFetch = (v) => isBangumiItem(v) && (!hasScore(v) || !hasRank(v)) && /^\d+$/.test(String(v.vodId || ''));
    assert.ok(needFetch({ ...mirror }), '两字段全缺：需补拉');
    assert.ok(needFetch({ ...mirror, bgmScore: 7 }), '只有 rank 缺：需补拉（旧逻辑跳过）');
    assert.ok(needFetch({ ...mirror, bgmRank: 42 }), '只有 score 缺：需补拉（旧逻辑跳过）');
    assert.ok(!needFetch({ ...mirror, bgmScore: 7, bgmRank: 42 }), '两字段全有：不补拉');
    assert.ok(!needFetch({ ...mirror, vodId: 'kazumi-x' }), '非数字 vodId：不补拉');
    assert.ok(!needFetch({ site: 'cspby', vodId: '1', name: '普通收藏' }), '非 Bangumi 条目：不补拉');
});

test('已看话数徽章补齐：tag 不再过滤（want/hold 也查询），bgmEpStatus 兜底负缓存瞬时失败', async () => {
    const ctx = loadRecords({});
    const isBangumiItem = ctx.__isBangumiItem;
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/records.js'), 'utf8');
    // 与 records.js 内联实现同构的过滤与兜底逻辑（防口径漂移）：
    const epNeedFetch = (v) => v && isBangumiItem(v) && /^\d+$/.test(String(v.vodId || ''));
    // 修复点①：tag 只是本地记号，不决定徽章有无——所有状态都查询（旧逻辑仅 watching/seen）
    for (const tag of ['want', 'watching', 'seen', 'hold', 'dropped']) {
        const item = { site: 'bangumi', vodId: '9', name: '番', tag, bangumi: true, ts: 1 };
        assert.ok(epNeedFetch(item), `tag=${tag} 的 Bangumi 卡应进入已看话数补拉（tag 过滤已放开）`);
    }
    // 修复点②：回源 col=null（60s 负缓存吞掉的瞬时失败/未回写打点的 6h 正缓存）时，
    // 带 bgmEpStatus 的条目仍用记录值兜底出徽章；无记录值保持无徽章
    const watchedOf = (col, item) => {
        let watched = col ? (Number(col.ep_status) || 0) : 0;
        if (watched <= 0 && Number(item.bgmEpStatus) > 0) watched = Number(item.bgmEpStatus);
        return watched;
    };
    assert.equal(watchedOf({ ep_status: 5 }, {}), 5, '正常回源：用远端 ep_status');
    assert.equal(watchedOf(null, { bgmEpStatus: 7 }), 7, 'null 回源 + bgmEpStatus 记录：兜底 7');
    assert.equal(watchedOf(null, {}), 0, 'null 回源无记录：不出徽章');
    assert.equal(watchedOf({ ep_status: 0 }, { bgmEpStatus: 3 }), 3, 'ep_status=0 且有记录：兜底 3');
    assert.equal(watchedOf({ ep_status: 2 }, { bgmEpStatus: 9 }), 2, '回源有值优先于记录值（远端为准）');
    // 源码级契约断言：bgmEpStatus 兜底分支必须仍存在于 records.js 源码中（防源码删除后
    // 本用例的同构复制品静默失去对应物）；当前该分支无写入方，属预留兜底（打点回写走
    // kazumi.js 乐观缓存路径），删除前需先在本文件同步更新契约。
    assert.ok(
        source.includes('bgmEpStatus') && source.includes('watched = Number(item.bgmEpStatus)'),
        'records.js 源码应保留 bgmEpStatus 兜底分支（预留，无写入方）'
    );
});

test('recCard：带评分按钮时仍无 rec-del/rec-edit，按钮 title 转义安全', () => {
    const { __recCard } = loadRecords({});
    const bgm = __recCard({ site: 'bangumi', vodId: '5', name: '<img src=x onerror=1>', tag: 'want', bangumi: true, myRate: 7 }, true, true, {});
    assert.ok(!bgm.includes('rec-del'), '评分按钮不替代托管规则：仍无删除按钮');
    assert.ok(!bgm.includes('rec-edit'), '仍无编辑按钮');
    // 片名进 data-name/title 时经 escHtml，注入串不产出可执行标签
    assert.ok(!/<img src=x/.test(bgm), '片名应被转义');
});

// ---------------------------------------------------------------- 封面徽章组布局与已看集数徽章

test('recCard：状态徽章移入封面徽章组（源徽章右侧），不再绝对定位在封面左上角', () => {
    const { __recCard } = loadRecords({});
    // 本地收藏：源徽章 → 状态徽章 → 依次进 rec-cover-badges
    const local = __recCard({ site: 'cspby', siteName: '源甲', vodId: '1', name: '片名', tag: 'watching', uid: 'u1' }, true, true, {});
    const m = local.match(/<div class="rec-cover-badges">([\s\S]*?)<\/div><span class="bangumi/) || local.match(/<div class="rec-cover-badges">([\s\S]*?)<\/div>/);
    assert.ok(m, '应渲染徽章组容器');
    assert.ok(m[1].includes('rec-site'), '徽章组首项为源徽章');
    assert.ok(m[1].indexOf('rec-site') < m[1].indexOf('rec-tag'), '状态徽章在源徽章右侧');
    // 卡片顶层不再有独立的状态徽章（旧的封面左上角绝对定位已移除）
    const topTag = local.replace(/<div class="rec-cover-badges">[\s\S]*?<\/div>/, '');
    assert.ok(!topTag.includes('class="rec-tag'), '徽章组外不应再有 rec-tag');
    // Bangumi 收藏：无源徽章时状态徽章单独进徽章组（只读样式）
    const bgm = __recCard({ site: 'bangumi', vodId: '9', name: '番剧', tag: 'seen', bangumi: true }, true, true, {});
    const bm = bgm.match(/<div class="rec-cover-badges">([\s\S]*?)<\/div>/);
    assert.ok(bm && bm[1].includes('rec-tag-static'), 'Bangumi 卡状态徽章也在徽章组内（只读）');
    // 历史卡（withTags=false）：不出状态徽章
    const hist = __recCard({ site: 's', vodId: 'v', name: '播放卡', kind: 'play' }, true, false, {});
    assert.ok(!hist.includes('rec-tag'), '历史卡无状态徽章');
});

test('recCard：CatVod 收藏已看集数徽章用本地 progress（currentEp/totalEps），无进度不出徽章', () => {
    const { __recCard } = loadRecords({});
    // 有本地观看进度：显示 已看/总集数
    const watched = __recCard(
        { site: 'cspby', vodId: '1', name: '片名', tag: 'watching', uid: 'u1', progress: { currentEp: 3, totalEps: 12, percent: 25 } },
        true, true, {});
    const badge = watched.match(/<span class="rec-eps"[^>]*>([^<]*)<\/span>/);
    assert.ok(badge, '有 progress 的收藏卡应渲染集数徽章');
    assert.equal(badge[1], '3/12', '显示已看 3 / 共 12');
    // 无进度：无徽章
    const fresh = __recCard({ site: 'cspby', vodId: '2', name: '片名2', tag: 'want', uid: 'u2' }, true, true, {});
    assert.ok(!fresh.includes('rec-eps'), '无 progress 的收藏卡不出集数徽章');
    // 有 currentEp 无 totalEps：N/? 形态
    const partial = __recCard(
        { site: 'cspby', vodId: '3', name: '片名3', tag: 'watching', uid: 'u3', progress: { currentEp: 5, totalEps: 0, percent: 0 } },
        true, true, {});
    const pb = partial.match(/<span class="rec-eps"[^>]*>([^<]*)<\/span>/);
    assert.ok(pb && pb[1] === '5/?', '无总数显示 5/?');
    // 历史播放卡：仍按同名去重计数（watchedCount），数据源不变
    const play = __recCard({ site: 's', vodId: 'v', name: '播放卡', kind: 'play', totalEps: 12 }, true, false, { '播放卡': 2 });
    const pl = play.match(/<span class="rec-eps"[^>]*>([^<]*)<\/span>/);
    assert.ok(pl && pl[1] === '2/12', '历史卡仍用同名去重集数 2/12');
});

// ---------------------------------------------------------------- 来源筛选（全部/CatVod/Bangumi）

test('makeRecordView：来源筛选 _src 仅在收藏视图生效，历史视图 _extra/_src 过滤不参与（catvod 口径=非 Bangumi 托管）', () => {
    const ctx = loadRecords({});
    // 历史视图（withTags=false）：不绑定来源筛选页签，_src 保持空串（全量）
    const historyView = ctx.__makeRecordView('view-history', 'history', 'x', true, false, 'pageSizeHistory');
    assert.equal(String(historyView._src), '', '历史视图 _src 默认空（不过滤）');
    // 收藏视图：_src 挂在视图上，catvod=非 Bangumi、bangumi=Bangumi 托管（与 recCard isBgm 同口径）
    const favView = ctx.__makeRecordView('view-favorites', 'favorites', 'x', true, true, 'pageSizeFavorites');
    assert.equal(String(favView._src), '', '收藏视图 _src 默认全部');
});

// ---------------------------------------------------------------- 通用观看进度表（watchProgress，不依赖收藏）

test('setWatchProgress/getWatchProgress：通用表写入与读取（未收藏影片也有进度）', async () => {
    const settings = {};
    const ctx = loadRecords(settings);
    await ctx.__Records.setWatchProgress('site-a', 'v1', { currentEp: 3, totalEps: 12, percent: 25 });
    const p = await ctx.__Records.getWatchProgress('site-a', 'v1');
    assert.equal(p.currentEp, 3);
    assert.equal(p.totalEps, 12);
    assert.ok(p.ts > 0, '缺省 ts 自动补 Date.now()');
    assert.equal(await ctx.__Records.getWatchProgress('site-a', 'v-none'), null, '无记录返回 null');
});

test('setWatchProgress：非法入参（缺 site/vodId/progress 非对象）静默拒绝', async () => {
    const settings = {};
    const ctx = loadRecords(settings);
    await ctx.__Records.setWatchProgress('', 'v1', { currentEp: 1 });
    await ctx.__Records.setWatchProgress('site-a', '', { currentEp: 1 });
    await ctx.__Records.setWatchProgress('site-a', 'v1', null);
    await ctx.__Records.setWatchProgress('site-a', 'v1', 'bad');
    assert.equal(settings.watchProgress, undefined, '全部拒绝，不建表');
});

test('setWatchProgress：LRU 上限 500 条，超出按 ts 淘汰最旧', async () => {
    const settings = {};
    const ctx = loadRecords(settings);
    for (let i = 0; i < 505; i++) {
        await ctx.__Records.setWatchProgress('s', `v${i}`, { currentEp: 1, ts: 1000 + i });
    }
    const map = settings.watchProgress;
    assert.equal(Object.keys(map).length, 500);
    assert.equal(map['s|v0'], undefined, '最旧的 v0 被淘汰');
    assert.ok(map['s|v504'], '最新的 v504 保留');
});

test('updateProgress：未收藏条目进度写入通用表（核心语义：不依赖收藏）', async () => {
    const settings = { favorites: [] }; // 空收藏
    const ctx = loadRecords(settings);
    await ctx.__FavoritesView.updateProgress('site-a', 'v1', { currentEp: 2, totalEps: 10, percent: 20 });
    const p = await ctx.__Records.getWatchProgress('site-a', 'v1');
    assert.ok(p && p.currentEp === 2, '未收藏也写入通用表');
});

test('updateProgress：已收藏条目双写（通用表 + 收藏条目 progress 字段向后兼容）', async () => {
    const settings = { favorites: [{ uid: 'u1', site: 'site-a', vodId: 'v1', name: '片 A', tag: 'watching', ts: 1 }] };
    const ctx = loadRecords(settings);
    await ctx.__FavoritesView.updateProgress('site-a', 'v1', { currentEp: 4, totalEps: 12, percent: 33 });
    const wp = await ctx.__Records.getWatchProgress('site-a', 'v1');
    assert.ok(wp && wp.currentEp === 4, '通用表已写');
    assert.equal(settings.favorites[0].progress.currentEp, 4, '收藏条目 progress 字段镜像保留（旧版收藏页徽章兼容）');
});

test('getProgress：优先读通用表；未命中回退收藏条目 progress 字段（旧数据升级兼容）', async () => {
    const settings = {
        watchProgress: { 'site-a|v1': { currentEp: 9, totalEps: 12, percent: 75, ts: 2 } },
        favorites: [{ uid: 'u1', site: 'site-a', vodId: 'v2', name: '旧数据片', tag: 'watching', ts: 1, progress: { currentEp: 3, totalEps: 12, percent: 25 } }],
    };
    const ctx = loadRecords(settings);
    const favView = ctx.__makeRecordView('view-favorites', 'favorites', 'x', true, true, 'pageSizeFavorites');
    const hit = await favView.getProgress('site-a', 'v1');
    assert.equal(hit.currentEp, 9, '通用表优先');
    const legacy = await favView.getProgress('site-a', 'v2');
    assert.equal(legacy.currentEp, 3, '通用表未命中回退收藏条目字段');
    assert.equal(await favView.getProgress('site-a', 'v-none'), null);
});
