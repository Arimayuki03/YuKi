# -*- coding: utf-8 -*-
"""S1.1-S1.4 spawn Supervisor、硬取消、搜索预算与资源回收。"""
from __future__ import annotations

import json
import asyncio
import os
import socket
import subprocess
import sys
import shutil
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ROOT = os.environ.get('VPC_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import hoststate  # noqa: E402
import runtime  # noqa: E402
import server  # noqa: E402
from runtime.contracts import RuntimeRequest  # noqa: E402
from runtime.errors import RuntimeError  # noqa: E402
from runtime.supervised_runner import SupervisedRunner  # noqa: E402
from runtime.supervisor import (  # noqa: E402
    RuntimePolicy,
    RuntimeSupervisor,
    active_supervisors,
    destroy_all_supervisors,
)
from site_manager import Site, SiteManager  # noqa: E402
from config import ConfigManager  # noqa: E402


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
    deadline = time.monotonic() + timeout
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
    def _call(supervisor, method='homeContent', deadline_ms=1000, args=None):
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
        self.assertLess(time.monotonic() - started, 1.5)
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
        self.assertLess(time.monotonic() - started, 1.5)
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
        self.assertLess(elapsed, 2.0, 'Worker 清理也必须包含在聚合搜索总预算内')
        self.assertEqual(len(result['list']), 40)
        self.assertEqual(
            {item['source'] for item in result['list']},
            {'source-%02d' % index for index in range(10, 50)},
        )
        self.assertTrue(all(runner.supervisor.pid is None for runner in runners[:10]))

        second_started = time.monotonic()
        second = server.aggregate_search('next-budget', timeout=2.0)
        self.assertLess(time.monotonic() - second_started, 2.0)
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
