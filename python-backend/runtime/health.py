# -*- coding: utf-8 -*-
"""站点能力、装配阶段和运行健康状态。"""
from dataclasses import dataclass, field
import os
import time
from typing import Iterable

from .errors import RuntimeError, error_from_exception


def android_worker_enabled() -> bool:
    """Return true only after an Android Worker has reported readiness.

    G0 does not start an Android Worker.  The old implementation treated a
    user-set ``VPC_ANDROID_WORKER_ENABLED`` flag as proof that one existed,
    which could let an Android/Dex JAR enter the ordinary JVM path and become
    healthy.  A future Worker must set both flags during its health handshake;
    merely opting in is never sufficient.
    """
    enabled = str(os.environ.get('VPC_ANDROID_WORKER_ENABLED', '')).lower() in ('1', 'true', 'yes')
    ready = str(os.environ.get('VPC_ANDROID_WORKER_READY', '')).lower() in ('1', 'true', 'yes')
    return enabled and ready


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
        elif err.code.endswith('_CANCELLED'):
            self.state = 'cancelled'
        elif err.code == 'L3_RUNTIME_CREDENTIALS_REQUIRED':
            self.state = 'credentials_required'
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
        if self.state in ('circuit-open', 'credentials_required'):
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
        }


def infer_site_health(item: dict, capabilities: Iterable[str] | None = None) -> SiteHealth:
    """只按配置字段推断候选运行时；JAR Android 信号由下载后的扫描覆盖。"""
    key = str((item or {}).get('key') or '?')
    api = str((item or {}).get('api') or '')
    try:
        stype = int((item or {}).get('type', 0))
    except (TypeError, ValueError):
        stype = -1
    lower = api.lower()
    if stype in (0, 1):
        runtime, compatibility = 'cms', 'C1'
    elif 'drpy' in lower:
        runtime, compatibility = 'drpy', 'C1'
    elif stype == 4 or lower.endswith('.js'):
        runtime, compatibility = 'js', 'C1'
    elif stype == 3 and (api.startswith('csp_') or lower.split('?')[0].endswith('.jar')):
        runtime, compatibility = 'jar', 'C1'
    elif stype == 3:
        runtime, compatibility = 'python', 'C1'
    else:
        runtime, compatibility = 'unsupported', 'C0'
    caps = list(capabilities or ('home', 'search', 'detail', 'player', 'proxy'))
    if not bool((item or {}).get('searchable', 1)) and 'search' in caps:
        caps.remove('search')
    return SiteHealth(key, runtime=runtime, compatibility=compatibility, capabilities=caps)
