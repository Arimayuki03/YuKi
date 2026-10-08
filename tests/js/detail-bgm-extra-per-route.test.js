'use strict';
// A-29 回归测试：角色/制作/关联页签不得因「共用 _bgmExtraLoaded」把在途数据渲染成「暂无」。
//
// 缺陷背景（用户报告：「数据太多导致显示暂无数据」）：
// _loadBgmExtra 四路并发，但 _bgmExtraLoaded 在**吐槽路**到达（最快，通常 ~1s）时
// 即无条件置真；角色路要并发补全角色中文名（N 个角色 = N 次详情请求，长番剧实测
// 8~22s），制作/关联同样慢于吐槽。共用标志期间切到这三个页签会穿过骨架判定、而
// 数组仍是空的 → 渲染成「暂无角色信息/暂无制作人员信息/暂无关联番剧」，数据随后
// 到达也只在页签内重绘一次。条目角色/关联越多越容易命中，正是「数据越多越显示暂无」。
//
// 修复口径：逐路 settle 标志 _bgmExtraRouteLoaded —— 每页签等到自己那一路真正
// settle（成功或判失败）才出内容；慢路只影响自己，快路照常秒出。
//
// 覆盖：
// ① 角色路慢于吐槽路 → 吐槽已上屏时角色页签仍是骨架（不得显示「暂无角色信息」）；
// ② 角色路最终到达 → 页签渲染卡片（数据不丢）；
// ③ 制作/关联同口径（各自等自己的路）；
// ④ 请求成功但空列表 → 仍维持「暂无…」文案（回归保护：不得误显骨架/错误态）；
// ⑤ 换片/重试复位逐路标志（页签回到骨架，不沿用上一部番剧的 settle 态）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const plain = (x) => JSON.parse(JSON.stringify(x));

/** 最小 jQuery 桩（对齐 detail-bgm-extra-fail.test.js）：html 按选择器捕获 + on 记录监听。 */
function makeJqStub(captor) {
    const makeNode = (sel) => ({
        sel: String(sel),
        length: 1,
        _data: {},
        on(ev, a, b) {
            const fn = typeof b === 'function' ? b : a;
            if (captor && typeof fn === 'function') captor.bound.push({ sel: String(sel), ev, fn });
            return this;
        },
        off() { return this; },
        html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), String(s)); return this; },
        text() { return this; },
        addClass() { return this; },
        removeClass() { return this; },
        attr() { return this; },
        prop() { return this; },
        find(s) { return makeNode(s === undefined ? String(sel) + ' *' : String(sel) + ' ' + String(s)); },
        children() { return Object.assign(makeNode(String(sel) + ' > *'), { length: 0 }); },
        first() { return this; },
        each() { return this; },
        not() { return this; },
        is() { return false; },
        toggle() { return this; },
        hide() { return this; },
        show() { return this; },
        closest() { return makeNode(String(sel) + ' ^'); },
        data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
    });
    return (sel) => makeNode(sel);
}

function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const captor = { bound: [], htmlBySel: new Map() };
    const warns = [];
    const context = {
        console: { warn: (...a) => warns.push(a.map(String).join(' ')), log: () => {}, error: () => {}, info: () => {} },
        Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, URL,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: () => null,
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: makeJqStub(captor),
        registerEsc: () => {},
        staggerEnter: () => {},
        replayClass: () => {},
        escHtml: (s) => String(s),
        stripHtml: (s) => String(s || ''),
        warnToast: () => {},
        showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: () => '<img src="cover.jpg">',
        normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        localCacheGet: () => null,
        localCacheSet: () => {},
        localCacheDel: () => {},
        openDialog: () => {},
        closeDialog: () => {},
        doAction: async () => ({ list: [] }),
        // open() 依赖 App.currentView / showView；最小桩（换片复位路径不触及其他分支）
        App: { currentView: 'home', showView() {}, _detailOpening: false },
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, bound: captor.bound, htmlBySel: captor.htmlBySel, warns, context };
}

/** 可控的四路 Kazumi 桩：每路用 deferred 手动决定何时 settle，模拟真实速度差。 */
function deferredRoutes(overrides) {
    const mk = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
    const d = { comments: mk(), characters: mk(), staff: mk(), relations: mk() };
    const Kazumi = {
        bangumiComments: () => d.comments.p,
        bangumiCharacters: () => d.characters.p,
        bangumiStaff: () => d.staff.p,
        bangumiRelations: () => d.relations.p,
    };
    Object.assign(Kazumi, overrides || {});
    return { d, Kazumi };
}

const flush = () => new Promise((r) => setImmediate(r));

/** 标准夹具：_bgmId 已设 + 指定页签。 */
function fixture(Kazumi, tab) {
    const loaded = loadDetail({ Kazumi });
    loaded.Detail._bgmId = '42';
    loaded.Detail._bgmInfo = { id: 42, name: '番剧' };
    loaded.Detail._activeTab = tab || '角色';
    return loaded;
}

// ---------------------------------------------------------------- ① 角色路慢于吐槽路 → 骨架而非「暂无」

test('A-29①：吐槽先到（_bgmExtraLoaded 置真）时角色路仍在途 → 角色页签渲染骨架，不得显示「暂无角色信息」', async () => {
    const { d, Kazumi } = deferredRoutes();
    const { Detail, htmlBySel } = fixture(Kazumi, '角色');
    Detail._loadBgmExtra();
    // 只让吐槽路 settle（模拟吐槽 ~1s 返回、角色路仍在补全中文名）
    d.comments.res({ list: [{ user: { nickname: '甲' }, comment: 'x' }], total: 1 });
    await flush(); await flush();
    assert.equal(Detail._bgmExtraLoaded, true, '吐槽到达即置真（既有语义不变）');
    assert.equal(Detail._bgmRouteSettled('characters'), false, '角色路未 settle');
    Detail._renderTabContent();
    const html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(!html.includes('暂无角色信息'), '角色数据还在途时不得渲染「暂无角色信息」（本缺陷根因）');
    assert.ok(html.includes('skeleton') || html.includes('加载中'), '在途期间应显示骨架/加载中占位');

    // 角色路随后到达 → 正常渲染卡片（数据不丢）
    d.characters.res([{ id: 7, name: '甲', name_cn: '甲先生', relation: '主角', images: {}, actors: [] }]);
    d.staff.res([]); d.relations.res([]);
    await flush(); await flush();
    assert.equal(Detail._bgmRouteSettled('characters'), true, '角色路到达后置位');
    Detail._renderTabContent();
    const html2 = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html2.includes('甲先生'), '角色数据到达后正常渲染卡片');
});

// ---------------------------------------------------------------- ② 制作/关联同口径

test('A-29②：制作/关联各自等自己的路（吐槽已到、本路在途 → 骨架，不误显「暂无」）', async () => {
    for (const [tab, route, emptyText] of [
        ['制作', 'staff', '暂无制作人员信息'],
        ['关联', 'relations', '暂无关联番剧'],
    ]) {
        const { d, Kazumi } = deferredRoutes();
        const { Detail, htmlBySel } = fixture(Kazumi, tab);
        Detail._loadBgmExtra();
        d.comments.res({ list: [], total: 0 });
        await flush(); await flush();
        assert.equal(Detail._bgmExtraLoaded, true);
        assert.equal(Detail._bgmRouteSettled(route), false, `${tab} 路未 settle`);
        Detail._renderTabContent();
        const html = String(htmlBySel.get('#detail-tab-content') || '');
        assert.ok(!html.includes(emptyText), `${tab}：本路在途不得渲染「${emptyText}」`);
        assert.ok(html.includes('skeleton') || html.includes('加载中'), `${tab}：在途期间显示骨架`);
        // 收尾（避免未 settle 的 promise 悬挂）
        d.characters.res([]); d.staff.res([]); d.relations.res([]);
        await flush();
    }
});

// ---------------------------------------------------------------- ③ 真无数据 → 维持「暂无」（回归保护）

test('A-29③：请求成功但空列表 → 维持「暂无…」文案（逐路标志不得把空态变成永久骨架）', async () => {
    const { Detail, htmlBySel } = fixture({
        bangumiComments: async () => ({ list: [], total: 0 }),
        bangumiCharacters: async () => [],
        bangumiStaff: async () => [],
        bangumiRelations: async () => [],
    });
    await Detail._loadBgmExtra();
    await flush(); await flush();
    assert.deepEqual(plain(Detail._bgmExtraRouteLoaded),
        { comments: true, characters: true, staff: true, relations: true }, '四路均 settle');
    for (const [tab, text] of [['角色', '暂无角色信息'], ['制作', '暂无制作人员信息'], ['关联', '暂无关联番剧']]) {
        Detail._activeTab = tab;
        Detail._renderTabContent();
        assert.ok(String(htmlBySel.get('#detail-tab-content') || '').includes(text), `${tab}：真无数据应显示「${text}」`);
    }
});

// ---------------------------------------------------------------- ④ 换片/重试复位逐路标志

test('A-29④：换片与重试复位逐路标志（不沿用上一部番剧的 settle 态）', async () => {
    const { Detail } = fixture({
        bangumiComments: async () => ({ list: [], total: 0 }),
        bangumiCharacters: async () => [{ id: 1, name: 'A' }],
        bangumiStaff: async () => [],
        bangumiRelations: async () => [],
    });
    await Detail._loadBgmExtra();
    await flush(); await flush();
    assert.equal(Detail._bgmRouteSettled('characters'), true, '加载完成后角色路已 settle');

    // 重试：期间回到骨架（用户点了重试应看到加载反馈）
    Detail._retryBgmExtra();
    assert.deepEqual(plain(Detail._bgmExtraRouteLoaded),
        { comments: false, characters: false, staff: false, relations: false }, '重试复位逐路标志');
    await flush(); await flush();
    assert.equal(Detail._bgmRouteSettled('characters'), true, '重试完成后恢复 settle');

    // 换片（open 路径）：复位。open 需要 App 桩与站点/影片参数，此处只验证
    // 复位语义——用最小 App 桩承载（其余副作用由既有测试覆盖）。
    Detail._backStack = [];
    Detail.open('site-a', 'v1');
    assert.deepEqual(plain(Detail._bgmExtraRouteLoaded),
        { comments: false, characters: false, staff: false, relations: false }, '换片复位逐路标志');
});

// ---------------------------------------------------------------- ⑤ partial 缓存空占位不当作已 settle

test('A-29⑤：命中 partial 缓存且三路为空占位 → 该路不置 settle（骨架等补齐，不误显「暂无」）', async () => {
    const CACHE_PREFIX = 'detail::bgmextra::v1::';
    const store = new Map();
    // 预置 partial 半截条目：仅吐槽有数据，角色/制作/关联是空占位
    store.set('yuki_bigcache::' + CACHE_PREFIX + '42', JSON.stringify({
        v: { comments: [{ user: { nickname: '甲' }, comment: 'x' }], characters: [], staff: [], relations: [], commentTotal: 1, partial: true, failed: [] },
        e: Date.now() + 30 * 60 * 1000, t: Date.now(),
    }));
    const ls = {
        get length() { return store.size; },
        key: (i) => [...store.keys()][i],
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
    };
    let charsCalls = 0;
    const loaded = loadDetail({
        localCacheGet: (k) => {
            const raw = store.get('yuki_bigcache::' + k) || store.get('yuki_cache::' + k);
            if (!raw) return null;
            try {
                const o = JSON.parse(raw);
                if (o.e && Date.now() >= o.e) return null;
                return o.v;
            } catch (e) { return null; }
        },
        localCacheSet: () => {},
        Kazumi: {
            bangumiComments: async () => ({ list: [], total: 0 }),
            bangumiCharacters: async () => { charsCalls++; return []; },
            bangumiStaff: async () => [],
            bangumiRelations: async () => [],
        },
    });
    Object.defineProperty(loaded.context, 'localStorage', { value: ls, configurable: true });
    const { Detail, htmlBySel } = loaded;
    Detail._bgmId = '42';
    Detail._activeTab = '角色';
    await Detail._loadBgmExtra();
    assert.equal(Detail._bgmExtraRouteLoaded.characters, false,
        'partial 缓存里角色为空占位时不算 settle（否则渲染成「暂无角色信息」）');
    Detail._renderTabContent();
    const html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(!html.includes('暂无角色信息'), 'partial 命中不得误显「暂无角色信息」');
    assert.ok(charsCalls >= 1, 'partial 命中应后台重拉补齐');
});
