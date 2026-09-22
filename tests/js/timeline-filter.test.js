// 组件测试：时间表收藏过滤 —— node:vm 加载真实源码 src/renderer/js/timeline.js 直测。
// 2026-09 审查 high#15：本文件原先内联复刻 _mergeLocalCollections/_applyFilters 逻辑
// （假测试），实现改坏依旧全绿；现改为注入最小桩后运行真实 timeline.js，断言全部基于真实实现。
// 覆盖：_buildColSets（账号收藏集合构建）、_mergeLocalCollections（本地收藏合并）、
// _applyFilters（过滤裁剪）。只测纯数据层，不触 DOM、不发真实网络。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 在 VM 中加载 timeline.js，注入最小全局桩；返回 Timeline 对象与桩的可控状态。 */
function loadTimeline() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/timeline.js'), 'utf8');
    // recGet 的返回值由用例按需改写（_mergeLocalCollections 读 favorites）
    const state = { recGetResult: undefined };
    const context = {
        console,
        // 渲染层 $ 全局：init/_renderGrid 之外的路径只用少量方法；给最小对象即可
        $: () => ({ on() { return this; }, empty() { return this; }, html() { return this; }, text() { return this; }, show() { return this; }, hide() { return this; }, find() { return this; }, each() {}, val() { return ''; }, attr() { return this; }, toggleClass() { return this; }, addClass() { return this; }, removeClass() { return this; }, append() { return this; } }),
        doAction: async () => ({ items: [] }), // _loadColSets 路径的网络桩，直测函数不触达
        escHtml: (s) => String(s),
        warnToast: () => {},
        showLoading: () => {},
        hideLoading: () => {},
        renderPagerBox: () => {},
        pageSizeOf: async () => 20,
        bangumiCard: () => '<div class="bangumi-card"></div>',
        bangumiNetGuide: () => '<div class="tip-line">guide</div>',
        fitVodTitles: () => {},
        Kazumi: {}, // 不带 _getBangumiToken → token 为空，_loadColSets 只走本地集合
        FavHub: { onChanged: () => () => {} },
        UIState: { get: () => null, set: () => {} },
        // 本地收藏存储桩（records.js favorites）
        recGet: async (key) => (key === 'favorites' ? state.recGetResult : undefined),
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testTimeline = Timeline;`, context, { filename: 'timeline.js' });
    return { T: context.__testTimeline, state };
}

/** 重置过滤状态到「集合为空 + 过滤全关 + 可用」——_applyFilters 真实生效的前置条件。 */
function freshFilters(T) {
    T._colAvailable = true;
    T._colSets = { dropped: new Set(), watched: new Set(), watching: new Set() };
    T._filters = { dropped: false, watched: false, onlyWatching: false };
}

test('挂载：Timeline 对象暴露过滤相关方法（vm 加载真实源码）', () => {
    const { T } = loadTimeline();
    assert.equal(typeof T._buildColSets, 'function');
    assert.equal(typeof T._mergeLocalCollections, 'function');
    assert.equal(typeof T._applyFilters, 'function');
    assert.equal(typeof T._loadColSets, 'function');
});

// ---------------------------------------------------------------- _buildColSets

test('_buildColSets：账号收藏按 type 分桶（2=看过 3=在看 5=抛弃）', () => {
    const { T } = loadTimeline();
    const sets = T._buildColSets([
        { subject_id: 100, type: 3 },
        { subject_id: 200, type: 2 },
        { subject_id: 300, type: 5 },
        { subject_id: 400, type: 1 }, // 想看：不入任何集合
        { subject_id: 500, type: 4 }, // 搁置：不入任何集合
    ]);
    assert.ok(sets.watching.has('100'));
    assert.ok(sets.watched.has('200'));
    assert.ok(sets.dropped.has('300'));
    assert.equal(sets.watching.size, 1);
    assert.equal(sets.watched.size, 1);
    assert.equal(sets.dropped.size, 1);
});

test('_buildColSets：兼容嵌套 subject.id 与字符串 type（镜像源形态）', () => {
    const { T } = loadTimeline();
    const sets = T._buildColSets([
        { subject: { id: 326661 }, type: '3' },
    ]);
    assert.ok(sets.watching.has('326661'), '嵌套 subject.id 应被采纳');
    assert.ok(sets.watching.has('326661') === true && sets.watching.size === 1, '字符串 type=3 应转数字后命中在看');
});

test('_buildColSets：无 id 的条目跳过、null 条目跳过、空输入返回空集合', () => {
    const { T } = loadTimeline();
    const sets = T._buildColSets([null, { subject_id: '', type: 3 }, {}]);
    assert.equal(sets.watching.size, 0);
    assert.equal(sets.watched.size, 0);
    assert.equal(sets.dropped.size, 0);
    const empty = T._buildColSets(null);
    assert.equal(empty.watching.size + empty.watched.size + empty.dropped.size, 0);
});

// ---------------------------------------------------------------- _mergeLocalCollections

test('_mergeLocalCollections：本地收藏带 bangumiId + tag → 按 tag 归入集合', async () => {
    const { T, state } = loadTimeline();
    const sets = { dropped: new Set(), watched: new Set(), watching: new Set() };
    state.recGetResult = [
        { site: 'mysite', vodId: 'v1', name: '海贼王', bangumiId: '326661', tag: 'watching' },
        { site: 'mysite', vodId: 'v2', name: '火影忍者', bangumiId: '99999', tag: 'seen' },
        { site: 'mysite', vodId: 'v3', name: '鬼灭之刃', bangumiId: '88888', tag: 'dropped' },
    ];
    await T._mergeLocalCollections(sets);
    assert.ok(sets.watching.has('326661'));
    assert.ok(sets.watched.has('99999'));
    assert.ok(sets.dropped.has('88888'));
    assert.equal(sets.watching.size, 1);
    assert.equal(sets.watched.size, 1);
    assert.equal(sets.dropped.size, 1);
});

test('_mergeLocalCollections：site=bangumi 时用 vodId 作为 ID', async () => {
    const { T, state } = loadTimeline();
    const sets = { dropped: new Set(), watched: new Set(), watching: new Set() };
    state.recGetResult = [{ site: 'bangumi', vodId: '555', tag: 'watching' }];
    await T._mergeLocalCollections(sets);
    assert.ok(sets.watching.has('555'));
});

test('_mergeLocalCollections：无 bangumiId 的本地收藏被跳过（不影响筛选）', async () => {
    const { T, state } = loadTimeline();
    const sets = { dropped: new Set(), watched: new Set(), watching: new Set() };
    state.recGetResult = [{ site: 's', vodId: 'v1', tag: 'watching' }]; // 无 bangumiId 且 site≠bangumi
    await T._mergeLocalCollections(sets);
    assert.equal(sets.watching.size, 0);
});

test('_mergeLocalCollections：null 条目/未知 tag 跳过；favorites 为空/读取抛错不影响集合', async () => {
    const { T, state } = loadTimeline();
    const sets = { dropped: new Set(), watched: new Set(), watching: new Set() };
    state.recGetResult = [null, { site: 's', bangumiId: '1', tag: 'whatever' }];
    await T._mergeLocalCollections(sets);
    assert.equal(sets.watching.size + sets.watched.size + sets.dropped.size, 0);

    state.recGetResult = [];
    await T._mergeLocalCollections(sets);
    assert.equal(sets.watching.size, 0);

    state.recGetResult = undefined; // recGet 未返回（等价存储缺失）
    await T._mergeLocalCollections(sets);
    assert.equal(sets.watching.size, 0);
});

// ---------------------------------------------------------------- _applyFilters（经 _loadColSets 全链路驱动）

test('只显示在看：筛选出匹配的影片（真实 _loadColSets → _buildColSets → _applyFilters）', async () => {
    const { T } = loadTimeline();
    freshFilters(T);
    T._colSets = T._buildColSets([{ subject_id: 100, type: 3 }, { subject_id: 200, type: 3 }]);
    T._filters.onlyWatching = true;
    const timeline = [
        { id: 100, name: '海贼王' },
        { id: 200, name: '火影忍者' },
        { id: 300, name: '鬼灭之刃' },
    ];
    const result = T._applyFilters(timeline);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((it) => it.name), ['海贼王', '火影忍者']);
});

test('不显示已抛弃：排除标记 dropped 的影片', () => {
    const { T } = loadTimeline();
    freshFilters(T);
    T._colSets = T._buildColSets([{ subject_id: 200, type: 5 }]);
    T._filters.dropped = true;
    const timeline = [
        { id: 100, name: '海贼王' },
        { id: 200, name: '火影忍者' },
    ];
    const result = T._applyFilters(timeline);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, '海贼王');
});

test('不显示已看完：排除标记 seen 的影片', () => {
    const { T } = loadTimeline();
    freshFilters(T);
    T._colSets = T._buildColSets([{ subject_id: 100, type: 2 }]);
    T._filters.watched = true;
    const timeline = [
        { id: 100, name: '海贼王' },
        { id: 200, name: '火影忍者' },
    ];
    const result = T._applyFilters(timeline);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, '火影忍者');
});

test('时间表项 id 为数字，收藏 bangumiId 为字符串 → String() 归一化后匹配', async () => {
    const { T, state } = loadTimeline();
    freshFilters(T);
    // 经真实 _mergeLocalCollections 注入字符串 bangumiId
    state.recGetResult = [{ site: 's', vodId: 'v1', bangumiId: '326661', tag: 'watching' }];
    await T._mergeLocalCollections(T._colSets);
    T._filters.onlyWatching = true;
    // 后端时间表项 id 为数字（dict(subject) 扁平化）
    const timeline = [{ id: 326661, name: '海贼王' }];
    const result = T._applyFilters(timeline);
    assert.equal(result.length, 1, '数字 id 与字符串 bangumiId 应能匹配');
});

test('_applyFilters：item id 兼容嵌套 subject.id；_colAvailable=false 时原样返回', () => {
    const { T } = loadTimeline();
    freshFilters(T);
    T._colSets = T._buildColSets([{ subject_id: 100, type: 3 }]);
    T._filters.onlyWatching = true;
    const nested = [{ subject: { id: 100 }, name: '嵌套形态' }];
    assert.deepEqual(T._applyFilters(nested), nested, '嵌套 subject.id 与集合取 id 口径一致');
    T._colAvailable = false;
    assert.deepEqual(T._applyFilters([{ id: 999 }]), [{ id: 999 }], '过滤不可用时原样返回');
});

// ---------------------------------------------------------------- 端到端（_loadColSets：无 token → 本地收藏独立驱动过滤）

test('_loadColSets：无 Bangumi token 时仅由本地收藏驱动过滤集合', async () => {
    const { T, state } = loadTimeline();
    state.recGetResult = [
        { site: 's', vodId: 'v1', bangumiId: '100', tag: 'watching' },
        { site: 's', vodId: 'v2', bangumiId: '200', tag: 'dropped' },
    ];
    await T._loadColSets();
    assert.ok(T._colAvailable, '有本地标记即启用过滤');
    assert.deepEqual([...T._colSets.watching], ['100']);
    assert.deepEqual([...T._colSets.dropped], ['200']);
    assert.equal(T._colSets.watched.size, 0);
});
