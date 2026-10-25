'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/**
 * Bangumi 搜索「筛选条件」弹窗的取值限制与显示文案单测（vm 沙箱，无真实 DOM/网络）。
 * 覆盖：评分 1-10 / 排名 1-10000 的夹取与交叉约束（纯函数）、星期显示文案映射
 * （取值仍是 1-7）、空=不限 语义、以及「非法输入不进入请求参数」的 apply 链路。
 */

const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/bangumi-search.js'), 'utf8');

/** 迷你 DOM 桩：$ 按选择器返回可链式对象，状态存在 Map 里，供断言读取。 */
function makeStub() {
    const nodes = new Map();
    const handlers = [];
    const rec = (sel) => {
        if (!nodes.has(sel)) {
            nodes.set(sel, { value: '', checked: false, attrs: {}, text: '', html: '', visible: true, cls: new Set() });
        }
        return nodes.get(sel);
    };
    const mk = (sel) => {
        const o = {
            on(evt, a, b) { handlers.push({ evt, sel: typeof a === 'function' ? '' : String(a), fn: typeof a === 'function' ? a : b }); return o; },
            off() { return o; },
            empty() { return o; },
            each() { return o; },
            first() { return o; },
            removeClass() { return o; },
            addClass() { return o; },
            toggleClass() { return o; },
            trigger() { return o; },
            show() { return o; },
            hide() { return o; },
            find() { return mk(sel + ' *'); },
            data() { return ''; },
            css() { return o; },
            val(v) { if (v === undefined) return rec(sel).value; rec(sel).value = String(v); return o; },
            text(v) { if (v === undefined) return rec(sel).text; rec(sel).text = String(v); return o; },
            html(v) { if (v === undefined) return rec(sel).html; rec(sel).html = String(v); return o; },
            prop(name, v) { if (v === undefined) return rec(sel)[name]; rec(sel)[name] = v; return o; },
            attr(name, v) {
                if (v === undefined) return rec(sel).attrs[name];
                if (v === null) delete rec(sel).attrs[name];
                else rec(sel).attrs[name] = String(v);
                return o;
            },
            toggle(flag) { rec(sel).visible = (flag === undefined) ? !rec(sel).visible : !!flag; return o; },
        };
        return o;
    };
    const $ = (sel) => mk(typeof sel === 'string' ? sel : String(sel));
    return {
        $,
        handlers,
        setVal: (sel, v) => { rec(sel).value = String(v); },
        getVal: (sel) => rec(sel).value,
        setChecked: (sel, v) => { rec(sel).checked = !!v; },
        getText: (sel) => rec(sel).text,
        getHtml: (sel) => rec(sel).html,
        getAttr: (sel, name) => rec(sel).attrs[name],
        isShown: (sel) => rec(sel).visible,
        /** 找到 sel 含关键词的已注册处理器并触发（模拟弹窗事件）。 */
        fire(evt, selPart, event) {
            const hit = handlers.filter((h) => h.evt === evt && h.sel.includes(selPart));
            assert.ok(hit.length > 0, `未注册 ${evt} → ${selPart} 处理器`);
            hit.forEach((h) => h.fn(event || {}));
        },
    };
}

function loadSearch() {
    const stub = makeStub();
    const fake = { draft: null };
    const captured = { calls: [], params: null, action: null };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Boolean, Error,
        parseInt, parseFloat, Number, RegExp, isNaN, isFinite,
        setTimeout, clearTimeout,
        $: stub.$,
        doAction: async (action, params) => {
            captured.calls.push(action);
            captured.action = action;
            captured.params = params;
            return { items: [], total: 0 };
        },
        warnToast: () => {}, showLoading: () => {}, hideLoading: () => {},
        renderPagerBox: () => {}, pageSizeOf: async () => 20,
        bangumiCard: (item) => `<div data-id="${item.id}"></div>`,
        escHtml: (s) => String(s), fitVodTitles: () => {},
        openDialog: () => {}, closeDialog: () => { fake.draft = 'closed'; },
        App: {}, Kazumi: {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(
        `${SOURCE}\n;globalThis.__B = BangumiSearch; globalThis.__P = BangumiSearchParser;
         globalThis.__H = { bgmClampBound, bgmNormalizeRange, bgmRangeHint, bgmWeekdayLabel,
                            bgmWeekdaysText, bgmFmtNum, BGM_SCORE_LIMIT, BGM_RANK_LIMIT };`,
        context, { filename: 'bangumi-search.js' });
    return { B: context.__B, P: context.__P, H: context.__H, stub, captured, fake };
}

/** VM 上下文里构造的对象原型来自不同 realm，deepStrictEqual 会误判；用 JSON 规范化比较。 */
function deepEq(actual, expected, msg) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);
}

const emptyDraft = () => ({
    id: '', keyword: '', tags: [], sort: 'heat', season: '',
    dateRange: null, rankRange: null, scoreRange: null, weekdays: [],
});

// ── 星期显示文案（只改显示，不改取值）────────────────────────────────

test('星期文案映射：1-7 → 周一…周日，非法值不猜（空串）', () => {
    const { H } = loadSearch();
    assert.equal([1, 2, 3, 4, 5, 6, 7].map(H.bgmWeekdayLabel).join(','), '周一,周二,周三,周四,周五,周六,周日');
    assert.equal(H.bgmWeekdayLabel(0), '', '0 无对应星期（取值域是 1-7）');
    assert.equal(H.bgmWeekdayLabel(8), '');
    assert.equal(H.bgmWeekdayLabel('x'), '');
    assert.equal(H.bgmWeekdaysText([1, 7]), '周一,周日');
});

test('weekday 取值/序列化仍是 1-7 数字（显示文案改动不碰存储与请求参数）', () => {
    const { P, B, stub, captured } = loadSearch();
    assert.equal(P.fromFilterState({ weekdays: [1, 7], tags: [] }), 'weekday:1,7');
    deepEq(P.parseWeekdays('weekday:1,7'), [1, 7]);
    // chip 文案换「周X」，但删除分支仍按 kind=weekday 生效
    B._state = Object.assign(emptyDraft(), { weekdays: [1, 7] });
    B._renderChips();
    const chipHtml = stub.getHtml('#bgm-search-chips');
    assert.ok(chipHtml.includes('星期: 周一,周日'), `chip 应显示周X，实际：${chipHtml}`);
    assert.ok(chipHtml.includes('data-kind="weekday"'), 'weekday chip 删除入口保留');
    assert.equal(chipHtml.includes('星期: 1,7'), false);
    assert.equal(captured.calls.length, 0, '仅重绘 chip 不发请求');
});

// ── 评分/排名夹取（纯函数）──────────────────────────────────────────

test('评分硬限制 1-10：0/负数夹到 1，>10 夹到 10，保留 1 位小数', () => {
    const { H } = loadSearch();
    const L = H.BGM_SCORE_LIMIT;
    assert.equal(H.bgmClampBound('0', L), 1, '0 不合法（不允许出现 0）');
    assert.equal(H.bgmClampBound('-3', L), 1);
    assert.equal(H.bgmClampBound('15', L), 10);
    assert.equal(H.bgmClampBound('100', L), 10);
    assert.equal(H.bgmClampBound('1', L), 1);
    assert.equal(H.bgmClampBound('10', L), 10);
    assert.equal(H.bgmClampBound('7.25', L), 7.3, '显示口径 1 位小数');
    assert.equal(H.bgmClampBound('7.5', L), 7.5);
});

test('排名硬限制 1-10000（1 = 最靠前，语义不反转），取整', () => {
    const { H } = loadSearch();
    const L = H.BGM_RANK_LIMIT;
    assert.equal(H.bgmClampBound('0', L), 1, '排名 1 是最小合法值');
    assert.equal(H.bgmClampBound('1', L), 1);
    assert.equal(H.bgmClampBound('5000', L), 5000);
    assert.equal(H.bgmClampBound('10000', L), 10000);
    assert.equal(H.bgmClampBound('10001', L), 10000);
    assert.equal(H.bgmClampBound('12.6', L), 13, '排名取整');
});

test('空/非法 = 不限（null），不会被 NaN 污染', () => {
    const { H } = loadSearch();
    [H.BGM_SCORE_LIMIT, H.BGM_RANK_LIMIT].forEach((L) => {
        assert.equal(H.bgmClampBound('', L), null);
        assert.equal(H.bgmClampBound('   ', L), null);
        assert.equal(H.bgmClampBound(null, L), null);
        assert.equal(H.bgmClampBound(undefined, L), null);
        assert.equal(H.bgmClampBound('abc', L), null, 'bad-input 文本按空处理');
    });
});

test('区间交叉约束：编辑侧优先、另一侧被顶到同值；不限侧不参与', () => {
    const { H } = loadSearch();
    deepEq(H.bgmNormalizeRange('min', 9, 3), { min: 9, max: 9 }, '编辑最低 → 最高被顶上去');
    deepEq(H.bgmNormalizeRange('max', 9, 3), { min: 3, max: 3 }, '编辑最高 → 最低被顶下来');
    deepEq(H.bgmNormalizeRange('min', 7, 10), { min: 7, max: 10 }, '合法区间原样');
    deepEq(H.bgmNormalizeRange('min', null, 3), { min: null, max: 3 }, '最低不限 → 不施加约束');
    deepEq(H.bgmNormalizeRange('max', 5, null), { min: 5, max: null }, '最高不限 → 不施加约束');
});

test('空态提示：全空显示「不限」，单侧空显示「不限」', () => {
    const { H } = loadSearch();
    assert.equal(H.bgmRangeHint(null, null), '不限');
    assert.equal(H.bgmRangeHint(7, 10, H.bgmFmtNum), '7 - 10');
    assert.equal(H.bgmRangeHint(null, 10, H.bgmFmtNum), '不限 - 10');
    assert.equal(H.bgmRangeHint(1, 5000), '1 - 5000');
});

// ── 控件读取：非法值进不了草稿 ─────────────────────────────────────

test('_readScoreFromDom / _readRankFromDom：控件里的越界值当场夹取', () => {
    const { B, stub } = loadSearch();
    stub.setVal('#bgm-score-min', '0');
    stub.setVal('#bgm-score-max', '999');
    deepEq(B._readScoreFromDom('min'), { min: 1, max: 10 });

    stub.setVal('#bgm-rank-min', '0');
    stub.setVal('#bgm-rank-max', '100000');
    deepEq(B._readRankFromDom('min'), { min: 1, max: 10000 });

    stub.setVal('#bgm-score-min', '');
    stub.setVal('#bgm-score-max', '');
    deepEq(B._readScoreFromDom('min'), { min: null, max: null }, '两侧留空 = 不限');
});

test('_readDateFromDom：只填一侧自动跟随（单日），反序时编辑侧优先', () => {
    const { B, stub } = loadSearch();
    stub.setVal('#bgm-date-start', '2026-03-01');
    stub.setVal('#bgm-date-end', '');
    deepEq(B._readDateFromDom('start'), { start: '2026-03-01', end: '2026-03-01' });

    stub.setVal('#bgm-date-start', '');
    stub.setVal('#bgm-date-end', '2026-03-02');
    deepEq(B._readDateFromDom('end'), { start: '2026-03-02', end: '2026-03-02' });

    stub.setVal('#bgm-date-start', '2026-05-01');
    stub.setVal('#bgm-date-end', '2026-01-01');
    deepEq(B._readDateFromDom('end'), { start: '2026-01-01', end: '2026-01-01' }, '编辑结束日 → 开始日被顶');
    deepEq(B._readDateFromDom('start'), { start: '2026-05-01', end: '2026-05-01' }, '编辑开始日 → 结束日被顶');

    stub.setVal('#bgm-date-start', '');
    stub.setVal('#bgm-date-end', '');
    assert.equal(B._readDateFromDom('start'), null, '两侧都空 = 不限日期');
});

// ── apply 链路：非法输入不进入请求参数 ───────────────────────────────

test('apply：控件停在非法/未提交态，参数仍只有合法值（评分/排名/日期）', async () => {
    const { B, stub, captured } = loadSearch();
    B._draft = emptyDraft();
    stub.setChecked('#bgm-score-toggle', true);
    stub.setVal('#bgm-score-min', '0');
    stub.setVal('#bgm-score-max', '999');
    stub.setChecked('#bgm-rank-toggle', true);
    stub.setVal('#bgm-rank-min', '0');
    stub.setVal('#bgm-rank-max', '100000');
    stub.setVal('#bgm-date-start', '2026-05-01');
    stub.setVal('#bgm-date-end', '2026-01-01');

    B._commitDraftFromDom();
    deepEq(B._draft.scoreRange, { min: 1, max: 10 });
    deepEq(B._draft.rankRange, { min: 1, max: 10000 });
    deepEq(B._draft.dateRange, { start: '2026-05-01', end: '2026-05-01' }, '反序日期被夹成单日');

    B._state = Object.assign({}, B._draft);
    await B.load(1);
    assert.equal(captured.action, 'kazumiBangumiSearchFilter');
    assert.equal(captured.params.scoreMin, 1);
    assert.equal(captured.params.scoreMax, 10);
    assert.equal(captured.params.rankMin, 1);
    assert.equal(captured.params.rankMax, 10000);
    assert.equal(captured.params.dateStart, '2026-05-01');
    assert.equal(captured.params.dateEnd, '2026-05-01');
});

test('apply：开关关闭 = 不启用（控件残留值不参与请求参数）', async () => {
    const { B, stub, captured } = loadSearch();
    B._draft = emptyDraft();
    stub.setChecked('#bgm-score-toggle', false);
    stub.setChecked('#bgm-rank-toggle', false);
    stub.setVal('#bgm-score-min', '0');
    stub.setVal('#bgm-score-max', '50');
    stub.setVal('#bgm-rank-min', '0');
    stub.setVal('#bgm-rank-max', '99999');
    stub.setVal('#bgm-date-start', '');
    stub.setVal('#bgm-date-end', '');
    B._commitDraftFromDom();
    assert.equal(B._draft.scoreRange, null);
    assert.equal(B._draft.rankRange, null);
    assert.equal(B._draft.dateRange, null);

    B._state = Object.assign({}, B._draft, { keyword: '孤独摇滚' });
    await B.load(1);
    assert.equal(captured.params.scoreMin, '');
    assert.equal(captured.params.scoreMax, '');
    assert.equal(captured.params.rankMin, '');
    assert.equal(captured.params.rankMax, '');
});

// ── 输入过程：即时夹取回写 + 不触发搜索 ─────────────────────────────

test('input 越界值立即夹取回写；输入过程不发请求', () => {
    const { B, stub, captured } = loadSearch();
    B._state = Object.assign(emptyDraft(), { keyword: '孤独摇滚' });
    B.init(); // 注册弹窗处理器
    B._openWorkbench();
    assert.equal(captured.calls.length, 0, '打开弹窗不发请求');

    // 勾选开关 → 默认 7-10（既有默认语义）
    stub.fire('change', '#bgm-score-toggle', { currentTarget: { id: 'bgm-score-toggle', checked: true } });
    assert.equal(stub.getVal('#bgm-score-min'), '7');
    assert.equal(stub.getVal('#bgm-score-max'), '10');

    stub.setVal('#bgm-score-min', '0');
    stub.fire('input', '#bgm-score-min', { currentTarget: { id: 'bgm-score-min' } });
    assert.equal(stub.getVal('#bgm-score-min'), '1', '越界值当场回写为边界值');
    deepEq(B._draft.scoreRange, { min: 1, max: 10 });
    assert.equal(captured.calls.length, 0, '输入过程不得触发搜索请求');
});

test('input 交叉约束：编辑最低高于最高时最高被顶上去（回写两侧）', () => {
    const { B, stub } = loadSearch();
    B._state = Object.assign(emptyDraft(), { keyword: 'x' });
    B.init();
    B._openWorkbench();
    stub.setVal('#bgm-score-min', '9');
    stub.setVal('#bgm-score-max', '7');
    stub.fire('input', '#bgm-score-min', { currentTarget: { id: 'bgm-score-min' } });
    deepEq(B._draft.scoreRange, { min: 9, max: 9 });
    assert.equal(stub.getVal('#bgm-score-max'), '9', '被顶的一侧同步回写');

    stub.setVal('#bgm-rank-min', '8000');
    stub.setVal('#bgm-rank-max', '1');
    stub.fire('input', '#bgm-rank-max', { currentTarget: { id: 'bgm-rank-max' } });
    deepEq(B._draft.rankRange, { min: 1, max: 1 });
    assert.equal(stub.getVal('#bgm-rank-min'), '1');
});

// ── 草稿回填：手输语法里的越界值显示时即夹取 ─────────────────────────

test('_syncWorkbenchScore/_syncWorkbenchRank：草稿越界值（手输 score:0..15）回填即夹取', () => {
    const { B, stub } = loadSearch();
    B._draft = Object.assign(emptyDraft(), { scoreRange: { min: 0, max: 15 } });
    B._syncWorkbenchScore();
    assert.equal(stub.getVal('#bgm-score-min'), '1');
    assert.equal(stub.getVal('#bgm-score-max'), '10');
    assert.equal(stub.getText('#bgm-score-vals'), '1 - 10');
    deepEq(B._draft.scoreRange, { min: 1, max: 10 });

    B._draft = Object.assign(emptyDraft(), { rankRange: { min: 9, max: 2 } });
    B._syncWorkbenchRank();
    deepEq(B._draft.rankRange, { min: 9, max: 9 }, '反序以最低值为准顶高最高值');
    assert.equal(stub.getText('#bgm-rank-vals'), '9 - 9');

    B._draft = Object.assign(emptyDraft(), { scoreRange: { min: null, max: 8 } });
    B._syncWorkbenchScore();
    assert.equal(stub.getVal('#bgm-score-min'), '', '不限侧留空');
    assert.equal(stub.getText('#bgm-score-vals'), '不限 - 8');
});

test('日期控件回填时联动原生 min/max（起止先后约束可见）', () => {
    const { B, stub } = loadSearch();
    B._draft = Object.assign(emptyDraft(), { dateRange: { start: '2026-01-01', end: '2026-04-01' } });
    B._syncWorkbenchDate();
    assert.equal(stub.getVal('#bgm-date-start'), '2026-01-01');
    assert.equal(stub.getVal('#bgm-date-end'), '2026-04-01');
    assert.equal(stub.getAttr('#bgm-date-start', 'max'), '2026-04-01');
    assert.equal(stub.getAttr('#bgm-date-end', 'min'), '2026-01-01');

    // 季度选中 → 日期被清空，min/max 一并移除（两者不会互相覆盖出错）
    B._draft = Object.assign(emptyDraft(), { season: '2026Q1' });
    B._syncWorkbenchDate();
    assert.equal(stub.getVal('#bgm-date-start'), '');
    assert.equal(stub.getVal('#bgm-date-end'), '');
    assert.equal(stub.getAttr('#bgm-date-start', 'max'), undefined);
    assert.equal(stub.getAttr('#bgm-date-end', 'min'), undefined);
});

test('筛选弹窗排名标签：最好名次/最差名次（排名 1 为最好，避免“最低/最高”歧义）', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    const start = html.indexOf('id="bgm-rank-range-row"');
    const end = html.indexOf('id="bgm-rank-vals"');
    assert.ok(start >= 0 && end > start, '排名区间行必须存在');
    const block = html.slice(start, end);
    assert.ok(block.includes('最好名次'), '排名下限的标签应为「最好名次」');
    assert.ok(block.includes('最差名次'), '排名上限的标签应为「最差名次」');
    assert.ok(!block.includes('最低') && !block.includes('最高'), '排名行不应再出现易歧义的「最低/最高」');
});
