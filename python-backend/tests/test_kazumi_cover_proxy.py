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
import go_proxy  # noqa: E402
import server  # noqa: E402

TOKEN = 'kazumi-cover-token'


def _stub_go_proxy_listeners():
    """屏蔽 create_app() 的 go_proxy.start_go_proxy() 固定端口监听（9978/7944/1314）。

    旧实现引用 server._go_proxy_started 属性——server.py 已不存在该属性，
    抑制从未生效，本文件独立直跑会真绑生产端口（P3-19-①）。改为 monkeypatch
    go_proxy.start_go_proxy 本身：封面代理走 FastAPI 侧 http_client mock，
    完全不需要 go_proxy 固定端口服务。返回还原函数。
    """
    sentinel = object()
    original = getattr(go_proxy, 'start_go_proxy', sentinel)

    def fake_start():
        return None

    go_proxy.start_go_proxy = fake_start

    def restore():
        if original is sentinel:
            try:
                del go_proxy.start_go_proxy
            except AttributeError:
                pass
        else:
            go_proxy.start_go_proxy = original

    return restore


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

        cls.restore_go_proxy = _stub_go_proxy_listeners()
        cls.old_state = {
            'port': hoststate.get_port(),
            'token': hoststate.get_token(),
        }
        # 不需要生产固定端口监听器与真实站点（go_proxy 启动已被屏蔽）
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
        cls.restore_go_proxy()
        hoststate.configure(**cls.old_state)

    def setUp(self):
        self._old_get = http_client.get
        self.fetched = []
        self.ua_seen = []
        self._token_q = 'token=' + urllib.parse.quote(TOKEN)

    def tearDown(self):
        http_client.get = self._old_get

    def _mock_get(self, results):
        """results: {host: status | (status, content, ctype)}；记录每次请求 host 与 UA。"""
        def fake_get(url, **kw):
            host = urllib.parse.urlsplit(url).hostname
            self.fetched.append(host)
            self.ua_seen.append((kw.get('headers') or {}).get('User-Agent', ''))
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
        # 镜像 lain.bangumi.vip 在 Cloudflare 后拦程序化 UA（okhttp 默认 UA 实测 403）：
        # 代理转发必须带浏览器前缀 UA（与渲染层 <img> 同形态）
        self.assertTrue(self.ua_seen[0].startswith('Mozilla/5.0'), self.ua_seen[0])

    def test_official_fail_falls_back_to_mirror(self):
        # 2026-09-15 镜像根域名切至 bangumi.vip（bangumi.pro 失效）
        self._mock_get({'lain.bgm.tv': 502, 'lain.bangumi.vip': (200, b'mirror', 'image/jpeg')})
        status, _, body = _request(self._url('https://lain.bgm.tv/r/400/pic/cover/c/a.jpg'))
        self.assertEqual(status, 200)
        self.assertEqual(body, b'mirror')
        self.assertEqual(self.fetched, ['lain.bgm.tv', 'lain.bangumi.vip'])

    def test_all_candidates_fail_is_502(self):
        self._mock_get({'lain.bgm.tv': 502, 'lain.bangumi.vip': 500})
        status, _, _ = _request(self._url('https://lain.bgm.tv/r/400/pic/cover/c/a.jpg'))
        self.assertEqual(status, 502)

    def test_legacy_mirror_pro_host_falls_back_to_current_mirror(self):
        # 存量记录可能持久化旧镜像 lain.bangumi.pro：仍在白名单，失败后兜底当前镜像
        self._mock_get({'lain.bangumi.pro': 502, 'lain.bangumi.vip': (200, b'vip', 'image/jpeg')})
        status, _, body = _request(self._url('https://lain.bangumi.pro/r/400/pic/cover/l/a.jpg'))
        self.assertEqual(status, 200)
        self.assertEqual(body, b'vip')
        self.assertEqual(self.fetched, ['lain.bangumi.pro', 'lain.bangumi.vip'])

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
            'lain.bangumi.vip': (200, b'ok', 'image/jpeg'),
        })
        status, _, body = _request(self._url('https://lain.bgm.tv/r/400/pic/cover/c/a.jpg'))
        self.assertEqual(status, 200)
        self.assertEqual(body, b'ok')

    def test_custom_mirror_root_whitelisted_and_used_as_fallback(self):
        # 设置页手动替换镜像根域名后：lain.{自定义根域名} 入白名单并作为兜底候选
        old_mgr = server.kazumi_mgr
        server.kazumi_mgr = type('MgrStub', (), {'mirror_root': 'mirror.example.com'})()
        try:
            self._mock_get({'lain.bgm.tv': 502, 'lain.mirror.example.com': (200, b'custom', 'image/jpeg')})
            status, _, body = _request(self._url('https://lain.bgm.tv/r/400/pic/cover/c/a.jpg'))
            self.assertEqual(status, 200)
            self.assertEqual(body, b'custom')
            self.assertEqual(self.fetched, ['lain.bgm.tv', 'lain.mirror.example.com'])
            # 自定义镜像域 URL 本身放行且已是镜像域（不再追加候选）
            self.fetched.clear()
            self._mock_get({'lain.mirror.example.com': (200, b'direct', 'image/jpeg')})
            status, _, body = _request(self._url('https://lain.mirror.example.com/pic/cover/l/a.jpg'))
            self.assertEqual(status, 200)
            self.assertEqual(self.fetched, ['lain.mirror.example.com'])
        finally:
            server.kazumi_mgr = old_mgr

    def test_poisoned_r_prefix_segment_normalized(self):
        """T78：旧渲染层持久化的损坏组合（/r/{n}/pic/cover/{非l}/，lain CDN 返回
        HTTP 400）在代理侧归一化为段 l 后转发；裸路径形式保持原样。"""
        fetched_urls = []

        def fake_get(url, **kw):
            fetched_urls.append(url)
            return _FakeRsp(status=200, content=b'ok', ctype='image/jpeg')

        http_client.get = fake_get
        status, _, _ = _request(
            self._url('https://lain.bangumi.vip/r/400/pic/cover/c/3c/ec/247_MnPPU.jpg'))
        self.assertEqual(status, 200)
        self.assertEqual(len(fetched_urls), 1)  # 已是当前镜像域，不再追加候选
        self.assertIn('/r/400/pic/cover/l/3c/ec/247_MnPPU.jpg', fetched_urls[0])

        # 裸路径（无 r 前缀）的 c 段合法：原样透传
        fetched_urls.clear()
        status, _, _ = _request(self._url('https://lain.bgm.tv/pic/cover/c/a/b/1.jpg'))
        self.assertEqual(status, 200)
        self.assertIn('lain.bgm.tv/pic/cover/c/a/b/1.jpg', fetched_urls[0])


if __name__ == '__main__':
    unittest.main()
