# -*- coding: utf-8 -*-
"""C2.1–C2.5 离线夹具服务：把 `tests/fixtures/config/` 通过 loopback HTTP 暴露。

为什么需要真的起 HTTP 服务而不是 monkeypatch `fetch_text`：本轮要验的正是
下载层本身——最终 URL、跳转链、ETag/304、Content-Length 上限、gzip 解压上限、
图片伪装解码、以及「相对 api/jar/ext 按最终配置 URL 解析」。把这些 patch 掉就等于
不测。全部监听 `127.0.0.1:0`，不出网。

顺带一条边界语义：loopback 根地址是用户显式选择的信任根，因此同源子资源可读；
测试里用 `http://127.0.0.1:port/...` 当根，用 `http://localhost:port/...` 当**跨源**
（host 不同 → origin 不同），正好用来验证同源继承不会被放宽成「只要是本机就行」。
"""
import base64
import gzip
import http.server
import io
import json
import os
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_DIR = os.path.join(HERE, 'fixtures', 'config')

# 二进制形态由 `single.json` 确定性派生（见 fixtures/config/make_binary.py 的说明）：
# 内容一定与文本夹具一致，所以「解出来的配置」可以直接和文本形态对比，任何解码错误
# 都表现为两者不等，而不是夹具自己写错。这里在起服务前自动生成，避免整个 C2 套件
# 依赖一条「先手动跑一次脚本」的前置步骤。
#
# 最小合法 JPEG（SOI + APP0/JFIF + EOI）与最小合法 PNG（签名 + IHDR + IEND）。
# 宿主只按魔数识别伪装、不解码像素，因此这两段头部足够真实。
JPEG_HEAD = bytes.fromhex(
    'ffd8ffe000104a46494600010100000100010000') + b'\xff\xd9'
PNG_HEAD = bytes.fromhex(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    '0000000049454e44ae426082')


def ensure_binary_fixtures():
    """从 `single.json` 派生 gzip / JPEG 伪装 / PNG 伪装三种载体，返回文件名列表。

    幂等：字节完全由 `single.json` 决定（gzip 固定 `mtime=0`，否则默认写入当前
    时间，夹具每次都会变），所以重复调用不会产生差异，也不会污染 git 工作区。
    """
    with open(os.path.join(CONFIG_DIR, 'single.json'), 'rb') as handle:
        raw = handle.read()
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode='wb', mtime=0) as gz:
        gz.write(raw)
    tail = base64.b64encode(raw)
    derived = {
        'single.json.gz': buffer.getvalue(),
        'disguise.jpg': JPEG_HEAD + tail,
        'disguise.png': PNG_HEAD + tail,
    }
    for name, payload in derived.items():
        path = os.path.join(CONFIG_DIR, name)
        try:
            with open(path, 'rb') as handle:
                if handle.read() == payload:
                    continue
        except OSError:
            pass
        with open(path, 'wb') as handle:
            handle.write(payload)
    return sorted(derived)


def read_fixture(name, *, binary=False):
    path = os.path.join(CONFIG_DIR, *str(name).split('/'))
    with open(path, 'rb') as handle:
        raw = handle.read()
    return raw if binary else raw.decode('utf-8')


class _Handler(http.server.BaseHTTPRequestHandler):
    """只读夹具 + 一组显式的边界路由。

    每条特殊路由都对应一个验收点，命名保持自解释；不做通配猜测，请求到未注册的
    路径一律 404，避免测试因为拼错路径而「意外通过」。
    """

    protocol_version = 'HTTP/1.1'
    server_version = 'vpc-fixture/1.0'

    def log_message(self, *_args):        # 保持测试输出干净
        return

    # ---------------------------------------------------------------- 工具

    def _send(self, status, body, *, ctype='application/json; charset=utf-8',
              headers=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body and self.command != 'HEAD':
            self.wfile.write(body)

    def _fixture(self, name, *, ctype='application/json; charset=utf-8', headers=None):
        try:
            raw = read_fixture(name, binary=True)
        except OSError:
            self._send(404, '{"error":"missing fixture"}')
            return
        self._send(200, raw, ctype=ctype, headers=headers)

    # ---------------------------------------------------------------- 路由

    def do_GET(self):                                     # noqa: N802
        parts = urllib.parse.urlsplit(self.path)
        route = parts.path
        query = urllib.parse.parse_qs(parts.query)
        counters = self.server.counters
        counters[route] = counters.get(route, 0) + 1

        # 明文 JSON 夹具（含子目录 lib/、js/）。
        if route.startswith('/config/'):
            name = route[len('/config/'):]
            if name.endswith('.gz'):
                # 故意**不**发 `Content-Encoding: gzip`：那样 requests/urllib3 会在
                # `iter_content` 里替我们解好，`decompress_capped` 根本见不到 gzip
                # 流，这条夹具就测不到宿主自己的解压上限了。TVBox 生态里 `tv.json.gz`
                # 直链正是这种「正文本身就是 gzip」的形态（octet-stream）。
                # 传输层压缩（CDN 发 Content-Encoding）另有 /config-encoded/ 路由。
                self._fixture(name, ctype='application/octet-stream')
            elif name.endswith('.jpg'):
                self._fixture(name, ctype='image/jpeg')
            elif name.endswith('.png'):
                self._fixture(name, ctype='image/png')
            elif name.endswith('.txt'):
                self._fixture(name, ctype='text/plain; charset=utf-8')
            else:
                self._fixture(name)
            return

        # 传输层压缩：正文是 gzip 且**声明** Content-Encoding。这一支由 requests
        # 透明解掉，宿主看到的是明文——因此 `disguise` 为空、体积上限落在
        # `read_capped`（对解码后的字节计量）。两条路由合起来才覆盖「gzip 配置」。
        if route.startswith('/config-encoded/'):
            name = route[len('/config-encoded/'):]
            try:
                raw = read_fixture(name, binary=True)
            except OSError:
                self._send(404, '{"error":"missing fixture"}')
                return
            self._send(200, gzip.compress(raw), ctype='application/json',
                       headers={'Content-Encoding': 'gzip'})
            return

        # ETag 条件请求：第二次带 If-None-Match 时回 304（ext 缓存验收）。
        if route == '/etag/ext.json':
            body = read_fixture('ext_payload.json', binary=True)
            tag = '"fixture-etag"'
            if self.headers.get('If-None-Match') == tag:
                self.send_response(304)
                self.send_header('ETag', tag)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            self._send(200, body, headers={'ETag': tag})
            return

        # 跳转：/hop/<n> 逐级跳，用于验证跳转上限（每跳都要重新过守卫）。
        if route.startswith('/hop/'):
            try:
                left = int(route[len('/hop/'):])
            except ValueError:
                self._send(404, '{"error":"bad hop"}')
                return
            if left <= 0:
                self._fixture('single.json')
                return
            self.send_response(302)
            self.send_header('Location', '/hop/%d' % (left - 1))
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        # 跳转到内网/回环的**跨源**地址：跳转不能成为绕过私网守卫的通道。
        if route == '/redirect-to-private':
            self.send_response(302)
            self.send_header('Location', 'http://10.0.0.1/secret.json')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        # 压缩炸弹：正文是 gzip，解压后远超上限。同样不声明 Content-Encoding——
        # 声明了就由 urllib3 解压，挡它的是 read_capped 的响应上限而不是解压上限，
        # 「小包大解压」这条防线就没被测到。
        if route == '/bomb.json.gz':
            payload = gzip.compress(b'{"sites":[]}' + b' ' * (4 * 1024 * 1024))
            self._send(200, payload, ctype='application/octet-stream')
            return

        # 声明超长 Content-Length：必须在读正文前就被拒。
        if route == '/huge.json':
            body = b'{"sites":[]}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(64 * 1024 * 1024))
            self.end_headers()
            self.wfile.write(body)
            return

        # 慢响应：用于超时与取消。ms 由调用方给，服务端不自行设上限。
        if route == '/slow.json':
            time.sleep(float((query.get('ms') or ['800'])[0]) / 1000.0)
            self._fixture('single.json')
            return

        # ext 展开的四种形态：远端 JSON / 纯文本 / 空响应 / 自指递归。
        if route == '/ext/json':
            self._fixture('ext_payload.json')
            return
        if route == '/ext/text':
            self._fixture('ext_plain.txt', ctype='text/plain; charset=utf-8')
            return
        if route == '/ext/empty':
            self._send(200, '', ctype='text/plain; charset=utf-8')
            return
        if route == '/ext/loop':
            # 返回自身地址：FongMi 语义下会再取一次，必须被深度上限或环检测挡住。
            self._send(200, '%s/ext/loop' % self.server.base_url,
                       ctype='text/plain; charset=utf-8')
            return
        if route == '/ext/chain':
            self._send(200, '%s/ext/json' % self.server.base_url,
                       ctype='text/plain; charset=utf-8')
            return
        if route == '/ext/gbk':
            # GBK 正文 + 不声明 charset：编码识别必须回退 gb18030。
            self._send(200, '{"名称":"中文"}'.encode('gb18030'),
                       ctype='application/json')
            return
        if route == '/ext/500':
            self._send(500, '{"error":"boom"}')
            return

        # 站点资源：JS/Python/JAR 的可下载占位物（内容真实但极小）。
        if route == '/js/site.js':
            self._send(200, 'globalThis.__JS_SPIDER__ = {};',
                       ctype='application/javascript')
            return
        if route == '/py/site.py':
            self._send(200, 'class Spider:\n    def init(self, extend=""):\n        pass\n',
                       ctype='text/x-python')
            return

        self._send(404, '{"error":"no such fixture route"}')

    def do_HEAD(self):                                    # noqa: N802
        self.do_GET()


class _QuietServer(http.server.ThreadingHTTPServer):
    """客户端主动断开不算夹具错误。

    体积上限用例正是靠 `read_capped` 提前 `response.close()` 来验证「不先收完再判断」，
    于是服务端必然看到连接重置。`socketserver` 默认把它当未处理异常打整段 traceback，
    测试输出里看起来像夹具炸了。这里只吞掉连接类异常，其余仍按原样上报。
    """

    def handle_error(self, request, client_address):
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class FixtureServer:
    """loopback 上的夹具服务；`with FixtureServer() as fx:` 用法。

    进入时隔离宿主的代理配置，这是**测试确定性**措施，不改变任何被测语义：

    * `127.0.0.1,localhost` 追加进 `NO_PROXY`，并清掉 `HTTP(S)_PROXY`/`ALL_PROXY`
      ——开发机上设了代理时 `http_client` 会照着走，夹具请求会被代理吞掉；
    * `http_client._read_wininet` 临时返回「无代理」——Windows 注册表里的系统代理
      不受环境变量影响，若不隔离，指向 `*.invalid` 的用例会打到公司代理并可能拿到
      一个 200 的错误页，装配结果就随宿主环境变化了。

    退出时全部原样还原。
    """

    _NO_PROXY_KEYS = ('NO_PROXY', 'no_proxy')
    _PROXY_KEYS = ('HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
                   'ALL_PROXY', 'all_proxy')

    def __init__(self):
        ensure_binary_fixtures()
        self.httpd = _QuietServer(('127.0.0.1', 0), _Handler)
        self.httpd.daemon_threads = True
        self.httpd.counters = {}
        self.httpd.base_url = 'http://127.0.0.1:%d' % self.httpd.server_port
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True,
                                       name='vpc-config-fixture')
        self._saved_env = {}
        self._saved_wininet = None

    # ------------------------------------------------------------ 生命周期

    def __enter__(self):
        for key in self._NO_PROXY_KEYS:
            self._saved_env[key] = os.environ.get(key)
            current = os.environ.get(key) or ''
            parts = [p for p in current.split(',') if p.strip()]
            for host in ('127.0.0.1', 'localhost'):
                if host not in parts:
                    parts.append(host)
            os.environ[key] = ','.join(parts)
        for key in self._PROXY_KEYS:
            self._saved_env[key] = os.environ.get(key)
            os.environ.pop(key, None)
        try:
            import http_client
            self._saved_wininet = http_client._read_wininet
            http_client._read_wininet = lambda: ({}, '')
        except Exception:
            self._saved_wininet = None
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.close()
        return False

    def close(self):
        try:
            self.httpd.shutdown()
        except Exception:
            pass
        try:
            self.httpd.server_close()
        except Exception:
            pass
        if self._saved_wininet is not None:
            try:
                import http_client
                http_client._read_wininet = self._saved_wininet
            except Exception:
                pass
            self._saved_wininet = None
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._saved_env.clear()

    # ------------------------------------------------------------------ URL

    @property
    def base(self):
        return self.httpd.base_url

    @property
    def port(self):
        return self.httpd.server_port

    def url(self, path):
        return '%s/%s' % (self.base, str(path).lstrip('/'))

    def config(self, name):
        return self.url('config/%s' % name)

    def cross_origin(self, path):
        """同一进程、不同 host 名 → 不同 origin，用于验证同源继承的边界。"""
        return 'http://localhost:%d/%s' % (self.port, str(path).lstrip('/'))

    def hits(self, route):
        return int(self.httpd.counters.get(route, 0))


def json_fixture(name):
    return json.loads(read_fixture(name))
