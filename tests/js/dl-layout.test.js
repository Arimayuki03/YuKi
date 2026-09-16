// 单元测试：RM-1 下载番剧子目录布局（dl-layout.js）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { sanitizeSegment, resolveSeriesTaskLayout, relUnderRoot, seriesDisplayName } = require('../../src/main/dl-layout');

// ------------------------------------------------------------ sanitizeSegment

test('sanitizeSegment: Windows 非法字符替换为下划线（含路径分隔符防穿越）', () => {
    assert.equal(sanitizeSegment('a<b>c:d"e|f?g*h'), 'a_b_c_d_e_f_g_h');
    assert.equal(sanitizeSegment('a/b\\c'), 'a_b_c');
});

test('sanitizeSegment: 尾部空格与点去除（含连续混合）', () => {
    assert.equal(sanitizeSegment('名字. '), '名字');
    assert.equal(sanitizeSegment('name...'), 'name');
    assert.equal(sanitizeSegment('  两端空格  '), '两端空格');
});

test('sanitizeSegment: Windows 保留设备名追加下划线（含带扩展名形态）', () => {
    assert.equal(sanitizeSegment('CON'), 'CON_');
    assert.equal(sanitizeSegment('com1'), 'com1_');
    assert.equal(sanitizeSegment('LPT9'), 'LPT9_');
    assert.equal(sanitizeSegment('CON.mp4'), 'CON_.mp4');
    assert.equal(sanitizeSegment('nul.txt'), 'nul_.txt');
    // 非保留名不受影响；仅前缀相同不算保留
    assert.equal(sanitizeSegment('console'), 'console');
    assert.equal(sanitizeSegment('COM10'), 'COM10');
});

test('sanitizeSegment: 截断到 80 码点（中文不切半、代理对安全）', () => {
    const long = '剧'.repeat(100);
    const out = sanitizeSegment(long);
    assert.equal(Array.from(out).length, 80);
    assert.equal(sanitizeSegment('x'.repeat(100), { maxLen: 10 }), 'x'.repeat(10));
    // 代理对（emoji）不切半
    const emoji = '🎬'.repeat(50);
    assert.equal(Array.from(sanitizeSegment(emoji, { maxLen: 10 })).length, 10);
});

test('sanitizeSegment: 控制字符剔除、空结果回退 fallback（默认空串）', () => {
    assert.equal(sanitizeSegment('a\x00b\x1fc'), 'abc');
    assert.equal(sanitizeSegment('..'), '');
    assert.equal(sanitizeSegment('..', { fallback: '未命名番剧' }), '未命名番剧');
    assert.equal(sanitizeSegment('正常'), '正常');
});

// ------------------------------------------------------ resolveSeriesTaskLayout

test('layout: 正常场景 dir=<root>/<剧名>、file=<剧名> - <集名><ext>（仅一级子目录）', () => {
    const r = resolveSeriesTaskLayout({
        dlRoot: 'D:\\Downloads', vodName: '葬送のフリーレン', epName: '第01集', out: '葬送のフリーレン - 第01集.mp4',
    });
    assert.ok(r);
    assert.equal(r.dir, path.join('D:\\Downloads', '葬送のフリーレン'));
    assert.equal(r.file, '葬送のフリーレン - 第01集.mp4');
    assert.equal(r.folder, '葬送のフリーレン');
    // 文件名不含分隔符（防穿越）
    assert.ok(!r.file.includes(path.sep) && !r.file.includes('/'));
});

test('layout: 集名本身以剧名开头（「剧名 第X集」形态源）不重复前缀', () => {
    const r = resolveSeriesTaskLayout({
        dlRoot: '/dl', vodName: '剧A', epName: '剧A 第02话', out: '剧A 第02话.mp4',
    });
    assert.equal(r.file, '剧A 第02话.mp4');
    // 单集影片：集名 === 剧名，避免「剧名 - 剧名.mp4」
    const r2 = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: '星际穿越', epName: '星际穿越', out: '星际穿越.mp4' });
    assert.equal(r2.file, '星际穿越.mp4');
});

test('layout: 开关关闭 / 缺剧名 / 缺根目录 → null（回退平铺旧行为）', () => {
    const base = { dlRoot: 'D:\\Downloads', vodName: '剧', epName: '第1集', out: '剧 - 第1集.mp4' };
    assert.equal(resolveSeriesTaskLayout({ ...base, enabled: false }), null);
    assert.equal(resolveSeriesTaskLayout({ ...base, vodName: '  ' }), null);
    assert.equal(resolveSeriesTaskLayout({ ...base, dlRoot: '' }), null);
    assert.equal(resolveSeriesTaskLayout({ ...base, dlRoot: null }), null);
});

test('layout: 集名缺失回退旧 out 文件名；单集影片同样建目录', () => {
    const r = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: '星际穿越', epName: '', out: '星际穿越 - .mp4' });
    assert.ok(r);
    assert.equal(r.dir, path.join('/dl', '星际穿越'));
    assert.equal(r.file, '星际穿越 - .mp4'.replace(/[\\/:*?"<>|]/g, '_'));
});

test('layout: 集名含非法字符被清洗；纯点集名回退 out 文件名', () => {
    const r = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: '剧', epName: 'a/b\\c:d', out: '剧 - x.mp4' });
    assert.equal(r.file, '剧 - a_b_c_d.mp4');
    const r2 = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: '剧', epName: '..', out: '剧 - 第2集.mp4' });
    assert.equal(r2.file, '剧 - 第2集.mp4');
});

test('layout: 保留名剧名/集名追加下划线，不产生非法目录', () => {
    const r = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: 'CON', epName: '第1集', out: 'CON - 第1集.mp4' });
    assert.equal(r.folder, 'CON_');
    const r2 = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: '剧', epName: 'AUX', out: '剧 - AUX.mp4' });
    assert.equal(r2.file, '剧 - AUX_.mp4');
});

test('layout: out 无扩展名时 file 保持无扩展名（不发明扩展名）', () => {
    const r = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: '剧', epName: '第1集', out: '剧 - 第1集' });
    assert.equal(r.file, '剧 - 第1集');
});

test('layout: 新命名产物经 seriesDisplayName 展示不再叠加剧名前缀', () => {
    const root = path.resolve('/dl');
    const r = resolveSeriesTaskLayout({ dlRoot: root, vodName: '葬送のフリーレン', epName: '第01集', out: 'x.mp4' });
    assert.equal(r.file, '葬送のフリーレン - 第01集.mp4');
    assert.equal(seriesDisplayName({
        dlRoot: root, files: [path.join(root, r.folder, r.file)], name: r.file,
    }), '葬送のフリーレン - 第01集.mp4');
});

test('layout: 超长剧名只截剧名前缀，集名保留在尾部，同剧多集不碰撞', () => {
    const vodName = '葬送のフリーレン 第二期 完結編 特装版 HD 高画質リマスター版 字幕入り'.repeat(2);
    const a = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName, epName: '第01集', out: 'x.mp4' });
    const b = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName, epName: '第02集', out: 'x.mp4' });
    assert.ok(a && b);
    assert.notEqual(a.file, b.file);
    assert.ok(a.file.endsWith(' - 第01集.mp4'));
    assert.ok(b.file.endsWith(' - 第02集.mp4'));
    // 主名不超段长上限，且截断后仍无路径分隔符
    const stem = a.file.slice(0, a.file.length - path.extname(a.file).length);
    assert.ok(Array.from(stem).length <= 80);
    assert.ok(!a.file.includes(path.sep) && !a.file.includes('/'));
});

test('layout: 剧名恰满 80 码点时集名仍在文件名尾部（截断回归）', () => {
    const folder = 'あ'.repeat(80);
    const a = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: folder, epName: '第01集', out: 'x.mp4' });
    const b = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: folder, epName: '第02集', out: 'x.mp4' });
    assert.ok(a.file.endsWith(' - 第01集.mp4'));
    assert.ok(b.file.endsWith(' - 第02集.mp4'));
    assert.notEqual(a.file, b.file);
});

test('layout: 剧名截断恰好落在点/空格上时清掉尾缀，段名合法', () => {
    // budget = 80 - 3 - len('第1集') = 74，剧名前 74 码点恰以点结尾
    const vodName = 'x'.repeat(73) + '.超长后缀部分';
    const r = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName, epName: '第1集', out: 'x.mp4' });
    assert.equal(r.file, 'x'.repeat(73) + ' - 第1集.mp4');
});

test('layout: 集名近满段长时放弃剧名前缀，保住集名不被截掉', () => {
    const ep = '第'.repeat(77) + '01集';   // 79 码点，剧名+「 - 」已无预算
    const r = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: '剧名很长'.repeat(20), epName: ep, out: 'x.mp4' });
    assert.equal(r.file, ep + '.mp4');
});

// ------------------------------------------------------------------ relUnderRoot

test('relUnderRoot: 根内子路径返回相对路径；越界/平级/相同返回空串', () => {
    const root = path.resolve('/dl');
    assert.equal(relUnderRoot(root, path.join(root, '番剧', '第1集.mp4')), path.join('番剧', '第1集.mp4'));
    assert.equal(relUnderRoot(root, path.join(root, 'a.mp4')), 'a.mp4');
    assert.equal(relUnderRoot(root, root), '');
    assert.equal(relUnderRoot(root, path.resolve('/etc/passwd')), '');
    assert.equal(relUnderRoot(root, path.resolve('/dl2/x.mp4')), '');
    assert.equal(relUnderRoot('', '/x'), '');
    assert.equal(relUnderRoot(root, ''), '');
});

// -------------------------------------------------------------- seriesDisplayName

test('seriesDisplayName: 番剧子目录一级产物补「剧名 - 文件名」前缀', () => {
    const root = path.resolve('/dl');
    const r = seriesDisplayName({
        dlRoot: root,
        files: [path.join(root, '葬送のフリーレン', '第01集.mp4')],
        name: '第01集.mp4',
    });
    assert.equal(r, '葬送のフリーレン - 第01集.mp4');
    // name 缺失时回退产物 basename
    assert.equal(seriesDisplayName({ dlRoot: root, files: [path.join(root, '剧B', '第2集.mp4')] }), '剧B - 第2集.mp4');
});

test('seriesDisplayName: 平铺/BT 多级目录返回空串（保持原 name）', () => {
    const root = path.resolve('/dl');
    // 平铺（一级）
    assert.equal(seriesDisplayName({ dlRoot: root, files: [path.join(root, 'movie.mp4')], name: 'movie.mp4' }), '');
    // BT 自建多级目录
    assert.equal(seriesDisplayName({
        dlRoot: root,
        files: [path.join(root, '种子包', 'Season 1', 'ep1.mkv')],
        name: '种子包',
    }), '');
    // 产物在根目录外 / 无产物 / 无根目录
    assert.equal(seriesDisplayName({ dlRoot: root, files: [path.resolve('/elsewhere/a.mp4')], name: 'a.mp4' }), '');
    assert.equal(seriesDisplayName({ dlRoot: root, files: [], name: 'a.mp4' }), '');
    assert.equal(seriesDisplayName({ dlRoot: '', files: [path.join(root, '剧', 'a.mp4')], name: 'a.mp4' }), '');
});

test('seriesDisplayName: BT 种子仅一级目录时凑出「种子名 - 文件名」（顺带生效）', () => {
    const root = path.resolve('/dl');
    assert.equal(seriesDisplayName({
        dlRoot: root,
        files: [path.join(root, '种子包', 'ep1.mkv')],
        name: 'ep1.mkv',
    }), '种子包 - ep1.mkv');
});

test('seriesDisplayName: 文件主名已含剧名时不重复前缀', () => {
    const root = path.resolve('/dl');
    // 单集影片：stem === 剧名
    assert.equal(seriesDisplayName({
        dlRoot: root, files: [path.join(root, '星际穿越', '星际穿越.mp4')], name: '星际穿越.mp4',
    }), '星际穿越.mp4');
    // 集名缺失回退旧 out 命名（「剧名 - xxx」已落子目录）
    assert.equal(seriesDisplayName({
        dlRoot: root, files: [path.join(root, '剧A', '剧A - 特别篇.mp4')], name: '剧A - 特别篇.mp4',
    }), '剧A - 特别篇.mp4');
});
