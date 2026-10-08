'use strict';
/**
 * 全局番剧屏蔽在各页面的接线测试（渲染层集成侧）。
 *
 * 与 tests/js/block-words.test.js 的分工：那个文件管 common.js 屏蔽引擎本身的
 * 匹配/生命周期语义，本文件管「各页真的调用了它」——用真实源码 + 最小桩驱动，
 * 断言基于真实实现（不内联复刻逻辑，避免实现改坏依旧全绿，同 timeline-filter
 * .test.js 的回归背景）。
 *
 * 覆盖：
 *  - search.js renderGroup：屏蔽在分组入口收口，计数/分组卡/快照只看过滤后结果；
 *    整组被屏蔽干净时按「该源无结果」处理，不出分组卡也不占结果位；
 *  - timeline.js _applyFilters：屏蔽先于收藏过滤生效；
 *  - bangumi-search.js / popular.js：渲染前过滤，且 _items 原始数据保留（删词可恢复）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * 从 common.js 抽出屏蔽引擎源码片段，与被测页面源码载入同一 VM 上下文。
 * 引擎自身的行为由 block-words.test.js 覆盖，这里只要「真实那份」在场。
 */
function blockEngineSrc() {
    const src = read('src/renderer/js/common.js');
    const start = src.indexOf('const BLOCK_WORDS_KEY');
    const end = src.indexOf('// ---------------------------------------------------------------- 分页', start);
    assert.ok(start > 0 && end > start, 'common.js 屏蔽引擎片段定位失败（常量/边界已改名？）');
    return src.slice(start, end);
}

/** 屏蔽引擎运行所需的最小依赖（仅 normalize 用到的内置对象 + 可选 SettingsSnapshot）。 */
function engineDeps(ctx, settings) {
    ctx.String = String;
    ctx.Array = Array;
    ctx.Object = Object;
    ctx.Set = Set;
    ctx.Map = Map;
    ctx.Promise = Promise;
    ctx.console = console;
    if (settings) ctx.window = { yuki: { settingsGet: async () => settings } };
}

/** 载入屏蔽引擎 + 注入词表（走真实 loadBlockWords，不用短路赋值）。 */
async function withWords(ctx, words, enable) {
    await ctx.__api_block.loadBlockWords.call(null); // 先占位，确保函数存在
    return ctx;
}

// ---------------------------------------------------------------- search.js：renderGroup

/** 在 VM 中加载 search.js（屏蔽引擎 + 最小桩），返回门面与录制器。 */
function loadSearchWithBlock(settings) {
    const ops = { html: [], append: [], remove: [], text: [] };
    const removed = [];
    const api = { sel: null };
    const mk$ = (sel) => {
        api.sel = sel;
        const self = {
            _sel: String(sel),
            on() { return self; }, off() { return self; },
            empty() { return self; },
            html(h) { if (typeof h === 'string') ops.html.push([String(sel), h]); return self; },
            append(h) { if (typeof h === 'string') ops.append.push([String(sel), h]); return self; },
            remove() { removed.push(String(sel)); return self; },
            text(t) { ops.text.push([String(sel), String(t)]); return self; },
            find() { return mk$(`${sel}>>find`); },
            closest() { return mk$(`${sel}>>closest`); },
            children() { const c = mk$(`${sel}>>children`); c.last = () => c; return c; },
            last() { return self; },
            each(cb) { return self; },
            filter() { return self; },
            first() { return self; },
            trigger() { return self; },
            toggle() { return self; }, show() { return self; }, hide() { return self; },
            val(v) { return v === undefined ? '英雄' : self; },
            data() { return undefined; },
            addClass() { return self; }, removeClass() { return self; },
            get length() { return 0; },
        };
        return self;
    };
    const context = {
        console, JSON, Math, Object, Array, String, Promise, Set, Map, RegExp, Number,
        encodeURIComponent: (s) => encodeURIComponent(s),
        setTimeout, clearTimeout,
        CSS: { escape: (s) => String(s) },
        $: mk$,
        escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        // Kazumi 卡渲染路径需要（_paintGrp 内联拼串）
        truncateTitle: (s, max) => { const t = String(s || ''); const n = max > 0 ? max : 60; return t.length <= n ? t : t.slice(0, n); },
        warnToast: () => {},
        showLoading: () => {}, hideLoading: () => {},
        apiUrl: (u) => u,
        pageSizeOf: async () => 20,
        renderStatusBar: () => {},
        renderPagerBox: () => {},
        vodCard: (v) => `<div class="vod-card" data-name="${v.vod_name}"></div>`,
        vodCoverImg: () => '<img>',
        bangumiCoverImg: () => '<img>',
        bangumiEpBadge: () => '',
        getCachedCover: () => '',
        fillMissingCovers: () => {},
        abortCoverFill: () => {},
        fitVodTitles: () => {},
        playCardsEnter: () => {},
        errorTextOf: (e) => String(e),
        Detail: { open: () => {} },
        UIState: { isEnabled: () => false, get: () => null, set: () => {} },
        localCacheGet: () => null,
        localCacheSet: () => {},
    };
    engineDeps(context, settings);
    context.window = { yuki: { settingsGet: async () => (settings || {}), settingsSet: async (k, v) => v } };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${blockEngineSrc()}
${read('src/renderer/js/search.js')}
;globalThis.__create = createSearchPage; globalThis.__Search = Search;
globalThis.__blk = { loadBlockWords, filterBlocked, invalidateBlockWords, normalizeBlockWords };`,
    context, { filename: 'search.js' });
    return { create: context.__create, Search: context.__Search, blk: context.__blk, ops, removed, $: mk$ };
}

const CFG = {
    mode: 'aggregate', stab: 'aggregate', gidPrefix: 'ag-sg',
    keywordSel: '#kw', goSel: '#go', filtersSel: '#ft', statusSel: '#st', resultsSel: '#rs',
};

test('search.js renderGroup：屏蔽词命中项不渲染、不占结果数（搜索时自动跳过）', async () => {
    const h = loadSearchWithBlock({ blockWords: ['我的英雄学院'] });
    await h.blk.loadBlockWords();
    const page = h.create(CFG);
    page._inited = true; // 跳过 init 的 DOM 绑定
    const total = page.renderGroup(
        { source: 'srcA', name: '源A' },
        [{ vod_id: '1', vod_name: '我的英雄学院 第4季' }, { vod_id: '2', vod_name: '刀使巫女' }],
    );
    assert.equal(total, 1, '返回值应为过滤后的条数');
    // 分组头计数只算过滤后
    const head = h.ops.append.find(([, html]) => html.includes('src-group'));
    assert.ok(head, '应追加了分组头');
    assert.match(head[1], /src-count">1</, '分组计数应为 1，而非原始 2');
    // 来源筛选标签同样只算过滤后
    const tab = h.ops.append.find(([, html]) => html.includes('class-tab') && html.includes('源A'));
    assert.ok(tab);
    assert.match(tab[1], /源A（1）/);
    // 网格只渲染未命中卡片
    const grid = h.ops.html.find(([sel]) => sel.endsWith('-grid'));
    assert.ok(grid);
    assert.match(grid[1], /刀使巫女/);
    assert.doesNotMatch(grid[1], /我的英雄学院/);
});

test('search.js renderGroup：整组被屏蔽干净时不渲染分组、返回 0（该源按无结果处理）', async () => {
    const h = loadSearchWithBlock({ blockWords: ['我的英雄学院'] });
    await h.blk.loadBlockWords();
    const page = h.create(CFG);
    page._inited = true;
    const total = page.renderGroup(
        { source: 'srcA', name: '源A' },
        [{ vod_id: '1', vod_name: '我的英雄学院 第4季' }, { vod_id: '2', vod_name: '我的英雄学院' }],
    );
    assert.equal(total, 0);
    assert.equal(h.ops.append.filter(([, html]) => html.includes('src-group')).length, 0, '不应出分组卡');
    assert.equal(h.ops.append.filter(([, html]) => html.includes('class-tab')).length, 0, '不应出来源标签');
});

test('search.js renderGroup：Kazumi 结果按 name 字段屏蔽（与 CatVod 的 vod_name 两种口径都生效）', async () => {
    const h = loadSearchWithBlock({ blockWords: ['我的英雄学院'] });
    await h.blk.loadBlockWords();
    const page = h.create(CFG);
    page._inited = true;
    const total = page.renderGroup(
        { source: 'kazumi:规则A', name: '规则A' },
        [{ src: 'u1', name: '我的英雄学院 第4季' }, { src: 'u2', name: '进击的巨人' }],
    );
    assert.equal(total, 1);
    const grid = h.ops.html.find(([sel]) => sel.endsWith('-grid'));
    assert.match(grid[1], /进击的巨人/);
    assert.doesNotMatch(grid[1], /我的英雄学院/);
});

test('search.js：无屏蔽词时行为完全不变（空词表零副作用）', async () => {
    const h = loadSearchWithBlock({ blockWords: [] });
    await h.blk.loadBlockWords();
    const page = h.create(CFG);
    page._inited = true;
    const total = page.renderGroup(
        { source: 'srcA', name: '源A' },
        [{ vod_id: '1', vod_name: '我的英雄学院' }, { vod_id: '2', vod_name: '刀使巫女' }],
    );
    assert.equal(total, 2);
    const head = h.ops.append.find(([, html]) => html.includes('src-group'));
    assert.match(head[1], /src-count">2</);
});

test('search.js：总开关关闭时屏蔽停用，被屏蔽项恢复出现', async () => {
    const h = loadSearchWithBlock({ blockWords: ['我的英雄学院'], blockWordsEnable: false });
    await h.blk.loadBlockWords();
    const page = h.create(CFG);
    page._inited = true;
    const total = page.renderGroup(
        { source: 'srcA', name: '源A' },
        [{ vod_id: '1', vod_name: '我的英雄学院' }, { vod_id: '2', vod_name: '刀使巫女' }],
    );
    assert.equal(total, 2, '开关关闭：两项都应保留');
});

// ---------------------------------------------------------------- timeline.js：_applyFilters

test('timeline.js _applyFilters：屏蔽先于收藏过滤，命中项不进入当日列表', async () => {
    const src = read('src/renderer/js/timeline.js');
    const context = {
        console, JSON, Math, Object, Array, String, Promise, Set, Map,
        $: () => ({ on() { return this; }, empty() { return this; }, html() { return this; }, text() { return this; }, find() { return this; }, each() {}, val() { return ''; }, append() { return this; }, show() { return this; }, hide() { return this; }, addClass() { return this; }, removeClass() { return this; }, toggleClass() { return this; }, attr() { return this; } }),
        doAction: async () => ({ items: [] }),
        escHtml: (s) => String(s),
        warnToast: () => {}, showLoading: () => {}, hideLoading: () => {},
        renderPagerBox: () => {}, pageSizeOf: async () => 20,
        bangumiCard: () => '<div class="bangumi-card"></div>',
        bangumiNetGuide: () => '<div class="tip-line">guide</div>',
        fitVodTitles: () => {},
        Kazumi: {}, FavHub: { onChanged: () => () => {} },
        UIState: { get: () => null, set: () => {} },
        recGet: async () => undefined,
    };
    engineDeps(context);
    context.window = { yuki: { settingsGet: async () => ({ blockWords: ['我的英雄学院'] }) } };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${blockEngineSrc()}
${src}
;globalThis.__T = Timeline; globalThis.__blk = { loadBlockWords, filterBlocked };`, context, { filename: 'timeline.js' });
    const T = context.__T;
    await context.__blk.loadBlockWords();

    const items = [
        { id: '1', name_cn: '我的英雄学院' },
        { id: '2', name_cn: '刀使巫女' },
        { id: '3', name: '我的英雄学院 第4季' },
    ];
    // 收藏过滤关闭态（_colAvailable=false）：只走屏蔽
    T._colAvailable = false;
    const out = T._applyFilters(items);
    assert.deepEqual(Array.from(out).map((x) => x.id), ['2']);
    // 原始数据未被改动：删词后可恢复显示
    assert.equal(items.length, 3);
});

// ---------------------------------------------------------------- bangumi-search.js：_renderGrid

test('bangumi-search.js _renderGrid：渲染前过滤，_items 原始数据保留', async () => {
    const ops = [];
    const context = {
        console, JSON, Math, Object, Array, String, Promise, Set, Map,
        $: (sel) => ({
            _sel: String(sel),
            on() { return this; }, empty() { return this; }, text() { return this; },
            html(h) { ops.push([String(sel), h]); return this; },
            find(s) { return this; }, each() {}, val() { return ''; },
            append() { return this; }, show() { return this; }, hide() { return this; },
            addClass() { return this; }, removeClass() { return this; },
            get length() { return 0; },
        }),
        doAction: async () => ({ items: [] }),
        escHtml: (s) => String(s),
        warnToast: () => {}, showLoading: () => {}, hideLoading: () => {},
        renderPagerBox: () => {}, pageSizeOf: async () => 20,
        bangumiCard: (it) => `<div class="bangumi-card" data-name="${it.name_cn || it.name}"></div>`,
        fitVodTitles: () => {},
        FavHub: { onChanged: () => () => {} },
        App: {}, Timeline: undefined, DetailSnap: {}, Home: {},
    };
    engineDeps(context);
    context.window = { yuki: { settingsGet: async () => ({ blockWords: ['我的英雄学院'] }) } };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${blockEngineSrc()}
${read('src/renderer/js/bangumi-search.js')}
;globalThis.__B = BangumiSearch; globalThis.__blk = { loadBlockWords };`, context, { filename: 'bangumi-search.js' });
    const B = context.__B;
    await context.__blk.loadBlockWords();
    B._items = [{ id: '1', name_cn: '我的英雄学院' }, { id: '2', name_cn: '刀使巫女' }];
    B._inited = true;
    B._renderGrid();
    const html = (ops.find(([, h]) => typeof h === 'string' && h.includes('bangumi-card')) || [])[1] || '';
    assert.match(html, /刀使巫女/);
    assert.doesNotMatch(html, /我的英雄学院/);
    assert.equal(B._items.length, 2, '_items 原始数据保留（删屏蔽词后可恢复）');
    assert.deepEqual(Array.from(B._shown).map((x) => x.id), ['2']);
});

// ---------------------------------------------------------------- popular.js：_renderGrid

test('popular.js _renderGrid：渲染前过滤，徽章按过滤后的条目挂（不错位）', async () => {
    const ops = [];
    const badgeItems = [];
    const context = {
        console, JSON, Math, Object, Array, String, Promise, Set, Map,
        $: (sel) => ({
            _sel: String(sel),
            on() { return this; }, empty() { return this; }, text() { return this; },
            html(h) { ops.push([String(sel), h]); return this; },
            find(s) { return this; }, each() {}, val() { return ''; },
            append() { return this; }, show() { return this; }, hide() { return this; },
            addClass() { return this; }, removeClass() { return this; },
            get length() { return 0; },
        }),
        doAction: async () => ({ trends: [] }),
        escHtml: (s) => String(s),
        warnToast: () => {}, showLoading: () => {}, hideLoading: () => {},
        renderPagerBox: () => {}, pageSizeOf: async () => 20,
        bangumiCard: (it) => `<div class="bangumi-card" data-name="${it.name_cn || it.name}"></div>`,
        bangumiNetGuide: () => '<div class="tip-line">guide</div>',
        fitVodTitles: () => {}, playCardsEnter: () => {},
        recGet: async () => [],
        FavHub: { onChanged: () => () => {} },
        Timeline: {
            _attachFavBadges: (grid, items) => { badgeItems.push(items); },
            _attachEpBadges: async () => {},
        },
        DetailSnap: {}, Home: {},
    };
    engineDeps(context);
    context.window = { yuki: { settingsGet: async () => ({ blockWords: ['我的英雄学院'] }) } };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${blockEngineSrc()}
${read('src/renderer/js/popular.js')}
;globalThis.__P = Popular; globalThis.__blk = { loadBlockWords };`, context, { filename: 'popular.js' });
    const P = context.__P;
    await context.__blk.loadBlockWords();
    P._items = [{ id: '1', name_cn: '我的英雄学院' }, { id: '2', name_cn: '刀使巫女' }];
    P._inited = true;
    P._renderGrid();
    const html = (ops.find(([, h]) => typeof h === 'string' && h.includes('bangumi-card')) || [])[1] || '';
    assert.match(html, /刀使巫女/);
    assert.doesNotMatch(html, /我的英雄学院/);
    assert.equal(P._items.length, 2, '原始数据保留');
    // 徽章管线拿到的是过滤后的条目（否则徽标会挂到错位的卡片上）
    assert.deepEqual(Array.from(badgeItems[0]).map((x) => x.id), ['2']);
});

// ---------------------------------------------------------------- 设置页契约（静态）

test('设置页：屏蔽分类与控件齐备，且屏蔽键已进主进程写入白名单', () => {
    const html = read('src/renderer/index.html');
    for (const id of ['set_block_words_enable', 'block_word_input', 'block_word_add', 'block_word_clear', 'block_word_list', 'block_word_count']) {
        assert.match(html, new RegExp(`id="${id}"`), `缺少控件 #${id}`);
    }
    assert.match(html, /data-cat="block"/, '缺少「屏蔽过滤」一级分类');
    assert.match(html, /data-setcat="block"/, '缺少屏蔽分类的详情卡片');
    // 主进程白名单：缺了设置页写入会被静默 ignored（H-1 同型坑）
    const main = read('src/main/index.js');
    assert.match(main, /SETTINGS_SET_ALLOWED[\s\S]*?'blockWords', 'blockWordsEnable',/);
});
