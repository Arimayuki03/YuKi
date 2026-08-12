'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

// 加载 kazumi.js 到隔离 VM，注入上传批量函数所需的全局桩：
// recGet/recSet（收藏读写）、doAction（后端调用）、warnToast、window.vpc.settingsGet。
function loadKazumi(extra = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/kazumi.js'), 'utf8');
    const jqueryStub = () => ({
        on() { return this; },
        off() { return this; },
        val() { return ''; },
        text() { return this; },
        html() { return this; },
        show() { return this; },
        hide() { return this; },
        empty() { return this; },
        append() { return this; },
        prop() { return this; },
        toggle() { return this; },
        length: 1,
    });
    const context = {
        console, Map, Promise, Date, Math, JSON, String, Array, Number,
        parseInt, parseFloat, setTimeout, clearTimeout,
        $: jqueryStub,
        warnToast() {},
        window: { vpc: {} },
        ...extra,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testKazumi = Kazumi;`, context, { filename: 'kazumi.js' });
    return context.__testKazumi;
}

// 构造一个受控 Kazumi：token 固定、收藏表内存化、getBangumiMatch/setBangumiCollection 可编排。
function makeHarness(favorites, opts = {}) {
    let saved = null;
    const setCalls = [];
    const kazumi = loadKazumi({
        recGet: async () => favorites.map((f) => ({ ...f })),
        recSet: async (key, list) => { saved = list; },
        window: { vpc: { settingsGet: async () => ({ bangumiToken: 'tok', bangumiImmediateSyncToastEnable: false }) } },
        doAction: async () => ({ code: 200 }),
    });
    kazumi._getBangumiToken = async () => 'tok';
    // getBangumiMatch：按片名给出匹配 id（opts.match: name -> id，缺省 0 = 匹配不到）
    kazumi.getBangumiMatch = async (name) => ({ id: (opts.match && opts.match[name]) || 0, cover: '' });
    // setBangumiCollection：记录调用，按 opts.fail（subjectId 集合）模拟失败
    kazumi.setBangumiCollection = async (id, type) => {
        setCalls.push({ id, type });
        if (opts.fail && opts.fail.has(Number(id))) return false;
        if (opts.throwOn && opts.throwOn.has(Number(id))) throw new Error('boom');
        return true;
    };
    return { kazumi, setCalls, getSaved: () => saved };
}

test('tag → Bangumi type 映射为 1-5（想看1 看过2 在看3 搁置4 抛弃5）', () => {
    const kazumi = loadKazumi();
    const m = kazumi._favTagToBangumiType;
    // 逐字段比较（对象来自独立 VM realm，原型不同，不能用 deepEqual 严格模式）
    assert.equal(m.want, 1);
    assert.equal(m.seen, 2);
    assert.equal(m.watching, 3);
    assert.equal(m.hold, 4);
    assert.equal(m.dropped, 5);
});

test('uploadFavoritesToBangumi 按 tag set 正确 type 并跳过 bangumi 自身条目', async () => {
    const favorites = [
        { uid: 'a', site: 'kazumi:x', name: '想看番', tag: 'want' },
        { uid: 'b', site: '量子资源', name: '在看番', tag: 'watching' },
        { uid: 'c', site: 'bangumi', name: 'Bangumi 条目', tag: 'seen' }, // 应被过滤
    ];
    const { kazumi, setCalls } = makeHarness(favorites, { match: { 想看番: 101, 在看番: 202 } });
    const r = await kazumi.uploadFavoritesToBangumi();
    assert.equal(r.total, 2);       // bangumi 条目被过滤
    assert.equal(r.uploaded, 2);
    assert.equal(r.skipped, 0);
    assert.equal(r.failed, 0);
    assert.deepEqual(setCalls.sort((x, y) => x.id - y.id), [{ id: 101, type: 1 }, { id: 202, type: 3 }]);
});

test('匹配不到 subject 的条目计入 skipped 且不调用 set', async () => {
    const favorites = [
        { uid: 'a', site: 'kazumi:x', name: '有匹配', tag: 'seen' },
        { uid: 'b', site: 'kazumi:x', name: '无匹配', tag: 'want' },
    ];
    const { kazumi, setCalls } = makeHarness(favorites, { match: { 有匹配: 55 } });
    const r = await kazumi.uploadFavoritesToBangumi();
    assert.equal(r.uploaded, 1);
    assert.equal(r.skipped, 1);
    assert.equal(setCalls.length, 1);
    assert.deepEqual(setCalls[0], { id: 55, type: 2 });
});

test('已有 bangumiId 直接使用，不再调用 getBangumiMatch', async () => {
    const favorites = [{ uid: 'a', site: 'kazumi:x', name: '已匹配番', tag: 'hold', bangumiId: '900' }];
    const { kazumi, setCalls } = makeHarness(favorites, {});
    let matchCalled = false;
    kazumi.getBangumiMatch = async () => { matchCalled = true; return { id: 0 }; };
    const r = await kazumi.uploadFavoritesToBangumi();
    assert.equal(matchCalled, false);
    assert.equal(r.uploaded, 1);
    assert.deepEqual(setCalls[0], { id: 900, type: 4 });
});

test('新解析的 subject id 回写到收藏项 bangumiId', async () => {
    const favorites = [{ uid: 'a', site: 'kazumi:x', name: '回写番', tag: 'want' }];
    const { kazumi, getSaved } = makeHarness(favorites, { match: { 回写番: 777 } });
    await kazumi.uploadFavoritesToBangumi();
    const saved = getSaved();
    assert.ok(Array.isArray(saved));
    const it = saved.find((x) => x.uid === 'a');
    assert.equal(it.bangumiId, '777');
});

test('单条 set 失败与抛错都不中断整批，分别计入 failed', async () => {
    const favorites = [
        { uid: 'a', site: 'kazumi:x', name: 'ok番', tag: 'want' },
        { uid: 'b', site: 'kazumi:x', name: 'fail番', tag: 'want' },
        { uid: 'c', site: 'kazumi:x', name: 'throw番', tag: 'want' },
        { uid: 'd', site: 'kazumi:x', name: 'ok番2', tag: 'seen' },
    ];
    const { kazumi } = makeHarness(favorites, {
        match: { ok番: 1, fail番: 2, throw番: 3, ok番2: 4 },
        fail: new Set([2]),
        throwOn: new Set([3]),
    });
    const r = await kazumi.uploadFavoritesToBangumi();
    assert.equal(r.total, 4);
    assert.equal(r.uploaded, 2);
    assert.equal(r.failed, 2);
    assert.equal(r.skipped, 0);
});

test('无 Token 返回 null（不上传）', async () => {
    const kazumi = loadKazumi({
        recGet: async () => [],
        recSet: async () => {},
        window: { vpc: { settingsGet: async () => ({}) } },
        doAction: async () => ({ code: 200 }),
    });
    kazumi._getBangumiToken = async () => '';
    const r = await kazumi.uploadFavoritesToBangumi();
    assert.equal(r, null);
});
