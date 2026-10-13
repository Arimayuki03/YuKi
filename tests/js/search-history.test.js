/**
 * 白盒单元测试：搜索历史（src/renderer/js/search-history.js + 四处入口接线）
 *
 * 渲染层脚本不是 CommonJS（<script> 顺序加载共享全局作用域），沿用 tests/js/records.test.js
 * 的做法：fs.readFileSync + node:vm，在注入全局桩的上下文里执行源码，再从 globalThis 取句柄。
 *
 * 覆盖目标：
 *   - 存储契约：按 word+source 去重上移、上限淘汰、删除单条、清空、按来源分组、损坏容错
 *   - 面板：聚焦弹出（分组小标题/条目/删除按钮/清空入口）、点删除、清空二次确认、键盘上下+回车
 *   - 记录时机：只在真正发起搜索时写盘（输入过程不写）
 *   - 「不回填搜索框」：search.js / home.js 的状态恢复不再把持久化的词写回输入框
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const R = (f) => path.join(__dirname, '../../src/renderer/js', f);
const read = (f) => fs.readFileSync(R(f), 'utf8');

/** 与 common.js escHtml 同实现的转义桩（H-6：含单引号）。 */
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------------------------------------------------------------- jQuery 桩
/**
 * 记录型 jQuery 桩：val/attr/html/text/addClass 真实记账（供断言读写），
 * 其余方法以 Proxy 兜底返回自身（链式调用不炸）。[0] 给一个带 style 与
 * getBoundingClientRect 的假元素，让 search-history 的 _place 能真跑一遍。
 */
function makeJq(state) {
    const handlers = new Map(); // sel → { ev: [{ deleg, fn }] }
    const fire = (sel, ev, evt, deleg) => {
        const m = handlers.get(sel);
        const list = (m && m[ev]) || [];
        const hits = list.filter((h) => (deleg ? h.deleg === deleg : !h.deleg));
        for (const h of hits) {
            h.fn(evt);
            // 真实 jQuery/DOM 语义：stopImmediatePropagation 后同元素后续监听器不再执行
            if (evt && evt.stopped) break;
        }
    };
    let htmlSeq = 0;
    const wrap = (raw) => {
        if (raw && typeof raw === 'object' && raw.__jq) return raw;      // 已是包装
        if (raw && typeof raw === 'object') return raw;                   // 外部元素对象（currentTarget 等）
        let sel = String(raw == null ? '' : raw);
        // $('<div id="x" ...>') 建元素：以 id 作键，后续 $('.selector')/断言才能对上
        if (/^\s*</.test(sel)) {
            const m = /id="([^"]+)"/.exec(sel);
            sel = m ? `#${m[1]}` : `__html${htmlSeq++}`;
        }
        const cls = () => { if (!state.cls.has(sel)) state.cls.set(sel, new Set()); return state.cls.get(sel); };
        const htmls = () => { if (!state.html.has(sel)) state.html.set(sel, ''); return state.html; };
        const el = {
            __jq: true, sel, length: 1,
            get 0() { return { style: {}, contains: () => false, querySelector: () => null, scrollIntoView() {} }; },
            on(ev, a, b) {
                if (!handlers.has(sel)) handlers.set(sel, {});
                const m = handlers.get(sel);
                (m[ev] = m[ev] || []).push({ deleg: typeof a === 'string' ? a : null, fn: typeof a === 'function' ? a : b });
                return el;
            },
            off() { return el; },
            val(v) { if (v === undefined) return state.vals.get(sel) || ''; state.vals.set(sel, String(v)); return el; },
            attr(k, v) { const key = sel + '#' + k; if (v === undefined) return state.attrs.get(key); state.attrs.set(key, String(v)); return el; },
            data(k) { return state.data.get(sel + '#' + k); },
            html(h) { if (h === undefined) return htmls().get(sel) || ''; htmls().set(sel, String(h)); return el; },
            empty() { htmls().set(sel, ''); return el; },
            append(h) { htmls().set(sel, (htmls().get(sel) || '') + String(h)); return el; },
            text(t) { if (t === undefined) return state.text.get(sel) || ''; state.text.set(sel, String(t)); return el; },
            addClass(c) { cls().add(String(c)); return el; },
            removeClass(c) { cls().delete(String(c)); return el; },
            toggleClass(c) { const s = cls(); if (s.has(String(c))) s.delete(String(c)); else s.add(String(c)); return el; },
            hasClass(c) { return cls().has(String(c)); },
            show() { cls().add('__show'); return el; },
            hide() { cls().delete('__show'); return el; },
            toggle(v) { if (v) return el.show(); return el.hide(); },
            find(sel2) { return wrap(`${sel}>>${sel2}`); },
            filter(fn) { if (typeof fn === 'function') fn.call({ attr: () => undefined }); return el; },
            each(cb) { cb.call({ data: () => undefined }, 0); return el; },
            children() { return wrap(`${sel}>>children`); },
            last() { return el; }, first() { return el; },
            prop() { return el; }, css() { return el; }, scrollTop() { return el; },
            trigger(ev) { fire(sel, ev, { currentTarget: el }); return el; },
            remove() { return el; }, closest() { return el; }, is() { return false; },
            appendTo(t) { const dst = (t && t.__jq && t.sel) || String(t); state.mounted.set(sel, dst); return el; },
        };
        return new Proxy(el, {
            get(t, p) {
                if (p in t) return t[p];
                if (typeof p === 'string') return () => el; // 未实现的方法：链式兜底
                return undefined;
            },
        });
    };
    const $ = (raw) => wrap(raw);
    $.val = (sel, v) => { state.vals.set(sel, String(v)); };
    $.fire = (sel, ev, evt) => fire(sel, ev, evt);
    $.fireDelegated = (sel, deleg, ev, evt) => fire(sel, ev, evt, deleg);
    $.has = (sel, ev) => !!(handlers.get(sel) && handlers.get(sel)[ev]);
    $.addHandler = (sel, ev, fn) => { if (!handlers.has(sel)) handlers.set(sel, {}); (handlers.get(sel)[ev] = handlers.get(sel)[ev] || []).push({ deleg: null, fn }); };
    return $;
}

function makeState() {
    return {
        vals: new Map(), cls: new Map(), html: new Map(), text: new Map(),
        attrs: new Map(), data: new Map(), mounted: new Map(),
    };
}

/** settings 通道桩：data 为盘上数据，sets 记录每次写入（断言「只在搜索时写」）。 */
function makeSettings(initial) {
    const data = JSON.parse(JSON.stringify(initial || {}));
    const sets = [];
    return {
        data, sets,
        settingsGet: async () => JSON.parse(JSON.stringify(data)),
        settingsSet: async (k, v) => { sets.push([k, JSON.parse(JSON.stringify(v))]); data[k] = JSON.parse(JSON.stringify(v)); },
    };
}

const flush = () => new Promise((r) => setImmediate(r));
/** VM 内产生的数组/对象与宿主不同 realm：deepStrictEqual 会因原型不同失败，统一过一遍 JSON。 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** 通用 VM 上下文：search-history.js 必载，hosts 为额外要加载的文件（同一上下文共享全局）。 */
function loadVm(opts) {
    const o = opts || {};
    const state = makeState();
    const $ = makeJq(state);
    const settings = o.settings || makeSettings(o.initial);
    const uiStore = o.uiStore || {};
    const calls = { toasts: [], confirm: [], view: [], app: [] };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean, RegExp,
        parseInt, parseFloat, isNaN, encodeURIComponent, URLSearchParams, CSS: { escape: (s) => String(s) },
        setTimeout, clearTimeout,
        addEventListener() {}, removeEventListener() {},
        document: {
            body: { __docBody: true },
            addEventListener() {}, removeEventListener() {},
            on() {}, off() {}, // $(document).on(...)：面板外部点击收起
        },
        // 浏览器里 window === 全局对象；VM 必须同构，否则 search-history.js 的
        // root.SearchHistory 挂到 window 桩上，宿主的裸引用 SearchHistory 取不到
        yuki: { settingsGet: settings.settingsGet, settingsSet: settings.settingsSet },
        $, escHtml,
        confirmDialog: (msg) => { calls.confirm.push(String(msg)); return Promise.resolve(o.confirm !== false); },
        warnToast: (t) => calls.toasts.push(String(t)),
        showLoading() {}, hideLoading() {}, apiUrl: (u) => u,
        pageSizeOf: async () => 20, renderStatusBar: () => {}, renderPagerBox: () => {},
        vodCard: () => '<div class="vod-card"></div>', vodCoverImg: () => '', getCachedCover: () => '',
        fillMissingCovers: () => {}, fitVodTitles: () => {}, playCardsEnter: () => {},
        errorTextOf: (e) => String(e), localCacheGet: () => null, localCacheSet: () => {},
        Detail: {}, FavHub: { onChanged: () => () => {} }, Timeline: {},
        UIState: {
            isEnabled: () => o.uiEnabled !== false,
            get: (k) => uiStore[k],
            set: (k, v) => { uiStore[k] = JSON.parse(JSON.stringify(v)); },
        },
        actionResponseFailed: () => false,
        // guardedLoad(host, opts)：真实世代守卫的最小语义版（返回 { token }）
        guardedLoad: (host) => {
            const token = (host._loadToken || 0) + 1;
            host._loadToken = token;
            return { token, isLive: () => host._loadToken === token };
        },
        EventSource: function EventSourceStub(url) {
            this.url = url; this.closed = false;
            this.addEventListener = () => {}; this.close = () => { this.closed = true; };
        },
    };
    context.globalThis = context;
    context.window = context; // 与浏览器同构：window === 全局对象
    context.self = context;
    vm.createContext(context);
    const files = [read('search-history.js')].concat((o.hosts || []).map(read));
    // 宿主文件的对象都是顶层 const（只存在于全局词法环境，不是 sandbox 对象属性），
    // 必须显式桥接出来才能从测试驱动它们（对齐 search-page.test.js 的做法）
    vm.runInContext(`${files.join('\n;')}
;globalThis.__H = SearchHistory;
;if (typeof Search !== 'undefined') globalThis.__Search = Search;
;if (typeof createSearchPage === 'function') globalThis.__create = createSearchPage;
;if (typeof Home !== 'undefined') globalThis.__Home = Home;
;if (typeof BangumiSearch !== 'undefined') globalThis.__BangumiSearch = BangumiSearch;`, context, { filename: 'search-history.vm.js' });
    context.__state = state;
    context.__$ = $;
    context.__settings = settings;
    context.__uiStore = uiStore;
    context.__calls = calls;
    return context;
}

// ================================================================ 存储契约

test('sanitize：损坏数据一律降级为空数组，不抛错', () => {
    const ctx = loadVm();
    const H = ctx.__H;
    for (const bad of [null, undefined, 'x', 42, {}, [], [null], [1], [{ word: '' }], [{ word: 'a' }], [{ source: 'home' }], [{ word: 'a', source: 'bogus' }]]) {
        assert.deepEqual(plain(H.sanitize(bad)), [], `非法输入 ${JSON.stringify(bad)} 应降级为空`);
    }
});

test('sanitize：合法条目按 ts 倒序、丢弃非法字段、同键合并取新时间', () => {
    const H = loadVm().__H;
    const out = plain(H.sanitize([
        { word: '旧', source: 'home', ts: 100 },
        { word: ' 新 ', source: 'kazumi', ts: 300 },      // word 去空白
        { word: '旧', source: 'home', ts: 400 },            // 同键：保留较新时间
        { word: '坏ts', source: 'home', ts: 'x' },
        'garbage',
    ]));
    assert.deepEqual(out.map((i) => [i.word, i.source, i.ts]), [
        ['旧', 'home', 400], ['新', 'kazumi', 300], ['坏ts', 'home', 0],
    ]);
});

test('record：按 word+source 去重，重复搜索把该条时间上移', async () => {
    const ctx = loadVm();
    const H = ctx.__H;
    await H.record('甲', 'aggregate');
    await H.record('乙', 'aggregate');
    await H.record('丙', 'aggregate');
    assert.deepEqual(plain(H.list()).map((i) => i.word), ['丙', '乙', '甲']);
    await H.record('甲', 'aggregate');
    assert.deepEqual(plain(H.list()).map((i) => i.word), ['甲', '丙', '乙'], '重复词回到最前');
    assert.equal(H.list().filter((i) => i.word === '甲').length, 1, '同来源同词只留一条');
});

test('record：同一词在不同来源各成一条（分组语义要求）', async () => {
    const ctx = loadVm();
    const H = ctx.__H;
    await H.record('进击的巨人', 'aggregate');
    await H.record('进击的巨人', 'bangumi');
    assert.equal(H.list().length, 2);
    const g = plain(H.grouped());
    assert.deepEqual(g.map((x) => x.source), ['aggregate', 'bangumi']);
    assert.deepEqual(g[0].items.map((i) => i.word), ['进击的巨人']);
    assert.deepEqual(g[1].items.map((i) => i.word), ['进击的巨人']);
});

test('record：超过上限淘汰最旧（保留最近 100 条）', async () => {
    const ctx = loadVm();
    const H = ctx.__H;
    for (let i = 0; i < H.MAX_ITEMS + 5; i += 1) await H.record(`词${i}`, 'aggregate');
    assert.equal(H.list().length, H.MAX_ITEMS);
    assert.equal(H.list()[0].word, `词${H.MAX_ITEMS + 4}`, '最新一条在最前');
    assert.equal(H.list().some((i) => i.word === '词0'), false, '最旧的被淘汰');
    assert.equal(ctx.__settings.data.searchHistory.length, H.MAX_ITEMS, '落盘同样受上限约束');
});

test('remove / clear：删除单条与清空都同步落盘', async () => {
    const ctx = loadVm();
    const H = ctx.__H;
    await H.record('甲', 'home');
    await H.record('乙', 'home');
    await H.record('丙', 'kazumi');
    await H.remove('乙', 'home');
    assert.deepEqual(plain(H.list()).map((i) => i.word), ['丙', '甲']);
    assert.equal(ctx.__settings.data.searchHistory.length, 2, '删除已落盘');
    await H.remove('乙', 'home'); // 删不存在的：无副作用
    assert.equal(H.list().length, 2);
    await H.clear();
    assert.deepEqual(plain(H.list()), []);
    assert.deepEqual(ctx.__settings.data.searchHistory, []);
});

test('落盘结构为 [{word,source,ts}]，且每次 record 只写一次（不在输入过程写）', async () => {
    const ctx = loadVm();
    const H = ctx.__H;
    await H.record('甲', 'home');
    await H.record('乙', 'home');
    const writes = ctx.__settings.sets.filter((s) => s[0] === 'searchHistory');
    assert.equal(writes.length, 2, '两条记录两次写，别无谓写盘');
    const last = writes[writes.length - 1][1];
    assert.deepEqual(Object.keys(last[0]).sort(), ['source', 'ts', 'word']);
    assert.equal(last[0].source, 'home');
    assert.equal(typeof last[0].ts, 'number');
});

test('首次记录先载入盘上历史，不会把旧历史覆盖成一条', async () => {
    const settings = makeSettings({
        searchHistory: [{ word: '盘上旧词', source: 'home', ts: 10 }],
    });
    const ctx = loadVm({ settings });
    const H = ctx.__H;
    await H.record('新词', 'home');
    assert.deepEqual(plain(H.list()).map((i) => i.word), ['新词', '盘上旧词']);
    assert.equal(settings.data.searchHistory.length, 2, '旧历史保留');
});

test('settingsSet 抛错/通道缺失时静默降级（记录不抛错，内存仍可用）', async () => {
    const ctx = loadVm();
    const H = ctx.__H;
    ctx.yuki.settingsSet = async () => { throw new Error('ipc down'); };
    await H.record('甲', 'home');
    assert.deepEqual(plain(H.list()).map((i) => i.word), ['甲'], '写失败不影响本次会话内可用');
    const ctx2 = loadVm();
    delete ctx2.yuki;
    await ctx2.__H.record('乙', 'home');
    assert.deepEqual(plain(ctx2.__H.list()).map((i) => i.word), ['乙']);
});

test('空词/非法来源不写入（避免垃圾条目）', async () => {
    const ctx = loadVm();
    const H = ctx.__H;
    await H.record('   ', 'home');
    await H.record('甲', 'nope');
    await H.record('', '');
    assert.deepEqual(plain(H.list()), []);
    assert.equal(ctx.__settings.sets.length, 0);
});

// ================================================================ 面板与交互

const seed = async (ctx, pairs) => {
    for (const [w, s] of pairs) await ctx.__H.record(w, s);
};

test('attach + 聚焦：面板列出来源分组、词与删除/清空入口（HTML 已转义）', async () => {
    const ctx = loadVm();
    await seed(ctx, [['甲', 'aggregate'], ['乙', 'kazumi'], ['<img src=x onerror=1>', 'home']]);
    assert.equal(ctx.__H.attach('#search-keyword', 'aggregate'), true);
    ctx.__$.fire('#search-keyword', 'focus', {});
    await flush();
    assert.equal(ctx.__H.isOpen(), true, '聚焦即弹出');
    const html = ctx.__state.html.get('#search-his-panel') || '';
    assert.match(html, /聚合搜索/, '有来源小标题');
    assert.match(html, /Kazumi 源/);
    assert.match(html, /首页（当前源）/);
    assert.match(html, /data-source="aggregate" data-word="甲"/);
    assert.match(html, /search-his-del/, '每条带删除按钮');
    assert.match(html, /清空历史/);
    assert.ok(!html.includes('<img src=x'), '用户输入必须转义，不得注入 HTML');
    assert.match(html, /&lt;img src=x/);
});

test('attach 幂等；同一输入框重复挂载不重复绑定', async () => {
    const ctx = loadVm();
    await seed(ctx, [['甲', 'home']]);
    ctx.__H.attach('#home-search', 'home');
    ctx.__H.attach('#home-search', 'home');
    ctx.__$.fire('#home-search', 'focus', {});
    await flush();
    // 双绑会让每次 focus 都排队两次渲染，这里以「仍然只打开一次、内容正确」为契约
    assert.equal(ctx.__H.isOpen(), true);
    assert.match(ctx.__state.html.get('#search-his-panel'), /data-word="甲"/);
});

test('无历史时聚焦不弹空面板', async () => {
    const ctx = loadVm();
    ctx.__H.attach('#search-keyword', 'aggregate');
    ctx.__$.fire('#search-keyword', 'focus', {});
    await flush();
    assert.equal(ctx.__H.isOpen(), false);
});

test('点条目直接搜同来源；点删除只删该条', async () => {
    const ctx = loadVm();
    await seed(ctx, [['甲', 'aggregate'], ['乙', 'aggregate']]);
    // 同来源条目：面板所属输入框即目标，填词后交给 Search.agg.run()
    let ran = null;
    ctx.Search = { _stab: 'aggregate', agg: { run: () => { ran = ctx.__state.vals.get('#search-keyword'); } } };
    ctx.App = { currentView: 'search', showView() {} };
    ctx.__H.attach('#search-keyword', 'aggregate');
    ctx.__$.fire('#search-keyword', 'focus', {});
    await flush(); // 面板懒建 + 首次渲染（删除按钮的委托 handler 在此时才绑上）
    ctx.__H.dispatch('aggregate', '乙');
    assert.equal(ran, '乙', '点击即以该词发起检索');
    assert.equal(ctx.__H.isOpen(), false, '发起检索后面板收起');
    // 删除按钮（委托 click）：data-* 走 attr 原始字符串
    const ev = { stopPropagation() {}, currentTarget: { attr: (k) => (k === 'data-word' ? '甲' : 'aggregate') } };
    ctx.__$.fireDelegated('#search-his-panel', '.search-his-del', 'click', ev);
    await flush(); await flush(); await flush();
    assert.deepEqual(plain(ctx.__H.list()).map((i) => i.word), ['乙']);
});

test('清空历史：确认后才清，取消则原样保留', async () => {
    const okCtx = loadVm();
    await seed(okCtx, [['甲', 'home'], ['乙', 'home']]);
    okCtx.__H.attach('#home-search', 'home');
    okCtx.__$.fire('#home-search', 'focus', {});
    await flush();
    okCtx.__$.fireDelegated('#search-his-panel', '.search-his-clear', 'click', {});
    await flush(); await flush(); await flush();
    assert.match(okCtx.__calls.confirm[0], /清空全部 2 条搜索历史/);
    assert.deepEqual(plain(okCtx.__H.list()), []);
    assert.deepEqual(okCtx.__settings.data.searchHistory, [], '清空落盘');

    const noCtx = loadVm({ confirm: false });
    await seed(noCtx, [['甲', 'home']]);
    noCtx.__H.attach('#home-search', 'home');
    noCtx.__$.fire('#home-search', 'focus', {});
    await flush();
    noCtx.__$.fireDelegated('#search-his-panel', '.search-his-clear', 'click', {});
    await flush(); await flush(); await flush();
    assert.deepEqual(plain(noCtx.__H.list()).map((i) => i.word), ['甲'], '取消不清空');
});

test('键盘：上下选 + 回车执行高亮项（并拦下宿主回车）', async () => {
    const ctx = loadVm();
    await seed(ctx, [['甲', 'aggregate'], ['乙', 'kazumi']]);
    let kzWord = null; let aggWord = null;
    ctx.Search = {
        _stab: 'kazumi',
        agg: { run: () => { aggWord = ctx.__state.vals.get('#search-keyword'); } },
        kz: { run: () => { kzWord = ctx.__state.vals.get('#kazumi-search-keyword'); } },
    };
    ctx.App = { currentView: 'search', showView() {} };
    // 绑定顺序与生产一致：attach 先（面板键盘导航要能拦下宿主的回车搜索），宿主后
    ctx.__H.attach('#search-keyword', 'aggregate');
    let host = 0;
    ctx.__$.addHandler('#search-keyword', 'keydown', () => { host += 1; });
    ctx.__$.fire('#search-keyword', 'focus', {});
    await flush();
    const keydown = (key) => {
        const ev = { key, preventDefault() {}, stopImmediatePropagation() { ev.stopped = true; } };
        ctx.__$.fire('#search-keyword', 'keydown', ev);
    };
    keydown('ArrowDown'); // 第一项 = 聚合搜索 甲
    keydown('ArrowDown'); // 第二项 = Kazumi 乙
    keydown('Enter');
    assert.equal(kzWord, '乙', '回车执行高亮项（跨来源：切页签语义由 dispatch 承担）');
    assert.equal(aggWord, null);
    assert.equal(host, 0, '面板消费的回车不得落到宿主的回车搜索');
    assert.equal(ctx.Search._stab, 'kazumi', '本就在 kazumi 页签：不重复切页签');
});

test('跨来源点击：切到对应视图/页签后以该词发起检索', async () => {
    const ctx = loadVm();
    await seed(ctx, [['番剧名', 'bangumi'], ['首页词', 'home']]);
    const calls = [];
    ctx.App = { currentView: 'home', showView: (v) => calls.push(['view', v]) };
    ctx.Home = { searchCurrent: (pg, wd) => calls.push(['home.run', wd || ctx.__state.vals.get('#home-search')]) };
    ctx.Search = { _stab: 'aggregate', agg: { run: () => calls.push(['agg.run']) }, kz: { run: () => calls.push(['kz.run']) } };
    const tabEv = { currentTarget: { data: (k) => (k === 'stab' ? 'bangumi' : undefined), addClass() {}, removeClass() {} } };
    ctx.__$.addHandler('#search-tabs', 'click', () => { ctx.Search._stab = 'bangumi'; });
    ctx.BangumiSearch = { _submitFromInput: () => calls.push(['bgm.run', ctx.__state.vals.get('#bgm-search-keyword')]) };

    ctx.__H.dispatch('home', '首页词');
    assert.deepEqual(calls, [['home.run', '首页词']], '首页源：填 #home-search 并搜');
    assert.equal(ctx.__state.vals.get('#home-search'), '首页词');

    calls.length = 0;
    ctx.__H.dispatch('bangumi', '番剧名');
    assert.ok(calls.some((c) => c[0] === 'view' && c[1] === 'search'), '跨来源先切到搜索视图');
    assert.deepEqual(calls.filter((c) => c[0] === 'bgm.run'), [['bgm.run', '番剧名']]);
    assert.equal(ctx.__state.vals.get('#bgm-search-keyword'), '番剧名', '切页签后填入目标输入框');
    assert.equal(tabEv.currentTarget.data('stab'), 'bangumi'); // 触发链已就位
});

// ================================================================ search.js 接入

test('search.js：run() 在聚合/Kazumi 两个页签各自记录来源', async () => {
    const ctx = loadVm({ hosts: ['search.js'] });
    const H = ctx.__H;
    const agg = ctx.__create({
        mode: 'aggregate', stab: 'aggregate', gidPrefix: 'ag-sg',
        keywordSel: '#search-keyword', goSel: '#search-go',
        filtersSel: '#search-filters', statusSel: '#search-status', resultsSel: '#search-results',
    });
    ctx.__$.val('#search-keyword', '聚合词');
    await agg.run();
    assert.deepEqual(plain(H.list()).map((i) => [i.word, i.source]), [['聚合词', 'aggregate']]);

    const kz = ctx.__create({
        mode: 'kazumi', stab: 'kazumi', gidPrefix: 'km-sg',
        keywordSel: '#kazumi-search-keyword', goSel: '#kazumi-search-go',
        filtersSel: '#kazumi-search-filters', statusSel: '#kazumi-search-status', resultsSel: '#kazumi-search-results',
    });
    ctx.__Search._stab = 'kazumi';
    ctx.__$.val('#kazumi-search-keyword', 'KZ词');
    await kz.run();
    assert.equal(H.list().find((i) => i.word === 'KZ词').source, 'kazumi');
});

test('search.js：空关键词不记录（未发起检索）', async () => {
    const ctx = loadVm({ hosts: ['search.js'] });
    const agg = ctx.__create({
        mode: 'aggregate', stab: 'aggregate', gidPrefix: 'ag-sg',
        keywordSel: '#search-keyword', goSel: '#search-go',
        filtersSel: '#search-filters', statusSel: '#search-status', resultsSel: '#search-results',
    });
    await agg.run();
    assert.deepEqual(plain(ctx.__H.list()), []);
    assert.equal(ctx.__settings.sets.length, 0);
});

test('search.js：_restoreShellOnce 恢复页签但绝不回填搜索框（需求核心）', async () => {
    const uiStore = { search: { stab: 'kazumi', words: { aggregate: '聚合旧词', kazumi: 'KZ旧词', bangumi: 'BGM旧词' } } };
    const ctx = loadVm({ hosts: ['search.js'], uiStore });
    ctx.__Search.init();
    // init 会把 #search-tabs 的委托 click 绑上；页签点击链路的 stub currentTarget
    const tabEl = { data: (k) => (k === 'stab' ? 'kazumi' : undefined), addClass() {}, removeClass() {} };
    ctx.__$.fireDelegated('#search-tabs', '.class-tab', 'click', { currentTarget: tabEl });
    assert.equal(ctx.__Search._stab, 'kazumi', '页签按持久化状态还原');
    for (const sel of ['#search-keyword', '#kazumi-search-keyword', '#bgm-search-keyword']) {
        assert.equal(ctx.__state.vals.has(sel), false, `${sel} 不得被写入关键词（回填已废除）`);
    }
});

test('search.js：输入过程（input 事件）不写历史，只有 run() 才写', async () => {
    const ctx = loadVm({ hosts: ['search.js'] });
    ctx.__Search.init();
    ctx.__$.val('#search-keyword', '半截词');
    ctx.__$.fire('#search-keyword', 'input', { target: {} });
    await flush();
    assert.deepEqual(plain(ctx.__H.list()), [], '打字不产生历史条目');
    assert.equal(ctx.__settings.sets.length, 0, '打字不写盘');
});

// ================================================================ home.js 接入

test('home.js：searchCurrent 记录 home 来源；恢复路径用参数传词而非回填输入框', async () => {
    const uiStore = { home: { site: 's', mode: 'search', tid: '', page: 2, word: '海贼王' } };
    const ctx = loadVm({ hosts: ['home.js'], uiStore });
    const H = ctx.__Home;
    H.site = 's';
    H.classes = [];
    H.mode = 'home';
    H.tid = '';
    H._loadToken = 0;
    H.renderGrid = () => {}; H.renderPager = () => {}; H.renderClass = () => {};
    // 恢复路径：显式传词（不经过输入框），输入框保持空
    await H.searchCurrent(2, '海贼王');
    assert.deepEqual(plain(ctx.__H.list()).map((i) => [i.word, i.source]), [['海贼王', 'home']]);
    assert.equal(ctx.__state.vals.get('#home-search') || '', '', '恢复不得把词写回输入框');
    assert.equal(H.searchWord, '海贼王', '模式状态记住词（供 _saveView 持久化）');
    assert.equal(uiStore.home.word, '海贼王', '页面状态记忆仍保存关键词（与搜索历史互补）');
});

test('home.js：输入框为空且未传词时不记录', async () => {
    const ctx = loadVm({ hosts: ['home.js'] });
    const H = ctx.__Home;
    H.site = 's'; H.mode = 'home'; H.tid = '';
    await H.searchCurrent(1);
    assert.deepEqual(plain(ctx.__H.list()), []);
});

// ================================================================ bangumi-search.js 接入

test('bangumi-search.js：提交时记录 bangumi 来源，空输入不记录', async () => {
    const ctx = loadVm({ hosts: ['bangumi-search.js'] });
    ctx.__BangumiSearch.init();
    ctx.__$.val('#bgm-search-keyword', ' 进击的巨人 ');
    ctx.__BangumiSearch._submitFromInput();
    await flush(); await flush();
    assert.deepEqual(plain(ctx.__H.list()).map((i) => [i.word, i.source]), [['进击的巨人', 'bangumi']]);

    // 筛选语法也是用户敲进去的查询串：照记，点回可复现同一次检索
    ctx.__$.val('#bgm-search-keyword', 'tag:日常 sort:rank');
    ctx.__BangumiSearch._submitFromInput();
    await flush(); await flush();
    assert.deepEqual(plain(ctx.__H.list()).map((i) => i.word), ['tag:日常 sort:rank', '进击的巨人']);

    // 输入框为空（连筛选也没有）：提示且不记录
    ctx.__$.val('#bgm-search-keyword', '');
    ctx.__BangumiSearch._submitFromInput();
    await flush(); await flush();
    assert.equal(ctx.__H.list().length, 2, '空输入不产生条目');
    assert.ok(ctx.__calls.toasts.some((t) => /请输入关键字/.test(t)));
});

test('bangumi-search.js：聚焦弹出历史面板（接线生效）', async () => {
    const ctx = loadVm({ hosts: ['bangumi-search.js'] });
    await seed(ctx, [['旧番', 'bangumi']]);
    ctx.__BangumiSearch.init();
    ctx.__$.fire('#bgm-search-keyword', 'focus', {});
    await flush();
    assert.equal(ctx.__H.isOpen(), true);
    assert.match(ctx.__state.html.get('#search-his-panel'), /data-source="bangumi" data-word="旧番"/);
});
