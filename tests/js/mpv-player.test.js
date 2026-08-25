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

test('原生队列首集续播：pendingSeekSec 只在首次 file-loaded 应用一次，ready 照常逐次发出', () => {
    const p = Object.create(MpvPlayer.prototype);
    p._pending = new Map();
    const seeks = [];
    p.command = (...args) => {
        if (args[0] === 'seek') seeks.push(args); // 只捕获 seek；file-loaded 还会查 playlist-pos
        return Promise.resolve();
    };
    p._activeSession = { id: 30, ready: false, pendingSeekSec: 95.5, seekApplied: false, itemStartMs: Date.now() };
    let readyCount = 0;
    p.on('ready', () => { readyCount += 1; });
    p._onEvent({ event: 'file-loaded' });
    p._onEvent({ event: 'file-loaded' }); // 第二集装载：不再 seek
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
    p.supportsContextMenu = false; // 版本解析仅作参考信息，不再是注入门槛
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
