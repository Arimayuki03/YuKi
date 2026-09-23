# -*- coding: utf-8 -*-
"""runtime 子包内部白盒测试：补既有测试未覆盖的分支。

与既有文件互补（不重复覆盖）：
- ``test_circuit.py``   已测：达阈值阻断、成功重置、半开取消/失败的窗口、退避钳制。
- ``test_health_concurrency.py`` 已测：并发快照自洽、apply_runtime_state 回填。
- ``test_site_health.py`` 已测：生命周期四态、timeout/cancelled/requires_android。
- ``test_runtime_contract.py`` 已测：请求-响应往返、异常映射、脱敏、HTTP 端点。

本文件补的是**内部私有分支**：熔断器的 stage 计数切换、排队超时豁免、force_half_open
与 snapshot 的纯读性；SiteHealth 的状态判定矩阵与降级阈值边界；errors 的序列化与
因果链；contracts 的截止钳制与 from_action 字段剥离；以及 config_cache / ext_resolver /
android_policy / worker_base / process_transport 的冷门分支。

时间推进一律用 mock（改内部时间戳或 patch ``time.monotonic``/``time.time``），
禁止 sleep；子进程/线程一律 mock，禁止真实出网。
"""
import io
import json
import os
import sys
import threading
import time
from unittest import mock

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

from runtime import circuit as circuit_mod                      # noqa: E402
from runtime import process_transport as transport_mod          # noqa: E402
from runtime import worker_base as worker_base_mod              # noqa: E402
from runtime.android_policy import (                            # noqa: E402
    ANDROID_ONLY_MESSAGE, ANDROID_WORKER_DECISION,
    ANDROID_WORKER_SHIPPED, SUPPORT_CEILING,
    android_only_details, android_worker_available)
from runtime.circuit import CircuitBreaker                      # noqa: E402
from runtime.config_cache import (                              # noqa: E402
    CACHE_VERSION, MAX_CACHE_FILE_BYTES, MAX_CONFIG_BYTES,
    MAX_DOCUMENTS_BYTES, CachedConfig, ConfigRepositoryCache)
from runtime.contracts import (                                 # noqa: E402
    DEFAULT_DEADLINES_MS, MAX_DEADLINE_MS, RuntimeRequest,
    RuntimeResponse, bind_runtime_request, current_runtime_request,
    normalize_request_id)
from runtime.errors import (                                    # noqa: E402
    ERROR_SPECS, RuntimeError, error_from_exception, redact_sensitive)
from runtime.ext_resolver import (                              # noqa: E402
    EXT_TIMEOUT, ExtCache, ExtCancelled, ExtResolver, ExtTimeout,
    ResolvedExt, canonical_ext, detect_text, is_http_ext)
from runtime.health import (                                    # noqa: E402
    SiteHealth, android_worker_enabled, infer_site_health)
from runtime.process_transport import (                         # noqa: E402
    MAX_FRAME_BYTES, WindowsJob, apply_worker_limits,
    encode_value, decode_value, enter_worker_process_group,
    recv_json, send_json, terminate_process_tree)


# ---------------------------------------------------------------- 通用夹具


class _Response:
    """ext 取回用的最小响应替身：status_code / headers / iter_content / close。"""

    def __init__(self, status=200, headers=None, url='', body=b''):
        self.status_code = status
        self.headers = dict(headers or {})
        self.url = url
        self._body = body
        self.closed = False

    def iter_content(self, _size):
        yield self._body

    def close(self):
        self.closed = True


def send_json_frame(payload):
    """把一个 JSON 帧编码成字节（供 _FakeConnection.push 模拟对端写入）。"""
    return json.dumps(encode_value(payload), ensure_ascii=False,
                      separators=(',', ':')).encode('utf-8')


class _FakeConnection:
    """替代 multiprocessing.Connection：读队列与写日志分离 + 断连模拟。

    读写分离是刻意的：Worker 入口（worker_base.worker_main）是「发一帧、收一帧」
    的半双工对话，若写入回灌读队列，它会读到自己发的 booted 帧。
    """

    def __init__(self, frames=None):
        self.queue = list(frames or [])
        self.sent = []
        self.closed = False

    def push(self, payload):
        """模拟对端发来一帧（dict 直接编码，bytes 原样入队）。"""
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode('utf-8')
        self.queue.append(raw)
        return self

    def send_bytes(self, raw):
        if self.closed:
            raise BrokenPipeError('connection closed')
        self.sent.append(raw)

    def recv_bytes(self, _limit=0):
        if self.closed:
            raise BrokenPipeError('peer closed')
        if not self.queue:
            raise EOFError('peer closed')
        return self.queue.pop(0)

    def close(self):
        self.closed = True

    def frames(self):
        """按发送顺序还原成 JSON 帧列表。"""
        return [json.loads(raw.decode('utf-8')) for raw in self.sent]


def _fail(code='L3_RUNTIME_CALL_FAILED', stage='runtime', **kw):
    return RuntimeError(code, stage=stage, **kw)


def _to_half_open(failure_threshold=1, open_seconds=60.0):
    """把熔断器推到「半开探测在途」，不真实等待（直接改内部时间戳）。"""
    breaker = CircuitBreaker(failure_threshold=failure_threshold, open_seconds=open_seconds)
    for _ in range(failure_threshold):
        breaker.record_failure(_fail())
    breaker._open_until = circuit_mod.time.monotonic() - 1
    breaker.before_call()
    return breaker


def _in_half_open_without_history(open_seconds=60.0):
    """直接进入「半开探测在途」且失败计数为 0（纯白盒构造，用于豁免分支）。

    不经过 record_failure，避免前置失败污染 consecutiveFailures 基线。
    """
    breaker = CircuitBreaker(failure_threshold=1, open_seconds=open_seconds)
    breaker._state = 'half-open'
    breaker._half_open_in_flight = True
    breaker._open_until = circuit_mod.time.monotonic() - 1
    return breaker


# ================================================================ circuit


def test_circuit_threshold_is_inclusive_at_exact_boundary():
    """失败阈值是「达到即熔断」：第 N-1 次仍放行，第 N 次立刻 open。"""
    breaker = CircuitBreaker(failure_threshold=3, open_seconds=60)
    breaker.record_failure(_fail())
    breaker.record_failure(_fail())
    breaker.before_call()                       # 差一次：不得阻断
    assert breaker.snapshot()['state'] == 'closed'
    assert breaker.snapshot()['consecutiveFailures'] == 2
    breaker.record_failure(_fail())
    assert breaker.snapshot()['state'] == 'open'
    try:
        breaker.before_call()
    except RuntimeError as exc:
        assert exc.code == 'L3_RUNTIME_CIRCUIT_OPEN'
    else:
        raise AssertionError('已达阈值仍放行了调用')


def test_circuit_different_stage_resets_the_failure_counter():
    """同阶段才累加：切阶段后计数从 1 重开，且 _failure_stage 被改写。"""
    breaker = CircuitBreaker(failure_threshold=3, open_seconds=60)
    breaker.record_failure(_fail(stage='init'))
    breaker.record_failure(_fail(stage='init'))
    assert breaker.snapshot()['consecutiveFailures'] == 2
    breaker.record_failure(_fail(stage='home'))
    snap = breaker.snapshot()
    assert snap['consecutiveFailures'] == 1
    assert snap['failureStage'] == 'home'
    assert snap['state'] == 'closed'


def test_circuit_empty_stage_defaults_to_runtime():
    """stage 为空串时按 'runtime' 归一（record_failure 的 `stage or 'runtime'`）。"""
    breaker = CircuitBreaker(failure_threshold=2, open_seconds=60)
    breaker.record_failure(_fail(stage=''))
    assert breaker.snapshot()['failureStage'] == 'runtime'
    breaker.record_failure(_fail(stage=''))
    assert breaker.snapshot()['state'] == 'open'


def test_circuit_queued_timeout_is_exempt_and_frees_the_probe_slot():
    """排队超时（details.queued）不计失败，并归还半开探测名额。

    用一份没有失败历史的半开态隔离豁免语义本身，避免前置失败污染计数基线。
    """
    breaker = _in_half_open_without_history()
    assert breaker.snapshot()['halfOpenInFlight'] is True
    queued = RuntimeError('L3_RUNTIME_TIMEOUT', stage='runtime', details={'queued': True})
    breaker.record_failure(queued)
    snap = breaker.snapshot()
    assert snap['halfOpenInFlight'] is False        # 探测名额归还
    assert snap['consecutiveFailures'] == 0         # 不计失败
    assert snap['state'] != 'open'                  # 不因排队超时冻站点
    breaker.before_call()                           # 下一个请求不被阻断（继续探测）


def test_circuit_queued_timeout_does_not_increment_the_counter():
    """排队超时在计数之前返回：连续失败计数保持不变，也不推进熔断。"""
    breaker = CircuitBreaker(failure_threshold=3, open_seconds=60)
    baseline = 2
    for _ in range(baseline):
        breaker.record_failure(_fail())
    breaker.record_failure(RuntimeError('L3_RUNTIME_TIMEOUT', details={'queued': True}))
    assert breaker.snapshot()['consecutiveFailures'] == baseline
    assert breaker.snapshot()['state'] == 'closed'
    breaker.record_failure(_fail())                 # 再来一次真实失败才达阈值
    assert breaker.snapshot()['state'] == 'open'


def test_circuit_real_worker_timeout_without_queued_flag_still_counts():
    """只有显式 queued 标记才豁免：Worker 侧真实超时照常计数。"""
    breaker = CircuitBreaker(failure_threshold=2, open_seconds=60)
    breaker.record_failure(RuntimeError('L3_RUNTIME_TIMEOUT', details={'elapsed': 1}))
    assert breaker.snapshot()['consecutiveFailures'] == 1
    breaker.record_failure(RuntimeError('L3_RUNTIME_TIMEOUT', details={}))
    assert breaker.snapshot()['state'] == 'open'


def test_circuit_l2_site_timeout_with_queued_flag_is_also_exempt():
    """豁免覆盖 L2_SITE_TIMEOUT 与 L3_RUNTIME_TIMEOUT 两个码。"""
    breaker = CircuitBreaker(failure_threshold=1, open_seconds=60)
    breaker.record_failure(RuntimeError('L2_SITE_TIMEOUT', details={'queued': True}))
    assert breaker.snapshot()['state'] == 'closed'
    assert breaker.snapshot()['consecutiveFailures'] == 0


def test_circuit_queued_timeout_outside_half_open_is_noop():
    """非半开状态下的排队超时：不改 open_until，也不动状态。"""
    breaker = CircuitBreaker(failure_threshold=3, open_seconds=60)
    breaker.record_failure(RuntimeError('L3_RUNTIME_TIMEOUT', details={'queued': True}))
    snap = breaker.snapshot()
    assert snap['state'] == 'closed'
    assert snap['circuitOpenForMs'] == 0


def test_circuit_non_runtime_error_is_ignored():
    """record_failure 只认 RuntimeError：裸异常/字符串一律被丢弃（防误熔断）。"""
    breaker = CircuitBreaker(failure_threshold=1, open_seconds=60)
    breaker.record_failure(ValueError('boom'))
    breaker.record_failure('plain string')
    breaker.record_failure(None)
    snap = breaker.snapshot()
    assert snap['state'] == 'closed'
    assert snap['consecutiveFailures'] == 0


def test_circuit_recovery_transition_uses_snapshot_for_state_only():
    """closed→open→half_open→closed 的完整迁移：每次推进都不真实等待。

    注意：half-open 只是内部标记，``snapshot()`` 在探测在途时把过期 open 直接
    投影成 'half-open'；真正的「放行一个探测」行为由 before_call 承担。
    """
    breaker = CircuitBreaker(failure_threshold=2, open_seconds=60)
    assert breaker.snapshot()['state'] == 'closed'
    breaker.record_failure(_fail())
    breaker.record_failure(_fail())                 # 达阈值
    assert breaker.snapshot()['state'] == 'open'
    breaker._open_until = circuit_mod.time.monotonic() - 1     # mock 时间推进
    assert breaker.snapshot()['state'] == 'half-open'          # 过期即视为可探测
    breaker.before_call()
    assert breaker.snapshot()['halfOpenInFlight'] is True
    breaker.record_success()                                   # 探测成功
    snap = breaker.snapshot()
    assert snap['state'] == 'closed'
    assert snap['consecutiveFailures'] == 0
    assert snap['circuitOpenForMs'] == 0


def test_circuit_half_open_allows_only_one_probe():
    """半开态只允许单个在途探测（内部标记生效）。"""
    breaker = _in_half_open_without_history()
    assert breaker.snapshot()['halfOpenInFlight'] is True
    breaker._state = 'open'                         # 回到「过期 open + 探测在途」
    breaker._open_until = circuit_mod.time.monotonic() - 1
    try:
        breaker.before_call()
    except RuntimeError as exc:
        assert exc.code == 'L3_RUNTIME_CIRCUIT_OPEN'
        assert exc.details.get('halfOpen') is True
    else:
        raise AssertionError('半开态放行了第二个并发探测')


def test_circuit_second_probe_rejected_while_first_in_flight():
    """探测在途期间，后续调用被 halfOpen 拒绝（配额=1 的真实约束）。"""
    breaker = _in_half_open_without_history()
    breaker._state = 'open'                         # 窗口已过期但探测仍在途
    rejected = []
    for _ in range(3):
        try:
            breaker.before_call()
        except RuntimeError as exc:
            rejected.append(exc.details.get('halfOpen'))
    assert rejected == [True, True, True]
    assert breaker.snapshot()['halfOpenInFlight'] is True


def test_circuit_half_open_success_returns_to_closed_and_clears_permanent():
    """半开探测成功：整条链路 closed→open→half-open→closed，并清掉永久错误。"""
    breaker = CircuitBreaker(failure_threshold=1, open_seconds=60)
    breaker.record_failure(RuntimeError('L3_RUNTIME_CREDENTIALS_REQUIRED'))
    assert breaker.snapshot()['permanent'] is True
    breaker.force_half_open()                       # 用户显式探测绕过永久阻断
    breaker.before_call()
    assert breaker.snapshot()['state'] == 'half-open'
    breaker.record_success()
    snap = breaker.snapshot()
    assert snap['state'] == 'closed'
    assert snap['permanent'] is False
    assert snap['consecutiveFailures'] == 0
    assert snap['failureStage'] == ''
    assert snap['halfOpenInFlight'] is False


def test_circuit_snapshot_is_pure_and_never_mutates_state():
    """snapshot 是只读投影：过期 open 在快照里显示 half-open，但内部状态不变。"""
    breaker = CircuitBreaker(failure_threshold=1, open_seconds=60)
    breaker.record_failure(_fail())
    assert breaker._state == 'open'
    breaker._open_until = circuit_mod.time.monotonic() - 5      # mock 时间推进
    assert breaker.snapshot()['state'] == 'half-open'
    assert breaker._state == 'open'                             # 内部未迁移
    assert breaker.snapshot()['circuitOpenForMs'] == 0          # 过期不得为负
    assert breaker.snapshot()['state'] == 'half-open'           # 重复调用结果稳定


def test_circuit_open_until_boundary_is_exclusive():
    """恢复超时边界：now < open_until 阻断；恰好等于/超过才放行（用 patch 推进）。"""
    breaker = CircuitBreaker(failure_threshold=1, open_seconds=60)
    now = circuit_mod.time.monotonic()
    breaker.record_failure(_fail())
    breaker._open_until = now + 10.0
    with mock.patch.object(circuit_mod.time, 'monotonic', return_value=now + 9.999):
        try:
            breaker.before_call()
        except RuntimeError as exc:
            assert exc.code == 'L3_RUNTIME_CIRCUIT_OPEN'
            assert exc.details['retryAfterMs'] >= 1     # retryAfterMs 下限钳制
        else:
            raise AssertionError('窗口未过就放行了')
    with mock.patch.object(circuit_mod.time, 'monotonic', return_value=now + 10.0):
        breaker.before_call()                          # 恰好过期：放行半开探测
    assert breaker.snapshot()['state'] == 'half-open'


def test_circuit_forced_probe_bypasses_open_window_once():
    """force_half_open 只放行一次探测：_forced_probe 在 before_call 内被消费。"""
    breaker = CircuitBreaker(failure_threshold=1, open_seconds=60)
    breaker.record_failure(_fail())
    breaker.force_half_open()
    assert breaker._forced_probe is True
    breaker.before_call()
    assert breaker._forced_probe is False            # 已消费
    assert breaker.snapshot()['state'] == 'half-open'
    breaker.record_failure(_fail())                  # 探测失败回到 open
    try:
        breaker.before_call()
    except RuntimeError as exc:
        assert exc.code == 'L3_RUNTIME_CIRCUIT_OPEN'
    else:
        raise AssertionError('force_half_open 应只生效一次')


def test_circuit_force_half_open_is_noop_when_closed_without_permanent():
    """closed 且无永久错误时不需要强制探测：不置位 _forced_probe。"""
    breaker = CircuitBreaker(failure_threshold=3, open_seconds=60)
    breaker.force_half_open()
    assert breaker._forced_probe is False
    assert breaker.snapshot()['state'] == 'closed'


def test_circuit_permanent_error_survives_success_only_after_probe():
    """不可重试错误：before_call 直接重抛原错误（含 site_key），不包装成熔断码。"""
    breaker = CircuitBreaker(failure_threshold=3, open_seconds=60)
    breaker.record_failure(RuntimeError('L3_RUNTIME_CREDENTIALS_REQUIRED', site_key='demo'))
    try:
        breaker.before_call()
    except RuntimeError as exc:
        assert exc.code == 'L3_RUNTIME_CREDENTIALS_REQUIRED'
        assert exc.site_key == 'demo'
    else:
        raise AssertionError('永久错误未阻断')
    assert breaker.snapshot()['permanent'] is True
    assert breaker.snapshot()['state'] == 'blocked'


def test_circuit_permanent_error_wins_over_open_window():
    """永久错误优先于开放窗口判定：即使已过期也先抛永久错误。"""
    breaker = CircuitBreaker(failure_threshold=1, open_seconds=60)
    breaker.record_failure(_fail())
    breaker._open_until = circuit_mod.time.monotonic() - 1
    breaker.record_failure(RuntimeError('L2_SITE_UNSUPPORTED'))
    try:
        breaker.before_call()
    except RuntimeError as exc:
        assert exc.code == 'L2_SITE_UNSUPPORTED'
    else:
        raise AssertionError('永久错误被过期窗口掩盖')


def test_circuit_concurrent_failures_reach_threshold_exactly_once():
    """并发失败：N 个线程各记一次失败，计数精确等于 N，状态一致收敛到 open。"""
    breaker = CircuitBreaker(failure_threshold=8, open_seconds=60)
    threads, per = 8, 50
    barrier = threading.Barrier(threads)

    def worker():
        barrier.wait()
        for _ in range(per):
            breaker.record_failure(_fail())

    ts = [threading.Thread(target=worker) for _ in range(threads)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(timeout=30)
    snap = breaker.snapshot()
    assert snap['consecutiveFailures'] == threads * per
    assert snap['state'] == 'open'


def test_circuit_concurrent_before_call_keeps_state_consistent():
    """并发争抢半开名额：状态迁移只发生一次，最终态自洽（不出现半个迁移）。"""
    breaker = CircuitBreaker(failure_threshold=1, open_seconds=60)
    breaker.record_failure(_fail())
    breaker._open_until = circuit_mod.time.monotonic() - 1      # 窗口已过期
    transitions = []
    granted, rejected = [], []
    barrier = threading.Barrier(16)

    def worker():
        barrier.wait()
        # 把读取与调用放进同一临界区（CircuitBreaker 用 RLock 可重入）：
        # 之前在锁外读 _state、随后才调 before_call()，存在竞态——线程 B 在迁移
        # 完成前读到 'open'、而它的 before_call 在线程 A 完成迁移之后才执行，按
        # before_call 的实际行为（state 已是 half-open 时直接放行），B 会被 granted
        # 且 before == 'open'，导致下面的 len(transitions) == 1 假失败。
        with breaker._lock:
            before = breaker._state
            try:
                breaker.before_call()
            except RuntimeError as exc:
                rejected.append(exc.details.get('halfOpen'))
            else:
                granted.append(before)

    ts = [threading.Thread(target=worker) for _ in range(16)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(timeout=30)
    transitions = [state for state in granted if state == 'open']
    # 抢占到「open → half-open」迁移的线程有且只有一个（RLock 保证迁移是原子的）
    assert len(transitions) == 1, '迁移被并发重复执行了 %d 次' % len(transitions)
    snap = breaker.snapshot()
    assert snap['state'] == 'half-open'
    assert snap['halfOpenInFlight'] is True
    assert len(granted) + len(rejected) == 16


def test_circuit_concurrent_blocked_calls_never_mutate_state():
    """窗口未过期时并发 before_call：全部被拒且状态/窗口不被改写。"""
    breaker = CircuitBreaker(failure_threshold=1, open_seconds=60)
    breaker.record_failure(_fail())
    until = breaker._open_until
    errors = []
    barrier = threading.Barrier(12)

    def worker():
        barrier.wait()
        try:
            breaker.before_call()
        except RuntimeError as exc:
            errors.append(exc.code)
        else:
            errors.append('PASSED')

    ts = [threading.Thread(target=worker) for _ in range(12)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(timeout=30)
    assert set(errors) == {'L3_RUNTIME_CIRCUIT_OPEN'}
    assert breaker._state == 'open'                   # 未被误迁到 half-open
    assert breaker._open_until == until               # 窗口未被并发改写
    assert breaker._half_open_in_flight is False


def test_circuit_half_open_passes_through_without_quota_after_transition():
    """锁定既有行为：进入 half-open 后，后续 before_call 不再受名额约束。

    源码 50-55 行的名额检查挂在 ``state == 'open'`` 分支上；一旦第一个调用把
    状态迁到 'half-open'，后续调用既不命中 open 分支也不命中 half-open 分支，
    全部放行——「单个半开探测」只对**迁移那一次**成立（并发下的实际配额不是 1）。
    """
    breaker = _in_half_open_without_history()
    assert breaker._state == 'half-open'
    breaker.before_call()
    breaker.before_call()
    assert breaker._state == 'half-open'              # 未被拒绝，也未被重置
    assert breaker.snapshot()['halfOpenInFlight'] is True


def test_circuit_open_seconds_and_backoff_are_clamped():
    """构造参数钳制：阈值下限 1、open_seconds 下限 0.01、退避不超过 open_seconds。"""
    breaker = CircuitBreaker(failure_threshold=0, open_seconds=0)
    assert breaker.failure_threshold == 1
    assert breaker.open_seconds == 0.01
    assert breaker.half_open_backoff_seconds <= breaker.open_seconds
    big = CircuitBreaker(failure_threshold=1, open_seconds=10, half_open_backoff_seconds=0)
    assert big.half_open_backoff_seconds == 0.01


# ================================================================ health


def test_health_constructor_dedupes_and_sorts_capabilities():
    """__post_init__ 对 capabilities 去重 + 排序 + 丢弃空值。"""
    health = SiteHealth('s', capabilities=['player', 'home', 'home', '', None])
    assert health.capabilities == ['home', 'player']


def test_health_pickle_drops_lock_and_rebuilds_it():
    """RLock 不可序列化：__getstate__ 丢弃、__setstate__ 重建（跨进程传递契约）。"""
    import pickle

    health = SiteHealth('s', runtime='jar').mark_built().mark_initialized()
    restored = pickle.loads(pickle.dumps(health))
    state = health.__getstate__()                   # 显式取序列化态：RLock 被丢弃
    assert '_lock' not in state
    assert 'site_key' in state
    assert isinstance(restored._lock, type(threading.RLock()))
    assert restored.initialized is True
    restored.record_failure(_fail())            # 重建的锁可用（可重入临界区）
    assert restored.state == 'unavailable'


def test_health_mark_built_does_not_touch_initialized():
    """mark_built 只推进 built/state，不得顺带把 initialized 置真。"""
    health = SiteHealth('s', runtime='python')
    health.mark_built()
    assert health.built is True
    assert health.initialized is False
    assert health.state == 'built'
    assert health.healthy is False


def test_health_mark_healthy_clears_circuit_and_error():
    """mark_healthy 一次性清掉失败痕迹：错误、计数、熔断窗口、half_open。"""
    health = SiteHealth('s', runtime='python').mark_initialized()
    health.record_failure(_fail())
    health.circuit_open_until = 12345.0
    health.half_open = True
    health.mark_healthy()
    assert health.healthy is True and health.state == 'healthy'
    assert health.last_error is None
    assert health.consecutive_failures == 0
    assert health.circuit_open_until == 0
    assert health.half_open is False


def test_health_record_success_keeps_uninitialized_site_from_becoming_healthy():
    """未 initialized 的成功回调只更新 last_success_at，不把站点抬成 healthy。"""
    health = SiteHealth('s', runtime='python')
    health.record_success('home')
    assert health.healthy is False
    assert health.state == 'configured'
    assert health.last_success_at > 0


def test_health_degradation_threshold_is_three_failures():
    """降级阈值边界（源码写死 3）：第 2 次不设熔断窗口，第 3 次立即开窗。"""
    health = SiteHealth('s', runtime='python').mark_initialized()
    health.record_failure(_fail(stage='home'))
    health.record_failure(_fail(stage='home'))
    assert health.consecutive_failures == 2
    assert health.circuit_open_until == 0           # 差一次：尚未开窗
    health.record_failure(_fail(stage='home'))
    assert health.circuit_open_until > 0            # 达到阈值：开窗


def test_health_failure_stage_switch_restarts_the_count():
    """换阶段后计数归 1：与 CircuitBreaker 的计数语义保持一致。"""
    health = SiteHealth('s', runtime='python').mark_initialized()
    health.record_failure(_fail(stage='init'))
    health.record_failure(_fail(stage='init'))
    assert health.consecutive_failures == 2
    health.record_failure(_fail(stage='player'))
    assert health.consecutive_failures == 1
    assert health.failure_stage == 'player'


def test_health_non_retryable_failure_never_increments_circuit_count():
    """不可重试错误（retryable=False）不累加计数：不该把凭据缺失算成抖动。"""
    health = SiteHealth('s', runtime='python').mark_initialized()
    health.record_failure(RuntimeError('L3_RUNTIME_CREDENTIALS_REQUIRED'))
    health.record_failure(RuntimeError('L3_RUNTIME_CREDENTIALS_REQUIRED'))
    assert health.consecutive_failures == 0
    assert health.circuit_open_until == 0
    assert health.state == 'degraded'


def test_health_cancel_preserves_health_and_skips_circuit():
    """取消不降健康度、不计熔断，只把 state 标成 cancelled 并保留 last_error。"""
    health = SiteHealth('s', runtime='python').mark_initialized().mark_healthy()
    health.record_failure(RuntimeError('L3_RUNTIME_CANCELLED'))
    assert health.healthy is True                   # 健康站点不被取消打死
    assert health.consecutive_failures == 0
    assert health.circuit_open_until == 0
    assert health.state == 'cancelled'
    assert health.last_error.code == 'L3_RUNTIME_CANCELLED'


def test_health_circuit_open_failure_extends_window_from_retry_after():
    """L3_RUNTIME_CIRCUIT_OPEN 用 retryAfterMs 折算窗口，且取 max 不被回缩。"""
    health = SiteHealth('s', runtime='python').mark_initialized()
    now = 100000.0
    with mock.patch('time.time', return_value=now):
        health.record_failure(RuntimeError('L3_RUNTIME_CIRCUIT_OPEN',
                                           details={'retryAfterMs': 4000}))
        assert health.circuit_open_until == now + 4.0
        health.record_failure(RuntimeError('L3_RUNTIME_CIRCUIT_OPEN',
                                           details={'retryAfterMs': 1000}))
        assert health.circuit_open_until == now + 4.0      # max：不回缩
    assert health.state == 'circuit-open'


def test_health_plain_exception_is_wrapped_with_site_context():
    """record_failure 收裸异常：经 error_from_exception 包装并回填 site_key/runtime。"""
    health = SiteHealth('ctx', runtime='jar').mark_initialized()
    health.record_failure(TimeoutError('worker hung'))
    assert health.last_error.code == 'L3_RUNTIME_TIMEOUT'
    assert health.last_error.site_key == 'ctx'
    assert health.last_error.runtime == 'jar'
    assert health.state == 'timeout'


def test_health_requires_android_failure_rewrites_runtime_and_compatibility():
    """L2_SITE_REQUIRES_ANDROID 分支：把 runtime/compatibility/state 一并改写。"""
    health = SiteHealth('s', runtime='jar', compatibility='C1').mark_initialized()
    health.record_failure(RuntimeError('L2_SITE_REQUIRES_ANDROID'))
    assert health.runtime == 'android'
    assert health.compatibility == 'C2'
    assert health.state == 'requires_android'


def test_health_unsupported_state_is_sticky():
    """runtime='unsupported' 或 L2_SITE_UNSUPPORTED 都落到 unsupported 状态。"""
    by_runtime = SiteHealth('s', runtime='unsupported')
    by_runtime.record_failure(_fail())
    assert by_runtime.state == 'unsupported'
    by_code = SiteHealth('s2', runtime='python')
    by_code.record_failure(RuntimeError('L2_SITE_UNSUPPORTED'))
    assert by_code.state == 'unsupported'


def test_health_force_half_open_only_from_frozen_states():
    """force_half_open 的状态迁移是白名单：circuit-open/degraded 才转 half-open。"""
    frozen = SiteHealth('s', runtime='python', state='circuit-open')
    frozen.force_half_open()
    assert frozen.state == 'half-open'
    assert frozen.half_open is True
    assert frozen.circuit_open_until == 0

    degraded = SiteHealth('s2', runtime='python', state='degraded')
    degraded.force_half_open()
    assert degraded.state == 'half-open'

    healthy = SiteHealth('s3', runtime='python').mark_healthy()
    healthy.force_half_open()
    assert healthy.state == 'healthy'               # 健康站点不被强制半开
    assert healthy.half_open is True                # 标记仍置位供诊断


def test_health_concurrent_updates_keep_counters_exact():
    """并发成功/失败交错：计数与状态的终值必须确定（锁保护读-改-写）。"""
    health = SiteHealth('s', runtime='jar').mark_initialized()
    threads, per = 10, 120
    barrier = threading.Barrier(threads)

    def worker(idx):
        barrier.wait()
        for i in range(per):
            if idx % 3 == 0 and i % 5 == 0:
                health.record_success()
            else:
                health.record_failure(_fail(stage='home'))

    ts = [threading.Thread(target=worker, args=(i,)) for i in range(threads)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(timeout=30)
    snapshot = health.to_dict()
    assert snapshot['consecutiveFailures'] >= 3          # 失败足够多，已越过阈值
    assert isinstance(snapshot['lastError'], dict)
    assert snapshot['lastError']['code'] == 'L3_RUNTIME_CALL_FAILED'


def test_health_to_dict_last_success_and_circuit_are_epoch_ms():
    """to_dict 把秒级时间戳折算成毫秒 epoch；0 值保持 0 而不是脏值。"""
    health = SiteHealth('s', runtime='python')
    assert health.to_dict()['lastSuccessAt'] == 0
    assert health.to_dict()['circuitOpenUntil'] == 0
    health.mark_healthy()
    assert health.to_dict()['lastSuccessAt'] > 0
    health.circuit_open_until = 1700000000.5
    assert health.to_dict()['circuitOpenUntil'] == 1700000000500


def test_health_route_is_serialized_when_present():
    """to_dict 的 route 分支：有路由结论时展开，无路由时为 None。"""
    health = SiteHealth('s')
    assert health.to_dict()['route'] is None
    inferred = infer_site_health({'key': 'k', 'type': 3, 'api': 'demo.py'})
    payload = inferred.to_dict()
    assert isinstance(payload['route'], dict)
    assert payload['route']['siteKey'] == 'k'
    assert payload['runtime'] == 'python'


def test_health_unknown_site_defaults_to_unknown_runtime():
    """未知/空条目：runtime 兜底 unknown，站点默认 configured 且不健康。"""
    health = infer_site_health({})
    assert health.site_key == '?'
    assert health.runtime == 'unsupported'
    assert health.state == 'unsupported'
    assert health.healthy is False
    assert health.capabilities == []


def test_health_infer_drops_search_capability_for_non_one_searchable():
    """searchable != 1（FongMi 里 isSearchable()=false）时显式能力表也要剔除 search。"""
    health = infer_site_health({'key': 'k', 'type': 3, 'api': 'demo.py', 'searchable': 2},
                               capabilities=['search', 'home'])
    assert 'search' not in health.capabilities
    assert health.capabilities == ['home']
    kept = infer_site_health({'key': 'k', 'type': 3, 'api': 'demo.py', 'searchable': 1},
                             capabilities=['search', 'home'])
    assert kept.capabilities == ['home', 'search']


def test_health_android_worker_enabled_is_false_under_policy_ceiling():
    """C1 支持天花板下 android_worker_enabled 恒假：env 不能抬高正式上限。"""
    env = {'YUKI_ANDROID_WORKER_ENABLED': '1', 'YUKI_ANDROID_WORKER_READY': '1'}
    with mock.patch.dict(os.environ, env):
        assert android_worker_enabled() is False
    with mock.patch.dict(os.environ, {'YUKI_ANDROID_WORKER_ENABLED': 'true',
                                      'YUKI_ANDROID_WORKER_READY': 'yes'}):
        assert android_worker_enabled() is False
    with mock.patch.dict(os.environ, {}, clear=True):
        assert android_worker_enabled() is False


# ================================================================ errors


def test_errors_inheritance_and_catalog_shape():
    """RuntimeError 既是 Exception 也是 dataclass；目录覆盖 L1-L6 六层。"""
    err = RuntimeError('L3_RUNTIME_CALL_FAILED')
    assert isinstance(err, Exception)
    assert hasattr(err, '__dataclass_fields__')
    assert {code[:2] for code in ERROR_SPECS} == {'L1', 'L2', 'L3', 'L4', 'L5', 'L6'}
    for code, spec in ERROR_SPECS.items():
        assert len(spec) == 4
        assert isinstance(spec[1], bool) and 400 <= spec[2] < 600


def test_errors_unknown_code_is_rejected_at_construction():
    """错误码是闭合集合：未登记码直接 ValueError，不放任脏码进 UI。"""
    try:
        RuntimeError('L9_MADE_UP')
    except ValueError as exc:
        assert 'unknown runtime error code' in str(exc)
    else:
        raise AssertionError('未知错误码被接受')


def test_errors_explicit_overrides_win_over_spec_defaults():
    """显式 stage/retryable/http_status 覆盖目录默认值；缺省才取目录。"""
    err = RuntimeError('L3_RUNTIME_CALL_FAILED', stage='parse', retryable=False,
                       http_status=418)
    assert err.stage == 'parse'
    assert err.retryable is False
    assert err.http_status == 418
    default = RuntimeError('L3_RUNTIME_CREDENTIALS_REQUIRED')
    assert default.stage == 'runtime' and default.retryable is False
    assert default.http_status == 401


def test_errors_to_dict_omits_empty_optional_fields():
    """to_dict 只在非空时输出可选字段：避免给前端塞一堆空串/空 dict。"""
    err = RuntimeError('L3_RUNTIME_CALL_FAILED')
    payload = err.to_dict()
    assert set(payload) == {'code', 'stage', 'retryable', 'siteKey', 'runtime', 'message'}
    assert 'details' not in payload and 'requestId' not in payload
    err.request_id = 'req-abcdefg-0001'
    err.play_session_id = 'ses-abcdefg-0001'
    err.details = {'k': 1}
    full = err.to_dict()
    assert full['requestId'] == 'req-abcdefg-0001'
    assert full['playSessionId'] == 'ses-abcdefg-0001'
    assert full['details'] == {'k': 1}
    assert 'rawError' not in full                       # include_raw=False


def test_errors_raw_error_is_redacted_and_only_on_demand():
    """raw_error 走独立脱敏（上限 1000）且仅 include_raw=True 时出帧。"""
    err = RuntimeError('L3_RUNTIME_CALL_FAILED',
                       raw_error='Cookie: sid=supersecret token=abcd1234')
    assert 'supersecret' not in err.raw_error
    assert 'abcd1234' not in err.raw_error
    assert '[REDACTED]' in err.raw_error
    assert 'rawError' not in err.to_dict()
    assert err.to_dict(include_raw=True)['rawError'] == err.raw_error


def test_errors_str_returns_user_safe_message():
    """__str__ 用脱敏后的 message（Exception.__init__ 在 __post_init__ 里重放）。"""
    err = RuntimeError('L3_RUNTIME_CREDENTIALS_REQUIRED', message='Cookie: a=b')
    assert str(err) == err.message
    assert 'a=b' not in str(err)
    assert err.args[0] == err.message


def test_errors_with_request_backfills_only_empty_fields():
    """with_request 只回填空字段，不覆盖已有值；request=None 是 no-op。"""
    class _Req:
        request_id = 'req-from-req-0001'
        play_session_id = 'ses-from-req-0001'
        site_key = 'site-from-req'

    err = RuntimeError('L3_RUNTIME_CALL_FAILED', site_key='explicit')
    err.with_request(_Req())
    assert err.site_key == 'explicit'                 # 已有值不被覆盖
    assert err.request_id == 'req-from-req-0001'
    assert err.play_session_id == 'ses-from-req-0001'
    before = err.request_id
    err.with_request(None)
    assert err.request_id == before


def test_errors_cause_chain_is_preserved():
    """raise ... from 的因果链不被错误包装吞掉：__cause__ 指向原始异常。"""
    try:
        try:
            raise ValueError('upstream exploded')
        except ValueError as exc:
            mapped = error_from_exception(exc, stage='parse')
            raise RuntimeError(mapped.code, raw_error=mapped.raw_error) from exc
    except RuntimeError as caught:
        assert isinstance(caught.__cause__, ValueError)
        assert str(caught.__cause__) == 'upstream exploded'
    else:
        raise AssertionError('因果链未保留')


def test_errors_error_from_exception_maps_every_stage():
    """error_from_exception 的 stage→码映射矩阵（普通异常分支，六个层级全覆盖）。"""
    expected = {
        'config': 'L1_CONFIG_PARSE_FAILED', 'site': 'L2_SITE_BUILD_FAILED',
        'parse': 'L4_PARSE_FAILED', 'media': 'L5_MEDIA_UNREACHABLE',
        'player': 'L6_PLAYER_START_FAILED', 'runtime': 'L3_RUNTIME_CALL_FAILED',
    }
    for stage, code in expected.items():
        assert error_from_exception(ValueError('x'), stage=stage).code == code


def test_errors_error_from_exception_is_idempotent():
    """已归一化的 RuntimeError 直接返回自身（不再包一层，避免套娃）。"""
    original = RuntimeError('L3_RUNTIME_TIMEOUT', request_id='')
    assert error_from_exception(original) is original
    assert error_from_exception(original, stage='parse').code == 'L3_RUNTIME_TIMEOUT'


def test_errors_from_dict_sanitizes_untrusted_worker_frames():
    """from_dict 是隔离进程的入口：未知码/未知字段一律降级，不信任对端。"""
    assert RuntimeError.from_dict({'code': 'EVIL_CODE'}).code == 'L3_RUNTIME_CALL_FAILED'
    assert RuntimeError.from_dict(None).code == 'L3_RUNTIME_CALL_FAILED'
    assert RuntimeError.from_dict({'code': 123}).code == 'L3_RUNTIME_CALL_FAILED'
    restored = RuntimeError.from_dict({'code': 'L3_RUNTIME_TIMEOUT', 'siteKey': 'a',
                                       'runtime': 'jar', 'requestId': 'r',
                                       'playSessionId': 'p', 'details': {'k': 'v'},
                                       'rawError': 'token=zzz',
                                       'message': 'Cookie: sid=zzz'})
    assert restored.code == 'L3_RUNTIME_TIMEOUT'
    assert restored.details == {'k': 'v'}
    assert 'zzz' not in restored.raw_error                 # 构造期已脱敏
    assert '[REDACTED]' in restored.raw_error
    assert 'zzz' not in restored.message
    assert '[REDACTED]' in restored.message
    assert RuntimeError.from_dict({'details': ['not', 'a', 'map']}).details == {}


def test_errors_redact_limit_is_clamped_and_truncates():
    """redact_sensitive 的 limit 钳制在 [32, 16000]，超限用省略号收尾。"""
    long_text = 'a' * 5000
    assert len(redact_sensitive(long_text, 100)) == 100
    assert redact_sensitive(long_text, 100).endswith('…')
    assert len(redact_sensitive(long_text, 1)) == 32          # 下限钳制
    assert len(redact_sensitive(long_text, 999999)) == 5000   # 未超限不截断
    assert redact_sensitive('a\r\nb\tc') == 'a b c'           # 控制字符压成空格
    assert redact_sensitive('x\x00y') == 'xy'


def test_errors_message_defaults_to_catalog_text():
    """未给 message 时用目录里的中文文案；L2_SITE_REQUIRES_ANDROID 复用策略文案。"""
    assert RuntimeError('L3_RUNTIME_CIRCUIT_OPEN').message == '站点运行时暂时熔断，稍后将自动重试'
    assert RuntimeError('L2_SITE_REQUIRES_ANDROID').message == ANDROID_ONLY_MESSAGE


# ================================================================ contracts


def test_contracts_deadline_defaults_per_method_and_clamps():
    """方法默认截止来自目录；未知方法 30000；上下界钳制到 [1, 120000]。"""
    assert RuntimeRequest.create(method='homeContent').deadline_ms == DEFAULT_DEADLINES_MS['homeContent']
    assert RuntimeRequest.create(method='init').deadline_ms == 30000
    assert RuntimeRequest.create(method='unknown').deadline_ms == 30000
    assert RuntimeRequest.create(method='homeContent', deadline_ms=10 ** 9).deadline_ms == MAX_DEADLINE_MS
    assert RuntimeRequest.create(method='homeContent', deadline_ms=-5).deadline_ms == 1
    assert RuntimeRequest.create(method='homeContent', deadline_ms=0).deadline_ms == 1


def test_contracts_non_numeric_deadline_falls_back_to_default():
    """deadline_ms 类型错误（字符串/None 混合）走 except 分支回默认值。"""
    assert RuntimeRequest.create(method='search', deadline_ms='abc').deadline_ms == 20000
    assert RuntimeRequest.create(method='search', deadline_ms=None).deadline_ms == 20000
    assert RuntimeRequest.create(method='search', deadline_ms=object()).deadline_ms == 20000


def test_contracts_request_id_normalization_rules():
    """ID 归一化：合法保留、非法重新生成（长度 8-128、首字符字母数字）。"""
    good = 'req-normal-0001'
    assert normalize_request_id(good) == good
    for bad in ('', 'short', 'bad!char!', ' leading', '-leading', None, 12345):
        generated = normalize_request_id(bad)
        assert generated != bad
        assert 8 <= len(generated) <= 128
        assert generated[0].isalnum()
    two = normalize_request_id('same-bad-input!!')
    assert two != normalize_request_id('same-bad-input!!')   # 每次重新生成 uuid4


def test_contracts_from_action_strips_control_fields_into_args():
    """from_action：do/site/siteKey/requestId/playSessionId/deadlineMs 被剥离，其余进 args。"""
    request = RuntimeRequest.from_action({
        'do': 'categoryContent', 'site': 'demo', 'siteKey': 'ignored',
        'page': 2, 'filters': {'tid': '1'}, 'requestId': 'req-abcdefg-0001',
        'playSessionId': 'ses-abcdefg-0001', 'deadlineMs': '5000',
    })
    assert request.method == 'categoryContent'
    assert request.site_key == 'demo'                     # site 优先于 siteKey
    assert request.args == {'page': 2, 'filters': {'tid': '1'}}
    assert request.request_id == 'req-abcdefg-0001'
    assert request.play_session_id == 'ses-abcdefg-0001'
    assert request.deadline_ms == 5000
    fallback = RuntimeRequest.from_action({'do': 'home', 'siteKey': 'from-site-key'})
    assert fallback.site_key == 'from-site-key'
    empty = RuntimeRequest.from_action({})
    assert empty.method == '' and empty.site_key == '' and empty.args == {}


def test_contracts_remaining_ms_and_elapsed_are_monotonic():
    """elapsed/remaining 用 mock 推进 time.time：不 sleep 也能验证剩余预算递减。"""
    request = RuntimeRequest.create(method='homeContent', deadline_ms=1000)
    assert request.elapsed_ms == 0 and request.remaining_ms == 1000
    with mock.patch('time.time', return_value=request.created_at + 0.4):
        assert request.elapsed_ms == 400
        assert request.remaining_ms == 600
    with mock.patch('time.time', return_value=request.created_at + 5.0):
        assert request.remaining_ms == 0                  # 下限 0，不为负
        assert request.deadline_exceeded is True


def test_contracts_expire_raises_method_specific_timeout_code():
    """超时码按 method 分派：init/parse/mediaProbe/playerStart 各有专属码。"""
    cases = {
        'init': 'L2_SITE_TIMEOUT', 'parse': 'L4_PARSE_TIMEOUT',
        'mediaProbe': 'L5_MEDIA_TIMEOUT', 'playerStart': 'L6_PLAYER_START_TIMEOUT',
        'homeContent': 'L3_RUNTIME_TIMEOUT', 'nope': 'L3_RUNTIME_TIMEOUT',
    }
    for method, code in cases.items():
        request = RuntimeRequest.create(method=method)
        request.expire()
        try:
            request.raise_if_cancelled()
        except RuntimeError as exc:
            assert exc.code == code, '%s → %s' % (method, exc.code)
        else:
            raise AssertionError('%s 超时未抛错' % method)


def test_contracts_cancel_reason_falls_back_to_timeout_when_expired():
    """cancel_reason：显式原因优先；未显式原因且已超时时推导为 timeout。"""
    request = RuntimeRequest.create(method='homeContent', deadline_ms=1)
    assert request.cancel_reason == 'cancelled'            # 未取消也未超时
    request.cancel('user-switch')
    assert request.cancel_reason == 'user-switch'
    fresh = RuntimeRequest.create(method='homeContent', deadline_ms=1)
    with mock.patch('time.time', return_value=fresh.created_at + 10):
        assert fresh.cancel_reason == 'timeout'
        try:
            fresh.raise_if_cancelled_or_expired()
        except RuntimeError as exc:
            assert exc.code == 'L3_RUNTIME_TIMEOUT'
        else:
            raise AssertionError('已过期请求未抛错')
    timed_out = RuntimeRequest.create(method='homeContent', deadline_ms=1)
    timed_out.expire()
    try:
        timed_out.raise_if_cancelled(code='L3_RUNTIME_CANCELLED')
    except RuntimeError as exc:
        assert exc.code == 'L3_RUNTIME_TIMEOUT'      # 超时码优先于传入的默认码
    else:
        raise AssertionError('expire() 后未抛错')


def test_contracts_response_failure_carries_error_runtime_and_nulls_result():
    """RuntimeResponse.failure：结果置 None、runtime 回退到 error.runtime、回填请求上下文。"""
    request = RuntimeRequest.create(site_key='demo', method='playerContent',
                                    request_id='req-abcdefg-0001',
                                    play_session_id='ses-abcdefg-0001')
    error = RuntimeError('L4_PARSE_FAILED', runtime='jar')
    response = RuntimeResponse.failure(request, error)
    payload = response.to_dict()
    assert payload['ok'] is False
    assert payload['result'] is None
    assert payload['runtime'] == 'jar'                     # runtime 为空时取 error.runtime
    assert payload['error']['requestId'] == 'req-abcdefg-0001'
    assert payload['error']['siteKey'] == 'demo'
    explicit = RuntimeResponse.failure(request, RuntimeError('L4_PARSE_FAILED'), 'js')
    assert explicit.runtime == 'js'


def test_contracts_response_success_keeps_result_and_elapsed():
    """RuntimeResponse.success：透传 result 与 elapsed_ms，error 保持 None。"""
    request = RuntimeRequest.create(site_key='demo', method='homeContent',
                                    request_id='req-abcdefg-0001')
    response = RuntimeResponse.success(request, {'list': [1, 2]}, 'python')
    payload = response.to_dict()
    assert payload['ok'] is True
    assert payload['result'] == {'list': [1, 2]}
    assert payload['error'] is None
    assert payload['requestId'] == 'req-abcdefg-0001'
    assert isinstance(payload['elapsedMs'], int)


def test_contracts_bind_runtime_request_restores_context_after_exception():
    """bind_runtime_request 在异常路径也要 reset（finally），不污染后续调用。"""
    assert current_runtime_request() is None
    request = RuntimeRequest.create(site_key='demo', method='homeContent')
    try:
        with bind_runtime_request(request):
            assert current_runtime_request() is request
            raise KeyError('boom')
    except KeyError:
        pass
    assert current_runtime_request() is None


def test_contracts_request_to_dict_is_json_round_trippable():
    """to_dict 的帧能原样 JSON 往返（Worker 侧 from_action 可反向消费）。"""
    request = RuntimeRequest.create(site_key='demo', method='searchContent',
                                    args={'wd': '中�'.replace('�', '文'), 'page': 1},
                                    request_id='req-abcdefg-0001')
    restored = json.loads(json.dumps(request.to_dict(), ensure_ascii=False))
    assert restored['siteKey'] == 'demo'
    assert restored['args'] == {'wd': '中文', 'page': 1}
    assert restored['deadlineMs'] == request.deadline_ms


# ================================================================ config_cache


def test_config_cache_save_and_load_roundtrip_with_documents():
    """save→load 往返：正文、URL、ETag、documents 全部保真（用临时目录）。"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ConfigRepositoryCache(tmp)
        class _Fetch:
            final_url = 'https://fixture.invalid/final.json'
            etag = 'W/"abc"'
            last_modified = 'Wed, 21 Oct 2026 07:28:00 GMT'
        assert store.save('https://fixture.invalid/tv.json', '{"sites":[]}',
                          fetch=_Fetch(), documents={'a.json': '{}', 'b.json': '[]'}) is True
        loaded = store.load()
        assert isinstance(loaded, CachedConfig)
        assert loaded.text == '{"sites":[]}'
        assert loaded.final_url == _Fetch.final_url
        assert loaded.etag == 'W/"abc"'
        assert loaded.last_modified == _Fetch.last_modified
        assert loaded.documents == {'a.json': '{}', 'b.json': '[]'}
        assert loaded.transport == 'disk-cache'
        assert loaded.saved_at > 0


def test_config_cache_rejects_oversize_text_and_documents():
    """save 的体积闸门：正文超限 / documents 超限都整份不落盘（不写半个缓存）。"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ConfigRepositoryCache(tmp)
        assert store.save('u', 'x' * (MAX_CONFIG_BYTES + 1)) is False
        big_doc = 'y' * (MAX_DOCUMENTS_BYTES + 1)
        assert store.save('u', 'ok', documents={'big': big_doc}) is False
        assert store.load() is None                      # 未落盘
        assert store.save('u', '') is False              # 空正文不缓存
        assert store.save('u', 'ok') is True


def test_config_cache_load_rejects_oversize_file_before_parsing():
    """load 先按文件大小粗校验：超限文件不进 json.load（防内存放大）。"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ConfigRepositoryCache(tmp)
        with open(store.path, 'w', encoding='utf-8') as stream:
            stream.write('{"version":%d,"text":"' % CACHE_VERSION)
            stream.write('a' * (MAX_CACHE_FILE_BYTES + 1024))
            stream.write('"}')
        assert os.path.getsize(store.path) > MAX_CACHE_FILE_BYTES
        assert store.load() is None


def test_config_cache_load_rejects_bad_documents_and_hash():
    """load 的三条拒绝路径：documents 非 dict / 超上限 / 哈希不符。"""
    import hashlib
    import tempfile

    text = '{"sites":[]}'
    digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
    base = {'version': CACHE_VERSION, 'text': text, 'contentHash': digest}

    # 每次 write 用独立 TemporaryDirectory，与本文件其它用例的清理口径一致
    # （之前 tempfile.mkdtemp 从不清理，每次运行泄漏 5 个临时目录）。
    def check(payload, expect):
        with tempfile.TemporaryDirectory() as directory:
            store = ConfigRepositoryCache(directory)
            with open(store.path, 'w', encoding='utf-8') as stream:
                json.dump(payload, stream, ensure_ascii=False)
            got = store.load()
        if expect == 'empty-documents':
            assert got is not None and got.documents == {}
        else:
            assert got is None

    bad_docs = dict(base, documents=['not', 'a', 'dict'])
    check(bad_docs, 'empty-documents')                 # 非 dict → 视为空

    huge = dict(base, documents={'k': 'v' * (MAX_DOCUMENTS_BYTES + 1)})
    check(huge, None)                                  # documents 超限 → 整份无效

    tampered = dict(base, contentHash='0' * 64)
    check(tampered, None)

    no_text = {'version': CACHE_VERSION, 'text': '', 'contentHash': digest}
    check(no_text, None)

    too_big_text = {'version': CACHE_VERSION, 'text': 'z' * (MAX_CONFIG_BYTES + 1),
                    'contentHash': digest}
    check(too_big_text, None)


def test_config_cache_clear_is_idempotent_and_noop_without_path():
    """clear 幂等（文件不存在不抛）；directory 为空时 save/load/clear 全 no-op。"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ConfigRepositoryCache(tmp)
        assert store.save('u', 'text') is True
        store.clear()
        assert store.load() is None
        store.clear()                                    # 重复 clear 不抛
    empty = ConfigRepositoryCache('')
    assert empty.path == ''
    assert empty.save('u', 'text') is False
    assert empty.load() is None
    empty.clear()


def test_config_cache_save_failure_is_swallowed_as_false():
    """落盘期 OSError/TypeError 被收口成 False（缓存失败不得拖垮配置加载）。"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        store = ConfigRepositoryCache(tmp)
        with mock.patch('runtime.config_cache.tempfile.mkstemp',
                        side_effect=OSError('disk full')):
            assert store.save('u', 'text') is False
        unserializable = {'k': object()}
        with mock.patch('runtime.config_cache.json.dump',
                        side_effect=TypeError('not serializable')):
            assert store.save('u', 'text', documents=unserializable) is False


# ================================================================ ext_resolver


def test_ext_canonical_ext_covers_every_json_shape():
    """canonical_ext 的分支矩阵：None/bool/数字/整数浮点/对象/数组/未知类型。"""
    assert canonical_ext(None) == ''
    assert canonical_ext('') == ''
    assert canonical_ext('  pad  ') == 'pad'
    assert canonical_ext(True) == 'true' and canonical_ext(False) == 'false'
    assert canonical_ext(7) == '7'
    assert canonical_ext(7.0) == '7'                 # Gson 不补 .0
    assert canonical_ext(2.5) == '2.5'
    assert canonical_ext({'b': 1, 'a': 2}) == '{"b":1,"a":2}'
    assert canonical_ext([1, 'x']) == '[1,"x"]'
    assert canonical_ext(set()) == ''                # 未知类型兜底空串


def test_ext_kind_of_maps_raw_shape_to_kind_string():
    """_kind_of 私有分支：object/array/number/empty/json/text 六态。"""
    resolver = ExtResolver(cache=ExtCache())
    kind = ExtResolver._kind_of
    assert kind({'a': 1}, '') == 'object'
    assert kind([1], '') == 'array'
    assert kind(True, 'true') == 'number'
    assert kind(3, '3') == 'number'
    assert kind(None, '') == 'empty'
    assert kind('', '') == 'empty'
    assert kind('{"a":1}', '{"a":1}') == 'json'
    assert kind('[1]', '[1]') == 'json'
    assert kind('plain', 'plain') == 'text'
    assert resolver._kind_of('  [1]', '[1]') == 'json'   # lstrip 后才判首字符


def test_ext_resolve_relative_expands_nested_containers():
    """_resolve_relative 递归进 dict/list，非相对字符串原样返回。"""
    resolver = ExtResolver(cache=ExtCache())
    base = 'https://fixture.invalid/cfg/final.json'
    nested = resolver._resolve_relative({'a': './x.json', 'b': ['../y.json', 'abs']}, base)
    assert nested['a'] == 'https://fixture.invalid/cfg/x.json'
    assert nested['b'][0] == 'https://fixture.invalid/y.json'
    assert nested['b'][1] == 'abs'
    assert resolver._resolve_relative('./x.json', '') == './x.json'   # 无基址不解析
    assert resolver._resolve_relative(5, base) == 5                   # 非字符串透传


def test_ext_is_http_ext_matches_upstream_startswith_only():
    """is_http_ext 只认 http:// 与 https://（大小写不敏感），其余一律不展开。"""
    assert is_http_ext('https://a/b') is True
    assert is_http_ext('HTTP://a/b') is True
    assert is_http_ext('  http://a/b  ') is True
    for bad in ('ftp://a', 'file:///etc/passwd', '//a/b', 'javascript:alert(1)', '', None):
        assert is_http_ext(bad) is False


def test_ext_detect_text_residual_bom_is_stripped():
    """BOM 分支：utf-8-sig / utf-16 解码后再剥残留 U+FEFF（否则 json.loads 报 col 1）。"""
    assert detect_text(b'') == ('', 'utf-8')
    text, enc = detect_text(b'\xef\xbb\xbf{"a":1}')
    assert enc == 'utf-8-sig' and text == '{"a":1}' and not text.startswith('﻿')
    text16, enc16 = detect_text('﻿{"a":1}'.encode('utf-16'))
    assert enc16 == 'utf-16' and text16 == '{"a":1}'
    broken16 = b'\xff\xfe\x00\xd8\x00'
    assert detect_text(broken16)[1] in ('utf-16', 'utf-8/replace', 'utf-8')
    assert detect_text(b'\xff\xfe\xfe\xff\x00')[1] in ('utf-16', 'utf-8/replace', 'utf-8')


def test_ext_detect_text_declared_charset_then_fallback_chain():
    """声明 charset → utf-8 → gb18030 → replace 兜底；iso-8859-1 声明被忽略。"""
    gbk = '中文'.encode('gb18030')
    assert detect_text(gbk)[0] == '中文'
    assert detect_text(gbk, 'gbk')[1] == 'gbk'
    assert detect_text(gbk, 'iso-8859-1')[0] == '中文'      # 忽略该声明，走 utf-8→gb18030
    assert detect_text(b'\xff\xfe\xfd', 'no-such-codec')[1] == 'utf-8/replace'
    assert detect_text('{"a":1}'.encode('utf-8'), 'utf-8')[1] == 'utf-8'


def test_ext_cache_evicts_oldest_and_is_thread_safe():
    """ExtCache LRU：超出 max_entries 淘汰最旧；get 返回副本（防外部改内部）。"""
    cache = ExtCache(max_entries=2)
    cache.put('u1', text='a')
    cache.put('u2', text='b')
    assert cache.stats() == {'entries': 2}
    cache.put('u1', text='a2')                               # 已存在：不新增顺序位
    assert cache.stats() == {'entries': 2}
    cache.put('u3', text='c')
    assert cache.get('u1') == {}                             # 最旧被淘汰
    assert cache.get('u2')['text'] == 'b'
    snapshot = cache.get('u2')
    snapshot['text'] = 'tampered'
    assert cache.get('u2')['text'] == 'b'                    # get 返回副本
    cache.clear()
    assert cache.stats() == {'entries': 0}
    assert cache.get('missing') == {}

    shared = ExtCache(max_entries=64)
    barrier = threading.Barrier(8)

    def worker(idx):
        barrier.wait()
        for i in range(40):
            shared.put('k%d-%d' % (idx, i), text='v')

    ts = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(timeout=30)
    assert shared.stats()['entries'] <= 64


def test_ext_for_runtime_selects_expanded_only_for_js():
    """for_runtime 的契约分派：只有 js+展开成功才给 expanded，其余一律 canonical。"""
    resolved = ResolvedExt(canonical='https://a/ext.json', expanded='{"a":1}')
    assert resolved.expanded_ok is True
    assert resolved.for_runtime('js') == '{"a":1}'
    for runtime in ('python', 'jar', 'cms', '', 'js2'):
        assert resolved.for_runtime(runtime) == 'https://a/ext.json'
    failed = ResolvedExt(canonical='https://a/ext.json', expanded='', error='boom')
    assert failed.expanded_ok is False
    assert failed.for_runtime('js') == 'https://a/ext.json'    # 展开失败回退原 URL
    half = ResolvedExt(canonical='c', expanded='e', error='boom')
    assert half.expanded_ok is False                           # 有 error 即不算成功
    assert half.for_runtime('js') == 'c'


def test_ext_resolved_ext_to_dict_truncates_hash_and_redacts():
    """to_dict 只出前 16 位 hash、脱敏 URL，且仅在出错时附 error/errorReason。"""
    resolved = ResolvedExt(
        canonical='c', origin='https://a/ext.json?token=secret', url='https://a/ext.json?token=secret',
        expanded='{"a":1}', expanded_kind='json', hops=['https://a/ext.json?token=secret'],
        size=10, encoding='utf-8', etag='e', last_modified='m',
        content_hash='0' * 64, from_cache=True, elapsed_ms=3)
    payload = resolved.to_dict()
    assert payload['contentHash'] == '0' * 16
    assert 'secret' not in json.dumps(payload, ensure_ascii=False)
    assert payload['hops'] and 'secret' not in payload['hops'][0]
    assert 'error' not in payload
    resolved.error = 'token=secret'
    resolved.error_reason = 'fetch_failed'
    with_error = resolved.to_dict()
    assert with_error['errorReason'] == 'fetch_failed'
    assert 'secret' not in with_error['error']


def test_ext_resolver_resolve_never_expands_non_http_ext():
    """非 http 的 ext 不进 _expand：hops 为空、elapsed_ms 仍被计算。"""
    calls = []

    class _NoFetch:
        def __call__(self, *args, **kwargs):
            calls.append(args)
            raise AssertionError('非 http ext 不得发起请求')

    resolver = ExtResolver(cache=ExtCache(), session_get=_NoFetch())
    got = resolver.resolve('{"cate":"all"}')
    assert got.kind == 'json' and got.url == '' and got.hops == []
    assert calls == []
    assert got.elapsed_ms >= 0


def test_ext_resolver_expand_failure_is_recorded_not_raised():
    """站点级隔离：取回抛异常时写进 error/error_reason，不向上抛。"""
    def boom(_url, **_kw):
        raise ValueError('connection refused')

    resolver = ExtResolver(cache=ExtCache(), session_get=boom)
    got = resolver.resolve('https://fixture.invalid/ext.json')
    assert got.error == 'connection refused'
    assert got.error_reason == 'fetch_failed'
    assert got.canonical == 'https://fixture.invalid/ext.json'   # 原 URL 保留


def test_ext_resolver_security_error_keeps_upstream_reason():
    """ConfigSecurityError 的 reason 被透传（不是笼统的 fetch_failed）。"""
    from runtime.config_security import ConfigSecurityError

    def blocked(_url, **_kw):
        raise ConfigSecurityError('private_network_blocked', '内网被拒',
                                  code='L2_SITE_BLOCKED')

    resolver = ExtResolver(cache=ExtCache(), session_get=blocked)
    got = resolver.resolve('https://fixture.invalid/ext.json')
    assert got.error_reason == 'private_network_blocked'


def test_ext_resolver_deadline_overrun_is_reported_as_timeout():
    """预算耗尽：ExtTimeout 被转成 timeout 原因，且取消信号优先于一切。"""
    def slow(_url, **_kw):
        raise AssertionError('预算已耗尽，不应发起请求')

    resolver = ExtResolver(cache=ExtCache(), session_get=slow)
    got = resolver.resolve('https://fixture.invalid/ext.json',
                           deadline=time.monotonic() - 1)
    assert got.error_reason == 'timeout'

    cancelled = threading.Event()
    cancelled.set()
    resolver2 = ExtResolver(cache=ExtCache(), session_get=slow, cancel_event=cancelled)
    try:
        resolver2.resolve('https://fixture.invalid/ext.json')
    except ExtCancelled:
        pass
    else:
        raise AssertionError('取消信号必须一路上抛')


def test_ext_resolver_expands_single_hop_with_fake_session():
    """一次展开成功：写入 etag/encoding/hash/size，并回写缓存（session_get 全 mock）。"""
    cache = ExtCache()
    body = '{"cate":"all"}'

    class _Response:
        status_code = 200
        headers = {'Content-Type': 'application/json; charset=utf-8', 'ETag': 'W/"1"',
                   'Last-Modified': 'Wed, 21 Oct 2026 07:28:00 GMT'}
        url = 'https://fixture.invalid/ext.json'

        def iter_content(self, _size):
            yield body.encode('utf-8')

        def close(self):
            return None

    seen = {}

    def getter(url, **_kw):
        seen['url'] = url
        return _Response()

    resolver = ExtResolver(cache=cache, session_get=getter)
    got = resolver.resolve('https://fixture.invalid/ext.json')
    assert got.expanded == body
    assert got.expanded_kind == 'json'
    assert got.encoding == 'utf-8'
    assert got.etag == 'W/"1"'
    assert got.size == len(body)
    assert got.hops == ['https://fixture.invalid/ext.json']
    assert got.error == ''
    assert cache.get('https://fixture.invalid/ext.json')['text'] == body


def test_ext_resolver_conditional_headers_and_304_reuse():
    """第二次解析带 If-None-Match/If-Modified-Since；304 复用缓存正文。"""
    cache = ExtCache()
    cache.put('https://fixture.invalid/ext.json', text='cached', etag='W/"1"',
              last_modified='Wed, 21 Oct 2026 07:28:00 GMT')

    sent_headers = {}

    class _Response:
        status_code = 304
        headers = {}
        url = 'https://fixture.invalid/ext.json'

        def iter_content(self, _size):
            raise AssertionError('304 不应读 body')

        def close(self):
            return None

    def getter(_url, **kw):
        sent_headers.update(kw.get('headers') or {})
        return _Response()

    resolver = ExtResolver(cache=cache, session_get=getter)
    got = resolver.resolve('https://fixture.invalid/ext.json')
    assert sent_headers.get('If-None-Match') == 'W/"1"'
    assert sent_headers.get('If-Modified-Since') == 'Wed, 21 Oct 2026 07:28:00 GMT'
    assert got.expanded == 'cached'
    assert got.from_cache is True


def test_ext_resolver_redirect_is_followed_and_rechecked():
    """3xx + Location：递归 _fetch 到跳转目标，且目标同样要过安全边界。

    两段断言分别锁定：默认（真实守卫）下相对 Location 合成的同源地址被放行并
    真的多取一次；以及守卫拒绝时冒泡成站点级 fetch_failed（防 SSRF 借跳转绕过）。
    """
    seen = []

    def getter(url, **_kw):
        seen.append(url)
        if url.endswith('/start.json'):
            return _Response(status=302, headers={'Location': '/final/ext.json'}, url=url)
        return _Response(status=200, url=url, body=b'{"ok":1}')

    resolver = ExtResolver(cache=ExtCache(), session_get=getter)
    got = resolver.resolve('https://fixture.invalid/start.json')
    assert seen == ['https://fixture.invalid/start.json',
                    'https://fixture.invalid/final/ext.json']
    assert got.expanded == '{"ok":1}'
    assert got.expanded_kind == 'json'
    assert got.hops == ['https://fixture.invalid/start.json']   # 跳转不记 hop
    assert got.error == ''

    seen.clear()
    from runtime.config_security import ConfigSecurityError

    resolver2 = ExtResolver(cache=ExtCache(), session_get=getter)
    with mock.patch(
            'runtime.ext_resolver.guard_url',
            side_effect=ConfigSecurityError('loopback_blocked', 'ext 跳转目标被拒',
                                            code='L2_SITE_BLOCKED')):
        blocked = resolver2.resolve('https://fixture.invalid/start.json')
    assert blocked.error_reason == 'loopback_blocked'
    assert blocked.expanded == ''
    assert blocked.canonical == 'https://fixture.invalid/start.json'   # 保留原 URL


def test_ext_resolver_http_error_and_empty_response_branches():
    """HTTP >=400 记 error；空响应保留原 URL 且标 empty_response。"""
    class _Err:
        status_code = 500
        headers = {}
        url = 'https://fixture.invalid/ext.json'

        def iter_content(self, _size):
            yield b''

        def close(self):
            return None

    resolver = ExtResolver(cache=ExtCache(), session_get=lambda _u, **_k: _Err())
    got = resolver.resolve('https://fixture.invalid/ext.json')
    assert got.error == 'ext 地址返回 HTTP 500'
    assert got.error_reason == 'fetch_failed'

    class _Empty:
        status_code = 200
        headers = {}
        url = 'https://fixture.invalid/ext.json'

        def iter_content(self, _size):
            yield b'   '

        def close(self):
            return None

    resolver2 = ExtResolver(cache=ExtCache(), session_get=lambda _u, **_k: _Empty())
    got2 = resolver2.resolve('https://fixture.invalid/ext.json')
    assert got2.expanded == ''
    assert got2.error_reason == 'empty_response'
    assert got2.canonical == 'https://fixture.invalid/ext.json'


def test_ext_resolver_none_response_is_a_fetch_failure():
    """session_get 返回 None（无响应）被包成 ValueError → fetch_failed。"""
    resolver = ExtResolver(cache=ExtCache(), session_get=lambda _u, **_k: None)
    got = resolver.resolve('https://fixture.invalid/ext.json')
    assert got.error == 'ext 地址无响应'
    assert got.error_reason == 'fetch_failed'


def test_ext_resolver_timeout_defaults_are_shorter_than_config():
    """ext 的超时档（5,10）比配置拉取更短：单站点附属资源不拖住整次加载。"""
    assert EXT_TIMEOUT == (5, 10)
    assert isinstance(ExtTimeout(), TimeoutError)
    assert isinstance(ExtCancelled(), Exception)


# ================================================================ android_policy


def test_android_policy_matrix_and_ceiling_constants():
    """策略判定矩阵：SHIPPED=False → 任何 enabled/ready 组合都不可用。"""
    assert (SUPPORT_CEILING, ANDROID_WORKER_DECISION, ANDROID_WORKER_SHIPPED) == ('C1', 'NO_GO', False)
    for enabled in (True, False):
        for ready in (True, False):
            assert android_worker_available(enabled=enabled, ready=ready) is False
    assert android_worker_available() is False


def test_android_policy_details_expose_fallback_contract():
    """android_only_details 的诊断字段：天花板、决策、回落方式与用户动作。"""
    details = android_only_details()
    assert details['supportCeiling'] == SUPPORT_CEILING
    assert details['androidWorkerDecision'] == ANDROID_WORKER_DECISION
    assert details['androidWorkerShipped'] is False
    assert details['fallback'] == 'dex2jar/JVM'
    assert isinstance(details['userAction'], str) and details['userAction']
    assert android_only_details() is not details            # 每次新建，调用方可改


def test_android_policy_message_is_shared_with_error_catalog():
    """策略文案与错误目录同源：改一处两处同时生效（避免文案漂移）。"""
    assert ERROR_SPECS['L2_SITE_REQUIRES_ANDROID'][3] == ANDROID_ONLY_MESSAGE
    assert RuntimeError('L2_SITE_REQUIRES_ANDROID').message == ANDROID_ONLY_MESSAGE
    assert RuntimeError('L2_SITE_REQUIRES_ANDROID').http_status == 424


# ================================================================ worker_base


# worker_main 会无条件执行 os.environ['YUKI_RUNTIME_WORKER'] = '1'（runtime/worker_base.py:19），
# 本段 8 个用例都会触发。每个调用点用 mock.patch.dict(os.environ) 包裹，
# 失败路径也能自动还原（之前只有 1 个用例显式 pop 且清理位于断言之后，其余 7 个完全泄漏）。


def test_worker_base_sends_booted_then_ready_frames():
    """正常启动序列：booted → 等 start 栅栏 → ready（含 pid）。"""
    connection = _FakeConnection().push({'op': 'start'})
    spec = {'kind': 'fixture', 'site_key': 'demo'}
    with mock.patch.object(worker_base_mod, 'enter_worker_process_group'), \
            mock.patch.object(worker_base_mod, 'apply_worker_limits'), \
            mock.patch.object(worker_base_mod.os, 'getpid', return_value=4242), \
            mock.patch('runtime.site_worker.SiteRuntimeWorker') as worker_cls:
        worker_cls.return_value.last_error = ''
        with mock.patch.dict(os.environ, {}):
            worker_base_mod.worker_main(connection, spec, {})
            assert os.environ.get('YUKI_RUNTIME_WORKER') == '1'      # Worker 侧标记已置位
    frames = connection.frames()
    assert [frame['op'] for frame in frames] == ['booted', 'ready']
    assert frames[0]['ok'] is True and frames[0]['pid'] == 4242
    assert frames[1]['ok'] is True


def test_worker_base_unreleased_start_barrier_reports_protocol_error():
    """栅栏未释放（op != start）：发 ready 失败帧并关闭连接，不进入 Worker 构建。"""
    connection = _FakeConnection().push({'op': 'nope'})
    with mock.patch.object(worker_base_mod, 'enter_worker_process_group'), \
            mock.patch.object(worker_base_mod, 'apply_worker_limits'), \
            mock.patch('runtime.site_worker.SiteRuntimeWorker') as worker_cls:
        with mock.patch.dict(os.environ, {}):
            worker_base_mod.worker_main(connection, {'kind': 'fixture', 'site_key': 'demo'}, {})
        assert not worker_cls.called
    frames = connection.frames()
    assert frames[0]['op'] == 'booted'
    assert frames[1]['op'] == 'ready' and frames[1]['ok'] is False
    assert frames[1]['error']['code'] == 'L3_RUNTIME_PROTOCOL_ERROR'
    assert connection.closed is True


def test_worker_base_call_loop_dispatches_and_answers_shutdown():
    """call 帧分派：结果帧带 lastError；shutdown 帧终止循环并 destroy handler。"""
    connection = (_FakeConnection().push({'op': 'start'})
                  .push({'op': 'call', 'id': 'req-abcdefg-0001', 'method': 'homeContent',
                         'args': [False], 'request': {}})
                  .push({'op': 'shutdown'}))
    handler = mock.Mock()
    handler.call.return_value = {'list': []}
    handler.last_error = ''
    handler.destroy.return_value = None
    with mock.patch.object(worker_base_mod, 'enter_worker_process_group'), \
            mock.patch.object(worker_base_mod, 'apply_worker_limits'), \
            mock.patch('runtime.site_worker.SiteRuntimeWorker', return_value=handler):
        with mock.patch.dict(os.environ, {}):
            worker_base_mod.worker_main(connection, {'kind': 'fixture', 'site_key': 'demo'}, {})
    frames = connection.frames()
    assert [frame['op'] for frame in frames[:2]] == ['booted', 'ready']
    call_frame = frames[2]
    assert call_frame['id'] == 'req-abcdefg-0001'
    assert call_frame['ok'] is True
    assert call_frame['result'] == {'list': []}
    handler.call.assert_called_once_with('homeContent', [False], {})
    handler.destroy.assert_called_once()
    assert connection.closed is True


def test_worker_base_unknown_op_is_reported_per_frame_and_loop_continues():
    """未知 op：逐帧回协议错误（带 id），循环不中断，后续 call 仍可服务。"""
    connection = (_FakeConnection().push({'op': 'start'})
                  .push({'op': 'wat', 'id': 'req-badop-0001'})
                  .push({'op': 'shutdown'}))
    handler = mock.Mock()
    handler.last_error = ''
    with mock.patch.object(worker_base_mod, 'enter_worker_process_group'), \
            mock.patch.object(worker_base_mod, 'apply_worker_limits'), \
            mock.patch('runtime.site_worker.SiteRuntimeWorker', return_value=handler):
        with mock.patch.dict(os.environ, {}):
            worker_base_mod.worker_main(connection, {'kind': 'fixture'}, {})
    frames = connection.frames()
    bad = frames[2]
    assert bad['ok'] is False and bad['id'] == 'req-badop-0001'
    assert bad['error']['code'] == 'L3_RUNTIME_PROTOCOL_ERROR'
    assert not handler.call.called


def test_worker_base_handler_exception_is_mapped_per_call():
    """call 抛异常：走 handler.map_error 归一，帧里带 error 与 lastError。"""
    connection = (_FakeConnection().push({'op': 'start'})
                  .push({'op': 'call', 'id': 'req-abcdefg-0002', 'method': 'playerContent',
                         'args': [], 'request': {'site_key': 'demo'}})
                  .push({'op': 'shutdown'}))
    handler = mock.Mock()
    handler.call.side_effect = ValueError('spider exploded')
    handler.last_error = 'spider exploded'
    handler.map_error.return_value = RuntimeError('L3_RUNTIME_CALL_FAILED',
                                                  raw_error='spider exploded')
    with mock.patch.object(worker_base_mod, 'enter_worker_process_group'), \
            mock.patch.object(worker_base_mod, 'apply_worker_limits'), \
            mock.patch('runtime.site_worker.SiteRuntimeWorker', return_value=handler):
        with mock.patch.dict(os.environ, {}):
            worker_base_mod.worker_main(connection, {'kind': 'fixture', 'site_key': 'demo'}, {})
    frame = connection.frames()[2]
    assert frame['ok'] is False
    assert frame['id'] == 'req-abcdefg-0002'
    assert frame['error']['code'] == 'L3_RUNTIME_CALL_FAILED'
    assert frame['lastError'] == 'spider exploded'
    handler.map_error.assert_called_once()


def test_worker_base_non_exception_base_exception_propagates():
    """BaseException（非 Exception）不映射：直接向上抛（如 SystemExit/KeyboardInterrupt）。"""
    connection = (_FakeConnection().push({'op': 'start'})
                  .push({'op': 'call', 'id': 'req-abcdefg-0003', 'method': 'homeContent',
                         'args': [], 'request': {}}))
    handler = mock.Mock()
    handler.call.side_effect = KeyboardInterrupt('interrupted')
    with mock.patch.object(worker_base_mod, 'enter_worker_process_group'), \
            mock.patch.object(worker_base_mod, 'apply_worker_limits'), \
            mock.patch('runtime.site_worker.SiteRuntimeWorker', return_value=handler):
        try:
            with mock.patch.dict(os.environ, {}):
                worker_base_mod.worker_main(connection, {'kind': 'fixture'}, {})
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError('BaseException 被吞掉了')
    handler.destroy.assert_called_once()             # finally 仍收口销毁
    assert connection.closed is True


def test_worker_base_broken_pipe_ends_loop_silently():
    """对端断开（EOFError/BrokenPipeError/OSError）：静默退出循环并销毁 handler。"""
    for exc in (EOFError('closed'), BrokenPipeError('pipe'), OSError('handle')):
        connection = _FakeConnection().push({'op': 'start'})
        handler = mock.Mock()
        handler.last_error = ''
        handler.recv_guard = None
        with mock.patch.object(worker_base_mod, 'enter_worker_process_group'), \
                mock.patch.object(worker_base_mod, 'apply_worker_limits'), \
                mock.patch('runtime.site_worker.SiteRuntimeWorker', return_value=handler), \
                mock.patch.object(worker_base_mod, 'recv_json', side_effect=[{'op': 'start'}, exc]):
            with mock.patch.dict(os.environ, {}):
                worker_base_mod.worker_main(connection, {'kind': 'fixture'}, {})
        handler.destroy.assert_called_once()
        assert connection.closed is True


def test_worker_base_boot_failure_survives_unwritable_connection():
    """启动失败 + 连接已断：两层 try/except 都不让异常逃出 worker 入口。"""
    class _Dead(_FakeConnection):
        def send_bytes(self, raw):
            raise BrokenPipeError('gone')

    dead = _Dead()
    with mock.patch.object(worker_base_mod, 'enter_worker_process_group'), \
            mock.patch.object(worker_base_mod, 'apply_worker_limits'), \
            mock.patch.object(worker_base_mod, 'recv_json', side_effect=OSError('no peer')):
        with mock.patch.dict(os.environ, {}):
            worker_base_mod.worker_main(dead, {'kind': 'fixture', 'site_key': 'demo'}, {})
    assert dead.closed is True


# ================================================================ process_transport


def test_transport_encode_value_covers_all_supported_shapes():
    """encode_value 的类型分派：标量直传、bytes 打标、list/tuple/dict 递归。"""
    assert encode_value(None) is None
    assert encode_value(True) is True
    assert encode_value(3) == 3 and encode_value(2.5) == 2.5
    assert encode_value('x') == 'x'
    assert encode_value(b'hi') == {'__yuki_bytes__': 'aGk='}
    assert encode_value((1, 2)) == [1, 2]
    assert encode_value([1, [2, b'x']]) == [1, [2, {'__yuki_bytes__': 'eA=='}]]
    assert encode_value({1: 'a', 'k': b'\x00'}) == {'1': 'a', 'k': {'__yuki_bytes__': 'AA=='}}


def test_transport_encode_value_rejects_unserializable_types():
    """不可序列化类型抛 TypeError 并带上类型名（不放任 json.dumps 抛更难懂的错）。"""
    for bad in (object(), {1, 2}, io.BytesIO()):
        try:
            encode_value(bad)
        except TypeError as exc:
            assert 'not JSON serializable' in str(exc)
            assert type(bad).__name__ in str(exc)
        else:
            raise AssertionError('%r 未被拒绝' % type(bad))


def test_transport_decode_value_inverts_encode_for_bytes_marker():
    """decode_value 只在**恰好**只有标记键时还原 bytes：附加字段视为普通 dict。"""
    assert decode_value({'__yuki_bytes__': 'aGk='}) == b'hi'
    assert decode_value({'__yuki_bytes__': ''}) == b''
    mixed = {'__yuki_bytes__': 'aGk=', 'extra': 1}
    assert decode_value(mixed) == {'__yuki_bytes__': 'aGk=', 'extra': 1}
    assert decode_value([{'__yuki_bytes__': 'aGk='}]) == [b'hi']
    assert decode_value({'a': {'__yuki_bytes__': 'aGk='}}) == {'a': b'hi'}
    # validate=False 但仍要求长度是 4 的倍数：非法的 9 字符载荷会抛 binascii.Error
    try:
        decode_value({'__yuki_bytes__': '!!!not-base64!!!'})
    except Exception as exc:
        assert 'Invalid base64' in str(exc)
    else:
        raise AssertionError('非法 base64 未被拒绝')
    assert decode_value({'__yuki_bytes__': None}) == b''        # 空标记还原成空字节
    assert decode_value('plain') == 'plain'


def test_transport_send_json_rejects_oversized_frames():
    """帧体积闸门：超过 MAX_FRAME_BYTES 直接 ValueError，不许半帧上连接。"""
    assert MAX_FRAME_BYTES == 16 * 1024 * 1024
    connection = _FakeConnection()
    with mock.patch.object(transport_mod, 'MAX_FRAME_BYTES', 32):
        try:
            send_json(connection, {'blob': 'x' * 1024})
        except ValueError as exc:
            assert 'exceeds' in str(exc)
        else:
            raise AssertionError('超上限帧被放行')
    assert connection.sent == []                      # 未写出任何字节
    send_json(connection, {'ok': 1})
    assert len(connection.sent) == 1


def test_transport_recv_json_roundtrip_and_broken_pipe():
    """recv_json 走 decode 路径：能还原 bytes 帧；连接已断时抛 BrokenPipeError。"""
    connection = _FakeConnection()
    connection.push(send_json_frame({'a': [1, b'\x01\x02'], 'b': '中文'}))
    assert recv_json(connection) == {'a': [1, b'\x01\x02'], 'b': '中文'}
    try:
        recv_json(connection)
    except EOFError:
        pass
    else:
        raise AssertionError('空队列未抛 EOFError')
    dead = _FakeConnection()
    dead.close()
    try:
        send_json(dead, {'a': 1})
    except BrokenPipeError:
        pass
    else:
        raise AssertionError('已关闭连接未报错')
    assert recv_json(_FakeConnection().push({'op': 'shutdown'})) == {'op': 'shutdown'}


def test_transport_apply_worker_limits_is_noop_on_windows_or_zero():
    """apply_worker_limits：Windows 直接返回；非 Windows 且未配置也返回（不 import resource）。"""
    assert os.name == 'nt'
    with mock.patch.object(transport_mod, 'resource', create=True) as resource:
        apply_worker_limits({})
        apply_worker_limits({'memory_limit_mb': 0})
        apply_worker_limits(None)
        apply_worker_limits({'memory_limit_mb': 256})
        assert not resource.setrlimit.called


def test_transport_apply_worker_limits_sets_rlimit_off_windows():
    """非 Windows 且配置了内存上限：按字节设置 RLIMIT_AS，异常被吞。"""
    fake_resource = mock.Mock()
    fake_resource.RLIMIT_AS = 9
    with mock.patch.object(transport_mod.os, 'name', 'posix'), \
            mock.patch.dict(sys.modules, {'resource': fake_resource}):
        apply_worker_limits({'memory_limit_mb': 128})
        fake_resource.setrlimit.assert_called_once_with(9, (128 * 1024 * 1024,) * 2)
        fake_resource.setrlimit.side_effect = OSError('not permitted')
        apply_worker_limits({'memory_limit_mb': 128})        # 异常被吞，不冒泡


def test_transport_enter_worker_process_group_setsid_off_windows():
    """非 Windows 调 setsid；OSError 被吞。Windows 上是 no-op。"""
    with mock.patch.object(transport_mod, 'os') as fake_os:
        fake_os.name = 'posix'
        fake_os.setsid = mock.Mock()
        enter_worker_process_group()
        fake_os.setsid.assert_called_once_with()
        fake_os.setsid.side_effect = OSError('already a leader')
        enter_worker_process_group()                          # 不冒泡
    enter_worker_process_group()                              # Windows：无 setsid 也不报错


def test_transport_terminate_process_tree_handles_none_process():
    """terminate_process_tree(None) 视为成功（无进程可杀）。"""
    assert terminate_process_tree(None) is True


def test_transport_terminate_process_tree_closes_job_first():
    """带 Job Object：先 close job，再短暂 join；进程已退出即返回 True。"""
    process = mock.Mock()
    process.is_alive.return_value = False
    job = mock.Mock()
    assert terminate_process_tree(process, timeout=1.0, job=job) is True
    job.close.assert_called_once()
    process.kill.assert_not_called()


def test_transport_terminate_process_tree_falls_back_to_kill_when_job_fails():
    """Job close 抛异常：回落到 kill 路径，并保证返回进程存活状态的否定。"""
    process = mock.Mock()
    process.pid = 4321
    process.is_alive.return_value = True
    job = mock.Mock()
    job.close.side_effect = OSError('job gone')
    with mock.patch.object(transport_mod.subprocess, 'run') as run:
        assert terminate_process_tree(process, timeout=1.0, job=job) is False
        run.assert_called_once()
        args = run.call_args[0][0]
        assert args[0] == 'taskkill' and str(4321) in args
    process.kill.assert_called()


def test_transport_terminate_process_tree_taskkill_failure_falls_back_to_kill():
    """taskkill 抛异常（如命令缺失）：回落到 process.kill()。"""
    process = mock.Mock()
    process.pid = 999
    process.is_alive.return_value = True
    with mock.patch.object(transport_mod.subprocess, 'run',
                           side_effect=FileNotFoundError('no taskkill')):
        assert terminate_process_tree(process, timeout=1.0) is False
    assert process.kill.called
    process.join.assert_called()


def test_transport_terminate_process_tree_without_pid_only_joins():
    """无 pid（尚未 spawn 成功）：不调 taskkill，仅 join 并按存活状态返回。"""
    process = mock.Mock()
    process.pid = None
    process.is_alive.return_value = False
    with mock.patch.object(transport_mod.subprocess, 'run') as run:
        assert terminate_process_tree(process, timeout=0.5) is True
        assert not run.called
    process.kill.assert_not_called()


def test_transport_windows_job_close_is_idempotent():
    """WindowsJob.close 幂等：第二次 close 不再触碰句柄（句柄已置 None）。"""
    job = WindowsJob.__new__(WindowsJob)          # 绕过真实 Win32 调用
    job.handle = 12345
    with mock.patch.object(transport_mod, 'os') as fake_os:
        fake_os.name = 'nt'
        fake_kernel = mock.Mock()
        with mock.patch('ctypes.WinDLL', return_value=fake_kernel):
            job.close()
            job.close()
        assert job.handle is None
        assert fake_kernel.CloseHandle.call_count == 1
        fake_os.name = 'posix'
        job.handle = 999
        job.close()                                  # 非 nt：只清句柄不调内核
        assert job.handle is None
        assert fake_kernel.CloseHandle.call_count == 1


def test_transport_windows_job_is_noop_off_windows():
    """非 Windows：__init__ 立刻返回，句柄保持 None，不触碰任何 Win32 API。"""
    with mock.patch.object(transport_mod, 'os') as fake_os, \
            mock.patch('ctypes.WinDLL') as windll:
        fake_os.name = 'posix'
        job = WindowsJob(1234, memory_limit_mb=128)
        assert job.handle is None
        assert not windll.called
        job.close()                                  # 空句柄 close 安全
        assert job.handle is None


def test_transport_windows_job_creation_failure_raises_oserror():
    """CreateJobObjectW 失败：抛 OSError，句柄不泄漏（Windows 本机真实路径）。"""
    if os.name != 'nt':
        return
    with mock.patch('ctypes.WinDLL') as windll:
        windll.return_value.CreateJobObjectW.return_value = None
        try:
            WindowsJob(0)
        except OSError as exc:
            assert 'CreateJobObjectW' in str(exc)
        else:
            raise AssertionError('CreateJobObjectW 失败未报错')


def test_transport_windows_job_sets_memory_limit_flag():
    """memory_limit_mb>0 时置 PROCESS_MEMORY(0x100) 标志与字节上限；0 时不置。

    内核 DLL 全 mock：只断言写入 Job Object 的 LimitFlags/ProcessMemoryLimit。
    """
    if os.name != 'nt':
        return
    captured = []

    def make_kernel():
        kernel = mock.Mock()
        kernel.CreateJobObjectW = mock.Mock(return_value=1)
        kernel.CreateJobObjectW.restype = None
        kernel.OpenProcess = mock.Mock(return_value=2)
        kernel.OpenProcess.restype = None
        kernel.SetInformationJobObject = mock.Mock(return_value=1)
        kernel.AssignProcessToJobObject = mock.Mock(return_value=1)
        kernel.CloseHandle = mock.Mock(return_value=1)

        def capture(_job, info_class, byref_limits, _size):
            captured.append((info_class, byref_limits._obj))
            return 1
        kernel.SetInformationJobObject.side_effect = capture
        return kernel

    with mock.patch('ctypes.WinDLL', side_effect=lambda *_a, **_k: make_kernel()):
        job = WindowsJob(111, memory_limit_mb=64)
        assert job.handle == 1
        info_class, limits = captured[-1]
        assert info_class == 9                                       # JobObjectExtendedLimitInformation
        assert limits.BasicLimitInformation.LimitFlags & 0x00002000  # KILL_ON_JOB_CLOSE
        assert limits.BasicLimitInformation.LimitFlags & 0x00000100  # PROCESS_MEMORY
        assert limits.ProcessMemoryLimit == 64 * 1024 * 1024

        WindowsJob(222, memory_limit_mb=0)
        _, limits_zero = captured[-1]
        assert not limits_zero.BasicLimitInformation.LimitFlags & 0x00000100
        assert limits_zero.ProcessMemoryLimit == 0

        WindowsJob(333, memory_limit_mb=-5)                          # 负值钳制为 0
        _, limits_neg = captured[-1]
        assert limits_neg.ProcessMemoryLimit == 0


# ================================================================ runner


def _cases():
    """收集本模块全部 test_* 用例，按定义顺序返回。"""
    module = sys.modules[__name__]
    names = [name for name in dir(module) if name.startswith('test_')]
    return [(name, getattr(module, name)) for name in sorted(names)]


if __name__ == '__main__':
    passed, failed = [], []
    for name, func in _cases():
        try:
            func()
        except Exception as exc:                                  # noqa: BLE001
            failed.append((name, repr(exc)))
            print('FAIL %s: %r' % (name, exc))
        else:
            passed.append(name)
            print('ok   %s' % name)
    print('\n%d passed, %d failed, %d total' % (len(passed), len(failed), len(passed) + len(failed)))
    if failed:
        for name, reason in failed:
            print('  - %s: %s' % (name, reason))
        sys.exit(1)
    sys.exit(0)
