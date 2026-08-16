/**
 * build-python.js — 将 Python FastAPI 后端用 PyInstaller 打包为独立 exe。
 *
 * 产物放在项目根 python-dist/ 下，electron-builder 将其作为 extraResource
 * 内嵌到安装包中。主进程根据 isPackaged 自动切换后端启动路径。
 *
 * 前置：python-backend/.venv 中需安装 pyinstaller。
 * 用法：node scripts/build-python.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'python-backend');
const DIST = path.join(ROOT, 'python-dist');
const VENV_PYTHON = path.join(BACKEND, '.venv', 'Scripts', 'python.exe');
const VENV_PIP = path.join(BACKEND, '.venv', 'Scripts', 'pip.exe');

function run(cmd, cwd) {
    console.log(`> ${cmd}`);
    execSync(cmd, { cwd: cwd || ROOT, stdio: 'inherit' });
}

// 1. 确保 PyInstaller 已安装
console.log('[build-python] 检查 PyInstaller…');
try {
    execSync(`"${VENV_PYTHON}" -c "import PyInstaller"`, { stdio: 'ignore' });
} catch (e) {
    console.log('[build-python] 安装 PyInstaller…');
    run(`"${VENV_PIP}" install pyinstaller`);
}

// 2. 清理旧产物
console.log('[build-python] 清理旧产物…');
try { fs.rmSync(DIST, { recursive: true, force: true }); } catch (e) { /* ignore */ }
fs.mkdirSync(DIST, { recursive: true });

// 3. PyInstaller 打包（单文件 exe，不含控制台窗口）
console.log('[build-python] PyInstaller 打包中（约 1-3 分钟）…');
const distDir = path.join(DIST);
const workDir = path.join(ROOT, 'python-dist-tmp');
try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

const cmd = [
    `"${VENV_PYTHON}" -m PyInstaller`,
    '--onefile',
    '--windowed',
    '--name', 'video-pc-backend',
    '--distpath', `"${distDir}"`,
    '--workpath', `"${workDir}"`,
    '--add-data', `"js-engine;js-engine"`,
    '--add-data', `"spiders;spiders"`,
    '--add-data', `"base;base"`,
    '--add-data', `"kazumi/assets;kazumi/assets"`,
    '--hidden-import', 'uvicorn.logging',
    '--hidden-import', 'uvicorn.loops.auto',
    '--hidden-import', 'uvicorn.protocols.http.auto',
    '--hidden-import', 'lxml',
    '--hidden-import', 'quickjs',
    'server.py',
].join(' ');

run(cmd, BACKEND);

// 4. 复制数据文件（PyInstaller --add-data 对 onefile 支持有限，额外手动复制）
console.log('[build-python] 复制数据文件…');
const dataDirs = ['js-engine', 'spiders', 'base', 'kazumi/assets'];
for (const dir of dataDirs) {
    const src = path.join(BACKEND, dir);
    const dst = path.join(DIST, dir);
    if (fs.existsSync(src)) {
        copyDir(src, dst);
    }
}

// 5. 清理临时文件
console.log('[build-python] 清理临时文件…');
try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
// PyInstaller 生成的 .spec 文件
const specFile = path.join(BACKEND, 'video-pc-backend.spec');
try { fs.unlinkSync(specFile); } catch (e) { /* ignore */ }

console.log('[build-python] 完成！产物在 python-dist/');

// --- helpers ---

function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) { copyDir(s, d); }
        else if (entry.isFile()) { fs.copyFileSync(s, d); }
    }
}
