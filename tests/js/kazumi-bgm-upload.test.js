'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

// 加载 kazumi.js 到隔离 VM，注入上传批量函数所需的全局桩：
// recGet/recSet（收藏读写）、doAction（后端调用）、warnToast、window.yuki.settingsGet。
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
        window: { yuki: {} },
        ...extra,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testKazumi = Kazumi;`, context, { filename: 'kazumi.js' });
    return context.__testKazumi;
}

// 构造一个受控 Kazumi：token 固定、收藏表内存化、getBangumiMatch/setBangumiCollection 可编排。
// 新 pipeline：uploadFavoritesToBangumi → kazumiBangumiSync（merge plan）→ kazumiBangumiSyncApply（concurrent upload）
// opts.settings：settingsGet 的额外字段（如 bangumiSyncPriority / bangumiLastSyncAt）；
// opts.plan：直接指定 kazumiBangumiSync 的 plan（冲突裁决/回退用例用），可为函数 (params) => plan。
function makeHarness(favorites, opts = {}) {
    let state = favorites.map((f) => ({ ...f })); // 模拟 settings 落盘：recSet 后再 recGet 应看到新值
    const setCalls = [];
    let planParams = null;
    const kazumi = loadKazumi({
        recGet: async () => state.map((f) => ({ ...f })),
        recSet: async (key, list) => { state = (list || []).map((f) => ({ ...f })); },
        window: {
            yuki: {
                settingsGet: async () => ({
                    bangumiToken: 'tok', bangumiImmediateSyncToastEnable: false, ...(opts.settings || {}),
                }),
            },
        },
        doAction: async (action, params) => {
            if (action === 'kazumiBangumiSync') {
                planParams = { ...(params || {}) }; // 参数传递断言用
                if (opts.plan !== undefined) {
                    return { code: 200, plan: (typeof opts.plan === 'function') ? opts.plan(params) : opts.plan };
                }
                const localFavs = JSON.parse((params && params.favorites) || '[]');
                const upload = localFavs.filter((f) => !(opts.skip && opts.skip.has(f.subjectId))).map((f) => ({
                    subjectId: f.subjectId, type: f.type,
                }));
                const skipped = localFavs.length - upload.length;
                return { code: 200, plan: { upload, pull: [], conflict: [], skipped } };
            }
            if (action === 'kazumiBangumiSyncApply') {
                const uploads = JSON.parse((params && params.uploads) || '[]');
                let uploaded = 0, failed = 0;
                for (const u of uploads) {
                    setCalls.push({ id: u.subjectId, type: u.type });
                    if (opts.fail && opts.fail.has(Number(u.subjectId))) failed++;
                    else if (opts.throwOn && opts.throwOn.has(Number(u.subjectId))) { failed++; setCalls.pop(); }
                    else uploaded++;
                }
                return { code: 200, result: { uploaded, failed } };
            }
            return { code: 200 };
        },
    });
    kazumi._getBangumiToken = async () => 'tok';
    // getBangumiMatch：按片名给出匹配 id（opts.match: name -> id，缺省 0 = 匹配不到）
    kazumi.getBangumiMatch = async (name) => ({ id: (opts.match && opts.match[name]) || 0, cover: '' });
    kazumi.setBangumiCollection = async (id, type) => { setCalls.push({ id, type }); return true; };
    return {
        kazumi, setCalls,
        getSaved: () => state.map((f) => ({ ...f })),
        getPlanParams: () => planParams,
    };
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
    assert.deepEqual(setCalls.sort((x, y) => Number(x.id) - Number(y.id)), [{ id: '101', type: 1 }, { id: '202', type: 3 }]);
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
    assert.deepEqual(setCalls[0], { id: "55", type: 2 });
});

test('已有 bangumiId 直接使用，不再调用 getBangumiMatch', async () => {
    const favorites = [{ uid: 'a', site: 'kazumi:x', name: '已匹配番', tag: 'hold', bangumiId: '900' }];
    const { kazumi, setCalls } = makeHarness(favorites, {});
    let matchCalled = false;
    kazumi.getBangumiMatch = async () => { matchCalled = true; return { id: 0 }; };
    const r = await kazumi.uploadFavoritesToBangumi();
    assert.equal(matchCalled, false);
    assert.equal(r.uploaded, 1);
    assert.deepEqual(setCalls[0], { id: "900", type: 4 });
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
        window: { yuki: { settingsGet: async () => ({}) } },
        doAction: async () => ({ code: 200 }),
    });
    kazumi._getBangumiToken = async () => '';
    const r = await kazumi.uploadFavoritesToBangumi();
    assert.equal(r, null);
});

// ---------------------------------------------------------------- 同步优先级（T46：最新修改时间优先）

test('同步优先级取值归一化：新值透传 / 旧值 0、1 迁移 / 非法回落 local', () => {
    const kazumi = loadKazumi();
    const n = (v) => kazumi._normalizeSyncPriority(v);
    assert.equal(n('local'), 'local');
    assert.equal(n('remote'), 'remote');
    assert.equal(n('newest'), 'newest');
    assert.equal(n('0'), 'local');      // 旧下拉：'0' = 本地优先
    assert.equal(n('1'), 'remote');     // 旧下拉：'1' = Bangumi 优先（绝不能被回落成 local，语义相反）
    assert.equal(n(' 1 '), 'remote');
    assert.equal(n('NEWEST'), 'newest');
    assert.equal(n('bogus'), 'local');  // 非法值回落 = 改动前的既有行为
    assert.equal(n(''), 'local');
    assert.equal(n(undefined), 'local');
    assert.equal(n(null), 'local');
    assert.equal(n(0), 'local');        // 旧设置可能是 number 类型落盘
    assert.equal(n(1), 'remote');
});

test('uploadFavoritesToBangumi 传设置里的 priority 与 lastSyncAt（不再硬编码 local）', async () => {
    // 收藏项带 ts：本地修改时间要随请求发给后端（newest 裁决依赖它）
    const favorites = [{ uid: 'a', site: 'kazumi:x', name: '番A', tag: 'want', ts: 1759999999123 }];
    // 旧值 '1' → remote
    const h1 = makeHarness(favorites, { match: { 番A: 11 }, settings: { bangumiSyncPriority: '1' } });
    await h1.kazumi.uploadFavoritesToBangumi();
    assert.equal(h1.getPlanParams().priority, 'remote');
    assert.equal(h1.getPlanParams().lastSyncAt, ''); // 无落盘时间 → 空串（不能是 "null"/"undefined"）
    assert.equal(JSON.parse(h1.getPlanParams().favorites)[0].ts, 1759999999123);
    // 新值 newest + 数值 lastSyncAt
    const h2 = makeHarness(favorites, {
        match: { 番A: 11 },
        settings: { bangumiSyncPriority: 'newest', bangumiLastSyncAt: 1750000000000 },
    });
    await h2.kazumi.uploadFavoritesToBangumi();
    assert.equal(h2.getPlanParams().priority, 'newest');
    assert.equal(h2.getPlanParams().lastSyncAt, 1750000000000);
    // ISO 字符串原样透传（后端解析）
    const h3 = makeHarness(favorites, {
        match: { 番A: 11 },
        settings: { bangumiSyncPriority: 'newest', bangumiLastSyncAt: '2026-10-12T13:20:11+08:00' },
    });
    await h3.kazumi.uploadFavoritesToBangumi();
    assert.equal(h3.getPlanParams().lastSyncAt, '2026-10-12T13:20:11+08:00');
    // 设置缺失 → local（与改动前行为一致）
    const h4 = makeHarness(favorites, { match: { 番A: 11 } });
    await h4.kazumi.uploadFavoritesToBangumi();
    assert.equal(h4.getPlanParams().priority, 'local');
});

test('_getLastSyncAt：缺失/非正数当未提供（null），数字与 ISO 字符串透传', async () => {
    const cases = [
        [{}, null],
        [{ bangumiLastSyncAt: 0 }, null],
        [{ bangumiLastSyncAt: -5 }, null],
        [{ bangumiLastSyncAt: 1750000000000 }, 1750000000000],
        [{ bangumiLastSyncAt: '2026-10-12T13:20:11+08:00' }, '2026-10-12T13:20:11+08:00'],
    ];
    for (const [settings, expected] of cases) {
        const kazumi = loadKazumi({ window: { yuki: { settingsGet: async () => settings } } });
        assert.equal(await kazumi._getLastSyncAt(), expected, JSON.stringify(settings));
    }
});

test('远端较新的冲突：写回本地收藏标签并统计 byNewest/remoteOverridden', async () => {
    const favorites = [{ uid: 'a', site: 'kazumi:x', name: '冲突番', tag: 'watching', bangumiId: '20', ts: 1000 }];
    const plan = {
        upload: [], pull: [{ subject_id: 20, type: 2 }], skipped: 1,
        conflict: [{ subjectId: '20', localType: 3, remoteType: 2, resolved: 'remote', resolvedBy: 'newest', name: '冲突番' }],
    };
    const { kazumi, getSaved } = makeHarness(favorites, { plan, settings: { bangumiSyncPriority: 'newest' } });
    const r = await kazumi.uploadFavoritesToBangumi();
    assert.equal(r.uploaded, 0);
    assert.equal(r.conflicts, 1);
    assert.equal(r.byNewest, 1);
    assert.equal(r.remoteOverridden, 1);
    assert.equal(r.priority, 'newest');
    // 远端 type=2（看过）覆盖本地标签（原先 watching = 在看）
    assert.equal(getSaved().find((f) => f.uid === 'a').tag, 'seen');
});

test('按最新时间裁决但本地较新：不动本地标签，也不计入 remoteOverridden', async () => {
    const favorites = [{ uid: 'a', site: 'kazumi:x', name: '本地新', tag: 'watching', bangumiId: '20', ts: 1000 }];
    const plan = {
        upload: [{ subjectId: '20', type: 3 }], pull: [], skipped: 0,
        conflict: [{ subjectId: '20', localType: 3, remoteType: 2, resolved: 'local', resolvedBy: 'newest', name: '本地新' }],
    };
    const { kazumi, getSaved, setCalls } = makeHarness(favorites, { plan, settings: { bangumiSyncPriority: 'newest' } });
    const r = await kazumi.uploadFavoritesToBangumi();
    assert.equal(r.uploaded, 1);
    assert.equal(r.byNewest, 1);
    assert.equal(r.remoteOverridden, 0);
    assert.equal(getSaved().find((f) => f.uid === 'a').tag, 'watching');
    assert.deepEqual(setCalls[0], { id: '20', type: 3 });
});

test('回退裁决（resolvedBy=fallback）不计入最新时间裁决，也不覆盖本地状态', async () => {
    const favorites = [{ uid: 'a', site: 'kazumi:x', name: '缺时间', tag: 'want', bangumiId: '20', ts: 0 }];
    const plan = {
        upload: [{ subjectId: '20', type: 1 }], pull: [], skipped: 0,
        conflict: [{ subjectId: '20', localType: 1, remoteType: 3, resolved: 'local', resolvedBy: 'fallback', name: '缺时间' }],
    };
    const { kazumi, getSaved } = makeHarness(favorites, { plan, settings: { bangumiSyncPriority: 'newest' } });
    const r = await kazumi.uploadFavoritesToBangumi();
    assert.equal(r.conflicts, 1);
    assert.equal(r.byNewest, 0);
    assert.equal(r.remoteOverridden, 0);
    assert.equal(getSaved().find((f) => f.uid === 'a').tag, 'want');
});

test('syncBangumiNow 结果提示带上最新时间裁决条数', async () => {
    const favorites = [{ uid: 'a', site: 'kazumi:x', name: '冲突番', tag: 'watching', bangumiId: '20', ts: 1000 }];
    const toasts = [];
    let planParams = null;
    const plan = {
        upload: [], pull: [], skipped: 1,
        conflict: [{ subjectId: '20', localType: 3, remoteType: 2, resolved: 'remote', resolvedBy: 'newest', name: '冲突番' }],
    };
    const kazumi = loadKazumi({
        recGet: async () => favorites.map((f) => ({ ...f })),
        recSet: async () => {},
        warnToast: (m) => toasts.push(String(m)),
        showLoading() {}, hideLoading() {},
        window: { yuki: { settingsGet: async () => ({ bangumiToken: 'tok', bangumiSyncPriority: 'newest' }) } },
        doAction: async (action, params) => {
            if (action === 'kazumiBangumiSync') { planParams = { ...params }; return { code: 200, plan }; }
            if (action === 'kazumiBangumiCollections') return { code: 200, items: [{ subject_id: 20, type: 2 }] };
            return { code: 200, result: { uploaded: 0, failed: 0 } };
        },
    });
    kazumi._getBangumiToken = async () => 'tok';
    kazumi.getBangumiMatch = async () => ({ id: 20 });
    await kazumi.syncBangumiNow();
    assert.equal(planParams.priority, 'newest');
    const last = toasts[toasts.length - 1];
    assert.match(last, /已同步 Bangumi 收藏/);
    assert.match(last, /最新时间裁决 1/);
    assert.match(last, /Bangumi 覆盖本地 1/);
});
