'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { probeMedia, isLocalProxyStreamUrl } = require('../../src/main/media-probe');

let server;
let base;
let requests = 0;
const sockets = new Set();

before(async () => {
    server = http.createServer((req, res) => {
        requests += 1;
        if (req.url === '/direct.mp4') {
            res.writeHead(200, { 'Content-Type': 'video/mp4' });
            return res.end(req.method === 'HEAD' ? undefined : Buffer.from('media'));
        }
        if (req.url === '/hls.m3u8') {
            if (req.method === 'HEAD') { res.writeHead(405); return res.end(); }
            assert.equal(req.headers.range, 'bytes=0-1');
            res.writeHead(206, { 'Content-Type': 'application/octet-stream',
                'Content-Range': 'bytes 0-1/32' });
            return res.end('#EXTM3U\n#EXT-X-VERSION:3\n');
        }
        if (req.url === '/range-media') {
            if (req.method === 'HEAD') { res.writeHead(501); return res.end(); }
            assert.equal(req.headers.range, 'bytes=0-1');
            const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]);
            res.writeHead(206, { 'Content-Type': 'application/octet-stream',
                'Content-Range': `bytes 0-${mp4.length - 1}/${mp4.length}` });
            return res.end(mp4);
        }
        if (req.url === '/redirect') {
            res.writeHead(302, { Location: '/cookie.mp4', 'Set-Cookie': 'media_session=ok; Path=/' });
            return res.end();
        }
        if (req.url === '/cookie.mp4') {
            const ok = /media_session=ok/.test(req.headers.cookie || '')
                && req.headers.referer === 'https://site.test/'
                && req.headers.origin === 'https://site.test'
                && req.headers['user-agent'] === 'fixture-agent'
                && req.headers.authorization === 'Bearer fixture';
            res.writeHead(ok ? 200 : 403, { 'Content-Type': ok ? 'video/mp4' : 'text/html' });
            return res.end();
        }
        if (req.url === '/fake.mp4') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(req.method === 'HEAD' ? undefined : '<html>fake video</html>');
        }
        if (req.url === '/login.mp4') {
            if (req.method === 'HEAD') { res.writeHead(405); return res.end(); }
            res.writeHead(206, { 'Content-Type': 'application/octet-stream' });
            return res.end('<html><form><input type=password>登录</form></html>');
        }
        if (req.url === '/forbidden.mp4') {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            return res.end();
        }
        if (req.url === '/slow.mp4') return; // timeout/cancellation fixture
        res.writeHead(404); res.end();
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
});

test('直链矩阵：有效 Content-Type 只需 HEAD，不消费媒体主体', async () => {
    const result = await probeMedia(`${base}/direct.mp4`);
    assert.equal(result.ok, true);
    assert.equal(result.via, 'head');
});

test('HLS 与 Range 矩阵：HEAD 不支持时使用 bytes=0-1 并识别文本/魔数', async () => {
    const hls = await probeMedia(`${base}/hls.m3u8`);
    const range = await probeMedia(`${base}/range-media`);
    assert.equal(hls.ok, true);
    assert.equal(hls.via, 'range');
    assert.equal(range.ok, true);
    assert.equal(range.via, 'range');
    assert.equal(Object.keys(range.headers).some((key) => key.toLowerCase() === 'range'), false,
        '探测用 Range 不能泄漏给 mpv 后续请求');
});

test('Cookie/重定向矩阵：五类敏感请求头跨跳转保持且 Set-Cookie 合并', async () => {
    const result = await probeMedia(`${base}/redirect`, { headers: {
        Referer: 'https://site.test/', Origin: 'https://site.test',
        'User-Agent': 'fixture-agent', Authorization: 'Bearer fixture', Cookie: 'initial=1',
    } });
    assert.equal(result.ok, true);
    assert.equal(result.finalUrl, `${base}/cookie.mp4`);
    const cookieKey = Object.keys(result.headers).find((key) => key.toLowerCase() === 'cookie');
    assert.match(result.headers[cookieKey], /media_session=ok/);
});

test('假视频矩阵：HTML、登录页和 403 均不能交给 mpv', async () => {
    const html = await probeMedia(`${base}/fake.mp4`);
    const login = await probeMedia(`${base}/login.mp4`);
    const forbidden = await probeMedia(`${base}/forbidden.mp4`);
    assert.deepEqual([html.ok, login.ok, forbidden.ok], [false, false, false]);
    assert.equal(html.reason, 'html-response');
    assert.equal(login.reason, 'login-page');
    assert.equal(forbidden.reason, 'http-403');
});

test('过期 URL 矩阵：已过期签名在离线判定后不发网络请求', async () => {
    const beforeCount = requests;
    const result = await probeMedia(`${base}/direct.mp4?Expires=946684800`);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired-url');
    assert.equal(requests, beforeCount);
});

test('超时矩阵：挂起的 HEAD 有界退出', async () => {
    const result = await probeMedia(`${base}/slow.mp4`, { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'probe-timeout');
});

test('取消矩阵：外部 AbortSignal 立即终止探测', async () => {
    const controller = new AbortController();
    const pending = probeMedia(`${base}/slow.mp4`, { timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'probe-cancelled');
});

test('一次性 URL 可显式 skipProbe，避免重复消耗', async () => {
    const beforeCount = requests;
    const result = await probeMedia(`${base}/one-time`, { skipProbe: true });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(requests, beforeCount);
});

test('本机 go-proxy 取流地址矩阵：do=pan 与 ?url= 直链转发不做探测', () => {
    // 夸克 do=pan 的一次 HEAD 会触发后端整条解析链（token→detail→v2/play，
    // 必要时转存并轮询），远超 8s 探测预算；这条链路的上游校验与签名刷新
    // 由 go_proxy._stream_forward 负责，探测只会误杀。
    for (const url of [
        'http://127.0.0.1:9978/proxy?do=pan&site=quark&fileId=fid&quality=%E5%8E%9F%E7%94%BB',
        'http://localhost:9978/proxy?do=pan&site=quark&shareId=s&fileId=f',
        // go-proxy 按 query 分发、不看路径：非 /proxy 路径同样是取流地址。
        'http://127.0.0.1:1314/?url=https%3A%2F%2Fcdn.example%2Fv.mp4&proxytype=go',
        'http://127.0.0.1:7944/anything?url=https%3A%2F%2Fcdn.example%2Fv.mp4',
    ]) assert.equal(isLocalProxyStreamUrl(url), true, url);

    for (const url of [
        // 本机但不是取流地址（直播 do=live、配置/接口调用）仍要探测。
        'http://127.0.0.1:9978/proxy?do=live&ext=abc',
        'http://127.0.0.1:9978/proxy?do=push',
        'http://127.0.0.1:9978/proxy',
        // 远端地址不能因为带 do=pan / ?url= 就跳过探测。
        'https://cdn.example/proxy?do=pan&fileId=fid',
        'https://cdn.example/v.mp4?url=https%3A%2F%2Fx%2Fy.mp4',
        'file:///C:/local/v.mp4?do=pan',
        'not a url', '', null, undefined,
    ]) assert.equal(isLocalProxyStreamUrl(url), false, String(url));
});
