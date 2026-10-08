'use strict';
// A-03 失败态修复回归测试：区分「请求失败」与「真无数据」两条路径。
//
// 缺陷背景：_loadBgmExtra 四路子请求各带 .catch(() => [])，网络失败 resolve 空数组，
// _bgmExtraLoaded 无条件置真——断网时页签误显「暂无角色信息」等空态文案，
// 且整体 catch 静默吞异常（_detailCacheSet 类错误不可观测）。
//
// 修复口径：
// 1) 全部子请求失败 → 页签渲染错误态 + 重试按钮（id=detail-bgm-extra-retry，
//    点击重入 _retryBgmExtra → _loadBgmExtra），而非「暂无…」；
// 2) 部分成功 → 成功项正常渲染，失败路独立错误态（如角色成功渲染卡片、制作路错误态）；
// 3) 请求成功但列表为空 → 维持「暂无角色信息」（回归保护：不得误显错误态）；
// 4) _loadBgmExtra 整体 catch 不再静默：console.warn 必须被调用。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** VM 沙箱内对象字面量带 VM realm 原型，deepStrictEqual 会因原型不同误判
 *  （对齐 home-detail.test.js 的 plain 口径）：经 JSON 往返转宿主 realm 纯数据。 */
const plain = (x) => JSON.parse(JSON.stringify(x));

/** 最小 jQuery 桩（对齐 detail-start-button.test.js）：html 按选择器捕获 + on 记录监听。 */
function makeJqStub(captor) {
    const makeNode = (sel) => ({
        sel: String(sel),
        length: 1,
        _data: {},
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
        // find(s) 对齐真实 querySelector：后代组合器拼接（全批桩统一口径）；
        // 无参调用无子选择器可用，视为后代通配
        find(s) { return makeNode(s === undefined ? String(sel) + ' *' : String(sel) + ' ' + String(s)); },
        // 空集合形态：_renderComments 增量分支以 children(...).length 判定列表是否在屏，
        // 桩返回空集合走全量渲染分支（box.html 可捕获），不触发 _appendCommentRows DOM 复用
        children() { return Object.assign(makeNode(String(sel) + ' > *'), { length: 0 }); },
        first() { return this; },
        each() { return this; },
        not() { return this; },
        is() { return false; },
        toggle() { return this; },
        hide() { return this; },
        show() { return this; },
        closest() { return makeNode(String(sel) + ' ^'); },
        data(k, v) { if (v !== undefined) this._data[k] = v; return this._data[k]; },
    });
    return (sel) => makeNode(sel);
}

/** 在 VM 中加载 detail.js（最小桩，网络路经 Kazumi 桩注入）。 */
function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const captor = { bound: [], htmlBySel: new Map() };
    const warns = [];
    const context = {
        console: { warn: (...a) => warns.push(a.map(String).join(' ')), log: () => {}, error: () => {}, info: () => {} },
        Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout, URL,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: () => null,
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: makeJqStub(captor),
        registerEsc: () => {},
        // A-11 staggerEnter 后落地于 detail.js（_renderStaff/_renderRelations 网格入场），
        // 本测试 vm 桩不加载 common.js——补最小 no-op 桩，行为断言不受影响
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
        localCacheGet: () => null,
        localCacheSet: () => {},
        localCacheDel: () => {},
        openDialog: () => {},
        closeDialog: () => {},
        doAction: async () => ({ list: [] }),
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, bound: captor.bound, htmlBySel: captor.htmlBySel, warns, context };
}

/** 标准夹具：Bangumi-only 详情（_bgmId 已设）+ 指定页签，返回可断言的渲染捕获。 */
function fixture(extra, tab) {
    const loaded = loadDetail(Object.assign({
        Kazumi: {
            bangumiComments: async () => ({ list: [], total: 0 }),
            bangumiCharacters: async () => [],
            bangumiStaff: async () => [],
            bangumiRelations: async () => [],
            bangumiEpisodes: async () => ({ data: [] }),
            bangumiInfo: async () => ({ id: '42', name: '番剧' }),
        },
    }, extra || {}));
    loaded.Detail._bgmId = '42';
    loaded.Detail._bgmInfo = { id: 42, name: '番剧' };
    loaded.Detail._activeTab = tab || '角色';
    return loaded;
}

// ---------------------------------------------------------------- ① 全部失败 → 错误态 + 重试

test('A-03①：四路子请求全部失败 → 「角色」页签渲染错误态+重试按钮（而非「暂无角色信息」）', async () => {
    const netErr = new Error('net down');
    const calls = { chars: 0 };
    let recovered = false; // 重试前模拟网络恢复
    const { Detail, htmlBySel, bound, warns } = fixture({
        Kazumi: {
            bangumiComments: async () => { if (recovered) return { list: [], total: 0 }; throw netErr; },
            bangumiCharacters: async () => { calls.chars++; if (recovered) return []; throw netErr; },
            bangumiStaff: async () => { if (recovered) return []; throw netErr; },
            bangumiRelations: async () => { if (recovered) return []; throw netErr; },
        },
    });
    Detail._loadBgmExtra();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(Detail._bgmExtraLoaded, true, '失败也置真（本会话已尝试过，防切页签自动重拉）');
    assert.deepEqual(plain(Detail._bgmExtraFailed), { comments: true, characters: true, staff: true, relations: true }, '四路失败态全部记录');
    // 失败路日志可观测（console.warn 带上下文）
    assert.ok(warns.length >= 4, `每路失败应落 warn（实际 ${warns.length} 条）`);
    assert.ok(warns.some((w) => w.includes('bangumiCharacters')), '角色路失败日志应含端点名');
    // 渲染「角色」页签：错误态而非「暂无角色信息」
    Detail._renderTabContent();
    const html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(!html.includes('暂无角色信息'), '断网时不得再伪装成「暂无角色信息」');
    assert.ok(html.includes('角色信息加载失败'), '应渲染错误文案');
    assert.ok(html.includes('id="detail-bgm-extra-retry"'), '应渲染重试按钮');
    assert.ok(html.includes('md-btn md-btn-tonal md-btn-sm'), '重试按钮复用既有 md-btn 样式');
    // 点击重试：重入 _loadBgmExtra（世代自增），网络恢复后正常落数据
    const retry = bound.find((b) => b.sel === '#detail-bgm-extra-retry' && typeof b.fn === 'function');
    assert.ok(retry, '重试按钮应绑定监听');
    recovered = true;
    retry.fn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(calls.chars >= 2, '重试应重新发起角色请求');
    assert.deepEqual(plain(Detail._bgmExtraFailed), { comments: false, characters: false, staff: false, relations: false }, '重试成功后失败态复位');
});

test('A-03①：全部失败 → 「制作」「关联」「吐槽」页签同样渲染错误态+重试按钮', async () => {
    const netErr = new Error('net down');
    for (const tab of ['制作', '关联', '吐槽']) {
        const { Detail, htmlBySel } = fixture({
            Kazumi: {
                bangumiComments: async () => { throw netErr; },
                bangumiCharacters: async () => { throw netErr; },
                bangumiStaff: async () => { throw netErr; },
                bangumiRelations: async () => { throw netErr; },
            },
        }, tab);
        Detail._loadBgmExtra();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        Detail._renderTabContent();
        const html = String(htmlBySel.get('#detail-tab-content') || '');
        assert.ok(html.includes('id="detail-bgm-extra-retry"'), `${tab} 页签应渲染重试按钮`);
        assert.ok(!html.includes('暂无制作人员信息'), `${tab}：不得伪装「暂无制作人员信息」`);
        assert.ok(!html.includes('暂无关联番剧'), `${tab}：不得伪装「暂无关联番剧」`);
        assert.ok(!html.includes('暂无吐槽'), `${tab}：不得伪装「暂无吐槽」`);
    }
});

// ---------------------------------------------------------------- ② 部分成功 → 成功项渲染、失败项错误态

test('A-03②：角色成功、制作失败 → 角色页签正常渲染卡片，「制作」页签单独错误态', async () => {
    const netErr = new Error('staff down');
    const CHARS = [{ id: 7, name: '甲', name_cn: '甲先生', relation: '主角', images: {}, actors: [{ name: '声优A' }] }];
    const { Detail, htmlBySel } = fixture({
        Kazumi: {
            bangumiComments: async () => ({ list: [], total: 0 }),
            bangumiCharacters: async () => CHARS,
            bangumiStaff: async () => { throw netErr; },
            bangumiRelations: async () => [],
        },
    });
    Detail._loadBgmExtra();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(plain(Detail._bgmExtraFailed), { comments: false, characters: false, staff: true, relations: false }, '仅制作路失败');
    // 角色页签：成功项照常渲染（部分成功不算失败）
    Detail._activeTab = '角色';
    Detail._renderTabContent();
    let html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html.includes('detail-char-card') && html.includes('甲先生'), '角色成功项应正常渲染卡片');
    assert.ok(!html.includes('detail-bgm-extra-retry'), '成功页签不应出现重试按钮');
    // 制作页签：失败项单独错误态
    Detail._activeTab = '制作';
    Detail._renderTabContent();
    html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html.includes('制作人员信息加载失败') && html.includes('id="detail-bgm-extra-retry"'), '失败页签应渲染错误态+重试');
    assert.ok(!html.includes('暂无制作人员信息'), '失败页签不得伪装「暂无」');
});

// ---------------------------------------------------------------- ③ 成功但空列表 → 维持「暂无」文案（回归保护）

test('A-03③：请求成功但空列表 → 维持「暂无角色信息」等空态文案（不误显错误态）', async () => {
    const { Detail, htmlBySel } = fixture();
    Detail._loadBgmExtra();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(plain(Detail._bgmExtraFailed), { comments: false, characters: false, staff: false, relations: false }, '成功请求不得记录失败态');
    Detail._renderTabContent();
    const html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html.includes('暂无角色信息'), '真无数据应维持「暂无角色信息」');
    assert.ok(!html.includes('detail-bgm-extra-retry'), '真无数据不应渲染重试按钮');
    // 制作/关联/吐槽同口径
    Detail._activeTab = '制作';
    Detail._renderTabContent();
    assert.ok(String(htmlBySel.get('#detail-tab-content') || '').includes('暂无制作人员信息'));
    Detail._activeTab = '关联';
    Detail._renderTabContent();
    assert.ok(String(htmlBySel.get('#detail-tab-content') || '').includes('暂无关联番剧'));
    Detail._activeTab = '吐槽';
    Detail._renderTabContent();
    assert.ok(String(htmlBySel.get('#detail-tab-content') || '').includes('暂无吐槽'));
});

// ---------------------------------------------------------------- ④ 整体 catch 不再静默 + 重试交互

test('A-03④：_loadBgmExtra 整体异常不再静默（console.warn 落日志）且失败态全记录', async () => {
    const { Detail, warns } = fixture({
        Kazumi: {
            bangumiComments: async () => ({ list: [{ user: { nickname: '甲' }, comment: 'x' }], total: 1 }),
            bangumiCharacters: async () => [],
            bangumiStaff: async () => [],
            bangumiRelations: async () => [],
        },
    });
    // 模拟渲染/落盘阶段抛异常：swapTabContent 链路炸掉 → 整体 catch 兜底
    Detail._isBelowTabsStick = () => { throw new Error('cache boom'); };
    Detail._loadBgmExtra();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(warns.some((w) => w.includes('_loadBgmExtra')), `整体异常应落 warn（实际 ${JSON.stringify(warns)}）`);
    assert.equal(Detail._bgmExtraLoaded, true, '兜底后仍置真（页签显示失败态而非永久「加载中」）');
    assert.deepEqual(plain(Detail._bgmExtraFailed), { comments: true, characters: true, staff: true, relations: true }, '兜底按全失败处理');
});

test('A-03：重试重入 _loadBgmExtra 自增 _bgmExtraGen（旧响应按世代作废，语义与导航一致）', async () => {
    const netErr = new Error('net down');
    const { Detail } = fixture({
        Kazumi: {
            bangumiComments: async () => { throw netErr; },
            bangumiCharacters: async () => { throw netErr; },
            bangumiStaff: async () => { throw netErr; },
            bangumiRelations: async () => { throw netErr; },
        },
    });
    Detail._loadBgmExtra();
    await new Promise((r) => setImmediate(r));
    const genBefore = Detail._bgmExtraGen;
    Detail._retryBgmExtra();
    assert.equal(Detail._bgmExtraGen, genBefore + 1, '重试应自增世代（作废旧在途响应）');
    assert.equal(Detail._bgmExtraLoaded, false, '重试期间 _bgmExtraLoaded 置假（显示「加载中…」）');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(Detail._bgmExtraLoaded, true, '重试完成后恢复已尝试语义');
});
