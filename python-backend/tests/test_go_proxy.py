# -*- coding: utf-8 -*-
"""go_proxy 白盒单元测试：监听生命周期 + ？url= 通道签名的生成与校验 + 分享/转存缓存。

与既有测试的互补边界（避免重复覆盖）：

- ``test_goproxy_segstream_and_url_auth.py``：_SegStream 背压/区间契约、
  ？url= 通道的 token 门禁与私网边界、HLS 重写。本文件**不碰**分段下载与
  HLS 重写，改测监听生命周期（start/stop/ensure_listener/_probe）与
  token 收集器的纯函数语义（多传输位置、去重、空值、过期）。
- ``test_proxy_http.py`` / ``test_proxy_stream.py``：真实 HTTP 回环与上游
  状态转发。本文件把 socket / 上游请求全部打桩，只测拼装与判定分支。
- ``test_port_generalization.py``：真实绑定 7777 等端口验证可达性与保护端口。
  本文件用假 server 工厂验证**构造参数、冲突回退与上限分支**（不占任何端口）。
- ``test_q7_fault_injection.py``：真实占住固定端口后 start_go_proxy 自愈。
  本文件补「全部端口冲突 → 返回 None」「OSError 分支 → 视为已被覆盖」。

纪律：go_proxy 是纯 Python 数据面（无外部 go 二进制可 spawn），全部进程/线程
副作用打桩；不出网；不监听固定端口（确需回环时用 127.0.0.1:0 且用完即关）；
时间推进用 mock，禁止 sleep。
"""
import http.client
import http.server
import json
import os
import socket
import sys
import tempfile
import threading

import unittest.mock as mock

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(HERE)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import go_proxy  # noqa: E402
import hoststate  # noqa: E402

FIXED_PORTS = [go_proxy.PORT] + list(go_proxy.EXTRA_PORTS)


# ---------------------------------------------------------------- 测试夹具


class _FakeServer:
    """``ThreadingHTTPServer`` 替身：记录构造参数，不占任何端口。"""

    def __init__(self, address, handler):
        self.address = address
        self.handler = handler
        self.serve_calls = 0
        self.shutdown_calls = 0
        self.close_calls = 0
        self.raise_on_shutdown = False

    def serve_forever(self):
        self.serve_calls += 1

    def shutdown(self):
        self.shutdown_calls += 1
        if self.raise_on_shutdown:
            raise RuntimeError('shutdown boom')

    def server_close(self):
        self.close_calls += 1


def _server_factory(blocked=(), record=None):
    """返回 ``ThreadingHTTPServer`` 替身工厂；blocked 端口抛 OSError（端口冲突）。"""
    made = []

    def factory(address, handler):
        if record is not None:
            record.append((address, handler))
        if address[1] in blocked:
            raise OSError('address already in use: %s' % (address,))
        srv = _FakeServer(address, handler)
        made.append(srv)
        return srv
    factory.made = made
    return factory


def _fake_listener(port, extra=None):
    return _FakeServer(('127.0.0.1', port), go_proxy._Handler)


class _StartPatch:
    """start_go_proxy 的统一打桩：假 server 工厂 + 屏蔽自检/保活线程。"""

    def __init__(self, blocked=(), record=None):
        self.blocked = blocked
        self.record = record if record is not None else []
        self.keeper_calls = []
        self._saved_base = None

    def __enter__(self):
        self._saved_base = go_proxy._base_servers
        go_proxy._base_servers = []
        self._p = [
            mock.patch('http.server.ThreadingHTTPServer',
                       _server_factory(self.blocked, self.record)),
            mock.patch.object(go_proxy, '_probe_listener_owner', lambda port: ''),
            mock.patch.object(go_proxy, 'start_quark_session_keeper',
                              lambda: self.keeper_calls.append(1)),
        ]
        for p in self._p:
            p.__enter__()
        return self

    def __exit__(self, *exc):
        for p in reversed(self._p):
            p.__exit__(*exc)
        go_proxy._base_servers = self._saved_base
        return False


class _DeadConn:
    """``http.client.HTTPConnection`` 替身：每次连接都按 timeout 失败。"""

    attempts = 0

    def __init__(self, host, port, timeout=None):
        _DeadConn.attempts += 1

    def request(self, *args, **kwargs):
        raise socket.timeout('timed out')

    def getresponse(self):
        raise AssertionError('unreachable: request must fail first')

    def close(self):
        pass


def _free_port():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


class _LoopbackHandler(http.server.BaseHTTPRequestHandler):
    """回环自检夹具：按类属性 ``pid`` 回 X-GoProxy-Pid（None 表示不发该头）。"""

    pid = '1'

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = b'ok'
        self.send_response(200)
        if _LoopbackHandler.pid is not None:
            self.send_header('X-GoProxy-Pid', str(_LoopbackHandler.pid))
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _serve_loopback(pid):
    """起一个 127.0.0.1:0 的临时监听；返回 (port, 关闭函数)。用完必须关。"""
    previous = _LoopbackHandler.pid
    _LoopbackHandler.pid = pid
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), _LoopbackHandler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True,
                              name='test-loopback-probe')
    thread.start()

    def close():
        try:
            srv.shutdown()
        except Exception:
            pass
        try:
            srv.server_close()
        except Exception:
            pass
        thread.join(timeout=5)
        _LoopbackHandler.pid = previous
    return srv.server_address[1], close


def _counting_qpost(stoken):
    """返回 (替身函数, 计数器)：patch.object 传 new 不产 Mock，故自带计数。"""
    calls = []

    def fake(*args, **kwargs):
        calls.append(1)

        class _Resp:
            status_code = 200

            def json(self):
                return {'data': {'stoken': stoken}}
        return _Resp()
    return fake, calls


# ---------------------------------------------- 可执行文件/路径探测（无外部二进制）


def test_go_proxy_has_no_external_binary_dependency():
    """go-proxy 在 PC 端是进程内 Python 实现：源码不得引入任何外部二进制 spawn。

    （任务书里的「可执行文件探测」在 go_proxy 上落到这一层：没有 go 二进制
    可 spawn，因此以源码级不变量 + 缓存文件路径探测三态覆盖该语义。）
    """
    with open(go_proxy.__file__, 'r', encoding='utf-8') as fp:
        src = fp.read()
    assert 'subprocess' not in src
    assert 'Popen' not in src
    assert 'os.system' not in src
    assert not hasattr(go_proxy, 'subprocess')
    # 启动入口只构造进程内监听器，不产生子进程
    assert callable(go_proxy.start_go_proxy)


def test_save_cache_path_probe_resolves_existing_dir():
    """路径探测（存在）：hoststate 缓存目录可用 → 返回文件绝对路径并建目录。"""
    tmp = tempfile.mkdtemp(prefix='yuki-test-savecache-')
    saved = go_proxy._SAVE_CACHE_FILE
    try:
        go_proxy._SAVE_CACHE_FILE = None
        with mock.patch.object(hoststate, 'get_cache_dir', return_value=tmp):
            path = go_proxy._save_cache_file()
        assert path == os.path.join(tmp, 'quark_save_cache.json'), path
        assert os.path.isdir(tmp)
        assert go_proxy._save_cache_file() == path   # 幂等（已 memoize）
    finally:
        go_proxy._SAVE_CACHE_FILE = saved
        try:
            os.rmdir(tmp)
        except OSError:
            pass


def test_save_cache_path_probe_falls_back_when_dir_unavailable():
    """路径探测（不存在/不可用）：hoststate 抛错 → 返回 ''，绝不向上抛。"""
    saved = go_proxy._SAVE_CACHE_FILE
    try:
        go_proxy._SAVE_CACHE_FILE = None
        with mock.patch.object(hoststate, 'get_cache_dir',
                               side_effect=RuntimeError('no hoststate')):
            assert go_proxy._save_cache_file() == ''
    finally:
        go_proxy._SAVE_CACHE_FILE = saved


def test_save_cache_path_probe_empty_path_is_rejected():
    """路径探测（空路径）：缓存目录为空串时不得退化成相对路径写到 CWD。"""
    saved = go_proxy._SAVE_CACHE_FILE
    try:
        go_proxy._SAVE_CACHE_FILE = None
        with mock.patch.object(hoststate, 'get_cache_dir', return_value=''):
            assert go_proxy._save_cache_file() == ''
        with mock.patch.object(hoststate, 'get_cache_dir', return_value='   '):
            go_proxy._SAVE_CACHE_FILE = None
            assert go_proxy._save_cache_file() == ''
    finally:
        go_proxy._SAVE_CACHE_FILE = saved


def test_persist_save_cache_is_atomic_and_reloadable():
    """转存缓存落盘：原子写（无 .tmp 残留）+ 可被 _load_save_cache 读回。"""
    tmp = tempfile.mkdtemp(prefix='yuki-test-savecache-')
    path = os.path.join(tmp, 'quark_save_cache.json')
    saved_file, saved_cache = go_proxy._SAVE_CACHE_FILE, dict(go_proxy._SAVE_CACHE)
    try:
        go_proxy._SAVE_CACHE_FILE = path
        go_proxy._SAVE_CACHE.clear()
        go_proxy._save_cache_put('pwd-1', 'fid-1')
        go_proxy._save_cache_put('pwd-2', 'fid-2')
        with open(path, 'r', encoding='utf-8') as fp:
            assert json.load(fp) == {'pwd-1': 'fid-1', 'pwd-2': 'fid-2'}
        assert not [n for n in os.listdir(tmp) if '.tmp' in n]
        go_proxy._SAVE_CACHE.clear()
        go_proxy._load_save_cache()
        assert go_proxy._SAVE_CACHE == {'pwd-1': 'fid-1', 'pwd-2': 'fid-2'}
    finally:
        go_proxy._SAVE_CACHE_FILE = saved_file
        go_proxy._SAVE_CACHE.clear()
        go_proxy._SAVE_CACHE.update(saved_cache)
        for name in os.listdir(tmp):
            try:
                os.remove(os.path.join(tmp, name))
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass


def test_save_cache_put_evicts_oldest_at_cap():
    """转存缓存上限：超过 _SAVE_CACHE_MAX 按插入序淘汰最早条目（无界增长护栏）。"""
    tmp = tempfile.mkdtemp(prefix='yuki-test-savecache-')
    path = os.path.join(tmp, 'quark_save_cache.json')
    saved_file, saved_cache = go_proxy._SAVE_CACHE_FILE, dict(go_proxy._SAVE_CACHE)
    saved_max = go_proxy._SAVE_CACHE_MAX
    try:
        go_proxy._SAVE_CACHE_FILE = path
        go_proxy._SAVE_CACHE.clear()
        go_proxy._SAVE_CACHE_MAX = 3
        for i in range(5):
            go_proxy._save_cache_put('pwd-%d' % i, 'fid-%d' % i)
        assert list(go_proxy._SAVE_CACHE) == ['pwd-2', 'pwd-3', 'pwd-4']
        assert len(go_proxy._SAVE_CACHE) == 3
        with open(path, 'r', encoding='utf-8') as fp:
            assert json.load(fp) == {k: v for k, v in go_proxy._SAVE_CACHE.items()}
    finally:
        go_proxy._SAVE_CACHE_MAX = saved_max
        go_proxy._SAVE_CACHE_FILE = saved_file
        go_proxy._SAVE_CACHE.clear()
        go_proxy._SAVE_CACHE.update(saved_cache)
        for name in os.listdir(tmp):
            try:
                os.remove(os.path.join(tmp, name))
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass


def test_save_cache_put_is_reentrant_under_concurrency():
    """并发写入：_SAVE_LOCK 是 RLock（put 内部再取锁落盘不得自死锁）。"""
    tmp = tempfile.mkdtemp(prefix='yuki-test-savecache-')
    path = os.path.join(tmp, 'quark_save_cache.json')
    saved_file, saved_cache = go_proxy._SAVE_CACHE_FILE, dict(go_proxy._SAVE_CACHE)
    saved_max = go_proxy._SAVE_CACHE_MAX
    try:
        go_proxy._SAVE_CACHE_FILE = path
        go_proxy._SAVE_CACHE.clear()
        go_proxy._SAVE_CACHE_MAX = 64

        def worker(i):
            go_proxy._save_cache_put('pwd-%d' % i, 'fid-%d' % i)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(16)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        assert not any(t.is_alive() for t in threads), 'RLock 自死锁'
        assert len(go_proxy._SAVE_CACHE) == 16
        with open(path, 'r', encoding='utf-8') as fp:
            assert len(json.load(fp)) == 16
        assert not [n for n in os.listdir(tmp) if '.tmp' in n]
    finally:
        go_proxy._SAVE_CACHE_MAX = saved_max
        go_proxy._SAVE_CACHE_FILE = saved_file
        go_proxy._SAVE_CACHE.clear()
        go_proxy._SAVE_CACHE.update(saved_cache)
        for name in os.listdir(tmp):
            try:
                os.remove(os.path.join(tmp, name))
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass


# ------------------------------------------------- 进程启动：参数拼装与端口冲突回退


def test_start_go_proxy_assembles_listener_args():
    """启动参数拼装：按 [PORT] + EXTRA_PORTS 顺序绑 127.0.0.1，共用同一 _Handler。"""
    record = []
    with _StartPatch(record=record) as patch:
        first = go_proxy.start_go_proxy()
        servers = go_proxy._base_servers
    assert [addr for addr, _ in record] == [('127.0.0.1', p) for p in FIXED_PORTS]
    assert all(handler is go_proxy._Handler for _, handler in record)
    assert len(servers) == len(FIXED_PORTS)
    assert first is servers[0]
    assert patch.keeper_calls == [1], '有监听器就位才起保活线程'


def test_start_go_proxy_spawns_daemon_threads_named_per_port():
    """每个监听器一个 daemon 线程，线程名带端口（崩溃时线程不拖住进程退出）。"""
    seen = []

    class _RecThread:
        def __init__(self, target=None, name='', daemon=None, args=(), kwargs=None):
            seen.append({'name': name, 'daemon': daemon, 'target': target})

        def start(self):
            pass

    record = []
    with _StartPatch(record=record):
        with mock.patch.object(threading, 'Thread', _RecThread):
            go_proxy.start_go_proxy()
    assert [item['name'] for item in seen] == ['go-proxy-%d' % p for p in FIXED_PORTS]
    assert all(item['daemon'] for item in seen)
    assert all(callable(item['target']) for item in seen)


def test_start_go_proxy_skips_conflicting_ports():
    """端口冲突回退：主端口被占 → 跳过它，其余端口照常就位并返回首个成功者。"""
    record = []
    with _StartPatch(blocked={go_proxy.PORT}, record=record) as patch:
        first = go_proxy.start_go_proxy()
        servers = go_proxy._base_servers
    assert [addr[1] for addr, _ in record] == FIXED_PORTS, '冲突端口也要尝试过'
    assert [srv.address[1] for srv in servers] == list(go_proxy.EXTRA_PORTS)
    assert first.address[1] == go_proxy.EXTRA_PORTS[0]
    assert patch.keeper_calls == [1]


def test_start_go_proxy_returns_none_when_all_ports_conflict():
    """全端口冲突：返回 None、_base_servers 为空、且不起保活线程（不误报成功）。"""
    record = []
    with _StartPatch(blocked=set(FIXED_PORTS), record=record) as patch:
        result = go_proxy.start_go_proxy()
        servers = go_proxy._base_servers
    assert result is None
    assert servers == []
    assert patch.keeper_calls == []


def test_start_go_proxy_is_idempotent_single_flight():
    """幂等单飞：已监听时二次调用直接复用，不再构造任何监听器。"""
    record = []
    with _StartPatch(record=record):
        first = go_proxy.start_go_proxy()
        second = go_proxy.start_go_proxy()
        assert second is first
    assert len(record) == len(FIXED_PORTS), '第二次调用不得再构造监听器'


def test_concurrent_start_returns_the_same_server():
    """并发启动单飞：多线程同时 start 只拿到同一批监听器，不重复构造。"""
    record = []
    with _StartPatch(record=record):
        first = go_proxy.start_go_proxy()
        results = []
        barrier = threading.Barrier(8)

        def worker():
            barrier.wait()
            results.append(go_proxy.start_go_proxy())

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        assert not any(t.is_alive() for t in threads)
        assert len(results) == 8
        assert all(item is first for item in results)
    assert len(record) == len(FIXED_PORTS)


# ------------------------------------------------------------------ 健康检查


def test_probe_listener_owner_detects_foreign_pid():
    """双绑定探测：端口被他进程接手（响应头 PID 不是自己）→ 报告该 PID。"""
    port, close = _serve_loopback(str(os.getpid() + 100000))
    try:
        with mock.patch.object(go_proxy.time, 'sleep'):
            owner = go_proxy._probe_listener_owner(port, attempts=1)
    finally:
        close()
    assert owner == str(os.getpid() + 100000), owner


def test_probe_listener_owner_accepts_self_pid():
    """健康检查成功：响应头 PID 就是本进程 → 视为独占，返回 ''。"""
    port, close = _serve_loopback(str(os.getpid()))
    try:
        with mock.patch.object(go_proxy.time, 'sleep'):
            assert go_proxy._probe_listener_owner(port, attempts=1) == ''
    finally:
        close()


def test_probe_listener_owner_without_pid_header_is_not_foreign():
    """响应缺少 X-GoProxy-Pid（旧实现/他类服务）→ 不下分裂态结论。"""
    port, close = _serve_loopback(None)
    try:
        with mock.patch.object(go_proxy.time, 'sleep'):
            assert go_proxy._probe_listener_owner(port, attempts=1) == ''
    finally:
        close()


def test_probe_listener_owner_connection_refused_returns_empty():
    """健康检查失败（连接被拒）：吞掉 OSError，按 attempts 次数重试后返回 ''。"""
    port = _free_port()
    _DeadConn.attempts = 0
    with mock.patch.object(go_proxy.time, 'sleep'), \
            mock.patch.object(http.client, 'HTTPConnection', _DeadConn):
        assert go_proxy._probe_listener_owner(port, attempts=3) == ''
    assert _DeadConn.attempts == 3


def test_probe_listener_owner_timeout_is_swallowed():
    """健康检查超时（socket.timeout 是 OSError 子类）→ 不得把异常抛给启动路径。"""
    _DeadConn.attempts = 0
    with mock.patch.object(go_proxy.time, 'sleep'), \
            mock.patch.object(http.client, 'HTTPConnection', _DeadConn):
        assert go_proxy._probe_listener_owner(go_proxy.PORT, attempts=2) == ''
    assert _DeadConn.attempts == 2


def test_health_check_do_ck_returns_ok_and_pid_header():
    """do=ck 健康检查：200 + 精确 body 'ok' + X-GoProxy-Pid（供双绑定自检比对）。"""
    handler = object.__new__(go_proxy._Handler)
    handler.headers = {}
    handler.path = '/proxy?do=ck'
    handler.command = 'GET'
    handler.wfile = _Buffer()
    events = []
    handler.send_response = lambda code: events.append(('status', code))
    handler.send_header = lambda k, v: events.append(('header', k, v))
    handler.end_headers = lambda: events.append(('end',))
    handler._handle()
    assert ('status', 200) in events
    assert ('header', 'X-GoProxy-Pid', str(os.getpid())) in events
    assert ('header', 'Content-Length', '2') in events
    assert handler.wfile.getvalue() == b'ok'
    assert handler._headers_sent is False, '_handle 入口重置「已发状态行」标记'


def test_health_check_head_only_writes_no_body():
    """HEAD 形态的健康检查：状态行与头照发，body 一字不写。"""
    handler = object.__new__(go_proxy._Handler)
    handler.headers = {}
    handler.path = '/proxy?do=ck'
    handler.command = 'HEAD'
    handler.wfile = _Buffer()
    events = []
    handler.send_response = lambda code: events.append(('status', code))
    handler.send_header = lambda k, v: events.append(('header', k, v))
    handler.end_headers = lambda: events.append(('end',))
    handler._handle(head_only=True)
    assert ('status', 200) in events
    assert handler.wfile.getvalue() == b''


class _Buffer:
    """最小 wfile 替身。"""

    def __init__(self):
        import io
        self._io = io.BytesIO()

    def write(self, data):
        return self._io.write(data)

    def flush(self):
        return self._io.flush()

    def getvalue(self):
        return self._io.getvalue()


# -------------------------------------------- 关闭：监听器清理与重启上限


def _install_fake_listeners():
    """往 _base_servers / _extra_servers 里塞替身；返回 (base, dynamic, 还原函数)。"""
    saved_base, saved_extra = go_proxy._base_servers, dict(go_proxy._extra_servers)
    base = [_fake_listener(p) for p in FIXED_PORTS]
    dynamic = {45001: _fake_listener(45001), 45002: _fake_listener(45002)}
    go_proxy._base_servers = list(base)
    go_proxy._extra_servers.clear()
    go_proxy._extra_servers.update(dynamic)

    def restore():
        go_proxy._base_servers = saved_base
        go_proxy._extra_servers.clear()
        go_proxy._extra_servers.update(saved_extra)
    return base, dynamic, restore


def test_stop_go_proxy_closes_base_and_dynamic_listeners():
    """关闭时的清理：固定端口与泛化端口的监听器都要 shutdown + server_close。"""
    base, dynamic, restore = _install_fake_listeners()
    try:
        go_proxy.stop_go_proxy()
        assert go_proxy._base_servers == []
        assert go_proxy._extra_servers == {}
        for srv in base + list(dynamic.values()):
            assert srv.shutdown_calls == 1
            assert srv.close_calls == 1
        assert go_proxy.listening_ports() == sorted(set(FIXED_PORTS))
    finally:
        restore()


def test_stop_go_proxy_survives_shutdown_failure():
    """关闭时某个监听器 shutdown 抛错：其余仍被关闭，容器照样清空（不泄漏）。"""
    base, dynamic, restore = _install_fake_listeners()
    try:
        base[0].raise_on_shutdown = True
        go_proxy.stop_go_proxy()      # 不得抛出
        assert go_proxy._base_servers == []
        assert base[0].close_calls == 1, 'shutdown 失败也要 server_close'
        for srv in base[1:] + list(dynamic.values()):
            assert srv.shutdown_calls == 1
            assert srv.close_calls == 1
    finally:
        restore()


def test_stop_then_start_rebuilds_listeners_exactly_once():
    """停止后重启：重新构造一遍监听器（次数恰好 = 端口数），旧句柄已全部关闭。"""
    base, _dynamic, restore = _install_fake_listeners()
    try:
        go_proxy.stop_go_proxy()
        assert go_proxy._base_servers == []
        assert all(srv.close_calls == 1 for srv in base)
        record = []
        with _StartPatch(record=record) as patch:
            rebuilt = go_proxy.start_go_proxy()
            servers = list(go_proxy._base_servers)
            keeper = list(patch.keeper_calls)
        assert len(record) == len(FIXED_PORTS)
        assert len(servers) == len(FIXED_PORTS)
        assert rebuilt is servers[0]
        assert keeper == [1], '重启后重新拉起保活线程'
        assert all(srv.shutdown_calls == 0 and srv.close_calls == 0
                   for srv in servers), '新监听器未被关闭'
        assert all(new is not old for new in servers for old in base)
    finally:
        restore()


def test_listener_restart_storm_is_bounded_by_cap():
    """泛化监听达上限：不再构造任何新监听器（防异常 jar 打满端口/无限重启）。"""
    saved_extra = dict(go_proxy._extra_servers)
    saved_cap = go_proxy.EXTRA_LISTENER_CAP
    try:
        go_proxy._extra_servers.clear()
        for i in range(go_proxy.EXTRA_LISTENER_CAP):
            go_proxy._extra_servers[46000 + i] = _fake_listener(46000 + i)
        with mock.patch('http.server.ThreadingHTTPServer',
                        _server_factory()) as factory:
            assert go_proxy.ensure_listener(47000) is False
        assert factory.made == [], '达上限后不得再构造监听器'
        assert 47000 not in go_proxy._extra_servers
    finally:
        go_proxy._extra_servers.clear()
        go_proxy._extra_servers.update(saved_extra)
        go_proxy.EXTRA_LISTENER_CAP = saved_cap


def test_restart_after_crash_does_not_multiply_listeners():
    """「崩溃残留」语义：句柄仍在（哪怕已死）时不重复拉起，避免监听器翻倍。"""
    saved_base = go_proxy._base_servers
    stale = _fake_listener(go_proxy.PORT)
    stale.raise_on_shutdown = True
    go_proxy._base_servers = [stale]
    try:
        with mock.patch('http.server.ThreadingHTTPServer',
                        _server_factory()) as factory:
            assert go_proxy.start_go_proxy() is stale
        assert factory.made == []
    finally:
        go_proxy._base_servers = saved_base


# ------------------------------------------------------- 端口泛化的守卫分支


def test_ensure_listener_rejects_protected_and_out_of_range_ports():
    """保护端口 / 越界端口 / 非法类型一律拒绝（后端 API 端口绝不被代理 Handler 占用）。"""
    saved_extra = dict(go_proxy._extra_servers)
    saved_state = {'port': hoststate.get_port(), 'token': hoststate.get_token()}
    try:
        go_proxy._extra_servers.clear()
        hoststate.configure(port=57000)
        with mock.patch('http.server.ThreadingHTTPServer',
                        _server_factory()) as factory:
            for port in (go_proxy.PORT, *go_proxy.EXTRA_PORTS, 57000, 80, 1023,
                         65536, 99999, -1, 0, 'not-a-port', None, 7944.0):
                assert go_proxy.ensure_listener(port) is False, port
        assert factory.made == []
        assert go_proxy._extra_servers == {}
    finally:
        go_proxy._extra_servers.clear()
        go_proxy._extra_servers.update(saved_extra)
        hoststate.configure(**saved_state)


def test_ensure_listener_survives_hoststate_failure():
    """hoststate 不可用（get_port 抛错/返回空）时仍按固定保护集合判定，不误拒。"""
    saved_extra = dict(go_proxy._extra_servers)
    try:
        go_proxy._extra_servers.clear()
        with mock.patch('http.server.ThreadingHTTPServer',
                        _server_factory()) as factory:
            with mock.patch.object(hoststate, 'get_port',
                                   side_effect=RuntimeError('boom')):
                assert go_proxy.ensure_listener(48001) is True
            assert len(factory.made) == 1
            with mock.patch.object(hoststate, 'get_port', return_value=None):
                assert go_proxy.ensure_listener(48002) is True
            # 后端端口为 0/空（未配置）时不纳入保护集合 → 也不误拒合法端口
            with mock.patch.object(hoststate, 'get_port', return_value=''):
                assert go_proxy.ensure_listener(48003) is True
        assert sorted(go_proxy._extra_servers) == [48001, 48002, 48003]
    finally:
        go_proxy._extra_servers.clear()
        go_proxy._extra_servers.update(saved_extra)


def test_ensure_listener_bind_conflict_counts_as_covered():
    """bind 失败（已被他进程监听）视为「已覆盖」返回 True，且不登记为自己的监听器。"""
    saved_extra = dict(go_proxy._extra_servers)
    try:
        go_proxy._extra_servers.clear()
        with mock.patch('http.server.ThreadingHTTPServer',
                        _server_factory(blocked={49001})) as factory:
            assert go_proxy.ensure_listener(49001) is True
            assert factory.made == []
            assert go_proxy._extra_servers == {}, '冲突端口不得占用名额'
            assert go_proxy.ensure_listener(49002) is True
            assert len(factory.made) == 1
            assert sorted(go_proxy._extra_servers) == [49002]
            # 已在监听：幂等返回 True 且不再构造
            assert go_proxy.ensure_listener(49002) is True
            assert len(factory.made) == 1
    finally:
        go_proxy._extra_servers.clear()
        go_proxy._extra_servers.update(saved_extra)


def test_listening_ports_merges_fixed_and_dynamic_with_dedup():
    """监听端口快照：固定端口 + 动态端口合并去重且有序（server 侧 token 白名单依赖）。"""
    saved_extra = dict(go_proxy._extra_servers)
    try:
        go_proxy._extra_servers.clear()
        go_proxy._extra_servers[go_proxy.EXTRA_PORTS[0]] = _fake_listener(
            go_proxy.EXTRA_PORTS[0])          # 与固定端口重叠
        go_proxy._extra_servers[49010] = _fake_listener(49010)
        ports = go_proxy.listening_ports()
        assert ports == sorted(set(FIXED_PORTS) | {49010}), ports
        assert len(ports) == len(set(ports))
    finally:
        go_proxy._extra_servers.clear()
        go_proxy._extra_servers.update(saved_extra)


# ------------------------------------------------- URL 签名的生成与校验


def _query_of(url):
    return __import__('urllib.parse', fromlist=['x']).parse_qs(
        __import__('urllib.parse', fromlist=['x']).urlparse(url).query,
        keep_blank_values=True)


def test_signed_url_generation_embeds_token_and_passes_validation():
    """签名生成→校验闭环：_hls_proxy_wrap 附上的 token 能通过 ？url= 通道门禁。"""
    saved = {'token': hoststate.get_token(), 'port': hoststate.get_port()}
    hoststate.configure(token='tok-signed')
    try:
        wrapped = go_proxy._hls_proxy_wrap('https://cdn.test/live/seg0.ts?a=1',
                                           token='tok-signed')
        assert wrapped.startswith('http://127.0.0.1:%d/proxy?url=' % go_proxy.PORT)
        assert 'tok-signed' in wrapped
        # 分片地址本身被 URL 编码（不含裸 ':''/' 破坏 query）
        assert 'https%3A%2F%2Fcdn.test' in wrapped
        q = _query_of(wrapped)
        assert go_proxy._request_valid_proxy_token(q, {}) is True
    finally:
        hoststate.configure(**saved)


def test_signed_url_tampered_token_is_rejected():
    """篡改拒绝：改写签名值（哪怕只差一个字符）不得通过 token 门禁。"""
    saved = {'token': hoststate.get_token(), 'port': hoststate.get_port()}
    hoststate.configure(token='tok-signed')
    try:
        wrapped = go_proxy._hls_proxy_wrap('https://cdn.test/seg.ts',
                                           token='tok-signed')
        q = _query_of(wrapped)
        q['token'] = ['tok-signedX']
        assert go_proxy._request_valid_proxy_token(q, {}) is False
        q['token'] = ['tok-signe']
        assert go_proxy._request_valid_proxy_token(q, {}) is False
        q['token'] = ['TOK-SIGNED']
        assert go_proxy._request_valid_proxy_token(q, {}) is False
    finally:
        hoststate.configure(**saved)


def test_signed_url_missing_token_is_rejected_even_without_host_token():
    """缺参数拒绝：宿主已配置 token 时不带签名的请求一律拒绝（无论值是否为空）。"""
    saved = {'token': hoststate.get_token(), 'port': hoststate.get_port()}
    try:
        hoststate.configure(token='tok-signed')
        assert go_proxy._request_valid_proxy_token({'url': ['https://x/y']}, {}) is False
        assert go_proxy._request_valid_proxy_token({'token': ['']}, {}) is False
        assert go_proxy._request_valid_proxy_token({}, {}) is False
        hoststate.configure(token='')       # 宿主未启用鉴权的兼容分支
        assert go_proxy._request_valid_proxy_token({'token': ['anything']}, {}) is False, \
            '宿主 token 为空时 valid_proxy_token 恒 False（空值兼容语义不对非空值放行）'
        assert go_proxy._request_valid_proxy_token({}, {}) is False, '缺参数仍拒绝'
        assert go_proxy._request_valid_proxy_token({'token': ['']}, {}) is False
    finally:
        hoststate.configure(**saved)


def test_token_collection_covers_query_and_header_positions():
    """签名收集：query 多值 + 请求头（大小写不敏感）全部收集，空值丢弃。"""
    values = go_proxy._request_proxy_tokens(
        {'Token': ['a', ''], 'url': ['https://x/y']},
        {'X-Proxy-Token': 'b', 'proxy-token': 'c', 'Proxy-Token': None,
         'Cookie': 'k=v'})
    assert values == ['a', 'b', 'c'], values
    assert go_proxy._request_proxy_tokens({}, {}) == []
    assert go_proxy._request_proxy_tokens(None, None) == []


def test_signed_url_header_position_validates():
    """签名在请求头位置（X-Proxy-Token）同样通过校验。"""
    saved = {'token': hoststate.get_token(), 'port': hoststate.get_port()}
    hoststate.configure(token='tok-header')
    try:
        assert go_proxy._request_valid_proxy_token(
            {}, {'X-Proxy-Token': 'tok-header'}) is True
        assert go_proxy._request_valid_proxy_token(
            {'token': ['wrong']}, {'x-proxy-token': 'tok-header'}) is True
        assert go_proxy._request_valid_proxy_token(
            {'token': ['wrong']}, {'x-proxy-token': 'also-wrong'}) is False
    finally:
        hoststate.configure(**saved)


# ------------------------------------------- 分享解析缓存：TTL 过期与容量上限


def test_share_cache_fresh_entry_short_circuits():
    """签名有效期内：直接复用缓存 stoken，不再向夸克申请（不重复建会话）。"""
    saved = dict(go_proxy._SHARE_CACHE)
    try:
        go_proxy._SHARE_CACHE.clear()
        import time as _time
        go_proxy._SHARE_CACHE['pwd-1'] = {'ts': _time.time(), 'stoken': 'cached',
                                          'fid': 'f1', 'fid_token': 'ft1'}
        fake, calls = _counting_qpost('brand-new')
        with mock.patch.object(go_proxy, '_qpost', fake):
            assert go_proxy._quark_share_stoken('pwd-1', {}) == 'cached'
        assert calls == [], '有效期内不得重复申请 stoken'
    finally:
        go_proxy._SHARE_CACHE.clear()
        go_proxy._SHARE_CACHE.update(saved)


def test_share_cache_expired_entry_is_dropped_and_refreshed():
    """过期拒绝：超过 _SHARE_CACHE_TTL 的条目被清掉并重新申请 stoken。"""
    saved = dict(go_proxy._SHARE_CACHE)
    try:
        go_proxy._SHARE_CACHE.clear()
        import time as _time
        go_proxy._SHARE_CACHE['pwd-2'] = {'ts': _time.time() - 301,
                                          'stoken': 'stale', 'fid': 'f2',
                                          'fid_token': 'ft2'}
        fake, calls = _counting_qpost('fresh')
        with mock.patch.object(go_proxy, '_qpost', fake):
            assert go_proxy._quark_share_stoken('pwd-2', {}) == 'fresh'
        assert calls == [1], '过期条目必须触发一次重新申请'
        entry = go_proxy._SHARE_CACHE['pwd-2']
        assert entry['stoken'] == 'fresh'
        assert entry['fid'] == 'f2', '重建时保留 fid/fid_token'
        assert entry['fid_token'] == 'ft2'
    finally:
        go_proxy._SHARE_CACHE.clear()
        go_proxy._SHARE_CACHE.update(saved)


def test_share_cache_cap_clears_everything():
    """容量上限：触顶整表清空后写入新条目（条目均为 300s TTL，代价最低）。"""
    saved = dict(go_proxy._SHARE_CACHE)
    saved_max = go_proxy._SHARE_CACHE_MAX
    try:
        go_proxy._SHARE_CACHE.clear()
        go_proxy._SHARE_CACHE_MAX = 4
        import time as _time
        for i in range(4):
            go_proxy._SHARE_CACHE['pwd-%d' % i] = {'ts': _time.time(),
                                                   'stoken': 's%d' % i,
                                                   'fid': '', 'fid_token': ''}
        fake, _calls = _counting_qpost('after-cap')
        with mock.patch.object(go_proxy, '_qpost', fake):
            assert go_proxy._quark_share_stoken('pwd-9', {}) == 'after-cap'
        assert list(go_proxy._SHARE_CACHE) == ['pwd-9']
        assert len(go_proxy._SHARE_CACHE) == 1
    finally:
        go_proxy._SHARE_CACHE_MAX = saved_max
        go_proxy._SHARE_CACHE.clear()
        go_proxy._SHARE_CACHE.update(saved)


# ---------------------------------------------------------------- 纯函数边界


def test_parse_range_matrix():
    """Range 解析矩阵：无头/非 bytes/开放区间/后缀区间/越界/多段/垃圾输入。"""
    assert go_proxy._parse_range(None, 100) == (0, 99)
    assert go_proxy._parse_range('', 100) == (0, 99)
    assert go_proxy._parse_range('items=0-10', 100) == (0, 99)
    assert go_proxy._parse_range('bytes=0-9', 100) == (0, 9)
    assert go_proxy._parse_range('bytes=10-', 100) == (10, 99)
    assert go_proxy._parse_range('bytes=-5', 100) == (95, 99)
    assert go_proxy._parse_range('bytes=90-500', 100) == (90, 99), 'end 钳到 total-1'
    assert go_proxy._parse_range('bytes=0-99', 100) == (0, 99)
    assert go_proxy._parse_range('bytes=50-10', 100) is None, '倒置 → 416'
    assert go_proxy._parse_range('bytes=200-300', 100) is None, '越界 → 416'
    assert go_proxy._parse_range('bytes=0-9,20-29', 100) == (0, 9), '多段取首段'
    assert go_proxy._parse_range('bytes=abc-def', 100) == (0, 99), '垃圾输入兜底'
    assert go_proxy._parse_range('bytes=-', 100) == (0, 99)
    assert go_proxy._parse_range('bytes=-1000', 100) == (0, 99), ' suffix 超长钳到 0'


def test_quark_quality_key_normalizes_line_suffix():
    """线路名归一化：去 ``#xxxx`` 后缀 + 大小写无关 + 未知名原样透传。"""
    assert go_proxy._quark_quality_key('原画#0101') == 'original'
    assert go_proxy._quark_quality_key('Quark原画') == 'original'
    assert go_proxy._quark_quality_key('  HIGH ') == 'high'
    assert go_proxy._quark_quality_key('普画') == 'normal'
    assert go_proxy._quark_quality_key('4K') == '4k'
    assert go_proxy._quark_quality_key('蓝光') == '蓝光', '未知线路原样透传'
    assert go_proxy._quark_quality_key('') == ''
    assert go_proxy._quark_quality_key(None) == ''


if __name__ == '__main__':
    passed = 0
    failed = []
    for name, fn in sorted(globals().items()):
        if not (name.startswith('test_') and callable(fn)):
            continue
        try:
            fn()
        except Exception as exc:                      # noqa: BLE001 汇总 runner
            failed.append((name, exc))
            print('FAIL %s: %s: %s' % (name, type(exc).__name__, exc))
        else:
            passed += 1
            print('PASS %s' % name)
    print('----')
    print('TOTAL %d PASS %d FAIL %d' % (passed + len(failed), passed, len(failed)))
    if failed:
        for name, exc in failed:
            print('FAILED %s -> %s' % (name, exc))
        sys.exit(1)
    print('ALL PASS')
