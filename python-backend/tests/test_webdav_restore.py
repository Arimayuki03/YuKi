# -*- coding: utf-8 -*-
"""WebDAV 恢复语义回环测试。

旧实现逐文件吞异常、空结果恒当成功返回 → 渲染层提示「恢复完成」但实际什么都没
恢复（网址输错时最典型）。新实现返回 {'files','ok','error'}：
- 连接错误 / 非 404 的 HTTP 错误 → ok=False + error；
- 单文件 404 视为云端无该数据（不算失败），全部 404 → ok=False（无可恢复数据）；
- 部分成功 → ok=True 且 files 只含拿到的数据。
不访问外网：monkeypatch plugin_manager.http_client.get。
"""

from __future__ import annotations

import os
import sys
import unittest

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import kazumi.plugin_manager as pm  # noqa: E402


class _Rsp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError('no json')
        return self._body


class WebdavRestoreTests(unittest.TestCase):
    def setUp(self):
        self._orig = pm.http_client.get
        self.calls = []

        def fake_get(url, **kwargs):
            self.calls.append(url)
            return self._respond(url)

        pm.http_client.get = fake_get

    def tearDown(self):
        pm.http_client.get = self._orig

    def _respond(self, url):  #被子类/用例覆写
        return _Rsp(200, {'v': 1})

    def test_connection_error_fails_loudly(self):
        def boom(url, **kwargs):
            raise OSError('dns lookup failed')

        pm.http_client.get = boom
        r = pm.PluginManager.webdav_restore(None, 'https://bad.example/dav', '', '', ['favorites'])
        self.assertFalse(r['ok'])
        self.assertIn('dns lookup failed', r['error'])
        self.assertEqual(r['files'], {})

    def test_http_500_fails_loudly(self):
        self._respond = lambda url: _Rsp(500)
        r = pm.PluginManager.webdav_restore(None, 'https://x/dav', '', '', ['favorites'])
        self.assertFalse(r['ok'])
        self.assertIn('500', r['error'])

    def test_all_404_means_nothing_to_restore(self):
        self._respond = lambda url: _Rsp(404)
        r = pm.PluginManager.webdav_restore(None, 'https://x/dav', '', '', ['favorites', 'history'])
        self.assertFalse(r['ok'])
        self.assertIn('没有找到任何可恢复的数据', r['error'])

    def test_partial_404_still_ok(self):
        def respond(url):
            if url.endswith('/favorites.json'):
                return _Rsp(404)
            return _Rsp(200, {'items': [1, 2]})

        self._respond = respond
        r = pm.PluginManager.webdav_restore(None, 'https://x/dav', '', '', ['favorites', 'history'])
        self.assertTrue(r['ok'])
        self.assertEqual(list(r['files'].keys()), ['history'])
        self.assertEqual(r['files']['history'], {'items': [1, 2]})

    def test_bad_json_fails_loudly(self):
        self._respond = lambda url: _Rsp(200, None)
        r = pm.PluginManager.webdav_restore(None, 'https://x/dav', '', '', ['favorites'])
        self.assertFalse(r['ok'])
        self.assertIn('JSON', r['error'])


if __name__ == '__main__':
    unittest.main()
