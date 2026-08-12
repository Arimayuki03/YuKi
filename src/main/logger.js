/**
 * logger.js — 主进程 UTF-8 轮转日志与日志读取。
 *
 * 运行日志统一放在 ~/.video-pc/logs；单文件 5 MiB，保留 5 份历史文件。
 * 写入前会遮盖常见令牌、Cookie、Authorization 与密码字段。
 */
const fs = require('fs');
const path = require('path');
const util = require('util');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_BACKUPS = 5;

// 所有活动写入器（含主进程 electron-main 与 Python 控制台）——外部清空日志后统一重置大小，避免轮转计算漂移。
const _activeWriters = new Set();

/** 去掉轮转备份后缀（如 electron-main.log.2 → electron-main.log），用于按“来源”归组与过滤。 */
function baseSource(name) {
    return String(name).replace(/\.\d+$/, '');
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
            const message = redactSecrets(args.map(formatArg).join(' '));
            const lines = message.split(/\r?\n/);
            const stamp = new Date().toISOString();
            const text = lines.map((line) => `${stamp} [${String(level || 'INFO').toUpperCase()}] ${line}`).join('\n') + '\n';
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
 *  返回真实删除数量与无法删除的文件名列表，并重置活动写入器的大小，避免轮转漂移。 */
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
                failed.push(name);
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
    RotatingLogWriter,
    installConsoleLogger,
    readRecentLogs,
    clearLogs,
    redactSecrets,
};
