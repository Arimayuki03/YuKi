// 白盒单元测试：主进程三个小工具模块（win-focus / misans / app-icon）
//
// 三个模块都在「加载期」读取环境（process.platform、require('electron')、__dirname），
// 因此统一用 node:vm 重新加载源码（records.test.js 同款桩范式）：注入 electron /
// child_process / fs 替身并控制 process，既不起 Electron、也不出网、不改 src/。
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const SRC_MAIN = path.join(__dirname, '..', '..', 'src', 'main');

/** 临时目录（用例结束统一清理，不污染仓库）。 */
function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `yuki-${prefix}-`));
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * 在 VM 中加载 src/main 下的模块源码。
 * 可替换 electron / child_process / fs 等依赖，并控制 process.platform、
 * process.resourcesPath、__dirname 等加载期环境（模块级常量由此分支）。
 *
 * @param {string} file src/main 下的文件名
 * @param {object} [opts] { electron, stubs, process, console, dirname }
 */
function loadModule(file, opts) {
    const o = opts || {};
    const abs = path.join(SRC_MAIN, file);
    const source = fs.readFileSync(abs, 'utf8');
    const ctx = {
        console: o.console || console,
        process: Object.assign({
            platform: process.platform,
            env: process.env,
            version: process.version,
            resourcesPath: undefined,
        }, o.process || {}),
        Buffer, URL, setTimeout, clearTimeout,
        __dirname: o.dirname || SRC_MAIN,
        __filename: abs,
        module: { exports: {} },
    };
    ctx.exports = ctx.module.exports;
    ctx.require = (id) => {
        if (id === 'electron') {
            // 'throw' 用于模拟「不在 Electron 进程内」的真实失败路径
            if (o.electron === 'throw') throw new Error('electron unavailable outside Electron');
            return o.electron || {};
        }
        if (o.stubs && Object.prototype.hasOwnProperty.call(o.stubs, id)) return o.stubs[id];
        return require(id);
    };
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: abs });
    return ctx.module.exports;
}

// ================================================================ win-focus

describe('win-focus', () => {
    /** spawn 替身：记录调用参数；可按需让 spawn / unref 抛错。 */
    function makeSpawn(fail) {
        const calls = [];
        const spawn = (cmd, args, options) => {
            const rec = { cmd, args, options, unrefCalled: false };
            calls.push(rec);
            if (fail === 'spawn') throw new Error('spawn ENOENT');
            return {
                unref() {
                    rec.unrefCalled = true;
                    if (fail === 'unref') throw new Error('unref failed');
                },
            };
        };
        return { calls, spawn };
    }

    /** 按平台加载 win-focus（module 级 IS_WIN 由此决定）。 */
    function load(platform, spawn) {
        return loadModule('win-focus.js', { process: { platform }, stubs: { child_process: { spawn } } });
    }

    test('导出契约：只暴露 bringToFront 一个函数', () => {
        const { calls, spawn } = makeSpawn();
        const mod = load('win32', spawn);
        assert.deepEqual(Object.keys(mod), ['bringToFront']);
        assert.equal(typeof mod.bringToFront, 'function');
        assert.equal(calls.length, 0, '仅加载不应触发 spawn');
    });

    test('非 win32（linux/darwin）直接跳过：不 spawn 任何辅助进程', () => {
        for (const platform of ['linux', 'darwin']) {
            const { calls, spawn } = makeSpawn();
            const { bringToFront } = load(platform, spawn);
            bringToFront(4242);
            assert.equal(calls.length, 0, `${platform} 应直接返回（mpv --focus-on 已自带）`);
        }
    });

    test('win32 + 合法 pid：spawn powershell.exe，脚本文本内已内插 pid（无 __PID__ 残留）', () => {
        const { calls, spawn } = makeSpawn();
        const { bringToFront } = load('win32', spawn);
        bringToFront(4321);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].cmd, 'powershell.exe');
        const script = calls[0].args[calls[0].args.length - 1];
        assert.ok(script.includes('$targetPid = 4321'), 'pid 必须内插进脚本文本');
        assert.ok(!script.includes('__PID__'), '占位符必须被替换');
        // 回归：-Command 形态下 $args 恒为空，脚本不得再依赖 $args 拿 pid
        // （只查代码行：HELPER 的注释里提到了 $args 这个坑，需先剔注释行）
        const codeLines = script.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
        assert.ok(!codeLines.some((l) => l.includes('$args')),
            '不得再用 $args 传 pid（实测恒为空，激活从未生效）');
        assert.ok(script.includes('$targetPid = 4321'), 'pid 必须内插进脚本文本');
        assert.ok(script.includes('SetForegroundWindow'), '辅助脚本走 Win32 P/Invoke 激活');
        assert.ok(script.includes('AttachThreadInput'), '须 AttachThreadInput 绕过前台锁');
        assert.ok(script.includes('IsIconic'), '最小化窗口先 SW_RESTORE 再激活');
    });

    test('win32：spawn 选项 detached + windowsHide + stdio=ignore，并 unref 脱离父进程', () => {
        const { calls, spawn } = makeSpawn();
        const { bringToFront } = load('win32', spawn);
        bringToFront(100);
        const opt = calls[0].options;
        assert.equal(opt.stdio, 'ignore', '辅助进程输出不接管');
        assert.equal(opt.windowsHide, true, '避免闪黑窗');
        assert.equal(opt.detached, true, '脱离父进程');
        assert.equal(calls[0].unrefCalled, true, 'unref 保证不挂住主进程退出');
    });

    test('win32：命令行固定 -NoProfile/-NonInteractive/-ExecutionPolicy Bypass/-Command', () => {
        const { calls, spawn } = makeSpawn();
        const { bringToFront } = load('win32', spawn);
        bringToFront(7);
        const head = calls[0].args.slice(0, 5);
        assert.equal(head.join('|'), '-NoProfile|-NonInteractive|-ExecutionPolicy|Bypass|-Command');
    });

    test('入参为 null/undefined/0/负数/NaN/字符串/对象：一律不 spawn 且不抛（调用方无需防御）', () => {
        const { calls, spawn } = makeSpawn();
        const { bringToFront } = load('win32', spawn);
        for (const bad of [null, undefined, 0, -1, NaN, '123', {}]) {
            assert.doesNotThrow(() => bringToFront(bad), `pid=${String(bad)} 不应抛`);
        }
        assert.equal(calls.length, 0, '非法 pid 全部被 pid > 0 守卫拦下');
    });

    test('pid 为 Infinity：typeof number 且 >0，守卫放行的现状（脚本内插 Infinity，见报告）', () => {
        const { calls, spawn } = makeSpawn();
        const { bringToFront } = load('win32', spawn);
        assert.doesNotThrow(() => bringToFront(Infinity));
        assert.equal(calls.length, 1, '现状：Infinity 不被守卫拦截（疑似缺陷，已在报告中记录）');
        assert.ok(calls[0].args[calls[0].args.length - 1].includes('$targetPid = Infinity'));
    });

    test('pid 为小数：内插前 Math.floor 取整（避免脚本语法错/错激活别的进程）', () => {
        const { calls, spawn } = makeSpawn();
        const { bringToFront } = load('win32', spawn);
        bringToFront(4321.9);
        const script = calls[0].args[calls[0].args.length - 1];
        assert.ok(script.includes('$targetPid = 4321'));
        assert.ok(!script.includes('4321.9'));
    });

    test('spawn 抛异常（powershell 不存在）被吞：不向播放主流程冒泡', () => {
        const { spawn } = makeSpawn('spawn');
        const { bringToFront } = load('win32', spawn);
        assert.doesNotThrow(() => bringToFront(999));
    });

    test('child.unref 抛异常同样被吞：fire-and-forget 契约不被破坏', () => {
        const { calls, spawn } = makeSpawn('unref');
        const { bringToFront } = load('win32', spawn);
        assert.doesNotThrow(() => bringToFront(555));
        assert.equal(calls.length, 1, 'unref 失败不影响已发出的激活请求');
    });

    test('返回值恒为 undefined（异步 fire-and-forget，调用方不得 await 结果）', () => {
        const { spawn } = makeSpawn();
        const { bringToFront } = load('win32', spawn);
        assert.equal(bringToFront(1), undefined);
    });
});

// ================================================================ misans

describe('misans', () => {
    /** 把 ROOT 指到临时目录根（__dirname 取 {root}/src/main，模块内向上两级）。 */
    function loadMisans(root, extra) {
        return loadModule('misans.js', Object.assign({
            dirname: path.join(root, 'src', 'main'),
            electron: { app: { isPackaged: false } },
        }, extra || {}));
    }

    /** 在 {root}/vendor/misans 下写一份指定体积的 CSS（返回绝对路径）。 */
    function putCss(root, weight, bytes) {
        const dir = path.join(root, 'vendor', 'misans');
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, `MiSans-${weight}.min.css`);
        fs.writeFileSync(p, Buffer.alloc(bytes));
        return p;
    }

    test('导出契约：ensureMisans / fontCssUrls / readyCssPaths 三个函数', () => {
        const root = tmpDir('misans-api');
        try {
            const mod = loadMisans(root);
            assert.equal(typeof mod.ensureMisans, 'function');
            assert.equal(typeof mod.fontCssUrls, 'function');
            assert.equal(typeof mod.readyCssPaths, 'function');
        } finally { cleanup(root); }
    });

    test('两字重均就绪：readyCssPaths 返回两条，顺序 Regular → Bold', () => {
        const root = tmpDir('misans-ready');
        try {
            const reg = putCss(root, 'Regular', 4096);
            const bold = putCss(root, 'Bold', 4096);
            const { readyCssPaths } = loadMisans(root);
            const out = readyCssPaths();
            assert.equal(out.length, 2);
            assert.equal(out[0], reg, 'Regular 先（WEIGHTS 顺序）');
            assert.equal(out[1], bold);
        } finally { cleanup(root); }
    });

    test('字体缺失（vendor/misans 不存在）：readyCssPaths 与 fontCssUrls 均为空数组', () => {
        const root = tmpDir('misans-missing');
        try {
            const { readyCssPaths, fontCssUrls } = loadMisans(root);
            assert.equal(readyCssPaths().length, 0);
            assert.equal(fontCssUrls().length, 0, '未就绪不得产出 <link> URL');
        } finally { cleanup(root); }
    });

    test('部分就绪（仅 Regular）：只返回存在的那一条，Bold 不占位', () => {
        const root = tmpDir('misans-partial');
        try {
            const reg = putCss(root, 'Regular', 4096);
            const { readyCssPaths, fontCssUrls } = loadMisans(root);
            const out = readyCssPaths();
            assert.equal(out.length, 1);
            assert.equal(out[0], reg);
            assert.equal(fontCssUrls().length, 1);
        } finally { cleanup(root); }
    });

    test('空文件（0 字节）不算就绪：损坏/中断产物不得被当字体加载', () => {
        const root = tmpDir('misans-empty');
        try {
            putCss(root, 'Regular', 0);
            putCss(root, 'Bold', 10);
            const { readyCssPaths } = loadMisans(root);
            assert.equal(readyCssPaths().length, 0);
        } finally { cleanup(root); }
    });

    test('体积门槛边界：恰好 1024 字节不算就绪，1025 字节算就绪（严格 >1024）', () => {
        const root = tmpDir('misans-size');
        try {
            putCss(root, 'Regular', 1024);
            putCss(root, 'Bold', 1025);
            const out = loadMisans(root).readyCssPaths();
            assert.equal(out.length, 1, '1024 不算、1025 算');
            assert.ok(out[0].endsWith('MiSans-Bold.min.css'));
        } finally { cleanup(root); }
    });

    test('fontCssUrls：就绪路径转 file:// URL（含字重文件名与 vendor/misans 段）', () => {
        const root = tmpDir('misans-url');
        try {
            putCss(root, 'Regular', 4096);
            putCss(root, 'Bold', 2048);
            const urls = loadMisans(root).fontCssUrls();
            assert.equal(urls.length, 2);
            for (const u of urls) {
                assert.ok(u.startsWith('file:///'), `应为 file:// URL，实际 ${u}`);
            }
            assert.ok(urls[0].includes('/vendor/misans/MiSans-Regular.min.css'));
            assert.ok(urls[1].includes('/vendor/misans/MiSans-Bold.min.css'));
            // URL 解码后应指回真实文件路径（渲染层 <link> 能真正加载）
            const decoded = decodeURIComponent(urls[0].replace('file:///', ''));
            assert.ok(decoded.replace(/\//g, path.sep).endsWith(path.join('vendor', 'misans', 'MiSans-Regular.min.css')));
        } finally { cleanup(root); }
    });

    test('去重：结果无重复路径，且不纳入 Medium 字重（避免 400 正文命中 380）', () => {
        const root = tmpDir('misans-dedupe');
        try {
            const reg = putCss(root, 'Regular', 4096);
            putCss(root, 'Medium', 4096); // 目录里存在也不应被采纳
            const out = loadMisans(root).readyCssPaths();
            assert.equal(out.length, 1, 'Medium 不在 WEIGHTS 内');
            assert.equal(out[0], reg);
            assert.equal(new Set(out).size, out.length, '结果不得有重复路径');
        } finally { cleanup(root); }
    });

    test('ensureMisans：就绪时 resolve(true) 且不打印降级提示', async () => {
        const root = tmpDir('misans-ok');
        try {
            putCss(root, 'Regular', 4096);
            const logs = [];
            const mod = loadMisans(root, { console: { log: (m) => logs.push(String(m)), warn: () => {}, error: () => {} } });
            assert.equal(await mod.ensureMisans(), true);
            assert.equal(logs.length, 0, '就绪不得打「回退系统字体」');
        } finally { cleanup(root); }
    });

    test('ensureMisans：未就绪时 resolve(false) 并打印回退提示（打包内置，无运行时下载）', async () => {
        const root = tmpDir('misans-fallback');
        try {
            const logs = [];
            const mod = loadMisans(root, { console: { log: (m) => logs.push(String(m)), warn: () => {}, error: () => {} } });
            assert.equal(await mod.ensureMisans(), false);
            assert.ok(logs.some((l) => l.includes('回退系统字体')), '应提示降级');
            assert.ok(!logs.some((l) => l.includes('http')), '不得触发任何下载日志');
        } finally { cleanup(root); }
    });

    test('ensureMisans 幂等：连续调用返回值一致，且不落盘/不改目录内容', async () => {
        const root = tmpDir('misans-idempotent');
        try {
            putCss(root, 'Bold', 4096);
            const mod = loadMisans(root, { console: { log: () => {}, warn: () => {}, error: () => {} } });
            const a = await mod.ensureMisans();
            const b = await mod.ensureMisans();
            const c = await mod.ensureMisans();
            assert.deepEqual([a, b, c], [true, true, true]);
            // 目录内容未被改写（仅探测，不下载不写文件）
            assert.deepEqual(fs.readdirSync(path.join(root, 'vendor', 'misans')), ['MiSans-Bold.min.css']);
            assert.equal(fs.statSync(path.join(root, 'vendor', 'misans', 'MiSans-Bold.min.css')).size, 4096);
        } finally { cleanup(root); }
    });

    test('fs 探测抛错被吞：existsSync 抛错时不冒泡、按未就绪返回', () => {
        const { readyCssPaths, fontCssUrls } = loadModule('misans.js', {
            dirname: path.join(SRC_MAIN),
            electron: { app: { isPackaged: false } },
            stubs: { fs: { existsSync: () => { throw new Error('EACCES'); }, statSync: () => ({ size: 4096 }) } },
        });
        assert.doesNotThrow(() => readyCssPaths());
        assert.equal(readyCssPaths().length, 0);
        assert.equal(fontCssUrls().length, 0);
    });

    test('fs 探测抛错被吞：existsSync 为真但 statSync 抛错时同样按未就绪返回', () => {
        const { readyCssPaths } = loadModule('misans.js', {
            dirname: path.join(SRC_MAIN),
            electron: { app: { isPackaged: false } },
            stubs: { fs: { existsSync: () => true, statSync: () => { throw new Error('ESTALE'); } } },
        });
        assert.doesNotThrow(() => readyCssPaths());
        assert.equal(readyCssPaths().length, 0);
    });

    test('ROOT 解析：isPackaged=false 时取 __dirname 上两级（开发态仓库根）', () => {
        const root = tmpDir('misans-dev');
        try {
            const p = putCss(root, 'Regular', 4096);
            const out = loadMisans(root, { electron: { app: { isPackaged: false } } }).readyCssPaths();
            assert.equal(out.length, 1);
            assert.equal(out[0], p);
        } finally { cleanup(root); }
    });

    test('ROOT 解析：isPackaged=true 时取 process.resourcesPath（extraResources 落点）', () => {
        const root = tmpDir('misans-packed');
        try {
            const dev = path.join(root, 'dev');
            const res = path.join(root, 'resources');
            putCss(dev, 'Regular', 4096);                 // 开发根（不应被读到）
            const packed = putCss(res, 'Bold', 4096);     // resources/vendor/misans
            const out = loadModule('misans.js', {
                dirname: path.join(dev, 'src', 'main'),
                electron: { app: { isPackaged: true } },
                process: { resourcesPath: res },
            }).readyCssPaths();
            assert.equal(out.length, 1);
            assert.equal(out[0], packed, '打包态必须读 resources 下的 vendor');
        } finally { cleanup(root); }
    });

    test('ROOT 解析：require("electron") 抛错时回退 __dirname 上两级（纯 Node 环境可用）', () => {
        const root = tmpDir('misans-noelectron');
        try {
            const p = putCss(root, 'Regular', 4096);
            const mod = loadModule('misans.js', { dirname: path.join(root, 'src', 'main'), electron: 'throw' });
            assert.equal(mod.readyCssPaths().length, 1);
            assert.equal(mod.readyCssPaths()[0], p);
        } finally { cleanup(root); }
    });
});

// ================================================================ app-icon

describe('app-icon', () => {
    /** 在临时根下铺 assets（tray-16/20/24/32 + icon.png），内容即文件名便于断言 buffer 来源。 */
    function putAssets(root, names) {
        const tray = path.join(root, 'assets', 'tray');
        fs.mkdirSync(tray, { recursive: true });
        fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
        for (const n of names) {
            const p = n.includes(path.sep) || n === 'icon.png'
                ? path.join(root, 'assets', n)
                : path.join(tray, n);
            fs.writeFileSync(p, `PNG:${n}`);
        }
        return root;
    }

    const ALL = ['tray-16.png', 'tray-20.png', 'tray-24.png', 'tray-32.png', 'icon.png'];

    /** nativeImage 替身：记录 addRepresentation 调用；可让 isEmpty/add 按需表现。 */
    function makeNativeImage(opt) {
        const o = opt || {};
        const reps = [];
        const img = {
            addRepresentation(r) {
                reps.push({ scaleFactor: r.scaleFactor, text: r.buffer ? r.buffer.toString('utf8') : null });
                if (o.throwOnAdd) throw new Error('bad representation buffer');
            },
            isEmpty: () => !!o.isEmpty,
        };
        return { img, reps };
    }

    /**
     * 加载 app-icon.js 并注入 electron 桩。
     * throw* 开关用于模拟各条失败降级路径（资源异常一律回落 exe 图标，不崩）。
     */
    function loadAppIcon(root, ni, opt) {
        const o = opt || {};
        const electron = o.electron === 'throw' ? 'throw' : {
            app: { getAppPath: o.throwOnGetAppPath ? () => { throw new Error('no app path'); } : () => root },
            nativeImage: {
                createEmpty: o.throwOnCreate ? () => { throw new Error('no nativeImage'); } : () => ni.img,
            },
        };
        return loadModule('app-icon.js', {
            electron,
            stubs: o.throwOnRead
                ? { fs: { existsSync: () => true, readFileSync: () => { throw new Error('EACCES'); } } }
                : undefined,
        });
    }

    test('导出契约：只暴露 windowIcon 一个函数', () => {
        const dir = tmpDir('icon-api');
        try {
            const mod = loadAppIcon(dir, makeNativeImage());
            assert.deepEqual(Object.keys(mod), ['windowIcon']);
            assert.equal(typeof mod.windowIcon, 'function');
        } finally { cleanup(dir); }
    });

    test('五份资源齐全：按 DPI 组多表示，scaleFactor 依次 1 / 1.25 / 1.5 / 2 / 1', () => {
        const root = putAssets(tmpDir('icon-all'), ALL);
        try {
            const ni = makeNativeImage();
            const img = loadAppIcon(root, ni).windowIcon();
            assert.equal(img, ni.img, 'loaded>0 且非空时应返回同一张图');
            assert.equal(ni.reps.length, 5);
            assert.equal(ni.reps.map((r) => r.scaleFactor).join(','), '1,1.25,1.5,2,1');
        } finally { cleanup(root); }
    });

    test('buffer 取自真实文件字节：readFileSync 结果原样入表示（16→tray-16，icon.png→兜底大图）', () => {
        const root = putAssets(tmpDir('icon-buf'), ALL);
        try {
            const ni = makeNativeImage();
            loadAppIcon(root, ni).windowIcon();
            const texts = ni.reps.map((r) => r.text);
            assert.equal(texts.join('|'), 'PNG:tray-16.png|PNG:tray-20.png|PNG:tray-24.png|PNG:tray-32.png|PNG:icon.png');
        } finally { cleanup(root); }
    });

    test('部分资源缺失（缺 tray-20/24）：跳过 1.25/1.5，只登记存在的表示', () => {
        const root = putAssets(tmpDir('icon-partial'), ['tray-16.png', 'tray-32.png', 'icon.png']);
        try {
            const ni = makeNativeImage();
            const img = loadAppIcon(root, ni).windowIcon();
            assert.equal(img, ni.img);
            assert.equal(ni.reps.length, 3);
            assert.equal(ni.reps.map((r) => r.scaleFactor).join(','), '1,2,1');
            assert.equal(ni.reps.every((r) => r.text.startsWith('PNG:')), true);
        } finally { cleanup(root); }
    });

    test('tray 全缺、仅 icon.png 在：仍返回图标（大图兜底，不回落 exe 图标）', () => {
        const root = putAssets(tmpDir('icon-onlybase'), ['icon.png']);
        try {
            const ni = makeNativeImage();
            const img = loadAppIcon(root, ni).windowIcon();
            assert.equal(img, ni.img);
            assert.equal(ni.reps.length, 1);
            assert.equal(ni.reps[0].scaleFactor, 1);
            assert.equal(ni.reps[0].text, 'PNG:icon.png');
        } finally { cleanup(root); }
    });

    test('资源全缺失：返回 undefined 且不抛（回落 exe 图标）', () => {
        const root = tmpDir('icon-none');
        try {
            const ni = makeNativeImage();
            const img = loadAppIcon(root, ni).windowIcon();
            assert.equal(img, undefined);
            assert.equal(ni.reps.length, 0, '一个文件都没读到就不该登记任何表示');
        } finally { cleanup(root); }
    });

    test('nativeImage 判定为空图（isEmpty() 为真）：即使 loaded>0 也返回 undefined', () => {
        const root = putAssets(tmpDir('icon-emptyimg'), ALL);
        try {
            const ni = makeNativeImage({ isEmpty: true });
            const img = loadAppIcon(root, ni).windowIcon();
            assert.equal(img, undefined, 'loaded>0 && !isEmpty() 才算成功');
            assert.equal(ni.reps.length, 5, '表示确实登记过，只是 nativeImage 仍为空');
        } finally { cleanup(root); }
    });

    test('require("electron") 抛错（不在 Electron 进程内）：返回 undefined 不崩', () => {
        const root = putAssets(tmpDir('icon-noelectron'), ALL);
        try {
            const ni = makeNativeImage();
            const mod = loadModule('app-icon.js', { electron: 'throw' });
            assert.doesNotThrow(() => mod.windowIcon());
            assert.equal(mod.windowIcon(), undefined);
            assert.equal(ni.reps.length, 0);
        } finally { cleanup(root); }
    });

    test('app.getAppPath 抛错：被 catch 兜底为 undefined（回落 exe 图标）', () => {
        const root = putAssets(tmpDir('icon-nopath'), ALL);
        try {
            const ni = makeNativeImage();
            const img = loadAppIcon(root, ni, { throwOnGetAppPath: true }).windowIcon();
            assert.equal(img, undefined);
            assert.equal(ni.reps.length, 0);
        } finally { cleanup(root); }
    });

    test('addRepresentation 抛错（坏 buffer）：异常不冒泡，返回 undefined', () => {
        const root = putAssets(tmpDir('icon-badadd'), ALL);
        try {
            const ni = makeNativeImage({ throwOnAdd: true });
            const mod = loadAppIcon(root, ni, { throwOnAdd: true });
            assert.doesNotThrow(() => mod.windowIcon());
            assert.equal(mod.windowIcon(), undefined);
        } finally { cleanup(root); }
    });

    test('readFileSync 抛错（权限/占用）：异常不冒泡，返回 undefined', () => {
        const root = putAssets(tmpDir('icon-badread'), ALL);
        try {
            const ni = makeNativeImage();
            const mod = loadAppIcon(root, ni, { throwOnRead: true });
            assert.doesNotThrow(() => mod.windowIcon());
            assert.equal(mod.windowIcon(), undefined);
        } finally { cleanup(root); }
    });

    test('只读不写：windowIcon 调用前后资源文件内容与数量不变', () => {
        const root = putAssets(tmpDir('icon-readonly'), ALL);
        try {
            const before = fs.readdirSync(path.join(root, 'assets', 'tray')).sort().join(',');
            loadAppIcon(root, makeNativeImage()).windowIcon();
            const after = fs.readdirSync(path.join(root, 'assets', 'tray')).sort().join(',');
            assert.equal(after, before);
            assert.equal(fs.readFileSync(path.join(root, 'assets', 'tray', 'tray-16.png'), 'utf8'), 'PNG:tray-16.png');
        } finally { cleanup(root); }
    });
});
