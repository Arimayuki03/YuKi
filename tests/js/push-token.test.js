// 组件测试：push-server.js — 局域网 URL 推送
// 守住四条安全承诺：token 为随机 base64url、错 token 拒收、只接 http(s)、首页不回显 token。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const PushServer = require('../../src/main/push-server');

/** 裸 http 请求（keepAlive:false）：避免连接池与 server.close 竞态拖住进程退出 */
function request(port, path, method, body) {
    return new Promise((resolve, reject) => {
        const headers = body == null ? {} : {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
        };
        const r = http.request({
            host: '127.0.0.1', port, path, method: method || 'GET', headers,
            agent: new http.Agent({ keepAlive: false }),
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                contentType: res.headers['content-type'] || '',
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        r.on('error', reject);
        if (body != null) r.write(body);
        r.end();
    });
}

/** 真起服务跑完 fn，无论成败都关闭端口 */
async function withServer(fn) {
    const srv = new PushServer();
    const pushed = [];
    srv.on('push', (p) => pushed.push(p.url));
    const port = await srv.start();
    assert.ok(port > 0, 'push server 应监听到随机端口');
    try {
        await fn(srv, port, pushed);
    } finally {
        srv.stop();
    }
}

test('token 为 24 字节 base64url：32 位 URL 安全字符，且实例间互不相同', () => {
    const a = new PushServer();
    const b = new PushServer();
    assert.match(a.token, /^[A-Za-z0-9_-]{32}$/);
    assert.match(b.token, /^[A-Za-z0-9_-]{32}$/);
    // base64url 不含 + / =：token 直接进 query string 不需再转义
    assert.ok(!/[+/=]/.test(a.token), 'token 不应含 base64 标准字母表的 +/= ');
    assert.notEqual(a.token, b.token, '两个实例的 token 必须不同（非固定值）');
    assert.equal(a.info().token, a.token);
});

test('/push 鉴权：token 不匹配一律 401，且不触发推送', async () => {
    await withServer(async (srv, port, pushed) => {
        const bad = await request(port, '/push?url=https%3A%2F%2Fok.test%2Fa.m3u8&token=wrong');
        assert.equal(bad.status, 401);
        assert.equal(JSON.parse(bad.body).code, 401);
        const none = await request(port, '/push?url=https%3A%2F%2Fok.test%2Fa.m3u8');
        assert.equal(none.status, 401, '缺 token 与错 token 同等对待');
        assert.deepEqual(pushed, [], '鉴权失败不得 emit push');
    });
});

test('/push 协议白名单：非 http(s) 与空 url 返回 400，http(s) 才 200 并 emit', async () => {
    await withServer(async (srv, port, pushed) => {
        const t = encodeURIComponent(srv.token);
        for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'intent://x', '']) {
            const res = await request(port, `/push?url=${encodeURIComponent(raw)}&token=${t}`);
            assert.equal(res.status, 400, `${raw || '(空)'} 应被拒`);
            assert.equal(JSON.parse(res.body).code, 400);
        }
        assert.deepEqual(pushed, [], '被拒的 url 不得进入播放链路');

        const ok = await request(port, `/push?url=${encodeURIComponent('https://ok.test/a.m3u8')}&token=${t}`);
        assert.equal(ok.status, 200);
        assert.equal(JSON.parse(ok.body).code, 200);
        assert.deepEqual(pushed, ['https://ok.test/a.m3u8']);
    });
});

test('/push 支持 POST 表单，query 与 body 参数合并', async () => {
    await withServer(async (srv, port, pushed) => {
        const form = new URLSearchParams({ url: 'http://lan.test/b.mp4', token: srv.token }).toString();
        const res = await request(port, '/push', 'POST', form);
        assert.equal(res.status, 200);
        assert.deepEqual(pushed, ['http://lan.test/b.mp4']);

        // token 走 query、url 走 body：两侧参数应合并后再校验
        const merged = await request(port, `/push?token=${encodeURIComponent(srv.token)}`, 'POST',
            new URLSearchParams({ url: 'https://lan.test/c.m3u8' }).toString());
        assert.equal(merged.status, 200);
        assert.deepEqual(pushed, ['http://lan.test/b.mp4', 'https://lan.test/c.m3u8']);

        const bad = await request(port, '/push', 'POST',
            new URLSearchParams({ url: 'https://lan.test/d.m3u8', token: 'wrong' }).toString());
        assert.equal(bad.status, 401);
    });
});

test('说明页不回显完整 token（局域网内任意设备可访问 /）', async () => {
    await withServer(async (srv, port) => {
        const res = await request(port, '/');
        assert.equal(res.status, 200);
        assert.match(res.contentType, /text\/html/);
        assert.ok(!res.body.includes(srv.token), '首页 HTML 不得包含真实 token');
        assert.ok(res.body.includes(`:${port}/push?url=`), '首页应给出推送地址模板');

        const nf = await request(port, '/unknown');
        assert.equal(nf.status, 404);
    });
});
