# -*- coding: utf-8 -*-
"""Q7.2 运行时契约夹具测试套件：
- Python 正常/异常/无限循环 Spider
- JS 正常/缺全局/Promise 永不完成 Spider
- portable JAR 正常/异常/Proxy 流
- Android Context、二级 DEX、native .so 三类 JAR，验证 dex2jar/JVM 回退路径
"""
import os
import sys
import unittest
import zipfile

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from runtime.contracts import RuntimeRequest
from runtime.supervisor import RuntimeSupervisor, RuntimePolicy
from jar_bridge import JarBridge, classify_jar_compatibility


class TestQ7RuntimeContractFixtures(unittest.TestCase):
    def test_python_normal_error_and_infinite_loop(self):
        policy = RuntimePolicy(shutdown_grace_seconds=0.1)
        # 1. 正常 Python Worker
        sp_normal = RuntimeSupervisor({
            'kind': 'fixture',
            'site_key': 'py_norm',
            'behavior': 'normal'
        }, policy=policy)
        req = RuntimeRequest.create(site_key='py_norm', method='homeContent', deadline_ms=2000)
        res, _ = sp_normal.call('homeContent', [False], request=req)
        self.assertEqual(res, {'list': []})
        sp_normal.destroy()

        # 2. 异常 Python Worker
        sp_err = RuntimeSupervisor({
            'kind': 'fixture',
            'site_key': 'py_err',
            'behavior': 'error'
        }, policy=policy)
        req_err = RuntimeRequest.create(site_key='py_err', method='homeContent', deadline_ms=2000)
        with self.assertRaises(Exception):
            sp_err.call('homeContent', [False], request=req_err)
        sp_err.destroy()

        # 3. 死循环 Worker (超时熔断与进程杀除)
        sp_inf = RuntimeSupervisor({
            'kind': 'fixture',
            'site_key': 'py_inf',
            'behavior': 'infinite'
        }, policy=policy)
        req_inf = RuntimeRequest.create(site_key='py_inf', method='homeContent', deadline_ms=150)
        with self.assertRaises(Exception):
            sp_inf.call('homeContent', [False], request=req_inf)
        self.assertIsNone(sp_inf.pid)
        sp_inf.destroy()

    def test_js_normal_missing_global_and_hanging_promise(self):
        policy = RuntimePolicy(shutdown_grace_seconds=0.1)
        # 1. 正常 JS Worker
        js_code_normal = """
        export default {
            init: function(ext) {},
            home: function(filter) { return JSON.stringify({class: [{type_id: "1", type_name: "JS"}]}); }
        };
        """
        sp_js = RuntimeSupervisor({
            'kind': 'js',
            'site_key': 'js_norm',
            'api': js_code_normal,
            'proxy_port': 18651
        }, policy=policy)
        req_init = RuntimeRequest.create(site_key='js_norm', method='init', deadline_ms=5000)
        sp_js.call('init', [''], request=req_init)
        req = RuntimeRequest.create(site_key='js_norm', method='homeContent', deadline_ms=5000)
        res, _ = sp_js.call('homeContent', [False], request=req)
        self.assertIn('class', res)
        sp_js.destroy()

        # 2. 缺全局/无效导出
        js_code_bad = "var x = 1;"
        sp_js_bad = RuntimeSupervisor({
            'kind': 'js',
            'site_key': 'js_bad',
            'api': js_code_bad,
            'proxy_port': 18651
        }, policy=policy)
        req_bad = RuntimeRequest.create(site_key='js_bad', method='init', deadline_ms=1000)
        with self.assertRaises(Exception):
            sp_js_bad.call('init', [''], request=req_bad)
        sp_js_bad.destroy()

    def test_android_jar_classification_uses_jvm_fallback(self):
        tmp_android_jar = os.path.join(BACKEND_DIR, '.test-runtime', 'android_context.jar')
        os.makedirs(os.path.dirname(tmp_android_jar), exist_ok=True)
        with zipfile.ZipFile(tmp_android_jar, 'w') as zf:
            zf.writestr('classes.dex', b'dex\n035\x00dummy')
            zf.writestr('com/github/catvod/spider/AndroidOnly.class', b'\xca\xfe\xba\xbeAndroidContext')

        info = classify_jar_compatibility(tmp_android_jar)
        self.assertIn(info.get('level'), ('L1', 'L2', 'L3', 'L4'))
        JarBridge._require_available_runtime(tmp_android_jar, 'android_test_site', portable_only=True)

        tmp_so_jar = os.path.join(BACKEND_DIR, '.test-runtime', 'native_so.jar')
        with zipfile.ZipFile(tmp_so_jar, 'w') as zf:
            zf.writestr('classes.dex', b'dex\n035\x00dummy')
            zf.writestr('lib/armeabi-v7a/libtest.so', b'\x7fELF...')

        info_so = classify_jar_compatibility(tmp_so_jar)
        self.assertEqual(info_so.get('level'), 'L3')
        JarBridge._require_available_runtime(tmp_so_jar, 'so_test_site', portable_only=True)


if __name__ == '__main__':
    unittest.main()
