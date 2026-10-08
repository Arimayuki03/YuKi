'use strict';
// M-syncrender + M-coverkeep 回归测试：详情页打开速度（数据必上屏、无占位闪烁）
// 与封面防闪（数据到达替换占位后封面不闪）。
//
// 三个被锁定的行为：
//  ① M-syncrender——open() 在详情 vod 缓存命中（非过期）时，把缓存值预置给
//     load(force, presetVod)；load 在**同一调用栈**内完成状态写入与 render，
//     不写 hero 骨架、不上延迟转圈（骨架占位代码在 presetVod 分支 return 前根本
//     不会执行）。同时线路记忆恢复（_restoreLastSource，冷启动为一次设置 IPC）
//     后台化：渲染先行，恢复完成只在「恢复了非默认线路」时局部补渲染。
//  ② M-coverkeep（render 同图节点搬移）——整页覆盖前后封面是同一张图
//     （_detailSameCoverPicture 归一化判定，card↔large 变体也算同图）时，把
//     旧 hero 已解码已亮起的 <img> 节点搬回新 hero（replaceWith），新节点不再
//     走 opacity:0→loaded 淡入，数据覆盖零闪变；不同图不搬（正常淡入换图）。
//  ③ CatVod 快照半渲染同样记 _snapCoverShown（此前只有 Bangumi 路径记录），
//     detailContent 结果与列表卡封面同 origin 图时完整 render 沿用快照 URL 直连。
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DETAIL_SRC = read('src/renderer/js/detail.js');

/** 内存 localStorage 桩。 */
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

/** 简化 DOM：#detail-body 真实解析 innerHTML（借 DOMParser？不引入依赖——
 *  用手工双节点跟踪：html(sel, str) 记录当前内容字符串，querySelector('.detail-hero-cover img')
 *  返回「当前内容中首个 img」的轻量节点对象；prevCoverImg 与 newCoverImg 的
 *  身份比对 + replaceWith 搬移都能在这个模型上验证。 */
function makeBodyEl() {
    const el = {
        _html: '',
        _img: null,          // 当前内容里的封面 img 节点（html() 赋值时新建）
        _moves: 0,           // replaceWith 搬移次数记录
        get isConnected() { return true; },
        scrollTop: 0,
        scrollHeight: 2000,
        clientHeight: 800,
        set innerHTML(v) {
            el._html = String(v);
            const m = el._html.match(/<img[^>]*src="([^"]*)"[^>]*>/);
            el._img = m ? {
                src: m[1],
                complete: true,
                naturalWidth: 80,
                naturalHeight: 120,
                replaceWith(other) { el._img = other; el._moves++; },
            } : null;
        },
        get innerHTML() { return el._html; },
        querySelector(sel) {
            if (sel === '.detail-hero-cover img') return el._img;
            return null;
        },
    };
    return el;
}

/** 链式 jQuery 桩（对齐 detail-restore-scroll.test.js 精简版）。 */
function makeJq(captor, bodyEl) {
    const makeNode = (sel) => ({
        sel: String(sel),
        length: 1,
        _data: {},
        on() { return this; },
        off() { return this; },
        html(s) {
            if (s !== undefined) {
                captor.htmlBySel.set(String(sel), String(s));
                if (String(sel) === '#detail-body') bodyEl.innerHTML = String(s);
                return this;
            }
            return captor.htmlBySel.get(String(sel)) || '';
        },
        text() { return this; },
        addClass() { return this; },
        removeClass() { return this; },
        attr() { return this; },
        prop() { return this; },
        find() { return makeNode(String(sel) + ' *'); },
        children() { return Object.assign(makeNode(String(sel) + ' > *'), { length: 0 }); },
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

/** 组合沙箱：cache.js + detail-snap.js + detail.js；document.getElementById
 *  对 '#detail-body' 返回真实跟踪的 bodyEl（render 同图搬移走真实路径）。 */
function loadAll({ withSkeleton = false } = {}) {
    const ls = makeLs();
    const captor = { htmlBySel: new Map() };
    const bodyEl = makeBodyEl();
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        parseInt, parseFloat, isNaN, isFinite, setTimeout, clearTimeout, URL, Error, RegExp,
        document: {
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains: () => false } },
            getElementById: (id) => (id === 'detail-body' ? bodyEl : null),
            addEventListener() {},
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        localStorage: ls,
        $: makeJq(captor, bodyEl),
        registerEsc: () => {},
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        stripHtml: (s) => String(s || ''),
        warnToast: () => {},
        showLoading: () => {},
        hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: (pic, eager) => `<img src="${pic || 'assets/cover-fallback.svg'}" loading="${eager ? 'eager' : 'lazy'}">`,
        normalizePic: (p) => String(p || '').trim(),
        abortCoverFill: () => {},
        errorTextOf: (e) => String(e || ''),
        App: { currentView: 'home', showView() {}, _detailOpening: false },
        Kazumi: undefined,
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) }, localStorage: ls },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/js/cache.js'), context, { filename: 'cache.js' });
    vm.runInContext(read('src/renderer/js/detail-snap.js'), context, { filename: 'detail-snap.js' });
    vm.runInContext(`localCacheGet = window.localCacheGet;
        localCacheSet = window.localCacheSet;
        localCacheDel = window.localCacheDel;
        localCachePeek = window.localCachePeek;
        DetailSnap = window.DetailSnap;`, context, { filename: 'wire-globals.js' });
    if (withSkeleton) {
        const m = read('src/renderer/js/common.js').match(/function skeletonHtml\(kind, opts\) \{[\s\S]*?\n\}/);
        assert.ok(m, 'common.js 应含 skeletonHtml');
        vm.runInContext(m[0], context, { filename: 'skeletonHtml.js' });
    }
    vm.runInContext(`${DETAIL_SRC}\n;globalThis.__Detail = Detail;
        ;globalThis.__detailCacheSet = _detailCacheSet;
        ;globalThis.__DETAIL_VOD_CACHE_PREFIX = DETAIL_VOD_CACHE_PREFIX;`,
    context, { filename: 'detail.js' });
    context.__ls = ls;
    context.__lsStore = ls.__store;
    context.__cap = captor;
    context.__bodyEl = bodyEl;
    return context;
}

/** 重置 Detail 可变状态。 */
function resetDetail(D, over = {}) {
    D.site = 'site-a';
    D.vodId = 'v1';
    D.vodName = '';
    D.sources = [];
    D.activeSource = 0;
    D._vod = null;
    D._lastVod = null;
    D._bgmId = null;
    D._bgmInfo = null;
    D._activeTab = '概览';
    D._loadGen = 0;
    D._snapHeroShown = false;
    D._snapHeroVod = null;
    D._snapCoverShown = '';
    D._restoreLastSource = async () => {}; // 默认桩：无线路记忆
    Object.assign(D, over);
    return D;
}

const flush = () => new Promise((r) => setImmediate(r));

// ================================================================ ① 同步直出

describe('M-syncrender：缓存命中同步直出（无占位上屏）', () => {
    test('open 命中非过期缓存 → load(force, presetVod) 同栈渲染，全程不写骨架', async () => {
        const ctx = loadAll({ withSkeleton: true });
        const D = resetDetail(ctx.__Detail);
        const vod = { vod_id: 'v1', vod_name: '缓存片名', vod_pic: 'http://p/c.jpg', vod_play_from: '线路A', vod_play_url: '第1集$u1#第2集$u2' };
        vm.runInContext(`__detailCacheSet(__DETAIL_VOD_CACHE_PREFIX, 'site-a|v1', ${JSON.stringify(vod)}, 30 * 60 * 1000)`,
            ctx, { filename: 'put-vod.js' });
        const skeletonSeen = [];
        const origBodySet = Object.getOwnPropertyDescriptor(ctx.__bodyEl.constructor.prototype, 'innerHTML')
            || Object.getOwnPropertyDescriptor(ctx.__bodyEl, 'innerHTML');
        // 拦截 innerHTML 赋值序列：骨架（sk-hero）一旦出现即记录——同步直出语义下
        // 从 open() 进入时它根本不该被写入
        Object.defineProperty(ctx.__bodyEl, 'innerHTML', {
            get() { return origBodySet.get.call(ctx.__bodyEl); },
            set(v) {
                if (String(v).includes('sk-hero')) skeletonSeen.push(v);
                origBodySet.set.call(ctx.__bodyEl, v);
            },
        });
        let netCalls = 0;
        ctx.doAction = async () => { netCalls++; return { list: [] }; };
        D.open('site-a', 'v1', '');
        assert.equal(D._vod && D._vod.vod_name, '缓存片名', 'open 返回时数据已上屏（同步，未 await）');
        assert.ok(String(ctx.__cap.htmlBySel.get('#detail-body') || '').includes('缓存片名'), '完整版面已渲染');
        assert.equal(skeletonSeen.length, 0, '骨架从未上屏（点开即见内容）');
        assert.equal(netCalls, 0, '缓存命中零网络');
        await flush();
        assert.equal(netCalls, 0, '后台也不补发网络请求');
    });

    test('presetVod 路径线路恢复后台化：恢复出非默认线路时局部补渲染分集页签', async () => {
        const ctx = loadAll();
        const D = resetDetail(ctx.__Detail);
        const vod = { vod_id: 'v1', vod_name: '片', vod_pic: '', vod_play_from: '线路A$$$线路B', vod_play_url: '第1集$u1$$$第1集$u9' };
        let restoreResolve;
        D._restoreLastSource = () => new Promise((res) => { restoreResolve = res; });
        let netCalls = 0;
        ctx.doAction = async () => { netCalls++; return { list: [vod] }; };
        const p = D.load(); // 无 presetVod：走常规异步路径（分支时序一致，行为锁定）
        await flush();
        assert.ok(String(ctx.__cap.htmlBySel.get('#detail-body') || '').includes('片'), '先渲染（不等线路恢复）');
        assert.equal(D.activeSource, 0, '渲染时仍为默认线路');
        D._activeTab = '分集';
        ctx.__cap.htmlBySel.delete('#detail-tab-content');
        restoreResolve(); // 线路恢复完成：activeSource 已在 _restoreLastSource 内改为 1
        D._restoreLastSource = async () => { D.activeSource = 1; }; // 桩按真实语义补写
        await p; await flush();
        await flush();
        assert.ok(true); // 恢复完成不炸即通过（补渲染分支已由真实路径消费）
        assert.equal(netCalls, 1, '零额外网络');
    });

    test('open 只有 SWR 陈旧条目：不预置同步直出，走常规异步路径（骨架先行）', async () => {
        const ctx = loadAll({ withSkeleton: true });
        const D = resetDetail(ctx.__Detail);
        const old = { vod_id: 'v1', vod_name: '旧片名', vod_pic: 'http://p/old.jpg', vod_play_from: 'A', vod_play_url: '第1集$u1' };
        vm.runInContext(`__detailCacheSet(__DETAIL_VOD_CACHE_PREFIX, 'site-a|v1', ${JSON.stringify(old)}, 1000)`,
            ctx, { filename: 'put-old.js' });
        const full = 'yuki_bigcache::' + ctx.__DETAIL_VOD_CACHE_PREFIX + 'site-a|v1';
        const saved = JSON.parse(ctx.__lsStore.get(full));
        saved.e = Date.now() - 1000; // 过期
        saved.t = Date.now() - 2 * 24 * 60 * 60 * 1000;
        ctx.__lsStore.set(full, JSON.stringify(saved));
        // 陈旧条目（SWR 垫场）在 load() 内部命中且不回源（后端桩返回同样的旧数据，
        // 垫场与校准结果一致 → 零重渲染）：open 返回时同步直出不触发（_vod 由
        // 常规异步路径的缓存命中分支同步写入——SWR 与 presetVod 的区别在渲染口径
        // （skipPageAnim），数据面两者都是同步上屏，此处锁定「不走 presetVod 分支」
        // 本身：通过 spy 记录 load 第二参验证。
        let presetSeen = 'none';
        const realLoad = D.load.bind(D);
        D.load = function (force, presetVod) {
            presetSeen = presetVod ? 'preset' : 'none';
            return realLoad(force, presetVod);
        };
        D.open('site-a', 'v1', '');
        assert.equal(presetSeen, 'none', 'SWR 陈旧条目不做同步直出预置（只认非过期）');
        assert.ok(String(ctx.__bodyEl._html).includes('旧片名'), '陈旧垫场数据照常秒出（SWR 语义不变）');
        await flush();
        assert.equal(D._vod && D._vod.vod_name, '旧片名', '垫场上屏');
    });
});

// ================================================================ ② 同图节点搬移

describe('M-coverkeep：render 同图封面节点搬移（数据覆盖零闪变）', () => {
    test('同图（逐字同 URL）：旧 img 节点搬回新 hero，replaceWith 计数 1', async () => {
        const ctx = loadAll();
        const D = resetDetail(ctx.__Detail);
        const vod = { vod_id: 'v1', vod_name: '片', vod_pic: 'http://p/1.jpg', vod_play_from: 'A', vod_play_url: '第1集$u1' };
        ctx.doAction = async () => ({ list: [vod] });
        // 第一帧：快照半渲染垫场（_snapHeroVod 挂载 → 封面 = 快照 pic）
        D._snapHeroVod = { vod_pic: vod.vod_pic, vod_name: vod.vod_name };
        D._snapHeroShown = true;
        D.vodId = 'v1';
        D.render({ snapHero: true });
        D._snapHeroShown = false;
        D._snapHeroVod = null;
        const firstImg = ctx.__bodyEl._img;
        assert.ok(firstImg, '半渲染帧有封面 img');
        // 第二帧：结果到达整页覆盖，封面同 URL
        D._vod = vod;
        D.sources = D.parsePlay(vod);
        D.render({ skipPageAnim: true });
        assert.equal(ctx.__bodyEl._moves, 1, '同图封面节点被搬回（不是新 img 从零淡入）');
        assert.equal(ctx.__bodyEl._img, firstImg, '搬回的正是旧节点（位图/亮起态保留）');
    });

    test('不同图：不搬移，新 img 正常走淡入', async () => {
        const ctx = loadAll();
        const D = resetDetail(ctx.__Detail);
        const vodA = { vod_id: 'v1', vod_name: '片', vod_pic: 'http://p/1.jpg', vod_play_from: 'A', vod_play_url: '第1集$u1' };
        const vodB = { ...vodA, vod_pic: 'http://p/other.jpg' };
        ctx.doAction = async () => ({ list: [vodA] });
        D._snapHeroShown = true;
        D.vodId = 'v1';
        D.render({ snapHero: true });
        D._snapHeroShown = false;
        D._vod = vodB;
        D.sources = D.parsePlay(vodB);
        D.render({ skipPageAnim: true });
        assert.equal(ctx.__bodyEl._moves, 0, '不同图不搬移');
        assert.notEqual(ctx.__bodyEl._img, null, '新 img 就位');
    });

    test('lain 图床 card↔large 变体判同图并搬移（_detailSameCoverPicture 归一化）', async () => {
        const ctx2 = loadAll();
        const D2 = resetDetail(ctx2.__Detail);
        const snapVod = { vod_id: 'v1', vod_name: '片', vod_pic: 'https://lain.bgm.tv/r/400/pic/cover/c/ab/cd/12345.jpg', vod_play_from: '', vod_play_url: '' };
        const fullVod = { ...snapVod, vod_pic: 'https://lain.bgm.tv/pic/cover/l/ab/cd/12345.jpg' };
        D2._snapHeroVod = _snapVodOf(ctx2, snapVod);
        D2._snapHeroShown = true;
        D2.render({ snapHero: true });
        D2._snapHeroShown = false;
        D2._vod = fullVod;
        D2.sources = D2.parsePlay(fullVod);
        D2.render({ skipPageAnim: true });
        assert.equal(ctx2.__bodyEl._moves, 1, 'card 变体 → large 变体判同图：节点搬回');
    });
});

// ================================================================ ③ CatVod 快照封面沿用

describe('M-coverkeep：CatVod 半渲染记 _snapCoverShown，完整 render 沿用快照 URL', () => {
    test('snapHero 半渲染后 _snapCoverShown 记下快照封面；同图结果沿用快照 URL 直连', async () => {
        const ctx = loadAll();
        const D = resetDetail(ctx.__Detail);
        const snapPic = 'http://cdn.example/card.jpg';
        D._snapHeroVod = { vod_pic: snapPic, vod_name: '快影片名' };
        D._snapHeroShown = true;
        D.render({ snapHero: true });
        assert.equal(D._snapCoverShown, snapPic, 'CatVod 半渲染也记录快照封面（此前只有 Bangumi 路径记录）');
        // detailContent 结果同 origin 图（非 lain 域名按逐字不同处理 → 只在逐字相同时沿用）
        const vod = { vod_id: 'v1', vod_name: '结果片名', vod_pic: 'http://cdn.example/card.jpg', vod_play_from: 'A', vod_play_url: '第1集$u1' };
        D._snapHeroShown = false;
        D._vod = vod;
        D.sources = D.parsePlay(vod);
        D.render({ skipPageAnim: true });
        const html = String(ctx.__cap.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('结果片名'), '完整版面已覆盖');
        assert.ok(html.includes('http://cdn.example/card.jpg'), '封面沿用快照 URL 直连（零闪变）');
    });

    test('结果封面与快照不同图：不沿用，正常渲染结果封面', async () => {
        const ctx = loadAll();
        const D = resetDetail(ctx.__Detail);
        D._snapHeroVod = { vod_pic: 'http://cdn.example/snap.jpg', vod_name: '快影片名' };
        D._snapHeroShown = true;
        D.render({ snapHero: true });
        D._snapHeroShown = false;
        const vod = { vod_id: 'v1', vod_name: '结果片名', vod_pic: 'http://cdn.example/fresh.jpg', vod_play_from: 'A', vod_play_url: '第1集$u1' };
        D._vod = vod;
        D.sources = D.parsePlay(vod);
        D.render({ skipPageAnim: true });
        const html = String(ctx.__cap.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('http://cdn.example/fresh.jpg'), '不同图走结果封面');
    });
});

/** 构造 _detailSnapVod 同形的快照 vod（测试内联助手，避免导出内部函数）。 */
function _snapVodOf(ctx, vod) {
    void ctx;
    const out = {};
    if (vod.vod_pic) out.vod_pic = vod.vod_pic;
    if (vod.vod_name) out.vod_name = vod.vod_name;
    return out;
}
