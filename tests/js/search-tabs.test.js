// 单元测试：搜索页「聚合搜索 / Kazumi 源」双页签独立性回归
//
// 背景（bug）：两页签曾共用同一套搜索栏/进度条/来源筛选/结果容器，任一侧搜索
// 都会清空另一侧结果，切页签看到的始终是同一份内容。
// 修复：search.js 重构为 createSearchPage 工厂，聚合/Kazumi 各一实例（独立状态
// 与选择器），index.html 拆分 #aggregate-search-panel / #kazumi-search-panel。
//
// 在 VM 中加载 search.js，注入记录型 jQuery 桩（不触碰真实 DOM/网络）：
//   1. 页签点击后两个面板互斥可见；
//   2. 两实例状态对象相互隔离；
//   3. 各实例渲染写入各自的容器，分组 gid 全局唯一不冲突。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** 构建记录型 jQuery 桩：按选择器登记事件处理器与操作流水。 */
function makeJQueryStub() {
    const reg = new Map();
    const rec = (sel) => {
        let r = reg.get(sel);
        if (!r) { r = { handlers: {}, ops: [], data: {} }; reg.set(sel, r); }
        return r;
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
        toggle(f) { rec(this.sel).ops.push(['toggle', !!f]); return this; }
        show() { return this.toggle(true); }
        hide() { return this.toggle(false); }
        text(t) { rec(this.sel).ops.push(['text', t]); return this; }
        html(h) { rec(this.sel).ops.push(['html', h]); return this; }
        empty() { return this; }
        val(v) {
            if (v === undefined) return '';
            rec(this.sel).ops.push(['val', v]);
            return this;
        }
        append(h) { rec(this.sel).ops.push(['append', h]); return this; }
        appendTo(parent) { rec(String(parent && parent.sel || parent)).ops.push(['append', '<div></div>']); return this; }
        find() { return new W(this.sel + '>>find'); }
        children() { return this; }
        last() { return this; }
        each(cb) { cb.call({}); return this; }
        scrollTop() { return this; }
        prop() { return this; }
        data(k) { return rec(this.sel).data[k]; }
        trigger(ev) {
            const r = rec(this.sel);
            (r.handlers[ev] || []).forEach((h) => h.fn.call({}, { key: '', target: { blur() {} }, currentTarget: {} }));
            return this;
        }
    }
    const $ = (sel) => {
        if (sel && typeof sel === 'object') {
            // 测试自造的伪元素（如页签 currentTarget）：要求自带 data/addClass 方法
            return sel;
        }
        return new W(sel);
    };
    $.registry = reg;
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
    $.allHtml = (sel) => rec(sel).ops.filter((o) => o[0] === 'append' || o[0] === 'html').map((o) => o[1]).join('\n');
    return $;
}

function loadSearchModule($) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/search.js'), 'utf8');
    const context = {
        console,
        setTimeout,
        clearTimeout,
        $,
        escHtml: (s) => String(s),
        warnToast: () => {},
        showLoading: () => {},
        hideLoading: () => {},
        apiUrl: (u) => u,
        pageSizeOf: async () => 20,
        Detail: { open() {} },
        vodCard: () => '<div class="vod-card"></div>',
        vodCoverImg: () => '<div class="placeholder"></div>',
        bangumiCoverImg: () => '<div class="bgm-cover"></div>',
        vodCoverChain: () => '',
        truncateTitle: (s) => s,
        getCachedCover: () => '',
        fillMissingCovers: () => {},
        abortCoverFill: () => {},
        renderPagerBox: () => {},
        renderStatusBar: () => {},
        fitVodTitles: () => {},
        errorTextOf: (e) => String(e),
        doAction: async () => ({}),
    };
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__S = Search;`, context, { filename: 'search.js' });
    return context.__S;
}

test('聚合/Kazumi 页签切换：面板互斥可见且聚焦各自输入框', () => {
    const $ = makeJQueryStub();
    const Search = loadSearchModule($);
    Search.init();

    // 初始为聚合页签
    assert.strictEqual(Search._stab, 'aggregate');

    // 点「Kazumi 源」页签：Kazumi 面板显示、聚合面板隐藏、聚焦 Kazumi 输入框
    $.fire('#search-tabs', 'click', { currentTarget: { data: (k) => (k === 'stab' ? 'kazumi' : undefined), addClass() { return this; }, removeClass() { return this; } } });
    assert.strictEqual(Search._stab, 'kazumi');
    assert.strictEqual($.lastToggle('#kazumi-search-panel'), true);
    assert.strictEqual($.lastToggle('#aggregate-search-panel'), false);
    assert.strictEqual($.lastToggle('#image-search-panel'), false);
    assert.strictEqual($.lastToggle('#bangumi-search-panel'), false);

    // 切回「聚合搜索」：反转
    $.fire('#search-tabs', 'click', { currentTarget: { data: (k) => (k === 'stab' ? 'aggregate' : undefined), addClass() { return this; }, removeClass() { return this; } } });
    assert.strictEqual(Search._stab, 'aggregate');
    assert.strictEqual($.lastToggle('#aggregate-search-panel'), true);
    assert.strictEqual($.lastToggle('#kazumi-search-panel'), false);
});

test('两页签控制器状态隔离，渲染各写各的容器且 gid 不冲突', () => {
    const $ = makeJQueryStub();
    const Search = loadSearchModule($);
    Search.init();

    assert.ok(Search.agg && Search.kz, '应创建聚合与 Kazumi 两个控制器实例');
    assert.notStrictEqual(Search.agg, Search.kz);
    assert.notStrictEqual(Search.agg._grpLists, Search.kz._grpLists, '分组数据必须互不共享');
    assert.notStrictEqual(Search.agg.cfg.resultsSel, Search.kz.cfg.resultsSel, '结果容器选择器必须不同');

    // 聚合侧渲染一个源分组
    Search.agg.renderGroup({ source: 'srcA', name: '源A' }, [{ vod_id: '1', vod_name: '影片甲' }]);
    // Kazumi 侧渲染另一个源分组（相同内部序号 0）
    Search.kz.renderGroup({ source: 'srcB', name: '源B' }, [{ vod_id: '2', vod_name: '影片乙' }]);

    // 状态隔离
    assert.deepStrictEqual(Object.keys(Search.agg._grpLists), ['ag-sg0']);
    assert.deepStrictEqual(Object.keys(Search.kz._grpLists), ['km-sg0']);

    // 渲染目标容器互不串扰
    const aggHtml = $.allHtml('#search-results');
    const kzHtml = $.allHtml('#kazumi-search-results');
    assert.ok(aggHtml.includes('id="ag-sg0-grid"'), '聚合结果应写入 #search-results');
    assert.ok(!aggHtml.includes('km-sg'), '聚合容器不应出现 Kazumi 分组');
    assert.ok(kzHtml.includes('id="km-sg0-grid"'), 'Kazumi 结果应写入 #kazumi-search-results');
    assert.ok(!kzHtml.includes('ag-sg'), 'Kazumi 容器不应出现聚合分组');

    // 来源筛选 chip 也各自独立
    assert.ok($.allHtml('#search-filters').includes('源A'));
    assert.ok($.allHtml('#kazumi-search-filters').includes('源B'));
    assert.ok(!$.allHtml('#search-filters').includes('源B'));
    assert.ok(!$.allHtml('#kazumi-search-filters').includes('源A'));

    // 双面板内所有分组网格 id 全局唯一（此前共用 sg 前缀会撞 id 导致写错容器）
    const ids = [...aggHtml.matchAll(/id="([^"]+-grid)"/g), ...kzHtml.matchAll(/id="([^"]+-grid)"/g)].map((m) => m[1]);
    assert.strictEqual(new Set(ids).size, ids.length, `分组网格 id 应全局唯一：${ids.join(',')}`);
});
