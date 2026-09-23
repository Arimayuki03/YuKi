'use strict';
/** 白盒单元测试：src/main/playlist-proxy.js — 令牌/条目解析/会话生命周期内部机制。
 *
 *  与 tests/js/playlist-proxy.test.js 的分工：后者以 HTTP 端到端视角覆盖管道转发、
 *  清单重写、R22/R23/R26/R27 等场景；本文件补内部机制分支——
 *  - 令牌与条目 URL 的严格/畸形形态（含越界、负数、非数字、超大、查询串、锚点）；
 *  - register 的 kind 归一化与 start 钳制（含 NaN/负数/越界/字符串）；
 *  - 懒解析触发条件与并发去重（catvodInflight 合流）；
 *  - 会话 TTL 续期、容量上限自淘汰、close 幂等与清理；
 *  - 直连模式的 302 Location 拼装与未知路径 404；
 *  - 解析层（_resolve/_withRetry/_reresolveEntry）的失败分类与重试语义；
 *  - clientError 聚合与 400 兜底。
 *  依赖全部注入桩：fetchFn 替身后端、本地 127.0.0.1 端口 0 的桩上游。 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PlaylistProxy } = require('../../src/main/playlist-proxy');

const OK_BACKEND = () => ({ base: 'http://backend.test', token: 't' });
/** 恒成功解析桩：不关心解析细节的用例一律用它（catvod 起始集预热是登记必经步骤）。 */
const OK_FETCH = async () => ({ json: async () => ({ url: 'http://cdn/warm.m3u8', parse: 0 }) });

/** base64url（与源码同算法）：/seg 端点断言用 */
const b64u = (s) => Buffer.from(String(s), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 裸 GET：只要状态与 Location（keepAlive:false 避免连接池拖住进程退出） */
function req(url, headers) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const r = http.get({
            host: u.hostname, port: u.port, path: u.pathname + u.search,
            agent: new http.Agent({ keepAlive: false }), headers: headers || {},
        }, (res) => {
            res.resume();
            resolve({ status: res.statusCode, location: res.headers.location || '' });
        });
        r.on('error', reject);
    });
}

/** 全量 GET：状态 + 类型 + 响应体（断言空清单/错误文案用） */
function reqFull(url, headers) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const r = http.get({
            host: u.hostname, port: u.port, path: u.pathname + u.search,
            agent: new http.Agent({ keepAlive: false }), headers: headers || {},
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                contentType: res.headers['content-type'] || '',
                location: res.headers.location || '',
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        r.on('error', reject);
    });
}

/** 起一个代理并登记默认三集队列，返回 { proxy, base, reg, sess, token }。 */
async function make(opts = {}) {
    const proxy = new PlaylistProxy({
        getBackend: opts.getBackend || OK_BACKEND,
        fetchFn: opts.fetchFn || OK_FETCH,
        captureDirect: opts.captureDirect || null,
        onEntryError: opts.onEntryError || null,
    });
    const reg = await proxy.register(Object.assign({
        site: 'csp_site', flag: 'flag1', vipFlags: '[]',
        eps: [{ id: 'ep0', name: '第1集' }, { id: 'ep1', name: '第2集' }, { id: 'ep2', name: '第3集' }],
    }, opts.ctx || {}));
    assert.ok(reg.ok, `register 失败：${reg.reason}`);
    const token = new URL(reg.entries[0].url).pathname.split('/')[2];
    return {
        proxy, reg, token,
        base: new URL(reg.entries[0].url).origin,
        sess: proxy.sessions.get(token),
    };
}

// ---------------------------------------------------------------- 令牌与条目 URL（严格匹配）

test('令牌生成：register 产出的 token 与会话表一一对应，可据条目 URL 反查会话', async () => {
    const { proxy, reg, token, sess } = await make();
    assert.equal(token, reg.token, '条目 URL 第三段即会话令牌');
    assert.ok(sess, '从条目 URL 取回的 token 应命中会话表');
    assert.equal(sess.eps.length, 3);
    assert.equal(sess.site, 'csp_site');
    assert.equal(sess.flag, 'flag1');
    // 条目 URL 形如 /pl/<token>/<index>.m3u8：catvod 统一 .m3u8 标签（R27 前口径）
    assert.match(reg.entries[0].url, /\/pl\/[A-Za-z0-9_-]{8,64}\/0\.m3u8$/);
    assert.equal(reg.entries[2].title, '第3集');
    await proxy.close();
});

test('令牌校验：缺失/篡改/过短的令牌一律 404（不得退回空清单掩盖失效）', async () => {
    const { proxy, base, reg } = await make();
    // 不存在的令牌（过期/应用重启后旧列表）
    assert.equal((await req(`${base}/pl/deadbeefdeadbeef/0`)).status, 404);
    // 篡改最后一位（令牌字符集合法但无对应会话）
    const tampered = `${reg.token.slice(0, -1)}${reg.token.slice(-1) === 'a' ? 'b' : 'a'}`;
    assert.equal((await req(`${base}/pl/${tampered}/0`)).status, 404);
    // 过短令牌：TOKEN_RE 要求 8-64 位，不足不匹配 → 无会话 → 404
    assert.equal((await req(`${base}/pl/abc/0`)).status, 404);
    await proxy.close();
});

test('令牌校验：活令牌下越界/负数/非数字/超长 index 回空清单软响应（避免 VLC 弹窗刷屏）', async () => {
    const { proxy, base, reg } = await make();
    const cases = ['3', '-1', '9999', '10000', '1x', '0/0', ''];
    for (const suffix of cases) {
        const rsp = await reqFull(`${base}/pl/${reg.token}/${suffix}`);
        assert.equal(rsp.status, 200, `index=${suffix} 活令牌下应为软响应`);
        assert.equal(rsp.contentType, 'application/vnd.apple.mpegurl', `index=${suffix}`);
        assert.equal(rsp.body, '#EXTM3U\n#EXT-X-ENDLIST\n', `index=${suffix}`);
    }
    await proxy.close();
});

test('条目 URL 解析：合法 index 的等价形态（补零/伪扩展名/查询串/锚点）均解析到同一集', async () => {
    let seen = 0;
    const { proxy, base, reg } = await make({
        fetchFn: async (u, init) => {
            seen += 1;
            assert.match(String(init.body), /do=playerContent/);
            return { json: async () => ({ url: 'http://cdn/one.m3u8', parse: 0 }) };
        },
    });
    // 索引 1：1 / 1.m3u8 / 01（TOKEN_RE 限 1-4 位十进制）/ 带 ?query / 带 #frag
    for (const p of [`${base}/pl/${reg.token}/1`, `${base}/pl/${reg.token}/1.m3u8`,
        `${base}/pl/${reg.token}/01`, `${base}/pl/${reg.token}/1.m3u8?t=1`,
        `${base}/pl/${reg.token}/1.m3u8#frag`]) {
        const rsp = await req(p);
        assert.equal(rsp.status, 302, `路径 ${p} 应 302`);
        assert.equal(rsp.location, 'http://cdn/one.m3u8', `路径 ${p} 的 Location`);
    }
    // 首集命中预热缓存（不解析）；后续 4 次全部落在 index=1 的缓存上 → 仅 1 次现场解析
    assert.equal(seen, 2, `预热 1 次 + 首回 1 次，其后 4 次应命中缓存（实际 ${seen}）`);
    await proxy.close();
});

test('未知路径：非 /pl 前缀、/pl 无 index 段、短令牌段一律 404', async () => {
    const { proxy, base, reg } = await make();
    for (const p of ['/', '/foo', '/pl', `/pl/${reg.token}`, '/pl/ab/0', '/seg', '/plx/a/0']) {
        const rsp = await reqFull(`${base}${p}`);
        assert.equal(rsp.status, 404, `路径 ${p} 应 404`);
    }
    // 宽松前缀命中活令牌但 TOKEN_RE 不匹配（无 index 段）→ 空清单而非 404
    const loose = await reqFull(`${base}/pl/${reg.token}/`);
    assert.equal(loose.status, 200);
    assert.equal(loose.body, '#EXTM3U\n#EXT-X-ENDLIST\n');
    await proxy.close();
});

test('seg 端点：非管道会话 / 上游非法 / 解码后非 http 一律 404，且零上游请求', async () => {
    const { proxy, base, reg } = await make();
    const cases = [
        b64u('http://127.0.0.1:1/a.ts'),  // 合法地址但会话非 pipe
        b64u('ftp://x/a.ts'),             // 协议非法
        b64u(''),                         // 空地址
        'not-base64!!',                   // 非法 base64url 字符 → 无匹配
    ];
    for (const enc of cases) {
        const rsp = await req(`${base}/seg/${reg.token}/0/${enc}`);
        assert.equal(rsp.status, 404, `seg 载荷 ${enc || '(空)'} 应 404`);
    }
    await proxy.close();
});

// ---------------------------------------------------------------- register：kind / start / 校验

test('register：kind 归一化——kazumi 未注入 captureDirect 时降级为 catvod', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    const reg = await proxy.register({
        kind: 'kazumi', site: 'kazumi:demo', pluginName: 'demo',
        eps: [{ id: 'p1', name: '第01集' }], start: 0,
    });
    assert.ok(reg.ok);
    assert.equal(proxy.sessions.get(reg.token).kind, 'catvod',
        '无抓流注入时走 catvod 解析链（否则预热调 kazumiResolve 必然失败）');
    assert.equal(reg.entries[0].url.endsWith('.m3u8'), true, 'catvod 条目统一 .m3u8 标签');
    await proxy.close();
});

test('register：kind=static 校验全部集目直链——非法协议在第 N 项报错并拒绝登记', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND });
    // 第 1 项即非法
    const bad1 = await proxy.register({ kind: 'static', eps: [{ id: 'ftp://x/a.mp4', name: 'a' }] });
    assert.equal(bad1.ok, false);
    assert.equal(bad1.reason, 'static 直链非法（第 1 项）');
    // 前两项合法、第 3 项非法：序号按过滤后的索引报（1-based 提示）
    const bad3 = await proxy.register({ kind: 'static', eps: [
        { id: 'http://o/a.mp4', name: 'a' }, { id: 'http://o/b.mp4', name: 'b' }, { id: 'e3', name: 'c' },
    ] });
    assert.equal(bad3.ok, false);
    assert.equal(bad3.reason, 'static 直链非法（第 3 项）');
    assert.equal(proxy.sessions.size, 0, '登记失败不得留残会话');
    await proxy.close();
});

test('register：空队列 / 空 id 集目 / 非数组入参 → empty queue，不建会话', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    for (const ctx of [null, undefined, {}, { eps: [] }, { eps: 'x' },
        { eps: [{ id: '   ', name: '空白' }] }, { eps: [{ id: null }, { id: undefined }] }]) {
        const r = await proxy.register(ctx);
        assert.equal(r.ok, false, `入参 ${JSON.stringify(ctx)} 应拒绝`);
        assert.equal(r.reason, 'empty queue');
    }
    assert.equal(proxy.sessions.size, 0);
    await proxy.close();
});

test('register：start 钳制到 [0, eps.length-1]——负数/越界/NaN/字符串/空值一律可播', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    const ctx = { site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    const table = [
        [-5, 0], [0, 0], [1, 1], [2, 2], [9, 2], [NaN, 0], ['x', 0], [null, 0], [undefined, 0], ['2', 2],
    ];
    for (const [input, want] of table) {
        const r = await proxy.register(Object.assign({}, ctx, { start: input }));
        assert.ok(r.ok);
        assert.equal(r.startIndex, want, `start=${JSON.stringify(input)} 应钳制为 ${want}`);
    }
    await proxy.close();
});

// ---------------------------------------------------------------- 按需解析触发与去重

test('按需解析：首集命中预热缓存不再解析；未预热集目首次访问才解析并写缓存', async () => {
    const calls = [];
    const { proxy, base, reg, sess } = await make({
        fetchFn: async (u, init) => {
            const body = String(init.body);
            calls.push(/id=(ep\d)/.exec(body)[1]);
            return { json: async () => ({ url: `http://cdn/${/id=(ep\d)/.exec(body)[1]}.m3u8`, parse: 0 }) };
        },
    });
    assert.deepEqual(calls, ['ep0'], '登记只预热起始集');
    assert.equal(sess.cache.get(0), 'http://cdn/ep0.m3u8');

    // 已预热：直接 302，零新增解析
    const r0 = await req(`${base}/pl/${reg.token}/0`);
    assert.equal(r0.status, 302);
    assert.equal(calls.length, 1, '命中缓存不得再解析');

    // 未预热：现场解析一次并写缓存
    const r1 = await req(`${base}/pl/${reg.token}/2`);
    assert.equal(r1.status, 302);
    assert.equal(r1.location, 'http://cdn/ep2.m3u8');
    assert.deepEqual(calls.slice(1), ['ep2']);
    assert.equal(sess.cache.get(2), 'http://cdn/ep2.m3u8');
    assert.equal(sess.cache.has(1), false, '未访问的集目不应被解析');

    // 二次访问同一集：缓存命中
    await req(`${base}/pl/${reg.token}/2`);
    assert.deepEqual(calls, ['ep0', 'ep2'], '重复访问不得重复解析');
    await proxy.close();
});

test('按需解析并发去重：强鉴权会话同一集并发只解析一次（探测与预取合流同一 promise）', async () => {
    let ep1Calls = 0;
    const { proxy, base, reg } = await make({
        fetchFn: async (u, init) => {
            const id = /id=(ep\d)/.exec(String(init.body))[1];
            if (id === 'ep1') ep1Calls += 1;
            await new Promise((r) => setTimeout(r, 60));
            // 会话头含 Referer → 强鉴权（触发后台预取窗口，catvodInflight 生效）
            return { json: async () => ({ url: `http://cdn/${id}.m3u8`, parse: 0, header: { Referer: 'http://src/' } }) };
        },
    });
    // 并发 3 个请求打同一集（模拟 PotPlayer 探测 + 起播撞车）
    const rs = await Promise.all([
        req(`${base}/pl/${reg.token}/1`),
        req(`${base}/pl/${reg.token}/1`),
        req(`${base}/pl/${reg.token}/1`),
    ]);
    assert.deepEqual(rs.map((x) => x.status), [302, 302, 302]);
    assert.deepEqual(rs.map((x) => x.location), new Array(3).fill('http://cdn/ep1.m3u8'));
    assert.equal(ep1Calls, 1, `同一集并发应合流为一次解析（实际 ${ep1Calls} 次）`);
    await proxy.close();
});

test('预取窗口：非强鉴权会话不启动后台预取（无 catvodInflight，避免无意义解析风暴）', async () => {
    const { proxy, sess, reg } = await make({
        fetchFn: async () => ({ json: async () => ({ url: 'http://cdn/warm.m3u8', parse: 0 }) }), // 无 header
    });
    assert.equal(sess.catvodInflight, undefined, '无强鉴权头不应建预取表');
    // 集目缓存只有预热的首集（startIndex 默认 0）
    assert.equal(reg.startIndex, 0);
    assert.deepEqual([...sess.cache.keys()], [0]);
    // 断言保持非空（避免空断言）：集目总数与缓存规模
    assert.equal(sess.eps.length, 3);
    await proxy.close();
});

// ---------------------------------------------------------------- 302 Location 拼装

test('302 Location：原样透传带签名查询串的直链（不重写、不剥参）', async () => {
    const signed = 'http://cdn.example.com/v/index.m3u8?sign=abc&t=1700000000';
    const { proxy, base, reg } = await make({
        fetchFn: async () => ({ json: async () => ({ url: signed, parse: 0 }) }),
    });
    const rsp = await req(`${base}/pl/${reg.token}/1`);
    assert.equal(rsp.status, 302);
    assert.equal(rsp.location, signed, '签名查询串必须完整保留，丢参即 403');
    await proxy.close();
});

test('302 Location：直连模式（无会话头）不进管道，Location 即上游直链', async () => {
    const { proxy, base, reg } = await make({
        fetchFn: async () => ({ json: async () => ({ url: 'http://cdn/plain.mp4', parse: 0 }) }), // 无 header
    });
    const rsp = await req(`${base}/pl/${reg.token}/1`);
    assert.equal(rsp.status, 302);
    assert.equal(rsp.location, 'http://cdn/plain.mp4');
    await proxy.close();
});

test('本地抓流产物：白名单内文件按 HLS 直出并支持 Range；白名单外本地路径 502', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-plproxy-'));
    const prevDir = process.env.YUKI_ARTIFACT_DIR;
    process.env.YUKI_ARTIFACT_DIR = dir;
    fs.writeFileSync(path.join(dir, 'kazumi_stream_7.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n');
    try {
        const { proxy, reg } = await make({
            ctx: { site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: 'p1', name: '第1集' }], start: 0 },
            fetchFn: async () => ({ json: async () => ({ url: path.join(dir, 'kazumi_stream_7.m3u8'), parse: 0 }) }),
        });
        // 整取：HLS 类型直出（非 302，避免 mpv 把本地清单当播放列表二次展开）
        const r0 = await reqFull(reg.entries[0].url);
        assert.equal(r0.status, 200);
        assert.equal(r0.contentType, 'application/vnd.apple.mpegurl');
        assert.equal(r0.body, '#EXTM3U\n#EXT-X-ENDLIST\n');
        // Range：206 + Content-Range（seek 依赖）
        const r1 = await reqFull(reg.entries[0].url, { Range: 'bytes=0-2' });
        assert.equal(r1.status, 206);
        assert.equal(r1.body, '#EX');
        assert.equal(r1.headers['content-range'], 'bytes 0-2/23');
        await proxy.close();

        // 白名单外：任意本地文件读取面必须封死
        const p2 = new PlaylistProxy({
            getBackend: OK_BACKEND,
            fetchFn: async () => ({ json: async () => ({ url: 'file:///C:/Windows/win.ini', parse: 0 }) }),
        });
        const reg2 = await p2.register({ site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: 'x', name: 'x' }], start: 0 });
        assert.ok(reg2.ok);
        const r2 = await reqFull(reg2.entries[0].url);
        assert.equal(r2.status, 502);
        assert.equal(r2.body, 'forbidden local path');
        await p2.close();
    } finally {
        if (prevDir === undefined) delete process.env.YUKI_ARTIFACT_DIR;
        else process.env.YUKI_ARTIFACT_DIR = prevDir;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------- 解析失败分类与停队

test('解析失败分类：parse=1 / DRM / 空地址 / 源错误 → 各自一条可定位原因（停队文案依据）', async () => {
    const table = [
        [{ url: 'http://cdn/a.m3u8', parse: 1 }, '该集需 VIP 解析线路，原生连播暂不支持'],
        [{ url: 'http://cdn/a.m3u8', drm: true }, '需要 DRM，桌面版暂不支持'],
        [{ url: '   ', parse: 0 }, '播放地址为空'],
        [{ error: { message: '源站炸了' } }, '源站炸了'],
        [{ error: { code: 'E42' } }, 'E42'],
        [{ error: 'plain' }, '源返回错误'],
    ];
    for (const [payload, wantReason] of table) {
        const proxy = new PlaylistProxy({
            getBackend: OK_BACKEND,
            fetchFn: async () => ({ json: async () => payload }),
        });
        const sess = { kind: 'catvod', site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: 'e0' }] };
        const r = await proxy._resolve(sess, 0);
        assert.equal(r.ok, false, `载荷 ${JSON.stringify(payload)} 应判失败`);
        assert.equal(r.reason, wantReason);
        await proxy.close();
    }
});

test('解析失败停队：非起始集失败 → 502 带文本类型 + onEntryError 带会话上下文', async () => {
    const errors = [];
    let n = 0;
    const { proxy, base, reg } = await make({
        fetchFn: async () => {
            n += 1;
            // 首条（预热）成功，其余一律 DRM
            return { json: async () => (n === 1 ? { url: 'http://cdn/warm.m3u8', parse: 0 } : { url: 'http://cdn/x.m3u8', drm: true }) };
        },
        onEntryError: (i) => errors.push(i),
    });
    const rsp = await reqFull(`${base}/pl/${reg.token}/1`);
    assert.equal(rsp.status, 502, '解析失败必须回 502 让播放器跳集（不得悬挂）');
    assert.equal(rsp.contentType, 'text/plain; charset=utf-8', '带 Content-Type 才能被播放器当失败而非无限缓冲');
    assert.equal(rsp.body, '需要 DRM，桌面版暂不支持');
    // 失败后不得写缓存：下次访问应重新解析（重试机会留给连播推进）
    assert.equal(proxy.sessions.get(reg.token).cache.has(1), false);
    assert.equal(errors.length, 1, '重试在解析层内部，onEntryError 应只回调一次');
    assert.equal(errors[0].index, 1);
    assert.equal(errors[0].reason, '需要 DRM，桌面版暂不支持');
    assert.equal(errors[0].sess.token, reg.token, '回调需带会话上下文供主进程定位队列');
    await proxy.close();
});

test('_resolve：解析链折叠为失败对象不裸抛；解析层外的裸 reject 由 _handleAsync 兜底为 502', async () => {
    // ① 解析层内（fetch 抛）已由 _resolve 自身捕获 → 语义化原因，不经「解析异常」路径
    const p1 = new PlaylistProxy({
        getBackend: OK_BACKEND,
        fetchFn: async () => {
            throw new Error('backend exploded');
        },
    });
    const s1 = { kind: 'catvod', site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: 'e0' }] };
    const r1 = await p1._resolve(s1, 0);
    assert.deepEqual(r1, { ok: false, reason: '解析请求失败（后端不可达/超时）' });
    await p1.close();

    // ② 解析层外（_resolveCatvodWithInflight / _withRetry 之外）的裸 reject：
    //    由 _handleAsync 的 .catch 折叠为「解析异常：…」，仍走 502 + onEntryError，
    //    绝不裸抛成无 Content-Type 的 502（播放器会把失败当无限缓冲干等 → 连播静默卡死）
    const errors = [];
    const { proxy, base, reg } = await make({
        fetchFn: async () => ({ json: async () => ({ url: 'http://cdn/warm.m3u8', parse: 0 }) }),
        onEntryError: (i) => errors.push(i),
    });
    const sess = proxy.sessions.get(reg.token);
    assert.equal(sess.kind, 'catvod', '懒解析走 catvod 链（替换 _resolveCatvodWithInflight 才生效）');
    // 直接让懒解析链抛：把 _resolveCatvodWithInflight 换成立即 reject 的桩
    const origInflight = proxy._resolveCatvodWithInflight.bind(proxy);
    assert.equal(typeof origInflight, 'function', '替换前应有原实现');
    const boom = new Error('unexpected resolve layer blow-up');
    proxy._resolveCatvodWithInflight = async () => { throw boom; };
    const rsp = await reqFull(`${base}/pl/${reg.token}/2`);
    assert.equal(rsp.status, 502);
    assert.match(rsp.body, /^解析异常：.*unexpected resolve layer blow-up$/);
    assert.equal(rsp.contentType, 'text/plain; charset=utf-8', '异常路径同样要带 Content-Type');
    assert.equal(errors.length, 1, '异常也要触发 onEntryError（否则播放列表不推进/不收场）');
    assert.equal(errors[0].index, 2);
    assert.match(errors[0].reason, /解析异常/);
    await proxy.close();
});

test('_resolve：后端未就绪 / 响应非 JSON 各自给出可定位失败原因且不抛异常', async () => {
    // 后端未提供地址
    const p1 = new PlaylistProxy({ getBackend: () => null });
    const sess = { kind: 'catvod', site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: 'e0' }] };
    assert.deepEqual(await p1._resolve(sess, 0), { ok: false, reason: '后端未就绪' });
    await p1.close();

    // 后端返回非 JSON（json() reject 被 catch 折叠为 null）
    const p2 = new PlaylistProxy({
        getBackend: OK_BACKEND,
        fetchFn: async () => ({ json: async () => { throw new Error('not json'); } }),
    });
    assert.deepEqual(await p2._resolve(sess, 0), { ok: false, reason: '源返回错误' });
    await p2.close();

    // fetch 直接抛（后端不可达/超时）
    const p3 = new PlaylistProxy({
        getBackend: OK_BACKEND,
        fetchFn: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    assert.deepEqual(await p3._resolve(sess, 0), { ok: false, reason: '解析请求失败（后端不可达/超时）' });
    await p3.close();

    // header 为数组/非对象时降级为 null，解析结果本身仍成功
    const p4 = new PlaylistProxy({
        getBackend: OK_BACKEND,
        fetchFn: async () => ({ json: async () => ({ url: ' http://cdn/a.m3u8 ', parse: 0, header: ['bad'] }) }),
    });
    const ok = await p4._resolve(sess, 0);
    assert.deepEqual(ok, { ok: true, url: 'http://cdn/a.m3u8', header: null }, '地址 trim + header 非法降级');
    await p4.close();
});

test('_withRetry：noRetry 结果立即放弃（Kazumi 抓流失败不再双倍超时）；可重试失败退避一次', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    // noRetry：只调一次，无 600ms 退避
    let n1 = 0;
    const t0 = Date.now();
    const r1 = await proxy._withRetry(async () => { n1 += 1; return { ok: false, reason: 'x', noRetry: true }; });
    assert.equal(n1, 1, 'noRetry 不得二次尝试');
    assert.ok(Date.now() - t0 < 400, 'noRetry 不应退避等待');
    assert.equal(r1.noRetry, true);

    // 可重试：调两次且间隔 ≥600ms（源站冷启动抖动不应整队判死）
    let n2 = 0;
    const t1 = Date.now();
    await proxy._withRetry(async () => { n2 += 1; return { ok: false, reason: 'y' }; });
    assert.equal(n2, 2);
    assert.ok(Date.now() - t1 >= 600, '可重试失败应退避一次再试');

    // 成功即短路
    let n3 = 0;
    const r3 = await proxy._withRetry(async () => { n3 += 1; return { ok: true, url: 'http://cdn/z.m3u8' }; });
    assert.equal(n3, 1);
    assert.equal(r3.ok, true);
    await proxy.close();
});

test('_reresolveEntry：清缓存后以 refresh=1 重新解析，并把新会话头合并进会话', async () => {
    const bodies = [];
    const proxy = new PlaylistProxy({
        getBackend: OK_BACKEND,
        fetchFn: async (u, init) => {
            bodies.push(String(init.body));
            return { json: async () => ({ url: 'http://cdn/new.m3u8', parse: 0, header: { Referer: 'http://r2/' } }) };
        },
    });
    const sess = {
        kind: 'catvod', site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: 'e0' }],
        cache: new Map([[0, 'http://cdn/old.m3u8']]),
        headers: { 'User-Agent': 'UA-old', Referer: 'http://old/' },
    };
    const r = await proxy._reresolveEntry(sess, 0);
    assert.equal(r.ok, true);
    assert.equal(r.url, 'http://cdn/new.m3u8');
    assert.match(bodies[0], /refresh=1/, '重解析必须带 refresh=1 刷新签名');
    assert.equal(sess.cache.get(0), 'http://cdn/new.m3u8', '新直链应覆盖旧缓存');
    // 会话头合并（不是整体替换）：既有 UA 保留，Referer 被刷新值覆盖
    assert.equal(sess.headers['User-Agent'], 'UA-old');
    assert.equal(sess.headers.Referer, 'http://r2/');

    // 重解析失败：不写缓存，返回失败对象
    const p2 = new PlaylistProxy({ getBackend: () => null });
    const sess2 = { kind: 'catvod', site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: 'e0' }], cache: new Map([[0, 'http://cdn/old.m3u8']]) };
    const r2 = await p2._reresolveEntry(sess2, 0);
    assert.equal(r2.ok, false);
    assert.equal(sess2.cache.has(0), false, '失败必须清掉旧直链，避免复用已失效签名');
    await proxy.close();
    await p2.close();
});

// ---------------------------------------------------------------- 会话生命周期

test('会话 TTL：_touch 按最近访问滚动续期（创建时刻过期但活跃会话不被清扫）', async () => {
    const { proxy, reg, sess } = await make();
    // 造「注册于 3 小时前、刚访问过」的活跃会话：按 createdAt 硬删会误杀长视频
    sess.createdAt = Date.now() - 3 * 60 * 60 * 1000;
    const marked = Date.now() - 10 * 60 * 1000;
    sess.lastAccess = marked;
    // 命中 /pl 请求 → 续期
    await req(`${reg.entries[0].url}`);
    assert.ok(sess.lastAccess > marked, '命中应刷新 lastAccess');
    const sweep = () => {
        const now = Date.now();
        for (const [tok, s] of proxy.sessions) {
            if (now - (s.lastAccess || s.createdAt) > 2 * 60 * 60 * 1000) proxy.sessions.delete(tok);
        }
    };
    sweep();
    assert.ok(proxy.sessions.has(reg.token), 'TTL 内活跃会话不得被清扫');
    // 置为 3 小时未访问 → 应被清扫
    sess.lastAccess = Date.now() - 3 * 60 * 60 * 1000;
    sweep();
    assert.equal(proxy.sessions.has(reg.token), false, '超过 TTL 未访问应被清扫');
    await proxy.close();
});

test('会话 TTL：未知令牌路径不续期（只有命中会话的 /pl 才 _touch）', async () => {
    const { proxy, base, sess } = await make();
    const frozen = Date.now() - 60 * 60 * 1000;
    sess.lastAccess = frozen;
    await req(`${base}/pl/deadbeefdeadbeef/0`);
    assert.equal(sess.lastAccess, frozen, '未命中会话的请求不得续期任何会话');
    await proxy.close();
});

test('会话上限：MAX_SESSIONS=8 时新注册淘汰最久未访问者（正播会话不被挤掉）', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    const tokens = [];
    for (let i = 0; i < 8; i++) {
        const r = await proxy.register({ site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: `e${i}`, name: `第${i + 1}集` }] });
        assert.ok(r.ok);
        tokens.push(r.token);
        // 拉开 lastAccess 间隔，确保淘汰顺序确定
        await new Promise((res) => setTimeout(res, 2));
    }
    assert.equal(proxy.sessions.size, 8);
    // 让 tokens[0] 成为「最近访问」（模拟正在播放），tokens[1] 为最旧
    proxy.sessions.get(tokens[0]).lastAccess = Date.now() + 5000;
    const r = await proxy.register({ site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: 'new', name: '新集' }] });
    assert.ok(r.ok);
    assert.equal(proxy.sessions.size, 8, '容量应封顶 8');
    assert.ok(proxy.sessions.has(tokens[0]), '最近访问的会话不得被淘汰');
    assert.equal(proxy.sessions.has(tokens[1]), false, '最久未访问的应被淘汰');
    assert.ok(proxy.sessions.has(r.token), '新会话必须留在表内');
    await proxy.close();
});

test('会话上限自淘汰：候选最旧者恰为新会话时 break——保新会话，容量可短暂越界', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    for (let i = 0; i < 8; i++) {
        const r = await proxy.register({ site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: `e${i}`, name: 'x' }] });
        assert.ok(r.ok);
    }
    // 把所有存量会话的 lastAccess 顶到未来（模拟全部刚被访问过）：
    // 新注册的 lastAccess=now 成为最旧者 → 自淘汰保护触发，不得把自己删掉
    const future = Date.now() + 60 * 1000;
    for (const [, s] of proxy.sessions) s.lastAccess = future;
    const r = await proxy.register({ site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: 'n', name: '新' }] });
    assert.ok(r.ok, '自淘汰保护不得让新会话登记失败');
    assert.ok(proxy.sessions.has(r.token), '新会话必须可用');
    assert.equal(proxy.sessions.size, 9, '自淘汰 break 时容量短暂为 9（后续注册继续收敛）');
    // 新会话的条目仍可正常播放（不会被自己淘汰成 404）
    const rsp = await req(r.entries[0].url);
    assert.equal(rsp.status, 302, '新会话条目应可正常访问');
    await proxy.close();
});

test('getSessionHeaders：未知/空/非字符串令牌返回 null；无会话头的会话同样 null', async () => {
    const { proxy } = await make({
        fetchFn: async () => ({ json: async () => ({ url: 'http://cdn/warm.m3u8', parse: 0 }) }), // 无 header
    });
    assert.equal(proxy.getSessionHeaders('nope'), null);
    assert.equal(proxy.getSessionHeaders(''), null);
    assert.equal(proxy.getSessionHeaders(null), null);
    assert.equal(proxy.getSessionHeaders(undefined), null);
    assert.equal(proxy.getSessionHeaders({}), null);
    await proxy.close();
});

test('close：清空会话表、停清扫器、销毁上游 agent；重复 close 幂等且端口不再接受连接', async () => {
    const { proxy, reg } = await make();
    const port = new URL(reg.entries[0].url).port;
    const sweeper = proxy.sweeper;
    const upAgent = proxy.upAgents.http;
    assert.ok(sweeper, '构造时创建了清扫定时器');
    await proxy.close();
    assert.equal(proxy.sessions.size, 0, 'close 必须清空会话表');
    assert.equal(proxy.getSessionHeaders(reg.token), null);
    // 重复 close 不抛异常（返回 Promise 且 resolve）
    let second = 'pending';
    await proxy.close().then(() => { second = 'resolved'; }, () => { second = 'rejected'; });
    assert.equal(second, 'resolved', 'close 必须幂等');
    // 端口已关闭：连接被拒（Windows 上对死端口可能长时间无响应，故只断言不成功）
    let connectErr = null;
    try { await req(`http://127.0.0.1:${port}/pl/${reg.token}/0`); } catch (e) { connectErr = e; }
    assert.ok(connectErr, `关闭后端口不应继续服务（sweeper=${!!sweeper}, agent=${!!upAgent}）`);
});

test('close(cb)：节点式回调用法在服务器完全关闭后触发（与 Promise 用法兼容）', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    let cbDone = false;
    const pr = proxy.close(() => { cbDone = true; });
    assert.ok(pr instanceof Promise, 'close 始终返回 Promise');
    await pr;
    assert.equal(cbDone, true, '回调应在关闭完成后触发');
});

// ---------------------------------------------------------------- 解析层与请求层兜底

test('clientError：同类错误聚合计数只告警一次，换类后重新告警；一律回 400 并关闭连接', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    const warnings = [];
    const logs = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...a) => warnings.push(a.join(' '));
    console.log = (...a) => logs.push(a.join(' '));
    const ended = [];
    const sock = { end: (s) => ended.push(s) };
    const mkErr = (code, msg) => { const e = new Error(msg); e.code = code; return e; };
    try {
        // 同类连续两条：只首次告警，第二条进聚合计数
        proxy.server.emit('clientError', mkErr('HPE_INVALID_URL', 'bad url'), sock);
        proxy.server.emit('clientError', mkErr('HPE_INVALID_URL', 'bad url'), sock);
        // 换类：先刷出上一条的聚合汇总，再告警新类
        proxy.server.emit('clientError', mkErr('ECONNRESET', 'reset'), sock);
    } finally {
        console.warn = origWarn;
        console.log = origLog;
    }
    assert.equal(warnings.length, 2, `同类应聚合为一条告警（实际 ${warnings.length}）`);
    assert.match(warnings[0], /HPE_INVALID_URL/);
    assert.match(warnings[1], /ECONNRESET/);
    assert.ok(logs.some((l) => /同类已聚合/.test(l)), '换类时应刷出上一条的聚合汇总');
    assert.equal(ended.length, 3, '每条错误都要给客户端一个明确应答');
    assert.equal(ended[0], 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    assert.deepEqual(proxy._clientErrAggr, { sig: 'ECONNRESET', count: 1 });
    await proxy.close();
});

test('清单重写：绝对/相对/标签属性 URI 映射到 /seg 端点，data/非 http 协议保持原样', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    const sess = { token: 'tok_internals_1', eps: [{ id: 'e0' }] };
    const reqObj = { headers: { host: '127.0.0.1:9' } };
    const base = 'http://up.example.com/v/master.m3u8?sign=abc';
    const text = [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.key?k=1",IV=0x1',
        '#EXT-X-MAP:URI="init.mp4"',
        'sub/child.m3u8',
        'http://other.example.com/a/seg1.ts',
        'data:application/octet-stream;base64,AAA',
        'ftp://bad/x.ts',
        '#EXT-X-ENDLIST',
        '',
    ].join('\n');
    const out = proxy._rewriteManifest(text, base, sess, 0, reqObj);
    const lines = out.split('\n');
    const segBase = 'http://127.0.0.1:9/seg/tok_internals_1/0/';
    // 标签属性 URI 重写（KEY/MAP）
    assert.ok(lines[1].includes(`URI="${segBase}${b64u('http://up.example.com/v/key.key?k=1')}"`), lines[1]);
    assert.ok(lines[2].includes(`URI="${segBase}${b64u('http://up.example.com/v/init.mp4?sign=abc')}"`), lines[2]);
    // 相对分片：解析为绝对地址并继承 base 的签名 query（否则子清单 403）
    assert.equal(lines[3], segBase + b64u('http://up.example.com/v/sub/child.m3u8?sign=abc'));
    // 绝对地址：自身无 query 时同样继承 base 的签名串（源码约定：!abs.search && baseUrl
    // 即继承，跨域绝对地址也在此列——本用例钉住现状，非缺陷但跨域签名透传值得留档）
    assert.equal(lines[4], segBase + b64u('http://other.example.com/a/seg1.ts?sign=abc'));
    // data: 与非 http 协议原样保留（重写会破坏播放器本地解析）
    assert.equal(lines[5], 'data:application/octet-stream;base64,AAA');
    assert.equal(lines[6], 'ftp://bad/x.ts');
    // 重写即登记上游域名白名单（/seg 门控依据）
    assert.deepEqual([...sess.upstreamHosts], ['up.example.com', 'other.example.com']);
    // baseUrl=null（本地抓流产物）：相对地址维持原样
    assert.equal(proxy._rewriteManifest('a.ts', null, sess, 0, reqObj), 'a.ts');
    // 无 Host 头时回落 127.0.0.1（代理只绑回环，Host 头缺失不应致命）
    assert.ok(proxy._rewriteManifest('http://x/a.ts', null, sess, 0, {}).startsWith('http://127.0.0.1/seg/'));
    await proxy.close();
});

test('上游域名白名单：_allowUpstreamHost 非法 URL 不登记；_upstreamAllowed 空表/非法一律拒绝', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    const sess = { eps: [{ id: 'e0' }] };
    // 空表：拒绝
    assert.equal(proxy._upstreamAllowed(sess, 'http://a.example.com/x.ts'), false);
    // 非法 URL：不登记也不放行
    proxy._allowUpstreamHost(sess, 'not a url');
    assert.equal(proxy._upstreamAllowed(sess, 'not a url'), false);
    // 合法登记后放行（大小写不敏感）
    proxy._allowUpstreamHost(sess, 'http://A.Example.COM:8080/x.ts');
    assert.equal(proxy._upstreamAllowed(sess, 'http://a.example.com/y.ts'), true);
    assert.equal(proxy._upstreamAllowed(sess, 'http://b.example.com/y.ts'), false, '未登记域必须拒绝');
    await proxy.close();
});

test('_upstreamGet：非法 URL 立即 reject（不发起连接，绝不出网）', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    let msg = '';
    await proxy._upstreamGet('http://%' , {}, 2).catch((e) => { msg = e.message; });
    assert.equal(msg, 'bad upstream url');
    // 跳转目标非法同样 reject
    await proxy._upstreamGet('::::', {}, 2).catch((e) => { msg = e.message; });
    assert.equal(msg, 'bad upstream url');
    await proxy.close();
});

test('并发请求安全性：多集并发各自独立解析，互不影响（无共享游标竞态）', async () => {
    const { proxy, base, reg, sess } = await make({
        fetchFn: async (u, init) => {
            const id = /id=(ep\d)/.exec(String(init.body))[1];
            await new Promise((r) => setTimeout(r, 20));
            return { json: async () => ({ url: `http://cdn/${id}.m3u8`, parse: 0 }) };
        },
    });
    const rs = await Promise.all([0, 1, 2].map((i) => req(`${base}/pl/${reg.token}/${i}`)));
    assert.deepEqual(rs.map((x) => x.status), [302, 302, 302]);
    assert.deepEqual(rs.map((x) => x.location),
        ['http://cdn/ep0.m3u8', 'http://cdn/ep1.m3u8', 'http://cdn/ep2.m3u8'],
        '每集 Location 必须与自身索引对应（串号即连播跳错集）');
    assert.deepEqual([...sess.cache.entries()].sort((a, b) => a[0] - b[0]),
        [[0, 'http://cdn/ep0.m3u8'], [1, 'http://cdn/ep1.m3u8'], [2, 'http://cdn/ep2.m3u8']]);
    await proxy.close();
});

test('注册并发安全性：并行 register 各自拿到独立令牌与端口一致的 base', async () => {
    const proxy = new PlaylistProxy({ getBackend: OK_BACKEND, fetchFn: OK_FETCH });
    const regs = await Promise.all([0, 1, 2].map((i) => proxy.register({
        site: 's', flag: 'f', vipFlags: '[]', eps: [{ id: `e${i}`, name: `第${i + 1}集` }], start: 0,
    })));
    assert.ok(regs.every((r) => r.ok));
    const tokens = regs.map((r) => r.token);
    assert.equal(new Set(tokens).size, 3, '并发注册不得产出重复令牌');
    // 所有会话共享同一监听端口（单实例单端口）
    const ports = new Set(regs.map((r) => new URL(r.entries[0].url).port));
    assert.equal(ports.size, 1);
    assert.equal(proxy.sessions.size, 3);
    for (const r of regs) assert.ok(proxy.sessions.has(r.token));
    await proxy.close();
});
