# -*- coding: utf-8 -*-
"""网盘数据面：签名 URL 过期只刷新一次，错误状态不吞掉。"""

from __future__ import annotations

import io
import os
import sys
import unittest
from unittest.mock import patch

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import go_proxy  # noqa: E402


class _Response:
    def __init__(self, status, headers=None):
        self.status_code = status
        self.headers = headers or {}

    def close(self):
        pass


class TestProxyStream(unittest.TestCase):
    def _handler(self):
        handler = object.__new__(go_proxy._Handler)
        handler.headers = {}
        handler.events = []
        handler.send_response = lambda status: handler.events.append(('status', status))
        handler.send_header = lambda key, value: handler.events.append(('header', key, value))
        handler.end_headers = lambda: handler.events.append(('end',))
        handler._stream_single = lambda *args, **kwargs: handler.events.append(('stream', args[0]))
        return handler

    def test_expired_url_refreshes_once_before_headers(self):
        handler = self._handler()
        refreshed = []
        responses = iter([
            _Response(403),
            _Response(200, {'Content-Type': 'video/mp4'}),
        ])

        def refresh():
            refreshed.append(True)
            return 'https://cdn.test/fresh.mp4', {'User-Agent': 'fixture'}

        with patch.object(go_proxy, '_fetch', side_effect=lambda *args, **kwargs: next(responses)):
            handler._stream_forward('https://cdn.test/stale.mp4', {}, True, refresh=refresh)
        self.assertEqual(len(refreshed), 1)
        self.assertIn(('status', 200), handler.events)
        self.assertNotIn(('status', 403), handler.events)

    def test_quark_412_refreshes_once_before_headers(self):
        handler = self._handler()
        refreshed = []
        responses = iter([
            _Response(412),
            _Response(206, {'Content-Range': 'bytes 0-0/100', 'Content-Type': 'video/mp4'}),
        ])

        def refresh():
            refreshed.append(True)
            return 'https://cdn.test/fresh-412.mp4', {'User-Agent': 'fixture'}

        with patch.object(go_proxy, '_fetch', side_effect=lambda *args, **kwargs: next(responses)):
            handler._stream_forward('https://cdn.test/stale-412.mp4', {}, True, refresh=refresh)
        self.assertEqual(len(refreshed), 1)
        self.assertIn(('status', 200), handler.events)
        self.assertNotIn(('status', 412), handler.events)

    def test_unrefreshable_upstream_status_is_returned(self):
        handler = self._handler()
        with patch.object(go_proxy, '_fetch', return_value=_Response(416)):
            handler._stream_forward('https://cdn.test/bad-range', {}, True)
        self.assertIn(('status', 416), handler.events)

    def test_octet_stream_is_normalized_for_the_player(self):
        """夸克 file/download 直链回 application/octet-stream。

        照原样透传，mpv 的格式探测和宿主的媒体探测都会把它判成非媒体而拒播；
        明确的媒体类型（video/audio/HLS）必须原样保留，不能被覆盖成 mp4；
        明确的文本/接口类型（HTTP 200 的软失败）也要原样保留，否则真正的
        失败原因会被伪装成「视频格式不支持」。
        """
        for upstream, expected in (
                ('application/octet-stream', 'video/mp4'),
                ('binary/octet-stream', 'video/mp4'),
                ('application/force-download', 'video/mp4'),
                ('', 'video/mp4'),
                ('application/vnd.apple.mpegurl', 'application/vnd.apple.mpegurl'),
                ('video/x-matroska', 'video/x-matroska'),
                ('audio/mpeg', 'audio/mpeg'),
                ('text/html; charset=utf-8', 'text/html; charset=utf-8'),
                ('application/json', 'application/json'),
        ):
            handler = self._handler()
            with patch.object(go_proxy, '_fetch', return_value=_Response(
                    200, {'Content-Type': upstream})):
                handler._stream_forward('https://cdn.test/pan', {}, True)
            self.assertIn(('header', 'Content-Type', expected), handler.events, upstream)

    def test_legacy_url_probe_does_not_wrap_412_as_200(self):
        handler = object.__new__(go_proxy._Handler)
        handler.headers = {}
        handler.path = ('/?url=https%3A%2F%2Fdl-pc-zb.drive.quark.cn%2Fstale.mp4'
                        '&proxytype=go&thread=32')
        handler.command = 'GET'
        handler.events = []
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: handler.events.append(('status', status))
        handler.send_header = lambda key, value: handler.events.append(('header', key, value))
        handler.end_headers = lambda: handler.events.append(('end',))

        with patch.object(go_proxy, '_fetch', return_value=_Response(412)):
            handler._handle()
        self.assertIn(('status', 412), handler.events)
        self.assertNotIn(('status', 200), handler.events)
        self.assertEqual(handler.wfile.getvalue(), b'upstream HTTP 412')


if __name__ == '__main__':
    unittest.main()
