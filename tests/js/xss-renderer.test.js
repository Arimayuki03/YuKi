'use strict';
// #11 渲染层 XSS 修复回归测试：
// 1) common.js bangumiCard — Bangumi 远端可控字段（rank/score/name）全部经 escHtml 进 HTML
// 2) home.js renderGrid — 后端 data.error（字符串/对象）进 .html() 前经 escHtml
// 3) detail.js load — data.error（第三方源回传）经 escHtml 后进 .html()
// 4) timeline.js _buildSeasonOptions — 季度键（UIState 存档）经 escHtml
// 5) index.html — CSP meta 存在且禁内联脚本/eval（script-src 无 unsafe-inline）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 在 VM 中加载 common.js（最小桩），返回导出的函数集合。 */
function loadCommon(extra = {}) {
    const source = read('src/renderer/js/common.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, parseInt, parseFloat,
        setTimeout, clearTimeout, URLSearchParams,
        $: () => ({ on() { return this; } }),
        window: {},
        document: {},
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        fetch: async () => ({ ok: true, text: async () => '' }),
        AbortSignal: { timeout: () => ({}) },
        ...extra,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__card = bangumiCard; globalThis.__escHtml = escHtml;`,
        context, { filename: 'common.js' });
    return context;
}

/** 在 VM 中加载 home.js（复用 home-probe 的最小桩思路）。 */
function loadHome() {
    const commonSrc = read('src/renderer/js/common.js');
    const cacheSrc = read('src/renderer/js/cache.js');
    const source = read('src/renderer/js/home.js');
    const ls = { m: new Map(), getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
    let captured = '';
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, document: {},
        localStorage: ls,
        $: (sel) => ({ on() { return this; }, off() { return this; }, empty() { return this; }, html(s) { if (s !== undefined) captured = s; return this; }, val() { return ''; } }),
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => {} }, localStorage: ls },
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        truncateTitle: (s) => String(s || '').slice(0, 60),
        vodCoverImg: (pic) => `<img src="${pic || ''}">`,
        warnToast: () => {}, showLoading: () => {}, hideLoading: () => {},
        normalizePic: (p) => p || '', Detail: {}, renderPagerBox: () => {},
        pageSizeOf: async () => 20, fillMissingCovers: () => {}, fitVodTitles: () => {},
        renderStatusBar: () => {}, doAction: async () => ({ list: [] }), getJson: async () => ({ sites: [] }),
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${cacheSrc}\n;${commonSrc}\n;${source}`, context, { filename: 'home.js' });
    vm.runInContext(`
        ;globalThis.__Home = Home;
        ;localCacheGet = (typeof window.localCacheGet === 'function') ? window.localCacheGet : (() => null);
        ;localCacheSet = (typeof window.localCacheSet === 'function') ? window.localCacheSet : (() => {});
        ;warnToast = () => {}; showLoading = () => {}; hideLoading = () => {};
        ;fillMissingCovers = () => {}; fitVodTitles = () => {}; renderStatusBar = () => {}; renderPagerBox = () => {};
        ;playCardsEnter = () => {}; stageAppendedCards = () => {};
        ;confirmDialog = async () => true; doAction = async () => ({ list: [] }); pageSizeOf = async () => 20;`, context);
    // __captured 挂到 ctx 上（vm 内重赋值 $ 桩后 captured 闭包仍在）
    context.__captured = () => captured;
    return context;
}

test('#11 bangumiCard：Bangumi 远端可控字段（rank/score/name）进 HTML 前全部转义', () => {
    const ctx = loadCommon();
    const item = {
        id: '1"><img src=x onerror=alert(1)>',
        name: '<script>alert("name")</script>',
        rating: { score: '5</span><script>x</script>', rank: '3" onerror="x' },
        air_date: '2026-01-01',
    };
    const html = ctx.__card(item);
    // 原始载荷不得以未转义形式出现（无裸 script 标签、无裸属性闭合）
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /onerror="x"/);
    // 转义形态存在：id/name_cn 属性位、rank 属性位、score 文本位
    assert.match(html, /data-id="1&quot;&gt;&lt;img/);          // id 属性位转义
    assert.match(html, /#3&quot; onerror=&quot;x/);              // rank 属性位转义
    assert.match(html, /⭐5&amp;lt;\/span&amp;gt;/);             // score 先转义进 remarks 再整体转义（双重实体，仍为文本）
    assert.match(html, /&lt;script&gt;/);                        // name 文本位转义
    // name_cn（优先字段）也转义
    const cn = ctx.__card({ id: '2', name: 'orig', name_cn: '中文名" onmouseover="x' });
    assert.match(cn, /data-name="中文名&quot; onmouseover=&quot;x"/);
    assert.doesNotMatch(cn, /onmouseover="x/);
    // 正常值不受影响
    const ok = ctx.__card({ id: '42', name: '日常', rating: { score: 8.3, rank: 107 }, air_date: '2011-04-03' });
    assert.match(ok, /#107/);
    assert.match(ok, /⭐8\.3/);
});

test('#11 home renderGrid：data.error（字符串/对象）经 escHtml 再进 .html()', () => {
    const ctx = loadHome();
    const H = ctx.__Home;
    // 恶意字符串错误
    H.renderGrid([], '<img src=x onerror=alert(1)>');
    let html = ctx.__captured();
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    // 正常错误仍可读（code+message）
    H.renderGrid([], { code: 'L3_RUNTIME_CALL_FAILED', message: '蜘蛛调用失败', stage: 'site' });
    html = ctx.__captured();
    assert.match(html, /L3_RUNTIME_CALL_FAILED 蜘蛛调用失败/);
    // 恶意 message 同样转义
    H.renderGrid([], { code: 'E', message: '<script>y</script>' });
    assert.doesNotMatch(ctx.__captured(), /<script>/);
});

test('#11 detail load：data.error（第三方源回传）经 escHtml 再进 .html()', async () => {
    const commonSrc = read('src/renderer/js/common.js');
    const cacheSrc = read('src/renderer/js/cache.js');
    const source = read('src/renderer/js/detail.js');
    let captured = '';
    const ls = { m: new Map(), getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
    const jqStub = () => {
        const o = { on() { return this; }, off() { return this; }, empty() { return this; }, html(s) { if (s !== undefined) captured = s; return this; }, val() { return ''; }, text() { return this; }, addClass() { return this; }, removeClass() { return this; }, toggleClass() { return this; }, attr() { return this; }, prop() { return this; }, find() { return this; }, remove() { return this; }, prepend() { return this; }, append() { return this; }, first() { return this; }, each() {}, show() { return this; }, hide() { return this; }, focus() { return this; }, trigger() { return this; }, is() { return false; }, css() { return this; } };
        return o;
    };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, document: { addEventListener() {} },
        localStorage: ls,
        $: jqStub,
        window: { yuki: { settingsGet: async () => ({}) }, localStorage: ls },
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        doAction: async () => ({ error: '<script>detail-xss</script>' }),
        // common.js 重新加载后重打桩（showLoading 内部有 $().find 链）
        showLoading: () => {}, hideLoading: () => {}, warnToast: () => {}, showView: () => {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${cacheSrc}\n;${commonSrc}\n;${source}`, context, { filename: 'detail.js' });
    vm.runInContext(';doAction = async () => ({ error: \'<script>detail-xss</script>\' }); showLoading = () => {}; hideLoading = () => {}; warnToast = () => {};', context);
    const Detail = context.Detail || vm.runInContext('Detail', context);
    Detail.site = 's'; Detail.vodId = '1';
    await Detail.load();
    assert.doesNotMatch(captured, /<script>detail-xss<\/script>/);
    assert.match(captured, /&lt;script&gt;detail-xss&lt;\/script&gt;/);
});

test('#11 timeline _seasonOptionHtml：季度键进选项前 escHtml（转义汇点直测）', () => {
    const source = read('src/renderer/js/timeline.js');
    const optgroups = [];
    const fakeSel = {
        empty() { return this; },
        append(el) { optgroups.push(String(el)); return this; },
    };
    const context = {
        console, Date, Math, JSON, String, Number, Array, Map, Set, parseInt,
        $: () => fakeSel,
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    };
    // 打桩 jQuery optgroup 构造：直接捕获 escHtml 后的拼串结果
    const jqCalls = [];
    context.$ = (arg) => {
        if (typeof arg === 'string' && arg.indexOf('<optgroup') === 0) {
            return { html(s) { jqCalls.push([arg, s]); return this; } };
        }
        return fakeSel;
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}
        ;globalThis._bso = Timeline._buildSeasonOptions.bind(Timeline);
        ;globalThis._soh = Timeline._seasonOptionHtml.bind(Timeline);`, context, { filename: 'timeline.js' });
    const soh = context._soh;
    const bso = context._bso;
    // (1) 转义汇点直测：季度键（UIState 存档恢复路径可控）注入恶意载荷——
    // 撤掉 escHtml 后该用例必挂（value 属性位出现裸 "> 闭合）
    const hostile = '2026Q1"><img src=x onerror=alert(1)>';
    const html = soh(hostile);
    assert.ok(html.includes('<option value="'), '仍输出 option 标签');
    assert.doesNotMatch(html, /"><img/, `value 属性位不得出现裸引号闭合: ${html}`);
    assert.doesNotMatch(html, /<img src=x/, `恶意 img 不得以未转义形式出现: ${html}`);
    assert.match(html, /&quot;&gt;&lt;img/, '载荷必须以转义形态出现');
    // 标签路径：非标准键原样进文本位，同样必须转义
    const html2 = soh('<script>x</script>');
    assert.doesNotMatch(html2, /<script>/);
    assert.match(html2, /&lt;script&gt;/);
    // (2) _buildSeasonOptions 注入固定 now：季度枚举确定性（2025Q4 起 2 个季度）
    const fixed = new Date(2025, 11, 15); // 2025-12 → 2025Q4
    bso(fixed);
    assert.ok(jqCalls.length > 0, '应产生 optgroup');
    const all = jqCalls.map(([a, b]) => a + b).join('');
    assert.match(all, /<option value="2025Q4">2025年秋季新番<\/option>/, '注入 now 后首季度应确定为 2025Q4');
    assert.match(all, /<option value="2025Q3">2025年夏季新番<\/option>/, '回溯第二季度应为 2025Q3');
    assert.ok(!all.includes('undefined'), '不得出现 undefined 键');
    assert.doesNotMatch(all, /<script>/);
});

test('#11 index.html：CSP meta 禁内联脚本与 eval', () => {
    const html = read('src/renderer/index.html');
    const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
    assert.ok(m, '存在 CSP meta');
    const csp = m[1];
    // 脚本：self + file:，无 unsafe-inline（内联 <script> 块与 eval 被禁）
    assert.match(csp, /script-src[^;]*'self'[^;]*file:/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    // 内联事件属性白名单（unsafe-hashes）与动态桥接并存
    assert.match(csp, /script-src-attr[^;]*'unsafe-hashes'/);
    assert.match(csp, /script-src-attr[^;]*'sha256-/);
    // 资源放宽项
    assert.match(csp, /style-src[^;]*'unsafe-inline'/);
    assert.match(csp, /img-src[^;]*data:/);
    assert.match(csp, /img-src[^;]*https:/);
    assert.match(csp, /connect-src[^;]*http:/);
    assert.match(csp, /connect-src[^;]*ws:/);
    assert.match(csp, /media-src[^;]*https:/);
    // 页面无内联 <script> 块（脚本全部本地 src 引用）
    assert.doesNotMatch(html, /<script>/);
});

test('#11 CSP sha256 白名单：所有静态 on* 处理器表达式必须被某个声明哈希覆盖', () => {
    // 重新计算（不硬编码清单）：index.html 与渲染层 JS 模板里的静态
    // on*="..." 表达式逐个 sha256，必须能在 CSP script-src-attr 的
    // unsafe-hashes 哈希集合里找到——CSP meta 忘了随表达式同步更新时在此报警。
    const crypto = require('node:crypto');
    const sha256Attr = (s) => 'sha256-' + crypto.createHash('sha256').update(s, 'utf8').digest('base64');
    const html = read('src/renderer/index.html');
    const cspMeta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
    assert.ok(cspMeta, '存在 CSP meta');
    const declared = new Set(
        [...cspMeta[1].matchAll(/sha256-([A-Za-z0-9+/=]+)/g)].map((x) => `sha256-${x[1]}`));
    assert.ok(declared.size >= 30, `CSP 应声明完整哈希白名单，实际 ${declared.size} 个`);
    // 收集静态 on* 表达式：index.html 属性 + 渲染层 JS 模板字面量（跳过含 ${ 的动态桥接）
    const found = [];
    let mm;
    const attrRe = /\s(on[a-z]+)="([^"]*)"/g;
    while ((mm = attrRe.exec(html)) !== null) found.push(['index.html', mm[1], mm[2]]);
    const jsDir = path.join(ROOT, 'src/renderer/js');
    for (const f of fs.readdirSync(jsDir)) {
        if (!f.endsWith('.js') || f === 'jquery.min.js') continue;
        const src = read(path.join('src/renderer/js', f));
        const re = /\s(on[a-z]+)="([^"]*)"/g;
        while ((mm = re.exec(src)) !== null) found.push([f, mm[1], mm[2]]);
    }
    assert.ok(found.length >= 20, `应扫描到内联事件处理器，实际 ${found.length} 个`);
    const uncovered = [];
    for (const [file, attr, expr] of found) {
        if (expr.includes('${')) continue; // 动态桥接（script-src-attr 之外的豁免由 unsafe-hashes 之外的机制处理）
        // 候选形态：原样 + JS 模板里被 \' 转义的单引号还原（浏览器收到的是还原后的）
        const candidates = [expr, expr.replace(/\\'/g, "'")];
        if (!candidates.some((c) => declared.has(sha256Attr(c)))) {
            uncovered.push(`${file} ${attr}="${expr.slice(0, 80)}"`);
        }
    }
    assert.deepEqual(uncovered, [],
        `以下静态 on* 表达式未被 CSP 哈希白名单覆盖（漏更新 index.html 的 meta）:\n${uncovered.join('\n')}`);
});
