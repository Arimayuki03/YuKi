# -*- coding: utf-8 -*-
"""FongMi /proxy 契约：参数合并、流式 body 和 recent Spider 路由。"""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import unittest
from unittest.mock import patch

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

from proxy_contract import (  # noqa: E402
    iter_body,
    merge_request_params,
    normalize_proxy_result,
)


class _CloseStream(io.BytesIO):
    def __init__(self, data):
        super().__init__(data)
        self.closed_by_test = False

    def close(self):
        self.closed_by_test = True
        super().close()


class _Runner:
    def __init__(self, value):
        self.value = value
        self.calls = []

    def localProxy(self, params):
        self.calls.append(dict(params))
        return self.value


class _Site:
    def __init__(self, key, kind, value):
        self.key = key
        self.spider_type = kind
        self.runner = _Runner(value)


class _Sites:
    def __init__(self):
        self.items = {
            'js-site': _Site('js-site', 'js', [200, 'text/plain', b'js']),
            'py-site': _Site('py-site', 'py', [200, 'text/plain', b'py']),
        }
        self.recent_key = None

    @property
    def sites(self):
        return list(self.items.values())

    def get(self, key=None):
        return self.items.get(key) if key else next(iter(self.items.values()))

    def recent(self, kind=None):
        if kind:
            return next((s for s in self.items.values() if s.spider_type == kind), None)
        return self.get(self.recent_key) if self.recent_key else self.get()

    def set_recent(self, key):
        self.recent_key = key


class TestProxyContract(unittest.TestCase):
    def test_merge_query_form_and_headers(self):
        params = merge_request_params(
            {'do': 'py', 'url': 'https://example.test/a'},
            {'Range': 'bytes=0-9', 'Cookie': 'secret', 'do': 'header-value'},
            {'x': 'form'},
        )
        self.assertEqual(params['do'], 'py')
        self.assertEqual(params['url'], 'https://example.test/a')
        self.assertEqual(params['x'], 'form')
        self.assertEqual(params['range'], 'bytes=0-9')
        self.assertEqual(params['cookie'], 'secret')

    def test_stream_result_is_not_buffered_and_is_closed(self):
        stream = _CloseStream(b'0123456789')
        result = normalize_proxy_result((206, 'video/mp4', stream, {'Content-Range': 'bytes 0-9/10'}))
        self.assertEqual(result.status, 206)
        self.assertIs(result.body, stream)
        self.assertEqual(b''.join(iter_body(result.body, chunk_size=3)), b'0123456789')
        self.assertTrue(stream.closed_by_test)
        self.assertEqual(result.headers['Content-Range'], 'bytes 0-9/10')

    def test_dict_result_is_json_bytes(self):
        result = normalize_proxy_result({'ok': True, 'name': '测试'})
        self.assertEqual(result.status, 200)
        self.assertIn('application/json', result.mime)
        self.assertIn('测试', result.body.decode('utf-8'))

    def test_consumed_requests_response_uses_content(self):
        import requests  # noqa: PLC0415

        response = requests.Response()
        response.status_code = 200
        response.headers['Content-Type'] = 'text/plain'
        response.raw = io.BytesIO(b'raw-is-already-consumed')
        response._content = b'content-body'
        response._content_consumed = True
        result = normalize_proxy_result(response)
        self.assertEqual(result.body, b'content-body')

    def test_server_builds_streaming_response(self):
        import server  # noqa: PLC0415
        from starlette.responses import StreamingResponse  # noqa: PLC0415

        response = server.build_proxy_response(
            (206, 'video/mp4', io.BytesIO(b'abc'), {'Content-Range': 'bytes 0-2/3'})
        )
        self.assertIsInstance(response, StreamingResponse)
        self.assertEqual(response.status_code, 206)

        async def collect():
            return b''.join([chunk async for chunk in response.body_iterator])

        self.assertEqual(asyncio.run(collect()), b'abc')

    def test_player_result_normalizes_jx_and_headers(self):
        import server  # noqa: PLC0415

        raw = '{"url":"https://example.test/v.m3u8","jx":1,"header":"{\\"Referer\\":\\"https://example.test/\\"}","headers":{"X-Test":"1"}}'
        normalized = json.loads(server._normalize_play_result(raw, '线路A'))
        self.assertEqual(normalized['parse'], 1)
        self.assertEqual(normalized['header']['Referer'], 'https://example.test/')
        self.assertEqual(normalized['header']['X-Test'], '1')
        self.assertEqual(normalized['flag'], '线路A')

    def test_server_routes_site_key_and_recent_engine(self):
        import server  # noqa: PLC0415

        fake_sites = _Sites()
        with patch.object(server, 'sites', fake_sites):
            direct = server.do_local_proxy({'siteKey': 'js-site', 'do': 'js', 'x': '1'})
            self.assertEqual(direct[2], b'js')
            self.assertEqual(fake_sites.items['js-site'].runner.calls[-1]['x'], '1')

            recent = server.do_local_proxy({'do': 'py', 'x': '2'})
            self.assertEqual(recent[2], b'py')
            self.assertEqual(fake_sites.recent_key, 'py-site')

    def test_server_pan_without_site_returns_go_proxy_url(self):
        import server  # noqa: PLC0415

        # 即使存在最近的普通 Spider，宿主级 do=pan 也不能误调用它。
        fake_sites = _Sites()
        with patch.object(server, 'sites', fake_sites):
            value = server.do_local_proxy({'do': 'pan', 'fileId': 'fid-1'})
        self.assertTrue(value.startswith('http://127.0.0.1:'))
        self.assertIn('/proxy?', value)
        self.assertIn('fileId=fid-1', value)

        with patch.object(server, 'sites', fake_sites):
            value = server.do_local_proxy({'do': 'pan', 'site': 'quark', 'fileId': 'fid-2'})
        self.assertIn('site=quark', value)
        self.assertIn('fileId=fid-2', value)


if __name__ == '__main__':
    unittest.main()
