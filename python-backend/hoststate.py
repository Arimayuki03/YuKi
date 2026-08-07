# -*- coding: utf-8 -*-
"""宿主运行时状态（替代 Chaquopy/Android 桥接）。

原 base/spider.py 通过 Java 类获取端口/缓存目录/代理地址，
PC 端统一由本模块提供；server.py 启动时调用 configure() 写入。
"""
import os

_HOME = os.path.join(os.path.expanduser('~'), '.video-pc')

_state = {
    'port': 0,
    'token': '',
    'data_dir': _HOME,
    'cache_dir': os.path.join(_HOME, 'cache'),
    'plugins_dir': os.path.join(_HOME, 'cache', 'py'),  # 对应原 Android cacheDir/py
    'log_dir': os.path.join(_HOME, 'logs'),
}


def configure(**kwargs):
    _state.update(kwargs)


def get_port():
    return _state['port']


def get_token():
    return _state['token']


def get_data_dir():
    return _state['data_dir']


def get_cache_dir():
    return _state['cache_dir']


def get_plugins_dir():
    return _state['plugins_dir']


def get_log_dir():
    return _state['log_dir']


def get_proxy_url(local=True):
    """对应原 Proxy.getUrl(local)；local 语义在 PC 端无差异。"""
    return f"http://127.0.0.1:{_state['port']}/proxy"


def ensure_dirs():
    for key in ('data_dir', 'cache_dir', 'plugins_dir', 'log_dir'):
        os.makedirs(_state[key], exist_ok=True)
