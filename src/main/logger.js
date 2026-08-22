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
        .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*)['"]?[^\s,'"}\]]+/gi, '$1[REDACTED]');
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
        for (let i = this.backups; i >= 1; i--) {
            const src = i === 1 ? this.file : `${this.file}.${i - 1}`;
            const dest = `${this.file}.${i}`;
            try {
                if (!fs.existsSync(src)) continue;
                if (i === this.backups && fs.existsSync(dest)) fs.rmSync(dest, { force: true });
                fs.renameSync(src, dest);
            } catch (e) { /* 单个历史文件占用时保留当前日志，不影响应用 */ }
        }
        this._size = 0;
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

function readRecentLogs(logDir, page, pageSize, source) {
    const pg = Math.max(1, parseInt(page, 10) || 1);
    const ps = Math.max(1, Math.min(200, parseInt(pageSize, 10) || 50));
    const filter = source ? String(source) : '';
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
    for (const item of items) {
        sources.add(baseSource(item.name));
        // 按来源过滤（含其轮转备份，如选 electron-main.log 时也纳入 .1/.2）。
        if (filter && baseSource(item.name) !== filter) continue;
        // 逐文件独立 try/catch：单个文件被锁定/权限拒绝（如 EPERM）时只跳过并显式上报，
        // 不再作废整个扫描结果。
        try {
            const lines = fs.readFileSync(item.file, 'utf8').split(/\r?\n/).filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) entries.push({ file: item.name, line: lines[i] });
        } catch (e) {
            entries.push({ file: item.name, line: `[无法读取 ${item.name}: ${e && e.code ? e.code : (e && e.message) || '未知错误'}]` });
        }
    }
    const total = entries.length;
    return {
        ok: true,
        logs: entries.slice((pg - 1) * ps, pg * ps),
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
