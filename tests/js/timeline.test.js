'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 在 VM 沙箱载入 timeline.js，返回 Timeline 对象（仅测纯函数，不触发 init/DOM）。 */
function loadTimeline() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/timeline.js'), 'utf8');
    const context = { console, Date, Math, JSON, String, Number, Array, Map, Set, parseInt };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testTimeline = Timeline;`, context, { filename: 'timeline.js' });
    return context.__testTimeline;
}

test('_seasonRange：四季度日期区间与跨年', () => {
    const t = loadTimeline();
    const check = (key, start, end) => {
        const r = t._seasonRange(key);
        assert.equal(r.start, start);
        assert.equal(r.end, end);
    };
    check('2026Q1', '2026-01-01', '2026-04-01');
    check('2026Q2', '2026-04-01', '2026-07-01');
    check('2026Q3', '2026-07-01', '2026-10-01');
    check('2026Q4', '2026-10-01', '2027-01-01');
    assert.equal(t._seasonRange('invalid'), null);
    assert.equal(t._seasonRange('current'), null);
});

test('_seasonLabel：季度展示标签', () => {
    const t = loadTimeline();
    assert.equal(t._seasonLabel('2026Q1'), '2026年冬季新番');
    assert.equal(t._seasonLabel('2026Q2'), '2026年春季新番');
    assert.equal(t._seasonLabel('2026Q3'), '2026年夏季新番');
    assert.equal(t._seasonLabel('2026Q4'), '2026年秋季新番');
    assert.equal(t._seasonLabel('current'), 'current');
});

const ITEMS = [
    { id: 1, rating: { total: 100, score: 7.5 }, air_date: '2026-07-05' },
    { id: 2, rating: { total: 300, score: 8.5 }, air_date: '2026-07-01' },
    { id: 3, rating: { total: 200, score: 6.0 }, air_date: '2026-07-10' },
];

test('_sortItems：热度降序', () => {
    const t = loadTimeline();
    t._sort = 'heat';
    assert.deepEqual(t._sortItems(ITEMS).map((x) => x.id), [2, 3, 1]);
});

test('_sortItems：评分降序', () => {
    const t = loadTimeline();
    t._sort = 'rating';
    assert.deepEqual(t._sortItems(ITEMS).map((x) => x.id), [2, 1, 3]);
});

test('_sortItems：播出时间升序', () => {
    const t = loadTimeline();
    t._sort = 'date';
    assert.deepEqual(t._sortItems(ITEMS).map((x) => x.id), [2, 1, 3]);
});

test('_sortItems：缺 rating 字段不报错', () => {
    const t = loadTimeline();
    t._sort = 'heat';
    const out = t._sortItems([{ id: 9 }, { id: 8, rating: { total: 5 } }]);
    assert.deepEqual(out.map((x) => x.id), [8, 9]);
});

test('_applyFilters：无过滤/隐藏抛弃/隐藏看完/只看在看', () => {
    const t = loadTimeline();
    t._colAvailable = true;
    t._colSets = { dropped: new Set(['10']), watched: new Set(['20']), watching: new Set(['30']) };
    const list = [{ id: 10 }, { id: 20 }, { id: 30 }, { id: 40 }];
    t._filters = { dropped: false, watched: false, onlyWatching: false };
    assert.deepEqual(t._applyFilters(list).map((x) => x.id), [10, 20, 30, 40]);
    t._filters.dropped = true;
    assert.deepEqual(t._applyFilters(list).map((x) => x.id), [20, 30, 40]);
    t._filters.dropped = false; t._filters.watched = true;
    assert.deepEqual(t._applyFilters(list).map((x) => x.id), [10, 30, 40]);
    t._filters.watched = false; t._filters.onlyWatching = true;
    assert.deepEqual(t._applyFilters(list).map((x) => x.id), [30]);
});

test('_applyFilters：收藏不可用时原样返回', () => {
    const t = loadTimeline();
    t._colAvailable = false;
    t._filters = { dropped: true, watched: true, onlyWatching: true };
    const list = [{ id: 10 }, { id: 20 }];
    assert.deepEqual(t._applyFilters(list).map((x) => x.id), [10, 20]);
});

test('_buildColSets：顶层 subject_id + 数字 type 正确分桶', () => {
    const t = loadTimeline();
    const sets = t._buildColSets([
        { subject_id: 10, type: 5 }, // 抛弃
        { subject_id: 20, type: 2 }, // 看过
        { subject_id: 30, type: 3 }, // 在看
        { subject_id: 40, type: 1 }, // 想看（不进任一集合）
    ]);
    assert.deepEqual([...sets.dropped], ['10']);
    assert.deepEqual([...sets.watched], ['20']);
    assert.deepEqual([...sets.watching], ['30']);
});

test('_buildColSets：id 仅在嵌套 subject.id + type 为字符串也能匹配（镜像/脏数据）', () => {
    const t = loadTimeline();
    const sets = t._buildColSets([
        { subject: { id: 11 }, type: '5' },  // 镜像：id 嵌套 + 字符串 type
        { subject: { id: 22 }, type: '3' },
        { id: 33, type: 2 },                 // 仅顶层 id 兜底
    ]);
    assert.deepEqual([...sets.dropped], ['11']);
    assert.deepEqual([...sets.watching], ['22']);
    assert.deepEqual([...sets.watched], ['33']);
});

test('_buildColSets → _applyFilters：端到端 id-type 匹配（时间表项 .id 命中收藏集合）', () => {
    const t = loadTimeline();
    // 时间表条目 id 与收藏条目 subject_id 同为 Bangumi subject id，但一为 Number 一为 String
    t._colAvailable = true;
    t._colSets = t._buildColSets([
        { subject_id: 100, type: 5 },
        { subject_id: 200, type: 3 },
    ]);
    const list = [{ id: 100 }, { id: 200 }, { id: 300 }];
    t._filters = { dropped: true, watched: false, onlyWatching: false };
    assert.deepEqual(t._applyFilters(list).map((x) => x.id), [200, 300]);
    t._filters = { dropped: false, watched: false, onlyWatching: true };
    assert.deepEqual(t._applyFilters(list).map((x) => x.id), [200]);
});

test('_buildColSets：空/无效输入返回空集合，不抛错', () => {
    const t = loadTimeline();
    const empty = t._buildColSets(undefined);
    assert.equal(empty.dropped.size, 0);
    assert.equal(empty.watched.size, 0);
    assert.equal(empty.watching.size, 0);
    const skipped = t._buildColSets([null, {}, { type: 5 }]); // 无 id → 跳过
    assert.equal(skipped.dropped.size, 0);
});

// ---------------------------------------------------------------- 收藏状态徽标（悬停显示）

test('_buildColStateMap：六态全收录（想看/搁置入映射，过滤桶之外）', () => {
    const t = loadTimeline();
    const map = t._buildColStateMap([
        { subject_id: 1, type: 1 }, // 想看
        { subject_id: 2, type: 2 }, // 看过
        { subject_id: 3, type: 3 }, // 在看
        { subject_id: 4, type: 4 }, // 搁置
        { subject_id: 5, type: 5 }, // 抛弃
        { subject_id: 6, type: 9 }, // 非法 type → 跳过
    ]);
    assert.deepEqual([...map.entries()].sort(), [['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5]]);
});

test('_buildColStateMap：嵌套 subject.id + 字符串 type（镜像形态）+ 空输入', () => {
    const t = loadTimeline();
    const map = t._buildColStateMap([
        { subject: { id: 326661 }, type: '3' },
        { id: 777, type: 2 },
        null, {}, { subject_id: '' },
    ]);
    assert.equal(map.get('326661'), 3);
    assert.equal(map.get('777'), 2);
    assert.equal(map.size, 2);
    assert.equal(t._buildColStateMap(undefined).size, 0);
});

test('_mergeLocalStates：本地五态 tag 入映射；账号态优先不被本地覆盖', async () => {
    const t = loadTimeline();
    // 沙箱无 recGet：静默返回，映射不变
    const bare = new Map([['10', 3]]);
    await t._mergeLocalStates(bare);
    assert.equal(bare.get('10'), 3);

    // 注入 recGet 桩再测合并：want/seen/watching/hold/dropped → 1/2/3/4/5
    const contextRec = { recGet: async () => [
        { bangumiId: '1', tag: 'want' },
        { bangumiId: '2', tag: 'seen' },
        { site: 'bangumi', vodId: '3', tag: 'watching' },
        { bangumiId: '4', tag: 'hold' },
        { bangumiId: '5', tag: 'dropped' },
        { bangumiId: '6', tag: 'whatever' },  // 未知 tag 跳过
        { bangumiId: '', tag: 'seen' },       // 无 id 跳过
        null,
    ] };
    const t2Src = loadTimelineWith(contextRec);
    const map = new Map([['3', 3]]); // 账号已有「在看」，本地也标 watching → 不得覆盖
    await t2Src._mergeLocalStates(map);
    assert.deepEqual([...map.entries()].sort((a, b) => a[0] - b[0]),
        [['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5]]);
});

/** 带 recGet 桩的 timeline 载入（_mergeLocalStates 用例专用）。 */
function loadTimelineWith(extraGlobals) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/timeline.js'), 'utf8');
    const context = { console, Date, Math, JSON, String, Number, Array, Map, Set, parseInt, ...extraGlobals };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testTimeline = Timeline;`, context, { filename: 'timeline.js' });
    return context.__testTimeline;
}

test('_attachFavBadges：收藏条目挂 .vod-fav-row 徽标行，未收藏零 DOM', () => {
    const t = loadTimeline();
    t._colStateMap = new Map([['200', 3], ['300', 5]]);
    const cards = {};
    const grid = makeMiniGrid(cards, ['100', '200', '300']);
    t._attachFavBadges(grid, [{ id: 100 }, { id: 200 }, { id: 300 }]);
    assert.match(cards[100].html, /^$/);
    assert.match(cards[200].html, /class="vod-fav-row"/);
    assert.match(cards[200].html, /vod-fav-badge vod-fav-watching/);
    assert.match(cards[200].html, /在看/);
    assert.match(cards[300].html, /vod-fav-dropped/);
    assert.match(cards[300].html, /抛弃/);
});

test('_attachFavBadges：映射为 null/空 → 零 DOM；嵌套 subject.id 兼容', () => {
    const t = loadTimeline();
    const cards = {};
    const grid = makeMiniGrid(cards, ['100']);
    t._colStateMap = null;
    t._attachFavBadges(grid, [{ id: 100 }]);
    t._colStateMap = new Map();
    t._attachFavBadges(grid, [{ id: 100 }]);
    assert.equal(cards[100].html, '');
    t._colStateMap = new Map([['100', 1]]);
    t._attachFavBadges(grid, [{ subject: { id: 100 } }]);
    assert.match(cards[100].html, /vod-fav-want/);
});

test('话数徽章落位：有徽标行时 prepend 行首（收藏徽标在其右侧），无行时回退直挂', async () => {
    // _attachEpBadges 依赖 Kazumi.bangumiInfoBatch 拿总话数：注入桩（放送日久远 → 已完结分支）
    const t = loadTimelineWith({
        Kazumi: { bangumiInfoBatch: async (ids) => Object.fromEntries(ids.map((id) => [id, { eps: 12, date: '2025-01-06' }])) },
    });
    t._colStateMap = new Map([['200', 2]]);
    const cards = {};
    const grid = makeMiniGrid(cards, ['100', '200']);
    const items = [{ id: 100 }, { id: 200 }];
    t._attachFavBadges(grid, items); // 先挂徽标行（与 _renderGrid 顺序一致）
    await t._attachEpBadges(grid, items);
    // 100 无收藏：无行 → 话数徽章直挂 .vod-cover（旧行为不变）
    assert.equal(cards[100].rowPrepends.length, 0);
    assert.match(cards[100].html, /timeline-ep-badge/);
    assert.doesNotMatch(cards[100].html, /vod-fav-row/);
    // 200 有收藏：话数徽章 prepend 进 .vod-fav-row 行首，收藏徽标在行内其右侧
    assert.equal(cards[200].rowPrepends.length, 1, '话数徽章应 prepend 进行首');
    assert.match(cards[200].rowPrepends[0], /timeline-ep-badge/);
    assert.match(cards[200].html, /vod-fav-badge vod-fav-seen/);
});

test('_attachEpBadges itemsFull 快捷分支：条目自带 eps 时免回源批量详情（推荐页复用）', async () => {
    let infoCalls = 0;
    const t = loadTimelineWith({
        Kazumi: { bangumiInfoBatch: async () => { infoCalls++; return {}; } },
    });
    const cards = {};
    const grid = makeMiniGrid(cards, ['100']);
    // 条目自带 eps/air_date（趋势/榜单接口响应形态）+ itemsFull=true：不走批量回源
    const items = [{ id: 100, eps: 12, air_date: '2025-01-06' }];
    await t._attachEpBadges(grid, items, true);
    assert.equal(infoCalls, 0, '快捷分支不回源详情');
    // 已完结 → 徽章文本为纯数字「12」（与搜索卡 .rec-eps 统一），不再是「已完结」文案
    assert.match(cards[100].html, /title="放送已完结 · 共 12 话">12话</, '完结显示总话数（N话），title 保留「共 N 话」说明');
    assert.doesNotMatch(cards[100].html, />已完结</, '徽章文本位不再输出「已完结」');
    assert.doesNotMatch(cards[100].html, />共 /, '文本位不带「共」字');
});

test('_attachEpBadges：缺 eps 条目合并为一次批量请求（bangumiInfoBatch）', async () => {
    let batchCalls = 0;
    let batchIds = [];
    const t = loadTimelineWith({
        Kazumi: { bangumiInfoBatch: async (ids) => { batchCalls++; batchIds = ids; return { 100: { eps: 24, date: '2026-10-05' } }; } },
    });
    const cards = {};
    const grid = makeMiniGrid(cards, ['100', '200']);
    // 两条都缺 eps：一次批量带回（新管线核心——旧行为是每条各发一次 bangumiInfo）
    const items = [{ id: 100, air_date: '2026-10-05' }, { id: 200 }];
    await t._attachEpBadges(grid, items, true);
    assert.equal(batchCalls, 1, '整页只发一次批量请求');
    assert.deepEqual([...batchIds], ['100', '200'], '缺失条目 id 全部并入批量');
    // 2026-10-05（周一）放送：按天粒度推算首播日当天 aired=1，但今天恰为放送日
    // 前夜（Date.now() < start）时 clamp 到 0——用宽松断言兼容执行时刻。
    // 连载未完结保留「N/总话数」格式（用户要求）
    assert.match(cards[100].html, /[01]\/24/, '当周首播 → 0 或 1/24');
    // 批量结果缺值的条目（200 无 info）不挂徽章，也不抛错
    assert.doesNotMatch(cards[200].html, /timeline-ep-badge/, '批量缺值条目静默跳过');
});

test('重挂徽标行（FavHub 广播/映射重建）后话数徽章不丢（推荐页同步返回 bug 回归锁）', async () => {
    // 场景：详情页同步收藏 → FavHub.changed → 推荐页 refreshBadges →
    // _ensureColState 在已渲染网格上重跑 _attachFavBadges。旧实现 remove 行时
    // 把已 prepend 进行内的话数徽章连带删除，且之后再 find 不到 → 徽章消失。
    // _attachEpBadges 需要 Kazumi.bangumiInfoBatch 桩拿总话数（条目无 eps，走回源分支）。
    const t = loadTimelineWith({
        Kazumi: { bangumiInfoBatch: async (ids) => Object.fromEntries(ids.map((id) => [id, { eps: 12, date: '2025-01-06' }])) },
    });
    t._colStateMap = new Map([['200', 2]]);
    const cards = {};
    const grid = makeMiniGrid(cards, ['100', '200']);
    const items = [{ id: 100 }, { id: 200 }];
    // 首轮：挂徽标行 + 异步话数徽章落入行内
    t._attachFavBadges(grid, items);
    await t._attachEpBadges(grid, items, true);
    assert.match(cards[200].html, /timeline-ep-badge/, '首轮：话数徽章在行内');
    assert.match(cards[200].html, /vod-fav-seen/, '首轮：收藏徽标在行内');
    // 模拟「同步后返回」：收藏映射不变（或已更新），网格未重渲染，重跑 _attachFavBadges
    t._attachFavBadges(grid, items);
    assert.match(cards[200].html, /vod-fav-row/, '重挂后徽标行仍在');
    assert.match(cards[200].html, /vod-fav-seen/, '重挂后收藏徽标仍在');
    assert.match(cards[200].html, /timeline-ep-badge/, '重挂后话数徽章必须保留（bug 回归锁）');
    assert.equal(cards[200].rowPrepends.length, 1, '行内仅一枚话数徽章（不重复堆积）');
    // 未收藏卡片（100）不受重挂影响：始终无徽标行（.vod-cover 直挂的话数徽章
    // 属旧行为，与重挂无关——重挂只作用于有收藏态的卡片）
    assert.doesNotMatch(cards[100].html, /vod-fav-row/, '未收藏卡不建徽标行');
    assert.equal(cards[100].rowPrepends.length, 0, '未收藏卡无行内徽章');
});

test('getColStateMap：跨页面共享映射入口——并发调用共享在途 Promise（零重复请求）', async () => {
    let netCalls = 0;
    const t = loadTimelineWith({
        Kazumi: { _getBangumiToken: async () => 'tok' },
        doAction: async (action) => {
            if (action === 'kazumiBangumiCollections') { netCalls++; return { items: [{ subject_id: 9, type: 3 }] }; }
            return { items: [] };
        },
        recGet: async () => [],
    });
    // 并发两路（模拟推荐页与搜索页同时进入）：应共享同一在途 Promise，只发一次网络
    const [a, b] = await Promise.all([t.getColStateMap(), t.getColStateMap()]);
    assert.equal(netCalls, 1, '并发共享一次拉取');
    assert.equal(a, b, '两路拿到同一映射对象');
    assert.equal(a.get('9'), 3);
    // 完成后再次调用：命中 _loadColSets 的内存缓存，仍零网络
    await t.getColStateMap();
    assert.equal(netCalls, 1, '后续调用走内存缓存');
});

test('_attachFavBadges：bangumiCard 直出的 .rec-eps 重挂时吸进行首（不丢不重复）', async () => {
    // 搜索响应自带 eps → bangumiCard 直出徽标行（行首 rec-eps）；收藏映射晚到手
    // 重跑 _attachFavBadges 时，旧 rec-eps 必须保留吸回，而非被删行连带销毁
    const t = loadTimeline();
    t._colStateMap = new Map([['200', 2]]);
    const cards = {};
    const grid = makeMiniGrid(cards, ['200']);
    // 模拟 bangumiCard 直出：<div class="vod-fav-row"><span class="rec-eps">…</span></div>
    grid.find('.bangumi-card[data-id="200"] .vod-cover').append('<div class="vod-fav-row"><span class="rec-eps" title="共 12 话">12话</span></div>');
    t._attachFavBadges(grid, [{ id: 200 }]);
    assert.match(cards[200].html, /rec-eps/, '重挂后 rec-eps 保留（吸回行首）');
    assert.match(cards[200].html, /vod-fav-seen/, '收藏徽标在行内');
});

/** 迷你 DOM 桩：模拟 grid.find('.bangumi-card[data-id="N"] .vod-cover') 的
 *  append/find/prepend/remove 链。rows 记录直挂 .vod-cover 的节点（徽标行/
 *  直挂徽章），rowPrepends 记录 prepend 进行的徽章——真实 DOM 中后者位于
 *  行内首项（收藏徽标左侧），平铺串无法表达嵌套顺序，故以结构调用断言。
 *  行结构与徽章可变（remove 行/徽章真实生效、行内徽章 prepend 后可再被
 *  find('.timeline-ep-badge') 命中），支持 _attachFavBadges 重挂路径测试。
 *  ids 预注册卡片节点，供早退场景（映射为空）下也能断言零 DOM。 */
function makeMiniGrid(cards, ids = []) {
    const node = () => {
        const rows = []; const rowPrepends = [];
        const n = {
            length: 1, _rows: rows, rowPrepends,
            get html() { return [...rows, ...rowPrepends].join(''); },
            append(inner) { rows.push(inner); return n; },
            find(sel) {
                if (sel === '.vod-fav-row') {
                    const i = rows.findIndex((r) => String(r).includes('vod-fav-row'));
                    return i >= 0 ? {
                        length: 1,
                        prepend(b) { rowPrepends.push(b); },
                        remove() { rows.splice(i, 1); rowPrepends.length = 0; },
                        // 行内反查（_attachEpBadges 查 .rec-eps 防双徽章）
                        find(inner) {
                            const inRow = rowPrepends.concat(rows.filter((r) => String(r).includes('vod-fav-row')));
                            const hit = inRow.some((r) => String(r).includes(inner.replace('.', '')));
                            return { length: hit ? 1 : 0 };
                        },
                    } : { length: 0, remove() {} };
                }
                if (sel === '.timeline-ep-badge') {
                    // 直挂徽章（rows）或行内徽章（rowPrepends）都可命中；
                    // outerHTML 固定形状（与实现生成的标签形状无关，测试只关心存在性）
                    const hit = rows.concat(rowPrepends).some((r) => String(r).includes('timeline-ep-badge'));
                    return hit ? {
                        length: 1,
                        0: { outerHTML: '<span class="detail-progress-badge timeline-ep-badge" title="t">1/12</span>' },
                        remove() {
                            const j = rows.findIndex((r) => String(r).includes('timeline-ep-badge'));
                            if (j >= 0) rows.splice(j, 1);
                            const k = rowPrepends.findIndex((r) => String(r).includes('timeline-ep-badge'));
                            if (k >= 0) rowPrepends.splice(k, 1);
                        },
                    } : { length: 0, remove() {} };
                }
                if (sel === '.rec-eps') {
                    // bangumiCard 直出的话数徽章（嵌在徽标行字符串内）也可命中
                    const hit = rows.concat(rowPrepends).some((r) => String(r).includes('rec-eps'));
                    return hit ? {
                        length: 1,
                        0: { outerHTML: '<span class="rec-eps" title="共 12 话">12话</span>' },
                        remove() {
                            // 真实 DOM：rec-eps 在徽标行内，remove 即从行中摘除；
                            // 桩以「从行字符串里剥掉 rec-eps span」近似
                            const j = rows.findIndex((r) => String(r).includes('rec-eps'));
                            if (j >= 0) rows[j] = String(rows[j]).replace(/<span class="rec-eps"[^>]*>.*?<\/span>/, '');
                            const k = rowPrepends.findIndex((r) => String(r).includes('rec-eps'));
                            if (k >= 0) rowPrepends.splice(k, 1);
                        },
                    } : { length: 0, remove() {} };
                }
                return { length: 0, remove() {} };
            },
            remove() { return n; },
        };
        return n;
    };
    ids.forEach((id) => { cards[id] = node(); });
    return {
        find(sel) {
            const m = sel.match(/\.bangumi-card\[data-id="(.+?)"\] \.vod-cover/);
            if (!m) return { length: 0 };
            const id = m[1];
            cards[id] = cards[id] || node();
            return cards[id];
        },
    };
}
