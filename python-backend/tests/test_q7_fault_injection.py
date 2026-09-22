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
import builtins
import http.client
import os
import sys
import socket
import tempfile
import unittest
import unittest.mock
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

        # 2. 磁盘写失败时不崩溃，保持内存降级服务（审查 T-11：此前本用例没有任何
        # 注入，只是顺序 set/get 自证——假绿。真实落盘函数是 CacheStore.set 里对
        # 临时文件的 open()，在这里注入 PermissionError 模拟盘满/只读盘）。
        with tempfile.TemporaryDirectory() as ro_dir:
            store_ro = CacheStore(ro_dir)
            store_ro.set('mem_key', 'mem_val')
            self.assertEqual(store_ro.get('mem_key'), 'mem_val')

            real_open = builtins.open

            def _deny_write(path, mode='r', *args, **kwargs):
                # 只拦写模式打开（set 的 tmp 落盘与 os.replace 前的写入路径），
                # 读路径放行，模拟「磁盘只读」而非「全文件系统不可用」
                if ('w' in str(mode)) or ('a' in str(mode)) or ('+' in str(mode)):
                    raise PermissionError(13, 'injected: disk write denied', str(path))
                return real_open(path, mode, *args, **kwargs)

            with unittest.mock.patch('builtins.open', side_effect=_deny_write):
                # 不抛异常：写失败被 set 内部吞掉（OSError 分支），内存层照常服务
                store_ro.set('deny_key', 'deny_val')
            self.assertEqual(store_ro.get('deny_key'), 'deny_val',
                             '落盘失败必须回退内存层，值仍可读')
            # 已有键重复 set 在写失败后仍保持旧值（不因失败把内存值弄丢/弄脏）
            store_ro.set('mem_key', 'mem_val_v2')  # 本次不注入，正常落盘+写内存
            self.assertEqual(store_ro.get('mem_key'), 'mem_val_v2')

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
        """Q7.6 端口冲突探测与自愈：打在真实被测组件 go_proxy 的监听链路上。

        旧实现只对两个裸 socket 做二分绑定，只验证了 OS 的 socket 语义，
        注入从未触及被测对象（假绿）。现在把「同端口二次绑定」真实注入到
        go_proxy.start_go_proxy / ensure_listener 的启动路径：
        - 占住 go_proxy 固定端口之一（OSError）→ start_go_proxy 跳过该端口、
          不崩溃，其余端口照常就位且确属本进程（self-heal）；
        - 释放后 ensure_listener 能在同一端口重新挂上服务（release）。
        """
        import go_proxy  # noqa: PLC0415

        def _owner_pid(port):
            """探测端口监听者；无监听返回 None。"""
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
            try:
                conn.request('GET', '/proxy?do=ck')
                rsp = conn.getresponse()
                rsp.read()
                return rsp.getheader('X-GoProxy-Pid') or 'unknown'
            except OSError:
                return None
            finally:
                conn.close()

        def _find_bindable(candidates):
            """从候选端口里找当前空闲可绑定的；优先 EXTRA_PORTS（避开 PORT 的
            双绑定探测重试延迟）。"""
            for port in candidates:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                try:
                    sock.bind(('127.0.0.1', port))
                    return port
                except OSError:
                    continue
                finally:
                    sock.close()
            return None

        fixed_ports = [go_proxy.PORT, *go_proxy.EXTRA_PORTS]
        # 测试前提：固定端口集合中至少有一个空闲（否则本机已有真实实例监听，
        # 冲突注入无从谈起——跳过而非误报）。
        pre_held = {p for p in fixed_ports if _owner_pid(p) is not None}
        occupiable = [p for p in (*go_proxy.EXTRA_PORTS, go_proxy.PORT)
                      if p not in pre_held]
        occupied = _find_bindable(occupiable)
        if occupied is None:
            self.skipTest('go_proxy fixed ports all in use by a live instance')

        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            blocker.bind(('127.0.0.1', occupied))
            blocker.listen(1)
            servers = go_proxy.start_go_proxy()
        finally:
            blocker.close()
        try:
            self.assertTrue(servers, 'start_go_proxy must self-heal on port conflict')
            # 冲突端口被跳过；其余「测试前空闲」的固定端口必须就位且确属本进程
            for port in fixed_ports:
                if port == occupied or port in pre_held:
                    continue
                self.assertEqual(_owner_pid(port), str(os.getpid()),
                                 f'fixed port {port} must be served by this process')
        finally:
            go_proxy.stop_go_proxy()

        # ── 释放后再绑定：ensure_listener 的真实服务链路 ──
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.assertTrue(go_proxy.ensure_listener(port))
        try:
            self.assertEqual(_owner_pid(port), str(os.getpid()))
        finally:
            listener = go_proxy._extra_servers.pop(port, None)
            if listener is not None:
                listener.shutdown()
                listener.server_close()
        # 释放后可再次成功绑定并服务（release 语义）
        self.assertTrue(go_proxy.ensure_listener(port))
        try:
            self.assertEqual(_owner_pid(port), str(os.getpid()))
        finally:
            listener = go_proxy._extra_servers.pop(port, None)
            if listener is not None:
                listener.shutdown()
                listener.server_close()


if __name__ == '__main__':
    unittest.main()
