// 组件测试（实现）：hls-downloader.js ffmpeg 进程登记与 cleanup() 收敛
// 本文件由 hls-cleanup.test.js 以 HLS_CLEANUP_MOCK=1 / HLS_CLEANUP_REAL=1 的环境变量
// 在隔离子进程内分发执行；直接以 node --test 全量运行时两个实现用例都会正常通过。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

// 无 vendor ffmpeg 的环境（CI）也能跑 mock 用例：findFfmpeg() 返回 null 时
// h.add() 抛 ffmpeg-missing，任务建不出来——桩掉 './ffmpeg' 模块绕过该依赖。
// 只含 hls-downloader.js 实际解构的 findFfmpeg（其余成员兜底空实现）。
const FFMPEG_MODULE = './ffmpeg';
const FAKE_FFMPEG = {
    findFfmpeg: () => 'C:\\fake\\ffmpeg.exe',
    ensureFfmpeg: async () => {},
    isEnsuring: () => false,
    thumb: async () => null,
    urlThumb: async () => null,
};

/** 加载 hls-downloader 并按 needFfmpeg 桩 child_process / ffmpeg 模块。 */
function loadDownloader(childProcessModule) {
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'child_process' && childProcessModule) return childProcessModule;
        if (request === FFMPEG_MODULE) return FAKE_FFMPEG;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../../src/main/hls-downloader')];
        return require('../../src/main/hls-downloader');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../../src/main/hls-downloader')];
    }
}

// ===== mock 分支：桩 child_process，验证 spawn 登记 / 全杀 / 幂等 =====
if (process.env.HLS_CLEANUP_MOCK === '1') {
    /** 桩子进程：可配置 kill 行为与初始存活状态，记录事件监听供手动触发。 */
    function makeProc(pid, opts = {}) {
        const listeners = {};
        const p = {
            pid,
            killed: false,
            exitCode: opts.exitCode === undefined ? null : opts.exitCode, // null=在跑
            signalCode: null,
            killedWith: null,
            kill(sig) {
                p.killed = true;
                p.killedWith = sig || 'SIGTERM';
                return true;
            },
            once(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return p; },
            on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return p; },
            stderr: { on() {} },
            _emit(ev, ...rest) { for (const fn of listeners[ev] || []) fn(...rest); },
        };
        return p;
    }

    test('hls cleanup [mock]: _spawn 登记进程、cleanup 全杀存活项、退出项自移除、重复调用幂等', async () => {
        const spawned = [];
        let HlsDownloader;
        try {
            HlsDownloader = loadDownloader({
                // 桩 ffmpeg：spawn 后不退出，模拟长时间合成
                spawn(bin, args, o) {
                    const proc = makeProc(1000 + spawned.length, { args });
                    spawned.push({ proc, args, opts: o });
                    return proc;
                },
                spawnSync() { return { status: 0 }; },
                execSync() { throw new Error('no system proxy in test'); },
            });
        } finally {
            delete require.cache[require.resolve('../../src/main/hls-downloader')];
        }
        // 桩掉全局 fetch：probeDuration 走网络会拖慢/挂起测试；抛错即按「时长未知」跳过
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => { throw new Error('offline test'); };

        const h = new HlsDownloader();
        h.dir = os.tmpdir();
        h.setConcurrency(1);
        h.setMaxActive(3);
        const gid = h.add({ url: 'https://example.com/a.m3u8', out: 'cleanup-mock.mp4', concurrency: 1 });
        assert.ok(gid, '任务应创建成功');
        // 等 _run 异步续体（probeDuration 抛错返回 0 → _spawn）执行到位
        await new Promise((r) => setTimeout(r, 50));
        globalThis.fetch = origFetch;
        assert.equal(spawned.length, 1, 'ffmpeg 顺序拉流模式应 spawn 一次');
        assert.equal(spawned[0].opts.windowsHide, true, 'spawn 需带 windowsHide');
        assert.equal(h._procs.size, 1, 'spawn 出的进程应被登记');
        assert.ok(h._procs.has(spawned[0].proc));

        // 直接登记两种边界形态（等价于其余 spawn 点登记后的生命周期变化）：
        //  - exited：exit 事件已发 → 注册表应已自动移除
        const exited = makeProc(2001);
        h._registerProc(exited);
        exited._emit('exit', 0);
        assert.ok(!h._procs.has(exited), 'exit 事件后应自移除');
        //  - dead：exitCode 非 null 但尚未发 exit 事件 → cleanup 应过滤不杀
        const dead = makeProc(2002, { exitCode: 1 });
        h._registerProc(dead);

        h.cleanup();
        const live = spawned[0].proc;
        assert.equal(live.killed, true, '存活的 ffmpeg 应被 kill');
        assert.equal(live.killedWith, 'SIGTERM', '先常规 kill（与仓库其他 stop 路径一致）');
        if (process.platform === 'win32') {
            assert.equal(dead.killed, false, '已死进程不应再 kill');
        }
        assert.ok(!h._procs.has(live) && !h._procs.has(dead), 'cleanup 后注册表应清空');

        // 幂等：对空注册表重复调用无操作；新登记的存活项重复 cleanup 仍收敛
        h.cleanup();
        h.cleanup();
        assert.equal(h._procs.size, 0);
        const again = makeProc(2003);
        h._registerProc(again);
        h.cleanup();
        assert.equal(again.killed, true);
        assert.equal(h._procs.size, 0);
    });

    test('hls cleanup [mock]: remove 杀任务进程后注册表随 exit 自清理，cleanup 不误伤', async () => {
        const spawned = [];
        let HlsDownloader;
        try {
            HlsDownloader = loadDownloader({
                spawn() {
                    const proc = makeProc(3000 + spawned.length);
                    spawned.push(proc);
                    return proc;
                },
                spawnSync() { return { status: 0 }; },
                execSync() { throw new Error('no system proxy in test'); },
            });
        } finally {
            delete require.cache[require.resolve('../../src/main/hls-downloader')];
        }
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => { throw new Error('offline test'); };

        const h = new HlsDownloader();
        h.dir = os.tmpdir();
        const gid = h.add({ url: 'https://example.com/b.m3u8', out: 'cleanup-mock2.mp4', concurrency: 1 });
        await new Promise((r) => setTimeout(r, 50));
        globalThis.fetch = origFetch;
        const proc = spawned[0];
        assert.equal(h._procs.size, 1);
        h.remove(gid); // 任务删除杀进程（既有行为）
        assert.equal(proc.killed, true, 'remove 应杀任务进程');
        assert.equal(h._procs.size, 1, 'kill 本身不移除，等 exit 事件');
        proc._emit('exit', 1);
        assert.equal(h._procs.size, 0, 'exit 后自移除');
        h.cleanup(); // 空表无操作
        assert.equal(h._procs.size, 0);
    });
}

// ===== real 分支：vendor ffmpeg 真实 spawn，验证 cleanup 收敛在跑进程 =====
if (process.env.HLS_CLEANUP_REAL === '1') {
    // 本地「卡死源」：accept 后收下请求头就持住连接不回应——ffmpeg 会一直等
    // 分片数据，进程稳定存活，正好用来验证 cleanup() 的真实收敛能力。
    function startStallServer() {
        const sockets = new Set();
        const server = require('node:net').createServer((socket) => {
            sockets.add(socket);
            socket.on('error', () => {});
            socket.once('data', () => { /* 收到请求头后保持静默，不回响应 */ });
        });
        return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, sockets })));
    }

    test('hls cleanup [real]: cleanup 杀掉在跑的 ffmpeg，不落地成品文件', { timeout: 45000 }, async () => {
        const HlsDownloader = require('../../src/main/hls-downloader');
        const bin = process.env.HLS_CLEANUP_FFMPEG;
        assert.ok(bin && fs.existsSync(bin), '需要 vendor ffmpeg');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-hls-cleanup-'));
        const { server, sockets } = await startStallServer();
        let h = null;
        try {
            const port = server.address().port;
            // 本地慢速源（分片指向本机 stall 端口，ffmpeg 会一直等流），直接驱动
            // _spawn：add 的 M-2 校验只放行 http(s)，此处绕过入口构造等价任务
            const task = {
                gid: 'hls-cleanup-real', kind: 'hls', name: 'cleanup-real.mp4',
                url: `http://127.0.0.1:${port}/stall.m3u8`, header: null, dir: dir,
                status: 'active', percent: 0, done: 0, total: 0, speed: 0,
                errorMessage: '', files: [path.join(dir, 'cleanup-real.mp4')],
                _dest: path.join(dir, 'cleanup-real.mp4'), _bin: bin, _proc: null,
                _retried: false, _transcodeRetried: false, adFilter: false, _adTemp: null,
                _input: null, _mode: 'ffmpeg', _segConc: 1, _segsDir: `${path.join(dir, 'cleanup-real.mp4')}.segs`,
                _segments: null, _totalSegs: 0, _downloaded: 0, _segBytes: 0,
                _speedTimer: null, _speedLastBytes: 0, _speedLastTs: 0, _gen: 0,
            };
            h = new HlsDownloader();
            h.setDir(dir);
            h.setMaxActive(1);
            h._tasks.set(task.gid, task);
            h._spawn(task, true);
            // 等 ffmpeg 真正被拉起并进入拉流循环（stall 源不会自行退出）
            let proc = null;
            for (let i = 0; i < 100 && !proc; i++) {
                await new Promise((r) => setTimeout(r, 100));
                proc = [...h._procs].find((p) => p.exitCode === null) || null;
            }
            assert.ok(proc, 'ffmpeg 应被登记为在跑进程');
            assert.ok(task._proc, 'task._proc 应指向在跑的 ffmpeg');
            // 收口前快照：用于断言「无重启」（respawn 会产生不同的新 pid）
            const pid = proc.pid;
            const pidsBefore = new Set([...h._procs].map((p) => p.pid));
            h.cleanup();
            assert.equal(h._procs.size, 0, 'cleanup 后注册表应清空');
            // Windows taskkill /T /F 异步；轮询确认进程消失（或句柄上报退出）
            let gone = false;
            for (let i = 0; i < 50 && !gone; i++) {
                await new Promise((r) => setTimeout(r, 100));
                if (proc.exitCode !== null || proc.signalCode !== null) { gone = true; break; }
                try { process.kill(pid, 0); } catch (e) { gone = true; }
            }
            assert.ok(gone, 'ffmpeg 进程应在 5s 内被终止');
            // 无重启：2s 内不得为同一任务再拉起新的 ffmpeg（respawn 回归会被此处抓到）
            await new Promise((r) => setTimeout(r, 2000));
            const pidsAfter = new Set([...(h._procs || [])].map((p) => p.pid));
            const respawned = [...pidsAfter].filter((p) => !pidsBefore.has(p));
            assert.equal(respawned.length, 0, `cleanup 后不得为新任务重新拉起 ffmpeg: ${respawned.join(',')}`);
            // 新进程的存活校验（exitCode 尚未上报时以 pid 为准）
            for (const p of (h._procs || [])) {
                assert.throws(() => process.kill(p.pid, 0), 'cleanup 后登记的进程应已死亡');
            }
            await new Promise((r) => setTimeout(r, 300));
            assert.ok(!fs.existsSync(task._dest), '被杀任务不应产出成品文件');
        } finally {
            if (h) h.cleanup(); // 断言失败路径也要收敛 ffmpeg，防挂后台
            for (const socket of sockets) { try { socket.destroy(); } catch (e) { /* ignore */ } }
            server.close();
            fs.rmSync(dir, { recursive: true, force: true }); // try/finally：失败路径不泄漏临时目录
        }
    });
}
