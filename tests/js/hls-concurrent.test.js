// 组件测试：hls-downloader.js 分片并发模式 —— require 加载真实主进程模块直测。
// 2026-09 审查 high#15：本文件原先内联复刻 _parsePlaylist/_concatSegments 等逻辑
// （假测试），实现改坏依旧全绿；现改为直测真实实现。
// 网络覆盖：hls-downloader.js 经 system-proxy.proxyFetch 发请求。system-proxy 的
// proxyFetch 内部走 Electron net.fetch / global fetch——把 globalThis.fetch 桩成
// 「按 URL 从临时目录读文件」，即可零协议栈直驱 _parsePlaylist/_downloadSegments 的全链路。
// 合并用例同样借 fetch：把「分片 URL」映射到磁盘文件内容，验证 concat 列表写到
// ffmpeg 输入文件且合并退出后按真实实现落盘/报错（不 spawn 真实 ffmpeg）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const HlsDownloader = require('../../src/main/hls-downloader');

/** 建临时目录（try/finally 清理），返回路径。 */
function mktmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 简易分片服务器描述：{ base, dir, files }，fetch 桩按 URL 映射到磁盘文件。 */
function makeFileServer(dir) {
    const files = new Map(); // 相对路径 → 内容字符串
    return {
        files,
        /** 注册一个可被 fetch 的「网络资源」（内容存内存，断言后无需清理）。 */
        add(relPath, content) {
            files.set(relPath, content);
            return `http://hls.test/${relPath}`;
        },
        /** fetch 桩：返回 Response 形状（hls-downloader 只用 ok/status/text/arrayBuffer）。 */
        handler(url) {
            const rel = String(url).replace(/^https?:\/\/hls\.test\//, '');
            if (!files.has(rel)) {
                return { ok: false, status: 404, text: async () => 'not found', arrayBuffer: async () => new ArrayBuffer(0) };
            }
            const body = files.get(rel);
            return { ok: true, status: 200, text: async () => body, arrayBuffer: async () => Buffer.from(body, 'utf8') };
        },
    };
}

// ---------------------------------------------------------------- _parsePlaylist（真实实现）

test('_parsePlaylist: media 播放列表解析分片（相对地址绝对化、时长聚合）', async () => {
    const origFetch = globalThis.fetch;
    const srv = makeFileServer(null);
    srv.add('pl.m3u8', [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.0,',
        'seg1.ts',
        '#EXTINF:10.0,',
        'https://cdn.example.com/seg2.ts',
        '#EXTINF:5.5,',
        'seg3.ts',
        '#EXT-X-ENDLIST',
    ].join('\n'));
    globalThis.fetch = async (url) => srv.handler(url);
    try {
        const { segments, isEncrypted, totalDuration } = await HlsDownloader.prototype._parsePlaylist
            .call({ _segsDir: '' }, 'http://hls.test/pl.m3u8', null, false);
        assert.equal(segments.length, 3);
        assert.equal(segments[0].url, 'http://hls.test/seg1.ts', '相对分片应按播放列表 URL 绝对化');
        assert.equal(segments[1].url, 'https://cdn.example.com/seg2.ts', '绝对地址保持原样');
        assert.equal(segments[0].index, 0);
        assert.equal(segments[2].index, 2);
        assert.equal(segments[0].duration, 10.0);
        assert.equal(segments[2].duration, 5.5);
        assert.equal(totalDuration, 25.5);
        assert.equal(isEncrypted, false);
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('_parsePlaylist: AES-128 加密流检测（#EXT-X-KEY → isEncrypted=true）', async () => {
    const origFetch = globalThis.fetch;
    const srv = makeFileServer(null);
    srv.add('enc.m3u8', [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin"',
        '#EXTINF:10.0,',
        'seg1.ts',
        '#EXT-X-ENDLIST',
    ].join('\n'));
    globalThis.fetch = async (url) => srv.handler(url);
    try {
        const { segments, isEncrypted } = await HlsDownloader.prototype._parsePlaylist
            .call({ _segsDir: '' }, 'http://hls.test/enc.m3u8', null, false);
        assert.equal(isEncrypted, true);
        assert.equal(segments.length, 1);
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('_parsePlaylist: master 播放列表自动选最高 BANDWIDTH 变体', async () => {
    const origFetch = globalThis.fetch;
    const srv = makeFileServer(null);
    srv.add('master.m3u8', [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000',
        'low.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2500000',
        'high.m3u8',
    ].join('\n'));
    srv.add('high.m3u8', ['#EXTM3U', '#EXTINF:4.0,', 'h1.ts', '#EXT-X-ENDLIST'].join('\n'));
    srv.add('low.m3u8', ['#EXTM3U', '#EXTINF:9.0,', 'l1.ts', '#EXT-X-ENDLIST'].join('\n'));
    globalThis.fetch = async (url) => srv.handler(url);
    try {
        const { segments, totalDuration } = await HlsDownloader.prototype._parsePlaylist
            .call({ _segsDir: '' }, 'http://hls.test/master.m3u8', null, false);
        assert.equal(segments.length, 1, '应只取选中变体的分片');
        assert.equal(segments[0].url, 'http://hls.test/h1.ts', '应选 BANDWIDTH 最高的变体');
        assert.equal(totalDuration, 4.0);
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('_parsePlaylist: 无分片抛错（no segments in playlist）', async () => {
    const origFetch = globalThis.fetch;
    const srv = makeFileServer(null);
    srv.add('empty.m3u8', '#EXTM3U\n#EXT-X-ENDLIST');
    globalThis.fetch = async (url) => srv.handler(url);
    try {
        await assert.rejects(
            () => HlsDownloader.prototype._parsePlaylist.call({ _segsDir: '' }, 'http://hls.test/empty.m3u8', null, false),
            /no segments in playlist/,
        );
    } finally {
        globalThis.fetch = origFetch;
    }
});

// ---------------------------------------------------------------- _downloadSegments（真实实现）

test('_downloadSegments: 并发池下载分片写盘、进度聚合、速度定时器清理（真实实现）', async () => {
    const origFetch = globalThis.fetch;
    const dir = mktmp('yuki-hls-dlseg-');
    const srv = makeFileServer(null);
    srv.add('s0.ts', 'AAAA');
    srv.add('s1.ts', 'BBBBBB');
    srv.add('s2.ts', 'CC');
    globalThis.fetch = async (url) => srv.handler(url);
    const task = {
        status: 'active', _gen: 0, header: null,
        _segsDir: dir, _totalSegs: 0, _downloaded: 0, _segBytes: 0, percent: 0, speed: 0,
        _speedTimer: null, _speedLastBytes: 0, _speedLastTs: Date.now(), _segSizes: new Map(),
    };
    try {
        const segments = [
            { url: 'http://hls.test/s0.ts', index: 0 },
            { url: 'http://hls.test/s1.ts', index: 1 },
            { url: 'http://hls.test/s2.ts', index: 2 },
        ];
        await HlsDownloader.prototype._downloadSegments.call({}, task, segments, 2);
        assert.equal(task._totalSegs, 3);
        assert.equal(task._downloaded, 3);
        assert.equal(task._segBytes, 12, '总字节数按各分片长度累加');
        assert.equal(task._speedTimer, null, '下载完成后速度定时器应被清理');
        assert.equal(task.speed, 0);
        // 分片文件按 seg-000000.ts 命名落盘且内容完整
        assert.equal(fs.readFileSync(path.join(dir, 'seg-000000.ts'), 'utf8'), 'AAAA');
        assert.equal(fs.readFileSync(path.join(dir, 'seg-000001.ts'), 'utf8'), 'BBBBBB');
        assert.equal(fs.readFileSync(path.join(dir, 'seg-000002.ts'), 'utf8'), 'CC');
        // P2-16：每分片写入字节数入 _segSizes（续传完整性校验依据）
        assert.equal(task._segSizes.get(0), 4);
        assert.equal(task._segSizes.get(1), 6);
        assert.equal(task._segSizes.get(2), 2);
    } finally {
        globalThis.fetch = origFetch;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_downloadSegments: 续传命中——期望字节数吻合的分片跳过重拉', async () => {
    const origFetch = globalThis.fetch;
    const dir = mktmp('yuki-hls-resume-');
    const srv = makeFileServer(null);
    let fetched = [];
    srv.add('s1.ts', 'BBBBBB');
    globalThis.fetch = async (url) => { fetched.push(url); return srv.handler(url); };
    const task = {
        status: 'active', _gen: 0, header: null,
        _segsDir: dir, _totalSegs: 0, _downloaded: 0, _segBytes: 0, percent: 0, speed: 0,
        _speedTimer: null, _speedLastBytes: 0, _speedLastTs: Date.now(), _segSizes: new Map([[0, 4]]),
    };
    fs.writeFileSync(path.join(dir, 'seg-000000.ts'), 'AAAA');
    try {
        const segments = [
            { url: 'http://hls.test/s0.ts', index: 0 }, // 磁盘已有且大小吻合
            { url: 'http://hls.test/s1.ts', index: 1 },
        ];
        await HlsDownloader.prototype._downloadSegments.call({}, task, segments, 2);
        assert.equal(fetched.length, 1, '大小吻合的已有分片不得重新下载');
        assert.equal(task._downloaded, 2, '命中续传的分片计入进度');
        assert.equal(task._segBytes, 6, '只累加实际新下载的分片字节');
    } finally {
        globalThis.fetch = origFetch;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_downloadSegments: 大小不符/无记录的残留分片重新下载（P2-16 完整性校验）', async () => {
    const origFetch = globalThis.fetch;
    const dir = mktmp('yuki-hls-trunc-');
    const srv = makeFileServer(null);
    let fetched = [];
    srv.add('s0.ts', 'AAAA');
    srv.add('s1.ts', 'BBBBBB');
    globalThis.fetch = async (url) => { fetched.push(url); return srv.handler(url); };
    const task = {
        status: 'active', _gen: 0, header: null,
        _segsDir: dir, _totalSegs: 0, _downloaded: 0, _segBytes: 0, percent: 0, speed: 0,
        _speedTimer: null, _speedLastBytes: 0, _speedLastTs: Date.now(), _segSizes: new Map([[0, 4]]),
    };
    fs.writeFileSync(path.join(dir, 'seg-000000.ts'), 'AA'); // 截断残留：期望 4 字节
    fs.writeFileSync(path.join(dir, 'seg-000001.ts'), 'OLDOLDOLD'); // 无期望记录：一律不信任
    try {
        const segments = [
            { url: 'http://hls.test/s0.ts', index: 0 },
            { url: 'http://hls.test/s1.ts', index: 1 },
        ];
        await HlsDownloader.prototype._downloadSegments.call({}, task, segments, 2);
        assert.equal(fetched.length, 2, '截断残留与无记录残留都应重新下载');
        assert.equal(fs.readFileSync(path.join(dir, 'seg-000000.ts'), 'utf8'), 'AAAA');
        assert.equal(fs.readFileSync(path.join(dir, 'seg-000001.ts'), 'utf8'), 'BBBBBB');
    } finally {
        globalThis.fetch = origFetch;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_downloadSegments: 单分片重试耗尽 → 抛错且 finally 清理速度定时器', async () => {
    const origFetch = globalThis.fetch;
    const dir = mktmp('yuki-hls-fail-');
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; return { ok: false, status: 503, text: async () => 'err', arrayBuffer: async () => new ArrayBuffer(0) }; };
    const task = {
        status: 'active', _gen: 0, header: null,
        _segsDir: dir, _totalSegs: 0, _downloaded: 0, _segBytes: 0, percent: 0, speed: 0,
        _speedTimer: null, _speedLastBytes: 0, _speedLastTs: Date.now(), _segSizes: new Map(),
    };
    try {
        await assert.rejects(
            () => HlsDownloader.prototype._downloadSegments.call({}, task, [{ url: 'http://hls.test/x.ts', index: 0 }], 1),
            /下载失败/,
        );
        assert.ok(attempts >= 3, '单分片失败应重试 3 次（0/1/2 轮）');
        assert.equal(task._speedTimer, null, 'worker 抛错也必须清理速度定时器（finally 路径）');
    } finally {
        globalThis.fetch = origFetch;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}, { timeout: 15000 });

test('_downloadSegments: failed 置位后其余 worker 不再处理任何分片（真实并发池语义）', async () => {
    const origFetch = globalThis.fetch;
    const dir = mktmp('yuki-hls-cancel-');
    // worker A 固定失败分片（重试 3 次耗尽后置 failed）；worker B 拿到好分片但
    // 其 fetch 故意等 A 失败落定后才返回——此后 B 的循环应因 failed 直接退出，
    // 剩余分片（g2）永不被请求。
    const g2Served = [];
    let badAttempts = 0;
    let wakeG1;
    const aFailed = new Promise((res) => { wakeG1 = res; });
    globalThis.fetch = async (url) => {
        if (String(url).includes('bad')) {
            badAttempts++;
            if (badAttempts >= 3) wakeG1(); // 第 3 次尝试即重试耗尽，随后 catch 置 failed
            return { ok: false, status: 500, text: async () => 'e', arrayBuffer: async () => new ArrayBuffer(0) };
        }
        await aFailed; // 等 worker A 的 failed 置位后再返回成功响应
        await new Promise((r) => setTimeout(r, 20));
        if (String(url).includes('g2')) g2Served.push(url);
        return { ok: true, status: 200, text: async () => 'x', arrayBuffer: async () => Buffer.from('x') };
    };
    const task = {
        status: 'active', _gen: 0, header: null,
        _segsDir: dir, _totalSegs: 0, _downloaded: 0, _segBytes: 0, percent: 0, speed: 0,
        _speedTimer: null, _speedLastBytes: 0, _speedLastTs: Date.now(), _segSizes: new Map(),
    };
    try {
        await assert.rejects(
            () => HlsDownloader.prototype._downloadSegments.call({}, task, [
                { url: 'http://hls.test/bad.ts', index: 0 },
                { url: 'http://hls.test/g1.ts', index: 1 },
                { url: 'http://hls.test/g2.ts', index: 2 },
            ], 2),
            /下载失败/,
        );
        assert.equal(badAttempts, 3, '失败分片应重试 3 次后耗尽');
        assert.equal(g2Served.length, 0, 'failed 后其余 worker 不得继续下载任何分片');
        assert.ok(!fs.existsSync(path.join(dir, 'seg-000002.ts')), 'failed 后不得写 g2 分片文件');
    } finally {
        globalThis.fetch = origFetch;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}, { timeout: 20000 });

// ---------------------------------------------------------------- _concatSegments（真实实现，ffmpeg 出口按退出码驱动）

test('_concatSegments: concat 列表写盘、路径为正斜杠、单引号转义（真实列表内容）', async () => {
    const dir = mktmp('yuki-hls-concat-');
    const dest = path.join(dir, 'video.mp4');
    const task = { _dest: dest, _segsDir: dir, _bin: 'ffmpeg-fake', _proc: null, _gen: 0, status: 'active' };
    const calls = [];
    let current = null;
    // 每轮 spawn 独立假进程：exit 链若复用同一 child 会叠加多个 exit 处理器，轮次驱动即错乱
    const makeChild = () => {
        const c = { stderr: { on() {} }, on(ev, fn) { if (ev === 'exit') c._exit = fn; if (ev === 'error') c._err = fn; return c; }, killed: false, pid: 100 + calls.length };
        return c;
    };
    // 用 Module._load 桩 child_process（与 hls-cleanup-impl.test.js 同手法）
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'child_process') {
            return {
                spawn: (bin, args, opts) => {
                    calls.push({ bin, args, opts });
                    current = makeChild();
                    return current;
                },
                spawnSync: () => ({ status: 0 }),
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../../src/main/hls-downloader')];
        const Patched = require('../../src/main/hls-downloader');
        // 重试链在 this 上递归调用 _concatSegments/_concatTranscode：把方法接回补丁版原型
        const self = { _closing: false, _registerProc() {} };
        self._concatSegments = (t, segs, bsf) => Patched.prototype._concatSegments.call(self, t, segs, bsf);
        self._concatTranscode = (t, segs) => Patched.prototype._concatTranscode.call(self, t, segs);
        const p = Patched.prototype._concatSegments.call(self, task, [
            { index: 0 }, { index: 1 }, { index: 2 },
        ]);
        // 驱动完整重试链：copy(withBsf) 失败 → copy(无 bsf) 失败 → 转码失败（见下一用例的链路断言）
        await new Promise((r) => setTimeout(r, 10));
        current._exit(1);
        await new Promise((r) => setTimeout(r, 10));
        current._exit(1);
        await new Promise((r) => setTimeout(r, 10));
        current._exit(1);
        await assert.rejects(() => p, /ffmpeg 合并失败/);
        // 首轮参数：concat demuxer + aac_adtstoasc + hide_banner
        assert.ok(calls.length >= 3, 'copy 失败应自动进入重试链');
        const args = calls[0].args;
        assert.equal(args[0], '-hide_banner');
        assert.ok(args.includes('-f') && args.includes('concat'), '应使用 concat demuxer');
        assert.ok(args.includes('-safe') && args.includes('0'));
        assert.ok(args.includes('-bsf:a') && args.includes('aac_adtstoasc'), '首轮应带 aac_adtstoasc');
        const listFile = path.join(dir, 'concat.txt');
        assert.ok(fs.existsSync(listFile), 'concat 列表应写入分片目录');
        const content = fs.readFileSync(listFile, 'utf8');
        const lines = content.split('\n');
        assert.equal(lines.length, 3);
        for (const line of lines) {
            assert.ok(line.startsWith('file \''), '每行应为 file \'…\' 形式');
            assert.ok(!line.includes('\\'), `路径须为正斜杠（Windows 兼容）：${line}`);
        }
        assert.ok(lines[0].includes('seg-000000.ts'));
        assert.ok(lines[2].includes('seg-000002.ts'));
        // part 临时名保留真实扩展名
        assert.ok(calls[0].args[calls[0].args.length - 1].endsWith('.incomplete.mp4'), '临时文件应保留 .mp4 扩展名供 ffmpeg 推断容器');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../../src/main/hls-downloader')];
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_concatSegments: 退出码 0 且 part 存在 → 删旧成品、renameSync 落盘为终名', async () => {
    const dir = mktmp('yuki-hls-concat2-');
    const dest = path.join(dir, 'video.mp4');
    const part = dest + '.incomplete.mp4';
    const task = { _dest: dest, _segsDir: dir, _bin: 'ffmpeg-fake', _proc: null, _gen: 0, status: 'active' };
    const child = { stderr: { on() {} }, on(ev, fn) { if (ev === 'exit') this._exit = fn; return child; }, killed: false, pid: 456 };
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'child_process') {
            return { spawn: () => child, spawnSync: () => ({ status: 0 }) };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        fs.writeFileSync(part, 'merged-data');
        fs.writeFileSync(dest, 'old-dest-content');
        delete require.cache[require.resolve('../../src/main/hls-downloader')];
        const Patched = require('../../src/main/hls-downloader');
        const p = Patched.prototype._concatSegments.call({ _closing: false, _registerProc() {} }, task, [{ index: 0 }]);
        child._exit(0);
        await p; // 不抛错即成功
        assert.equal(fs.readFileSync(dest, 'utf8'), 'merged-data', 'part 应 rename 为终名');
        assert.ok(!fs.existsSync(part), '临时文件应消失');
        assert.equal(task._proc, null, 'exit 后应清空进程句柄');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../../src/main/hls-downloader')];
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_concatSegments: copy 失败 → 去 bsf 重试 → 转码兜底（真实重试链）', async () => {
    const dir = mktmp('yuki-hls-retry-');
    const dest = path.join(dir, 'video.mp4');
    const task = { _dest: dest, _segsDir: dir, _bin: 'ffmpeg-fake', _proc: null, _gen: 0, status: 'active' };
    const calls = [];
    let current = null;
    const makeChild = () => {
        const c = { stderr: { on() {} }, on(ev, fn) { if (ev === 'exit') c._exit = fn; return c; }, killed: false, pid: 700 + calls.length };
        return c;
    };
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'child_process') {
            return {
                spawn: (bin, args) => {
                    calls.push(args);
                    current = makeChild();
                    return current;
                },
                spawnSync: () => ({ status: 0 }),
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../../src/main/hls-downloader')];
        const Patched = require('../../src/main/hls-downloader');
        const self = { _closing: false, _registerProc() {} };
        self._concatSegments = (t, segs, bsf) => Patched.prototype._concatSegments.call(self, t, segs, bsf);
        self._concatTranscode = (t, segs) => Patched.prototype._concatTranscode.call(self, t, segs);
        const p = Patched.prototype._concatSegments.call(self, task, [{ index: 0 }]);
        // 驱动重试链：copy(withBsf) 失败 → copy(无 bsf) 失败 → 转码失败
        await new Promise((r) => setTimeout(r, 10));
        current._exit(1);
        await new Promise((r) => setTimeout(r, 10));
        current._exit(1);
        await new Promise((r) => setTimeout(r, 10));
        current._exit(1);
        await assert.rejects(() => p, /ffmpeg 合并失败 \(code=1\).*转码也失败/, '三级全失败应聚合错误信息');
        assert.equal(calls.length, 3, '应依次尝试 copy(withBsf) / copy / 转码');
        assert.deepEqual(
            [calls[0].includes('aac_adtstoasc'), calls[1].includes('aac_adtstoasc'), calls[2].includes('-c:v')],
            [true, false, true],
            '第一轮带 bsf、重试去 bsf、兜底转码',
        );
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../../src/main/hls-downloader')];
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_concatSegments: _gen 变化（目录迁移杀进程）→ 拒绝旧续体重试，报 migrating', async () => {
    const dir = mktmp('yuki-hls-gen-');
    const dest = path.join(dir, 'video.mp4');
    const task = { _dest: dest, _segsDir: dir, _bin: 'ffmpeg-fake', _proc: null, _gen: 0, status: 'active' };
    const calls = [];
    let current = null;
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'child_process') {
            return {
                spawn: (bin, args) => {
                    calls.push(args);
                    current = { stderr: { on() {} }, on(ev, fn) { if (ev === 'exit') current._exit = fn; return current; }, killed: false, pid: 800 };
                    return current;
                },
                spawnSync: () => ({ status: 0 }),
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../../src/main/hls-downloader')];
        const Patched = require('../../src/main/hls-downloader');
        const p = Patched.prototype._concatSegments.call({ _closing: false, _registerProc() {} }, task, [{ index: 0 }]);
        await new Promise((r) => setTimeout(r, 10));
        task._gen = 1; // 模拟 migrateDir/pause 杀进程后代数自增
        current._exit(1);
        await assert.rejects(() => p, /migrating/, '旧代数续体应自弃且不得进入重试链');
        assert.equal(calls.length, 1, 'migrating 分支不得再 spawn 重试');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../../src/main/hls-downloader')];
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_concatSegments: _closing 置位 → 直接拒绝拉起（不重生 ffmpeg）', async () => {
    const h = new HlsDownloader();
    h._closing = true;
    const task = { _dest: path.join(os.tmpdir(), 'x.mp4'), _segsDir: os.tmpdir(), _bin: 'ffmpeg-fake', _proc: null, _gen: 0, status: 'active' };
    await assert.rejects(
        () => h._concatSegments(task, [{ index: 0 }]),
        /closing/,
    );
});

// ---------------------------------------------------------------- 调度联动（真实 _pump/_runConcurrent 入口）

test('_pump: 槽位空闲按 FIFO 启动 waiting 任务；waiting 期间被删除的残留跳过', () => {
    const h = new HlsDownloader();
    let started = [];
    h._runConcurrent = (task, conc) => started.push({ task, conc, mode: 'concurrent' });
    h._run = (task) => started.push({ task, mode: 'ffmpeg' });
    const t1 = { gid: 'g1', name: 't1', status: 'waiting', _segConc: 4 };
    const t2 = { gid: 'g2', name: 't2', status: 'removed' }; // 排队期间被删除
    const t3 = { gid: 'g3', name: 't3', status: 'waiting', _segConc: 1 };
    h._tasks.set('g1', t1); h._tasks.set('g2', t2); h._tasks.set('g3', t3);
    h._pending.push(t1, t2, t3);
    h.setMaxActive(8);
    h._pump();
    assert.deepEqual(started.map((s) => s.task.gid), ['g1', 'g3'], 'removed 残留应被跳过');
    assert.equal(t1._mode, 'concurrent');
    assert.deepEqual(started[0].conc, 4);
    assert.equal(t3._mode, 'ffmpeg', 'concurrency<=1 走 ffmpeg 顺序模式');
    assert.equal(h._pending.length, 0);
});

test('_pump: 活跃任务占满槽位时不启动新任务（maxActive 语义）', () => {
    const h = new HlsDownloader();
    h.setMaxActive(1);
    let started = 0;
    h._run = () => { started++; };
    h._tasks.set('busy', { gid: 'busy', name: 'busy', status: 'active' });
    const waiting = { gid: 'w', name: 'w', status: 'waiting', _segConc: 1 };
    h._tasks.set('w', waiting);
    h._pending.push(waiting);
    h._pump();
    assert.equal(started, 0, '无空闲槽位不得启动');
    assert.equal(h._pending.length, 1);
    h._tasks.get('busy').status = 'complete'; // 终态释放槽位
    h._pump();
    assert.equal(started, 1, '槽位释放后 FIFO 补位');
    assert.equal(waiting.status, 'active');
});
