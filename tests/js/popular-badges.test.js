'use strict';
/**
 * popular.js 封面悬停徽章（话数徽章 + 收藏状态徽标）单元测试。
 *
 * 交互对齐时间表页（timeline.js 同款管线）：话数徽章常驻，收藏徽标默认隐藏、悬停显形，动画/样式
 * 由 ui.css 的 .vod-fav-row/.vod-fav-badge 提供（纯 CSS，不在本测试范围）。
 * 本文件只测 JS 行为：_renderGrid 后徽章挂载、收藏映射重建、FavHub 刷新联动、
 * Timeline 缺席降级；_attachEpBadges 的 itemsFull 快捷分支在 timeline.test.js 补。
 *
 * 加载方式：fs.readFileSync + node:vm，注入最小全局桩（与 popular-cache.test.js
 * 同款写法）；Timeline 用真实 timeline.js 源码 + miniGrid 桩（借 timeline.test.js
 * 的桩思路）注入，让 Popular 走真实复用路径。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const POPULAR_SRC = path.join(__dirname, '../../src/renderer/js/popular.js');
const TIMELINE_SRC = path.join(__dirname, '../../src/renderer/js/timeline.js');

/** 迷你 DOM 桩：模拟 jQuery 对象上 popular.js 用到的链（empty/html/find/…）。
 *  cards 记录每张 .bangumi-card 封面节点的挂载痕迹，供徽章断言。 */
function makeGrid(cards) {
    const cardNode = (id) => {
        if (!cards[id]) {
            const rows = []; const rowPrepends = [];
            cards[id] = {
                length: 1, // 真实 jQuery 对象必有 length；timeline 侧 $card.length 判空依赖
                rows, rowPrepends,
                get html() { return [...rows, ...rowPrepends].join(''); },
                append(inner) { rows.push(inner); return cards[id]; },
                find(sel) {
                    if (sel === '.vod-fav-row') {
                        return rows.some((r) => String(r).includes('vod-fav-row'))
                            ? { length: 1, prepend(b) { rowPrepends.push(b); } }
                            : { length: 0, remove() {} };
                    }
                    if (sel === '.timeline-ep-badge') {
                        return rows.concat(rowPrepends).some((r) => String(r).includes('timeline-ep-badge'))
                            ? { length: 1, 0: { outerHTML: '<span class="detail-progress-badge timeline-ep-badge">x/x</span>' }, remove() {} }
                            : { length: 0, remove() {} };
                    }
                    return { length: 0, remove() {} };
                },
                remove() { return cards[id]; },
            };
        }
        return cards[id];
    };
    const api = {
        _ids: Object.keys(cards),
        _cards: cards,
        empty() { for (const k of Object.keys(cards)) delete cards[k]; return api; },
        html() { return api; },
        find(sel) {
            const m = sel.match(/\.bangumi-card\[data-id="(.+?)"\] \.vod-cover/);
            if (m) return cardNode(m[1]);
            if (sel === '.bangumi-card') {
                return { length: api._ids.length };
            }
            return { length: 0, on() {}, remove() {} };
        },
        on() { return api; },
        text() { return api; },
        show() { return api; },
        hide() { return api; },
    };
    return api;
}

/** 在 VM 沙箱加载 popular.js（可注入真实 timeline.js），返回 { Popular, ctx }。 */
function loadPopular({ timelineItems = null } = {}) {
    const lsStore = new Map();
    const ls = {
        getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
        setItem: (k, v) => lsStore.set(k, String(v)),
        removeItem: (k) => lsStore.delete(k),
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Number, Array, Object,
        parseInt, parseFloat, setTimeout, clearTimeout, setImmediate,
        localStorage: ls,
        $: () => ({ on() { return this; }, empty() { return this; }, html() {}, text() { return this; }, show() { return this; }, hide() { return this; }, find() { return { on() {} }; } }),
        doAction: async () => ({ trends: [], total: 0 }),
        // A-31：本沙箱不装载 common.js，注入 guardedLoad 真实语义的最小桩
        // （纯世代型：++_loadToken + isLive 比对；本页无 abort 需求）
        guardedLoad: (host) => {
            const token = ++host._loadToken;
            return { token, isLive: () => token === host._loadToken, signal: undefined };
        },
        warnToast: () => {}, showLoading: () => {}, hideLoading: () => {},
        renderPagerBox: () => {},
        bangumiCard: (item) => `<div class="bangumi-card" data-id="${item.id}"></div>`,
        bangumiNetGuide: () => '<div class="tip-line">bangumi-guide</div>',
        escHtml: (s) => String(s),
        Kazumi: {},
        fitVodTitles: () => {},
        playCardsEnter: () => {},
    };
    context.globalThis = context;
    vm.createContext(context);
    if (timelineItems) {
        // 真实 timeline.js + miniGrid 桩注入（_attachFavBadges/_attachEpBadges 走真实实现）
        context.$ = () => ({ on() { return this; } }); // timeline init 相关桩（本测试只调两个 _attach 方法，不触 init/DOM）
        context.Timeline = null;
        vm.runInContext(`${fs.readFileSync(TIMELINE_SRC, 'utf8')}\nglobalThis.Timeline = Timeline;`, context, { filename: 'timeline.js' });
        // _attachFavBadges/_attachEpBadges 的 grid 入参用 miniGrid；timeline 内部只调
        // grid.find(...) 与 $card.append/prepend——miniGrid 完整覆盖。
        context.__miniCards = timelineItems.cards;
        context.Timeline._attachFavBadges = TimelineBind(context);
    }
    vm.runInContext(`${fs.readFileSync(POPULAR_SRC, 'utf8')}\nglobalThis.__Popular = Popular;`, context, { filename: 'popular.js' });
    context.__ls = ls;
    context.__lsStore = lsStore;
    return context;
}

/** 把 Timeline 的两个 _attach 方法包装为接受 miniGrid 的版本（真实实现直调）。 */
function TimelineBind(context) {
    return context.Timeline._attachFavBadges;
}

function resetPop(ctx) {
    const P = ctx.__Popular;
    P._inited = false;
    P._items = [];
    P._total = 0;
    P._page = 1;
    P._tag = '';
    P._badgesOn = false;
    P._colStateMap = new Map();
    return P;
}

// ---------------------------------------------------------------- 挂载与降级

test('_attachBadges：Timeline 缺席时静默降级，不抛错不置 _badgesOn', async () => {
    const ctx = loadPopular(); // 未注入 timeline.js
    const P = resetPop(ctx);
    P._items = [{ id: 1 }];
    P._attachBadges(makeGrid({}));
    assert.equal(P._badgesOn, false, '降级路径不置开关');
});

test('_attachBadges：置 _badgesOn 并异步重建收藏映射（复用 Timeline.getColStateMap 共享缓存）', async () => {
    const ctx = loadPopular();
    const P = resetPop(ctx);
    P._items = [{ id: 555 }, { id: 777 }, { id: 999 }];
    // 沙箱无真实 Timeline：手工替换为直调桩，验证 Popular 侧参数/顺序。
    // popular._ensureColState 已改为复用共享映射（时间表三级缓存），本测试只验证
    // 「取映射 → 存 _colStateMap → 补挂网格」的联动，不再验证网络拉取本身。
    const grid = makeGrid({});
    const seen = [];
    const sharedMap = new Map([['555', 2], ['777', 1]]);
    let mapCalls = 0;
    ctx.Timeline = {
        getColStateMap: async () => { mapCalls++; return sharedMap; },
        _attachFavBadges: (g, items, map) => { seen.push({ kind: 'fav', items, map: new Map(map || []) }); },
        _attachEpBadges: async (g, items, full) => { seen.push({ kind: 'ep', items, full }); },
    };
    P._attachBadges(grid);
    assert.equal(P._badgesOn, true, '置开关（后续 load 自动补挂）');
    await new Promise((r) => setImmediate(r)); // 冲刷 _ensureColState
    await new Promise((r) => setImmediate(r));
    assert.equal(mapCalls, 1, '经共享入口取映射');
    assert.equal(P._colStateMap.get('555'), 2, '映射透传给 _colStateMap');
    const favCalls = seen.filter((s) => s.kind === 'fav');
    assert.ok(favCalls.length >= 2, '映射到手后补挂徽标行');
    const last = favCalls[favCalls.length - 1];
    assert.equal(last.map.get('555'), 2, '补挂带最新映射');
});

test('_ensureColState：透传共享映射并补挂；Timeline 缺席时回空映射不抛错', async () => {
    const ctx = loadPopular();
    const P = resetPop(ctx);
    ctx.Timeline = { getColStateMap: async () => new Map([['10', 3]]), _attachFavBadges: () => {} };
    await P._ensureColState();
    assert.deepEqual([...P._colStateMap.entries()], [['10', 3]]);

    // 无 Timeline（共享入口缺席）：回空 Map，不抛错
    const ctx2 = loadPopular();
    const P2 = resetPop(ctx2);
    await P2._ensureColState();
    assert.ok(P2._colStateMap instanceof Map);
    assert.equal(P2._colStateMap.size, 0);
});

test('_attachBadges：与真实 timeline.js 联调——映射含收藏条目时挂 .vod-fav-row 徽标行', async () => {
    // 真实 Timeline + miniGrid：Popular 传自己的映射，不依赖时间表内部状态
    const cards = {};
    const ctx = loadPopular({ timelineItems: { cards } });
    const P = resetPop(ctx);
    P._items = [{ id: 200 }, { id: 300 }];
    P._colStateMap = new Map([['200', 3], ['300', 5]]);
    // 用真实 Timeline 方法直调（绕过 $ 选择器差异：miniGrid find 兼容两页同款选择器）
    P._attachBadges(makeGrid(cards));
    assert.match(cards[200] && cards[200].html || '', /vod-fav-row/);
    assert.match(cards[200].html, /vod-fav-watching/);
    assert.match(cards[200].html, /在看/);
    assert.match(cards[300].html, /vod-fav-dropped/);
});

test('refreshBadges：_badgesOn 未置位时零开销；置位后经共享入口重读映射', async () => {
    const ctx = loadPopular();
    const P = resetPop(ctx);
    let calls = 0;
    ctx.Timeline = {
        getColStateMap: async () => { calls++; return new Map([['1', 2]]); },
        _attachFavBadges: () => {},
    };
    await P.refreshBadges();
    assert.equal(calls, 0, '未开启徽章不拉数据');
    P._badgesOn = true;
    await P.refreshBadges();
    assert.equal(calls, 1);
    assert.deepEqual([...P._colStateMap.entries()], [['1', 2]]);
});

test('load 后网格重渲染会再次挂徽章（_renderGrid → _attachBadges 联动）', async () => {
    const ctx = loadPopular();
    const P = resetPop(ctx);
    const marks = [];
    ctx.Timeline = {
        _attachFavBadges: () => { marks.push('fav'); },
        _attachEpBadges: async () => { marks.push('ep'); },
    };
    ctx.doAction = async (action) => (action === 'kazumiBangumiTrends'
        ? { trends: [{ id: 1 }, { id: 2 }], total: 2 }
        : { items: [], total: 0 });
    await P.load(1);
    // 时序：渲染时同步挂 fav 行 + 异步挂 ep 徽章（['fav','ep']），随后首次
    // _ensureColState 异步完成后按设计再补挂一次 fav（['fav','ep','fav']）——
    // 首屏渲染先于收藏映射就绪的场景靠这次补挂，属预期行为。
    assert.equal(marks[0], 'fav', '渲染网格后同步挂收藏行');
    assert.equal(marks[1], 'ep', '随即异步挂话数徽章');
    assert.equal(marks[2], 'fav', '收藏映射就绪后补挂（首屏先于映射场景）');
});
