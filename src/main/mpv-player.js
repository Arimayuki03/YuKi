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
const { spawn, execSync, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

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
        this.ipcPath = WIN
            ? `\\\\.\\pipe\\vpc-mpv-${process.pid}`
            : path.join(os.tmpdir(), `vpc-mpv-${process.pid}.sock`);
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
        this._queueLen = 0;        // 当前播放队列长度（ended 事件附带，供渲染层判定队列末尾）
        this._sessionId = 0;       // 起播会话号（每次 play 自增；exit 事件附带，供渲染层匹配新旧进程）
        this._lastFs = false;      // 播放期间全屏状态（实时追踪，exit 时无需查询）
        this._lastSp = 1;          // 播放期间倍速（实时追踪，exit 时无需查询）
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
        if (!this.binary) return { ok: false, reason: 'mpv not found' };
        if (!episodes || !episodes.length) return { ok: false, reason: 'empty playlist' };
        this._danmakuLines = [];
        this._writeAss();

        const args = [
            '--idle=no', '--no-terminal',
            `--input-ipc-server=${this.ipcPath}`,
            '--sub-auto=no', '--sub-visibility=yes',
            `--osd-playing-msg=${opts.title || '影视 PC'}`,
        ];
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
        args.push('--', episodes[0].url);
        for (let i = 1; i < episodes.length; i++) args.push(episodes[i].url);
        this._queueLen = episodes.length;
        this._lastFs = false;
        this._lastSp = 1;
        const sessionId = ++this._sessionId; // 闭包捕获：进程退出时附带，区分新旧会话
        this.proc = spawn(this.binary, args, { stdio: 'ignore' });
        this.proc.on('exit', (code) => {
            // 进程退出前抢救播放进度/时长（IPC 未拆除）：供主进程区分
            // 「播完正常退出」与「未到结尾就断流/EOF」（提前退出自动重连续播）
            const info = { code, sessionId };
            const done = () => { this._teardown(); this.emit('exit', info); };
            const grab = async () => {
                // 全屏/倍速已在播放期间通过 observe_property 实时追踪，直接使用缓存；
                // 仅补充 time-pos / duration（IPC 断开前抢救一次）
                info.fullscreen = this._lastFs;
                info.speed = this._lastSp;
                try {
                    // 400ms 内拿不到就放弃（管道已断时 command 会拖到 5s 超时，不能阻塞退出事件）
                    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('grab timeout')), 400));
                    const [pos, dur] = await Promise.race([
                        Promise.all([this.getProperty('time-pos'), this.getProperty('duration')]),
                        timeout,
                    ]);
                    info.pos = typeof pos === 'number' ? pos : null;
                    info.duration = typeof dur === 'number' ? dur : null;
                } catch (e) { /* IPC 已断/超时：不附带进度 */ }
            };
            grab().finally(() => setTimeout(done, 0));
        });
        this._connectIpc();
        return { ok: true, sessionId };
    }

    stop() {
        if (this.proc) {
            try { this.proc.kill(); } catch (e) { /* ignore */ }
        }
        this._teardown();
    }

    _teardown() {
        this._connected = false;
        if (this.socket) { try { this.socket.destroy(); } catch (e) { /* ignore */ } this.socket = null; }
        this.proc = null;
        for (const [, p] of this._pending) p.reject(new Error('mpv stopped'));
        this._pending.clear();
    }

    // ------------------------------------------------------------ IPC

    _connectIpc(attempt = 0) {
        if (!this.proc) return;
        if (attempt > 50) return; // ~5s 仍连不上则放弃（播放本身不受影响，仅失去控制/事件）
        const sock = net.connect(this.ipcPath);
        sock.once('connect', () => {
            this.socket = sock;
            this._connected = true;
            sock.on('data', (chunk) => this._onData(chunk));
            sock.on('error', () => { /* 进程退出时管道断开 */ });
            // 装载 ASS 弹幕轨
            this.command('sub-add', this.assPath, 'select', '彈幕').catch(() => { });
            // 追踪全屏/倍速状态（退出时无需再查询，避免窗口已关闭拿到错误值）
            this.command('observe_property', 0x101, 'fullscreen').catch(() => { });
            this.command('observe_property', 0x102, 'speed').catch(() => { });
        });
        sock.once('error', () => {
            setTimeout(() => this._connectIpc(attempt + 1), 100);
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
            if (msg.name === 'fullscreen') this._lastFs = !!msg.data;
            if (msg.name === 'speed' && typeof msg.data === 'number') this._lastSp = msg.data;
            return;
        }
        if (msg.event === 'end-file' && msg.reason === 'eof') {
            const playlistPos = (typeof msg.playlist_pos === 'number') ? msg.playlist_pos : -1;
            // 附带队列长度：渲染层据此区分「mpv 队列自动推进」与「队列末尾播完」（接力连播用）
            this.emit('ended', { playlistPos, queueLen: this._queueLen });
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
