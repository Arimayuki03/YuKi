# -*- coding: utf-8 -*-
"""宿主运行时状态（替代 Chaquopy/Android 桥接）。

原 base/spider.py 通过 Java 类获取端口/缓存目录/代理地址，
PC 端统一由本模块提供；server.py 启动时调用 configure() 写入。
"""
import os
import hmac

_HOME = os.path.join(os.path.expanduser('~'), '.video-pc')
_ENV_DATA_DIR = os.environ.get('VPC_DATA_DIR', '').strip()
_ENV_CACHE_DIR = os.environ.get('VPC_CACHE_DIR', '').strip()
_DATA_DIR = _ENV_DATA_DIR or _HOME
_CACHE_DIR = _ENV_CACHE_DIR or os.path.join(_DATA_DIR, 'cache')

_state = {
    'port': 0,
    'token': '',
    'data_dir': _DATA_DIR,
    'cache_dir': _CACHE_DIR,
    'plugins_dir': os.path.join(_CACHE_DIR, 'py'),  # 对应原 Android cacheDir/py
    'log_dir': os.path.join(_DATA_DIR, 'logs'),
    'pan_fast_path': True,  # 任务三：网盘快路径开关（默认开：夸克文件前置短路；
                            # 关：全走 jar，兜底才用 go-proxy）
}


def configure(**kwargs):
    _state.update(kwargs)


def get_port():
    return _state['port']


def get_token():
    return _state['token']


def valid_proxy_token(value):
    """校验可选的数据面 token；空 token 保持旧 FongMi 地址兼容。"""
    supplied = str(value or '')
    expected = str(_state.get('token') or '')
    return not supplied or (bool(expected) and hmac.compare_digest(supplied, expected))


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


def get_pan_fast_path():
    """任务三：网盘快路径开关（True=前置短路；False=jar优先+兜底）。"""
    return _state.get('pan_fast_path', True)


def ensure_dirs():
    for key in ('data_dir', 'cache_dir', 'plugins_dir', 'log_dir'):
        os.makedirs(_state[key], exist_ok=True)
