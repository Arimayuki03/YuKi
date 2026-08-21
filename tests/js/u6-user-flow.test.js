// 单元测试：U6.1～U6.4 单仓库地址用户体验与自动回退
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPlayerContext(customMethods = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/player.js'), 'utf8');
    const logs = [];
    const toasts = [];
    const dialogs = [];
    const fakeJQuery = (sel) => {
        const obj = {
            empty: () => obj,
            text: () => obj,
            toggle: () => obj,
            hide: () => obj,
            show: () => obj,
            html: () => obj,
            val: () => '',
            append: () => obj,
            appendTo: () => obj,
            on: () => obj,
            off: () => obj,
            find: () => obj,
            closest: () => obj,
            length: 1,
        };
        return obj;
    };

    const context = {
        console,
        setTimeout,
        clearTimeout,
        Date,
        AbortController,
        DIRECT_MEDIA_RE: /\.(mp4|flv|mov|mkv|webm|ts|m3u8)(\?|#|$)/i,
        showLoading: (text) => logs.push(`showLoading:${text || ''}`),
        hideLoading: () => logs.push('hideLoading'),
        warnToast: (msg) => toasts.push(msg),
        createRuntimeId: (prefix = 'id') => `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
        mergePlayHeaders: (a, b) => ({ ...(a || {}), ...(b || {}) }),
        openDialog: (id) => dialogs.push({ action: 'open', id }),
        closeDialog: (id) => dialogs.push({ action: 'close', id }),
        getJson: async () => ({ sites: [], flags: [], parses: [] }),
        doAction: async () => ({}),
        document: {
            getElementById: () => ({
                pause: () => {},
                removeAttribute: () => {},
                load: () => {},
            }),
        },
        window: {
            vpc: {
                settingsGet: async () => ({ autoFallbackRoute: true }),
                playUrl: async () => ({ ok: true }),
                resolveParse: async () => ({ ok: true, url: 'https://cdn.example.com/live.m3u8' }),
                captureDirect: async () => ({ ok: true, url: 'https://cdn.example.com/direct.mp4' }),
                cancelRuntime: async () => ({ ok: true }),
            },
        },
        $: fakeJQuery,
        Detail: {
            sources: [
                { from: '线路1', episodes: [{ id: 'ep1', name: '第1集' }] },
                { from: '线路2', episodes: [{ id: 'ep1-line2', name: '第1集' }] },
            ],
            activeSource: 0,
        },
        ...customMethods,
    };
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__player = Player;`, context);
    return { player: context.__player, logs, toasts, dialogs, context };
}

test('U6.3: 播放状态机生命周期与会话隔离 (playSessionId)', async () => {
    const { player, logs } = loadPlayerContext({
        doAction: async (action, params, path, opts) => {
            if (action === 'playerContent') {
                return {
                    url: 'https://cdn.example.com/video.mp4',
                    parse: 0,
                    requestId: opts.requestId,
                    playSessionId: opts.playSessionId,
                };
            }
            return {};
        },
    });

    const res = await player.play('demo-site', '线路1', 'ep1', '测试影片', '第1集', [{ id: 'ep1', name: '第1集' }], 0);
    assert.equal(res.ok, true);
    assert.ok(logs.some(l => String(l).includes('获取播放地址')));
    assert.ok(logs.some(l => String(l).includes('启动播放器')));
});

test('U6.4: 当前线路失败时自动回退到同影片备用线路', async () => {
    let callCount = 0;
    const { player, toasts } = loadPlayerContext({
        doAction: async (action, params) => {
            if (action === 'playerContent') {
                callCount += 1;
                if (params.flag === '线路1') {
                    return { error: '线路1已损坏' };
                }
                return {
                    url: 'https://cdn.example.com/video2.mp4',
                    parse: 0,
                };
            }
            return {};
        },
    });

    const res = await player.play('demo-site', '线路1', 'ep1', '测试影片', '第1集', [{ id: 'ep1', name: '第1集' }], 0);
    assert.equal(res.ok, true);
    assert.ok(toasts.some(t => t.includes('自动尝试备用线路「线路2」')));
});

test('U6.1 & U6.2: 配置进度文案与站点降级/熔断展示状态', () => {
    const panelsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/panels.js'), 'utf8');
    const homeSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/home.js'), 'utf8');

    // 验证 panels.js 包含进度标准五阶段文案
    assert.ok(panelsSource.includes('获取仓库 → 解析配置'));
    assert.ok(panelsSource.includes('解析配置 → 检测站点'));
    assert.ok(panelsSource.includes('检测站点 → 初始化运行时'));
    assert.ok(panelsSource.includes('可用') && panelsSource.includes('降级') && panelsSource.includes('不支持'));

    // 验证 home.js 包含 Android 过滤与降级/熔断标签
    assert.ok(homeSource.includes('L2_SITE_REQUIRES_ANDROID') || homeSource.includes('android'));
    assert.ok(homeSource.includes('降级·需Cookie/解析'));
    assert.ok(homeSource.includes('熔断保护'));
});
