'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

function loadPlayer(parses = []) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/player.js'), 'utf8');
    const jqueryStub = () => ({ on() { return this; }, text() { return ''; }, show() { return this; }, hide() { return this; } });
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, parseInt, parseFloat,
        setTimeout, clearTimeout, getJson: async () => ({ parses }),
        window: { vpc: { settingsGet: async () => ({}) } },
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

test('普通 playUrl 保留前缀拼接，空 url 不回退原始 id', async () => {
    const player = loadPlayer();
    const route = await player._resolvePlayerRoute({ playUrl: 'https://proxy.example/?url=' }, 'episode-id');
    assert.equal(route.url, 'https://proxy.example/?url=episode-id');
    const empty = await player._resolvePlayerRoute({}, '');
    assert.equal(empty.ok, false);
});
