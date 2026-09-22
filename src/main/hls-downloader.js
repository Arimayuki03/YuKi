/**
 * hls-downloader.js — m3u8 切片流下载（分片并发 + ffmpeg 合并 / ffmpeg 顺序拉流兜底）
 *
 * aria2 无法处理 HLS 切片流，此处独立管理任务：
 * - add({url, out, header, concurrency})：concurrency > 1 时走分片并发模式
 *   （解析 m3u8 → 并行拉取各 .ts/.m4s 分片 → ffmpeg concat 合并），
 *   concurrency <= 1 或加密流/解析失败时回退 ffmpeg 顺序拉流模式；
 * - 任务级并发上限（maxActive，对应设置页「并发任务数」）：活跃任务达到上限时
 *   新任务进入 waiting 队列排队，任一任务终态后 FIFO 补位启动；
 * - AES-128 加密流（含 #EXT-X-KEY）自动回退 ffmpeg 模式（ffmpeg 自动解密）；
 * - 广告过滤（adFilter）复用 filterAdSegments，在解析阶段过滤广告分片；
 * - 任务状态结构与 aria2 flatten 对齐（kind:'hls' 供渲染层区分），
 *   由主进程 1s 轮询合并推送；完成/失败经 EventEmitter 通知。
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { findFfmpeg } = require('./ffmpeg');
const { proxyEnv, proxyFetch } = require('./system-proxy');
const { relUnderRoot } = require('./dl-layout');

const WIN = process.platform === 'win32';
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
        this.maxActive = 3;   // 同时进行的任务数上限（设置页「并发任务数」，index.js 同步）
        this._tasks = new Map(); // gid → task
        this._pending = [];      // 并发已满时排队的任务（FIFO，status 恒为 'waiting'）
        this._procs = new Set(); // 全部已 spawn 的 ffmpeg 子进程（退出时移除，供 cleanup 收敛孤儿）
        this._closing = false;   // cleanup() 置位：退出路径禁止 spawn/重试，防 exit 回调重生孤儿 ffmpeg
        // 任务进入终态（completed/error 事件）即释放并发槽位，补位启动排队任务
        this.on('completed', () => this._pump());
        this.on('error', () => this._pump());
        this.on('error', () => { }); // EventEmitter 兜底
    }

    setDir(dir) { this.dir = dir || path.join(os.homedir(), 'Downloads'); }

    /** 更换下载目录时迁移在途任务：杀掉活跃进程 → 成品/临时分片目录随迁 →
     *  更新任务路径并重新排队。分片并发模式重跑时跳过已存在分片（断点续传）；
     *  ffmpeg 顺序拉流模式无法续传，从头重下（分片模式是默认，concurrency>1）。
     *  已结束（complete/error）任务的成品文件同样随迁。
     *  同卷 rename 即时完成；跨盘（EXDEV）等 rename 不可达时改为 fs.promises
     *  后台分块拷贝（不冻结主进程），在途任务待拷贝 settle 后才重新入队。
     *  迁移期间再次调用 migrateDir 是合法的（用户来回换目录）：每轮持有唯一
     *  token，在途拷贝任务的挂起归属随之转移到新一轮，旧轮 gate 只放行
     *  token 仍归自己的任务，防止旧轮提前放行与新一轮后台拷贝竞态。 */
    migrateDir(newDir) {
        if (!newDir) return 0;
        const oldDir = this.dir; // 番剧子目录相对路径以旧引擎目录为基准，须先于 this.dir 覆盖捕获
        this.dir = newDir;
        // 本轮迁移唯一 token：任务挂起时记录归属，gate 回调只放行 token 仍归属
        // 本轮的任务——期间再次 migrateDir 会给任务换新 token，上一轮的 gate
        // 提前放行会让任务与第二轮仍在进行的后台拷贝读写同路径竞态。
        const roundToken = Symbol('migrate-round');
        try { fs.mkdirSync(newDir, { recursive: true }); } catch (e) { /* ignore */ }
        // Windows 下刚 kill 的 ffmpeg 句柄未必立即释放，紧随其后的 rename 会 EPERM/EBUSY：
        // 带短重试的 rename（总 ~1s），耗尽后仍失败则回落 move 的 copy 分支兜底
        const sleepSync = (ms) => {
            try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
            catch (e) { const end = Date.now() + ms; while (Date.now() < end) { /* 无 Atomics 时退化为自旋 */ } }
        };
        const renameWithRetry = (src, dest) => {
            const delays = [50, 100, 200, 300, 400];
            for (let i = 0; ; i++) {
                try { fs.renameSync(src, dest); return true; } catch (e) {
                    if (e && e.code === 'EXDEV') return false; // 跨盘：重试不可能成功，直接走异步拷贝回退
                    if (i >= delays.length) return false;
                    sleepSync(delays[i]); // 同步等待：migrateDir 同步段不引入异步语义
                }
            }
        };
        // 本轮调度到后台的异步拷贝（rename 不可达时逐个推入）。循环体同步执行，
        // 单个任务的全部 move 调用推入后，据此决定是否延迟重新入队（见循环尾部）。
        let taskMoves = [];
        const move = (src, dest, opts = {}) => {
            try {
                if (!fs.existsSync(src)) return false;
                if (opts.retry) {
                    if (renameWithRetry(src, dest)) return true;
                } else {
                    fs.renameSync(src, dest);
                    return true;
                }
            } catch (e) { /* 回落异步 copy 分支 */ }
            // 跨盘（EXDEV）等 rename 不可达时不再同步 cpSync/copyFileSync——GB 级视频
            // 会冻结主进程数分钟；改为 fs.promises 后台分块拷贝（libuv 线程池执行，
            // 事件循环不受阻），拷贝成功才删源、失败保留源文件（失败回退语义与原
            // 同步 copy 分支一致：数据不丢，仅迁移未完成，moved 计数为调度口径）。
            taskMoves.push(this._asyncMove(src, dest));
            return true;
        };
        /** 番剧子目录布局（RM-1）：产物相对旧引擎目录的路径原样带到新目录（保持两级
         *  结构）；相对路径异常（旧目录为空/产物在旧目录外）回退按 basename 平铺。 */
        const destFor = (oldDest) => {
            const rel = relUnderRoot(oldDir, oldDest);
            return rel ? path.join(newDir, rel) : path.join(newDir, path.basename(oldDest));
        };
        let moved = 0;
        const reruns = []; // 有异步拷贝的在途任务：待拷贝 settle 后再补延迟入队（见 _asyncMove 内）
        for (const t of this._tasks.values()) {
            taskMoves = []; // 每任务重置：当前任务推入的异步 move 集合
            const newDest = destFor(t._dest);
            try { fs.mkdirSync(path.dirname(newDest), { recursive: true }); } catch (e) { /* 异步拷贝同样依赖父目录存在 */ }
            const oldDest = t._dest;
            const finished = ['complete', 'error', 'removed'].includes(t.status);
            if (finished) {
                if (move(oldDest, newDest)) moved++;
                t._dest = newDest;
                t.dir = path.dirname(newDest); // RM-1：任务级目录随迁（含平铺回退时落新根目录）
                t.files = [newDest];
                continue;
            }
            // 在途：杀进程、停速度采样，移完文件再重新排队。代数 +1 让在飞的
            // 异步续体（ffmpeg exit 重试/分片 worker）自弃，不会回写旧目录
            t._gen = (t._gen || 0) + 1;
            if (t._proc) { try { t._proc.kill(); } catch (e) { /* ignore */ } t._proc = null; }
            if (t._speedTimer) { clearInterval(t._speedTimer); t._speedTimer = null; }
            if (move(oldDest, newDest, { retry: true })) moved++;
            move(oldDest + '.incomplete' + path.extname(oldDest), newDest + '.incomplete' + path.extname(newDest), { retry: true });
            // 广告过滤临时播放列表重启后会重新生成，直接清理
            if (t._adTemp) { try { fs.rmSync(t._adTemp, { force: true }); } catch (e) { /* ignore */ } }
            const newSegs = `${newDest}.${t.gid}.segs`;
            if (move(t._segsDir, newSegs, { retry: true })) moved++;
            t._dest = newDest;
            t._segsDir = newSegs;
            t.dir = path.dirname(newDest);
            t.files = [newDest];
            t._adTemp = null;
            t._input = null;
            t._retried = false;       // 重启后 copy/转码兜底重试额度复位
            t._transcodeRetried = false;
            t.speed = 0;
            // 本任务走了异步拷贝：保持原状态但挂起调度（_awaitingMove 门控），
            // 等拷贝 settle 后再入队——立即重跑会与后台拷贝读写同一路径竞态；
            // active 转 waiting 释放并发槽位（拷贝可能持续数分钟），paused 保持暂停。
            // 已在等待队列的先出队，防 _pump 在拷贝期间启动任务
            if (taskMoves.length) {
                if (t.status !== 'paused') t.status = 'waiting';
                this._pending = this._pending.filter((x) => x !== t);
                t._awaitingMove = true;
                t._awaitingMoveToken = roundToken; // 归属本轮：gate 只放行 token 仍匹配的任务
                reruns.push({ task: t, moves: taskMoves });
            } else if (t.status === 'paused') {
                continue; // 暂停状态保持不动（分片已随迁，继续时断点续传）
            } else if (t.status !== 'removed') {
                t.status = 'waiting';
                if (!this._pending.includes(t)) this._pending.push(t);
            }
        }
        this._pump();
        if (reruns.length) {
            // 延迟入队：本轮全部后台拷贝 settle 后统一放行（任务在此前不会被 _pump
            // 启动——不在 _pending 中；期间用户暂停/删除由下方状态检查收敛）。
            // 期间再次 migrateDir 会给任务挂新 token：本轮 gate 回调校验 token 归属，
            // 不再放行已被接管/暂停/删除的任务（避免与新一轮后台拷贝竞态）。
            const allMoves = reruns.flatMap((r) => r.moves);
            Promise.all(allMoves).then(() => {
                for (const { task: t } of reruns) {
                    if (t._awaitingMoveToken !== roundToken) continue; // 已被新一轮迁移接管：本轮无权放行
                    t._awaitingMoveToken = null;
                    t._awaitingMove = false;
                    if (t.status !== 'waiting') continue; // 期间被暂停/删除：保持现状
                    if (!this._pending.includes(t)) this._pending.push(t);
                }
                this._pump();
            }).catch(() => { /* _asyncMove 全捕获不 reject，兜底防未处理拒绝 */ });
        }
        return moved;
    }

    /** 跨盘迁移的异步分块拷贝：fs.promises 在 libuv 线程池执行，不阻塞主进程事件
     *  循环；按 4MiB 分块读写以控制单次内存占用（原同步 cpSync 会整段占内存）。
     *  成功后删除源；拷贝阶段失败保留源文件并 resolve false（迁移失败不抛、
     *  不删数据，重试语义交给上层重新迁移/任务重跑）。拷贝已完成后删源失败
     *  仅记日志：此时数据已完整落在新目录，catch 不再回头删 dest——否则删源
     *  一次抖动就把已拷出的成品/分片整体丢掉（两端都剩半空）。 */
    async _asyncMove(src, dest) {
        const CHUNK = 4 * 1024 * 1024;
        let srcFd = null;
        let destFd = null;
        let finished = false; // 拷贝（含子项递归）是否已完成：catch 据此决定是否删 dest
        try {
            const st = await fsp.stat(src);
            if (st.isDirectory()) {
                // 目录：递归逐项迁移（mkdir 保证层级，文件逐个走分块拷贝）
                await fsp.mkdir(dest, { recursive: true });
                const children = await fsp.readdir(src);
                let ok = true;
                for (const child of children) {
                    const r = await this._asyncMove(path.join(src, child), path.join(dest, child));
                    if (!r) ok = false;
                }
                if (ok) {
                    // 全部子项成功才删源；删源失败不算迁移失败——dest 已完整
                    finished = true;
                    try { await fsp.rm(src, { recursive: true, force: true }); } catch (e) { console.warn(`[hls] 迁移拷贝完成但删除源目录失败（保留源，不影响新目录）: ${src}`); }
                }
                return ok;
            }
            srcFd = await fsp.open(src, 'r');
            destFd = await fsp.open(dest, 'w');
            const buf = Buffer.allocUnsafe(CHUNK);
            let pos = 0;
            for (;;) {
                const { bytesRead } = await srcFd.read(buf, 0, CHUNK, pos);
                if (!bytesRead) break;
                await destFd.write(buf, 0, bytesRead, pos);
                pos += bytesRead; // 分块推进：让出微任务队列，事件循环可持续响应
            }
            await srcFd.close(); srcFd = null;
            await destFd.close(); destFd = null;
            finished = true; // 数据已完整写入 dest：此后任何失败都不得删 dest
            try { await fsp.rm(src, { force: true }); } catch (e) { console.warn(`[hls] 迁移拷贝完成但删除源文件失败（保留源，不影响新目录）: ${src}`); }
            return true;
        } catch (e) {
            // 拷贝阶段失败：半成品目标删除，源文件保留（不丢数据）；fd 泄漏防护。
            // finished=true 后进这里的只可能是删源失败（上面已兜底）等收尾抖动，
            // 绝不回头删已拷出的 dest。
            if (!finished) {
                try { if (destFd) await destFd.close(); } catch (e2) { /* ignore */ }
                try { await fsp.rm(dest, { force: true }); } catch (e2) { /* ignore */ }
            }
            return false;
        } finally {
            try { if (srcFd) await srcFd.close(); } catch (e2) { /* ignore */ }
            try { if (destFd) await destFd.close(); } catch (e2) { /* ignore */ }
        }
    }
    setConcurrency(n) { this.concurrency = Math.max(1, Math.min(32, n | 0)); }
    /** 调整同时进行的任务数上限（设置页「并发任务数」）；调大后立即补位启动排队任务。 */
    setMaxActive(n) {
        this.maxActive = Math.max(1, Math.min(10, n | 0));
        this._pump();
    }

    /** 暂停任务（page 源/m3u8 走此通道，此前无暂停能力导致「暂停不了」）：
     *  活跃任务杀进程并代数 +1 让在飞续体（分片 worker/ffmpeg exit 回调）自弃，
     *  分片目录与 .incomplete 保留供继续时断点续传；排队任务直接出队。
     *  返回是否暂停成功（任务存在且处于 active/waiting）。 */
    pause(gid) {
        const t = this._tasks.get(gid);
        if (!t || !['active', 'waiting'].includes(t.status)) return false;
        t._gen = (t._gen || 0) + 1;
        if (t._proc) { try { t._proc.kill(); } catch (e) { /* ignore */ } t._proc = null; }
        if (t._speedTimer) { clearInterval(t._speedTimer); t._speedTimer = null; }
        this._pending = this._pending.filter((x) => x !== t);
        t.status = 'paused';
        t.speed = 0;
        console.log(`[hls] ${t.name}: 已暂停（分片保留，可断点续传）`);
        this._pump(); // 释放的活跃槽位立即补位
        return true;
    }

    /** 继续暂停的任务：重新排队等待调度。分片并发模式复用已存在分片（断点续传）；
     *  ffmpeg 顺序拉流模式无法续传，从头重下（与 migrateDir 语义一致）。
     *  迁移后台拷贝未完成（_awaitingMove）时拒绝唤醒，避免与拷贝读写竞态。
     *  返回是否唤醒成功（任务存在且处于 paused）。 */
    unpause(gid) {
        const t = this._tasks.get(gid);
        if (!t || t.status !== 'paused' || t._awaitingMove) return false;
        t.status = 'waiting';
        t._retried = false;       // copy/转码兜底重试额度复位（同 migrateDir）
        t._transcodeRetried = false;
        t._adTemp = null;         // 广告过滤临时播放列表重新生成
        t._input = null;
        if (!this._pending.includes(t)) this._pending.push(t);
        this._pump();
        return true;
    }

    /** 暂停全部活跃/排队任务，返回暂停数量。 */
    pauseAll() {
        let n = 0;
        for (const t of [...this._tasks.values()]) {
            if (this.pause(t.gid)) n++;
        }
        return n;
    }

    /** 继续全部暂停中的任务（超并发的重新排队），返回唤醒数量。 */
    unpauseAll() {
        let n = 0;
        for (const t of [...this._tasks.values()]) {
            if (this.unpause(t.gid)) n++;
        }
        return n;
    }

    _activeCount() {
        let n = 0;
        for (const t of this._tasks.values()) if (t.status === 'active') n++;
        return n;
    }

    // ===== ffmpeg 进程登记与退出收敛 =====

    /** spawn ffmpeg 后登记（4 个 spawn 点共用）；exit/error 后自移除。 */
    _registerProc(proc) {
        if (!proc) return;
        this._procs.add(proc);
        if (typeof proc.once === 'function') {
            proc.once('exit', () => this._procs.delete(proc));
            proc.once('error', () => this._procs.delete(proc));
            proc.once('spawn', () => { if (proc.killed) this._procs.delete(proc); });
        }
    }

    /** 退出清理（M-8）：杀掉全部仍在运行的 ffmpeg 子进程，防止退出后 ffmpeg
     *  成孤儿继续下载/转码。Windows 下 child.kill() 只能杀单进程，与仓库内
     *  mpv/python 收敛一致，追加 taskkill /T /F 杀整棵进程树；先 taskkill 后
     *  proc.kill()——顺序反了会先杀死目标 PID，taskkill 落到已死的树上（status 128）。
     *  置位 _closing 后 _spawn/重试续体拒绝拉起新进程（否则 exit 回调会重生孤儿）。
     *  幂等（Set 迭代副本 + 逐个移除），可在退出路径重复调用。 */
    cleanup() {
        this._closing = true;
        if (!this._procs.size) return;
        const tracked = [...this._procs];
        for (const proc of tracked) {
            let alive = false;
            try { alive = proc.pid > 0 && !proc.killed && proc.exitCode === null && proc.signalCode === null; } catch (e) { alive = false; }
            if (!alive) { this._procs.delete(proc); continue; } // 已死/已上报退出：仅清登记
            this._procs.delete(proc);
            try {
                if (WIN) {
                    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
                    try { proc.kill(); } catch (e) { /* taskkill 已收敛整树；兜底不阻断退出流程 */ }
                } else {
                    proc.kill('SIGKILL');
                }
            } catch (e2) { /* 强杀失败不阻断退出流程 */ }
        }
    }

    /** 有空闲槽位时按 FIFO 启动等待中的任务（并发任务数设置的 HLS 侧执行点）。 */
    _pump() {
        while (this._pending.length && this._activeCount() < this.maxActive) {
            const task = this._pending.shift();
            if (!task || task.status !== 'waiting') continue; // 排队期间已被删除/清理
            task.status = 'active';
            console.log(`[hls] ${task.name}: 槽位空闲，开始下载`);
            if (task._segConc > 1) { task._mode = 'concurrent'; this._runConcurrent(task, task._segConc); }
            else { task._mode = 'ffmpeg'; this._run(task); }
        }
    }

    /** 新增任务；返回 gid。ffmpeg 缺失抛 Error('ffmpeg-missing')。
     *  concurrency > 1 时走分片并发模式（解析 m3u8 → 并行拉取分片 → ffmpeg 合并）；
     *  concurrency <= 1 或加密流/解析失败时回退 ffmpeg 顺序拉流模式。
     *  adFilter=true 时先过滤广告分段（CUE-OUT/CUE-IN + 广告路径特征）。
     *  dir 为任务级输出目录（RM-1 番剧子目录），缺省沿用引擎全局目录（向后兼容）。
     *  M-2：url 仅接受 http(s)，非 http(s)（file:// 等）直接拒绝。 */
    add({ url, out, header, adFilter, concurrency, dir }) {
        if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('bad url protocol');
        const bin = findFfmpeg();
        if (!bin) throw new Error('ffmpeg-missing');
        const gid = `hls-${++_seq}-${Date.now().toString(36)}`;
        const baseDir = dir || this.dir;
        fs.mkdirSync(baseDir, { recursive: true });
        // M-10：文件名须为纯文件名——sanitize 已去分隔符，再挡 '.'/'..'/空串等
        // 会 path.join 逃逸或指向目录本身的取值，非法一律回落默认名
        let name = (out || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
        if (!name || path.basename(name) !== name || name === '.' || name === '..') name = 'video.mp4';
        // 防御：无扩展名时补 .mp4，避免 ffmpeg 因无法推断格式而合成失败（边下边播等调用方漏传扩展名）
        if (!path.extname(name)) name += '.mp4';
        const dest = path.join(baseDir, name);
        // 同名并发防护：同 dest 已有活跃（active/waiting/paused）任务时直接复用返回
        // 其 gid——否则两个任务互覆盖 _dest 成品与 .adfilter.m3u8 临时播放列表
        // （后者文件名不含 gid，后写者清掉前者的输入）。复用不抛错：调用方多处
        // 未包 try/catch，与「已在下载→静默跳过」的 dlDedupe 语义一致；终态/已删除
        // 任务不拦截，照常新建（重新下载语义）。
        for (const t of this._tasks.values()) {
            if (t._dest === dest && !['complete', 'error', 'removed'].includes(t.status)) {
                console.log(`[hls] ${name}: 同名任务已在进行（${t.gid}），复用不重复下载`);
                return t.gid;
            }
        }
        const conc = Math.max(1, Math.min(32, parseInt(concurrency, 10) || 1));
        // 并发任务数已满则排队（waiting），任一活跃任务终态后由 _pump 补位启动
        const queued = this._activeCount() >= this.maxActive;
        const task = {
            gid, kind: 'hls', name, url, header: header || null, dir: baseDir,
            status: queued ? 'waiting' : 'active', percent: 0, done: 0, total: 0, speed: 0,
            errorMessage: '', files: [dest], _dest: dest, _bin: bin, _proc: null, _retried: false, _transcodeRetried: false,
            adFilter: !!adFilter, _adTemp: null, _input: null,
            _mode: 'ffmpeg', // 'concurrent' | 'ffmpeg'（分片并发 / ffmpeg 顺序拉流）
            _segConc: conc,  // 启动时按此分片并发数运行（排队期间暂存）
            _segsDir: `${dest}.${gid}.segs`, // 分片临时目录（M-10：带 gid，同名任务并发互不覆盖）
            _segments: null, _totalSegs: 0, _downloaded: 0, _segBytes: 0,
            _speedTimer: null, _speedLastBytes: 0, _speedLastTs: 0,
            _gen: 0, // 任务代数：目录迁移杀进程时 +1，旧的异步续体（ffmpeg exit 回调/分片 worker）据此自弃
        };
        this._tasks.set(gid, task);
        if (queued) {
            this._pending.push(task);
            console.log(`[hls] ${task.name}: 并发任务数已满（${this.maxActive}），进入等待队列`);
        } else if (conc > 1) {
            task._mode = 'concurrent';
            this._runConcurrent(task, conc);
        } else {
            this._run(task);
        }
        return gid;
    }

    async _run(task) {
        const gen = task._gen || 0;
        task.duration = await probeDuration(task.url, task.header);
        if (task.status === 'removed' || task._gen !== gen) return;
        if (task.adFilter) await this._applyAdFilter(task); // 过滤广告（失败静默走原地址）
        if (task.status === 'removed' || task._gen !== gen) return;
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

    /** 并发池下载分片到临时目录。单分片失败重试 2 次。
     *  P2-16：续传时校验已存在分片的完整性——状态里记录了每个分片下载后写入的
     *  字节数（task._segSizes[index]），期望字节数已知的分片按大小核对；期望大小
     *  未知（无记录/旧任务残留）的分片一律不信任、重新下载。崩溃/强杀/磁盘满
     *  残留的截断分片不再被静默复用进合成产物。正常暂停/恢复路径不受影响：
     *  完整写盘的分片大小有记录，继续时照常命中复用。 */
    async _downloadSegments(task, segments, concurrency) {
        const gen = task._gen || 0;
        const segsDir = task._segsDir;
        fs.mkdirSync(segsDir, { recursive: true });
        task._totalSegs = segments.length;
        task._downloaded = 0;
        task._segBytes = 0;
        // 每分片写入字节数（index → 字节）：本进程内写盘时记录；续传完整性校验依据
        if (!(task._segSizes instanceof Map)) task._segSizes = new Map();
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
                if (task.status === 'removed' || task._gen !== gen || failed) return;
                const seg = segments[idx++];
                const segFile = path.join(segsDir, `seg-${String(seg.index).padStart(6, '0')}.ts`);
                // 断点续传（目录迁移/进程重启恢复/暂停后继续）：已存在分片先按状态里
                // 记录的期望字节数校验完整性（P2-16）——大小吻合才计入进度跳过重拉；
                // 期望大小未知（无记录，如上次进程崩溃/强杀/磁盘满留下的截断分片）
                // 一律不信任，按未下载处理重新拉取。
                try {
                    if (fs.existsSync(segFile)) {
                        const expected = task._segSizes.get(seg.index);
                        if (Number.isFinite(expected) && expected > 0
                            && fs.statSync(segFile).size === expected) {
                            task._downloaded++;
                            task.percent = Math.min(99, Math.round(task._downloaded / task._totalSegs * 1000) / 10);
                            continue;
                        }
                    }
                } catch (e) { /* stat 失败按未下载处理 */ }
                let ok = false;
                for (let retry = 0; retry < 3 && !ok; retry++) {
                    if (task.status === 'removed' || task._gen !== gen || failed) return;
                    try {
                        const resp = await proxyFetch(seg.url, { headers, signal: AbortSignal.timeout(30000), redirect: 'follow' });
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        const buf = Buffer.from(await resp.arrayBuffer());
                        if (task.status === 'removed' || task._gen !== gen || failed) return; // 下载期间被取消/迁移
                        fs.writeFileSync(segFile, buf);
                        task._segSizes.set(seg.index, buf.length); // 记录期望字节数（续传完整性校验依据，P2-16）
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
        // 必须 finally：任一 worker 抛出（分片重试耗尽）时 Promise.all 直接 reject，
        // 原本写在 await 之后的清理会被整段跳过，留下一个每秒空转并锁住已废弃 task
        // 闭包的定时器——外层 catch 里只有 status==='removed' 才走 _cleanSegsDir 兜底，
        // 暂停/目录迁移（_gen 变化）路径下它就是永久泄漏。
        try {
            await Promise.all(workers);
        } finally {
            // 下载完毕后立即停止速度定时器（合并阶段不再有下载速度）
            if (task._speedTimer) { clearInterval(task._speedTimer); task._speedTimer = null; }
            task.speed = 0;
        }
    }

    /** 用 ffmpeg concat demuxer 合并分片为最终文件。withBsf=false 为重试（部分流不需要 aac_adtstoasc）。 */
    async _concatSegments(task, segments, withBsf = true) {
        if (this._closing) throw new Error('closing'); // 退出清理后拒绝拉起/重试（按失败收敛，不重生 ffmpeg）
        const gen = task._gen || 0;
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
            const proc = spawn(task._bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...proxyEnv() }, windowsHide: true });
            task._proc = proc;
            this._registerProc(proc);
            let errBuf = '';
            proc.stderr.on('data', (chunk) => { errBuf += chunk.toString(); });
            proc.on('exit', (code) => {
                task._proc = null;
                if (task._gen !== gen) return reject(new Error('migrating')); // 目录迁移杀进程：不自弃会按旧路径重试/报错
                if (task.status === 'removed') return reject(new Error('removed')); // 已删除：不再进重试链 spawn 注定失败的 ffmpeg
                if (code === 0 && fs.existsSync(part)) {
                    try { fs.rmSync(task._dest, { force: true }); } catch (e) { /* ignore */ }
                    try {
                        fs.renameSync(part, task._dest);
                    } catch (e) {
                        // Windows 目标被占用（播放器在播旧文件）/保留设备名时 EPERM：
                        // 保留 .incomplete 供后续重试，按错误终态收敛（回退 ffmpeg 重下也不会好）
                        task.status = 'error';
                        task.errorMessage = '成品落盘失败（目标文件可能被占用）';
                        this._cleanAdTemp(task);
                        this.emit('error', this._flatten(task));
                        return reject(new Error(`成品落盘失败: ${e.message}`));
                    }
                    resolve();
                } else if (withBsf) {
                    // aac_adtstoasc 对 fMP4/m4s 流会失败，去掉 bsf 重试
                    this._concatSegments(task, segments, false).then(resolve, reject);
                } else {
                    // copy 均失败时尝试转码兜底（兼容封装/编码异常的切片）
                    this._concatTranscode(task, segments).then(resolve, (e) => reject(new Error(`ffmpeg 合并失败 (code=${code}): ${errBuf.slice(-500)}; 转码也失败: ${e.message}`)));
                }
            });
            proc.on('error', () => { task._proc = null; reject(new Error('ffmpeg 启动失败')); });
        });
    }

    /** 转码兜底合并（copy 失败后以重编码方式重试） */
    _concatTranscode(task, segments) {
        if (this._closing) return Promise.reject(new Error('closing')); // 退出清理后拒绝拉起
        const gen = task._gen || 0;
        const segsDir = task._segsDir;
        const part = task._dest + '.incomplete' + path.extname(task._dest);
        const listFile = path.join(segsDir, 'concat.txt');
        return new Promise((resolve, reject) => {
            const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', part];
            const proc = spawn(task._bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...proxyEnv() }, windowsHide: true });
            task._proc = proc;
            this._registerProc(proc);
            let errBuf = '';
            proc.stderr.on('data', (chunk) => { errBuf += chunk.toString(); });
            proc.on('exit', (code) => {
                task._proc = null;
                if (task._gen !== gen) return reject(new Error('migrating')); // 目录迁移杀进程：旧续体自弃
                if (task.status === 'removed') return reject(new Error('removed')); // 已删除：不再进报错链
                if (code === 0 && fs.existsSync(part)) {
                    try { fs.rmSync(task._dest, { force: true }); } catch (e) { /* ignore */ }
                    try {
                        fs.renameSync(part, task._dest);
                    } catch (e) {
                        // 同 _concatSegments：rename 失败保留 .incomplete，按错误终态收敛
                        task.status = 'error';
                        task.errorMessage = '成品落盘失败（目标文件可能被占用）';
                        this._cleanAdTemp(task);
                        this.emit('error', this._flatten(task));
                        return reject(new Error(`成品落盘失败: ${e.message}`));
                    }
                    resolve();
                } else {
                    reject(new Error(`ffmpeg 转码合并失败 (code=${code}): ${errBuf.slice(-500)}`));
                }
            });
            proc.on('error', () => { task._proc = null; reject(new Error('ffmpeg 启动失败')); });
        });
    }

    /** 分片并发模式主流程：解析 → 下载 → 合并 → 清理。加密流/解析失败时回退 ffmpeg 模式。 */
    async _runConcurrent(task, concurrency) {
        const gen = task._gen || 0;
        // 迁移（gen 变化）后旧续体直接退出且不清理分片目录（随迁续传的载体）；
        // removed 则按原语义清理临时产物
        const dead = () => task.status === 'removed' || task._gen !== gen;
        try {
            // 1. 解析播放列表
            const { segments, isEncrypted, totalDuration } = await this._parsePlaylist(task.url, task.header, task.adFilter);
            if (dead()) { if (task.status === 'removed') this._cleanSegsDir(task); return; }
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
            if (dead()) { if (task.status === 'removed') this._cleanSegsDir(task); return; }
            // 3. 合并分片
            await this._concatSegments(task, segments);
            if (dead()) { if (task.status === 'removed') { this._cleanSegsDir(task); this._cleanAdTemp(task); } return; }
            // 4. 成功
            task.status = 'complete';
            task.percent = 100;
            task.speed = 0;
            this._cleanSegsDir(task);
            this._cleanAdTemp(task);
            this.emit('completed', this._flatten(task));
        } catch (e) {
            if (dead()) { if (task.status === 'removed') this._cleanSegsDir(task); return; }
            // 合并落盘失败（rename EPERM 等）已在 _concatSegments 内按错误终态收敛：
            // 回退 ffmpeg 重下也躲不开同一目标路径，直接停在这里
            if (task.status === 'error') return;
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
        if (this._closing) return; // 退出清理后拒绝拉起（exit 回调重试会重生孤儿 ffmpeg）
        const gen = task._gen || 0;
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
        const proc = spawn(task._bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...proxyEnv() }, windowsHide: true });
        task._proc = proc;
        this._registerProc(proc);
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
            // 目录迁移杀进程：旧续体自弃，不按旧路径重试/报错（新代数续体已由 _pump 重启）
            if (task._gen !== gen) return;
            if (task.status === 'removed') return;
            if (code === 0 && fs.existsSync(part)) {
                try { fs.rmSync(task._dest, { force: true }); } catch (e) { /* ignore */ }
                try {
                    fs.renameSync(part, task._dest);
                } catch (e) {
                    // Windows 目标被占用（播放器在播旧文件）/保留设备名时 EPERM：
                    // 保留 .incomplete 供后续重试，按错误终态收敛（不再走重试链）
                    task.status = 'error';
                    task.errorMessage = '成品落盘失败（目标文件可能被占用）';
                    this._cleanAdTemp(task);
                    this.emit('error', this._flatten(task));
                    return;
                }
                task.status = 'complete';
                task.percent = 100;
                this._cleanAdTemp(task);
                this.emit('completed', this._flatten(task));
                return;
            }
            try { fs.rmSync(part, { force: true }); } catch (e) { /* ignore */ }
            if (!task._retried) { task._retried = true; this._spawn(task, false); return; }
            // 格式异常兜底：-c copy 失败后尝试转码（兼容非标准封装/编码，避免直接报“格式异常”）
            if (!task._transcodeRetried) {
                task._transcodeRetried = true;
                this._spawnTranscode(task);
                return;
            }
            task.status = 'error';
            task.errorMessage = '切片合成失败（源可能不可达或格式异常）';
            this._cleanAdTemp(task);
            this.emit('error', this._flatten(task));
        });
        proc.on('error', () => {
            if (task._gen !== gen) return;
            task.status = 'error';
            task.errorMessage = 'ffmpeg 启动失败';
            this._cleanAdTemp(task);
            this.emit('error', this._flatten(task));
        });
    }

    /** 转码兜底：copy 失败时以重编码方式重试，兼容封装/编码异常的源 */
    _spawnTranscode(task) {
        if (this._closing) return; // 退出清理后拒绝拉起（exit 回调重试会重生孤儿 ffmpeg）
        const gen = task._gen || 0;
        const part = task._dest + '.incomplete' + path.extname(task._dest);
        const args = ['-hide_banner', '-y'];
        const hs = ffmpegHeaders(task.header);
        if (hs) args.push('-headers', hs);
        // 转码模式（不使用 -c copy），兼容格式异常的流
        args.push('-i', (task._input || task.url), '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart', part);
        task.speed = 0;
        task._lastProgressTime = null;
        task._lastProgressBytes = null;
        task._progressBuffer = '';
        const proc = spawn(task._bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...proxyEnv() }, windowsHide: true });
        task._proc = proc;
        this._registerProc(proc);
        let errBuf = '';
        proc.stderr.on('data', (chunk) => {
            errBuf += chunk.toString();
            const lines = (task._progressBuffer + chunk.toString()).split(/\r\n|\n|\r/);
            task._progressBuffer = lines.pop() || '';
            for (const line of lines) {
                const m = line.match(/(?=.*time=(\d+):(\d+):([\d.]+))(?=.*size=\s*([\d.]+)\s*([kKmMgG](?:[iI])?B|B))/);
                if (!m) continue;
                const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
                if (Number.isFinite(t) && task.duration > 0) {
                    task.percent = Math.max(task.percent, Math.min(99.9, Math.round(t / task.duration * 1000) / 10));
                }
            }
        });
        proc.on('exit', (code) => {
            task._proc = null;
            if (task.status === 'removed' || task._gen !== gen) return;
            if (code === 0 && fs.existsSync(part)) {
                try { fs.rmSync(task._dest, { force: true }); } catch (e) { /* ignore */ }
                try {
                    fs.renameSync(part, task._dest);
                } catch (e) {
                    // Windows 目标被占用（播放器在播旧文件）/保留设备名时 EPERM：
                    // 保留 .incomplete 供后续重试，按错误终态收敛（不再走重试链）
                    task.status = 'error';
                    task.errorMessage = '成品落盘失败（目标文件可能被占用）';
                    this._cleanAdTemp(task);
                    this.emit('error', this._flatten(task));
                    return;
                }
                task.status = 'complete';
                task.percent = 100;
                this._cleanAdTemp(task);
                this.emit('completed', this._flatten(task));
                return;
            }
            try { fs.rmSync(part, { force: true }); } catch (e) { /* ignore */ }
            task.status = 'error';
            // 保留最后错误片段便于定位，但仍展示友好提示
            console.warn(`[hls] ${task.name}: 转码兜底也失败: ${errBuf.slice(-500)}`);
            task.errorMessage = '切片合成失败（源可能不可达或格式异常）';
            this._cleanAdTemp(task);
            this.emit('error', this._flatten(task));
        });
        proc.on('error', () => {
            if (task._gen !== gen) return;
            task.status = 'error';
            task.errorMessage = 'ffmpeg 启动失败';
            this._cleanAdTemp(task);
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
        // 排队中的任务直接出队，避免残留引用被 _pump 误启动
        this._pending = this._pending.filter((x) => x !== t);
        try { fs.rmSync(t._dest + '.incomplete' + path.extname(t._dest), { force: true }); } catch (e) { /* ignore */ }
        // 历史版本临时名，旧残留顺带清理
        try { fs.rmSync(t._dest + '.part', { force: true }); } catch (e) { /* ignore */ }
        this._pump(); // 活跃/排队槽位变化，立即补位
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
            header: t.header || null, // L-8:Referer/UA 随任务输出，供持久化恢复
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
