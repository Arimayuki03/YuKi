/**
 * ffmpeg.js — ffmpeg 二进制管理（探测 / 启动自动下载 / 缩略图抓帧）
 *
 * 用途：
 * - m3u8 切片流下载合成（hls-downloader.js 调用）
 * - 本地文件视频预览图抓帧（主进程 yuki:file-thumb）
 *
 * 二进制来源：<repo>/vendor/ffmpeg/ffmpeg.exe → PATH；
 * 缺失时 ensureFfmpeg() 后台下载 gyan.dev essentials 构建（约 90MB，zip 经系统 tar 解压）。
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
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

/** vendor 内置 → PATH 探测；找不到返回 null。 */
function findFfmpeg() {
    const exe = WIN ? 'ffmpeg.exe' : 'ffmpeg';
    const vendor = path.join(ROOT, 'vendor', 'ffmpeg', exe);
    if (fs.existsSync(vendor)) return vendor;
    try {
        if (WIN) {
            const out = execSync('where ffmpeg', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            const first = out.split(/\r?\n/)[0];
            if (first) return first;
        } else {
            const out = execSync('command -v ffmpeg', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            if (out) return out;
        }
    } catch (e) { /* 不在 PATH */ }
    return null;
}

/** 带重定向跟随的下载（写入 dest）。 */
function downloadFile(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('too many redirects'));
        const req = https.get(url, { headers: { 'User-Agent': 'yuki' } }, (rsp) => {
            if ([301, 302, 303, 307, 308].includes(rsp.statusCode)) {
                rsp.resume();
                return resolve(downloadFile(rsp.headers.location, dest, redirects + 1));
            }
            if (rsp.statusCode !== 200) {
                rsp.resume();
                return reject(new Error(`HTTP ${rsp.statusCode}`));
            }
            const file = fs.createWriteStream(dest);
            rsp.pipe(file);
            file.on('finish', () => { file.close(); resolve(dest); });
            file.on('error', reject);
        });
        req.on('error', reject);
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
        const target = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
        const stage = path.join(ROOT, 'vendor', '.tmp');
        try {
            fs.mkdirSync(stage, { recursive: true });
            fs.mkdirSync(path.dirname(target), { recursive: true });
            console.log('[ffmpeg] downloading', FFMPEG_URL);
            const archive = path.join(stage, 'yuki-ffmpeg.zip');
            await downloadFile(FFMPEG_URL, archive);
            const tmp = path.join(stage, 'yuki-ffmpeg-extract');
            fs.mkdirSync(tmp, { recursive: true });
            execSync(`tar -xf "${archive}" -C "${tmp}"`, { stdio: 'ignore' });
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

function makeThumb(videoPath, outJpg) {
    return new Promise((resolve) => {
        const bin = findFfmpeg();
        if (!bin) return resolve(false);
        const args = ['-y', '-ss', '5', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', outJpg];
        const proc = spawn(bin, args, { stdio: 'ignore' });
        proc.on('exit', (code) => {
            if (code === 0 && fs.existsSync(outJpg)) return resolve(true);
            // 短视频 5s 处无帧：从头抓一帧再试一次
            const retry = spawn(bin, ['-y', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', outJpg], { stdio: 'ignore' });
            retry.on('exit', (c2) => resolve(c2 === 0 && fs.existsSync(outJpg)));
            retry.on('error', () => resolve(false));
        });
        proc.on('error', () => resolve(false));
    });
}

function thumb(videoPath, cacheDir) {
    return new Promise((resolve) => {
        if (!THUMB_EXT.has(path.extname(videoPath).toLowerCase())) return resolve({ ok: false });
        _thumbQueue.push({ videoPath, cacheDir, resolve });
        _pumpThumb();
    });
}

async function _pumpThumb() {
    while (_thumbRunning < 4 && _thumbQueue.length) {
        const job = _thumbQueue.shift();
        _thumbRunning++;
        (async () => {
            try {
                let st = null;
                try { st = fs.statSync(job.videoPath); } catch (e) { return job.resolve({ ok: false }); }
                fs.mkdirSync(job.cacheDir, { recursive: true });
                const key = crypto.createHash('md5')
                    .update(`${job.videoPath}|${st.mtimeMs}|${st.size}`).digest('hex');
                const out = path.join(job.cacheDir, key + '.jpg');
                if (fs.existsSync(out)) return job.resolve({ ok: true, path: out });
                const ok = await makeThumb(job.videoPath, out);
                job.resolve(ok ? { ok: true, path: out } : { ok: false });
            } catch (e) { job.resolve({ ok: false }); }
            finally { _thumbRunning--; _pumpThumb(); }
        })();
    }
}

module.exports = { findFfmpeg, ensureFfmpeg, isEnsuring, thumb };
