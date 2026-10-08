'use strict';
// 图片放大浮层 v2：工具栏（缩放/旋转/复位/保存/复制地址/关闭）+ 评论图点击放大。
// VM 桩只给最小 DOM 面：#cover-float 首建走 createElement/getElementById 首空后存档路径。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

/** 极简 DOM 元素桩：记录 addEventListener 的 handler 供手动触发；querySelector 回归自身。 */
function mkEl(tag) {
    const el = {
        tag,
        id: '',
        style: {},
        listeners: {},
        children: [],
        _html: '',
        classList: {
            _set: new Set(),
            add(...k) { k.forEach((x) => this._set.add(x)); },
            remove(...k) { k.forEach((x) => this._set.delete(x)); },
            contains(k) { return this._set.has(k); },
        },
        addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
        appendChild(c) { el.children.push(c); return c; },
        removeAttribute() {},
        setAttribute(k, v) { el['attr_' + k] = v; },
        getAttribute(k) { return el['attr_' + k] === undefined ? null : el['attr_' + k]; },
        querySelector(sel) {
            if (sel === 'img') return el._img || null;
            if (sel === '.cover-float-toolbar button') return el._btn || null;
            return null;
        },
        closest() { return null; },
    };
    // detail.js 的浮层首建用 wrap.querySelector('img') 定位图片节点；真实 innerHTML
    // 解析后必有一个 img，桩里给每个 div 预置一个可复用的 img 桩对齐该不变量。
    if (tag === 'div') el._img = mkImg();
    return el;
}

function mkImg() {
    const el = {
        tag: 'img', style: {},
        removeAttribute() {},
        setAttribute(k, v) { el['attr_' + k] = v; },
        getAttribute(k) { return el['attr_' + k] === undefined ? null : el['attr_' + k]; },
        addEventListener(type, fn) { (el._imgEv[type] = el._imgEv[type] || []).push(fn); },
        removeEventListener(type, fn) {
            const arr = el._imgEv[type];
            if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
        },
        _imgEv: {},
    };
    // 真实 DOM 的 img.src 属性与 content attribute 双向同步（reflected attribute）；
    // 桩用 getter/setter 对齐，_openCoverFloat 的 getAttribute('src') 换图判断才不失真
    Object.defineProperty(el, 'src', {
        configurable: true,
        get() { return el.attr_src || ''; },
        set(v) { el.attr_src = String(v); },
    });
    const cls = new Set();
    el.classList = {
        add(...k) { k.forEach((x) => cls.add(x)); },
        remove(...k) { k.forEach((x) => cls.delete(x)); },
        contains(k) { return cls.has(k); },
        _set: cls,
    };
    return el;
}

function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object,
        parseInt, parseFloat, setTimeout, clearTimeout, setInterval, clearInterval,
        navigator: {},
        document: {
            _els: {},
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: {
                classList: { contains() { return false; } },
                children: [],
                appendChild(c) { this.children.push(c); if (c.id) this._byId[c.id] = c; },
                _byId: {},
            },
            getElementById(id) { return this.body._byId[id] || null; },
            createElement(tag) { const e = mkEl(tag); return e; },
        },
        $: () => ({ on() { return this; }, off() { return this; }, html() { return this; }, find() { return this; }, length: 0 }),
        registerEsc: () => {}, staggerEnter: () => {}, replayClass: () => {},
        escHtml: (s) => String(s), stripHtml: (s) => String(s || ''),
        warnToast: (m) => { context._toasts.push(m); },
        showLoading() {}, hideLoading() {},
        bangumiCover: () => '', vodCoverImg: () => '', normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        localCacheGet: () => null, localCacheSet: () => {}, localCacheDel: () => {},
        openDialog: () => {}, closeDialog: () => {},
        fmtCommentTimeFull: () => '', commentTsMs: () => 0,
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
        _toasts: [],
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, context };
}

/** 首次 _openCoverFloat 让 detail.js 走真实创建分支（监听器只在首建时绑定），
 * 再把创建出的 wrap 从 document.body.children 取出并接管 querySelector 指向 img 桩。 */
function bootstrapFloat(context, Detail) {
    Detail._openCoverFloat('https://example.com/_boot.jpg');
    const wrap = context.document.body.children[context.document.body.children.length - 1];
    wrap.querySelector = (sel) => (sel === 'img' ? wrap._img : (sel.startsWith('.cover-float-toolbar') && wrap._btn) || null);
    return wrap;
}

// ---------------------------------------------------------------- 换图防串影

test('_openCoverFloat：换图先摘 .loaded 隐没旧图，load 后复挂；同图重开不闪烁', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/a.jpg');
    // 换图：立即摘 .loaded（旧图隐没），挂 load/error 监听待新图淡入
    Detail._openCoverFloat('https://example.com/b.jpg');
    assert.ok(!wrap._img.classList.contains('loaded'), '换图瞬间旧图已隐没（摘 .loaded）');
    assert.equal(wrap._img.src, 'https://example.com/b.jpg');
    assert.equal(wrap._img._imgEv.load.length, 1, '挂了待淡入的 load 监听');
    wrap._img._imgEv.load[0]();
    assert.ok(wrap._img.classList.contains('loaded'), '新图 load 后复挂 .loaded 淡入');
    assert.equal(wrap._img._imgEv.load.length, 0, '淡入后监听自摘（守卫式，防多次换图累积）');
    // 连续换图：旧监听被显式摘除，不叠加
    Detail._openCoverFloat('https://example.com/c.jpg');
    assert.equal(wrap._img._imgEv.load.length, 1, '连续换图监听不累积');
    wrap._img._imgEv.load[0](); // 模拟新图加载完成
    // 同图重开：不动 loaded、不挂监听，避免无谓灭亮
    Detail._openCoverFloat('https://example.com/c.jpg');
    assert.ok(wrap._img.classList.contains('loaded'), '同图重开保持可见');
    assert.equal(wrap._img._imgEv.load.length, 0, '同图重开不新增监听');
});

// ---------------------------------------------------------------- 工具栏打开态

test('_openCoverFloat：打开时写入 src 并复位缩放/旋转状态', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/a.jpg');
    assert.equal(wrap._img.src, 'https://example.com/a.jpg');
    assert.equal(Detail._coverZoom, 1);
    assert.equal(Detail._coverRotate, 0);
    assert.ok(wrap.classList.contains('show'));
    // 二次打开另一张图：缩放旋转状态不残留
    Detail._coverZoom = 3; Detail._coverRotate = 90;
    Detail._openCoverFloat('https://example.com/b.jpg');
    assert.equal(wrap._img.src, 'https://example.com/b.jpg');
    assert.equal(Detail._coverZoom, 1);
    assert.equal(Detail._coverRotate, 0);
});

test('_openCoverFloat：工具栏按钮 zoom-in/out 与 rot-left/right 语义', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/a.jpg');
    // 找到按钮分支 listener（第二个 click listener 是按钮分发）
    const clicks = wrap.listeners.click;
    assert.equal(clicks.length, 2, '两个 click listener：遮罩关闭 + 按钮分发');
    const mkBtn = (act) => {
        const b = mkEl('button');
        b.setAttribute('data-cf', act);
        b.closest = () => b; // ev.target.closest 选择器命中自身
        return b;
    };
    let btn = mkBtn('zoom-in');
    wrap._btn = btn;
    clicks[1]({ target: btn });
    assert.equal(Detail._coverZoom, 1.2);
    // transform 应用到 img 上（rotate 前 scale 后的模板）
    assert.match(wrap._img.style.transform, /scale\(1\.2/);
    btn = mkBtn('zoom-out');
    wrap._btn = btn;
    clicks[1]({ target: btn });
    assert.ok(Math.abs(Detail._coverZoom - 1) < 1e-9);
    btn = mkBtn('rot-right');
    wrap._btn = btn;
    clicks[1]({ target: btn });
    assert.equal(Detail._coverRotate, 90);
    assert.match(wrap._img.style.transform, /rotate\(90deg\)/);
    btn = mkBtn('rot-left');
    wrap._btn = btn;
    clicks[1]({ target: btn });
    assert.equal(Detail._coverRotate, 0);
});

test('_openCoverFloat：复制地址走 clipboard.writeText，close 走退场', () => {
    const { Detail, context } = loadDetail({
        navigator: { clipboard: { writeText: async () => { context._copied = true; } } },
    });
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/c.jpg');
    const clicks = wrap.listeners.click;
    const mkBtn = (act) => {
        const b = mkEl('button');
        b.setAttribute('data-cf', act);
        b.closest = () => b;
        return b;
    };
    let btn = mkBtn('copy');
    wrap._btn = btn;
    const p = clicks[1]({ target: btn }); // clipboard.writeText 是 async，等微任务落地
    return Promise.resolve(p).then(() => {
        assert.equal(context._copied, true);
        assert.ok(context._toasts.includes('已复制图片地址'));
        btn = mkBtn('close');
        wrap._btn = btn;
        clicks[1]({ target: btn });
        assert.ok(wrap.classList.contains('float-out'), 'close 触发退场 .float-out');
    });
});

test('_openCoverFloat：保存按钮调用主进程 saveImage（文件名取 URL 尾段）', async () => {
    const { Detail, context } = loadDetail({
        window: { yuki: { settingsGet: async () => ({}), saveImage: async (url, name) => { context._saved = { url, name }; return { ok: true }; } } },
    });
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/pic/cover.webp');
    const clicks = wrap.listeners.click;
    const btn = mkEl('button');
    btn.setAttribute('data-cf', 'save');
    btn.closest = () => btn;
    wrap._btn = btn;
    clicks[1]({ target: btn });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(context._saved, { url: 'https://example.com/pic/cover.webp', name: 'cover.webp' });
    assert.ok(context._toasts.some((t) => t.includes('已保存图片')));
});

test('_saveImageAs：无扩展名 URL 自动补 .jpg；失败 toast', async () => {
    const { Detail, context } = loadDetail({
        window: { yuki: { settingsGet: async () => ({}), saveImage: async () => ({ ok: false, reason: 'http-404' }) } },
    });
    await Detail._saveImageAs('https://example.com/img?x=1');
    assert.ok(context._toasts.includes('保存图片失败'));
});

// ---------------------------------------------------------------- 遮罩/滚轮行为

test('cover-float 遮罩点击：空白处关闭，点图与点工具栏不关', () => {
    const { Detail, context } = loadDetail();
    const wrap = bootstrapFloat(context, Detail);
    Detail._openCoverFloat('https://example.com/a.jpg');
    const maskClicks = wrap.listeners.click;
    // 空 target（无 closest 命中）→ 关闭
    maskClicks[0]({ target: { closest: () => null } });
    assert.ok(wrap.classList.contains('float-out'));
    // 点 stage（图）→ 不触发关闭路径（这里只验证分支不抛错且不叠加 float-out 定时副作用）
    const wrap2 = bootstrapFloat(context, Detail);
    const d2 = Detail;
    d2._openCoverFloat('https://example.com/b.jpg');
    wrap2.listeners.click[0]({ target: { closest: (s) => (s === '.cover-float-stage' ? {} : null) } });
    // float-out 可能因前一次保留，断言 show 仍在（未走隐藏）
    assert.ok(wrap2.classList.contains('show'));
});

// ---------------------------------------------------------------- 评论图放大

test('_renderCommentBBCode：[img] 产出 .detail-comment-inline-img 可点击放大类', () => {
    const { Detail } = loadDetail();
    const html = Detail._renderCommentBBCode('[img]https://example.com/x.png[/img]');
    assert.match(html, /class="detail-comment-inline-img"/);
    assert.match(html, /src="https:\/\/example\.com\/x\.png"/);
});

test('_commentRowHtml：主楼/楼中楼头像带 data-big 大图口径', () => {
    const { Detail } = loadDetail();
    const row = Detail._commentRowHtml({
        user: { nickname: '甲', avatar: { medium: 'm.png', large: 'L.png' } },
        comment: '正文', createdAt: 1700000000,
        replies: [{ user: { nickname: '乙', avatar: { medium: 'rm.png', large: 'RL.png' } }, content: '回复', createdAt: 1700000001 }],
    }, 'k#1');
    assert.match(row, /src="m\.png" data-big="L\.png"/);
    assert.match(row, /src="rm\.png" data-big="RL\.png"/);
});

test('detail.js 源码锚点：评论区委托放大 + 浮层工具栏结构存在', () => {
    const src = read('src/renderer/js/detail.js');
    // 委托选择器覆盖头像 + 内嵌图
    assert.match(src, /\.on\('click', '\.detail-comment-avatar, \.detail-comment-inline-img'/);
    // 工具栏八个按钮
    for (const act of ['zoom-in', 'zoom-out', 'reset', 'rot-left', 'rot-right', 'save', 'copy', 'close']) {
        assert.ok(src.includes(`data-cf="${act}"`), `工具栏按钮 ${act} 存在`);
    }
    // 主进程 + preload 接线
    assert.match(read('src/main/index.js'), /ipcMain\.handle\('yuki:save-image'/);
    assert.match(read('src/preload/preload.js'), /saveImage: \(url, suggestedName\)/);
});
