/**
 * 白盒单元测试：Kazumi 播放源「别名检索」（T86）+ 手动检索弹窗拖选误关修复。
 *
 * 任务 A（交互修复）：_showKeywordDialog 的关窗判定。旧实现只在 click 上看
 *   `e.target === overlay`——click 的 target 是 mousedown/mouseup 的最近公共
 *   祖先，在弹窗里按下、把选中文本拖到弹窗外松手时 target 正好是遮罩，
 *   于是"拖选结束"被当成"点外部"关窗。现在要求按下起点与释放点都在遮罩上。
 *
 * 任务 B（别名检索）：
 *   - 纯函数：_aliasKeyOf / _aliasSanitizeList / _aliasSanitizeMap / _aliasTrimMap /
 *     _aliasUpsert / _aliasRemoveItem / _aliasPromoteItem / _aliasCandidates /
 *     _aliasShouldRecord / _isAliasWord / _mergeResults
 *   - 检索链：标题轮无可用源才顺序试别名（命中即停、上限 3、全源 error 不试）
 *   - 沉淀：手动检索换词且搜出可用源 → 记入 kazumiAliasMap（settings 整表写）
 *   - 管理：_aliasPanelHtml 渲染 chips；_aliasMutate 增删/置顶即时落盘
 *
 * 加载方式同 kazumi-chapter-captcha.test.js：kazumi.js 是经典脚本，node:vm
 * 注入全局桩后取 Kazumi。沙箱内的字面量对象属于另一个 realm，整对象
 * deepEqual 会因原型不同失败，断言前先摊平成测试侧对象。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/renderer/js/kazumi.js'), 'utf8');

/** 摊平沙箱对象（跨 realm deepEqual 会挂在原型上）。 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** 让所有 microtask 跑完（落盘/回落决策都在 await 之后）。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- 通用桩

/**
 * jQuery 桩：按选择器缓存节点，记录 on/html/val。
 * makeJq 支持 $(html 字符串) 动态创建（手动检索弹窗走这条）。
 */
function makeJq() {
    const nodes = new Map();
    const created = [];
    function node(sel) {
        if (!nodes.has(sel)) {
            const n = {
                sel, length: 1, handlers: {}, htmlValue: undefined, vals: {},
                on(ev, a, b) {
                    const sub = typeof a === 'string' ? a : '';
                    const fn = typeof a === 'function' ? a : b;
                    (n.handlers[ev] = n.handlers[ev] || []).push({ sub, fn });
                    return n;
                },
                off(ev) {
                    // 对齐 jQuery：off() 清空；off('.ks') / off('click.ks') 按命名空间移除，
                    // 否则重绘后委托会重复注册（真机上会一次点击触发两次）
                    if (ev === undefined) { n.handlers = {}; return n; }
                    const e = String(ev);
                    Object.keys(n.handlers).forEach((k) => {
                        if (k === e || k.endsWith(e) || k.split('.')[0] === e) delete n.handlers[k];
                    });
                    return n;
                },
                html(v) { if (v !== undefined) n.htmlValue = String(v); return n; },
                text() { return n; },
                append() { return n; },
                appendTo() { return n; },
                prepend() { return n; },
                find(s) { return node(sel + ' ' + s); },
                filter() { return n; },
                not() { return n; },
                closest() { return n; },
                replaceWith() { return n; },
                each() { return n; },
                data() { return undefined; },
                val(v) { if (v !== undefined) { n.vals.value = v; return n; } return n.vals.value === undefined ? '' : n.vals.value; },
                trigger() { return n; },
                select() { return n; },
                focus() { return n; },
                remove() { n.removed = true; return n; },
                show() { return n; },
                hide() { return n; },
                empty() { return n; },
                prop() { return n; },
                toggle() { return n; },
                is() { return false; },
                addClass() { return n; },
                removeClass() { return n; },
            };
            nodes.set(sel, n);
        }
        return nodes.get(sel);
    }
    const $ = (arg) => {
        if (typeof arg === 'string' && arg.startsWith('<')) {
            const n = node('__created__' + created.length);
            n[0] = { __el: created.length };   // 动态节点需要一个元素本体供 e.target 比较
            n.html$ = arg;
            created.push(n);
            return n;
        }
        if (arg && typeof arg === 'object') return arg; // $(e.currentTarget)：直接把元素桩交回
        return node(String(arg));
    };
    $.nodes = nodes;
    $.created = created;
    return $;
}

/** 可手动的 EventSource 桩：记录 URL，测试侧逐条派发 data 与 done。 */
function installFakeEventSource(ctx) {
    const instances = [];
    function FakeES(url) {
        this.url = String(url);
        this.closed = false;
        this.listeners = {};
        instances.push(this);
    }
    FakeES.prototype.close = function () { this.closed = true; };
    FakeES.prototype.addEventListener = function (ev, fn) { this.listeners[ev] = fn; };
    FakeES.prototype.emit = function (payloads) {
        (payloads || []).forEach((p) => { if (this.onmessage) this.onmessage({ data: JSON.stringify(p) }); });
    };
    FakeES.prototype.done = function () { if (this.listeners.done) this.listeners.done(); };
    ctx.EventSource = FakeES;
    return instances;
}

const wordOf = (url) => decodeURIComponent(String(url).split('word=')[1] || '');

/** 加载 kazumi.js（通用桩）。settings 走 settingsGet/settingsSet 桩，记录写入。 */
function loadKazumi(opts = {}) {
    const $ = makeJq();
    const settingsValue = opts.settings || {};
    const writes = [];
    const toasts = [];
    const ctx = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, RegExp, JSON: JSON,
        parseInt, parseFloat, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
        MutationObserver: function () { this.observe = () => { }; },
        $, openDialog: () => { }, closeDialog: () => { },
        escHtml: (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        warnToast: (m) => toasts.push(String(m)),
        showLoading: () => { }, hideLoading: () => { },
        apiUrl: (u) => u,
        doAction: opts.doAction || (() => Promise.resolve({})),
        document: {
            body: {},
            addEventListener() { }, removeEventListener() { }, getElementById: () => null,
        },
        window: {
            yuki: {
                settingsGet: async () => settingsValue,
                settingsSet: async (k, v) => { writes.push({ key: k, value: plain(v) }); return { value: v }; },
            },
        },
    };
    if (opts.noSettingsGet) delete ctx.window.yuki.settingsGet;
    const instances = installFakeEventSource(ctx);
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(`${SRC}\n;globalThis.__testKazumi = Kazumi;`, ctx, { filename: 'kazumi.js' });
    const kazumi = ctx.__testKazumi;
    kazumi.hasEnabledRules = () => true;
    return { kazumi, ctx, $, writes, toasts, instances, settingsValue };
}

const listOf = (rows) => plain(rows).map((r) => ({ alias: r.alias, ts: r.ts, hits: r.hits }));

// ---------------------------------------------------------------- 键与归一化

test('_aliasKeyOf：显式 subjectId 用 bgm: 键，其余回落 t: 片名键（归一化）', () => {
    const { kazumi } = loadKazumi();
    assert.equal(kazumi._aliasKeyOf('葬送的芙莉莲', '383233'), 'bgm:383233');
    assert.equal(kazumi._aliasKeyOf('葬送的芙莉莲', 383233), 'bgm:383233');
    assert.equal(kazumi._aliasKeyOf('葬送的芙莉莲', ' 42 '), 'bgm:42');
    // 非法/缺失 subjectId 一律走片名键：0/负/非数字/布尔都不能被 Number() 强转骗过
    ['', '   ', 'abc', '0', '-3', '3.5', true, null, undefined].forEach((bad) => {
        assert.equal(kazumi._aliasKeyOf('葬送的芙莉莲', bad), 't:葬送的芙莉莲',
            `subjectId=${String(bad)} 应回落片名键`);
    });
    // 片名键归一化：压空白 + 去首尾 + 拉丁小写
    assert.equal(kazumi._aliasKeyOf('  Frieren  Beyond  ', ''), 't:frieren beyond');
    assert.equal(kazumi._aliasKeyOf(null, ''), 't:', '空片名不抛错');
});

test('_aliasValid/_aliasSanitizeList：脏数据容错、去重、≥8 条截断、超长与控制字符丢弃', () => {
    const { kazumi } = loadKazumi();
    assert.equal(kazumi._aliasValid('芙莉莲'), true);
    assert.equal(kazumi._aliasValid(''), false);
    assert.equal(kazumi._aliasValid('x'.repeat(61)), false, '61 字符超限');
    assert.equal(kazumi._aliasValid('x'.repeat(60)), true, '60 字符恰好合规');
    assert.equal(kazumi._aliasValid('换\n行'), false, '控制字符丢弃');

    // 字符串形态（旧/手改数据）也收
    assert.deepEqual(listOf(kazumi._aliasSanitizeList(['a', '  b  ', ''])),
        [{ alias: 'a', ts: 0, hits: 0 }, { alias: 'b', ts: 0, hits: 0 }]);
    // null/数字/对象垃圾项：丢；大小写重复：留首个；hits 负数/NaN：归零
    assert.deepEqual(listOf(kazumi._aliasSanitizeList([null, 42, { alias: '' }, { alias: 'Frieren' },
        { alias: 'frieren', ts: '5', hits: -2 }, { alias: 'x', hits: 'abc' }])),
    [{ alias: 'Frieren', ts: 0, hits: 0 }, { alias: 'x', ts: 0, hits: 0 }]);
    // 非数组/非字符串：空表
    assert.deepEqual(listOf(kazumi._aliasSanitizeList(null)), []);
    assert.deepEqual(listOf(kazumi._aliasSanitizeList({ alias: 'x' })), []);
    // 上限 8 条：保留靠前的（靠前=优先），溢出的尾部丢弃
    const many = Array.from({ length: 12 }, (_, i) => 'a' + i);
    const kept = listOf(kazumi._aliasSanitizeList(many));
    assert.equal(kept.length, 8);
    assert.deepEqual(kept.map((x) => x.alias), ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
});

test('_aliasSanitizeMap：非法键丢弃、空表不落键、键数上限按 ts 淘汰最旧', () => {
    const { kazumi } = loadKazumi();
    assert.deepEqual(plain(kazumi._aliasSanitizeMap(null)), {});
    assert.deepEqual(plain(kazumi._aliasSanitizeMap([1, 2])), {}, '数组不是合法表');
    assert.deepEqual(plain(kazumi._aliasSanitizeMap({ 't:A': [], 'bgm:1': [{ alias: 'x' }], 'evil:1': ['y'], 't:': ['z'] })),
        { 'bgm:1': [{ alias: 'x', ts: 0, hits: 0 }] }, '空表和非法键形态都不落键');

    const many = {};
    for (let i = 0; i < 501; i++) many['bgm:' + i] = [{ alias: 'a', ts: i }];
    const trimmed = plain(kazumi._aliasSanitizeMap(many));
    assert.equal(Object.keys(trimmed).length, 500, '键数收敛到 500');
    assert.equal(trimmed['bgm:0'], undefined, 'ts 最小的键被淘汰');
    assert.equal(trimmed['bgm:500'].length, 1);
});

// ---------------------------------------------------------------- 增删/排序

test('_aliasUpsert：新词置顶（优先级最高）、已存在的只更新 ts 不重排、满 8 条丢尾部', () => {
    const { kazumi } = loadKazumi();
    let list = kazumi._aliasUpsert([], '  Frieren ', 100);
    assert.deepEqual(listOf(list), [{ alias: 'Frieren', ts: 100, hits: 0 }]);

    list = kazumi._aliasUpsert(list, '葬送', 200);
    assert.deepEqual(listOf(list).map((x) => x.alias), ['葬送', 'Frieren'], '新词置顶');

    list = kazumi._aliasUpsert(list, 'Frieren', 300);
    assert.deepEqual(listOf(list).map((x) => x.alias), ['葬送', 'Frieren'], '重复词不重排');
    assert.equal(listOf(list)[1].ts, 300, '重复词刷新 ts');
    // 大小写不敏感去重：保留首见写法，不新增条目
    list = kazumi._aliasUpsert(list, 'FRIEREN', 400);
    assert.deepEqual(listOf(list).map((x) => x.alias), ['葬送', 'Frieren']);
    assert.equal(listOf(list)[1].ts, 400);
    // 非法别名不改变列表
    assert.deepEqual(listOf(kazumi._aliasUpsert(list, '   ', 500)).map((x) => x.alias), ['葬送', 'Frieren']);

    let full = [];
    for (let i = 0; i < 9; i++) full = kazumi._aliasUpsert(full, 'a' + i, i);
    assert.equal(listOf(full).length, 8);
    assert.deepEqual(listOf(full).map((x) => x.alias), ['a8', 'a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1'],
        '最新的置顶，最早的 a0 被挤出');
});

test('_aliasRemoveItem/_aliasPromoteItem：删（大小写不敏感）与置顶优先', () => {
    const { kazumi } = loadKazumi();
    const base = kazumi._aliasSanitizeList(['a', 'b', 'c']);
    assert.deepEqual(listOf(kazumi._aliasRemoveItem(base, 'B')).map((x) => x.alias), ['a', 'c']);
    assert.deepEqual(listOf(kazumi._aliasRemoveItem(base, 'zz')).map((x) => x.alias), ['a', 'b', 'c'],
        '删不存在的词空操作');
    assert.deepEqual(listOf(kazumi._aliasPromoteItem(base, 'c')).map((x) => x.alias), ['c', 'a', 'b']);
    assert.deepEqual(listOf(kazumi._aliasPromoteItem(base, 'a')).map((x) => x.alias), ['a', 'b', 'c'],
        '首项置顶幂等');
});

// ---------------------------------------------------------------- 候选与沉淀判定

test('_aliasCandidates：原标题永远第一顺位，别名去重后最多 3 个', () => {
    const { kazumi } = loadKazumi();
    const c = kazumi._aliasCandidates('葬送的芙莉莲', ['葬送的芙莉莲', '芙莉莲', 'Frieren', '葬送', '多余', '多余2']);
    assert.deepEqual(plain(c.words), ['葬送的芙莉莲', '芙莉莲', 'Frieren', '葬送'],
        '标题占首位；与标题相同的别名去重；别名最多 3 个');
    assert.deepEqual(plain(c.aliases), ['芙莉莲', 'Frieren', '葬送']);
    // 无别名时退化为只有标题
    assert.deepEqual(plain(kazumi._aliasCandidates('X', []).words), ['X']);
    assert.deepEqual(plain(kazumi._aliasCandidates('X', null).aliases), []);
    // 标题为空/非法：不占别名额度，且 aliases 不会把别名误当标题切片丢掉
    const c2 = kazumi._aliasCandidates('  ', ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(plain(c2.words), ['a', 'b', 'c'], '别名硬上限 3，与标题是否有效无关');
    assert.deepEqual(plain(c2.aliases), ['a', 'b', 'c']);
    // 别名与标题重复时只算标题，不占别名额度
    const c3 = kazumi._aliasCandidates('标题', ['标题', 'a', 'b', 'c', 'd']);
    assert.deepEqual(plain(c3.aliases), ['a', 'b', 'c']);
});

test('_aliasShouldRecord：同标题/空/超长不记，换词才记（且必须真搜出可用源）', () => {
    const { kazumi } = loadKazumi();
    assert.equal(kazumi._aliasShouldRecord('葬送的芙莉莲', '芙莉莲', 1), true);
    assert.equal(kazumi._aliasShouldRecord('葬送的芙莉莲', '葬送的芙莉莲', 1), false, '同标题不记');
    assert.equal(kazumi._aliasShouldRecord('Frieren', ' frieren ', 1), false, '归一化后同标题不记');
    assert.equal(kazumi._aliasShouldRecord('葬送的芙莉莲', '芙莉莲', 0), false, '没搜出可用源不记');
    assert.equal(kazumi._aliasShouldRecord('葬送的芙莉莲', '  ', 1), false, '空词不记');
    assert.equal(kazumi._aliasShouldRecord('葬送的芙莉莲', 'x'.repeat(61), 1), false, '超长词不记');
});

test('_isAliasWord/_mergeResults：别名词判定与去重合并', () => {
    const { kazumi } = loadKazumi();
    const st = { title: '葬送的芙莉莲' };
    assert.equal(kazumi._isAliasWord(st, '芙莉莲'), true);
    assert.equal(kazumi._isAliasWord(st, ' 葬送的芙莉莲 '), false);
    assert.equal(kazumi._isAliasWord(st, ''), false);
    assert.equal(kazumi._isAliasWord({}, '芙莉莲'), false, '无标题一律不算别名词');

    const prev = [{ src: 'u1', name: 'a' }, { src: 'u2', name: 'b' }];
    const merged = kazumi._mergeResults(prev, [{ src: 'u2', name: 'b' }, { src: 'u3', name: 'c' }]);
    assert.equal(merged.length, 3, '源+标题去重，新条目追加在后');
    assert.deepEqual(plain(merged).map((x) => x.src), ['u1', 'u2', 'u3']);
    assert.deepEqual(plain(kazumi._mergeResults(null, [{ src: 'u1', name: 'a' }])).length, 1);
    assert.deepEqual(plain(kazumi._mergeResults(prev, null)).length, 2);
});

// ---------------------------------------------------------------- 检索链（自动别名检索）

function prepareSheet(kazumi, aliases, settings) {
    kazumi._rules = [
        { name: 'A', enabled: true, validity: 'valid' },
        { name: 'B', enabled: true, validity: 'valid' },
    ];
    // 桩环境 $ 缺 filter/replaceWith：卡片级重绘按既有测试惯例桩掉，只断言状态机
    kazumi._renderSourceCard = () => { };
    return kazumi;
}

test('别名检索：标题轮有可用源时不再试别名（零额外请求）', async () => {
    const h = loadKazumi({ settings: { kazumiAliasMap: { 't:葬送的芙莉莲': [{ alias: '芙莉莲', ts: 1, hits: 0 }] } } });
    prepareSheet(h.kazumi);
    await h.kazumi.openSourceDialog('葬送的芙莉莲', 'kazumi', '');
    assert.equal(h.instances.length, 1);
    assert.equal(wordOf(h.instances[0].url), '葬送的芙莉莲', '第一轮永远是原标题');
    h.instances[0].emit([{ name: 'A', list: [{ src: 'u1', name: 'n1' }], status: 'success' },
        { name: 'B', list: [], status: 'noresult' }]);
    h.instances[0].done();
    await tick();
    assert.equal(h.instances.length, 1, '有结果就不换词');
    assert.equal(h.kazumi._dlgState.plugins.A.status, 'success');
    assert.equal(h.kazumi._dlgState.plugins.A.hitWord, '', '标题轮结果不带别名标记');
});

test('别名检索：标题轮无可用源 → 顺序试别名，命中即停并标注命中词', async () => {
    const h = loadKazumi({
        settings: { kazumiAliasMap: { 't:葬送的芙莉莲': [{ alias: '芙莉莲', ts: 9, hits: 2 }, { alias: '葬送', ts: 1, hits: 0 }] } },
    });
    prepareSheet(h.kazumi);
    await h.kazumi.openSourceDialog('葬送的芙莉莲', 'kazumi', '');
    const st = h.kazumi._dlgState;
    assert.equal(wordOf(h.instances[0].url), '葬送的芙莉莲');
    h.instances[0].emit([{ name: 'A', list: [], status: 'noresult' }, { name: 'B', error: true, msg: 'x' }]);
    h.instances[0].done();
    await tick();
    assert.equal(h.instances.length, 2, '标题轮无可用源 → 起别名轮');
    assert.equal(wordOf(h.instances[1].url), '芙莉莲', '按别名表顺序（靠前=优先）');
    assert.equal(st.attempt, 1);
    assert.equal(st.keyword, '芙莉莲', '当前检索词切到别名');
    assert.equal(st.aliasPhase, true, '别名轮标记（头部加载态提示用）');

    h.instances[1].emit([{ name: 'A', list: [{ src: 'u9', name: 'n9' }], status: 'success' },
        { name: 'B', list: [], status: 'noresult' }]);
    h.instances[1].done();
    await tick();
    assert.equal(h.instances.length, 2, '命中即停：不再试下一个别名');
    assert.equal(st.plugins.A.status, 'success');
    assert.equal(st.plugins.A.hitWord, '芙莉莲', '卡片标出别名命中词');
    assert.equal(st.aliasPhase, false);
    // 命中计数落盘（一次检索只写一次 settings）
    const w = h.writes.filter((x) => x.key === 'kazumiAliasMap');
    assert.equal(w.length, 1, '一次检索最多写一次别名表');
    const row = w[0].value['t:葬送的芙莉莲'][0];
    assert.equal(row.alias, '芙莉莲');
    assert.equal(row.hits, 3, '命中次数 +1');
    assert.ok(row.ts > 9, '命中刷新 ts');
});

test('别名检索：别名轮全部无果 → 试满上限（1 标题 + 3 别名）后收工', async () => {
    const aliases = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const h = loadKazumi({
        settings: { kazumiAliasMap: { 't:标题': aliases.map((a, i) => ({ alias: a, ts: i })) } },
    });
    prepareSheet(h.kazumi);
    await h.kazumi.openSourceDialog('标题', 'kazumi', '');
    const fire = async (idx) => {
        h.instances[idx].emit([{ name: 'A', list: [], status: 'noresult' },
            { name: 'B', list: [], status: 'noresult' }]);
        h.instances[idx].done();
        await tick();
    };
    await fire(0);
    await fire(1);
    await fire(2);
    await fire(3);
    assert.equal(h.instances.length, 4, '别名最多试 3 个（1 标题 + 3 别名），超出不请求');
    assert.deepEqual(h.instances.map((x) => wordOf(x.url)), ['标题', 'a1', 'a2', 'a3']);
    assert.equal(h.kazumi._dlgState.aliasPhase, false);
    assert.equal(h.kazumi._dlgState.keyword, 'a3');
    assert.equal(h.writes.length, 0, '没有命中就不写计数');
});

test('别名检索：全源 error 时不试别名（整层故障换词无益，不放大失败请求）', async () => {
    const h = loadKazumi({ settings: { kazumiAliasMap: { 't:标题': [{ alias: 'a1', ts: 1 }] } } });
    prepareSheet(h.kazumi);
    await h.kazumi.openSourceDialog('标题', 'kazumi', '');
    h.instances[0].emit([{ name: 'A', error: true, msg: 'boom' }, { name: 'B', error: true, msg: 'boom' }]);
    h.instances[0].done();
    await tick();
    assert.equal(h.instances.length, 1, '全源 error 不换词');
    assert.equal(h.kazumi._dlgState.plugins.A.status, 'error');
});

test('别名检索：无别名表（或读设置失败）时行为与改造前一致（只打标题一轮）', async () => {
    const h = loadKazumi({ noSettingsGet: true });
    prepareSheet(h.kazumi);
    await h.kazumi.openSourceDialog('标题', 'kazumi', '');
    h.instances[0].emit([{ name: 'A', list: [], status: 'noresult' }, { name: 'B', list: [], status: 'noresult' }]);
    h.instances[0].done();
    await tick();
    assert.equal(h.instances.length, 1);
    assert.equal(h.kazumi._dlgState.plugins.A.status, 'noresult');
});

test('别名检索：opts.subjectId 存在时用 bgm: 键取表（片名键的表不受影响）', async () => {
    const h = loadKazumi({
        settings: {
            kazumiAliasMap: {
                'bgm:383233': [{ alias: '别名甲', ts: 5 }],
                't:葬送的芙莉莲': [{ alias: '别名乙', ts: 5 }],
            },
        },
    });
    prepareSheet(h.kazumi);
    await h.kazumi.openSourceDialog('葬送的芙莉莲', 'kazumi', '', { subjectId: '383233' });
    await tick();
    const st = h.kazumi._dlgState;
    assert.equal(st.aliasKey, 'bgm:383233');
    assert.deepEqual(plain(st.aliasChain), ['别名甲'], '只取当前键下的别名');
});

test('_applySourceResult：别名轮结果与原标题轮结果合并（不互相覆盖）', () => {
    const h = loadKazumi();
    const kazumi = h.kazumi;
    kazumi._renderSourceCard = () => { };
    kazumi._updateSheetHeader = () => { };
    const st = { title: '标题', keyword: 'a1', attempt: 1, expanded: null, plugins: Object.assign(Object.create(null), {
        A: { status: 'success', results: [{ src: 'u1', name: 'x' }], msg: '', searching: false },
    }) };
    kazumi._dlgState = st;
    kazumi._applySourceResult({ name: 'A', list: [{ src: 'u1', name: 'x' }, { src: 'u2', name: 'y' }] }, 'a1');
    assert.equal(st.plugins.A.results.length, 2, '同源两轮结果按 源+标题 去重合并');
    assert.equal(st.plugins.A.hitWord, 'a1');
    // 别名轮的 noresult 不能把原标题轮的好结果抹掉
    kazumi._applySourceResult({ name: 'A', list: [], status: 'noresult' }, 'a1');
    assert.equal(st.plugins.A.status, 'success');
    assert.equal(st.plugins.A.results.length, 2);
});

// ---------------------------------------------------------------- 沉淀与管理

test('_aliasRecord：手动检索换词成功 → 置顶入表并整表落盘；同标题/失败不写', async () => {
    const h = loadKazumi({ settings: { kazumiAliasMap: { 't:标题': [{ alias: '旧词', ts: 1, hits: 3 }] } } });
    const kazumi = h.kazumi;
    kazumi._renderSourceSheet = () => { };
    kazumi._renderSourceCard = () => { };
    kazumi._updateSheetHeader = () => { };
    kazumi._dlgState = { title: '标题', aliasKey: 't:标题' };
    kazumi._dlgState.aliasMap = { 't:标题': [{ alias: '旧词', ts: 1, hits: 3 }] };
    kazumi._dlgState.aliases = [{ alias: '旧词', ts: 1, hits: 3 }];
    kazumi._dlgState.aliasChain = ['旧词'];

    kazumi._aliasRecord(kazumi._dlgState, '新词', 'A');
    await tick();
    const w = h.writes.filter((x) => x.key === 'kazumiAliasMap');
    assert.equal(w.length, 1);
    assert.deepEqual(w[0].value['t:标题'].map((x) => x.alias), ['新词', '旧词'], '新词置顶');
    assert.equal(kazumi._dlgState.aliasChain[0], '新词', '候选链同步更新');
    assert.ok(h.toasts.some((t) => t.includes('记为别名')));

    h.writes.length = 0;
    kazumi._aliasRecord(kazumi._dlgState, '标题', 'A');   // 与标题相同：不记
    kazumi._aliasRecord(kazumi._dlgState, '', 'A');       // 空词：不记
    await tick();
    assert.equal(h.writes.length, 0);

    // 弹窗已关（_dlgState 不是同一个对象）：丢弃，不写设置
    kazumi._dlgState = null;
    kazumi._aliasRecord({ title: '标题', aliasKey: 't:标题' }, '别的词', 'A');
    await tick();
    assert.equal(h.writes.length, 0);
});

test('_aliasPanelHtml/_aliasMutate：面板 chips 渲染 + 增删置顶即时落盘', async () => {
    const h = loadKazumi();
    const kazumi = h.kazumi;
    kazumi._renderSourceSheet = () => { };
    const st = {
        title: '标题', aliasKey: 't:标题', aliasMap: {},
        aliases: kazumi._aliasSanitizeList([{ alias: '甲', hits: 4 }, { alias: '乙' }]),
    };
    st.aliasChain = kazumi._aliasCandidates('标题', st.aliases).aliases;
    kazumi._dlgState = st;

    const html = kazumi._aliasPanelHtml(st);
    assert.ok(html.includes('kazumi-alias-panel'));
    assert.ok(html.includes('甲') && html.includes('乙'));
    assert.ok(html.includes('kazumi-alias-hits'), '命中次数上屏');
    assert.ok(html.includes('data-alias-action="front"'), '非首项可设优先');
    assert.ok(html.includes('data-alias-action="del"'));
    assert.ok(!html.includes('data-alias="甲" data-alias-action'), '首项不给置顶按钮');

    // 空表提示
    assert.ok(kazumi._aliasPanelHtml({ title: '标题', aliases: [] }).includes('暂无别名'));

    // 置顶：乙 → 表首 + 落盘
    kazumi._aliasMutate(st, 'front', '乙');
    await tick();
    assert.deepEqual(plain(st.aliases).map((x) => x.alias), ['乙', '甲']);
    assert.deepEqual(h.writes.at(-1).value['t:标题'].map((x) => x.alias), ['乙', '甲']);

    // 删除：表空时删键（不落空数组）
    kazumi._aliasMutate(st, 'del', '乙');
    kazumi._aliasMutate(st, 'del', '甲');
    await tick();
    assert.equal(h.writes.at(-1).value['t:标题'], undefined, '空表删键');

    // 添加：校验 + 落盘
    kazumi._aliasMutate(st, 'add', '  丙  ');
    await tick();
    assert.deepEqual(plain(st.aliases).map((x) => x.alias), ['丙']);
    // 未知 op 不写
    const before = h.writes.length;
    kazumi._aliasMutate(st, 'nope', '丙');
    assert.equal(h.writes.length, before);
});

// ---------------------------------------------------------------- 管理 UI 委托

test('别名管理委托：头部入口展开面板、输入框回车添加、× 删除、↑ 置顶都即时落盘', async () => {
    const h = loadKazumi();
    const kazumi = h.kazumi;
    kazumi._dlgToken = 1;
    const st = {
        title: '标题', token: 1, keyword: '标题', expanded: null, aliasKey: 't:标题',
        aliasMap: {}, aliases: [], aliasChain: [], aliasEdit: false,
        plugins: Object.create(null),
    };
    kazumi._dlgState = st;
    kazumi._renderSourceSheet();
    const box = h.$.nodes.get('#kazumi-dialog-body');
    // _bindSheetEvents 用命名空间事件（click.ks / keydown.ks）
    const fireSub = (ev, sub, currentTarget, key) => {
        const list = (box.handlers[ev + '.ks'] || []).filter((x) => x.sub === sub);
        assert.ok(list.length, `应有 ${ev} ${sub} 委托`);
        list.forEach((x) => x.fn({ stopPropagation() { }, preventDefault() { }, currentTarget, key: key || '' }));
    };

    // 头部入口：展开/收起管理面板
    fireSub('click', '.kazumi-alias-toggle');
    assert.equal(st.aliasEdit, true, '头部入口应展开管理面板');
    fireSub('click', '.kazumi-alias-toggle');
    assert.equal(st.aliasEdit, false, '再点收起');

    // 添加（回车）
    const inputNode = h.$('#kazumi-dialog-body .kazumi-alias-input'); // 按选择器取出（首次调用即建桩）
    inputNode.vals.value = '甲';
    fireSub('keydown', '.kazumi-alias-input', null, 'Enter');
    await tick();
    assert.deepEqual(plain(st.aliases).map((x) => x.alias), ['甲']);
    assert.deepEqual(plain(h.writes.at(-1).value['t:标题']).map((x) => x.alias), ['甲']);

    // 再加一个，然后置顶
    inputNode.vals.value = '乙';
    fireSub('keydown', '.kazumi-alias-input', null, 'Enter');
    await tick();
    assert.deepEqual(plain(st.aliases).map((x) => x.alias), ['乙', '甲']);
    const el = (action, alias) => ({ data: (k) => (k === 'aliasAction' ? action : k === 'alias' ? alias : undefined) });
    fireSub('click', '.kazumi-alias-act', el('front', '甲'));
    await tick();
    assert.deepEqual(plain(st.aliases).map((x) => x.alias), ['甲', '乙'], '置顶生效');
    assert.ok(h.toasts.some((t) => t.includes('已设为优先')));

    // 删除
    fireSub('click', '.kazumi-alias-act', el('del', '乙'));
    await tick();
    assert.deepEqual(plain(st.aliases).map((x) => x.alias), ['甲']);
    assert.deepEqual(plain(h.writes.at(-1).value['t:标题']).map((x) => x.alias), ['甲']);
    assert.ok(h.toasts.some((t) => t.includes('已删除别名')));

    // 非 Enter 键不添加
    inputNode.vals.value = '丙';
    fireSub('keydown', '.kazumi-alias-input', null, 'a');
    await tick();
    assert.deepEqual(plain(st.aliases).map((x) => x.alias), ['甲'], '非回车键不触发添加');
});

// ---------------------------------------------------------------- 任务 A：手动检索弹窗

/** 手动检索弹窗专用桩：动态节点带 [0] 元素本体，子节点按选择器取。 */
function loadKazumiForDialog(opts = {}) {
    const h = loadKazumi(opts);
    const docListeners = [];
    h.ctx.document.addEventListener = (ev, fn, capture) => { docListeners.push({ ev, fn, capture }); };
    h.ctx.document.removeEventListener = (ev, fn, capture) => {
        const i = docListeners.findIndex((x) => x.ev === ev && x.fn === fn && x.capture === capture);
        if (i >= 0) docListeners.splice(i, 1);
    };
    return { ...h, docListeners };
}

const fire = (node, ev, evt) => (node.handlers[ev] || []).forEach((x) => x.fn(evt || {}));

test('任务A：弹窗内部按下、拖到遮罩上松手不关窗（根因回归）', () => {
    const h = loadKazumiForDialog();
    h.kazumi._queryPlugin = async () => ({ ok: false });
    h.kazumi._showKeywordDialog('A', 1, '手动检索');
    const dlg = h.$.created[0];
    assert.ok(dlg, '应动态插入遮罩节点');
    const overlayEl = dlg[0];
    const inputEl = { __el: 'input' };
    // 在输入框里按下 → 拖出弹窗 → 在遮罩上松手（旧实现：click.target===遮罩 → 误关）
    fire(dlg, 'mousedown', { button: 0, target: inputEl });
    fire(dlg, 'mouseup', { button: 0, target: overlayEl });
    assert.notEqual(dlg.removed, true, '拖选结束不得关窗');
    // 标题上按下同理（标题是弹窗内文本节点，拖选的主要场景）
    fire(dlg, 'mousedown', { button: 0, target: { __el: 'title' } });
    fire(dlg, 'mouseup', { button: 0, target: overlayEl });
    assert.notEqual(dlg.removed, true);
    // 在窗口外松手（没有 mouseup/click 事件）：状态不复位也不关窗
    fire(dlg, 'mousedown', { button: 0, target: inputEl });
    assert.notEqual(dlg.removed, true);
});

test('任务A：按下与释放都在遮罩上才关窗；右键不误关', () => {
    const h = loadKazumiForDialog();
    h.kazumi._queryPlugin = async () => ({ ok: false });
    // 右键（button=2）在遮罩上按下+释放：不关（与改造前 click 语义一致）
    h.kazumi._showKeywordDialog('A', 1, '手动检索');
    let dlg = h.$.created[0];
    fire(dlg, 'mousedown', { button: 2, target: dlg[0] });
    fire(dlg, 'mouseup', { button: 2, target: dlg[0] });
    assert.notEqual(dlg.removed, true, '非左键不关窗');
    // 左键完整点击遮罩 → 关
    fire(dlg, 'mousedown', { button: 0, target: dlg[0] });
    fire(dlg, 'mouseup', { button: 0, target: dlg[0] });
    assert.equal(dlg.removed, true, '点遮罩空白处照旧关闭');
    // 弹窗内部按下+内部释放（点标题/双击）→ 不关
    h.kazumi._showKeywordDialog('A', 1, '手动检索');
    dlg = h.$.created[1];
    const inner = { __el: 'title' };
    fire(dlg, 'mousedown', { button: 0, target: inner });
    fire(dlg, 'mouseup', { button: 0, target: inner });
    assert.notEqual(dlg.removed, true);
});

test('任务A：取消/确认/Esc 三条关闭路径仍正常，确认走 _queryPlugin 并沉淀别名', async () => {
    const h = loadKazumiForDialog({
        settings: { kazumiAliasMap: {} },
    });
    const kazumi = h.kazumi;
    const st = { title: '葬送的芙莉莲', aliasKey: 't:葬送的芙莉莲' };
    st.aliasMap = {}; st.aliases = []; st.aliasChain = []; st.keyword = '葬送的芙莉莲';
    kazumi._dlgState = st;
    kazumi._renderSourceCard = () => { };
    kazumi._updateSheetHeader = () => { };
    const calls = [];
    kazumi._queryPlugin = async (kw, plugin, token) => { calls.push({ kw, plugin, token }); return { ok: true, status: 'success' }; };

    // 取消：关窗且不重查
    kazumi._showKeywordDialog('A', 1, '手动检索');
    let dlg = h.$.created[0];
    dlg.find('#kazumi-kw-input').vals.value = '新词';
    dlg.find('#kazumi-kw-cancel').handlers.click[0].fn();
    assert.equal(dlg.removed, true);
    assert.equal(calls.length, 0);

    // 确认：重查 + 成功后沉淀别名
    kazumi._showKeywordDialog('A', 1, '手动检索');
    dlg = h.$.created[1];
    dlg.find('#kazumi-kw-input').vals.value = '新词';
    dlg.find('#kazumi-kw-ok').handlers.click[0].fn();
    assert.equal(dlg.removed, true);
    await tick();
    assert.deepEqual(calls, [{ kw: '新词', plugin: 'A', token: 1 }]);
    assert.deepEqual(h.writes.at(-1).value['t:葬送的芙莉莲'].map((x) => x.alias), ['新词'],
        '成功关键词沉淀为别名');

    // 空输入不提交（仍可再输入）
    kazumi._showKeywordDialog('A', 1, '手动检索');
    dlg = h.$.created[2];
    dlg.find('#kazumi-kw-input').vals.value = '   ';
    dlg.find('#kazumi-kw-ok').handlers.click[0].fn();
    assert.notEqual(dlg.removed, true, '空关键词不关窗');
    assert.ok(h.toasts.some((t) => t.includes('请输入关键词')));

    // Esc：registered capture 监听关窗并吞掉事件（不冒泡到全局 Esc 派发）
    assert.equal(h.docListeners.length, 1, '开窗时应挂一个 capture Esc 监听');
    const esc = { key: 'Escape', stopped: 0, stopPropagation() { esc.stopped++; } };
    h.docListeners[0].fn(esc);
    assert.equal(esc.stopped, 1, '必须拦下冒泡，否则全局 Esc 会连选源弹窗一起关');
    assert.equal(dlg.removed, true);
    assert.equal(h.docListeners.length, 0, '关窗后移除监听（不泄漏）');
    // 非 Escape 键不处理
    const other = { key: 'a', stopPropagation() { throw new Error('不应拦截'); } };
    h.docListeners[0] && h.docListeners[0].fn(other);
});

test('任务A：源码级回归锁——关窗只看 mousedown/mouseup 双端，不再只看 click.target', () => {
    assert.ok(!/dlg\.on\('click', \(e\) => \{ if \(e\.target === dlg\[0\]\) close\(\); \}\)/.test(SRC),
        '旧的 click.target 单端判定必须已被移除');
    assert.ok(/dlg\.on\('mousedown'/.test(SRC) && /dlg\.on\('mouseup'/.test(SRC),
        '应改为 mousedown/mouseup 双端判定');
});
