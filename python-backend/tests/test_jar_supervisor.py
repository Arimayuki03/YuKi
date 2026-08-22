# -*- coding: utf-8 -*-
"""S1.2 JAR Worker deadline、崩溃恢复与独立流数据面。"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import unittest
import asyncio

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ROOT = os.path.dirname(BASE)
TEST_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
if BASE not in sys.path:
    sys.path.insert(0, BASE)

from runtime.contracts import RuntimeRequest  # noqa: E402
from runtime.errors import RuntimeError  # noqa: E402
from runtime.supervised_runner import SupervisedRunner  # noqa: E402
from config import ConfigManager  # noqa: E402
from site_manager import Site, SiteManager  # noqa: E402
import server  # noqa: E402

RUNNER_JAR = os.path.join(ROOT, 'vendor', 'spider-runner.jar')
FIXTURE_SOURCE = os.path.join(BASE, 'tests', 'fixtures', 'java', 'SupervisorSpider.java')
FIXTURE_CLASSES = os.path.join(TEST_ROOT, 'jar-supervisor-classes')
FIXTURE_JAR = os.path.join(TEST_ROOT, 'supervisor-spider.jar')
PROXY_JAR = os.path.join(BASE, 'jar-runner', 'test-proxy.jar')
PROXY_SOURCE = os.path.join(
    BASE, 'jar-runner', 'test-proxy', 'com', 'github', 'catvod', 'spider', 'Proxy.java')
PROXY_CLASSES = os.path.join(TEST_ROOT, 'jar-proxy-classes')
PROXY_STUBS = os.path.join(BASE, 'jar-runner', 'stubs')


def _find_tool(name):
    java_home = os.environ.get('JAVA_HOME', '')
    suffix = '.exe' if os.name == 'nt' else ''
    if java_home:
        candidate = os.path.join(java_home, 'bin', name + suffix)
        if os.path.isfile(candidate):
            return candidate
    return shutil.which(name)


def _build_fixture():
    javac, jar = _find_tool('javac'), _find_tool('jar')
    if not javac or not jar:
        raise RuntimeError('L3_RUNTIME_INIT_FAILED', raw_error='JDK tools unavailable')
    shutil.rmtree(FIXTURE_CLASSES, ignore_errors=True)
    os.makedirs(FIXTURE_CLASSES, exist_ok=True)
    subprocess.run(
        [javac, '-encoding', 'UTF-8', '-d', FIXTURE_CLASSES, FIXTURE_SOURCE],
        check=True, capture_output=True)
    subprocess.run(
        [jar, 'cf', FIXTURE_JAR, '-C', FIXTURE_CLASSES, '.'],
        check=True, capture_output=True)


def _build_proxy_fixture():
    javac, jar = _find_tool('javac'), _find_tool('jar')
    if not javac or not jar:
        raise RuntimeError('L3_RUNTIME_INIT_FAILED', raw_error='JDK tools unavailable')
    shutil.rmtree(PROXY_CLASSES, ignore_errors=True)
    os.makedirs(PROXY_CLASSES, exist_ok=True)
    subprocess.run(
        [javac, '-encoding', 'UTF-8', '-cp', PROXY_STUBS,
         '-d', PROXY_CLASSES, PROXY_SOURCE],
        check=True, capture_output=True)
    subprocess.run(
        [jar, 'cf', PROXY_JAR, '-C', PROXY_CLASSES, '.'],
        check=True, capture_output=True)


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
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=5, check=False)
        text = result.stdout.decode(errors='replace')
        return ('No tasks are running' not in text
                and '没有运行的任务' not in text
                and str(pid) in text)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _wait_pid_gone(pid, timeout=5):
    deadline = time.monotonic() + timeout
    while _pid_exists(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    return not _pid_exists(pid)


class JarSupervisorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.makedirs(TEST_ROOT, exist_ok=True)
        if not os.path.isfile(RUNNER_JAR):
            raise unittest.SkipTest('spider-runner.jar unavailable')
        try:
            _build_fixture()
            _build_proxy_fixture()
        except RuntimeError as e:
            raise unittest.SkipTest(f'JDK unavailable: {e}')

    def setUp(self):
        self.runner = SupervisedRunner({
            'kind': 'jar', 'site_key': 'jar-supervisor', 'name': 'jar-supervisor',
            'jar_path': FIXTURE_JAR, 'class_name': 'SupervisorSpider',
            'runner_jar': RUNNER_JAR,
        })
        self.runner.init('')

    def tearDown(self):
        self.runner.destroy()

    def _call(self, method, args, deadline_ms=1500):
        request = RuntimeRequest.create(
            site_key='jar-supervisor', method=method, deadline_ms=deadline_ms)
        return self.runner.supervisor.call(method, args, request=request)[0]

    def test_normal_error_timeout_cancel_and_recovery(self):
        result = self._call('homeContent', [False])
        self.assertEqual(result['list'][0]['vod_id'], 'jar-ok')

        with self.assertRaises(RuntimeError) as failed:
            self._call('searchContent', ['error', False, '1'])
        self.assertEqual(failed.exception.code, 'L3_RUNTIME_CALL_FAILED')

        with self.assertRaises(RuntimeError) as timeout:
            self._call('homeContent', [True], deadline_ms=300)
        self.assertEqual(timeout.exception.code, 'L3_RUNTIME_TIMEOUT')
        self.assertIsNone(self.runner.supervisor.pid)
        recovered = self._call('homeContent', [False], deadline_ms=6000)
        self.assertEqual(recovered['list'][0]['vod_id'], 'jar-ok')

        request = RuntimeRequest.create(
            site_key='jar-supervisor', method='homeContent', deadline_ms=5000)
        caught = {}

        def invoke():
            try:
                self.runner.supervisor.call('homeContent', [True], request=request)
            except RuntimeError as error:
                caught['error'] = error

        thread = threading.Thread(target=invoke)
        thread.start()
        time.sleep(0.2)
        request.cancel()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(caught['error'].code, 'L3_RUNTIME_CANCELLED')

    def test_killed_jvm_is_restarted_for_next_healthy_request(self):
        status = self._call('__runtimeStatus', [], deadline_ms=1000)
        java_pid = status.get('javaPid')
        self.assertIsInstance(java_pid, int)
        if os.name == 'nt':
            subprocess.run(
                ['taskkill', '/PID', str(java_pid), '/F'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=False, timeout=5)
        else:
            os.kill(java_pid, 9)
        time.sleep(0.1)
        result = self._call('homeContent', [False], deadline_ms=6000)
        self.assertEqual(result['list'][0]['vod_id'], 'jar-ok')
        restarted = self._call('__runtimeStatus', [], deadline_ms=1000)
        self.assertNotEqual(restarted.get('javaPid'), java_pid)

    def test_jar_queue_wait_is_bounded(self):
        first = RuntimeRequest.create(
            site_key='jar-supervisor', method='homeContent', deadline_ms=800)
        thread = threading.Thread(
            target=lambda: self._ignore_error(
                lambda: self.runner.supervisor.call('homeContent', [True], request=first)))
        thread.start()
        time.sleep(0.1)
        started = time.monotonic()
        with self.assertRaises(RuntimeError) as queued:
            self._call('homeContent', [False], deadline_ms=150)
        self.assertEqual(queued.exception.code, 'L3_RUNTIME_TIMEOUT')
        self.assertLess(time.monotonic() - started, 0.5)
        thread.join(timeout=2)

    def test_static_proxy_stream_stays_off_json_control_channel(self):
        proxy_runner = SupervisedRunner({
            'kind': 'jar', 'site_key': 'jar-proxy-supervisor', 'name': 'jar-proxy',
            'jar_path': PROXY_JAR, 'class_name': 'Test',
            'runner_jar': RUNNER_JAR,
        })
        try:
            result = proxy_runner.proxy({'range': 'bytes=0-2'})
            self.assertEqual(result.status, 200)
            self.assertTrue(hasattr(result.body, 'read'),
                            'JAR InputStream 必须由数据 socket 流式读取')
            self.assertEqual(result.body.read(5), b'proxy')
            result.close()
            self.assertTrue(result.body._closed)
        finally:
            proxy_runner.destroy()

    def test_range_disconnect_closes_upstream_and_releases_data_port(self):
        observer = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        observer.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        observer.bind(('127.0.0.1', 0))
        observer.listen(1)
        observer.settimeout(4)
        observer_port = observer.getsockname()[1]
        proxy_runner = SupervisedRunner({
            'kind': 'jar', 'site_key': 'jar-range-supervisor', 'name': 'jar-range',
            'jar_path': PROXY_JAR, 'class_name': 'Test',
            'runner_jar': RUNNER_JAR,
        })
        result = None
        try:
            result = proxy_runner.proxy({
                'mode': 'interrupt', 'range': 'bytes=1024-2047',
                'observerPort': str(observer_port),
            })
            self.assertEqual(result.status, 206)
            self.assertEqual(result.headers.get('X-Fixture-Range'), 'bytes=1024-2047')
            data_port = result.body._socket.getpeername()[1]
            self.assertEqual(result.body.read(1024), b'x' * 1024)
            result.close()
            upstream, _address = observer.accept()
            try:
                self.assertEqual(upstream.recv(32), b'closed\n',
                                 '客户端中断必须传播到 JVM 上游 InputStream.close()')
            finally:
                upstream.close()
            deadline = time.monotonic() + 3
            still_listening = True
            while time.monotonic() < deadline:
                probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                try:
                    still_listening = probe.connect_ex(('127.0.0.1', data_port)) == 0
                finally:
                    probe.close()
                if not still_listening:
                    break
                time.sleep(0.05)
            self.assertFalse(still_listening, 'JAR 一次性数据端口必须在中断后关闭')
        finally:
            if result is not None:
                result.close()
            observer.close()
            proxy_runner.destroy()

    def test_config_reload_releases_actual_jvm(self):
        manager = ConfigManager(SiteManager())
        old_runner = SupervisedRunner({
            'kind': 'jar', 'site_key': 'jar-reload-old', 'name': 'jar-reload-old',
            'jar_path': FIXTURE_JAR, 'class_name': 'SupervisorSpider',
            'runner_jar': RUNNER_JAR,
        })
        old_runner.init('')
        status = old_runner.supervisor.call(
            '__runtimeStatus', [], request=RuntimeRequest.create(
                site_key='jar-reload-old', method='__runtimeStatus', deadline_ms=1500))[0]
        java_pid = status['javaPid']
        worker_pid = status['workerPid']
        old_site = Site('jar-reload-old', 'fixture')
        old_site.runner = old_runner
        old_site.health.mark_built().mark_initialized().mark_healthy()
        manager._apply({
            'sites': [old_site], 'parses': [], 'flags': [], 'lives': [],
            'wallpaper': '', 'source_url': '(fixture)',
            'diagnostics': [old_site.health],
        })

        replacement = SupervisedRunner({
            'kind': 'fixture', 'site_key': 'jar-reload-new',
            'name': 'jar-reload-new', 'behavior': 'normal',
        })
        replacement.init('')
        new_site = Site('jar-reload-new', 'fixture')
        new_site.runner = replacement
        new_site.health.mark_built().mark_initialized().mark_healthy()
        manager._apply({
            'sites': [new_site], 'parses': [], 'flags': [], 'lives': [],
            'wallpaper': '', 'source_url': '(fixture)',
            'diagnostics': [new_site.health],
        })
        self.assertTrue(old_runner.supervisor.destroyed)
        self.assertTrue(_wait_pid_gone(worker_pid), '配置重载必须结束旧 JAR Worker')
        self.assertTrue(_wait_pid_gone(java_pid), '配置重载必须结束旧 JVM')
        manager.sites.destroy_all()

    def test_fastapi_exit_releases_actual_jvm_worker_and_stream_port(self):
        observer = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        observer.bind(('127.0.0.1', 0))
        observer.listen(1)
        proxy_runner = SupervisedRunner({
            'kind': 'jar', 'site_key': 'jar-app-exit', 'name': 'jar-app-exit',
            'jar_path': PROXY_JAR, 'class_name': 'Test',
            'runner_jar': RUNNER_JAR,
        })
        result = None
        try:
            result = proxy_runner.proxy({
                'mode': 'interrupt', 'range': 'bytes=0-',
                'observerPort': str(observer.getsockname()[1]),
            })
            data_port = result.body._socket.getpeername()[1]
            status = proxy_runner.supervisor.call(
                '__runtimeStatus', [], request=RuntimeRequest.create(
                    site_key='jar-app-exit', method='__runtimeStatus', deadline_ms=1500))[0]
            worker_pid = status['workerPid']
            java_pid = status['javaPid']
            self.assertTrue(_pid_exists(worker_pid))
            self.assertTrue(_pid_exists(java_pid))
            app = server.create_app()

            async def close_app():
                async with app.router.lifespan_context(app):
                    pass

            asyncio.run(close_app())
            self.assertTrue(_wait_pid_gone(worker_pid), '应用退出必须结束 JAR Worker')
            self.assertTrue(_wait_pid_gone(java_pid), '应用退出必须结束 JVM')
            deadline = time.monotonic() + 3
            listening = True
            while time.monotonic() < deadline:
                probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                try:
                    listening = probe.connect_ex(('127.0.0.1', data_port)) == 0
                finally:
                    probe.close()
                if not listening:
                    break
                time.sleep(0.05)
            self.assertFalse(listening, '应用退出必须释放 JAR 数据端口')
        finally:
            if result is not None:
                result.close()
            observer.close()
            proxy_runner.destroy()

    @staticmethod
    def _ignore_error(callback):
        try:
            callback()
        except Exception:
            pass


if __name__ == '__main__':
    unittest.main(verbosity=2)
