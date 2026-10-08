'use strict';
/**
 * 全局番剧屏蔽（common.js 屏蔽引擎）白盒单元测试。
 *
 * 覆盖对象：normalizeBlockText / normalizeBlockWords / loadBlockWords /
 * blockWordsEnabled / isTitleBlocked / filterBlocked / invalidateBlockWords /
 * onBlockWordsChange。
 *
 * 手法：与 tests/js/common-utils.test.js 同款 —— fs.readFileSync + node:vm 加载
 * common.js，注入最小全局桩；settings 读取走注入的 window.yuki.settingsGet，
 * 因此「屏蔽词从哪来」「读写失败怎么降级」都能在单测里精确驱动。
 *
 * 互补边界：渲染层各页（home/search/timeline/popular/bangumi-search/records）
 * 的接线由各自的页面测试覆盖，本文件只管引擎本身的匹配与生命周期语义。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '../../src/renderer/js/common.js');

/** 极简 jQuery 桩：引擎不碰 DOM，仅源码顶层可能引用 $，给个无副作用的空壳。 */
function makeJq() {
    const api = {
        length: 0,
        on() { return api; }, off() { return api; }, find() { return api; },
        each() { return api; }, children() { return api; }, html() { return api; },
        text() { return api; }, empty() { return api; }, addClass() { return api; },
        removeClass() { return api; }, data() { return ''; },
    };
    return api;
}

/**
 * 在 VM 中加载 common.js。
 * @param {Object} opts settings：settingsGet 返回的假设置；不传则为空对象
 */
function loadEngine(opts = {}) {
    const source = fs.readFileSync(SRC, 'utf8');
    const settings = opts.settings || {};
    const calls = { set: [], get: 0 };
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, RegExp, Number,
        parseInt, parseFloat, setTimeout, clearTimeout,
        crypto: globalThis.crypto,
        $: () => makeJq(),
        document: { addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
        window: {
            yuki: {
                settingsGet: async () => { calls.get += 1; return { ...settings }; },
                settingsSet: async (k, v) => { calls.set.push([k, v]); return v; },
            },
        },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    };
    context.globalThis = context;
    if (opts.before) opts.before(context);
    vm.createContext(context);
    vm.runInContext(`${source}
;globalThis.__api = {
    normalizeBlockText, normalizeBlockWords, loadBlockWords, invalidateBlockWords,
    onBlockWordsChange, blockWordsEnabled, getBlockWords, isTitleBlocked, filterBlocked,
    BLOCK_WORDS_KEY,
};`, context, { filename: 'common.js' });
    context.__calls = calls;
    context.__setSettings = (next) => { Object.keys(settings).forEach((k) => delete settings[k]); Object.assign(settings, next); };
    return context;
}

const A = (ctx) => ctx.__api;

// ---------------------------------------------------------------- normalizeBlockText（归一化）

test('normalizeBlockText：全角/大小写/空白与常见标点差异被折叠', () => {
    const { normalizeBlockText } = A(loadEngine());
    // 全角转半角 + 大小写折叠
    assert.equal(normalizeBlockText('ＭＹ ＨＥＲＯ'), 'myhero');
    assert.equal(normalizeBlockText('My Hero'), 'myhero');
    // 空白（含全角空格）与标点一律去掉，两侧归一后相同即可互相命中
    assert.equal(normalizeBlockText('我的英雄学院 第4季'), normalizeBlockText('我的英雄学院第4季'));
    assert.equal(normalizeBlockText('我的英雄学院：两位英雄'), normalizeBlockText('我的英雄学院:两位英雄'));
    assert.equal(normalizeBlockText('A-B_C'), normalizeBlockText('abc'));
});

test('normalizeBlockText：空值与纯符号归一后为空（不参与匹配）', () => {
    const { normalizeBlockText } = A(loadEngine());
    assert.equal(normalizeBlockText(''), '');
    assert.equal(normalizeBlockText(null), '');
    assert.equal(normalizeBlockText(undefined), '');
    assert.equal(normalizeBlockText('！！！'), '');
    assert.equal(normalizeBlockText('   '), '');
});

test('normalizeBlockText：非字符串输入不抛错（源数据脏字段防御）', () => {
    const { normalizeBlockText } = A(loadEngine());
    assert.doesNotThrow(() => normalizeBlockText(123));
    assert.doesNotThrow(() => normalizeBlockText({}));
    assert.equal(normalizeBlockText(123), '123');
});

// ---------------------------------------------------------------- normalizeBlockWords（词表整理）

test('normalizeBlockWords：去重按归一后判定，保留首次书写形态', () => {
    const { normalizeBlockWords } = A(loadEngine());
    // 大小写/全角/空格差异视为同一词，保留用户首次输入的形态用于展示
    assert.deepEqual(
        Array.from(normalizeBlockWords(['刀使巫女', '刀使 巫女', ' 刀使巫女 '])),
        ['刀使巫女'],
    );
    assert.deepEqual(Array.from(normalizeBlockWords(['ＡＢＣ', 'abc'])), ['ＡＢＣ']);
    // 简繁不互通（NFKC 不做简繁转换）：两个词都保留，避免误伤
    assert.equal(Array.from(normalizeBlockWords(['进击的巨人', '進擊的巨人'])).length, 2);
});

test('normalizeBlockWords：丢弃空串与纯符号词，非数组输入返回空表', () => {
    const { normalizeBlockWords } = A(loadEngine());
    assert.deepEqual(Array.from(normalizeBlockWords(['', '   ', '！！！', '刀使巫女'])), ['刀使巫女']);
    assert.deepEqual(Array.from(normalizeBlockWords(null)), []);
    assert.deepEqual(Array.from(normalizeBlockWords('不是数组')), []);
});

// ---------------------------------------------------------------- 引擎生命周期

test('loadBlockWords：首读穿透 settingsGet 并缓存；未显式关闭时开关默认开', async () => {
    const ctx = loadEngine({ settings: { blockWords: ['我的英雄学院'] } });
    const api = A(ctx);
    assert.equal(api.blockWordsEnabled(), false); // 未载入：词表为空，判定不生效
    const r = await api.loadBlockWords();
    assert.equal(r.on, true);
    assert.deepEqual(Array.from(r.words), ['我的英雄学院']);
    assert.equal(ctx.__calls.get, 1);
    await api.loadBlockWords();
    assert.equal(ctx.__calls.get, 1); // 已在内存：不重复穿透
    assert.equal(api.blockWordsEnabled(), true);
    assert.deepEqual(Array.from(api.getBlockWords()), ['我的英雄学院']);
});

test('loadBlockWords：blockWordsEnable=false 时整体停用（词表仍在）', async () => {
    const ctx = loadEngine({ settings: { blockWords: ['我的英雄学院'], blockWordsEnable: false } });
    const api = A(ctx);
    await api.loadBlockWords();
    assert.equal(api.blockWordsEnabled(), false);
    assert.deepEqual(Array.from(api.getBlockWords()), ['我的英雄学院']); // 词保留，仅停用
    assert.equal(api.isTitleBlocked('我的英雄学院 第4季'), false);
});

test('loadBlockWords：settings 读取失败按「未启用」降级，不抛错', async () => {
    const ctx = loadEngine({ settings: {} });
    ctx.window.yuki.settingsGet = async () => { throw new Error('IPC down'); };
    const api = A(ctx);
    const r = await api.loadBlockWords();
    assert.equal(r.on, true);
    assert.deepEqual(Array.from(r.words), []);
    assert.equal(api.blockWordsEnabled(), false); // 读失败不应把整个列表清空
});

test('invalidateBlockWords：置脏后重新穿透，并广播订阅者', async () => {
    const ctx = loadEngine({ settings: { blockWords: ['我的英雄学院'] } });
    const api = A(ctx);
    await api.loadBlockWords();
    let hits = 0;
    const off = api.onBlockWordsChange(() => { hits += 1; });
    ctx.__setSettings({ blockWords: ['我的英雄学院', '进击的巨人'] });
    api.invalidateBlockWords();
    assert.equal(hits, 1); // 订阅者收到一次变更通知
    const r = await api.loadBlockWords();
    // 跨 VM realm 的数组与宿主 Array.prototype 不同源，逐项比较而非 deepStrictEqual
    assert.deepEqual(Array.from(r.words), ['我的英雄学院', '进击的巨人']);
    assert.equal(ctx.__calls.get, 2); // 置脏后确实重新读了一次
    // 退订后不再收到通知
    off();
    api.invalidateBlockWords();
    assert.equal(hits, 1);
});

test('invalidateBlockWords(false)：只置脏不广播（初始化路径用）', async () => {
    const ctx = loadEngine({ settings: { blockWords: ['A'] } });
    const api = A(ctx);
    await api.loadBlockWords();
    let hits = 0;
    api.onBlockWordsChange(() => { hits += 1; });
    api.invalidateBlockWords(false);
    assert.equal(hits, 0);
});

test('onBlockWordsChange：单个订阅者抛错不影响其余订阅者', async () => {
    const ctx = loadEngine({ settings: { blockWords: ['A'] } });
    const api = A(ctx);
    await api.loadBlockWords();
    let ok = 0;
    api.onBlockWordsChange(() => { throw new Error('boom'); });
    api.onBlockWordsChange(() => { ok += 1; });
    assert.doesNotThrow(() => api.invalidateBlockWords());
    assert.equal(ok, 1);
});

// ---------------------------------------------------------------- isTitleBlocked（匹配语义）

test('isTitleBlocked：包含语义命中，且忽略大小写/空格/标点差异', async () => {
    const ctx = loadEngine({ settings: { blockWords: ['我的英雄学院'] } });
    const api = A(ctx);
    await api.loadBlockWords();
    assert.equal(api.isTitleBlocked('我的英雄学院'), true);
    assert.equal(api.isTitleBlocked('我的英雄学院 第4季'), true);
    assert.equal(api.isTitleBlocked('【2024】我的英雄学院：两位英雄'), true);
    assert.equal(api.isTitleBlocked('我的英雄学院'), true);
    // 未命中
    assert.equal(api.isTitleBlocked('我的青春恋爱物语果然有问题'), false);
    assert.equal(api.isTitleBlocked(''), false); // 空标题不参与屏蔽
});

test('isTitleBlocked：词表为空或未载入时恒 false（零开销快路径）', async () => {
    const ctx = loadEngine({ settings: { blockWords: [] } });
    const api = A(ctx);
    await api.loadBlockWords();
    assert.equal(api.isTitleBlocked('我的英雄学院'), false);
});

// ---------------------------------------------------------------- filterBlocked（列表过滤）

test('filterBlocked：默认字段口径（vod_name/name/name_cn）与自定义取值器', async () => {
    const ctx = loadEngine({ settings: { blockWords: ['我的英雄学院'] } });
    const api = A(ctx);
    await api.loadBlockWords();
    // CatVod 口径 vod_name
    const catvod = [{ vod_name: '我的英雄学院' }, { vod_name: '刀使巫女' }];
    assert.deepEqual(Array.from(api.filterBlocked(catvod)).map((x) => x.vod_name), ['刀使巫女']);
    // Bangumi 口径 name_cn / name
    const bgm = [{ name_cn: '我的英雄学院' }, { name: '进击的巨人' }];
    assert.deepEqual(api.filterBlocked(bgm).length, 1);
    // 搜索 Kazumi 结果口径 name
    assert.equal(api.filterBlocked([{ name: '我的英雄学院 第4季' }]).length, 0);
    // 自定义取值器
    assert.equal(api.filterBlocked([{ title: '我的英雄学院' }], (x) => x.title).length, 0);
});

test('filterBlocked：非数组原样返回；无屏蔽词时不复制数组（零开销）', async () => {
    const ctx = loadEngine({ settings: { blockWords: [] } });
    const api = A(ctx);
    await api.loadBlockWords();
    const list = [{ vod_name: 'A' }];
    assert.equal(api.filterBlocked(list), list); // 同一引用：未启用时不做任何拷贝
    assert.equal(api.filterBlocked(null), null);
});

test('filterBlocked：命中全部时返回空数组（整组可被判定为「无结果」）', async () => {
    const ctx = loadEngine({ settings: { blockWords: ['我的英雄学院'] } });
    const api = A(ctx);
    await api.loadBlockWords();
    assert.deepEqual(Array.from(api.filterBlocked([{ vod_name: '我的英雄学院 1' }, { vod_name: '我的英雄学院 2' }])), []);
});

test('filterBlocked：过滤结果不改动原数组（原始数据保留，删词后可恢复）', async () => {
    const ctx = loadEngine({ settings: { blockWords: ['我的英雄学院'] } });
    const api = A(ctx);
    await api.loadBlockWords();
    const list = [{ vod_name: '我的英雄学院' }, { vod_name: '刀使巫女' }];
    api.filterBlocked(list);
    assert.equal(list.length, 2); // 屏蔽只影响展示，不删数据
});
