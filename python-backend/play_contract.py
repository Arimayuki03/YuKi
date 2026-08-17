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
    'flag': '',
    'jxFrom': '',
    'click': '',
    'format': '',
    'subs': [],
    'drm': None,
    'position': 0,
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
    result['url'] = _string(url).strip()

    jx = result.get('jx')
    jx_enabled = jx is True or str(jx).lower() in ('1', 'true', 'yes')
    result['jx'] = 1 if jx_enabled else _number(jx, 0)
    parse = _number(result.get('parse'), 0)
    result['parse'] = 1 if jx_enabled or parse == 1 else 0

    result['header'] = merge_headers(site_headers, result.get('header'), result.get('headers'))
    result['flag'] = _string(result.get('flag')) or _string(flag)
    for key in ('playUrl', 'jxFrom', 'click', 'format'):
        result[key] = _string(result.get(key))

    result['subs'] = _json_value(result.get('subs'))
    if result['subs'] in (None, ''):
        result['subs'] = []
    result['drm'] = _json_value(result.get('drm'))
    result['position'] = _number(result.get('position'), 0)

    if not result['url'] and not result.get('error'):
        result['error'] = 'playerContent returned an empty url'
    return result

