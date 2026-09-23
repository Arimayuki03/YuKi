/**
 * panels.js —— 本地文件面板 + 纯工具函数 白盒单元测试。
 *
 * 覆盖对象（src/renderer/js/panels.js）：
 *  - 类型判定：isLocalVideo / isLocalAudio
 *  - URL 归一化：asciiUrl（IDN punycode + 百分号编码）
 *  - 列表项/卡片构建：buildParentItem / buildDirItem / buildFileItem / buildVideoCard
 *  - 缩略图回填：loadLocalThumbs
 *  - 导航：enterDir / goParent / selectFile / pushFile / refreshLocal / ensureLocalPanel / renderNeedRoot
 *  - 分页：gotoLocalPage / localPrev / localNext / renderLocalPage
 *  - 配置面板：refreshConfigViews / applyConfigResult / renderConfigDiagnostics / renderConfigHistory
 *              addConfigHistory / removeConfigHistory
 *  - 直播源自列表：renderLiveSources
 *
 * 加载方式同 records.test.js：panels.js 是经典脚本（非 CommonJS），故用
 * fs.readFileSync + node:vm 在注入全局桩的上下文中执行，再把被测函数挂到
 * globalThis 取出。桩只需支撑被测路径，不模拟完整浏览器。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('node:path');
const vm = require('node:vm');

const BS = String.fromCharCode(92); // 反斜杠：源码里写字面量易被转义规则吃掉
const PANELS_SRC = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/panels.js'), 'utf8');

// ---------------------------------------------------------------- 全局桩

/** 可记录调用的链式 jQuery 桩：每次 $(sel) 返回一个记录对象，供断言 DOM 写入。 */
function makeJq(sel, log) {
    const rec = { sel, html: [], text: [], append: [], prop: {}, show: 0, hide: 0, each: 0, scrollTop: [] };
    (log || []).push(rec);
    const jq = {
        __rec: rec,
        length: 1,
        html(v) { rec.html.push(v); return jq; },
        text(v) { rec.text.push(String(v)); return jq; },
        append(v) { rec.append.push(v); return jq; },
        appendTo(target) {
            // $(...).text(x).appendTo(box)：把 text 内容当作一个子条目挂到目标容器
            const v = rec.text.length ? rec.text[rec.text.length - 1] : String(sel);
            if (target && target.__rec) { target.__rec.append.push(v); target.__rec.text.push(v); }
            return jq;
        },
        prop(k, v) { rec.prop[k] = v; return jq; },
        attr(k, v) { rec.prop[k] = v; return jq; },
        empty() { rec.html.push(''); return jq; },
        show() { rec.show++; return jq; },
        hide() { rec.hide++; return jq; },
        scrollTop(v) { rec.scrollTop.push(v); return jq; },
        each(fn) { rec.each++; return jq; },
        find() { return jq; },
        children() { return jq; },
        filter() { return jq; },
        off() { return jq; },
        on() { return jq; },
        val() { return ''; },
        data() { return ''; },
        closest() { return jq; },
        removeClass() { return jq; },
        addClass() { return jq; },
        toggleClass() { return jq; },
        toggle() { return jq; },
        css() { return jq; },
        removeAttr() { return jq; },
        getAttribute() { return null; },
        trigger() { return jq; },
    };
    return jq;
}

/** 构造 VM 上下文：注入 document/window/$/console 及渲染层跨文件依赖桩。 */
function buildContext(opts) {
    const o = opts || {};
    const jqLog = o.jqLog || [];
    const toasts = o.warnToasts || [];
    const dialogs = o.dialogs || [];
    const yuki = Object.assign({
        settingsGet: async () => ({}),
        settingsSet: async () => {},
        fileList: async () => ({ path: '', parent: '.', files: [] }),
        fileThumb: async () => ({ ok: false }),
        filePush: async () => ({ ok: false }),
        filePickRoot: async () => ({ ok: false }),
        fileOpenDir: async () => ({ ok: false }),
    }, o.yuki || {});

    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Number, Object, Boolean,
        parseInt, parseFloat, isNaN, isFinite, RegExp, Error, TypeError,
        setTimeout, clearTimeout, setImmediate, URL, encodeURIComponent, decodeURIComponent,
        AbortController, AbortSignal,
        fetch: async () => ({ text: async () => '{}' }),
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        $: (sel) => makeJq(sel, jqLog),
        document: {
            getElementById: (id) => ((o.docElements || {})[id] || null),
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
            querySelector: () => null,
            addEventListener() {},
            removeEventListener() {},
        },
        window: { yuki, _cfgHistoryCache: undefined },
        // common.js 提供的转义工具（按线上实现原样复制，保证语义一致）
        escPath: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
        escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        warnToast: (m) => { toasts.push(String(m)); },
        showLoading: () => {},
        hideLoading: () => {},
        openDialog: (id) => { dialogs.push(['open', id]); },
        closeDialog: (id) => { dialogs.push(['close', id]); },
        confirmDialog: async () => true,
        registerEsc: () => {},
        createRuntimeId: (p) => `${p}-test`,
        fmtSize: (b) => `${b}B`,
        doAction: async () => ({ code: 200 }),
        getJson: async () => ({}),
        localPlayToast: () => {},
        toFileUrl: (p) => 'file:///' + String(p),
        applySkin: () => {},
        applyMisansFont: async () => {},
        CSS: { escape: (s) => String(s) },
        refreshCacheDirLine: () => {},
        refreshDlDirLine: () => {},
        updateBlockedLine: () => {},
    };
    // 用例自定义全局（Home / Live 等跨文件页面对象）
    Object.assign(context, o.extra || {});
    context.globalThis = context;
    return { context, jqLog, toasts, dialogs, yuki };
}

/** 导出被测函数与模块级状态访问器到 globalThis.__t。 */
const EXPORT_TAIL = `
;globalThis.__t = {
  isLocalVideo, isLocalAudio, asciiUrl,
  buildParentItem, buildDirItem, buildFileItem, buildVideoCard,
  loadLocalThumbs, enterDir, goParent, selectFile, pushFile,
  renderNeedRoot, refreshLocal, localPrev, localNext, gotoLocalPage, renderLocalPage,
  ensureLocalPanel, renderLiveSources,
  refreshConfigViews, applyConfigResult, renderConfigDiagnostics, renderConfigHistory,
  addConfigHistory, removeConfigHistory, listFile,
  get _localPage() { return _localPage; },
  set _localPage(v) { _localPage = v; },
  get _localPageNo() { return _localPageNo; },
  set _localPageNo(v) { _localPageNo = v; },
  get currentRoot() { return currentRoot; },
  set currentRoot(v) { currentRoot = v; },
  get currentParent() { return currentParent; },
  set currentParent(v) { currentParent = v; },
  get currentFile() { return currentFile; },
  set currentFile(v) { currentFile = v; },
  get dirNavStack() { return dirNavStack; },
  set dirNavStack(v) { dirNavStack = v; },
  get _cfgHistoryCache() { return window._cfgHistoryCache; },
};`;

/**
 * 在 VM 中加载 panels.js 并取出被测 API。
 * @param {object} opts { jqLog, warnToasts, dialogs, docElements, yuki, extra, exportTail }
 */
function loadPanels(opts) {
    const { context, jqLog, toasts, dialogs, yuki } = buildContext(opts);
    vm.createContext(context);
    vm.runInContext(PANELS_SRC + ((opts && opts.exportTail) || EXPORT_TAIL),
        context, { filename: 'panels.js' });
    return { ctx: context, api: context.__t, jqLog, toasts, dialogs, yuki };
}

// ---------------------------------------------------------------- jqLog 读取辅助

/** 某个选择器最后一次 html() 写入的内容。 */
function lastHtml(jqLog, sel) {
    for (let i = jqLog.length - 1; i >= 0; i--) {
        if (jqLog[i].sel === sel && jqLog[i].html.length) return jqLog[i].html[jqLog[i].html.length - 1];
    }
    return undefined;
}
/** 某个选择器最后一次 text() 写入的内容。 */
function lastText(jqLog, sel) {
    for (let i = jqLog.length - 1; i >= 0; i--) {
        if (jqLog[i].sel === sel && jqLog[i].text.length) return jqLog[i].text[jqLog[i].text.length - 1];
    }
    return undefined;
}
/** 某个选择器上 append()/appendTo() 累积的所有内容（按调用顺序）。 */
function appends(jqLog, sel) {
    const out = [];
    for (const rec of jqLog) if (rec.sel === sel) out.push(...rec.append);
    return out;
}
/** 某个选择器的最后一条 jq 记录。 */
function lastRec(jqLog, sel) {
    for (let i = jqLog.length - 1; i >= 0; i--) if (jqLog[i].sel === sel) return jqLog[i];
    return undefined;
}
/** 造 n 个文件节点（kind: dir | video | audio），供分页状态注入。 */
function nodes(kind, n, prefix) {
    const ext = kind === 'dir' ? '' : (kind === 'video' ? 'mp4' : 'mp3');
    const arr = [];
    for (let i = 0; i < n; i++) {
        arr.push({
            name: `${prefix || kind}${i}${ext}`,
            dir: kind === 'dir' ? 1 : 0,
            time: `2026-01-0${(i % 9) + 1}`,
            path: `${kind}/${i}`,
        });
    }
    return arr;
}

// ---------------------------------------------------------------- isLocalVideo / isLocalAudio

test('isLocalVideo：白名单扩展名一律识别，大小写混写不影响判定', () => {
    const { api } = loadPanels();
    for (const n of ['a.mp4', 'a.MKV', 'A.TS', 'x.Flv', 'y.AVI', 'z.mOv', 'w.WMV',
        'm.mpg', 'n.MPEG', 'o.m4v', 'p.webm', 'q.M2TS']) {
        assert.equal(api.isLocalVideo(n), true, `${n} 应判为视频`);
    }
});

test('isLocalVideo：音频/未知扩展名/无扩展名不得误判为视频', () => {
    const { api } = loadPanels();
    for (const n of ['a.mp3', 'a.flac', 'b.txt', 'c', '.mp4', 'd.mp5', 'e.mkv.bak', 'f.avi.txt']) {
        assert.equal(api.isLocalVideo(n), false, `${n} 不应判为视频`);
    }
});

test('isLocalVideo：多点文件名取最后一段扩展名（lastIndexOf 语义）', () => {
    const { api } = loadPanels();
    assert.equal(api.isLocalVideo(' episode.01.final.mkv'), true);
    assert.equal(api.isLocalVideo('archive.tar.gz'), false);
    assert.equal(api.isLocalVideo('v1.2.mp4'), true);
});

test('isLocalVideo：带目录路径只看文件名后缀，正斜杠与反斜杠均可', () => {
    const { api } = loadPanels();
    assert.equal(api.isLocalVideo('dir/sub/video.mkv'), true);
    assert.equal(api.isLocalVideo(`D:${BS}Videos${BS}movie.MP4`), true);
    // 目录名带点但文件无扩展名：不得因目录名含 ".mp4" 误判
    assert.equal(api.isLocalVideo('folder.mp4/noext'), false);
});

test('isLocalVideo：含查询串/片段/尾空格的文件名按字面扩展名判定（不按 URL 解析）', () => {
    const { api } = loadPanels();
    assert.equal(api.isLocalVideo('movie.mkv?t=1'), false, '? 不是扩展名分隔符');
    assert.equal(api.isLocalVideo('movie.mkv#clip'), false, '# 不是扩展名分隔符');
    assert.equal(api.isLocalVideo('movie.mkv '), false, '尾空格仍属扩展名，不匹配');
});

test('isLocalVideo：null/undefined/数字等非字符串输入安全返回 false', () => {
    const { api } = loadPanels();
    assert.equal(api.isLocalVideo(null), false);
    assert.equal(api.isLocalVideo(undefined), false);
    assert.equal(api.isLocalVideo(''), false);
    assert.equal(api.isLocalVideo(123), false);
    assert.equal(api.isLocalVideo({ toString: () => 'a.mp4' }), true, '可字符串化对象仍按字符串处理');
});

test('isLocalAudio：白名单扩展名识别且大小写无关', () => {
    const { api } = loadPanels();
    for (const n of ['a.mp3', 'b.FLAC', 'c.Wav', 'd.aac', 'e.ogg', 'f.oga', 'g.opus', 'h.m4a', 'i.wma', 'j.APE']) {
        assert.equal(api.isLocalAudio(n), true, `${n} 应判为音频`);
    }
});

test('isLocalAudio：视频/未知扩展名不得误判为音频，且与视频判定互斥', () => {
    const { api } = loadPanels();
    for (const n of ['a.mp4', 'b.mkv', 'c.txt', 'd', '.mp3', 'e.mp34']) {
        assert.equal(api.isLocalAudio(n), false, `${n} 不应判为音频`);
    }
    // 两张白名单无交集：任一名字不可能同时是视频和音频
    for (const n of ['a.mp4', 'a.mp3', 'a.flac', 'a.webm', 'a.txt', 'a']) {
        assert.ok(!(api.isLocalVideo(n) && api.isLocalAudio(n)), `${n} 不应同时命中两类`);
    }
});

test('isLocalAudio：多点文件名/带路径/空值输入稳健', () => {
    const { api } = loadPanels();
    assert.equal(api.isLocalAudio('track.01.FLAC'), true);
    assert.equal(api.isLocalAudio(`Music${BS}album${BS}01.mp3`), true);
    assert.equal(api.isLocalAudio(null), false);
    assert.equal(api.isLocalAudio(''), false);
});

// ---------------------------------------------------------------- asciiUrl

test('asciiUrl：中文域名转 punycode，中文路径转百分号编码', () => {
    const { api } = loadPanels();
    assert.equal(api.asciiUrl('https://中文.cn/a'), 'https://xn--fiq228c.cn/a');
    assert.equal(
        api.asciiUrl('https://example.com/视频/目录'),
        'https://example.com/%E8%A7%86%E9%A2%91/%E7%9B%AE%E5%BD%95',
        '中文路径段必须百分号编码，否则后端 fetch 会失败',
    );
});

test('asciiUrl：空格与 # ? % 特殊字符按 URL 语义保留/编码', () => {
    const { api } = loadPanels();
    assert.equal(api.asciiUrl('http://example.com/a b/c'), 'http://example.com/a%20b/c');
    assert.equal(api.asciiUrl('http://example.com/p?x=1#片段'), 'http://example.com/p?x=1#%E7%89%87%E6%AE%B5');
    // 已合法编码的 % 序列不得被二次转义成 %25
    assert.equal(api.asciiUrl('https://example.com/%E4%B8%AD'), 'https://example.com/%E4%B8%AD');
    assert.equal(api.asciiUrl('http://x/a%zz'), 'http://x/a%zz', '非法转义序列原样保留（不抛错）');
});

test('asciiUrl：已是 URL 的输入做规范化（补斜杠、协议小写、保留查询串）', () => {
    const { api } = loadPanels();
    assert.equal(api.asciiUrl('http://example.com'), 'http://example.com/');
    assert.equal(api.asciiUrl('HTTP://Example.COM/Path'), 'http://example.com/Path');
    assert.equal(api.asciiUrl('https://a.com/x?b=2&a=1'), 'https://a.com/x?b=2&a=1');
});

test('asciiUrl：file:// 中文/空格路径编码为可直接请求的形式', () => {
    const { api } = loadPanels();
    assert.equal(api.asciiUrl('file:///D:/中文/文件 名.txt'),
        'file:///D:/%E4%B8%AD%E6%96%87/%E6%96%87%E4%BB%B6%20%E5%90%8D.txt');
});

test('asciiUrl：Windows 反斜杠盘符路径被当成 scheme 解析（异常输入原样/按 scheme 返回）', () => {
    const { api } = loadPanels();
    const withDrive = `D:${BS}media${BS}movie.mp4`;
    // 现象：`new URL('D:\media\movie.mp4')` 把 D: 当作 scheme、反斜杠当普通字符，
    // 返回 'd:\media\movie.mp4'（未做路径归一）。此处固化当前行为作为契约锚点。
    assert.equal(api.asciiUrl(withDrive), `d:${BS}media${BS}movie.mp4`);
    // 无盘符的相对反斜杠路径不是合法 URL：URL 构造抛错 → 原样返回
    assert.equal(api.asciiUrl(`sub${BS}dir${BS}v.mp4`), `sub${BS}dir${BS}v.mp4`);
});

test('asciiUrl：非 URL / 空值非法输入原样返回（不抛异常）', () => {
    const { api } = loadPanels();
    assert.equal(api.asciiUrl(''), '');
    assert.equal(api.asciiUrl('   '), '   ');
    assert.equal(api.asciiUrl('not a url'), 'not a url');
    assert.equal(api.asciiUrl('http://a b/'), 'http://a b/', '主机名含空格非法 → 原样返回');
});

// ------------------------------------------- buildParentItem / buildDirItem / buildFileItem / buildVideoCard

test('buildParentItem：返回「..」锚点，无 href 且不带任何路径参数', () => {
    const { api } = loadPanels();
    const html = api.buildParentItem();
    assert.match(html, /^<a class="file-item" onclick="goParent\(\)">/);
    assert.match(html, /<div class="file-name">\.\.<\/div>/);
    assert.match(html, /class="file-icon"/);
    assert.doesNotMatch(html, /href=/, '上级项不得用 href（CSP 场景禁止导航）');
    assert.doesNotMatch(html, /enterDir|selectFile/, '上级项不得携带路径回调');
});

test('buildDirItem：名称与时间被转义，路径进 oncontextmenu/onclick 回调', () => {
    const { api } = loadPanels();
    const html = api.buildDirItem('子目录', '2026-01-02', 'sub/子目录');
    assert.match(html, /<div class="file-name">子目录<\/div>/);
    assert.match(html, /<div class="file-time">2026-01-02<\/div>/);
    assert.match(html, /onclick="enterDir\('sub\/子目录'\)"/);
    assert.match(html, /oncontextmenu="showDelFolderDialog\('sub\/子目录',currentRoot\);return false"/);
    assert.match(html, /class="file-icon"/);
});

test('buildDirItem：防 XSS —— 文件名含 <script> 在进入名称节点前被实体转义', () => {
    const { api } = loadPanels();
    const html = api.buildDirItem('<script>alert(1)</script>', 't', 'd/x');
    const nameNode = html.match(/<div class="file-name">([\s\S]*?)<\/div>/)[1];
    assert.equal(nameNode, '&lt;script&gt;alert(1)&lt;/script&gt;', '名称节点内不得出现活标签');
    // 路径参数走 escPath（转义 & " \ '，不转义尖括号）；尖括号在双引号属性值内
    // 不构成属性闭合，故此处只校验关键的引号/反斜杠转义（见下一条用例）。
    assert.doesNotMatch(html, /file-name">\s*<script>/);
});

test('buildDirItem：路径含单引号/双引号时转义，不得闭合 onclick 属性', () => {
    const { api } = loadPanels();
    const html = api.buildDirItem('名', 't', `a'b"c`);
    assert.ok(!html.includes(`enterDir('a'b"c')`), '原始危险引号串不得原样出现');
    assert.doesNotMatch(html, /onclick="enterDir\('a'b/, '单引号必须被反斜杠转义');
    assert.ok(html.includes('&quot;'), '双引号必须实体转义');
});

test('buildDirItem：Windows 反斜杠路径在 JS 字符串字面量中被双写转义', () => {
    const { api } = loadPanels();
    const html = api.buildDirItem('v', 't', `sub${BS}dir`);
    assert.ok(html.includes(`sub${BS}${BS}dir`), '单反斜杠必须双写，否则 JS 字符串会吃掉转义');
});

test('buildFileItem：结构含文件图标与选中回调，名称/时间转义', () => {
    const { api } = loadPanels();
    const html = api.buildFileItem('影片.mkv', '2026-03-04', 'v/影片.mkv');
    assert.match(html, /^<a class="file-item" oncontextmenu="showDelFileDialog\('v\/影片\.mkv'\);return false" onclick="selectFile\('v\/影片\.mkv'\)">/);
    assert.match(html, /<div class="file-name">影片\.mkv<\/div>/);
    assert.match(html, /<div class="file-time">2026-03-04<\/div>/);
    assert.match(html, /class="file-icon"/);
});

test('buildFileItem：防 XSS —— <script> 与引号注入均不产生活标签/属性闭合', () => {
    const { api } = loadPanels();
    const html = api.buildFileItem('<img src=x onerror=alert(1)>', '<b>t</b>', 'x');
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<b>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&lt;b&gt;t&lt;\/b&gt;/);
});

test('buildVideoCard：网格卡片结构完整（thumb-rel / 占位图 / 名称 / 时间）', () => {
    const { api } = loadPanels();
    const html = api.buildVideoCard('电影.mp4', '2026-05-06', 'v/电影.mp4');
    assert.match(html, /^<div class="local-card"/);
    assert.match(html, /data-thumb-rel="v\/电影\.mp4"/);
    assert.match(html, /<div class="local-thumb ph">/);
    assert.match(html, /<div class="local-name">电影\.mp4<\/div>/);
    assert.match(html, /<div class="local-time">2026-05-06<\/div>/);
    assert.match(html, /onclick="selectFile\('v\/电影\.mp4'\)"/);
    assert.match(html, /oncontextmenu="showDelFileDialog\('v\/电影\.mp4'\);return false"/);
});

test('buildVideoCard：title 属性内片名经 escHtml，注入串被中和', () => {
    const { api } = loadPanels();
    const html = api.buildVideoCard('a" onclick="alert(1)', 't', 'p');
    assert.doesNotMatch(html, /title="a" onclick=/, '双引号必须转义为 &quot;');
    assert.match(html, /&quot;/);
});

test('极长文件名：不截断、原样转义输出（完整名保留在 title 与名称节点）', () => {
    const { api } = loadPanels();
    const long = '长'.repeat(300) + '.mkv';
    const card = api.buildVideoCard(long, '2026-01-01', 'p');
    const file = api.buildFileItem(long, '2026-01-01', 'p');
    assert.ok(card.includes(long), '卡片名称节点保留完整长名（不做静默截断丢信息）');
    assert.ok(file.includes(long));
    assert.doesNotMatch(card, /…<\/div>$/, '名称不加省略号');
});

// ---------------------------------------------------------------- loadLocalThumbs

test('loadLocalThumbs：无匹配卡片时不发起抓帧请求（空列表零 IPC）', () => {
    let calls = 0;
    const { api } = loadPanels({ yuki: { fileThumb: async () => { calls++; return { ok: true, path: 'x' }; } } });
    api.loadLocalThumbs();
    assert.equal(calls, 0);
});

// ------------------------------------------- enterDir / goParent / selectFile / pushFile

test('enterDir：当前目录压栈后切到子目录（导航栈供 Esc 逐级回退）', async () => {
    const asked = [];
    const { api } = loadPanels({ yuki: { fileList: async (p) => { asked.push(p); return { path: p, parent: '.', files: [] }; } } });
    api.currentRoot = 'anime';
    api.dirNavStack = [];
    api.enterDir('anime/进击的巨人');
    assert.deepEqual(asked, ['anime/进击的巨人'], '应以子目录路径发起一次 fileList');
    assert.deepEqual(api.dirNavStack, ['anime'], '当前目录应入栈');
});

test('goParent：非根目录时压栈并跳上级；已在根目录（parent==="."）则不动作', async () => {
    const asked = [];
    const { api } = loadPanels({ yuki: { fileList: async (p) => { asked.push(p); return { path: p, parent: '.', files: [] }; } } });
    api.currentRoot = 'anime/巨人';
    api.currentParent = 'anime';
    api.dirNavStack = [];
    api.goParent();
    assert.deepEqual(asked, ['anime']);
    assert.deepEqual(api.dirNavStack, ['anime/巨人']);

    // 根目录态：parent 为 '.' 时不得发起请求、不得压栈
    api.currentRoot = '';
    api.currentParent = '.';
    api.dirNavStack = [];
    api.goParent();
    assert.equal(asked.length, 1, '根目录再返回上级不产生请求');
    assert.deepEqual(api.dirNavStack, []);
});

test('selectFile：记录当前文件并打开信息确认框（路径以 file:/ 前缀展示）', () => {
    const jqLog = [];
    const dialogs = [];
    const { api } = loadPanels({ jqLog, dialogs });
    api.selectFile('anime/a.mkv');
    assert.equal(api.currentFile, 'anime/a.mkv');
    assert.equal(lastText(jqLog, '#fileUrl'), 'file:/anime/a.mkv');
    assert.deepEqual(dialogs, [['open', 'fileInfoDialog']]);
});

test('pushFile：yes!==1 只关框不播放；未选中文件时给提示且不调 filePush', async () => {
    const toasts = [];
    let pushes = 0;
    const dialogs = [];
    const { api } = loadPanels({
        warnToasts: toasts,
        dialogs,
        yuki: { filePush: async () => { pushes++; return { ok: true }; } },
    });
    api.pushFile(0);
    assert.deepEqual(dialogs, [['close', 'fileInfoDialog']]);
    assert.equal(pushes, 0);

    api.currentFile = '   ';
    api.pushFile(1);
    assert.equal(pushes, 0, '空白路径不得发起播放');
    assert.ok(toasts.includes('未选中文件'), `实际提示：${JSON.stringify(toasts)}`);
});

test('pushFile：各失败 reason 映射到可读提示（not-video / file-not-found / path-denied / mpv-missing）', async () => {
    const table = [
        ['not-video', '仅支持直接播放视频/音频文件'],
        ['file-not-found', '文件不存在或已被移动'],
        ['path-denied', '路径不在白名单内'],
        ['mpv-missing', '未检测到播放器，请在 设置 → 扩展 指定 mpv.exe 路径，或下载内置播放器'],
    ];
    for (const [reason, msg] of table) {
        const toasts = [];
        const { api } = loadPanels({ warnToasts: toasts, yuki: { filePush: async () => ({ ok: false, reason }) } });
        api.currentFile = 'a.mkv';
        api.pushFile(1);
        await new Promise((r) => setImmediate(r));
        assert.ok(toasts.includes(msg), `reason=${reason} 应提示「${msg}」，实际 ${JSON.stringify(toasts)}`);
    }
});

// ------------------------------------------- renderNeedRoot / refreshLocal / ensureLocalPanel

test('renderNeedRoot：渲染「选择根目录」引导并隐藏分页条', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.renderNeedRoot();
    const html = lastHtml(jqLog, '#file_list');
    assert.match(html, /尚未选择根目录（白名单）/);
    assert.match(html, /onclick="pickRoot\(\)"/);
    assert.equal(lastRec(jqLog, '#local-pager').hide, 1);
});

test('refreshLocal：以当前目录重新拉列表（不动导航栈）', async () => {
    const asked = [];
    const { api } = loadPanels({ yuki: { fileList: async (p) => { asked.push(p); return { path: p, parent: '.', files: [] }; } } });
    api.currentRoot = 'anime/巨人';
    api.refreshLocal();
    assert.deepEqual(asked, ['anime/巨人']);
});

test('ensureLocalPanel：列表为空时首次进入懒加载根目录', async () => {
    const asked = [];
    const { api } = loadPanels({
        docElements: { file_list: { innerHTML: '' } },
        yuki: { fileList: async (p) => { asked.push(p); return { path: p, parent: '.', files: [] }; } },
    });
    api.ensureLocalPanel();
    assert.deepEqual(asked, [''], '空列表首次进入应以根路径触发一次 listFile');
});

test('ensureLocalPanel：列表已有内容时不重复拉取（避免每次切页都重拉）', async () => {
    const asked = [];
    const { api } = loadPanels({
        docElements: { file_list: { innerHTML: '<div>已渲染</div>' } },
        yuki: { fileList: async (p) => { asked.push(p); return { path: p, parent: '.', files: [] }; } },
    });
    api.ensureLocalPanel();
    assert.deepEqual(asked, [], '已有内容不应再触发 listFile');
});

// ---------------------------------------------------------------- 分页钳制

/** 造分页状态：dirs/videos/audios 数量可控，返回 { api, jqLog }。 */
function withPage(nd, nv, na) {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api._localPage = {
        path: 'root', parent: '.',
        dirs: nodes('dir', nd), videos: nodes('video', nv), audios: nodes('audio', na),
    };
    api._localPageNo = 1;
    return { api, jqLog };
}

test('gotoLocalPage：首页再上一页被钳到 1（不越界到 0/负数）', () => {
    const { api } = withPage(5, 5, 5);
    api._localPageNo = 1;
    api.localPrev();
    assert.equal(api._localPageNo, 1);
});

test('gotoLocalPage：末页再下一页停在末页（250 项 = 3 页）', () => {
    const { api, jqLog } = withPage(100, 100, 50); // 250 项 → 3 页
    api.gotoLocalPage(3);
    assert.equal(api._localPageNo, 3);
    api.localNext();
    assert.equal(api._localPageNo, 3, '末页再下一页应停在 3');
    assert.equal(lastText(jqLog, '#local-page-info'), '第 3 / 3 页 · 共 250 项');
});

test('gotoLocalPage：负数/超大/小数入参分别钳到 1 与末页，且不崩溃', () => {
    const { api } = withPage(10, 10, 10); // 30 项 → 1 页
    api.gotoLocalPage(-5);
    assert.equal(api._localPageNo, 1);
    api.gotoLocalPage(9999);
    assert.equal(api._localPageNo, 1, '单页时超大页码钳到 1');

    const big = withPage(120, 60, 20); // 200 项 → 2 页
    big.api.gotoLocalPage(9999);
    assert.equal(big.api._localPageNo, 2, '两页时超大页码钳到末页 2');
    big.api.gotoLocalPage(0.4);
    assert.equal(big.api._localPageNo, 1, '小数页码向下钳到 1');
    big.api.gotoLocalPage(-0.5);
    assert.equal(big.api._localPageNo, 1);
});

test('gotoLocalPage：NaN 入参当前会污染页码（缺陷锚点，见报告 panels.js:733）', () => {
    const { api } = withPage(10, 10, 10);
    api.gotoLocalPage(NaN);
    // Math.min(Math.max(1, NaN), pages) === NaN：页码被写成 NaN，后续翻页无法自愈。
    // 线上入口（inline onclick 的 localPrev/localNext 无参）传不到 NaN，故仅作行为锚定。
    assert.ok(Number.isNaN(api._localPageNo), '当前实现下 NaN 会直接写入 _localPageNo');
});

test('gotoLocalPage：未初始化（_localPage 为空）时直接返回，不渲染不报错', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api._localPage = null;
    api.gotoLocalPage(2);
    api.localNext();
    assert.equal(api._localPageNo, 1, '缺省页码保持不变');
    assert.equal(lastHtml(jqLog, '#file_list'), undefined, '不得写入文件列表');
});

test('gotoLocalPage：翻页后按钮禁用态与分页信息同步（首页禁上一页 / 末页禁下一页）', () => {
    const { api, jqLog } = withPage(150, 100, 50); // 300 项 → 3 页
    api.gotoLocalPage(1);
    assert.equal(lastRec(jqLog, '#local-prev').prop.disabled, true, '首页应禁用上一页');
    assert.equal(lastRec(jqLog, '#local-next').prop.disabled, false);

    api.gotoLocalPage(3);
    assert.equal(lastRec(jqLog, '#local-next').prop.disabled, true, '末页应禁用下一页');
    assert.equal(lastRec(jqLog, '#local-prev').prop.disabled, false);
    assert.equal(lastText(jqLog, '#local-page-info'), '第 3 / 3 页 · 共 300 项');
});

test('gotoLocalPage：翻页把列表滚回顶部；单页时隐藏分页条', () => {
    const { api, jqLog } = withPage(1, 2, 3);
    api.gotoLocalPage(1);
    assert.deepEqual(lastRec(jqLog, '#view-tools').scrollTop, [0], '翻页后列表回到顶部');
    const pager = lastRec(jqLog, '#local-pager');
    assert.equal(pager.hide, 1, '仅一页时应隐藏分页条');
    assert.equal(pager.show, 0);
});

test('localNext/localPrev：跨页边界逐页移动正确（1→2→3→2→1）', () => {
    const { api } = withPage(200, 80, 20); // 300 项 → 3 页
    assert.equal(api._localPageNo, 1);
    api.localNext();
    assert.equal(api._localPageNo, 2);
    api.localNext();
    assert.equal(api._localPageNo, 3);
    api.localPrev();
    assert.equal(api._localPageNo, 2);
    api.localPrev();
    assert.equal(api._localPageNo, 1);
});

test('renderLocalPage：非根目录时置顶「..」；空目录且为根时给空态提示', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api._localPage = { path: 'sub', parent: 'root', dirs: [], videos: [], audios: [] };
    api._localPageNo = 1;
    api.renderLocalPage();
    assert.match(lastHtml(jqLog, '#file_list'), /goParent\(\)/, '非根目录应显示返回上级');

    const jqLog2 = [];
    const b = loadPanels({ jqLog: jqLog2 });
    b.api._localPage = { path: '', parent: '.', dirs: [], videos: [], audios: [] };
    b.api._localPageNo = 1;
    b.api.renderLocalPage();
    const html2 = lastHtml(jqLog2, '#file_list');
    assert.doesNotMatch(html2, /goParent\(\)/, '根目录不显示返回上级');
    assert.match(html2, /（无视频\/音频文件）/);
});

// ---------------------------------------------------------------- renderLiveSources

test('renderLiveSources：空列表渲染引导文案；非空列表渲染条目与删除按钮', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.renderLiveSources([]);
    assert.match(lastHtml(jqLog, '#live_src_list'), /暂无自定义直播源/);

    const jqLog2 = [];
    const b = loadPanels({ jqLog: jqLog2 });
    b.api.renderLiveSources([{ name: '央视', url: 'https://a/1.m3u' }, 'https://b/2.txt']);
    const items = appends(jqLog2, '#live_src_list');
    assert.equal(items.length, 2);
    assert.match(items[0], /history-url">央视</);
    assert.match(items[0], /data-idx="0"/);
    assert.match(items[1], /history-url">https:\/\/b\/2\.txt</, '字符串条目以自身为名');
    assert.match(items[1], /data-idx="1"/);
    assert.match(items[0], /live-src-del/);
});

test('renderLiveSources：URL 进 title 前经 escHtml，注入串不闭合属性', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.renderLiveSources([{ name: 'x', url: 'a" onerror="alert(1)' }]);
    const item = appends(jqLog, '#live_src_list')[0];
    assert.doesNotMatch(item, /onerror="alert/, 'title 内双引号必须转义');
    assert.match(item, /&quot;/);
});

test('renderLiveSources：超长名称截断到 70 字符加省略号', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.renderLiveSources([{ name: 'n'.repeat(120), url: 'https://x/1' }]);
    const name = appends(jqLog, '#live_src_list')[0].match(/<span class="history-url">([\s\S]*?)<\/span>/)[1];
    assert.equal(name.length, 71, '名称截断为 70 字符 + …');
    assert.equal(name, 'n'.repeat(70) + '…');
});

// ------------------------------------------- renderConfigDiagnostics

test('renderConfigDiagnostics：空/无诊断数据时输出「尚无配置诊断」占位', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.renderConfigDiagnostics({});
    const items = appends(jqLog, '#config_diagnostics');
    assert.ok(items.some((h) => h.includes('尚无配置诊断')), '应给出空态占位');
    assert.ok(items.some((h) => h.includes('配置 0 · 建成 0')), '汇总行仍输出（计数归零）');
});

test('renderConfigDiagnostics：健康站点时提示「当前没有不可用站点」并给出汇总与运行时分布', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.renderConfigDiagnostics({
        summary: { configured: 3, built: 3, initialized: 3, healthy: 3, degraded: 0, unsupported: 0 },
        diagnostics: [
            { siteKey: 's1', healthy: true, runtime: 'js' },
            { siteKey: 's2', healthy: true, runtime: 'js' },
            { siteKey: 's3', healthy: true, runtime: 'py' },
        ],
    });
    const items = appends(jqLog, '#config_diagnostics');
    assert.ok(items.some((h) => h.includes('配置 3 · 建成 3 · 初始化 3 · 可用 3 · 降级 0 · 不支持 0')), '汇总行计数正确');
    assert.ok(items.some((h) => h.includes('运行时分布: js: 2 · py: 1')), '运行时分布统计');
    assert.ok(items.some((h) => h.includes('当前没有不可用站点')));
});

test('renderConfigDiagnostics：不健康条目按 error.code 聚合，原因列表截断到 50 条', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    const diags = [];
    for (let i = 0; i < 60; i++) {
        diags.push({ siteKey: `site${i}`, healthy: false, state: 'unavailable', runtime: 'js', lastError: { code: 'L3_JS_FAILED', message: 'boom' } });
    }
    api.renderConfigDiagnostics({ summary: { healthy: 0 }, diagnostics: diags });
    const items = appends(jqLog, '#config_diagnostics');
    assert.ok(items.some((h) => h.includes('错误层级统计: L3_JS_FAILED (60)')), '按 lastError.code 聚合');
    const first = items.filter((h) => h.includes('site0 ·'));
    assert.equal(first.length, 1);
    assert.match(first[0], /site0 · unavailable · L3_JS_FAILED boom/);
    // 汇总 + 运行时 + 错误统计 3 行 + 最多 50 条原因
    assert.ok(items.length <= 53, `原因列表须截断到 50 条，实际 ${items.length}`);
});

test('renderConfigDiagnostics：条目缺字段（无 runtime / 无 state / 无 lastError）稳健归类', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    // 注：summary 必须给出 healthy/degraded/unsupported，否则 221-223 行的
    // diagnostics.filter(item => item.healthy) 对 null 条目会抛 TypeError（见报告）。
    api.renderConfigDiagnostics({
        summary: { configured: 5, built: 0, initialized: 0, healthy: 0, degraded: 0, unsupported: 0 },
        diagnostics: [null, undefined, {}, { siteKey: 'a', runtime: 'android' }, { healthy: true }],
    });
    const items = appends(jqLog, '#config_diagnostics');
    assert.ok(items.some((h) => h.includes('unknown')), '缺 runtime 归入 unknown');
    assert.ok(items.some((h) => h.includes('android: 1')), 'android 运行时单独计数');
    assert.ok(items.some((h) => h.includes('仅支持 Android')), 'android 站点给出可移植源建议');
    assert.ok(items.some((h) => h.includes('? · unavailable')), '缺 siteKey 回退为 ?');
});

test('renderConfigDiagnostics：summary 缺计数时回退按 diagnostics 自行统计健康/降级/不支持', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.renderConfigDiagnostics({
        summary: {},
        diagnostics: [
            { siteKey: 'ok', healthy: true, runtime: 'js' },
            { siteKey: 'dg', state: 'degraded', runtime: 'js' },
            { siteKey: 'un', state: 'unsupported', runtime: 'jar' },
            { siteKey: 'an', runtime: 'android' },
        ],
    });
    const items = appends(jqLog, '#config_diagnostics');
    assert.ok(items.some((h) => h.includes('配置 4 · 建成 0 · 初始化 0 · 可用 1 · 降级 1 · 不支持 2')),
        `汇总应按 diagnostics 推导，实际 ${JSON.stringify(items[0])}`);
});

test('renderConfigDiagnostics：skipped 列表与不可用条目合并展示', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.renderConfigDiagnostics({
        summary: { skipped: ['跳过项A', '跳过项B'], healthy: 0 },
        diagnostics: [{ siteKey: 'bad', healthy: false, state: 'down' }],
    });
    const items = appends(jqLog, '#config_diagnostics');
    assert.ok(items.some((h) => h.includes('跳过项A')));
    assert.ok(items.some((h) => h.includes('跳过项B')));
    assert.ok(items.some((h) => h.includes('bad · down')), '不可用站点单独成行');
});

// ---------------------------------------------------------------- renderConfigHistory

test('renderConfigHistory：空列表渲染占位提示；非空列表按序输出索引与删除按钮', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.renderConfigHistory([]);
    assert.match(lastHtml(jqLog, '#config_history'), /暂无历史源/);

    const jqLog2 = [];
    const b = loadPanels({ jqLog: jqLog2 });
    b.api.renderConfigHistory(['https://a/1.json', 'https://b/2.json']);
    const items = appends(jqLog2, '#config_history');
    assert.equal(items.length, 2);
    assert.match(items[0], /data-idx="0"/);
    assert.match(items[1], /data-idx="1"/);
    assert.match(items[0], /history-del/);
});

test('renderConfigHistory：超长 URL 名称截断到 70 字符加省略号，title 保留完整值', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    const longUrl = 'https://example.com/' + 'p'.repeat(120) + '.json';
    api.renderConfigHistory([longUrl]);
    const item = appends(jqLog, '#config_history')[0];
    const name = item.match(/<span class="history-url">([\s\S]*?)<\/span>/)[1];
    assert.equal(name.length, 71, '名称截断为 70 字符 + …');
    assert.ok(name.endsWith('…'));
    assert.ok(item.includes(longUrl), 'title 保留完整 URL');
});

test('renderConfigHistory：URL 中的中文被 decodeURIComponent 还原展示，非法编码保留原文', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.renderConfigHistory(['https://example.com/%E9%85%8D%E7%BD%AE.json', 'https://x/%zz']);
    const items = appends(jqLog, '#config_history');
    assert.match(items[0], /<span class="history-url">https:\/\/example\.com\/配置\.json<\/span>/);
    assert.match(items[1], /<span class="history-url">https:\/\/x\/%zz<\/span>/, '非法编码不抛错，保留原文');
});

test('renderConfigHistory：注入串经 escHtml，不产出可执行属性/标签', () => {
    const jqLog = [];
    const { api } = loadPanels({ jqLog });
    api.renderConfigHistory(['<img src=x onerror=alert(1)>']);
    const item = appends(jqLog, '#config_history')[0];
    assert.doesNotMatch(item, /<img src=x/);
    assert.match(item, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('addConfigHistory：写入 settings 并同步 window._cfgHistoryCache（最新在前、去重、上限 10）', async () => {
    const store = { configHistory: ['https://old/1.json'] };
    const yuki = {
        settingsGet: async () => JSON.parse(JSON.stringify(store)),
        settingsSet: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    };
    const { api } = loadPanels({ yuki });
    await api.addConfigHistory('https://new/1.json');
    assert.deepEqual(store.configHistory, ['https://new/1.json', 'https://old/1.json']);
    assert.deepEqual(api._cfgHistoryCache, ['https://new/1.json', 'https://old/1.json'],
        '缓存必须同步（历史条目的点击载入依赖它）');

    await api.addConfigHistory('https://new/1.json');
    assert.equal(store.configHistory.length, 2, '重复 URL 不产生第二条目');

    for (let i = 0; i < 15; i++) await api.addConfigHistory(`https://x/${i}.json`);
    assert.equal(store.configHistory.length, 10, '历史上限 10 条');
    assert.equal(store.configHistory[0], 'https://x/14.json', '最新在前');
});

test('removeConfigHistory：删除指定索引后同步缓存并重渲；越界索引不抛错', async () => {
    const store = { configHistory: ['a', 'b', 'c'] };
    const yuki = {
        settingsGet: async () => JSON.parse(JSON.stringify(store)),
        settingsSet: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    };
    const { api } = loadPanels({ yuki });
    await api.removeConfigHistory(1);
    assert.deepEqual(store.configHistory, ['a', 'c']);
    assert.deepEqual(api._cfgHistoryCache, ['a', 'c']);

    await assert.doesNotReject(() => api.removeConfigHistory(99), '越界索引 splice 后应静默完成');
});

// ---------------------------------------------------------------- refreshConfigViews / applyConfigResult

test('refreshConfigViews：按存在性触发 Home.loadSites / Live.load（缺失时静默跳过）', async () => {
    const calls = [];
    const full = loadPanels({
        extra: { Home: { loadSites: () => calls.push('home') }, Live: { load: () => calls.push('live') } },
    });
    full.api.refreshConfigViews();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, ['home', 'live'], '两者都定义时都刷新');

    const calls2 = [];
    const onlyHome = loadPanels({ extra: { Home: { loadSites: () => calls2.push('home') } } });
    onlyHome.api.refreshConfigViews(); // Live 未定义 → typeof 守卫跳过
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls2, ['home'], 'Live 未定义时只刷新首页且不报错');

    const none = loadPanels({});
    assert.doesNotThrow(() => none.api.refreshConfigViews(), 'Home/Live 全缺时静默跳过');
});

test('refreshConfigViews：单个刷新任务抛错被 catch 吞掉，不影响另一个', async () => {
    const calls = [];
    const { api } = loadPanels({
        extra: {
            Home: { loadSites: () => { throw new Error('首页刷新炸了'); } },
            Live: { load: () => calls.push('live') },
        },
    });
    assert.doesNotThrow(() => api.refreshConfigViews());
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, ['live'], '首页刷新失败不得拖垮直播页刷新');
});

test('applyConfigResult：可用站点 > 0 时给出汇总提示，并把 http(s) URL 持久化 + 记入历史', async () => {
    const store = {};
    const yuki = {
        settingsGet: async () => JSON.parse(JSON.stringify(store)),
        settingsSet: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    };
    const toasts = [];
    const { api } = loadPanels({ warnToasts: toasts, yuki });
    api.applyConfigResult(
        { configured: 5, built: 5, initialized: 5, healthy: 4, degraded: 1, parses: 3 },
        'https://cfg.example.com/a.json',
    );
    await new Promise((r) => setImmediate(r)); // addConfigHistory 为 fire-and-forget
    assert.equal(store.lastConfigUrl, 'https://cfg.example.com/a.json', 'URL 需持久化供下次回填');
    assert.deepEqual(store.configHistory, ['https://cfg.example.com/a.json']);
    const tip = toasts[toasts.length - 1];
    assert.match(tip, /检测 5 个站点/);
    assert.match(tip, /可用 4 \/ 降级 1 \/ 不支持 0/);
    assert.match(tip, /3 个解析/);
});

test('applyConfigResult：零可用站点时走「没有可用站点」分支（缺陷锚点：诊断明细被丢弃）', async () => {
    const toasts = [];
    const { api } = loadPanels({ warnToasts: toasts });
    api.applyConfigResult(
        { configured: 2, healthy: 0, degraded: 0, unsupported: 2, build_errors: { js_failed: 2 } },
        'http://x/y.json',
    );
    await new Promise((r) => setImmediate(r));
    const tip = toasts[toasts.length - 1];
    assert.match(tip, /配置已解析但没有可用站点/);
    assert.match(tip, /不支持 2/);
    // 现象：该分支只拼 progressSummary（hint），把已算好的 parts（含「诊断：L3 JS 失败 2」）
    // 丢掉了，而文案却让用户「请查看设置中的诊断信息」——提示与内容不一致。
    // 缺陷锚点，见报告 panels.js:208。
    assert.doesNotMatch(tip, /诊断：L3 JS 失败 2/, '当前实现下零可用分支不携带诊断明细');
});

test('applyConfigResult：有降级站点时走正常分支，build_errors 诊断进入提示', async () => {
    const toasts = [];
    const { api } = loadPanels({ warnToasts: toasts });
    api.applyConfigResult(
        { configured: 2, healthy: 0, degraded: 1, build_errors: { js_failed: 2, jar_failed: 1 } },
        'http://x/y.json',
    );
    await new Promise((r) => setImmediate(r));
    const tip = toasts[toasts.length - 1];
    assert.doesNotMatch(tip, /配置已解析但没有可用站点/);
    // 诊断项顺序固定为 L1 解析失败 → L2 类型不支持 → L3 JAR → L3 JS → L3 Python
    assert.match(tip, /诊断：L3 JAR 失败 1、L3 JS 失败 2/, '降级>0 时诊断明细应出现在提示中');
});

test('applyConfigResult：跳过条目数量写入提示', async () => {
    const toasts = [];
    const { api } = loadPanels({ warnToasts: toasts });
    api.applyConfigResult({ configured: 4, healthy: 4, skipped: ['a', 'b', 'c'] }, 'http://x/y.json');
    await new Promise((r) => setImmediate(r));
    assert.match(toasts[toasts.length - 1], /跳过 3 个/);
});

test('applyConfigResult：非 URL 文本（裸 JSON）不写 lastConfigUrl / 历史', async () => {
    const store = {};
    const yuki = {
        settingsGet: async () => JSON.parse(JSON.stringify(store)),
        settingsSet: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    };
    const { api } = loadPanels({ yuki });
    api.applyConfigResult({ configured: 1, healthy: 1 }, '{"sites":[]}');
    await new Promise((r) => setImmediate(r));
    assert.equal(store.lastConfigUrl, undefined, '裸 JSON 不应持久化成配置地址');
    assert.equal(store.configHistory, undefined);
});

test('applyConfigResult：不支持数由 configured-healthy-degraded 推导，负值归零', async () => {
    const toasts = [];
    const { api } = loadPanels({ warnToasts: toasts });
    api.applyConfigResult({ configured: 2, healthy: 3, degraded: 1 }, 'http://x/y.json');
    await new Promise((r) => setImmediate(r));
    const tip = toasts[toasts.length - 1];
    assert.match(tip, /不支持 0/, '推导为负必须归零，不能显示负数');
});

test('applyConfigResult：JAR / 网盘源数量写入提示文案（缺 JRE 时额外提示）', async () => {
    const toasts = [];
    const { api } = loadPanels({ warnToasts: toasts });
    api.applyConfigResult({ configured: 3, healthy: 3, jarSites: 1, javaOk: false, panSites: 2 }, 'http://x/y.json');
    await new Promise((r) => setImmediate(r));
    const tip = toasts[toasts.length - 1];
    assert.match(tip, /含 1 个 JAR 源（需安装 JRE）/);
    assert.match(tip, /含 2 个网盘源/);
});
