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
