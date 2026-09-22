# -*- coding: utf-8 -*-
"""S1.1-S1.4 spawn Supervisor、硬取消、搜索预算与资源回收。"""
from __future__ import annotations

import json
import asyncio
import gc
import itertools
import os
import socket
import subprocess
import sys
import shutil
import threading
import time
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import hoststate  # noqa: E402
import runtime  # noqa: E402
import server  # noqa: E402
from runtime.contracts import RuntimeRequest, bind_runtime_request  # noqa: E402
from runtime.errors import RuntimeError  # noqa: E402
from runtime import supervisor as supervisor_mod  # noqa: E402
from runtime.supervised_runner import SupervisedRunner  # noqa: E402
from runtime.supervisor import (  # noqa: E402
    RuntimePolicy,
    RuntimeSupervisor,
    active_supervisors,
    destroy_all_supervisors,
)
from site_manager import Site, SiteManager  # noqa: E402
from config import ConfigManager  # noqa: E402

# 共享 CI runner（GitHub Actions）进程调度抖动大：50 worker 聚合搜索的墙钟断言
# 在慢机上会超限（曾观测 2.7s vs 2.0s 预算；run 35141371068 观测 3.2s vs 3.0s——
# 第二轮搜索要等上一批 10 个无限循环 worker 的杀除与清理协调完成）。CI 环境放宽
# 2s 余量，本地开发保持原有严格度；功能断言（结果集、pid 回收）不受影响。
# 本地后台高负载（如并行测试套件）也会放大 spawn 抖动：实测裸机连续跑 14 用例
# 出现 L3_RUNTIME_TIMEOUT 覆盖预期错误码、1.61s vs 1.5s 墙钟超限、启动屏障
# deadline exceeded（HEAD 基线同样复现，与修复无关）。默认加 2s 余量，CI 已有
# 同款处理；deadline_ms 与行为断言本身不变。
_BUDGET_ASSERT_SLACK = 2.0 if os.environ.get('CI') else 0.0
# `_call` 默认 deadline：含 Worker 冷启动（spawn + booted 屏障 + attach Job）。
# 裸机负载下冷启动可超 1s，启动屏障先把整个 deadline 烧完，预期错误码
# （CRASHED/CALL_FAILED/CREDENTIALS）被 L3_RUNTIME_TIMEOUT 覆盖。放宽到 5s
# 不影响被测语义——行为断言只看错误码，不看耗时。
_DEFAULT_CALL_DEADLINE_MS = 5000


def _pid_exists(pid):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == 'nt':
        result = subprocess.run(
            ['tasklist', '/FI', 'PID eq %d' % pid, '/NH'],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
        text = result.stdout.decode(errors='replace')
        return ('No tasks are running' not in text
                and '没有运行的任务' not in text
                and str(pid) in text)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _reserve_port():
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


def _port_is_open(port):
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(0.1)
    try:
        return probe.connect_ex(('127.0.0.1', int(port))) == 0
    finally:
        probe.close()


def _wait_resources_gone(state, timeout=4):
    pids = [state.get('workerPid'), state.get('pythonPid'), state.get('nodePid')]
    ports = [state.get('pythonPort'), state.get('nodePort')]
    # tasklist 轮询与端口释放在 CI 上都可能拖过 4s：加 CI 余量放宽等待，
    # 语义不变（资源最终必须全部回收）。
    deadline = time.monotonic() + timeout + _BUDGET_ASSERT_SLACK
    while time.monotonic() < deadline:
        if (all(not _pid_exists(pid) for pid in pids if pid)
                and all(not _port_is_open(port) for port in ports if port)):
            return True
        time.sleep(0.05)
    return False


class _ActionRequest:
    def __init__(self, form, request_id):
        self._form = dict(form)
        self.headers = {'x-request-id': request_id}

    async def form(self):
        return dict(self._form)

    async def is_disconnected(self):
        return False


class RuntimeSupervisorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.makedirs(ROOT, exist_ok=True)
        hoststate.configure(
            data_dir=os.path.join(ROOT, 'supervisor-data'),
            cache_dir=os.path.join(ROOT, 'supervisor-cache'),
            plugins_dir=os.path.join(ROOT, 'supervisor-cache', 'py'),
            port=18651,
            token='supervisor-test',
        )
        hoststate.ensure_dirs()

    def tearDown(self):
        server.sites.destroy_all()
        destroy_all_supervisors()

    def _supervisor(self, behavior='normal', **extra):
        spec = {'kind': 'fixture', 'site_key': extra.pop('site_key', 'fixture'),
                'behavior': behavior, **extra}
        policy = RuntimePolicy(
            memory_limit_mb=192,
            max_concurrency=1,
            max_queue=2,
            failure_threshold=3,
            circuit_open_seconds=0.25,
            shutdown_grace_seconds=0.1,
        )
        return RuntimeSupervisor(spec, policy=policy)

    @staticmethod
    def _action_endpoint(app):
        return next(route.endpoint for route in app.routes
                    if getattr(route, 'path', '') == '/action')

    @staticmethod
    def _http_action(endpoint, form, request_id):
        response = asyncio.run(endpoint(_ActionRequest(form, request_id)))
        return response.status_code, json.loads(response.body)

    def test_runtime_package_keeps_contract_and_supervisor_exports(self):
        expected = {
            'RuntimeRequest', 'RuntimeResponse', 'RuntimeError', 'SiteHealth',
            'RuntimePolicy', 'RuntimeSupervisor', 'destroy_all_supervisors',
        }
        self.assertTrue(expected.issubset(set(runtime.__all__)))
        self.assertTrue(all(hasattr(runtime, name) for name in expected))

    @staticmethod
    def _call(supervisor, method='homeContent', deadline_ms=_DEFAULT_CALL_DEADLINE_MS, args=None):
        request = RuntimeRequest.create(
            site_key=supervisor.site_key,
            method=method,
            deadline_ms=deadline_ms,
        )
        return supervisor.call(method, args or [False], request=request)[0]

    def test_normal_exception_timeout_and_worker_is_really_gone(self):
        normal = self._supervisor('normal', site_key='normal')
        self.assertEqual(self._call(normal), {'list': []})
        self.assertIsNotNone(normal.pid)

        failed = self._supervisor('error', site_key='error')
        with self.assertRaises(RuntimeError) as caught:
            self._call(failed)
        self.assertEqual(caught.exception.code, 'L3_RUNTIME_CALL_FAILED')

        blocked = self._supervisor('infinite', site_key='timeout')
        started = time.monotonic()
        with self.assertRaises(RuntimeError) as caught:
            self._call(blocked, deadline_ms=180)
        self.assertEqual(caught.exception.code, 'L3_RUNTIME_TIMEOUT')
        # 180ms deadline 的守卫断言：确认超时没有被拖成永久等待。含首次 spawn
        # 的路径可能吃满 5s 冷启动余量，墙钟预算同样放宽。
        self.assertLess(time.monotonic() - started, 1.5 + _BUDGET_ASSERT_SLACK + 4.0)
        self.assertIsNone(blocked.pid, '超时必须结束 Worker，而非只停止等待')

    def test_cancel_kills_worker_instead_of_treating_future_cancel_as_done(self):
        supervisor = self._supervisor('infinite', site_key='cancel')
        request = RuntimeRequest.create(
            site_key='cancel', method='homeContent', deadline_ms=5000)
        result = {}

        def invoke():
            try:
                supervisor.call('homeContent', [False], request=request)
            except RuntimeError as error:
                result['error'] = error

        thread = threading.Thread(target=invoke)
        thread.start()
        deadline = time.monotonic() + 2
        while supervisor.pid is None and time.monotonic() < deadline:
            time.sleep(0.01)
        request.cancel('cancelled')
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result['error'].code, 'L3_RUNTIME_CANCELLED')
        self.assertIsNone(supervisor.pid)

    def test_queue_wait_is_part_of_deadline(self):
        supervisor = self._supervisor('sleep:0.45', site_key='queue')
        first = RuntimeRequest.create(
            site_key='queue', method='homeContent', deadline_ms=2000)
        thread = threading.Thread(
            target=lambda: supervisor.call('homeContent', [False], request=first))
        thread.start()
        time.sleep(0.08)
        started = time.monotonic()
        with self.assertRaises(RuntimeError) as caught:
            self._call(supervisor, deadline_ms=100)
        self.assertEqual(caught.exception.code, 'L3_RUNTIME_TIMEOUT')
        self.assertLess(time.monotonic() - started, 0.5)
        thread.join(timeout=2)

    def test_crash_restarts_then_repeated_crashes_open_circuit(self):
        marker = os.path.join(ROOT, 'crash-once.marker')
        try:
            os.remove(marker)
        except OSError:
            pass
        once = self._supervisor('crash_once', site_key='crash-once', marker_file=marker)
        with self.assertRaises(RuntimeError) as caught:
            self._call(once)
        self.assertEqual(caught.exception.code, 'L3_RUNTIME_CRASHED')
        self.assertEqual(self._call(once), {'list': []}, '下一请求应自动启动健康 Worker')
        self.assertGreaterEqual(once.snapshot()['generation'], 2)

        repeated = self._supervisor('crash', site_key='crash-loop')
        for _ in range(3):
            with self.assertRaises(RuntimeError) as crash:
                self._call(repeated)
            self.assertEqual(crash.exception.code, 'L3_RUNTIME_CRASHED')
        generation = repeated.snapshot()['generation']
        with self.assertRaises(RuntimeError) as opened:
            self._call(repeated)
        self.assertEqual(opened.exception.code, 'L3_RUNTIME_CIRCUIT_OPEN')
        self.assertEqual(repeated.snapshot()['generation'], generation,
                         '熔断期间不能继续刷 Worker/日志')

    def test_half_open_probe_recovers_and_credentials_do_not_auto_retry(self):
        mode_file = os.path.join(ROOT, 'recover.mode')
        with open(mode_file, 'w', encoding='utf-8') as stream:
            stream.write('crash')
        supervisor = self._supervisor(
            'normal', site_key='recover', mode_file=mode_file)
        for _ in range(3):
            with self.assertRaises(RuntimeError):
                self._call(supervisor)
        with open(mode_file, 'w', encoding='utf-8') as stream:
            stream.write('normal')
        supervisor.force_half_open()
        self.assertEqual(self._call(supervisor), {'list': []})
        self.assertEqual(supervisor.snapshot()['state'], 'closed')

        credentials = self._supervisor('credentials', site_key='credentials')
        with self.assertRaises(RuntimeError) as missing:
            self._call(credentials)
        self.assertEqual(missing.exception.code, 'L3_RUNTIME_CREDENTIALS_REQUIRED')
        generation = credentials.snapshot()['generation']
        with self.assertRaises(RuntimeError) as blocked:
            self._call(credentials)
        self.assertEqual(blocked.exception.code, 'L3_RUNTIME_CREDENTIALS_REQUIRED')
        self.assertEqual(credentials.snapshot()['generation'], generation)

    def test_child_process_and_bound_port_are_released_after_timeout(self):
        child_pid_file = os.path.join(ROOT, 'supervisor-child.pid')
        try:
            os.remove(child_pid_file)
        except OSError:
            pass
        child = self._supervisor(
            'spawn_child_infinite', site_key='tree', child_pid_file=child_pid_file)
        with self.assertRaises(RuntimeError):
            self._call(child, deadline_ms=1200)
        with open(child_pid_file, encoding='ascii') as stream:
            child_pid = int(stream.read().strip())
        deadline = time.monotonic() + 2
        while _pid_exists(child_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(_pid_exists(child_pid), 'Worker 的 Python 后代必须一并终止')

        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
        probe.close()
        port_worker = self._supervisor('port_infinite', site_key='port', port=port)
        with self.assertRaises(RuntimeError):
            self._call(port_worker, deadline_ms=1000)
        rebound = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            rebound.bind(('127.0.0.1', port))
        finally:
            rebound.close()

        # FastAPI shutdown must kill an actively blocked Worker and close
        # both its listener and the backend proxy listener.
        import go_proxy
        worker_port = _reserve_port()
        exit_worker = self._supervisor(
            'port_infinite', site_key='fastapi-exit-worker', port=worker_port)
        exit_request = RuntimeRequest.create(
            site_key='fastapi-exit-worker', method='homeContent', deadline_ms=10000)
        exit_result = {}
        exit_thread = threading.Thread(
            target=lambda: self._capture_runtime_error(
                exit_result, lambda: exit_worker.call(
                    'homeContent', [False], request=exit_request)))
        exit_thread.start()
        deadline = time.monotonic() + 3
        while not _port_is_open(worker_port) and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(_port_is_open(worker_port))
        worker_pid = exit_worker.pid

        proxy_port = _reserve_port()
        app = server.create_app()
        self.assertTrue(go_proxy.ensure_listener(proxy_port))

        async def close_app():
            async with app.router.lifespan_context(app):
                pass

        asyncio.run(close_app())
        exit_thread.join(timeout=3)
        self.assertFalse(exit_thread.is_alive())
        self.assertEqual(exit_result['error'].code, 'L3_RUNTIME_RESTARTED')
        self.assertFalse(_pid_exists(worker_pid))
        self.assertFalse(_port_is_open(worker_port))
        rebound = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            rebound.bind(('127.0.0.1', proxy_port))
        finally:
            rebound.close()

    @staticmethod
    def _capture_runtime_error(target, callback):
        try:
            callback()
        except RuntimeError as error:
            target['error'] = error

    def test_python_and_quickjs_infinite_loops_are_process_isolated(self):
        python_runner = SupervisedRunner({
            'kind': 'python', 'site_key': 'real-python', 'name': 'real-python',
            'path': os.path.join(BASE, 'tests', 'fixtures', 'infinite_spider.py'),
        })
        python_runner.init('')
        request = RuntimeRequest.create(
            site_key='real-python', method='homeContent', deadline_ms=220)
        with self.assertRaises(RuntimeError) as py_timeout:
            python_runner.supervisor.call('homeContent', [False], request=request)
        self.assertEqual(py_timeout.exception.code, 'L3_RUNTIME_TIMEOUT')
        self.assertIsNone(python_runner.supervisor.pid)

        js_source = ('export default { init: function(){}, '
                     'home: function(){ while (true) {} } };')
        js_runner = SupervisedRunner({
            'kind': 'js', 'site_key': 'real-js', 'name': 'real-js',
            'api': js_source, 'proxy_port': 18651,
        })
        js_runner.init('')
        request = RuntimeRequest.create(
            site_key='real-js', method='homeContent', deadline_ms=220)
        with self.assertRaises(RuntimeError) as js_timeout:
            js_runner.supervisor.call('homeContent', [False], request=request)
        self.assertEqual(js_timeout.exception.code, 'L3_RUNTIME_TIMEOUT')
        self.assertIsNone(js_runner.supervisor.pid)

    def test_twenty_reload_cycles_and_exit_leave_no_workers(self):
        manager = ConfigManager(SiteManager())
        node_exe = shutil.which('node')
        self.assertTrue(node_exe, 'Node executable is required for resource-tree acceptance')
        fixture_path = os.path.join(BASE, 'tests', 'fixtures', 'resource_tree_spider.py')
        with open(fixture_path, encoding='utf-8') as stream:
            source = stream.read()
        states = []
        for index in range(20):
            pid_file = os.path.join(ROOT, 'reload-resources-%02d.json' % index)
            config = json.dumps({'sites': [{
                'key': 'reload', 'name': 'reload', 'type': 3, 'api': source,
                'ext': {
                    'pidFile': pid_file,
                    'pythonPort': _reserve_port(),
                    'nodePort': _reserve_port(),
                    'nodeExe': node_exe,
                },
            }]})
            summary = manager.load(config)
            self.assertEqual(summary['healthy'], 1, summary)
            # 惰性初始化：load() 只建站不拉起 Worker；首次调用触发 Worker 自举
            # init，resource_tree_spider 在 init 里派生 Python/Node 后代并写状态文件。
            reloaded = manager.sites.sites[0]
            self.assertEqual(reloaded.runner.homeContent(False), {'list': []})
            with open(pid_file, encoding='utf-8') as stream:
                state = json.load(stream)
            state['workerPid'] = manager.sites.sites[0].runner.supervisor.pid
            self.assertTrue(_pid_exists(state['pythonPid']))
            self.assertTrue(_pid_exists(state['nodePid']))
            self.assertTrue(_port_is_open(state['pythonPort']))
            self.assertTrue(_port_is_open(state['nodePort']))
            states.append(state)
            if index:
                self.assertTrue(
                    _wait_resources_gone(states[index - 1]),
                    '第 %d 次重载遗留旧 Python/Node/端口: %s' % (index, states[index - 1]))
        manager.sites.destroy_all()
        self.assertEqual(active_supervisors(), [])
        self.assertEqual(len(states), 20)
        self.assertTrue(_wait_resources_gone(states[-1]))

        hanging = self._supervisor('infinite', site_key='exit')
        request = RuntimeRequest.create(
            site_key='exit', method='homeContent', deadline_ms=10000)
        thread = threading.Thread(
            target=lambda: self._ignore_runtime_error(
                lambda: hanging.call('homeContent', [False], request=request)))
        thread.start()
        deadline = time.monotonic() + 2
        while hanging.pid is None and time.monotonic() < deadline:
            time.sleep(0.01)
        started = time.monotonic()
        hanging.destroy()
        thread.join(timeout=2)
        self.assertLess(time.monotonic() - started, 1.5 + _BUDGET_ASSERT_SLACK)
        self.assertFalse(thread.is_alive())

    def test_real_python_resource_fixture_normal_and_cleanup(self):
        node_exe = shutil.which('node')
        self.assertTrue(node_exe)
        pid_file = os.path.join(ROOT, 'resource-fixture-direct.json')
        runner = SupervisedRunner({
            'kind': 'python', 'site_key': 'resource-fixture-direct',
            'name': 'resource-fixture-direct',
            'path': os.path.join(BASE, 'tests', 'fixtures', 'resource_tree_spider.py'),
        })
        try:
            try:
                # 夹具 init 要等两个真实子进程的监听端口就绪；CI runner 冷启动可能
                # 吃掉大半默认 30s init 截止，放宽为 60s 专属 deadline 防慢机误判。
                with bind_runtime_request(RuntimeRequest.create(
                        site_key='resource-fixture-direct', method='init',
                        deadline_ms=60000)):
                    runner.init(json.dumps({
                        'pidFile': pid_file,
                        'pythonPort': _reserve_port(),
                        'nodePort': _reserve_port(),
                        'nodeExe': node_exe,
                    }))
            except RuntimeError as error:
                self.fail('resource fixture init failed: %s' % error.raw_error)
            with open(pid_file, encoding='utf-8') as stream:
                state = json.load(stream)
            state['workerPid'] = runner.supervisor.pid
            self.assertEqual(runner.homeContent(False), {'list': []})
        finally:
            runner.destroy()
        self.assertTrue(_wait_resources_gone(state))

    def test_startup_barrier_captures_descendant_created_during_worker_build(self):
        pid_file = os.path.join(ROOT, 'startup-barrier-child.pid')
        try:
            os.remove(pid_file)
        except OSError:
            pass
        port = _reserve_port()
        supervisor = self._supervisor(
            'normal', site_key='startup-barrier',
            startup_child_pid_file=pid_file, startup_child_port=port)
        self.assertEqual(self._call(supervisor), {'list': []})
        with open(pid_file, encoding='ascii') as stream:
            child_pid = int(stream.read())
        deadline = time.monotonic() + 3
        while not _port_is_open(port) and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(_pid_exists(child_pid))
        self.assertTrue(_port_is_open(port))
        supervisor.destroy()
        self.assertTrue(_wait_resources_gone({
            'pythonPid': child_pid, 'pythonPort': port,
        }), '启动阶段创建的后代必须已在 Job/进程组内')

    @staticmethod
    def _ignore_runtime_error(callback):
        try:
            callback()
        except Exception:
            pass

    def test_fifty_sources_with_ten_permanent_blocks_return_healthy_results(self):
        # 本测试验证 aggregate_search 的协调与预算回收，不是全局 Worker 上限；
        # 放开上限（生产默认 8，见 supervisor._MAX_WORKERS_DEFAULT）以保持
        # 「50 源并发应答」的原始覆盖前提。
        with mock.patch('runtime.supervisor._max_workers', return_value=64), \
                mock.patch('runtime.supervisor._max_jar_workers', return_value=16):
            self._fifty_sources_scenario()

    def _fifty_sources_scenario(self):
        runners = []
        for index in range(50):
            runner = SupervisedRunner({
                'kind': 'fixture',
                'site_key': 'source-%02d' % index,
                'name': 'source-%02d' % index,
                'behavior': {
                    'searchContent': 'infinite' if index < 10 else 'normal',
                    '*': 'normal',
                },
            })
            runners.append(runner)
        with ThreadPoolExecutor(max_workers=16) as pool:
            list(pool.map(lambda runner: runner.init(''), runners))
        for index, runner in enumerate(runners):
            site = Site('source-%02d' % index, 'fixture')
            site.runner = runner
            site.searchable = True
            site.health.mark_built().mark_initialized().mark_healthy()
            server.sites.sites.append(site)
            server.sites.diagnostics.append(site.health)

        started = time.monotonic()
        result = server.aggregate_search('budget', timeout=2.0)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2.0 + _BUDGET_ASSERT_SLACK,
                        'Worker 清理也必须包含在聚合搜索总预算内')
        self.assertEqual(len(result['list']), 40)
        self.assertEqual(
            {item['source'] for item in result['list']},
            {'source-%02d' % index for index in range(10, 50)},
        )
        self.assertTrue(all(runner.supervisor.pid is None for runner in runners[:10]))

        second_started = time.monotonic()
        second = server.aggregate_search('next-budget', timeout=2.0)
        self.assertLess(time.monotonic() - second_started, 2.0 + _BUDGET_ASSERT_SLACK)
        self.assertEqual(len(second['list']), 40)
        self.assertEqual(
            {item['source'] for item in second['list']},
            {'source-%02d' % index for index in range(10, 50)},
            '第二次搜索不能被上一批遗留协调线程/Worker 占满',
        )
        self.assertTrue(all(runner.supervisor.pid is None for runner in runners[:10]))

    def test_http_retry_cookie_and_config_reload_recover_circuit(self):
        app = server.create_app()
        endpoint = self._action_endpoint(app)
        policy = RuntimePolicy(
            memory_limit_mb=192, max_concurrency=1, max_queue=2,
            failure_threshold=3, circuit_open_seconds=60,
            shutdown_grace_seconds=0.1)

        retry_mode = os.path.join(ROOT, 'http-retry.mode')
        with open(retry_mode, 'w', encoding='utf-8') as stream:
            stream.write('crash')
        retry_runner = SupervisedRunner({
            'kind': 'fixture', 'site_key': 'http-retry', 'name': 'http-retry',
            'behavior': 'normal', 'mode_file': retry_mode,
        }, policy=policy)
        retry_site = Site('http-retry', 'fixture')
        retry_site.runner = retry_runner
        retry_site.health.mark_built().mark_initialized().mark_healthy()
        server.sites.sites.append(retry_site)
        server.sites.diagnostics.append(retry_site.health)
        for _ in range(3):
            with self.assertRaises(RuntimeError):
                self._call(retry_runner.supervisor)
        self.assertEqual(retry_runner.runtime_state()['state'], 'open')
        with open(retry_mode, 'w', encoding='utf-8') as stream:
            stream.write('normal')
        status, body = self._http_action(
            endpoint, {'do': 'runtimeRetry', 'site': 'http-retry'},
            'req-runtime-retry-0001')
        self.assertEqual(status, 200, body)
        status, body = self._http_action(
            endpoint, {'do': 'homeContent', 'site': 'http-retry'},
            'req-runtime-retry-home-0001')
        self.assertEqual(status, 200, body)
        self.assertEqual(body.get('list'), [])
        self.assertEqual(retry_runner.runtime_state()['state'], 'closed')

        cookie_mode = os.path.join(ROOT, 'http-cookie.mode')
        with open(cookie_mode, 'w', encoding='utf-8') as stream:
            stream.write('credentials')
        cookie_runner = SupervisedRunner({
            'kind': 'fixture', 'site_key': 'http-cookie', 'name': 'http-cookie',
            'behavior': 'normal', 'mode_file': cookie_mode,
        }, policy=policy)
        cookie_site = Site('http-cookie', 'fixture')
        cookie_site.runner = cookie_runner
        cookie_site.health.mark_built().mark_initialized().mark_healthy()
        server.sites.sites.append(cookie_site)
        server.sites.diagnostics.append(cookie_site.health)
        with self.assertRaises(RuntimeError) as credential_error:
            self._call(cookie_runner.supervisor)
        self.assertEqual(credential_error.exception.code,
                         'L3_RUNTIME_CREDENTIALS_REQUIRED')
        self.assertTrue(cookie_runner.runtime_state()['permanent'])
        with open(cookie_mode, 'w', encoding='utf-8') as stream:
            stream.write('normal')
        status, body = self._http_action(endpoint, {
            'do': 'panCookie', 'act': 'set',
            'cookies': json.dumps({'quark': '__puus=fixture'}),
        }, 'req-cookie-set-0001')
        self.assertEqual(status, 200, body)
        status, body = self._http_action(
            endpoint, {'do': 'homeContent', 'site': 'http-cookie'},
            'req-cookie-home-0001')
        self.assertEqual(status, 200, body)
        self.assertEqual(cookie_runner.runtime_state()['state'], 'closed')

        # A config reload installs a new runtime boundary. It must recover
        # without retaining the old open/permanent breaker or Worker.
        with open(retry_mode, 'w', encoding='utf-8') as stream:
            stream.write('crash')
        for _ in range(3):
            with self.assertRaises(RuntimeError):
                self._call(retry_runner.supervisor)
        old_supervisor = retry_runner.supervisor
        source = '''
from base.spider import Spider as BaseSpider
class Spider(BaseSpider):
    def init(self, extend=''): return None
    def getName(self): return 'reload-recovery'
    def homeContent(self, filter): return {'list': []}
    def destroy(self): return None
'''
        summary = server.config_mgr.load(json.dumps({'sites': [{
            'key': 'http-retry', 'name': 'reload-recovery',
            'type': 3, 'api': source,
        }]}))
        self.assertEqual(summary['healthy'], 1)
        self.assertTrue(old_supervisor.destroyed)
        self.assertIsNone(old_supervisor.pid)
        status, body = self._http_action(
            endpoint, {'do': 'homeContent', 'site': 'http-retry'},
            'req-config-reload-home-0001')
        self.assertEqual(status, 200, body)
        self.assertEqual(body.get('list'), [])

        async def close_app():
            async with app.router.lifespan_context(app):
                pass
        asyncio.run(close_app())

    def test_aggregate_timeout_does_not_cancel_an_unrelated_site_call(self):
        runner = SupervisedRunner({
            'kind': 'fixture', 'site_key': 'shared-site', 'name': 'shared-site',
            'behavior': {'homeContent': 'sleep:0.4', 'searchContent': 'normal'},
        })
        runner.init('')
        site = Site('shared-site', 'fixture')
        site.runner = runner
        site.searchable = True
        site.health.mark_built().mark_initialized().mark_healthy()
        server.sites.sites.append(site)
        server.sites.diagnostics.append(site.health)

        home_request = RuntimeRequest.create(
            site_key='shared-site', method='homeContent', deadline_ms=2000)
        home_result = {}

        def call_home():
            home_result['value'] = runner.supervisor.call(
                'homeContent', [False], request=home_request)[0]

        thread = threading.Thread(target=call_home)
        thread.start()
        deadline = time.monotonic() + 1
        while (runner.supervisor._active_request is not home_request
               and time.monotonic() < deadline):
            time.sleep(0.01)
        self.assertIs(runner.supervisor._active_request, home_request)
        self.assertEqual(server.aggregate_search('budget', timeout=0.1), {'list': []})
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(home_result.get('value'), {'list': []})


class _FakeSup:
    """伪 Supervisor：只提供 LRU 淘汰扫描读取的最小属性面。

    - ``pid`` 属性可注入（模拟已崩溃未重启的 Supervisor / 存活 Worker）；
    - ``_call_lock`` 为真实 threading.Lock，可被外部占用以模拟「正忙」；
    - ``alive_ref=False`` 时本类不保留自引用，调用方必须自行持强引用。

    伪对象不进 _registry（WeakSet）——上限判定走 _registry 计数，测试直接
    把 _max_workers/_max_jar_workers mock 成 0（下限钳制对 mock 不生效），
    使 ``total >= limit`` 无条件成立，从而聚焦淘汰扫描本身的有界性。
    """

    def __init__(self, site_key, runtime='fixture', pid=None, busy=False,
                 active=False, alive_ref=True):
        self.site_key = site_key
        self.runtime = runtime
        self._pid = pid
        self._active_request = object() if active else None
        self._call_lock = threading.Lock()
        if busy:
            self._call_lock.acquire()
        self._lifecycle_lock = threading.RLock()
        if alive_ref:
            # 自引用仅为保持弱引用存活（引用环，靠 tearDown 的 gc.collect 回收）
            self._keepalive = self

    @property
    def pid(self):
        return self._pid

    def release_keepalive(self):
        self.__dict__.pop('_keepalive', None)


class GlobalSlotBoundedScanTest(unittest.TestCase):
    """C-1 回归：全局上限触达时，淘汰扫描必须有界且不霸占 _registry_lock。

    曾经的回归把「对快照 for 循环」改成 ``while True`` + 永远取 LRU 队头，
    于是队头是 pid is None（已崩溃未重启）/ 运行时不匹配 / 正忙
    （_call_lock 被占）的 Supervisor 时，每个「跳过」分支都只 continue
    不前进，全程持有 _registry_lock 死循环 → 其它线程全部挂死。
    """

    @classmethod
    def setUpClass(cls):
        os.makedirs(ROOT, exist_ok=True)
        hoststate.configure(
            data_dir=os.path.join(ROOT, 'globalslot-data'),
            cache_dir=os.path.join(ROOT, 'globalslot-cache'),
            plugins_dir=os.path.join(ROOT, 'globalslot-cache', 'py'),
            port=18651,
            token='supervisor-test',
        )
        hoststate.ensure_dirs()

    def setUp(self):
        # 逐用例清空全局 LRU，避免同进程其它用例留下的条目干扰计数与顺序
        self._fakes = []
        self._acquire_registry_lock()
        try:
            supervisor_mod._GLOBAL_LRU.clear()
        finally:
            supervisor_mod._registry_lock.release()

    def tearDown(self):
        for sup in list(self._fakes):
            try:
                sup.release_keepalive()
            except Exception:
                pass
        self._acquire_registry_lock()
        try:
            supervisor_mod._GLOBAL_LRU.clear()
        finally:
            supervisor_mod._registry_lock.release()
        gc.collect()

    # ---- 基础设施 -------------------------------------------------------

    def _acquire_registry_lock(self, timeout=5.0):
        """测试自身也要防死锁：拿不到 _registry_lock 直接 fail 而非挂死。"""
        self.assertTrue(
            supervisor_mod._registry_lock.acquire(timeout=timeout),
            '测试线程无法获取 _registry_lock（疑似扫描死循环霸锁）')

    _lru_key_counter = itertools.count(10 ** 9)

    def _seed(self, sup):
        """把伪 Supervisor 直接放进全局 LRU 最前端方向（调用方负责保活）。

        刻意用合成 key 而非 id(sup)：伪对象被回收后 CPython 可能复用同一
        内存地址（id 撞车），后续 seed 会覆盖已失效槽位，令「死弱引用清扫」
        用例的前置失真。生产代码对条目 key 只做字典操作（caller 除外，
        其 key 由被测函数用 id(caller) 自行写入）。
        """
        key = next(self._lru_key_counter)
        self._acquire_registry_lock()
        try:
            supervisor_mod._GLOBAL_LRU[key] = weakref.ref(sup)
        finally:
            supervisor_mod._registry_lock.release()
        self._fakes.append(sup)
        return key

    def _call_ensure(self, caller, results):
        try:
            results['value'] = supervisor_mod._ensure_global_slot_locked(caller)
        except RuntimeError as error:
            results['error'] = error
        except BaseException as error:  # 只为把意外异常带回主线程断言
            results['unexpected'] = error

    def _run_bounded(self, caller, timeout=5.0):
        """线程内调 _ensure_global_slot_locked；回归死循环时 join 超时 → fail。"""
        results = {}
        worker = threading.Thread(
            target=self._call_ensure, args=(caller, results))
        worker.start()
        worker.join(timeout)
        self.assertFalse(
            worker.is_alive(),
            '淘汰扫描必须在有限时间内结束（回归：队头不合格项被无限重扫，'
            '持有 _registry_lock 死循环）')
        return results

    def _assert_registry_lock_free(self, timeout=2.0):
        """回归的另一面：扫描若挂死，_registry_lock 被永久持有，他人无法获取。"""
        acquired = threading.Event()

        def probe():
            if supervisor_mod._registry_lock.acquire(timeout=timeout):
                supervisor_mod._registry_lock.release()
                acquired.set()

        thread = threading.Thread(target=probe)
        thread.start()
        thread.join(timeout + 1.0)
        self.assertFalse(thread.is_alive(), '_registry_lock 探针线程不得挂起')
        self.assertTrue(
            acquired.is_set(), '扫描结束后 _registry_lock 必须可被其他线程获取')

    def _lru_keys(self):
        self._acquire_registry_lock()
        try:
            return list(supervisor_mod._GLOBAL_LRU)
        finally:
            supervisor_mod._registry_lock.release()

    @staticmethod
    def _force_total_limit():
        return mock.patch('runtime.supervisor._max_workers', return_value=0)

    # ---- 用例 -----------------------------------------------------------

    def test_head_victim_without_pid_scan_picks_next_lru_entry(self):
        # 队头：已崩溃未重启（pid is None）——回归中会被无限重扫
        self._seed(_FakeSup(site_key='dead-head', pid=None))
        victim = _FakeSup(site_key='idle-victim', pid=4242)
        self._seed(victim)
        caller = _FakeSup(site_key='caller', pid=None, alive_ref=False)
        self._fakes.append(caller)

        started = time.monotonic()
        with self._force_total_limit():
            results = self._run_bounded(caller)
        self.assertLess(time.monotonic() - started, 2.0)

        self.assertNotIn('unexpected', results)
        self.assertNotIn('error', results)
        self.assertIsNotNone(results.get('value'), '应选中 idle-victim 而非 BUSY')
        evicted, own_lock = results['value']
        self.assertIs(evicted, victim)
        self.assertTrue(own_lock, 'victim _call_lock 占用权必须随 victim 交接')
        self.assertNotIn(id(victim), self._lru_keys(), 'victim 应已从 LRU 摘除')
        supervisor_mod._release_victim_lock(evicted)
        self._assert_registry_lock_free()

    def test_head_victim_with_held_call_lock_scan_picks_next_lru_entry(self):
        # 队头：_call_lock 被占用（正忙）——回归中同样无限重扫
        self._seed(_FakeSup(site_key='busy-head', pid=1111, busy=True))
        victim = _FakeSup(site_key='idle-victim', pid=2222)
        self._seed(victim)
        caller = _FakeSup(site_key='caller', pid=None, alive_ref=False)
        self._fakes.append(caller)

        with self._force_total_limit():
            results = self._run_bounded(caller)
        self.assertNotIn('unexpected', results)
        self.assertNotIn('error', results)
        evicted, own_lock = results['value']
        self.assertIs(evicted, victim)
        self.assertTrue(own_lock)
        supervisor_mod._release_victim_lock(evicted)
        self._assert_registry_lock_free()

    def test_all_victims_unqualified_raises_busy_and_never_spins(self):
        # 池里全是「跳过」类条目 + caller 自己：必须扫完一轮即 raise BUSY
        self._seed(_FakeSup(site_key='dead', pid=None))
        self._seed(_FakeSup(site_key='busy', pid=3333, busy=True))
        caller = _FakeSup(site_key='caller', pid=None, alive_ref=False)
        self._seed(caller)

        started = time.monotonic()
        with self._force_total_limit():
            results = self._run_bounded(caller)
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertNotIn('unexpected', results)
        self.assertNotIn('value', results)
        self.assertIn('error', results)
        self.assertEqual(results['error'].code, 'L3_RUNTIME_BUSY')
        self._assert_registry_lock_free()

    def test_jar_limit_skips_mismatched_runtime_head_and_picks_jar_tail(self):
        # jar 上限触达：队头是 runtime 不匹配的 python Worker——回归中无限重扫
        self._seed(_FakeSup(site_key='python-head', runtime='python', pid=4444))
        jar_victim = _FakeSup(site_key='jar-victim', runtime='jar', pid=5555)
        self._seed(jar_victim)
        caller = _FakeSup(site_key='jar-caller', runtime='jar', pid=None,
                          alive_ref=False)
        self._fakes.append(caller)

        with mock.patch('runtime.supervisor._max_workers', return_value=64), \
                mock.patch('runtime.supervisor._max_jar_workers', return_value=0):
            results = self._run_bounded(caller)
        self.assertNotIn('unexpected', results)
        self.assertNotIn('error', results)
        evicted, own_lock = results['value']
        self.assertIs(evicted, jar_victim)
        self.assertTrue(own_lock)
        supervisor_mod._release_victim_lock(evicted)
        self._assert_registry_lock_free()

    def test_dead_weakref_slots_are_swept_and_scan_stays_bounded(self):
        # 弱引用失效槽位 + 忙条目 + caller：空壳被顺带清扫、忙项被跳过 → BUSY（有界）
        dead_key = self._seed_dead_and_collect()
        self._seed(_FakeSup(site_key='busy-tail', pid=7777, busy=True))
        caller = _FakeSup(site_key='caller', pid=None, alive_ref=False)
        self._seed(caller)

        # 前置：伪造的空壳槽位确实已失效（弱引用解引用为 None）
        supervisor_mod._registry_lock.acquire(timeout=5)
        try:
            ref = supervisor_mod._GLOBAL_LRU[dead_key]
        finally:
            supervisor_mod._registry_lock.release()
        self.assertIsNone(
            ref() if ref is not None else None,
            '测试前置失败：弱引用应已失效，用例退化为普通 BUSY 场景')

        with self._force_total_limit():
            results = self._run_bounded(caller)
        self.assertNotIn('unexpected', results)
        self.assertNotIn('value', results)
        self.assertIn('error', results)
        self.assertEqual(results['error'].code, 'L3_RUNTIME_BUSY')
        self.assertNotIn(dead_key, self._lru_keys(), '失效弱引用槽位应被扫描顺带清扫')
        self._assert_registry_lock_free()

    def _seed_dead_and_collect(self):
        """构造一个「弱引用已失效」的 LRU 空壳槽位并返回其 key。

        必须在独立栈帧里建对象、摘自 _fakes、再 del：若对象残留在本测试
        方法或框架保存的帧局部变量/回溯里，弱引用就不会失效（CPython 3.14
        上实测会被外层帧引用拖活），用例前置即退化。
        """
        dead = _FakeSup(site_key='collected', pid=6666)
        key = self._seed(dead)
        dead.release_keepalive()
        self._fakes.remove(dead)
        dead = None
        gc.collect()
        return key

    def test_only_caller_in_table_returns_busy_without_spinning(self):
        # 全表只有 caller 自己（无 pid）：同样必须立即 BUSY，不能自旋等自己
        caller = _FakeSup(site_key='lonely-caller', pid=None, alive_ref=False)
        self._fakes.append(caller)
        with self._force_total_limit():
            results = self._run_bounded(caller)
        self.assertNotIn('unexpected', results)
        self.assertNotIn('value', results)
        self.assertIn('error', results)
        self.assertEqual(results['error'].code, 'L3_RUNTIME_BUSY')
        self._assert_registry_lock_free()


if __name__ == '__main__':
    unittest.main(verbosity=2)
