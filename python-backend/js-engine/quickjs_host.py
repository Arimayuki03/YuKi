# -*- coding: utf-8 -*-
"""quickjs-ng 宿主：JS spider 运行环境。

对齐原 TV 端 QuickJS 注入面：
- 同步 HTTP（_http/http/req，Python requests 阻塞实现，天然同步）
- console / log、global/window/self 别名（host_bootstrap.js）
- cat.js 聚合库（cheerio/Crypto/dayjs/jinja2 等，转为脚本后注入为全局）
- spider.js 加载协议（__jsEvalReturn / default，spider-loader.js）

线程安全：单个 Context 非线程安全，JsEngine 内置锁；聚合搜索并发时
每个 JS 站点各自持有独立 JsEngine。
"""
import os
import sys
import json
import time
import hashlib
import logging
import threading
import re

import http_client
import hoststate
from urllib.parse import quote

import quickjs

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)

from esm_transform import esm_to_script  # noqa: E402
from module_resolver import ModuleBundle, binding_statements  # noqa: E402

logger = logging.getLogger('vpc.jsengine')

BOOTSTRAP_JS = os.path.join(ENGINE_DIR, 'host_bootstrap.js')
LOADER_JS = os.path.join(ENGINE_DIR, 'spider-loader.js')
CAT_JS = os.path.join(ENGINE_DIR, 'lib', 'cat.js')

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


# ---- C2/M-24：JS local KV 按站点隔离 + 配额 ----
# 存储键 = "<site_key>\u0002<原key>"；读取时 scoped 未命中回退裸 key（迁移前
# 旧数据兼容），写入时顺带清理同名裸键。全站点共享一个 JSON 文件，但互不可见。
KV_SCOPE_SEP = '\u0002'
KV_MAX_VALUE_BYTES = 64 * 1024         # 单值上限
KV_MAX_TOTAL_BYTES = 2 * 1024 * 1024   # 全文件上限（超限拒写并告警）


def _kv_scoped(site_key, key):
    return site_key + KV_SCOPE_SEP + key if site_key else key


def _native_local_get(site_key=''):
    def fn(key):
        with _local_kv_lock:
            data = _local_kv_load()
            v = data.get(_kv_scoped(site_key, key))
            if v is None and site_key:
                v = data.get(key)   # 迁移前旧数据兜底
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
                del data[key]   # 迁移走同名裸键，避免兜底读到旧值
            try:
                blob = json.dumps(data, ensure_ascii=False).encode('utf-8')
            except Exception:
                blob = b''
            if len(blob) > KV_MAX_TOTAL_BYTES:
                logger.warning('[js] local.set skipped: kv total %dKB > %dKB (site=%s)',
                               len(blob) // 1024, KV_MAX_TOTAL_BYTES // 1024, site_key)
                return None   # 不落盘，本次写丢弃
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
                del data[key]   # 旧数据一并清理
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

# cat.js 导出 → 全局名（spider 常用别名一并注入）
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


class JsEngine:
    """单个 JS spider 的运行环境（Context + 宿主 API）。"""

    def __init__(self, site_key=''):
        self.lock = threading.RLock()
        self.ctx = quickjs.Context()
        # H-3：远程 JS 源不可信——C 扩展同步 eval 期间不释放 GIL，一段
        # while(true){} 会冻结整个后端（所有端点、所有站点）。三重限额：
        # CPU 30s / 内存 256MB / 栈 1MB；API 缺失时降级告警。
        try:
            self.ctx.set_time_limit(30)
            self.ctx.set_memory_limit(256 * 1024 * 1024)
            self.ctx.set_max_stack_size(1024 * 1024)
        except AttributeError:
            logger.warning('quickjs-ng 缺少限额 API，跳过（建议升级 quickjs-ng）')
        self.ctx.add_callable('_native_http', _native_http)
        self.ctx.add_callable('_native_log', self._log)
        self.ctx.add_callable('_native_local_get', _native_local_get(site_key))
        self.ctx.add_callable('_native_local_set', _native_local_set(site_key))
        self.ctx.add_callable('_native_local_delete', _native_local_delete(site_key))
        self.ctx.add_callable('_native_md5', _native_md5)
        self.ctx.add_callable('_native_js2proxy', self._js2proxy)
        self.site_key = str(site_key or '')   # local KV 隔离域（config 加载时传站点 key）
        self.proxy_port = 0          # 后端 HTTP 端口（config 加载时注入）
        self.init_protocol = 'string'  # string=CatVod 单文件；fongmi=TVBox 多模块
        self._bootstrap()

    # ------------------------------------------------------------ 初始化

    def _log(self, level, msg):
        getattr(logger, level if level in ('info', 'warn', 'error', 'debug') else 'info')(
            '[js] %s', msg)

    @staticmethod
    def _warn_missing_global(error, source=''):
        """把 QuickJS 深埋的 ReferenceError 转成可检索的宿主诊断。"""
        text = str(error or '')
        match = re.search(r"(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*) is not defined", text)
        if not match:
            return
        name = match.group(1)
        suffix = f' ({source})' if source else ''
        logger.warning('该 JS 源需要宿主未提供的全局 <%s>%s', name, suffix)

    def _js2proxy(self, site_key, flag):
        """TVBox js2Proxy 桥：生成后端 /proxy 媒体代理 URL（query 透传给 localProxy）。"""
        port = self.proxy_port or 0
        encoded_site = quote(str(site_key), safe='')
        encoded_flag = quote(str(flag), safe='')
        return (f'http://127.0.0.1:{port}/proxy?do=js&siteKey={encoded_site}'
                f'&flag={encoded_flag}')

    def _eval_file(self, path):
        with open(path, encoding='utf-8') as f:
            self.ctx.eval(f.read())

    def _bootstrap(self):
        self._eval_file(BOOTSTRAP_JS)
        # cat.js 为 ESM，转换后以全局形式注入
        with open(CAT_JS, encoding='utf-8') as f:
            cat_src = f.read()
        self.ctx.eval(esm_to_script(cat_src, ns='__CAT__'))
        for export, names in CAT_ALIASES.items():
            for g in names:
                self.ctx.eval(f'try {{ globalThis.{g} = __CAT__.{export}; }} catch (e) {{}}')

    def load_spider(self, src):
        """加载 spider 源码（ESM），执行 spider.js 协议；返回是否成功。"""
        with self.lock:
            try:
                self.ctx.eval(esm_to_script(src, ns='__MODULE_EXPORTS__'))
                self._eval_file(LOADER_JS)
                return self.ctx.eval('typeof globalThis.__JS_SPIDER__') == 'object'
            except Exception as e:
                self._warn_missing_global(e, '加载')
                raise

    def load_spider_url(self, entry_url, fetch_text):
        """加载多模块 ESM spider：递归抓取依赖，逐模块 IIFE 隔离执行。

        每个模块顶层声明封闭在各自 IIFE 内避免同名冲突，exports 收集到
        独立命名空间 __MODn__，import 绑定以 var 前缀语句注入。
        """
        bundle = ModuleBundle().build(entry_url, fetch_text)
        self.init_protocol = 'fongmi'
        with self.lock:
            for i, (url, src) in enumerate(bundle.modules):
                # JS 前置探测：站点挂了/反爬页时抓到的往往是 HTML 而非 JS。
                # 直接 eval 会造成 SyntaxError + 完整堆栈；改记 WARNING 并返回 False，
                # 由上层跳过该站点。入口模块（拓扑序最后）失败直接 return False。
                if src.lstrip().startswith('<'):
                    snippet = src.strip()[:80]
                    logger.warning(
                        'js module fetch is not JS (HTML), skip site: %s '
                        'content_head=%r', url, snippet)
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
                    logger.warning('js module eval failed: %s (%s)', url, e)
                    raise
            last = len(bundle.modules) - 1
            self.ctx.eval(f'globalThis.__MODULE_EXPORTS__ = globalThis.__MOD{last}__;')
            self._eval_file(LOADER_JS)
            return self.ctx.eval('typeof globalThis.__JS_SPIDER__') == 'object'

    # ------------------------------------------------------------ 调用

    def call(self, method, *args):
        """调用 spider 方法；返回原始字符串结果（通常 JSON 串），失败返回 None。"""
        if not self.lock.acquire(blocking=True, timeout=35):
            logger.warning('js call %s timeout waiting for lock', method)
            return None
        try:
            fn = self.ctx.get('__VPC_CALL__')
            args_json = json.dumps(list(args), ensure_ascii=False)
            try:
                ret = fn(method, args_json)
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
                    logger.warning('js %s error: %s', method, parsed['__vpc_err__'])
                    return None
            except ValueError:
                pass
            return ret
        finally:
            self.lock.release()

    def _drain_promise(self):
        """泵动微任务直到异步方法兑现（上限防死循环，30s 超时兜底）。"""
        deadline = time.time() + 30
        for _ in range(5000):
            if time.time() > deadline:
                break
            if not self.ctx.eval('!!globalThis.__VPC_PENDING__'):
                break
            if not self.ctx.execute_pending_job():
                break
        fn = self.ctx.get('__VPC_FETCH_RESULT__')
        return fn()
