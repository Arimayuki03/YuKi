# -*- coding: utf-8 -*-
"""C2 Dex2Jar 生命周期、原子写入与异常处理测试。

验证：
1. DEX 转换为 JVM jar 过程中发生非0退出码、超时、异常时，绝不假成功回退，而是抛出 RuntimeContractError；
2. 中断或失败时不产生破损的 .tmp 孤儿文件；
3. 转译成功时使用原子重命名并清理临时文件。
"""
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

import java_probe  # noqa: E402
from jar_bridge import JarBridge  # noqa: E402
from runtime.errors import RuntimeError as RuntimeContractError  # noqa: E402


def _make_dummy_dex_jar(target_path):
    """创建一个包含 classes.dex 的假 Android JAR。"""
    with zipfile.ZipFile(target_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('classes.dex', b'dex\n035\x00dummy_dex_bytes')
        zf.writestr('com/github/catvod/spider/Test.class', b'fake_class')


def _make_dummy_jvm_jar(target_path):
    """创建一个纯标准 JVM class JAR（不含 classes.dex）。"""
    with zipfile.ZipFile(target_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('com/github/catvod/spider/Test.class', b'fake_class')


class Dex2JarLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix='d2j_test_')
        # 确保 java_probe 探测返回虚拟 java 路径以测试 dex2jar 执行链路
        self._orig_find_java = java_probe.find_java
        java_probe.find_java = lambda: 'java.exe'

    def tearDown(self):
        java_probe.find_java = self._orig_find_java
        import shutil
        if os.path.isdir(self.tmp_dir):
            shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_missing_java_raises_init_failed_and_cleans_nothing(self):
        """当系统无 Java 运行时，直接抛出 L3_RUNTIME_INIT_FAILED。"""
        java_probe.find_java = lambda: None
        jar_path = os.path.join(self.tmp_dir, 'no_java.jar')
        _make_dummy_dex_jar(jar_path)
        with self.assertRaises(RuntimeContractError) as ctx:
            JarBridge._ensure_jvm_compatible(jar_path)
        self.assertEqual(ctx.exception.code, 'L3_RUNTIME_INIT_FAILED')
        self.assertIn('Java runtime not found', str(ctx.exception.raw_error))

    def test_standard_jvm_jar_bypasses_dex2jar(self):
        """标准 JVM jar 不触发 dex2jar，直接返回原文件。"""
        jar_path = os.path.join(self.tmp_dir, 'standard.jar')
        _make_dummy_jvm_jar(jar_path)
        res = JarBridge._ensure_jvm_compatible(jar_path)
        self.assertTrue(os.path.isfile(res))
        self.assertFalse(res.endswith('-jvm.jar'))

    def test_dex2jar_failed_exit_code_raises_contract_error_and_cleans_tmp(self):
        """dex2jar 返回非 0 退出码时抛出 L3_RUNTIME_INIT_FAILED，且不残留 .tmp 文件，不返回假成功。"""
        jar_path = os.path.join(self.tmp_dir, 'android_corrupt.jar')
        _make_dummy_dex_jar(jar_path)
        tmp_jvm = os.path.join(self.tmp_dir, 'android_corrupt-jvm.jar.tmp')
        final_jvm = os.path.join(self.tmp_dir, 'android_corrupt-jvm.jar')

        # 模拟 subprocess.run 返回错误码 1
        fake_result = subprocess.CompletedProcess(
            args=['java', 'dex2jar'],
            returncode=1,
            stdout=b'',
            stderr=b'DexException: Bad dex magic'
        )

        def _mock_run(cmd, capture_output=True, timeout=120):
            # 模拟在执行中途产生了一个 .tmp 文件
            with open(tmp_jvm, 'wb') as f:
                f.write(b'partial broken jar')
            return fake_result

        orig_run = subprocess.run
        subprocess.run = _mock_run
        try:
            with self.assertRaises(RuntimeContractError) as ctx:
                JarBridge._ensure_jvm_compatible(jar_path)
            self.assertEqual(ctx.exception.code, 'L3_RUNTIME_INIT_FAILED')
            self.assertIn('dex2jar conversion failed', str(ctx.exception.raw_error))
            # 必须验证临时破损文件已被清理
            self.assertFalse(os.path.exists(tmp_jvm), '.tmp file must be cleaned up on failure')
            self.assertFalse(os.path.exists(final_jvm), 'final jvm jar must not exist on failure')
        finally:
            subprocess.run = orig_run

    def test_dex2jar_timeout_raises_timeout_error_and_cleans_tmp(self):
        """dex2jar 超时抛出 L3_RUNTIME_TIMEOUT 契约错误，且不残留 .tmp 文件。"""
        jar_path = os.path.join(self.tmp_dir, 'android_timeout.jar')
        _make_dummy_dex_jar(jar_path)
        tmp_jvm = os.path.join(self.tmp_dir, 'android_timeout-jvm.jar.tmp')
        final_jvm = os.path.join(self.tmp_dir, 'android_timeout-jvm.jar')

        def _mock_timeout(cmd, capture_output=True, timeout=120):
            with open(tmp_jvm, 'wb') as f:
                f.write(b'stalled partial bytes')
            raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout)

        orig_run = subprocess.run
        subprocess.run = _mock_timeout
        try:
            with self.assertRaises(RuntimeContractError) as ctx:
                JarBridge._ensure_jvm_compatible(jar_path)
            self.assertEqual(ctx.exception.code, 'L3_RUNTIME_TIMEOUT')
            self.assertFalse(os.path.exists(tmp_jvm), '.tmp file must be cleaned up on timeout')
            self.assertFalse(os.path.exists(final_jvm), 'final jvm jar must not exist on timeout')
        finally:
            subprocess.run = orig_run

    def test_dex2jar_success_atomic_replace(self):
        """dex2jar 成功时通过原子重命名生成 -jvm.jar 产物。"""
        jar_path = os.path.join(self.tmp_dir, 'android_ok.jar')
        _make_dummy_dex_jar(jar_path)
        tmp_jvm = os.path.join(self.tmp_dir, 'android_ok-jvm.jar.tmp')
        final_jvm = os.path.join(self.tmp_dir, 'android_ok-jvm.jar')

        def _mock_success(cmd, capture_output=True, timeout=120):
            # dex2jar 工具输出到 -o 指定的 tmp_jvm
            _make_dummy_jvm_jar(tmp_jvm)
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout=b'ok', stderr=b'')

        orig_run = subprocess.run
        subprocess.run = _mock_success
        try:
            res = JarBridge._ensure_jvm_compatible(jar_path)
            self.assertTrue(os.path.isfile(final_jvm))
            self.assertFalse(os.path.exists(tmp_jvm))
            self.assertEqual(os.path.abspath(res), os.path.abspath(final_jvm))
        finally:
            subprocess.run = orig_run


if __name__ == '__main__':
    unittest.main()
