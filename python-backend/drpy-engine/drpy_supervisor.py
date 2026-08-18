# -*- coding: utf-8 -*-
"""正式 drpy Node Supervisor 模块 (drpy_supervisor.py)

管理 Node.js Worker 子进程的生命周期：
1. 使用 RLock 确保并发与异常强杀分支安全，杜绝自死锁；
2. 超时强杀后记录当前规则并在进程重建时自动重放规则（Rule Reloading）；
3. 注入 Node --max-old-space-size 启动参数作为内存硬兜底，配合 Supervisor 内存监控；
4. 集成 node_probe 自动探测 Electron 内置 Node / 系统 Node；
5. Windows 下整树强杀与资源清理。
"""

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Union

from node_probe import get_node_env

logger = logging.getLogger('vpc.drpy_supervisor')


class DrpyWorkerError(Exception):
    """drpy Worker 错误基类"""
    def __init__(self, message: str, code: int = -32000, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


class DrpyWorkerTimeoutError(DrpyWorkerError):
    """调用超时异常"""
    pass


class DrpyWorkerMemoryLimitError(DrpyWorkerError):
    """内存超限异常"""
    pass


class DrpySupervisor:
    """
    drpy Supervisor:
    - 启动并管理单独的 drpy_worker_runner.mjs 进程
    - 通过标准输入输出进行 JSON-RPC 2.0 通信
    - 支持超时中断与 SIGKILL / TerminateProcess 强杀
    - 自动重放 rule 规则源码（自愈能力）
    """

    def __init__(
        self,
        node_path: Optional[str] = None,
        worker_script_path: Optional[str] = None,
        timeout: float = 15.0,
        max_memory_mb: float = 256.0,
        workdir: Optional[str] = None,
        site_key: str = ""
    ):
        self.node_path = node_path
        if worker_script_path is None:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            self.worker_script_path = os.path.join(base_dir, 'drpy_worker_runner.mjs')
        else:
            self.worker_script_path = worker_script_path

        self.timeout = timeout
        self.max_memory_mb = max_memory_mb
        self.workdir = workdir or os.path.dirname(self.worker_script_path)
        self.site_key = site_key

        self._proc: Optional[subprocess.Popen] = None
        # 使用 RLock 避免递归加锁时的死锁（解决 P0-1 缺陷）
        self._lock = threading.RLock()
        self._req_id = 0
        self._pending_requests: Dict[int, Dict[str, Any]] = {}
        self._reader_thread: Optional[threading.Thread] = None
        self._stderr_thread: Optional[threading.Thread] = None
        self._running = False
        
        # 记录当前加载的规则源码，强杀重建后自动重载（解决 P0-3 缺陷）
        self.current_rule_source: Optional[str] = None
        self.temp_dir: Optional[str] = None

    def start(self):
        """启动 Node.js Worker 子进程与后台通信线程"""
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return

            if not os.path.exists(self.worker_script_path):
                raise FileNotFoundError(f"Worker script not found: {self.worker_script_path}")

            node_bin, node_env = get_node_env()
            target_node = self.node_path or node_bin
            if not target_node:
                raise RuntimeError("未找到可用的 Node.js / Electron 运行时环境")

            # 为当前 Worker 创建专属受控临时目录
            if not self.temp_dir or not os.path.exists(self.temp_dir):
                self.temp_dir = tempfile.mkdtemp(prefix=f"vpc_drpy_{self.site_key or 'worker'}_")
            node_env['VPC_WORKER_TEMP_DIR'] = self.temp_dir

            # 内存硬限制兜底参数 --max-old-space-size
            max_old_space = max(64, int(self.max_memory_mb))
            cmd = [
                target_node,
                f"--max-old-space-size={max_old_space}",
                self.worker_script_path
            ]

            creation_flags = 0
            if sys.platform == 'win32':
                creation_flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self.workdir,
                env=node_env,
                text=True,
                encoding='utf-8',
                bufsize=1,
                creationflags=creation_flags
            )
            self._running = True
            self._pending_requests.clear()

            self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
            self._reader_thread.start()

            self._stderr_thread = threading.Thread(target=self._stderr_loop, daemon=True)
            self._stderr_thread.start()

    def _stderr_loop(self):
        proc = self._proc
        if not proc or not proc.stderr:
            return
        try:
            for line in proc.stderr:
                logger.debug("[DrpyWorker stderr] %s", line.rstrip())
        except Exception:
            pass

    def _read_loop(self):
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
                    logger.warning("[DrpySupervisor] Received invalid JSON: %s", line)
        except Exception as e:
            logger.debug("[DrpySupervisor] read_loop terminated: %s", e)
        finally:
            self._running = False
            with self._lock:
                for holder in self._pending_requests.values():
                    holder['event'].set()

    def is_alive(self) -> bool:
        """检查 Worker 进程是否健康存活"""
        return self._proc is not None and self._proc.poll() is None

    def call_rpc(
        self,
        method: str,
        params: Union[list, dict, None] = None,
        timeout: Optional[float] = None
    ) -> Any:
        """发送 JSON-RPC 2.0 请求并等待响应，具备超时强杀与异常自愈"""
        need_reload = False
        if not self.is_alive():
            self.start()
            if self.current_rule_source and method != 'loadRule':
                need_reload = True

        timeout_sec = timeout if timeout is not None else self.timeout

        if need_reload:
            try:
                res = self.call_rpc('loadRule', [self.current_rule_source], timeout=timeout_sec)
                if not res or not res.get('success'):
                    logger.warning("[DrpySupervisor] Rule auto-reload did not report success")
            except Exception as e:
                logger.error(f"[DrpySupervisor] Rule auto-reload failed: {e}")

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
                raise DrpyWorkerError(f"Failed to write to drpy worker process: {e}")

        # 等待响应或超时
        finished = event.wait(timeout=timeout_sec)
        with self._lock:
            self._pending_requests.pop(req_id, None)

        if not finished:
            logger.error(f"[DrpySupervisor] Call '{method}' timed out after {timeout_sec}s, killing worker.")
            self.kill()
            raise DrpyWorkerTimeoutError(f"RPC call '{method}' timed out after {timeout_sec}s.")

        resp = holder.get('response')
        if not resp:
            if not self.is_alive():
                raise DrpyWorkerMemoryLimitError("Worker process crashed or terminated by OOM killer.")
            self.kill()
            raise DrpyWorkerMemoryLimitError("No response received from worker (possible OOM or crash).")

        if 'error' in resp and resp['error']:
            err = resp['error']
            raise DrpyWorkerError(
                err.get('message', 'Unknown error'),
                code=err.get('code', -32000),
                data=err.get('data')
            )

        # 内存超限检查
        if self.max_memory_mb > 0 and method not in ('getMemoryUsage', 'destroy', 'loadRule', 'ping'):
            self._check_memory_limit()

        return resp.get('result')

    def check_memory_usage(self) -> Dict[str, int]:
        try:
            res = self.call_rpc('getMemoryUsage', [], timeout=2.0)
            return res if isinstance(res, dict) else {}
        except Exception:
            return {}

    def _check_memory_limit(self):
        usage = self.check_memory_usage()
        rss_bytes = usage.get('rss', 0)
        rss_mb = rss_bytes / (1024 * 1024)
        if rss_mb > self.max_memory_mb:
            logger.error(f"[DrpySupervisor] Memory limit exceeded: {rss_mb:.2f}MB > {self.max_memory_mb}MB. Killing worker.")
            self.kill()
            raise DrpyWorkerMemoryLimitError(
                f"Worker exceeded memory limit ({rss_mb:.2f}MB > {self.max_memory_mb}MB)."
            )

    def load_rule(self, rule_source: str, timeout: Optional[float] = None, _is_reload: bool = False) -> bool:
        """加载 drpy 规则源码并记录当前源码"""
        if not _is_reload:
            self.current_rule_source = rule_source
        timeout_sec = timeout if timeout is not None else self.timeout
        res = self.call_rpc('loadRule', [rule_source], timeout=timeout_sec)
        return bool(res and res.get('success'))

    def kill(self):
        """强杀 Worker 进程"""
        with self._lock:
            proc = self._proc
            self._proc = None
            if proc is not None:
                try:
                    # Windows 下彻底终止进程树（先 kill 进程，管道自然关闭）
                    if sys.platform == 'win32':
                        subprocess.run(
                            ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL
                        )
                    proc.kill()
                except Exception:
                    pass
            self._running = False
            for holder in self._pending_requests.values():
                holder['event'].set()
            self._pending_requests.clear()

    def destroy(self):
        """安全停止并清理专属临时目录"""
        try:
            if self.is_alive():
                self.call_rpc('destroy', [], timeout=2.0)
        except Exception:
            pass
        finally:
            self.kill()
            if self.temp_dir and os.path.exists(self.temp_dir):
                try:
                    shutil.rmtree(self.temp_dir, ignore_errors=True)
                except Exception:
                    pass
                self.temp_dir = None
