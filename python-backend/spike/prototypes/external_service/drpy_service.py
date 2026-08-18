# -*- coding: utf-8 -*-
"""方案3【外部 drpy 服务】原型 —— 独立的外部 drpy 专有服务。

模拟一个与 Python 后端完全解耦的独立 drpy 服务进程（单 TCP 端口、HTTP REST）。
生产形态下该进程内运行的是真实 drpy JS 运行时（Node Worker / QuickJS，即方案1/2
所研究的两类引擎）；本原型用内置的 Python「伪 drpy 规则」在服务端模拟同一套
SPIDER 契约，保证客户端适配器、REST 协议与评测结论可以离线复现。

REST 契约（全部 JSON）：
    GET  /api/v1/ping                健康检查 -> {ok, service, version, pid, uptime, rules}
    GET  /api/v1/rules               规则列表 -> {ok, rules: [{rule, name, methods, payload_kb}]}
    GET  /api/v1/rules/{rule}        单个规则元信息（name, methods, payload_kb）
    POST /api/v1/invoke              调用规则方法 -> {ok, code, data}
                                     请求体: {rule, method, args, kwargs}
    GET  /api/v1/stats               服务端统计（命中/响应字节/处理耗时）-> {ok, stats}

安全边界：可调用方法白名单 == base Spider 接口（SPIDER_METHODS），外部调用方无法
触达服务端任意代码；`--token` 可开启 Bearer 鉴权，防止端口裸露被任意调用。

运行：
    python drpy_service.py [--host 127.0.0.1] [--port 9810] [--latency-ms 0]
                           [--rule-dir DIR] [--token TOKEN]

- `--latency-ms N`：给每次 invoke 附加 N 毫秒模拟真实规则的计算/网络上游耗时，
  用于评测「规则计算耗时 vs 传输开销」的比例。
- `--rule-dir DIR`：加载目录下 *.py 中导出 `rule` 字典（{方法名: 可调用}) 的
  自定义规则（模拟真实仓库里散落的 drpy 规则被部署到独立服务）。
- `--port 0`：自动分配端口，就绪后打印 DRPY_SERVICE_READY url=... 供宿主读取。

仅依赖标准库（Python >= 3.8）。
"""

import argparse
import base64
import importlib.util
import json
import os
import socket
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SERVICE_NAME = 'spike-external-drpy'
SERVICE_VERSION = '0.1.0'
DEFAULT_HOST = '127.0.0.1'
DEFAULT_PORT = 9810

# 对外暴露的方法白名单 —— 与 base/spider.py 的 Spider 接口一一对应。
# 这是原型里最重要的一条安全边界：外部服务只暴露爬虫契约，其余一律拒绝。
SPIDER_METHODS = frozenset({
    'init', 'homeContent', 'homeVideoContent', 'categoryContent', 'detailContent',
    'searchContent', 'playerContent', 'liveContent', 'localProxy', 'getName',
    'getDependence', 'action', 'isVideoFormat', 'manualVideoCheck',
})


# ---------------------------------------------------------------- 内置模拟规则
class RuleBase:
    """伪 drpy 规则的公共基类：字段名/返回值全部对齐标准 SPIDER 契约。"""

    name = ''

    def getName(self):
        return self.name

    def getDependence(self):
        return []

    def init(self, extend=''):
        return {'ok': True}

    def homeContent(self, filter=False):
        return {'class': [], 'list': [], 'filters': {}}

    def homeVideoContent(self):
        return {'list': self.homeContent(False).get('list', [])}

    def categoryContent(self, tid, pg, filter, extend):
        return {'list': [], 'page': int(pg or 1), 'pagecount': 1, 'limit': 0, 'total': 0}

    def detailContent(self, ids):
        return {'list': []}

    def searchContent(self, key, quick, pg='1'):
        return {'list': []}

    def playerContent(self, flag, id, vipFlags):
        return {'url': id, 'parse': 0, 'header': {}}

    def liveContent(self, url):
        return {}

    def localProxy(self, param):
        # REST 协议传输 bytes 不可直接 JSON 序列化：统一 base64 传输，客户端还原
        return [200, 'text/plain; charset=utf-8',
                base64.b64encode(b'drpy-service-proxy-ok').decode('ascii')]

    def action(self, action):
        return {}

    def isVideoFormat(self, url):
        return False

    def manualVideoCheck(self):
        return False


def _vod(vod_id, name, remarks='', pic='https://img.external.test/{id}.jpg'):
    """构造一条标准 vod dict，控制 payload 大小用于评测。"""
    return {
        'vod_id': vod_id,
        'vod_name': name,
        'vod_pic': pic.format(id=vod_id),
        'vod_remarks': remarks,
    }


class DemoCmsRule(RuleBase):
    """轻量规则：小 payload，模拟普通 CMS 站点。"""

    name = 'demo_cms'

    def homeContent(self, filter=False):
        return {
            'class': [
                {'type_id': 'movie', 'type_name': '电影'},
                {'type_id': 'serie', 'type_name': '剧集'},
            ],
            'list': [
                _vod('c1', '国产喜剧精选', '更新至12'),
                _vod('c2', '高分纪录片集', '完结'),
                _vod('c3', '经典港片回顾', '4K'),
                _vod('c4', '海外剧集热播', '连载中'),
                _vod('c5', '动画剧场版', 'HD'),
                _vod('c6', '悬疑推理剧场', '1080P'),
            ],
            'filters': {},
        }

    def detailContent(self, ids):
        vid = ids[0] if ids else 'c1'
        return {'list': [{
            'vod_id': vid,
            'vod_name': f'示例影片_{vid}',
            'type_name': '电影',
            'vod_play_from': 'cms专线',
            'vod_play_url': '第01集$https://cdn.test/v1.m3u8#第02集$https://cdn.test/v2.m3u8',
        }]}


class DemoMovieRule(RuleBase):
    """重量规则：大 payload（3 条线路 × 24 集 + 完整元信息），评测负载大小的影响。"""

    name = 'demo_movie'

    def homeContent(self, filter=False):
        classes = [
            {'type_id': 'movie', 'type_name': '电影'},
            {'type_id': 'serie', 'type_name': '剧集'},
            {'type_id': 'anime', 'type_name': '动漫'},
        ]
        items = [
            _vod(f'h{idx:02d}', f'首页热播片源{idx:02d}号',
                 '更新至字幕组第12集' if idx % 2 else '4K超清收藏版')
            for idx in range(1, 13)
        ]
        return {'class': classes, 'list': items, 'filters': {}}

    def detailContent(self, ids):
        vid = ids[0] if ids else 'h01'
        episodes = '#'.join(
            f'第{i:02d}集$https://cdn.movie.test/{vid}/ep{i:02d}.m3u8'
            for i in range(1, 25)
        )
        return {'list': [{
            'vod_id': vid,
            'vod_name': f'大体积影片_{vid}',
            'vod_pic': f'https://img.movie.test/{vid}.jpg',
            'type_name': '动作',
            'vod_year': '2026',
            'vod_area': '中国大陆',
            'vod_remarks': '完结',
            'vod_actor': '演员A / 演员B / 演员C / 演员D',
            'vod_director': '导演X',
            'vod_content': ('这是一部用于评测外部 drpy 服务网络开销的影片，简介内容为'
                            '一段较长的文本，用来放大 detailContent 响应 payload。' * 3),
            'vod_play_from': '高清专线$$$备用专线$$$海外线路',
            'vod_play_url': f'{episodes}$$${episodes}$$${episodes}',
        }]}

    def searchContent(self, key, quick, pg='1'):
        return {'list': [
            _vod(f's_{key}_{i}', f'搜索命中_{key}_{i}', '搜索匹配')
            for i in range(1, 9)
        ]}


class DemoStatefulRule(RuleBase):
    """带状态的流媒体规则：模拟真实 drpy 站点常见的「先登录/鉴权保活」形态。

    服务端持有会话状态（本原型为进程内内存态），播放地址需要会话 token ——
    这恰好体现了外部服务进程「必须长驻保活」的业务原因。
    """

    name = 'demo_stateful'
    _token = 'spike_session_token_2026'

    def homeContent(self, filter=False):
        return {
            'class': [{'type_id': 'vip', 'type_name': '会员影院'}],
            'list': [_vod('v1', '会话保活测试大片', 'VIP专享')],
            'filters': {},
        }

    def detailContent(self, ids):
        vid = ids[0] if ids else 'v1'
        return {'list': [{
            'vod_id': vid,
            'vod_name': f'会话保活影片_{vid}',
            'vod_pic': f'https://img.stateful.test/{vid}.jpg',
            'type_name': '会员影院',
            'vod_play_from': 'VIP专线',
            'vod_play_url': (f'高清$https://vip.test/play/{vid}.m3u8'
                             f'?session={self._token}#蓝光$https://vip.test/play/'
                             f'{vid}_bluray.m3u8?session={self._token}'),
        }]}

    def playerContent(self, flag, id, vipFlags):
        return {
            'url': f'https://stream.stateful.test/{id}.m3u8?session={self._token}',
            'parse': 0,
            'header': {'Referer': 'https://stateful.test/'},
        }


def _build_registry(rule_dir):
    """注册内置规则 + 可选的外部 JSON/规则文件。返回 {rule_name: rule_obj}。"""
    registry = {r.name: r for r in (DemoCmsRule(), DemoMovieRule(), DemoStatefulRule())}
    if rule_dir:
        for path in sorted(Path(rule_dir).glob('*.py')):
            try:
                mod_name = f'drpy_ext_{path.stem}'
                spec = importlib.util.spec_from_file_location(mod_name, path)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                rule = getattr(mod, 'rule', None)
                if isinstance(rule, dict):
                    registry[path.stem] = _DictRule(rule, path.stem)
                    print(f'[drpy-service] loaded external rule: {path.stem} <- {path}',
                          flush=True)
            except Exception as exc:  # 单个规则加载失败不拖垮整个服务
                print(f'[drpy-service] WARN skip {path}: {exc}', file=sys.stderr, flush=True)
    return registry


class _DictRule:
    """把 {方法名: 可调用} 字典包装成与内置规则一致的调用形态（模拟 drpy `rule` 对象）。"""

    def __init__(self, methods, name):
        self._methods = methods
        self.name = name

    def getName(self):
        return self._methods.get('getName', lambda: self.name)()

    def getDependence(self):
        return self._methods.get('getDependence', lambda: [])()

    def __getattr__(self, item):
        if item in self._methods:
            return self._methods[item]
        raise AttributeError(item)


# ---------------------------------------------------------------- HTTP 服务
class DrpyRequestHandler(BaseHTTPRequestHandler):
    server_version = f'{SERVICE_NAME}/{SERVICE_VERSION}'
    # HTTP/1.1 + Content-Length -> 连接复用（keep-alive），评测稳态连接开销的前提
    protocol_version = 'HTTP/1.1'

    # ---------------- 基础设施 ----------------
    def _safe(self, fn):
        """handler 兜底：任何未预期异常转成 500 JSON，避免工作线程崩溃丢连接。"""
        try:
            fn()
        except Exception as exc:
            try:
                self._json(500, {'ok': False, 'code': 500,
                                 'error': f'internal: {type(exc).__name__}: {exc}'})
            except Exception:
                pass
    def _json(self, status_code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Drpy-Service', f'{os.getpid()}')
        self.end_headers()
        self.wfile.write(body)
        return len(body)

    def _stats_lock(self):
        return getattr(self.server, 'stats_lock')

    def _track(self, method, sent_bytes, recv_bytes, ns):
        lock = self._stats_lock()
        with lock:
            st = self.server.stats
            st['invokes'] += 1
            st['bytes_sent'] += sent_bytes
            st['bytes_recv'] += recv_bytes
            st['handle_ns'] += ns
            st['hits'][method] = st['hits'].get(method, 0) + 1

    def _check_auth(self):
        token = getattr(self.server, 'auth_token', None)
        if not token:
            return True
        supplied = self.headers.get('Authorization', '')
        expected = f'Bearer {token}'
        return supplied == expected

    # ---------------- GET ----------------
    def do_GET(self):
        self._safe(self._handle_get)

    def _handle_get(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == '/api/v1/ping':
            return self._json(200, {
                'ok': True,
                'service': SERVICE_NAME,
                'version': SERVICE_VERSION,
                'pid': os.getpid(),
                'uptime': round(time.time() - self.server.started_at, 3),
                'rules': sorted(self.server.registry),
            })

        if path == '/api/v1/rules':
            metas = [self._rule_meta(name, rule) for name, rule in self.server.registry.items()]
            return self._json(200, {'ok': True, 'rules': metas})

        if path.startswith('/api/v1/rules/'):
            name = urllib.parse.unquote(path.rsplit('/', 1)[-1])
            rule = self.server.registry.get(name)
            if rule is None:
                return self._json(404, {'ok': False, 'code': 404, 'error': f'unknown rule: {name}'})
            return self._json(200, {'ok': True, 'rule': self._rule_meta(name, rule)})

        if path == '/api/v1/stats':
            with self._stats_lock():
                stats = dict(self.server.stats)
            stats['uptime'] = round(time.time() - self.server.started_at, 3)
            return self._json(200, {'ok': True, 'stats': stats})

        return self._json(404, {'ok': False, 'code': 404, 'error': f'unknown route: {path}'})

    @staticmethod
    def _rule_meta(name, rule):
        fn = getattr(rule, 'homeContent', None)
        sample = None
        try:
            sample = fn(False) if callable(fn) else None
        except Exception:
            sample = None
        payload_kb = round(len(json.dumps(sample, ensure_ascii=False).encode('utf-8')) / 1024, 3) \
            if sample is not None else 0.0
        return {
            'rule': name,
            'name': getattr(rule, 'getName', lambda: name)(),
            'methods': sorted(SPIDER_METHODS),
            'payload_kb': payload_kb,
        }

    # ---------------- POST: /api/v1/invoke ----------------
    def do_POST(self):
        self._safe(self._handle_post)

    def _handle_post(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != '/api/v1/invoke':
            return self._json(404, {'ok': False, 'code': 404, 'error': f'unknown route: {parsed.path}'})

        # 必须先读完请求体再鉴权/响应：HTTP/1.1 keep-alive 下，未消费的 body
        # 会污染同一连接上的下一条请求（"Bad request syntax"）。
        content_length = int(self.headers.get('Content-Length', 0) or 0)
        raw = self.rfile.read(content_length) if content_length > 0 else b''

        if not self._check_auth():
            return self._json(401, {'ok': False, 'code': 401, 'error': 'missing/invalid bearer token'})

        try:
            req = json.loads(raw.decode('utf-8')) if raw else {}
        except (ValueError, UnicodeDecodeError) as exc:
            return self._json(400, {'ok': False, 'code': 400, 'error': f'bad json body: {exc}'})

        rule_name = req.get('rule', '')
        method = req.get('method', '')
        args = req.get('args') or []
        kwargs = req.get('kwargs') or {}

        tracked = method in SPIDER_METHODS
        t0 = time.perf_counter_ns()
        if self.server.latency_ms > 0:
            time.sleep(self.server.latency_ms / 1000.0)

        error = None
        status_code = 200
        data = None
        if rule_name not in self.server.registry:
            status_code, error = 404, f'unknown rule: {rule_name}'
        elif method not in SPIDER_METHODS:
            status_code, error = 400, f'method not allowed (whitelist): {method}'
        else:
            rule = self.server.registry[rule_name]
            fn = getattr(rule, method, None)
            if not callable(fn):
                status_code, error = 501, f'rule {rule_name!r} does not implement {method}()'
            else:
                try:
                    data = fn(*args, **kwargs)
                except Exception as exc:  # 规则内部异常 → 500，不拖垮服务进程
                    status_code, error = 500, f'{type(exc).__name__}: {exc}'

        handle_ns = time.perf_counter_ns() - t0
        if status_code == 200:
            sent = self._json(200, {'ok': True, 'code': 0, 'data': data})
        else:
            sent = self._json(status_code, {'ok': False, 'code': status_code, 'error': error})
        if tracked:
            self._track(method, sent, len(raw), handle_ns)

    def log_message(self, format, *args):  # 保持评测输出整洁
        pass


# ---------------------------------------------------------------- 入口
def build_server(host=DEFAULT_HOST, port=DEFAULT_PORT, latency_ms=0,
                 token=None, rule_dir=None):
    """创建（尚未启动）服务实例，供测试/宿主进程内嵌使用。

    端口占用探测：http.server 默认 allow_reuse_address=True（SO_REUSEADDR），
    在 Windows 上该选项语义不同，允许第二个进程静默绑定同一端口。因此在创建
    HTTPServer 之前先用「不设 SO_REUSEADDR」的 socket 做独占探测，端口被占用时
    立即给出明确错误（跨平台行为一致）。port=0（自动分配）跳过探测。
    """
    if port != 0:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind((host, port))
        except OSError as exc:
            raise RuntimeError(
                f'cannot bind {host}:{port} ({exc}) —— 端口被占用或被防火墙拦截；'
                f'换 --port 或 --port 0 自动分配') from exc
        finally:
            probe.close()
    try:
        server = ThreadingHTTPServer((host, port), DrpyRequestHandler)
    except OSError as exc:
        raise RuntimeError(
            f'cannot bind {host}:{port} ({exc}) —— 端口被占用或被防火墙拦截；'
            f'换 --port 或 --port 0 自动分配') from exc
    server.auth_token = token or None
    server.latency_ms = max(0, int(latency_ms or 0))
    server.registry = _build_registry(rule_dir)
    server.stats_lock = threading.Lock()
    server.stats = {
        'invokes': 0,
        'bytes_sent': 0,
        'bytes_recv': 0,
        'handle_ns': 0,
        'hits': {},
    }
    server.started_at = time.time()
    return server


def main(argv=None):
    ap = argparse.ArgumentParser(description='方案3【外部 drpy 服务】原型（独立进程）')
    ap.add_argument('--host', default=DEFAULT_HOST,
                    help=f'监听地址（默认 {DEFAULT_HOST}；远程部署用 0.0.0.0）')
    ap.add_argument('--port', type=int, default=DEFAULT_PORT,
                    help=f'监听端口（默认 {DEFAULT_PORT}；0 = 自动分配）')
    ap.add_argument('--latency-ms', type=int, default=0,
                    help='每次 invoke 附加的模拟计算耗时（毫秒），用于评测开销构成')
    ap.add_argument('--rule-dir', default=None,
                    help='加载 *.py 自定义规则目录（模块须导出 rule 字典）')
    ap.add_argument('--token', default=None, help='可选 Bearer 鉴权 token（防端口裸奔）')
    args = ap.parse_args(argv)

    try:
        server = build_server(args.host, args.port, args.latency_ms, args.token, args.rule_dir)
    except RuntimeError as exc:
        print(f'[drpy-service] FATAL: {exc}', file=sys.stderr, flush=True)
        return 2

    host, port = server.server_address[:2]
    print(f'[drpy-service] {SERVICE_NAME} v{SERVICE_VERSION} listening on '
          f'http://{host}:{port} latency_ms={args.latency_ms} '
          f'auth={bool(args.token)} rules={sorted(server.registry)}', flush=True)
    print(f'DRPY_SERVICE_READY url=http://{host}:{port} pid={os.getpid()} '
          f'rules={sorted(server.registry)}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[drpy-service] shutting down.', flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())