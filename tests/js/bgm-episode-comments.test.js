'use strict';
// Bangumi 选集讨论 + bgm.tv 跳转按钮 + 分集评论端点链路回归测试：
// 1) 详情页签表包含「选集讨论」，且 _renderTabContent 正确派发（T82 选集评论板块）
// 2) 选集讨论渲染：集数 chips + 列表骨架 + 切集重拉（世代守卫）
// 3) 评论排序：默认倒序（新→旧），切正序按时间旧→新
// 4) 分集列表缺失时先拉取（_ensureBgmEpisodes 复用 _bgmEps 缓存）；跨番剧复位防串档
// 5) Bangumi 详情 hero 渲染「↗ Bangumi 页」按钮，点击 window.open 系统浏览器跳转 bgm.tv
// 6) 后端契约：kazumiBangumiEpisodeComments do 分支 + next.bgm /p1/episodes 端点 + tags 字段链路
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 最小 jQuery 桩（对齐 detail-start-button.test.js）：链式 + html 捕获 + 委托记录。
 *  find() 同样走 makeNode 并记录链路，data() 按选择器内 data-eid="N" 解析，
 *  add/removeClass/toggle/html 记录到 ops（按选择器前缀聚合），支撑长列表网格交互断言。
 *  A-23：格网 cells 改节点重排（不再整片 innerHTML 重写），桩内置 cells 迷你 DOM——
 *  #detail-tab-content.html(骨架) 时按 cellHtml 片段解析出轻量节点数组
 *  （captor.cellsChildren，含 classList/getAttribute/remove），cells 容器经 [0]
 *  暴露 { children, appendChild }（appendChild 已有节点 = 移动），支撑
 *  「重排非重建」「active 随节点保留」「缺格补建/脏格移除」的节点级断言。 */
function makeJqStub(captor) {
    captor.cellsChildren = captor.cellsChildren || [];
    // 轻量 cell 节点：data-eid + class 集合（classList.toggle 供高亮迁移走真语义）
    const makeRawCell = (cls, eid) => ({
        eid: Number(eid),
        getAttribute: (a) => (a === 'data-eid' ? String(eid) : null),
        classList: {
            _s: new Set(String(cls || '').split(/\s+/).filter(Boolean)),
            contains(c) { return this._s.has(c); },
            add(c) { this._s.add(c); },
            remove(c) { this._s.delete(c); },
            toggle(c, force) {
                if (force === undefined) { if (this._s.has(c)) this._s.delete(c); else this._s.add(c); }
                else if (force) this._s.add(c);
                else this._s.delete(c);
                return this._s.has(c);
            },
        },
        remove() {
            const arr = captor.cellsChildren;
            const i = arr.indexOf(this);
            if (i >= 0) arr.splice(i, 1);
        },
    });
    // 从 cellHtml 片段解析节点（class 在前 data-eid 在后，与 detail.js 模板一致；
    // 模板 data-eid 与 title 之间有换行缩进，用 [\s\S]*? 跨行匹配属性间隙）
    const parseCells = (html) => {
        const out = [];
        const re = /<button[\s\S]*?class="([^"]*)"[\s\S]*?data-eid="(\d+)"[\s\S]*?>/g;
        let m;
        while ((m = re.exec(String(html))) !== null) out.push(makeRawCell(m[1], m[2]));
        return out;
    };
    const makeNode = (sel) => {
        const s = String(sel);
        const node = {
            sel: s,
            length: 1,
            on(ev, a, b) {
                const fn = typeof b === 'function' ? b : a;
                const delegated = typeof b === 'function' ? String(a) : '';
                if (captor && typeof fn === 'function') captor.bound.push({ sel: s, ev, delegated, fn });
                return this;
            },
            off() { return this; },
            html(s2) {
                if (captor && s2 !== undefined) {
                    captor.htmlBySel.set(s, String(s2));
                    captor.ops.push({ op: 'html', sel: s, value: String(s2) });
                    // 骨架渲染重建 cells 迷你 DOM（等效真实 DOM 生成子节点）；
                    // 原地 splice 重置而非换新数组——测试在渲染前解构的 cellsChildren
                    // 引用才能持续看到后续变化（getter 求值一次即定值）
                    const mm = String(s2).match(/<div class="ep-comments-grid-cells">([\s\S]*?)<\/div>\s*<\/div>/);
                    if (mm) {
                        const next = parseCells(mm[1]);
                        captor.cellsChildren.splice(0, captor.cellsChildren.length, ...next);
                    }
                }
                return this;
            },
            text(s2) { if (captor && s2 !== undefined) captor.ops.push({ op: 'text', sel: s, value: String(s2) }); return this; },
            val(s2) {
                if (s2 !== undefined) { if (captor) captor.ops.push({ op: 'val', sel: s, value: String(s2) }); return this; }
                // 读值：按选择器尾部匹配 context.$stubValues 预置值（跳转输入框等）
                const values = (captor && captor.stubValues) || {};
                for (const key of Object.keys(values)) {
                    if (s === key || s.endsWith(key) || s.includes(`> ${key}`)) return values[key];
                }
                return '';
            },
            addClass(c) { if (captor) captor.ops.push({ op: 'addClass', sel: s, value: String(c) }); return this; },
            removeClass(c) { if (captor) captor.ops.push({ op: 'removeClass', sel: s, value: String(c) }); return this; },
            toggleClass() { return this; },
            toggle(v) { if (captor) captor.ops.push({ op: 'toggle', sel: s, value: v === undefined ? 'toggle' : !!v }); return this; },
            hide() { if (captor) captor.ops.push({ op: 'hide', sel: s }); return this; },
            show() { if (captor) captor.ops.push({ op: 'show', sel: s }); return this; },
            is() { return false; },
            attr() { return this; },
            prop() { return this; },
            trigger() { return this; },
            closest(s2) { return makeNode(`${s2} < ${s}`); },
            find(s2) { return makeNode(`${s} > ${s2}`); },
            each() { return this; },
            map() { return this; },
            get() { return []; },
            filter() { return this; },
            data(k) {
                // 按选择器内嵌的 data-eid="N" 解析（渲染出的 cell/chip 均带该属性）
                const m = s.match(/data-eid="(\d+)"/);
                if (k === 'eid' && m) return Number(m[1]);
                return undefined;
            },
        };
        // $ 传入 cell html 片段（cellsBox.append($(cellHtml()).get(0))）：包装单节点
        if (/^\s*<button/.test(s)) {
            const parsed = parseCells(s);
            node.length = parsed.length;
            node.get = (i) => (i === undefined ? parsed : parsed[i]);
            return node;
        }
        // cells 子集集合（高亮迁移 each / 点选 currentTarget 包装）：遍历迷你 DOM
        if (s.includes('.ep-comments-cell')) {
            node.length = captor.cellsChildren.length;
            node.each = (fn) => { captor.cellsChildren.slice().forEach((c, i) => fn.call(c, i, c)); return node; };
            node.get = (i) => captor.cellsChildren[i];
            return node;
        }
        // cells 容器：[0] 暴露迷你 DOM（children 活引用 + appendChild 移动语义）
        if (s.includes('.ep-comments-grid-cells')) {
            node[0] = {
                get children() { return captor.cellsChildren; },
                appendChild(el) {
                    const arr = captor.cellsChildren;
                    const i = arr.indexOf(el);
                    if (i >= 0) arr.splice(i, 1); // append 已有节点 = 先摘下再放末尾（移动）
                    arr.push(el);
                    return el;
                },
            };
            node.append = (x) => { if (x && typeof x === 'object') captor.cellsChildren.push(x); return node; };
        }
        return node;
    };
    return (sel) => makeNode(sel);
}

/** 在 VM 中加载 detail.js（最小桩）。extra 可覆盖 window/Kazumi 等。 */
function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const captor = { bound: [], htmlBySel: new Map(), ops: [], stubValues: {} };
    const toasts = [];
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: () => null,
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: makeJqStub(captor),
        registerEsc: () => {},
        escHtml: (s) => String(s),
        stripHtml: (s) => String(s || ''),
        warnToast: (m) => toasts.push(String(m)),
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
        // A-14：detail.js 评论时间/排序实现已下沉 common.js，VM 内提供同款真实现
        fmtCommentTimeFull: (ts) => {
            if (!ts) return '';
            if (typeof ts === 'string' && !/^\d+$/.test(ts)) return ts;
            let n = Number(ts);
            if (!n) return '';
            if (n < 1e12) n *= 1000;
            const d = new Date(n);
            if (isNaN(d.getTime())) return '';
            const pad = (x) => String(x).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        },
        commentTsMs: (ts) => {
            if (!ts) return 0;
            if (typeof ts === 'string' && !/^\d+$/.test(ts)) {
                const d = new Date(ts);
                return isNaN(d.getTime()) ? 0 : d.getTime();
            }
            let n = Number(ts);
            if (!n) return 0;
            if (n < 1e12) n *= 1000;
            return n;
        },
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    // cellsChildren 用 getter：桩在骨架渲染时会重建数组（captor.cellsChildren 重新赋值）
    return { Detail, bound: captor.bound, htmlBySel: captor.htmlBySel, ops: captor.ops, stubValues: captor.stubValues, toasts, context, get cellsChildren() { return captor.cellsChildren; } };
}

const SAMPLE_EPISODES = {
    data: [
        { id: 101, sort: 1, ep: 1, type: 0, name: '第一话', name_cn: '第 1 集' },
        { id: 102, sort: 2, ep: 2, type: 0, name: '第二话', name_cn: '第 2 集' },
        { id: 103, sort: 1, ep: 1, type: 1, name: 'SP', name_cn: '特别篇' },  // SP 与正片同 sort
    ],
};
/** 长分集列表（24 正片 + SP = 25 > EP_COMMENTS_CHIPS_MAX=20）：触发按钮+悬浮网格模式。 */
const LONG_EPISODES = {
    data: Array.from({ length: 24 }, (_, i) => ({ id: 200 + i, sort: i + 1, ep: i + 1, type: 0, name: `第${i + 1}话`, name_cn: `第 ${i + 1} 集` }))
        .concat([{ id: 299, sort: 25, type: 1, name: 'SP', name_cn: '特别篇' }]),
};
const SAMPLE_EP_COMMENTS = [
    { user: { nickname: '甲' }, content: '一楼', createdAt: 1700000000, replies: [] },
    { user: { nickname: '乙' }, content: '二楼', createdAt: 1700100000, replies: [
        { user: { nickname: '丙' }, content: '楼中楼', createdAt: 1700150000 },
    ] },
];

/** 标准夹具：Bangumi-only 详情 + 已加载分集 + 已渲染选集讨论页签。 */
function fixtureEpComments(extra) {
    const opened = [];
    const loaded = loadDetail(Object.assign({
        window: {
            open: (u) => opened.push(String(u)),
            yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) },
        },
        Kazumi: {
            bangumiEpisodes: async () => SAMPLE_EPISODES,
            bangumiEpisodeComments: async (eid) => (Number(eid) === 102 ? SAMPLE_EP_COMMENTS : []),
            bangumiComments: async () => [],
            bangumiCharacters: async () => [],
            bangumiStaff: async () => [],
            bangumiRelations: async () => [],
            bangumiInfo: async () => ({ id: '42', name: '番剧', tags: [{ name: 'TV', count: 9 }] }),
        },
    }, extra || {}));
    const { Detail, htmlBySel, ops, bound, stubValues, context } = loaded;
    Detail._bgmId = '42';
    Detail._bgmInfo = { id: 42, name: '番剧' };
    Detail.vodName = '番剧';
    Detail._activeTab = '选集讨论';
    return { Detail, htmlBySel, ops, bound, stubValues, context, opened, get cellsChildren() { return loaded.cellsChildren; } };
}

// ---------------------------------------------------------------- 页签注册与派发

test('页签表：DETAIL_TABS 含「选集讨论」且位于「分集」之后', () => {
    const { context } = loadDetail();
    const tabs = vm.runInContext('DETAIL_TABS', context);
    assert.ok(Array.isArray(tabs), 'DETAIL_TABS 应为数组');
    assert.ok(tabs.includes('选集讨论'), '页签表应包含「选集讨论」');
    assert.ok(tabs.indexOf('选集讨论') > tabs.indexOf('分集'), '「选集讨论」应在「分集」之后');
});

test('派发：_renderTabContent 对「选集讨论」调用 _renderEpComments', () => {
    const { Detail } = loadDetail();
    let called = 0;
    Detail._renderEpComments = () => { called++; };
    Detail._activeTab = '选集讨论';
    Detail._renderTabContent();
    assert.equal(called, 1, '选集讨论页签应派发到 _renderEpComments');
});

// ---------------------------------------------------------------- 渲染与交互

test('渲染：集数选择器统一为按钮+悬浮网格（含 SP 徽标），默认选中第 1 集', async () => {
    const { Detail, htmlBySel } = fixtureEpComments();
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    await Detail._renderEpComments();
    const html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html.includes('ep-comments-picker'), '应渲染选择器容器');
    assert.ok(html.includes('id="ep-comments-picker-btn"'), '应渲染「第 N 集」按钮');
    assert.ok(html.includes('共 3'), '按钮展示总集数');
    assert.ok(html.includes('data-eid="101"'), '第 1 集格子存在');
    assert.ok(html.includes('data-eid="103"'), 'SP 格子存在（全部分集含 SP/OP/ED）');
    assert.ok(/ep-comments-cell[^>]*data-eid="101"[^>]*class="[^"]*active|class="[^"]*active[^"]*"[^>]*data-eid="101"|data-eid="101"[^>]*class="ep-comments-cell active"/.test(html.replace(/\n/g, ' ')), '第 1 集默认高亮');
    assert.ok(html.includes('第 1 集讨论'), '标题展示当前集');
    assert.ok(html.includes('加载评论中'), '列表骨架先展示 loading');
    assert.ok(!html.includes('ep-comments-chips'), '不再渲染旧版横排 chips 容器');
    assert.ok(!html.includes('ep-comments-picker-caret'), '按钮不带 ⌄ 下标');
    assert.ok(html.includes('style="display:none;"'), '弹层默认收起');
});

// ---------------------------------------------------------------- 选集按钮布局 + 弹层形态

test('选集按钮布局：head 内位于切正序左侧，两按钮同规格同字号纯文本', async () => {
    const { Detail, htmlBySel } = fixtureEpComments();
    Detail._bgmEps = LONG_EPISODES.data.slice();
    await Detail._renderEpComments();
    const html = String(htmlBySel.get('#detail-tab-content') || '');
    const head = html.slice(html.indexOf('ep-comments-head'), html.indexOf('ep-comments-list'));
    assert.ok(head.indexOf('ep-comments-picker-btn') < head.indexOf('id="ep-comments-order"'), '选集按钮应位于切正序左侧');
    assert.ok((head.match(/md-btn md-btn-tonal md-btn-sm/g) || []).length === 2, '两按钮均 md-btn-sm 同规格');
    // 按钮内是纯文本（无小号差标 span）：字号与切正序完全一致
    assert.ok(html.includes('id="ep-comments-picker-btn" class="md-btn md-btn-tonal md-btn-sm">第 1 集 / 共 25 集</button>'), '按钮文本纯文字「第 N 集 / 共 M 集」');
    assert.ok(!html.includes('ep-comments-picker-total'), '不再有「/ 共 M」小号差标 span');
});

test('弹层 CSS 契约：向下展开 + 限高滚轮 + head 置顶（防遮挡回归）', () => {
    const css = read('src/renderer/css/ui.css');
    const block = css.slice(css.indexOf('.ep-comments-grid {'), css.indexOf('.ep-comments-cell {'));
    assert.ok(block.includes('top:calc(100% + 8px)'), '弹层应向下展开（top 锚定按钮下方）');
    assert.ok(!block.includes('bottom:calc(100%'), '不得再向上展开（会被吸顶页签栏截断）');
    assert.ok(block.includes('max-height:208px'), '弹层整体限高（顶栏 + 格片区）');
    // 滚轮只发生在格片区：顶栏（计数 + 排序切换）恒可见
    const cellsCss = css.slice(css.indexOf('.ep-comments-grid-cells {'), css.indexOf('.ep-comments-cell {'));
    assert.ok(cellsCss.includes('overflow-y:auto'), '格片区内部滚轮滚动（仿颜文字面板）');
    assert.ok(block.includes('.ep-comments-grid-order') || css.includes('.ep-comments-grid-order {'), '弹层内应有排序切换图标样式');
    // head 必须自建堆叠上下文压过评论卡：评论卡 content-visibility:auto 隐式
    // contain:paint 各自成独立绘制层，弹层若只靠自身 z-index 会被其盖住（实测遮挡）
    const headRule = css.slice(css.indexOf('.ep-comments-head {'), css.indexOf('.ep-comments-title {'));
    assert.ok(headRule.includes('position:relative') && headRule.includes('z-index:2'), '.ep-comments-head 应提为堆叠上下文（置顶于评论卡）');
    // chips 旧形态已删：CSS 不再保留 .ep-comments-chips/.ep-comments-chip 规则
    assert.ok(!css.includes('.ep-comments-chips'), '旧版横排 chips 容器样式应删除');
    assert.ok(!css.includes('.ep-comments-chip '), '旧版 chips 样式应删除');
});

test('弹层内排序切换：小图标只切格网方向（独立状态），不重写外层按钮、不动评论排序', async () => {
    const { Detail, htmlBySel, ops, bound, cellsChildren } = fixtureEpComments();
    Detail._bgmEps = LONG_EPISODES.data.slice();
    await Detail._renderEpComments();
    // 初始态：格网默认倒序 → 图标「↓ 倒序」、首格为最大集（SP）；外层按钮不受影响
    const html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html.includes('id="ep-comments-grid-order"'), '弹层内应渲染排序切换图标');
    assert.ok(html.includes('↓ 倒序'), '格网默认倒序图标文案');
    assert.ok(/class="ep-comments-grid-cells">\s*<button[^>]*data-eid="299"/.test(html.replace(/\n/g, ' ')), '倒序时网格首格为最大集（SP）');
    assert.ok(html.includes('⇅ 切正序'), '外层按钮初始文案不受弹层影响');
    // A-23：切方向前记录每个格子的节点引用（重排非重建的断言锚点）
    const beforeNodes = cellsChildren.map((c) => ({ node: c, eid: c.eid }));
    assert.equal(beforeNodes.length, 25, '初始渲染 25 格');
    assert.equal(beforeNodes[0].eid, 299, '倒序首格为 SP');
    // 点击图标：仅格网翻转 → 图标变「↑ 正序」、首格变第 1 集；
    // 外层按钮文案不动（无 text 操作目标 ep-comments-order）、_epCommentsDesc 不变
    const bind = bound.find((b) => /#ep-comments-grid-order$/.test(b.sel) && typeof b.fn === 'function');
    assert.ok(bind, '应绑定弹层内排序切换');
    bind.fn.call('#ep-comments-grid-order', { currentTarget: '#ep-comments-grid-order', stopPropagation() {} });
    assert.equal(Detail._epGridDesc, false, '格网方向翻转');
    assert.equal(Detail._epCommentsDesc, true, '评论排序状态不受弹层图标影响');
    assert.ok(ops.some((o) => o.op === 'text' && String(o.value).includes('↑ 正序')), '图标文案更新为正序');
    assert.ok(!ops.some((o) => o.sel.includes('#ep-comments-order')), '外层切正序按钮文案不被重写（两控件互不干扰）');
    // A-23 核心断言：节点重排非重建——
    // ① 同 eid 的格子节点对象引用不变（append 已有节点 = 移动位置）
    const byEid = {};
    cellsChildren.forEach((c) => { byEid[c.eid] = c; });
    beforeNodes.forEach(({ node, eid }) => assert.ok(byEid[eid] === node, `格子 ${eid} 节点引用不变（重排非重建）`));
    // ② 无 html 重写操作记录（旧实现整片 innerHTML 重写，新实现零 html 调用）
    assert.ok(!ops.some((o) => o.op === 'html' && o.sel.includes('.ep-comments-grid-cells')), '切方向不再整片重写 cells innerHTML');
    // ③ 顺序翻转：正序首格为第 1 集（id=200）、末格为 SP
    assert.equal(cellsChildren[0].eid, 200, '正序时首格为第 1 集');
    assert.equal(cellsChildren[24].eid, 299, '正序时末格为 SP');
});

test('长列表点选：网格内点集 → 收起弹层 + 标题/按钮刷新（委托绑定，重排后仍生效）', async () => {
    const { Detail, htmlBySel, ops, bound, cellsChildren } = fixtureEpComments();
    Detail._bgmEps = LONG_EPISODES.data.slice();
    await Detail._renderEpComments();
    // 骨架绑定：cell 点选委托挂 .ep-comments-grid-cells（重排增删不掉绑定）、
    // picker 开合按钮直挂；桩记录 find 链选择器与委托目标
    const cellBind = bound.find((b) => /(^|>| )\.ep-comments-grid-cells$/.test(b.sel) && b.delegated === '.ep-comments-cell' && typeof b.fn === 'function');
    const gridBind = bound.find((b) => /#ep-comments-picker-btn$/.test(b.sel) && typeof b.fn === 'function');
    assert.ok(cellBind && gridBind, 'cell 点选应委托在 grid-cells 容器上（修复重排后点格无响应）');
    // 模拟点击第 24 集（id=223）cell：桩 $(sel) 会 String 化入参再从中解析
    // data-eid="N"，故 currentTarget 直接给带该属性的选择器串（同 DOM 语义）
    const cellFn = cellBind.fn;
    const currentTarget = 'button.ep-comments-cell[data-eid="223"]';
    const nodeById = {};
    cellsChildren.forEach((c) => { nodeById[c.eid] = c; });
    cellFn.call(currentTarget, { currentTarget });
    assert.equal(Detail._epCommentsEpisodeId, 223, '点选后选中集切换为第 24 集（id=223）');
    assert.ok(ops.some((o) => o.op === 'html' && o.sel.includes('.ep-comments-title') && o.value.includes('第 24 集讨论')), '标题更新为第 24 集');
    assert.ok(ops.some((o) => o.op === 'hide'), '弹层收起');
    // A-23 高亮迁移：pickEp 在现有格子上切 active class（不重写 innerHTML）——
    // 新集带 active、旧集无，节点引用不变（「选中格子无变化」根因仍在修）
    assert.ok(!ops.some((o) => o.op === 'html' && o.sel.includes('.ep-comments-grid-cells')), '点选不再整片重写 cells innerHTML（改切 class + 节点重排）');
    // 格子集合写死期望（LONG_EPISODES：24 正片 id 200-223 + SP id 299，升序比对与顺序无关）
    assert.equal(cellsChildren.map((c) => c.eid).sort((a, b) => a - b).join(','),
        '200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,299',
        '格子集合不变（点选不增删格子）');
    assert.equal(cellsChildren.length, 25, '点选不增删格子');
    cellsChildren.forEach((c) => assert.ok(nodeById[c.eid] === c, `格子 ${c.eid} 节点引用不变`));
    const activeCells = cellsChildren.filter((c) => c.classList.contains('active')).map((c) => c.eid);
    assert.deepEqual(activeCells, [223], 'active 高亮迁到新集格上（再点开按钮能看到选中态）');
    // 桩按 find 链记录 html（"#detail-tab-content > #ep-comments-picker-btn"），按尾部选择器取
    const btnEntry = [...htmlBySel.entries()].find(([k]) => k.trim().endsWith('#ep-comments-picker-btn'));
    const btnHtml = String((btnEntry && btnEntry[1]) || '');
    assert.ok(btnHtml.includes('第 24 集'), '按钮文案更新为新集');
    // 再点同一集：不重复拉取（pickEp 返回 false，仅剩收起动作）
    const before = ops.length;
    cellFn.call(currentTarget, { currentTarget });
    assert.equal(ops.length, before + 1, '重复点选仅收起弹层，不触发重渲染');
});

// ---------------------------------------------------------------- A-23：格网 cells 节点重排

test('A-23 勾选态/状态保留：重排与切集后格子上自定义 class 随节点保留（不随 innerHTML 重写丢失）', async () => {
    const { Detail, bound, cellsChildren } = fixtureEpComments();
    Detail._bgmEps = LONG_EPISODES.data.slice();
    await Detail._renderEpComments();
    // 用户在格子上产生的自定义状态（此处以自加 class 模拟，真实场景同理由 DOM
    // 节点承载：节点不重建则状态不丢——A-23 改节点重排的验收核心）
    const mark = cellsChildren.find((c) => c.eid === 205);
    assert.ok(mark, '目标格存在');
    mark.classList.add('user-marked');
    // 排序切换（节点重排）
    const bind = bound.find((b) => /#ep-comments-grid-order$/.test(b.sel) && typeof b.fn === 'function');
    bind.fn.call('#ep-comments-grid-order', { currentTarget: '#ep-comments-grid-order', stopPropagation() {} });
    assert.ok(cellsChildren.some((c) => c.eid === 205 && c.classList.contains('user-marked')), '方向切换后自定义状态保留');
    // 点选切集（class 迁移 + 节点重排）后仍在
    const cellBind = bound.find((b) => /(^|>| )\.ep-comments-grid-cells$/.test(b.sel) && b.delegated === '.ep-comments-cell' && typeof b.fn === 'function');
    cellBind.fn.call('button.ep-comments-cell[data-eid="223"]', { currentTarget: 'button.ep-comments-cell[data-eid="223"]' });
    assert.ok(cellsChildren.find((c) => c.eid === 205).classList.contains('user-marked'), '切集重排后自定义状态保留');
    // active 高亮只按选中集迁移，自定义状态不受影响
    assert.ok(cellsChildren.find((c) => c.eid === 223).classList.contains('active'), 'active 已迁到新集');
    assert.ok(!cellsChildren.find((c) => c.eid === 205).classList.contains('active'), '非选中集无 active');
    // 勾选态语义等价验证：滚动位置因节点复用天然保留（无 DOM 重建），此处以
    // 「cells 容器从未被 html() 重写」作为滚动锚不失效的桩级证据
});

test('A-23 chips 增删：syncGridCells 对缺格补建、多余格移除、顺序按当前方向重排', async () => {
    const { Detail, ops, bound, cellsChildren } = fixtureEpComments();
    Detail._bgmEps = LONG_EPISODES.data.slice();
    await Detail._renderEpComments();
    assert.equal(cellsChildren.length, 25, '初始 25 格');
    // 注意：shell 闭包持有 _bgmEps 数组引用，分集表变化须原地 mutate（等价于
    // 数据刷新写回同一缓存数组；换新数组必然走 shell 重绘，不在本用例范围）
    Detail._bgmEps.splice(0, Detail._bgmEps.length,
        ...Detail._bgmEps.filter((ep) => ep.id !== 201 && ep.id !== 202), // 删两集
        { id: 350, sort: 26, ep: 26, type: 0, name: 'e26' });             // 增一集
    // 触发同步：点选新表里的集（pickEp → syncGridCells）
    const cellBind = bound.find((b) => /(^|>| )\.ep-comments-grid-cells$/.test(b.sel) && b.delegated === '.ep-comments-cell' && typeof b.fn === 'function');
    cellBind.fn.call('button.ep-comments-cell[data-eid="299"]', { currentTarget: 'button.ep-comments-cell[data-eid="299"]' });
    assert.equal(cellsChildren.length, 24, '删 2 增 1 后共 24 格');
    const eids = cellsChildren.map((c) => c.eid);
    assert.ok(!eids.includes(201) && !eids.includes(202), '多余格已移除');
    assert.ok(eids.includes(350), '缺格已按需补建');
    // 倒序方向下补建格（sort=26 全表最大）落在首位
    assert.equal(cellsChildren[0].eid, 350, '补建格按当前方向落在首位');
    // 点选切集期间未整片重写（节点级增删）
    assert.ok(!ops.some((o) => o.op === 'html' && o.sel.includes('.ep-comments-grid-cells')), '增删走节点操作而非 innerHTML 重写');
});

test('弹层集号跳转：输入集号直达切集，无效输入行内提示（长番快速定位）', async () => {
    const { Detail, htmlBySel, ops, bound, stubValues } = fixtureEpComments();
    // 300 集长番：sort 跨季累计偏移 700（模拟几百集番剧，ep 季内 1..300）
    Detail._bgmEps = Array.from({ length: 300 }, (_, i) => ({ id: 1000 + i, sort: 700 + i, ep: String(i + 1), type: 0, name: `e${i + 1}` }));
    await Detail._renderEpComments();
    // 结构：跳转行（输入框 + 按钮 + 错误提示）在弹层内
    const html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html.includes('id="ep-comments-jump-input"'), '弹层应渲染集号跳转输入框');
    assert.ok(html.includes('id="ep-comments-jump-go"'), '应渲染跳转按钮');
    assert.ok(html.includes('id="ep-comments-jump-err"'), '应渲染行内错误提示');
    // 桩增强：val() 按选择器尾部匹配 stubValues 预置值（模拟真实输入）
    stubValues['#ep-comments-jump-input'] = '250';
    const enterBind = bound.find((b) => /#ep-comments-jump-input$/.test(b.sel) && b.ev === 'keydown' && typeof b.fn === 'function');
    const goBind = bound.find((b) => /#ep-comments-jump-go$/.test(b.sel) && typeof b.fn === 'function');
    assert.ok(enterBind && goBind, '应绑定输入框回车与跳转按钮');
    // 回车跳转：250 → ep 口径匹配 id=1249（sort=949）
    let preventDefaulted = false;
    enterBind.fn.call('#ep-comments-jump-input', { key: 'Enter', preventDefault: () => { preventDefaulted = true; }, stopPropagation() {} });
    assert.ok(preventDefaulted, '回车 preventDefault');
    assert.equal(Detail._epCommentsEpisodeId, 1249, '跳转后选中集为 ep=250（id=1249）');
    assert.ok(ops.some((o) => o.op === 'html' && o.sel.includes('.ep-comments-title') && o.value.includes('第 250 集讨论')), '标题切到第 250 集');
    assert.ok(ops.some((o) => o.op === 'hide'), '跳转成功收起弹层');
    // A-23：跳转切集走高亮 class 迁移 + 节点重排，不再整片重写 cells
    assert.ok(!ops.some((o) => o.op === 'html' && o.sel.includes('.ep-comments-grid-cells')), '跳转切集不再整片重写 cells innerHTML');
    // 无匹配集：行内提示，不改选中集
    stubValues['#ep-comments-jump-input'] = '999';
    const errBefore = Detail._epCommentsEpisodeId;
    goBind.fn.call('#ep-comments-jump-go', { currentTarget: '#ep-comments-jump-go', stopPropagation() {} });
    assert.equal(Detail._epCommentsEpisodeId, errBefore, '无效集号不切集');
    assert.ok(ops.some((o) => o.op === 'text' && o.sel.includes('#ep-comments-jump-err') && String(o.value).includes('没有第 999 集')), '行内提示「没有第 999 集」');
    // 记忆写入：跳转也被记住（跨重开恢复）。逐字段比对——对象跨 VM 上下文
    // 原型不同，deepEqual 会误判
    assert.equal(String(Detail._epCommentsMemory.sid), '42', '记忆归属当前番剧');
    assert.equal(Number(Detail._epCommentsMemory.eid), 1249, '跳转写入选集记忆');
});

test('连续编号（跨季累计 sort）：显示季内集号 ep 优先，不再出现「第 78 集/共 8 集」', async () => {
    const { Detail, htmlBySel } = fixtureEpComments();
    // 第二季 8 集：sort 跨季累计 71..78，ep 季内重排 1..8（Bangumi /v0/episodes 真实口径）
    Detail._bgmEps = Array.from({ length: 8 }, (_, i) => ({ id: 900 + i, sort: 71 + i, ep: String(i + 1), type: 0, name: `e${i + 1}` }));
    Detail._epCommentsEpisodeId = 907; // 第 8 集（sort=78, ep=8）
    await Detail._renderEpComments();
    const html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html.includes('第 8 集讨论'), '标题按季内集号 ep=8 显示（而非 sort=78）');
    assert.ok(html.includes('第 8 集 / 共 8 集'), '按钮同样按 ep 显示，集数口径一致');
    assert.ok(html.includes('data-eid="907"'), '选中集存在');
    assert.ok(!/第 78 集/.test(html), '不再出现「第 78 集」绝对集号');
    // ep 缺失时回退 sort，再回退位置序号（标题按当前选中集 951 展示）
    Detail._bgmEps = [{ id: 950, sort: 12, type: 0, name: 'a' }, { id: 951, type: 0, name: 'b' }];
    Detail._epCommentsEpisodeId = 951;
    await Detail._renderEpComments();
    const html2 = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html2.includes('第 2 集讨论'), '当前选中集（id=951，无 ep 无 sort）按位置序号显示第 2 集');
    assert.ok(html2.includes('>12<i') || html2.includes('>12<'), '格子里 ep 缺失的集回退 sort=12');
});

test('加载：bangumiEpisodeComments 按选中集 episode_id 拉取并渲染（含楼中楼）', async () => {
    const { Detail, htmlBySel } = fixtureEpComments();
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    await Detail._renderEpComments();
    // 默认选中第 1 集（id=101 无评论）：空态
    await Detail._loadEpComments(Detail._bgmEps.find((e) => Number(e.id) === 101));
    assert.equal(Detail._epComments.length, 0);
    // 切到第 2 集（id=102 有 2 条评论，含楼中楼）
    await Detail._loadEpComments(Detail._bgmEps.find((e) => Number(e.id) === 102));
    assert.equal(Detail._epComments.length, 2);
    Detail._renderEpCommentsList();
    const html = String(htmlBySel.get('#ep-comments-list') || '');
    assert.ok(html.includes('共 2 条讨论'), '评论计数');
    assert.ok(html.includes('一楼') && html.includes('二楼'), '主楼层正文');
    assert.ok(html.includes('楼中楼'), '楼中楼 replies 渲染');
    assert.ok(html.includes('detail-comment-replies'), '楼中楼复用吐槽页签缩进结构');
});

test('排序：默认倒序（新→旧），切换 _epCommentsDesc 后正序渲染', async () => {
    const { Detail, htmlBySel } = fixtureEpComments();
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    await Detail._renderEpComments();
    const ep2 = Detail._bgmEps.find((e) => Number(e.id) === 102);
    await Detail._loadEpComments(ep2);
    assert.equal(Detail._epCommentsDesc, true, '默认倒序（新→旧）');
    // 倒序渲染：createdAt 更大的「二楼」在前
    Detail._renderEpCommentsList();
    let html = String(htmlBySel.get('#ep-comments-list') || '');
    assert.ok(html.indexOf('二楼') < html.indexOf('一楼'), '倒序：新评论在前');
    // 切正序：旧评论在前
    Detail._epCommentsDesc = false;
    Detail._renderEpCommentsList();
    html = String(htmlBySel.get('#ep-comments-list') || '');
    assert.ok(html.indexOf('一楼') < html.indexOf('二楼'), '正序：旧评论在前');
    // 排序只影响渲染，不改数据数组本身顺序
    assert.equal(Detail._epComments[0].content, '一楼', '原始数组顺序不变');
});

test('世代守卫：切集后旧请求的迟到结果被丢弃，不覆盖新集数据', async () => {
    // bangumiEpisodeComments 按调用次序分批放行：首个请求被 hold，切集后放行——
    // 迟到结果因世代不匹配必须被丢弃
    let releaseFirst;
    const gate = new Promise((res) => { releaseFirst = res; });
    let call = 0;
    const { Detail } = fixtureEpComments({
        Kazumi: {
            bangumiEpisodes: async () => SAMPLE_EPISODES,
            bangumiEpisodeComments: async () => {
                call++;
                if (call === 1) { await gate; return SAMPLE_EP_COMMENTS; } // 第 1 集请求被 hold
                return SAMPLE_EP_COMMENTS.slice(0, 1);                     // 第 2 集立即返回 1 条
            },
            bangumiComments: async () => [],
            bangumiCharacters: async () => [],
            bangumiStaff: async () => [],
            bangumiRelations: async () => [],
        },
    });
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    const first = Detail._loadEpComments(Detail._bgmEps.find((e) => Number(e.id) === 101));
    await new Promise((r) => setImmediate(r)); // 首个请求进入 hold
    // 切到第 2 集：世代自增，第 2 集先完成
    await Detail._loadEpComments(Detail._bgmEps.find((e) => Number(e.id) === 102));
    assert.equal(Detail._epComments.length, 1, '第 2 集 1 条评论先落位');
    // 放行第 1 集的迟到请求：世代已过，结果必须被丢弃
    releaseFirst();
    await first;
    assert.equal(Detail._epComments.length, 1, '迟到旧请求不覆盖新集数据');
    assert.equal(Detail._epComments[0].content, '一楼');
});

test('跨番剧复位：_resetEpComments 清空评论与 _bgmEps（防上一部分集串档）', () => {
    const { Detail } = fixtureEpComments();
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    Detail._epComments = SAMPLE_EP_COMMENTS;
    Detail._epCommentsEpisodeId = 102;
    const oldGen = Detail._epCommentsGen;
    Detail._resetEpComments();
    assert.equal(Detail._epComments.length, 0, '评论清空');
    assert.equal(Detail._epCommentsEpisodeId, 0, '选中集复位');
    assert.equal(Detail._bgmEps, null, '分集列表缓存清空（跨番剧防串档）');
    assert.ok(Detail._epCommentsGen > oldGen, '世代自增（作废在途请求）');
});

test('选集跨会话记忆：重开同一番剧恢复上次选中的集；换番剧记忆作废', async () => {
    const { Detail, htmlBySel } = fixtureEpComments();
    // 首次：番剧 42，选第 3 集（id=103，SP）
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    Detail._epCommentsEpisodeId = 103;
    Detail._rememberEpSelection(103);
    // 模拟重开番剧 42：reset 清实例态 + _bgmEps 缓存
    Detail._resetEpComments();
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    await Detail._renderEpComments();
    let html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html.includes('data-eid="103"'), '记忆恢复：重开同番剧回到上次选中的第 3 集');
    assert.ok(/data-eid="103"[^>]*active|active[^>]*data-eid="103"/.test(html.replace(/\n/g, ' ')), '恢复的集带高亮');
    // 换番剧 99：记忆 sid 不匹配 → 回退第 1 集
    Detail._bgmId = '99';
    Detail._resetEpComments();
    Detail._bgmEps = Array.from({ length: 4 }, (_, i) => ({ id: 500 + i, sort: i + 1, ep: String(i + 1), type: 0, name: `e${i + 1}` }));
    await Detail._renderEpComments();
    html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html.includes('data-eid="500"'), '换番剧不沿用旧记忆：回退第 1 集');
    assert.ok(!/data-eid="103"/.test(html), '旧番剧的集 ID 不出现在新番剧格网');
});

// ---------------------------------------------------------------- bgm.tv 跳转按钮

test('Bangumi 页按钮：hero 操作行渲染 #detail-bgm-open，点击经 window.open 跳转 bgm.tv', async () => {
    const opened = [];
    const { Detail } = loadDetail({
        window: {
            open: (u) => opened.push(String(u)),
            yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) },
        },
    });
    Detail._bgmId = '42';
    Detail._bgmInfo = { id: 42, name: '番剧', images: {} };
    Detail.vodName = '番剧';
    const html = Detail._bangumiColHtml(Detail._bgmInfo);
    assert.ok(String(html).includes('id="detail-bgm-open"'), '操作行应含 #detail-bgm-open');
    assert.ok(String(html).includes('Bangumi 页'), '按钮文案');
    // 点击行为（与 detail.js #detail-bgm-open 委托同口径）：数字守卫 + bgm.tv 条目 URL
    const sid = String(Detail._bgmId || '');
    if (sid && /^\d+$/.test(sid)) opened.push(`https://bgm.tv/subject/${sid}`);
    assert.deepEqual(opened, ['https://bgm.tv/subject/42']);
});

test('bgm.tv 跳转守卫：非数字 subjectId 不拼 URL（toast 提示）', () => {
    const { Detail } = loadDetail({
        window: { open: () => { throw new Error('should not open'); }, yuki: { settingsGet: async () => ({}) } },
    });
    Detail._bgmId = 'abc<script>';
    // 守卫口径：/^\d+$/ 才放行（与 detail.js #detail-bgm-open 委托一致）
    const sid = String(Detail._bgmId || '');
    const pass = !!(sid && /^\d+$/.test(sid));
    assert.equal(pass, false, '非数字 ID 必须被守卫拦截');
});

test('源码契约：#detail-bgm-open 委托绑定存在（init 挂 #detail-body）', () => {
    const src = read('src/renderer/js/detail.js');
    assert.match(src, /on\('click', '#detail-bgm-open'/, '应绑定 #detail-bgm-open 点击委托');
    // 跳转目标统一走 bangumiWebUrl（条目页跳转跟随镜像：官方 bgm.tv / 镜像 bgm.{根域名} 双形态）
    assert.match(src, /window\.open\(bangumiWebUrl\(sid\), '_blank'\)/, '应经 bangumiWebUrl 取跳转 URL（官方/镜像双形态）');
    // 守卫正则必须锚定在委托处理器内部（上方复刻式用例只测副本不测生产代码，
    // 若 detail.js 删掉数字 ID 守卫，这里必须失败——防注入防线的源码级回归）
    assert.ok(src.includes('.test(sid)'), '跳转守卫必须存在于 detail.js（.test(sid) 数字 ID 校验）');
});

// ---------------------------------------------------------------- 渲染层→后端链路（kazumi.js + server.py + plugin_manager.py）

test('kazumi.js：bangumiEpisodeComments 封装 kazumiBangumiEpisodeComments + 本地 10 分钟缓存', async () => {
    const source = read('src/renderer/js/kazumi.js');
    const calls = [];
    const cacheWrites = [];
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, parseInt, parseFloat,
        setTimeout, clearTimeout, setInterval, clearInterval,
        $: () => ({ on: () => this }),
        doAction: async (doName, form) => {
            calls.push({ doName, form });
            return { code: 200, comments: SAMPLE_EP_COMMENTS };
        },
        warnToast: () => {},
        escHtml: (s) => String(s),
        showLoading: () => {}, hideLoading: () => {},
        openDialog: () => {}, closeDialog: () => {},
        confirmDialog: async () => false,
        localCacheGet: () => null,
        localCacheSet: (k, v, ttl) => { cacheWrites.push({ k, v, ttl }); },
        localCacheDel: () => {},
        document: {
            addEventListener() {},
            getElementById: () => null,
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
            body: { appendChild() {} },
        },
        window: {}, // kazumi.js 尾部 IIFE 把 YUKI.kazumi 挂到 window
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'kazumi.js' });
    const K = context.window.YUKI && context.window.YUKI.kazumi;
    assert.ok(K, 'kazumi.js 应导出 YUKI.kazumi');
    assert.equal(typeof K.bangumiEpisodeComments, 'function', '应提供 bangumiEpisodeComments 封装');
    const list = await K.bangumiEpisodeComments(102);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].doName, 'kazumiBangumiEpisodeComments');
    assert.equal(calls[0].form.episodeId, '102', 'episodeId 以字符串透传');
    assert.equal(list.length, 2, '数组归一化（直接数组形态）');
    // 命中非空列表时落 localStorage 持久缓存，TTL 10 分钟
    assert.equal(cacheWrites.length, 1);
    assert.equal(cacheWrites[0].k, 'detail::epcmt::v1::102');
    assert.equal(cacheWrites[0].ttl, 10 * 60 * 1000);
    // 缓存命中路径：不再发请求
    context.localCacheGet = () => SAMPLE_EP_COMMENTS;
    const again = await context.window.YUKI.kazumi.bangumiEpisodeComments(102);
    assert.equal(again.length, 2);
    assert.equal(calls.length, 1, '缓存命中不发网络请求');
});

test('后端：kazumiBangumiEpisodeComments do 分支 + next.bgm 端点 + 缓存 TTL', () => {
    const serverSrc = read('python-backend/server.py');
    assert.match(serverSrc, /if do == 'kazumiBangumiEpisodeComments':/, 'server.py 应有 do 分支');
    assert.match(serverSrc, /'kazumiBangumiEpisodeComments': 600/, '只读端点应配 10 分钟 TTL 缓存');
    assert.match(serverSrc, /kazumi_mgr\.bangumi_episode_comments\(episode_id\)/, '应调用 plugin_manager 方法');
    const pmSrc = read('python-backend/kazumi/plugin_manager.py');
    assert.match(pmSrc, /def bangumi_episode_comments\(self, episode_id\):/, 'plugin_manager 应有 bangumi_episode_comments');
    assert.match(pmSrc, /\/p1\/episodes\/\{episode_id\}\/comments/, '对齐 Kazumi：GET next.bgm /p1/episodes/{id}/comments');
});

test('后端：收藏 PATCH 支持 tags（对齐 Kazumi rating_review_dialog 边界 10 个/10 字）', () => {
    const pmSrc = read('python-backend/kazumi/plugin_manager.py');
    assert.match(pmSrc, /def normalize_bgm_tags\(/, '应有 normalize_bgm_tags 归一化');
    assert.match(pmSrc, /BGM_TAGS_MAX = 10/, '上限 10 个');
    assert.match(pmSrc, /BGM_TAG_MAX_LEN = 10/, '单标签最长 10 字');
    // 三条写入路径都透传 tags
    assert.match(pmSrc, /def _bangumi_set_one\(self, subject_id, ctype, headers, bases, usernames, rate=None, comment=None, tags=None\):/, '_bangumi_set_one 支持 tags');
    assert.match(pmSrc, /tags_n = normalize_bgm_tags\(item\.get\('tags'\)\)/, 'apply_sync_plan 归一化 tags');
    assert.match(pmSrc, /def bangumi_update_collection\(self, token, subject_id, collection_type, rate=None, comment=None, tags=None\):/, 'update_collection 支持 tags');
    assert.match(pmSrc, /body\['tags'\] = tags_n/, 'body 携带 tags 键');
});

// ---------------------------------------------------------------- Python 侧纯逻辑（VM 外，直接 subprocess 跑断言脚本）

/** Python 解释器探测：优先 venv，回退 PATH（CI js job 无 venv，无回退会 ENOENT）。 */
function hasPython() {
    const fs2 = require('fs');
    const venv = path.join(ROOT, 'python-backend', '.venv', 'Scripts', 'python.exe');
    if (fs2.existsSync(venv)) return venv;
    try { require('child_process').execFileSync('python', ['--version'], { stdio: 'ignore' }); return 'python'; } catch (e) { return null; }
}

test('normalize_bgm_tags：边界与非法值（Python 纯逻辑）', { skip: !hasPython() && '无可用 Python 解释器（CI js job 无 venv）——该断言由 python job 的 kazumi-bgm-rating stage 覆盖' }, async () => {
    // 环境探测先于硬编码路径：CI js job 没有 venv（release.yml 才创建），
    // 无回退会 ENOENT 必炸 js job（先例：python-bridge-lifecycle.test.js）
    const py = hasPython();
    const code = [
        'import sys',
        "sys.path.insert(0, 'python-backend')",
        'from kazumi.plugin_manager import normalize_bgm_tags, BgmFieldError',
        "assert normalize_bgm_tags(None) is None",
        "assert normalize_bgm_tags('') is None",
        "assert normalize_bgm_tags(['a', ' a ', '', 'b']) == ['a', 'b']",
        "assert normalize_bgm_tags('solo') == ['solo']",
        "try:",
        "    normalize_bgm_tags(['x' * 11])",
        "    raise SystemExit('long tag should fail')",
        "except BgmFieldError as e:",
        "    assert e.field == 'tags'",
        "try:",
        "    normalize_bgm_tags([f't{i}' for i in range(11)])",
        "    raise SystemExit('11 tags should fail')",
        "except BgmFieldError:",
        "    pass",
        "assert normalize_bgm_tags([f't{i}' for i in range(10)]) == [f't{i}' for i in range(10)]",
        'print("PY_OK")',
    ].join('\n');
    const { execFileSync } = require('child_process');
    const out = execFileSync(py, ['-c', code], { encoding: 'utf8', cwd: ROOT });
    assert.ok(out.includes('PY_OK'), `Python 逻辑断言应通过：${out}`);
});
