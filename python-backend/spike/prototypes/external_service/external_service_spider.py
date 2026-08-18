# -*- coding: utf-8 -*-
"""方案3【外部 drpy 服务】原型 —— Python 后端客户端适配器。

把 base Spider 接口的每个方法翻译成对「独立外部 drpy 服务」的 HTTP REST 调用，
返回标准 dict。包含三个组成部分：

- DrpyServiceClient      底层 keep-alive HTTP 客户端（requests.Session 连接复用），
                         逐调用记录延迟/字节，用于网络开销评测；
- ManagedDrpyService     进程保活原型：自动拉起 drpy_service.py 子进程，/ping
                         看门狗 + 指数退避重启，destroy()/atexit 兜底清理防孤儿；
- ExternalDrpySpider     统一 Python 调用适配器，实现 base Spider 接口。

两种接入方式：
    1) 直连已部署服务：  ExternalDrpySpider(base_url='http://127.0.0.1:9810', rule='demo_movie')
    2) 自动托管子进程：  ExternalDrpySpider(rule='demo_movie')          # auto_spawn=True
                         进程由 ManagedDrpyService 保活，spider.destroy() 时回收。

运行评测（从 python-backend 目录）：
    .venv/Scripts/python.exe spike/prototypes/external_service/run_proto.py
"""

import atexit
import base64
import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

try:  # 仓库内运行：接入真实 base Spider 接口
    from base.spider import Spider as _BaseSpider
    _BASE_IMPORTABLE = True
except ImportError:  # 脱离仓库单独演示时的最小回退基类（接口签名一致）
    _BASE_IMPORTABLE = False

    class _BaseSpider:  # pragma: no cover - 仅离线回退
        def __init__(self):
            self.extend = ''

        def init(self, extend=''):
            pass

        def homeContent(self, filter):
            return {}

        def homeVideoContent(self):
            return {}

        def categoryContent(self, tid, pg, filter, extend):
            return {}

        def detailContent(self, ids):
            return {}

        def searchContent(self, key, quick, pg='1'):
            return {}

        def playerContent(self, flag, id, vipFlags):
            return {}

        def liveContent(self, url):
            return {}

        def localProxy(self, param):
            return [200, 'text/plain; charset=utf-8', b'']

        def isVideoFormat(self, url):
            return False

        def manualVideoCheck(self):
            return False

        def action(self, action):
            return {}

        def destroy(self):
            pass

        def getName(self):
            return ''

        def getDependence(self):
            return []

try:
    import requests
except ImportError:  # pragma: no cover - venv 已装 requests，此分支仅作防御
    requests = None

SERVICE_SCRIPT = Path(__file__).resolve().parent / 'drpy_service.py'
READY_PREFIX = 'DRPY_SERVICE_READY '


# ---------------------------------------------------------------- 底层客户端
class DrpyServiceError(RuntimeError):
    """外部 drpy 服务调用失败（连接 / HTTP 错误 / 服务端业务错误）。"""


class DrpyServiceClient:
    """外部 drpy 服务的 keep-alive HTTP 客户端。

    优先使用 requests.Session（TCP 连接复用 / 连接池）；requests 不可用时回退
    urllib（每次新建连接 —— 无连接复用，评测时可对比 keep-alive 收益）。
    """

    def __init__(self, base_url, timeout=5.0, token=None):
        self.base_url = str(base_url).rstrip('/')
        self.timeout = timeout
        self.token = token or None
        self._session = requests.Session() if requests is not None else None
        self._lock = threading.Lock()
        self.stats = {
            'calls': 0,
            'errors': 0,
            'bytes_sent': 0,
            'bytes_recv': 0,
            'total_ns': 0,
        }

    # ---------------- 底层请求 ----------------
    def request(self, method, path, body=None):
        url = self.base_url + path
        headers = {}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        t0 = time.perf_counter_ns()
        try:
            if self._session is not None:
                resp = self._session.request(method, url, json=body, timeout=self.timeout,
                                             headers=headers)
                status, payload = resp.status_code, resp.content
            else:  # pragma: no cover - 仅当 requests 缺失
                data = json.dumps(body).encode('utf-8') if body is not None else None
                req = urllib.request.Request(url, data=data, headers=headers, method=method)
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    status, payload = resp.status, resp.read()
        except Exception as exc:
            dt = time.perf_counter_ns() - t0
            with self._lock:
                self.stats['calls'] += 1
                self.stats['errors'] += 1
                self.stats['total_ns'] += dt
            raise DrpyServiceError(f'HTTP {method} {path} -> {type(exc).__name__}: {exc}') from exc
        dt = time.perf_counter_ns() - t0
        with self._lock:
            self.stats['calls'] += 1
            self.stats['bytes_sent'] += len(json.dumps(body).encode('utf-8')) if body else 0
            self.stats['bytes_recv'] += len(payload)
            self.stats['total_ns'] += dt
        return status, payload

    # ---------------- 业务调用 ----------------
    def invoke(self, rule, method, args=None, kwargs=None):
        """POST /api/v1/invoke，返回服务端 `data`（标准 dict）。"""
        body = {'rule': rule, 'method': method, 'args': args or [], 'kwargs': kwargs or {}}
        status, payload = self.request('POST', '/api/v1/invoke', body)
        try:
            obj = json.loads(payload.decode('utf-8'))
        except (ValueError, UnicodeDecodeError) as exc:
            raise DrpyServiceError(
                f'drpy invoke {rule}.{method} -> HTTP {status}, non-json body: {exc}') from exc
        if status != 200 or not obj.get('ok'):
            raise DrpyServiceError(
                f'drpy invoke {rule}.{method} -> HTTP {status}: {obj.get("error")}')
        return obj.get('data')

    def ping(self):
        """GET /api/v1/ping；失败返回 None（由调用方决定重试/重启）。"""
        try:
            status, payload = self.request('GET', '/api/v1/ping', None)
            if status != 200:
                return None
            return json.loads(payload.decode('utf-8'))
        except DrpyServiceError:
            return None

    def service_stats(self):
        try:
            status, payload = self.request('GET', '/api/v1/stats', None)
            if status != 200:
                return {}
            return json.loads(payload.decode('utf-8')).get('stats', {})
        except DrpyServiceError:
            return {}

    def stats_snapshot(self):
        with self._lock:
            return dict(self.stats)

    def close(self):
        if self._session is not None:
            try:
                self._session.close()
            except Exception:
                pass


# ---------------------------------------------------------------- 进程保活原型
class ManagedDrpyService:
    """独立 drpy 服务进程的托管器（进程保活机制原型）。

    - start():  以子进程拉起 drpy_service.py（--port 0 自动分配），读就绪行取 URL；
    - watchdog: 后台线程周期性 /ping；进程死亡或连续 N 次健康检查失败即重启，
                指数退避（1s/2s/4s/8s…封顶 10s），重启后回调 on_restart(new_url)；
    - stop():   停止看门狗、terminate 子进程；atexit 兜底，避免孤儿进程。
    """

    def __init__(self, host='127.0.0.1', port=0, latency_ms=0, token=None,
                 rule_dir=None, python=None, health_interval=1.0,
                 max_health_fails=3, max_restarts=5, start_timeout=10.0,
                 on_restart=None):
        self.host = host
        self.port = port
        self.latency_ms = latency_ms
        self.token = token
        self.rule_dir = rule_dir
        self.python = python or sys.executable
        self.health_interval = health_interval
        self.max_health_fails = max_health_fails
        self.max_restarts = max_restarts
        self.start_timeout = start_timeout
        self.on_restart = on_restart

        self.proc = None
        self.base_url = None
        self.restart_count = 0
        self.events = []           # [(ts, 事件描述)]，供评测输出
        self._lines = queue.Queue()
        self._reader = None
        self._stop = threading.Event()
        self._watchdog = None
        self._restart_lock = threading.Lock()
        atexit.register(self.stop)

    # ---------------- 生命周期 ----------------
    def start(self):
        self._spawn()
        self._wait_ready()
        self._watchdog = threading.Thread(target=self._watchdog_loop,
                                          name='drpy-watchdog', daemon=True)
        self._watchdog.start()
        self._log(f'started url={self.base_url} pid={self.proc.pid}')

    def _spawn(self):
        cmd = [self.python, str(SERVICE_SCRIPT), '--host', self.host,
               '--port', str(self.port)]
        if self.latency_ms:
            cmd += ['--latency-ms', str(self.latency_ms)]
        if self.token:
            cmd += ['--token', self.token]
        if self.rule_dir:
            cmd += ['--rule-dir', str(self.rule_dir)]
        kwargs = {}
        if os.name == 'nt':
            kwargs['creationflags'] = 0x08000000  # CREATE_NO_WINDOW
        env = dict(os.environ)
        env.setdefault('PYTHONIOENCODING', 'utf-8')
        env.setdefault('PYTHONUTF8', '1')
        self.proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', env=env,
            cwd=str(SERVICE_SCRIPT.parent), **kwargs)
        self._reader = threading.Thread(target=self._read_lines, daemon=True)
        self._reader.start()

    def _read_lines(self):
        try:
            for line in self.proc.stdout:
                self._lines.put(line.rstrip('\n'))
        except (ValueError, OSError):
            pass

    def _wait_ready(self):
        deadline = time.time() + self.start_timeout
        while time.time() < deadline:
            try:
                line = self._lines.get(timeout=0.5)
            except queue.Empty:
                if self.proc.poll() is not None:
                    break
                continue
            if line.startswith(READY_PREFIX):
                url = line[len(READY_PREFIX):].split()[0].split('url=')[-1]
                self.base_url = url
                return
            self._log(f'child: {line}')
        raise DrpyServiceError(
            f'drpy service did not become ready in {self.start_timeout}s '
            f'(exit={self.proc.poll()}); last lines:\n' + self._tail())

    def _tail(self, n=12):
        lines = []
        while not self._lines.empty() and len(lines) < n:
            lines.append(self._lines.get())
        return '\n'.join(lines)

    # ---------------- 看门狗 ----------------
    def _watchdog_loop(self):
        health_fails = 0
        while not self._stop.is_set():
            self._stop.wait(self.health_interval)
            if self._stop.is_set():
                break
            proc = self.proc
            if proc is None or proc.poll() is not None:
                self.restart('child process exited')
                health_fails = 0
                continue
            ok = self._ping_ok()
            health_fails = 0 if ok else health_fails + 1
            if health_fails >= self.max_health_fails:
                self.restart(f'health check failed x{health_fails}')
                health_fails = 0

    def _ping_ok(self):
        try:
            status, payload = self._raw_ping()
            if status != 200:
                return False
            return bool(json.loads(payload.decode('utf-8')).get('ok'))
        except (DrpyServiceError, ValueError, UnicodeDecodeError):
            return False

    def _raw_ping(self):
        url = self.base_url + '/api/v1/ping'
        if requests is not None:
            resp = requests.get(url, timeout=self.health_interval + 1.0)
            return resp.status_code, resp.content
        with urllib.request.urlopen(url, timeout=self.health_interval + 1.0) as resp:
            return resp.status, resp.read()

    def restart(self, reason):
        with self._restart_lock:
            if self.restart_count >= self.max_restarts:
                self._log(f'restart skipped: max_restarts={self.max_restarts} reached '
                          f'(reason={reason})')
                return
            if self.proc is not None and self.proc.poll() is None:
                self._kill_proc()
            self.restart_count += 1
            backoff = min(10.0, 2 ** self.restart_count)
            self._log(f'restarting (#{self.restart_count}, backoff={backoff}s, reason={reason})')
            self._stop.wait(backoff)
            if self._stop.is_set():
                return
            old_url = self.base_url
            self._spawn()
            try:
                self._wait_ready()
            except DrpyServiceError:
                self._log('restart failed: service did not become ready')
                return
            if self.base_url != old_url and self.on_restart:
                try:
                    self.on_restart(self.base_url)
                except Exception as exc:
                    self._log(f'on_restart callback failed: {exc}')

    def _kill_proc(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=3.0)
        except (subprocess.TimeoutExpired, OSError):
            try:
                self.proc.kill()
            except OSError:
                pass
        self.proc = None

    def kill_for_test(self):
        """评测用：模拟外部服务进程意外死亡（触发看门狗重启）。"""
        proc = self.proc
        if proc is not None and proc.poll() is None:
            proc.kill()
            self._log('kill_for_test: sent SIGKILL/terminate to child pid={}'.format(proc.pid))

    def stop(self):
        self._stop.set()
        if self._watchdog is not None:
            self._watchdog.join(timeout=self.health_interval + 2.0)
            self._watchdog = None
        if self.proc is not None:
            self._kill_proc()
        self._log('stopped')

    def _log(self, msg):
        self.events.append((time.time(), msg))

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()


# ---------------------------------------------------------------- 统一适配器
class ExternalDrpySpider(_BaseSpider):
    """统一 Python 调用适配器：把 base Spider 接口翻译为外部 drpy 服务 REST 调用。

    用法::

        spider = ExternalDrpySpider(base_url='http://127.0.0.1:9810', rule='demo_movie')
        spider.init('')
        print(spider.homeContent(False))          # -> 标准 dict
        print(spider.detailContent(['h01']))      # -> {'list': [...]}
        print(spider.playerContent('demo_movie', 'h01', []))
        spider.destroy()

    参数:
        base_url:   外部 drpy 服务地址；None 且 auto_spawn=True 时自动托管子进程。
        rule:       外部服务上注册的规则名。
        timeout:    单次 HTTP 调用超时（秒）。
        token:      Bearer token（服务端开启鉴权时必填）。
        service:    复用已托管的 ManagedDrpyService 实例。
        auto_spawn: base_url 为空时是否自动拉起并保活独立服务进程。
    """

    def __new__(cls, *args, **kwargs):
        # 原型阶段需要多个独立实例（不同 base_url/rule/token），绕过基类单例
        return object.__new__(cls)

    def __init__(self, base_url=None, rule='demo_cms', timeout=5.0, token=None,
                 service=None, auto_spawn=True):
        super().__init__()
        self.rule = rule
        self.timeout = timeout
        self._owns_service = False
        if base_url is None and service is None and auto_spawn:
            service = ManagedDrpyService(port=0)
            service.start()
            self._owns_service = True
        self.service = service
        if service is not None:
            if service.base_url is None:
                service.start()
                self._owns_service = True
            if self._owns_service and service.on_restart is None:
                service.on_restart = self._on_service_restart
            base_url = service.base_url
        if not base_url:
            raise ValueError('ExternalDrpySpider requires base_url or a started service')
        self.client = DrpyServiceClient(base_url, timeout=timeout, token=token)

    # ---------------- base Spider 接口 ----------------
    def init(self, extend=''):
        self.extend = extend
        try:
            self._invoke('init', [extend])
        except DrpyServiceError:
            pass  # 远程 init 失败不阻断加载，留到首个真实调用暴露

    def getName(self):
        try:
            return self._invoke('getName') or self.rule
        except DrpyServiceError:
            return self.rule

    def getDependence(self):
        try:
            return self._invoke('getDependence') or []
        except DrpyServiceError:
            return []

    def homeContent(self, filter):
        return self._invoke('homeContent', [filter])

    def homeVideoContent(self):
        return self._invoke('homeVideoContent')

    def categoryContent(self, tid, pg, filter, extend):
        return self._invoke('categoryContent', [tid, pg, filter, extend])

    def detailContent(self, ids):
        return self._invoke('detailContent', [ids])

    def searchContent(self, key, quick, pg='1'):
        return self._invoke('searchContent', [key, quick, pg])

    def playerContent(self, flag, id, vipFlags):
        return self._invoke('playerContent', [flag, id, vipFlags])

    def liveContent(self, url):
        return self._invoke('liveContent', [url])

    def action(self, action):
        return self._invoke('action', [action])

    def isVideoFormat(self, url):
        return bool(self._invoke('isVideoFormat', [url]))

    def manualVideoCheck(self):
        return bool(self._invoke('manualVideoCheck'))

    def localProxy(self, param):
        data = self._invoke('localProxy', [param])
        if isinstance(data, list) and len(data) == 3:
            body = data[2]
            if isinstance(body, str):  # REST 传输约定：bytes 以 base64 承载
                try:
                    body = base64.b64decode(body)
                except (ValueError, TypeError):
                    body = body.encode('utf-8')
            return [data[0], data[1], body]
        return [200, 'text/plain; charset=utf-8', b'']

    def destroy(self):
        try:
            self.client.close()
        finally:
            if self._owns_service and self.service is not None:
                self.service.stop()
                self._owns_service = False

    # ---------------- 评测辅助 ----------------
    def _invoke(self, method, args=None, kwargs=None):
        return self.client.invoke(self.rule, method, args, kwargs)

    def _on_service_restart(self, new_url):
        self.client = DrpyServiceClient(new_url, timeout=self.timeout, token=self.client.token)

    def stats(self):
        """客户端侧累计统计（调用数 / 字节 / 延迟）。"""
        return self.client.stats_snapshot()

    def benchmark(self, method='homeContent', args=None, kwargs=None, n=100,
                  warmup=5, name=None):
        """评测网络开销：n 次调用，返回汇总指标。

        说明::
            cold_connect_ms —— 首个（冷连接）调用耗时；
            avg/p50/p95/p99 —— 稳态调用延迟；
            bytes_per_call   —— 请求体 + 响应体字节数；
            service_ms       —— 服务端处理耗时（/api/v1/stats 增量）；
            net_overhead_ms  —— 传输 + 序列化开销 ≈ 客户端总耗时 - 服务端耗时。
        """
        label = name or f'{self.rule}.{method}'
        args = args or []
        kwargs = kwargs or {}
        payload_bytes = 0
        # 冷连接：客户端尚无调用时先单独测一次首调用（新建 TCP 连接）
        cold = None
        if self.client.stats_snapshot()['calls'] == 0:
            t0 = time.perf_counter_ns()
            self._invoke(method, args, kwargs)
            cold = time.perf_counter_ns() - t0
        for _ in range(max(0, warmup)):
            self._invoke(method, args, kwargs)
        sv_before = self.client.service_stats()
        cb_before = self.client.stats_snapshot()
        lat = []
        for _ in range(n):
            t0 = time.perf_counter_ns()
            self._invoke(method, args, kwargs)
            lat.append((time.perf_counter_ns() - t0) / 1e6)
        cb_after = self.client.stats_snapshot()
        sv_after = self.client.service_stats()
        delta_bytes = ((cb_after['bytes_sent'] - cb_before['bytes_sent']) +
                       (cb_after['bytes_recv'] - cb_before['bytes_recv']))
        payload_bytes = int(delta_bytes / n) if n else 0
        service_ms = None
        if sv_after.get('invokes', 0) > sv_before.get('invokes', 0):
            dn = sv_after['handle_ns'] - sv_before.get('handle_ns', 0)
            di = sv_after['invokes'] - sv_before.get('invokes', 0)
            service_ms = (dn / 1e6) / di if di else 0.0
        lat.sort()
        avg = sum(lat) / len(lat) if lat else 0.0

        def _pct(p):
            if not lat:
                return 0.0
            idx = min(len(lat) - 1, int(len(lat) * p))
            return lat[idx]

        overhead_ms = None
        overhead_pct = None
        if service_ms is not None:
            overhead_ms = max(0.0, avg - service_ms)
            overhead_pct = (overhead_ms / avg * 100.0) if avg > 0 else 0.0
        return {
            'benchmark': label,
            'n': n,
            'cold_connect_ms': round(cold / 1e6, 3) if cold else None,
            'avg_ms': round(avg, 3),
            'p50_ms': round(_pct(0.50), 3),
            'p95_ms': round(_pct(0.95), 3),
            'p99_ms': round(_pct(0.99), 3),
            'bytes_per_call': payload_bytes,
            'service_ms': round(service_ms, 3) if service_ms is not None else None,
            'net_overhead_ms': round(overhead_ms, 3) if overhead_ms is not None else None,
            'overhead_pct': round(overhead_pct, 1) if overhead_pct is not None else None,
        }


# 插件约定别名：运行时按「顶层类名 Spider」加载时同样可用。
Spider = ExternalDrpySpider


def create_external_spider(base_url=None, rule='demo_cms', **kwargs):
    """便捷工厂：返回 ExternalDrpySpider 实例（base_url 缺省时自动托管服务进程）。"""
    return ExternalDrpySpider(base_url=base_url, rule=rule, **kwargs)


if __name__ == '__main__':
    import argparse

    ap = argparse.ArgumentParser(description='外部 drpy 服务适配器自检')
    ap.add_argument('--base-url', default=None, help='外部服务地址（缺省自动拉起）')
    ap.add_argument('--rule', default='demo_movie')
    ap.add_argument('--timeout', type=float, default=5.0)
    args = ap.parse_args()
    spider = create_external_spider(base_url=args.base_url, rule=args.rule,
                                    timeout=args.timeout)
    spider.init('spike')
    print('getName =', spider.getName())
    print('homeContent keys =', sorted(spider.homeContent(False)))
    print('detailContent list[0].vod_name =', spider.detailContent(['h01'])['list'][0]['vod_name'])
    print('searchContent count =', len(spider.searchContent('spike', False)['list']))
    print('playerContent =', spider.playerContent('demo_movie', 'h01', []))
    print('stats =', spider.stats())
    spider.destroy()
    print('self-check OK')