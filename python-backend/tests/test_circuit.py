# -*- coding: utf-8 -*-
"""CircuitBreaker 熔断语义单元测试（重点：半开探测被取消后的恢复行为）。

回归背景：半开探测被取消（用户切分类中止在途请求）曾把熔断重新拉开满
open_seconds，快速连续切换分类导致站点在浏览期间始终不可用。
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from runtime.circuit import CircuitBreaker
from runtime.errors import RuntimeError


def _fail(code='L3_RUNTIME_CALL_FAILED', stage='runtime'):
    return RuntimeError(code, stage=stage)


class CircuitBreakerTests(unittest.TestCase):

    def test_opens_after_threshold_and_blocks(self):
        breaker = CircuitBreaker(failure_threshold=3, open_seconds=60)
        for _ in range(3):
            breaker.before_call()
            breaker.record_failure(_fail())
        with self.assertRaises(RuntimeError) as ctx:
            breaker.before_call()
        self.assertEqual(ctx.exception.code, 'L3_RUNTIME_CIRCUIT_OPEN')
        self.assertGreater(ctx.exception.details.get('retryAfterMs', 0), 0)

    def test_success_resets(self):
        breaker = CircuitBreaker(failure_threshold=3, open_seconds=60)
        for _ in range(2):
            breaker.record_failure(_fail())
        breaker.record_success()
        for _ in range(2):
            breaker.record_failure(_fail())
        breaker.before_call()  # 未达阈值：不阻断
        self.assertEqual(breaker.snapshot()['state'], 'closed')

    def test_cancelled_in_half_open_does_not_extend_full_window(self):
        """取消探测回到 open 但保持原 _open_until：下一个请求立即成为新探测。"""
        breaker = CircuitBreaker(failure_threshold=1, open_seconds=60)
        breaker.record_failure(_fail())  # 达阈值 → open
        # 等过开放窗口（用极小窗口模拟过期）
        breaker = CircuitBreaker(failure_threshold=1, open_seconds=0.01)
        breaker.record_failure(_fail())
        import time
        time.sleep(0.02)
        # 进入半开（单个探测放行）
        breaker.before_call()
        self.assertTrue(breaker.snapshot()['halfOpenInFlight'])
        # 探测被取消：不得重新计满 60s/0.01s 之外的完整开放时间
        breaker.record_failure(RuntimeError('L3_RUNTIME_CANCELLED'))
        snap = breaker.snapshot()
        self.assertEqual(snap['state'], 'half-open')  # 过期 open 在快照中即视为半开
        self.assertFalse(snap['halfOpenInFlight'])
        # 下一个调用立即成为新的半开探测（不被阻断）
        breaker.before_call()

    def test_cancelled_outside_half_open_is_noop(self):
        breaker = CircuitBreaker(failure_threshold=3, open_seconds=60)
        breaker.record_failure(RuntimeError('L3_RUNTIME_CANCELLED'))
        self.assertEqual(breaker.snapshot()['state'], 'closed')
        self.assertEqual(breaker.snapshot()['consecutiveFailures'], 0)

    def test_non_retryable_blocks_permanently(self):
        breaker = CircuitBreaker(failure_threshold=3, open_seconds=60)
        breaker.record_failure(RuntimeError('L3_RUNTIME_CREDENTIALS_REQUIRED'))
        with self.assertRaises(RuntimeError) as ctx:
            breaker.before_call()
        self.assertEqual(ctx.exception.code, 'L3_RUNTIME_CREDENTIALS_REQUIRED')


class HalfOpenFailureTests(unittest.TestCase):
    """半开探测**失败**（非取消）后的退避长度。

    回归背景（2026-09 全项目审查）：原实现把「半开失败」和「连续失败达阈值」写在
    同一个分支里，一律重置为满 open_seconds。于是慢源的真实路径是：
    3 次失败 → 冻 60s → 放行 1 个探测 → 探测又偶发超时 → 再冻 60s ……
    与上面 test_cancelled_in_half_open 刻意避免的「无限延长」是同一类缺陷，
    却与自己的取消分支语义自相矛盾。现在半开失败只用一段短退避。
    """

    def _to_half_open(self, open_seconds=60.0):
        """把熔断器推进到「半开探测进行中」，不做任何真实等待。

        先正常触发一次 open，再手工把窗口挪到已过期——避免为了测 5s vs 60s 而真睡
        几十秒（本文件此前 80s 的运行时长全烧在 sleep 上）。
        """
        breaker = CircuitBreaker(failure_threshold=1, open_seconds=open_seconds)
        breaker.record_failure(_fail())
        breaker._open_until = time.monotonic() - 1     # 视作已过开放时间
        breaker.before_call()                          # 放行半开探测
        self.assertEqual(breaker.snapshot()['state'], 'half-open')
        return breaker

    def test_half_open_failure_backs_off_shorter_than_full_window(self):
        breaker = self._to_half_open(open_seconds=60.0)
        breaker.record_failure(_fail())
        with self.assertRaises(RuntimeError) as ctx:
            breaker.before_call()
        retry_ms = ctx.exception.details.get('retryAfterMs', 0)
        # 满窗口是 60000ms；半开失败必须显著短于此
        self.assertGreater(retry_ms, 0)
        self.assertLess(retry_ms, 60000,
                        '半开探测失败被冻了完整 open_seconds（回归）：%dms' % retry_ms)
        self.assertLessEqual(retry_ms, int(breaker.half_open_backoff_seconds * 1000) + 50)

    def test_half_open_failure_still_opens_state(self):
        """短退避不等于放过失败：状态仍须回到 open 并阻断后续调用。"""
        breaker = self._to_half_open(open_seconds=60.0)
        breaker.record_failure(_fail())
        self.assertEqual(breaker.snapshot()['state'], 'open')

    def test_threshold_failures_still_use_full_window(self):
        """只有「半开探测」这一条路径缩短；常规达阈值仍是满 open_seconds。"""
        breaker = CircuitBreaker(failure_threshold=3, open_seconds=60)
        for _ in range(3):
            breaker.record_failure(_fail())
        self.assertEqual(breaker.snapshot()['state'], 'open')
        with self.assertRaises(RuntimeError) as ctx:
            breaker.before_call()
        self.assertGreater(ctx.exception.details.get('retryAfterMs', 0), 55000)

    def test_backoff_default_and_override(self):
        self.assertEqual(CircuitBreaker(open_seconds=60).half_open_backoff_seconds, 5.0)
        self.assertEqual(CircuitBreaker(open_seconds=60, half_open_backoff_seconds=1).half_open_backoff_seconds, 1.0)
        # 显式给一个比开放窗口还长的退避没有意义，钳制到 open_seconds
        self.assertEqual(CircuitBreaker(open_seconds=2, half_open_backoff_seconds=99).half_open_backoff_seconds, 2.0)


if __name__ == '__main__':
    unittest.main()
