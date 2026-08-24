// 组件测试：playlist-proxy.js — 在线整季原生播放列表的本地按需解析代理
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { PlaylistProxy } = require('../../src/main/playlist-proxy');

/** 裸 http GET（keepAlive:false）：避免 undici 连接池与服务器关闭竞态导致进程退出断言。 */
function req(url) {
    return new Promise((resolve, reject) => {
        const r = http.get(url, { agent: new http.Agent({ keepAlive: false }) }, (res) => {
            res.resume();
            resolve({ status: res.statusCode, location: res.headers.location || '' });
        });
        r.on('error', reject);
    });
}

/** 起一个代理实例并等待端口就绪，返回 { proxy, base }。 */
async function make(backend, fetchFn, onEntryError) {
    const proxy = new PlaylistProxy({ getBackend: backend, fetchFn, onEntryError });
    // basePromise 是内部字段：借 register 触发后读取首个 entry 的 origin
    const reg = await proxy.register({
        site: 'csp_site', flag: 'flag1', vipFlags: '[]',
        eps: [{ id: 'ep0', name: '第01集' }, { id: 'ep1', name: '第02集' }],
    });
    assert.ok(reg.ok);
    const base = new URL(reg.entries[0].url).origin;
    return { proxy, base, reg };
}

test('register(): entries 与集数一一对应，标题进 title，start 钳制', async () => {
    const { proxy, reg } = await make(() => null, fetch);
    assert.equal(reg.entries.length, 2);
    assert.equal(reg.startIndex, 0);
    assert.equal(reg.entries[1].title, '第02集');
    const bad = await proxy.register({ eps: [] });
    assert.equal(bad.ok, false);
    proxy.close();
});

test('GET /pl/<token>/<i>: 解析成功 → 302 到真实直链', async () => {
    const { proxy, base, reg } = await make(
        () => ({ base: 'http://backend.test', token: 't' }),
        async () => ({ json: async () => ({ url: 'http://cdn/x.m3u8', parse: 0 }) }),
    );
    const rsp = await req(`${base}/pl/${reg.token}/1`);
    assert.equal(rsp.status, 302);
    assert.equal(rsp.location, 'http://cdn/x.m3u8');
    proxy.close();
});

test('GET /pl/<token>/<i>: 失败自动重试一次；持续失败 → 502 + onEntryError', async () => {
    const errors = [];
    const { proxy, base, reg } = await make(
        () => ({ base: 'http://backend.test', token: 't' }),
        async () => ({ json: async () => ({ url: '', parse: 0 }) }),
        (info) => errors.push(info),
    );
    const r0 = await req(`${base}/pl/${reg.token}/0`);
    assert.equal(r0.status, 502);
    // 重试后仍失败：两次尝试、同一原因，最终 502 带原因
    assert.deepEqual(errors.map((e) => ({ index: e.index, reason: e.reason })), [
        { index: 0, reason: '播放地址为空' },
    ]);
    assert.ok(errors.every((e) => e.sess && e.sess.site === 'csp_site'));
    const r1 = await req(`${base}/pl/${reg.token}/1`);
    assert.equal(r1.status, 502);
    proxy.close();
});

test('GET /pl/<token>/<i>: 首次瞬时失败、重试成功 → 正常 302（不整队判死）', async () => {
    let calls = 0;
    const { proxy, base, reg } = await make(
        () => ({ base: 'http://backend.test', token: 't' }),
        async () => {
            calls += 1;
            return { json: async () => (calls === 1 ? { error: 'cold start' } : { url: 'http://cdn/ok.mp4', parse: 0 }) };
        },
    );
    const rsp = await req(`${base}/pl/${reg.token}/0`);
    assert.equal(rsp.status, 302);
    assert.equal(rsp.location, 'http://cdn/ok.mp4');
    proxy.close();
});

test('未知 token / 越界下标 → 404', async () => {
    const { proxy, base, reg } = await make(() => null, fetch);
    const notFound = await req(`${base}/pl/deadbeefdeadbeef/0`);
    assert.equal(notFound.status, 404);
    const oob = await req(`${base}/pl/${reg.token}/9`);
    assert.equal(oob.status, 404);
    proxy.close();
});

test('kazumi 队列：预热首集产出规则头，条目走缓存直链 302', async () => {
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
    assert.equal(captures, 1); // 预热恰好抓流一次
    // 条目打开：命中预热缓存 → 302 直链，不再重复解析/抓流
    const rsp = await req(`${reg.entries[0].url}`);
    assert.equal(rsp.status, 302);
    assert.equal(rsp.location, 'http://cdn/ep.m3u8');
    assert.equal(captures, 1);
    proxy.close();
});
