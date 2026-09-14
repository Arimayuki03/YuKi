// 单元测试：RM-2 应用内更新控制器（updater.js createUpdaterController）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdaterController, setupAutoUpdater } = require('../../src/main/updater');

/** electron-updater 替身：记录调用，事件由用例手动驱动。 */
class FakeAutoUpdater extends EventEmitter {
    constructor() {
        super();
        this.autoDownload = null;
        this.autoInstallOnAppQuit = null;
        this.checkCalls = 0;
        this.downloadCalls = 0;
        this.installCalls = 0;
    }
    checkForUpdates() { this.checkCalls++; return Promise.resolve({ updateInfo: {} }); }
    downloadUpdate() { this.downloadCalls++; return Promise.resolve(); }
    quitAndInstall() { this.installCalls++; }
}

function makeController(getAutoUpdatePref) {
    const autoUpdater = new FakeAutoUpdater();
    const states = [];
    const controller = createUpdaterController({
        autoUpdater,
        publish: (state, extra) => states.push({ state, ...extra }),
        getAutoUpdatePref,
    });
    return { autoUpdater, states, controller };
}

test('控制器: autoUpdate 开 → 检查前 autoDownload=true，事件归一为渲染层状态序列', async () => {
    const { autoUpdater, states, controller } = makeController(() => true);
    const p = controller.check();
    assert.equal(autoUpdater.autoDownload, true);
    assert.equal(autoUpdater.checkCalls, 1);
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-available', { version: '0.3.0' });
    autoUpdater.emit('download-progress', { percent: 42.6 });
    autoUpdater.emit('update-downloaded', { version: '0.3.0' });
    await p;
    assert.deepEqual(states, [
        { state: 'checking' },
        { state: 'available', version: '0.3.0' },
        { state: 'downloading', percent: 43 },
        { state: 'downloaded', version: '0.3.0' },
    ]);
    assert.equal(autoUpdater.autoInstallOnAppQuit, true, '退出安装应始终开启');
});

test('控制器: autoUpdate 关 → autoDownload=false 仅提醒；download() 显式下载', async () => {
    const { autoUpdater, states, controller } = makeController(() => false);
    await controller.check();
    assert.equal(autoUpdater.autoDownload, false, '关闭时检查不得静默下载');
    autoUpdater.emit('update-available', { version: '0.3.0' });
    await controller.download();
    assert.equal(autoUpdater.downloadCalls, 1, '手动下载经 downloadUpdate 触发');
    assert.equal(states.some((s) => s.state === 'available' && s.version === '0.3.0'), true);
});

test('控制器: autoUpdate 未设置（默认）→ autoDownload=false，不静默下载', async () => {
    const { autoUpdater, controller } = makeController(() => undefined);
    await controller.check();
    assert.equal(autoUpdater.autoDownload, false, '默认（未显式开启）不得静默下载');
    assert.equal(autoUpdater.autoInstallOnAppQuit, true, '退出安装应始终开启');
});

test('控制器: 检查进行中重复调用复用同一 promise（不并发打更新源）', async () => {
    const { autoUpdater, controller } = makeController(() => true);
    const a = controller.check();
    const b = controller.check();
    assert.equal(a, b, 'in-flight 检查应返回同一 promise');
    await Promise.all([a, b]);
    assert.equal(autoUpdater.checkCalls, 1);
    // 上一次结束后再次检查：重新发起
    await controller.check();
    assert.equal(autoUpdater.checkCalls, 2);
});

test('控制器: error 事件 → publish error 并清除 in-flight（下次检查可重试）', async () => {
    const { autoUpdater, states, controller } = makeController(() => true);
    const p = controller.check();
    autoUpdater.emit('error', new Error('ENOTFOUND api.github.com'));
    await p.catch(() => { });
    assert.equal(states[states.length - 1].state, 'error');
    assert.equal(states[states.length - 1].message, 'ENOTFOUND api.github.com');
    await controller.check();
    assert.equal(autoUpdater.checkCalls, 2, 'error 后 in-flight 已清除，可再次检查');
});

test('控制器: install() 经 quitAndInstall 退出安装', () => {
    const { autoUpdater, controller } = makeController(() => true);
    controller.install();
    assert.equal(autoUpdater.installCalls, 1);
});

test('setupAutoUpdater: 非 Electron 运行时（单测环境）明确返回不可用而非抛错', () => {
    const r = setupAutoUpdater(() => null, {});
    assert.equal(r.enabled, false);
    assert.equal(r.reason, 'no-electron-runtime');
});

test('更新 UI 契约：自动下载默认关 + 更新通知开关 + 失败文案缩短 + CatVod 命名', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const read = (f) => fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
    const html = read('src/renderer/index.html');
    const panels = read('src/renderer/js/panels.js');
    const mainIndex = read('src/main/index.js');

    // 自动下载更新默认关：HTML 默认态不带 checked，回填严格取 === true
    assert.doesNotMatch(html, /id="set_auto_update"[^>]*checked/);
    assert.match(panels, /set_auto_update'\)\.prop\('checked', s\.autoUpdate === true\)/);
    // 自动下载更新下方存在「更新通知」开关（默认开），回填 !== false，且主进程白名单放行持久化
    assert.match(html, /id="set_update_notify"[^>]*checked/);
    assert.match(panels, /set_update_notify'\)\.prop\('checked', s\.updateNotify !== false\)/);
    assert.match(mainIndex, /'updateNotify'/);
    // 更新失败通知只取首行截断（shortUpdateError），不再整串透传 electron-updater 错误
    assert.match(panels, /shortUpdateError/);
    // Bangumi 同步板块开关改称 CatVod 源详情页
    assert.match(html, /CatVod 源详情页自动匹配 Bangumi 数据/);
    assert.doesNotMatch(html, /非 Kazumi 源详情页/);
});
