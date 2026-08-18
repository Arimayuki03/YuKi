/**
 * sync_http.cjs
 * 提供同步 HTTP / HTTPS 请求辅助脚本，供 worker_runner.mjs 在 Node 端同步执行 request/post。
 * 由于 drpy 传统规则是同步函数写法语义（var res = request(url); var data = JSON.parse(res);），
 * 同步请求机制可确保所有同步 rule 直接无缝运行。
 */

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

function syncRequest(urlStr, options = {}) {
    const parsedUrl = new URL(urlStr);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const method = (options.method || (options.body ? 'POST' : 'GET')).toUpperCase();
    const headers = Object.assign({}, options.headers || {});
    const body = options.body || options.data || '';

    let bodyBuffer = null;
    if (body) {
        if (typeof body === 'string') {
            bodyBuffer = Buffer.from(body, 'utf-8');
        } else if (Buffer.isBuffer(body)) {
            bodyBuffer = body;
        } else {
            bodyBuffer = Buffer.from(JSON.stringify(body), 'utf-8');
        }
        headers['Content-Length'] = bodyBuffer.length;
    }

    const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method,
        headers: headers,
        timeout: options.timeout || 10000
    };

    const req = client.request(reqOptions, (res) => {
        // 跟随重定向 (301, 302, 303, 307, 308)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, urlStr).toString();
            syncRequest(redirectUrl, options);
            return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            process.stdout.write(buffer);
            process.exit(0);
        });
    });

    req.on('error', (err) => {
        process.stderr.write(err.message || String(err));
        process.exit(1);
    });

    req.on('timeout', () => {
        req.destroy();
        process.stderr.write('Request timeout');
        process.exit(1);
    });

    if (bodyBuffer) {
        req.write(bodyBuffer);
    }
    req.end();
}

const inputArg = process.argv[2];
if (inputArg) {
    try {
        const cfg = JSON.parse(inputArg);
        syncRequest(cfg.url, cfg.options);
    } catch (e) {
        process.stderr.write(e.message);
        process.exit(1);
    }
}
