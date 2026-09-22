# -*- coding: utf-8 -*-
"""进程隔离、绝对 deadline、强制终止、重启与熔断。"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import asdict, dataclass
import atexit
import logging
import multiprocessing
import os
import threading
import time
import weakref

from .circuit import CircuitBreaker
from .contracts import RuntimeRequest, current_runtime_request
from .errors import RuntimeError
from .process_transport import WindowsJob, recv_json, send_json, terminate_process_tree
from .worker_base import worker_main

logger = logging.getLogger('yuki.runtime.supervisor')


@dataclass(frozen=True)
class RuntimePolicy:
    memory_limit_mb: int = 256
    max_concurrency: int = 1
    max_queue: int = 8
    failure_threshold: int = 3
    circuit_open_seconds: float = 60.0
    shutdown_grace_seconds: float = 0.5


RUNTIME_POLICIES = {
    'python': RuntimePolicy(memory_limit_mb=256, max_queue=8),
    'js': RuntimePolicy(memory_limit_mb=256, max_queue=8),
    # HotSpot 启动时会按系统内存预留较大的地址空间；512 MiB Job 限额会让
    # `java -version` 本身启动失败。1.5 GiB 仍是硬上限，同时可运行常见 JAR。
    'jar': RuntimePolicy(memory_limit_mb=1536, max_queue=16),
    'cms': RuntimePolicy(memory_limit_mb=192, max_queue=8),
    'fixture': RuntimePolicy(memory_limit_mb=192, max_queue=16),
}

_registry_lock = threading.RLock()
_registry = weakref.WeakSet()

# 全局 Worker 进程数限制：配置多仓/多站点并发构建时无上限会同时拉起数十个
# Python 子进程（每个站点一个 Supervisor）+ 若为 jar 则再派生 JVM，内存暴涨。
# 默认总 Worker 8、其中 jar 最多 3，可用环境变量覆盖。
# 值必须是**弱引用**：_registry 用 WeakSet 表达「Supervisor 无人引用即可回收」，
# 若这里持强引用，每个建过的 Supervisor 都会泄漏到进程退出（destroy 只是忘了
# 从本表摘除时也无法靠 GC 兜底）。存活判定统一走弱引用解引用 + pid 检查。
_GLOBAL_LRU: 'OrderedDict[int, weakref.ref]' = OrderedDict()
_MAX_WORKERS_DEFAULT = 8
_MAX_JAR_WORKERS_DEFAULT = 3


def _max_workers() -> int:
    raw = os.environ.get('YUKI_MAX_WORKERS') or os.environ.get('YUKI_MAX_PYTHON_WORKERS')
    if raw:
        try:
            v = int(str(raw).strip())
            return max(1, min(16, v))
        except (TypeError, ValueError):
            pass
    return _MAX_WORKERS_DEFAULT


def _max_jar_workers() -> int:
    raw = os.environ.get('YUKI_MAX_JAR_WORKERS') or os.environ.get('YUKI_MAX_JVM')
    if raw:
        try:
            v = int(str(raw).strip())
            return max(1, min(8, v))
        except (TypeError, ValueError):
            pass
    return _MAX_JAR_WORKERS_DEFAULT


def _touch_global(sup) -> None:
    with _registry_lock:
        k = id(sup)
        if k in _GLOBAL_LRU:
            ref = _GLOBAL_LRU[k]
            # 仅当槽位仍指向同一对象时才算命中（id 复用防护）
            if ref is not None and ref() is sup:
                _GLOBAL_LRU.move_to_end(k)
                return
        _GLOBAL_LRU[k] = weakref.ref(sup)


def _remove_global(sup) -> None:
    with _registry_lock:
        _GLOBAL_LRU.pop(id(sup), None)


def _ensure_global_slot_locked(caller) -> tuple[object, bool]:
    """在全局上限内为 caller 预留进程槽；返回 ``(victim, own_lock)``。

    需淘汰时返回 victim；``own_lock=True`` 表示 caller 已获得 victim._call_lock
    的**占用权**（未释放），必须在完成销毁后调用 ``_release_victim_lock(victim)``
    归还。须在 caller._lifecycle_lock 已持有且未持有 _registry_lock 时调用；内部
    会短暂持有 _registry_lock 判断并挑选 victim，但不直接销毁（避免在
    _registry_lock 内重入 victim._lifecycle_lock 造成死锁或 ~1s 阻塞）。
    """
    limit_total = _max_workers()
    limit_jar = _max_jar_workers()
    with _registry_lock:
        # 刷新 caller 在 LRU 中的位置（即使尚未有 pid，也占位以保证公平）
        k = id(caller)
        ref = _GLOBAL_LRU.get(k)
        if ref is not None and ref() is caller:
            _GLOBAL_LRU.move_to_end(k)
        else:
            _GLOBAL_LRU[k] = weakref.ref(caller)
        # caller 已有存活进程则无需预留
        if caller.pid is not None:
            return None, False
        total = sum(1 for s in list(_registry) if s.pid is not None)
        jar_total = sum(1 for s in list(_registry) if getattr(s, 'runtime', None) == 'jar' and s.pid is not None)
        need_total = total >= limit_total
        need_jar = caller.runtime == 'jar' and jar_total >= limit_jar
        if not (need_total or need_jar):
            return None, False
        reason = 'total %d/%d' % (total, limit_total) if need_total else 'jar %d/%d' % (jar_total, limit_jar)
        logger.warning('global worker limit reached (%s), evicting LRU idle worker caller=%s',
                       reason, caller.site_key)
        # 从最久未用方向遍历，挑一个空闲（无 active_request 且 _call_lock 可非阻塞获取）的
        # jar 上限触达时必须淘汰同为 jar 的空闲 Worker，淘汰 python 不能释放 jar 配额。
        # 遍历必须**有界**：对快照做 for 循环，任何不合格的 victim 只被跳过不被重扫。
        # 不可改成「while + 永远取队头」——pid is None / 运行时不匹配 / 正忙的条目会被
        # 无限重看，持有 _registry_lock 死循环，全进程挂死（审查 C-1 回归）。
        required_runtime = 'jar' if need_jar else None
        for vk, ref in list(_GLOBAL_LRU.items()):
            sup = ref() if ref is not None else None
            if sup is None:
                # 弱引用已失效（Supervisor 被 GC）：清掉空壳槽位
                _GLOBAL_LRU.pop(vk, None)
                continue
            if sup is caller:
                # caller 已在函数入口被 move_to_end 到队尾，快照中本就是最后一项；
                # 这里再提升一次（保持既有设计），然后跳过——caller 不淘汰自己
                _GLOBAL_LRU.move_to_end(vk)
                continue
            if sup.pid is None:
                continue
            if required_runtime is not None and getattr(sup, 'runtime', None) != required_runtime:
                continue
            # 跳过正忙的（有在途请求或 call 锁被占用）
            try:
                if getattr(sup, '_active_request', None) is not None:
                    continue
            except Exception:
                continue
            lock = getattr(sup, '_call_lock', None)
            if lock is not None and not lock.acquire(blocking=False):
                continue
            # 找到可淘汰的空闲 victim：从 LRU 摘除并连同其 _call_lock 占用权一起
            # 返回。锁**不再释放**——它是防淘汰竞态的令牌：victim 的 call() 拿不到
            # _call_lock 就无法送出新的 `call` 帧，直到我们完成销毁。调用方负责
            # 销毁后经 _release_victim_lock 归还。
            _GLOBAL_LRU.pop(vk, None)
            return sup, True
        # 无一可淘汰——池已耗尽且全忙，拒绝而非无限排队
        raise RuntimeError(
            'L3_RUNTIME_BUSY',
            site_key=getattr(caller, 'site_key', ''),
            runtime=getattr(caller, 'runtime', ''),
            raw_error='global worker pool exhausted (all workers busy)',
        )


def _release_victim_lock(victim) -> None:
    """淘汰完成后归还 victim._call_lock 的占用权（见 _ensure_global_slot_locked）。"""
    try:
        victim._call_lock.release()
    except Exception:
        pass


def active_supervisors():
    with _registry_lock:
        return [item for item in list(_registry)
                if not item.destroyed or item.pid is not None]


def destroy_all_supervisors():
    for supervisor in active_supervisors():
        try:
            supervisor.destroy()
        except Exception:
            pass


class RuntimeSupervisor:
    """一个串行 Worker 的监督边界。

    所有平台显式使用 ``spawn``，避免开发机上的 fork 行为掩盖 Windows
    打包问题。队列槽、调用锁、启动握手和响应等待共享同一个绝对预算。
    """

    def __init__(self, spec, policy=None):
        self.spec = dict(spec or {})
        self.runtime = str(self.spec.get('kind') or 'python')
        self.site_key = str(self.spec.get('site_key') or '')
        self.policy = policy or RUNTIME_POLICIES.get(self.runtime, RuntimePolicy())
        self._ctx = multiprocessing.get_context('spawn')
        self._process = None
        self._connection = None
        self._job = None
        self._generation = 0
        self._destroyed = False
        # 杀不掉的 Worker 进程树 pid + 句柄。pid 非 None 即表示本 Supervisor 已无法
        # 安全重启该 Worker，后续调用快速失败并计入熔断（见 _start_locked）；句柄留给
        # destroy()/atexit 做最后一次回收。
        self._unreapable_pid = None
        self._unreapable_proc = None
        self._lifecycle_lock = threading.RLock()
        self._call_lock = threading.Lock()
        capacity = max(1, self.policy.max_concurrency + self.policy.max_queue)
        self._slots = threading.BoundedSemaphore(capacity)
        self._active_request = None
        self._active_lock = threading.RLock()
        self._active_done = threading.Event()
        self._active_done.set()
        self._circuit = CircuitBreaker(
            self.policy.failure_threshold,
            self.policy.circuit_open_seconds,
        )
        with _registry_lock:
            _registry.add(self)

    @property
    def destroyed(self):
        return self._destroyed

    @property
    def pid(self):
        process = self._process
        return process.pid if process is not None and process.is_alive() else None

    @staticmethod
    def _deadline(request):
        return time.monotonic() + max(0.001, request.remaining_ms / 1000.0)

    @staticmethod
    def _remaining(deadline):
        return max(0.0, deadline - time.monotonic())

    @classmethod
    def _acquire_until(cls, gate, deadline, request):
        """等待队列/串行槽时持续观察取消，且等待计入绝对 deadline。"""
        while True:
            request.raise_if_cancelled()
            remaining = cls._remaining(deadline)
            if remaining <= 0:
                return False
            if gate.acquire(timeout=min(0.05, remaining)):
                return True

    def _request(self, method, request=None):
        request = request or current_runtime_request()
        if request is not None:
            return request
        return RuntimeRequest.create(site_key=self.site_key, method=method)

    def _start_locked(self, deadline):
        if self._destroyed:
            raise RuntimeError('L3_RUNTIME_RESTARTED', site_key=self.site_key,
                               runtime=self.runtime, raw_error='supervisor destroyed')
        if self._unreapable_pid is not None:
            # 上一次回收就没成功：再开一个 Worker 只会与残留进程争同一份站点资源，
            # 且旧进程仍占着全局槽位。快速失败（retryable → 计入熔断，坏站点自动降温），
            # 而不是每次都重试杀同一个杀不掉的进程。重建 Supervisor（重载配置/重启应用）
            # 会清掉本标记。
            raise RuntimeError(
                'L3_RUNTIME_CRASHED', site_key=self.site_key, runtime=self.runtime,
                raw_error='previous worker pid %s could not be terminated' % self._unreapable_pid)
        if self._process is not None and self._process.is_alive() and self._connection is not None:
            _touch_global(self)
            return
        # 全局进程数限流：超限时先淘汰最久未用的空闲 Worker（LRU）
        victim = None
        try:
            victim, victim_locked = _ensure_global_slot_locked(self)
        except RuntimeError:
            raise
        if victim is not None:
            # victim._call_lock 已由本线程占用（own 锁语义）：新请求在此排队，
            # 不会在「空闲判定之后、销毁完成之前」的窗口里给 victim 送 call 帧，
            # 从而避免刚接请求的 Worker 被杀、请求误报 L3_RUNTIME_CRASHED。
            logger.info('evicting idle worker %s (%s) pid=%s to free global slot for %s',
                        victim.site_key, victim.runtime, victim.pid, self.site_key)
            try:
                with victim._lifecycle_lock:
                    victim._dispose_locked(kill=True)
            except Exception:
                pass
            with _registry_lock:
                _GLOBAL_LRU.pop(id(victim), None)
            _release_victim_lock(victim)
        self._dispose_locked(kill=True)
        parent, child = self._ctx.Pipe(duplex=True)
        process = self._ctx.Process(
            target=worker_main,
            args=(child, self.spec, asdict(self.policy)),
            name='yuki-%s-%s' % (self.runtime, self.site_key or 'worker'),
            daemon=False,
        )
        process.start()
        child.close()
        self._process = process
        self._connection = parent
        self._generation += 1
        try:
            # worker_main first reports ``booted`` and then blocks. No site
            # module, QuickJS program or JVM may be initialized before this
            # parent has attached the process to its kill-on-close Job.
            while self._remaining(deadline) > 0:
                if parent.poll(min(0.05, self._remaining(deadline))):
                    message = recv_json(parent)
                    if message.get('op') != 'booted' or not message.get('ok'):
                        raise RuntimeError(
                            'L3_RUNTIME_PROTOCOL_ERROR', site_key=self.site_key,
                            runtime=self.runtime,
                            raw_error='worker did not stop at startup barrier')
                    break
                if not process.is_alive():
                    raise RuntimeError(
                        'L3_RUNTIME_CRASHED', site_key=self.site_key,
                        runtime=self.runtime,
                        raw_error='worker exited before startup barrier: %s' % process.exitcode)
            else:
                raise RuntimeError(
                    'L3_RUNTIME_TIMEOUT', site_key=self.site_key,
                    runtime=self.runtime,
                    raw_error='worker startup barrier deadline exceeded')

            job = WindowsJob(process.pid, self.policy.memory_limit_mb)
            if os.name == 'nt' and not job.handle:
                raise OSError('Windows Job Object has no handle')
            self._job = job
            send_json(parent, {'op': 'start'})
        except RuntimeError:
            self._dispose_locked(kill=True)
            raise
        except Exception as exc:
            self._dispose_locked(kill=True)
            raise RuntimeError(
                'L3_RUNTIME_INIT_FAILED', site_key=self.site_key,
                runtime=self.runtime,
                raw_error='worker process boundary setup failed: %s' % exc) from exc
        while self._remaining(deadline) > 0:
            if parent.poll(min(0.05, self._remaining(deadline))):
                try:
                    message = recv_json(parent)
                except (EOFError, OSError, ValueError) as exc:
                    self._dispose_locked(kill=True)
                    raise RuntimeError(
                        'L3_RUNTIME_CRASHED', site_key=self.site_key,
                        runtime=self.runtime, raw_error=str(exc)) from exc
                if message.get('op') != 'ready' or not message.get('ok'):
                    error = RuntimeError.from_dict(
                        message.get('error'), fallback_code='L3_RUNTIME_INIT_FAILED')
                    error.site_key = error.site_key or self.site_key
                    error.runtime = error.runtime or self.runtime
                    self._dispose_locked(kill=True)
                    raise error
                return
            if not process.is_alive():
                code = process.exitcode
                self._dispose_locked(kill=True)
                raise RuntimeError(
                    'L3_RUNTIME_CRASHED', site_key=self.site_key,
                    runtime=self.runtime, raw_error='worker exited during startup: %s' % code)
        self._dispose_locked(kill=True)
        raise RuntimeError('L3_RUNTIME_TIMEOUT', site_key=self.site_key,
                           runtime=self.runtime, raw_error='worker startup deadline exceeded')

    def _dispose_locked(self, kill=False):
        connection, process, job = self._connection, self._process, self._job
        self._connection = None
        self._process = None
        self._job = None
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        terminated = True
        if process is not None:
            if kill or process.is_alive():
                terminated = terminate_process_tree(process, job=job)
            else:
                if job is not None:
                    job.close()
                try:
                    process.join(timeout=0.2)
                except Exception:
                    pass
        if not terminated:
            # 原实现在这里把杀不掉的 process 重新塞回 self._process，好「保留可观察
            # 句柄」。但 self._connection 已被摘除并 close，于是下一次 call() 走
            # _start_locked 时命中不了「process + connection 都健康」的早退分支，会
            # 再调一次 _dispose_locked(kill=True) 去杀同一个僵尸——每次请求都重付一遍
            # taskkill/join 的代价且永远杀不掉，该 Supervisor 因此进入不可恢复的活锁
            # （Windows 上 Job Object attach 失败或进程受保护时就会走到这里）。
            # 改为挪到独立字段：请求路径快速失败（_start_locked），但句柄不丢，
            # destroy()/atexit 仍有一次最后的回收机会（否则就是纯进程泄漏）。
            self._unreapable_pid = getattr(process, 'pid', None)
            self._unreapable_proc = process
            logger.critical('worker process tree did not terminate site=%s pid=%s',
                            self.site_key, self._unreapable_pid)
        return terminated

    def _hard_stop(self):
        with self._lifecycle_lock:
            return self._dispose_locked(kill=True)

    def _terminate_worker_only(self):
        """Kill the process tree without closing a concurrently-polled pipe.

        Windows ``Connection.poll`` uses overlapped I/O. Closing that handle
        from a cancellation/shutdown thread can leave an operation in flight
        at interpreter finalization. Job close wakes the polling call via EOF;
        the owning call thread then disposes its own connection safely.
        """
        with self._lifecycle_lock:
            process, job = self._process, self._job
            self._job = None
            return terminate_process_tree(process, job=job)

    def _timeout_error(self, request, raw='runtime deadline exceeded'):
        code = 'L2_SITE_TIMEOUT' if request.method == 'init' else 'L3_RUNTIME_TIMEOUT'
        return RuntimeError(
            code, site_key=self.site_key, runtime=self.runtime,
            request_id=request.request_id, play_session_id=request.play_session_id,
            raw_error=raw,
        )

    def call(self, method, args=None, request=None):
        request = self._request(method, request)
        deadline = self._deadline(request)
        if not self._acquire_until(self._slots, deadline, request):
            error = self._timeout_error(request, 'deadline expired in supervisor queue')
            # queued 标记：从未被准入执行，熔断不把排队超时计为站点失败
            error.details = dict(error.details or {}, queued=True)
            self._circuit.record_failure(error)
            raise error
        acquired_call = False
        try:
            request.raise_if_cancelled()
            acquired_call = self._acquire_until(self._call_lock, deadline, request)
            if not acquired_call:
                error = self._timeout_error(request, 'deadline expired waiting for worker slot')
                # queued 标记：同上，等待调用锁的阶段仍未被准入执行
                error.details = dict(error.details or {}, queued=True)
                self._circuit.record_failure(error)
                raise error
            request.raise_if_cancelled()
            self._circuit.before_call()
            try:
                with self._lifecycle_lock:
                    self._start_locked(deadline)
                    connection = self._connection
                    process = self._process
                    generation = self._generation
                    try:
                        send_json(connection, {
                            'op': 'call',
                            'id': request.request_id,
                            'method': method,
                            'args': list(args or []),
                            'request': {
                                **request.to_dict(),
                                'method': method,
                                'remainingMs': max(1, int(self._remaining(deadline) * 1000)),
                            },
                        })
                    except Exception as exc:
                        self._dispose_locked(kill=True)
                        error = RuntimeError(
                            'L3_RUNTIME_RESTARTED', site_key=self.site_key,
                            runtime=self.runtime, request_id=request.request_id,
                            raw_error=str(exc))
                        self._circuit.record_failure(error)
                        raise error from exc
            except RuntimeError as exc:
                # 全局池耗尽（L3_RUNTIME_BUSY）需计入熔断，避免无限重试
                if getattr(exc, 'code', None) == 'L3_RUNTIME_BUSY':
                    try:
                        self._circuit.record_failure(exc)
                    except Exception:
                        pass
                raise
            with self._active_lock:
                self._active_request = request
                self._active_done.clear()
            while self._remaining(deadline) > 0:
                try:
                    request.raise_if_cancelled()
                except RuntimeError as error:
                    self._hard_stop()
                    self._circuit.record_failure(error)
                    raise
                if process is None or not process.is_alive():
                    self._hard_stop()
                    error = RuntimeError(
                        ('L3_RUNTIME_RESTARTED' if self._destroyed
                         else 'L3_RUNTIME_CRASHED'), site_key=self.site_key,
                        runtime=self.runtime, request_id=request.request_id,
                        play_session_id=request.play_session_id,
                        raw_error='worker exited with code %s' % getattr(process, 'exitcode', None),
                    )
                    self._circuit.record_failure(error)
                    raise error
                try:
                    readable = connection.poll(
                        min(0.05, self._remaining(deadline)))
                except (EOFError, OSError, ValueError) as exc:
                    self._hard_stop()
                    error = RuntimeError(
                        ('L3_RUNTIME_RESTARTED' if self._destroyed
                         else 'L3_RUNTIME_CRASHED'),
                        site_key=self.site_key, runtime=self.runtime,
                        request_id=request.request_id, raw_error=str(exc))
                    self._circuit.record_failure(error)
                    raise error from exc
                if readable:
                    try:
                        message = recv_json(connection)
                    except (EOFError, OSError, ValueError) as exc:
                        self._hard_stop()
                        error = RuntimeError(
                            ('L3_RUNTIME_RESTARTED' if self._destroyed
                             else 'L3_RUNTIME_CRASHED'),
                            site_key=self.site_key,
                            runtime=self.runtime, request_id=request.request_id,
                            raw_error=str(exc))
                        self._circuit.record_failure(error)
                        raise error from exc
                    if generation != self._generation or message.get('id') != request.request_id:
                        self._hard_stop()
                        error = RuntimeError(
                            'L3_RUNTIME_PROTOCOL_ERROR', site_key=self.site_key,
                            runtime=self.runtime, request_id=request.request_id,
                            raw_error='mismatched worker response')
                        self._circuit.record_failure(error)
                        raise error
                    if not message.get('ok'):
                        error = RuntimeError.from_dict(message.get('error'))
                        error.with_request(request)
                        error.site_key = error.site_key or self.site_key
                        error.runtime = error.runtime or self.runtime
                        if error.code in ('L3_RUNTIME_TIMEOUT', 'L2_SITE_TIMEOUT'):
                            self._hard_stop()
                        self._circuit.record_failure(error)
                        raise error
                    self._circuit.record_success()
                    _touch_global(self)
                    return message.get('result'), str(message.get('lastError') or '')
            self._hard_stop()
            # 预算耗尽发生在「call 帧已发出、等待响应」的阶段：请求已被准入，
            # 属于真实执行超时，不加 queued 标记（熔断照常计数）。
            error = self._timeout_error(request)
            self._circuit.record_failure(error)
            raise error
        finally:
            with self._active_lock:
                if self._active_request is request:
                    self._active_request = None
                    self._active_done.set()
            if acquired_call:
                self._call_lock.release()
            self._slots.release()

    def cancel_active(self, reason='cancelled'):
        return self.cancel_request('', reason)

    def cancel_request(self, request_id, reason='cancelled'):
        """只终止匹配请求；空 request_id 保留显式“取消当前任务”语义。"""
        with self._active_lock:
            request = self._active_request
            matched = request is not None and (
                not request_id or request.request_id == str(request_id))
            if matched:
                request.cancel(reason)
        if matched:
            terminated = self._terminate_worker_only()
            self._active_done.wait(timeout=max(
                0.2, self.policy.shutdown_grace_seconds + 1.0))
            return terminated
        return False

    def force_half_open(self):
        self._circuit.force_half_open()

    def snapshot(self):
        state = self._circuit.snapshot()
        state.update({
            'runtime': self.runtime,
            'siteKey': self.site_key,
            'pid': self.pid,
            'generation': self._generation,
            'destroyed': self._destroyed,
            # 诊断页据此解释「该站点为什么所有请求秒失败」：残留进程 pid
            'unreapablePid': self._unreapable_pid,
        })
        return state

    def destroy(self):
        process = None
        active = False
        with self._lifecycle_lock:
            if self._destroyed and (
                    self._process is None or not self._process.is_alive()) \
                    and self._unreapable_proc is None:
                # 仍要放行一次：_unreapable_proc 非空说明还有颗没杀掉的进程要收，
                # 直接 return 就等于把它彻底泄漏了
                return
            self._destroyed = True
            connection, process = self._connection, self._process
            with self._active_lock:
                active = self._active_request is not None
            if (not active and connection is not None and process is not None
                    and process.is_alive()):
                try:
                    send_json(connection, {'op': 'shutdown'})
                except Exception:
                    pass
        if process is not None and process.is_alive() and not active:
            try:
                process.join(timeout=self.policy.shutdown_grace_seconds)
            except Exception:
                pass
        if process is not None and process.is_alive():
            self._terminate_worker_only()
            self._active_done.wait(timeout=max(
                0.2, self.policy.shutdown_grace_seconds + 1.0))
        with self._lifecycle_lock:
            self._dispose_locked(kill=True)
            # 最后一次回收没杀掉的进程树（请求路径已因 _unreapable_pid 快速失败，
            # 只有这里还会再试一遍；atexit 走的正是本函数，不给它机会就是纯泄漏）
            straggler = self._unreapable_proc
            if straggler is not None:
                self._unreapable_proc = None
                reaped = False
                try:
                    reaped = terminate_process_tree(straggler, job=self._job)
                except Exception:
                    reaped = False
                if reaped:
                    logger.info('unreapable worker pid %s reaped at destroy site=%s',
                                self._unreapable_pid, self.site_key)
                    self._unreapable_pid = None
                else:
                    logger.warning(
                        'worker pid %s still alive at destroy site=%s（需人工介入或重启系统）',
                        getattr(straggler, 'pid', None), self.site_key)
        with _registry_lock:
            _registry.discard(self)
        _remove_global(self)


atexit.register(destroy_all_supervisors)
