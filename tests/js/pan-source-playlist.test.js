'use strict';
/** 网盘类源禁用原生播放列表（2026-08-26）：
 *  - 主进程 yuki:playlist-build 对网盘源拒绝建队（isPanQueueRequest）；
 *  - 渲染层 play() 提前跳过原生队列分支（isPanQueueSource，正则同口径）；
 *  - Kazumi 规则引擎豁免（规则名含「ali/移动」等子串会误伤）。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const { PAN_SOURCE_RE, isPanQueueRequest } = require('../../src/main/pan-source');

test('pan-source: 站点/线路名命中网盘特征的建队请求被拒', () => {
    // 英文站点名：quark 子串
    assert.equal(isPanQueueRequest({
        kind: 'catvod', site: 'csp_QuarkPan', flag: 'Quark云盘',
        eps: [{ id: 'fid1' }, { id: 'fid2' }],
    }), true);
    // 中文站点名：「夸克云盘」不命中 quark/pan/网盘 任一既有子串，靠「夸克」「云盘」补充捕获
    assert.equal(isPanQueueRequest({
        kind: 'catvod', site: '云盘资源', flag: '夸克云盘',
        eps: [{ id: 'https://pan.quark.cn/s/abc#pwd' }],
    }), true);
});

test('pan-source: 集地址带网盘分享链接 / do=pan 取流协定的建队请求被拒', () => {
    // 站点名干净但集 id 是夸克分享链接
    assert.equal(isPanQueueRequest({
        kind: 'catvod', site: 'csp_clean', flag: '剧情',
        eps: [{ id: 'https://pan.quark.cn/s/abc' }, { id: 'ep2' }],
    }), true);
    // 集 id 是本地 go-proxy 网盘取流地址（do=pan&site=quark）
    assert.equal(isPanQueueRequest({
        kind: 'catvod', site: 'csp_clean', flag: '剧情',
        eps: [{ id: 'http://127.0.0.1:9978/proxy?do=pan&site=quark&shareId=s1&fileId=f1' }],
    }), true);
});

test('pan-source: 普通源不受影响', () => {
    assert.equal(isPanQueueRequest({
        kind: 'catvod', site: 'csp_douban', flag: '剧情',
        eps: [{ id: '/detail/1' }, { id: '/detail/2' }],
    }), false);
    assert.equal(isPanQueueRequest(undefined), false);
    assert.equal(isPanQueueRequest({}), false);
});

test('pan-source: Kazumi 规则引擎豁免——规则名含 ali/移动 不误伤', () => {
    assert.equal(isPanQueueRequest({
        kind: 'kazumi', site: 'kazumi:阿里嘎多', flag: '',
        eps: [{ id: 'mov-id-1' }, { id: 'mov-id-2' }],
    }), false);
    assert.equal(isPanQueueRequest({
        kind: 'kazumi', site: 'kazumi:移动番剧', flag: '',
        eps: [{ id: 'ep1' }],
    }), false);
});

test('pan-source: PAN_SOURCE_RE 与主进程 isDynamicProxyStream 消费同一常量', () => {
    // 回归锚点：index.js 的边下边播排除与建队排除必须同源演化。
    const mainIndex = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
    assert.ok(mainIndex.includes("require('./pan-source')"),
        'index.js 应引入共享网盘识别模块');
    assert.ok(/isPanQueueRequest\(q\)/.test(mainIndex),
        'yuki:playlist-build 应对网盘源拒绝建队');
    assert.ok(mainIndex.includes("reason: 'pan-source'"),
        '拒绝原因应标记为 pan-source');
    assert.ok(!mainIndex.includes('isPanSource'),
        '陈旧的 isPanSource 引用应已清理（该排除从未实现过）');
    assert.match(String(PAN_SOURCE_RE.source), /夸克/, '正则须含中文「夸克」特征');
});

function loadPlayer(opts = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/player.js'), 'utf8');
    const jqueryStub = () => ({ on() { return this; }, text() { return ''; }, show() { return this; }, hide() { return this; } });
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, parseInt, parseFloat,
        setTimeout, clearTimeout, URL,
        getJson: async () => ({ parses: [], flags: [] }),
        warnToast: () => {},
        showLoading: () => {}, hideLoading: () => {},
        Detail: opts.detail,
        window: { yuki: { settingsGet: async () => (opts.settings || {}) } },
    };
    context.$ = jqueryStub;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__Player = Player; globalThis.__isPanQueueSource = isPanQueueSource;`,
        context, { filename: 'player.js' });
    return context;
}

function loadPlayerHelpers() {
    return loadPlayer().__isPanQueueSource;
}

test('渲染层 isPanQueueSource 与主进程同口径：夸克源跳过原生队列、Kazumi 豁免', () => {
    const isPanQueueSource = loadPlayerHelpers();
    const eps = [{ name: '第1集', url: 'fid1' }, { name: '第2集', url: 'fid2' }];
    assert.equal(isPanQueueSource('csp_QuarkPan', 'Quark云盘', eps), true);
    assert.equal(isPanQueueSource('csp_clean', '剧情',
        [{ name: '第1集', url: 'https://pan.quark.cn/s/x' }]), true);
    assert.equal(isPanQueueSource('csp_douban', '剧情', eps), false);
    // Kazumi 豁免：site 前缀 kazumi: 时即使名字含 ali/移动 也放行
    assert.equal(isPanQueueSource('kazumi:阿里嘎多', '', eps), false);
    assert.equal(isPanQueueSource('kazumi:移动番剧', '', eps), false);
});

test('网盘源播放失败不触发自动线路回退（转存风暴修复）', async () => {
    // 回归背景：逐集链路失去队列路径的静默收口后，播放失败会走 U6.4
    // 自动换线路——每次回退对同一夸克分享再打一轮完整解析链（含
    // sharepage/save），与后端重试循环叠加把临时风控打成持续 403。
    const detail = {
        sources: [
            { from: '线路1', episodes: [{ name: '第1集', url: 'e1' }] },
            { from: '线路2', episodes: [{ name: '第1集', url: 'e2' }] },
        ],
        activeSource: 0,
    };
    const player = loadPlayer({ detail }).__Player;
    let playCalls = 0;
    player.play = async () => { playCalls += 1; return { ok: true }; };

    const panPb = { site: 'csp_QuarkPan', flag: '夸克云盘', id: 'e1', title: 'T',
        subtitle: '', episodes: [{ name: '第1集', url: 'e1' }], epIndex: 0 };
    const r1 = await player._tryFallbackRoute(panPb, 'mpv 播放失败', {});
    assert.equal(r1, null, '网盘源必须直接收口，不发起线路回退');
    assert.equal(playCalls, 0, '网盘源回退不得再次起播');
    assert.equal(detail.activeSource, 0, '网盘源回退不得切换线路游标');

    const normalPb = { site: 'csp_demo', flag: '剧情', id: 'e1', title: 'T',
        subtitle: '', episodes: [{ name: '第1集', url: 'e1' }], epIndex: 0 };
    const r2 = await player._tryFallbackRoute(normalPb, 'mpv 播放失败', {});
    assert.equal(playCalls, 1, '普通源仍应正常尝试备用线路');
    assert.ok(r2 && r2.ok);
});
