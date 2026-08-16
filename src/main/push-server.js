/**
 * push-server.js — 局域网 URL 推送接收（Phase 7.1）
 *
 * 0.0.0.0 随机端口 + 一次性 token 的极简 HTTP 服务：
 * - GET  /                使用说明页（含推送地址模板）
 * - GET|POST /push        ?url=<播放地址>&token=<token>，成功后 emit('push')
 *
 * 手机端用法：浏览器访问 http://<本机IP>:<port>/push?url=...&token=...
 * （对应原版 App「推送」面板的 PC 化：收到即交 mpv 播放）
 */
const os = require('os');
const http = require('http');
const { EventEmitter } = require('events');

class PushServer extends EventEmitter {
    constructor() {
        super();
        this.on('error', () => { });  // EventEmitter 约定兜底
        this.server = null;
        this.port = 0;
        this.token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    /** 取局域网 IPv4 地址（展示用）。 */
    static lanIp() {
        for (const list of Object.values(os.networkInterfaces())) {
            for (const it of list || []) {
                if (it.family === 'IPv4' && !it.internal) return it.address;
            }
        }
        return '127.0.0.1';
    }

    start() {
        if (this.server) return Promise.resolve(this.port);
        this.server = http.createServer((req, res) => this._handle(req, res));
        return new Promise((resolve) => {
            this.server.listen(0, '0.0.0.0', () => {
                this.port = this.server.address().port;
                resolve(this.port);
            });
            this.server.on('error', () => resolve(0));
        });
    }

    stop() {
        if (this.server) { try { this.server.close(); } catch (e) { /* ignore */ } this.server = null; }
    }

    info() {
        return { port: this.port, token: this.token, ip: PushServer.lanIp() };
    }

    _handle(req, res) {
        const u = new URL(req.url, `http://127.0.0.1:${this.port}`);
        if (u.pathname === '/') return this._page(res);
        if (u.pathname === '/push') {
            const done = (params) => {
                const url = (params.get('url') || '').trim();
                if (params.get('token') !== this.token) return this._json(res, 401, { code: 401, msg: 'bad token' });
                if (!/^https?:\/\//i.test(url)) return this._json(res, 400, { code: 400, msg: 'url required (http/https)' });
                this.emit('push', { url });
                return this._json(res, 200, { code: 200, msg: 'push received' });
            };
            if (req.method === 'POST') {
                let body = '';
                req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
                req.on('end', () => {
                    const merged = new URLSearchParams(u.search);
                    new URLSearchParams(body).forEach((v, k) => merged.set(k, v));
                    done(merged);
                });
            } else {
                done(u.searchParams);
            }
            return;
        }
        this._json(res, 404, { code: 404, msg: 'not found' });
    }

    _json(res, code, obj) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
    }

    _page(res) {
        const ip = PushServer.lanIp();
        const html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="utf-8">
<title>影視 PC 推送</title>
<style>body{font-family:sans-serif;background:#121212;color:#eee;padding:40px;max-width:640px;margin:auto;line-height:1.8}
code{background:#333;padding:2px 6px;border-radius:4px;word-break:break-all}</style></head>
<body><h2>影視 PC · URL 推送</h2>
<p>在手機瀏覽器打開以下地址（替換 <code>&lt;播放地址&gt;</code>）即可推送到本機播放：</p>
<code>http://${ip}:${this.port}/push?url=&lt;播放地址&gt;&amp;token=&lt;token&gt;</code>
<p>token 請在應用內「推送」面板查看（首頁不回顯完整 token，避免局域網內任意設備直接讀取）。</p>
<p>支援 GET 與 POST（表單 <code>url</code> 欄位），僅接受 http/https 連結。</p>
</body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    }
}

module.exports = PushServer;
