# -*- coding: utf-8 -*-
"""后端 HTTP 服务端到端契约测试（黑盒）。

与 tests/smoke.py（进程内冒烟）互补：这里**不 mock 任何内部函数**，而是
真实拉起一个 uvicorn 服务（127.0.0.1 + 端口 0，由系统分配空闲端口），用
标准库 urllib 发真实 HTTP 请求，只断言**外部可见契约**（状态码、响应体、
Content-Type、请求头），不触碰 server 内部状态。

覆盖的端点（以 server.create_app() 的路由表为准）：
- GET  /health          健康检查（免 token）
- GET  /sites           站点状态（需 token）
- GET/POST /cache       spider 缓存协议 get/set/del（免 token，仅本机）
- GET/POST /proxy       spider localProxy 媒体代理（强制有效 token，do=ck 豁免）
- POST /action          内容 API + 面板指令（需 token）
- GET/POST /danmaku     弹幕中转（需 token）
- POST /runtime/cancel  控制面取消（需 token）
- POST /kazumi/action   Kazumi 规则引擎端点（需 token）
- 未注册路径            404

纪律：
- 禁止访问外网。所有被代理的目标都是本测试自己在 127.0.0.1 上起的夹具服务。
- 独立 YUKI_TEST_ROOT / YUKI_DATA_DIR / YUKI_CACHE_DIR（tempfile.mkdtemp），
  绝不碰真实用户数据目录 ~\\.yuki。
- Windows spawn 语义：hoststate 配置与站点加载必须放在 ``main()`` 里，
  否则 multiprocessing 复跑模块顶层会把 SupervisedRunner 子进程再拉一遍。

用法：<venv>/python python-backend/tests/test_http_api_blackbox.py
"""
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
if BASE not in sys.path:
    sys.path.insert(0, BASE)

TOKEN = 'blackbox-token'

# 模块级共享的服务上下文（由 start_backend() 填充，main() 结束时清理）
_CTX = {
    'port': 0,
    'root': '',
    'server': None,
    'fixture_port': 0,
    'fixture_server': None,
    'play_dir': '',
}


# --------------------------------------------------------------------------
# 夹具：本地 loopback 源服务 + 回环 spider（禁止外网）
# --------------------------------------------------------------------------
# 一个把「被代理目标」当普通参数消费的本地 spider：只按参数里的 u 去抓
# 127.0.0.1 上的夹具服务，绝不访问外网。用它把 /proxy 的 localProxy 通道
# 从「返回固定串」升级成「真实回环取流」的黑盒验证。
_FIXTURE_SPIDER_SRC = '''
class Spider:
    def init(self, extend=''):
        self.extend = extend

    def getName(self):
        return 'loopback-fixture'

    def localProxy(self, param):
        import urllib.request
        url = (param or {}).get('u') or ''
        if not url:
            return [400, 'text/plain; charset=utf-8', b'NO-U-PARAM']
        try:
            with urllib.request.urlopen(url, timeout=10) as rsp:
                data = rsp.read()
        except Exception as exc:
            return [502, 'text/plain; charset=utf-8', ('ERR:' + str(exc)).encode('utf-8')]
        return [200, 'text/plain; charset=utf-8', data]
'''

FIXTURE_SITE_KEY = 'bb_fixture'


def _start_fixture_server():
    """起一个 127.0.0.1 上的假上游源，供 /proxy 的 localProxy 回环使用。

    只监听 127.0.0.1、端口 0（系统分配），任何测试都不出网。
    """
    import http.server

    class _Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def do_GET(self):
            body = ('FIXTURE:' + self.path).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _install_fixture_spider():
    """把回环 spider 插件写进测试专属 plugins 目录并加载为站点。

    demo 必须先加载（sites.get(None) 取首个站点，demo 才是 /action 默认源）。
    """
    import hoststate
    import server

    plugins_dir = hoststate.get_plugins_dir()
    os.makedirs(plugins_dir, exist_ok=True)
    path = os.path.join(plugins_dir, 'bb_fixture_spider.py')
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(_FIXTURE_SPIDER_SRC)
    server.sites.load_local(FIXTURE_SITE_KEY, path)


# --------------------------------------------------------------------------
# 服务拉起 / 关闭
# --------------------------------------------------------------------------
def _host_setup():
    """宿主侧一次性初始化（只在 __main__ 进程跑，禁止模块顶层执行）。"""
    root = tempfile.mkdtemp(prefix='yuki-http-blackbox-')
    os.environ['YUKI_TEST_ROOT'] = root
    os.environ['YUKI_DATA_DIR'] = os.path.join(root, 'data')
    os.environ['YUKI_CACHE_DIR'] = os.path.join(root, 'cache')

    import hoststate

    hoststate.configure(port=0, token=TOKEN)
    hoststate.ensure_dirs()

    # RM-4：playerContent 持久缓存目录重定向，避免污染真实 ~/.yuki/cache
    play_dir = tempfile.mkdtemp(prefix='yuki-http-playcache-')
    import play_cache
    play_cache.set_dir_for_tests(play_dir)
    _CTX['root'] = root
    _CTX['play_dir'] = play_dir


def start_backend():
    """拉起后端 HTTP 服务（端口 0 自动分配），全部用例复用同一实例。

    守卫：本文件的所有隔离设施（YUKI_TEST_ROOT/YUKI_DATA_DIR/YUKI_CACHE_DIR、
    hoststate.configure(token=...)、play_cache.set_dir_for_tests）都只在
    ``main() -> _host_setup()`` 里执行。若有人直接对该目录跑 pytest（仓库无
    conftest/pytest.ini 拦截），本函数会在未配置状态下真实拉起 uvicorn，
    ``hoststate._HOME`` 回落到真实 ``~/.yuki``，插件写入与 load_default_sites
    会触碰真实用户数据目录——必须 fail-fast 而非污染真实目录。
    """
    if not os.environ.get('YUKI_TEST_ROOT'):
        raise RuntimeError(
            'test_http_api_blackbox 必须独立运行：python tests/test_http_api_blackbox.py，'
            '不得用 pytest 直接收集（YUKI_TEST_ROOT 未设置 → 隔离未建立，会污染真实 ~/.yuki）')
    if _CTX['server'] is not None:
        return _CTX['port']

    import uvicorn
    import server

    fixture_srv, fixture_port = _start_fixture_server()
    _CTX['fixture_server'] = fixture_srv
    _CTX['fixture_port'] = fixture_port

    server.load_default_sites()
    # 先 demo（sites.get(None) 取首个站点），再挂回环夹具 spider
    _install_fixture_spider()
    app = server.create_app()
    cfg = uvicorn.Config(app, host='127.0.0.1', port=0, log_level='error')
    srv = uvicorn.Server(cfg)
    threading.Thread(target=srv.run, daemon=True).start()
    for _ in range(300):
        if srv.started:
            break
        time.sleep(0.05)
    if not srv.started:
        raise RuntimeError('backend server failed to start')
    port = srv.servers[0].sockets[0].getsockname()[1]
    _CTX['server'] = srv
    _CTX['port'] = port
    return port


def stop_backend():
    """关闭服务并清理临时目录。"""
    srv = _CTX.get('server')
    if srv is not None:
        srv.should_exit = True
        time.sleep(0.4)
    fx = _CTX.get('fixture_server')
    if fx is not None:
        try:
            fx.shutdown()
        except Exception:
            pass
        try:
            fx.server_close()
        except Exception:
            pass
    for key in ('root', 'play_dir'):
        path = _CTX.get(key) or ''
        if path and os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)


def port():
    return start_backend()


def fixture_url(path='/fixture.mp4'):
    """夹具上游的 loopback 地址（绝不出网）。"""
    return 'http://127.0.0.1:%d%s' % (_CTX['fixture_port'], path)


def raw(method, path, *, token=TOKEN, headers=None, body=None, ctype=None):
    """裸 HTTP 请求：不跟随重定向，用于验证 302 Location 这类中间态。

    urllib 的默认 opener 会自动跟 302，把 do=ck 的 'ok' 当相对路径再请求
    一次 /ok（得到 401），无法观察到「健康探测本身」的契约。
    """
    lines = ['%s %s HTTP/1.1' % (method, path)]
    lines.append('Host: 127.0.0.1:%d' % port())
    lines.append('Connection: close')
    for key, value in (headers or {}).items():
        lines.append('%s: %s' % (key, value))
    if body is not None:
        payload = body if isinstance(body, bytes) else body.encode('utf-8')
        lines.append('Content-Length: %d' % len(payload))
        lines.append('Content-Type: %s' % (ctype or 'application/x-www-form-urlencoded'))
    else:
        payload = b''
    sock = socket.create_connection(('127.0.0.1', port()), timeout=60)
    try:
        sock.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('utf-8') + payload)
        buf = b''
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf += chunk
    finally:
        sock.close()
    text = buf.decode('utf-8', 'replace')
    head, _, payload_text = text.partition('\r\n\r\n')
    status = int(head.split(' ')[1]) if ' ' in head else 0
    headers_map = {}
    for line in head.split('\r\n')[1:]:
        key, sep, value = line.partition(':')
        if sep:
            headers_map[key.strip().lower()] = value.strip()
    return Resp(status, payload_text, headers_map)


# --------------------------------------------------------------------------
# HTTP 请求助手（标准库 urllib，不用第三方）
# --------------------------------------------------------------------------
class Resp:
    """精简响应视图：状态码 / 文本体 / 响应头。"""

    def __init__(self, status, text, headers):
        self.status = status
        self.text = text
        self.headers = {str(k).lower(): v for k, v in (headers or {}).items()}

    @property
    def json(self):
        return json.loads(self.text)

    def brief(self, limit=200):
        return 'status=%s body=%s' % (self.status, self.text[:limit].replace('\n', ' '))


def req(method, path, data=None, *, raw=None, ctype=None, token=TOKEN,
        headers=None, host='127.0.0.1', timeout=60):
    """发一个真实 HTTP 请求。

    token=None 表示不携带任何 token（验证鉴权面）；token=str 拼在 query 上。
    """
    url = 'http://%s:%d%s' % (host, port(), path)
    if token:
        url += ('&' if '?' in url else '?') + urllib.parse.urlencode({'token': token})
    body = None
    hdrs = dict(headers or {})
    if data is not None:
        body = urllib.parse.urlencode(data).encode('utf-8')
        hdrs.setdefault('Content-Type', 'application/x-www-form-urlencoded')
    if raw is not None:
        body = raw if isinstance(raw, bytes) else raw.encode('utf-8')
        hdrs.setdefault('Content-Type', ctype or 'application/x-www-form-urlencoded')
    request = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as rsp:
            return Resp(rsp.status, rsp.read().decode('utf-8', 'replace'), dict(rsp.headers))
    except urllib.error.HTTPError as exc:
        return Resp(exc.code, exc.read().decode('utf-8', 'replace'), dict(exc.headers))


def req_with_host(path, host_header, method='GET'):
    """用裸 socket 自定义 Host 头（验证 DNS rebinding 防御）。"""
    raw = ('%s %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n'
           % (method, path, host_header)).encode('utf-8')
    sock = socket.create_connection(('127.0.0.1', port()), timeout=30)
    try:
        sock.sendall(raw)
        buf = b''
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf += chunk
    finally:
        sock.close()
    head = buf.decode('utf-8', 'replace')
    status = int(head.split(' ')[1]) if ' ' in head else 0
    return Resp(status, head.split('\r\n\r\n', 1)[-1], {})


# --------------------------------------------------------------------------
# /health 契约
# --------------------------------------------------------------------------
def test_health_status_and_shape():
    """黑盒意图：/health 免 token 可达，返回 200 且字段齐全（status/站点列表/规则数）。"""
    r = req('GET', '/health', token=None)
    assert r.status == 200, r.brief()
    body = r.json
    assert body.get('status') == 'ok', r.brief()
    assert isinstance(body.get('sites'), list), r.brief()
    assert isinstance(body.get('kazumiRuleCount'), int), r.brief()


def test_health_content_type_json():
    """黑盒意图：/health 的 Content-Type 必须是 JSON，调用方按 JSON 解析。"""
    r = req('GET', '/health', token=None)
    assert 'application/json' in r.headers.get('content-type', ''), r.headers


def test_health_repeated_calls_consistent():
    """黑盒意图：连续多次 /health 结果一致（不因轮询自增益/自减，也不泄露状态漂移）。"""
    first = req('GET', '/health', token=None)
    second = req('GET', '/health', token=None)
    third = req('GET', '/health', token=None)
    assert first.status == second.status == third.status == 200
    assert first.json == second.json == third.json, (first.brief(), third.brief())


def test_health_ignores_token():
    """黑盒意图：/health 在免 token 表内，带不带正确 token 都一样可达（不被鉴权误伤）。"""
    anon = req('GET', '/health', token=None)
    with_token = req('GET', '/health', token=TOKEN)
    with_bad = req('GET', '/health', token='definitely-wrong')
    assert anon.status == with_token.status == with_bad.status == 200, (
        anon.status, with_token.status, with_bad.status)


def test_health_method_not_allowed():
    """黑盒意图：/health 只注册 GET，POST 必须 405 且不返回业务数据。"""
    r = req('POST', '/health', data={'x': '1'}, token=None)
    assert r.status == 405, r.brief()
    assert 'status' not in r.text or r.json.get('status') != 'ok', r.brief()


def test_health_rejects_foreign_host_header():
    """黑盒意图：DNS rebinding 防御——Host 头非本机时 /health 必须 403（不放行站点列表）。"""
    r = req_with_host('/health', 'evil.example.com:80')
    assert r.status == 403, r.brief(120)


def test_health_accepts_localhost_host_header():
    """黑盒意图：Host 为 localhost/127.0.0.1 属正常客户端，必须放行（白名单不能误伤）。"""
    r = req_with_host('/health', 'localhost:%d' % port())
    assert r.status == 200, r.brief(120)


def test_health_does_not_leak_rule_sources():
    """黑盒意图：/health 免 token 可读，不得携带 Kazumi 规则源全文（api/baseURL/searchURL）。"""
    r = req('GET', '/health', token=None)
    for leaked in ('baseURL', 'searchURL', '"api"'):
        assert leaked not in r.text, r.brief(300)


# --------------------------------------------------------------------------
# 鉴权面
# --------------------------------------------------------------------------
def test_auth_missing_token_rejected():
    """黑盒意图：/action 缺失 token 必须 401，且响应是结构化 JSON（不是 HTML/栈）。"""
    r = req('POST', '/action', data={'do': 'homeContent'}, token=None)
    assert r.status == 401, r.brief()
    assert r.json.get('code') == 401, r.brief()


def test_auth_wrong_token_rejected():
    """黑盒意图：错误 token 与缺失 token 行为一致（401 + 同一响应体），不给攻击者差分信息。"""
    missing = req('POST', '/action', data={'do': 'homeContent'}, token=None)
    wrong = req('POST', '/action', data={'do': 'homeContent'}, token='wrong-token-value')
    assert missing.status == wrong.status == 401, (missing.status, wrong.status)
    assert missing.text == wrong.text, (missing.brief(), wrong.brief())


def test_auth_valid_token_accepted():
    """黑盒意图：正确 token 的同一请求必须放行（200 + 业务数据），证明 401 确实来自鉴权。"""
    r = req('POST', '/action', data={'do': 'homeContent'}, token=TOKEN)
    assert r.status == 200, r.brief()
    assert r.json.get('ok') is True, r.brief()


def test_auth_header_token_equivalent_to_query():
    """黑盒意图：token 既可走 query 也可走 x-token 头，两种携带方式结果一致。"""
    by_query = req('POST', '/action', data={'do': 'homeContent'}, token=TOKEN)
    by_header = req('POST', '/action', data={'do': 'homeContent'}, token=None,
                    headers={'x-token': TOKEN})
    assert by_query.status == by_header.status == 200, (by_query.brief(), by_header.brief())


def test_auth_failure_leaks_no_stack():
    """黑盒意图：鉴权失败的响应体不得泄露内部栈/路径/异常（Traceback、.py、File "）。"""
    r = req('POST', '/action', data={'do': 'homeContent'}, token=None)
    for marker in ('Traceback', '.py', 'File "', 'uvicorn', 'Exception'):
        assert marker not in r.text, (marker, r.brief(300))


def test_auth_protected_endpoints_need_token():
    """黑盒意图：/sites 与 /danmaku 不在免 token 表内，匿名必须 401。"""
    for path, method in (('/sites', 'GET'), ('/danmaku', 'GET'), ('/kazumi/action', 'POST')):
        r = req(method, path, data={} if method == 'POST' else None, token=None)
        assert r.status == 401, (path, r.brief())


def test_auth_unknown_path_is_401_before_404():
    """黑盒意图：鉴权中间件先于路由，未知路径匿名访问先得 401（免 token 路径除外）。"""
    anon = req('GET', '/definitely-not-a-route', token=None)
    assert anon.status == 401, anon.brief()
    authed = req('GET', '/definitely-not-a-route', token=TOKEN)
    assert authed.status == 404, authed.brief()


# --------------------------------------------------------------------------
# /action 契约
# --------------------------------------------------------------------------
def test_action_home_content_shape():
    """黑盒意图：合法 action（homeContent）返回 200 + CatVod 扁平结构 + ok/requestId 装饰。"""
    r = req('POST', '/action', data={'do': 'homeContent'})
    assert r.status == 200, r.brief()
    body = r.json
    assert isinstance(body.get('class'), list) and len(body['class']) >= 1, r.brief()
    assert isinstance(body.get('list'), list), r.brief()
    assert body.get('ok') is True, r.brief()
    assert isinstance(body.get('requestId'), str) and body['requestId'], r.brief()


def test_action_response_content_type():
    """黑盒意图：/action 响应必须是 application/json; charset=utf-8（渲染层按 JSON 解析）。"""
    r = req('POST', '/action', data={'do': 'homeContent'})
    assert r.headers.get('content-type', '').startswith('application/json'), r.headers
    assert 'charset=utf-8' in r.headers.get('content-type', ''), r.headers


def test_action_request_id_header_echo():
    """黑盒意图：/action 响应带 X-Request-Id，且与包体里的 requestId 一致（排障可对齐）。"""
    r = req('POST', '/action', data={'do': 'homeContent'})
    header_id = r.headers.get('x-request-id')
    assert header_id, r.headers
    assert r.json.get('requestId') == header_id, r.brief(300)


def test_action_explicit_request_id_preserved():
    """黑盒意图：调用方自带 X-Request-Id 时后端照用不改写（端到端追踪不中断）。"""
    mine = 'client-supplied-rid-0001'
    r = req('POST', '/action', data={'do': 'homeContent'}, headers={'x-request-id': mine})
    assert r.json.get('requestId') == mine, r.brief(300)
    assert r.headers.get('x-request-id') == mine, r.headers


def test_action_unknown_do_fallback():
    """黑盒意图：未知 action 走结构化兜底 400 + L3_RUNTIME_INVALID_REQUEST，不是 500 也不是裸串。"""
    r = req('POST', '/action', data={'do': 'noSuchActionAtAll'})
    assert r.status == 400, r.brief()
    body = r.json
    assert body.get('ok') is False, r.brief()
    error = body.get('error') or {}
    assert error.get('code') == 'L3_RUNTIME_INVALID_REQUEST', r.brief(400)


def test_action_missing_do_parameter():
    """黑盒意图：完全不带 do 参数同样落到 400 结构化错误，不崩不 500。"""
    r = req('POST', '/action', data={})
    assert r.status == 400, r.brief()
    assert (r.json.get('error') or {}).get('code') == 'L3_RUNTIME_INVALID_REQUEST', r.brief(400)


def test_action_unknown_site():
    """黑盒意图：站点 key 不存在时是 404 + L2_SITE_NOT_FOUND，语义与「参数错」(400) 区分。"""
    r = req('POST', '/action', data={'do': 'homeContent', 'site': 'site-that-does-not-exist'})
    assert r.status == 404, r.brief()
    assert (r.json.get('error') or {}).get('code') == 'L2_SITE_NOT_FOUND', r.brief(400)


def test_action_malformed_json_body():
    """黑盒意图：非 form 编码 / 畸形 JSON body 不得让服务 500，返回结构化 4xx。"""
    r = req('POST', '/action', raw='{ this is not json', ctype='application/json')
    assert 400 <= r.status < 500, r.brief()
    assert r.status != 500, r.brief()
    assert r.json.get('ok') is False, r.brief(400)


def test_action_json_content_type_not_accepted_as_form():
    """黑盒意图：Content-Type: application/json 的 body 不会自动变成 form 参数（契约边界可预测）。"""
    r = req('POST', '/action', raw='{"do":"homeContent"}', ctype='application/json')
    assert r.status in (400, 404), r.brief()
    assert r.json.get('ok') is False, r.brief(400)


def test_action_oversized_parameter_rejected():
    """黑盒意图：超长参数（100KB 关键词）不得压垮服务：要么正常处理，要么结构化 4xx，绝不 500。"""
    r = req('POST', '/action', data={'do': 'searchContent', 'word': 'x' * 100000})
    assert r.status != 500, r.brief(120)
    if r.status == 200:
        assert isinstance(r.json.get('list'), list), r.brief(120)
    else:
        assert 400 <= r.status < 500, r.brief(120)


def test_action_get_not_allowed():
    """黑盒意图：/action 只注册 POST，GET 必须 405（方法白名单不被绕过）。"""
    r = req('GET', '/action', data={'do': 'homeContent'})
    assert r.status == 405, r.brief()


def test_action_panel_instruction_config_task():
    """黑盒意图：面板指令 configTask 是轮询快路径，返回 200 + 顶层 status/msg 旧契约。"""
    r = req('POST', '/action', data={'do': 'configTask'})
    assert r.status == 200, r.brief()
    body = r.json
    assert body.get('code') == 200, r.brief()
    assert 'status' in body and 'msg' in body, r.brief(300)


def test_action_error_body_has_no_internal_paths():
    """黑盒意图：/action 的错误响应不含源码路径/栈帧（脱敏契约外泄检查）。"""
    r = req('POST', '/action', data={'do': 'homeContent', 'site': 'nope',
                                     'extend': '../../etc/passwd'})
    assert r.status == 404, r.brief()
    for marker in ('Traceback', 'site_manager.py', 'File "'):
        assert marker not in r.text, (marker, r.brief(400))


# --------------------------------------------------------------------------
# /cache 契约
# --------------------------------------------------------------------------
def test_cache_set_get_roundtrip():
    """黑盒意图：/cache set → get 往返：明文字符串原样回读（spider KV 协议基石）。"""
    req('POST', '/cache?do=set&key=bb_round', data={'value': 'hello-cache'}, token=None)
    r = req('GET', '/cache?do=get&key=bb_round', token=None)
    assert r.status == 200, r.brief()
    assert r.text == 'hello-cache', r.brief()


def test_cache_get_miss_is_empty_text():
    """黑盒意图：未命中 key 返回 200 + 空串（不是 404/JSON null），spider 侧按空串判缺失。"""
    r = req('GET', '/cache?do=get&key=bb_never_written_' + str(time.time()), token=None)
    assert r.status == 200, r.brief()
    assert r.text == '', r.brief()


def test_cache_del_then_get_empty():
    """黑盒意图：del 之后再 get 必须空（删除语义生效，不是只清内存）。"""
    key = 'bb_del_key'
    req('POST', '/cache?do=set&key=%s' % key, data={'value': 'to-be-deleted'}, token=None)
    assert req('GET', '/cache?do=get&key=%s' % key, token=None).text == 'to-be-deleted'
    req('GET', '/cache?do=del&key=%s' % key, token=None)
    assert req('GET', '/cache?do=get&key=%s' % key, token=None).text == ''


def test_cache_del_idempotent():
    """黑盒意图：重复 del / del 不存在的 key 都保持 200 空体（幂等，不报错）。"""
    key = 'bb_del_twice'
    req('POST', '/cache?do=set&key=%s' % key, data={'value': 'v'}, token=None)
    r1 = req('GET', '/cache?do=del&key=%s' % key, token=None)
    r2 = req('GET', '/cache?do=del&key=%s' % key, token=None)
    r3 = req('GET', '/cache?do=del&key=bb_no_such_key_at_all', token=None)
    assert r1.status == r2.status == r3.status == 200, (r1.status, r2.status, r3.status)
    assert r1.text == r2.text == r3.text == '', (r1.brief(), r3.brief())


def test_cache_key_isolation():
    """黑盒意图：不同 key 互不串值（写 A 不影响 B），KV 命名空间隔离。"""
    req('POST', '/cache?do=set&key=bb_iso_a', data={'value': 'value-a'}, token=None)
    req('POST', '/cache?do=set&key=bb_iso_b', data={'value': 'value-b'}, token=None)
    assert req('GET', '/cache?do=get&key=bb_iso_a', token=None).text == 'value-a'
    assert req('GET', '/cache?do=get&key=bb_iso_b', token=None).text == 'value-b'


def test_cache_overwrite_same_key():
    """黑盒意图：同 key 覆盖写后读到新值（不是追加/拼接）。"""
    req('POST', '/cache?do=set&key=bb_over', data={'value': 'old'}, token=None)
    req('POST', '/cache?do=set&key=bb_over', data={'value': 'new'}, token=None)
    assert req('GET', '/cache?do=get&key=bb_over', token=None).text == 'new'


def test_cache_unicode_value_roundtrip():
    """黑盒意图：中文/emoji value 往返不乱码（UTF-8 端到端保真）。"""
    value = '中文值-🎉-ünïcödé'
    req('POST', '/cache?do=set&key=bb_uni', data={'value': value}, token=None)
    assert req('GET', '/cache?do=get&key=bb_uni', token=None).text == value


def test_cache_path_traversal_key_is_plain_data():
    """黑盒意图：含 ../ 与斜杠的 key 只当作普通字符串键，不能被解析成文件路径。"""
    key = urllib.parse.quote('../../windows/system32/drivers/etc/hosts')
    req('POST', '/cache?do=set&key=%s' % key, data={'value': 'traversal-payload'}, token=None)
    r = req('GET', '/cache?do=get&key=%s' % key, token=None)
    assert r.text == 'traversal-payload', r.brief()
    # 同键写读一致即说明没有被当路径落到别处；且未命中其它路径形式
    assert req('GET', '/cache?do=get&key=hosts', token=None).text == ''


def test_cache_oversized_value_rejected():
    """黑盒意图：超过 1MB 的 value 被拒绝（配额守卫），服务不崩、后续请求仍可用。"""
    big = 'x' * (1024 * 1024 + 16)
    r = req('POST', '/cache?do=set&key=bb_toobig', data={'value': big}, token=None)
    assert r.status >= 400, r.brief(160)
    assert req('GET', '/cache?do=get&key=bb_toobig', token=None).text == ''
    # 拒绝后服务仍健康
    assert req('GET', '/health', token=None).status == 200


def test_cache_large_value_within_quota():
    """黑盒意图：配额内的较大 value（~900KB）可正常往返，守卫不误杀。"""
    value = 'y' * (900 * 1024)
    req('POST', '/cache?do=set&key=bb_big_ok', data={'value': value}, token=None)
    assert req('GET', '/cache?do=get&key=bb_big_ok', token=None).text == value


def test_cache_content_type_is_plain_text():
    """黑盒意图：/cache 返回 text/plain（spider 侧按裸串消费，不带 JSON 包装）。"""
    req('POST', '/cache?do=set&key=bb_ct', data={'value': 'v'}, token=None)
    r = req('GET', '/cache?do=get&key=bb_ct', token=None)
    assert r.headers.get('content-type', '').startswith('text/plain'), r.headers


def test_cache_unknown_do_falls_back_to_get():
    """黑盒意图：未知 do 走 else 分支即 get 语义（200 + 空体），不报 400。"""
    r = req('GET', '/cache?do=nonsense&key=bb_ct', token=None)
    assert r.status == 200, r.brief()
    assert r.text in ('', 'v'), r.brief()


def test_cache_rejects_browser_origin():
    """黑盒意图：带跨站 Origin 的浏览器请求被 403（CSRF/DNS rebinding 防御）。"""
    r = req('GET', '/cache?do=get&key=bb_ct', token=None,
            headers={'Origin': 'http://evil.example.com'})
    assert r.status == 403, r.brief()


# --------------------------------------------------------------------------
# /proxy 契约
# --------------------------------------------------------------------------
def test_proxy_requires_token():
    """黑盒意图：/proxy 强制 token（防 SSRF 跳板），匿名请求 401 而非放行。"""
    r = req('GET', '/proxy?do=py&x=1', token=None)
    assert r.status == 401, r.brief()
    assert r.json.get('msg') == 'proxy token required', r.brief()


def test_proxy_wrong_token_rejected_with_distinct_message():
    """黑盒意图：错 token 与缺 token 同码但不同 msg（运维可区分「没带」与「带错」）。"""
    missing = req('GET', '/proxy?do=py&x=1', token=None)
    wrong = req('GET', '/proxy?do=py&x=1', token='totally-wrong')
    assert missing.status == wrong.status == 401, (missing.status, wrong.status)
    assert missing.json.get('msg') == 'proxy token required', missing.brief()
    assert wrong.json.get('msg') == 'invalid proxy token', wrong.brief()


def test_proxy_token_in_body_also_validated():
    """黑盒意图：把错误 token 从 query 挪进 POST body 不能绕过校验（全位置一致门禁）。"""
    r = req('POST', '/proxy?do=py', data={'token': 'wrong-in-body'}, token=None)
    assert r.status == 401, r.brief()
    assert r.json.get('msg') == 'invalid proxy token', r.brief()


def test_proxy_health_check_exempt_from_token():
    """黑盒意图：do=ck 健康探测豁免 token（蜘蛛扫描端口依赖），返回 302 + Location: ok。

    必须不跟随重定向观察：'ok' 是相对 Location，跟随会把探测本身掩盖成 /ok 的 401。
    """
    r = raw('GET', '/proxy?do=ck', token=None)
    assert r.status == 302, r.brief()
    assert r.headers.get('location') == 'ok', r.headers


def test_proxy_health_check_case_insensitive():
    """黑盒意图：do=CK（大写）同样按健康探测豁免，大小写不敏感。"""
    r = raw('GET', '/proxy?do=CK', token=None)
    assert r.status == 302, r.brief()


def test_proxy_health_check_rejects_wrong_token():
    """黑盒意图：豁免只针对「没带 token」，主动带错 token 的 do=ck 仍被拒。"""
    r = req('GET', '/proxy?do=ck', token='still-wrong')
    assert r.status == 401, r.brief()
    assert r.json.get('msg') == 'invalid proxy token', r.brief()


def test_proxy_local_proxy_loopback_fetch():
    """黑盒意图：localProxy 真实回环取流——经 /proxy 拿到 127.0.0.1 夹具服务的字节。

    目标地址全程是本机夹具（禁止外网），验证「代理通道确实转发了上游响应体」。
    """
    target = urllib.parse.quote(fixture_url('/upstream.txt'), safe='')
    r = req('GET', '/proxy?do=py&siteKey=%s&u=%s' % (FIXTURE_SITE_KEY, target), token=TOKEN)
    assert r.status == 200, r.brief()
    assert r.text == 'FIXTURE:/upstream.txt', r.brief()


def test_proxy_loopback_fetch_preserves_content_type():
    """黑盒意图：代理回环保留上游 Content-Type（媒体回放依赖它选择解码器）。"""
    target = urllib.parse.quote(fixture_url('/clip.mp4'), safe='')
    r = req('GET', '/proxy?do=py&siteKey=%s&u=%s' % (FIXTURE_SITE_KEY, target), token=TOKEN)
    assert r.status == 200, r.brief()
    assert r.headers.get('content-type', '').startswith('text/plain'), r.headers


def test_proxy_loopback_fetch_requires_token():
    """黑盒意图：即便目标是本机夹具，缺 token 的回环取流仍被 401 挡在门外。"""
    target = urllib.parse.quote(fixture_url('/upstream.txt'), safe='')
    r = req('GET', '/proxy?do=py&siteKey=%s&u=%s' % (FIXTURE_SITE_KEY, target), token=None)
    assert r.status == 401, r.brief()
    assert r.json.get('msg') == 'proxy token required', r.brief()


def test_proxy_loopback_fetch_unreachable_upstream():
    """黑盒意图：上游不可达时代理把失败映射成 502 响应体（不是 200 空体、不是 500）。"""
    dead = urllib.parse.quote('http://127.0.0.1:1/nope', safe='')
    r = req('GET', '/proxy?do=py&siteKey=%s&u=%s' % (FIXTURE_SITE_KEY, dead), token=TOKEN)
    assert r.status == 502, r.brief()
    assert 'ERR:' in r.text, r.brief()


def test_action_fetch_text_loopback_only():
    """黑盒意图：面板 fetchText 只用于本机夹具这类可信地址，成功回 200 且带上游诊断。"""
    r = req('POST', '/action', data={'do': 'fetchText', 'url': fixture_url('/a.txt')})
    assert r.status == 200, r.brief(200)
    body = r.json
    assert body.get('text') == 'FIXTURE:/a.txt', r.brief(200)
    assert (body.get('upstream') or {}).get('status') == 200, r.brief(300)


def test_proxy_local_proxy_returns_body():
    """黑盒意图：带有效 token 的 localProxy 通道返回 200 + spider 产出的字节。

    smoke.py 已验过的基准（无 siteKey 走「最近同类 spider」）；这里显式带
    siteKey=demo，避免断言依赖用例执行顺序（回环夹具站点也在列表里）。
    """
    r = req('GET', '/proxy?do=py&siteKey=demo&x=1', token=TOKEN)
    assert r.status == 200, r.brief()
    assert r.text == 'demo-proxy-ok', r.brief()


def test_proxy_header_token_accepted():
    """黑盒意图：token 走 X-Proxy-Token 专用头同样有效（非浏览器播放器地址形态）。"""
    r = req('GET', '/proxy?do=py&siteKey=demo', token=None, headers={'X-Proxy-Token': TOKEN})
    assert r.status == 200, r.brief()
    assert r.text == 'demo-proxy-ok', r.brief()


def test_proxy_wrong_header_token_rejected():
    """黑盒意图：专用头里的错误 token 同样被拒（头位置不得成为绕过面）。"""
    r = req('GET', '/proxy?do=py', token=None, headers={'X-Proxy-Token': 'bad'})
    assert r.status == 401, r.brief()


def test_proxy_request_id_header_present():
    """黑盒意图：/proxy 响应带 X-Request-Id（与 /action 同一排障契约）。"""
    r = req('GET', '/proxy?do=py', token=TOKEN)
    assert r.headers.get('x-request-id'), r.headers


def test_proxy_external_url_channel_needs_token():
    """黑盒意图：?url= 直链转发通道必须携带有效 token（否则是任意 http(s) 跳板）。"""
    target = urllib.parse.quote(fixture_url('/remote.bin'), safe='')
    anon = req('GET', '/proxy?url=%s' % target, token=None)
    assert anon.status == 401, anon.brief()
    authed = req('GET', '/proxy?url=%s' % target, token=TOKEN)
    assert authed.status == 200, authed.brief()


def test_proxy_rejects_browser_origin():
    """黑盒意图：带跨站 Origin 的 /proxy 请求被 403，媒体代理不被网页跨站借用。"""
    r = req('GET', '/proxy?do=py', token=TOKEN, headers={'Origin': 'http://evil.example.com'})
    assert r.status == 403, r.brief()


def test_proxy_sec_fetch_site_cross_site_rejected():
    """黑盒意图：Sec-Fetch-Site: cross-site 的 /proxy 请求被 403（浏览器来源防御）。"""
    r = req('GET', '/proxy?do=py', token=TOKEN, headers={'Sec-Fetch-Site': 'cross-site'})
    assert r.status == 403, r.brief()


# --------------------------------------------------------------------------
# 协议细节 / 健壮性
# --------------------------------------------------------------------------
def test_unknown_path_returns_404():
    """黑盒意图：未注册路径（带合法 token）返回 404 + JSON detail，不是 200 空页。"""
    r = req('GET', '/no/such/route', token=TOKEN)
    assert r.status == 404, r.brief()
    assert 'detail' in r.json, r.brief()


def test_path_traversal_not_served():
    """黑盒意图：/../health 这类路径遍历不得被解析成 /health（不带 token 时应当 401 而非 200）。"""
    r = req('GET', '/../health', token=None)
    assert r.status != 200, r.brief()
    assert r.status in (401, 403, 404), r.brief()


def test_encoded_path_traversal_not_served():
    """黑盒意图：%2e%2e 编码形式的遍历同样落 404/401，不得绕过前缀匹配。"""
    r = req('GET', '/%2e%2e/health', token=None)
    assert r.status != 200, r.brief()
    assert r.status in (401, 403, 404), r.brief()


def test_token_exempt_prefix_not_abused():
    """黑盒意图：/healthX、/cacheXXX 这类同前缀路径不享受免 token（精确匹配而非 startswith）。"""
    for path in ('/healthX', '/cacheXXX', '/proxyYYY'):
        r = req('GET', path, token=None)
        assert r.status == 401, (path, r.brief())
        authed = req('GET', path, token=TOKEN)
        assert authed.status == 404, (path, authed.brief())


def test_oversized_url_not_crash():
    """黑盒意图：超长 URL（3 万字符查询串）不崩服务，且之后 /health 仍 200。"""
    r = req('GET', '/cache?do=get&key=' + ('k' * 30000), token=None)
    assert r.status in (200, 400, 404, 414), r.brief(80)
    assert req('GET', '/health', token=None).status == 200


def test_concurrent_cache_reads_do_not_interleave():
    """黑盒意图：并发读同一 key 时每次都拿到完整且相同的值（响应不乱序/不串包）。"""
    from concurrent.futures import ThreadPoolExecutor

    key = 'bb_concurrent_read'
    req('POST', '/cache?do=set&key=%s' % key, data={'value': 'stable-value'}, token=None)

    def one(_i):
        return req('GET', '/cache?do=get&key=%s' % key, token=None).text

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(one, range(24)))
    assert set(results) == {'stable-value'}, set(results)


def test_concurrent_action_responses_not_crossed():
    """黑盒意图：并发 /action 各请求回自己的结果（按 word 一一对应），不互相串台。"""
    from concurrent.futures import ThreadPoolExecutor

    def one(i):
        r = req('POST', '/action', data={'do': 'searchContent', 'word': 'kw%d' % i})
        assert r.status == 200, (i, r.brief(160))
        return r.json['list'][0]['vod_name']

    with ThreadPoolExecutor(max_workers=8) as pool:
        names = list(pool.map(one, range(12)))
    assert names == ['kw%d (示例结果)' % i for i in range(12)], names


def test_sites_endpoint_shape():
    """黑盒意图：/sites 需 token 且返回 200 JSON（面板消费的站点状态面）。"""
    r = req('GET', '/sites', token=TOKEN)
    assert r.status == 200, r.brief(160)
    assert isinstance(r.json, (dict, list)), r.brief(160)


def test_danmaku_poll_returns_items_and_base():
    """黑盒意图：/danmaku?do=poll 返回 JSON 的 items + baseSec（弹幕中转协议面）。"""
    req('GET', '/danmaku?do=reset', token=TOKEN)
    r = req('GET', '/danmaku?do=poll', token=TOKEN)
    assert r.status == 200, r.brief()
    body = r.json
    assert isinstance(body.get('items'), list), r.brief()
    assert isinstance(body.get('baseSec'), (int, float)), r.brief()


def test_runtime_cancel_acknowledges_unknown_request():
    """黑盒意图：/runtime/cancel 对未知 requestId 也返回 200 + registered:false（控制面幂等）。"""
    r = req('POST', '/runtime/cancel', raw='{"requestId":"not-a-real-request"}',
            ctype='application/json', token=TOKEN)
    assert r.status == 200, r.brief()
    assert r.json.get('registered') is False, r.brief()
    assert r.json.get('ok') is True, r.brief()


def test_kazumi_action_lists_plugins():
    """黑盒意图：/kazumi/action 与 CatVod /action 物理隔离，kazumiList 返回 200 + list。"""
    r = req('POST', '/kazumi/action', data={'do': 'kazumiList'}, token=TOKEN)
    assert r.status == 200, r.brief(160)
    assert isinstance(r.json.get('list'), list), r.brief(160)


# --------------------------------------------------------------------------
# runner
# --------------------------------------------------------------------------
if __name__ == '__main__':
    import multiprocessing

    multiprocessing.freeze_support()
    _host_setup()
    passed, failed = [], []
    try:
        port()
        for name, fn in sorted(globals().items()):
            if not (name.startswith('test_') and callable(fn)):
                continue
            try:
                fn()
            except Exception as exc:
                failed.append((name, '%s: %s' % (type(exc).__name__, exc)))
                print('FAIL %s -> %s: %s' % (name, type(exc).__name__, exc))
            else:
                passed.append(name)
                print('PASS %s' % name)
    finally:
        stop_backend()
    print()
    print('RESULT: %d passed, %d failed' % (len(passed), len(failed)))
    for name, detail in failed:
        print('  FAILED %s: %s' % (name, detail))
    sys.exit(1 if failed else 0)
