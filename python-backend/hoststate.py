# -*- coding: utf-8 -*-
"""宿主运行时状态（替代 Chaquopy/Android 桥接）。

原 base/spider.py 通过 Java 类获取端口/缓存目录/代理地址，
PC 端统一由本模块提供；server.py 启动时调用 configure() 写入。
"""
import os
import shutil
import hmac

_HOME = os.path.join(os.path.expanduser('~'), '.yuki')


def _migrate_legacy_home():
    """项目改名 video-pc → yuki：旧 ~/.video-pc 整体搬到 ~/.yuki。

    Electron 主进程启动时已做同样迁移（覆盖桌面端路径）；此处兜底保护
    `npm run backend` 等脱离 Electron 的独立后端运行方式。目标已存在
    （非空）则不动，失败静默跳过（仅旧数据暂不可见，不阻断启动）。
    """
    legacy = os.path.join(os.path.expanduser('~'), '.video-pc')
    try:
        if not os.path.isdir(legacy):
            return
        if not os.path.exists(_HOME):
            os.makedirs(_HOME)
        elif os.listdir(_HOME):
            return  # 目标已存在且非空：不动，避免覆盖新数据
        for name in os.listdir(legacy):
            src = os.path.join(legacy, name)
            dst = os.path.join(_HOME, name)
            if os.path.isdir(src) and not os.path.islink(src):
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
        # 复制成功后再清掉旧目录；任一步失败保留旧目录原样
        shutil.rmtree(legacy, ignore_errors=True)
    except Exception:
        pass


_migrate_legacy_home()

_ENV_DATA_DIR = os.environ.get('YUKI_DATA_DIR', '').strip()
_ENV_CACHE_DIR = os.environ.get('YUKI_CACHE_DIR', '').strip()
_DATA_DIR = _ENV_DATA_DIR or _HOME
_CACHE_DIR = _ENV_CACHE_DIR or os.path.join(_DATA_DIR, 'cache')

_state = {
    'port': 0,
    'token': '',
    'data_dir': _DATA_DIR,
    'cache_dir': _CACHE_DIR,
    'plugins_dir': os.path.join(_CACHE_DIR, 'py'),  # 对应原 Android cacheDir/py
    'log_dir': os.path.join(_DATA_DIR, 'logs'),
    # R8.1 功能开关标准体系
    'runtime_android_worker': False,# Android Worker（受 A4.1 No-Go 政策硬锁定）
    'pan_fast_path': True,          # 网盘快路径（夸克等前置短路，关后全走 jar 兜底）
    'media_probe': True,            # 起播前媒体探测
    'auto_line_fallback': True,     # 播放失败多线路自动回退
    'legacy_parser': True,          # 简易解析器与 iframe 跟随
}


def configure(**kwargs):
    _state.update(kwargs)


def get_feature_flags():
    """获取所有功能开关当前状态字典。"""
    return {
        'runtime_android_worker': bool(_state.get('runtime_android_worker', False)),
        'pan_fast_path': bool(_state.get('pan_fast_path', True)),
        'media_probe': bool(_state.get('media_probe', True)),
        'auto_line_fallback': bool(_state.get('auto_line_fallback', True)),
        'legacy_parser': bool(_state.get('legacy_parser', True)),
    }


def get_media_probe():
    return bool(_state.get('media_probe', True))


def get_auto_line_fallback():
    return bool(_state.get('auto_line_fallback', True))


def get_legacy_parser():
    return bool(_state.get('legacy_parser', True))


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
