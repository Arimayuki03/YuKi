# -*- coding: utf-8 -*-
"""RuntimeRequest / RuntimeResponse 控制面模型。"""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
import re
import threading
import time
import uuid
from typing import Any, Mapping

from .errors import RuntimeError


DEFAULT_DEADLINES_MS = {
    'init': 30000,
    'homeContent': 15000,
    'homeVideoContent': 15000,
    'categoryContent': 20000,
    'searchContent': 20000,
    'search': 20000,
    'detailContent': 20000,
    'playerContent': 30000,
    'parse': 20000,
    'mediaProbe': 15000,
    'playerStart': 30000,
    'proxy': 30000,
}
MAX_DEADLINE_MS = 120000
_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$')
_current_request = ContextVar('yuki_runtime_request', default=None)


def normalize_request_id(value: Any = '') -> str:
    text = str(value or '').strip()
    return text if _ID_RE.fullmatch(text) else str(uuid.uuid4())


@dataclass
class RuntimeRequest:
    request_id: str
    site_key: str
    method: str
    deadline_ms: int
    args: dict[str, Any] = field(default_factory=dict)
    play_session_id: str = ''
    created_at: float = field(default_factory=time.time)
    _cancel_event: threading.Event = field(default_factory=threading.Event, repr=False, compare=False)
    _cancel_reason: str = field(default='', repr=False, compare=False)

    @classmethod
    def create(cls, *, site_key: str = '', method: str = '', deadline_ms: int | None = None,
               args: Mapping[str, Any] | None = None, request_id: str = '',
               play_session_id: str = ''):
        method = str(method or '')
        default = DEFAULT_DEADLINES_MS.get(method, 30000)
        try:
            deadline = int(deadline_ms if deadline_ms is not None else default)
        except (TypeError, ValueError):
            deadline = default
        deadline = max(1, min(deadline, MAX_DEADLINE_MS))
        return cls(
            request_id=normalize_request_id(request_id),
            site_key=str(site_key or ''),
            method=method,
            deadline_ms=deadline,
            args=dict(args or {}),
            play_session_id=normalize_request_id(play_session_id) if play_session_id else '',
        )

    @classmethod
    def from_action(cls, form: Mapping[str, Any], request_id: str = ''):
        data = {str(k): v for k, v in dict(form or {}).items()}
        method = str(data.pop('do', '') or '')
        site_key = str(data.pop('site', data.pop('siteKey', '')) or '')
        rid = request_id or data.pop('requestId', '')
        play_id = data.pop('playSessionId', '')
        deadline = data.pop('deadlineMs', None)
        return cls.create(site_key=site_key, method=method, deadline_ms=deadline,
                          args=data, request_id=rid, play_session_id=play_id)

    @property
    def cancelled(self):
        return self._cancel_event.is_set()

    @property
    def deadline_exceeded(self):
        return self.elapsed_ms >= self.deadline_ms

    @property
    def cancel_reason(self):
        return self._cancel_reason or ('timeout' if self.deadline_exceeded else 'cancelled')

    @property
    def elapsed_ms(self):
        return max(0, int((time.time() - self.created_at) * 1000))

    @property
    def remaining_ms(self):
        return max(0, self.deadline_ms - self.elapsed_ms)

    def cancel(self, reason: str = 'cancelled'):
        self._cancel_reason = str(reason or 'cancelled')
        self._cancel_event.set()

    def expire(self):
        self.cancel('timeout')

    def raise_if_cancelled(self, code: str = 'L3_RUNTIME_CANCELLED'):
        if self.deadline_exceeded or self.cancel_reason == 'timeout':
            timeout_code = {
                'init': 'L2_SITE_TIMEOUT',
                'parse': 'L4_PARSE_TIMEOUT',
                'mediaProbe': 'L5_MEDIA_TIMEOUT',
                'playerStart': 'L6_PLAYER_START_TIMEOUT',
            }.get(self.method, 'L3_RUNTIME_TIMEOUT')
            raise RuntimeError(timeout_code, request_id=self.request_id,
                               play_session_id=self.play_session_id,
                               site_key=self.site_key)
        if self.cancelled:
            raise RuntimeError(code, request_id=self.request_id,
                               play_session_id=self.play_session_id,
                               site_key=self.site_key)

    def raise_if_cancelled_or_expired(self):
        self.raise_if_cancelled()

    def to_dict(self):
        return {
            'requestId': self.request_id,
            'playSessionId': self.play_session_id,
            'siteKey': self.site_key,
            'method': self.method,
            'deadlineMs': self.deadline_ms,
            'args': dict(self.args),
        }


@dataclass
class RuntimeResponse:
    request_id: str
    ok: bool
    runtime: str = ''
    elapsed_ms: int = 0
    result: Any = None
    error: RuntimeError | None = None
    play_session_id: str = ''

    @classmethod
    def success(cls, request: RuntimeRequest, result: Any, runtime: str = ''):
        return cls(request.request_id, True, runtime, request.elapsed_ms, result, None,
                   request.play_session_id)

    @classmethod
    def failure(cls, request: RuntimeRequest, error: RuntimeError, runtime: str = ''):
        error.with_request(request)
        return cls(request.request_id, False, runtime or error.runtime,
                   request.elapsed_ms, None, error, request.play_session_id)

    def to_dict(self):
        return {
            'requestId': self.request_id,
            'playSessionId': self.play_session_id,
            'ok': bool(self.ok),
            'runtime': self.runtime,
            'elapsedMs': int(self.elapsed_ms),
            'result': self.result if self.ok else None,
            'error': self.error.to_dict() if self.error else None,
        }


def current_runtime_request() -> RuntimeRequest | None:
    return _current_request.get()


@contextmanager
def bind_runtime_request(request: RuntimeRequest):
    token = _current_request.set(request)
    try:
        yield request
    finally:
        _current_request.reset(token)
