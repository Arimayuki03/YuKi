/**
 * 白盒单测：Kazumi 规则管理（拖动排序 / 批量选择 / 源网站展示）。
 *
 * 覆盖 kazumi.js 中三处状态计算的纯函数与渲染结果（vm 沙箱加载，$ 用记录型桩）：
 *   - 排序：_moveItem / _dropGapFromRects / _dropTargetIndex / _sameRuleSet
 *   - 拖拽落位 dropRuleAt / 上移下移 moveRule / 保存通道 _applyRuleOrder（一次性 kazumiReorder）
 *   - 源网站：_extractHost / _ruleSourceLabel（含非法 URL 与缺字段）
 *   - 批量选择：_batchReconcile / _batchToggle / _batchInvert + 批量删除/更新请求形态
 *   - 渲染：_renderRuleList 的勾选框/禁用态/源网站行/escHtml 转义
 *
 * 真实鼠标拖拽（dragstart/dragover/drop 的像素级落点与指示线观感）与真实点击
 * 只能在应用中人工验证，单测只覆盖到「事件回调背后的纯计算与请求形态」。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');

/** 记录型 $ 桩：捕获 html/text/prop/toggleClass 写入，其余链式调用原样返回。 */
function makeJqStub() {
    const captured = { html: {}, text: {}, props: {}, classes: {} };
    const node = (sel) => {
        const key = String(sel);
        const $el = {
            selector: key,
            length: 1,
            on() { return $el; },
            off() { return $el; },
            val() { return ''; },
            text(v) { if (v !== undefined) captured.text[key] = v; return $el; },
            html(v) { if (v !== undefined) captured.html[key] = v; return $el; },
            prop(k, v) { captured.props[key + ':' + k] = v; return $el; },
            toggle() { return $el; },
            toggleClass(c, on) { captured.classes[key + ':' + c] = on === undefined ? true : !!on; return $el; },
            show() { return $el; },
            hide() { return $el; },
            each() { return $el; },
            eq() { return $el; },
            addClass() { return $el; },
            removeClass() { return $el; },
            closest() { return $el; },
            find() { return $el; },
            append() { return $el; },
            empty() { return $el; },
        };
        return $el;
    };
    const $ = (sel) => node(sel);
    return { $, captured };
}

/** 加载 kazumi.js（最小桩），返回 Kazumi 实例与桩捕获。 */
function loadKazumi(extra = {}) {
    const source = fs.readFileSync(path.join(ROOT, 'src/renderer/js/kazumi.js'), 'utf8');
    const { $, captured } = makeJqStub();
    const toasts = [];
    const confirms = [];
    const actions = [];
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, Number, String, Array, Object,
        parseInt, parseFloat, setTimeout, clearTimeout,
        $,
        window: { yuki: {} },
        navigator: { clipboard: { readText: async () => '' } },
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        warnToast: (msg, opts) => toasts.push({ msg, opts }),
        showLoading: () => {}, hideLoading: () => {},
        confirmDialog: async (msg, opts) => { confirms.push({ msg, opts }); return true; },
        openDialog: () => {}, closeDialog: () => {},
        doAction: async (do_, kv, p) => { actions.push({ do: do_, kv, p }); return { code: 200, started: true }; },
        renderStatusBar: () => {},
        ...extra,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__K = Kazumi;`, context, { filename: 'kazumi.js' });
    return { kazumi: context.__K, captured, toasts, confirms, actions };
}

// 注：vm 沙箱里的数组/对象与宿主 realm 原型不同，assert/strict 的深比较会因
// 原型不一致报错，所以统一在这里投影成宿主 realm 的值再断言。
const NAMES = (list) => Array.from(list, (r) => r.name);
const SRC = (v) => (v ? { text: v.text, title: v.title, from: v.from } : null);
const KV = (a) => JSON.parse(JSON.stringify((a && a.kv) || {}));

// ---------------------------------------------------------------- 排序：_moveItem

test('_moveItem：中间/首/尾三个方向都按插入语义落位', () => {
    const { kazumi } = loadKazumi();
    assert.deepEqual(NAMES(kazumi._moveItem([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }], 0, 2)),
        ['b', 'c', 'a', 'd']);   // 第 0 个移到索引 2
    assert.deepEqual(NAMES(kazumi._moveItem([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 2, 0)),
        ['c', 'a', 'b']);        // 末尾移到列表首
    assert.deepEqual(NAMES(kazumi._moveItem([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 0, 2)),
        ['b', 'c', 'a']);        // 首移到列表尾
    assert.deepEqual(NAMES(kazumi._moveItem([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 1, 1)),
        ['a', 'b', 'c']);        // 拖到自己：顺序不变
});

test('_moveItem：越界索引被夹住，非法 from 原样返回（不产生重复/丢失）', () => {
    const { kazumi } = loadKazumi();
    const list = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    assert.deepEqual(NAMES(kazumi._moveItem(list, 0, 99)), ['b', 'c', 'a']);  // to 越界 → 夹到末尾
    assert.deepEqual(NAMES(kazumi._moveItem(list, 2, -5)), ['c', 'a', 'b']);   // to 越界 → 夹到 0
    assert.deepEqual(NAMES(kazumi._moveItem(list, -1, 0)), ['a', 'b', 'c']);   // from 非法：不动
    assert.deepEqual(NAMES(kazumi._moveItem(list, 3, 0)), ['a', 'b', 'c']);    // from 越界：不动
    assert.deepEqual(NAMES(kazumi._moveItem(list, 1.5, 0)), ['a', 'b', 'c']);  // 非整数 from：不动
    assert.deepEqual(NAMES(kazumi._moveItem([], 0, 1)), []);
    assert.deepEqual(NAMES(kazumi._moveItem(null, 0, 1)), []);
    assert.deepEqual(NAMES(kazumi._moveItem([{ name: 'a' }], 0, 0)), ['a']);
    assert.deepEqual(NAMES(list), ['a', 'b', 'c']); // 入参不被修改
});

// ---------------------------------------------------------------- 拖拽落点：gap 计算

test('_dropGapFromRects：按行中线把指针位置换算成插入间隙', () => {
    const { kazumi } = loadKazumi();
    // 三行：top 0/40/80，高 40（中线 20/60/100）
    const rects = [{ top: 0, height: 40 }, { top: 40, height: 40 }, { top: 80, height: 40 }];
    assert.equal(kazumi._dropGapFromRects(rects, -10), 0);   // 第一行上方 → 列表首
    assert.equal(kazumi._dropGapFromRects(rects, 20), 0);    // 恰在中线：按未越过处理（严格大于）
    assert.equal(kazumi._dropGapFromRects(rects, 21), 1);
    assert.equal(kazumi._dropGapFromRects(rects, 100), 2);   // 恰在最后一行中线
    assert.equal(kazumi._dropGapFromRects(rects, 101), 3);   // 最后一行下方 → 列表末尾
    assert.equal(kazumi._dropGapFromRects(rects, 9999), 3);
    assert.equal(kazumi._dropGapFromRects([], 10), 0);       // 空列表：无落点可言
});

test('_dropGapFromRects：几何非法返回 null（放弃落位，不用坏索引乱序）', () => {
    const { kazumi } = loadKazumi();
    assert.equal(kazumi._dropGapFromRects([{ top: 0, height: 40 }], NaN), null);
    assert.equal(kazumi._dropGapFromRects([{ top: 0, height: 40 }], undefined), null);
    assert.equal(kazumi._dropGapFromRects([null, null], 10), null);              // 全无效
    assert.equal(kazumi._dropGapFromRects('not-an-array', 10), 0);               // 非数组按空列表
    // 部分无效：跳过无效项，仍按有效行算出间隙
    assert.equal(kazumi._dropGapFromRects([{ top: 0, height: 40 }, null], 30), 1);
});

test('_dropTargetIndex：移除自身造成的间隙左移换算 + 非法输入放弃', () => {
    const { kazumi } = loadKazumi();
    // 列表 [a,b,c,d]，拖 a(0) 到 c 下方间隙 3 → 目标索引 3-1=2
    assert.equal(kazumi._dropTargetIndex(0, 3, 4), 2);
    // 拖 d(3) 到 a 上方间隙 0 → 目标 0
    assert.equal(kazumi._dropTargetIndex(3, 0, 4), 0);
    // 落在自己上方/下方两个相邻间隙都等价于原地：gap 2（自身下方）不位移
    assert.equal(kazumi._dropTargetIndex(1, 2, 4), 1);
    assert.equal(kazumi._dropTargetIndex(1, 1, 4), 1);   // 拖到自己上方 → 原地
    assert.equal(kazumi._dropTargetIndex(0, 0, 4), 0);
    assert.equal(kazumi._dropTargetIndex(3, 4, 4), 3);   // 列表末尾且已是最后一项
    assert.equal(kazumi._dropTargetIndex(1, 99, 4), 3);  // gap 越界夹到列表末尾
    assert.equal(kazumi._dropTargetIndex(1, -3, 4), 0);  // gap 越界夹到列表首
    // from 非法（规则已被删/列表已刷新）→ -1，调用方放弃
    assert.equal(kazumi._dropTargetIndex(-1, 2, 4), -1);
    assert.equal(kazumi._dropTargetIndex(4, 2, 4), -1);
    assert.equal(kazumi._dropTargetIndex(0, 2, 0), -1);
    // gap 缺失（null/非法）退化为原地，不产生位移
    assert.equal(kazumi._dropTargetIndex(2, null, 4), 2);
    assert.equal(kazumi._dropTargetIndex(2, undefined, 4), 2);
});

// ---------------------------------------------------------------- 顺序集合不变式

test('_sameRuleSet：同集合的排列为真；丢/重/换名一律为假', () => {
    const { kazumi } = loadKazumi();
    const a = [{ name: 'x' }, { name: 'y' }, { name: 'z' }];
    assert.equal(kazumi._sameRuleSet(a, [{ name: 'z' }, { name: 'x' }, { name: 'y' }]), true);
    assert.equal(kazumi._sameRuleSet(a, [{ name: 'x' }, { name: 'y' }]), false);                 // 丢
    assert.equal(kazumi._sameRuleSet(a, [{ name: 'x' }, { name: 'y' }, { name: 'y' }]), false);  // 重
    assert.equal(kazumi._sameRuleSet(a, [{ name: 'x' }, { name: 'y' }, { name: 'w' }]), false);  // 换名
    assert.equal(kazumi._sameRuleSet([], []), true);
    assert.equal(kazumi._sameRuleSet(null, undefined), true);
});

test('dropRuleAt：拖到自己/规则已删除/落点非法时不发请求', async () => {
    const { kazumi, actions } = loadKazumi();
    kazumi._rules = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    await kazumi.dropRuleAt('a', 1);        // 落在自己上方 → 原地
    await kazumi.dropRuleAt('a', null);     // 几何非法
    await kazumi.dropRuleAt('missing', 0);  // 拖拽期间规则被删
    await kazumi.dropRuleAt('', 0);
    assert.equal(actions.length, 0);
    assert.deepEqual(NAMES(kazumi._rules), ['a', 'b', 'c']);
});

test('拖动中列表刷新（整表重渲）作废本次拖拽：旧索引不会把规则挪错位', async () => {
    const { kazumi, actions } = loadKazumi();
    kazumi._rules = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    kazumi._dragName = 'a';
    kazumi._renderRuleList();                 // 检测/更新完成触发的重渲
    assert.equal(kazumi._dragName, null);     // 拖拽态被收口清理（dragover/drop 随之失效）
    // 即便浏览器仍把旧拖拽的 drop 送达，落位也以最新列表为准：重名不存在 → 不请求
    kazumi._rules = [{ name: 'b' }, { name: 'c' }];
    await kazumi.dropRuleAt('a', 1);
    assert.equal(actions.length, 0);
    assert.deepEqual(NAMES(kazumi._rules), ['b', 'c']);
});

test('dropRuleAt：落到列表首/尾时一次性提交完整新顺序（kazumiReorder）', async () => {
    const { kazumi, actions } = loadKazumi();
    kazumi._rules = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    kazumi._pollTask = () => {};
    await kazumi.dropRuleAt('c', 0); // 拖到列表首
    assert.equal(actions.length, 1);
    assert.equal(actions[0].do, 'kazumiReorder');
    assert.deepEqual(JSON.parse(actions[0].kv.names), ['c', 'a', 'b']);
    await kazumi.dropRuleAt('c', 3); // 再拖到列表尾
    assert.equal(actions.length, 2);
    assert.deepEqual(JSON.parse(actions[1].kv.names), ['a', 'b', 'c']);
});

test('moveRule：上移下移与拖拽共用保存通道，首/尾越界不请求', async () => {
    const { kazumi, actions } = loadKazumi();
    kazumi._rules = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    await kazumi.moveRule('a', -1); // 已在首位：不请求
    await kazumi.moveRule('c', 1);  // 已在末位：不请求
    await kazumi.moveRule('nope', 1);
    assert.equal(actions.length, 0);
    await kazumi.moveRule('a', 1);
    assert.deepEqual(JSON.parse(actions[0].kv.names), ['b', 'a', 'c']);
});

test('_applyRuleOrder：非同集合排列拒绝保存并回退渲染（防竞态丢/重规则）', async () => {
    const { kazumi, actions } = loadKazumi();
    kazumi._rules = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    await kazumi._applyRuleOrder([{ name: 'a' }, { name: 'b' }]); // 丢了一条
    assert.equal(actions.length, 0);
    assert.deepEqual(NAMES(kazumi._rules), ['a', 'b', 'c']);
});

test('_applyRuleOrder：保存失败时回滚到原顺序（乐观更新可回退）', async () => {
    const { kazumi, actions, toasts } = loadKazumi({
        doAction: async (do_, kv, p) => { actions.push({ do: do_, kv, p }); return { code: 400, msg: 'bad' }; },
    });
    kazumi._rules = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    await kazumi._applyRuleOrder([{ name: 'b' }, { name: 'a' }, { name: 'c' }]);
    assert.equal(actions.length, 1);
    assert.deepEqual(NAMES(kazumi._rules), ['a', 'b', 'c']);
    assert.ok(toasts.some((t) => t.msg.includes('排序保存失败')));
});

// ---------------------------------------------------------------- 源网站：_extractHost

test('_extractHost：完整 URL / 无协议 / 协议相对 / 端口 / 凭据 / 路径', () => {
    const { kazumi } = loadKazumi();
    assert.equal(kazumi._extractHost('https://www.mxdm8.com/search/{keyword}.html'), 'mxdm8.com');
    assert.equal(kazumi._extractHost('http://example.com:8080/a?b=1#c'), 'example.com');
    assert.equal(kazumi._extractHost('//cdn.example.com/x'), 'cdn.example.com');
    assert.equal(kazumi._extractHost('example.com/search'), 'example.com');
    assert.equal(kazumi._extractHost('www.Example.COM'), 'example.com');           // 去 www + 小写
    assert.equal(kazumi._extractHost('user:pw@sub.example.com/p'), 'sub.example.com');
    assert.equal(kazumi._extractHost('localhost:3000'), 'localhost');
    assert.equal(kazumi._extractHost('http://127.0.0.1:8000/'), '127.0.0.1');
    assert.equal(kazumi._extractHost('  https://example.com  '), 'example.com');   // 去首尾空白
    assert.equal(kazumi._extractHost('https://example.com.'), '');                 // 尾点不合法
});

test('_extractHost：空值/非域名/非 http(s) scheme 返回空字符串', () => {
    const { kazumi } = loadKazumi();
    for (const bad of ['', '   ', null, undefined, 0, 'https://', '//', 'not a url', 'javascript:alert(1)',
        'data:text/html,x', 'mailto:a@b.com', 'about:blank', '...', 'a b.com', 42]) {
        assert.equal(kazumi._extractHost(bad), '', `应拒绝：${String(bad)}`);
    }
});

// ---------------------------------------------------------------- 源网站：_ruleSourceLabel

test('_ruleSourceLabel：自带 source 优先，超长截断但 title 保留全串', () => {
    const { kazumi } = loadKazumi();
    assert.deepEqual(SRC(kazumi._ruleSourceLabel({ name: 'r', source: 'Enlie 官方源', baseURL: 'https://a.com' })),
        { text: 'Enlie 官方源', title: 'Enlie 官方源', from: 'source' });
    const long = 'x'.repeat(200);
    const r = kazumi._ruleSourceLabel({ source: long });
    assert.equal(r.text.length, 81);           // 80 + 省略号
    assert.equal(r.title, long);
    // source 非字符串（对象/数组）不当来源文本用，继续向后回退
    assert.deepEqual(kazumi._ruleSourceLabel({ source: { name: 'x' }, baseURL: 'https://b.com/' }).from, 'baseURL');
});

test('_ruleSourceLabel：无自带来源时按 referer → baseURL → searchURL 回退取域名', () => {
    const { kazumi } = loadKazumi();
    assert.deepEqual(SRC(kazumi._ruleSourceLabel({ referer: 'https://ref.example.com/', baseURL: 'https://base.example.com/' })),
        { text: 'ref.example.com', title: 'https://ref.example.com/', from: 'referer' });
    assert.deepEqual(SRC(kazumi._ruleSourceLabel({ referer: '', baseURL: 'https://www.base.com/x' })),
        { text: 'base.com', title: 'https://www.base.com/x', from: 'baseURL' });
    assert.deepEqual(SRC(kazumi._ruleSourceLabel({ searchURL: 'https://search.example.org/s?wd={keyword}' })),
        { text: 'search.example.org', title: 'https://search.example.org/s?wd={keyword}', from: 'searchURL' });
    // referer 非法（空/坏值）时继续回退，不被坏值挡住
    assert.equal(kazumi._ruleSourceLabel({ referer: 'https://', baseURL: 'https://ok.com/' }).from, 'baseURL');
});

test('_ruleSourceLabel：字段缺失/全非法返回 null（卡片不渲染来源行）', () => {
    const { kazumi } = loadKazumi();
    assert.equal(kazumi._ruleSourceLabel(null), null);
    assert.equal(kazumi._ruleSourceLabel({}), null);
    assert.equal(kazumi._ruleSourceLabel({ name: 'r', baseURL: '', searchURL: '   ' }), null);
    assert.equal(kazumi._ruleSourceLabel({ baseURL: 'not a url', searchURL: 'https://' }), null);
});

// ---------------------------------------------------------------- 批量选择集合运算

test('_batchReconcile：选集收窄到当前列表（幽灵选中项被剔除）', () => {
    const { kazumi } = loadKazumi();
    const sel = new Set(['a', 'b', 'gone']);
    assert.deepEqual([...kazumi._batchReconcile(sel, ['a', 'b', 'c'])], ['a', 'b']);
    assert.deepEqual([...kazumi._batchReconcile(sel, [])], []);              // 列表清空
    assert.deepEqual([...kazumi._batchReconcile(null, ['a'])], []);          // 无选集
    assert.deepEqual([...kazumi._batchReconcile(sel, ['a', 'a', 'a'])], ['a']); // 列表重复名不放大
    assert.equal(kazumi._batchReconcile(sel, ['a', 'b', 'c']).has('gone'), false);
});

test('_batchToggle：勾选/取消/空名（不改入参）', () => {
    const { kazumi } = loadKazumi();
    const base = new Set(['a']);
    assert.deepEqual([...kazumi._batchToggle(base, 'b', true)], ['a', 'b']);
    assert.deepEqual([...kazumi._batchToggle(base, 'a', false)], []);
    assert.deepEqual([...kazumi._batchToggle(base, '', true)], ['a']);      // 空名忽略
    assert.deepEqual([...kazumi._batchToggle(null, 'x', true)], ['x']);
    assert.deepEqual([...base], ['a']);                                     // 入参不变
});

test('_batchInvert：以当前列表为全集反选；全选/清空与之组合幂等', () => {
    const { kazumi } = loadKazumi();
    assert.deepEqual([...kazumi._batchInvert(new Set(['a']), ['a', 'b', 'c'])], ['b', 'c']);
    assert.deepEqual([...kazumi._batchInvert(new Set(['a', 'b', 'c']), ['a', 'b', 'c'])], []);
    assert.deepEqual([...kazumi._batchInvert(new Set(), ['a', 'b'])], ['a', 'b']);
    assert.deepEqual([...kazumi._batchInvert(null, ['a'])], ['a']);
    // 反选两次回到原选集
    const once = kazumi._batchInvert(new Set(['a']), ['a', 'b']);
    assert.deepEqual([...kazumi._batchInvert(once, ['a', 'b'])], ['a']);
});

test('_batchSelectedNames：按列表顺序返回选中项（请求顺序稳定）', () => {
    const { kazumi } = loadKazumi();
    kazumi._rules = [{ name: 'b' }, { name: 'a' }, { name: 'c' }];
    kazumi._batchSel = new Set(['c', 'a']);
    assert.deepEqual(kazumi._batchSelectedNames(), ['a', 'c']);
    kazumi._batchSel = null;
    assert.deepEqual(kazumi._batchSelectedNames(), []);
});

// ---------------------------------------------------------------- 渲染结果

test('_renderRuleList：普通模式输出与既有选择器/拖拽契约保持不变', () => {
    const { kazumi, captured } = loadKazumi();
    kazumi._rules = [{ name: 'a', version: '1.0', enabled: true, baseURL: 'https://www.mxdm8.com/', installed_at: '2026-01-01' }];
    kazumi._renderRuleList();
    const html = captured.html['#kazumi_rule_list'];
    assert.ok(html.includes('class="history-item kazumi-rule-row"'));
    assert.ok(html.includes('draggable="true"'));
    assert.ok(html.includes('kazumi-rule-move'));
    assert.ok(html.includes('kazumi-rule-main'));
    assert.ok(html.includes('kazumi-rule-name'));
    assert.ok(html.includes('kazumi-rule-times'));
    assert.ok(!html.includes('kazumi-rule-checkbox'));  // 普通模式不出现勾选框
    assert.ok(!html.includes('disabled'));
    assert.equal(captured.text['#kazumi_rule_count'], 1);
    // 源网站行（任务3）：显示 baseURL 域名
    assert.ok(html.includes('kazumi-rule-source'));
    assert.ok(html.includes('来源 mxdm8.com'));
    assert.ok(html.includes('title="来源：https://www.mxdm8.com/"'));
});

test('_renderRuleList：批量模式渲染勾选框、卡片按钮禁用、拖拽关闭', () => {
    const { kazumi, captured } = loadKazumi();
    kazumi._rules = [{ name: 'a', version: '1.0' }, { name: 'b', version: '2.0' }];
    kazumi._batchMode = true;
    kazumi._batchSel = new Set(['b']);
    kazumi._renderRuleList();
    const html = captured.html['#kazumi_rule_list'];
    assert.equal(captured.classes['#kazumi_rule_list:batch-mode'], true);
    assert.ok(html.includes('kazumi-rule-checkbox'));
    assert.ok(html.includes('draggable="false"'));
    assert.ok(!html.includes('draggable="true"'));
    assert.ok(html.includes('data-name="b" checked'));   // 选中项勾选状态回显
    assert.ok(html.includes('kazumi-rule-checked'));     // 选中行高亮
    assert.ok(html.includes('disabled'));                // 编辑/启停/删除/上移下移禁用
    assert.equal(captured.text['#kazumi_batch_count'], '已选 1 项');
    // 列表刷新（检测/更新完成）后选集与列表求交：不存在的名字被剔除
    kazumi._batchSel = new Set(['b', 'ghost']);
    kazumi._renderRuleList();
    assert.deepEqual([...kazumi._batchSel], ['b']);
    assert.equal(captured.text['#kazumi_batch_count'], '已选 1 项');
});

test('_renderRuleList：远端可控文本（规则名/来源）经 escHtml 转义，不产出可执行标签', () => {
    const { kazumi, captured } = loadKazumi();
    kazumi._rules = [{
        name: '<img src=x onerror=alert(1)>',
        version: '1"><script>bad()</script>',
        source: '<b>evil</b>',
    }];
    kazumi._renderRuleList();
    const html = captured.html['#kazumi_rule_list'];
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<b>evil'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(html.includes('来源 &lt;b&gt;evil&lt;/b&gt;'));
});

test('_renderRuleList：无来源字段的规则不渲染来源行', () => {
    const { kazumi, captured } = loadKazumi();
    kazumi._rules = [{ name: 'a', version: '1.0' }];
    kazumi._renderRuleList();
    assert.ok(!captured.html['#kazumi_rule_list'].includes('kazumi-rule-source'));
});

test('_renderRuleList：空列表时给出空态并同步计数；批量模式下选集被清空', () => {
    const { kazumi, captured } = loadKazumi();
    kazumi._rules = [];
    kazumi._batchMode = true;
    kazumi._batchSel = new Set(['ghost']);
    kazumi._renderRuleList();
    assert.ok(captured.html['#kazumi_rule_list'].includes('尚未导入任何 Kazumi 规则'));
    assert.equal(captured.text['#kazumi_rule_count'], 0);
    assert.equal(captured.text['#kazumi_batch_count'], '已选 0 项');
});

// ---------------------------------------------------------------- 批量操作请求形态

test('batchUpdate：原入口（无参）保持「所有已安装」文案与空表单请求', async () => {
    const { kazumi, actions, confirms } = loadKazumi();
    kazumi._pollTask = () => {}; // 不启动轮询
    const started = await kazumi.batchUpdate();
    assert.equal(started, true);
    assert.equal(confirms[0].msg, '将从规则商店批量检查并更新所有已安装规则，继续？');
    assert.deepEqual(actions[0].do, 'kazumiBatchUpdate');
    assert.deepEqual(KV(actions[0]), {});
    assert.equal(actions[0].p, '/kazumi/action');
});

test('batchUpdate：传子集时只提交选中名字（逗号协议）且确认文案写明条数', async () => {
    const { kazumi, actions, confirms } = loadKazumi();
    kazumi._pollTask = () => {};
    const started = await kazumi.batchUpdate(['a', 'b']);
    assert.equal(started, true);
    assert.equal(confirms[0].msg, '将从规则商店批量检查并更新选中的 2 条规则，继续？');
    assert.deepEqual(KV(actions[0]), { names: 'a,b' });
});

test('batchUpdate：确认框取消 / 已有任务在跑时返回 false（调用方不退出批量模式）', async () => {
    const cancel = loadKazumi({ confirmDialog: async () => false });
    cancel.kazumi._pollTask = () => {};
    assert.equal(await cancel.kazumi.batchUpdate(['a']), false);
    assert.equal(cancel.actions.length, 0);
    const busy = loadKazumi({ doAction: async (do_, kv, p) => { busy.actions.push({ do: do_, kv, p }); return { code: 409, started: false }; } });
    busy.kazumi._pollTask = () => {};
    assert.equal(await busy.kazumi.batchUpdate(['a']), false);
    assert.equal(busy.actions.length, 1);
});

test('batchRemoveSelected：一次确认写明条数 + 复用 kazumiRemove 逐条删除 + 退出批量模式并刷新', async () => {
    const { kazumi, actions, confirms, captured } = loadKazumi();
    kazumi._rules = [{ name: 'b' }, { name: 'a' }, { name: 'c' }];
    kazumi._batchMode = true;
    kazumi._batchSel = new Set(['c', 'a']);
    let refreshed = 0;
    kazumi.refreshRuleList = async () => { refreshed++; };
    await kazumi.batchRemoveSelected();
    assert.equal(confirms.length, 1);
    assert.ok(confirms[0].msg.includes('将删除选中的 2 条规则'));
    assert.deepEqual(actions.map((a) => a.do), ['kazumiRemove', 'kazumiRemove']);
    assert.deepEqual(actions.map((a) => a.kv.name), ['a', 'c']); // 按列表顺序
    assert.equal(kazumi._batchMode, false);
    assert.equal(kazumi._batchSel.size, 0);
    assert.equal(refreshed, 1);
    assert.equal(captured.classes['#kazumi_rule_list:batch-mode'], false);
});

test('batchRemoveSelected：未勾选/确认取消时不发请求', async () => {
    const { kazumi, actions, toasts } = loadKazumi();
    kazumi._rules = [{ name: 'a' }];
    kazumi._batchMode = true;
    kazumi._batchSel = new Set();
    await kazumi.batchRemoveSelected();
    assert.equal(actions.length, 0);
    assert.ok(toasts.some((t) => t.msg.includes('请先勾选')));
    const cancel = loadKazumi({ confirmDialog: async () => false });
    cancel.kazumi._rules = [{ name: 'a' }];
    cancel.kazumi._batchMode = true;
    cancel.kazumi._batchSel = new Set(['a']);
    await cancel.kazumi.batchRemoveSelected();
    assert.equal(cancel.actions.length, 0);
});

test('batchRemoveSelected：部分失败按汇总口径提示（summary 不被错误过滤吞掉）', async () => {
    const { kazumi, toasts } = loadKazumi({
        doAction: async (do_, kv) => (kv.name === 'a' ? { code: 200 } : { code: 404, msg: 'not found' }),
    });
    kazumi._rules = [{ name: 'a' }, { name: 'b' }];
    kazumi._batchMode = true;
    kazumi._batchSel = new Set(['a', 'b']);
    kazumi.refreshRuleList = async () => {};
    kazumi.exitBatchMode = () => {};
    await kazumi.batchRemoveSelected();
    const last = toasts[toasts.length - 1];
    assert.ok(last.msg.includes('成功 1 条'));
    assert.ok(last.msg.includes('失败 1 条'));
    assert.equal(last.opts.summary, true);
});

test('批量删除走单条确认通道：removeRule 仍保留自己的二次确认', async () => {
    const { kazumi, actions, confirms } = loadKazumi();
    kazumi.refreshRuleList = () => {};
    await kazumi.removeRule('a');
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0].msg, '删除规则「a」？');
    assert.deepEqual(actions[0].do, 'kazumiRemove');
});

test('enterBatchMode / exitBatchMode：无规则不进入；切换时清空选择并同步入口按钮态', () => {
    const { kazumi, captured, toasts } = loadKazumi();
    kazumi._rules = [];
    kazumi.enterBatchMode();
    assert.equal(kazumi._batchMode, false);
    assert.ok(toasts.some((t) => t.msg.includes('当前没有已导入的规则')));
    kazumi._rules = [{ name: 'a' }];
    kazumi.enterBatchMode();
    assert.equal(kazumi._batchMode, true);
    assert.equal(captured.classes['#kazumi_rule_batch:active'], true);
    kazumi._batchSel = new Set(['a']);
    kazumi.exitBatchMode();
    assert.equal(kazumi._batchMode, false);
    assert.equal(kazumi._batchSel.size, 0);
    assert.equal(captured.classes['#kazumi_rule_batch:active'], false);
});

test('batchUpdateSelected：勾选为空不发请求；启动成功后退出批量模式', async () => {
    const empty = loadKazumi();
    empty.kazumi._rules = [{ name: 'a' }];
    empty.kazumi._batchMode = true;
    empty.kazumi._batchSel = new Set();
    await empty.kazumi.batchUpdateSelected();
    assert.equal(empty.actions.length, 0);
    const { kazumi, actions } = loadKazumi();
    kazumi._pollTask = () => {};
    kazumi._rules = [{ name: 'a' }, { name: 'b' }];
    kazumi._batchMode = true;
    kazumi._batchSel = new Set(['a']);
    await kazumi.batchUpdateSelected();
    assert.deepEqual(KV(actions[0]), { names: 'a' });
    assert.equal(kazumi._batchMode, false);
});
