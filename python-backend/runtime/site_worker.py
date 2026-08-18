# -*- coding: utf-8 -*-
"""在隔离 Worker 内构造并调用 Python、QuickJS、CMS 或 JAR Spider。"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import os
import socket
import subprocess
import sys
import time

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS_DIR = os.path.join(BASE_DIR, 'js-engine')
DRPY_DIR = os.path.join(BASE_DIR, 'drpy-engine')
for path in (BASE_DIR, JS_DIR, DRPY_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

from runner import Runner  # noqa: E402
from runtime.contracts import RuntimeRequest, bind_runtime_request  # noqa: E402
from runtime.errors import (  # noqa: E402
    RuntimeError,
    error_from_exception,
)


def _credential_error(exc, site_key='', runtime=''):
    text = str(exc or '').lower()
    mentions_cookie = 'cookie' in text or 'credential' in text or '登录' in text or '凭据' in text
    missing = any(word in text for word in (
        'missing', 'required', 'empty', 'invalid', 'expired', '未配置', '缺少', '失效', '过期'))
    if mentions_cookie and missing:
        return RuntimeError(
            'L3_RUNTIME_CREDENTIALS_REQUIRED',
            site_key=site_key,
            runtime=runtime,
            raw_error=str(exc),
        )
    return None


class _FixtureRuntime:
    """确定性故障注入 Worker；只供离线契约测试。"""

    def __init__(self, spec):
        self.spec = dict(spec or {})
        self.children = []
        self.bound_socket = None
        startup_pid_file = str(self.spec.get('startup_child_pid_file') or '')
        startup_port = int(self.spec.get('startup_child_port') or 0)
        if startup_pid_file and startup_port:
            code = (
                "import socket,sys,time; s=socket.socket(); "
                "s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); "
                "s.bind(('127.0.0.1',int(sys.argv[1]))); s.listen(8); "
                "exec(\"while True:\\n c,_=s.accept()\\n c.close()\")"
            )
            child = subprocess.Popen(
                [sys.executable, '-c', code, str(startup_port)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            self.children.append(child)
            with open(startup_pid_file, 'w', encoding='ascii') as stream:
                stream.write(str(child.pid))

    def _mode(self, method):
        mode_file = str(self.spec.get('mode_file') or '')
        if mode_file and os.path.exists(mode_file):
            try:
                return open(mode_file, encoding='utf-8').read().strip() or 'normal'
            except OSError:
                pass
        behavior = self.spec.get('behavior')
        if isinstance(behavior, dict):
            return str(behavior.get(method) or behavior.get('*') or 'normal')
        return str(behavior or 'normal')

    def invoke(self, method, args):
        mode = self._mode(method)
        if mode.startswith('sleep:'):
            time.sleep(float(mode.split(':', 1)[1]))
        elif mode == 'infinite':
            while True:
                time.sleep(0.05)
        elif mode == 'error':
            raise ValueError(self.spec.get('error') or 'fixture runtime error')
        elif mode == 'credentials':
            raise ValueError('Cookie missing or expired')
        elif mode == 'crash':
            os._exit(86)
        elif mode == 'crash_once':
            marker = str(self.spec.get('marker_file') or '')
            if marker and not os.path.exists(marker):
                with open(marker, 'w', encoding='ascii') as stream:
                    stream.write('crashed')
                os._exit(86)
        elif mode == 'spawn_child_infinite':
            child = subprocess.Popen(
                [sys.executable, '-c', 'import time; time.sleep(600)'],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.children.append(child)
            pid_file = str(self.spec.get('child_pid_file') or '')
            if pid_file:
                with open(pid_file, 'w', encoding='ascii') as stream:
                    stream.write(str(child.pid))
            while True:
                time.sleep(0.05)
        elif mode == 'port_infinite':
            self.bound_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.bound_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.bound_socket.bind(('127.0.0.1', int(self.spec['port'])))
            self.bound_socket.listen(8)
            self.bound_socket.settimeout(0.05)
            while True:
                try:
                    client, _address = self.bound_socket.accept()
                    client.close()
                except socket.timeout:
                    pass

        responses = self.spec.get('responses') or {}
        if method in responses:
            return responses[method]
        if method == 'getName':
            return str(self.spec.get('name') or self.spec.get('site_key') or 'fixture')
        if method == 'searchContent':
            word = str(args[0] if args else '')
            return {'list': [{'vod_id': str(self.spec.get('site_key') or 'fixture'),
                              'vod_name': word + '-' + str(self.spec.get('site_key') or 'fixture')}]}
        if method in ('homeContent', 'homeVideoContent', 'categoryContent', 'detailContent'):
            return {'list': []}
        if method == 'playerContent':
            return {'parse': 0, 'url': str(args[1] if len(args) > 1 else '')}
        return None

    def destroy(self):
        if self.bound_socket is not None:
            try:
                self.bound_socket.close()
            except OSError:
                pass


class SiteRuntimeWorker:
    def __init__(self, spec):
        self.spec = dict(spec or {})
        self.kind = str(self.spec.get('kind') or '')
        self.site_key = str(self.spec.get('site_key') or '')
        self.name = str(self.spec.get('name') or self.site_key)
        self.runner = None
        self.fixture = None
        self._build()

    def _build(self):
        if self.kind == 'fixture':
            self.fixture = _FixtureRuntime(self.spec)
            return
        if self.kind == 'python':
            path = os.path.realpath(str(self.spec.get('path') or ''))
            if not os.path.isfile(path):
                raise ValueError('python spider file not found')
            module_name = 'vpc_worker_' + hashlib.sha256(
                (self.site_key + '|' + path).encode('utf-8')).hexdigest()[:16]
            module_spec = importlib.util.spec_from_file_location(module_name, path)
            if module_spec is None or module_spec.loader is None:
                raise ValueError('python spider module cannot be loaded')
            module = importlib.util.module_from_spec(module_spec)
            try:
                module_spec.loader.exec_module(module)
            except ModuleNotFoundError as e:
                missing_pkg = getattr(e, 'name', '') or str(e)
                raise ValueError(f'[L3:py] Python Spider 缺失依赖包: {missing_pkg}') from e
            except Exception as e:
                raise ValueError(f'[L3:py] Python Spider 执行失败: {e}') from e

            if not hasattr(module, 'Spider'):
                raise ValueError('[L3:py] Python Spider 缺少 Spider 类导出')
            spider = module.Spider()
        elif self.kind == 'js':
            from config import fetch_text
            from js_spider import make_js_spider_class
            from quickjs_host import JsEngine
            engine = JsEngine(site_key=self.site_key)
            engine.proxy_port = int(self.spec.get('proxy_port') or 0)
            api = str(self.spec.get('api') or '')
            ok = engine.load_spider_url(api, fetch_text) if api.startswith('http') else engine.load_spider(api)
            if not ok:
                raise ValueError('JS spider produced no export')
            spider = make_js_spider_class(self.site_key, engine, self.name)
        elif self.kind == 'drpy':
            from config import fetch_text
            from drpy_spider import make_drpy_spider_class
            api = str(self.spec.get('api') or '')
            rule_source = fetch_text(api) if api.startswith('http') else api
            spider = make_drpy_spider_class(self.site_key, rule_source, self.name)
        elif self.kind == 'jar':
            os.environ['VPC_WORKER_CONTROL_ONLY'] = '1'
            from jar_bridge import JarBridge
            from jar_spider import make_jar_spider_class
            bridge = JarBridge.get_or_create(
                str(self.spec.get('jar_path') or ''),
                runner_jar=str(self.spec.get('runner_jar') or ''),
            )
            spider = make_jar_spider_class(
                self.site_key, bridge, self.name, str(self.spec.get('class_name') or ''))
        elif self.kind == 'cms':
            from cms_spider import CmsSpider
            spider = CmsSpider(
                self.site_key,
                str(self.spec.get('api') or ''),
                int(self.spec.get('stype') or 0),
                self.name,
            )
        else:
            raise ValueError('unsupported worker kind: %s' % self.kind)
        try:
            spider.site_key = self.site_key
        except Exception:
            pass
        self.runner = Runner(spider)

    @property
    def last_error(self):
        spider = getattr(self.runner, 'spider', None)
        return str(getattr(spider, 'last_error', '') or '')

    def call(self, method, args, request_data):
        if self.fixture is not None:
            return self.fixture.invoke(method, args)
        if method == '__runtimeStatus':
            spider = getattr(self.runner, 'spider', None)
            bridge = getattr(spider, 'bridge', None)
            process = getattr(bridge, 'proc', None)
            return {
                'workerPid': os.getpid(),
                'javaPid': getattr(process, 'pid', None)
                if process is not None and process.poll() is None else None,
            }
        if method in ('setCache', 'getCache', 'delCache', 'getProxyUrl'):
            return getattr(self.runner.spider, method)(*args)
        request = RuntimeRequest.create(
            request_id=str(request_data.get('requestId') or ''),
            play_session_id=str(request_data.get('playSessionId') or ''),
            site_key=self.site_key,
            method=method,
            deadline_ms=int(request_data.get('remainingMs') or request_data.get('deadlineMs') or 30000),
            args={'args': args},
        )
        with bind_runtime_request(request):
            if method == 'proxy' and self.kind == 'jar':
                spider = self.runner.spider
                from jar_spider import _load_pan_cookies
                return spider.bridge.call_proxy_descriptor(
                    args[0] if args else {},
                    class_name=spider.class_name,
                    pan_cookies=_load_pan_cookies(),
                )
            result = getattr(self.runner, method)(*args)
            last_error = self.last_error
            if last_error:
                lowered = last_error.lower()
                if 'timeout' in lowered or 'timed out' in lowered:
                    code = 'L3_RUNTIME_TIMEOUT'
                elif 'process' in lowered or 'restart' in lowered or 'exited' in lowered:
                    code = 'L3_RUNTIME_RESTARTED'
                else:
                    code = 'L3_RUNTIME_CALL_FAILED'
                raise RuntimeError(
                    code, site_key=self.site_key, runtime=self.kind,
                    raw_error=last_error)
        return self._encode_proxy_result(result)

    @staticmethod
    def _encode_proxy_result(result):
        try:
            from proxy_contract import ProxyResult
        except Exception:
            ProxyResult = ()
        if not isinstance(result, ProxyResult):
            return result
        body = result.body
        if not isinstance(body, (bytes, str)):
            raise RuntimeError(
                'L3_RUNTIME_PROTOCOL_ERROR',
                raw_error='Python/JS streaming proxy requires a worker data socket',
            )
        raw = body.encode('utf-8') if isinstance(body, str) else body
        return {
            '__vpc_proxy__': True,
            'status': int(result.status),
            'mime': str(result.mime),
            'headers': dict(result.headers or {}),
            'body': base64.b64encode(raw).decode('ascii'),
        }

    def map_error(self, exc, request_data):
        request = RuntimeRequest.create(
            request_id=str(request_data.get('requestId') or ''),
            play_session_id=str(request_data.get('playSessionId') or ''),
            site_key=self.site_key,
            method=str(request_data.get('method') or ''),
            deadline_ms=int(request_data.get('remainingMs') or request_data.get('deadlineMs') or 30000),
        )
        if isinstance(exc, RuntimeError):
            return exc.with_request(request)
        credential = _credential_error(exc, self.site_key, self.kind)
        return credential or error_from_exception(
            exc, stage='runtime', request=request,
            site_key=self.site_key, runtime=self.kind,
        )

    def destroy(self):
        if self.fixture is not None:
            self.fixture.destroy()
            return
        if self.runner is not None:
            try:
                self.runner.destroy()
            except Exception:
                pass
        if self.kind == 'jar':
            try:
                from jar_bridge import JarBridge
                JarBridge.destroy_all()
            except Exception:
                pass
