/**
 * 白盒单元测试：src/renderer/js/search.js
 *
 * 渲染层脚本不是 CommonJS（<script> 顺序加载共享全局作用域），因此沿用
 * tests/js/records.test.js 的做法：fs.readFileSync + node:vm，在注入全局桩的
 * 上下文里执行源码，再从 globalThis 取出 createSearchPage / Search 直接驱动。
 *
 * 覆盖目标：
 *   - createSearchPage(cfg) 返回对象的方法与状态字段（门面契约）
 *   - 搜索请求参数：关键词 trim、空关键词不放行、URL 编码、每页条数取 pageSizeSearch
 *   - SSE 结果渲染 / 空态 / 失败态
 *   - 重复搜索的去重与取消（旧连接关闭 + 令牌丢弃旧词在途结果）
 *   - 来源筛选（全部视图限显 / 单源视图分页）与再次搜索的状态复位
 *   - 渲染转义（源名/片名/关键词含 HTML 不注入）
 *
 * 与 tests/js/search-tabs.test.js 的分工：那个文件管「双页签 DOM 互斥与状态隔离」，
 * 本文件管「单个控制器内部的行为契约」，互不重复。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SEARCH_SRC = path.join(__dirname, '../../src/renderer/js/search.js');

/** 与 common.js escHtml 同实现的转义桩（H-6：含单引号）。 */
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 记录型 jQuery 桩：按选择器登记事件处理器、操作流水与 val 值。
 * 不触碰真实 DOM，所有 append/html 内容留档供断言。
 */
function makeJQueryStub() {
    const reg = new Map();
    const values = new Map();
    const rec = (sel) => {
        let r = reg.get(sel);
        if (!r) { r = { handlers: {}, ops: [], data: {}, eachItems: [], gtoggles: [] }; reg.set(sel, r); }
        return r;
    };
    /** 从写入的 HTML 里识别 .src-group（供 each 遍历用）。 */
    const noteGroups = (sel, html) => {
        if (typeof html !== 'string') return;
        const target = rec(sel + ' .src-group');
        const re = /<div class="src-group" data-source="([^"]*)"/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            const src = m[1];
            const r = target;
            target.eachItems.push({
                data: (k) => (k === 'source' ? src : undefined),
                toggle: (f) => { r.gtoggles.push([src, !!f]); },
                addClass() { return this; },
                removeClass() { return this; },
            });
        }
    };
    class W {
        constructor(sel) { this.sel = String(sel); this.length = 1; }
        on(ev, a, b) {
            const r = rec(this.sel);
            const fn = typeof a === 'function' ? a : b;
            (r.handlers[ev] = r.handlers[ev] || []).push({ delegate: typeof a === 'string' ? a : null, fn });
            return this;
        }
        off() { return this; }
        addClass() { return this; }
        removeClass() { return this; }
        toggleClass() { return this; }
        toggle(f) { rec(this.sel).ops.push(['toggle', !!f]); return this; }
        show() { return this.toggle(true); }
        hide() { return this.toggle(false); }
        text(t) { rec(this.sel).ops.push(['text', t]); return this; }
        html(h) { rec(this.sel).ops.push(['html', h]); noteGroups(this.sel, h); return this; }
        empty() { rec(this.sel).ops.push(['empty']); return this; }
        val(v) {
            if (v === undefined) return values.has(this.sel) ? values.get(this.sel) : '';
            values.set(this.sel, v);
            rec(this.sel).ops.push(['val', v]);
            return this;
        }
        append(h) { rec(this.sel).ops.push(['append', h]); noteGroups(this.sel, h); return this; }
        appendTo() { return this; }
        find(sel) { return new W(`${this.sel}>>${sel}`); }
        children() { const w = new W(`${this.sel}>>children`); w.length = 0; return w; }
        last() { return this; }
        each(cb) { (rec(this.sel).eachItems || []).forEach((it, i) => cb.call(it, i, it)); return this; }
        scrollTop() { return this; }
        prop() { return this; }
        css() { return this; }
        data(k) { return rec(this.sel).data[k]; }
        trigger(ev) {
            (rec(this.sel).handlers[ev] || []).forEach((h) => h.fn.call({}, { currentTarget: {} }));
            return this;
        }
    }
    const $ = (sel) => ((sel && typeof sel === 'object') ? sel : new W(sel));
    $.setVal = (sel, v) => { values.set(sel, v); };
    $.fire = (sel, ev, evt) => {
        const r = reg.get(sel);
        assert.ok(r && r.handlers[ev], `应已绑定 ${sel} 的 ${ev} 处理器`);
        r.handlers[ev].forEach((h) => h.fn.call({}, evt));
    };
    $.opsOf = (sel) => rec(sel).ops;
    $.lastToggle = (sel) => {
        const ts = rec(sel).ops.filter((o) => o[0] === 'toggle');
        return ts.length ? ts[ts.length - 1][1] : null;
    };
    $.lastHtml = (sel) => {
        const hs = rec(sel).ops.filter((o) => o[0] === 'html');
        return hs.length ? hs[hs.length - 1][1] : null;
    };
    $.allHtml = (sel) => rec(sel).ops.filter((o) => o[0] === 'append' || o[0] === 'html').map((o) => o[1]).join('\n');
    $.groupToggles = (sel) => rec(sel).gtoggles.slice();
    return $;
}

/**
 * 在 VM 中加载 search.js。
 * opts: { pageSize, kazumi, uiEnabled }
 * 返回 { $, Search, create, es, apiUrls, toasts, status, pager, ... }
 */
function loadSearch(opts) {
    const o = opts || {};
    const $ = makeJQueryStub();
    const esList = [];
    const state = {
        $, es: esList, apiUrls: [], toasts: [], status: [], pager: [], covers: [],
        pageSizeKeys: [], cacheSets: [], uiSets: [], kazumiWords: [], captcha: [],
    };

    /** SSE 桩：记录 URL、监听器与 close，测试可主动 emit 消息/完成/错误。 */
    class EventSourceStub {
        constructor(url) {
            this.url = url;
            this.closed = false;
            this.listeners = {};
            this.onmessage = null;
            this.onerror = null;
            esList.push(this);
        }
        addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
        close() { this.closed = true; }
        emit(name, ev) { (this.listeners[name] || []).slice().forEach((f) => f(ev || {})); }
        message(data) { if (this.onmessage) this.onmessage({ data: JSON.stringify(data) }); }
    }

    const uiStore = {};
    const kazumiDeferred = [];
    const kazumi = o.kazumi ? {
        _rules: [],
        hasEnabledRules: () => true,
        aggregateSearch: (word) => {
            state.kazumiWords.push(word);
            let resolve;
            const p = new Promise((r) => { resolve = r; });
            kazumiDeferred.push({ word, resolve });
            return p;
        },
    } : undefined;

    const context = {
        console, setTimeout, clearTimeout, encodeURIComponent, JSON, Math, Object, Array, String, Promise,
        EventSource: EventSourceStub,
        CSS: { escape: (s) => String(s) },
        $,
        escHtml,
        warnToast: (t) => { state.toasts.push(String(t)); },
        showLoading: () => {}, hideLoading: () => {},
        apiUrl: (u) => { state.apiUrls.push(u); return u; },
        pageSizeOf: async (key) => { state.pageSizeKeys.push(key); return o.pageSize || 20; },
        renderStatusBar: (el, o2) => { state.status.push(o2 || {}); return el; },
        renderPagerBox: (box, po) => {
            state.pager.push({ sel: box && box.sel, page: po.page, pagecount: po.pagecount, onJump: po.onJump });
        },
        vodCard: (v, src, eager) => `<div class="vod-card" data-id="${escHtml(v.vod_id)}" data-name="${escHtml(v.vod_name || '')}"${src != null ? ` data-source="${escHtml(src)}"` : ''} tabindex="0">
        <div class="vod-cover">${v.vod_pic || ''}</div>
        <div class="vod-name" title="${escHtml(v.vod_name || '')}">${escHtml(String(v.vod_name || '').slice(0, 60))}</div>
        <div class="vod-remarks">${escHtml(v.vod_remarks || '')}</div>
    </div>`,
        vodCoverImg: () => '<img class="cover">',
        vodCoverChain: () => '',
        bangumiCover: () => '',
        bangumiCoverImg: (c) => `<img src="${c}">`,
        truncateTitle: (s) => String(s || '').slice(0, 60),
        getCachedCover: () => '',
        fillMissingCovers: (sel) => { state.covers.push(sel); },
        abortCoverFill: () => {},
        fitVodTitles: () => {},
        playCardsEnter: () => {},
        errorTextOf: (e) => String(e),
        Detail: { open: (src, id, name) => { state.captcha.push(['detail', src, id, name]); } },
        UIState: {
            isEnabled: () => o.uiEnabled !== false,
            get: (k) => uiStore[k],
            set: (k, v) => { uiStore[k] = JSON.parse(JSON.stringify(v)); state.uiSets.push(k); },
        },
        localCacheGet: () => null,
        localCacheSet: (k, v) => { state.cacheSets.push({ key: k, value: v }); },
    };
    if (kazumi) context.Kazumi = kazumi;
    vm.createContext(context);
    vm.runInContext(`${fs.readFileSync(SEARCH_SRC, 'utf8')}\n;globalThis.__create = createSearchPage; globalThis.__Search = Search;`,
        context, { filename: 'search.js' });
    state.create = context.__create;
    state.Search = context.__Search;
    state.uiStore = uiStore;
    state.kazumiDeferred = kazumiDeferred;
    return state;
}

/** 取得已初始化的聚合页控制器（并设置搜索框关键词）。 */
function aggPage(h, word) {
    h.Search.init();
    if (word !== undefined) h.$.setVal('#search-keyword', word);
    return h.Search.agg;
}

const mkItems = (n, p) => Array.from({ length: n }, (_, i) => ({
    vod_id: `${p}${i + 1}`, vod_name: `${p}片${i + 1}`, vod_remarks: '完结',
}));

const tabEl = (src) => ({
    data: (k) => (k === 'src' ? src : undefined),
    addClass() { return this; },
    removeClass() { return this; },
});

const flush = () => new Promise((r) => setImmediate(r));

const CFG = {
    mode: 'aggregate', stab: 'aggregate', gidPrefix: 'ag-sg',
    keywordSel: '#kw', goSel: '#go', filtersSel: '#ft', statusSel: '#st', resultsSel: '#rs',
};

// ---------------------------------------------------------------- 工厂契约

test('createSearchPage：返回对象必备方法与状态字段齐全（app.js 门面契约）', () => {
    const { create } = loadSearch();
    const page = create(CFG);
    const methods = ['init', 'stop', 'run', 'renderGroup', '_paintGrp', '_fillAllCovers',
        '_runKazumi', '_renderKazumiCaptcha', '_saveWord', '_saveSnapshot',
        '_restoreSnapshotOnce', 'onViewShown', '_setStatus', '_bindResultCardClick', '_bindSrcFilterTabs'];
    for (const m of methods) assert.equal(typeof page[m], 'function', `缺少方法 ${m}`);
    assert.equal(page.cfg.mode, 'aggregate', 'cfg 应原样保留');
    assert.equal(page.es, null, '初始无在途连接');
    assert.equal(page._inited, false);
    assert.equal(page._searchToken, 0);
    assert.equal(page._curSrc, '', '初始为「全部」视图');
    assert.equal(page._size, 0);
    assert.equal(Object.keys(page._grpLists).length, 0);
    assert.equal(Object.keys(page._grpRendered).length, 0);
});

test('createSearchPage：两实例 cfg 互不共享（聚合/Kazumi 双页签基础）', () => {
    const { create } = loadSearch();
    const a = create(CFG);
    const b = create({ ...CFG, mode: 'kazumi', gidPrefix: 'km-sg' });
    assert.notEqual(a._grpLists, b._grpLists);
    assert.equal(a.cfg.gidPrefix, 'ag-sg');
    assert.equal(b.cfg.gidPrefix, 'km-sg');
    a.renderGroup({ source: 's', name: 'S' }, mkItems(1, 'x'));
    assert.equal(Object.keys(a._grpLists).length, 1);
    assert.equal(Object.keys(b._grpLists).length, 0, '另一个实例不应受影响');
});

// ---------------------------------------------------------------- 请求参数

test('空关键词（含纯空白）不放行：不发请求、不建流、提示「请输入关键字」', async () => {
    const h = loadSearch();
    const page = aggPage(h, '   \t ');
    await page.run();
    assert.deepEqual(h.apiUrls, [], '不应拼接搜索 URL');
    assert.equal(h.es.length, 0, '不应创建 SSE 连接');
    assert.deepEqual(h.toasts, ['请输入关键字']);
});

test('关键词首尾空白被 trim 后再拼请求 URL（含 & 等特殊字符走 encodeURIComponent）', async () => {
    const h = loadSearch();
    const page = aggPage(h, '  进击 的巨人&x  ');
    await page.run();
    assert.equal(h.apiUrls.length, 1);
    assert.equal(h.apiUrls[0], '/search/stream?word=' + encodeURIComponent('进击 的巨人&x'));
    assert.equal(h.es[0].url, h.apiUrls[0], 'SSE 地址应取自 apiUrl 返回值');
});

test('每页条数取自 pageSizeSearch 设置（T39：搜索页单独设置而非全局值）', async () => {
    const h = loadSearch({ pageSize: 10 });
    const page = aggPage(h, '甲');
    await page.run();
    assert.deepEqual(h.pageSizeKeys, ['pageSizeSearch']);
    assert.equal(page._size, 10);
    // 25 条结果在「全部」视图只渲染前 10 条
    page.renderGroup({ source: 'srcA', name: '源A' }, mkItems(25, 'A'));
    const grid = h.$.allHtml('#ag-sg0-grid');
    assert.equal((grid.match(/class="vod-card"/g) || []).length, 10);
});

test('关键词持久化到 UIState 的按页签 words（切页/重启回填搜索框）', async () => {
    const h = loadSearch();
    const page = aggPage(h, '  持久化词  ');
    await page.run();
    assert.equal(h.uiStore.search.words.aggregate, '持久化词', '应存 trim 后的词');
});

// ---------------------------------------------------------------- 渲染 / 分页

test('全部视图：每组限显每页条数并给出「仅显示前 N 条」提示，不出分页器', () => {
    const h = loadSearch({ pageSize: 2 });
    const page = aggPage(h);
    page._size = 2;
    page.renderGroup({ source: 'srcA', name: '源A' }, mkItems(5, 'A'));
    const grid = h.$.allHtml('#ag-sg0-grid');
    assert.equal((grid.match(/class="vod-card"/g) || []).length, 2, '只渲染前 2 条');
    assert.ok(grid.includes('A片1') && grid.includes('A片2'));
    assert.ok(!grid.includes('A片3'), '第 3 条不应进入 DOM');
    const hintOps = h.$.opsOf('#ag-sg0-hint');
    assert.deepEqual(hintOps[0], ['text', '仅显示前 2 条 · 点上方来源标签分页看全部']);
    assert.deepEqual(hintOps[1], ['toggle', true], '超出每页条数时提示可见');
    assert.equal(h.pager[h.pager.length - 1].pagecount, 1, '全部视图不出分页器');
    assert.equal(page._grpRendered['ag-sg0'].mode, 'all');
});

test('来源筛选：点单源标签只保留该源分组，并为该源启用分页（其他源不重绘）', () => {
    const h = loadSearch({ pageSize: 2 });
    const page = aggPage(h);
    page._size = 2;
    page.renderGroup({ source: 'srcA', name: '源A' }, mkItems(5, 'A'));
    page.renderGroup({ source: 'srcB', name: '源B' }, mkItems(3, 'B'));
    assert.deepEqual(h.pager.map((p) => p.pagecount), [1, 1], '全部视图两组都不出分页器');

    h.$.fire('#search-filters', 'click', { currentTarget: tabEl('srcA') });
    assert.equal(page._curSrc, 'srcA');
    assert.deepEqual(h.$.groupToggles('#search-results .src-group'),
        [['srcA', true], ['srcB', false]], '只保留 srcA 可见');
    assert.equal(page._grpRendered['ag-sg0'].mode, 'single', 'srcA 重绘为单源模式');
    assert.equal(page._grpRendered['ag-sg1'].mode, 'all', '隐藏组不重绘');
    const last = h.pager[h.pager.length - 1];
    assert.equal(last.sel, '#ag-sg0-pager', '只给可见源装分页器');
    assert.equal(last.pagecount, 3, '5 条 / 每页 2 条 = 3 页');
});

test('单源视图翻页：按每页条数切片渲染目标页并回写页码', () => {
    const h = loadSearch({ pageSize: 2 });
    const page = aggPage(h);
    page._size = 2;
    page.renderGroup({ source: 'srcA', name: '源A' }, mkItems(5, 'A'));
    page._curSrc = 'srcA';
    page._paintGrp('ag-sg0', 2);
    const grid = h.$.lastHtml('#ag-sg0-grid');
    assert.ok(grid.includes('A片3') && grid.includes('A片4'), '第 2 页应为第 3、4 条');
    assert.ok(!grid.includes('A片1') && !grid.includes('A片5'));
    assert.deepEqual(page._grpRendered['ag-sg0'].mode, 'single');
    assert.equal(page._grpRendered['ag-sg0'].page, 2);
    const last = h.pager[h.pager.length - 1];
    assert.equal(last.page, 2);
    assert.equal(last.pagecount, 3);
});

// ---------------------------------------------------------------- 空态 / 失败态

test('结果为空：SSE done 后渲染「无结果」空态并收尾进度', async () => {
    const h = loadSearch();
    const page = aggPage(h, '无此片');
    await page.run();
    // 先来一个「有响应但无结果」的源（recv>0 → 进度条已显示），再收 done
    h.es[0].message({ source: 'srcA', name: '源A', list: [] });
    assert.equal(page._statusShown, true, '有首个源响应后进度条应已显示');
    h.es[0].emit('done');
    assert.ok(h.$.allHtml('#search-results').includes('<div class="tip-line">无结果</div>'));
    const done = h.status.filter((s) => s.done === true);
    assert.equal(done.length, 1, '应给出一次完成态进度');
    assert.equal(done[0].items, 0, '完成态计数为 0 条结果');
    assert.equal(page.es, null, '完成后连接应释放');
});

test('快速搜索（无结果到达）不闪现完成态：done 时不渲染状态条只置空态', async () => {
    const h = loadSearch();
    const page = aggPage(h, '无此片');
    await page.run();
    assert.equal(page._statusShown, false, '尚无结果时进度条保持隐藏');
    assert.ok(page._statusTimer, 'recv=0 时排 1s 延迟显示定时器');
    assert.equal(h.status.length, 0, '发起阶段不立即渲染状态条');
    h.es[0].emit('done');
    assert.equal(page._statusShown, false, '未显示过的进度条不闪现完成态');
    assert.equal(h.status.length, 0, '快速搜索不渲染完成态');
    assert.equal(h.$.lastToggle('#search-status'), false, '状态条保持隐藏');
    assert.ok(h.$.allHtml('#search-results').includes('无结果'));
});

test('空结果源不生成分组与来源标签（T60：无结果的源不占位）', () => {
    const h = loadSearch();
    const page = aggPage(h);
    page.renderGroup({ source: 'emptySrc', name: '空源' }, []);
    assert.equal(Object.keys(page._grpLists).length, 0, '空源不进分组表');
    assert.equal(h.$.allHtml('#search-filters'), '', '空源不生成筛选标签');
    assert.ok(!h.$.allHtml('#search-results').includes('空源'));
});

test('请求失败（SSE error 且无任何结果）：提示搜寻失败且未显示过进度条时不闪现完成态', async () => {
    const h = loadSearch();
    const page = aggPage(h, '甲');
    await page.run();
    h.es[0].onerror();
    assert.deepEqual(h.toasts, ['搜寻失败']);
    assert.equal(h.$.lastToggle('#search-status'), false, '从未显示过进度条则不闪现状态条');
    assert.equal(page.es, null, '失败后连接应释放');
});

test('部分结果后失败：视为正常结束（已有结果不被清空）', async () => {
    const h = loadSearch();
    const page = aggPage(h, '甲');
    await page.run();
    h.es[0].message({ source: 'srcA', name: '源A', list: mkItems(2, 'A') });
    h.es[0].onerror();
    assert.deepEqual(h.toasts, [], '有结果时不报失败');
    assert.ok(h.$.allHtml('#search-results').includes('源A'), '已渲染结果保留');
});

// ---------------------------------------------------------------- 重复搜索的去重 / 取消

test('重复搜索：新搜索发起时关闭上一条 SSE 连接（旧流不再叠加渲染）', async () => {
    const h = loadSearch();
    const page = aggPage(h, '甲');
    await page.run();
    const es1 = h.es[0];
    h.$.setVal('#search-keyword', '乙');
    await page.run();
    const es2 = h.es[1];
    assert.equal(es1.closed, true, '旧连接必须被 close');
    assert.equal(page.es, es2, '当前连接指向新搜索');
    assert.equal(page._searchToken, 2, '令牌随每次搜索自增');
    assert.equal(h.apiUrls.length, 2);
});

test('重复搜索：旧搜索在途的 Kazumi 结果被令牌丢弃，不混入新结果页（M-30a）', async () => {
    const h = loadSearch({ kazumi: true });
    const page = aggPage(h, '甲');
    await page.run();
    h.$.setVal('#search-keyword', '乙');
    await page.run();
    assert.deepEqual(h.kazumiWords, ['甲', '乙']);

    // 旧词「甲」的在途结果迟到
    h.kazumiDeferred[0].resolve([{ pluginName: '旧源', data: [{ name: '旧词结果', src: 'u1' }] }]);
    await flush();
    assert.equal(Object.keys(page._grpLists).length, 0, '旧词结果不得混入');

    // 新词「乙」的结果正常渲染（卡片写入本分组网格 #ag-sg0-grid）
    h.kazumiDeferred[1].resolve([{ pluginName: '新源', data: [{ name: '新词结果', src: 'u2' }] }]);
    await flush();
    assert.equal(Object.keys(page._grpLists).length, 1);
    const grid = h.$.allHtml('#ag-sg0-grid');
    assert.ok(grid.includes('新词结果'), '新词结果应渲染');
    assert.ok(!grid.includes('旧词结果'));
});

test('再次搜索：来源筛选栏与分组状态整体复位（_curSrc/分组表/筛选标签/序号）', async () => {
    const h = loadSearch();
    const page = aggPage(h, '甲');
    page.renderGroup({ source: 'srcA', name: '源A' }, mkItems(2, 'A'));
    page._curSrc = 'srcA';
    assert.equal(Object.keys(page._grpLists).length, 1);

    await page.run();
    assert.equal(page._curSrc, '', '筛选源归零回「全部」');
    assert.equal(Object.keys(page._grpLists).length, 0, '分组数据清空');
    assert.equal(Object.keys(page._grpRendered).length, 0, '分组渲染态清空');
    assert.equal(page._grpSeq, 0, '分组序号归零');
    assert.equal(h.$.lastHtml('#search-filters'), '<span class="class-tab active" data-src="">全部</span>');
});

// ---------------------------------------------------------------- 转义

test('渲染转义：源名/片名含 HTML 不注入 DOM，卡片属性全部走 escHtml', () => {
    const h = loadSearch();
    const page = aggPage(h);
    page.renderGroup({ source: 'src"><img src=x onerror=alert(1)>', name: '<img src=x onerror=alert(1)>' },
        [{ vod_id: '1" onerror="alert(2)', vod_name: '<script>alert(3)</script>' }]);
    // 卡片写入本分组网格（#ag-sg0-grid），分组头/筛选标签写入结果容器与筛选栏
    const all = h.$.allHtml('#search-results') + h.$.allHtml('#search-filters') + h.$.allHtml('#ag-sg0-grid');
    assert.ok(!/<script>alert\(3\)<\/script>/.test(all), '片名必须转义');
    assert.ok(!/<img src=x/.test(all), '源名不得产出可执行标签');
    assert.ok(all.includes('&lt;script&gt;alert(3)&lt;/script&gt;'), '应产出实体化文本');
    assert.ok(all.includes('&lt;img src=x onerror=alert(1)&gt;'), '源名应实体化');
    assert.ok(!all.includes('1" onerror="alert(2)'), 'data-id 属性内的引号必须转义');
    assert.ok(all.includes('data-id="1&quot; onerror=&quot;alert(2)"'));
});

test('渲染转义：含 HTML 的关键词只进 URL 编码，不进 DOM', async () => {
    const h = loadSearch();
    const page = aggPage(h, '<img src=x onerror=alert(1)>');
    await page.run();
    assert.equal(h.apiUrls[0], '/search/stream?word=' + encodeURIComponent('<img src=x onerror=alert(1)>'));
    assert.ok(!h.apiUrls[0].includes('<img'), 'URL 内尖括号应被编码');
    const dom = h.$.allHtml('#search-results');
    assert.ok(!/<img src=x/.test(dom), '结果容器不应出现未转义关键词');
});

// ---------------------------------------------------------------- 快照 / 生命周期

test('结果快照落盘：只收录有结果的分组，条目按上限截断，键按 mode 区分', () => {
    const h = loadSearch();
    const page = aggPage(h);
    page.renderGroup({ source: 'srcA', name: '源A' }, mkItems(250, 'A'));
    page.renderGroup({ source: 'srcB', name: '源B' }, []);   // 空组不收录
    page._grpLists['ag-sg9'] = { src: 'srcEmpty', list: [], name: '空' };
    page._saveSnapshot();
    assert.equal(h.cacheSets.length, 1);
    assert.equal(h.cacheSets[0].key, 'search::snap::aggregate');
    assert.equal(h.cacheSets[0].value.groups.length, 1, '空组不收录');
    assert.equal(h.cacheSets[0].value.groups[0].list.length, 200, '每组条目按上限截断');
    assert.equal(h.cacheSets[0].value.groups[0].name, '源A', '分组名一并落盘供还原');
});

test('结果快照：页面状态总开关关闭时不写盘', () => {
    const h = loadSearch({ uiEnabled: false });
    const page = aggPage(h);
    page.renderGroup({ source: 'srcA', name: '源A' }, mkItems(2, 'A'));
    page._saveSnapshot();
    assert.deepEqual(h.cacheSets, [], '开关关闭不应落盘');
});

test('Search.stop：关闭各页签在途连接并隐藏各自进度条', async () => {
    const h = loadSearch();
    h.Search.init();
    h.$.setVal('#search-keyword', '甲');
    await h.Search.agg.run();
    assert.equal(h.es.length, 1);
    h.Search.stop();
    assert.equal(h.es[0].closed, true, '在途连接应关闭');
    assert.equal(h.Search.agg.es, null);
    assert.equal(h.Search.kz.es, null);
    assert.equal(h.$.lastToggle('#search-status'), false);
    assert.equal(h.$.lastToggle('#kazumi-search-status'), false);
    assert.equal(h.Search.agg._statusShown, false, '进度条状态位复位');
    assert.equal(h.Search.agg._lastStatus, null);
});

test('Kazumi 页签：未启用规则时提示「Kazumi 引擎不可用」且不建流', async () => {
    const h = loadSearch();   // 上下文无 Kazumi 全局
    h.Search.init();
    h.$.setVal('#kazumi-search-keyword', '甲');
    await h.Search.kz.run();
    assert.equal(h.es.length, 0, '引擎不可用不应创建 SSE');
    assert.equal(h.$.lastToggle('#kazumi-search-status'), false);
    assert.equal(Object.keys(h.Search.kz._grpLists).length, 0);
    // M21 修复钉：之前 _setStatus done 分支在 _statusShown=false 时只 el.hide()，
    // 用户实际收不到任何提示（"Kazumi 引擎不可用"被静默吞掉）。
    // 现已改为 done 分支带 warnText 时走 warnToast，这里断言用户能看到提示。
    assert.deepEqual(h.toasts, ['Kazumi 引擎不可用'],
        '_statusShown=false 时 done 分支也应通过 warnToast 让用户看到提示');
});
