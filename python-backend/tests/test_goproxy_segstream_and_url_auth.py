# -*- coding: utf-8 -*-
"""#7 / #8 修复及 C 组（H-6 / H-7）修复的针对性回归。

#7：go_proxy._SegStream 的 _put 错捕 queue.Empty（实抛 queue.Full）导致
    下载线程死亡 + stream 永久挂死。回归点：
    a) 队列满时下载线程不炸、流以错误收场（而非挂死或错序重灌）；
    b) stream 超时 / 取消能退出。
#8：/proxy 的 ？url= 通道免鉴权 + 任意转发（开放代理）。回归点：
    c) 无 token 被拒；带有效 token 且目标公网放行；
       YUKI_CONFIG_BLOCK_PRIVATE_NETWORK=1 时私网目标被拒。
H-6：_SegStream._dl 接受 HTTP 200 且不校验 Content-Range、不按段长截断。
    回归点：
    d) 上游忽略 Range 回 200 → 按错误重试并中断流，不灌数据；
    e) 206 但 Content-Range 区间错位 → 同样按错误处理；
    f) 206 区间正确但响应体超出段长 → 按段长截断。
H-7：HLS 重写仅在 total 未知分支执行，Range 探测回 206+Content-Range
    （nginx CDN 常态）时跳过 m3u8 重写直接透传。回归点：
    g) ？url= 通道探测回 206+Content-Range 且 Content-Type 为 m3u8 → 仍重写；
    h) do=pan 数据面（_stream_forward）同上仍重写。
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


def _await_threads(w, timeout=10.0):
    """等待 _SegStream 的全部下载线程真正收尾（join），不做存活断言。

    ``stream()`` 收到段哨兵即返回，此刻生产者线程**仍在收尾**：它刚从
    ``_put(q, None)`` 返回、正退出 ``_dl`` 栈帧并销毁线程对象，这段窗口内
    ``is_alive()`` 仍为 True——这是完全正当的中间态，不是线程泄漏。

    裸 ``assertFalse(t.is_alive())`` 会把这个窗口判成失败。窗口通常只有微秒
    级，单机空跑几乎撞不上；机器负载高时（编排跑到本阶段时系统较忙）主线程
    恰好在这个窗口里被调度，断言就偶发失败——本文件此前 flaky 的根因即此。
    先 join 再断言是唯一可靠的终止判定：join 超时后仍存活才是真泄漏。
    """
    for t in w._threads:
        t.join(timeout)


def _assert_threads_stopped(case, w, timeout=10.0):
    """断言全部下载线程已收尾（join 之后才判定，见 _await_threads）。"""
    _await_threads(w, timeout)
    for i, t in enumerate(w._threads):
        case.assertFalse(t.is_alive(), '段 %d 下载线程未收尾（泄漏）' % i)


class _FakeResponse:
    """最小 _fetch 响应：status 206 + 可迭代 chunk。"""

    def __init__(self, chunks, status=206, delay=0.0, headers=None):
        self.status_code = status
        self.headers = dict(headers or {'Content-Range': 'bytes 0-99/100'})
        self._chunks = list(chunks)
        self._delay = delay

    def iter_content(self, size):
        for chunk in self._chunks:
            if self._delay:
                time.sleep(self._delay)
            yield chunk

    def close(self):
        pass


class _Response:
    """最小静态响应：带 content 字段（_send_hls_playlist 整体读取用）。"""

    def __init__(self, status, headers=None, content=b''):
        self.status_code = status
        self.headers = headers or {}
        self.content = content

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
        # H-6 后上游契约：206 + 与请求区间一致的 Content-Range。
        # 替身按请求的 (start, end) 区间取响应，而不是按调用到达序 pop(0)：
        # 段线程并发启动，到达 _fetch 的先后顺序不保证是 0,1,2；pop(0) 会把
        # 段 1 的响应发给先到的段 0，Content-Range 校验随即把它判为区间错位
        # 进入重试阶梯，三次耗尽后列表已被取空 → 'pop from empty list' →
        # 错误哨兵入队 → stream() 抛错、字节序断言失败。与线程收尾竞态同为
        # 本文件在编排下偶发失败的根因（负载高时到达序更容易乱）。
        by_range = {}
        for i in range(3):
            s = i * 4
            e = min((i + 1) * 4 - 1, 11)
            by_range[(s, e)] = _FakeResponse(
                segs[i], status=206,
                headers={'Content-Range': 'bytes %d-%d/12' % (s, e)})
        with patch.object(go_proxy, '_fetch',
                          side_effect=lambda url, headers, s, e, timeout=60:
                              by_range[(s, e)]):
            w.start()
            out = io.BytesIO()
            w.stream(out)
        self.assertEqual(out.getvalue(), b'abcdefghij')
        _assert_threads_stopped(self, w)


class TestSegStreamRangeContract(unittest.TestCase):
    """H-6：_dl 必须要求 206 + Content-Range 区间校验 + 按段长截断。

    上游忽略 Range 回 200 时，每个分段线程都会灌入整文件数据（n 倍重复）；
    206 但区间错位时字节序错乱。二者都必须按错误走重试阶梯，耗尽后中断流。
    走真实下载线程（不替换 start），get_timeout 缩短加速收场。
    """

    def _seg(self, n=2):
        w = go_proxy._SegStream('https://cdn.test/a.mp4', {}, 0, 99, n)
        # 测试加速：空闲拍等待缩短
        w.get_timeout = 0.2
        w.get_max_idle_ticks = 2
        return w

    @staticmethod
    def _drain(w):
        out = io.BytesIO()
        try:
            w.stream(out)
        except Exception:
            pass
        return out.getvalue()

    def test_http_200_is_rejected_not_ingested(self):
        """上游忽略 Range 回 200：不灌任何数据，重试耗尽后中断流。"""
        w = self._seg(n=1)
        # 重试阶梯含真实退避（0.3s/0.6s）：空闲拍上限放宽到足以让 3 次
        # 尝试全部跑完，错误哨兵到达即提前收场。
        w.get_max_idle_ticks = 15
        fetches = []

        def fake_fetch(url, headers, s, e, timeout=60):
            fetches.append((s, e))
            # 返回 200（忽略 Range），响应体故意塞入远超段长的数据：
            # 修复前会被整体灌进队列造成 n 倍重复字节
            return _FakeResponse([b'0123456789'] * 20, status=200,
                                 headers={'Content-Length': '200'})

        with patch.object(go_proxy, '_fetch', side_effect=fake_fetch):
            w.start()
            out = self._drain(w)
        self.assertEqual(out, b'', 'HTTP 200 must not be ingested into the stream')
        # 重试阶梯耗尽（3 次）
        self.assertGreaterEqual(len(fetches), 3)
        self.assertTrue(w._cancel.is_set())
        _assert_threads_stopped(self, w)

    def test_mismatched_content_range_is_rejected(self):
        """206 但 Content-Range 与请求区间错位：按错误处理，不灌数据。"""
        w = self._seg(n=1)
        # 请求区间是 bytes 0-99，响应谎称 bytes 100-199
        resp = _FakeResponse([b'x' * 100], status=206,
                             headers={'Content-Range': 'bytes 100-199/200'})

        with patch.object(go_proxy, '_fetch', return_value=resp):
            w.start()
            out = self._drain(w)
        self.assertEqual(out, b'', 'mismatched Content-Range must not be ingested')
        self.assertTrue(w._cancel.is_set())

    def test_matching_content_range_allows_ingest(self):
        """206 且 Content-Range 区间与请求一致：正常灌数（回归既有行为）。"""
        w = self._seg(n=2)
        segs = {0: [b'ab', b'cd'], 1: [b'ef', b'gh', b'ij', b'kl']}

        def fake_fetch(url, headers, s, e, timeout=60):
            return _FakeResponse(
                segs[0 if s == 0 else 1], status=206,
                headers={'Content-Range': 'bytes %d-%d/100' % (s, e)})

        with patch.object(go_proxy, '_fetch', side_effect=fake_fetch):
            w.start()
            out = self._drain(w)
        self.assertEqual(out, b'abcdefghijkl')
        _assert_threads_stopped(self, w)

    def test_oversized_response_is_truncated_to_segment_length(self):
        """206 区间正确但响应体超出段长：必须截断，多余字节不进队列。"""
        # 区间 0-99 共 100 字节；响应体给了 130 字节
        w = self._seg(n=1)

        def fake_fetch(url, headers, s, e, timeout=60):
            return _FakeResponse([b'x' * 30, b'y' * 100], status=206,
                                 headers={'Content-Range': 'bytes 0-99/100'})

        with patch.object(go_proxy, '_fetch', side_effect=fake_fetch):
            w.start()
            out = self._drain(w)
        self.assertEqual(out, b'x' * 30 + b'y' * 70,
                         'output must be truncated to the requested segment length')
        self.assertEqual(len(out), 100)
        _assert_threads_stopped(self, w)


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


class TestHlsRewriteOnKnownTotal(unittest.TestCase):
    """H-7：Content-Type 是 m3u8 就必须重写，与探测是否拿到 total 无关。

    Range 探测（bytes=0-0）对 nginx 一类源站常态回 206+Content-Range
    （total 已知）：修复前重写仅挂在「total 未知」分支，m3u8 被当普通
    媒体透传——相对分片按代理基址解析必 404，绝对分片直连 CDN 缺
    Cookie/Referer 被拒。
    """

    M3U8 = b'#EXTM3U\n#EXTINF:2.0,\nseg0.ts?auth=k\n'

    @staticmethod
    def _stub_writer(handler):
        """替身响应写出：真实 send_response 会访问 requestline 等连接态。"""
        handler._headers_sent = False
        handler.wfile = io.BytesIO()
        handler.send_response = lambda code: (
            setattr(handler, '_headers_sent', True),
            handler.wfile.write(b'HTTP/1.0 %d\r\n' % code))
        handler.send_header = lambda k, v: handler.wfile.write(
            ('%s: %s\r\n' % (k, v)).encode('utf-8'))
        handler.end_headers = lambda: handler.wfile.write(b'\r\n')

    @classmethod
    def _url_handler(cls):
        """？url= 通道（_handle）的处理器替身。"""
        handler = object.__new__(go_proxy._Handler)
        handler.headers = {}
        handler.path = ('/proxy?url=https%3A%2F%2Fcdn.quark.test%2Flive%2Fhls.m3u8'
                        '&token=tok-123')
        handler.command = 'GET'
        cls._stub_writer(handler)
        return handler

    def test_url_channel_206_probe_still_rewrites_hls(self):
        """探测回 206+Content-Range 且 Content-Type 为 m3u8 → 仍整体取回重写。"""
        handler = self._url_handler()
        probe = _Response(206, {'Content-Type': 'application/vnd.apple.mpegurl',
                                'Content-Range': 'bytes 0-0/1234'},
                          content=self.M3U8)
        fetch = _Response(200, {'Content-Type': 'application/vnd.apple.mpegurl'},
                          content=self.M3U8)
        old_state = {'token': hoststate.get_token(), 'port': hoststate.get_port()}
        hoststate.configure(token='tok-123')
        try:
            with patch.object(go_proxy, '_fetch', side_effect=[probe, fetch]):
                handler._handle()
        finally:
            hoststate.configure(**old_state)
        written = handler.wfile.getvalue().decode('utf-8')
        # 相对分片必须被包回代理转发，而不是按 127.0.0.1 基址原样透传
        self.assertIn('http://127.0.0.1:9978/proxy?url=', written)
        self.assertIn('seg0.ts', written)
        self.assertIn('application/vnd.apple.mpegurl', written)

    @classmethod
    def _stream_forward_handler(cls):
        """do=pan 数据面（_stream_forward）的处理器替身。"""
        handler = object.__new__(go_proxy._Handler)
        handler.headers = {}
        cls._stub_writer(handler)
        return handler

    def test_pan_stream_forward_206_probe_still_rewrites_hls(self):
        """H-7（do=pan 数据面）：探测回 206+Content-Range 且 m3u8 仍重写。"""
        handler = self._stream_forward_handler()
        probe = _Response(206, {'Content-Type': 'application/vnd.apple.mpegurl',
                                'Content-Range': 'bytes 0-0/4321'},
                          content=self.M3U8)
        fetch = _Response(200, {'Content-Type': 'application/vnd.apple.mpegurl'},
                          content=self.M3U8)
        with patch.object(go_proxy, '_fetch', side_effect=[probe, fetch]):
            handler._stream_forward('https://cdn.quark.test/live/hls.m3u8',
                                    {}, False, valid_token='tok-123')
        written = handler.wfile.getvalue().decode('utf-8')
        self.assertIn('http://127.0.0.1:9978/proxy?url=', written)
        self.assertIn('seg0.ts', written)


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

    def test_non_local_urls_untouched_and_do_pan_gets_token(self):
        raw = 'https://example.com/play?url=x'
        self.assertEqual(self._normalize_url(raw), raw)
        # P1-3：do=pan 通道加 token 门禁后，旧 jar 硬编码的 do=pan 地址
        # （无 url= 参数）由 _attach_go_proxy_channel_token 统一补 token，
        # 否则会被新门禁 401（旧断言「do=pan 原样不动」随批次 1 失效）。
        raw2 = 'http://127.0.0.1:9978/proxy?do=pan&site=quark&fileId=f1'
        out2 = self._normalize_url(raw2)
        self.assertIn('token=tok-xyz', out2)
        self.assertIn('do=pan', out2)
        # 已带 token 的 do=pan 地址不重复附加
        raw3 = raw2 + '&token=tok-xyz'
        self.assertEqual(self._normalize_url(raw3), raw3)


if __name__ == '__main__':
    unittest.main()
