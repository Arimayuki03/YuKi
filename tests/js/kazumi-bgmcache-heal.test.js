// 组件测试：Kazumi Bangumi 匹配缓存毒条目自愈（历史页封面拉取失败的根源）。
// 场景：搜索页点击路径 cacheBangumiMatch 写入 {id, cover:''}（首条结果无 images），
// 旧实现被 getBangumiMatch 当完整命中永久短路，只能手动清缓存；新实现按 id 拉详情补图，
// 持久化时过滤残缺条目。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

function loadKazumi(extra = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/kazumi.js'), 'utf8');
    const jqueryStub = () => ({
        on() { return this; }, off() { return this; }, val() { return ''; },
        text() { return this; }, html() { return this; }, show() { return this; },
        hide() { return this; }, empty() { return this; }, append() { return this; },
        prop() { return this; }, toggle() { return this; }, length: 1,
    });
    const store = {};
    const context = {
        console, Map, Promise, Date, Math, JSON, String, Array, Number,
        parseInt, parseFloat, setTimeout, clearTimeout,
        $: jqueryStub,
        warnToast() {},
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
        localCacheGet: () => null,
        localCacheSet: () => {},
        bangumiCover: (v) => (typeof v === 'string' ? v : ((v && (v.common || v.large)) || '')),
        window: { yuki: {} },
        ...extra,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testKazumi = Kazumi;`, context, { filename: 'kazumi.js' });
    const K = context.__testKazumi;
    K.__store = store;
    return K;
}

test('getBangumiMatch：{id,无cover} 毒条目按 id 拉详情自愈，不再永久占位', async () => {
    const calls = [];
    const K = loadKazumi({
        doAction: async (action) => {
            calls.push(action);
            if (action === 'kazumiBangumiInfo') {
                return { info: { id: 42, images: { common: 'https://lain.bgm.tv/pic/cover/c/x.jpg' } } };
            }
            return { results: [] };
        },
    });
    K._bgmMatchCache.set('毒动画', { id: 42, cover: '' });
    const m = await K.getBangumiMatch('毒动画');
    assert.equal(m.id, 42);
    assert.equal(m.cover, 'https://lain.bgm.tv/pic/cover/c/x.jpg');
    assert.ok(calls.includes('kazumiBangumiInfo'), '应按 id 拉详情补封面');
    assert.ok(!calls.includes('kazumiBangumiSearch'), 'id 可用时不应按名重搜（两次搜索首条可能不同部）');
});

test('getBangumiMatch：详情失败回退按名搜索，跳过无 images 的首条结果', async () => {
    const K = loadKazumi({
        doAction: async (action) => {
            if (action === 'kazumiBangumiInfo') return { info: null };
            if (action === 'kazumiBangumiSearch') {
                return {
                    results: [
                        { id: 1, images: null }, // 无图首条：旧实现取 [0] 会写毒条目
                        { id: 2, images: { common: 'https://lain.bgm.tv/pic/cover/c/ok.jpg' } },
                    ],
                };
            }
            return {};
        },
    });
    K._bgmMatchCache.set('某番', { id: 1, cover: '' });
    const m = await K.getBangumiMatch('某番');
    assert.equal(m.id, 2, '应选中首个带 images 的结果');
    assert.equal(m.cover, 'https://lain.bgm.tv/pic/cover/c/ok.jpg');
});

test('_saveBgmMatchCache：id 无封面的残缺条目不落盘（重启后不再中毒）', async () => {
    const K = loadKazumi({
        doAction: async (action) => {
            if (action === 'kazumiBangumiInfo') return { info: null };
            return { results: [] };
        },
    });
    // 点击路径回填：首条无图 → {id, cover:''}
    K.cacheBangumiMatch('残缺番', 99, '');
    const raw = K.__store['kazumi_bgm_cover'] || '[]';
    const entries = JSON.parse(raw);
    assert.ok(!entries.some(([, v]) => v && v.id === 99 && !v.cover),
        'id-only 条目不应被持久化');
});

test('getBangumiMatch：负缓存 60s 内直接返回，过期后重搜', async () => {
    let searchCount = 0;
    const K = loadKazumi({
        doAction: async (action) => {
            if (action === 'kazumiBangumiSearch') {
                searchCount++;
                return { results: [{ id: 7, images: { common: 'https://lain.bgm.tv/pic/cover/c/n.jpg' } }] };
            }
            return {};
        },
    });
    // 60s 内的负缓存：不发请求
    K._bgmMatchCache.set('负缓存番', { id: 0, cover: '', negAt: Date.now() });
    let m = await K.getBangumiMatch('负缓存番');
    assert.equal(searchCount, 0, '负缓存期内不应重搜');
    assert.equal(m.id, 0);
    // 过期的负缓存：删除并重搜
    K._bgmMatchCache.set('负缓存番', { id: 0, cover: '', negAt: Date.now() - 61000 });
    m = await K.getBangumiMatch('负缓存番');
    assert.equal(searchCount, 1, '过期后应重搜');
    assert.equal(m.id, 7);
});

test('_loadBgmMatchCache：加载时丢弃旧版持久化的 id-only 毒条目', () => {
    const K = loadKazumi({
        doAction: async () => ({ results: [] }),
    });
    const poison = JSON.stringify([
        ['中毒番', { id: 5, cover: '' }],           // 毒条目：应被丢弃
        ['好番', { id: 6, cover: 'https://lain.bgm.tv/pic/cover/c/g.jpg' }], // 完整条目保留
    ]);
    K.__store['kazumi_bgm_cover'] = poison;
    K._loadBgmMatchCache();
    assert.equal(K.getCachedBangumiCover('中毒番'), '', '毒条目不应加载为有效缓存');
    assert.equal(K.getCachedBangumiCover('好番'), 'https://lain.bgm.tv/pic/cover/c/g.jpg');
});
