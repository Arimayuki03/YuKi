/**
 * logger.js — 主进程 UTF-8 轮转日志与日志读取。
 *
 * 运行日志统一放在 ~/.yuki/logs；单文件 5 MiB，保留 5 份历史文件。
 * 写入前会遮盖常见令牌、Cookie、Authorization 与密码字段。
 */
const fs = require('fs');
const path = require('path');
const util = require('util');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_BACKUPS = 5;

// 日志等级权重：低于设定级别的日志不写入文件（DEBUG=10/INFO=20/WARN=30/ERROR=40）。
const LEVEL_WEIGHT = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
// 当前生效的日志级别（运行时可由 settings.logLevel 调整；默认 INFO：DEBUG 不落盘）。
let _currentLogLevel = LEVEL_WEIGHT.INFO;

/** 设置当前日志级别（'DEBUG'|'INFO'|'WARN'|'ERROR'），不区分大小写；未知值回退 INFO。 */
function setLogLevel(level) {
    const k = String(level || 'INFO').toUpperCase();
    _currentLogLevel = LEVEL_WEIGHT[k] != null ? LEVEL_WEIGHT[k] : LEVEL_WEIGHT.INFO;
}
function getLogLevel() {
    const v = _currentLogLevel;
    return Object.keys(LEVEL_WEIGHT).find((k) => LEVEL_WEIGHT[k] === v) || 'INFO';
}

// 所有活动写入器（含主进程 electron-main 与 Python 控制台）——外部清空日志后统一重置大小，避免轮转计算漂移。
const _activeWriters = new Set();

// 定时清空日志的计时器引用（由 startScheduledLogCleanup 管理）。
let _cleanupTimer = null;
// 巡检间隔：Node 将 >2^31-1ms（约 24.8 天）的计时器延时钳成 1ms，
// 因此长周期（如 90 天）不能直接 setInterval(intervalMs)，改为低频巡检 + 到期判断。
const CLEANUP_PATROL_MS = 60 * 60 * 1000;

/** 启动定时清空日志：每 intervalMs 毫秒清空一次日志目录。
 *  intervalMs <= 0 或重复调用时先清掉旧计时器。enabled=false 时不启动。
 *  hooks（可选）：{ getLastCleanup, markCleaned } —— 持久化“上次清理时间”，
 *  使清理周期跨应用重启生效；启动时已逾期会立即补清一次。 */
function startScheduledLogCleanup(logDir, intervalMs, enabled, hooks = {}) {
    stopScheduledLogCleanup();
    if (!enabled || !intervalMs || intervalMs <= 0) return;
    const getLast = typeof hooks.getLastCleanup === 'function' ? hooks.getLastCleanup : null;
    const markCleaned = typeof hooks.markCleaned === 'function' ? hooks.markCleaned : () => {};
    const run = () => {
        try { clearLogs(logDir); } catch (e) { /* 定时清空失败不阻断 */ }
        try { markCleaned(Date.now()); } catch (e) { /* 持久化失败仅影响跨重启周期 */ }
        nextAt = Date.now() + intervalMs;
    };
    // 到期时间基准：有持久化钩子按上次清理时间起算，否则本次启动起算。
    let nextAt;
    if (getLast) {
        const last = Number(getLast()) || 0;
        nextAt = (last > 0 ? last : Date.now()) + intervalMs;
        if (Date.now() >= nextAt) run(); // 已逾期（如长期未启动）：立即补清
    } else {
        nextAt = Date.now() + intervalMs;
    }
    _cleanupTimer = setInterval(() => {
        if (Date.now() >= nextAt) run();
    }, Math.min(CLEANUP_PATROL_MS, intervalMs));
}

/** 停止定时清空日志（退出/设置变更时调用）。 */
function stopScheduledLogCleanup() {
    if (_cleanupTimer) { clearInterval(_cleanupTimer); _cleanupTimer = null; }
}

/** 去掉轮转备份后缀（如 electron-main.log.2 → electron-main.log），用于按“来源”归组与过滤。 */
function baseSource(name) {
    return String(name).replace(/\.\d+$/, '');
}

/** 当前级别是否应落盘（DEBUG=10/INFO=20/WARN=30/ERROR=40）。
 * 低于当前级别的日志直接丢弃，不进入轮转写入器。 */
function shouldLog(level) {
    const w = LEVEL_WEIGHT[String(level || 'INFO').toUpperCase()];
    return w == null ? true : w >= _currentLogLevel;
}

function redactSecrets(value) {
    return String(value == null ? '' : value)
        .replace(/([?&](?:token|access_token|refresh_token|api[_-]?key|secret|password)=)[^&#\s]*/gi, '$1[REDACTED]')
        .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,;]+/gi, '$1[REDACTED]')
        .replace(/((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]*/gi, '$1[REDACTED]')
        // 键名允许 JSON 引号形态（"password": "x"）；值带引号时连同闭合引号一起遮盖
        // （保留原引号字符），不带引号时才吃普通分隔符——正常文本中提及 password
        // 字样（后无冒号）不受影响。值类同时排除 [ 与 ]：不吞前一条规则写入的
        // [REDACTED] 占位符（否则会再包一层括号）。
        .replace(/(["']?(?:password|passwd|pwd|token|secret|api[_-]?key)["']?\s*[:=]\s*)(["'])(?:([^"\\]|\\.)*"|(?:[^'\\]|\\.)*'|[^\s,'"}\[\]]+)|(["']?(?:password|passwd|pwd|token|secret|api[_-]?key)["']?\s*[:=]\s*)([^\s,'"}\[\]]+)/gi,
            (m, k1, q1, _v1, k2, v2) => {
                if (k1 != null) return `${k1}${q1}[REDACTED]${q1}`;
                return `${k2}[REDACTED]`;
            });
}

function formatArg(arg) {
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    if (typeof arg === 'string') return arg;
    return util.inspect(arg, { depth: 5, breakLength: 160, maxArrayLength: 100 });
}

class RotatingLogWriter {
    constructor(file, opts = {}) {
        this.file = file;
        this.maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
        this.backups = opts.backups || DEFAULT_BACKUPS;
        this._size = 0;
        this._ready = false;
        _activeWriters.add(this);
    }

    /** 外部（clearLogs）删除日志文件后调用：让下次写入按空文件重新计尺寸，避免轮转漂移。 */
    resetSize() {
        this._size = 0;
        this._ready = false;
    }

    _ensure() {
        if (this._ready) return;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        try { this._size = fs.statSync(this.file).size; } catch (e) { this._size = 0; }
        this._ready = true;
    }

    _rotate(nextBytes) {
        this._ensure();
        if (this._size + nextBytes <= this.maxBytes) return;
        let renamedAll = true;
        for (let i = this.backups; i >= 1; i--) {
            const src = i === 1 ? this.file : `${this.file}.${i - 1}`;
            const dest = `${this.file}.${i}`;
            try {
                if (!fs.existsSync(src)) continue;
                if (i === this.backups && fs.existsSync(dest)) fs.rmSync(dest, { force: true });
                fs.renameSync(src, dest);
            } catch (e) {
                // 单个历史文件占用（如被外部查看器锁定）时放弃本次轮转：
                // 保留当前日志继续追加，_size 不重置，日志不会因计数漂移而无限增长
                renamedAll = false;
                break;
            }
        }
        // 仅历史链全部改名成功才按空文件重计尺寸；否则下次写入继续按旧尺寸判断轮转
        if (renamedAll) this._size = 0;
    }

    write(level, ...args) {
        try {
            const lvl = String(level || 'INFO').toUpperCase();
            // 级别过滤：低于当前日志级别的直接丢弃，不写入文件（不占轮转配额）
            if (LEVEL_WEIGHT[lvl] != null && LEVEL_WEIGHT[lvl] < _currentLogLevel) return;
            const message = redactSecrets(args.map(formatArg).join(' '));
            const lines = message.split(/\r?\n/);
            const stamp = new Date().toISOString();
            const text = lines.map((line) => `${stamp} [${lvl}] ${line}`).join('\n') + '\n';
            const bytes = Buffer.byteLength(text, 'utf8');
            this._rotate(bytes);
            fs.appendFileSync(this.file, text, 'utf8');
            this._size += bytes;
        } catch (e) { /* 日志绝不能导致应用退出 */ }
    }
}

function installConsoleLogger(logDir) {
    const writer = new RotatingLogWriter(path.join(logDir, 'electron-main.log'));
    for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR'], ['debug', 'DEBUG']]) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            writer.write(level, ...args);
            original(...args);
        };
    }
    writer.write('INFO', '[logger] Electron main logging started');
    return writer;
}

/** 从文件尾部倒序读取行（每次向前扩一块，凑够 need 行或读完全文件即停）。
 *  替代整文件同步读入——大日志（数十 MB）分页不再全量扫盘。
 *  返回 { lines, total }：lines 为从新到旧的行数组；total 为已确认存在的
 *  行数下界（读完全文件时即精确行数），仅影响总页数显示，不影响本页内容。 */
function readTailLines(file, need) {
    // stat/open/read 失败一律向上传播，由调用方记入「无法读取」条目（保持旧口径显式上报）
    const st = fs.statSync(file);
    if (st.isDirectory()) throw new Error('EISDIR'); // Windows 上目录 stat.size 为 0、可 open，需显式排除
    const size = st.size;
    if (size === 0) return { lines: [], total: 0 };
    const CHUNK = 256 * 1024;
    let start = size;
    let lines = [];
    let full = false;
    while (true) {
        start = Math.max(0, start - CHUNK);
        if (start === 0) full = true;
        const len = size - start;
        const buf = Buffer.alloc(len);
        let got = 0;
        // open/read 失败（被轮转删除/锁定）不吞错：向上传播由调用方记入「无法读取」条目
        const fd = fs.openSync(file, 'r');
        try {
            while (got < len) {
                const n = fs.readSync(fd, buf, got, len - got, start + got);
                if (n <= 0) break;
                got += n;
            }
        } finally { fs.closeSync(fd); }
        const parts = buf.toString('utf8').split(/\r?\n/);
        if (start > 0) parts.shift(); // 起始字节截断的残行丢弃
        lines = parts.filter(Boolean);
        if (full || lines.length >= need) break;
    }
    const out = [];
    for (let i = lines.length - 1; i >= 0; i--) out.push(lines[i]);
    return { lines: out, total: full ? out.length : out.length + 1 };
}

function readRecentLogs(logDir, page, pageSize, source) {
    const pg = Math.max(1, parseInt(page, 10) || 1);
    const ps = Math.max(1, Math.min(200, parseInt(pageSize, 10) || 50));
    const filter = source ? String(source) : '';
    // 倒序凑页：跳过前 (pg-1)*ps 行（最新行不读），再取 ps 行即停，不全量扫描
    const skip = (pg - 1) * ps;
    const need = skip + ps;
    const entries = [];
    const sources = new Set();
    let files = [];
    try {
        files = fs.readdirSync(logDir).filter((name) => /\.log(?:\.\d+)?$/i.test(name));
    } catch (e) { /* 日志目录尚未建立 */ }
    // 先按 mtime 降序排序（读不到 stat 的文件排到最后，不影响其它文件）。
    const items = files.map((name) => {
        const file = path.join(logDir, name);
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch (e) { mtime = 0; }
        return { name, file, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    let total = 0;
    let earlyStop = false;
    for (const item of items) {
        sources.add(baseSource(item.name));
        // 按来源过滤（含其轮转备份，如选 electron-main.log 时也纳入 .1/.2）。
        if (filter && baseSource(item.name) !== filter) continue;
        // 逐文件独立 try/catch：单个文件被锁定/权限拒绝（如 EPERM）时只跳过并显式上报，
        // 不再作废整个扫描结果。
        try {
            const { lines, total: fileTotal } = readTailLines(item.file, need - entries.length);
            total += fileTotal;
            for (let i = 0; i < lines.length && entries.length < need; i++) {
                entries.push({ file: item.name, line: lines[i] });
            }
        } catch (e) {
            total += 1;
            entries.push({ file: item.name, line: `[无法读取 ${item.name}: ${e && e.code ? e.code : (e && e.message) || '未知错误'}]` });
        }
        // 已凑够本页所需（含翻页偏移）：后续更旧的文件不再读取
        if (entries.length >= need) { earlyStop = true; break; }
    }
    // 提前停止说明后面还有未读内容：把 total 抬到「至少还有一行」，保证
    // 渲染层按 total 算总页数时下一页可达（total 为已确认行数的下界近似）。
    if (earlyStop) total = Math.max(total, entries.length + 1);
    return {
        ok: true,
        logs: entries.slice(skip, need),
        total,
        page: pg,
        pageSize: ps,
        logDir,
        sources: Array.from(sources).sort(),
        source: filter,
    };
}

/** 清空日志目录下的所有日志文件（当前进程日志句柄仍会继续写入新文件）。
 *  返回真实删除数量与无法删除的文件名列表，并重置活动写入器的大小，避免轮转漂移。
 *  Windows 下 Python 后端以 RotatingFileHandler 持有 python-backend.log 句柄，
 *  rmSync 和 truncateSync 可能均失败——此时改用 open('r+') + ftruncate 截断内容。 */
function clearLogs(logDir) {
    let removed = 0;
    const failed = [];
    try {
        const files = fs.readdirSync(logDir).filter((name) => /\.log(?:\.\d+)?$/i.test(name));
        for (const name of files) {
            const full = path.join(logDir, name);
            try {
                fs.rmSync(full);
                // 确认已删除（rmSync 无 force 时被占用会抛错，此处再核一次）。
                if (fs.existsSync(full)) { failed.push(name); } else { removed++; }
            } catch (e) {
                // Windows 下被其他进程（如 Python 后端 python-backend.log）持有句柄的文件无法删除，
                // 退而清空内容（truncate 到 0 字节）：句柄仍有效，后续追加从头写。视为成功清空。
                let cleared = false;
                try {
                    fs.truncateSync(full, 0);
                    cleared = true;
                } catch (e2) {
                    // truncateSync 也失败时（文件以独占模式打开），尝试 open + ftruncate 截断
                    try {
                        const fd = fs.openSync(full, 'r+');
                        try { fs.ftruncateSync(fd, 0); cleared = true; } finally { fs.closeSync(fd); }
                    } catch (e3) { /* open 也失败，确实无法清空 */ }
                }
                if (cleared) removed++;
                else failed.push(name);
            }
        }
    } catch (e) { /* 目录不存在视为空 */ }
    // 外部清空后同步重置活动写入器的大小，避免旧句柄的轮转计算漂移。
    for (const w of _activeWriters) {
        try { if (path.resolve(path.dirname(w.file)) === path.resolve(logDir)) w.resetSize(); } catch (e) { /* ignore */ }
    }
    return { ok: true, removed, failed };
}

module.exports = {
    DEFAULT_MAX_BYTES,
    DEFAULT_BACKUPS,
    LEVEL_WEIGHT,
    RotatingLogWriter,
    installConsoleLogger,
    readRecentLogs,
    clearLogs,
    redactSecrets,
    setLogLevel,
    getLogLevel,
    startScheduledLogCleanup,
    stopScheduledLogCleanup,
};
