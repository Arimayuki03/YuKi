# -*- coding: utf-8 -*-
"""网盘短期播放 URL 缓存。

播放 URL 通常是带签名的短期凭据，不能写入播放历史或普通 KV 缓存。
这里仅在进程内保存少量结果，并用账号 Cookie 的不可逆指纹隔离账号。
同一文件的并发解析由 single-flight 合并，避免 mpv/预览/重试同时触发
多次转存或签名请求。
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import threading
import time
from collections.abc import Callable, Mapping
from copy import deepcopy
from urllib.parse import parse_qs, urlsplit
from typing import Any

from .models import PlayUrl


_AUTH_HEADER_NAMES = {
    'authorization', 'cookie', 'proxy-authorization', 'x-auth-token',
    'x-api-key', 'bduss',
}
_EXPIRE_KEYS = {
    'expire', 'expires', 'expire_at', 'expires_at', 'deadline',
    'e', 'x-expires', 'x-amz-expires', 'se',
}


def _account_fingerprint(headers: Mapping[str, Any] | None) -> str:
    """返回账号凭据指纹；绝不返回或记录 Cookie 原文。"""

    values = {}
    for key, value in (headers or {}).items():
        lowered = str(key).lower()
        if lowered in _AUTH_HEADER_NAMES and value:
            values[lowered] = str(value)
    payload = json.dumps(values, ensure_ascii=False, sort_keys=True).encode('utf-8')
    return hashlib.sha256(payload).hexdigest()[:32]


def extract_expire_at(url: str, *, now: float | None = None) -> float:
    """从常见 CDN query 参数提取 Unix 过期时间。

    不认识的签名格式返回 0，由缓存使用短 TTL 兜底；毫秒时间戳会自动
    转成秒。
    """

    current = time.time() if now is None else float(now)
    try:
        query = parse_qs(urlsplit(str(url or '')).query, keep_blank_values=True)
    except ValueError:
        return 0.0
    for key, values in query.items():
        if str(key).lower() not in _EXPIRE_KEYS or not values:
            continue
        try:
            value = float(str(values[-1]).strip())
        except (TypeError, ValueError):
            continue
        if value > 10_000_000_000:
            value /= 1000.0
        # 过小的 e 参数可能是相对秒数，而不是 Unix 时间戳。
        if value < 10_000_000:
            value = current + value
        if value > current:
            return value
    return 0.0


def make_cache_key(
    provider: str,
    params: Mapping[str, Any] | None,
    headers: Mapping[str, Any] | None,
) -> str:
    """生成不含明文凭据的稳定缓存键。"""

    p = params or {}
    stable = {
        'shareId': p.get('shareId') or p.get('share_id') or '',
        'fileId': p.get('fileId') or p.get('file_id') or p.get('fid') or '',
        'fileToken': p.get('fileToken') or p.get('file_token') or '',
        'url': p.get('url') or '',
        'quality': p.get('quality') or p.get('resolution') or '',
    }
    payload = json.dumps(stable, ensure_ascii=False, sort_keys=True, default=str)
    return '%s|%s|%s' % (
        str(provider or '').strip().lower(),
        _account_fingerprint(headers),
        hashlib.sha256(payload.encode('utf-8')).hexdigest()[:32],
    )


@dataclass
class _Flight:
    event: threading.Event
    result: PlayUrl | None = None
    error: BaseException | None = None


class SignedUrlCache:
    """进程内的短期 URL 缓存和 single-flight 协调器。"""

    def __init__(self, *, refresh_skew: int = 60, fallback_ttl: int = 120,
                 max_entries: int = 512):
        self.refresh_skew = max(0, int(refresh_skew))
        self.fallback_ttl = max(1, int(fallback_ttl))
        self.max_entries = max(1, int(max_entries))
        self._values: dict[str, tuple[PlayUrl, float]] = {}
        self._flights: dict[str, _Flight] = {}
        self._lock = threading.RLock()

    def _copy(self, play: PlayUrl) -> PlayUrl:
        # Provider 结果可能被调用方修改 headers；缓存必须隔离返回对象。
        return deepcopy(play)

    def _with_expiry(self, play: PlayUrl, now: float) -> PlayUrl:
        result = self._copy(play)
        if not result.expire_at:
            result.expire_at = extract_expire_at(result.url, now=now)
        if not result.expire_at:
            result.expire_at = now + self.fallback_ttl
        return result

    def _valid(self, play: PlayUrl, now: float) -> bool:
        return bool(play.url) and float(play.expire_at or 0) > now + self.refresh_skew

    def get(self, key: str, *, now: float | None = None) -> PlayUrl | None:
        current = time.time() if now is None else float(now)
        with self._lock:
            entry = self._values.get(key)
            if entry is None:
                return None
            play, stored = entry
            if not self._valid(play, current):
                self._values.pop(key, None)
                return None
            # ``stored`` is intentionally read so the tuple remains easy to
            # inspect while debugging; freshness is controlled by expire_at.
            _ = stored
            return self._copy(play)

    def put(self, key: str, play: PlayUrl, *, now: float | None = None) -> PlayUrl:
        current = time.time() if now is None else float(now)
        value = self._with_expiry(play, current)
        with self._lock:
            if len(self._values) >= self.max_entries and key not in self._values:
                oldest = min(self._values.items(), key=lambda item: item[1][1])[0]
                self._values.pop(oldest, None)
            self._values[key] = (value, current)
        return self._copy(value)

    def invalidate(self, key: str) -> None:
        with self._lock:
            self._values.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._values.clear()

    def resolve(
        self,
        key: str,
        resolver: Callable[[], PlayUrl | None],
        *,
        refresh: bool = False,
    ) -> PlayUrl | None:
        """读取或解析一个 URL；同 key 只允许一个 resolver 在途。"""

        with self._lock:
            flight = self._flights.get(key)
            if flight is None and not refresh:
                cached = self.get(key)
                if cached is not None:
                    return cached
            leader = flight is None
            if leader:
                flight = _Flight(threading.Event())
                self._flights[key] = flight
        assert flight is not None
        if not leader:
            flight.event.wait()
            if flight.error is not None:
                raise flight.error
            return self._copy(flight.result) if flight.result is not None else None

        try:
            # A refresh must evict the old value before resolving. This also
            # prevents a waiter arriving after the refresh from receiving it.
            self.invalidate(key)
            resolved = resolver()
            flight.result = self.put(key, resolved) if resolved and resolved.url else None
            return self._copy(flight.result) if flight.result is not None else None
        except BaseException as exc:
            flight.error = exc
            raise
        finally:
            with self._lock:
                self._flights.pop(key, None)
                flight.event.set()

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {'entries': len(self._values), 'inflight': len(self._flights)}


signed_url_cache = SignedUrlCache()


def clear_signed_url_cache() -> None:
    signed_url_cache.clear()
