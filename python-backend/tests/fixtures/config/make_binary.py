# -*- coding: utf-8 -*-
"""从文本夹具派生二进制配置形态（gzip / JPEG 伪装 / PNG 伪装）。

TVBox 生态里这三种形态很常见（饭太硬系 JPEG 尾附 base64、哈基米 PNG、CDN gzip），
但它们不适合当成手写文本入库。这里由 `single.json` 确定性地派生：内容一定与文本
夹具一致，因此「二进制形态解出来的配置」和「文本形态」可以直接对比，任何解码错误
都会表现为两者不等，而不是夹具自己写错。

实现放在 `tests/offline_config_server.ensure_binary_fixtures()`，夹具服务启动时会
自动调用一次，所以跑测试**不需要**先手动执行本脚本；保留 CLI 入口只是为了能单独
重新生成、检查产物。

用法（离线，无网络）：
    python python-backend/tests/fixtures/config/make_binary.py
"""
import os
import sys

TESTS_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         '..', '..'))
if TESTS_DIR not in sys.path:
    sys.path.insert(0, TESTS_DIR)

from offline_config_server import ensure_binary_fixtures  # noqa: E402


def main():
    names = ensure_binary_fixtures()
    print('derived from single.json: %s' % ', '.join(names))


if __name__ == '__main__':
    main()
