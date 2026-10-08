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
// 在用户机器上才炸。守卫与下方 --hidden-import 清单必须同源维护：凡 hidden-import
// 声明的子模块（uvicorn.auto 三件套、lxml、quickjs、qrcode.image.pil、PIL.Image）
// 一并纳入检查。curl_cffi / qrcode / PIL 是夸克扫码登录（pan_login.py）的生产
// 依赖，且全部是**函数内惰性 import + 缺失即优雅降级**（curl_cffi 抛可读
// RuntimeError、qrcode 渲染返回 None）：打包期不报错、运行时才让功能静默不可用，
// 而本地 venv 的手装残留会完全掩盖这个缺口（只有 CI 全新环境才暴露），所以必须
// 显式纳入守卫。注意：ddddocr/onnxruntime 已按体积决策移除（2026-10-01，省
// ~200MB），不是 hidden-import，也不进守卫——误装回 venv 反而会撑爆体积门禁。
// 输出保持 ASCII（run_all 同约）：release CI 无 PYTHONUTF8，中文 print 会 UnicodeEncodeError。
run(`"${VENV_PYTHON}" -c "`
    + 'import fastapi, uvicorn, uvicorn.logging, uvicorn.loops.auto, uvicorn.protocols.http.auto, '
    + 'requests, lxml, quickjs, jsonpath_ng, bs4, cachetools, multipart, '
    + 'curl_cffi, qrcode, qrcode.image.pil, PIL.Image; '
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
    // 验证码识别链（2026-10-01 终态）：tiny-CNN（numpy 纯推理 + assets 权重随
    // 应用打包）→ 视觉大模型（用户配置的 OpenAI 兼容多模态接口，凭据按次传入）
    // → 人工验证窗口。ddddocr/onnxruntime/opencv 已按体积决策移除（省 ~200MB），
    // 无需 hidden-import。
    // AVIF 解码插件（_avif pyd 约 7.9MB）：业务只生成二维码/验证码（PIL.Image 保存），
    // 无 AVIF 解码需求；显式排除避免 PyInstaller 把 PIL 的可选插件连带打包。
    '--exclude-module', 'PIL.AvifImagePlugin',
    'server.py',
].join(' ');

run(cmd, BACKEND);

// 4. 复制数据文件到 python-dist 根（extraResources 根 = resources/python-backend，
// 与 onedir 的 _internal/ 数据并存：_internal 供 BASE_DIR 解析，根副本供
// cwd 相对路径与人工排查使用）
console.log('[build-python] 复制数据文件…');

// 拷贝时排除的目录名（P1-1 处置④ + P3-24）：字节码/测试目录/venv 之外，补上
// FM/（网盘蜘蛛运行态，曾含真实登录 Cookie .quark/.uc 随安装包泄露）与
// .test-runtime/（测试运行态，含测试凭据）——出现在快照里即泄露面。
// 必须先于下方首次 copyDir 调用求值（const TDZ）：定义放在文件尾 helpers 区时，
// CI 全新 checkout（本地无旧产物兜底）上会 ReferenceError 崩溃。
const COPY_EXCLUDE_NAMES = new Set([
    '.venv', '__pycache__', 'tests', '.pytest_cache', 'node_modules',
    'FM',            // 网盘 Cookie 运行态（.quark/.uc 等）
    '.test-runtime', // 测试凭据与测试运行数据
]);

const dataDirs = ['js-engine', 'spiders', 'base', 'kazumi/assets'];
for (const dir of dataDirs) {
    const src = path.join(BACKEND, dir);
    const dst = path.join(DIST, dir);
    if (fs.existsSync(src)) {
        copyDir(src, dst);
    }
}

// 4.5 清理不经 COPY_EXCLUDE_NAMES 的产物目录：PyInstaller --add-data 直接复制源目录
// 整棵树，js-engine/spiders/base 的 __pycache__（以及源目录树里可能已产生的 FM/、
// .test-runtime/ 等网盘 Cookie 运行态——曾在源码根真实泄露过）会原样打进 _internal。
// 对整个 python-dist 递归执行同一份排除清单，兜住 add-data 与根副本两条复制路径。
console.log('[build-python] 清理产物中的排除目录（__pycache__/FM 等）…');
cleanExcludedDirs(DIST);

// 5. 清理临时文件
console.log('[build-python] 清理临时文件…');
try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
// PyInstaller 生成的 .spec 文件
const specFile = path.join(BACKEND, 'yuki-backend.spec');
try { fs.unlinkSync(specFile); } catch (e) { /* ignore */ }

// 6. 体积门禁：python-dist 总大小超上限即构建失败（L5：成功日志移到门禁之后，
// 避免「完成！」打在门禁失败之前误导读者）。
// 上限 180MB（2026-10-01 ddddocr 移除决策：验证码识别链改为 tiny-CNN（~3MB 权重）
// → 视觉大模型（用户配置，零打包体积）→ 人工窗口；ddddocr+onnxruntime+opencv
// 约 200MB 全部省去，实测基线回落至 ~65MB 量级；180 = 65 + 防异常膨胀余量）。
// 紧急绕过：YUKI_SIZE_GATE=0 跳过断言（例如临时引入大依赖且门禁上限
// 尚未调整时，允许先出包，但必须在同一 PR 内上调 SIZE_LIMIT 或恢复门禁）。
const SIZE_LIMIT_MB = 180;
const sizeGateEnabled = process.env.YUKI_SIZE_GATE !== '0';
if (sizeGateEnabled) {
    const subdirs = [];
    let totalBytes = 0;
    for (const entry of fs.readdirSync(DIST, { withFileTypes: true })) {
        const p = path.join(DIST, entry.name);
        const bytes = entry.isDirectory() ? dirSize(p) : fileSize(p);
        totalBytes += bytes;
        subdirs.push({ name: entry.name, bytes });
    }
    const totalMB = totalBytes / (1000 * 1000);
    console.log(`[build-python] 体积门禁：python-dist 总计 ${totalMB.toFixed(1)} MB / 上限 ${SIZE_LIMIT_MB} MB`);
    if (totalMB > SIZE_LIMIT_MB) {
        // 超限时按体积降序列出每子目录 top-10（含 _internal 下二级目录），
        // 直接给出「谁吃掉了体积」的定位线索，省去再手工扫一遍。
        subdirs.sort((a, b) => b.bytes - a.bytes);
        console.error('[build-python] 超限！各子目录体积（降序 top-10）：');
        for (const s of subdirs.slice(0, 10)) {
            console.error(`  ${s.name}: ${(s.bytes / (1000 * 1000)).toFixed(1)} MB`);
        }
        const internalDir = path.join(DIST, 'yuki-backend', '_internal');
        if (fs.existsSync(internalDir)) {
            const internals = fs.readdirSync(internalDir, { withFileTypes: true })
                .map((e) => ({ name: e.name, bytes: e.isDirectory()
                    ? dirSize(path.join(internalDir, e.name))
                    : fileSize(path.join(internalDir, e.name)) }))
                .sort((a, b) => b.bytes - a.bytes)
                .slice(0, 10);
            console.error('[build-python] yuki-backend/_internal 下 top-10：');
            for (const s of internals) {
                console.error(`  ${s.name}: ${(s.bytes / (1000 * 1000)).toFixed(1)} MB`);
            }
        }
        console.error(`[build-python] 产物超限：请排查依赖（如误引 onnx 类重库），`
            + `或评估后上调 SIZE_LIMIT_MB / 以 YUKI_SIZE_GATE=0 临时绕过。`);
        process.exit(1);
    }
} else {
    // L5：跳过门禁必须显式留痕，不能静默出包
    console.warn('[build-python] 警告：体积门禁已通过 YUKI_SIZE_GATE=0 跳过');
}

console.log('[build-python] 完成！产物在 python-dist/');

// --- helpers ---

function fileSize(p) {
    try { return fs.statSync(p).size; } catch (e) { return 0; }
}

function dirSize(p) {
    let total = 0;
    let entries;
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return 0; }
    for (const entry of entries) {
        const child = path.join(p, entry.name);
        if (entry.isDirectory()) total += dirSize(child);
        else if (entry.isFile()) total += fileSize(child);
    }
    return total;
}

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

/** 递归删除产物树里命中 COPY_EXCLUDE_NAMES 的目录（PyInstaller --add-data 不走
 * copyDir 的排除清单，__pycache__/FM 等会打进 _internal，这里做统一兜底清理）。 */
function cleanExcludedDirs(root) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const p = path.join(root, entry.name);
        if (COPY_EXCLUDE_NAMES.has(entry.name)) {
            try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
            continue;
        }
        cleanExcludedDirs(p);
    }
}
