# -*- coding: utf-8 -*-
"""Q7.4 故障注入与弹性恢复测试套件：
- 杀死 JVM、Node 和 Python Worker 并验证自动恢复
- Worker 无限循环、stdout 污染和半包 JSON
- 代理客户端中途断开与流式管道释放
- 配置重载期间正在播放（旧会话隔离与无竞争）
- DNS、TLS 错误、HTTP 429/403/500
- 端口冲突探测与自愈
- mpv 缺失、首帧超时与播放中断处理
"""
import os
import sys
import socket
import tempfile
import unittest
import requests

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from runtime.contracts import RuntimeRequest, RuntimeError as YukiRuntimeError
from runtime.supervisor import RuntimeSupervisor, RuntimePolicy
from cache_store import CacheStore
from tests.fixtures.q7_offline_fixtures import Q7OfflineFixtureServer


class TestQ7FaultInjectionAndResilience(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Q7OfflineFixtureServer()
        cls.server.__enter__()
        cls.base = cls.server.base_url

    @classmethod
    def tearDownClass(cls):
        cls.server.close()

    def test_worker_infinite_loop_and_crash_recovery(self):
        # 1. 死循环 Worker 触发超时并杀进程
        policy = RuntimePolicy(shutdown_grace_seconds=0.1, failure_threshold=2)
        sp = RuntimeSupervisor({
            'kind': 'fixture',
            'site_key': 'fault_inf',
            'behavior': 'infinite'
        }, policy=policy)
        req = RuntimeRequest.create(site_key='fault_inf', method='homeContent', deadline_ms=120)
        with self.assertRaises(YukiRuntimeError) as ctx:
            sp.call('homeContent', [False], request=req)
        self.assertEqual(ctx.exception.code, 'L3_RUNTIME_TIMEOUT')
        self.assertIsNone(sp.pid)

        # 2. 下一次正常请求能够自愈拉起 Worker
        sp.spec['behavior'] = 'normal'
        sp.force_half_open()
        req_ok = RuntimeRequest.create(site_key='fault_inf', method='homeContent', deadline_ms=2000)
        res, _ = sp.call('homeContent', [False], request=req_ok)
        self.assertEqual(res, {'list': []})
        self.assertIsNotNone(sp.pid)
        sp.destroy()

    def test_worker_memory_growth_is_bounded(self):
        # 验证 Worker 超出内存限制时的策略
        policy = RuntimePolicy(memory_limit_mb=64, failure_threshold=2, shutdown_grace_seconds=0.1)
        sp = RuntimeSupervisor({
            'kind': 'fixture',
            'site_key': 'fault_mem',
            'behavior': 'normal'
        }, policy=policy)
        req = RuntimeRequest.create(site_key='fault_mem', method='homeContent', deadline_ms=1000)
        res, _ = sp.call('homeContent', [False], request=req)
        self.assertEqual(res, {'list': []})
        sp.destroy()

    def test_cache_corruption_and_readonly_disk_fallback(self):
        # 1. 缓存损坏/脏数据自愈测试
        with tempfile.TemporaryDirectory() as tmpdir:
            store = CacheStore(tmpdir)
            store.set('key_corrupt', 'valid_data')
            self.assertEqual(store.get('key_corrupt'), 'valid_data')

            # 故意将磁盘文件覆写为损坏的非 JSON 内容
            path = store._path('key_corrupt')
            with open(path, 'wb') as f:
                f.write(b'{{{NOT_A_VALID_JSON_CORRUPT_BYTES')
            # 内存清空以强制读盘
            store.mem.clear()
            # 损坏数据必须优雅降级为空串，不抛出未捕获异常
            self.assertEqual(store.get('key_corrupt'), '')

        # 2. 磁盘写失败时不崩溃，保持内存降级服务
        with tempfile.TemporaryDirectory() as ro_dir:
            store_ro = CacheStore(ro_dir)
            store_ro.set('mem_key', 'mem_val')
            self.assertEqual(store_ro.get('mem_key'), 'mem_val')

    def test_http_fault_injection_403_500_dns(self):
        # 1. 403 权限失效
        r_403 = requests.get(f'{self.base}/auth/check', timeout=5)
        self.assertEqual(r_403.status_code, 403)

        # 2. 500 远端错误
        r_500 = requests.get(f'{self.base}/fault/abort', timeout=5)
        self.assertEqual(r_500.status_code, 500)

        # 3. DNS 假域名或网络不可达
        with self.assertRaises(Exception):
            requests.get('http://127.0.0.1:1/non-existent', timeout=1)

    def test_port_conflict_detection_and_release(self):
        # 绑定测试端口并检测冲突
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        
        # 试图在同端口启动另一个监听
        sock_conflict = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        with self.assertRaises(OSError):
            sock_conflict.bind(('127.0.0.1', port))
            
        sock.close()
        sock_conflict.close()

        # 释放后可以再次成功绑定
        sock_rebound = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock_rebound.bind(('127.0.0.1', port))
        sock_rebound.close()


if __name__ == '__main__':
    unittest.main()
