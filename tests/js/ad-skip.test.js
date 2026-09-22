'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 把 ad-skip.js 载入干净沙箱（localStorage 可注入 Map 替身），返回 AdSkip。 */
function loadAdSkip(store) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/ad-skip.js'), 'utf8');
    const backing = store || new Map();
    const localStorageStub = {
        getItem: (k) => (backing.has(k) ? backing.get(k) : null),
        setItem: (k, v) => backing.set(k, String(v)),
        removeItem: (k) => backing.delete(k),
    };
    const context = {
        console,
        Date,
        JSON,
        Math,
        Object,
        Number,
        String,
        localStorage: localStorageStub,
        window: null,
    };
    context.window = context; // ad-skip.js 按 window 优先挂全局，vm 沙箱需自引用
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'ad-skip.js' });
    return { AdSkip: context.AdSkip, backing, localStorageStub };
}

/** 带 localStorage 的 player.js 沙箱（同 player-watch.test.js 风格，叠加 OP/ED 依赖）。
 *  关键：context.window 必须自引用（ad-skip.js 经 window 挂全局、player.js 顶层
 *  IIFE 经 globalThis 挂 YUKI，vm 沙箱中裸标识符只解析 context 对象自身属性，
 *  故 yuki/localStorage 等也要是 context 的自有属性）。 */
function loadPlayer(settings, storeBacking) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/player.js'), 'utf8');
    const adSkipSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/ad-skip.js'), 'utf8');
    const backing = storeBacking || new Map();
    const documentStub = {
        addEventListener() {},
        getElementById() { return null; },
        querySelector() { return null; },
    };
    const context = {
        console,
        Map,
        Set,
        Promise,
        Date,
        Math,
        JSON,
        String,
        Array,
        Number,
        Object,
        parseInt,
        parseFloat,
        setTimeout,
        clearTimeout,
        document: documentStub,
        // player.js play() 依赖的最小全局（同 player-watch.test.js 的 stub 思路）
        createRuntimeId: (p) => `${p}-test-${Math.random().toString(36).slice(2)}`,
        showLoading() {},
        hideLoading() {},
        openDialog() {},
        closeDialog() {},
        warnToast(msg) { context.__toasts.push(String(msg)); },
        $: () => {
            const el = {};
            for (const m of ['on', 'text', 'toggle', 'show', 'hide', 'append', 'empty',
                'appendTo', 'css', 'attr', 'remove', 'each', 'find', 'addClass', 'removeClass']) {
                el[m] = () => el;
            }
            return el;
        },
        __toasts: [],
        AbortController,
    };
    context.window = context; // 自引用：裸标识符与 window.yuki 双通道生效
    context.yuki = {
        settingsGet: async () => JSON.parse(JSON.stringify(settings)),
        settingsSet: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
    };
    context.localStorage = {
        getItem: (k) => (backing.has(k) ? backing.get(k) : null),
        setItem: (k, v) => backing.set(k, String(v)),
        removeItem: (k) => backing.delete(k),
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${adSkipSource}\n${source}\n;globalThis.__testPlayer = Player;`, context,
        { filename: 'player+ad-skip.js' });
    return { player: context.__testPlayer, context, backing };
}

test('opEdKey：片名+线路拼接，空片段容忍但全空拒绝，| 转义防碰撞', () => {
    const { AdSkip } = loadAdSkip();
    assert.equal(AdSkip.opEdKey('海贼王', '线路1'), '海贼王|线路1');
    assert.equal(AdSkip.opEdKey('  海贼王  ', '  线路1 '), '海贼王|线路1');
    assert.equal(AdSkip.opEdKey('', ''), '|');
    assert.equal(AdSkip.opEdKey(null, undefined), '|');
    // title/flag 中的 | 替换为全角／：防键段碰撞（原裸拼接会撞键）
    assert.equal(AdSkip.opEdKey('A|B', 'C'), 'A／B|C');
    assert.notEqual(AdSkip.opEdKey('A|B', 'C'), AdSkip.opEdKey('A', 'B|C'));
    assert.equal(AdSkip.opEdKey('A', 'B|C'), 'A|B／C');
});

test('recordOpEd/getOpEd：登记与读取闭环，非法值拒绝', () => {
    const { AdSkip, backing } = loadAdSkip();
    const rec = AdSkip.recordOpEd('番剧A', '线路1', 'op', 90.4);
    assert.equal(rec.op, 90);
    assert.equal(AdSkip.getOpEd('番剧A', '线路1').op, 90);
    // 片尾登记不覆盖片头
    AdSkip.recordOpEd('番剧A', '线路1', 'ed', 1200);
    const both = AdSkip.getOpEd('番剧A', '线路1');
    assert.equal(both.op, 90);
    assert.equal(both.ed, 1200);
    // 非法值：负数 / 0 / 超 1 小时 / 未知 kind / 空键
    assert.equal(AdSkip.recordOpEd('番剧B', '', 'op', -5), null);
    assert.equal(AdSkip.recordOpEd('番剧B', '', 'op', 0), null);
    assert.equal(AdSkip.recordOpEd('番剧B', '', 'op', 4000), null);
    assert.equal(AdSkip.recordOpEd('番剧B', '', 'intro', 60), null);
    assert.equal(AdSkip.recordOpEd('', '', 'op', 60), null);
    // 存储确实落了 localStorage
    assert.ok(backing.has(AdSkip.STORE_KEY));
});

test('recordOpEd：容量上限淘汰最旧记录', () => {
    const store = loadAdSkip();
    for (let i = 0; i < store.AdSkip.MAX_ENTRIES + 5; i++) {
        store.AdSkip.recordOpEd(`片${i}`, '线路', 'op', 30, null, 1000 + i);
    }
    const data = JSON.parse(store.backing.get(store.AdSkip.STORE_KEY));
    assert.ok(Object.keys(data.byKey).length <= store.AdSkip.MAX_ENTRIES);
    // 最旧的被淘汰
    assert.equal(data.byKey['片0|线路'], undefined);
    assert.ok(data.byKey[`片${store.AdSkip.MAX_ENTRIES + 4}|线路`]);
});

test('findSiblingOpEd：同片名跨线路查询，不含本线路，返回 {flag, rec}', () => {
    const { AdSkip } = loadAdSkip();
    AdSkip.recordOpEd('番剧A', '线路1', 'op', 88);
    AdSkip.recordOpEd('番剧A', '线路2', 'op', 90);
    const sib = AdSkip.findSiblingOpEd('番剧A', '线路2');
    assert.ok(sib && typeof sib === 'object' && !Array.isArray(sib));
    assert.equal(sib.flag, '线路1');
    assert.equal(sib.rec.op, 88);
    // 本线路记录不会被当作 sibling
    assert.equal(AdSkip.findSiblingOpEd('番剧B', '线路X'), null);
});

test('findSiblingHint：兄弟线路有片头记录时返回提示，无记录/无片头值返回 null', () => {
    const { AdSkip } = loadAdSkip();
    assert.equal(AdSkip.findSiblingHint('番剧H', '线路A'), null); // 无任何记录
    AdSkip.recordOpEd('番剧H', '线路B', 'op', 90);
    const hint = AdSkip.findSiblingHint('番剧H', '线路A');
    assert.ok(hint);
    assert.equal(hint.flag, '线路B');
    assert.equal(hint.sec, 90);
    // 兄弟线路只有片尾记录（无 op）：不构成片头提示
    AdSkip.recordOpEd('番剧I', '线路B', 'ed', 1200);
    assert.equal(AdSkip.findSiblingHint('番剧I', '线路A'), null);
});

test('decideStartSec：正片保护带与异常值防线', () => {
    const { AdSkip } = loadAdSkip();
    assert.equal(AdSkip.decideStartSec(90, 1400), 90);
    // 未知时长：手动登记值照用
    assert.equal(AdSkip.decideStartSec(90, null), 90);
    // 片头值离片尾不足 30s：宁可从头播
    assert.equal(AdSkip.decideStartSec(1390, 1400), 0);
    // 非法/越界值
    assert.equal(AdSkip.decideStartSec(0, 1400), 0);
    assert.equal(AdSkip.decideStartSec(-3, 1400), 0);
    assert.equal(AdSkip.decideStartSec(99999, 1400), 0);
    assert.equal(AdSkip.decideStartSec('abc', 1400), 0);
});

test('decideEdAction：跳过窗口/提示窗口/越过后不动作', () => {
    const { AdSkip } = loadAdSkip();
    // ed=1200, dur=1400：提前量 5s → [1195,1200) 报 skip
    assert.equal(AdSkip.decideEdAction(1196, 1400, 1200), 'skip');
    // 距片尾 30s 内但在提前量之前 → toast
    assert.equal(AdSkip.decideEdAction(1180, 1400, 1200), 'toast');
    // 太早不动作
    assert.equal(AdSkip.decideEdAction(1000, 1400, 1200), null);
    // 已越过片尾点（可能回拖回看）不动作
    assert.equal(AdSkip.decideEdAction(1206, 1400, 1200), null);
    // 片长太短（<300s 保护）不动作
    assert.equal(AdSkip.decideEdAction(180, 200, 150), null);
    // ed 值可疑（≈片长 / 过小）不动作
    assert.equal(AdSkip.decideEdAction(1395, 1400, 1395), null);
    assert.equal(AdSkip.decideEdAction(10, 1400, 10), null);
    // 时长未知不动作
    assert.equal(AdSkip.decideEdAction(1196, null, 1200), null);
});

test('resolveAutoOpSec：只信任同键（片名+线路）记录，不跨线路自动套用', () => {
    const { AdSkip } = loadAdSkip();
    AdSkip.recordOpEd('番剧A', '线路1', 'op', 90);
    AdSkip.recordOpEd('番剧A', '线路2', 'op', 95);
    assert.equal(AdSkip.resolveAutoOpSec('番剧A', '线路2', null), 95);
    // 不同压制线路片头长度可能不同：无本线路记录时不套用兄弟线路值（返回 0 从头播）
    assert.equal(AdSkip.resolveAutoOpSec('番剧A', '线路3', null), 0);
    assert.equal(AdSkip.resolveAutoOpSec('番剧B', '线路1', null), 0);  // 无记录
    // 兄弟线路记录只作提示（findSiblingHint），不参与自动决策
    const hint = AdSkip.findSiblingHint('番剧A', '线路3');
    assert.equal(hint.flag, '线路1');
    assert.equal(hint.sec, 90);
});

/** 给 player 所在沙箱注入 doAction/getJson/yuki.playUrl stub——
 *  play() 直链路径需要走通「playerContent → 路由 → playUrl」。 */
function loadPlayerWithIpc(settings, storeBacking, ipcStubs = {}) {
    const loaded = loadPlayer(settings, storeBacking);
    // 沙箱内 doAction/getJson 是裸全局；直接在 context 上补
    loaded.context.doAction = ipcStubs.doAction
        || (async () => ({ url: 'http://cdn.example/video.m3u8', parse: 0, header: {} }));
    loaded.context.getJson = ipcStubs.getJson || (async () => ({ flags: [], parses: [] }));
    loaded.context.yuki.playUrl = ipcStubs.playUrl
        || (async (url) => ({ ok: true, sessionId: 1, url }));
    return loaded;
}

test('play() 集成：opEdSkip=false 关闭时不跳片头', async () => {
    const settings = { opEdSkip: false };
    const backing = new Map();
    backing.set('yuki_oped_skip_v1', JSON.stringify({ byKey: { '影片Z|线路A': { op: 90, ed: null, ts: 1 } } }));
    const { player, context } = loadPlayerWithIpc(settings, backing);
    player.getVipFlags = async () => [];
    let capturedMeta = null;
    context.yuki.playUrl = async (url, meta) => { capturedMeta = meta; return { ok: true, sessionId: 1, url }; };
    const r = await player.play('siteA', '线路A', 'ep1', '影片Z', '第1集', null, 0, '');
    assert.equal(r.ok, true);
    assert.ok(capturedMeta);
    assert.equal(capturedMeta.position, undefined);
    assert.equal(player._opEdStartPos, 0);
});

test('play() 集成：源站续播 position 优先，opEd 片头位置让位', async () => {
    const settings = {};
    const backing = new Map();
    backing.set('yuki_oped_skip_v1',
        JSON.stringify({ byKey: { '影片P|线路A': { op: 90, ed: null, ts: 1 } } }));
    const { player, context } = loadPlayerWithIpc(settings, backing, {
        doAction: async () => ({ url: 'http://cdn.example/video.m3u8', parse: 0, header: {}, position: 600 }),
    });
    player.getVipFlags = async () => [];
    let capturedMeta = null;
    context.yuki.playUrl = async (url, meta) => { capturedMeta = meta; return { ok: true, sessionId: 1, url }; };
    // 源站自带续播位置（如 600s）：opEd 的 90s 不得覆盖
    const r = await player.play('siteA', '线路A', 'ep1', '影片P', '第1集', null, 0, '');
    assert.equal(r.ok, true);
    assert.equal(capturedMeta.position, 600);
});

test('play() 直链快路径：parse=1 已是媒体直链时也注入 opEd 片头位置', async () => {
    const settings = {};
    const backing = new Map();
    backing.set('yuki_oped_skip_v1',
        JSON.stringify({ byKey: { '影片D|线路A': { op: 90, ed: null, ts: 1 } } }));
    const { player, context } = loadPlayerWithIpc(settings, backing, {
        doAction: async () => ({
            // parse=1 + mp4 直链：走 _playDirect 快路径
            url: 'http://cdn.example/video.mp4', parse: 1, header: {},
        }),
    });
    player.getVipFlags = async () => [];
    let capturedMeta = null;
    context.yuki.playUrl = async (url, meta) => { capturedMeta = meta; return { ok: true, sessionId: 1, url }; };
    const r = await player.play('siteA', '线路A', 'ep1', '影片D', '第1集', null, 0, '');
    assert.equal(r.ok, true);
    assert.ok(capturedMeta);
    // 快路径同样兜底：无源站 position 时注入 opEd 毫秒
    assert.equal(capturedMeta.position, 90000);
    // toast 只在实际注入时弹
    assert.ok(context.__toasts.some((t) => t.includes('已自动跳过片头，已在 mpv')));
});

test('play() 直链快路径：源站续播优先且不弹「已自动跳过片头」', async () => {
    const settings = {};
    const backing = new Map();
    backing.set('yuki_oped_skip_v1',
        JSON.stringify({ byKey: { '影片D2|线路A': { op: 90, ed: null, ts: 1 } } }));
    const { player, context } = loadPlayerWithIpc(settings, backing, {
        doAction: async () => ({
            url: 'http://cdn.example/video2.mp4', parse: 1, header: {}, position: 600,
        }),
    });
    player.getVipFlags = async () => [];
    let capturedMeta = null;
    context.yuki.playUrl = async (url, meta) => { capturedMeta = meta; return { ok: true, sessionId: 1, url }; };
    const r = await player.play('siteA', '线路A', 'ep1', '影片D2', '第1集', null, 0, '');
    assert.equal(r.ok, true);
    assert.equal(capturedMeta.position, 600); // 源站续播保留
    // 不弹快路径专有提示「已自动跳过片头，已在 mpv」（play() 自身的自动跳过提示不在此断言范围）
    assert.ok(!context.__toasts.some((t) => t.includes('已自动跳过片头，已在 mpv')));
});

test('play() 集成：有片头记录时经 position（毫秒）传给 playUrl', async () => {
    const settings = {};
    const backing = new Map();
    backing.set('yuki_oped_skip_v1',
        JSON.stringify({ byKey: { '影片Z|线路A': { op: 90, ed: null, ts: 1 } } }));
    const { player, context } = loadPlayerWithIpc(settings, backing);
    player.getVipFlags = async () => [];
    let capturedMeta = null;
    context.yuki.playUrl = async (url, meta) => { capturedMeta = meta; return { ok: true, sessionId: 1, url }; };
    const r = await player.play('siteA', '线路A', 'ep1', '影片Z', '第1集', null, 0, '');
    assert.equal(r.ok, true);
    assert.ok(capturedMeta, '应调用 playUrl');
    // position 应为 90000 毫秒（90s × 1000，主进程换算 mpv --start）
    assert.equal(capturedMeta.position, 90000);
    assert.equal(player._opEdStartPos, 90);
    assert.ok(context.__toasts.some((t) => t.includes('已自动跳过片头')));
});

test('play() 集成：无记录时不注入 position', async () => {
    const settings = {};
    const { player, context } = loadPlayerWithIpc(settings, new Map());
    player.getVipFlags = async () => [];
    let capturedMeta = null;
    context.yuki.playUrl = async (url, meta) => { capturedMeta = meta; return { ok: true, sessionId: 1, url }; };
    const r = await player.play('siteA', '线路A', 'ep1', '影片N', '第1集', null, 0, '');
    assert.equal(r.ok, true);
    assert.ok(capturedMeta);
    assert.equal(capturedMeta.position, undefined);
    assert.equal(player._opEdStartPos, 0);
});

test('_recordOpEdFromPlayback：mpv 模式经 get-pos 记录当前位置并提示', async () => {
    const settings = {};
    const backing = new Map();
    const { player, context } = loadPlayer(settings, backing);
    player._curMeta = { title: '影片M', flag: '线路B', site: 'siteA' };
    // get-pos 返回真实 time-pos：登记成功
    context.yuki.playerControl = async (cmd) => (cmd === 'get-pos' ? { ok: true, pos: 95 } : { ok: false });
    await player._recordOpEdFromPlayback('op');
    const rec = JSON.parse(backing.get('yuki_oped_skip_v1')).byKey['影片M|线路B'];
    assert.equal(rec.op, 95);
    assert.ok(context.__toasts.some((t) => t.includes('已记录片头结束点')));
});

test('_recordOpEdFromPlayback：get-pos 不可用（reject/ok:false/pos:null）降级不登记', async () => {
    const settings = {};
    const backing = new Map();
    // reject：R1 未合入（主进程未放行 get-pos → unknown cmd 返回 ok:false；IPC 异常则 reject）
    const { player, context } = loadPlayer(settings, backing);
    player._curMeta = { title: '影片M', flag: '线路B', site: 'siteA' };
    context.yuki.playerControl = async () => { throw new Error('unknown cmd'); };
    await player._recordOpEdFromPlayback('op');
    // ok:false
    context.yuki.playerControl = async () => ({ ok: false });
    await player._recordOpEdFromPlayback('op');
    // ok:true 但 pos=null（未起播/无会话）
    context.yuki.playerControl = async () => ({ ok: true, pos: null });
    await player._recordOpEdFromPlayback('op');
    // playerControl 不存在（旧 preload）
    delete context.yuki.playerControl;
    await player._recordOpEdFromPlayback('op');
    // 四种形态均不登记、均给出「无法获取播放位置」提示且不抛错
    assert.equal(backing.get('yuki_oped_skip_v1'), undefined);
    assert.equal(context.__toasts.filter((t) => t === '无法获取播放位置').length, 4);
});

test('_recordOpEdFromPlayback：pos=0 视为无法获取，不落「太靠前」提示', async () => {
    const settings = {};
    const backing = new Map();
    const { player, context } = loadPlayer(settings, backing);
    player._curMeta = { title: '影片M0', flag: '线路B', site: 'siteA' };
    context.yuki.playerControl = async () => ({ ok: true, pos: 0 });
    await player._recordOpEdFromPlayback('op');
    assert.equal(backing.get('yuki_oped_skip_v1'), undefined);
    assert.ok(context.__toasts.includes('无法获取播放位置'));
});

test('_recordOpEdFromPlayback：opEdSkip=false 时登记入口关闭并提示', async () => {
    const settings = { opEdSkip: false };
    const backing = new Map();
    const { player, context } = loadPlayer(settings, backing);
    player._curMeta = { title: '影片S', flag: '线路B', site: 'siteA' };
    player._opEdSkipEnabled = false; // play() 起播时按设置缓存
    let getPosCalled = 0;
    context.yuki.playerControl = async () => { getPosCalled += 1; return { ok: true, pos: 90 }; };
    await player._recordOpEdFromPlayback('op');
    assert.equal(getPosCalled, 0); // 开关关闭不发起 get-pos 查询
    assert.equal(backing.get('yuki_oped_skip_v1'), undefined);
    assert.ok(context.__toasts.includes('跳过片头片尾功能已关闭'));
});

test('_onOpEdHotkey：Shift+O / Shift+E 触发登记，输入框与修饰键组合不触发', async () => {
    const settings = {};
    const backing = new Map();
    const { player, context } = loadPlayer(settings, backing);
    player._curMeta = { title: '影片H', flag: '线路C', site: 'siteA' };
    context.yuki.playerControl = async () => ({ ok: true, pos: 80 });
    await player._onOpEdHotkey({ shiftKey: true, key: 'O' });
    await player._onOpEdHotkey({ shiftKey: true, key: 'e' });
    const rec = JSON.parse(backing.get('yuki_oped_skip_v1')).byKey['影片H|线路C'];
    assert.equal(rec.op, 80);
    assert.equal(rec.ed, 80);
    // 无 Shift / 其他键：不触发
    await player._onOpEdHotkey({ shiftKey: false, key: 'O' });
    await player._onOpEdHotkey({ shiftKey: true, key: 'A' });
    // 输入框/可编辑元素聚焦：不劫持
    await player._onOpEdHotkey({ shiftKey: true, key: 'O', target: { tagName: 'INPUT' } });
    await player._onOpEdHotkey({ shiftKey: true, key: 'O', target: { tagName: 'TEXTAREA' } });
    await player._onOpEdHotkey({ shiftKey: true, key: 'O', target: { tagName: 'DIV', isContentEditable: true } });
    // Ctrl/Alt/Meta 组合：不拦截
    await player._onOpEdHotkey({ shiftKey: true, key: 'O', ctrlKey: true });
    await player._onOpEdHotkey({ shiftKey: true, key: 'O', metaKey: true });
    const data = JSON.parse(backing.get('yuki_oped_skip_v1'));
    assert.equal(Object.keys(data.byKey).length, 1);
    assert.equal(rec.op, 80); // 仍是最初登记值
});

test('_onOpEdHotkey：opEdSkip=false 时快捷键提示功能已关闭', async () => {
    const settings = { opEdSkip: false };
    const backing = new Map();
    const { player, context } = loadPlayer(settings, backing);
    player._curMeta = { title: '影片H2', flag: '线路C', site: 'siteA' };
    player._opEdSkipEnabled = false;
    await player._onOpEdHotkey({ shiftKey: true, key: 'O' });
    assert.ok(context.__toasts.includes('跳过片头片尾功能已关闭'));
    assert.equal(backing.get('yuki_oped_skip_v1'), undefined);
});

test('_estimateCurrentSec：<video> 预览（含暂停态）返回 currentTime，mpv 分支读 get-pos', async () => {
    const settings = {};
    const { player, context } = loadPlayer(settings, new Map());
    // 沙箱 document.getElementById 返回 null → 走 mpv 分支
    context.yuki.playerControl = async (cmd) => (cmd === 'get-pos' ? { ok: true, pos: 102.5 } : { ok: false });
    assert.equal(await player._estimateCurrentSec(), 102.5);
    // 预览模式：暂停态也可登记（不再要求 !paused）
    context.document.getElementById = () => ({ paused: true, currentTime: 65, duration: 1300 });
    assert.equal(await player._estimateCurrentSec(), 65);
});

test('play() 起播缓存 opEdSkip 开关到 _opEdSkipEnabled', async () => {
    const settings = { opEdSkip: false };
    const { player } = loadPlayerWithIpc(settings, new Map());
    player.getVipFlags = async () => [];
    await player.play('siteA', '线路A', 'ep1', '影片N', '第1集', null, 0, '');
    assert.equal(player._opEdSkipEnabled, false);
    // 读设置失败：默认开启
    const loaded2 = loadPlayerWithIpc({}, new Map());
    loaded2.context.yuki.settingsGet = async () => { throw new Error('ipc down'); };
    loaded2.player.getVipFlags = async () => [];
    await loaded2.player.play('siteA', '线路A', 'ep1', '影片N', '第1集', null, 0, '');
    assert.equal(loaded2.player._opEdSkipEnabled, true);
});

test('play() 集成（回归）：有片头记录时经 position（毫秒）传给 playUrl', async () => {
    const settings = {};
    const backing = new Map();
    backing.set('yuki_oped_skip_v1',
        JSON.stringify({ byKey: { '影片Z|线路A': { op: 90, ed: null, ts: 1 } } }));
    const { player, context } = loadPlayerWithIpc(settings, backing);
    player.getVipFlags = async () => [];
    let capturedMeta = null;
    context.yuki.playUrl = async (url, meta) => { capturedMeta = meta; return { ok: true, sessionId: 1, url }; };
    const r = await player.play('siteA', '线路A', 'ep1', '影片Z', '第1集', null, 0, '');
    assert.equal(r.ok, true);
    assert.ok(capturedMeta, '应调用 playUrl');
    // position 应为 90000 毫秒（90s × 1000，主进程换算 mpv --start）
    assert.equal(capturedMeta.position, 90000);
    assert.equal(player._opEdStartPos, 90);
});
