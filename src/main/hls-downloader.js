/**
 * hls-downloader.js — m3u8 切片流下载（分片并发 + ffmpeg 合并 / ffmpeg 顺序拉流兜底）
 *
 * aria2 无法处理 HLS 切片流，此处独立管理任务：
 * - add({url, out, header, concurrency})：concurrency > 1 时走分片并发模式
 *   （解析 m3u8 → 并行拉取各 .ts/.m4s 分片 → ffmpeg concat 合并），
 *   concurrency <= 1 或加密流/解析失败时回退 ffmpeg 顺序拉流模式；
 * - AES-128 加密流（含 #EXT-X-KEY）自动回退 ffmpeg 模式（ffmpeg 自动解密）；
 * - 广告过滤（adFilter）复用 filterAdSegments，在解析阶段过滤广告分片；
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
        this.concurrency = 5; // 分片并发数（设置页可调，index.js 传入）
        this._tasks = new Map(); // gid → task
        this.on('error', () => { }); // EventEmitter 兜底
    }

    setDir(dir) { this.dir = dir || path.join(os.homedir(), 'Downloads'); }
    setConcurrency(n) { this.concurrency = Math.max(1, Math.min(32, n | 0)); }

    /** 新增任务；返回 gid。ffmpeg 缺失抛 Error('ffmpeg-missing')。
     *  concurrency > 1 时走分片并发模式（解析 m3u8 → 并行拉取分片 → ffmpeg 合并）；
     *  concurrency <= 1 或加密流/解析失败时回退 ffmpeg 顺序拉流模式。
     *  adFilter=true 时先过滤广告分段（CUE-OUT/CUE-IN + 广告路径特征）。 */
    add({ url, out, header, adFilter, concurrency }) {
        const bin = findFfmpeg();
        if (!bin) throw new Error('ffmpeg-missing');
        const gid = `hls-${++_seq}-${Date.now().toString(36)}`;
        fs.mkdirSync(this.dir, { recursive: true });
        const name = (out || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
        const dest = path.join(this.dir, name);
        const conc = Math.max(1, Math.min(32, parseInt(concurrency, 10) || 1));
        const task = {
            gid, kind: 'hls', name, url, header: header || null,
            status: 'active', percent: 0, done: 0, total: 0, speed: 0,
            errorMessage: '', files: [dest], _dest: dest, _bin: bin, _proc: null, _retried: false,
            adFilter: !!adFilter, _adTemp: null, _input: null,
            _mode: 'ffmpeg', // 'concurrent' | 'ffmpeg'（分片并发 / ffmpeg 顺序拉流）
            _segsDir: dest + '.segs', // 分片临时目录
            _segments: null, _totalSegs: 0, _downloaded: 0, _segBytes: 0,
            _speedTimer: null, _speedLastBytes: 0, _speedLastTs: 0,
        };
        this._tasks.set(gid, task);
        if (conc > 1) {
            task._mode = 'concurrent';
            this._runConcurrent(task, conc);
        } else {
            this._run(task);
        }
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

    /** 清理分片临时目录（任务结束/删除/失败时）。 */
    _cleanSegsDir(t) {
        if (t && t._segsDir) {
            try { fs.rmSync(t._segsDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        }
        if (t && t._speedTimer) { clearInterval(t._speedTimer); t._speedTimer = null; }
    }

    // ===== 分片并发模式 =====

    /** 解析 m3u8 播放列表，提取分片 URL 列表。返回 {segments, isEncrypted, totalDuration}。
     *  master 播放列表自动选最高码率变体；广告过滤复用 filterAdSegments。 */
    async _parsePlaylist(url, header, adFilter) {
        const headers = { 'User-Agent': 'Mozilla/5.0', ...(header || {}) };
        let plUrl = url;
        let text = await (await proxyFetch(plUrl, { headers, signal: AbortSignal.timeout(15000), redirect: 'follow' })).text();
        // master 播放列表 → 选最高码率变体
        if (text.includes('#EXT-X-STREAM-INF')) {
            let best = null, bestBw = -1;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const m = lines[i].match(/^#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/);
                if (m && lines[i + 1] && !lines[i + 1].startsWith('#')) {
                    const bw = parseInt(m[1], 10);
                    if (bw > bestBw) { bestBw = bw; best = lines[i + 1].trim(); }
                }
            }
            if (!best) throw new Error('no variant in master playlist');
            plUrl = new URL(best, url).href;
            text = await (await proxyFetch(plUrl, { headers, signal: AbortSignal.timeout(15000), redirect: 'follow' })).text();
        }
        // 广告过滤
        if (adFilter) {
            const { filtered, removed } = filterAdSegments(text, plUrl);
            if (removed > 0) text = filtered;
        }
        // 解析分片
        const segments = [];
        let isEncrypted = false;
        let totalDuration = 0;
        let pendingInf = null;
        const abs = (uri) => { try { return new URL(uri, plUrl).href; } catch (e) { return uri; } };
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            if (/^#EXT-X-KEY:/i.test(line)) { isEncrypted = true; continue; }
            if (/^#EXTINF:([\d.]+)/.test(line)) {
                const m = line.match(/^#EXTINF:([\d.]+)/);
                pendingInf = m ? parseFloat(m[1]) : 0;
                continue;
            }
            if (line.startsWith('#')) continue;
            // 分片 URL
            const segUrl = abs(line);
            segments.push({ url: segUrl, index: segments.length, duration: pendingInf || 0 });
            totalDuration += pendingInf || 0;
            pendingInf = null;
        }
        if (!segments.length) throw new Error('no segments in playlist');
        return { segments, isEncrypted, totalDuration };
    }

    /** 并发池下载分片到临时目录。单分片失败重试 2 次。 */
    async _downloadSegments(task, segments, concurrency) {
        const segsDir = task._segsDir;
        fs.mkdirSync(segsDir, { recursive: true });
        task._totalSegs = segments.length;
        task._downloaded = 0;
        task._segBytes = 0;
        const headers = { 'User-Agent': 'Mozilla/5.0', ...(task.header || {}) };
        // 速度计算定时器（1s 采样）
        task._speedLastBytes = 0;
        task._speedLastTs = Date.now();
        task._speedTimer = setInterval(() => {
            const now = Date.now();
            const elapsed = (now - task._speedLastTs) / 1000;
            if (elapsed > 0) {
                task.speed = Math.max(0, (task._segBytes - task._speedLastBytes) / elapsed);
                task._speedLastBytes = task._segBytes;
                task._speedLastTs = now;
            }
        }, 1000);
        // 并发池
        let idx = 0;
        let failed = false; // 任一 worker 失败即置位，其余 worker 检测后退出
        const downloadOne = async () => {
            while (idx < segments.length) {
                if (task.status === 'removed' || failed) return;
                const seg = segments[idx++];
                const segFile = path.join(segsDir, `seg-${String(seg.index).padStart(6, '0')}.ts`);
                let ok = false;
                for (let retry = 0; retry < 3 && !ok; retry++) {
                    if (task.status === 'removed' || failed) return;
                    try {
                        const resp = await proxyFetch(seg.url, { headers, signal: AbortSignal.timeout(30000), redirect: 'follow' });
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        const buf = Buffer.from(await resp.arrayBuffer());
                        if (task.status === 'removed' || failed) return; // 下载期间被取消
                        fs.writeFileSync(segFile, buf);
                        task._segBytes += buf.length;
                        ok = true;
                    } catch (e) {
                        if (task.status === 'removed' || failed) return;
                        if (retry < 2) await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
                        else { failed = true; throw new Error(`分片 ${seg.index + 1} 下载失败: ${e.message}`); }
                    }
                }
                task._downloaded++;
                task.percent = Math.min(99, Math.round(task._downloaded / task._totalSegs * 1000) / 10);
            }
        };
        const workers = Array.from({ length: Math.min(concurrency, segments.length) }, () => downloadOne());
        await Promise.all(workers);
        // 下载完毕后立即停止速度定时器（合并阶段不再有下载速度）
        if (task._speedTimer) { clearInterval(task._speedTimer); task._speedTimer = null; }
        task.speed = 0;
    }

    /** 用 ffmpeg concat demuxer 合并分片为最终文件。withBsf=false 为重试（部分流不需要 aac_adtstoasc）。 */
    async _concatSegments(task, segments, withBsf = true) {
        const segsDir = task._segsDir;
        const part = task._dest + '.incomplete' + path.extname(task._dest);
        // 生成 concat 列表文件（ffmpeg concat demuxer 要求正斜杠路径，Windows 反斜杠会被当转义符）
        const listFile = path.join(segsDir, 'concat.txt');
        const lines = segments.map((seg) => {
            const segFile = path.join(segsDir, `seg-${String(seg.index).padStart(6, '0')}.ts`);
            const p = segFile.split(path.sep).join('/').replace(/'/g, "'\\''");
            return `file '${p}'`;
        });
        fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
        // spawn ffmpeg 合并
        return new Promise((resolve, reject) => {
            const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy'];
            if (withBsf) args.push('-bsf:a', 'aac_adtstoasc');
            args.push(part);
            const proc = spawn(task._bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...proxyEnv() } });
            task._proc = proc;
            let errBuf = '';
            proc.stderr.on('data', (chunk) => { errBuf += chunk.toString(); });
            proc.on('exit', (code) => {
                task._proc = null;
                if (code === 0 && fs.existsSync(part)) {
                    try { fs.rmSync(task._dest, { force: true }); } catch (e) { /* ignore */ }
                    fs.renameSync(part, task._dest);
                    resolve();
                } else if (withBsf) {
                    // aac_adtstoasc 对 fMP4/m4s 流会失败，去掉 bsf 重试
                    this._concatSegments(task, segments, false).then(resolve, reject);
                } else {
                    reject(new Error(`ffmpeg 合并失败 (code=${code}): ${errBuf.slice(-500)}`));
                }
            });
            proc.on('error', () => { task._proc = null; reject(new Error('ffmpeg 启动失败')); });
        });
    }

    /** 分片并发模式主流程：解析 → 下载 → 合并 → 清理。加密流/解析失败时回退 ffmpeg 模式。 */
    async _runConcurrent(task, concurrency) {
        try {
            // 1. 解析播放列表
            const { segments, isEncrypted, totalDuration } = await this._parsePlaylist(task.url, task.header, task.adFilter);
            if (task.status === 'removed') { this._cleanSegsDir(task); return; }
            // 加密流回退 ffmpeg 模式（JS 层解密复杂且易出错，ffmpeg 自动解密）
            if (isEncrypted) {
                console.log(`[hls] ${task.name}: 加密流，回退 ffmpeg 模式`);
                task._mode = 'ffmpeg';
                task.duration = totalDuration;
                this._cleanSegsDir(task);
                this._spawn(task, true);
                return;
            }
            task._segments = segments;
            task.duration = totalDuration;
            console.log(`[hls] ${task.name}: 分片并发模式，${segments.length} 个分片，并发 ${concurrency}`);
            // 2. 并发下载分片
            await this._downloadSegments(task, segments, concurrency);
            if (task.status === 'removed') { this._cleanSegsDir(task); return; }
            // 3. 合并分片
            await this._concatSegments(task, segments);
            if (task.status === 'removed') { this._cleanSegsDir(task); this._cleanAdTemp(task); return; }
            // 4. 成功
            task.status = 'complete';
            task.percent = 100;
            task.speed = 0;
            this._cleanSegsDir(task);
            this._cleanAdTemp(task);
            this.emit('completed', this._flatten(task));
        } catch (e) {
            if (task.status === 'removed') { this._cleanSegsDir(task); return; }
            console.warn(`[hls] ${task.name}: 分片并发失败，回退 ffmpeg 模式: ${e.message}`);
            // 清理分片临时目录
            this._cleanSegsDir(task);
            task._mode = 'ffmpeg';
            // 回退 ffmpeg 模式（不走 adFilter 二次解析，直接用原始 URL）
            task.adFilter = false;
            this._spawn(task, true);
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
        task.speed = 0;
        task._lastProgressTime = null;
        task._lastProgressBytes = null;
        task._progressBuffer = '';
        // ffmpeg 不读系统代理：经环境变量注入（直连不可达的环境下必需）
        const proc = spawn(task._bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...proxyEnv() } });
        task._proc = proc;
        proc.stderr.on('data', (chunk) => {
            // ffmpeg 进度行 "size=123kB time=00:12:34.56" → 按时间差分估算速度
            const lines = (task._progressBuffer + chunk.toString()).split(/\r\n|\n|\r/);
            task._progressBuffer = lines.pop() || '';
            for (const line of lines) {
                const m = line.match(/(?=.*time=(\d+):(\d+):([\d.]+))(?=.*size=\s*([\d.]+)\s*([kKmMgG](?:[iI])?B|B))/);
                if (!m) {
                    if (/time=/.test(line)) {
                        task.speed = 0;
                        task._lastProgressTime = null;
                        task._lastProgressBytes = null;
                    }
                    continue;
                }
                const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
                if (Number.isFinite(t) && task.duration > 0) {
                    task.percent = Math.max(task.percent, Math.min(99.9, Math.round(t / task.duration * 1000) / 10));
                }
                const unit = m[5].toLowerCase().replace('i', '');
                const multiplier = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit];
                const sizeBytes = Number(m[4]) * multiplier;
                if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || !Number.isFinite(t)) {
                    task.speed = 0;
                    task._lastProgressTime = null;
                    task._lastProgressBytes = null;
                    continue;
                }
                const previousTime = task._lastProgressTime;
                const previousBytes = task._lastProgressBytes;
                const elapsed = t - previousTime;
                const delta = sizeBytes - previousBytes;
                task.speed = Number.isFinite(previousTime) && Number.isFinite(previousBytes)
                    && Number.isFinite(elapsed) && elapsed > 0 && Number.isFinite(delta) && delta >= 0
                    ? delta / elapsed : 0;
                task._lastProgressTime = t;
                task._lastProgressBytes = sizeBytes;
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
        this._cleanSegsDir(t);
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
                this._cleanSegsDir(t);
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
            this._cleanSegsDir(t);
            this._tasks.delete(gid);
            try { fs.rmSync(t._dest + '.incomplete' + path.extname(t._dest), { force: true }); } catch (e) { /* ignore */ }
            try { fs.rmSync(t._dest + '.part', { force: true }); } catch (e) { /* ignore */ }
            n++;
        }
        return n;
    }

    _flatten(t) {
        const total = t._mode === 'concurrent' ? (t._totalSegs || 0) : 0;
        const done = t._mode === 'concurrent' ? (t._downloaded || 0) : 0;
        return {
            gid: t.gid, kind: 'hls', status: t.status, name: t.name,
            total, done, percent: t.percent,
            speed: t.status === 'active' && Number.isFinite(t.speed) && t.speed > 0 ? t.speed : 0, connections: t._mode === 'concurrent' ? `${done}/${total}` : '',
            errorMessage: t.errorMessage, files: t.files,
            uri: t.url || '', // 原始 URL，用于重启后恢复下载
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
