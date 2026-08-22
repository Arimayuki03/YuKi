// 组件测试：dl-record.js 下载记录持久化（注入临时路径，无需 Electron）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DlRecordStore = require('../../src/main/dl-record');

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-dl-'));
    return path.join(dir, 'dl-records.json');
}

test('add + all：记录落盘且最新在前', () => {
    const store = new DlRecordStore(tmpFile());
    store.add({ gid: 'a', name: '影片A', status: 'complete', size: 100 });
    store.add({ gid: 'b', name: '影片B', status: 'error', size: 0 });
    const all = store.all();
    assert.equal(all.length, 2);
    assert.equal(all[0].gid, 'b'); // 最新在前
});

test('add：同 gid 覆盖为最新（不产生重复）', () => {
    const store = new DlRecordStore(tmpFile());
    store.add({ gid: 'a', name: 'v1', status: 'complete', size: 100 });
    store.add({ gid: 'a', name: 'v2', status: 'complete', size: 200 });
    const all = store.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'v2');
});

test('remove：删除单条', () => {
    const store = new DlRecordStore(tmpFile());
    store.add({ gid: 'a', name: 'x', status: 'complete' });
    store.add({ gid: 'b', name: 'y', status: 'complete' });
    store.remove('a');
    assert.deepEqual(store.all().map((r) => r.gid), ['b']);
});

test('clear：清空全部', () => {
    const store = new DlRecordStore(tmpFile());
    store.add({ gid: 'a', name: 'x', status: 'complete' });
    store.clear();
    assert.deepEqual(store.all(), []);
});

test('clearErrors：仅清失败记录', () => {
    const store = new DlRecordStore(tmpFile());
    store.add({ gid: 'a', name: 'ok', status: 'complete' });
    store.add({ gid: 'b', name: 'err', status: 'error' });
    store.clearErrors();
    const all = store.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].gid, 'a');
});

test('跨实例持久化：新实例读回磁盘记录', () => {
    const file = tmpFile();
    const s1 = new DlRecordStore(file);
    s1.add({ gid: 'a', name: '持久化', status: 'complete', size: 42 });
    const s2 = new DlRecordStore(file);
    assert.equal(s2.all().length, 1);
    assert.equal(s2.all()[0].name, '持久化');
});

test('损坏文件自动重置为空', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{corrupted json');
    const store = new DlRecordStore(file);
    assert.deepEqual(store.all(), []);
});
