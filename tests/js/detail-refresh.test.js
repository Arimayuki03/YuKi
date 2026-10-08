'use strict';
// B-13 衍生（详情页手动刷新按钮）回归测试 + 刷新按钮 v2（图标化 + 移位）+ 返回栈修复：
// 1) 按钮：index.html 静态图标钮，挂在 .detail-topbar 内 #detail-back 右侧
//    （md-btn-icon + aria-label，SVG 与 #home-refresh 同款 Material refresh 路径）；
//    render() hero 操作行不再渲染刷新钮
// 2) 点击 → 清 detail::vod::v1:: 缓存条目 + load 重入（force=true 跳本地缓存读）
// 3) 请求带 refresh 参数：force load 的 detailContent 请求 kv 含 refresh:'1'，
//    非 force 请求不带（空串，_form_flag 读不到即关）
// 4) 防抖：disabled 期间连点无效（_refreshDetail 只触发一次）；异步收尾复位按钮态
// 5) Bangumi-only 版面：清 detail::bgminfo::v1:: 缓存条目并重入 openBangumi
// 6) 返回栈修复：刷新重入不压栈/不清栈——刷新后 back() 一次回上级视图；
//    嵌套跳转（非刷新路径）压栈行为不变
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 最小 jQuery 桩（手法照抄 detail-start-button.test.js / detail-desc-toggle.test.js）：
 *  链式 on 记录委托监听器（委托选择器单独记录）；对象分支记录 prop/attr 调用，
 *  供防抖断言读 disabled 态；html/text 按选择器捕获。
 *  L48 桩差异登记（5 份近似桩各自的语义差异，detail.js 新增 $ 链式调用需逐一核对补桩）：
 *  - 本文件：attr/prop 有返回值语义（防抖断言读 disabled 态）；html/text 按选择器捕获；
 *    escHtml 为真实转义（L49）。共享节点 registry / [0] 原生桥见 detail-source-switch；
 *    first() 注入容器见 detail-comment-reorder；text/toggleClass 捕获见 detail-bgm-defer；
 *    按调用新建节点见 detail-skeleton-wiring。提炼共享 detail-test-kit 前以本注释为索引。 */
function makeJqStub(captor) {
    const makeNode = (sel) => ({
        sel: String(sel),
        length: 1,
        _data: {},
        on(ev, a, b) {
            const fn = typeof b === 'function' ? b : a;
            const delegated = typeof b === 'function' ? String(a) : '';
            if (typeof fn === 'function') captor.bound.push({ sel: String(sel), ev, delegated, fn });
            return this;
        },
        off() { return this; },
        html(s) { if (s !== undefined) captor.htmlBySel.set(String(sel), s); return this; },
        text() { return this; },
        addClass() { return this; },
        removeClass() { return this; },
        attr(k, v) {
            if (v !== undefined) { this._attrs = this._attrs || {}; this._attrs[k] = v; captor.attrCalls.push({ sel: String(sel), k, v }); }
            return (this._attrs && this._attrs[k]) || (v !== undefined ? this : undefined);
        },
        prop(k, v) {
            if (v !== undefined) { this._props = this._props || {}; this._props[k] = v; captor.propCalls.push({ sel: String(sel), k, v }); }
            return (this._props && this._props[k] !== undefined) ? this._props[k] : (v !== undefined ? this : undefined);
        },
        find(s) { return makeNode(String(sel) + ' > ' + String(s)); },
        each() { return this; },
        not() { return this; },
        is() { return false; },
        toggle() { return this; },
        toggleClass() { return this; },
        hide() { return this; },
        show() { return this; },
        remove() { return this; },
        closest() { return makeNode(String(sel) + ' ^'); },
        prepend(s) { captor.prepends.push({ sel: String(sel), html: String(s) }); return this; },
        replaceWith(html) { captor.replaced.push({ sel: String(sel), html: String(html) }); return this; },
        data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
    });
    // $(domObj)：包装事件目标——prop/attr/prepend 记录到 captor（供防抖断言），
    // data 委托原对象（jQuery 读元素 data 的行为）。
    return (sel) => {
        if (sel && typeof sel === 'object') {
            const wrap = {
                length: 1,
                prop(k, v) {
                    if (v !== undefined) { sel._props = sel._props || {}; sel._props[k] = v; captor.propCalls.push({ sel: 'obj', k, v }); return wrap; }
                    return sel._props ? sel._props[k] : undefined;
                },
                attr(k, v) {
                    if (v !== undefined) { sel._attrs = sel._attrs || {}; sel._attrs[k] = v; captor.attrCalls.push({ sel: 'obj', k, v }); return wrap; }
                    return sel._attrs ? sel._attrs[k] : undefined;
                },
                prepend(s) { captor.prepends.push({ sel: 'obj', html: String(s) }); return wrap; },
                data(k) { return (typeof sel.data === 'function') ? sel.data(k) : (sel._data && sel._data[k]); },
                find(s) { return makeNode('obj > ' + String(s)); },
                on() { return wrap; }, off() { return wrap; },
                html(s) { if (s !== undefined) captor.htmlBySel.set('obj', s); return wrap; },
                text() { return wrap; }, addClass() { return wrap; }, removeClass() { return wrap; },
                each() { return wrap; }, not() { return wrap; }, is() { return false; },
                toggle() { return wrap; }, hide() { return wrap; }, show() { return wrap; },
                remove() { return wrap; },
                closest() { return makeNode('obj ^'); },
            };
            return wrap;
        }
        return makeNode(sel);
    };
}

/** 模拟 #detail-refresh 静态 DOM 节点：document.getElementById 桩的返回值。
 *  支持点击处理器写入的 disabled/setAttribute/removeAttribute 与复位断言。 */
function makeRefreshEl() {
    return {
        disabled: false,
        _attrs: {},
        data: () => undefined,
        setAttribute(k, v) { this._attrs[k] = v; },
        removeAttribute(k) { delete this._attrs[k]; },
    };
}

/** 在 VM 中加载 detail.js（最小桩），返回 Detail、监听器记录、行为捕获。
 *  opts.doAction：自定义 detailContent 桩；opts.App：自定义 App 桩（返回栈测试
 *  需 currentView 随 showView 变化）；opts.getElementById：覆盖 document.getElementById。 */
function loadDetail(opts = {}) {
    const source = read('src/renderer/js/detail.js');
    const captor = {
        bound: [], htmlBySel: new Map(), propCalls: [], attrCalls: [], prepends: [],
        replaced: [],
        deleted: [], doActionCalls: [],
    };
    const toasts = [];
    const context = {
        console: { warn: () => {}, log: () => {}, error: () => {} },
        Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, URL,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: (id) => (opts.getElementById ? opts.getElementById(id) : null),
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: makeJqStub(captor),
        registerEsc: () => {},
        // L49：与 common.js escHtml 同实现的真实转义桩（含单引号），转义层回归
        // （双重转义/漏转义）在本文件内容断言中可见；口径与 detail-skeleton-wiring 对齐。
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        stripHtml: (s) => String(s || ''),
        warnToast: (m) => toasts.push(String(m)),
        showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: () => '<img src="cover.jpg">',
        normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        localCacheGet: () => null,
        localCacheSet: () => {},
        localCacheDel: (k) => { captor.deleted.push(String(k)); },
        openDialog: () => {}, closeDialog: () => {},
        doAction: async (action, kv) => {
            captor.doActionCalls.push({ action, kv });
            return (opts.doAction) ? opts.doAction(action, kv) : { list: [JSON.parse(JSON.stringify(SAMPLE_VOD))] };
        },
        App: opts.App || { currentView: 'detail', showView() {} },
        Records: { isFavorite: async () => false, getFavTag: async () => '', getWatchProgress: async () => null },
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    Object.assign(context, opts.extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, captor, toasts, context };
}

const SAMPLE_VOD = {
    vod_id: 'v1', vod_name: '测试影片', vod_pic: '', vod_content: '',
    vod_play_from: '线路A',
    vod_play_url: '第1集$u1#第2集$u2',
};

const flush = () => new Promise((r) => setImmediate(r));

/** 取 init() 直绑在 #detail-refresh 上的 click 监听器（刷新按钮 v2：静态节点直绑，
 *  不再走 #detail-body 委托——按钮已移到 #detail-body 之外）。 */
function findRefreshHandler(bound) {
    const hit = bound.find((b) => b.sel === '#detail-refresh' && b.ev === 'click'
        && b.delegated === '');
    assert.ok(hit, 'init() 应直绑 #detail-refresh click 监听（静态节点，#detail-body 委托收不到）');
    return hit.fn;
}

/** index.html 中 .detail-topbar 段（返回 + 刷新钮容器）。 */
function detailTopbarHtml() {
    const html = read('src/renderer/index.html');
    const m = html.match(/<div class="detail-topbar">([\s\S]*?)<\/div>\s*<div id="detail-body"/);
    assert.ok(m, 'index.html 应有 .detail-topbar 容器包裹返回与刷新钮，且位于 #detail-body 之前');
    return m[1];
}

test('① 按钮 DOM 锚点：#detail-refresh 是 #detail-back 的兄弟节点且在其右侧（.detail-topbar 内）', () => {
    const bar = detailTopbarHtml();
    const idxBack = bar.indexOf('id="detail-back"');
    const idxRefresh = bar.indexOf('id="detail-refresh"');
    assert.ok(idxBack >= 0, '.detail-topbar 应含返回按钮 #detail-back');
    assert.ok(idxRefresh >= 0, '.detail-topbar 应含刷新按钮 #detail-refresh');
    assert.ok(idxBack < idxRefresh, '刷新按钮应在返回按钮右侧（DOM 顺序：back → refresh）');
});

test('① 按钮形态：图标钮（md-btn-icon）+ aria-label/title=刷新，SVG 与 #home-refresh 同款', () => {
    const html = read('src/renderer/index.html');
    const bar = detailTopbarHtml();
    const m = bar.match(/<button id="detail-refresh"([^>]*)>([\s\S]*?)<\/button>/);
    assert.ok(m, '刷新按钮应为 button 元素');
    const attrs = m[1];
    assert.ok(attrs.includes('md-btn-icon'), '应复用全应用图标按钮样式 md-btn-icon（同 #home-refresh）');
    assert.ok(attrs.includes('md-btn-tonal'), '应保持 tonal 配色（同返回按钮/工具栏图标钮）');
    assert.ok(attrs.includes('aria-label="刷新"'), '应带 aria-label="刷新"（可访问性）');
    assert.ok(attrs.includes('title="刷新"'), '应带 title="刷新"');
    // 图标资源完全复用：detail-topbar 内 SVG path 与 #home-refresh 的逐字一致
    const homeM = html.match(/id="home-refresh"[^>]*>\s*<svg viewBox="0 0 24 24"><path d="([^"]+)"/);
    const refreshM = m[2].match(/<svg viewBox="0 0 24 24"><path d="([^"]+)"/);
    assert.ok(homeM, '#home-refresh 应含 Material refresh 图标 path');
    assert.ok(refreshM, '#detail-refresh 应含同款 SVG 图标');
    assert.equal(refreshM[1], homeM[1], '刷新图标 path 应与 #home-refresh 逐字一致（不新造视觉）');
});

test('① hero 操作行不再渲染刷新钮：render() 产出不含 id="detail-refresh"', () => {
    const { Detail, captor } = loadDetail();
    Detail._vod = SAMPLE_VOD;
    Detail.sources = Detail.parsePlay(SAMPLE_VOD);
    Detail.activeSource = 0;
    Detail.render();
    const html = String(captor.htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('detail-hero-actions'), 'hero 操作行容器仍存在');
    assert.ok(!html.includes('id="detail-refresh"'), '刷新按钮 v2：hero 操作行不应再渲染刷新钮（已移至返回按钮旁）');
});

test('① Bangumi-only 版面 render() 同样不再渲染刷新钮', async () => {
    const Kazumi = {
        getBangumiMatch: async () => null,
        bangumiInfo: async () => ({ id: 777, name: 'b', name_cn: 'c', images: {} }),
        bangumiEpisodes: async () => null,
        _applyBangumiColState: async () => {},
    };
    const { Detail, captor } = loadDetail({ extra: { Kazumi } });
    await Detail.openBangumi('777', '测试番剧');
    await flush();
    const html = String(captor.htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('detail-hero-bangumi'), '应为 Bangumi 版面');
    assert.ok(!html.includes('id="detail-refresh"'), 'Bangumi-only 版面 hero 也不应渲染刷新钮（静态钮常驻）');
});

test('⑦ 详情 hero 封面：Bangumi 封面走 bangumiCoverImg 代理链（/kazumi/cover 首源），CatVod 回落 vodCoverImg', async () => {
    // 封面慢修复：hero 封面不再直连 lain 图床（被墙/慢时空白）——Bangumi 封面
    // 改走 bangumiCoverImg（代理 + 磁盘缓存 + 镜像兜底），size='large' 保持详情大图。
    const Kazumi = {
        getBangumiMatch: async () => null,
        bangumiInfo: async () => ({ id: 777, name: 'b', name_cn: 'c', images: {} }),
        bangumiEpisodes: async () => null,
        _applyBangumiColState: async () => {},
    };
    const bgmCalls = [];
    const { Detail, captor } = loadDetail({
        extra: {
            Kazumi,
            // 沙箱默认 bangumiCover 桩返回 ''（无 images 数据）——这里给真实 URL 走
            // 「有 Bangumi 封面」分支，验证 hero 封面出自 bangumiCoverImg 代理链
            bangumiCover: () => 'https://lain.bgm.tv/pic/cover/l/x.jpg',
            bangumiCoverImg: (pic, eager, size) => { bgmCalls.push({ pic, eager, size }); return `<img class="bgm-proxy" src="${pic}">`; },
        },
    });
    await Detail.openBangumi('777', '测试番剧');
    await flush();
    const html = String(captor.htmlBySel.get('#detail-body') || '');
    assert.ok(html.includes('class="bgm-proxy"'), 'Bangumi 版面 hero 封面应出自 bangumiCoverImg');
    assert.deepEqual(bgmCalls, [{ pic: 'https://lain.bgm.tv/pic/cover/l/x.jpg', eager: true, size: 'large' }], 'bangumiCoverImg 应带 eager + size=large（详情大图口径）');
    // CatVod 版面：无 Bangumi 匹配，封面仍走 vodCoverImg（源图床无白名单代理）
    const catvod = loadDetail({ extra: { Kazumi } });
    catvod.Detail._vod = SAMPLE_VOD;
    catvod.Detail.render();
    const catHtml = String(catvod.captor.htmlBySel.get('#detail-body') || '');
    assert.ok(catHtml.includes('<img src="cover.jpg">'), 'CatVod 版面 hero 封面仍走 vodCoverImg');
});

test('② 点击刷新：清 detail::vod::v1:: 缓存条目并重入 load()（force 跳缓存读）', async () => {
    const refreshEl = makeRefreshEl();
    const { Detail, captor } = loadDetail({ getElementById: (id) => (id === 'detail-refresh' ? refreshEl : null) });
    Detail.init();
    Detail.site = 'site-a';
    Detail.vodId = 'v1';
    Detail.vodName = '测试影片';
    let loadCalls = [];
    const origLoad = Detail.load.bind(Detail);
    Detail.load = function (force) { loadCalls.push(force); return origLoad(force); };
    await Detail.load();
    await flush(); await flush();
    loadCalls = [];
    const handler = findRefreshHandler(captor.bound);
    await handler({ currentTarget: refreshEl });
    assert.deepEqual(loadCalls, [true], '刷新应重入 load(true)');
    assert.deepEqual(captor.deleted, ['detail::vod::v1::site-a|v1'], '应清该条目的详情缓存');
    await flush(); await flush();
});

test('③ 请求带 refresh 参数：force load 的 detailContent kv 含 refresh=1，普通 load 不带', async () => {
    // force：点击刷新路径 → refresh:'1'
    const forced = loadDetail();
    forced.Detail.site = 'site-a';
    forced.Detail.vodId = 'v1';
    await forced.Detail.load(true);
    await flush();
    const fCall = forced.captor.doActionCalls.find((c) => c.action === 'detailContent');
    assert.ok(fCall, 'force load 应发起 detailContent');
    assert.equal(fCall.kv.refresh, '1', 'force 请求应带 refresh=1');
    // 非 force：普通打开路径 → 不带真值（空串，后端 _form_flag 读到即关）
    const normal = loadDetail();
    normal.Detail.site = 'site-a';
    normal.Detail.vodId = 'v1';
    await normal.Detail.load();
    await flush();
    const nCall = normal.captor.doActionCalls.find((c) => c.action === 'detailContent');
    assert.ok(nCall, '普通 load 应发起 detailContent');
    assert.ok(!nCall.kv.refresh, '普通请求不应携带真值 refresh');
});

test('④ 防抖：disabled 期间连点无效（_refreshDetail 只触发一次）', async () => {
    const refreshEl = makeRefreshEl();
    const { Detail, captor } = loadDetail({ getElementById: (id) => (id === 'detail-refresh' ? refreshEl : null) });
    Detail.init();
    Detail.site = 'site-a';
    Detail.vodId = 'v1';
    const handler = findRefreshHandler(captor.bound);
    let refreshCount = 0;
    let resolveRefresh;
    // 桩返回受控 promise：模拟刷新在途（真实场景 = load(true)/openBangumi 未收尾），
    // 收尾前按钮保持 disabled，收尾复位后才可再点
    Detail._refreshDetail = function () {
        refreshCount++;
        return new Promise((r) => { resolveRefresh = r; });
    };
    await handler({ currentTarget: refreshEl });
    assert.equal(refreshCount, 1, '首次点击应触发刷新');
    // disabled 期间再点：handler 首行读 el.disabled 为 true → 忽略
    await handler({ currentTarget: refreshEl });
    await handler({ currentTarget: refreshEl });
    assert.equal(refreshCount, 1, 'disabled 期间连点不应重复触发');
    // 点击已置 disabled + aria-busy + spinner（A-21 手法复用）+ 图标让位
    assert.equal(refreshEl.disabled, true, '点击后按钮应禁用');
    assert.equal(refreshEl._attrs['aria-busy'], 'true', '点击后应置 aria-busy');
    assert.ok(captor.prepends.some((p) => p.sel === 'obj' && p.html.includes('yuki-tr-spinner')), '刷新期间应挂 spinner 反馈');
    resolveRefresh();
    await flush();
});

test('④ 防抖复位：重入 load 收尾后按钮态恢复（disabled 摘除 + spinner 摘除 + 图标还原）', async () => {
    const refreshEl = makeRefreshEl();
    const { Detail, captor } = loadDetail({ getElementById: (id) => (id === 'detail-refresh' ? refreshEl : null) });
    Detail.init();
    Detail.site = 'site-a';
    Detail.vodId = 'v1';
    const handler = findRefreshHandler(captor.bound);
    await handler({ currentTarget: refreshEl });
    assert.equal(refreshEl.disabled, true, '前置：刷新期间禁用');
    await flush(); await flush(); await flush();
    assert.equal(refreshEl.disabled, false, 'load 收尾后应解除禁用（按钮在 #detail-body 外不被重建，必须手动复位）');
    assert.equal(refreshEl._attrs['aria-busy'], undefined, 'aria-busy 应摘除');
    // spinner 摘除 + svg 还原：经 $(el).find(...).remove()/.show()（桩记录到 captor.prepends 之外，
    // 这里以按钮回到可点击态为准——再点一次应能重新触发）
    let second = 0;
    Detail._refreshDetail = function () { second++; };
    await handler({ currentTarget: refreshEl });
    assert.equal(second, 1, '复位后可再次点击（防永久卡死）');
    await flush(); await flush();
});

test('⑤ Bangumi-only：点击刷新清 detail::bgminfo::v1:: 缓存并重入 openBangumi', async () => {
    const refreshEl = makeRefreshEl();
    const Kazumi = {
        getBangumiMatch: async () => null,
        bangumiInfo: async (id) => ({ id: Number(id), name: 'b', name_cn: 'c', images: {} }),
        bangumiEpisodes: async () => null,
        _applyBangumiColState: async () => {},
    };
    const { Detail, captor } = loadDetail({
        extra: { Kazumi },
        getElementById: (id) => (id === 'detail-refresh' ? refreshEl : null),
    });
    Detail.init();
    await Detail.openBangumi('777', '测试番剧');
    await flush();
    assert.equal(Detail.site, '', '前置：openBangumi 详情 site 为空（Bangumi-only）');
    const handler = findRefreshHandler(captor.bound);
    const openCalls = [];
    Detail.openBangumi = function (sid, name) { openCalls.push({ sid, name }); return Promise.resolve(); };
    await handler({ currentTarget: refreshEl });
    assert.deepEqual(captor.deleted, ['detail::bgminfo::v1::777'], '应清 bangumiInfo 缓存条目');
    assert.equal(openCalls.length, 1, '应重入 openBangumi');
    assert.equal(openCalls[0].sid, '777', '重入应携带原 subjectId');
    await flush(); await flush();
});

test('⑥ 返回栈修复（CatVod）：刷新后 back() 一次回上级视图，栈不叠加', async () => {
    const shown = [];
    const AppStub = { currentView: 'home', showView(v) { this.currentView = v; shown.push(v); } };
    const { Detail } = loadDetail({ App: AppStub });
    Detail.init();
    // 从首页打开详情（非嵌套）：清栈 + backView='home'
    Detail.open('site-a', 'v1', '测试影片');
    await flush(); await flush();
    assert.equal(AppStub.currentView, 'detail', '前置：详情视图已展示');
    assert.equal(Detail.backView, 'home', '前置：backView 指向来源视图 home');
    assert.equal(Detail._backStack.length, 0, '前置：非嵌套打开栈为空');
    // 刷新：本页原地更新，不得产生新栈条目
    await Detail._refreshDetail();
    await flush(); await flush();
    assert.equal(Detail._backStack.length, 0, '刷新不得往返回栈压条目');
    // 一次 back() 即回上级 home（修复前：无栈时同样回 home，但 Bangumi 路径会叠加；
    // CatVod 路径此处验证 backView 未被刷新破坏）
    await Detail.back();
    assert.equal(AppStub.currentView, 'home', '刷新后一次返回应回上级视图 home');
    assert.equal(shown[shown.length - 1], 'home', 'showView 末次调用应为 home');
});

test('⑥ 返回栈修复（Bangumi-only）：刷新重入 openBangumi 不压栈，back() 一次回上级', async () => {
    const Kazumi = {
        getBangumiMatch: async () => null,
        bangumiInfo: async (id) => ({ id: Number(id), name: 'b', name_cn: 'c', images: {} }),
        bangumiEpisodes: async () => null,
        _applyBangumiColState: async () => {},
    };
    const shown = [];
    const AppStub = { currentView: 'home', showView(v) { this.currentView = v; shown.push(v); } };
    const { Detail } = loadDetail({ extra: { Kazumi }, App: AppStub });
    Detail.init();
    // 从时间表打开 Bangumi-only 详情
    await Detail.openBangumi('777', '测试番剧');
    await flush();
    assert.equal(AppStub.currentView, 'detail', '前置：详情视图已展示');
    assert.equal(Detail.backView, 'home', '前置：backView 指向来源视图 home');
    assert.equal(Detail._backStack.length, 0, '前置：非嵌套打开栈为空');
    // 刷新：重入 openBangumi——修复前 App.currentView==='detail' 被误判为嵌套跳转，
    // 把当前页快照压进栈，返回时恢复的是同一部影片的旧快照（永远回不到上级）
    await Detail._refreshDetail();
    await flush(); await flush();
    assert.equal(Detail._backStack.length, 0, '刷新重入 openBangumi 不得压栈');
    // 一次 back() 直达上级 home，不经过「恢复刷新前快照」的假返回
    await Detail.back();
    assert.equal(AppStub.currentView, 'home', '刷新后一次返回应回上级视图 home');
    assert.equal(Detail._backStack.length, 0, '返回后栈应为空');
});

test('⑥ 返回栈修复（Bangumi-only）：嵌套跳转压栈行为不受刷新守卫影响', async () => {
    const Kazumi = {
        getBangumiMatch: async () => null,
        bangumiInfo: async (id) => ({ id: Number(id), name: 'b', name_cn: 'c', images: {} }),
        bangumiEpisodes: async () => null,
        _applyBangumiColState: async () => {},
    };
    const shown = [];
    const AppStub = { currentView: 'home', showView(v) { this.currentView = v; shown.push(v); } };
    const { Detail } = loadDetail({ extra: { Kazumi }, App: AppStub });
    Detail.init();
    // 第一部：home → detail（栈空）
    await Detail.openBangumi('777', '第一部');
    await flush();
    // 嵌套：详情页内点关联打开第二部（非刷新路径）→ 压栈第一部快照
    await Detail.openBangumi('888', '第二部');
    await flush();
    assert.equal(Detail._backStack.length, 1, '嵌套跳转应压栈（守卫只拦刷新路径）');
    // 返回：恢复第一部
    await Detail.back();
    await flush();
    assert.equal(Detail._bgmId, '777', '返回应恢复上一详情页（嵌套语义不变）');
    assert.equal(AppStub.currentView, 'detail', '嵌套返回停留在详情视图');
    // 再返回：栈空，回上级 home
    await Detail.back();
    assert.equal(AppStub.currentView, 'home', '栈空后返回回上级视图');
});

test('⑥ 刷新在途的嵌套跳转仍正常压栈（_reloadInProgress 不跨 await 存活）', async () => {
    const { Detail } = loadDetail();
    Detail.init();
    Detail.site = 'site-a';
    Detail.vodId = 'v1';
    Detail.vodName = '测试影片';
    // 模拟刷新重入的同步段已结束（_refreshDetail 的 finally 已复位标志）
    await Detail._refreshDetail();
    await flush();
    assert.equal(Detail._reloadInProgress, false, '刷新重入同步段结束后标志应复位');
    // 此后用户点关联卡片（详情视图内嵌套跳转）：压栈正常发生
    Detail.open('site-b', 'v2', '另一部');
    assert.equal(Detail._backStack.length, 1, '刷新完成后的嵌套跳转仍应压栈');
});
