// 组件测试：下载列表稳定排序（全部开始/暂停时卡片顺序跳动修复）+ 排序模式。
// aria2 listAll 按 [active, waiting, stopped] 分组拼接，批量暂停/恢复的 RPC 过渡期
// 任务在分组间迁移，推送顺序短暂变化——渲染层按 gid 首次出现顺序稳定排列。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

function loadDownloads() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/downloads.js'), 'utf8');
    const rendered = [];
    const elStub = () => {
        const o = {
            length: 1,
            text() { return o; }, show() { return o; }, hide() { return o; },
            empty() { return o; }, html(h) { if (h !== undefined) rendered.push(String(h)); return o; },
            children() { return []; }, val() { return ''; }, on() { return o; },
            trigger() { return o; },
        };
        return o;
    };
    const context = {
        console, Map, Promise, Date, Math, JSON, String, Array, Number,
        setTimeout, clearTimeout,
        $: (sel) => elStub(),
        warnToast() {},
        fmtSize: () => '1 B',
        localStorage: { getItem: () => null, setItem() { } },
        window: { yuki: { download: {} } },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testDownloads = Downloads;`, context, { filename: 'downloads.js' });
    const D = context.__testDownloads;
    D.__rendered = rendered;
    return D;
}

test('render：批量暂停过渡期顺序抖动时，卡片保持首次出现顺序', () => {
    const D = loadDownloads();
    const mk = (gid, name) => ({ gid, name, status: 'active', percent: 10, speed: 1, files: [] });
    // 第一次推送：a b c
    D.render([mk('a', 'A'), mk('b', 'B'), mk('c', 'C')]);
    assert.deepEqual(D._tasks.map((t) => t.gid), ['a', 'b', 'c']);
    // 过渡态推送（RPC 逐个生效）：c 已迁到 waiting 组 → 推送序变成 c a b
    D.render([mk('c', 'C'), mk('a', 'A'), mk('b', 'B')]);
    assert.deepEqual(D._tasks.map((t) => t.gid), ['a', 'b', 'c'], '不应跟随分组拼接序跳动');
    // 恢复完成：回到 a b c
    D.render([mk('a', 'A'), mk('b', 'B'), mk('c', 'C')]);
    assert.deepEqual(D._tasks.map((t) => t.gid), ['a', 'b', 'c']);
});

test('render：新任务固定排在既有任务之后', () => {
    const D = loadDownloads();
    const mk = (gid) => ({ gid, name: gid, status: 'waiting', percent: 0, files: [] });
    D.render([mk('a'), mk('b')]);
    D.render([mk('c'), mk('a'), mk('b')]);
    assert.deepEqual(D._tasks.map((t) => t.gid), ['a', 'b', 'c'], '新 gid 排尾，不因推送序插队');
});

test('render：按名称排序', () => {
    const D = loadDownloads();
    D._sort = 'name';
    const mk = (gid, name) => ({ gid, name, status: 'complete', files: [] });
    D.render([mk('z', 'banana'), mk('y', 'apple'), mk('x', 'cherry')]);
    const names = D._tasks.map((t) => t.name);
    assert.deepEqual(names, ['apple', 'banana', 'cherry']);
});

test('render：按时间排序（新→旧，addedAt 优先）', () => {
    const D = loadDownloads();
    D._sort = 'time';
    const mk = (gid, addedAt) => ({ gid, name: gid, status: 'complete', files: [], addedAt });
    // 先出现旧任务（无 addedAt → 用首次出现时间），再推送带 addedAt 的恢复记录
    D.render([mk('old', 1000)]);
    D.render([mk('new', 9000), mk('old', 1000)]);
    assert.deepEqual(D._tasks.map((t) => t.gid), ['new', 'old'], 'addedAt 大的在前');
});

test('render：已消失任务的登记被清理（防 Map 无限增长）', () => {
    const D = loadDownloads();
    const mk = (gid) => ({ gid, name: gid, status: 'complete', files: [] });
    const many = [];
    for (let i = 0; i < 30; i++) many.push(mk('g' + i));
    D.render(many);
    D.render([mk('g1')]); // 大量任务被删除/清除
    D.render([mk('g1')]); // 再推一次触发清理阈值
    assert.ok(D._order.size <= 30 * 2 + 50 + 1, '登记表不应无限增长');
    assert.ok(D._order.has('g1'), '存活任务的登记保留');
});
