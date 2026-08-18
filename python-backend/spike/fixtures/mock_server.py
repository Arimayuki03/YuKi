# -*- coding: utf-8 -*-
"""
离线 mock HTTP 服务，供 spike/fixtures 下 4 个 drpy 规则做五方法实测与多方案横向对比。

覆盖的路由契约（规则文件与这里一一对应）：

Rule 1  simple CMS（HTML/DOM）            GET /cms, /cms/category/{tid}?page=, /cms/detail/{id}, /cms/search?wd=
Rule 2  crypto 鉴权 API（签名+Token）     GET /api/crypto/nav|list|detail|search|play_sign   （严格校验 X-Signature）
                                         POST /api/crypto/auth_query
Rule 3  dynamic 模板 / eval / 二级解析    GET /dynamic/home|category|detail|search
Rule 4  stateful 登录态维持                POST /stateful/login   GET /stateful/home|category|detail|search

Rule 2 签名协议（与 rule2_crypto_auth.js 的 _getSignHeaders 完全一致）：
    raw = path + '?' + '&k=v'(按 key 字典序) + '&t=' + timestamp + '&nonce=' + nonce + '&key=' + APP_KEY
    sig = HMAC_SHA256(MD5(raw), APP_SECRET).hex
  strict_signature=True 时服务端重算并比对，不匹配返回 403。
Rule 2 播放直链走 AES 信封（OpenSSL "Salted__" 格式，CryptoJS.AES.decrypt 可直接解）：
    data = base64("Salted__" + salt + AES256CBC(EVP_BytesToKey(passphrase=AES_PASSPHRASE, AES-256, PKCS7, JSON 明文))
Rule 4 登录成功会下发 Set-Cookie 与 JSON {session_id, token}；其余 /stateful/* 请求必须携带
    Cookie: session_token=valid_token_xyz_888 或 X-Session-ID: sess_abc_123，否则 403。

辅助能力：
    MockHttpServer: 可编程启动/停止（port=0 自动分配），可用作 context manager。
    patch_host():   把规则源码里的默认 host 127.0.0.1:9999 替换为实际运行的 base_url。
    GET /__stats:   返回 {方法 路径: 命中次数}，用于断言（例如 rule4 登录只发生一次）。

仅依赖标准库；AES 信封依赖 pycryptodome（.venv 已装），缺失时自动降级为明文 JSON。
"""

import base64
import hashlib
import hmac
import json
import secrets
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

# ---------------------------------------------------------------- 常量（与规则文件保持一致）
APP_KEY = 'mock_app_key_2026'
APP_SECRET = 'mock_secret_xyz_987654321'
AES_PASSPHRASE = APP_SECRET  # play_sign 信封的口令（规则用同一个 secret 解）

try:  # pycryptodome（可选）
    from Crypto.Cipher import AES as _PyAES
    AES_AVAILABLE = True
except Exception:  # pragma: no cover
    _PyAES = None
    AES_AVAILABLE = False

_hits_lock = threading.Lock()


# ---------------------------------------------------------------- 加密辅助
def _evp_bytes_to_key(passphrase: bytes, salt: bytes, key_len: int = 32, iv_len: int = 16):
    """复刻 CryptoJS OpenSSLKdf（EVP_BytesToKey, MD5, 单次迭代）。"""
    data = b''
    prev = b''
    while len(data) < key_len + iv_len:
        prev = hashlib.md5(prev + passphrase + salt).digest()
        data += prev
    return data[:key_len], data[key_len:key_len + iv_len]


def aes_openssl_encrypt(passphrase: str, plaintext: bytes) -> str:
    """AES-256-CBC + PKCS7，OpenSSL Salted 信封，返回 base64 串（CryptoJS.AES.decrypt 可直接解）。"""
    if not AES_AVAILABLE:
        raise RuntimeError('pycryptodome not available')
    salt = secrets.token_bytes(8)
    key, iv = _evp_bytes_to_key(passphrase.encode('utf-8'), salt)
    pad_len = 16 - (len(plaintext) % 16)
    padded = plaintext + bytes([pad_len]) * pad_len
    ct = _PyAES.new(key, _PyAES.MODE_CBC, iv).encrypt(padded)
    return base64.b64encode(b'Salted__' + salt + ct).decode('ascii')


def verify_signature(path: str, query, headers, app_key: str = APP_KEY, app_secret: str = APP_SECRET):
    """严格校验 rule2 生成的签名。query 为 parse_qs 结果（list 值）。

    返回 (ok: bool, reason: str)。
    """
    timestamp = headers.get('X-Timestamp', '')
    nonce = headers.get('X-Nonce', '')
    signature = headers.get('X-Signature', '')
    if not timestamp or not nonce or not signature:
        return False, 'missing X-Signature/X-Timestamp/X-Nonce headers'
    params = {k: v[-1] for k, v in query.items()}
    param_str = ''.join('&' + k + '=' + params[k] for k in sorted(params))
    raw = f'{path}?{param_str}&t={timestamp}&nonce={nonce}&key={app_key}'
    md5_hex = hashlib.md5(raw.encode('utf-8')).hexdigest()
    expected = hmac.new(app_secret.encode('utf-8'), md5_hex.encode('utf-8'),
                        hashlib.sha256).hexdigest()
    if expected != signature:
        return False, f'signature mismatch (raw={raw!r})'
    return True, 'ok'


# ---------------------------------------------------------------- 路由
class MockRequestHandler(BaseHTTPRequestHandler):
    # 可被 MockHttpServer 覆写的类级配置
    strict_signature = True
    encrypt_play_sign = True

    # ---------------- 基础设施 ----------------
    def _count_hit(self):
        server = self.server
        hits = getattr(server, 'hits', None)
        if hits is None:
            with _hits_lock:
                hits = getattr(server, 'hits', None)
                if hits is None:
                    hits = server.hits = {}
        key = f'{self.command} {self.path}'
        with _hits_lock:
            hits[key] = hits.get(key, 0) + 1

    def _send_response(self, status_code, content_type, body):
        body = str(body)
        self.send_response(status_code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body.encode('utf-8'))))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()
        self.wfile.write(body.encode('utf-8'))

    def _json(self, status_code, obj):
        self._send_response(status_code, 'application/json; charset=utf-8',
                            json.dumps(obj, ensure_ascii=False))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    # ---------------- GET ----------------
    def do_GET(self):
        self._count_hit()
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == '/__stats':
            return self._json(200, getattr(self.server, 'hits', {}))

        # ===== Rule 1: Simple CMS (HTML/DOM) =====
        if path == '/cms' or path == '/cms/':
            html = """<!DOCTYPE html>
<html>
<head><title>Mock Simple CMS</title></head>
<body>
    <div class="nav-menu">
        <a class="nav-item" href="/cms/category/movie">电影</a>
        <a class="nav-item" href="/cms/category/tv">电视剧</a>
        <a class="nav-item" href="/cms/category/anime">动漫</a>
    </div>
    <div class="module-items">
        <div class="module-item">
            <a class="module-item-title" href="/cms/detail/1001" title="肖申克的救赎">
                <img class="lazyload" src="/static/img1.jpg" alt="肖申克的救赎"/>
                <div class="module-item-text">HD国语</div>
            </a>
        </div>
        <div class="module-item">
            <a class="module-item-title" href="/cms/detail/1002" title="霸王别姬">
                <img class="lazyload" src="/static/img2.jpg" alt="霸王别姬"/>
                <div class="module-item-text">HD中字</div>
            </a>
        </div>
    </div>
</body>
</html>"""
            return self._send_response(200, 'text/html; charset=utf-8', html)

        if path.startswith('/cms/category/'):
            tid = path.split('/cms/category/')[1]
            pg = query.get('page', ['1'])[0]
            html = f"""<!DOCTYPE html>
<html>
<head><title>Category - {tid} - Page {pg}</title></head>
<body>
    <div class="module-items">
        <div class="module-item">
            <a class="module-item-title" href="/cms/detail/{tid}_item_1" title="{tid.upper()} 精彩节目 1">
                <img class="lazyload" src="/static/{tid}_1.jpg" alt="{tid.upper()} 精彩节目 1"/>
                <div class="module-item-text">第{pg}页更新</div>
            </a>
        </div>
        <div class="module-item">
            <a class="module-item-title" href="/cms/detail/{tid}_item_2" title="{tid.upper()} 精彩节目 2">
                <img class="lazyload" src="/static/{tid}_2.jpg" alt="{tid.upper()} 精彩节目 2"/>
                <div class="module-item-text">第{pg}页更新</div>
            </a>
        </div>
    </div>
    <div class="page-info" data-page="{pg}" data-total="10"></div>
</body>
</html>"""
            return self._send_response(200, 'text/html; charset=utf-8', html)

        if path.startswith('/cms/detail/'):
            vid = path.split('/cms/detail/')[1]
            html = f"""<!DOCTYPE html>
<html>
<head><title>Detail - {vid}</title></head>
<body>
    <div class="video-info">
        <h1 class="video-title">示例影片_{vid}</h1>
        <img class="video-cover" src="/static/{vid}.jpg" />
        <div class="video-tags">剧情 / 动作</div>
        <div class="video-year">2024</div>
        <div class="video-area">中国大陆</div>
        <div class="video-actor">演员A / 演员B</div>
        <div class="video-director">导演X</div>
        <div class="video-desc">这是一部关于{vid}的精彩测试电影简介内容。</div>
    </div>
    <div class="playlist-box">
        <div class="playlist-tab">
            <span class="tab-item">默认专线</span>
            <span class="tab-item">备用专线</span>
        </div>
        <div class="playlist-content">
            <ul class="episode-list line-1">
                <li><a href="/cms/play/{vid}_ep1.m3u8">第01集</a></li>
                <li><a href="/cms/play/{vid}_ep2.m3u8">第02集</a></li>
            </ul>
            <ul class="episode-list line-2">
                <li><a href="/cms/play/{vid}_backup_ep1.m3u8">备用01</a></li>
                <li><a href="/cms/play/{vid}_backup_ep2.m3u8">备用02</a></li>
            </ul>
        </div>
    </div>
</body>
</html>"""
            return self._send_response(200, 'text/html; charset=utf-8', html)

        if path == '/cms/search':
            wd = query.get('wd', [''])[0]
            pg = query.get('page', ['1'])[0]
            html = f"""<!DOCTYPE html>
<html>
<head><title>Search - {wd}</title></head>
<body>
    <div class="search-result-list">
        <div class="module-item">
            <a class="module-item-title" href="/cms/detail/search_{wd}_1" title="搜到_{wd}_结果1">
                <img class="lazyload" src="/static/search1.jpg" alt="搜到_{wd}_结果1"/>
                <div class="module-item-text">搜索匹配</div>
            </a>
        </div>
    </div>
</body>
</html>"""
            return self._send_response(200, 'text/html; charset=utf-8', html)

        # ===== Rule 2: Crypto Auth API（严格签名校验） =====
        if path.startswith('/api/crypto/'):
            if self.strict_signature:
                if not self.headers.get('X-Auth-Token'):
                    return self._json(401, {'code': 401, 'msg': 'Missing X-Auth-Token header'})
                ok, reason = verify_signature(path, query, self.headers)
                if not ok:
                    return self._json(403, {'code': 403, 'msg': 'signature rejected: ' + reason})
            else:
                if not (self.headers.get('X-Signature') and self.headers.get('X-Timestamp')):
                    return self._json(401, {'code': 401,
                                            'msg': 'Missing X-Signature or X-Timestamp headers'})

            sub = path.replace('/api/crypto', '')
            if sub == '/nav':
                return self._json(200, {
                    'code': 0,
                    'classes': [
                        {'type_id': '1', 'type_name': '加密电影'},
                        {'type_id': '2', 'type_name': '加密剧集'},
                    ],
                    'recommend': [
                        {'vod_id': 'crypto_101', 'vod_name': '安全第一课',
                         'vod_pic': 'https://img.test/c101.jpg', 'vod_remarks': '4K超清'},
                    ],
                })
            if sub == '/list':
                tid = query.get('tid', ['1'])[0]
                pg = query.get('pg', ['1'])[0]
                return self._json(200, {
                    'code': 0, 'page': int(pg), 'pagecount': 5, 'total': 50,
                    'list': [
                        {'vod_id': f'crypto_{tid}_{pg}_1', 'vod_name': f'加密分类{tid}-作品{pg}-1',
                         'vod_pic': f'https://img.test/{tid}_{pg}_1.jpg', 'vod_remarks': f'第{pg}页'},
                        {'vod_id': f'crypto_{tid}_{pg}_2', 'vod_name': f'加密分类{tid}-作品{pg}-2',
                         'vod_pic': f'https://img.test/{tid}_{pg}_2.jpg', 'vod_remarks': f'第{pg}页'},
                    ],
                })
            if sub == '/detail':
                vid = query.get('id', [''])[0]
                return self._json(200, {
                    'code': 0,
                    'data': {
                        'vod_id': vid, 'vod_name': f'加密详情_{vid}',
                        'vod_pic': f'https://img.test/{vid}.jpg', 'vod_type': '科幻',
                        'vod_year': '2025', 'vod_area': '中国', 'vod_remarks': '完结',
                        'vod_actor': '加密演员', 'vod_director': '加密导演',
                        'vod_content': '这是一部经过端到端加密鉴权测试的影片。',
                        'vod_play_from': '加密超清$$$加密备用',
                        'vod_play_url': '第1集$crypto_play_ep1#第2集$crypto_play_ep2$$$备用1$crypto_bk_1',
                    },
                })
            if sub == '/search':
                wd = query.get('wd', [''])[0]
                return self._json(200, {
                    'code': 0,
                    'list': [
                        {'vod_id': f'crypto_search_{wd}', 'vod_name': f'加密搜索_{wd}',
                         'vod_pic': 'https://img.test/search.jpg', 'vod_remarks': '搜索匹配'},
                    ],
                })
            if sub == '/play_sign':
                play_id = query.get('play_id', [''])[0]
                token = hashlib.md5(f'{play_id}_salt_2026'.encode('utf-8')).hexdigest()
                url = f'https://stream.mock.test/live/{play_id}.m3u8?token={token}'
                if self.encrypt_play_sign and AES_AVAILABLE:
                    envelope = json.dumps({'play_id': play_id, 'url': url, 'parse': 0},
                                          ensure_ascii=False)
                    return self._json(200, {'code': 0,
                                            'data': aes_openssl_encrypt(AES_PASSPHRASE,
                                                                        envelope.encode('utf-8'))})
                return self._json(200, {'code': 0, 'url': url, 'parse': 0})
            return self._json(404, {'code': 404, 'msg': f'unknown crypto route: {sub}'})

        # ===== Rule 3: Dynamic Code / Regex / Eval / 二级解析 =====
        if path.startswith('/dynamic/'):
            sub = path.replace('/dynamic', '')
            if sub == '/home':
                html = """<!DOCTYPE html>
<html>
<head><title>Dynamic Page</title></head>
<body>
    <script>
        var pageConfig = {
            cate: [{"id":"d1","name":"动态电影"},{"id":"d2","name":"动态剧集"}],
            recom: [{"id":"dyn_100","name":"盗梦空间(动态)","pic":"/img/dyn100.png","note":"1080P"}]
        };
    </script>
    <div id="app">Dynamic Template Page</div>
</body>
</html>"""
                return self._send_response(200, 'text/html; charset=utf-8', html)

            if sub == '/category':
                tid = query.get('tid', ['d1'])[0]
                pg = query.get('pg', ['1'])[0]
                payload = f"""
                var __DATA__ = {{
                    "code": 200,
                    "items": [
                        {{"vid": "{tid}_{pg}_a", "title": "动态节目_{tid}_{pg}_A", "thumb": "/img/{tid}_a.jpg", "desc": "更新至{pg}"}},
                        {{"vid": "{tid}_{pg}_b", "title": "动态节目_{tid}_{pg}_B", "thumb": "/img/{tid}_b.jpg", "desc": "更新至{pg}"}}
                    ],
                    "page": {pg},
                    "totalPage": 10
                }};
                """
                return self._send_response(200, 'application/javascript; charset=utf-8', payload)

            if sub == '/detail':
                vid = query.get('id', ['dyn_100'])[0]
                raw_info = {
                    'id': vid,
                    'name': f'动态解析影片_{vid}',
                    'cover': f'/img/{vid}.jpg',
                    'actor': '诺兰团队',
                    'summary': '动态 eval 与正则提取解析测试',
                    'urls': [
                        {'name': '动态01', 'raw': f'eval_stream://{vid}/part1'},
                        {'name': '动态02', 'raw': f'eval_stream://{vid}/part2'},
                    ],
                }
                encoded = base64.b64encode(json.dumps(raw_info, ensure_ascii=True).encode('utf-8')).decode('ascii')
                html = f"""<!DOCTYPE html>
<html>
<body>
    <div id="encrypted-video-payload" data-payload="{encoded}"></div>
    <script>
        var __SIGN_SEED__ = 1337;
        function resolvePlayUrl(raw) {{
            return "https://cdn.eval.test/" + raw.replace("eval_stream://", "") + ".m3u8?seed=" + __SIGN_SEED__;
        }}
    </script>
</body>
</html>"""
                return self._send_response(200, 'text/html; charset=utf-8', html)

            if sub == '/search':
                wd = query.get('wd', [''])[0]
                html = f"""
                <html>
                <body>
                    <script>
                        window.__SEARCH_RESULTS__ = [
                            {{"id": "dyn_s_{wd}", "name": "动态搜_{wd}", "pic": "/img/s.jpg", "note": "搜索匹配"}}
                        ];
                    </script>
                </body>
                </html>
                """
                return self._send_response(200, 'text/html; charset=utf-8', html)

        # ===== Rule 4: Stateful Local & Session（登录态维持） =====
        if path.startswith('/stateful/'):
            sub = path.replace('/stateful', '')
            cookie = self.headers.get('Cookie', '')
            auth_session = self.headers.get('X-Session-ID', '')
            has_valid_session = ('session_token=valid_token_xyz_888' in cookie) or (auth_session == 'sess_abc_123')

            if not has_valid_session:
                return self._json(403, {'code': 403, 'msg': 'Session expired or not logged in'})

            if sub == '/home':
                return self._json(200, {
                    'code': 0,
                    'class': [
                        {'type_id': 's1', 'type_name': '会员专区'},
                        {'type_id': 's2', 'type_name': '独播剧场'},
                    ],
                    'list': [
                        {'vod_id': 'state_100', 'vod_name': '状态维持推荐大片',
                         'vod_pic': 'https://state.test/pic100.jpg', 'vod_remarks': 'VIP专享'},
                    ],
                })
            if sub == '/category':
                tid = query.get('tid', ['s1'])[0]
                pg = query.get('pg', ['1'])[0]
                return self._json(200, {
                    'code': 0, 'page': int(pg), 'pagecount': 10,
                    'list': [
                        {'vod_id': f'state_{tid}_{pg}', 'vod_name': f'会员内容-{tid}-P{pg}',
                         'vod_pic': f'https://state.test/{tid}_{pg}.jpg', 'vod_remarks': f'更新至{pg}'},
                    ],
                })
            if sub == '/detail':
                vid = query.get('id', ['state_100'])[0]
                return self._json(200, {
                    'code': 0,
                    'data': {
                        'vod_id': vid, 'vod_name': f'VIP大片_{vid}',
                        'vod_pic': f'https://state.test/{vid}.jpg',
                        'vod_play_from': 'VIP专线',
                        'vod_play_url': f'高清$https://vip.test/play/{vid}.m3u8?session=valid_token_xyz_888',
                    },
                })
            if sub == '/search':
                wd = query.get('wd', [''])[0]
                return self._json(200, {
                    'code': 0,
                    'list': [
                        {'vod_id': f'state_search_{wd}', 'vod_name': f'VIP搜_{wd}',
                         'vod_pic': 'https://state.test/search.jpg', 'vod_remarks': '搜索匹配'},
                    ],
                })
            return self._json(404, {'code': 404, 'msg': f'unknown stateful route: {sub}'})

        return self._send_response(404, 'text/plain', f'Mock route not found: {path}')

    # ---------------- POST ----------------
    def do_POST(self):
        self._count_hit()
        content_length = int(self.headers.get('Content-Length', 0) or 0)
        post_data = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else ''
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == '/stateful/login':
            # 读取请求体（规则会提交 JSON 账号），校验通过后下发 session + Set-Cookie
            try:
                body_obj = json.loads(post_data) if post_data else {}
            except ValueError:
                body_obj = {}
            if not (body_obj.get('user') and body_obj.get('pass')):
                return self._json(400, {'code': 400, 'msg': 'user/pass required'})
            body = json.dumps({'code': 0, 'msg': 'login success',
                               'session_id': 'sess_abc_123', 'token': 'valid_token_xyz_888'},
                              ensure_ascii=False)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Set-Cookie', 'session_token=valid_token_xyz_888; Path=/; Max-Age=3600')
            self.send_header('Content-Length', str(len(body.encode('utf-8'))))
            self.end_headers()
            self.wfile.write(body.encode('utf-8'))
            return

        if path == '/api/crypto/auth_query':
            if self.strict_signature:
                if not self.headers.get('X-Auth-Token'):
                    return self._json(401, {'code': 401, 'msg': 'Missing X-Auth-Token header'})
                ok, reason = verify_signature(path, query, self.headers)
                if not ok:
                    return self._json(403, {'code': 403, 'msg': 'signature rejected: ' + reason})
            elif not self.headers.get('X-Signature'):
                return self._json(401, {'code': 401, 'msg': 'No signature'})
            return self._json(200, {'code': 0, 'received': post_data, 'status': 'verified'})

        return self._send_response(404, 'text/plain', f'Mock POST route not found: {path}')

    def log_message(self, format, *args):  # 保持测试输出整洁
        pass


# ---------------------------------------------------------------- 可编程服务
class MockHttpServer:
    """可编程启动/关闭的离线 Mock HTTP Server（context manager 可用）。"""

    def __init__(self, host='127.0.0.1', port=0, strict_signature=True, encrypt_play_sign=True):
        self.host = host
        self.port = port
        self.strict_signature = strict_signature
        self.encrypt_play_sign = encrypt_play_sign
        self.server = None
        self.thread = None

    def start(self):
        handler = type('ConfiguredHandler', (MockRequestHandler,), {
            'strict_signature': self.strict_signature,
            'encrypt_play_sign': self.encrypt_play_sign,
        })
        self.server = HTTPServer((self.host, self.port), handler)
        self.port = self.server.server_port  # port=0 时取实际端口
        self.server.hits = {}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f'http://{self.host}:{self.port}'

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.server = None
        if self.thread:
            self.thread.join(timeout=1.0)
            self.thread = None

    def get_url(self, path=''):
        if not path.startswith('/'):
            path = '/' + path
        return f'http://{self.host}:{self.port}{path}'

    def hits(self):
        return dict(getattr(self.server, 'hits', {}))

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()


# ---------------------------------------------------------------- 规则 host 改写辅助
def patch_host(js_source: str, base_url: str) -> str:
    """把规则源码中的默认 host（http://127.0.0.1:9999）替换为实际运行的 base_url。

    典型用法（MockHttpServer 以动态端口启动后）::

        from mock_server import MockHttpServer, patch_host
        with MockHttpServer() as srv:
            js = patch_host(open('rule1_simple_cms.js', encoding='utf-8').read(),
                            srv.get_url())
            # js 传入 JS 引擎执行
    """
    base = base_url.rstrip('/')
    return (js_source.replace('http://127.0.0.1:9999', base)
                     .replace('https://127.0.0.1:9999', base))


if __name__ == '__main__':
    PORT = 9999
    handler = type('StandaloneHandler', (MockRequestHandler,), {})
    server = HTTPServer(('127.0.0.1', PORT), handler)
    server.hits = {}
    print(f'Mock server running at http://127.0.0.1:{PORT} (strict_signature='
          f'{MockRequestHandler.strict_signature}, aes={AES_AVAILABLE})')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down server.')
        server.server_close()
