# -*- coding: utf-8 -*-
"""CircuitBreaker 熔断语义单元测试（重点：半开探测被取消后的恢复行为）。

回归背景：半开探测被取消（用户切分类中止在途请求）曾把熔断重新拉开满
open_seconds，快速连续切换分类导致站点在浏览期间始终不可用。
"""
import os
import sys
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


if __name__ == '__main__':
    unittest.main()
