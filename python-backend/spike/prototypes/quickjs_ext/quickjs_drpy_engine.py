# -*- coding: utf-8 -*-
"""QuickJS drpy Engine: 增强版 QuickJS drpy 运行引擎。

在原有 quickjs_host.JsEngine 基础上提供完整的 drpy 环境：
1. 完整注入 drpy 契约环境（cheerio, pdfa, pdfh, pdft, pd, CryptoJS, req, request, post, local, joinUrl 等）。
2. 可配置 CPU 执行时限 (time_limit)、内存大小 (memory_limit)、调用超时 (timeout)。
3. 微任务泵与同步/异步 Promise 处理机制，保证同步 req() 与异步调用的兼容。
4. 增强的异常捕获与诊断机制（ReferenceError、超时中断、内存超限识别）。
"""

import os
import sys
import json
import time
import hashlib
import logging
import threading
import re
from typing import Any, Dict, List, Optional, Union
from urllib.parse import quote

import quickjs

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(ENGINE_DIR, '..', '..', '..'))
JS_ENGINE_DIR = os.path.join(BACKEND_DIR, 'js-engine')

for p in (BACKEND_DIR, JS_ENGINE_DIR, ENGINE_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

import http_client
import hoststate
from esm_transform import esm_to_script
from module_resolver import ModuleBundle, binding_statements

logger = logging.getLogger('vpc.drpy_qjs')

HOST_BOOTSTRAP_JS = os.path.join(JS_ENGINE_DIR, 'host_bootstrap.js')
CAT_JS = os.path.join(JS_ENGINE_DIR, 'lib', 'cat.js')
DRPY_BOOTSTRAP_JS = os.path.join(ENGINE_DIR, 'drpy_bootstrap.js')
SPIDER_LOADER_JS = os.path.join(JS_ENGINE_DIR, 'spider-loader.js')

LOCAL_KV_DIR = hoststate.get_data_dir()
LOCAL_KV_FILE = os.path.join(LOCAL_KV_DIR, 'js_local.json')
_local_kv_lock = threading.Lock()


def _local_kv_load():
    try:
        with open(LOCAL_KV_FILE, encoding='utf-8') as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _local_kv_save(data):
    try:
        os.makedirs(LOCAL_KV_DIR, exist_ok=True)
        with open(LOCAL_KV_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception as e:
        logger.warning('local kv save failed: %s', e)


KV_SCOPE_SEP = '\u0002'
KV_MAX_VALUE_BYTES = 64 * 1024
KV_MAX_TOTAL_BYTES = 2 * 1024 * 1024


def _kv_scoped(site_key, key):
    return site_key + KV_SCOPE_SEP + key if site_key else key


def _native_local_get(site_key=''):
    def fn(key):
        with _local_kv_lock:
            data = _local_kv_load()
            v = data.get(_kv_scoped(site_key, key))
            if v is None and site_key:
                v = data.get(key)
            return v if isinstance(v, str) else ''
    return fn


def _native_local_set(site_key=''):
    def fn(key, value):
        value = str(value)
        if len(value.encode('utf-8')) > KV_MAX_VALUE_BYTES:
            logger.warning('[js] local.set skipped: value %dKB > %dKB (site=%s key=%.60s)',
                           len(value) // 1024, KV_MAX_VALUE_BYTES // 1024, site_key, key)
            return None
        with _local_kv_lock:
            data = _local_kv_load()
            sk = _kv_scoped(site_key, key)
            data[sk] = value
            if site_key and key in data:
                del data[key]
            try:
                blob = json.dumps(data, ensure_ascii=False).encode('utf-8')
            except Exception:
                blob = b''
            if len(blob) > KV_MAX_TOTAL_BYTES:
                logger.warning('[js] local.set skipped: kv total %dKB > %dKB (site=%s)',
                               len(blob) // 1024, KV_MAX_TOTAL_BYTES // 1024, site_key)
                return None
            _local_kv_save(data)
        return None
    return fn


def _native_local_delete(site_key=''):
    def fn(key):
        with _local_kv_lock:
            data = _local_kv_load()
            changed = False
            sk = _kv_scoped(site_key, key)
            if sk in data:
                del data[sk]
                changed = True
            if site_key and key in data:
                del data[key]
                changed = True
            if changed:
                _local_kv_save(data)
        return None
    return fn


def _native_md5(text):
    try:
        return hashlib.md5(str(text).encode('utf-8')).hexdigest()
    except Exception:
        return ''


CAT_ALIASES = {
    'cheerio': ['cheerio', '$'],
    'Crypto': ['Crypto', 'CryptoJS'],
    'dayjs': ['dayjs'],
    'jinja2': ['jinja2'],
    'contains': ['contains'],
    'merge': ['merge'],
    'parseHTML': ['parseHTML'],
    'text': ['text'],
    'xml': ['xml'],
    'html': ['html'],
    'Uri': ['Uri'],
    '_': ['_'],
}


def _native_http(url, options_json):
    """同步 HTTP，返回 JSON 串：{ok, status, code, content, headers}。"""
    try:
        opt = json.loads(options_json) if options_json else {}
    except (TypeError, ValueError):
        opt = {}
    method = str(opt.get('method') or 'GET').upper()
    headers = opt.get('headers') or {}
    timeout = opt.get('timeout') or 10
    allow_redirects = opt.get('redirect', True)
    try:
        kwargs = dict(headers=headers, timeout=timeout,
                      allow_redirects=bool(allow_redirects), verify=False)
        if method == 'POST':
            kwargs['data'] = opt.get('body') or opt.get('data')
            rsp = http_client.post(url, **kwargs)
        else:
            rsp = http_client.get(url, **kwargs)
        return json.dumps({
            'ok': rsp.status_code < 400,
            'status': rsp.status_code,
            'code': rsp.status_code,
            'content': rsp.text,
            'data': rsp.text,
            'headers': dict(rsp.headers),
        }, ensure_ascii=False)
    except Exception as e:
        logger.warning('js req failed: %s %s', url, e)
        return json.dumps({'ok': False, 'status': 500, 'code': 500,
                           'content': '', 'headers': {}, 'url': url})


class QuickJsDrpyEngine:
    """drpy 专用 QuickJS 执行引擎。"""

    def __init__(
        self,
        site_key: str = '',
        time_limit: float = 30.0,
        memory_limit_mb: float = 256.0,
        max_stack_size_kb: float = 1024.0,
        custom_http_handler=None,
    ):
        self.lock = threading.RLock()
        self.site_key = str(site_key or '')
        self.time_limit = float(time_limit)
        self.memory_limit_bytes = int(memory_limit_mb * 1024 * 1024)
        self.max_stack_size_bytes = int(max_stack_size_kb * 1024)
        self.proxy_port = 0
        self.init_protocol = 'string'
        self.custom_http_handler = custom_http_handler

        self.ctx = quickjs.Context()
        self._apply_limits()
        self._inject_host_functions()
        self._bootstrap()

    def _apply_limits(self):
        """配置 CPU 执行时长、内存占用上限和调用栈上限。
        
        注意（QuickJS-ng 关键机制与边界）：
        QuickJS 的 C 扩展中，当设置了 time_limit 时，若 JS 尝试调用 Python 原生回调（add_callable 注册的函数），
        QuickJS 会抛出 'InternalError: Can not call into Python with a time limit set.'。
        因此，在宿主初始化及需要调用 Python 回调（如 HTTP req/request、local KV、log 等）时，
        必须保持 time_limit 解除；或者在执行纯 JS 动态计算段时单独施加 time_limit。
        """
        try:
            if self.memory_limit_bytes > 0:
                self.ctx.set_memory_limit(self.memory_limit_bytes)
        except AttributeError:
            logger.warning('quickjs-ng set_memory_limit API not available')

        try:
            if self.max_stack_size_bytes > 0:
                self.ctx.set_max_stack_size(self.max_stack_size_bytes)
        except AttributeError:
            logger.warning('quickjs-ng set_max_stack_size API not available')

    def set_time_limit(self, seconds: float):
        """设置纯 JS 计算时限。若传入 <= 0 则清除时限。"""
        try:
            self.ctx.set_time_limit(seconds if seconds > 0 else -1)
        except AttributeError:
            pass

    def _inject_host_functions(self):
        """向 QuickJS 上下文注入 Python 原生宿主回调。"""
        http_fn = self.custom_http_handler or _native_http
        self.ctx.add_callable('_native_http', http_fn)
        self.ctx.add_callable('_native_log', self._log)
        self.ctx.add_callable('_native_local_get', _native_local_get(self.site_key))
        self.ctx.add_callable('_native_local_set', _native_local_set(self.site_key))
        self.ctx.add_callable('_native_local_delete', _native_local_delete(self.site_key))
        self.ctx.add_callable('_native_md5', _native_md5)
        self.ctx.add_callable('_native_js2proxy', self._js2proxy)

    def _log(self, level, msg):
        getattr(logger, level if level in ('info', 'warn', 'error', 'debug') else 'info')(
            '[drpy-js] %s', msg)

    def _js2proxy(self, site_key, flag):
        port = self.proxy_port or 0
        encoded_site = quote(str(site_key or self.site_key), safe='')
        encoded_flag = quote(str(flag), safe='')
        return (f'http://127.0.0.1:{port}/proxy?do=js&siteKey={encoded_site}'
                f'&flag={encoded_flag}')

    def _eval_file(self, path):
        with open(path, encoding='utf-8') as f:
            self.ctx.eval(f.read())

    def _bootstrap(self):
        """依次引导 host 别名、cat.js 库以及 drpy 专用契约环境。"""
        # 1. host_bootstrap.js
        self._eval_file(HOST_BOOTSTRAP_JS)

        # 2. 注入 crypto.getRandomValues 避免 cat.js 内部 crypto-js 初始化报错
        self.ctx.eval("""
        if (typeof globalThis.crypto === 'undefined') {
            globalThis.crypto = {};
        }
        if (typeof globalThis.crypto.getRandomValues === 'undefined') {
            globalThis.crypto.getRandomValues = function (typedArray) {
                if (!typedArray || typeof typedArray.length === 'undefined') return typedArray;
                for (var i = 0; i < typedArray.length; i++) {
                    typedArray[i] = Math.floor(Math.random() * 256);
                }
                return typedArray;
            };
        }
        """)

        # 3. cat.js (ESM -> script 注入)
        with open(CAT_JS, encoding='utf-8') as f:
            cat_src = f.read()
        self.ctx.eval(esm_to_script(cat_src, ns='__CAT__'))
        for export, names in CAT_ALIASES.items():
            for g in names:
                self.ctx.eval(f'try {{ globalThis.{g} = __CAT__.{export}; }} catch (e) {{}}')

        # 4. 修复 CryptoJS.lib.WordArray.random 兜底
        self.ctx.eval("""
        try {
            if (typeof CryptoJS !== 'undefined' && CryptoJS.lib && CryptoJS.lib.WordArray) {
                CryptoJS.lib.WordArray.random = function (nBytes) {
                    var words = [];
                    for (var i = 0; i < nBytes; i += 4) {
                        words.push((Math.random() * 0x100000000) | 0);
                    }
                    return new CryptoJS.lib.WordArray.init(words, nBytes);
                };
            }
        } catch(e) {}
        """)

        # 5. drpy_bootstrap.js
        self._eval_file(DRPY_BOOTSTRAP_JS)

    @staticmethod
    def _warn_missing_global(error, source=''):
        text = str(error or '')
        match = re.search(r"(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*) is not defined", text)
        if not match:
            return
        name = match.group(1)
        suffix = f' ({source})' if source else ''
        logger.warning('drpy JS 源缺少宿主全局 <%s>%s', name, suffix)

    def load_spider(self, src: str) -> bool:
        """加载 drpy / CatVod 单文件规则源码并挂载规则实例。"""
        with self.lock:
            try:
                # 兼容处理 ESM export 语法
                self.ctx.eval(esm_to_script(src, ns='__MODULE_EXPORTS__'))
                # 加载 spider 调度器
                self._eval_file(SPIDER_LOADER_JS)
                # 使用 drpy 提取函数二次确保挂载
                self.ctx.eval('globalThis.__DRPY_EXTRACT_RULE__();')
                is_obj = self.ctx.eval('typeof globalThis.__JS_SPIDER__ === "object" || typeof globalThis.rule === "object"')
                return bool(is_obj)
            except Exception as e:
                self._warn_missing_global(e, 'load_spider')
                logger.error('Failed to load drpy rule in QuickJS: %s', e)
                raise

    def load_spider_url(self, entry_url: str, fetch_text) -> bool:
        """加载多模块 ESM spider。"""
        bundle = ModuleBundle().build(entry_url, fetch_text)
        self.init_protocol = 'fongmi'
        with self.lock:
            for i, (url, src) in enumerate(bundle.modules):
                if src.lstrip().startswith('<'):
                    logger.warning('drpy module fetch is not JS (HTML): %s', url)
                    return False
                ns = f'__MOD{i}__'
                preamble = []
                for clause, dep_url in bundle.imports.get(url, []):
                    dep_idx = bundle.index.get(dep_url)
                    if dep_idx is None:
                        continue
                    preamble.extend(binding_statements(clause, f'__MOD{dep_idx}__'))
                body = esm_to_script(src, ns=ns)
                script = '(function(){\n' + '\n'.join(preamble) + '\n' + body + '\n})();'
                try:
                    self.ctx.eval(script)
                except Exception as e:
                    self._warn_missing_global(e, url)
                    logger.warning('drpy module eval failed: %s (%s)', url, e)
                    raise
            last = len(bundle.modules) - 1
            self.ctx.eval(f'globalThis.__MODULE_EXPORTS__ = globalThis.__MOD{last}__;')
            self._eval_file(SPIDER_LOADER_JS)
            self.ctx.eval('globalThis.__DRPY_EXTRACT_RULE__();')
            return bool(self.ctx.eval('typeof globalThis.__JS_SPIDER__ === "object" || typeof globalThis.rule === "object"'))

    def call(self, method: str, *args) -> Optional[str]:
        """调用 drpy 规则方法，自动处理 Promise 兑现与微任务泵动。"""
        if not self.lock.acquire(blocking=True, timeout=self.time_limit + 5):
            logger.warning('drpy call %s timeout waiting for engine lock', method)
            return None
        try:
            # 动态获取并执行目标方法
            args_json = json.dumps(list(args), ensure_ascii=False)
            call_script = f"""
            (function() {{
                var s = globalThis.__JS_SPIDER__ || globalThis.rule;
                if (!s) return JSON.stringify({{ __vpc_err__: 'no rule loaded' }});
                var fn = s['{method}'];
                if (typeof fn !== 'function') {{
                    return JSON.stringify({{ __vpc_err__: 'no method: {method}' }});
                }}
                try {{
                    var args = {args_json};
                    var r = fn.apply(s, args);
                    if (r && typeof r.then === 'function') {{
                        globalThis.__VPC_PENDING__ = true;
                        globalThis.__VPC_RESULT__ = undefined;
                        r.then(
                            function(v) {{ globalThis.__VPC_RESULT__ = v; globalThis.__VPC_PENDING__ = false; }},
                            function(e) {{ globalThis.__VPC_RESULT__ = {{ __vpc_err__: String(e && e.message || e) }}; globalThis.__VPC_PENDING__ = false; }}
                        );
                        return '__PROMISE__';
                    }}
                    return typeof r === 'string' ? r : JSON.stringify(r === undefined ? null : r);
                }} catch (e) {{
                    return JSON.stringify({{ __vpc_err__: String(e && e.message || e) }});
                }}
            }})()
            """
            try:
                ret = self.ctx.eval(call_script)
            except Exception as e:
                self._warn_missing_global(e, method)
                raise

            if ret == '__PROMISE__':
                ret = self._drain_promise()

            if not isinstance(ret, str):
                return None

            try:
                parsed = json.loads(ret)
                if isinstance(parsed, dict) and '__vpc_err__' in parsed:
                    self._warn_missing_global(parsed['__vpc_err__'], method)
                    logger.warning('drpy method %s error: %s', method, parsed['__vpc_err__'])
                    return None
            except ValueError:
                pass

            return ret
        finally:
            self.lock.release()

    def _drain_promise(self) -> Optional[str]:
        """泵动 QuickJS 微任务队列直到 Promise 完成或超时。"""
        deadline = time.time() + self.time_limit
        for _ in range(5000):
            if time.time() > deadline:
                break
            if not self.ctx.eval('!!globalThis.__VPC_PENDING__'):
                break
            if not self.ctx.execute_pending_job():
                break
        res_js = """
        (function() {
            var v = globalThis.__VPC_RESULT__;
            return typeof v === 'string' ? v : JSON.stringify(v === undefined ? null : v);
        })()
        """
        return self.ctx.eval(res_js)

    def memory_usage(self) -> Dict[str, Any]:
        """获取 QuickJS 内存分配统计信息。"""
        try:
            return self.ctx.memory()
        except Exception:
            return {}
