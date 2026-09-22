// 组件测试：hls-downloader.js 广告过滤纯函数（filterAdSegments / isAdUri / filterAdBlocks）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Hls = require('../../src/main/hls-downloader');

const { filterAdSegments, isAdUri, filterAdBlocks } = Hls;

test('isAdUri: 命中广告路径特征', () => {
    assert.equal(isAdUri('https://cdn.example.com/ad/pre.mp4'), true);
    assert.equal(isAdUri('https://cdn.example.com/ads/seg1.ts'), true);
    assert.equal(isAdUri('https://cdn.example.com/adbreak/x.ts'), true);
    assert.equal(isAdUri('https://cdn.example.com/hls/adsegment1.ts'), true);
});

test('isAdUri: 普通内容不误判', () => {
    assert.equal(isAdUri('https://cdn.example.com/hls/seg1.ts'), false);
    assert.equal(isAdUri('https://cdn.example.com/adventure/ep1.ts'), false);
    assert.equal(isAdUri(''), false);
});

test('filterAdSegments: CUE-OUT/CUE-IN 之间的分段剔除', () => {
    const pl = [
        '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.0,', 'seg0.ts',
        '#EXT-X-CUE-OUT:30',
        '#EXTINF:10.0,', 'ad1.ts',
        '#EXTINF:10.0,', 'ad2.ts',
        '#EXT-X-CUE-IN',
        '#EXTINF:10.0,', 'seg1.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const { filtered, removed } = filterAdSegments(pl, 'https://cdn.example.com/playlist.m3u8');
    assert.equal(removed, 2);
    assert.ok(!filtered.includes('ad1.ts'), '广告分段 ad1 应被剔除');
    assert.ok(!filtered.includes('ad2.ts'), '广告分段 ad2 应被剔除');
    assert.ok(filtered.includes('seg0.ts'));
    assert.ok(filtered.includes('seg1.ts'));
    assert.ok(filtered.includes('#EXT-X-ENDLIST'));
    assert.ok(!filtered.includes('CUE-OUT'));
});

test('filterAdSegments: 相对分段地址解析为绝对地址', () => {
    const pl = ['#EXTM3U', '#EXTINF:10.0,', 'seg/1.ts', '#EXT-X-ENDLIST'].join('\n');
    const { filtered } = filterAdSegments(pl, 'https://cdn.example.com/hls/main.m3u8');
    assert.ok(filtered.includes('https://cdn.example.com/hls/seg/1.ts'), '应补全为绝对地址');
});

test('filterAdSegments: EXT-X-KEY 相对地址改写为绝对（AES 加密流）', () => {
    const pl = [
        '#EXTM3U', '#EXT-X-VERSION:3',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
        '#EXTINF:10.0,', 'seg0.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const { filtered } = filterAdSegments(pl, 'https://cdn.example.com/hls/main.m3u8');
    assert.ok(filtered.includes('URI="https://cdn.example.com/hls/key.bin"'), 'KEY URI 应绝对化');
    assert.ok(filtered.includes('seg0.ts'));
});

test('filterAdSegments: 无广告时不删任何分段', () => {
    const pl = [
        '#EXTM3U', '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.0,', 'a.ts',
        '#EXTINF:10.0,', 'b.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const { removed, filtered } = filterAdSegments(pl, 'https://cdn.example.com/main.m3u8');
    assert.equal(removed, 0);
    assert.ok(filtered.includes('a.ts') && filtered.includes('b.ts'));
});

test('filterAdSegments: 空输入安全返回', () => {
    const { filtered, removed } = filterAdSegments('', 'https://cdn.example.com/main.m3u8');
    assert.equal(removed, 0);
    assert.equal(filtered, '');
});

// ------------------------------------------------------------------
// filterAdBlocks：DISCONTINUITY 广告块启发式（与 python-backend/ad_filter.py
// 同规则：多特征叠加防错杀、正片主体永不删、30% 安全阀）
// ------------------------------------------------------------------

/** 广告块标准样例（对齐 ad_filter.py 自检样例）：块内跨 host 分片应整块删除。 */
const AD_BLOCK_PL = [
    '#EXTM3U', '#EXT-X-TARGETDURATION:10',
    '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
    '#EXTINF:10.0,', 'http://video.cdn/v/seg-02.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:5.0,', 'http://ad.cdn/ad/01.ts',
    '#EXTINF:5.0,', 'http://ad.cdn/ad/02.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:10.0,', 'http://video.cdn/v/seg-03.ts',
    '#EXT-X-ENDLIST',
].join('\n');

test('filterAdBlocks: DISCONTINUITY 内跨 host 广告块整块删除，正片保留', () => {
    const r = filterAdBlocks(AD_BLOCK_PL, 'http://video.cdn/v/index.m3u8');
    assert.equal(r.removed, 2);
    assert.equal(r.removedSec, 10);
    assert.ok(!r.text.includes('ad/01'), '广告分片应被删除');
    assert.ok(r.text.includes('seg-01') && r.text.includes('seg-03'), '正片分片保留');
    assert.ok(r.text.includes('#EXT-X-ENDLIST'), '结构标签保留');
});

test('filterAdBlocks: 相对地址广告分片按清单 host 归属后删除', () => {
    const pl = [
        '#EXTM3U',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-02.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:5.0,', 'http://ad.cdn/ads/x1.ts',
        '#EXTINF:5.0,', 'http://ad.cdn/ads/x2.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-03.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, 'http://video.cdn/v/index.m3u8');
    assert.equal(r.removed, 2);
    assert.ok(!r.text.includes('ads/x1'));
});

test('filterAdBlocks: 词边界防误报——/video/ad-01.ts 是正片路径不删', () => {
    const pl = [
        '#EXTM3U',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
        '#EXTINF:10.0,', 'http://video.cdn/video/ad-01.ts',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-03.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, 'http://video.cdn/v/index.m3u8');
    assert.equal(r.removed, 0, 'ad-01 的连字符不是词边界，不得判为广告路径');
    assert.ok(r.text.includes('video/ad-01.ts'));
});

test('filterAdBlocks: 安全阀——广告块占全片比例超 30% 时整份放弃过滤', () => {
    // 防假绿构造（2026-09-22 重写）：正片 10×10s=100s 占主体（条数、时长均
    // 过半），广告块 6×8s=48s 跨 host 且命中 /ad/ 路径——若删除安全阀逻辑，
    // 该块会被整块删除（48/148≈32.4% 超 30%），即安全阀是唯一拦截点，
    // 本用例必然转红（removed 变 6 而非 0）。注释即对偶验证方式，无需真做
    // 变异测试。旧 fixture（广告 60s vs 正片 40s，广告为时长主体）全部走
    // 「无命中」路径，删掉安全阀依然绿，属假绿。
    const segs = [];
    for (let i = 1; i <= 10; i++) {
        segs.push(`#EXTINF:10.0,`, `http://video.cdn/v/seg-${String(i).padStart(2, '0')}.ts`);
    }
    const pl = [
        '#EXTM3U',
        ...segs.slice(0, 10),           // 前 5 个正片分片
        '#EXT-X-DISCONTINUITY',
        ...Array.from({ length: 6 }, (_, i) => [`#EXTINF:8.0,`, `http://ad.cdn/ad/${i}.ts`]).flat(),  // 广告块 6×8s=48s
        '#EXT-X-DISCONTINUITY',
        ...segs.slice(10),              // 后 5 个正片分片
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, 'http://video.cdn/v/index.m3u8');
    assert.equal(r.removed, 0, '超安全阀应整份放弃');
    assert.equal(r.removedSec, 0);
    assert.ok(r.text.includes('ad/0.ts'), '原文原样返回');
    // 命中确实发生（走了启发式判定而非「无命中」假绿路径）：块内 6 片全部命中
    assert.equal(r.reasons.filter((s) => s.includes('cross-host segment in discontinuity block')).length, 6,
        '6 个广告分片必须全部命中（锁定走了目标分支），否则 fixture 失真');
});

test('filterAdBlocks: 块时长超 120s（更像正片段落）不删', () => {
    // 防假绿构造（2026-09-22 重写）：正片 30×10s=300s 占主体；广告块跨 host
    // 且命中 /ad/ 路径（每片 16s≤30s 但 ≥0.6×10s，shortOdd 不成立，不依赖
    // 时长特征）。
    // 对偶双查（防假绿 + 防御变异）：同一 fixture 形态、块累计恰 120s
    // （8×15s）时整块删除且 reasons 非空——证明 fixture 真实命中宽松通道
    // （走了目标分支）；块累计 128s（>120s）时整块放过，且删除占比
    // 128/428≈29.9%<30% 安全阀不拦——120s 上限是唯一拦截点，删除被测
    // 防御逻辑本用例必然转红（removed 变 8 而非 0）。旧 fixture（2×40s=80s
    // 未超上限、无路径词命中，与注释「4 个 40s 分片=160s」不符）属假绿。
    const build = (adDur, adCount) => {
        const segs = [];
        for (let i = 1; i <= 30; i++) {
            segs.push(`#EXTINF:10.0,`, `http://video.cdn/v/seg-${String(i).padStart(2, '0')}.ts`);
        }
        return [
            '#EXTM3U',
            ...segs.slice(0, 20),           // 前 10 个正片分片
            '#EXT-X-DISCONTINUITY',
            ...Array.from({ length: adCount }, (_, i) =>
                [`#EXTINF:${adDur.toFixed(1)},`, `http://ad.cdn/ad/${i}.ts`]).flat(),
            '#EXT-X-DISCONTINUITY',
            ...segs.slice(20),              // 后 10 个正片分片
            '#EXT-X-ENDLIST',
        ].join('\n');
    };
    // 对照（目标分支锁定）：8×15s=120s 恰在上限内 → 整块删除，reasons 非空
    const atCap = filterAdBlocks(build(15.0, 8), 'http://video.cdn/v/index.m3u8');
    assert.equal(atCap.removed, 8, '恰 120s 的同形态块应整块删除（fixture 命中证明）');
    assert.equal(atCap.removedSec, 120);
    assert.ok(atCap.reasons.length >= 8, '命中原因必须非空（锁定走了目标分支）');
    // 被测行为：8×16s=128s > 120s → 整块放过
    const over = filterAdBlocks(build(16.0, 8), 'http://video.cdn/v/index.m3u8');
    assert.equal(over.removed, 0, '块累计 128s 超 120s 上限，整块放过');
    assert.ok(over.text.includes('ad/0.ts'));
});

test('filterAdBlocks: 单分片孤立 discontinuity 块不删（低于块分片数下限）', () => {
    const pl = [
        '#EXTM3U',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-02.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:5.0,', 'http://ad.cdn/ad/01.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-03.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, 'http://video.cdn/v/index.m3u8');
    assert.equal(r.removed, 0, '编码切换的孤立块删了就是错杀');
});

test('filterAdBlocks: master 清单与无 EXTINF 文本原样返回', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nhttp://video.cdn/hi.m3u8\n';
    const r1 = filterAdBlocks(master, 'http://video.cdn/index.m3u8');
    assert.equal(r1.text, master);
    assert.equal(r1.removed, 0);
    const event = '#EXTM3U\n#EXT-X-ENDLIST\n';
    const r2 = filterAdBlocks(event, '');
    assert.equal(r2.text, event);
});

test('filterAdBlocks: 分片过少（<3）无统计意义，原样返回', () => {
    const pl = [
        '#EXTM3U',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
        '#EXTINF:5.0,', 'http://ad.cdn/ad/01.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, 'http://video.cdn/v/index.m3u8');
    assert.equal(r.removed, 0);
    assert.equal(r.text, pl);
});

test('filterAdBlocks: 同 host 正片分片仅路径命中不删（防错杀）', () => {
    // 同 host + /ad/ 路径但无 discontinuity 包裹：证据不足，不动手
    const pl = [
        '#EXTM3U',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-02.ts',
        '#EXTINF:10.0,', 'http://video.cdn/upload/ad/seg-99.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, 'http://video.cdn/v/index.m3u8');
    assert.equal(r.removed, 0);
});

test('filterAdSegments: CUE 删除的分片时长计入 removedSec（日志秒数口径完整）', () => {
    const pl = [
        '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.0,', 'seg0.ts',
        '#EXT-X-CUE-OUT:30',
        '#EXTINF:12.5,', 'ad1.ts',
        '#EXTINF:7.5,', 'ad2.ts',
        '#EXT-X-CUE-IN',
        '#EXTINF:10.0,', 'seg1.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const { filtered, removed, removedSec } = filterAdSegments(pl, 'https://cdn.example.com/playlist.m3u8');
    assert.equal(removed, 2);
    assert.equal(removedSec, 20, 'CUE 删除的 12.5s + 7.5s 必须计入累计时长');
    assert.ok(!filtered.includes('ad1.ts') && filtered.includes('seg1.ts'));
});

test('filterAdSegments: 保留分片的 pendingSec 不误入统计', () => {
    const pl = [
        '#EXTM3U', '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.0,', 'a.ts',
        '#EXTINF:9.0,', 'b.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const { removed, removedSec } = filterAdSegments(pl, 'https://cdn.example.com/main.m3u8');
    assert.equal(removed, 0);
    assert.equal(removedSec, 0);
});

// ------------------------------------------------------------------
// 回归（2026-09-22，与 python-backend/ad_filter.py 同步修复）
// ------------------------------------------------------------------

test('filterAdBlocks: 裸 URI 行（无 EXTINF）用全新状态收口，不继承上一分片行号', () => {
    // 回归（high）：旧行为裸 URI 行继承 pendingDur/pendingLine，删除窗口按
    // 错误行号覆盖前一个正片分片（错杀正片、留下真广告）。
    const pl = [
        '#EXTM3U', '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-02.ts',
        '#EXT-X-DISCONTINUITY',
        'http://ad.cdn/ad/01.ts',   // 裸 URI：无 EXTINF 前缀
        'http://ad.cdn/ad/02.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-03.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, 'http://video.cdn/v/index.m3u8');
    assert.ok(!r.text.includes('ad.cdn'), '真广告（裸 URI）应被删除');
    assert.ok(r.text.includes('seg-02.ts'), '前一个正片分片不得被连带错杀');
    assert.ok(r.text.includes('seg-01.ts') && r.text.includes('seg-03.ts'));
    assert.equal(r.removed, 2);
});

test('filterAdBlocks: 跨 host + 无路径证据的 OP 块不删（防错杀修订）', () => {
    // 2026-09-22 修订口径：跨 host 只是来源不同这一条证据，任何删除都必须有
    // pathHit 作为第二证据；shortOdd 仅作放大器。独立压制的 OP 不再被误删。
    const pl = [
        '#EXTM3U',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:8.0,', 'http://op.cdn/op/part-01.ts',
        '#EXTINF:8.0,', 'http://op.cdn/op/part-02.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-02.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, 'http://video.cdn/v/index.m3u8');
    assert.equal(r.removed, 0, '跨 host 无路径证据：宁可漏过滤');
    assert.ok(r.text.includes('op.cdn'));
});

test('filterAdBlocks: 跨 host + 短时长 + 无路径词也不删（shortOdd 降级为放大器）', () => {
    const pl = [
        '#EXTM3U',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-02.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:5.0,', 'http://op.cdn/op/short-01.ts',
        '#EXTINF:5.0,', 'http://op.cdn/op/short-02.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-03.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, 'http://video.cdn/v/index.m3u8');
    assert.equal(r.removed, 0, '旧口径（跨 host+短时长即删）已收紧');
    assert.ok(r.text.includes('short-01'));
});

test('filterAdBlocks: 未闭合 DISCONTINUITY 禁用块内宽松通道并告警', () => {
    // 清单以奇数个 DISCONTINUITY 收尾（写坏/截断）：其后分片的块标记不可信，
    // 只允许严格组合；返回值 unclosedDiscontinuity 告警置位。
    const pl = [
        '#EXTM3U',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-02.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:8.0,', 'http://op.cdn/op/part-01.ts',
        '#EXTINF:8.0,', 'http://op.cdn/op/part-02.ts',
        // 无配对的关闭 DISCONTINUITY
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, 'http://video.cdn/v/index.m3u8');
    assert.equal(r.unclosedDiscontinuity, true, '未闭合告警必须置位');
    assert.equal(r.removed, 0, '宽松通道已禁用：跨 host 无路径词不删');
    assert.ok(r.text.includes('op.cdn'));

    // 对照：正常配对（偶数）时无告警
    const ok = filterAdBlocks(
        [
            '#EXTM3U',
            '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
            '#EXTINF:10.0,', 'http://video.cdn/v/seg-02.ts',
            '#EXT-X-DISCONTINUITY',
            '#EXTINF:8.0,', 'http://op.cdn/op/part-01.ts',
            '#EXTINF:8.0,', 'http://op.cdn/op/part-02.ts',
            '#EXT-X-DISCONTINUITY',
            '#EXT-X-ENDLIST',
        ].join('\n'),
        'http://video.cdn/v/index.m3u8');
    assert.equal(ok.unclosedDiscontinuity, false);
});

test('filterAdBlocks: 未闭合 DISCONTINUITY 时严格组合（跨 host+路径+时长）仍生效', () => {
    const pl = [
        '#EXTM3U',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-01.ts',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-02.ts',
        '#EXTINF:10.0,', 'http://video.cdn/v/seg-03.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:5.0,', 'http://ad.cdn/ad/x01.ts',   // 跨 host + 路径命中 + 短异常
        '#EXTINF:5.0,', 'http://ad.cdn/ad/x02.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');
    const r = filterAdBlocks(pl, 'http://video.cdn/v/index.m3u8');
    assert.equal(r.unclosedDiscontinuity, true);
    assert.equal(r.removed, 2, '不依赖包裹证据的严格组合照删');
    assert.ok(!r.text.includes('x01.ts'));
    assert.ok(r.reasons.every((s) => s.includes('odd duration')),
        '报告原因取严格组合（非块内命中误标）');
});

test('filterAdBlocks: 空输入安全返回', () => {
    const r = filterAdBlocks('', 'http://video.cdn/index.m3u8');
    assert.equal(r.text, '');
    assert.equal(r.removed, 0);
    assert.equal(r.unclosedDiscontinuity, false);
});
