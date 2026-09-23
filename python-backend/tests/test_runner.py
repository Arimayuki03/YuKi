# -*- coding: utf-8 -*-
"""runner.py 白盒单元测试（CatVod 契约恢复源码 + 运行时请求上下文贯穿）。

Runner 是 Site 级单例（config._assemble 每站点一个），同一站点会并发处理多个
请求（多集预加载 / 自动换线路 + 用户手动点击，/action 走 16 并发 threadpool）。
因此本文件的重点不是"转发是否正确"，而是三个易被改坏的不变量：
  1. 上下文注入：request_id / play_session_id 必须贯穿到 spider 实例与 TLS 诊断位；
  2. 线程性：诊断位必须是线程本地，否则"最后写入者获胜"会让排障指向错误请求；
  3. 取消语义：取消/超时的请求不得再打到 spider（浪费一次远程调用）。

刻意不含真实 sleep / 真实出网：时间推进全部靠直接改 RuntimeRequest.created_at，
或让 spider 自己等 threading.Event（事件由测试立刻 set）。

与既有测试的互补关系：
- test_runtime_contract.py：RuntimeRequest/Response 本身的创建与错误映射；
- 本文件：钉 Runner 如何利用/贯穿这个上下文（私有分支 _invoke/_remember_request、
  homeVideoContent 的签名预检与降级、proxy 的 static 优先）。

用法：<venv>/python python-backend/tests/test_runner.py
"""
import inspect
import os
import sys
import threading
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, BASE)

from runner import Runner  # noqa: E402
from runtime.contracts import RuntimeRequest, bind_runtime_request, current_runtime_request  # noqa: E402
from runtime.errors import RuntimeError  # noqa: E402


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------
class Rec:
    """记录 (方法名, 位置参数)，并记录注入时刻看到的上下文。"""

    def __init__(self, result=None, raises=None, gate=None):
        self.calls = []
        self.seen_request_id = []
        self.seen_play_session_id = []
        self._result = result
        self._raises = raises
        self._gate = gate            # threading.Event：给并发用例一个可控的阻塞点

    def __getattr__(self, name):
        def _fn(*args):
            self.calls.append((name, args))
            req = current_runtime_request()
            self.seen_request_id.append(getattr(req, 'request_id', None))
            self.seen_play_session_id.append(getattr(req, 'play_session_id', None))
            if self._raises:
                raise self._raises
            if self._gate is not None:
                self._gate.wait(timeout=5)
            return self._result
        return _fn


def _rid(tag):
    """request_id 需满足 ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$ 才会被原样保留。"""
    return 'req-%s-0001' % tag


def _psid(tag):
    return 'ses-%s-0001' % tag


# ---------------------------------------------------------------------------
# 无上下文：纯转发
# ---------------------------------------------------------------------------
def test_runner_forwards_without_context():
    """没有绑定 RuntimeRequest 时，Runner 是纯转发层：不注入、不报错。"""
    sp = Rec('R')
    r = Runner(sp)
    assert r.homeContent(False) == 'R'
    assert r.getName() == 'R'
    assert r.getDependence() == 'R'
    assert r.init('ext') == 'R'
    assert sp.calls == [('homeContent', (False,)), ('getName', ()),
                        ('getDependence', ()), ('init', ('ext',))]
    assert sp.seen_request_id == [None] * 4


def test_runner_init_default_extend_empty():
    """init 的 extend 缺省为 ''（CatVod 契约），不传 None 给 spider。"""
    sp = Rec()
    Runner(sp).init()
    assert sp.calls == [('init', ('',))]


def test_runner_argument_positions_are_pinned():
    """各方法的位置参数顺序是 CatVod 契约，调换即跨站串参。"""
    sp = Rec('R')
    r = Runner(sp)
    r.homeContent(True)
    r.categoryContent('tid', '2', True, {})
    r.detailContent(['id-1'])
    r.searchContent('关', '0')
    r.playerContent('flag', 'id', [])
    r.jsonExt('key', 'jx', 'http://u')
    r.liveContent('http://live')
    r.localProxy({'p': 1})
    r.isVideoFormat('a.m3u8')
    r.manualVideoCheck()
    r.action({'do': 'x'})
    r.destroy()
    assert sp.calls == [
        ('homeContent', (True,)),
        ('categoryContent', ('tid', '2', True, {})),
        ('detailContent', (['id-1'],)),
        ('searchContent', ('关', '0', '1')),
        ('playerContent', ('flag', 'id', [])),
        ('jsonExt', ('key', 'jx', 'http://u')),
        ('liveContent', ('http://live',)),
        ('localProxy', ({'p': 1},)),
        ('isVideoFormat', ('a.m3u8',)),
        ('manualVideoCheck', ()),
        ('action', ({'do': 'x'},)),
        ('destroy', ()),
    ]


def test_runner_search_content_pg_default_and_explicit():
    """searchContent 的 pg 默认 '1'；显式值原样透传（不转 int）。"""
    sp = Rec('R')
    r = Runner(sp)
    r.searchContent('k', '0')
    r.searchContent('k', '0', '5')
    assert sp.calls == [('searchContent', ('k', '0', '1')),
                        ('searchContent', ('k', '0', '5'))]


# ---------------------------------------------------------------------------
# homeVideoContent：签名预检（L-20）
# ---------------------------------------------------------------------------
def test_runner_home_video_content_new_signature():
    """新签名（接受 pg）：把 pg 传下去，且只调用一次。"""
    sp = Rec('R')
    r = Runner(sp)
    assert r.homeVideoContent('3') == 'R'
    assert sp.calls == [('homeVideoContent', ('3',))]
    assert len(sp.calls) == 1, '不得因签名预检触发二次调用'


def test_runner_home_video_content_legacy_signature():
    """旧签名（无参数）：不带 pg 调用，且只调用一次。"""
    sp = Rec('R')

    class Legacy:
        def __init__(self, rec):
            self._rec = rec

        def homeVideoContent(self):        # 旧爬虫：不接 pg
            return self._rec.homeVideoContent()

    r = Runner(Legacy(sp))
    assert r.homeVideoContent('3') == 'R'
    assert sp.calls == [('homeVideoContent', ())]
    assert len(sp.calls) == 1


def test_runner_home_video_content_business_typeerror_not_swallowed():
    """L-20 核心：业务代码抛的 TypeError 不得被误判成"旧签名"而二次调用。

    旧实现用 except TypeError 兜底，spider 内部的 TypeError 会触发第二次调用，
    副作用（一次远程请求 / 一次计费）翻倍。
    """
    attempts = []

    class Boom:
        def homeVideoContent(self, pg='1'):
            attempts.append(pg)
            raise TypeError('内部 bug：拼包时 int + str')

    try:
        Runner(Boom()).homeVideoContent('2')
        assert False, '业务 TypeError 必须上抛'
    except TypeError as e:
        assert '内部 bug' in str(e)
    assert attempts == ['2'], '只允许一次调用，实际 %r' % attempts


def test_runner_home_video_content_signature_probe_failures_default_to_pg():
    """inspect.signature 不可用（TypeError/ValueError，如 C 扩展方法）→ 按新签名处理。"""
    for exc in (TypeError('no signature'), ValueError('no signature')):
        sp = Rec('R')
        r = Runner(sp)
        with mock.patch.object(inspect, 'signature', side_effect=exc):
            assert r.homeVideoContent('9') == 'R'
        assert sp.calls == [('homeVideoContent', ('9',))], '%s: %r' % (exc, sp.calls)


def test_runner_home_video_content_varargs_counts_as_accepting():
    """签名预检只看参数个数：*args 型旧签名（n=1）会收到 pg，且能正常接受。

    n>=1 的判定对 VAR_POSITIONAL 恰好正确——旧爬虫写 def f(*args) 时传 pg 无误。
    """
    sp = Rec('R')

    class VarArgs:
        def __init__(self, rec):
            self._rec = rec

        def homeVideoContent(self, *args):
            return self._rec.homeVideoContent(*args)

    r = Runner(VarArgs(sp))
    assert r.homeVideoContent('4') == 'R'
    assert sp.calls == [('homeVideoContent', ('4',))]


def test_runner_home_video_content_kwargs_only_signature_breaks():
    """已知边界（非回归目标，仅记录）：纯 **kw 签名也被算成 n=1，于是被按位置传 pg
    并抛 TypeError。旧实现（except TypeError 兜底）在这里反而"能跑"——会退化为
    无参二次调用并成功。L-20 用签名预检换掉 except 后，此形态从静默降级变成显错。

    影响面极小（真实 spider 不会只写 **kw），但跨端对齐时需知情。
    """
    class KwOnly:
        def homeVideoContent(self, **kw):
            return 'never'

    try:
        Runner(KwOnly()).homeVideoContent('4')
        assert False, '纯 **kw 签名会接到位置参数并抛 TypeError'
    except TypeError as e:
        assert 'positional argument' in str(e)


# ---------------------------------------------------------------------------
# 上下文贯穿与 TLS 诊断位
# ---------------------------------------------------------------------------
def test_runner_injects_context_into_spider_and_tls():
    """绑定上下文后：spider 实例拿到 request_id/play_session_id，TLS 诊断位同步。"""
    sp = Rec('R')
    r = Runner(sp)
    request = RuntimeRequest.create(request_id=_rid('ctx'), method='homeContent',
                                    play_session_id=_psid('ctx'))
    with bind_runtime_request(request):
        assert r.homeContent(False) == 'R'
        assert sp.request_id == request.request_id
        assert sp.play_session_id == request.play_session_id
        assert r.last_request_id == request.request_id
        assert r.last_play_session_id == request.play_session_id
    # contextvar 退出后已清空，但 TLS 诊断位必须仍能读到"刚才那次"
    assert current_runtime_request() is None
    assert r.last_request_id == request.request_id
    assert r.last_play_session_id == request.play_session_id


def test_runner_diagnostic_slots_default_empty():
    """未处理过任何请求时，诊断位为空串（不是 None）——避免 f-string 打出 'None'。"""
    r = Runner(Rec())
    assert r.last_request_id == ''
    assert r.last_play_session_id == ''


def test_runner_tls_is_per_thread_not_last_writer_wins():
    """Runner 是 Site 级单例：并发下诊断位必须按线程隔离，不得最后写入者获胜。"""
    sp = Rec('R', gate=None)
    runner = Runner(sp)
    gate = threading.Event()
    sp._gate = gate

    results = {}
    barrier = threading.Barrier(3)

    def worker(tag):
        request = RuntimeRequest.create(request_id=_rid(tag), method='homeContent',
                                        play_session_id=_psid(tag))
        barrier.wait()
        with bind_runtime_request(request):
            runner.homeContent(False)
        results[tag] = (runner.last_request_id, runner.last_play_session_id)
        gate.set()

    threads = [threading.Thread(target=worker, args=(t,)) for t in ('aaa', 'bbb')]
    for t in threads:
        t.start()
    barrier.wait()
    gate.set()
    for t in threads:
        t.join(timeout=5)
    assert not any(t.is_alive() for t in threads)
    assert results['aaa'] == (_rid('aaa'), _psid('aaa')), results
    assert results['bbb'] == (_rid('bbb'), _psid('bbb')), results
    # 主线程从未处理请求，诊断位必须仍为空（不被任一 worker 污染）
    assert runner.last_request_id == ''


def test_runner_spider_attribute_injection_failure_is_tolerated():
    """给 spider 打属性失败（__slots__ / 只读 property）不得影响正常返回。"""
    class Slotted:
        __slots__ = ('calls',)

        def __init__(self):
            self.calls = []

        def homeContent(self, _f):
            self.calls.append(current_runtime_request().request_id)
            return 'OK'

    sp = Slotted()
    request = RuntimeRequest.create(request_id=_rid('slot'), method='homeContent')
    with bind_runtime_request(request):
        assert Runner(sp).homeContent(False) == 'OK'
    assert sp.calls == [request.request_id]     # 上下文照样贯穿（spider 自己读）


# ---------------------------------------------------------------------------
# 取消 / 超时
# ---------------------------------------------------------------------------
def test_runner_cancelled_request_never_reaches_spider():
    """请求进入前就已取消：spider 完全不被调用，省掉一次远程调用。"""
    sp = Rec('R')
    request = RuntimeRequest.create(request_id=_rid('cancel'), method='homeContent')
    request.cancel()
    try:
        with bind_runtime_request(request):
            Runner(sp).homeContent(False)
        assert False, '已取消请求必须抛错'
    except RuntimeError as e:
        assert e.code == 'L3_RUNTIME_CANCELLED'
    assert sp.calls == []


def test_runner_expired_deadline_raises_timeout_before_calling_spider():
    """超时判定发生在调用 spider 之前（时间推进用改 created_at，不用 sleep）。"""
    sp = Rec('R')
    request = RuntimeRequest.create(request_id=_rid('timeout'), method='homeContent',
                                    deadline_ms=1)
    request.created_at -= 5          # 等价于"已经过了 5 秒"
    assert request.deadline_exceeded
    try:
        with bind_runtime_request(request):
            Runner(sp).homeContent(False)
        assert False, '超时请求必须抛错'
    except RuntimeError as e:
        assert e.code == 'L3_RUNTIME_TIMEOUT'
    assert sp.calls == []


def test_runner_timeout_code_varies_by_method():
    """不同方法的超时错误码不同（init → L2_SITE_TIMEOUT），由 contracts 决定。"""
    sp = Rec('R')
    request = RuntimeRequest.create(request_id=_rid('tinit'), method='init')
    request.created_at -= 999
    try:
        with bind_runtime_request(request):
            Runner(sp).init('ext')
        assert False
    except RuntimeError as e:
        assert e.code == 'L2_SITE_TIMEOUT'
    assert sp.calls == []


def test_runner_spider_exception_propagates_uncaught():
    """spider 抛异常时 Runner 不吞、不包装：交给上层 error_from_exception 收口。"""
    boom = RuntimeError('L3_RUNTIME_CALL_FAILED', stage='runtime')
    sp = Rec(raises=boom)
    try:
        Runner(sp).playerContent('f', 'i', [])
        assert False
    except RuntimeError as e:
        assert e is boom
    assert len(sp.calls) == 1        # 只调用一次，不重试


# ---------------------------------------------------------------------------
# proxy：JAR 静态 Proxy 优先
# ---------------------------------------------------------------------------
def test_runner_proxy_prefers_callable_static():
    """proxy_static 可调用时优先走 JAR 静态 Proxy.proxy(Map)，不碰 localProxy。"""
    sp = Rec('R')
    seen = []

    def _static(param):
        seen.append(param)
        return 'STATIC'

    sp.proxy_static = _static
    assert Runner(sp).proxy({'a': 1}) == 'STATIC'
    assert seen == [{'a': 1}]
    assert sp.calls == []            # localProxy 未被调用


def test_runner_proxy_records_context_without_cancelling():
    """已知分支：static 路径只 _remember_request，不调用 raise_if_cancelled。

    即"静态 proxy 不参与取消判定"——取消中的请求若走 static 仍会执行到底。
    钉住现状：这不是笔误，但跨端对齐时应显式决策。
    """
    sp = Rec('R')
    sp.proxy_static = lambda p: 'STATIC'
    request = RuntimeRequest.create(request_id=_rid('pstatic'), method='proxy')
    request.cancel()
    with bind_runtime_request(request):
        r = Runner(sp)
        assert r.proxy({'a': 1}) == 'STATIC'
        assert r.last_request_id == request.request_id


def test_runner_proxy_falls_back_to_localproxy():
    """没有 proxy_static（或不可调用）→ 回退 localProxy，且取消判定照常生效。

    注意 Rec 的 __getattr__ 会把任何属性访问变成"可调用"，所以"无 static"必须
    用一个刻意不实现 proxy_static 的夹具来表达，否则 static 分支会全部命中。
    """
    class NoStatic:
        def __init__(self):
            self.calls = []

        def localProxy(self, param):
            self.calls.append(param)
            return 'LOCAL'

    sp = NoStatic()
    assert Runner(sp).proxy({'a': 1}) == 'LOCAL'
    assert sp.calls == [{'a': 1}]

    class BadStatic(NoStatic):
        proxy_static = 'not-callable'          # 存在但不可调用 → 仍需回退

    sp2 = BadStatic()
    assert Runner(sp2).proxy({'a': 1}) == 'LOCAL'
    assert sp2.calls == [{'a': 1}]

    sp3 = NoStatic()
    request = RuntimeRequest.create(request_id=_rid('pfall'), method='proxy')
    request.cancel()
    try:
        with bind_runtime_request(request):
            Runner(sp3).proxy({'a': 1})
        assert False, '回退路径必须做取消判定'
    except RuntimeError as e:
        assert e.code == 'L3_RUNTIME_CANCELLED'
    assert sp3.calls == []


def test_runner_proxy_missing_localproxy_raises_attributeerror():
    """既无 static 又无 localProxy：AttributeError 上抛（不静默返回 None）。"""
    class Bare:
        pass

    try:
        Runner(Bare()).proxy({'a': 1})
        assert False
    except AttributeError as e:
        assert 'localProxy' in str(e)


# ---------------------------------------------------------------------------
# 并发安全
# ---------------------------------------------------------------------------
def test_runner_concurrent_calls_are_isolated_and_all_complete():
    """16 并发打同一个 Runner：每次调用看到的都是自己的上下文，无交叉、无丢失。"""
    sp = Rec('R')
    runner = Runner(sp)
    total = 16
    barrier = threading.Barrier(total)
    observed = {}
    lock = threading.Lock()

    def worker(idx):
        request = RuntimeRequest.create(request_id='req-conc-%04d-0001' % idx,
                                        method='homeContent',
                                        play_session_id='ses-conc-%04d-0001' % idx)
        barrier.wait()
        with bind_runtime_request(request):
            runner.homeContent(False)
            got = (sp.request_id, sp.play_session_id, runner.last_request_id)
        with lock:
            observed[idx] = got

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(total)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)
    assert not any(t.is_alive() for t in threads)
    assert len(sp.calls) == total, len(sp.calls)
    assert len(observed) == total, len(observed)
    for idx, got in observed.items():
        want_id = 'req-conc-%04d-0001' % idx
        assert got[2] == want_id, '诊断位串了: %r' % (got,)


def test_runner_one_bad_call_does_not_poison_later_calls():
    """异常调用不影响后续调用：Runner 无状态残留，诊断位也不被污染。"""
    sp = Rec(raises=ValueError('boom'))
    r = Runner(sp)
    try:
        r.homeContent(False)
        assert False
    except ValueError:
        pass
    sp._raises = None
    sp._result = 'OK'
    request = RuntimeRequest.create(request_id=_rid('recover'), method='homeContent',
                                    play_session_id=_psid('recover'))
    with bind_runtime_request(request):
        assert r.homeContent(False) == 'OK'
    assert r.last_request_id == request.request_id
    assert len(sp.calls) == 2        # 失败那次确实转发了，之后能正常恢复


if __name__ == '__main__':
    failed = []
    count = 0
    for name in sorted(list(globals())):
        fn = globals()[name]
        if name.startswith('test_') and callable(fn):
            count += 1
            try:
                fn()
                print('PASS %s' % name)
            except Exception as exc:              # noqa: BLE001 - 汇总 runner
                failed.append(name)
                print('FAIL %s: %s: %s' % (name, type(exc).__name__, exc))
    print('RESULT: %d passed, %d failed' % (count - len(failed), len(failed)))
    sys.exit(1 if failed else 0)
