'use strict';
/**
 * settings-snapshot.test.js —— A-27 设置快照层单测 + 主链路调用点改造锚点断言。
 *
 * 覆盖对象：src/renderer/js/settings-snapshot.js（新模块）与 detail.js / player.js
 * 的 5 处主链路 settingsGet 收口（detail.js load() 路径 2 次、playSelected 1 次、
 * player.js play() 起播 3 次）。
 *
 * 语义层关系（与模块头注释一致，此处为回归锚点）：
 *   - 快照层职责：渲染层长驻内存 + 事件失效；首读穿透一次全量，之后内存直读；
 *   - preload 3s TTL（preload.js:12-17）是其下层的短时合并兜底，快照命中路径
 *     完全不经过 preload，两层不重复调 IPC、不互相打架。
 *
 * 失效通道口径：主进程对 settings-set 无广播（preload API 清单被
 * preload-contract.test.js 钉死），失效按「写失效（document change 冒泡段委托 +
 * echo fence settle 后 invalidate）+ getFresh 强刷 + 90s 兜底」三保险实现
 * （优化.md 风险登记：低频写可接受短暂不一致；M11：失效与落盘解耦、写在途时
 * get/getFresh 等 settle 后才穿透，杜绝半新半旧窗口）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer', 'js');
const readSrc = (name) => fs.readFileSync(path.join(RENDERER, name), 'utf8');

const SNAPSHOT_SRC = readSrc('settings-snapshot.js');
const DETAIL_SRC = readSrc('detail.js');
const PLAYER_SRC = readSrc('player.js');

/**
 * 在 VM 中加载 settings-snapshot.js。
 * @param {object} opts
 *   - settings: 可变设置对象（settingsGet 桩每次返回深拷贝）
 *   - ipcCount: { n } 计数器对象，记录 settingsGet 穿透次数
 *   - ipcDelay: settingsGet 桩的人工延迟（并发合并测试用）
 *   - withDocument: 注入 document.addEventListener 桩（默认 true）
 *   - throwOnGet: settingsGet 桩抛错（失败不缓存语义测试用）
 *   - setDelay: settingsSet 桩的人工延迟（写 fence 时序测试用）；0/缺省=立即 resolve
 *   - hasBubblingTarget: 模拟 change 在控件上冒泡（默认 true；false 模拟不冒泡源）
 * M11 后快照层会在 change 信号时调一次 no-op echo settingsSet（IPC fence），
 * 桩提供可编程延迟/重入钩子供时序断言（settle 后才失效）。
 */
function loadSnapshot(opts = {}) {
    const settings = opts.settings || {};
    const ipcCount = opts.ipcCount || { n: 0 };
    const listeners = [];
    const targetListeners = []; // 控件级监听（冒泡模拟：document 侧 + target 侧按 DOM 顺序）
    const setCount = opts.setCount || { n: 0 };
    let yukiApi = null; // 延迟初始化：测试可在派发 change 前换桩（如把 settingsSet 换成会抛错的）
    const documentStub = { addEventListener: (ev, fn, useCapture) => listeners.push([ev, fn, useCapture]) };
    // Date 可注入：兜底过期测试需要推进沙箱时钟（模块用 Date.now 判龄）
    const DateCtor = opts.DateImpl || Date;
    const context = {
        console, JSON, Object, Array, Promise, Error, Math,
        setTimeout, clearTimeout,
        Date: DateCtor,
        document: documentStub,
        yuki: null,
    };
    yukiApi = {
        settingsGet: async () => {
            if (opts.throwOnGet) throw new Error('ipc down');
            ipcCount.n += 1;
            if (opts.ipcDelay) await new Promise((r) => setTimeout(r, opts.ipcDelay));
            return JSON.parse(JSON.stringify(settings));
        },
        settingsSet: async (key, value) => {
            setCount.n += 1;
            if (opts.throwOnSet) throw new Error('ipc set down');
            if (opts.setDelay) await new Promise((r) => setTimeout(r, opts.setDelay));
            if (key !== '__snapSettle' && !(key in settings)) settings[key] = value; // 白名单外键不落盘（对齐主进程 M-1 行为；fence 键主进程直接忽略）
            return { value: undefined };
        },
        /** 测试重入点：换掉 yuki API（如 settingsSet 抛错/延迟变体） */
        __swap: (patch) => Object.assign(yukiApi, patch),
    };
    context.yuki = yukiApi;
    context.window = context;   // 自引用：window.yuki / 裸 document / root 挂载同 realm
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(SNAPSHOT_SRC, context, { filename: 'settings-snapshot.js' });
    return {
        snap: context.SettingsSnapshot,
        yuki: context.window.yuki,
        listeners,
        ipcCount,
        setCount,
        context,
        /** 模拟设置页写入：改桩数据 + 控件 change 冒泡到 document（冒泡段委托应失效快照） */
        simulateSettingsWrite(key, value) {
            settings[key] = value;
            const evt = { target: { id: 'set_' + key } };
            if (opts.hasBubblingTarget !== false) {
                for (const [ev, fn] of targetListeners) if (ev === 'change') fn(evt); // 控件段先
            }
            for (const [ev, fn] of listeners) {
                if (ev === 'change') fn(evt); // document 委托段（冒泡到达）
            }
        },
        /** 测试直读（不走冒泡）：观察 document 上注册的 change 委托 handler */
        dispatchChangeDirect(evt) {
            for (const [ev, fn] of listeners) if (ev === 'change') fn(evt);
        },
        /** 测试注册控件级监听（配合 hasBubblingTarget 验证冒泡段可收到控件 change） */
        addTargetListener(ev, fn) { targetListeners.push([ev, fn]); },
        /** 沙箱时钟偏移（兜底过期用） */
        clockSkew: { v: 0 },
        /** flush 写链微任务：等 echo fence settle（invalidate 已发生）后再断言 */
        flushWrite: () => new Promise((r) => setTimeout(r, 1)),
    };
}

// ─────────────────────────────────────────────────────────────── 快照层契约

test('A-27 ①：首读走 IPC 并缓存（一次穿透，返回全量）', async () => {
    const ipc = { n: 0 };
    const { snap } = loadSnapshot({ settings: { autoNext: false, theme: 'dark' }, ipcCount: ipc });
    const a = await snap.get();
    assert.equal(ipc.n, 1, '首读必须穿透一次 IPC');
    assert.equal(a.autoNext, false);
    assert.equal(a.theme, 'dark');
});

test('A-27 ②：二次读零 IPC（内存快照命中，同帧引用一致）', async () => {
    const ipc = { n: 0 };
    const { snap } = loadSnapshot({ settings: { autoNext: true }, ipcCount: ipc });
    const a = await snap.get();
    const b = await snap.get();
    const c = await snap.get();
    assert.equal(ipc.n, 1, '快照命中后不得再发起 IPC');
    assert.equal(a, b, '命中路径返回快照本体（调用方只读消费）');
    assert.equal(b, c);
    assert.ok(snap.ageMs() !== null);
});

test('A-27 并发首读合并：同帧多个 get() 只发起一次穿透', async () => {
    const ipc = { n: 0 };
    const { snap } = loadSnapshot({ settings: { k: 1 }, ipcCount: ipc, ipcDelay: 20 });
    const [a, b, c] = await Promise.all([snap.get(), snap.get(), snap.get()]);
    assert.equal(ipc.n, 1, 'in-flight 合并：并发未命中只打一次 IPC');
    assert.equal(a, b);
    assert.equal(b, c);
});

test('A-27 ③：变更事件（change 委托）后失效重读', async () => {
    const ipc = { n: 0 };
    const { snap, simulateSettingsWrite, flushWrite } = loadSnapshot({ settings: { autoNext: true }, ipcCount: ipc });
    assert.equal((await snap.get()).autoNext, true);
    assert.equal(ipc.n, 1);
    simulateSettingsWrite('autoNext', false); // 写穿桩数据 + 派发 change → echo fence → settle 后 invalidate
    assert.equal(ipc.n, 1, 'fence（echo settingsSet）不是 settingsGet，穿透计数不变');
    await flushWrite(); // 等 fence settle（落盘完成 → invalidate）
    assert.equal(snap.ageMs(), null, 'settle 后快照应被清空（失效与落盘解耦，M11）');
    assert.equal((await snap.get()).autoNext, false, '失效后的下一次 get 必须重读新值');
    assert.equal(ipc.n, 2, '失效后首读重新穿透');
    assert.equal((await snap.get()).autoNext, false);
    assert.equal(ipc.n, 2, '失效后的二次读仍走快照');
});

test('A-27 ③b：change 委托监听以冒泡段注册（M11 统一口径），input 控件的 change 能收到', () => {
    const { listeners } = loadSnapshot({});
    const changes = listeners.filter(([ev]) => ev === 'change');
    assert.equal(changes.length, 1, 'change 只注册一个委托监听');
    assert.equal(changes[0].length, 3, '注册形参为 (ev, handler, useCapture) 三参');
    assert.equal(changes[0][2], false, 'useCapture 必须为 false——监听 document 冒泡段（M11：与实现/注释统一）');
});

test('M11：change 冒泡段监听确实收到 input 控件的 change（控件段先于 document 段）', async () => {
    const ipc = { n: 0 };
    const set = { n: 0 };
    const { snap, simulateSettingsWrite, addTargetListener, flushWrite } = loadSnapshot({
        settings: { theme: 'dark' }, ipcCount: ipc, setCount: set,
    });
    await snap.get(); // 先建快照
    // 模拟控件自身监听（panels.js/kazumi.js 的 change handler：内部发 settingsSet）
    const order = [];
    addTargetListener('change', () => order.push('target-handler'));
    simulateSettingsWrite('theme', 'light');
    assert.deepEqual(order, ['target-handler'],
        '控件 handler 先执行（模拟页面先发出 settingsSet）——document 冒泡段在其后收到信号');
    assert.equal(set.n, 1, 'document 冒泡段触发快照层 echo fence（settingsSet 被调用）');
    await flushWrite(); // 等 echo fence settle
    assert.equal(snap.ageMs(), null, 'fence settle 后快照已失效（invalidate 已发生）');
    assert.equal((await snap.get()).theme, 'light', '失效后的下一次 get 重读新值');
    assert.equal(ipc.n, 2, '下一次 get 重新穿透拿新值');
});

// ─────────────────────────────────────────── M11 写时序（fence + 世代守卫）

test('M11 ①：写在途时 get() 不返回旧快照，也不提前穿透——settle（落盘）后才读新值', async () => {
    const ipc = { n: 0 };
    const set = { n: 0 };
    const gate = { open: false, release: null };
    const env = loadSnapshot({ settings: { v: 'old' }, ipcCount: ipc, setCount: set });
    await env.snap.get();                       // 建立旧快照
    assert.equal(ipc.n, 1);
    // settingsSet 换成可控延迟桩：模拟 settings-set 落盘在途
    env.context.window.yuki.__swap({
        settingsSet: async (key, value) => {
            set.n += 1;
            if (gate.open) return { value: undefined };
            await new Promise((r) => { gate.release = r; }); // 卡住，直到测试放行
            return { value: undefined };
        },
    });
    env.simulateSettingsWrite('v', 'new');       // change 信号：写进入途（fence 挂起）
    // change 同步触发 echo fence（set.n=1、挂起中）；此刻 get 必须「不返回旧值」：
    // 用 setDelay=0 的对照组证明旧快照已失去新鲜资格——先用 ageMs 断言失效已抬信号
    assert.equal(set.n, 1, 'change 同步发出 echo fence（写信号已抬）');
    const pGet = env.snap.get();
    // get 不能在 fence settle 前返回：构造证据——放行落盘前轮询 get 未决
    let settledBeforeRelease = false;
    let raced = false;
    const race = Promise.race([pGet.then(() => { settledBeforeRelease = true; }), new Promise((r) => setTimeout(() => { raced = true; r(); }, 15))]);
    await race;
    assert.equal(raced, true, '等待窗已到期');
    assert.equal(settledBeforeRelease, false, '写在途（fence 未 settle）时 get() 必须保持未决——不返回旧快照');
    gate.release();                              // 模拟落盘完成
    const v = (await pGet).v;
    assert.equal(v, 'new', 'settle 后 get 返回新值（不吞写入）');
    assert.equal(ipc.n, 2, 'settle 后重新穿透读全量');
});

test('M11 ②：写在途时 getFresh() 不得把旧快照当新鲜值返回（等 fence 后穿透）', async () => {
    const ipc = { n: 0 };
    const env = loadSnapshot({ settings: { v: 'old' }, ipcCount: ipc, setDelay: 10 });
    await env.snap.get();
    // 落盘 10ms：fence 未 settle 期间 getFresh 必须未决（不许拿旧快照直读充数）
    env.simulateSettingsWrite('v', 'new');
    const t0 = Date.now();
    const v = (await env.snap.getFresh()).v;
    assert.ok(Date.now() - t0 >= 10, 'getFresh 等 echo fence settle（≥setDelay）后才返回');
    assert.equal(v, 'new', '等完落盘后拿新值');
    assert.equal(ipc.n, 2, '穿透读全量（getFresh 语义保持）');
});

test('M11 ③：invalidate 在 fence（落盘）之后发生——settle 前 ageMs 仍非 null', async () => {
    const gate = { release: null };
    const env = loadSnapshot({ settings: { v: 1 } });
    await env.snap.get();
    assert.ok(env.snap.ageMs() !== null, '快照有效');
    env.context.window.yuki.__swap({
        settingsSet: async () => { await new Promise((r) => { gate.release = r; }); return { value: undefined }; },
    });
    env.simulateSettingsWrite('v', 2); // change 信号已到、落盘未完成
    assert.ok(env.snap.ageMs() !== null, '写在途（fence 未 settle）：invalidate 尚未发生（失效与落盘解耦）');
    gate.release();
    await new Promise((r) => setTimeout(r, 5)); // 让微任务链走完（echo resolve → .then(invalidate)）
    assert.equal(env.snap.ageMs(), null, '落盘完成后 invalidate 才发生');
    assert.equal((await env.snap.get()).v, 2, '失效后首读拿新值');
});

test('M11 ④：写入完成后 invalidate 已发生——并发首个 get 返回的引用含新值', async () => {
    const ipc = { n: 0 };
    const env = loadSnapshot({ settings: { v: 'old' }, ipcCount: ipc, setDelay: 5 });
    await env.snap.get();
    env.simulateSettingsWrite('v', 'new');
    const s = await env.snap.get(); // 等 fence 后穿透
    assert.equal(s.v, 'new', 'settle 后读引用即新值');
    const s2 = await env.snap.get();
    assert.equal(s2, s, '后续读命中同一快照');
    assert.equal(ipc.n, 2, '只多穿透一次');
});

test('M11 ⑤：echo fence 不落盘——主进程对白名单外键忽略（零副作用）', async () => {
    const set = { n: 0 };
    const env = loadSnapshot({ settings: { autoNext: true }, setCount: set });
    await env.snap.get();
    env.simulateSettingsWrite('autoNext', false);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(set.n, 1, 'echo fence 恰好一次 settingsSet');
    const all = await env.snap.get();
    assert.equal(all.__snapSettle, undefined, 'fence 键不得出现在设置全量中（主进程白名单外忽略）');
});

test('M11 ⑥：并发两写——get 等「所有」在途写 settle（累积链），不早返回', async () => {
    const gates = [];
    const env = loadSnapshot({ settings: { v: 0 } });
    await env.snap.get();
    env.context.window.yuki.__swap({
        settingsSet: async () => new Promise((r) => { gates.push(r); }),
    });
    env.simulateSettingsWrite('v', 1); // 写 A：fence 1 挂起
    env.simulateSettingsWrite('v', 2); // 写 B：fence 2 挂起
    assert.equal(gates.length, 2, '两写各发出一次 echo fence');
    gates[1](); // 先 settle 后写的 fence（若无累积链，get 会在 A 仍在途时提前返回）
    await new Promise((r) => setTimeout(r, 5));
    let early = false;
    const p = env.snap.get();
    const loser = p.then(() => { early = true; }, () => {});
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(early, false, '写 A 仍在途：get 不得提前返回');
    gates[0](); // settle 写 A 的 fence
    const v = (await p).v;
    assert.equal(v, 2, '全部写 settle 后穿透，拿到最终值');
    await loser;
});

test('M11 ⑦：change 信号后 settingsSet 抛错——退化为立即失效，不向派发方冒泡', async () => {
    const ipc = { n: 0 };
    const env = loadSnapshot({ settings: { v: 'old' }, ipcCount: ipc });
    await env.snap.get();
    env.context.window.yuki.__swap({
        settingsSet: () => { throw new Error('ipc set down'); },
    });
    assert.doesNotThrow(() => env.simulateSettingsWrite('v', 'new'),
        'fence 失败不得向 change 派发方（页面 handler）冒泡');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(env.snap.ageMs(), null, 'fence 失败兜底：仍完成失效');
    assert.equal((await env.snap.get()).v, 'new', '下一次 get 重新穿透');
});

test('M11 ⑧：世代守卫——起读后才到的写信号，其在途读结果不回填快照', async () => {
    const ipc = { n: 0 };
    const gates = [];
    const state = { v: 'base' };
    const env = loadSnapshot({ settings: { v: 'base' }, ipcCount: ipc });
    // settingsGet 桩（只限首读挂起）：发起时点打包 payload，模拟「IPC 返回值晚于写信号」
    env.context.window.yuki.__swap({
        settingsGet: async () => {
            ipc.n += 1;
            const payload = { ...state }; // 发起时点数据（挂起期间 state 变更不影响本次返回）
            if (gates.length === 0) await new Promise((r) => gates.push(r));
            return payload;
        },
    });
    const pFirst = env.snap.get();              // 穿透读在途（挂起）
    state.v = 'changed';                        // 桩数据更新
    env.simulateSettingsWrite('v', 'changed');  // 读在途期间 change 信号（世代 ++）
    assert.equal(gates.length, 1, '仅一次穿透读在途');
    gates[0]();                                 // 放行：读此刻才返回（payload 仍是 base）
    const s = await pFirst;
    assert.equal(s.v, 'base', '在途读按其发起时刻语义返回');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(env.snap.ageMs(), null, '世代漂移：该读结果不得回填快照（防旧读覆盖新写信号）');
    const s2 = await env.snap.get();            // 世代一致的新穿透（不再挂起）
    assert.equal(s2.v, 'changed', '下一读穿透拿最新');
});

test('A-27 ④：getFresh 强刷——命中状态下绕过快照直读并回填', async () => {
    const seq = { n: 0 };
    const env2 = loadSnapshot({ settings: { v: 'v1' }, ipcCount: seq });
    await env2.snap.get();
    assert.equal((await env2.snap.get()).v, 'v1', '常规 get 命中快照');
    assert.equal(seq.n, 1);
    // 外部直改设置数据（模拟主进程对话框直写键，绕过渲染层 change 通道），
    // 写后经 simulateSettingsWrite 派发失效；getFresh 无论快照是否有效都应穿透。
    env2.simulateSettingsWrite('v', 'v2');
    assert.equal((await env2.snap.getFresh()).v, 'v2', 'getFresh 拿强刷新值');
    assert.equal(seq.n, 2);
    assert.equal((await env2.snap.get()).v, 'v2', 'getFresh 回填后 get 命中');
    assert.equal(seq.n, 2, '回填后不再穿透');
    // getFresh 对命中态快照也必须穿透（invalid + refresh 语义，而非命中返回）
    const seq3 = { n: 0 };
    const env3 = loadSnapshot({ settings: { v: 'a' }, ipcCount: seq3 });
    await env3.snap.get();
    assert.equal(seq3.n, 1);
    await env3.snap.getFresh();
    assert.equal(seq3.n, 2, '命中状态下 getFresh 仍然穿透强刷');
});

test('A-27 兜底失效：快照超龄（90s）后下一次 get 自动穿透重拉', async () => {
    const ipc = { n: 0 };
    // 偏移时钟：前 0ms 内正常，之后整体 +91s（沙箱内 Date.now 被替换，宿主不受影响）
    const skewStart = { v: 0 };
    const SkewedDate = class extends Date {
        static now() { return Date.now() + skewStart.v; }
    };
    const { snap } = loadSnapshot({ settings: { k: 1 }, ipcCount: ipc, DateImpl: SkewedDate });
    await snap.get();
    assert.equal(ipc.n, 1);
    skewStart.v = 91000; // 推进沙箱时钟越过兜底时限
    await snap.get();
    assert.equal(ipc.n, 2, '超龄快照必须自动穿透（主进程直写键的最终收敛通道）');
});

test('A-27 失败不缓存：穿透抛错后快照仍空，恢复后可重试', async () => {
    const ipc = { n: 0 };
    const env = loadSnapshot({ settings: { k: 1 }, ipcCount: ipc, throwOnGet: true });
    await assert.rejects(() => env.snap.get(), /ipc down/, '穿透失败原样冒泡给调用方降级');
    // 恢复 IPC：同一环境把桩换成正常实现（快照层不缓存失败，下一次 get 重试）
    env.context.window.yuki.settingsGet = async () => {
        ipc.n += 1;
        return { k: 42 };
    };
    assert.equal((await env.snap.get()).k, 42, '恢复后下一次 get 重试成功');
    assert.equal((await env.snap.get()).k, 42);
    assert.equal(ipc.n, 1, '成功后恢复快照语义（第二次读命中）');
});

test('A-27 沙箱降级：无 window.yuki / 无 document 时不炸（行为收敛为直读）', () => {
    const context = { console, Date, JSON, Object, Array, Promise, Error, setTimeout, clearTimeout };
    context.window = {}; // 无 yuki、无 document
    context.globalThis = context;
    vm.createContext(context);
    assert.doesNotThrow(() => vm.runInContext(SNAPSHOT_SRC, context, { filename: 'settings-snapshot.js' }),
        '快照层加载必须零依赖爆炸（defer 顺序之前/测试沙箱都安全）');
});

test('A-27 命名空间：root.SettingsSnapshot 与 YUKI.settingsSnapshot 双挂载', () => {
    const { snap, context } = loadSnapshot({});
    assert.equal(snap, context.SettingsSnapshot);
    assert.equal(context.YUKI.settingsSnapshot, context.SettingsSnapshot);
    for (const k of ['get', 'getFresh', 'invalidate', 'ageMs']) {
        assert.equal(typeof snap[k], 'function', `SettingsSnapshot.${k} 必须存在`);
    }
});

// ─────────────────────────────────────────────────────── 主链路调用点锚点断言

describe('A-27 主链路 5 处改造锚点（源码断言）', () => {
    test('detail.js：load() 路径 2 处（_catvodBgmMatchEnabled / _restoreLastSource）走快照', () => {
        // _catvodBgmMatchEnabled：唯一 settingsGet 调用点必须经 SettingsSnapshot（带回退）
        const catvodFn = DETAIL_SRC.match(/_catvodBgmMatchEnabled\(\)\s*\{[\s\S]*?\n    \},/);
        assert.ok(catvodFn, '_catvodBgmMatchEnabled 函数体应可定位');
        assert.match(catvodFn[0], /SettingsSnapshot\.get\(\)/, 'load() 第 1 读（catvodBgmMatch）应走快照');
        // _restoreLastSource：同上
        const restoreFn = DETAIL_SRC.match(/_restoreLastSource\(\)\s*\{[\s\S]*?\n    \},/);
        assert.ok(restoreFn, '_restoreLastSource 函数体应可定位');
        assert.match(restoreFn[0], /SettingsSnapshot\.get\(\)/, 'load() 第 2 读（lastSourceMap 恢复）应走快照');
        assert.match(restoreFn[0], /_cloneSnap/, '读改写路径必须深拷贝隔离');
    });

    test('detail.js：playSelected 的 autoNext 读走快照', () => {
        const fn = DETAIL_SRC.match(/async playSelected\(\)\s*\{[\s\S]*?\n    \},/);
        assert.ok(fn, 'playSelected 函数体应可定位');
        assert.match(fn[0], /SettingsSnapshot\.get\(\)/, 'playSelected 的 autoNext 读应走快照');
        // 直读只能存在于快照回退分支：settingsGet 行与 typeof 守卫行相邻（三元回退）。
        // 守卫与三元跨行书写（仓库换行惯例），故校验「settingsGet 行的上一行是 typeof 守卫」。
        const lines = fn[0].split('\n');
        const direct = lines.filter((l) => l.includes('yuki.settingsGet'));
        assert.ok(direct.length >= 1, '回退分支应保留 settingsGet 直读');
        for (const line of direct) {
            const i = lines.indexOf(line);
            assert.ok(i > 0 && /typeof SettingsSnapshot !== 'undefined'/.test(lines[i - 1]),
                'settingsGet 直读必须挂在快照回退三元（上一行应为 typeof 守卫）');
        }
    });

    test('player.js：play() 起播 3 处（opEd 开关 / 片头位置 / autoNext）走快照', () => {
        const playFn = PLAYER_SRC.match(/async play\(site, flag, id, title, subtitle, episodes, epIndex, kazumiSrc, runtimeOpts = \{\}\)\s*\{/);
        assert.ok(playFn, 'play() 入口应可定位');
        // 三处读都在 play() 帧内：用入口行号做上界截取到 _playByInternalMpv 之前的帧体
        const start = playFn.index;
        const nextFn = PLAYER_SRC.indexOf('async _playBy', start);
        const body = PLAYER_SRC.slice(start, nextFn > 0 ? nextFn : start + 30000);
        const snapshotReads = body.match(/SettingsSnapshot\.get\(\)/g) || [];
        assert.ok(snapshotReads.length >= 3, `play() 帧内应有 3 处快照读，实际 ${snapshotReads.length}`);
        // opEd 开关读（_opEdSkipEnabled 赋值前）与 autoNext 读各自独立可见
        assert.match(body, /_opEdSkipEnabled = s0\.opEdSkip === true/, '第 1 读：opEd 开关');
        assert.match(body, /s\.opEdSkip === true && title/, '第 2 读：片头自动跳过');
        assert.match(body, /autoNext = s\.autoNext !== false/, '第 3 读：连播开关');
    });

    test('detail.js：lastSourceMap 写入防抖（A-27 附带）——_saveLastSource 300ms 合并', () => {
        const fn = DETAIL_SRC.match(/async _saveLastSource\(\)\s*\{[\s\S]*?\n    \},/);
        assert.ok(fn, '_saveLastSource 函数体应可定位');
        assert.match(fn[0], /setTimeout/, '写入应经 setTimeout 防抖合并');
        assert.match(fn[0], /, 300\)/, '防抖窗口 300ms');
        assert.match(fn[0], /clearTimeout\(this\._saveLastSourceTimer\)/, '重复调用应取消前次挂起写入');
        assert.match(fn[0], /getFresh/, '写前读必须强刷（合并窗口内拿最新全量）');
    });

    test('index.html：settings-snapshot.js 已注册且先于 detail/player 加载', () => {
        const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
        const pos = (name) => html.indexOf(`js/${name}`);
        const pSnap = pos('settings-snapshot.js');
        assert.ok(pSnap > 0, 'index.html 应注册 settings-snapshot.js');
        assert.ok(pSnap < pos('detail.js'), '快照层必须先于 detail.js（defer 保序）');
        assert.ok(pSnap < pos('player.js'), '快照层必须先于 player.js（defer 保序）');
    });
});

// ─────────────────────────────────────────────── 两层语义关系回归锚点（preload）

test('A-27 两层语义：preload 3s TTL 兜底仍在（快照层不依赖也不破坏它）', () => {
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
    assert.match(preloadSrc, /_SETTINGS_TTL = 3000/, 'preload TTL 常量必须保持（下层兜底语义不变）');
    assert.match(preloadSrc, /settingsGet: async \(\) => \{[\s\S]*?_settingsCache[\s\S]*?\}/,
        'preload settingsGet 缓存实现应保持原样（快照层首读仍经它穿透）');
    // 快照层首读走 root.yuki.settingsGet（而非绕过 preload 直连 ipcRenderer——渲染层无此能力）
    assert.match(SNAPSHOT_SRC, /root\.yuki\.settingsGet\(\)/, '快照层穿透必须复用 preload 暴露的 settingsGet');
});

test('A-27 失效通道：主进程无 settings 广播（口径登记）——失效收敛在渲染层三保险', () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
    assert.doesNotMatch(mainSrc, /settings-changed/,
        '主进程当前无 settings-set 广播；若未来新增，快照层应改订阅该事件（本断言提醒同步）');
    assert.match(SNAPSHOT_SRC, /addEventListener\('change',/,
        '保险①：写失效（document change 冒泡段委托 + echo fence settle 后失效，M11）');
    // 2026-10-02：委托由裸函数改为「按来源收窄」的包装——非设置控件的 change
    // （切源/排序/全选/日志翻页等）不再抬世代、不发 fence，否则每次白发两次 IPC
    // 且把首帧读从「内存直读」退化成「等 IPC」。断言随之验证收窄语义仍生效。
    assert.match(SNAPSHOT_SRC, /t\.closest\('#view-settings, \[data-setting-key\]'\)/,
        '保险①：change 委托按设置来源收窄（非设置控件不抬世代）');
    assert.match(SNAPSHOT_SRC, /_onWrite\(\)/, '保险①：命中设置来源仍触发写失效');
    assert.match(SNAPSHOT_SRC, /FALLBACK_MAX_AGE/, '保险②：90s 兜底过期');
    assert.match(SNAPSHOT_SRC, /getFresh/, '保险③：getFresh 强刷旁路');
});
