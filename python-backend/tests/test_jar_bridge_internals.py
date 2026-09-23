# -*- coding: utf-8 -*-
"""JAR Spider 桥接内部机制白盒测试（纯函数 / 协议解析 / 子进程桩）。

与既有 JAR 测试互补：test_jar_proxy / test_jar_e2e / test_jar_supervisor 依赖真实
JDK 与 spider-runner.jar（无 JDK 即 skip，协议细节恒未覆盖）；test_jar_phase 走
FakeBridge 只验证适配层；test_dex2jar_lifecycle 只覆盖 dex2jar 三条退出路径。
本文件用 unittest.mock 完全打桩 subprocess，覆盖它们碰不到的纯函数与分支：

- 协议帧：请求序列化（动作名/参数 map/转义/Unicode/嵌套/空参）、响应解析
  （正常/多行/半包/非法 JSON/空行/错误帧/超长帧）；
- 参数类型转换：Python 类型 → params 映射与缺参兜底；
- 结果映射：Java 返回结构 → 内部模型；
- jar_patch：常量池解析、Utf8 替换、条目名校验、幂等、失败不破坏原文件；
- java_probe：候选优先级、版本解析、缓存与失效；
- 子进程生命周期：超时清理、崩溃计数上限、串行化、关闭释放。

禁止真实子进程 / 真实网络 / sleep 等待。
"""
import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest.mock as mock
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import hoststate  # noqa: E402

hoststate.configure(port=19761, token='jar-internals-token')

import jar_bridge  # noqa: E402
import jar_patch  # noqa: E402
import java_probe  # noqa: E402
import runtime.contracts as rt_contracts  # noqa: E402
from jar_bridge import JarBridge  # noqa: E402
from jar_spider import JarSpider, _load_pan_cookies  # noqa: E402
from proxy_contract import ProxyResult  # noqa: E402
from runtime.errors import RuntimeError as RuntimeContractError  # noqa: E402


# 安全网：把 cookie 清理目录指向一个**不存在的**临时路径。任何触及真实清理路径的
# 代码路径（_kill_proc / destroy 的兜底清理）都只会静默 no-op，绝不删用户真实登录态。
_UNUSED_COOKIE_DIR = os.path.join(tempfile.gettempdir(), 'yuki-test-cookie-dir-absent')
jar_bridge._JVM_COOKIE_DIR = _UNUSED_COOKIE_DIR


# ============================================================================
# 桩：假 JVM 子进程
# ============================================================================

class _FakePipe:
    """可写可读的内存管道替身（stdin/stdout/stderr）。"""

    def __init__(self, payload=b''):
        self.buf = io.BytesIO(payload)
        self.written = bytearray()
        self.closed = False

    def write(self, data):
        if self.closed:
            raise OSError('pipe closed')
        self.written.extend(data)
        return len(data)

    def flush(self):
        if self.closed:
            raise OSError('pipe closed')

    def readline(self):
        return self.buf.readline()

    def read(self, _size=-1):
        return self.buf.read()

    def close(self):
        self.closed = True

    def __iter__(self):
        return iter(())


class _FakeProc:
    """subprocess.Popen 替身：绝不真的派生进程。"""

    def __init__(self, alive=True, stdout_payload=b'', stderr_payload=b''):
        self.stdin = _FakePipe()
        self.stdout = _FakePipe(stdout_payload)
        self.stderr = _FakePipe(stderr_payload)
        self._alive = alive
        self.killed = False
        self.waited = 0

    def poll(self):
        return None if self._alive else 0

    def wait(self, timeout=None):
        self.waited += 1
        return 0

    def kill(self):
        self.killed = True
        self._alive = False


def _bridge_with_proc(proc, jar_path='', runner_jar='runner.jar'):
    """构造一个 proc 已被打桩注入的 JarBridge（绕过 _ensure_alive 的 spawn）。"""
    bridge = JarBridge(jar_path or os.path.join(BASE, 'fake.jar'), runner_jar=runner_jar)
    bridge.proc = proc
    bridge._destroyed = False
    bridge._crash_count = 0
    return bridge


def _new_bridge(jar_path='', runner_jar='runner.jar'):
    return JarBridge(jar_path or os.path.join(BASE, 'fake.jar'), runner_jar=runner_jar)


class FakeJVM(_FakeProc):
    """把请求帧翻译成应答帧的假 JVM（纯内存，绝不派生真实进程）。

    ``responder(frame)`` 返回应答的**业务部分**（如 ``{'result': ...}`` /
    ``{'proxy': ...}`` / ``{'error': {...}}``），由 drain() 补上 id 后喂回
    ``bridge._on_line``。返回非 dict 时按 result 原样交付。
    """

    def __init__(self, responder=None, alive=True):
        super().__init__(alive=alive)
        self.responder = responder or (lambda frame: {'result': ''})
        self.requests = []
        self.raw_requests = []
        self.responses = []

    def drain(self):
        """取出自上次 drain 以来写出的请求帧（并清空写缓冲）。"""
        raw = bytes(self.stdin.written)
        self.stdin.written.clear()
        frames = []
        for line in raw.splitlines(keepends=True):
            if not line.strip():
                continue
            self.raw_requests.append(line)          # 保留原始字节含换行符
            frames.append(json.loads(line.decode('utf-8')))
        self.requests.extend(frames)
        return frames


def _frame_of(bridge):
    """取最后一次写出的请求帧（dict）。"""
    raw = bytes(bridge.proc.stdin.written).decode('utf-8')
    return json.loads(raw.splitlines()[-1])


_JUGGLE_BRIDGES = []


def _clear_juggle():
    """清空 juggle 注册表（每个用到它的用例都要在 finally 里调用）。"""
    _JUGGLE_BRIDGES.clear()


def _install_juggling_wait():
    """把 Event.wait 换成「交错驱动」：等待期间把写出的请求帧喂回 _on_line。

    真实桥是单线程写 stdin 后阻塞等 stdout；这里在 wait 的那一刻（同一线程）
    把已经写出的帧翻译成应答帧并直接交给 ``bridge._on_line``，既保持真实代码
    路径（写帧 → 等 → 解析应答 → 返回），又不需要真实子进程与 sleep。
    deadline 已过（超时分支）不会走到 wait，超时语义保持不变。
    """
    real_wait = threading.Event.wait

    def juggle(self, timeout=None):
        if real_wait(self, 0):
            return True
        for bridge in list(_JUGGLE_BRIDGES):
            proc = getattr(bridge, 'proc', None)
            if not isinstance(proc, FakeJVM):
                continue
            for frame in proc.drain():
                payload = proc.responder(frame)
                reply = dict(payload) if isinstance(payload, dict) else {'result': payload}
                response = {'id': frame.get('id'), **reply}
                proc.responses.append(response)
                bridge._on_line(json.dumps(response).encode('utf-8'))
        return real_wait(self, 0)

    return mock.patch.object(threading.Event, 'wait', juggle)


def _echo_bridge(responder=None, jar_path='', runner_jar='runner.jar'):
    """构造一个接了 FakeJVM 的桥：call 会走完整的写帧 → 应答 → 返回流程。"""
    bridge = JarBridge(jar_path or os.path.join(BASE, 'fake.jar'), runner_jar=runner_jar)
    bridge.proc = FakeJVM(responder)
    bridge._destroyed = False
    bridge._crash_count = 0
    bridge._ensure_alive = lambda: True
    _JUGGLE_BRIDGES.append(bridge)
    return bridge


def _roundtrip(bridge, method, *args, **kwargs):
    """驱动一次完整往返，返回 (请求帧, 应答值)。"""
    with _install_juggling_wait():
        value = bridge._call_inner(method, *args, **kwargs)
    return bridge.proc.requests[-1], value


def _write_frame(bridge, method, *args, **kwargs):
    """只驱动请求帧序列化（走真实往返），返回请求帧。"""
    frame, _value = _roundtrip(bridge, method, *args, **kwargs)
    return frame


def _drive_proxy(bridge, return_descriptor=False, params=None):
    """驱动 _call_proxy_inner 完成一次真实往返（应答由 bridge 的 FakeJVM 生成）。"""
    with _install_juggling_wait():
        return bridge._call_proxy_inner(
            params or {}, class_name='csp_X', return_descriptor=return_descriptor,
            deadline=time.monotonic() + 5)


def _drive(bridge, method, *args, **kwargs):
    """驱动 bridge.call(...)（含 _call_lock 排队）完成一次往返。"""
    with _install_juggling_wait():
        return bridge.call(method, *args, **kwargs)


def _touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'fake java')
    return path


def _rmtree(path):
    shutil.rmtree(path, ignore_errors=True)


def _utf8_const(text):
    """构造一个 CONSTANT_Utf8 条目字节（tag=1 + u2 长度 + UTF-8 内容）。"""
    raw = text.encode('utf-8')
    return b'\x01' + len(raw).to_bytes(2, 'big') + raw


# ============================================================================
# 第一节：协议帧 — 请求序列化
# ============================================================================

def test_request_frame_shape_and_newline_terminator():
    """请求帧必须是单行 JSON + '\\n'，且带 id/method/params 三个业务键。"""
    bridge = _echo_bridge()
    try:
        frame = _write_frame(bridge, 'manualVideoCheck')
        raw = bridge.proc.raw_requests[-1]
        assert raw.endswith(b'\n'), '请求帧必须以换行结束'
        assert raw.count(b'\n') == 1, '单帧只能有一个换行：%r' % raw
        assert set(frame) == {'id', 'method', 'params', 'requestId',
                              'playSessionId'}, sorted(frame)
        assert frame['method'] == 'manualVideoCheck'
        assert frame['params'] == {}
        assert isinstance(frame['id'], int)
        assert frame['requestId'] == '' and frame['playSessionId'] == ''
    finally:
        _clear_juggle()


def test_request_frame_is_line_delimited_not_length_prefixed():
    """协议是换行分隔而非长度前缀：帧内嵌 '\\n' 的 JSON 字符串必须被转义。"""
    bridge = _echo_bridge()
    try:
        frame = _write_frame(bridge, 'init', 'line1\nline2')
        raw = bridge.proc.raw_requests[-1]
        assert b'\\n' in raw, '内嵌换行必须转义为 \\n'
        assert raw.count(b'\n') == 1, '转义后帧仍只有一个物理换行'
        assert frame['params']['ext'] == 'line1\nline2'
    finally:
        _clear_juggle()


def test_request_frame_keeps_unicode_unescaped():
    """ensure_ascii=False：中文/emoji 原样落帧（UTF-8 编码），不做 \\uXXXX 转义。"""
    bridge = _echo_bridge()
    try:
        frame = _write_frame(bridge, 'searchContent', '海贼王\U0001f525')
        raw = bridge.proc.raw_requests[-1].decode('utf-8')
        assert '海贼王\U0001f525' in raw, 'Unicode 必须原样出现在帧内'
        assert '\\u' not in raw, '不应出现 \\u 转义'
        assert frame['params']['key'] == '海贼王\U0001f525'
    finally:
        _clear_juggle()


def test_request_frame_unicode_keys_and_nested_structures():
    """参数的 Unicode 键名与嵌套 dict/list 必须完整保留（dict 原样透传）。"""
    bridge = _echo_bridge()
    try:
        nested = {'中文键': {'内层': [1, 2, {'x': None}]}, 'ok': True}
        frame = _write_frame(bridge, 'categoryContent', 't1', '2', True, nested)
        params = frame['params']
        assert params['tid'] == 't1' and params['pg'] == '2' and params['filter'] is True
        assert params['extend'] == nested, 'extend 必须原样透传嵌套结构'
        assert params['extend']['中文键']['内层'][2] == {'x': None}
    finally:
        _clear_juggle()


def test_request_frame_boundary_characters_survive_roundtrip():
    """边界符：引号/反斜杠/CRLF/制表/NUL/等号与 & 都要无损往返。"""
    bridge = _echo_bridge()
    try:
        nasty = 'a"b\\c\r\nd\te=&% \x00end'
        frame = _write_frame(bridge, 'init', nasty)
        raw = bridge.proc.raw_requests[-1]
        assert frame['params']['ext'] == nasty, '边界字符必须无损往返'
        assert raw.count(b'\n') == 1, 'CRLF 不得引入额外帧分隔符'
        assert b'\x00' not in raw, 'NUL 必须被 JSON 转义，不得裸写进帧'
    finally:
        _clear_juggle()


def test_request_frame_empty_params_for_zero_arg_methods():
    """无参方法（manualVideoCheck / destroy）序列化出空 params map，且 id 递增。"""
    bridge = _bridge_with_proc(_FakeProc())
    bridge._ensure_alive = lambda: True
    bridge.proc.stdin.written.clear()

    def fake_wait(_self, timeout=None):
        with bridge._lock:
            pend = list(bridge._pending.values())
        for resolve, _reject in pend:
            resolve('')
        return True

    with mock.patch.object(threading.Event, 'wait', fake_wait):
        bridge._call_inner('manualVideoCheck')
        bridge._call_inner('destroy')
    raw = bytes(bridge.proc.stdin.written).decode('utf-8')
    frames = [json.loads(line) for line in raw.splitlines()]
    assert [f['method'] for f in frames] == ['manualVideoCheck', 'destroy']
    assert all(f['params'] == {} for f in frames), '无参方法 params 必须是空 map'
    assert frames[0]['id'] != frames[1]['id'], '每次调用必须取新 id'


def test_request_id_is_monotonic_and_unique():
    """_next_id 自增：多次调用不重复、单调递增。"""
    before = jar_bridge._id_counter
    got = [jar_bridge._next_id() for _ in range(50)]
    assert len(set(got)) == 50, 'id 必须唯一'
    assert got == sorted(got), 'id 必须单调递增'
    assert jar_bridge._id_counter == before + 50


def test_action_name_dispatch_rejects_unknown_method():
    """未知动作名在写帧之前就抛 ValueError，绝不向 JVM 写任何字节。"""
    bridge = _bridge_with_proc(_FakeProc())
    bridge._ensure_alive = lambda: True
    try:
        bridge._call_inner('noSuchMethod', 'x')
    except ValueError as e:
        assert 'unknown jar method' in str(e), str(e)
    else:
        assert False, '未知方法必须抛 ValueError'
    assert bytes(bridge.proc.stdin.written) == b'', '失败前不得写 stdin'


def test_proxy_request_frame_marks_static_proxy():
    """call_proxy 帧必须置 __static_proxy=True（静态 Proxy 与实例 proxy 的分界）。"""
    bridge = _bridge_with_proc(_FakeProc())
    proc = bridge.proc  # 超时路径会 _kill_proc 置空 proc，这里用本地引用读回帧
    bridge._ensure_alive = lambda: True
    try:
        with mock.patch.object(threading.Event, 'wait', lambda _s, _t=None: False):
            bridge._call_proxy_inner({'do': 'pan'}, class_name='csp_X',
                                     deadline=time.monotonic() - 1)
    except TimeoutError:
        pass
    frame = json.loads(bytes(proc.stdin.written).decode('utf-8')[:-1])
    assert frame['method'] == 'proxy'
    assert frame['params']['__static_proxy'] is True
    assert frame['params']['class_name'] == 'csp_X'
    assert frame['params']['do'] == 'pan'


def test_proxy_request_frame_uses_default_str_for_unknown_types():
    """proxy 帧用 default=str 兜底不可序列化对象（普通 call 帧会直接抛 TypeError）。"""
    bridge = _bridge_with_proc(_FakeProc())
    proc = bridge.proc
    bridge._ensure_alive = lambda: True
    try:
        with mock.patch.object(threading.Event, 'wait', lambda _s, _t=None: False):
            bridge._call_proxy_inner({'obj': object()}, deadline=time.monotonic() - 1)
    except TimeoutError:
        pass
    frame = json.loads(bytes(proc.stdin.written).decode('utf-8')[:-1])
    assert isinstance(frame['params']['obj'], str), '未知类型必须被 default=str 兜底'

    # 对照：普通 call 帧没有 default=str，非序列化参数会直接抛错
    bridge2 = _bridge_with_proc(_FakeProc())
    bridge2._ensure_alive = lambda: True
    try:
        bridge2._call_inner('categoryContent', 't', '1', False, {'bad': object()})
    except TypeError:
        pass
    else:
        assert False, '普通 call 帧不得静默吞掉不可序列化参数'


# ============================================================================
# 第二节：参数类型转换 Python → params map
# ============================================================================

def test_param_mapping_init_casts_to_str():
    """init：任意入参一律 str()（TVBox 约定空配置传空串而非 '{}'）。"""
    bridge = _echo_bridge()
    try:
        for value, expect in ((None, ''), (123, '123'), (True, 'True'), (' raw ', ' raw ')):
            args = [] if value is None else [value]
            assert _write_frame(bridge, 'init', *args)['params']['ext'] == expect, value
        assert _write_frame(bridge, 'init')['params']['ext'] == '', '无参 init 必须是空串'
    finally:
        _clear_juggle()


def test_param_mapping_home_content_casts_to_bool():
    """homeContent：filter 转成真 bool（0 / '' / None / [] 都变 False）。"""
    bridge = _echo_bridge()
    try:
        for value, expect in ((0, False), ('', False), (None, False), ('0', True),
                              ([], False), (9, True)):
            got = _write_frame(bridge, 'homeContent', value)['params']['filter']
            assert got is expect, (value, got)
            assert isinstance(got, bool), '必须是 JSON bool 不是 0/1'
    finally:
        _clear_juggle()


def test_param_mapping_search_content_full_and_missing_args():
    """searchContent：key/quick/pg 全量映射；缺参用 ''/False/'1' 兜底。"""
    bridge = _echo_bridge()
    try:
        full = _write_frame(bridge, 'searchContent', 'k', 1, 7)['params']
        assert full == {'key': 'k', 'quick': True, 'pg': '7'}, full
        short = _write_frame(bridge, 'searchContent', 'only')['params']
        assert short == {'key': 'only', 'quick': False, 'pg': '1'}, short
    finally:
        _clear_juggle()


def test_param_mapping_detail_content_wraps_scalar_into_list():
    """detailContent：list/tuple 转 list；标量包成单元素 list（Java 侧 String[]）。"""
    bridge = _echo_bridge()
    try:
        assert _write_frame(bridge, 'detailContent', ['a', 'b'])['params']['ids'] == ['a', 'b']
        assert _write_frame(bridge, 'detailContent', 'single')['params']['ids'] == ['single']
        assert _write_frame(bridge, 'detailContent', ('t1', 't2'))['params']['ids'] == \
            ['t1', 't2']
        assert _write_frame(bridge, 'detailContent')['params']['ids'] == [], '无参时 ids 为 []'
    finally:
        _clear_juggle()


def test_param_mapping_player_content_vipflags_type_guard():
    """playerContent：vipFlags 非 list/tuple 时退化为 []（不把标量塞成字符）。"""
    bridge = _echo_bridge()
    try:
        ok = _write_frame(bridge, 'playerContent', 'fl', 'id1', ['vip1', 'vip2'])['params']
        assert ok == {'flag': 'fl', 'id': 'id1', 'vipFlags': ['vip1', 'vip2']}, ok
        bad = _write_frame(bridge, 'playerContent', 'fl', 'id1', 'not-a-list')['params']
        assert bad['vipFlags'] == [], bad
        none = _write_frame(bridge, 'playerContent', 'fl', 'id1', None)['params']
        assert none['vipFlags'] == [], none
    finally:
        _clear_juggle()


def test_param_mapping_category_extend_rejects_non_dict():
    """categoryContent：extend 非 dict（含 None/str/list/int）一律降级为 {}。"""
    bridge = _echo_bridge()
    try:
        for bad in (None, 'raw', ['a'], 42):
            got = _write_frame(bridge, 'categoryContent', 't', '1', False, bad)['params']
            assert got['extend'] == {}, (bad, got)
    finally:
        _clear_juggle()


def test_param_mapping_json_ext_and_proxy_stringify():
    """__json_ext 的 jxs 非 dict 降级 {}；proxy 的 param 一律 str()。"""
    bridge = _echo_bridge()
    try:
        got = _write_frame(bridge, '__json_ext', 'k', {'a': 1}, 'http://u')['params']
        assert got == {'key': 'k', 'jxs': {'a': 1}, 'url': 'http://u'}, got
        assert _write_frame(bridge, '__json_ext', 'k', 'not-dict')['params']['jxs'] == {}
        assert _write_frame(bridge, 'proxy', {'a': 1})['params']['param'] == "{'a': 1}"
        assert _write_frame(bridge, 'proxy')['params']['param'] == '{}', \
            '无参 proxy 用 {} 兜底'
    finally:
        _clear_juggle()


def test_param_mapping_live_action_isvideo_arg0_slots():
    """liveContent→url / action→action / isVideoFormat→arg0 三个显式槽位映射。"""
    bridge = _echo_bridge()
    try:
        assert _write_frame(bridge, 'liveContent', 'http://live/x.m3u8')['params'] == \
            {'url': 'http://live/x.m3u8'}
        assert _write_frame(bridge, 'action', '{"do":"x"}')['params'] == \
            {'action': '{"do":"x"}'}
        assert _write_frame(bridge, 'isVideoFormat', 'http://v/1.mp4')['params'] == \
            {'arg0': 'http://v/1.mp4'}
        assert _write_frame(bridge, 'isVideoFormat')['params'] == {'arg0': ''}
    finally:
        _clear_juggle()


def test_param_injection_class_name_and_pan_cookies():
    """class_name / pan_cookies 注入：真值才写，空值不污染 params。"""
    bridge = _echo_bridge()
    try:
        clean = _write_frame(bridge, 'manualVideoCheck', class_name='',
                             pan_cookies=None)['params']
        assert clean == {}, '空 class_name/pan_cookies 不得写入'
        got = _write_frame(bridge, 'manualVideoCheck', class_name='csp_Q',
                           pan_cookies={'quark': 'ck=1'})['params']
        assert got == {'class_name': 'csp_Q', 'pan_cookies': {'quark': 'ck=1'}}, got
    finally:
        _clear_juggle()


def test_home_video_content_and_category_defaults():
    """homeVideoContent 的 pg 默认 '1'；categoryContent 缺参兜底 tid='' pg='1'。"""
    bridge = _echo_bridge()
    try:
        assert _write_frame(bridge, 'homeVideoContent')['params'] == {'pg': '1'}
        assert _write_frame(bridge, 'homeVideoContent', 3)['params'] == {'pg': '3'}
        assert _write_frame(bridge, 'categoryContent')['params'] == \
            {'tid': '', 'pg': '1', 'filter': False, 'extend': {}}
    finally:
        _clear_juggle()


# ============================================================================
# 第三节：协议帧 — 响应解析（_on_line / _read_loop）
# ============================================================================

def _pending_bridge():
    bridge = _new_bridge()
    fired = []

    def resolve(v):
        fired.append(('resolve', v))

    def reject(e):
        fired.append(('reject', e))

    bridge._pending = {7: (resolve, reject)}
    return bridge, fired


def test_response_parse_normal_result_frame():
    """正常结果帧：取 result 字段交给 resolve，并摘除 pending。"""
    bridge, fired = _pending_bridge()
    bridge._on_line(json.dumps({'id': 7, 'result': '{"list":[]}'}).encode('utf-8'))
    assert fired == [('resolve', '{"list":[]}')], fired
    assert bridge._pending == {}, '应答后必须摘除 pending'


def test_response_parse_result_defaults_to_empty_string():
    """结果帧缺 result 字段：resolve 收到 ''（不得 KeyError）。"""
    bridge, fired = _pending_bridge()
    bridge._on_line(json.dumps({'id': 7}).encode('utf-8'))
    assert fired == [('resolve', '')], fired


def test_response_parse_proxy_frame_is_resolved_whole():
    """proxy 帧特殊：整条 msg 交给 resolve（控制帧含 socket 描述符）。"""
    bridge, fired = _pending_bridge()
    msg = {'id': 7, 'proxy': {'status': 200, 'mime': 'video/mp4', 'body': ''}}
    bridge._on_line(json.dumps(msg).encode('utf-8'))
    assert len(fired) == 1 and fired[0][0] == 'resolve'
    assert fired[0][1]['proxy']['status'] == 200, fired
    assert fired[0][1]['id'] == 7, '整条 msg 交付，id 仍在'


def test_response_parse_error_frame_rejects_with_message():
    """错误帧：reject(RuntimeError(error.message))；缺 message 时回落 'jar error'。"""
    bridge, fired = _pending_bridge()
    bridge._on_line(json.dumps({'id': 7, 'error': {'message': 'boom'}}).encode('utf-8'))
    assert fired[0][0] == 'reject' and str(fired[0][1]) == 'boom', fired

    bridge2, fired2 = _pending_bridge()
    bridge2._on_line(json.dumps({'id': 7, 'error': {}}).encode('utf-8'))
    assert str(fired2[0][1]) == 'jar error', fired2

    bridge3, fired3 = _pending_bridge()
    bridge3._on_line(json.dumps({'id': 7, 'error': {'message': 404}}).encode('utf-8'))
    assert str(fired3[0][1]) == '404', '非字符串 message 也要 str() 化'


def test_response_parse_ignores_illegal_json_and_empty_lines():
    """非法 JSON / 空行 / 纯空白行一律忽略，且不摘除 pending（半包语义）。

    注意：`[]` 是合法 JSON，但缺 id → 走「无 id 丢弃」分支而非「非法 JSON」。
    """
    for payload in (b'not json at all', b'', b'   \n', b'{broken', b'\n', b'{"a":'):
        bridge, fired = _pending_bridge()
        bridge._on_line(payload)
        assert fired == [], (payload, fired)
        assert 7 in bridge._pending, '非法帧不得误清 pending'


def test_response_parse_rejects_non_object_frames():
    """顶层非 dict 的帧（数组/标量）被静默丢弃 —— A2 修复钉。

    A2 修复前：`_on_line` 的 except 只收 ValueError/UnicodeDecodeError
    （jar_bridge.py:1050），AttributeError 不在其中，非 dict 帧会向上冒泡；
    若异常发生在真实 _read_loop 线程内，读线程会跳出 while 循环死亡、
    pending 调用被 finally 里的 _reject_all('jar process exited') 误拒。
    修复后：isinstance(dict) 校验让非法帧静默跳过（与 ValueError 兜底口径一致），
    不再冒泡 AttributeError。
    """
    bridge, fired = _pending_bridge()
    for payload in (b'[1,2,3]', b'"just a string"', b'42', b'null', b'true'):
        # 不抛异常即为修复生效
        bridge._on_line(payload)
    assert fired == [], fired
    assert 7 in bridge._pending, '非法帧不得误清 pending'


def test_response_parse_unknown_id_is_dropped():
    """未知 id 的应答帧被丢弃（旧 JVM 的迟到响应不得串到新请求上）。"""
    bridge, fired = _pending_bridge()
    bridge._on_line(json.dumps({'id': 999, 'result': 'x'}).encode('utf-8'))
    assert fired == [], fired
    assert 7 in bridge._pending


def test_response_parse_missing_id_is_dropped():
    """无 id 的帧（如 JVM 日志行恰为合法 JSON）被丢弃。"""
    bridge, fired = _pending_bridge()
    bridge._on_line(json.dumps({'result': 'x'}).encode('utf-8'))
    bridge._on_line(json.dumps({}).encode('utf-8'))
    bridge._on_line(json.dumps({'id': None, 'result': 'x'}).encode('utf-8'))
    assert fired == [], fired


def test_response_parse_tolerates_surrounding_whitespace_and_crlf():
    """帧前后空白 / CRLF 结尾不影响解析（strip 后 json.loads）。"""
    bridge, fired = _pending_bridge()
    bridge._on_line(b'  ' + json.dumps({'id': 7, 'result': 'ok'}).encode('utf-8') + b'\r\n  ')
    assert fired == [('resolve', 'ok')], fired


def test_response_parse_very_long_frame():
    """超长帧（1MB 级 result）必须完整解析，不被截断。"""
    bridge, fired = _pending_bridge()
    big = 'x' * (1 << 20)
    bridge._on_line(json.dumps({'id': 7, 'result': big}).encode('utf-8'))
    assert len(fired) == 1 and fired[0][1] == big, '超长帧必须完整送达'


def test_response_parse_utf8_and_broken_bytes():
    """UTF-8 中文结果正常解析；坏字节按 replace 解码后 JSON 失败 → 忽略。"""
    bridge, fired = _pending_bridge()
    bridge._on_line(json.dumps({'id': 7, 'result': '海贼王'},
                               ensure_ascii=False).encode('utf-8'))
    assert fired == [('resolve', '海贼王')], fired

    # 非法 UTF-8：按 errors='replace' 解码（U+FFFD），JSON 仍成立 → 带替换字符应答。
    # 即「坏字节不丢包」，而是把不可解码字节替换掉——真实 jar 回中文日志时
    # 偶发截断也走这条路径，不会静默丢掉整条应答。
    bridge2, fired2 = _pending_bridge()
    bridge2._on_line(b'{"id":7,"result":"\xff\xfe-bad"}\n')
    assert len(fired2) == 1 and fired2[0][0] == 'resolve', fired2
    assert '\ufffd' in fired2[0][1], '不可解码字节应替换为 U+FFFD：%r' % (fired2[0][1],)

    # 坏字节落在键名里：replace 后仍是合法 JSON → 按「未知键 + 无 result」应答 ''
    bridge3, fired3 = _pending_bridge()
    bridge3._on_line(b'{"id":7,"resu\xfflt":1}\n')
    assert fired3 == [('resolve', '')], fired3

    # JSON 转义的孤立代理项 \udcff：json.loads 接受，原样交付（不抛、不丢）
    bridge4, fired4 = _pending_bridge()
    bridge4._on_line(b'{"id":7,"result":"\\udcff"}')
    assert fired4 == [('resolve', '\udcff')], fired4


def test_read_loop_half_packet_is_not_delivered():
    """半包：readline 拿到不带换行的残缺行 → 解析失败被忽略，pending 保留。

    注意 `_read_loop` 收尾（进程退出）会 reject pending，所以这里断言「没有任何
    resolve 交付」，而不是「没有任何回调」。
    """
    proc = _FakeProc(stdout_payload=b'{"id":7,"resu')
    bridge = _bridge_with_proc(proc)
    fired = []
    bridge._pending[7] = (lambda v: fired.append(('resolve', v)),
                          lambda e: fired.append(('reject', str(e))))
    bridge._read_loop()
    assert not any(kind == 'resolve' for kind, _v in fired), '半包不得交付结果：%s' % fired
    assert any('jar process exited' in text for kind, text in fired if kind == 'reject'), fired


def test_read_loop_multiple_frames_in_one_stream():
    """多行流（粘包场景）：每行独立交付，空行与错误帧各行其是。"""
    lines = [
        json.dumps({'id': 1, 'result': 'a'}).encode('utf-8'),
        json.dumps({'id': 2, 'error': {'message': 'bad'}}).encode('utf-8'),
        b'',
        json.dumps({'id': 3, 'result': 'c'}).encode('utf-8'),
    ]
    proc = _FakeProc(stdout_payload=b'\n'.join(lines) + b'\n')
    bridge = _bridge_with_proc(proc)
    out = {}
    bridge._pending = {
        1: (lambda v: out.__setitem__(1, v), lambda e: None),
        2: (lambda v: None, lambda e: out.__setitem__(2, str(e))),
        3: (lambda v: out.__setitem__(3, v), lambda e: None),
    }
    bridge._read_loop()
    assert out == {1: 'a', 2: 'bad', 3: 'c'}, out


def test_read_loop_rejects_pending_when_process_exits():
    """进程退出：_read_loop 收尾把剩余 pending 全部 reject（不让调用方永久挂起）。"""
    proc = _FakeProc(stdout_payload=b'')
    bridge = _bridge_with_proc(proc)
    fired = []
    bridge._pending[5] = (lambda v: None, lambda e: fired.append(str(e)))
    bridge._read_loop()
    assert fired and 'jar process exited' in fired[0], fired
    assert bridge._pending == {}


def test_reject_all_clears_pending_and_rejects_each():
    """_reject_all：清空 _pending 并逐个 reject（destroy / 强杀路径）。"""
    bridge = _new_bridge()
    fired = []
    for i in (1, 2, 3):
        bridge._pending[i] = (lambda v: None,
                              (lambda idx: lambda e: fired.append(idx))(i))
    bridge._reject_all(RuntimeError('bye'))
    assert sorted(fired) == [1, 2, 3], fired
    assert bridge._pending == {}


# ============================================================================
# 第四节：结果映射 — Java 返回结构 → 内部模型
# ============================================================================

def test_proxy_result_descriptor_mapping():
    """控制帧 → 描述符：status/mime/headers/stream/body 逐字段归一。"""
    info = {
        'status': 206,
        'mime': 'video/mp4',
        'headers': {'Range': 'bytes=0-1', 'X-Null': None},
        'stream': {'host': '127.0.0.1', 'port': 45001, 'token': 'tk-1'},
        'body': '',
    }
    bridge = _echo_bridge(responder=lambda frame: {'proxy': info})
    try:
        got = _drive_proxy(bridge, return_descriptor=True)
        assert got['__yuki_proxy__'] is True
        assert got['status'] == 206 and got['mime'] == 'video/mp4'
        assert got['headers'] == {'Range': 'bytes=0-1'}, 'None 值响应头必须剔除'
        assert got['stream'] == {'host': '127.0.0.1', 'port': 45001, 'token': 'tk-1'}
        assert got['body'] == ''
    finally:
        _clear_juggle()


def test_proxy_result_defaults_for_missing_fields():
    """proxy 帧缺字段：status→200、mime→octet-stream、headers→{}、stream→None。"""
    bridge = _echo_bridge(responder=lambda frame: {'proxy': {}})
    try:
        got = _drive_proxy(bridge, return_descriptor=True)
        assert got['status'] == 200 and got['mime'] == 'application/octet-stream'
        assert got['headers'] == {} and got['stream'] is None and got['body'] == ''
    finally:
        _clear_juggle()

    bridge2 = _echo_bridge(responder=lambda frame: {'proxy': {'status': 0,
                                                              'stream': 'bad'}})
    try:
        got2 = _drive_proxy(bridge2, return_descriptor=True)
        assert got2['status'] == 200, 'status=0 视为无效 → 回落 200'
        assert got2['stream'] is None, '非 dict 的 stream 必须丢弃'
    finally:
        _clear_juggle()


def test_proxy_result_base64_body_decoded_to_bytes():
    """无 stream 时 body 是 base64：必须解码为 bytes（ProxyResult.body）。"""
    payload = b'\x00\x01binary-video-bytes'
    bridge = _echo_bridge(responder=lambda frame: {
        'proxy': {'status': 200, 'body': base64.b64encode(payload).decode('ascii')}})
    try:
        got = _drive_proxy(bridge, return_descriptor=False)
        assert isinstance(got, ProxyResult)
        assert got.body == payload
        assert got.status == 200
        assert got.mime == 'application/octet-stream', '缺 mime 时回落默认'
        assert got.close is None, '无 stream 时不需要关闭回调'
    finally:
        _clear_juggle()


def test_proxy_result_invalid_response_rejected():
    """非 dict / 缺 proxy 字段的应答 → RuntimeError('invalid static proxy response')。"""
    for bad in ('plain string', {'result': 'x'}, {'proxy': 'not-a-dict'}, None, 42):
        bridge = _echo_bridge(responder=lambda frame, _bad=bad: _bad)
        try:
            _drive_proxy(bridge, return_descriptor=False)
        except RuntimeError as e:
            assert 'invalid static proxy response' in str(e), (bad, str(e))
        else:
            assert False, '畸形 proxy 应答必须被拒：%r' % (bad,)
        finally:
            _clear_juggle()


def test_proxy_result_stream_requires_port_and_token():
    """stream 描述符完整才建数据 socket；缺 token 退化为 base64 body 通道。"""
    fake_sock = mock.Mock()
    fake_sock.makefile.return_value = io.BytesIO(b'video-bytes')
    bridge = _echo_bridge(responder=lambda frame: {
        'proxy': {'status': 200, 'mime': 'video/mp4',
                  'stream': {'port': 45002, 'token': 'tk'}}})
    try:
        with mock.patch.object(jar_bridge.socket, 'create_connection',
                               return_value=fake_sock) as conn:
            got = _drive_proxy(bridge, return_descriptor=False)
        assert conn.called, '完整描述符必须建立数据 socket'
        assert isinstance(got.body, jar_bridge.JarProxyBody)
        assert got.close is not None
        assert got.headers == {}
        got.close()
        assert got.body.closed is True, '关闭回调必须释放数据 socket'
    finally:
        _clear_juggle()

    payload = b'abc'
    bridge2 = _echo_bridge(responder=lambda frame: {
        'proxy': {'status': 200, 'stream': {'port': 45003},
                  'body': base64.b64encode(payload).decode('ascii')}})
    try:
        with mock.patch.object(jar_bridge.socket, 'create_connection',
                               side_effect=AssertionError('must not connect')):
            got2 = _drive_proxy(bridge2, return_descriptor=False)
        assert got2.body == payload, '不完整描述符必须走 base64 通道'
    finally:
        _clear_juggle()


def test_spider_json_mapping_passthrough_and_fallback():
    """JarSpider._json：dict/list 原样返回；坏 JSON/None/非容器回落 default。"""
    assert JarSpider._json({'list': []}) == {'list': []}
    assert JarSpider._json([1, 2]) == [1, 2]
    assert JarSpider._json('{"a":1}') == {'a': 1}
    assert JarSpider._json('not-json', {'list': []}) == {'list': []}
    assert JarSpider._json(None, {'list': []}) == {'list': []}
    assert JarSpider._json(None) is None
    assert JarSpider._json(123, 'd') == 'd', '非 str/非容器类型同样回落 default'


def test_spider_truthy_mapping():
    """JarSpider._truthy：Java 侧可能回 '1'/'true'/'TRUE'/bool/None。"""
    assert JarSpider._truthy(True) is True and JarSpider._truthy(False) is False
    assert JarSpider._truthy(None) is False
    assert JarSpider._truthy('1') is True and JarSpider._truthy('true') is True
    assert JarSpider._truthy('TRUE') is True and JarSpider._truthy('Yes') is True
    assert JarSpider._truthy('0') is False and JarSpider._truthy('') is False
    assert JarSpider._truthy(1) is True, '整数 1 也按真处理'


def test_result_mapping_missing_fields_use_defaults():
    """detail/search 结果缺字段时，适配层返回 default 结构而不是崩。"""
    class B:
        def call(self, method, *args, class_name='', pan_cookies=None):
            return {'detailContent': '{"list":[{}]}', 'searchContent': '{}'}.get(method)

    spider = JarSpider.__new__(JarSpider)
    spider.bridge = B()
    spider.class_name = 'csp_X'
    spider._inited = True
    spider.site_key = 'k'
    assert spider.detailContent(['1'])['list'] == [{}], '缺字段的条目原样保留'
    assert spider.searchContent('k', False) == {}, '缺 list 字段时返回空 dict'
    assert spider.homeContent(True) == {}, '桥返回 None 时回落 {}'


def test_result_mapping_empty_list_is_preserved():
    """空列表结果是合法业务结果，不能被当成失败替换成 default。"""
    class B:
        def call(self, method, *args, class_name='', pan_cookies=None):
            return '{"list":[],"class":[]}'

    spider = JarSpider.__new__(JarSpider)
    spider.bridge = B()
    spider._inited = True
    spider.site_key = 'k'
    assert spider.homeContent(True) == {'list': [], 'class': []}
    assert spider.searchContent('k', False, '1') == {'list': [], 'class': []}


def test_result_mapping_player_content_null_result():
    """playerContent 返回 JSON null：回落 {'url': id, 'parse': 1} 并写 last_error。"""
    class B:
        def call(self, method, *args, class_name='', pan_cookies=None):
            return 'null'

    spider = JarSpider.__new__(JarSpider)
    spider.bridge = B()
    spider._inited = True
    spider.site_key = 'k'
    spider.last_error = ''
    got = spider.playerContent('flag', 'vod-1', [])
    assert got['url'] == 'vod-1' and got['parse'] == 1, got
    assert 'Cookie' in spider.last_error or '分享' in spider.last_error, spider.last_error


def test_result_mapping_player_content_stale_url_replaced():
    """裸夸克 CDN 直链被替换为 do=pan（PC 侧解得开时），并清掉上一次 JAR 错误。"""
    class B:
        def call(self, method, *args, class_name='', pan_cookies=None):
            return json.dumps({'url': 'https://abc.quark.cn/1.m3u8?sign=x', 'parse': 0})

    spider = JarSpider.__new__(JarSpider)
    spider.bridge = B()
    spider._inited = True
    spider.site_key = 'k'
    spider.last_error = 'previous error'
    with mock.patch.object(hoststate, 'get_pan_fast_path', return_value=False):
        with mock.patch.object(hoststate, 'get_token', return_value='tk'):
            got = spider.playerContent(
                '1080', 'https://pan.quark.cn/s/abcd1234efgh', [])
    assert 'do=pan' in got['url'] and 'site=quark' in got['url'], got
    assert got['parse'] == 0
    assert spider.last_error == '', '有效兜底必须清掉上一次 JAR 错误'


def test_result_mapping_player_content_unresolvable_keeps_jar_url():
    """PC 侧解不开（无 pwdId/shareUrl）时保留 JAR 直链，只包一层本地取流通道。"""
    class B:
        def call(self, method, *args, class_name='', pan_cookies=None):
            return json.dumps({'url': 'https://x.myquark.cn/live.m3u8', 'parse': 0})

    spider = JarSpider.__new__(JarSpider)
    spider.bridge = B()
    spider._inited = True
    spider.site_key = 'k'
    vid = ('a' * 32 + '++' + 'b' * 32 + '++' + '0' * 32
           + '++' + 'tok' + '++' + '12345')
    with mock.patch('go_proxy.ensure_listener', return_value=False):
        got = spider.playerContent('f', vid, [])
    assert 'proxytype=go' in got['url'] and 'url=' in got['url'], got
    assert 'do=pan' not in got['url'], '解不开时不得替换为必然 502 的 do=pan'


# ============================================================================
# 第五节：jar_patch — 补丁匹配与注入
# ============================================================================

def _class_file(entries):
    """构造最小 class 字节流。entries: (tag, payload)；long/double 占 2 槽。"""
    def u2(v):
        return int(v).to_bytes(2, 'big')

    body = b''
    slot = 1
    for tag, payload in entries:
        if tag == 1:
            body += b'\x01' + u2(len(payload)) + payload
        else:
            body += bytes([tag]) + payload
        slot += 2 if tag in (5, 6) else 1
    return b'\xca\xfe\xba\xbe' + b'\x00\x00' + b'\x00\x00' + u2(slot) + body


def test_patch_utf8_single_hit_updates_length_and_content():
    """命中一次：长度前缀与内容同步改写，替换次数为 1。"""
    data = b'\xca\xfe\xba\xbe' + _utf8_const('abc') + _utf8_const('xyz')
    out, cnt = jar_patch.patch_utf8_constant(data, 'abc', 'HELLO')
    assert cnt == 1, cnt
    assert _utf8_const('HELLO') in out, out
    assert b'abc' not in out, '旧字面量必须消失'
    assert out.endswith(_utf8_const('xyz')), '无关条目不得被改写'


def test_patch_utf8_multiple_hits_and_idempotent_repeat():
    """多处命中一次改完；重复打同一补丁不再命中（幂等，不叠加）。"""
    data = _utf8_const('abc') * 3
    out, cnt = jar_patch.patch_utf8_constant(data, 'abc', 'A')
    assert cnt == 3, cnt
    assert out.count(_utf8_const('A')) == 3, out

    out2, cnt2 = jar_patch.patch_utf8_constant(out, 'abc', 'A')
    assert cnt2 == 0 and out2 == out, '重复打补丁必须幂等'

    out3, cnt3 = jar_patch.patch_utf8_constant(data, 'abc', 'LONGER-VALUE')
    assert cnt3 == 3 and out3.count(_utf8_const('LONGER-VALUE')) == 3, out3


def test_patch_utf8_no_hit_returns_identical_bytes():
    """未命中：返回原字节且计数 0（不得破坏原文件）。"""
    data = b'\xca\xfe\xba\xbe' + _utf8_const('abc')
    out, cnt = jar_patch.patch_utf8_constant(data, 'zzz', 'q')
    assert cnt == 0 and out == data, (cnt, out)


def test_patch_utf8_unicode_and_boundary_length():
    """Unicode 常量（中文选择器）按 UTF-8 字节长度改写；空值/超长被拒。"""
    data = _utf8_const('#导航')
    out, cnt = jar_patch.patch_utf8_constant(data, '#导航', '.nav-m')
    assert cnt == 1, cnt
    assert _utf8_const('.nav-m') in out, out
    assert len(out) == len(data) - len('#导航'.encode()) + len('.nav-m'.encode()), out

    for bad_old, bad_new in (('', 'x'), ('x', '')):
        try:
            jar_patch.patch_utf8_constant(data, bad_old, bad_new)
        except ValueError as e:
            assert 'bad patch length' in str(e), str(e)
        else:
            assert False, '空 old/new 必须抛 ValueError'
    try:
        jar_patch.patch_utf8_constant(data, 'x', 'y' * 70000)
    except ValueError:
        pass
    else:
        assert False, '超长新值（>65535）必须抛 ValueError'


def test_patch_utf8_requires_exact_tag_and_length_match():
    """必须同时匹配 tag=1 与长度前缀，避免误改普通字节码里的同内容字节。"""
    wrong_tag = b'\x02' + len('abc').to_bytes(2, 'big') + b'abc'
    out, cnt = jar_patch.patch_utf8_constant(wrong_tag, 'abc', 'zzz')
    assert cnt == 0 and out == wrong_tag
    wrong_len = b'\x01' + (4).to_bytes(2, 'big') + b'abc'
    out2, cnt2 = jar_patch.patch_utf8_constant(wrong_len, 'abc', 'zzz')
    assert cnt2 == 0 and out2 == wrong_len


def test_parse_cp_slot_compensation_for_long_double():
    """常量池槽位：long/double 占 2 槽，其后条目 slot 整体 +1（审查 M-5）。"""
    data = _class_file([
        (1, b'java/lang/Object'),                 # slot 1
        (7, (1).to_bytes(2, 'big')),              # slot 2: Class(Object)
        (5, (1 << 62).to_bytes(8, 'big')),        # slots 3-4: Long
        (1, b'after-long'),                       # slot 5
    ])
    entries, count = jar_patch._parse_cp(data)
    by_slot = jar_patch._cp_by_slot(entries)
    assert 3 in by_slot and by_slot[3][0] == 5, 'long 本体占槽 3'
    assert 4 not in by_slot, 'long 的第二槽不得被当作有效条目'
    assert 5 in by_slot, 'long 之后的 Utf8 必须从槽 5 起'
    assert jar_patch._cp_utf8(data, by_slot[5]) == 'after-long'
    assert count >= 5, count


def test_parse_cp_rejects_truncated_and_tiny_input():
    """数据过短（<10 字节）或截断 / 未知 tag 时安全返回，不抛异常。"""
    assert jar_patch._parse_cp(b'\xca\xfe') == ([], 0)
    entries, count = jar_patch._parse_cp(
        b'\xca\xfe\xba\xbe\x00\x00\x00\x00\x00\x05\x01')
    assert count == 5 and entries == [], (count, entries)
    entries2, _ = jar_patch._parse_cp(_class_file([(1, b'ok'), (99, b'')]))
    assert len(entries2) == 1, '未知 tag 之前解析到的条目应保留'


def test_patch_methodref_redirects_matching_signature_only():
    """Methodref：只有 owner+name+desc 全匹配才重定向；签名不符的不动。"""
    desc = b'(Landroid/content/Context;Ljava/lang/String;)V'
    data = _class_file([
        (1, b'com/github/catvod/spider/Pan'), (7, (1).to_bytes(2, 'big')),
        (1, b'init'), (1, desc),
        (12, (3).to_bytes(2, 'big') + (4).to_bytes(2, 'big')),   # slot 5: NAT(init,desc)
        (10, (2).to_bytes(2, 'big') + (5).to_bytes(2, 'big')),   # slot 6: Methodref
        (1, b'other'), (1, b'()V'),
        (12, (7).to_bytes(2, 'big') + (8).to_bytes(2, 'big')),   # slot 9: NAT(other,()V)
        (10, (2).to_bytes(2, 'big') + (9).to_bytes(2, 'big')),   # slot 10: Methodref
        (1, b'com/github/catvod/crawler/Spider'),
        (7, (11).to_bytes(2, 'big')),                            # slot 12: Class(Spider)
    ])
    out, cnt = jar_patch.patch_methodref_class(
        data, 'com/github/catvod/spider/Pan', 'init', desc.decode(),
        'com/github/catvod/crawler/Spider')
    assert cnt == 1, '只应命中 init(Context,String)V 一条'
    by_slot = jar_patch._cp_by_slot(jar_patch._parse_cp(out)[0])
    mref = by_slot[6]
    assert int.from_bytes(out[mref[2]:mref[2] + 2], 'big') == 12, '重定向到 Spider Class 槽'
    mref2 = by_slot[10]
    assert int.from_bytes(out[mref2[2]:mref2[2] + 2], 'big') == 2, 'other()V 不得被改'


def test_patch_methodref_missing_target_or_owner_is_noop():
    """new_owner / owner 不在常量池：原样返回且不计数。"""
    data = _class_file([
        (1, b'com/github/catvod/spider/Pan'), (7, (1).to_bytes(2, 'big')),
        (1, b'init'), (1, b'()V'),
        (12, (3).to_bytes(2, 'big') + (4).to_bytes(2, 'big')),
        (10, (2).to_bytes(2, 'big') + (5).to_bytes(2, 'big')),
    ])
    out, cnt = jar_patch.patch_methodref_class(data, 'com/github/catvod/spider/Pan',
                                               'init', '()V', 'com/example/Nope')
    assert cnt == 0 and out == data
    out2, cnt2 = jar_patch.patch_methodref_class(data, 'com/example/Other', 'init',
                                                 '()V', 'com/github/catvod/spider/Pan')
    assert cnt2 == 0 and out2 == data
    out3, cnt3 = jar_patch.patch_methodref_class(data, 'com/github/catvod/spider/Pan',
                                                 'init', '(I)V',
                                                 'com/github/catvod/spider/Pan')
    assert cnt3 == 0 and out3 == data, '描述符不符不得命中'


def test_validate_zip_entry_name_rejects_traversal():
    """P3-4：'..' 段 / 绝对路径 / 盘符 / 空名一律 ValueError（fail-closed）。"""
    for bad in ('', '../evil.class', 'a/../../b.class', '/abs/path.class',
                '\\unc\\path.class', 'C:\\win\\x.class', 'a\\..\\b.class'):
        try:
            jar_patch._validate_zip_entry_name(bad)
        except ValueError:
            pass
        else:
            assert False, '非法条目名必须被拒：%r' % (bad,)
    for good in ('com/github/catvod/spider/Kwps.class', 'classes.dex',
                 'a/b/c.txt', '..hidden', 'a..b/c.class'):
        jar_patch._validate_zip_entry_name(good)  # 合法名不得抛


def test_patch_jar_hit_writes_patched_copy_and_leaves_source_intact():
    """命中补丁：产出 patched jar 且源文件字节不变（不动运行中 JVM 的句柄）。"""
    tmp = tempfile.mkdtemp(prefix='jar_patch_hit_')
    src = os.path.join(tmp, 'spider.jar')
    dst = os.path.join(tmp, 'spider.patched.jar')
    old, new = jar_patch.SELECTOR_PATCHES['com/github/catvod/spider/Kwps.class'][0]
    try:
        with zipfile.ZipFile(src, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('com/github/catvod/spider/Kwps.class',
                       b'padding' + _utf8_const(old) + b'tail')
            z.writestr('other/Unrelated.class', _utf8_const(old))
        before = open(src, 'rb').read()
        changed = jar_patch.patch_jar(src, dst, jar_patch.SELECTOR_PATCHES)
        assert changed and changed[0][0] == 'com/github/catvod/spider/Kwps.class', changed
        assert changed[0][1] == 'utf8' and changed[0][4] == 1, changed
        assert open(src, 'rb').read() == before, '源文件必须字节不变'
        with zipfile.ZipFile(dst) as z:
            assert new.encode('utf-8') in z.read('com/github/catvod/spider/Kwps.class')
            assert old.encode('utf-8') in z.read('other/Unrelated.class'), \
                '未登记条目不得被打补丁'
            assert z.testzip() is None
    finally:
        _rmtree(tmp)


def test_patch_jar_miss_leaves_content_untouched():
    """未命中：changed 为空，目标 jar 内容与源逐字节一致（不产生任何改写）。"""
    tmp = tempfile.mkdtemp(prefix='jar_patch_miss_')
    # 注意：patch_jar 是「全量复制 + 原地改条目」，无论有没有命中都会产出目标
    # jar（changed 为空表示无补丁生效）。未命中的语义因此是「内容逐字节同源」，
    # 而不是「不产出文件」——apply_jar_patches 会把它当有效产物复用（见下一条）。
    src = os.path.join(tmp, 'plain.jar')
    dst = os.path.join(tmp, 'plain.patched.jar')
    entry = _utf8_const('abc')
    try:
        with zipfile.ZipFile(src, 'w') as z:
            z.writestr('com/example/Nothing.class', entry)
        changed = jar_patch.patch_jar(src, dst, jar_patch.SELECTOR_PATCHES)
        assert changed == [], changed
        assert os.path.isfile(dst), 'patch_jar 总是产出目标 jar'
        with zipfile.ZipFile(dst) as z:
            assert z.namelist() == ['com/example/Nothing.class']
            assert z.read('com/example/Nothing.class') == entry, '条目内容必须逐字节同源'
    finally:
        _rmtree(tmp)


def test_patch_jar_failure_does_not_corrupt_source_or_leave_tmp():
    """条目名非法（打补丁失败）：抛错、源文件完好、不留 .tmp 残留。"""
    tmp = tempfile.mkdtemp(prefix='jar_patch_fail_')
    src = os.path.join(tmp, 'bad.jar')
    dst = os.path.join(tmp, 'bad.patched.jar')
    try:
        with zipfile.ZipFile(src, 'w') as z:
            z.writestr('../escape.class', _utf8_const('abc'))
        before = open(src, 'rb').read()
        try:
            jar_patch.patch_jar(src, dst, jar_patch.SELECTOR_PATCHES)
        except ValueError as e:
            assert 'entry name' in str(e), str(e)
        else:
            assert False, '非法条目名必须抛 ValueError'
        assert open(src, 'rb').read() == before, '失败不得破坏源文件'
        assert not os.path.exists(dst), '失败不得产出目标文件'
        assert not [n for n in os.listdir(tmp) if '.tmp' in n], '临时文件必须被清理'
    finally:
        _rmtree(tmp)


def test_patch_jar_is_idempotent_on_second_pass():
    """二次打补丁（对产物再打一次）：不再命中（选择器已被替换），产物仍合法。"""
    tmp = tempfile.mkdtemp(prefix='jar_patch_idem_')
    src = os.path.join(tmp, 'spider.jar')
    dst1 = os.path.join(tmp, 'spider.patched.jar')
    dst2 = os.path.join(tmp, 'spider.patched2.jar')
    old = jar_patch.SELECTOR_PATCHES['com/github/catvod/spider/Kwps.class'][0][0]
    try:
        with zipfile.ZipFile(src, 'w') as z:
            z.writestr('com/github/catvod/spider/Kwps.class', _utf8_const(old))
        first = jar_patch.patch_jar(src, dst1, jar_patch.SELECTOR_PATCHES)
        assert len(first) == 1, first
        with zipfile.ZipFile(dst1) as z:
            data = z.read('com/github/catvod/spider/Kwps.class')
        assert old.encode('utf-8') not in data
        second = jar_patch.patch_jar(dst1, dst2, jar_patch.SELECTOR_PATCHES)
        assert second == [], '二次打补丁不得再次命中'
        with zipfile.ZipFile(dst2) as z:
            assert z.read('com/github/catvod/spider/Kwps.class') == data
    finally:
        _rmtree(tmp)


def test_apply_jar_patches_skips_when_no_patch_target_present():
    """apply_jar_patches：jar 内无补丁目标类 / 路径无效 → 直接返回原路径。"""
    tmp = tempfile.mkdtemp(prefix='apply_patch_')
    jar = os.path.join(tmp, 'plain.jar')
    try:
        with zipfile.ZipFile(jar, 'w') as z:
            z.writestr('com/example/Nope.class', _utf8_const('abc'))
        assert JarBridge.apply_jar_patches(jar) == jar
        assert not os.path.exists(jar[:-4] + '.patched.jar')
        assert JarBridge.apply_jar_patches('') == ''
        assert JarBridge.apply_jar_patches(os.path.join(tmp, 'missing.jar')) == \
            os.path.join(tmp, 'missing.jar')
    finally:
        _rmtree(tmp)


def test_apply_jar_patches_reuses_valid_and_rebuilds_corrupt_artifact():
    """patched 产物有效则复用；崩溃残留的坏 zip 必须重打而不是永久复用。"""
    tmp = tempfile.mkdtemp(prefix='apply_patch2_')
    jar = os.path.join(tmp, 'spider.jar')
    patched = os.path.join(tmp, 'spider.patched.jar')
    old = jar_patch.SELECTOR_PATCHES['com/github/catvod/spider/Kwps.class'][0][0]
    try:
        with zipfile.ZipFile(jar, 'w') as z:
            z.writestr('com/github/catvod/spider/Kwps.class', _utf8_const(old))
        got = JarBridge.apply_jar_patches(jar)
        assert got == patched and os.path.isfile(patched), got
        mtime = os.path.getmtime(patched)
        assert JarBridge.apply_jar_patches(jar) == patched
        assert os.path.getmtime(patched) == mtime, '合法产物不得被重打'
        # 人为写坏产物并置新 mtime → 必须重打
        with open(patched, 'wb') as f:
            f.write(b'not a zip at all')
        os.utime(patched, (mtime + 10, mtime + 10))
        rebuilt = JarBridge.apply_jar_patches(jar)
        assert rebuilt == patched
        with zipfile.ZipFile(patched) as z:
            assert z.testzip() is None, '坏产物必须被重打为合法 zip'
    finally:
        _rmtree(tmp)


def test_apply_jar_patches_failure_falls_back_to_source():
    """打补丁过程中抛异常：返回原路径（绝不因为补丁失败而拿不到 jar）。"""
    tmp = tempfile.mkdtemp(prefix='apply_patch3_')
    jar = os.path.join(tmp, 'spider.jar')
    old = jar_patch.SELECTOR_PATCHES['com/github/catvod/spider/Kwps.class'][0][0]
    try:
        with zipfile.ZipFile(jar, 'w') as z:
            z.writestr('com/github/catvod/spider/Kwps.class', _utf8_const(old))
        with mock.patch('jar_patch.patch_jar', side_effect=OSError('disk on fire')):
            assert JarBridge.apply_jar_patches(jar) == jar
    finally:
        _rmtree(tmp)


# ============================================================================
# 第六节：java_probe — 探测优先级 / 版本解析 / 缓存
# ============================================================================

def test_java_probe_priority_user_bin_over_java_home():
    """优先级 1：YUKI_JAVA_BIN 指定文件存在时排在最前（先于 YUKI_JAVA_HOME）。"""
    tmp = tempfile.mkdtemp(prefix='probe_prio_')
    try:
        user_bin = _touch(os.path.join(tmp, 'user', 'bin', 'java.exe'))
        home_bin = _touch(os.path.join(tmp, 'home', 'bin', 'java.exe'))
        env = {'YUKI_JAVA_BIN': user_bin,
               'YUKI_JAVA_HOME': os.path.join(tmp, 'home'),
               'JAVA_HOME': os.path.join(tmp, 'envhome')}
        with mock.patch.dict(os.environ, env, clear=False):
            with mock.patch.object(java_probe, '_resources_root', return_value=tmp):
                with mock.patch.object(java_probe.shutil, 'which', return_value=None):
                    cands = java_probe._candidates()
        assert cands[0] == user_bin, cands
        assert home_bin in cands, 'YUKI_JAVA_HOME/bin/java 也应进入候选'
    finally:
        _rmtree(tmp)


def test_java_probe_java_home_appends_bin_and_strips_quotes():
    """优先级 3：JAVA_HOME 自动拼 bin/java(.exe)，且容忍包裹引号。"""
    tmp = tempfile.mkdtemp(prefix='probe_home_')
    try:
        home_bin = _touch(os.path.join(tmp, 'jh', 'bin', 'java.exe'))
        with mock.patch.dict(os.environ,
                             {'JAVA_HOME': '"%s"' % os.path.join(tmp, 'jh')}, clear=False):
            with mock.patch.object(java_probe, '_resources_root', return_value=tmp):
                with mock.patch.object(java_probe.shutil, 'which', return_value=None):
                    cands = java_probe._candidates()
        assert home_bin in cands, (home_bin, cands)
    finally:
        _rmtree(tmp)


def test_java_probe_vendor_jre_and_path_order():
    """优先级 2/4：随包 JRE 先于 JAVA_HOME 先于 PATH。"""
    tmp = tempfile.mkdtemp(prefix='probe_order_')
    try:
        vendor = _touch(os.path.join(tmp, 'vendor', 'jre', 'bin', 'java.exe'))
        envhome = _touch(os.path.join(tmp, 'envhome', 'bin', 'java.exe'))
        path_bin = os.path.join(tmp, 'path', 'java.exe')
        with mock.patch.dict(os.environ,
                             {'JAVA_HOME': os.path.join(tmp, 'envhome')}, clear=False):
            with mock.patch.object(java_probe, '_resources_root', return_value=tmp):
                with mock.patch.object(java_probe.shutil, 'which', return_value=path_bin):
                    cands = java_probe._candidates()
        assert cands.index(vendor) < cands.index(envhome) < cands.index(path_bin), cands
    finally:
        _rmtree(tmp)


def test_java_probe_ignores_nonexistent_and_empty_candidates():
    """不存在的路径 / 空环境变量不得进入候选（避免 _version 白跑）。"""
    tmp = tempfile.mkdtemp(prefix='probe_bad_')
    try:
        env = {'YUKI_JAVA_BIN': os.path.join(tmp, 'nope', 'java.exe'),
               'YUKI_JAVA_HOME': '',
               'JAVA_HOME': os.path.join(tmp, 'nohome')}
        with mock.patch.dict(os.environ, env, clear=False):
            with mock.patch.object(java_probe, '_resources_root', return_value=tmp):
                with mock.patch.object(java_probe.shutil, 'which', return_value=None):
                    assert java_probe._candidates() == []
    finally:
        _rmtree(tmp)


def test_java_version_parsing_normal_and_malformed():
    """版本解析：正常 / stdout 兜底 / 无引号 / 多版本行 / 畸形 / 空 / 异常 全分支。"""
    def done(stderr='', stdout=''):
        return subprocess.CompletedProcess(args=[], returncode=0,
                                           stdout=stdout, stderr=stderr)

    with mock.patch.object(java_probe.subprocess, 'run', return_value=done(
            'openjdk version "17.0.10" 2024-01-16\nOpenJDK Runtime...')):
        assert java_probe._version('java') == '17.0.10'

    with mock.patch.object(java_probe.subprocess, 'run', return_value=done('', 'java version "21"')):
        assert java_probe._version('java') == '21', 'stdout 也要兜底'

    with mock.patch.object(java_probe.subprocess, 'run', return_value=done('version 17')):
        assert java_probe._version('java') == '', '无引号不算版本'

    with mock.patch.object(java_probe.subprocess, 'run', return_value=done('garbage')):
        assert java_probe._version('java') == ''

    with mock.patch.object(java_probe.subprocess, 'run', return_value=done('')):
        assert java_probe._version('java') == ''

    with mock.patch.object(java_probe.subprocess, 'run', return_value=done(
            'Picked up JAVA_TOOL_OPTIONS: -Xmx1g\nopenjdk version "11.0.2" 2019\n'
            'Picked up _JAVA_OPTIONS: version "1.4"')):
        assert java_probe._version('java') == '11.0.2', '多版本行取第一个匹配'

    def _boom(*_a, **_k):
        raise OSError('no such file')

    with mock.patch.object(java_probe.subprocess, 'run', side_effect=_boom):
        assert java_probe._version('missing-java') == ''


def test_java_find_java_cache_hit_and_invalidation():
    """缓存：命中即短路（不再跑 _version）；clear_cache 后重新探测并恢复版本。"""
    java_probe.clear_cache()
    calls = []

    def fake_version(binpath):
        calls.append(binpath)
        return '17.0.10' if binpath.endswith('good') else ''

    with mock.patch.object(java_probe, '_candidates', return_value=['/x/bad', '/x/good']):
        with mock.patch.object(java_probe, '_version', side_effect=fake_version):
            assert java_probe.find_java() == '/x/good'
            assert java_probe.java_version() == '17.0.10'
            assert calls == ['/x/bad', '/x/good'], calls
            assert java_probe.find_java() == '/x/good'
            assert calls == ['/x/bad', '/x/good'], '缓存命中不得重复 _version'
            java_probe.clear_cache()
            assert java_probe.java_version() == '', '清缓存后版本必须为空'
            assert java_probe.find_java() == '/x/good'
            assert len(calls) == 4, calls
    java_probe.clear_cache()


def test_java_find_java_failure_clears_cache_and_returns_none():
    """全部候选不可用：返回 None 且缓存保持空（下次仍会重探）。"""
    java_probe.clear_cache()
    with mock.patch.object(java_probe, '_candidates', return_value=['/x/a', '/x/b']):
        with mock.patch.object(java_probe, '_version', return_value=''):
            assert java_probe.find_java() is None
            assert java_probe.java_version() == ''
            assert java_probe._probe_cache['bin'] is None
            assert java_probe.find_java() is None
    java_probe.clear_cache()


def test_java_find_java_skips_empty_candidate():
    """候选列表里的空串/None 被跳过（不调用 _version）。"""
    java_probe.clear_cache()
    seen = []

    def fake_version(binpath):
        seen.append(binpath)
        return ''

    with mock.patch.object(java_probe, '_candidates', return_value=['', None, '/x/a']):
        with mock.patch.object(java_probe, '_version', side_effect=fake_version):
            assert java_probe.find_java() is None
    assert seen == ['/x/a'], seen
    java_probe.clear_cache()


def test_java_version_does_not_trigger_probe():
    """java_version() 是纯读缓存：未探测时返回 ''，绝不触发 _version。"""
    java_probe.clear_cache()
    with mock.patch.object(java_probe, '_version', side_effect=AssertionError('must not probe')):
        assert java_probe.java_version() == ''
        assert java_probe._probe_cache['bin'] is None
    java_probe.clear_cache()


# ============================================================================
# 第七节：子进程生命周期 — 超时 / 崩溃计数 / 串行化 / 关闭
# ============================================================================

def test_timeout_kills_proc_and_clears_pending():
    """超时：pending 被摘除、进程被 kill、抛 TimeoutError（不无限挂起）。"""
    proc = _FakeProc(alive=False)
    bridge = _bridge_with_proc(proc)
    bridge._ensure_alive = lambda: True
    try:
        bridge._call_inner('homeContent', True, deadline=time.monotonic() - 1)
    except TimeoutError as e:
        assert 'timeout' in str(e), str(e)
    else:
        assert False, '超时必须抛 TimeoutError'
    assert proc.killed is True, '超时必须强杀 JVM'
    assert bridge._pending == {}, '超时后 pending 必须清空'


def test_timeout_releases_resources_and_reaps():
    """超时后的清理：stdin/stdout/stderr 全部关闭，_reap 已确认进程退出。"""
    proc = _FakeProc(alive=False)
    bridge = _bridge_with_proc(proc)
    bridge._ensure_alive = lambda: True
    try:
        bridge._call_inner('homeContent', True, deadline=time.monotonic() - 1)
    except TimeoutError:
        pass
    assert proc.stdin.closed and proc.stdout.closed and proc.stderr.closed, '管道必须全关'
    assert proc.waited >= 1, '_reap 必须 wait 过'


def test_crash_count_increments_and_hits_restart_limit():
    """崩溃计数：每次重新拉起都 +1；>3 后拒绝再拉起（杜绝无限重启循环）。"""
    bridge = _new_bridge()
    refused = []

    def attempt():
        with mock.patch.object(java_probe, 'find_java', return_value=None):
            with mock.patch.object(jar_bridge.time, 'sleep', return_value=None):
                try:
                    bridge._call_inner('homeContent', True)
                except RuntimeError as e:
                    refused.append(str(e))

    # 前 3 次：计数累加且仍尝试拉起（此处因无 java 而失败）
    for i in range(1, 4):
        attempt()
        assert bridge._crash_count == i, (i, bridge._crash_count)
    assert all('no-java-runtime' in msg for msg in refused), refused

    # 第 4 次起：计数继续累加，但一律拒绝拉起
    for i in range(4, 7):
        attempt()
        assert bridge._crash_count == i, (i, bridge._crash_count)
        assert 'restart limit exceeded (3)' in refused[-1], refused[-1]


def test_crash_limit_sets_last_error_and_refuses_spawn():
    """已超上限：不再 Popen，直接置 last_error 并返回 False。"""
    bridge = _new_bridge(runner_jar=os.path.join(BASE, 'no-such-runner.jar'))
    bridge._crash_count = 3
    with mock.patch.object(jar_bridge.subprocess, 'Popen',
                           side_effect=AssertionError('must not spawn')):
        assert bridge._ensure_alive() is False
    assert bridge._last_error == 'jar restart limit exceeded (3)', bridge._last_error
    bridge._crash_count = 0


def test_successful_call_resets_crash_count():
    """调用成功即视为进程健康：崩溃计数清零（M-27a）。"""
    bridge = _echo_bridge()
    try:
        bridge._crash_count = 2
        got = _write_frame(bridge, 'homeContent', True)
        assert got['method'] == 'homeContent'
        assert bridge._crash_count == 0, '成功调用必须清零崩溃计数'
    finally:
        _clear_juggle()


def test_destroyed_bridge_refuses_respawn():
    """destroy() 是终态：残留引用再 call 也不得孵化孤儿 JVM。"""
    bridge = _new_bridge()
    bridge._destroyed = True
    with mock.patch.object(jar_bridge.subprocess, 'Popen',
                           side_effect=AssertionError('must not spawn')):
        assert bridge._ensure_alive() is False
    assert bridge._last_error == 'jar bridge destroyed'


def test_ensure_alive_missing_java_or_assets():
    """缺 java / 缺目标 jar：分别置不同 last_error 且不 spawn。"""
    bridge = _new_bridge(runner_jar=os.path.join(BASE, 'no-such-runner.jar'))
    with mock.patch.object(java_probe, 'find_java', return_value=None):
        with mock.patch.object(jar_bridge.subprocess, 'Popen',
                               side_effect=AssertionError('must not spawn')):
            with mock.patch.object(jar_bridge.time, 'sleep', return_value=None):
                assert bridge._ensure_alive() is False
    assert bridge._last_error == 'no-java-runtime', bridge._last_error

    bridge2 = _new_bridge(jar_path=os.path.join(BASE, 'definitely-missing.jar'),
                          runner_jar=__file__)
    with mock.patch.object(java_probe, 'find_java', return_value='java'):
        with mock.patch.object(jar_bridge.subprocess, 'Popen',
                               side_effect=AssertionError('must not spawn')):
            with mock.patch.object(jar_bridge.time, 'sleep', return_value=None):
                assert bridge2._ensure_alive() is False
    assert 'jar not found' in bridge2._last_error, bridge2._last_error


def test_ensure_alive_missing_runner_jar_reports_path():
    """缺 spider-runner.jar：last_error 带上具体路径，便于诊断。"""
    missing = os.path.join(BASE, 'no-such-runner.jar')
    bridge = _new_bridge(jar_path=__file__, runner_jar=missing)
    with mock.patch.object(java_probe, 'find_java', return_value='java'):
        with mock.patch.object(jar_bridge.subprocess, 'Popen',
                               side_effect=AssertionError('must not spawn')):
            with mock.patch.object(jar_bridge.time, 'sleep', return_value=None):
                assert bridge._ensure_alive() is False
    assert bridge._last_error == 'missing spider-runner.jar at ' + missing, \
        bridge._last_error


def test_ensure_alive_spawn_failure_is_contained():
    """Popen 抛异常：捕获为 last_error，不向外抛。"""
    bridge = _new_bridge(jar_path=__file__, runner_jar=__file__)
    with mock.patch.object(java_probe, 'find_java', return_value='java'):
        with mock.patch.object(jar_bridge.subprocess, 'Popen',
                               side_effect=OSError('access denied')):
            with mock.patch.object(jar_bridge.time, 'sleep', return_value=None):
                with mock.patch.object(jar_bridge, 'get_jar_runtime_dir',
                                       return_value=tempfile.gettempdir()):
                    assert bridge._ensure_alive() is False
    assert bridge._last_error.startswith('java spawn:'), bridge._last_error


def test_ensure_alive_builds_expected_command_lines():
    """启动命令行：jar 模式用 -jar；DEX(-jvm) 且有 deps 时用 -noverify + -cp。"""
    tmp = tempfile.mkdtemp(prefix='jar_spawn_')
    try:
        _touch(os.path.join(tmp, 'deps', 'okhttp.jar'))
        runner = _touch(os.path.join(tmp, 'runner.jar'))
        plain_jar = _touch(os.path.join(tmp, 'plain.jar'))
        dex_jar = _touch(os.path.join(tmp, 'a-jvm.jar'))
        common = [
            mock.patch.object(jar_bridge, 'DEXDEPS_DIR', os.path.join(tmp, 'deps')),
            mock.patch.object(java_probe, 'find_java', return_value='java'),
            mock.patch.object(jar_bridge.time, 'sleep', return_value=None),
            mock.patch.object(jar_bridge, 'get_jar_runtime_dir',
                              return_value=tempfile.gettempdir()),
            mock.patch.object(JarBridge, 'proxy_java_args', return_value=[]),
            mock.patch.object(JarBridge, 'runtime_java_args', return_value=[]),
            mock.patch.object(JarBridge, 'runtime_java_env', return_value={}),
        ]
        def enter_all():
            for item in common:
                item.start()

        def exit_all():
            for item in common:
                item.stop()

        enter_all()
        try:
            plain = _new_bridge(jar_path=plain_jar, runner_jar=runner)
            with mock.patch.object(jar_bridge.subprocess, 'Popen',
                                   return_value=_FakeProc()) as popen:
                assert plain._ensure_alive() is True
            args = popen.call_args[0][0]
            assert args[:3] == ['java', '-jar', runner], args
            assert args[3:] == [plain_jar, 'default'], args

            dex = _new_bridge(jar_path=dex_jar, runner_jar=runner)
            with mock.patch.object(jar_bridge.subprocess, 'Popen',
                                   return_value=_FakeProc()) as popen2:
                assert dex._ensure_alive() is True
            args2 = popen2.call_args[0][0]
            assert args2[:2] == ['java', '-noverify'], args2
            assert '-cp' in args2 and 'SpiderRunner' in args2, args2
            assert args2[-2:] == [dex_jar, 'default'], args2
            assert 'okhttp.jar' in args2[args2.index('-cp') + 1], args2
        finally:
            exit_all()
    finally:
        _rmtree(tmp)


def test_write_failure_restarts_once_then_retries():
    """写 stdin 失败：杀进程 → 重新拉起 → 用新进程重试一次写；成功即返回。"""
    proc = _FakeProc(alive=False)
    bridge = _bridge_with_proc(proc)
    calls = []

    # 第一次写（旧管道）必炸；重启后写新管道应成功（新管道默认是好管道）
    def flaky_write(data):
        calls.append(('old', len(data)))
        raise BrokenPipeError('pipe broken')

    proc.stdin.write = flaky_write
    fresh = _FakeProc(alive=False)
    real_fresh_write = fresh.stdin.write
    fresh.stdin.write = lambda data: (calls.append(('new', len(data))),
                                      real_fresh_write(data))[1]

    # 注意：重试写的是**同一个 request 对象**，不会再调用一次序列化分支。
    def respawn():
        # 与真实语义一致：进程仍在则直接返回；被 kill（proc 置空）后换成新进程
        if bridge.proc is None:
            bridge.proc = fresh
        return True

    bridge._ensure_alive = respawn

    def deliver(_self, timeout=None):
        with bridge._lock:
            pend = list(bridge._pending.values())
        for resolve, _reject in pend:
            resolve('ok')
        return True

    with mock.patch.object(threading.Event, 'wait', deliver):
        assert bridge._call_inner('homeContent', True) == 'ok'
    assert [kind for kind, _n in calls] == ['old', 'new'], '必须恰好重试一次写'
    assert proc.killed is True
    assert bridge.proc is fresh, '重启后必须改用新进程'
    assert fresh.stdin.written.endswith(b'\n'), '重试必须写完整帧'


def test_write_failure_after_restart_raises_runtime_error():
    """重启后写仍然失败：抛 RuntimeError 且不残留 pending。"""
    proc = _FakeProc(alive=False)
    bridge = _bridge_with_proc(proc)
    bridge._ensure_alive = lambda: True

    def always_fail(_data):
        raise BrokenPipeError('still dead')

    proc.stdin.write = always_fail
    try:
        bridge._call_inner('homeContent', True)
    except RuntimeError as e:
        assert 'write after restart failed' in str(e), str(e)
    else:
        assert False, '二次写失败必须抛 RuntimeError'
    assert bridge._pending == {}


def test_calls_are_serialized_by_call_lock():
    """同一桥的并发 call 被 _call_lock 串行化：任意时刻只有一个调用在途。"""
    bridge = _bridge_with_proc(_FakeProc())
    state = {'now': 0, 'max': 0}
    guard = threading.Lock()

    def inner(*_args, **_kwargs):
        with guard:
            state['now'] += 1
            state['max'] = max(state['max'], state['now'])
        try:
            return '{"list":[]}'
        finally:
            with guard:
                state['now'] -= 1

    bridge._call_inner = inner
    errors = []
    threads = [threading.Thread(target=lambda: _safe_call(bridge, errors)) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert not errors, errors
    assert state['max'] == 1, '并发调用必须被串行化：峰值=%d' % state['max']


def _safe_call(bridge, errors):
    try:
        bridge.call('homeContent', True)
    except Exception as exc:  # pragma: no cover - 仅收集
        errors.append(repr(exc))


def test_queue_timeout_when_lock_is_held():
    """锁被长时间持有时，排队者按 budget 超时快速失败（不无限挂起）。"""
    bridge = _new_bridge()
    held = threading.Lock()
    bridge._call_lock = held
    held.acquire()
    caught = []
    try:
        with mock.patch.object(jar_bridge, '_runtime_budget_seconds', return_value=0.01):
            worker = threading.Thread(target=lambda: _catch(bridge, caught))
            worker.start()
            worker.join(timeout=5)
        assert not worker.is_alive(), '排队者必须快速失败而非永久挂起'
        assert caught and isinstance(caught[0], TimeoutError), caught
        assert 'queued for jar worker' in str(caught[0]), caught
    finally:
        held.release()


def _catch(bridge, caught):
    try:
        bridge.call('homeContent', True)
    except Exception as exc:  # noqa: BLE001 - 收集用
        caught.append(exc)


def test_destroy_releases_resources_and_marks_terminal():
    """destroy：置 _destroyed、清 pending、发 __shutdown、关三条管道、计数清零。"""
    proc = _FakeProc()
    bridge = _bridge_with_proc(proc)
    bridge._crash_count = 2
    bridge._pending[1] = (lambda v: None, lambda e: None)
    bridge.destroy()
    assert bridge._destroyed is True
    assert bridge.proc is None
    assert bridge._pending == {} and bridge._crash_count == 0
    assert b'__shutdown' in bytes(proc.stdin.written), '必须发 __shutdown 帧'
    assert proc.stdin.closed and proc.stdout.closed and proc.stderr.closed


def test_destroy_falls_back_to_kill_when_graceful_wait_fails():
    """优雅退出等待失败：转强杀（kill），仍然关闭所有管道。"""
    proc = _FakeProc()

    def wait_no(*_a, **_k):
        raise Exception('still running')

    proc.wait = wait_no
    bridge = _bridge_with_proc(proc)
    with mock.patch.object(jar_bridge, '_reap', return_value=None):
        bridge.destroy()
    assert proc.killed is True, '优雅失败必须强杀'
    assert proc.stdin.closed and proc.stdout.closed and proc.stderr.closed


def test_destroy_all_clears_registry_without_deadlock():
    """destroy_all：先摘除注册表再逐个 destroy（锁外销毁，避免不可重入锁自锁）。"""
    reg_backup = dict(jar_bridge._jar_bridges)
    lru_backup = dict(jar_bridge._jar_lru)
    jar_bridge._jar_bridges.clear()
    jar_bridge._jar_lru.clear()
    try:
        procs = []
        for i in range(3):
            proc = _FakeProc()
            procs.append(proc)
            jar_bridge._jar_bridges['/x/jar%d.jar' % i] = _bridge_with_proc(
                proc, jar_path='/x/jar%d.jar' % i)
            jar_bridge._jar_lru['/x/jar%d.jar' % i] = True
        done = threading.Event()

        def worker():
            JarBridge.destroy_all()
            done.set()

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        assert done.wait(timeout=10), 'destroy_all 不得死锁'
        assert jar_bridge._jar_bridges == {} and jar_bridge._jar_lru == {}
        assert all(p.stdin.closed for p in procs), '所有子进程资源必须释放'
    finally:
        jar_bridge._jar_bridges.clear()
        jar_bridge._jar_lru.clear()
        jar_bridge._jar_bridges.update(reg_backup)
        jar_bridge._jar_lru.update(lru_backup)


def test_kill_proc_rejects_pending_and_closes_pipes():
    """_kill_proc：pending 全部 reject、stdin 关闭、进程被 kill、补删 cookie。"""
    proc = _FakeProc(alive=False)
    bridge = _bridge_with_proc(proc)
    fired = []
    bridge._pending = {1: (lambda v: None, lambda e: fired.append(str(e)))}
    with mock.patch.object(jar_bridge, '_reap', return_value=None):
        with mock.patch.object(bridge, '_cleanup_cookie_files_after_kill') as cleanup:
            bridge._kill_proc()
    assert fired == ['jar process restarted'], fired
    assert bridge.proc is None and proc.killed is True
    assert proc.stdin.closed
    assert cleanup.called, '强杀后必须补删 cookie 文件'


def test_kill_proc_survives_oserror_on_already_dead_process():
    """Windows 上已退出进程 kill 抛 OSError(Errno 22)：必须被吞掉不冒泡。"""
    proc = _FakeProc(alive=False)

    def boom():
        raise OSError(22, 'Invalid argument')

    proc.kill = boom
    bridge = _bridge_with_proc(proc)
    with mock.patch.object(jar_bridge, '_reap', return_value=None):
        with mock.patch.object(bridge, '_cleanup_cookie_files_after_kill',
                               return_value=None):
            bridge._kill_proc()  # 不得抛
    assert bridge.proc is None


def test_reap_tolerates_dumb_proc_double():
    """_reap：替身没有 poll/wait 语义时按「已退出」处理，不抛也不死循环。"""
    class Dumb:
        def wait(self, timeout=None):
            raise TypeError('no wait')

        def poll(self):
            raise TypeError('no poll')

    with mock.patch.object(jar_bridge.time, 'sleep', return_value=None) as slept:
        jar_bridge._reap(Dumb())
    assert not slept.called, '无 poll/wait 语义时应直接返回，不得进入 sleep 轮询'

    class Alive:
        def __init__(self):
            self.n = 0

        def wait(self, timeout=None):
            return None

        def poll(self):
            self.n += 1
            return None if self.n < 3 else 0

    with mock.patch.object(jar_bridge.time, 'sleep', return_value=None) as slept2:
        jar_bridge._reap(Alive())
    assert slept2.call_count == 2, '应轮询到 poll() 返回非 None 为止'


# ============================================================================
# 第八节：桥注册表 / LRU / cookie 清理
# ============================================================================

def _swap_registry():
    """保存并清空全局桥注册表，返回还原函数。"""
    reg_backup = dict(jar_bridge._jar_bridges)
    lru_backup = dict(jar_bridge._jar_lru)
    jar_bridge._jar_bridges.clear()
    jar_bridge._jar_lru.clear()

    def restore():
        jar_bridge._jar_bridges.clear()
        jar_bridge._jar_lru.clear()
        jar_bridge._jar_bridges.update(reg_backup)
        jar_bridge._jar_lru.update(lru_backup)

    return restore


def test_max_jvm_env_clamp_and_invalid_values():
    """_max_jvm：环境变量 clamp 到 [1,8]；非法值回落默认 3。"""
    for raw, expect in (('1', 1), ('8', 8), ('0', 1), ('99', 8), ('-5', 1),
                        ('abc', 3), ('  5  ', 5)):
        env = {'YUKI_MAX_JVM': raw, 'YUKI_MAX_JAR_PROCESSES': ''}
        with mock.patch.dict(os.environ, env, clear=False):
            assert jar_bridge._max_jvm() == expect, (raw, jar_bridge._max_jvm())
    with mock.patch.dict(os.environ,
                         {'YUKI_MAX_JVM': '', 'YUKI_MAX_JAR_PROCESSES': '4'}, clear=False):
        assert jar_bridge._max_jvm() == 4, '备用环境变量也要生效'
    with mock.patch.dict(os.environ,
                         {'YUKI_MAX_JVM': '', 'YUKI_MAX_JAR_PROCESSES': ''}, clear=False):
        assert jar_bridge._max_jvm() == 3, '都为空时回落默认 3'


def _hold_busy(bridges):
    """让若干桥的调用锁被**另一个线程**持有（模拟并发在途调用）。

    ``_call_lock`` 原为 RLock（同线程可重入），要让 ``acquire(blocking=False)``
    返回 False 必须由别的线程持有——这里临时换成普通 Lock 由持有线程操作。
    返回 release()（任一方解除等待都不会永久挂起，超时上限 10s）。
    """
    ready = threading.Event()
    release_now = threading.Event()
    for bridge in bridges:
        bridge._call_lock = threading.Lock()

    def holder():
        for bridge in bridges:
            bridge._call_lock.acquire()
        ready.set()
        release_now.wait(timeout=10)
        for bridge in bridges:
            try:
                bridge._call_lock.release()
            except RuntimeError:  # pragma: no cover - 已释放
                pass

    worker = threading.Thread(target=holder, daemon=True)
    worker.start()
    assert ready.wait(timeout=10), '持有线程未能就位'

    def release():
        release_now.set()
        worker.join(timeout=10)

    return release


def test_evict_jvm_if_needed_picks_lru_head_and_skips_busy():
    """淘汰：从 LRU 头部取最久未用且空闲的桥；忙桥被跳过。"""
    restore = _swap_registry()
    try:
        bridges = {name: _new_bridge(jar_path='/x/%s.jar' % name)
                   for name in ('old', 'mid', 'new')}
        for name, b in bridges.items():
            jar_bridge._jar_bridges['/x/%s.jar' % name] = b
            jar_bridge._jar_lru['/x/%s.jar' % name] = True
        with mock.patch.object(jar_bridge, '_max_jvm', return_value=3):
            victim = jar_bridge._evict_jvm_if_needed_locked()
        assert victim is bridges['old'], '最久未用的 old 应被淘汰'
        assert '/x/old.jar' not in jar_bridge._jar_bridges
        assert '/x/old.jar' not in jar_bridge._jar_lru

        # 只剩 mid/new，上限降到 2 仍触发淘汰；mid 被别的线程占用 → 跳过它选 new
        release = _hold_busy([bridges['mid']])
        try:
            with mock.patch.object(jar_bridge, '_max_jvm', return_value=2):
                victim2 = jar_bridge._evict_jvm_if_needed_locked()
            assert victim2 is bridges['new'], '忙桥必须被跳过'
            assert bridges['mid'] in jar_bridge._jar_bridges.values(), '忙桥不得被摘除'
        finally:
            release()
    finally:
        restore()


def test_evict_jvm_all_busy_raises_runtime_busy():
    """所有桥都在忙：抛 L3_RUNTIME_BUSY（拒绝而非阻塞等待）。"""
    restore = _swap_registry()
    try:
        bridges = []
        for name in ('a', 'b'):
            bridge = _new_bridge(jar_path='/x/%s.jar' % name)
            jar_bridge._jar_bridges['/x/%s.jar' % name] = bridge
            jar_bridge._jar_lru['/x/%s.jar' % name] = True
            bridges.append(bridge)
        release = _hold_busy(bridges)
        try:
            with mock.patch.object(jar_bridge, '_max_jvm', return_value=1):
                try:
                    jar_bridge._evict_jvm_if_needed_locked()
                except RuntimeContractError as e:
                    assert e.code == 'L3_RUNTIME_BUSY', e.code
                else:
                    assert False, '池耗尽必须抛 L3_RUNTIME_BUSY'
            assert len(jar_bridge._jar_bridges) == 2, '拒绝时不得摘除任何桥'
        finally:
            release()
    finally:
        restore()


def test_evict_jvm_cleans_orphan_lru_entries():
    """LRU 里有桥缓存中不存在的条目：清理孤儿后再继续找可淘汰者。"""
    restore = _swap_registry()
    try:
        jar_bridge._jar_lru['/x/ghost.jar'] = True
        real = _new_bridge(jar_path='/x/real.jar')
        jar_bridge._jar_bridges['/x/real.jar'] = real
        jar_bridge._jar_lru['/x/real.jar'] = True
        with mock.patch.object(jar_bridge, '_max_jvm', return_value=1):
            victim = jar_bridge._evict_jvm_if_needed_locked()
        assert victim is real
        assert '/x/ghost.jar' not in jar_bridge._jar_lru, '孤儿 LRU 条目必须被清理'
    finally:
        restore()


def test_is_md5_helper_boundaries():
    """_is_md5：仅 32 位十六进制为真；大小写、边界长度、非十六进制全假。"""
    assert jar_bridge._is_md5('a' * 32) and jar_bridge._is_md5('A' * 32)
    assert jar_bridge._is_md5('0123456789abcdefABCDEF0123456789')
    assert not jar_bridge._is_md5('a' * 31)
    assert not jar_bridge._is_md5('a' * 33)
    assert not jar_bridge._is_md5('g' * 32)
    assert not jar_bridge._is_md5('')
    assert not jar_bridge._is_md5('a' * 31 + ' ')


def test_norm_jar_src_segment_variants():
    """norm_jar_src：多段分号 —— 'md5' 字面标记 / 空段 / 大小写 / 非 md5 段。"""
    md5 = 'abc123def456abc123def456abc123d4'
    url, got, cls = JarBridge.norm_jar_src('https://x/y/spider.jar;md5;' + md5.upper())
    assert url == 'https://x/y/spider.jar' and got == md5, (url, got)
    assert cls == 'csp_spider', cls

    url2, got2, cls2 = JarBridge.norm_jar_src('https://x/y/csp_A.jar;MD5;;%s;zz' % md5)
    assert got2 == md5 and url2 == 'https://x/y/csp_A.jar' and cls2 == 'csp_A'

    url3, got3, cls3 = JarBridge.norm_jar_src('https://x/y/csp_B.jar;md5;nope')
    assert (url3, got3, cls3) == ('https://x/y/csp_B.jar', '', 'csp_B'), (url3, got3, cls3)

    # 无 .jar 后缀：base 就是最后一段；已带 csp_ 前缀不再重复加
    _, _, cls4 = JarBridge.norm_jar_src('https://x/y/csp_C?a=1')
    assert cls4 == 'csp_C', cls4
    # 无 csp_ 前缀：自动补前缀
    _, _, cls5 = JarBridge.norm_jar_src('https://x/y/MaoYan.jar')
    assert cls5 == 'csp_MaoYan', cls5
    assert JarBridge.norm_jar_src('') == ('', '', '')
    assert JarBridge.norm_jar_src(None) == ('', '', '')
    assert JarBridge.norm_jar_src('csp_Local') == ('', '', '')
    assert JarBridge.norm_jar_src('ftp://x/y.jar') == ('', '', '')


def test_jar_source_integrity_strict_and_insecure_opt_in():
    """严格模式：非 https / 无 md5 拒绝；opt-in 环境变量后放行。"""
    md5 = 'a' * 32
    try:
        jar_bridge._assert_jar_source_integrity('http://x/y.jar', md5)
    except ValueError as e:
        assert 'https' in str(e), str(e)
    else:
        assert False, '明文 http 源必须被拒'

    try:
        jar_bridge._assert_jar_source_integrity('https://x/y.jar', '')
    except ValueError as e:
        assert 'md5' in str(e), str(e)
    else:
        assert False, '无 md5 源必须被拒'

    try:
        jar_bridge._assert_jar_source_integrity('x/y.jar', md5)
    except ValueError:
        pass
    else:
        assert False, '无协议源必须被拒'

    jar_bridge._assert_jar_source_integrity('https://x/y.jar', md5)  # 合规不抛
    with mock.patch.dict(os.environ, {'YUKI_JAR_INSECURE_SOURCES': '1'}, clear=False):
        assert jar_bridge._allow_insecure_jar_sources() is True
        jar_bridge._assert_jar_source_integrity('http://x/y.jar', '')  # 宽松模式放行
    with mock.patch.dict(os.environ, {'YUKI_JAR_INSECURE_SOURCES': 'yes'}, clear=False):
        assert jar_bridge._allow_insecure_jar_sources() is True
    with mock.patch.dict(os.environ, {'YUKI_JAR_INSECURE_SOURCES': '0'}, clear=False):
        assert jar_bridge._allow_insecure_jar_sources() is False


def test_runtime_java_args_and_env_injection():
    """runtime_java_args 用宿主端口；token 经 JAVA_TOOL_OPTIONS 注入而非命令行。"""
    with mock.patch.object(hoststate, 'get_port', return_value=19761):
        args = JarBridge.runtime_java_args()
    assert args == ['-Dyuki.proxyHost=127.0.0.1', '-Dyuki.proxyPort=19761'], args

    with mock.patch.object(hoststate, 'get_port', return_value=0):
        args2 = JarBridge.runtime_java_args()
    assert args2[1].startswith('-Dyuki.proxyPort=')
    assert int(args2[1].split('=')[1]) > 0, '端口缺失时必须回落到可用端口'

    with mock.patch.object(hoststate, 'get_token', return_value='secret'):
        env = JarBridge.runtime_java_env()
        # 之前的断言在 patch 作用域**之外**调 runtime_java_args()，此时 token 是
        # 模块级配置的 'jar-internals-token'，断言恒真——检测不到把 token 塞进命令行
        # 参数的回归。把调用移进 patch 作用域内才有意义。
        args_with_secret = JarBridge.runtime_java_args()
    assert 'JAVA_TOOL_OPTIONS' in env
    assert '-Dyuki.proxyToken=secret' in env['JAVA_TOOL_OPTIONS']
    assert 'secret' not in json.dumps(args_with_secret), \
        'token 不得出现在命令行参数里'

    with mock.patch.object(hoststate, 'get_token', return_value=''):
        assert JarBridge.runtime_java_env() == {}

    with mock.patch.dict(os.environ, {'JAVA_TOOL_OPTIONS': '-Xmx1g'}, clear=False):
        with mock.patch.object(hoststate, 'get_token', return_value='t2'):
            env2 = JarBridge.runtime_java_env()
    assert env2['JAVA_TOOL_OPTIONS'].startswith('-Xmx1g'), '必须保留既有选项'
    assert '-Dyuki.proxyToken=t2' in env2['JAVA_TOOL_OPTIONS']


def test_proxy_java_args_from_system_proxy():
    """系统代理：有则生成 4 条 -D 属性；无地址/缺字段/异常时返回 []。"""
    with mock.patch('http_client.system_proxy_addr', return_value=('127.0.0.1', 7890)):
        assert JarBridge.proxy_java_args() == [
            '-Dhttp.proxyHost=127.0.0.1', '-Dhttp.proxyPort=7890',
            '-Dhttps.proxyHost=127.0.0.1', '-Dhttps.proxyPort=7890']
    with mock.patch('http_client.system_proxy_addr', return_value=None):
        assert JarBridge.proxy_java_args() == []
    with mock.patch('http_client.system_proxy_addr', return_value=('', 0)):
        assert JarBridge.proxy_java_args() == []
    with mock.patch('http_client.system_proxy_addr', side_effect=OSError('boom')):
        assert JarBridge.proxy_java_args() == []


def test_map_class_name_and_scan_jar_ports():
    """map_class_name 命中才改写；_scan_jar_ports 只收 1024-65535 的端口。"""
    tmp = tempfile.mkdtemp(prefix='mapcls_')
    jar = os.path.join(tmp, 's.jar')
    try:
        with zipfile.ZipFile(jar, 'w') as z:
            z.writestr('com/github/catvod/spider/MaoYan.class', b'\xca\xfe\xba\xbe')
        assert JarBridge.map_class_name(jar, 'csp_MaoYan') == \
            'com.github.catvod.spider.MaoYan'
        assert JarBridge.map_class_name(jar, 'csp_Missing') == 'csp_Missing'
        assert JarBridge.map_class_name(jar, 'Plain') == 'Plain'
    finally:
        _rmtree(tmp)
    assert JarBridge.map_class_name('/no/such.jar', 'csp_X') == 'csp_X', '异常路径原样返回'

    tmp2 = tempfile.mkdtemp(prefix='scanports_')
    try:
        jar2 = os.path.join(tmp2, 'p.jar')
        with zipfile.ZipFile(jar2, 'w') as z:
            z.writestr('a.dex', b'http://127.0.0.1:7777/x 127.0.0.1:80 127.0.0.1:70000')
        assert jar_bridge._scan_jar_ports(jar2) == {7777}
        raw = os.path.join(tmp2, 'raw.dex')
        with open(raw, 'wb') as f:
            f.write(b'127.0.0.1:1314 and 127.0.0.1:999')
        assert jar_bridge._scan_jar_ports(raw) == {1314}
        assert jar_bridge._scan_jar_ports(os.path.join(tmp2, 'missing')) == set()
    finally:
        _rmtree(tmp2)


def test_get_or_create_reuses_bridge_and_touches_lru():
    """get_or_create 同路径复用同一实例并刷新 LRU；路径按 realpath 规范化。"""
    restore = _swap_registry()
    tmp = tempfile.mkdtemp(prefix='goc_')
    try:
        jar = _touch(os.path.join(tmp, 'spider.jar'))
        with mock.patch.object(jar_bridge, '_scan_jar_ports', return_value=set()):
            with mock.patch.object(jar_bridge, 'classify_jar_compatibility',
                                   return_value={'level': 'L0', 'signals': [],
                                                 'hasDex': False, 'hasNative': False}):
                b1 = JarBridge.get_or_create(jar, runner_jar='r.jar')
                b2 = JarBridge.get_or_create(os.path.join(tmp, '.', 'spider.jar'),
                                             runner_jar='r.jar')
        assert b1 is b2, '同 jar 必须复用同一桥'
        real = os.path.normpath(os.path.realpath(jar))
        assert real in jar_bridge._jar_bridges
        assert list(jar_bridge._jar_lru)[-1] == real, 'LRU 必须被刷新到末尾'
    finally:
        for bridge in list(jar_bridge._jar_bridges.values()):
            try:
                bridge.destroy()
            except Exception:
                pass
        restore()
        _rmtree(tmp)


def test_cleanup_jvm_cookie_files_scopes():
    """cookie 清理：全局兜底清所有 *_cookie.txt；按 jar 只清摘要名；bare 追加裸名。"""
    tmp = tempfile.mkdtemp(prefix='cookie_')
    try:
        jar_path = os.path.join(tmp, 'spider.jar')
        digest = hashlib.sha1(jar_path.encode('utf-8', 'replace')).hexdigest()[:10]
        names = list(jar_bridge._BARE_JVM_COOKIE_NAMES) + [
            'spider.jar_%s_cookie.txt' % digest,
            'other.jar_deadbeef_cookie.txt', 'keep-me.txt']
        for name in names:
            with open(os.path.join(tmp, name), 'w', encoding='utf-8') as f:
                f.write('secret')
        with mock.patch.object(jar_bridge, '_JVM_COOKIE_DIR', tmp):
            jar_bridge.cleanup_jvm_cookie_files(jar_path)
            assert os.path.isfile(os.path.join(tmp, 'quark_cookie.txt')), \
                '按 jar 清理（非 bare）不得动裸名文件'
            assert not os.path.exists(os.path.join(tmp, 'spider.jar_%s_cookie.txt' % digest)), \
                '摘要名文件必须被清理'
            assert os.path.isfile(os.path.join(tmp, 'other.jar_deadbeef_cookie.txt')), \
                '其他 jar 的登录态不得被误删'

            jar_bridge.cleanup_jvm_cookie_files(jar_path, bare=True)
            for bare in jar_bridge._BARE_JVM_COOKIE_NAMES:
                assert not os.path.exists(os.path.join(tmp, bare)), \
                    'bare 模式必须清理裸名 %s' % bare
            assert os.path.isfile(os.path.join(tmp, 'keep-me.txt')), '非 cookie 文件不得动'

            jar_bridge.cleanup_jvm_cookie_files()
            assert not os.path.exists(os.path.join(tmp, 'other.jar_deadbeef_cookie.txt')), \
                '全局兜底必须清所有 *_cookie.txt'
        with mock.patch.object(jar_bridge, '_JVM_COOKIE_DIR',
                               os.path.join(tmp, 'not-a-dir')):
            jar_bridge.cleanup_jvm_cookie_files('x.jar', bare=True)  # 目录不存在：静默
    finally:
        _rmtree(tmp)


def test_cleanup_cookie_after_kill_requires_no_live_sibling():
    """同 jar 存在其它存活桥时不得清理裸名 cookie（避免误删存活 JVM 的登录态）。"""
    tmp = tempfile.mkdtemp(prefix='cookie2_')
    restore = _swap_registry()
    try:
        jar_path = os.path.join(tmp, 'spider.jar')
        bridge = _new_bridge(jar_path=jar_path)
        sibling = _bridge_with_proc(_FakeProc(alive=True), jar_path=jar_path)
        jar_bridge._jar_bridges[jar_path] = sibling
        with mock.patch.object(jar_bridge, '_JVM_COOKIE_DIR', tmp):
            with mock.patch.object(jar_bridge, 'cleanup_jvm_cookie_files') as cleanup:
                bridge._cleanup_cookie_files_after_kill()
        assert not cleanup.called, '同 jar 有存活桥时必须放弃清理'

        sibling.proc._alive = False  # 兄弟桥进程已死 → 允许清理
        with mock.patch.object(jar_bridge, '_JVM_COOKIE_DIR', tmp):
            with mock.patch.object(jar_bridge, 'cleanup_jvm_cookie_files') as cleanup2:
                bridge._cleanup_cookie_files_after_kill()
        assert cleanup2.called, '兄弟桥已死时必须清理'
        assert cleanup2.call_args[0][0] == jar_path
        assert cleanup2.call_args[1] == {'bare': True}, cleanup2.call_args
    finally:
        restore()
        _rmtree(tmp)


def test_cookie_cleanup_is_idempotent_and_concurrent():
    """清理幂等：并发多次调用不抛异常，重复调用无副作用。"""
    tmp = tempfile.mkdtemp(prefix='cookie3_')
    try:
        with open(os.path.join(tmp, 'quark_cookie.txt'), 'w', encoding='utf-8') as f:
            f.write('x')
        with mock.patch.object(jar_bridge, '_JVM_COOKIE_DIR', tmp):
            jar_bridge.cleanup_jvm_cookie_files(bare=True)
            jar_bridge.cleanup_jvm_cookie_files(bare=True)  # 幂等
            errors = []
            threads = [threading.Thread(target=lambda: _safe_cleanup(errors))
                       for _ in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=10)
            assert not errors, errors
        assert not os.path.exists(os.path.join(tmp, 'quark_cookie.txt'))
    finally:
        _rmtree(tmp)


def _safe_cleanup(errors):
    try:
        jar_bridge.cleanup_jvm_cookie_files(bare=True)
    except Exception as exc:  # pragma: no cover - 仅收集
        errors.append(repr(exc))


# ============================================================================
# 第九节：JarSpider 动作分发与错误传播
# ============================================================================

def _spider(bridge, class_name='csp_X', site_key='k'):
    spider = JarSpider.__new__(JarSpider)
    spider.bridge = bridge
    spider.class_name = class_name
    spider.site_key = site_key
    spider._inited = True
    spider.site_name = 'X'
    return spider


def test_spider_call_dispatches_expected_method_names():
    """JarSpider 各方法 → 桥 method 名与参数形态一一对应。"""
    seen = []

    class B:
        def call(self, method, *args, class_name='', pan_cookies=None):
            seen.append((method, args, class_name))
            return None

    spider = _spider(B())
    spider.homeContent(True)
    spider.homeVideoContent('3')
    spider.categoryContent('t', '2', False, {'a': 1})
    spider.detailContent(['i1'])
    spider.searchContent('kw', False, '2')
    spider.isVideoFormat('http://v/1.mp4')
    spider.manualVideoCheck()
    spider.liveContent('http://live')
    methods = [m for m, _a, _c in seen]
    assert methods == ['homeContent', 'homeVideoContent', 'categoryContent',
                       'detailContent', 'searchContent', 'isVideoFormat',
                       'manualVideoCheck', 'liveContent'], methods
    assert seen[0][1] == (True,)
    assert seen[1][1] == ('3',)
    assert seen[2][1] == ('t', '2', False, {'a': 1})
    assert seen[3][1] == (['i1'],)
    assert seen[4][1] == ('kw', False, '2')
    assert all(c == 'csp_X' for _m, _a, c in seen)


def test_spider_auto_init_runs_once_and_never_repeats():
    """自动 init：首调前触发一次；失败也标记已初始化，绝不每次调用都 init。"""
    calls = []

    class B:
        def call(self, method, *args, class_name='', pan_cookies=None):
            calls.append(method)
            if method == 'init':
                raise RuntimeError('init exploded')
            return '{"list":[]}'

    spider = _spider(B())
    spider._inited = False
    spider._ext = ''
    spider.homeContent(True)
    spider.homeContent(True)
    assert calls == ['init', 'homeContent', 'homeContent'], calls
    assert spider._inited is True, 'init 失败也必须标记已初始化'


def test_spider_init_ext_normalization():
    """init 的 extend 归一：None/str/dict/空 dict/其它类型各自的序列化。"""
    class B:
        def __init__(self):
            self.args = []

        def call(self, method, *args, class_name='', pan_cookies=None):
            self.args.append((method, args))
            return None

    for value, expect in ((None, ''), (' raw ', 'raw'), ({'a': 1}, '{"a": 1}'),
                          ({}, ''), (42, '42')):
        bridge = B()
        spider = _spider(bridge)
        spider.init(value)
        assert spider._ext == expect, (value, spider._ext, expect)
        assert bridge.args[0][0] == 'init'
        assert bridge.args[0][1] == (expect,), bridge.args


def test_spider_last_error_is_thread_local():
    """last_error 线程局部：A 线程的失败不得附着到 B 线程的成功响应上。"""
    class B:
        def call(self, method, *args, class_name='', pan_cookies=None):
            if method == 'searchContent':
                raise RuntimeError('site A down')
            return '{"list":[]}'

    spider = _spider(B())
    box = {}

    def fail_then_read():
        spider.searchContent('kw', False)
        box['failed'] = spider.last_error

    thread = threading.Thread(target=fail_then_read)
    thread.start()
    thread.join(timeout=5)
    assert 'site A down' in box.get('failed', ''), box
    assert spider.last_error == '', '主线程不得看到别的线程的错误'


def test_spider_json_ext_and_local_proxy_shapes():
    """jsonExt 传 (key, dict, url)；localProxy 把 dict 结果 JSON 解析回 dict。"""
    class B:
        def call(self, method, *args, class_name='', pan_cookies=None):
            if method == '__json_ext':
                assert args == ('k', {'json': 'u'}, 'http://url'), args
                return '{"ok":1}'
            if method == 'proxy':
                assert args == (json.dumps({'a': 1}, ensure_ascii=False),), args
                return '{"b":2}'
            return None

    spider = _spider(B())
    assert spider.jsonExt('k', {'json': 'u'}, 'http://url') == '{"ok":1}'
    assert spider.localProxy({'a': 1}) == {'b': 2}

    # 空入参归一：key/url → ''，jxs → {}，再原样传给桥（参数形态可被断言）
    class Recorder:
        def call(self, method, *args, class_name='', pan_cookies=None):
            assert method == '__json_ext', method
            assert args == ('', {}, ''), args
            return '{}'

    assert _spider(Recorder()).jsonExt('', None, '') == '{}'


def test_local_proxy_returns_raw_on_non_json_and_none_on_null():
    """localProxy：非 JSON 原样返回字符串；桥返回 None 时返回 None。"""
    class B:
        def __init__(self, payload):
            self.payload = payload

        def call(self, method, *args, class_name='', pan_cookies=None):
            return self.payload

    spider = _spider(B('not-json'))
    assert spider.localProxy({}) == 'not-json'
    spider.bridge = B(None)
    assert spider.localProxy({}) is None


def test_proxy_static_falls_back_to_instance_proxy():
    """bridge 为 None 返回 None；静态 Proxy 抛异常时退回实例 proxy(String)。"""
    spider = _spider(None)
    assert spider.proxy_static({'a': 1}) is None

    class B:
        def call_proxy(self, params=None, class_name='', pan_cookies=None):
            raise RuntimeError('static proxy unavailable')

        def call(self, method, *args, class_name='', pan_cookies=None):
            assert method == 'proxy', method
            return '{"fallback":true}'

    spider.bridge = B()
    with mock.patch('jar_spider._load_pan_cookies', return_value=None):
        assert spider.proxy_static({'a': 1}) == {'fallback': True}


def test_spider_destroy_is_best_effort():
    """destroy：桥异常被吞；bridge=None 直接返回（spider 级清理不杀进程）。"""
    spider = _spider(None)
    spider.destroy()  # 不得抛

    class B:
        def call(self, method, *args, class_name='', pan_cookies=None):
            raise RuntimeError('already gone')

    spider.bridge = B()
    spider.destroy()  # 不得抛


def test_ensure_local_proxy_ports_and_normalize_scheme():
    """机制A：本机端口播放地址触发 ensure_listener；proxy:// 走网关归一。"""
    from jar_spider import _ensure_local_proxy_ports, _normalize_proxy_scheme

    got = []
    with mock.patch('go_proxy.ensure_listener',
                    side_effect=lambda p: got.append(p) or True):
        assert _ensure_local_proxy_ports({'url': 'http://127.0.0.1:7777/a.m3u8'}) == \
            {'url': 'http://127.0.0.1:7777/a.m3u8'}
        _ensure_local_proxy_ports({'url': 'https://cdn.example.com/a.m3u8'})
        _ensure_local_proxy_ports({'url': 'http://10.0.0.1:7777/a'})
        _ensure_local_proxy_ports('not-a-dict')
        _ensure_local_proxy_ports({'url': 123})
    assert got == [7777], got

    with mock.patch('go_proxy.ensure_listener', side_effect=OSError('port busy')):
        assert _ensure_local_proxy_ports({'url': 'http://127.0.0.1:8888/a'}) is not None

    with mock.patch.object(hoststate, 'get_proxy_url',
                           return_value='http://127.0.0.1:19761/proxy'):
        with mock.patch.object(hoststate, 'get_token', return_value='tk'):
            out = _normalize_proxy_scheme({'url': 'proxy://do=live&ext=x'}, 'site-a')
    assert out['url'].startswith('http://127.0.0.1:19761/proxy?'), out
    assert out['parse'] == 0
    assert _normalize_proxy_scheme({'url': 'http://x/y.m3u8'}, 's') == \
        {'url': 'http://x/y.m3u8'}
    assert _normalize_proxy_scheme('not-a-dict', 's') == 'not-a-dict'
    assert _normalize_proxy_scheme({'url': 'proxy://'}, 's') == {'url': 'proxy://'}
    assert _normalize_proxy_scheme({'url': 'proxy://http://a/b?c'}, 's') == \
        {'url': 'proxy://http://a/b?c'}, '不可解析的自定义 scheme 必须原样保留'


def test_quark_play_params_variants():
    """_quark_play_params：分享链接 / 五段不透明 id / JSON 对象 / 嵌套 / 不可解析。"""
    assert JarSpider._quark_play_params('https://pan.quark.cn/s/abcd') == \
        {'fileId': 'https://pan.quark.cn/s/abcd'}
    assert JarSpider._quark_play_params('') is None
    assert JarSpider._quark_play_params(None) is None

    opaque = 'a' * 32 + '++' + 'b' * 32 + '++' + 'pwd123456789' + '++' + 'tok' + '++' + '99'
    got = JarSpider._quark_play_params(opaque)
    assert got['shareId'] == 'a' * 32 and got['fileId'] == 'b' * 32
    assert got['fileToken'] == 'tok' and got['pwdId'] == 'pwd123456789', got

    opaque2 = 'a' * 32 + '++' + 'b' * 32 + '++' + 'c' * 32 + '++' + 'tok' + '++' + '1'
    assert 'pwdId' not in JarSpider._quark_play_params(opaque2), '32 位 hex 第三段不猜 pwdId'

    obj = json.dumps({'folder': 'fid1', 'share_id': 'sid1', 'fid_token': 'ft'})
    assert JarSpider._quark_play_params(obj) == \
        {'fileId': 'fid1', 'shareId': 'sid1', 'fileToken': 'ft'}

    # 嵌套结构：objects() 由外层向内 yield，最外层的 list 自身不是 dict，
    # 因此首个候选就是整串文本（fileId 回落为原始串）——记录这条既有行为，
    # 避免误以为嵌套 JSON 能被拆解。
    nested = json.dumps([{'x': {'file_id': 'f2', 'shareId': 's2',
                                'shareUrl': 'https://pan.quark.cn/s/zzz'}}])
    assert JarSpider._quark_play_params(nested) == {'fileId': nested}, nested

    # dict 顶层 + 内层 dict：仍取最外层，且不会带上内层的 shareId
    outer = json.dumps({'fid': 'f3', 'inner': {'shareId': 's3'}})
    assert JarSpider._quark_play_params(outer) == \
        {'fileId': 'f3', 'shareId': '', 'fileToken': ''}, outer

    encoded = __import__('urllib.parse', fromlist=['quote']).quote(obj)
    assert JarSpider._quark_play_params(encoded)['fileId'] == 'fid1'
    assert JarSpider._quark_play_params('garbage') is None, '不可解析返回 None'
    assert JarSpider._quark_play_params(json.dumps([{'no': 'id'}])) is None


def test_pan_resolvable_and_vod_id_shape():
    """_pan_resolvable：无 shareId 可解；有 shareId 必须有 pwdId 或 shareUrl。"""
    assert JarSpider._pan_resolvable({'fileId': 'f'}) is True
    assert JarSpider._pan_resolvable({'fileId': 'f', 'shareId': 's', 'pwdId': 'p'}) is True
    assert JarSpider._pan_resolvable({'fileId': 'f', 'shareId': 's',
                                      'shareUrl': 'https://pan.quark.cn/s/x'}) is True
    assert JarSpider._pan_resolvable({'fileId': 'f', 'shareId': 's'}) is False
    assert JarSpider._pan_resolvable({'shareId': 's'}) is False, '缺 fileId 一律不可解'
    assert JarSpider._pan_resolvable(None) is False
    assert JarSpider._pan_resolvable({}) is False

    assert JarSpider._vod_id_shape('') == 'empty'
    assert JarSpider._vod_id_shape(None) == 'empty'
    shape = JarSpider._vod_id_shape('a' * 32 + '++' + 'b' * 32 + '++tok++1')
    assert shape.startswith('opaque parts=4 lens='), shape
    assert JarSpider._vod_id_shape(json.dumps({'folder': 'f', 'shareId': 's'})) == \
        'params=fileId,shareId'
    assert JarSpider._vod_id_shape('garbage').startswith('unknown len=')


def test_quark_pan_url_and_legacy_detection():
    """_quark_pan_url 带 do=pan/site/token；旧 go-proxy 与裸 CDN 识别。"""
    with mock.patch.object(hoststate, 'get_token', return_value='tok-1'):
        url = JarSpider._quark_pan_url({'fileId': 'f', 'shareId': 's',
                                        'fileToken': 't', 'pwdId': 'p'}, flag='超清')
    assert url.startswith('http://127.0.0.1:9978/proxy?'), url
    assert 'do=pan' in url and 'site=quark' in url and 'token=tok-1' in url
    assert 'fileId=f' in url and 'shareId=s' in url and 'pwdId=p' in url
    assert 'quality=' in url, '线路名必须编码透传'
    assert JarSpider._quark_pan_url(None) is None
    assert JarSpider._quark_pan_url({'shareId': 's'}) is None, '缺 fileId 返回 None'

    assert JarSpider._is_legacy_go_proxy_url(
        'http://127.0.0.1:9978/proxy?url=http%3A%2F%2Fcdn&proxytype=go') is True
    assert JarSpider._is_legacy_go_proxy_url(
        'http://127.0.0.1:7944/proxy?url=x&proxytype=go') is True
    assert JarSpider._is_legacy_go_proxy_url(
        'http://127.0.0.1:9978/proxy?proxytype=go') is False
    assert JarSpider._is_legacy_go_proxy_url(
        'http://127.0.0.1:8080/proxy?url=x&proxytype=go') is False
    assert JarSpider._is_legacy_go_proxy_url('https://cdn.example.com/a.m3u8') is False
    assert JarSpider._is_legacy_go_proxy_url('not-a-url') is False

    assert JarSpider._is_bare_quark_cdn_url('https://a.quark.cn/x.m3u8') is True
    assert JarSpider._is_bare_quark_cdn_url('https://x.myquark.cn/y') is True
    assert JarSpider._is_bare_quark_cdn_url('https://a.uc.cn/y') is True
    assert JarSpider._is_bare_quark_cdn_url('https://cdn.example.com/y') is False
    assert JarSpider._is_bare_quark_cdn_url('ftp://a.quark.cn/y') is False

    wrapped = JarSpider._wrap_local_go_proxy('https://a.quark.cn/x?sign=1')
    assert wrapped.startswith('http://127.0.0.1:9978/proxy?')
    assert 'proxytype=go' in wrapped and 'thread=8' in wrapped
    assert JarSpider._quark_folder_id(
        json.dumps({'fid': 'ff', 'shareId': 'ss'})) == ('ff', 'ss')


def test_load_pan_cookies_and_quark_presence():
    """_load_pan_cookies / _quark_cookie_present：读取失败与空值的兜底。"""
    with mock.patch('pan_cookies.load_pan_cookies', return_value={'quark': 'ck'}):
        assert _load_pan_cookies() == {'quark': 'ck'}
    with mock.patch('pan_cookies.load_pan_cookies', side_effect=OSError('no file')):
        assert _load_pan_cookies() is None
    with mock.patch('pan_cookies.load_pan_cookies', return_value={}):
        assert _load_pan_cookies() is None

    from jar_spider import _quark_cookie_present
    with mock.patch('jar_spider._load_pan_cookies', return_value={'quark': 'ck'}):
        assert _quark_cookie_present() is True
    with mock.patch('jar_spider._load_pan_cookies', return_value={'quark': '   '}):
        assert _quark_cookie_present() is False
    with mock.patch('jar_spider._load_pan_cookies', return_value=None):
        assert _quark_cookie_present() is False


# ============================================================================
# 第十节：运行期预算与取消
# ============================================================================

def test_runtime_budget_defaults_and_clamps():
    """_runtime_budget_seconds：无请求用 CALL_TIMEOUT；有请求按剩余时间 clamp。"""
    with mock.patch.object(jar_bridge, 'current_runtime_request', return_value=None):
        assert jar_bridge._runtime_budget_seconds() == float(jar_bridge.CALL_TIMEOUT)
        assert jar_bridge._runtime_budget_seconds(5) == 5.0

    req = mock.Mock()
    req.remaining_ms = 1500
    with mock.patch.object(jar_bridge, 'current_runtime_request', return_value=req):
        assert jar_bridge._runtime_budget_seconds() == 1.5
        assert jar_bridge._runtime_budget_seconds(10) == 1.5, '不得超过剩余预算'
        req.remaining_ms = 0
        assert jar_bridge._runtime_budget_seconds() == 0.001, '必须 clamp 到最小 1ms'
    assert req.raise_if_cancelled.called, '取预算时必须检查取消'


def test_cancelled_request_raises_before_frame_write():
    """已取消的请求：在写帧之前抛错，绝不向 JVM 发送已作废的请求。"""
    bridge = _bridge_with_proc(_FakeProc())
    bridge._ensure_alive = lambda: True
    req = mock.Mock()
    req.raise_if_cancelled.side_effect = RuntimeError('L3_RUNTIME_CANCELLED')
    with mock.patch.object(jar_bridge, 'current_runtime_request', return_value=req):
        try:
            bridge._call_inner('homeContent', True)
        except RuntimeError as e:
            assert 'CANCELLED' in str(e), str(e)
        else:
            assert False, '已取消请求必须抛错'
    assert bytes(bridge.proc.stdin.written) == b'', '取消后不得写 stdin'


def test_runtime_trace_fields_fallback():
    """_runtime_trace_fields：无请求或异常时返回空串占位的两个字段。"""
    with mock.patch.object(rt_contracts, 'current_runtime_request', return_value=None):
        assert jar_bridge._runtime_trace_fields() == {'requestId': '', 'playSessionId': ''}

    req = mock.Mock()
    req.request_id = 'r-1'
    req.play_session_id = 'p-1'
    with mock.patch.object(rt_contracts, 'current_runtime_request', return_value=req):
        assert jar_bridge._runtime_trace_fields() == {'requestId': 'r-1',
                                                      'playSessionId': 'p-1'}

    with mock.patch.object(rt_contracts, 'current_runtime_request',
                           side_effect=RuntimeError('boom')):
        assert jar_bridge._runtime_trace_fields() == {'requestId': '', 'playSessionId': ''}


def test_jar_download_lock_is_per_url():
    """下载锁按 URL 分桶：同 URL 同一把锁，不同 URL 互不相干。"""
    a1 = jar_bridge._jar_download_lock('https://x/a.jar')
    a2 = jar_bridge._jar_download_lock('https://x/a.jar')
    b1 = jar_bridge._jar_download_lock('https://x/b.jar')
    assert a1 is a2
    assert a1 is not b1


def test_classify_jar_compatibility_levels():
    """兼容性分级：L0 纯 class / L1 dex / L2 android-ui / L3 native / L4 drm 边界。"""
    tmp = tempfile.mkdtemp(prefix='compat_')
    try:
        plain = os.path.join(tmp, 'plain.jar')
        with zipfile.ZipFile(plain, 'w') as z:
            z.writestr('com/a/B.class', b'hello world')
        assert jar_bridge.classify_jar_compatibility(plain)['level'] == 'L0'

        dex = os.path.join(tmp, 'dex.jar')
        with zipfile.ZipFile(dex, 'w') as z:
            z.writestr('classes.dex', b'dex\n035\x00')
        assert jar_bridge.classify_jar_compatibility(dex)['level'] == 'L1'

        ui = os.path.join(tmp, 'ui.jar')
        with zipfile.ZipFile(ui, 'w') as z:
            z.writestr('com/a/C.class', b'android/webkit/WebView')
        assert jar_bridge.classify_jar_compatibility(ui)['level'] == 'L2'

        nat = os.path.join(tmp, 'nat.jar')
        with zipfile.ZipFile(nat, 'w') as z:
            z.writestr('lib/arm/libx.so', b'')
        assert jar_bridge.classify_jar_compatibility(nat)['level'] == 'L3'

        drm = os.path.join(tmp, 'drm.jar')
        with zipfile.ZipFile(drm, 'w') as z:
            z.writestr('com/a/D.class', b'widevine')
        assert jar_bridge.classify_jar_compatibility(drm)['level'] == 'L4'

        raw = os.path.join(tmp, 'raw.dex')
        with open(raw, 'wb') as f:
            f.write(b'dex\n035\x00android/view/View')
        assert jar_bridge.classify_jar_compatibility(raw)['level'] == 'L1'

        report = jar_bridge.classify_jar_compatibility(os.path.join(tmp, 'missing.jar'))
        assert report['level'] == 'L0' and 'unreadable' in report['signals'], report
    finally:
        _rmtree(tmp)


# ============================================================================
# runner
# ============================================================================

if __name__ == '__main__':
    tests = [(name, fn) for name, fn in sorted(globals().items())
             if name.startswith('test_') and callable(fn)]
    failed = []
    for name, fn in tests:
        try:
            fn()
            print('PASS %s' % name)
        except Exception as exc:  # noqa: BLE001 - 汇总 runner 需捕获全部
            failed.append((name, exc))
            print('FAIL %s: %r' % (name, exc))
    print()
    print('RESULT: %d passed, %d failed, total %d'
          % (len(tests) - len(failed), len(failed), len(tests)))
    sys.exit(1 if failed else 0)
