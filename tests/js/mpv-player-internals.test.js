// 白盒单元测试：mpv-player.js 内部实现（argv 拼装 / IPC 帧协议 / 生命周期 / 控制命令）
//
// 与 tests/js/mpv-player.test.js 互补：后者覆盖静态助手（parseDanmaku/_ts/escapeOsdText/
// buildM3u/extractErrorReason…）与事件语义（end-file/file-loaded 续播守卫/waitForReady/
// 弹幕轨门控/缓存与截图参数）。本文件补其未覆盖的部分：
//   - play() 的完整命令行拼装（各设置项映射、参数转义、路径含空格与中文、倍速优先级与
//     冲突参数覆盖顺序、原生队列 startIndex 重映射）
//   - command()/_onData()/_onEvent() 的 IPC 帧收发（序列化、粘包半包、错序应答、超时）
//   - 生命周期（spawn 异步 error、exit 退出信息映射与退出码、重复关闭幂等、重探自愈、重启）
//   - 控制命令（setPause/seek/setVolume/setSpeed/getProperty/screenshot）参数正确性
//
// 隔离方式：vm 沙箱装载源码，child_process / win-focus / net 全部替身，
// 绝不真起 mpv 进程、绝不真连命名管道。
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const osReal = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// 所有落盘动作（ASS/播放清单/日志/截图目录）都收在这个临时目录里，避免污染真实 %TEMP%
const TMP = fs.mkdtempSync(path.join(osReal.tmpdir(), 'yuki-mpv-internals-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

/** 可控定时器：记录 setTimeout/setInterval，由测试显式触发（不依赖真实时钟等待 5s/3s）。 */
function makeTimerHarness() {
    const timeouts = new Map();
    const intervals = new Map();
    let seq = 0;
    return {
        setTimeout(fn, ms) {
            const h = { id: ++seq, ms, fn, unref() { return this; } };
            timeouts.set(h.id, h);
            return h;
        },
        clearTimeout(h) { timeouts.delete(h && h.id !== undefined ? h.id : h); },
        setInterval(fn, ms) {
            const h = { id: ++seq, ms, fn };
            intervals.set(h.id, h);
            return h;
        },
        clearInterval(h) { intervals.delete(h && h.id !== undefined ? h.id : h); },
        /** 触发（可选按 ms 过滤的）到期定时器 */
        fireTimeouts(pred) {
            for (const h of [...timeouts.values()]) {
                if (pred && !pred(h)) continue;
                timeouts.delete(h.id);
                h.fn();
            }
        },
        counts() { return { timeouts: timeouts.size, intervals: intervals.size }; },
    };
}

/** mpv 子进程替身：可注册/触发 error、exit，记录 kill 调用。 */
function makeProc(pid = 4242) {
    const handlers = new Map();
    const push = (ev, cb) => {
        if (!handlers.has(ev)) handlers.set(ev, []);
        handlers.get(ev).push(cb);
    };
    return {
        pid,
        stderr: null,
        killed: [],
        on(ev, cb) { push(ev, cb); return this; },
        once(ev, cb) { push(ev, cb); return this; },
        kill(sig) { this.killed.push(sig); return true; },
        emit(ev, ...args) { for (const cb of [...(handlers.get(ev) || [])]) cb(...args); },
        count(ev) { return (handlers.get(ev) || []).length; },
    };
}

/** IPC socket 替身：记录写入帧、可注入下行数据。 */
function makeSock() {
    const handlers = new Map();
    const push = (ev, cb) => {
        if (!handlers.has(ev)) handlers.set(ev, []);
        handlers.get(ev).push(cb);
    };
    return {
        written: [],
        destroyed: false,
        write(s) { this.written.push(String(s)); return true; },
        destroy() { this.destroyed = true; },
        on(ev, cb) { push(ev, cb); return this; },
        once(ev, cb) { push(ev, cb); return this; },
        emit(ev, ...args) { for (const cb of [...(handlers.get(ev) || [])]) cb(...args); },
    };
}

const SRC = path.join(__dirname, '../../src/main/mpv-player.js');

/**
 * 在 vm 沙箱里装载 mpv-player.js。
 * @param {{spawnSyncOut?: string, makeProc?: Function, findMpvTarget?: Function}} [opts]
 * `findMpvTarget`：返回自动发现应命中的路径（null = 自动发现一无所获）。
 * 用它把「vendor 里是否真实存在 mpv.exe」从测试前提里剥掉——vendor/ 不入库，
 * CI 全新 checkout 上该目录为空，重探/恢复默认类用例不能依赖宿主机文件系统。
 */
function loadMpv(opts = {}) {
    const source = fs.readFileSync(SRC, 'utf8');
    const timers = makeTimerHarness();
    const spawnCalls = [];
    const execCalls = [];
    const frontCalls = [];
    const netSockets = [];
    const osStub = new Proxy(osReal, {
        get(t, p) { return p === 'tmpdir' ? () => TMP : t[p]; },
    });
    const findMpvTarget = opts.findMpvTarget || null;
    // findMpvTarget 生效时：fs.existsSync 只对「沙箱自身算出的 vendor mpv 路径」为真——
    // vendor/ 不入库，CI 全新 checkout 上该目录为空，重探/恢复默认类用例不能依赖宿主机
    // 文件系统。注入后 findMpv 把 vendor 路径当真实候选（版本校验走 spawnSync 替身恒
    // 成功），自动发现的「命中」分支即可在 CI 上稳定复现。
    const vendorFake = path.join(path.dirname(SRC), '..', '..', 'vendor', 'mpv', 'mpv.exe');
    const fsForSandbox = (findMpvTarget !== null)
        ? new Proxy(fs, {
            get(t, p) {
                if (p === 'existsSync') {
                    return (fp) => {
                        const s = String(fp);
                        return s === vendorFake || s === path.resolve(vendorFake) || s === path.resolve(String(vendorFake));
                    };
                }
                return t[p];
            },
        })
        : fs;
    const context = {
        console: { log() { }, warn() { }, error() { } },
        process: { pid: 4242, platform: 'win32', resourcesPath: '' },
        // ROOT 计算落在 catch 分支（未注入 electron.app），需要 __dirname 参与路径拼接
        __dirname: path.dirname(SRC),
        __filename: SRC,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        module: { exports: {} },
        require(name) {
            switch (name) {
                case 'fs': return fsForSandbox;
                case 'os': return osStub;
                case 'path': return path;
                case 'events': return { EventEmitter };
                case 'net': return {
                    connect() {
                        const sock = makeSock();
                        netSockets.push(sock);
                        return sock;
                    },
                };
                case 'child_process': return {
                    spawn(bin, args, o) {
                        const proc = opts.makeProc ? opts.makeProc() : makeProc();
                        spawnCalls.push({ bin, args, opts: o, proc });
                        return proc;
                    },
                    spawnSync() {
                        return { status: 0, stdout: opts.spawnSyncOut || 'mpv v0.41.0 (C) 2026\n', stderr: '' };
                    },
                    exec(cmd, o, cb) {
                        execCalls.push(String(cmd));
                        if (typeof cb === 'function') cb(null, '', '');
                        return {};
                    },
                    execSync() { return ''; },
                };
                case 'electron': return {}; // app 未定义 → ROOT 计算走 catch 分支
                case './win-focus': return { bringToFront: (pid) => frontCalls.push(pid) };
                default: throw new Error(`unexpected dependency: ${name}`);
            }
        },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__MpvPlayer = MpvPlayer;`, context, { filename: SRC });
    return { MpvPlayer: context.__MpvPlayer, timers, spawnCalls, execCalls, frontCalls, netSockets };
}

/** 建一个已就绪的播放器：binary 指向真实存在的 node（play() 会做存在性校验），
 *  IPC 走 net.connect 替身（只造 socket 对象、不真连命名管道，除非测试显式 emit('connect')）。 */
function mkPlayer(opts = {}) {
    const ctx = loadMpv(opts);
    const p = new ctx.MpvPlayer();
    if (opts.findMpvTarget !== true) p.binary = process.execPath;
    return { p, ctx };
}

/** 起播并截获 argv / 返回值 / 子进程替身。 */
function playAndCapture(p, ctx, episodes, popts = {}) {
    const r = p.play(episodes, popts);
    const last = ctx.spawnCalls[ctx.spawnCalls.length - 1];
    return { result: r, argv: last ? last.args : null, proc: last ? last.proc : null };
}

/** 断言 argv 中存在形如 `--key=value` 的项并返回值。 */
function argValue(argv, key) {
    const prefix = `--${key}=`;
    const hit = argv.find((a) => typeof a === 'string' && a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
}

// ---------------------------------------------------------------- argv 拼装：基础与分隔符

test('play(): 单集基础 argv 与 `--` 分隔（本地路径含空格与中文原样传参、不 shell 转义）', () => {
    const { p, ctx } = mkPlayer();
    // mpv 由 execve 直接传参，路径含空格/中文无需引号或转义；加引号反而会让 mpv 找不到文件
    const local = 'D:\\剧集 收藏\\第 01 集 测试.mp4';
    const { argv } = playAndCapture(p, ctx, [{ url: local, title: '第1集' }]);
    assert.ok(argv.includes('--idle=no'), '播完即退，不常驻');
    assert.ok(argv.includes('--no-terminal'));
    assert.ok(argv.includes('--focus-on=open'), 'v0.41 起 --focus-on-open 已移除，改用 --focus-on=open');
    assert.ok(argv.includes('--sub-auto=no') && argv.includes('--sub-visibility=yes'));
    assert.ok(!argv.includes('--ontop'), '不得常驻置顶（前置交给 _bringToFront）');
    assert.equal(argv.filter((a) => a === '--').length, 1, '`--` 分隔符必须且只能出现一次');
    assert.equal(argv[argv.length - 1], local, 'URL/路径必须是最后一个参数且原样保留');
    assert.ok(argv.indexOf('--') < argv.length - 1);
    assert.match(argValue(argv, 'input-ipc-server'), /^\\\\\.\\pipe\\yuki-mpv-/);
});

// ---------------------------------------------------------------- argv 拼装：设置项映射

test('play(): 各设置项映射为对应 mpv 参数（alang/slang/glsl-shaders/fs/log-file/sub-file/format）', () => {
    const { p, ctx } = mkPlayer();
    p.audioLang = 'jpn';
    p.subLang = 'zh,chi';
    p.anime4kShaders = 'C:\\shaders\\Anime4K.glsl';
    p.logFilePath = path.join(TMP, 'logs', 'mpv.log'); // 目录不存在：应被兜底创建
    const { argv } = playAndCapture(p, ctx, [{ url: 'https://cdn.test/a.m3u8' }], {
        fullscreen: true,
        format: 'application/x-mpegurl',
        subs: ['https://sub.test/zh.srt', { url: 'https://sub.test/en.vtt' }, { src: 'file:///local.srt' }],
    });
    assert.equal(argValue(argv, 'alang'), 'jpn', '音轨语言偏好');
    assert.equal(argValue(argv, 'slang'), 'zh,chi', '字幕语言偏好');
    assert.equal(argValue(argv, 'glsl-shaders'), 'C:\\shaders\\Anime4K.glsl', 'Anime4K 着色器链');
    assert.ok(argv.includes('--fs'), '连播延续的全屏状态');
    assert.equal(argValue(argv, 'demuxer-lavf-format'), 'hls', 'MIME → libavformat 名');
    assert.equal(argValue(argv, 'log-file'), path.join(TMP, 'logs', 'mpv.log'));
    assert.ok(fs.existsSync(path.dirname(p.logFilePath)), '--log-file 目录须兜底创建');
    // 外置字幕：http(s) 才收；file:// 与未知对象不得进 argv
    const subFiles = argv.filter((a) => a.startsWith('--sub-file='));
    assert.deepEqual(subFiles, ['--sub-file=https://sub.test/zh.srt', '--sub-file=https://sub.test/en.vtt']);
});

test('play(): 非法/未知 format 不注入 --demuxer-lavf-format（不污染 argv）', () => {
    const { p, ctx } = mkPlayer();
    const bad = playAndCapture(p, ctx, [{ url: 'https://cdn.test/a.mp4' }], { format: 'video/mp4; charset=utf-8' });
    assert.equal(argValue(bad.argv, 'demuxer-lavf-format'), undefined, '含非法字符的 MIME 一律丢弃');
    // 白名单内照常映射；白名单外但字符集合法的裸容器名保留
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }], { format: 'application/dash+xml' }).argv,
        'demuxer-lavf-format'), 'dash');
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }], { format: 'HLS' }).argv,
        'demuxer-lavf-format'), 'hls', '大小写不敏感，小写化后放行');
});

// ---------------------------------------------------------------- argv 拼装：倍速优先级与冲突覆盖

test('play(): 倍速优先级（opts.speed > defaultSpeed）与夹取（0.1~4；=1 不注入）', () => {
    const { p, ctx } = mkPlayer();
    // opts.speed 覆盖默认倍速
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }], { speed: 2 }).argv, 'speed'), '2');
    // 未传 speed → 用 defaultSpeed
    p.defaultSpeed = 1.5;
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }]).argv, 'speed'), '1.5');
    // opts.speed 优先于 defaultSpeed（连播延续的当前速度压过设置默认）
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }], { speed: 0.5 }).argv, 'speed'), '0.5');
    // 夹取：>4 → 4；极小值 → 0.1（下限放宽为 0.1，历史低倍速配置不被悄悄抬高）
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }], { speed: 99 }).argv, 'speed'), '4');
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }], { speed: 0.01 }).argv, 'speed'), '0.1');
    // 非法（0/负/NaN）回落 defaultSpeed；speed===1 时不注入（保持 argv 与旧路径一致）
    p.defaultSpeed = 3;
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }], { speed: -1 }).argv, 'speed'), '3');
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }], { speed: 0 }).argv, 'speed'), '3');
    p.defaultSpeed = 1;
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }]).argv, 'speed'), undefined, '1 倍速不注入');
});

test('play(): 标题与 OSD 转义（$ 翻倍、引号剔除；原生队列 --title=yuki）', () => {
    const { p, ctx } = mkPlayer();
    // 片名含裸 $：osd-playing-msg 会做属性展开，必须翻倍；--title 里的 $ 与 " 直接剔除
    const single = playAndCapture(p, ctx, [{ url: 'x' }], { title: 'A"$B 剧集' });
    assert.equal(argValue(single.argv, 'osd-playing-msg'), 'A"$$B 剧集', 'OSD 文本里的 $ 翻倍');
    assert.equal(argValue(single.argv, 'title'), 'yuki · AB 剧集',
        '窗口标题剔除 $ 与引号（不补空格），避免 CDN 文件名/乱码串进标题');
    // 未给标题时的默认文案
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }]).argv, 'title'), 'yuki · YuKi');
    // 原生队列：$ 由 ${media-title} 展开跟随集名，标题固定 yuki（file-loaded 时经 IPC 改写）
    const queue = playAndCapture(p, ctx, [{ url: 'a' }, { url: 'b' }], { title: 'X$Y' });
    assert.equal(argValue(queue.argv, 'title'), 'yuki');
    assert.equal(argValue(queue.argv, 'osd-playing-msg'), 'X$$Y');
});

test('play(): 冲突参数覆盖顺序 —— 原生队列用 pendingSeekSec 取代全局 --start', () => {
    const { p, ctx } = mkPlayer();
    // 单集：position(ms) → --start=秒
    const single = playAndCapture(p, ctx, [{ url: 'https://cdn.test/a.m3u8' }], { position: 60000 });
    assert.equal(argValue(single.argv, 'start'), '60');
    assert.equal(p._activeSession.pendingSeekSec, null, '单集不需要延迟 seek');
    // 原生队列：--start 是全局选项会作用到每一集，改为首集装载后 IPC seek 一次
    const queue = playAndCapture(p, ctx, [{ url: 'https://cdn.test/a.m3u8' }, { url: 'https://cdn.test/b.m3u8' }],
        { position: 60000 });
    assert.equal(argValue(queue.argv, 'start'), undefined, '原生队列不得下发 --start');
    assert.equal(p._activeSession.pendingSeekSec, 60);
    assert.equal(p._activeSession.seekApplied, false);
    // 非法 position（NaN/0/负）不注入
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }], { position: 0 }).argv, 'start'), undefined);
    assert.equal(argValue(playAndCapture(p, ctx, [{ url: 'x' }], { position: 'abc' }).argv, 'start'), undefined);
});

test('play(): --playlist-start 仅 >0 注入；startIndex 越界/该集无 url 时回退 0', () => {
    const { p, ctx } = mkPlayer();
    const eps = [{ url: 'a' }, { url: 'b' }, { url: 'c' }];
    // 下标 0：不传（保持 argv 与旧单集路径一致）
    assert.equal(argValue(playAndCapture(p, ctx, eps, { startIndex: 0 }).argv, 'playlist-start'), undefined);
    assert.equal(argValue(playAndCapture(p, ctx, eps, { startIndex: 2 }).argv, 'playlist-start'), '2');
    // 越界 / 非法：绝不传越界的 --playlist-start
    assert.equal(argValue(playAndCapture(p, ctx, eps, { startIndex: 99 }).argv, 'playlist-start'), undefined);
    assert.equal(argValue(playAndCapture(p, ctx, eps, { startIndex: 'x' }).argv, 'playlist-start'), undefined);
    assert.equal(argValue(playAndCapture(p, ctx, eps, { startIndex: -3 }).argv, 'playlist-start'), undefined);
});

test('play(): m3u 下标重映射（缺 url 的集被剔除后 startIndex 与 _queueTitles 同步）', () => {
    const { p, ctx } = mkPlayer();
    // 第 2 集无 url：buildM3u 会剔除，原数组下标 2 → m3u 实际下标 1
    const eps = [{ url: 'https://cdn.test/1.m3u8' }, { title: '第2集' }, { url: 'https://cdn.test/3.m3u8' }];
    p._queueTitles = ['第1集', '第2集', '第3集'];
    const { argv } = playAndCapture(p, ctx, eps, { startIndex: 2 });
    assert.equal(argValue(argv, 'playlist-start'), '1', '必须按 m3u 实际下标，不能越界');
    assert.deepEqual(p._queueTitles, ['第1集', '第3集'], '逐集标题表须同步重映射');
    // 清单文件确实写盘且只含带 url 的条目
    const m3u = fs.readFileSync(argv[argv.length - 1], 'utf8');
    assert.equal((m3u.match(/^#EXTINF:/gm) || []).length, 2);
    assert.ok(m3u.includes('https://cdn.test/3.m3u8'));
    // 选中的集本身没有 url（下标 1）→ 回退 0 从头播
    const fallback = playAndCapture(p, ctx, eps, { startIndex: 1 });
    assert.equal(argValue(fallback.argv, 'playlist-start'), undefined);
});

test('play(): 在线 URL 注入网络预缓冲，本地文件只显式关闭落盘（isNet 由首集判定）', () => {
    const { p, ctx } = mkPlayer();
    const net = playAndCapture(p, ctx, [{ url: 'https://cdn.test/a.m3u8' }]).argv;
    assert.ok(net.includes('--cache=yes'), '在线预缓冲');
    assert.ok(net.includes('--demuxer-max-bytes=256MiB'));
    assert.ok(net.includes('--network-timeout=120'), '网盘转流首字节可能等 5-20s');
    assert.ok(net.includes('--cache-on-disk=no'), '缓存一律落内存');
    const local = playAndCapture(p, ctx, [{ url: 'D:\\a.mp4' }]).argv;
    assert.ok(!local.includes('--cache=yes'), '本地文件不需要预缓冲');
    assert.deepEqual(local.filter((a) => a.startsWith('--demuxer-') || a.startsWith('--cache')),
        ['--cache-on-disk=no']);
});

test('play(): resume=false（直播）或未设 watchLaterDir 时不注入续播参数', () => {
    const { p, ctx } = mkPlayer();
    // 未设目录：不注入
    assert.ok(!playAndCapture(p, ctx, [{ url: 'x' }]).argv.some((a) => a.startsWith('--watch-later-directory=')));
    p.watchLaterDir = path.join(TMP, 'watch-later');
    const on = playAndCapture(p, ctx, [{ url: 'x' }]).argv;
    assert.ok(on.includes('--save-position-on-quit'));
    assert.equal(argValue(on, 'watch-later-directory'), path.join(TMP, 'watch-later'));
    assert.ok(fs.existsSync(p.watchLaterDir), '续播目录须兜底创建');
    // 直播：位置不记录，避免下次误跳旧位置
    const live = playAndCapture(p, ctx, [{ url: 'x' }], { resume: false }).argv;
    assert.ok(!live.includes('--save-position-on-quit'));
    assert.ok(!live.some((a) => a.startsWith('--watch-later-directory=')));
});

test('play(): header 值内逗号按 mpv 列表语法转义后拼进 --http-header-fields', () => {
    const { p, ctx } = mkPlayer();
    const { argv } = playAndCapture(p, ctx, [{ url: 'x' }], {
        header: { Referer: 'https://x.test/', Accept: 'text/html,application/json' },
    });
    const v = argValue(argv, 'http-header-fields');
    assert.equal(v, 'Referer: https://x.test/, Accept: text/html\\,application/json',
        '值内逗号写成 \\,（否则被当头分隔符拆开 → CDN 400）');
});

// ---------------------------------------------------------------- argv 拼装：ytdl/功能资产与失败路径

test('play(): spawn 同步抛异常返回 mpv-spawn-failed 并携带 trace 字段，不崩溃', () => {
    const { p, ctx } = mkPlayer();
    p._spawn = () => { throw new Error('EACCES: permission denied'); };
    const r = p.play([{ url: 'https://cdn.test/a.m3u8' }],
        { requestId: 'play-spawn-0001', playSessionId: 'sess-spawn-0001' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'mpv-spawn-failed');
    assert.equal(r.error, 'EACCES: permission denied');
    assert.equal(r.requestId, 'play-spawn-0001', 'trace 字段必须随失败返回，供前端对账');
    assert.equal(r.playSessionId, 'sess-spawn-0001');
    assert.equal(p.proc, null);
    assert.equal(ctx.timers.counts().timeouts, 0, '未起播不得留下 IPC 重试定时器');
});

test('play(): 成功返回载荷（url/urls/nativeQueue/controlGen/sessionId/trace）', () => {
    const { p, ctx } = mkPlayer();
    const eps = [{ url: 'https://cdn.test/1.m3u8' }, { url: 'https://cdn.test/2.m3u8' }];
    const r = p.play(eps, { requestId: 'r1', playSessionId: 's1' });
    assert.equal(r.ok, true);
    assert.equal(r.sessionId, 1);
    assert.equal(r.nativeQueue, true, '≥2 集走 mpv 原生队列');
    assert.equal(r.url, 'https://cdn.test/1.m3u8');
    assert.deepEqual(r.urls, ['https://cdn.test/1.m3u8', 'https://cdn.test/2.m3u8']);
    assert.equal(r.controlGen, p.controlGen);
    assert.equal(r.requestId, 'r1');
    assert.equal(r.playSessionId, 's1');
    // 单集模式
    const single = p.play([{ url: 'https://cdn.test/only.m3u8' }]);
    assert.equal(single.nativeQueue, false);
    assert.equal(single.sessionId, 2, '每次起播会话号自增，供 exit 事件区分新旧进程');
    // 空列表：不 spawn
    const before = ctx.spawnCalls.length;
    assert.deepEqual(p.play([]), { ok: false, reason: 'empty playlist' });
    assert.deepEqual(p.play(null), { ok: false, reason: 'empty playlist' });
    assert.equal(ctx.spawnCalls.length, before, '空列表不得起进程');
});

// ---------------------------------------------------------------- IPC：命令序列化

test('command(): 序列化为单行 JSON + 换行终止，request_id 自增且不重复', () => {
    const { p } = mkPlayer();
    const sock = makeSock();
    p.socket = sock;
    p._connected = true;
    p.command('get_property', 'time-pos');
    p.command('seek', 12.5, 'relative');
    assert.equal(sock.written.length, 2);
    assert.equal(sock.written[0], '{"command":["get_property","time-pos"],"request_id":1}\n');
    assert.equal(sock.written[1], '{"command":["seek",12.5,"relative"],"request_id":2}\n');
    assert.ok(sock.written.every((f) => f.endsWith('\n') && f.indexOf('\n') === f.length - 1),
        '每帧必须单行且以 \\n 终止（mpv 按行切分）');
    assert.equal(p._pending.size, 2, '两帧各占一个待应答槽');
    assert.deepEqual([...p._pending.keys()], [1, 2]);
});

test('command(): 未连接立即拒绝；socket.write 抛错时拒绝并清理 pending 与定时器', async () => {
    const { p, ctx } = mkPlayer();
    // 未连接
    await assert.rejects(() => p.command('quit'), /mpv ipc not connected/);
    assert.equal(ctx.timers.counts().timeouts, 0, '拒绝路径不得留下悬挂定时器');
    // write 抛错（管道断开）
    const sock = makeSock();
    sock.write = () => { throw new Error('EPIPE'); };
    p.socket = sock;
    p._connected = true;
    await assert.rejects(() => p.command('quit'), /EPIPE/);
    assert.equal(p._pending.size, 0, 'write 失败必须同步摘掉待应答项');
    assert.equal(ctx.timers.counts().timeouts, 0, 'write 失败必须清掉 5s 超时定时器');
});

test('command(): 5s 无应答超时拒绝并从 _pending 移除（不累积悬挂请求）', async () => {
    const { p, ctx } = mkPlayer();
    const sock = makeSock();
    p.socket = sock;
    p._connected = true;
    const pr = p.command('get_property', 'duration');
    assert.equal(p._pending.size, 1);
    assert.equal(ctx.timers.counts().timeouts, 1, '起一个 5s 超时定时器');
    ctx.timers.fireTimeouts((h) => h.ms === 5000);
    await assert.rejects(() => pr, /mpv ipc timeout/);
    assert.equal(p._pending.size, 0, '超时后必须摘除，否则高频命令无限累积');
    assert.equal(ctx.timers.counts().timeouts, 0);
});

// ---------------------------------------------------------------- IPC：响应解析

test('_onData(): 粘包/半包/空行/非法 JSON/CRLF 混合到达时只派发完整合法帧', () => {
    const { p } = mkPlayer();
    const seen = [];
    p._onEvent = (msg) => seen.push(msg);
    // 半包：第一帧被切成两段到达
    p._onData(Buffer.from('{"event":"a"'));
    assert.equal(seen.length, 0, '半包不得派发');
    p._onData(Buffer.from(',"v":1}\n'));
    assert.equal(seen.length, 1);
    // 粘包：两帧一次到达（含 CRLF 与空行、非法 JSON）
    p._onData(Buffer.from('\nnot-json\r\n{"event":"b"}\r\n{"event":"c","n":2}\n'));
    assert.deepEqual(seen.map((m) => m.event), ['a', 'b', 'c'], '空行与非法 JSON 必须静默跳过');
    assert.equal(p._buf, '', '合法帧消费后缓冲区必须清空，不留残留');
    // 尾部残余无换行：留在缓冲区等下一帧
    p._onData(Buffer.from('{"event":"partial"'));
    assert.equal(p._buf, '{"event":"partial"}'.slice(0, 18));
});

test('_onEvent(): 错序应答按 request_id 各自匹配；error 拒绝、success 解析、未知 id 不误消费', async () => {
    const { p, ctx } = mkPlayer();
    const sock = makeSock();
    p.socket = sock;
    p._connected = true;
    const a = p.command('get_property', 'a');
    const b = p.command('get_property', 'b');
    const c = p.command('get_property', 'c');
    // 乱序应答：3 → 1 → 2
    p._onEvent({ request_id: 3, error: 'success', data: 'C' });
    p._onEvent({ request_id: 1, error: 'success', data: 'A' });
    p._onEvent({ request_id: 2, error: 'property unavailable' });
    assert.equal(await a, 'A');
    assert.equal(await c, 'C');
    await assert.rejects(() => b, /property unavailable/);
    assert.equal(p._pending.size, 0, '三条应答各清一个槽');
    assert.equal(ctx.timers.counts().timeouts, 0, '应答即清定时器（高频命令不累积）');
    // 未知 request_id：不是应答也不当事件，静默忽略且不抛
    p._onEvent({ request_id: 999, error: 'success', data: 'x' });
    // error === 'success' 视为成功
    const d = p.command('quit');
    p._onEvent({ request_id: 4, error: 'success', data: null });
    assert.equal(await d, null);
});

// ---------------------------------------------------------------- IPC：连接与属性观察

test('_connectIpc(): 连接就绪后按固定 id 观察 7 条属性（含两个 user-data 信号）', () => {
    const { p, ctx } = mkPlayer();
    const calls = [];
    p.command = (...args) => { calls.push(args); return Promise.resolve(); };
    p._probeContextMenuBinding = () => { };
    p._verifyA4kBindings = () => { };
    p._bringToFront = () => { };
    p.proc = makeProc();
    p._activeSession = { id: 77, nativeQueue: false };
    const emitted = [];
    p.on('ipc-connected', () => emitted.push(1));
    p._connectIpc(0, 77);
    assert.equal(ctx.netSockets.length, 1, '必须发起一次连接');
    ctx.netSockets[0].emit('connect');
    assert.equal(p._connected, true);
    assert.deepEqual(emitted, [1], '连接就绪须通知主进程推送会话级状态');
    const obs = calls.filter((c) => c[0] === 'observe_property');
    assert.deepEqual(obs.map((c) => [c[1], c[2]]), [
        [0x101, 'fullscreen'], [0x102, 'speed'], [0x103, 'time-pos'], [0x104, 'duration'],
        [0x105, 'pause'], [0x106, 'user-data/yuki/a4k-request'], [0x107, 'user-data/yuki/ep-skip'],
    ], '全屏/倍速/进度/时长/暂停与 Anime4K、上下集信号都必须观察（退出时直接用缓存）');
});

test('_connectIpc(): 连接失败按 100ms 重试；attempt>100 放弃；无进程/会话不匹配不连', () => {
    const { p, ctx } = mkPlayer();
    p.proc = makeProc();
    p._activeSession = { id: 88 };
    // 会话号不匹配：旧会话的重连不得接管新会话
    p._connectIpc(0, 999);
    assert.equal(ctx.netSockets.length, 0);
    // 无进程：不连
    p.proc = null;
    p._connectIpc(0, 88);
    assert.equal(ctx.netSockets.length, 0);
    // 正常连接后 error → 排 100ms 重试
    p.proc = makeProc();
    p._connectIpc(0, 88);
    assert.equal(ctx.netSockets.length, 1);
    ctx.netSockets[0].emit('error');
    assert.equal(ctx.timers.counts().timeouts, 1, '失败后须排一次重试');
    ctx.timers.fireTimeouts();
    assert.equal(ctx.netSockets.length, 2, '重试必须重新发起连接（首播冷启动管道未就绪）');
    // 超过 ~10s（100 次重试）仍连不上则放弃，避免无限重连（播放本身不受影响）
    const before = ctx.netSockets.length;
    p._connectIpc(101, 88);
    assert.equal(ctx.netSockets.length, before, 'attempt>100 直接放弃，不再建连接');
});

test('property-change: ep-skip/a4k-request 读后清零并 emit（仅 ±1 方向生效）', () => {
    const { p } = mkPlayer();
    const sets = [];
    const skips = [];
    const a4k = [];
    p.command = (...args) => { if (args[0] === 'set') sets.push(args); return Promise.resolve(); };
    p.on('ep-skip', (i) => skips.push(i.dir));
    p.on('a4k-request', (i) => a4k.push(i.mode));
    p._activeSession = { id: 5 };
    p._onEvent({ event: 'property-change', name: 'user-data/yuki/ep-skip', data: '-1' });
    p._onEvent({ event: 'property-change', name: 'user-data/yuki/ep-skip', data: '1' });
    p._onEvent({ event: 'property-change', name: 'user-data/yuki/ep-skip', data: '7' }); // 非法方向
    p._onEvent({ event: 'property-change', name: 'user-data/yuki/ep-skip', data: '' });  // 空串
    p._onEvent({ event: 'property-change', name: 'user-data/yuki/a4k-request', data: 'A4K_Restore' });
    assert.deepEqual(skips, [-1, 1], '仅 ±1 方向触发；其它值不得误跳转集数');
    assert.deepEqual(a4k, ['A4K_Restore']);
    assert.deepEqual(sets, [
        ['set', 'user-data/yuki/ep-skip', ''],
        ['set', 'user-data/yuki/ep-skip', ''],
        // data='7' 也清零（任何非空信号都要复位），但不 emit ep-skip；
        // data='' 为 falsy，整段跳过（不清零也不 emit）
        ['set', 'user-data/yuki/ep-skip', ''],
        ['set', 'user-data/yuki/a4k-request', ''],
    ], '信号读后立即清空，重复请求同一档位才能再次触发 observe');
});

test('property-change: pause 累计暂停时长，可多次暂停/恢复累加', () => {
    const { p } = mkPlayer();
    p._activeSession = { id: 6, paused: false, pausedMs: 0, pauseSince: 0 };
    p._onEvent({ event: 'property-change', name: 'pause', data: true });
    assert.equal(p._activeSession.paused, true);
    assert.ok(p._activeSession.pauseSince > 0, '记录暂停起点');
    const since = p._activeSession.pauseSince;
    p._onEvent({ event: 'property-change', name: 'pause', data: true }); // 重复上报不重复计时
    assert.equal(p._activeSession.pauseSince, since);
    p._onEvent({ event: 'property-change', name: 'pause', data: false });
    assert.equal(p._activeSession.paused, false);
    assert.equal(p._activeSession.pauseSince, 0);
    assert.ok(p._activeSession.pausedMs >= 0);
    // 二次暂停恢复后累加（不清零）
    const first = p._activeSession.pausedMs;
    p._onEvent({ event: 'property-change', name: 'pause', data: true });
    p._onEvent({ event: 'property-change', name: 'pause', data: false });
    assert.ok(p._activeSession.pausedMs >= first, '多段暂停须累加，供观看时长扣除');
});

// ---------------------------------------------------------------- 生命周期：spawn 异步错误

test('proc error(ENOENT/EACCES)：清空 binary、排延迟重探、teardown 并 emit spawn-error', () => {
    const { p, ctx } = mkPlayer();
    const proc = makeProc();
    ctx.spawnCalls.push({ bin: 'x', args: [], proc });
    p.proc = proc;
    p._activeSession = { id: 3, requestId: 'r', playSessionId: 's' };
    const errs = [];
    p.on('spawn-error', (i) => errs.push(i));
    const r = p.play([{ url: 'https://cdn.test/a.m3u8' }]);
    const spawned = ctx.spawnCalls[ctx.spawnCalls.length - 1].proc;
    spawned.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    assert.equal(r.ok, true, 'spawn 本身成功，失败是异步到达的');
    assert.equal(p.binary, null, '一次性 spawn 失败须标记不可用并广播 mpv-missing');
    assert.equal(p.proc, null, '失败后必须清理，不能留下空壳进程');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].code, 'ENOENT');
    assert.equal(errs[0].sessionId, 1);
    assert.ok(p._reprobeTimer, '必须排一次延迟重探（杀软占用/UAC 抖动是一次性的）');
});

test('proc error(非 ENOENT/EACCES)：不清空 binary（不得把无关错误误判成 mpv-missing）', () => {
    const { p, ctx } = mkPlayer();
    const orig = p.binary;
    const errs = [];
    p.on('spawn-error', (i) => errs.push(i));
    p.play([{ url: 'https://cdn.test/a.m3u8' }]);
    ctx.spawnCalls[ctx.spawnCalls.length - 1].proc
        .emit('error', Object.assign(new Error('unknown'), { code: 'EPIPE' }));
    assert.equal(p.binary, orig, '非文件级错误不得连带禁用播放器');
    assert.equal(p._reprobeTimer, undefined);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].code, 'EPIPE');
});

test('_scheduleBinaryReprobe(): 3s 后重探成功自愈并复位 externalStyle', () => {
    // 自动发现的「命中」分支依赖 vendor 里真实存在 mpv.exe，而 vendor/ 不入库——CI 全新
    // checkout 上该目录为空（早前消息里写「找回 vendor 里的 mpv」，在 CI 上是碰运气）。
    // 用 findMpvTarget 注入让 existsSync 只认 vendor 路径，重探命中在 CI 上稳定复现。
    const { p, ctx } = mkPlayer({ findMpvTarget: true });
    assert.ok(p.binary, '注入后构造期自动发现应命中 vendor 路径');
    const discovered = p.binary;
    p.binary = null;
    p.externalStyle = true; // 模拟曾被用户指定外部 mpv
    p._scheduleBinaryReprobe();
    assert.ok(p._reprobeTimer, '排一次重探');
    // 重排期间已被 setCustomPath/asset-status 恢复：重探不得覆盖
    p.binary = 'C:\\restored\\mpv.exe';
    ctx.timers.fireTimeouts((h) => h.ms === 3000);
    assert.equal(p.binary, 'C:\\restored\\mpv.exe', '期间已恢复则保持不动');
    assert.equal(p._reprobeTimer, null);
    // 仍未恢复：重探走 resetBinary（自动发现 + externalStyle 复位）
    p.binary = null;
    p._scheduleBinaryReprobe();
    ctx.timers.fireTimeouts((h) => h.ms === 3000);
    assert.equal(p.binary, discovered, '重探恢复自动发现结果');
    assert.equal(p.externalStyle, false, '回到自动发现语义，状态保持一致');
});

// ---------------------------------------------------------------- 生命周期：进程退出

test('exit: 退出信息字段完整映射（code/pos/duration/wallWatched/playlistPos/queueLen/stderr）', () => {
    const { p, ctx } = mkPlayer();
    const proc = makeProc();
    proc.stderr = { on() { } };
    ctx.spawnCalls.push({ bin: 'x', args: [], proc });
    const r = p.play([{ url: 'https://cdn.test/a.m3u8' }], { requestId: 'exit-1', playSessionId: 'sess-1' });
    const spawned = ctx.spawnCalls[ctx.spawnCalls.length - 1].proc;
    const session = p._activeSession;
    session.ready = true;
    session.pos = 42.5;
    session.duration = 120;
    session.queueIdx = 3;
    session.stderr = '  some mpv error  ';
    session.endReason = 'eof';
    let info = null;
    p.on('exit', (i) => { info = i; });
    spawned.emit('exit', 2);
    assert.equal(info.code, 2, '退出码原样透传（0 正常 / 非 0 异常）');
    assert.equal(info.sessionId, r.sessionId);
    assert.equal(info.requestId, 'exit-1', 'trace 字段随退出事件回传');
    assert.equal(info.playSessionId, 'sess-1');
    assert.equal(info.pos, 42.5);
    assert.equal(info.duration, 120);
    assert.equal(info.playlistPos, 3);
    assert.equal(info.queueLen, 1);
    assert.equal(info.wallWatched, 0, '墙钟时长（本次会话刚起播）');
    assert.equal(info.ready, true);
    assert.equal(info.nativeQueue, false);
    assert.equal(info.endReason, 'eof');
    assert.equal(info.stderr, 'some mpv error', 'stderr 需 trim');
    assert.equal(info.userStopped, false, 'eof 不是用户关闭');
    assert.equal(p.proc, null, '退出必须清理，playing 回到 false');
    assert.equal(p.playing, false);
});

test('exit: 未 ready 且无 stderr 时从 --log-file 提取可读原因（--no-terminal 吞掉了 stderr）', () => {
    const { p, ctx } = mkPlayer();
    const logPath = path.join(TMP, 'exit-log', 'mpv.log');
    p.logFilePath = logPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, [
        '[ 0.412][v][lavf] Opening',
        '[ 0.902][e][ffmpeg] http: HTTP error 404 Not Found',
        '[ 0.903][i][cplayer] Exiting... (Errors when loading file)',
        '[ 0.968][d][console] Destroying client handle...',
    ].join('\n'), 'utf8');
    p.play([{ url: 'https://cdn.test/dead.m3u8' }]);
    const spawned = ctx.spawnCalls[ctx.spawnCalls.length - 1].proc;
    let info = null;
    p.on('exit', (i) => { info = i; });
    spawned.emit('exit', 1);
    assert.match(info.stderr, /HTTP error 404/, '日志里的真实原因必须回填');
    assert.doesNotMatch(info.stderr, /Destroying client handle/, '收尾调试噪音不得当原因展示');
    // 已 ready 的会话不再回读日志（正常退出无需解释）
    const p2 = mkPlayer();
    p2.p.logFilePath = logPath;
    p2.p.play([{ url: 'https://cdn.test/a.m3u8' }]);
    p2.p._activeSession.ready = true;
    let info2 = null;
    p2.p.on('exit', (i) => { info2 = i; });
    p2.ctx.spawnCalls[p2.ctx.spawnCalls.length - 1].proc.emit('exit', 0);
    assert.equal(info2.stderr, null);
});

test('exit: 用户关窗（endReason=quit）标记 userStopped 并自增 controlGen（断流重连不接手）', () => {
    const { p, ctx } = mkPlayer();
    p.play([{ url: 'https://cdn.test/a.m3u8' }]);
    const spawned = ctx.spawnCalls[ctx.spawnCalls.length - 1].proc;
    p._activeSession.endReason = 'quit';
    const genBefore = p.controlGen;
    let info = null;
    p.on('exit', (i) => { info = i; });
    spawned.emit('exit', 0);
    assert.equal(info.userStopped, true);
    assert.equal(p.controlGen, genBefore + 1, '用户直接关窗与 stop() 同代际语义');
    // stop() 路径：userStopped 由 stop 置位，同样自增（已在 stop 内自增一次）
    const q = mkPlayer();
    q.p.play([{ url: 'https://cdn.test/a.m3u8' }]);
    const gen2 = q.p.controlGen;
    q.p.stop();
    assert.equal(q.p.controlGen, gen2 + 1);
});

// ---------------------------------------------------------------- 生命周期：停止与重启

test('stop(): 重复调用幂等（第二次无进程可杀也不抛异常），并清空 socket/proc/pending', async () => {
    const { p, ctx } = mkPlayer();
    const sock = makeSock();
    p.play([{ url: 'https://cdn.test/a.m3u8' }], { });
    const proc = ctx.spawnCalls[ctx.spawnCalls.length - 1].proc;
    p.socket = sock;
    p._connected = true;
    const pending = p.command('get_property', 'x');
    p.stop();
    assert.ok(proc.killed.length >= 1, '必须 kill 掉进程');
    assert.match(ctx.execCalls.join('|'), /taskkill/, 'Windows 上追加 taskkill 杀整棵进程树');
    assert.equal(p.proc, null);
    assert.equal(p.socket, null);
    assert.equal(p._connected, false);
    assert.equal(p._activeSession, null);
    await assert.rejects(() => pending, /mpv stopped/, 'teardown 必须让在途命令落地，不留悬挂 Promise');
    assert.equal(ctx.timers.counts().timeouts, 0, 'teardown 同步清理所有 IPC 超时定时器');
    // 二次 stop：幂等
    p.stop();
    assert.equal(p.proc, null);
    assert.equal(ctx.timers.counts().timeouts, 0);
});

test('_teardown(): sessionId 为 null 时无条件清理（不清空则下次起播会连到旧 socket）', () => {
    const { p } = mkPlayer();
    const sock = makeSock();
    p.socket = sock;
    p.proc = makeProc();
    p._connected = true;
    p._activeSession = { id: 9 };
    p._frontTimer = { id: 0 };
    p._frontTries = 3;
    p._teardown(null);
    assert.equal(p.socket, null);
    assert.equal(p.proc, null);
    assert.equal(p._activeSession, null);
    assert.equal(p._connected, false);
    assert.equal(p._frontTimer, null, '前台抢焦定时器必须一并清理');
    assert.equal(p._frontTries, 0);
});

test('_removeAssFile(): 会话号不匹配时保护新会话弹幕文件（快速 stop→play 不误删）', () => {
    const { p } = mkPlayer();
    p.assPath = path.join(TMP, 'danmaku-guard.ass');
    fs.writeFileSync(p.assPath, 'placeholder', 'utf8');
    p._activeSession = { id: 11 };
    p._removeAssFile(10); // 旧会话退出：新会话已装载，不得删
    assert.equal(fs.existsSync(p.assPath), true);
    p._removeAssFile(11); // 本会话退出：删（unlink 异步，仅断言调用未抛）
    assert.doesNotThrow(() => p._removeAssFile(11), '删除不存在/被占用的文件必须静默');
    p._activeSession = null;
    p._removeAssFile();
    try { fs.rmSync(p.assPath, { force: true }); } catch (e) { /* ignore */ }
});

test('重启：play() 先 stop 旧进程并自增 sessionId；旧进程延迟 exit 不清掉新会话', () => {
    const { p, ctx } = mkPlayer();
    const first = p.play([{ url: 'https://cdn.test/1.m3u8' }]);
    const firstProc = ctx.spawnCalls[ctx.spawnCalls.length - 1].proc;
    const firstSession = p._activeSession;
    const second = p.play([{ url: 'https://cdn.test/2.m3u8' }]);
    const secondProc = ctx.spawnCalls[ctx.spawnCalls.length - 1].proc;
    assert.ok(firstProc.killed.length >= 1, '起播前必须先停旧进程');
    assert.equal(second.sessionId, first.sessionId + 1, '会话号自增');
    assert.equal(p._activeSession.id, second.sessionId);
    // 旧 mpv 延迟退出：不得清掉刚起播的新会话
    firstProc.emit('exit', 0);
    assert.equal(p.proc, secondProc, '旧进程 exit 后新会话必须仍在');
    assert.equal(p._activeSession.id, second.sessionId);
    assert.equal(firstSession.userStopped, true, '被 stop 的会话不得触发断流重连');
});

// ---------------------------------------------------------------- 控制命令参数正确性

test('控制命令：setPause/seek/setVolume(夹取 0~200)/setSpeed(clamp)/getProperty 参数正确', () => {
    const { p } = mkPlayer();
    const calls = [];
    p.socket = makeSock();
    p._connected = true;
    p.command = (...args) => { calls.push(args); return Promise.resolve(); };
    p.setPause(true);
    p.setPause(0);
    p.seek(15);
    p.setVolume(300);
    p.setVolume(-5);
    p.setVolume(80);
    p.setSpeed(9);
    p.setSpeed(0);
    p.getProperty('duration');
    assert.deepEqual(calls, [
        ['set_property', 'pause', true],
        ['set_property', 'pause', false],   // 真值归一
        ['seek', 15, 'relative'],           // 相对 seek（绝对定位走 pendingSeekSec）
        ['set_property', 'volume', 200],    // 上限夹取
        ['set_property', 'volume', 0],      // 下限夹取
        ['set_property', 'volume', 80],
        ['set_property', 'speed', 4],       // clampSpeed 上限
        ['set_property', 'speed', 1],       // 非正值回落 1
        ['get_property', 'duration'],
    ]);
});

test('screenshot(): 路径反斜杠转正斜杠、目录兜底创建、subtitles 模式（所见即所得）', () => {
    const { p } = mkPlayer();
    const calls = [];
    p.command = (...args) => { calls.push(args); return Promise.resolve(); };
    const file = path.join(TMP, '截图 目录', '中文 名称.png');
    p.screenshot(file);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'screenshot-to-file');
    assert.equal(calls[0][1], file.replace(/\\/g, '/'),
        'Windows 反斜杠在 mpv JSON IPC 解析中被当转义 → 落盘失败');
    assert.equal(calls[0][2], 'subtitles');
    assert.ok(fs.existsSync(path.dirname(file)), '目录不存在时兜底创建');
});
