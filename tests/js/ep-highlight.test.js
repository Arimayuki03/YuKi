'use strict';
// A-16：集网格「看到第 N 集」当前集高亮回归测试（detail.js renderEpisodes → _applyEpHighlight）：
// 1) 通用观看进度表有记录（currentEp=N）→ 对应集按钮（data-idx=N-1）加 ep-hi 高亮类，
//    title 变为「… · 上次看到第 N 集」；2) 无进度记录 → 渲染输出与既有完全一致（零变化）；
// 3) currentEp 超出当前线路集数（换线路越界）→ 宁缺勿错标；4) Records 缺失 → 静默不高亮；
// 5) 重渲染（切顺序/换线路）→ 先清旧徽标再上新，不会残留双高亮；
// 6) 契约守卫：ui.css 存在 .ep-btn.ep-hi 令牌化样式；Bangumi 分集页签（_renderBgmEpisodes）
//    不接高亮——其观看进度走 RM-5 远端上报、从不写 watchProgress 本地表（源码锚点断言）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/**
 * 可查询的 jQuery 桩：renderEpisodes 用 box.children('.ep-btn') 枚举伪 DOM 元素
 * （each 回调里读 getAttribute('data-idx')），高亮逻辑用选择器查询按钮后
 * addClass/attr。桩用「元素注册表」模拟：attr(id) 注册元素，选择器按 data-idx 精确匹配。
 */
function makeEpJq() {
    // 元素注册表：data-idx → { attrs: Map, classes: Set, name: string }
    const registry = new Map(); // key: String(data-idx)
    const nodeFor = (sel) => {
        const m = String(sel).match(/^#ep-list \.ep-btn\[data-idx="(\d+)"\]$/);
        if (m) {
            const el = registry.get(m[1]);
            if (!el) return makeNode(String(sel), null);
            return makeNode(String(sel), el);
        }
        return makeNode(String(sel), null);
    };
    function makeNode(sel, el) {
        const node = {
            sel: String(sel),
            // 容器选择器（#ep-list 等）恒存在；仅 .ep-btn[data-idx] 查询按注册表命中与否
            length: el ? 1 : (String(sel).includes('.ep-btn[data-idx') ? 0 : 1),
            on() { return node; },
            off() { return node; },
            html(s) { if (s !== undefined && el) el.name = String(s); return node; },
            text(s) { return node; },
            append(s) { return node; },
            find(child) {
                // 高亮路径读 .ep-name 的文本：返回只含 text() 的节点
                return {
                    text() { return el ? String(el.name || '') : ''; },
                    length: el ? 1 : 0,
                };
            },
            each(fn) {
                // children('.ep-btn') 枚举：以伪 DOM 元素回调（getAttribute 可读）
                if (String(sel) === '#ep-list' || String(sel) === '#bgm-ep-list') {
                    for (const el of registry.values()) fn.call(el);
                }
                return node;
            },
            addClass(c) { if (el) el.classes.add(String(c)); return node; },
            removeClass(c) { if (el) el.classes.delete(String(c)); return node; },
            toggleClass() { return node; },
            attr(k, v) {
                if (v !== undefined && el) el.attrs.set(String(k), String(v));
                return node;
            },
            prop() { return node; },
            data() { return node; },
            remove(el2) {
                if (el2 && el2.__key) registry.delete(el2.__key);
                return node;
            },
            children() { return node; },
            show() { return node; },
            hide() { return node; },
            css() { return node; },
        };
        return node;
    }
    const $ = (sel) => {
        if (sel && typeof sel === 'object') {
            // 清旧徽标路径传入原生伪元素：包一层节点，removeClass/attr 写回注册表
            const el = registry.get(sel.__key);
            const node = makeNode('obj', el);
            if (el) {
                node.removeClass = (c) => { el.classes.delete(String(c)); return node; };
                node.find = (child) => ({
                    text() { return String(el.name || ''); },
                    length: 1,
                });
            }
            return node;
        }
        return nodeFor(sel);
    };
    /** 预置一排集按钮（renderEpisodes 会真实构造这些 DOM）。 */
    const seed = (names) => {
        registry.clear();
        names.forEach((name, i) => {
            const attrs = new Map([['data-idx', String(i)], ['title', name || `第 ${i + 1} 集`]]);
            registry.set(String(i), {
                __key: String(i),
                attrs,
                classes: new Set(['ep-btn']),
                name: name || '',
                getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
            });
        });
    };
    return { $, registry, seed };
}

/** 在 VM 中加载 detail.js：Records.getWatchProgress 返回 opts.progress。 */
function loadDetail({ progress = undefined } = {}) {
    const jq = makeEpJq();
    const wpCalls = [];
    const source = read('src/renderer/js/detail.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout, RegExp,
        document: {
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains: () => false } },
            getElementById: () => null,
            addEventListener() {},
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: jq.$,
        registerEsc: () => {},
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        stripHtml: (s) => String(s || ''),
        warnToast: () => {},
        showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: (pic) => `<img src="${pic || 'assets/cover-fallback.svg'}">`,
        normalizePic: (p) => String(p || '').trim(),
        abortCoverFill: () => {},
        errorTextOf: (e) => String(e || ''),
        App: { currentView: 'detail', showView() {} },
        Kazumi: undefined,
        Records: {
            isFavorite: async () => false, getFavTag: async () => '', setFavTag: async () => {},
            toggleFavorite: async () => {},
            getWatchProgress: async (site, vodId) => { wpCalls.push({ site, vodId }); return progress; },
        },
        FavHub: { onChanged: () => () => {}, changed() {} },
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/js/cache.js'), context, { filename: 'cache.js' });
    vm.runInContext(`${source}\n;globalThis.__Detail = Detail;`, context, { filename: 'detail.js' });
    return { Detail: context.__Detail, jq, wpCalls, context };
}

/** 造一台已渲染 3 集网格的 Detail（对齐 home-detail.test.js 的 detail() 复位手法）。 */
function setup(D, jq, over = {}) {
    D.site = 'site-a';
    D.vodId = 'v1';
    D.vodName = '测试影片';
    D.sources = [{ from: '线路A', episodes: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }, { name: '第3集', url: 'u3' }] }];
    D.activeSource = 0;
    D._epDesc = false;
    D._epHiCache = undefined;
    Object.assign(D, over);
    jq.seed(['第1集', '第2集', '第3集']); // 模拟既有网格 DOM（renderEpisodes 的复用路径）
    D.renderEpisodes();
}

const elOf = (jq, i) => jq.registry.get(String(i));

test('A-16：有进度（currentEp=2）→ data-idx=1 按钮带 ep-hi 类，title 为「上次看到第 2 集」', async () => {
    const { Detail, jq, wpCalls } = loadDetail({ progress: { currentEp: 2, totalEps: 3, percent: 66, ts: 1 } });
    setup(Detail, jq);
    await new Promise((r) => setTimeout(r, 0)); // getWatchProgress 异步回填
    assert.equal(wpCalls.length, 1);
    assert.deepEqual(wpCalls[0], { site: 'site-a', vodId: 'v1' }, '按 site|vodId 读通用进度表');
    assert.equal(elOf(jq, 0).classes.has('ep-hi'), false, '非当前集不高亮');
    assert.equal(elOf(jq, 1).classes.has('ep-hi'), true, '当前集高亮');
    assert.equal(elOf(jq, 2).classes.has('ep-hi'), false);
    assert.equal(elOf(jq, 1).attrs.get('title'), '第2集 · 上次看到第 2 集', '悬浮可解释');
    assert.equal(elOf(jq, 0).attrs.get('title'), '第1集', '其余按钮 title 不变');
});

test('A-16：无进度记录 → 渲染零变化（无 ep-hi 类、title 保持集名）', async () => {
    const { Detail, jq, wpCalls } = loadDetail({ progress: null });
    setup(Detail, jq);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(wpCalls.length, 1, '仍会读一次进度表');
    for (let i = 0; i < 3; i++) {
        assert.equal(elOf(jq, i).classes.has('ep-hi'), false, `第 ${i + 1} 集无高亮类`);
        assert.equal(elOf(jq, i).attrs.get('title'), `第${i + 1}集`, 'title 保持纯集名');
    }
});

test('A-16：currentEp 超出当前线路集数（换线路越界）→ 宁缺勿错标', async () => {
    const { Detail, jq } = loadDetail({ progress: { currentEp: 9, totalEps: 12, percent: 70, ts: 1 } });
    setup(Detail, jq);
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 3; i++) assert.equal(elOf(jq, i).classes.has('ep-hi'), false, '越界集号不高亮任何按钮');
});

test('A-16：currentEp=0 / null 进度 → 不高亮（与无进度同口径）', async () => {
    for (const progress of [{ currentEp: 0, totalEps: 3, percent: 0, ts: 1 }, undefined]) {
        const { Detail, jq } = loadDetail({ progress });
        setup(Detail, jq);
        await new Promise((r) => setTimeout(r, 0));
        for (let i = 0; i < 3; i++) assert.equal(elOf(jq, i).classes.has('ep-hi'), false);
    }
});

test('A-16：重渲染（切倒序）→ 先清旧徽标再回填，无残留双高亮；title 还原后再覆盖', async () => {
    const { Detail, jq } = loadDetail({ progress: { currentEp: 2, totalEps: 3, percent: 66, ts: 1 } });
    setup(Detail, jq);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(elOf(jq, 1).classes.has('ep-hi'), true);
    Detail.toggleEpOrder(); // 重渲染走「清旧徽标」路径（会话缓存命中，同步回放）
    assert.equal(elOf(jq, 1).classes.has('ep-hi'), true, '会话缓存回放：徽标不闪');
    assert.equal(elOf(jq, 1).attrs.get('title'), '第2集 · 上次看到第 2 集');
    assert.ok(!elOf(jq, 0).classes.has('ep-hi') && !elOf(jq, 2).classes.has('ep-hi'), '仅单点高亮');
});

test('A-16：Records 缺失 → 静默不高亮不抛错', async () => {
    const { Detail, jq, context } = loadDetail({ progress: { currentEp: 2, totalEps: 3, percent: 66, ts: 1 } });
    vm.runInContext('Records = undefined;', context);
    setup(Detail, jq);
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 3; i++) assert.equal(elOf(jq, i).classes.has('ep-hi'), false);
});

// ── 契约守卫（源码锚点）：样式类、Bangumi 侧不做的原因、交互行为零改动 ──

test('契约：ui.css 提供 .ep-btn.ep-hi 令牌化高亮样式（背景/边框/文字色，不动尺寸）', () => {
    const css = read('src/renderer/css/ui.css');
    assert.match(css, /\.ep-btn\.ep-hi\s*\{[^}]*--accent-soft/, '高亮底色复用 --md-primary 派生令牌');
    assert.match(css, /\.ep-btn\.ep-hi\s*\{[^}]*--accent-border/, '高亮边框复用派生令牌');
});

test('契约：renderEpisodes 仍以既有 append/复用路径渲染，_applyEpHighlight 只在尾部追加调用', () => {
    const src = read('src/renderer/js/detail.js');
    // 交互行为零改动：_applyEpHighlight 不得出现在点击委托等交互链路里
    const hits = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('_applyEpHighlight'));
    assert.ok(hits.length >= 2, '定义 + renderEpisodes 调用点存在');
    for (const [, line] of hits) {
        assert.ok(!/\.on\(|addEventListener/.test(line), '高亮逻辑不挂任何交互监听');
    }
});

test('契约：Bangumi 分集页签不做本地进度高亮——其播放链路从不写 watchProgress 表', () => {
    const detailSrc = read('src/renderer/js/detail.js');
    const playerSrc = read('src/renderer/js/player.js');
    // _renderBgmEpisodes 渲染区不含高亮调用（高亮只在 CatVod renderEpisodes 链）
    const fnStart = detailSrc.indexOf('async _renderBgmEpisodes()');
    const fnEnd = detailSrc.indexOf('_syncBgmDlBar() {', fnStart);
    const bgmFn = detailSrc.slice(fnStart, fnEnd);
    assert.ok(bgmFn.includes('bgm-ep-list'), '锚点有效');
    assert.ok(!bgmFn.includes('_applyEpHighlight'), 'Bangumi 分集渲染不接本地进度高亮');
    // player.js 写进度仅在有 vodId 的 CatVod 源（_updateFavProgress 无 vodId 直接返回）；
    // Bangumi 条目 site='bangumi' / kazumi: 源无 vodId → watchProgress 表永远没有它的行
    assert.match(playerSrc, /_updateFavProgress\(meta, playlistPos[\s\S]{0,120}if \(!meta \|\| !meta\.vodId\) return;/, '进度记账准入 = 有 vodId');
});
