/**
 * 本地文件多选 + 同类命名播放列表 单元测试。
 *
 * 覆盖对象：
 *  - panels.js：toggleSelMode / toggleSel / selectAllLocal / collectSelPaths /
 *    delSelected / playSelected / epAnchorOf / parseEpNum / isNoiseNumber /
 *    groupSameSeries / pushFile 组列表分支 / buildDirItem·buildFileItem·buildVideoCard
 *    的 sel-mode 勾选框渲染
 *  - common.js CSP 桥接白名单必须包含 toggleSel（动态勾选框点击依赖桥接放行）
 *
 * 加载方式同 panels-local.test.js：fs.readFileSync + node:vm 注入全局桩执行经典脚本。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('node:path');
const vm = require('node:vm');

const PANELS_SRC = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/panels.js'), 'utf8');

// ---------------------------------------------------------------- 全局桩（panels-local.test.js 同款精简版）

function makeJq(sel, log) {
    const rec = { sel, html: [], text: [], append: [], prop: {}, show: 0, hide: 0, toggle: [], scrollTop: [] };
    (log || []).push(rec);
    const jq = {
        __rec: rec, length: 1,
        html(v) { rec.html.push(v); return jq; },
        text(v) { rec.text.push(String(v)); return jq; },
        append(v) { rec.append.push(v); return jq; },
        prop(k, v) { rec.prop[k] = v; return jq; },
        empty() { rec.html.push(''); return jq; },
        show() { rec.show++; return jq; },
        hide() { rec.hide++; return jq; },
        scrollTop(v) { rec.scrollTop.push(v); return jq; },
        toggle(v) { rec.toggle.push(!!v); return jq; },
        each() { return jq; }, find() { return jq; }, on() { return jq; }, off() { return jq; },
        val() { return ''; }, data() { return ''; }, closest() { return jq; },
        removeClass() { return jq; }, addClass() { return jq; }, toggleClass() { return jq; },
        css() { return jq; }, attr() { return jq; }, removeAttr() { return jq; }, trigger() { return jq; },
    };
    return jq;
}

function buildContext(opts) {
    const o = opts || {};
    const jqLog = o.jqLog || [];
    const toasts = o.warnToasts || [];
    const yuki = Object.assign({
        settingsGet: async () => ({}),
        settingsSet: async () => {},
        fileList: async () => ({ path: '', parent: '.', files: [] }),
        fileThumb: async () => ({ ok: false }),
        filePush: async () => ({ ok: false, reason: 'mpv-missing' }),
        filePushMany: async () => ({ ok: false, reason: 'mpv-missing' }),
        fileDelMany: async () => ({ ok: true, results: [], failed: 0 }),
        filePickRoot: async () => ({ ok: false }),
        fileOpenDir: async () => ({ ok: false }),
    }, o.yuki || {});
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Number, Object, Boolean,
        parseInt, parseFloat, isNaN, isFinite, RegExp, Error, TypeError,
        setTimeout, clearTimeout, setImmediate, URL, encodeURIComponent, decodeURIComponent,
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        $: (sel) => makeJq(sel, jqLog),
        document: {
            getElementById: (id) => ((o.docElements || {})[id] || null),
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
            querySelector: () => null, addEventListener() {}, removeEventListener() {},
        },
        window: { yuki },
        escPath: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        warnToast: (m) => { toasts.push(String(m)); },
        showLoading: (o.onShowLoading || (() => {})),
        hideLoading: (o.onHideLoading || (() => {})),
        openDialog: () => {}, closeDialog: () => {},
        confirmDialog: o.confirmDialog || (async () => true),
        registerEsc: () => {},
        localPlayToast: (r) => { toasts.push('play-toast:' + JSON.stringify(r)); },
        createRuntimeId: (p) => `${p}-test`,
        CSS: { escape: (s) => String(s) },
    };
    Object.assign(context, o.extra || {});
    context.globalThis = context;
    return { context, jqLog, toasts, yuki };
}

const EXPORT_TAIL = `
;globalThis.__t = {
  isLocalVideo, isLocalAudio,
  buildParentItem, buildDirItem, buildFileItem, buildVideoCard,
  toggleSelMode, toggleSel, selectAllLocal, collectSelPaths, delSelected, playSelected, updateSelCount,
  epAnchorOf, parseEpNum, isNoiseNumber, groupSameSeries, pushFile, renderLocalPage,
  get _localPage() { return _localPage; },
  set _localPage(v) { _localPage = v; },
  get _localPageNo() { return _localPageNo; },
  set _localPageNo(v) { _localPageNo = v; },
  get _selMode() { return _selMode; },
  set _selMode(v) { _selMode = v; },
  get _selSet() { return _selSet; },
  set _selSet(v) { _selSet = v; },
  get currentRoot() { return currentRoot; },
  set currentRoot(v) { currentRoot = v; },
  get currentFile() { return currentFile; },
  set currentFile(v) { currentFile = v; },
};`;

function loadPanels(opts) {
    const { context, jqLog, toasts, yuki } = buildContext(opts);
    vm.createContext(context);
    vm.runInContext(PANELS_SRC + ((opts && opts.exportTail) || EXPORT_TAIL), context, { filename: 'panels.js' });
    return { ctx: context, api: context.__t, jqLog, toasts, yuki };
}

/** 造分页状态：dirs/videos/audios 用 {name,dir,time,path} 节点。 */
function withPage(items) {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api._localPage = {
        path: '', parent: '.',
        dirs: items.filter((n) => n.dir === 1),
        videos: items.filter((n) => n.dir !== 1),
        audios: [],
    };
    api._localPageNo = 1;
    api._selMode = false;
    api._selSet = new Set();
    return { api, jqLog };
}

// ---------------------------------------------------------------- 多选模式

test('toggleSelMode：进入/退出多选模式切换工具栏按钮与状态条显隐', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.toggleSelMode(true);
    assert.equal(api._selMode, true);
    // 显隐顺序：select 隐藏、selall/play/del/exit 显示（toggle(true/false)）
    assert.deepEqual(lastRecToggle(jqLog, '#local-btn-select'), [false]);
    assert.deepEqual(lastRecToggle(jqLog, '#local-btn-selall'), [true]);
    assert.deepEqual(lastRecToggle(jqLog, '#local-btn-play-sel'), [true]);
    assert.deepEqual(lastRecToggle(jqLog, '#local-btn-del-sel'), [true]);
    assert.deepEqual(lastRecToggle(jqLog, '#local-btn-exit-sel'), [true]);

    api.toggleSelMode(false);
    assert.equal(api._selMode, false);
    assert.deepEqual(lastRecToggle(jqLog, '#local-btn-select'), [true]);
    assert.deepEqual(lastRecToggle(jqLog, '#local-btn-exit-sel'), [false]);
});

function lastRecToggle(jqLog, sel) {
    for (let i = jqLog.length - 1; i >= 0; i--) if (jqLog[i].sel === sel) return jqLog[i].toggle;
    return undefined;
}

test('toggleSel：勾选/取消写入 _selSet；未开多选模式时忽略', () => {
    const { api } = withPage([{ name: 'a.mp4', dir: 0, time: 't', path: 'a.mp4' }]);
    api.toggleSel('a.mp4');
    assert.equal(api._selSet.size, 0, '未进多选模式不得勾选');
    api._selMode = true;
    api.toggleSel('a.mp4');
    assert.ok(api._selSet.has('a.mp4'));
    api.toggleSel('a.mp4');
    assert.equal(api._selSet.size, 0, '重复勾选应取消');
    api.toggleSel('');
    api.toggleSel(null);
    assert.equal(api._selSet.size, 0, '空路径不得写入');
});

test('selectAllLocal：全选吸收当前页全部条目（含文件夹）；再点一次反选清空', () => {
    const items = [
        { name: 'd', dir: 1, time: 't', path: 'd' },
        { name: 'a.mp4', dir: 0, time: 't', path: 'a.mp4' },
        { name: 'b.mp3', dir: 0, time: 't', path: 'b.mp3' },
    ];
    const { api } = withPage(items);
    api._selMode = true;
    api.selectAllLocal();
    assert.deepEqual([...api._selSet].sort(), ['a.mp4', 'b.mp3', 'd']);
    api.selectAllLocal();
    assert.equal(api._selSet.size, 0, '已全选时再点应反选清空');
});

test('collectSelPaths：按列表顺序返回勾选路径；空选集返回 null', () => {
    const items = [
        { name: 'a.mp4', dir: 0, time: 't', path: 'a.mp4' },
        { name: 'b.mp4', dir: 0, time: 't', path: 'b.mp4' },
    ];
    const { api } = withPage(items);
    assert.equal(api.collectSelPaths(), null, '未勾选返回 null');
    api._selMode = true;
    api.toggleSel('b.mp4');
    api.toggleSel('a.mp4');
    assert.deepEqual(api.collectSelPaths(), ['a.mp4', 'b.mp4'], '顺序按列表而非勾选先后');
});

test('delSelected：确认后调 fileDelMany 并刷新列表；取消不发请求；空选提示', async () => {
    const asked = [];
    const delCalls = [];
    const toasts = [];
    const items = [{ name: 'a.mp4', dir: 0, time: 't', path: 'a.mp4' }];
    const { api } = loadPanels({
        warnToasts: toasts,
        confirmDialog: async () => true,
        yuki: {
            fileList: async (p) => { asked.push(p); return { path: p, parent: '.', files: [] }; },
            fileDelMany: async (rels) => { delCalls.push(rels); return { ok: true, results: rels.map((r) => ({ rel: r, ok: true })), failed: 0 }; },
        },
    });
    api._localPage = { path: '', parent: '.', dirs: [], videos: items, audios: [] };
    api._selMode = true;
    api.toggleSel('a.mp4');
    await api.delSelected();
    assert.deepEqual(delCalls, [['a.mp4']]);
    assert.ok(toasts.includes('已删除 1 项'), `实际 ${JSON.stringify(toasts)}`);

    // 取消：不发删除请求
    const toasts2 = [];
    const b = loadPanels({
        warnToasts: toasts2,
        confirmDialog: async () => false,
        yuki: { fileDelMany: async () => { throw new Error('should not be called'); } },
    });
    b.api._localPage = { path: '', parent: '.', dirs: [], videos: items, audios: [] };
    b.api._selMode = true;
    b.api.toggleSel('a.mp4');
    await b.api.delSelected();
    assert.deepEqual(toasts2, []);

    // 空选集：仅提示
    const toasts3 = [];
    const c = loadPanels({ warnToasts: toasts3, yuki: { fileDelMany: async () => { throw new Error('should not be called'); } } });
    c.api._localPage = { path: '', parent: '.', dirs: [], videos: items, audios: [] };
    await c.api.delSelected();
    assert.ok(toasts3.includes('未勾选任何项'));
});

test('delSelected：主进程在写互斥拒绝时给出可读提示', async () => {
    const toasts = [];
    const { api } = loadPanels({
        warnToasts: toasts,
        yuki: { fileDelMany: async () => ({ ok: false, reason: 'folder has active downloads' }) },
    });
    api._localPage = { path: '', parent: '.', dirs: [], videos: [{ name: 'd', dir: 1, time: 't', path: 'd' }], audios: [] };
    api._selMode = true;
    api.toggleSel('d');
    await api.delSelected();
    assert.ok(toasts.includes('所选文件夹内有进行中的下载任务，已取消删除'));
});

test('playSelected：调 filePushMany 透传勾选路径；空选提示；失败 reason 映射', async () => {
    const pushManyCalls = [];
    const toasts = [];
    const items = [{ name: 'a.mp4', dir: 0, time: 't', path: 'a.mp4' }];
    const { api } = loadPanels({
        warnToasts: toasts,
        yuki: { filePushMany: async (rels) => { pushManyCalls.push(rels); return { ok: true, count: rels.length }; } },
    });
    api._localPage = { path: '', parent: '.', dirs: [], videos: items, audios: [] };
    api._selMode = true;
    api.toggleSel('a.mp4');
    await new Promise((r) => setImmediate(r));
    api.playSelected();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(pushManyCalls, [['a.mp4']]);
    assert.ok(toasts.some((t) => t.startsWith('play-toast:')), '成功应给播放 toast');

    // 空选
    const toasts2 = [];
    const b = loadPanels({ warnToasts: toasts2, yuki: { filePushMany: async () => { throw new Error('no'); } } });
    b.api._localPage = { path: '', parent: '.', dirs: [], videos: items, audios: [] };
    b.api.playSelected();
    await new Promise((r) => setImmediate(r));
    assert.ok(toasts2.includes('未勾选任何项'));

    // no-playable
    const toasts3 = [];
    const c = loadPanels({ warnToasts: toasts3, yuki: { filePushMany: async () => ({ ok: false, reason: 'no-playable' }) } });
    c.api._localPage = { path: '', parent: '.', dirs: [], videos: items, audios: [] };
    c.api._selMode = true;
    c.api.toggleSel('a.mp4');
    c.api.playSelected();
    await new Promise((r) => setImmediate(r));
    assert.ok(toasts3.includes('所选项目均无可播放的媒体文件'));
});

// ---------------------------------------------------------------- 勾选框渲染

test('多选模式：buildDirItem/buildFileItem/buildVideoCard 插入 sel-box，退出后不插', () => {
    const { api } = loadPanels({});
    api._selMode = false;
    assert.doesNotMatch(api.buildDirItem('d', 't', 'd'), /sel-box/);
    assert.doesNotMatch(api.buildFileItem('a.mp4', 't', 'a.mp4'), /sel-box/);
    assert.doesNotMatch(api.buildVideoCard('a.mp4', 't', 'a.mp4'), /sel-box/);

    api._selMode = true;
    const dir = api.buildDirItem('d', 't', 'd');
    const file = api.buildFileItem('a.mp4', 't', 'a.mp4');
    const card = api.buildVideoCard('a.mp4', 't', 'a.mp4');
    for (const [label, html] of [['dir', dir], ['file', file], ['card', card]]) {
        assert.match(html, /class="sel-box/, `${label} 应带勾选框`);
        assert.match(html, /toggleSel\('/, `${label} 勾选框应挂 toggleSel 回调`);
    }
    assert.match(dir, /class="file-item sel-mode"/);
    assert.match(card, /class="local-card sel-mode"/);
});

test('sel-box 勾选态回显：已勾选路径带 checked 类', () => {
    const { api } = loadPanels({});
    api._selMode = true;
    api._selSet = new Set(['a.mp4']);
    assert.match(api.buildFileItem('a.mp4', 't', 'a.mp4'), /class="sel-box checked"/);
    assert.doesNotMatch(api.buildFileItem('b.mp4', 't', 'b.mp4'), /checked/);
});

test('sel-box 路径转义：含引号/反斜杠的路径不得闭合 onclick 属性', () => {
    const { api } = loadPanels({});
    api._selMode = true;
    const html = api.buildFileItem('x', 't', `a'b\\c"d`);
    assert.match(html, /data-sel-rel="a\\'b\\\\c&quot;d"/);
    assert.ok(!html.includes("toggleSel('a'b"), '单引号必须被转义');
});

test('上级「..」项不带勾选框（避免把父目录勾进删除集合）', () => {
    const { api } = loadPanels({});
    api._selMode = true;
    assert.doesNotMatch(api.buildParentItem(), /sel-box/);
});

// ---------------------------------------------------------------- 集号锚点（epAnchorOf / parseEpNum / isNoiseNumber）

test('epAnchorOf：S01E02 / E02 / EP2 标记 → 骨架键与集号', () => {
    const { api } = loadPanels({});
    const a1 = api.epAnchorOf('剧名 S01E02'.replace('.mp4', ''));
    assert.equal(a1.num, 2);
    assert.equal(a1.key, '剧名§', 'S01E02 整段被剥掉（含季号），仅剩剧名骨架');
    const a2 = api.epAnchorOf('Show - E03');
    assert.equal(a2.num, 3);
    assert.equal(a2.key, 'show§', '集号标记连同相邻分隔符一并剥离');
    const a3 = api.epAnchorOf('Show EP12');
    assert.equal(a3.num, 12);
});

test('epAnchorOf：中文「第X集/话/回」标记（含中文数字）', () => {
    const { api } = loadPanels({});
    assert.equal(api.epAnchorOf('进击的巨人 第03集').num, 3);
    assert.equal(api.epAnchorOf('海贼王 第12话').num, 12);
    assert.equal(api.epAnchorOf('番剧 第二十五回').num, 25);
    assert.equal(api.epAnchorOf('番剧 第十二集').num, 12);
});

test('epAnchorOf：前导零/纯两位数字段启发（剧名 01 / 01.剧名 / [01]）', () => {
    const { api } = loadPanels({});
    assert.equal(api.epAnchorOf('剧名 01').num, 1);
    assert.equal(api.epAnchorOf('剧名 07').key, '剧名§', '集号连同相邻分隔符一并剥离');
    assert.equal(api.epAnchorOf('07.剧名').num, 7);
    assert.equal(api.epAnchorOf('[07] 剧名').num, 7);
    assert.equal(api.epAnchorOf('Show - 03 - 1080p').num, 3, '尾部分辨率是噪声，取前面的 03');
});

test('epAnchorOf：噪声数字不作为集号（1080p / x264 / 年份）', () => {
    const { api } = loadPanels({});
    // 唯一数字段是噪声 → null
    assert.equal(api.epAnchorOf('Movie 1080p'), null);
    assert.equal(api.epAnchorOf('Video x264'), null);
    assert.equal(api.epAnchorOf('Blade Runner 2049'), null, '4 位年份段视为噪声');
    assert.equal(api.epAnchorOf('无数字文件名'), null);
    assert.equal(api.epAnchorOf(''), null);
});

test('epAnchorOf：骨架为空（纯数字文件名）不分组', () => {
    const { api } = loadPanels({});
    assert.equal(api.epAnchorOf('01'), null);
});

test('parseEpNum：阿拉伯/全角/中文数字归一', () => {
    const { api } = loadPanels({});
    assert.equal(api.parseEpNum('07'), 7);
    assert.equal(api.parseEpNum('０２'), 2, '全角数字');
    assert.equal(api.parseEpNum('十'), 10);
    assert.equal(api.parseEpNum('二十三'), 23);
    assert.equal(api.parseEpNum('一百零五'), 105);
    assert.ok(Number.isNaN(api.parseEpNum('abc')));
});

// ---------------------------------------------------------------- groupSameSeries 组列表

test('groupSameSeries：同骨架同级文件按集号升序组队（前导零排序不乱序）', () => {
    const { api } = loadPanels({});
    const siblings = ['剧名 02.mp4', '剧名 10.mp4', '剧名 01.mp4', '别的电影.mp4'];
    const g = api.groupSameSeries('剧名 01.mp4', siblings);
    assert.deepEqual([...g], ['剧名 01.mp4', '剧名 02.mp4', '剧名 10.mp4']);
});

test('groupSameSeries：S01E0x 系列成组，E 编号排序', () => {
    const { api } = loadPanels({});
    const siblings = ['Show S01E02.mp4', 'Show S01E01.mp4', 'Show S01E03.mp4'];
    assert.deepEqual([...api.groupSameSeries('Show S01E01.mp4', siblings)],
        ['Show S01E01.mp4', 'Show S01E02.mp4', 'Show S01E03.mp4']);
});

test('groupSameSeries：不同扩展名/不同剧名不混组；骨架含扩展名差异不互通', () => {
    const { api } = loadPanels({});
    // 扩展名进骨架（.mkv vs .mp4 不成组）——保守策略：宁可不组不误组
    const siblings = ['剧名 01.mkv', '剧名 02.mkv', '剧名 01.mp4'];
    assert.deepEqual([...api.groupSameSeries('剧名 01.mkv', siblings)],
        ['剧名 01.mkv', '剧名 02.mkv']);
});

test('groupSameSeries：不足 2 项 / 无锚点返回 null（单文件播放）', () => {
    const { api } = loadPanels({});
    assert.equal(api.groupSameSeries('电影.mp4', ['电影.mp4']), null, '单文件不组');
    assert.equal(api.groupSameSeries('别的电影.mp4', ['别的电影.mp4']), null);
    assert.equal(api.groupSameSeries('无数字.mp4', ['无数字.mp4', '也是无数字.mp4']), null);
    assert.equal(api.groupSameSeries('剧名 01.mp4', []), null, '空兄弟列表');
    assert.equal(api.groupSameSeries('剧名 01.mp4', null), null);
});

test('groupSameSeries：大小写不敏感骨架（Show vs show）成组', () => {
    const { api } = loadPanels({});
    const g = api.groupSameSeries('Show 01.mp4', ['show 02.mp4', 'SHOW 03.mp4']);
    assert.deepEqual([...g], ['show 02.mp4', 'SHOW 03.mp4']);
});

// ---------------------------------------------------------------- pushFile 组列表分支

test('pushFile：同类命名自动组队——filePushMany 收到整组相对路径并记历史', async () => {
    const pushMany = [];
    const pushOne = [];
    const records = [];
    const { api } = loadPanels({
        yuki: {
            filePush: async (rel) => { pushOne.push(rel); return { ok: true }; },
            filePushMany: async (rels) => { pushMany.push(rels); return { ok: true, count: rels.length }; },
        },
        extra: { Records: { recordPlay: async (v) => { records.push(v); } } },
    });
    api._localPage = {
        path: '剧名', parent: '.',
        dirs: [],
        videos: ['剧名 01.mp4', '剧名 02.mp4', '剧名 03.mp4'].map((n) => ({ name: n, dir: 0, time: 't', path: `剧名/${n}` })),
        audios: [],
    };
    api._selMode = false;
    api.currentFile = '剧名/剧名 02.mp4';
    api.pushFile(1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(pushOne.length, 0, '组队成功时不得走单文件通道');
    assert.deepEqual(pushMany.map((x) => [...x]), [['剧名/剧名 01.mp4', '剧名/剧名 02.mp4', '剧名/剧名 03.mp4']]);
    assert.equal(records.length, 1);
    assert.equal(records[0].site, 'local');
});

test('pushFile：无同类兄弟保持单文件播放（filePush 通道不受影响）', async () => {
    const pushMany = [];
    const pushOne = [];
    const { api } = loadPanels({
        yuki: {
            filePush: async (rel) => { pushOne.push(rel); return { ok: true }; },
            filePushMany: async () => { pushMany.push(1); return { ok: true }; },
        },
    });
    api._localPage = {
        path: '', parent: '.',
        dirs: [],
        videos: [{ name: '独家电影.mp4', dir: 0, time: 't', path: '独家电影.mp4' }],
        audios: [],
    };
    api.currentFile = '独家电影.mp4';
    api.pushFile(1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(pushOne, ['独家电影.mp4']);
    assert.equal(pushMany.length, 0);
});

test('pushFile：yes!==1 不触发任何播放请求', async () => {
    let called = 0;
    const { api } = loadPanels({ yuki: { filePush: async () => { called++; return { ok: true }; }, filePushMany: async () => { called++; return { ok: true }; } } });
    api.currentFile = 'a.mp4';
    api.pushFile(0);
    await new Promise((r) => setImmediate(r));
    assert.equal(called, 0);
});

// ---------------------------------------------------------------- CSP 桥接契约

test('common.js CSP 桥接白名单包含 toggleSel（动态勾选框点击依赖桥接放行）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/common.js'), 'utf8');
    const m = src.match(/_cspFnWhitelist\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(m, '存在 _cspFnWhitelist 定义');
    assert.match(m[1], /'toggleSel'/, '本地文件勾选框 toggleSel 必须在白名单内');
});

test('index.html 多选工具栏按钮与 sel-bar 存在且初始隐藏态正确', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    for (const id of ['local-btn-select', 'local-btn-selall', 'local-btn-play-sel', 'local-btn-del-sel', 'local-btn-exit-sel', 'local-sel-bar', 'local-sel-count']) {
        assert.ok(html.includes(`id="${id}"`), `应存在 #${id}`);
    }
    // 初始只有「多选」入口可见，其余 display:none
    assert.match(html, /id="local-btn-selall"[^>]*style="display:none"/);
    assert.match(html, /id="local-sel-bar"[^>]*style="display:none"/);
});
