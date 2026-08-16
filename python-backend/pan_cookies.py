# -*- coding: utf-8 -*-
"""网盘 Cookie 配置存储（夸克/UC/天翼/百度/P123/迅雷）。

供 JAR（TVBox）网盘源使用：用户在设置页粘贴网盘 Cookie 后，
JarSpider 在每次调用 JVM 桥时附带该配置，SpiderRunner 注入蜘蛛。

存储：<data_dir>/pan_cookies.json；带 mtime 缓存避免每次调用都读盘。
"""
import json
import os
import threading
import time

import hoststate

PAN_COOKIE_KEYS = ('quark', 'uc', 'tianyi', 'baidu', 'p123', 'xunlei')
_PROVIDER_NAMES = {
    'quark': '夸克网盘',
    'uc': 'UC 网盘',
    'tianyi': '天翼云盘',
    'baidu': '百度网盘',
    'p123': '123 云盘',
    'xunlei': '迅雷云盘',
}

_cache = {'mtime': 0.0, 'data': {}}
# 保存串行化：避免并发 os.replace 同一目标在 Windows 上互抛建议锁
_SAVE_LOCK = threading.Lock()


def _os_replace_retry(src, dst, attempts=4):
    """Windows 下目标被并发读/替换时 os.replace 可能短暂 Access Denied，重试。"""
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.05)


def _path():
    return os.path.join(hoststate.get_data_dir(), 'pan_cookies.json')


def load_pan_cookies():
    """读取全部网盘 Cookie 配置（{key: cookie}）。带 mtime 缓存。"""
    p = _path()
    try:
        mtime = os.path.getmtime(p)
    except OSError:
        mtime = 0.0
    if mtime == _cache['mtime'] and _cache['data'] is not None:
        return dict(_cache['data'])
    data = {}
    try:
        with open(p, encoding='utf-8') as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            data = {k: str(v).strip() for k, v in raw.items()
                    if k in PAN_COOKIE_KEYS and str(v).strip()}
    except (OSError, ValueError):
        data = {}
    _cache['mtime'] = mtime
    _cache['data'] = data
    return dict(data)


# 各网盘要求的关键 Cookie 字段（jar 蜘蛛硬性校验，缺失则该网盘无法播放）
_REQUIRED_FIELDS = {
    'quark': '__pus',
    'uc': '__pus',
    'baidu': 'BDUSS',
    'tianyi': '',   # 天翼云盘蜘蛛未校验特定字段
    'p123': '',
    'xunlei': '',
}


def validate_pan_cookie(key, value):
    """校验单个网盘 Cookie 是否可被蜘蛛使用，返回问题列表（空=无问题）。"""
    issues = []
    v = str(value or '').strip()
    if not v:
        return issues
    # Cookie 必须形如 k=v; k2=v2
    if '=' not in v:
        issues.append(f'{_PROVIDER_NAMES.get(key, key)} Cookie 不是标准格式：应为「字段=值; 字段2=值2; …」（例如 __puus=xxx; __pus=xxx）')
        return issues
    if v.lower().lstrip().startswith('cookie'):
        issues.append('请只粘贴 Cookie 内容本身，不要带「Cookie: 」前缀')
    req = _REQUIRED_FIELDS.get(key, '')
    if req and req not in v:
        issues.append(f'{_PROVIDER_NAMES.get(key, key)} Cookie 缺少关键字段「{req}」，蜘蛛将无法使用该 Cookie（可能不完整或已过期）')
    return issues


def save_pan_cookies(cookies):
    """保存网盘 Cookie 配置；返回实际保存的 dict。非法键/空值丢弃。
    同时返回校验问题列表（不阻止保存，仅提示）。"""
    cleaned = {k: str(v).strip() for k, v in (cookies or {}).items()
               if k in PAN_COOKIE_KEYS and str(v).strip()}
    warnings = []
    for k, v in cleaned.items():
        warnings.extend(validate_pan_cookie(k, v))
    p = _path()
    # 临时文件名带 pid + 线程 id：同进程并发保存时各自独立，避免互相抢句柄
    tmp = '%s.tmp%d-%d' % (p, os.getpid(), threading.get_ident())
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(cleaned, f, ensure_ascii=False, indent=2)
        with _SAVE_LOCK:
            # 原子替换（M-28）：避免写一半时被并发读取到残缺 JSON
            _os_replace_retry(tmp, p)
        _cache['mtime'] = os.path.getmtime(p)
        _cache['data'] = cleaned
    except OSError as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise RuntimeError(f'网盘 Cookie 保存失败: {e}')
    return cleaned, warnings
