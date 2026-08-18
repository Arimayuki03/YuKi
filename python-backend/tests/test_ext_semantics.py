# -*- coding: utf-8 -*-
"""C2.2 `ext` 完整语义测试（对齐 FongMi 上游契约）。

上游参考（`TV-fongmi/`，只读不改）：

* `gson/ExtAdapter.java` —— 任意 JSON 值反序列化后**一律是字符串**；
* `bean/Site.java::setExt` —— `trim()`；
* `bean/Site.java::fetchExt` —— `if (!ext.startsWith("http")) return this;`，
  空响应保留原 URL；
* `api/SiteApi.java:73` —— `fetchExt()` **只在 type == 4 的 homeContent 前**调用一次；
  type=3 的 spider 拿到的是原始 ext 字符串，自己决定要不要去取。

四类路径全覆盖：正常（各形态归一与展开）、异常（HTTP 错误/超限/递归/被拒只影响该
站点）、超时（预算耗尽与 socket 超时分别归因）、取消（立即停止且不再发请求）。
"""
import os
import sys
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
for _path in (BASE, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from offline_config_server import FixtureServer  # noqa: E402
from runtime.config_security import ConfigSecurityPolicy, SourceTrust  # noqa: E402
from runtime.ext_resolver import (  # noqa: E402
    ExtCache, ExtCancelled, ExtResolver, ExtTimeout, ResolvedExt, canonical_ext,
    detect_text, is_http_ext)


class CanonicalExtTest(unittest.TestCase):
    """ExtAdapter + setExt：任何 JSON 值 → trim 过的字符串。"""

    def test_every_json_shape_becomes_a_string(self):
        cases = [
            (None, ''),
            ('', ''),
            ('  spaced  ', 'spaced'),
            ('https://x.invalid/e.json', 'https://x.invalid/e.json'),
            (True, 'true'),
            (False, 'false'),
            (7, '7'),
            (7.0, '7'),          # Gson getAsString() 不给整数补 .0
            (7.5, '7.5'),
            ({'a': 1}, '{"a":1}'),
            ([1, 'b'], '[1,"b"]'),
            ({}, '{}'),
            ([], '[]'),
        ]
        for value, expected in cases:
            got = canonical_ext(value)
            self.assertIsInstance(got, str, value)
            self.assertEqual(got, expected, value)

    def test_non_ascii_is_preserved_not_escaped(self):
        self.assertEqual(canonical_ext({'名称': '中文'}), '{"名称":"中文"}')

    def test_http_detection_matches_upstream_startswith(self):
        self.assertTrue(is_http_ext('http://x.invalid/e'))
        self.assertTrue(is_http_ext('HTTPS://X.invalid/e'))
        self.assertTrue(is_http_ext('  https://x.invalid/e  '))
        for value in ('', 'ftp://x/e', '{"a":1}', 'httpfoo', 'plain-text'):
            self.assertFalse(is_http_ext(value), value)


class DetectTextTest(unittest.TestCase):
    """TVBox 生态里 ext/配置常是 GBK 或带 BOM，编码识别错了就是乱码。"""

    def test_bom_and_declared_and_fallback(self):
        self.assertEqual(detect_text('{"a":1}'.encode('utf-8-sig'))[0], '{"a":1}')
        # 双 BOM：已带 BOM 的文件又被按 utf-8-sig 重新编码一次。只剥一层会让文本仍以
        # U+FEFF 开头，后续 json.loads 在第 1 列报错，看上去像配置写错了。
        self.assertEqual(detect_text('﻿{"a":1}'.encode('utf-8-sig'))[0], '{"a":1}')
        self.assertEqual(detect_text(b'\xff\xfe' + '中'.encode('utf-16-le'))[0], '中')
        self.assertEqual(detect_text('中文'.encode('gb18030'), 'gbk')[0], '中文')
        # 不声明 charset 的 GBK：utf-8 解不开，必须回退 gb18030 而不是替换成问号
        text, encoding = detect_text('中文'.encode('gb18030'))
        self.assertEqual(text, '中文')
        self.assertEqual(encoding, 'gb18030')

    def test_iso_8859_1_declaration_is_ignored(self):
        """requests 对无 charset 的响应默认标 ISO-8859-1，照信会把中文全变乱码。"""
        text, _ = detect_text('中文'.encode('utf-8'), 'iso-8859-1')
        self.assertEqual(text, '中文')

    def test_undecodable_bytes_fall_back_to_replacement(self):
        text, encoding = detect_text(b'\xc3\x28\xa0\xa1')
        self.assertTrue(text)
        self.assertEqual(encoding, 'utf-8/replace')

    def test_empty_body(self):
        self.assertEqual(detect_text(b''), ('', 'utf-8'))


class ForRuntimeContractTest(unittest.TestCase):
    """SiteApi.java:73：只有 type=4/JS 用展开后的文本，其余拿原始字符串。"""

    def _resolved(self):
        return ResolvedExt(canonical='https://x.invalid/e.json',
                           origin='https://x.invalid/e.json',
                           url='https://x.invalid/e.json',
                           expanded='{"cate":"all"}', kind='url', expanded_kind='json')

    def test_js_gets_expanded_others_get_the_url(self):
        resolved = self._resolved()
        self.assertEqual(resolved.for_runtime('js'), '{"cate":"all"}')
        for runtime in ('jar', 'python', 'cms', 'android', 'unsupported', ''):
            self.assertEqual(resolved.for_runtime(runtime), 'https://x.invalid/e.json',
                             runtime)

    def test_failed_expansion_falls_back_to_the_original_url_even_for_js(self):
        resolved = self._resolved()
        resolved.expanded = ''
        resolved.error = 'boom'
        self.assertFalse(resolved.expanded_ok)
        self.assertEqual(resolved.for_runtime('js'), 'https://x.invalid/e.json',
                         '展开失败必须保留原 URL，让 spider 自己再试')

    def test_to_dict_redacts_and_reports_expansion(self):
        payload = self._resolved().to_dict()
        self.assertEqual(payload['kind'], 'url')
        self.assertTrue(payload['expanded'])
        self.assertEqual(payload['expandedKind'], 'json')
        self.assertNotIn('error', payload)


class _ResolverCase(unittest.TestCase):
    """共用一台夹具服务；每个用例一份干净缓存，避免相互污染。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = FixtureServer().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def resolver(self, *, trust_root=None, cache=None, **policy_kw):
        policy = ConfigSecurityPolicy(resolve_hostnames=False, **policy_kw)
        root = trust_root if trust_root is not None else self.fx.config('single.json')
        return ExtResolver(policy=policy,
                           trust=SourceTrust.for_source(root, policy=policy),
                           cache=cache if cache is not None else ExtCache())


class NoNetworkPathTest(_ResolverCase):
    """归一化与相对路径解析不发请求——这一层不该有任何 IO。"""

    def test_non_http_ext_is_never_fetched(self):
        resolver = self.resolver()
        got = resolver.resolve('{"cate":"all"}', self.fx.config('single.json'))
        self.assertEqual(got.canonical, '{"cate":"all"}')
        self.assertEqual(got.kind, 'json')
        self.assertEqual(got.url, '', '非 http 的 ext 没有可取的地址')
        self.assertEqual(got.hops, [])

    def test_object_ext_keeps_inner_relative_paths_resolved(self):
        """`{"site":"./lib/x.json"}` 的内部相对路径也要按最终配置 URL 解析。

        否则 spider 拿到的是无法请求的 `./...`——它没有配置 URL 可以拼。
        """
        base = self.fx.config('relative.json')
        got = self.resolver().resolve({'site': './lib/site_ext.json', 'n': 1}, base,
                                      expand=False)
        self.assertEqual(got.kind, 'object')
        self.assertIn(self.fx.config('lib/site_ext.json'), got.canonical)
        self.assertNotIn('./lib', got.canonical)

    def test_list_ext_resolves_each_element(self):
        base = self.fx.config('relative.json')
        got = self.resolver().resolve(['./a.json', 'https://x.invalid/b.json'], base,
                                      expand=False)
        self.assertEqual(got.kind, 'array')
        self.assertIn(self.fx.config('a.json'), got.canonical)

    def test_relative_string_ext_uses_final_config_url(self):
        # 最终 URL 与源 URL 不同时（跳转/多仓），必须以**最终**URL 为基址。
        got = self.resolver().resolve('./lib/site_ext.json',
                                      self.fx.config('sub/final.json'), expand=False)
        self.assertEqual(got.canonical, self.fx.config('sub/lib/site_ext.json'))

    def test_relative_without_base_stays_relative_and_is_not_fetched(self):
        got = self.resolver().resolve('./lib/site_ext.json', '', expand=False)
        self.assertEqual(got.canonical, './lib/site_ext.json')
        self.assertEqual(got.url, '')

    def test_expand_false_makes_zero_requests(self):
        before = self.fx.hits('/ext/json')
        got = self.resolver().resolve(self.fx.url('ext/json'), expand=False)
        self.assertEqual(got.kind, 'url')
        self.assertEqual(got.url, self.fx.url('ext/json'))
        self.assertFalse(got.expanded_ok)
        self.assertEqual(self.fx.hits('/ext/json'), before)


class ExpansionTest(_ResolverCase):
    """fetchExt 语义：只取 http(s)，空响应保留原 URL，结果类型如实标注。"""

    def test_json_body_expands(self):
        got = self.resolver().resolve(self.fx.url('ext/json'), expand=True)
        self.assertEqual(got.error, '')
        self.assertTrue(got.expanded_ok)
        self.assertEqual(got.expanded_kind, 'json')
        self.assertIn('ext-json-payload', got.expanded)
        self.assertEqual(got.url, self.fx.url('ext/json'),
                         '原 URL 必须保留，供 type=3 契约取用')
        self.assertEqual(got.hops, [self.fx.url('ext/json')])
        self.assertEqual(len(got.content_hash), 64)

    def test_plain_text_body_expands_as_text(self):
        got = self.resolver().resolve(self.fx.url('ext/text'), expand=True)
        self.assertTrue(got.expanded_ok)
        self.assertEqual(got.expanded_kind, 'text')
        self.assertEqual(got.expanded, 'ext-plain-text-body')

    def test_empty_response_keeps_the_original_url(self):
        """FongMi fetchExt：`if (!response.isEmpty()) setExt(response)`。"""
        url = self.fx.url('ext/empty')
        got = self.resolver().resolve(url, expand=True)
        self.assertFalse(got.expanded_ok)
        self.assertEqual(got.error_reason, 'empty_response')
        self.assertEqual(got.canonical, url, '空响应不得覆盖 ext')
        self.assertEqual(got.for_runtime('js'), url)

    def test_gbk_body_without_charset_is_decoded(self):
        got = self.resolver().resolve(self.fx.url('ext/gbk'), expand=True)
        self.assertTrue(got.expanded_ok)
        self.assertIn('中文', got.expanded)

    def test_one_extra_hop_is_followed(self):
        got = self.resolver().resolve(self.fx.url('ext/chain'), expand=True)
        self.assertTrue(got.expanded_ok, got.error)
        self.assertIn('ext-json-payload', got.expanded)
        self.assertEqual(got.hops, [self.fx.url('ext/chain'), self.fx.url('ext/json')])

    def test_etag_second_resolve_reuses_cached_body(self):
        cache = ExtCache()
        resolver = self.resolver(cache=cache)
        url = self.fx.url('etag/ext.json')
        before = self.fx.hits('/etag/ext.json')
        first = resolver.resolve(url, expand=True)
        self.assertTrue(first.expanded_ok, first.error)
        self.assertFalse(first.from_cache)
        self.assertEqual(first.etag, '"fixture-etag"')
        second = resolver.resolve(url, expand=True)
        self.assertTrue(second.expanded_ok, second.error)
        self.assertTrue(second.from_cache, '304 必须复用缓存正文')
        self.assertEqual(second.expanded, first.expanded)
        self.assertEqual(self.fx.hits('/etag/ext.json') - before, 2,
                         '条件请求仍要发出去，只是不重传正文')


class ExpansionFailureIsolationTest(_ResolverCase):
    """异常：ext 失败只影响该站点，`resolve` 不抛（取消除外）。"""

    def test_http_error_is_recorded_not_raised(self):
        got = self.resolver().resolve(self.fx.url('ext/500'), expand=True)
        self.assertFalse(got.expanded_ok)
        self.assertEqual(got.error_reason, 'fetch_failed')
        self.assertIn('500', got.error)
        self.assertEqual(got.canonical, self.fx.url('ext/500'))

    def test_oversize_body_is_capped_per_site(self):
        got = self.resolver(max_ext_bytes=8).resolve(self.fx.url('ext/json'),
                                                    expand=True)
        self.assertFalse(got.expanded_ok)
        self.assertEqual(got.error_reason, 'response_too_large')

    def test_self_referencing_ext_is_stopped_by_cycle_detection(self):
        got = self.resolver().resolve(self.fx.url('ext/loop'), expand=True)
        self.assertFalse(got.expanded_ok)
        self.assertEqual(got.error_reason, 'recursion_cycle')
        self.assertLessEqual(len(got.hops), 2)

    def test_depth_limit_stops_a_long_chain(self):
        got = self.resolver(max_ext_depth=1).resolve(self.fx.url('ext/chain'),
                                                     expand=True)
        self.assertFalse(got.expanded_ok)
        self.assertEqual(got.error_reason, 'recursion_limit')

    def test_public_config_cannot_expand_ext_into_loopback(self):
        """远端配置的 ext 指向本机 = 端口探测，必须在取之前就被拒。"""
        resolver = self.resolver(trust_root='https://cdn.fixture.invalid/tv.json')
        before = self.fx.hits('/ext/json')
        got = resolver.resolve(self.fx.url('ext/json'), expand=True)
        self.assertFalse(got.expanded_ok)
        self.assertEqual(got.error_reason, 'private_network_blocked')
        self.assertEqual(self.fx.hits('/ext/json'), before, '被拒的地址不得发出请求')

    def test_dead_host_failure_does_not_raise(self):
        got = self.resolver(trust_root='https://cdn.fixture.invalid/tv.json').resolve(
            'https://nothing-here.invalid/e.json', expand=True)
        self.assertFalse(got.expanded_ok)
        self.assertTrue(got.error)
        self.assertEqual(got.canonical, 'https://nothing-here.invalid/e.json')


class TimeoutTest(_ResolverCase):
    """超时：预算耗尽（timeout）与 socket 超时（fetch_failed）分别归因。"""

    def test_exhausted_budget_is_reported_as_timeout(self):
        before = self.fx.hits('/ext/json')
        got = self.resolver().resolve(self.fx.url('ext/json'), expand=True,
                                      deadline=time.monotonic() - 1)
        self.assertEqual(got.error_reason, 'timeout')
        self.assertEqual(self.fx.hits('/ext/json'), before,
                         '预算已耗尽就不该再发请求')

    def test_deadline_clamps_socket_timeout(self):
        started = time.monotonic()
        got = self.resolver().resolve(self.fx.url('slow.json?ms=4000'), expand=True,
                                      deadline=time.monotonic() + 0.8)
        elapsed = time.monotonic() - started
        self.assertFalse(got.expanded_ok)
        self.assertTrue(got.error)
        self.assertLess(elapsed, 3.0, 'ext 展开不得拖满整次配置加载')
        self.assertEqual(got.for_runtime('js'), self.fx.url('slow.json?ms=4000'))

    def test_timeout_raises_only_through_the_resolver_internals(self):
        with self.assertRaises(ExtTimeout):
            self.resolver()._fetch(self.fx.url('ext/json'),
                                   deadline=time.monotonic() - 1)


class CancelTest(_ResolverCase):
    """取消：唯一允许穿透 `resolve` 的异常，且必须立刻停手。"""

    def test_cancel_before_first_fetch(self):
        cancel = threading.Event()
        cancel.set()
        resolver = self.resolver()
        resolver.cancel_event = cancel
        before = self.fx.hits('/ext/json')
        with self.assertRaises(ExtCancelled):
            resolver.resolve(self.fx.url('ext/json'), expand=True)
        self.assertEqual(self.fx.hits('/ext/json'), before)

    def test_cancel_between_hops_stops_the_chain(self):
        import http_client

        cancel = threading.Event()
        calls = []

        def spy(url, **kwargs):
            calls.append(url)
            cancel.set()                     # 第一跳刚回来就取消
            return http_client.get(url, **kwargs)

        resolver = self.resolver()
        resolver.cancel_event = cancel
        resolver.session_get = spy
        with self.assertRaises(ExtCancelled):
            resolver.resolve(self.fx.url('ext/chain'), expand=True)
        self.assertEqual(len(calls), 1, '取消后不得再取下一跳')

    def test_cancel_does_not_leak_as_a_site_level_error(self):
        """取消必须一路上抛成 L1（整次加载结束），不能退化成「这个站点 ext 取失败」。"""
        cancel = threading.Event()
        cancel.set()
        resolver = self.resolver()
        resolver.cancel_event = cancel
        try:
            resolver.resolve(self.fx.url('ext/json'), expand=True)
        except ExtCancelled:
            return
        self.fail('取消必须抛 ExtCancelled，不能只写进 result.error')


class _FakeRunner:
    """替代 `SupervisedRunner`：记录真正传给运行时的 ext，不起子进程。

    这里被替换掉的是 Worker 启动层，不是被测契约——本用例要断言的正是
    「哪一个 ext 字符串到达了运行时」，而那由 `_build_site` 决定。
    """

    instances = []

    def __init__(self, spec):
        self.spec = dict(spec or {})
        self.inits = []
        _FakeRunner.instances.append(self)

    def init(self, ext=''):
        self.inits.append(ext)

    def destroy(self):
        return None


class BuildSiteExtContractTest(_ResolverCase):
    """把 SiteApi.java:73 的分歧固定住：type=4 展开、type=3 拿原始 URL。"""

    def setUp(self):
        from config import ConfigManager
        from site_manager import SiteManager

        _FakeRunner.instances = []
        self.manager = ConfigManager(SiteManager())
        self.base = self.fx.config('single.json')
        patcher = mock.patch('config.SupervisedRunner', _FakeRunner)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_type4_receives_expanded_text(self):
        before = self.fx.hits('/ext/json')
        site = self.manager._build_site({
            'key': 'js1', 'name': 'JS', 'type': 4,
            'api': self.fx.url('js/site.js'), 'ext': self.fx.url('ext/json'),
        }, self.base, '')
        self.assertEqual(site.health.runtime, 'js')
        self.assertTrue(site.ext_detail.expanded_ok, site.ext_detail.error)
        self.assertIn('ext-json-payload', site.ext)
        self.assertEqual(site.runner.inits, [site.ext])
        self.assertEqual(self.fx.hits('/ext/json') - before, 1,
                         'type=4 在 homeContent 前取一次 ext')

    def test_type3_receives_the_raw_url_and_never_fetches_it(self):
        """type=3 的 spider 自己决定要不要取 ext——宿主不得替它请求。"""
        before = self.fx.hits('/etag/ext.json')
        ext_url = self.fx.url('etag/ext.json')
        site = self.manager._build_site({
            'key': 'py1', 'name': 'PY', 'type': 3,
            'api': self.fx.url('py/site.py'), 'ext': ext_url,
        }, self.base, '')
        self.assertEqual(site.health.runtime, 'python')
        self.assertEqual(site.ext, ext_url, 'type=3 拿到的必须是原始字符串')
        self.assertEqual(site.runner.inits, [ext_url])
        self.assertFalse(site.ext_detail.expanded_ok)
        self.assertEqual(self.fx.hits('/etag/ext.json'), before,
                         'type=3 不得触发 fetchExt')

    def test_object_ext_reaches_runtime_as_a_json_string(self):
        site = self.manager._build_site({
            'key': 'cmsx', 'name': 'CMS', 'type': 1,
            'api': self.fx.url('config/single.json'),
            'ext': {'cate': ['电影'], 'n': 2},
        }, self.base, '')
        self.assertEqual(site.health.runtime, 'cms')
        self.assertIsInstance(site.ext, str)
        self.assertEqual(site.ext, '{"cate":["电影"],"n":2}')
        self.assertEqual(site.runner.inits, [site.ext])

    def test_one_broken_ext_does_not_affect_the_other_site(self):
        good = self.manager._build_site({
            'key': 'good', 'name': 'good', 'type': 4,
            'api': self.fx.url('js/site.js'), 'ext': self.fx.url('ext/json'),
        }, self.base, '')
        broken = self.manager._build_site({
            'key': 'broken', 'name': 'broken', 'type': 4,
            'api': self.fx.url('js/site.js'), 'ext': self.fx.url('ext/500'),
        }, self.base, '')
        self.assertTrue(good.health.healthy)
        self.assertTrue(broken.health.healthy,
                        'ext 取不到不等于站点不可用——spider 可能不需要它')
        self.assertTrue(good.ext_detail.expanded_ok)
        self.assertFalse(broken.ext_detail.expanded_ok)
        self.assertEqual(broken.ext, self.fx.url('ext/500'))

    def test_cancelled_build_reports_l1_not_a_site_error(self):
        from runtime.errors import RuntimeError as RuntimeContractError

        cancel = threading.Event()
        ctx = self.manager._context(self.base)
        ctx.cancel_event = cancel
        ctx.ext.cancel_event = cancel
        cancel.set()
        with self.assertRaises(RuntimeContractError) as caught:
            self.manager._build_site({
                'key': 'js2', 'name': 'JS', 'type': 4,
                'api': self.fx.url('js/site.js'), 'ext': self.fx.url('ext/json'),
            }, self.base, '')
        self.assertEqual(caught.exception.code, 'L1_CONFIG_CANCELLED',
                         '取消是整次加载的结论，不是单站点失败')


if __name__ == '__main__':
    unittest.main(verbosity=2)
