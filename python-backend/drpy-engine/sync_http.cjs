/**
 * sync_http.cjs
 * 专门用于在子进程中同步发起 HTTP 请求，将响应输出到 stdout。
 * 包含最大重定向层数防护、超时防护与错误捕获。
 */

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const MAX_REDIRECTS = 10;

function syncRequest(targetUrl, options = {}, redirectCount = 0) {
    if (redirectCount > MAX_REDIRECTS) {
        process.stderr.write(`[sync_http error] Exceeded maximum redirects (${MAX_REDIRECTS})\n`);
        process.exit(1);
    }

    try {
        const parsedUrl = new URL(targetUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const bodyPayload = options.body || options.data;
        const headers = Object.assign({}, options.headers || {});
        let bodyBuffer = null;
        if (bodyPayload) {
            if (typeof bodyPayload === 'string') {
                bodyBuffer = Buffer.from(bodyPayload, 'utf-8');
            } else if (Buffer.isBuffer(bodyPayload)) {
                bodyBuffer = bodyPayload;
            } else if (typeof bodyPayload === 'object') {
                bodyBuffer = Buffer.from(JSON.stringify(bodyPayload), 'utf-8');
            }
            if (bodyBuffer && !headers['Content-Length'] && !headers['content-length']) {
                headers['Content-Length'] = bodyBuffer.length;
            }
        }

        const reqOpts = {
            method: (options.method || 'GET').toUpperCase(),
            headers: headers,
            timeout: (options.timeout || 15) * 1000,
            rejectUnauthorized: false
        };

        const req = client.request(parsedUrl, reqOpts, (res) => {
            // 处理 301, 302, 303, 307, 308 重定向
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, parsedUrl).toString();
                syncRequest(redirectUrl, options, redirectCount + 1);
                return;
            }

            const chunks = [];
            res.on('data', (chunk) => {
                chunks.push(chunk);
            });

            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                if (options.buffer) {
                    process.stdout.write(buffer);
                } else {
                    process.stdout.write(buffer.toString('utf-8'));
                }
                process.exit(0);
            });
        });

        req.on('error', (err) => {
            process.stderr.write(`[sync_http error] ${err.message}\n`);
            process.exit(1);
        });

        req.on('timeout', () => {
            req.destroy();
            process.stderr.write(`[sync_http error] Request timed out\n`);
            process.exit(1);
        });

        if (bodyBuffer) {
            req.write(bodyBuffer);
        }

        req.end();
    } catch (err) {
        process.stderr.write(`[sync_http exception] ${err.message}\n`);
        process.exit(1);
    }
}

// 从命令行入参中解析 JSON payload
const inputJson = process.argv[2];
if (inputJson) {
    try {
        const { url, options } = JSON.parse(inputJson);
        syncRequest(url, options);
    } catch (err) {
        process.stderr.write(`[sync_http parse error] ${err.message}\n`);
        process.exit(1);
    }
} else {
    process.stderr.write('[sync_http error] No payload provided.\n');
    process.exit(1);
}
