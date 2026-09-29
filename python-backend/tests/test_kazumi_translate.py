# -*- coding: utf-8 -*-
"""划词翻译（kazumi/translate.py）单测。

覆盖：HTML 转义往返、语言码归一（微软/Google 两套 zh 变体）、Microsoft/
Google/LLM 三通道响应解析与错误分类、provider 链 failover 次序、缓存命中
（同文本二次调用不再出网）。

HTTP 桩对齐 test_kazumi_bgm_rating 惯例：mock.patch http_client.get/post。
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json  # noqa: E402
import http_client  # noqa: E402
import mem_cache  # noqa: E402
from kazumi import translate as tr  # noqa: E402


class _Rsp:
    """http_client 响应桩：status_code + text。"""
    def __init__(self, code=200, text=''):
        self.status_code = code
        self.text = text


class TestEscape(unittest.TestCase):
    """HTML 转义往返：& 最先转义；unescape 一次解码（&amp;lt; → &lt;）。"""

    def test_roundtrip(self):
        cases = ['a & b', 'a < b', 'x > y', '<b>bold</b>', '&amp;', 'A&amp;B<C']
        for raw in cases:
            self.assertEqual(tr.unescape_html(tr.escape_html(raw)), raw, raw)

    def test_bare_lt_becomes_entity(self):
        self.assertEqual(tr.escape_html('a < b'), 'a &lt; b')
        self.assertEqual(tr.escape_html('&<'), '&amp;&lt;')


class TestNormalizeLang(unittest.TestCase):
    """语言码归一：微软端点不认裸 zh（落 zh-Hans/zh-Hant）；Google 用 zh-CN/zh-TW。"""

    def test_microsoft(self):
        self.assertEqual(tr.normalize_lang('zh', microsoft=True), 'zh-Hans')
        self.assertEqual(tr.normalize_lang('zh-CN', microsoft=True), 'zh-Hans')
        self.assertEqual(tr.normalize_lang('zh-TW', microsoft=True), 'zh-Hant')
        self.assertEqual(tr.normalize_lang('zh-HK', microsoft=True), 'zh-Hant')
        self.assertEqual(tr.normalize_lang('JA', microsoft=True), 'ja')
        self.assertEqual(tr.normalize_lang('en-US', microsoft=True), 'en')
        self.assertEqual(tr.normalize_lang('', microsoft=True), 'zh-Hans')

    def test_google(self):
        self.assertEqual(tr.normalize_lang('zh', microsoft=False), 'zh-CN')
        self.assertEqual(tr.normalize_lang('zh-Hant', microsoft=False), 'zh-TW')
        self.assertEqual(tr.normalize_lang('ja', microsoft=False), 'ja')
        self.assertEqual(tr.normalize_lang('', microsoft=False), 'zh-CN')

    def test_ms_source_lang(self):
        self.assertEqual(tr._ms_source_lang('zh'), 'zh-Hans')
        self.assertEqual(tr._ms_source_lang('zh-TW'), 'zh-Hant')
        self.assertEqual(tr._ms_source_lang('en'), 'en')
        self.assertEqual(tr._ms_source_lang(''), '')


class TestMicrosoft(unittest.TestCase):
    """Microsoft 通道：裸 JSON 数组 body + HTML 转义 + translations[0].text。"""

    def test_ok(self):
        captured = {}

        def fake_post(url, **kw):
            captured['url'] = url
            captured['json'] = kw.get('json')
            return _Rsp(200, '[{"translations":[{"text":"&lt;b&gt;你好"}]}]')

        with mock.patch.object(http_client, 'post', side_effect=fake_post):
            out = tr.microsoft_translate('<b>hello & world', 'zh-CN')
        self.assertEqual(out, '<b>你好')  # unescape 一次：&lt;b&gt; → <b>，&amp; 已还原
        self.assertIn('https://edge.microsoft.com/translate/translatetext', captured['url'])
        self.assertIn('to=zh-Hans', captured['url'])
        # 发送前必须转义（防端点标签对齐器融合裸 <），& 最先
        self.assertEqual(captured['json'], ['&lt;b&gt;hello &amp; world'])

    def test_segment_count_mismatch(self):
        with mock.patch.object(http_client, 'post', return_value=_Rsp(200, '[]')):
            with self.assertRaises(tr.TranslateError) as cm:
                tr.microsoft_translate('hello', 'zh-CN')
            self.assertEqual(cm.exception.code, 'bad_response')

    def test_long_text_batched(self):
        """超长文本按换行拆批（每批 ≤ _MS_BATCH_CHARS），响应逐批校验。"""
        paras = ['a' * 1500, 'b' * 1500, 'c' * 1500]
        text = '\n'.join(paras)
        bodies = []

        def fake_post(url, **kw):
            bodies.append(kw.get('json'))
            return _Rsp(200, json.dumps([{'translations': [{'text': '译' * len(s)}]}
                                         for s in kw.get('json')]))

        with mock.patch.object(http_client, 'post', side_effect=fake_post):
            out = tr.microsoft_translate(text, 'zh-CN')
        # 4500 字 > 4000 单批上限 → 2 批；每批响应段数与请求段数一致
        self.assertEqual(len(bodies), 2)
        self.assertEqual(len(bodies[0]), 2)   # a + b
        self.assertEqual(len(bodies[1]), 1)   # c
        self.assertEqual(out.count('\n'), 2)  # 分段结构保留

    def test_rate_limit(self):
        with mock.patch.object(http_client, 'post', return_value=_Rsp(429, '')):
            with self.assertRaises(tr.TranslateError) as cm:
                tr.microsoft_translate('hi', 'zh-CN')
            self.assertEqual(cm.exception.code, 'rate_limit')


class TestGoogle(unittest.TestCase):
    """Google 通道：translate_a/single 嵌套数组解析、空结果/坏格式报错。"""

    def test_ok(self):
        captured = {}

        def fake_get(url, **kw):
            captured['url'] = url
            captured['params'] = kw.get('params')
            return _Rsp(200, '[[["你好","hello"],["，"," "]],null]')

        with mock.patch.object(http_client, 'get', side_effect=fake_get):
            out = tr.google_translate('hello', 'zh-CN')
        self.assertEqual(out, '你好，')
        self.assertIn('translate.googleapis.com/translate_a/single', captured['url'])
        self.assertEqual(captured['params']['client'], 'gtx')
        self.assertEqual(captured['params']['tl'], 'zh-CN')

    def test_bad_format(self):
        with mock.patch.object(http_client, 'get', return_value=_Rsp(200, '{"x":1}')):
            with self.assertRaises(tr.TranslateError) as cm:
                tr.google_translate('hi', 'zh-CN')
            self.assertEqual(cm.exception.code, 'bad_response')

    def test_empty_result(self):
        with mock.patch.object(http_client, 'get', return_value=_Rsp(200, '[[]]')):
            with self.assertRaises(tr.TranslateError) as cm:
                tr.google_translate('hi', 'zh-CN')
            self.assertEqual(cm.exception.code, 'bad_response')


class TestLlm(unittest.TestCase):
    """LLM 通道：OpenAI 兼容 body、鉴权失败分类、配置缺失报错。"""

    def test_ok(self):
        captured = {}

        def fake_post(url, **kw):
            captured['url'] = url
            captured['json'] = kw.get('json')
            captured['headers'] = kw.get('headers')
            return _Rsp(200, '{"choices":[{"message":{"content":" 你好 "}}]}')

        with mock.patch.object(http_client, 'post', side_effect=fake_post):
            out = tr.llm_translate('hello', 'zh-CN',
                                   {'base': 'https://api.x.com/v1', 'key': 'sk-1', 'model': 'gpt-x'})
        self.assertEqual(out, '你好')
        self.assertEqual(captured['url'], 'https://api.x.com/v1/chat/completions')
        self.assertEqual(captured['json']['model'], 'gpt-x')
        self.assertEqual(captured['headers']['Authorization'], 'Bearer sk-1')
        self.assertFalse(captured['json']['stream'])

    def test_auth_error(self):
        with mock.patch.object(http_client, 'post', return_value=_Rsp(401, '')):
            with self.assertRaises(tr.TranslateError) as cm:
                tr.llm_translate('hi', 'zh-CN', {'base': 'https://x.com', 'model': 'm'})
            self.assertEqual(cm.exception.code, 'auth')

    def test_missing_config(self):
        with self.assertRaises(tr.TranslateError) as cm:
            tr.llm_translate('hi', 'zh-CN', {'base': '', 'model': ''})
        self.assertEqual(cm.exception.code, 'bad_request')


class TestTranslateText(unittest.TestCase):
    """编排层：缓存命中、failover 次序、参数校验。"""

    def setUp(self):
        mem_cache.invalidate('translate')

    def test_empty_text(self):
        self.assertEqual(tr.translate_text('  ', 'zh-CN')['code'], 1)

    def test_too_long(self):
        self.assertEqual(tr.translate_text('a' * 5001, 'zh-CN')['code'], 1)

    def test_failover_ms_to_google(self):
        """microsoft 失败自动降级 google。"""
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(429, '')), \
             mock.patch.object(http_client, 'get',
                               return_value=_Rsp(200, '[[["你好","hi"]]]')):
            out = tr.translate_text('hi', 'zh-CN')
        self.assertEqual(out['code'], 0)
        self.assertEqual(out['provider'], 'google')
        self.assertEqual(out['text'], '你好')

    def test_cache_hit(self):
        calls = []

        def fake_post(url, **kw):
            calls.append(url)
            return _Rsp(200, '[{"translations":[{"text":"你好"}]}]')

        with mock.patch.object(http_client, 'post', side_effect=fake_post), \
             mock.patch.object(http_client, 'get', return_value=_Rsp(200, '[[]]')):
            first = tr.translate_text('unique-cache-text', 'zh-CN')
            second = tr.translate_text('unique-cache-text', 'zh-CN')
        self.assertEqual(first['code'], 0)
        self.assertEqual(second['code'], 0)
        self.assertTrue(second.get('cached'))
        self.assertEqual(len(calls), 1)  # 第二次命中缓存，不出网

    def test_all_fail(self):
        with mock.patch.object(http_client, 'post', return_value=_Rsp(500, '')), \
             mock.patch.object(http_client, 'get', return_value=_Rsp(500, '')):
            out = tr.translate_text('hi', 'zh-CN')
        self.assertEqual(out['code'], 1)
        self.assertTrue(out.get('msg'))

    def test_long_text_skips_google(self):
        """超长文本（UTF-8 字节数 > 4000）链中跳过 Google（GET URL 超限必拒），
        只走微软。'长' 每字 3 字节，1600 字 = 4800 字节 > 4000。"""
        posts, gets = [], []

        def fake_post(url, **kw):
            posts.append(url)
            return _Rsp(200, '[{"translations":[{"text":"译"}]}]')

        def fake_get(url, **kw):
            gets.append(url)
            return _Rsp(200, '[[["错","x"]]]')

        with mock.patch.object(http_client, 'post', side_effect=fake_post), \
             mock.patch.object(http_client, 'get', side_effect=fake_get):
            out = tr.translate_text('长' * 1600, 'zh-CN')
        self.assertEqual(out['code'], 0)
        self.assertEqual(out['provider'], 'microsoft')
        self.assertEqual(gets, [])  # Google 未被调用

    def test_long_text_byte_boundary(self):
        """字节口径边界：阈值按 UTF-8 字节数判定（>4000 跳过 Google），
        与字符数无关——emoji 每字 4 字节，1000 字（恰 4000B）保留 Google，
        1001 字（4004B）跳过；旧字符口径（>1500 字）下两者都会误跳。"""
        def run(text, ms_code):
            gets = []

            def fake_post(url, **kw):
                # 429 → 逼 failover 到 Google；200 → 单批有效响应（单段无换行）
                return _Rsp(ms_code, '[{"translations":[{"text":"译"}]}]')

            def fake_get(url, **kw):
                gets.append(url)
                return _Rsp(200, '[[["你好","hi"]]]')

            with mock.patch.object(http_client, 'post', side_effect=fake_post), \
                 mock.patch.object(http_client, 'get', side_effect=fake_get):
                out = tr.translate_text(text, 'zh-CN')
            return out, gets

        emoji = '\U0001F600'  # 😀，UTF-8 编码 4 字节
        # 恰等于阈值 4000 字节（不超）→ Google 保留：微软 429 逼降级，
        # 落到 provider=google 才算「保留」
        out, gets = run(emoji * 1000, 429)
        self.assertEqual(out['code'], 0)
        self.assertEqual(out['provider'], 'google')
        self.assertEqual(len(gets), 1)

        # 超 4 字节 → 跳过 Google：微软直接成功，无 get 调用
        out, gets = run(emoji * 1001, 200)
        self.assertEqual(out['code'], 0)
        self.assertEqual(out['provider'], 'microsoft')
        self.assertEqual(gets, [])

    def test_ascii_over_old_char_threshold_keeps_google(self):
        """2000 个 ASCII 字符仅 2000 字节（≤4000）→ 保留 Google；
        旧字符口径（>1500 字）会误跳，此用例锁定字节口径的行为。"""
        with mock.patch.object(http_client, 'post', return_value=_Rsp(429, '')), \
             mock.patch.object(http_client, 'get',
                               return_value=_Rsp(200, '[[["你好","hi"]]]')) as g:
            out = tr.translate_text('a' * 2000, 'zh-CN')
        self.assertEqual(out['code'], 0)
        self.assertEqual(out['provider'], 'google')
        self.assertEqual(g.call_count, 1)


class TestProbe(unittest.TestCase):
    """LLM 探测模式（设置页「测试连接」）：单通道、不 failover、不缓存。"""

    def test_probe_ok(self):
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(200, '{"choices":[{"message":{"content":"你好"}}]}')):
            out = tr.translate_text('hi', 'zh-CN', prefer='probe',
                                    llm_cfg={'base': 'https://x.com/v1', 'key': 'sk', 'model': 'm'})
        self.assertEqual(out['code'], 0)
        self.assertTrue(out.get('probe'))
        self.assertEqual(out['provider'], 'llm')
        self.assertEqual(out['text'], '你好')

    def test_probe_no_failover(self):
        """LLM 失败直接返回错误分类，不降级免费通道。"""
        with mock.patch.object(http_client, 'post', return_value=_Rsp(401, '')), \
             mock.patch.object(http_client, 'get', return_value=_Rsp(200, '[[["x","y"]]]')) as g:
            out = tr.translate_text('hi', 'zh-CN', prefer='probe',
                                    llm_cfg={'base': 'https://x.com', 'key': 'bad', 'model': 'm'})
        self.assertEqual(out['code'], 1)
        self.assertTrue(out.get('probe'))
        self.assertEqual(out['err'], 'auth')
        self.assertEqual(g.call_count, 0)  # 免费通道未被触碰

    def test_probe_incomplete_config(self):
        out = tr.translate_text('hi', 'zh-CN', prefer='probe', llm_cfg={'base': '', 'model': ''})
        self.assertEqual(out['code'], 1)
        self.assertEqual(out['err'], 'bad_request')

    def test_probe_not_cached(self):
        """探测结果不写缓存：同参数正常翻译仍会出网。"""
        with mock.patch.object(http_client, 'post',
                               return_value=_Rsp(200, '{"choices":[{"message":{"content":"ok"}}]}')) as p:
            tr.translate_text('probe-unique-text', 'zh-CN', prefer='probe',
                              llm_cfg={'base': 'https://x.com', 'model': 'm'})
            self.assertEqual(p.call_count, 1)
            tr.translate_text('probe-unique-text', 'zh-CN', prefer='llm',
                              llm_cfg={'base': 'https://x.com', 'model': 'm'})
            self.assertEqual(p.call_count, 2)  # 正常通道未复用探测结果


if __name__ == '__main__':
    unittest.main()
