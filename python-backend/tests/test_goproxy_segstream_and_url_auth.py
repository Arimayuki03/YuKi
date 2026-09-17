# -*- coding: utf-8 -*-
"""#7 / #8 修复的针对性回归。

#7：go_proxy._SegStream 的 _put 错捕 queue.Empty（实抛 queue.Full）导致
    下载线程死亡 + stream 永久挂死。回归点：
    a) 队列满时下载线程不炸、流以错误收场（而非挂死或错序重灌）；
    b) stream 超时 / 取消能退出。
#8：/proxy 的 ？url= 通道免鉴权 + 任意转发（开放代理）。回归点：
    c) 无 token 被拒；带有效 token 且目标公网放行；
       YUKI_CONFIG_BLOCK_PRIVATE_NETWORK=1 时私网目标被拒。
"""

from __future__ import annotations

import io
import os
import queue
import sys
import threading
import time
import unittest
from unittest.mock import patch

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import go_proxy  # noqa: E402
import hoststate  # noqa: E402


class _FakeThread:
    """替身线程：只用于 stream() 的 is_alive() 判定。"""

    def __init__(self, alive=True):
        self._alive = alive

    def is_alive(self):
        return self._alive


class _FakeResponse:
    """最小 _fetch 响应：status 206 + 可迭代 chunk。"""

    def __init__(self, chunks, status=206, delay=0.0):
        self.status_code = status
        self.headers = {'Content-Range': 'bytes 0-99/100'}
        self._chunks = list(chunks)
        self._delay = delay

    def iter_content(self, size):
        for chunk in self._chunks:
            if self._delay:
                time.sleep(self._delay)
            yield chunk

    def close(self):
        pass


class TestQueueFullSegStream(unittest.TestCase):
    """#7-a：_put 队列满 → 下载线程存活、流以错误收场。"""

    def _seg(self, n=1):
        w = go_proxy._SegStream('https://cdn.test/a.mp4', {}, 0, 99, n)
        # 测试加速：空闲拍等待缩短（正常路径判定见各用例）
        w.get_timeout = 0.2
        w.get_max_idle_ticks = 2
        return w

    def test_put_full_blocks_until_cancel_not_give_up(self):
        """队列满 + 消费端存活是 ≥32MB 分段的正常背压稳态：阻塞等待而非按
        计时放弃（放弃会让大文件播放断流）；_cancel 置位后立即退出。"""
        w = self._seg()
        q = queue.Queue(maxsize=1)
        q.put(b'x')
        self.assertTrue(w._put.__doc__)
        result = []

        def run():
            result.append(w._put(q, b'y'))

        t = threading.Thread(target=run, daemon=True)
        t.start()
        time.sleep(0.5)  # 期间队列持续满：旧「计时放弃」实现此时已返回 False
        self.assertTrue(t.is_alive(), 'put must keep waiting under backpressure')
        self.assertEqual(q.get_nowait(), b'x')
        t.join(timeout=5)  # 队列腾空后 put 成功返回
        self.assertFalse(t.is_alive())
        self.assertEqual(result, [True])

        # 消费端取消：put 立即放弃返回 False（不抛 queue.Full）
        w2 = self._seg()
        q2 = queue.Queue(maxsize=1)
        q2.put_nowait(b'x')
        w2._cancel.set()
        self.assertFalse(w2._put(q2, b'y'))

    def test_put_fatal_sentinel_beats_backpressure(self):
        """消费端持续取走数据时，哨兵最终入队成功。"""
        w = self._seg()
        q = queue.Queue(maxsize=1)
        stop = threading.Event()

        def drain():
            while not stop.is_set():
                try:
                    q.get(timeout=0.05)
                except queue.Empty:
                    pass

        t = threading.Thread(target=drain, daemon=True)
        t.start()
        try:
            self.assertTrue(w._put(q, RuntimeError('boom')))
        finally:
            stop.set()
            t.join(timeout=2)

    def test_dl_thread_never_dies_when_queue_stays_full(self):
        """消费端不取数且未取消：下载线程阻塞在 _put（存活、不炸、不重下）。"""
        w = self._seg()
        # 换小容量队列并填满且无人消费：旧实现 chunk put 抛 Full →
        # except Exception → 重下整段 → 收尾哨兵再裸抛 → 线程死亡（无哨兵
        # → stream 挂死）。
        w._queues[0] = queue.Queue(maxsize=2)
        for chunk in (b'a', b'b'):
            w._queues[0].put_nowait(chunk)
        errors = []
        resp = _FakeResponse([b'c', b'd', b'e'])

        def run():
            try:
                with patch.object(go_proxy, '_fetch', return_value=resp):
                    w._dl(0)
            except BaseException as exc:  # 旧缺陷路径：queue.Full 炸线程
                errors.append(exc)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        time.sleep(1.0)
        self.assertTrue(t.is_alive(),
                        'thread must survive a full queue (no exception ladder)')
        self.assertEqual(errors, [])
        self.assertEqual(len(resp._chunks), 3,
                         'must NOT re-download the segment on queue-full')
        # 既有数据未被重复灌入破坏（字节序不变量）
        self.assertEqual(w._queues[0].get_nowait(), b'a')
        self.assertEqual(w._queues[0].get_nowait(), b'b')
        # 收场：取消后线程立即退出（无泄漏、无裸奔异常）
        w._cancel.set()
        t.join(timeout=5)
        self.assertFalse(t.is_alive())

    def test_stream_ends_with_error_when_dl_thread_dies(self):
        """下载线程死亡（无哨兵）时 stream 以错误收场，不永久挂死。"""
        w = self._seg()
        w._threads = [_FakeThread(alive=False)]
        out = io.BytesIO()
        start = time.monotonic()
        with self.assertRaises(Exception):
            w.stream(out)
        self.assertLess(time.monotonic() - start, 10,
                        'stream must not hang when producer is dead')
        self.assertTrue(w._cancel.is_set())

    def test_stream_stalled_consumer_times_out(self):
        """多拍无产出（下载挂起 + 消费停滞）→ stream 按错误收场。"""
        w = self._seg()
        w._threads = [_FakeThread(alive=True)]

        def never_fetch(*args, **kwargs):
            time.sleep(60)  # 模拟上游挂死
            return _FakeResponse([b'x'])

        out = io.BytesIO()
        start = time.monotonic()
        with patch.object(go_proxy, '_fetch', side_effect=never_fetch), \
                patch.object(go_proxy._SegStream, 'start', lambda self: None):
            with self.assertRaises(Exception):
                w.start()
                w.stream(out)
        self.assertLess(time.monotonic() - start, 10,
                        'stalled stream must end by idle-tick bound')
        self.assertTrue(w._cancel.is_set())

    def test_stream_cancel_event_exits_promptly(self):
        """取消事件置位后 stream 不再无限等待。"""
        w = self._seg()
        w._threads = [_FakeThread(alive=True)]

        def canceller():
            time.sleep(0.3)
            w._cancel.set()

        threading.Thread(target=canceller, daemon=True).start()
        out = io.BytesIO()
        start = time.monotonic()
        with self.assertRaises(Exception):
            w.stream(out)
        self.assertLess(time.monotonic() - start, 10)
        self.assertTrue(w._cancel.is_set())

    def test_happy_path_ordering_unchanged(self):
        """正常路径：多段按序消费、字节序与文件一致（回归旧行为）。"""
        w = go_proxy._SegStream('https://cdn.test/a.mp4', {}, 0, 11, 3)
        w.get_timeout = 5.0
        segs = [[b'ab', b'cd'], [b'ef', b'gh'], [b'ij']]
        responses = [_FakeResponse(segs[i]) for i in range(3)]
        with patch.object(go_proxy, '_fetch',
                          side_effect=lambda *a, **k: responses.pop(0)):
            w.start()
            out = io.BytesIO()
            w.stream(out)
        self.assertEqual(out.getvalue(), b'abcdefghij')
        for t in w._threads:
            self.assertFalse(t.is_alive())


class TestGoProxyUrlChannelAuth(unittest.TestCase):
    """#8-c：？url= 通道 token 门禁 + 私网边界。"""

    def setUp(self):
        self.old_state = {'port': hoststate.get_port(), 'token': hoststate.get_token()}
        hoststate.configure(token='tok-123')
        self.handler = object.__new__(go_proxy._Handler)
        self.handler.headers = {}
        self.handler.path = '/proxy?url=https%3A%2F%2Fcdn.test%2Fa.mp4'
        self.handler.command = 'GET'
        self.handler._headers_sent = False
        self.events = []
        self.handler.send_response = lambda s: self.events.append(('status', s))
        self.handler.send_header = lambda k, v: self.events.append(('header', k, v))
        self.handler.end_headers = lambda: self.events.append(('end',))
        self.wfile = io.BytesIO()
        self.handler.wfile = self.wfile

    def tearDown(self):
        hoststate.configure(**self.old_state)

    def _request(self, query, headers=None):
        self.handler.headers = headers or {}
        self.handler.path = '/proxy' + (query or '')
        with patch.object(go_proxy, '_fetch',
                          return_value=_FakeResponse([b'x'], status=200)), \
                patch.object(go_proxy._Handler, '_stream_single',
                             lambda self, *a, **k: None):
            self.handler._handle()
        return self.events

    def test_missing_token_rejected(self):
        events = self._request('?url=https%3A%2F%2Fcdn.test%2Fa.mp4')
        self.assertIn(('status', 401), events)
        self.assertNotIn(('status', 200), events)
        self.assertIn(b'requires valid token', self.wfile.getvalue())

    def test_wrong_token_rejected(self):
        events = self._request('?url=https%3A%2F%2Fcdn.test%2Fa.mp4&token=bad')
        self.assertIn(('status', 401), events)
        events = self._request('?url=https%3A%2F%2Fcdn.test%2Fa.mp4',
                               headers={'X-Proxy-Token': 'bad'})
        self.assertIn(('status', 401), events)

    def test_valid_token_query_allows_public_target(self):
        events = self._request('?url=https%3A%2F%2Fcdn.test%2Fa.mp4&token=tok-123')
        self.assertIn(('status', 200), events)
        self.assertNotIn(('status', 401), events)

    def test_valid_token_header_allows_public_target(self):
        events = self._request('?url=https%3A%2F%2Fcdn.test%2Fa.mp4',
                               headers={'X-Proxy-Token': 'tok-123'})
        self.assertIn(('status', 200), events)

    def test_private_target_allowed_by_default(self):
        """默认（未设 YUKI_CONFIG_BLOCK_PRIVATE_NETWORK）：私网目标放行。"""
        from runtime.config_security import reset_dns_cache
        reset_dns_cache()
        target = 'http://10.0.0.5:8080/lan.mkv'
        events = self._request('?url=' + go_proxy.urllib.parse.quote(target, safe='')
                               + '&token=tok-123')
        self.assertIn(('status', 200), events)

    def test_private_target_blocked_when_env_set(self):
        """YUKI_CONFIG_BLOCK_PRIVATE_NETWORK=1：私网目标必须拒绝。"""
        from runtime.config_security import reset_dns_cache
        reset_dns_cache()
        with patch.dict(os.environ, {'YUKI_CONFIG_BLOCK_PRIVATE_NETWORK': '1'}):
            target = 'http://192.168.1.10:8080/lan.mkv'
            events = self._request('?url=' + go_proxy.urllib.parse.quote(target, safe='')
                                   + '&token=tok-123')
        self.assertIn(('status', 403), events)
        self.assertNotIn(('status', 200), events)

    def test_loopback_target_blocked_when_env_set(self):
        from runtime.config_security import reset_dns_cache
        reset_dns_cache()
        with patch.dict(os.environ, {'YUKI_CONFIG_BLOCK_PRIVATE_NETWORK': '1'}):
            target = 'http://127.0.0.1:9978/proxy?do=ck'
            events = self._request('?url=' + go_proxy.urllib.parse.quote(target, safe='')
                                   + '&token=tok-123')
        self.assertIn(('status', 403), events)


class TestServerTokenAttach(unittest.TestCase):
    """server._normalize_play_result 给旧 jar 的 ？url= 通道补 token。"""

    def setUp(self):
        import server
        self.server = server
        self.old_state = {'port': hoststate.get_port(), 'token': hoststate.get_token()}
        hoststate.configure(token='tok-xyz')

    def tearDown(self):
        hoststate.configure(**self.old_state)

    def _normalize_url(self, raw):
        result = self.server._normalize_play_result({'url': raw})
        import json as _json
        return _json.loads(result)['url']

    def test_legacy_jar_url_gets_token(self):
        out = self._normalize_url(
            'http://127.0.0.1:7944/?url=https%3A%2F%2Fdl.quark.cn%2Fa.mp4'
            '&proxytype=go&thread=32')
        self.assertIn('token=tok-xyz', out)
        self.assertIn('proxytype=go', out)

    def test_existing_token_not_duplicated(self):
        raw = ('http://127.0.0.1:9978/proxy?url=https%3A%2F%2Fdl.quark.cn%2Fa.mp4'
               '&token=tok-xyz')
        self.assertEqual(self._normalize_url(raw), raw)

    def test_non_local_and_do_pan_urls_untouched(self):
        raw = 'https://example.com/play?url=x'
        self.assertEqual(self._normalize_url(raw), raw)
        raw2 = 'http://127.0.0.1:9978/proxy?do=pan&site=quark&fileId=f1'
        self.assertEqual(self._normalize_url(raw2), raw2)


if __name__ == '__main__':
    unittest.main()
