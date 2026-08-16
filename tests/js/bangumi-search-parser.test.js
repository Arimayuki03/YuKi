'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/**
 * 在 VM 中加载 bangumi-search.js，注入最小全局桩（不触碰 DOM/网络），
 * 只暴露 BangumiSearchParser 做纯逻辑单测——复刻 Kazumi test/search_parser_test.dart。
 */
function loadParser() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/bangumi-search.js'), 'utf8');
    const noop = function () { return this; };
    const $stub = () => ({
        on: noop, off: noop, empty: noop, html: noop, text: noop, val: noop,
        show: noop, hide: noop, toggle: noop, addClass: noop, removeClass: noop,
        find: () => ({ on: noop, each: noop, removeClass: noop, addClass: noop }),
        each: noop, prop: noop, trigger: noop, toggleClass: noop,
    });
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object,
        parseInt, parseFloat, Number, RegExp, isNaN,
        setTimeout, clearTimeout,
        $: $stub,
        doAction: async () => ({ items: [], total: 0 }),
        warnToast: () => {}, showLoading: () => {}, hideLoading: () => {},
        renderPagerBox: () => {}, pageSizeOf: async () => 20,
        bangumiCard: (item) => `<div data-id="${item.id}"></div>`,
        escHtml: (s) => String(s), fitVodTitles: () => {},
        openDialog: () => {}, closeDialog: () => {},
        App: {}, Kazumi: {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__P = BangumiSearchParser;`, context, { filename: 'bangumi-search.js' });
    return context.__P;
}

const P = loadParser();

// VM 上下文里构造的对象/数组原型来自不同 realm，deepStrictEqual 会因原型不等而误判；
// 用 JSON 规范化后比较结构值，规避跨 realm 原型差异。
function deepEq(actual, expected, msg) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);
}

test('id 搜索行为保留', () => {
    const state = P.toFilterState('id:12345 tag:日本 sort:rank');
    assert.equal(P.parseId('id:12345 tag:日本 sort:rank'), '12345');
    assert.equal(!!state.id, true);
    assert.equal(P.fromFilterState(state), 'id:12345');
});

test('解析多个标签并从关键词中剔除', () => {
    const q = '葬送的芙莉莲 tag:奇幻 tag:漫画改 sort:rank';
    assert.equal(P.parseKeywords(q), '葬送的芙莉莲');
    deepEq(P.parseTags(q), ['奇幻', '漫画改']);
    assert.equal(P.parseSort(q), 'rank');
});

test('解析相邻的 tag 与 sort 语法', () => {
    const q = 'tag:Re：从零开始的异世界生活sort:rank';
    deepEq(P.parseTags(q), ['Re：从零开始的异世界生活']);
    assert.equal(P.parseSort(q), 'rank');
    assert.equal(P.parseKeywords(q), '');
});

test('解析季度并映射为日期区间', () => {
    const state = P.toFilterState('season:2026Q1');
    assert.equal(state.season, '2026Q1');
    deepEq(P.effectiveDateRange(state), { start: '2026-01-01', end: '2026-04-01' });
});

test('解析自定义日期区间', () => {
    deepEq(
        P.parseDateRange('date:2026-01-01..2026-04-01'),
        { start: '2026-01-01', end: '2026-04-01' },
    );
});

test('解析排名与评分区间', () => {
    const q = 'rank:1..5000 score:7.5..10';
    deepEq(P.parseRankRange(q), { min: 1, max: 5000 });
    deepEq(P.parseScoreRange(q), { min: 7.5, max: 10.0 });
});

test('解析星期并忽略 nsfw 词元', () => {
    const q = 'weekday:1,3,5 nsfw:true';
    deepEq(P.parseWeekdays(q), [1, 3, 5]);
    assert.equal(P.parseKeywords(q), '');
    assert.equal(P.fromFilterState(P.toFilterState(q)), 'weekday:1,3,5');
});

test('筛选状态序列化回查询语法', () => {
    const state = {
        id: '', keyword: '孤独摇滚', tags: ['音乐', '漫画改'],
        sort: 'score', season: '2022Q4', dateRange: null,
        rankRange: { min: 1, max: 1000 }, scoreRange: { min: 8.0, max: 10.0 },
        weekdays: [6, 1],
    };
    assert.equal(
        P.fromFilterState(state),
        '孤独摇滚 tag:音乐 tag:漫画改 sort:score season:2022Q4 rank:1..1000 score:8..10 weekday:1,6',
    );
});

test('季度映射覆盖四个季度的月份边界', () => {
    // L-32：标准季度半开区间 [首月1日, 首月+3月1日)——与 timeline.js 对齐
    // （原实现对齐 Kazumi Dart 的偏移行为：起点提前一月、结束多算一月）
    deepEq(P.seasonToDateRange('2023Q1'), { start: '2023-01-01', end: '2023-04-01' });
    deepEq(P.seasonToDateRange('2023Q2'), { start: '2023-04-01', end: '2023-07-01' });
    deepEq(P.seasonToDateRange('2023Q3'), { start: '2023-07-01', end: '2023-10-01' });
    deepEq(P.seasonToDateRange('2023Q4'), { start: '2023-10-01', end: '2024-01-01' });
});

test('toFilterState/fromFilterState 往返稳定', () => {
    const q = '关键词 tag:治愈 sort:score weekday:2,4';
    const round = P.fromFilterState(P.toFilterState(q));
    assert.equal(round, '关键词 tag:治愈 sort:score weekday:2,4');
});

test('hasAdvancedFilters 正确识别纯关键词与含筛选', () => {
    assert.equal(P.hasAdvancedFilters(P.toFilterState('孤独摇滚')), false);
    assert.equal(P.hasAdvancedFilters(P.toFilterState('孤独摇滚 tag:音乐')), true);
    assert.equal(P.hasAdvancedFilters(P.toFilterState('sort:rank')), true);
});
