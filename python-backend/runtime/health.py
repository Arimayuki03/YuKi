# -*- coding: utf-8 -*-
"""站点能力、装配阶段和运行健康状态。"""
from dataclasses import dataclass, field
import os
import time
from typing import Iterable

from .android_policy import android_worker_available
from .errors import RuntimeError, error_from_exception


def android_worker_enabled() -> bool:
    """Return true only when policy and both readiness inputs permit it.

    A4.1 ended in No-Go, so the current product policy keeps this false even if
    both environment variables are set.  This prevents environment flags from
    silently widening the formal C1 support ceiling.
    """
    enabled = str(os.environ.get('YUKI_ANDROID_WORKER_ENABLED', '')).lower() in ('1', 'true', 'yes')
    ready = str(os.environ.get('YUKI_ANDROID_WORKER_READY', '')).lower() in ('1', 'true', 'yes')
    return android_worker_available(enabled=enabled, ready=ready)


@dataclass
class SiteHealth:
    site_key: str
    runtime: str = 'unknown'
    compatibility: str = 'C0'
    state: str = 'configured'
    capabilities: list[str] = field(default_factory=list)
    configured: bool = True
    built: bool = False
    initialized: bool = False
    healthy: bool = False
    last_success_at: float = 0
    last_error: RuntimeError | None = None
    consecutive_failures: int = 0
    circuit_open_until: float = 0
    failure_stage: str = ''
    half_open: bool = False
    # C2.4：能力路由结论（RouteDecision）。诊断页要能回答「为什么判成这个运行时」，
    # 而不是只看到一个 runtime 字符串。
    route: object = None

    def __post_init__(self):
        self.capabilities = sorted(set(str(v) for v in self.capabilities if v))

    def mark_built(self):
        self.built = True
        self.state = 'built'
        return self

    def mark_initialized(self):
        self.built = True
        self.initialized = True
        self.state = 'initialized'
        return self

    def mark_healthy(self):
        if self.runtime == 'android' and not android_worker_enabled():
            return self.record_failure(RuntimeError(
                'L2_SITE_REQUIRES_ANDROID', site_key=self.site_key, runtime='android'))
        self.built = True
        self.initialized = True
        self.healthy = True
        self.state = 'healthy'
        self.last_success_at = time.time()
        self.last_error = None
        self.consecutive_failures = 0
        self.failure_stage = ''
        self.circuit_open_until = 0
        self.half_open = False
        return self

    def record_success(self, _capability: str = ''):
        # A successful callback is not proof that a capability can run on the
        # current host.  In particular, a Dex/native/Android JAR must never
        # become healthy merely because a probe returned a value while the
        # Android Worker handshake is absent.  Keep this guard here as well as
        # in mark_healthy so late callbacks cannot resurrect a failed site.
        if self.runtime == 'android' and not android_worker_enabled():
            return self.record_failure(RuntimeError(
                'L2_SITE_REQUIRES_ANDROID', site_key=self.site_key, runtime='android'))
        if self.initialized:
            self.healthy = True
            self.state = 'healthy'
        self.last_success_at = time.time()
        self.last_error = None
        self.consecutive_failures = 0
        self.failure_stage = ''
        self.circuit_open_until = 0
        self.half_open = False
        return self

    def record_failure(self, error, *, stage: str = 'runtime'):
        err = error if isinstance(error, RuntimeError) else error_from_exception(
            error if isinstance(error, Exception) else Exception(str(error)),
            stage=stage, site_key=self.site_key, runtime=self.runtime)
        err.site_key = err.site_key or self.site_key
        err.runtime = err.runtime or self.runtime
        self.last_error = err
        self.healthy = False
        if err.code.endswith('_CANCELLED'):
            pass
        elif err.code == 'L3_RUNTIME_CIRCUIT_OPEN':
            retry_ms = int((err.details or {}).get('retryAfterMs') or 0)
            self.circuit_open_until = max(
                self.circuit_open_until, time.time() + retry_ms / 1000.0)
        elif err.retryable:
            if self.failure_stage == err.stage:
                self.consecutive_failures += 1
            else:
                self.failure_stage = err.stage
                self.consecutive_failures = 1
            if self.consecutive_failures >= 3:
                self.circuit_open_until = time.time() + 60
        else:
            self.consecutive_failures = 0
        if err.code == 'L2_SITE_REQUIRES_ANDROID':
            self.runtime = 'android'
            self.compatibility = 'C2'
            self.state = 'requires_android'
        elif self.runtime == 'unsupported' or err.code == 'L2_SITE_UNSUPPORTED':
            self.state = 'unsupported'
        elif err.code.endswith('_CANCELLED'):
            self.state = 'cancelled'
        elif err.code == 'L3_RUNTIME_CREDENTIALS_REQUIRED':
            self.state = 'degraded'
        elif err.code == 'L3_RUNTIME_CIRCUIT_OPEN' or self.circuit_open_until > time.time():
            self.state = 'circuit-open'
        elif err.code.endswith('_TIMEOUT'):
            self.state = 'timeout'
        else:
            self.state = 'unavailable'
        return self

    def apply_runtime_state(self, state):
        data = dict(state or {})
        self.consecutive_failures = int(data.get('consecutiveFailures') or 0)
        self.failure_stage = str(data.get('failureStage') or '')
        remaining = int(data.get('circuitOpenForMs') or 0)
        self.circuit_open_until = time.time() + remaining / 1000.0 if remaining else 0
        self.half_open = str(data.get('state') or '') == 'half-open'
        if str(data.get('state') or '') == 'open':
            self.healthy = False
            self.state = 'circuit-open'
        return self

    def force_half_open(self):
        self.circuit_open_until = 0
        self.half_open = True
        if self.state in ('circuit-open', 'degraded', 'credentials_required'):
            self.state = 'half-open'
        return self

    def to_dict(self):
        return {
            'siteKey': self.site_key,
            'runtime': self.runtime,
            'compatibility': self.compatibility,
            'state': self.state,
            'capabilities': list(self.capabilities),
            'configured': bool(self.configured),
            'built': bool(self.built),
            'initialized': bool(self.initialized),
            'healthy': bool(self.healthy),
            'lastSuccessAt': int(self.last_success_at * 1000) if self.last_success_at else 0,
            'lastError': self.last_error.to_dict() if self.last_error else None,
            'consecutiveFailures': int(self.consecutive_failures),
            'circuitOpenUntil': int(self.circuit_open_until * 1000) if self.circuit_open_until else 0,
            'failureStage': self.failure_stage,
            'halfOpen': bool(self.half_open),
            'route': self.route.to_dict() if self.route is not None else None,
        }


def infer_site_health(item: dict, capabilities: Iterable[str] | None = None) -> SiteHealth:
    """只按配置字段推断候选运行时；JAR Android 信号由下载后的扫描覆盖。

    判定本身委托给 C2.4 的 :func:`capability_router.route_site`——此前这里有一份
    独立的 if/elif 链，与 `config.py::_build_site` 的分支规则不完全一致（例如 drpy
    在这里是 C1、在装配路径上却直接跳过），诊断页与实际装配结果因此会互相矛盾。
    现在两边共用同一个纯函数，`route` 字段同时带上判定依据。

    延迟导入：`capability_router` 在模块层从本模块取 `android_worker_enabled`，
    顶层互相导入会形成环。
    """
    from .capability_router import capabilities_for, route_site
    from .config_snapshot import site_flag

    key = str((item or {}).get('key') or '?')
    decision = route_site(item, site_key=key)
    if capabilities is None:
        caps = capabilities_for(item, decision)
    else:
        caps = list(capabilities)
        # 与字段矩阵共用同一份开关语义（`searchable=2` 在 FongMi 里不可搜）。
        if not site_flag((item or {}).get('searchable'), 1) and 'search' in caps:
            caps.remove('search')
    initial_state = 'unsupported' if decision.runtime in ('android', 'unsupported') else 'configured'
    return SiteHealth(key, runtime=decision.runtime, compatibility=decision.compatibility,
                      capabilities=caps, state=initial_state, route=decision)
