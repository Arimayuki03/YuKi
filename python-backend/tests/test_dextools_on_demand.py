# -*- coding: utf-8 -*-
"""jar_bridge 按需下载链路（0.2.7 打包不随附 dex-tools 后的主路径）单元测试。

覆盖此前完全无测试的 _download_dextools_on_demand / _dex2jar_jar / _dexdeps_dir：
- 解析顺序：vendor 优先 → 缓存命中跳过下载 → 均缺失时触发按需下载；
- 上游 zip 真实顶层布局（dex-tools-v2.4/，无外层 dex-tools/ 包装层——
  回归点：曾按错误布局解压导致打包模式按需安装必然失败）；
- dexdeps 快路径完整性：主 jar 在而依赖缺 → 补全循环可达（回归点：曾提前
  return 跳过补全，缺失依赖永不重试）；
- 依赖哈希校验失败跳过、tmp+replace 原子落位；
- 失败负缓存：全部源失败后冷却期内不再发起下载（防弱网下每次请求都重跑
  完整下载链拖死调用方）。

禁止真实网络 / 真实子进程；zip 全部按上游真实布局在内存中构造。
"""
import hashlib
import io
import os
import shutil
import sys
import tempfile
import unittest
import unittest.mock
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

import jar_bridge  # noqa: E402


def _make_dextools_zip_bytes():
    """按上游 dex-tools-v2.4.zip 的真实布局构造内存 zip：顶层即 dex-tools-v2.4/。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('dex-tools-v2.4/lib/dex-tools-v2.4.jar', b'fake-dex-tools-jar')
        zf.writestr('dex-tools-v2.4/lib/dex-lib.jar', b'fake-dex-lib')
        zf.writestr('dex-tools-v2.4/LICENSE', b'Apache-2.0')
    return buf.getvalue()


def _fake_response(content):
    class _Rsp:
        def raise_for_status(self):
            return None

        @property
        def content(self):
            return content

    return _Rsp()


class DexToolsOnDemandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='yuki-dextools-test-')
        self.vendor_dir = os.path.join(self.tmp, 'vendor')
        self.cache_dir = os.path.join(self.tmp, 'cache')
        os.makedirs(self.vendor_dir)
        os.makedirs(self.cache_dir)
        self._orig_vendor = jar_bridge.hoststate.vendor_dir
        self._orig_cache = jar_bridge.hoststate.get_cache_dir
        jar_bridge.hoststate.vendor_dir = lambda: self.vendor_dir
        jar_bridge.hoststate.get_cache_dir = lambda: self.cache_dir
        # sha256 固定常量替换为夹具内容哈希：校验逻辑照常执行（内容不匹配即
        # 拒绝），只是把「钉住的期望值」换成可构造的。dexdeps 清单同理换为
        # 内容可构造的条目（原清单 sha256 无法反向造出内容）。
        self.zip_bytes = _make_dextools_zip_bytes()
        self._orig_zip_sha = jar_bridge.DEX_TOOLS_SHA256
        jar_bridge.DEX_TOOLS_SHA256 = hashlib.sha256(self.zip_bytes).hexdigest()
        self._orig_deps = jar_bridge.DEXDEPS_FILES
        self.fake_deps = [
            ('gson.jar', 'com/google/code/gson/gson/2.10.1/gson-2.10.1.jar', hashlib.sha256(b'content-gson').hexdigest()),
            ('kotlin-stdlib.jar', 'org/jetbrains/kotlin/kotlin-stdlib/1.8.21/kotlin-stdlib-1.8.21.jar', hashlib.sha256(b'content-kotlin-stdlib').hexdigest()),
            ('okhttp3.jar', 'com/squareup/okhttp3/okhttp/4.12.0/okhttp-4.12.0.jar', hashlib.sha256(b'content-okhttp3').hexdigest()),
        ]
        jar_bridge.DEXDEPS_FILES = self.fake_deps
        # 重置模块级负缓存状态，保证用例间隔离
        jar_bridge._dex_tools_failed_at = 0.0
        jar_bridge._dex_tools_checked.clear()

    def tearDown(self):
        jar_bridge.hoststate.vendor_dir = self._orig_vendor
        jar_bridge.hoststate.get_cache_dir = self._orig_cache
        jar_bridge.DEX_TOOLS_SHA256 = self._orig_zip_sha
        jar_bridge.DEXDEPS_FILES = self._orig_deps
        jar_bridge._dex_tools_failed_at = 0.0
        jar_bridge._dex_tools_checked.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _fake_get_zip_ok(self, url, **kwargs):
        if url in jar_bridge.DEX_TOOLS_URLS:
            return _fake_response(self.zip_bytes)
        for name, rel, sha in self.fake_deps:
            if url == jar_bridge.MAVEN_BASE + rel:
                return _fake_response(f'content-{name[:-4]}'.encode())
        raise AssertionError(f'unexpected url {url}')

    # ---------------------------------------------------------------- vendor/缓存解析

    def test_vendor_priority(self):
        """vendor 下已有完整布局：直接返回，不触网不触发下载。"""
        jar = os.path.join(self.vendor_dir, 'dex-tools', 'dex-tools-v2.4', 'lib', 'dex-tools-v2.4.jar')
        os.makedirs(os.path.dirname(jar))
        with open(jar, 'wb') as f:
            f.write(b'x')
        called = []
        with unittest.mock.patch('http_client.get', side_effect=lambda *a, **k: called.append(a)):
            self.assertEqual(jar_bridge._dex2jar_jar(), jar)
        self.assertEqual(called, [], 'vendor 命中时不得发起任何 HTTP 请求')

    def test_cache_hit_skips_download(self):
        """缓存目录已有完整布局：_dex2jar_jar 直接命中，不重下载。"""
        jar = os.path.join(self.cache_dir, 'dextools', 'dex-tools', 'dex-tools-v2.4', 'lib', 'dex-tools-v2.4.jar')
        os.makedirs(os.path.dirname(jar))
        with open(jar, 'wb') as f:
            f.write(b'x')
        called = []
        with unittest.mock.patch('http_client.get', side_effect=lambda *a, **k: called.append(a)):
            self.assertEqual(jar_bridge._dex2jar_jar(), jar)
        self.assertEqual(called, [])

    # ---------------------------------------------------------------- 下载落位布局

    def test_download_installs_real_layout(self):
        """vendor/缓存均缺失：下载并按真实上游布局落位为 cache/dex-tools/dex-tools-v2.4/。"""
        with unittest.mock.patch('http_client.get', return_value=_fake_response(self.zip_bytes)):
            jar = jar_bridge._dex2jar_jar()
        self.assertEqual(
            jar,
            os.path.join(self.cache_dir, 'dextools', 'dex-tools', 'dex-tools-v2.4', 'lib', 'dex-tools-v2.4.jar'),
            '落位路径必须与 vendor 布局一致（dex-tools/dex-tools-v2.4/lib/…）')
        self.assertTrue(os.path.isfile(jar), '按需安装后主 jar 必须真实存在')

    def test_download_wrong_hash_falls_through_to_fail(self):
        """sha256 与固定值不符：跳过该源；全部源不匹配 → 返回 None 并进负缓存。"""
        bad = b'corrupted' * 1024
        with unittest.mock.patch('http_client.get', return_value=_fake_response(bad)):
            self.assertIsNone(jar_bridge._download_dextools_on_demand())

    def test_dexdeps_completed_on_download(self):
        """下载成功后 dexdeps 依赖 jar 全部落盘且内容哈希与清单一致。"""
        with unittest.mock.patch('http_client.get', side_effect=self._fake_get_zip_ok):
            jar = jar_bridge._dex2jar_jar()
        self.assertTrue(jar)
        deps_dir = os.path.join(self.cache_dir, 'dextools', 'dexdeps')
        for name, rel, sha in self.fake_deps:
            dep = os.path.join(deps_dir, name)
            self.assertTrue(os.path.isfile(dep), f'{name} 应已落盘')
            with open(dep, 'rb') as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), sha,
                                 f'{name} 内容哈希须与清单一致')

    def test_dexdeps_hash_mismatch_skipped(self):
        """依赖 jar 哈希不符：跳过该文件（不落坏产物），主 jar 仍安装成功。"""
        bad_content = b'not-the-real-jar'

        def fake_get(url, **kwargs):
            if url in jar_bridge.DEX_TOOLS_URLS:
                return _fake_response(self.zip_bytes)
            for name, rel, sha in self.fake_deps:
                if url == jar_bridge.MAVEN_BASE + rel:
                    return _fake_response(b'not-the-real-jar')
            raise AssertionError(f'unexpected url {url}')

        with unittest.mock.patch('http_client.get', side_effect=fake_get):
            jar = jar_bridge._dex2jar_jar()
        self.assertTrue(jar, 'dexdeps 单文件失败不得影响主 jar 安装')
        deps_dir = os.path.join(self.cache_dir, 'dextools', 'dexdeps')
        self.assertFalse(os.path.exists(os.path.join(deps_dir, 'gson.jar')), '哈希不符的依赖不得落盘')

    # ---------------------------------------------------------------- 快路径与补全

    def test_fast_path_requires_complete_deps(self):
        """主 jar 已在而 dexdeps 缺失：快路径不得直接放行，须补全缺失依赖（回归点）。"""
        # 预置主 jar + 部分依赖（缺 gson.jar）
        jar = os.path.join(self.cache_dir, 'dextools', 'dex-tools', 'dex-tools-v2.4', 'lib', 'dex-tools-v2.4.jar')
        os.makedirs(os.path.dirname(jar))
        with open(jar, 'wb') as f:
            f.write(b'x')
        deps_dir = os.path.join(self.cache_dir, 'dextools', 'dexdeps')
        os.makedirs(deps_dir)
        for name, rel, sha in self.fake_deps[:-1]:
            with open(os.path.join(deps_dir, name), 'wb') as f:
                f.write(f'content-{name[:-4]}'.encode())
        # 未预置 zip：下载链会因 zip 源哈希不符而失败 → 返回 None（而非放行不完整快路径）
        with unittest.mock.patch('http_client.get', return_value=_fake_response(b'bad-zip')):
            self.assertIsNone(
                jar_bridge._download_dextools_on_demand(),
                '依赖不完整时应尝试补全（此处补全失败 → None），不得提前 return 主 jar')

    def test_no_tmp_residue_after_dexdeps_write(self):
        """依赖写盘走 tmp+replace：成功后不残留 .tmp 文件。"""
        with unittest.mock.patch('http_client.get', side_effect=self._fake_get_zip_ok):
            self.assertTrue(jar_bridge._dex2jar_jar())
        deps_dir = os.path.join(self.cache_dir, 'dextools', 'dexdeps')
        self.assertEqual([f for f in os.listdir(deps_dir) if f.endswith('.tmp')], [],
                         '不得残留 .tmp 半截文件')

    # ---------------------------------------------------------------- 失败负缓存

    def test_failure_cooldown_blocks_retry(self):
        """全部源失败后进入冷却期：冷却期内再次调用直接放弃，不发请求。"""
        calls = []

        def fake_get(url, **kwargs):
            calls.append(url)
            raise RuntimeError('network down')

        with unittest.mock.patch('http_client.get', side_effect=fake_get):
            self.assertIsNone(jar_bridge._download_dextools_on_demand())
            first_round = len(calls)
            self.assertGreater(first_round, 0, '首次应真实尝试下载')
            self.assertIsNone(jar_bridge._download_dextools_on_demand())
            self.assertEqual(len(calls), first_round, '冷却期内第二次调用不得再发请求')

    def test_cooldown_expires_retries(self):
        """冷却期过后恢复重试（注入时间戳前移模拟时间流逝）。"""
        with unittest.mock.patch('http_client.get', side_effect=RuntimeError('network down')):
            self.assertIsNone(jar_bridge._download_dextools_on_demand())
        jar_bridge._dex_tools_failed_at -= jar_bridge._DEX_TOOLS_RETRY_COOLDOWN_S + 1
        with unittest.mock.patch('http_client.get', side_effect=self._fake_get_zip_ok) as m:
            jar = jar_bridge._dex2jar_jar()
        self.assertTrue(jar, '冷却期后应恢复下载并成功')
        self.assertGreater(m.call_count, 0)
        self.assertTrue(m.call_count > 0)


if __name__ == '__main__':
    unittest.main()
