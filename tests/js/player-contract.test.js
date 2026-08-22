'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

function loadPlayer(parses = [], flags = []) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/player.js'), 'utf8');
    const jqueryStub = () => ({ on() { return this; }, text() { return ''; }, show() { return this; }, hide() { return this; } });
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, parseInt, parseFloat,
        setTimeout, clearTimeout, URL,
        getJson: async () => ({ parses, flags }),
        window: { yuki: { settingsGet: async () => ({}) } },
    };
    context.$ = jqueryStub;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testPlayer = Player;`, context, { filename: 'player.js' });
    return context.__testPlayer;
}

test('json: 前缀生成单独的 type=1 解析器', async () => {
    const player = loadPlayer();
    const route = await player._resolvePlayerRoute({ playUrl: 'json:https://jx.example/api?url=' }, 'https://site.example/ep');
    assert.equal(route.parse, 1);
    assert.equal(route.url, 'https://site.example/ep');
    assert.equal(route.parsers[0].url, 'https://jx.example/api?url=');
    assert.equal(route.parsers[0].type, 1);
    assert.equal(route.parsers[0].name, 'json');
});

test('parse: 前缀只选择配置中同名解析器', async () => {
    const parser = { name: '线路解析', type: 1, url: 'https://jx.example/?url=' };
    const player = loadPlayer([parser, { name: '其他', url: 'https://other.example/' }]);
    const route = await player._resolvePlayerRoute({ playUrl: 'parse:线路解析' }, 'https://site.example/ep');
    assert.equal(route.parsers.length, 1);
    assert.equal(route.parsers[0].name, parser.name);
    const missing = await player._resolvePlayerRoute({ playUrl: 'parse:不存在' }, 'https://site.example/ep');
    assert.equal(missing.ok, false);
});

test('普通 playUrl 作为 type=0 前缀解析器，空 url 不回退原始 id', async () => {
    const player = loadPlayer();
    const route = await player._resolvePlayerRoute({ playUrl: 'https://proxy.example/?url=' }, 'episode-id');
    assert.equal(route.url, 'episode-id');
    assert.equal(route.parse, 1);
    assert.equal(route.parsers[0].type, 0);
    assert.equal(route.parsers[0].url + route.url, 'https://proxy.example/?url=episode-id');
    const empty = await player._resolvePlayerRoute({}, '');
    assert.equal(empty.ok, false);
});

test('jx=1 与配置 flags 都会选择解析链，vip flags 不丢失', async () => {
    const parser = { name: 'vip-json', type: 1, url: 'https://jx.example/?url=' };
    const player = loadPlayer([parser], ['youku']);
    const byJx = await player._resolvePlayerRoute({ jx: 1, flag: 'other' }, 'https://site.test/ep');
    const byFlag = await player._resolvePlayerRoute({ parse: 0, flag: 'youku' }, 'https://site.test/ep');
    assert.equal(byJx.parse, 1);
    assert.equal(byFlag.parse, 1);
    assert.equal(byFlag.context.flag, 'youku');
    assert.equal(byFlag.parsers[0].name, 'vip-json');
});

test('本地 go-proxy 网盘取流地址强制直达 mpv，绝不进外部解析链', async () => {
    // 回归背景：站点带 jx=1 时，快路径返回的 do=pan 本地地址曾被交给
    // 外部解析站（jx.m3u8.tv），既必然失败，还把分享 token 泄露给第三方。
    const parser = { name: 'vip-json', type: 1, url: 'https://jx.example/?url=' };
    const player = loadPlayer([parser], ['youku']);
    const panUrl = 'http://127.0.0.1:9978/proxy?do=pan&site=quark&shareId=s1&fileId=f1';
    for (const data of [{ jx: 1 }, { parse: 1 }, { parse: 0 }, {}]) {
        const route = await player._resolvePlayerRoute(data, panUrl);
        assert.equal(route.ok, true);
        assert.equal(route.url, panUrl);
        assert.equal(route.parse, 0, JSON.stringify(data));
        assert.equal(route.parsers, undefined);
    }
    // 站点自带 playUrl 前缀解析器时同样不生效（网盘流不需要再解析）。
    const withPlayUrl = await player._resolvePlayerRoute(
        { playUrl: 'json:https://jx.example/api?url=' }, panUrl);
    assert.equal(withPlayUrl.parse, 0);
    // 旧 jar 的 ?url= 转发通道（localhost）同样是就绪直连流。
    const wrapped = 'http://localhost:9978/proxy?url=https%3A%2F%2Fdl.quark.cn%2Fa.mp4&proxytype=go&thread=8';
    assert.equal((await player._resolvePlayerRoute({ jx: 1 }, wrapped)).parse, 0);
});

test('本地非网盘代理通道与其他地址不受强制直连影响', async () => {
    const parser = { name: 'p0', type: 1, url: 'https://jx.example/?url=' };
    const player = loadPlayer([parser], []);
    // do=py/do=js 等蜘蛛内容通道保持原有路由语义（按站点标记走）。
    const pyProxy = await player._resolvePlayerRoute({ parse: 1 }, 'http://127.0.0.1:9978/proxy?do=py&x=1');
    assert.equal(pyProxy.parse, 1);
    // 远端地址带 url= 参数不是本地通道。
    const remote = await player._resolvePlayerRoute({ jx: 1 }, 'https://jx.example/?url=https%3A%2F%2Fa.test');
    assert.equal(remote.parse, 1);
});
