/**
 * syncplay-client.js — SyncPlay 协议客户端（多人一起看）
 *
 * 协议参考：https://syncplay.pl/about/protocol/
 * 默认服务器：syncplay.pl:8996（需 TLS）
 *
 * 职责：连接 SyncPlay 服务器，同步播放/暂停/拖动/换集，聊天以橙色底部弹幕渲染。
 * 与 mpv-player 协作：监听 mpv 播放状态变化，广播给房间其他成员；接收远端指令控制 mpv。
 */
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

const DEFAULT_SERVER = 'syncplay.pl';
const DEFAULT_PORT = 8996;
const PROTOCOL_VERSION = '1.7.0';

class SyncplayClient extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.connected = false;
        this.room = '';
        this.username = '';
        this.usernameList = {};
        this.pingMovingAvg = 0;
        this.lastPingTime = 0;
        this.lastFileUpdate = 0;
        this.serverIgnores = [];
        this.clientRtt = 0;
        this.clientLatencyCalculation = 0;
        this._pingTimer = null;
        this._recvBuf = '';   // TCP 接收缓冲：跨 chunk 拼帧，残包保留到下一 chunk（条目 7）
        this._connectGen = 0; // connect 代际：重连/断开后递增，旧 socket 事件按代际失效（条目 8）
        // 兜底 error 监听，防 EventEmitter 抛 ERR_UNHANDLED_ERROR 致进程崩溃
        this.on('error', () => {});
        // 在途 connect 的 reject：disconnect/重连 teardown 掉旧 socket 后，其
        // close/error 监听已被摘除、代际守卫又会跳过 reject——promise 会永久
        // 悬挂（IPC 调用方一直转圈）。teardown 时从这里收口。
        this._connectReject = null;
    }

    /**
     * 连接 SyncPlay 服务器并加入房间。
     * @param {string} server 服务器地址
     * @param {number} port 端口
     * @param {string} username 用户名
     * @param {string} room 房间名
     * @param {boolean} useTls 是否使用 TLS（默认 true）
     * @param {object} [opts] 可选项
     * @param {boolean} [opts.insecureTls] 显式跳过证书校验（自签服务器兼容开关，
     *        默认 false——P3-7：原实现无条件 rejectUnauthorized:false，TLS 隧道对
     *        MITM 敞开，链路虽无凭据但同步指令/聊天可被中间人伪造。仅自签服务器
     *        场景由调用方显式传入，公共服务器一律走默认严格校验）。
     */
    connect(server, port, username, room, useTls = true, opts = {}) {
        this.username = username;
        this.room = room;
        const host = server || DEFAULT_SERVER;
        const p = port || DEFAULT_PORT;

        // 条目 8：重连前先清旧 socket/定时器/接收缓冲。原实现直接覆盖 this.socket，
        // 旧连接的 data/close 监听仍挂在旧 socket 上（close 还会再 emit 一次 disconnect），
        // 且 ping 定时器在握手前关闭时无人回收。断开为静默清理（不留 disconnect 事件）。
        const gen = ++this._connectGen;
        this._teardownSocket();

        return new Promise((resolve, reject) => {
            // 代际守卫：connect 被再次调用（或 disconnect）后，旧 socket 的事件不再落 handle
            const stale = () => gen !== this._connectGen;
            // 存到实例：disconnect()/_teardownSocket() 接管时（旧监听已摘除、
            // 代际守卫跳过 reject）由这里收口在途 promise，不悬挂
            this._connectReject = reject;
            const onError = (err) => {
                if (stale()) return;
                this.connected = false;
                this.emit('error', err);
                reject(err);
            };
            const onConnect = () => {
                if (stale()) return;
                this.connected = true;
                this._connectReject = null; // promise 已 resolve，teardown 无需再收口
                this._sendHello();
                this._startPingLoop();
                resolve();
            };
            if (useTls) {
                // 默认校验服务端证书（rejectUnauthorized:true）；证书错误时 Node 会以
                // CERT_HAS_EXPIRED / SELF_SIGNED_CERT_IN_CHAIN 等前缀报错，连接失败
                // 提示可据此区分自签场景（需自签兼容请显式开启 insecureTls）。
                this.socket = tls.connect({ host, port: p, rejectUnauthorized: opts.insecureTls !== true }, onConnect);
            } else {
                this.socket = net.connect({ host, port: p }, onConnect);
            }
            this.socket.setEncoding('utf8');
            this.socket.on('data', (data) => { if (!stale()) this._onData(data); });
            this.socket.on('error', onError);
            // 条目 8：握手完成前 socket 被 close（服务器拒连/网络断/TLS 握手失败）时，
            // 原实现既不 resolve 也不 reject，connect promise 永久悬挂、IPC 调用方一直转圈。
            // close 后仍按错误收口 promise；已 resolve 的连接断开走既有 disconnect 事件。
            this.socket.on('close', () => {
                if (stale()) return;
                this.connected = false;
                this._stopPingLoop();
                // 代际未变说明本次 connect 尚未被 disconnect 接管：视为本次连接失败
                this._connectGen++;
                this.socket = null;
                this._connectReject = null; // promise 即将在此收口，teardown 无需再管
                this.emit('disconnect');
                reject(new Error('连接在完成握手前已关闭'));
            });
            // close/error 双到时 reject 只生效一次（Promise 语义），无需额外去重
        });
    }

    /** 清理当前 socket 与接收缓冲（connect 重连前 / disconnect 共用，静默不发事件）。 */
    _teardownSocket() {
        this._stopPingLoop();
        // 在途 connect 的 promise 收口：此时旧 socket 的 close/error 监听已被
        // 摘除（下一行），其 reject 永远不会触发，只能由这里以错误结束。
        if (this._connectReject) {
            const reject = this._connectReject;
            this._connectReject = null;
            reject(new Error('连接被 disconnect/重连接管，未完成握手'));
        }
        if (this.socket) {
            const sock = this.socket;
            this.socket = null;
            try {
                // 摘掉业务监听（data/close 会 emit disconnect、污染新连接），但 error/close
                // 必须补一个空 handler 再销毁：destroy 后内核仍可能吐 ECONNRESET，
                // 无监听的 error 事件会以 ERR_UNHANDLED_ERROR 打崩主进程。
                sock.removeAllListeners();
                sock.on('error', () => {});
                sock.on('close', () => {});
            } catch (e) { /* ignore */ }
            try { sock.end(); } catch (e) { /* ignore */ }
            try { sock.destroy(); } catch (e) { /* ignore */ }
        }
        this._recvBuf = '';
        this.connected = false;
    }

    /** 断开连接并离开房间。 */
    disconnect() {
        // 条目 8：代际递增使在途 connect 的回调/close 全部失效。其 promise 由
        // _teardownSocket 里的 _connectReject 以错误收口（旧 socket 监听已摘除、
        // 代际守卫又跳过 reject，不在此收口就会永久悬挂）；随后静默清理旧 socket。
        this._connectGen++;
        this._teardownSocket();
        this.emit('disconnect');
    }

    /** 发送 Hello 消息。 */
    _sendHello() {
        this._send({
            Hello: {
                username: this.username,
                room: { name: this.room },
                version: PROTOCOL_VERSION,
                features: {
                    sharedPlaylists: true,
                    chat: true,
                    featureList: true,
                    readiness: true,
                    managedRooms: false,
                },
            },
        });
    }

    /** 发送状态消息（播放位置/暂停/Seek）。 */
    sendState(position, paused, doSeek) {
        if (!this.connected) return;
        const ts = Date.now() / 1000;
        this.clientLatencyCalculation = ts;
        this._send({
            State: {
                position: position || 0,
                paused: !!paused,
                doSeek: doSeek || false,
                clientLatencyCalculation: this.clientLatencyCalculation,
                clientRtt: this.clientRtt,
            },
        });
    }

    /** 发送文件信息（换集时通知房间）。 */
    sendFile(name, duration) {
        if (!this.connected) return;
        this.lastFileUpdate = Date.now() / 1000;
        this._send({
            Set: {
                file: {
                    name: name,
                    duration: duration || 0,
                    size: 0,
                },
            },
        });
    }

    /** 发送聊天消息。 */
    sendChat(message) {
        if (!this.connected) return;
        this._send({ Chat: { message } });
    }

    /** 发送准备就绪状态。 */
    sendReady(ready) {
        if (!this.connected) return;
        this._send({ Set: { ready: { manuallySet: true, isReady: ready, explicitlySet: true } } });
    }

    _send(obj) {
        if (!this.socket || !this.connected) return;
        try {
            this.socket.write(JSON.stringify(obj) + '\r\n');
        } catch (e) { /* 连接已断开 */ }
    }

    _onData(data) {
        // 条目 7：SyncPlay 消息以 \r\n 分帧，TCP 是字节流、单个 chunk 可能只含半条
        // 消息或拼有多条消息。原实现按 chunk 直接 split，跨包截断的消息 JSON.parse
        // 失败被静默丢弃（表现为状态/聊天随机丢消息）。这里维护接收缓冲：累积后按
        // \r\n 切帧，最后一段残包留在缓冲里等下一个 chunk。
        this._recvBuf += data;
        // \r?\n 兼容：官方服务器发 \r\n，宽容处理裸 \n，避免异常服务器卡死缓冲
        let idx;
        while ((idx = this._recvBuf.search(/\r?\n/)) >= 0) {
            const m = this._recvBuf.slice(idx).match(/^\r?\n/);
            const sepLen = m ? m[0].length : 1;
            const line = this._recvBuf.slice(0, idx);
            this._recvBuf = this._recvBuf.slice(idx + sepLen);
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                this._handleMessage(msg);
            } catch (e) {
                /* 非 JSON 行忽略 */
            }
        }
        // 防御上限：单帧超 1MB 视为恶意/异常数据，清空缓冲防内存被撑爆
        if (this._recvBuf.length > 1024 * 1024) this._recvBuf = '';
    }

    _handleMessage(msg) {
        if (msg.Hello) {
            // 服务器 Hello 响应
            this.emit('hello', msg.Hello);
        } else if (msg.State) {
            // 远端状态更新
            this.emit('state', {
                position: msg.State.position,
                paused: msg.State.paused,
                doSeek: msg.State.doSeek,
                setBy: msg.State.setBy,
                latencyCalculation: msg.State.latencyCalculation,
                serverRtt: msg.State.serverRtt,
            });
        } else if (msg.Set) {
            if (msg.Set.user) {
                // 用户列表更新
                this.usernameList = msg.Set.user;
                this.emit('users', msg.Set.user);
            }
            if (msg.Set.file) {
                // 远端换集
                this.emit('file', msg.Set.file);
            }
            if (msg.Set.ready) {
                this.emit('ready', msg.Set.ready);
            }
        } else if (msg.Chat) {
            // 聊天消息
            this.emit('chat', { username: msg.Chat.username, message: msg.Chat.message });
        } else if (msg.Error) {
            this.emit('error', new Error(msg.Error.message || 'SyncPlay error'));
        }
    }

    _startPingLoop() {
        // 先清旧定时器：重复 connect 时若直接覆盖句柄，旧 interval 的引用丢失、
        // 再也无法清理，连 N 次就会并行跑 N 个 ping 循环
        this._stopPingLoop();
        this._pingTimer = setInterval(() => {
            if (!this.connected) return;
            this.lastPingTime = Date.now();
            this._send({ State: { ping: { clientLatencyCalculation: Date.now() / 1000, clientRtt: this.clientRtt } } });
        }, 5000);
    }

    /** 停止 ping 定时器（幂等）。 */
    _stopPingLoop() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    }
}

module.exports = SyncplayClient;
