// 白盒单元测试：push-server.js —— 局域网 URL 推送接收服务
//
// 与 push-token.test.js 的分工：那边用真实 HTTP 客户端跑端到端（鉴权/协议白名单/首页），
// 这边走白盒：把 http.createServer 换成桩件，直接驱动 _handle / _json / _page 与
// start/stop 的内部分支（绑定失败、listen 回调异常、超大 body、非法请求行、
// 订阅者广播与异常隔离等真实请求难以稳定构造的分支）。全程不监听端口。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const { EventEmitter } = require('node:events');

// ---- 依赖注入：必须在 require('../../src/main/push-server') 之前替换 ----
// push-server.js 在模块顶层 `const http = require('http')` / `const os = require('os')`，
// 二者与 node:http / node:os 是同一模块对象，故此处打桩对被测模块生效（本文件独立进程运行）。
const realCreateServer = http.createServer;
const realNetworkInterfaces = os.networkInterfaces;

/** 服务桩行为开关（每个用例自行设置） */
let behavior = { kind: 'ok', port: 41234, closeThrows: false, address: null };
/** 每次 createServer 产出的桩件 */
let createdServers = [];

function makeFakeServer(handler) {
    const srv = {
        handler,
        listening: false,
        closeCalls: 0,
        listenArgs: null,
        listenCb: null,
        errorHandlers: [],
        address() { return behavior.address; },
        listen(port, host, cb) {
            this.listenArgs = [port, host];
            this.listenCb = cb;
            if (behavior.kind === 'ok') {
                this.listening = true;
                if (cb) setImmediate(() => cb());
            } else if (behavior.kind === 'error') {
                // 真实 http 的 error 是异步 emit 的（同步 emit 会先于 on('error') 注册）
                setImmediate(() => { for (const fn of this.errorHandlers) fn(new Error('EADDRINUSE')); });
            } // kind === 'manual' | 'hang'：不回调，由用例自行驱动
        },
        on(ev, fn) { if (ev === 'error') this.errorHandlers.push(fn); },
        close() {
            this.closeCalls++;
            this.listening = false;
            if (behavior.closeThrows) throw new Error('close boom');
        },
    };
    createdServers.push(srv);
    return srv;
}

http.createServer = (handler) => makeFakeServer(handler);
os.networkInterfaces = () => behavior.interfaces || realNetworkInterfaces.call(os);

const PushServer = require('../../src/main/push-server');

/** 每个用例前重置桩状态，避免用例间互相污染 */
function reset(opts) {
    behavior = Object.assign(
        { kind: 'ok', port: 41234, closeThrows: false, address: null, interfaces: null },
        opts || {},
    );
    // 显式传 address:null 表示「address() 返回 null」；其余情况按 port 造地址
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'address') && opts.address === null) {
        behavior.address = null;
    } else if (!behavior.address) {
        behavior.address = { port: behavior.port, address: '0.0.0.0' };
    }
    createdServers = [];
}
reset();

/** 响应桩：记录 writeHead/end 调用次数与内容（可断言「不重复响应」） */
function makeRes() {
    return {
        statusCode: 0,
        headers: null,
        body: '',
        writeHeadCalls: 0,
        endCalls: 0,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.writeHeadCalls++; return this; },
        end(b) { this.body = b == null ? '' : String(b); this.endCalls++; return this; },
        json() { return JSON.parse(this.body || '{}'); },
    };
}

/** 请求桩（GET）：只提供 _handle 用到的 method / url / destroy */
function makeGet(url) {
    const req = new EventEmitter();
    req.method = 'GET';
    req.url = url;
    req.destroyCalls = 0;
    req.destroy = () => { req.destroyCalls++; };
    return req;
}

/** 请求桩（POST）：_handle 同步注册 data/end，之后由用例 push 分片再 emit('end') */
function makePost(url) {
    const req = makeGet(url);
    req.method = 'POST';
    return req;
}

/** 建实例并登记 push 收集器 */
function newServer() {
    const srv = new PushServer();
    const pushed = [];
    srv.on('push', (p) => pushed.push(p && p.url));
    srv.pushed = pushed;
    return srv;
}

// ---------------------------------------------------------------- 构造 / 静态

test('构造：token 为 24 字节 base64url、实例唯一，且 error 事件已挂兜底监听', () => {
    reset();
    const a = new PushServer();
    const b = new PushServer();
    assert.match(a.token, /^[A-Za-z0-9_-]{32}$/, '24 字节 → 32 个 base64url 字符');
    assert.notEqual(a.token, b.token, '两个实例 token 必须不同');
    assert.equal(a.listenerCount('error'), 1, '构造函数必须挂 no-op error 监听，避免未处理 error 崩进程');
    assert.doesNotThrow(() => a.emit('error', new Error('boom')), 'error 事件被兜底吞掉');
    assert.equal(a.server, null);
    assert.equal(a.port, 0);
});

test('lanIp：无可用网卡时兜底 127.0.0.1；只取非 internal 的 IPv4', () => {
    reset({ interfaces: {} });
    assert.equal(PushServer.lanIp(), '127.0.0.1', '空网卡表必须兜底回环地址');
    reset({
        interfaces: {
            lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
            v6: [{ family: 'IPv6', internal: false, address: '2001:db8::1' }],
            eth0: [{ family: 'IPv4', internal: true, address: '10.0.0.9' },
                { family: 'IPv4', internal: false, address: '192.168.1.7' }],
        },
    });
    assert.equal(PushServer.lanIp(), '192.168.1.7', 'IPv6 与 internal 地址都要跳过');
});

test('info：返回 port/token/ip，且 ip 随 lanIp 走', () => {
    reset({ interfaces: { eth0: [{ family: 'IPv4', internal: false, address: '10.1.2.3' }] } });
    const srv = newServer();
    srv.port = 45678;
    const info = srv.info();
    assert.deepEqual(Object.keys(info).sort(), ['ip', 'port', 'token']);
    assert.equal(info.port, 45678);
    assert.equal(info.token, srv.token);
    assert.equal(info.ip, '10.1.2.3');
});

// ---------------------------------------------------------------- start / stop

test('start 幂等：二次调用复用同一 server 与端口，不重复 createServer', async () => {
    reset();
    const srv = newServer();
    const p1 = await srv.start();
    const p2 = await srv.start();
    assert.equal(p1, 41234);
    assert.equal(p2, 41234, '已启动时直接返回同一端口');
    assert.equal(createdServers.length, 1, 'createServer 只能调用一次');
    assert.equal(srv.port, 41234);
    srv.stop();
});

test('start：listen 使用端口 0（系统分配）+ 0.0.0.0（局域网可达）', async () => {
    reset();
    const srv = newServer();
    await srv.start();
    assert.deepEqual(createdServers[0].listenArgs, [0, '0.0.0.0']);
    srv.stop();
});

test('start：端口绑定失败（error 事件）resolve 0 且不向上抛出', async () => {
    reset({ kind: 'error' });
    const srv = newServer();
    const port = await srv.start();
    assert.equal(port, 0, '绑定失败必须 resolve(0) 而不是 reject');
    assert.equal(srv.port, 0);
});

test('start：绑定失败后 server 残留 → 二次 start 直接返回 0，无法自愈重试', async () => {
    reset({ kind: 'error' });
    const srv = newServer();
    assert.equal(await srv.start(), 0);
    assert.ok(srv.server, '失败路径未清 server：start 的 this.server 判空短路会一直命中');
    assert.equal(await srv.start(), 0, '第二次 start 因 server 非空而短路，仍返回 0');
    assert.equal(createdServers.length, 1, '没有重新建 server，即没有重试');
    srv.stop(); // 兜底清理：stop 会把残留 server 关掉并置空
});

test('start：listen 回调内 address() 为 null 时抛 TypeError，端口保持 0', () => {
    reset({ kind: 'manual', address: null });
    const srv = newServer();
    const pending = srv.start(); // 永不 resolve（桩不回调）
    assert.ok(pending instanceof Promise);
    const cb = createdServers[0].listenCb;
    assert.equal(typeof cb, 'function', '应已注册 listen 回调');
    assert.throws(() => cb(), TypeError, 'server.address() 返回 null 时取值 .port 会抛');
    assert.equal(srv.port, 0);
    srv.stop();
});

test('start：listen 永不回调时 start 不 resolve（端口被占/挂起场景）', async () => {
    reset({ kind: 'hang' });
    const srv = newServer();
    let resolved = false;
    srv.start().then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(resolved, false, '无 listen 回调不应 resolve');
    srv.stop();
});

test('stop：关闭 server 并置空；重复调用不重复 close（幂等）', async () => {
    reset();
    const srv = newServer();
    await srv.start();
    srv.stop();
    assert.equal(createdServers[0].closeCalls, 1);
    assert.equal(srv.server, null);
    srv.stop();
    srv.stop();
    assert.equal(createdServers[0].closeCalls, 1, 'server 置空后再 stop 必须无操作');
});

test('stop：close 抛异常被吞掉，server 仍被置空', async () => {
    reset({ closeThrows: true });
    const srv = newServer();
    await srv.start();
    assert.doesNotThrow(() => srv.stop(), 'close 异常不得冒泡到调用方');
    assert.equal(srv.server, null, '即便 close 抛错也要复位状态');
});

test('stop 后再 start：创建新 server 实例（端口重新协商）', async () => {
    reset();
    const srv = newServer();
    await srv.start();
    const first = createdServers[0];
    srv.stop();
    behavior.port = 49999;
    behavior.address = { port: 49999 };
    const port = await srv.start();
    assert.equal(port, 49999);
    assert.equal(createdServers.length, 2);
    assert.notEqual(createdServers[1], first, '必须新建 server');
    assert.equal(first.closeCalls, 1, '旧 server 已关闭');
    srv.stop();
});

test('stop：只释放 server，不移除 push 订阅者（广播能力保留）', async () => {
    reset();
    const srv = newServer();
    await srv.start();
    srv.stop();
    assert.equal(srv.server, null);
    assert.equal(srv.listenerCount('push'), 1, 'stop 不应解绑业务订阅者');
    srv.emit('push', { url: 'https://x.test/a' });
    assert.deepEqual(srv.pushed, ['https://x.test/a'], '停止后实例本身仍可本地 emit（不对外监听）');
});

// ---------------------------------------------------------------- _handle 鉴权 / 协议

test('/push 鉴权：token 缺失/错误 → 401 且不广播；正确 → 200 且广播一次', () => {
    reset();
    const srv = newServer();
    const good = `https://a.test/x.m3u8`;

    const noToken = makeRes();
    srv._handle(makeGet(`/push?url=${encodeURIComponent(good)}`), noToken);
    assert.equal(noToken.statusCode, 401);
    assert.equal(noToken.json().code, 401);

    const badToken = makeRes();
    srv._handle(makeGet(`/push?url=${encodeURIComponent(good)}&token=wrong`), badToken);
    assert.equal(badToken.statusCode, 401);

    const emptyToken = makeRes();
    srv._handle(makeGet(`/push?url=${encodeURIComponent(good)}&token=`), emptyToken);
    assert.equal(emptyToken.statusCode, 401, '空 token 等同缺失');

    assert.deepEqual(srv.pushed, [], '鉴权失败不得 emit push');

    const ok = makeRes();
    srv._handle(makeGet(`/push?url=${encodeURIComponent(good)}&token=${encodeURIComponent(srv.token)}`), ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().code, 200);
    assert.deepEqual(srv.pushed, [good], '正确 token 广播一次');
});

test('/push 协议白名单：非 http(s)/空/纯空白 → 400；http(s) 通过且首尾空白被 trim', () => {
    reset();
    const srv = newServer();
    const t = encodeURIComponent(srv.token);
    for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://a.test/x', '', '   ']) {
        const res = makeRes();
        srv._handle(makeGet(`/push?url=${encodeURIComponent(raw)}&token=${t}`), res);
        assert.equal(res.statusCode, 400, `${JSON.stringify(raw)} 必须拒绝`);
        assert.equal(res.json().code, 400);
    }
    assert.deepEqual(srv.pushed, [], '被拒的 url 不得进入播放链路');

    const res = makeRes();
    srv._handle(makeGet(`/push?url=${encodeURIComponent('  HTTPS://A.test/x.m3u8  ')}&token=${t}`), res);
    assert.equal(res.statusCode, 200, '协议判定大小写不敏感');
    assert.deepEqual(srv.pushed, ['HTTPS://A.test/x.m3u8'], 'url 需 trim 后原样广播');
});

test('/push 支持 POST 表单：query 与 body 合并，同名键 body 覆盖 query', () => {
    reset();
    const srv = newServer();

    const r1 = makeRes();
    const req1 = makePost('/push');
    srv._handle(req1, r1);
    req1.emit('data', Buffer.from(`url=${encodeURIComponent('https://a.test/1')}&token=${encodeURIComponent(srv.token)}`));
    req1.emit('end');
    assert.equal(r1.statusCode, 200);

    // token 走 query、url 走 body：两侧参数合并后再校验
    const r2 = makeRes();
    const req2 = makePost(`/push?token=${encodeURIComponent(srv.token)}`);
    srv._handle(req2, r2);
    req2.emit('data', Buffer.from(`url=${encodeURIComponent('http://a.test/2')}`));
    req2.emit('end');
    assert.equal(r2.statusCode, 200);

    // body 覆盖 query：query 里是真 token，body 里是错 token → 以 body 为准 → 401
    const r3 = makeRes();
    const req3 = makePost(`/push?token=${encodeURIComponent(srv.token)}`);
    srv._handle(req3, r3);
    req3.emit('data', Buffer.from('url=https%3A%2F%2Fa.test%2F3&token=wrong'));
    req3.emit('end');
    assert.equal(r3.statusCode, 401, 'merged.set 语义：body 参数覆盖 query 同名键');

    assert.deepEqual(srv.pushed, ['https://a.test/1', 'http://a.test/2']);
});

test('POST 超大 body（>64KB）：回 413 并 destroy 请求，后续 end 不二次响应也不广播', () => {
    reset();
    const srv = newServer();
    const res = makeRes();
    const req = makePost(`/push?token=${encodeURIComponent(srv.token)}`);
    srv._handle(req, res);
    req.emit('data', Buffer.from(`url=https%3A%2F%2Fa.test%2Fok&pad=${'a'.repeat(70000)}`));
    assert.equal(res.statusCode, 413, '超过 64KB 立即回 413');
    assert.equal(res.json().code, 413);
    assert.equal(req.destroyCalls, 1, '必须 destroy 请求流');
    assert.equal(res.writeHeadCalls, 1);

    // destroy 后真实请求不会再触发 end；即便触发也不能二次响应/广播
    req.emit('end');
    assert.equal(res.endCalls, 1, 'end 到场也不得再写一次响应');
    assert.deepEqual(srv.pushed, [], '超大 body 不得进入播放链路');
});

test('POST 分片累加后超限：第二片越界才触发 413（分片边界）', () => {
    reset();
    const srv = newServer();
    const res = makeRes();
    const req = makePost('/push');
    srv._handle(req, res);
    req.emit('data', Buffer.alloc(60000, 'b')); // 未越界
    assert.equal(res.statusCode, 0, '未越界前不应响应');
    req.emit('data', Buffer.alloc(10000, 'c')); // 累计 70000 > 65536
    assert.equal(res.statusCode, 413);
    req.emit('data', Buffer.alloc(100, 'd')); // 已 overflow：后续分片应被忽略
    assert.equal(res.writeHeadCalls, 1, 'overflow 后必须短路，不再重复响应');
});

test('非法请求行（new URL 解析失败）：_handle 抛出且不产生任何响应', () => {
    reset();
    const srv = newServer();
    const res = makeRes();
    // 形如 "GET http://[ HTTP/1.1" 的畸形 target 会让 new URL 抛 ERR_INVALID_URL。
    // 实测在真实 http.Server 下该异常无处兜底（无 server 'error' 监听、不在请求
    // 回调的同步 try 内）→ 主进程崩溃；这里用桩响应锚定「无响应写出」的表现。
    assert.throws(() => srv._handle(makeGet('http://['), res), TypeError);
    assert.equal(res.writeHeadCalls, 0, '解析失败时没有响应写出（真实场景表现为连接挂起）');
    assert.deepEqual(srv.pushed, []);
});

test('req.url 缺失也不崩：退化为 /undefined 走 404 分支', () => {
    reset();
    const srv = newServer();
    const res = makeRes();
    srv._handle(makeGet(undefined), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 404);
});

test('路由：/ 返回说明页（200 html 且不含 token），未知路径 404', () => {
    reset();
    const srv = newServer();
    srv.port = 41234;
    const home = makeRes();
    srv._handle(makeGet('/'), home);
    assert.equal(home.statusCode, 200);
    assert.match(home.headers['Content-Type'], /text\/html/);
    assert.ok(!home.body.includes(srv.token), '首页不得回显 token');
    assert.ok(home.body.includes(':41234/push?url='), '首页应给出推送地址模板');

    const nf = makeRes();
    srv._handle(makeGet('/nope'), nf);
    assert.equal(nf.statusCode, 404);
    assert.match(nf.headers['Content-Type'], /application\/json/);
});

test('_json / _page：响应头与内容类型由内部方法统一写入', () => {
    reset();
    const srv = newServer();
    const r1 = makeRes();
    srv._json(r1, 418, { code: 418, msg: 'teapot' });
    assert.equal(r1.statusCode, 418);
    assert.equal(r1.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(r1.json(), { code: 418, msg: 'teapot' });

    const r2 = makeRes();
    srv._page(r2);
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.match(r2.body, /^<!DOCTYPE html>/);
});

// ---------------------------------------------------------------- 广播 / 订阅者管理

test('广播：多个订阅者按注册顺序全部收到同一条推送（payload 为 {url}）', () => {
    reset();
    const srv = newServer();
    const seen = [];
    const a = (p) => seen.push(`a:${p.url}`);
    const b = (p) => seen.push(`b:${p.url}`);
    srv.on('push', a);
    srv.on('push', b);
    srv.emit('push', { url: 'https://a.test/1' });
    assert.deepEqual(seen, ['a:https://a.test/1', 'b:https://a.test/1']);
    assert.deepEqual(srv.pushed, ['https://a.test/1']);
});

test('订阅者管理：removeListener 退订后不再收到；once 只触发一次', () => {
    reset();
    const srv = newServer();
    let hits = 0;
    const h = () => { hits++; };
    srv.on('push', h);
    srv.emit('push', { url: 'https://a.test/1' });
    assert.equal(hits, 1);
    srv.removeListener('push', h);
    srv.emit('push', { url: 'https://a.test/2' });
    assert.equal(hits, 1, '退订后不再收到');

    let onceHits = 0;
    srv.once('push', () => { onceHits++; });
    srv.emit('push', { url: 'https://a.test/3' });
    srv.emit('push', { url: 'https://a.test/4' });
    assert.equal(onceHits, 1, 'once 订阅者只收一次');
});

test('异常订阅者：抛错会中断后续订阅者，且异常冒泡到 _handle 调用方', () => {
    reset();
    const srv = newServer();
    const later = [];
    srv.removeAllListeners('push');
    srv.on('push', () => { throw new Error('subscriber boom'); });
    srv.on('push', (p) => later.push(p.url));

    const res = makeRes();
    // EventEmitter.emit 同步调用监听者：第一个抛错后第二个不会执行，异常直接冒泡
    assert.throws(
        () => srv._handle(makeGet(`/push?url=https%3A%2F%2Fa.test%2Fx&token=${encodeURIComponent(srv.token)}`), res),
        /subscriber boom/,
        '订阅者异常会穿透 _handle',
    );
    assert.deepEqual(later, [], '抛错的订阅者之后的订阅者收不到推送');
    assert.equal(res.writeHeadCalls, 0, '异常发生在 emit 之后：客户端拿不到 200，连接会挂到超时');
});

test('异常订阅者若自行 try/catch，则不影响后续订阅者与响应', () => {
    reset();
    const srv = newServer();
    const later = [];
    srv.on('push', () => { try { throw new Error('self handled'); } catch (e) { /* 业务侧自行兜底 */ } });
    srv.on('push', (p) => later.push(p.url));
    const res = makeRes();
    srv._handle(makeGet(`/push?url=https%3A%2F%2Fa.test%2Fy&token=${encodeURIComponent(srv.token)}`), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(later, ['https://a.test/y'], '自兜底的订阅者不吃掉后续广播');
});

// ---------------------------------------------------------------- 真实 loopback 冒烟（端口 0，用完即关）

test('冒烟：127.0.0.1 端口 0 真起一次服务，GET/POST 全链路可用后立刻关闭', async () => {
    reset();
    const srv = newServer();
    const real = realCreateServer.call(http, (req, res) => srv._handle(req, res));
    const port = await new Promise((resolve, reject) => {
        real.on('error', reject);
        real.listen(0, '127.0.0.1', () => resolve(real.address().port));
    });
    try {
        const call = (path, method, body) => new Promise((resolve, reject) => {
            const headers = body == null ? {} : {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            };
            const r = http.request({ host: '127.0.0.1', port, path, method: method || 'GET', headers,
                agent: new http.Agent({ keepAlive: false }) }, (res2) => {
                const chunks = [];
                res2.on('data', (c) => chunks.push(c));
                res2.on('end', () => resolve({ status: res2.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            });
            r.on('error', reject);
            if (body != null) r.write(body);
            r.end();
        });

        const bad = await call(`/push?url=${encodeURIComponent('https://a.test/x')}&token=wrong`);
        assert.equal(bad.status, 401);
        const ok = await call(`/push?url=${encodeURIComponent('https://a.test/x')}&token=${encodeURIComponent(srv.token)}`);
        assert.equal(ok.status, 200);
        assert.deepEqual(srv.pushed, ['https://a.test/x']);
        const posted = await call('/push', 'POST',
            new URLSearchParams({ url: 'http://a.test/z', token: srv.token }).toString());
        assert.equal(posted.status, 200);
        assert.deepEqual(srv.pushed, ['https://a.test/x', 'http://a.test/z']);
    } finally {
        await new Promise((resolve) => real.close(resolve)); // 立即关闭，不驻留端口
    }
});
