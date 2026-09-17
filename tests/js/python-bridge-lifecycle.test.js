'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const bridgePath = path.join(__dirname, '../../src/main/python-bridge.js');

function loadBridge(childProcessModule, opts = {}) {
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'electron') return { app: { isPackaged: Boolean(opts.isPackaged) } };
        if (request === 'child_process' && childProcessModule) return childProcessModule;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve(bridgePath)];
        return require(bridgePath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve(bridgePath)];
    }
}

test('Windows backend stop requests taskkill for the full process tree', () => {
    let taskkill = null;
    let killedDirectly = false;
    const PythonBridge = loadBridge({
        spawn() { throw new Error('spawn should not be used by stop test'); },
        spawnSync(command, args, options) {
            taskkill = { command, args, options };
            return { status: 0 };
        },
    });
    const bridge = new PythonBridge('C:\\fixture', 'C:\\fixture');
    bridge.proc = { pid: 43210, kill() { killedDirectly = true; } };
    bridge.info = { port: 1, token: 'fixture', base: 'http://127.0.0.1:1' };
    bridge.stop();
    if (process.platform === 'win32') {
        assert.equal(taskkill.command, 'taskkill');
        assert.deepEqual(taskkill.args, ['/PID', '43210', '/T', '/F']);
        assert.equal(taskkill.options.windowsHide, true);
        assert.equal(killedDirectly, false);
    } else {
        assert.equal(killedDirectly, true);
    }
    assert.equal(bridge.proc, null);
    assert.equal(bridge.stopping, true);
});

test('Windows backend stop falls back when taskkill returns nonzero', () => {
    let killedDirectly = false;
    const PythonBridge = loadBridge({
        spawn() { throw new Error('spawn should not be used by stop test'); },
        spawnSync() { return { status: 128 }; },
    });
    const bridge = new PythonBridge('C:\\fixture', 'C:\\fixture');
    bridge.proc = { pid: 43211, kill() { killedDirectly = true; } };
    bridge.stop();
    assert.equal(killedDirectly, true);
});

async function reservePorts(count) {
    const reservations = [];
    for (let index = 0; index < count; index += 1) {
        const server = net.createServer();
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        reservations.push(server);
    }
    const ports = reservations.map((server) => server.address().port);
    await Promise.all(reservations.map((server) => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    })));
    return ports;
}

function pidExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error && error.code === 'EPERM';
    }
}

function portAccepts(port) {
    return new Promise((resolve) => {
        const client = net.createConnection({ host: '127.0.0.1', port });
        const finish = (value) => {
            client.removeAllListeners();
            client.destroy();
            resolve(value);
        };
        client.setTimeout(250, () => finish(false));
        client.once('connect', () => finish(true));
        client.once('error', () => finish(false));
    });
}

async function waitUntil(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(message);
}

function readJsonLine(proc, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('process tree fixture timeout')), timeoutMs);
        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            clearTimeout(timer);
            try { resolve(JSON.parse(buffer.slice(0, newline))); } catch (error) { reject(error); }
        });
        proc.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`process tree fixture exited early (${code})`));
        });
    });
}

test('packaged Windows does not spawn backend when system VC++ runtime is missing', () => {
    if (process.platform !== 'win32') return;
    const sysRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'yuki-sysroot-'));
    const prevSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = sysRoot; // 空目录 = 无 vcruntime140*.dll
    try {
        let spawnCalled = false;
        const PythonBridge = loadBridge({
            spawn() { spawnCalled = true; throw new Error('spawn must not happen'); },
            spawnSync() { return { status: 0 }; },
        }, { isPackaged: true });
        const bridge = new PythonBridge('C:\\fixture', 'C:\\fixture');
        const states = [];
        let vcrtEvents = null;
        bridge.on('state', (s) => states.push(s));
        bridge.on('vcrt-missing', (missing) => { vcrtEvents = missing; });
        bridge.start();
        assert.equal(spawnCalled, false, '运行库缺失时不得 spawn（Windows 会弹系统错误框）');
        assert.deepEqual(states, ['vcrt-missing']);
        assert.deepEqual(vcrtEvents, ['vcruntime140.dll', 'vcruntime140_1.dll']);
    } finally {
        if (prevSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = prevSystemRoot;
        fs.rmSync(sysRoot, { recursive: true, force: true });
    }
});

test('packaged Windows spawns backend when system VC++ runtime present', () => {
    if (process.platform !== 'win32') return;
    const sysRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'yuki-sysroot-'));
    const sys32 = path.join(sysRoot, 'System32');
    fs.mkdirSync(sys32);
    fs.writeFileSync(path.join(sys32, 'vcruntime140.dll'), '');
    fs.writeFileSync(path.join(sys32, 'vcruntime140_1.dll'), '');
    const prevSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = sysRoot;
    try {
        const fakeProc = { stdout: { on() {} }, stderr: { on() {} }, on() {}, pid: 4242, kill() {} };
        let spawnCalled = false;
        const PythonBridge = loadBridge({
            spawn() { spawnCalled = true; return fakeProc; },
            spawnSync() { return { status: 0 }; },
        }, { isPackaged: true });
        const bridge = new PythonBridge('C:\\fixture', 'C:\\fixture');
        const states = [];
        bridge.on('state', (s) => states.push(s));
        bridge.start();
        assert.equal(spawnCalled, true);
        assert.deepEqual(states, ['starting']);
    } finally {
        if (prevSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = prevSystemRoot;
        fs.rmSync(sysRoot, { recursive: true, force: true });
    }
});

function makeFakeProc() {
    const handlers = {};
    const proc = {
        stdout: { on(event, fn) { handlers[`stdout:${event}`] = fn; } },
        stderr: { on() {} },
        on(event, fn) { handlers[event] = fn; },
        pid: 4242,
        killed: false,
        exitCode: null,
        kill() { proc.killed = true; },
        __emitStdout(text) { handlers['stdout:data']({ toString: () => text }); },
        // 预置 no-op 监听，保证手动桥接 proc（未经 _spawn）也能派发 exit
        __emitExit(code) { (handlers.exit || (() => {}))(code); },
    };
    return proc;
}

test('stdout READY buffer is bounded before ready and trimmed after ready', () => {
    const fakeProc = makeFakeProc();
    const PythonBridge = loadBridge({ spawn() { return fakeProc; }, spawnSync() { return { status: 0 }; } });
    const bridge = new PythonBridge('C:\\fixture', 'C:\\fixture');
    // 健康检查定时器来自 ready 路径：断言失败也必须清理，否则 15s setInterval
    // 会让 node --test 永不退出（run-jsunit 的 spawnSync 无超时）——try/finally 兜底
    try {
        let readyInfo = null;
        bridge.on('ready', (info) => { readyInfo = info; });
        bridge._spawn();
        // (a) READY 命中后截断：超长日志不再累积（尾部保留仅 4KB 量级）
        fakeProc.__emitStdout(`noise\nYUKI_BACKEND_READY port=8765 token=tok-secret\n`);
        assert.ok(readyInfo, 'READY 行必须触发 ready');
        assert.equal(readyInfo.port, 8765);
        assert.equal(readyInfo.token, 'tok-secret');
        for (let i = 0; i < 100; i += 1) fakeProc.__emitStdout(`x`.repeat(64 * 1024));
        assert.ok(bridge._stdoutBuf.length <= 4096,
            `就绪后缓冲应只保留小尾部，实际 ${bridge._stdoutBuf.length}`);
    } finally {
        bridge._stopHealthCheck();
    }
});

test('stdout buffer discards front half while waiting for READY', () => {
    const fakeProc = makeFakeProc();
    const PythonBridge = loadBridge({ spawn() { return fakeProc; }, spawnSync() { return { status: 0 }; } });
    const bridge = new PythonBridge('C:\\fixture', 'C:\\fixture');
    // 同上：后半段匹配 READY 后会启动健康检查定时器，finally 确保清理
    try {
        bridge._spawn();
        // (a') 后端始终打不出 READY：缓冲有上限（1MB），超限丢前半段、保留尾部
        for (let i = 0; i < 40; i += 1) fakeProc.__emitStdout(`y`.repeat(64 * 1024));
        assert.ok(bridge._stdoutBuf.length <= 1024 * 1024,
            `未就绪缓冲应有上限，实际 ${bridge._stdoutBuf.length}`);
        // 丢弃前半段后仍能匹配新到达的 READY 行（保留尾部语义）
        fakeProc.__emitStdout(`YUKI_BACKEND_READY port=1 token=a\n`);
        assert.ok(bridge.info, '缓冲截断后 READY 仍须可匹配');
        assert.equal(bridge.info.port, 1);
    } finally {
        bridge._stopHealthCheck();
    }
});

test('stop() cancels pending crash restart timer', () => {
    const procs = [];
    const PythonBridge = loadBridge({
        spawn() { const proc = makeFakeProc(); procs.push(proc); return proc; },
        spawnSync() { return { status: 0 }; },
    });
    const bridge = new PythonBridge('C:\\fixture', 'C:\\fixture');
    // (b) 走真实 _spawn 接线（exit 监听由 _spawn 注册），再模拟崩溃调度重启
    bridge._spawn();
    bridge.backoff = 10; // 压缩退避，避免测试真实等待 1s+
    const dead = bridge.proc;
    dead.__emitExit(1);
    assert.equal(bridge._restartTimer !== null, true, '崩溃后应存在挂起的重启定时器');
    bridge.stop();
    assert.equal(bridge._restartTimer, null, 'stop() 必须取消挂起的重启定时器');
    // 定时器已取消：等待超过原退避间隔也不会触发 _spawn（spawn 再入栈即失败）
    const delayMs = bridge.backoff + 20;
    return new Promise((resolve) => setTimeout(resolve, delayMs)).then(() => {
        assert.equal(procs.length, 1, '取消后不得再拉起新进程');
    });
});

test('crash restart fires _spawn once after backoff', () => {
    const procs = [];
    const PythonBridge = loadBridge({
        spawn() {
            const proc = makeFakeProc();
            procs.push(proc);
            return proc;
        },
        spawnSync() { return { status: 0 }; },
    });
    const bridge = new PythonBridge('C:\\fixture', 'C:\\fixture');
    bridge._spawn();
    bridge.backoff = 10; // 压缩退避：exit 回调按调度时的 backoff 计算延迟
    bridge.proc.__emitExit(0);
    assert.equal(procs.length, 1, '退避期内不应立即 spawn');
    return new Promise((resolve) => setTimeout(resolve, 120)).then(() => {
        assert.equal(procs.length, 2, '退避到点应重启一次');
        assert.equal(bridge._restartTimer, null, '重启触发后定时器句柄应清空');
    });
});

test('_spawn does not duplicate while a live proc exists', () => {
    let spawnCalls = 0;
    const PythonBridge = loadBridge({
        spawn() {
            spawnCalls += 1;
            return makeFakeProc();
        },
        spawnSync() { return { status: 0 }; },
    });
    const bridge = new PythonBridge('C:\\fixture', 'C:\\fixture');
    // (c) 已有存活进程（exitCode=null）：再次 _spawn 不得重复拉起
    bridge._spawn();
    assert.equal(spawnCalls, 1);
    bridge._spawn();
    bridge._spawn();
    assert.equal(spawnCalls, 1, '存活进程存在时重复 _spawn 必须被守卫拦截');
    // killed=true 但 exit 未到（exitCode 仍为 null）：同样不重复 spawn
    bridge.proc.kill();
    bridge._spawn();
    assert.equal(spawnCalls, 1, '已 kill 未退出的进程也不得重复 spawn');
    // exit 之后（exitCode 非 null）：守卫放行，可重新 spawn
    bridge.proc.exitCode = 1;
    bridge._spawn();
    assert.equal(spawnCalls, 2, '已退出进程后应允许重新 spawn');
});

test('stop then start respawns a fresh backend', () => {
    const procs = [];
    const PythonBridge = loadBridge({
        spawn() {
            const proc = makeFakeProc();
            procs.push(proc);
            return proc;
        },
        // 返回失败 status，命中 stop() 的 proc.kill() 回退分支，确保 fake 进程
        // 被标记 killed（win32 上正常 status=0 时走 taskkill，不会调 kill()）
        spawnSync() { return { status: 1 }; },
    });
    const bridge = new PythonBridge('C:\\fixture', 'C:\\fixture');
    // (c') 正常 stop→start 流程不受守卫影响：stop kill 并清 proc，start 能重启
    bridge.start();
    assert.equal(procs.length, 1);
    bridge.stop();
    assert.equal(procs[0].killed, true);
    assert.equal(bridge.proc, null);
    bridge.start();
    assert.equal(procs.length, 2, 'stop→start 后必须能拉起新后端');
    assert.notEqual(bridge.proc, procs[0]);
});

test('real Windows app stop releases Python Java Node descendants and ports', async () => {
    if (process.platform !== 'win32') return;
    const root = path.join(__dirname, '../..');
    const fixtureDir = path.join(__dirname, 'fixtures');
    const runtimeDir = path.join(root, 'python-backend', '.test-runtime', 'node-lifecycle');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const compile = childProcess.spawnSync(
        'javac', ['-encoding', 'UTF-8', '-d', runtimeDir,
            path.join(fixtureDir, 'ResourceTreeChild.java')],
        { windowsHide: true, encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr || compile.error);
    const venvPython = path.join(root, 'python-backend', '.venv', 'Scripts', 'python.exe');
    const python = fs.existsSync(venvPython) ? venvPython : 'python';
    const ports = await reservePorts(4);
    const parent = childProcess.spawn(
        python,
        [path.join(fixtureDir, 'process-tree-parent.py'), ...ports.map(String),
            process.execPath, 'java', runtimeDir],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let bridge;
    try {
        const state = await readJsonLine(parent);
        assert.deepEqual(state.ports, ports);
        const PythonBridge = loadBridge();
        bridge = new PythonBridge(root, root);
        bridge.proc = parent;
        bridge.stop();
        const pids = [state.rootPid, state.pythonPid, state.nodePid, state.javaPid];
        await waitUntil(() => pids.every((pid) => !pidExists(pid)), 5000,
            `process tree still alive: ${pids.filter(pidExists).join(',')}`);
        await waitUntil(async () => {
            const accepting = await Promise.all(ports.map(portAccepts));
            return accepting.every((value) => !value);
        }, 5000, `released ports still accept connections: ${ports.join(',')}`);
    } finally {
        if (pidExists(parent.pid)) {
            childProcess.spawnSync('taskkill', ['/PID', String(parent.pid), '/T', '/F'],
                { windowsHide: true, stdio: 'ignore' });
        }
        if (bridge) bridge.proc = null;
    }
});
