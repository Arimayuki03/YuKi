// 白盒组件测试：dlna-caster.js（UPnP 发现 + SOAP 投屏动作）
// 网络全部走注入桩：dgram（SSDP 组播）与 http（设备描述 / SOAP）替身，
// 并通过 vm 把模块级私有函数 escXml 与常量暴露出来直测（禁止真实发包）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const SRC = path.join(__dirname, '../../src/main/dlna-caster.js');
const SOURCE = fs.readFileSync(SRC, 'utf8');

/** 假定时器：替代 vm 上下文里的 setTimeout，避免真等 3s 搜索窗口。 */
function makeFakeTimers() {
    let seq = 0;
    const pending = [];
    return {
        pending,
        setTimeout(fn, ms) { const id = ++seq; pending.push({ id, fn, ms: ms || 0 }); return id; },
        clearTimeout(id) {
            const i = pending.findIndex((t) => t.id === id);
            if (i >= 0) pending.splice(i, 1);
        },
        /** 触发全部在途定时器（模拟 SSDP 3s 窗口到期）。 */
        fireAll() { const list = pending.splice(0); for (const t of list) t.fn(); return list.length; },
    };
}

/** dgram 替身：createSocket 返回可控的 UDP 桩（不产生真实网络流量）。 */
function makeDgramStub() {
    const sockets = [];
    return {
        sockets,
        createSocket(opts) {
            const sock = new EventEmitter();
            sock.opts = opts;
            sock.sent = [];
            sock.broadcast = null;
            sock.bound = false;
            sock.closed = false;
            sock.bind = (cb) => { sock.bound = true; if (cb) cb(); };
            sock.setBroadcast = (v) => { sock.broadcast = v; };
            sock.send = (msg, off, len, port, addr) => { sock.sent.push({ msg, off, len, port, addr }); };
            sock.close = () => { sock.closed = true; };
            sockets.push(sock);
            return sock;
        },
    };
}

/**
 * http 替身。handlers.onGet(rec) / handlers.onRequest(rec) 决定每次请求的行为：
 * - { body } / { statusCode }  正常响应（get 会走 data→end，request 只给 statusCode）
 * - { error }                  触发 req 'error'
 * - { timeout }                触发 req 'timeout'（_fetchDeviceDesc 分支）
 * - { timeoutThenResponse }    先超时再回调（验证 settled 防双重回调）
 * - { errorThenResponse }      先报错再回调（验证 settled 防双重回调）
 */
function makeHttpStub(handlers = {}) {
    const gets = [];
    const requests = [];
    return {
        gets,
        requests,
        get(url, opts, cb) {
            // 与宿主真实 http.get 行为对齐：构造时同步校验 URL，非法 URL 立即抛
            // ERR_INVALID_URL。之前 stub 不校验，会让「非法 location 被 catch 兜底
            // resolve(null)」这种描述生产行为中不存在路径的用例假阳性。
            if (typeof url === 'string') {
                try { new URL(url); } catch (e) { throw new TypeError(`ERR_INVALID_URL: ${url}`); }
            }
            const rec = { url, opts };
            gets.push(rec);
            const req = new EventEmitter();
            req.destroy = () => { rec.destroyed = true; };
            req.setTimeout = () => {};
            setImmediate(() => {
                const out = (handlers.onGet && handlers.onGet(rec)) || { body: '' };
                if (out.error) { req.emit('error', out.error); return; }
                if (out.timeout) { req.emit('timeout'); return; }
                const rsp = new EventEmitter();
                rsp.statusCode = out.statusCode || 200;
                cb(rsp);
                if (out.body) rsp.emit('data', Buffer.from(out.body, 'utf8'));
                rsp.emit('end');
            });
            return req;
        },
        request(options, cb) {
            // 与 get 同理：options 若是 string/URL 需要先校验
            if (typeof options === 'string') {
                try { new URL(options); } catch (e) { throw new TypeError(`ERR_INVALID_URL: ${options}`); }
            }
            const rec = { options, chunks: [] };
            requests.push(rec);
            const req = new EventEmitter();
            req.write = (chunk) => { rec.chunks.push(String(chunk)); };
            req.end = () => { rec.ended = true; rec.body = rec.chunks.join(''); };
            req.destroy = () => { rec.destroyed = true; };
            req.setTimeout = (ms, fn) => { rec.timeoutMs = ms; rec.timeoutFn = fn; };
            setImmediate(() => {
                const out = (handlers.onRequest && handlers.onRequest(rec)) || { statusCode: 200 };
                if (out.error) { req.emit('error', out.error); return; }
                if (out.errorThenResponse) {
                    req.emit('error', out.errorThenResponse);
                    cb({ statusCode: 200 });
                    return;
                }
                if (out.timeout) { rec.timeoutFn(); return; }
                if (out.timeoutThenResponse) {
                    rec.timeoutFn();
                    cb({ statusCode: 200 });
                    return;
                }
                cb({ statusCode: out.statusCode });
            });
            return req;
        },
    };
}

/**
 * 在 vm 中加载 dlna-caster.js：注入 dgram/http 替身与假定时器，
 * 并把模块私有符号（escXml / SSDP 常量）挂到 globalThis 供白盒直测。
 */
function loadCaster(opts = {}) {
    const timers = makeFakeTimers();
    const dgramStub = opts.dgram || makeDgramStub();
    const httpStub = opts.http || makeHttpStub(opts.handlers);
    const ctx = {
        console, URL, Buffer, Promise, Error, RegExp, JSON, Math, Date, Object,
        String, Number, Boolean, Array, Map, Set, Symbol, parseInt, parseFloat,
        setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
        module: { exports: {} },
        require: (name) => {
            if (name === 'dgram') return dgramStub;
            if (name === 'http') return httpStub;
            if (name === 'events') return { EventEmitter };
            throw new Error(`unexpected require: ${name}`);
        },
    };
    ctx.exports = ctx.module.exports;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(`${SOURCE}
;globalThis.__escXml = escXml;
globalThis.__SSDP_SEARCH = SSDP_SEARCH;
globalThis.__SSDP_ADDR = SSDP_ADDR;
globalThis.__SSDP_PORT = SSDP_PORT;
globalThis.__SOAP_TIMEOUT_MS = SOAP_TIMEOUT_MS;`, ctx, { filename: 'dlna-caster.js' });
    return {
        ctx,
        timers,
        dgram: dgramStub,
        http: httpStub,
        DlnaCaster: ctx.module.exports,
        escXml: ctx.__escXml,
    };
}

/** 微任务/宏任务冲刷：让注入桩里的 setImmediate 回调与 promise 链跑完。 */
async function flush(times = 4) {
    for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

/** 把设备塞进 caster.devices（等价于一次成功发现后的状态）。 */
function register(caster, controlUrl) {
    const location = 'http://192.168.1.9:8200/rootDesc.xml';
    caster.devices.set(location, { name: '客厅电视', location, controlUrl });
    return controlUrl;
}

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';

// ------------------------------------------------------------ escXml（私有，vm 暴露）

test('escXml：& < > " \' 五类实体全部转义，且 & 不被二次转义', () => {
    const { escXml } = loadCaster();
    assert.equal(escXml('&'), '&amp;');
    assert.equal(escXml('<'), '&lt;');
    assert.equal(escXml('>'), '&gt;');
    assert.equal(escXml('"'), '&quot;');
    assert.equal(escXml("'"), '&apos;');
    // 顺序正确（& 先行）：已有实体不会被二次转义成 &amp;amp;
    assert.equal(escXml('&lt;script&gt;'), '&amp;lt;script&amp;gt;');
    assert.equal(escXml('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
    assert.equal(escXml('<s:Envelope xmlns:s="x">'), '&lt;s:Envelope xmlns:s=&quot;x&quot;&gt;');
});

test('escXml：null/undefined 归空串，数字与布尔按值字符串化', () => {
    const { escXml } = loadCaster();
    assert.equal(escXml(null), '');
    assert.equal(escXml(undefined), '');
    assert.equal(escXml(''), '');
    assert.equal(escXml(0), '0');
    assert.equal(escXml(123), '123');
    assert.equal(escXml(false), 'false');
});

test('escXml：中文与超长串原样保留，输出无残留危险字符', () => {
    const { escXml } = loadCaster();
    assert.equal(escXml('间谍过家家 第 12 集'), '间谍过家家 第 12 集');
    const long = '超长标题'.repeat(3000) + '<&>';
    const out = escXml(long);
    assert.equal(out.length, long.length + 10); // <lt; +3、&gt; +3、&amp; +4
    assert.ok(out.length > 12000, '超长串不被截断');
    assert.ok(!/[<>&]/.test(out.replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, '')), '实体外不应残留裸 <>&');
    assert.ok(out.endsWith('&lt;&amp;&gt;'));
});

// ------------------------------------------------------------ SSDP 搜索报文

test('SSDP M-SEARCH：发往 239.255.255.250:1900，ST=MediaRenderer，bind 后广播', () => {
    const env = loadCaster();
    const c = new env.DlnaCaster();
    c.search(); // 不 await：只校验发包行为
    const sock = env.dgram.sockets[0];
    assert.equal(sock.opts.type, 'udp4');
    assert.equal(sock.opts.reuseAddr, true);
    assert.equal(sock.bound, true);
    assert.equal(sock.broadcast, true);
    assert.equal(sock.sent.length, 1);
    const s = sock.sent[0];
    assert.equal(s.port, 1900);
    assert.equal(s.addr, '239.255.255.250');
    assert.equal(s.off, 0);
    assert.equal(s.len, env.ctx.__SSDP_SEARCH.length);
    // 报文要素：CRLF 分隔、M-SEARCH 行、HOST/MAN/MX/ST
    assert.ok(s.msg.startsWith('M-SEARCH * HTTP/1.1\r\n'));
    assert.match(s.msg, /HOST: 239\.255\.255\.250:1900/);
    assert.match(s.msg, /MAN: "ssdp:discover"/);
    assert.match(s.msg, /MX: 3/);
    assert.match(s.msg, /ST: urn:schemas-upnp-org:device:MediaRenderer:1/);
    assert.ok(s.msg.endsWith('\r\n\r\n'), '报文以空行结尾');
    assert.equal(s.msg.split('\r\n').filter((l) => l === '').length, 2, '头部后有空行');
});

// ------------------------------------------------------------ search：SSDP 响应解析

test('search：LOCATION 头大小写与空格差异均能提取（触发一次描述拉取）', async () => {
    const env = loadCaster({ handlers: { onGet: () => ({ body: '' }) } });
    const c = new env.DlnaCaster();
    const p = c.search();
    const sock = env.dgram.sockets[0];
    sock.emit('message', Buffer.from('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.5:8200/desc.xml\r\n\r\n'));
    await flush();
    sock.emit('message', Buffer.from('HTTP/1.1 200 OK\r\nlocation:   http://192.168.1.6/desc.xml  \r\n\r\n'));
    sock.emit('message', Buffer.from('HTTP/1.1 200 OK\r\nLoCaTiOn:\thttp://192.168.1.7:1234/desc.xml\r\n\r\n'));
    await flush();
    env.timers.fireAll();
    await p;
    const urls = env.http.gets.map((g) => g.url);
    assert.deepEqual(urls, [
        'http://192.168.1.5:8200/desc.xml',
        'http://192.168.1.6/desc.xml',
        'http://192.168.1.7:1234/desc.xml',
    ]);
});

test('search：缺 LOCATION 头的 SSDP 报文直接忽略（不拉描述、不抛错）', async () => {
    const env = loadCaster({ handlers: { onGet: () => ({ body: '' }) } });
    const c = new env.DlnaCaster();
    const p = c.search();
    const sock = env.dgram.sockets[0];
    sock.emit('message', Buffer.from('HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:abc\r\n\r\n'));
    sock.emit('message', Buffer.from('NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\n\r\n'));
    await flush();
    env.timers.fireAll();
    await p;
    assert.equal(env.http.gets.length, 0, '无 LOCATION 不应触发任何 HTTP 拉取');
});

test('search：畸形报文（空包/纯文本/LOCATION 空值）不崩溃且不产生设备', async () => {
    const env = loadCaster({ handlers: { onGet: () => ({ body: '' }) } });
    const c = new env.DlnaCaster();
    const p = c.search();
    const sock = env.dgram.sockets[0];
    assert.doesNotThrow(() => {
        sock.emit('message', Buffer.from(''));
        sock.emit('message', Buffer.from('这不是 HTTP 报文'));
        sock.emit('message', Buffer.from('HTTP/1.1 200 OK\r\nLOCATION:\r\n\r\n'));
        sock.emit('message', Buffer.from('\u0000\u00ff\u00fe garbage'));
    });
    await flush();
    env.timers.fireAll();
    await p;
    assert.equal(env.http.gets.length, 0);
    assert.equal(c.devices.size, 0);
});

test('search：重复 LOCATION 去重依赖 devices 填充 —— 描述返回 null 时重复报文被重复拉取（疑似缺陷）', async () => {
    // 现状（src/main/dlna-caster.js:62）：判重查的是 devices，而 devices 只在
    // _fetchDeviceDesc 成功后才写入。同一设备连发两条 SSDP 响应（组播+单播常见）
    // 时，在首个描述返回前不会被去重 → 重复 HTTP 拉取；描述为 null 时永不入表，
    // 每次报文都会重拉一遍。记录现状，非本次改动项。
    const env = loadCaster({ handlers: { onGet: () => ({ body: '' }) } });
    const c = new env.DlnaCaster();
    const p = c.search();
    const sock = env.dgram.sockets[0];
    const payload = 'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.5:8200/desc.xml\r\n\r\n';
    sock.emit('message', Buffer.from(payload));
    sock.emit('message', Buffer.from(payload));
    await flush(); // 两条报文都在描述结果回填前到达
    const burst = env.http.gets.length;
    env.timers.fireAll();
    await p;
    assert.equal(burst, 2, '描述为 null 时同一 LOCATION 会被重复拉取');

    // 对照组：描述可解析（设备入表）后，再来的同 LOCATION 报文被 devices 挡掉
    const desc = '<root><device><friendlyName>TV</friendlyName><serviceList><service>'
        + `<serviceType>${AVT}</serviceType><controlURL>/ctl/AVT</controlURL></service>`
        + '</serviceList></device></root>';
    const env2 = loadCaster({ handlers: { onGet: () => ({ body: desc }) } });
    const c2 = new env2.DlnaCaster();
    const p2 = c2.search();
    const sock2 = env2.dgram.sockets[0];
    sock2.emit('message', Buffer.from(payload));
    await flush(); // 让首个描述回填 devices
    sock2.emit('message', Buffer.from(payload.replace('LOCATION:', 'location:')));
    await flush();
    env2.timers.fireAll();
    await p2;
    assert.equal(env2.http.gets.length, 1, '设备入表后同 LOCATION 被去重');
    assert.equal(c2.devices.size, 1);
});

test('search：USN/ST 头不参与解析，仅 LOCATION 决定设备身份', async () => {
    const desc = '<root><device><friendlyName>TV</friendlyName>'
        + `<serviceList><service><serviceType>${AVT}</serviceType><controlURL>/ctl/AVT</controlURL></service></serviceList>`
        + '</device></root>';
    const env = loadCaster({ handlers: { onGet: () => ({ body: desc }) } });
    const c = new env.DlnaCaster();
    const p = c.search();
    const sock = env.dgram.sockets[0];
    // 一个带 USN/ST，一个不带，LOCATION 相同 → 视为同一设备
    sock.emit('message', Buffer.from('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.5/desc.xml\r\nUSN: uuid:a::MediaRenderer\r\nST: upnp:rootdevice\r\n\r\n'));
    await flush();
    sock.emit('message', Buffer.from('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.5/desc.xml\r\n\r\n'));
    await flush();
    env.timers.fireAll();
    const list = await p;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'TV');
    assert.equal(list[0].controlUrl, 'http://192.168.1.5/ctl/AVT');
});

test('search：3s 窗口到期 emit devices 并 resolve 设备列表（不真等 3s）', async () => {
    const desc = '<root><device><friendlyName>卧室盒子</friendlyName>'
        + `<serviceList><service><serviceType>${AVT}</serviceType><controlURL>/upnp/control/AVT</controlURL></service></serviceList>`
        + '</device></root>';
    const env = loadCaster({ handlers: { onGet: () => ({ body: desc }) } });
    const c = new env.DlnaCaster();
    const events = [];
    c.on('devices', (l) => events.push(l));
    const p = c.search();
    env.dgram.sockets[0].emit('message', Buffer.from('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.8/desc.xml\r\n\r\n'));
    await flush();
    assert.equal(env.timers.pending.length, 1, '应注册一个 3s 窗口定时器');
    assert.equal(env.timers.pending[0].ms, 3000);
    env.timers.fireAll();
    const list = await p;
    assert.equal(list.length, 1);
    assert.equal(list[0].controlUrl, 'http://192.168.1.8/upnp/control/AVT');
    assert.ok(events.length >= 2, '发现时与窗口结束时各 emit 一次 devices');
    assert.equal(events[events.length - 1].length, 1);
    assert.equal(env.dgram.sockets[0].closed, true, '窗口结束应关闭 socket');
});

test('search：socket error 分支 resolve 空数组、关 socket 且清定时器', async () => {
    const env = loadCaster({ handlers: { onGet: () => ({ body: '' }) } });
    const c = new env.DlnaCaster();
    const p = c.search();
    const sock = env.dgram.sockets[0];
    assert.equal(env.timers.pending.length, 1);
    sock.emit('error', new Error('EPERM: 无网络接口'));
    const list = await p;
    assert.deepEqual(list, []);
    assert.equal(sock.closed, true);
    assert.equal(env.timers.pending.length, 0, 'error 分支必须 clearTimeout，防 3s 后再 emit');
});

test('search：新一轮搜索清空上一轮设备（旧 controlUrl 随即失效）', async () => {
    const env = loadCaster({ handlers: { onGet: () => ({ body: '' }) } });
    const c = new env.DlnaCaster();
    register(c, 'http://192.168.1.9:8200/ctl');
    assert.equal(c.devices.size, 1);
    const p = c.search();
    assert.equal(c.devices.size, 0, 'search 入口 devices.clear()');
    env.timers.fireAll();
    await p;
});

// ------------------------------------------------------------ _fetchDeviceDesc：controlURL 拼装

test('_fetchDeviceDesc：相对 controlURL 按 location 的 host:port 拼绝对 URL', async () => {
    const desc = '<root><device><friendlyName>客厅电视</friendlyName><serviceList><service>'
        + `<serviceType>${AVT}</serviceType><controlURL>/ctl/AVTransport</controlURL>`
        + '</service></serviceList></device></root>';
    const env = loadCaster({ handlers: { onGet: () => ({ body: desc }) } });
    const c = new env.DlnaCaster();
    const dev = await c._fetchDeviceDesc('http://192.168.1.5:8200/rootDesc.xml');
    assert.equal(dev.name, '客厅电视');
    assert.equal(dev.location, 'http://192.168.1.5:8200/rootDesc.xml');
    assert.equal(dev.controlUrl, 'http://192.168.1.5:8200/ctl/AVTransport');
});

test('_fetchDeviceDesc：绝对 controlURL（含其它端口/主机）原样采用', async () => {
    const desc = '<root><device><friendlyName>TV</friendlyName><serviceList><service>'
        + `<serviceType>${AVT}</serviceType><controlURL>http://192.168.1.77:9000/AVT/ctrl</controlURL>`
        + '</service></serviceList></device></root>';
    const env = loadCaster({ handlers: { onGet: () => ({ body: desc }) } });
    const c = new env.DlnaCaster();
    const dev = await c._fetchDeviceDesc('http://192.168.1.5:8200/rootDesc.xml');
    assert.equal(dev.controlUrl, 'http://192.168.1.77:9000/AVT/ctrl');
});

test('_fetchDeviceDesc：controlURL 带前后空白被 trim，80 端口 location 也正确', async () => {
    const desc = '<root><device><friendlyName>TV</friendlyName><serviceList><service>'
        + `<serviceType>${AVT}</serviceType><controlURL>  /AVT/ctl  </controlURL>`
        + '</service></serviceList></device></root>';
    const env = loadCaster({ handlers: { onGet: () => ({ body: desc }) } });
    const c = new env.DlnaCaster();
    const dev = await c._fetchDeviceDesc('http://192.168.1.5/rootDesc.xml');
    assert.equal(dev.controlUrl, 'http://192.168.1.5/AVT/ctl');
});

test('_fetchDeviceDesc：无 friendlyName 回落「未知设备」', async () => {
    const desc = '<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><serviceList><service>'
        + `<serviceType>${AVT}</serviceType><controlURL>/ctl</controlURL>`
        + '</service></serviceList></device></root>';
    const env = loadCaster({ handlers: { onGet: () => ({ body: desc }) } });
    const c = new env.DlnaCaster();
    const dev = await c._fetchDeviceDesc('http://192.168.1.5/desc.xml');
    assert.equal(dev.name, '未知设备');
});

test('_fetchDeviceDesc：描述里没有 AVTransport service → resolve(null)', async () => {
    const desc = '<root><device><friendlyName>打印机</friendlyName><serviceList><service>'
        + '<serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/RC</controlURL>'
        + '</service></serviceList></device></root>';
    const env = loadCaster({ handlers: { onGet: () => ({ body: desc }) } });
    const c = new env.DlnaCaster();
    assert.equal(await c._fetchDeviceDesc('http://192.168.1.5/desc.xml'), null);
});

test('_fetchDeviceDesc：多 service 时精确取 AVTransport 的 controlURL（RC 在前）', async () => {
    const desc = '<root><device><friendlyName>TV</friendlyName><serviceList>'
        + '<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/ctl/RC</controlURL></service>'
        + `<service><serviceType>${AVT}</serviceType><controlURL>/ctl/AVT</controlURL></service>`
        + '</serviceList></device></root>';
    const env = loadCaster({ handlers: { onGet: () => ({ body: desc }) } });
    const c = new env.DlnaCaster();
    const dev = await c._fetchDeviceDesc('http://192.168.1.5:8200/desc.xml');
    assert.equal(dev.controlUrl, 'http://192.168.1.5:8200/ctl/AVT');
});

test('_fetchDeviceDesc：AVTransport service 缺 controlURL 时越过 </service> 抓到下游控制 URL（疑似缺陷）', async () => {
    // AVT 段本身没有 controlURL，正则的 [\s\S]*? 会跨过 </service> 命中下一个
    // service（RenderingControl）的 controlURL —— 记录现状，实现见
    // src/main/dlna-caster.js:96（正则未锚定在单个 <service> 块内）。
    const desc = '<root><device><friendlyName>TV</friendlyName><serviceList>'
        + `<service><serviceType>${AVT}</serviceType><SCPDURL>/avt.xml</SCPDURL></service>`
        + '<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/ctl/RC</controlURL></service>'
        + '</serviceList></device></root>';
    const env = loadCaster({ handlers: { onGet: () => ({ body: desc }) } });
    const c = new env.DlnaCaster();
    const dev = await c._fetchDeviceDesc('http://192.168.1.5:8200/desc.xml');
    assert.equal(dev.controlUrl, 'http://192.168.1.5:8200/ctl/RC');
});

test('_fetchDeviceDesc：请求 error 向上传播 reject', async () => {
    const env = loadCaster({ handlers: { onGet: () => ({ error: new Error('ECONNREFUSED') }) } });
    const c = new env.DlnaCaster();
    await assert.rejects(
        () => c._fetchDeviceDesc('http://192.168.1.5/desc.xml'),
        /ECONNREFUSED/);
});

test('_fetchDeviceDesc：超时 resolve(null) 并销毁请求', async () => {
    const env = loadCaster({ handlers: { onGet: () => ({ timeout: true }) } });
    const c = new env.DlnaCaster();
    assert.equal(await c._fetchDeviceDesc('http://192.168.1.5/desc.xml'), null);
    assert.equal(env.http.gets[0].opts.timeout, 5000, '描述请求 5s 超时');
});

test('_fetchDeviceDesc：非法 location（非 URL）同步抛 ERR_INVALID_URL → reject', async () => {
    // 真实 http.get('not-a-url', ...) 会在 ClientRequest 构造时同步抛 ERR_INVALID_URL，
    // 使 _fetchDeviceDesc 的 Promise executor 内抛出 → 整个 Promise reject。
    // 之前的 stub 不校验 URL，让本用例描述了一条生产行为中不存在的兜底路径（假阳性）。
    // 注意：调用方 search() 用 .catch(() => {}) 兜底（dlna-caster.js:64），所以
    // 上层仍可容错，只是 _fetchDeviceDesc 本身不再"静默 resolve(null)"。
    const env = loadCaster({ handlers: { onGet: () => ({ body: '<root/>' }) } });
    const c = new env.DlnaCaster();
    await assert.rejects(
        () => c._fetchDeviceDesc('not-a-url'),
        /ERR_INVALID_URL/);
});

// ------------------------------------------------------------ cast / stop 准入

test('cast/stop：未发现的设备（controlUrl 不在 devices 里）一律 reject，且零 HTTP 请求', async () => {
    const env = loadCaster({ handlers: { onRequest: () => ({ statusCode: 200 }) } });
    const c = new env.DlnaCaster();
    await assert.rejects(() => c.cast('http://192.168.1.9:8200/ctl', 'http://x/a.mp4', '标题'), /unknown dlna device/);
    await assert.rejects(() => c.stop('http://192.168.1.9:8200/ctl'), /unknown dlna device/);
    assert.equal(env.http.requests.length, 0, '准入拒绝必须在发请求之前');
});

test('cast：search 清空设备后，上一轮 controlUrl 不再被接受（兜底闭合）', async () => {
    const env = loadCaster({ handlers: { onRequest: () => ({ statusCode: 200 }) } });
    const c = new env.DlnaCaster();
    const url = register(c, 'http://192.168.1.9:8200/ctl');
    const p = c.search();
    env.timers.fireAll();
    await p;
    await assert.rejects(() => c.cast(url, 'http://x/a.mp4'), /unknown dlna device/);
    assert.equal(env.http.requests.length, 0);
});

// ------------------------------------------------------------ cast：信封与动作序列

test('cast：先 SetAVTransportURI 再 Play，SOAPAction 与信封均正确', async () => {
    const env = loadCaster({ handlers: { onRequest: () => ({ statusCode: 200 }) } });
    const c = new env.DlnaCaster();
    const url = register(c, 'http://192.168.1.9:8200/ctl/AVT');
    await c.cast(url, 'http://nas/movie.mkv', '电影');
    const reqs = env.http.requests;
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].options.method, 'POST');
    assert.equal(reqs[0].options.hostname, '192.168.1.9');
    assert.equal(reqs[0].options.port, 8200);
    assert.equal(reqs[0].options.path, '/ctl/AVT');
    assert.equal(reqs[0].options.headers.SOAPAction, `"${AVT}#SetAVTransportURI"`);
    assert.equal(reqs[1].options.headers.SOAPAction, `"${AVT}#Play"`);

    const setBody = reqs[0].body;
    assert.match(setBody, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
    assert.match(setBody, /<s:Envelope xmlns:s="http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\/"/);
    assert.match(setBody, /s:encodingStyle="http:\/\/schemas\.xmlsoap\.org\/soap\/encoding\/"/);
    assert.match(setBody, /<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">/);
    assert.match(setBody, /<InstanceID>0<\/InstanceID>/);
    assert.match(setBody, /<CurrentURI>http:\/\/nas\/movie\.mkv<\/CurrentURI>/);

    const playBody = reqs[1].body;
    assert.match(playBody, /<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">/);
    assert.match(playBody, /<Speed>1<\/Speed>/);
    assert.doesNotMatch(playBody, /CurrentURI/);
    assert.equal(reqs[0].ended, true);
    assert.equal(reqs[1].ended, true);
});

test('cast：媒体 URL 含 & < > " 经 XML 转义进入 CurrentURI（防 SOAP 注入）', async () => {
    const env = loadCaster({ handlers: { onRequest: () => ({ statusCode: 200 }) } });
    const c = new env.DlnaCaster();
    const url = register(c, 'http://192.168.1.9/ctl');
    const evil = 'http://x/a.mp4?t=1&name=<script>"x"</script>';
    await c.cast(url, evil, '标题');
    const body = env.http.requests[0].body;
    assert.ok(body.includes('<CurrentURI>http://x/a.mp4?t=1&amp;name=&lt;script&gt;&quot;x&quot;&lt;/script&gt;</CurrentURI>'));
    assert.ok(!body.includes('<script>'), '裸 <script> 不应出现在信封里');
    // 转义后仍是合法 XML：Body 内只得一组转义实体，不会出现额外标签
    assert.equal((body.match(/<s:Body>/g) || []).length, 1);
});

test('cast：中文标题与超长 URL 完整入报文；title 未写入 CurrentURIMetaData（疑似缺陷）', async () => {
    const env = loadCaster({ handlers: { onRequest: () => ({ statusCode: 200 }) } });
    const c = new env.DlnaCaster();
    const url = register(c, 'http://192.168.1.9/ctl');
    const longUrl = 'http://nas/剧名/第01集/' + 'x'.repeat(4000) + '.m4v';
    await c.cast(url, longUrl, '间谍过家家 第 12 集 <特别篇>');
    const body = env.http.requests[0].body;
    assert.ok(body.includes(longUrl), '超长 URL 不应被截断');
    assert.ok(body.includes('剧名'), '中文路径按 UTF-8 原样入报文');
    assert.equal(env.http.requests[0].options.headers['Content-Length'], Buffer.byteLength(body));
    // 现状：`<CurrentURIMetaData></CurrentURIMetaData>` 恒空，title 形参未被使用
    // （src/main/dlna-caster.js:113 / 125），设备端拿不到 DIDL-Lite 标题。
    assert.ok(body.includes('<CurrentURIMetaData></CurrentURIMetaData>'));
    assert.ok(!body.includes('间谍过家家'), 'title 未进元数据');
    assert.ok(!/DIDL-Lite/.test(body), '未拼装 DIDL-Lite 元数据');
});

// ------------------------------------------------------------ 动作失败的错误传播

test('cast：SetAVTransportURI 返回 500（SOAP Fault 体）→ reject 且不再发 Play', async () => {
    const fault = '<?xml version="1.0"?><s:Envelope><s:Body><s:Fault>'
        + '<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>'
        + '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>714</errorCode></UPnPError></detail>'
        + '</s:Fault></s:Body></s:Envelope>';
    let served = 0;
    const env = loadCaster({ handlers: { onRequest: () => { served++; return { statusCode: 500, fault }; } } });
    const c = new env.DlnaCaster();
    const url = register(c, 'http://192.168.1.9/ctl');
    await assert.rejects(() => c.cast(url, 'http://x/a.mp4'), /DLNA SetAVTransportURI failed: 500/);
    assert.equal(served, 1, '首动作失败即中止，不应继续发 Play');
    assert.equal(env.http.requests[0].destroyed, true, '失败分支销毁请求');
});

test('cast：SetAVTransportURI 成功但 Play 返回 401 → 错误向上传播', async () => {
    let n = 0;
    const env = loadCaster({ handlers: { onRequest: () => { n++; return { statusCode: n === 1 ? 200 : 401 }; } } });
    const c = new env.DlnaCaster();
    const url = register(c, 'http://192.168.1.9/ctl');
    await assert.rejects(() => c.cast(url, 'http://x/a.mp4'), /DLNA Play failed: 401/);
    assert.equal(n, 2);
});

test('cast：传输层错误（ECONNREFUSED）原样 reject，不包装成状态码错误', async () => {
    const boom = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const env = loadCaster({ handlers: { onRequest: () => ({ error: boom }) } });
    const c = new env.DlnaCaster();
    const url = register(c, 'http://192.168.1.9/ctl');
    await assert.rejects(() => c.cast(url, 'http://x/a.mp4'), (e) => {
        assert.equal(e.code, 'ECONNREFUSED');
        assert.match(e.message, /ECONNREFUSED/);
        return true;
    });
});

test('cast：SOAP 5s 超时 → reject 超时错误并销毁请求（不永挂）', async () => {
    const env = loadCaster({ handlers: { onRequest: () => ({ timeout: true }) } });
    const c = new env.DlnaCaster();
    const url = register(c, 'http://192.168.1.9/ctl');
    await assert.rejects(() => c.cast(url, 'http://x/a.mp4'), /DLNA SetAVTransportURI timeout \(5000ms\)/);
    assert.equal(env.http.requests[0].timeoutMs, 5000);
    assert.equal(env.http.requests[0].destroyed, true);
    assert.equal(env.ctx.__SOAP_TIMEOUT_MS, 5000);
});

// ------------------------------------------------------------ stop

test('stop：SOAPAction=Stop、信封含 InstanceID 0，成功即 resolve', async () => {
    const env = loadCaster({ handlers: { onRequest: () => ({ statusCode: 200 }) } });
    const c = new env.DlnaCaster();
    const url = register(c, 'http://192.168.1.9:8200/ctl/AVT');
    await c.stop(url);
    const reqs = env.http.requests;
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].options.headers.SOAPAction, `"${AVT}#Stop"`);
    assert.match(reqs[0].body, /<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">/);
    assert.match(reqs[0].body, /<InstanceID>0<\/InstanceID>/);
    assert.doesNotMatch(reqs[0].body, /Speed|CurrentURI/);
});

test('stop：动作返回 405 → reject 并销毁请求', async () => {
    const env = loadCaster({ handlers: { onRequest: () => ({ statusCode: 405 }) } });
    const c = new env.DlnaCaster();
    const url = register(c, 'http://192.168.1.9/ctl');
    await assert.rejects(() => c.stop(url), /DLNA Stop failed: 405/);
    assert.equal(env.http.requests[0].destroyed, true);
});

// ------------------------------------------------------------ _sendSoap 请求头与边界

test('_sendSoap：请求头三件套与 path（含 query）拼装正确', async () => {
    const env = loadCaster({ handlers: { onRequest: () => ({ statusCode: 200 }) } });
    const c = new env.DlnaCaster();
    await c._sendSoap('http://192.168.1.9:8200/ctl/AVT?token=1', 'GetPositionInfo', '<body/>');
    const o = env.http.requests[0].options;
    assert.equal(o.hostname, '192.168.1.9');
    assert.equal(o.port, '8200');
    assert.equal(o.path, '/ctl/AVT?token=1');
    assert.equal(o.method, 'POST');
    assert.equal(o.headers['Content-Type'], 'text/xml; charset="utf-8"');
    assert.equal(o.headers.SOAPAction, `"${AVT}#GetPositionInfo"`);
    assert.equal(o.headers['Content-Length'], Buffer.byteLength('<body/>'));
    // 默认端口：无显式端口时落到 80
    await c._sendSoap('http://192.168.1.9/ctl', 'Pause', '<b/>');
    assert.equal(env.http.requests[1].options.port, 80);
});

test('_sendSoap：2xx 边界内成功（200/202），边界外（199/300/404）失败', async () => {
    let n = 0;
    const codes = [200, 202, 199, 300, 404];
    const env = loadCaster({ handlers: { onRequest: () => ({ statusCode: codes[n++] }) } });
    const c = new env.DlnaCaster();
    await c._sendSoap('http://h/ctl', 'Pause', '<b/>');
    await c._sendSoap('http://h/ctl', 'Pause', '<b/>');
    await assert.rejects(() => c._sendSoap('http://h/ctl', 'Pause', '<b/>'), /DLNA Pause failed: 199/);
    await assert.rejects(() => c._sendSoap('http://h/ctl', 'Pause', '<b/>'), /DLNA Pause failed: 300/);
    await assert.rejects(() => c._sendSoap('http://h/ctl', 'Pause', '<b/>'), /DLNA Pause failed: 404/);
});

test('_sendSoap：settled 防双重回调（error→响应 / 超时→响应 只生效首个）', async () => {
    const env = loadCaster({
        handlers: {
            onRequest: (rec) => {
                if (rec.options.path === '/err') return { errorThenResponse: new Error('socket hang up') };
                return { timeoutThenResponse: true };
            },
        },
    });
    const c = new env.DlnaCaster();
    // error 先到，随后的 200 响应不得把 promise 翻成 resolve
    await assert.rejects(() => c._sendSoap('http://h/err', 'Stop', '<b/>'), /socket hang up/);
    assert.equal(env.http.requests[0].destroyed, true);
    // timeout 先到，随后的 200 响应不得把 promise 翻成 resolve
    await assert.rejects(() => c._sendSoap('http://h/t', 'Stop', '<b/>'), /DLNA Stop timeout \(5000ms\)/);
});
