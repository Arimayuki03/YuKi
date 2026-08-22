# -*- coding: utf-8 -*-
"""打包版入口契约：PyInstaller --onefile --windowed 下的 spawn / 标准流回归。

这类缺陷在开发模式里完全看不见，所以必须单独守：
  * 源码模式（venv + server.py）的 spawn 子进程以 __mp_main__ 重新导入模块，
    `if __name__ == '__main__'` 为假，main() 不会重跑；
  * 冻结产物里子进程是「再执行一次 exe」，不调 multiprocessing.freeze_support()
    就没人认领 --multiprocessing-fork，子进程把 main() 整个再跑一遍（再起 uvicorn、
    再抢 go-proxy 端口），Worker 永远不上报 booted → 每个站点 L3_RUNTIME_TIMEOUT；
  * --windowed 是 GUI 子系统 exe，叠加 spawn 不继承句柄后 sys.stdout/stderr 为 None，
    凡假设标准流存在的库都会炸（uvicorn 的 ColourizedFormatter 调 stdout.isatty()）。

用法：<venv>/python tests/test_frozen_entrypoint.py
"""
from __future__ import annotations

import ast
import logging
import os
import shutil
import sys
import tempfile
import threading
import unittest
from logging.handlers import RotatingFileHandler

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import server  # noqa: E402

SERVER_PY = os.path.join(BASE, 'server.py')


def _dotted(node):
    """把 Call.func 还原成 'multiprocessing.freeze_support' 这样的点号名。"""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return '.'.join(reversed(parts))
    return ''


def _is_main_guard(test):
    return (isinstance(test, ast.Compare)
            and isinstance(test.left, ast.Name) and test.left.id == '__name__'
            and len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq)
            and len(test.comparators) == 1
            and isinstance(test.comparators[0], ast.Constant)
            and test.comparators[0].value == '__main__')


def _parse_server():
    with open(SERVER_PY, 'r', encoding='utf-8') as fh:
        return ast.parse(fh.read(), filename=SERVER_PY)


def _called_names(body):
    """按语句顺序收集调用名（同一语句内部顺序不敏感，这里只比较语句先后）。"""
    names = []
    for stmt in body:
        for node in ast.walk(stmt):
            if isinstance(node, ast.Call):
                name = _dotted(node.func)
                if name:
                    names.append(name)
    return names


class FrozenEntrypointSourceTest(unittest.TestCase):
    """对 server.py 源码做静态断言——冻结产物的行为无法在单测里跑出来。"""

    def setUp(self):
        tree = _parse_server()
        self.guard_body = None
        for node in tree.body:
            if isinstance(node, ast.If) and _is_main_guard(node.test):
                self.guard_body = node.body
                break
        self.tree = tree

    def test_main_guard_exists(self):
        self.assertIsNotNone(self.guard_body, "server.py 缺少 if __name__ == '__main__' 入口块")

    def test_freeze_support_runs_before_main(self):
        """freeze_support 必须在 main() 之前，否则 spawn 子进程会重跑整个服务。"""
        names = _called_names(self.guard_body)
        self.assertIn('multiprocessing.freeze_support', names,
                      '冻结产物的 spawn 子进程需要 multiprocessing.freeze_support() 接管')
        self.assertIn('main', names)
        self.assertLess(names.index('multiprocessing.freeze_support'), names.index('main'),
                        'freeze_support() 必须早于 main()，否则子进程先把服务再起一遍')

    def test_std_streams_are_ensured_before_main(self):
        """--windowed 下标准流可能为 None，兜底必须发生在任何库用到它之前。"""
        names = _called_names(self.guard_body)
        self.assertIn('_ensure_std_streams', names)
        self.assertLess(names.index('_ensure_std_streams'), names.index('main'))

    def test_uvicorn_skips_its_own_log_config(self):
        """uvicorn 默认 dictConfig 的 ColourizedFormatter 会在无标准流时抛
        ValueError: Unable to configure formatter 'default'，必须传 log_config=None。"""
        main_fn = next((n for n in self.tree.body
                        if isinstance(n, ast.FunctionDef) and n.name == 'main'), None)
        self.assertIsNotNone(main_fn, 'server.py 缺少 main()')
        calls = [n for n in ast.walk(main_fn)
                 if isinstance(n, ast.Call) and _dotted(n.func) == 'uvicorn.run']
        self.assertTrue(calls, 'main() 里找不到 uvicorn.run 调用')
        for call in calls:
            kwargs = {kw.arg: kw.value for kw in call.keywords if kw.arg}
            self.assertIn('log_config', kwargs, 'uvicorn.run 必须显式传 log_config')
            self.assertIsInstance(kwargs['log_config'], ast.Constant)
            self.assertIsNone(kwargs['log_config'].value, 'log_config 必须为 None')


class EnsureStdStreamsTest(unittest.TestCase):
    _NAMES = ('stdin', 'stdout', 'stderr', '__stdin__', '__stdout__', '__stderr__')

    def setUp(self):
        self._saved = {name: getattr(sys, name, None) for name in self._NAMES}

    def tearDown(self):
        opened = [getattr(sys, name, None) for name in self._NAMES]
        for name, value in self._saved.items():
            setattr(sys, name, value)
        for stream in opened:
            if stream is not None and stream not in self._saved.values():
                try:
                    stream.close()
                except Exception:
                    pass

    def test_none_streams_become_usable_devnull(self):
        for name in self._NAMES:
            setattr(sys, name, None)
        server._ensure_std_streams()
        for name in self._NAMES:
            self.assertIsNotNone(getattr(sys, name), '%s 未兜底' % name)
        # 库里最常见的两种探测：写入与 isatty() 调用本身，都不能抛。
        # 注意 Windows 上 NUL 是字符设备，isatty() 合法地返回 True——只断言可调用。
        sys.stdout.write('probe')
        sys.stderr.write('probe')
        self.assertTrue(callable(sys.stdout.isatty))
        self.assertTrue(callable(sys.stderr.isatty))

    def test_existing_streams_are_left_untouched(self):
        sentinel_out, sentinel_err = sys.stdout, sys.stderr
        server._ensure_std_streams()
        self.assertIs(sys.stdout, sentinel_out)
        self.assertIs(sys.stderr, sentinel_err)


class SetupLoggingWithoutConsoleTest(unittest.TestCase):
    def test_setup_logging_survives_missing_stderr(self):
        """没有标准流时只装轮转文件 handler，不能因 StreamHandler(None) 而炸。"""
        root = logging.getLogger()
        saved_handlers = root.handlers[:]
        saved_level = root.level
        saved_excepthook = sys.excepthook
        saved_thread_hook = getattr(threading, 'excepthook', None)
        saved_stderr = sys.stderr
        saved_log_dir = os.environ.get('YUKI_LOG_DIR')
        tmp_dir = tempfile.mkdtemp(prefix='yuki_frozen_log_')
        os.environ['YUKI_LOG_DIR'] = tmp_dir
        try:
            sys.stderr = None
            server._setup_logging()
            handlers = root.handlers[:]
            self.assertTrue(any(isinstance(h, RotatingFileHandler) for h in handlers),
                            '轮转文件 handler 必须始终存在')
            # RotatingFileHandler 本身是 StreamHandler 子类，这里要精确匹配控制台 handler
            self.assertFalse(any(type(h) is logging.StreamHandler for h in handlers),
                             'sys.stderr 为 None 时不得注册控制台 handler')
            logging.getLogger('yuki.test').warning('frozen entrypoint probe')
        finally:
            for handler in root.handlers[:]:
                if handler not in saved_handlers:
                    root.removeHandler(handler)
                    try:
                        handler.close()
                    except Exception:
                        pass
            root.handlers[:] = saved_handlers
            root.setLevel(saved_level)
            sys.excepthook = saved_excepthook
            if saved_thread_hook is not None:
                threading.excepthook = saved_thread_hook
            sys.stderr = saved_stderr
            if saved_log_dir is None:
                os.environ.pop('YUKI_LOG_DIR', None)
            else:
                os.environ['YUKI_LOG_DIR'] = saved_log_dir
            shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
