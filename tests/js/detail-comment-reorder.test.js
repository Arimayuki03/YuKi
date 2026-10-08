'use strict';
// A-24 吐槽排序就地重排回归测试（detail.js）：
// 背景：旧实现排序按钮 handler 里 this._commentDesc 翻转后直接 this._renderComments()
// 整表 box.html() 重绘——全部行与头像 <img> 重建（重新解码→闪烁）+ 滚动位置跳动。
// 新实现：handler 调 _reorderCommentRows 就地移动已渲染行节点（手法同 _appendCommentRows
// 的 data-key 增量渲染先例），节点复用天然保住头像已加载状态与楼中楼结构。
// 覆盖：
//   1) _commentSortedList 正/倒序语义（与 _renderComments 排序一致）
//   2) 就地重排后已渲染节点引用不变（重排非重建）+ 新顺序正确
//   3) 头像 img 节点身份不变（未被替换；_commentRowHtml 零调用佐证零重建）
//   4) 楼中楼（.detail-comment-replies）随父行整体移动，不拆散
//   5) 回退路径：行数与数据不符 / 键重复 → 返回 false 且不动 DOM（调用方整表渲染兜底）
//   6) 排序按钮 handler 接线：翻转状态→就地重排→按钮文案更新→不整表重绘
//   7) 源码锚点：旧的一行式「翻转+整表重绘」不复存在
// 无 jsdom：自建最小假 DOM（children/parentElement/insertBefore/after/
// previousElementSibling/firstElementChild/querySelectorAll），支撑节点身份断言。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------------------------------------------------------------- 最小假 DOM

/** 假元素：单类名 + dataset + 父子/兄弟链，覆盖 _reorderCommentRows 用到的操作面。 */
function fakeEl(cls) {
    const el = {
        tagName: 'DIV',
        className: String(cls || ''),
        dataset: {},
        children: [],
        parentElement: null,
        isConnected: true, // 本测试不触发 _appendCommentRows 锚点补偿路径
        style: {}, // _reorderCommentRows 摘 stagger-in 时写 style.animationDelay
    };
    // classList 最小桩（Set 语义）：M5 后 _reorderCommentRows 重排前会摘
    // .stagger-in（contains/remove），stagger 布置路径还会 add——桩按 className
    // 字符串同步维护，与生产 DOM 行为一致。
    const classes = new Set(String(cls || '').split(/\s+/).filter(Boolean));
    el.classList = {
        contains: (c) => classes.has(c),
        add: (c) => { classes.add(c); el.className = [...classes].join(' '); },
        remove: (c) => { classes.delete(c); el.className = [...classes].join(' '); },
        toggle: (c, force) => {
            const want = force === undefined ? !classes.has(c) : !!force;
            if (want) classes.add(c); else classes.delete(c);
            el.className = [...classes].join(' ');
            return want;
        },
    };
    el.detach = () => {
        if (el.parentElement) {
            const i = el.parentElement.children.indexOf(el);
            if (i >= 0) el.parentElement.children.splice(i, 1);
            el.parentElement = null;
        }
    };
    // 同容器内移动（重排常态）：先摘除再定位插入，索引在摘除后重算
    el.after = (node) => {
        const p = el.parentElement;
        if (!p) return;
        node.detach();
        const i = p.children.indexOf(el);
        p.children.splice(i + 1, 0, node);
        node.parentElement = p;
    };
    Object.defineProperty(el, 'firstElementChild', {
        get() { return el.children.length ? el.children[0] : null; },
    });
    Object.defineProperty(el, 'previousElementSibling', {
        get() {
            const p = el.parentElement;
            if (!p) return null;
            const i = p.children.indexOf(el);
            return i > 0 ? p.children[i - 1] : null;
        },
    });
    el.appendChild = (node) => {
        node.detach();
        el.children.push(node);
        node.parentElement = el;
    };
    // innerHTML 赋值走 parseHtml：_appendCommentRows/_updateCommentFooter 用
    // holder.innerHTML 承接行模板再取 firstElementChild，裸属性赋值不会解析
    Object.defineProperty(el, 'innerHTML', {
        set(html) {
            el.children.length = 0;
            for (const n of parseHtml(String(html))) {
                n.parentElement = el;
                el.children.push(n);
            }
        },
        get() { return ''; },
    });
    el.insertBefore = (node, ref) => {
        node.detach();
        const i = ref ? el.children.indexOf(ref) : -1;
        if (i >= 0) el.children.splice(i, 0, node);
        else el.children.push(node);
        node.parentElement = el;
    };
    // 类名/标签名匹配（测试元素均为单类名，无需完整选择器引擎）
    const hit = (n, sel) => (sel.startsWith('.') ? n.className === sel.slice(1) : n.tagName === sel.toUpperCase());
    el.querySelectorAll = (sel) => {
        const out = [];
        (function walk(list) {
            for (const n of list) {
                if (hit(n, sel)) out.push(n);
                walk(n.children);
            }
        })(el.children);
        return out;
    };
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
    return el;
}

/** 评论列表容器（.detail-comment-list）。 */
function fakeList() {
    return fakeEl('detail-comment-list');
}

/** 评论行（.detail-comment）：默认带头像 img 子节点，可带楼中楼。 */
function mkRow(key, withReplies) {
    const row = fakeEl('detail-comment');
    row.dataset.key = key;
    const img = fakeEl('detail-comment-avatar');
    img.tagName = 'IMG';
    row.appendChild(img);
    if (withReplies) row.appendChild(fakeEl('detail-comment-replies'));
    return row;
}

// ---------------------------------------------------------------- VM 加载

/** 最小 jQuery 桩：on 捕获（取排序按钮 handler）、text/html 捕获、
 *  「#detail-tab-content .detail-comment-list」查询返回注入的假容器。 */
function makeJq(captor, listContainer) {
    return (sel) => {
        const s = String(sel);
        const node = {
            length: sel === undefined ? 0 : 1,
            on(ev, a, b) {
                const fn = typeof b === 'function' ? b : a;
                if (typeof fn === 'function') captor.handlers.push({ sel: s, ev, fn });
                return node;
            },
            text(v) { if (v !== undefined) captor.texts.push({ sel: s, value: v }); return node; },
            html(v) { if (v !== undefined) captor.htmls.push({ sel: s, value: v }); return node; },
            find() { return node; },
            first() { return { length: 1, 0: listContainer }; },
            children() { return { length: 0 }; },
            prop() { return node; },
            off() { return node; },
            attr() { return node; },
            trigger() { return node; },
        };
        return node;
    };
}

/** 在 VM 中加载 detail.js（最小桩，手法照抄 bgm-episode-comments.test.js）。 */
function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const captor = { handlers: [], texts: [], htmls: [] };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: () => null,
            // _appendCommentRows 用 holder.innerHTML 承接行模板再取 firstElementChild：
            // data-key 断言需要一个能解析该惯用法的桩（简易解析器，见 parseHtml）。
            createElement: (tag) => parseHtml(`<${tag}></${tag}>`)[0] || fakeEl(tag),
        },
        $: makeJq(captor, (extra && extra.__listContainer) || fakeList()),
        registerEsc: () => {},
        // A-11 staggerEnter 后落地于 detail.js（_renderComments 首屏错峰），
        // 本测试不加载 common.js——补最小 no-op 桩，重排行为断言不受影响
        staggerEnter: () => {},
        replayClass: () => {},
        escHtml: (s) => String(s),
        stripHtml: (s) => String(s || ''),
        warnToast: () => {},
        showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '', vodCoverImg: () => '', normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        localCacheGet: () => null, localCacheSet: () => {}, localCacheDel: () => {},
        openDialog: () => {}, closeDialog: () => {},
        // A-14：detail.js 评论时间/排序实现已下沉 common.js，VM 内提供同款真实现
        fmtCommentTimeFull: (ts) => {
            if (!ts) return '';
            let n = Number(ts);
            if (!n) return '';
            if (n < 1e12) n *= 1000;
            const d = new Date(n);
            const pad = (x) => String(x).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        },
        commentTsMs: (ts) => {
            if (!ts) return 0;
            let n = Number(ts);
            if (!n) return 0;
            if (n < 1e12) n *= 1000; // 秒 → 毫秒
            return n;
        },
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    const listContainer = extra && extra.__listContainer;
    if (extra) delete extra.__listContainer;
    Object.assign(context, extra || {});
    if (listContainer) context.$ = makeJq(captor, listContainer);
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, captor, context };
}

// ------------------------------------------------------------ 简易 HTML 解析桩

/** 真实 _commentRowHtml 输出的承接桩：解析行模板 HTML 为 fakeEl 树。
 *  只需覆盖该模板用到的形状：div/img/span/strong/em/u/s + class + data-* 属性。
 *  img 的 on* 内联属性在假 DOM 无意义，忽略即可。 */
function parseHtml(html) {
    const tagRe = /<(\/)?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/)?>|([^<]+)/g;
    const attrRe = /([\w-]+)(?:="([^"]*)")?/g;
    const root = fakeEl('');
    let cur = root;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        if (m[5] !== undefined) continue; // 文本节点：本测试不消费
        if (m[1]) { // 闭合标签：回到父节点
            if (cur.parentElement) cur = cur.parentElement;
            continue;
        }
        const el = fakeEl('');
        el.tagName = m[2].toUpperCase();
        let a;
        while ((a = attrRe.exec(m[3] || '')) !== null) {
            const name = a[1];
            const value = a[2] !== undefined ? a[2] : '';
            if (name === 'class') el.className = value;
            else if (name === 'data-key') el.dataset.key = value;
            else if (name.startsWith('data-')) el.dataset[name.slice(5)] = value;
        }
        cur.appendChild(el);
        if (!m[4]) cur = el; // 非自闭合：进入子树（img 无闭合标签但也不进——见下）
        if (el.tagName === 'IMG' && !m[1] && !m[4]) cur = el.parentElement; // img 无闭合
    }
    return root.children;
}

/** 标准夹具：三条评论（时间升序 createdAt=秒），_commentDesc=false（正序已渲染）。 */
function fixture(Detail, container, extraComments) {
    Detail._activeTab = '吐槽';
    Detail._bgmId = '42';
    Detail._bgmExtraLoaded = true;
    Detail._commentDesc = false;
    Detail._comments = extraComments || [
        { user: { nickname: '甲' }, comment: '一楼', createdAt: 1700000000 },
        { user: { nickname: '乙' }, comment: '二楼', createdAt: 1700100000 },
        { user: { nickname: '丙' }, comment: '三楼', createdAt: 1700200000 },
    ];
    const list = Detail._commentSortedList();
    const keys = Detail._commentKeys(list);
    const rows = keys.map((k) => mkRow(k, true));
    for (const r of rows) container.appendChild(r);
    return { list, keys, rows };
}

// ---------------------------------------------------------------- _commentSortedList

test('_commentSortedList：正/倒序语义与切换（A-24 从 _renderComments 抽出）', () => {
    const { Detail } = loadDetail();
    Detail._comments = [
        { user: { nickname: '甲' }, comment: 'a', createdAt: 1700000000 },
        { user: { nickname: '乙' }, comment: 'b', createdAt: 1700100000 },
        { user: { nickname: '丙' }, comment: 'c', createdAt: 1700200000 },
    ];
    Detail._commentDesc = false; // 正序：旧→新
    assert.deepEqual(Detail._commentSortedList().map((c) => c.comment), ['a', 'b', 'c']);
    Detail._commentDesc = true; // 倒序：新→旧（默认）
    assert.deepEqual(Detail._commentSortedList().map((c) => c.comment), ['c', 'b', 'a']);
    // 不改原数组（slice 副本排序）
    assert.equal(Detail._comments[0].comment, 'a');
});

test('_commentSortedList：空表安全', () => {
    const { Detail } = loadDetail();
    Detail._comments = [];
    assert.deepEqual(Detail._commentSortedList(), []);
});

// ---------------------------------------------------------------- 就地重排核心

test('就地重排：已渲染节点引用不变（重排非重建）+ 新顺序正确', () => {
    const { Detail } = loadDetail();
    const container = fakeList();
    const { rows } = fixture(Detail, container);
    // 每行挂一个头像子节点用于后续身份断言（mkRow 已带 img，这里取引用）
    const imgs = rows.map((r) => r.children[0]);
    // 正序已渲染（fixture 默认）→ 切倒序
    Detail._commentDesc = true;
    const htmlSpy = { n: 0 };
    const orig = Detail._commentRowHtml;
    Detail._commentRowHtml = (...a) => { htmlSpy.n++; return orig.apply(Detail, a); };
    const ok = Detail._reorderCommentRows(container);
    Detail._commentRowHtml = orig;
    assert.equal(ok, true, '应完成就地重排');
    assert.equal(htmlSpy.n, 0, '重排过程不应生成任何行 HTML（零重建）');
    const after = container.querySelectorAll('.detail-comment');
    assert.equal(after.length, 3);
    // 新顺序 = 倒序（新→旧）：数据序与 DOM 序一致，且节点引用是原行
    const wantKeys = Detail._commentKeys(Detail._commentSortedList());
    assert.deepEqual(after.map((r) => r.dataset.key), wantKeys);
    // 逐项身份断言：顺序翻转为 fixture rows 的逆序，且引用是原节点
    assert.equal(after[0], rows[2]);
    assert.equal(after[1], rows[1]);
    assert.equal(after[2], rows[0]);
    // 头像 img 节点未被替换（节点身份保持 → <img> 已加载状态天然保留）
    after.forEach((r, i) => assert.equal(r.children[0], imgs[2 - i], `第 ${i} 行头像应为原 img 节点`));
});

test('就地重排：已在目标顺序时零移动（结构不变）', () => {
    const { Detail } = loadDetail();
    const container = fakeList();
    const { rows } = fixture(Detail, container); // 正序渲染
    Detail._commentDesc = false; // 目标顺序与当前一致
    const before = container.children.slice();
    assert.equal(Detail._reorderCommentRows(container), true);
    assert.deepEqual(container.children, before, '零移动：children 序列引用完全不变');
    assert.deepEqual(before, rows);
});

test('就地重排：楼中楼随父行整体移动，不拆散', () => {
    const { Detail } = loadDetail();
    const container = fakeList();
    const { rows } = fixture(Detail, container); // 每行带 .detail-comment-replies
    const replies = rows.map((r) => r.querySelector('.detail-comment-replies'));
    Detail._commentDesc = true;
    assert.equal(Detail._reorderCommentRows(container), true);
    const after = container.querySelectorAll('.detail-comment');
    assert.equal(after[0], rows[2]);
    // 楼中楼节点仍是原父行的子节点（身份 + 归属都未变）
    after.forEach((r, i) => {
        assert.equal(r.querySelector('.detail-comment-replies'), replies[2 - i]);
        assert.equal(replies[2 - i].parentElement, r);
    });
});

test('回退：已渲染行数与数据不符 → false 且不动 DOM（调用方整表渲染兜底）', () => {
    const { Detail } = loadDetail();
    const container = fakeList();
    fixture(Detail, container);
    // 模拟「已渲染列表与 _comments 漂移」（如未渲染的分页数据混入）
    Detail._comments = Detail._comments.concat([{ user: { nickname: '丁' }, comment: '四楼', createdAt: 1700300000 }]);
    const before = container.children.slice();
    assert.equal(Detail._reorderCommentRows(container), false, '行数不一致应放弃就地重排');
    assert.deepEqual(container.children, before, 'DOM 不应被触碰');
});

test('回退：行 key 重复/缺失 → false', () => {
    const { Detail } = loadDetail();
    const { keys } = fixture(Detail, fakeList());
    // 构造重复 key 行：容器行数（3）与 _comments 数（3）一致——通过 rows.length
    // 守卫（:2360）后真正命中 byKey.has(key) 重复分支（:2365），而非被行数守卫
    // 提前挡下（旧用例 2 行 vs 3 条零覆盖该分支）。置倒序使「若未拦截则必然
    // 移动节点」，配合 DOM 不动断言证明是重复 key 拦截生效。
    Detail._commentDesc = true;
    const dup = fakeList();
    dup.appendChild(mkRow(keys[0]));
    dup.appendChild(mkRow(keys[0])); // 与第 1 行同 key（相邻重复）
    dup.appendChild(mkRow(keys[2]));
    const dupBefore = dup.children.slice();
    assert.equal(Detail._reorderCommentRows(dup), false, '重复 key 应放弃就地重排');
    assert.deepEqual(dup.children, dupBefore, '重复 key 拦截不得触碰 DOM');
    // 非相邻重复同样命中（第 1 行与第 3 行同 key）
    const dup2 = fakeList();
    dup2.appendChild(mkRow(keys[0]));
    dup2.appendChild(mkRow(keys[1]));
    dup2.appendChild(mkRow(keys[0]));
    assert.equal(Detail._reorderCommentRows(dup2), false, '非相邻重复 key 同样应放弃就地重排');
    // 缺失 key（data-key 为空）
    const missing = fakeList();
    const r1 = mkRow(keys[0]);
    const r2 = mkRow(keys[1]);
    delete r2.dataset.key;
    missing.appendChild(r1);
    missing.appendChild(r2);
    Detail._comments = Detail._comments.slice(0, 2);
    Detail._commentDesc = false;
    assert.equal(Detail._reorderCommentRows(missing), false, '缺失 key 应放弃就地重排');
});

// ---------------------------------------------------------------- 排序按钮 handler 接线

test('排序按钮 handler：翻转→就地重排→文案更新→不整表重绘', () => {
    const container = fakeList();
    const { Detail, captor } = loadDetail({ __listContainer: container });
    fixture(Detail, container); // 正序渲染（_commentDesc=false）
    // 真渲染一次以捕获 #detail-comment-order 的 click handler（全量分支注册）
    Detail._renderComments();
    const h = captor.handlers.find((x) => x.sel === '#detail-comment-order' && x.ev === 'click');
    assert.ok(h, '全量渲染应注册排序按钮 click handler');
    // 替换 _renderComments 为 spy：handler 就地重排成功时不得再整表重绘
    let renderCalls = 0;
    const origRender = Detail._renderComments;
    Detail._renderComments = () => { renderCalls++; };
    h.fn(); // 模拟点击：_commentDesc 翻转为 true
    Detail._renderComments = origRender;
    assert.equal(Detail._commentDesc, true, '点击后排序状态翻转');
    assert.equal(renderCalls, 0, '就地重排成功不应整表重绘');
    const after = container.querySelectorAll('.detail-comment');
    assert.equal(after.length, 3);
    // 新顺序应为倒序：DOM 序与 _commentSortedList 新序完全一致
    const wantKeys = Detail._commentKeys(Detail._commentSortedList());
    assert.deepEqual(after.map((r) => r.dataset.key), wantKeys);
    // 按钮文案已局部更新（⇅ 切正序）
    const textCall = captor.texts.find((x) => x.sel === '#detail-comment-order');
    assert.ok(textCall, '应局部更新按钮文案');
    assert.equal(textCall.value, '⇅ 切正序');
});

test('排序按钮 handler：重排不可行（行数漂移）→ 回退整表重绘', () => {
    const container = fakeList();
    const { Detail, captor } = loadDetail({ __listContainer: container });
    fixture(Detail, container);
    Detail._renderComments();
    const h = captor.handlers.find((x) => x.sel === '#detail-comment-order' && x.ev === 'click');
    assert.ok(h);
    // 制造漂移：数据多一条（未渲染）
    Detail._comments = Detail._comments.concat([{ user: { nickname: '丁' }, comment: '四楼', createdAt: 1700300000 }]);
    let renderCalls = 0;
    const origRender = Detail._renderComments;
    Detail._renderComments = () => { renderCalls++; origRender.call(Detail); };
    h.fn();
    Detail._renderComments = origRender;
    assert.equal(renderCalls, 1, '重排失败应回退整表重绘一次');
});

// ---------------------------------------------------------------- 真实模板 data-key 回归（A1）

/** 真实 _commentRowHtml 输出回归：行模板必须带 data-key 属性——
 *  _appendCommentRows（增量插入比对 dataset.key）与 _reorderCommentRows
 *  （身份映射）都消费该属性；模板丢失它会让两条增量路径双双失效
 *  （append 整行重复插入 / reorder 回退整表重绘），且无任何报错。 */
test('真实模板：_commentRowHtml 输出含 data-key 属性（带/无 key 两形态）', () => {
    const { Detail } = loadDetail();
    Detail._comments = [{ user: { nickname: '甲' }, comment: '一楼', createdAt: 1700000000 }];
    const key = Detail._commentKeys(Detail._commentSortedList())[0];
    const withKey = Detail._commentRowHtml(Detail._comments[0], key);
    assert.match(withKey, new RegExp(`class="detail-comment" data-key="${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"`),
        '带 key 调用必须产出 data-key 属性');
    assert.ok(withKey.includes('detail-comment-head'), '行结构应完整（head 区）');
    const noKey = Detail._commentRowHtml(Detail._comments[0], '');
    assert.doesNotMatch(noKey, /<div class="detail-comment" data-key=/, '空 key 调用不得产出空 data-key');
    const noKeyArg = Detail._commentRowHtml(Detail._comments[0]);
    assert.doesNotMatch(noKeyArg, /data-key=/, '缺省 key 调用不得产出 data-key');
});

test('真实模板：_appendCommentRows 基于模板行推进指针，仅插入新行', () => {
    const { Detail } = loadDetail();
    // 夹具 3 条；已渲染容器用真实模板产出行（走 _renderComments 全量分支同款
    // 模板，防模板与消费方口径漂移；旧 mkRow 桩行只保证 data-key 形状）
    fixture(Detail, fakeList());
    const list0 = Detail._commentSortedList();
    const keys0 = Detail._commentKeys(list0);
    const container2 = fakeList();
    list0.forEach((c, i) => container2.appendChild(parseHtml(Detail._commentRowHtml(c, keys0[i]))[0]));
    const before = container2.children.slice();
    // 续拉第 4 条（时间更晚，正序排在末尾）
    Detail._comments = Detail._comments.concat([{ user: { nickname: '丁' }, comment: '四楼', createdAt: 1700300000 }]);
    const list1 = Detail._commentSortedList();
    const keys1 = Detail._commentKeys(list1);
    const renderSpy = { n: 0 };
    const orig = Detail._commentRowHtml;
    Detail._commentRowHtml = (...a) => { renderSpy.n++; return orig.apply(Detail, a); };
    Detail._appendCommentRows(container2, list1, keys1);
    Detail._commentRowHtml = orig;
    assert.equal(renderSpy.n, 1, '只为新条目生成行 HTML（旧行零重建）');
    const after = container2.querySelectorAll('.detail-comment');
    assert.equal(after.length, 4);
    assert.deepEqual(after.map((r) => r.dataset.key), keys1, 'DOM 序应与新数据序一致');
    // 旧行节点身份不变（指针推进：existing[i].dataset.key === key 时 i++ 跳过）
    assert.deepEqual(after.slice(0, 3), before, '前 3 行应是原节点引用');
    assert.equal(after[3].dataset.key, keys1[3]);
});

test('真实模板：_reorderCommentRows 基于模板行就地重排（非整表重绘）', () => {
    const { Detail } = loadDetail();
    const container = fakeList();
    fixture(Detail, container);
    // 用真实模板行重建容器（与 _renderComments 全量分支同款输出）
    const list0 = Detail._commentSortedList();
    const keys0 = Detail._commentKeys(list0);
    container.children.length = 0;
    keys0.forEach((k, i) => container.appendChild(parseHtml(Detail._commentRowHtml(list0[i], k))[0]));
    const imgs = container.querySelectorAll('.detail-comment').map((r) => r.querySelector('img'));
    Detail._commentDesc = true; // 切倒序
    const htmlSpy = { n: 0 };
    const orig = Detail._commentRowHtml;
    Detail._commentRowHtml = (...a) => { htmlSpy.n++; return orig.apply(Detail, a); };
    const ok = Detail._reorderCommentRows(container);
    Detail._commentRowHtml = orig;
    assert.equal(ok, true, '真实模板行应支持就地重排');
    assert.equal(htmlSpy.n, 0, '就地重排零模板调用（非整表重绘）');
    const after = container.querySelectorAll('.detail-comment');
    const wantKeys = Detail._commentKeys(Detail._commentSortedList());
    assert.deepEqual(after.map((r) => r.dataset.key), wantKeys);
    // 头像 img 节点身份不变：模板产出的 <img> 随行节点整体移动，未重建
    after.forEach((r, i) => assert.equal(r.querySelector('img'), imgs[2 - i], `第 ${i} 行 img 应为原节点`));
});

// ---------------------------------------------------------------- 源码锚点

test('源码锚点：旧「一行式翻转+整表重绘」已移除，就地重排入口存在', () => {
    const source = read('src/renderer/js/detail.js');
    assert.match(source, /_reorderCommentRows\(/, '应存在 _reorderCommentRows 就地重排入口');
    assert.doesNotMatch(
        source,
        /_commentDesc = !this\._commentDesc;\s*this\._renderComments\(\)/,
        '排序切换不得再直接整表重绘'
    );
    assert.match(source, /_commentSortedList\(/, '排序逻辑应抽出共用');
});
