// 组件测试：playlist-proxy.js — 在线整季原生播放列表的本地按需解析代理
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PlaylistProxy } = require('../../src/main/playlist-proxy');

/** 裸 http GET（keepAlive:false）：避免 undici 连接池与服务器关闭竞态导致进程退出断言失败 */
function req(url) {
    return new Promise((resolve, reject) => {
        const r = http.get(url, { agent: new http.Agent({ keepAlive: false }) }, (res) => {
            res.resume();
            resolve({ status: res.statusCode, location: res.headers.location || '' });
        });
        r.on('error', reject);
    });
}

/** 全量 GET（keepAlive:false）：返回状态/类型/响应体文本，供清单重写断言 */
function reqFull(url, headers) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const r = http.get({
            host: u.hostname, port: u.port, path: u.pathname + u.search,
            agent: new http.Agent({ keepAlive: false }),
            headers: headers || {},
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                contentType: res.headers['content-type'] || '',
                location: res.headers.location || '',
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        r.on('error', reject);
    });
}

/** 测试上游：记录收到的请求头/路径，按路径返回桩内容。返回 { port, seen, close }。
 *  注意 close 前先掐空闲 keep-alive 连接——代理侧用 Node 默认全局 agent（19+ keep-alive），
 *  不掐则 server.close 永不完成（测试挂起）。 */
async function makeUpstream(routes) {
    const seen = [];
    const server = http.createServer((rq, rs) => {
        const chunks = [];
        rq.on('data', (c) => chunks.push(c));
        rq.on('end', () => {
            seen.push({ path: rq.url, headers: rq.headers });
            const route = routes.find((x) => rq.url.startsWith(x.match));
            if (!route) { rs.writeHead(404); rs.end(); return; }
            if (route.respondReceivedHeaders) {
                // 回显收到的关键请求头，便于断言代理注入是否生效
                rs.writeHead(200, { 'Content-Type': route.contentType || 'text/plain' });
                rs.end(JSON.stringify({
                    ua: rq.headers['user-agent'] || '',
                    referer: rq.headers.referer || '',
                    range: rq.headers.range || '',
                }));
                return;
            }
            rs.writeHead(route.status || 200, { 'Content-Type': route.contentType || 'video/mp4' });
            rs.end(route.body != null ? route.body : '');
        });
    });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    return {
        port: server.address().port,
        seen,
        close: () => new Promise((r) => {
            if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
            server.close(r);
        }),
    };
}

/** 恒成功桩：catvod 起始集预热自 v1.1 起为登记必经步骤，不关心解析的用例一律用它 */
const OK_FETCH = async () => ({ json: async () => ({ url: 'http://cdn/warm.m3u8', parse: 0 }) });
const OK_BACKEND = () => ({ base: 'http://backend.test', token: 't' });

/** 起一个代理实例并等待端口就绪，返回 { proxy, base, reg }。 */
async function make(backend, fetchFn, onEntryError) {
    const proxy = new PlaylistProxy({
        getBackend: backend || OK_BACKEND,
        fetchFn: fetchFn || OK_FETCH,
        onEntryError,
    });
    const reg = await proxy.register({
        site: 'csp_site', flag: 'flag1', vipFlags: '[]',
        eps: [{ id: 'ep0', name: '第1集' }, { id: 'ep1', name: '第2集' }],
    });
    assert.ok(reg.ok);
    const base = new URL(reg.entries[0].url).origin;
    return { proxy, base, reg };
}

test('register(): entries 与集数一一对应，标题进 title，start 钳制', async () => {
    const { proxy, reg } = await make();
    assert.equal(reg.entries.length, 2);
    assert.equal(reg.startIndex, 0);
    assert.equal(reg.entries[1].title, '第2集');
    const bad = await proxy.register({ eps: [] });
    assert.equal(bad.ok, false);
    proxy.close();
});

test('register(): catvod 预热起始集——playerContent 的 header 提升为会话头（外部播放器 302 后鉴权依赖）', async () => {
    const { proxy, reg } = await make(OK_BACKEND, async () => ({
        json: async () => ({ url: 'http://cdn/warm.m3u8', parse: 0, header: { Referer: 'http://src.page/', 'User-Agent': 'UA-1' } }),
    }));
    // 会话头随 register 返回：主进程据此注入全局 --http-header-fields / 外部播放器开关
    assert.equal(reg.headers.Referer, 'http://src.page/');
    assert.equal(proxy.getSessionHeaders(reg.token)['User-Agent'], 'UA-1');
    // 预热命中的首集直接 302，无需再解析
    const rsp = await req(`${reg.entries[0].url}`);
    assert.equal(rsp.status, 302);
    assert.equal(rsp.location, 'http://cdn/warm.m3u8');
    proxy.close();
});

test('GET /pl/<token>/<i>: 解析成功 → 302 到真实直链', async () => {
    const { proxy, base, reg } = await make(
        OK_BACKEND,
        async () => ({ json: async () => ({ url: 'http://cdn/x.m3u8', parse: 0 }) }),
    );
    const rsp = await req(`${base}/pl/${reg.token}/1`);
    assert.equal(rsp.status, 302);
    assert.equal(rsp.location, 'http://cdn/x.m3u8');
    proxy.close();
});

test('GET /pl/<token>/<i>: 懒解析失败自动重试一次；持续失败 → 502 + onEntryError', async () => {
    const errors = [];
    let calls = 0;
    const { proxy, base, reg } = await make(
        OK_BACKEND,
        async () => {
            calls += 1;
            // 第 1 次（预热起始集）成功；其后全部返回空地址 → 懒解析路径持续失败
            return { json: async () => (calls === 1 ? { url: 'http://cdn/warm.m3u8', parse: 0 } : { url: '', parse: 0 }) };
        },
        (info) => errors.push(info),
    );
    // 起始集命中预热缓存 → 302 不受影响
    const r0 = await req(`${base}/pl/${reg.token}/0`);
    assert.equal(r0.status, 302);
    // 非起始集懒解析：重试后仍失败 → 502；onEntryError 只记一次（重试在解析层内部）
    const r1 = await req(`${base}/pl/${reg.token}/1`);
    assert.equal(r1.status, 502);
    assert.deepEqual(errors.map((e) => ({ index: e.index, reason: e.reason })), [
        { index: 1, reason: '播放地址为空' },
    ]);
    assert.ok(errors.every((e) => e.sess && e.sess.site === 'csp_site'));
    proxy.close();
});

test('register(): 起始集预热失败 → 登记失败 + onEntryError（parse=1 由主进程据此拉黑线路）', async () => {
    const errors = [];
    const proxy = new PlaylistProxy({
        getBackend: OK_BACKEND,
        fetchFn: async () => ({ json: async () => ({ url: '', parse: 1 }) }),
        onEntryError: (info) => errors.push(info),
    });
    const reg = await proxy.register({
        site: 'csp_page', flag: 'f', vipFlags: '[]',
        eps: [{ id: 'e0', name: '第1集' }],
    });
    assert.equal(reg.ok, false);
    assert.match(reg.reason, /播放地址为空/);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].index, 0);
    proxy.close();
});

test('GET /pl/<token>/<i>: 首次瞬时失败、重试成功 → 正常 302（不整队判死）', async () => {
    let calls = 0;
    const { proxy, base, reg } = await make(
        OK_BACKEND,
        async () => {
            calls += 1;
            return { json: async () => (calls % 2 === 1 ? { error: 'cold start' } : { url: 'http://cdn/ok.mp4', parse: 0 }) };
        },
    );
    const rsp = await req(`${base}/pl/${reg.token}/0`);
    assert.equal(rsp.status, 302);
    assert.equal(rsp.location, 'http://cdn/ok.mp4');
    proxy.close();
});

test('未知 token / 越界下标 → 404', async () => {
    const { proxy, base, reg } = await make();
    const notFound = await req(`${base}/pl/deadbeefdeadbeef/0`);
    assert.equal(notFound.status, 404);
    const oob = await req(`${base}/pl/${reg.token}/9`);
    assert.equal(oob.status, 404);
    proxy.close();
});

test('kazumi 队列：预热仅轻量页面解析产出规则头（零抓流），拉取时才现场抓流', async () => {
    let captures = 0;
    const proxy = new PlaylistProxy({
        getBackend: () => ({ base: 'http://backend.test', token: 't' }),
        fetchFn: async () => ({ json: async () => ({ pageUrl: 'http://page/play', referer: 'http://page/' }) }),
        captureDirect: async () => {
            captures += 1;
            return { ok: true, url: 'http://cdn/ep.m3u8', header: {} };
        },
    });
    const reg = await proxy.register({
        kind: 'kazumi', site: 'kazumi:demo', pluginName: 'demo',
        eps: [{ id: 'p1', name: '第01集' }], start: 0,
    });
    assert.ok(reg.ok, `register 失败：${reg.reason}`);
    // 规则头随预热产出：主进程据此注入全局 --http-header-fields
    assert.equal(reg.headers.Referer, 'http://page/');
    assert.equal(proxy.getSessionHeaders(reg.token).Referer, 'http://page/');
    // 注册路径绝不抓流（隐藏窗口抓流 15s+ 曾致渲染层竞速超时"一直加载中"）
    assert.equal(captures, 0);
    // 条目打开：现场抓流一次 → 命中缓存 → 302 直链
    const rsp = await req(`${reg.entries[0].url}`);
    assert.equal(rsp.status, 302);
    assert.equal(rsp.location, 'http://cdn/ep.m3u8');
    assert.equal(captures, 1);
    proxy.close();
});

// ---------------------------------------------------------------- 管道模式（外部主播放器）

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('pipe 模式：条目不再 302，代理带会话头转发上游，清单 URI 重写回 /seg', async () => {
    const routes = [
        {
            match: '/master.m3u8', contentType: 'application/vnd.apple.mpegurl',
            body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/v/idx0.m3u8\n',
        },
        { match: '/v/idx0.m3u8', contentType: 'application/vnd.apple.mpegurl', body: '' },
        { match: '/media/seg1.ts', body: 'TSBYTES' },
    ];
    const up = await makeUpstream(routes);
    // 子清单内部分片为绝对地址（端口此时才可知，惰性回填路由体）
    routes[1].body = `#EXTM3U\n#EXTINF:4,\nhttp://127.0.0.1:${up.port}/media/seg1.ts\n`;

    const proxy = new PlaylistProxy({
        getBackend: OK_BACKEND,
        fetchFn: async () => ({
            json: async () => ({
                url: `http://127.0.0.1:${up.port}/master.m3u8`, parse: 0,
                header: { Referer: 'http://src.page/', 'User-Agent': 'UA-1' },
            }),
        }),
    });
    const reg = await proxy.register({
        site: 'csp_site', flag: 'flag1', vipFlags: '[]', pipe: true,
        eps: [{ id: 'ep0', name: '第1集' }],
    });
    assert.ok(reg.ok);

    // 条目：非 302；上游收到会话头（Referer/UA 由代理注入）
    const r0 = await reqFull(reg.entries[0].url);
    assert.equal(r0.status, 200);
    assert.match(r0.contentType, /mpegurl/);
    assert.equal(up.seen[0].path, '/master.m3u8');
    assert.equal(up.seen[0].headers['user-agent'], 'UA-1');
    assert.equal(up.seen[0].headers.referer, 'http://src.page/');
    // 相对子清单 → 绝对地址 → /seg base64url 映射
    const childLine = r0.body.split('\n').find((l) => l.includes('/seg/'));
    assert.ok(childLine, `主清单应包含 /seg 重写行，实际：${r0.body}`);
    assert.ok(childLine.trim().endsWith(b64u(`http://127.0.0.1:${up.port}/v/idx0.m3u8`)));

    // 子清单经 seg 端点取回：同样带头，内部分片映射到同 token
    const rChild = await reqFull(childLine.trim());
    assert.equal(rChild.status, 200);
    assert.equal(up.seen[up.seen.length - 1].path, '/v/idx0.m3u8');
    assert.equal(up.seen[up.seen.length - 1].headers['user-agent'], 'UA-1');
    const seg2 = rChild.body.split('\n').find((l) => l.includes('/seg/'));
    assert.ok(seg2 && seg2.includes(b64u(`http://127.0.0.1:${up.port}/media/seg1.ts`)),
        `分片应映射为 base64url 端点，实际：${rChild.body}`);

    // 分片直通：字节原样回传，Range 头透传上游
    const rSeg = await reqFull(seg2.trim(), { Range: 'bytes=1-3' });
    assert.equal(rSeg.body, 'TSBYTES');
    const lastMedia = up.seen.filter((s) => s.path === '/media/seg1.ts').pop();
    assert.equal(lastMedia.headers.range, 'bytes=1-3');

    await proxy.close();
    await up.close();
});

test('seg 端点门控与直连模式兼容性', async () => {
    const up = await makeUpstream([{ match: '/a.ts', body: 'OKTS' }]);
    const mk = async (pipe) => {
        const proxy = new PlaylistProxy({
            getBackend: OK_BACKEND,
            fetchFn: async () => ({ json: async () => ({ url: `http://127.0.0.1:${up.port}/a.ts`, parse: 0 }) }),
        });
        const reg = await proxy.register({
            site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: 'e0', name: '第1集' }], pipe,
        });
        assert.ok(reg.ok);
        return { proxy, reg };
    };
    // 非 pipe 会话：条目保持 302 零拷贝；seg 路径不可用
    const direct = await mk(false);
    const originD = new URL(direct.reg.entries[0].url).origin;
    const rDirect = await req(direct.reg.entries[0].url);
    assert.equal(rDirect.status, 302);
    const noPipe = await reqFull(`${originD}/seg/${direct.reg.token}/0/${b64u('http://127.0.0.1/x')}`);
    assert.equal(noPipe.status, 404);
    await direct.proxy.close();
    // pipe 会话：seg 可用且字节直通；坏 token → 404（须在关闭该代理前请求，
    // 否则对死端口发起的连接在 Windows 上可能长时间无响应导致测试挂起）
    const piped = await mk(true);
    const originP = new URL(piped.reg.entries[0].url).origin;
    const okSeg = await reqFull(`${originP}/seg/${piped.reg.token}/0/${b64u(`http://127.0.0.1:${up.port}/a.ts`)}`);
    assert.equal(okSeg.status, 200);
    assert.equal(okSeg.body, 'OKTS');
    const bad = await reqFull(`${originP}/seg/deadbeefdeadbeef/0/${b64u('http://x/y')}`);
    assert.equal(bad.status, 404);
    await piped.proxy.close();
    await up.close();
});

