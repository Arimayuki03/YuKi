# -*- coding: utf-8 -*-
"""FongMi localProxy 数据面契约。

普通 Spider 方法通过 JSON 返回短结果；``proxy()`` 是例外，它返回的是
HTTP 状态、Content-Type、可选响应头和一个可能很大的流。这个模块把现有
Python/JS/JAR 适配层返回的多种形态归一为 ``ProxyResult``，供 FastAPI
StreamingResponse 和后续 JVM 二进制桥共同使用。

本模块不负责选择哪个 Spider，也不负责网盘 URL 解析；它只处理代理请求
参数合并、代理结果归一化和流式 body 生命周期。
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from typing import Any, Callable, Iterator, Mapping
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


# HTTP/1.1 hop-by-hop 头不能从上游直接转发给 ASGI 客户端。
_HOP_BY_HOP = {
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
}

# 这些头是请求凭据或宿主内部信息，不能从 Spider 的响应头回送给浏览器/
# mpv。请求侧仍会把 Cookie/Authorization 传入 Spider；这里只限制响应侧。
_SENSITIVE_RESPONSE_HEADERS = {
    'authorization',
    'cookie',
    'proxy-authorization',
    'set-cookie',
}

_REQUEST_HEADER_ALIASES = {
    'accept-ranges', 'authorization', 'content-length', 'content-range',
    'content-type', 'cookie', 'if-modified-since', 'if-none-match',
    'location', 'range', 'referer', 'user-agent',
}


@dataclass
class ProxyResult:
    """归一化的代理响应。

    ``body`` 可以是 bytes/str、小型 JSON，也可以是 file-like 或 iterator。
    对流式 body 不应提前读取；``close`` 用于请求结束或客户端断开时释放
    上游连接。
    """

    status: int = 200
    mime: str = 'application/octet-stream'
    body: Any = b''
    headers: dict[str, str] = field(default_factory=dict)
    close: Callable[[], Any] | None = None


def merge_request_params(
    query: Mapping[str, Any] | None = None,
    headers: Mapping[str, Any] | None = None,
    form: Mapping[str, Any] | None = None,
    body: Any = None,
) -> dict[str, Any]:
    """合并 FongMi ``/proxy`` 请求参数。

    FongMi 的 NanoHTTPD 会把 query、请求头、POST 参数合并后交给 Spider。
    query/form 优先，避免请求头中的同名字段覆盖代理 URL 参数；请求头键
    统一为小写，便于 Python/JS Spider 处理 ``range``、``cookie`` 等字段。
    原始 body 只在调用方明确传入时放入 ``_body``，不强行解码二进制媒体。
    """

    out: dict[str, Any] = {}

    def put(key: Any, value: Any, *, control: bool = False) -> None:
        if key is None or value is None:
            return
        name = str(key)
        # HTTP header 名大小写不应改变 Spider 看到的参数；业务控制参数
        # （siteKey、fileId 等）保留原始拼写，同时补常用小写别名由调用方
        # 自行消费。这样不会破坏旧 JS Spider 依赖的驼峰字段。
        lowered = name.lower()
        if lowered in _REQUEST_HEADER_ALIASES:
            name = lowered
        if control or name not in out:
            out[name] = value

    for source in (query or {}, form or {}):
        for key, value in source.items():
            put(key, value, control=True)
    for key, value in (headers or {}).items():
        # Query/form 是 Spider 自己构造的控制参数，应当优先。
        put(key, value)
    if body not in (None, b'', ''):
        out.setdefault('_body', body)
    return out


def proxy_token_values(
    query: Mapping[str, Any] | None = None,
    headers: Mapping[str, Any] | None = None,
    form: Mapping[str, Any] | None = None,
) -> list[Any]:
    """收集代理请求中主动携带的 token 值。

    旧 FongMi 地址允许完全不带 token；但 query、POST body 和专用请求头
    一旦出现 token，就应该由所有 HTTP 入口执行一致校验。这里仅收集值，
    不依赖 hoststate，方便 FastAPI 与旧端口共享这条契约。
    """
    values: list[Any] = []
    for source in (query or {}, form or {}):
        for key, value in source.items():
            if str(key).lower() == 'token':
                values.append(value)
    for key, value in (headers or {}).items():
        if str(key).lower() in ('x-proxy-token', 'proxy-token'):
            values.append(value)
    return values


def decode_proxy_body(body: bytes | str | None, content_type: str = '') -> tuple[dict[str, Any], Any]:
    """解码 ``/proxy`` 的 POST body。

    FongMi 的 POST 代理参数通常是 ``application/x-www-form-urlencoded``，
    但也有 Python/JS Spider 直接提交 JSON 或二进制 body。返回 ``(fields,
    raw_body)``：已识别的字段进入 fields，无法安全解码的主体保留给
    ``merge_request_params`` 的 ``_body``，不把媒体字节误当成文本。
    """
    if body in (None, b'', ''):
        return {}, None
    raw = body.encode('utf-8') if isinstance(body, str) else bytes(body)
    ctype = str(content_type or '').split(';', 1)[0].strip().lower()
    if ctype == 'application/x-www-form-urlencoded':
        try:
            pairs = parse_qsl(raw.decode('utf-8'), keep_blank_values=True)
            return {k: v for k, v in pairs}, None
        except (UnicodeDecodeError, ValueError):
            return {}, raw
    if ctype == 'application/json':
        try:
            value = json.loads(raw.decode('utf-8'))
            return (value if isinstance(value, dict) else {}), None if isinstance(value, dict) else raw
        except (UnicodeDecodeError, ValueError, TypeError):
            return {}, raw
    return {}, raw


def _clean_headers(headers: Mapping[str, Any] | None) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, value in (headers or {}).items():
        if key is None or value is None:
            continue
        name = str(key)
        lowered = name.lower()
        if lowered in _HOP_BY_HOP or lowered in _SENSITIVE_RESPONSE_HEADERS:
            continue
        # 多值 header 在代理契约中统一成逗号分隔字符串；FastAPI/requests
        # 的 HeaderMapping 也能安全接收普通字符串。
        if isinstance(value, (list, tuple)):
            value = ', '.join(str(v) for v in value)
        result[name] = str(value)
    return result


def _response_to_result(response: Any) -> ProxyResult | None:
    """把 requests.Response 变成流式 ProxyResult；不是 Response 则返回 None。"""

    if not all(hasattr(response, attr) for attr in ('status_code', 'headers')):
        return None
    raw = getattr(response, 'raw', None)
    # requests.Response 在 stream=False 时会把 raw 消费到 content；这时再
    # 读取 raw 只得到空流。仅对尚未消费的 raw 使用流式路径，兼容旧 Spider
    # 返回普通 Response 的小响应。
    consumed = getattr(response, '_content_consumed', False)
    body = raw if raw is not None and not consumed else getattr(response, 'content', b'')
    headers = _clean_headers(getattr(response, 'headers', None))
    mime = headers.get('Content-Type', 'application/octet-stream')
    close = getattr(response, 'close', None)
    return ProxyResult(int(getattr(response, 'status_code', 200)), mime, body, headers, close)


def _is_stream_body(body: Any) -> bool:
    if body is None or isinstance(body, (bytes, bytearray, memoryview, str)):
        return False
    if isinstance(body, (dict, list, tuple, set)):
        # list/tuple 在代理返回值里通常是数据结构，不默认当作 chunk 迭代器。
        return False
    return callable(getattr(body, 'read', None)) or callable(getattr(body, '__iter__', None))


def normalize_proxy_result(result: Any) -> ProxyResult:
    """把 Spider/JAR/requests 的返回值归一为 ProxyResult。

    兼容形态：

    - ``None`` → 404；
    - ``str`` → 302 Location（保留旧 build_proxy_response 行为）；
    - ``(status, mime, body[, headers])`` → FongMi 标准 Object[]；
    - ``requests.Response`` → 保留 raw 流；
    - ``dict`` → JSON 响应；
    - 其他值 → UTF-8 文本。
    """

    if isinstance(result, ProxyResult):
        result.headers = _clean_headers(result.headers)
        if result.mime:
            result.headers.setdefault('Content-Type', str(result.mime))
        return result

    response_result = _response_to_result(result)
    if response_result is not None:
        return response_result

    if result is None:
        return ProxyResult(status=404, mime='text/plain; charset=utf-8', body=b'')

    if isinstance(result, str):
        return ProxyResult(
            status=302,
            mime='text/plain; charset=utf-8',
            body=b'',
            headers={'Location': result},
        )

    if isinstance(result, (list, tuple)) and len(result) >= 2:
        try:
            status = int(result[0])
        except (TypeError, ValueError):
            status = 502
        mime = str(result[1] or 'application/octet-stream')
        body = result[2] if len(result) >= 3 else b''
        headers = result[3] if len(result) >= 4 and isinstance(result[3], Mapping) else {}
        close = getattr(body, 'close', None) if _is_stream_body(body) else None
        return ProxyResult(status, mime, body, _clean_headers(headers), close)

    if isinstance(result, dict):
        body = json.dumps(result, ensure_ascii=False).encode('utf-8')
        return ProxyResult(
            status=200,
            mime='application/json; charset=utf-8',
            body=body,
            headers={'Content-Type': 'application/json; charset=utf-8'},
        )

    body = str(result).encode('utf-8', 'replace')
    return ProxyResult(
        status=200,
        mime='text/plain; charset=utf-8',
        body=body,
        headers={'Content-Type': 'text/plain; charset=utf-8'},
    )


def iter_body(body: Any, chunk_size: int = 64 * 1024) -> Iterator[bytes]:
    """把 file-like/iterator/bytes 转成 StreamingResponse 可用的 chunks。"""

    close = getattr(body, 'close', None)
    try:
        if body is None:
            return
        if isinstance(body, str):
            if body:
                yield body.encode('utf-8')
            return
        if isinstance(body, (bytes, bytearray, memoryview)):
            if body:
                yield bytes(body)
            return
        read = getattr(body, 'read', None)
        if callable(read):
            while True:
                chunk = read(chunk_size)
                if not chunk:
                    break
                yield chunk if isinstance(chunk, bytes) else str(chunk).encode('utf-8')
            return
        for chunk in body:
            if not chunk:
                continue
            yield chunk if isinstance(chunk, bytes) else str(chunk).encode('utf-8')
    finally:
        if callable(close):
            try:
                close()
            except Exception:
                pass


def is_streaming(result: ProxyResult) -> bool:
    """判断是否应使用 StreamingResponse。"""

    return _is_stream_body(result.body)


def normalize_proxy_url(
    url: Any,
    site_key: str = '',
    spider_type: str = '',
    *,
    proxy_base: str = '',
    proxy_token: str = '',
    legacy_ports: tuple[int, ...] = (7944, 9978, 1314),
) -> str:
    """把 FongMi/旧 TVBox 代理地址归一为可消费的本地代理地址。

    ``proxy://do=...`` 是 JAR/JS/Python Spider 常见的内部 scheme；旧源则
    可能直接写死 7944、9978 或 1314。只对本机旧地址做转换，绝不改写外部
    URL，也不重复 ``unquote_plus`` 已经解码过的 query 参数。
    """
    raw = str(url or '').strip()
    if not raw:
        return raw
    base = str(proxy_base or '').rstrip('/')
    if not base:
        # 延迟导入，避免这个纯契约模块在 JVM/单元测试里要求完整 hoststate。
        try:
            import hoststate
            base = hoststate.get_proxy_url(True).rstrip('/')
        except Exception:
            base = 'http://127.0.0.1:9978/proxy'

    query = ''
    target = raw
    if raw.lower().startswith('proxy://'):
        query = raw[8:].lstrip('?')
        target = base
    else:
        try:
            parts = urlsplit(raw)
            host = (parts.hostname or '').lower()
            port = parts.port or (443 if parts.scheme == 'https' else 80)
            if host in ('127.0.0.1', 'localhost') and port in set(legacy_ports):
                query = parts.query
                # 旧 go-proxy 的 do=pan/url 协议仍由数据面处理；Spider
                # 调度协议则统一进入当前控制端口，避免 7944/9978 之间
                # 各自维护一套 recent-loader 语义。
                pairs = dict(parse_qsl(query, keep_blank_values=True))
                do = str(pairs.get('do') or '').lower()
                if do in ('js', 'py', 'jar') or pairs.get('siteKey'):
                    target = base
                else:
                    return raw
            else:
                return raw
        except ValueError:
            return raw

    pairs = parse_qsl(query, keep_blank_values=True)
    values: dict[str, str] = {}
    for key, value in pairs:
        values[str(key)] = str(value)
    # do=pan 的 site 是 Provider 名称（quark/uc 等），不是 SiteManager key；
    # 把 jar 的站点 key 塞进去会让 FastAPI 把网盘请求误派回该 Spider。
    do_value = str(values.get('do') or '').lower()
    if site_key and do_value != 'pan' and not any(k.lower() == 'sitekey' for k in values):
        values['siteKey'] = str(site_key)
    if proxy_token and not any(k.lower() == 'token' for k in values):
        values['token'] = str(proxy_token)
    # 保留 spider_type 作为诊断/兼容上下文；do 已明确时不覆盖。
    if spider_type and not values.get('do') and spider_type in ('js', 'py', 'jar'):
        values['do'] = spider_type
    encoded = urlencode(values, doseq=True)
    if not encoded:
        return target
    parts = urlsplit(target)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, encoded, parts.fragment))
