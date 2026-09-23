/**
 * preload.js 桥接契约测试（黑盒）。
 *
 * 关注「渲染层通过 window.yuki.* 能调用到什么、参数如何传递、返回值如何回传」
 * 这一契约面，不关心主进程侧实现：
 *   - 注入假 electron 到 require.cache，真实加载 src/preload/preload.js（不起 Electron）
 *   - 记录所有 ipcRenderer.invoke / on / send 的频道与参数，断言透传行为
 *   - 扫描渲染层源码交叉验证「用到的 API 必须存在 / 暴露了却没人用的死接口」
 *
 * 与其它测试的边界：
 *   - api-contract.test.js / file-manager-ipc.test.js 测的是**主进程 ipcMain 侧**语义；
 *     本文件测的是**preload 桥接层**的形状与透传，不重复覆盖主进程业务。
 *   - renderer-globals-contract.test.js 测渲染层跨文件全局函数；本文件只测
 *     渲染层 → preload 的垂直契约。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD_PATH = path.join(ROOT, 'src', 'preload', 'preload.js');
const PRELOAD_SRC = fs.readFileSync(PRELOAD_PATH, 'utf8');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer', 'js');
const RENDERER_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const MAIN_DIR = path.join(ROOT, 'src', 'main');
// electron 只被 require.resolve 定位（用于注入 require.cache 假模块），从不真正加载
const ELECTRON_ID = require.resolve('electron', { paths: [ROOT] });

/**
 * 用假 electron 真实加载 preload.js，返回暴露出来的 yuki 对象与全部 IPC 记录。
 * 每次调用都是全新模块实例（_settingsCache 等模块级状态不跨用例残留）。
 */
function loadPreload(opts = {}) {
    const actions = [];       // { kind: 'invoke'|'on'|'send', channel, args }
    const zoom = [];          // webFrame.setZoomFactor 收到的参数
    const removed = [];       // removeListener / removeAllListeners 调用
    const listeners = new Map();
    const handlers = opts.handlers || {};

    const electron = {
        contextBridge: {
            exposeInMainWorld: (name, api) => { state.name = name; state.api = api; },
        },
        ipcRenderer: {
            invoke: (channel, ...args) => {
                actions.push({ kind: 'invoke', channel, args });
                if (opts.throwOnInvoke) throw new Error('ipc-stub-sync-throw');
                if (!Object.prototype.hasOwnProperty.call(handlers, channel)) {
                    return opts.unknownReject
                        ? Promise.reject(new Error(`No handler registered for '${channel}'`))
                        : Promise.resolve(undefined);
                }
                try {
                    return Promise.resolve(handlers[channel](...args));
                } catch (e) {
                    return Promise.reject(e);
                }
            },
            send: (channel, ...args) => { actions.push({ kind: 'send', channel, args }); },
            on: (channel, listener) => {
                actions.push({ kind: 'on', channel, args: [listener] });
                if (!listeners.has(channel)) listeners.set(channel, []);
                listeners.get(channel).push(listener);
            },
            removeListener: (channel, listener) => { removed.push({ channel, listener }); },
            removeAllListeners: (channel) => { removed.push({ channel }); },
        },
        webFrame: {
            setZoomFactor: (factor) => {
                zoom.push(factor);
                if (opts.zoomThrows) throw new Error('webFrame-stub-throw');
            },
        },
    };

    const state = { actions, zoom, removed, listeners, name: null, api: null };
    state.emit = (channel, payload) => {
        const ls = listeners.get(channel) || [];
        for (const l of ls) l({ senderId: 1 }, payload); // 主进程侧 (event, payload) 形态
    };

    const prevElectron = require.cache[ELECTRON_ID];
    require.cache[ELECTRON_ID] = {
        id: ELECTRON_ID, filename: ELECTRON_ID, loaded: true,
        exports: electron, children: [], paths: [],
    };
    delete require.cache[PRELOAD_PATH];
    try {
        require(PRELOAD_PATH);
    } finally {
        if (prevElectron) require.cache[ELECTRON_ID] = prevElectron;
        else delete require.cache[ELECTRON_ID];
        delete require.cache[PRELOAD_PATH];
    }
    assert.ok(state.api, 'preload 必须通过 contextBridge.exposeInMainWorld 暴露一个对象');
    return state;
}

/** 展平嵌套命名空间（download.* / syncplay.* / dlna.*）为 'a.b' 形式的方法清单。 */
function flatten(api) {
    const out = new Map();
    for (const [k, v] of Object.entries(api)) {
        if (typeof v === 'function') out.set(k, v);
        else if (v && typeof v === 'object') {
            for (const [k2, v2] of Object.entries(v)) out.set(`${k}.${k2}`, v2);
        }
    }
    return out;
}

/** 取某次 load 里的 invoke 记录（按频道过滤）。 */
function invokes(state, channel) {
    return state.actions.filter((a) => a.kind === 'invoke' && a.channel === channel);
}

/** 渲染层全部脚本（跳过第三方压缩库）。 */
function rendererSources() {
    const files = fs.readdirSync(RENDERER_DIR)
        .filter((f) => f.endsWith('.js') && f !== 'jquery.min.js')
        .map((f) => ({ name: `src/renderer/js/${f}`, src: fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8') }));
    files.push({ name: 'src/renderer/index.html', src: fs.readFileSync(RENDERER_HTML, 'utf8') });
    return files;
}

/** 扫描渲染层 `yuki.xxx(` / `yuki.ns.xxx(` 调用点。 */
function rendererCallSites() {
    const re = /(?:window\.)?yuki\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\s*\(/g;
    const out = new Map();
    for (const f of rendererSources()) {
        let m;
        while ((m = re.exec(f.src)) !== null) {
            const key = m[2] ? `${m[1]}.${m[2]}` : m[1];
            if (!out.has(key)) out.set(key, `${f.name}:${f.src.slice(0, m.index).split('\n').length}`);
        }
    }
    return out;
}

/** 主进程侧出现过的全部 IPC 频道字符串（ipcMain.handle/on + webContents.send）。 */
function mainChannels() {
    const found = new Set();
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) {
                const src = fs.readFileSync(p, 'utf8');
                for (const m of src.matchAll(/'((?:yuki:|backend-)[A-Za-z0-9:_-]*)'/g)) found.add(m[1]);
            }
        }
    };
    walk(MAIN_DIR);
    return found;
}

// ---------------------------------------------------------------------------
// 1. 形状契约
// ---------------------------------------------------------------------------

test('contextBridge 只暴露一个全局命名空间且名字固定为 yuki', () => {
    const state = loadPreload();
    assert.equal(state.name, 'yuki',
        'preload 必须把桥接对象挂到 window.yuki（渲染层全库按此名字访问）');
});

test('暴露对象的每个叶子都是函数：不泄漏 ipcRenderer / webFrame 等原始能力', () => {
    const state = loadPreload();
    const flat = flatten(state.api);
    const bad = [];
    for (const [k, v] of Object.entries(state.api)) {
        if (typeof v !== 'function' && !(v && typeof v === 'object')) bad.push(`${k}(${typeof v})`);
    }
    for (const [k, v] of flat) {
        if (typeof v !== 'function') bad.push(`${k}(${typeof v})`);
    }
    assert.deepEqual(bad, [], 'contextBridge 只能暴露函数/函数命名空间，实际异常项：' + bad.join(', '));
    for (const forbidden of ['ipcRenderer', 'webFrame', 'contextBridge', 'require', 'process']) {
        assert.equal(forbidden in state.api, false, `不得把 ${forbidden} 直接暴露给渲染层`);
    }
});

test('API 全集快照：暴露的方法名清单与契约清单完全一致（新增/删除都必须显式确认）', () => {
    // 这是本文件的核心锚点：任何一次 preload 改动都会在这里显形，
    // 迫使改动者同步确认渲染层调用点（防止「悄悄加了个接口没人用/悄悄删了还在用」）。
    const EXPECTED = [
        'getBackendInfo', 'configState', 'onBackendReady', 'onBackendState',
        'playUrl', 'playerControl', 'playerState', 'onPlayerEnded', 'onPlayerExit',
        'onA4kChanged', 'onEpisodeSkip', 'onExternalPlayerExit', 'buildPlaylist',
        'fileRoot', 'filePickRoot', 'fileList', 'fileOpenDir', 'fileThumb',
        'fileNewFolder', 'fileDelFile', 'fileDelFolder', 'filePush',
        'download.control', 'download.pickDir', 'download.openDir', 'download.onList',
        'download.onEvent', 'download.onGoto', 'download.play',
        'pushUrl', 'pushInfo', 'onPushReceived',
        'resolveParse', 'captureDirect', 'cancelRuntime', 'captchaVerify',
        'pickWallpaper', 'appVersion', 'winMinimize', 'winMaximize', 'winClose', 'fontCss',
        'settingsGet', 'settingsSet', 'settingsReset', 'pickCacheDir', 'pickFolder',
        'clearAppCaches', 'getAppCacheSize', 'updateHotkeys', 'updatePlayerPrefs',
        'mpvScreenshot', 'loadDanmaku', 'mpvScreenshotDir',
        'onConfigReloaded', 'onUpdateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate',
        'onMouseNav', 'probeUrls', 'pickMpv', 'clearMpvPath', 'mpvPath', 'downloadMpv',
        'onMpvDownloadState', 'onPlayerSpawnError', 'assetStatus',
        'syncplay.connect', 'syncplay.disconnect', 'syncplay.sendState', 'syncplay.sendFile',
        'syncplay.sendChat', 'syncplay.onState', 'syncplay.onChat', 'syncplay.onFile',
        'syncplay.onUsers', 'syncplay.onDisconnect', 'syncplay.onError',
        'dlna.search', 'dlna.cast', 'dlna.stop', 'dlna.onDevices', 'dlna.onError',
        'externalPlayer', 'pickPlayer', 'playerConfig', 'clearPlayer', 'shutdownTimer',
        'setProxy', 'setPanFastPath', 'testProxy', 'setDandan',
        'getLogs', 'logRenderer', 'clearLogs', 'setLogLevel', 'setLogCleanup',
        'onboardingDone', 'panQrLogin', 'panQrCancel', 'setZoomFactor',
    ];
    const actual = [...flatten(loadPreload().api).keys()].sort();
    assert.deepEqual(actual, [...EXPECTED].sort(),
        'preload 暴露的 API 清单发生变化，请确认渲染层调用点同步更新后，再修订本契约清单');
    assert.equal(actual.length, EXPECTED.length, '契约清单内部不得有重复项');
});

test('渲染层调用的每一个 yuki API 都必须在 preload 里有定义（契约不断裂）', () => {
    const defined = new Set(flatten(loadPreload().api).keys());
    const missing = [];
    for (const [key, at] of rendererCallSites()) {
        if (!defined.has(key)) missing.push(`${key}（${at}）`);
    }
    assert.deepEqual(missing, [],
        '以下 API 被渲染层调用但 preload 未定义（点了没反应的静默失效）：\n  ' + missing.join('\n  '));
});

test('死接口审计：preload 暴露但渲染层从不使用的 API 恰好是已确认清单（新增死接口立即显形）', () => {
    const defined = new Set(flatten(loadPreload().api).keys());
    const used = new Set(rendererCallSites().keys());
    // 2026-09-23 实测：这 27 个接口渲染层零调用点。其中 syncplay.*（11 个）与
    // dlna.*（5 个）是成体系的「主进程已实现、前端无入口」；其余为单个孤儿接口。
    const KNOWN_DEAD = [
        'onBackendState', 'playerState', 'fileRoot', 'pushUrl', 'pushInfo', 'pickFolder',
        'mpvScreenshot', 'pickMpv', 'clearMpvPath', 'mpvPath', 'onMpvDownloadState',
        'syncplay.connect', 'syncplay.disconnect', 'syncplay.sendState', 'syncplay.sendFile',
        'syncplay.sendChat', 'syncplay.onState', 'syncplay.onChat', 'syncplay.onFile',
        'syncplay.onUsers', 'syncplay.onDisconnect', 'syncplay.onError',
        'dlna.search', 'dlna.cast', 'dlna.stop', 'dlna.onDevices', 'dlna.onError',
    ];
    const dead = [...defined].filter((k) => !used.has(k)).sort();
    assert.deepEqual(dead, [...KNOWN_DEAD].sort(),
        'preload 死接口清单发生变化：新增了没人用的桥接，或某个死接口终于被接线'
        + '（后者请从本清单移除）。实际：\n  ' + dead.join('\n  '));
});

test('渲染层不存在 yuki 解构或动态属性访问（保证上面的调用点扫描是完备的）', () => {
    const suspicious = [];
    for (const f of rendererSources()) {
        for (const m of f.src.matchAll(/\}\s*=\s*(?:window\.)?yuki\b/g)) suspicious.push(`${f.name}: 解构 ${m[0]}`);
        for (const m of f.src.matchAll(/(?:window\.)?yuki\[/g)) suspicious.push(`${f.name}: 动态下标 ${m[0]}`);
    }
    assert.deepEqual(suspicious, [],
        '出现解构/动态访问时本文件的正则扫描会漏判，需改用具名访问或同步升级扫描：\n  '
        + suspicious.join('\n  '));
});

test('每个 IPC 频道都在主进程侧有注册（preload 与 ipcMain 频道名零漂移）', () => {
    const used = new Set();
    for (const m of PRELOAD_SRC.matchAll(/ipcRenderer\.(?:invoke|on|send)\(\s*'([^']+)'/g)) used.add(m[1]);
    assert.ok(used.size >= 80, 'preload 应涉及大量频道，实际解析出 ' + used.size);
    const registered = mainChannels();
    const orphan = [...used].filter((c) => !registered.has(c)).sort();
    assert.deepEqual(orphan, [],
        '以下频道 preload 在调用/订阅，但 src/main 全库找不到对应字符串（调用后无响应）：\n  '
        + orphan.join('\n  '));
});

// ---------------------------------------------------------------------------
// 2. 调用转发
// ---------------------------------------------------------------------------

test('全量调用矩阵：每个 API 都恰好产生一次 IPC 动作（无空实现、无重复发送）', () => {
    const state = loadPreload();
    const flat = flatten(state.api);
    const broken = [];
    for (const [name, fn] of flat) {
        if (name === 'setZoomFactor') continue; // 唯一不走 IPC 的接口（走 webFrame）
        state.actions.length = 0;
        const arg = name.startsWith('on') || name.includes('.on') ? () => {} : 1;
        fn(arg, 2, 3);
        if (state.actions.length !== 1) {
            broken.push(`${name} → ${state.actions.length} 次 IPC`);
        }
    }
    assert.deepEqual(broken, [],
        '以下 API 调用后没产生且仅产生一次 IPC 动作：\n  ' + broken.join('\n  '));
});

test('无参方法不传多余参数：所有 0 元函数 invoke 的 args 长度为 0', () => {
    const state = loadPreload();
    const flat = flatten(state.api);
    // download.pickDir 是 0 元便捷封装，内部固定打 ('pickDir', {})——属于刻意的
    // 常量转发（已在「下载类」用例里显式断言），不参与本条的「不携带参数」判定。
    const EXEMPT = new Set(['setZoomFactor', 'download.pickDir']);
    const bad = [];
    for (const [name, fn] of flat) {
        if (EXEMPT.has(name) || fn.length !== 0) continue;
        state.actions.length = 0;
        fn();
        const a = state.actions[0];
        if (!a || a.args.length !== 0) bad.push(`${name} → args=${JSON.stringify(a && a.args)}`);
    }
    assert.ok(bad.length === 0, '0 元方法不应携带任何参数（主进程 handler 形参为空）：\n  ' + bad.join('\n  '));
});

test('播放类：playUrl 把 {url,meta} 打包到 yuki:play', async () => {
    const state = loadPreload({ handlers: { 'yuki:play': () => ({ ok: true, started: true }) } });
    const meta = { title: '第1集', site: 'csp' };
    const r = await state.api.playUrl('http://a.m3u8', meta);
    const call = invokes(state, 'yuki:play')[0];
    assert.deepEqual(call.args, [{ url: 'http://a.m3u8', meta }], 'playUrl 必须打包成单个对象载荷');
    assert.deepEqual(r, { ok: true, started: true });
});

test('播放类：playerControl 按 (cmd,value) 原样透传 yuki:player（无 cmd 白名单）', async () => {
    const state = loadPreload({ handlers: { 'yuki:player': (cmd, value) => ({ ok: true, cmd, value }) } });
    const r = await state.api.playerControl('seek', 12.5);
    assert.deepEqual(invokes(state, 'yuki:player')[0].args, ['seek', 12.5]);
    assert.deepEqual(r, { ok: true, cmd: 'seek', value: 12.5 });
    await state.api.playerControl('pause');
    const second = invokes(state, 'yuki:player')[1];
    assert.deepEqual(second.args, ['pause', undefined], '单参调用仍是两参签名（value=undefined）');
});

test('播放类：playerState / buildPlaylist 频道与参数透传', async () => {
    const state = loadPreload({
        handlers: {
            'yuki:player-state': () => ({ available: true, playing: false }),
            'yuki:playlist-build': (q) => ({ ok: true, len: q.eps.length }),
        },
    });
    assert.deepEqual(await state.api.playerState(), { available: true, playing: false });
    const queue = { site: 's', eps: [{ id: '1', name: '第1集' }], start: 0 };
    assert.deepEqual(await state.api.buildPlaylist(queue), { ok: true, len: 1 });
    assert.deepEqual(invokes(state, 'yuki:playlist-build')[0].args, [queue], '整季队列原样透传');
});

test('文件类：fileList / fileOpenDir / fileNewFolder / fileDelFile / fileDelFolder / fileThumb / filePush 参数透传', async () => {
    const state = loadPreload();
    await state.api.fileList('剧名');
    await state.api.fileOpenDir('剧名/季1');
    await state.api.fileNewFolder('剧名', '季2');
    await state.api.fileDelFile('剧名/a.mp4');
    await state.api.fileDelFolder('剧名/季2');
    await state.api.fileThumb('剧名/a.mp4');
    await state.api.filePush('剧名/a.mp4');
    assert.deepEqual(invokes(state, 'yuki:file-list')[0].args, ['剧名']);
    assert.deepEqual(invokes(state, 'yuki:file-open-dir')[0].args, ['剧名/季1']);
    assert.deepEqual(invokes(state, 'yuki:file-new-folder')[0].args, ['剧名', '季2']);
    assert.deepEqual(invokes(state, 'yuki:file-del-file')[0].args, ['剧名/a.mp4']);
    assert.deepEqual(invokes(state, 'yuki:file-del-folder')[0].args, ['剧名/季2']);
    assert.deepEqual(invokes(state, 'yuki:file-thumb')[0].args, ['剧名/a.mp4']);
    assert.deepEqual(invokes(state, 'yuki:file-push')[0].args, ['剧名/a.mp4']);
});

test('文件类：rel 传 undefined/null 时兜底为空字符串（根目录语义）', async () => {
    const state = loadPreload();
    await state.api.fileList();
    await state.api.fileList(undefined);
    await state.api.fileList(null);
    await state.api.fileOpenDir(null);
    await state.api.fileNewFolder(null, '新建文件夹');
    const lists = invokes(state, 'yuki:file-list');
    assert.deepEqual(lists.map((c) => c.args), [[''], [''], ['']], '空 rel 必须归一化为空串而非 undefined');
    assert.deepEqual(invokes(state, 'yuki:file-open-dir')[0].args, ['']);
    assert.deepEqual(invokes(state, 'yuki:file-new-folder')[0].args, ['', '新建文件夹']);
});

test('文件类：fileRoot / filePickRoot 是无参频道', async () => {
    const state = loadPreload({ handlers: { 'yuki:file-root': () => ({ ok: true, root: 'D:\\dl' }) } });
    assert.deepEqual(await state.api.fileRoot(), { ok: true, root: 'D:\\dl' });
    await state.api.filePickRoot();
    for (const ch of ['yuki:file-root', 'yuki:file-pick-root']) {
        assert.equal(invokes(state, ch)[0].args.length, 0, `${ch} 不接受参数`);
    }
});

test('下载类：download.control 透传 (action,payload)，缺失/falsy payload 归一为 {}', async () => {
    const state = loadPreload({ handlers: { 'yuki:dl': (action, payload) => ({ action, payload }) } });
    assert.deepEqual(await state.api.download.control('add', { uri: 'http://x' }),
        { action: 'add', payload: { uri: 'http://x' } });
    await state.api.download.control('init');
    await state.api.download.control('pause', 0);
    await state.api.download.control('clear', '');
    const calls = invokes(state, 'yuki:dl');
    assert.deepEqual(calls[1].args, ['init', {}], '缺 payload 必须补空对象');
    assert.deepEqual(calls[2].args, ['pause', {}], 'falsy payload 归一为空对象');
    assert.deepEqual(calls[3].args, ['clear', {}]);
});

test('下载类：download.pickDir 固定 action=pickDir；openDir / play 频道正确', async () => {
    const state = loadPreload({ handlers: { 'yuki:dl': (a) => ({ a }) } });
    assert.deepEqual(await state.api.download.pickDir(), { a: 'pickDir' });
    assert.deepEqual(invokes(state, 'yuki:dl')[0].args, ['pickDir', {}]);
    await state.api.download.openDir();
    assert.equal(invokes(state, 'yuki:dl-open-dir').length, 1, 'openDir 走独立频道 yuki:dl-open-dir');
    await state.api.download.play('D:\\dl\\a.mp4');
    assert.deepEqual(invokes(state, 'yuki:dl-play')[0].args, ['D:\\dl\\a.mp4']);
});

test('解析类：resolveParse 无 parses/context 时发送裸 url 字符串（兼容旧主进程签名）', async () => {
    const state = loadPreload({ handlers: { 'yuki:parse': (p) => ({ url: p }) } });
    const r = await state.api.resolveParse('http://v.qq.com/x');
    assert.equal(invokes(state, 'yuki:parse')[0].args.length, 1, '单参形态只发一个参数');
    assert.equal(invokes(state, 'yuki:parse')[0].args[0], 'http://v.qq.com/x', '必须发裸字符串');
    assert.deepEqual(r, { url: 'http://v.qq.com/x' });
});

test('解析类：resolveParse 带 parses 或 context 时打包为对象（context 展开到顶层）', async () => {
    const state = loadPreload({ handlers: { 'yuki:parse': (p) => p } });
    await state.api.resolveParse('http://u', ['json:电影', 'parse:好家伙']);
    await state.api.resolveParse('http://u', null);
    await state.api.resolveParse('http://u', undefined, { site: 'csp', ep: 3 });
    const calls = invokes(state, 'yuki:parse');
    assert.deepEqual(calls[0].args[0], { url: 'http://u', parses: ['json:电影', 'parse:好家伙'] });
    assert.deepEqual(calls[1].args[0], { url: 'http://u', parses: null }, 'parses=null 仍走对象形态');
    assert.deepEqual(calls[2].args[0], { url: 'http://u', parses: undefined, site: 'csp', ep: 3 });
});

test('解析类：captureDirect legacy 归一为布尔且 context 展开；cancelRuntime 空值补 {}', async () => {
    const state = loadPreload();
    await state.api.captureDirect('http://share/1');
    await state.api.captureDirect('http://share/1', 1);
    await state.api.captureDirect('http://share/1', true, { site: 'k' });
    await state.api.cancelRuntime();
    await state.api.cancelRuntime({ sessionId: 7 });
    const caps = invokes(state, 'yuki:capture-direct');
    assert.deepEqual(caps[0].args[0], { url: 'http://share/1', legacy: false }, 'legacy 缺省为 false');
    assert.deepEqual(caps[1].args[0], { url: 'http://share/1', legacy: true }, 'truthy 归一为 true');
    assert.deepEqual(caps[2].args[0], { url: 'http://share/1', legacy: true, site: 'k' });
    const cancels = invokes(state, 'yuki:runtime-cancel');
    assert.deepEqual(cancels[0].args, [{}]);
    assert.deepEqual(cancels[1].args, [{ sessionId: 7 }]);
});

test('解析类：captchaVerify 把 url 包装成 {url}', async () => {
    const state = loadPreload();
    await state.api.captchaVerify('https://captcha.site/verify');
    assert.deepEqual(invokes(state, 'yuki:captcha-verify')[0].args,
        [{ url: 'https://captcha.site/verify' }]);
});

test('窗口类：winMinimize / winMaximize / winClose 各自独立无参频道', async () => {
    const state = loadPreload();
    await state.api.winMinimize();
    await state.api.winMaximize();
    await state.api.winClose();
    for (const ch of ['yuki:win-minimize', 'yuki:win-maximize', 'yuki:win-close']) {
        const calls = invokes(state, ch);
        assert.equal(calls.length, 1, `${ch} 应被调用一次`);
        assert.equal(calls[0].args.length, 0, `${ch} 不接受参数`);
    }
});

test('日志类：getLogs 三参顺序、logRenderer 两参、clearLogs/setLogLevel/setLogCleanup 透传', async () => {
    const state = loadPreload();
    await state.api.getLogs(1, 20, 'app');
    await state.api.logRenderer('error', '渲染层炸了');
    await state.api.setLogLevel('DEBUG');
    await state.api.setLogCleanup({ enabled: true, days: 7 });
    await state.api.clearLogs();
    assert.deepEqual(invokes(state, 'yuki:get-logs')[0].args, [1, 20, 'app']);
    assert.deepEqual(invokes(state, 'yuki:log-renderer')[0].args, ['error', '渲染层炸了']);
    assert.deepEqual(invokes(state, 'yuki:set-log-level')[0].args, ['DEBUG']);
    assert.deepEqual(invokes(state, 'yuki:set-log-cleanup')[0].args, [{ enabled: true, days: 7 }]);
    assert.equal(invokes(state, 'yuki:clear-logs')[0].args.length, 0);
});

test('系统/设置类：一批代表性接口的频道与参数透传', async () => {
    const state = loadPreload();
    await state.api.shutdownTimer(30);
    await state.api.setProxy({ url: 'http://127.0.0.1:7890', enable: true });
    await state.api.setPanFastPath(1);
    await state.api.setPanFastPath(0);
    await state.api.testProxy({ proxyUrl: 'http://p', url: 'http://t' });
    await state.api.setDandan({ appid: 'a', secret: 's' });
    await state.api.pickCacheDir('D:\\cache');
    await state.api.pickCacheDir();
    await state.api.externalPlayer('http://m3u8', { header: 'Referer: x' });
    await state.api.externalPlayer('http://m3u8');
    await state.api.probeUrls(['http://a', 'http://b']);
    await state.api.assetStatus(true);
    await state.api.assetStatus();
    assert.deepEqual(invokes(state, 'yuki:shutdown-timer')[0].args, [30], 'minutes=0 语义为取消，不得归一');
    assert.deepEqual(invokes(state, 'yuki:set-proxy')[0].args, [{ url: 'http://127.0.0.1:7890', enable: true }]);
    assert.deepEqual(invokes(state, 'yuki:set-pan-fast-path')[0].args, [true], '开关归一为布尔');
    assert.deepEqual(invokes(state, 'yuki:set-pan-fast-path')[1].args, [false]);
    assert.deepEqual(invokes(state, 'yuki:test-proxy')[0].args, [{ proxyUrl: 'http://p', url: 'http://t' }]);
    assert.deepEqual(invokes(state, 'yuki:set-dandan')[0].args, [{ appid: 'a', secret: 's' }]);
    assert.deepEqual(invokes(state, 'yuki:pick-cache-dir')[0].args, ['D:\\cache']);
    assert.deepEqual(invokes(state, 'yuki:pick-cache-dir')[1].args, [''], '不传 dir 弹选择框');
    assert.deepEqual(invokes(state, 'yuki:external-player')[0].args, ['http://m3u8', { header: 'Referer: x' }]);
    assert.deepEqual(invokes(state, 'yuki:external-player')[1].args, ['http://m3u8', {}], 'opts 缺省补 {}');
    assert.deepEqual(invokes(state, 'yuki:probe-urls')[0].args[0], ['http://a', 'http://b'], '批量地址数组原样透传');
    assert.deepEqual(invokes(state, 'yuki:asset-status')[0].args, [true]);
    assert.deepEqual(invokes(state, 'yuki:asset-status')[1].args, [false], 'force 缺省为 false');
});

test('SyncPlay 命名空间：五个方法频道与参数透传', async () => {
    const state = loadPreload({
        handlers: {
            'yuki:syncplay-connect': (o) => ({ joined: o.room }),
            'yuki:syncplay-state': (p, paused, seek) => ({ p, paused, seek }),
        },
    });
    assert.deepEqual(await state.api.syncplay.connect({ room: 'r1' }), { joined: 'r1' });
    assert.deepEqual(invokes(state, 'yuki:syncplay-connect')[0].args, [{ room: 'r1' }]);
    await state.api.syncplay.disconnect();
    assert.equal(invokes(state, 'yuki:syncplay-disconnect')[0].args.length, 0);
    assert.deepEqual(await state.api.syncplay.sendState(12.5, false, true),
        { p: 12.5, paused: false, seek: true });
    assert.deepEqual(invokes(state, 'yuki:syncplay-state')[0].args, [12.5, false, true]);
    await state.api.syncplay.sendFile('剧名 - 第1集.mkv', 1420);
    await state.api.syncplay.sendChat('大家好');
    assert.deepEqual(invokes(state, 'yuki:syncplay-file')[0].args, ['剧名 - 第1集.mkv', 1420]);
    assert.deepEqual(invokes(state, 'yuki:syncplay-chat')[0].args, ['大家好']);
});

test('DLNA 命名空间：search/cast/stop 频道与参数透传', async () => {
    const state = loadPreload({ handlers: { 'yuki:dlna-cast': (d, m, t) => ({ d, m, t }) } });
    await state.api.dlna.search();
    assert.equal(invokes(state, 'yuki:dlna-search')[0].args.length, 0);
    const r = await state.api.dlna.cast('http://dev/avt', 'http://media.m3u8', '第1集');
    assert.deepEqual(invokes(state, 'yuki:dlna-cast')[0].args, ['http://dev/avt', 'http://media.m3u8', '第1集']);
    assert.deepEqual(r, { d: 'http://dev/avt', m: 'http://media.m3u8', t: '第1集' });
    await state.api.dlna.stop('http://dev/avt');
    assert.deepEqual(invokes(state, 'yuki:dlna-stop')[0].args, ['http://dev/avt']);
});

test('杂项无参接口：频道名与「零参数」双正确', async () => {
    const state = loadPreload();
    // pushUrl（推送 URL 到 mpv）是 1 元接口，在下一个用例单独断言；这里只列零参接口。
    const pairs = [
        ['getBackendInfo', 'backend-info'], ['configState', 'yuki:config-state'],
        ['pickWallpaper', 'yuki:pick-wallpaper'], ['appVersion', 'yuki:app-version'],
        ['fontCss', 'yuki:font-css'], ['pickFolder', 'yuki:pick-folder'],
        ['clearAppCaches', 'yuki:clear-app-caches'], ['getAppCacheSize', 'yuki:cache-size'],
        ['updateHotkeys', 'yuki:update-hotkeys'], ['updatePlayerPrefs', 'yuki:update-player-prefs'],
        ['mpvScreenshot', 'yuki:mpv-screenshot'], ['mpvScreenshotDir', 'yuki:mpv-screenshot-dir'],
        ['checkForUpdates', 'yuki:check-for-updates'], ['downloadUpdate', 'yuki:update-download'],
        ['installUpdate', 'yuki:update-install'], ['pickMpv', 'yuki:pick-mpv'],
        ['clearMpvPath', 'yuki:clear-mpv-path'], ['mpvPath', 'yuki:mpv-path'],
        ['downloadMpv', 'yuki:download-mpv'], ['pickPlayer', 'yuki:pick-player'],
        ['playerConfig', 'yuki:player-config'], ['clearPlayer', 'yuki:clear-player'],
        ['onboardingDone', 'yuki:onboarding-done'], ['panQrLogin', 'yuki:pan-qr-login'],
        ['panQrCancel', 'yuki:pan-qr-cancel'],
        ['pushInfo', 'yuki:push-info'],
    ];
    for (const [name, channel] of pairs) {
        assert.equal(typeof state.api[name], 'function', `${name} 必须存在`);
        await state.api[name]();
        const calls = invokes(state, channel);
        assert.equal(calls.length, 1, `${name} 必须打到 ${channel}`);
        assert.equal(calls[0].args.length, 0, `${channel} 不接受参数`);
    }
});

test('pushUrl 把待推送 URL 直接透传（不做装箱）', async () => {
    const state = loadPreload({ handlers: { 'yuki:push-url': (u) => ({ ok: true, u }) } });
    assert.deepEqual(await state.api.pushUrl('http://lan/play.m3u8'), { ok: true, u: 'http://lan/play.m3u8' });
    assert.deepEqual(invokes(state, 'yuki:push-url')[0].args, ['http://lan/play.m3u8']);
});

test('loadDanmaku 把弹幕数组原样透传（不装箱）', async () => {
    const state = loadPreload({ handlers: { 'yuki:load-danmaku': (c) => ({ ok: true, count: c.length }) } });
    const comments = [{ time: 1, text: '前方高能' }, { time: 2, text: '233' }];
    assert.deepEqual(await state.api.loadDanmaku(comments), { ok: true, count: 2 });
    assert.deepEqual(invokes(state, 'yuki:load-danmaku')[0].args, [comments]);
});

// ---------------------------------------------------------------------------
// 3. 返回值回传
// ---------------------------------------------------------------------------

test('invoke 的 resolve 值原样回传给渲染层（同一对象引用，不二次包装）', async () => {
    const payload = { ok: true, path: 'D:\\shot\\1.png' };
    const state = loadPreload({ handlers: { 'yuki:mpv-screenshot': () => payload } });
    const r = await state.api.mpvScreenshot();
    assert.equal(r, payload, 'preload 不得包装/复制 resolve 结果');
});

test('invoke 的 reject 以同一 Error 对象回传给渲染层 catch', async () => {
    const boom = new Error('mpv-start-timeout');
    const state = loadPreload({ handlers: { 'yuki:play': () => { throw boom; } } });
    await assert.rejects(() => state.api.playUrl('http://x'), (e) => e === boom,
        '主进程拒绝必须原样冒泡到渲染层，便于按 reason 分支处理');
});

test('handler 返回 rejected Promise 时同样回传拒绝（异步失败路径）', async () => {
    const state = loadPreload({ handlers: { 'yuki:settings-get': () => Promise.reject(new Error('disk-error')) } });
    await assert.rejects(() => state.api.settingsGet(), /disk-error/);
});

test('多个并发 invoke 各自独立 resolve，互不串台', async () => {
    const state = loadPreload({
        handlers: {
            'yuki:file-thumb': (rel) => `thumb:${rel}`,
            'yuki:app-version': () => '1.2.3',
        },
    });
    const [t, v] = await Promise.all([state.api.fileThumb('a/b.mp4'), state.api.appVersion()]);
    assert.equal(t, 'thumb:a/b.mp4');
    assert.equal(v, '1.2.3');
});

test('settingsGet：主进程返回 null/undefined 时回退为空对象而非 null', async () => {
    const state = loadPreload({ handlers: { 'yuki:settings-get': () => null } });
    assert.deepEqual(await state.api.settingsGet(), {}, '渲染层普遍直接读 settings.xxx，null 会 TypeError');
});

// ---------------------------------------------------------------------------
// 4. 参数净化 / 设置缓存（外部可见行为）
// ---------------------------------------------------------------------------

test('settingsGet 3 秒 TTL 缓存：连续两次只读一次 IPC', async () => {
    let ipcCount = 0;
    const state = loadPreload({
        handlers: { 'yuki:settings-get': () => { ipcCount += 1; return { theme: 'dark', list: [] }; } },
    });
    const a = await state.api.settingsGet();
    const b = await state.api.settingsGet();
    assert.equal(ipcCount, 1, 'TTL 内的连续读必须命中内存缓存（settingsGet 被每页高频调用）');
    assert.deepEqual(b, { theme: 'dark', list: [] });
    assert.notEqual(a, b, '两次返回必须是不同对象');
});

test('settingsGet 返回深拷贝：调用方就地修改不污染缓存（recGet→push→recSet 场景）', async () => {
    const state = loadPreload({ handlers: { 'yuki:settings-get': () => ({ favs: ['a'] }) } });
    const first = await state.api.settingsGet();
    first.favs.push('b'); // 渲染层常见写法
    const second = await state.api.settingsGet();
    assert.deepEqual(second.favs, ['a'], '就地修改回写进了缓存会导致收藏/历史凭空多出条目');
});

test('settingsSet 写穿透：设置后 TTL 内 settingsGet 立即可见且不再走 IPC', async () => {
    let ipcCount = 0;
    const state = loadPreload({
        handlers: {
            'yuki:settings-get': () => { ipcCount += 1; return { theme: 'dark' }; },
            'yuki:settings-set': (k, v) => ({ ok: true, k, v }),
        },
    });
    await state.api.settingsGet();
    assert.deepEqual(await state.api.settingsSet('dlDir', 'D:\\dl'),
        { ok: true, k: 'dlDir', v: 'D:\\dl' }, 'settingsSet 的返回值即主进程返回值，原样回传');
    assert.deepEqual(invokes(state, 'yuki:settings-set')[0].args, ['dlDir', 'D:\\dl']);
    const after = await state.api.settingsGet();
    assert.deepEqual(after, { theme: 'dark', dlDir: 'D:\\dl' }, '写入必须立刻可读');
    assert.equal(ipcCount, 1, '写穿透后不应再拉全量');
});

test('settingsGet TTL 过期后重新拉全量（防主进程侧直写造成的陈旧）', async () => {
    let ipcCount = 0;
    const state = loadPreload({
        handlers: { 'yuki:settings-get': () => { ipcCount += 1; return { v: ipcCount }; } },
    });
    assert.deepEqual(await state.api.settingsGet(), { v: 1 });
    const realNow = Date.now;
    Date.now = () => realNow() + 5000; // 越过 3s TTL
    try {
        assert.deepEqual(await state.api.settingsGet(), { v: 2 }, 'TTL 后必须重新 IPC');
    } finally {
        Date.now = realNow;
    }
    assert.equal(ipcCount, 2);
});

test('settingsReset 清空缓存：下一次 settingsGet 重新拉全量', async () => {
    let ipcCount = 0;
    const state = loadPreload({
        handlers: {
            'yuki:settings-get': () => { ipcCount += 1; return { v: ipcCount }; },
            'yuki:settings-reset': () => ({ ok: true }),
        },
    });
    await state.api.settingsGet();
    await state.api.settingsGet();
    assert.equal(ipcCount, 1);
    assert.deepEqual(await state.api.settingsReset(), { ok: true });
    assert.deepEqual(await state.api.settingsGet(), { v: 2 }, '恢复默认后缓存必须失效');
});

test('settingsSet 在缓存未初始化时不猜测整体：后续 settingsGet 仍走全量 IPC', async () => {
    let ipcCount = 0;
    const state = loadPreload({
        handlers: {
            'yuki:settings-get': () => { ipcCount += 1; return { theme: 'dark' }; },
            'yuki:settings-set': () => ({ ok: true }),
        },
    });
    await state.api.settingsSet('zoom', 1.2); // 此前从未 settingsGet
    assert.deepEqual(await state.api.settingsGet(), { theme: 'dark' });
    assert.equal(ipcCount, 1, '未初始化缓存时不得凭单次写入伪造全量设置');
});

test('设置缓存深拷贝降级：写入含函数的对象不抛异常且函数被剔除', async () => {
    const state = loadPreload({
        handlers: {
            'yuki:settings-get': () => ({ base: 1 }),
            'yuki:settings-set': () => ({ ok: true }),
        },
    });
    await state.api.settingsGet();
    // structuredClone 无法克隆函数；桥接必须降级而不是抛 DataCloneError 打断渲染层
    await state.api.settingsSet('cb', { n: 5, fn: () => 'x' });
    const s = await state.api.settingsGet();
    assert.equal(typeof s.cb, 'object', '含函数的写入不得让缓存崩掉');
    assert.equal(s.cb.fn, undefined, '函数字段在序列化降级中被剔除（contextBridge 语义）');
    assert.equal(s.cb.n, 5, '可序列化字段必须保留');
});

test('setZoomFactor 走 webFrame 而非 IPC，且参数原样透传', () => {
    const state = loadPreload();
    state.api.setZoomFactor(1.25);
    assert.deepEqual(state.zoom, [1.25], '缩放必须落到 webFrame.setZoomFactor');
    assert.equal(state.actions.length, 0, '缩放不得产生任何 IPC 往返');
});

test('setZoomFactor 内部异常被吞掉：渲染层调用不炸', () => {
    const state = loadPreload({ zoomThrows: true });
    assert.doesNotThrow(() => state.api.setZoomFactor(2), 'webFrame 失败不应打断渲染流程');
    assert.deepEqual(state.zoom, [2]);
});

// ---------------------------------------------------------------------------
// 5. 事件订阅类 API
// ---------------------------------------------------------------------------

test('订阅类 API 名称统一以 on 开头，且都在 ipcRenderer.on 上注册了监听器', () => {
    const state = loadPreload();
    const flat = flatten(state.api);
    const subs = [];
    const bad = [];
    for (const [name, fn] of flat) {
        const leaf = name.split('.').pop();
        // onboardingDone 是「首次引导：标记已完成」，不是事件订阅（名字恰以 on 开头）
        if (!leaf.startsWith('on') || name === 'onboardingDone') continue;
        subs.push(name);
        state.actions.length = 0;
        fn(() => {});
        const a = state.actions[0];
        if (!a || a.kind !== 'on' || typeof a.args[0] !== 'function') bad.push(name);
        if (state.listeners.get(a.channel) === undefined) bad.push(`${name} 未登记监听器`);
    }
    assert.ok(subs.length >= 20, '应存在大量事件订阅接口，实际 ' + subs.length);
    assert.deepEqual(bad, [], '以下订阅接口没有正确注册监听器：' + bad.join(', '));
});

test('订阅回调收到主进程 payload：event 第一参被剥掉', () => {
    const state = loadPreload();
    const got = [];
    state.api.onBackendReady((info) => got.push(info));
    state.api.onPlayerExit((info) => got.push(info));
    state.api.onPlayerEnded((info) => got.push(info));
    state.api.onExternalPlayerExit((info) => got.push(info));
    state.api.onEpisodeSkip((info) => got.push(info));
    state.api.onA4kChanged((info) => got.push(info));
    state.api.onMouseNav((info) => got.push(info));
    state.api.onPlayerSpawnError((info) => got.push(info));
    state.api.onUpdateState((info) => got.push(info));
    state.api.onConfigReloaded((info) => got.push(info));
    state.api.onPushReceived((info) => got.push(info));
    state.api.onMpvDownloadState((info) => got.push(info));

    const payloads = [
        ['backend-ready', { port: 8801, token: 't' }],
        ['yuki:player-exit', { pos: 12, duration: 100 }],
        ['yuki:player-ended', { sessionId: 3 }],
        ['yuki:ext-player-exit', { sessionId: 3, wallSec: 55 }],
        ['yuki:episode-skip', { dir: 1 }],
        ['yuki:a4k-changed', { enabled: true, mode: 'A' }],
        ['yuki:mouse-nav', { dir: 'back' }],
        ['yuki:player-spawn-error', { code: 'ENOENT' }],
        ['yuki:update-state', { state: 'available' }],
        ['yuki:config-reloaded', { url: 'http://c' }],
        ['yuki:push-received', { url: 'http://p' }],
        ['yuki:mpv-download-state', { downloading: true }],
    ];
    for (const [ch, p] of payloads) state.emit(ch, p);
    assert.deepEqual(got, payloads.map(([, p]) => p), '回调必须只收到 payload，不暴露 IPC event 对象');
});

test('无 payload 订阅（download.onGoto / syncplay.onDisconnect）：回调被触发且不带参数', () => {
    const state = loadPreload();
    let gotoCount = 0;
    let dcArgs = 'unset';
    state.api.download.onGoto(() => { gotoCount += 1; });
    state.api.syncplay.onDisconnect((...a) => { dcArgs = a; });
    state.emit('yuki:dl-goto', { anything: 1 });
    state.emit('yuki:syncplay-disconnect', {});
    assert.equal(gotoCount, 1);
    assert.deepEqual(dcArgs, [], '无参订阅不得把 IPC event 泄露给渲染层');
});

test('下载/SyncPlay/DLNA 事件订阅的频道映射正确', () => {
    const state = loadPreload();
    const got = {};
    state.api.download.onList((items) => { got.list = items; });
    state.api.download.onEvent((d) => { got.event = d; });
    state.api.syncplay.onState((i) => { got.spState = i; });
    state.api.syncplay.onChat((i) => { got.chat = i; });
    state.api.syncplay.onFile((i) => { got.file = i; });
    state.api.syncplay.onUsers((i) => { got.users = i; });
    state.api.syncplay.onError((i) => { got.spErr = i; });
    state.api.dlna.onDevices((d) => { got.devices = d; });
    state.api.dlna.onError((i) => { got.dlnaErr = i; });

    state.emit('yuki:dl-list', [{ gid: 'g1' }]);
    state.emit('yuki:dl-event', { type: 'completed', task: { gid: 'g1' } });
    state.emit('yuki:syncplay-state', { pos: 1 });
    state.emit('yuki:syncplay-chat', { msg: 'hi' });
    state.emit('yuki:syncplay-file', { name: 'a.mkv' });
    state.emit('yuki:syncplay-users', [{ id: 1 }]);
    state.emit('yuki:syncplay-error', { reason: 'kicked' });
    state.emit('yuki:dlna-devices', [{ name: 'TV' }]);
    state.emit('yuki:dlna-error', { reason: 'timeout' });

    assert.deepEqual(got, {
        list: [{ gid: 'g1' }], event: { type: 'completed', task: { gid: 'g1' } },
        spState: { pos: 1 }, chat: { msg: 'hi' }, file: { name: 'a.mkv' },
        users: [{ id: 1 }], spErr: { reason: 'kicked' },
        devices: [{ name: 'TV' }], dlnaErr: { reason: 'timeout' },
    });
});

test('重复订阅同一接口：两个监听器都注册、都触发（当前语义是叠加而非覆盖）', () => {
    const state = loadPreload();
    const seen = [];
    state.api.onBackendReady((i) => seen.push('first:' + i.port));
    state.api.onBackendReady((i) => seen.push('second:' + i.port));
    state.emit('backend-ready', { port: 8801 });
    assert.deepEqual(seen, ['first:8801', 'second:8801'],
        '同一接口被重复调用会累积监听器（渲染层重复初始化会造成重复处理）');
});

test('订阅接口不返回取消订阅句柄（返回 undefined），锚定当前契约防止误以为可退订', () => {
    const state = loadPreload();
    const ret = state.api.onBackendReady(() => {});
    assert.equal(ret, undefined,
        'preload 的 on* 未返回退订函数；若将来改为返回句柄，需同步放开本断言并补退订用例');
    assert.deepEqual(state.removed, [], 'preload 从不调用 removeListener/removeAllListeners');
});

// ---------------------------------------------------------------------------
// 6. 健壮性
// ---------------------------------------------------------------------------

test('未知频道：主进程拒绝时 Promise 原样 reject（桥接层不吞错）', async () => {
    const state = loadPreload({ unknownReject: true });
    await assert.rejects(() => state.api.playerState(), /No handler registered/,
        'preload 不得把主进程错误静默转成 undefined');
});

test('ipcRenderer.invoke 同步抛错时异常直接冒泡到渲染层（preload 无 try/catch 包装）', () => {
    const state = loadPreload({ throwOnInvoke: true });
    assert.throws(() => state.api.configState(), /ipc-stub-sync-throw/,
        '桥接层不吞同步异常：渲染层必须自己 catch（与 app.js 现有写法一致）');
});

test('undefined / null 参数原样透传（桥接层不做隐式净化）', async () => {
    const state = loadPreload();
    await state.api.playUrl(undefined, undefined);
    await state.api.logRenderer(null, undefined);
    assert.deepEqual(invokes(state, 'yuki:play')[0].args, [{ url: undefined, meta: undefined }]);
    assert.deepEqual(invokes(state, 'yuki:log-renderer')[0].args, [null, undefined]);
});

test('订阅时传非函数不立即报错：失败延迟到事件到达（注册期不校验）', () => {
    const state = loadPreload();
    assert.doesNotThrow(() => state.api.onBackendReady(null), '注册期不校验回调类型');
    assert.doesNotThrow(() => state.api.onPlayerExit(undefined));
    assert.throws(() => state.emit('backend-ready', { port: 1 }), TypeError,
        '事件真正到达时才 TypeError——渲染层必须始终传函数');
});

test('回调抛异常不污染桥接：异常向派发方传播，但订阅表与 IPC 通道不受影响', async () => {
    const state = loadPreload({ handlers: { 'yuki:app-version': () => '1.2.3' } });
    let second = null;
    let ready = null;
    state.api.onPlayerExit(() => { throw new Error('渲染层处理炸了'); });
    state.api.onPlayerExit((i) => { second = i; });
    state.api.onBackendReady((i) => { ready = i; });

    // 抛错向上传播到派发方（preload 不吞回调异常），但只中断「本次派发」：
    // 同一频道的后一个监听器因此错过这一次事件（Node EventEmitter 语义）。
    assert.throws(() => state.emit('yuki:player-exit', { pos: 1 }), /渲染层处理炸了/);
    assert.equal(second, null);

    // 下一次同频道推送：监听器表完整，仍照常派发（依旧抛错，说明没被摘掉也没被替换）
    assert.throws(() => state.emit('yuki:player-exit', { pos: 2, duration: 10 }), /渲染层处理炸了/);
    assert.equal(second, null, '抛错监听器位于队列前，后一个监听器始终被本次派发中断');
    assert.equal((state.listeners.get('yuki:player-exit') || []).length, 2, '监听器未被异常清理');

    // 其它频道订阅与 invoke 通道完全不受影响——这是「不影响主流程」的实质
    state.emit('backend-ready', { port: 8801 });
    assert.deepEqual(ready, { port: 8801 });
    assert.equal(await state.api.appVersion(), '1.2.3');
});

test('回调抛异常：若异常发生在后一个监听器，前一个监听器的副作用已生效（顺序保证）', () => {
    const state = loadPreload();
    const order = [];
    state.api.onPlayerEnded((i) => order.push('first:' + i.sessionId));
    state.api.onPlayerEnded(() => { throw new Error('second-boom'); });
    assert.throws(() => state.emit('yuki:player-ended', { sessionId: 5 }), /second-boom/);
    assert.deepEqual(order, ['first:5'], '监听器按注册顺序同步派发，先注册者先执行');
});

test('健壮性：一次 IPC 失败不影响后续调用（桥接无状态残留）', async () => {
    let n = 0;
    const state = loadPreload({
        handlers: {
            'yuki:file-thumb': () => {
                n += 1;
                if (n === 1) throw new Error('ffmpeg-missing');
                return { ok: true };
            },
        },
    });
    await assert.rejects(() => state.api.fileThumb('a.mp4'), /ffmpeg-missing/);
    assert.deepEqual(await state.api.fileThumb('a.mp4'), { ok: true },
        '单次失败不得让桥接进入不可用状态');
});
