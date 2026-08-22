# -*- coding: utf-8 -*-
"""vendor/resources 根解析契约：开发、打包（YUKI_RESOURCES_ROOT 注入）、冻结产物
（exe 上溯）三种形态都必须给出可用路径。

背景：jar 运行时的 spider-runner.jar / dex-tools / dexdeps / jre 都在 vendor/ 下，
vendor 由 electron-builder 作为 extraResources 放进 resources/，不在 PyInstaller
产物内。打包版曾用 ``__file__/../vendor`` 直拼——冻结产物里 __file__ 在 _internal/
下，拼出来的路径不存在，于是所有 jar 站点 Worker 初始化即 L3_RUNTIME_INIT_FAILED。

用法：<venv>/python tests/test_resources_root.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest import mock

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import hoststate  # noqa: E402


class ResourcesRootTest(unittest.TestCase):
    def setUp(self):
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop('YUKI_RESOURCES_ROOT', None)

    tearDown = lambda self: self._env.stop()  # noqa: E731

    def test_env_injection_wins(self):
        """python-bridge 注入的 YUKI_RESOURCES_ROOT 优先（打包模式的正路）。"""
        with tempfile.TemporaryDirectory(prefix='yuki_res_') as tmp:
            os.environ['YUKI_RESOURCES_ROOT'] = tmp
            self.assertEqual(hoststate.resources_root(), tmp)

    def test_env_must_be_existing_dir(self):
        os.environ['YUKI_RESOURCES_ROOT'] = os.path.join('Z:', 'no', 'such', 'dir')
        self.assertNotIn('no', hoststate.resources_root())

    def test_dev_fallback_is_repo_root(self):
        """开发模式（未冻结、无注入）回退 python-backend/.. = 仓库根。"""
        self.assertEqual(hoststate.resources_root(), os.path.dirname(BASE))

    def _fake_frozen(self, exe_path):
        return (
            mock.patch.object(sys, 'frozen', True, create=True),
            mock.patch.object(sys, 'executable', exe_path),
        )

    def test_frozen_onedir_walks_up_two_levels(self):
        """onedir：resources/python-backend/yuki-backend/yuki-backend.exe → resources/。"""
        with tempfile.TemporaryDirectory(prefix='yuki_res_') as tmp:
            exe = os.path.join(tmp, 'python-backend', 'yuki-backend', 'yuki-backend.exe')
            os.makedirs(os.path.dirname(exe), exist_ok=True)
            os.makedirs(os.path.join(tmp, 'vendor'), exist_ok=True)
            p1, p2 = self._fake_frozen(exe)
            with p1, p2:
                self.assertEqual(hoststate.resources_root(), tmp)

    def test_frozen_flat_exe_walks_up_one_level(self):
        """旧 onefile 布局：resources/python-backend/yuki-backend.exe → resources/。"""
        with tempfile.TemporaryDirectory(prefix='yuki_res_') as tmp:
            exe = os.path.join(tmp, 'python-backend', 'yuki-backend.exe')
            os.makedirs(os.path.dirname(exe), exist_ok=True)
            os.makedirs(os.path.join(tmp, 'vendor'), exist_ok=True)
            p1, p2 = self._fake_frozen(exe)
            with p1, p2:
                self.assertEqual(hoststate.resources_root(), tmp)

    def test_frozen_without_vendor_falls_back_to_dev_root(self):
        """独立运行冻结 exe（无注入、周边无 vendor）时回退开发路径，不抛异常。"""
        with tempfile.TemporaryDirectory(prefix='yuki_res_') as tmp:
            exe = os.path.join(tmp, 'bin', 'yuki-backend.exe')
            os.makedirs(os.path.dirname(exe), exist_ok=True)
            p1, p2 = self._fake_frozen(exe)
            with p1, p2:
                self.assertEqual(hoststate.resources_root(), os.path.dirname(BASE))


class VendorPathsTest(unittest.TestCase):
    """jar 运行时资产路径必须跟随 resources 根解析（开发模式即仓库 vendor/）。"""

    def test_jar_bridge_runner_jar_resolves_via_vendor_dir(self):
        import jar_bridge
        self.assertIn(os.path.join('vendor', 'spider-runner.jar'), jar_bridge.DEFAULT_RUNNER_JAR)
        self.assertEqual(
            jar_bridge.DEFAULT_RUNNER_JAR,
            os.path.join(hoststate.vendor_dir(), 'spider-runner.jar'))

    def test_config_runner_jar_matches_jar_bridge(self):
        import config
        import jar_bridge
        self.assertEqual(config.DEFAULT_RUNNER_JAR, jar_bridge.DEFAULT_RUNNER_JAR)

    def test_java_probe_uses_hoststate_root(self):
        import java_probe
        self.assertEqual(java_probe._resources_root(), hoststate.resources_root())


if __name__ == '__main__':
    unittest.main(verbosity=2)
