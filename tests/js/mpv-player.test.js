// 组件测试：mpv-player.js 静态助手（弹幕行解析 / ASS 颜色 / 时间戳）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const MpvPlayer = require('../../src/main/mpv-player');

// 源码断言：writeMpvAssets 的便携 input.conf 合并契约（index.js 闭包内，无法直接单测）。
// 自定义 mpv（如 mpv.lite）旁 portable_config/input.conf 必须被合并进生成文件且排最后
// （mpv 同键后绑定优先 → 该播放器自带键位不被应用段顶掉）；应用绑定段须跳过便携已绑键。
test('writeMpvAssets: 自定义播放器便携 input.conf 合并契约（同键以播放器自身为准）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
    // 便携行追加在用户全局行之后（文件中位置靠后 = 生效优先）
    const portableWrite = src.indexOf('...portableLines,');
    const userWrite = src.indexOf('...userLines,');
    assert.ok(portableWrite > -1 && userWrite > -1, '生成文件同时包含用户全局与便携段');
    assert.ok(portableWrite > userWrite, '便携段必须排用户全局段之后（同键以播放器自身为准）');
    // 应用绑定段跳过便携已绑键（与用户全局键同样的冲突避让）
    assert.ok(src.includes('userKeys.has(key) || portableKeys.has(key)'),
        '应用绑定段必须同时避让用户全局键与便携键');
    // 便携键探测复用 inputConfBoundKeys（键名提取规则一致）
    assert.ok(src.includes('const portableKeys = inputConfBoundKeys(portableLines);'),
        '便携键必须经 inputConfBoundKeys 收集');
});

test('parseDanmaku: 完整字段', () => {
    const d = MpvPlayer.parseDanmaku('[12.5,1,25,16711680]测试弹幕');
    assert.equal(d.time, 12.5);
    assert.equal(d.mode, 1);
    assert.equal(d.size, 25);
    assert.equal(d.color, 0xFF0000);
    assert.equal(d.content, '测试弹幕');
});

test('parseDanmaku: 缺省字段（time=0 mode=1 size=25 白）', () => {
    const d = MpvPlayer.parseDanmaku('[,,,]内容');
    assert.equal(d.time, 0);
    assert.equal(d.mode, 1);
    assert.equal(d.size, 25);
    assert.equal(d.color, 0xFFFFFF);
    assert.equal(d.content, '内容');
});

test('parseDanmaku: 非法输入返回 null', () => {
    assert.equal(MpvPlayer.parseDanmaku('没有方括号'), null);
    assert.equal(MpvPlayer.parseDanmaku(''), null);
    assert.equal(MpvPlayer.parseDanmaku('[1]'), null);
});

test('parseDanmaku: 反向滚动 mode=6', () => {
    const d = MpvPlayer.parseDanmaku('[1,6]反向');
    assert.equal(d.mode, 6);
});

test('_assColor: 0xRRGGBB 转 ASS &HAABBGGRR', () => {
    assert.equal(MpvPlayer._assColor(0xFF0000), '&H000000FF'); // 红 → B=0 G=0 R=FF
    assert.equal(MpvPlayer._assColor(0x00FF00), '&H0000FF00'); // 绿
    assert.equal(MpvPlayer._assColor(0xFFFFFF), '&H00FFFFFF');
});

test('_ts: 秒转 ASS 时间轴', () => {
    assert.equal(MpvPlayer._ts(0), '00:00:00.00');
    assert.equal(MpvPlayer._ts(65.5), '00:01:05.50');
    assert.equal(MpvPlayer._ts(3661.25), '01:01:01.25');
    assert.equal(MpvPlayer._ts(-5), '00:00:00.00'); // 负值钳制 0
});

test('escapeOsdText: 裸 $ 翻倍（mpv 属性展开占位符转义）', () => {
    // 回归：曾写成 replace(/\$/g, '$$')，'$$' 在 replace 字符串替换串里是
    // 「字面 $」转义，等于空操作；必须 'a$b' → 'a$$b' 才能在 mpv OSD 里
    // 呈现字面 $（$$ 是 mpv 的字面 $ 占位符）。
    assert.equal(MpvPlayer.escapeOsdText('a$b'), 'a$$b');
    assert.equal(MpvPlayer.escapeOsdText('$ ${title} $?{prop}x'), '$$ $${title} $$?{prop}x');
    assert.equal(MpvPlayer.escapeOsdText('无美元符号'), '无美元符号');
    assert.equal(MpvPlayer.escapeOsdText(''), '');
    assert.equal(MpvPlayer.escapeOsdText(null), '');
    assert.equal(MpvPlayer.escapeOsdText(undefined), '');
});

test('property-change 持续缓存播放进度与时长', () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    p._lastFs = false;
    p._lastSp = 1;
    p._activeSession = { id: 7, pos: null, duration: null, fullscreen: false, speed: 1 };
    p._onEvent({ event: 'property-change', name: 'time-pos', data: 42.5 });
    p._onEvent({ event: 'property-change', name: 'duration', data: 120 });
    assert.equal(p._activeSession.pos, 42.5);
    assert.equal(p._activeSession.duration, 120);
});

test('旧会话 teardown 不会清理新会话', () => {
    const p = Object.create(MpvPlayer.prototype);
    const proc = {};
    p._activeSession = { id: 8 };
    p.proc = proc;
    p.socket = null;
    p._pending = new Map();
    p._connected = true;
    p._teardown(7);
    assert.equal(p.proc, proc);
    assert.equal(p._activeSession.id, 8);
    assert.equal(p._connected, true);
});

test('end-file eof 附带会话号并把进度补满后发出 ended', () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    p._activeSession = { id: 9, pos: 42.5, duration: 120, fullscreen: false, speed: 1 };
    p._queueLen = 3;
    let ended = null;
    p.on('ended', (info) => { ended = info; });
    p._onEvent({ event: 'end-file', reason: 'eof', playlist_pos: 1 });
    assert.equal(p._activeSession.pos, 120); // 播完把进度补满，供退出判定
    // 单集会话：nativeQueue=false，itemWallSec 缺失（未设 itemStartMs）为 null
    assert.deepEqual(ended, { sessionId: 9, playlistPos: 1, queueLen: 3,
        pos: 120, duration: 120, itemWallSec: null, nativeQueue: false });
});

test('end-file eof 会话号只属当前活动会话', () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    p._activeSession = { id: 10, pos: 10, duration: 90, fullscreen: false, speed: 1 };
    p._queueLen = 1;
    let ended = null;
    p.on('ended', (info) => { ended = info; });
    // 旧会话（id 5）的 ended 事件不应携带活动会话 id
    p._activeSession.id = 10;
    p._onEvent({ event: 'end-file', reason: 'eof', playlist_pos: 0 });
    assert.equal(ended.sessionId, 10);
});

// ---------------------------------------------------------------- 用户主动关闭 vs 断流（重连修复）

test('end-file quit（用户关窗）记录 endReason 且不触发 ended', () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    p._activeSession = { id: 12, pos: 30, duration: 120 };
    let ended = null;
    p.on('ended', (info) => { ended = info; });
    p._onEvent({ event: 'end-file', reason: 'quit' });
    assert.equal(p._activeSession.endReason, 'quit');
    assert.equal(ended, null); // quit 不是播放完成，不发出 ended
});

test('end-file stop 记录 endReason', () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    p._activeSession = { id: 13 };
    p._onEvent({ event: 'end-file', reason: 'stop' });
    assert.equal(p._activeSession.endReason, 'stop');
});

test('end-file eof 记录 endReason 且触发 ended（既有行为保持）', () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    p._activeSession = { id: 14, pos: 10, duration: 90 };
    p._queueLen = 1;
    let ended = null;
    p.on('ended', (info) => { ended = info; });
    p._onEvent({ event: 'end-file', reason: 'eof', playlist_pos: 0 });
    assert.equal(p._activeSession.endReason, 'eof');
    assert.ok(ended);
});

test('stop() 标记当前会话 userStopped（退出时不得断流重连）', () => {
    const p = Object.create(MpvPlayer.prototype);
    const session = { id: 15, userStopped: false };
    p._activeSession = session;
    p.proc = { pid: 999, kill() {} };
    p._teardown = () => {}; // 阻止清空以便断言
    p._pending = new Map();
    p.stop();
    assert.equal(session.userStopped, true);
});

// ---------------------------------------------------------------- 播放位置查询（get-pos 契约的底层）

// 渲染层经 yuki:player 'get-pos' 读取当前播放位置做真实进度估算；
// 主进程侧取值口径：无会话/未连接 → null，否则返回观察缓存（异步 get_property 顺带刷新）。
test('getTimePos(): 已连接时返回观察缓存并异步刷新（实时 time-pos 滞后时也不跳变）', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p.proc = {};
    p._connected = true;
    p.socket = {};
    p._activeSession = { id: 51, pos: 33.5 };
    let queried = 0;
    p.getProperty = (name) => {
        assert.equal(name, 'time-pos');
        queried += 1;
        return Promise.resolve(99);
    };
    assert.equal(p.getTimePos(), 33.5, '同步返回观察缓存（此刻 33.5）');
    await new Promise((r) => setImmediate(r));
    assert.equal(queried, 1, '同步返回后仍发起一次实时查询');
    assert.equal(p._activeSession.pos, 99, '查询结果顺带刷新缓存，下次调用即最新');
    assert.equal(p.getTimePos(), 99);
});

test('getTimePos(): 未连接/无会话/缓存缺失时返回 null', () => {
    const p = Object.create(MpvPlayer.prototype);
    p.proc = {};
    p._connected = false;
    p.socket = null;
    p._activeSession = { id: 52, pos: 10 };
    assert.equal(p.getTimePos(), null, 'IPC 未连接：无从取实时位置');

    p._connected = true;
    p._activeSession = null;
    assert.equal(p.getTimePos(), null, '无活动会话：返回 null');

    p._activeSession = { id: 53, pos: null }; // 起播后 time-pos 尚未上报
    p.getProperty = () => Promise.reject(new Error('property unavailable'));
    assert.equal(p.getTimePos(), null, '缓存缺失（未起播）时返回 null，不猜测 0');
});

// ---------------------------------------------------------------- watch-later 续播位置守卫（opEd/续播 seek 不覆盖 mpv 自行恢复）

// mpv --save-position-on-quit 会在装载时自行恢复 watch-later 位置（time-pos 已落在
// 记录处）；此后无条件下发 pendingSeekSec 会把播放位置拽回目标秒（典型症状：看到
// 中途退出重进被拉回片头/跳片点）。守卫：仅当当前位置仍在片头附近才应用 seek。
test('file-loaded 续播守卫：mpv 已自行恢复到中途（time-pos>5s）时跳过 pendingSeekSec', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    const seeks = [];
    p.command = (...args) => {
        if (args[0] === 'seek') seeks.push(args);
        if (args[0] === 'get_property' && args[1] === 'time-pos') return Promise.resolve(1200.5);
        return Promise.resolve();
    };
    p._activeSession = { id: 60, ready: false, pendingSeekSec: 90, seekApplied: false, itemStartMs: Date.now() };
    p._onEvent({ event: 'file-loaded' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seeks, [], 'watch-later 已恢复到中途位置：不得再下发 seek 覆盖');
    assert.equal(p._activeSession.seekApplied, true, '守卫只判定一次，后续集数不再重试');
});

test('file-loaded 续播守卫：当前位置仍在片头（≤5s）时照常应用 opEd/续播 seek', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    const seeks = [];
    p.command = (...args) => {
        if (args[0] === 'seek') seeks.push(args);
        if (args[0] === 'get_property' && args[1] === 'time-pos') return Promise.resolve(0.3);
        return Promise.resolve();
    };
    p._activeSession = { id: 61, ready: false, pendingSeekSec: 90, seekApplied: false, itemStartMs: Date.now() };
    p._onEvent({ event: 'file-loaded' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seeks, [['seek', 90, 'absolute+exact']]);
});

test('file-loaded 续播守卫：time-pos 属性不可用时按无恢复处理，seek 照常应用', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    const seeks = [];
    p.command = (...args) => {
        if (args[0] === 'seek') seeks.push(args);
        return Promise.resolve();
    };
    p.getProperty = (name) => {
        assert.equal(name, 'time-pos');
        return Promise.reject(new Error('property unavailable'));
    };
    p._activeSession = { id: 62, ready: false, pendingSeekSec: 90, seekApplied: false, itemStartMs: Date.now() };
    p._onEvent({ event: 'file-loaded' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seeks, [['seek', 90, 'absolute+exact']], '守卫失败必须保持 opEd/续播 seek 原有行为');
});

test('file-loaded 续播守卫：读 time-pos 期间会话已切换时不再对旧会话 seek', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    const seeks = [];
    p.command = (...args) => {
        if (args[0] === 'seek') seeks.push(args);
        if (args[0] === 'get_property' && args[1] === 'time-pos') {
            // 应答延迟到达前，渲染层已 stop→play 换了新会话
            return Promise.resolve(0.3);
        }
        return Promise.resolve();
    };
    const oldSession = { id: 63, ready: false, pendingSeekSec: 90, seekApplied: false, itemStartMs: Date.now() };
    p._activeSession = oldSession;
    p._onEvent({ event: 'file-loaded' });
    p._activeSession = { id: 64, ready: false, seekApplied: false }; // 新会话接管
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seeks, [], '旧会话的续播 seek 不得落在新会话头上');
});

// ---------------------------------------------------------------- 真正起播确认

test('waitForReady(): 收到 file-loaded/ready 事件后返回成功', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p._activeSession = { id: 21, ready: false, stderr: '', requestId: 'play-normal-0001', playSessionId: 'session-normal-0001' };
    p.proc = {};
    p._connected = false;
    const pending = p.waitForReady(21, 1000);
    setImmediate(() => p.emit('ready', { sessionId: 21 }));
    const result = await pending;
    assert.deepEqual(result, { ok: true, sessionId: 21,
        requestId: 'play-normal-0001', playSessionId: 'session-normal-0001' });
});

test('waitForReady(): 会话提前退出时返回明确失败原因', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p._activeSession = { id: 22, ready: false, stderr: '', requestId: 'play-error-0001' };
    p.proc = {};
    p._connected = false;
    const pending = p.waitForReady(22, 1000);
    setImmediate(() => p.emit('exit', {
        sessionId: 22, endReason: 'error', stderr: 'HTTP 404', code: 1,
    }));
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'mpv-exited-before-playback');
    assert.equal(result.requestId, 'play-error-0001');
    assert.match(result.error, /HTTP 404/);
});

test('waitForReady(): 未收到加载事件时超时', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p._activeSession = { id: 23, ready: false, stderr: 'network error', requestId: 'play-timeout-0001' };
    p.proc = {};
    p._connected = false;
    const result = await p.waitForReady(23, 1000);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'mpv-start-timeout');
    assert.equal(result.requestId, 'play-timeout-0001');
    assert.match(result.error, /network error/);
});

// ---------------------------------------------------------------- 无内置播放器（mpv 缺失）健壮性

test('play(): binary=null 时返回 mpv-missing，不 spawn、不抛异常', () => {
    const p = Object.create(MpvPlayer.prototype);
    p.binary = null;
    p.stop = () => {}; // 隔离：避免触发 teardown 依赖的字段
    const r = p.play([{ url: 'http://x/a.mp4', title: 'a' }]);
    assert.deepEqual(r, { ok: false, reason: 'mpv-missing' });
});

test('play(): binary 指向不存在的文件时提前拦截为 mpv-missing 并清空 binary', () => {
    const p = Object.create(MpvPlayer.prototype);
    const ghost = require('path').join(require('os').tmpdir(), 'yuki-no-such-mpv-xyz.exe');
    try { require('fs').rmSync(ghost, { force: true }); } catch (e) { /* ignore */ }
    p.binary = ghost;
    p.stop = () => {};
    const r = p.play([{ url: 'http://x/a.mp4', title: 'a' }]);
    assert.deepEqual(r, { ok: false, reason: 'mpv-missing' });
    assert.equal(p.binary, null); // 拦截后标记为不可用，isAvailable() 后续返回 false
});

test('isAvailable(): binary 缺失时为 false（渲染层据此走友好提示/降级）', () => {
    const p = Object.create(MpvPlayer.prototype);
    p.binary = null;
    assert.equal(p.isAvailable(), false);
    p.binary = 'C:/mpv/mpv.exe';
    assert.equal(p.isAvailable(), true);
});

test('setCustomPath(): 不存在的路径返回 false，不改变现有 binary', () => {
    const p = Object.create(MpvPlayer.prototype);
    p.binary = null;
    const ok = p.setCustomPath(require('path').join(require('os').tmpdir(), 'yuki-nope-mpv.exe'));
    assert.equal(ok, false);
    assert.equal(p.binary, null);
});

test('setCustomPath(): 外部 mpv 跳过外观注入（externalStyle=true），bundled 补装不跳过', () => {
    const fs = require('fs');
    // setCustomPath 用 spawnSync --version 校验，需真实可执行文件；用 node 自身冒充
    const fake = process.execPath;
    assert.ok(fs.existsSync(fake), 'node 二进制必须存在（校验用）');
    const p = Object.create(MpvPlayer.prototype);
    p.binary = null;
    assert.equal(p.setCustomPath(fake), true, '默认视为用户手动选择的外部 mpv');
    assert.equal(p.externalStyle, true);
    assert.equal(p.setCustomPath(fake, { bundled: true }), true, '补装内置二进制');
    assert.equal(p.externalStyle, false);
    assert.equal(p.setCustomPath(fake, { bundled: false }), true);
    assert.equal(p.externalStyle, true);
});

test('play(): externalStyle 下功能类资产仍注入，外观类跳过（快捷键在自定义 mpv 上生效的前提）', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-extstyle-'));
    const script = path.join(dir, 'hints.lua');
    const conf = path.join(dir, 'input.conf');
    const menu = path.join(dir, 'menu.conf');
    fs.writeFileSync(script, '-- t');
    fs.writeFileSync(conf, 'SPACE cycle pause\n');
    fs.writeFileSync(menu, '退出\tquit\n');
    const p = Object.create(MpvPlayer.prototype);
    p.binary = process.execPath; // 须真实存在：play() 起播前会做存在性校验
    p.scriptPath = script;
    p.inputConfPath = conf;
    p.menuConfPath = menu;
    p.externalStyle = true; // 用户手动指定的外部 mpv（如 mpv.lite）
    p.stop = () => {};
    p._refreshIpcPath = () => {};
    p._writeAss = () => {};
    p._bringToFront = () => {};
    p._connectIpc = () => {};
    p._cacheArgs = () => [];
    p._screenshotArgs = () => [];
    p._ytdlArgs = () => [];
    // 不 stub _contextMenuArgs：走真实实现（menuConfPath 存在即注入），验证「无条件注入」不是空转
    let argv = null;
    p._spawn = (_bin, args) => {
        argv = args;
        return { pid: 12345, on: () => {}, once: () => {} }; // 不真起进程
    };
    p.play([{ url: 'http://x/a.mp4', title: 'a' }]);
    // 功能类资产：无论是否 externalStyle 都必须带上
    assert.ok(argv.includes(`--scripts-append=${script}`), 'hints.lua 必须注入（上/下集与 Anime4K 信号）');
    assert.ok(argv.includes(`--input-conf=${conf}`), 'input.conf 必须注入（自定义键位与步长）');
    assert.ok(argv.some((a) => a.startsWith('--script-opt=select-menu_conf_path=')), '中文菜单必须注入');
    // 外观类：externalStyle 下跳过
    assert.ok(!argv.includes('--osd-font=Microsoft YaHei'), '外观字体按 externalStyle 跳过');
    // 窗口层级：不注入 --ontop 常驻置顶（前置交给 _bringToFront 激活兜底）
    assert.ok(!argv.includes('--ontop'), '起播 argv 不得包含 --ontop（不默认置顶）');
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 弹幕轨装载门控（danmakuEnable 默认关）

// 渲染层设置键 danmakuEnable 默认关：player.js 只在开启时才向 mpv 推弹幕；
// 但播放器侧若 IPC 连接后无条件 sub-add 弹幕轨，外部 mpv 仍会进入弹幕播放状态
// （表现为「设置关闭后弹幕仍默认启动」）。播放器侧必须同受该开关约束。
test('_connectIpc(): danmakuEnabled=false（默认）不 sub-add 弹幕轨，其余 observe 照常', () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    p._activeSession = { id: 40 };
    p.proc = {};
    const calls = [];
    p.command = (...args) => { calls.push(args); return Promise.resolve(); };
    p._probeContextMenuBinding = () => {};
    p._verifyA4kBindings = () => {};
    p._bringToFront = () => {};
    // 模拟 socket connect 回调（真实 _connectIpc 依赖 net.connect，直接测连接就绪段）
    // 用 net.connect 桩：注入假 socket 触发 connect 回调
    const net = require('net');
    const fakeSock = new net.Socket();
    p.ipcPath = '\\\\.\\pipe\\yuki-test';
    const origConnect = net.connect;
    net.connect = () => fakeSock;
    try {
        p._connectIpc(0, 40);
        fakeSock.emit('connect');
    } finally {
        net.connect = origConnect;
        fakeSock.destroy();
    }
    assert.equal(p._connected, true);
    assert.ok(!calls.some((c) => c[0] === 'sub-add'), '弹幕关闭（默认）时不得 sub-add 弹幕轨');
    assert.ok(calls.some((c) => c[0] === 'observe_property'), '全屏/倍速等属性观察不受弹幕开关影响');
});

test('_connectIpc(): danmakuEnabled=true 时 sub-add 弹幕轨（开启态行为保持）', () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    p._activeSession = { id: 41 };
    p.proc = {};
    p.danmakuEnabled = true;
    const calls = [];
    p.command = (...args) => { calls.push(args); return Promise.resolve(); };
    p._probeContextMenuBinding = () => {};
    p._verifyA4kBindings = () => {};
    p._bringToFront = () => {};
    const net = require('net');
    const fakeSock = new net.Socket();
    p.ipcPath = '\\\\.\\pipe\\yuki-test-on';
    const origConnect = net.connect;
    net.connect = () => fakeSock;
    try {
        p._connectIpc(0, 41);
        fakeSock.emit('connect');
    } finally {
        net.connect = origConnect;
        fakeSock.destroy();
    }
    const add = calls.find((c) => c[0] === 'sub-add');
    assert.ok(add, '弹幕开启时必须 sub-add 弹幕轨');
    assert.equal(add[1], p.assPath);
    assert.equal(add[3], '彈幕');
});

test('loadDanmakuBatch(): danmakuEnabled=false 直接返回 0，不写盘不 sub-reload', () => {
    const p = Object.create(MpvPlayer.prototype);
    p.danmakuEnabled = false;
    p._connected = true;
    p.assPath = path.join(require('os').tmpdir(), 'yuki-danmaku-gate-off-test.ass');
    try { fs.rmSync(p.assPath, { force: true }); } catch (e) { /* ignore */ }
    let reloaded = 0;
    p.command = (...args) => { if (args[0] === 'sub-reload') reloaded++; return Promise.resolve(); };
    const n = p.loadDanmakuBatch([{ p: '1.0,1,16777215,uid', m: '弹幕' }]);
    assert.equal(n, 0);
    assert.equal(reloaded, 0);
    assert.equal(fs.existsSync(p.assPath), false, '关闭态不得生成 ASS 弹幕文件');
    assert.deepEqual(p._danmakuLines || [], []);
});

test('loadDanmakuBatch(): danmakuEnabled=true 行为保持（转 ASS 写盘并经轨探测 sub-reload）', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p.danmakuEnabled = true;
    p._connected = true;
    p.assPath = path.join(require('os').tmpdir(), `yuki-danmaku-gate-on-${Date.now()}.ass`);
    let reloaded = 0;
    p.command = (...args) => {
        if (args[0] === 'sub-reload') reloaded++;
        // 轨探测走真实 getProperty → get_property track-list：桩回「已有弹幕轨」。
        // 用真实 mpv（v0.41 实测）的条目形态：external-filename 字段，无 src。
        if (args[0] === 'get_property' && args[1] === 'track-list') {
            return Promise.resolve([{ type: 'sub', 'external-filename': p.assPath }]);
        }
        return Promise.resolve();
    };
    const n = p.loadDanmakuBatch([
        { p: '1.0,1,16777215,uid', m: '弹幕一' },
        { p: '2.5,5,255,uid', m: '顶部弹幕' },
    ]);
    assert.equal(n, 2);
    await new Promise((r) => setImmediate(r)); // 轨探测异步分流后才下发 sub-reload
    assert.equal(reloaded, 1);
    const text = fs.readFileSync(p.assPath, 'utf8');
    assert.ok(text.includes('弹幕一'));
    try { fs.rmSync(p.assPath, { force: true }); } catch (e) { /* ignore */ }
});

// ---------------------------------------------------------------- 弹幕轨装载时序（占位文件 + 轨探测补轨）

// sub-add 在文件不存在时不建轨（mpv 直接报 "error running command"），此后
// sub-reload 无轨可刷——弹幕整场静默失效。起播前必须先落一份占位文件。
test('play(): danmakuEnabled=true 起播前写 ASS 占位文件（sub-add 建轨前提）；关闭态不写', () => {
    const mk = (enabled) => {
        const p = Object.create(MpvPlayer.prototype);
        p.binary = process.execPath; // play() 起播前校验存在性
        p.danmakuEnabled = enabled;
        // 原型实例不经构造器：assPath 与生产一致指向共享临时路径
        p.assPath = path.join(require('os').tmpdir(), `yuki-danmaku-placeholder-${enabled}-${Date.now()}.ass`);
        p.stop = () => {};
        p._refreshIpcPath = () => {};
        p._bringToFront = () => {};
        p._connectIpc = () => {};
        p._spawn = () => ({ pid: 1, on: () => {}, once: () => {}, stderr: null });
        return p;
    };
    const on = mk(true);
    on.play([{ url: 'http://x/a.mp4', title: 'a' }]);
    const text = fs.readFileSync(on.assPath, 'utf8');
    assert.ok(text.includes('[Script Info]') && text.includes('[V4+ Styles]') && text.includes('[Events]'),
        '占位文件必须是含三段结构的合法 ASS');
    assert.ok(!text.includes('Dialogue:'), '占位文件只含 header，不携带任何弹幕 Dialogue');
    try { fs.rmSync(on.assPath, { force: true }); } catch (e) { /* ignore */ }

    const off = mk(false);
    off.play([{ url: 'http://x/a.mp4', title: 'a' }]);
    assert.equal(fs.existsSync(off.assPath), false, '弹幕关闭（默认）时起播全程不生成 ASS 文件');
});

test('loadDanmakuBatch(): track-list 无弹幕轨时补 sub-add 建轨而非 sub-reload', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p.danmakuEnabled = true;
    p._connected = true;
    p.assPath = path.join(require('os').tmpdir(), `yuki-danmaku-addback-${Date.now()}.ass`);
    const calls = [];
    p.command = (...args) => {
        calls.push(args);
        if (args[0] === 'get_property' && args[1] === 'track-list') {
            return Promise.resolve([{ type: 'video' }, { type: 'audio' }]); // 只有视频/音频轨
        }
        return Promise.resolve();
    };
    p.loadDanmakuBatch([{ p: '1.0,1,16777215,uid', m: '弹幕' }]);
    await new Promise((r) => setImmediate(r));
    assert.ok(calls.some((c) => c[0] === 'sub-add' && c[1] === p.assPath && c[3] === '彈幕'),
        '轨缺失必须补 sub-add（与 _connectIpc 同参：select + 彈幕）');
    assert.ok(!calls.some((c) => c[0] === 'sub-reload'), '无轨时 sub-reload 静默失败，不得下发');
    try { fs.rmSync(p.assPath, { force: true }); } catch (e) { /* ignore */ }
});

test('loadDanmakuBatch(): 重复调用不产生重复 sub-add（真实 mpv external-filename 形态锁死）', async () => {
    // 回归锁（验证代理真机实测）：真实 mpv track-list 条目只有 external-filename、
    // 没有 src 字段。此前谓词 t.src === assPath 在真实 mpv 上恒假 → 每次批量装载
    // 都误判为「无轨」补发 sub-add，两次刷新后出现 3 条重复弹幕轨。
    const p = Object.create(MpvPlayer.prototype);
    p.danmakuEnabled = true;
    p._connected = true;
    p.assPath = path.join(require('os').tmpdir(), `yuki-danmaku-dup-${Date.now()}.ass`);
    const calls = [];
    // 纯 external-filename 形态（无 src 字段）＝真实 mpv 返回形态，锁死谓词兼容
    p.command = (...args) => {
        calls.push(args);
        if (args[0] === 'get_property' && args[1] === 'track-list') {
            return Promise.resolve([
                { type: 'video', 'external-filename': 'C:/video.mp4' },
                { type: 'audio' },
                { type: 'sub', 'external-filename': p.assPath, title: '彈幕' },
            ]);
        }
        return Promise.resolve();
    };
    p.loadDanmakuBatch([{ p: '1.0,1,16777215,uid', m: '第一轮' }]);
    await new Promise((r) => setImmediate(r));
    p.loadDanmakuBatch([{ p: '2.0,1,16777215,uid', m: '第二轮' }]);
    await new Promise((r) => setImmediate(r));
    const adds = calls.filter((c) => c[0] === 'sub-add');
    assert.equal(adds.length, 0, '已有弹幕轨（external-filename 匹配）时重复批量装载只 sub-reload，不得再 sub-add');
    assert.equal(calls.filter((c) => c[0] === 'sub-reload').length, 2, '每轮批量装载各一次 sub-reload 热更新');
    try { fs.rmSync(p.assPath, { force: true }); } catch (e) { /* ignore */ }
});

test('loadDanmakuBatch(): track-list 属性不可用时静默跳过（不误发命令）', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p.danmakuEnabled = true;
    p._connected = true;
    p.assPath = path.join(require('os').tmpdir(), `yuki-danmaku-probe-fail-${Date.now()}.ass`);
    const calls = [];
    p.command = (...args) => { calls.push(args); return Promise.resolve(); };
    p.getProperty = () => Promise.reject(new Error('property unavailable'));
    p.loadDanmakuBatch([{ p: '1.0,1,16777215,uid', m: '弹幕' }]);
    await new Promise((r) => setImmediate(r));
    assert.ok(!calls.some((c) => c[0] === 'sub-reload' || c[0] === 'sub-add'),
        '无法判断轨状态时不得盲目下发 reload/add');
    try { fs.rmSync(p.assPath, { force: true }); } catch (e) { /* ignore */ }
});

// ---------------------------------------------------------------- 视频缓冲缓存（只走内存）

test('_cacheArgs(): 在线播放缓存只进内存，不落磁盘', () => {
    const p = Object.create(MpvPlayer.prototype);
    const a = p._cacheArgs(true);
    assert.ok(a.includes('--cache=yes'));
    assert.ok(a.includes('--demuxer-max-bytes=256MiB'));      // 内存缓冲上限
    assert.ok(a.includes('--demuxer-max-back-bytes=64MiB')); // 回退缓冲（同为内存，与上限 4:1）
    assert.ok(a.includes('--demuxer-readahead-secs=60'));
    assert.ok(a.includes('--cache-on-disk=no'));              // 显式关闭，压过用户 mpv.conf
    assert.ok(!a.some((x) => x.startsWith('--demuxer-cache-dir=')));
    assert.ok(!a.includes('--cache-on-disk=yes'));
});

test('_cacheArgs(): 本地文件同样显式关闭落盘（不加预缓冲）', () => {
    const p = Object.create(MpvPlayer.prototype);
    assert.deepEqual(p._cacheArgs(false), ['--cache-on-disk=no']);
});

test('_cacheArgs(): 残留的旧 disk 字段也不得让缓存落盘（防回归）', () => {
    // 硬盘缓存能力已移除；旧版本的 cacheMode/cacheDir 字段或历史设置键都不应再有任何效力
    const p = Object.create(MpvPlayer.prototype);
    p.cacheMode = 'disk';
    p.cacheDir = require('path').join(require('os').tmpdir(), 'yuki-legacy-mpv-cache');
    for (const isNet of [true, false]) {
        const a = p._cacheArgs(isNet);
        assert.ok(a.includes('--cache-on-disk=no'));
        assert.ok(!a.includes('--cache-on-disk=yes'));
        assert.ok(!a.some((x) => x.startsWith('--demuxer-cache-dir=')));
    }
    // 目录也不该被顺手创建
    assert.equal(require('fs').existsSync(p.cacheDir), false);
});

// ---------------------------------------------------------------- 截图（s 键落盘）

/**
 * 校验 mpv 截图文件名模板的转义合法性（对齐 mpv create_fname 的可接受集合）。
 * mpv 遇到未知转义会判整个模板非法并**放弃截图**，故此处逐个转义白名单校验。
 */
function shotTemplateBad(tpl) {
    for (let i = 0; i < tpl.length; i++) {
        if (tpl[i] !== '%') continue;
        let c = tpl[++i];
        if (c === undefined) return '模板以 % 结尾';
        if (c === '#') c = tpl[++i];                      // %#n：每个文件重置序号
        while (c >= '0' && c <= '9') c = tpl[++i];         // %0Xn：序号补零位数
        if (c === undefined) return '序号转义缺 n';
        if ('nfFxpP%'.includes(c)) continue;               // 序号/文件名/路径/播放时间/字面 %
        if (c === '{') {                                   // %{property}
            const end = tpl.indexOf('}', i);
            if (end < 0) return '%{…} 未闭合';
            i = end;
            continue;
        }
        if (c === 't') {                                   // %tX：strftime 字段，必须带子格式字符
            if (tpl[++i] === undefined) return '%t 缺子格式字符';
            continue;
        }
        if (c === 'w') {                                   // %wX：播放时间，子格式限定集合
            const sub = tpl[++i];
            if (!'HhMmSsfT'.includes(String(sub))) return `%w 子格式非法：%w${sub}`;
            continue;
        }
        if (c === 'X') {                                   // %X{fallback}
            if (tpl[++i] !== '{') return '%X 缺 {fallback}';
            const end = tpl.indexOf('}', i);
            if (end < 0) return '%X{…} 未闭合';
            i = end;
            continue;
        }
        return `未知转义：%${c}`;
    }
    return '';
}

test('shotTemplateBad(): 能识别出旧模板 yuki-%w-%03n 非法（本次 bug 的根因）', () => {
    assert.equal(shotTemplateBad('yuki-%w-%03n'), '%w 子格式非法：%w-');
    assert.equal(shotTemplateBad('mpv-shot%n'), '');
    assert.equal(shotTemplateBad('%wH.%wM.%wS-%03n'), '');
});

test('_screenshotArgs(): 目录/png/合法模板三件套', () => {
    const dir = require('path').join(require('os').tmpdir(), 'yuki-shot-args-test');
    const p = Object.create(MpvPlayer.prototype);
    p.screenshotDir = dir;
    const a = p._screenshotArgs();
    assert.ok(a.includes(`--screenshot-directory=${dir}`));
    assert.ok(a.includes('--screenshot-format=png')); // 与 IPC 通道 screenshot-to-file 的 .png 一致
    const tpl = a.find((x) => x.startsWith('--screenshot-template='));
    assert.ok(tpl, '缺 --screenshot-template');
    const value = tpl.slice('--screenshot-template='.length);
    assert.equal(shotTemplateBad(value), ''); // 非法模板会让 mpv 放弃截图（s 键只弹 OSD 不落盘）
    assert.ok(/%0?\d*n/.test(value), '模板需含序号 %n，重名时自增避让而非报错');
    assert.ok(require('fs').existsSync(dir), '目录应被兜底创建');
    try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

test('_screenshotArgs(): 未设目录时不注入任何截图参数', () => {
    const p = Object.create(MpvPlayer.prototype);
    p.screenshotDir = '';
    assert.deepEqual(p._screenshotArgs(), []);
});

// ---------------------------------------------------------------- ytdl_hook（默认排除）

// 本应用不打包 yt-dlp：放任 mpv 内置 ytdl_hook 探测会在无扩展名直链（CDN 签名链接，
// 不命中旧的后缀白名单）上逐一 spawn 6 个候选名全落空，起播拖慢 ~5s 并刷
// "Subprocess failed: init" 错误日志。默认整体排除，仅 opts.ytdl 显式开启时保留。
test('_ytdlArgs(): 默认排除 ytdl_hook（含无扩展名直链场景）', () => {
    const p = Object.create(MpvPlayer.prototype);
    assert.deepEqual(p._ytdlArgs({}), ['--script-opt=ytdl_hook-exclude=.*']);
    // 调用方未传 opts（历史签名兼容）同样默认排除
    assert.deepEqual(p._ytdlArgs(undefined), ['--script-opt=ytdl_hook-exclude=.*']);
});

test('_ytdlArgs(): opts.ytdl===true 是逃生口，不注入排除参数', () => {
    const p = Object.create(MpvPlayer.prototype);
    assert.deepEqual(p._ytdlArgs({ ytdl: true }), []);
});

// ---------------------------------------------------------------- HTTP 请求头（--http-header-fields 逗号转义）

// mpv 的 --http-header-fields 是逗号分隔列表：值内逗号不转义会被拆成多个头，
// 拼出畸形请求（实测 CDN 回 400，mpv "Errors when loading file" 退出，
// 即「解析成功但 mpv 未能开始播放：error」）。
test('headerFieldsValue(): 多头以逗号+空格连接', () => {
    assert.equal(
        MpvPlayer.headerFieldsValue({ 'User-Agent': 'libmpv', Referer: 'https://x/' }),
        'User-Agent: libmpv, Referer: https://x/');
});

test('headerFieldsValue(): 值内逗号转义为 \\,（mpv 列表转义语法）', () => {
    assert.equal(
        MpvPlayer.headerFieldsValue({ Accept: 'text/html,application/xhtml+xml,xml;q=0.9' }),
        'Accept: text/html\\,application/xhtml+xml\\,xml;q=0.9');
    assert.equal(
        MpvPlayer.headerFieldsValue({ Cookie: 'a=1,b=2' }),
        'Cookie: a=1\\,b=2');
});

test('headerFieldsValue(): 空/缺失头被过滤，非法输入返回空串', () => {
    assert.equal(MpvPlayer.headerFieldsValue({ Referer: '', 'X-B': null, 'X-C': undefined, 'X-D': 'ok' }),
        'X-D: ok');
    assert.equal(MpvPlayer.headerFieldsValue(null), '');
    assert.equal(MpvPlayer.headerFieldsValue(undefined), '');
    assert.equal(MpvPlayer.headerFieldsValue(' Referer: x'), '');
    assert.equal(MpvPlayer.headerFieldsValue({}), '');
});

// ---------------------------------------------------------------- 右键上下文菜单（版本门控 + 参数注入）

// 原生多集队列：m3u 生成 + 首集延迟 seek + 逐集记账载荷
test('buildM3u(): #EXTINF 集名与 URL 成对；换行/Tab 压空格；空列表回退空串', () => {
    const m3u = MpvPlayer.buildM3u([
        { url: 'http://x/1.mp4', title: '第01集\n预告\t版' },
        { url: 'file:///d/a.mkv' }, // 无标题也保留条目
        null,
        { title: '无地址不收录' },
    ]);
    const lines = m3u.split('\n').filter((l) => l !== '');
    assert.equal(lines[0], '#EXTM3U');
    assert.ok(lines.includes('#EXTINF:-1,第01集 预告 版'));
    assert.ok(lines.includes('http://x/1.mp4'));
    assert.ok(lines.includes('file:///d/a.mkv'));
    assert.ok(!lines.some((l) => l.includes('无地址不收录')));
    assert.equal(MpvPlayer.buildM3u([]), '');
    assert.equal(MpvPlayer.buildM3u(null), '');
});

test('原生队列首集续播：pendingSeekSec 只在首次 file-loaded 应用一次，ready 照常逐次发出', async () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    const seeks = [];
    p.command = (...args) => {
        if (args[0] === 'seek') seeks.push(args); // 只捕获 seek
        // 轨守卫走 get_property time-pos：桩回片头附近（无 watch-later 恢复）→ seek 放行
        if (args[0] === 'get_property' && args[1] === 'time-pos') return Promise.resolve(0.4);
        if (args[0] === 'get_property') return Promise.resolve(0);
        return Promise.resolve();
    };
    p._activeSession = { id: 30, ready: false, pendingSeekSec: 95.5, seekApplied: false, itemStartMs: Date.now() };
    let readyCount = 0;
    p.on('ready', () => { readyCount += 1; });
    p._onEvent({ event: 'file-loaded' });
    p._onEvent({ event: 'file-loaded' }); // 第二集装载：不再 seek
    await new Promise((r) => setImmediate(r)); // 守卫读 time-pos 异步返回后才 seek
    assert.deepEqual(seeks, [['seek', 95.5, 'absolute+exact']]);
    assert.equal(readyCount, 2); // waitForReady 依赖每次 file-loader 的 ready 事件
    assert.equal(p._activeSession.seekApplied, true);
});

test('ended 载荷：原生队列携带 nativeQueue/playlistPos/itemWallSec/pos/duration 供渲染层逐集记账', () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    p._queueLen = 12;
    p._activeSession = { id: 31, nativeQueue: true, pos: 30, duration: 90,
        fullscreen: false, speed: 1, itemStartMs: Date.now() - 30000 };
    let ended = null;
    p.on('ended', (info) => { ended = info; });
    p._onEvent({ event: 'end-file', reason: 'eof', playlist_pos: 4 });
    assert.equal(ended.playlistPos, 4);
    assert.equal(ended.queueLen, 12);
    assert.equal(ended.nativeQueue, true);
    assert.equal(ended.pos, 90);       // eof 把进度补满
    assert.equal(ended.duration, 90);
    assert.ok(ended.itemWallSec >= 29 && ended.itemWallSec <= 32, `itemWallSec 异常：${ended.itemWallSec}`);
});

// select.lua 的 context-menu 绑定与自定义 menu.conf 自 mpv 0.41 起提供；
// git 开发版版本号 ≥ 对应的下一个发布版，同样视为支持。
test('parseMpvVersion(): 解析发布版与 git 版本首行', () => {
    assert.deepEqual(MpvPlayer.parseMpvVersion('mpv v0.41.0-73-g7b8915bc1d'), { major: 0, minor: 41 });
    assert.deepEqual(MpvPlayer.parseMpvVersion('mpv 0.40.0'), { major: 0, minor: 40 });
    assert.deepEqual(MpvPlayer.parseMpvVersion('mpv v1.0.0'), { major: 1, minor: 0 }); // 未来主版本升位
    assert.equal(MpvPlayer.parseMpvVersion('mpv UNKNOWN'), null);
    assert.equal(MpvPlayer.parseMpvVersion(''), null);
    assert.equal(MpvPlayer.parseMpvVersion(null), null);
});

test('supportsContextMenu(): 仅 0.41+/git 版注入右键菜单（旧版默认右键=暂停，保持原样）', () => {
    assert.equal(MpvPlayer.supportsContextMenu('mpv v0.41.0-73-g7b8915bc1d'), true);
    assert.equal(MpvPlayer.supportsContextMenu('mpv v0.42.0 (C) 2026 mpv-player.org'), true);
    assert.equal(MpvPlayer.supportsContextMenu('mpv v1.0.0'), true);
    assert.equal(MpvPlayer.supportsContextMenu('mpv 0.40.0'), false);
    assert.equal(MpvPlayer.supportsContextMenu('mpv 0.38.0'), false);
    assert.equal(MpvPlayer.supportsContextMenu('mpv UNKNOWN'), false); // 解析失败一律按不支持处理
    assert.equal(MpvPlayer.supportsContextMenu(null), false);
});

test('_contextMenuArgs(): menu.conf 存在即注入（旧版 mpv 忽略未知 script-opt 键，无副作用），路径转正斜杠', () => {
    const fs = require('fs');
    const path = require('path');
    const conf = path.join(require('os').tmpdir(), 'yuki-menu-conf-test', 'menu.conf');
    try { fs.mkdirSync(path.dirname(conf), { recursive: true }); fs.writeFileSync(conf, '退出\tquit\n'); } catch (e) { /* ignore */ }

    const p = Object.create(MpvPlayer.prototype);
    p.menuConfPath = conf;
    const a = p._contextMenuArgs();
    assert.equal(a.length, 1);
    assert.ok(a[0].startsWith('--script-opt=select-menu_conf_path='));
    assert.ok(!a[0].includes('\\'), 'Windows 路径必须转为正斜杠');
    assert.ok(a[0].endsWith('/menu.conf'));

    // 未生成/文件缺失时不注入
    p.menuConfPath = null;
    assert.deepEqual(p._contextMenuArgs(), []);
    p.menuConfPath = path.join(require('os').tmpdir(), 'yuki-no-such-menu.conf');
    assert.deepEqual(p._contextMenuArgs(), []);
    try { fs.rmSync(path.dirname(conf), { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

test('_probeContextMenuBinding(): 默认绑定含 select/context-menu 才运行时注入 MBTN_RIGHT', async () => {
    const mk = (bindings) => {
        const p = Object.create(MpvPlayer.prototype);
        const calls = [];
        p.getProperty = (name) => { assert.equal(name, 'input-bindings'); return Promise.resolve(bindings); };
        p.command = (...args) => { calls.push(args); return Promise.resolve(); };
        return { p, calls };
    };
    // 新版默认绑定（MENU → context-menu）存在：keybind 注入右键
    const a = mk([
        { key: 'MBTN_RIGHT', cmd: 'cycle pause' },
        { key: 'MENU', cmd: 'script-binding select/context-menu' },
    ]);
    await a.p._probeContextMenuBinding();
    assert.deepEqual(a.calls, [['keybind', 'MBTN_RIGHT', 'script-binding select/context-menu']]);
    // 旧版（只有右键暂停）：不注入，保持其默认行为，绝不发死绑定
    const b = mk([{ key: 'MBTN_RIGHT', cmd: 'cycle pause' }]);
    await b.p._probeContextMenuBinding();
    assert.deepEqual(b.calls, []);
});

// ---------------------------------------------------------------- 起播失败原因提取（日志噪音过滤）

// mpv --log-file 尾部充满收尾调试行（Destroying client handle…），直接切尾巴
// 会把无信息量噪音当错误原因展示给用户（「mpv 已退出，媒体尚未开始播放」弹窗）。
const MPV_DEAD_LINK_LOG = [
    '[ 0.412][v][lavf] Opening \'https://v.example/share/dead\'',
    '[ 0.902][e][ffmpeg] http: HTTP error 404 Not Found',
    '[ 0.903][e][lavf] Failed to recognize file format.',
    '[ 0.903][i][cplayer] Exiting... (Errors when loading file)',
    '[ 0.968][d][console] Destroying client handle...',
    '[ 0.968][d][select] Destroying client handle...',
    '[ 0.969][d][osc] Destroying client handle...',
    '[ 0.969][d] Terminating.',
].join('\n');

test('extractErrorReason(): 保留 error 级行，剔除 Destroying client handle 噪音', () => {
    const text = MpvPlayer.extractErrorReason(MPV_DEAD_LINK_LOG);
    assert.match(text, /HTTP error 404/);
    assert.match(text, /Failed to recognize file format/);
    assert.doesNotMatch(text, /Destroying client handle/);
});

test('extractErrorReason(): 无 error 级时退回非调试行尾部（仍去噪音）', () => {
    const log = [
        '[ 0.100][v][cplayer] starting playback',
        '[ 0.200][d][console] Destroying client handle...',
        '[ 0.300][i][cplayer] Exiting... (Quit)',
    ].join('\n');
    const text = MpvPlayer.extractErrorReason(log);
    assert.ok(text.includes('starting playback'));
    assert.ok(text.includes('Exiting'));
    assert.doesNotMatch(text, /Destroying client handle/);
});

test('extractErrorReason(): 空输入返回空串；超长截断到 limit', () => {
    assert.equal(MpvPlayer.extractErrorReason(''), '');
    assert.equal(MpvPlayer.extractErrorReason(null), '');
    const long = MpvPlayer.extractErrorReason(`[ 1.000][e][x] ${'a'.repeat(2000)}`);
    assert.ok(long.length <= 600);
});

// mpv 旧版 ytdl_hook 对缺失的 youtube-dl/yt-dlp 逐一 spawn 失败会刷屏：
// "Subprocess failed: init" ×N + "youtube-dl failed"。直链播放与 ytdl 无关，
// 存在其它模块错误行时必须整段丢弃，只留真实原因。
const MPV_YTDL_SPAM_ONLY = [
    '[ 0.236][e][ytdl_hook] Subprocess failed: init',
    '[ 0.239][e][ytdl_hook] Subprocess failed: init',
    '[ 1.213][e][ytdl_hook] Subprocess failed: init',
    '[ 1.216][e][ytdl_hook] youtube-dl failed: not found or not enough permissions',
].join('\n');

const MPV_YTDL_SPAM_WITH_DEMUX = `${MPV_YTDL_SPAM_ONLY}\n[ 1.300][w][demux] DEMUXER_ERROR_NO_VALID_DATA`;

test('extractErrorReason(): 同文重复行折叠 ×N', () => {
    const text = MpvPlayer.extractErrorReason(MPV_YTDL_SPAM_ONLY);
    assert.match(text, /Subprocess failed: init（×3）/);
    assert.equal((text.match(/Subprocess failed: init/g) || []).length, 1);
    assert.match(text, /youtube-dl failed/);
});

test('extractErrorReason(): 有其它模块错误行时丢弃 ytdl 噪音行', () => {
    const text = MpvPlayer.extractErrorReason(MPV_YTDL_SPAM_WITH_DEMUX);
    assert.doesNotMatch(text, /ytdl_hook|youtube-dl/);
    assert.match(text, /DEMUXER_ERROR_NO_VALID_DATA/);
});
