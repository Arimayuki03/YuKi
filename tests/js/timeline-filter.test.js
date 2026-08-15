// 组件测试：时间表收藏过滤 — 本地收藏 bangumiId 匹配（核心修复验证）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 模拟 _mergeLocalCollections 逻辑
function mergeLocalCollections(favs) {
    const sets = { dropped: new Set(), watched: new Set(), watching: new Set() };
    (favs || []).forEach((f) => {
        if (!f) return;
        const id = String(f.bangumiId || (String(f.site) === 'bangumi' ? f.vodId : '') || '');
        if (!id) return;
        const tag = f.tag || '';
        if (tag === 'watching') sets.watching.add(id);
        else if (tag === 'seen') sets.watched.add(id);
        else if (tag === 'dropped') sets.dropped.add(id);
    });
    return sets;
}

// 模拟 _applyFilters / idOf
function applyFilters(list, sets, filters) {
    const idOf = (it) => String((it && (it.id || (it.subject && it.subject.id))) || '');
    let out = list;
    if (filters.onlyWatching) {
        out = out.filter((it) => sets.watching.has(idOf(it)));
    } else {
        if (filters.dropped) out = out.filter((it) => !sets.dropped.has(idOf(it)));
        if (filters.watched) out = out.filter((it) => !sets.watched.has(idOf(it)));
    }
    return out;
}

test('本地收藏带 bangumiId + tag=watching → 只显示在看筛选命中', () => {
    const favs = [
        { site: 'mysite', vodId: 'v1', name: '海贼王', bangumiId: '326661', tag: 'watching' },
        { site: 'mysite', vodId: 'v2', name: '火影忍者', bangumiId: '99999', tag: 'seen' },
    ];
    const sets = mergeLocalCollections(favs);
    assert.ok(sets.watching.has('326661'));
    assert.ok(sets.watched.has('99999'));
    assert.equal(sets.watching.size, 1);
    assert.equal(sets.watched.size, 1);
});

test('只显示在看：筛选出匹配的影片', () => {
    const favs = [
        { site: 's', vodId: 'v1', bangumiId: '100', tag: 'watching' },
    ];
    const sets = mergeLocalCollections(favs);
    const timeline = [
        { id: 100, name: '海贼王' },
        { id: 200, name: '火影忍者' },
        { id: 300, name: '鬼灭之刃' },
    ];
    const result = applyFilters(timeline, sets, { onlyWatching: true });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, '海贼王');
});

test('不显示已抛弃：排除标记 dropped 的影片', () => {
    const favs = [
        { site: 's', vodId: 'v1', bangumiId: '200', tag: 'dropped' },
    ];
    const sets = mergeLocalCollections(favs);
    const timeline = [
        { id: 100, name: '海贼王' },
        { id: 200, name: '火影忍者' },
    ];
    const result = applyFilters(timeline, sets, { dropped: true, onlyWatching: false });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, '海贼王');
});

test('不显示已看完：排除标记 seen 的影片', () => {
    const favs = [
        { site: 's', vodId: 'v1', bangumiId: '100', tag: 'seen' },
    ];
    const sets = mergeLocalCollections(favs);
    const timeline = [
        { id: 100, name: '海贼王' },
        { id: 200, name: '火影忍者' },
    ];
    const result = applyFilters(timeline, sets, { watched: true, onlyWatching: false });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, '火影忍者');
});

test('无 bangumiId 的本地收藏被跳过（不影响筛选）', () => {
    const favs = [
        { site: 's', vodId: 'v1', tag: 'watching' }, // 无 bangumiId
    ];
    const sets = mergeLocalCollections(favs);
    assert.equal(sets.watching.size, 0);
});

test('site=bangumi 时用 vodId 作为 ID', () => {
    const favs = [
        { site: 'bangumi', vodId: '555', tag: 'watching' },
    ];
    const sets = mergeLocalCollections(favs);
    assert.ok(sets.watching.has('555'));
});

test('时间表项 id 为数字，收藏 bangumiId 为字符串 → String() 归一化后匹配', () => {
    const favs = [
        { site: 's', vodId: 'v1', bangumiId: '326661', tag: 'watching' },
    ];
    const sets = mergeLocalCollections(favs);
    // 后端时间表项 id 为数字（dict(subject) 扁平化）
    const timeline = [{ id: 326661, name: '海贼王' }];
    const result = applyFilters(timeline, sets, { onlyWatching: true });
    assert.equal(result.length, 1, '数字 id 与字符串 bangumiId 应能匹配');
});
