// 组件测试：下载删除/清除流程 —— node:vm 加载真实源码 src/renderer/js/downloads.js 直测。
// 2026-09 审查 high#15：本文件原先内联复刻被测逻辑（假测试），实现改坏依旧全绿；
// 现改为注入最小桩后运行真实 downloads.js，断言全部基于真实实现。
// 覆盖范围说明：渲染层 removeTask/_confirmRemove/clearFailed 负责确认弹窗与 IPC 编排；
// 磁盘文件的真实删除在主进程 src/main/index.js（case 'remove'/'clearFailed'），
// 该文件依赖 electron 无法在此 vm 化，属已知覆盖缺口（见文件头注释）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 在 VM 中加载 downloads.js，注入最小全局桩；返回视图对象与各桩的调用记录。 */
function loadDownloads() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/downloads.js'), 'utf8');
    const calls = [];   // window.yuki.download.* IPC 调用记录
    const toasts = [];  // warnToast 文案
    const dialogs = []; // openDialog/closeDialog 记录
    const texts = [];   // jq .text() 写入的内容（弹窗任务名截断用）
    const plays = [];   // localPlayToast 记录
    const state = { uri: '', confirmResult: true, controlResult: { ok: true }, playResult: { ok: true } };

    // 链式 jQuery 桩：任何方法返回自身；val() 返回受控输入值；text() 记录写入；
    // [0] 取节点返回 undefined（onAction 的 closest 无命中路径依赖它）。
    const makeJq = () => {
        const jq = new Proxy(function () { return jq; }, {
            get(_t, prop) {
                if (prop === 'val') return () => state.uri;
                if (prop === 'text') return (v) => { if (v !== undefined) texts.push(String(v)); return jq; };
                if (prop === '0') return undefined;
                return () => jq;
            },
        });
        return jq;
    };

    const window = {
        yuki: {
            download: {
                // 记录时 JSON 归一化：vm realm 里创建的对象字面量与宿主原型不同，
                // 直接存引用会让 deepStrictEqual 误判「结构相同但非引用相等」
                control: async (op, payload) => {
                    calls.push({ op, payload: payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)) });
                    // controlResult 为 undefined 时原样返回（removeTask 有「r 为空」分支要覆盖）
                    return state.controlResult === undefined ? undefined
                        : JSON.parse(JSON.stringify(state.controlResult));
                },
                play: async (video) => {
                    calls.push({ op: 'play', payload: video === undefined ? undefined : JSON.parse(JSON.stringify(video)) });
                    return state.playResult === undefined ? undefined
                        : JSON.parse(JSON.stringify(state.playResult));
                },
                openDir: async () => ({ ok: true }),
                onList: () => {},
                onEvent: () => {},
                onGoto: () => {},
            },
        },
    };
    const context = {
        console, setTimeout, clearTimeout,
        $: () => makeJq(),
        warnToast: (m) => toasts.push(m),
        fmtSize: (n) => `${n}B`,
        confirmDialog: async () => state.confirmResult,
        openDialog: (id) => dialogs.push(['open', id]),
        closeDialog: (id) => dialogs.push(['close', id]),
        localPlayToast: (r) => plays.push(r),
        localStorage: { getItem: () => null, setItem() {} },
        window,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testDownloads = Downloads;`, context, { filename: 'downloads.js' });
    return { D: context.__testDownloads, calls, toasts, dialogs, texts, plays, state, context };
}

// ---------------------------------------------------------------- 挂载方式

test('挂载：Downloads 以 window.YUKI.downloads 挂载，弹窗按钮函数为全局函数', () => {
    const { D, context } = loadDownloads();
    assert.equal(context.window.YUKI.downloads, D, '源码 IIFE 应把 Downloads 挂到 window.YUKI.downloads');
    // index.html 内联 onclick 直接调用这三个全局函数（Esc 兜底同走 _dlRemoveResolve）
    assert.equal(typeof context.dlRemoveFiles, 'function');
    assert.equal(typeof context.dlRemoveTaskOnly, 'function');
    assert.equal(typeof context.dlRemoveCancel, 'function');
});

// ---------------------------------------------------------------- removeTask

test('removeTask：点「连文件删除」→ control("remove", {gid, deleteFiles:true})', async () => {
    const { D, calls, toasts, dialogs, context } = loadDownloads();
    const p = D.removeTask({ gid: 'g1', name: '视频A' });
    // _confirmRemove 在 Promise 执行器里同步挂 resolve（openDialog 后供按钮/Esc 兜底）
    assert.ok(context.window._dlRemoveResolve, '确认弹窗打开后应在 window 上挂 resolve');
    assert.deepEqual(dialogs, [['open', 'dlRemoveDialog']]);
    context.dlRemoveFiles(); // index.html 内联 onclick 的真实入口
    await p;
    assert.deepEqual(calls, [{ op: 'remove', payload: { gid: 'g1', deleteFiles: true } }]);
    assert.ok(toasts.includes('已删除任务及文件'));
    assert.deepEqual(dialogs, [['open', 'dlRemoveDialog'], ['close', 'dlRemoveDialog']], 'resolve 后应关弹窗');
    assert.equal(context.window._dlRemoveResolve, null, 'resolve 应清槽，防重复触发');
});

test('removeTask：点「仅移除任务」→ deleteFiles=false（文件保留）', async () => {
    const { D, calls, toasts, context } = loadDownloads();
    const p = D.removeTask({ gid: 'g2', name: '视频B' });
    context.dlRemoveTaskOnly();
    await p;
    assert.deepEqual(calls, [{ op: 'remove', payload: { gid: 'g2', deleteFiles: false } }]);
    assert.ok(toasts.includes('已移除任务（文件保留在下载目录）'));
});

test('removeTask：Esc 兜底取消 → 不发 IPC', async () => {
    const { D, calls, context } = loadDownloads();
    const p = D.removeTask({ gid: 'g3', name: '视频C' });
    context.dlRemoveCancel(); // closeDialog 的 Esc 兜底按取消处理
    await p;
    assert.deepEqual(calls, [], '取消后不得调用删除 IPC');
    assert.equal(context.window._dlRemoveResolve, null);
});

test('removeTask：任务名超 60 字截断加省略号；task 为空直接返回', async () => {
    const { D, calls, texts, context } = loadDownloads();
    await D.removeTask(null);
    assert.deepEqual(calls, [], '无任务时不得发 IPC，也不得开弹窗');
    const longName = '名'.repeat(65);
    const p = D.removeTask({ gid: 'g4', name: longName });
    context.dlRemoveCancel();
    await p;
    assert.equal(texts.length, 1);
    assert.ok(texts[0].endsWith('…'), '超长名应以省略号结尾');
    assert.equal(texts[0].length, 61, '截断为 60 字 + 省略号');
});

test('removeTask：IPC 返回空 → 提示「删除失败」', async () => {
    const { D, toasts, state, context } = loadDownloads();
    state.controlResult = undefined;
    const p = D.removeTask({ gid: 'g5', name: '视频D' });
    context.dlRemoveFiles();
    await p;
    assert.ok(toasts.includes('删除失败'));
});

// ---------------------------------------------------------------- clearFailed

test('clearFailed：确认弹窗取消 → 不调 control("clearFailed")', async () => {
    const { D, calls, state } = loadDownloads();
    state.confirmResult = false;
    await D.clearFailed();
    assert.deepEqual(calls, []);
});

test('clearFailed：确认后转发 control("clearFailed")，按 n 给结果提示', async () => {
    const { D, calls, toasts, state } = loadDownloads();
    state.controlResult = { ok: true, n: 2 };
    await D.clearFailed();
    assert.deepEqual(calls, [{ op: 'clearFailed', payload: {} }]);
    assert.ok(toasts.includes('已删除 2 个失败任务'));
});

test('clearFailed：n=0 与失败分支的提示文案', async () => {
    const { D, toasts, state } = loadDownloads();
    state.controlResult = { ok: true, n: 0 };
    await D.clearFailed();
    assert.ok(toasts.includes('当前没有失败任务'));
    state.controlResult = { ok: false, reason: 'engine-down' };
    await D.clearFailed();
    assert.ok(toasts.includes('删除失败：engine-down'));
});

// ---------------------------------------------------------------- addUri（m3u8 路由）

test('addUri：m3u8 链接走 addHls，普通链接走 add（含带 query 的 m3u8）', async () => {
    const { D, calls, toasts, state } = loadDownloads();
    state.uri = 'https://example.com/a.m3u8?token=1';
    await D.addUri();
    assert.deepEqual(calls, [{ op: 'addHls', payload: { uri: state.uri } }]);
    assert.ok(toasts.includes('已加入下载队列'));

    calls.length = 0; toasts.length = 0;
    state.uri = 'https://example.com/b.mp4';
    await D.addUri();
    assert.deepEqual(calls, [{ op: 'add', payload: { uri: state.uri } }], '非 m3u8 应走普通 add 通道');
});

test('addUri：空输入 → 不发 IPC 并提示', async () => {
    const { D, calls, toasts, state } = loadDownloads();
    state.uri = '   ';
    await D.addUri();
    assert.deepEqual(calls, []);
    assert.ok(toasts.includes('请先在上方输入框粘贴视频链接'));
});

// ---------------------------------------------------------------- play（输出文件选择）

test('play：优先取第一个视频扩展名文件', async () => {
    const { D, calls, plays } = loadDownloads();
    await D.play({ gid: 'g6', files: ['/dl/a.mkv', '/dl/n.txt'] });
    assert.deepEqual(calls, [{ op: 'play', payload: '/dl/a.mkv' }]);
    assert.equal(plays.length, 1, '播放成功应走 localPlayToast');
});

test('play：无扩展名文件兜底（多文件取首个无后缀；单文件直接交 mpv 探测）', async () => {
    const { D, calls } = loadDownloads();
    await D.play({ gid: 'g7', files: ['/dl/s1', '/dl/s2'] });
    assert.deepEqual(calls, [{ op: 'play', payload: '/dl/s1' }]);
    calls.length = 0;
    await D.play({ gid: 'g8', files: ['/dl/blob'] });
    assert.deepEqual(calls, [{ op: 'play', payload: '/dl/blob' }]);
});

test('play：无产出文件不调 play；mpv 缺失给安装指引', async () => {
    const { D, calls, toasts, state } = loadDownloads();
    await D.play({ gid: 'g9', files: [] });
    assert.deepEqual(calls, []);
    assert.ok(toasts.includes('找不到输出文件'));

    state.playResult = { ok: false, reason: 'mpv-missing' };
    await D.play({ gid: 'g10', files: ['/dl/a.mp4'] });
    assert.ok(toasts.includes('mpv 未安装：node scripts/download-binaries.js mpv'));
});
