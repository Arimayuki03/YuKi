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
        this._onError = () => {}; // 兜底 noop，防 ERR_UNHANDLED_ERROR
    }

    /**
     * 连接 SyncPlay 服务器并加入房间。
     * @param {string} server 服务器地址
     * @param {number} port 端口
     * @param {string} username 用户名
     * @param {string} room 房间名
     * @param {boolean} useTls 是否使用 TLS（默认 true）
     */
    connect(server, port, username, room, useTls = true) {
        this.username = username;
        this.room = room;
        const host = server || DEFAULT_SERVER;
        const p = port || DEFAULT_PORT;

        return new Promise((resolve, reject) => {
            const onError = (err) => {
                this.connected = false;
                this.emit('error', err);
                reject(err);
            };
            const onConnect = () => {
                this.connected = true;
                this._sendHello();
                this._startPingLoop();
                resolve();
            };
            if (useTls) {
                this.socket = tls.connect({ host, port: p, rejectUnauthorized: false }, onConnect);
            } else {
                this.socket = net.connect({ host, port: p }, onConnect);
            }
            this.socket.setEncoding('utf8');
            this.socket.on('data', (data) => this._onData(data));
            this.socket.on('error', onError);
            this.socket.on('close', () => {
                this.connected = false;
                this.emit('disconnect');
            });
        });
    }

    /** 断开连接并离开房间。 */
    disconnect() {
        this.connected = false;
        if (this.socket) {
            try { this.socket.end(); } catch (e) { /* ignore */ }
            this.socket = null;
        }
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
        // SyncPlay 消息以 \r\n 分隔
        const lines = data.split(/\r?\n/);
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                this._handleMessage(msg);
            } catch (e) {
                /* 非 JSON 行忽略 */
            }
        }
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
        this._pingTimer = setInterval(() => {
            if (!this.connected) return;
            this.lastPingTime = Date.now();
            this._send({ State: { ping: { clientLatencyCalculation: Date.now() / 1000, clientRtt: this.clientRtt } } });
        }, 5000);
    }
}

module.exports = SyncplayClient;
