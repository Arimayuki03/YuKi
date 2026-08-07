/**
 * hls-downloader.js — m3u8 切片流下载（ffmpeg -c copy 自动合成单文件）
 *
 * aria2 无法处理 HLS 切片流，此处独立管理任务：
 * - add({url, out, header})：先抓播放列表估总时长（进度用），再 spawn ffmpeg
 *   拉流合成到下载目录（临时名保留真实扩展名，完成后 rename 为终名）；
 * - AES-128 加密流由 ffmpeg 自动解密（KEY 随播放列表内嵌）；
 * - 任务状态结构与 aria2 flatten 对齐（kind:'hls' 供渲染层区分），
 *   由主进程 1s 轮询合并推送；完成/失败经 EventEmitter 通知。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { findFfmpeg } = require('./ffmpeg');
const { proxyEnv, proxyFetch } = require('./system-proxy');

let _seq = 0;

/** header 对象 → ffmpeg -headers 需要的 "K: V\r\n" 串（空对象返回 ''）。 */
function ffmpegHeaders(header) {
    if (!header || typeof header !== 'object') return '';
    return Object.entries(header)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k}: ${v}\r\n`).join('');
}

/** 抓 m3u8 播放列表估算总时长（master 播放列表自动选最高码率变体）；失败返回 0。 */
async function probeDuration(url, header) {
    try {
        const headers = { 'User-Agent': 'Mozilla/5.0', ...(header || {}) };
        let text = await (await proxyFetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'follow' })).text();
        if (text.includes('#EXT-X-STREAM-INF')) {
            // master：取 BANDWIDTH 最高的变体（相对地址按播放列表 URL 解析）
            let best = null, bestBw = -1;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const m = lines[i].match(/^#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/);
                if (m && lines[i + 1] && !lines[i + 1].startsWith('#')) {
                    const bw = parseInt(m[1], 10);
                    if (bw > bestBw) { bestBw = bw; best = lines[i + 1].trim(); }
                }
            }
            if (!best) return 0;
            const vurl = new URL(best, url).href;
            text = await (await proxyFetch(vurl, { headers, signal: AbortSignal.timeout(15000), redirect: 'follow' })).text();
        }
        let dur = 0;
        for (const line of text.split(/\r?\n/)) {
            const m = line.match(/^#EXTINF:([\d.]+)/);
            if (m) dur += parseFloat(m[1]);
        }
        return dur;
    } catch (e) { return 0; }
}

class HlsDownloader extends EventEmitter {
    constructor() {
        super();
        this.dir = '';
        this._tasks = new Map(); // gid → task
        this.on('error', () => { }); // EventEmitter 兜底
    }

    setDir(dir) { this.dir = dir || path.join(os.homedir(), 'Downloads'); }

    /** 新增任务；返回 gid。ffmpeg 缺失抛 Error('ffmpeg-missing')。 */
    add({ url, out, header }) {
        const bin = findFfmpeg();
        if (!bin) throw new Error('ffmpeg-missing');
        const gid = `hls-${++_seq}-${Date.now().toString(36)}`;
        fs.mkdirSync(this.dir, { recursive: true });
        const name = (out || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
        const dest = path.join(this.dir, name);
        const task = {
            gid, kind: 'hls', name, url, header: header || null,
            status: 'active', percent: 0, done: 0, total: 0,
            errorMessage: '', files: [dest], _dest: dest, _bin: bin, _proc: null, _retried: false,
        };
        this._tasks.set(gid, task);
        this._run(task);
        return gid;
    }

    async _run(task) {
        task.duration = await probeDuration(task.url, task.header);
        if (task.status === 'removed') return;
        this._spawn(task, true);
    }

    /** spawn ffmpeg 合成；withBsf=false 为重试（部分流不需要 aac_adtstoasc）。 */
    _spawn(task, withBsf) {
        // 临时名保留真实扩展名：ffmpeg 按扩展名推断容器格式，.part 后缀会导致
        // 「Unable to choose an output format」直接失败；完成后 rename 为终名
        const part = task._dest + '.incomplete' + path.extname(task._dest);
        const args = ['-hide_banner', '-y'];
        const hs = ffmpegHeaders(task.header);
        if (hs) args.push('-headers', hs);
        args.push('-i', task.url, '-c', 'copy');
        if (withBsf) args.push('-bsf:a', 'aac_adtstoasc');
        args.push(part);
        // ffmpeg 不读系统代理：经环境变量注入（直连不可达的环境下必需）
        const proc = spawn(task._bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...proxyEnv() } });
        task._proc = proc;
        proc.stderr.on('data', (chunk) => {
            // ffmpeg 进度行 "time=00:12:34.56" → 按播放列表总时长折算百分比
            const m = chunk.toString().match(/time=(\d+):(\d+):([\d.]+)/);
            if (m && task.duration > 0) {
                const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
                task.percent = Math.max(task.percent, Math.min(99.9, Math.round(t / task.duration * 1000) / 10));
            }
        });
        proc.on('exit', (code) => {
            task._proc = null;
            if (task.status === 'removed') return;
            if (code === 0 && fs.existsSync(part)) {
                try { fs.rmSync(task._dest, { force: true }); } catch (e) { /* ignore */ }
                fs.renameSync(part, task._dest);
                task.status = 'complete';
                task.percent = 100;
                this.emit('completed', this._flatten(task));
                return;
            }
            try { fs.rmSync(part, { force: true }); } catch (e) { /* ignore */ }
            if (!task._retried) { task._retried = true; this._spawn(task, false); return; }
            task.status = 'error';
            task.errorMessage = '切片合成失败（源可能不可达或格式异常）';
            this.emit('error', this._flatten(task));
        });
        proc.on('error', () => {
            task.status = 'error';
            task.errorMessage = 'ffmpeg 启动失败';
            this.emit('error', this._flatten(task));
        });
    }

    /** 终止任务并从列表移除（进行中杀进程；临时产物一并清理）。 */
    remove(gid) {
        const t = this._tasks.get(gid);
        if (!t) return;
        if (t._proc) { try { t._proc.kill(); } catch (e) { /* ignore */ } }
        t.status = 'removed';
        this._tasks.delete(gid);
        try { fs.rmSync(t._dest + '.incomplete' + path.extname(t._dest), { force: true }); } catch (e) { /* ignore */ }
        // 历史版本临时名，旧残留顺带清理
        try { fs.rmSync(t._dest + '.part', { force: true }); } catch (e) { /* ignore */ }
    }

    /** 清掉已停止的记录（complete/error/removed），与 aria2 purge 对应。 */
    clearStopped() {
        for (const [gid, t] of this._tasks) {
            if (['complete', 'error', 'removed'].includes(t.status)) this._tasks.delete(gid);
        }
    }

    /** 清掉失败记录并兜底清理临时残留（正常失败路径 exit 回调已删，此处防漏）。返回条数。 */
    clearFailed() {
        let n = 0;
        for (const [gid, t] of this._tasks) {
            if (t.status !== 'error') continue;
            this._tasks.delete(gid);
            try { fs.rmSync(t._dest + '.incomplete' + path.extname(t._dest), { force: true }); } catch (e) { /* ignore */ }
            try { fs.rmSync(t._dest + '.part', { force: true }); } catch (e) { /* ignore */ }
            n++;
        }
        return n;
    }

    _flatten(t) {
        return {
            gid: t.gid, kind: 'hls', status: t.status, name: t.name,
            total: 0, done: 0, percent: t.percent, speed: 0, connections: '',
            errorMessage: t.errorMessage, files: t.files,
        };
    }

    /** 全量任务（渲染层与 aria2 列表合并展示）。 */
    list() {
        return [...this._tasks.values()].map((t) => this._flatten(t));
    }
}

module.exports = HlsDownloader;
