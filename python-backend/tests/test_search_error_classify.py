# -*- coding: utf-8 -*-
"""单源检索失败分类（server._classify_search_error）。

用户要求「播放源检索失败原因要有明确状态码提示」：以前只把 str(e)[:80] 原样塞进卡片，
"403 Client Error: Forbidden for url: …" 既看不出是 HTTP 状态码还是超时，也读不懂。
本组测试锁住四类归一（HTTP 码 / 超时 / 网络 / 解析）与文案。
"""
import os
import sys
import unittest

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(BASE_DIR)
sys.path.insert(0, BACKEND_DIR)
TEST_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BACKEND_DIR, '.test-runtime')
os.makedirs(TEST_ROOT, exist_ok=True)
os.environ.setdefault('YUKI_DATA_DIR', os.path.join(TEST_ROOT, 'classify-data'))
os.makedirs(os.environ['YUKI_DATA_DIR'], exist_ok=True)

from server import _classify_search_error  # noqa: E402


class _Rsp:
    def __init__(self, code):
        self.status_code = code


class _HttpError(Exception):
    """模拟 requests.HTTPError：带 response.status_code。"""

    def __init__(self, code, msg=''):
        super().__init__(msg or ('%d Client Error' % code))
        self.response = _Rsp(code)


class _Timeout(Exception):
    pass


_Timeout.__name__ = 'ReadTimeout'


class SearchErrorClassifyTest(unittest.TestCase):
    def test_http_status_from_response(self):
        for code in (403, 404, 429):
            err_code, hint = _classify_search_error(_HttpError(code))
            self.assertEqual(err_code, 'HTTP %d' % code)
            self.assertTrue(hint, '应给出可读说明')

    def test_http_status_detected_from_text(self):
        err_code, _hint = _classify_search_error(Exception('403 Client Error: Forbidden for url: https://x/1'))
        self.assertEqual(err_code, 'HTTP 403')
        err_code, _hint = _classify_search_error(Exception('HTTP 502 Bad Gateway'))
        self.assertEqual(err_code, 'HTTP 502')

    def test_5xx_family_hint(self):
        _code, hint = _classify_search_error(_HttpError(502))
        self.assertIn('源站', hint)

    def test_timeout(self):
        err_code, hint = _classify_search_error(_Timeout('Read timed out'))
        self.assertEqual(err_code, 'TIMEOUT')
        self.assertIn('超时', hint)

    def test_network(self):
        class ConnectionError_(Exception):
            pass
        ConnectionError_.__name__ = 'ConnectionError'
        err_code, hint = _classify_search_error(ConnectionError_('NameResolutionError'))
        self.assertEqual(err_code, 'NETWORK')
        self.assertIn('网络', hint)

    def test_parse(self):
        err_code, hint = _classify_search_error(AttributeError("'NoneType' object has no attribute 'x'"))
        self.assertEqual(err_code, 'PARSE')
        self.assertIn('解析', hint)

    def test_unknown_keeps_short_text(self):
        err_code, hint = _classify_search_error(Exception('something weird happened'))
        self.assertEqual(err_code, 'ERROR')
        self.assertEqual(hint, 'something weird happened')

    def test_empty_message_still_classified(self):
        err_code, hint = _classify_search_error(Exception())
        self.assertEqual(err_code, 'ERROR')
        self.assertTrue(hint, '不能给空说明')


if __name__ == '__main__':
    unittest.main()
