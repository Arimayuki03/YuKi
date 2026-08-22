'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('配置摘要完成后始终触发首页和直播页刷新', () => {
    const source = read('src/renderer/js/panels.js');
    const refreshIndex = source.indexOf('refreshConfigViews();');
    const healthBranchIndex = source.indexOf('if (healthy > 0 || degraded > 0)');
    assert.ok(refreshIndex >= 0);
    assert.ok(healthBranchIndex >= 0);
    assert.ok(refreshIndex < healthBranchIndex, '刷新不能只放在可用站点分支内');
});

test('自动重载监听器在等待后端前注册', () => {
    const source = read('src/renderer/js/app.js');
    const listenerIndex = source.indexOf('window.yuki.onConfigReloaded');
    const waitIndex = source.indexOf('const ok = await waitBackend();');
    assert.ok(listenerIndex >= 0);
    assert.ok(waitIndex >= 0);
    assert.ok(listenerIndex < waitIndex);
});

test('首页站点刷新使用世代令牌丢弃旧响应', () => {
    const source = read('src/renderer/js/home.js');
    assert.match(source, /_sitesLoadToken/);
    assert.match(source, /const isCurrentSitesLoad = \(\) => sitesLoadToken === this\._sitesLoadToken/);
    assert.match(source, /if \(!isCurrentSitesLoad\(\)\) return;/);
});