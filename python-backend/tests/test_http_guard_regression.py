# -*- coding: utf-8 -*-
"""问题 #6 / #9 修复回归：

- #6：`JarBridge.destroy_all` 曾在持有不可重入 `_jar_bridges_lock` 的循环里调用
  `destroy()`，而 `destroy()` 自身要重新获取同一把锁 → 退出/热重载永久死锁。
  修复后锁内只摘除实例、锁外逐个销毁，与 `_evict_jvm_if_needed_locked` 同模式。
- #9：远程 py/jar/CMS 下载曾绕过逐跳 SSRF 守卫与体积守卫：
  - `http_client.fetch_follow_redirects` 现在每一跳都过 `guard_url`（策略机制与
    配置层一致，`YUKI_CONFIG_BLOCK_PRIVATE_NETWORK=1` 生效）且响应体流式限长；
  - `jar_bridge.requests_get_jar` 弃用 requests 自动跟重定向，改为手动逐跳 +
    512MB 限长。

原则：只用 loopback 夹具，不出网；错误断言断在 reason/错误码上。
"""
import os
import sys
import threading
import time
import unittest
from collections import OrderedDict
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
for path in (BASE, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

import http_client  # noqa: E402
import jar_bridge  # noqa: E402
from offline_config_server import FixtureServer  # noqa: E402
from runtime.config_security import reset_dns_cache  # noqa: E402


def _strict_env(**kw):
    """严格 SSRF 防护环境（含覆盖项）。"""
    env = {'YUKI_CONFIG_BLOCK_PRIVATE_NETWORK': '1'}
    env.update(kw)
    return env


def assert_private_blocked(testcase, exc, host='10.0.0.1'):
    """断言异常确为私网守卫拒绝。

    ConfigSecurityError 的 reason 字段与正文是分开的（正文是给诊断页的中文文案，
    且外层包装可能截断），所以断言优先打在 reason 上，退回正文标记；被拦的
    主机名必须出现，防止「因别的理由失败」被误判为通过。
    """
    reason = str(getattr(exc, 'reason', '') or '')
    text = str(exc)
    testcase.assertTrue(
        reason == 'private_network_blocked' or '本机/内网' in text,
        f'expected private_network_blocked, got: {text!r}')
    testcase.assertIn(host, text)


class _StrictMixin:
    """夹具 + 私网守卫需要的环境隔离。

    私网判定默认做真实 DNS 解析——测试里 `.invalid`/`.test` 后缀不解析，但
    `10.0.0.1` 是 IP 字面量也不需要解析；`127.0.0.1` 夹具自身是 loopback，
    同样是字面量。跨进程 DNS 缓存仍按惯例清一次，避免上一轮测试的旧结论遮挡。
    """

    def setUp(self):
        super().setUp()
        reset_dns_cache()


class FetchFollowRedirectsGuardTest(_StrictMixin, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = FixtureServer().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_default_mode_follows_and_decodes(self):
        """默认（开关关）：公网/夹具链路照常取回，鸭子属性齐全。"""
        rsp = http_client.fetch_follow_redirects(self.fx.url('config/single.json'),
                                                 timeout=5)
        self.assertEqual(rsp.status_code, 200)
        self.assertIn(b'cms_json', rsp.content)
        self.assertTrue(rsp.text.strip())
        self.assertIsInstance(rsp.apparent_encoding, str)
        self.assertIn('Content-Type', rsp.headers)

    def test_default_mode_follows_hops(self):
        rsp = http_client.fetch_follow_redirects(self.fx.url('hop/2'), timeout=5)
        self.assertEqual(rsp.status_code, 200)
        self.assertIn(b'cms_json', rsp.content)

    def test_default_mode_allows_lan_cms_source(self):
        """默认策略放行本机/内网引用：局域网 CMS 源不能突然不可用（兼容性验收）。"""
        spider_url = self.fx.url('py/site.py')
        rsp = http_client.fetch_follow_redirects(spider_url, timeout=5)
        self.assertEqual(rsp.status_code, 200)

    def test_strict_mode_blocks_redirect_to_private(self):
        """开关打开：用户给定源 302 到 10.0.0.1，必须在跟随前被拒——
        重定向目标是远端响应派生的地址，不继承第一跳的同源信任。"""
        with patch.dict(os.environ, _strict_env()):
            with self.assertRaises(Exception) as caught:
                http_client.fetch_follow_redirects(
                    self.fx.url('redirect-to-private'), timeout=5,
                    trust_root=self.fx.url('redirect-to-private'))
            assert_private_blocked(self, caught.exception)

    def test_strict_mode_allows_user_entered_private_root(self):
        """严格模式下用户/配置**直接填写**的私网地址仍可达（其自身即信任根，
        与配置层 fetch_text「用户输入即显式选择」语义一致——局域网 CMS 源不因
        开关失效）；真正的防线在「公网源 302 到私网」的跳转被拒。

        验证方式用**同机异名**跳转：`localhost:port` 根（用户输入）跳到
        `127.0.0.1:port`（同机同端口、不同 origin）——host 不同 → 跨源私网，
        严格模式必须拒绝；若被放宽成「只要是本机就放行」则该用例拿到 200。"""
        with patch.dict(os.environ, _strict_env()):
            root = self.fx.cross_origin('redirect-cross-host')
            with self.assertRaises(Exception) as caught:
                http_client.fetch_follow_redirects(root, timeout=5, trust_root=root)
            assert_private_blocked(self, caught.exception, host='127.0.0.1')

    def test_strict_mode_same_origin_loopback_root_still_works(self):
        """开关打开：用户显式给出的 loopback 源（信任根）同源子资源照常取回。"""
        with patch.dict(os.environ, _strict_env()):
            root = self.fx.url('config/single.json')
            rsp = http_client.fetch_follow_redirects(root, timeout=5,
                                                     trust_root=root)
            self.assertEqual(rsp.status_code, 200)
            self.assertIn(b'cms_json', rsp.content)

    def test_body_over_cap_is_rejected_before_full_buffer(self):
        """响应体超上限必须立刻断连拒绝——不能无上限全量入内存。"""
        with patch.dict(os.environ, _strict_env(max_body_bytes='64')):
            root = self.fx.url('config/single.json')
            with self.assertRaises(ValueError) as caught:
                http_client.fetch_follow_redirects(root, timeout=5,
                                                   trust_root=root,
                                                   max_bytes=64)
            self.assertIn('exceeds 64 bytes cap', str(caught.exception))

    def test_strict_mode_cap_uses_max_api_response_bytes(self):
        with patch.dict(os.environ, _strict_env()):
            root = self.fx.url('config/single.json')
            with patch.object(http_client, 'MAX_API_RESPONSE_BYTES', 8):
                with self.assertRaises(ValueError) as caught:
                    http_client.fetch_follow_redirects(root, timeout=5,
                                                       trust_root=root)
                self.assertIn('exceeds 8 bytes cap', str(caught.exception))


class CmsSpiderGuardTest(_StrictMixin, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = FixtureServer().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_cms_json_payload_still_parses(self):
        """存量行为兼容：CMS API（JSON 形态）经守卫路径照常出数据。"""
        from cms_spider import CmsSpider
        spider = CmsSpider('cms_guard', self.fx.url('config/single.json'), stype=1)
        data = spider._fetch({})
        self.assertTrue(data)

    def test_cms_strict_mode_blocks_redirect_to_private(self):
        from cms_spider import CmsSpider
        spider = CmsSpider('cms_guard_private', self.fx.url('redirect-to-private'),
                           stype=1)
        with patch.dict(os.environ, _strict_env()):
            with self.assertRaises(Exception) as caught:
                spider._fetch({'ac': 'class'})
            assert_private_blocked(self, caught.exception)

    def test_cms_strict_mode_allows_user_entered_private_root(self):
        """局域网 CMS 源（用户直接填写）在严格模式下第一跳仍可达。"""
        from cms_spider import CmsSpider
        dead_root = 'http://127.0.0.1:9/api'
        spider = CmsSpider('cms_guard_private_root', dead_root, stype=1)
        with patch.dict(os.environ, _strict_env()):
            with self.assertRaises(Exception) as caught:
                spider._fetch({'ac': 'class'})
            self.assertNotIn('private_network_blocked', str(caught.exception))


class PythonSpiderMaterializeGuardTest(_StrictMixin, unittest.TestCase):
    """config._materialize_python_spider（远程 py 落盘后会被 exec_module）的守卫链。"""

    @classmethod
    def setUpClass(cls):
        cls.fx = FixtureServer().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def _manager(self):
        from config import ConfigManager
        from site_manager import SiteManager
        return ConfigManager(SiteManager())

    def test_strict_mode_blocks_private_redirect_chain(self):
        """远程 py 源 302 到私网：跳转目标不继承信任（远端内容派生的地址），
        严格模式下必须在跟随前被拒——落盘文件会被 exec_module 执行，这条链
        就是 RCE 面。"""
        with patch.dict(os.environ, _strict_env()):
            with self.assertRaises(Exception) as caught:
                self._manager()._materialize_python_spider(
                    'py_guard_private', self.fx.url('redirect-to-private'))
            assert_private_blocked(self, caught.exception)

    def test_default_mode_materializes_fixture_source(self):
        with patch.dict(os.environ, {}):
            os.environ.pop('YUKI_CONFIG_BLOCK_PRIVATE_NETWORK', None)
            path = self._manager()._materialize_python_spider(
                'py_guard_ok', self.fx.url('py/site.py'))
            self.assertTrue(os.path.isfile(path))


class RequestsGetJarGuardTest(_StrictMixin, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = FixtureServer().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def test_default_mode_downloads_fixture_jar(self):
        rsp = jar_bridge.requests_get_jar(self.fx.url('jar/tiny.jar'), timeout=10)
        self.assertTrue(rsp[:2] == b'PK' or rsp[:4] == b'dex\n')

    def test_default_mode_follows_hops(self):
        rsp = jar_bridge.requests_get_jar(self.fx.url('hop-jar/2/tiny.jar'),
                                          timeout=10)
        self.assertTrue(rsp[:2] == b'PK' or rsp[:4] == b'dex\n')

    def test_strict_mode_blocks_redirect_to_private(self):
        """jar 源 302 到私网：重定向目标不继承信任，严格模式下跟随前被拒。"""
        with patch.dict(os.environ, _strict_env()):
            with self.assertRaises(Exception) as caught:
                jar_bridge.requests_get_jar(self.fx.url('redirect-to-private'),
                                            timeout=10)
            assert_private_blocked(self, caught.exception)

    def test_strict_mode_allows_user_entered_private_root(self):
        """jar 源直接指向内网（NAS 场景）在严格模式下第一跳仍可达——
        其自身即信任根；端口不可达失败必须是传输错误而非安全拒绝。"""
        with patch.dict(os.environ, _strict_env()):
            with self.assertRaises(Exception) as caught:
                jar_bridge.requests_get_jar('http://127.0.0.1:9/x.jar', timeout=5)
            self.assertNotIn('private_network_blocked', str(caught.exception))

    def test_body_over_cap_is_rejected(self):
        with patch.dict(os.environ, _strict_env()):
            with patch.object(jar_bridge, 'MAX_JAR_DOWNLOAD_BYTES', 8):
                with self.assertRaises(ValueError) as caught:
                    jar_bridge.requests_get_jar(self.fx.url('jar/tiny.jar'),
                                                timeout=10)
                self.assertIn('exceeds 8 bytes cap', str(caught.exception))

    def test_too_many_redirects_rejected(self):
        with self.assertRaises(ValueError) as caught:
            jar_bridge.requests_get_jar(self.fx.url('hop-jar/9/tiny.jar'), timeout=10)
        self.assertIn('too many redirects', str(caught.exception))


class DestroyAllNoDeadlockTest(unittest.TestCase):
    """#6 回归：destroy_all 不得在 _jar_bridges_lock 内调用 destroy()。

    夹具桥 destroy() 时重入 `_jar_bridges_lock` 并记录（真实实现里 destroy()
    也会进这把锁做缓存摘除）。修复前：destroy_all 持锁循环 destroy → 死锁。
    """

    def setUp(self):
        jar_bridge._jar_bridges.clear()
        jar_bridge._jar_lru.clear()

    def tearDown(self):
        jar_bridge._jar_bridges.clear()
        jar_bridge._jar_lru.clear()

    def _fixture_bridge(self, jar_path):
        bridge = jar_bridge.JarBridge(jar_path)
        bridge.proc = None  # destroy() 走无进程路径，只做缓存摘除
        return bridge

    def _destroy_on_thread(self, bridges):
        for path, bridge in bridges.items():
            jar_bridge._jar_bridges[path] = bridge
        jar_bridge._jar_lru.update({p: True for p in bridges})

        def recording_destroy(self):
            """模拟真实 destroy() 的缓存摘除行为（重入同一把锁）。"""
            with jar_bridge._jar_bridges_lock:
                jar_bridge._jar_bridges.pop(self.jar_path, None)
                jar_bridge._jar_lru.pop(self.jar_path, None)
            self.destroyed = True

        done = []

        def run():
            with patch.object(jar_bridge.JarBridge, 'destroy', recording_destroy):
                jar_bridge.JarBridge.destroy_all()
            done.append(True)

        worker = threading.Thread(target=run, name='destroy-all-probe', daemon=True)
        started = time.monotonic()
        worker.start()
        worker.join(timeout=10)
        elapsed = time.monotonic() - started
        return worker, done, elapsed

    def test_destroy_all_returns_and_destroys_every_bridge(self):
        bridges = {
            os.path.join(BASE, 'a.jar'): self._fixture_bridge(os.path.join(BASE, 'a.jar')),
            os.path.join(BASE, 'b.jar'): self._fixture_bridge(os.path.join(BASE, 'b.jar')),
        }
        worker, done, elapsed = self._destroy_on_thread(bridges)
        self.assertTrue(done, 'destroy_all 在 10s 内未返回——存在死锁（#6 未修复）')
        self.assertFalse(worker.is_alive())
        self.assertLess(elapsed, 5, 'destroy_all 不应阻塞数秒才返回')
        for bridge in bridges.values():
            self.assertTrue(getattr(bridge, 'destroyed', False),
                            '每个桥都必须在锁外被 destroy()')
        self.assertEqual(jar_bridge._jar_bridges, {})
        self.assertEqual(jar_bridge._jar_lru, OrderedDict())

    def test_destroy_all_tolerates_destroy_exception(self):
        bridge = self._fixture_bridge(os.path.join(BASE, 'boom.jar'))

        def raising_destroy(self):
            raise RuntimeError('boom')

        with patch.object(jar_bridge.JarBridge, 'destroy', raising_destroy):
            jar_bridge._jar_bridges[bridge.jar_path] = bridge
            jar_bridge._jar_lru[bridge.jar_path] = True
            jar_bridge.JarBridge.destroy_all()
        self.assertEqual(jar_bridge._jar_bridges, {})


if __name__ == '__main__':
    unittest.main()
