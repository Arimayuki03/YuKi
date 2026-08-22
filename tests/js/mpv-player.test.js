// 组件测试：mpv-player.js 静态助手（弹幕行解析 / ASS 颜色 / 时间戳）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const MpvPlayer = require('../../src/main/mpv-player');

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
    assert.deepEqual(ended, { sessionId: 9, playlistPos: 1, queueLen: 3 });
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

// ---------------------------------------------------------------- 视频缓冲缓存（只走内存）

test('_cacheArgs(): 在线播放缓存只进内存，不落磁盘', () => {
    const p = Object.create(MpvPlayer.prototype);
    const a = p._cacheArgs(true);
    assert.ok(a.includes('--cache=yes'));
    assert.ok(a.includes('--demuxer-max-bytes=512MiB'));      // 内存缓冲上限
    assert.ok(a.includes('--demuxer-max-back-bytes=128MiB')); // 回退缓冲（同为内存）
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
