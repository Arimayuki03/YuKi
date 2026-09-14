'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

// RM-5：看完自动上报 Bangumi 观看进度。加载 kazumi.js 到隔离 VM（桩同 kazumi-bgm-upload.test.js），
// 编排 settings 开关 / token / 片名匹配 / 分集列表 / 后端 action，验证打点与收藏联动。
function loadKazumi(extra = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/kazumi.js'), 'utf8');
    const jqueryStub = () => ({
        on() { return this; },
        off() { return this; },
        val() { return ''; },
        text() { return this; },
        html() { return this; },
        show() { return this; },
        hide() { return this; },
        empty() { return this; },
        append() { return this; },
        prop() { return this; },
        toggle() { return this; },
        length: 1,
    });
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Number,
        parseInt, parseFloat, setTimeout, clearTimeout,
        $: jqueryStub,
        warnToast() {},
        window: { yuki: {} },
        ...extra,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testKazumi = Kazumi;`, context, { filename: 'kazumi.js' });
    return context.__testKazumi;
}

// 受控环境：eps 为 Bangumi 分集列表（含 1 个 type=1 SP 用于验证只匹配本篇）。
function makeHarness(opts = {}) {
    const actions = [];
    const setCalls = [];
    const toasts = [];
    const eps = opts.eps || [
        { id: 9001, type: 0, ep: 1, name: 'EP1', name_cn: '第1话' },
        { id: 9002, type: 0, ep: 2, name: 'EP2', name_cn: '第2话' },
        { id: 9003, type: 0, ep: 3, name: 'EP3', name_cn: '第3话' },
        { id: 9005, type: 0, ep: 4, name: 'OVA', name_cn: '花嫁' },
        { id: 9101, type: 1, ep: 1, name: 'SP', name_cn: '总集篇' },
    ];
    const kazumi = loadKazumi({
        warnToast: (m) => toasts.push(String(m)),
        window: { yuki: { settingsGet: async () => ({
            bangumiToken: 'tok',
            bangumiImmediateSyncToastEnable: false,
            bangumiProgressSync: opts.sync !== false,
        }) } },
        doAction: async (action, params) => {
            actions.push({ action, params });
            if (action === 'kazumiBangumiEpisodes') {
                // 后端透传 Bangumi /v0/episodes 包装对象 {data, total}——走真实 bangumiEpisodes
                // 解包（回归防：曾直接把该方法换成数组桩，掩盖了 .filter 抛 TypeError 的静默失效）
                if (opts.epsFail) return { code: 500, msg: 'boom' };
                return { code: 200, episodes: { data: eps, total: eps.length } };
            }
            if (action === 'kazumiBangumiEpisodeWatched') {
                if (opts.watchFail) return { code: 400, msg: opts.watchFail };
                return { code: 200, msg: 'ok' };
            }
            if (action === 'kazumiBangumiEpisodeCollections') {
                return { code: 200, items: opts.epCols === undefined
                    ? [{ episode_id: 9001, type: 2 }, { episode_id: 9002, type: 2 }, { episode_id: 9003, type: 2 }]
                    : opts.epCols };
            }
            if (action === 'kazumiBangumiCollectionGet') {
                return { code: 200, collection: opts.col === undefined ? null : opts.col };
            }
            if (action === 'kazumiBangumiCollectionSet') {
                setCalls.push({ id: String(params.id), type: params.type });
                return { code: 200 };
            }
            return { code: 200 };
        },
    });
    kazumi._getBangumiToken = async () => (opts.noToken ? '' : 'tok');
    kazumi.getBangumiMatch = async (name) => ({ id: (opts.match && opts.match[name]) || 0, cover: '' });
    return { kazumi, actions, setCalls, toasts };
}

/** 等待上报串行链清空。 */
function drain(kazumi) { return kazumi._bgmProgressChain.catch(() => {}); }

const META = { site: '量子资源', vodId: 'v1', title: '测试番', kazumiSrc: '' };
const MATCH = { match: { 测试番: 311 } };

test('开关默认关：不上报（无任何后端 action）', async () => {
    const { kazumi, actions } = makeHarness({ sync: false, ...MATCH });
    kazumi.reportWatchProgress({ ...META, subtitle: '第01集' }, 0);
    await drain(kazumi);
    assert.equal(actions.length, 0);
});

test('看完一集：该集被标记看过（第03集 → ep 3 的 episodeId）', async () => {
    const { kazumi, actions } = makeHarness(MATCH);
    kazumi.reportWatchProgress({ ...META, subtitle: '第03集' }, 2);
    await drain(kazumi);
    const w = actions.find((a) => a.action === 'kazumiBangumiEpisodeWatched');
    assert.ok(w, '应调用分集打点');
    assert.equal(w.params.subjectId, 311);
    assert.deepEqual(JSON.parse(w.params.episodeIds), [9003]);
});

test('集名形态覆盖：EP02 / S01E02 / 纯数字 / Episode 3 / 前导数字；「第2季」不误判', async () => {
    const cases = [['EP02', 9002], ['S01E02', 9002], ['02', 9002], ['Episode 3', 9003], ['03 花嫁', 9003]];
    for (const [sub, expected] of cases) {
        const { kazumi, actions } = makeHarness(MATCH);
        kazumi.reportWatchProgress({ ...META, subtitle: sub }, 0);
        await drain(kazumi);
        const w = actions.find((a) => a.action === 'kazumiBangumiEpisodeWatched');
        assert.ok(w, `「${sub}」应打点`);
        assert.deepEqual(JSON.parse(w.params.episodeIds), [expected], `「${sub}」应命中 ep ${expected}`);
    }
    // 无集后缀的季节标记不能当集数
    const { kazumi, actions } = makeHarness(MATCH);
    kazumi.reportWatchProgress({ ...META, subtitle: '第2季' }, 0);
    await drain(kazumi);
    assert.equal(actions.find((a) => a.action === 'kazumiBangumiEpisodeWatched'), undefined);
});

test('特典/花絮等番外集名不做数字推断：不误标同号正片；精确同名仍可名称兜底', async () => {
    for (const sub of ['特典 01', 'SP 1', 'OVA 2', '花絮02', 'NCOP']) {
        const { kazumi, actions } = makeHarness(MATCH);
        kazumi.reportWatchProgress({ ...META, subtitle: sub }, 0);
        await drain(kazumi);
        assert.equal(actions.find((a) => a.action === 'kazumiBangumiEpisodeWatched'), undefined, `「${sub}」不应按数字误标`);
    }
    // 守卫只压制数字推断：番外名与 Bangumi 本篇分集名完全一致时仍走名称精确兜底
    // （harness 主篇 type=0 中含名为 OVA 的集）
    const { kazumi, actions } = makeHarness(MATCH);
    kazumi.reportWatchProgress({ ...META, subtitle: 'OVA' }, 0);
    await drain(kazumi);
    const w = actions.find((a) => a.action === 'kazumiBangumiEpisodeWatched');
    assert.ok(w, '「OVA」应经名称精确兜底命中本篇同名集');
    assert.deepEqual(JSON.parse(w.params.episodeIds), [9005]);
});

test('集名无数字时按 Bangumi 分集名精确兜底（本篇 type=0 才参与）', async () => {
    const { kazumi, actions } = makeHarness(MATCH);
    kazumi.reportWatchProgress({ ...META, subtitle: '花嫁' }, 3);
    await drain(kazumi);
    const w = actions.find((a) => a.action === 'kazumiBangumiEpisodeWatched');
    assert.ok(w);
    assert.deepEqual(JSON.parse(w.params.episodeIds), [9005]);
});

test('匹配不到分集：宁缺勿错标，不发起任何写请求', async () => {
    const { kazumi, actions } = makeHarness(MATCH);
    kazumi.reportWatchProgress({ ...META, subtitle: '预告' }, 9);
    await drain(kazumi);
    // 分集列表的 GET 属于正常读取；打点与收藏联动这两个写动作不得发生
    assert.equal(actions.some((a) => a.action === 'kazumiBangumiEpisodeWatched'
        || a.action === 'kazumiBangumiCollectionSet'), false);
});

test('分集列表拉取失败不写缓存：下一集重新拉取（失败不毒化 10 分钟）', async () => {
    const { kazumi, actions } = makeHarness({ ...MATCH, epsFail: true });
    kazumi.reportWatchProgress({ ...META, subtitle: '第01集' }, 0);
    kazumi.reportWatchProgress({ ...META, subtitle: '第02集' }, 1);
    await drain(kazumi);
    const fetches = actions.filter((a) => a.action === 'kazumiBangumiEpisodes');
    assert.equal(fetches.length, 2, '失败不应缓存，第二集应重新拉取分集列表');
    assert.equal(actions.some((a) => a.action === 'kazumiBangumiEpisodeWatched'), false);
});

test('分集列表成功拉取后缓存复用：连播多集只拉一次', async () => {
    const { kazumi, actions } = makeHarness(MATCH);
    kazumi.reportWatchProgress({ ...META, subtitle: '第01集' }, 0);
    kazumi.reportWatchProgress({ ...META, subtitle: '第02集' }, 1);
    kazumi.reportWatchProgress({ ...META, subtitle: '第03集' }, 2);
    await drain(kazumi);
    assert.equal(actions.filter((a) => a.action === 'kazumiBangumiEpisodes').length, 1);
    assert.equal(actions.filter((a) => a.action === 'kazumiBangumiEpisodeWatched').length, 3);
});

test('未收藏 → 自动加入「在看」；想看 → 升级「在看」（均静默）', async () => {
    const { kazumi, setCalls } = makeHarness({ ...MATCH, col: null });
    kazumi.reportWatchProgress({ ...META, subtitle: '第01集' }, 0);
    await drain(kazumi);
    assert.deepEqual(setCalls, [{ id: '311', type: 3 }]);

    const h2 = makeHarness({ ...MATCH, col: { type: 1 } });
    h2.kazumi.reportWatchProgress({ ...META, subtitle: '第01集' }, 0);
    await drain(h2.kazumi);
    assert.deepEqual(h2.setCalls, [{ id: '311', type: 3 }]);
});

test('最后一集看完且远端本篇全部看过 → 自动标记「看过」', async () => {
    // epCols 全 type=2（含刚打的 9005）→ 收藏从在看升级看过
    const { kazumi, setCalls } = makeHarness({ ...MATCH, col: { type: 3 },
        epCols: [{ episode_id: 9001, type: 2 }, { episode_id: 9002, type: 2 },
            { episode_id: 9003, type: 2 }, { episode_id: 9005, type: 2 }] });
    kazumi.reportWatchProgress({ ...META, subtitle: '花嫁' }, 3); // 本篇 ep4 = 最后一集
    await drain(kazumi);
    assert.deepEqual(setCalls, [{ id: '311', type: 2 }]);
});

test('搁置/抛弃不自动改状态；已是看过不重复 set；远端未全看过不升级', async () => {
    for (const col of [{ type: 4 }, { type: 5 }]) {
        const { kazumi, setCalls } = makeHarness({ ...MATCH, col });
        kazumi.reportWatchProgress({ ...META, subtitle: '花嫁' }, 3);
        await drain(kazumi);
        assert.equal(setCalls.length, 0, `type=${col.type} 不应改动收藏`);
    }
    const a = makeHarness({ ...MATCH, col: { type: 2 } });
    a.kazumi.reportWatchProgress({ ...META, subtitle: '花嫁' }, 3);
    await drain(a.kazumi);
    assert.equal(a.setCalls.length, 0);

    // type 异常（非数字）同样不自动改状态（外层 curType 门拦下，不发分集收藏查询）
    const c = makeHarness({ ...MATCH, col: { type: 'x' } });
    c.kazumi.reportWatchProgress({ ...META, subtitle: '花嫁' }, 3);
    await drain(c.kazumi);
    assert.equal(c.setCalls.length, 0);
    assert.equal(c.actions.some((x) => x.action === 'kazumiBangumiEpisodeCollections'), false);

    // 还差一集没看（9003 未打）→ 不升级看过
    const b = makeHarness({ ...MATCH, col: { type: 3 },
        epCols: [{ episode_id: 9001, type: 2 }, { episode_id: 9002, type: 2 }, { episode_id: 9005, type: 2 }] });
    b.kazumi.reportWatchProgress({ ...META, subtitle: '花嫁' }, 3);
    await drain(b.kazumi);
    assert.equal(b.setCalls.length, 0);
});

test('准入过滤：直链/本地/下载/Bangumi 条目与无片名不上报', async () => {
    for (const meta of [
        { site: 'direct', title: 'movie.mp4', subtitle: '第1集' },
        { site: 'local', title: '本地文件', subtitle: '01' },
        { site: 'download', title: '下载文件', subtitle: '01' },
        { site: 'bangumi', title: 'Bangumi 条目', subtitle: '01' },
        { site: '量子资源', vodId: 'v1', title: '' },
        null,
    ]) {
        const { kazumi, actions } = makeHarness(MATCH);
        kazumi.reportWatchProgress(meta, 0);
        await drain(kazumi);
        assert.equal(actions.length, 0, `site=${meta && meta.site} 不应上报`);
    }
});

test('无 Token / 匹配不到条目：静默跳过', async () => {
    const { kazumi, actions } = makeHarness({ ...MATCH, noToken: true });
    kazumi.reportWatchProgress({ ...META, subtitle: '第01集' }, 0);
    await drain(kazumi);
    assert.equal(actions.length, 0);

    const h2 = makeHarness({ match: {} }); // getBangumiMatch 返回 id 0
    h2.kazumi.reportWatchProgress({ ...META, subtitle: '第01集' }, 0);
    await drain(h2.kazumi);
    assert.equal(h2.actions.length, 0);
});

test('打点失败：5 分钟内只提醒一次（连播逐集失败不刷屏）', async () => {
    const { kazumi, toasts } = makeHarness({ ...MATCH, watchFail: 'remote 500' });
    kazumi.reportWatchProgress({ ...META, subtitle: '第01集' }, 0);
    kazumi.reportWatchProgress({ ...META, subtitle: '第02集' }, 1);
    kazumi.reportWatchProgress({ ...META, subtitle: '第03集' }, 2);
    await drain(kazumi);
    assert.equal(toasts.length, 1);
    assert.ok(toasts[0].includes('观看进度上报失败'));
});

test('kazumi: 源（无 vodId）同样参与上报', async () => {
    const { kazumi, actions } = makeHarness(MATCH);
    kazumi.reportWatchProgress({ site: 'kazumi:某规则', vodId: '', title: '测试番', subtitle: '第1话', kazumiSrc: 'https://x' }, 0);
    await drain(kazumi);
    const w = actions.find((a) => a.action === 'kazumiBangumiEpisodeWatched');
    assert.ok(w);
    assert.deepEqual(JSON.parse(w.params.episodeIds), [9001]);
});
