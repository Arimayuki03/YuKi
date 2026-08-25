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

test('未知 token → 404；活令牌下越界/畸形路径 → 空清单软响应（R24）', async () => {
    const { proxy, base, reg } = await make();
    // 令牌不存在（过期/重启后旧列表）：维持 404，静默跳过会掩盖真实失效
    const notFound = await req(`${base}/pl/deadbeefdeadbeef/0`);
    assert.equal(notFound.status, 404);
    // 活令牌：数字越界 + VLC 相对解析产出的畸形路径（实测 …/%12、…/Z）一律回
    // 最小合法空清单，播放器静默跳过而非逐条弹「无法打开 MRL」
    for (const suffix of ['9', '%12', 'Z']) {
        const rsp = await reqFull(`${base}/pl/${reg.token}/${suffix}`);
        assert.equal(rsp.status, 200, `path=/${suffix}`);
        assert.equal(rsp.contentType.includes('mpegurl'), true, `path=/${suffix}`);
        assert.equal(rsp.body, '#EXTM3U\n#EXT-X-ENDLIST\n', `path=/${suffix}`);
    }
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

test('R22：static 管道会话 UA/Referer-only 也走 pipe 转发（302 会让播放器裸连丢头被 WAF 拒）', async () => {
    const routes = [
        { match: '/idx.m3u8', contentType: 'application/vnd.apple.mpegurl', body: '' },
        { match: '/media/seg1.ts', body: 'TSBYTES' },
    ];
    const up = await makeUpstream(routes);
    // 子清单内部分片为绝对地址（端口此时才可知，惰性回填路由体）
    routes[0].body = `#EXTM3U\n#EXTINF:4,\nhttp://127.0.0.1:${up.port}/media/seg1.ts\n`;
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND });
    const reg = await proxy.register({
        kind: 'static', title: 'R22', site: '', flag: '', vipFlags: '[]',
        eps: [{ id: `http://127.0.0.1:${up.port}/idx.m3u8`, name: '第1集' }],
        start: 0, pipe: true,
        headers: { Referer: 'http://src.page/', 'User-Agent': 'UA-1' },
    });
    assert.ok(reg.ok);

    // 条目请求：非 302，代理带会话头转发上游（VLC 默认 UA 被 WAF 封锁的场景由此修复）
    const r0 = await reqFull(reg.entries[0].url);
    assert.equal(r0.status, 200);
    assert.match(r0.contentType, /mpegurl/);
    assert.equal(up.seen[0].path, '/idx.m3u8');
    assert.equal(up.seen[0].headers['user-agent'], 'UA-1');
    assert.equal(up.seen[0].headers.referer, 'http://src.page/');
    // 清单重写产物含 /seg 映射行（分片同样经代理注入头取回）
    assert.ok(r0.body.split('\n').some((l) => l.includes('/seg/')), `应包含 /seg 重写行：${r0.body}`);

    await proxy.close();
    await up.close();
});

// ---- R23（2026-08-26）：PotPlayer m3u8 被识别成 MPEG TS ----
// 根因（本机 PotPlayer 26.06.30 请求矩阵实测）：清单响应缺 Content-Type 或为
// application/octet-stream 时，PotPlayer 走「未知内容」原始流路径（Icy-MetaData/
// WINAMP 探测），把 m3u8 当 MPEG TS 播；无头 static 会话旧逻辑 302 直连 CDN，
// 播放器裸连拿到坏 CT 响应即复现。修复：forcePipe 会话无头也强制管道，由代理
// 回写标准 mpegurl + 定长清单。

test('R23：forcePipe 无会话头也强制管道——回写 mpegurl+定长并补默认 UA，而非 302', async () => {
    const routes = [
        // 上游模拟问题 CDN：octet-stream 的 HLS 清单
        { match: '/live/index.m3u8', contentType: 'application/octet-stream',
            body: '#EXTM3U\n#EXTINF:4,\nseg0.ts\n' },
        { match: '/live/seg0.ts', contentType: 'video/mp2t', body: 'TSBYTES' },
    ];
    const up = await makeUpstream(routes);
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND });
    const reg = await proxy.register({
        kind: 'static', title: 'R23', site: '', flag: '', vipFlags: '[]',
        eps: [{ id: `http://127.0.0.1:${up.port}/live/index.m3u8`, name: '第1集' }],
        start: 0, pipe: true, forcePipe: true, headers: {},
    });
    assert.ok(reg.ok);

    // 条目请求必须 200 管道回写（302 直连会复现 MPEG TS 误判）
    const r0 = await reqFull(reg.entries[0].url);
    assert.equal(r0.status, 200);
    assert.match(r0.contentType, /mpegurl/);
    // 相对分片 URI 重写为 /seg 绝对地址（播放器无需自行解析相对路径）
    assert.ok(r0.body.split('\n').some((l) => l.includes('/seg/')), `应包含 /seg 重写行：${r0.body}`);
    // 无会话头时上游收到默认浏览器 UA（Node http 不自动带 UA，WAF 会拒）
    const manifestReq = up.seen.find((s) => s.path.startsWith('/live/index.m3u8'));
    assert.ok(manifestReq, '上游应收到清单请求');
    assert.equal(manifestReq.headers['user-agent'], 'Mozilla/5.0');

    // 分片经 /seg 转发可取回
    const segLine = r0.body.split('\n').find((l) => l.includes('/seg/'));
    const r1 = await reqFull(segLine);
    assert.equal(r1.status, 200);
    assert.equal(r1.body, 'TSBYTES');

    await proxy.close();
    await up.close();
});

test('R23：无 forcePipe 的无头 static 会话维持 302 直连（catvod 队列时长体验不回退）', async () => {
    const routes = [
        { match: '/live/index.m3u8', contentType: 'application/octet-stream',
            body: '#EXTM3U\n#EXTINF:4,\nseg0.ts\n' },
    ];
    const up = await makeUpstream(routes);
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND });
    const reg = await proxy.register({
        kind: 'static', title: 'R23b', site: '', flag: '', vipFlags: '[]',
        eps: [{ id: `http://127.0.0.1:${up.port}/live/index.m3u8`, name: '第1集' }],
        start: 0, pipe: true, headers: {},
    });
    assert.ok(reg.ok);
    const r0 = await req(reg.entries[0].url);
    assert.equal(r0.status, 302);
    assert.equal(r0.location, `http://127.0.0.1:${up.port}/live/index.m3u8`);
    await proxy.close();
    await up.close();
});

// ---------------------------------------------------------------- R26：断流必须终止响应

/** kazumi 管道会话快捷注册（会话头非空 → pipe 模式） */
async function makeKazumiPipe(proxy, upstreamPort, mediaPath) {
    return proxy.register({
        kind: 'kazumi', site: 'kazumi:demo', pluginName: 'demo',
        eps: [{ id: `http://127.0.0.1:${upstreamPort}/page/1`, name: '第01集' }],
        start: 0, pipe: true,
    });
}

const KAZUMI_STUBS = {
    getBackend: () => ({ base: 'http://backend.test', token: 't' }),
    fetchFn: async () => ({ json: async () => ({ pageUrl: 'http://page/play', referer: 'http://p/' }) }),
    captureDirect: null, // 由各用例按上游端口注入
};

test('R26：直通模式上游断流 → 响应必须终止，不得把断流当无限缓冲（VLC 起播无反应根因）', async () => {
    // 上游发 1KB 不可嗅探格式的字节后中途销毁连接（模拟 CDN 断流）。
    // 注意用未知魔串：可嗅探格式（ftyp/TS 魔串等）在 R27 下会 302 改标签，
    // 只有不可识别格式才走直通路径——本用例钉的是直通断流的终止语义。
    const junk = Buffer.from([0x09, 0x0b, 0x0c, 0x0d, ...Buffer.alloc(1020, 0x5a)]);
    const up = http.createServer((rq, rs2) => {
        rs2.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        rs2.write(junk);
        setTimeout(() => { try { rs2.destroy(); } catch (e) { /* ignore */ } }, 50);
    });
    await new Promise((r) => up.listen(0, '127.0.0.1', r));
    const proxy = new PlaylistProxy({
        ...KAZUMI_STUBS,
        captureDirect: async () => ({ ok: true, url: `http://127.0.0.1:${up.address().port}/media.ts`, header: {} }),
    });
    const reg = await makeKazumiPipe(proxy, up.address().port);
    assert.ok(reg.ok);

    const started = Date.now();
    const rsp = await Promise.race([
        reqFull(reg.entries[0].url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('R26 回归：断流后响应未终止，播放器将无限等待')), 5000)),
    ]);
    assert.equal(rsp.status, 200);
    assert.ok(Date.now() - started < 5000);
    await proxy.close();
    await new Promise((r) => up.close(r));
});

test('R26：清单收取总死线——上游慢滴不结束时回 504 明确失败', async () => {
    // 发出 #EXTM3U 头后永不结束（每类 idle 超时都会被「慢滴」躲过，需要总死线兜底）
    const up = http.createServer((rq, rs2) => {
        rs2.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        rs2.write('#EXTM3U\n#EXT-X-TARGETDURATION:6\n');
        // 故意不 end
    });
    await new Promise((r) => up.listen(0, '127.0.0.1', r));
    const proxy = new PlaylistProxy({
        ...KAZUMI_STUBS,
        manifestCollectDeadlineMs: 300,
        captureDirect: async () => ({ ok: true, url: `http://127.0.0.1:${up.address().port}/list.m3u8`, header: {} }),
    });
    const reg = await makeKazumiPipe(proxy, up.address().port);
    assert.ok(reg.ok);

    const started = Date.now();
    const rsp = await Promise.race([
        reqFull(reg.entries[0].url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('R26 回归：清单收取死线未生效')), 4000)),
    ]);
    assert.equal(rsp.status, 504);
    assert.ok(Date.now() - started < 3000, `死线应在注入的 300ms 附近触发（耗时 ${Date.now() - started}ms）`);
    await proxy.close();
    await new Promise((r) => up.close(r));
});

// ---------------------------------------------------------------- R27：非 HLS 内容改标签

test('R27：.m3u8 标签下探到 MP4 → 302 改 .mp4 标签，播放器 demux 与内容对齐', async () => {
    // 字节系 CDN 形态：渐进式 MP4（ftyp 魔串）+ CT video/mp4，VLC 带 Range 全 GET
    const mp4 = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom'),
        Buffer.alloc(32, 0x01),
    ]);
    const up = http.createServer((rq, rs2) => {
        rs2.writeHead(rq.headers.range ? 206 : 200, { 'Content-Type': 'video/mp4' });
        rs2.end(mp4);
    });
    await new Promise((r) => up.listen(0, '127.0.0.1', r));
    const proxy = new PlaylistProxy({
        ...KAZUMI_STUBS,
        captureDirect: async () => ({ ok: true, url: `http://127.0.0.1:${up.address().port}/video/tos/media`, header: {} }),
    });
    const reg = await makeKazumiPipe(proxy, up.address().port);
    assert.ok(reg.ok);
    assert.ok(reg.entries[0].url.endsWith('.m3u8'), 'kazumi 条目默认 .m3u8 标签');

    // VLC 同款带 Range 的清单请求：不再直通二进制（会被 m3u 解析器拆成垃圾子条目），改 302 纠偏
    const r0 = await reqFull(reg.entries[0].url, { Range: 'bytes=0-' });
    assert.equal(r0.status, 302);
    const loc = new URL(r0.location);
    assert.equal(loc.pathname.endsWith('/0.mp4'), true, `Location 应为 .mp4 标签：${r0.location}`);
    assert.equal(loc.pathname.includes(reg.token), true);

    // 纠偏后的 .mp4 地址正常直通（CT 与扩展名一致，demux 不再说谎）
    const r1 = await reqFull(r0.location);
    assert.equal(r1.status, 200);
    assert.equal(r1.contentType.includes('video/mp4'), true);
    assert.ok(r1.body.length >= 40);
    await proxy.close();
    await new Promise((r) => up.close(r));
});

test('R27：TS 魔串按内容识别改 .ts 标签；未知格式维持直通不冒险', async () => {
    const tsBuf = Buffer.alloc(377 + 11, 0);
    [0, 188, 376].forEach((o) => { tsBuf[o] = 0x47; });
    let mode = 'ts';
    const up = http.createServer((rq, rs2) => {
        if (mode === 'ts') {
            rs2.writeHead(200, { 'Content-Type': 'video/mp2t' });
            rs2.end(tsBuf.slice(0, 380));
        } else {
            // 未知格式：非空但无任何已知魔串、CT 也无法归类
            rs2.writeHead(200, { 'Content-Type': 'application/x-unknown-format' });
            rs2.end(Buffer.from([0x09, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11]));
        }
    });
    await new Promise((r) => up.listen(0, '127.0.0.1', r));

    // TS 内容 → 302 .ts
    const p1 = new PlaylistProxy({
        ...KAZUMI_STUBS,
        captureDirect: async () => ({ ok: true, url: `http://127.0.0.1:${up.address().port}/stream`, header: {} }),
    });
    const reg1 = await makeKazumiPipe(p1, up.address().port);
    const r1 = await reqFull(reg1.entries[0].url);
    assert.equal(r1.status, 302);
    assert.equal(new URL(r1.location).pathname.endsWith('.ts'), true, r1.location);
    await p1.close();

    // 未知格式 → 维持直通（200 原样字节），绝不盲目改标签
    mode = 'unknown';
    const p2 = new PlaylistProxy({
        ...KAZUMI_STUBS,
        captureDirect: async () => ({ ok: true, url: `http://127.0.0.1:${up.address().port}/stream`, header: {} }),
    });
    const reg2 = await makeKazumiPipe(p2, up.address().port);
    const r2 = await reqFull(reg2.entries[0].url);
    assert.equal(r2.status, 200);
    await p2.close();
    await new Promise((r) => up.close(r));
});



