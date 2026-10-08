# -*- coding: utf-8 -*-
"""B-11 Worker 预热回归：调度、节流、失败静默与空配置零预热。

预热实现（runtime/warmup.py）在配置恢复完成后对前 N 个健康站点串行发空
homeContent，提前付掉 Worker spawn + boot 的冷启动成本。本套件验证：
1. 配置恢复完成后预热被调度（mock runner 计数）；
2. N 上限与低并发节流（串行：顺序 + 间隔断言）；
3. 预热失败静默不抛；
4. 空配置/无可用源零预热。
"""
from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from unittest import mock

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import hoststate  # noqa: E402
from runtime import warmup  # noqa: E402
from runtime.health import SiteHealth  # noqa: E402
from site_manager import Site, SiteManager  # noqa: E402


def _site(key, *, healthy=True, hide=False, searchable=True, filterable=True):
    site = Site(key, 'api-' + key)
    site.display_name = key
    site.spider_type = 'py'
    site.hide = hide
    site.searchable = searchable
    site.filterable = filterable
    site.health = SiteHealth(key)
    if healthy:
        site.health.mark_built().mark_initialized().mark_healthy()
    # 候选过滤要求 runner 就位且 homeContent 可调；默认挂记录型假 runner
    site.runner = _RecordingRunner()
    return site


class _RecordingRunner:
    """记录 _invoke 调用（方法/参数/时刻/线程）的假 runner。

    预热走 bind_runtime_request(request) + runner._invoke('homeContent', False)，
    与真实请求同一调用链；测试只关心「被调了 homeContent、什么时候、在哪个
    线程」以及绑进的请求预算。
    """

    def __init__(self, gate=None, error=None, delay=0.0):
        self.calls = []
        self.gate = gate            # threading.Event：置位前阻塞，测并发语义
        self.error = error          # 注入异常，测失败静默
        self.delay = delay

    def _invoke(self, method, *args, request=None):
        from runtime.contracts import current_runtime_request
        self.calls.append({
            'method': method,
            'args': args,
            'time': time.monotonic(),
            'thread': threading.current_thread().name,
            'bound_request': current_runtime_request(),
        })
        if self.gate is not None:
            self.gate.wait(timeout=5)
        if self.delay:
            time.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return {'list': []}

    def homeContent(self, filter=False):
        return self._invoke('homeContent', filter)


class _WarmupEnvPinned:
    """钉住 YUKI_WARMUP_SITES：setUp 移除外部注入值，用例结束恢复原值。

    本文件用例均按默认 N=warmup.DEFAULT_WARMUP_SITES（3）的语义断言；外部
    注入（如 run_all.py 注入 YUKI_WARMUP_SITES='0'）会让读该变量的用例失败
    （_warmup_candidates/schedule_warmup 在 N<=0 时直接短路），且整文件字母
    序下仅靠前排用例 finally 里的 pop 侥幸兜底——单独跑某个类即炸。统一钉
    住后单跑/整跑行为一致。需要自设该变量的用例（override/0 关闭用例）仍可
    照常在用例体内 set/pop，与钉住互不影响（cleanup 恢复的是 setUp 时的值）。
    """

    def setUp(self):
        saved = os.environ.pop('YUKI_WARMUP_SITES', None)
        if saved is None:
            self.addCleanup(os.environ.pop, 'YUKI_WARMUP_SITES', None)
        else:
            self.addCleanup(os.environ.__setitem__, 'YUKI_WARMUP_SITES', saved)
        super().setUp()


class WarmupCandidatesTest(_WarmupEnvPinned, unittest.TestCase):
    """候选挑选：前 N 个健康站点 + hide/不健康/纯播放源过滤。"""

    def _manager(self, *sites):
        mgr = SiteManager()
        mgr.sites = list(sites)
        return mgr

    def test_picks_first_n_healthy_sites_in_order(self):
        sites = self._manager(_site('a'), _site('b'), _site('c'), _site('d'))
        picked = warmup._warmup_candidates(sites)
        self.assertEqual([s.key for s in picked], ['a', 'b', 'c'])

    def test_respects_env_override_and_zero_disables(self):
        sites = self._manager(_site('a'), _site('b'))
        try:
            os.environ['YUKI_WARMUP_SITES'] = '0'
            self.assertEqual(warmup._warmup_candidates(sites), [])
            self.assertFalse(warmup.schedule_warmup(sites))
            os.environ['YUKI_WARMUP_SITES'] = '1'
            picked = warmup._warmup_candidates(sites)
            self.assertEqual([s.key for s in picked], ['a'])
        finally:
            os.environ.pop('YUKI_WARMUP_SITES', None)
            self.assertEqual(warmup.warmup_site_count(), warmup.DEFAULT_WARMUP_SITES)

    def test_skips_unhealthy_hidden_and_non_browsable(self):
        sites = self._manager(
            _site('dead', healthy=False),
            _site('hidden', hide=True),
            _site('playonly', searchable=False, filterable=False),
            _site('ok'),
        )
        picked = warmup._warmup_candidates(sites)
        self.assertEqual([s.key for s in picked], ['ok'])

    def test_bad_env_falls_back_to_default(self):
        try:
            os.environ['YUKI_WARMUP_SITES'] = 'not-a-number'
            self.assertEqual(warmup.warmup_site_count(), warmup.DEFAULT_WARMUP_SITES)
            os.environ['YUKI_WARMUP_SITES'] = '99'
            # 上限钉在 8（全局 worker 上限之内）
            self.assertEqual(warmup.warmup_site_count(), 8)
        finally:
            os.environ.pop('YUKI_WARMUP_SITES', None)


class WarmupSchedulingTest(_WarmupEnvPinned, unittest.TestCase):
    """配置恢复完成 → 预热被调度（mock runner 计数 + 调用线程）。"""

    def setUp(self):
        super().setUp()  # _WarmupEnvPinned：先钉住 YUKI_WARMUP_SITES
        os.makedirs(ROOT, exist_ok=True)
        hoststate.configure(
            data_dir=os.path.join(ROOT, 'warmup-data'),
            cache_dir=os.path.join(ROOT, 'warmup-cache'),
            plugins_dir=os.path.join(ROOT, 'warmup-cache', 'py'),
            port=18660,
            token='warmup-test',
        )
        hoststate.ensure_dirs()

    def tearDown(self):
        # schedule_warmup 的在途去重标记（L7）是模块级状态：本套件用例或者把
        # 清除留给尚在 sleep 的后台线程，或者线程被 mock 掉根本不会清除。不清
        # 会把「已调度」状态泄漏给后续用例（字母序整跑时 WarmupEmptyConfigTest
        # 的零预热断言会先撞上）。这里无条件清空。
        with warmup._pending_lock:
            warmup._pending_warmups.clear()

    def test_warmup_sites_invokes_home_content_on_n_sites(self):
        mgr = SiteManager()
        mgr.sites = [_site('a'), _site('b'), _site('c'), _site('d')]
        runners = {}
        for site in mgr.sites:
            runner = _RecordingRunner()
            site.runner = runner
            runners[site.key] = runner
        done = warmup.warmup_sites(mgr, count=3, site_gap=0.0)
        self.assertEqual(done, 3)
        for key in ('a', 'b', 'c'):
            self.assertEqual(
                [c['method'] for c in runners[key].calls], ['homeContent'])
        self.assertEqual(runners['d'].calls, [])

    def test_schedule_warmup_runs_in_background_thread_after_delay(self):
        mgr = SiteManager()
        site = _site('bg')
        runner = _RecordingRunner()
        site.runner = runner
        mgr.sites = [site]
        # 预热线程须 daemon 化（进程退出不被它拖住）
        default_delay = warmup.START_DELAY_SECONDS
        try:
            warmup.START_DELAY_SECONDS = 0.05
            started = warmup.schedule_warmup(mgr, delay=0.05)
        finally:
            warmup.START_DELAY_SECONDS = default_delay
        self.assertTrue(started)
        deadline = time.monotonic() + 5
        while not runner.calls and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual([c['method'] for c in runner.calls], ['homeContent'])
        self.assertEqual(runner.calls[0]['thread'], 'yuki-worker-warmup')

    def test_each_source_uses_dedicated_deadline_budget(self):
        """预热请求必须带自己的短预算：拖死源不该占满默认 15s homeContent。"""
        mgr = SiteManager()
        site = _site('slow')
        runner = site.runner  # _site() 默认挂好的记录型假 runner
        mgr.sites = [site]
        warmup.warmup_sites(mgr, count=1, site_gap=0.0)
        self.assertEqual([c['method'] for c in runner.calls], ['homeContent'])
        # bind_runtime_request 绑进的请求须携带预热专用预算
        bound = runner.calls[0]['bound_request']
        self.assertIsNotNone(bound)
        self.assertEqual(bound.deadline_ms, warmup.WARMUP_DEADLINE_MS)
        self.assertEqual(bound.site_key, 'slow')

    def test_schedule_warmup_dedupes_inflight_site_set(self):
        """L7：同一站点集合在途期间重复调度被忽略，执行完成后可再次调度。"""
        mgr = SiteManager()
        gate = threading.Event()
        site = _site('dedup')
        runner = _RecordingRunner(gate=gate)
        site.runner = runner
        mgr.sites = [site]
        self.assertTrue(warmup.schedule_warmup(mgr, delay=0),
                        '首次调度应启动线程')
        deadline = time.monotonic() + 5
        while not runner.calls and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(runner.calls, '预热线程应已开始执行')
        # 线程仍在 gate 上阻塞（预热未完成）：重复调用必须被去重忽略
        self.assertFalse(warmup.schedule_warmup(mgr, delay=0),
                         '在途期间重复调度应返回 False')
        self.assertEqual(len(runner.calls), 1, '去重后不得堆叠第二次预热')
        gate.set()  # 放行，让预热完成并在 finally 清除在途标记
        deadline = time.monotonic() + 5
        while warmup._pending_warmups and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(warmup._pending_warmups, {}, '执行完成后应清除在途标记')
        # 同一集合对象此时可再次调度（新的预热轮次，如配置重载后的正常重预热）
        self.assertTrue(warmup.schedule_warmup(mgr, delay=0),
                        '在途标记清除后同一集合应可再次调度')
        deadline = time.monotonic() + 5
        while len(runner.calls) < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(runner.calls), 2)

    def test_schedule_warmup_different_site_set_not_deduped(self):
        """去重键是站点集合对象身份：新集合对象（热重载后的新配置）正常调度。"""
        first = SiteManager()
        first_site = _site('one')
        first_site.runner = _RecordingRunner()
        first.sites = [first_site]
        second = SiteManager()
        second_site = _site('two')
        second_site.runner = _RecordingRunner()
        second.sites = [second_site]
        self.assertTrue(warmup.schedule_warmup(first, delay=30))
        self.assertTrue(warmup.schedule_warmup(second, delay=0),
                        '不同集合对象不应被在途标记误伤')

    def test_probe_timeout_does_not_trip_circuit_or_kill_worker(self):
        """M2 回归：预热（probe）超时既不杀热 worker，也不给熔断记账。

        预热与真实请求走同一 Supervisor.call 链——慢源 homeContent 天然超过
        预热预算，若超时照真实请求记账，N 次配置重载就把站点熔断 60s，真实
        请求反被 L3_RUNTIME_CIRCUIT_OPEN 拒绝，预热反转成「主动制造故障」。

        首次调用预算 5000ms（本套件惯例）：须覆盖 spawn+boot 冷启动，确保
        超时发生在 Worker 侧真实执行阶段而非启动屏障（启动屏障超时照旧杀
        Worker——半启动的 Worker 无法安全保留，这与 M2 无冲突）。
        threshold=1：probe 超时只要记账一次就会打开熔断，断言更强。
        """
        from runtime.contracts import RuntimeRequest
        from runtime.errors import RuntimeError as RuntimeFailure
        from runtime.supervisor import RuntimePolicy, RuntimeSupervisor

        def _make_sup(site_key):
            return RuntimeSupervisor(
                {'kind': 'fixture', 'site_key': site_key, 'behavior': 'infinite'},
                policy=RuntimePolicy(
                    memory_limit_mb=192, max_concurrency=1, max_queue=2,
                    failure_threshold=1, circuit_open_seconds=0.25,
                    shutdown_grace_seconds=0.1))

        # probe：预热超时不记账、不杀 worker（threshold=1 下记账一次即熔断）
        slow = _make_sup('warmup-probe')
        self.addCleanup(slow.destroy)
        with self.assertRaises(RuntimeFailure) as caught:
            slow.call('homeContent', [False], request=RuntimeRequest.create(
                site_key=slow.site_key, method='homeContent',
                deadline_ms=5000, probe=True))
        self.assertEqual(caught.exception.code, 'L3_RUNTIME_TIMEOUT')
        self.assertEqual(slow.snapshot()['state'], 'closed',
                         'probe 执行超时不得计入熔断')
        self.assertIsNotNone(slow.pid,
                             'probe 超时必须保留热 worker 供真实请求复用')
        # worker 已热：短预算 probe 纯执行超时，重复超时同样不记账
        with self.assertRaises(RuntimeFailure) as caught:
            slow.call('homeContent', [False], request=RuntimeRequest.create(
                site_key=slow.site_key, method='homeContent',
                deadline_ms=200, probe=True))
        self.assertEqual(caught.exception.code, 'L3_RUNTIME_TIMEOUT')
        self.assertEqual(slow.snapshot()['state'], 'closed')
        self.assertEqual(slow.snapshot()['consecutiveFailures'], 0)
        self.assertIsNotNone(slow.pid)

        # 对照组：真实请求（probe=False）同一超时路径照旧记账 → 熔断打开
        real = _make_sup('warmup-real')
        self.addCleanup(real.destroy)
        with self.assertRaises(RuntimeFailure) as caught:
            real.call('homeContent', [False], request=RuntimeRequest.create(
                site_key=real.site_key, method='homeContent', deadline_ms=5000))
        self.assertEqual(caught.exception.code, 'L3_RUNTIME_TIMEOUT')
        self.assertEqual(real.snapshot()['state'], 'open',
                         '真实请求执行超时照常记账（threshold=1 即开）')
        with self.assertRaises(RuntimeFailure) as opened:
            real.call('homeContent', [False], request=RuntimeRequest.create(
                site_key=real.site_key, method='homeContent', deadline_ms=2000))
        self.assertEqual(opened.exception.code, 'L3_RUNTIME_CIRCUIT_OPEN')

    def test_probe_stale_late_frame_is_swallowed_not_protocol_error(self):
        """M2 后门回归：probe 超时保留的 worker 稍后写入迟到帧，不得被下一个
        真实请求当成协议错误后门杀掉/记账。

        场景用 ``sleep:2`` 构造确定性迟到帧：probe 预算 300ms 先超时（worker
        仍在睡，被 probe 路径保留），worker 2s 后把 probe 的成功帧写进管道；
        紧随其后的真实请求先读到这条 id 错配的迟到帧——吞帧后继续等自己的
        响应，最终正常返回、worker 不被杀、熔断不记账。
        """
        from runtime.contracts import RuntimeRequest
        from runtime.errors import RuntimeError as RuntimeFailure
        from runtime.supervisor import RuntimePolicy, RuntimeSupervisor

        sup = RuntimeSupervisor(
            {'kind': 'fixture', 'site_key': 'warmup-stale', 'behavior': 'sleep:2'},
            policy=RuntimePolicy(
                memory_limit_mb=192, max_concurrency=1, max_queue=2,
                failure_threshold=1, circuit_open_seconds=0.25,
                shutdown_grace_seconds=0.1))
        self.addCleanup(sup.destroy)
        # 先用宽预算发一次成功请求，付掉 spawn+boot（worker 热）
        result, _ = sup.call('homeContent', [False], request=RuntimeRequest.create(
            site_key=sup.site_key, method='homeContent', deadline_ms=5000))
        self.assertEqual(result, {'list': []})
        # 短预算 probe：worker 还在 sleep:2 → 300ms 执行超时 → 保留 worker +
        # 迟到帧簿记（worker 2s 后写入成功帧）
        with self.assertRaises(RuntimeFailure) as caught:
            sup.call('homeContent', [False], request=RuntimeRequest.create(
                site_key=sup.site_key, method='homeContent',
                deadline_ms=300, probe=True))
        self.assertEqual(caught.exception.code, 'L3_RUNTIME_TIMEOUT')
        self.assertIsNotNone(sup.pid, 'probe 超时保留 worker（此刻仍在执行）')
        self.assertEqual(len(sup._stale_probe_ids), 1, '迟到帧簿记应就位')
        # 紧随其后的真实请求：先读到 probe 迟到帧（id 错配）→ 吞帧 → 继续等
        # 自己的响应（worker 空出来后再 sleep:2 一次）→ 正常返回
        result, _ = sup.call('homeContent', [False], request=RuntimeRequest.create(
            site_key=sup.site_key, method='homeContent', deadline_ms=8000))
        self.assertEqual(result, {'list': []})
        self.assertEqual(sup.snapshot()['state'], 'closed')
        self.assertIsNotNone(sup.pid, '迟到帧不得后门杀掉热 worker')
        self.assertEqual(sup._stale_probe_ids, [], '迟到帧消费后簿记应清空')


class WarmupThrottleTest(_WarmupEnvPinned, unittest.TestCase):
    """节流：串行逐源 + 源间隔（优化.md「实测内存峰值后决策」的节流要求）。"""

    def test_sources_warmed_serially_with_gap(self):
        mgr = SiteManager()
        gate = threading.Event()
        runners = []
        for key in ('a', 'b', 'c'):
            site = _site(key)
            runner = _RecordingRunner(gate=gate)
            site.runner = runner
            mgr.sites.append(site)
            runners.append(runner)
        result = {}

        def run():
            result['ok'] = warmup.warmup_sites(mgr, count=3, site_gap=0.25)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        time.sleep(0.3)
        # 串行：第一个还在等 gate 时，后续站点绝不能已开始（否则即并发拉起）
        self.assertEqual(len(runners[0].calls), 1)
        self.assertEqual(runners[1].calls, [])
        self.assertEqual(runners[2].calls, [])
        gate.set()
        thread.join(timeout=5)
        self.assertEqual(result['ok'], 3)
        # 顺序 + 间隔：b 在 a 之后至少 site_gap 才发起
        self.assertGreaterEqual(
            runners[1].calls[0]['time'] - runners[0].calls[0]['time'], 0.2)
        self.assertGreaterEqual(
            runners[2].calls[0]['time'] - runners[1].calls[0]['time'], 0.2)

    def test_warmup_thread_is_daemon(self):
        threads = []
        original = threading.Thread

        def spy(**kwargs):
            t = original(**kwargs)
            threads.append(t)
            return t

        mgr = SiteManager()
        site = _site('d')
        site.runner = _RecordingRunner()
        mgr.sites = [site]
        with mock.patch.object(warmup.threading, 'Thread', side_effect=spy):
            warmup.schedule_warmup(mgr, delay=0)
        self.assertTrue(threads and threads[-1].daemon)


class WarmupFailureTest(_WarmupEnvPinned, unittest.TestCase):
    """失败静默：单源异常不抛、不影响后续源预热。"""

    def test_single_site_error_swallowed_and_continues(self):
        mgr = SiteManager()
        bad_runner = _RecordingRunner(error=RuntimeError('boom'))
        good_runner = _RecordingRunner()
        site_bad = _site('bad')
        site_bad.runner = bad_runner
        site_good = _site('good')
        site_good.runner = good_runner
        mgr.sites = [site_bad, site_good]
        ok = warmup.warmup_sites(mgr, count=2, site_gap=0.0)
        self.assertEqual(ok, 1)  # bad 失败被吞，good 照常预热
        self.assertEqual([c['method'] for c in good_runner.calls], ['homeContent'])

    def test_runner_missing_site_runner_none(self):
        """runner 缺失的站点不进候选，预热整体不炸。"""
        mgr = SiteManager()
        site = _site('norunner')
        site.runner = None
        mgr.sites = [site]
        self.assertEqual(warmup.warmup_sites(mgr, count=1, site_gap=0.0), 0)


class WarmupEmptyConfigTest(_WarmupEnvPinned, unittest.TestCase):
    """空配置/无可用源：零预热。"""

    def test_empty_site_list_warms_nothing(self):
        mgr = SiteManager()
        self.assertEqual(warmup.warmup_sites(mgr, count=3, site_gap=0.0), 0)

    def test_no_healthy_site_warms_nothing(self):
        mgr = SiteManager()
        site = _site('dead', healthy=False)
        runner = _RecordingRunner()
        site.runner = runner
        mgr.sites = [site]
        self.assertEqual(warmup.warmup_sites(mgr, count=3, site_gap=0.0), 0)
        self.assertEqual(runner.calls, [])

    def test_schedule_warmup_zero_count_never_starts_thread(self):
        try:
            os.environ['YUKI_WARMUP_SITES'] = '0'
            self.assertFalse(warmup.schedule_warmup(SiteManager(), delay=0))
        finally:
            os.environ.pop('YUKI_WARMUP_SITES', None)


if __name__ == '__main__':
    unittest.main(verbosity=2)
