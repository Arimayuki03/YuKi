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
const https = require('https');
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
// 默认列表取自 trackerslist.com 的 best_aria2.txt（2026-09-28 拉取，共 71 条），
// 需刷新时从 https://cf.trackerslist.com/best_aria2.txt 重新拉取整段替换即可。
const BT_TRACKERS = [
    // http
    'http://1337.abcvg.info:80/announce',
    'http://bt1.archive.org:6969/announce',
    'http://bt2.archive.org:6969/announce',
    'http://ipv4announce.sktorrent.eu:6969/announce',
    'http://nyaa.tracker.wf:7777/announce',
    'http://torrentsmd.com:8080/announce',
    'http://tracker.dhitechnical.com:6969/announce',
    'http://tracker.dler.com:6969/announce',
    'http://tracker.dler.org:6969/announce',
    'http://tracker.mywaifu.best:6969/announce',
    'http://tracker.renfei.net:8080/announce',
    'http://tracker.waaa.moe:6969/announce',
    'http://tracker2.dler.org:80/announce',
    'http://www.wareztorrent.com:80/announce',
    // https
    'https://004430.xyz:443/announce',
    'https://1.tracker.eu.org:443/announce',
    'https://1337.abcvg.info:443/announce',
    'https://t.213891.xyz:443/announce',
    'https://tr.abiir.top:443/announce',
    'https://tr.burnabyhighstar.com:443/announce',
    'https://tracker.7471.top:443/announce',
    'https://tracker.foreverpirates.co:443/announce',
    'https://tracker.kuroy.me:443/announce',
    'https://tracker.nekomi.cn:443/announce',
    'https://tracker.pmman.tech:443/announce',
    'https://tracker.qingwapt.org:443/announce',
    'https://tracker1.520.jp:443/announce',
    // udp
    'udp://anime-tracker.aruku.kro.kr:8081/announce',
    'udp://bittorrent-tracker.e-n-c-r-y-p-t.net:1337/announce',
    'udp://evan.im:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://explodie.org:6969/announce',
    'udp://ipv6.govt.hu:6969/announce',
    'udp://mail.segso.net:6969/announce',
    'udp://martin-gebhardt.eu:25/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://open.ftorrent.com:443/announce',
    'udp://open.stealth.si:80/announce',
    'udp://open.tracker.ink:6969/announce',
    'udp://opentor.org:2710/announce',
    'udp://opentracker.lain.moscow:6969/announce',
    'udp://p4p.arenabg.com:1337/announce',
    'udp://retracker.hotplug.ru:2710/announce',
    'udp://retracker01-msk-virt.corbina.net:80/announce',
    'udp://t.overflow.biz:6969/announce',
    'udp://torrent.tracker.durukanbal.com:6969/announce',
    'udp://tr4ck3r.duckdns.org:6969/announce',
    'udp://tracker-udp.gbitt.info:80/announce',
    'udp://tracker.aruku.ovh:8081/announce',
    'udp://tracker.bittor.pw:1337/announce',
    'udp://tracker.cn.nyaa.net:6969/announce',
    'udp://tracker.corpscorp.online:80/announce',
    'udp://tracker.dler.com:6969/announce',
    'udp://tracker.ducks.party:1984/announce',
    'udp://tracker.farted.net:6969/announce',
    'udp://tracker.gmi.gd:6969/announce',
    'udp://tracker.ilibr.org:6969/announce',
    'udp://tracker.k.vu:6969/announce',
    'udp://tracker.nyaa.net:6969/announce',
    'udp://tracker.nyaa.vc:6969/announce',
    'udp://tracker.opentrackr.com:6969/announce',
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.peerfect.org:6969/announce',
    'udp://tracker.qu.ax:6969/announce',
    'udp://tracker.skynetcloud.site:6969/announce',
    'udp://tracker.skyts.net:6969/announce',
    'udp://tracker.teambelgium.net:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.torrents.observer:80/announce',
    'udp://v6.vito-tracker.space:6969/announce',
    // wss（aria2 不支持 WebSocket tracker，保留以与源列表一致，announce 失败会被静默忽略）
    'wss://tracker.openwebtorrent.com:443/announce',
];

// -------------------------------------------------------------- tracker 自动刷新
// 内置列表会随时间失效（公共 tracker 存活率波动大），定期从 trackerslist.com
// 拉取最新 best 列表热更新；失败静默回退当前列表（内置 → 上次缓存），永不影响下载。

const TRACKER_SOURCE = 'https://cf.trackerslist.com/best_aria2.txt';
// 成功后 72h 内不再拉取；失败后 6h 退避重试（网络差/被墙时避免每次启动都空打一发）
const TRACKER_REFRESH_OK_MS = 72 * 60 * 60 * 1000;
const TRACKER_REFRESH_FAIL_MS = 6 * 60 * 60 * 1000;
// 拉取超时与重定向跟随上限（cf.trackerslist.com 可能经 CDN 30x 跳转）
const TRACKER_FETCH_TIMEOUT_MS = 15000;
const TRACKER_FETCH_MAX_REDIRECTS = 3;
// 缓存文件名（userData 下）：记录列表内容 + 上次成功/失败时间，跨会话持久
const TRACKER_CACHE_FILE = 'tracker-cache.json';

/** 校验拉取文本并解析为 tracker 数组；不合法返回 null（调用方回退当前列表）。
 *  Aria2 格式为逗号分隔（兼容换行分隔），逐条 scheme/host 校验剔除坏行；
 *  有效条数 <10 视为异常响应（防 CDN 错误页/截断），>300 截断（aria2 无压力上限，
 *  但保留合理规模）。 */
function parseTrackerList(text) {
    if (typeof text !== 'string') return null;
    const items = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const item of items) {
        // 仅放行 aria2 认识的 announce 协议；udp6 需 --enable-dht6 之外参数，先不收
        if (!/^(https?|udp|wss):\/\/[^\s/:]+(:\d+)?\/announce$/i.test(item)) continue;
        if (seen.has(item)) continue;
        seen.add(item);
        if (out.length >= 300) break;
        out.push(item);
    }
    if (out.length < 10) return null;
    return out;
}

/** HTTPS GET 拉取文本，跟随最多 maxRedirects 次 3xx；超时/网络错/非 2xx 抛异常。 */
function fetchText(url, redirects = TRACKER_FETCH_MAX_REDIRECTS) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: TRACKER_FETCH_TIMEOUT_MS }, (rsp) => {
            const status = rsp.statusCode || 0;
            // 3xx：取 Location 重发（跨 host 允许，纯只读公开文本，无凭据泄漏面）。
            // 本回调是事件回调而非 Promise executor：同步 throw 不会变成 rejection，
            // 会让 fetchText 永不 settle 并卡死 refreshTrackers 防并发锁——
            // URL 解析必须 try/catch 兜底（CDN 错误页可能回畸形 Location）。
            if (status >= 300 && status < 400 && rsp.headers.location) {
                if (redirects <= 0) return reject(new Error('too many redirects'));
                let next;
                try {
                    next = new URL(rsp.headers.location, url).toString();
                } catch (e) {
                    return reject(new Error(`bad redirect location: ${rsp.headers.location}`));
                }
                rsp.resume(); // 排空当前响应，socket 及时归还连接池
                resolve(fetchText(next, redirects - 1));
                return;
            }
            if (status < 200 || status >= 300) {
                return reject(new Error(`HTTP ${status}`));
            }
            let text = '';
            // 上限 1MB：正常列表 <10KB，超限视为异常响应不再累积
            rsp.on('data', (c) => {
                text += c;
                if (text.length > 1024 * 1024) req.destroy(new Error('response too large'));
            });
            rsp.on('end', () => resolve(text));
        });
        req.on('timeout', () => req.destroy(new Error('fetch timeout')));
        req.on('error', reject);
    });
}

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
        // tracker 自动刷新状态：当前生效列表（默认内置）、缓存路径（start 时定位）、
        // 定时器与防并发锁。失败静默，仅打 console.warn 便于诊断。
        this._trackers = BT_TRACKERS.slice();
        this._trackerCacheFile = '';
        this._trackerTimer = null;
        this._trackerRefreshing = false;
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
            `--bt-tracker=${this._trackers.join(',')}`,
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
        this._ready = this._waitReady(200).then((ok) => {
            // 引擎就绪后异步刷新公共 tracker 列表（缓存新鲜则不出网，失败静默回退）
            this.scheduleTrackerRefresh();
            return ok;
        }).catch((e) => {
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
        // tracker 刷新定时器随引擎生命周期停止（下次 start 重新调度）
        if (this._trackerTimer) {
            clearInterval(this._trackerTimer);
            this._trackerTimer = null;
        }
        // P3-20：通知集合与引擎生命周期对齐——aria2 gid 仅单会话唯一，引擎重启后
        // 同名 gid 不会复现，但集合只增不减会随长期运行缓慢增长；引擎停止即整体清空。
        this._notified.clear();
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
    // ------------------------------------------------------------ tracker 自动刷新

    /** 读取缓存文件（不存在/损坏返回 null）。结构：{ url, trackers, updatedAt, failedAt } */
    _readTrackerCache() {
        if (!this._trackerCacheFile) return null;
        try {
            const raw = JSON.parse(fs.readFileSync(this._trackerCacheFile, 'utf8'));
            if (!raw || !Array.isArray(raw.trackers)) return null;
            return raw;
        } catch (e) { return null; }
    }

    /** 写缓存（失败静默：缓存只是加速手段，写不进去不影响功能） */
    _writeTrackerCache(data) {
        if (!this._trackerCacheFile) return;
        try {
            fs.writeFileSync(this._trackerCacheFile, JSON.stringify(data), 'utf8');
        } catch (e) { /* 只读盘/磁盘满等，忽略 */ }
    }

    /**
     * 拉取远端列表并热更新。永不抛出——失败返回 null 并记录退避时间，
     * 成功返回新 tracker 数组。决策顺序：
     *   1. 命中缓存且 updatedAt 距今 < 72h → 直接用缓存列表（不出网）
     *   2. 缓存 updatedAt 过期但 failedAt 距今 < 6h → 不重试（退避期）
     *   3. 拉取 → 校验 → 成功则热更新（aria2 运行中经 changeGlobalOption）并写缓存
     *   4. 拉取/校验失败 → 上报失败时间（写缓存 failedAt），保持现有列表
     * @param {number} now 当前时刻（测试注入用，缺省 Date.now()）
     * @returns {Promise<string[]|null>} 新列表（无更新或失败为 null）
     */
    async refreshTrackers(now = Date.now()) {
        if (this._trackerRefreshing) return null;
        this._trackerRefreshing = true;
        try {
            const cached = this._readTrackerCache();
            if (cached && this._trackerCacheFile) {
                const fresh = now - (cached.updatedAt || 0) < TRACKER_REFRESH_OK_MS;
                const cooling = now - (cached.failedAt || 0) < TRACKER_REFRESH_FAIL_MS;
                if (fresh) {
                    // 缓存新鲜：过校验后换成缓存列表（可能与当前一致），不出网
                    const list = parseTrackerList(cached.trackers.join(','));
                    if (list) {
                        this._applyTrackers(list);
                        return list;
                    }
                    // 缓存内容已不合法：当无缓存处理，继续走拉取
                } else if (cooling) {
                    return null; // 上次失败后退避期内：不重试
                }
            }
            let list = null;
            try {
                const text = await fetchText(TRACKER_SOURCE);
                list = parseTrackerList(text);
            } catch (e) { /* 网络错：走下方失败记录 */ }
            if (list) {
                const data = { url: TRACKER_SOURCE, trackers: list, updatedAt: now, failedAt: 0 };
                this._writeTrackerCache(data);
                await this._applyTrackers(list);
                return list;
            }
            // 失败：记录退避时间。缓存可能不存在（首次启动即失败）→ 只记内存态，
            // 下次 start 再试（无缓存文件可写失败时间，代价是冷启动多一次尝试，可接受）
            if (cached && this._trackerCacheFile) {
                this._writeTrackerCache({ ...cached, failedAt: now });
            }
            return null;
        } finally {
            this._trackerRefreshing = false;
        }
    }

    /** 应用列表到实例并热更新运行中的 aria2（全局选项对新增任务生效）。 */
    async _applyTrackers(list) {
        if (!Array.isArray(list) || !list.length) return;
        const joined = list.join(',');
        if (this._trackers.join(',') === joined) return; // 无变化不触发 RPC
        this._trackers = list.slice();
        if (this.proc) {
            // 热更新失败（RPC 断开等）不影响内存中的新列表：下次 spawn 随 CLI 生效
            await this.changeGlobalOption({ 'bt-tracker': joined }).catch(() => { });
        }
    }

    /**
     * 引擎启动后调用：定位缓存文件 → 立即按需刷新 → 调度 24h 周期复查。
     * 全程异步不 await：绝不能拖慢 start() 的就绪路径。缓存文件放 userData
     * （start 时才 require electron，测试环境 app.getPath 为桩）。
     */
    scheduleTrackerRefresh() {
        if (this._trackerTimer) clearInterval(this._trackerTimer);
        if (!this._trackerCacheFile) {
            try {
                const { app } = require('electron');
                const ud = app.getPath('userData');
                if (!fs.existsSync(ud)) fs.mkdirSync(ud, { recursive: true });
                this._trackerCacheFile = path.join(ud, TRACKER_CACHE_FILE);
            } catch (e) { /* userData 不可用：仅损失缓存与退避持久化，刷新照常 */ }
        }
        // 失败仅告警：定时器回调吞掉所有异常，防止 unhandledRejection
        this.refreshTrackers().catch((e) => {
            try { console.warn('[aria2] tracker 刷新失败:', e && e.message); } catch (e2) { /* ignore */ }
        });
        // 24h 复查一次（refreshTrackers 内部有 72h/6h 闸门，这里只提供节拍）
        this._trackerTimer = setInterval(() => {
            this.refreshTrackers().catch((e) => {
                try { console.warn('[aria2] tracker 刷新失败:', e && e.message); } catch (e2) { /* ignore */ }
            });
        }, 24 * 60 * 60 * 1000);
        // 定时器不阻止进程退出（Electron 主进程常驻，unref 只是防御）
        if (this._trackerTimer.unref) this._trackerTimer.unref();
    }

    addUri(urls, opts = {}) {
        const list = [].concat(urls);
        // 磁链任务级补 tracker：全局 --bt-tracker 对经 RPC 新增的磁链不总是生效，
        // 显式在任务 options 里带上 bt-tracker，确保每个磁链都有 DHT 之外的 peer 来源。
        const isMagnet = list.some((u) => /^magnet:/i.test(String(u)));
        const finalOpts = isMagnet ? { 'bt-tracker': this._trackers.join(','), ...opts } : opts;
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
        return this._rpc('removeDownloadResult', [gid]).catch(() => gid)
            .finally(() => this._forgetNotified(gid));
    }
    /** 从 stopped 列表彻底清除记录（complete/error/removed） */
    purge(gid) {
        return this._rpc('removeDownloadResult', [gid]).finally(() => this._forgetNotified(gid));
    }
    tellStatus(gid) { return this._rpc('tellStatus', [gid]); }

    /** P3-20：任务从 aria2 stopped 列表移除时同步清掉对应通知标记（含 error 侧的 'e'+gid），
     *  集合只增不减会随任务量无界增长。仅当任务已不在列表（purge 之后）才需清；
     *  简化处理：直接删两个键，未通知过的 gid 删空集是无害操作。 */
    _forgetNotified(gid) {
        this._notified.delete(gid);
        this._notified.delete('e' + gid);
    }
    tellActive() { return this._rpc('tellActive'); }
    tellWaiting() { return this._rpc('tellWaiting', [0, 1000]); }
    tellStopped() { return this._rpc('tellStopped', [0, 1000]); }

    // ------------------------------------------------------------ 聚合视图

    /** 宽容解码：URL 片段含裸 %（未转义）时 decodeURIComponent 抛 URIError，
     *  上抛会让该任务永远 flatten 失败 → 无法从列表删除，下载页持续不可用。
     *  失败回退原串，仅损失显示名的可读性。 */
    static safeDecode(s) {
        try { return decodeURIComponent(s); } catch (e) { return s; }
    }

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
            else if (first.uris && first.uris[0]) name = Downloader.safeDecode(first.uris[0].uri.split('?')[0].split('/').pop() || first.uris[0].uri);
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
        // 引擎从未启动（this.dir 为空）时不代拉：start() 对空 dir 回退系统下载目录，
        // 且 _ready 一经建立就不再换目录——轮询先于 startDlEngine(设置目录) 冷启动的话，
        // 整个会话都会烧死在默认目录里（重启/更新后自定义下载目录“被还原”的根因）。
        // 崩溃自愈场景不受影响：proc 退出但 this.dir 保留，轮询照旧原位重拉。
        if (!this.dir) return [];
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
// 测试与潜在调用方可复用校验解析：挂静态而非导出第二份模块
Downloader.parseTrackerList = parseTrackerList;
