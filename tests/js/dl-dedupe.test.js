// 组件测试：dl-dedupe.js 同源同集下载去重（注入 store/liveProvider/fs 替身，无需 Electron）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { DlDedupe, buildKey, setFs } = require('../../src/main/dl-dedupe');
const DlRecordStore = require('../../src/main/dl-record');

/** 真实 DlRecordStore + 临时文件（与 dl-record.test.js 同款注入方式）。 */
function makeStore() {
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-dldedupe-'));
    return new DlRecordStore(path.join(dir, 'dl-records.json'));
}

const EXISTING_FILE = 'D:\\dl\\剧名 - 第1集.mp4';

// fs 替身：只有 EXISTING_FILE 视为存在（模块级注入，全文件生效）
setFs({ existsSync: (p) => String(p) === EXISTING_FILE });

test('buildKey：小写+trim 归一化，要素缺失返回空', () => {
    assert.equal(buildKey({ site: 'CSP_Xxx', vod: ' 剧名 ', episode: '第01集' }), 'csp_xxx|剧名|第01集');
    assert.equal(buildKey({ site: '', vod: 'a', episode: 'b' }), '');
    assert.equal(buildKey({ site: 's', vod: '', episode: 'b' }), '');
    assert.equal(buildKey({ site: 's', vod: 'a', episode: '' }), '');
    assert.equal(buildKey(null), '');
});

test('check：进行中任务命中 downloading', async () => {
    const store = makeStore();
    const live = [{ gid: 'g1', status: 'active' }];
    const d = new DlDedupe(store, async () => live);
    d.bind('g1', 's|v|e1', { kind: 'aria2', name: 'x', files: [], status: 'waiting', uri: 'http://u' });
    const r = await d.check('s|v|e1');
    assert.equal(r.state, 'downloading');
});

test('check：孤儿记录（引擎已无任务）放行重下', async () => {
    const store = makeStore();
    const d = new DlDedupe(store, async () => []); // 引擎里没有任何任务
    d.bind('g1', 's|v|e1', { kind: 'aria2', name: 'x', files: [], status: 'active', uri: 'http://u' });
    assert.equal(await d.check('s|v|e1'), null);
});

test('check：已完成且文件在 → done(file)', async () => {
    const store = makeStore();
    const d = new DlDedupe(store, async () => []);
    d.bind('g1', 's|v|e1', { kind: 'hls', name: 'x', files: [EXISTING_FILE], status: 'complete', uri: 'http://u' });
    const r = await d.check('s|v|e1');
    assert.equal(r.state, 'done');
    assert.equal(r.file, EXISTING_FILE);
});

test('check：完成但产物已被删 → 放行重下', async () => {
    const store = makeStore();
    const d = new DlDedupe(store, async () => []);
    d.bind('g1', 's|v|e1', { kind: 'hls', name: 'x', files: ['D:\\gone\\a.mp4'], status: 'complete', uri: 'http://u' });
    assert.equal(await d.check('s|v|e1'), null);
});

test('check：失败任务放行重下；空 key 直接 null', async () => {
    const store = makeStore();
    const d = new DlDedupe(store, async () => []);
    d.bind('g1', 's|v|e1', { kind: 'aria2', name: 'x', files: [], status: 'error', uri: 'http://u' });
    assert.equal(await d.check('s|v|e1'), null);
    assert.equal(await d.check(''), null);
});

test('stamp：会话登记优先，其次回填已有记录', () => {
    const store = makeStore();
    const d = new DlDedupe(store, async () => []);
    store.add({ gid: 'g9', name: '旧任务', status: 'active', epKey: 's|v|old' });
    d._keyByGid.set('g1', 's|v|new'); // 模拟 bind 内部登记
    assert.equal(d.stamp('g1', null), 's|v|new');
    assert.equal(d.stamp('g9', store.all().find((r) => r.gid === 'g9')), 's|v|old');
    assert.equal(d.stamp('gx', null), undefined);
});

test('carry：gid 迁移（目录重排/恢复入队）转移去重 key', () => {
    const store = makeStore();
    const d = new DlDedupe(store, async () => []);
    d.bind('old', 's|v|e1', { kind: 'aria2', name: 'x', files: [], status: 'active', uri: 'http://u' });
    assert.equal(d.carry('old', 'new'), 's|v|e1');
    assert.equal(d.stamp('new', null), 's|v|e1');

    // 跨重启场景：新实例会话 Map 为空，从持久化记录回填
    const d2 = new DlDedupe(store, async () => []);
    assert.equal(d2.carry('old', 'new2'), 's|v|e1');
    assert.equal(d2.stamp('new2', null), 's|v|e1');
});

test('整链路：add 改写记录（persistInProgress/完成事件）不丢 epKey', async () => {
    const store = makeStore();
    const d = new DlDedupe(store, async () => [{ gid: 'g1', status: 'paused' }]);
    d.bind('g1', 's|v|e1', { kind: 'aria2', name: 'x', files: [], status: 'waiting', uri: 'http://u' });

    // 模拟轮询改写（不带 epKey 字段，epKey 由 stamp 回填）
    store.add({ gid: 'g1', kind: 'aria2', name: 'x', files: [], status: 'active',
        percent: 30, done: 300, size: 1000, epKey: d.stamp('g1', store.all().find((r) => r.gid === 'g1')) });
    let r = await d.check('s|v|e1');
    assert.equal(r.state, 'downloading');

    // 模拟完成事件改写
    store.add({ gid: 'g1', kind: 'aria2', name: 'x', files: [EXISTING_FILE], status: 'complete',
        epKey: d.stamp('g1', store.all().find((r2) => r2.gid === 'g1')) });
    r = await d.check('s|v|e1');
    assert.equal(r.state, 'done');
});

test('drop：删除任务后会话登记清除', () => {
    const store = makeStore();
    const d = new DlDedupe(store, async () => []);
    d.bind('g1', 's|v|e1', { kind: 'aria2', name: 'x', files: [], status: 'active', uri: 'http://u' });
    d.drop('g1');
    assert.equal(d.stamp('g1', null), undefined);
});
