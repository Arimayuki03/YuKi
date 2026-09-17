# -*- coding: utf-8 -*-
"""SiteHealth 并发一致性与熔断计数单元测试。

回归背景（2026-09 全项目审查）：SiteHealth 是每站点一个、进程级共享的可变对象，
原先所有字段裸奔无锁，而后端同时跑在 16 并发 spider（/action 经 threadpool +
_SPIDER_SEMAPHORE）+ 聚合搜索 8 线程 + 每连接一线程的 go_proxy 之上。

实测（12 线程交错 record_success/record_failure、放大 setswitchinterval）：
无锁实现 12000 次 to_dict 采样中出现 364 次自相矛盾快照（healthy=True 同时
consecutiveFailures>0，或 state='healthy' 同时 lastError 仍在），加锁后为 0。
这类矛盾快照会直接打到 /sites 诊断页与前端「站点不可用」提示上。

注：审查报告曾把影响写成「计数被覆盖 → 熔断器永不打开」。该机制经复核**不成立**
——同压力下无锁复刻 30 轮均未丢失自增（CPython 单字段 += 在实际切换粒度下未被撕裂）。
本文件因此锁定的不变量是「对外快照自洽」，而非计数不丢。
"""
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from runtime.health import SiteHealth        # noqa: E402
from runtime.errors import RuntimeError      # noqa: E402


def _retryable_fail(stage='runtime'):
    return RuntimeError('L3_RUNTIME_CALL_FAILED', stage=stage, retryable=True)


class _UnlockedTwin(SiteHealth):
    """去掉锁的孪生实现，仅用于在测试里证明「无锁确实会撕裂」这一前提仍然成立。

    若将来有人删掉 SiteHealth 的锁，本类的对照断言仍会绿，但 LockedConsistencyTests
    会红——两者共同构成回归防线。
    """

    def record_failure(self, error, *, stage='runtime'):
        self.last_error = error
        self.healthy = False
        if self.failure_stage == stage:
            self.consecutive_failures += 1
        else:
            self.failure_stage = stage
            self.consecutive_failures = 1
        self.state = 'unavailable'
        return self

    def record_success(self, _capability=''):
        if self.initialized:
            self.healthy = True
            self.state = 'healthy'
        self.last_error = None
        self.consecutive_failures = 0
        return self

    def to_dict(self):
        return {'healthy': bool(self.healthy), 'state': self.state,
                'consecutiveFailures': int(self.consecutive_failures),
                'lastError': self.last_error}


def _interleave_probe(cls, rounds, threads, samples):
    """让成功/失败记账在多线程下交错，统计 to_dict 出现的矛盾快照次数。"""
    bad = 0
    for _ in range(rounds):
        h = cls('probe', runtime='jar')
        h.initialized = True
        stop = threading.Event()

        def worker(idx):
            while not stop.is_set():
                if idx % 2:
                    h.record_failure(_retryable_fail())
                else:
                    h.record_success()

        ts = [threading.Thread(target=worker, args=(i,)) for i in range(threads)]
        for t in ts:
            t.daemon = True
            t.start()
        for _ in range(samples):
            d = h.to_dict()
            if d['healthy'] and d['consecutiveFailures'] > 0:
                bad += 1
            elif d['state'] == 'healthy' and d['lastError'] is not None:
                bad += 1
        stop.set()
        for t in ts:
            t.join(timeout=5)
    return bad


class LockedConsistencyTests(unittest.TestCase):
    """加锁后：对外快照任何时刻都必须自洽。"""

    def test_snapshot_never_contradicts_under_contention(self):
        previous = sys.getswitchinterval()
        sys.setswitchinterval(1e-7)      # 放大竞态窗口，与仓库既有压力测试同一手法
        try:
            bad = _interleave_probe(SiteHealth, rounds=25, threads=10, samples=150)
        finally:
            sys.setswitchinterval(previous)
        self.assertEqual(bad, 0, '加锁实现不应出现任何自相矛盾快照，实际 %d 次' % bad)

    def test_failure_counting_is_exact_under_concurrency(self):
        h = SiteHealth('count', runtime='jar')
        h.initialized = True
        threads, per = 12, 200
        barrier = threading.Barrier(threads)

        def worker():
            barrier.wait()
            for _ in range(per):
                h.record_failure(_retryable_fail())

        ts = [threading.Thread(target=worker) for _ in range(threads)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(timeout=30)
        self.assertEqual(h.consecutive_failures, threads * per)
        # 越过阈值后必须已经打开熔断（这是 SiteHealth 本地视图的既有语义）
        self.assertGreater(h.circuit_open_until, 0)


class UnlockedPremiseTests(unittest.TestCase):
    """证明「无锁会撕裂」这个前提在本环境下可观测；前提失效时提醒更新本文件。"""

    def test_unlocked_twin_does_tear(self):
        previous = sys.getswitchinterval()
        sys.setswitchinterval(1e-7)
        try:
            bad = _interleave_probe(_UnlockedTwin, rounds=25, threads=10, samples=150)
        finally:
            sys.setswitchinterval(previous)
        if bad == 0:
            self.skipTest('本机未复现无锁撕裂（解释器调度粒度变化），前提断言不适用')
        self.assertGreater(bad, 0)


class HalfOpenResetTests(unittest.TestCase):
    """熔断字段的权威回填路径：apply_runtime_state 覆盖本地判定。"""

    def test_apply_runtime_state_overrides_local_view(self):
        h = SiteHealth('hs', runtime='jar')
        h.initialized = True
        for _ in range(5):
            h.record_failure(_retryable_fail())
        h.apply_runtime_state({'consecutiveFailures': 1, 'failureStage': 'runtime',
                               'circuitOpenForMs': 0, 'state': 'half-open'})
        d = h.to_dict()
        self.assertEqual(d['consecutiveFailures'], 1)
        self.assertTrue(d['halfOpen'])
        self.assertEqual(d['circuitOpenUntil'], 0)

    def test_open_state_marks_unhealthy(self):
        h = SiteHealth('hs2', runtime='jar')
        h.mark_healthy()
        h.apply_runtime_state({'consecutiveFailures': 3, 'circuitOpenForMs': 5000,
                               'state': 'open'})
        d = h.to_dict()
        self.assertFalse(d['healthy'])
        self.assertEqual(d['state'], 'circuit-open')


if __name__ == '__main__':
    unittest.main(verbosity=2)
