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
async function probeDuration(url, header) {    try {
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

/** 分段 URL 是否为广告（保守路径特征：路径含 /ad/、/ads/、/adbreak/ 或 adsegment）。 */
function isAdUri(uri) {
    try {
        const p = new URL(uri).pathname.toLowerCase();
        return /\/ad(s)?\//.test(p) || /\/adbreak\//.test(p) || /adsegment/.test(p);
    } catch (e) { return false; }
}

/**
 * 过滤 m3u8 播放列表中的广告分段（SCTE-35 与路径特征），返回重写后的播放列表。
 * 主机制：#EXT-X-CUE-OUT … #EXT-X-CUE-IN 之间的分段为广告（标准插播协议）；
 * 辅助：#EXT-X-DATERANGE 带 X-ASSET-URI/ad 标记的行去除；分段 URL 命中广告路径特征也去除。
 * 保留其它标签（KEY/TARGETDURATION/MEDIA-SEQUENCE/ENDLIST）与正常分段，相对地址解析为绝对地址。
 */
function filterAdSegments(playlist, baseUrl) {
    const lines = playlist.split(/\r?\n/);
    const out = [];
    let inAd = false;
    let pendingInf = null;
    let removed = 0;
    const abs = (uri) => {
        try { return new URL(uri, baseUrl).href; } catch (e) { return uri; }
    };
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (/^#EXT-X-CUE-OUT/.test(line)) { inAd = true; pendingInf = null; continue; }
        if (/^#EXT-X-CUE-IN/.test(line)) { inAd = false; continue; }
        if (/^#EXT-X-DATERANGE/.test(line)) {
            if (/X-ASSET-URI|CLASS="[^"]*ad/i.test(line)) removed++;
            else out.push(line);
            continue;
        }
        // AES 密钥 / fMP4 初始化段：本地临时播放列表里相对 URI 会按临时文件路径解析失效 → 改写为绝对地址
        if (/^#EXT-X-KEY:/.test(line) || /^#EXT-X-MAP:/.test(line)) {
            out.push(line.replace(/URI="([^"]+)"/, (m, u) => `URI="${abs(u)}"`));
            continue;
        }
        if (/^#EXTINF/.test(line)) { pendingInf = line; continue; }
        if (line.startsWith('#')) { out.push(line); continue; }
        const uri = abs(line);
        if (inAd || isAdUri(uri)) { removed++; pendingInf = null; continue; }
        if (pendingInf) { out.push(pendingInf); pendingInf = null; }
        out.push(uri);
    }
    if (pendingInf) out.push(pendingInf);
    return { filtered: out.join('\n'), removed };
}

class HlsDownloader extends EventEmitter {
    constructor() {
        super();
        this.dir = '';
        this._tasks = new Map(); // gid → task
        this.on('error', () => { }); // EventEmitter 兜底
    }

    setDir(dir) { this.dir = dir || path.join(os.homedir(), 'Downloads'); }

    /** 新增任务；返回 gid。ffmpeg 缺失抛 Error('ffmpeg-missing')。
     *  adFilter=true 时先抓播放列表过滤广告分段（CUE-OUT/CUE-IN + 广告路径特征），
     *  重写为本地临时 m3u8 再交 ffmpeg；无广告或过滤失败则走原始地址。 */
    add({ url, out, header, adFilter }) {
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
            adFilter: !!adFilter, _adTemp: null, _input: null,
        };
        this._tasks.set(gid, task);
        this._run(task);
        return gid;
    }

    async _run(task) {
        task.duration = await probeDuration(task.url, task.header);
        if (task.status === 'removed') return;
        if (task.adFilter) await this._applyAdFilter(task); // 过滤广告（失败静默走原地址）
        if (task.status === 'removed') return;
        this._spawn(task, true);
    }

    /** 抓媒体播放列表（master 自动选最高码率变体），过滤广告分段并写本地临时 m3u8。 */
    async _applyAdFilter(task) {
        try {
            const headers = { 'User-Agent': 'Mozilla/5.0', ...(task.header || {}) };
            let plUrl = task.url;
            let text = await (await proxyFetch(plUrl, { headers, signal: AbortSignal.timeout(15000), redirect: 'follow' })).text();
            if (text.includes('#EXT-X-STREAM-INF')) {
                // master 播放列表：取 BANDWIDTH 最高的变体
                let best = null, bestBw = -1;
                const lines = text.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const m = lines[i].match(/^#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/);
                    if (m && lines[i + 1] && !lines[i + 1].startsWith('#')) {
                        const bw = parseInt(m[1], 10);
                        if (bw > bestBw) { bestBw = bw; best = lines[i + 1].trim(); }
                    }
                }
                if (!best) return;
                plUrl = new URL(best, task.url).href;
                text = await (await proxyFetch(plUrl, { headers, signal: AbortSignal.timeout(15000), redirect: 'follow' })).text();
            }
            const { filtered, removed } = filterAdSegments(text, plUrl);
            if (!removed) return; // 无广告分段，直接走原地址
            // 过滤后播放列表须保留 .m3u8 扩展名供 ffmpeg 推断 HLS 输入
            const tmp = task._dest + '.adfilter.m3u8';
            fs.writeFileSync(tmp, filtered, 'utf8');
            task._adTemp = tmp;
            task._input = tmp;
            task.adRemoved = removed;
            console.log(`[hls] ${task.name}: 过滤 ${removed} 个广告分段`);
        } catch (e) { /* 过滤失败走原始 url */ }
    }

    /** 清理广告过滤临时播放列表（任务结束/删除时）。 */
    _cleanAdTemp(t) {
        if (t && t._adTemp) {
            try { fs.rmSync(t._adTemp, { force: true }); } catch (e) { /* ignore */ }
            t._adTemp = null;
        }
    }

    /** spawn ffmpeg 合成；withBsf=false 为重试（部分流不需要 aac_adtstoasc）。 */
    _spawn(task, withBsf) {
        // 临时名保留真实扩展名：ffmpeg 按扩展名推断容器格式，.part 后缀会导致
        // 「Unable to choose an output format」直接失败；完成后 rename 为终名
        const part = task._dest + '.incomplete' + path.extname(task._dest);
        const args = ['-hide_banner', '-y'];
        const hs = ffmpegHeaders(task.header);
        if (hs) args.push('-headers', hs);
        args.push('-i', (task._input || task.url), '-c', 'copy');
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
                this._cleanAdTemp(task);
                this.emit('completed', this._flatten(task));
                return;
            }
            try { fs.rmSync(part, { force: true }); } catch (e) { /* ignore */ }
            if (!task._retried) { task._retried = true; this._spawn(task, false); return; }
            task.status = 'error';
            task.errorMessage = '切片合成失败（源可能不可达或格式异常）';
            this._cleanAdTemp(task);
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
        this._cleanAdTemp(t);
        this._tasks.delete(gid);
        try { fs.rmSync(t._dest + '.incomplete' + path.extname(t._dest), { force: true }); } catch (e) { /* ignore */ }
        // 历史版本临时名，旧残留顺带清理
        try { fs.rmSync(t._dest + '.part', { force: true }); } catch (e) { /* ignore */ }
    }

    /** 清掉已停止的记录（complete/error/removed），与 aria2 purge 对应。 */
    clearStopped() {
        for (const [gid, t] of this._tasks) {
            if (['complete', 'error', 'removed'].includes(t.status)) {
                this._cleanAdTemp(t);
                this._tasks.delete(gid);
            }
        }
    }

    /** 清掉失败记录并兜底清理临时残留（正常失败路径 exit 回调已删，此处防漏）。返回条数。 */
    clearFailed() {
        let n = 0;
        for (const [gid, t] of this._tasks) {
            if (t.status !== 'error') continue;
            this._cleanAdTemp(t);
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
// 导出纯函数供单测（组件测试：tests/js/hls-filter.test.js）
module.exports.filterAdSegments = filterAdSegments;
module.exports.isAdUri = isAdUri;
