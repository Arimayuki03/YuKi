/**
 * download-binaries.js — 下载第三方二进制（Phase 4：mpv；aria2c 槽位 Phase 6 复用）
 *
 * 用法：node scripts/download-binaries.js [mpv|aria2|anime4k|ffmpeg|all]
 * 目标目录：<repo>/vendor/mpv/mpv.exe（.gitignore 已忽略 vendor/）
 * anime4k：Anime4K v4.1 超分着色器 → vendor/anime4k/*.glsl（设置里开启后 mpv 注入）
 * ffmpeg：m3u8 切片合成 + 本地视频预览图抓帧 → vendor/ffmpeg/ffmpeg.exe（应用启动也会自动下载）
 * Windows 额外支持：node scripts/download-binaries.js mpv --winget
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const WIN = process.platform === 'win32';

// shinchiro 构建（mpv 官方推荐的 Windows 发行渠道），从 latest release 动态取 tag
const MPV_API = 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest';
// aria2 官方 release（Windows 64 位 zip，内含 aria2c.exe）
const ARIA2_API = 'https://api.github.com/repos/aria2/aria2/releases/latest';
// ffmpeg 官方 essentials 构建（m3u8 合成 + 抓帧，约 90MB；与主进程 ffmpeg.js 同源）
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
// Anime4K v4.1 着色器（Mode A 链：高光钳制→恢复→2x 升频→再恢复→暗部增强）
// 仓库按功能分子目录，下载后扁平存入 vendor/anime4k（主进程按文件名拼链）
const ANIME4K_BASE = 'https://raw.githubusercontent.com/bloc97/Anime4K/master/glsl/';
const ANIME4K_FILES = [
    'Restore/Anime4K_Clamp_Highlights.glsl',
    'Restore/Anime4K_Restore_CNN_M.glsl',
    'Upscale/Anime4K_Upscale_CNN_x2_M.glsl',
    'Restore/Anime4K_Restore_CNN_S.glsl',
    'Upscale/Anime4K_Upscale_CNN_x2_S.glsl',
    'Experimental-Effects/Anime4K_Darken_HQ.glsl',
];

function log(msg) { console.log(`[download-binaries] ${msg}`); }

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

/** 带重定向跟随的下载；binary=true 写文件，false 返回文本。 */
function download(url, dest, { redirects = 0, binary = true } = {}) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('too many redirects'));
        log(`GET ${url}`);
        const req = https.get(url, { headers: { 'User-Agent': 'video-pc' } }, (rsp) => {
            if ([301, 302, 303, 307, 308].includes(rsp.statusCode)) {
                rsp.resume();
                return resolve(download(rsp.headers.location, dest, { redirects: redirects + 1, binary }));
            }
            if (rsp.statusCode !== 200) {
                rsp.resume();
                return reject(new Error(`HTTP ${rsp.statusCode}`));
            }
            if (!binary) {
                let text = '';
                rsp.on('data', (c) => { text += c; });
                rsp.on('end', () => resolve(text));
                return;
            }
            const total = parseInt(rsp.headers['content-length'] || '0', 10);
            let got = 0;
            const file = fs.createWriteStream(dest);
            rsp.on('data', (chunk) => {
                got += chunk.length;
                if (total) process.stdout.write(`\r[download-binaries] ${(got / total * 100).toFixed(1)}% `);
            });
            rsp.pipe(file);
            file.on('finish', () => { file.close(); console.log(''); resolve(dest); });
            file.on('error', reject);
        });
        req.on('error', reject);
    });
}

/** 压缩包解压：Windows 10 1803+ 内置 tar 可直接解 7z/zip，其余平台用 7z/unzip。 */
function extract(archivePath, destDir) {
    ensureDir(destDir);
    if (WIN) {
        execSync(`tar -xf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
    } else if (archivePath.endsWith('.7z')) {
        execSync(`7z x "${archivePath}" -o"${destDir}" -y`, { stdio: 'inherit' });
    } else {
        execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'inherit' });
    }
}

async function downloadMpv() {
    const target = path.join(VENDOR, 'mpv', WIN ? 'mpv.exe' : 'mpv');
    if (fs.existsSync(target)) { log(`mpv 已存在：${target}`); return; }
    if (!WIN) {
        log('非 Windows 平台请通过系统包管理器安装 mpv（brew install mpv / apt install mpv）');
        return;
    }
    ensureDir(path.join(VENDOR, 'mpv'));
    // 暂存放在工作区 vendor/.tmp（避开系统临时目录权限差异）
    const stage = path.join(VENDOR, '.tmp');
    ensureDir(stage);

    // 1) 取 latest release tag，选 mpv-x86_64-<tag>-git-*.7z（非 dev / 非 v3）
    const meta = JSON.parse(await download(MPV_API, null, { binary: false }));
    const tag = meta.tag_name;
    const asset = (meta.assets || []).find((a) => /^mpv-x86_64-\d+-git-[\da-f]+\.7z$/.test(a.name));
    if (!asset) throw new Error(`no mpv-x86_64 7z asset in release ${tag}`);
    log(`release ${tag} -> ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB)`);

    // 2) 下载并解压
    const archive = path.join(stage, 'vpc-mpv.7z');
    await download(asset.browser_download_url, archive);
    const tmp = path.join(stage, 'vpc-mpv-extract');
    extract(archive, tmp);
    const found = findFile(tmp, 'mpv.exe');
    if (!found) throw new Error('mpv.exe not found in archive');
    fs.copyFileSync(found, target);
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    log(`mpv 安装完成：${target}`);
}

function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { const r = findFile(p, name); if (r) return r; }
        else if (entry.name === name) return p;
    }
    return null;
}

async function downloadAria2() {
    const exe = WIN ? 'aria2c.exe' : 'aria2c';
    const target = path.join(VENDOR, 'aria2', exe);
    if (fs.existsSync(target)) { log(`aria2c 已存在：${target}`); return; }
    if (!WIN) {
        log('非 Windows 平台请通过系统包管理器安装 aria2（brew install aria2 / apt install aria2）');
        return;
    }
    ensureDir(path.join(VENDOR, 'aria2'));
    const stage = path.join(VENDOR, '.tmp');
    ensureDir(stage);

    const meta = JSON.parse(await download(ARIA2_API, null, { binary: false }));
    const asset = (meta.assets || []).find((a) =>
        /^aria2-\d+[\d.]*-win-64bit-build\d+\.zip$/.test(a.name));
    if (!asset) throw new Error(`no win-64bit zip asset in release ${meta.tag_name}`);
    log(`release ${meta.tag_name} -> ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB)`);

    const archive = path.join(stage, 'vpc-aria2.zip');
    await download(asset.browser_download_url, archive);
    const tmp = path.join(stage, 'vpc-aria2-extract');
    extract(archive, tmp);
    const found = findFile(tmp, 'aria2c.exe');
    if (!found) throw new Error('aria2c.exe not found in archive');
    fs.copyFileSync(found, target);
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    log(`aria2c 安装完成：${target}`);
}

async function downloadAnime4k() {
    const dir = path.join(VENDOR, 'anime4k');
    ensureDir(dir);
    let okCount = 0;
    for (const rel of ANIME4K_FILES) {
        const dest = path.join(dir, path.basename(rel)); // 扁平化：只留文件名
        if (fs.existsSync(dest)) { okCount += 1; continue; }
        try {
            await download(ANIME4K_BASE + rel, dest);
            okCount += 1;
        } catch (e) {
            log(`${rel} 下载失败：${e.message}（可稍后重跑 node scripts/download-binaries.js anime4k）`);
        }
    }
    if (okCount === ANIME4K_FILES.length) log(`Anime4K 着色器就绪（${okCount}/${ANIME4K_FILES.length}）：${dir}`);
    else log(`Anime4K 不完整（${okCount}/${ANIME4K_FILES.length}），开关暂不会生效`);
}

async function downloadFfmpeg() {
    const exe = WIN ? 'ffmpeg.exe' : 'ffmpeg';
    const target = path.join(VENDOR, 'ffmpeg', exe);
    if (fs.existsSync(target)) { log(`ffmpeg 已存在：${target}`); return; }
    if (!WIN) {
        log('非 Windows 平台请通过系统包管理器安装 ffmpeg（brew install ffmpeg / apt install ffmpeg）');
        return;
    }
    ensureDir(path.join(VENDOR, 'ffmpeg'));
    const stage = path.join(VENDOR, '.tmp');
    ensureDir(stage);

    const archive = path.join(stage, 'vpc-ffmpeg.zip');
    await download(FFMPEG_URL, archive);
    const tmp = path.join(stage, 'vpc-ffmpeg-extract');
    extract(archive, tmp);
    const found = findFile(tmp, 'ffmpeg.exe');
    if (!found) throw new Error('ffmpeg.exe not found in archive');
    fs.copyFileSync(found, target);
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    log(`ffmpeg 安装完成：${target}`);
}

async function main() {
    const what = process.argv[2] || 'mpv';
    if (process.argv.includes('--winget') && WIN) {
        log('通过 winget 安装 mpv（安装到系统目录，应用会从 PATH 探测）...');
        execSync('winget install --id=shinchiro.mpv -e --accept-source-agreements --accept-package-agreements', { stdio: 'inherit' });
        return;
    }
    if (what === 'mpv' || what === 'all') await downloadMpv();
    if (what === 'aria2' || what === 'all') await downloadAria2();
    if (what === 'anime4k' || what === 'all') await downloadAnime4k();
    if (what === 'ffmpeg' || what === 'all') await downloadFfmpeg();
}

main().catch((e) => { console.error(`[download-binaries] FAILED: ${e.message}`); process.exit(1); });
