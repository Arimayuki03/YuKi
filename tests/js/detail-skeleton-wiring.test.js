'use strict';
/**
 * detail-skeleton-wiring.test.js — A-02 第二阶段骨架接线 + A-01 第二阶段快照先渲染联合回归。
 *
 * 覆盖：
 *  ① 8 个占位点源码锚点：渲染函数含 _detailSkeleton 调用（load/openBangumi/_renderBgmEpisodes/
 *     _renderComments/_renderCharacters/_renderStaff/_renderRelations/_renderEpComments×2），
 *     且 A-03 错误态分支（_bgmExtraFailed 判定 + _detailRetryHtml）保持不动、位于骨架之前；
 *  ② common.js skeletonHtml comment 形态 count 扩展（单卡结构不变 + 多条 sk-comments 容器）；
 *  ③ A-01 快照命中时 open() 立即出 hero（行为断言：render 被调且带快照数据，_loadGen 守卫覆盖）；
 *  ④ 快照与详情结果字段冲突时结果优先（load() 合并口径）；
 *  ⑤ 无快照走 hero 骨架（渲染层实测 + 源码锚点）；
 *  ⑥ 错误态优先于骨架不误显（_bgmExtraFailed 全失败时页签渲染重试而非骨架）；
 *  ⑦ ui.css 联动：.detail-content 空态规则扩展 + .sk-comments 容器样式。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DETAIL_SRC = read('src/renderer/js/detail.js');
const COMMON_SRC = read('src/renderer/js/common.js');

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

/** 链式 jQuery 桩：html() 按选择器捕获（对齐 detail-start-button.test.js 精简版）。 */
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

/** 组合沙箱：cache.js + detail-snap.js + common.js 的 skeletonHtml（真实现）+ detail.js。
 *  renderSpy：包一层 Detail.render 记录调用时的 _vod 快照与 opts（行为断言用）。 */
function loadAll({ withSkeleton = true, renderSpy = false } = {}) {
    const ls = makeLs();
    const captor = { bound: [], htmlBySel: new Map(), renderCalls: [] };
    const toasts = [];
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        parseInt, parseFloat, isNaN, isFinite, setTimeout, clearTimeout, URL, Error, RegExp,
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
        showLoading: () => {},
        hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: (pic) => `<img src="${pic || 'assets/cover-fallback.svg'}">`,
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
    // cache.js/detail-snap.js 挂 root 时优先取 window（沙箱里是 { yuki } 桩）——把
    // localCache*/DetailSnap 导出回填到沙箱全局，与生产 <script defer> 共享 window
    // 的语义一致（导出只存在于 window 桩上，globalThis 直查为 undefined）
    vm.runInContext(`localCacheGet = window.localCacheGet;
        localCacheSet = window.localCacheSet;
        localCacheDel = window.localCacheDel;
        localCachePeek = window.localCachePeek;
        DetailSnap = window.DetailSnap;`,
    context, { filename: 'wire-globals.js' });
    if (withSkeleton) {
        // common.js 只取 skeletonHtml：整文件加载需要大量桩，正则抽函数（纯字符串拼装、
        // 依赖仅 escHtml/Number/Math——detail.js 沙箱已备）。参数漂移由 skeleton.test.js 锁定。
        const m = COMMON_SRC.match(/function skeletonHtml\(kind, opts\) \{[\s\S]*?\n\}/);
        assert.ok(m, 'common.js 应含 skeletonHtml 函数');
        vm.runInContext(m[0], context, { filename: 'skeletonHtml.js' });
    }
    vm.runInContext(`${DETAIL_SRC}\n;globalThis.__Detail = Detail;
        ;globalThis.__detailCacheGet = _detailCacheGet; globalThis.__detailCacheSet = _detailCacheSet;`,
    context, { filename: 'detail.js' });
    const D = context.__Detail;
    if (renderSpy) {
        const realRender = D.render.bind(D);
        D.render = (opts) => {
            // 半渲染数据在 render 体内临时挂到 _vod、渲染完即还原——调用前只能
            // 捕获 _snapHeroVod（open 传入的快照 vod），渲染后的 hero 以 #detail-body
            // HTML 捕获为准
            captor.renderCalls.push({
                opts: opts || null,
                snapHeroVod: D._snapHeroVod ? JSON.parse(JSON.stringify(D._snapHeroVod)) : null,
                sourcesLen: Array.isArray(D.sources) ? D.sources.length : -1,
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

/** 重置 Detail 可变状态（对齐 home-detail.test.js 的 detail() 夹具）。 */
function resetDetail(D, over = {}) {
    D.site = 'site-a';
    D.vodId = 'v1';
    D.vodName = '';
    D.sources = [];
    D.activeSource = 0;
    D._vod = null;
    D._lastVod = null;
    D._bgmId = null;
    D._bgmInfo = null;
    D._bgmExtraLoaded = false;
    D._bgmExtraFailed = { comments: false, characters: false, staff: false, relations: false };
    D._activeTab = '概览';
    D._loadGen = 0;
    D._snapHeroShown = false;
    D._snapHeroVod = null;
    Object.assign(D, over);
    return D;
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

// ================================================================ ① 8 个占位点源码锚点

describe('A-02①：8 个占位点骨架接线（源码锚点）', () => {
    // 各接线点 → 所在函数定义行（带 4 空格缩进 + 收尾 {，防命中前文调用点）→ kind + count
    // （与任务接线表一一对应）
    const SITES = [
        // G42 刷新按钮为 load() 加了 force 形参（refresh 旁路）；M-syncrender 再加
        // presetVod（open 预置缓存直出）——锚点放宽到 force 前缀，参数扩容不再碎改
        { fn: '    async load(force', label: '详情主体加载占位', kind: 'hero' },
        { fn: '    async openBangumi(subjectId, fallbackName, kazumiOrigin) {', label: 'Bangumi 详情主体（hero 形态）', kind: 'hero' },
        { fn: '    async _renderBgmEpisodes() {', label: 'bgm 分集区', kind: 'episode', count: 8 },
        { fn: '    _renderComments(append) {', label: '吐槽页签', kind: 'comment', count: 4 },
        { fn: '    _renderCharacters() {', label: '角色网格', kind: 'card', count: 6 },
        { fn: '    _renderStaff() {', label: '制作人员', kind: 'card', count: 6 },
        { fn: '    _renderRelations() {', label: '关联作品', kind: 'card', count: 4 },
        { fn: '    async _renderEpComments() {', label: '选集讨论弹层/页签', kind: 'comment' },
    ];

    test('每个接线点的函数体内都含对应 kind 的 _detailSkeleton 调用', () => {
        const src = DETAIL_SRC;
        // 方法体边界：下一个对象字面量方法定义行（CRLF 容忍：\r?\n + 4 空格 + 签名）。
        // 不能用「首个缩进行」找边界——函数体内部全是缩进行。
        const methodRe = /\r?\n    (?:async )?[A-Za-z_$][\w$]*\(.*?\)\s*\{/g;
        for (const s of SITES) {
            const i = src.indexOf(s.fn);
            assert.ok(i > 0, `找不到函数定义 ${s.fn.trim()}`);
            methodRe.lastIndex = i + s.fn.length; // 从签名行之后找下一个方法定义
            const m = methodRe.exec(src);
            const body = src.slice(i, m ? m.index : undefined);
            const callRe = s.count
                // opts 字面量允许额外键（骨架高度匹配：吐槽/选集讨论接线带 header 垫头部行）
                ? new RegExp(`_detailSkeleton\\('${s.kind}',\\s*\\{ count: ${s.count}\\s*[,}]`)
                : new RegExp(`_detailSkeleton\\('${s.kind}'`);
            assert.ok(callRe.test(body), `${s.label}（${s.fn.trim()}）应调用 _detailSkeleton('${s.kind}'${s.count ? `, {count: ${s.count}}` : ''})`);
        }
    });

    test('选集讨论页签内两条「加载评论中」均换骨架（shell 初染 + 切集重拉，header chip 垫计数行）', () => {
        const hits = DETAIL_SRC.match(/_detailSkeleton\('comment', \{ count: 3, header: 'chip' \}/g) || [];
        assert.equal(hits.length, 2, 'shell 初染 + pickEp 切集重拉共 2 处 comment count:3 header:chip');
    });

    test('骨架高度匹配：分集区用 episode 形态、吐槽/选集讨论等分集期头部由 header 垫住', () => {
        // 分集区：真实内容是 44px 集格网格，骨架必须用 episode 形态（旧 card 差数倍高度）
        assert.ok(/_detailSkeleton\('episode', \{ count: 8 \}/.test(DETAIL_SRC), 'bgm 分集骨架 episode count:8');
        // 吐槽页签 + 选集讨论等分集期：header:true 垫计数胶囊+按钮工具条行
        const headerTrue = DETAIL_SRC.match(/_detailSkeleton\('comment', \{ count: (?:4|2), header: true \}/g) || [];
        assert.equal(headerTrue.length, 2, '吐槽 + 选集讨论等分集期共 2 处 header:true');
    });

    test('A-03 错误态分支不动：_bgmExtraFailed 判定与 _detailRetryHtml 仍在骨架之前', () => {
        // 顺序锚点：每个页签渲染器内「_bgmExtraLoaded 骨架行」必须先于「_bgmExtraFailed 错误态行」
        const methodRe = /\r?\n    (?:async )?[A-Za-z_$][\w$]*\(.*?\)\s*\{/g;
        for (const fn of ['    _renderComments(append) {', '    _renderCharacters() {', '    _renderStaff() {', '    _renderRelations() {']) {
            const i = DETAIL_SRC.indexOf(fn);
            methodRe.lastIndex = i + fn.length;
            const m = methodRe.exec(DETAIL_SRC);
            const body = DETAIL_SRC.slice(i, m ? m.index : undefined);
            const skIdx = body.indexOf('_detailSkeleton(');
            const failIdx = body.indexOf('_bgmExtraFailed &&');
            assert.ok(skIdx > 0 && failIdx > skIdx,
                `${fn.trim()}：骨架在 _bgmExtraLoaded 分支，错误态分支必须在其后且未动`);
            assert.ok(body.includes('_detailRetryHtml('), `${fn.trim()}：错误态仍走 _detailRetryHtml`);
        }
        // 错误态文案不得被骨架替换污染：detail-retry-line 仍存在
        assert.ok(DETAIL_SRC.includes('id="detail-bgm-extra-retry"'), '重试按钮 id 保留');
    });
});

// ================================================================ ② skeletonHtml comment count 扩展

describe('A-02②：skeletonHtml comment 形态 count 扩展（common.js 小改）', () => {
    // 直接从 common.js 抽函数（同 loadAll 的手法），单独沙箱验证
    function loadSkeleton() {
        const m = COMMON_SRC.match(/function skeletonHtml\(kind, opts\) \{[\s\S]*?\n\}/);
        assert.ok(m);
        const ctx = { escHtml: (s) => String(s) };
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        vm.runInContext(m[0], ctx);
        return ctx.skeletonHtml;
    }
    const skeletonHtml = loadSkeleton();

    test('count 缺省：comment 仍单卡（第一阶段结构不变），card 缺省 6', () => {
        assert.ok(skeletonHtml('comment').includes('class="sk-root sk-comment"'), '缺省单卡根类');
        assert.ok(!skeletonHtml('comment').includes('sk-comments'), '缺省不出现多条容器类');
        assert.equal((skeletonHtml('card').match(/class="sk-card"/g) || []).length, 6, 'card 缺省 6 不变');
    });

    test('count>1：单一 sk-root.sk-comments 容器包 N 行，根类不重复', () => {
        const html = skeletonHtml('comment', { count: 4 });
        assert.equal((html.match(/class="sk-root/g) || []).length, 1, '唯一 sk-root（整组一次淡入）');
        assert.ok(html.includes('sk-root sk-comments'), '多条容器类 sk-comments');
        assert.equal((html.match(/sk-comment-avatar/g) || []).length, 4, '4 行头像块');
        assert.equal((html.match(/sk-comment-name(?=[" ])/g) || []).length, 4, '4 行名字条');
    });

    test('count>1 + header：外层再包唯一 sk-root.sk-tab（头部行 + 列表体整组一次淡入）', () => {
        const html = skeletonHtml('comment', { count: 4, header: true });
        assert.equal((html.match(/class="sk-root/g) || []).length, 1, '带头部仍唯一 sk-root');
        assert.ok(html.includes('sk-root sk-tab'), '组合根容器 sk-tab');
        assert.equal((html.match(/sk-comment-avatar/g) || []).length, 4, '列表体 4 行不变');
    });

    test('count 越界/非法回落：comment 与 card 同一钳制口径（1~12）', () => {
        assert.equal((skeletonHtml('comment', { count: 0 }).match(/sk-comment-avatar/g) || []).length, 1, '下取 1');
        assert.equal((skeletonHtml('comment', { count: 99 }).match(/sk-comment-avatar/g) || []).length, 12, '上取 12');
        assert.equal((skeletonHtml('comment', { count: 'x' }).match(/sk-comment-avatar/g) || []).length, 1, '非法回落缺省 1');
        // hero 形态忽略 count
        assert.ok(!skeletonHtml('hero', { count: 9 }).includes('sk-card'), 'hero 忽略 count');
    });
});

// ================================================================ ③ A-01 快照命中：open 立即出 hero

/** 快照专用夹具：在沙箱内以生产写入侧同款链路写快照（DetailSnap.put），可选预置
 *  详情 vod 缓存。返回 Detail、render 调用记录与 HTML 捕获。 */
function loadAllSnap({ renderSpy = true, withVodCache = false } = {}) {
    const env = loadAll({ withSkeleton: true, renderSpy });
    const { Detail, captor, ls } = env;
    const D = resetDetail(Detail);
    // 生产写入侧同款：沙箱内 DetailSnap.put（fire-and-forget 同步落 localStorage 桩）
    vm.runInContext(`DetailSnap.put('site-a', 'v1', { pic: 'http://p/1.jpg', name: '快影片名', remarks: '更新至 12 集', year: '2026' })`,
        env.context, { filename: 'put-snap.js' });
    if (withVodCache) {
        vm.runInContext(`__detailCacheSet('detail::vod::v1::', 'site-a|v1', { vod_name: '缓存片名', vod_pic: 'http://p/c.jpg', vod_play_from: '线路A', vod_play_url: '第1集$u1' }, 6 * 60 * 60 * 1000)`,
            env.context, { filename: 'put-vod.js' });
    }
    return { D, captor, ls, env };
}

describe('A-01③：快照命中时 open() 立即出 hero（行为断言）', () => {
    test('快照命中且 vod 缓存未命中：render 立即被调、带快照数据、实例态不被污染', async () => {
        const { D, captor, env } = loadAllSnap();
        const shown = [];
        env.context.App = { currentView: 'home', showView: (v) => shown.push(v) };
        // doAction 挂起不放行：load() 停在等结果，#detail-body 保持在快照半渲染态——
        // （若放行失败分支，错误页会覆盖 hero，无法断言半渲染 HTML）
        let release;
        env.context.doAction = () => new Promise((res) => { release = res; });
        D.open('site-a', 'v1', '');
        await flush();
        assert.equal(captor.renderCalls.length, 1, 'open 内快照路径立即 render 一次');
        const call = captor.renderCalls[0];
        assert.ok(call.opts && call.opts.snapHero === true, 'render 收到 snapHero 标记');
        assert.equal(call.snapHeroVod && call.snapHeroVod.vod_name, '快影片名', '半渲染 hero 用快照片名');
        assert.equal(call.snapHeroVod && call.snapHeroVod.vod_pic, 'http://p/1.jpg', '半渲染 hero 用快照封面');
        assert.equal(call.sourcesLen, 0, '半渲染态无 sources（无线路区）');
        assert.equal(D._vod, null, '渲染后实例 _vod 还原为 null（快照不落实例态）');
        assert.equal(D._lastVod, null, '_lastVod 同步还原');
        assert.ok(shown.includes('detail'), '视图已切换');
        // hero HTML：封面+标题进 #detail-body，半渲染态文案正确
        const heroHtml = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(heroHtml.includes('快影片名'), 'hero 标题为快照片名');
        assert.ok(heroHtml.includes('http://p/1.jpg'), 'hero 封面为快照 pic');
        assert.ok(heroHtml.includes('线路加载中…'), '半渲染态播放信息为「线路加载中…」而非「暂无播放线路」');
        assert.ok(heroHtml.includes('sk-root sk-desc'), '页签内容区垫简介形态骨架（对齐概览页签真实内容）');
        release({ list: [{ vod_id: 'v1', vod_name: '结果片名', vod_play_from: '', vod_play_url: '' }] });
        await flush();
        assert.equal(D._vod && D._vod.vod_name, '结果片名', '结果到达后覆盖半渲染态');
    });

    test('快照命中但 vod 缓存也命中：跳过半渲染，open 同步直出完整版面（M-syncrender）', async () => {
        const { D, captor } = loadAllSnap({ withVodCache: true });
        // 只拦网络侧不拦渲染：load(force, presetVod) 拿到 open 预置的缓存值后
        // 在同一调用栈内 render——完整版面（含线路区）替换快照半渲染，无骨架无垫场
        D.load = async function (force, presetVod) {
            captor.renderCalls.push({ opts: null, presetVodName: presetVod && presetVod.vod_name, snapHero: false });
        };
        D.open('site-a', 'v1', '');
        await flush();
        assert.equal(captor.renderCalls.length, 1, 'vod 缓存命中时不做快照半渲染，改走 load 同步直出');
        assert.equal(captor.renderCalls[0].presetVodName, '缓存片名', 'open 预置的缓存 vod 直达 load（免网络）');
        assert.ok(!captor.renderCalls[0].snapHero, '未经快照半渲染路径');
    });

    test('无快照：open 不触发半渲染（render 不被 open 调用）', async () => {
        const { Detail, captor } = loadAll({ withSkeleton: true, renderSpy: true });
        const D = resetDetail(Detail);
        D.load = async () => {};
        D.open('site-a', 'v2', '');
        await flush();
        assert.equal(captor.renderCalls.length, 0, '无快照时 open 不半渲染');
        void captor;
    });
});

// ================================================================ ④ 快照与结果冲突时结果优先

describe('A-01④：详情结果优先（merge 口径）', () => {
    test('load() 结果到达后整页覆盖快照版面：hero 为结果字段，_snapHeroShown 收口', async () => {
        const { Detail, captor, context: ctxS } = loadAll({ withSkeleton: true, renderSpy: true });
        const D = resetDetail(Detail);
        // 快照：旧片名/旧封面
        vm.runInContext(`DetailSnap.put('site-a', 'v9', { pic: 'http://p/old.jpg', name: '旧片名', remarks: '旧备注', year: '2020' })`,
            ctxS, { filename: 'put-snap.js' });
        // 网络结果：新片名/新封面（结果与快照全部冲突）
        ctxS.doAction = async () => ({ list: [{
            vod_id: 'v9', vod_name: '新片名', vod_pic: 'http://p/new.jpg',
            vod_remarks: '新备注', vod_year: '2026',
            vod_play_from: '线路A', vod_play_url: '第1集$u1#第2集$u2',
        }] });
        // 模拟 open 已展示半渲染态（快照路径上屏后 load 才到结果）
        D._snapHeroShown = true;
        D.vodId = 'v9';
        await D.load();
        await flush();
        assert.equal(D._snapHeroShown, false, '结果到达后收口半渲染标记');
        assert.equal(D._vod.vod_name, '新片名', '实例态为结果片名（结果优先）');
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('新片名'), 'hero 覆盖为结果片名');
        assert.ok(html.includes('http://p/new.jpg'), 'hero 覆盖为结果封面');
        assert.ok(!html.includes('旧片名') && !html.includes('http://p/old.jpg'), '快照旧字段不残留');
        assert.ok(html.includes('1 条线路 · 共 2 集'), 'vod_play_url 线路区由结果补齐');
        assert.ok(!html.includes('线路加载中…'), '半渲染态文案被完整版面替换');
    });

    test('load() 失败：快照半渲染收口为错误态（_snapHeroShown 复位 + 重试入口）', async () => {
        const { Detail, captor, toasts, context: ctxS } = loadAll({ withSkeleton: true });
        const D = resetDetail(Detail);
        ctxS.doAction = async () => { throw new Error('net down'); };
        D._snapHeroShown = true; // 假设半渲染已上屏
        D.vodId = 'v-err';
        await D.load();
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.equal(D._snapHeroShown, false, '失败路径复位半渲染标记');
        assert.ok(html.includes('详情载入失败'), '错误态替代垫场 hero');
        assert.ok(html.includes('detail-load-retry'), '重试入口保留（A-03）');
        assert.ok(toasts.some((t) => /详情载入失败/.test(t)));
        void captor;
    });
});

// ================================================================ ⑤ 无快照走骨架（渲染层实测）

describe('A-02⑤：无快照走骨架（渲染层实测）', () => {
    test('load 入口：无快照/半渲染时 #detail-body 写 hero 骨架（sk-hero 结构）', async (t) => {
        const { Detail, captor, context: ctxS } = loadAll({ withSkeleton: true });
        const D = resetDetail(Detail);
        // doAction 挂起：观察 load 入口写入的占位
        let release;
        ctxS.doAction = () => new Promise((res) => { release = res; });
        // A-34：骨架不再无条件先写——要先越过 DETAIL_LOADING_DELAY_MS 宽限期。
        // 用 fake timer 推动这 200ms（不真等）：node:vm 沙箱捕获的是加载时的宿主
        // setTimeout 引用，t.mock.timers 够不到，故 detail.js 暴露了注入点。
        const restore = installFakeTimers(ctxS);
        const p = D.load();
        await flush();
        ctxS.__tickTimers(250); // 越过 200ms 宽限期
        await flush();
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('class="sk-root sk-hero"'), '慢源超宽限期后 hero 骨架上屏（⑤ 无快照走骨架）');
        assert.ok(html.includes('sk-hero-cover') && html.includes('sk-hero-info'), '骨架含封面块+信息区');
        release({ list: [{ vod_id: 'v1', vod_name: '最终片名', vod_play_from: '', vod_play_url: '' }] });
        await p;
        await flush();
        restore();
        const after = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(after.includes('最终片名'), '数据到达后骨架被真实内容替换');
        assert.ok(!after.includes('sk-hero-cover'), '骨架不残留');
    });

    // A-34 首屏宽限期：快请求不写任何中间态，第一次绘制即完整版面（对齐 v0.2.6
    // 「打开即见」手感，避免快速请求也先闪一屏骨架）。
    test('A-34：数据在宽限期内到达时不写 hero 骨架，首屏即完整版面', async () => {
        const { Detail, captor, context: ctxS } = loadAll({ withSkeleton: true });
        const D = resetDetail(Detail);
        ctxS.doAction = async () => ({ list: [{ vod_id: 'v1', vod_name: '快返片名', vod_play_from: '', vod_play_url: '' }] });
        const skeletonWrites = [];
        const after = await D.load();
        void after;
        for (const [, v] of captor.htmlBySel) {
            if (/sk-root sk-hero/.test(String(v))) skeletonWrites.push(v);
        }
        assert.equal(skeletonWrites.length, 0, '快请求（<200ms）不该写 hero 骨架');
        const html = String(captor.htmlBySel.get('#detail-body') || '');
        assert.ok(html.includes('快返片名'), '首屏即为真实内容（一次成型）');
    });

    test('A-34：宽限期 race 不重发请求——同一个 doAction promise 被复用', async () => {
        const { Detail, context: ctxS } = loadAll({ withSkeleton: true });
        const D = resetDetail(Detail);
        let calls = 0;
        let release;
        ctxS.doAction = () => { calls += 1; return new Promise((res) => { release = res; }); };
        const restore = installFakeTimers(ctxS);
        const p = D.load();
        await flush();
        ctxS.__tickTimers(250);
        await flush();
        assert.equal(calls, 1, '慢路径下 race 后仅发出一次 detailContent（不因宽限期重发）');
        release({ list: [{ vod_id: 'v1', vod_name: 'x', vod_play_from: '', vod_play_url: '' }] });
        await p;
        restore();
        assert.equal(calls, 1, '全流程只发一次请求');
    });

    test('沙箱无 skeletonHtml：_detailSkeleton 回落 .tip-line 文本（兜底不抛错）', () => {
        // helper 单测：无实现回落文本、有实现返回骨架
        const ctx = { escHtml: (s) => String(s) };
        const m = DETAIL_SRC.match(/function _detailSkeleton\(kind, opts, fallbackText\) \{[\s\S]*?\n\}/);
        assert.ok(m, 'detail.js 应含 _detailSkeleton helper');
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        vm.runInContext(`${m[0]}\n;globalThis.__f = _detailSkeleton;`, ctx);
        const out = ctx.__f('hero', null, '载入中…');
        assert.ok(out.includes('tip-line') && out.includes('载入中…'), '无 skeletonHtml 时回落文本占位');
        assert.doesNotThrow(() => ctx.__f('card', null, undefined), 'fallback 缺省不抛错');
        // 挂上真实现后返回骨架
        const m2 = COMMON_SRC.match(/function skeletonHtml\(kind, opts\) \{[\s\S]*?\n\}/);
        vm.runInContext(m2[0], ctx);
        const out2 = vm.runInContext('_detailSkeleton("card", { count: 6 }, "加载中…")', ctx);
        assert.ok(out2.includes('sk-root sk-cards'), '有实现时返回骨架 HTML');
        assert.equal((out2.match(/class="sk-card"/g) || []).length, 6);
    });
});

// ================================================================ ⑥ 错误态优先于骨架

describe('A-02⑥：错误态（_bgmExtraFailed）优先于骨架不误显', () => {
    test('四路全失败 → 吐槽页签渲染重试态，无骨架结构残留', async () => {
        const netErr = new Error('net down');
        const { Detail, captor } = loadAll({ withSkeleton: true });
        const D = resetDetail(Detail, { _bgmId: '42', _bgmInfo: { id: 42, name: '番剧' }, _activeTab: '吐槽' });
        D._loadBgmExtra = async function () { // 直接置失败态（加载流程已被 A-03 测试覆盖）
            this._bgmExtraLoaded = true;
            this._bgmExtraFailed = { comments: true, characters: true, staff: true, relations: true };
        };
        await D._loadBgmExtra();
        D._renderComments();
        const html = String(captor.htmlBySel.get('#detail-tab-content') || '');
        assert.ok(html.includes('吐槽加载失败'), '错误态文案');
        assert.ok(html.includes('id="detail-bgm-extra-retry"'), '重试按钮');
        assert.ok(!html.includes('sk-root'), '失败页不显骨架');
        assert.ok(!html.includes('加载中…'), '失败页不显加载占位');
    });

    test('未加载（_bgmExtraLoaded=false）→ 骨架；失败态判定在其后（顺序已由①锁定）', async () => {
        const { Detail, captor } = loadAll({ withSkeleton: true });
        const D = resetDetail(Detail, { _bgmId: '42', _activeTab: '角色' });
        D._renderCharacters();
        const html = String(captor.htmlBySel.get('#detail-tab-content') || '');
        assert.ok(html.includes('sk-root sk-cards'), '未加载显卡片骨架');
        assert.ok(!html.includes('加载中…'), '骨架替代文本占位');
    });
});

// ================================================================ ⑦ ui.css 联动

describe('A-02⑦：ui.css 联动规则', () => {
    test('.detail-content 空态规则扩展 + .sk-comments 容器样式落地', () => {
        const css = read('src/renderer/css/ui.css');
        assert.ok(/\.vod-grid > \.tip-line:only-child,/.test(css), 'vod-grid 选择器组后接 detail-content');
        assert.ok(/\.detail-content > \.tip-line:only-child \{/.test(css), '.detail-content 空态虚线卡');
        assert.ok(/\.sk-comments \{ min-width:0; \}/.test(css), 'sk-comments 容器类样式');
    });

    test('骨架高度匹配：头部工具条行 / episode 集格样式与真实结构对齐', () => {
        const css = read('src/renderer/css/ui.css');
        // 头部工具条：32px 控件行 + 下距 10px（对齐 .detail-comment-toolbar / .ep-comments-head）
        assert.ok(/\.sk-head-line \{[^}]*min-height:32px/.test(css), 'sk-head-line 32px 控件行');
        assert.ok(/\.sk-head-line \{[^}]*margin-bottom:10px/.test(css), 'sk-head-line 下距同真实工具条');
        // episode 集格：列模板与 .kazumi-episode-grid 同口径，行格 44px 对齐 .kazumi-detail-ep
        assert.ok(/\.sk-eps \{[^}]*repeat\(auto-fill,minmax\(220px,1fr\)\)/.test(css), 'sk-eps 列模板对齐 kazumi-episode-grid');
        assert.ok(/\.sk-ep \{[^}]*min-height:44px/.test(css), 'sk-ep 行格 44px 对齐 kazumi-detail-ep');
        // 分集占位错位修复：骨架宿主 #bgm-ep-list 自带 .ep-grid 列模板——骨架根必须
        // 跨全列占满宿主行宽，否则被压进第一列轨道成窄条，数据到达后整幅错位跳变
        assert.ok(/\.ep-grid > \.sk-eps \{ grid-column:1 \/ -1; \}/.test(css), 'sk-eps 在 .ep-grid 宿主内跨全列（占位与真实网格零位差）');
        // 静态灰块裁决不破：头部/集格样式同样不引入循环动画
        const skRules = css.split('}').filter((chunk) => chunk.includes('.sk-'));
        for (const chunk of skRules) {
            assert.ok(!/animation[^;]*infinite/.test(chunk), `sk- 规则不得含 infinite 循环：${chunk.slice(0, 80)}`);
        }
    });
});
