# -*- coding: utf-8 -*-
"""C2.5 配置安全边界测试：协议、体积、跳转、递归、本地网络。

覆盖四类路径：正常（允许的来源照常取回）、异常（被拒绝且给出稳定错误码）、
超时（受限取回不会无限等待）、取消（取消后不再发起任何守卫请求）。

原则：只用 loopback 夹具，不出网。被拒绝的断言一律断在**错误码 + reason**上，
而不是断在错误文案里——文案会改，契约不会。
"""
import gzip
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
for path in (BASE, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from offline_config_server import FixtureServer  # noqa: E402
from runtime.config_security import (  # noqa: E402
    ALLOWED_SCHEMES, ArtifactRegistry, ConfigSecurityError, ConfigSecurityPolicy,
    SourceTrust, decompress_capped, fetch_guarded, guard_local_config_path,
    guard_url, host_scope, read_capped, reset_dns_cache)


class _FakeResponse:
    """最小响应替身：只实现 `read_capped` / `fetch_guarded` 真正用到的接口。"""

    def __init__(self, chunks, *, status=200, headers=None, url='http://fixture.invalid/x'):
        self._chunks = list(chunks)
        self.status_code = status
        self.headers = dict(headers or {})
        self.url = url
        self.encoding = ''
        self.closed = False

    def iter_content(self, _size):
        for chunk in self._chunks:
            if self.closed:
                return
            yield chunk

    def close(self):
        self.closed = True


def _policy(**kw):
    """显式构造策略，绕开 `from_env`——测试不该受宿主环境变量影响。"""
    base = dict(resolve_hostnames=False)
    base.update(kw)
    return ConfigSecurityPolicy(**base)


class HostScopeTest(unittest.TestCase):
    def test_ip_literals_are_classified_without_dns(self):
        self.assertEqual(host_scope('127.0.0.1', resolve=False), 'loopback')
        self.assertEqual(host_scope('::1', resolve=False), 'loopback')
        self.assertEqual(host_scope('0.0.0.0', resolve=False), 'loopback')
        self.assertEqual(host_scope('10.0.0.1', resolve=False), 'private')
        self.assertEqual(host_scope('192.168.1.1', resolve=False), 'private')
        self.assertEqual(host_scope('169.254.1.1', resolve=False), 'private')
        self.assertEqual(host_scope('8.8.8.8', resolve=False), 'public')

    def test_ipv4_mapped_ipv6_does_not_launder_loopback(self):
        # ::ffff:127.0.0.1 是回环的另一种写法；只看字符串会漏过。
        self.assertEqual(host_scope('::ffff:127.0.0.1', resolve=False), 'loopback')
        self.assertEqual(host_scope('[::ffff:10.0.0.1]', resolve=False), 'private')

    def test_conventional_local_suffixes(self):
        self.assertEqual(host_scope('localhost', resolve=False), 'loopback')
        self.assertEqual(host_scope('nas.localhost', resolve=False), 'loopback')
        self.assertEqual(host_scope('printer.local', resolve=False), 'private')
        self.assertEqual(host_scope('router.home.arpa', resolve=False), 'private')
        self.assertEqual(host_scope('svc.internal', resolve=False), 'private')

    def test_reserved_suffixes_short_circuit_dns(self):
        """RFC 6761/2606 保留后缀永不解析：不能让每个夹具地址白等一次 DNS 超时。

        这不是「按夹具名开后门」——`.invalid`/`.test` 由标准保证不可解析，
        判定结果仍是 `unknown`（不放宽为 public/private），只是跳过必然失败的解析。
        """
        reset_dns_cache()
        started = time.monotonic()
        self.assertEqual(host_scope('fixture.invalid', resolve=True), 'unknown')
        self.assertEqual(host_scope('a.b.test', resolve=True), 'unknown')
        self.assertLess(time.monotonic() - started, 0.5,
                        '保留后缀不应触发 DNS 解析等待')

    def test_empty_host_is_invalid(self):
        self.assertEqual(host_scope('', resolve=False), 'invalid')


class GuardUrlTest(unittest.TestCase):
    def setUp(self):
        self.policy = _policy()
        self.trust = SourceTrust.for_source('https://cdn.fixture.invalid/tv.json',
                                            policy=self.policy)

    def _blocked(self, url, **kw):
        with self.assertRaises(ConfigSecurityError) as caught:
            guard_url(url, policy=self.policy, trust=self.trust, **kw)
        return caught.exception

    # ------------------------------------------------------------ 正常

    def test_allowed_schemes_pass_through_normalized(self):
        self.assertEqual(ALLOWED_SCHEMES, ('http', 'https'))
        got = guard_url('https://cdn.fixture.invalid/a/b.json?x=1#frag',
                        policy=self.policy, trust=self.trust)
        self.assertEqual(got, 'https://cdn.fixture.invalid/a/b.json?x=1',
                         'fragment 必须剥掉：它不参与请求，留着会污染缓存键')

    def test_relative_resolves_against_final_config_url(self):
        got = guard_url('./jar/shared.jar', policy=self.policy, trust=self.trust,
                        kind='jar', base_url='https://cdn.fixture.invalid/sub/tv.json')
        self.assertEqual(got, 'https://cdn.fixture.invalid/sub/jar/shared.jar')

    def test_parent_relative_cannot_escape_into_local_path(self):
        # `../../` 只在 URL 空间内上溯，解析后仍是 http(s)，不会变成磁盘路径。
        got = guard_url('../../etc/passwd', policy=self.policy, trust=self.trust,
                        kind='ext', base_url='https://cdn.fixture.invalid/a/b/tv.json')
        self.assertTrue(got.startswith('https://cdn.fixture.invalid/'))

    # ------------------------------------------------------------ 异常

    def test_blocked_pseudo_schemes(self):
        for url in ('file:///C:/Windows/win.ini', 'assets://tv.json',
                    'proxy://live', 'data:application/json,{}', 'jar:file:///x.jar!/',
                    'javascript:alert(1)', 'ftp://host/x.json', 'smb://host/share'):
            exc = self._blocked(url)
            self.assertEqual(exc.reason, 'scheme_blocked', url)
            self.assertEqual(exc.code, 'L1_CONFIG_BLOCKED', url)

    def test_blocked_local_disk_paths(self):
        for url in ('C:\\Users\\x\\tv.json', 'D:/tv.json',
                    '\\\\server\\share\\tv.json', '/etc/passwd'):
            exc = self._blocked(url)
            self.assertEqual(exc.reason, 'local_path_blocked', url)

    def test_relative_without_base_is_rejected_not_guessed(self):
        exc = self._blocked('./sub/tv.json')
        self.assertEqual(exc.reason, 'relative_without_base')

    def test_unknown_scheme_and_missing_host(self):
        self.assertEqual(self._blocked('gopher://host/x').reason, 'scheme_not_allowed')
        self.assertEqual(self._blocked('http:///nohost.json').reason, 'no_host')
        self.assertEqual(self._blocked('').reason, 'empty')

    def test_site_kind_downgrades_error_to_l2(self):
        exc = self._blocked('file:///x.jar', kind='jar', site_key='s1')
        self.assertEqual(exc.code, 'L2_SITE_BLOCKED')
        self.assertIn('[L2:security]', str(exc))

    # -------------------------------------------- 私网同源继承（PNA 模型）

    def test_public_config_cannot_reach_loopback_or_private(self):
        for url in ('http://127.0.0.1:9978/api', 'http://localhost:8080/x',
                    'http://10.1.2.3/x', 'http://192.168.0.9/x'):
            exc = self._blocked(url, kind='api', site_key='s')
            self.assertEqual(exc.reason, 'private_network_blocked', url)
            self.assertIn(exc.scope, ('loopback', 'private'), url)

    def test_user_entered_loopback_root_is_a_trust_root(self):
        """用户亲手输入 http://127.0.0.1:8000/tv.json 属于显式选择，同源子资源继承信任。"""
        trust = SourceTrust.for_source('http://127.0.0.1:8000/tv.json', policy=self.policy)
        self.assertEqual(trust.scope, 'loopback')
        got = guard_url('http://127.0.0.1:8000/jar/x.jar', policy=self.policy,
                        trust=trust, kind='jar')
        self.assertEqual(got, 'http://127.0.0.1:8000/jar/x.jar')

    def test_trust_inheritance_is_same_origin_not_same_machine(self):
        """同源 = scheme+host+port 全等。换端口/换主机名/换协议都不继承。"""
        trust = SourceTrust.for_source('http://127.0.0.1:8000/tv.json', policy=self.policy)
        for url in ('http://127.0.0.1:9978/x',      # 换端口 → 端口扫描
                    'http://localhost:8000/x',      # 换主机名
                    'https://127.0.0.1:8000/x',     # 换协议
                    'http://10.0.0.5:8000/x'):      # 换主机
            with self.assertRaises(ConfigSecurityError, msg=url) as caught:
                guard_url(url, policy=self.policy, trust=trust, kind='api')
            self.assertEqual(caught.exception.reason, 'private_network_blocked', url)

    def test_allow_private_network_is_the_only_override(self):
        policy = _policy(allow_private_network=True)
        got = guard_url('http://192.168.1.10/api', policy=policy, trust=self.trust,
                        kind='api')
        self.assertEqual(got, 'http://192.168.1.10/api')

    def test_inline_config_has_no_trusted_origin(self):
        trust = SourceTrust.for_source('{"sites":[]}', policy=self.policy)
        self.assertEqual(trust.scope, 'inline')
        self.assertFalse(trust.trusts('http://127.0.0.1:1/x'))


class LocalConfigPathTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='vpc-c25-')
        self.path = os.path.join(self.dir, 'tv.json')
        with open(self.path, 'w', encoding='utf-8') as handle:
            handle.write('{"sites":[]}')
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_requires_explicit_user_selection(self):
        policy = _policy()
        with self.assertRaises(ConfigSecurityError) as caught:
            guard_local_config_path(self.path, policy=policy,
                                    trust=SourceTrust(root=self.path, scope='local'))
        self.assertEqual(caught.exception.reason, 'local_file_not_selected')
        # 顶层来源即用户选择：`for_source(..., user_selected_local_file=True)`
        trust = SourceTrust.for_source(self.path, policy=policy,
                                       user_selected_local_file=True)
        self.assertEqual(guard_local_config_path(self.path, policy=policy, trust=trust),
                         os.path.realpath(self.path))

    def test_missing_file_is_fetch_failure_not_blocked(self):
        policy = _policy(allow_local_file=True)
        with self.assertRaises(ConfigSecurityError) as caught:
            guard_local_config_path(os.path.join(self.dir, 'nope.json'),
                                    policy=policy, trust=SourceTrust())
        self.assertEqual(caught.exception.code, 'L1_CONFIG_FETCH_FAILED')

    def test_oversize_local_file_is_rejected(self):
        policy = _policy(allow_local_file=True, max_local_config_bytes=4)
        with self.assertRaises(ConfigSecurityError) as caught:
            guard_local_config_path(self.path, policy=policy, trust=SourceTrust())
        self.assertEqual(caught.exception.code, 'L1_CONFIG_TOO_LARGE')


class SizeCapTest(unittest.TestCase):
    def test_read_capped_stops_before_buffering_everything(self):
        response = _FakeResponse([b'x' * 100] * 10)
        with self.assertRaises(ConfigSecurityError) as caught:
            read_capped(response, 250)
        self.assertEqual(caught.exception.reason, 'response_too_large')
        self.assertTrue(response.closed, '超限必须立刻断连，不能读完再判断')

    def test_read_capped_returns_body_under_limit(self):
        self.assertEqual(read_capped(_FakeResponse([b'ab', b'cd']), 16), b'abcd')

    def test_decompress_capped_blocks_compression_bomb(self):
        bomb = gzip.compress(b' ' * (4 * 1024 * 1024))
        self.assertLess(len(bomb), 64 * 1024, '夹具必须真的是「小压缩包、大解压体」')
        with self.assertRaises(ConfigSecurityError) as caught:
            decompress_capped(bomb, 1024)
        self.assertEqual(caught.exception.reason, 'decompressed_too_large')

    def test_decompress_capped_handles_zlib_and_passthrough(self):
        payload = b'{"sites":[]}'
        raw, flag = decompress_capped(zlib.compress(payload), 4096)
        self.assertEqual((raw, flag), (payload, True))
        raw, flag = decompress_capped(payload, 4096)
        self.assertEqual((raw, flag), (payload, False))

    def test_decompress_capped_tolerates_magic_false_positive(self):
        """恰好以 \\x1f\\x8b 开头的非 gzip 数据不能当成炸弹或崩掉，原样返回。"""
        raw, flag = decompress_capped(b'\x1f\x8bnot-really-gzip', 4096)
        self.assertEqual((raw, flag), (b'\x1f\x8bnot-really-gzip', False))


class FetchGuardedTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = FixtureServer().__enter__()
        cls.trust = SourceTrust.for_source(cls.fx.config('single.json'),
                                           policy=_policy())

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_normal_fetch_records_final_url_and_hash(self):
        got = fetch_guarded(self.fx.config('single.json'), policy=_policy(),
                            trust=self.trust)
        self.assertTrue(got.ok)
        self.assertIn(b'"cms_json"', got.raw)
        self.assertEqual(got.final_url, self.fx.config('single.json'))

    def test_redirects_are_followed_up_to_the_cap(self):
        policy = _policy(max_redirects=3)
        got = fetch_guarded(self.fx.url('hop/2'), policy=policy, trust=self.trust)
        self.assertTrue(got.ok)
        self.assertEqual(len(got.redirects), 2, '跳转链要如实记录，诊断页要能显示')

    def test_redirect_cap_is_enforced(self):
        policy = _policy(max_redirects=2)
        with self.assertRaises(ConfigSecurityError) as caught:
            fetch_guarded(self.fx.url('hop/9'), policy=policy, trust=self.trust)
        self.assertEqual(caught.exception.reason, 'too_many_redirects')

    def test_every_hop_is_re_guarded_so_redirect_cannot_reach_private(self):
        """跳转是绕过 SSRF 检查最常见的路径：公网源 302 到内网必须在跟随前被拒。"""
        public_trust = SourceTrust.for_source('https://cdn.fixture.invalid/tv.json',
                                             policy=_policy())
        with self.assertRaises(ConfigSecurityError) as caught:
            fetch_guarded(self.fx.url('redirect-to-private'), policy=_policy(),
                          trust=public_trust)
        # 第一跳本身就跨源（夹具在 127.0.0.1，信任根在公网）→ 先被私网守卫拦住。
        self.assertEqual(caught.exception.reason, 'private_network_blocked')

        # 信任根就是夹具自身时第一跳放行，第二跳（10.0.0.1）仍必须被拒。
        with self.assertRaises(ConfigSecurityError) as caught:
            fetch_guarded(self.fx.url('redirect-to-private'), policy=_policy(),
                          trust=self.trust)
        exc = caught.exception
        self.assertEqual(exc.reason, 'private_network_blocked')
        self.assertIn('10.0.0.1', exc.url)

    def test_declared_content_length_is_rejected_before_reading_body(self):
        policy = _policy(max_config_bytes=1024)
        with self.assertRaises(ConfigSecurityError) as caught:
            fetch_guarded(self.fx.url('huge.json'), policy=policy, trust=self.trust)
        self.assertEqual(caught.exception.reason, 'response_too_large')
        self.assertEqual(caught.exception.code, 'L1_CONFIG_TOO_LARGE')

    def test_gzip_bomb_over_the_wire_is_capped(self):
        policy = _policy(max_decompressed_bytes=64 * 1024)
        with self.assertRaises(ConfigSecurityError) as caught:
            fetch_guarded(self.fx.url('bomb.json.gz'), policy=policy, trust=self.trust)
        self.assertEqual(caught.exception.reason, 'decompressed_too_large')

    def test_timeout_surfaces_as_transport_error_not_security_error(self):
        """超时是取不到，不是被拒绝——两者必须能分开报告。"""
        started = time.monotonic()
        with self.assertRaises(Exception) as caught:
            fetch_guarded(self.fx.url('slow.json?ms=3000'), policy=_policy(),
                          trust=self.trust, timeout=(0.5, 0.5))
        self.assertNotIsInstance(caught.exception, ConfigSecurityError)
        self.assertLess(time.monotonic() - started, 2.5, '超时必须真的生效')


class ArtifactRegistryTest(unittest.TestCase):
    def test_same_url_changed_content_forces_reevaluation(self):
        registry = ArtifactRegistry()
        directory = tempfile.mkdtemp(prefix='vpc-c25-art-')
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, 'spider.jar')
        url = 'https://cdn.fixture.invalid/spider.jar'
        with open(path, 'wb') as handle:
            handle.write(b'PK\x03\x04first')
        first = registry.register('jar', url, path)
        self.assertTrue(first.changed, '首次登记必须视为变化')
        self.assertEqual(len(first.sha256), 64)
        again = registry.register('jar', url, path)
        self.assertFalse(again.changed, '同 URL 同内容不该反复重评')
        with open(path, 'wb') as handle:
            handle.write(b'PK\x03\x04second-and-different')
        third = registry.register('jar', url, path)
        self.assertTrue(third.changed, '同 URL 内容变了必须重评能力与权限')
        self.assertNotEqual(third.sha256, first.sha256)

    def test_unreadable_artifact_does_not_raise(self):
        registry = ArtifactRegistry()
        got = registry.register('jar', 'https://x.invalid/a.jar',
                                os.path.join(tempfile.gettempdir(), 'vpc-missing.jar'))
        self.assertEqual(got.sha256, '')
        self.assertEqual(got.size, 0)


class CancelledLoadIssuesNoRequestsTest(unittest.TestCase):
    """取消：`load()` 在取消已置位时必须在发出第一个守卫请求前就停下。"""

    def test_cancelled_before_fetch_makes_zero_requests(self):
        from config import ConfigManager
        from runtime.errors import RuntimeError as RuntimeContractError
        from site_manager import SiteManager

        with FixtureServer() as fx:
            manager = ConfigManager(SiteManager())
            cancel = threading.Event()
            cancel.set()
            with self.assertRaises(RuntimeContractError) as caught:
                manager.load(fx.config('single.json'), cancel_event=cancel)
            self.assertEqual(caught.exception.code, 'L1_CONFIG_CANCELLED')
            self.assertEqual(fx.hits('/config/single.json'), 0,
                             '取消后不得再向外发起任何请求')


if __name__ == '__main__':
    unittest.main(verbosity=2)
