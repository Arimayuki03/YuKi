// 白盒单元测试：src/main/hls-downloader.js —— m3u8 解析矩阵 / 分片 URL 解析 / 并发下载
// 与队列 / 进度百分比 / 文件名清洗与临时产物清理 / _runConcurrent 状态机。
//
// 与同目录既有 hls-* 用例的分工（互补点）：
//  - hls-filter.test.js：filterAdSegments/filterAdBlocks 的黑盒行为（CUE、广告块、安全阀）。
//    本文件改为**直测其内部判定单元** roundHalfEven / adPathHit / parseAdSegments /
//    markDiscontinuityBlocks / adSegmentVerdict，覆盖 hls-filter 到不了的分支
//    （host 未知、跨 host 严格组合、悬空 EXTINF、-SEQUENCE 不翻转开关等）。
//  - hls-concurrent.test.js：_parsePlaylist/_downloadSegments/_concatSegments 的主干路径。
//    本文件补**解析矩阵**（ENDLIST/DISCONTINUITY/MAP/BYTERANGE/裸 URL/空文件/只有头部/
//    CRLF/注释/畸形行/超长清单）与 **URL 解析矩阵**（相对/上级/根相对/查询/锚点/协议相对/
//    中文与空格编码），以及并发上限、worker 数量钳制、取消语义、百分比边界。
//  - hls-cleanup*.test.js / hls-queue.test.js：进程登记与调度。本文件补**输出与清理**
//    （add 文件名清洗、remove/clearStopped/clearFailed 的临时产物清理、_cleanSegsDir
//    顺带清速度定时器）与 **_runConcurrent 降级状态机**（加密流回退、失败回退 ffmpeg、
//    成功后清理并置 100）。
//
// 加载方式：源码经 vm 重新求值（每个用例独立沙箱）——既能拿到私有函数（上述内部判定单元
// 未走 module.exports），又能对 child_process / system-proxy / ffmpeg 三个外部依赖整体打桩，
// 保证零真实网络、零真实 ffmpeg。依赖解析用 Module.createRequire 锚到源码路径，其余
// 内建模块仍走真实实现（fs/path/os/events 均为真货，便于断言真实落盘行为）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

const HLS_PATH = path.join(__dirname, '..', '..', 'src', 'main', 'hls-downloader.js');
const SRC = fs.readFileSync(HLS_PATH, 'utf8');
// 源码内未导出的私有函数（白盒入口）
const PRIVATE = [
    'ffmpegHeaders', 'probeDuration', 'isAdUri', 'filterAdSegments', 'filterAdBlocks',
    'roundHalfEven', 'adPathHit', 'parseAdSegments', 'markDiscontinuityBlocks', 'adSegmentVerdict',
];
const QUIET = { log() { }, warn() { }, error() { }, info() { }, debug() { } };
const FAKE_BIN = process.platform === 'win32' ? 'C:\\fake\\ffmpeg.exe' : '/fake/ffmpeg';

/**
 * 在隔离沙箱里重新求值 hls-downloader.js。
 * @param {{childProcess?:object, proxy?:object, ffmpeg?:object, globals?:object}} opts
 *   childProcess/proxy/ffmpeg 为对应 require 的替身（缺省时用真实 *除了* proxy：
 *   默认 proxy 直接抛错，杜绝任何真实出网）；globals 可覆盖沙箱全局（如 setInterval 间谍）。
 */
function loadHls(opts) {
    const o = opts || {};
    const req = Module.createRequire(pathToFileURL(HLS_PATH));
    const shim = (id) => {
        if (id === 'child_process' && o.childProcess) return o.childProcess;
        if (id === './system-proxy') return o.proxy || OFFLINE_PROXY;
        if (id === './ffmpeg') return o.ffmpeg || { findFfmpeg: () => FAKE_BIN };
        return req(id);
    };
    const sandbox = {
        console: QUIET, process, Buffer, URL, URLSearchParams, AbortSignal, TextDecoder,
        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
        require: shim, module: { exports: {} },
        __dirname: path.dirname(HLS_PATH), __filename: HLS_PATH,
        ...(o.globals || {}),
    };
    sandbox.exports = sandbox.module.exports;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`${SRC}\n;globalThis.__hls = { HlsDownloader, ${PRIVATE.join(', ')} };`,
        sandbox, { filename: 'hls-downloader.js' });
    return sandbox.__hls;
}

// 默认 proxy 替身：任何请求立即失败——用例未显式提供数据源时必定不出网
const OFFLINE_PROXY = {
    proxyEnv: () => ({}),
    proxyFetch: async () => { throw new Error('offline stub'); },
};

/** 由 URL→文本映射构造 system-proxy 替身（text/arrayBuffer 均从同一份内容取）。 */
function proxyOf(map) {
    return {
        proxyEnv: () => ({}),
        proxyFetch: async (url) => {
            const body = map(String(url));
            if (body === undefined || body === null) {
                return { ok: false, status: 404, text: async () => 'not found', arrayBuffer: async () => Buffer.alloc(0) };
            }
            return {
                ok: true, status: 200,
                text: async () => body,
                arrayBuffer: async () => Buffer.from(body, 'utf8'),
            };
        },
    };
}

/**
 * 计数/可控型数据源替身：handler(url) 返回 {ok,status,body}（异步亦可），
 * 用于在 _downloadSegments 场景精确统计 in-flight 数与请求次数。
 */
function countingProxy(handler) {
    return {
        proxyEnv: () => ({}),
        proxyFetch: async (url) => {
            const r = await handler(String(url));
            const body = r && r.ok ? String(r.body) : '';
            return {
                ok: !!(r && r.ok),
                status: (r && r.status) || (r && r.ok ? 200 : 500),
                text: async () => body,
                arrayBuffer: async () => Buffer.from(body, 'utf8'),
            };
        },
    };
}

/** 假 ffmpeg 子进程：可手动触发 exit/error；stderr 独立记录 data 监听供喂进度行。 */
function fakeProc(pid) {
    const ev = {};
    const stderrEv = [];
    const p = {
        pid,
        killed: false,
        exitCode: null,
        signalCode: null,
        stderr: { on(name, fn) { if (name === 'data') stderrEv.push(fn); } },
        on(name, fn) { (ev[name] = ev[name] || []).push(fn); return p; },
        once(name, fn) { (ev[name] = ev[name] || []).push(fn); return p; },
        kill() { p.killed = true; return true; },
        _fire(name, ...args) { for (const fn of [...(ev[name] || [])]) fn(...args); },
        /** 向 stderr 的 data 监听喂一块输出（等价 ffmpeg 写一行进度）。 */
        _stderr(chunk) { for (const fn of [...stderrEv]) fn(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); },
    };
    return p;
}

/** 记录 spawn 调用并返回假进程的 child_process 替身（spawnSync 恒成功，避免动系统进程）。 */
function fakeChildProcess(calls) {
    return {
        spawn(bin, args, opt) {
            const proc = fakeProc(4000 + calls.length);
            calls.push({ bin, args, opt, proc });
            return proc;
        },
        spawnSync() { return { status: 0 }; },
    };
}

/** 建临时目录（调用方在 finally 里 rmSync 清理）。 */
function mktmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 跨域归一化：沙箱里 new 出的 Array/Object 原型属于 vm realm，直接与宿主机字面量
 * deepStrictEqual 会因原型不同报「values have same structure but are not reference-equal」。
 * 断言前先过一遍 JSON 落到本 realm。
 */
function plain(v) {
    return JSON.parse(JSON.stringify(v));
}

/**
 * 构造仅含下载所需字段的任务对象（不触碰 add 的校验与队列）。
 * 未显式传 dir 时自建临时目录（yuki-hls-task- 前缀，便于一眼看出清理遗漏），
 * 返回的 dispose() 负责删除；用例应在 finally 中调用。
 */
function mkTask(overrides) {
    const o = overrides || {};
    // 调用方显式给了 dir 就不另建临时目录（避免每造一个任务都留下空目录）
    const ownDir = o.dir ? '' : mktmp('yuki-hls-task-');
    const dir = o.dir || ownDir;
    const dispose = () => fs.rmSync(dir, { recursive: true, force: true });
    const dest = path.join(dir, 'v.mp4');
    return {
        dispose,
        gid: 'hls-test-1', kind: 'hls', name: 'v.mp4', url: 'http://hls.test/p.m3u8',
        header: null, dir,
        status: 'active', percent: 0, done: 0, total: 0, speed: 0, errorMessage: '',
        files: [dest], _dest: dest, _bin: FAKE_BIN, _proc: null,
        _retried: false, _transcodeRetried: false, adFilter: false, _adTemp: null, _input: null,
        _mode: 'concurrent', _segConc: 2, _segsDir: `${dest}.hls-test-1.segs`,
        _segments: null, _totalSegs: 0, _downloaded: 0, _segBytes: 0,
        _speedTimer: null, _speedLastBytes: 0, _speedLastTs: Date.now(), _gen: 0,
        ...overrides,
    };
}

// ==================================================================
// ffmpegHeaders：header → ffmpeg -headers 串（过滤口径与 CRLF 结尾）
// ==================================================================

test('ffmpegHeaders：多 header 按 "K: V\r\n" 拼接，过滤 null/空串值', () => {
    const { ffmpegHeaders } = loadHls();
    assert.equal(ffmpegHeaders({ Referer: 'https://a.example/', 'X-Token': 'abc' }),
        'Referer: https://a.example/\r\nX-Token: abc\r\n');
    // null/undefined/'' 一律剔除，但 0 / false 这类有效值必须保留
    assert.equal(ffmpegHeaders({ A: null, B: undefined, C: '', D: 0, E: false }),
        'D: 0\r\nE: false\r\n');
});

test('ffmpegHeaders：空对象与非对象一律返回空串（spawn 不追加 -headers）', () => {
    const { ffmpegHeaders } = loadHls();
    assert.equal(ffmpegHeaders({}), '');
    assert.equal(ffmpegHeaders(null), '');
    assert.equal(ffmpegHeaders(undefined), '');
    assert.equal(ffmpegHeaders('Referer: x'), '');
    assert.equal(ffmpegHeaders(123), '');
});

test('_spawn：header 非空时才向参数追加 -headers（合成参数对接 ffmpeg CLI 口径）', () => {
    const calls = [];
    const { HlsDownloader } = loadHls({ childProcess: fakeChildProcess(calls) });
    const dir = mktmp('yuki-hls-hdr-');
    const h = new HlsDownloader();
    h.dir = dir;
    try {
        const withHdr = mkTask({ dir, _dest: path.join(dir, 'a.mp4'), url: 'http://hls.test/a.m3u8', header: { Referer: 'https://ref.example/' }, _input: null });
        h._spawn(withHdr, true);
        const args = calls[0].args;
        assert.ok(args.includes('-headers'), '有 header 时应追加 -headers');
        assert.equal(args[args.indexOf('-headers') + 1], 'Referer: https://ref.example/\r\n', 'CRLF 结尾的 K: V 串');
        assert.ok(args.includes('-c') && args.includes('copy'));
        assert.ok(args.includes('aac_adtstoasc'), '首轮应带 bsf');
        assert.equal(args[args.length - 1], path.join(dir, 'a.mp4') + '.incomplete.mp4', '临时产物保留真实扩展名');
        assert.equal(args[0], '-hide_banner');
        assert.ok(args.includes('-y'), '自动覆盖已存在的同名临时产物');

        // 无 header：不得追加 -headers（否则 ffmpeg 收到空头串会报 malformed）
        const noHdr = mkTask({ dir, _dest: path.join(dir, 'b.mp4'), url: 'http://hls.test/b.m3u8', header: null, _input: null });
        h._spawn(noHdr, false);
        assert.ok(!calls[1].args.includes('-headers'), '无 header 时不得追加 -headers');
        assert.ok(!calls[1].args.includes('aac_adtstoasc'), 'withBsf=false 的重试轮不带 bsf');
        assert.equal(calls[1].args[calls[1].args.indexOf('-i') + 1], 'http://hls.test/b.m3u8', '未过滤时直接喂原始 URL');
        // _input（广告过滤后的本地临时清单）优先于原始 URL
        const filtered = mkTask({ dir, _dest: path.join(dir, 'c.mp4'), url: 'http://hls.test/c.m3u8', header: null, _input: path.join(dir, 'c.adfilter.m3u8') });
        h._spawn(filtered, true);
        assert.equal(calls[2].args[calls[2].args.indexOf('-i') + 1], path.join(dir, 'c.adfilter.m3u8'), '广告过滤后喂本地临时清单');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ==================================================================
// probeDuration：duration 预估（master 变体选择 + EXTINF 累加 + 异常兜底）
// ==================================================================

test('probeDuration：media 播放列表累加全部 EXTINF 得总时长', async () => {
    const { probeDuration } = loadHls({
        proxy: proxyOf((u) => (u.includes('p.m3u8')
            ? ['#EXTM3U', '#EXTINF:10.5,', 'a.ts', '#EXTINF:9.0,', 'b.ts', '#EXTINF:0.5,', 'c.ts', '#EXT-X-ENDLIST'].join('\n')
            : undefined)),
    });
    const d = await probeDuration('http://hls.test/p.m3u8', { Referer: 'r' });
    assert.ok(Math.abs(d - 20) < 1e-6, `应累加 10.5+9.0+0.5=20，实际 ${d}`);
});

test('probeDuration：master 播放列表选 BANDWIDTH 最高的变体再累加其 EXTINF', async () => {
    const master = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'low.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080', 'sub/high.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000', 'mid.m3u8',
    ].join('\n');
    const seen = [];
    const { probeDuration } = loadHls({
        proxy: proxyOf((u) => {
            seen.push(u);
            if (u === 'http://hls.test/master.m3u8') return master;
            return ['#EXTM3U', '#EXTINF:4.0,', 'h1.ts', '#EXTINF:6.0,', 'h2.ts', '#EXT-X-ENDLIST'].join('\n');
        }),
    });
    const d = await probeDuration('http://hls.test/master.m3u8', null);
    assert.equal(d, 10, '应取最高码率变体的 EXTINF 之和');
    assert.deepEqual(seen, ['http://hls.test/master.m3u8', 'http://hls.test/sub/high.m3u8'],
        '变体相对地址按 master URL 解析为绝对地址');
});

test('probeDuration：同 BANDWIDTH 并列时取先出现的变体（严格 > 比较的钉法）', async () => {
    const master = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2500000', 'first.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2500000', 'second.m3u8',
    ].join('\n');
    const seen = [];
    const { probeDuration } = loadHls({
        proxy: proxyOf((u) => {
            seen.push(u);
            return u.includes('master') ? master : '#EXTM3U\n#EXTINF:3.0,\nx.ts\n';
        }),
    });
    await probeDuration('http://hls.test/master.m3u8', null);
    assert.ok(seen[1].includes('first.m3u8'), '码率并列时首个变体胜出（不因后到同值被替换）');
});

test('probeDuration：master 无可选用变体行（STREAM-INF 后紧接标签）返回 0', async () => {
    const { probeDuration } = loadHls({
        proxy: proxyOf(() => [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=800000',
            '#EXT-X-STREAM-INF:BANDWIDTH=1600000',
            '#EXT-X-ENDLIST',
        ].join('\n')),
    });
    assert.equal(await probeDuration('http://hls.test/master.m3u8', null), 0,
        '找不到变体 URI 不得凭 media 正文继续估算');
});

test('probeDuration：网络异常返回 0 而不是抛出（上层按「时长未知」继续）', async () => {
    const { probeDuration } = loadHls(); // 默认 OFFLINE_PROXY：fetch 恒抛
    assert.equal(await probeDuration('http://hls.test/p.m3u8', null), 0);
});

test('probeDuration：只有头部/无 EXTINF 的清单返回 0', async () => {
    const { probeDuration } = loadHls({ proxy: proxyOf(() => '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-ENDLIST\n') });
    assert.equal(await probeDuration('http://hls.test/p.m3u8', null), 0);
});

// ==================================================================
// 广告判定内部单元（hls-filter.test.js 覆盖不到的分支）
// ==================================================================

test('roundHalfEven：Python 风格银行家舍入（0.5→0、1.5→2、2.5→2、3.5→4）', () => {
    const { roundHalfEven } = loadHls();
    assert.equal(roundHalfEven(0.5), 0);
    assert.equal(roundHalfEven(1.5), 2);
    assert.equal(roundHalfEven(2.5), 2);
    assert.equal(roundHalfEven(3.5), 4);
    assert.equal(roundHalfEven(-0.5), -0, '负半值同样向偶数方向取整');
    assert.equal(roundHalfEven(2.4), 2);
    assert.equal(roundHalfEven(2.6), 3);
});

test('adPathHit：命中 /ad/·/ads/·/cm/·guanggao，ad-01 连字符不构成词边界', () => {
    const { adPathHit } = loadHls();
    assert.equal(adPathHit('http://x/ad/1.ts'), true);
    assert.equal(adPathHit('http://x/ads/1.ts'), true);
    assert.equal(adPathHit('http://x/advert/1.ts'), true);
    assert.equal(adPathHit('http://x/advertisement.mp4'), true);
    assert.equal(adPathHit('http://x/CM/1.ts'), true, '大小写不敏感');
    assert.equal(adPathHit('http://x/guanggao/1.ts'), true);
    assert.equal(adPathHit('http://x/video/ad-01.ts'), false, '连字符非边界，防错杀正片');
    assert.equal(adPathHit('http://x/load/1.ts'), false);
    assert.equal(adPathHit('http://x/v/seg.ts'), false);
});

test('adPathHit：畸形 URL 走伪基兜底且不抛异常', () => {
    const { adPathHit } = loadHls();
    assert.equal(adPathHit('http://[bad'), false, '不可解析 URL 不得抛异常');
    assert.equal(adPathHit(''), false);
    assert.equal(adPathHit(null), false);
});

test('parseAdSegments：EXTINF 与 URI 成对收口，中间标签归属该分片', () => {
    const { parseAdSegments } = loadHls();
    const lines = [
        '#EXTM3U\n',
        '#EXTINF:10.0,\n',
        '#EXT-X-BYTERANGE:1000@0\n',
        'http://v/a.ts\n',
        '#EXTINF:9.0,\n',
        'http://v/b.ts\n',
        '#EXT-X-ENDLIST\n',
    ];
    const segs = parseAdSegments(lines);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].uri, 'http://v/a.ts');
    assert.equal(segs[0].duration, 10);
    assert.equal(segs[0].lineNo, 1, '行号指向 EXTINF 行（删除窗口起点）');
    assert.equal(segs[0].lines.length, 3, 'BYTERANGE 等中间标签随分片一同被删除');
    assert.equal(segs[1].uri, 'http://v/b.ts');
    assert.equal(segs[1].lineNo, 4);
});

test('parseAdSegments：URI 行取首个空白前 token，行尾附加信息不入 URL', () => {
    const { parseAdSegments } = loadHls();
    const segs = parseAdSegments(['#EXTINF:4.0,\n', 'http://v/a.ts  # 尾部注释\n']);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].uri, 'http://v/a.ts');
});

test('parseAdSegments：行尾无 URI 的悬空 EXTINF 不成段（避免删除窗口错位）', () => {
    const { parseAdSegments } = loadHls();
    const segs = parseAdSegments(['#EXTINF:10.0,\n', 'http://v/a.ts\n', '#EXTINF:8.0,\n']);
    assert.equal(segs.length, 1, '悬空 EXTINF 不得生成无 URI 的分片');
    assert.equal(segs[0].uri, 'http://v/a.ts');
});

test('parseAdSegments：裸 URI 行独立成段（duration 归零，不继承上一分片时长）', () => {
    const { parseAdSegments } = loadHls();
    const segs = parseAdSegments([
        '#EXTINF:10.0,\n', 'http://v/a.ts\n',
        'http://v/bare.ts\n',
    ]);
    assert.equal(segs.length, 2);
    assert.equal(segs[1].uri, 'http://v/bare.ts');
    assert.equal(segs[1].duration, 0, '裸 URI 必须全新状态：不继承 10.0');
    assert.equal(segs[1].lineNo, 2, '行号指向裸 URI 自身，防止删除邻近正片');
});

test('markDiscontinuityBlocks：DISCONTINUITY-SEQUENCE 与其它扩展不翻转区间开关', () => {
    const { markDiscontinuityBlocks } = loadHls();
    const lines = [
        '#EXT-X-DISCONTINUITY-SEQUENCE:5\n',
        'a.ts\n',
        '#EXT-X-DISCONTINUITY-EXT:v1\n',
        'b.ts\n',
        '#EXT-X-DISCONTINUITY\n',
        'c.ts\n',
        'd.ts\n',
        '#EXT-X-DISCONTINUITY\n',
        'e.ts\n',
    ];
    const flags = [false, false, false, false, false];
    const unclosed = markDiscontinuityBlocks(lines, flags);
    assert.deepEqual(flags, [false, false, true, true, false], 'SEQUENCE/其它扩展不开启区间');
    assert.equal(unclosed, false, '偶数次 DISCONTINUITY 视为闭合');
});

test('markDiscontinuityBlocks：奇数次 DISCONTINUITY 收尾返回未闭合标志', () => {
    const { markDiscontinuityBlocks } = loadHls();
    const flags = [false, false];
    const unclosed = markDiscontinuityBlocks(['a.ts\n', '#EXT-X-DISCONTINUITY\n', 'b.ts\n'], flags);
    assert.equal(unclosed, true);
    assert.deepEqual(flags, [false, true], '未配对开启后其后的分片被标记为块内');
});

test('adSegmentVerdict：跨 host + 路径命中 + 时长异常（无包裹）走严格组合通道', () => {
    const { adSegmentVerdict } = loadHls();
    const seg = { uri: 'http://ad.cdn/ad/x.ts', duration: 3, lineNo: 0 };
    const why = adSegmentVerdict(seg, 'video.cdn', 'video.cdn', 10, false);
    assert.match(why, /cross-host ad-like path with odd duration/);
    // 时长不异常（≥ 主体 0.6 倍）：跨 host + 路径命中不足以删
    assert.equal(adSegmentVerdict({ uri: 'http://ad.cdn/ad/x.ts', duration: 9 }, 'video.cdn', 'video.cdn', 10, false), null);
    // 路径不命中：跨 host + 时长异常也不足以删
    assert.equal(adSegmentVerdict({ uri: 'http://op.cdn/op/x.ts', duration: 3 }, 'video.cdn', 'video.cdn', 10, false), null);
});

test('adSegmentVerdict：同 host 分片无 discontinuity 包裹时永不判广告', () => {
    const { adSegmentVerdict } = loadHls();
    const args = [{ uri: 'http://video.cdn/ad/x.ts', duration: 2 }, 'video.cdn', 'video.cdn', 10];
    assert.equal(adSegmentVerdict(...args, false), null, '同 host 无包裹：仅路径+时长不得删');
    assert.match(adSegmentVerdict(...args, true), /same-host ad-like path\+duration in discontinuity/,
        '叠加 discontinuity 包裹后才动手');
});

test('adSegmentVerdict：host 全未知（相对清单且无 baseUrl）仅在三证齐备时判广告', () => {
    const { adSegmentVerdict } = loadHls();
    const seg = { uri: 'ad/01.ts', duration: 3 };
    assert.match(adSegmentVerdict(seg, '', '', 10, true), /host-unknown ad-like path\+duration in discontinuity/);
    assert.equal(adSegmentVerdict(seg, '', '', 10, false), null, 'host 未知且无包裹：证据不足放过');
    assert.equal(adSegmentVerdict({ uri: 'clip/01.ts', duration: 3 }, '', '', 10, true), null, '无路径命中即放过');
});

test('filterAdBlocks：全相对地址清单（host 未知）也能按路径+时长+包裹三证删广告', () => {
    const { filterAdBlocks } = loadHls();
    const pl = [
        '#EXTM3U', '#EXT-X-TARGETDURATION:10',
        ...Array.from({ length: 10 }, (_, i) => [`#EXTINF:10.0,`, `v/seg-${i}.ts`]).flat(),
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:4.0,', 'ad/01.ts',
        '#EXTINF:4.0,', 'ad/02.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, '');
    assert.equal(r.removed, 2, 'host 未知通道：路径+短时长+discontinuity 三证齐备应删');
    assert.equal(r.removedSec, 8);
    assert.ok(!r.text.includes('ad/01.ts'));
    assert.ok(r.text.includes('v/seg-0.ts'), '正片保留');
    assert.ok(r.reasons.some((s) => s.includes('host-unknown')), '删除原因应标注 host 未知通道');
});

test('filterAdBlocks：全相对地址清单无广告路径证据时不删（防错杀 OP/ED）', () => {
    const { filterAdBlocks } = loadHls();
    const pl = [
        '#EXTM3U',
        ...Array.from({ length: 10 }, (_, i) => [`#EXTINF:10.0,`, `v/seg-${i}.ts`]).flat(),
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:4.0,', 'clip/01.ts',
        '#EXTINF:4.0,', 'clip/02.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-ENDLIST',
    ].join('\n');
    assert.equal(filterAdBlocks(pl, '').removed, 0);
});

// ==================================================================
// _parsePlaylist：m3u8 解析矩阵（既有 hls-concurrent 只覆盖主干媒体清单）
// ==================================================================

/** 用给定播放列表正文 + 基址调用真实 _parsePlaylist。 */
async function parse(plBody, plUrl, adFilter) {
    const { HlsDownloader } = loadHls({ proxy: proxyOf((u) => (String(u) === plUrl ? plBody : undefined)) });
    return HlsDownloader.prototype._parsePlaylist.call({}, plUrl, null, !!adFilter);
}

test('_parsePlaylist：ENDLIST/DISCONTINUITY/MAP/BYTERANGE/KEY 等标签均不产生分片', async () => {
    const r = await parse([
        '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="sk.bin",KEYFORMATVERSIONS="1"',
        '#EXTINF:10.0,', 'a.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:9.0,', 'b.ts',
        '#EXT-X-BYTERANGE:1000@0',
        '#EXTINF:9.0,', 'b.ts',
        '#EXT-X-ENDLIST',
    ].join('\n'), 'http://hls.test/v/p.m3u8');
    // MAP 携带 URI="…" 但整行以 # 开头 → 不入分片；BYTERANGE 后的重复 URI 仍独立成片
    assert.equal(r.segments.length, 3);
    assert.equal(r.segments[2].url, 'http://hls.test/v/b.ts', 'BYTERANGE 复用同一 URI 也单独成段');
    assert.equal(r.totalDuration, 28);
    assert.equal(r.isEncrypted, true, 'KEY（含 METHOD=SAMPLE-AES）置加密标记');
});

test('_parsePlaylist：无标签裸 URL 列表全部成片且时长为 0', async () => {
    const r = await parse(['http://hls.test/v/1.ts', 'v/2.ts', 'http://hls.test/v/3.ts'].join('\n'),
        'http://hls.test/v/p.m3u8');
    assert.equal(r.segments.length, 3, '裸 URL 行不因缺少 EXTINF 被丢弃');
    assert.deepEqual(plain(r.segments.map((s) => s.duration)), [0, 0, 0]);
    assert.equal(r.totalDuration, 0);
    assert.equal(r.segments[1].url, 'http://hls.test/v/v/2.ts', '相对裸 URL 同样按播放列表目录解析');
});

test('_parsePlaylist：空文件与只有头部的清单抛 no segments', async () => {
    await assert.rejects(() => parse('', 'http://hls.test/empty.m3u8'), /no segments in playlist/);
    await assert.rejects(() => parse('#EXTM3U\n', 'http://hls.test/head.m3u8'), /no segments in playlist/);
    await assert.rejects(() => parse('#EXTM3U\n#EXT-X-ENDLIST\n', 'http://hls.test/head2.m3u8'), /no segments in playlist/);
});

test('_parsePlaylist：CRLF 换行与注释/空行/空白行混合正常解析', async () => {
    const body = [
        '#EXTM3U', '# a comment: 中文注释', '', '   ',
        '#EXTINF:6.0,', 'a.ts',
        '#EXTINF:6.0,', 'b.ts',
        '#EXT-X-ENDLIST', '',
    ].join('\r\n');
    const r = await parse(body, 'http://hls.test/v/p.m3u8');
    assert.equal(r.segments.length, 2, '空行与注释行不产生分片');
    assert.equal(r.totalDuration, 12);
});

test('_parsePlaylist：畸形 EXTINF（无数值）被忽略且不影响后续分片', async () => {
    const r = await parse([
        '#EXTM3U',
        '#EXTINF:', 'zzz.ts',
        '#EXTINF:abc,', 'bad.ts',
        '#EXTINF:5.0,', 'good.ts',
        '#EXTINF:-1,', 'neg.ts',
        '#EXT-X-ENDLIST',
    ].join('\n'), 'http://hls.test/v/p.m3u8');
    assert.equal(r.segments.length, 4, '无有效时长的 EXTINF 其 URI 仍成片');
    assert.equal(r.segments[0].duration, 0, '缺数值时 pendingInf 为 0');
    assert.equal(r.segments[2].duration, 5);
});

test('_parsePlaylist：EXTINF 与 URI 之间夹注释行，时长归属仍正确；连续 EXTINF 取最后一条', async () => {
    const r = await parse([
        '#EXTINF:4.0,', '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z', 'a.ts',
        '#EXTINF:1.0,', '#EXTINF:7.0,', 'b.ts',
    ].join('\n'), 'http://hls.test/v/p.m3u8');
    assert.deepEqual(plain(r.segments.map((s) => s.duration)), [4, 7], '后置 EXTINF 覆盖前一条');
    assert.equal(r.segments[0].url, 'http://hls.test/v/a.ts');
});

test('_parsePlaylist：超长清单（3000 分片）序号连续且时长累加正确', async () => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (let i = 0; i < 3000; i++) lines.push('#EXTINF:2.0,', `seg-${i}.ts`);
    lines.push('#EXT-X-ENDLIST');
    const r = await parse(lines.join('\n'), 'http://hls.test/v/p.m3u8');
    assert.equal(r.segments.length, 3000);
    assert.equal(r.segments[2999].index, 2999, '索引连续递增（与数组位序一致）');
    assert.ok(Math.abs(r.totalDuration - 6000) < 1e-6);
    assert.equal(r.segments[1234].url, 'http://hls.test/v/seg-1234.ts');
});

test('_parsePlaylist：URL 解析矩阵（同目录/上级/根相对/绝对/查询/锚点/协议相对）', async () => {
    const body = [
        '#EXTINF:1,', 'same.ts',
        '#EXTINF:1,', '../up/parent.ts',
        '#EXTINF:1,', '/root/abs.ts',
        '#EXTINF:1,', 'https://cdn.b.example/abs.ts',
        '#EXTINF:1,', 'q.ts?token=abc&x=1',
        '#EXTINF:1,', 'frag.ts#sec',
        '#EXTINF:1,', '//cdn.c.example/pr.ts',
    ].join('\n');
    const r = await parse(body, 'http://a.example/hls/sub/p.m3u8');
    assert.deepEqual(plain(r.segments.map((s) => s.url)), [
        'http://a.example/hls/sub/same.ts',
        'http://a.example/hls/up/parent.ts',
        'http://a.example/root/abs.ts',
        'https://cdn.b.example/abs.ts',
        'http://a.example/hls/sub/q.ts?token=abc&x=1',
        'http://a.example/hls/sub/frag.ts#sec',
        'http://cdn.c.example/pr.ts',
    ], '相对/上级/根相对/协议相对/查询/锚点均应正确解析');
});

test('_parsePlaylist：播放列表 URL 带查询串时相对地址仍按目录解析', async () => {
    const r = await parse(['#EXTINF:1,', 'x.ts'].join('\n'), 'http://a.example/hls/p.m3u8?token=zz&t=1');
    assert.equal(r.segments[0].url, 'http://a.example/hls/x.ts', '查询串不得被当作目录层级');
});

test('_parsePlaylist：含空格与中文的分片名被百分号编码，已编码 URI 不二次编码', async () => {
    const body = [
        '#EXTINF:1,', '第 01 集.ts',
        '#EXTINF:1,', 'a%20b.ts',
        '#EXTINF:1,', '中文-分片.ts?name=张 三',
    ].join('\n');
    const r = await parse(body, 'http://a.example/hls/p.m3u8');
    assert.equal(r.segments[0].url, 'http://a.example/hls/%E7%AC%AC%2001%20%E9%9B%86.ts',
        '空格→%20、中文→UTF-8 百分号编码');
    assert.equal(r.segments[1].url, 'http://a.example/hls/a%20b.ts', '已编码的 %20 不再被二次编码（%→%25 会取不到切片）');
    assert.ok(r.segments[2].url.includes('%E5%BC%A0%20%E4%B8%89'), '查询串中的中文同样编码');
});

test('_parsePlaylist：UTF-8 BOM 后紧跟标签时不影响分片解析（BOM 不落在分片行）', async () => {
    const body = `﻿${['#EXTM3U', '#EXTINF:4.0,', 'a.ts', '#EXT-X-ENDLIST'].join('\n')}`;
    const r = await parse(body, 'http://hls.test/v/p.m3u8');
    assert.equal(r.segments.length, 1, 'BOM 落在 #EXTM3U 行上：该行仍被识别为标签（trim 后非 # 开头却无 URI 语义）');
    assert.equal(r.segments[0].url, 'http://hls.test/v/a.ts', '分片照常解析');
    assert.equal(r.totalDuration, 4);
});

test('_parsePlaylist：UTF-8 BOM 被 trim 剥离，首行标签/裸 URI 均不产生伪分片', async () => {
    // U+FEFF（ZWNBSP）属于 ECMAScript WhiteSpace，raw.trim() 会一并剥掉——
    // 故 BOM 既不会把首行标签变成分片，也不会被百分号编码进首个分片 URL。
    const withTags = `﻿${['#EXTM3U', '#EXTINF:4.0,', 'a.ts', '#EXT-X-ENDLIST'].join('\n')}`;
    const r1 = await parse(withTags, 'http://hls.test/v/p.m3u8');
    assert.equal(r1.segments.length, 1, 'BOM+标签行：不产生伪分片');
    assert.equal(r1.segments[0].url, 'http://hls.test/v/a.ts');
    assert.equal(r1.totalDuration, 4);

    const withBare = `﻿${'first.ts'}\n#EXTINF:4.0,\nsecond.ts\n`;
    const r2 = await parse(withBare, 'http://hls.test/v/p.m3u8');
    assert.equal(r2.segments.length, 2, 'BOM+裸 URI 行：正常成片');
    assert.equal(r2.segments[0].url, 'http://hls.test/v/first.ts', '首个分片 URL 不得含 %EF%BB%BF');
    assert.equal(r2.segments[0].duration, 0, '裸 URI 无前置 EXTINF，时长为 0');
    assert.equal(r2.segments[1].url, 'http://hls.test/v/second.ts', '后续分片不受影响');
});

test('_parsePlaylist：重复 URL 不去重（保留序号独立性），空/纯空白行不入片', async () => {
    const r = await parse([
        '#EXTINF:1,', 'dup.ts',
        '', '   ',
        '#EXTINF:1,', 'dup.ts',
        '#EXTINF:1,', 'dup.ts?ts=2',
        '#EXT-X-ENDLIST',
    ].join('\n'), 'http://a.example/hls/p.m3u8');
    assert.equal(r.segments.length, 3, '完全相同的 URL 不做去重（各占独立序号）');
    assert.deepEqual(plain(r.segments.map((s) => s.index)), [0, 1, 2]);
    assert.equal(r.segments[2].url, 'http://a.example/hls/dup.ts?ts=2', '查询不同视为不同分片');
});

test('_parsePlaylist：master 无候选变体抛 no variant in master playlist', async () => {
    await assert.rejects(
        () => parse(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1000', '#EXT-X-ENDLIST'].join('\n'),
            'http://hls.test/master.m3u8'),
        /no variant in master playlist/);
});

test('_parsePlaylist：master 变体选取（大小写属性）与 adFilter=true 触发两级广告过滤', async () => {
    const body = [
        '#EXTM3U',
        '#EXT-X-CUE-OUT:30',
        '#EXTINF:10.0,', 'ad1.ts',
        '#EXT-X-CUE-IN',
        '#EXTINF:8.0,', 'seg1.ts',
        '#EXTINF:8.0,', 'seg2.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const { HlsDownloader } = loadHls({ proxy: proxyOf((u) => (String(u).includes('media.m3u8') ? body : undefined)) });
    const off = await HlsDownloader.prototype._parsePlaylist.call({}, 'http://hls.test/media.m3u8', null, false);
    const on = await HlsDownloader.prototype._parsePlaylist.call({}, 'http://hls.test/media.m3u8', null, true);
    assert.equal(off.segments.length, 3, '关闭 adFilter 时 CUE 区间分片段一并解析');
    assert.equal(on.segments.length, 2, '开启 adFilter 时 CUE 广告段被剔除');
    assert.equal(on.segments[0].url, 'http://hls.test/seg1.ts');
    assert.equal(on.totalDuration, 16);
});

// ==================================================================
// _downloadSegments：并发控制 / 取消 / 进度百分比
// ==================================================================

test('_downloadSegments：并发上限生效——同时 in-flight 请求不超过设定值', async () => {
    const dir = mktmp('yuki-hls-cap-');
    let inFlight = 0;
    let peak = 0;
    const n = 8;
    const { HlsDownloader } = loadHls({
        proxy: countingProxy(async () => {
            inFlight++; peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 20));
            inFlight--;
            return { ok: true, body: 'DATA' };
        }),
    });
    const task = mkTask({ dir, _segsDir: dir, _dest: path.join(dir, 'v.mp4') });
    try {
        const segments = Array.from({ length: n }, (_, i) => ({ url: `http://hls.test/s${i}.ts`, index: i }));
        await HlsDownloader.prototype._downloadSegments.call({}, task, segments, 3);
        assert.equal(peak, 3, `并发上限 3，实测峰值 ${peak}（超出即为并发失控）`);
        assert.equal(task._downloaded, n);
        assert.equal(task._segBytes, n * 4, '字节数按各分片实际长度累加');
        assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('seg-')).length, n);
        assert.equal(task._speedTimer, null, '下载结束后速度定时器被清理');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_downloadSegments：worker 数取 min(并发, 分片数)，分片少于并发时不空转', async () => {
    const dir = mktmp('yuki-hls-wk-');
    let inFlight = 0;
    let peak = 0;
    const { HlsDownloader } = loadHls({
        proxy: countingProxy(async () => {
            inFlight++; peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 30));
            inFlight--;
            return { ok: true, body: 'DATA' };
        }),
    });
    const task = mkTask({ dir, _segsDir: dir, _dest: path.join(dir, 'v.mp4') });
    try {
        await HlsDownloader.prototype._downloadSegments.call({}, task, [
            { url: 'http://hls.test/a.ts', index: 0 },
            { url: 'http://hls.test/b.ts', index: 1 },
        ], 16);
        assert.equal(peak, 2, '两个分片开 16 并发：最多 2 个 worker 有活干');
        assert.equal(task._speedTimer, null, '下载结束后速度定时器被清理');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_downloadSegments：已标记为 removed 的任务不下载任何分片且正常返回', async () => {
    const dir = mktmp('yuki-hls-rm-');
    let requests = 0;
    const { HlsDownloader } = loadHls({
        proxy: countingProxy(async () => { requests++; return { ok: true, body: 'DATA' }; }),
    });
    const task = mkTask({ dir, _segsDir: dir, status: 'removed', _dest: path.join(dir, 'v.mp4') });
    try {
        await HlsDownloader.prototype._downloadSegments.call({}, task, [
            { url: 'http://hls.test/a.ts', index: 0 },
            { url: 'http://hls.test/b.ts', index: 1 },
        ], 2);
        assert.equal(requests, 0, '任务已删除：不应发出任何请求');
        assert.equal(task._downloaded, 0);
        assert.equal(fs.readdirSync(dir).length, 0, '分片目录保持干净');
        assert.equal(task._speedTimer, null, 'removed 路径同样要清掉速度定时器');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_downloadSegments：下载途中被取消 → 停止后续分片且不再落盘', async () => {
    const dir = mktmp('yuki-hls-cancel-');
    let requests = 0;
    const { HlsDownloader } = loadHls({
        proxy: countingProxy(async () => { requests++; return { ok: true, body: 'DATA' }; }),
    });
    const task = mkTask({ dir, _segsDir: dir, _dest: path.join(dir, 'v.mp4') });
    try {
        const segments = Array.from({ length: 20 }, (_, i) => ({ url: `http://hls.test/s${i}.ts`, index: i }));
        // 首个请求发出后即删除任务：其余 worker 应在下一轮循环处退出
        const origStatus = task.status;
        // 第 2 个请求发出后置为 removed：已起活的 worker 在本轮循环入口处自弃
        Object.defineProperty(task, 'status', {
            get() { return requests >= 2 ? 'removed' : origStatus; },
            configurable: true,
        });
        await HlsDownloader.prototype._downloadSegments.call({}, task, segments, 3);
        assert.equal(requests, 2, `取消后不再取新分片（并发 3、共 20 片，实际请求 ${requests}）`);
        assert.equal(task._downloaded, 0, '取消后完成计数不再增长');
        assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('seg-')).length, 0, '取消后不落盘分片');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_downloadSegments：percent 按 done/total 精确到 0.1%，下载阶段封顶 99', async () => {
    const dir = mktmp('yuki-hls-pct-');
    const seen = [];
    let requests = 0;
    const { HlsDownloader } = loadHls({
        proxy: countingProxy(async () => {
            requests++;
            seen.push(task.percent);
            return { ok: true, body: 'DATA' };
        }),
    });
    const task = mkTask({ dir, _segsDir: dir, _dest: path.join(dir, 'v.mp4') });
    const segments = [
        { url: 'http://hls.test/a.ts', index: 0 },
        { url: 'http://hls.test/b.ts', index: 1 },
        { url: 'http://hls.test/c.ts', index: 2 },
    ];
    try {
        await HlsDownloader.prototype._downloadSegments.call({}, task, segments, 1);
        assert.deepEqual(plain(seen), [0, 33.3, 66.7], '串行下载时逐片推进：0 → 33.3 → 66.7');
        assert.equal(task.percent, 99, '全部下完也只到 99（100 由终态赋值）');
        // 二次调用（断点续传）：命中已有且大小吻合的分片，不重拉但进度仍回到 99
        await HlsDownloader.prototype._downloadSegments.call({}, task, segments, 1);
        assert.equal(requests, 3, '续传命中：不再发起任何请求');
        assert.equal(task.percent, 99);
        assert.equal(task._segBytes, 0, '每轮下载重置字节计数（速度采样从零起算）');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_downloadSegments：单片失败重试耗尽抛错，且 finally 清理速度定时器（既有用例外的角度）', async () => {
    const dir = mktmp('yuki-hls-retry-');
    let attempts = 0;
    const { HlsDownloader } = loadHls({
        proxy: countingProxy(async () => { attempts++; return { ok: false, status: 500 }; }),
    });
    const task = mkTask({ dir, _segsDir: dir, _dest: path.join(dir, 'v.mp4') });
    try {
        await assert.rejects(
            () => HlsDownloader.prototype._downloadSegments.call({}, task, [{ url: 'http://hls.test/x.ts', index: 0 }], 1),
            /分片 1 下载失败/,
        );
        assert.equal(attempts, 3, '单分片最多 3 次尝试（0/1/2 轮后放弃）');
        assert.equal(task._speedTimer, null, '抛错路径也必须清理定时器（finally 兜底）');
        assert.equal(task.speed, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}, { timeout: 30000 });

// ==================================================================
// add()：入参加载 → 文件名清洗 / 去重 / 排队 / 协议与 ffmpeg 校验
// ==================================================================

test('add：非法字符清洗、空名/点名回落默认名、无扩展名补 .mp4', () => {
    const { HlsDownloader } = loadHls({ childProcess: fakeChildProcess([]) });
    const dir = mktmp('yuki-hls-name-');
    const h = new HlsDownloader();
    h.dir = dir;
    h._pump = () => { };
    const nameOf = (out) => {
        const g = h.add({ url: 'http://hls.test/a.m3u8', out, concurrency: 1 });
        return h._tasks.get(g).name;
    };
    try {
        assert.equal(nameOf('a/b:c*?d"e<f>g|h.mp4'), 'a_b_c__d_e_f_g_h.mp4',
            '路径分隔符与 Windows 保留字符逐个替换为下划线（位置分隔符也变下划线，无法逃逸目录）');
        assert.equal(nameOf(''), 'video.mp4', '空名回落默认名');
        assert.equal(nameOf('.'), 'video.mp4', '点名（指向目录自身）回落默认名');
        assert.equal(nameOf('..'), 'video.mp4', '双点名（逃逸父目录）回落默认名');
        assert.equal(nameOf('剧集标题'), '剧集标题.mp4', '无扩展名补 .mp4');
        assert.equal(nameOf('第01集.mkv'), '第01集.mkv', '已有扩展名不追加 .mp4');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('add：超长文件名截断到 150 字符（再补扩展名）', () => {
    const { HlsDownloader } = loadHls({ childProcess: fakeChildProcess([]) });
    const dir = mktmp('yuki-hls-long-');
    const h = new HlsDownloader();
    h.dir = dir;
    h._pump = () => { };
    try {
        const g = h.add({ url: 'http://hls.test/a.m3u8', out: 'x'.repeat(200), concurrency: 1 });
        const n = h._tasks.get(g).name;
        assert.equal(n.length, 154, '150 字符截断 + 补 .mp4');
        assert.ok(n.endsWith('.mp4'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('add：非 http(s) 协议抛 bad url protocol（file:// 等被拒）', () => {
    const { HlsDownloader } = loadHls();
    const h = new HlsDownloader();
    h.dir = mktmp('yuki-hls-proto-');
    assert.throws(() => h.add({ url: 'file:///C:/x/a.m3u8' }), /bad url protocol/);
    assert.throws(() => h.add({ url: 'ftp://a/a.m3u8' }), /bad url protocol/);
    assert.throws(() => h.add({ url: '' }), /bad url protocol/);
    assert.throws(() => h.add({}), /bad url protocol/);
    fs.rmSync(h.dir, { recursive: true, force: true });
});

test('add：ffmpeg 缺失抛 ffmpeg-missing（不建立任务）', () => {
    const { HlsDownloader } = loadHls({ ffmpeg: { findFfmpeg: () => null } });
    const h = new HlsDownloader();
    h.dir = mktmp('yuki-hls-nobin-');
    assert.throws(() => h.add({ url: 'http://hls.test/a.m3u8', out: 'x.mp4' }), /ffmpeg-missing/);
    assert.equal(h._tasks.size, 0, '抛错前不得留下任务残骸');
    fs.rmSync(h.dir, { recursive: true, force: true });
});

test('add：同名同 dest 的活跃任务复用 gid（防互覆盖临时清单），终态任务不拦', () => {
    const { HlsDownloader } = loadHls({ childProcess: fakeChildProcess([]) });
    const dir = mktmp('yuki-hls-dedupe-');
    const h = new HlsDownloader();
    h.dir = dir;
    h._pump = () => { };
    try {
        const g1 = h.add({ url: 'http://hls.test/a.m3u8', out: 'same.mp4', concurrency: 1 });
        const g2 = h.add({ url: 'http://hls.test/b.m3u8', out: 'same.mp4', concurrency: 1 });
        assert.equal(g2, g1, '同 dest 活跃任务直接复用，不重复下载');
        assert.equal(h._tasks.size, 1);
        const t = h._tasks.get(g1);
        t.status = 'complete'; // 终态不拦截
        const g3 = h.add({ url: 'http://hls.test/c.m3u8', out: 'same.mp4', concurrency: 1 });
        assert.notEqual(g3, g1, '终态任务让位：重新下载同名文件');
        assert.equal(h._tasks.size, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('add：分片并发数钳制到 1..32；并发任务数满时进入 waiting 队列', () => {
    const { HlsDownloader } = loadHls({ childProcess: fakeChildProcess([]) });
    const dir = mktmp('yuki-hls-queue-');
    const h = new HlsDownloader();
    h.dir = dir;
    try {
        h.setMaxActive(1);
        const gA = h.add({ url: 'http://hls.test/a.m3u8', out: 'a.mp4', concurrency: 0 });
        const gB = h.add({ url: 'http://hls.test/b.m3u8', out: 'b.mp4', concurrency: 99 });
        assert.equal(h._tasks.get(gA)._segConc, 1, 'concurrency 0 → 1');
        assert.equal(h._tasks.get(gB)._segConc, 32, 'concurrency 99 → 32');
        assert.equal(h._tasks.get(gA).status, 'active');
        assert.equal(h._tasks.get(gB).status, 'waiting', '达到并发任务数上限应排队');
        assert.equal(h._pending.length, 1);
        assert.ok(h._pending[0].gid === gB);
        // 释放槽位后 FIFO 补位
        h._tasks.get(gA).status = 'complete';
        h._pump();
        assert.equal(h._tasks.get(gB).status, 'active');
        assert.equal(h._pending.length, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('add：任务级 dir 参数覆盖引擎目录并自动创建（番剧子目录 RM-1）', () => {
    const { HlsDownloader } = loadHls({ childProcess: fakeChildProcess([]) });
    const root = mktmp('yuki-hls-subdir-');
    const h = new HlsDownloader();
    h.dir = mktmp('yuki-hls-engine-');
    h._pump = () => { };
    try {
        const sub = path.join(root, '番剧', 'Season 1');
        const g = h.add({ url: 'http://hls.test/a.m3u8', out: 'e01.mp4', concurrency: 1, dir: sub });
        const t = h._tasks.get(g);
        assert.ok(fs.existsSync(sub), '任务级目录应被递归创建');
        assert.equal(t._dest, path.join(sub, 'e01.mp4'));
        assert.equal(t.dir, sub);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(h.dir, { recursive: true, force: true });
    }
});

// ==================================================================
// 清理：remove / clearStopped / clearFailed / _cleanSegsDir
// ==================================================================

test('remove：清理 .incomplete/.part/分片目录/广告临时清单并出队补位', () => {
    const { HlsDownloader } = loadHls();
    const dir = mktmp('yuki-hls-remove-');
    const dest = path.join(dir, 'v.mp4');
    const segs = dest + '.hls-x.segs';
    const adTemp = dest + '.adfilter.m3u8';
    fs.writeFileSync(dest + '.incomplete.mp4', 'part');
    fs.writeFileSync(dest + '.part', 'legacy');
    fs.mkdirSync(segs, { recursive: true });
    fs.writeFileSync(path.join(segs, 'seg-000000.ts'), 'x');
    fs.writeFileSync(adTemp, '#EXTM3U');
    const h = new HlsDownloader();
    h.dir = dir;
    const t = mkTask({ gid: 'hls-x', _dest: dest, _segsDir: segs, _adTemp: adTemp, dir });
    h._tasks.set('hls-x', t);
    h._pending.push(t);
    let killed = false;
    t._proc = { kill() { killed = true; } };
    try {
        h.remove('hls-x');
        assert.ok(killed, 'remove 应杀掉在跑的 ffmpeg');
        assert.equal(h._tasks.size, 0);
        assert.equal(h._pending.length, 0, '排队任务同时出队');
        assert.ok(!fs.existsSync(dest + '.incomplete.mp4'), '.incomplete 临时产物应清理');
        assert.ok(!fs.existsSync(dest + '.part'), '历史版本 .part 残留顺带清理');
        assert.ok(!fs.existsSync(segs), '分片临时目录应清理');
        assert.ok(!fs.existsSync(adTemp), '广告过滤临时清单应清理');
        assert.equal(t.status, 'removed');
        h.remove('nope'); // 不存在的 gid：静默无操作
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('clearStopped：仅清 complete/error/removed 任务并清理其临时产物', () => {
    const { HlsDownloader } = loadHls();
    const dir = mktmp('yuki-hls-clear-');
    const h = new HlsDownloader();
    h.dir = dir;
    const mk = (gid, status, keepTemp) => {
        const dest = path.join(dir, `${gid}.mp4`);
        const segs = `${dest}.${gid}.segs`;
        const adTemp = `${dest}.adfilter.m3u8`;
        if (keepTemp) {
            fs.mkdirSync(segs, { recursive: true });
            fs.writeFileSync(adTemp, '#EXTM3U');
        }
        const t = mkTask({ gid, status, _dest: dest, _segsDir: segs, _adTemp: adTemp, dir });
        h._tasks.set(gid, t);
        return { segs, adTemp };
    };
    const a = mk('done', 'complete', true);
    const b = mk('failed', 'error', true);
    const c = mk('running', 'active', true);
    try {
        h.clearStopped();
        assert.equal(h._tasks.size, 1, '仅保留进行中的任务');
        assert.equal(h._tasks.get('running').gid, 'running');
        assert.ok(!fs.existsSync(a.segs) && !fs.existsSync(a.adTemp), '终态任务的临时产物一并清理');
        assert.ok(!fs.existsSync(b.segs) && !fs.existsSync(b.adTemp));
        assert.ok(fs.existsSync(c.segs), '活跃任务的临时产物不得被清掉');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('clearFailed：只清 error 任务并返回条数，顺带清 .incomplete/.part 残留', () => {
    const { HlsDownloader } = loadHls();
    const dir = mktmp('yuki-hls-clearfailed-');
    const dest = path.join(dir, 'f.mp4');
    fs.writeFileSync(dest + '.incomplete.mp4', 'x');
    fs.writeFileSync(dest + '.part', 'x');
    const segs = dest + '.g.segs';
    fs.mkdirSync(segs, { recursive: true });
    const h = new HlsDownloader();
    h.dir = dir;
    h._tasks.set('e1', mkTask({ gid: 'e1', status: 'error', _dest: dest, _segsDir: segs, dir }));
    h._tasks.set('a1', mkTask({ gid: 'a1', status: 'active', _dest: path.join(dir, 'ok.mp4'), _segsDir: path.join(dir, 'ok.segs'), dir }));
    try {
        assert.equal(h.clearFailed(), 1, '仅 error 任务计入');
        assert.equal(h._tasks.size, 1);
        assert.ok(!fs.existsSync(dest + '.incomplete.mp4'), '失败任务的 .incomplete 应清理');
        assert.ok(!fs.existsSync(dest + '.part'), '失败任务的 .part 应清理');
        assert.ok(!fs.existsSync(segs));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_cleanSegsDir：删除分片目录的同时清掉速度采样定时器', () => {
    const { HlsDownloader } = loadHls({
        globals: {
            // 沙箱内替换定时器 API：验证 _cleanSegsDir 真的调用了 clearInterval
            clearInterval: (handle) => { CLEARED.push(handle); },
            setInterval: () => ({ tag: 'timer' }),
        },
    });
    const dir = mktmp('yuki-hls-clearsegs-');
    const segs = path.join(dir, 'v.mp4.g.segs');
    fs.mkdirSync(segs, { recursive: true });
    fs.writeFileSync(path.join(segs, 'seg-000000.ts'), 'x');
    const h = new HlsDownloader();
    h.dir = dir;
    const t = mkTask({ gid: 'g', _dest: path.join(dir, 'v.mp4'), _segsDir: segs, dir });
    t._speedTimer = { tag: 'timer' };
    try {
        h._cleanSegsDir(t);
        assert.ok(!fs.existsSync(segs), '分片目录应被删除');
        assert.equal(t._speedTimer, null, '速度定时器句柄应释放');
        assert.deepEqual(CLEARED, [{ tag: 'timer' }], 'clearInterval 必须被调用（泄漏定时器会锁住废弃 task 闭包）');
        h._cleanSegsDir(null); // 空对象防御：不得抛异常
    } finally {
        CLEARED.length = 0;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** clearInterval 间谍收集器（配合上面的 globals 注入）。 */
const CLEARED = [];

// ==================================================================
// _spawn 进度解析：ffmpeg stderr → percent/speed（既有 hls-* 未覆盖的状态机）
// ==================================================================

test('_spawn：解析 ffmpeg 进度行更新 percent/speed（按时间差分估算速度）', () => {
    const calls = [];
    const { HlsDownloader } = loadHls({ childProcess: fakeChildProcess(calls) });
    const dir = mktmp('yuki-hls-prog-');
    const h = new HlsDownloader();
    h.dir = dir;
    try {
        const t = mkTask({ dir, _dest: path.join(dir, 'p.mp4'), url: 'http://hls.test/p.m3u8' });
        t.duration = 100;
        h._spawn(t, true);
        const proc = calls[0].proc;
        proc._stderr(Buffer.from('frame=1 size=1024kB time=00:00:10.00 bitrate=1\r\n'));
        assert.equal(t.percent, 10, '10s/100s → 10%（按 duration 折算）');
        assert.equal(t.speed, 0, '首个采样点无基准，速度置 0');
        proc._stderr(Buffer.from('frame=2 size=2048kB time=00:00:20.00 bitrate=1\r\n'));
        assert.equal(t.percent, 20);
        // (2048-1024)KB / (20-10)s = 102.4 KB/s
        assert.ok(Math.abs(t.speed - 1024 * 1024 / 10) < 1, `速度应按字节差/时间差，实际 ${t.speed}`);
        // 进度回退（源重放）时 percent 不倒退
        proc._stderr(Buffer.from('frame=1 size=512kB time=00:00:05.00 bitrate=1\r\n'));
        assert.equal(t.percent, 20, 'percent 取历史最大值，不因进度回退而下调');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_spawn：进度行跨 chunk 拼接、无 size 的 time 行重置采样基准', () => {
    const calls = [];
    const { HlsDownloader } = loadHls({ childProcess: fakeChildProcess(calls) });
    const dir = mktmp('yuki-hls-prog2-');
    const h = new HlsDownloader();
    h.dir = dir;
    try {
        const t = mkTask({ dir, _dest: path.join(dir, 'p.mp4'), url: 'http://hls.test/p.m3u8' });
        t.duration = 60;
        h._spawn(t, true);
        const proc = calls[0].proc;
        // 一行被切成两个 chunk：应按 _progressBuffer 拼接后解析
        proc._stderr(Buffer.from('frame=5 size='));
        proc._stderr(Buffer.from('1000kB time=00:00:30.00 bitrate=2\r\n'));
        assert.equal(t.percent, 50, '跨 chunk 的半行应被正确拼接解析');
        // 只有 time 没有 size：采样基准重置（下一轮速度从 0 起算，避免算出负速度）
        proc._stderr(Buffer.from('frame=6 time=00:00:31.00 bitrate=2\r\n'));
        assert.equal(t._lastProgressTime, null, '缺 size 的行应重置采样基准');
        assert.equal(t.speed, 0);
        assert.equal(t._progressBuffer, '', '完整行解析后缓冲区应清空');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_spawn：exit 0 且 part 存在 → rename 落盘并 emit completed；非零码先去 bsf 重试', () => {
    const calls = [];
    const { HlsDownloader } = loadHls({ childProcess: fakeChildProcess(calls) });
    const dir = mktmp('yuki-hls-exit-');
    const h = new HlsDownloader();
    h.dir = dir;
    const dest = path.join(dir, 'out.mp4');
    const events = [];
    h.on('completed', (f) => events.push(f));
    try {
        const t = mkTask({ dir, _dest: dest, url: 'http://hls.test/p.m3u8' });
        fs.writeFileSync(dest, 'stale');
        h._spawn(t, true);
        fs.writeFileSync(dest + '.incomplete.mp4', 'FRESH');
        calls[0].proc._fire('exit', 0);
        assert.equal(fs.readFileSync(dest, 'utf8'), 'FRESH', 'part rename 为终名，旧成品被替换');
        assert.equal(t.status, 'complete');
        assert.equal(t.percent, 100);
        assert.equal(events.length, 1, '应 emit completed');

        // 非零退出：先去 bsf 重试一轮（_retried 置位），再失败才走转码
        const t2 = mkTask({ dir, _dest: path.join(dir, 'out2.mp4'), url: 'http://hls.test/p.m3u8' });
        h._spawn(t2, true);
        assert.equal(calls.length, 2, '首次 spawn 完成');
        calls[1].proc._fire('exit', 1);
        assert.equal(calls.length, 3, '非零码应立刻重试一次（不带 bsf）');
        assert.equal(t2._retried, true);
        assert.ok(calls[1].args.includes('aac_adtstoasc'), '首轮应带 bsf');
        assert.ok(!calls[2].args.includes('aac_adtstoasc'), '重试轮去掉 bsf');
        assert.ok(!fs.existsSync(path.join(dir, 'out2.mp4') + '.incomplete.mp4'), '失败后 part 被清理');
        calls[2].proc._fire('exit', 1);
        assert.equal(calls.length, 4, '二次失败进入转码兜底');
        assert.ok(calls[3].args.includes('libx264'), '兜底轮使用重编码');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_spawn：转码兜底仍失败 → error 终态并 emit error（友好提示）', () => {
    const calls = [];
    const { HlsDownloader } = loadHls({ childProcess: fakeChildProcess(calls) });
    const dir = mktmp('yuki-hls-err-');
    const h = new HlsDownloader();
    h.dir = dir;
    const errs = [];
    h.on('error', (f) => errs.push(f));
    try {
        const t = mkTask({ dir, _dest: path.join(dir, 'e.mp4'), url: 'http://hls.test/p.m3u8' });
        h._spawn(t, true);
        calls[0].proc._fire('exit', 1);            // copy(withBsf) 失败
        calls[1].proc._fire('exit', 1);            // copy 重试失败
        calls[2].proc._fire('exit', 1);            // 转码兜底失败
        assert.equal(t.status, 'error');
        assert.equal(t.errorMessage, '切片合成失败（源可能不可达或格式异常）');
        assert.equal(errs.length, 1, '应 emit error');
        assert.equal(errs[0].gid, t.gid);
        assert.equal(calls.length, 3, '三级重试链用尽后不再 spawn');
        assert.ok(!fs.existsSync(path.join(dir, 'e.mp4')), '失败不产出成品');
        assert.ok(!fs.existsSync(path.join(dir, 'e.mp4') + '.incomplete.mp4'), '失败清理 part');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_spawn：_closing 置位后拒绝拉起（退出清理不重生孤儿 ffmpeg）', () => {
    const calls = [];
    const { HlsDownloader } = loadHls({ childProcess: fakeChildProcess(calls) });
    const dir = mktmp('yuki-hls-closing-');
    const h = new HlsDownloader();
    h.dir = dir;
    h._closing = true;
    try {
        const t = mkTask({ dir, _dest: path.join(dir, 'c.mp4'), url: 'http://hls.test/p.m3u8' });
        h._spawn(t, true);
        h._spawnTranscode(t);
        assert.equal(calls.length, 0, '_closing 后不得再 spawn 任何 ffmpeg');
        assert.equal(t._proc, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_run：adFilter 命中广告时写本地临时清单并置为 ffmpeg 输入', async () => {
    const calls = [];
    // 播放列表含 CUE-OUT 广告段：_applyAdFilter 应产出 .adfilter.m3u8 并喂给 ffmpeg
    const pl = [
        '#EXTM3U', '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.0,', 'seg0.ts',
        '#EXT-X-CUE-OUT:30',
        '#EXTINF:15.0,', 'ad1.ts',
        '#EXT-X-CUE-IN',
        '#EXTINF:10.0,', 'seg1.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const hls = loadHls({
        childProcess: fakeChildProcess(calls),
        proxy: proxyOf((u) => (String(u).includes('p.m3u8') ? pl : undefined)),
    });
    const dir = mktmp('yuki-hls-adfilter-');
    const h = new hls.HlsDownloader();
    h.dir = dir;
    const dest = path.join(dir, 'ad.mp4');
    const t = { gid: 'ad1', kind: 'hls', name: 'ad.mp4', url: 'http://hls.test/p.m3u8', header: null, dir,
        status: 'active', percent: 0, speed: 0, errorMessage: '', files: [dest], _dest: dest,
        _bin: FAKE_BIN, _proc: null, _retried: false, _transcodeRetried: false, adFilter: true,
        _adTemp: null, _input: null, _mode: 'ffmpeg', _segConc: 1, _segsDir: dest + '.ad1.segs',
        _gen: 0, duration: 0 };
    h._tasks.set('ad1', t);
    try {
        await h._run(t);
        assert.ok(t._adTemp, '应生成广告过滤临时播放列表');
        assert.equal(t._adTemp, dest + '.adfilter.m3u8', '临时清单保留 .m3u8 扩展名供 ffmpeg 推断 HLS');
        assert.ok(fs.existsSync(t._adTemp));
        const text = fs.readFileSync(t._adTemp, 'utf8');
        assert.ok(!text.includes('ad1.ts'), '广告分片不应出现在过滤后清单');
        assert.ok(text.includes('seg0.ts') && text.includes('seg1.ts'), '正片分片保留（且已绝对化）');
        assert.ok(text.includes('http://hls.test/seg0.ts'), '过滤后地址绝对化');
        assert.equal(t.adRemoved, 1);
        assert.equal(t.adRemovedSec, 15, 'CUE 删除的分片时长计入 removedSec');
        assert.ok(t.duration > 0, 'probeDuration 应回填总时长');
        assert.equal(calls[0].args[calls[0].args.indexOf('-i') + 1], t._adTemp, 'ffmpeg 输入为过滤后清单');
        h._cleanAdTemp(t);
        assert.ok(!fs.existsSync(t._adTemp), '_cleanAdTemp 应删除临时清单');
        assert.equal(t._adTemp, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}, { timeout: 30000 });

test('_run：adFilter 未命中广告时不生成临时清单，直接拉原始 URL', async () => {
    const calls = [];
    const pl = ['#EXTM3U', '#EXTINF:10.0,', 'seg0.ts', '#EXT-X-ENDLIST'].join('\n');
    const hls = loadHls({
        childProcess: fakeChildProcess(calls),
        proxy: proxyOf((u) => (String(u).includes('p.m3u8') ? pl : undefined)),
    });
    const dir = mktmp('yuki-hls-noad-');
    const h = new hls.HlsDownloader();
    h.dir = dir;
    const dest = path.join(dir, 'noad.mp4');
    const t = { gid: 'na', kind: 'hls', name: 'noad.mp4', url: 'http://hls.test/p.m3u8', header: null, dir,
        status: 'active', percent: 0, speed: 0, errorMessage: '', files: [dest], _dest: dest,
        _bin: FAKE_BIN, _proc: null, _retried: false, _transcodeRetried: false, adFilter: true,
        _adTemp: null, _input: null, _mode: 'ffmpeg', _segConc: 1, _segsDir: dest + '.na.segs', _gen: 0, duration: 0 };
    h._tasks.set('na', t);
    try {
        await h._run(t);
        assert.equal(t._adTemp, null, '无广告不生成临时清单');
        assert.equal(calls[0].args[calls[0].args.indexOf('-i') + 1], 'http://hls.test/p.m3u8', '直接喂原始 URL');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}, { timeout: 30000 });

test('_run：adFilter 拉取失败时静默走原地址（过滤失败不阻塞下载）', async () => {
    const calls = [];
    const hls = loadHls({ childProcess: fakeChildProcess(calls) }); // 默认 OFFLINE：过滤必失败
    const dir = mktmp('yuki-hls-adfail-');
    const h = new hls.HlsDownloader();
    h.dir = dir;
    const dest = path.join(dir, 'f.mp4');
    const t = { gid: 'af', kind: 'hls', name: 'f.mp4', url: 'http://hls.test/p.m3u8', header: null, dir,
        status: 'active', percent: 0, speed: 0, errorMessage: '', files: [dest], _dest: dest,
        _bin: FAKE_BIN, _proc: null, _retried: false, _transcodeRetried: false, adFilter: true,
        _adTemp: null, _input: null, _mode: 'ffmpeg', _segConc: 1, _segsDir: dest + '.af.segs', _gen: 0, duration: 0 };
    h._tasks.set('af', t);
    try {
        await h._run(t);
        assert.equal(t._adTemp, null, '过滤失败不生成临时清单');
        assert.equal(calls.length, 1, '仍照常拉起 ffmpeg');
        assert.equal(calls[0].args[calls[0].args.indexOf('-i') + 1], 'http://hls.test/p.m3u8');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}, { timeout: 30000 });

// ==================================================================
// _runConcurrent 状态机：加密回退 / 失败回退 / 成功收尾 / 终止事件
// ==================================================================

/** 启动一个真实 _runConcurrent 并拿到其 Promise（add 不返回运行时句柄，故包一层）。 */
function runRealTask(hls, opts) {
    const proto = hls.HlsDownloader.prototype;
    let p = null;
    const orig = proto._runConcurrent;
    proto._runConcurrent = function patched(task, conc) {
        p = orig.call(this, task, conc);
        return p;
    };
    return {
        restore: () => { proto._runConcurrent = orig; },
        promise: () => p,
    };
}

test('_runConcurrent：加密流（#EXT-X-KEY）回退 ffmpeg 模式并带上总时长', async () => {
    const calls = [];
    const pl = [
        '#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="k.bin"',
        '#EXTINF:10.0,', 'a.ts', '#EXTINF:5.0,', 'b.ts', '#EXT-X-ENDLIST',
    ].join('\n');
    const hls = loadHls({
        childProcess: fakeChildProcess(calls),
        proxy: proxyOf((u) => (String(u).includes('p.m3u8') ? pl : undefined)),
    });
    const dir = mktmp('yuki-hls-enc-');
    const h = new hls.HlsDownloader();
    h.dir = dir;
    const cap = runRealTask(hls);
    try {
        h.add({ url: 'http://hls.test/p.m3u8', out: 'enc.mp4', concurrency: 4, header: { Referer: 'https://ref.example' } });
        await cap.promise();
        const t = [...h._tasks.values()][0];
        assert.equal(t._mode, 'ffmpeg', '加密流应回退 ffmpeg 顺序拉流模式');
        assert.equal(t.duration, 15, '回退前解析出的总时长应回填任务');
        assert.equal(calls.length, 1, '回退只 spawn 一次 ffmpeg（不得并发拉分片）');
        const args = calls[0].args;
        assert.ok(args.includes('-i') && args.includes('http://hls.test/p.m3u8'), '直接喂原始 URL 给 ffmpeg 解密');
        assert.ok(args.includes('-headers'), '自定义 header 透传给 ffmpeg');
        assert.equal(args[args.indexOf('-headers') + 1], 'Referer: https://ref.example\r\n');
        assert.ok(!fs.existsSync(t._segsDir), '回退前已清理分片临时目录');
    } finally {
        cap.restore();
        h.cleanup();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_runConcurrent：分片下载失败 → 清分片目录、关 adFilter 并降级 ffmpeg 重下', async () => {
    const calls = [];
    const pl = ['#EXTM3U', '#EXTINF:4.0,', 'a.ts', '#EXTINF:4.0,', 'b.ts', '#EXT-X-ENDLIST'].join('\n');
    const hls = loadHls({
        childProcess: fakeChildProcess(calls),
        // 播放列表可取、分片一律 404：worker 重试耗尽后触发回退
        proxy: proxyOf((u) => (String(u).includes('.m3u8') ? pl : undefined)),
    });
    const dir = mktmp('yuki-hls-fallback-');
    const h = new hls.HlsDownloader();
    h.dir = dir;
    const cap = runRealTask(hls);
    try {
        h.add({ url: 'http://hls.test/p.m3u8', out: 'fb.mp4', concurrency: 2, adFilter: true });
        await cap.promise();
        const t = [...h._tasks.values()][0];
        assert.equal(t._mode, 'ffmpeg', '分片模式失败应降级 ffmpeg 顺序拉流');
        assert.equal(t.adFilter, false, '回退路径不做二次广告解析');
        assert.ok(!fs.existsSync(t._segsDir), '失败后分片临时目录应清理');
        assert.equal(calls.length, 1, '降级后 spawn 一次 ffmpeg（且仅一次）');
        assert.ok(calls[0].args.includes('http://hls.test/p.m3u8'), '回退喂原始 URL');
    } finally {
        cap.restore();
        h.cleanup();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}, { timeout: 60000 });

test('_runConcurrent：全流程成功 → percent 置 100、清理临时目录、emit completed', async () => {
    const calls = [];
    const pl = ['#EXTM3U', '#EXTINF:4.0,', 'a.ts', '#EXTINF:4.0,', 'b.ts', '#EXT-X-ENDLIST'].join('\n');
    // 成功型 ffmpeg：仅对 concat 轮写出 part 后以 0 退出（对应合并阶段）
    const cp = {
        spawn(bin, args, opt) {
            const proc = fakeProc(5000 + calls.length);
            calls.push({ bin, args, opt, proc });
            if (args.includes('concat')) {
                setImmediate(() => {
                    fs.writeFileSync(args[args.length - 1], 'MERGED');
                    proc._fire('exit', 0);
                });
            }
            return proc;
        },
        spawnSync() { return { status: 0 }; },
    };
    const hls = loadHls({
        childProcess: cp,
        proxy: proxyOf((u) => {
            if (String(u).includes('.m3u8')) return pl;
            return 'SEGDATA'; // 分片内容
        }),
    });
    const dir = mktmp('yuki-hls-ok-');
    const h = new hls.HlsDownloader();
    h.dir = dir;
    const cap = runRealTask(hls);
    const events = [];
    h.on('completed', (flat) => events.push(flat));
    try {
        h.add({ url: 'http://hls.test/p.m3u8', out: 'ok.mp4', concurrency: 2 });
        await cap.promise();
        await new Promise((r) => setTimeout(r, 30));
        const t = [...h._tasks.values()][0];
        assert.equal(t.status, 'complete');
        assert.equal(t.percent, 100, '成功终态百分比为 100（下载阶段封顶 99）');
        assert.equal(t.speed, 0);
        assert.ok(!fs.existsSync(t._segsDir), '成功后分片临时目录被清理');
        assert.equal(fs.readFileSync(t._dest, 'utf8'), 'MERGED', 'ffmpeg 产物 rename 为终名');
        assert.ok(!fs.existsSync(t._dest + '.incomplete.mp4'), '临时文件已 rename，不应残留');
        assert.equal(events.length, 1, '应 emit 一次 completed');
        assert.equal(events[0].gid, t.gid);
        assert.equal(events[0].kind, 'hls');
        assert.equal(events[0].percent, 100);
    } finally {
        cap.restore();
        h.cleanup();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('_runConcurrent：completed 监听器抛异常不影响终态、不额外 spawn（已修复，验证修复）', async () => {
    // 修复钉：hls-downloader.js 的 `this.emit('completed', …)` 现已包 try/catch，
    // 监听器（渲染层/其它订阅方）抛出的异常被吞掉并打 console.warn，
    // 不会回流到主 try/catch 触发 ffmpeg 兜底重下，也不会冒泡成未捕获异常。
    const calls = [];
    const pl = ['#EXTM3U', '#EXTINF:4.0,', 'a.ts', '#EXTINF:4.0,', 'b.ts', '#EXT-X-ENDLIST'].join('\n');
    const cp = {
        spawn(bin, args, opt) {
            const proc = fakeProc(6000 + calls.length);
            calls.push({ bin, args, opt, proc });
            if (args.includes('concat')) {
                setImmediate(() => {
                    fs.writeFileSync(args[args.length - 1], 'MERGED');
                    proc._fire('exit', 0);
                });
            }
            return proc;
        },
        spawnSync() { return { status: 0 }; },
    };
    const hls = loadHls({ childProcess: cp, proxy: proxyOf((u) => (String(u).includes('.m3u8') ? pl : 'SEGDATA')) });
    const dir = mktmp('yuki-hls-throw-');
    const h = new hls.HlsDownloader();
    h.dir = dir;
    const cap = runRealTask(hls);
    h.on('completed', () => { throw new Error('renderer listener boom'); });
    try {
        h.add({ url: 'http://hls.test/p.m3u8', out: 'throw.mp4', concurrency: 2 });
        await cap.promise();
        const t = [...h._tasks.values()][0];
        assert.equal(calls.length, 1, '修复后：只 spawn 一次（分片并发模式成功即收尾，不再走 ffmpeg 兜底）');
        assert.equal(t.status, 'complete', '修复后：终态为 complete');
        assert.equal(t.percent, 100, '修复后：终态百分比为 100');
        assert.notEqual(t._mode, 'ffmpeg', '修复后：不被降级为 ffmpeg 模式');
    } finally {
        cap.restore();
        h.cleanup();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ==================================================================
// _flatten / list：渲染层扁平化口径
// ==================================================================

test('_flatten：并发模式暴露 done/total 与 connections，ffmpeg 模式留空', () => {
    const { HlsDownloader } = loadHls();
    const h = new HlsDownloader();
    const base = { gid: 'g1', kind: 'hls', name: 'v.mp4', url: 'http://hls.test/p.m3u8',
        header: { Referer: 'https://r.example' }, status: 'active', percent: 42.5, files: ['D:\\v.mp4'], errorMessage: '' };
    const conc = h._flatten({
        ...base, _mode: 'concurrent', _totalSegs: 10, _downloaded: 3, speed: 1024, adRemoved: 2, adRemovedSec: 8.5,
    });
    assert.equal(conc.total, 10);
    assert.equal(conc.done, 3);
    assert.equal(conc.connections, '3/10');
    assert.equal(conc.speed, 1024, 'active 且速度为正时原样透出');
    assert.equal(conc.percent, 42.5);
    assert.equal(conc.adRemoved, 2);
    assert.equal(conc.adRemovedSec, 8.5);
    assert.equal(conc.uri, 'http://hls.test/p.m3u8', '原始 URL 透出供重启恢复');
    assert.equal(conc.header.Referer, 'https://r.example', 'header 透出供持久化恢复');

    const ff = h._flatten({ ...base, _mode: 'ffmpeg', _totalSegs: 7, _downloaded: 5, speed: 999 });
    assert.equal(ff.total, 0, 'ffmpeg 模式不暴露分片计数');
    assert.equal(ff.done, 0);
    assert.equal(ff.connections, '');
    assert.equal(ff.adRemoved, 0, '未做广告过滤时补零占位');
});

test('_flatten：非 active 或速度非法时速度归零（暂停/完成后不再显示下载速度）', () => {
    const { HlsDownloader } = loadHls();
    const h = new HlsDownloader();
    const mk = (status, speed) => h._flatten({
        gid: 'g', kind: 'hls', name: 'v.mp4', url: 'u', header: null, status, percent: 0,
        errorMessage: '', files: [], _mode: 'concurrent', _totalSegs: 1, _downloaded: 1, speed,
    });
    assert.equal(mk('active', 0).speed, 0);
    assert.equal(mk('paused', 500).speed, 0, '暂停任务速度归零');
    assert.equal(mk('complete', 500).speed, 0, '完成任务速度归零');
    assert.equal(mk('active', Number.NaN).speed, 0, 'NaN 速度兜底为 0');
    assert.equal(mk('active', -1).speed, 0, '负速度兜底为 0');
    assert.equal(mk('active', 2048).speed, 2048);
});

test('list：按插入序输出全部任务的扁平化视图', () => {
    const { HlsDownloader } = loadHls();
    const h = new HlsDownloader();
    const mkFlat = (gid, status, mode) => ({
        gid, kind: 'hls', name: `${gid}.mp4`, url: 'http://hls.test/p.m3u8', header: null, status,
        percent: 0, errorMessage: '', files: [], _mode: mode, _totalSegs: 2, _downloaded: 1, speed: 0,
    });
    h._tasks.set('a', mkFlat('a', 'active', 'concurrent'));
    h._tasks.set('b', mkFlat('b', 'waiting', 'ffmpeg'));
    const out = h.list();
    assert.equal(out.length, 2);
    assert.deepEqual(plain(out.map((x) => x.gid)), ['a', 'b']);
    assert.equal(out[0].connections, '1/2');
    assert.equal(out[1].connections, '');
    assert.ok(out.every((x) => x.kind === 'hls'), 'kind 恒为 hls 供渲染层区分 aria2');
});
