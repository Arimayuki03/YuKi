# -*- coding: utf-8 -*-
"""FongMi ``playerContent`` result normalization.

The Android Result model accepts a surprisingly broad set of JSON shapes.  The
desktop player should receive one stable object while retaining extension
fields emitted by a site/JAR for diagnostics and future playback features.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any


DEFAULT_FIELDS = {
    'url': '',
    'parse': 0,
    'jx': 0,
    'playUrl': '',
    'header': {},
    'headers': {},
    'flag': '',
    'jxFrom': '',
    'click': '',
    'format': '',
    'subs': [],
    'drm': None,
    'position': 0,
    'msg': '',
    'code': 0,
    'proxy': None,
    'error': '',
}


def _json_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text or text[0] not in '[{':
        return value
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return value


def _header_map(value: Any) -> dict[str, str]:
    value = _json_value(value)
    if isinstance(value, Mapping):
        return {str(k): str(v) for k, v in value.items() if k is not None and v is not None}
    if isinstance(value, (list, tuple)):
        out: dict[str, str] = {}
        for item in value:
            if isinstance(item, Mapping):
                out.update(_header_map(item))
            elif isinstance(item, str) and ':' in item:
                key, val = item.split(':', 1)
                if key.strip():
                    out[key.strip()] = val.strip()
        return out
    if isinstance(value, str) and '\n' in value:
        out = {}
        for line in value.splitlines():
            if ':' in line:
                key, val = line.split(':', 1)
                if key.strip():
                    out[key.strip()] = val.strip()
        return out
    return {}


def merge_headers(*sources: Any) -> dict[str, str]:
    """按站点 → Spider → alias 的顺序合并 header，大小写不重复。"""
    result: dict[str, str] = {}
    positions: dict[str, str] = {}
    for source in sources:
        for key, value in _header_map(source).items():
            canonical = key.lower()
            old = positions.get(canonical)
            if old is not None:
                result.pop(old, None)
            positions[canonical] = key
            result[key] = value
    return result


def _string(value: Any) -> str:
    return '' if value is None else str(value)


def _looks_like_http_url(value: Any) -> bool:
    """宽松判定值是否形如 http(s) 绝对地址（scheme 快速校验，不做网络请求）。"""
    text = str(value or '').strip()
    return text.lower().startswith(('http://', 'https://'))


def _unwrap_duplicated_url(url: str) -> str:
    """容错「``<真实地址>.<同一真实地址>``」形态的播放直链（bug：mpv 报
    ``HTTP error 400 Bad Request``，日志显示请求打开
    ``https://…/index.m3u8.https://…/index.m3u8``）。

    某些 CatVod 源（如极速 jisuzyv 系）playerContent 返回的 ``url`` 可能被
    源码/模板以「分集序号.地址」或重复拼接的形式写出，整条 URL 语法仍以
    http(s) 开头，但 mpv/ffmpeg 会把第一个 ``.`` 之后的 ``https://…`` 当作
    同一 host 的路径继续请求，上游随即回 400 Bad Request，播放从未开始。
    而 YuKi 的渲染层/主进程链路（player.js → index.js → mpv-player.js）对
    url 全程只做 trim 与透传，没有任何 ``+ '.'`` 拼接点（已逐文件核查），
    所以防线必须设在后端唯一收口处：``normalize_play_result``。

    识别规则（必须足够保守，绝不误伤正常地址）：
    - 整串以 http(s) 开头；
    - 串内恰有一个 ``.`` 同时满足其两侧各自都是合法 http(s) 绝对地址
      （即形如 ``https://a/x.m3u8.https://a/x.m3u8``）；
    - 两侧去协议后完全一致（重复拼接的自证特征）。
    命中即取后半（与 jisuzyv 观测样本一致，后半是源站真实给出的可播地址）；
    其余形态（含 query/fragment 的正常地址、普通文件名 ``v1.2.m3u8``、
    urljoin 产物等）一律原样返回。parse=1 的网页地址不匹配此双 URL 形态，
    天然不受影响。
    """
    text = str(url or '').strip()
    if not text.lower().startswith(('http://', 'https://')):
        return text
    # 找「.https://」/「.http://」边界：只有边界两侧都是合法 http(s) 地址、
    # 且去掉协议后完全相同时才认定是重复拼接。
    lower = text.lower()
    for marker in ('.https://', '.http://'):
        pos = lower.find(marker)
        while pos != -1:
            head, tail = text[:pos], text[pos + 1:]
            if _looks_like_http_url(tail):
                # 双写自证：去协议前缀后两侧一致（允许其中一侧缺尾斜杠差异）
                head_body = head.split('://', 1)[-1].rstrip('/')
                tail_body = tail.split('://', 1)[-1].rstrip('/')
                if head_body and head_body == tail_body:
                    return tail
            pos = lower.find(marker, pos + 1)
    return text


def _number(value: Any, default: int | float = 0) -> int | float:
    if value in (None, ''):
        return default
    try:
        number = float(value)
        return int(number) if number.is_integer() else number
    except (TypeError, ValueError):
        return default


def normalize_play_result(
    raw: Any,
    *,
    site_headers: Any = None,
    site_play_url: str = '',
    flag: str = '',
    original_id: str = '',
) -> dict[str, Any]:
    """Return a stable, JSON-serializable FongMi playback result.

    ``url`` is deliberately not filled from ``original_id``.  A missing URL is
    an actionable Spider error, and silently replaying the episode page makes
    parse failures look like a player failure.
    """
    value = raw
    if isinstance(value, (bytes, bytearray, memoryview)):
        try:
            value = bytes(value).decode('utf-8')
        except UnicodeDecodeError:
            value = ''
    if isinstance(value, str):
        parsed = _json_value(value)
        if parsed is value and value.strip():
            # A few Python/CMS adapters return a bare direct URL instead of the
            # standard JSON object.  Treat that as a valid minimal result.
            value = {'url': value.strip()} if value.strip().lower().startswith(('http://', 'https://')) else {'error': value.strip()}
        else:
            value = parsed
    if not isinstance(value, Mapping):
        value = {'error': 'playerContent returned an unsupported result'}

    # Copy first so extension keys survive normalization.
    result: dict[str, Any] = dict(value)
    for key, default in DEFAULT_FIELDS.items():
        if key not in result:
            result[key] = default.copy() if isinstance(default, (dict, list)) else default

    url = result.get('url')
    if isinstance(url, Mapping):
        url = url.get('url', url.get('v', url.get('value', '')))
    elif isinstance(url, (list, tuple)):
        url = url[0] if url else ''
    # 防御性规范化：拆掉「真实地址.真实地址」双写形态（jisuzyv 等源观测样本），
    # 正常直链/网页地址原样通过（见 _unwrap_duplicated_url 注释）。
    result['url'] = _unwrap_duplicated_url(_string(url).strip())

    jx = result.get('jx')
    jx_enabled = jx is True or str(jx).lower() in ('1', 'true', 'yes')
    result['jx'] = 1 if jx_enabled else _number(jx, 0)
    # ``jx=1`` is FongMi's compatibility spelling for "needs parsing".  Keep
    # the independent jx field, promote a false/absent parse to 1, and retain
    # any explicit non-zero numeric parse extension supplied by the Spider.
    parsed_mode = _number(result.get('parse'), 0)
    result['parse'] = 1 if jx_enabled and not parsed_mode else parsed_mode

    spider_header = result.get('header')
    spider_headers = result.get('headers')
    result['headers'] = _header_map(spider_headers)
    result['header'] = merge_headers(site_headers, spider_header, spider_headers)
    result['flag'] = _string(result.get('flag')) or _string(flag)
    for key in ('playUrl', 'jxFrom', 'click', 'format', 'msg'):
        result[key] = _string(result.get(key))
    if not result['playUrl']:
        result['playUrl'] = _string(site_play_url).strip()

    result['subs'] = _json_value(result.get('subs'))
    if result['subs'] in (None, ''):
        result['subs'] = []
    result['drm'] = _json_value(result.get('drm'))
    result['position'] = _number(result.get('position'), 0)
    result['code'] = _number(result.get('code'), 0)
    result['proxy'] = _json_value(result.get('proxy'))
    if 'skipProbe' in result:
        result['skipProbe'] = result['skipProbe'] is True or str(result['skipProbe']).lower() in ('1', 'true', 'yes')

    if not result['url'] and not result.get('error'):
        result['error'] = 'playerContent returned an empty url'
    return result
