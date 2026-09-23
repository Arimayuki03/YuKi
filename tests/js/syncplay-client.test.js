// 白盒测试：syncplay-client.js（SyncPlay 协议客户端）
// 依赖 net/tls（真实 socket 会出网），故用 vm 载入源码并注入可控假 socket + 假定时器，
// 全程不产生任何真实网络连接。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { EventEmitter } = require('events');

const SRC = path.join(__dirname, '../../src/main/syncplay-client.js');

/** 跨 realm 归一：vm 里创建的对象原型不同于本 realm，deepStrictEqual 会因原型不同失败。 */
const plain = (o) => JSON.parse(JSON.stringify(o));

/** 假 socket：EventEmitter + 记录写入/end/destroy/removeAllListeners，连接由测试手动触发。 */
function makeStubSocket(sockets, opts, onConnect, kind) {
    const sock = new EventEmitter();
    sock.kind = kind;            // 'tcp' | 'tls'
    sock.connectOpts = opts;     // connect 传入的 { host, port, rejectUnauthorized }
    sock.written = [];           // 出站原始帧（含 \r\n）
    sock.ended = 0;
    sock.destroyed = 0;
    sock.removeAllCalls = 0;
    sock.encoding = null;
    sock.throwOnWrite = false;   // 置 true 模拟 socket.write 抛 EPIPE
    sock.setEncoding = (enc) => { sock.encoding = enc; };
    sock.write = (s) => {
        if (sock.throwOnWrite) throw new Error('EPIPE: socket closed');
        sock.written.push(s);
        return true;
    };
    sock.end = () => { sock.ended++; };
    sock.destroy = () => { sock.destroyed++; };
    const rawRemoveAll = sock.removeAllListeners.bind(sock);
    sock.removeAllListeners = (...a) => { sock.removeAllCalls++; return rawRemoveAll(...a); };
    /** 手动触发 connect 回调（模拟 TCP/TLS 握手完成）。 */
    sock.fireConnect = () => onConnect();
    /** 出站帧解析为对象数组，便于断言序列化结果。 */
    sock.frames = () => sock.written.map((s) => JSON.parse(s.replace(/\r\n$/, '')));
    sockets.push(sock);
    return sock;
}

/**
 * 在 VM 中加载 syncplay-client.js，注入 net/tls 桩与假定时器。
 * 返回类、socket 记录、定时器状态与 tick 工具。
 */
function loadClient() {
    const source = fs.readFileSync(SRC, 'utf8');
    const sockets = [];
    // 假定时器：可手动 tick，统计在途 interval 峰值（用于验证不会并行跑多个 ping 循环）
    const timerState = { live: 0, peak: 0, intervals: new Map(), nextId: 1 };
    const fakeSetInterval = (fn, ms) => {
        const id = timerState.nextId++;
        timerState.intervals.set(id, { fn, ms });
        timerState.live++;
        if (timerState.live > timerState.peak) timerState.peak = timerState.live;
        return id;
    };
    const fakeClearInterval = (id) => {
        if (timerState.intervals.delete(id)) timerState.live--;
    };
    const tick = () => { for (const t of [...timerState.intervals.values()]) t.fn(); };
    const create = (opts, cb, kind) => makeStubSocket(sockets, opts, cb, kind);

    const sandbox = {
        console,
        module: { exports: {} },
        setInterval: fakeSetInterval,
        clearInterval: fakeClearInterval,
        setTimeout,
        clearTimeout,
        setImmediate,
        require: (name) => {
            if (name === 'net') return { connect: (o, cb) => create(o, cb, 'tcp') };
            if (name === 'tls') return { connect: (o, cb) => create(o, cb, 'tls') };
            return require(name);
        },
    };
    vm.runInNewContext(source, sandbox, { filename: 'syncplay-client.js' });
    return { SyncplayClient: sandbox.module.exports, sockets, timerState, tick };
}

/** 让 connect 内的同步逻辑（建 socket、挂监听）先落定。 */
const flush = () => new Promise((r) => setImmediate(r));

/** 新客户端 + 各类事件收集器。 */
function makeClient() {
    const env = loadClient();
    const client = new env.SyncplayClient();
    // 收集器统一归一：vm realm 内的对象原型与本 realm 不同，deepStrictEqual 会误判
    const seen = { hello: [], state: [], users: [], file: [], ready: [], chat: [], error: [], disconnect: 0 };
    client.on('hello', (v) => seen.hello.push(plain(v)));
    client.on('state', (v) => seen.state.push(plain(v)));
    client.on('users', (v) => seen.users.push(plain(v)));
    client.on('file', (v) => seen.file.push(plain(v)));
    client.on('ready', (v) => seen.ready.push(plain(v)));
    client.on('chat', (v) => seen.chat.push(plain(v)));
    client.on('error', (e) => seen.error.push(e));
    client.on('disconnect', () => { seen.disconnect++; });
    return { ...env, client, seen };
}

// ---------------------------------------------------------------- 构造与初始状态

test('构造函数：初始状态归零，并预置 error 兜底监听（无监听时 emit error 不崩）', () => {
    const { SyncplayClient, client } = makeClient();
    assert.equal(typeof SyncplayClient, 'function', 'module.exports 应为类');
    assert.equal(client.socket, null);
    assert.equal(client.connected, false);
    assert.equal(client.room, '');
    assert.equal(client.username, '');
    assert.equal(client._recvBuf, '', '接收缓冲应为空串');
    assert.equal(client._pingTimer, null);
    assert.equal(client._connectGen, 0);
    assert.equal(client._connectReject, null);
    // 兜底监听存在：未加业务监听时 emit('error') 不会抛 ERR_UNHANDLED_ERROR
    assert.ok(client.listenerCount('error') >= 1);
    assert.doesNotThrow(() => client.emit('error', new Error('boom')));
});

// ---------------------------------------------------------------- connect 与状态机

test('connect：TLS 默认严格校验证书（rejectUnauthorized:true）且透传 host/port', async () => {
    const { client, sockets } = makeClient();
    const p = client.connect('sync.example', 8997, 'u1', 'room-a');
    await flush();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].kind, 'tls', '默认应走 tls.connect');
    assert.deepStrictEqual(plain(sockets[0].connectOpts), { host: 'sync.example', port: 8997, rejectUnauthorized: true });
    assert.equal(sockets[0].encoding, 'utf8', 'socket 应设为 utf8 编码（按行解码）');
    assert.equal(client.username, 'u1');
    assert.equal(client.room, 'room-a');
    assert.deepStrictEqual(plain(client.usernameList), {});
    // 收口 promise，避免悬挂影响后续用例
    sockets[0].fireConnect();
    await p;
});

test('connect：insecureTls 显式开启时才跳过证书校验（自签服务器兼容开关）', async () => {
    const { client, sockets } = makeClient();
    const p = client.connect('selfsigned.local', 9000, 'u', 'r', true, { insecureTls: true });
    await flush();
    assert.equal(sockets[0].connectOpts.rejectUnauthorized, false);
    sockets[0].fireConnect();
    await p;
});

test('connect：useTls=false 走 net.connect，且空 server/port 回落默认值', async () => {
    const { client, sockets } = makeClient();
    const p = client.connect('', 0, 'u', 'r', false);
    await flush();
    assert.equal(sockets[0].kind, 'tcp', 'useTls=false 应走 net.connect');
    assert.deepStrictEqual(plain(sockets[0].connectOpts), { host: 'syncplay.pl', port: 8996 });
    sockets[0].fireConnect();
    await p;
});

test('connect：握手成功 → connected=true、发 Hello 帧、启动 ping 定时器、promise resolve', async () => {
    const { client, sockets, timerState } = makeClient();
    const p = client.connect('h', 1, 'alice', 'room-1', false);
    await flush();
    const sock = sockets[0];
    assert.equal(client.connected, false, '握手回调前不应置 connected');
    sock.fireConnect();
    await p;
    assert.equal(client.connected, true);
    assert.equal(client._connectReject, null, 'resolve 后应清掉在途 reject 句柄');
    assert.equal(sock.written.length, 1);
    const hello = sock.frames()[0];
    assert.equal(hello.Hello.username, 'alice');
    assert.equal(hello.Hello.room.name, 'room-1');
    assert.equal(hello.Hello.version, '1.7.0');
    assert.deepStrictEqual(plain(hello.Hello.features), {
        sharedPlaylists: true, chat: true, featureList: true, readiness: true, managedRooms: false,
    });
    assert.ok(sock.written[0].endsWith('\r\n'), '帧必须以 \\r\\n 结尾');
    assert.equal(timerState.live, 1, '握手后应启动 ping 定时器');
    assert.equal([...timerState.intervals.values()][0].ms, 5000, '心跳间隔应为 5s');
});

test('connect：握手完成前 socket close → reject 不悬挂、清理句柄并 emit disconnect', async () => {
    const { client, sockets, seen } = makeClient();
    const genBefore = client._connectGen;
    const p = client.connect('h', 1, 'u', 'r', false);
    await flush();
    const sock = sockets[0];
    sock.emit('close');
    await assert.rejects(p, /连接在完成握手前已关闭/);
    assert.equal(client.connected, false);
    assert.equal(client.socket, null, 'close 后应释放 socket 句柄');
    assert.equal(client._pingTimer, null);
    assert.equal(client._connectGen, genBefore + 2, 'connect 递增一次 + close 收口再递增一次');
    assert.equal(seen.disconnect, 1, '握手前关闭应通知上层断连');
});

test('connect：已连接后 socket close → 清定时器/句柄并 emit disconnect，已 resolve 的 promise 不再 reject', async () => {
    const { client, sockets, seen, timerState } = makeClient();
    const p = client.connect('h', 1, 'u', 'r', false);
    await flush();
    const sock = sockets[0];
    sock.fireConnect();
    await p;
    assert.equal(timerState.live, 1);
    sock.emit('close');
    assert.equal(client.connected, false);
    assert.equal(client.socket, null);
    assert.equal(timerState.live, 0, 'close 必须回收 ping 定时器，否则进程被定时器吊住');
    assert.equal(seen.disconnect, 1);
    await p; // 已 resolve，二次 settle 无副作用
    assert.equal(seen.disconnect, 1);
});

test('connect：socket error → emit error 与 reject 同一错误对象，connected 保持 false', async () => {
    const { client, sockets, seen } = makeClient();
    const p = client.connect('h', 1, 'u', 'r', false);
    await flush();
    const err = new Error('ECONNREFUSED');
    sockets[0].emit('error', err);
    await assert.rejects(p, (e) => e === err);
    assert.strictEqual(seen.error[0], err, '应是同一个错误实例，便于上层透传 message');
    assert.equal(client.connected, false);
});

test('connect：重连时 teardown 旧 socket（摘监听+end+destroy）并收口在途 promise', async () => {
    const { client, sockets } = makeClient();
    const p1 = client.connect('h1', 1, 'u1', 'r1', false);
    await flush();
    const s1 = sockets[0];
    const p2 = client.connect('h2', 2, 'u2', 'r2', false);
    await assert.rejects(p1, /连接被 disconnect\/重连接管/, '旧 promise 必须由 teardown 收口，不能永久悬挂');
    await flush();
    assert.equal(s1.removeAllCalls, 1, '旧 socket 的 data/close/error 监听必须摘除');
    assert.equal(s1.ended, 1);
    assert.equal(s1.destroyed, 1);
    assert.equal(client.socket, sockets[1], 'this.socket 应指向新 socket');
    assert.equal(client.connected, false, 'teardown 后连接态复位');
    assert.equal(client._recvBuf, '', '重连应清空残留半包，避免脏数据拼到新连接');

    // 代际守卫：旧 socket 迟到的 connect 回调不得再落 handle（否则会重复发 Hello）
    s1.fireConnect();
    assert.equal(client.connected, false, 'stale onConnect 必须被代际守卫拦下');
    assert.equal(s1.written.length, 0, 'stale socket 不应再写 Hello');

    sockets[1].fireConnect();
    await p2;
});

test('代际守卫：重连后旧 socket 的 data/close/error 不再影响新连接状态', async () => {
    const { client, sockets, seen } = makeClient();
    const p1 = client.connect('h1', 1, 'u1', 'r1', false);
    await flush();
    const s1 = sockets[0];
    const p2 = client.connect('h2', 2, 'u2', 'r2', false);
    await p1.catch(() => {});
    await flush();
    const s2 = sockets[1];
    s2.fireConnect();
    await p2;

    // 旧 socket 迟到事件：代际已变，全部应被丢弃
    s1.emit('data', '{"Chat":{"username":"ghost","message":"旧连接"}}\r\n');
    s1.emit('close');
    s1.emit('error', new Error('stale error'));
    assert.equal(seen.chat.length, 0, '旧连接数据不应污染新连接');
    assert.equal(seen.disconnect, 0, 'teardown 是静默清理，不应多发 disconnect');
    assert.equal(seen.error.length, 0);
    assert.equal(client.connected, true, '旧 socket 事件不得把新连接置为断开');

    // 新 socket 数据正常生效
    s2.emit('data', '{"Chat":{"username":"bob","message":"新连接"}}\r\n');
    assert.deepStrictEqual(seen.chat[0], { username: 'bob', message: '新连接' });
});

test('disconnect：静默清理 socket 与定时器，emit disconnect，在途 connect promise 被 reject', async () => {
    const { client, sockets, seen, timerState } = makeClient();
    const p = client.connect('h', 1, 'u', 'r', false);
    await flush();
    const sock = sockets[0];
    sock.fireConnect();
    await p;
    assert.equal(timerState.live, 1);

    const p2 = client.connect('h', 1, 'u', 'r', false); // 制造一个在途连接
    await flush();
    client.disconnect();
    await assert.rejects(p2, /连接被 disconnect\/重连接管/);
    assert.equal(client.socket, null);
    assert.equal(timerState.live, 0, 'ping 定时器必须回收');
    assert.equal(seen.disconnect, 1);
    assert.equal(client._recvBuf, '');
});

test('disconnect 幂等：重复调用不抛错、不残留定时器、socket 保持 null', () => {
    const { client, sockets, seen, timerState } = makeClient();
    client.socket = sockets[0] || null;
    assert.doesNotThrow(() => { client.disconnect(); client.disconnect(); client.disconnect(); });
    assert.equal(client.socket, null);
    assert.equal(timerState.live, 0, '多次 disconnect 不应留下孤儿 interval');
    assert.equal(seen.disconnect, 3, 'disconnect 每次都通知上层（幂等指资源而非事件）');
    // 无 socket 时 teardown 也安全
    assert.doesNotThrow(() => client._teardownSocket());
    assert.equal(client._pingTimer, null);
});

test('_teardownSocket：销毁后给旧 socket 补空 error/close 监听，迟到 ECONNRESET 不打崩进程', async () => {
    const { client, sockets } = makeClient();
    const p = client.connect('h', 1, 'u', 'r', false);
    await flush();
    const s1 = sockets[0];
    client.disconnect();
    await p.catch(() => {});
    // removeAllListeners 之后必须补监听，否则 destroy 后的 error 会以 ERR_UNHANDLED_ERROR 抛出
    assert.equal(s1.listenerCount('error'), 1);
    assert.equal(s1.listenerCount('close'), 1);
    assert.doesNotThrow(() => s1.emit('error', new Error('ECONNRESET')));
    assert.doesNotThrow(() => s1.emit('close'));
});

// ---------------------------------------------------------------- 出站序列化

test('_send：对象序列化为 JSON 行 + \\r\\n；无 socket 或未连接时不写', () => {
    const { client, sockets } = makeClient();
    // 未连接：静默丢弃
    client._send({ Chat: { message: 'x' } });
    assert.equal(sockets.length, 0, '未连接不应建连接');
    // 伪造已连接态但无 socket
    client.connected = true;
    assert.doesNotThrow(() => client._send({ Chat: { message: 'x' } }));
    // 有 socket 但 connected=false（_send 双条件都要求）
    const sock = new EventEmitter();
    sock.written = [];
    sock.write = (s) => { sock.written.push(s); return true; };
    client.socket = sock;
    client.connected = false;
    client._send({ Chat: { message: 'y' } });
    assert.equal(sock.written.length, 0, 'connected=false 时 _send 必须短路');
    client.connected = true;
    client._send({ Chat: { message: 'z' } });
    assert.equal(sock.written.length, 1);
    assert.equal(sock.written[0], '{"Chat":{"message":"z"}}\r\n');
});

test('sendState：字段填充与默认值（position 兜 0、paused 强转布尔、doSeek 默认 false）', async () => {
    const { client, sockets } = makeClient();
    client.sendState(12.5, true, true); // 未连接 → no-op
    const p = client.connect('h', 1, 'u', 'r', false);
    await flush();
    const sock = sockets[0];
    sock.fireConnect();
    await p;
    sock.written.length = 0;

    client.sendState(12.5, 1, true);
    const f = sock.frames()[0];
    assert.equal(f.State.position, 12.5);
    assert.equal(f.State.paused, true, 'paused 应强转布尔');
    assert.equal(f.State.doSeek, true);
    assert.equal(typeof f.State.clientLatencyCalculation, 'number');
    assert.ok(f.State.clientLatencyCalculation > 0, '应写入秒级时间戳');
    assert.equal(client.clientLatencyCalculation, f.State.clientLatencyCalculation);
    assert.equal(f.State.clientRtt, 0);

    sock.written.length = 0;
    client.sendState(undefined, undefined, undefined);
    const g = sock.frames()[0];
    assert.equal(g.State.position, 0, 'position 缺省应兜 0');
    assert.equal(g.State.paused, false);
    assert.equal(g.State.doSeek, false, 'doSeek 缺省应为 false');
});

test('sendFile/sendChat/sendReady：帧结构正确，sendFile 记录 lastFileUpdate', async () => {
    const { client, sockets } = makeClient();
    const p = client.connect('h', 1, 'u', 'r', false);
    await flush();
    const sock = sockets[0];
    sock.fireConnect();
    await p;
    sock.written.length = 0;

    client.sendFile('剧名 - 第01集.mp4', 1440);
    assert.ok(client.lastFileUpdate > 0, 'sendFile 应刷新最后换集时间');
    const file = sock.frames()[0];
    assert.deepStrictEqual(plain(file.Set.file), { name: '剧名 - 第01集.mp4', duration: 1440, size: 0 });

    sock.written.length = 0;
    client.sendFile('无时长.mp4');
    assert.equal(sock.frames()[0].Set.file.duration, 0, 'duration 缺省兜 0');

    sock.written.length = 0;
    client.sendChat('大家好');
    assert.deepStrictEqual(plain(sock.frames()[0]), { Chat: { message: '大家好' } });

    sock.written.length = 0;
    client.sendReady(true);
    assert.deepStrictEqual(plain(sock.frames()[0].Set.ready), { manuallySet: true, isReady: true, explicitlySet: true });
});

// ---------------------------------------------------------------- 入站分帧（TCP 流）

test('入站：单 chunk 粘包多帧一次全部解析', () => {
    const { client, seen } = makeClient();
    client._onData('{"Hello":{"username":"a"}}\r\n{"Chat":{"username":"b","message":"hi"}}\r\n');
    assert.equal(seen.hello.length, 1);
    assert.equal(seen.chat.length, 1);
    assert.equal(client._recvBuf, '', '完整帧解析后缓冲应清空');
});

test('入站：半包跨 chunk 拼帧（残包留缓冲，下一 chunk 补全后解析）', () => {
    const { client, seen } = makeClient();
    client._onData('{"Chat":{"username":"u"');
    assert.equal(seen.chat.length, 0, '半包不应触发解析');
    assert.equal(client._recvBuf, '{"Chat":{"username":"u"', '残包必须留在缓冲里');
    client._onData(',"message":"拼包成功"}}\r\n');
    assert.equal(seen.chat.length, 1);
    assert.deepStrictEqual(seen.chat[0], { username: 'u', message: '拼包成功' });
    assert.equal(client._recvBuf, '');
});

test('入站：非法 JSON 行与空行被忽略，不影响后续帧', () => {
    const { client, seen } = makeClient();
    client._onData('这不是 JSON\r\n\r\n   \r\n{"Chat":{"username":"u","message":"ok"}}\r\n');
    assert.equal(seen.chat.length, 1, '非法行静默丢弃，不应中断后续解析');
    assert.deepStrictEqual(seen.chat[0], { username: 'u', message: 'ok' });
    assert.equal(client._recvBuf, '', '完整帧已消费完，缓冲应为空');

    // 去掉行尾换行的坏帧算残包：留在缓冲里等后续数据，不重复解析
    client._onData('{坏帧');
    assert.equal(seen.chat.length, 1);
    assert.equal(client._recvBuf, '{坏帧');
});

test('入站：裸 \\n 分帧兼容（异常服务器不发 \\r）', () => {
    const { client, seen } = makeClient();
    client._onData('{"Chat":{"username":"a","message":"m1"}}\n{"Chat":{"username":"b","message":"m2"}}\n');
    assert.equal(seen.chat.length, 2, '裸 \\n 也应切帧，否则缓冲会被卡死');
    assert.equal(seen.chat[1].message, 'm2');
    assert.equal(client._recvBuf, '');
});

test('入站：残包超 1MB 清空缓冲（防恶意/异常数据撑爆内存）', () => {
    const { client } = makeClient();
    client._onData('x'.repeat(1024 * 1024 + 8));
    assert.equal(client._recvBuf, '', '超过 1MB 的残帧应被丢弃');
});

// ---------------------------------------------------------------- 消息分发

test('_handleMessage：Hello/State/Set(user+file+ready)/Chat/Error 各自分发', () => {
    const { client, seen } = makeClient();
    client._handleMessage({ Hello: { username: 'srv' } });
    assert.deepStrictEqual(plain(seen.hello[0]), { username: 'srv' });

    client._handleMessage({ State: { position: 10, paused: true, doSeek: false, setBy: 'bob', latencyCalculation: 1, serverRtt: 2 } });
    assert.deepStrictEqual(plain(seen.state[0]), {
        position: 10, paused: true, doSeek: false, setBy: 'bob', latencyCalculation: 1, serverRtt: 2,
    });

    client._handleMessage({ Set: { user: { bob: {} } } });
    assert.deepStrictEqual(plain(client.usernameList), { bob: {} }, 'Set.user 应刷新用户名表');
    assert.deepStrictEqual(seen.users[0], { bob: {} });

    client._handleMessage({ Set: { file: { name: 'a.mkv', duration: 100 } } });
    assert.deepStrictEqual(plain(seen.file[0]), { name: 'a.mkv', duration: 100 });

    client._handleMessage({ Set: { ready: { isReady: true } } });
    assert.deepStrictEqual(plain(seen.ready[0]), { isReady: true });

    client._handleMessage({ Chat: { username: 'bob', message: '你好' } });
    assert.deepStrictEqual(plain(seen.chat[0]), { username: 'bob', message: '你好' });

    client._handleMessage({ Error: { message: '房间已满' } });
    // 注意：Error 由 vm realm 内的 VM Error 构造器造出，跨 realm 的 `instanceof Error` 恒为 false，
    // 故按 name/message 断言（同 src/main/index.js:3839 的取值方式一致）
    assert.equal(seen.error[0].name, 'Error');
    assert.equal(seen.error[0].message, '房间已满');
});

test('_handleMessage：Error 缺省文案兜底；未知 opcode 不 emit 任何业务事件', () => {
    const { client, seen } = makeClient();
    client._handleMessage({ Error: {} });
    assert.equal(seen.error[0].message, 'SyncPlay error', '缺 message 时应兜底文案');

    client._handleMessage({ UnknownOp: { a: 1 } });
    client._handleMessage({});
    assert.equal(seen.hello.length, 0);
    assert.equal(seen.state.length, 0);
    assert.equal(seen.users.length, 0);
    assert.equal(seen.file.length, 0);
    assert.equal(seen.ready.length, 0);
    assert.equal(seen.chat.length, 0);
    assert.equal(seen.error.length, 1, '除上面的 Error 外不应再有事件');
});

// ---------------------------------------------------------------- 心跳

test('心跳：tick 发送 State.ping 并刷新 lastPingTime；connected=false 时跳过', async () => {
    const { client, sockets, tick } = makeClient();
    const p = client.connect('h', 1, 'u', 'r', false);
    await flush();
    const sock = sockets[0];
    sock.fireConnect();
    await p;
    sock.written.length = 0;
    assert.equal(client.lastPingTime, 0);

    tick();
    assert.ok(client.lastPingTime > 0, '心跳应记录发起时间');
    const f = sock.frames()[0];
    assert.ok(f.State.ping, '心跳帧结构为 State.ping');
    assert.equal(typeof f.State.ping.clientLatencyCalculation, 'number');
    assert.equal(f.State.ping.clientRtt, 0);

    // 连接态被置 false 时（如已断开但定时器尚未清）心跳必须短路
    sock.written.length = 0;
    client.connected = false;
    tick();
    assert.equal(sock.written.length, 0, '未连接不应写心跳');
});

test('心跳：反复 connect 不产生并行 ping 循环（旧 interval 必被清理）', async () => {
    const { client, sockets, timerState } = makeClient();
    for (let i = 0; i < 3; i++) {
        const p = client.connect('h', i, 'u', 'r', false);
        await flush();
        sockets[i].fireConnect();
        await p;
    }
    assert.equal(timerState.live, 1, '任意时刻只应有一个在途 ping interval');
    assert.equal(timerState.peak, 1, 'N 次连接不应并行跑 N 个心跳循环');
});

test('_stopPingLoop 幂等：重复调用不抛错且句柄归零', () => {
    const { client, timerState } = makeClient();
    client._startPingLoop();
    assert.equal(timerState.live, 1);
    assert.doesNotThrow(() => { client._stopPingLoop(); client._stopPingLoop(); });
    assert.equal(client._pingTimer, null);
    assert.equal(timerState.live, 0);
});

// ---------------------------------------------------------------- 异常与资源清理

test('_send：socket.write 抛错被吞，不向上冒泡（连接已断语义）', async () => {
    const { client, sockets } = makeClient();
    const p = client.connect('h', 1, 'u', 'r', false);
    await flush();
    const sock = sockets[0];
    sock.fireConnect();
    await p;
    // _send 自有 try/catch（src/main/syncplay-client.js:218-220）：底层 write 抛 EPIPE 时
    // 客户端吞掉，IPC 调用方（sendState/sendChat 等）不会因已断连接而抛错
    sock.throwOnWrite = true;
    assert.doesNotThrow(() => client.sendChat('断线了'));
    assert.doesNotThrow(() => client.sendState(1, true, false));
    assert.doesNotThrow(() => client.sendFile('a.mkv', 1));
    assert.doesNotThrow(() => client.sendReady(true));
});

test('回调异常：业务监听抛错被吞且不冒泡，但同 chunk 后续帧仍被解析（逐帧隔离）', () => {
    const { client, seen } = makeClient();
    let listenerCalls = 0;
    client.on('hello', () => { listenerCalls++; throw new Error('listener boom'); });
    // 白盒：try/catch 位于 while 循环内部（src/main/syncplay-client.js:231-243），
    // 只包住「JSON.parse + _handleMessage」这一帧。故监听抛错既不冒泡出 _onData，
    // 也不会连带丢掉同一 chunk 里已经切好的后续帧——这是刻意逐帧隔离的结果。
    assert.doesNotThrow(() => client._onData('{"Hello":{}}\r\n{"Chat":{"username":"u","message":"照常投递"}}\r\n'));
    assert.equal(listenerCalls, 1, '监听确实被调用');
    assert.equal(seen.chat.length, 1, '后续帧不受前帧监听异常影响');
    assert.deepStrictEqual(plain(seen.chat[0]), { username: 'u', message: '照常投递' });
    assert.equal(client._recvBuf, '', '异常后缓冲状态正常，未卡住');
});

test('回调异常：单帧多处 emit 时前一个监听抛错 → 异常冒泡且漏投同帧其余事件', () => {
    // emit 之间没有隔离：users 监听抛错后同帧的 file/ready 就收不到了，异常直接冒泡给 _handleMessage 调用方。
    const env = loadClient();
    const client = new env.SyncplayClient();
    const got = [];
    // 监听顺序：users 先抛错，file/ready 在后（对应源码 emit 顺序）
    client.on('users', () => { got.push('users'); throw new Error('users listener boom'); });
    client.on('file', () => got.push('file'));
    client.on('ready', () => got.push('ready'));

    const frame = { Set: { user: { bob: {} }, file: { name: 'a.mkv' }, ready: { isReady: true } } };
    // 直接调 _handleMessage（无 try 包裹）时异常照常冒泡，且同帧后续事件丢失
    assert.throws(() => client._handleMessage(frame), /users listener boom/);
    assert.deepStrictEqual(got, ['users'], '同帧 file/ready 被前一处抛错吞掉');

    // 经 socket data 路径时异常被 _onData 的逐帧 catch 吞掉：调用方无感，但事件同样只丢不报错
    assert.doesNotThrow(() => client._onData(JSON.stringify(frame) + '\r\n'));
    assert.deepStrictEqual(got, ['users', 'users'], '静默丢失，调用方完全无感知');
});

test('teardown：end/destroy 抛错时被吞，不影响 disconnect 完成', () => {
    const { client, sockets } = makeClient();
    const sock = new EventEmitter();
    sock.ended = 0;
    sock.destroyed = 0;
    sock.end = () => { sock.ended++; throw new Error('end failed'); };
    sock.destroy = () => { sock.destroyed++; throw new Error('destroy failed'); };
    client.socket = sock;
    client.connected = true;
    assert.doesNotThrow(() => client._teardownSocket());
    assert.equal(sock.ended, 1);
    assert.equal(sock.destroyed, 1, 'end 抛错后 destroy 仍应尝试');
    assert.equal(client.socket, null, '异常不影响状态复位');
    assert.equal(client.connected, false);
    assert.equal(sockets.length, 0);
});
