# -*- coding: utf-8 -*-
"""pan_login 白盒单元测试：二维码创建/轮询状态机/Cookie 抽取与落盘/会话清理。

全部对外 HTTP、二维码渲染、Cookie 落盘均用 unittest.mock 打桩，
临时目录用 tempfile.mkdtemp，不触碰真实用户数据、不出网。

与既有用例互补：test_pan_cookies.py 只覆盖 pan_cookies 的加密读写，
test_runtime_contract.py 只桩掉 quark_qr_create 看契约层行为，
本文件深入 pan_login 内部私有分支（_scan_page/_cleanup/_render_qr_png/
_name_in_whitelist/_exchange_st/quark_qr_poll 状态机）。
"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import traceback
import types
from unittest.mock import MagicMock, patch

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import curl_cffi.requests  # noqa: E402
import hoststate  # noqa: E402
import pan_cookies  # noqa: E402
import pan_login  # noqa: E402


# --------------------------------------------------------------------------
# 打桩工具
# --------------------------------------------------------------------------

class _FakeCookie:
    """模拟 curl_cffi cookie jar 里的单个 cookie 对象。"""

    def __init__(self, name, value, domain='.quark.cn'):
        self.name = name
        self.value = value
        self.domain = domain


class _FakeResponse:
    def __init__(self, payload=None, text='', status_code=200, raise_exc=None):
        self._payload = payload
        self.text = text
        self.status_code = status_code
        self._raise_exc = raise_exc

    def raise_for_status(self):
        if self._raise_exc is not None:
            raise self._raise_exc

    def json(self):
        return self._payload


class _FakeSession:
    """模拟 curl_cffi.Session 实例：按 handler 返回预设响应或抛错。"""

    def __init__(self, handler=None, cookies=None):
        self.headers = {}
        self.kw = {}
        self.cookies = cookies if cookies is not None else _FakeJar([])
        self.calls = []
        self.handler = handler

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.handler is None:
            return _FakeResponse({}, 'ok')
        return self.handler(url, kwargs)


class _FakeJar:
    """带 jar 属性的 cookie 容器（curl_cffi 形态）。"""

    def __init__(self, cookies):
        self.jar = cookies

    def items(self):
        return [(c.name, c.value) for c in self.jar]


class _PlainJar:
    """无 jar 属性、只有 items() 的旧形态容器（走名称白名单兜底）。"""

    def __init__(self, pairs):
        self._pairs = pairs

    def items(self):
        return list(self._pairs)


def _patch_curl_session(factory=None):
    """替换 curl_cffi.requests.Session（pan_login 在函数内 from-import，
    必须打在真实模块对象上；patch.dict(sys.modules) 会让 curl_cffi 包
    自身的 __init__ 反查失败）。"""
    class _FakeCurlSession:
        def __init__(self, **kw):
            object.__setattr__(self, 'kw', kw)
            object.__setattr__(self, '_inner', (factory or _FakeSession)())

        def __setattr__(self, key, value):
            if key == '_inner':
                object.__setattr__(self, key, value)
            else:
                setattr(object.__getattribute__(self, '_inner'), key, value)

        def __getattr__(self, item):
            return getattr(object.__getattribute__(self, '_inner'), item)

    return patch.object(curl_cffi.requests, 'Session', _FakeCurlSession)


def _reset_sessions():
    """清空 pan_login 的全局会话表，避免用例间互相污染。"""
    with pan_login._lock:
        pan_login._sessions.clear()


def _prime_session(session, ttl_offset=0.0):
    """往全局会话表塞一个条目；ttl_offset 为正表示「已过去多少秒」。"""
    _reset_sessions()
    with pan_login._lock:
        pan_login._sessions['tok-1'] = (session, time.time() - ttl_offset,
                                        threading.Lock())
    return 'tok-1'


def _token_payload(token='tok-abc'):
    return {'data': {'members': {'token': token}}}


# --------------------------------------------------------------------------
# 二维码 URL 构造
# --------------------------------------------------------------------------

def test_scan_page_encodes_all_params():
    """_scan_page 必须对每个参数做 URL 编码（| @ : 未编码会导致扫码校验失败）。"""
    url = pan_login._scan_page('tok|en')
    assert url.startswith(pan_login.QR_BASE + '?')
    query = url.split('?', 1)[1]
    assert 'token=tok%7Cen' in query or 'token=tok%7cen' in query
    assert 'client_id=532' in query
    assert 'ssb=weblogin' in query
    assert 'uc_param_str=' in query
    assert 'uc_biz_str=' in query


def test_scan_page_biz_str_is_fully_encoded():
    """UC_BIZ_STR 里的 | 与 @ 必须被百分号编码，不能原样出现在 URL 中。"""
    query = pan_login._scan_page('t').split('?', 1)[1]
    assert '|' not in query
    assert '@' not in query
    assert 'S%3Acustom' in query
    assert 'OPT%3ASAREA' in query


def test_constants_sanity():
    """会话 TTL 应短于夸克侧二维码有效期（210s），且为正数。"""
    assert 0 < pan_login.SESSION_TTL <= 210
    assert pan_login.QR_BASE.startswith('https://su.quark.cn/')
    assert 'Windows NT 10.0' in pan_login.BROWSER_UA


# --------------------------------------------------------------------------
# 会话创建 _new_session / quark_qr_create
# --------------------------------------------------------------------------

def test_qr_create_success_returns_token_and_text():
    """正常响应：返回 token / qr_text / qr_png 三元组，且注册到会话表。"""
    _reset_sessions()
    fake = _FakeSession(handler=lambda url, kw: _FakeResponse(_token_payload()))
    with _patch_curl_session(lambda: fake), \
            patch.object(pan_login, '_render_qr_png', lambda text: 'PNG:' + text):
        info = pan_login.quark_qr_create()
    assert info['token'] == 'tok-abc'
    assert info['qr_text'] == pan_login._scan_page('tok-abc')
    assert info['qr_png'] == 'PNG:' + info['qr_text']
    assert 'tok-abc' in pan_login._sessions
    with pan_login._lock:
        item = pan_login._sessions['tok-abc']
    assert len(item) == 3 and isinstance(item[2], type(threading.Lock()))
    _reset_sessions()


def test_qr_create_raises_when_token_missing():
    """data.members.token 缺失：抛 RuntimeError 且不注册会话。"""
    _reset_sessions()
    fake = _FakeSession(handler=lambda url, kw: _FakeResponse({'data': {'members': {}}}))
    try:
        with _patch_curl_session(lambda: fake), \
                patch.object(pan_login, '_render_qr_png', lambda text: None):
            pan_login.quark_qr_create()
        assert False, '应当抛出 RuntimeError'
    except RuntimeError as e:
        assert '获取二维码失败' in str(e)
    assert pan_login._sessions == {}


def test_qr_create_handles_null_data_branch():
    """data 为 None / members 为 None / 整个响应不是 dict 形态：走 (or {}) 兜底后报错。"""
    for payload in ({'data': None}, {'data': {'members': None}}, {}, {'message': '风控了'}):
        _reset_sessions()
        fake = _FakeSession(handler=lambda url, kw, p=payload: _FakeResponse(p))
        try:
            with _patch_curl_session(lambda: fake), \
                    patch.object(pan_login, '_render_qr_png', lambda text: None):
                pan_login.quark_qr_create()
            assert False, '应当抛出 RuntimeError: %r' % (payload,)
        except RuntimeError as e:
            assert '获取二维码失败' in str(e)
    _reset_sessions()


def test_qr_create_error_message_is_truncated():
    """异常摘要只截取响应前 120 字符，避免超长响应进异常文本。"""
    _reset_sessions()
    payload = {'message': 'M' * 500}
    fake = _FakeSession(handler=lambda url, kw: _FakeResponse(payload))
    try:
        with _patch_curl_session(lambda: fake), \
                patch.object(pan_login, '_render_qr_png', lambda text: None):
            pan_login.quark_qr_create()
        assert False, '应当抛出 RuntimeError'
    except RuntimeError as e:
        assert len(str(e)) < 200
    _reset_sessions()


def test_qr_create_propagates_http_error():
    """raise_for_status 抛错（网络失败/4xx）：原样向上冒泡，且不注册会话。"""
    _reset_sessions()
    fake = _FakeSession(handler=lambda url, kw: _FakeResponse(
        {}, raise_exc=RuntimeError('network down')))
    try:
        with _patch_curl_session(lambda: fake), \
                patch.object(pan_login, '_render_qr_png', lambda text: None):
            pan_login.quark_qr_create()
        assert False, '应当抛出网络异常'
    except RuntimeError as e:
        assert 'network down' in str(e)
    assert pan_login._sessions == {}


def test_qr_create_requires_curl_cffi():
    """curl_cffi 缺失时 _new_session 抛 RuntimeError（提示安装）。

    pan_login 在函数内 ``from curl_cffi import requests as cr``，
    把 curl_cffi.requests 置为 None 即可复现「导入到空」的分支。
    """
    with patch.object(curl_cffi, 'requests', None):
        try:
            pan_login._new_session()
            assert False, '应当抛出 RuntimeError'
        except RuntimeError as e:
            assert 'curl_cffi' in str(e)


def test_new_session_warmup_then_token_request():
    """_new_session 先访问 pan.quark.cn 拿 ctoken，再请求 getTokenForQrcodeLogin。"""
    _reset_sessions()
    fake = _FakeSession(handler=lambda url, kw: _FakeResponse(_token_payload('tok-order')))
    with _patch_curl_session(lambda: fake), \
            patch.object(pan_login, '_render_qr_png', lambda text: None):
        pan_login.quark_qr_create()
    urls = [u for u, _ in fake.calls]
    assert urls[0] == 'https://pan.quark.cn/'
    assert urls[1] == 'https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin'
    assert fake.calls[1][1].get('timeout') == 20
    _reset_sessions()


def test_new_session_sets_navigation_then_api_headers():
    """预热时用导航请求头，随后切换为 uop API 的 CORS 请求头。"""
    _reset_sessions()
    seen = {}

    class _HeaderSession(_FakeSession):
        def get(self, url, **kwargs):
            seen.setdefault(url, dict(self.headers))
            return super().get(url, **kwargs)

    fake = _HeaderSession(handler=lambda url, kw: _FakeResponse(_token_payload('tok-h')))
    with _patch_curl_session(lambda: fake), \
            patch.object(pan_login, '_render_qr_png', lambda text: None):
        pan_login.quark_qr_create()
    warm = seen['https://pan.quark.cn/']
    assert warm['Sec-Fetch-Mode'] == 'navigate'
    assert warm['User-Agent'] == pan_login.BROWSER_UA
    api = seen['https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin']
    assert api['Sec-Fetch-Mode'] == 'cors'
    assert api['Referer'] == 'https://pan.quark.cn/'
    assert api['Origin'] == 'https://pan.quark.cn'
    _reset_sessions()


def test_new_session_warmup_failure_is_tolerated():
    """预热主页失败只记 warning，不阻断二维码创建。"""
    _reset_sessions()

    def handler(url, kwargs):
        if url == 'https://pan.quark.cn/':
            raise RuntimeError('warmup boom')
        return _FakeResponse(_token_payload('tok-warm'))

    fake = _FakeSession(handler=handler)
    with _patch_curl_session(lambda: fake), \
            patch.object(pan_login, '_render_qr_png', lambda text: None):
        info = pan_login.quark_qr_create()
    assert info['token'] == 'tok-warm'
    _reset_sessions()


def test_render_qr_png_delegates_to_private_impl():
    """render_qr_png 是 _render_qr_png 的薄封装（主进程扫码登录入口）。"""
    with patch.object(pan_login, '_render_qr_png', lambda text: 'uri:' + text):
        assert pan_login.render_qr_png('hello') == 'uri:hello'


def test_render_qr_png_swallows_library_errors():
    """二维码库不可用/抛错时返回 None，不把异常抛给调用方。"""
    broken = types.ModuleType('qrcode')

    def _boom(*a, **k):
        raise RuntimeError('no qrcode backend')

    broken.QRCode = _boom
    broken.constants = types.SimpleNamespace(ERROR_CORRECT_M=1)
    with patch.dict(sys.modules, {'qrcode': broken}):
        assert pan_login.render_qr_png('hello') is None


def test_render_qr_png_real_library_path():
    """真实 qrcode 库可用时能产出 PNG data URI（纯本地渲染，不出网）。

    库缺失时显式跳过（之前 `assert uri is None or ...` 是占位式断言：库缺失时静默
    通过、库可用时 None 分支又会掩盖渲染回归，例如库升级返回空串/错误格式仍能通过）。
    """
    try:
        import qrcode  # noqa: F401
    except ImportError:
        return  # 库不可用：本用例只测「库可用」路径，由 _broken_library 用例覆盖失败分支
    uri = pan_login.render_qr_png('https://su.quark.cn/4_eMHBJ?token=t')
    assert uri is not None, 'qrcode 库可用但渲染返回 None'
    assert uri.startswith('data:image/png;base64,'), f'返回的不是 PNG data URI: {uri[:80]}'


# --------------------------------------------------------------------------
# 会话清理 _cleanup / TTL
# --------------------------------------------------------------------------

def test_cleanup_purges_expired_sessions():
    """_cleanup 只删除超过 SESSION_TTL 的会话，新鲜会话保留。"""
    _reset_sessions()
    with pan_login._lock:
        pan_login._sessions['old'] = (object(), time.time() - pan_login.SESSION_TTL - 5, threading.Lock())
        pan_login._sessions['new'] = (object(), time.time(), threading.Lock())
    pan_login._cleanup()
    assert 'old' not in pan_login._sessions
    assert 'new' in pan_login._sessions
    _reset_sessions()


def test_cleanup_keeps_boundary_session():
    """刚到 TTL 边界（now - ts 略小于 TTL）不算过期，避免过早清理在途会话。"""
    _reset_sessions()
    with pan_login._lock:
        pan_login._sessions['edge'] = (object(), time.time() - pan_login.SESSION_TTL + 1, threading.Lock())
    pan_login._cleanup()
    assert 'edge' in pan_login._sessions
    _reset_sessions()


def test_cleanup_on_empty_table_is_noop():
    """空会话表执行 _cleanup 不报错（首次调用路径）。"""
    _reset_sessions()
    pan_login._cleanup()
    assert pan_login._sessions == {}


def test_qr_create_runs_cleanup_first():
    """quark_qr_create 开头调用 _cleanup：过期会话在建新码时被回收。"""
    _reset_sessions()
    with pan_login._lock:
        pan_login._sessions['stale'] = (object(), time.time() - 9999, threading.Lock())
    fake = _FakeSession(handler=lambda url, kw: _FakeResponse(_token_payload('tok-fresh')))
    with _patch_curl_session(lambda: fake), \
            patch.object(pan_login, '_render_qr_png', lambda text: None):
        pan_login.quark_qr_create()
    assert 'stale' not in pan_login._sessions
    assert 'tok-fresh' in pan_login._sessions
    _reset_sessions()


# --------------------------------------------------------------------------
# 轮询状态机 quark_qr_poll
# --------------------------------------------------------------------------

def test_poll_unknown_token_returns_expired():
    """会话表里没有该 token：直接返回 expired（已失效/已被清理）。"""
    _reset_sessions()
    res = pan_login.quark_qr_poll('no-such-token')
    assert res['status'] == 'expired'
    assert 'cookies' not in res


def test_poll_empty_token_is_treated_as_unknown():
    """空 token / None token：走未知分支返回 expired，不 KeyError。"""
    _reset_sessions()
    for tok in ('', None, '   '):
        assert pan_login.quark_qr_poll(tok)['status'] == 'expired'


def test_poll_session_ttl_expired():
    """会话存在但超过 SESSION_TTL：返回 expired 且不再发起轮询请求。"""
    session = _FakeSession(handler=lambda url, kw: _FakeResponse({'status': 2000000}))
    _prime_session(session, ttl_offset=pan_login.SESSION_TTL + 1)
    res = pan_login.quark_qr_poll('tok-1')
    assert res['status'] == 'expired'
    assert session.calls == []
    _reset_sessions()


def test_poll_waiting_status():
    """50004001（未扫码）→ waiting，且请求带上 token 查询参数。"""
    session = _FakeSession(handler=lambda url, kw: _FakeResponse({'status': 50004001}))
    _prime_session(session)
    res = pan_login.quark_qr_poll('tok-1')
    assert res['status'] == 'waiting'
    assert res['message'] == '等待扫码…'
    assert len(session.calls) == 1
    assert session.calls[0][0] == 'https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken'
    assert session.calls[0][1]['params'] == {'token': 'tok-1'}
    assert session.calls[0][1]['timeout'] == 20
    _reset_sessions()


def test_poll_expired_status_codes():
    """50001000/50001001/50004002 三个码统一映射为 expired。"""
    for code in (50001000, 50001001, 50004002):
        session = _FakeSession(handler=lambda url, kw, c=code: _FakeResponse({'status': c}))
        _prime_session(session)
        res = pan_login.quark_qr_poll('tok-1')
        assert res['status'] == 'expired', code
        assert '重新获取' in res['message']
    _reset_sessions()


def test_poll_unknown_status_falls_back_to_waiting():
    """非白名单状态码（含 None / 缺字段）→ 兜底 waiting，不能误判为过期。"""
    for payload in ({'status': 99999999, 'message': '怪状态'}, {'status': None}, {}):
        session = _FakeSession(handler=lambda url, kw, p=payload: _FakeResponse(p))
        _prime_session(session)
        res = pan_login.quark_qr_poll('tok-1')
        assert res['status'] == 'waiting', payload
    _reset_sessions()


def test_poll_network_error_returns_error_status():
    """轮询请求抛异常 → error，且 message 截断到 80 字符内。"""
    def boom(url, kwargs):
        raise RuntimeError('x' * 500)

    session = _FakeSession(handler=boom)
    _prime_session(session)
    res = pan_login.quark_qr_poll('tok-1')
    assert res['status'] == 'error'
    assert '轮询失败' in res['message']
    assert len(res['message']) < 120
    _reset_sessions()


def test_poll_json_decode_error_returns_error_status():
    """响应不是 JSON（r.json() 抛错）→ error，不因解析失败崩主流程。"""
    class BadJson:
        status_code = 200

        @staticmethod
        def json():
            raise ValueError('not json')

    session = _FakeSession(handler=lambda url, kw: BadJson())
    _prime_session(session)
    res = pan_login.quark_qr_poll('tok-1')
    assert res['status'] == 'error'
    assert '轮询失败' in res['message']
    _reset_sessions()


def test_poll_success_without_ticket_returns_error():
    """status==2000000 但没有 service_ticket：error「未取得票据」。"""
    session = _FakeSession(handler=lambda url, kw: _FakeResponse(
        {'status': 2000000, 'data': {'members': {}}}))
    _prime_session(session)
    res = pan_login.quark_qr_poll('tok-1')
    assert res['status'] == 'error'
    assert '未取得票据' in res['message']
    _reset_sessions()


def test_poll_success_with_null_data_branch():
    """status==2000000 但 data/members 为 None：(or {}) 兜底后同上报错。"""
    for payload in ({'status': 2000000, 'data': None},
                    {'status': 2000000, 'data': {'members': None}},
                    {'status': 2000000}):
        session = _FakeSession(handler=lambda url, kw, p=payload: _FakeResponse(p))
        _prime_session(session)
        assert pan_login.quark_qr_poll('tok-1')['status'] == 'error'
    _reset_sessions()


def test_poll_reuses_single_session_under_lock():
    """并发轮询同一 token 串行执行：session 级互斥锁保证不并发打同一会话。"""
    active = {'cur': 0, 'max': 0}
    guard = threading.Lock()

    def handler(url, kwargs):
        with guard:
            active['cur'] += 1
            active['max'] = max(active['max'], active['cur'])
        time.sleep(0.01)
        with guard:
            active['cur'] -= 1
        return _FakeResponse({'status': 50004001})

    session = _FakeSession(handler=handler)
    _prime_session(session)
    results = []
    threads = [threading.Thread(target=lambda: results.append(pan_login.quark_qr_poll('tok-1')))
               for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(results) == 4
    assert all(r['status'] == 'waiting' for r in results)
    assert active['max'] == 1
    _reset_sessions()


def test_poll_different_tokens_do_not_share_state():
    """不同 token 相互隔离：一个过期不影响另一个仍在等待。"""
    _reset_sessions()
    ok = _FakeSession(handler=lambda url, kw: _FakeResponse({'status': 50004001}))
    dead = _FakeSession(handler=lambda url, kw: _FakeResponse({'status': 50004001}))
    with pan_login._lock:
        pan_login._sessions['live'] = (ok, time.time(), threading.Lock())
        pan_login._sessions['dead'] = (dead, time.time() - pan_login.SESSION_TTL - 1, threading.Lock())
    assert pan_login.quark_qr_poll('live')['status'] == 'waiting'
    assert pan_login.quark_qr_poll('dead')['status'] == 'expired'
    assert len(ok.calls) == 1 and len(dead.calls) == 0
    _reset_sessions()


def test_poll_repeated_until_failure_cap():
    """模拟上层轮询上限：连续 5 次 waiting 后由调用方停止。

    验证「失败上限」语义：后端状态机本身无计数，每次都如实返回 waiting，
    连续调用后状态仍自洽、会话未被误清理（上限判断在上层）。
    """
    session = _FakeSession(handler=lambda url, kw: _FakeResponse({'status': 50004001}))
    _prime_session(session)
    for _ in range(5):
        assert pan_login.quark_qr_poll('tok-1')['status'] == 'waiting'
    assert len(session.calls) == 5
    assert 'tok-1' in pan_login._sessions
    _reset_sessions()


def test_poll_backoff_is_caller_responsibility():
    """退避策略在上层：后端单次轮询不 sleep（总耗时远低于间隔预算）。"""
    session = _FakeSession(handler=lambda url, kw: _FakeResponse({'status': 50004001}))
    _prime_session(session)
    start = time.monotonic()
    for _ in range(3):
        pan_login.quark_qr_poll('tok-1')
    assert time.monotonic() - start < 0.5
    _reset_sessions()


def test_poll_success_delegates_to_exchange_st():
    """status==2000000 且有 ticket：转交 _exchange_st 并把结果原样返回。"""
    session = _FakeSession(handler=lambda url, kw: _FakeResponse(
        {'status': 2000000, 'data': {'members': {'service_ticket': 'ST-1'}}}))
    _prime_session(session)
    expected = {'status': 'ok', 'message': '登录成功'}
    with patch.object(pan_login, '_exchange_st', return_value=expected) as ex:
        res = pan_login.quark_qr_poll('tok-1')
    assert res is expected
    assert ex.call_count == 1
    assert ex.call_args[0][1] == 'ST-1'
    _reset_sessions()


def _broken_observer():
    """返回一个「任何观测方法都抛错」的假 logger，模拟回调/监听侧故障。"""
    return MagicMock(**{
        'info.side_effect': RuntimeError('observer down'),
        'warning.side_effect': RuntimeError('observer down'),
        'debug.side_effect': RuntimeError('observer down'),
        'error.side_effect': RuntimeError('observer down'),
    })


def test_poll_external_callback_failure_is_contained():
    """外部回调（session.get / r.json）抛任意类型异常都收敛为 error，不崩主流程。"""
    for exc in (ValueError('bad json'), OSError('conn reset'),
                KeyError('members'), AttributeError('no attr')):
        def boom(url, kwargs, e=exc):
            raise e

        session = _FakeSession(handler=boom)
        _prime_session(session)
        res = pan_login.quark_qr_poll('tok-1')
        assert res['status'] == 'error', exc
        assert '轮询失败' in res['message']
    _reset_sessions()


def test_poll_success_callback_failure_propagates():
    """成功分支里的外部回调（_exchange_st）抛错时不被包裹，直接冒泡。

    与轮询分支不同：quark_qr_poll 的 try 只包住 HTTP 请求与 JSON 解析。
    """
    session = _FakeSession(handler=lambda url, kw: _FakeResponse(
        {'status': 2000000, 'data': {'members': {'service_ticket': 'ST-9'}}}))
    _prime_session(session)
    with patch.object(pan_login, '_exchange_st', side_effect=RuntimeError('exchange boom')):
        try:
            pan_login.quark_qr_poll('tok-1')
            assert False, '当前实现未包裹 _exchange_st，异常应冒泡'
        except RuntimeError as e:
            assert 'exchange boom' in str(e)
    _reset_sessions()


def test_qr_create_render_failure_is_absorbed_by_private_impl():
    """二维码渲染回调内部异常被 _render_qr_png 吞掉（返回 None），建码仍成功。"""
    _reset_sessions()
    fake = _FakeSession(handler=lambda url, kw: _FakeResponse(_token_payload('tok-nopng')))
    broken = types.ModuleType('qrcode')
    broken.QRCode = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('render boom'))
    broken.constants = types.SimpleNamespace(ERROR_CORRECT_M=1)
    with _patch_curl_session(lambda: fake), \
            patch.dict(sys.modules, {'qrcode': broken}), \
            patch.object(pan_login, 'logger', MagicMock()):
        info = pan_login.quark_qr_create()
    assert info['token'] == 'tok-nopng'
    assert info['qr_png'] is None
    _reset_sessions()


def test_logging_failure_is_not_guarded():
    """现状风险：日志回调抛错没有被包裹，会直接冒泡（非 try 包裹路径）。

    真实 logging.Handler 不会抛给业务代码，但注入式 logger（如测试/宿主
    桥接）抛错会让建码/轮询失败。此处固化现状，供后续加固时对照。
    """
    _reset_sessions()
    fake = _FakeSession(handler=lambda url, kw: _FakeResponse(_token_payload('tok-obs')))
    try:
        with _patch_curl_session(lambda: fake), \
                patch.object(pan_login, 'logger', _broken_observer()), \
                patch.object(pan_login, '_render_qr_png', lambda text: 'PNG'):
            pan_login.quark_qr_create()
        assert False, '当前实现未包裹 logger，异常应冒泡'
    except RuntimeError as e:
        assert 'observer down' in str(e)
    _reset_sessions()


# --------------------------------------------------------------------------
# Cookie 名称白名单
# --------------------------------------------------------------------------

def test_name_in_whitelist_exact_names():
    """白名单精确名命中，且与大小写无关。"""
    assert pan_login._name_in_whitelist('__pus')
    assert pan_login._name_in_whitelist('__PUUS')
    assert pan_login._name_in_whitelist('Ctoken')
    assert pan_login._name_in_whitelist('b-user-id')
    assert pan_login._name_in_whitelist('__sdid')


def test_name_in_whitelist_rejects_foreign_names():
    """无关 Cookie 名与空名一律落空，避免把第三方域会话写进网盘配置。"""
    assert not pan_login._name_in_whitelist('sessionid')
    assert not pan_login._name_in_whitelist('')
    assert not pan_login._name_in_whitelist(None or '')
    assert not pan_login._name_in_whitelist('quark.cn')


def test_name_in_whitelist_prefix_case_behaviour():
    """前缀分支实测：先 lower 再 startswith('_UP_') → 大写 _UP_xxx 也匹配不上。

    注意：这是源码现状（前缀常量为大写而比较对象是小写后的名字），
    该兜底前缀实际永不命中；此处按现状固化行为，供后续修复时对照。
    """
    lowered = '_up_session'
    assert pan_login._name_in_whitelist(lowered) is False
    assert pan_login._name_in_whitelist('_UP_session') is False
    assert lowered.startswith(pan_login._QUARK_COOKIE_PREFIXES) is False


# --------------------------------------------------------------------------
# _exchange_st：Cookie 抽取与落盘
# --------------------------------------------------------------------------

def test_exchange_st_filters_cookies_by_domain():
    """按域名白名单收集：quark.cn/uc.cn 及其子域留下，第三方域丢弃。

    注意：源码只判 name 非空（不判 value 非空），空值 Cookie 仍会入串，
    此处按现状固化，并显式把空值项纳入期望以暴露该宽松点。
    """
    cookies = [
        _FakeCookie('__pus', 'a', '.quark.cn'),
        _FakeCookie('__puus', 'b', 'uc.cn'),
        _FakeCookie('ctoken', 'c', 'drive-pc.quark.cn'),
        _FakeCookie('upass', 'u', '.UC.cn'),
        _FakeCookie('third', 'd', '.evil.com'),
        _FakeCookie('empty', '', '.quark.cn'),
    ]
    expected = '__pus=a; __puus=b; ctoken=c; upass=u; empty='
    session = _FakeSession(handler=lambda url, kw: _FakeResponse(text='body', status_code=200),
                           cookies=_FakeJar(cookies))
    saved = {'quark': expected}
    with patch.object(pan_login, 'logger'), \
            patch.object(pan_login, 'save_pan_cookies', return_value=(saved, [])) as sp:
        res = pan_login._exchange_st(session, 'ST-1')
    assert res['status'] == 'ok'
    assert sp.call_args[0][0]['quark'] == expected
    assert '5 个字段' in res['message']
    assert 'evil.com' not in sp.call_args[0][0]['quark']
    assert res['cookies'] == saved['quark']


def test_exchange_st_falls_back_to_name_whitelist():
    """jar 为空（旧形态只有 items()）：按名称白名单兜底收集。"""
    pairs = [('__pus', 'a'), ('ctoken', 'b'), ('randomsite', 'c')]
    session = _FakeSession(handler=lambda url, kw: _FakeResponse(text='body', status_code=200),
                           cookies=_PlainJar(pairs))
    with patch.object(pan_login, 'logger'), \
            patch.object(pan_login, 'save_pan_cookies',
                        return_value=({'quark': '__pus=a; ctoken=b'}, [])) as sp:
        res = pan_login._exchange_st(session, 'ST-1')
    assert res['status'] == 'ok'
    assert sp.call_args[0][0]['quark'] == '__pus=a; ctoken=b'
    assert 'randomsite' not in sp.call_args[0][0]['quark']


def test_exchange_st_no_cookie_returns_error():
    """没有任何夸克 Cookie：error，并把 HTTP 状态码带进提示。"""
    session = _FakeSession(handler=lambda url, kw: _FakeResponse(text='no cookie', status_code=403),
                           cookies=_FakeJar([_FakeCookie('x', 'y', 'evil.com')]))
    with patch.object(pan_login, 'logger'), \
            patch.object(pan_login, 'save_pan_cookies', side_effect=AssertionError('不应落盘')):
        res = pan_login._exchange_st(session, 'ST-1')
    assert res['status'] == 'error'
    assert 'HTTP 403' in res['message']
    assert '未取得 Cookie' in res['message']


def test_exchange_st_network_failure_returns_error():
    """account/info 请求抛错 → error，message 带异常摘要且截断。"""
    def boom(url, kwargs):
        raise RuntimeError('y' * 500)

    session = _FakeSession(handler=boom)
    with patch.object(pan_login, 'logger'), \
            patch.object(pan_login, 'save_pan_cookies', side_effect=AssertionError('不应落盘')):
        res = pan_login._exchange_st(session, 'ST-1')
    assert res['status'] == 'error'
    assert '兑换登录态失败' in res['message']
    assert len(res['message']) < 120


def test_exchange_st_persists_cookies_to_disk():
    """登录成功后 Cookie 真正落盘（临时 data_dir），且可从文件读回。"""
    import shutil
    root = tempfile.mkdtemp(prefix='panlogin-')
    old_dir = hoststate.get_data_dir()
    try:
        hoststate.configure(data_dir=root)
        pan_cookies._cache.update({'path': '', 'mtime': 0.0, 'data': {}})
        cookies = [_FakeCookie('__pus', 'disk-value', '.quark.cn')]
        session = _FakeSession(handler=lambda url, kw: _FakeResponse(text='ok', status_code=200),
                               cookies=_FakeJar(cookies))
        res = pan_login._exchange_st(session, 'ST-1')
        assert res['status'] == 'ok'
        assert res['cookies'] == '__pus=disk-value'
        assert os.path.exists(os.path.join(root, 'pan_cookies.json'))
        assert pan_cookies.load_pan_cookies().get('quark') == '__pus=disk-value'
    finally:
        hoststate.configure(data_dir=old_dir)
        pan_cookies._cache.update({'path': '', 'mtime': 0.0, 'data': {}})
        shutil.rmtree(root, ignore_errors=True)


def test_exchange_st_save_failure_returns_error_not_crash():
    """写盘失败（RuntimeError）→ error；不向调用方抛出异常。"""
    session = _FakeSession(handler=lambda url, kw: _FakeResponse(text='ok', status_code=200),
                           cookies=_FakeJar([_FakeCookie('__pus', 'v', '.quark.cn')]))
    with patch.object(pan_login, 'logger'), \
            patch.object(pan_login, 'save_pan_cookies', side_effect=RuntimeError('disk full')):
        res = pan_login._exchange_st(session, 'ST-1')
    assert res['status'] == 'error'
    assert 'Cookie 保存失败' in res['message']


def test_exchange_st_keeps_memory_state_on_write_failure():
    """写盘失败时已抽取的 Cookie 串不丢（回滚语义：只回滚落盘，不清内存态）。"""
    captured = {}

    def failing(cookies_dict, *a, **k):
        captured.update(cookies_dict)
        raise OSError('read-only fs')

    session = _FakeSession(handler=lambda url, kw: _FakeResponse(text='ok', status_code=200),
                           cookies=_FakeJar([_FakeCookie('__pus', 'keep-me', '.quark.cn')]))
    with patch.object(pan_login, 'logger'), \
            patch.object(pan_login, 'save_pan_cookies', side_effect=failing):
        first = pan_login._exchange_st(session, 'ST-1')
        second = pan_login._exchange_st(session, 'ST-1')
    assert first['status'] == 'error' and second['status'] == 'error'
    assert captured['quark'] == '__pus=keep-me'
    assert len(session.calls) == 2  # 失败可重试，会话未被破坏


def test_exchange_st_write_failure_does_not_touch_existing_file():
    """落盘失败时不改动既有 Cookie 文件（旧配置不能被半途写坏）。"""
    import shutil
    root = tempfile.mkdtemp(prefix='panlogin-')
    old_dir = hoststate.get_data_dir()
    try:
        hoststate.configure(data_dir=root)
        pan_cookies._cache.update({'path': '', 'mtime': 0.0, 'data': {}})
        pan_cookies.save_pan_cookies({'quark': '__pus=old-value'})
        cookie_file = os.path.join(root, 'pan_cookies.json')
        with open(cookie_file, encoding='utf-8') as fp:
            before = fp.read()
        session = _FakeSession(handler=lambda url, kw: _FakeResponse(text='ok', status_code=200),
                               cookies=_FakeJar([_FakeCookie('__pus', 'new-value', '.quark.cn')]))
        with patch.object(pan_login, 'logger'), \
                patch.object(pan_login, 'save_pan_cookies', side_effect=OSError('disk full')):
            assert pan_login._exchange_st(session, 'ST-1')['status'] == 'error'
        with open(cookie_file, encoding='utf-8') as fp:
            assert fp.read() == before
    finally:
        hoststate.configure(data_dir=old_dir)
        pan_cookies._cache.update({'path': '', 'mtime': 0.0, 'data': {}})
        shutil.rmtree(root, ignore_errors=True)


def test_exchange_st_forwards_warnings():
    """落盘返回的 warnings 原样透传给上层（例如缺少 __pus 关键字段）。"""
    session = _FakeSession(handler=lambda url, kw: _FakeResponse(text='ok', status_code=200),
                           cookies=_FakeJar([_FakeCookie('ctoken', 'v', '.quark.cn')]))
    warns = ['夸克网盘 Cookie 缺少关键字段「__pus」']
    with patch.object(pan_login, 'logger'), \
            patch.object(pan_login, 'save_pan_cookies', return_value=({'quark': 'ctoken=v'}, warns)):
        res = pan_login._exchange_st(session, 'ST-1')
    assert res['status'] == 'ok'
    assert res['warnings'] == warns


def test_exchange_st_cookie_jar_access_failure_is_contained():
    """访问 cookie.jar 抛异常：静默降级到名称白名单兜底，不崩溃。"""
    class BoomJar:
        @property
        def jar(self):
            raise RuntimeError('jar broken')

        def items(self):
            return [('__pus', 'fallback-value')]

    session = _FakeSession(handler=lambda url, kw: _FakeResponse(text='ok', status_code=200),
                           cookies=BoomJar())
    with patch.object(pan_login, 'logger'), \
            patch.object(pan_login, 'save_pan_cookies',
                         return_value=({'quark': '__pus=fallback-value'}, [])) as sp:
        res = pan_login._exchange_st(session, 'ST-1')
    assert res['status'] == 'ok'
    assert sp.call_args[0][0]['quark'] == '__pus=fallback-value'


def test_exchange_st_no_cookie_attribute_at_all():
    """session 连 cookies 都没有：走空列表兜底，返回 error 而非 AttributeError。"""
    session = _FakeSession(handler=lambda url, kw: _FakeResponse(text='ok', status_code=200),
                           cookies=None)
    with patch.object(pan_login, 'logger'):
        res = pan_login._exchange_st(session, 'ST-1')
    assert res['status'] == 'error'
    assert '未取得 Cookie' in res['message']


def test_exchange_st_requests_account_info_with_ticket():
    """兑换请求打到 account/info 且带上 st 参数；日志只留前 200 字符。"""
    seen = {}

    def handler(url, kwargs):
        seen['url'] = url
        seen['params'] = kwargs.get('params')
        return _FakeResponse(text='z' * 5000, status_code=200)

    session = _FakeSession(handler=handler,
                           cookies=_FakeJar([_FakeCookie('__pus', 'v', '.quark.cn')]))
    with patch.object(pan_login, 'logger'), \
            patch.object(pan_login, 'save_pan_cookies', return_value=({'quark': '__pus=v'}, [])):
        assert pan_login._exchange_st(session, 'ST-42')['status'] == 'ok'
    assert seen['url'] == 'https://pan.quark.cn/account/info'
    assert seen['params'] == {'st': 'ST-42'}
    assert session.calls[0][1]['timeout'] == 20


# --------------------------------------------------------------------------
# 并发登录与取消
# --------------------------------------------------------------------------

def test_concurrent_login_same_token_serialized():
    """同一 token 的并发登录：请求串行、结果各自一致（会话锁生效）。"""
    calls = {'n': 0}

    def handler(url, kwargs):
        if 'getServiceTicketByQrcodeToken' in url:
            calls['n'] += 1
            return _FakeResponse({'status': 2000000,
                                  'data': {'members': {'service_ticket': 'ST-%d' % calls['n']}}})
        return _FakeResponse(text='ok', status_code=200)

    session = _FakeSession(handler=handler,
                           cookies=_FakeJar([_FakeCookie('__pus', 'v', '.quark.cn')]))
    _prime_session(session)
    results = []
    with patch.object(pan_login, 'logger'), \
            patch.object(pan_login, 'save_pan_cookies', return_value=({'quark': '__pus=v'}, [])):
        threads = [threading.Thread(target=lambda: results.append(pan_login.quark_qr_poll('tok-1')))
                   for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    assert len(results) == 3
    assert all(r['status'] == 'ok' for r in results)
    assert all(r['cookies'] == '__pus=v' for r in results)
    assert calls['n'] == 3  # 后端每次轮询如实发请求；去重/上限由上层承担
    _reset_sessions()


def test_concurrent_create_registers_distinct_sessions():
    """并发建码：不同 token 各自入表，互不覆盖（并发登录不去重、按 token 隔离）。"""
    _reset_sessions()
    counter = {'n': 0}
    guard = threading.Lock()

    def handler(url, kwargs):
        if url == 'https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin':
            with guard:
                counter['n'] += 1
                n = counter['n']
            return _FakeResponse(_token_payload('tok-%d' % n))
        return _FakeResponse({}, 'ok')

    with _patch_curl_session(lambda: _FakeSession(handler=handler)), \
            patch.object(pan_login, '_render_qr_png', lambda text: None):
        infos = []
        threads = [threading.Thread(target=lambda: infos.append(pan_login.quark_qr_create()))
                   for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    tokens = {info['token'] for info in infos}
    assert len(infos) == 3
    assert tokens <= set(pan_login._sessions)
    _reset_sessions()


def test_cancel_login_clears_session_entry():
    """取消登录 = 从会话表移除 token：之后轮询立即返回 expired。"""
    session = _FakeSession(handler=lambda url, kw: _FakeResponse({'status': 50004001}))
    _prime_session(session)
    assert pan_login.quark_qr_poll('tok-1')['status'] == 'waiting'
    with pan_login._lock:
        pan_login._sessions.pop('tok-1', None)
    res = pan_login.quark_qr_poll('tok-1')
    assert res['status'] == 'expired'
    assert len(session.calls) == 1  # 取消后不再发任何请求（无资源泄漏）


def test_cancel_login_releases_all_resources():
    """批量取消：会话表清空后所有 token 轮询均为 expired，无残留。"""
    _reset_sessions()
    with pan_login._lock:
        for i in range(5):
            pan_login._sessions['t%d' % i] = (_FakeSession(), time.time(), threading.Lock())
    assert len(pan_login._sessions) == 5
    with pan_login._lock:
        pan_login._sessions.clear()
    assert pan_login._sessions == {}
    for i in range(5):
        assert pan_login.quark_qr_poll('t%d' % i)['status'] == 'expired'


def test_poll_after_cancel_does_not_resurrect_session():
    """取消后再轮询不会把 token 重新塞回会话表。"""
    session = _FakeSession(handler=lambda url, kw: _FakeResponse({'status': 50004001}))
    _prime_session(session)
    with pan_login._lock:
        pan_login._sessions.pop('tok-1', None)
    for _ in range(3):
        assert pan_login.quark_qr_poll('tok-1')['status'] == 'expired'
    assert pan_login._sessions == {}


if __name__ == '__main__':
    passed = 0
    failed = []
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            try:
                fn()
                passed += 1
                print('PASS %s' % name)
            except Exception as exc:  # noqa: BLE001
                failed.append(name)
                print('FAIL %s: %r' % (name, exc))
                traceback.print_exc()
    print('---- %d passed, %d failed ----' % (passed, len(failed)))
    if failed:
        sys.exit(1)
    print('ALL PASS')
