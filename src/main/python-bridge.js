/**
 * python-bridge.js — Python 后端子进程管理
 *
 * 职责：spawn server.py → 解析 READY 行获得 port/token → 健康检查 →
 * 崩溃后指数退避重启（1s/2s/4s...上限 60s，就绪后重置）。
 *
 * 打包模式（app.isPackaged）：启动 PyInstaller 单文件 exe
 * （extraResources/python-backend/video-pc-backend.exe），无 venv 依赖。
 */
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const READY_RE = /VPC_BACKEND_READY port=(\d+) token=(\S+)/;
const HEALTH_INTERVAL = 15000;
const MAX_BACKOFF = 60000;

class PythonBridge extends EventEmitter {
    constructor(rootDir, resourcesRoot, opts = {}) {
        super();
        this.rootDir = rootDir;
        this.resourcesRoot = resourcesRoot || rootDir;
        // 开发模式：venv python + server.py；打包模式：PyInstaller 单文件 exe
        if (app.isPackaged) {
            this.backendDir = path.join(this.resourcesRoot, 'python-backend');
            this.script = path.join(this.backendDir, 'video-pc-backend.exe');
            this._isPackaged = true;
        } else {
            this.backendDir = path.join(this.rootDir, 'python-backend');
            this.script = path.join(this.backendDir, 'server.py');
            this._isPackaged = false;
        }
        this.proc = null;
        this.info = null;          // { port, token, base }
        this.stopping = false;
        this.backoff = 1000;
        this.healthTimer = null;
        this.readyWaiters = [];
        this.extraEnv = {};        // 附加环境变量（如自定义缓存目录 VPC_CACHE_DIR）
        this.logWriter = opts.logWriter || null;
    }

    _pythonExe() {
        if (this._isPackaged) return this.script; // PyInstaller exe 直接运行
        const venv = path.join(this.backendDir, '.venv', 'Scripts', 'python.exe');
        return fs.existsSync(venv) ? venv : 'python';
    }

    start() {
        this.stopping = false;
        this._spawn();
    }

    _spawn() {
        if (this.stopping) return;
        this.info = null; // info 只属于当前进程：换进程前重置，READY 行才能重新捕获新端口/token
        this.emit('state', 'starting');
        const args = this._isPackaged ? [] : ['-X', 'utf8', this.script];
        const proc = spawn(this._pythonExe(), args, {
            cwd: this.backendDir,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...this.extraEnv },
        });
        this.proc = proc;

        let buf = '';
        proc.stdout.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            buf += text;
            if (this.logWriter) this.logWriter.write('STDOUT', text.trimEnd());
            const m = buf.match(READY_RE);
            if (m && !this.info) {
                const port = parseInt(m[1], 10);
                this.info = { port, token: m[2], base: `http://127.0.0.1:${port}` };
                this.backoff = 1000;
                this._startHealthCheck();
                this.emit('ready', this.info);
                this.readyWaiters.forEach((r) => r(this.info));
                this.readyWaiters = [];
            }
        });
        proc.stderr.on('data', (chunk) => {
            if (this.logWriter) this.logWriter.write('STDERR', chunk.toString('utf8').trimEnd());
            process.stderr.write(`[python] ${chunk}`);
        });
        proc.on('exit', (code) => {
            // H-9：stop→start 已换新进程时旧进程的迟到 exit——直接忽略，
            // 不清掉新进程的 info/proc，也不再安排多余的 _spawn（防进程翻倍）
            if (this.proc !== proc) return;
            this._stopHealthCheck();
            this.info = null;
            this.proc = null;
            if (this.stopping) return;
            this.emit('state', 'restarting');
            const delay = this.backoff;
            this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
            console.log(`[python-bridge] backend exited (code=${code}), restart in ${delay}ms`);
            setTimeout(() => this._spawn(), delay);
        });
    }

    _startHealthCheck() {
        this._stopHealthCheck();
        this.healthTimer = setInterval(async () => {
            if (!this.info) return;
            try {
                const rsp = await fetch(`${this.info.base}/health`, { signal: AbortSignal.timeout(5000) });
                if (!rsp.ok) throw new Error(`status ${rsp.status}`);
            } catch (e) {
                console.warn(`[python-bridge] health check failed: ${e.message}, killing for restart`);
                if (this.proc) this.proc.kill();
            }
        }, HEALTH_INTERVAL);
    }

    _stopHealthCheck() {
        if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    }

    /** 供 IPC 调用：已就绪返回 info，否则等待（最多 timeoutMs）。 */
    getInfo(timeoutMs = 30000) {
        if (this.info) return Promise.resolve(this.info);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const i = this.readyWaiters.indexOf(waiter);
                if (i >= 0) this.readyWaiters.splice(i, 1);
                resolve(null);
            }, timeoutMs);
            const waiter = (info) => { clearTimeout(timer); resolve(info); };
            this.readyWaiters.push(waiter);
        });
    }

    /** Notify the backend that a traced /action request was abandoned. */
    async cancelRuntime(context = {}) {
        const info = this.info;
        const requestId = String((context && context.requestId) || '');
        if (!info || !requestId) return { ok: true, cancelled: false, requestId };
        try {
            const rsp = await fetch(`${info.base}/runtime/cancel?token=${encodeURIComponent(info.token)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
                body: JSON.stringify({ requestId }),
                signal: AbortSignal.timeout(1500),
            });
            return await rsp.json();
        } catch (e) {
            return { ok: false, cancelled: false, requestId, reason: String(e && e.message || e) };
        }
    }

    stop() {
        this.stopping = true;
        this._stopHealthCheck();
        if (this.proc) {
            const proc = this.proc;
            this.proc = null;
            // Windows 的 ChildProcess.kill() 只结束 Python 宿主，不保证清理其
            // spawn Worker、JVM 或 Node 后代。退出/设置重置必须杀完整进程树。
            if (process.platform === 'win32' && proc.pid) {
                try {
                    const result = spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
                        windowsHide: true,
                        stdio: 'ignore',
                        timeout: 5000,
                    });
                    if (result.error || result.status !== 0) proc.kill();
                } catch (e) { proc.kill(); }
            } else {
                proc.kill();
            }
        }
    }
}

module.exports = PythonBridge;
