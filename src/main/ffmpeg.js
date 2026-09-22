/**
 * ffmpeg.js — ffmpeg 二进制管理（探测 / 启动自动下载 / 缩略图抓帧）
 *
 * 用途：
 * - m3u8 切片流下载合成（hls-downloader.js 调用）
 * - 本地文件视频预览图抓帧（主进程 yuki:file-thumb）
 *
 * 二进制来源：<repo>/vendor/ffmpeg/ffmpeg.exe → PATH；
 * 缺失时 ensureFfmpeg() 后台下载 BtbN/FFmpeg-Builds 官方构建（约 190MB，zip 经系统 tar 解压）。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

// 打包后 extraResources 放在 resources/，vendor 从该处读取
const ROOT = (() => {
    try {
        const { app } = require('electron');
        return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
    } catch (e) { return path.join(__dirname, '..', '..'); }
})();
const WIN = process.platform === 'win32';
// 二进制来源与哈希一律以 scripts/binaries.lock.json 的 ffmpeg 段为准（构建期已锁定版本化
// 不可变包 URL）。运行时自动下载同样强制校验，防止上游/CDN 被篡改后把恶意 exe 落到用户机器。
// 二进制来源与哈希一律以 scripts/binaries.lock.json 的 ffmpeg 段为准（构建期已锁定
// BtbN/FFmpeg-Builds 版本化资产 URL）。运行时自动下载同样强制校验，防止上游/CDN
// 被篡改后把恶意 exe 落到用户机器。
// 原锁定源 gyan.dev 的 packages/ 版本化包已从服务器移除（HTTP 404），2026-09-22 迁移至
// BtbN/FFmpeg-Builds；此处常量仅作 lock 缺失时的兜底。
const FFMPEG_URL_FALLBACK = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-gpl-9.0.zip';

/** 读取 binaries.lock.json 的 ffmpeg 段；找不到或解析失败返回 null（调用方据此拒绝下载）。 */
function ffmpegLock() {
    const candidates = [];
    try {
        const { app } = require('electron');
        if (app && typeof app.getAppPath === 'function') {
            candidates.push(path.join(app.getAppPath(), 'scripts', 'binaries.lock.json'));
        }
    } catch (e) { /* 非 Electron 环境（单测） */ }
    candidates.push(path.join(__dirname, '..', '..', 'scripts', 'binaries.lock.json'));
    for (const p of candidates) {
        try {
            if (!fs.existsSync(p)) continue;
            const lock = JSON.parse(fs.readFileSync(p, 'utf8'));
            const f = lock && lock.ffmpeg;
            if (f && f.url && f.sha256) return f;
        } catch (e) { /* 尝试下一个候选路径 */ }
    }
    return null;
}

/** 流式 sha256（避免把 ~110MB 读进内存）。 */
function sha256File(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const rs = fs.createReadStream(p);
        rs.on('error', reject);
        h.once('error', reject);
        rs.on('data', (c) => h.update(c));
        rs.on('end', () => resolve(h.digest('hex')));
    });
}

/** vendor 内置 → PATH 探测；找不到返回 null。 */
function findFfmpeg() {
    const exe = WIN ? 'ffmpeg.exe' : 'ffmpeg';
    const vendor = path.join(ROOT, 'vendor', 'ffmpeg', exe);
    if (fs.existsSync(vendor)) return vendor;
    try {
        if (WIN) {
            const out = execSync('where ffmpeg', { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
            const first = out.split(/\r?\n/)[0];
            if (first) return first;
        } else {
            const out = execSync('command -v ffmpeg', { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
            if (out) return out;
        }
    } catch (e) { /* 不在 PATH */ }
    return null;
}

// 下载总超时：约 190MB 的 zip 在慢网下也要留足余量，10 分钟足够；
// 断连后请求停摆时兜底失败，promise 不至永挂。
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** 带重定向跟随的下载（写入 dest）。error/aborted/超时均 reject，settled 防双重回调。 */
function downloadFile(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('too many redirects'));
        let settled = false;
        let timer = null;
        let rsp = null;   // 响应流：失败时销毁（见 fail），断连后 socket 不悬挂
        let file = null;  // 写盘流：失败时销毁，释放 dest 文件句柄（Windows 句柄锁）
        const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
        const fail = (err) => {
            if (settled) return;
            settled = true;
            clearTimer();
            // 失败路径必须主动销毁在途资源：不销毁时 190MB 下载的 socket/写盘流
            // 会继续占住句柄——下载无法真正取消，Windows 下 stage 目录因句柄
            // 未释放而删不掉半截 zip，ensureFfmpeg 收尾的 rmSync 静默失败留垃圾。
            try { req.destroy(); } catch (e) { /* 尚未创建/已销毁 */ }
            try { rsp.destroy(); } catch (e) { /* 尚未收到响应 */ }
            try { if (file) file.destroy(); } catch (e) { /* 尚未打开 */ }
            reject(err);
        };
        const ok = (val) => {
            if (settled) return;
            settled = true;
            clearTimer();
            resolve(val);
        };
        timer = setTimeout(() => fail(new Error(`download timeout (${DOWNLOAD_TIMEOUT_MS / 60000} min)`)), DOWNLOAD_TIMEOUT_MS);
        const req = https.get(url, { headers: { 'User-Agent': 'yuki' } }, (r) => {
            rsp = r;
            if ([301, 302, 303, 307, 308].includes(rsp.statusCode)) {
                rsp.resume();
                return ok(downloadFile(rsp.headers.location, dest, redirects + 1));
            }
            if (rsp.statusCode !== 200) {
                rsp.resume();
                return fail(new Error(`HTTP ${rsp.statusCode}`));
            }
            // 响应中途断连/中止：reject 而非等待停摆（半截 zip 会在 sha256 校验处被拒）
            rsp.on('error', fail);
            rsp.on('aborted', () => fail(new Error('download aborted')));
            file = fs.createWriteStream(dest);
            rsp.pipe(file);
            file.on('finish', () => { file.close(); ok(dest); });
            file.on('error', fail);
        });
        req.on('error', fail);
    });
}

function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { const r = findFile(p, name); if (r) return r; }
        else if (entry.name === name) return p;
    }
    return null;
}

let _ensuring = null;
let _ensuringActive = false; // 下载进行中标志：m3u8 下载据此提示「后台下载中」而非「未安装」

/** ffmpeg 后台自动下载是否进行中。 */
function isEnsuring() { return _ensuringActive; }

/**
 * 确保 ffmpeg 就绪（幂等，并发复用同一 Promise）：
 * 已存在直接返回；否则下载 zip → tar 解压 → 拷出 ffmpeg.exe。失败不抛出，返回 null。
 */
function ensureFfmpeg() {
    if (_ensuring) return _ensuring;
    _ensuring = (async () => {
        const exist = findFfmpeg();
        if (exist) return exist;
        if (!WIN) return null; // 非 Windows 交给系统包管理器
        _ensuringActive = true;
        const pinned = ffmpegLock();
        if (!pinned) {
            // 无 lock 绝不下载未校验的二进制：宁可不装，也不引入供应链风险
            console.error('[ffmpeg] 拒绝下载：binaries.lock.json 缺少 ffmpeg.url/sha256');
            return null;
        }
        const url = pinned.url || FFMPEG_URL_FALLBACK;
        const target = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
        const stage = path.join(ROOT, 'vendor', '.tmp');
        try {
            fs.mkdirSync(stage, { recursive: true });
            fs.mkdirSync(path.dirname(target), { recursive: true });
            console.log('[ffmpeg] downloading', url);
            const archive = path.join(stage, 'yuki-ffmpeg.zip');
            await downloadFile(url, archive);
            // 完整性校验：不匹配即删除并放弃安装（上游可能已更新或被篡改）
            const got = await sha256File(archive);
            if (got !== pinned.sha256) {
                try { fs.rmSync(archive, { force: true }); } catch (e) { /* ignore */ }
                throw new Error(`ffmpeg sha256 校验失败（期望 ${pinned.sha256}，实际 ${got}）`);
            }
            console.log('[ffmpeg] sha256 校验通过');
            const tmp = path.join(stage, 'yuki-ffmpeg-extract');
            fs.mkdirSync(tmp, { recursive: true });
            // 必须走 System32 的 bsdtar：PATH 里可能是 Git Bash 的 GNU tar，它会把
            // "C:\..." 的盘符冒号解析成「主机:文件」远程语法。改用 cwd + 相对名进一步消歧。
            const sysTar = WIN
                ? (() => {
                    const s = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows',
                        'System32', 'tar.exe');
                    return fs.existsSync(s) ? s : 'tar';
                })()
                : 'tar';
            execSync(`"${sysTar}" -xf "yuki-ffmpeg.zip" -C "yuki-ffmpeg-extract"`,
                { cwd: stage, stdio: 'ignore', windowsHide: true });
            const found = findFile(tmp, 'ffmpeg.exe');
            if (!found) throw new Error('ffmpeg.exe not found in archive');
            fs.copyFileSync(found, target);
            try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { /* ignore */ }
            console.log('[ffmpeg] installed:', target);
            return target;
        } catch (e) {
            console.warn('[ffmpeg] ensure failed:', e && e.message);
            try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
            return null;
        } finally {
            _ensuring = null;
            _ensuringActive = false;
        }
    })();
    return _ensuring;
}

// ---------------------------------------------------------------- 缩略图

const THUMB_EXT = new Set(['.mp4', '.mkv', '.ts', '.flv', '.avi', '.mov', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm', '.m2ts']);

/**
 * 抓视频缩略图（并发上限 4，避免多文件同时起 ffmpeg 卡顿）：
 * 缓存命中（md5(路径|mtime|大小)）直接返回；否则 5s 处抓一帧缩到 480 宽 jpg。
 * resolve {ok:true, path} | {ok:false}。
 */
const _thumbQueue = [];
let _thumbRunning = 0;

/** 本地文件抓帧成功判定：文件存在且非 0 字节（ffmpeg 失败可能遗留空文件）。
 *  命中即返回 true；失败删除遗留的 0 字节 jpg，避免缓存层永久命中坏缩略图。 */
function thumbOutputOk(outJpg) {
    try {
        if (fs.existsSync(outJpg) && fs.statSync(outJpg).size > 0) return true;
    } catch (e) { /* 读不到按失败处理 */ }
    try { fs.rmSync(outJpg, { force: true }); } catch (e) { /* ignore */ }
    return false;
}

/** 本地文件抓帧：与 makeUrlThumb 同样 30s 总超时杀进程——损坏容器会让 ffmpeg
 *  长时间空转，不设超时会占死并发队列（上限 4）。 */
function makeThumb(videoPath, outJpg) {
    return new Promise((resolve) => {
        const bin = findFfmpeg();
        if (!bin) return resolve(false);
        let done = false;
        let timer = null;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(ok);
        };
        // 超时杀进程后遗留的半写 jpg（非 0 字节的坏图）必须清除：exit 回调会因
        // done=true 提前 return、不再走 thumbOutputOk 的清理分支，坏图会被后续
        // 请求的 size>0 判定永久命中。异步删除（Windows 下 ffmpeg 进程未退时句柄
        // 未释放会删除失败，exit 回调的兜底删除会在进程死后成功）。
        const discardPartialOutput = () => {
            try { fs.rm(outJpg, { force: true }, () => { /* ignore */ }); } catch (e) { /* ignore */ }
        };
        const armTimeout = (proc) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                try { proc.kill(); } catch (e) { /* ignore */ }
                discardPartialOutput();
                finish(false);
            }, 30000);
        };
        const proc = spawn(bin, ['-y', '-ss', '5', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', outJpg],
            { stdio: 'ignore', windowsHide: true });
        armTimeout(proc);
        proc.on('exit', () => {
            if (done) { discardPartialOutput(); return; } // 超时已判负：清掉杀进程遗留的半写 jpg
            if (thumbOutputOk(outJpg)) return finish(true);
            // 短视频 5s 处无帧：从头抓一帧再试一次
            const retry = spawn(bin, ['-y', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', outJpg], { stdio: 'ignore', windowsHide: true });
            armTimeout(retry);
            retry.on('exit', () => {
                if (done) { discardPartialOutput(); return; }
                finish(thumbOutputOk(outJpg));
            });
            retry.on('error', () => { if (!done) finish(false); });
        });
        proc.on('error', () => finish(false));
    });
}

function thumb(videoPath, cacheDir) {
    return new Promise((resolve) => {
        // 无扩展名（旧版无后缀存量下载文件）放行给 ffmpeg 实际探测；带已知非视频扩展名才拒绝
        const ext = path.extname(videoPath).toLowerCase();
        if (ext && !THUMB_EXT.has(ext)) return resolve({ ok: false });
        _thumbQueue.push({ videoPath, cacheDir, resolve });
        _pumpThumb();
    });
}

/** 直链 URL 抓帧：ffmpeg 原生支持 http(s)（含 m3u8 走 hls demuxer）输入。
 *  与本地文件共用并发队列；30s 总超时杀进程，死链/慢站不长期占用额度。 */
function urlThumb(url, cacheDir) {
    return new Promise((resolve) => {
        const u = String(url || '');
        if (!/^(https?|rtmps?):\/\//i.test(u)) return resolve({ ok: false });
        _thumbQueue.push({ url: u, cacheDir, resolve });
        _pumpThumb();
    });
}

const URL_THUMB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 YuKi';

function makeUrlThumb(url, outJpg) {
    return new Promise((resolve) => {
        const bin = findFfmpeg();
        if (!bin) return resolve(false);
        let done = false;
        let timer = null;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(ok);
        };
        // 超时杀进程后遗留的半写 jpg（非 0 字节的坏图）必须清除：exit 回调会因
        // done=true 提前 return、不再走 thumbOutputOk 的清理分支，坏图会被后续
        // 请求的 size>0 判定永久命中。异步删除（Windows 下 ffmpeg 进程未退时句柄
        // 未释放会删除失败，exit 回调的兜底删除会在进程死后成功）。
        const discardPartialOutput = () => {
            try { fs.rm(outJpg, { force: true }, () => { /* ignore */ }); } catch (e) { /* ignore */ }
        };
        const armTimeout = (proc) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                try { proc.kill(); } catch (e) { /* ignore */ }
                discardPartialOutput();
                finish(false);
            }, 30000);
        };
        // 远程流 -ss 预 seek 部分服务不支持（403/无帧）：失败再从头抓一帧
        const proc = spawn(bin, ['-y', '-hide_banner', '-user_agent', URL_THUMB_UA,
            '-ss', '5', '-i', url, '-frames:v', '1', '-vf', 'scale=480:-2', outJpg],
        { stdio: 'ignore', windowsHide: true });
        armTimeout(proc);
        proc.on('exit', () => {
            if (done) { discardPartialOutput(); return; } // 超时已判负：清掉杀进程遗留的半写 jpg
            if (thumbOutputOk(outJpg)) return finish(true);
            const retry = spawn(bin, ['-y', '-hide_banner', '-user_agent', URL_THUMB_UA,
                '-i', url, '-frames:v', '1', '-vf', 'scale=480:-2', outJpg],
            { stdio: 'ignore', windowsHide: true });
            armTimeout(retry);
            retry.on('exit', () => {
                if (done) { discardPartialOutput(); return; }
                finish(thumbOutputOk(outJpg));
            });
            retry.on('error', () => { if (!done) finish(false); });
        });
        proc.on('error', () => finish(false));
    });
}

async function _pumpThumb() {
    while (_thumbRunning < 4 && _thumbQueue.length) {
        const job = _thumbQueue.shift();
        _thumbRunning++;
        (async () => {
            try {
                fs.mkdirSync(job.cacheDir, { recursive: true });
                let out;
                if (job.url) {
                    // 远程 URL 无 mtime/size：缓存 key 直接用 md5(url)
                    const key = crypto.createHash('md5').update(String(job.url)).digest('hex');
                    out = path.join(job.cacheDir, key + '.jpg');
                    // 命中须校验非 0 字节：历史遗留的空文件重新抓帧，不永久返回坏图
                    if (thumbOutputOk(out)) return job.resolve({ ok: true, path: out });
                    const ok = await makeUrlThumb(job.url, out);
                    job.resolve(ok ? { ok: true, path: out } : { ok: false });
                    return;
                }
                let st = null;
                try { st = fs.statSync(job.videoPath); } catch (e) { return job.resolve({ ok: false }); }
                const key = crypto.createHash('md5')
                    .update(`${job.videoPath}|${st.mtimeMs}|${st.size}`).digest('hex');
                out = path.join(job.cacheDir, key + '.jpg');
                // 命中须校验非 0 字节：历史遗留的空文件重新抓帧，不永久返回坏图
                if (thumbOutputOk(out)) return job.resolve({ ok: true, path: out });
                const ok = await makeThumb(job.videoPath, out);
                job.resolve(ok ? { ok: true, path: out } : { ok: false });
            } catch (e) { job.resolve({ ok: false }); }
            finally { _thumbRunning--; _pumpThumb(); }
        })();
    }
}

module.exports = { findFfmpeg, ensureFfmpeg, isEnsuring, thumb, urlThumb };
