/**
 * download-binaries.js — 下载第三方二进制（Phase 4：mpv；aria2c 槽位 Phase 6 复用）
 *
 * 用法：node scripts/download-binaries.js [mpv|aria2|anime4k|ffmpeg|misans|all]
 * 目标目录：<repo>/vendor/mpv/mpv.exe（.gitignore 已忽略 vendor/）
 * anime4k：Anime4K v4.1 超分着色器 → vendor/anime4k/*.glsl（设置里开启后 mpv 注入）
 * ffmpeg：m3u8 切片合成 + 本地视频预览图抓帧 → vendor/ffmpeg/ffmpeg.exe（应用启动也会自动下载）
 * misans：MiSans 子集化 UI 字体 → vendor/misans/*.css + 分片 woff2（应用启动也会自动补齐）
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
// 仓库按功能分子目录，下载后扁平存入 vendor/anime4k（主进程按文件名拼链）。
// 多镜像（与主进程 index.js ensureAnime4k 同源）：raw 直连 → jsdelivr CDN → ghfast.top 加速代理
const ANIME4K_BASES = [
    'https://raw.githubusercontent.com/bloc97/Anime4K/master/glsl/',
    'https://cdn.jsdelivr.net/gh/bloc97/Anime4K@master/glsl/',
    'https://ghfast.top/https://raw.githubusercontent.com/bloc97/Anime4K/master/glsl/',
];
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

async function downloadMpv(vendorDir) {
    const vendor = vendorDir || VENDOR;
    const target = path.join(vendor, 'mpv', WIN ? 'mpv.exe' : 'mpv');
    if (fs.existsSync(target)) { log(`mpv 已存在：${target}`); return target; }
    if (!WIN) {
        log('非 Windows 平台请通过系统包管理器安装 mpv（brew install mpv / apt install mpv）');
        return null;
    }
    ensureDir(path.join(vendor, 'mpv'));
    // 暂存放在 vendor/.tmp（避开系统临时目录权限差异）
    const stage = path.join(vendor, '.tmp');
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
    return target;
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
        if (fs.existsSync(dest) && fs.statSync(dest).size >= 128) { okCount += 1; continue; }
        let got = false;
        for (const base of ANIME4K_BASES) {
            try {
                await download(base + rel, dest);
                okCount += 1;
                got = true;
                break;
            } catch (e) {
                log(`${rel} 镜像 ${base} 失败：${e.message}`);
            }
        }
        if (!got) log(`${rel} 全部镜像下载失败（可稍后重跑 node scripts/download-binaries.js anime4k，应用启动也会自动补齐）`);
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

// MiSans 子集化字体（npm misans@4.1.0，dsrkafuu 基于 Noto Sans SC 代码范围子集化）：
// 按 unicode-range 分片成 ~100 个 woff2/字重，浏览器只加载用到的分片，总 ~2MB/字重。
// 字重：Regular(330) 覆盖正文，Bold(630) 覆盖标题/强调；不引入 Medium，避免 400 正文
// 命中 380 Medium 而非 330 Regular（浏览器按最近字重匹配）。目录：vendor/misans/
const MISANS_BASE = 'https://cdn.jsdelivr.net/npm/misans@4.1.0/lib/Normal/';
const MISANS_WEIGHTS = ['Regular', 'Bold'];

async function downloadMisans() {
    const dir = path.join(VENDOR, 'misans');
    ensureDir(dir);
    // 1) 拉三个字重的 CSS（内含各分片 url 与 unicode-range）
    const cssFiles = [];
    for (const w of MISANS_WEIGHTS) {
        const dest = path.join(dir, `MiSans-${w}.min.css`);
        if (!(fs.existsSync(dest) && fs.statSync(dest).size > 1024)) {
            try { await download(`${MISANS_BASE}MiSans-${w}.min.css`, dest); }
            catch (e) { log(`MiSans-${w} CSS 下载失败：${e.message}`); continue; }
        }
        cssFiles.push(dest);
    }
    if (!cssFiles.length) { log('MiSans CSS 全部下载失败'); return; }
    // 2) 解析所有 CSS 引用的分片，逐个下载（并发 8，跳过已存在 → 幂等）
    const wanted = new Set();
    for (const css of cssFiles) {
        const text = fs.readFileSync(css, 'utf8');
        for (const m of text.matchAll(/url\('([^']+)'\)/g)) wanted.add(m[1]);
    }
    const list = [...wanted];
    let ok = 0;
    const pool = [];
    for (const name of list) {
        const dest = path.join(dir, name);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 500) { ok++; continue; }
        pool.push(download(`${MISANS_BASE}${name}`, dest)
            .then(() => ok++)
            .catch((e) => log(`分片 ${name} 下载失败：${e.message}`)));
        if (pool.length >= 8) { await Promise.all(pool); pool.length = 0; }
    }
    await Promise.all(pool);
    log(`MiSans 字体就绪（${ok}/${list.length} 分片）：${dir}`);
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
    if (what === 'misans' || what === 'all') await downloadMisans();
}

// 作为脚本直接运行时才执行 CLI 主流程；被 require（主进程一键补装）时仅导出函数。
if (require.main === module) {
    main().catch((e) => { console.error(`[download-binaries] FAILED: ${e.message}`); process.exit(1); });
}

module.exports = { downloadMpv, downloadAria2, downloadFfmpeg, downloadAnime4k, downloadMisans };
