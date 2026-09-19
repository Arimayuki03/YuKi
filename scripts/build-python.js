/**
 * build-python.js — 将 Python FastAPI 后端用 PyInstaller 打包为独立 exe。
 *
 * 产物放在项目根 python-dist/ 下，electron-builder 将其作为 extraResource
 * 内嵌到安装包中。主进程根据 isPackaged 自动切换后端启动路径。
 *
 * 前置：python-backend/.venv 存在（脚本会自动按锁文件校准 PyInstaller 与运行时依赖）。
 * 用法：node scripts/build-python.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'python-backend');
const DIST = path.join(ROOT, 'python-dist');
const VENV_BIN = process.platform === 'win32' ? 'Scripts' : 'bin';
const VENV_PYTHON = path.join(BACKEND, '.venv', VENV_BIN,
    process.platform === 'win32' ? 'python.exe' : 'python');
const VENV_PIP = path.join(BACKEND, '.venv', VENV_BIN,
    process.platform === 'win32' ? 'pip.exe' : 'pip');
const BUILD_REQUIREMENTS = path.join(BACKEND, 'requirements-build.txt');
const RUNTIME_REQUIREMENTS = path.join(BACKEND, 'requirements.txt');
const DATA_SEPARATOR = process.platform === 'win32' ? ';' : ':';

function run(cmd, cwd) {
    console.log(`> ${cmd}`);
    execSync(cmd, { cwd: cwd || ROOT, stdio: 'inherit' });
}

// 1. 按锁文件校准构建环境：PyInstaller（工具链）+ requirements.txt（运行时依赖）。
// CI 全新 checkout 的 venv 是空的——PyInstaller 对缺失的导入包只告警不失败，
// 产物里静默少整个 fastapi（v0.2.2 安装后 ModuleNotFoundError 的根因），
// 因此运行时依赖必须在这里显式安装，并在打包前用目标解释器做一次导入守卫。
console.log('[build-python] 按 requirements-build.txt / requirements.txt 校准构建环境…');
for (const req of [BUILD_REQUIREMENTS, RUNTIME_REQUIREMENTS]) {
    if (!fs.existsSync(req)) {
        throw new Error(`缺少依赖锁文件：${req}`);
    }
}
const pipCmd = fs.existsSync(VENV_PIP) ? `"${VENV_PIP}"` : 'pip';
try {
    run(`${pipCmd} install -r "${BUILD_REQUIREMENTS}" -r "${RUNTIME_REQUIREMENTS}"`);
} catch (e) {
    // venv 不存在时回退到 python -m pip（CI 全新 checkout 场景）
    console.log(`[build-python] ${pipCmd} 不可用，尝试 python -m pip…`);
    run(`python -m pip install -r "${BUILD_REQUIREMENTS}" -r "${RUNTIME_REQUIREMENTS}"`);
}
// 导入守卫：与 PyInstaller 用同一解释器，缺包在打包前就失败，而不是打进产物后
// 在用户机器上才炸。quickjs/lxml 是 hidden-import 项，同样纳入检查。
// curl_cffi / qrcode / PIL 是夸克扫码登录（pan_login.py）的生产依赖，且全部是**函数内
// 惰性 import + 缺失即优雅降级**（curl_cffi 抛可读 RuntimeError、qrcode 渲染返回 None）：
// 打包期不报错、运行时才让功能静默不可用，而本地 venv 的手装残留会完全掩盖这个缺口
// （只有 CI 全新环境才暴露），所以必须显式纳入守卫。
// 输出保持 ASCII（run_all 同约）：release CI 无 PYTHONUTF8，中文 print 会 UnicodeEncodeError。
run(`"${VENV_PYTHON}" -c "`
    + 'import fastapi, uvicorn, requests, lxml, quickjs, jsonpath_ng, bs4, cachetools, multipart, '
    + 'curl_cffi, qrcode, PIL.Image; '
    + "print('[build-python] import guard OK')\"", BACKEND);

// 2. 清理旧产物
console.log('[build-python] 清理旧产物…');
try { fs.rmSync(DIST, { recursive: true, force: true }); } catch (e) { /* ignore */ }
fs.mkdirSync(DIST, { recursive: true });

// 3. PyInstaller 打包（onedir 目录产物，不含控制台窗口）
// 不用 --onefile：单文件每次启动都要把全部依赖解压到 %TEMP% 再执行，后端冷启动
// 因此多出数秒（杀软扫描时更久）；onedir 免解压，启动 ~1s。产物布局：
// python-dist/yuki-backend/yuki-backend.exe + _internal/（依赖与 --add-data 数据）。
console.log('[build-python] PyInstaller 打包中（约 1-3 分钟）…');
const distDir = path.join(DIST);
const workDir = path.join(ROOT, 'python-dist-tmp');
try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

const cmd = [
    `"${VENV_PYTHON}" -m PyInstaller`,
    '--windowed',
    '--name', 'yuki-backend',
    '--distpath', `"${distDir}"`,
    '--workpath', `"${workDir}"`,
    '--add-data', `"js-engine${DATA_SEPARATOR}js-engine"`,
    '--add-data', `"spiders${DATA_SEPARATOR}spiders"`,
    '--add-data', `"base${DATA_SEPARATOR}base"`,
    '--add-data', `"kazumi/assets${DATA_SEPARATOR}kazumi/assets"`,
    '--hidden-import', 'uvicorn.logging',
    '--hidden-import', 'uvicorn.loops.auto',
    '--hidden-import', 'uvicorn.protocols.http.auto',
    '--hidden-import', 'lxml',
    '--hidden-import', 'quickjs',
    // qrcode 的图像工厂通过 setuptools entry-point 动态解析（qrcode.image.pil），
    // PyInstaller 静态分析抓不到；不显式声明的话扫码二维码在打包版里渲染为空。
    '--hidden-import', 'qrcode.image.pil',
    '--hidden-import', 'PIL.Image',
    'server.py',
].join(' ');

run(cmd, BACKEND);

// 4. 复制数据文件到 python-dist 根（extraResources 根 = resources/python-backend，
// 与 onedir 的 _internal/ 数据并存：_internal 供 BASE_DIR 解析，根副本供
// cwd 相对路径与人工排查使用）
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
const specFile = path.join(BACKEND, 'yuki-backend.spec');
try { fs.unlinkSync(specFile); } catch (e) { /* ignore */ }

console.log('[build-python] 完成！产物在 python-dist/');

// --- helpers ---

// 拷贝时排除的目录名（P1-1 处置④ + P3-24）：字节码/测试目录/venv 之外，补上
// FM/（网盘蜘蛛运行态，曾含真实登录 Cookie .quark/.uc 随安装包泄露）与
// .test-runtime/（测试运行态，含测试凭据）——出现在快照里即泄露面。
const COPY_EXCLUDE_NAMES = new Set([
    '.venv', '__pycache__', 'tests', '.pytest_cache', 'node_modules',
    'FM',            // 网盘 Cookie 运行态（.quark/.uc 等）
    '.test-runtime', // 测试凭据与测试运行数据
]);

function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    let entries;
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
        if (COPY_EXCLUDE_NAMES.has(entry.name)) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        let st;
        try { st = fs.statSync(s); } catch (e) { continue; } // 失效链接等：跳过
        // P3-24：解引用拷贝——statSync 跟随符号链接/junction（Windows junction 同样
        // 被跟随），按指向的真实类型分别处理。原实现按 readdirSync 的 Dirent 分类，
        // symlink/junction 条目既非 isDirectory 也非 isFile，被静默跳过 →
        // venv 含 junction 时冻结包不完整。
        if (st.isDirectory()) { copyDir(s, d); }
        else if (st.isFile()) { fs.copyFileSync(s, d); }
    }
}
