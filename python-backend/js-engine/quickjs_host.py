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
import gzip
import os
import sys
import json
import time
import zlib
import hashlib
import logging
import tempfile
import threading
import re

import http_client
import hoststate
import urllib.parse
from urllib.parse import quote

import quickjs

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)

from esm_transform import esm_to_script  # noqa: E402
from module_resolver import ModuleBundle, binding_statements  # noqa: E402
logger = logging.getLogger('yuki.jsengine')


class JsEngineUnavailableError(ValueError):
    """QuickJS 宿主安全前提不满足（限额 API 缺失/设置失败等）。

    继承 ValueError：上层装载入口（config 的 js 站点装配 / site_worker._build）
    按 except Exception 捕获后把站点记为构建失败（skipped）或回 ready
    ok=False——站点呈现为「不可用」而不是静默跑无限额的远端代码，也不会
    崩溃后端。
    """


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
        # 原子写：先写临时文件再 os.replace。原实现直接覆写 js_local.json，
        # 进程崩溃/断电可留下半截 JSON——之后 load 永远失败、KV 被静默清空。
        # os.replace 在 Windows/POSIX 上都原子替换，读侧要么旧文件要么新文件。
        payload = json.dumps(data, ensure_ascii=False)
        fd, tmp = tempfile.mkstemp(prefix='.js_local-', suffix='.tmp', dir=LOCAL_KV_DIR)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            for i in range(4):
                try:
                    os.replace(tmp, LOCAL_KV_FILE)
                    break
                except PermissionError:
                    # Windows：目标被并发读/替换时短暂拒绝，短退避重试
                    #（对齐 cache_store.set 的写法）
                    if i == 3:
                        raise
                    time.sleep(0.05)
        finally:
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass
    except Exception as e:
        logger.warning('local kv save failed: %s', e)


# ---- C2/M-24/N3.2：JS local KV 按站点隔离 + 单站点配额 ----
KV_SCOPE_SEP = '\u0002'
KV_MAX_VALUE_BYTES = 64 * 1024         # 单值上限 (64KB)
KV_MAX_SITE_BYTES = 256 * 1024         # 单站点上限 (256KB)
KV_MAX_TOTAL_BYTES = 2 * 1024 * 1024   # 全文件上限 (2MB)


def _kv_scoped(site_key, key):
    return (site_key + KV_SCOPE_SEP + key) if site_key else key


def _native_local_get(site_key=''):
    def fn(key):
        with _local_kv_lock:
            data = _local_kv_load()
            v = data.get(_kv_scoped(site_key, key))
            if v is None and site_key:
                v = data.get(key)   # 迁移前旧数据兼容兜底
            return v if isinstance(v, str) else ''
    return fn


def _native_local_set(site_key=''):
    def fn(key, value):
        value = str(value)
        val_bytes = len(value.encode('utf-8'))
        if val_bytes > KV_MAX_VALUE_BYTES:
            logger.warning('[js] local.set skipped: value %dKB > %dKB (site=%s key=%.60s)',
                           val_bytes // 1024, KV_MAX_VALUE_BYTES // 1024, site_key, key)
            return None
        with _local_kv_lock:
            data = _local_kv_load()
            sk = _kv_scoped(site_key, key)

            # 计算该 site_key 当前占用的总字节数
            site_prefix = site_key + KV_SCOPE_SEP if site_key else ''
            current_site_bytes = sum(
                len(k.encode('utf-8')) + len(str(v).encode('utf-8'))
                for k, v in data.items()
                if site_prefix and k.startswith(site_prefix) and k != sk
            ) + len(sk.encode('utf-8')) + val_bytes

            if site_key and current_site_bytes > KV_MAX_SITE_BYTES:
                logger.warning('[js] local.set skipped: site %s total %dKB > %dKB',
                               site_key, current_site_bytes // 1024, KV_MAX_SITE_BYTES // 1024)
                return None

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


GLOBAL_SUGGESTIONS = {
    'rule': '此 JS 依赖 drpy 规则解析器 (rule)，需使用 drpy 引擎 (type=3) 或补充 drpy 运行环境',
    'pdfh': '此 JS 依赖 drpy HTML 解析辅助函数 (pdfh)，需使用 drpy 引擎或补充 drpy 运行环境',
    'pd': '此 JS 依赖 drpy HTML 属性/节点提取函数 (pd)，需使用 drpy 引擎或补充 drpy 运行环境',
    'pdfa': '此 JS 依赖 drpy 节点列表解析函数 (pdfa)，需使用 drpy 引擎或补充 drpy 运行环境',
    'mobaRule': '此 JS 依赖 mobaRule 模板规则，请使用 drpy 引擎',
    'fetch': '当前 QuickJS 环境提供的是 TVBox 标准 http/req 接口，请使用 http/req 代替 fetch',
    'axios': '当前 QuickJS 环境提供的是 TVBox 标准 http/req 接口，请使用 http/req 代替 axios',
    'document': '当前宿主为非浏览器 QuickJS 环境，请使用 cheerio 进行 DOM/HTML 解析',
    'window': '当前宿主为非浏览器 QuickJS 环境',
    'navigator': '当前宿主为非浏览器 QuickJS 环境',
    'process': '当前宿主为纯 JS 沙箱环境，禁止访问 Node 进程对象',
}


# ---- _native_http 安全边界（N3.2/S1.1 之外的宿主级限额） ----
# 与 http_client 的超时档位保持一致（TIMEOUT_FAST~TIMEOUT_SLOW = 5s~60s 连接段）：
# JS 源传 0/负数/超大值一律收敛到边界，防止远端代码用超大 timeout 长占连接。
HTTP_TIMEOUT_MIN = 1.0
HTTP_TIMEOUT_MAX = 60.0
HTTP_TIMEOUT_DEFAULT = 10.0
# 响应体上限：与 config_security.MAX_DECOMPRESSED_BYTES 同档（32MB），
# 流式读取，超限立即断开——远端代码不允许把宿主内存读爆。
HTTP_MAX_RESPONSE_BYTES = 32 * 1024 * 1024
_HTTP_CHUNK_SIZE = 64 * 1024


def _clamp_timeout(value):
    """timeout clamp 到 [HTTP_TIMEOUT_MIN, HTTP_TIMEOUT_MAX]；非法值取默认。"""
    try:
        if isinstance(value, bool) or value is None:
            raise ValueError('invalid timeout')
        value = float(value)
        if value != value:   # NaN
            raise ValueError('invalid timeout')
    except (TypeError, ValueError):
        return HTTP_TIMEOUT_DEFAULT
    return min(max(value, HTTP_TIMEOUT_MIN), HTTP_TIMEOUT_MAX)


def _sniff_or_latin1(raw_bytes):
    """无 charset 兜底：charset_normalizer 嗅探只对足够长的载荷可靠——
    过短样本误判率高（如 5 字节 latin-1 'caf\\xe9' 会被认成 utf_16_be），
    不足 64 字节时退回 latin-1（requests 对 text/* 的缺省编码，可无损还原）。
    """
    if len(raw_bytes) >= 64:
        try:
            import charset_normalizer
            best = charset_normalizer.from_bytes(raw_bytes).best()
            if best is not None:
                return str(best)
        except Exception:
            pass
    return raw_bytes.decode('latin-1', errors='replace')


def _decode_body(raw_bytes, headers):
    """按 Content-Encoding 解 gzip/deflate，再按响应头/嗅探编码转文本。

    http_client 基于 requests/urllib3，iter_content 已对 gzip/deflate 透明解压；
    这里按头再解一次属于兜底逻辑（未来若换成返回原始压缩字节的客户端仍可用），
    因此必须防御式：任何解压失败都按「已是明文」原样返回，绝不让 zlib.error
    冒泡成 500。文本解码顺序：显式 charset → text/* 缺省走 utf-8 →
    charset_normalizer 嗅探（仅长载荷，见 _sniff_or_latin1）→ latin-1，
    全程宽松替换，保证 JS 侧总能拿到字符串。
    """
    headers = headers or {}
    encoding = str(headers.get('Content-Encoding')
                   or headers.get('content-encoding') or '').lower().strip()
    try:
        if encoding in ('gzip', 'x-gzip') and raw_bytes[:2] == b'\x1f\x8b':
            raw_bytes = gzip.decompress(raw_bytes)
        elif encoding == 'deflate':
            # zlib 容器与 raw deflate 都可能；两层都失败则视为明文
            # （urllib3 已透明解压时走到这里的就是明文，绝不能抛 zlib.error）
            try:
                raw_bytes = zlib.decompress(raw_bytes)
            except zlib.error:
                try:
                    raw_bytes = zlib.decompress(raw_bytes, -zlib.MAX_WBITS)
                except zlib.error:
                    pass
    except Exception:
        pass   # 兜底解压失败：按「iter_content 已解压的明文」原样返回
    content_type = str(headers.get('Content-Type')
                       or headers.get('content-type') or '')
    match = re.search(r'charset=([\w\-]+)', content_type, re.IGNORECASE)
    if match:
        try:
            return raw_bytes.decode(match.group(1), errors='replace')
        except LookupError:
            pass
    if content_type.strip().lower().startswith('text/'):
        try:
            return raw_bytes.decode('utf-8')
        except UnicodeDecodeError:
            return _sniff_or_latin1(raw_bytes)
    try:
        return raw_bytes.decode('utf-8')
    except UnicodeDecodeError:
        return _sniff_or_latin1(raw_bytes)


def _read_body_capped(response, url):
    """流式读响应体，超过 HTTP_MAX_RESPONSE_BYTES 立即中止。"""
    chunks, total = [], 0
    try:
        for chunk in response.iter_content(_HTTP_CHUNK_SIZE):
            if not chunk:
                continue
            total += len(chunk)
            if total > HTTP_MAX_RESPONSE_BYTES:
                raise ValueError(
                    f'js http response too large: body exceeds '
                    f'{HTTP_MAX_RESPONSE_BYTES // (1024 * 1024)}MB limit ({url})')
            chunks.append(chunk)
    finally:
        try:
            response.close()
        except Exception:
            pass
    return b''.join(chunks)


# P2-11：重定向跟随上限。JS 源请求与 ？url=/jar 下载同档（5 跳）。
_NATIVE_HTTP_MAX_REDIRECTS = 5

_REDIRECT_STATUSES = (301, 302, 303, 307, 308)


def _native_http(url, options_json):
    """同步 HTTP，返回 JSON 串：{ok, status, code, content, headers}。"""
    try:
        opt = json.loads(options_json) if options_json else {}
    except (TypeError, ValueError):
        opt = {}
    method = str(opt.get('method') or 'GET').upper()
    headers = opt.get('headers') or {}
    timeout = _clamp_timeout(opt.get('timeout'))
    allow_redirects = opt.get('redirect', True)

    def _blocked(payload_url, exc):
        # P2-11：SSRF 守卫拒绝（首跳或重定向任一跳）。JS 源是不可信代码，
        # 响应结构与正常失败一致，不向沙箱内回显内部错误细节。
        logger.warning('js req blocked by security policy: %s (%s)', payload_url, exc)
        return json.dumps({'ok': False, 'status': 403, 'code': 403,
                           'content': 'blocked by host security policy',
                           'headers': {}, 'url': payload_url})

    # N3.2 / S1.1: 继承宿主安全策略（SSRF 守卫与私网防护）。
    # P2-11：守卫逻辑收编到 http_client._guard_hop（与 CMS/jar 下载同一套
    # 逐跳复检机制），首跳守卫改经它执行——策略每跳从环境变量重建，
    # trust_root 留空 = 无受信 origin（JS 源没有「用户显式信任根」语义）。
    try:
        current = http_client._guard_hop(url, kind='site')
    except Exception as e:
        return _blocked(url, e)

    try:
        if allow_redirects:
            # P2-11：requests 的 allow_redirects=True 会在库内静默跟随 302，
            # 首跳过守卫也拦不住「公网源 302 → 内网」。改为手动逐跳跟随，
            # 每一跳都过 _guard_hop（trust_redirect=True：跳转目标是远端
            # 响应派生的地址，不继承任何信任根）。对齐 go_proxy._fetch /
            # http_client.fetch_follow_redirects / jar_bridge.requests_get_jar。
            for _ in range(_NATIVE_HTTP_MAX_REDIRECTS + 1):
                kwargs = dict(headers=headers, timeout=timeout,
                              allow_redirects=False, verify=True, stream=True)
                if method == 'POST':
                    kwargs['data'] = opt.get('body') or opt.get('data')
                    rsp = http_client.post(current, **kwargs)
                else:
                    rsp = http_client.get(current, **kwargs)
                if rsp.status_code not in _REDIRECT_STATUSES \
                        or 'Location' not in rsp.headers:
                    break
                location = rsp.headers.get('Location') or ''
                rsp.close()   # 3xx body 从不读取，取完 Location 立刻还连接
                try:
                    current = http_client._guard_hop(
                        urllib.parse.urljoin(current, location), kind='site',
                        trust_redirect=True)
                except Exception as e:
                    return _blocked(current, e)
            else:
                raise ValueError(f'too many redirects (>{_NATIVE_HTTP_MAX_REDIRECTS}): {url}')
        else:
            kwargs = dict(headers=headers, timeout=timeout,
                          allow_redirects=False, verify=True, stream=True)
            if method == 'POST':
                kwargs['data'] = opt.get('body') or opt.get('data')
                rsp = http_client.post(current, **kwargs)
            else:
                rsp = http_client.get(current, **kwargs)
        raw = _read_body_capped(rsp, current)
        text = _decode_body(raw, rsp.headers)
        return json.dumps({
            'ok': rsp.status_code < 400,
            'status': rsp.status_code,
            'code': rsp.status_code,
            'content': text,
            'data': text,
            'headers': dict(rsp.headers),
        }, ensure_ascii=False)
    except Exception as e:
        logger.warning('js req failed: %s %s', current, e)
        return json.dumps({'ok': False, 'status': 500, 'code': 500,
                           'content': '', 'headers': {}, 'url': current})


class JsEngine:
    """单个 JS spider 的运行环境（Context + 宿主 API）。"""

    def __init__(self, site_key=''):
        self.lock = threading.RLock()
        self.ctx = quickjs.Context()
        # H-3：远程 JS 源不可信——C 扩展同步 eval 期间不释放 GIL，一段
        # while(true){} 会冻结整个后端（所有端点、所有站点）。三重限额：
        # CPU 30s / 内存 256MB / 栈 1MB。限额是运行不可信远端代码的安全前提：
        # API 缺失或设置失败都必须 fail-closed（拒绝加载该站点），绝不静默降级。
        self._apply_runtime_limits()
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

    def _apply_runtime_limits(self):
        """应用 CPU/内存/栈三重限额；不可用即 fail-closed。

        两种情形都拒绝运行远端 JS：
        - API 完全缺失（AttributeError）：当前 quickjs-ng 构建不带限额能力；
        - API 存在但设置失败（其他异常）：限额可能未生效，同样是 fail-open 风险。
        抛 JsEngineUnavailableError 让上层把站点标记为不可用，而不是告警后
        继续跑一段可 while(true){} 冻结整个后端的远端代码。
        """
        limits = (
            ('set_time_limit', 30),
            ('set_memory_limit', 256 * 1024 * 1024),
            ('set_max_stack_size', 1024 * 1024),
        )
        for name, value in limits:
            fn = getattr(self.ctx, name, None)
            if fn is None or not callable(fn):
                raise JsEngineUnavailableError(
                    f'quickjs-ng 缺少限额 API {name}，无法安全运行 JS 站点源 '
                    f'（站点不可用；请升级 quickjs-ng）')
            try:
                fn(value)
            except Exception as e:
                raise JsEngineUnavailableError(
                    f'quickjs-ng 限额 API {name}({value}) 设置失败：{e}'
                    f'（站点不可用，拒绝在无限额状态下运行远端 JS）') from e

    def _log(self, level, msg):
        getattr(logger, level if level in ('info', 'warn', 'error', 'debug') else 'info')(
            '[js] %s', msg)

    @staticmethod
    def _warn_missing_global(error, source=''):
        """把 QuickJS 深埋的 ReferenceError 转成可检索的宿主诊断与操作建议。"""
        text = str(error or '')
        match = re.search(r"(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*) is not defined", text)
        if not match:
            return
        name = match.group(1)
        suffix = f' ({source})' if source else ''
        suggestion = GLOBAL_SUGGESTIONS.get(name, '')
        if suggestion:
            logger.warning('该 JS 源需要宿主未提供的全局 <%s>%s。建议：%s', name, suffix, suggestion)
        else:
            logger.warning('该 JS 源需要宿主未提供的全局 <%s>%s', name, suffix)

    def _js2proxy(self, site_key, flag):
        """TVBox js2Proxy 桥：生成后端 /proxy 媒体代理 URL（query 透传给 localProxy）。"""
        port = self.proxy_port or 0
        encoded_site = quote(str(site_key), safe='')
        encoded_flag = quote(str(flag), safe='')
        # /proxy 已强制 token（R 组）：地址由播放器直接消费，必须自带有效
        # token。宿主 token 已注入本进程 hoststate（site_worker spec 注入），
        # 未配置（仅测试）时不补。
        try:
            import hoststate
            token = str(hoststate.get_token() or '')
        except Exception:
            token = ''
        token_part = f'&token={quote(token, safe="")}' if token else ''
        return (f'http://127.0.0.1:{port}/proxy?do=js&siteKey={encoded_site}'
                f'&flag={encoded_flag}{token_part}')

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

    def _reset_spider_globals(self):
        """清除上一轮 spider 加载残留（load_spider / load_spider_url 共用）。

        spider-loader.js 以 `if (!globalThis.__JS_SPIDER__)` 守卫，站点重载/换源
        重复加载时旧 spider 残留会让新 spider 永不生效；旧 __MODULE_EXPORTS__ /
        __MODn__ 命名空间（含其上的 __fixups__ 数组）同理必须一并清掉，避免
        指向已删除命名空间的残留语句在新一轮里误触发。全部以 configurable:true
        定义，可 delete。
        """
        self.ctx.eval(
            '(function(){'
            'try { delete globalThis.__JS_SPIDER__; } catch (e) {}'
            'try { delete globalThis.__MODULE_EXPORTS__; } catch (e) {}'
            'Object.getOwnPropertyNames(globalThis).forEach(function (k) {'
            '  if (/^__MOD\\d+__$/.test(k)) { try { delete globalThis[k]; } catch (e) {} }'
            '});'
            '})();')

    def _drain_import_fixups(self, mod_count):
        """回填循环依赖（回边）的 import 绑定（详见 module_resolver.binding_statements）。

        回边绑定生成 `var alias;` + 补赋闭包挂到 __MODi__.__fixups__。每轮
        模块 eval 完成后统一执行：此时全部命名空间已填充，回填结果与 ESM
        调用期 live binding 对齐。函数引用的命名空间全局存在（预建空对象），
        重复执行幂等；加载失败残留的 fixups 随 __MODn__ 在下一轮重置时清除。
        """
        if mod_count <= 0:
            return
        self.ctx.eval(
            '(function(){for(var i=0;i<' + str(mod_count) + ';i++){'
            'var ns=globalThis["__MOD"+i+"__"];'
            'if(ns&&ns.__fixups__){for(var j=0;j<ns.__fixups__.length;j++){'
            'try{ns.__fixups__[j]();}catch(e){}}}}})();')

    def load_spider(self, src):
        """加载 spider 源码（ESM），执行 spider.js 协议；返回是否成功。"""
        with self.lock:
            try:
                # 重复加载（站点重载/换源）前重置，否则旧 spider 残留、新 spider 永不生效
                self._reset_spider_globals()
                self.ctx.eval(esm_to_script(src, ns='__MODULE_EXPORTS__'))
                self._eval_file(LOADER_JS)
                return self.ctx.eval('typeof globalThis.__JS_SPIDER__') == 'object'
            except Exception as e:
                self._warn_missing_global(e, '加载')
                raise

    def load_spider_url(self, entry_url, fetch_text):
        """加载多模块 ESM spider：递归抓取依赖，逐模块 IIFE 隔离执行。

        每个模块顶层声明封闭在各自 IIFE 内避免同名冲突，exports 收集到
        独立命名空间 __MODn__。import 绑定按依赖拓扑序分两类（见
        module_resolver.binding_statements）：前向边（依赖拓扑序在前）在
        IIFE 内 var 快照；回边（循环依赖）var 声明 + 延迟回填（__fixups__，
        全部模块 eval 完成后由 _drain_import_fixups 统一执行，调用期解析
        对齐 ESM live binding）。re-export 以 dep_map（原始说明符 → 依赖
        命名空间）转发。
        """
        bundle = ModuleBundle().build(entry_url, fetch_text)
        self.init_protocol = 'fongmi'
        with self.lock:
            # 重复加载（站点重载/换源）前重置，否则旧 spider 残留、新 spider 永不生效
            self._reset_spider_globals()
            # 预建全部命名空间为空对象：回边补赋闭包与 re-export 转发按
            # __MODn__ 名引用依赖命名空间，若首个模块的 preamble 先于依赖
            # 命名空间创建执行会 ReferenceError（循环依赖下顺序不可保证）。
            for i in range(len(bundle.modules)):
                self.ctx.eval(f'globalThis.__MOD{i}__ = globalThis.__MOD{i}__ || {{}};')
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
                dep_map = {}
                for clause, dep_url, spec in bundle.imports.get(url, []):
                    dep_idx = bundle.index.get(dep_url)
                    if dep_idx is None:
                        continue
                    dep_ns = f'__MOD{dep_idx}__'
                    dep_map[spec] = dep_ns
                    # 真回边（DFS 截断标记）：var 声明 + 延迟回填；
                    # 前向边：IIFE 内 var 快照（见 binding_statements）
                    is_back = (url, dep_url) in bundle.back_edges
                    preamble.extend(binding_statements(clause, dep_ns,
                                                       mod_idx=i, back_edge=is_back))
                body = esm_to_script(src, ns=ns, dep_map=dep_map)
                script = f'(function(){{\n' + '\n'.join(preamble) + '\n' + body + f'\n}})();\n//# sourceURL={url}'
                try:
                    self.ctx.eval(script)
                except Exception as e:
                    self._warn_missing_global(e, url)
                    logger.warning('js module eval failed: %s (%s)', url, e)
                    raise
            # 回填循环依赖的 import 绑定（回边 var 此刻才取到依赖导出值）
            self._drain_import_fixups(len(bundle.modules))
            last = len(bundle.modules) - 1
            self.ctx.eval(f'globalThis.__MODULE_EXPORTS__ = globalThis.__MOD{last}__;')
            self._eval_file(LOADER_JS)
            return self.ctx.eval('typeof globalThis.__JS_SPIDER__') == 'object'

    # ------------------------------------------------------------ 调用

    def destroy(self):
        """显式释放上下文与资源。"""
        with self.lock:
            try:
                self.call('destroy')
            except Exception:
                pass
            self.ctx = None

    def call(self, method, *args):
        """调用 spider 方法；返回原始字符串结果（通常 JSON 串），失败返回 None。"""
        if self.ctx is None:
            return None
        if not self.lock.acquire(blocking=True, timeout=35):
            logger.warning('js call %s timeout waiting for lock', method)
            return None
        try:
            fn = self.ctx.get('__YUKI_CALL__')
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
                if isinstance(parsed, dict) and '__yuki_err__' in parsed:
                    self._warn_missing_global(parsed['__yuki_err__'], method)
                    logger.warning('js %s error: %s', method, parsed['__yuki_err__'])
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
            if not self.ctx.eval('!!globalThis.__YUKI_PENDING__'):
                break
            if not self.ctx.execute_pending_job():
                break
        fn = self.ctx.get('__YUKI_FETCH_RESULT__')
        return fn()
