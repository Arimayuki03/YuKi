/**
 * detail-snap.test.js — A-01 详情页列表快照写入侧单元测试（渲染层，node:vm + 全局桩）。
 *
 * 覆盖：
 *  ① put/get 往返 + key 格式（detail::snap::v1::<site|vodId>，yuki_cache:: 命名空间）
 *  ② 畸形/过期/字段缺失/键内容不一致安全丢弃
 *  ③ 5 处调用方源码锚点断言（写入调用存在、detail.js 未被本阶段触碰）
 *  ④ TTL 2h 断言（cache.js 收到的过期时间戳 = now + 2h）
 *  ⑤ index.html defer 脚本列表注册断言
 */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 内存 localStorage 桩（与 home-detail.test.js 同款：真实遍历语义）。 */
function makeLs() {
    const store = new Map();
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        key: (i) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
        __store: store,
    };
}

/** 在 VM 沙箱加载 cache.js + detail-snap.js，返回 { DetailSnap, ls }。 */
function loadSnap({ clock } = {}) {
    const ls = makeLs();
    const context = {
        console, Date: clock || Date, JSON, String, Number, Object, Array, Math, isFinite,
        localStorage: ls,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${read('src/renderer/js/cache.js')}\n;${read('src/renderer/js/detail-snap.js')}`,
        context, { filename: 'detail-snap.js' });
    return { DetailSnap: context.DetailSnap, ls };
}

// ================================================================ ① put/get 往返 + key 格式
describe('detail-snap put/get 往返与 key 格式', () => {
    test('往返：四字段齐全时原样读回并带 site/vodId/ts', () => {
        const { DetailSnap } = loadSnap();
        DetailSnap.put('mysite', 'v123', { pic: 'http://p/1.jpg', name: '片名', remarks: '更新至 12 集', year: '2026' });
        const got = DetailSnap.get('mysite', 'v123');
        assert.ok(got, '应命中');
        assert.equal(got.site, 'mysite');
        assert.equal(got.vodId, 'v123');
        assert.equal(got.pic, 'http://p/1.jpg');
        assert.equal(got.name, '片名');
        assert.equal(got.remarks, '更新至 12 集');
        assert.equal(got.year, '2026');
        assert.equal(typeof got.ts, 'number');
    });

    test('key 格式：detail::snap::v1::<site|vodId>，落 yuki_cache:: 命名空间', () => {
        const { DetailSnap, ls } = loadSnap();
        assert.equal(DetailSnap.key('a', 'b'), 'detail::snap::v1::a|b');
        DetailSnap.put('a', 'b', { name: 'x' });
        const keys = Array.from(ls.__store.keys());
        assert.equal(keys.length, 1);
        assert.equal(keys[0], 'yuki_cache::detail::snap::v1::a|b');
    });

    test('site 为空串（Bangumi 路径口径）合法：key 为 |vodId 且往返一致', () => {
        const { DetailSnap } = loadSnap();
        assert.ok(DetailSnap.put('', 'bgm42', { name: '番名' }));
        const got = DetailSnap.get('', 'bgm42');
        assert.ok(got);
        assert.equal(got.site, '');
        assert.equal(got.name, '番名');
    });

    test('空值防御：site null 归一为空串、vodId 数字字符串化', () => {
        const { DetailSnap } = loadSnap();
        DetailSnap.put(null, 77, { name: 'n' });
        assert.ok(DetailSnap.get('', '77'), '数字 id 字符串化后应命中');
    });

    test('不存 vod_play_url：put 无该参数，条目值不含播放地址字段', () => {
        const { DetailSnap, ls } = loadSnap();
        DetailSnap.put('s', 'i', { name: 'n', vod_play_url: 'hack' });
        const raw = JSON.parse(Array.from(ls.__store.values())[0]);
        assert.equal(raw.v.vod_play_url, undefined);
    });
});

// ================================================================ ② 畸形/过期/字段缺失安全丢弃
describe('detail-snap 畸形/过期/字段缺失安全丢弃', () => {
    test('全部字段为空：put 返回 false 不落盘', () => {
        const { DetailSnap, ls } = loadSnap();
        assert.equal(DetailSnap.put('s', 'i', {}), false);
        assert.equal(DetailSnap.put('s', 'i', { pic: '', name: '  ' }), false);
        assert.equal(DetailSnap.put('s', 'i', null), false);
        assert.equal(ls.__store.size, 0);
    });

    test('vodId 为空：put/get 均拒绝', () => {
        const { DetailSnap, ls } = loadSnap();
        assert.equal(DetailSnap.put('s', '', { name: 'n' }), false);
        assert.equal(DetailSnap.put('s', null, { name: 'n' }), false);
        assert.equal(DetailSnap.get('s', ''), null);
        assert.equal(ls.__store.size, 0);
    });

    test('部分快照合法：仅 name 也能写入与读回', () => {
        const { DetailSnap } = loadSnap();
        DetailSnap.put('s', 'i', { name: '只有名字' });
        const got = DetailSnap.get('s', 'i');
        assert.equal(got.name, '只有名字');
        assert.equal(got.pic, undefined);
        assert.equal(got.year, undefined);
    });

    test('未命中/畸形值安全丢弃：get 返回 null 不抛异常', () => {
        const { DetailSnap, ls } = loadSnap();
        assert.equal(DetailSnap.get('s', 'missing'), null);
        ls.__store.set('yuki_cache::detail::snap::v1::s|bad', 'not-json{{{');
        ls.__store.set('yuki_cache::detail::snap::v1::s|arr', JSON.stringify([1, 2]));
        ls.__store.set('yuki_cache::detail::snap::v1::s|num', JSON.stringify({ v: 42, e: 0, t: 1 }));
        assert.equal(DetailSnap.get('s', 'bad'), null);
        assert.equal(DetailSnap.get('s', 'arr'), null);
        assert.equal(DetailSnap.get('s', 'num'), null);
    });

    test('键内容不一致不信任：值内 site/vodId 与 key 不符按未命中处理', () => {
        const { DetailSnap, ls } = loadSnap();
        DetailSnap.put('s1', 'i1', { name: 'n' });
        // 直接把 s2|i2 的值写到 s1|i1 的 key 下（模拟串键脏数据）
        const v = DetailSnap.get('s1', 'i1');
        ls.__store.set('yuki_cache::detail::snap::v1::s1|i1',
            JSON.stringify({ v: { site: 's2', vodId: 'i1', name: v.name, ts: Date.now() }, e: 0, t: Date.now() }));
        assert.equal(DetailSnap.get('s1', 'i1'), null);
    });

    test('过期（TTL 之外）：get 返回 null（cache.js 惰性删除语义）', () => {
        // 固定时钟：先写入，再把时钟拨到 3h 后
        let now = 1_700_000_000_000;
        const { DetailSnap, ls } = loadSnap({ clock: { now: () => now } });
        DetailSnap.put('s', 'i', { name: 'n' });
        now += 3 * 60 * 60 * 1000; // 3h > TTL 2h
        assert.equal(DetailSnap.get('s', 'i'), null);
        assert.equal(ls.__store.get('yuki_cache::detail::snap::v1::s|i'), undefined, '过期条目应被惰性删除');
    });
});

// ================================================================ ④ TTL 2h 断言
describe('detail-snap TTL 2h', () => {
    test('写入的过期时间戳 = 写入时刻 + 2h', () => {
        let now = 1_700_000_000_000;
        const { DetailSnap, ls } = loadSnap({ clock: { now: () => now } });
        DetailSnap.put('s', 'i', { name: 'n' });
        const raw = JSON.parse(ls.__store.get('yuki_cache::detail::snap::v1::s|i'));
        assert.equal(raw.e, now + 2 * 60 * 60 * 1000);
        assert.equal(raw.t, now);
        assert.equal(DetailSnap.TTL_MS, 2 * 60 * 60 * 1000);
    });
});

// ================================================================ ③ 调用方源码锚点断言
describe('调用方源码锚点：5 处写入点存在且 detail.js 已消费快照（open() 接线落地）', () => {
    const srcOf = (f) => read('src/renderer/js/' + f);

    test('home.js：卡片点击写入快照', () => {
        const src = srcOf('home.js');
        assert.match(src, /DetailSnap\.put\(this\.site,\s*el\.data\('id'\),\s*Home\._snapFieldsFromCard\(el\)\)/);
        assert.match(src, /Detail\.open\(this\.site,\s*el\.data\('id'\)/);
    });

    test('search.js：CatVod 结果卡点击写入快照（kazumi 分支不写）', () => {
        const src = srcOf('search.js');
        // 2026-10-02：裸调用改走 _snapPutSearch（DetailSnap/Home 缺席时静默跳过，
        // 不得在 Detail.open 之前抛错打断主流程）。锚点改为验证「写入仍存在且已守卫」。
        assert.match(src, /_snapPutSearch\(src,\s*el\.data\('id'\),\s*el\)/);
        assert.match(src, /Detail\.open\(src,\s*el\.data\('id'\)/);
        assert.match(src, /function _snapPutSearch\(site, id, \$el\)/);
        assert.match(src, /typeof Home === 'undefined' \|\| typeof Home\._snapFieldsFromCard !== 'function'\) return false/);
    });

    test('records.js：收藏/历史卡点击写入快照（bangumi/kazumi 分支不写）', () => {
        const src = srcOf('records.js');
        // 同上：改走 _snapPut helper（纯优化路径永不抛错）
        assert.match(src, /_snapPut\(site,\s*String\(el\.data\('id'\)\),\s*el\)/);
        assert.match(src, /Detail\.open\(site,\s*String\(el\.data\('id'\)\)/);
        assert.match(src, /function _snapPut\(site, id, \$el\)/);
    });

    test('timeline.js：Bangumi 卡点击写入快照（site 空串）', () => {
        const src = srcOf('timeline.js');
        assert.match(src, /DetailSnap\.put\('',\s*id,\s*Home\._snapFieldsFromCard/);
        assert.match(src, /Kazumi\.openBangumiInfoPage\(id\)/);
    });

    test('popular.js：Bangumi 卡点击写入快照（site 空串）', () => {
        const src = srcOf('popular.js');
        assert.match(src, /DetailSnap\.put\('',\s*id,\s*Home\._snapFieldsFromCard/);
        assert.match(src, /Kazumi\.openBangumiInfoPage\(id\)/);
    });

    test('detail.js：第二阶段接线已落地（open() 消费 DetailSnap.get）', () => {
        // A-01 第一阶段此处曾锁「detail.js 无 DetailSnap 引用」；第二阶段消费接线
        // （open() 读快照 → 半渲染 hero → load() 结果优先合并）落地后反转为存在性断言。
        // 行为级覆盖在 detail-skeleton-wiring.test.js（快照命中/冲突优先/无快照走骨架）。
        const src = srcOf('detail.js');
        assert.match(src, /DetailSnap\.get\(/, 'open() 应读取列表快照');
        assert.match(src, /_snapHeroShown/, '应有半渲染态标记（load() 侧保留快照 hero）');
        assert.match(src, /snapHero: true/, 'render 应收到 snapHero 半渲染标记');
    });

    test('index.html：detail-snap.js 已注册 defer 脚本且先于 detail.js 加载', () => {
        const html = read('src/renderer/index.html');
        assert.match(html, /<script src="js\/detail-snap\.js" defer><\/script>/);
        const snapAt = html.indexOf('js/detail-snap.js');
        const detailAt = html.indexOf('js/detail.js');
        assert.ok(snapAt > -1 && detailAt > snapAt, '快照模块须先于 detail.js');
    });
});
