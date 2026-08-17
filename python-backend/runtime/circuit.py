# -*- coding: utf-8 -*-
"""线程安全的站点运行时熔断器。"""
from __future__ import annotations

import threading
import time

from .errors import RuntimeError


class CircuitBreaker:
    """连续同阶段失败熔断，并以单个半开探测恢复。

    取消不计失败；不可重试错误保持阻断，直到配置/Cookie 更新或用户显式
    触发探测。这样不会把凭据缺失当成网络抖动反复重启 Worker。
    """

    def __init__(self, failure_threshold=3, open_seconds=60.0):
        self.failure_threshold = max(1, int(failure_threshold))
        self.open_seconds = max(0.01, float(open_seconds))
        self._lock = threading.RLock()
        self._state = 'closed'
        self._failure_stage = ''
        self._consecutive_failures = 0
        self._open_until = 0.0
        self._half_open_in_flight = False
        self._permanent_error = None
        self._forced_probe = False

    def before_call(self):
        with self._lock:
            now = time.monotonic()
            if self._permanent_error is not None and not self._forced_probe:
                raise self._permanent_error
            if self._state == 'open' and now < self._open_until and not self._forced_probe:
                raise RuntimeError(
                    'L3_RUNTIME_CIRCUIT_OPEN',
                    details={'retryAfterMs': max(1, int((self._open_until - now) * 1000))},
                )
            if self._state == 'open' or self._permanent_error is not None:
                if self._half_open_in_flight:
                    raise RuntimeError('L3_RUNTIME_CIRCUIT_OPEN', details={'halfOpen': True})
                self._state = 'half-open'
                self._half_open_in_flight = True
                self._forced_probe = False

    def record_success(self):
        with self._lock:
            self._state = 'closed'
            self._failure_stage = ''
            self._consecutive_failures = 0
            self._open_until = 0.0
            self._half_open_in_flight = False
            self._permanent_error = None
            self._forced_probe = False

    def record_failure(self, error):
        if not isinstance(error, RuntimeError):
            return
        with self._lock:
            if error.code.endswith('_CANCELLED'):
                self._half_open_in_flight = False
                if self._state == 'half-open':
                    self._state = 'open'
                    self._open_until = max(self._open_until, time.monotonic() + self.open_seconds)
                return
            if not error.retryable:
                self._permanent_error = error
                self._state = 'blocked'
                self._half_open_in_flight = False
                self._open_until = 0.0
                return
            stage = str(error.stage or 'runtime')
            if stage == self._failure_stage:
                self._consecutive_failures += 1
            else:
                self._failure_stage = stage
                self._consecutive_failures = 1
            if self._state == 'half-open' or self._consecutive_failures >= self.failure_threshold:
                self._state = 'open'
                self._open_until = time.monotonic() + self.open_seconds
            self._half_open_in_flight = False

    def force_half_open(self):
        with self._lock:
            if self._state != 'closed' or self._permanent_error is not None:
                self._forced_probe = True
                self._half_open_in_flight = False

    def snapshot(self):
        with self._lock:
            now = time.monotonic()
            state = self._state
            if state == 'open' and now >= self._open_until and not self._half_open_in_flight:
                state = 'half-open'
            return {
                'state': state,
                'consecutiveFailures': self._consecutive_failures,
                'failureStage': self._failure_stage,
                'circuitOpenForMs': max(0, int((self._open_until - now) * 1000)),
                'halfOpenInFlight': self._half_open_in_flight,
                'permanent': self._permanent_error is not None,
            }

