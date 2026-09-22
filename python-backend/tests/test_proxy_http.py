# -*- coding: utf-8 -*-
"""FongMi proxy 的真实 HTTP 回环夹具。

不访问外部站点；用最小 JS/Python 风格 Runner 验证 FastAPI 和旧端口
入口共享同一套参数合并、token 校验与 Spider 调度逻辑。
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

import go_proxy  # noqa: E402
import hoststate  # noqa: E402
import server  # noqa: E402


TOKEN = 'proxy-http-token'


def _stub_go_proxy_listeners():
    """屏蔽 create_app() 的 go_proxy.start_go_proxy() 固定端口监听（9978/7944/1314）。

    旧实现引用 server._go_proxy_started 属性——server.py 已不存在该属性，
    抑制从未生效，本文件独立直跑会真绑生产端口（P3-19-①）。改为 monkeypatch
    go_proxy.start_go_proxy 本身：本测试自起 uvicorn + 动态 legacy 监听器，
    完全不需要固定端口服务。返回还原函数。
    """
    sentinel = object()
    original = getattr(go_proxy, 'start_go_proxy', sentinel)
    calls = []

    def fake_start():
        calls.append(True)
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

    return restore, calls


class _FixtureRunner:
    def __init__(self, kind):
        self.kind = kind
        self.calls = []

    def localProxy(self, params):
        self.calls.append(dict(params))
        body = 'kind={kind};x={x};body={body};range={range}'.format(
            kind=self.kind,
            x=params.get('x', ''),
            body=params.get('body', ''),
            range=params.get('range', ''),
        ).encode('utf-8')
        return [200, 'text/plain; charset=utf-8', body,
                {'X-Proxy-Fixture': self.kind}]


class _FixtureSite:
    def __init__(self, key, kind):
        self.key = key
        self.spider_type = kind
        self.runner = _FixtureRunner(kind)
        self.headers = {}


class _FixtureSites:
    def __init__(self):
        self.items = {
            'js-fixture': _FixtureSite('js-fixture', 'js'),
            'py-fixture': _FixtureSite('py-fixture', 'py'),
        }
        self.current = None
        self.sites = list(self.items.values())

    def get(self, key=None):
        return self.items.get(key) if key else self.sites[0]

    def recent(self, kind=None):
        if kind:
            return next((item for item in self.sites
                         if item.spider_type == kind), None)
        return self.get(self.current)

    def set_recent(self, key):
        self.current = key


def _request(url, *, method='GET', data=None, headers=None, no_redirect=False):
    body = None
    request_headers = dict(headers or {})
    if data is not None:
        if isinstance(data, dict):
            body = urllib.parse.urlencode(data).encode('utf-8')
            request_headers.setdefault(
                'Content-Type', 'application/x-www-form-urlencoded')
        else:
            body = data
    request = urllib.request.Request(url, data=body, headers=request_headers,
                                     method=method)
    openers = []
    if no_redirect:
        # 不跟随 30x：断言原始状态码（do=ck 的 302 形态断言用）
        openers.append(urllib.request.HTTPRedirectHandler)
        class _NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            with opener.open(request, timeout=8) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            try:
                return error.code, error.headers, error.read()
            finally:
                error.close()
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        try:
            return error.code, error.headers, error.read()
        finally:
            error.close()


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class TestProxyHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import uvicorn  # noqa: PLC0415

        cls.old_sites = server.sites
        cls.restore_go_proxy, cls.go_proxy_calls = _stub_go_proxy_listeners()
        cls.old_state = {
            'port': hoststate.get_port(),
            'token': hoststate.get_token(),
        }
        cls.sites = _FixtureSites()
        server.sites = cls.sites
        # create_app() 内部对 go_proxy.start_go_proxy() 的调用已被屏蔽：
        # 本测试自起 uvicorn + 独立动态 legacy 监听器（见
        # test_legacy_listener_reuses_same_dispatcher），不需要固定端口服务。
        hoststate.configure(port=_free_port(), token=TOKEN)
        cls.app = server.create_app()
        cls.port = _free_port()
        cls.uvicorn = uvicorn.Server(uvicorn.Config(
            cls.app, host='127.0.0.1', port=cls.port, log_level='error'))
        cls.thread = threading.Thread(target=cls.uvicorn.run,
                                      daemon=True, name='proxy-http-fixture')
        cls.thread.start()
        deadline = time.time() + 8
        while time.time() < deadline and not cls.uvicorn.started:
            time.sleep(0.05)
        if not cls.uvicorn.started:
            cls.uvicorn.should_exit = True
            raise RuntimeError('proxy HTTP fixture did not start')

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, 'uvicorn', None) is not None:
            cls.uvicorn.should_exit = True
        if getattr(cls, 'thread', None) is not None:
            cls.thread.join(timeout=5)
        server.sites = cls.old_sites
        cls.restore_go_proxy()
        hoststate.configure(**cls.old_state)

    def test_fastapi_post_merges_body_headers_and_query(self):
        url = (f'http://127.0.0.1:{self.port}/proxy'
               '?siteKey=py-fixture&do=py&x=query&token=' + TOKEN)
        status, headers, body = _request(
            url,
            method='POST',
            data={'x': 'form', 'body': 'urlencoded'},
            headers={'Range': 'bytes=0-1'},
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers.get('X-Proxy-Fixture'), 'py')
        self.assertEqual(
            body.decode('utf-8'),
            'kind=py;x=form;body=urlencoded;range=bytes=0-1',
        )
        self.assertNotIn('token', self.sites.items['py-fixture'].runner.calls[-1])

    def test_fastapi_json_body_and_optional_token(self):
        query = urllib.parse.urlencode({
            'siteKey': 'js-fixture', 'do': 'js', 'token': TOKEN,
        })
        status, headers, body = _request(
            f'http://127.0.0.1:{self.port}/proxy?{query}',
            method='POST',
            data=b'{"x":"json","body":"json-body"}',
            headers={'Content-Type': 'application/json'},
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers.get('X-Proxy-Fixture'), 'js')
        self.assertEqual(
            body.decode('utf-8'),
            'kind=js;x=json;body=json-body;range=',
        )
        self.assertNotIn('token', self.sites.items['js-fixture'].runner.calls[-1])

        status, _headers, body = _request(
            f'http://127.0.0.1:{self.port}/proxy?do=js&token=wrong')
        self.assertEqual(status, 401)
        self.assertIn(b'invalid proxy token', body)

        status, _headers, body = _request(
            f'http://127.0.0.1:{self.port}/proxy?do=js',
            headers={'X-Proxy-Token': 'wrong'},
        )
        self.assertEqual(status, 401)
        self.assertIn(b'invalid proxy token', body)

        status, _headers, body = _request(
            f'http://127.0.0.1:{self.port}/proxy?do=js',
            method='POST',
            data=b'{"x":"body-token","token":"wrong"}',
            headers={'Content-Type': 'application/json'},
        )
        self.assertEqual(status, 401)
        self.assertIn(b'invalid proxy token', body)

    def test_fastapi_anonymous_proxy_rejected(self):
        """R 组：/proxy 不带 token 一律 401（仅 do=ck 健康探测豁免）。"""
        # 无 token 且非 ck：本地任意进程不能再匿名借道代理
        status, _headers, body = _request(
            f'http://127.0.0.1:{self.port}/proxy?do=js&siteKey=js-fixture')
        self.assertEqual(status, 401)
        self.assertIn(b'proxy token required', body)
        # do=ck 健康探测：不触网、不派发 spider，保持免 token（蜘蛛端口扫描
        # 依赖）。既有契约返回裸字符串 'ok' → normalize 为 302 Location: ok，
        # 故用不跟随重定向的请求断言「未被 token 门禁 401」即可。
        status, _headers, _body = _request(
            f'http://127.0.0.1:{self.port}/proxy?do=ck', no_redirect=True)
        self.assertEqual(status, 302)
        self.assertEqual(_headers.get('Location'), 'ok')

    def test_legacy_listener_reuses_same_dispatcher(self):
        port = _free_port()
        self.assertTrue(go_proxy.ensure_listener(port))
        try:
            query = urllib.parse.urlencode({
                'siteKey': 'js-fixture', 'do': 'js', 'x': 'legacy', 'token': TOKEN,
            })
            status, headers, body = _request(
                f'http://127.0.0.1:{port}/proxy?{query}')
            self.assertEqual(status, 200)
            self.assertEqual(headers.get('X-Proxy-Fixture'), 'js')
            self.assertEqual(
                body.decode('utf-8'),
                'kind=js;x=legacy;body=;range=',
            )

            status, _headers, body = _request(
                f'http://127.0.0.1:{port}/proxy?{query}',
                method='POST',
                data=b'{"token":"wrong"}',
                headers={'Content-Type': 'application/json'},
            )
            self.assertEqual(status, 401)
            self.assertIn(b'invalid proxy token', body)
        finally:
            legacy = go_proxy._extra_servers.pop(port, None)
            if legacy is not None:
                legacy.shutdown()
                legacy.server_close()


if __name__ == '__main__':
    unittest.main()
