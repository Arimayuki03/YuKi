/**
 * python-bridge.js — Python 后端子进程管理
 *
 * 职责：spawn server.py → 解析 READY 行获得 port/token → 健康检查 →
 * 崩溃后指数退避重启（1s/2s/4s...上限 60s，就绪后重置）。
 *
 * 打包模式（app.isPackaged）：启动 PyInstaller onedir 产物
 * （extraResources/python-backend/yuki-backend/yuki-backend.exe），无 venv 依赖。
 * 打包版 Windows 先预检系统 VC++ 运行库（安装包不随带副本，见 after-pack），
 * 缺失时不 spawn、发 vcrt-missing 事件由主进程弹窗引导安装。
 */
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const READY_RE = /YUKI_BACKEND_READY port=(\d+) token=(\S+)/;
const HEALTH_INTERVAL = 15000;
const MAX_BACKOFF = 60000;
// stdout READY 匹配缓冲上限（字符数≈字节）：后端始终打不出 READY 时防无限膨胀
const READY_BUF_MAX = 1024 * 1024;
// 就绪后保留的缓冲尾部（字符数，仅供诊断）：日志持续输出不再线性累积内存/正则开销
const READY_BUF_TAIL = 4096;

class PythonBridge extends EventEmitter {
    constructor(rootDir, resourcesRoot, opts = {}) {
        super();
        this.rootDir = rootDir;
        this.resourcesRoot = resourcesRoot || rootDir;
        // 开发模式：venv python + server.py；打包模式：PyInstaller 产物
        if (app.isPackaged) {
            this.backendDir = path.join(this.resourcesRoot, 'python-backend');
            // onedir 产物在 yuki-backend/ 子目录（exe + _internal/）；兼容旧 onefile 平铺 exe
            const onedir = path.join(this.backendDir, 'yuki-backend', 'yuki-backend.exe');
            const onefile = path.join(this.backendDir, 'yuki-backend.exe');
            this.script = fs.existsSync(onedir) ? onedir : onefile;
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
        // 挂起的崩溃重启定时器：必须存实例字段，stop() 才能取消（否则 stop→start
        // 竞态窗口内旧定时器触发会 spawn 出第二个后端）
        this._restartTimer = null;
        this._stdoutBuf = '';      // stdout READY 匹配缓冲（有界，截断逻辑见 _spawn）
        this.readyWaiters = [];
        this.extraEnv = {};        // 附加环境变量（如自定义缓存目录 YUKI_CACHE_DIR）
        this.logWriter = opts.logWriter || null;
    }

    _pythonExe() {
        if (this._isPackaged) return this.script; // PyInstaller exe 直接运行
        const venv = path.join(this.backendDir, '.venv', 'Scripts', 'python.exe');
        return fs.existsSync(venv) ? venv : 'python';
    }

    /**
     * 打包版 Windows 预检：安装包不再随带 VCRUNTIME140*.dll（afterPack 剔除——未签名
     * 安装包向用户目录写系统同名 DLL 是杀软行为拦截的高频触发点），后端 python314.dll
     * 依赖系统 VC++ 2015-2022 运行库。返回缺失的 DLL 名列表（无缺失为空数组）。
     */
    _vcrtMissing() {
        const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
        return ['vcruntime140.dll', 'vcruntime140_1.dll'].filter((n) => !fs.existsSync(path.join(sys, n)));
    }

    start() {
        this.stopping = false;
        this._spawn();
    }

    _spawn() {
        if (this.stopping) return;
        // 防重入：已有未退出进程时不重复 spawn（killed=true 但 exit 未到也算存活，
        // 否则健康检查 kill 的窗口内重启会翻倍进程）。stop() 会清空 proc，
        // 正常的 stop→start 重启不受影响。
        if (this.proc && this.proc.exitCode === null) return;
        if (this._isPackaged && process.platform === 'win32') {
            const missing = this._vcrtMissing();
            if (missing.length) {
                // 不 spawn：Windows 会弹系统错误框，且退避重启变成死循环；交给主进程
                // 弹窗引导安装运行库（index.js 的 vcrt-missing 监听）。
                this.emit('state', 'vcrt-missing');
                this.emit('vcrt-missing', missing);
                return;
            }
        }
        this.info = null; // info 只属于当前进程：换进程前重置，READY 行才能重新捕获新端口/token
        this.emit('state', 'starting');
        const args = this._isPackaged ? [] : ['-X', 'utf8', this.script];
        const proc = spawn(this._pythonExe(), args, {
            cwd: this.backendDir,
            // YUKI_RESOURCES_ROOT：vendor/（spider-runner.jar、dex-tools、jre 等）
            // 所在的 resources 根。后端在冻结产物里按 __file__ 拼不出 vendor 路径，
            // 必须显式告知；开发模式 resourcesRoot 即仓库根，行为一致。
            env: {
                ...process.env,
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1',
                YUKI_RESOURCES_ROOT: this.resourcesRoot,
                ...this.extraEnv,
            },
            windowsHide: true,
        });
        this.proc = proc;
        this._stdoutBuf = ''; // 每个 stdout 监听器绑定一个进程，缓冲随进程走

        proc.stdout.on('data', (chunk) => {
            // H-9 同源防护：缓冲是实例字段，换进程后旧进程迟到的 stdout 不得
            // 污染新进程的匹配缓冲（否则旧 READY 行会写入旧端口/token）。
            if (this.proc !== proc) return;
            const text = chunk.toString('utf8');
            this._stdoutBuf += text;
            // STDOUT/STDERR 不是有效日志级别（LEVEL_WEIGHT 无此键会绕过级别过滤），
            // 映射为 INFO/WARN，使 Python 控制台输出同样受设置页日志级别约束。
            if (this.logWriter) this.logWriter.write('INFO', '[python:stdout]', text.trimEnd());
            if (!this.info) {
                const m = this._stdoutBuf.match(READY_RE);
                if (m) {
                    const port = parseInt(m[1], 10);
                    this.info = { port, token: m[2], base: `http://127.0.0.1:${port}` };
                    this.backoff = 1000;
                    this._startHealthCheck();
                    this.emit('ready', this.info);
                    this.readyWaiters.forEach((r) => r(this.info));
                    this.readyWaiters = [];
                } else if (this._stdoutBuf.length > READY_BUF_MAX) {
                    // 后端始终打不出 READY：丢弃前半段、保留尾部继续匹配，防无限膨胀
                    this._stdoutBuf = this._stdoutBuf.slice(-Math.floor(READY_BUF_MAX / 2));
                }
            }
            if (this.info && this._stdoutBuf.length > READY_BUF_TAIL) {
                // 就绪后不再需要全量匹配，只保留小尾部供诊断：否则缓冲随日志量
                // 无限增长，内存与逐块正则匹配开销线性上升。
                this._stdoutBuf = this._stdoutBuf.slice(-READY_BUF_TAIL);
            }
        });
        proc.stderr.on('data', (chunk) => {
            if (this.logWriter) this.logWriter.write('WARN', '[python:stderr]', chunk.toString('utf8').trimEnd());
            process.stderr.write(`[python] ${chunk}`);
        });
        // 'error' 事件有两类，处理不同：
        // (a) spawn 失败（ENOENT/权限不足等）：进程从未存在，Node 不会再发
        //     exit——此处就是本次 spawn 的终态，直接走与 exit 相同的重启路径。
        // (b) 运行期 error（进程仍存活：proc.kill() 以 EPERM 失败、IPC 通道
        //     错误等）：不能只清句柄就重启——旧进程沦为不受管理的僵尸，且
        //     守卫（this.proc !== proc）会让其后的 exit 全部失效，僵尸永久
        //     留存。必须先杀完整进程树，再走同一条重启链；杀掉后的 exit 由
        //     该守卫挡住，不会双重启。
        proc.on('error', (err) => {
            if (this.proc !== proc) return; // H-9：stop→start 已换新进程，旧进程的错误直接忽略
            const running = proc.exitCode === null && proc.pid != null;
            if (running) {
                this._killTree(proc);
            } else {
                // 纯 spawn 失败：无进程可杀，立刻收口句柄进入重启
                this._stopHealthCheck();
                this.info = null;
                this.proc = null;
            }
            if (this.stopping) return;
            if (this.logWriter) {
                this.logWriter.write('ERROR', '[python-bridge]',
                    running ? `backend runtime error: ${err.message}` : `backend spawn failed: ${err.message}`);
            }
            console.error(`[python-bridge] ${running ? 'runtime error' : 'spawn failed'}: ${err.message}`);
            this.emit('state', 'restarting');
            const delay = this.backoff;
            this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
            if (this._restartTimer) clearTimeout(this._restartTimer);
            this._restartTimer = setTimeout(() => {
                this._restartTimer = null;
                this._spawn();
            }, delay);
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
            // 句柄必须存实例字段：stop() 依赖它取消挂起的重启，否则 stop→start
            // 竞态窗口内旧定时器触发会 spawn 出第二个后端。
            if (this._restartTimer) clearTimeout(this._restartTimer);
            this._restartTimer = setTimeout(() => {
                this._restartTimer = null;
                this._spawn();
            }, delay);
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
                // 健康检查失败必须杀完整进程树：仅 kill() 留下的 Worker/JVM 后代
                // 会随周期性失败重启不断累积成孤儿进程
                this._killTree();
            }
        }, HEALTH_INTERVAL);
    }

    _stopHealthCheck() {
        if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    }

    /**
     * 终止后端进程的完整进程树（Windows 用 taskkill /T /F；其它平台 kill）。
     * 健康检查失败与 stop() 共用：只 proc.kill() 会留下 Worker/JVM 等后代进程，
     * 周期性健康检查失败重启会累积孤儿进程。
     * @param {object} [target] 待杀进程；缺省取 this.proc（stop() 清空句柄后需显式传入）。
     */
    _killTree(target) {
        const proc = target || this.proc;
        if (!proc) return;
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
        // 取消挂起的崩溃重启：否则 stop→start 后旧定时器触发 _spawn，
        // 与 start 刚拉起的新进程叠加成双后端。
        if (this._restartTimer) {
            clearTimeout(this._restartTimer);
            this._restartTimer = null;
        }
        if (this.proc) {
            const proc = this.proc;
            this.proc = null;
            // Windows 的 ChildProcess.kill() 只结束 Python 宿主，不保证清理其
            // spawn Worker、JVM 或 Node 后代。退出/设置重置必须杀完整进程树。
            this._killTree(proc);
        }
    }
}

module.exports = PythonBridge;
