# -*- coding: utf-8 -*-
"""Bangumi 封面代理端点 /kazumi/cover 的回环测试。

不访问外网：monkeypatch http_client.get，验证 host 白名单（防 SSRF）、
官方域名失败自动换镜像重试、token 校验与图片透传。
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import unittest

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import hoststate  # noqa: E402
import http_client  # noqa: E402
import server  # noqa: E402

TOKEN = 'kazumi-cover-token'


class _FakeRsp:
    def __init__(self, status=200, content=b'', ctype='image/jpeg'):
        self.status_code = status
        self.content = content
        self.headers = {'content-type': ctype}


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def _request(url):
    request = urllib.request.Request(url, method='GET')
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        try:
            return error.code, error.headers, error.read()
        finally:
            error.close()


class TestKazumiCoverProxy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import uvicorn  # noqa: PLC0415

        cls.old_started = getattr(server, '_go_proxy_started', False)
        cls.old_state = {
            'port': hoststate.get_port(),
            'token': hoststate.get_token(),
        }
        # 不需要生产固定端口监听器与真实站点
        server._go_proxy_started = True
        hoststate.configure(port=_free_port(), token=TOKEN)
        cls.app = server.create_app()
        cls.port = _free_port()
        cls.uvicorn = uvicorn.Server(uvicorn.Config(
            cls.app, host='127.0.0.1', port=cls.port, log_level='error'))
        cls.thread = threading.Thread(target=cls.uvicorn.run,
                                      daemon=True, name='kazumi-cover-fixture')
        cls.thread.start()
        deadline = time.time() + 8
        while time.time() < deadline and not cls.uvicorn.started:
            time.sleep(0.05)
        if not cls.uvicorn.started:
            cls.uvicorn.should_exit = True
            raise RuntimeError('kazumi cover fixture did not start')

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, 'uvicorn', None) is not None:
            cls.uvicorn.should_exit = True
        if getattr(cls, 'thread', None) is not None:
            cls.uvicorn and cls.thread.join(timeout=5)
        server._go_proxy_started = cls.old_started
        hoststate.configure(**cls.old_state)

    def setUp(self):
        self._old_get = http_client.get
        self.fetched = []
        self._token_q = 'token=' + urllib.parse.quote(TOKEN)

    def tearDown(self):
        http_client.get = self._old_get

    def _mock_get(self, results):
        """results: {host: status | (status, content, ctype)}；记录每次请求 host。"""
        def fake_get(url, **kw):
            host = urllib.parse.urlsplit(url).hostname
            self.fetched.append(host)
            r = results.get(host, 502)
            if isinstance(r, int):
                return _FakeRsp(status=r)
            status, content, ctype = r
            return _FakeRsp(status=status, content=content, ctype=ctype)
        http_client.get = fake_get

    def _url(self, target):
        return (f'http://127.0.0.1:{self.port}/kazumi/cover'
                f'?{self._token_q}&url=' + urllib.parse.quote(target, safe=''))

    def test_cover_proxied_with_cache_header(self):
        self._mock_get({'lain.bgm.tv': (200, b'\xff\xd8fakejpg', 'image/jpeg')})
        status, headers, body = _request(self._url('https://lain.bgm.tv/r/400/pic/cover/c/a.jpg'))
        self.assertEqual(status, 200)
        self.assertEqual(body, b'\xff\xd8fakejpg')
        self.assertTrue(headers.get('Content-Type', '').startswith('image/'))
        self.assertIn('max-age', headers.get('Cache-Control', ''))
        self.assertEqual(self.fetched, ['lain.bgm.tv'])

    def test_official_fail_falls_back_to_mirror(self):
        self._mock_get({'lain.bgm.tv': 502, 'lain.bangumi.pro': (200, b'mirror', 'image/jpeg')})
        status, _, body = _request(self._url('https://lain.bgm.tv/r/400/pic/cover/c/a.jpg'))
        self.assertEqual(status, 200)
        self.assertEqual(body, b'mirror')
        self.assertEqual(self.fetched, ['lain.bgm.tv', 'lain.bangumi.pro'])

    def test_all_candidates_fail_is_502(self):
        self._mock_get({'lain.bgm.tv': 502, 'lain.bangumi.pro': 500})
        status, _, _ = _request(self._url('https://lain.bgm.tv/r/400/pic/cover/c/a.jpg'))
        self.assertEqual(status, 502)

    def test_host_whitelist_rejects_other_hosts(self):
        self._mock_get({})
        for bad in ('https://evil.example.com/a.jpg', 'http://127.0.0.1/x',
                    'file:///c:/windows/win.ini', 'https://lain.bgm.tv.evil.com/a.jpg'):
            status, _, _ = _request(self._url(bad))
            self.assertEqual(status, 403, bad)
        self.assertEqual(self.fetched, [])

    def test_missing_or_wrong_token_rejected(self):
        self._mock_get({})
        url = ('http://127.0.0.1:%d/kazumi/cover?url=' % self.port
               + urllib.parse.quote('https://lain.bgm.tv/r/400/pic/cover/c/a.jpg', safe=''))
        self.assertEqual(_request(url)[0], 401)
        wrong = url + '&token=wrong'
        self.assertEqual(_request(wrong)[0], 401)

    def test_non_image_content_type_rejected_then_mirror(self):
        # 官方返回 HTML 错误页（如反爬跳转）应视为失败并走镜像
        self._mock_get({
            'lain.bgm.tv': (200, b'<html>err</html>', 'text/html'),
            'lain.bangumi.pro': (200, b'ok', 'image/jpeg'),
        })
        status, _, body = _request(self._url('https://lain.bgm.tv/r/400/pic/cover/c/a.jpg'))
        self.assertEqual(status, 200)
        self.assertEqual(body, b'ok')


if __name__ == '__main__':
    unittest.main()
