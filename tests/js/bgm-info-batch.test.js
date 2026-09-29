'use strict';
// 封面话数徽章批量详情（kazumi.js bangumiInfoBatch）回归测试：
// 1) 入参去重/过滤空值；批量封装 do=kazumiBangumiInfoBatch（ids 逗号串）
// 2) localStorage 逐 id 预筛（键与单条 bangumiInfo 一致：detail::bgminfo::v1::{id}，
//    TTL 30 分钟）——命中部分不进批量请求
// 3) 同帧重复调用共享在途 Promise（多次调用只发一次网络）
// 4) 响应经 _sanitizeBangumiInfo 净化后落缓存；缺值 id 返回 null 不拖垮整批
// 5) 后端契约：server.py 的 kazumiBangumiInfoBatch do 分支 + TTL 注册 + 逐 id
//    复用单条缓存键；plugin_manager 的 bangumi_info_batch 并发实现
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function loadKazumi(extra = {}) {    const source = read('src/renderer/js/kazumi.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number,
        parseInt, parseFloat, setTimeout, clearTimeout,
        $: () => ({ on() { return this; } }),
        warnToast() {},
        escHtml: (s) => String(s),
        document: {
            addEventListener() {},
            getElementById: () => null,
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
            body: { appendChild() {} },
        },
        window: {},
        ...extra,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'kazumi.js' });
    return context.window.YUKI && context.window.YUKI.kazumi;
}

test('bangumiInfoBatch：ids 去重过滤 + 一次批量请求 + 响应净化落缓存', async () => {
    const calls = [];
    const writes = [];
    const K = loadKazumi({
        doAction: async (doName, form) => {
            calls.push({ doName, form });
            return { code: 200, infos: { 100: { id: 100, name: 'A', eps: 12, date: '2025-01-06' } } };
        },
        localCacheGet: () => null,
        localCacheSet: (k, v, ttl) => writes.push({ k, v, ttl }),
    });
    const out = await K.bangumiInfoBatch(['100', '100', '200', '', null]);
    assert.equal(calls.length, 1, '整批只发一次请求');
    assert.equal(calls[0].doName, 'kazumiBangumiInfoBatch');
    assert.equal(calls[0].form.ids, '100,200', '去重 + 空值过滤后逗号串');
    assert.equal(out[100].eps, 12, '净化后 eps 数值字段保留');
    assert.equal(out[200], null, '响应缺值 id → null');
    // 净化后的 info 落 localStorage（键与单条 bangumiInfo 一致）
    assert.equal(writes.length, 1);
    assert.equal(writes[0].k, 'detail::bgminfo::v1::100');
    assert.equal(writes[0].ttl, 30 * 60 * 1000);
});

test('bangumiInfoBatch：缓存命中的 id 不进批量请求；全命中零网络', async () => {
    const calls = [];
    const K = loadKazumi({
        doAction: async (doName, form) => {
            calls.push({ doName, form });
            return { code: 200, infos: { 200: { id: 200, eps: 24 } } };
        },
        localCacheGet: (key) => {
            if (key === 'detail::bgminfo::v1::100') {
                return { id: 100, name: 'cached', eps: 12, date: '2025-01-06' };
            }
            return null;
        },
    });
    const out = await K.bangumiInfoBatch(['100', '200']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].form.ids, '200', '缓存命中的 100 不进批量');
    assert.equal(out[100].eps, 12, '缓存直出');
    assert.equal(out[200].eps, 24, '批量回源');
    // 全命中：零网络
    const again = await K.bangumiInfoBatch(['100']);
    assert.equal(calls.length, 1, '全命中零请求');
    assert.equal(again[100].eps, 12);
});

test('bangumiInfoBatch：同帧重复调用共享在途 Promise（只发一次网络）', async () => {
    const calls = [];
    const resolvers = [];
    const K = loadKazumi({
        doAction: (doName, form) => new Promise((resolve) => {
            calls.push({ doName, form });
            resolvers.push(() => resolve({ code: 200, infos: { 100: { id: 100, eps: 12 } } }));
        }),
        localCacheGet: () => null,
    });
    const p1 = K.bangumiInfoBatch(['100']);
    const p2 = K.bangumiInfoBatch(['100']);
    assert.equal(calls.length, 1, '并发两路只发一次请求');
    // 先 resolve 再 await：Promise 永挂会卡死测试进程
    resolvers.forEach((r) => r());
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a[100].eps, 12);
    assert.equal(b[100].eps, 12);
    assert.equal(calls.length, 1);
});

test('bangumiInfoBatch：网络失败整体吞掉返回空对象（不外溢）', async () => {
    const K = loadKazumi({
        doAction: async () => { throw new Error('network down'); },
        localCacheGet: () => null,
    });
    const out = await K.bangumiInfoBatch(['100']);
    assert.equal(Object.keys(out).length, 0, '失败返回空对象');
});

test('空入参零请求', async () => {
    const calls = [];
    const K = loadKazumi({
        doAction: async (doName, form) => { calls.push({ doName, form }); return { code: 200, infos: {} }; },
        localCacheGet: () => null,
    });
    const empty = await K.bangumiInfoBatch([]);
    assert.equal(Object.keys(empty).length, 0, '空入参返回空对象');
    const fromNull = await K.bangumiInfoBatch(null);
    assert.equal(Object.keys(fromNull).length, 0, 'null 入参返回空对象');
    assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- 后端契约（源码静态断言）

test('后端：kazumiBangumiInfoBatch do 分支 + TTL + 逐 id 复用单条缓存键 + 并发批量实现', () => {
    const serverSrc = read('python-backend/server.py');
    assert.match(serverSrc, /if do == 'kazumiBangumiInfoBatch':/, 'server.py 应有批量 do 分支');
    assert.match(serverSrc, /'kazumiBangumiInfoBatch': 1800/, '批量端点注册 30 分钟 TTL');
    // 徽章不拉取 bug 回归锁：缓存键参数表必须含 ids，否则所有批次共用一个
    // 整包缓存键，首个批次写入后其他页面的批量请求全部命中旧批次（静默无徽章）
    assert.match(
        serverSrc,
        /keys = \('id', 'ids', 'episodeId'/,
        '_bangumi_cache_key 参数表必须含 ids（不同 id 集各自成键）',
    );
    assert.match(
        serverSrc,
        /_bangumi_cache_key\('kazumiBangumiInfo', \{'id': sid\}\)/,
        '逐 id 读写单条 kazumiBangumiInfo 缓存键（批量/单条互通）',
    );
    assert.match(serverSrc, /kazumi_mgr\.bangumi_info_batch\(missing\)/, '缺失 id 走并发批量');
    const pmSrc = read('python-backend/kazumi/plugin_manager.py');
    assert.match(pmSrc, /def bangumi_info_batch\(self, subject_ids/, 'plugin_manager 应有批量方法');
    assert.match(pmSrc, /ThreadPoolExecutor/, '批量实现用线程池并发');
});
