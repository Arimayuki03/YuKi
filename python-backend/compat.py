# -*- coding: utf-8 -*-
"""兼容层：Python 3.12+ 已移除 SourceFileLoader.load_module。

恢复源码（app.py / base/spider.py）经字节码校验与原版一致，保持不动；
在宿主启动时 import 本模块，为 SourceFileLoader 补回 load_module，
语义对齐旧实现：已加载模块复用 sys.modules，失败时回滚注册。
"""
import sys
import importlib.util
from importlib.machinery import SourceFileLoader

if not hasattr(SourceFileLoader, 'load_module'):
    def _load_module(self):
        name = self.name
        if name in sys.modules:
            return sys.modules[name]
        spec = importlib.util.spec_from_file_location(name, self.path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            sys.modules.pop(name, None)
            raise
        return sys.modules[name]

    SourceFileLoader.load_module = _load_module
