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

// mpv 原生截图（s 键）文件名模板：yuki-20260820-153012-000.png
// 合法转义见 _screenshotArgs 注释（%tX / %0Xn；裸 %w 会让 mpv 判为非法模板并放弃截图）。
const SHOT_TEMPLATE = 'yuki-%tY%tm%td-%tH%tM%tS-%03n';

function traceFields(value) {
    const result = {};
    if (value && value.requestId) result.requestId = String(value.requestId);
    if (value && value.playSessionId) result.playSessionId = String(value.playSessionId);
    return result;
}

/** 校验 mpv 二进制真实可用：spawnSync --version（规避损坏/占位 exe），返回版本首行或 null。 */
function mpvVersion(p) {
    try {
        const r = spawnSync(p, ['--version'], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        if (r.error || r.status !== 0) return null;
        const line = String(r.stdout || '').split(/\r?\n/)[0].trim();
        return line || null;
    } catch (e) { return null; }
}

/** 解析 --version 首行（如 "mpv v0.41.0-73-g…" 或 "mpv 0.40.0"）→ { major, minor }；无法解析返回 null。 */
function parseMpvVersion(line) {
    const m = /v?(\d+)\.(\d+)/.exec(String(line || '').trim());
    return m ? { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) } : null;
}

/**
 * 右键上下文菜单能力：select.lua 的 context-menu 绑定、Windows 原生菜单与自定义菜单定义
 * （--script-opt=select-menu_conf_path）自 0.41 起提供（PR #16816/#18057 之后）；git 开发版
 * 版本号 ≥ 对应的下一个发布版，同样满足。旧版注入会在按键时报 unknown binding，故按版本门控。
 */
function supportsContextMenu(versionLine) {
    const v = parseMpvVersion(versionLine);
    return !!v && (v.major > 0 || v.minor >= 41);
}

/**
 * 多集静态列表 → m3u 文本：#EXTINF 携带集名，mpv 原生播放列表（右键菜单/F8）显示标题
 * 而非裸 CDN 地址。仅用于 URL 已知的静态列表（本地/下载/直链批量）；在线剧集的直链
 * 懒解析且带签名时效（整季预解析既慢又会被风控、放到后面集数时早已过期），仍走渲染层
 * 逐集驱动，不进原生队列。无可播放项返回空串，调用方回退单集路径。
 */
function buildM3u(episodes) {
    const lines = ['#EXTM3U'];
    let n = 0;
    for (const ep of (Array.isArray(episodes) ? episodes : [])) {
        if (!ep || !ep.url) continue;
        n += 1;
        // EXTINF 集名净化：换行/Tab 破坏行结构压成空格；抓流产物/清单的临时
        // 文件名（kazumi_stream_*.m3u8、yuki-playlist-*.m3u8 等）一旦混入集名，
        // 会原样出现在 mpv 标题与播放列表——统一回落「第N集」。
        let name = String(ep.title || '').replace(/[\r\n\t]+/g, ' ').trim();
        if (!name || /\.(m3u8?|mp4|mkv|ts|flv)$/i.test(name)) name = `第${n}集`;
        lines.push(`#EXTINF:-1,${name}`);
        lines.push(String(ep.url));
    }
    return lines.length > 1 ? lines.join('\n') + '\n' : '';
}

function findMpv(verOut) {
    const exe = WIN ? 'mpv.exe' : 'mpv';
    const candidates = [];
    const vendor = path.join(ROOT, 'vendor', 'mpv', exe);
    if (fs.existsSync(vendor)) candidates.push(vendor);
    // 「下载内置播放器」装到 userData\vendor\mpv（index.js yuki:download-mpv）。
    // 自动发现必须覆盖该位置，否则用户没装 mpv 组件时点过一次下载、再「恢复默认」，
    // mpvPath 被清空后这份 mpv 就失联，设置页显示未安装（只能再点下载找回）。
    try {
        const { app } = require('electron');
        const ud = path.join(app.getPath('userData'), 'vendor', 'mpv', exe);
        if (fs.existsSync(ud)) candidates.push(ud);
    } catch (e) { /* 非 Electron 环境（单测）忽略 */ }
    try {
        if (WIN) {
            const out = execSync('where mpv', { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
            for (const p of out.split(/\r?\n/)) if (p) candidates.push(p);
        } else {
            const out = execSync(`command -v ${exe}`, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
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
            if (verOut && typeof verOut === 'object') verOut.version = v; // 带回版本首行供能力判断
            return p;
        }
    }
    return null;
}

class MpvPlayer extends EventEmitter {
    constructor() {
        super();
        // findMpv 顺带带回版本首行，用于判定 context-menu 能力（右键菜单/中文 menu.conf 注入门控）
        const probe = {};
        this.binary = findMpv(probe);
        this.supportsContextMenu = supportsContextMenu(probe.version);
        this.proc = null;
        this.socket = null;
        // IPC 命名管道：pid + 最近一次播放时间戳，杜绝「管道已存在（残留 mpv 仍占用）→
        // IPC 连接失败 → 首次起播无窗口/无控制」的偶发 bug（二次点击因残留退出才成功）。
        this.ipcPath = WIN
            ? `\\\\.\\pipe\\yuki-mpv-${process.pid}-${Date.now()}`
            : path.join(os.tmpdir(), `yuki-mpv-${process.pid}-${Date.now()}.sock`);
        this.assPath = path.join(os.tmpdir(), `yuki-danmaku-${process.pid}.ass`);
        this._reqId = 0;
        this._buf = '';
        this._connected = false;
        this._pending = new Map();
        this._danmakuLines = [];
        this._laneCounter = 0;
        this.scriptPath = null;   // 可选 lua 脚本（快捷键提示 + Anime4K 右键菜单信号，见 index.js）
        this.inputConfPath = null; // 可选 input.conf（自定义快捷键步长，见 index.js）
        this.menuConfPath = null;  // 可选中文右键菜单定义 menu.conf（--script-opt=select-menu_conf_path，见 index.js writeMpvAssets）
        this._queueTitles = null;  // 原生队列逐集集名表（index.js 注入；file-loaded 时设置窗口标题用）
        this._queueSeriesTitle = ''; // 原生队列片名（标题 = yuki · 片名 · 集名）
        this.supportsContextMenu = false; // 所选二进制支持 context-menu（mpv 0.41+）；决定右键菜单绑定与 menu.conf 是否注入
        this.externalStyle = false; // 手动指定的自定义 mpv：不注入 YuKi OSD/外观资源，用其自身配置样式
        this.logFilePath = null;  // 可选 mpv 运行日志（--log-file，主进程指定，见 index.js）
        this.watchLaterDir = null; // 续播位置记录目录（--save-position-on-quit）
        this.defaultSpeed = 1;     // 默认倍速（≠1 时起播注入 --speed）
        this.audioLang = '';       // 音轨语言偏好（非空时注入 --alang）
        this.subLang = '';         // 字幕语言偏好（非空时注入 --slang）
        this.anime4kShaders = '';  // Anime4K 着色器链（分号分隔路径；非空时注入 --glsl-shaders）
        this.screenshotDir = '';   // 截图保存目录（非空时注入 --screenshot-directory，mpv 原生 s 键也存这里）
        this._queueLen = 0;        // 当前播放队列长度（ended 事件附带，供渲染层判定队列末尾）
        this._sessionId = 0;       // 起播会话号（每次 play 自增；exit 事件附带，供渲染层匹配新旧进程）
        this._lastFs = false;      // 播放期间全屏状态（实时追踪，exit 时无需查询）
        this._lastSp = 1;          // 播放期间倍速（实时追踪，exit 时无需查询）
        this._activeSession = null; // {id, proc, pos, duration, fullscreen, speed}，退出时使用缓存
        this.controlGen = 0;        // 播放控制代际：stop()/用户关闭/新起播时自增，供断流重连检测退出
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
            this.supportsContextMenu = supportsContextMenu(v); // 自定义二进制同样按版本门控
            this.externalStyle = true; // 用户手动指定的 mpv：原生配置模式（不注入 hints/input.conf/menu.conf）
            return true;
        }
        return false;
    }

    /** 重置为自动发现（内置 vendor → PATH），清除自定义路径。 */
    resetBinary() {
        const probe = {};
        this.binary = findMpv(probe);
        this.supportsContextMenu = supportsContextMenu(probe.version);
        this.externalStyle = false; // 回到自动发现：恢复 YuKi 引擎样式
    }

    get playing() { return !!this.proc; }

    // ------------------------------------------------------------ 生命周期

    /** 重新生成 IPC 管道路径（每次起播独立，避免残留管道导致首播 IPC 无法连接）。 */
    _refreshIpcPath() {
        this.ipcPath = WIN
            ? `\\\\.\\pipe\\yuki-mpv-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
            : path.join(os.tmpdir(), `yuki-mpv-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sock`);
        // Linux 遗留 socket 文件（上次崩溃未清理）会阻止 mpv 绑定，需预先清理
        if (!WIN) {
            try { if (fs.existsSync(this.ipcPath)) fs.rmSync(this.ipcPath, { force: true }); } catch (e) { /* ignore */ }
        }
    }

    /**
     * 视频缓冲缓存参数（起播时拼入 argv）。
     *
     * **缓存一律落在内存，永不落磁盘**：无条件带 `--cache-on-disk=no`（命令行优先级高于用户
     * `mpv.conf`，杜绝 conf 里 `cache-on-disk=yes` 把在线流写进磁盘），本地文件也一并带上。
     *
     * 曾经存在的 'disk' 模式（`--cache-on-disk=yes` + `--demuxer-cache-dir`，由设置键
     * playerCacheMode 控制）已整体移除：那个键没有任何 UI 入口，一旦被历史版本写成 'disk'
     * 用户就再也关不掉，表现为「代码默认值已改成内存但实测仍在写盘」——持久化值压过默认值。
     * 残留的两个设置键与 mpv-cache-*.dat 由 index.js 启动时一次性迁移清理。
     *
     * 在线播放（isNet）统一加大预缓冲抗 CDN/转发抖动（含网盘 go-proxy 分段实时转发流），
     * 本地文件不需要预缓冲。注：mpv 默认 `--demuxer-cache-unlink-files=immediate`，历史上
     * 落盘的缓存文件建好即 unlink、播完消失，故排查时只见磁盘写入吞吐、目录里找不到文件。
     */
    _cacheArgs(isNet) {
        const args = [];
        if (isNet) {
            // 网盘(夸克)go-proxy 转流 CDN 常限速（~5MB/s），并发分段几乎无增益。
            // 加大读缓冲窗口让有限的带宽流水化填充缓存，减少 4K 起播/连播卡顿；
            // 保持起播即时（不强制先缓冲满，否则等太久）。这些即为内存占用上限。
            args.push('--cache=yes',
                      '--demuxer-max-bytes=512MiB', '--demuxer-readahead-secs=60',
                      '--demuxer-max-back-bytes=128MiB');
            // 网盘 go-proxy 转发（do=pan）首次起播可能要先解析分享/转存（5-20s），
            // 加大网络超时避免 mpv 等待首字节超时断开（此前 10054 播放失败）。
            args.push('--network-timeout=120');
        }
        args.push('--cache-on-disk=no');
        return args;
    }

    /**
     * 截图参数（起播时拼入 argv），覆盖 mpv 原生 s 键（screenshot 命令）落盘的目录/格式/文件名。
     *
     * 文件名模板只用 mpv 合法转义：`%tX`（strftime 字段）+ `%0Xn`（序号，重名时自增避让）。
     * **不要写裸 `%w`**——mpv 的 `%w` 必须紧跟子格式字符（%wH/%wM/%wS/%ws/%wf…），
     * 此前模板 `yuki-%w-%03n` 里 `%w-` 属未知转义，mpv create_fname 判为非法模板后
     * 直接放弃截图（终端报 "Invalid screenshot filename template"），而 input.conf 的
     * `show-text "已截图"` 照旧弹出 → 表现为「提示截了但目录里没有图」。
     * 格式显式 png：mpv 默认 jpg，与 IPC 通道 screenshot-to-file 的 .png 统一。
     */
    _screenshotArgs() {
        if (!this.screenshotDir) return [];
        try { fs.mkdirSync(this.screenshotDir, { recursive: true }); } catch (e) { /* ignore */ }
        return [
            `--screenshot-directory=${this.screenshotDir}`,
            '--screenshot-format=png',
            `--screenshot-template=${SHOT_TEMPLATE}`,
        ];
    }

    /**
     * ytdl_hook 参数（起播时拼入 argv）：**默认整体排除**。
     *
     * YuKi 交给 mpv 的全部是已解析媒体直链或本地文件——推送/解析的非直链 URL 也先经
     * 隐藏窗口抓到真实媒体请求（captureDirect），失败即报 resolve-failed，页面 URL 从不
     * 原样进 mpv。而本应用不打包 yt-dlp、用户 PATH 通常也没有：mpv 内置 ytdl_hook 会对
     * 每个 URL 先尝试 yt-dlp/youtube-dl（6 个候选名 × 配置目录逐一探测 + PATH spawn），
     * 全部落空报 "Subprocess failed: init"。带扩展名直链历史上靠后缀白名单排除；
     * 无扩展名直链（CDN 签名链接如 .../video/tos/.../<token>/）不命中白名单，实测起播
     * 被拖慢 ~5s 且错误刷满日志尾部。故改为默认排除：
     * opts.ytdl === true 是逃生口——调用方明确要让 yt-dlp 参与解析时显式开启。
     */
    _ytdlArgs(opts) {
        if (opts && opts.ytdl === true) return [];
        return ['--script-opt=ytdl_hook-exclude=.*'];
    }

    /**
     * 右键中文菜单参数（起播时拼入 argv）：menu.conf 无条件注入——script-opts 对脚本而言
     * 是不透明键值表，旧版 select.lua 不认识 menu_conf_path 键时静默忽略，无副作用；
     * 新版则用它加载中文菜单定义。路径统一正斜杠，规避 mpv keyvalue 列表值中反斜杠的
     * 转义歧义。（右键「打开菜单」的绑定不在此处：由连接后的运行时能力探测注入，见 _connectIpc。）
     */
    _contextMenuArgs() {
        if (!this.menuConfPath || !fs.existsSync(this.menuConfPath)) return [];
        return [`--script-opt=select-menu_conf_path=${this.menuConfPath.replace(/\\/g, '/')}`];
    }

    /** 播放首项并装载播放列表。episodes: [{url, title}]；opts.header 注入 HTTP 头（解析直链常需 Referer） */
    play(episodes, opts = {}) {
        this._refreshIpcPath();
        this.stop();
        const trace = traceFields(opts);
        if (!this.binary) return { ok: false, reason: 'mpv-missing', ...trace };
        // 起播前二次校验二进制真实存在：findMpv() 发现后文件被删（如安装时取消内置播放器、
        // 或卸载补装目录被清）会让 spawn 抛异步 ENOENT。此处提前拦截，返回可用错误而非崩溃。
        if (!fs.existsSync(this.binary)) {
            console.warn(`[mpv] 二进制已不存在，标记为不可用：${this.binary}`);
            this.binary = null;
            return { ok: false, reason: 'mpv-missing', ...trace };
        }
        if (!episodes || !episodes.length) return { ok: false, reason: 'empty playlist' };
        // 原生播放列表模式（episodes≥2，静态直链）：整季装载进 mpv 原生列表，连播由
        // mpv 同进程推进。外部播放器主播放器在进入本方法前已分流（index.js extPrimary）；
        // 在线剧集因直链懒解析+签名时效仍走渲染层逐集驱动，不进此模式（见 buildM3u 注）。
        const nativeQueue = episodes.length > 1;
        let deferredSeekSec = null;
        let playlistPath = '';
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
        ];
        // 窗口标题：原生队列用 ${media-title}（EXTINF 集名随切集自动跟随）；
        // 单集会话直接采用已知集名标题，避免 CDN 文件名/乱码串进标题。
        if (nativeQueue) {
            args.push('--title=yuki');
        } else {
            const epTitle = String(opts.title || 'YuKi').replace(/["$]/g, '');
            args.push(`--title=yuki · ${epTitle}`);
        }
        if (WIN && !this.externalStyle) args.push('--osd-font=Microsoft YaHei');
        const headerFields = MpvPlayer.headerFieldsValue(opts.header);
        if (headerFields) args.push(`--http-header-fields=${headerFields}`);
        // ytdl_hook 默认整体排除（见 _ytdlArgs 注）：本应用不打包 yt-dlp，放任 mpv 探测
        // 只会在无扩展名直链上白白拖慢起播并刷错误日志。opts.ytdl===true 时保留。
        args.push(...this._ytdlArgs(opts));
        // 自定义 lua 提示脚本/input.conf（主进程写入 userData/mpv-scripts，见 index.js writeMpvAssets）：
        // 用 --scripts-append 追加而非 --scripts 覆盖，避免替换 mpv 默认 scripts 目录的加载
        // 原生配置模式（手动指定的自定义 mpv，如 mpv.lite）：不注入 YuKi OSD/外观
        // 资源（hints.lua / 生成 input.conf / 中文 menu.conf / 雅黑字体），完全使用
        // 该播放器自身的 portable_config 或 %APPDATA%\mpv 配置与脚本。功能类参数
        // （IPC/续播/缓存/截图目录）仍保留，连播与统计不受影响。
        if (!this.externalStyle) {
            if (this.scriptPath && fs.existsSync(this.scriptPath)) args.push(`--scripts-append=${this.scriptPath}`);
            if (this.inputConfPath && fs.existsSync(this.inputConfPath)) args.push(`--input-conf=${this.inputConfPath}`);
            args.push(...this._contextMenuArgs());
        }
        // mpv 运行日志落盘（每次启动覆盖）：--no-terminal 会吞掉全部终端输出，
        // 起播失败时 stderr 为空、用户只能看到无信息量的 'error'；落盘日志让
        // HTTP 4xx/5xx、TLS、超时等真实原因可以在退出时回读（见 exit 处理）。
        if (this.logFilePath) {
            try { fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true }); } catch (e) { /* ignore */ }
            args.push(`--log-file=${this.logFilePath}`);
        }
        // 续播：退出时记录位置，同一地址再次起播自动跳转（mpv 按 URL 哈希匹配）；
        // 直播地址（opts.resume===false）不记录，避免下次误跳旧位置
        if (this.watchLaterDir && opts.resume !== false) {
            try { fs.mkdirSync(this.watchLaterDir, { recursive: true }); } catch (e) { /* ignore */ }
            args.push('--save-position-on-quit', `--watch-later-directory=${this.watchLaterDir}`);
        }
        // 倍速：优先使用连播延续的当前速度，其次用设置的默认倍速
        const speed = (opts.speed && opts.speed > 0) ? opts.speed : this.defaultSpeed;
        if (speed && speed !== 1) args.push(`--speed=${speed}`);
        // FongMi position 使用毫秒；mpv --start 使用秒。仅接受有限的非负数，
        // 防止源配置把任意字符串拼进播放器参数。
        // 原生队列不用 --start：它是全局选项，会错误作用于列表里的每一集；
        // 改为首集装载后经 IPC seek 一次（session.pendingSeekSec，见 _onEvent file-loaded）。
        if (Number.isFinite(Number(opts.position)) && Number(opts.position) > 0) {
            const startSec = Math.max(0, Number(opts.position) / 1000);
            if (nativeQueue) deferredSeekSec = startSec;
            else args.push(`--start=${startSec}`);
        }
        // 外置字幕：Result.subs 的 url/src 字段映射到 mpv --sub-file。
        // DRM/特殊自定义轨道仍由上层保留并明确提示，不把未知对象拼进 argv。
        if (Array.isArray(opts.subs)) {
            for (const sub of opts.subs) {
                const subUrl = typeof sub === 'string' ? sub : (sub && (sub.url || sub.src));
                if (/^https?:\/\//i.test(String(subUrl || ''))) args.push(`--sub-file=${subUrl}`);
            }
        }
        // Result.format 是 MIME 或容器提示；映射到 libavformat 名称，
        // 只接受白名单字符，未知值仍保留在调用元数据而不污染 argv。
        if (opts.format) {
            const format = String(opts.format).toLowerCase();
            const formatMap = {
                'application/x-mpegurl': 'hls',
                'application/vnd.apple.mpegurl': 'hls',
                'application/dash+xml': 'dash',
                'video/mp4': 'mp4',
                'video/webm': 'webm',
            };
            const lavf = formatMap[format] || (/^[a-z0-9_+-]{1,32}$/.test(format) ? format : '');
            if (lavf) args.push(`--demuxer-lavf-format=${lavf}`);
        }
        // 全屏：连播延续上一集的全屏状态
        if (opts.fullscreen) args.push('--fs');
        // 语言偏好：多音轨/内嵌字幕时按设定语言优先选择（设置页可调）
        if (this.audioLang) args.push(`--alang=${this.audioLang}`);
        if (this.subLang) args.push(`--slang=${this.subLang}`);
        // Anime4K 实时超分（动漫向）：着色器链完整存在才注入，缺文件静默跳过
        if (this.anime4kShaders) args.push(`--glsl-shaders=${this.anime4kShaders}`);
        // 视频缓冲（只走内存，永不落盘，见 _cacheArgs）
        const isNet = /^https?:\/\//i.test(String(episodes[0].url || ''));
        args.push(...this._cacheArgs(isNet));
        // 截图目录/格式/文件名模板（mpv 原生 s 键与 IPC 截图都存到这里，见 _screenshotArgs）
        args.push(...this._screenshotArgs());
        // 原生队列：m3u（#EXTINF 集名进 mpv 原生列表，右键菜单/F8 可见可切）+ 起始集下标
        if (nativeQueue) {
            // 不保留历史清单：残留的旧 m3u 一旦被当作列表展开，会导致集数虚增与
            // 匹配错位。写入新清单前先清掉全部同类临时文件（此时旧进程已被 stop）。
            try {
                for (const f of fs.readdirSync(os.tmpdir())) {
                    if (/^yuki-playlist-\d+-\d+\.m3u8$/.test(f)) {
                        try { fs.rmSync(path.join(os.tmpdir(), f), { force: true }); } catch (e) { /* ignore */ }
                    }
                }
            } catch (e) { /* ignore */ }
            playlistPath = path.join(os.tmpdir(), `yuki-playlist-${process.pid}-${Date.now()}.m3u8`);
            fs.writeFileSync(playlistPath, buildM3u(episodes), 'utf8');
            const startIndex = Number.isFinite(Number(opts.startIndex))
                ? Math.max(0, Math.floor(Number(opts.startIndex))) : 0;
            // --playlist-start 为 0 基下标；0 时不传，保持 argv 与旧单集路径完全一致
            if (startIndex > 0) args.push(`--playlist-start=${startIndex}`);
            args.push('--', playlistPath);
        } else {
            args.push('--', episodes[0].url);
        }
        this._queueLen = episodes.length;
        this._lastFs = !!opts.fullscreen;
        this._lastSp = (speed && speed > 0) ? speed : 1;
        const sessionId = ++this._sessionId; // 闭包捕获：进程退出时附带，区分新旧会话
        let proc;
        try {
            // stderr 不能再丢弃：网络地址/解码失败时 mpv 会把唯一可读原因
            // 写到 stderr；同时持续消费 pipe，避免缓冲区塞满后卡住进程。
            proc = spawn(this.binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        } catch (err) {
            console.error(`[mpv] spawn 异常：${err && err.message || err}`);
            return {
                ok: false,
                reason: 'mpv-spawn-failed',
                error: err && err.message ? err.message : String(err || 'spawn failed'),
                ...trace,
            };
        }
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
            ready: false,       // 已收到 file-loaded / core-idle=false，才算真正开始播放
            stderr: '',         // 最近一段 mpv 错误输出（避免错误日志无限增长）
            nativeQueue,        // 原生多集队列：ended 逐集携带 nativeQueue/playlistPos 供渲染层逐集记账
            pendingSeekSec: deferredSeekSec, // 首集装载后一次性 seek（原生队列替代全局 --start）
            seekApplied: false,
            queueIdx: Number(opts.startIndex) || 0, // 当前播放的列表下标（file-loaded 时经 IPC 刷新；end-file 记账用）
            itemStartMs: Date.now(), // 当前集墙钟起点（每次 file-loaded 刷新；逐集统计用）
            // 观看时长统计（墙钟）：累计播放器运行时长（打开播放器后运行了多久，含暂停）。
            playStartMs: Date.now(),
            pausedMs: 0,        // 累计暂停时长（毫秒）
            paused: false,
            pauseSince: 0,
            ...trace,
        };
        this.proc = proc;
        this._activeSession = session;
        if (proc.stderr) {
            proc.stderr.on('data', (chunk) => {
                const text = String(chunk || '');
                session.stderr = (session.stderr + text).slice(-8192);
            });
        }
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
            // 起播前失败时 stderr 常为空（--no-terminal 吞掉终端输出）；从落盘的
            // --log-file 取真实原因（HTTP 4xx/5xx、TLS、超时），否则退出信息里只剩
            // 无信息量的 endReason='error'，渲染层提示无法给出可操作的原因。
            if (!session.ready && !session.stderr && this.logFilePath) {
                try {
                    const logText = fs.readFileSync(this.logFilePath, 'utf8');
                    // 尾部直切会带满收尾调试行（Destroying client handle…），展示给
                    // 用户的「原因」毫无信息量；改为提取 error/warn 级与错误关键词行。
                    const reason = MpvPlayer.extractErrorReason(logText);
                    if (reason) session.stderr = reason;
                } catch (e) { /* 日志缺失时保持原样 */ }
            }
            // ChildProcess 的 exit 触发时 mpv IPC 通常已经断开；直接使用播放期间持续观察的缓存。
            // 观看时长（墙钟）：从起播到退出的总运行时长（打开播放器后运行了多久），暂停期间也算。
            const wallWatched = Math.max(0, Math.round((Date.now() - session.playStartMs) / 1000));
            const info = {
                code,
                sessionId,
                ...traceFields(session),
                pos: typeof session.pos === 'number' ? session.pos : null,
                duration: typeof session.duration === 'number' ? session.duration : null,
                wallWatched,   // 播放器运行时长（墙钟，含暂停）：观看统计以此累计
                fullscreen: session.fullscreen,
                speed: session.speed,
                endReason: session.endReason || null,
                ready: !!session.ready,
                nativeQueue: !!session.nativeQueue,
                queueLen: this._queueLen,
                // 当前集下标（与 ended 的 playlistPos 同源，file-loaded 时经 IPC 刷新）：
                // 原生队列退出时渲染层据此补记「正在看的这一集」并与已记账下标去重
                playlistPos: (typeof session.queueIdx === 'number') ? session.queueIdx : -1,
                stderr: session.stderr ? session.stderr.trim().slice(-8192) : null,
                // 用户主动关闭：应用 stop() 标记，或 mpv 自己 end-file reason=quit/stop（点窗口关闭键）
                userStopped: session.userStopped || session.endReason === 'quit' || session.endReason === 'stop',
            };
            // 用户直接关掉 mpv 窗口（未走应用 stop()）：同样自增代际，断流重连不再接手重播
            if (info.userStopped) this.controlGen++;
            // 只清理该会话；旧进程延迟退出时不能误清掉刚起播的新会话。
            this._teardown(sessionId);
            this.emit('exit', info);
        });
        this._connectIpc(0, sessionId);
        return {
            ok: true,
            sessionId,
            ...trace,
            controlGen: this.controlGen,
            nativeQueue, // 渲染层/调用方据此区分原生多集队列（连播由 mpv 推进）与单集会话
            // 调用方需要把实际交给 mpv 的地址回传给渲染层/日志，便于复制和诊断。
            url: episodes[0].url,
            urls: episodes.map((episode) => episode.url),
        };
    }

    /**
     * 等待当前会话真正装载媒体。
     * spawn 成功只代表进程创建成功；file-loaded 或 core-idle=false 才代表
     * mpv 已经接受并打开了媒体。进程提前退出时返回 stderr/end-file 原因。
     */
    waitForReady(sessionId, timeoutMs = 30000) {
        const id = Math.abs(Number(sessionId) || 0);
        const active = this._activeSession;
        if (!id || !this.proc || !active || active.id !== id) {
            return Promise.resolve({ ok: false, reason: 'mpv-exited', sessionId: id });
        }
        if (active.ready) return Promise.resolve({ ok: true, sessionId: id, ...traceFields(active) });

        return new Promise((resolve) => {
            let settled = false;
            let checking = false;
            let pollTimer = null;
            let timeoutTimer = null;

            const finish = (result) => {
                if (settled) return;
                settled = true;
                if (pollTimer) clearInterval(pollTimer);
                if (timeoutTimer) clearTimeout(timeoutTimer);
                this.removeListener('ready', onReady);
                this.removeListener('exit', onExit);
                this.removeListener('spawn-error', onSpawnError);
                resolve(result);
            };
            const onReady = (info) => {
                if (info && info.sessionId === id) finish({ ok: true, sessionId: id, ...traceFields(active) });
            };
            const onExit = (info) => {
                if (!info || info.sessionId === id) {
                    finish({
                        ok: false,
                        reason: 'mpv-exited-before-playback',
                        sessionId: id,
                        ...traceFields(active),
                        error: info && (info.stderr || info.endReason || (info.code != null ? `exit ${info.code}` : '')),
                    });
                }
            };
            const onSpawnError = (info) => {
                if (!info || info.sessionId === id) {
                    finish({
                        ok: false,
                    reason: 'mpv-spawn-failed',
                    sessionId: id,
                    ...traceFields(active),
                        error: info && (info.message || info.code || 'spawn failed'),
                    });
                }
            };
            const check = async () => {
                if (settled || checking) return;
                const current = this._activeSession;
                if (!this.proc || !current || current.id !== id) {
                    finish({ ok: false, reason: 'mpv-exited-before-playback', sessionId: id });
                    return;
                }
                if (current.ready) {
                    finish({ ok: true, sessionId: id });
                    return;
                }
                if (!this._connected) return;
                checking = true;
                try {
                    if ((await this.getProperty('core-idle')) === false) {
                        current.ready = true;
                        finish({ ok: true, sessionId: id });
                    }
                } catch (e) {
                    // IPC 仍在连接/媒体仍在打开，继续等待；真正失败会由 exit 事件给出。
                } finally {
                    checking = false;
                }
            };

            this.on('ready', onReady);
            this.on('exit', onExit);
            this.on('spawn-error', onSpawnError);
            pollTimer = setInterval(check, 250);
            timeoutTimer = setTimeout(() => finish({
                ok: false,
                    reason: 'mpv-start-timeout',
                    sessionId: id,
                    ...traceFields(active),
                error: active.stderr ? active.stderr.trim().slice(-8192) : '',
            }), Math.max(1000, Number(timeoutMs) || 30000));
            check();
        });
    }

    stop() {
        this.controlGen++; // 用户/应用主动停止：代际自增，断流重连监控据此立即退出
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
                    exec(`taskkill /pid ${proc.pid} /T /F`, { windowsHide: true }, () => { /* 进程可能已退出，忽略 */ });
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
        for (const [, p] of this._pending) {
            clearTimeout(p.timer); // L-9:teardown 时同步清理所有 IPC 超时定时器
            p.reject(new Error('mpv stopped'));
        }
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
        if (attempt > 100) return; // ~10s 仍连不上则放弃（首播冷启动需更长时间，播放本身不受影响，仅失去控制/事件）
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
            // Anime4K 右键菜单档位请求（hints.lua 写 user-data 信号，主进程消费后回写当前档位）
            this.command('observe_property', 0x106, 'user-data/yuki/a4k-request').catch(() => { });
            this.command('observe_property', 0x107, 'user-data/yuki/ep-skip').catch(() => { });
            this._probeContextMenuBinding();
            this._verifyA4kBindings();
            // 连接就绪通知：主进程据此用实时设置推送菜单初始档位等会话级状态
            // （hints.lua 的静态快照可能过期，见 index.js ipc-connected 处理）。
            this.emit('ipc-connected');
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
            clearTimeout(p.timer); // L-9:应答即清定时器，高频命令不累积
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
            // Anime4K 右键菜单档位请求（hints.lua 写入）：读后立即清空，
            // 这样重复请求同一档位也能再次触发 observe（observe 只在值变化时上报）
            if (msg.name === 'user-data/yuki/a4k-request' && typeof msg.data === 'string' && msg.data) {
                const mode = msg.data;
                this.command('set', 'user-data/yuki/a4k-request', '').catch(() => { });
                this.emit('a4k-request', { mode });
            }
            // 上/下集信号（hints/ep-*）：读后清零，同方向连续按键可再次触发
            if (msg.name === 'user-data/yuki/ep-skip' && typeof msg.data === 'string' && msg.data) {
                const dir = Number(msg.data);
                this.command('set', 'user-data/yuki/ep-skip', '').catch(() => { });
                if (dir === -1 || dir === 1) this.emit('ep-skip', { dir });
            }
            return;
        }
        if (msg.event === 'file-loaded') {
            const active = this._activeSession;
            if (active) {
                active.ready = true;
                // 窗口此时必然已创建：补一次前置激活兜底。spawn 时那次可能早于窗口
                // 创建（慢网络下 VO 初始化滞后），PowerShell 辅助进程虽有 6s 自轮询，
                // 这里再加一发保证「媒体真正开播」时刻也在前台。
                this._bringToFront();
                // 逐集墙钟起点：原生队列里 mpv 每装载一项就刷新一次，ended 时算出本集观看秒数
                active.itemStartMs = Date.now();
                // 刷新当前列表下标（end-file 记账需要；事件本身不带 playlist_pos）
                this.command('get_property', 'playlist-pos').then((v) => {
                    if (this._activeSession === active && typeof v === 'number') active.queueIdx = v;
                    // 原生队列：窗口标题 + OSD 模板 + 立即弹条，三处同步为「yuki · 片名 · 集名」。
                    // 不依赖 ${media-title}——流 metadata 会覆盖它导致只剩片名。
                    if (active.nativeQueue && Array.isArray(this._queueTitles)) {
                        const idx = (typeof active.queueIdx === 'number') ? active.queueIdx : 0;
                        const nm = this._queueTitles[idx] || `第${idx + 1}集`;
                        const series = String(this._queueSeriesTitle || '');
                        const full = (`yuki · ${series}${series && nm ? ' · ' : ''}${nm}`)
                            .replace(/·\s*$/, '').trim();
                        // force-media-title 强制覆盖 media-title：OSC/统计/Windows 媒体浮层
                        // 读到的标题全部变为我们指定的集名（流内嵌 title 标签被压制）
                        this.command('set', 'force-media-title', full).catch(() => { });
                        this.command('set', 'title', full).catch(() => { });
                        this.command('show-text', full, 1200).catch(() => { });
                    }
                }).catch(() => { });
                // 原生队列的首集续播位置：--start 会作用到每一集（全局选项），故只在
                // 首次 file-loaded 后经 IPC seek 一次，后续集数从头播。
                if (active.pendingSeekSec != null && !active.seekApplied) {
                    active.seekApplied = true;
                    const sec = active.pendingSeekSec;
                    this.command('seek', sec, 'absolute+exact').catch(() => { /* 起播 seek 失败不致命 */ });
                }
                this.emit('ready', { sessionId: active.id, ...traceFields(active) });
            }
            return;
        }
        if (msg.event === 'end-file') {
            const active = this._activeSession;
            // 记录退出原因：eof=播完/断流；quit/stop=用户关闭；error=出错
            if (active) active.endReason = msg.reason;
            if (msg.reason === 'eof') {
                if (active && typeof active.duration === 'number') active.pos = active.duration;
                // end-file 事件不带 playlist_pos：优先事件字段，缺省回退会话跟踪值
                // （file-loaded 时经 IPC 刷新，end-file 触发时仍是刚结束这一集的下标）
                let playlistPos = (typeof msg.playlist_pos === 'number') ? msg.playlist_pos : -1;
                if (playlistPos < 0 && active && typeof active.queueIdx === 'number') {
                    playlistPos = active.queueIdx;
                }
                // 附带队列长度：渲染层据此区分「mpv 队列自动推进」与「队列末尾播完」（接力连播用）
                // 原生队列额外携带逐集记账字段（pos/duration/itemWallSec/nativeQueue）：
                // 进程在队列中途不会退出，渲染层改为逐集在 ended 写统计/历史（口径与旧逐集会话一致）。
                const itemWallSec = (active && active.itemStartMs)
                    ? Math.max(0, Math.round((Date.now() - active.itemStartMs) / 1000)) : null;
                this.emit('ended', { sessionId: active ? active.id : null,
                    ...(active ? traceFields(active) : {}), playlistPos, queueLen: this._queueLen,
                    pos: (active && typeof active.pos === 'number') ? active.pos : null,
                    duration: (active && typeof active.duration === 'number') ? active.duration : null,
                    itemWallSec,
                    nativeQueue: !!(active && active.nativeQueue) });
            }
        }
    }

        /**
     * 右键上下文菜单绑定：连接后运行时探测，不猜版本号。
     * 直接查默认绑定表里有没有 select/context-menu（0.41+ 内置默认）：有 → 运行时
     * keybind 注入 MBTN_RIGHT；没有 → 保持该二进制默认行为（如旧版的右键暂停），
     * 绝不注入会报 unknown binding 的死绑定。版本号解析（supportsContextMenu）仅作
     * 设置页提示等参考用途，不再作为注入依据。
     */
    _probeContextMenuBinding() {
        return this.getProperty('input-bindings').then((list) => {
            if (!Array.isArray(list)) return null;
            // 能力探测：默认绑定表里有没有 select/context-menu（0.41+ 内置默认）
            const capable = list.some((b) => b && typeof b.cmd === 'string'
                && b.cmd.includes('select/context-menu'));
            if (!capable) {
                console.log('[mpv] 右键菜单：当前 mpv 无上下文菜单能力，右键保持其默认行为');
                return null;
            }
            // 新版 mpv 已自带 MBTN_RIGHT → select/context-menu 默认绑定；再注入一次
            // 会双绑定（实测每次右键触发两次 script-binding，间隔毫秒级），菜单行为
            // 异常。仅在没有任何 MBTN_RIGHT 绑定时补注入（旧版能力但未绑定的情形）。
            const bound = list.some((b) => b && b.key === 'MBTN_RIGHT'
                && typeof b.cmd === 'string' && b.cmd.includes('select/context-menu'));
            if (bound) {
                console.log('[mpv] 右键菜单：使用内置 MBTN_RIGHT 绑定，跳过注入');
                return null;
            }
            return this.command('keybind', 'MBTN_RIGHT', 'script-binding select/context-menu')
                .then(() => console.log('[mpv] 右键菜单：已启用（MBTN_RIGHT → 上下文菜单）'));
        }).catch(() => { /* 探测失败不影响播放；下次起播重试 */ });
    }

    /**
     * Anime4K 菜单信号自检：hints.lua 是否成功加载。
     * 不能用 input-bindings 判定——add_key_binding(nil,…) 注册的是无键绑定，
     * 只进输入节区（define-section），永不出现于 input-bindings；改为读脚本
     * 加载时写入的哨兵属性 user-data/yuki/hints-loaded，缺失即 lua 未加载
     * （语法/路径问题），右键切档会无响应——大声记日志便于定位。
     */
    _verifyA4kBindings() {
        this.getProperty('user-data/yuki/hints-loaded').then((v) => {
            if (String(v) === '1') {
                console.log('[mpv] Anime4K 菜单信号：hints.lua 已加载');
            } else {
                console.warn('[mpv] Anime4K 菜单信号缺失：哨兵属性不存在（hints.lua 未加载？详见 mpv 日志）');
            }
        }).catch(() => { /* 查询失败不影响播放 */ });
    }

    command(...args) {
        return new Promise((resolve, reject) => {
            if (!this._connected || !this.socket) return reject(new Error('mpv ipc not connected'));
            const id = ++this._reqId;
            const timer = setTimeout(() => {
                if (this._pending.has(id)) {
                    this._pending.delete(id);
                    reject(new Error('mpv ipc timeout'));
                }
            }, 5000);
            this._pending.set(id, { resolve, reject, timer });
            try {
                this.socket.write(JSON.stringify({ command: args, request_id: id }) + '\n');
            } catch (e) {
                clearTimeout(timer);
                this._pending.delete(id);
                reject(e);
            }
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
        // 防御：确保目录存在（调用方通常已 mkdir，此处兜底）。
        try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch (e) { /* ignore */ }
        // 归一化为 posix 斜杠：Windows 反斜杠在部分 mpv 版本的 JSON IPC 解析中被当作转义，
        // 导致 screenshot-to-file 落盘失败。mpv 在 Windows 下同样接受正斜杠路径。
        const posix = String(filePath).replace(/\\/g, '/');
        return this.command('screenshot-to-file', posix, 'subtitles');
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

    /**
     * 从 mpv --log-file 文本提取「起播前退出」的可读原因。
     * 日志尾部充满收尾调试噪音（Destroying client handle…/Terminating 等），
     * 直接 slice(-N) 会把这些无信息量行当错误原因展示给用户（实测对话框只剩
     * 一串 Destroying client handle）。这里优先保留 error/warn 级别行和含
     * HTTP/网络/解封装错误关键词的行；一行都没有时退回尾部非调试行。
     * 另做两层降噪：同文重复行折叠为一条（ytdl_hook 对多个候选二进制逐一
     * 失败会刷屏）；存在其它模块的错误行时整段丢弃 ytdl 行——直链播放与
     * youtube-dl 无关，其失败（not found/permissions）不是退出原因。
     */
    static extractErrorReason(logText, limit = 600) {
        const lines = String(logText || '').split(/\r?\n/);
        const levelOf = (line) => {
            const m = line.match(/^\[\s*[\d.]+\]\[([edvwi])\]/);
            return m ? m[1] : '';
        };
        const ERRORISH_RE = /error|fail|timed? ?out|timeout|refused|reset|broken pipe|tls|ssl|certificate|40[134]\b|429\b|5\d\d\b|no video|unrecognized|invalid data|unable to|denied|not found|expired|forbidden|abort/i;
        const isNoise = (line) => /destroying client handle/i.test(line)
            || /^\[\s*[\d.]+\]\[d\](?:\[[a-z-]+\])?\s+(?:Terminating\.?|Exiting|Uninit)\b/i.test(line);
        const important = [];
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || isNoise(line)) continue;
            const level = levelOf(line);
            if (level === 'e' || level === 'w'
                || (!level && ERRORISH_RE.test(line))) important.push(line);
        }
        let pool = important;
        if (!pool.length) {
            // 无 error/warn 行：退回非调试行尾部（仅排除 [d] 调试级；v/i 级行保留）
            pool = lines.map((l) => l.trim()).filter((line) => line && !isNoise(line)
                && !/^\[\s*[\d.]+\]\[d\]/.test(line));
        }
        // 同文去重（剥掉时间戳后比对），重复的追加 ×N 计数
        const normOf = (line) => line.replace(/^\[\s*[\d.]+\]\[[a-z]\]/, '').trim();
        const collapsed = [];
        const counts = new Map();
        for (const line of pool) {
            const key = normOf(line);
            counts.set(key, (counts.get(key) || 0) + 1);
            if (counts.get(key) === 1) collapsed.push(line);
        }
        for (const line of collapsed) {
            const n = counts.get(normOf(line));
            if (n > 1) collapsed[collapsed.indexOf(line)] = `${line}（×${n}）`;
        }
        // 有其它模块的错误行时丢弃 ytdl 行（直链播放与 youtube-dl 缺失无关）
        let picked = collapsed;
        if (collapsed.some((l) => /\[ytdl_hook\]|youtube-dl|yt-dlp/i.test(l))) {
            const nonYtdl = collapsed.filter((l) => !/\[ytdl_hook\]|youtube-dl|yt-dlp/i.test(l));
            if (nonYtdl.length) picked = nonYtdl;
        }
        const text = picked.slice(-6).join(' ｜ ');
        return text.length > limit ? text.slice(-limit) : text;
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

    /** 构造 --http-header-fields 值；无可发头时返回 ''。
     *  mpv 的该选项是逗号分隔的列表：头值里的逗号（Accept 协商串、含逗号的
     *  Cookie 等）会被当成头分隔符拆开，拼出畸形请求——实测 CDN 直接回
     *  HTTP 400，mpv 以 "Errors when loading file" 退出，对应用户看到的
     *  「解析成功但 mpv 未能开始播放：error」。按 mpv 列表转义语法把值内
     *  逗号写成 \,，头与头之间仍用逗号分隔。 */
    static headerFieldsValue(header) {
        if (!header || typeof header !== 'object') return '';
        // 头值清洗：规则站返回的 UA/Referer 常带尾部空格或换行——原样注入后，
        // mpv 对每个请求（含本地播放列表代理）都回放这些头，Node 严格解析会以
        // HPE_INVALID_HEADER_TOKEN 拒收（"Unexpected whitespace after header value"）。
        const clean = (s) => String(s).replace(/[\r\n\t]+/g, ' ').trim();
        return Object.entries(header)
            .filter(([, v]) => v != null && v !== '')
            .map(([k, v]) => [clean(k), clean(v)])
            .filter(([k, v]) => k && v !== '')
            .map(([k, v]) => `${k}: ${v.replace(/,/g, '\\,')}`)
            .join(', ');
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
        // M-6：弹幕文本先转义换行，再转义 { }（ASS 内 {…} 是样式覆盖块，未转义的
        // 花括号会被解析器吞掉/干扰渲染，恶意文本还可注入 \pos 等覆盖指令）
        const text = d.content.replace(/\r?\n/g, '\\N').replace(/\{/g, '({').replace(/\}/g, '})');
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

// 版本能力解析/原生队列构建对外暴露（测试与调用方复用）
MpvPlayer.parseMpvVersion = parseMpvVersion;
MpvPlayer.supportsContextMenu = supportsContextMenu;
MpvPlayer.buildM3u = buildM3u;

module.exports = MpvPlayer;
