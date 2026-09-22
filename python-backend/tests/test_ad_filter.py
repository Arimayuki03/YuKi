# -*- coding: utf-8 -*-
"""HLS 广告段过滤（ad_filter）单元测试。

覆盖：DISCONTINUITY 包裹的跨 host 广告块删除、同 host 正片保护、
路径关键词组合判定、master 清单原样放行、全相对清单 host 缺失退化、
安全阀（删除超 30% 放弃过滤）、孤立 discontinuity 块不错杀。
只测纯文本变换，不出网、不拉起服务。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
for _path in (BASE, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from ad_filter import (  # noqa: E402
    MAX_AD_BLOCK_SEC,
    filter_m3u8,
)


def _playlist(*parts: str) -> str:
    """把 (标签/分片) 片段拼成 m3u8 文本，每段独立一行，便于断言。"""
    return "#EXTM3U\n#EXT-X-TARGETDURATION:10\n" + "".join(
        p + "\n" for p in parts) + "#EXT-X-ENDLIST\n"


def _seg(host: str, path: str, dur: float) -> str:
    return f"#EXTINF:{dur},\nhttp://{host}{path}"


def test_discontinuity_wrapped_cross_host_ad_block_removed():
    """广告核心形态：DISCONTINUITY 包裹 + 跨 host + 路径命中 → 整块删除。

    2026-09-22 修订口径：跨 host 只是来源不同这一条证据，任何删除都必须有
    path_hit 作为第二证据（原「跨 host + 短时长即可删」通道已收紧——短时长
    仅作放大器），故 fixture 用 /ad/ 广告路径。
    """
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("ad.cdn", "/ad/01.ts", 5.0),
        _seg("ad.cdn", "/ad/02.ts", 5.0),
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/v/seg-03.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert "ad/01.ts" not in cleaned and "ad/02.ts" not in cleaned
    assert "seg-01.ts" in cleaned and "seg-03.ts" in cleaned
    assert rep.removed_count == 2
    assert rep.removed_sec == 10.0
    assert rep.total_segments == 5
    assert rep.unclosed_discontinuity is False


def test_cross_host_short_duration_without_path_evidence_kept():
    """行为变化锁定（2026-09-22 修订）：DISCONTINUITY 包裹 + 跨 host + 短时长
    但无路径广告词——不删（旧口径 short_odd 单独与跨 host 组成删除依据，
    会误删独立压制的 OP；修订后短时长仅作放大器，删除必须有 path_hit）。"""
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("op.cdn", "/op/short-01.ts", 5.0),
        _seg("op.cdn", "/op/short-02.ts", 5.0),
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/v/seg-03.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert cleaned == text
    assert rep.removed_count == 0


def test_same_host_discontinuity_block_kept():
    """误伤保护：DISCONTINUITY 包裹但与正片同 host、无路径特征的多分片块
    （典型：OP/ED 独立压制段、编码切换）——不删。"""
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/v/op-01.ts", 5.0),
        _seg("video.cdn", "/v/op-02.ts", 5.0),
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert cleaned == text  # 原样返回
    assert rep.removed_count == 0


def test_same_host_ad_path_block_removed():
    """同 host 但路径命中广告词 + 时长异常 + DISCONTINUITY 包裹 → 删。
    （路径词是同 host 场景唯一可用特征，故要求三条同时成立。）

    正片用 4×10s 保证广告占比（10/50=20%）低于 30% 安全阀。
    """
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/guanggao/g01.ts", 5.0),
        _seg("video.cdn", "/guanggao/g02.ts", 5.0),
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/v/seg-03.ts", 10.0),
        _seg("video.cdn", "/v/seg-04.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert "guanggao" not in cleaned
    assert rep.removed_count == 2


def test_short_single_segment_without_discontinuity_kept():
    """误伤保护：无 DISCONTINUITY、无路径特征的孤立短分片（封面帧/关键帧
    切换常见形态）——即便跨 host 也不删（跨 host 无路径证据证据不足，
    2026-09-22 修订后任何删除都以 path_hit 为第二证据）。"""
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("cover.cdn", "/c/cover.ts", 2.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert "cover.ts" in cleaned
    assert rep.removed_count == 0


def test_cross_host_op_block_without_path_evidence_kept():
    """误伤保护（2026-09-22 修订）：DISCONTINUITY 包裹 + 跨 host 但无路径
    广告词、时长不异常的整块（典型：独立压制的 OP）——不删。跨 host 只是
    来源不同这一条证据，任何删除都必须有 path_hit 作为第二证据。"""
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("op.cdn", "/op/part-01.ts", 8.0),
        _seg("op.cdn", "/op/part-02.ts", 8.0),
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert cleaned == text  # 原样返回
    assert rep.removed_count == 0


def test_cross_host_block_with_path_evidence_removed():
    """对照：同样的跨 host 块但路径命中广告词（第二证据成立）→ 整块删除。
    正片 5×10s=50s 占主体，广告 2×8s=16s 占比 24%<30%，安全阀不拦。"""
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        _seg("video.cdn", "/v/seg-03.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("ad.cdn", "/ad/01.ts", 8.0),
        _seg("ad.cdn", "/ad/02.ts", 8.0),
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/v/seg-04.ts", 10.0),
        _seg("video.cdn", "/v/seg-05.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert "ad.cdn" not in cleaned
    assert rep.removed_count == 2
    # 报告原因来自块内首次判定缓存（verdict 复用，非事后重判）
    assert all("discontinuity block" in r[2] for r in rep.removed)


def test_long_ad_block_over_120s_kept():
    """误伤保护：DISCONTINUITY 包裹的跨 host 块累计时长超过广告位量级
    （>120s）——更可能是正片分段，整块放过。

    防假绿构造（2026-09-22 重写）：正片 30×10s=300s 同 host 占主体；广告块
    跨 host 且路径命中（新口径下仅 path_hit+discontinuity 宽松通道即成立，
    每片 16s 满足 ≤30s 上限但 ≥0.6×10s 所以 short_odd 不成立——不能依赖
    时长特征）。

    对偶双查（防假绿 + 防御变异）：
    - 对照：同形态块累计恰 120s（8×15s）→ 整块删除、报告原因非空，证明
      fixture 真实命中宽松通道（走了目标分支）；
    - 被测：块累计 128s（>120s）→ 整块放过，且 128/428≈29.9%<30% 安全阀
      不拦——120s 上限是唯一拦截点，删除被测防御逻辑本用例必然转红
      （removed_count 变 8 而非 0）。注释即对偶验证方式，无需真做变异测试。
    """
    def _build(ad_dur: float, ad_count: int) -> str:
        parts = [_seg("video.cdn", f"/v/seg-{i:02d}.ts", 10.0) for i in range(30)]
        parts[10:10] = ["#EXT-X-DISCONTINUITY"]
        for i in range(ad_count):
            parts.insert(11 + i, _seg("ad.cdn", f"/ad/{i}.ts", ad_dur))
        parts.insert(11 + ad_count, "#EXT-X-DISCONTINUITY")
        return _playlist(*parts)

    # 对照（目标分支锁定）：8×15s=120s 恰在上限内 → 整块删除
    at_cap_text = _build(15.0, 8)
    at_cap, at_cap_rep = filter_m3u8(at_cap_text, "http://video.cdn/v/index.m3u8")
    assert at_cap_rep.removed_count == 8, "对照 fixture 必须真实命中（否则主断言假绿）"
    assert "ad.cdn" not in at_cap
    assert all("discontinuity block" in r[2] for r in at_cap_rep.removed)

    # 被测行为：8×16s=128s > 120s → 整块放过
    text = _build(16.0, 8)
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert "ad/0.ts" in cleaned
    assert rep.removed_count == 0


def test_mixed_block_never_partially_removed():
    """误伤保护：块内混有同 host 正片分片时整块放过，不允许部分删除
    （部分删除会截断媒体时间线造成花屏/断音，比广告更伤体验）。"""
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("ad.cdn", "/a/01.ts", 5.0),
        _seg("video.cdn", "/v/real-01.ts", 6.0),
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert "real-01.ts" in cleaned  # 正片分片必须原样保留
    assert "a/01.ts" in cleaned     # 整块放弃：宁可漏过滤


def test_master_playlist_passthrough():
    """master（多码率）清单无分片概念，原样返回不解析。"""
    text = ("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480\n"
            "480p/index.m3u8\n"
            "#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1080x720\n"
            "720p/index.m3u8\n")
    cleaned, rep = filter_m3u8(text)
    assert cleaned == text
    assert rep.total_segments == 0


def test_all_relative_playlist_without_base_url():
    """全相对分片 + 未传 base_url：host 特征失效，退化为
    路径+时长+discontinuity 三重组合判定；无路径特征的同源块不删。"""
    text = _playlist(
        "seg-01.ts",
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        "seg-03.ts",
        "seg-04.ts",
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/v/seg-05.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text)
    assert cleaned == text
    assert rep.removed_count == 0


def test_relative_playlist_with_base_url_cross_host_removed():
    """带 EXTINF 的相对分片 + 传入 base_url：相对分片继承清单 host，
    跨 host 广告照删（顺带覆盖 EXTINF 与 URI 之间夹 DISCONTINUITY 标签的
    解析归属：标签行必须跟随前一分片，不得吞掉后一分片的 EXTINF）。"""
    text = _playlist(
        "#EXTINF:10.0,",
        "seg-01.ts",
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("ad.cdn", "/ad/a1.ts", 5.0),
        _seg("ad.cdn", "/ad/a2.ts", 5.0),
        "#EXT-X-DISCONTINUITY",
        "#EXTINF:10.0,",
        "seg-03.ts",
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert "ad.cdn" not in cleaned
    assert rep.removed_count == 2


def test_safety_valve_over_30pct_aborts():
    """安全阀：疑似广告占总时长超 30% 时整份放弃——启发式大面积误判
    （或清单本身就是广告合集）都比错杀正片安全。

    防假绿构造：正片按条数与时长都占主体（10×10s 同 host 正片），广告块
    （6×8s=48s）跨 host 且路径命中——若无安全阀该块会被整块删除
    （48/148≈32.4% 超过 30%）。即安全阀是唯一拦截点：删除安全阀逻辑后
    本用例必然转红（removed_count 变 6 而非 0）——注释即对偶验证方式，
    无需真做变异测试。

    对偶对照：同形态、广告 5×8s=40s（40/140≈28.6%<30%）时安全阀不拦、
    块被整删且报告原因非空——证明 fixture 真实命中宽松通道（走了目标
    分支），上方主断言的「removed_count==0」确实出自安全阀而非无命中。
    """
    def _build(ad_count: int) -> str:
        parts = [_seg("video.cdn", f"/v/seg-{i:02d}.ts", 10.0) for i in range(10)]
        parts[5:5] = ["#EXT-X-DISCONTINUITY"]
        for i in range(ad_count):
            parts.insert(6 + i, _seg("ad.cdn", f"/ad/{i}.ts", 8.0))
        parts.insert(6 + ad_count, "#EXT-X-DISCONTINUITY")
        return _playlist(*parts)

    text = _build(6)
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    # 安全阀触发：整份放弃，原文原样返回
    assert "ad/0.ts" in cleaned
    assert rep.removed_count == 0

    # 对照（目标分支锁定）：占比低于 30% 时同形态块被整删、报告原因非空
    under_text = _build(5)
    under_clean, under_rep = filter_m3u8(under_text, "http://video.cdn/v/index.m3u8")
    assert under_rep.removed_count == 5, "对照 fixture 必须真实命中（否则主断言假绿）"
    assert "ad.cdn" not in under_clean
    assert all("discontinuity block" in r[2] for r in under_rep.removed)


def test_discontinuity_sequence_tag_ignored():
    """#EXT-X-DISCONTINUITY-SEQUENCE 只声明序列号偏移，不是位置边界：
    不应触发区间标记，也不应把后面正片误判进块。"""
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        _seg("video.cdn", "/v/seg-03.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("ad.cdn", "/ad/a1.ts", 5.0),
        _seg("ad.cdn", "/ad/a2.ts", 5.0),
        "#EXT-X-DISCONTINUITY",
        "#EXT-X-DISCONTINUITY-SEQUENCE:2",
        _seg("video.cdn", "/v/seg-99.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert rep.removed_count == 2
    assert "seg-99.ts" in cleaned


def test_large_block_majority_not_flipped():
    """广告块分片条数多于正片时（按时长加权主体）主体 host 仍是正片：
    广告 host 不会反客为主把正片判成广告。"""
    parts = [_seg("video.cdn", "/v/seg-01.ts", 30.0)]
    parts.append("#EXT-X-DISCONTINUITY")
    for i in range(10):
        parts.append(_seg("ad.cdn", f"/ad/{i}.ts", 2.0))  # 20s < 30s
    parts.append("#EXT-X-DISCONTINUITY")
    parts.append(_seg("video.cdn", "/v/seg-02.ts", 30.0))
    text = _playlist(*parts)
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert "seg-01.ts" in cleaned and "seg-02.ts" in cleaned
    assert rep.removed_count == 10  # 广告块全删，正片无损


def test_ad_path_without_duration_evidence_kept():
    """误伤保护：路径命中 /ad/ 但分片时长与正片主体一致（非短异常），
    同 host 且无 discontinuity → 不删（目录名巧合不应错杀）。"""
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("video.cdn", "/upload/ad/extra.ts", 10.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert "extra.ts" in cleaned
    assert rep.removed_count == 0


def test_few_segments_statistically_meaningless():
    """分片 <3 个无法确定正片主体：整份放行（宁可漏过滤）。"""
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("ad.cdn", "/ad/a1.ts", 5.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert cleaned == text
    assert rep.total_segments == 2


def test_malformed_and_empty_inputs():
    """畸形输入不抛错、原样返回。"""
    for bad in ("", None, "not a playlist", "#EXTM3U\n"):
        cleaned, rep = filter_m3u8(bad)  # type: ignore[arg-type]
        assert rep.removed_count == 0


def test_ad_block_at_max_threshold_boundary():
    """块时长恰好等于上限（120s）时仍可删；超过则放过（边界回归）。

    正片主体用 5×60s=300s 保证 host 主体判定与 30% 安全阀都站在
    正片一侧（120s 广告占比 28.6%）；真实清单中广告占比不会到 86%。
    """
    parts = [_seg("video.cdn", f"/v/seg-{i}.ts", 60.0) for i in range(5)]
    parts[2:2] = ["#EXT-X-DISCONTINUITY"]
    parts.append("#EXT-X-DISCONTINUITY")
    parts[2:2] = []
    # 结构：3×60s 正片 → DISCONTINUITY → 2×60s 广告 → DISCONTINUITY → 2×60s 正片
    text = _playlist(
        _seg("video.cdn", "/v/seg-a.ts", 60.0),
        _seg("video.cdn", "/v/seg-b.ts", 60.0),
        _seg("video.cdn", "/v/seg-c.ts", 60.0),
        "#EXT-X-DISCONTINUITY",
        _seg("ad.cdn", "/ad/b1.ts", 60.0),
        _seg("ad.cdn", "/ad/b2.ts", 60.0),
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/v/seg-d.ts", 60.0),
        _seg("video.cdn", "/v/seg-e.ts", 60.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    # 120s 恰好在 MAX_AD_BLOCK_SEC 上：属于广告位量级，删除
    assert rep.removed_count == 2
    assert "ad/b1.ts" not in cleaned

    over = text.replace("#EXTINF:60.0,\nhttp://ad.cdn/ad/b2.ts",
                        "#EXTINF:61.0,\nhttp://ad.cdn/ad/b2.ts")
    cleaned2, rep2 = filter_m3u8(over, "http://video.cdn/v/index.m3u8")
    assert rep2.removed_count == 0
    assert "ad/b1.ts" in cleaned2
    assert MAX_AD_BLOCK_SEC == 120.0


def test_bare_uri_line_does_not_inherit_pending_state():
    """回归（2026-09-22，high）：无 EXTINF 的裸 URI 行必须用全新状态收口
    （[raw]、0.0、当前行号），不得继承上一分片的 pending_dur/pending_line
    ——旧行为会把裸 URI 分片的删除窗口按上一分片的行号计算，错删前一个
    正片分片、留下真广告。

    构造：正片 3×10s + 裸 URI 广告块（无 EXTINF，时长按 0 计、不满足
    short_odd，仅靠路径命中 + discontinuity 宽松通道判定）。修复后删除
    窗口恰好覆盖广告自身行，正片 seg-02 必须保留。
    """
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        "http://ad.cdn/ad/01.ts",   # 裸 URI：无 EXTINF 前缀
        "http://ad.cdn/ad/02.ts",
        "#EXT-X-DISCONTINUITY",
        _seg("video.cdn", "/v/seg-03.ts", 10.0),
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    # 真广告（裸 URI）被删
    assert "ad.cdn" not in cleaned
    # 前一个正片分片不被连带错杀（旧行为会把它按广告行号窗口误删）
    assert "seg-02.ts" in cleaned
    assert "seg-01.ts" in cleaned and "seg-03.ts" in cleaned
    assert rep.removed_count == 2


def test_unclosed_discontinuity_disables_lenient_block_channel():
    """回归（2026-09-22，low）：清单以奇数个 DISCONTINUITY 收尾（写坏/截断）
    时——a) report.unclosed_discontinuity 告警置位；b) 其后分片不走块内宽松
    判定（只允许严格组合），跨 host+单条特征的整块不再被放大误杀。

    构造：尾部故意只放 1 个 DISCONTINUITY（不闭合），其后为跨 host 无路径
    词的正片段（OP 形态）。旧行为会把整段当广告块宽松评估；修复后仅凭
    跨 host 不删（块内宽松通道已禁用），并报告未闭合告警。
    """
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("op.cdn", "/op/part-01.ts", 8.0),
        _seg("op.cdn", "/op/part-02.ts", 8.0),
        _seg("op.cdn", "/op/part-03.ts", 8.0),
        # 注意：没有配对的关闭 DISCONTINUITY
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert rep.unclosed_discontinuity is True
    assert "op.cdn" in cleaned          # 未闭合时宽松通道禁用：不删
    assert rep.removed_count == 0

    # 对照：正常配对（偶数）时同样的跨 host 无路径块同样不删，且无告警
    ok_text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("op.cdn", "/op/part-01.ts", 8.0),
        _seg("op.cdn", "/op/part-02.ts", 8.0),
        _seg("op.cdn", "/op/part-03.ts", 8.0),
        "#EXT-X-DISCONTINUITY",
    )
    cleaned2, rep2 = filter_m3u8(ok_text, "http://video.cdn/v/index.m3u8")
    assert rep2.unclosed_discontinuity is False
    assert "op.cdn" in cleaned2 and rep2.removed_count == 0


def test_unclosed_discontinuity_strict_channel_still_removes():
    """未闭合 DISCONTINUITY 时只禁宽松通道：不依赖包裹证据的严格组合
    （跨 host + 路径 + 时长异常三证据齐备）仍然生效，真广告照删。
    同 host 通道因要求包裹证据（不可信），未闭合时整块放过——宁可漏过滤。"""
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        _seg("video.cdn", "/v/seg-03.ts", 10.0),
        "#EXT-X-DISCONTINUITY",
        _seg("ad.cdn", "/ad/x01.ts", 5.0),   # 跨 host + 路径命中 + 短异常
        _seg("ad.cdn", "/ad/x02.ts", 5.0),
        # 无关闭 DISCONTINUITY
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert rep.unclosed_discontinuity is True
    assert "ad/x01.ts" not in cleaned and "ad/x02.ts" not in cleaned
    assert rep.removed_count == 2
    # 原因来自首次判定缓存（verdict 复用），为严格组合描述（非块内命中）
    assert all("odd duration" in r[2] for r in rep.removed)


def test_strict_match_reason_not_mislabeled_as_block_hit():
    """回归（2026-09-22，low）：报告重建复用首次判定缓存——严格组合
    （无 discontinuity 包裹、跨 host+路径+时长三条齐备）删除的分片，
    原因不得被误标为「cross-host segment in discontinuity block」。
    """
    text = _playlist(
        _seg("video.cdn", "/v/seg-01.ts", 10.0),
        _seg("video.cdn", "/v/seg-02.ts", 10.0),
        _seg("ad.cdn", "/ad/only.ts", 3.0),   # 零散跨 host 广告：无包裹
    )
    cleaned, rep = filter_m3u8(text, "http://video.cdn/v/index.m3u8")
    assert "ad/only.ts" not in cleaned
    assert rep.removed_count == 1
    reason = rep.removed[0][2]
    assert reason == "cross-host ad-like path with odd duration", \
        f"严格组合删除的原因被误标: {reason}"


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print('PASS %s' % name)
    print('ALL PASS')
