'use strict';
/**
 * detail-bgm-snap.test.js — A-01（Bangumi 路径）快照半渲染联合回归。
 *
 * 背景：openBangumi 冷态要先 await bangumiInfo（1-3s 网络）才第一次 render，
 * 封面/标题全部白等；时间表/推荐/搜索/收藏/关联入口的列表卡上封面明明已经
 * 显示着。本批次把 CatVod 路径的 A-01 DetailSnap 半渲染手法接到 openBangumi：
 * 命中列表快照时立即出 hasBgm 版面 hero（封面=列表卡正在显示的 URL，浏览器
 * 缓存零网络秒出），bangumiInfo 返回后整页覆盖（结果优先）。
 *
 * 覆盖：
 *  ① 快照命中且 bgmInfo 缓存未命中：render 立即被调、带快照 bgm、实例态语义正确
 *     （_bgmId 真实值 / _bgmInfo=快照形状 / sources 空），hero HTML 封面+标题上屏，
 *     页签区垫 desc 骨架，无转圈遮罩（endLoading=null 路径）
 *  ② bgmInfo 缓存命中（peekCachedBangumiInfo=true）：跳过半渲染（马上出完整版面）
 *  ③ 无快照：openBangumi 不半渲染（走 hero 骨架，行为与旧版一致）
 *  ④ bangumiInfo 到达后整页覆盖：结果片名/封面替换快照垫场，_snapHeroBgm 收口
 *  ⑤ 半渲染口径：封面走缺省 card 口径（bangumiCoverImg 不带 size）、页签渲染与
 *     _loadBgmExtra 延后、large 大图后台预热（new Image）
 *  ⑥ 快照写入点源码锚点：bangumi-search/records/search/relations 四处新增写入 +
 *     timeline/popular 既有写入仍在
 *  ⑦ kazumi.js peekCachedBangumiInfo：与 bangumiInfo 同键同净化（源码锚点 + 行为）
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DETAIL_SRC = read('src/renderer/js/detail.js');

/** 内存 localStorage 桩（真实遍历语义，对齐 detail-snap.test.js）。 */
function makeLs() {
    const store = new Map();
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        key: (i) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
        __store: store,
    };
}

/** 链式 jQuery 桩（对齐 detail-skeleton-wiring.test.js 精简版）。 */
function makeJq(captor) {
    const makeNode = (sel) => ({
        sel: String(sel),
        length: 1,
        on(ev, a, b) {
            const fn = typeof b === 'function' ? b : a;
            if (captor && typeof fn === 'function') captor.bound.push({ sel: String(sel), ev, fn });
            return this;
        },
        off() { return this; },
        html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), String(s)); return this; },
        text() { return this; },
        addClass() { return this; },
        removeClass() { return this; },
        attr() { return this; },
        prop() { return this; },
        find() { return makeNode(String(sel) + ' *'); },
        children() { return Object.assign(makeNode(String(sel) + ' > *'), { length: 0 }); },
        first() { return this; },
        each() { return this; },
        not() { return this; },
        is() { return false; },
        toggle() { return this; },
        hide() { return this; },
        show() { return this; },
        remove() { return this; },
        replaceWith() { return this; },
        closest() { return makeNode(String(sel) + ' ^'); },
        css() { return this; },
        data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
    });
    return (sel) => {
        if (sel && typeof sel === 'object') return makeNode('obj');
        return makeNode(sel);
    };
}

/** 组合沙箱：cache.js + detail-snap.js + common.js skeletonHtml（真实现）+ detail.js。 */
function loadAll({ renderSpy = false } = {}) {
    const ls = makeLs();
    const captor = { bound: [], htmlBySel: new Map(), renderCalls: [], warmSrc: [] };
    const toasts = [];
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        parseInt, parseFloat, isNaN, isFinite, setTimeout, clearTimeout, URL, Error, RegExp,
        Image: class { set src(v) { captor.warmSrc.push(String(v)); } get src() { return ''; } set referrerPolicy(v) {} },
        document: {
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains: () => false } },
            getElementById: () => null,
            addEventListener() {},
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        localStorage: ls,
        $: makeJq(captor),
        registerEsc: () => {},
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        stripHtml: (s) => String(s || ''),
        warnToast: (m) => toasts.push(String(m)),
        fmtCommentTimeFull: () => '2026-01-01 00:00',
        commentTsMs: () => 0,
        showLoading: () => {},
        hideLoading: () => {},
        bangumiCover: (images, size) => (images && images.large) || '',
        vodCoverImg: (pic) => `<img src="${pic || 'assets/cover-fallback.svg'}">`,
        bangumiCoverImg: (pic, eager, size) => `<img class="bgm-cover" data-size="${size || 'card'}" src="${pic}">`,
        normalizePic: (p) => String(p || '').trim(),
        abortCoverFill: () => {},
        errorTextOf: (e) => String(e || ''),
        App: { currentView: 'home', showView() {} },
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) }, localStorage: ls },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/js/cache.js'), context, { filename: 'cache.js' });
    vm.runInContext(read('src/renderer/js/detail-snap.js'), context, { filename: 'detail-snap.js' });
    vm.runInContext(`localCacheGet = window.localCacheGet;
        localCacheSet = window.localCacheSet;
        localCacheDel = window.localCacheDel;
        localCachePeek = window.localCachePeek;
        DetailSnap = window.DetailSnap;`,
    context, { filename: 'wire-globals.js' });
    const m = read('src/renderer/js/common.js').match(/function skeletonHtml\(kind, opts\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'common.js 应含 skeletonHtml 函数');
    vm.runInContext(m[0], context, { filename: 'skeletonHtml.js' });
    vm.runInContext(`${DETAIL_SRC}\n;globalThis.__Detail = Detail;`, context, { filename: 'detail.js' });
    const D = context.__Detail;
    if (renderSpy) {
        const realRender = D.render.bind(D);
        D.render = (opts) => {
            captor.renderCalls.push({
                opts: opts || null,
                bgmName: D._bgmInfo ? D._bgmInfo.name_cn || D._bgmInfo.name : null,
                bgmId: D._bgmId,
                loadGen: D._loadGen,
            });
            realRender(opts);
        };
    }
    context.__ls = ls;
    context.__cap = captor;
    context.__toasts = toasts;
    return { Detail: D, captor, ls, toasts, context };
}

/** openBangumi 夹具：Kazumi 桩（bangumiInfo 可控延迟）+ 可选快照预置。 */
function loadBgm({ renderSpy = false, withSnap = true, bgmInfoCache = false } = {}) {
    const env = loadAll({ renderSpy });
    const { Detail, captor, context: ctx } = env;
    ctx.Kazumi = {
        bangumiInfo: async () => ({ id: 777, name: ' Ergebnis', name_cn: '结果番名', images: { large: 'http://o/l.jpg' } }),
        bangumiEpisodes: async () => null,
        _applyBangumiColState: async () => {},
        peekCachedBangumiInfo: () => bgmInfoCache,
    };
    if (withSnap) {
        vm.runInContext(`DetailSnap.put('', '777', { pic: 'http://card/snap.jpg', name: '快照番名', remarks: '2026-04' })`,
            ctx, { filename: 'put-snap.js' });
    }
    return { D: Detail, captor, env };
}

const flush = () => new Promise((r) => setImmediate(r));

/**
 * 给已加载 detail.js 的沙箱注入 fake timer（A-34 宽限期测试用）。
 *
 * 必要性：detail.js 在 node:vm 沙箱里执行，而 node:vm context 在**创建时**就捕获
 * 了宿主 setTimeout 引用；`t.mock.timers` 之后再去替换全局，沙箱内跑的仍是那份
 * 未 mock 的旧引用（已实测确认），于是宽限期永远推不动、测试只能真等 200ms。
 * 故 detail.js 把定时器调用收口到 `_detailSetTimeout/_detailClearTimeout` 两个可
 * 重赋值绑定，测试在这里替换它们，并用 `__tickTimers(ms)` 按虚拟时间放行到期回调。
 *
 * @returns {Function} 恢复函数（把沙箱的定时器绑回宿主实现）
 */
function installFakeTimers(ctxS) {
    const timers = new Map();
    let seq = 0;
    let vnow = 0;
    vm.runInContext(`
        globalThis.__realST = setTimeout;
        globalThis.__realCT = clearTimeout;
        _detailSetTimeout = (fn, ms) => { return globalThis.__fakeSet(fn, ms); };
        _detailClearTimeout = (h) => { globalThis.__fakeClear(h); };
        globalThis.__tickTimers = (ms) => { globalThis.__fakeTick(ms); };
    `, ctxS);
    ctxS.__fakeSet = (fn, ms) => {
        const id = ++seq;
        timers.set(id, { fn, at: vnow + (Number(ms) || 0) });
        return id;
    };
    ctxS.__fakeClear = (h) => { timers.delete(h); };
    ctxS.__fakeTick = (ms) => {
        vnow += Number(ms) || 0;
        for (const [id, t] of Array.from(timers.entries())) {
            if (t.at <= vnow) { timers.delete(id); t.fn(); }
        }
    };
    return () => {
        vm.runInContext(`
            _detailSetTimeout = (fn, ms) => globalThis.__realST(fn, ms);
            _detailClearTimeout = (h) => globalThis.__realCT(h);
        `, ctxS);
    };
}

// ================================================================ ① 快照命中立即出 hero

describe('① 快照命中且 bgmInfo 缓存未命中：openBangumi 立即出 hero', () => {
    test('render 立即被调、带快照 bgm、hero 封面/标题上屏、页签垫 desc 骨架', async () => {
        const { D, captor, env } = loadBgm({ renderSpy: true });
        const shown = [];
        env.context.App = { currentView: 'home', showView: (v) => shown.push(v) };
        // bangumiInfo 挂起不放行：#detail-body 停留在快照半渲染态
        let release;
        env.context.Kazumi.bangumiInfo = () => new Promise((res) => { release = res; });
        D.openBangumi('777', '');
        await flush();
        assert.equal(captor.renderCalls.length, 1, 'openBangumi 内快照路径立即 render 一次');
        const call = captor.renderCalls[0];
        assert.ok(call.opts && call.opts.snapHeroBgm === true, 'render 收到 snapHeroBgm 标记');
        assert.equal(call.bgmId, '777', '半渲染期 _bgmId 已是真实值（操作行/评分入口可用）');
        assert.equal(call.bgmName, '快照番名', '半渲染 hero 用快照片名');
        assert.ok(shown.includes('detail'), '视图已切换');
        const heroHtml = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(heroHtml.includes('快照番名'), 'hero 标题为快照片名');
        assert.ok(heroHtml.includes('http://card/snap.jpg'), 'hero 封面为快照 pic（列表卡正在显示的 URL）');
        assert.ok(!heroHtml.includes('data-size='), '半渲染封面走 vodCoverImg 直连（非代理链 large 口径，浏览器缓存必然命中）');
        assert.ok(heroHtml.includes('detail-hero-bangumi'), 'hasBgm 版面（Bangumi hero class）');
        assert.ok(heroHtml.includes('sk-root sk-desc'), '页签内容区垫简介形态骨架');
        release({ id: 777, name: 'Ergebnis', name_cn: '结果番名', images: { large: 'http://o/l.jpg' } });
        await flush();
        assert.equal(D._bgmInfo && D._bgmInfo.name_cn, '结果番名', '结果到达后覆盖快照');
    });

    test('半渲染期不上转圈遮罩 + large 大图后台预热 + _loadBgmExtra 延后', async () => {
        const { D, captor, env } = loadBgm();
        let extraCalls = 0;
        D._loadBgmExtra = function () { extraCalls++; };
        let release;
        env.context.Kazumi.bangumiInfo = () => new Promise((res) => { release = res; });
        D.openBangumi('777', '');
        await flush();
        assert.equal(extraCalls, 0, '半渲染期 _loadBgmExtra 延后（防 1-3s 后完整 render 重复发四路）');
        // 预热 URL：快照封面是 lain 外域名桩值（不满足 lain 域名推导分支）→ raw =
        // images.large = 快照 pic 本身；真实场景 lain 域名会推导 large 变体走代理链
        assert.deepEqual(captor.warmSrc, ['http://card/snap.jpg'], 'large 大图后台预热（new Image）');
        release({ id: 777, name: 'x', name_cn: '结果番名', images: { large: 'http://o/l.jpg' } });
        await flush();
        assert.equal(extraCalls, 1, '完整 render 后 _loadBgmExtra 恰好一次');
    });

    test('快照 remarks/year 不进半渲染 hero（bgm 版面 meta 行来自 bangumiInfo）', async () => {
        const { D, captor, env } = loadBgm();
        let release;
        env.context.Kazumi.bangumiInfo = () => new Promise((res) => { release = res; });
        D.openBangumi('777', '');
        await flush();
        const heroHtml = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(!heroHtml.includes('2026-04'), 'remarks 不误入 bgm meta 行');
        release({ id: 777, name: 'x', name_cn: 'n', images: {} });
        await flush();
    });
});

// ================================================================ ② 缓存命中跳过半渲染

describe('② bgmInfo 缓存命中（peek=true）：跳过半渲染', () => {
    test('不读快照不半渲染：render 只在 bangumiInfo 返回后被调一次（完整版面）', async () => {
        const { D, captor } = loadBgm({ renderSpy: true, bgmInfoCache: true });
        await D.openBangumi('777', '');
        await flush();
        assert.equal(captor.renderCalls.length, 1, '缓存命中路径只 render 一次');
        assert.ok(!captor.renderCalls[0].opts, '完整 render（无 snapHeroBgm 标记）');
        assert.equal(captor.renderCalls[0].bgmName, '结果番名', 'hero 为 bangumiInfo 结果');
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(!html.includes('快照番名'), '快照垫场不出现');
    });
});

// ================================================================ ③ 无快照走骨架（行为同旧版）

describe('③ 无快照：openBangumi 不半渲染', () => {
    test('render 不被提前调用，#detail-body 停在 hero 骨架直到结果到达', async () => {
        const { D, captor, env } = loadBgm({ renderSpy: true, withSnap: false });
        let release;
        env.context.Kazumi.bangumiInfo = () => new Promise((res) => { release = res; });
        // A-34：骨架在宽限期后才上屏，需推动虚拟时间越过 DETAIL_LOADING_DELAY_MS
        const restore = installFakeTimers(env.context);
        const p = D.openBangumi('777', '');
        await flush();
        assert.equal(captor.renderCalls.length, 0, '无快照时 openBangumi 不半渲染');
        // 宽限期内（<200ms）：尚未写任何占位——快请求本就不该出现中间态
        let html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(!html.includes('sk-hero-cover'), '宽限期内不写 hero 骨架（A-34）');
        env.context.__tickTimers(250); // 越过 200ms 宽限期
        await flush();
        html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('class="sk-root sk-hero"'), '慢请求超宽限期后 hero 骨架上屏');
        release({ id: 777, name: 'x', name_cn: '结果番名', images: {} });
        await p;
        await flush();
        restore();
        assert.equal(captor.renderCalls.length, 1, '结果到达后完整 render');
        html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('结果番名'), 'hero 为结果片名');
    });

    // A-34 首屏宽限期（Bangumi 路径）：bangumiInfo 命中 30min 缓存时毫秒级返回，
    // 快路径不该闪一屏骨架——第一次绘制就是完整 hero。
    test('A-34：bangumiInfo 快速返回时不写 hero 骨架，首屏即完整版面', async () => {
        const { D, captor, env } = loadBgm({ renderSpy: true, withSnap: false });
        env.context.Kazumi.bangumiInfo = async () => ({ id: 777, name: 'x', name_cn: '快返番名', images: {} });
        const restore = installFakeTimers(env.context);
        await D.openBangumi('777', '');
        await flush();
        const skeletonWrites = [];
        for (const [, v] of captor.htmlBySel) {
            if (/sk-root sk-hero/.test(String(v))) skeletonWrites.push(v);
        }
        assert.equal(skeletonWrites.length, 0, '快请求（<200ms）不该写 hero 骨架');
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('快返番名'), '首屏即为真实内容（一次成型）');
        restore();
    });
});

// ================================================================ ④ 结果优先覆盖

describe('④ bangumiInfo 到达后整页覆盖（结果优先）', () => {
    test('结果片名/封面替换快照垫场，页签内容由完整 render 重建', async () => {
        const { D, captor, env } = loadBgm();
        env.context.Kazumi.bangumiInfo = async () => ({ id: 777, name: 'orig', name_cn: '结果番名', images: { large: 'http://o/new.jpg' } });
        await D.openBangumi('777', '');
        await flush();
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('结果番名'), 'hero 覆盖为结果片名');
        assert.ok(html.includes('http://o/new.jpg'), 'hero 覆盖为结果封面（代理链 large）');
        assert.ok(!html.includes('快照番名') && !html.includes('http://card/snap.jpg'), '快照垫场字段不残留');
        assert.ok(html.includes('data-size="large"'), '完整 render 封面恢复 large 大图口径');
        assert.ok(!html.includes('sk-root sk-desc'), '页签骨架被真实概览内容替换');
    });
});

// ================================================================ ④a 原位覆盖不重播入场动画

describe('④a 完整覆盖不重播入场动画（防 hero 二次闪现）', () => {
    test('快照半渲染后 bangumiInfo 到达：render 收到 skipPageAnim（入场动画不重播）', async () => {
        const { D, captor } = loadBgm({ renderSpy: true });
        await D.openBangumi('777', '');
        await flush();
        const calls = captor.renderCalls;
        assert.ok(calls.length >= 2, '半渲染 + 完整覆盖共两次 render');
        assert.ok(calls[0].opts && calls[0].opts.snapHeroBgm === true, '第一次：快照半渲染');
        assert.ok(calls[calls.length - 1].opts && calls[calls.length - 1].opts.skipPageAnim === true,
            '完整覆盖带 skipPageAnim：不重挂 .detail-page-anim（重播入场 = hero 从 opacity:0 二次淡入闪现）');
    });

    test('无快照路径维持完整入场（render 无 opts，骨架→内容播动画）', async () => {
        const { D, captor } = loadBgm({ renderSpy: true, withSnap: false });
        await D.openBangumi('777', '');
        await flush();
        const calls = captor.renderCalls;
        assert.equal(calls.length, 1, '无快照只 render 一次');
        assert.equal(calls[0].opts, null, '无快照不传 opts：完整入场动画照播');
    });
});

// ================================================================ ⑥ 快照写入点源码锚点

describe('⑥ Bangumi 快照写入点源码锚点', () => {
    const srcOf = (f) => read('src/renderer/js/' + f);

    test('bangumi-search.js：结果卡点击写入快照（site 空串）', () => {
        // 2026-10-02：裸调用改走 _snapPutBgmSearch（DetailSnap/Home 缺席静默跳过，
        // 不得阻断 openBangumiInfoPage）。锚点随之改为验证「写入仍存在且已守卫」。
        assert.match(srcOf('bangumi-search.js'), /_snapPutBgmSearch\('',\s*id,\s*el\)/);
        assert.match(srcOf('bangumi-search.js'), /function _snapPutBgmSearch\(site, id, \$el\)/);
    });

    test('records.js：Bangumi 收藏卡 + Kazumi 历史卡两路写入快照', () => {
        const src = srcOf('records.js');
        assert.match(src, /_snapPut\('',\s*id,\s*el\)/, '收藏卡路径');
        assert.match(src, /_snapPut\('',\s*String\(id\),\s*el\)/, '历史卡匹配路径');
    });

    test('search.js：Kazumi 结果缓存匹配 + 现场搜索匹配两路写入快照', () => {
        const src = srcOf('search.js');
        assert.match(src, /_snapPutSearch\('',\s*String\(cachedMatch\.id\),\s*el\)/);
        assert.match(src, /_snapPutSearch\('',\s*String\(r0\.id\),\s*el\)/);
    });

    test('detail.js：关联卡嵌套跳转写入快照', () => {
        assert.match(DETAIL_SRC, /DetailSnap\.put\('',\s*id,\s*\{\s*pic: src/, '关联卡海报随快照垫场');
    });

    test('timeline.js / popular.js 既有写入仍在（不回退）', () => {
        assert.match(srcOf('timeline.js'), /DetailSnap\.put\('',\s*id,\s*Home\._snapFieldsFromCard/);
        assert.match(srcOf('popular.js'), /DetailSnap\.put\('',\s*id,\s*Home\._snapFieldsFromCard/);
    });

    test('detail.js：openBangumi 消费 DetailSnap.get + 半渲染标记 + 大图预热', () => {
        assert.match(DETAIL_SRC, /_detailSnapBgm\(DetailSnap\.get\('',\s*String\(subjectId\)\),\s*subjectId\)/);
        assert.match(DETAIL_SRC, /opts\.snapHeroBgm/);
        assert.match(DETAIL_SRC, /snapHeroBgm && bgm && bgm\.images/, 'large 预热门控');
    });

    test('kazumi.js：peekCachedBangumiInfo 与 bangumiInfo 同键（源码锚点）', () => {
        const src = srcOf('kazumi.js');
        assert.match(src, /peekCachedBangumiInfo\(subjectId\) \{/, '方法存在');
        assert.match(src, /this\._bgmInfoCacheKey\(key\)/, '同键口径');
    });
});

// ================================================================ ⑤ 快照封面沿用（防显示→占位→恢复闪变）

describe('⑤ 完整 render 沿用快照封面 URL（防闪变）', () => {
    test('结果封面与快照封面同 URL：完整 render 仍走 vodCoverImg 直连（不换代理链）', async () => {
        const { D, captor, env } = loadBgm();
        // 结果封面与快照 pic 同 URL（时间表/推荐卡直连 origin 的常态）
        env.context.Kazumi.bangumiInfo = async () => ({
            id: 777, name: 'x', name_cn: '结果番名',
            images: { large: 'http://card/snap.jpg' },
        });
        await D.openBangumi('777', '');
        await flush();
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('结果番名'), '完整版面上屏');
        assert.ok(html.includes('http://card/snap.jpg'), '封面 URL 与快照一致（图未变）');
        assert.ok(!html.includes('data-size='), '同 URL 沿用直连：不再切代理链（换 URL 会重走代理 → 占位闪变）');
    });

    test('结果封面与快照不同 URL：恢复代理链 large 口径（不沿用）', async () => {
        const { D, captor, env } = loadBgm();
        env.context.Kazumi.bangumiInfo = async () => ({
            id: 777, name: 'x', name_cn: '结果番名',
            images: { large: 'http://other/diff.jpg' },
        });
        await D.openBangumi('777', '');
        await flush();
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('data-size="large"'), '不同 URL 走完整版面代理链（B-08 磁盘缓存兜底）');
    });

    test('基准防跨片残留：跨类型残留基准被 open()/openBangumi 入口重置', async () => {
        const { D, captor, env } = loadBgm();
        env.context.Kazumi.bangumiInfo = async (id) => ({
            id: Number(id), name: 'x', name_cn: `番剧${id}`,
            images: { large: 'http://card/snap.jpg' },
        });
        await D.openBangumi('777', '');
        await flush();
        // 模拟 CatVod 详情打开（open() 入口重置基准）后又回 Bangumi 详情：基准只在
        // 本片快照半渲染时重记，其他影片的 URL 不会串入沿用判定
        D.open('site-a', 'v2', '');
        assert.equal(D._snapCoverShown, '', 'open() 入口重置基准');
        vm.runInContext(`DetailSnap.put('', '888', { pic: 'http://card/snap.jpg', name: '另一部' })`, env.context);
        await D.openBangumi('888', '');
        await flush();
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('番剧888'), '第二部完整版面上屏');
        assert.ok(!html.includes('data-size='), '第二部快照同 URL（新基准随本片快照重记）仍沿用直连');
    });
});

// ================================================================ ⑤b A-30：同图不同尺寸变体也沿用

describe('⑤b A-30：快照封面与结果封面「同一张图不同尺寸」也沿用（Bangumi 主路径）', () => {
    // 背景：列表卡用 card/common 变体（/r/400/…），详情 hero 用 large 变体（无 r 前缀），
    // 两者逐字必然不同。旧 keepSnapCover 只做全等比较 → 沿用机制在 Bangumi 路径从未
    // 生效，每次完整 render 换代理链 URL → 新 img opacity:0 重载 → 占位→显示→闪一下。
    const SNAP_CARD = 'https://lain.bgm.tv/r/400/pic/cover/l/01/88/899_REwVW.jpg';   // 列表卡显示
    const FULL_LARGE = 'https://lain.bgm.tv/pic/cover/l/01/88/899_REwVW.jpg';        // 详情 large

    test('同图不同尺寸（card 400 vs large）→ 沿用快照 URL 直连，不切代理链', async () => {
        const { D, captor, env } = loadBgm();
        env.context.Kazumi.bangumiInfo = async () => ({
            id: 777, name: 'x', name_cn: '结果番名', images: { large: FULL_LARGE },
        });
        vm.runInContext(`DetailSnap.put('', '777', { pic: '${SNAP_CARD}', name: '快照番名' })`, env.context);
        await D.openBangumi('777', '');
        await flush();
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('结果番名'), '完整版面上屏');
        // 关键：渲染的是快照 URL（浏览器已缓存那张），不是 large 变体
        assert.ok(html.includes(SNAP_CARD), '沿用快照 URL 直连（零网络、零重载）');
        assert.ok(!html.includes('data-size='), '同图沿用：不再切代理链（换 URL 会重走代理 → 占位闪变）');
    });

    test('沿用分支补 data-big=large 变体：点击放大仍拿大图（不因沿用降到 400px）', async () => {
        const { D, captor, env } = loadBgm();
        env.context.Kazumi.bangumiInfo = async () => ({
            id: 777, name: 'x', name_cn: '结果番名', images: { large: FULL_LARGE },
        });
        vm.runInContext(`DetailSnap.put('', '777', { pic: '${SNAP_CARD}', name: '快照番名' })`, env.context);
        await D.openBangumi('777', '');
        await flush();
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes(`data-big="${FULL_LARGE}"`), '沿用分支带 data-big 指向 large 变体');
    });

    // A-36 收藏/历史入口（recCard 走 bangumiCoverImg 本地代理）：此前 hero 必然换
    // URL 重走代理链表现，为「打开详情页封面刷新一下」。现在应与推荐入口同一口径。
    test('A-36：收藏入口代理封面 → 沿用快照 URL，不走代理链（渲染层实测）', async () => {
        const { D, captor, env } = loadBgm();
        env.context.Kazumi.bangumiInfo = async () => ({
            id: 777, name: 'x', name_cn: '结果番名', images: { large: FULL_LARGE },
        });
        const proxyPic = 'http://127.0.0.1:57549/kazumi/cover?token=T123&url='
            + encodeURIComponent(SNAP_CARD);
        vm.runInContext(`DetailSnap.put('', '777', { pic: ${JSON.stringify(proxyPic)}, name: '快照番名' })`, env.context);
        await D.openBangumi('777', '');
        await flush();
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        // 沿用 = 渲染的是快照 URL 本身（浏览器缓存已命中，零网络零重绘）。
        // URL 里的 & 在属性中会经 escHtml 转成 &amp;，故两者都认。
        const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        assert.ok(html.includes(proxyPic) || html.includes(escAttr(proxyPic)),
            'hero 沿用快照代理 URL（而非换新 URL 重载）');
        // 对照：不同图时才会走 bangumiCoverImg 代理链（data-size="large" 是该分支特征）
        assert.ok(!html.includes('data-size="large"'), '同图时不重走代理链 large 口径');
    });

    test('确为不同图（路径不同）→ 不沿用，恢复代理链 large 口径', async () => {
        const { D, captor, env } = loadBgm();
        env.context.Kazumi.bangumiInfo = async () => ({
            id: 777, name: 'x', name_cn: '结果番名',
            images: { large: 'https://lain.bgm.tv/pic/cover/l/01/88/900_OTHER.jpg' },
        });
        vm.runInContext(`DetailSnap.put('', '777', { pic: '${SNAP_CARD}', name: '快照番名' })`, env.context);
        await D.openBangumi('777', '');
        await flush();
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('data-size="large"'), '不同图走完整版面代理链');
        assert.ok(!html.includes(SNAP_CARD), '不沿用无关快照 URL');
    });

    test('_detailSameCoverPicture：尺寸变体归一判定（含镜像域/非 lain 边界）', () => {
        const m = DETAIL_SRC.match(/function _detailSameCoverPicture\(a, b\) \{[\s\S]*?\n\}/);
        assert.ok(m, '判定函数存在');
        const ctx = { String, RegExp, console };
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        vm.runInContext(m[0], ctx);
        const same = ctx._detailSameCoverPicture;
        assert.equal(same(SNAP_CARD, FULL_LARGE), true, 'card(400) vs large = 同图（本次修复核心）');
        assert.equal(same('https://lain.bgm.tv/r/400/pic/cover/l/a.jpg',
            'https://lain.bgm.tv/r/800/pic/cover/l/a.jpg'), true, '400 vs 800 同图');
        assert.equal(same('https://lain.bgm.tv/pic/cover/l/a.jpg',
            'https://lain.bgm.tv/pic/cover/c/a.jpg'), true, '段字母 l vs c 同图');
        assert.equal(same('https://lain.bgm.tv/pic/cover/l/a.jpg',
            'https://lain.bangumi.vip/pic/cover/l/a.jpg'), true, '官方域 vs 镜像域同图');
        assert.equal(same('https://lain.bgm.tv/pic/cover/l/a.jpg',
            'https://lain.bgm.tv/pic/cover/l/b.jpg'), false, '路径不同 = 不同图');
        assert.equal(same('https://ex.com/a.jpg', 'https://ex.com/b.jpg'), false, '非 lain 不同 URL 不等');
        assert.equal(same('', 'https://lain.bgm.tv/pic/cover/l/a.jpg'), false, '空值不等');

        // A-36：收藏/历史卡（recCard）对 Bangumi 图走 bangumiCoverImg 本地代理，
        // 快照里存的是代理串；完整 render 的结果封面是 lain 直连 large。修代理解包
        // 之前，二者主机名分别为 127.0.0.1 与 lain.bgm.tv，被 lainRe 闸门判否 →
        // keepSnapCover 从未生效 → hero 每次换 URL 重载 = 「封面刷新一下」。
        const PROXY = 'http://127.0.0.1:57549/kazumi/cover?token=T123&url=';
        const enc = encodeURIComponent;
        assert.equal(same(PROXY + enc('https://lain.bgm.tv/pic/cover/c/ab/cd/s1.jpg'),
            'https://lain.bgm.tv/pic/cover/l/ab/cd/s1.jpg'), true,
        '代理(common) ↔ 结果 lain large = 同图（收藏入口封面不刷新）');
        assert.equal(same(PROXY + enc('https://lain.bgm.tv/r/400/pic/cover/l/a.jpg'),
            'https://lain.bgm.tv/pic/cover/l/a.jpg'), true, '代理内含 r 宽度前缀也判同图');
        assert.equal(same(PROXY + enc('https://lain.bgm.tv/pic/cover/c/a.jpg'),
            PROXY + enc('https://lain.bgm.tv/pic/cover/l/a.jpg')), true,
        '代理 ↔ 代理（不同尺寸变体）也判同图');
        assert.equal(same(PROXY + enc('https://lain.bgm.tv/pic/cover/c/aa/a1.jpg'),
            'https://lain.bgm.tv/pic/cover/l/bb/b2.jpg'), false,
        '代理包装下路径不同仍判不同图（不得放宽到出错图）');
        assert.equal(same(PROXY + enc('https://lain.bgm.tv/pic/cover/c/a.jpg'),
            'https://img.example.com/a.jpg'), false, '代理 ↔ 非 lain 第三方图床不等');
        // 畸形转义不得抛错（ 回退为原串 → 判不等，比炸掉整页 render 安全）
        assert.equal(same(PROXY + 'url=%E0%A4%A', 'https://lain.bgm.tv/pic/cover/l/a.jpg'), false,
            '畸形百分号转义静默判不等');
    });
});

// ================================================================ ⑥ 选集讨论预取提速

describe('⑥ 选集讨论提速：分集预取接续预取第 1 集评论', () => {
    function loadBgmWithEps({ cmtDelay = 0 } = {}) {
        const env = loadAll({ renderSpy: false });
        const { Detail: D, captor, context: ctx } = env;
        const eps = [
            { id: 9001, type: 0, sort: 1, ep: 1, name: '第一集' },
            { id: 9002, type: 0, sort: 2, ep: 2, name: '第二集' },
        ];
        let epsReleased;
        const epsPromise = new Promise((res) => { epsReleased = res; });
        ctx.Kazumi = {
            bangumiInfo: async () => ({ id: 777, name: 'x', name_cn: '结果番名', images: {} }),
            bangumiEpisodes: () => epsPromise,
            bangumiEpisodeComments: async (eid) => {
                if (cmtDelay) await new Promise((r) => setTimeout(r, cmtDelay));
                return [{ user: { nickname: 'u' }, content: `评论${eid}` }];
            },
            _applyBangumiColState: async () => {},
            peekCachedBangumiInfo: () => false,
        };
        vm.runInContext(`DetailSnap.put('', '777', { pic: 'http://card/snap.jpg', name: '快照番名' })`, ctx);
        return { D, captor, ctx, eps, releaseEps: epsReleased };
    }

    test('主信息 render 后分集到达 → 自动预取第 1 集评论写 _epCommentsPreload', async () => {
        const { D, releaseEps, eps } = loadBgmWithEps();
        await D.openBangumi('777', '');
        await flush();
        assert.equal(D._epCommentsPreload, null, '分集未到达前无预取');
        releaseEps({ data: eps });
        await flush();
        assert.ok(D._epCommentsPreload, '预取已写入');
        assert.equal(D._epCommentsPreload.eid, 9001, '预取第 1 集（正片优先）');
        assert.equal(D._epCommentsPreload.list[0].content, '评论9001', '预取内容为该集评论');
        assert.equal(D._epCommentsPreload.sid, '777', '预取带番剧归属');
    });

    test('页签打开默认集直接消费预取：不再发评论请求、不见加载态', async () => {
        const { D, captor, ctx, releaseEps, eps } = loadBgmWithEps();
        await D.openBangumi('777', '');
        await flush();
        releaseEps({ data: eps });
        await flush();
        const before = ctx.Kazumi.bangumiEpisodeComments; // 请求计数探针
        let cmtCalls = 0;
        ctx.Kazumi.bangumiEpisodeComments = async (eid) => { cmtCalls++; return before(eid); };
        D._activeTab = '选集讨论';
        await D._renderEpComments();
        await flush();
        assert.equal(cmtCalls, 0, '预取命中：零评论请求');
        const html = String(captor.htmlBySel.get('#ep-comments-list') || '');
        assert.ok(html.includes('评论9001'), '预取评论直接上屏');
        assert.ok(html.includes('共 1 条讨论'), '评论列表结构完整');
    });

    test('切到第 2 集：预取不命中，正常请求路径兜底', async () => {
        const { D, ctx, releaseEps, eps } = loadBgmWithEps();
        await D.openBangumi('777', '');
        await flush();
        releaseEps({ data: eps });
        await flush();
        let cmtCalls = 0;
        const orig = ctx.Kazumi.bangumiEpisodeComments;
        ctx.Kazumi.bangumiEpisodeComments = async (eid) => { cmtCalls++; return orig(eid); };
        D._epCommentsEpisodeId = 9002;
        await D._loadEpComments({ id: 9002 });
        await flush();
        assert.equal(cmtCalls, 1, '非默认集走正常请求');
        assert.equal(D._epComments[0].content, '评论9002', '请求结果正确并入状态');
    });

    test('换番剧作废预取：_resetEpComments 清 _epCommentsPreload，sid 不匹配不消费', async () => {
        const { D, ctx, releaseEps, eps } = loadBgmWithEps();
        await D.openBangumi('777', '');
        await flush();
        releaseEps({ data: eps });
        await flush();
        assert.ok(D._epCommentsPreload, '第一部预取在手');
        D._bgmId = '999';
        D._resetEpComments();
        assert.equal(D._epCommentsPreload, null, '换番剧预取作废');
        // 即使残留（模拟极端时序），sid 校验也不消费
        D._epCommentsPreload = { sid: '777', eid: 9001, list: [{ content: 'stale' }] };
        let cmtCalls = 0;
        const orig = ctx.Kazumi.bangumiEpisodeComments;
        ctx.Kazumi.bangumiEpisodeComments = async (eid) => { cmtCalls++; return orig(eid); };
        await D._loadEpComments({ id: 9001 });
        await flush();
        assert.equal(cmtCalls, 1, 'sid 不匹配：预取不消费，走请求');
        assert.equal(D._epComments[0].content, '评论9001', '状态为新番剧请求结果');
    });
});


describe('⑦ peekCachedBangumiInfo 行为（kazumi.js 局部加载）', () => {
    /** 从 kazumi.js 抽取 peekCachedBangumiInfo 方法源码，在桩上下文中重建为独立函数。 */
    function buildPeek(localCacheGetImpl) {
        const src = read('src/renderer/js/kazumi.js');
        const m = src.match(/peekCachedBangumiInfo\(subjectId\) \{[\s\S]*?\n    \},/);
        assert.ok(m, 'kazumi.js 应含 peekCachedBangumiInfo');
        // 方法源码 → function 声明：掐掉「    },」结尾（非贪婪断言会捕到方法内最后一行
        // 之后，这里统一截到最后一个 } 后丢弃余部），容忍 CRLF。
        let body = m[0].replace(/\r/g, '');
        const lastBrace = body.lastIndexOf('}');
        body = body.slice(0, lastBrace + 1);
        body = body.replace(/^peekCachedBangumiInfo/, 'function peekCachedBangumiInfo');
        const ctx = { console, String, Number };
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        vm.runInContext(`const localCacheGet = ${localCacheGetImpl};`, ctx);
        vm.runInContext(`
            const _bgmInfoCacheKey = (k) => 'detail::bgminfo::v1::' + String(k);
            const _sanitizeBangumiInfo = (info) => (info && typeof info === 'object' && Number(info.id) ? info : null);
            ${body}
            // 方法体内经 this 访问同对象的 _bgmInfoCacheKey/_sanitizeBangumiInfo：
            // 以 Kazumi 同形对象调用（生产环境是 Kazumi.peekCachedBangumiInfo(...)）
            globalThis.__peek = (key) => peekCachedBangumiInfo.call({
                _bgmInfoCacheKey, _sanitizeBangumiInfo,
            }, key);
        `, ctx);
        return (key) => ctx.__peek(key);
    }

    test('缓存命中（含有效 id）返回 true；未命中/空 id 返回 false', () => {
        // 命中：localCacheGet 返回净化器认可的对象
        const peekHit = buildPeek(`() => ({ id: 42, name: 'a' })`);
        assert.equal(peekHit('42'), true, '命中返回 true');
        // 未命中
        const peekMiss = buildPeek(`() => null`);
        assert.equal(peekMiss('missing'), false, '未命中返回 false');
        // 空 id
        const peekEmpty = buildPeek(`() => ({ id: 1, name: 'a' })`);
        assert.equal(peekEmpty(''), false, '空 id 返回 false');
    });
});
