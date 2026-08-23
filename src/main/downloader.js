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

// 磁链/BT 公共 tracker 列表：磁链只有 info-hash，须先从 DHT/tracker/PEX 找到 peer 拿 metadata
// 才能开始下载。仅靠 DHT 在很多网络环境（UDP 被限）下连不通，导致进度长期卡 0%。
// 补一批稳定的公共 tracker（含 udp/http/wss）作为 DHT 之外的 peer 发现途径，显著提高磁链成功率。
const BT_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.tracker.cl:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://explodie.org:6969/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://opentracker.i2p.rocks:6969/announce',
    'http://tracker.openbittorrent.com:80/announce',
    'https://tracker.tamersunion.org:443/announce',
    'udp://tracker.tiny-vps.com:6969/announce',
    'udp://tracker.moeking.me:6969/announce',
    'udp://tracker1.bt.moack.co.kr:80/announce',
    'udp://tracker.bittor.pw:1337/announce',
];

function findAria2() {
    const exe = WIN ? 'aria2c.exe' : 'aria2c';
    const vendor = path.join(ROOT, 'vendor', 'aria2', exe);
    if (fs.existsSync(vendor)) return vendor;
    try {
        if (WIN) {
            const out = execSync('where aria2c', { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
            const first = out.split(/\r?\n/)[0];
            if (first) return first;
        } else {
            const out = execSync(`command -v ${exe}`, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
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
        this.split = 5;            // 单文件分片并发数（--split / --max-connection-per-server，设置页可调）
        this._reqId = 0;
        this._ready = null;          // start 的 Promise
        this._notified = new Set();  // 已通知完成的 gid
        // 启动失败诊断信息（exit/spawn error/stderr 尾部），供 _waitReady 抛出时附带
        this._exitCode = null;
        this._spawnError = '';
        this._stderrBuf = '';
        // EventEmitter 约定：'error' 无监听器会抛异常，兜底 noop
        this.on('error', () => { });
    }

    isAvailable() { return !!this.binary; }

    /** 惰性启动 aria2c 并等 RPC 就绪（重复调用复用）。 */
    start(dir, concurrency, split) {
        if (this._ready) return this._ready;
        // 二进制探测在构造时做过一次，但用户可能后来才补上/删除 vendor；
        // 每次启动重新解析并校验存在，避免拿着失效路径 spawn 失败后误报 rpc not ready。
        if (!this.binary || !fs.existsSync(this.binary)) {
            this.binary = findAria2();
        }
        if (!this.binary) return Promise.reject(new Error('aria2-missing'));
        // 优先用系统默认下载目录（尊重 Windows 注册表自定义路径），而非硬编码 ~/Downloads
        const { app } = require('electron');
        this.dir = dir || app.getPath('downloads') || path.join(os.homedir(), 'Downloads');
        if (concurrency) this.concurrency = Math.max(1, Math.min(10, concurrency | 0));
        if (split) this.split = Math.max(1, Math.min(32, split | 0));
        fs.mkdirSync(this.dir, { recursive: true });
        this.port = 10000 + Math.floor(Math.random() * 20000);
        this.secret = Math.random().toString(36).slice(2) + Date.now().toString(36);
        // BT/DHT 监听端口必须落在 aria2 校验范围 1024-65535：aria2c 1.37.0 对
        // --dht-listen-port=0 直接报 errorCode=28（"must be between 1024 and 65535"）
        // 并提前退出，导致 RPC 永远不就绪。DHT 默认区间 6881-6999 常与其他 BT
        // 客户端冲突，故取 16881-17880 随机单端口；--listen-port(TCP) 与
        // --dht-listen-port(UDP) 共用该端口，避免两个监听口各自冲突。
        this.btListenPort = 16881 + Math.floor(Math.random() * 1000);

        const args = [
            '--enable-rpc', `--rpc-secret=${this.secret}`,
            `--rpc-listen-port=${this.port}`, '--rpc-listen-all=false',
            `--dir=${this.dir}`,
            '--seed-time=0', `--max-concurrent-downloads=${this.concurrency}`,
            `--split=${this.split}`, `--max-connection-per-server=${this.split}`,
            '--continue=true', '--file-allocation=none',
            '--bt-stop-timeout=300',
            '--enable-dht=true',
            `--listen-port=${this.btListenPort}`,
            `--dht-listen-port=${this.btListenPort}`,
            '--bt-metadata-only=false', '--bt-load-saved-metadata=true',
            '--follow-torrent=true', '--follow-metalink=true',
            // 磁链提速：DHT 之外补公共 tracker + 开启 PEX（peer 交换），
            // 多路发现 peer 才能拉到 metadata 并开始实际下载，避免仅靠 DHT 卡 0%。
            `--bt-tracker=${BT_TRACKERS.join(',')}`,
            '--enable-peer-exchange=true',
            '--bt-max-peers=0',                 // 0 = 不限 peer 数，尽量多连
            '--bt-request-peer-speed-limit=0',  // 不因单 peer 慢而限速整体
            '--dht-entry-point=router.bittorrent.com:6881',
            '--dht-entry-point6=router.bittorrent.com:6881',
            '--enable-dht6=true',
            '--bt-enable-lpd=true',             // 本地 peer 发现（局域网种子）
            // 降噪 + RPC 稳定性：stdio 虽为 'ignore'，但过量日志仍可能拖慢首次就绪；
            // rpc-max-request-size 提升大 metalink/torrent 请求体上限，避免边界请求被拒。
            '--quiet', '--console-log-level=error',
            '--rpc-max-request-size=2M',
        ];
        // 代理不在此烘焙进 CLI：用户可能随时开关系统代理，而 CLI 传入的代理
        // 无法经 RPC changeGlobalOption 清除；改为 addUri/addTorrent/addMetalink
        // 任务级注入（见 _proxyOpts），添加时取实时值，代理失效不影响新任务。
        // stdio 设为 pipe 以捕获 stderr：aria2c 启动失败（端口占用/参数错/损坏）
        // 时 stderr 含真实原因，原 'ignore' 会丢失导致只报笼统的 rpc not ready。
        const proc = spawn(this.binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        this.proc = proc;
        // 重置上次启动的残留诊断信息（exit code / spawn error / stderr）
        this._exitCode = null;
        this._spawnError = '';
        this._stderrBuf = '';
        // 收集 stderr 尾部（裁剪到 500 字符避免占用过多内存），用于错误诊断
        this._stderrBuf = '';
        this.proc.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            this._stderrBuf = (this._stderrBuf + text).slice(-500);
        });
        // 捕获退出码：aria2c --enable-rpc 正常不该退出；记录 code 便于区分
        // 正常退出（0，理论不出现）与错误退出（非 0，如端口占用/参数错）。
        proc.on('exit', (code) => {
            if (code) { try { console.error(`[aria2] exited code=${code}`); } catch (e) { /* ignore */ } }
            this._exitCode = code; // 诊断信息照常记录（含旧进程迟到 exit 的场景）
            // H-9：stop→start 已换新进程时旧进程的迟到 exit——不清新进程的 this.proc/_ready，
            // 否则新任务被误判「aria2 not running」、_waitReady 提前误跳
            if (this.proc !== proc) return;
            this.proc = null;
            this._ready = null;
        });
        // spawn 失败（权限/损坏/被杀软拦截）会触发 'error' 而非 'exit'；
        // 未监听会作为未捕获异常崩主进程，且 _waitReady 只会空转到超时误报 rpc not ready。
        // 记录真实错误信息供 _waitReady 在抛出时附带，便于用户定位（如路径无效/被拦截）。
        this.proc.on('error', (err) => {
            this._spawnError = err && err.message ? err.message : String(err);
            this.proc = null;
            this._ready = null;
        });

        // 立即探测 + 200 次 × 200ms = ~40s：慢机/首次启动（AV 扫描、DHT 初始化）
        // RPC 起得晚，需宽松窗口。proc 若中途死掉，_waitReady 会提前跳出而非空等满时长。
        this._ready = this._waitReady(200).catch((e) => {
            this._ready = null;
            this.stop();
            throw e;
        });
        return this._ready;
    }

    async _waitReady(attempts) {
        // 立即开始探测、未就绪每 200ms 重试：RPC bind 通常几十毫秒完成，固定延迟
        // 只会白白拖慢下载页首屏（历史 bug：此前先睡 1s 再探测，列表固定晚 1 秒出现）。
        // 探测失败仅重试、无副作用（_rpc 为纯 HTTP 请求且异常被捕获）；进程死亡由
        // exit/error 事件置空 this.proc 判定，与探测失败无关，不存在误判路径。
        for (let i = 0; i < attempts; i++) {
            // 进程已退出（spawn error / 立即崩溃）：继续轮询无意义，立即抛出真实原因。
            if (!this.proc) {
                // 拼接真实诊断信息：spawn 错误 > 退出码 > stderr 尾部 > 默认提示
                const parts = ['aria2 process exited before rpc ready'];
                if (this._spawnError) parts.push(`spawn error: ${this._spawnError}`);
                if (this._exitCode !== undefined && this._exitCode !== null) parts.push(`exit code=${this._exitCode}`);
                if (this._stderrBuf && this._stderrBuf.trim()) {
                    parts.push(`stderr: ${this._stderrBuf.trim().split('\n').slice(-3).join(' | ')}`);
                }
                throw new Error(parts.join(' · '));
            }
            try { await this.getVersion(); return true; } catch (e) { /* 未就绪 */ }
            await new Promise((r) => setTimeout(r, 200));
        }
        // 超时仍未就绪：附 stderr 尾部帮助定位（如端口冲突 / 防火墙拦截）
        const parts = ['aria2 rpc not ready'];
        if (this._stderrBuf && this._stderrBuf.trim()) {
            parts.push(`stderr: ${this._stderrBuf.trim().split('\n').slice(-3).join(' | ')}`);
        }
        throw new Error(parts.join(' · '));
    }

    stop() {
        if (this.proc) {
            try { this.proc.kill(); } catch (e) { /* ignore */ }
            this.proc = null;
        }
        this._ready = null;
        // 重置诊断信息，避免下次启动误带上一次的残留状态
        this._exitCode = null;
        this._spawnError = '';
        this._stderrBuf = '';
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
    /** 调整并发任务数：运行中经 changeGlobalOption 即时生效（含排队中的任务重新调度），
     *  未启动时仅记录、待下次启动随 CLI 参数生效。
     *  注意：aria2 RPC 选项键为短横线格式（CLI 长选项去掉 --），驼峰键会被 aria2
     *  以「无法识别的选项」拒绝且此前被静默吞掉，导致运行中改并发从不生效——
     *  现将失败上抛，由调用方如实提示用户「重启引擎后生效」。 */
    async setConcurrency(n) {
        this.concurrency = Math.max(1, Math.min(10, n | 0));
        if (this.proc) {
            await this.changeGlobalOption({ 'max-concurrent-downloads': String(this.concurrency) });
        }
        return this.concurrency;
    }
    /** 调整分片并发数：全局选项是新增任务的模板，改完即对此后新增任务生效
     *  （进行中任务的既有连接数不变）。键名同样必须为短横线格式。 */
    async setSplit(n) {
        this.split = Math.max(1, Math.min(32, n | 0));
        if (this.proc) {
            await this.changeGlobalOption({
                split: String(this.split),
                'max-connection-per-server': String(this.split),
            });
        }
        return this.split;
    }
    addUri(urls, opts = {}) {
        const list = [].concat(urls);
        // 磁链任务级补 tracker：全局 --bt-tracker 对经 RPC 新增的磁链不总是生效，
        // 显式在任务 options 里带上 bt-tracker，确保每个磁链都有 DHT 之外的 peer 来源。
        const isMagnet = list.some((u) => /^magnet:/i.test(String(u)));
        const finalOpts = isMagnet ? { 'bt-tracker': BT_TRACKERS.join(','), ...opts } : opts;
        return this._rpc('addUri', [list, this._proxyOpts(finalOpts)]);
    }
    addTorrent(b64, opts = {}) { return this._rpc('addTorrent', [b64, [], this._proxyOpts(opts)]); }
    addMetalink(b64, opts = {}) { return this._rpc('addMetalink', [b64, this._proxyOpts(opts)]); }
    pause(gid) { return this._rpc('pause', [gid]); }
    unpause(gid) { return this._rpc('unpause', [gid]); }
    /** 全部暂停（返回被暂停的 gid 数组）。aria2 原生 pauseAll 仅暂停 active 任务，
     *  腾出的并发位会被调度器立即用 waiting 任务补上，批量下载时表现为按钮失效；
     *  故取 active + waiting 快照逐个 pause（tellWaiting 含已暂停任务，需按 status 排除），
     *  期间被调度器补位的任务其 gid 已在快照中，pause 对 active/waiting 均生效，不受影响。 */
    async pauseAll() {
        const [active, waiting] = await Promise.all([
            this.tellActive(), this.tellWaiting(),
        ]);
        const targets = [...active, ...waiting].filter((s) => s && s.gid && s.status !== 'paused');
        const rs = await Promise.allSettled(targets.map((s) => this.pause(s.gid)));
        return rs.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    }
    /** 全部恢复（返回被恢复的 gid 数组）。aria2 原生 unpauseAll 返回的是恢复数量
     *  （数字而非 gid 列表），调用方按数组统计会导致恒报「没有已暂停的任务」；
     *  故与 pauseAll 对齐：waiting 快照筛出 paused 任务逐个 unpause
     *  （tellWaiting 含排队中任务，需按 status 过滤），返回实际恢复成功的 gid。 */
    async unpauseAll() {
        const waiting = await this.tellWaiting();
        const targets = (waiting || []).filter((s) => s && s.gid && s.status === 'paused');
        const rs = await Promise.allSettled(targets.map((s) => this.unpause(s.gid)));
        return rs.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    }
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
        let uri = '';
        if (!name && first) {
            if (first.path) name = path.basename(first.path.replace(/[\\/]+$/, ''));
            else if (first.uris && first.uris[0]) name = decodeURIComponent(first.uris[0].uri.split('?')[0].split('/').pop() || first.uris[0].uri);
        }
        // 提取原始 URI（供持久化后恢复下载用；非 BT 用 uris[0].uri，BT 取 infoHash）
        if (first && first.uris && first.uris[0]) {
            uri = first.uris[0].uri;
        } else if (s.bittorrent && s.bittorrent.info && s.bittorrent.info.infoHash) {
            uri = 'magnet:?xt=urn:btih:' + s.bittorrent.info.infoHash.toUpperCase();
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
            uri, // 原始 URI，用于重启后恢复下载
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
