# -*- coding: utf-8 -*-
"""B-09 Python 冷启动瘦身的懒加载单测。

优化.md B-09：server.py 顶部 import 链拖慢「正在启动后端服务」。
importtime 实测（2026-09-30，开发环境）：asyncio ~80.8ms，为 import 链第二
大项（fastapi 202ms 服务启动必需不动）。本文件守两条懒加载链：

- server.asyncio 模块代理（_LazyAsyncio）：import server 不加载真 asyncio，
  首次属性访问（首个请求协程）才加载并置位 asyncio_loaded——先例
  kazumi/captcha.py _load_cnn 双检锁手法（test_kazumi_utils.py 同款
  mock.patch.object 断言手法）；
- runtime.errors.error_from_exception：asyncio 顶层 import 降为函数内懒加载
  （它是 server→config→runner 启动链上唯一另一个 asyncio 顶层来源，
  不改则 server 侧白做）。

不用 pytest（与 test_aggsearch_cache.py 等一致，自写断言 + __main__）。
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
for _path in (BASE, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)
TEST_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
os.makedirs(TEST_ROOT, exist_ok=True)
os.environ.setdefault('YUKI_DATA_DIR', os.path.join(TEST_ROOT, 'data'))
os.environ.setdefault('YUKI_CACHE_DIR', os.path.join(TEST_ROOT, 'cache'))

import server  # noqa: E402


class LazyAsyncioProxyTest(unittest.TestCase):
    """server.asyncio 代理：首触加载 + 透明转发 + 双检锁单例。"""

    def test_proxy_translates_to_real_module(self):
        # 代理不替换真模块对象：属性访问必须与真 asyncio 逐名等价
        real = sys.modules['asyncio']
        for name in ('sleep', 'create_task', 'wait', 'FIRST_COMPLETED',
                     'CancelledError', 'get_running_loop'):
            self.assertIs(getattr(server.asyncio, name), getattr(real, name),
                          'asyncio.%s 经代理后与真模块不一致' % name)

    def test_load_is_cached_and_flag_set(self):
        # _load() 单例：多次调用返回同一模块对象；旗标置位（供诊断/测试探针）
        mod = server.asyncio._load()
        self.assertIs(mod, server.asyncio._load())
        self.assertTrue(server.asyncio_loaded)
        self.assertIs(mod, sys.modules['asyncio'])

    def test_import_server_keeps_asyncio_lazy_until_touched(self):
        """核心契约：fresh 解释器里 import server 不加载 asyncio。

        用子进程验证（本测试进程自己已加载过 asyncio，进程内断言恒假），
        等价于「后端进程启动 → READY 前不付 asyncio import 成本」。"""
        import subprocess
        code = (
            "import sys; import server; "
            "assert 'asyncio' not in sys.modules, 'asyncio 应保持懒加载'; "
            "assert not server.asyncio_loaded; "
            "server.asyncio.sleep; "
            "assert 'asyncio' in sys.modules and server.asyncio_loaded"
        )
        proc = subprocess.run([sys.executable, '-c', code],
                              capture_output=True, text=True, cwd=BASE,
                              env={**os.environ, 'YUKI_TEST_ROOT': TEST_ROOT})
        self.assertEqual(proc.returncode, 0,
                         '子进程断言失败: %s' % proc.stderr[-2000:])

    def test_concurrent_first_touch_loads_once(self):
        """多线程并发首触：双检锁保证真 import 只发生一次（FastAPI 线程池
        handler 并发首触场景，对齐 captcha.py 先例的线程安全要求）。"""
        import threading
        results = []
        barrier = threading.Barrier(8)
        real = sys.modules['asyncio']

        def touch():
            barrier.wait()
            results.append(server.asyncio._load())

        threads = [threading.Thread(target=touch) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(results), 8)
        self.assertTrue(all(m is real for m in results),
                        '并发首触必须拿到同一模块对象')


class ErrorsLazyAsyncioTest(unittest.TestCase):
    """runtime.errors：error_from_exception 的 asyncio 函数内懒加载。"""

    def test_timeout_error_maps_via_lazy_asyncio(self):
        import runtime.errors as errors_mod
        err = errors_mod.error_from_exception(TimeoutError(), stage='config')
        self.assertEqual(err.code, 'L1_CONFIG_TIMEOUT')
        self.assertIsNotNone(errors_mod._asyncio_mod)

    def test_cancelled_error_branch(self):
        """asyncio.CancelledError 是 BaseException 子类（不能用内置异常名
        顶替，见 errors.py 分支注释）：懒加载后该分支判定语义不变。"""
        import asyncio
        import concurrent.futures
        import runtime.errors as errors_mod
        err = errors_mod.error_from_exception(
            asyncio.CancelledError(), stage='runtime')
        self.assertEqual(err.code, 'L3_RUNTIME_CANCELLED')
        err2 = errors_mod.error_from_exception(
            concurrent.futures.CancelledError(), stage='runtime')
        self.assertEqual(err2.code, 'L3_RUNTIME_CANCELLED')

    def test_fresh_interpreter_maps_timeout_without_preset_modules(self):
        import subprocess
        code = (
            "import sys; "
            "sys.path.insert(0, r'%s'); "
            "import runtime.errors as em; "
            "err = em.error_from_exception(TimeoutError(), stage='parse'); "
            "assert err.code == 'L4_PARSE_TIMEOUT', err.code; "
            "assert em._asyncio_mod is not None"
        ) % BASE
        proc = subprocess.run([sys.executable, '-c', code],
                              capture_output=True, text=True, cwd=BASE)
        self.assertEqual(proc.returncode, 0,
                         '子进程断言失败: %s' % proc.stderr[-2000:])


if __name__ == '__main__':
    unittest.main(verbosity=2)
