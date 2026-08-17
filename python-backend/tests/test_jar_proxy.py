# -*- coding: utf-8 -*-
"""JAR 级 FongMi Proxy.proxy(Map) 流式桥测试。"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(BASE)
sys.path.insert(0, BASE)

import java_probe  # noqa: E402
import hoststate  # noqa: E402
from jar_bridge import JarBridge  # noqa: E402
from jar_spider import _normalize_proxy_scheme, make_jar_spider_class  # noqa: E402
from runner import Runner  # noqa: E402


FIXTURE_SRC = os.path.join(BASE, 'jar-runner', 'test-proxy', 'com', 'github',
                           'catvod', 'spider', 'Proxy.java')
FIXTURE_BUILD = os.path.join(BASE, 'jar-runner', 'test-proxy-build')
FIXTURE_JAR = os.path.join(BASE, 'jar-runner', 'test-proxy.jar')
FIXTURE_STUBS = os.path.join(BASE, 'jar-runner', 'stubs')
RUNNER_JAR = os.path.join(ROOT, 'vendor', 'spider-runner.jar')


def _find_tool(name):
    java_home = os.environ.get('JAVA_HOME', '')
    suffix = '.exe' if os.name == 'nt' else ''
    if java_home:
        candidate = os.path.join(java_home, 'bin', name + suffix)
        if os.path.isfile(candidate):
            return candidate
    return shutil.which(name)


def _ensure_fixture():
    """用源码夹具生成 jar，避免把二进制测试产物提交到仓库。"""
    if os.path.isfile(FIXTURE_JAR):
        return True
    javac = _find_tool('javac')
    jar = _find_tool('jar')
    if not javac or not jar or not os.path.isfile(FIXTURE_SRC):
        return False
    shutil.rmtree(FIXTURE_BUILD, ignore_errors=True)
    os.makedirs(FIXTURE_BUILD, exist_ok=True)
    subprocess.run([javac, '-encoding', 'UTF-8', '-cp', FIXTURE_STUBS,
                    '-d', FIXTURE_BUILD, FIXTURE_SRC],
                   check=True, capture_output=True)
    subprocess.run([jar, 'cf', FIXTURE_JAR, '-C', FIXTURE_BUILD, '.'], check=True,
                   capture_output=True)
    shutil.rmtree(FIXTURE_BUILD, ignore_errors=True)
    return os.path.isfile(FIXTURE_JAR)


@unittest.skipUnless(java_probe.find_java() and os.path.isfile(RUNNER_JAR),
                     'JDK or spider-runner.jar unavailable')
class TestJarProxy(unittest.TestCase):
    def test_proxy_scheme_normalizes_to_backend_gateway(self):
        hoststate.configure(port=19776, token='proxy-test')
        result = _normalize_proxy_scheme({'url': 'proxy://do=js&url=episode-1'}, 'site-a')
        self.assertEqual(result['parse'], 0)
        self.assertTrue(result['url'].startswith('http://127.0.0.1:19776/proxy?'))
        self.assertIn('siteKey=site-a', result['url'])

    def test_static_proxy_input_stream_roundtrip(self):
        if not _ensure_fixture():
            self.skipTest('javac/jar unavailable for proxy fixture')
        bridge = JarBridge.get_or_create(FIXTURE_JAR, runner_jar=RUNNER_JAR)
        try:
            result = bridge.call_proxy({'range': 'bytes=0-2'})
            self.assertEqual(result.status, 200)
            self.assertEqual(result.mime, 'text/plain; charset=utf-8')
            self.assertEqual(result.body.read(5), b'proxy')
            self.assertEqual(result.body.read(), b'-ok:bytes=0-2')
            result.close()
        finally:
            bridge.destroy()

    def test_catvod_proxy_url_uses_backend_port(self):
        if not _ensure_fixture():
            self.skipTest('javac/jar unavailable for proxy fixture')
        hoststate.configure(port=19777, token='proxy-test')
        bridge = JarBridge.get_or_create(FIXTURE_JAR, runner_jar=RUNNER_JAR)
        try:
            result = bridge.call_proxy({'mode': 'url'})
            self.assertIn(':19777/proxy', result.body.read().decode('utf-8'))
            result.close()
        finally:
            bridge.destroy()

    def test_server_recent_jar_routes_static_proxy(self):
        if not _ensure_fixture():
            self.skipTest('javac/jar unavailable for proxy fixture')
        import server  # noqa: PLC0415
        from unittest.mock import patch  # noqa: PLC0415

        class Site:
            key = 'jar-site'
            spider_type = 'jar'

            def __init__(self, spider):
                self.runner = Runner(spider)

        class Sites:
            def __init__(self, site):
                self.site = site

            def get(self, key=None):
                return self.site if key == self.site.key else None

            def recent(self, kind=None):
                return self.site if kind in (None, 'jar') else None

            def set_recent(self, key):
                self.recent_key = key

        hoststate.configure(port=19775, token='proxy-test')
        bridge = JarBridge.get_or_create(FIXTURE_JAR, runner_jar=RUNNER_JAR)
        site = Site(make_jar_spider_class('jar-site', bridge, 'fixture', 'Test'))
        try:
            with patch.object(server, 'sites', Sites(site)):
                result = server.do_local_proxy({'do': 'jar', 'range': 'bytes=0-2'})
            self.assertEqual(result.status, 200)
            self.assertEqual(result.body.read(), b'proxy-ok:bytes=0-2')
            result.close()
        finally:
            bridge.destroy()


if __name__ == '__main__':
    unittest.main()
