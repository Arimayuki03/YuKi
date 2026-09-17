# -*- coding: utf-8 -*-
"""quickjs_host 宿主级安全边界回归（issue #10 三项修复）：
1. 限额 API 缺失/设置失败 → fail-closed 拒载（JsEngineUnavailableError），
   上层把站点呈现为「不可用」而不是无限额跑远端代码；
2. _native_http timeout clamp（1s~60s，非法值取边界/默认）；
3. 响应体流式限长（32MB 上限，超限中止并按 500 错误呈现给 JS 侧）。
"""
import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)
JS_ENGINE_DIR = os.path.join(BACKEND_DIR, 'js-engine')
if JS_ENGINE_DIR not in sys.path:
    sys.path.insert(0, JS_ENGINE_DIR)

import quickjs_host
from quickjs_host import (JsEngine, JsEngineUnavailableError,
                          HTTP_TIMEOUT_MAX, HTTP_TIMEOUT_MIN,
                          HTTP_TIMEOUT_DEFAULT, HTTP_MAX_RESPONSE_BYTES,
                          _clamp_timeout)


class _FakeLimitedContext:
    """可配置限额 API 存缺/行为的 quickjs.Context 替身。"""

    def __init__(self, *, missing=(), fail=None, ok_apis=True):
        self.missing = set(missing)
        self.fail = fail or {}
        self.calls = {}
        self.callables = []
        if ok_apis:
            for name in ('set_time_limit', 'set_memory_limit', 'set_max_stack_size'):
                if name in self.missing:
                    continue
                setattr(self, name, self._make(name))

    def _make(self, name):
        def fn(value):
            self.calls[name] = value
            exc = self.fail.get(name)
            if exc is not None:
                raise exc
        return fn

    def add_callable(self, name, fn):
        self.callables.append(name)

    def eval(self, src):
        return 0


def _make_engine(**ctx_kw):
    with patch.object(quickjs_host.quickjs, 'Context',
                      return_value=_FakeLimitedContext(**ctx_kw)), \
         patch.object(JsEngine, '_bootstrap', lambda self: None):
        return JsEngine(site_key='limit_test')


class TestRuntimeLimitsFailClosed(unittest.TestCase):
    """限额是安全前提：缺失/设置失败都必须拒绝加载，绝不静默降级。"""

    def test_missing_api_raises(self):
        with self.assertRaises(JsEngineUnavailableError) as cm:
            _make_engine(missing=('set_memory_limit',))
        msg = str(cm.exception)
        self.assertIn('set_memory_limit', msg)
        self.assertIn('站点不可用', msg)
        self.assertIn('quickjs-ng', msg)

    def test_set_failure_raises(self):
        with self.assertRaises(JsEngineUnavailableError) as cm:
            _make_engine(fail={'set_time_limit': RuntimeError('rt error')})
        msg = str(cm.exception)
        self.assertIn('set_time_limit', msg)
        self.assertIn('设置失败', msg)
        self.assertIn('rt error', msg)

    def test_all_limits_applied_when_available(self):
        engine = _make_engine()
        self.assertEqual(engine.ctx.calls.get('set_time_limit'), 30)
        self.assertEqual(engine.ctx.calls.get('set_memory_limit'), 256 * 1024 * 1024)
        self.assertEqual(engine.ctx.calls.get('set_max_stack_size'), 1024 * 1024)

    def test_error_is_valueerror_for_upper_layer(self):
        # 上层（config._load_js_spider / site_worker._build）按 except Exception
        # 捕获后包 [L3:js] / 回 ready ok=False —— ValueError 即可走既有路径。
        try:
            _make_engine(missing=('set_time_limit',))
        except JsEngineUnavailableError as e:
            self.assertIsInstance(e, ValueError)
        else:
            self.fail('expected JsEngineUnavailableError')


class TestNativeHttpTimeoutClamp(unittest.TestCase):
    def _captured_kwargs(self, options):
        captured = {}

        def fake_get(url, **kwargs):
            captured.update(kwargs)
            rsp = MagicMock()
            rsp.status_code = 200
            rsp.headers = {'Content-Type': 'text/plain'}
            rsp.iter_content = lambda n: iter([b'ok'])
            return rsp

        with patch.dict(os.environ, {'YUKI_CONFIG_SKIP_DNS_SCOPE': '1'}), \
             patch.object(quickjs_host.http_client, 'get', fake_get):
            res = json.loads(quickjs_host._native_http('https://example.invalid/x', options))
        self.assertTrue(res['ok'], res)
        return captured

    def test_oversized_timeout_clamped_to_max(self):
        captured = self._captured_kwargs(json.dumps({'timeout': 999999}))
        self.assertEqual(captured['timeout'], HTTP_TIMEOUT_MAX)

    def test_zero_and_negative_clamped_to_min(self):
        for bad in ('0', '-5'):
            captured = self._captured_kwargs(json.dumps({'timeout': json.loads(bad)}))
            self.assertEqual(captured['timeout'], HTTP_TIMEOUT_MIN)

    def test_illegal_values_fall_back_to_default(self):
        for bad in ('abc', None, True, [10]):
            captured = self._captured_kwargs(json.dumps({'timeout': bad}))
            self.assertEqual(captured['timeout'], HTTP_TIMEOUT_DEFAULT)

    def test_valid_value_kept(self):
        captured = self._captured_kwargs(json.dumps({'timeout': 7.5}))
        self.assertEqual(captured['timeout'], 7.5)

    def test_clamp_function_bounds(self):
        self.assertEqual(_clamp_timeout(0), HTTP_TIMEOUT_MIN)
        self.assertEqual(_clamp_timeout(-1), HTTP_TIMEOUT_MIN)
        self.assertEqual(_clamp_timeout(10 ** 9), HTTP_TIMEOUT_MAX)
        self.assertEqual(_clamp_timeout(float('nan')), HTTP_TIMEOUT_DEFAULT)
        self.assertEqual(_clamp_timeout('oops'), HTTP_TIMEOUT_DEFAULT)
        self.assertEqual(_clamp_timeout(5), 5)
        self.assertTrue(HTTP_TIMEOUT_MIN <= _clamp_timeout(None) <= HTTP_TIMEOUT_MAX)


class _OverflowStream:
    """模拟无限流：每次迭代都吐满块，验证超限时立即中止且连接被关闭。"""

    def __init__(self, limit):
        self.limit = limit
        self.sent = 0
        self.closed = False

    def iter_content(self, chunk_size):
        while True:
            yield b'x' * chunk_size

    def __iter__(self):
        while self.sent < self.limit + 8 * 1024 * 1024:
            self.sent += 64 * 1024
            yield b'x' * 64 * 1024

    def close(self):
        self.closed = True


class TestNativeHttpBodyCap(unittest.TestCase):
    def _run(self, rsp, options='{}'):
        with patch.dict(os.environ, {'YUKI_CONFIG_SKIP_DNS_SCOPE': '1'}), \
             patch.object(quickjs_host.http_client, 'get', return_value=rsp):
            return json.loads(quickjs_host._native_http('https://example.invalid/x', options))

    def test_oversized_body_aborts(self):
        rsp = MagicMock()
        rsp.status_code = 200
        rsp.headers = {'Content-Type': 'text/plain'}
        rsp.iter_content = lambda n: iter([b'x' * n] * (HTTP_MAX_RESPONSE_BYTES // n + 4))
        rsp.close = MagicMock()
        res = self._run(rsp)
        self.assertFalse(res['ok'])
        self.assertEqual(res['status'], 500)
        rsp.close.assert_called_once()

    def test_stream_reader_stops_at_limit(self):
        stream = _OverflowStream(HTTP_MAX_RESPONSE_BYTES)
        with self.assertRaises(ValueError) as cm:
            quickjs_host._read_body_capped(stream, 'https://example.invalid/x')
        self.assertIn('32MB', str(cm.exception))
        self.assertTrue(stream.closed)

    def test_normal_body_ok_and_headers_preserved(self):
        payload = json.dumps({'hello': 'world'}).encode('utf-8')
        rsp = MagicMock()
        rsp.status_code = 200
        rsp.headers = {'Content-Type': 'application/json; charset=utf-8',
                       'X-Custom': 'keep'}
        rsp.iter_content = lambda n: iter([payload])
        res = self._run(rsp)
        self.assertTrue(res['ok'])
        self.assertEqual(json.loads(res['content'])['hello'], 'world')
        self.assertEqual(res['headers'].get('X-Custom'), 'keep')

    def test_gzip_body_decompressed(self):
        import gzip as _gzip
        raw = _gzip.compress('压缩内容'.encode('utf-8'))
        rsp = MagicMock()
        rsp.status_code = 200
        rsp.headers = {'Content-Type': 'text/plain; charset=utf-8',
                       'Content-Encoding': 'gzip'}
        rsp.iter_content = lambda n: iter([raw])
        res = self._run(rsp)
        self.assertTrue(res['ok'])
        self.assertEqual(res['content'], '压缩内容')

    def test_latin1_fallback(self):
        rsp = MagicMock()
        rsp.status_code = 200
        rsp.headers = {'Content-Type': 'text/plain'}
        rsp.iter_content = lambda n: iter([b'caf\xe9'])
        res = self._run(rsp)
        self.assertEqual(res['content'], 'café')


if __name__ == '__main__':
    unittest.main()
