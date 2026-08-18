# -*- coding: utf-8 -*-
"""Node.js 运行时探测模块 (node_probe.py)

负责按优先级发现可用的 Node.js 运行时：
1. 主进程注入的环境变量 VPC_NODE_BIN (Electron 主程序 YuKi.exe / electron.exe)
2. 操作系统 PATH 中的 node / node.exe
3. 标准打包资源路径 vendor/node/node.exe

并提供子进程环境变量注入（如 ELECTRON_RUN_AS_NODE=1），实现零增量体积复用 Electron Node 运行时。
"""

import os
import shutil
import subprocess
from typing import Optional, Tuple, Dict


def find_node() -> Tuple[Optional[str], bool]:
    """按优先级寻找 Node 可执行文件。
    
    Returns:
        (node_path, is_electron): node 可执行文件路径与是否为 Electron 二进制
    """
    # 1. 主进程注入的 VPC_NODE_BIN
    custom = os.environ.get('VPC_NODE_BIN', '').strip().strip('"')
    if custom and os.path.isfile(custom):
        is_electron = bool(os.environ.get('VPC_ELECTRON_MODE') == '1' or 'electron' in custom.lower())
        return custom, is_electron

    # 2. 系统 PATH 中的 node
    system_node = shutil.which('node') or shutil.which('node.exe')
    if system_node and os.path.isfile(system_node):
        return system_node, False

    # 3. 常见打包资源目录探测
    base_dir = os.path.dirname(os.path.abspath(__file__))
    vendor_candidates = [
        os.path.join(base_dir, 'vendor', 'node', 'node.exe'),
        os.path.join(base_dir, '..', 'vendor', 'node', 'node.exe'),
    ]
    for c in vendor_candidates:
        if os.path.isfile(c):
            return c, False

    return None, False


def get_node_env() -> Tuple[Optional[str], Dict[str, str]]:
    """获取启动 Node Worker 所需的可执行文件路径与环境变量。
    
    当使用 Electron 作为 Node 运行时时，自动注入 ELECTRON_RUN_AS_NODE=1。
    """
    node_bin, is_electron = find_node()
    env = os.environ.copy()
    if is_electron:
        env['ELECTRON_RUN_AS_NODE'] = '1'
    return node_bin, env


def is_node_available() -> bool:
    """检查当前环境是否可运行 Node.js。"""
    node_bin, _ = find_node()
    return bool(node_bin)
