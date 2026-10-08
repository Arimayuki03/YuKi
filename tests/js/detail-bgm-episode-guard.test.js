'use strict';
// A11 回归防线：BGM 分集加载世代守卫（审查2.3）、_applyEpHighlight 迟到回调守卫
// （审查3.8a）、_loadBgmExtra 部分失败缓存 failed 标记 + 命中重拉（审查3.8b）。
//
// 覆盖：
//  ① 同世代双飞竞态：载入中重入 _renderBgmEpisodes，慢 reject 不得覆盖先到的成功网格
//  ② reject 且节点脱附文档（isConnected=false）→ 不写不可见节点
//  ③ 同世代 reject 且节点在文档 → 正常渲染错误态+重试（回归保护）
//  ④ 迟到 _applyEpHighlight 回调：site/vodId 变化后不写 _epHiCache、不高亮
//  ⑤ 同影片迟到回调正常高亮（回归保护）
//  ⑥ 部分失败落缓存带 failed 路列表；命中含失败路条目 → 秒回 + 后台重拉覆盖（恢复闭环）
//  ⑦ 旧格式缓存（无 failed 字段）/ 全成功条目命中 → 不触发重拉（回归保护）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** VM 沙箱内对象字面量带 VM realm 原型，deepStrictEqual 会因原型不同误判：经 JSON 往返转宿主 realm 纯数据。 */
const plain = (x) => JSON.parse(JSON.stringify(x));
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 内存版 localStorage 桩（对齐 bgm-eps-cache.test.js）。 */
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

/**
 * 可查询 jQuery 桩（对齐 ep-highlight.test.js 元素注册表 + bgm 容器 isConnected 开关）：
 *  - '#bgm-ep-list' 返回带 [0] 原生伪节点（isConnected 动态读 captor.bgmBoxConnected）；
 *  - '.ep-btn[data-idx="N"]' 按 ep 注册表命中（高亮路径 addClass/removeClass 写回注册表）；
 *  - 其余选择器返回通用无关节点（html() 捕获到 captor.htmlBySel）。
 */
function makeJq(captor) {
    const epRegistry = new Map(); // '0' -> { classes:Set, attrs:Map, name, getAttribute }
    captor.epRegistry = epRegistry; // 测试断言通过 captor.epRegistry 读高亮状态
    function makeNode(sel, el) {
        const node = {
            sel: String(sel),
            length: el ? 1 : (String(sel).includes('.ep-btn[data-idx') ? 0 : 1),
            on(ev, a, b) {
                const fn = typeof b === 'function' ? b : a;
                if (captor && typeof fn === 'function') captor.bound.push({ sel: String(sel), ev, fn });
                return node;
            },
            off() { return node; },
            html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), String(s)); return node; },
            text() { return node; },
            append() { return node; },
            find() { return makeNode(String(sel) + ' *'); },
            each() { return node; },
            addClass(c) { if (el) el.classes.add(String(c)); return node; },
            removeClass(c) { if (el) el.classes.delete(String(c)); return node; },
            toggleClass() { return node; },
            attr(k, v) { if (v !== undefined && el) el.attrs.set(String(k), String(v)); return node; },
            prop() { return node; },
            data() { return node; },
            children() { return Object.assign(makeNode(String(sel) + ' > *'), { length: 0 }); },
            first() { return node; },
            not() { return node; },
            is() { return false; },
            hide() { return node; },
            show() { return node; },
            css() { return node; },
            closest() { return makeNode(String(sel) + ' ^'); },
            remove() { return node; },
        };
        return node;
    }
    return (sel) => {
        if (sel === '#bgm-ep-list') {
            const node = makeNode(sel);
            // isConnected 判定入口：box[0] 动态读开关（setBgmBoxConnected 切换）
            node[0] = { get isConnected() { return captor.bgmBoxConnected; } };
            return node;
        }
        if (sel && typeof sel === 'object') return makeNode('obj');
        const m = /^#ep-list \.ep-btn\[data-idx="(\d+)"\]$/.exec(String(sel));
        const el = m ? epRegistry.get(m[1]) : null;
        return makeNode(sel, el);
    };
}

/** 在 VM 中加载 detail.js（cache.js 真实现 + Kazumi/Records 行为由 extra 注入）。 */
function loadDetail(extra) {
    const captor = { bound: [], htmlBySel: new Map(), bgmBoxConnected: true };
    const warns = [];
    const ls = makeLs();
    const context = {
        console: { warn: (...a) => warns.push(a.map(String).join(' ')), log: () => {}, error: () => {}, info: () => {} },
        Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, Boolean,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout, URL, Error, RegExp,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: () => null,
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: makeJq(captor),
        registerEsc: () => {},
        staggerEnter: () => {},
        replayClass: () => {},
        escHtml: (s) => String(s),
        stripHtml: (s) => String(s || ''),
        warnToast: () => {},
        showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: () => '<img src="cover.jpg">',
        normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        doAction: async () => ({ list: [] }),
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) }, localStorage: ls },
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    // 先加载 cache.js（root 取 window，localCacheGet/Set/Del 挂 window；真实现持久化到 ls）
    vm.runInContext(read('src/renderer/js/cache.js'), context, { filename: 'cache.js' });
    // 提为 context 顶层全局，供 detail.js 以裸标识符 typeof localCacheGet 访问
    context.localCacheGet = context.window.localCacheGet;
    context.localCacheSet = context.window.localCacheSet;
    context.localCacheDel = context.window.localCacheDel;
    vm.runInContext(`${read('src/renderer/js/detail.js')}\n;globalThis.__Detail = Detail;`, context, { filename: 'detail.js' });
    return { Detail: context.__Detail, captor, ls, warns, context, epRegistry: captor.epRegistry };
}

/** 在 ep 注册表铺 3 集按钮 + 组装 CatVod 详情状态（对齐 ep-highlight.test.js setup 口径）。 */
function setupEpGrid(D, epRegistry) {
    D.site = 'site-a';
    D.vodId = 'v1';
    D.vodName = '测试影片';
    D.sources = [{ from: '线路A', episodes: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }, { name: '第3集', url: 'u3' }] }];
    D.activeSource = 0;
    D._epDesc = false;
    D._epHiCache = undefined;
    ['第1集', '第2集', '第3集'].forEach((name, i) => {
        epRegistry.set(String(i), {
            __key: String(i),
            attrs: new Map([['data-idx', String(i)], ['title', name]]),
            classes: new Set(['ep-btn']),
            name,
            getAttribute: (k) => (k === 'data-idx' ? String(i) : null),
        });
    });
    D.renderEpisodes();
}

// ================================================================ 审查2.3：分集世代守卫

test('2.3①：载入中重入 _renderBgmEpisodes（切正序重入）→ 慢 reject 不覆盖先到的成功网格', async () => {
    let failFirst, okSecond;
    const slowErr = new Error('slow req down');
    let firstCall = true;
    const { Detail, captor } = loadDetail({
        Kazumi: {
            bangumiEpisodes: () => {
                if (firstCall) { firstCall = false; return new Promise((res, rej) => { failFirst = () => rej(slowErr); }); }
                return new Promise((res) => { okSecond = () => res({ data: [{ id: 1, type: 0, sort: 1, name: '第1话' }] }); });
            },
        },
    });
    Detail._bgmId = '42';
    const p1 = Detail._renderBgmEpisodes(); // gen=1：慢请求挂起（不 await）
    Detail._bgmEpDesc = true;
    const p2 = Detail._renderBgmEpisodes(); // gen=2：重入（模拟「切正序」）
    okSecond();
    await p2;
    assert.ok(String(captor.htmlBySel.get('#bgm-ep-list') || '').includes('bgm-ep-item'), '重入请求成功 → 网格已渲染');
    failFirst(); // 慢请求（旧世代）此刻才 reject
    await p1;
    const html = String(captor.htmlBySel.get('#bgm-ep-list') || '');
    assert.ok(!html.includes('分集载入失败'), '旧世代 reject 不得覆盖先到的成功网格');
    assert.ok(html.includes('bgm-ep-item'), '成功网格保持原样');
});

test('2.3②：reject 且 #bgm-ep-list 已脱附文档（isConnected=false）→ 不渲染错误态', async () => {
    let releaseFail;
    const { Detail, captor } = loadDetail({
        Kazumi: {
            bangumiEpisodes: () => new Promise((res, rej) => { releaseFail = () => rej(new Error('down')); }),
        },
    });
    Detail._bgmId = '42';
    const p = Detail._renderBgmEpisodes();
    captor.bgmBoxConnected = false; // 跨片切换：节点随 render 重建脱附
    releaseFail();
    await p; await flush();
    const html = String(captor.htmlBySel.get('#bgm-ep-list') || '');
    assert.ok(!html.includes('分集载入失败'), '脱附节点不写错误态');
});

test('2.3③：同世代 reject 且节点在文档 → 正常渲染错误态+重试（回归保护：守卫不误杀）', async () => {
    let releaseFail;
    const { Detail, captor } = loadDetail({
        Kazumi: {
            bangumiEpisodes: () => new Promise((res, rej) => { releaseFail = () => rej(new Error('down')); }),
        },
    });
    Detail._bgmId = '42';
    const p = Detail._renderBgmEpisodes();
    releaseFail();
    await p; await flush();
    const html = String(captor.htmlBySel.get('#bgm-ep-list') || '');
    assert.ok(html.includes('分集载入失败') && html.includes('bgm-ep-retry'), '当前世代失败仍应渲染错误态+重试按钮');
});

// ================================================================ 审查3.8a：迟到高亮回调守卫

test('3.8a①：迟到 _applyEpHighlight 回调（await 期间 site/vodId 已变）→ 不写缓存不高亮新影片', async () => {
    let release;
    const wpCalls = [];
    const { Detail, captor } = loadDetail({
        Records: {
            getWatchProgress: (site, vodId) => new Promise((res) => {
                wpCalls.push({ site, vodId });
                release = () => res({ currentEp: 2, totalEps: 3, percent: 66, ts: 1 });
            }),
        },
    });
    setupEpGrid(Detail, captor.epRegistry);
    await flush(); // renderEpisodes → _applyEpHighlight：getWatchProgress 已调用并挂起
    assert.equal(wpCalls.length, 1);
    assert.equal(Detail._epHiCache, undefined, '响应未到：缓存尚未写入');
    Detail.site = 'site-b'; Detail.vodId = 'v2'; // await 期间切到别的影片
    release();
    await flush(); await flush();
    assert.equal(Detail._epHiCache, undefined, '迟到回调不得写入新影片的 _epHiCache');
    for (const [, el] of captor.epRegistry) {
        assert.ok(!el.classes.has('ep-hi'), '迟到回调不得高亮任何集按钮');
    }
});

test('3.8a②：同影片迟到回调正常高亮（回归保护：守卫不误杀正常路径）', async () => {
    let release;
    const { Detail, captor } = loadDetail({
        Records: {
            getWatchProgress: () => new Promise((res) => { release = () => res({ currentEp: 2, totalEps: 3, percent: 66, ts: 1 }); }),
        },
    });
    setupEpGrid(Detail, captor.epRegistry);
    await flush();
    release();
    await flush(); await flush();
    assert.equal(Detail._epHiCache && Detail._epHiCache.key, 'site-a|v1', '同影片回调正常写缓存');
    assert.ok(captor.epRegistry.get('1').classes.has('ep-hi'), '第 2 集正常高亮');
});

// ================================================================ 审查3.8b：部分失败缓存 + 命中重拉

const CACHE_PREFIX = 'detail::bgmextra::v1::';

test('3.8b①：角色成功、制作失败 → 落缓存条目带 failed:["staff"]，本次失败态照实记录', async () => {
    const netErr = new Error('staff down');
    const CHARS = [{ id: 7, name: '甲', name_cn: '甲先生', relation: '主角', images: {}, actors: [{ name: '声优A' }] }];
    const { Detail, ls, warns } = loadDetail({
        Kazumi: {
            bangumiComments: async () => ({ list: [], total: 0 }),
            bangumiCharacters: async () => CHARS,
            bangumiStaff: async () => { throw netErr; },
            bangumiRelations: async () => [],
        },
    });
    Detail._bgmId = '42';
    Detail._bgmInfo = { id: 42, name: '番剧' };
    Detail._activeTab = '角色';
    await Detail._loadBgmExtra(); await flush(); await flush();
    assert.ok(!warns.some((w) => w.includes('_loadBgmExtra 整体异常')), '渲染链路不应有整体异常（桩齐全）');
    assert.deepEqual(plain(Detail._bgmExtraFailed), { comments: false, characters: false, staff: true, relations: false }, '仅制作路失败');
    // 大池/小池两前缀都探测（_detailCacheSet 走 big 池）
    const raw = ls.getItem('yuki_bigcache::' + CACHE_PREFIX + '42') || ls.getItem('yuki_cache::' + CACHE_PREFIX + '42');
    assert.ok(raw, '部分失败也落盘（秒回语义）');
    const entry = JSON.parse(raw);
    assert.deepEqual(entry.v.failed, ['staff'], '失败路列表随包落盘');
    assert.equal(entry.v.characters.length, 1, '成功路数据在缓存中');
});

test('3.8b②：命中含失败路条目 → 秒回缓存数据 + 后台重拉真实走网络并覆盖缓存清空 failed', async () => {
    const netErr = new Error('staff down');
    let staffCalls = 0;
    let recovered = false;
    const CHARS = [{ id: 7, name: '甲', name_cn: '甲先生', relation: '主角', images: {}, actors: [] }];
    const { Detail, ls } = loadDetail({
        Kazumi: {
            bangumiComments: async () => ({ list: [], total: 0 }),
            bangumiCharacters: async () => CHARS,
            bangumiStaff: async () => { staffCalls++; if (recovered) return [{ name: '制作A' }]; throw netErr; },
            bangumiRelations: async () => [],
        },
    });
    Detail._bgmId = '42';
    Detail._bgmInfo = { id: 42, name: '番剧' };
    Detail._activeTab = '角色';
    // 第一次：部分失败落缓存
    await Detail._loadBgmExtra(); await flush(); await flush();
    assert.equal(staffCalls, 1);
    assert.deepEqual(JSON.parse(ls.getItem('yuki_bigcache::' + CACHE_PREFIX + '42') || ls.getItem('yuki_cache::' + CACHE_PREFIX + '42')).v.failed, ['staff']);
    // 第二次（重开详情/点重试后的加载）：命中含失败路缓存 → 秒回 + 后台重拉
    recovered = true;
    await Detail._loadBgmExtra(); // 命中分支先按缓存秒回
    assert.equal(Detail._characters.length, 1, '缓存角色秒回上屏');
    await flush(); await flush(); await flush(); // 后台重拉（重入 _loadBgmExtra → 网络）
    assert.ok(staffCalls >= 2, '命中含失败路条目必须后台重拉（重试不再被投毒缓存短路）');
    const after = JSON.parse(ls.getItem('yuki_bigcache::' + CACHE_PREFIX + '42') || ls.getItem('yuki_cache::' + CACHE_PREFIX + '42'));
    assert.deepEqual(after.v.failed, [], '重拉成功后 failed 清空（恢复闭环）');
    assert.equal(after.v.staff.length, 1, '重拉数据覆盖缓存');
    assert.deepEqual(plain(Detail._bgmExtraFailed), { comments: false, characters: false, staff: false, relations: false }, '重拉成功后失败态全复位');
});

test('3.8b③：命中旧格式缓存（无 failed 字段）或全成功条目 → 不触发后台重拉（回归保护：正常秒开零网络）', async () => {
    const charsCalls = { n: 0 };
    const { Detail, ls } = loadDetail({
        Kazumi: {
            bangumiComments: async () => ({ list: [], total: 0 }),
            bangumiCharacters: async () => { charsCalls.n++; return []; },
            bangumiStaff: async () => [],
            bangumiRelations: async () => [],
        },
    });
    Detail._bgmId = '42';
    Detail._bgmInfo = { id: 42, name: '番剧' };
    Detail._activeTab = '角色';
    // 预置旧格式缓存条目（无 failed 字段；载荷形态对齐 cache.js {v,e,t}）
    const payload = { v: { comments: [], characters: [{ id: 9, name: '乙', name_cn: '乙小姐', relation: '主角', images: {}, actors: [] }], staff: [], relations: [], commentTotal: 0 }, e: Date.now() + 30 * 60 * 1000, t: Date.now() };
    ls.setItem('yuki_bigcache::' + CACHE_PREFIX + '42', JSON.stringify(payload));
    await Detail._loadBgmExtra();
    assert.equal(Detail._characters.length, 1, '旧格式缓存照常秒回');
    await flush(); await flush(); await flush();
    assert.equal(charsCalls.n, 0, '无失败标记的缓存命中不触发后台重拉');
});
