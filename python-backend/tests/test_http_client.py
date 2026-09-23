# -*- coding: utf-8 -*-
"""http_client 白盒单元测试：Session 底座、代理解析、基础入口守卫、请求封装
（get/post/_send）、逐跳守卫与重定向收敛、响应体限长与解码。

与 tests/test_http_guard_regression.py 的分工（互补而非重复）：
- 那份走 loopback 夹具 FixtureServer，做**集成**回归（真实 HTTP、真实
  config_security 策略链、私网重定向与体积守卫的端到端语义）；
- 本文件**打桩到底**：拦掉 requests.Session.request / _read_wininet /
  get_environ_proxies / urllib3 Retry，断言内部私有函数与分支——代理回退、
  超时传播、UA 与 header 合并优先级、编码分派、限长计量、重定向上限、
  inet_aton 归一、guard 放行/拦截边界。

纪律：全程无真实网络调用、无 sleep（时间函数一律打桩）。

环境隔离：导入即清空宿主的代理环境变量（HTTP(S)_PROXY/ALL_PROXY/NO_PROXY）
——否则「无代理 → 不带 proxies 键」这类断言在开发机/公司代理下会随宿主环境
漂移（与 offline_config_server.FixtureServer 的隔离口径一致）。
"""
import atexit
import os
import sys
from unittest.mock import MagicMock, patch

_PROXY_ENV_KEYS = ('HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
                   'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy')
# 本文件依赖 run_all.py 的子进程隔离模型（每阶段独立进程）。atexit 恢复只保证
# 进程退出时写回原值——它**不能**防止 pytest 同进程合并运行时其它测试模块看到
# 被 pop 掉的环境（恢复发生在全部测试结束之后）；本文件的用例已各自用
# _no_env_proxy()/_no_wininet() 断言级打桩兜住宿主漂移，故合并运行不被支持也
# 不受影响。
_ORIG_PROXY_ENV = {key: os.environ.get(key) for key in _PROXY_ENV_KEYS}
for _key in _PROXY_ENV_KEYS:
    os.environ.pop(_key, None)


def _restore_proxy_env():
    for key, val in _ORIG_PROXY_ENV.items():
        if val is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = val


atexit.register(_restore_proxy_env)

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
for _path in (BASE, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import requests  # noqa: E402
from requests import Session  # noqa: E402

import http_client  # noqa: E402


# ---------------------------------------------------------------- 测试替身

class _FakeRaw:
    """HTTPResponse 替身：requests 流式读取需要的接口 + release_conn 记账，
    用于断言「连接是否归还连接池」。

    `chunks` 给定时按其逐块吐（用于精确控制分块场景）；否则按请求的
    chunk_size 切片（与 urllib3 的真实行为一致）。
    """

    def __init__(self, body, chunks=None):
        self._body = body
        self._chunks = list(chunks) if chunks is not None else None
        self._pos = 0
        self.closed = False
        self.released = 0
        self.stream_calls = []

    def stream(self, chunk_size=1, decode_content=None):
        self.stream_calls.append(chunk_size)
        if self._chunks is not None:
            yield from self._chunks
            return
        size = max(1, int(chunk_size or 1))
        for start in range(0, len(self._body), size):
            yield self._body[start:start + size]

    def read(self, amt=None, decode_content=None):
        out = self._body[self._pos:] if amt is None else self._body[self._pos:self._pos + amt]
        self._pos += len(out)
        return out

    def close(self):
        self.closed = True

    def release_conn(self):
        self.released += 1


def _fake_response(status_code=200, content=b'ok', headers=None, url='http://example.com/x',
                   encoding='utf-8', chunks=None):
    """requests.Response 替身（含 stream 能力），供 _send/_read_capped 使用。"""
    rsp = requests.Response()
    rsp.status_code = status_code
    rsp.url = url
    rsp.encoding = encoding
    rsp.raw = _FakeRaw(content, chunks)
    if headers:
        rsp.headers.update(headers)
    return rsp


def _one_shot():
    """每次调用都返回一枚**全新**的响应替身（requests.Response 的流式内容
    只能消费一次，重复复用同一枚会抛 StreamConsumedError）。"""
    def _factory(_method, _url, **_kw):
        return _fake_response(200, b'ok', encoding='utf-8')
    return _factory


class _Chunked:
    """_read_capped 的可控替身：按块吐数据并统计 close 次数。"""

    def __init__(self, chunks, url='http://example.com/big', status_code=200, encoding='utf-8'):
        self.chunks = list(chunks)
        self.url = url
        self.status_code = status_code
        self.encoding = encoding
        self.headers = {}
        self.closed = 0

    def iter_content(self, chunk_size=1):
        for chunk in self.chunks:
            yield chunk

    def close(self):
        self.closed += 1


def _no_env_proxy():
    """让 requests 环境变量代理恒为空（宿主设了代理也不影响断言）。"""
    return patch.object(http_client.requests.utils, 'get_environ_proxies', return_value={})


def _no_wininet():
    return patch.object(http_client, '_read_wininet', return_value=({}, ''))


# ------------------------------------------------------- get_session / 底座

def test_get_session_is_process_singleton():
    """进程级共享 Session：多次调用同一实例（连接池复用前提）。"""
    assert http_client.get_session() is http_client.get_session()


def test_get_session_pools_and_disables_urllib3_retry():
    """连接池 16/16 且 max_retries=0——重试语义留给上层，不在传输层静默重放。"""
    session = http_client.get_session()
    assert session.trust_env is False, 'trust_env 关闭：代理改由 system_proxies 显式解析'
    adapter = session.get_adapter('https://example.com/x')
    assert adapter._pool_connections == 16
    assert adapter._pool_maxsize == 16
    assert int(adapter.max_retries.total or 0) == 0


def test_get_session_cookie_policy_never_stores():
    """共享 Session 的 Cookie jar 挂禁写策略：Set-Cookie 一律不落地。"""
    policy = http_client.get_session().cookies.get_policy()
    assert isinstance(policy, http_client._NoStoreCookiePolicy)
    assert policy.set_ok(MagicMock(), MagicMock()) is False


def test_no_store_policy_is_minimal_override():
    """只覆写 set_ok：其余判定沿用 http.cookiejar（Python 3.14 移除 BlockAll
    后的等价实现）。"""
    from http.cookiejar import Cookie, DefaultCookiePolicy

    sub = http_client._NoStoreCookiePolicy()
    assert vars(sub) == vars(DefaultCookiePolicy()), '策略状态不应被增删，只改行为'
    overridden = {n for n in dir(http_client._NoStoreCookiePolicy)
                  if not n.startswith('__')
                  and getattr(http_client._NoStoreCookiePolicy, n, None)
                  is not getattr(DefaultCookiePolicy, n, None)}
    assert overridden == {'set_ok'}, overridden
    # 同一枚真实 cookie：默认策略放行，本策略一律拒收（不落地）
    cookie = Cookie(0, 'sid', 'abc', None, False, 'example.com', True, False, '/',
                    True, False, None, False, None, None, {})
    request = MagicMock()
    request.unverifiable = False
    request.type = 'http'
    request.host = 'example.com'
    request.get_full_url.return_value = 'http://example.com/'
    request.origin_req_host = 'example.com'
    assert DefaultCookiePolicy().set_ok(cookie, request) is True
    assert sub.set_ok(cookie, request) is False


# ------------------------------------------------------------- header 合并

def test_with_default_ua_injects_ua_when_absent():
    """未给 UA 时补默认 okhttp UA（TVBox 生态按 UA 分流）。"""
    kw = http_client._with_default_ua({})
    assert kw['headers'] == {'User-Agent': http_client.DEFAULT_UA}
    assert http_client.DEFAULT_UA == 'okhttp/4.9.3'


def test_with_default_ua_caller_wins_on_exact_case():
    """调用方用标准大小写 'User-Agent' 显式指定时优先，不被默认 UA 覆盖。"""
    kw = http_client._with_default_ua({'headers': {'User-Agent': 'mine/1.0'}})
    assert kw['headers'] == {'User-Agent': 'mine/1.0'}
    prepared = http_client.get_session().prepare_request(
        requests.Request('GET', 'http://example.com/x', headers=kw['headers']))
    assert prepared.headers['User-Agent'] == 'mine/1.0'


def test_with_default_ua_lowercase_ua_is_shadowed():
    """已知缺陷（http_client.py:343）：headers 用普通 dict + setdefault('User-Agent')
    判定，不做大小写不敏感比较——调用方传 'user-agent'（小写）会同时留下两条 UA，
    requests 合并时**先插入的默认 UA 胜出**，调用方的 UA 被静默覆盖。

    TVBox 生态按 UA 分流（浏览器 UA 返回 HTML、okhttp UA 返回 JSON），这条路径
    会让「显式指定了 UA」的调用方拿到错的分流结果。这里固化当前实际行为，
    修复后本用例需同步改为断言调用方 UA 胜出。
    """
    kw = http_client._with_default_ua({'headers': {'user-agent': 'browser/1.0'}})
    assert kw['headers'] == {'user-agent': 'browser/1.0',
                             'User-Agent': http_client.DEFAULT_UA}
    prepared = http_client.get_session().prepare_request(
        requests.Request('GET', 'http://example.com/x', headers=kw['headers']))
    assert prepared.headers['User-Agent'] == http_client.DEFAULT_UA, (
        '调用方小写 UA 被默认 UA 覆盖——当前实现的实际行为（疑似缺陷）')


def test_with_default_ua_drops_none_valued_headers():
    """值为 None 的头必须剔除——requests 2.34 起对 None 值抛 InvalidHeader。"""
    kw = http_client._with_default_ua({'headers': {'X-A': None, 'X-B': 'b'}})
    prepared = http_client.get_session().prepare_request(
        requests.Request('GET', 'http://example.com/x', headers=kw['headers']))
    assert 'X-A' not in prepared.headers
    assert prepared.headers['X-B'] == 'b'
    assert prepared.headers['User-Agent'] == http_client.DEFAULT_UA


def test_with_default_ua_accepts_none_and_empty_headers():
    """headers=None / {} 都按「无」处理，只补默认 UA。"""
    assert http_client._with_default_ua({'headers': None})['headers'] == {
        'User-Agent': http_client.DEFAULT_UA}
    assert http_client._with_default_ua({})['headers'] == {'User-Agent': http_client.DEFAULT_UA}


def test_with_default_ua_preserves_other_kwargs():
    """只动 headers，其余关键字（params/verify/stream…）原样透传。"""
    kw = http_client._with_default_ua({'params': {'a': 1}, 'verify': False, 'stream': True})
    assert kw['params'] == {'a': 1}
    assert kw['verify'] is False
    assert kw['stream'] is True
    assert kw['headers'] == {'User-Agent': http_client.DEFAULT_UA}


def test_with_default_ua_does_not_mutate_caller_dict():
    """调用方传入的 headers 字典不得被就地改写（避免跨调用污染）。"""
    original = {'X-A': '1'}
    http_client._with_default_ua({'headers': original})
    assert original == {'X-A': '1'}


# --------------------------------------------------------- get / post / _send

def test_get_passes_method_timeout_and_ua_to_send():
    """get 必须把 method/timeout/proxy 与默认 UA 一并交给 _send。"""
    sentinel = _fake_response()
    with patch.object(Session, 'request', return_value=sentinel) as mocked:
        got = http_client.get('http://example.com/a', timeout=(1, 2), params={'q': '1'})
    assert got is sentinel
    assert mocked.call_args.args == ('GET', 'http://example.com/a')
    kwargs = mocked.call_args.kwargs
    assert kwargs['timeout'] == (1, 2)
    assert kwargs['params'] == {'q': '1'}
    assert kwargs['headers']['User-Agent'] == http_client.DEFAULT_UA


def test_get_defaults_to_normal_timeout_and_proxy_on():
    """默认超时 TIMEOUT_NORMAL、默认走代理解析。

    必须拦 _read_wininet：宿主机在 Windows 上启用系统代理（WinINET 注册表）时，
    本用例不拦会拿到真实代理并传 proxies 键，与本断言「无代理不传该键」冲突。
    """
    with _no_env_proxy(), _no_wininet(), \
            patch.object(Session, 'request', return_value=_fake_response()) as mocked:
        http_client.get('http://example.com/a')
    assert mocked.call_args.kwargs['timeout'] == http_client.TIMEOUT_NORMAL
    assert 'proxies' not in mocked.call_args.kwargs  # 无代理时不传该键


def test_post_passes_method_and_body_kwargs():
    """post 走 _send('POST') 且 data/json 原样透传。"""
    with patch.object(Session, 'request', return_value=_fake_response()) as mocked:
        http_client.post('http://example.com/a', data={'x': '1'}, headers={'X-T': 't'})
    assert mocked.call_args.args[0] == 'POST'
    assert mocked.call_args.kwargs['data'] == {'x': '1'}
    assert mocked.call_args.kwargs['headers']['X-T'] == 't'
    assert mocked.call_args.kwargs['headers']['User-Agent'] == http_client.DEFAULT_UA


def test_timeout_constants_are_ordered_pairs():
    """三档超时是 (连接, 读) 二元组且读超时递增。"""
    for value in (http_client.TIMEOUT_FAST, http_client.TIMEOUT_NORMAL, http_client.TIMEOUT_SLOW):
        assert isinstance(value, tuple) and len(value) == 2
        assert value[0] > 0 and value[1] >= value[0]
    assert (http_client.TIMEOUT_FAST[1] < http_client.TIMEOUT_NORMAL[1]
            < http_client.TIMEOUT_SLOW[1])


def test_send_guard_hook_runs_by_default():
    """_send 默认 _guard=True：入网前先过 guard_basic_url，URL 原样传入。"""
    seen = []
    with patch.object(http_client, 'system_proxies', return_value={}), \
            patch.object(http_client, 'guard_basic_url', side_effect=lambda u: seen.append(u)), \
            patch.object(Session, 'request', return_value=_fake_response()):
        http_client._send('GET', 'http://example.com/a')
    assert seen == ['http://example.com/a']


def test_send_guard_can_be_disabled_explicitly():
    """_guard=False 供守卫模块自身的取回链路豁免：钩子不得运行。"""

    def _must_not_run(_url):
        raise AssertionError('guard must not run when _guard=False')

    with patch.object(http_client, 'system_proxies', return_value={}), \
            patch.object(http_client, 'guard_basic_url', side_effect=_must_not_run), \
            patch.object(Session, 'request', return_value=_fake_response()) as mocked:
        http_client._send('GET', 'http://example.com/a', _guard=False)
    assert mocked.call_count == 1


def test_guard_blocks_cloud_metadata_without_any_network_call():
    """云元数据地址在基础入口被拦：请求未发出（连 Session.request 都不许碰）。"""
    with patch.object(Session, 'request', side_effect=AssertionError('no network call allowed')):
        for url in ('http://169.254.169.254/latest/meta-data/',
                    'http://metadata.google.internal/computeMetadata',
                    'http://[fd00:ec2::254]/',
                    'http://2852039166/'):
            try:
                http_client.get(url)
            except ValueError as exc:
                assert 'cloud metadata' in str(exc), url
            else:
                raise AssertionError('%s 未被拦截' % url)


def test_guard_blocks_high_risk_ports_without_any_network_call():
    """高危端口（SMTP/数据库等）无条件拒绝；常规 Web 端口不受影响。"""
    with patch.object(Session, 'request', side_effect=AssertionError('no network call allowed')):
        for port in (22, 25, 3306, 6379, 27017):
            try:
                http_client.get('http://example.com:%d/' % port)
            except ValueError as exc:
                assert 'high-risk port %d' % port in str(exc)
            else:
                raise AssertionError('port %d 未被拦截' % port)
    for port in (80, 443, 8080, 9978):
        http_client.guard_basic_url('http://example.com:%d/' % port)


def test_guard_allows_loopback_and_private_network():
    """回环/私网的放行与否不归基础入口判定（留给逐跳守卫路径），这里必须放行。"""
    for url in ('http://127.0.0.1:9978/api', 'http://10.0.0.1:8080/', 'http://localhost/x'):
        http_client.guard_basic_url(url)
    with patch.object(Session, 'request', return_value=_fake_response()) as mocked:
        http_client.get('http://127.0.0.1:9978/api')
    assert mocked.call_count == 1


def test_send_env_proxy_takes_priority_over_wininet():
    """环境变量代理优先（应用内「代理设置」由主进程注入），命中即不读注册表。"""
    env = {'http': 'http://env.invalid:3128'}
    with patch.object(http_client.requests.utils, 'get_environ_proxies',
                      return_value=env) as env_mock, \
            patch.object(http_client, '_read_wininet',
                         side_effect=AssertionError('wininet must not be read')):
        assert http_client.system_proxies('http://example.com/x') is env
    assert env_mock.call_args.args[0] == 'http://example.com/x'


def test_send_wininet_proxy_is_passed_through():
    """无环境变量代理时回落到 WinINET，并作为 proxies 传给 Session.request。"""
    proxies = {'http': 'http://127.0.0.1:9', 'https': 'http://127.0.0.1:9'}
    with _no_env_proxy(), patch.object(http_client, '_read_wininet',
                                       return_value=(proxies, '')):
        with patch.object(Session, 'request', return_value=_fake_response()) as mocked:
            http_client._send('GET', 'http://example.com/x')
    assert mocked.call_args.kwargs['proxies'] == proxies


def test_send_proxy_failure_falls_back_to_direct():
    """代理连接失败（RequestException）→ 自动回退直连，且直连不再带 proxies。"""
    sentinel = _fake_response()
    calls = []

    def _fake(_method, _url, **kw):
        calls.append(kw)
        if len(calls) == 1:
            raise requests.exceptions.ProxyError('proxy unreachable')
        return sentinel

    proxies = {'http': 'http://127.0.0.1:9'}
    with _no_env_proxy(), patch.object(http_client, '_read_wininet',
                                       return_value=(proxies, '')):
        with patch.object(Session, 'request', side_effect=_fake):
            assert http_client._send('GET', 'http://example.com/x') is sentinel
    assert len(calls) == 2
    assert calls[0]['proxies'] == proxies
    assert 'proxies' not in calls[1], '回退直连不得再带代理'


def test_send_direct_fallback_failure_propagates():
    """代理与直连都失败时抛出直连那次的异常（不是静默 None）。"""
    calls = []

    def _fake(_method, _url, **kw):
        calls.append(kw)
        if len(calls) == 1:
            raise requests.exceptions.ProxyError('proxy unreachable')
        raise requests.exceptions.ConnectionError('host unreachable')

    with _no_env_proxy(), patch.object(http_client, '_read_wininet',
                                       return_value=({'http': 'http://127.0.0.1:9'}, '')):
        with patch.object(Session, 'request', side_effect=_fake):
            try:
                http_client._send('GET', 'http://example.com/x')
            except requests.exceptions.ConnectionError as exc:
                assert 'host unreachable' in str(exc)
            else:
                raise AssertionError('直连也失败时必须抛出')
    assert len(calls) == 2


def test_send_http_error_status_is_not_proxy_failure():
    """HTTP 错误（5xx 响应）不是连接层异常：不触发回退，只发一次请求。"""
    rsp = _fake_response(503, b'upstream down')
    with _no_env_proxy(), patch.object(http_client, '_read_wininet',
                                       return_value=({'http': 'http://127.0.0.1:9'}, '')):
        with patch.object(Session, 'request', return_value=rsp) as mocked:
            assert http_client._send('GET', 'http://example.com/x') is rsp
    assert mocked.call_count == 1


def test_send_non_request_exception_not_swallowed():
    """非 requests 异常（如守卫/编程错误）不得被代理回退的 except 吞掉。"""
    with _no_env_proxy(), patch.object(http_client, '_read_wininet',
                                       return_value=({'http': 'http://127.0.0.1:9'}, '')):
        with patch.object(Session, 'request', side_effect=RuntimeError('boom')):
            try:
                http_client._send('GET', 'http://example.com/x')
            except RuntimeError as exc:
                assert 'boom' in str(exc)
            else:
                raise AssertionError('非 RequestException 必须继续上抛')


def test_send_proxy_false_never_resolves_proxies():
    """proxy=False：完全不解析代理（直连），proxies 键也不出现。"""

    def _must_not_resolve(_url=None):
        raise AssertionError('proxy=False 时不应解析代理')

    with patch.object(http_client, 'system_proxies', side_effect=_must_not_resolve):
        with patch.object(Session, 'request', return_value=_fake_response()) as mocked:
            http_client._send('GET', 'http://example.com/x', proxy=False)
            http_client.get('http://example.com/y', proxy=False)
    assert mocked.call_count == 2
    assert all('proxies' not in c.kwargs for c in mocked.call_args_list)


def test_send_timeout_is_propagated_verbatim():
    """timeout 原样透传（含标量档位与自定义元组），不给隐式默认值。"""
    with patch.object(http_client, 'system_proxies', return_value={}):
        with patch.object(Session, 'request', return_value=_fake_response()) as mocked:
            http_client._send('GET', 'http://example.com/x', timeout=(1.5, 2.5))
            http_client.get('http://example.com/y', timeout=http_client.TIMEOUT_FAST)
            http_client.post('http://example.com/z', timeout=http_client.TIMEOUT_SLOW)
    assert [c.kwargs['timeout'] for c in mocked.call_args_list] == [
        (1.5, 2.5), http_client.TIMEOUT_FAST, http_client.TIMEOUT_SLOW]


def test_timeout_connect_exception_surfaces_to_caller():
    """连接超时（ConnectTimeout）是 RequestException 子类：无代理时直接上抛。"""
    with patch.object(http_client, 'system_proxies', return_value={}):
        with patch.object(Session, 'request',
                          side_effect=requests.exceptions.ConnectTimeout('connect timeout')):
            try:
                http_client.get('http://example.com/x')
            except requests.exceptions.ConnectTimeout as exc:
                assert 'connect timeout' in str(exc)
            else:
                raise AssertionError('连接超时必须上抛')


def test_read_timeout_is_distinct_from_connect_timeout():
    """读超时与连接超时异常类型不同（调用方据此区分重试语义）。"""
    assert issubclass(requests.exceptions.ReadTimeout, requests.exceptions.Timeout)
    assert issubclass(requests.exceptions.ConnectTimeout, requests.exceptions.Timeout)
    assert issubclass(requests.exceptions.Timeout, requests.exceptions.RequestException)
    assert not issubclass(requests.exceptions.ConnectTimeout, requests.exceptions.ReadTimeout)


# ------------------------------------------------------------- 代理解析内部

def test_read_wininet_disabled_or_missing_returns_empty():
    """ProxyEnable=0 / ProxyServer 空 / 非 Windows（无 winreg）→ ({}, '')。"""
    with _no_env_proxy():
        with _patch_wininet({'ProxyEnable': 0, 'ProxyServer': 'p.invalid:8080',
                             'ProxyOverride': ''}):
            assert http_client._read_wininet() == ({}, '')
        with _patch_wininet({'ProxyEnable': 1, 'ProxyServer': '', 'ProxyOverride': ''}):
            assert http_client._read_wininet() == ({}, '')
    with patch.dict(sys.modules, {'winreg': None}):
        assert http_client._read_wininet() == ({}, '')


def test_read_wininet_plain_server_applies_to_both_schemes():
    """单地址形态：http/https 同指一个代理。"""
    with _patch_wininet({'ProxyEnable': 1, 'ProxyServer': '127.0.0.1:8888',
                         'ProxyOverride': ''}):
        proxies, bypass = http_client._read_wininet()
    assert proxies == {'http': 'http://127.0.0.1:8888', 'https': 'http://127.0.0.1:8888'}
    assert bypass == ''


def test_read_wininet_per_protocol_entries():
    """按协议指定形态：http=/https= 分别取用。"""
    with _patch_wininet({'ProxyEnable': 1,
                         'ProxyServer': 'http=h1:1;https=h2:2',
                         'ProxyOverride': 'local;*.corp'}):
        proxies, bypass = http_client._read_wininet()
    assert proxies == {'http': 'http://h1:1', 'https': 'http://h2:2'}
    assert bypass == 'local;*.corp'


def test_read_wininet_protocol_map_falls_back_to_first_addr():
    """有 = 但无 http/https 条目时回退第一个可用地址（go_proxy 语义）。"""
    with _patch_wininet({'ProxyEnable': 1, 'ProxyServer': 'socks=127.0.0.1:1080',
                         'ProxyOverride': ''}):
        proxies, _ = http_client._read_wininet()
    assert proxies == {'http': 'http://127.0.0.1:1080', 'https': 'http://127.0.0.1:1080'}


def test_read_wininet_missing_bypass_key_defaults_empty():
    """ProxyOverride 键缺失（OSError）→ bypass 视为空串，不整体失败。"""
    with _patch_wininet({'ProxyEnable': 1, 'ProxyServer': '127.0.0.1:8888'},
                        miss_bypass=True):
        proxies, bypass = http_client._read_wininet()
    assert proxies == {'http': 'http://127.0.0.1:8888', 'https': 'http://127.0.0.1:8888'}
    assert bypass == ''


def test_should_bypass_localhost_and_local_names():
    """loopback 地址与 <local>（无点主机名）恒直连。"""
    for url in ('http://127.0.0.1:8080/x', 'http://localhost/x', 'http://[::1]/x',
                'http://LOCALHOST/x'):
        assert http_client._should_bypass(url, '') is True, url
    assert http_client._should_bypass('http://intranet/x', '<local>') is True
    assert http_client._should_bypass('http://intranet.corp/x', '<local>') is False


def test_should_bypass_wildcard_and_substring():
    """通配符后缀（*.corp）与子串命中直连；不命中则走代理。"""
    assert http_client._should_bypass('http://a.corp/x', '*.corp') is True
    assert http_client._should_bypass('http://a.corp.example/x', '*.corp') is False
    assert http_client._should_bypass('http://cdn.example.com/x', 'example') is True
    assert http_client._should_bypass('http://cdn.example.com/x', '*.example.com') is True
    assert http_client._should_bypass('http://cdn.other.org/x', 'example') is False
    assert http_client._should_bypass('http://cdn.other.org/x', '') is False


def test_should_bypass_trims_and_skips_empty_items():
    """bypass 项逐段 strip 后比对，空段跳过（';;' 之类不产生误命中）。"""
    assert http_client._should_bypass('http://cdn.example.com/x', ';; example ;') is True
    assert http_client._should_bypass('http://cdn.example.com/x', ' ; ; ') is False
    assert http_client._should_bypass('http://cdn.example.com/x', '<local>;*.foo') is False
    assert http_client._should_bypass('http://cdn.example.com/x', '*.FOO;EXAMPLE') is True


def test_should_bypass_invalid_url_is_treated_as_bypass():
    """URL 解析失败（如未闭合 IPv6）→ 保守直连（True），不抛异常。"""
    assert http_client._should_bypass('http://[::1', '') is True


def test_system_proxies_wininet_respects_bypass():
    """无环境变量代理时，WinINET + ProxyOverride：命中 bypass 的 URL 返回空。"""
    with _no_env_proxy(), patch.object(http_client, '_read_wininet',
                                       return_value=({'http': 'http://127.0.0.1:9'}, '*.corp')):
        assert http_client.system_proxies('http://a.corp/x') == {}
        assert http_client.system_proxies('http://a.example/x') == {'http': 'http://127.0.0.1:9'}


def test_system_proxies_returns_empty_when_nothing_configured():
    """无任何代理来源 → {}（requests 不接受空 proxies 语义外的东西）。"""
    with _no_env_proxy(), _no_wininet():
        assert http_client.system_proxies('http://example.com/x') == {}
        assert http_client.system_proxies() == {}


def test_system_proxy_addr_parses_host_and_port():
    """system_proxy_addr 取 https 优先、回退 http，返回 (host, port)。"""
    with patch.object(http_client, 'system_proxies',
                      return_value={'https': 'http://127.0.0.1:8888'}):
        assert http_client.system_proxy_addr() == ('127.0.0.1', 8888)
    with patch.object(http_client, 'system_proxies',
                      return_value={'http': 'http://proxy.corp:3128'}):
        assert http_client.system_proxy_addr() == ('proxy.corp', 3128)


def test_system_proxy_addr_none_when_disabled_or_unparsable():
    """未启用 / 无端口 / 空串 → None（jar_bridge 据此不给 JVM 设代理属性）。"""
    for proxies in ({}, {'https': ''}, {'https': 'http://proxy.corp'}, {'https': '::::'}):
        with patch.object(http_client, 'system_proxies', return_value=proxies):
            assert http_client.system_proxy_addr() is None, proxies


# --------------------------------------------------- inet_aton 归一（M-2）

def test_parse_inet_seg_hex_octal_decimal():
    """段解析三进制：0x 十六进制 / 前导 0 八进制 / 十进制。"""
    assert http_client._parse_inet_seg('0xa9', 8) == 169
    assert http_client._parse_inet_seg('0XA9', 8) == 169
    assert http_client._parse_inet_seg('0251', 8) == 169
    assert http_client._parse_inet_seg('169', 8) == 169
    assert http_client._parse_inet_seg('0', 8) == 0


def test_parse_inet_seg_respects_bit_limit():
    """段值超该段位宽上限 → None（不是 IP，走域名逻辑）。"""
    assert http_client._parse_inet_seg('255', 8) == 255
    assert http_client._parse_inet_seg('256', 8) is None
    assert http_client._parse_inet_seg('65535', 16) == 65535
    assert http_client._parse_inet_seg('65536', 16) is None
    assert http_client._parse_inet_seg('16777215', 24) is not None
    assert http_client._parse_inet_seg('16777216', 24) is None


def test_parse_inet_seg_rejects_non_numeric_forms():
    """空段/负号/非法进制字符/超大整数 → None。"""
    for seg in ('', '-1', '0x', '0xzz', '08', '1.2', '0x1_2', '12345678901234567890',
                '+1', '0o7', 'abc'):
        assert http_client._parse_inet_seg(seg, 8) is None, seg
    assert http_client._parse_inet_seg('0xffffffff', 32) == 0xFFFFFFFF
    assert http_client._parse_inet_seg('0x1ffffffff', 32) is None  # 超过 8 位十六进制


def test_normalize_inet_aton_host_various_shapes():
    """1~4 段形态归一为点分十进制（inet_aton 语义：末段承载剩余字节）。"""
    cases = {
        '0xa9fea9fe': '169.254.169.254',
        '2852039166': '169.254.169.254',
        '169.16689662': '169.254.169.254',      # a.b：b 承载 24 位
        '169.254.43518': '169.254.169.254',     # a.b.c：c 承载 16 位
        '0251.0376.0251.0376': '169.254.169.254',
        '0xa9.0xfe.0xa9.0xfe': '169.254.169.254',
        '0xA9.254.169.254': '169.254.169.254',
        '1.2.3.4': '1.2.3.4',
        '1.2': '1.0.0.2',              # a.b：a 是首段，b 承载后 24 位
        '127.1': '127.0.0.1',          # 本机简写（inet_aton 同语义）
        '0': '0.0.0.0',
    }
    for host, expect in cases.items():
        assert http_client._normalize_inet_aton_host(host) == expect, host


def test_normalize_inet_aton_host_rejects_out_of_range():
    """段数 > 4 / 段值越界 / 空段 → None（按域名放行，避免误伤）。"""
    for host in ('1.2.3.4.5', '256.1.1.1', '1..2.3', '', 'abc', '-1.2.3.4',
                 '08.1.1.1', '1.2.3.4.', '999999999999'):
        assert http_client._normalize_inet_aton_host(host) is None, host


def test_is_cloud_metadata_host_ipv6_forms():
    """IPv6 IMDS 与 IPv4-mapped 形态（含 URL 里的方括号）都判为元数据端点。"""
    assert http_client._is_cloud_metadata_host('fd00:ec2::254') is True
    assert http_client._is_cloud_metadata_host('[fd00:ec2::254]') is True
    assert http_client._is_cloud_metadata_host('::ffff:169.254.169.254') is True
    assert http_client._is_cloud_metadata_host('[::ffff:169.254.169.254]') is True
    assert http_client._is_cloud_metadata_host('169.254.169.254') is True
    assert http_client._is_cloud_metadata_host('METADATA.GOOG') is True
    assert http_client._is_cloud_metadata_host('') is False
    assert http_client._is_cloud_metadata_host(None) is False
    assert http_client._is_cloud_metadata_host('169.254.170.254') is False


def test_guard_basic_url_non_http_scheme_skipped():
    """非 http/https scheme 不在基础入口的判定范围（交给各自解析器）。"""
    http_client.guard_basic_url('file:///etc/passwd')
    http_client.guard_basic_url('ftp://169.254.169.254/x')
    http_client.guard_basic_url('')
    http_client.guard_basic_url(None)


def test_guard_basic_url_cloud_metadata_beats_high_risk_port():
    """元数据地址即使同时命中高危端口，也先按元数据拒绝（判定顺序固化）。"""
    try:
        http_client.guard_basic_url('http://169.254.169.254:3306/')
    except ValueError as exc:
        assert 'cloud metadata' in str(exc), '元数据判定应先于端口判定'
    else:
        raise AssertionError('元数据地址必须被拦')


def test_guard_basic_url_malformed_url_fails_open():
    """URL 畸形到 `urlsplit` 都认不出 scheme（'::::' / 'ht tp://x/' / 非字符串）
    → 直接放行，钩子不改变存量行为。"""
    for url in ('::::', 'ht tp://x/', '', None, 12345, b'http://x/'):
        http_client.guard_basic_url(url)


def test_guard_basic_url_urlsplit_value_error_propagates_as_rejection():
    """已知缺陷（http_client.py:327-338）：docstring 承诺「守卫模块缺席/异常时
    放行（fail-open）」，但 `except ValueError: raise` 无法区分**守卫自己的
    拒绝**与 `urlsplit` 解析 URL 时抛出的 ValueError：

    - `http://[::1`（未闭合 IPv6 方括号）→ ValueError: Invalid IPv6 URL
    - `http://example.com:99999/`（端口越界）→ ValueError: Port out of range 0-65535

    两者都被当成守卫拒绝上抛给调用方（伪装成 SSRF 拦截），而不是让后续真实
    请求去报错。固化当前实际行为；修复后这两个用例应改为断言不抛 ValueError。
    """
    for url, marker in (('http://[::1', 'Invalid IPv6 URL'),
                        ('http://example.com:99999/', 'Port out of range')):
        try:
            http_client.guard_basic_url(url)
        except ValueError as exc:
            assert marker in str(exc), '%s: %s' % (url, exc)
        else:
            raise AssertionError('%s 的解析错误被错误地表现为守卫拒绝' % url)


# ---------------------------------------------------------------- 限长读取

def test_read_capped_within_limit_concatenates():
    """未超限：按块拼接原文，且读取结束后关闭响应。"""
    stub = _Chunked([b'ab', b'cd', b''])
    assert http_client._read_capped(stub, 10) == b'abcd'
    assert stub.closed == 1


def test_read_capped_exact_boundary_allowed():
    """边界：total == limit 放行（> limit 才拒绝）。"""
    stub = _Chunked([b'x' * 8])
    assert http_client._read_capped(stub, 8) == b'x' * 8
    stub2 = _Chunked([b'x' * 8])
    try:
        http_client._read_capped(stub2, 7)
    except ValueError as exc:
        assert 'exceeds 7 bytes cap' in str(exc)
    else:
        raise AssertionError('超限时必须拒绝')


def test_read_capped_over_limit_closes_and_raises():
    """超限立刻 close（断连）并抛 ValueError，错误里带上 URL 便于定位。"""
    stub = _Chunked([b'a' * 5, b'b' * 5], url='http://example.com/big')
    try:
        http_client._read_capped(stub, 6)
    except ValueError as exc:
        assert 'exceeds 6 bytes cap' in str(exc)
        assert 'http://example.com/big' in str(exc)
    else:
        raise AssertionError('超限未抛错')
    assert stub.closed >= 1, '超限必须断连（close）'


def test_read_capped_limit_is_sanitized_to_at_least_one():
    """limit 被 max(1, int(limit)) 规整：负数/0 退化为 1（但 1 只拦 >1 字节），
    浮点取整。"""
    assert http_client._read_capped(_Chunked([b'a']), 0) == b'a'
    assert http_client._read_capped(_Chunked([b'a']), -5) == b'a'
    assert http_client._read_capped(_Chunked([]), -5) == b''
    try:
        http_client._read_capped(_Chunked([b'ab']), 1)
    except ValueError as exc:
        assert 'exceeds 1 bytes cap' in str(exc)
    else:
        raise AssertionError('limit=1 时两字节 body 必须被拒')
    assert http_client._read_capped(_Chunked([b'ab']), 2.0) == b'ab'
    assert http_client._read_capped(_Chunked([b'ab']), 2.9) == b'ab', '浮点向下取整'


def test_read_capped_closes_even_when_iteration_raises():
    """iter_content 抛错时 finally 仍关闭响应（连接归还连接池）。"""
    class _Boom(_Chunked):
        def iter_content(self, chunk_size=1):
            yield b'a'
            raise RuntimeError('stream broken')

    stub = _Boom([])
    try:
        http_client._read_capped(stub, 100)
    except RuntimeError as exc:
        assert 'stream broken' in str(exc)
    else:
        raise AssertionError('迭代异常必须上抛')
    assert stub.closed == 1


def test_read_capped_counts_upstream_chunks_not_bytes():
    """限长按上游吐出的块累计，且**在累计后、追加前**判超限：任一抵达时点
    总字节 > limit 即立刻断连抛错，不等到后续块。

    用 64KB 的 _CHUNK_SIZE 验证真实切片路径：10KB 的 limit 在第 1 块（64KB）
    就超限；若把 limit 放宽到 100KB，同样的 200KB 响应会在第 4 块才超限——
    断言必须落在前 3 块的内容不被保留上。
    """
    rsp = _fake_response(200, b'z' * (200 * 1024))
    try:
        http_client._read_capped(rsp, 10 * 1024)
    except ValueError as exc:
        assert 'exceeds 10240 bytes cap' in str(exc)
    else:
        raise AssertionError('超限时必须拒绝')
    assert rsp.raw.released >= 1, '超限必须断连释放'
    assert rsp.raw.stream_calls == [http_client._CHUNK_SIZE], '按设备的块尺寸读取'

    exact = _fake_response(200, b'z' * (64 * 1024))
    assert http_client._read_capped(exact, 64 * 1024) == b'z' * (64 * 1024)


def test_read_capped_real_streaming_response():
    """与真实 requests.Response（stream=True）配合：分块读取后内容完整，
    且 close() 触发 release_conn（连接归还连接池，否则 pool_maxsize=16
    会被耗尽）。"""
    rsp = _fake_response(200, b'x' * 200, chunks=[b'x' * 64, b'x' * 64, b'x' * 72])
    assert http_client._read_capped(rsp, http_client.MAX_API_RESPONSE_BYTES) == b'x' * 200
    assert rsp.raw.released == 1, '读完必须释放连接（close → release_conn）'
    limited = _fake_response(200, b'x' * 200, chunks=[b'x' * 64, b'x' * 64, b'x' * 72])
    try:
        http_client._read_capped(limited, 100)
    except ValueError as exc:
        assert 'exceeds 100 bytes cap' in str(exc)
    else:
        raise AssertionError('分块响应超限时必须拒绝')
    assert limited.raw.released >= 1, '超限断连也必须释放连接'


# ------------------------------------------------------------- _CappedResponse

def test_capped_response_exposes_duck_typed_fields():
    """鸭子类型兼容 requests.Response：status/headers/url/content/encoding。"""
    src = _fake_response(201, b'{"a":1}', {'Content-Type': 'application/json'},
                         url='http://example.com/api', encoding='utf-8')
    capped = http_client._CappedResponse(src, b'{"a":1}', 'utf-8')
    assert capped.status_code == 201
    assert capped.headers['content-type'] == 'application/json'   # 大小写不敏感
    assert capped.url == 'http://example.com/api'
    assert capped.content == b'{"a":1}'
    assert capped.text == '{"a":1}'


def test_capped_response_text_decodes_utf8_and_gbk():
    """text 按响应声明的 encoding 解码：UTF-8 与 GBK 都要正确还原中文。"""
    utf8 = '中文'.encode('utf-8')
    assert http_client._CappedResponse(_fake_response(), utf8, 'utf-8').text == '中文'
    gbk = '中文'.encode('gbk')
    assert http_client._CappedResponse(_fake_response(), gbk, 'gbk').text == '中文'


def test_capped_response_text_falls_back_to_replace():
    """编码声明错误/乱码：errors='replace' 兜底，不让解码炸掉调用方。"""
    broken = http_client._CappedResponse(_fake_response(), b'\xff\xfe\xfd', 'utf-8')
    assert broken.text and broken.text.startswith('�')
    empty_enc = http_client._CappedResponse(_fake_response(), '中文'.encode('utf-8'), '')
    assert empty_enc.text == '中文', "encoding 为空串时按 utf-8 解"


def test_capped_response_apparent_encoding_cached_and_safe():
    """apparent_encoding 只算一次（缓存），chardet 异常/空结果降级为空串。"""
    capped = http_client._CappedResponse(_fake_response(), '中文'.encode('gbk'), 'gbk')
    first = capped.apparent_encoding
    assert isinstance(first, str)
    capped._apparent_encoding = 'pinned'
    assert capped.apparent_encoding == 'pinned', '结果必须缓存，避免重复探测'

    capped2 = http_client._CappedResponse(_fake_response(), b'\xff\xfe', '')
    with patch.object(http_client.requests.compat, 'chardet',
                      MagicMock(detect=MagicMock(side_effect=RuntimeError('no chardet')))):
        assert capped2.apparent_encoding == ''
    capped3 = http_client._CappedResponse(_fake_response(), b'plain', '')
    with patch.object(http_client.requests.compat, 'chardet',
                      MagicMock(detect=MagicMock(return_value=None))):
        assert capped3.apparent_encoding == ''
    with patch.object(http_client.requests.compat, 'chardet',
                      MagicMock(detect=MagicMock(return_value={'encoding': 'gb18030'}))):
        assert http_client._CappedResponse(_fake_response(), b'x', '').apparent_encoding == 'gb18030'


def test_capped_response_raise_for_status_boundary():
    """raise_for_status：>=400 抛 HTTPError，399/400 边界正确。"""
    assert http_client._CappedResponse(_fake_response(400), b'', '').raise_for_status.__self__ \
        is not None
    http_client._CappedResponse(_fake_response(399), b'', '').raise_for_status()
    http_client._CappedResponse(_fake_response(404, url='http://example.com/miss'),
                                b'', '').raise_for_status  # 取属性不抛错
    for code in (400, 404, 500, 503):
        capped = http_client._CappedResponse(_fake_response(code, url='http://e/x'), b'', '')
        try:
            capped.raise_for_status()
        except requests.HTTPError as exc:
            assert str(code) in str(exc) and 'http://e/x' in str(exc)
        else:
            raise AssertionError('%d 应抛 HTTPError' % code)


def test_capped_response_iter_content_and_close():
    """iter_content 按 chunk_size 切块；close 是安全的空操作。"""
    capped = http_client._CappedResponse(_fake_response(), b'abcdefg', 'utf-8')
    assert list(capped.iter_content(3)) == [b'abc', b'def', b'g']
    assert list(capped.iter_content(64)) == [b'abcdefg']
    assert b''.join(capped.iter_content(1)) == b'abcdefg'
    capped.close()


def test_capped_response_iter_content_zero_yields_empty_slices():
    """已知缺陷（http_client.py:455）：`max(1, chunk_size)` 只作用在
    range 的**步长**上，切片仍是 `content[start:start + chunk_size]`——
    chunk_size=0 时得到 7 个空切片（不死循环，但语义错误：调用方拿到
    len(body) 个空块而非数据）。chunk_size 为负时更彻底：切片为空且
    range 为空 → 静默丢失整个 body。固化当前实际行为。"""
    capped = http_client._CappedResponse(_fake_response(), b'abcdefg', 'utf-8')
    assert list(capped.iter_content(0)) == [b''] * 7
    negative = list(capped.iter_content(-3))
    assert negative == [b'abcd', b'bcde', b'cdef', b'', b'', b'', b''], negative
    assert b''.join(negative) != b'abcdefg', '负 chunk_size 产出错误的重叠切片'


def test_capped_response_defaults_for_missing_attributes():
    """源响应缺属性时取安全默认值（status 0 / 空 headers / 空 url）。"""
    bare = MagicMock()
    bare.status_code = None
    bare.headers = None
    bare.url = None
    del bare.encoding
    capped = http_client._CappedResponse(bare, b'', None)
    assert capped.status_code == 0
    assert dict(capped.headers) == {}
    assert capped.url == ''
    assert capped.text == ''


# ------------------------------------------------------ 逐跳守卫与重定向

def test_redirect_statuses_constant():
    """重定向状态码集合：不含 300/304（304 无 Location，不该被跟随）。"""
    assert http_client._REDIRECT_STATUSES == (301, 302, 303, 307, 308)
    assert 300 not in http_client._REDIRECT_STATUSES
    assert 304 not in http_client._REDIRECT_STATUSES


def test_fetch_single_hop_returns_capped_response():
    """无跳转：直接返回 _CappedResponse，且请求带 allow_redirects=False + stream。"""
    body = b'cms_json'
    rsp = _fake_response(200, body, {'Content-Type': 'application/json'}, encoding='utf-8')
    with patch.object(http_client, '_guard_hop', side_effect=lambda u, **kw: u), \
            patch.object(http_client, '_send', return_value=rsp) as send_mock:
        got = http_client.fetch_follow_redirects('http://example.com/api')
    assert isinstance(got, http_client._CappedResponse)
    assert got.status_code == 200 and got.content == body and got.text == 'cms_json'
    kwargs = send_mock.call_args.kwargs
    assert kwargs['allow_redirects'] is False
    assert kwargs['stream'] is True
    assert kwargs['headers']['User-Agent'] == http_client.DEFAULT_UA
    assert kwargs['timeout'] == http_client.TIMEOUT_NORMAL


def test_fetch_3xx_without_location_is_final_response():
    """3xx 但没有 Location：无从跟随，按最终响应返回（保留原状态码）。"""
    rsp = _fake_response(302, b'moved', {})
    with patch.object(http_client, '_guard_hop', side_effect=lambda u, **kw: u), \
            patch.object(http_client, '_send', return_value=rsp):
        got = http_client.fetch_follow_redirects('http://example.com/x')
    assert got.status_code == 302
    assert got.content == b'moved'


def test_fetch_follows_absolute_and_relative_location():
    """Location 相对路径必须 urljoin（拼出非法 URL 是原实现的 bug）。"""
    first = _fake_response(301, b'', {'Location': '/next/page'})
    second = _fake_response(200, b'done')
    responses = iter([first, second])
    urls = []
    with patch.object(http_client, '_guard_hop', side_effect=lambda u, **kw: u), \
            patch.object(http_client, '_send',
                         side_effect=lambda m, u, **kw: (urls.append(u), next(responses))[1]):
        got = http_client.fetch_follow_redirects('http://example.com/a/b?x=1')
    assert urls == ['http://example.com/a/b?x=1', 'http://example.com/next/page']
    assert got.status_code == 200 and got.content == b'done'


def test_fetch_closes_redirect_response_before_next_guard():
    """3xx 响应取完 Location 立刻 close，且必须早于下一跳守卫——
    守卫拒绝时若没关，连接永不归还 pool_maxsize=16 的连接池（每跳泄漏一个 slot）。"""
    rsp = _fake_response(302, b'', {'Location': 'http://10.0.0.1/'})
    closed = []
    rsp.close = lambda: closed.append(1)
    refused = []

    def _guard(url, **kw):
        refused.append(url)
        if url.startswith('http://10.0.0.1'):
            raise ValueError('private_network_blocked')
        return url

    with patch.object(http_client, '_guard_hop', side_effect=_guard), \
            patch.object(http_client, '_send', return_value=rsp) as send_mock:
        try:
            http_client.fetch_follow_redirects('http://example.com/a', max_redirects=3)
        except ValueError as exc:
            assert 'private_network_blocked' in str(exc)
        else:
            raise AssertionError('守卫拒绝必须上抛')
    assert closed == [1], '3xx 响应必须在取到 Location 后立刻关闭'
    assert send_mock.call_count == 1
    assert refused[-1] == 'http://10.0.0.1/'


def test_fetch_too_many_redirects_raises_after_exhausting_hops():
    """超过 max_redirects 抛 ValueError（原实现无上限 → RecursionError）。"""
    endless = _fake_response(302, b'', {'Location': '/again'})
    with patch.object(http_client, '_guard_hop', side_effect=lambda u, **kw: u), \
            patch.object(http_client, '_send', return_value=endless) as send_mock:
        try:
            http_client.fetch_follow_redirects('http://example.com/a', max_redirects=2)
        except ValueError as exc:
            assert 'too many redirects' in str(exc) and '>2' in str(exc)
        else:
            raise AssertionError('循环重定向必须被上限拦住')
    assert send_mock.call_count == 3, 'max_redirects=2 → 最多 3 次请求'


def test_fetch_max_redirects_zero_follows_no_hop():
    """max_redirects=0：只发一次请求，遇到 302 即触发上限（不做任何跟随）。"""
    with patch.object(http_client, '_guard_hop', side_effect=lambda u, **kw: u), \
            patch.object(http_client, '_send',
                         return_value=_fake_response(308, b'', {'Location': '/x'})) as send_mock:
        try:
            http_client.fetch_follow_redirects('http://example.com/a', max_redirects=0)
        except ValueError as exc:
            assert 'too many redirects' in str(exc)
        else:
            raise AssertionError('max_redirects=0 不应跟随')
    assert send_mock.call_count == 1


def test_fetch_all_redirect_statuses_are_followed():
    """301/302/303/307/308 全部跟随；300/304 视为最终响应。"""
    for code in http_client._REDIRECT_STATUSES:
        responses = iter([_fake_response(code, b'', {'Location': '/t'}),
                          _fake_response(200, b'ok')])
        with patch.object(http_client, '_guard_hop', side_effect=lambda u, **kw: u), \
                patch.object(http_client, '_send',
                             side_effect=lambda m, u, **kw: next(responses)):
            assert http_client.fetch_follow_redirects('http://example.com/a').status_code == 200
    for code in (300, 304):
        with patch.object(http_client, '_guard_hop', side_effect=lambda u, **kw: u), \
                patch.object(http_client, '_send',
                             return_value=_fake_response(code, b'body')):
            got = http_client.fetch_follow_redirects('http://example.com/a')
        assert got.status_code == code


def test_fetch_guard_hop_runs_on_every_hop():
    """每一跳都过守卫：首跳带 trust_root，跳转目标 trust_redirect=True。"""
    seen = []
    responses = iter([_fake_response(302, b'', {'Location': '/h2'}),
                      _fake_response(200, b'ok')])

    def _guard(url, **kw):
        seen.append((url, kw.get('kind'), kw.get('trust_root'), kw.get('trust_redirect')))
        return url

    with patch.object(http_client, '_guard_hop', side_effect=_guard), \
            patch.object(http_client, '_send', side_effect=lambda m, u, **kw: next(responses)):
        http_client.fetch_follow_redirects('http://example.com/a', kind='site',
                                           trust_root='http://example.com/a')
    assert len(seen) == 2
    # 后续跳只传 trust_redirect=True，trust_root 走函数默认参数（''）→ kw 里缺席
    assert seen[0] == ('http://example.com/a', 'site', 'http://example.com/a', None)
    assert seen[1] == ('http://example.com/h2', 'site', None, True)
    assert seen[1][2] is None and seen[1][3] is True, '跳转目标不得继承信任根'


def test_fetch_params_join_with_and_without_existing_query():
    """params 拼 query：已有 ? 用 &，没有用 ?；空 params 不追加分隔符。"""
    with patch.object(http_client, '_guard_hop', side_effect=lambda u, **kw: u), \
            patch.object(http_client, '_send', side_effect=_one_shot()) as send_mock:
        http_client.fetch_follow_redirects('http://example.com/api', params={'ac': 'list'})
        assert send_mock.call_args.args[1] == 'http://example.com/api?ac=list'
        http_client.fetch_follow_redirects('http://example.com/api?t=1', params={'ac': 'list'})
        assert send_mock.call_args.args[1] == 'http://example.com/api?t=1&ac=list'
        http_client.fetch_follow_redirects('http://example.com/api', params={})
        assert send_mock.call_args.args[1] == 'http://example.com/api'
        http_client.fetch_follow_redirects('http://example.com/api')
        assert send_mock.call_args.args[1] == 'http://example.com/api'


def test_fetch_caller_headers_win_and_max_bytes_propagates():
    """调用方 UA 优先；max_bytes 作为限长下传给 _read_capped。"""
    src = _fake_response(200, b'abcdef', encoding='utf-8')
    with patch.object(http_client, '_guard_hop', side_effect=lambda u, **kw: u), \
            patch.object(http_client, '_send', return_value=src) as send_mock:
        got = http_client.fetch_follow_redirects('http://example.com/a',
                                                 headers={'User-Agent': 'mine', 'X-T': '1'},
                                                 max_bytes=8)
        assert got.content == b'abcdef'
        assert send_mock.call_args.kwargs['headers'] == {'User-Agent': 'mine', 'X-T': '1'}
        assert send_mock.call_args.kwargs['timeout'] == http_client.TIMEOUT_NORMAL
    big = _fake_response(200, b'y' * 100, chunks=[b'y' * 100])
    with patch.object(http_client, '_guard_hop', side_effect=lambda u, **kw: u), \
            patch.object(http_client, '_send', return_value=big):
        try:
            http_client.fetch_follow_redirects('http://example.com/big', max_bytes=10)
        except ValueError as exc:
            assert 'exceeds 10 bytes cap' in str(exc)
        else:
            raise AssertionError('max_bytes 必须生效')


def test_security_guard_missing_disables_hop_guard():
    """守卫模块缺席（_security_guard 返回 None）→ _guard_hop 原样返回，
    行为同旧版（fail-open 口径一致）。"""
    with patch.object(http_client, '_security_guard', return_value=None):
        assert http_client._security_guard() is None
        assert http_client._guard_hop('http://10.0.0.1/x', kind='site') == 'http://10.0.0.1/x'
        assert http_client._guard_hop('http://example.com/x', kind='config',
                                      trust_root='http://example.com') == 'http://example.com/x'


def test_security_guard_import_error_is_swallowed_only_at_import():
    """已知缺陷（http_client.py:379-385 vs 388）：`_security_guard` 内部的
    try/except 只包住 **import** 那一行——守卫模块自身在**调用期**抛出的异常
    （ConfigSecurityPolicy.from_env / guard_url 内部错误）不会被降级，而是
    直接穿透给调用方。docstring 承诺的是「守卫缺席时放行」，与实现只覆盖
    导入失败不一致。

    这里固化当前行为：在 _security_guard 层面抛错必然穿透（守卫模块不是
    缺席而是坏了 → 拒绝放行更安全，但 docstring 需更正）。
    """
    with patch.object(http_client, '_security_guard', side_effect=RuntimeError('import boom')):
        try:
            http_client._guard_hop('http://example.com/x', kind='config')
        except RuntimeError as exc:
            assert 'import boom' in str(exc)
        else:
            raise AssertionError('守卫模块损坏时异常会穿透（当前实现，非 fail-open）')


def test_guard_hop_trust_root_vs_trust_redirect():
    """trust_root 非空 → for_source 建立信任；trust_redirect=True → 显式忽略信任根。"""
    calls = []
    trust_root_obj = object()
    empty_obj = object()
    policy_obj = object()

    class _Policy:
        @staticmethod
        def from_env(**kw):
            calls.append('from_env')
            return policy_obj

    class _Trust:
        def __init__(self):
            calls.append('empty')

        @classmethod
        def for_source(cls, source, policy=None):
            calls.append(('for_source', source))
            return trust_root_obj

    def _guard_url(url, policy=None, trust=None, kind='config'):
        calls.append(('guard_url', url, kind, policy, trust))
        return url

    with patch.object(http_client, '_security_guard',
                      return_value=(_guard_url, _Policy, _Trust, ValueError)):
        assert http_client._guard_hop('http://a/x', kind='site',
                                      trust_root='http://a/') == 'http://a/x'
        assert calls[0] == 'from_env'
        assert calls[1] == ('for_source', 'http://a/')
        assert calls[2][3] is policy_obj and calls[2][4] is trust_root_obj
        calls.clear()
        http_client._guard_hop('http://b/x', kind='config', trust_redirect=True)
        assert calls[1] == 'empty', 'trust_redirect 时不得继承信任根'
        calls.clear()
        http_client._guard_hop('http://c/x', kind='config')
        assert calls[1] == 'empty', 'trust_root 为空时无受信 origin'
        assert empty_obj is not None


def test_fetch_surfaces_guard_rejection_before_first_request():
    """首跳就被守卫拒绝：不得发出任何请求。"""
    with patch.object(http_client, '_guard_hop',
                      side_effect=ValueError('private_network_blocked')), \
            patch.object(http_client, '_send',
                         side_effect=AssertionError('no request allowed')):
        try:
            http_client.fetch_follow_redirects('http://10.0.0.1/x')
        except ValueError as exc:
            assert 'private_network_blocked' in str(exc)
        else:
            raise AssertionError('守卫拒绝必须上抛')


def test_fetch_body_size_defaults_to_api_cap():
    """默认限长取 MAX_API_RESPONSE_BYTES（10MB），重定向取回档 32MB 另有用途。"""
    assert http_client.MAX_API_RESPONSE_BYTES == 10 * 1024 * 1024
    assert http_client.MAX_REDIRECT_BODY_BYTES == 32 * 1024 * 1024
    assert http_client._CHUNK_SIZE == 64 * 1024
    big = _fake_response(200, b'z' * 200, chunks=[b'z' * 200])
    with patch.object(http_client, '_guard_hop', side_effect=lambda u, **kw: u), \
            patch.object(http_client, '_send', return_value=big), \
            patch.object(http_client, 'MAX_API_RESPONSE_BYTES', 8):
        try:
            http_client.fetch_follow_redirects('http://example.com/big')
        except ValueError as exc:
            assert 'exceeds 8 bytes cap' in str(exc)
        else:
            raise AssertionError('默认档必须落到 MAX_API_RESPONSE_BYTES')


def _patch_wininet(values, miss_bypass=False):
    """造一个 winreg 替身注入 sys.modules，避开真实注册表读写。"""
    winreg = MagicMock()
    winreg.HKEY_CURRENT_USER = 'HKCU'
    key = MagicMock()
    key.__enter__ = lambda self: key
    key.__exit__ = lambda *a: False
    winreg.OpenKey.return_value = key

    def _query(_k, name):
        if name == 'ProxyOverride' and miss_bypass:
            raise OSError('value not found')
        if name not in values:
            raise OSError('value not found')
        return values[name], None

    winreg.QueryValueEx.side_effect = _query
    return patch.dict(sys.modules, {'winreg': winreg})


def _run_all():
    names = sorted(n for n, fn in globals().items() if n.startswith('test_') and callable(fn))
    failed = []
    for name in names:
        try:
            globals()[name]()
        except Exception as exc:  # noqa: BLE001 —— 汇总 runner 需要捕获全部
            failed.append(name)
            print('FAIL %s: %s: %s' % (name, type(exc).__name__, exc))
        else:
            print('PASS %s' % name)
    print('---- %d passed, %d failed, %d total ----'
          % (len(names) - len(failed), len(failed), len(names)))
    if failed:
        print('FAILED: %s' % ', '.join(failed))
        return 1
    print('ALL PASS')
    return 0


if __name__ == '__main__':
    sys.exit(_run_all())
