/**
 * mpv-player.js — mpv 独立窗口播放器（Phase 4）
 *
 * 职责：
 * - 解析 mpv 二进制：<repo>/vendor/mpv/ → PATH
 * - spawn mpv（--input-ipc-server 命名管道），JSON IPC 收发
 * - ASS 弹幕：把 `[time,mode,size,color]text` 弹幕行写入 .ass 文件，
 *   追加后 sub-reload 热更新（对齐 CatVod 原生 ASS 弹幕方案）
 * - 事件：'ended'（单集播完，供连播）/ 'exit'（进程退出）
 *
 * mpv 缺失时 isAvailable()=false，由渲染层走 HTML5 降级。
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, exec, execSync, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { bringToFront } = require('./win-focus');

// 打包后 extraResources 放在 resources/，vendor 从该处读取
const ROOT = (() => {
    try {
        const { app } = require('electron');
        return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
    } catch (e) { return path.join(__dirname, '..', '..'); }
})();
const WIN = process.platform === 'win32';

/** 校验 mpv 二进制真实可用：spawnSync --version（规避损坏/占位 exe），返回版本首行或 null。 */
function mpvVersion(p) {
    try {
        const r = spawnSync(p, ['--version'], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (r.error || r.status !== 0) return null;
        const line = String(r.stdout || '').split(/\r?\n/)[0].trim();
        return line || null;
    } catch (e) { return null; }
}

function findMpv() {
    const exe = WIN ? 'mpv.exe' : 'mpv';
    const candidates = [];
    const vendor = path.join(ROOT, 'vendor', 'mpv', exe);
    if (fs.existsSync(vendor)) candidates.push(vendor);
    try {
        if (WIN) {
            const out = execSync('where mpv', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            for (const p of out.split(/\r?\n/)) if (p) candidates.push(p);
        } else {
            const out = execSync(`command -v ${exe}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            if (out) candidates.push(out);
        }
    } catch (e) { /* 不在 PATH */ }
    const seen = new Set();
    for (const p of candidates) {
        if (seen.has(p)) continue;
        seen.add(p);
        const v = mpvVersion(p);
        if (v) { // 能打印版本才算可用；损坏二进制回退下一候选
            console.log(`[mpv] 使用 ${v}（${p}）`);
            return p;
        }
    }
    return null;
}

class MpvPlayer extends EventEmitter {
    constructor() {
        super();
        this.binary = findMpv();
        this.proc = null;
        this.socket = null;
        // IPC 命名管道：pid + 最近一次播放时间戳，杜绝「管道已存在（残留 mpv 仍占用）→
        // IPC 连接失败 → 首次起播无窗口/无控制」的偶发 bug（二次点击因残留退出才成功）。
        this.ipcPath = WIN
            ? `\\\\.\\pipe\\vpc-mpv-${process.pid}-${Date.now()}`
            : path.join(os.tmpdir(), `vpc-mpv-${process.pid}-${Date.now()}.sock`);
        this.assPath = path.join(os.tmpdir(), `vpc-danmaku-${process.pid}.ass`);
        this._reqId = 0;
        this._buf = '';
        this._connected = false;
        this._pending = new Map();
        this._danmakuLines = [];
        this._laneCounter = 0;
        this.scriptPath = null;   // 可选 lua 脚本（主进程写入的快捷键提示，见 index.js）
        this.inputConfPath = null; // 可选 input.conf（自定义快捷键步长，见 index.js）
        this.watchLaterDir = null; // 续播位置记录目录（--save-position-on-quit）
        this.defaultSpeed = 1;     // 默认倍速（≠1 时起播注入 --speed）
        this.audioLang = '';       // 音轨语言偏好（非空时注入 --alang）
        this.subLang = '';         // 字幕语言偏好（非空时注入 --slang）
        this.anime4kShaders = '';  // Anime4K 着色器链（分号分隔路径；非空时注入 --glsl-shaders）
        this.cacheMode = 'memory'; // 视频缓冲位置：'memory' 内存（mpv 默认）| 'disk' 硬盘（--cache-on-disk）
        this.cacheDir = '';        // 硬盘缓存目录（cacheMode==='disk' 且非空时注入 --demuxer-cache-dir）
        this.screenshotDir = '';   // 截图保存目录（非空时注入 --screenshot-directory，mpv 原生 s 键也存这里）
        this._queueLen = 0;        // 当前播放队列长度（ended 事件附带，供渲染层判定队列末尾）
        this._sessionId = 0;       // 起播会话号（每次 play 自增；exit 事件附带，供渲染层匹配新旧进程）
        this._lastFs = false;      // 播放期间全屏状态（实时追踪，exit 时无需查询）
        this._lastSp = 1;          // 播放期间倍速（实时追踪，exit 时无需查询）
        this._activeSession = null; // {id, proc, pos, duration, fullscreen, speed}，退出时使用缓存
        this._frontTimer = null;   // 前台抢焦重试定时器（Windows foreground lock 兜底）
        this._frontTries = 0;
    }

    isAvailable() { return !!this.binary; }

    /** 指定自定义 mpv 二进制路径（设置页手动选择）；文件存在且能打印版本则更新，下次起播生效。 */
    setCustomPath(p) {
        const v = (p && fs.existsSync(p)) ? mpvVersion(p) : null;
        if (v) {
            console.log(`[mpv] 自定义路径生效：${v}（${p}）`);
            this.binary = p;
            return true;
        }
        return false;
    }

    /** 重置为自动发现（内置 vendor → PATH），清除自定义路径。 */
    resetBinary() { this.binary = findMpv(); }

    get playing() { return !!this.proc; }

    // ------------------------------------------------------------ 生命周期

    /** 播放首项并装载播放列表。episodes: [{url, title}]；opts.header 注入 HTTP 头（解析直链常需 Referer） */
    play(episodes, opts = {}) {
        this.stop();
        if (!this.binary) return { ok: false, reason: 'mpv-missing' };
        // 起播前二次校验二进制真实存在：findMpv() 发现后文件被删（如安装时取消内置播放器、
        // 或卸载补装目录被清）会让 spawn 抛异步 ENOENT。此处提前拦截，返回可用错误而非崩溃。
        if (!fs.existsSync(this.binary)) {
            console.warn(`[mpv] 二进制已不存在，标记为不可用：${this.binary}`);
            this.binary = null;
            return { ok: false, reason: 'mpv-missing' };
        }
        if (!episodes || !episodes.length) return { ok: false, reason: 'empty playlist' };
        this._danmakuLines = [];
        this._writeAss();

        const args = [
            '--idle=no', '--no-terminal',
            // 起播即抢焦点：请求 mpv 打开窗口时获得前台焦点。
            // 注：Windows 前台锁（foreground lock）下后台进程 spawn 的窗口常被系统
            // 压制在后台，单靠此选项不可靠，另见下方 _bringToFront 的 AppActivate 兜底。
            // 注意 v0.41 起 --focus-on-open 已移除，改用 --focus-on（open=新窗口时获得焦点）。
            '--focus-on=open',
            `--input-ipc-server=${this.ipcPath}`,
            // 窗口始终置顶（win32 gdi 后端）：从根源上杜绝 mpv 窗口落在主窗口背后，
            // 与 _bringToFront 的激活兜底互补（前置只是改 z 序，不一定抢到输入焦点）。
            '--ontop',
            '--sub-auto=no', '--sub-visibility=yes',
            `--osd-playing-msg=${opts.title || 'YuKi'}`,
            // 中文化（T8）：窗口标题模板 + OSD 中文字体（Windows 微软雅黑；其他平台走 mpv 默认字体回退）。
            // 注意 ${media-title} 是 mpv 属性展开，必须用普通字符串避免被 JS 模板插值。
            '--title=video-pc · ${media-title}',
        ];
        if (WIN) args.push('--osd-font=Microsoft YaHei');
        if (opts.header && typeof opts.header === 'object') {
            const pairs = Object.entries(opts.header)
                .filter(([, v]) => v != null && v !== '')
                .map(([k, v]) => `${k}: ${v}`).join(', ');
            if (pairs) args.push(`--http-header-fields=${pairs}`);
        }
        // 自定义 lua 提示脚本/input.conf（主进程写入 userData/mpv-scripts，见 index.js writeMpvAssets）：
        // 用 --scripts-append 追加而非 --scripts 覆盖，避免替换 mpv 默认 scripts 目录的加载
        if (this.scriptPath && fs.existsSync(this.scriptPath)) args.push(`--scripts-append=${this.scriptPath}`);
        if (this.inputConfPath && fs.existsSync(this.inputConfPath)) args.push(`--input-conf=${this.inputConfPath}`);
        // 续播：退出时记录位置，同一地址再次起播自动跳转（mpv 按 URL 哈希匹配）；
        // 直播地址（opts.resume===false）不记录，避免下次误跳旧位置
        if (this.watchLaterDir && opts.resume !== false) {
            try { fs.mkdirSync(this.watchLaterDir, { recursive: true }); } catch (e) { /* ignore */ }
            args.push('--save-position-on-quit', `--watch-later-directory=${this.watchLaterDir}`);
        }
        // 倍速：优先使用连播延续的当前速度，其次用设置的默认倍速
        const speed = (opts.speed && opts.speed > 0) ? opts.speed : this.defaultSpeed;
        if (speed && speed !== 1) args.push(`--speed=${speed}`);
        // 全屏：连播延续上一集的全屏状态
        if (opts.fullscreen) args.push('--fs');
        // 语言偏好：多音轨/内嵌字幕时按设定语言优先选择（设置页可调）
        if (this.audioLang) args.push(`--alang=${this.audioLang}`);
        if (this.subLang) args.push(`--slang=${this.subLang}`);
        // Anime4K 实时超分（动漫向）：着色器链完整存在才注入，缺文件静默跳过
        if (this.anime4kShaders) args.push(`--glsl-shaders=${this.anime4kShaders}`);
        // 视频缓冲落盘（设置页可切内存/硬盘）：缓存模式写进磁盘而非内存，
        // 目录不存在则创建（mpv 也会自建，提前建好便于「清空硬盘缓存」定位）。
        // 注意 mpv v0.41 的目录选项是 --demuxer-cache-dir（--cache-dir 不是合法选项）。
        if (this.cacheMode === 'disk' && this.cacheDir) {
            try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch (e) { /* 目录不可写时 mpv 自会报错，不阻断 */ }
            args.push('--cache=yes', '--cache-on-disk=yes', `--demuxer-cache-dir=${this.cacheDir}`);
        }
        // 截图目录：mpv 原生 s 键（screenshot 命令）与 IPC 截图都存到这里
        if (this.screenshotDir) {
            try { fs.mkdirSync(this.screenshotDir, { recursive: true }); } catch (e) { /* ignore */ }
            args.push(`--screenshot-directory=${this.screenshotDir}`, '--screenshot-template=video-pc-%w-%03n');
        }
        args.push('--', episodes[0].url);
        for (let i = 1; i < episodes.length; i++) args.push(episodes[i].url);
        this._queueLen = episodes.length;
        this._lastFs = !!opts.fullscreen;
        this._lastSp = (speed && speed > 0) ? speed : 1;
        const sessionId = ++this._sessionId; // 闭包捕获：进程退出时附带，区分新旧会话
        const proc = spawn(this.binary, args, { stdio: 'ignore' });
        // 起播即带入前台：前置(ontop)保证不被主窗遮住，激活兜底尽可能抢到输入焦点。
        // （务必在 proc 赋值后调用；fire-and-forget，不阻塞起播。）
        this._frontTimer = null;
        this._frontTries = 0;
        this._bringToFront(proc.pid);
        const session = {
            id: sessionId,
            proc,
            pos: null,
            duration: null,
            fullscreen: this._lastFs,
            speed: this._lastSp,
            endReason: null,    // 最近一次 end-file reason（eof/quit/stop/error…），用于区分断流与用户关闭
            userStopped: false, // 应用主动 stop() 置位：退出时不得断流重连
            // 观看时长统计（墙钟）：累计播放器运行时长（打开播放器后运行了多久，含暂停）。
            playStartMs: Date.now(),
            pausedMs: 0,        // 累计暂停时长（毫秒）
            paused: false,
            pauseSince: 0,
        };
        this.proc = proc;
        this._activeSession = session;
        // spawn 异步错误兜底：文件在 existsSync 之后被删/损坏/无执行权限时，Node 会异步
        // 触发 'error'（ENOENT/EACCES）而非抛同步异常；不监听则进程崩溃。捕获后清理并
        // 广播 mpv-missing，让渲染层给出友好提示而非静默失败。
        proc.on('error', (err) => {
            console.error(`[mpv] 启动失败（${err && err.code || 'unknown'}）：${err && err.message}`);
            if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) this.binary = null;
            this._teardown(sessionId);
            this.emit('spawn-error', { sessionId, code: err && err.code, message: err && err.message });
        });
        proc.on('exit', (code) => {
            // ChildProcess 的 exit 触发时 mpv IPC 通常已经断开；直接使用播放期间持续观察的缓存。
            // 观看时长（墙钟）：从起播到退出的总运行时长（打开播放器后运行了多久），暂停期间也算。
            const wallWatched = Math.max(0, Math.round((Date.now() - session.playStartMs) / 1000));
            const info = {
                code,
                sessionId,
                pos: typeof session.pos === 'number' ? session.pos : null,
                duration: typeof session.duration === 'number' ? session.duration : null,
                wallWatched,   // 播放器运行时长（墙钟，含暂停）：观看统计以此累计
                fullscreen: session.fullscreen,
                speed: session.speed,
                endReason: session.endReason || null,
                // 用户主动关闭：应用 stop() 标记，或 mpv 自己 end-file reason=quit/stop（点窗口关闭键）
                userStopped: session.userStopped || session.endReason === 'quit' || session.endReason === 'stop',
            };
            // 只清理该会话；旧进程延迟退出时不能误清掉刚起播的新会话。
            this._teardown(sessionId);
            this.emit('exit', info);
        });
        this._connectIpc(0, sessionId);
        return { ok: true, sessionId };
    }

    stop() {
        const sessionId = this._activeSession ? this._activeSession.id : null;
        const proc = this.proc;
        if (proc) {
            // 应用主动停止：标记该会话退出时不得断流重连（否则 kill 后 exit 会误触发自动重连）
            if (this._activeSession) this._activeSession.userStopped = true;
            try { proc.kill(); } catch (e) { /* ignore */ }
            // Windows：proc.kill() 仅 TerminateProcess 单进程，mpv 可能带子进程或未及时退出，
            // 追加 taskkill 杀整棵进程树确保残留被清；非 Windows 用 SIGKILL 兜底。
            try {
                if (WIN) {
                    exec(`taskkill /pid ${proc.pid} /T /F`, () => { /* 进程可能已退出，忽略 */ });
                } else {
                    proc.kill('SIGKILL');
                }
            } catch (e2) { /* 强杀失败不阻断后续 teardown */ }
        }
        this._teardown(sessionId);
    }

    _teardown(sessionId = null) {
        if (sessionId != null && this._activeSession && this._activeSession.id !== sessionId) return;
        if (this._frontTimer) { clearTimeout(this._frontTimer); this._frontTimer = null; }
        this._frontTries = 0;
        this._connected = false;
        if (this.socket) { try { this.socket.destroy(); } catch (e) { /* ignore */ } this.socket = null; }
        this.proc = null;
        this._activeSession = null;
        for (const [, p] of this._pending) p.reject(new Error('mpv stopped'));
        this._pending.clear();
    }

    /**
     * 起播后把 mpv 窗口带到前台。
     *
     * 背景：Electron 应用（尤其无边框/自绘标题栏模式）点击「播放」时自身已持有前台焦点，
     * Windows 前台锁（foreground lock）会拒绝后台进程激活窗口——mpv 窗口因此常静默落在
     * 主窗口背后（「播放器不出现在前台」）。--focus-on-open 只是请求，不可靠。
     * 方案双重保证：起播参数注入 --ontop（z 序置顶，从根源上不被主窗遮住）+
     * 这里从 Electron 主进程侧兜底（spawn PowerShell 辅助进程周期性尝试激活 mpv
     * 顶层窗口：Win32 AttachThreadInput + SetForegroundWindow，前台锁只允许持有
     * 前台线程的关联线程成功激活），mpv 窗口真正出现在前台后辅助进程自行退出。
     *
     * @param {number} [pid] 目标进程 PID（缺省取当前会话 proc.pid）
     */
    _bringToFront(pid) {
        // 真实实现见 win-focus.js（spawn PowerShell 辅助进程 + Win32 P/Invoke），
        // 这里仅作调用入口；辅助进程自检窗口在前台或超时后自行退出。
        bringToFront(pid || (this.proc && this.proc.pid) || 0);
    }

    // ------------------------------------------------------------ IPC

    _connectIpc(attempt = 0, sessionId = null) {
        const active = this._activeSession;
        if (!this.proc || !active || (sessionId != null && active.id !== sessionId)) return;
        if (attempt > 50) return; // ~5s 仍连不上则放弃（播放本身不受影响，仅失去控制/事件）
        const sock = net.connect(this.ipcPath);
        sock.once('connect', () => {
            if (!this._activeSession || this._activeSession.id !== active.id) {
                try { sock.destroy(); } catch (e) { /* ignore */ }
                return;
            }
            this.socket = sock;
            this._connected = true;
            sock.on('data', (chunk) => this._onData(chunk));
            sock.on('error', () => { /* 进程退出时管道断开 */ });
            // 装载 ASS 弹幕轨
            this.command('sub-add', this.assPath, 'select', '彈幕').catch(() => { });
            // 追踪全屏/倍速状态（退出时无需再查询，避免窗口已关闭拿到错误值）
            this.command('observe_property', 0x101, 'fullscreen').catch(() => { });
            this.command('observe_property', 0x102, 'speed').catch(() => { });
            this.command('observe_property', 0x103, 'time-pos').catch(() => { });
            this.command('observe_property', 0x104, 'duration').catch(() => { });
            this.command('observe_property', 0x105, 'pause').catch(() => { });
        });
        sock.once('error', () => {
            setTimeout(() => this._connectIpc(attempt + 1, active.id), 100);
        });
    }

    _onData(chunk) {
        this._buf += chunk.toString('utf8');
        let idx;
        while ((idx = this._buf.indexOf('\n')) >= 0) {
            const line = this._buf.slice(0, idx).trim();
            this._buf = this._buf.slice(idx + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch (e) { continue; }
            this._onEvent(msg);
        }
    }

    _onEvent(msg) {
        if (msg.request_id && this._pending.has(msg.request_id)) {
            const p = this._pending.get(msg.request_id);
            this._pending.delete(msg.request_id);
            if (msg.error && msg.error !== 'success') p.reject(new Error(msg.error));
            else p.resolve(msg.data);
            return;
        }
        if (msg.event === 'property-change') {
            const active = this._activeSession;
            if (msg.name === 'fullscreen') {
                this._lastFs = !!msg.data;
                if (active) active.fullscreen = this._lastFs;
            }
            if (msg.name === 'speed' && typeof msg.data === 'number') {
                this._lastSp = msg.data;
                if (active) active.speed = msg.data;
            }
            if (msg.name === 'time-pos' && typeof msg.data === 'number' && msg.data >= 0 && active) {
                active.pos = msg.data;
            }
            if (msg.name === 'duration' && typeof msg.data === 'number' && msg.data > 0 && active) {
                active.duration = msg.data;
            }
            // 暂停态计入观看时长扣除：暂停期间不算真实观看
            if (msg.name === 'pause' && active) {
                const p = !!msg.data;
                if (p && !active.paused) { active.paused = true; active.pauseSince = Date.now(); }
                else if (!p && active.paused) {
                    active.paused = false;
                    if (active.pauseSince) { active.pausedMs += Date.now() - active.pauseSince; active.pauseSince = 0; }
                }
            }
            return;
        }
        if (msg.event === 'end-file') {
            const active = this._activeSession;
            // 记录退出原因：eof=播完/断流；quit/stop=用户关闭；error=出错
            if (active) active.endReason = msg.reason;
            if (msg.reason === 'eof') {
                if (active && typeof active.duration === 'number') active.pos = active.duration;
                const playlistPos = (typeof msg.playlist_pos === 'number') ? msg.playlist_pos : -1;
                // 附带队列长度：渲染层据此区分「mpv 队列自动推进」与「队列末尾播完」（接力连播用）
                this.emit('ended', { sessionId: active ? active.id : null, playlistPos, queueLen: this._queueLen });
            }
        }
    }

    command(...args) {
        return new Promise((resolve, reject) => {
            if (!this._connected || !this.socket) return reject(new Error('mpv ipc not connected'));
            const id = ++this._reqId;
            this._pending.set(id, { resolve, reject });
            this.socket.write(JSON.stringify({ command: args, request_id: id }) + '\n');
            setTimeout(() => {
                if (this._pending.has(id)) {
                    this._pending.delete(id);
                    reject(new Error('mpv ipc timeout'));
                }
            }, 5000);
        });
    }

    setPause(v) { return this.command('set_property', 'pause', !!v); }
    seek(sec) { return this.command('seek', sec, 'relative'); }
    setVolume(v) { return this.command('set_property', 'volume', Math.max(0, Math.min(200, v))); }
    setSpeed(v) { return this.command('set_property', 'speed', Math.max(0.25, Math.min(4, v))); }
    getProperty(name) { return this.command('get_property', name); }

    /**
     * 截图：把当前视频帧存为 PNG（subtitles 模式含字幕/OSD，所见即所得）。
     * filePath 必须以 .png 结尾（mpv 按扩展名推断格式）。
     */
    screenshot(filePath) {
        return this.command('screenshot-to-file', filePath, 'subtitles');
    }

    // ------------------------------------------------------------ ASS 弹幕

    /** 追加弹幕；line 文本形如 "[time,mode,size,color]content"（CatVod 面板协议）。 */
    addDanmaku(lineText, atSec) {
        const d = MpvPlayer.parseDanmaku(lineText);
        if (!d) return;
        if (typeof atSec !== 'number' || !isFinite(atSec)) atSec = this._danmakuLines.length * 1.2;
        this._danmakuLines.push(this._assDialogue(d, atSec));
        this._writeAss();
        if (this._connected) this.command('sub-reload').catch(() => { });
    }

    /**
     * 批量装载整集弹幕（方案 A：起播后一次性预生成完整 ASS）。
     * comments 为弹弹 play /comment 返回的数组，元素形如 { p:"时间,模式,颜色,uid", m:"文本" }：
     *   - 时间：绝对秒（浮点），直接作为弹幕出现时刻（非 addDanmaku 的相对累加）；
     *   - 模式：弹弹 play 1/2/3/6→滚动，4→底部，5→顶部；
     *   - 颜色：十进制 0xRRGGBB。
     * 全部转成 ASS Dialogue 行后写盘，已连接则 sub-reload 生效。返回装载条数。
     */
    loadDanmakuBatch(comments) {
        if (!Array.isArray(comments) || !comments.length) return 0;
        this._danmakuLines = [];
        this._laneCounter = 0;
        // 按时间排序，弹道分配更稳定
        const parsed = [];
        for (const c of comments) {
            const d = MpvPlayer._parseDandan(c);
            if (d) parsed.push(d);
        }
        parsed.sort((a, b) => a.time - b.time);
        for (const d of parsed) {
            this._danmakuLines.push(this._assDialogue(d, 0)); // atSec=0：d.time 即绝对时刻
        }
        this._writeAss();
        if (this._connected) this.command('sub-reload').catch(() => { });
        return this._danmakuLines.length;
    }

    /** 弹弹 play comment → 内部弹幕对象 {time,mode,size,color,content}。非法项返回 null。 */
    static _parseDandan(c) {
        if (!c || typeof c !== 'object') return null;
        const content = String(c.m || '').trim();
        if (!content) return null;
        const parts = String(c.p || '').split(',');
        const time = parseFloat(parts[0]) || 0;
        const rawMode = parseInt(parts[1], 10) || 1;
        // 弹弹 play：1/2/3 滚动，4 底部，5 顶部，6 反向（少见）→ 归一到内部协议
        const mode = (rawMode === 4) ? 4 : (rawMode === 5) ? 5 : (rawMode === 6) ? 6 : 1;
        const color = parseInt(parts[2], 10);
        return { time, mode, size: 25, color: isNaN(color) ? 0xFFFFFF : color, content };
    }

    /** 解析 [time,mode,size,color]text；time 缺省 0。mode: 1滚动 4底部 5顶部 6反向滚动 */
    static parseDanmaku(text) {
        const m = String(text).match(/^\[([^\]]*)\]([\s\S]*)$/);
        if (!m) return null;
        const parts = m[1].split(',').map((s) => s.trim());
        const content = m[2].trim();
        if (!content) return null;
        const time = parseFloat(parts[0]) || 0;
        const mode = parseInt(parts[1], 10) || 1;
        const size = parseInt(parts[2], 10) || 25;
        const color = parseInt(parts[3], 10);
        return { time, mode, size, color: isNaN(color) ? 0xFFFFFF : color, content };
    }

    /** ASS 颜色为 &HAABBGGRR（十进制 color 为 0xRRGGBB）。 */
    static _assColor(rgb) {
        const r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
        const hex = (v) => v.toString(16).toUpperCase().padStart(2, '0');
        return `&H00${hex(b)}${hex(g)}${hex(r)}`;
    }

    _assDialogue(d, atSec) {
        const start = MpvPlayer._ts(atSec + d.time);
        const end = MpvPlayer._ts(atSec + d.time + (d.mode === 1 || d.mode === 6 ? 8 : 4));
        const lane = (this._laneCounter++ % 12) + 1;
        const y = lane * (d.size + 6);
        let pos;
        if (d.mode === 5) pos = `{\\an8\\pos(640,${y})}`;                 // 顶部固定
        else if (d.mode === 4) pos = `{\\an2\\pos(640,${720 - y})}`;      // 底部固定
        else {
            const rev = d.mode === 6;                                     // 反向：右→左 改 左→右
            const from = rev ? -200 : 1400, to = rev ? 1400 : -200;
            pos = `{\\an7\\move(${from},${y},${to},${y})}`;
        }
        const color = d.color === 0xFFFFFF ? '' : `{\\c${MpvPlayer._assColor(d.color)}}`;
        const text = d.content.replace(/\r?\n/g, '\\N');
        return `Dialogue: 0,${start},${end},Default,,0,0,0,,${pos}${color}${text}`;
    }

    static _ts(sec) {
        sec = Math.max(0, sec);
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60), cs = Math.floor((sec % 1) * 100);
        const p = (v) => String(v).padStart(2, '0');
        return `${p(h)}:${p(m)}:${p(s)}.${p(cs)}`;
    }

    _writeAss() {
        const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,25,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1.5,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
        const body = this._danmakuLines.join('\n');
        fs.writeFileSync(this.assPath, '\uFEFF' + header + body + '\n', 'utf8');
    }
}

module.exports = MpvPlayer;
