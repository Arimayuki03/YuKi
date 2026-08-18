# -*- coding: utf-8 -*-
"""C2.2 `ext` 完整语义。

上游契约（`TV-fongmi/`，只作参考不修改）：

* `gson/ExtAdapter.java`：`ext` 无论写成字符串、数字、对象还是数组，反序列化后
  **一律是字符串**——primitive 取 `getAsString()`，object/array 取 `toString()`，
  其余取 `""`。所以 spider 拿到的永远是一个 String。
* `bean/Site.java::setExt`：`ext.trim()`。
* `bean/Site.java::fetchExt`：`if (!ext.startsWith("http")) return this;`
  取回文本，**仅当非空**才覆盖 ext；空响应保留原 URL。
* `api/SiteApi.java:73`：`fetchExt()` 只在 `type == 4` 的 `homeContent` 前调用一次；
  type=3 的 spider 通过 `BaseLoader.getSpider(key, api, ext, jar)` 拿到**原始** ext
  字符串（很多 JAR spider 自己去 fetch 这个 URL）。

因此本模块同时保留三个值：`canonical`（ExtAdapter 归一化后的字符串，type=3 契约）、
`origin`（原始/相对解析后的写法）、`expanded`（展开后的文本，type=4 契约）。运行时
按自己的契约选，宿主不替它决定——这正是任务书「保留原 URL 供运行时按契约选择」。

额外的宿主责任（上游没有，桌面端必须有）：体积上限、超时、编码识别、ETag 条件请求
与缓存、递归展开深度上限，以及**失败只影响该站点**。
"""
import json
import threading
import time
from dataclasses import dataclass, field

from .config_security import (
    ConfigSecurityError, ConfigSecurityPolicy, SourceTrust, decompress_capped,
    guard_url, read_capped)
from .errors import redact_sensitive

# ext 展开用的超时档：比配置拉取更短——单个站点的附属资源不该拖住整次加载。
EXT_TIMEOUT = (5, 10)


class ExtCancelled(Exception):
    """配置加载被取消；`ext` 展开必须立刻停止，不能继续占用 Worker 预算。"""


class ExtTimeout(TimeoutError):
    """ext 展开超过本站点预算。"""


def canonical_ext(value):
    """等价于 FongMi `ExtAdapter` + `setExt`：任何 JSON 值 → trim 过的字符串。"""
    if value is None:
        return ''
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, bool):
        return ('true' if value else 'false')
    if isinstance(value, (int, float)):
        # Gson 的 getAsString() 对整数不会补 .0
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        return str(value)
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':')).strip()
    return ''


def is_http_ext(text):
    """FongMi 用 `startsWith("http")` 判定是否需要展开，这里保持同一判据。"""
    return str(text or '').strip().lower().startswith(('http://', 'https://'))


def detect_text(raw, declared=''):
    """编码识别：BOM → 声明 charset → utf-8 → gbk → 替换兜底。

    解码后再去掉残留的前导 U+FEFF：BOM 会被重复写入（例如已带 BOM 的文件又被工具按
    utf-8-sig 重新编码一次），只剥一层字节 BOM 会让文本仍以 U+FEFF 开头，
    `json.loads` 随后报 "Expecting value: line 1 column 1"，看上去像配置写错了。
    utf-16 正文解码后同样可能留下 BOM 字符。
    """
    if not raw:
        return '', 'utf-8'
    if raw[:3] == b'\xef\xbb\xbf':
        return raw[3:].decode('utf-8', errors='replace').lstrip('﻿'), 'utf-8-sig'
    if raw[:2] in (b'\xff\xfe', b'\xfe\xff'):
        try:
            return raw.decode('utf-16').lstrip('﻿'), 'utf-16'
        except UnicodeDecodeError:
            pass
    order = []
    declared = str(declared or '').strip().lower()
    if declared and declared not in ('iso-8859-1',):
        order.append(declared)
    order.extend(['utf-8', 'gb18030'])
    for encoding in order:
        try:
            return raw.decode(encoding).lstrip('﻿'), encoding
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode('utf-8', errors='replace').lstrip('﻿'), 'utf-8/replace'


@dataclass
class ResolvedExt:
    """一个站点 ext 的完整解析结果。"""

    canonical: str = ''          # ExtAdapter 归一化字符串（type=3 契约取此值）
    origin: str = ''             # 原始写法（相对路径已按最终配置 URL 解析）
    url: str = ''                # origin 是 http(s) 时的原 URL，始终保留
    expanded: str = ''           # 展开后的文本（type=4 契约取此值）
    kind: str = 'empty'          # empty/text/json/url/object/array/number
    expanded_kind: str = ''      # json/text
    hops: list = field(default_factory=list)
    etag: str = ''
    last_modified: str = ''
    content_hash: str = ''
    size: int = 0
    encoding: str = ''
    elapsed_ms: int = 0
    from_cache: bool = False
    error: str = ''
    error_reason: str = ''

    @property
    def expanded_ok(self):
        return bool(self.expanded) and not self.error

    def for_runtime(self, runtime):
        """按运行时契约选择传给 spider 的 ext。

        - `js`（type=4）：与 FongMi `SiteApi` 一致，优先用展开后的文本；
        - 其余（python / jar / cms）：与 FongMi type=3 一致，拿原始字符串，
          spider 自己决定要不要去 fetch 那个 URL。
        """
        if runtime == 'js' and self.expanded_ok:
            return self.expanded
        return self.canonical

    def to_dict(self):
        payload = {
            'kind': self.kind,
            'origin': redact_sensitive(self.origin, 300),
            'url': redact_sensitive(self.url, 300),
            'expanded': bool(self.expanded_ok),
            'expandedKind': self.expanded_kind,
            'hops': [redact_sensitive(u, 200) for u in self.hops],
            'size': int(self.size),
            'encoding': self.encoding,
            'etag': self.etag,
            'lastModified': self.last_modified,
            'contentHash': self.content_hash[:16],
            'fromCache': bool(self.from_cache),
            'elapsedMs': int(self.elapsed_ms),
        }
        if self.error:
            payload['error'] = redact_sensitive(self.error, 240)
            payload['errorReason'] = self.error_reason
        return payload


class ExtCache:
    """按 URL 缓存 ext 文本 + 校验器，支持 ETag / Last-Modified 条件请求。"""

    def __init__(self, max_entries=256):
        self._entries = {}
        self._order = []
        self._lock = threading.Lock()
        self._max = int(max_entries)

    def get(self, url):
        with self._lock:
            return dict(self._entries.get(url) or {})

    def put(self, url, *, text, etag='', last_modified='', encoding='', digest=''):
        record = {'text': text, 'etag': etag, 'lastModified': last_modified,
                  'encoding': encoding, 'hash': digest, 'at': time.time()}
        with self._lock:
            if url not in self._entries:
                self._order.append(url)
            self._entries[url] = record
            while len(self._order) > self._max:
                stale = self._order.pop(0)
                self._entries.pop(stale, None)

    def clear(self):
        with self._lock:
            self._entries.clear()
            self._order.clear()

    def stats(self):
        with self._lock:
            return {'entries': len(self._entries)}


EXT_CACHE = ExtCache()


class ExtResolver:
    """一次配置加载内共享的 ext 解析器（共享缓存、策略、信任根与取消信号）。"""

    def __init__(self, *, policy=None, trust=None, cache=None, cancel_event=None,
                 session_get=None, timeout=EXT_TIMEOUT):
        self.policy = policy or ConfigSecurityPolicy()
        self.trust = trust or SourceTrust()
        self.cache = cache if cache is not None else EXT_CACHE
        self.cancel_event = cancel_event
        self.session_get = session_get
        self.timeout = timeout

    # -------------------------------------------------------------- 解析

    def resolve(self, value, base_url='', *, site_key='', expand=True, deadline=None):
        """归一化 + 相对路径解析 + 可选 HTTP 展开。

        失败只写进返回值的 `error`，不抛——`ext` 失败必须只影响该站点，不能让整个
        配置加载失败（C2.2 验收第三条）。取消是唯一的例外：取消要一路上抛。
        """
        result = ResolvedExt()
        started = time.monotonic()
        raw_origin = self._resolve_relative(value, base_url)
        result.origin = canonical_ext(raw_origin)
        result.canonical = result.origin
        result.kind = self._kind_of(raw_origin, result.origin)
        if is_http_ext(result.canonical):
            result.url = result.canonical
            result.kind = 'url'
        if not expand or not result.url:
            result.elapsed_ms = int((time.monotonic() - started) * 1000)
            return result
        try:
            self._expand(result, site_key=site_key, deadline=deadline)
        except ExtCancelled:
            raise
        except ExtTimeout as exc:
            result.error, result.error_reason = str(exc), 'timeout'
        except ConfigSecurityError as exc:
            result.error, result.error_reason = str(exc), exc.reason
        except Exception as exc:                     # noqa: BLE001 - 单站点隔离
            result.error, result.error_reason = str(exc), 'fetch_failed'
        result.elapsed_ms = int((time.monotonic() - started) * 1000)
        return result

    # -------------------------------------------------------------- 内部

    def _resolve_relative(self, value, base_url):
        """对 str 解相对路径；dict/list 递归解内部字符串后再归一化。

        对象/数组形态的 ext 常见于 `{"site":"./lib/x.json"}`，内部相对路径同样要
        按最终配置 URL 解析，否则 spider 拿到的是无法请求的 `./...`。
        """
        from urllib.parse import urljoin
        if isinstance(value, dict):
            return {k: self._resolve_relative(v, base_url) for k, v in value.items()}
        if isinstance(value, list):
            return [self._resolve_relative(v, base_url) for v in value]
        if isinstance(value, str):
            text = value.strip()
            if (text.startswith('./') or text.startswith('../')) and base_url:
                return urljoin(base_url, text)
            return text
        return value

    @staticmethod
    def _kind_of(raw, canonical):
        if isinstance(raw, dict):
            return 'object'
        if isinstance(raw, list):
            return 'array'
        if isinstance(raw, bool) or isinstance(raw, (int, float)):
            return 'number'
        if not canonical:
            return 'empty'
        head = canonical.lstrip()[:1]
        if head in ('{', '['):
            return 'json'
        return 'text'

    def _check_cancelled(self):
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise ExtCancelled('配置加载已取消，停止展开 ext')

    def _expand(self, result, *, site_key='', deadline=None):
        """按 FongMi fetchExt 语义展开，附加深度上限与循环检测。"""
        seen = set()
        current = result.url
        max_depth = max(1, int(self.policy.max_ext_depth))
        for hop in range(max_depth + 1):
            self._check_cancelled()
            if deadline is not None and time.monotonic() > deadline:
                raise ExtTimeout('ext 展开超出本次配置加载预算')
            if current in seen:
                result.error = 'ext 展开出现循环引用，已停止'
                result.error_reason = 'recursion_cycle'
                return
            if hop >= max_depth:
                result.error = 'ext 展开层数超过 %d 层上限，已停止' % max_depth
                result.error_reason = 'recursion_limit'
                return
            seen.add(current)
            result.hops.append(current)
            text, meta = self._fetch(current, site_key=site_key, deadline=deadline)
            # FongMi：空响应保留原 URL，不覆盖 ext。
            if not text or not text.strip():
                result.error = result.error or 'ext 地址返回空内容，保留原 URL'
                result.error_reason = result.error_reason or 'empty_response'
                return
            result.etag = meta.get('etag') or result.etag
            result.last_modified = meta.get('lastModified') or result.last_modified
            result.encoding = meta.get('encoding') or result.encoding
            result.content_hash = meta.get('hash') or result.content_hash
            result.size = int(meta.get('size') or 0) or result.size
            result.from_cache = bool(meta.get('fromCache'))
            stripped = text.strip()
            if is_http_ext(stripped) and '\n' not in stripped and len(stripped) < 2048:
                # 展开结果又是一个 URL：继续一跳，但受深度上限约束。
                current = guard_url(stripped, policy=self.policy, trust=self.trust,
                                    kind='ext', site_key=site_key)
                continue
            result.expanded = stripped
            result.expanded_kind = 'json' if stripped[:1] in ('{', '[') else 'text'
            return

    def _fetch(self, url, *, site_key='', deadline=None):
        """带 ETag / Last-Modified 条件请求与体积上限的单次取回。"""
        from http_client import get as http_get

        getter = self.session_get or http_get
        safe = guard_url(url, policy=self.policy, trust=self.trust, kind='ext',
                         site_key=site_key)
        cached = self.cache.get(safe)
        headers = {}
        if cached.get('etag'):
            headers['If-None-Match'] = cached['etag']
        if cached.get('lastModified'):
            headers['If-Modified-Since'] = cached['lastModified']
        timeout = self.timeout
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ExtTimeout('ext 展开超出本次配置加载预算')
            timeout = (min(self.timeout[0], max(0.5, remaining)),
                       min(self.timeout[1], max(0.5, remaining)))
        response = getter(safe, timeout=timeout, headers=headers,
                          allow_redirects=False, stream=True)
        if response is None:
            raise ValueError('ext 地址无响应')
        status = int(getattr(response, 'status_code', 0) or 0)
        head = {k.lower(): v for k, v in dict(getattr(response, 'headers', {}) or {}).items()}
        if status == 304 and cached.get('text'):
            try:
                response.close()
            except Exception:
                pass
            return cached['text'], {
                'etag': cached.get('etag', ''), 'lastModified': cached.get('lastModified', ''),
                'encoding': cached.get('encoding', ''), 'hash': cached.get('hash', ''),
                'size': len(cached['text'].encode('utf-8', errors='replace')),
                'fromCache': True,
            }
        if status in (301, 302, 303, 307, 308) and head.get('location'):
            from urllib.parse import urljoin
            try:
                response.close()
            except Exception:
                pass
            target = guard_url(urljoin(safe, head['location']), policy=self.policy,
                               trust=self.trust, kind='ext', site_key=site_key)
            return self._fetch(target, site_key=site_key, deadline=deadline)
        if status >= 400:
            try:
                response.close()
            except Exception:
                pass
            raise ValueError('ext 地址返回 HTTP %d' % status)
        raw = read_capped(response, self.policy.max_ext_bytes, kind='ext')
        raw, _ = decompress_capped(raw, self.policy.max_ext_bytes, kind='ext')
        declared = ''
        ctype = str(head.get('content-type') or '')
        if 'charset=' in ctype.lower():
            declared = ctype.lower().split('charset=', 1)[1].split(';')[0].strip()
        text, encoding = detect_text(raw, declared)
        from .config_snapshot import content_hash
        digest = content_hash(raw)
        etag = str(head.get('etag') or '')
        last_modified = str(head.get('last-modified') or '')
        if text.strip():
            self.cache.put(safe, text=text, etag=etag, last_modified=last_modified,
                           encoding=encoding, digest=digest)
        return text, {'etag': etag, 'lastModified': last_modified, 'encoding': encoding,
                      'hash': digest, 'size': len(raw), 'fromCache': False}
