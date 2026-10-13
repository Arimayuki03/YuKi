'use strict';
/**
 * records.js 收藏/历史「排序 + 筛选 + 卡片动作」白盒单测。
 *
 * 覆盖四块：
 *  ① 纯函数层：排序比较器（缺字段排最后/中文名/播放卡与浏览卡的时间口径）、
 *     日期与数值区间归一化（含端点、非法区间自动纠正、跨月/跨年）、
 *     收藏筛选谓词（标签 AND / 季度半开 / 评分 / 排名 / 星期 / 未知归类）、
 *     历史筛选谓词（单日 + 区间 / 来源 / 评分档位）；
 *  ② Bangumi 元数据回填：取值优先级（记录自带 → 片名匹配缓存 → 批量回填缓存）、
 *     批量 ≤60、缓存命中零网络、失败短 TTL；
 *  ③ 视图管线（vm 沙箱 + settings 桩驱动真实 render）：排序/筛选状态持久化与归一化、
 *     网格内容顺序、空态文案；
 *  ④ 任务修复点：多选批量标记的广播（纯 Bangumi 路径必发一次、本地路径不重复发）、
 *     续播定位（lastSourceMap + 集名/watchProgress、Kazumi 集名对不上回退选源）。
 *
 * 手法与 records.test.js 同款：fs.readFileSync + node:vm；common.js 真实现注入
 * （escHtml/fmtCommentTimeFull/truncateTitle）避免 mock 漂移。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 跨 VM 原型域断言（vm 里创建的数组/对象原型与宿主不同，assert/strict 的 deepEqual
 *  会比原型而失败）。本文件比较的都是纯数据，按 JSON 串比较即可；其余一律 assert.equal。 */
function eq(actual, expected, msg) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);
}

/** 本地时区的固定时刻 → 便于断言「当天」（跨时区不会翻日：取当日 12:00）。 */
function localTs(y, m, d, hh = 12) {
    return new Date(y, m - 1, d, hh, 0, 0).getTime();
}

/**
 * 在 VM 中加载 records.js。
 * @param settings settings 桩（settingsGet/settingsSet 读写同一对象）
 * @param opts.onGridHtml(html)            #grid 的 html 写入观测
 * @param opts.checked [{uid,bgm,id}]      勾选中的 .rec-check 桩（tagChecked/removeChecked 驱动）
 * @param opts.values  {sel: value}        控件当前值（.val() 读回；写回也记录在此）
 * @param opts.props   {sel: value}        .prop() 读回（如面板「含未知」勾选）
 * @param opts.kazumi  Kazumi 桩（bundle 覆盖）；opts.player / opts.doAction / opts.timeline 同理
 * @param opts.settingsExtra 额外初始 settings（与 settings 合并，便于一次写全）
 */
function loadRecords(settings, opts = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/records.js'), 'utf8');
    const values = Object.assign({}, opts.values || {});
    const props = Object.assign({}, opts.props || {});
    const handlers = [];   // { sel, event, fn }（.on 捕获，测试可手动触发）
    const toasts = [];
    const gridWrites = [];

/** 收藏菜单单例的 DOM 桩（菜单元素由 favMenuEl() 懒建）：只需 jQuery 链式方法的桩。 */
    function makeFakeEl() {
        const el = { style: {}, offsetWidth: 156, offsetHeight: 200 };
        ['css', 'off', 'on', 'attr', 'append', 'setAttribute', 'removeAttribute'].forEach((m) => { el[m] = () => el; });
        el.html = (v) => { if (v !== undefined) values['#rec-fav-menu|html'] = String(v); return el; };
        return el;
    }

    const makeJqProxy = () => {
        const jq = new Proxy(function () { return jq; }, {
            get(_t, prop) {
                if (prop === 'length') return 0;
                if (prop === 'data' || prop === 'attr' || prop === 'prop' || prop === 'text') return () => '';
                if (prop === 'hasClass') return () => false;
                if (prop === 'each') return () => jq;
                if (prop === 'html') return (...args) => { if (args.length && opts.onGridHtml) opts.onGridHtml(String(args[0])); return jq; };
                return () => jq;
            },
        });
        return jq;
    };

    /** 集合项桩：.rec-check 的 $(this)。 */
    function checkEl(o) {
        return {
            checked: !!o.checked,
            _d: { bgm: o.bgm ? '1' : '', uid: o.uid || '', id: o.id || '', site: o.site || '' },
            data(k) { return this._d[k] === undefined ? '' : this._d[k]; },
            closest() { return this; },
            toggleClass() { return this; },
            removeClass() { return this; },
            hasClass() { return false; },
        };
    }
    const checks = (opts.checked || []).map(checkEl);

    function collection(items, sel) {
        const o = {
            length: items.length,
            each(fn) { items.forEach((it, i) => fn.call(it, i, it)); return o; },
            toggleClass() { return o; },
            removeClass() { return o; },
            addClass() { return o; },
            on() { return o; }, off() { return o; },
            empty() { return o; }, text() { return o; }, prop() { return o; },
            html(s) { if (s !== undefined) { gridWrites.push(String(s)); if (opts.onGridHtml) opts.onGridHtml(String(s)); } return o; },
            find() { return o; }, closest() { return o; }, data() { return ''; },
            val() { return ''; }, toggle() { return o; }, attr() { return o; },
            before() { return o; }, append() { return o; }, scrollTop() { return o; }, css() { return o; },
        };
        void sel;
        return o;
    }

    function selObj(sel) {
        const s = String(sel);
        const o = {
            length: 0,
            on(...args) { handlers.push({ sel: s, event: args[0], fn: args[args.length - 1] }); return o; },
            off() { return o; },
            html(v) { if (v !== undefined) { values[s + '|html'] = String(v); } return o; },
            text(v) { if (v !== undefined) values[s + '|text'] = String(v); return o; },
            empty() { return o; },
            prop(k, v) { if (v !== undefined) { props[s + '|' + k] = v; return o; } return props[s + '|' + k]; },
            val(v) { if (v === undefined) return values[s] === undefined ? '' : values[s]; values[s] = v; return o; },
            attr() { return o; },
            toggle() { return o; },
            toggleClass() { return o; },
            addClass() { return o; },
            removeClass() { return o; },
            removeAttr() { return o; },
            is() { return false; },
            data() { return ''; },
            hasClass() { return false; },
            closest() { return o; },
            find() { return o; },
            each() { return o; },
            map() { return o; },
            get() { return []; },
            append() { return o; },
            before() { return o; },
            scrollTop() { return o; },
            css() { return o; },
        };
        return o;
    }

    const $ = (sel) => {
        if (sel && typeof sel === 'object') return sel;                      // $(this) → 元素桩自身
        const s = String(sel === undefined || sel === null ? '' : sel);
        if (/\.rec-check\.checked$/.test(s)) return collection(checks.filter((c) => c.checked), s);
        if (/\.rec-check$/.test(s)) return collection(checks, s);
        if (/grid$/.test(s) && !/ ./.test(s)) return collection([], s);      // #xxx-grid（元素为空，each 空转）
        return selObj(s);
    };

    // L54（反 mock 漂移）同 records.test.js：先在独立 VM 装载真实 common.js，
    // 把 YUKI.common 的真实现注入 records 沙箱（转义/时间格式化随生产演进）。
    const commonCtx = { console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout, URL, URLSearchParams, Error, RegExp,
        Symbol, WeakMap, WeakSet, Function,
        document: { addEventListener() {}, documentElement: { classList: { contains: () => false, toggle() {} } } },
        $: () => makeJqProxy(),
        AbortController,
    };
    commonCtx.window = commonCtx;
    commonCtx.globalThis = commonCtx;
    vm.createContext(commonCtx);
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../../src/renderer/js/common.js'), 'utf8'),
        commonCtx, { filename: 'common.js' }
    );
    const realCommon = commonCtx.YUKI.common;

    const kazumi = opts.kazumi || null;
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout, Error, RegExp, Symbol, WeakMap, WeakSet,
        $,
        // 文档级单例（收藏菜单）只在点击路径用到；测试不点真实 DOM，给最小 document 桩
        document: { getElementById: () => null, createElement: () => makeFakeEl(), body: { appendChild() {} }, on() {}, off() {} },
        window: {
            innerWidth: 1024,
            innerHeight: 768,
            on() {}, off() {},
            yuki: {
                settingsGet: async () => JSON.parse(JSON.stringify(settings)),
                settingsSet: async (k, v) => { settings[k] = JSON.parse(JSON.stringify(v)); },
            },
        },
        escHtml: realCommon.escHtml,
        fmtCommentTimeFull: realCommon.fmtCommentTimeFull,
        truncateTitle: commonCtx.truncateTitle,
        normalizePic: commonCtx.normalizePic,
        vodCoverImg: (pic) => `<img src="${pic || ''}">`,
        bangumiCoverImg: (pic) => `<img src="${pic || ''}">`,
        isBangumiCoverUrl: () => false,
        warnToast: (m) => { toasts.push(String(m)); },
        showLoading: () => {}, hideLoading: () => {}, localPlayToast: () => {},
        Detail: {},
        renderPagerBox: () => {},
        pageSizeOf: opts.pageSizeOf || (async () => 20),
        confirmDialog: async () => true,
        openDialog: () => {}, closeDialog: () => {},
        fillMissingCovers: () => {},
        fitVodTitles: () => {},
        playCardsEnter: () => {},
        prefetchDetail: () => {},
        loadBlockWords: async () => {}, filterBlocked: (l) => l,
    };
    if (kazumi) context.Kazumi = kazumi;
    if (opts.player) context.Player = opts.player;
    if (opts.doAction) context.doAction = opts.doAction;
    if (opts.timeline) context.Timeline = opts.timeline;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}
;globalThis.__Records = Records;
globalThis.__FavHub = FavHub;
globalThis.__makeRecordView = makeRecordView;
globalThis.__recCard = recCard;
globalThis.__TOOLS = {
    recRecentTs, recTsNum, recDisplayName, recNameCompare, recNumCompare, recDateCompareDesc,
    normFavSort, normHistorySort, recFavCompare, recHistoryCompare, applyRecSort, recHistoryTs,
    recValidDate, recTsToDate, normDateRange, recDateInRange, normNumRange, recNumInRange,
    parseRecTagQuery, recSeasonRange, normFavFilter, favFilterActive, matchFavFilter,
    scoreInTier, normHistoryFilter, historyFilterActive, matchHistoryFilter, collectHistorySites,
    recBgmId, recMetaOf, recMetaIdsOf, recPrefetchBgmMeta, recScore, recRank, recAirDate, recWeekday,
    favMenuItems, buildFavMenuHtml, recToolbarHtml, parseRecSources, locateRecEpisode,
    openRecFavMenu, applyRecFavMenu, closeRecFavMenu,
    playDirectRecord, resumePlayRecord, playDirectFailToast: directPlayFailToast,
};`,
        context, { filename: 'records.js' });
    context.__TOOLS.toasts = toasts;
    context.__TOOLS.values = values;
    context.__TOOLS.props = props;
    context.__TOOLS.gridWrites = gridWrites;
    context.__TOOLS.fire = (sel, event, ev) => {
        // 真实 jQuery 的多选择器绑定（如 '#a, #b' 共用一个处理器）在这里按「逗号切分」匹配
        const h = handlers.filter((x) => x.event === event
            && x.sel.split(',').map((t) => t.trim()).indexOf(sel) >= 0);
        assert.ok(h.length, `未绑定 ${sel} 的 ${event} 处理器`);
        return h[h.length - 1].fn(ev);
    };
    return context;
}

/** 只取纯函数层（大多数用例只关心它）。 */
const tools = (settings = {}, opts = {}) => loadRecords(settings, opts).__TOOLS;

// ---------------------------------------------------------------- 排序比较器

test('recRecentTs：取值优先级 ts → updated_at/updatedAt → lastPlayTs，全缺为 0', () => {
    const t = tools();
    assert.equal(t.recRecentTs({ ts: 500, updated_at: 900, lastPlayTs: 100 }), 500, '本记录 ts 优先');
    assert.equal(t.recRecentTs({ updated_at: 900, lastPlayTs: 100 }), 900, '无 ts 用远端 updated_at');
    assert.equal(t.recRecentTs({ updatedAt: 800, lastPlayTs: 100 }), 800, '驼峰 updatedAt 同样认');
    assert.equal(t.recRecentTs({ lastPlayTs: 100 }), 100, '再回退 lastPlayTs');
    assert.equal(t.recRecentTs({}), 0);
    assert.equal(t.recRecentTs({ ts: 'x', updated_at: -5 }), 0, '非数值/负数一律 0');
});

test('recNameCompare：中文优先名（name_cn）本地化排序，缺名排最后', () => {
    const t = tools();
    assert.equal(t.recDisplayName({ name_cn: '中文名', name: '原名' }), '中文名');
    assert.equal(t.recDisplayName({ name: '原名' }), '原名');
    const arr = [{ name: '乙' }, { name: '' }, { name: '甲' }, {}];
    arr.sort((a, b) => t.recNameCompare(a, b));
    eq(arr.map((x) => x.name), ['甲', '乙', '', undefined], '有值在前（中文序），缺名殿后');
    assert.equal(t.recNameCompare({ name: '同名' }, { name: '同名' }), 0);
});

test('recNumCompare：null/非数值一律排最后（升序与降序都如此）', () => {
    const t = tools();
    const up = [{ v: 3 }, { v: null }, { v: 1 }, {}];
    up.sort((a, b) => t.recNumCompare(a.v, b.v, false));
    eq(up.map((x) => x.v), [1, 3, null, undefined]);
    const down = [{ v: 3 }, { v: null }, { v: 1 }, {}];
    down.sort((a, b) => t.recNumCompare(a.v, b.v, true));
    eq(down.map((x) => x.v), [3, 1, null, undefined]);
});

test('recFavCompare：评分降序/排名升序/开播新→旧/最近变更降序，缺字段一律最后', () => {
    const t = tools();
    const meta = (v) => v.meta || null;
    const byScore = [
        { name: 'a', meta: { score: 6 } }, { name: 'b', meta: { score: 9.2 } },
        { name: 'c', meta: { score: 0 } }, { name: 'd', meta: { score: 7.5 } },
    ].sort((x, y) => t.recFavCompare(x, y, 'score', meta));
    eq(byScore.map((x) => x.name), ['b', 'd', 'a', 'c'], '9.2 → 7.5 → 6 → 未知殿后');
    // 记录自带 bgmScore 优先于元数据
    const own = [{ name: 'x', bgmScore: 8, meta: { score: 3 } }, { name: 'y', meta: { score: 5 } }]
        .sort((a, b2) => t.recFavCompare(a, b2, 'score', meta));
    eq(own.map((x) => x.name), ['x', 'y']);
    const byRank = [{ name: 'a', meta: { rank: 500 } }, { name: 'b', meta: { rank: 12 } }, { name: 'c' }]
        .sort((x, y) => t.recFavCompare(x, y, 'rank', meta));
    eq(byRank.map((x) => x.name), ['b', 'a', 'c'], '#12 在 #500 之前，无排名殿后');
    const byAir = [{ name: 'a', meta: { date: '2024-04-01' } }, { name: 'b', meta: { date: '2026-01-01' } }, { name: 'c', meta: {} }]
        .sort((x, y) => t.recFavCompare(x, y, 'airdate', meta));
    eq(byAir.map((x) => x.name), ['b', 'a', 'c'], '新 → 旧，无日期殿后');
    const byRecent = [{ name: 'a', ts: 100 }, { name: 'b', updated_at: 900 }, { name: 'c' }]
        .sort((x, y) => t.recFavCompare(x, y, 'recent', meta));
    eq(byRecent.map((x) => x.name), ['b', 'a', 'c'], '最近变更降序，无时间殿后');
    assert.equal(t.normFavSort('bogus'), 'recent', '脏排序键钳回默认');
    assert.equal(t.normFavSort('name'), 'name');
});

test('recHistoryCompare：时间正/倒序按卡片日期口径（播放卡 lastPlayTs、浏览卡 ts）；未评分两个方向都最后', () => {
    const t = tools();
    assert.equal(t.recHistoryTs({ kind: 'play', ts: 100, lastPlayTs: 200 }), 200, '播放卡用 lastPlayTs');
    assert.equal(t.recHistoryTs({ kind: 'view', ts: 100, lastPlayTs: 200 }), 100, '浏览卡用 ts');
    assert.equal(t.recHistoryTs({ kind: 'play', ts: 100 }), 100, '播放卡无 lastPlayTs 回退 ts');
    const list = [{ name: 'a', kind: 'play', lastPlayTs: 100 }, { name: 'b', kind: 'view', ts: 300 }, { name: 'c', kind: 'play', lastPlayTs: 200 }];
    const desc = t.applyRecSort(list, 'time-desc', null, 'history');
    eq(desc.map((x) => x.name), ['b', 'c', 'a']);
    const asc = t.applyRecSort(list, 'time-asc', null, 'history');
    eq(asc.map((x) => x.name), ['a', 'c', 'b']);
    const meta = (v) => v.meta || null;
    const scored = [{ name: 'a', meta: { score: 9 }, playCount: 1 }, { name: 'b' }, { name: 'c', meta: { score: 7 }, playCount: 1 }];
    const hi = t.applyRecSort(scored, 'score-desc', meta, 'history');
    eq(hi.map((x) => x.name), ['a', 'c', 'b'], '高分在前，未评分殿后');
    const lo = t.applyRecSort(scored, 'score-asc', meta, 'history');
    eq(lo.map((x) => x.name), ['c', 'a', 'b'], '低分在前，未评分同样殿后');
    const cnt = t.applyRecSort([{ name: 'a', playCount: 3 }, { name: 'b' }, { name: 'c', playCount: 9 }], 'count-desc', null, 'history');
    eq(cnt.map((x) => x.name), ['c', 'a', 'b']);
    assert.equal(t.normHistorySort('whatever'), 'time-desc', '脏排序键钳回时间倒序（现状）');
});

test('applyRecSort：不修改入参、等值保持原相对顺序（稳定排序）', () => {
    const t = tools();
    const src = [{ name: 'b', ts: 5 }, { name: 'a', ts: 5 }, { name: 'c', ts: 9 }];
    const out = t.applyRecSort(src, 'recent', null, 'favorites');
    eq(src.map((x) => x.name), ['b', 'a', 'c'], '入参顺序不变');
    eq(out.map((x) => x.name), ['c', 'b', 'a'], '同 ts 保持原顺序（b 在 a 前）');
});

// ---------------------------------------------------------------- 日期 / 数值区间

test('recValidDate：只认真实存在的 YYYY-MM-DD（拦 2 月 30 日、13 月、乱串）', () => {
    const t = tools();
    assert.equal(t.recValidDate('2026-02-28'), '2026-02-28');
    assert.equal(t.recValidDate(' 2026-1-5 '), '', '必须两位月日（输入框只会给规范值）');
    assert.equal(t.recValidDate('2026-02-30'), '', 'Date 会把它归一成 3 月，反查拦下');
    assert.equal(t.recValidDate('2026-13-01'), '');
    assert.equal(t.recValidDate('abc'), '');
    assert.equal(t.recValidDate(''), '');
    assert.equal(t.recTsToDate(localTs(2026, 1, 5)), '2026-01-05', '本地时区取日');
    assert.equal(t.recTsToDate(0), '', '无时间戳返回空（未知，不当作 1970）');
});

test('normDateRange：端点颠倒自动交换、单侧开区间、两端皆空为 null', () => {
    const t = tools();
    eq(t.normDateRange('2026-03-10', '2026-03-01'), { from: '2026-03-01', to: '2026-03-10' });
    eq(t.normDateRange('', '2026-03-01'), { from: '', to: '2026-03-01' });
    eq(t.normDateRange('2026-03-01', ''), { from: '2026-03-01', to: '' });
    assert.equal(t.normDateRange('', ''), null);
    assert.equal(t.normDateRange('坏值', '坏值'), null);
    eq(t.normDateRange('2026-02-30', '2026-03-01'), { from: '', to: '2026-03-01' }, '非法端点被剔除');
});

test('recDateInRange：闭区间（含端点）+ 跨月/跨年', () => {
    const t = tools();
    const crossYear = t.normDateRange('2025-12-30', '2026-01-02');
    assert.ok(t.recDateInRange('2025-12-30', crossYear), '起点含');
    assert.ok(t.recDateInRange('2026-01-02', crossYear), '终点含');
    assert.ok(t.recDateInRange('2026-01-01', crossYear));
    assert.ok(!t.recDateInRange('2025-12-29', crossYear));
    assert.ok(!t.recDateInRange('2026-01-03', crossYear));
    const crossMonth = t.normDateRange('2026-01-28', '2026-02-02');
    assert.ok(t.recDateInRange('2026-01-31', crossMonth));
    assert.ok(t.recDateInRange('2026-02-01', crossMonth));
    assert.ok(!t.recDateInRange('', crossMonth), '空日期不落在任何区间');
    assert.ok(!t.recDateInRange('2026-01-31', null), '无区间 = false（由调用方决定是否跳过筛选）');
});

test('normNumRange / recNumInRange：钳制与颠倒纠正，端点含', () => {
    const t = tools();
    eq(t.normNumRange('8', '6', 0, 10), { min: 6, max: 8 }, 'min>max 自动交换');
    eq(t.normNumRange(-3, 20, 0, 10), { min: 0, max: 10 }, '越界钳到 0-10');
    eq(t.normNumRange('', ''), null);
    eq(t.normNumRange('7', ''), { min: 7, max: null }, '单侧区间');
    eq(t.normNumRange('bad', '9', 0, 10), { min: null, max: 9 });
    const r = { min: 7, max: 8 };
    assert.ok(t.recNumInRange(7, r) && t.recNumInRange(8, r), '端点含');
    assert.ok(!t.recNumInRange(6.9, r) && !t.recNumInRange(8.1, r));
    assert.ok(!t.recNumInRange(null, r), '缺值不满足具体数值条件');
});

// ---------------------------------------------------------------- 收藏筛选谓词

test('parseRecTagQuery：逗号/全角逗号/顿号/空格分隔，去重且封顶 16', () => {
    const t = tools();
    eq(t.parseRecTagQuery('日常, 校园、日常　搞笑'), ['日常', '校园', '搞笑']);
    eq(t.parseRecTagQuery(['原创', '原创', '  ']), ['原创']);
    eq(t.parseRecTagQuery(''), []);
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`).join(' ');
    assert.equal(t.parseRecTagQuery(many).length, 16);
});

test('recSeasonRange：标准季度半开区间（含跨年 Q4）', () => {
    const t = tools();
    eq(t.recSeasonRange('2026Q1'), { start: '2026-01-01', end: '2026-04-01' });
    eq(t.recSeasonRange('2026q4'), { start: '2026-10-01', end: '2027-01-01' });
    assert.equal(t.recSeasonRange('2026Q5'), null);
    assert.equal(t.recSeasonRange(''), null);
});

test('normFavFilter：季度与日期互斥、星期规范化、includeUnknown 严格布尔、脏输入收敛', () => {
    const t = tools();
    const f = t.normFavFilter({ season: '2026q1', dateFrom: '2026-03-01', dateTo: '2026-03-31', weekdays: [3, 1, 3, 9, '2'], includeUnknown: 'yes' });
    assert.equal(f.season, '2026Q1');
    assert.equal(f.dateRange, null, '有季度则日期区间作废（对齐 Bangumi 工作台互斥规则）');
    eq(f.weekdays, [1, 2, 3], '去重、排序、越界剔除');
    assert.equal(f.includeUnknown, false, '只认布尔 true');
    const g = t.normFavFilter({ dateFrom: '2026-03-31', dateTo: '2026-03-01', scoreMin: 9, scoreMax: 7, rankMin: 500, rankMax: 100 });
    eq(g.dateRange, { from: '2026-03-01', to: '2026-03-31' });
    eq(g.scoreRange, { min: 7, max: 9 });
    eq(g.rankRange, { min: 100, max: 500 });
    assert.equal(t.favFilterActive(null), false);
    assert.equal(t.favFilterActive({ tags: ['日常'] }), true);
    assert.equal(t.favFilterActive({ includeUnknown: true }), false, '「含未知」本身不是筛选条件');
});

test('matchFavFilter：标签 AND、评分/排名/日期/星期范围，未知默认排除、开关后可保留', () => {
    const t = tools();
    const item = { name: '番', bangumiId: '1' };
    // 标签 AND（大小写不敏感）
    assert.ok(t.matchFavFilter(item, { tags: ['日常', '校园'] }, { tags: ['日常', '校园', '治愈'] }));
    assert.ok(!t.matchFavFilter(item, { tags: ['日常', '机战'] }, { tags: ['日常', '校园'] }), '任一标签不满足即排除');
    assert.ok(!t.matchFavFilter(item, { tags: ['日常'] }, { tags: [] }), '无标签数据 → 默认排除');
    assert.ok(t.matchFavFilter(item, { tags: ['日常'], includeUnknown: true }, { tags: [] }), '含未知开关 → 保留');
    // 评分/排名（含端点）
    assert.ok(t.matchFavFilter(item, { scoreMin: 8, scoreMax: 9 }, { score: 8 }));
    assert.ok(!t.matchFavFilter(item, { scoreMin: 8, scoreMax: 9 }, { score: 9.1 }));
    assert.ok(t.matchFavFilter(item, { scoreMin: 8, includeUnknown: true }, { score: 0 }), '未评分 + 含未知 → 保留');
    assert.ok(t.matchFavFilter(item, { rankMin: 1, rankMax: 100 }, { rank: 100 }));
    assert.ok(!t.matchFavFilter(item, { rankMin: 1, rankMax: 100 }, { rank: 101 }));
    // 季度半开：Q1 = [01-01, 04-01)
    assert.ok(t.matchFavFilter(item, { season: '2026Q1' }, { date: '2026-01-01' }));
    assert.ok(t.matchFavFilter(item, { season: '2026Q1' }, { date: '2026-03-31' }));
    assert.ok(!t.matchFavFilter(item, { season: '2026Q1' }, { date: '2026-04-01' }), '下季首日不归本季');
    // 显式日期区间：闭区间
    const range = { dateFrom: '2026-01-01', dateTo: '2026-01-31' };
    assert.ok(t.matchFavFilter(item, range, { date: '2026-01-31' }));
    assert.ok(!t.matchFavFilter(item, range, { date: '2026-02-01' }));
    // 星期（1=周一，由开播日期推算）
    assert.ok(t.matchFavFilter(item, { weekdays: [4] }, { date: '2026-01-01' }), '2026-01-01 是周四');
    assert.ok(!t.matchFavFilter(item, { weekdays: [5] }, { date: '2026-01-01' }));
    assert.equal(t.recWeekday({ date: '2026-01-04' }, null), 7, '周日映射 7（对齐 Bangumi 口径）');
    // 未启用 = 恒真（含 null 记录也不拦）
    assert.ok(t.matchFavFilter(item, null, null));
    assert.ok(t.matchFavFilter(null, null, null), '无筛选时 null 记录也通过（由上层列表保证非空）');
});

// ---------------------------------------------------------------- 历史筛选谓词

test('scoreInTier：档位半开边界、未评分独立档、未知档位不筛', () => {
    const t = tools();
    assert.ok(t.scoreInTier(null, ''));
    assert.equal(t.scoreInTier(9, 'gte9'), true);
    assert.equal(t.scoreInTier(8.9, 'gte9'), false);
    assert.equal(t.scoreInTier(8.9, '8-9'), true);
    assert.equal(t.scoreInTier(8, '8-9'), true);
    assert.equal(t.scoreInTier(6, '6-7'), true);
    assert.equal(t.scoreInTier(5.9, 'lt6'), true);
    assert.equal(t.scoreInTier(6, 'lt6'), false);
    assert.equal(t.scoreInTier(null, 'none'), true);
    assert.equal(t.scoreInTier(0, 'none'), true, '0/缺失都算未评分');
    assert.equal(t.scoreInTier(7, 'none'), false);
    assert.equal(t.scoreInTier(7, 'bogus-tier'), true, '未知档位不筛（防脏设置把列表筛空）');
});

test('matchHistoryFilter：单日 + 区间（含端点、跨月、非法纠正）+ 来源 + 评分档位', () => {
    const t = tools();
    const play = { name: 'A', kind: 'play', site: 's1', siteName: '源甲', lastPlayTs: localTs(2026, 1, 31), ts: localTs(2026, 2, 1) };
    const view = { name: 'B', kind: 'view', site: 'kazumi:rule', siteName: '规则甲', ts: localTs(2026, 2, 2) };
    // 单日：播放卡按 lastPlayTs（1-31），浏览卡按 ts（2-2）
    assert.ok(t.matchHistoryFilter(play, { date: '2026-01-31' }, null));
    assert.ok(!t.matchHistoryFilter(play, { date: '2026-02-01' }, null), '播放卡不按 ts 取日');
    assert.ok(t.matchHistoryFilter(view, { date: '2026-02-02' }, null));
    // 区间含端点（跨月）
    const range = { from: '2026-01-31', to: '2026-02-02' };
    assert.ok(t.matchHistoryFilter(play, range, null));
    assert.ok(t.matchHistoryFilter(view, range, null));
    assert.ok(!t.matchHistoryFilter({ ...view, ts: localTs(2026, 2, 3) }, range, null));
    // 非法区间（起止颠倒）：归一化后仍能筛（不筛空、不抛错）
    assert.ok(t.matchHistoryFilter(play, { from: '2026-02-02', to: '2026-01-31' }, null));
    // 单日与区间叠加 = AND
    assert.ok(!t.matchHistoryFilter(play, { date: '2026-02-02', from: '2026-01-01', to: '2026-01-31' }, null));
    // 来源（site 原值相等；kazumi: 原样保留）
    assert.ok(t.matchHistoryFilter(view, { site: 'kazumi:rule' }, null));
    assert.ok(!t.matchHistoryFilter(view, { site: 's1' }, null));
    // 评分档位：未知记录只在「未评分」档出现
    assert.ok(t.matchHistoryFilter(play, { score: 'none' }, { score: 0 }));
    assert.ok(!t.matchHistoryFilter(play, { score: '8-9' }, { score: 0 }));
    assert.ok(t.matchHistoryFilter(play, { score: '8-9' }, { score: 8.6 }));
    assert.equal(t.normHistoryFilter({ date: '2026-02-30', score: 'nope' }).date, '', '非法日期剔空');
    assert.equal(t.normHistoryFilter({ score: 'nope' }).score, '', '非法档位回落不限');
    assert.equal(t.historyFilterActive(null), false);
    assert.equal(t.historyFilterActive({ site: 's1' }), true);
});

test('collectHistorySites：按 site 去重、siteName 优先作展示名、按名排序', () => {
    const t = tools();
    const out = t.collectHistorySites([
        { site: 's1', siteName: '源甲' }, { site: 's1', siteName: '源甲' },
        { site: 'kazumi:r', siteName: '规则' }, { site: '', siteName: '无源标识' },
        { site: 's2' },
    ]);
    // 展示名按码位序排列（不引 locale 依赖，顺序稳定可预期：ASCII 在前、中文在后）
    eq(out, [
        { value: 's2', label: 's2' },
        { value: 's1', label: '源甲' },
        { value: 'kazumi:r', label: '规则' },
    ]);
});

// ---------------------------------------------------------------- 元数据优先级与回填

test('recBgmId / recMetaOf：id 解析口径与「记录自带 → 匹配缓存 → 回填缓存」优先级', () => {
    const matchCache = new Map([['番甲', { id: 900, cover: 'c', score: 7.1, rank: 300, air_date: '2020-04-01' }]]);
    const kazumi = { getCachedBangumiMatch: (n) => matchCache.get(String(n || '').trim()) || null };
    const t = tools({}, { kazumi });
    assert.equal(t.recBgmId({ bangumiId: '12' }), '12');
    assert.equal(t.recBgmId({ site: 'bangumi', vodId: '34' }), '34', 'Bangumi 托管条目用 vodId');
    assert.equal(t.recBgmId({ site: 'cspby', vodId: 'v1' }), '', '普通源无 bangumiId → 无 id');
    // 记录自带字段优先
    const own = t.recMetaOf({ name: '番甲', bgmScore: 9, bgmRank: 5, airDate: '2026-01-01' });
    assert.equal(own.score, 9);
    assert.equal(own.rank, 5);
    assert.equal(own.date, '2026-01-01');
    // 无自带字段 → 片名匹配缓存补齐
    const fallback = t.recMetaOf({ name: '番甲' });
    assert.equal(fallback.id, '900');
    assert.equal(fallback.score, 7.1);
    assert.equal(fallback.rank, 300);
    assert.equal(fallback.date, '2020-04-01');
    // id 与缓存的 id 不一致 → 不采信（防同名不同部串数据）
    const mismatch = t.recMetaOf({ name: '番甲', bangumiId: '777' });
    assert.equal(mismatch.score, 0, '记录 id 与匹配缓存 id 冲突时不借用他人评分');
});

test('recPrefetchBgmMeta：批量 ≤60、缓存命中零重复请求、失败条目不再重试', async () => {
    const calls = [];
    const kazumi = {
        bangumiInfoBatch: async (ids) => {
            calls.push(ids.slice());
            const out = {};
            ids.forEach((id) => { out[id] = Number(id) === 2 ? null : { id: Number(id), rating: { score: 8, rank: 10 }, date: '2026-01-01', tags: [{ name: '日常' }] }; });
            return out;
        },
    };
    const ctx = loadRecords({}, { kazumi });
    const t = ctx.__TOOLS;
    const ids = Array.from({ length: 130 }, (_, i) => String(i + 1));
    await t.recPrefetchBgmMeta(ids);
    assert.equal(calls.length, 2, '单渲染最多 120 个 id（2 批），超出部分留给下次渲染');
    assert.equal(calls[0].length, 60, '单批 ≤60');
    assert.equal(calls[1].length, 60);
    // 第二次补上剩余 10 个 id（缓存命中的 120 个不再请求）
    await t.recPrefetchBgmMeta(ids);
    assert.equal(calls.length, 3, '未覆盖的 10 个 id 下次渲染补拉');
    assert.equal(calls[2].length, 10);
    // 全部命中缓存：再调不发请求
    await t.recPrefetchBgmMeta(ids);
    assert.equal(calls.length, 3, '30 分钟内同 id 零网络');
    // failure 短 TTL：id=2 上次返回 null，也记了失败条目 → 仍不重试
    const meta2 = t.recMetaOf({ bangumiId: '2', name: 'x' });
    assert.equal(meta2.score, 0);
    await t.recPrefetchBgmMeta(['2']);
    assert.equal(calls.length, 3, '失败条目在负缓存窗口内不重试');
    // 回填后 id=1 的标签可读（标签筛选依赖）
    const meta1 = t.recMetaOf({ bangumiId: '1', name: 'x' });
    eq(meta1.tags, ['日常']);
});

test('recMetaIdsOf：三项齐全的条目不回填；needTags 时把无标签条目也纳入', () => {
    const kazumi = { getCachedBangumiMatch: () => null };
    const t = tools({}, { kazumi });
    const full = { bangumiId: '1', bgmScore: 8, bgmRank: 9, airDate: '2026-01-01' };
    const gap = { bangumiId: '2', bgmScore: 8 };
    const noId = { site: 'cspby', vodId: 'v1', name: '无名片' };
    eq(t.recMetaIdsOf([full, gap, noId], false), ['2']);
    eq(t.recMetaIdsOf([full, gap], true), ['1', '2'], '标签筛选启用时无标签条目也要回填');
    eq(t.recMetaIdsOf(null, false), []);
});

// ---------------------------------------------------------------- 菜单 / 工具条 / 续播解析

test('buildFavMenuHtml：六态 + 取消收藏，当前状态高亮且 aria-checked 同步', () => {
    const t = tools();
    const html = t.buildFavMenuHtml('watching');
    for (const label of ['想看', '在看', '看过', '搁置', '抛弃', '取消收藏']) assert.ok(html.includes(label), `菜单应含「${label}」`);
    assert.equal((html.match(/rec-fav-menu-item/g) || []).length, 6);
    assert.equal((html.match(/aria-checked="true"/g) || []).length, 1, '只有一个当前项');
    assert.ok(html.match(/class="rec-fav-menu-item active" data-tag="watching" aria-checked="true"/));
    const none = t.buildFavMenuHtml('');
    assert.ok(none.match(/class="rec-fav-menu-item active" data-tag="" aria-checked="true"/), '未收藏时高亮「取消收藏」');
    eq(t.favMenuItems().map((x) => x.tag), ['want', 'watching', 'seen', 'hold', 'dropped', '']);
});

test('recToolbarHtml：收藏/历史控件齐备、无内联事件属性（CSP）、带 title/aria 标签', () => {
    const t = tools();
    const fav = t.recToolbarHtml('view-favorites', false);
    assert.ok(fav.includes('id="view-favorites-sort"') && fav.includes('id="view-favorites-filter-apply"'));
    assert.ok(fav.includes('id="view-favorites-f-unknown"'), '含未知/未评分开关');
    assert.ok(fav.includes('data-weekday="7"'));
    const his = t.recToolbarHtml('view-history', true);
    for (const id of ['-sort', '-sites', '-date', '-from', '-to', '-score', '-filter-reset']) {
        assert.ok(his.includes(`id="view-history${id}"`), `历史工具条应含 view-history${id}`);
    }
    assert.ok(his.includes('value="none"') && his.includes('value="time-asc"'));
    for (const html of [fav, his]) {
        assert.ok(!/on(click|change|input)=/i.test(html), '不得出现内联事件属性（CSP script-src-attr）');
        assert.ok(html.includes('title='), '控件应带 title（可读性）');
    }
    assert.ok(fav.includes('aria-label="筛选"') && fav.includes('aria-expanded="false"'));
});

test('parseRecSources / locateRecEpisode：详情响应解析与集数定位', () => {
    const t = tools();
    const sources = t.parseRecSources({
        vod_play_from: '线路一$$$线路二',
        vod_play_url: '第1集$http://a/1.m3u8#第2集$http://a/2.m3u8$$$第1集$http://b/1.m3u8',
    });
    assert.equal(sources.length, 2);
    assert.equal(sources[0].episodes.length, 2);
    assert.equal(sources[0].episodes[1].name, '第2集');
    assert.equal(sources[0].episodes[1].url, 'http://a/2.m3u8');
    assert.equal(sources[1].from, '线路二');
    eq(t.parseRecSources(null), []);
    assert.equal(t.locateRecEpisode(sources[0].episodes, '第2集', 1), 1, '集名优先');
    assert.equal(t.locateRecEpisode(sources[0].episodes, '不存在', 2), 1, '集名不中回退 watchProgress 集号');
    assert.equal(t.locateRecEpisode(sources[0].episodes, '不存在', 9), -1, '越界/无集号 → -1（调用方决定回退）');
    assert.equal(t.locateRecEpisode(sources[0].episodes, '', 0), -1);
});

test('resumePlayRecord：CatVod 用 lastSourceMap 记忆线路 + 集名定位，Player.play 参数与详情页同形', async () => {
    const plays = [];
    const settings = {
        lastSourceMap: { 'site-a|v1': 1 },
        watchProgress: { 'site-a|v1': { currentEp: 1, ts: 1 } },
    };
    const ctx = loadRecords(settings, {
        player: { play: async (...args) => { plays.push(args); } },
        doAction: async (action) => {
            if (action !== 'detailContent') return null;
            return { list: [{ vod_play_from: '线路一$$$线路二', vod_play_url: '第1集$http://a/1.m3u8#第2集$http://a/2.m3u8$$$第1集$http://b/1.m3u8#第2集$http://b/2.m3u8' }] };
        },
    });
    const r = await ctx.__TOOLS.resumePlayRecord({ site: 'site-a', vodId: 'v1', name: '片名', lastEpisode: '第2集' });
    assert.equal(r.ok, true);
    assert.equal(plays.length, 1);
    eq(plays[0].slice(0, 5), ['site-a', '线路二', 'http://b/2.m3u8', '片名', '第2集'], '记忆线路 + 集名定位');
    assert.equal(plays[0][6], 1, 'epIndex 为线路内下标（连播从该集开始）');
});

test('resumePlayRecord：线路记忆越界回退首条线路；集名/进度都对不上退第一集；无线路判失效', async () => {
    const plays = [];
    const settings = { lastSourceMap: { 'site-a|v1': 9 }, watchProgress: {} };
    const ctx = loadRecords(settings, {
        player: { play: async (...args) => { plays.push(args); } },
        doAction: async () => ({ list: [{ vod_play_from: '线路一', vod_play_url: '第1集$http://a/1.m3u8#第2集$http://a/2.m3u8' }] }),
    });
    await ctx.__TOOLS.resumePlayRecord({ site: 'site-a', vodId: 'v1', name: '片名', lastEpisode: '第9集' });
    eq(plays[0].slice(0, 5), ['site-a', '线路一', 'http://a/1.m3u8', '片名', '第1集'], '回退首线路首集');
    const empty = loadRecords({}, { player: { play: async () => {} }, doAction: async () => ({ list: [{}] }) });
    const r = await empty.__TOOLS.resumePlayRecord({ site: 'site-a', vodId: 'v1', name: '片名' });
    eq(r, { ok: false, reason: 'stale' });
    const noPlayer = loadRecords({}, { doAction: async () => ({ list: [{ vod_play_from: 'x', vod_play_url: '第1集$u' }] }) });
    const r2 = await noPlayer.__TOOLS.resumePlayRecord({ site: 'site-a', vodId: 'v1', name: '片名' });
    eq(r2, { ok: false, reason: 'mpv-missing' }, '无播放器明确区分（不是「播放失败」）');
});

test('resumePlayRecord：Kazumi 源按 kazumiSrc 解析、集名对不上回退选源；直连类走既有链路', async () => {
    const actions = [];
    const plays = [];
    const ctx = loadRecords({}, {
        kazumi: {},
        player: { play: async (...args) => { plays.push(args); } },
        doAction: async (action, kv) => {
            actions.push([action, kv]);
            return { roads: [{ name: '线路甲', data: ['http://k/1.mp4', 'http://k/2.mp4'], identifier: ['第1集', '第2集'] }] };
        },
    });
    const okRes = await ctx.__TOOLS.resumePlayRecord({ site: 'kazumi:rule', vodId: '', kazumiSrc: 'http://src/anime', name: '番名', lastEpisode: '第2集' });
    assert.equal(okRes.ok, true);
    assert.equal(actions[0][0], 'kazumiChapters');
    assert.equal(plays[0][1], '线路甲');
    assert.equal(plays[0][2], 'http://k/2.mp4');
    assert.equal(plays[0][7], 'http://src/anime', 'kazumiSrc 透传给 Player.play（历史/连播需要）');
    const miss = await ctx.__TOOLS.resumePlayRecord({ site: 'kazumi:rule', vodId: '', kazumiSrc: 'http://src/anime', name: '番名', lastEpisode: '第99集' });
    eq(miss, { ok: false, reason: 'need-source' }, '集名对不上 → 交回选源弹窗');
    const captcha = loadRecords({}, { kazumi: {}, doAction: async () => ({ captcha: true, roads: [] }) });
    eq(await captcha.__TOOLS.resumePlayRecord({ site: 'kazumi:rule', vodId: '', kazumiSrc: 'u', name: 'n', lastEpisode: '第1集' }),
        { ok: false, reason: 'captcha' });
    // 直连类：playUrl 成功即 ok
    const direct = loadRecords({}, { player: { play: async () => {} } });
    direct.window.yuki.playUrl = async () => ({ ok: true });
    eq(await direct.__TOOLS.resumePlayRecord({ site: 'direct', vodId: 'http://x/1.mp4', name: '直链' }), { ok: true });
});

// ---------------------------------------------------------------- 视图管线（真实 render）

test('收藏排序：settings.favoritesSort 载入并驱动网格顺序；控件切换后写回 settings', async () => {
    const settings = {
        favoritesSort: 'name',
        favorites: [
            { uid: 'u1', site: 'a', vodId: '1', name: '乙番', tag: 'want', ts: 300 },
            { uid: 'u2', site: 'a', vodId: '2', name: '甲番', tag: 'want', ts: 200 },
            { uid: 'u3', site: 'a', vodId: '3', name: '', tag: 'want', ts: 100 },
        ],
    };
    const htmls = [];
    const ctx = loadRecords(settings, { onGridHtml: (h) => htmls.push(h) });
    const view = ctx.__makeRecordView('view-favorites', 'favorites', '暂无收藏', true, true, 'pageSizeFavorites');
    await view.enter();
    assert.equal(view._sort, 'name', '排序状态从 settings 载入');
    const html = htmls.join('');
    assert.ok(html.indexOf('甲番') < html.indexOf('乙番'), '中文名升序（甲 < 乙）');
    // 控件切换：走真实 change 处理器（含持久化）
    ctx.__TOOLS.fire('#view-favorites-sort', 'change', { currentTarget: { value: 'recent' } });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(settings.favoritesSort, 'recent', '选择持久化');
    assert.equal(view._sort, 'recent');
    // 脏值钳回默认
    ctx.__TOOLS.fire('#view-favorites-sort', 'change', { currentTarget: { value: 'zzz' } });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(settings.favoritesSort, 'recent', '非法排序键不落盘、回默认值');
});

test('收藏筛选：settings.favoritesFilter 载入 → 谓词生效与空态文案；「含未知」开关保留无数据条目', async () => {
    const settings = {
        favoritesFilter: { scoreMin: 8, scoreMax: 10 },
        favorites: [
            { uid: 'u1', site: 'a', vodId: '1', name: '高分番', tag: 'want', ts: 1, bgmScore: 9 },
            { uid: 'u2', site: 'a', vodId: '2', name: '低分番', tag: 'want', ts: 2, bgmScore: 6 },
            { uid: 'u3', site: 'a', vodId: '3', name: '未知番', tag: 'want', ts: 3 },
        ],
    };
    const htmls = [];
    const ctx = loadRecords(settings, { onGridHtml: (h) => htmls.push(h) });
    const view = ctx.__makeRecordView('view-favorites', 'favorites', '暂无收藏', true, true, 'pageSizeFavorites');
    await view.enter();
    let html = htmls.join('');
    assert.ok(html.includes('高分番'));
    assert.ok(!html.includes('低分番'), '评分不在区间内被筛掉');
    assert.ok(!html.includes('未知番'), '默认排除未知条目（可在面板开关里放行）');
    // 面板勾选「含未知/未评分条目」后应用：未知条目回来
    htmls.length = 0;
    ctx.__TOOLS.values['#view-favorites-f-score-min'] = '8';
    ctx.__TOOLS.values['#view-favorites-f-score-max'] = '10';
    ctx.__TOOLS.props['#view-favorites-f-unknown|checked'] = true;
    ctx.__TOOLS.fire('#view-favorites-filter-apply', 'click', {});
    await new Promise((r) => setTimeout(r, 0));
    html = htmls.join('');
    assert.ok(html.includes('高分番') && html.includes('未知番'));
    assert.ok(!html.includes('低分番'));
    assert.equal(settings.favoritesFilter.includeUnknown, true, '开关持久化');
    // 归一化后的状态对象形状（面板输入 → normFavFilter）
    eq(settings.favoritesFilter.scoreRange, { min: 8, max: 10 });
    // 筛选无结果时空态必须提示「没有匹配」，不能是「暂无收藏」
    view._filter = ctx.__TOOLS.normFavFilter({ scoreMin: 9.9, scoreMax: 10 });
    htmls.length = 0;
    await view.render();
    assert.ok(htmls.join('').includes('没有匹配的记录'));
});

test('历史筛选与排序：settings 载入 + 即时筛选（控件 change）+ 非法区间纠正回写', async () => {
    const d1 = localTs(2026, 1, 31);
    const d2 = localTs(2026, 2, 2);
    const settings = {
        historySort: 'time-asc',
        historyFilter: { from: '2026-02-02', to: '2026-01-31', site: 'kazumi:r' },
        history: [
            { uid: 'h1', site: 'kazumi:r', siteName: '规则', kazumiSrc: 'u', name: '规则片', kind: 'play', lastEpisode: '第1集', ts: d1, lastPlayTs: d1 },
            { uid: 'h2', site: 'site-b', siteName: '源乙', vodId: 'v2', name: '源乙片', kind: 'play', lastEpisode: '第1集', ts: d2, lastPlayTs: d2 },
        ],
    };
    const htmls = [];
    const ctx = loadRecords(settings, { onGridHtml: (h) => htmls.push(h) });
    const view = ctx.__makeRecordView('view-history', 'history', '暂无历史', true, false, 'pageSizeHistory');
    await view.enter();
    assert.equal(view._sort, 'time-asc');
    eq(view._filter, { date: '', from: '2026-01-31', to: '2026-02-02', site: 'kazumi:r', score: '' },
        '颠倒的区间自动交换端点后落状态');
    assert.ok(htmls.join('').includes('规则片'));
    assert.ok(!htmls.join('').includes('源乙片'), '来源筛选生效');
    // 控件改评分档位：即时筛选（未评分档只留无评分记录）
    ctx.__TOOLS.values['#view-history-score'] = 'none';
    ctx.__TOOLS.values['#view-history-sites'] = '';
    ctx.__TOOLS.values['#view-history-date'] = '';
    ctx.__TOOLS.values['#view-history-from'] = '';
    ctx.__TOOLS.values['#view-history-to'] = '';
    htmls.length = 0;
    ctx.__TOOLS.fire('#view-history-score', 'change', {});
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(settings.historyFilter.score, 'none');
    assert.ok(htmls.join('').includes('规则片') && htmls.join('').includes('源乙片'), '两条都未评分 → 都在「未评分」档');
    // 重置：状态与持久化都回到默认
    ctx.__TOOLS.fire('#view-history-filter-reset', 'click', {});
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(settings.historySort, 'time-desc');
    eq(settings.historyFilter, { date: '', from: '', to: '', site: '', score: '' });
    // 历史卡渲染：播放卡有 ▶ 与 ⋯ 按钮，浏览卡无 ▶（收藏钮仍在：有 site+vodId）
    const card = ctx.__recCard({ uid: 'p1', site: 'site-a', vodId: 'v1', name: '播放卡', kind: 'play' }, true, false, {});
    assert.ok(card.includes('rec-play-btn') && card.includes('has-play') && card.includes('rec-fav-btn'));
    const viewCard = ctx.__recCard({ uid: 'v1', site: 'site-a', vodId: 'v1', name: '浏览卡', kind: 'view' }, true, false, {});
    assert.ok(!viewCard.includes('rec-play-btn'), '浏览卡不出续播按钮（无集数可续）');
    assert.ok(viewCard.includes('rec-fav-btn'));
    const favCard = ctx.__recCard({ uid: 'f1', site: 'a', vodId: '1', name: '收藏卡', tag: 'want' }, true, true, {});
    assert.ok(!favCard.includes('rec-play-btn') && !favCard.includes('rec-fav-btn'), '收藏页卡片不出这两个按钮');
});

// ---------------------------------------------------------------- 任务 1：批量标记广播

test('tagChecked：纯 Bangumi 勾选批量标记后统一广播一次（本页/其它页面徽标同步的关键）', async () => {
    const setCalls = [];
    let invalidated = 0;
    const settings = {
        favorites: [
            { uid: 'b1', site: 'bangumi', vodId: '11', name: '番一', tag: 'want', bangumi: true },
            { uid: 'b2', site: 'bangumi', vodId: '12', name: '番二', tag: 'want', bangumi: true },
        ],
    };
    const ctx = loadRecords(settings, {
        checked: [
            { uid: '', bgm: true, id: '11', checked: true },
            { uid: '', bgm: true, id: '12', checked: true },
        ],
        kazumi: {
            _favTagToBangumiType: { want: 1, watching: 3, seen: 2, hold: 4, dropped: 5 },
            setBangumiCollection: async (id, type) => { setCalls.push([id, type]); return true; },
        },
        timeline: { invalidateColCache: () => { invalidated++; }, refreshAfterFavoriteChange: () => {} },
    });
    let broadcasts = 0;
    ctx.__FavHub.onChanged(() => { broadcasts++; });
    const view = ctx.__makeRecordView('my-favorites', 'favorites', '暂无收藏', true, true, 'pageSizeFavorites', '#my-panel-favorites');
    await view.enter();
    broadcasts = 0;
    await view.tagChecked('seen');
    eq(setCalls, [['11', 2], ['12', 2]], '逐条同步到 Bangumi 账号');
    assert.equal(broadcasts, 1, '纯 Bangumi 路径也必须广播一次（此前完全没有）');
    assert.equal(invalidated, 1, '时间表收藏过滤集合一并作废');
    assert.equal(ctx.Kazumi._bgmBatchActive, false, '批量开关复位');
    assert.ok(ctx.__TOOLS.toasts.join('|').includes('2 条 Bangumi'), '结果回执包含 Bangumi 条数');
});

test('tagChecked：本地 + Bangumi 混合勾选只广播一次（recSet 已发，不重复）', async () => {
    const settings = { favorites: [
        { uid: 'l1', site: 'a', vodId: 'v1', name: '本地番', tag: 'want', ts: 1 },
        { uid: 'b1', site: 'bangumi', vodId: '11', name: '番一', tag: 'want', bangumi: true },
    ] };
    const ctx = loadRecords(settings, {
        checked: [
            { uid: 'l1', bgm: false, checked: true },
            { uid: '', bgm: true, id: '11', checked: true },
        ],
        kazumi: {
            _favTagToBangumiType: { seen: 2 },
            setBangumiCollection: async () => { throw new Error('boom'); },
        },
    });
    let broadcasts = 0;
    ctx.__FavHub.onChanged(() => { broadcasts++; });
    const view = ctx.__makeRecordView('my-favorites', 'favorites', '暂无收藏', true, true, 'pageSizeFavorites', '#my-panel-favorites');
    await view.enter();
    broadcasts = 0;
    await view.tagChecked('seen');
    assert.equal(settings.favorites.find((x) => x.uid === 'l1').tag, 'seen', '本地条目状态已写盘');
    assert.equal(broadcasts, 1, 'recSet 一次 + 补发逻辑跳过 = 恰好一次广播');
    assert.equal(ctx.Kazumi._bgmBatchActive, false, '同步抛错时开关也要复位（try/finally）');
    assert.ok(ctx.__TOOLS.toasts.join('|').includes('1 失败'), '单个 Bangumi 失败计入回执');
});

// ---------------------------------------------------------------- 任务 7：六态收藏菜单写链路

test('收藏菜单：applyRecFavMenu 走 setFavTag/toggleFavorite 并广播；当前态点击不写盘', async () => {
    const settings = { favorites: [{ uid: 'f1', site: 'site-a', vodId: 'v1', name: '片名', tag: 'want', ts: 1 }] };
    const ctx = loadRecords(settings);
    let broadcasts = 0;
    ctx.__FavHub.onChanged(() => { broadcasts++; });
    const btn = { length: 1, 0: { getBoundingClientRect: () => ({ right: 100, bottom: 300, top: 280 }) } };
    // 打开菜单：读出当前状态（want）并高亮
    await ctx.__TOOLS.openRecFavMenu(btn, { site: 'site-a', vodId: 'v1', name: '片名', siteName: '源甲' });
    assert.ok(ctx.__TOOLS.values['#rec-fav-menu|html'].includes('data-tag="want"'), '菜单已渲染六态');
    // 点击当前态：直接关闭，不写盘不广播
    await ctx.__TOOLS.applyRecFavMenu('want');
    assert.equal(broadcasts, 0, '同状态不产生无意义的写入与广播');
    assert.equal(settings.favorites.length, 1);
    // 切到「看过」
    await ctx.__TOOLS.openRecFavMenu(btn, { site: 'site-a', vodId: 'v1', name: '片名', siteName: '源甲' });
    await ctx.__TOOLS.applyRecFavMenu('seen');
    assert.equal(settings.favorites[0].tag, 'seen');
    assert.equal(broadcasts, 1, 'FavHub 广播一次（其它页面据此刷新）');
    assert.ok(ctx.__TOOLS.toasts.join('|').includes('已标记为看过'));
    // 取消收藏：删条目 + 广播
    await ctx.__TOOLS.openRecFavMenu(btn, { site: 'site-a', vodId: 'v1', name: '片名', siteName: '源甲' });
    await ctx.__TOOLS.applyRecFavMenu('');
    assert.equal(settings.favorites.length, 0, '取消收藏删除条目');
    assert.equal(broadcasts, 2);
    assert.ok(ctx.__TOOLS.toasts.join('|').includes('已取消收藏'));
    ctx.__TOOLS.closeRecFavMenu();
});

test('收藏菜单：未收藏的记录选择状态 → 先加入收藏再置标签（setFavTag 内建语义）', async () => {
    const settings = { favorites: [] };
    const ctx = loadRecords(settings);
    const btn = { length: 1, 0: { getBoundingClientRect: () => ({ right: 100, bottom: 300, top: 280 }) } };
    await ctx.__TOOLS.openRecFavMenu(btn, { site: 'site-b', vodId: 'v9', name: '新片', siteName: '源乙' });
    assert.ok(ctx.__TOOLS.values['#rec-fav-menu|html'].includes('data-tag="" aria-checked="true"'), '未收藏时高亮「取消收藏」');
    await ctx.__TOOLS.applyRecFavMenu('watching');
    assert.equal(settings.favorites.length, 1);
    assert.equal(settings.favorites[0].tag, 'watching');
    assert.equal(settings.favorites[0].name, '新片');
    assert.equal(settings.favorites[0].vodId, 'v9');
    ctx.__TOOLS.closeRecFavMenu();
});

// ---------------------------------------------------------------- 视图方法：续播按钮与筛选面板

test('view.resumePlay：按 uid 回查记录起播；记录已被删则给「已失效」提示而不是静默', async () => {
    const settings = { history: [
        { uid: 'h1', site: 'direct', vodId: 'http://x/1.mp4', name: '直链片', kind: 'play', lastEpisode: '第1集', ts: 1, lastPlayTs: 1 },
    ] };
    const calls = [];
    const ctx = loadRecords(settings, { onGridHtml: () => {} });
    ctx.window.yuki.playUrl = async (url, meta) => { calls.push([url, meta]); return { ok: true }; };
    const view = ctx.__makeRecordView('view-history', 'history', '暂无历史', true, false, 'pageSizeHistory');
    await view.enter();
    const btn = { length: 1, addClass() { return btn; }, removeClass() { return btn; }, prop() { return btn; }, attr() { return btn; }, removeAttr() { return btn; } };
    await view.resumePlay('h1', btn);
    assert.equal(calls.length, 1, '直链记录直接起播（不经详情页）');
    assert.equal(calls[0][0], 'http://x/1.mp4');
    assert.equal(view._resumeBusy, false, '起播结束复位防抖标志');
    await view.resumePlay('不存在的 uid', btn);
    assert.ok(ctx.__TOOLS.toasts.join('|').includes('记录已失效'), '记录缺失给明确提示');
});

test('normFavFilter 幂等 + matchFavFilter 接受已归一化状态（回归：二次归一化丢区间）', () => {
    const t = tools();
    const raw = { tags: '日常 校园', season: '2026q1', scoreMin: 7, scoreMax: 9, rankMin: 10, rankMax: 200, weekdays: [2], includeUnknown: true };
    const once = t.normFavFilter(raw);
    const twice = t.normFavFilter(once);
    eq(twice, once);
    assert.ok(twice.scoreRange && twice.rankRange, '归一化结果必须带回区间（否则二次归一化会丢）');
    const item = { name: '番', bangumiId: '1' };
    const meta = { score: 5, tags: ['日常', '校园'] };
    assert.equal(t.matchFavFilter(item, once, meta), false, '评分不满足 → 排除（区间未丢）');
    assert.equal(t.matchFavFilter(item, once, { score: 8, tags: ['日常', '校园'] }), true);
    assert.equal(t.favFilterActive(once), true);
});

// ---------------------------------------------------------------- 评分落盘（写路径）

test('recordPlay：新记录把已知 Bangumi 元数据随记录落盘（评分筛选不必每次回源）', async () => {
    const settings = {};
    const kazumi = {
        // 片名匹配缓存：详情页/列表页预热后这里就有值（纯读，不发网络）
        getCachedBangumiMatch: (name) => (String(name).indexOf('无职') >= 0
            ? { id: '42', score: 8.4, rank: 123, air_date: '2026-04-01' } : null),
    };
    const ctx = loadRecords(settings, { kazumi });
    await ctx.__Records.recordPlay({
        name: '无职转生', site: 'siteA', vodId: 'v1', episode: '第1集', seconds: 90,
    });
    const entry = settings.history[0];
    assert.equal(entry.kind, 'play');
    assert.equal(entry.bgmScore, 8.4, '评分必须落盘（用户拍板：以后新记录带评分）');
    assert.equal(entry.bgmRank, 123, '排名同理（同一批元数据，不额外请求）');
    assert.equal(entry.airDate, '2026-04-01');
    assert.equal(entry.bangumiId, '42', 'subject id 一并存下，后续筛选/刷新可对齐条目');
});

test('recordPlay：拿不到元数据时不写空字段（不让记录里出现 score:0 / id:"" 之类的噪音）', async () => {
    const settings = {};
    const ctx = loadRecords(settings, { kazumi: { getCachedBangumiMatch: () => null } });
    await ctx.__Records.recordPlay({ name: '查不到的片子', site: 'siteA', vodId: 'v2' });
    const entry = settings.history[0];
    assert.equal('bgmScore' in entry, false);
    assert.equal('bgmRank' in entry, false);
    assert.equal('bangumiId' in entry, false);
    assert.equal('airDate' in entry, false);
});
