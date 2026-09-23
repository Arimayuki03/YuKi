// 白盒单元测试：下载子系统四模块内部实现分支（downloader / dl-record / dl-layout / dl-dedupe）
// 与既有组件测试互补：既有测试覆盖「对外契约与主干路径」，本文件补未覆盖的边界分支
// （非法入参矩阵、长度边界、持久化兜底与上限、RPC 三级回退、事件去重、去重中间态等）。
// 全部依赖以桩注入：不 spawn 真实 aria2、不出网、不依赖 Electron 运行时。
'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const SRC_MAIN = path.join(__dirname, '..', '..', 'src', 'main');
const DOWNLOADER_SRC = path.join(SRC_MAIN, 'downloader.js');
const {
    sanitizeSegment, resolveSeriesTaskLayout, relUnderRoot, seriesDisplayName, DEFAULT_MAX_LEN,
} = require('../../src/main/dl-layout');
const DlRecordStore = require('../../src/main/dl-record');
const { DlDedupe, buildKey, setFs, ACTIVE_STATES } = require('../../src/main/dl-dedupe');
const Downloader = require('../../src/main/downloader');

/** 临时目录（测试结束统一清理）。 */
function tmpRoot(tag) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `yuki-dl-${tag}-`));
    return {
        root,
        cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* ignore */ } },
    };
}

// ============================================================================
describe('dl-layout：路径段清洗与布局计算（补既有测试的非法入参/边界分支）', () => {

    test('sanitizeSegment：非字符串入参按 String 转换，空结果回退 fallback', () => {
        assert.equal(sanitizeSegment(null), '');
        assert.equal(sanitizeSegment(undefined), '');
        assert.equal(sanitizeSegment(undefined, { fallback: '未命名' }), '未命名');
        assert.equal(sanitizeSegment(0), '0');                 // 数字 0 不是空值（?? 只挡 null/undefined）
        assert.equal(sanitizeSegment(false), 'false');
        assert.equal(sanitizeSegment({}), '[object Object]');
        assert.equal(sanitizeSegment(['a', 'b']), 'a,b');
        assert.equal(sanitizeSegment(''), '');
        assert.equal(sanitizeSegment('', { fallback: 'x' }), 'x');
    });

    test('sanitizeSegment：保留设备名全家族补下划线（大小写无关，含多级扩展名）', () => {
        assert.equal(sanitizeSegment('NUL'), 'NUL_');
        assert.equal(sanitizeSegment('prn'), 'prn_');
        assert.equal(sanitizeSegment(' Aux '), 'Aux_');         // 先 trim 再判定保留名
        assert.equal(sanitizeSegment('COM5'), 'COM5_');
        assert.equal(sanitizeSegment('lpt3'), 'lpt3_');
        assert.equal(sanitizeSegment('CON.a.b'), 'CON_.a.b');   // 多级扩展名整体保留
        assert.equal(sanitizeSegment('aux.docx'), 'aux_.docx');
        // 边界：COM0/COM10/LPT0 不在保留集合内；末尾数字 0 不合法
        assert.equal(sanitizeSegment('COM0'), 'COM0');
        assert.equal(sanitizeSegment('LPT0'), 'LPT0');
        assert.equal(sanitizeSegment('COM10'), 'COM10');
    });

    test('sanitizeSegment：控制字符含 DEL(\\x7f) 与制表换行；段内普通空格保留', () => {
        assert.equal(sanitizeSegment('a\x7fb'), 'ab');
        assert.equal(sanitizeSegment('a\tb\nc'), 'abc');        // \t/\n 属 \x00-\x1f 一并剔除
        assert.equal(sanitizeSegment('\r\n名字\r\n'), '名字');
        assert.equal(sanitizeSegment('剧 名 第 一 部'), '剧 名 第 一 部');
        assert.equal(sanitizeSegment('\x00\x1f\x7f'), '');
    });

    test('sanitizeSegment：长度恰等于 maxLen 不截断，超 1 码点才截；maxLen=0 走 fallback', () => {
        assert.equal(DEFAULT_MAX_LEN, 80);
        const exact = 'x'.repeat(80);
        assert.equal(sanitizeSegment(exact), exact);                 // 恰好等于：原样返回
        assert.equal(Array.from(sanitizeSegment('x'.repeat(81))).length, 80);
        assert.equal(sanitizeSegment('名字'.repeat(40)).length, 80);  // 80 码点中文
        assert.equal(sanitizeSegment('abc', { maxLen: 0 }), '');      // 0 上限 → 空 → 默认回退
        assert.equal(sanitizeSegment('abc', { maxLen: 0, fallback: 'F' }), 'F');
        assert.equal(sanitizeSegment('abc', { maxLen: 1 }), 'a');
    });

    test('sanitizeSegment：截断后残留的尾点/尾空格被二次清理', () => {
        // 前 80 码点末端恰好是点 → 截断后仍需清尾点
        const s = 'x'.repeat(79) + '. ' + '尾部';
        assert.equal(sanitizeSegment(s), 'x'.repeat(79));
        // 截断后末端是空格
        assert.equal(sanitizeSegment('y'.repeat(80) + ' 尾部'), 'y'.repeat(80));
        // 全是点空格 → 空串
        assert.equal(sanitizeSegment('. . .'), '');
        assert.equal(sanitizeSegment('   '), '');
    });

    test('sanitizeSegment：Unicode 与 emoji 按码点计数，不切开代理对', () => {
        assert.equal(sanitizeSegment('🎬番剧✨'), '🎬番剧✨');
        const emoji = '🎬'.repeat(10);
        assert.equal(Array.from(sanitizeSegment(emoji, { maxLen: 3 })).length, 3);
        assert.equal(sanitizeSegment(emoji, { maxLen: 3 }), '🎬🎬🎬');
        // 全角/组合字符不被误伤
        assert.equal(sanitizeSegment('Ｓｔｒａｎｇｅ'), 'Ｓｔｒａｎｇｅ');
        assert.equal(sanitizeSegment('がぎぐ'), 'がぎぐ');
    });

    test('sanitizeSegment：尾点尾空格混合与纯空白；结尾连点也清空', () => {
        assert.equal(sanitizeSegment('名字. .'), '名字');
        assert.equal(sanitizeSegment('名字。 '), '名字。');      // 中文句号不是非法字符
        assert.equal(sanitizeSegment('  \t\n '), '');
        assert.equal(sanitizeSegment('...'), '');
    });

    test('resolveSeriesTaskLayout：剧名含分隔符/保留名时目录仍为单层且可用', () => {
        const r = resolveSeriesTaskLayout({ dlRoot: 'D:\\dl', vodName: 'a/b\\CON', epName: '第1集', out: 'x.mp4' });
        assert.ok(r);
        assert.equal(r.folder, 'a_b_CON');
        assert.equal(r.dir, path.join('D:\\dl', 'a_b_CON'));
        assert.equal(path.relative('D:\\dl', r.dir), 'a_b_CON', '只比下载根目录深一级');
        // 根目录带尾分隔符时拼接不产生重复分隔符
        const r2 = resolveSeriesTaskLayout({ dlRoot: 'D:\\dl\\', vodName: '剧', epName: '第1集', out: 'x.mp4' });
        assert.equal(r2.dir, path.join('D:\\dl', '剧'));
    });

    test('resolveSeriesTaskLayout：集名含路径分隔符被清洗（产物不得逃逸子目录）', () => {
        const SEP = '\\';   // 避免源码里出现字面反斜杠转义歧义
        const ep = ['..', '..', 'evil.mp4'].join(SEP);
        const r = resolveSeriesTaskLayout({ dlRoot: 'D:\\dl', vodName: '剧', epName: ep, out: 'x.mp4' });
        // withSeriesPrefix 先拼剧名前缀（剧名不超长，prefix 保留完整）；分隔符 → 下划线
        assert.equal(r.file, '剧 - .._.._evil.mp4.mp4');
        assert.ok(!r.file.includes(SEP) && !r.file.includes('/'), '清洗后不得残留路径分隔符');
        assert.ok(!r.file.includes(':'));
        // 落在 <root>/<剧名>/ 下，不逃逸
        assert.equal(path.dirname(path.join(r.dir, r.file)), r.dir);
    });

    test('resolveSeriesTaskLayout：epName 与 out 都拿不到文件名时返回 null', () => {
        assert.equal(resolveSeriesTaskLayout({ dlRoot: 'D:\\dl', vodName: '剧', epName: '', out: '' }), null);
        assert.equal(resolveSeriesTaskLayout({ dlRoot: 'D:\\dl', vodName: '剧', epName: '   ', out: '.' }), null);
        assert.equal(resolveSeriesTaskLayout({ dlRoot: 'D:\\dl', vodName: '剧' }), null);
        assert.equal(resolveSeriesTaskLayout({}), null);           // 空入参
        assert.equal(resolveSeriesTaskLayout(), null);
        assert.equal(resolveSeriesTaskLayout({ dlRoot: 'D:\\dl', vodName: '...', epName: '第1集', out: 'x.mp4' }), null);
    });

    test('resolveSeriesTaskLayout：out 为路径时取 basename+扩展名，且不叠剧名前缀', () => {
        const r = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: '剧', epName: '', out: '/tmp/sub/第02集.mkv' });
        assert.equal(r.file, '第02集.mkv');
        assert.equal(r.dir, path.join('/dl', '剧'));
        // 多级扩展名（.tar.gz）只取最后一段
        const r2 = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: '剧', epName: '第1集', out: 'a.tar.gz' });
        assert.equal(r2.file, '剧 - 第1集.gz');
    });

    test('resolveSeriesTaskLayout：enabled 仅严格 false 才关闭（0/空串/undefined 仍启用）', () => {
        const base = { dlRoot: '/dl', vodName: '剧', epName: '第1集', out: 'x.mp4' };
        assert.equal(resolveSeriesTaskLayout({ ...base, enabled: false }), null);
        assert.ok(resolveSeriesTaskLayout({ ...base, enabled: 0 }));
        assert.ok(resolveSeriesTaskLayout({ ...base, enabled: '' }));
        assert.ok(resolveSeriesTaskLayout({ ...base, enabled: undefined }));
    });

    test('resolveSeriesTaskLayout：剧名超长时整体段长不越界、集名始终留在尾部', () => {
        const vod = '超长剧名'.repeat(30);
        const r = resolveSeriesTaskLayout({ dlRoot: '/dl', vodName: vod, epName: '第12集', out: 'x.mp4' });
        const stem = r.file.slice(0, r.file.length - path.extname(r.file).length);
        assert.ok(Array.from(stem).length <= DEFAULT_MAX_LEN);
        assert.ok(r.file.endsWith(' - 第12集.mp4'));
    });

    test('relUnderRoot：../ 穿越（末段/中段逃逸）、跨根目录、空入参均返回空串', () => {
        const t = tmpRoot('root');
        try {
            const root = path.join(t.root, 'dl');
            fs.mkdirSync(root);
            assert.equal(relUnderRoot(root, path.join(root, '..', 'secret', 'a.mp4')), '');
            assert.equal(relUnderRoot(root, path.join(root, 'a', '..', '..', 'b.mp4')), '');
            assert.equal(relUnderRoot(root, path.join(t.root, 'other', 'a.mp4')), '');   // 同级目录
            assert.equal(relUnderRoot(root, root + path.sep), '');
            assert.equal(relUnderRoot('', path.join(root, 'a.mp4')), '');
            assert.equal(relUnderRoot(null, path.join(root, 'a.mp4')), '');
            assert.equal(relUnderRoot(root, null), '');
            assert.equal(relUnderRoot(root, 0), '');
            if (process.platform === 'win32') {
                assert.equal(relUnderRoot('D:\\dl', 'E:\\dl\\a.mp4'), '', '盘符不同视为越界');
            }
        } finally { t.cleanup(); }
    });

    test('relUnderRoot：中段 .. 折叠后仍在根内时返回根内相对路径', () => {
        const t = tmpRoot('root');
        try {
            const root = path.join(t.root, 'dl');
            fs.mkdirSync(path.join(root, '剧'), { recursive: true });
            const p = path.join(root, '剧', '..', '第1集.mp4');
            assert.equal(relUnderRoot(root, p), '第1集.mp4');
            // 相对根目录（非绝对路径）按 cwd 解析后仍可用
            assert.equal(relUnderRoot(path.relative(process.cwd(), root), p), '第1集.mp4');
        } finally { t.cleanup(); }
    });

    test('seriesDisplayName：跳过 "." 与空项取首个有效产物；绝对路径 name 取 basename', () => {
        const t = tmpRoot('disp');
        try {
            const root = path.join(t.root, 'dl');
            const f = path.join(root, '剧A', '第01集.mp4');
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, 'x');
            assert.equal(seriesDisplayName({ dlRoot: root, files: ['.', '', null, f], name: f }), '剧A - 第01集.mp4');
            assert.equal(seriesDisplayName({ dlRoot: root, files: [f] }), '剧A - 第01集.mp4');
            assert.equal(seriesDisplayName({ dlRoot: root, files: [f], name: 'x' }), '剧A - x');
            assert.equal(seriesDisplayName({ dlRoot: root, files: ['.', ''], name: 'a.mp4' }), '');
        } finally { t.cleanup(); }
    });

    test('seriesDisplayName：无扩展名与多级扩展名文件的 stem 判定', () => {
        const root = path.resolve('/dl');
        // 无扩展名：stem === base，与 folder 不同 → 补前缀
        assert.equal(seriesDisplayName({
            dlRoot: root, files: [path.join(root, '剧B', '第02集')], name: '第02集',
        }), '剧B - 第02集');
        // 多级扩展名只剥最后一段：stem=' pack.tar' ≠ folder → 补剧名前缀
        assert.equal(seriesDisplayName({
            dlRoot: root, files: [path.join(root, '剧C', 'pack.tar.gz')], name: 'pack.tar.gz',
        }), '剧C - pack.tar.gz');
        // name 为纯扩展名时 path.extname('.mkv')==='' → stem='.mkv' ≠ folder → 补前缀
        assert.equal(seriesDisplayName({
            dlRoot: root, files: [path.join(root, '剧D', '.mkv')], name: '.mkv',
        }), '剧D - .mkv');
    });
});

// ============================================================================
describe('dl-record：持久化兜底、上限淘汰与写盘时机（补既有测试的损坏/边界分支）', () => {

    test('首次 add 自动创建父目录与文件（文件原本不存在）', () => {
        const t = tmpRoot('rec');
        try {
            const file = path.join(t.root, 'nested', 'deep', 'dl-records.json');
            assert.equal(fs.existsSync(file), false);
            const store = new DlRecordStore(file);
            store.add({ gid: 'a', name: '新建', status: 'complete' });
            assert.ok(fs.existsSync(file), '应自动创建目录与文件');
            assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1);
            assert.equal(store.all().length, 1);
        } finally { t.cleanup(); }
    });

    test('损坏文件兜底：空文件 / 非数组（对象、字符串、null、数字）一律视为空', () => {
        const t = tmpRoot('rec');
        try {
            const cases = ['', '   ', '{', '{"a":1}', '"str"', 'null', '123', '[]'];
            for (const raw of cases) {
                const file = path.join(t.root, `c${cases.indexOf(raw)}.json`);
                fs.writeFileSync(file, raw);
                const store = new DlRecordStore(file);
                assert.deepEqual(store.all(), [], `兜底失败：${JSON.stringify(raw)}`);
            }
            // 数组内混入非对象元素（缺字段）仍能读回，不被丢弃
            const file2 = path.join(t.root, 'mixed.json');
            fs.writeFileSync(file2, '[null, 1, {"gid":"g1"}, {"gid":"g2","status":"complete"}]');
            assert.equal(new DlRecordStore(file2).all().length, 4);
        } finally { t.cleanup(); }
    });

    test('缺字段记录可写入；clearFinished 视无 status 记录为「已结束」清除', () => {
        const t = tmpRoot('rec');
        try {
            const store = new DlRecordStore(path.join(t.root, 'r.json'));
            store.add({ gid: 'g1' });                       // 无 status
            store.add({ gid: 'g2', status: 'active' });
            store.add({ gid: 'g3', status: 'paused' });
            store.add({ gid: 'g4', status: 'removed' });
            assert.equal(store.all().length, 4);
            store.clearFinished();                          // 仅保留 active/waiting/paused
            assert.deepEqual(store.all().map((r) => r.gid), ['g3', 'g2']);
        } finally { t.cleanup(); }
    });

    test('记录上限 200：超出丢最旧，最新在首位', () => {
        const t = tmpRoot('rec');
        try {
            const store = new DlRecordStore(path.join(t.root, 'r.json'));
            for (let i = 0; i < 250; i++) store.add({ gid: `g${i}`, status: 'complete' });
            const all = store.all();
            assert.equal(all.length, 200);
            assert.equal(all[0].gid, 'g249', '最新在前');
            assert.equal(all.some((r) => r.gid === 'g0'), false, '最旧被淘汰');
            assert.equal(all.some((r) => r.gid === 'g49'), false);
            assert.equal(all.some((r) => r.gid === 'g50'), true, '第 50 条起保留');
            // 淘汰同样落盘
            assert.equal(JSON.parse(fs.readFileSync(path.join(t.root, 'r.json'), 'utf8')).length, 200);
        } finally { t.cleanup(); }
    });

    test('同 gid 重复 add：覆盖并前移到最新位置（不产生重复）', () => {
        const t = tmpRoot('rec');
        try {
            const store = new DlRecordStore(path.join(t.root, 'r.json'));
            store.add({ gid: 'a', v: 1, status: 'active' });
            store.add({ gid: 'b', v: 1, status: 'active' });
            store.add({ gid: 'a', v: 2, status: 'complete' });
            const all = store.all();
            assert.deepEqual(all.map((r) => r.gid), ['a', 'b']);
            assert.equal(all[0].v, 2);
        } finally { t.cleanup(); }
    });

    test('写盘时机：无变化的操作（remove 不存在 gid / clear 空表 / clearFinished 无已结束）不落盘', () => {
        const t = tmpRoot('rec');
        try {
            const store = new DlRecordStore(path.join(t.root, 'r.json'));
            let saves = 0;
            store._save = () => { saves++; };               // 桩：只计次数不真写
            store.remove('not-exist');
            store.clear();
            store.clearFinished();
            store.clearErrors();
            assert.equal(saves, 0, '空操作不应触发写盘');

            store.add({ gid: 'a', status: 'active' });
            assert.equal(saves, 1);
            store.remove('a');
            assert.equal(saves, 2, '真实删除才落盘');
            store.add({ gid: 'b', status: 'error' });
            store.clearErrors();
            assert.equal(saves, 4);
        } finally { t.cleanup(); }
    });

    test('持久化往返保真：中文、数组、嵌套对象、数字/布尔/null 原样读回', () => {
        const t = tmpRoot('rec');
        try {
            const file = path.join(t.root, 'r.json');
            const rec = {
                gid: 'gid-中文',
                name: '葬送のフリーレン - 第01集.mp4',
                status: 'complete',
                files: ['D:\\dl\\剧\\第01集.mp4', '.'],
                percent: 100, done: 123456789, size: 0,
                epKey: 'site|剧|第01集',
                meta: { nested: { ok: true, nothing: null } },
            };
            new DlRecordStore(file).add(rec);
            assert.deepEqual(new DlRecordStore(file).all()[0], rec);
        } finally { t.cleanup(); }
    });

    test('落盘失败（父路径不可创建）不抛异常，内存记录仍可读', () => {
        const t = tmpRoot('rec');
        try {
            const blocker = path.join(t.root, 'blocker');
            fs.writeFileSync(blocker, 'x');                  // 用文件挡住 mkdir
            const store = new DlRecordStore(path.join(blocker, 'sub', 'r.json'));
            assert.doesNotThrow(() => store.add({ gid: 'a', status: 'complete' }));
            assert.equal(store.all().length, 1, '落盘失败不影响内存视图');
        } finally { t.cleanup(); }
    });

    test('批量连续写入 60 次：文件始终是合法 JSON，最终条数与内容正确', () => {
        const t = tmpRoot('rec');
        try {
            const file = path.join(t.root, 'r.json');
            const store = new DlRecordStore(file);
            for (let i = 0; i < 60; i++) {
                store.add({ gid: `g${i}`, status: i % 2 ? 'complete' : 'error', size: i });
                assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), `第 ${i} 次写入后文件损坏`);
            }
            const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
            assert.equal(onDisk.length, 60);
            assert.equal(onDisk[0].gid, 'g59');
            // 不残留 .tmp 中间文件（rename 原子替换）
            assert.equal(fs.existsSync(file + '.tmp'), false);
        } finally { t.cleanup(); }
    });

    test('缺省 filePath（无 Electron userData 环境）不抛异常，退化为内存记录', () => {
        const store = new DlRecordStore();                   // 不传路径
        assert.doesNotThrow(() => store.add({ gid: 'a', status: 'complete' }));
        assert.equal(store.all().length, 1);
        assert.doesNotThrow(() => { store.remove('a'); store.clear(); });
    });

    test('懒加载现状：两个实例各自先读后加 → 后者覆盖前者记录（同文件多写者丢记录）', () => {
        const t = tmpRoot('rec');
        try {
            const file = path.join(t.root, 'r.json');
            const s1 = new DlRecordStore(file);
            const s2 = new DlRecordStore(file);
            s1.add({ gid: 'a', status: 'complete' });   // 载入 [] → 写 [a]
            assert.deepEqual(s2.all().map((r) => r.gid), ['a'], '惰性加载：构造时不读盘，此刻才加载');
            s2.add({ gid: 'b', status: 'complete' });   // 载入 [a] → 写 [b, a]
            assert.deepEqual(new DlRecordStore(file).all().map((r) => r.gid), ['b', 'a']);
        } finally { t.cleanup(); }
    });

    test('add 忽略无效入参（null / 无 gid），不写盘不记录', () => {
        const t = tmpRoot('rec');
        try {
            const store = new DlRecordStore(path.join(t.root, 'r.json'));
            let saves = 0;
            store._save = () => { saves++; };
            store.add(null);
            store.add(undefined);
            store.add({});
            store.add({ name: '无 gid', status: 'complete' });
            store.add({ gid: '', status: 'complete' });
            assert.equal(store.all().length, 0);
            assert.equal(saves, 0);
        } finally { t.cleanup(); }
    });
});

// ============================================================================
describe('downloader：RPC/启动/状态机内部分支（HTTP 与子进程全部注入桩）', () => {

    /**
     * 用注入桩加载真实 downloader.js：不 spawn 真进程、不出网、不依赖 Electron。
     * @param {object} o existsSync/onRequest/onSpawn/onExecSync/proxyUrl/appPath
     */
    function loadDownloader(o = {}) {
        const mkdirs = [];
        const deps = {
            './system-proxy': { getProxyUrl: () => (o.proxyUrl || '') },
            electron: { app: { isPackaged: false, getPath: () => (o.appPath || 'D:\\Downloads') } },
            fs: {
                existsSync: o.existsSync || (() => true),
                mkdirSync: (p) => { mkdirs.push(String(p)); },
            },
            child_process: {
                spawn: o.onSpawn || (() => { throw new Error('spawn 未桩化'); }),
                execSync: o.onExecSync || (() => { throw new Error('execSync 未桩化'); }),
            },
        };
        if (o.onRequest) deps.http = { request: o.onRequest };
        const mod = { exports: {} };
        const req = (id) => (Object.prototype.hasOwnProperty.call(deps, id) ? deps[id] : require(id));
        const src = fs.readFileSync(DOWNLOADER_SRC, 'utf8');
        // 用 Function 包装真实源码（同 realm，Buffer/JSON 等全局可用），仅替换 require 解析
        new Function('require', 'module', '__dirname', '__filename', src)(
            req, mod, path.dirname(DOWNLOADER_SRC), DOWNLOADER_SRC,
        );
        return { Downloader: mod.exports, mkdirs };
    }

    /**
     * HTTP 桩：handler(opts, body) 返回 { json } | { raw } | { socketError } | { timeout }。
     */
    function makeHttpStub(handler) {
        const calls = [];
        const request = (opts, cb) => {
            const req = new EventEmitter();
            let body = '';
            req.write = (c) => { body += c; };
            req.end = () => {
                calls.push({ opts, body });
                setImmediate(() => {
                    const out = handler(opts, body) || {};
                    if (out.socketError) return req.emit('error', out.socketError);
                    if (out.timeout) return req.emit('timeout');
                    const res = new EventEmitter();
                    cb(res);
                    setImmediate(() => {
                        res.emit('data', out.raw !== undefined ? out.raw : JSON.stringify(out.json));
                        res.emit('end');
                    });
                });
            };
            req.destroy = (err) => setImmediate(() => req.emit('error', err));
            return req;
        };
        return { httpStub: { request }, calls };
    }

    /** 造一个「已在运行」的引擎实例（proc/port/secret 手工置位，_rpc 走桩）。 */
    function runningEngine(handler) {
        const { httpStub, calls } = makeHttpStub(handler);
        const { Downloader: D } = loadDownloader({ onRequest: httpStub.request });
        const d = new D();
        d.proc = { fake: true };
        d.port = 12345;
        d.secret = 'sec-xyz';
        return { d, calls };
    }

    test('_rpc：请求体带 token:secret 与 aria2.<method> 前缀，成功解析 result', async () => {
        const { d, calls } = runningEngine(() => ({ json: { result: { gid: 'g1' } } }));
        const r = await d.tellStatus('g1');
        assert.deepEqual(r, { gid: 'g1' });
        const body = JSON.parse(calls[0].body);
        assert.equal(body.method, 'aria2.tellStatus');
        assert.equal(body.jsonrpc, '2.0');
        assert.deepEqual(body.params, ['token:sec-xyz', 'g1']);
        assert.equal(calls[0].opts.host, '127.0.0.1');
        assert.equal(calls[0].opts.port, 12345);
        assert.equal(calls[0].opts.path, '/jsonrpc');
    });

    test('_rpc：服务端 error 字段 → reject(message)；非 JSON 响应 → reject(bad rpc response)', async () => {
        const a = runningEngine(() => ({ json: { error: { code: 1, message: 'gid not found' } } }));
        await assert.rejects(a.d.tellStatus('x'), /gid not found/);
        const b = runningEngine(() => ({ raw: '<html>502</html>' }));
        await assert.rejects(b.d.tellStatus('x'), /bad rpc response/);
        // error 无 message 时回退 'rpc error'
        const c = runningEngine(() => ({ json: { error: { code: 9 } } }));
        await assert.rejects(c.d.tellStatus('x'), /rpc error/);
    });

    test('_rpc：socket error 与 timeout 都 reject（不静默挂起）', async () => {
        const a = runningEngine(() => ({ socketError: new Error('ECONNREFUSED') }));
        await assert.rejects(a.d.tellStatus('x'), /ECONNREFUSED/);
        const b = runningEngine(() => ({ timeout: true }));
        await assert.rejects(b.d.tellStatus('x'), /rpc timeout/);
    });

    test('_rpc：引擎未运行（proc 为空）直接 reject aria2 not running 且不发请求', async () => {
        const { httpStub, calls } = makeHttpStub(() => ({ json: { result: 1 } }));
        const { Downloader: D } = loadDownloader({ onRequest: httpStub.request });
        const d = new D();
        d.proc = null;
        await assert.rejects(d.tellStatus('x'), /aria2 not running/);
        assert.equal(calls.length, 0);
    });

    test('addUri：磁链自动补 bt-tracker；普通 http 链接不补', async () => {
        const { d, calls } = runningEngine(() => ({ json: { result: 'gid1' } }));
        await d.addUri(['magnet:?xt=urn:btih:ABC']);
        const magnetOpts = JSON.parse(calls[0].body).params[2];
        assert.ok(String(magnetOpts['bt-tracker']).includes('udp://tracker.opentrackr.org:1337/announce'));
        assert.ok(String(magnetOpts['bt-tracker']).split(',').length >= 10);

        await d.addUri(['https://example.com/a.mp4'], { dir: '/x' });
        const plainOpts = JSON.parse(calls[1].body).params[2];
        assert.equal('bt-tracker' in plainOpts, false);
        assert.equal(plainOpts.dir, '/x');
        assert.deepEqual(JSON.parse(calls[1].body).params[1], ['https://example.com/a.mp4']);
    });

    test('addUri：系统代理注入 httpProxy/httpsProxy；无代理时不加字段', async () => {
        const withProxy = makeHttpStub(() => ({ json: { result: 'g' } }));
        const A = loadDownloader({ onRequest: withProxy.httpStub.request, proxyUrl: 'http://127.0.0.1:7890' });
        const d1 = new A.Downloader();
        d1.proc = {}; d1.port = 1; d1.secret = 's';
        await d1.addUri(['https://a/b.mp4']);
        const opts1 = JSON.parse(withProxy.calls[0].body).params[2];
        assert.equal(opts1.httpProxy, 'http://127.0.0.1:7890');
        assert.equal(opts1.httpsProxy, 'http://127.0.0.1:7890');

        const noProxy = makeHttpStub(() => ({ json: { result: 'g' } }));
        const B = loadDownloader({ onRequest: noProxy.httpStub.request, proxyUrl: '' });
        const d2 = new B.Downloader();
        d2.proc = {}; d2.port = 1; d2.secret = 's';
        await d2.addUri(['https://a/b.mp4']);
        assert.equal('httpProxy' in JSON.parse(noProxy.calls[0].body).params[2], false);
    });

    test('start：并发与分片上下限裁剪（0 视为未设置，保持默认 3/5）', async () => {
        const spawnArgs = [];
        const { Downloader: D, mkdirs } = loadDownloader({
            onSpawn: (bin, args) => {
                spawnArgs.push({ bin, args });
                const proc = new EventEmitter();
                proc.stderr = new EventEmitter();
                proc.kill = () => {};
                return proc;
            },
            onRequest: makeHttpStub(() => ({ json: { result: { version: '1.37.0' } } })).httpStub.request,
            appPath: 'D:\\MyDownloads',
        });
        const d = new D();
        await d.start('', 99, 999);
        assert.equal(d.concurrency, 10);
        assert.equal(d.split, 32);
        assert.equal(d.dir, 'D:\\MyDownloads');
        assert.deepEqual(mkdirs, ['D:\\MyDownloads']);

        const d2 = new D();
        await d2.start('E:\\dl', 0, 0);         // 0 为 falsy → 不改写，保持默认
        assert.equal(d2.concurrency, 3);
        assert.equal(d2.split, 5);
        assert.equal(d2.dir, 'E:\\dl');

        const d3 = new D();
        await d3.start('E:\\dl', -7, 1);
        assert.equal(d3.concurrency, 1);
        assert.equal(d3.split, 1);
        assert.equal(spawnArgs.length, 3, '三次 start 各 spawn 一次');
    });

    test('start：spawn 参数含 secret/dir/split/BT 端口区间与 tracker', async () => {
        const captured = [];
        const { Downloader: D } = loadDownloader({
            onSpawn: (bin, args) => {
                captured.push({ bin, args });
                const proc = new EventEmitter();
                proc.stderr = new EventEmitter();
                proc.kill = () => {};
                return proc;
            },
            onRequest: makeHttpStub(() => ({ json: { result: {} } })).httpStub.request,
        });
        const d = new D();
        await d.start('D:\\dl', 4, 6);
        const { args, bin } = captured[0];
        assert.ok(bin.endsWith('aria2c.exe'));
        const get = (k) => args.find((a) => a.startsWith(`--${k}=`));
        assert.equal(get('max-concurrent-downloads'), '--max-concurrent-downloads=4');
        assert.equal(get('split'), '--split=6');
        assert.equal(get('max-connection-per-server'), '--max-connection-per-server=6');
        assert.equal(get('dir'), '--dir=D:\\dl');
        assert.ok(get('rpc-secret').startsWith('--rpc-secret='));
        const port = parseInt(get('rpc-listen-port').split('=')[1], 10);
        assert.ok(port >= 10000 && port <= 29999, 'RPC 端口落在 10000-29999');
        const bt = parseInt(get('dht-listen-port').split('=')[1], 10);
        assert.ok(bt >= 16881 && bt <= 17880, 'DHT 端口落在 aria2 合法区间且避开默认段');
        assert.equal(get('listen-port'), `--listen-port=${bt}`);
        assert.ok(get('bt-tracker').includes('udp://') && get('bt-tracker').includes('http://'));
        assert.ok(args.includes('--enable-dht=true') && args.includes('--quiet'));
        assert.equal(args.some((a) => a.includes('http-proxy')), false, '代理不烘焙进 CLI');
    });

    test('start：二进制缺失 → reject(aria2-missing)，且不 spawn', async () => {
        const { Downloader: D } = loadDownloader({
            existsSync: () => false,
            onExecSync: () => { throw new Error('not in PATH'); },
            onSpawn: () => { throw new Error('不应 spawn'); },
        });
        const d = new D();
        assert.equal(d.isAvailable(), false);
        await assert.rejects(d.start('D:\\dl'), /aria2-missing/);
        assert.equal(d.proc, null);
        assert.equal(d._ready, null);
    });

    test('_waitReady：进程启动即退出时立即抛出，并带 spawn error / exit code / stderr 诊断', async () => {
        const t = tmpRoot('aria');
        try {
            const procs = [];
            const { Downloader: D } = loadDownloader({
                onSpawn: () => {
                    const proc = new EventEmitter();
                    proc.stderr = new EventEmitter();
                    proc.kill = () => {};
                    procs.push(proc);
                    return proc;
                },
                appPath: t.root,
            });
            const d = new D();
            d.getVersion = async () => {
                d.proc = null;                     // 模拟进程死亡
                d._spawnError = 'spawn EPERM';
                d._exitCode = 28;
                d._stderrBuf = 'line1\nline2\nline3';
                throw new Error('dead');
            };
            await assert.rejects(d.start(t.root), (err) => {
                assert.match(err.message, /aria2 process exited before rpc ready/);
                assert.match(err.message, /spawn error: spawn EPERM/);
                assert.match(err.message, /exit code=28/);
                assert.match(err.message, /stderr: line1 \| line2 \| line3/);
                return true;
            });
            assert.equal(d._ready, null, '失败后应复位以便重试');
        } finally { t.cleanup(); }
    });

    test('_waitReady：探测超时抛 aria2 rpc not ready 并附 stderr 尾部；成功则立即返回 true', async () => {
        const { Downloader: D } = loadDownloader({});
        const d = new D();
        d.proc = {};
        d._stderrBuf = '地址已被占用';
        d.getVersion = async () => { throw new Error('not yet'); };
        await assert.rejects(d._waitReady(1), /aria2 rpc not ready · stderr: 地址已被占用/);

        const d2 = new D();
        d2.proc = {};
        let n = 0;
        d2.getVersion = async () => { n++; return { version: '1.37.0' }; };
        assert.equal(await d2._waitReady(200), true);
        assert.equal(n, 1, '首次探测即成功时不空转');
    });

    test('stderr 缓冲只保留最后 500 字符（长日志不占内存）', async () => {
        // 走真实 start() 路径：之前在测试体内手工复刻了 start 里的 stderr 监听注册
        // （注释自承"复现 start 内的监听注册"），断言的是测试副本而非真实实现——
        // 若源码删除该监听、把 slice(-500) 改成 1000，此用例依然通过，零回归检出能力。
        let spawnedProc = null;
        const { Downloader: D } = loadDownloader({
            onSpawn: () => {
                spawnedProc = new EventEmitter();
                spawnedProc.stderr = new EventEmitter();
                spawnedProc.kill = () => {};
                return spawnedProc;
            },
            onRequest: makeHttpStub(() => ({ json: { result: { version: '1.37.0' } } })).httpStub.request,
        });
        const d = new D();
        await d.start('D:\\dl');
        assert.ok(spawnedProc, 'start 必须 spawn aria2 进程');
        // 通过真实 start() 注册的监听器驱动 stderr data
        spawnedProc.stderr.emit('data', Buffer.from('A'.repeat(400)));
        spawnedProc.stderr.emit('data', Buffer.from('B'.repeat(400)));
        assert.equal(d._stderrBuf.length, 500);
        assert.ok(d._stderrBuf.endsWith('B'));
        assert.ok(d._stderrBuf.startsWith('A'));
    });

    test('stop：kill 进程、清空通知集合与诊断字段', () => {
        const { Downloader: D } = loadDownloader({});
        const d = new D();
        let killed = 0;
        d.proc = { kill: () => { killed++; } };
        d._ready = Promise.resolve(true);
        d._notified.add('g1');
        d._notified.add('eG2');
        d._exitCode = 1; d._spawnError = 'x'; d._stderrBuf = 'y';
        d.stop();
        assert.equal(killed, 1);
        assert.equal(d.proc, null);
        assert.equal(d._ready, null);
        assert.equal(d._notified.size, 0);
        assert.equal(d._exitCode, null);
        assert.equal(d._spawnError, '');
        assert.equal(d._stderrBuf, '');
        d.stop();                                    // 幂等
        assert.equal(killed, 1);
    });

    test('旧进程迟到 exit 不清新进程的 proc/_ready（H-9 回归）', async () => {
        const procs = [];
        const { Downloader: D } = loadDownloader({
            onSpawn: () => {
                const p = new EventEmitter();
                p.stderr = new EventEmitter();
                p.kill = () => {};
                procs.push(p);
                return p;
            },
            onRequest: makeHttpStub(() => ({ json: { result: {} } })).httpStub.request,
        });
        const d = new D();
        await d.start('D:\\dl');
        const old = procs[0];
        assert.equal(d.proc, old);

        // 模拟 stop→start：旧进程对象被换掉，但旧进程的 exit 事件迟到
        let killed = 0;
        const fresh = { kill: () => { killed++; } };
        d.proc = fresh;
        d._ready = Promise.resolve(true);
        d._exitCode = null;
        old.emit('exit', 1);
        assert.equal(d.proc, fresh, '迟到 exit 不得清空新进程');
        assert.ok(d._ready, '迟到 exit 不得复位 _ready');
        assert.equal(d._exitCode, 1, '诊断信息照常记录（含旧进程迟到 exit）');
        assert.equal(killed, 0, 'stop() 之外不得顺带 kill 新进程');
        d.stop();
    });

    test('spawn error 事件：置空 proc 与 _ready 并记录错误信息（未监听不崩进程）', async () => {
        const procs = [];
        const { Downloader: D } = loadDownloader({
            onSpawn: () => {
                const p = new EventEmitter();
                p.stderr = new EventEmitter();
                p.kill = () => {};
                procs.push(p);
                return p;
            },
            // 桩的 existsSync 不区分子进程与其他路径，恒真即可；http 探测恒失败
            existsSync: () => true,
            onRequest: makeHttpStub(() => ({ socketError: new Error('ECONNREFUSED') })).httpStub.request,
        });
        const d = new D();
        // RPC 探测恒失败（模拟进程已死、端口不通），_waitReady 才会进入下一轮并看到 proc 被清空
        const started = d.start('D:\\dl');
        procs[0].emit('error', new Error('spawn EACCES')); // 源码内已注册 'error' 监听
        // 抛出的诊断信息带上真实 spawn 原因（而非笼统的 rpc not ready）
        await assert.rejects(started, /aria2 process exited before rpc ready · spawn error: spawn EACCES/);
        assert.equal(d.proc, null, 'spawn error 应置空 proc');
        assert.equal(d._ready, null, '失败后复位 _ready 以便下次重试');
        // start 失败分支会调 stop()，诊断字段随之复位（下次启动不带上次残留）
        assert.equal(d._spawnError, '');
        assert.equal(d._exitCode, null);
    });

    test('setConcurrency/setSplit：运行中走短横线键名 changeGlobalOption；未启动只改内存', async () => {
        const { d, calls } = runningEngine(() => ({ json: { result: 'OK' } }));
        assert.equal(await d.setConcurrency(7), 7);
        assert.deepEqual(JSON.parse(calls[0].body).params[1], { 'max-concurrent-downloads': '7' });
        assert.equal(await d.setSplit(9), 9);
        assert.deepEqual(JSON.parse(calls[1].body).params[1], { split: '9', 'max-connection-per-server': '9' });
        assert.equal(await d.setConcurrency(0), 1);          // 下限裁剪
        assert.equal(await d.setConcurrency(99), 10);
        assert.equal(await d.setSplit(0), 1);
        assert.equal(await d.setSplit(999), 32);

        const idle = new (loadDownloader({}).Downloader)();
        assert.equal(await idle.setConcurrency(5), 5);        // proc 为空：不发 RPC
        assert.equal(await idle.setSplit(5), 5);
        assert.equal(idle.proc, null);
    });

    test('remove：remove→forceRemove→removeDownloadResult 三级回退并清通知标记', async () => {
        // ① remove 失败 → forceRemove 成功
        const d1 = new Downloader();
        d1._notified.add('g1'); d1._notified.add('eg1');
        const seen1 = [];
        d1._rpc = async (m) => {
            seen1.push(m);
            if (m === 'remove') throw new Error('not active');
            return 'ok:' + m;
        };
        assert.equal(await d1.remove('g1'), 'ok:forceRemove');
        assert.deepEqual(seen1, ['remove', 'forceRemove']);

        // ② 前两级都失败 → removeDownloadResult，再失败则回退 gid
        const d2 = new Downloader();
        d2._notified.add('g2');
        const seen2 = [];
        d2._rpc = async (m) => { seen2.push(m); throw new Error('all fail'); };
        assert.equal(await d2.remove('g2'), 'g2');
        assert.deepEqual(seen2, ['remove', 'forceRemove', 'removeDownloadResult']);
        assert.equal(d2._notified.has('g2'), false, 'remove 后应清通知标记');
        assert.equal(d2._notified.has('eg2'), false);
    });

    test('purge：清 stopped 记录并清通知标记（失败也会清）', async () => {
        const d = new Downloader();
        d._notified.add('g1');
        const seen = [];
        d._rpc = async (m) => { seen.push(m); return 'purged'; };
        assert.equal(await d.purge('g1'), 'purged');
        assert.deepEqual(seen, ['removeDownloadResult']);
        assert.equal(d._notified.size, 0);

        const d2 = new Downloader();
        d2._notified.add('g9');
        d2._rpc = async () => { throw new Error('boom'); };
        await assert.rejects(d2.purge('g9'), /boom/);
        assert.equal(d2._notified.has('g9'), false, 'RPC 失败也清标记');
    });

    test('pauseAll/unpauseAll：按 status 过滤，部分失败只返回成功的 gid', async () => {
        const d = new Downloader();
        d.tellActive = async () => [{ gid: 'a1', status: 'active' }, { gid: 'a2', status: 'active' }];
        d.tellWaiting = async () => [
            { gid: 'w1', status: 'waiting' },
            { gid: 'p1', status: 'paused' },
            { gid: 'bad', status: 'waiting' },
            { status: 'waiting' },                  // 无 gid：跳过
        ];
        d.pause = async (gid) => { if (gid === 'bad') throw new Error('nope'); return gid; };
        assert.deepEqual(await d.pauseAll(), ['a1', 'a2', 'w1']);

        d.unpause = async (gid) => { if (gid === 'p1') throw new Error('nope'); return gid; };
        assert.deepEqual(await d.unpauseAll(), []);      // 唯一 paused 任务失败 → 空
        d.unpause = async (gid) => gid;
        assert.deepEqual(await d.unpauseAll(), ['p1']);
    });

    test('listAll：complete/error 按 gid 去重一次；removed 等未知状态不触发事件', async () => {
        const d = new Downloader();
        d.dir = 'D:\\dl';
        d._ready = Promise.resolve(true);
        const tasks = [
            { gid: 'g1', status: 'complete', files: [{ path: 'D:\\dl\\a.mp4' }] },
            { gid: 'g2', status: 'error', errorMessage: 'x' },
            { gid: 'g3', status: 'removed' },
            { gid: 'g4', status: 'whatever' },
        ];
        d.tellActive = async () => [];
        d.tellWaiting = async () => [];
        d.tellStopped = async () => tasks;
        const done = [];
        const errs = [];
        d.on('completed', (t) => done.push(t.gid));
        d.on('error', (t) => errs.push(t.gid));
        const all = await d.listAll();
        assert.deepEqual(done, ['g1']);
        assert.deepEqual(errs, ['g2']);
        assert.equal(all.length, 4);
        assert.equal(all[2].status, 'removed');

        await d.listAll();                              // 第二遍不再通知
        assert.deepEqual(done, ['g1']);
        assert.deepEqual(errs, ['g2']);

        d._forgetNotified('g1');                        // 清标记后可再次通知
        await d.listAll();
        assert.deepEqual(done, ['g1', 'g1']);
    });

    test('listAll：监听器抛异常以 Promise reject 冒泡（不崩进程），且标记已计入不重复通知', async () => {
        const d = new Downloader();
        d.dir = 'D:\\dl';
        d._ready = Promise.resolve(true);
        d.tellActive = async () => [];
        d.tellWaiting = async () => [];
        d.tellStopped = async () => [{ gid: 'g1', status: 'complete' }];
        d.on('completed', () => { throw new Error('监听器炸了'); });
        await assert.rejects(d.listAll(), /监听器炸了/);
        assert.equal(d._notified.has('g1'), true, '异常前已完成标记，避免反复通知');
    });

    test('listAll：引擎未启动（dir 为空）返回空数组且不改写 dir', async () => {
        const d = new Downloader();
        assert.deepEqual(await d.listAll(), []);
        assert.equal(d.dir, '');
        assert.equal(d.proc, null);
    });

    test('flatten：total 为 0 时 percent=0；百分比保留一位小数；未知状态原样透传', () => {
        assert.equal(Downloader.flatten({ gid: 'a', status: 'removed', totalLength: '0', completedLength: '0' }).percent, 0);
        assert.equal(Downloader.flatten({ gid: 'a', status: 'paused', totalLength: '3', completedLength: '1' }).percent, 33.3);
        assert.equal(Downloader.flatten({ gid: 'a', status: 'waiting', totalLength: '7', completedLength: '1' }).percent, 14.3);
        assert.equal(Downloader.flatten({ gid: 'a', status: 'removed' }).status, 'removed');
        assert.deepEqual(Downloader.flatten({ gid: 'a', status: 'active' }).files, []);
        assert.equal(Downloader.flatten({ gid: 'a', status: 'active' }).name, '');
        assert.equal(Downloader.flatten({ gid: 'a', status: 'active' }).uri, '');
    });

    test('flatten：BT infoHash 生成大写 magnet URI；safeDecode 裸 % 回退原串', () => {
        const f = Downloader.flatten({ gid: 'b', status: 'active', bittorrent: { info: { name: '种子', infoHash: 'abc123' } } });
        assert.equal(f.uri, 'magnet:?xt=urn:btih:ABC123', '无 uris 的 BT 任务生成大写 magnet');
        assert.equal(f.name, '种子');
        // 有 uris 时优先取 uris[0].uri（BT 与直链一致）
        const f2 = Downloader.flatten({
            gid: 'b2', status: 'active',
            bittorrent: { info: { name: '种子', infoHash: 'abc123' } },
            files: [{ uris: [{ uri: 'http://x/y' }] }],
        });
        assert.equal(f2.uri, 'http://x/y');
        assert.equal(Downloader.safeDecode('%E8%A7%86%E9%A2%91'), '视频');
        assert.equal(Downloader.safeDecode('100%bad'), '100%bad');
        // 文件路径尾部带分隔符时 basename 仍正确
        const f3 = Downloader.flatten({ gid: 'c', status: 'complete', files: [{ path: 'D:\\dl\\剧\\\\' }] });
        assert.equal(f3.name, '剧');
    });
});

// ============================================================================
describe('dl-dedupe：与 dl-record 联动的边界（中间态/孤儿/并发/真实 fs）', () => {

    // 模块级 fs 替身：只有登记进 existing 的路径视为存在（不触碰真实磁盘）
    const existing = new Set();
    const stubFs = { existsSync: (p) => existing.has(String(p)) };
    setFs(stubFs);

    // 统一收集 makeStore 创建的临时目录，describe 结束后一并清理（之前
    // mkdtempSync 创建的 9 个目录从不清理，每次运行向 %TEMP% 泄漏）。
    const TMP_DIRS = [];
    after(() => {
        for (const d of TMP_DIRS) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        }
        TMP_DIRS.length = 0;
    });

    function makeStore() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-dl-dedupe2-'));
        TMP_DIRS.push(dir);
        return new DlRecordStore(path.join(dir, 'dl-records.json'));
    }

    test('check：记录为中间态（paused/waiting）且引擎任务存活 → downloading', async () => {
        const store = makeStore();
        const d = new DlDedupe(store, async () => [{ gid: 'g1', status: 'paused' }]);
        d.bind('g1', 's|v|e1', { kind: 'aria2', name: 'x', files: [], status: 'paused', uri: 'u' });
        assert.deepEqual(await d.check('s|v|e1'), { state: 'downloading', gid: 'g1' });

        const d2 = new DlDedupe(store, async () => [{ gid: 'g1', status: 'waiting' }]);
        assert.equal((await d2.check('s|v|e1')).state, 'downloading');
        assert.deepEqual(ACTIVE_STATES, ['active', 'waiting', 'paused']);
    });

    test('check：记录为中间态但引擎中该任务已结束 → 放行（以引擎实时状态为准）', async () => {
        const store = makeStore();
        const d = new DlDedupe(store, async () => [{ gid: 'g1', status: 'complete' }, { gid: 'g2', status: 'error' }]);
        d.bind('g1', 's|v|e1', { kind: 'aria2', name: 'x', files: [], status: 'active', uri: 'u' });
        assert.equal(await d.check('s|v|e1'), null);
        assert.equal(await d.check('s|v|e2'), null);      // key 不存在
    });

    test('check：liveProvider 抛异常或返回 undefined → 按未命中放行，不阻塞调用方', async () => {
        const store = makeStore();
        const d1 = new DlDedupe(store, async () => { throw new Error('aria2 down'); });
        d1.bind('g1', 's|v|e1', { kind: 'aria2', name: 'x', files: [], status: 'active', uri: 'u' });
        assert.equal(await d1.check('s|v|e1'), null);

        const d2 = new DlDedupe(store, async () => undefined);
        assert.equal(await d2.check('s|v|e1'), null);
        const d3 = new DlDedupe(store);                    // 缺省 liveProvider
        assert.equal(await d3.check('s|v|e1'), null);
    });

    test('check：同 epKey 多条记录时取最新一条（unshift 语义）', async () => {
        const store = makeStore();
        const d = new DlDedupe(store, async () => [{ gid: 'g2', status: 'active' }]);
        // 先写旧记录（失败），再写新记录（进行中）：应命中新记录
        store.add({ gid: 'g1', epKey: 's|v|e1', status: 'error', files: [] });
        store.add({ gid: 'g2', epKey: 's|v|e1', status: 'active', files: [] });
        const r = await d.check('s|v|e1');
        assert.equal(r.gid, 'g2');
        assert.equal(r.state, 'downloading');
        // 反向写入：最新为 error → 放行
        store.add({ gid: 'g1', epKey: 's|v|e1', status: 'error', files: [] });
        assert.equal(await d.check('s|v|e1'), null);
    });

    test('check：done 态跳过 "." 与不存在的产物，取第一个真实存在的文件', async () => {
        const t = tmpRoot('dedupe');
        try {
            const real = path.join(t.root, '剧', '第01集.mp4');
            fs.mkdirSync(path.dirname(real), { recursive: true });
            fs.writeFileSync(real, 'x');
            existing.add(real);
            const store = makeStore();
            const d = new DlDedupe(store, async () => []);
            d.bind('g1', 's|v|e1', {
                kind: 'hls', name: 'x', status: 'complete', uri: 'u',
                files: ['.', '', `${t.root}\\gone.mp4`, real],
            });
            const r = await d.check('s|v|e1');
            assert.equal(r.state, 'done');
            assert.equal(r.file, real);
            existing.delete(real);
        } finally { t.cleanup(); }
    });

    test('并发 check：同时查多个 key 结果互不干扰，liveProvider 各调一次', async () => {
        const store = makeStore();
        let calls = 0;
        const d = new DlDedupe(store, async () => { calls++; return [{ gid: 'g1', status: 'active' }]; });
        d.bind('g1', 's|v|e1', { kind: 'aria2', name: 'x', files: [], status: 'active', uri: 'u' });
        d.bind('g2', 's|v|e2', { kind: 'aria2', name: 'y', files: [], status: 'error', uri: 'u' });
        const [a, b] = await Promise.all([d.check('s|v|e1'), d.check('s|v|e2')]);
        assert.equal(a.state, 'downloading');
        assert.equal(b, null);
        assert.equal(calls, 1, '仅进行中记录触发存活复核');
    });

    test('buildKey：Unicode/全角与首尾空白归一化，中间空白保留；非字符串入参', () => {
        assert.equal(buildKey({ site: ' Ｓｉｔｅ ', vod: '\t剧名\n', episode: ' 第01集 ' }), 'ｓｉｔｅ|剧名|第01集');
        assert.equal(buildKey({ site: 'SITE', vod: '剧名', episode: '第01集' }), 'site|剧名|第01集');
        assert.equal(buildKey({ site: 'a', vod: 'b c', episode: 'd e' }), 'a|b c|d e');
        assert.equal(buildKey({ site: 1, vod: 2, episode: 3 }), '1|2|3');   // 数字按字符串处理
        assert.equal(buildKey({ site: 'a', vod: 'b', episode: 0 }), '', 'episode=0 视为缺失');
        assert.equal(buildKey({}), '');
        assert.equal(buildKey(undefined), '');
        assert.equal(buildKey({ site: null, vod: undefined, episode: 'x' }), '');
    });

    test('bind：gid 或 epKey 缺失时不写记录；forgetMany 只统计实际清除的 gid', () => {
        const store = makeStore();
        const d = new DlDedupe(store, async () => []);
        d.bind('', 's|v|e1', { status: 'active' });
        d.bind('g1', '', { status: 'active' });
        d.bind(null, null, { status: 'active' });
        assert.equal(store.all().length, 0, '缺 gid/epKey 不得落记录');

        d.bind('g1', 'k1', { status: 'active' });
        d.bind('g2', 'k2', { status: 'active' });
        assert.equal(d.forgetMany(['g1', 'g1', 'gX']), 1, '重复 gid 只计一次');
        assert.equal(d.forgetMany(undefined), 0);
        assert.equal(d.forgetMany([]), 0);
        assert.equal(d.stamp('g1', null), undefined);
        assert.equal(d.stamp('g2', null), 'k2');
        assert.equal(store.all().length, 2, 'forgetMany 只清会话 Map，不动持久化记录');
    });

    test('carry：无 oldGid / 无 newGid 时的边界（不写入、返回空 key）', () => {
        const store = makeStore();
        const d = new DlDedupe(store, async () => []);
        assert.equal(d.carry('', 'new'), '');
        assert.equal(d.stamp('new', null), undefined);
        d.bind('old', 'k1', { status: 'active' });
        assert.equal(d.carry('old', ''), 'k1', 'key 仍返回但不登记空新 gid');
        assert.equal(d.stamp('', null), undefined);
        assert.equal(d.carry('nope', 'new2'), '');
    });

    test('setFs(null) 恢复真实 fs：真实存在的产物判 done，删掉后放行', async () => {
        const t = tmpRoot('dedupe-real');
        try {
            const real = path.join(t.root, '第02集.mp4');
            fs.writeFileSync(real, 'x');
            const store = makeStore();
            setFs(null);                                 // 恢复真实 fs
            try {
                const d = new DlDedupe(store, async () => []);
                d.bind('g1', 's|v|e1', { kind: 'hls', name: 'x', status: 'complete', files: [real], uri: 'u' });
                assert.equal((await d.check('s|v|e1')).state, 'done');
                fs.rmSync(real);
                assert.equal(await d.check('s|v|e1'), null);
            } finally { setFs(stubFs); }
        } finally { t.cleanup(); }
    });
});
