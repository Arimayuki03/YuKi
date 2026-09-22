# -*- coding: utf-8 -*-
"""HLS 广告段过滤（尽力而为，best-effort）。

背景：国内影视源的 m3u8 常把广告分片混进正片播放列表。典型形态是广告段
被一对 ``#EXT-X-DISCONTINUITY`` 包裹、来自不同的 CDN host、时长明显短于正片
分片、或 URL 路径命中广告特征词。

设计原则——**宁可漏过滤，不可错杀正片**：
  一切启发式都必须同时满足多条独立特征才动手；单凭「DISCONTINUITY 包裹」
  或单凭「时长短」都不足以判定广告（片头/片尾、章节、多码率切换、画质
  分段都会产生 DISCONTINUITY；片头分片本身就短）。判定为「正片主体」的
  分片（出现次数最多的 host + 占总时长主体的时长档）永不删除。

使用方式（当前未挂载，见 README/挂载建议）::

    from ad_filter import filter_m3u8
    cleaned, report = filter_m3u8(text)
    # report.removed: [(序列号, 时长, 原因), ...]  供诊断日志输出

只处理媒体播放列表（含 ``#EXTINF`` 的二级 m3u8）；主播放列表（master，
含 ``#EXT-X-STREAM-INF``）原样返回——码率档位不是广告。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# 可调参数（集中暴露便于测试与后续按源调优）
# ---------------------------------------------------------------------------

#: 单个广告分片时长上限（秒）。电视台广告普遍 15~30s；正片 HLS 分片典型
#: 2~10s，但片头/封面帧分片可能更长，因此上限放宽到 30 仍只作为特征之一。
MAX_AD_SEGMENT_SEC = 30.0

#: 一个 DISCONTINUITY 区间（block）内广告分片数量下限。正片因编码切换产生
#: 的孤立 discontinuity 块往往只有 1~2 个分片且与主体同 host；广告块通常
#: 连续多片。低于该数量的块不删（防错杀）。
MIN_AD_BLOCK_SEGMENTS = 2

#: 区间内广告分片累计时长上限（秒）。单个广告位一般 ≤90s（3×30s），
#: 超过该值更可能是正片的一段（如 OP/ED 独立压制），不删。
MAX_AD_BLOCK_SEC = 120.0

#: 广告 URL 路径关键词（小写子串匹配）。命中是强特征，但单独不足以删——
#: 一些正片 CDN 目录名恰好含 ``/ad/``（如 ``/upload/ad/`` 也可能是正常目录），
#: 必须叠加另一条独立特征。
#: 词边界用 ``(^|[^a-z0-9])`` / ``([^a-z0-9]|$)`` 而非 ``\b``：``\b`` 在
#: ``ad-01`` 处会把连字符当边界造成误报（/video/ad-01.ts 并非广告路径）。
AD_PATH_RE = re.compile(
    r"(?:^|[^a-z0-9])(?:ads?|advert(?:isement)?|guanggao|cm)(?:/|\.ts|\.mp4|$|[?#])",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------


@dataclass
class AdFilterReport:
    """过滤诊断：删了什么、为什么删、统计口径。"""

    removed: List[Tuple[int, float, str]] = field(default_factory=list)
    # 每项: (原列表中的分片序号(0-based，含被删项计数), 分片时长, 命中原因)
    total_segments: int = 0
    removed_count: int = 0
    removed_sec: float = 0.0
    # 清单以奇数个 DISCONTINUITY 结尾（开区间未闭合）：其后全部分片的
    # 「在区间内」标记不可信，本轮已禁用块内宽松判定（只允许严格组合）。
    # 告警字段：供诊断日志/上游决定是否人工核对，不影响本次过滤结果。
    unclosed_discontinuity: bool = False

    @property
    def removed_summary(self) -> str:
        """人读摘要（诊断日志用）。无删除返回空串。"""
        if not self.removed:
            return ""
        reasons = {r[2] for r in self.removed}
        return f"removed {self.removed_count}/{self.total_segments} segs " \
               f"({self.removed_sec:.1f}s) reasons={sorted(reasons)}"


# ---------------------------------------------------------------------------
# 分片解析
# ---------------------------------------------------------------------------


@dataclass
class _Segment:
    lines: List[str]           # 该分片的全部原文行（含 EXTINF 行）
    duration: float            # EXTINF 标称时长（秒）
    uri: str                   # 分片 URL（相对/绝对原样）
    line_no: int               # 起始行号（诊断用）


_EXTINF_RE = re.compile(r"#EXTINF:\s*([0-9]+(?:\.[0-9]+)?)")
_URI_RE = re.compile(r"^(?!#)(\S+)")  # 非注释非空行


def _is_uri_line(line: str) -> bool:
    s = line.strip()
    return bool(s) and not s.startswith("#")


def _extract_uri(line: str) -> str:
    m = _URI_RE.match(line.strip())
    return m.group(1) if m else ""


def _iter_segments(lines: List[str]) -> List[_Segment]:
    """把媒体播放列表拆成 _Segment 列表。

    每个 EXTINF 行开启一个分片，直到下一个非注释 URI 行收口；EXTINF 与
    URI 之间的注释标签（#EXT-X-BYTERANGE 等）归属该分片。
    """
    segs: List[_Segment] = []
    pending: Optional[List[str]] = None
    pending_dur = 0.0
    pending_line = 0
    for i, raw in enumerate(lines):
        line = raw.rstrip("\r\n")
        m = _EXTINF_RE.match(line.strip())
        if m and line.strip().startswith("#EXTINF:"):
            pending = [raw]
            pending_dur = float(m.group(1))
            pending_line = i
            continue
        if pending is not None:
            pending.append(raw)
        if _is_uri_line(line):
            if pending is None:
                # 裸 URI 行（无前置 EXTINF，如 master 内嵌分片列表的混写清单）：
                # 必须用全新状态收口——绝不能继承上一分片的 pending_dur/
                # pending_line，否则该分片的删除窗口会按错误的行号覆盖到前一个
                # 正片分片（错杀正片、留下真广告）。
                pending = [raw]
                pending_dur = 0.0
                pending_line = i
            segs.append(_Segment(pending, pending_dur,
                                 _extract_uri(line), pending_line))
            pending = None
        elif not line.strip().startswith("#") and not line.strip():
            # 空行不打断 pending（有的源 EXTINF 与 URI 之间夹空行）
            pass
    return segs


def _host_of(uri: str) -> str:
    try:
        parsed = urlparse(uri)
        return (parsed.netloc or "").lower()
    except (ValueError, AttributeError):
        return ""


# ---------------------------------------------------------------------------
# 广告判定（多条独立特征叠加，防错杀）
# ---------------------------------------------------------------------------


def _host_key(uri: str, base_host: str) -> str:
    """分片 host；相对地址继承清单自身 host（m3u8 内相对分片与清单同源）。"""
    h = _host_of(uri)
    return h or base_host

def _majority_host(segs: List[_Segment], base_host: str) -> str:
    """按分片时长计的出现最多的 host——即「正片主体」的 host。

    用时长而非条数加权：个别源把最后一帧单独切成同 host 短片，
    条数口径会把它误当主体。
    """
    tally: dict = {}
    for s in segs:
        h = _host_key(s.uri, base_host)
        tally[h] = tally.get(h, 0.0) + s.duration
    if not tally:
        return ""
    return max(tally.items(), key=lambda kv: kv[1])[0]


def _majority_duration(segs: List[_Segment]) -> float:
    """按条数统计的分片时长众数（简化为 0.5s 粒度）——正片分片典型时长档。"""
    if not segs:
        return 0.0
    tally: dict = {}
    for s in segs:
        bucket = round(s.duration * 2) / 2
        tally[bucket] = tally.get(bucket, 0) + 1
    return max(tally.items(), key=lambda kv: kv[1])[0]


def _path_hit(uri: str) -> bool:
    try:
        path = urlparse(uri).path or uri
    except (ValueError, AttributeError):
        return False
    return bool(AD_PATH_RE.search(path))


def _is_ad_like(seg: _Segment, majority_host: str, base_host: str,
                majority_dur: float, in_discontinuity_block: bool) -> Optional[str]:
    """单分片广告判定。返回命中的原因描述；不是广告返回 None。

    组合逻辑（全部要求「位置特征 + 内容特征」至少两条独立证据）：

    1. DISCONTINUITY 包裹 + (路径命中 或 时长异常显著)——discontinuity 只算
       位置证据，内容证据必须另有其一；short_odd 仅作放大器（宽松判定用）；
    2. 不在 DISCONTINUITY 内时要求更严：跨 host **且** 路径命中 **且** 时长
       异常三条齐备；
    3. 与正片主体同 host 的分片永不因 host/时长删除（同源压制，
       时长档一致），只有路径强命中 + 时长异常才可疑——仍要求
       discontinuity 包裹才删。

    跨 host 口径（防错杀对拍口径，2026-09-22 修订）：跨 host 只是来源不同
    这一条证据——独立压制的 OP/ED、多 CDN 分发、画质切换都会产生跨 host
    分片。**任何删除都必须有 path_hit（路径广告词命中）作为第二证据**：
    「cross-host AND path_hit」是唯一的宽松通道；short_odd（时长异常）只
    作为宽松通道的放大器，不再单独与跨 host 组成删除依据。即
    cross-host AND (path_hit OR 时长异常显著) 中仅 path_hit 单独成立时
    放行——宁可漏过滤，不可错杀正片。
    """
    host = _host_key(seg.uri, base_host)
    # base host 与主体 host 都未知（全相对清单且未传 base_url）时，host
    # 特征不可用——不允许把「host 为空串相等」误算成同源证据，直接视作
    # 无 host 证据，只信任 时长+路径+discontinuity 的组合。
    host_unknown = not host and not majority_host
    cross_host = bool(majority_host) and bool(host) and host != majority_host
    # 时长异常（short_odd）：单独不构成删除依据，只与路径命中叠加时放大
    # 证据强度（同 host 通道 / 严格通道要求它）。
    short_odd = (seg.duration <= MAX_AD_SEGMENT_SEC and seg.duration > 0
                 and (majority_dur <= 0 or seg.duration < majority_dur * 0.6))
    path_hit = _path_hit(seg.uri)

    # 与主体同 host：正片同源分片，host/时长特征天然一致，仅路径命中
    # 不足以删（/ad/ 等目录可能是正片正常路径）。必须有 discontinuity
    # 包裹 + 路径命中两条一起才动手，且时长必须异常。
    if not cross_host:
        if host_unknown:
            # host 不可用：discontinuity 包裹 + 路径命中 + 时长异常三条同时
            # 成立才删（比跨 host 路径多一道时长门槛，进一步防错杀）。
            if in_discontinuity_block and path_hit and short_odd:
                return "host-unknown ad-like path+duration in discontinuity"
            return None
        if in_discontinuity_block and path_hit and short_odd:
            return "same-host ad-like path+duration in discontinuity"
        return None

    # 跨 host（弱特征，单独不足以删）：路径命中是第二证据——满足即在
    # discontinuity 包裹下整块处理（块级复核还有整块命中 + 时长上限两道闸）。
    if in_discontinuity_block and path_hit:
        return "cross-host segment in discontinuity block"
    # 无 discontinuity 包裹的零散跨 host 广告：仍取最严组合
    # （路径 + 时长异常 + 跨 host 三条齐备），缺一放过。
    if path_hit and short_odd:
        return "cross-host ad-like path with odd duration"
    return None


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------


def filter_m3u8(text: str, base_url: str = "") -> Tuple[str, AdFilterReport]:
    """过滤 m3u8 文本中的疑似广告分片。

    :param text:     上游 m3u8 原文（UTF-8 文本）
    :param base_url: 清单自身 URL（用于相对分片的 host 归属；可省略，
                     省略时全相对清单的 host 特征自动失效、退化为
                     纯时长+路径+discontinuity 组合判定）
    :returns: (过滤后文本, 诊断报告)。判定不安全时原样返回（宁可漏过滤）。
    """
    report = AdFilterReport()
    if not text or not isinstance(text, str):
        return text or "", report
    lines = text.splitlines(keepends=True)

    # master 清单（多码率）不是媒体列表：分片不存在，无广告可滤。
    # 误判代价不对称——把 master 当媒体解析会整份打散，故先行排除。
    if any(ln.strip().startswith("#EXT-X-STREAM-INF") for ln in lines):
        return text, report
    # 没有 EXTINF 的文本（事件清单/空清单）同样原样返回。
    if not any(ln.strip().startswith("#EXTINF:") for ln in lines):
        return text, report

    segs = _iter_segments(lines)
    report.total_segments = len(segs)
    if len(segs) < 3:
        # 分片太少没有统计意义：无法确定「正片主体」，动了必错。
        return text, report

    base_host = _host_of(base_url or _extract_uri(_first_uri_line(lines)))
    majority_host = _majority_host(segs, base_host)
    majority_dur = _majority_duration(segs)

    # 标记每个分片是否处于 DISCONTINUITY 区间内。
    # DISCONTINUITY-SEQUENCE 仅数值递增，不指示位置，不参与。
    # 清单以奇数个 DISCONTINUITY 收尾（写坏/截断）时 disc_open 悬空为 True：
    # 其后所有分片都被误标「在块内」，块内宽松判定（跨 host + 单条内容特征）
    # 的误杀面会扩大到整个尾部。此时只允许严格组合（同 host / host 未知通道
    # 本就要求 path_hit+short_odd+包裹三条齐备，保留），并写入告警字段。
    in_block = [False] * len(segs)
    disc_unclosed = _mark_discontinuity_blocks(lines, segs, in_block)
    report.unclosed_discontinuity = disc_unclosed

    remove: set = set()
    # 逐块复核：块内命中数与累计时长达标才整块删除（单分片命中可能是
    # 编码切换的孤立块，删了就是错杀）。
    # verdict 缓存：首次判定即命中原因，供后续报告重建直接复用——
    # 避免重建时以 in_discontinuity_block=True 重判，把「严格组合」
    # （无 discontinuity 包裹）删除的分片误标成块内命中。
    verdicts: dict = {}
    block_buf: List[int] = []
    block_disc = False

    def _flush_block() -> None:
        nonlocal block_disc
        if not block_buf:
            block_disc = False
            return
        if block_disc and len(block_buf) >= MIN_AD_BLOCK_SEGMENTS:
            hits = [(i, _is_ad_like(segs[i], majority_host, base_host,
                                    majority_dur, True)) for i in block_buf]
            hit_map = {i: why for i, why in hits if why}
            hit_idxs = list(hit_map)
            block_sec = sum(segs[i].duration for i in block_buf)
            # 只删「全块命中」且块时长在广告位量级（≤120s）的块：混有
            # 「不像广告」分片的块整块放过——块内正片分片承担不起误删。
            if (hit_idxs and len(hit_idxs) >= len(block_buf)
                    and block_sec <= MAX_AD_BLOCK_SEC):
                for i in hit_idxs:
                    remove.add(i)
                    verdicts[i] = hit_map[i]
        block_buf.clear()
        block_disc = False

    for i, seg in enumerate(segs):
        if in_block[i] and not disc_unclosed:
            # 未闭合 DISCONTINUITY 时整段「块」标记不可信：不走块内宽松
            # 通道（整块复核），按零散分片只允许严格组合判定。
            block_buf.append(i)
            block_disc = True
            continue
        _flush_block()
        # 不在 discontinuity 内：仅接受最严组合（跨 host + 路径 + 时长异常）
        why = _is_ad_like(seg, majority_host, base_host, majority_dur, False)
        if why:
            verdicts[i] = why
            remove.add(i)
    _flush_block()

    # 安全阀：删除的分片总时长不得超过全片 30%。超过说明启发式大面积
    # 误判（或该清单本身就是广告合集），整份放弃过滤。
    total_sec = sum(s.duration for s in segs) or 1.0
    removed_sec = sum(segs[i].duration for i in remove)
    if removed_sec / total_sec > 0.30:
        return text, AdFilterReport(total_segments=len(segs))

    if not remove:
        return text, report

    # 重建输出：按分片原文行删除（EXTINF 行 + 尾随行直到 URI 行）。
    drop_lines: set = set()
    for i in remove:
        seg = segs[i]
        started = False
        for j, raw in enumerate(lines):
            if j < seg.line_no:
                continue
            if not started:
                started = True
            drop_lines.add(j)
            if _is_uri_line(raw):
                break
    out = "".join(raw for j, raw in enumerate(lines) if j not in drop_lines)

    for i in sorted(remove):
        # 复用首次判定缓存的原因：严格组合（无 discontinuity 包裹）删除的
        # 分片不得以 in_discontinuity_block=True 重判，否则原因会被误标成
        # 「cross-host segment in discontinuity block」这类块内命中。
        report.removed.append((i, segs[i].duration, verdicts.get(i, "strict match")))
    report.removed_count = len(remove)
    report.removed_sec = removed_sec
    return out, report


def _first_uri_line(lines: List[str]) -> str:
    for raw in lines:
        if _is_uri_line(raw):
            return raw
    return ""


def _mark_discontinuity_blocks(lines: List[str], segs: List[_Segment],
                               out_flags: List[bool]) -> bool:
    """标记每个分片是否位于一对 #EXT-X-DISCONTINUITY 之间。

    语义：DISCONTINUITY 是「区间分隔符」——第 1 次出现开启广告候选区间，
    第 2 次出现关闭。因此开关状态按出现次数**翻转**（奇数次后=在区间内，
    偶数次后=回到正片）。逐行扫描，遇 DISCONTINUITY 翻转开关；URI 行出现
    时把当前开关状态写到对应分片（分片顺序与 URI 行顺序一致）。

    返回清单结束时区间是否未闭合（奇数个 DISCONTINUITY）：写坏/截断清单
    会悬空开启区间，调用方应据此禁用块内宽松判定（见 filter_m3u8）。
    """
    disc_open = False
    seg_i = 0
    for raw in lines:
        s = raw.strip()
        if s.startswith("#EXT-X-DISCONTINUITY-SEQUENCE"):
            continue  # 仅序列号声明，不代表位置边界
        if s == "#EXT-X-DISCONTINUITY":
            disc_open = not disc_open  # 翻转：奇数次=进入区间，偶数次=离开
            continue
        if s.startswith("#EXT-X-DISCONTINUITY"):
            continue  # 其他扩展形式（罕见）不参与
        if _is_uri_line(raw):
            if seg_i < len(out_flags):
                out_flags[seg_i] = disc_open
            seg_i += 1
    return disc_open


if __name__ == "__main__":
    # 自检样例（离线）：discontinuity 包裹、跨 host、广告路径的短分片被删，
    # 同 host 的正片相对分片保留。
    demo = (
        "#EXTM3U\n#EXT-X-TARGETDURATION:10\n"
        "#EXTINF:10.0,\nhttp://video.cdn/v/seg-01.ts\n"
        "#EXTINF:10.0,\nhttp://video.cdn/v/seg-02.ts\n"
        "#EXT-X-DISCONTINUITY\n"
        "#EXTINF:5.0,\nhttp://ad.cdn/ad/01.ts\n"
        "#EXTINF:5.0,\nhttp://ad.cdn/ad/02.ts\n"
        "#EXT-X-DISCONTINUITY\n"
        "#EXTINF:10.0,\nhttp://video.cdn/v/seg-03.ts\n#EXT-X-ENDLIST\n"
    )
    cleaned, rep = filter_m3u8(demo, "http://video.cdn/v/index.m3u8")
    print(rep.removed_summary or "no ads removed")
    assert "ad/01" not in cleaned and "seg-01" in cleaned
    print("SELFTEST PASS")
