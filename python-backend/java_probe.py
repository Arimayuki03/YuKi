# -*- coding: utf-8 -*-
"""JVM 运行时探测：定位可用的 java 可执行文件，供 jar spider 桥接使用。

策略（按优先级）：
1. 设置页用户指定的 java 路径（index.js 经环境变量 YUKI_JAVA_HOME / YUKI_JAVA_BIN 注入）
2. 随包内置 JRE（vendor/jre/bin/java.exe，打包模式由 electron-builder 放入 resources）
3. JAVA_HOME/bin/java
4. PATH 中的 java

探测结果带版本号缓存（进程内），命中即返回；每次探测失败会清缓存，下次再试。
resources 根经 hoststate.resources_root 解析：主进程注入 YUKI_RESOURCES_ROOT
（打包=resources/，开发=仓库根）；冻结产物缺注入时按 exe 位置上溯兜底。
"""
import os
import re
import shutil
import subprocess
import logging

import hoststate

logger = logging.getLogger('yuki.java')

_probe_cache = {'bin': None, 'version': ''}

# 可能的 java 可执行文件名（Windows/Linux/macOS）
_JAVA_EXES = ('java.exe', 'java')


def _resources_root():
    """resources 根（含 vendor/）：统一走 hoststate 解析（见模块 docstring）。"""
    return hoststate.resources_root()


def _candidates():
    """按优先级返回候选 java 路径列表。"""
    out = []

    # 1. 用户指定（设置页选择，主进程注入）
    for key in ('YUKI_JAVA_BIN', 'YUKI_JAVA_HOME'):
        v = os.environ.get(key, '').strip().strip('"')
        if not v:
            continue
        if key == 'YUKI_JAVA_HOME':
            for exe in _JAVA_EXES:
                p = os.path.join(v, 'bin', exe)
                if os.path.isfile(p):
                    out.append(p)
                    break
        elif os.path.isfile(v):
            out.append(v)

    # 2. 随包内置 JRE（vendor/jre）
    for sub in ('vendor', 'resources'):
        base = os.path.join(_resources_root(), sub, 'jre')
        for exe in _JAVA_EXES:
            p = os.path.join(base, 'bin', exe)
            if os.path.isfile(p):
                out.append(p)
                break

    # 3. JAVA_HOME
    jh = os.environ.get('JAVA_HOME', '').strip().strip('"')
    if jh:
        for exe in _JAVA_EXES:
            p = os.path.join(jh, 'bin', exe)
            if os.path.isfile(p):
                out.append(p)
                break

    # 4. PATH
    for exe in _JAVA_EXES:
        p = shutil.which(exe)
        if p:
            out.append(p)
            break
    return out


def _version(binpath):
    """运行 java -version，返回版本字符串（如 '17.0.10'）；不可执行返回 ''。"""
    try:
        r = subprocess.run([binpath, '-version'], capture_output=True, text=True,
                           timeout=10, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        text = (r.stderr or r.stdout or '')
        m = re.search(r'version\s+"([^"]+)"', text)
        return m.group(1) if m else ''
    except Exception as e:
        logger.debug('java -version failed for %s: %s', binpath, e)
        return ''


def find_java():
    """返回可用 java 绝对路径；找不到返回 None。结果进程内缓存。"""
    if _probe_cache['bin']:
        return _probe_cache['bin']
    for cand in _candidates():
        if not cand:
            continue
        v = _version(cand)
        if v:
            _probe_cache['bin'] = cand
            _probe_cache['version'] = v
            logger.info('java runtime: %s (%s)', cand, v)
            return cand
    _probe_cache['bin'] = None
    _probe_cache['version'] = ''
    return None


def java_version():
    """已探测到的版本字符串；未探测返回 ''（不触发探测）。"""
    return _probe_cache['version']


def clear_cache():
    """清除探测缓存（设置页更换 java 路径后调用）。"""
    _probe_cache['bin'] = None
    _probe_cache['version'] = ''
