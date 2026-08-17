# -*- coding: utf-8 -*-
"""TVBox 本地代理端口泛化的行为级回归。"""
import os
import sys
import urllib.request
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import go_proxy
import hoststate
from jar_bridge import _scan_jar_ports


class TestPortGeneralization(unittest.TestCase):
    def setUp(self):
        hoststate.configure(port=54321)
        self.before = set(go_proxy._extra_servers)

    def tearDown(self):
        # 测试启动的监听必须关闭，避免独立 unittest 进程里污染后续用例。
        for port in set(go_proxy._extra_servers) - self.before:
            srv = go_proxy._extra_servers.pop(port, None)
            if srv is not None:
                try:
                    srv.shutdown()
                    srv.server_close()
                except Exception:
                    pass

    def test_7777_listener_is_reachable(self):
        self.assertTrue(go_proxy.ensure_listener(7777))
        with urllib.request.urlopen('http://127.0.0.1:7777/proxy?do=ck', timeout=3) as rsp:
            self.assertEqual(rsp.status, 200)
            self.assertEqual(rsp.read(), b'ok')

    def test_protected_and_invalid_ports_are_rejected(self):
        for port in (go_proxy.PORT, *go_proxy.EXTRA_PORTS, 54321, 80, 99999, 'not-a-port', None):
            self.assertFalse(go_proxy.ensure_listener(port), port)

    def test_listener_cap_is_enforced(self):
        ports = list(range(40101, 40101 + go_proxy.EXTRA_LISTENER_CAP + 1))
        results = [go_proxy.ensure_listener(p) for p in ports]
        self.assertEqual(sum(results), go_proxy.EXTRA_LISTENER_CAP)
        self.assertFalse(results[-1])

    def test_scan_jar_finds_embedded_ports(self):
        class FakeZip:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def infolist(self):
                return [type('Info', (), {
                    'is_dir': lambda _self: False,
                    'file_size': 32,
                    'filename': 'classes.dex',
                })()]

            def read(self, _name):
                return b'127.0.0.1:7777\x00127.0.0.1:9999'

        with patch('zipfile.ZipFile', return_value=FakeZip()):
            self.assertEqual(_scan_jar_ports('fake.jar'), {7777, 9999})


if __name__ == '__main__':
    unittest.main()
