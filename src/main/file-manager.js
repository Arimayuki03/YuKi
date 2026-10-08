/**
 * file-manager.js — 本地文件管理（Phase 5）
 *
 * 职责：目录浏览 / 新建文件夹 / 复制上传 / 删除（文件与目录），
 * 所有操作经 resolveSafe() 做路径规范化 + 根目录白名单校验（防穿越）。
 *
 * 根目录（白名单）持久化在 <userData>/file-manager.json；
 * 未设置时 list 返回 { needRoot: true }，由渲染层引导选择。
 *
 * P2-7：delFolder 在白名单根（默认=下载目录）内可递归删除任意子树——补三道防线：
 * (a) 拒绝删除根目录本身（原有）；(b) 原生确认框二次确认（渲染层已有确认交互，
 * 此处为主进程最后防线——渲染层被注入时一次 IPC 调用即删整个媒体库）；(c) 在写
 * 互斥：目录下存在进行中的下载任务（持久化记录 active/waiting/paused）时拒绝删除。
 * electron/dialog 与活动任务探测经 opts 注入（本文件保持纯 Node 可单测；
 * index.js 装配时传入真实依赖）。
 */
const fs = require('fs');
const path = require('path');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.ts', '.flv', '.avi', '.mov', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm', '.m2ts']);
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.oga', '.opus', '.m4a', '.wma', '.ape']);

class FileManager {
    /**
     * @param {string} userDataPath 持久化目录
     * @param {object} [opts] 可选依赖注入
     * @param {(p: {type:string, title:string, message:string, detail:string, buttons:string[]})=>Promise<number>} [opts.confirm]
     *        原生确认框（返回所选按钮下标；缺省视为用户放弃，fail-closed）
     * @param {()=>Array<{dir?:string, status:string}>} [opts.getRecords]
     *        下载持久化记录提供者（在写互斥判定用）
     */
    constructor(userDataPath, opts = {}) {
        this._configPath = path.join(userDataPath, 'file-manager.json');
        this._confirm = typeof opts.confirm === 'function' ? opts.confirm : null;
        this._getRecords = typeof opts.getRecords === 'function' ? opts.getRecords : null;
        this.root = this._loadRoot();
    }

    _loadRoot() {
        try {
            const cfg = JSON.parse(fs.readFileSync(this._configPath, 'utf8'));
            return cfg.root && fs.existsSync(cfg.root) ? path.resolve(cfg.root) : null;
        } catch (e) { return null; }
    }

    /** 设置白名单根目录并持久化。 */
    setRoot(dir) {
        const abs = path.resolve(String(dir || ''));
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
            throw new Error('root not a directory');
        }
        this.root = abs;
        fs.mkdirSync(path.dirname(this._configPath), { recursive: true });
        fs.writeFileSync(this._configPath, JSON.stringify({ root: abs }), 'utf8');
        return abs;
    }

    /**
     * 白名单校验：rel 相对根目录规范化后必须仍在根内。
     * rel 允许 '' / null（根自身）；拒绝 '..'、绝对路径、盘符跳转等穿越。
     */
    resolveSafe(rel) {
        if (!this.root) throw new Error('root not set');
        const p = path.resolve(this.root, String(rel || ''));
        if (p !== this.root && !p.startsWith(this.root + path.sep)) {
            throw new Error('path outside whitelist');
        }
        return p;
    }

    /** 浏览目录，返回格式与原 /file 占位一致：{parent, path, files:[{dir,name,time,path}]}。
     *  异步 + 线程池卸载：同步 readdirSync+逐条 statSync 在几千条目的媒体目录上会
     *  把主进程事件循环独占数百 ms~数秒（打开板块瞬间单核 100% 全应用冻结）；
     *  fs.promises 走 libuv 线程池，主进程与窗口交互全程不卡。localeCompare 与
     *  toLocaleString 放入 worker（worker_threads）同理——ICU 首次加载也是几十 ms 级。 */
    async list(rel) {
        const dir = this.resolveSafe(rel);
        // resolveSafe 校验完白名单后，实际目录读取放 worker 线程执行，
        // 主进程只等结果。worker 内不访问 this（FileManager 实例不可跨线程传递）。
        return new Promise((resolve, reject) => {
            _listWorkerTask({ dir, root: this.root }, (err, out) => {
                if (err) reject(err); else resolve(out);
            });
        });
    }

    /** 新建文件夹（名称内不允许分隔符与 ..）。 */
    newFolder(rel, name) {
        const n = String(name || '').trim();
        if (!n || /[\\/]/.test(n) || n === '.' || n === '..') throw new Error('invalid name');
        const dir = this.resolveSafe(path.join(String(rel || ''), n));
        fs.mkdirSync(dir);
        return path.relative(this.root, dir);
    }

    /** 删除文件（仅限白名单内的普通文件）。 */
    delFile(rel) {
        const p = this.resolveSafe(rel);
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('not a file');
        fs.unlinkSync(p);
    }

    /** 判断目标目录内（含子树）是否有进行中的下载任务产物：
     *  持久化记录 active/waiting/paused 任务的 dir / 产物文件路径落在目标内即算。 */
    _hasActiveTaskUnder(dir) {
        let records;
        try { records = (this._getRecords && this._getRecords()) || []; } catch (e) { records = []; }
        const norm = (p) => {
            try { return path.resolve(String(p)).toLowerCase(); } catch (e) { return ''; }
        };
        const target = norm(dir);
        if (!target) return false;
        for (const r of records) {
            if (!r || !['active', 'waiting', 'paused'].includes(r.status)) continue;
            if (r.dir && norm(r.dir) === target) return true; // 任务级目录即目标本身（或子树根）
            for (const f of (r.files || [])) {
                if (!f || f === '.') continue;
                const fp = norm(f);
                if (!fp) continue;
                if (fp === target || fp.startsWith(target + path.sep)) return true;
            }
        }
        return false;
    }

    /** 删除目录（递归；拒绝删根目录自身）。
     *  P2-7 加固：原生确认框二次确认（主进程最后防线）+ 在写互斥（目录内有
     *  进行中的下载任务即拒绝）。确认框依赖未注入（单测/早期调用）时 fail-closed
     *  视为用户放弃——宁可少删，不可误删。 */
    async delFolder(rel) {
        const p = this.resolveSafe(rel);
        if (p === this.root) throw new Error('cannot delete root');
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('not a directory');
        // (c) 在写互斥：目标目录（含子树）内有进行中的下载任务 → 拒绝删除，
        //     避免边下边删造成产物损坏/任务异常
        if (this._hasActiveTaskUnder(p)) {
            throw new Error('folder has active downloads');
        }
        // (b) 原生确认框（最后防线）：渲染层已有确认交互，此处拦的是渲染层被注入/
        //     逻辑误传直发 IPC 的场景。列出将删除的目录绝对路径。
        if (this._confirm) {
            const choice = await this._confirm({
                type: 'warning',
                title: '删除文件夹',
                message: `确定要删除文件夹吗？`,
                detail: `将永久递归删除以下目录及其全部内容（不可恢复）：\n${p}`,
                buttons: ['删除', '取消'],
            });
            if (choice !== 0) throw new Error('delete cancelled');
        } else {
            throw new Error('delete cancelled: no confirm dialog');
        }
        fs.rmSync(p, { recursive: true, force: true });
    }

    /** 批量删除（多选模式入口）：先分类并过完全部防线（根目录剔除 / 在写互斥 /
     *  原生确认框），防线通过后才统一删除——取消/互斥拒绝时不得已删任何文件
     *  （否则用户在主进程框点「取消」意图全不删，文件却已被删）。目录确认框只弹
     *  一次（列出全部待删目录），整批共用一个决定；单项失败不中断整批，逐项结果
     *  随返回值回告。 */
    async delMany(rels) {
        const list = (Array.isArray(rels) ? rels : []).map((r) => String(r || '')).filter(Boolean);
        if (!list.length) throw new Error('empty selection');
        const results = [];
        // 先分类：目录统一收集（确认一次）；文件只解析校验，删除延后到防线之后
        const dirs = [];
        const files = [];
        for (const rel of list) {
            let p;
            try { p = this.resolveSafe(rel); } catch (e) { results.push({ rel, ok: false, reason: e.message }); continue; }
            let isDir = false;
            try { isDir = fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch (e) { /* stat 失败按文件处理 */ }
            if (isDir) dirs.push({ rel, p });
            else files.push(rel);
        }
        // 根目录项先剔除（对齐 delFolder：拒绝发生在确认框之前，不弹根目录确认）
        for (const d of dirs) {
            if (d.p === this.root) { results.push({ rel: d.rel, ok: false, reason: 'cannot delete root' }); }
        }
        const deletableDirs = dirs.filter((d) => d.p !== this.root);
        if (deletableDirs.length) {
            // 防线 (c)：任一目录在写互斥命中即整批拒绝（保守策略：宁可少删不误删）
            for (const d of deletableDirs) {
                if (this._hasActiveTaskUnder(d.p)) {
                    throw new Error('folder has active downloads');
                }
            }
            // 防线 (b)：原生确认框一次覆盖整批目录
            if (this._confirm) {
                const detail = deletableDirs.map((d) => d.p).join('\n');
                const choice = await this._confirm({
                    type: 'warning',
                    title: '删除文件夹',
                    message: deletableDirs.length > 1 ? `确定要删除这 ${deletableDirs.length} 个文件夹吗？` : '确定要删除文件夹吗？',
                    detail: `将永久递归删除以下目录及其全部内容（不可恢复）：\n${detail}`,
                    buttons: ['删除', '取消'],
                });
                if (choice !== 0) throw new Error('delete cancelled');
            } else {
                throw new Error('delete cancelled: no confirm dialog');
            }
        }
        // 防线全部通过：统一删除（文件 + 目录）。到这里才允许真正动文件系统。
        for (const rel of files) {
            try { this.delFile(rel); results.push({ rel, ok: true }); }
            catch (e) { results.push({ rel, ok: false, reason: e.message }); }
        }
        for (const d of deletableDirs) {
            try { fs.rmSync(d.p, { recursive: true, force: true }); results.push({ rel: d.rel, ok: true }); }
            catch (e) { results.push({ rel: d.rel, ok: false, reason: e.message }); }
        }
        return { results, failed: results.filter((r) => !r.ok).length };
    }

    isVideo(name) {
        return VIDEO_EXTS.has(path.extname(String(name || '')).toLowerCase());
    }

    isAudio(name) {
        return AUDIO_EXTS.has(path.extname(String(name || '')).toLowerCase());
    }

    /** 可交 mpv 播放的媒体文件（视频 + 音频）。 */
    isMedia(name) {
        const ext = path.extname(String(name || '')).toLowerCase();
        return VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext);
    }
}

// ---------------------------------------------------------------- 目录列举 worker 池
// list() 的全目录扫描（readdir + 逐条 stat + 排序 + 时间格式化）放独立线程执行，
// 主进程事件循环不被大目录阻塞。池容量 2：目录浏览是低频操作，且并发任务共享
// libuv 线程池配额，多了反而与 ffmpeg 抓帧的异步 IO 抢线程。

const TASK_IDLE_EXIT_MS = 120000; // 池内线程空闲 2 分钟自动退出（Electron 主进程不留常驻线程）

/** 目录扫描（worker 与无 worker 环境的退化路径共用同一实现，行为与旧版 list 逐行一致）。 */
function _scanDir(dir, root) {
    // stat 失败（不存在/无权限）与「是文件」同文案——对齐旧版 existsSync 分支的对外契约
    let st = null;
    try { st = fs.statSync(dir); } catch (e) { throw new Error('not a directory'); }
    if (!st.isDirectory()) throw new Error('not a directory');
    const relOf = (p) => path.relative(root, p);
    const parent = dir === root ? '.' : relOf(path.dirname(dir));
    const files = fs.readdirSync(dir, { withFileTypes: true })
        .map((e) => {
            const full = path.join(dir, e.name);
            let s = null;
            try { s = fs.statSync(full); } catch (err) { /* 无权限/失效项跳过时间 */ }
            return {
                dir: e.isDirectory() ? 1 : 0,
                name: e.name,
                time: s ? new Date(s.mtimeMs).toLocaleString('zh-TW') : '',
                path: relOf(full),
            };
        })
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh-Hant'));
    return { parent, path: relOf(dir), files };
}

/** worker 池单例：首次 list() 才创建（纯 Node 单测/未用目录浏览的场景零开销）。 */
let _pool = null;

/**
 * 向 worker 池提交一次目录扫描任务。
 * task: { dir, root }；cb: (err, {parent, path, files}) 。
 * worker 侧执行 _scanDirSerialized（见 WORKER_SRC），结果含相对路径与时间串。
 */
function _listWorkerTask(task, cb) {
    if (!_pool) _pool = _makePool();
    _pool.submit(task, cb);
}

function _makePool() {
    let worker_mod = null;
    try { worker_mod = require('worker_threads'); } catch (e) { /* 极老环境无 worker_threads */ }
    if (!worker_mod || !worker_mod.Worker) {
        // 退化路径：无 worker 环境同步执行（行为同旧版，只是失去卸载能力）
        return {
            submit(task, cb) {
                setImmediate(() => {
                    try { cb(null, _scanDir(task.dir, task.root)); }
                    catch (err) { cb(err); }
                });
            },
        };
    }
    const { Worker } = worker_mod;
    const MAX_WORKERS = 2;
    const IDLE_EXIT_MS = TASK_IDLE_EXIT_MS;
    const idle = [];
    const waiting = [];
    let live = 0;

    const WORKER_SRC = `
const { parentPort } = require('worker_threads');
const fs = require('fs');      // _scanDir 序列化后的自由变量（闭包不随 toString 传递）
const path = require('path');
parentPort.on('message', (job) => {
    let out, err = null;
    try { out = (${_scanDir.toString()})(job.task.dir, job.task.root); } catch (e) { err = e.message || String(e); }
    parentPort.postMessage({ id: job.id, err, out });
});
`;
    // job 表：id → {cb}。worker 返回 id 匹配回调（同 worker 可并发承接多任务）。
    const pending = new Map();
    let nextId = 1;

    function spawnWorker() {
        // M9：live++ 必须放在 new Worker 成功之后——eval 编译等构造路径可能抛异常，
        // 先自增的话失败路径没有 exit 事件来抵消，live 永久虚高，池两次即失效
        const w = new Worker(WORKER_SRC, { eval: true });
        live++;
        // 新 worker 启动即承接首任务（submit 拉起路径）：ref 态等回复；
        // 之后每次回到空闲由 dispatch unref。
        let idleTimer = null;
        const armIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                // 空闲回收：终止线程；此刻不会再有任务派给它（out 队列先移除）
                const i = idle.indexOf(entry);
                if (i >= 0) idle.splice(i, 1);
                w.terminate().catch(() => {});
                // 注意：不在这里 live-- —— terminate 必然触发 exit，live 的唯一
                // 出口在 exit 处理器里。两处都减会让计数漂移成负数，使
                // `live < MAX_WORKERS` 恒真、池容量形同虚设。
            }, IDLE_EXIT_MS);
            if (idleTimer.unref) idleTimer.unref(); // 不阻止进程自然退出（单测挂满 2min 才结束）
        };
        // jobs：本 worker 身上尚未回执的任务 id。worker 被 terminate/异常退出时
        // 这些 job 再无回执，必须兜底失败回调——否则调用方 promise 永不 settle。
        // 只清本 worker 的 job：pending 是全局 Map，整表清会误伤其他 worker。
        const entry = {
            w,
            armIdle,
            jobs: new Set(),
            clearIdle: () => clearTimeout(idleTimer),
        };
        w.on('message', (msg) => {
            const job = pending.get(msg.id);
            if (!job) return;
            pending.delete(msg.id);
            entry.jobs.delete(msg.id);
            // 先把 worker 派回空闲/接下一个等待任务，再回调：cb 内同步再 submit
            // （翻页/刷新）时可立即复用刚空闲的 worker，且 cb 抛异常不影响已派发的任务
            dispatch(entry);
            if (msg.err) job.cb(new Error(msg.err));
            else job.cb(null, msg.out);
        });
        // 异常死亡：等待中的任务重新派发。live-- 只在 exit 做（error 后必然 exit）。
        w.on('error', () => { redistribute(); });
        w.on('exit', () => {
            const i = idle.indexOf(entry);
            if (i >= 0) idle.splice(i, 1);
            live--;
            // 身故兜底：结算本 worker 身上未回执的任务（空闲回收的 terminate 与
            // 异常退出都会走这里），否则 list() 的 promise 永不 settle
            for (const jid of entry.jobs) {
                const orphan = pending.get(jid);
                if (!orphan) continue;
                pending.delete(jid);
                try { orphan.cb(new Error('worker exited')); } catch (e) { /* 回调异常不外溢 */ }
            }
            entry.jobs.clear();
            // M8：结算完孤儿任务后补一次重派——error 处理器调 redistribute 时 live
            // 尚未自减（live-- 只在 exit 做），`live < MAX_WORKERS` 恒假拉不起替补；
            // 此处 live 已扣减，两 worker 相继异常后等待队列仍能被重新拉起
            redistribute();
        });
        // 注意：这里不再 armIdle()/idle.push(entry) —— 空闲入队收口在 parkIdle()，
        // 由「真正处于空闲态」的调用点统一处理。spawnWorker 自己入队会让
        // submit 的 spawn 分支出现「已派首任务却仍在 idle 里」的重复条目。
        // 必须在挂完 on('message'/'error'/'exit') 之后 unref：挂监听器会重新 ref 内部
        // MessagePort。unref 后空闲 worker 不阻止进程自然退出（主动 terminate 仍是
        // 常规回收路径；unref 只兜底「进程想退而 worker 还闲着」的窗口，含单测环境）
        if (w.unref) w.unref();
        return entry;
    }

    /** 空闲入队的唯一出口：入 idle + unref + 挂空闲回收定时器。 */
    function parkIdle(entry) {
        idle.push(entry);
        if (entry.w.unref) entry.w.unref(); // 空闲：不阻止进程自然退出
        entry.armIdle();
    }

    /** 给 worker 派一个等待中的任务（无等待任务则回空闲）。 */
    function dispatch(entry) {
        entry.clearIdle(); // idleTimer 在 spawnWorker 闭包里，必须经 entry 暴露清理能力
        if (!waiting.length) {
            parkIdle(entry);
            return;
        }
        const job = waiting.shift();
        const id = nextId++;
        pending.set(id, { cb: job.cb });
        entry.jobs.add(id);
        if (entry.w.ref) entry.w.ref(); // 在途任务：事件循环须等回复到达
        entry.w.postMessage({ id, task: job.task });
    }

    function redistribute() {
        // worker 死亡兜底：把等待队列的任务重新尝试派发（可能拉起新 worker）
        while (waiting.length) {
            const entry = idle.pop();
            if (!entry) break;
            dispatch(entry);
        }
        if (waiting.length && live < MAX_WORKERS) dispatch(spawnWorker());
    }

    return {
        submit(task, cb) {
            const entry = idle.pop();
            const id = nextId++;
            const job = { task, cb };
            if (entry) {
                pending.set(id, { cb });
                entry.jobs.add(id);
                entry.clearIdle(); // M7：弹出空闲 worker 即拆其 120s 回收定时器，否则定时器到期会 terminate 正在执行任务的 worker
                if (entry.w.ref) entry.w.ref(); // 空闲 worker 转 busy：ref 等回复
                entry.w.postMessage({ id, task });
                return;
            }
            if (live < MAX_WORKERS) {
                // spawnWorker 不再自行入 idle，故不存在「已派首任务却仍在 idle
                // 里」的重复条目（原实现会让同一 entry 在 idle 中出现两份：两次
                // submit 会 pop 到同一个 worker 串行化，且 120s 回收只摘一份，
                // 僵尸条目后续把任务发给已 terminate 的 worker，消息被静默丢弃）。
                // 首任务必须是本次 submit 的 task——不能走 dispatch，那会去 waiting
                // 队列里取一个更老的任务而把本任务丢掉。
                const fresh = spawnWorker();
                pending.set(id, { cb });
                fresh.jobs.add(id);
                // spawnWorker 收尾是 unref（空闲态），首任务派发前须转回 ref，
                // 否则无其他引用时进程会在回复到达前退出（list 永挂）
                if (fresh.w.ref) fresh.w.ref();
                fresh.w.postMessage({ id, task });
                return;
            }
            // 满：进等待队列（worker 完成当前任务后 dispatch 接走）
            waiting.push(job);
        },
    };
}

module.exports = FileManager;
