# -*- coding: utf-8 -*-
"""
Node.js Worker Supervisor (node_supervisor.py)
负责管理 Node.js Worker 子进程的生命周期、JSON-RPC IPC 交互、超时强杀与内存超限监测。
"""

import json
import logging
import os
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Union

logger = logging.getLogger('vpc.node_supervisor')


class NodeWorkerError(Exception):
    """Node Worker 调用错误异常"""
    def __init__(self, message: str, code: int = -32000, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


class NodeWorkerTimeoutError(NodeWorkerError):
    """Worker 调用超时异常"""
    pass


class NodeWorkerMemoryLimitError(NodeWorkerError):
    """Worker 内存超限异常"""
    pass


class NodeSupervisor:
    """
    Node Supervisor:
    - 启动并管理单独的 worker_runner.mjs 进程
    - 通过标准输入输出进行 JSON-RPC 2.0 通信
    - 支持超时中断与 SIGKILL 强杀
    - 定期或按需采集 worker 内存，超出阈值时自动拦截/熔断
    """

    def __init__(
        self,
        node_path: str = "node",
        worker_script_path: Optional[str] = None,
        timeout: float = 10.0,
        max_memory_mb: float = 256.0,
        workdir: Optional[str] = None
    ):
        self.node_path = node_path
        if worker_script_path is None:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            self.worker_script_path = os.path.join(base_dir, 'worker_runner.mjs')
        else:
            self.worker_script_path = worker_script_path

        self.timeout = timeout
        self.max_memory_mb = max_memory_mb
        self.workdir = workdir or os.path.dirname(self.worker_script_path)

        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._req_id = 0
        self._pending_requests: Dict[int, Dict[str, Any]] = {}
        self._reader_thread: Optional[threading.Thread] = None
        self._running = False

    def start(self):
        """启动 Node.js Worker 子进程与后台读取线程"""
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return

            if not os.path.exists(self.worker_script_path):
                raise FileNotFoundError(f"Worker script not found: {self.worker_script_path}")

            cmd = [self.node_path, self.worker_script_path]
            # 开启子进程，stdin/stdout/stderr 管道化
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self.workdir,
                text=True,
                encoding='utf-8',
                bufsize=1
            )
            self._running = True
            self._pending_requests.clear()

            self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
            self._reader_thread.start()

            # 启动 stderr 转发线程
            self._stderr_thread = threading.Thread(target=self._stderr_loop, daemon=True)
            self._stderr_thread.start()

    def _stderr_loop(self):
        proc = self._proc
        if not proc or not proc.stderr:
            return
        try:
            for line in proc.stderr:
                logger.debug("[NodeWorker stderr] %s", line.rstrip())
        except Exception:
            pass

    def _read_loop(self):
        """读取 Node 进程 stdout 中的 JSON-RPC 响应并唤醒对应的等待线程"""
        proc = self._proc
        if not proc or not proc.stdout:
            return

        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    req_id = msg.get('id')
                    with self._lock:
                        if req_id in self._pending_requests:
                            holder = self._pending_requests[req_id]
                            holder['response'] = msg
                            holder['event'].set()
                except json.JSONDecodeError:
                    logger.warning("[NodeSupervisor] Received invalid JSON: %s", line)
        except Exception as e:
            logger.debug("[NodeSupervisor] read_loop terminated: %s", e)
        finally:
            self._running = False
            # 唤醒所有残留的请求
            with self._lock:
                for holder in self._pending_requests.values():
                    holder['event'].set()

    def is_alive(self) -> bool:
        """检查 Node Worker 进程是否存活"""
        return self._proc is not None and self._proc.poll() is None

    def call_rpc(
        self,
        method: str,
        params: Union[list, dict, None] = None,
        timeout: Optional[float] = None
    ) -> Any:
        """
        发送 JSON-RPC 2.0 请求并等待响应，提供超时与内存检测
        """
        if not self.is_alive():
            self.start()

        timeout_sec = timeout if timeout is not None else self.timeout

        with self._lock:
            self._req_id += 1
            req_id = self._req_id
            event = threading.Event()
            holder = {
                'event': event,
                'response': None,
                'start_time': time.time()
            }
            self._pending_requests[req_id] = holder

            payload = {
                'jsonrpc': '2.0',
                'id': req_id,
                'method': method,
                'params': params if params is not None else []
            }
            try:
                line = json.dumps(payload, ensure_ascii=False) + '\n'
                assert self._proc and self._proc.stdin
                self._proc.stdin.write(line)
                self._proc.stdin.flush()
            except Exception as e:
                self._pending_requests.pop(req_id, None)
                self.kill()
                raise NodeWorkerError(f"Failed to write to worker process: {e}")

        # 等待响应或超时
        finished = event.wait(timeout=timeout_sec)
        with self._lock:
            self._pending_requests.pop(req_id, None)

        if not finished:
            logger.error(f"[NodeSupervisor] Call {method} timed out after {timeout_sec}s, killing worker.")
            self.kill()
            raise NodeWorkerTimeoutError(f"RPC call '{method}' timed out after {timeout_sec}s.")

        resp = holder.get('response')
        if not resp:
            if not self.is_alive():
                raise NodeWorkerError("Worker process terminated unexpectedly.")
            raise NodeWorkerError("No response received from worker.")

        if 'error' in resp and resp['error']:
            err = resp['error']
            raise NodeWorkerError(
                err.get('message', 'Unknown error'),
                code=err.get('code', -32000),
                data=err.get('data')
            )

        # 检查内存限制（若需要）
        if self.max_memory_mb > 0 and method not in ('getMemoryUsage', 'destroy', 'loadRule', 'ping'):
            self._check_memory_limit()

        return resp.get('result')

    def check_memory_usage(self) -> Dict[str, int]:
        """获取当前 Worker 的内存占用 (bytes)"""
        try:
            res = self.call_rpc('getMemoryUsage', [], timeout=2.0)
            return res if isinstance(res, dict) else {}
        except Exception:
            return {}

    def _check_memory_limit(self):
        """如果 rss 内存超过 max_memory_mb，强杀并抛出内存超限异常"""
        usage = self.check_memory_usage()
        rss_bytes = usage.get('rss', 0)
        rss_mb = rss_bytes / (1024 * 1024)
        if rss_mb > self.max_memory_mb:
            logger.error(f"[NodeSupervisor] Memory limit exceeded: {rss_mb:.2f}MB > {self.max_memory_mb}MB. Killing worker.")
            self.kill()
            raise NodeWorkerMemoryLimitError(
                f"Worker exceeded memory limit ({rss_mb:.2f}MB > {self.max_memory_mb}MB)."
            )

    def load_rule(self, rule_source: str, timeout: Optional[float] = None) -> bool:
        """在 Node 沙箱中载入 drpy 规则源码"""
        res = self.call_rpc('loadRule', [rule_source], timeout=timeout)
        return bool(res and res.get('success'))

    def kill(self):
        """强制杀死 Node Worker 进程"""
        with self._lock:
            if self._proc is not None:
                try:
                    self._proc.kill()
                except Exception:
                    pass
                self._proc = None
            self._running = False
            for holder in self._pending_requests.values():
                holder['event'].set()
            self._pending_requests.clear()

    def destroy(self):
        """安全停止并销毁 Supervisor"""
        try:
            if self.is_alive():
                self.call_rpc('destroy', [], timeout=2.0)
        except Exception:
            pass
        finally:
            self.kill()
