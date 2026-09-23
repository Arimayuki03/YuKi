'use strict';
/**
 * common.js（渲染层共享工具库）白盒单元测试：纯函数与字符串/DOM 拼装逻辑。
 *
 * 加载方式：fs.readFileSync + node:vm，注入 document/window/$/console 等全局桩
 * （与 tests/js/records.test.js、bangumi-cover.test.js 同款写法）。
 *
 * 互补边界（避免重复造轮子）：
 * - xss-renderer.test.js：XSS 回归（bangumiCard 远端字段转义）——本文件只补
 *   escHtml/escPath 的字符集级用例与 truncateTitle 长度语义，不重复卡片注入串；
 * - bangumi-cover.test.js：bangumiCover 兜底链与基本 resize——本文件补
 *   bangumiResizeUrl 的畸形输入/大小写/查询串与镜像根归一化细节；
 * - cover-chain.test.js：兜底链基本切换——本文件补多级链构造细节与空链/脏数据。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '../../src/renderer/js/common.js');

// ---------------------------------------------------------------- 极简 jQuery / DOM 桩

/** 链式 jQuery 桩：够用即可（length/children/find/each/addClass/removeClass/hasClass/get）。 */
function jqOf(items) {
    const api = {
        length: items.length,
        _items: items,
        0: items[0],
        get() { return items.slice(); },
        find(sel) {
            const cls = String(sel).replace(/^\./, '');
            const out = [];
            for (const it of items) for (const c of (it._children || [])) if (c._classes && c._classes.has(cls)) out.push(c);
            return jqOf(out);
        },
        children(sel) {
            const cls = String(sel || '').replace(/^\./, '');
            const out = [];
            for (const it of items) for (const c of (it._children || [])) if (!cls || (c._classes && c._classes.has(cls))) out.push(c);
            return jqOf(out);
        },
        each(fn) { items.forEach((el, i) => fn.call(el, i, el)); return api; },
        addClass(c) { items.forEach((el) => el._classes && el._classes.add(c)); return api; },
        removeClass(c) { items.forEach((el) => el._classes && el._classes.delete(c)); return api; },
        hasClass(c) { return items.some((el) => el._classes && el._classes.has(c)); },
        on() { return api; }, off() { return api; }, empty() { return api; },
        html() { return api; }, text() { return api; }, css() { return api; },
        data() { return ''; }, removeAttr() { return api; },
    };
    return api;
}

/** 极简 DOM 元素：_classes/_children/style/textContent/attrs + 事件监听收集。 */
function makeEl(classes = [], props = {}) {
    const el = {
        _classes: new Set(classes),
        _children: [],
        style: {},
        textContent: '',
        attrs: {},
        listeners: [],
        getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
        setAttribute(n, v) { this.attrs[n] = String(v); },
        addEventListener(type, fn, opt) { this.listeners.push({ type, fn, opt }); },
        removeEventListener() {},
        closest() { return null; },
    };
    return Object.assign(el, props);
}

/** 可测量文本高度的 .vod-name 元素：每 perLine 字一行、行高 20px。 */
function makeTextEl(text, perLine = 10, clientHeight = 40) {
    const el = makeEl(['vod-name'], { clientHeight });
    el.textContent = text;
    Object.defineProperty(el, 'scrollHeight', {
        get() { return Math.ceil(this.textContent.length / perLine) * 20; },
        configurable: true,
    });
    return el;
}

/** 在 VM 中加载 common.js，注入最小全局桩；返回上下文（__api 为被测函数集合）。 */
function loadCommon(extra = {}) {
    const source = fs.readFileSync(SRC, 'utf8');
    const registry = new Map();     // CSS 选择器 → 元素数组（供 $('.vod-name') 等全局查询）
    const toasts = [];              // warnToast 调用记录
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array,
        parseInt, parseFloat, setTimeout, clearTimeout, URLSearchParams,
        crypto: globalThis.crypto,
        // $ 桩：字符串选择器走 registry；对象视作单元素集合（$(window)/$(document)/$(容器)）
        $: (arg) => {
            if (typeof arg === 'string') return jqOf(registry.get(arg) || []);
            if (arg && typeof arg === 'object') return jqOf([arg]);
            return jqOf([]);
        },
        getComputedStyle: () => ({ lineHeight: '20px' }),
        document: {
            addEventListener() {}, removeEventListener() {},
            querySelector: () => null, querySelectorAll: () => [],
            getElementById: () => null,
            createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false } }),
            documentElement: {
                classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                style: { setProperty() {}, removeProperty() {} },
                dataset: {},
            },
            body: { style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {} }, dataset: {} },
            head: { appendChild() {} },
        },
        window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        fetch: async () => ({ ok: true, text: async () => '' }),
        AbortSignal: { timeout: () => ({}) },
        ...extra,
    };
    context.globalThis = context;
    context.__toasts = toasts;      // 加载前先挂，供源码内 warnToast 重绑定时闭包引用
    vm.createContext(context);
    vm.runInContext(`${source}
;globalThis.__api = {
    createRuntimeId, setBackendInfo, apiUrl, escPath, escHtml, truncateTitle,
    fitVodTitle, fitVodTitles, playCardsEnter, stageAppendedCards, refitVodTitles,
    vodPlaceholder, coverFadeIn, vodCoverImg, coverChainNext, localPlayToast,
    vodCoverChain, bangumiResizeUrl, setBangumiMirrorRoot, bangumiMirrorUrl,
    isBangumiCoverUrl, bangumiCoverImg, bangumiCover, errorTextOf, bangumiCard,
    normalizePic, fmtSize, stripHtml, toFileUrl,
};`, context, { filename: 'common.js' });
    // 源码内 `function warnToast` 声明会覆盖外部同名桩（localPlayToast 直调它），
    // 加载后重绑定，让 toast 文案落到 __toasts 供断言（同 records.test.js 手法）。
    vm.runInContext(';warnToast = (m) => { globalThis.__toasts.push(String(m)); };', context);
    context.__registry = registry;
    context.__Error = vm.runInContext('Error', context); // VM realm 的 Error（供 instanceof 判定）
    return context;
}

/** 从 vodCoverChain/vodCoverImg 产出的 HTML 还原一个可驱动的 <img> 桩。 */
function imgFromHtml(html, cardSource) {
    const src = (html.match(/src="([^"]*)"/) || [])[1] || '';
    const fb = (html.match(/data-fb="([^"]*)"/) || [])[1] || undefined;
    const img = {
        dataset: fb === undefined ? {} : { fb },
        src,
        onerror: () => {},
        classList: { _s: new Set(), add(c) { this._s.add(c); } },
        setAttribute(n, v) { this.attrs = this.attrs || {}; this.attrs[n] = String(v); },
    };
    img.closest = () => (cardSource !== undefined ? { dataset: { source: cardSource } } : null);
    return img;
}

const A = (ctx) => ctx.__api;

// ---------------------------------------------------------------- escHtml（转义字符集）

test('escHtml：script 标签与尖括号转实体，注入串不产出可执行标签', () => {
    const { escHtml } = A(loadCommon());
    assert.equal(escHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(escHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.doesNotMatch(escHtml('<b>x</b>'), /<b>/);
});

test('escHtml：双引号转 &quot;、单引号转 &#39;（属性位闭合注入）', () => {
    const { escHtml } = A(loadCommon());
    assert.equal(escHtml('" onmouseover="x'), '&quot; onmouseover=&quot;x');
    assert.equal(escHtml("' onerror='x'"), '&#39; onerror=&#39;x&#39;');
    // H-6 回归：单引号必须转义，否则可闭合属性内单引号 JS 字符串
    assert.doesNotMatch(escHtml("a'"), /'/);
});

test('escHtml：& 先转 &amp;，已有实体会被二次转义（无幂等保护）', () => {
    const { escHtml } = A(loadCommon());
    assert.equal(escHtml('&<>'), '&amp;&lt;&gt;');
    assert.equal(escHtml('&amp;'), '&amp;amp;');
});

test('escHtml：反引号与 javascript: 协议不做处理（仅字符转义，不做协议过滤）', () => {
    const { escHtml } = A(loadCommon());
    assert.equal(escHtml('`${x}`'), '`${x}`');
    assert.equal(escHtml('javascript:alert(1)'), 'javascript:alert(1)');
});

test('escHtml：Unicode 全角尖括号（U+FF1C/FF1E）不在 ASCII 转义范围内，原样透传', () => {
    const { escHtml } = A(loadCommon());
    assert.equal(escHtml('＜script＞'), '＜script＞');
});

test('escHtml：null/undefined/数字/数组等非字符串输入经 String() 兜底不抛错', () => {
    const { escHtml } = A(loadCommon());
    assert.equal(escHtml(null), 'null');
    assert.equal(escHtml(undefined), 'undefined');
    assert.equal(escHtml(42), '42');
    assert.equal(escHtml(['<b>']), '&lt;b&gt;');
    assert.equal(escHtml({}), '[object Object]');
});

test('escHtml：超长串（1 万个 <）全部转义且不截断', () => {
    const { escHtml } = A(loadCommon());
    const out = escHtml('<'.repeat(10000));
    assert.equal(out, '&lt;'.repeat(10000));
    assert.equal(out.length, 40000);
});

// ---------------------------------------------------------------- escPath（属性内 JS 字符串）

test('escPath：& → &amp;、双引号 → &quot;（属性值位安全）', () => {
    const { escPath } = A(loadCommon());
    assert.equal(escPath('a&b"c'), 'a&amp;b&quot;c');
});

test('escPath：反斜杠转双反斜杠、单引号转 \\\'（JS 字符串字面量转义）', () => {
    const { escPath } = A(loadCommon());
    assert.equal(escPath("a'b"), "a\\'b");
    assert.equal(escPath('a\\b'), 'a\\\\b');
    assert.equal(escPath("\\'"), "\\\\\\'");
});

test('escPath：不转义尖括号——仅适用于属性值内的 JS 字符串，不能用于文本节点', () => {
    const { escPath } = A(loadCommon());
    assert.equal(escPath('<script>'), '<script>');
    // 与 escHtml 的分工对比：同一输入在文本节点位必须走 escHtml
    assert.equal(A(loadCommon()).escHtml('<script>'), '&lt;script&gt;');
});

test('escPath：null/undefined 无 String() 保护，直接抛 TypeError（与 escHtml 不一致）', () => {
    const { escPath } = A(loadCommon());
    assert.throws(() => escPath(null), (e) => e.name === 'TypeError' || e instanceof TypeError);
    assert.throws(() => escPath(undefined), (e) => e.name === 'TypeError' || e instanceof TypeError);
});

// ---------------------------------------------------------------- truncateTitle

test('truncateTitle：超长标题按码元截断，且不追加省略号（省略号由 fitVodTitle 负责）', () => {
    const { truncateTitle } = A(loadCommon());
    assert.equal(truncateTitle('abcdefg', 3), 'abc');
    assert.doesNotMatch(truncateTitle('abcdefg', 3), /…/);
});

test('truncateTitle：长度小于/正好等于 max 时原样返回', () => {
    const { truncateTitle } = A(loadCommon());
    assert.equal(truncateTitle('ab', 3), 'ab');
    assert.equal(truncateTitle('abc', 3), 'abc');
});

test('truncateTitle：max 为 0/负数/缺省时回退默认 60 字符', () => {
    const { truncateTitle } = A(loadCommon());
    assert.equal(truncateTitle('x'.repeat(100), 0).length, 60);
    assert.equal(truncateTitle('x'.repeat(100), -5).length, 60);
    assert.equal(truncateTitle('x'.repeat(100)).length, 60);
});

test('truncateTitle：null/undefined 返回空串；数字先转字符串再截断', () => {
    const { truncateTitle } = A(loadCommon());
    assert.equal(truncateTitle(null), '');
    assert.equal(truncateTitle(undefined), '');
    assert.equal(truncateTitle(''), '');
    assert.equal(truncateTitle(123456, 3), '123');
});

test('truncateTitle：中文按 UTF-16 码元计数（一个汉字算 1）', () => {
    const { truncateTitle } = A(loadCommon());
    assert.equal(truncateTitle('一二三四五六', 3), '一二三');
    assert.equal(truncateTitle('一二三四五六', 6), '一二三四五六');
});

test('truncateTitle：emoji 代理对占 2 个码元，max=2 恰好保留一个完整 emoji', () => {
    const { truncateTitle } = A(loadCommon());
    const out = truncateTitle('👍👍', 2);
    assert.equal(out, '👍');
    assert.equal(out.length, 2); // 一个代理对 = 2 个码元，未被切成半个字符
});

// ---------------------------------------------------------------- createRuntimeId

test('createRuntimeId：默认前缀 req，命中 crypto.randomUUID 时输出 UUID 形态', () => {
    const { createRuntimeId } = A(loadCommon());
    assert.match(createRuntimeId(), /^req-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.match(createRuntimeId('play'), /^play-[0-9a-f]{8}-/);
});

test('createRuntimeId：200 次调用生成的追踪 ID 互不重复', () => {
    const { createRuntimeId } = A(loadCommon());
    const ids = new Set(Array.from({ length: 200 }, () => createRuntimeId()));
    assert.equal(ids.size, 200);
});

test('createRuntimeId：crypto.randomUUID 缺失时回退「时间戳 + 随机串」形态', () => {
    const { createRuntimeId } = A(loadCommon({ crypto: undefined }));
    assert.match(createRuntimeId(), /^req-[0-9a-z]+-[0-9a-z]{1,10}$/);
    assert.notEqual(createRuntimeId(), createRuntimeId());
});

test('createRuntimeId：randomUUID 抛异常时同样回退（try/catch 兜底不中断）', () => {
    const { createRuntimeId } = A(loadCommon({
        crypto: { get randomUUID() { throw new Error('unavailable'); } },
    }));
    assert.match(createRuntimeId(), /^req-[0-9a-z]+-[0-9a-z]{1,10}$/);
});

// ---------------------------------------------------------------- apiUrl / setBackendInfo

test('apiUrl：默认后端（空 base/token）拼出 path?token=', () => {
    const { apiUrl } = A(loadCommon());
    assert.equal(apiUrl('/action'), '/action?token=');
    assert.equal(apiUrl('action'), 'action?token='); // 无前导斜杠也直接拼接
});

test('apiUrl：路径已含查询串时用 & 连接 token（不再追加第二个 ?）', () => {
    const { apiUrl } = A(loadCommon());
    assert.equal(apiUrl('/list?a=1'), '/list?a=1&token=');
    assert.equal(apiUrl('/list?a=1&b=2'), '/list?a=1&b=2&token=');
});

test('apiUrl：token 经 encodeURIComponent（空格与 & 均转义）', () => {
    const { apiUrl, setBackendInfo } = A(loadCommon());
    setBackendInfo({ base: 'http://127.0.0.1:9977', token: 'a b&c' });
    assert.equal(apiUrl('/action'), 'http://127.0.0.1:9977/action?token=a%20b%26c');
});

test('setBackendInfo：切换后端后 base 立即生效；base 为空/空入参被忽略', () => {
    const { apiUrl, setBackendInfo } = A(loadCommon());
    setBackendInfo({ base: 'http://a:1', token: 't1' });
    assert.equal(apiUrl('/x'), 'http://a:1/x?token=t1');
    setBackendInfo({ base: '', token: 'zz' });      // base 空 → 整包忽略
    assert.equal(apiUrl('/x'), 'http://a:1/x?token=t1');
    setBackendInfo(null);
    assert.equal(apiUrl('/x'), 'http://a:1/x?token=t1');
    setBackendInfo({ base: 'http://b:2', token: 't2' }); // 后端重启换端口
    assert.equal(apiUrl('/x'), 'http://b:2/x?token=t2');
});

// ---------------------------------------------------------------- errorTextOf

test('errorTextOf：Error 取 message；空 message 回落 String(err)', () => {
    const ctx = loadCommon();
    const { errorTextOf } = A(ctx);
    assert.equal(errorTextOf(new ctx.__Error('boom')), 'boom');
    assert.equal(errorTextOf(new ctx.__Error('')), 'Error');
});

test('errorTextOf：字符串入参去首尾空白', () => {
    const { errorTextOf } = A(loadCommon());
    assert.equal(errorTextOf('  hi  '), 'hi');
    assert.equal(errorTextOf('   '), '');
});

test('errorTextOf：后端 RuntimeResponse 对象取 "code message"（不再是 [object Object]）', () => {
    const { errorTextOf } = A(loadCommon());
    assert.equal(errorTextOf({ code: 'L3_RUNTIME_CALL_FAILED', message: '蜘蛛调用失败' }), 'L3_RUNTIME_CALL_FAILED 蜘蛛调用失败');
    assert.equal(errorTextOf({ msg: 'oops' }), 'oops');
    assert.equal(errorTextOf({ code: 0, message: 'x' }), 'x'); // code=0 视为缺省
});

test('errorTextOf：嵌套 {error:{...}} 逐层下钻，maxLen 一并透传到最内层', () => {
    const { errorTextOf } = A(loadCommon());
    assert.equal(errorTextOf({ error: { code: 'E2', message: 'inner' } }), 'E2 inner');
    assert.equal(errorTextOf({ error: { error: { message: 'deep' } } }), 'deep');
    assert.equal(errorTextOf({ error: 'plain' }), 'plain');
    assert.equal(errorTextOf({ error: { message: 'abcdefghij' } }, 5), 'abcde…');
});

test('errorTextOf：普通对象无 message 时 JSON 化；循环引用回落 String()', () => {
    const { errorTextOf } = A(loadCommon());
    assert.equal(errorTextOf({ a: 1 }), '{"a":1}');
    const cyc = {}; cyc.self = cyc;
    assert.equal(errorTextOf(cyc), '[object Object]');
});

test('errorTextOf：null/undefined 返回空串；数字走 String()', () => {
    const { errorTextOf } = A(loadCommon());
    assert.equal(errorTextOf(null), '');
    assert.equal(errorTextOf(undefined), '');
    assert.equal(errorTextOf(42), '42');
});

test('errorTextOf：超过 maxLen 末尾追加省略号；maxLen<=0 时不裁剪', () => {
    const { errorTextOf } = A(loadCommon());
    const dflt = errorTextOf('x'.repeat(200));
    assert.equal(dflt.length, 121);
    assert.ok(dflt.endsWith('…'));
    assert.equal(errorTextOf('x'.repeat(200), 10).length, 11);
    assert.equal(errorTextOf('x'.repeat(200), 0).length, 200);
    assert.doesNotMatch(errorTextOf('x'.repeat(200), 0), /…/);
});

// ---------------------------------------------------------------- bangumiResizeUrl

test('bangumiResizeUrl：裸路径形式按 /pic/cover/{lcmgs}/ 段字母替换各 variant', () => {
    const { bangumiResizeUrl } = A(loadCommon());
    const L = 'https://lain.bgm.tv/pic/cover/l/a/b/1.jpg';
    const seg = (c) => L.replace('/cover/l/', `/cover/${c}/`);
    assert.equal(bangumiResizeUrl(L, 'large'), seg('l'));
    assert.equal(bangumiResizeUrl(L, 'common'), seg('c'));
    assert.equal(bangumiResizeUrl(L, 'medium'), seg('m'));
    assert.equal(bangumiResizeUrl(L, 'small'), seg('s'));
    assert.equal(bangumiResizeUrl(L, 'grid'), seg('g'));
    assert.equal(bangumiResizeUrl(L, 'card'), seg('c')); // card → common 段
});

test('bangumiResizeUrl：目标变体与当前段一致时幂等（不重复改写）', () => {
    const { bangumiResizeUrl } = A(loadCommon());
    const C = 'https://lain.bgm.tv/pic/cover/c/a/b/1.jpg';
    assert.equal(bangumiResizeUrl(C, 'common'), C);
    assert.equal(bangumiResizeUrl(C, 'card'), C);
});

test('bangumiResizeUrl：不含 /pic/cover/ 段的 URL 原样透传', () => {
    const { bangumiResizeUrl } = A(loadCommon());
    assert.equal(bangumiResizeUrl('https://example.com/a.jpg', 'card'), 'https://example.com/a.jpg');
    assert.equal(bangumiResizeUrl('https://lain.bgm.tv/other/l/a.jpg', 'card'), 'https://lain.bgm.tv/other/l/a.jpg');
    assert.equal(bangumiResizeUrl('https://lain.bgm.tv/pic/cover/l', 'card'), 'https://lain.bgm.tv/pic/cover/l'); // 段后无斜杠
});

test('bangumiResizeUrl：按路径形态判定——非 lain 域名但命中 /pic/cover/x/ 也会被改写', () => {
    const { bangumiResizeUrl } = A(loadCommon());
    assert.equal(
        bangumiResizeUrl('https://example.com/pic/cover/l/a.jpg', 'card'),
        'https://example.com/pic/cover/c/a.jpg');
});

test('bangumiResizeUrl：畸形输入（空串/null/未知 variant）原样返回', () => {
    const { bangumiResizeUrl } = A(loadCommon());
    assert.equal(bangumiResizeUrl('', 'card'), '');
    assert.equal(bangumiResizeUrl(null, 'card'), '');
    assert.equal(bangumiResizeUrl(undefined, 'large'), '');
    assert.equal(bangumiResizeUrl('https://lain.bgm.tv/pic/cover/l/a.jpg', 'huge'),
        'https://lain.bgm.tv/pic/cover/l/a.jpg');
    assert.equal(bangumiResizeUrl('https://lain.bgm.tv/pic/cover/l/a.jpg'), 'https://lain.bgm.tv/pic/cover/l/a.jpg');
});

test('bangumiResizeUrl：尺寸段匹配大小写不敏感，带查询串时只改路径段', () => {
    const { bangumiResizeUrl } = A(loadCommon());
    assert.equal(
        bangumiResizeUrl('https://lain.bgm.tv/PIC/COVER/L/a.jpg', 'card'),
        'https://lain.bgm.tv/PIC/COVER/c/a.jpg');
    assert.equal(
        bangumiResizeUrl('https://lain.bgm.tv/pic/cover/l/a.jpg?x=1&y=2', 'card'),
        'https://lain.bgm.tv/pic/cover/c/a.jpg?x=1&y=2');
});

test('bangumiResizeUrl：r 前缀形式改宽度，large 移除前缀后不残留 /r/ 与重复斜杠', () => {
    const { bangumiResizeUrl } = A(loadCommon());
    const out = bangumiResizeUrl('https://lain.bgm.tv/r/400/pic/cover/l/a/b/1.jpg', 'large');
    assert.equal(out, 'https://lain.bgm.tv/pic/cover/l/a/b/1.jpg');
    assert.doesNotMatch(out, /\/r\//);
    assert.doesNotMatch(out.slice('https://'.length), /\/\//);
});

// ---------------------------------------------------------------- setBangumiMirrorRoot / bangumiMirrorUrl

test('setBangumiMirrorRoot：剥协议/路径/端口/尾点并小写归一，返回归一化值', () => {
    const { setBangumiMirrorRoot } = A(loadCommon());
    assert.equal(setBangumiMirrorRoot('HTTPS://Mirror.Example.com:8080/some/path///'), 'mirror.example.com');
    assert.equal(setBangumiMirrorRoot('  My.Mirror.Example.com  '), 'my.mirror.example.com');
    assert.equal(setBangumiMirrorRoot('mirror.example.com/'), 'mirror.example.com');
    assert.equal(setBangumiMirrorRoot('mirror.example.com.'), 'mirror.example.com');
});

test('setBangumiMirrorRoot：非法值（空白/单标签/含空格/仅协议前缀）返回空串且保持原镜像根', () => {
    const ctx = loadCommon();
    const { setBangumiMirrorRoot, bangumiMirrorUrl } = A(ctx);
    assert.equal(setBangumiMirrorRoot(''), '');
    assert.equal(setBangumiMirrorRoot('   '), '');
    assert.equal(setBangumiMirrorRoot('localhost'), '');       // 单标签主机名拒绝
    assert.equal(setBangumiMirrorRoot('not a domain'), '');
    assert.equal(setBangumiMirrorRoot('http://'), '');
    assert.equal(bangumiMirrorUrl('https://lain.bgm.tv/a.jpg'), 'https://lain.bangumi.vip/a.jpg'); // 原值未变
});

test('bangumiMirrorUrl：设置镜像根前后 URL 改写对比（默认 bangumi.vip → 自定义根）', () => {
    const { setBangumiMirrorRoot, bangumiMirrorUrl } = A(loadCommon());
    const u = 'https://lain.bgm.tv/pic/cover/c/a.jpg';
    assert.equal(bangumiMirrorUrl(u), 'https://lain.bangumi.vip/pic/cover/c/a.jpg');
    assert.equal(setBangumiMirrorRoot('Mirror.Example.com'), 'mirror.example.com');
    assert.equal(bangumiMirrorUrl(u), 'https://lain.mirror.example.com/pic/cover/c/a.jpg');
    assert.equal(bangumiMirrorUrl('http://lain.bangumi.tv/a.jpg'), 'https://lain.mirror.example.com/a.jpg'); // 同时升 https
});

test('bangumiMirrorUrl：仿冒域名（子域/后缀变形）不换域', () => {
    const { bangumiMirrorUrl } = A(loadCommon());
    assert.equal(bangumiMirrorUrl('https://sub.lain.bgm.tv/a.jpg'), 'https://sub.lain.bgm.tv/a.jpg');
    assert.equal(bangumiMirrorUrl('https://lain.bgm.tv.evil.com/a.jpg'), 'https://lain.bgm.tv.evil.com/a.jpg');
});

test('bangumiMirrorUrl：空值与第三方图床域名原样返回', () => {
    const { bangumiMirrorUrl } = A(loadCommon());
    assert.equal(bangumiMirrorUrl(''), '');
    assert.equal(bangumiMirrorUrl(null), '');
    assert.equal(bangumiMirrorUrl('https://s4.anilist.co/a.jpg'), 'https://s4.anilist.co/a.jpg');
});

// ---------------------------------------------------------------- isBangumiCoverUrl

test('isBangumiCoverUrl：官方 lain.bgm.tv / lain.bangumi.tv 与历史/当前镜像域名均命中', () => {
    const { isBangumiCoverUrl } = A(loadCommon());
    for (const host of ['lain.bgm.tv', 'lain.bangumi.tv', 'lain.bangumi.pro', 'lain.bangumi.vip']) {
        assert.ok(isBangumiCoverUrl(`https://${host}/pic/cover/c/a.jpg`), `${host} 应命中`);
    }
    assert.ok(isBangumiCoverUrl('//lain.bgm.tv/pic/cover/c/a.jpg')); // 协议相对
});

test('isBangumiCoverUrl：非 Bangumi 域名与空值不命中', () => {
    const { isBangumiCoverUrl } = A(loadCommon());
    assert.ok(!isBangumiCoverUrl('https://example.com/pic/cover/c/a.jpg'));
    assert.ok(!isBangumiCoverUrl('https://s4.anilist.co/a.jpg'));
    assert.ok(!isBangumiCoverUrl(''));
    assert.ok(!isBangumiCoverUrl(null));
    assert.ok(!isBangumiCoverUrl(undefined));
});

test('isBangumiCoverUrl：自定义镜像根生效，且根中的点被正则转义（不误命中 axb）', () => {
    const { isBangumiCoverUrl, setBangumiMirrorRoot } = A(loadCommon());
    assert.equal(setBangumiMirrorRoot('a-b.example.com'), 'a-b.example.com');
    assert.ok(isBangumiCoverUrl('https://lain.a-b.example.com/a.jpg'));
    assert.ok(!isBangumiCoverUrl('https://lain.axb.example.com/a.jpg'));
});

test('isBangumiCoverUrl：路径中段出现 lain.bgm.tv/ 也命中（前缀判定宽松，仅用于封面识别非鉴权）', () => {
    const { isBangumiCoverUrl } = A(loadCommon());
    assert.ok(isBangumiCoverUrl('https://evil.com/lain.bgm.tv/x.jpg'));
});

// ---------------------------------------------------------------- vodCoverChain / coverChainNext

test('vodCoverChain：多级兜底链按序构造，data-fb 用 || 连接后续候选', () => {
    const { vodCoverChain } = A(loadCommon());
    const html = vodCoverChain(['https://a/1.jpg', 'https://b/2.jpg', 'https://c/3.jpg'], false);
    const img = imgFromHtml(html);
    assert.equal(img.src, 'https://a/1.jpg');
    assert.equal(img.dataset.fb, 'https://b/2.jpg||https://c/3.jpg');
    assert.match(html, /loading="lazy"/);
    assert.match(html, /onerror="coverChainNext\(this\)"/);
});

test('vodCoverChain：过滤非法候选（相对路径/空串）；全非法时落占位图并标 missing', () => {
    const { vodCoverChain, vodPlaceholder } = A(loadCommon());
    const mixed = vodCoverChain(['', 'abc/rel.jpg', 'https://a/1.jpg'], true);
    const img = imgFromHtml(mixed);
    assert.equal(img.src, 'https://a/1.jpg');
    assert.equal(img.dataset.fb, undefined); // 只有一个合法候选 → 无 data-fb
    const empty = vodCoverChain([], true);
    assert.match(empty, new RegExp(vodPlaceholder()));
    assert.match(empty, /data-cover-missing="1"/);
    assert.match(vodCoverChain(null), /data-cover-missing="1"/);
});

test('vodCoverChain：候选 URL 中的双引号被 escHtml 转义，不产出属性闭合', () => {
    const { vodCoverChain } = A(loadCommon());
    const html = vodCoverChain(['https://a/"onerror="x', 'https://b/2.jpg'], true);
    assert.doesNotMatch(html, /"onerror="/);
    assert.match(html, /src="https:\/\/a\/&quot;onerror=&quot;x"/);
});

test('coverChainNext：三级链按序逐级切换，耗尽后置空 onerror 并落占位图', () => {
    const ctx = loadCommon();
    const { vodCoverChain, coverChainNext, vodPlaceholder } = A(ctx);
    const img = imgFromHtml(vodCoverChain(['https://a/1.jpg', 'https://b/2.jpg', 'https://c/3.jpg']));
    coverChainNext(img);
    assert.equal(img.src, 'https://b/2.jpg');
    assert.equal(img.dataset.fb, 'https://c/3.jpg');
    coverChainNext(img);
    assert.equal(img.src, 'https://c/3.jpg');
    assert.equal(img.dataset.fb, '');
    coverChainNext(img);
    assert.equal(img.src, vodPlaceholder());
    assert.equal(img.onerror, null);
    assert.ok(img.classList._s.has('loaded'));
});

test('coverChainNext：无 dataset / 无兜底链时直接占位且不抛错', () => {
    const ctx = loadCommon();
    const { coverChainNext, vodPlaceholder } = A(ctx);
    const bare = { src: 'https://a/1.jpg', onerror: () => {}, classList: { _s: new Set(), add(c) { this._s.add(c); } }, setAttribute() {} };
    assert.doesNotThrow(() => coverChainNext(bare));
    assert.equal(bare.src, vodPlaceholder());
    const empty = { dataset: {}, src: 'https://a/1.jpg', onerror: () => {}, classList: { _s: new Set(), add(c) { this._s.add(c); } }, setAttribute() {} };
    coverChainNext(empty);
    assert.equal(empty.src, vodPlaceholder());
    // 脏对象（连 classList 都没有）：占位赋值先成功，随后加 loaded 类抛 TypeError
    assert.throws(() => coverChainNext({}), (e) => e.name === 'TypeError' || e instanceof TypeError);
});

// ---------------------------------------------------------------- 封面渲染 / 淡入 / Toast

test('vodPlaceholder：返回统一占位图资产路径', () => {
    const { vodPlaceholder } = A(loadCommon());
    assert.equal(vodPlaceholder(), 'assets/cover-fallback.svg');
});

test('vodCoverImg：无封面时输出占位图并标 data-cover-missing（供后台补拉认领）', () => {
    const { vodCoverImg, vodPlaceholder } = A(loadCommon());
    const html = vodCoverImg('');
    assert.match(html, new RegExp(`src="${vodPlaceholder()}"`));
    assert.match(html, /data-cover-missing="1"/);
    assert.match(html, /loading="lazy"/); // 默认惰性
    assert.match(html, /onerror="this\.onerror=null/); // 换兜底后置空防死循环
});

test('vodCoverImg：有封面时输出 no-referrer 与 eager/lazy 策略，且不标 missing', () => {
    const { vodCoverImg } = A(loadCommon());
    const html = vodCoverImg('https://a/b.jpg', true);
    assert.match(html, /src="https:\/\/a\/b\.jpg"/);
    assert.match(html, /loading="eager"/);
    assert.match(html, /decoding="async"/);
    assert.match(html, /referrerpolicy="no-referrer"/);
    assert.doesNotMatch(html, /data-cover-missing/);
});

test('coverFadeIn：缓存命中（complete+naturalWidth）立即加 loaded；横图加 landscape', () => {
    const { coverFadeIn } = A(loadCommon());
    const mk = (w, h) => ({
        complete: true, naturalWidth: w, naturalHeight: h,
        classList: { _s: new Set(), add(c) { this._s.add(c); } },
        addEventListener() {},
    });
    const wide = mk(800, 600); coverFadeIn(wide);
    assert.ok(wide.classList._s.has('loaded'));
    assert.ok(wide.classList._s.has('landscape'));
    const tall = mk(400, 600); coverFadeIn(tall);
    assert.ok(tall.classList._s.has('loaded'));
    assert.ok(!tall.classList._s.has('landscape'));
});

test('coverFadeIn：未加载完成时注册一次性 load 监听，触发后才加 loaded', () => {
    const { coverFadeIn } = A(loadCommon());
    const img = {
        complete: false, naturalWidth: 0, naturalHeight: 0,
        classList: { _s: new Set(), add(c) { this._s.add(c); } },
        listeners: [], addEventListener(t, f, o) { this.listeners.push({ t, f, o }); },
    };
    coverFadeIn(img);
    assert.equal(img.classList._s.has('loaded'), false);
    assert.equal(img.listeners.length, 1);
    assert.equal(img.listeners[0].t, 'load');
    assert.equal(img.listeners[0].o.once, true);
    img.naturalWidth = 300; img.naturalHeight = 400;
    img.listeners[0].f();
    assert.ok(img.classList._s.has('loaded'));
});

test('localPlayToast：外部播放器 / mpv / Anime4K 档位四种文案', () => {
    const ctx = loadCommon();
    const { localPlayToast } = A(ctx);
    localPlayToast({ viaExternal: true });
    localPlayToast({});
    localPlayToast(null);
    localPlayToast({ anime4k: true, anime4kModeLabel: '质量' });
    localPlayToast({ anime4k: true });
    assert.deepEqual(ctx.__toasts, [
        '已交由指定播放器播放',
        '已在 mpv 窗口播放',
        '已在 mpv 窗口播放',
        '已在 mpv 窗口播放（Anime4K 超分已生效：质量）',
        '已在 mpv 窗口播放（Anime4K 超分已生效：均衡）', // 无档位标签时回落「均衡」
    ]);
});

// ---------------------------------------------------------------- normalizePic / fmtSize / stripHtml / toFileUrl

test('normalizePic：// 开头补 https、非 http(s)/data 视为无封面、空格转 %20', () => {
    const { normalizePic } = A(loadCommon());
    assert.equal(normalizePic('  https://a/b.jpg  '), 'https://a/b.jpg');
    assert.equal(normalizePic('//a/b.jpg'), 'https://a/b.jpg');
    assert.equal(normalizePic('a/b.jpg'), '');
    assert.equal(normalizePic('ftp://a/b.jpg'), '');
    assert.equal(normalizePic('https://a/b c.jpg'), 'https://a/b%20c.jpg');
    assert.equal(normalizePic('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
    assert.equal(normalizePic(''), '');
    assert.equal(normalizePic(null), '');
});

test('fmtSize：字节数到 KB/MB/GB/TB 的阈值与小数位，超过 TB 不再升档', () => {
    const { fmtSize } = A(loadCommon());
    assert.equal(fmtSize(0), '0 B');
    assert.equal(fmtSize(-5), '0 B');
    assert.equal(fmtSize(512), '512 B');
    assert.equal(fmtSize(1024), '1.0 KB');
    assert.equal(fmtSize(1536), '1.5 KB');
    assert.equal(fmtSize(1024 * 1024), '1.0 MB');
    assert.equal(fmtSize(1024 ** 3), '1.0 GB');
    assert.equal(fmtSize(1024 ** 4), '1.0 TB');
    assert.equal(fmtSize(1024 ** 5), '1024 TB'); // 档位用尽，数值继续增长
});

test('stripHtml：剥标签并把块级闭合转成段落换行，实体解码、零宽字符清除', () => {
    const { stripHtml } = A(loadCommon());
    assert.equal(stripHtml('<p>a</p><p>b</p>'), 'a\n\nb');
    assert.equal(stripHtml('<script>x</script>ok'), 'ok');
    assert.equal(stripHtml('a<br>b'), 'a\nb');
    assert.equal(stripHtml('&amp;&lt;&#65;&#x42;&nbsp;'), '&<AB');
    assert.equal(stripHtml('a\u200bb'), 'ab');
    assert.equal(stripHtml(null), '');
});

test('toFileUrl：Windows 反斜杠路径转 file:/// 并做 URI 编码', () => {
    const { toFileUrl } = A(loadCommon());
    assert.equal(toFileUrl('C:\\Users\\a b.png'), 'file:///C:/Users/a%20b.png');
    assert.equal(toFileUrl(''), '');
    assert.equal(toFileUrl(null), '');
});

// ---------------------------------------------------------------- 布局/动画辅助（最小桩，只断言纯逻辑）

test('fitVodTitle：未溢出时保持原文（宽容模式，CSS 已保证单行 ellipsis）', () => {
    const { fitVodTitle } = A(loadCommon());
    const el = makeTextEl('abc');
    fitVodTitle(el);
    assert.equal(el.textContent, 'abc');
});

test('fitVodTitle：溢出时二分求出最长可容前缀并追加省略号', () => {
    const { fitVodTitle } = A(loadCommon());
    const el = makeTextEl('A'.repeat(35)); // 每行 10 字、行高 20px、容器 40px
    fitVodTitle(el);
    assert.equal(el.textContent, 'A'.repeat(19) + '…');
});

test('fitVodTitles：对容器内 .vod-name 逐个执行截断；空容器不抛错', () => {
    const ctx = loadCommon();
    const { fitVodTitles } = A(ctx);
    const box = makeEl([], { offsetWidth: 100 });
    const n1 = makeTextEl('B'.repeat(35));
    const n2 = makeTextEl('C'.repeat(35));
    box._children = [n1, n2, makeEl(['other-el'])];
    fitVodTitles(box);
    assert.equal(n1.textContent, 'B'.repeat(19) + '…');
    assert.equal(n2.textContent, 'C'.repeat(19) + '…');
    assert.doesNotThrow(() => fitVodTitles(makeEl()));
});

test('playCardsEnter：错峰延迟按可见序号递增，第 8 张起封顶 315ms', () => {
    const { playCardsEnter } = A(loadCommon());
    const box = makeEl([], { offsetWidth: 100 });
    const cards = Array.from({ length: 10 }, () => makeEl(['vod-card']));
    box._children = cards;
    playCardsEnter(box);
    assert.deepEqual(cards.slice(0, 8).map((c) => c.style.animationDelay),
        ['0ms', '45ms', '90ms', '135ms', '180ms', '225ms', '270ms', '315ms']);
    assert.equal(cards[8].style.animationDelay, '315ms'); // 封顶
    assert.equal(cards[9].style.animationDelay, '315ms');
    assert.ok(box._classes.has('cards-enter'));
});

test('playCardsEnter：容器内无 .vod-card 时直接返回（不加类、不写延迟）', () => {
    const { playCardsEnter } = A(loadCommon());
    const box = makeEl([], { offsetWidth: 100 });
    box._children = [makeEl(['other'])];
    playCardsEnter(box);
    assert.ok(!box._classes.has('cards-enter'));
});

test('stageAppendedCards：只给新增卡补延迟，已有卡不重播；首挂补 cards-enter 类', () => {
    const { stageAppendedCards } = A(loadCommon());
    const box = makeEl([], { offsetWidth: 100 });
    const oldCards = Array.from({ length: 5 }, () => makeEl(['vod-card']));
    const newCards = Array.from({ length: 3 }, () => makeEl(['vod-card']));
    box._children = [...oldCards, ...newCards];
    stageAppendedCards(box, 5);
    assert.deepEqual(newCards.map((c) => c.style.animationDelay), ['0ms', '45ms', '90ms']);
    assert.ok(oldCards.every((c) => c.style.animationDelay === undefined));
    assert.ok(box._classes.has('cards-enter'));
});

test('stageAppendedCards：无新增卡时直接返回（不改类、不写延迟）', () => {
    const { stageAppendedCards } = A(loadCommon());
    const box = makeEl([], { offsetWidth: 100 });
    box._children = [makeEl(['vod-card'])];
    stageAppendedCards(box, 1);
    assert.ok(!box._classes.has('cards-enter'));
});

test('refitVodTitles：按 title 属性恢复完整标题后重新截断', () => {
    const ctx = loadCommon();
    const { refitVodTitles } = A(ctx);
    const full = 'X'.repeat(35);
    const truncated = makeTextEl('X'.repeat(19) + '…');
    truncated.attrs.title = full;
    const noTitle = makeTextEl('短标题');
    ctx.__registry.set('.vod-name', [truncated, noTitle]);
    refitVodTitles();
    assert.notEqual(truncated.textContent, full);   // 恢复后又被截断
    assert.ok(truncated.textContent.endsWith('…'));
    assert.equal(noTitle.textContent, '短标题');     // 无 title 属性时保持原文且不溢出
});

// ---------------------------------------------------------------- bangumiCard 拼装

test('bangumiCard：name_cn 优先于 name，无 rating 时不渲染评分/排名徽章', () => {
    const { bangumiCard } = A(loadCommon());
    const html = bangumiCard({
        id: '1', name: 'EN Name', name_cn: '中文名',
        images: { common: 'https://lain.bgm.tv/pic/cover/c/a.jpg' },
        air_date: '2026-01-01',
    });
    assert.match(html, /data-name="中文名"/);
    assert.match(html, /title="中文名"/);
    assert.doesNotMatch(html, /bangumi-rank-badge/);
    assert.doesNotMatch(html, /⭐/);
    assert.match(html, /vod-remarks">2026-01-01/);
});

test('bangumiCard：片名超 60 字时文本位截断、title 保留完整标题', () => {
    const { bangumiCard } = A(loadCommon());
    const long = 'Y'.repeat(80);
    const html = bangumiCard({ id: '2', name: long, images: {} });
    assert.match(html, new RegExp(`title="${long}"`));
    assert.match(html, new RegExp(`>${'Y'.repeat(60)}</div>`));
    assert.doesNotMatch(html, new RegExp(`>${'Y'.repeat(61)}`));
});

test('bangumiCard：my_rate 仅 1-10 渲染徽章（0/11/非数值不渲染，字符串数字可用）', () => {
    const { bangumiCard } = A(loadCommon());
    const badge = (myRate) => bangumiCard({ id: '3', name: '番', images: {}, my_rate: myRate });
    assert.match(badge(1), /我的 1★/);
    assert.match(badge(10), /我的 10★/);
    assert.match(badge('7'), /我的 7★/);
    assert.doesNotMatch(badge(0), /bangumi-myrate-badge/);
    assert.doesNotMatch(badge(11), /bangumi-myrate-badge/);
    assert.doesNotMatch(badge('abc'), /bangumi-myrate-badge/);
    assert.doesNotMatch(bangumiCard({ id: '3', name: '番', images: {} }), /bangumi-myrate-badge/);
});

test('bangumiCoverImg：有后端时首源走 /kazumi/cover 代理，链尾接镜像域兜底', () => {
    const ctx = loadCommon();
    const { bangumiCoverImg, setBackendInfo } = A(ctx);
    setBackendInfo({ base: 'http://127.0.0.1:9977', token: 'tk' });
    const html = bangumiCoverImg('https://lain.bgm.tv/pic/cover/l/aa/bb/1.jpg');
    assert.match(html, /src="http:\/\/127\.0\.0\.1:9977\/kazumi\/cover\?token=tk&amp;url=/);
    assert.match(html, /data-fb="https:\/\/lain\.bgm\.tv\/pic\/cover\/c\/aa\/bb\/1\.jpg\|\|https:\/\/lain\.bangumi\.vip\/pic\/cover\/c\/aa\/bb\/1\.jpg"/);
});

test('bangumiCoverImg：无后端（base 空）时退化为直连 + 镜像两级链', () => {
    const { bangumiCoverImg } = A(loadCommon());
    const html = bangumiCoverImg('https://lain.bgm.tv/pic/cover/l/aa/bb/1.jpg');
    assert.doesNotMatch(html, /kazumi\/cover/);
    assert.match(html, /src="https:\/\/lain\.bgm\.tv\/pic\/cover\/c\/aa\/bb\/1\.jpg"/);
    assert.match(html, /data-fb="https:\/\/lain\.bangumi\.vip\/pic\/cover\/c\/aa\/bb\/1\.jpg"/);
});

test('bangumiCoverImg：非 Bangumi 封面无镜像差异 → 单级链（无 data-fb）；空封面落占位图', () => {
    const { bangumiCoverImg, vodPlaceholder } = A(loadCommon());
    const other = bangumiCoverImg('https://s4.anilist.co/a.jpg');
    assert.match(other, /src="https:\/\/s4\.anilist\.co\/a\.jpg"/);
    assert.doesNotMatch(other, /data-fb=/);
    const empty = bangumiCoverImg('');
    assert.match(empty, new RegExp(vodPlaceholder()));
    assert.match(empty, /data-cover-missing="1"/);
});

// ---------------------------------------------------------------- bangumiCover（对象/裸 URL 双形态）

test('bangumiCover：images 对象按 size 取变体，旧缓存裸 URL 走 resize 降级', () => {
    const { bangumiCover } = A(loadCommon());
    const images = { large: 'https://lain.bgm.tv/pic/cover/l/a.jpg', common: 'https://lain.bgm.tv/pic/cover/c/a.jpg' };
    assert.equal(bangumiCover(images, 'detail'), images.large);
    assert.equal(bangumiCover(images, 'card'), images.common);
    assert.equal(bangumiCover(images.large, 'card'), images.common);
    assert.equal(bangumiCover(null, 'card'), '');
});
