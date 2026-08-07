/**
 * downloader.js — aria2c 下载引擎（Phase 6）
 *
 * 职责：
 * - 解析 aria2c 二进制：<repo>/vendor/aria2/ → PATH
 * - 惰性 spawn aria2c --enable-rpc（随机端口 + 一次性 secret），退出时 shutdown
 * - JSON-RPC 1.0 客户端：addUri/addTorrent/addMetalink/pause/unpause/remove/
 *   forceRemove/tellStatus/tellActive/tellWaiting/getVersion/shutdown
 * - listAll() 聚合三种状态并扁平化进度字段给渲染层
 * - EventEmitter：'completed' / 'error'（gid 去重，供主进程发系统通知）
 *
 * aria2c 缺失时 isAvailable()=false，由渲染层提示安装。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const { getProxyUrl } = require('./system-proxy');

// 打包后 extraResources 放在 resources/，vendor 从该处读取
const ROOT = (() => {
    try {
        const { app } = require('electron');
        return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
    } catch (e) { return path.join(__dirname, '..', '..'); }
})();
const WIN = process.platform === 'win32';

function findAria2() {
    const exe = WIN ? 'aria2c.exe' : 'aria2c';
    const vendor = path.join(ROOT, 'vendor', 'aria2', exe);
    if (fs.existsSync(vendor)) return vendor;
    try {
        if (WIN) {
            const out = execSync('where aria2c', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            const first = out.split(/\r?\n/)[0];
            if (first) return first;
        } else {
            const out = execSync(`command -v ${exe}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            if (out) return out;
        }
    } catch (e) { /* 不在 PATH */ }
    return null;
}

class Downloader extends EventEmitter {
    constructor() {
        super();
        this.binary = findAria2();
        this.proc = null;
        this.port = 0;
        this.secret = '';
        this.dir = '';
        this.concurrency = 3;      // 同时下载任务数（设置页可调，持久化）
        this._reqId = 0;
        this._ready = null;          // start 的 Promise
        this._notified = new Set();  // 已通知完成的 gid
        // EventEmitter 约定：'error' 无监听器会抛异常，兜底 noop
        this.on('error', () => { });
    }

    isAvailable() { return !!this.binary; }

    /** 惰性启动 aria2c 并等 RPC 就绪（重复调用复用）。 */
    start(dir, concurrency) {
        if (this._ready) return this._ready;
        if (!this.binary) return Promise.reject(new Error('aria2-missing'));
        this.dir = dir || path.join(os.homedir(), 'Downloads');
        if (concurrency) this.concurrency = Math.max(1, Math.min(10, concurrency | 0));
        fs.mkdirSync(this.dir, { recursive: true });
        this.port = 10000 + Math.floor(Math.random() * 20000);
        this.secret = Math.random().toString(36).slice(2) + Date.now().toString(36);

        const args = [
            '--enable-rpc', `--rpc-secret=${this.secret}`,
            `--rpc-listen-port=${this.port}`, '--rpc-listen-all=false',
            `--dir=${this.dir}`,
            '--seed-time=0', `--max-concurrent-downloads=${this.concurrency}`,
            '--continue=true', '--file-allocation=none',
            '--bt-stop-timeout=300',
        ];
        // 代理不在此烘焙进 CLI：用户可能随时开关系统代理，而 CLI 传入的代理
        // 无法经 RPC changeGlobalOption 清除；改为 addUri/addTorrent/addMetalink
        // 任务级注入（见 _proxyOpts），添加时取实时值，代理失效不影响新任务。
        this.proc = spawn(this.binary, args, { stdio: 'ignore' });
        this.proc.on('exit', () => { this.proc = null; this._ready = null; });

        this._ready = this._waitReady(80).catch((e) => {
            this._ready = null;
            this.stop();
            throw e;
        });
        return this._ready;
    }

    async _waitReady(attempts) {
        for (let i = 0; i < attempts; i++) {
            try { await this.getVersion(); return true; } catch (e) { /* 未就绪 */ }
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('aria2 rpc not ready');
    }

    stop() {
        if (this.proc) {
            try { this.proc.kill(); } catch (e) { /* ignore */ }
            this.proc = null;
        }
        this._ready = null;
    }

    // ------------------------------------------------------------ JSON-RPC

    _rpc(method, params = []) {
        if (!this.proc) return Promise.reject(new Error('aria2 not running'));
        const id = ++this._reqId;
        const body = JSON.stringify({
            jsonrpc: '2.0', id, method: `aria2.${method}`,
            params: [`token:${this.secret}`, ...params],
        });
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port: this.port, path: '/jsonrpc',
                method: 'POST', timeout: 15000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (rsp) => {
                let text = '';
                rsp.on('data', (c) => { text += c; });
                rsp.on('end', () => {
                    let msg;
                    try { msg = JSON.parse(text); } catch (e) { return reject(new Error('bad rpc response')); }
                    if (msg.error) reject(new Error(msg.error.message || 'rpc error'));
                    else resolve(msg.result);
                });
            });
            req.on('timeout', () => req.destroy(new Error('rpc timeout')));
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    getVersion() { return this._rpc('getVersion'); }
    changeGlobalOption(opts) { return this._rpc('changeGlobalOption', [opts]); }
    /** 任务级系统代理注入：部分网络环境直连不可达，须经本机代理客户端出海；
     *  aria2c 不读 WinINET 注册表需显式传。BT 的 DHT/对等连接不走 HTTP 代理，不受影响。 */
    _proxyOpts(opts) {
        const p = getProxyUrl();
        return p ? { ...opts, httpProxy: p, httpsProxy: p } : opts;
    }
    /** 调整并发任务数：运行中经 changeGlobalOption 即时生效，未启动时记下待下次启动。 */
    async setConcurrency(n) {
        this.concurrency = Math.max(1, Math.min(10, n | 0));
        if (this.proc) {
            try { await this.changeGlobalOption({ maxConcurrentDownloads: this.concurrency }); } catch (e) { /* 下轮重启生效 */ }
        }
        return this.concurrency;
    }
    addUri(urls, opts = {}) { return this._rpc('addUri', [[].concat(urls), this._proxyOpts(opts)]); }
    addTorrent(b64, opts = {}) { return this._rpc('addTorrent', [b64, [], this._proxyOpts(opts)]); }
    addMetalink(b64, opts = {}) { return this._rpc('addMetalink', [b64, this._proxyOpts(opts)]); }
    pause(gid) { return this._rpc('pause', [gid]); }
    unpause(gid) { return this._rpc('unpause', [gid]); }
    // remove 仅适用于 active/waiting/paused；已停止（complete/error/removed）的
    // 任务用 forceRemove，再不行则从 stopped 列表 purge（不视为失败）
    async remove(gid) {
        try { return await this._rpc('remove', [gid]); }
        catch (e) { /* 非活跃任务 */ }
        try { return await this._rpc('forceRemove', [gid]); }
        catch (e) { /* 已停止任务 */ }
        return this._rpc('removeDownloadResult', [gid]).catch(() => gid);
    }
    /** 从 stopped 列表彻底清除记录（complete/error/removed） */
    purge(gid) { return this._rpc('removeDownloadResult', [gid]); }
    tellStatus(gid) { return this._rpc('tellStatus', [gid]); }
    tellActive() { return this._rpc('tellActive'); }
    tellWaiting() { return this._rpc('tellWaiting', [0, 1000]); }
    tellStopped() { return this._rpc('tellStopped', [0, 1000]); }

    // ------------------------------------------------------------ 聚合视图

    /** 把 aria2 状态对象扁平化为渲染层友好结构。 */
    static flatten(s) {
        const total = parseInt(s.totalLength || '0', 10);
        const done = parseInt(s.completedLength || '0', 10);
        // 名称优先级：BT info name → 本地文件 basename → URL basename
        let name = '';
        if (s.bittorrent && s.bittorrent.info && s.bittorrent.info.name) name = s.bittorrent.info.name;
        const first = s.files && s.files[0];
        if (!name && first) {
            if (first.path) name = path.basename(first.path.replace(/[\\/]+$/, ''));
            else if (first.uris && first.uris[0]) name = decodeURIComponent(first.uris[0].uri.split('?')[0].split('/').pop() || first.uris[0].uri);
        }
        return {
            gid: s.gid,
            status: s.status,
            name,
            total, done,
            percent: total ? Math.round(done / total * 1000) / 10 : 0,
            speed: parseInt(s.downloadSpeed || '0', 10),
            connections: s.numSeeders !== undefined ? `${s.connections || 0}/${s.numSeeders}` : (s.connections || ''),
            errorMessage: s.errorMessage || '',
            files: (s.files || []).map((f) => f.path).filter(Boolean),
        };
    }

    /** 全量任务列表（active + waiting + stopped），完成/出错事件顺带触发。 */
    async listAll() {
        await this.start(this.dir);
        const [active, waiting, stopped] = await Promise.all([
            this.tellActive(), this.tellWaiting(), this.tellStopped(),
        ]);
        const all = [...active, ...waiting, ...stopped].map(Downloader.flatten);
        for (const t of all) {
            if (t.status === 'complete' && !this._notified.has(t.gid)) {
                this._notified.add(t.gid);
                this.emit('completed', t);
            } else if (t.status === 'error' && !this._notified.has('e' + t.gid)) {
                this._notified.add('e' + t.gid);
                this.emit('error', t);
            }
        }
        return all;
    }
}

module.exports = Downloader;
