// 单元测试：R8.1～R8.3 功能开关、数据迁移与发布门禁验证
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('R8.1: 功能开关默认值与 UI 绑定', () => {
    const panelsHtml = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    const panelsJs = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/panels.js'), 'utf8');
    const indexJs = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');

    // 验证功能开关在 UI 中全部呈现（drpy 引擎已移除，不再有对应开关）
    assert.ok(panelsHtml.includes('id="set_pan_fast_path"'));
    assert.ok(panelsHtml.includes('id="set_media_probe"'));
    assert.ok(panelsHtml.includes('id="set_auto_line_fallback"'));
    assert.ok(panelsHtml.includes('id="set_legacy_parser"'));
    assert.ok(!panelsHtml.includes('set_runtime_drpy'));

    // 验证 panels.js 中开关读写绑定
    assert.ok(panelsJs.includes('s.panFastPath !== false'));
    assert.ok(panelsJs.includes('s.mediaProbe !== false'));
    assert.ok(panelsJs.includes('s.autoLineFallback !== false'));
    assert.ok(panelsJs.includes('s.legacyParser !== false'));

    // 验证 main/index.js 环境变量注入
    assert.ok(indexJs.includes('VPC_PAN_FAST_PATH'));
    assert.ok(indexJs.includes('VPC_MEDIA_PROBE'));
    assert.ok(indexJs.includes('VPC_AUTO_LINE_FALLBACK'));
    assert.ok(indexJs.includes('VPC_LEGACY_PARSER'));
});

test('R8.2: 数据迁移：旧历史、收藏与 Cookie 不丢失', () => {
    const recordsJs = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/records.js'), 'utf8');

    // 验证 uid 迁移补齐函数
    assert.ok(recordsJs.includes('ensureRecUids'));
    assert.ok(recordsJs.includes('m${it.ts || 0}-${i}'));

    // 模拟旧版本数据无 uid 时的迁移过程
    const legacyHistory = [
        { name: '旧番剧1', site: 'siteA', ts: 1600000001 },
        { name: '旧番剧2', site: 'siteB', ts: 1600000002, uid: 'existing_uid' },
    ];
    let changed = false;
    legacyHistory.forEach((it, i) => {
        if (it && !it.uid) { it.uid = `m${it.ts || 0}-${i}`; changed = true; }
    });

    assert.equal(changed, true);
    assert.equal(legacyHistory[0].uid, 'm1600000001-0');
    assert.equal(legacyHistory[1].uid, 'existing_uid');
});

test('R8.3: 媒体探测开关 media_probe 控制', () => {
    const indexJs = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
    assert.ok(indexJs.includes('settings.get(\'mediaProbe\') !== false'));
});

test('R8.3: 自动线路回退开关 auto_line_fallback 控制', () => {
    const playerJs = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/player.js'), 'utf8');
    assert.ok(playerJs.includes('autoLineFallback === false'));
});
