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
