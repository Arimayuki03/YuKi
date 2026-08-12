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
