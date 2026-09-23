/**
 * 白盒单元测试：src/renderer/js/live.js
 *
 * 渲染层脚本不是 CommonJS（<script> 顺序加载共享全局作用域），沿用
 * tests/js/records.test.js 的做法：fs.readFileSync + node:vm，在注入全局桩的
 * 上下文里执行源码，再从 globalThis 取出 Live / liveFitPageSize 直接驱动。
 *
 * 覆盖目标：
 *   - liveFitPageSize：不同容器宽高下的列数/行数计算与下限钳制、缺 DOM 回退、
 *     NaN/0/负数等脏入参
 *   - normalizeLive：非 http(s) / proxy:// 坏 base64 / 空条目一律剔除（含 URL 透传）
 *   - parseTxt / parseM3u：分组与频道解析、多地址保留、非法行跳过
 *   - load：/sites 展平、自定义源并入、无源时提示态、选项渲染与转义
 *   - renderGroups / renderList：分组标签、分页切片、data-idx 指向原始下标
 *   - 播放：取首地址透传给 window.yuki.playUrl 并带 live 源标记
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const LIVE_SRC = path.join(__dirname, '../../src/renderer/js/live.js');

/** 与 common.js escHtml 同实现的转义桩（H-6：含单引号）。 */
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 记录型 jQuery 桩：登记事件处理器、操作流水、val 值，供断言。 */
function makeJQueryStub() {
    const reg = new Map();
    const values = new Map();
    const rec = (sel) => {
        let r = reg.get(sel);
        if (!r) { r = { handlers: {}, ops: [], data: {} }; reg.set(sel, r); }
        return r;
    };
    class W {
        constructor(sel) { this.sel = String(sel); this.length = 1; }
        on(ev, a, b) {
            const r = rec(this.sel);
            const fn = typeof a === 'function' ? a : b;
            (r.handlers[ev] = r.handlers[ev] || []).push({ delegate: typeof a === 'string' ? a : null, fn });
            return this;
        }
        off() { return this; }
        addClass() { return this; }
        removeClass() { return this; }
        toggleClass() { return this; }
        toggle(f) { rec(this.sel).ops.push(['toggle', !!f]); return this; }
        show() { return this.toggle(true); }
        hide() { return this.toggle(false); }
        text(t) { rec(this.sel).ops.push(['text', t]); return this; }
        html(h) { rec(this.sel).ops.push(['html', h]); return this; }
        empty() { rec(this.sel).ops.push(['empty']); return this; }
        val(v) {
            if (v === undefined) return values.has(this.sel) ? values.get(this.sel) : '';
            values.set(this.sel, v);
            rec(this.sel).ops.push(['val', v]);
            return this;
        }
        append(h) { rec(this.sel).ops.push(['append', h]); return this; }
        appendTo() { return this; }
        find() { return this; }
        each() { return this; }
        data(k) { return rec(this.sel).data[k]; }
        trigger(ev) {
            (rec(this.sel).handlers[ev] || []).forEach((h) => h.fn.call({}, { currentTarget: {} }));
            return this;
        }
    }
    const $ = (sel) => ((sel && typeof sel === 'object') ? sel : new W(sel));
    $.setVal = (sel, v) => { values.set(sel, v); };
    $.fire = (sel, ev, evt) => {
        const r = reg.get(sel);
        assert.ok(r && r.handlers[ev], `应已绑定 ${sel} 的 ${ev} 处理器`);
        r.handlers[ev].forEach((h) => h.fn.call({}, evt));
    };
    $.opsOf = (sel) => rec(sel).ops;
    $.lastHtml = (sel) => {
        const hs = rec(sel).ops.filter((o) => o[0] === 'html');
        return hs.length ? hs[hs.length - 1][1] : null;
    };
    $.allHtml = (sel) => rec(sel).ops.filter((o) => o[0] === 'append' || o[0] === 'html').map((o) => o[1]).join('\n');
    $.lastText = (sel) => {
        const ts = rec(sel).ops.filter((o) => o[0] === 'text');
        return ts.length ? ts[ts.length - 1][1] : null;
    };
    return $;
}

/**
 * 在 VM 中加载 live.js。
 * opts: { box: 容器尺寸桩（{clientWidth, rectTop}），win: 窗口尺寸，
 *         pageSize, sites, settings, doAction }
 */
function loadLive(opts) {
    const o = opts || {};
    const $ = makeJQueryStub();
    const state = {
        $, plays: [], toasts: [], pager: [], pageSizeKeys: [],
        settingsSets: [], doActions: [], nextPlay: null, setNextPlay: (r) => { state.nextPlay = r; },
        win: o.win || { innerWidth: 1280, innerHeight: 800 },
    };
    // 容器尺寸桩：缺省视为无 #live-list 元素（走 window.innerWidth 回退）
    const box = o.box === null ? null : (o.box || { clientWidth: 1280, rectTop: 100 });

    const settings = Object.assign({}, o.settings || {});
    const sites = o.sites || { lives: [] };

    // 直接用宿主的真实 URL 构造器：live.js 只在 _asciiUrl 内使用它（依赖
    // new URL(...).href 做 IDN punycode 转换），之前的 URLStub 丢 port/query/hash
    // 且不做 IDN，会让 _asciiUrl 的核心职责零有效覆盖、钉住与生产相反的行为。
    const context = {
        console, setTimeout, clearTimeout, JSON, Math, Object, Array, String, Promise,
        parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
        URL,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        document: { getElementById: (id) => (id === 'live-list' ? box : null) },
        window: {
            get innerWidth() { return state.win.innerWidth; },
            get innerHeight() { return state.win.innerHeight; },
            yuki: {
                settingsGet: async () => JSON.parse(JSON.stringify(settings)),
                settingsSet: async (k, v) => { settings[k] = JSON.parse(JSON.stringify(v)); state.settingsSets.push(k); },
                playUrl: async (url, meta) => {
                    state.plays.push({ url, meta });
                    if (state.nextPlay !== null) { const r = state.nextPlay; state.nextPlay = null; return r; }
                    return { ok: true };
                },
            },
        },
        $,
        escHtml,
        warnToast: (t) => { state.toasts.push(String(t)); },
        showLoading: () => {}, hideLoading: () => {},
        getJson: async () => JSON.parse(JSON.stringify(sites)),
        doAction: async (act, args) => {
            state.doActions.push({ act, args });
            if (o.doAction) return o.doAction(act, args);
            return { text: '' };
        },
        pageSizeOf: async (key) => { state.pageSizeKeys.push(key); return o.pageSize || 0; },
        renderPagerBox: (b, po) => { state.pager.push({ sel: b && b.sel, page: po.page, pagecount: po.pagecount, onJump: po.onJump }); },
        renderStatusBar: () => {},
    };
    if (box && typeof box.getBoundingClientRect !== 'function') {
        box.getBoundingClientRect = () => ({ top: box.rectTop });
    }
    vm.createContext(context);
    vm.runInContext(`${fs.readFileSync(LIVE_SRC, 'utf8')}\n;globalThis.__Live = Live; globalThis.__fit = liveFitPageSize;`,
        context, { filename: 'live.js' });
    state.Live = context.__Live;
    state.fit = context.__fit;
    state.settings = settings;
    return state;
}

/** 设置容器宽与视口高，返回 liveFitPageSize()。 */
function fitWith(clientWidth, rectTop, win) {
    const h = loadLive({ box: { clientWidth, rectTop }, win: win || { innerWidth: 1280, innerHeight: 800 } });
    return h.fit();
}

const flush = () => new Promise((r) => setImmediate(r));

/**
 * 跨 VM 原型域断言：vm 上下文里的 Array/Object 与宿主的不是同一个原型，
 * node:assert/strict 的 deepEqual 会因原型不等而失败（结构完全相同也报错）。
 * 先过一次 JSON 转成宿主对象再比（ src/lib/common.js 的同名导出亦可，此处只用基本一致）。
 */
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

const TXT = [
    '央视频道,#genre#',
    'CCTV-1,http://a.example/1.m3u8,http://b.example/1.m3u8',
    'CCTV-2,http://a.example/2.m3u8',
    '地方台,#genre#',
    '湖南卫视,rtmp://c.example/live/hunan',
    '无效行没有逗号',
    '空地址台,',
    '非协议地址台,ftp://x/y',
    '',
].join('\n');

const M3U = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="央视频道",CCTV-1',
    'http://a.example/1.m3u8',
    '#EXTINF:-1 group-title="地方台",湖南卫视',
    'http://c.example/hunan.m3u8',
    '#EXTINF:-1,无分组台',
    'not-a-url',
    '#EXTINF:-1 group-title="剧集",剧集台',
    'rtsp://d.example/series',
].join('\n');

// ---------------------------------------------------------------- liveFitPageSize

test('liveFitPageSize：按容器宽算列数、按视口剩余高算行数，乘积即每页条数', () => {
    // 宽 1280 → floor((1280+10)/230)=5 列；top=100，高 800 → floor(700/55)=12 行
    assert.equal(fitWith(1280, 100), 60);
    // 宽 450 → floor(460/230)=2 列；top=0，高 800 → floor(800/55)=14 行
    assert.equal(fitWith(450, 0), 28);
    // 宽 230 → floor(240/230)=1 列；高 300 → floor(300/55)=5 行
    assert.equal(fitWith(230, 0, { innerWidth: 320, innerHeight: 300 }), 5);
});

test('liveFitPageSize：极窄容器列数钳到 1、极矮视口行数钳到 3（下限保护）', () => {
    // 窄容器 100px：floor(110/230)=0 → 钳到 1 列；top=0，高 800 → floor(800/55)=14 行
    assert.equal(fitWith(100, 0), 14);
    // 视口只剩 100px：floor(100/55)=1 → 钳到 3 行；floor(1010/230)=4 列
    assert.equal(fitWith(1000, 700, { innerWidth: 1024, innerHeight: 800 }), 12);
    // top 超过 innerHeight（剩余高为负）：行数仍钳到 3
    assert.equal(fitWith(1000, 2000, { innerWidth: 1024, innerHeight: 800 }), 12);
    // 负宽度：floor((-500+10)/230) 为负 → 钳到 1 列
    assert.equal(fitWith(-500, 0), 14);
});

test('liveFitPageSize：脏入参（falsy 宽/NaN/undefined）走 window 兜底而不产出 NaN', () => {
    // clientWidth 为 0/NaN/undefined 时均 falsy → 回退 window.innerWidth（1280 → 5 列 × 14 行）
    assert.equal(fitWith(0, 0), 70, '宽 0 回退窗口宽');
    assert.equal(fitWith(NaN, 0), 70, '宽 NaN 回退窗口宽');
    assert.equal(fitWith(undefined, 0), 70, '宽 undefined 回退窗口宽');
    // top 为负：剩余高 = 800-(-200)=1000 → floor(1000/55)=18 行 × 5 列
    assert.equal(fitWith(1280, -200), 90);
    // top 超过 innerHeight（剩余高为负）：行数钳到下限 3（5 列 × 3 行）
    assert.equal(fitWith(1280, 1200), 15);
    assert.ok(Number.isFinite(fitWith(1280, -200)), '必须产出有限数');
});

test('liveFitPageSize：无 #live-list 容器时回退 window 宽且 top 视作 0', () => {
    const h = loadLive({ box: null, win: { innerWidth: 920, innerHeight: 660 } });
    // floor((920+10)/230)=4 列；floor(660/55)=12 行
    assert.equal(h.fit(), 48);
    // 视口高极小：行数钳到 3
    const h2 = loadLive({ box: null, win: { innerWidth: 1280, innerHeight: 60 } });
    assert.equal(h2.fit(), 15, '5 列 × 3 行（下限）');
});

test('liveFitPageSize：DOM 取值抛异常时回退默认 108', () => {
    const h = loadLive({ box: { get clientWidth() { throw new Error('boom'); }, rectTop: 0 } });
    assert.equal(h.fit(), 108);
});

// ---------------------------------------------------------------- 直播源归一化

test('normalizeLive：http/https 源保留，非 http(s) 与空条目一律剔除', () => {
    const { Live } = loadLive();
    assert.deepEqual(Live.normalizeLive({ name: '源甲', url: 'https://a.example/live.txt' }).url,
        'https://a.example/live.txt', 'URL 原样透传');
    assert.equal(Live.normalizeLive({ url: 'http://b.example/live.m3u' }).name,
        'http://b.example/live.m3u', '缺 name 时用 URL 兜底');
    assert.equal(Live.normalizeLive({ name: 'ftp', url: 'ftp://x/y.txt' }), null);
    assert.equal(Live.normalizeLive({ name: '无 url', url: '' }), null);
    assert.equal(Live.normalizeLive(null), null);
    assert.equal(Live.normalizeLive(undefined), null);
});

test('normalizeLive：proxy:// TVBox 源解 base64 还原真实地址', () => {
    const { Live } = loadLive();
    const real = 'https://raw.example/live.txt';
    const proxy = 'proxy://do=live&ext=' + encodeURIComponent(Buffer.from(real).toString('base64'));
    const got = Live.normalizeLive({ name: 'TVBox源', url: proxy });
    assert.ok(got, '合法 proxy 源应解析成功');
    assert.equal(got.url, real);
    assert.equal(got.name, 'TVBox源');
});

test('normalizeLive：proxy:// 缺 ext 或 base64 非法时剔除（不产出坏地址）', () => {
    const { Live } = loadLive();
    assert.equal(Live.normalizeLive({ name: '缺ext', url: 'proxy://do=live' }), null);
    assert.equal(Live.normalizeLive({ name: '坏base64', url: 'proxy://do=live&ext=!!!not-base64!!!' }), null);
    assert.equal(Live.normalizeLive({ name: '非http内容', url: 'proxy://do=live&ext=' + Buffer.from('ftp://x/y').toString('base64') }), null);
});

test('_asciiUrl：中文域名（IDN）转 punycode，非法 URL 原样返回不抛异常', () => {
    const { Live } = loadLive();
    // 真实 Node/Electron 下 new URL(...).href 会做 punycode 转换（后端拉取需要 ASCII），
    // 这是 _asciiUrl 存在的核心目的；用真实 URL 构造器后该行为可被测试有效覆盖。
    assert.equal(Live._asciiUrl('https://中文.example/live.txt'), 'https://xn--fiq228c.example/live.txt');
    assert.equal(Live._asciiUrl('不是URL'), '不是URL');
    // 带 port/query 的 URL 应保留完整（URLStub 之前会静默截断）
    assert.equal(Live._asciiUrl('http://a.example:8080/p?q=1#f'), 'http://a.example:8080/p?q=1#f');
});

// ---------------------------------------------------------------- 解析

test('parseTxt：按「组名,#genre#」分组，频道多地址全保留且首地址即播放地址', () => {
    const { Live } = loadLive();
    const list = Live.parseTxt(TXT);
    assert.equal(list.length, 3, '只解析出 3 个有效频道（无效行/空地址/非协议行跳过）');
    assert.deepEqual(plain(list.map((c) => c.group)), ['央视频道', '央视频道', '地方台']);
    assert.equal(list[0].name, 'CCTV-1');
    assert.deepEqual(plain(list[0].urls), ['http://a.example/1.m3u8', 'http://b.example/1.m3u8']);
    assert.equal(list[0].url, 'http://a.example/1.m3u8', 'url 取首地址');
    assert.equal(list[2].name, '湖南卫视');
    assert.equal(list[2].url, 'rtmp://c.example/live/hunan', 'rtmp 地址合法');
    assert.ok(!list.some((c) => c.name === '无效行没有逗号'), '无逗号行跳过');
    assert.ok(!list.some((c) => c.name === '空地址台'), '空地址行跳过');
});

test('parseTxt：无分组头的频道归入「未分组」，空文本返回空数组', () => {
    const { Live } = loadLive();
    const list = Live.parseTxt('单台,http://x/1.m3u8');
    assert.equal(list.length, 1);
    assert.equal(list[0].group, '未分组');
    assert.deepEqual(plain(Live.parseTxt('')), []);
    assert.deepEqual(plain(Live.parseTxt(null)), []);
});

test('parseM3u：按 group-title 分组，地址行非协议时跳过且不误配下一个频道', () => {
    const { Live } = loadLive();
    const list = Live.parseM3u(M3U);
    assert.equal(list.length, 3);
    assert.deepEqual(plain(list.map((c) => c.name)), ['CCTV-1', '湖南卫视', '剧集台']);
    assert.deepEqual(plain(list.map((c) => c.group)), ['央视频道', '地方台', '剧集']);
    assert.equal(list[0].url, 'http://a.example/1.m3u8');
    assert.deepEqual(plain(list[2].urls), ['rtsp://d.example/series'], 'rtsp 合法');
    assert.ok(!list.some((c) => c.name === '无分组台'), '地址非协议（not-a-url）的频道跳过');
    const noGroup = Live.parseM3u('#EXTINF:-1,裸台\nhttp://x/1.m3u8');
    assert.equal(noGroup[0].group, '未分组', '无 group-title 归未分组');
});

// ---------------------------------------------------------------- load 装配

test('load：/sites 的嵌套 lives 展平后与自定义源一并装入下拉，选项名经转义', async () => {
    const h = loadLive({
        sites: { lives: [{ name: '组源', url: 'https://x/group', channels: [{ name: '子源甲', urls: ['https://x/1.txt'] }, { name: '子源乙', urls: ['https://y/2.txt', 'https://y/3.txt'] }] }, { name: '普通源', url: 'https://z/plain.txt' }, { name: '坏源', url: 'ftp://bad/x' }] },
        settings: { customLives: ['https://c/self.txt', { name: '自定义甲', url: 'https://c/named.txt' }] },
    });
    await h.Live.load({});
    assert.deepEqual(plain(h.Live.lives.map((l) => l.url)),
        ['https://x/1.txt', 'https://y/2.txt', 'https://y/3.txt', 'https://z/plain.txt', 'https://c/self.txt', 'https://c/named.txt'],
        '嵌套展平 + 坏源剔除 + 纯 URL 与 {name,url} 两种自定义源都并入');
    assert.equal(h.Live.lives[0].name, '子源甲', '嵌套条目优先用频道名');
    assert.equal(h.Live.lives[4].name, 'https://c/self.txt', '纯 URL 自定义源用 URL 作名');
    assert.equal(h.Live.lives[5].name, '自定义甲');
    const opts = h.$.allHtml('#live-select');
    assert.ok(opts.includes('>子源甲</option>'));
    assert.ok(opts.includes('>自定义甲</option>'));
    assert.ok(!opts.includes('坏源'), '坏源不进下拉');
});

test('load：列表源名含 HTML 时选项转义（不注入下拉）', async () => {
    const h = loadLive({ sites: { lives: [{ name: '<img src=x onerror=alert(1)>', url: 'https://x/a.txt' }] } });
    await h.Live.load({});
    const opts = h.$.allHtml('#live-select');
    assert.ok(!/<img src=x/.test(opts), '源名必须转义');
    assert.ok(opts.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('load：无有效直播源时渲染可操作空态提示并清空分组栏', async () => {
    const h = loadLive({ sites: { lives: [{ name: '坏源', url: 'ftp://bad/x' }] } });
    await h.Live.load({});
    assert.deepEqual(plain(h.Live.lives), []);
    assert.ok(h.$.allHtml('#live-select').includes('（无直播源）'));
    const tip = h.$.lastHtml('#live-list');
    assert.ok(tip && tip.includes('tip-line'), '应给出提示行');
    assert.ok(tip.includes('直播源'), '提示应说明如何添加直播源');
    assert.deepEqual(plain(h.doActions), [], '无源时不发起文本拉取');
});

test('loadChannels：m3u 源按扩展名走 parseM3u，频道列表与分组就绪后渲染', async () => {
    const h = loadLive({
        sites: { lives: [{ name: 'M3U源', url: 'https://x/live.m3u' }] },
        doAction: async () => ({ text: M3U }),
        pageSize: 5,
    });
    await h.Live.load({});
    assert.equal(h.doActions.length, 1);
    assert.deepEqual(plain(h.doActions[0]), { act: 'fetchText', args: { url: 'https://x/live.m3u' } });
    assert.equal(h.Live.channels.length, 3, '走 M3U 解析');
    assert.deepEqual(plain(h.Live.channels.map((c) => c.name)), ['CCTV-1', '湖南卫视', '剧集台']);
    assert.deepEqual(plain(h.pageSizeKeys), ['pageSizeLive']);
    assert.equal(h.Live._pageSize, 5);
    assert.equal(h.Live._page, 1, '载入后回到第 1 页');
    const groups = h.$.lastHtml('#live-groups');
    assert.ok(groups.includes('data-group=""'), '分组栏含「全部」');
    assert.ok(groups.includes('>央视频道</span>'));
    assert.ok(groups.includes('>地方台</span>'));
});

test('loadChannels：txt 源返回网页 HTML 时给出「非直播源」可操作提示', async () => {
    const h = loadLive({
        sites: { lives: [{ name: '假源', url: 'https://x/page.txt' }] },
        doAction: async () => ({ text: '<!DOCTYPE html><html><body>hi</body></html>' }),
    });
    await h.Live.load({});
    assert.deepEqual(plain(h.Live.channels), []);
    const tip = h.$.lastHtml('#live-list');
    assert.ok(tip.includes('网页而非直播源'), '应提示这是网页不是直播源');
});

test('loadChannels：拉取失败时渲染「直播源载入失败」提示', async () => {
    const h = loadLive({
        sites: { lives: [{ name: '坏源', url: 'https://x/dead.txt' }] },
        doAction: async () => { throw new Error('network down'); },
    });
    await h.Live.load({});
    assert.equal(h.$.lastHtml('#live-list'), '<div class="tip-line">直播源载入失败</div>');
});

// ---------------------------------------------------------------- 渲染与分页

test('renderList：按每页条数切片，data-idx 指向 channels 原始下标（切分组后仍对得上）', () => {
    const h = loadLive();
    const L = h.Live;
    L.channels = [
        { group: '央视频道', name: 'CCTV-1', url: 'http://a/1' },
        { group: '央视频道', name: 'CCTV-2', url: 'http://a/2' },
        { group: '地方台', name: '湖南卫视', url: 'http://c/hunan' },
        { group: '地方台', name: '浙江卫视', url: 'http://c/zj' },
        { group: '地方台', name: '江苏卫视', url: 'http://c/js' },
    ];
    L._pageSize = 2;
    L.group = '地方台';
    L._page = 1;
    L.renderList();
    const html = h.$.lastHtml('#live-list');
    assert.ok(!html.includes('CCTV-1') && !html.includes('CCTV-2'), '按分组过滤掉央视频道');
    assert.ok(html.includes('湖南卫视') && html.includes('浙江卫视'), '只渲染第 1 页 2 条');
    assert.ok(!html.includes('江苏卫视'), '第 3 条留到第 2 页');
    assert.ok(html.includes('data-idx="2"'), '湖南卫视在原始 channels 中的下标是 2');
    assert.ok(html.includes('data-idx="3"'), '浙江卫视下标是 3');
    const p = h.pager[h.pager.length - 1];
    assert.equal(p.pagecount, 2, '3 条 / 每页 2 条 = 2 页');
    p.onJump(2);
    assert.equal(L._page, 2);
    const page2 = h.$.lastHtml('#live-list');
    assert.ok(page2.includes('江苏卫视') && !page2.includes('湖南卫视'));
    assert.ok(page2.includes('data-idx="4"'), '翻页后仍用原始下标');
});

test('renderList：分组下无频道时给出「该分组下没有频道」并清空分页器', () => {
    const h = loadLive();
    const L = h.Live;
    L.channels = [{ group: '央视频道', name: 'CCTV-1', url: 'http://a/1' }];
    L.group = '地方台';
    L._pageSize = 10;
    L.renderList();
    assert.equal(h.$.lastHtml('#live-list'), '<div class="tip-line">该分组下没有频道</div>');
    assert.equal(h.pager.length, 0, '无频道时不渲染分页器');
});

test('renderGroups：分组标签去重且当前选中分组标 active，分组名转义', () => {
    const h = loadLive();
    const L = h.Live;
    L.channels = [
        { group: '央视频道', name: 'A', url: 'http://a/1' },
        { group: '央视频道', name: 'B', url: 'http://a/2' },
        { group: '<img src=x>', name: 'C', url: 'http://c/1' },
    ];
    L.group = '<img src=x>';
    L.renderGroups();
    const html = h.$.lastHtml('#live-groups');
    assert.equal((html.match(/data-group="/g) || []).length, 3, '全部 + 两个去重分组');
    assert.equal((html.match(/data-group="央视频道"/g) || []).length, 1, '重复分组只出一枚标签');
    assert.ok(html.includes('class="class-tab active" data-group="&lt;img src=x&gt;"'), '当前分组标 active 且转义');
    assert.ok(!/<img src=x>/.test(html), '分组名不得注入标签');
});

test('页码越界：_page 大于总页数时被钳回末页（不会出现空白页）', () => {
    const h = loadLive();
    const L = h.Live;
    L.channels = Array.from({ length: 7 }, (_, i) => ({ group: 'G', name: `台${i}`, url: `http://a/${i}` }));
    L._pageSize = 3;
    L._page = 99;
    L.renderList();
    assert.equal(L._page, 3, '7 条 / 每页 3 条 = 3 页，越界回末页');
    const html = h.$.lastHtml('#live-list');
    assert.ok(html.includes('台6'), '末页应有数据');
});

// ---------------------------------------------------------------- 播放

test('点击频道：取首地址透传给 window.yuki.playUrl 并带 live 源标记与副标题', async () => {
    const h = loadLive();
    const L = h.Live;
    L.init();
    L.channels = [
        { group: '央视频道', name: 'CCTV-1', url: 'http://a/1.m3u8', urls: ['http://a/1.m3u8', 'http://b/1.m3u8'] },
        { group: '未分组', name: '裸台', url: 'http://c/bare.m3u8' },
    ];
    const el = (idx) => ({ data: (k) => (k === 'idx' ? String(idx) : undefined) });
    h.$.fire('#live-list', 'click', { currentTarget: el(0) });
    await flush();
    assert.equal(h.plays.length, 1);
    assert.equal(h.plays[0].url, 'http://a/1.m3u8', '多地址时取首地址');
    assert.deepEqual(plain(h.plays[0].meta), { title: 'CCTV-1', subtitle: '央视频道', source: 'live' });

    // 无 urls 数组时退回 url 字段；group 为「未分组」时不带副标题
    h.$.fire('#live-list', 'click', { currentTarget: el(1) });
    await flush();
    assert.equal(h.plays[1].url, 'http://c/bare.m3u8');
    assert.deepEqual(plain(h.plays[1].meta), { title: '裸台', subtitle: '', source: 'live' });
});

test('点击频道：下标越界/非法时不发起播放（脏 data-idx 兜底）', async () => {
    const h = loadLive();
    const L = h.Live;
    L.init();
    L.channels = [{ group: 'G', name: 'A', url: 'http://a/1' }];
    const el = (idx) => ({ data: (k) => (k === 'idx' ? idx : undefined) });
    h.$.fire('#live-list', 'click', { currentTarget: el('99') });
    h.$.fire('#live-list', 'click', { currentTarget: el('abc') });
    h.$.fire('#live-list', 'click', { currentTarget: el(undefined) });
    await flush();
    assert.deepEqual(plain(h.plays), [], '越界/非法下标不应播放');
});

test('播放结果：mpv 缺失/解析失败给出对应文案，外部播放器 launched 视为成功', async () => {
    const h = loadLive();
    const L = h.Live;
    L.init();
    const el = { data: (k) => (k === 'idx' ? '0' : undefined) };
    const cases = [
        [{ reason: 'mpv-missing' }, '直播播放失败：mpv 未安装（node scripts/download-binaries.js mpv）'],
        [{ reason: 'resolve-failed' }, '直播播放失败：频道地址解析失败，换条线路试试'],
        [{ reason: 'empty playlist' }, '直播播放失败：频道地址无效'],
        [{ ok: false }, '直播播放失败'],
        [{ ok: true }, '正在播放：A'],
        [{ ok: false, launched: true, viaExternal: true }, '已交外部播放器播放：A'],
    ];
    for (const [res, expect] of cases) {
        L.channels = [{ group: 'G', name: 'A', url: 'http://a/1' }];
        h.setNextPlay(res);
        h.$.fire('#live-list', 'click', { currentTarget: el });
        await flush();
        assert.equal(h.toasts[h.toasts.length - 1], expect,
            `playUrl 返回 ${JSON.stringify(res)} 时应提示「${expect}」`);
    }
    assert.ok(L._inited);
});
