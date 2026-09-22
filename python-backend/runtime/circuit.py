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

    「排队超时」也不计失败（见 record_failure）：请求根本没被 Worker 执行，
    它反映的是自身队列拥挤/预算耗尽，而不是站点真的坏了——尤其慢源在半开
    探测阶段前后台排队超时，会把刚放行的探测直接打回 open，站点被越冻越死。
    """

    def __init__(self, failure_threshold=3, open_seconds=60.0, half_open_backoff_seconds=None):
        self.failure_threshold = max(1, int(failure_threshold))
        self.open_seconds = max(0.01, float(open_seconds))
        # 半开探测失败的退避窗口：默认 open_seconds / 12（60s → 5s），并硬性不超过
        # open_seconds 本身。必须显著小于 open_seconds，否则一次抖动探测就把站点冻满
        # 一个完整开放周期，慢源在用户浏览期间实际不可用。
        backoff = (float(open_seconds) / 12.0 if half_open_backoff_seconds is None
                   else float(half_open_backoff_seconds))
        self.half_open_backoff_seconds = min(max(0.01, backoff), self.open_seconds)
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
                    # 半开探测被取消（典型：用户切分类/切源中止在途请求）：探测
                    # 结果未知，回到 open，但**不重新计满开放时间**——保持原
                    # _open_until（进入半开时已过期），下一个 before_call 会立即
                    # 放行新的单个探测。此前这里重置为满 open_seconds，快速连续
                    # 切换分类会把熔断无限延长（每次中止 +60s），站点在用户浏览
                    # 期间始终不可用。
                    self._state = 'open'
                return
            if not error.retryable:
                self._permanent_error = error
                self._state = 'blocked'
                self._half_open_in_flight = False
                self._open_until = 0.0
                return
            if error.code in ('L3_RUNTIME_TIMEOUT', 'L2_SITE_TIMEOUT') and getattr(
                    error, 'details', None).get('queued'):
                # 排队超时（supervisor 打了 queued 标记）：请求在 Supervisor 队列/
                # 调用锁上等超了预算，从未被准入执行。不计失败也不结束半开探测位
                # ——探测名额归还，让下一个请求继续探测；否则慢源「排队等超」会把
                # half-open 直接打回 open，站点在无任何真实失败的情况下持续熔断。
                # 注意只认显式标记：Worker 侧真实执行超时（无 queued 标记）照常计数。
                if self._state == 'half-open':
                    self._half_open_in_flight = False
                return
            stage = str(error.stage or 'runtime')
            if stage == self._failure_stage:
                self._consecutive_failures += 1
            else:
                self._failure_stage = stage
                self._consecutive_failures = 1
            if self._state == 'half-open':
                # 半开探测失败：回到 open，但**不重开满 open_seconds**。
                # 原实现与上面 61-70 行的取消分支自相矛盾——那里刻意「保持原
                # _open_until」并写明「每次中止 +60s 会把熔断无限延长，站点在用户
                # 浏览期间始终不可用」；而这里一次探测失败就再冻 60s。慢源（偶发超时）
                # 的实际后果：3 次失败 → 冻 60s → 放行 1 个探测 → 探测又超时 → 再冻
                # 60s，用户在整段浏览期几乎打不开该源。
                # 用一段远小于 open_seconds 的探测退避，既不无限冻结也不至于高频轰炸。
                self._state = 'open'
                self._open_until = time.monotonic() + self.half_open_backoff_seconds
            elif self._consecutive_failures >= self.failure_threshold:
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

