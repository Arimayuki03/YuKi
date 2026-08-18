# -*- coding: utf-8 -*-
"""L1-L6 结构化错误目录与脱敏。

错误层级固定为：配置、站点、运行时、播放路由/解析、媒体、播放器。
原始异常只写脱敏日志；返回给界面的 message 有长度上限。
"""
from dataclasses import dataclass, field
import asyncio
import concurrent.futures
import re
from typing import Any, Mapping

from .android_policy import ANDROID_ONLY_MESSAGE

try:
    # ``requests`` is an optional transport dependency for the runtime
    # contract.  Importing it here lets its Timeout subclass retain the same
    # L3/L1-L6 mapping as the built-in timeout classes without making the
    # contract module depend on requests at import time.
    from requests import exceptions as _requests_exceptions
except Exception:  # pragma: no cover - minimal/runtime-only installations
    _requests_exceptions = None


ERROR_SPECS = {
    # L1 configuration
    'L1_CONFIG_FETCH_FAILED': ('config', True, 502, '配置地址不可达或返回无效内容'),
    'L1_CONFIG_PARSE_FAILED': ('config', False, 422, '配置内容无法解析'),
    'L1_CONFIG_TIMEOUT': ('config', True, 504, '配置加载超时'),
    'L1_CONFIG_CANCELLED': ('config', True, 499, '配置加载已取消'),
    'L1_CONFIG_BUSY': ('config', True, 409, '配置加载正在进行，请稍后重试'),
    'L1_CONFIG_BLOCKED': ('config', False, 403, '配置来源被安全边界拒绝'),
    'L1_CONFIG_TOO_LARGE': ('config', False, 413, '配置内容超出允许体积'),
    # L2 site assembly/capability
    'L2_SITE_INVALID': ('site', False, 422, '站点配置无效'),
    'L2_SITE_BLOCKED': ('site', False, 403, '站点资源地址被安全边界拒绝'),
    'L2_SITE_NOT_FOUND': ('site', False, 404, '站点不存在或尚未加载'),
    'L2_SITE_UNSUPPORTED': ('site', False, 422, '当前版本不支持该站点类型'),
    'L2_SITE_BUILD_FAILED': ('site', False, 422, '站点装配失败'),
    'L2_SITE_REQUIRES_ANDROID': ('site', False, 424, ANDROID_ONLY_MESSAGE),
    'L2_SITE_TIMEOUT': ('site', True, 504, '站点装配超时'),
    'L2_SITE_CANCELLED': ('site', True, 499, '站点装配已取消'),
    # L3 runtime/worker
    'L3_RUNTIME_INIT_FAILED': ('runtime', False, 502, '站点运行时初始化失败'),
    'L3_RUNTIME_CALL_FAILED': ('runtime', True, 502, '站点运行时调用失败'),
    'L3_RUNTIME_INVALID_REQUEST': ('runtime', False, 400, '运行时请求参数无效'),
    'L3_RUNTIME_TIMEOUT': ('runtime', True, 504, '站点运行时响应超时'),
    'L3_RUNTIME_CANCELLED': ('runtime', True, 499, '站点运行时请求已取消'),
    'L3_RUNTIME_BUSY': ('runtime', True, 429, '站点运行时队列已满，请稍后重试'),
    'L3_RUNTIME_CIRCUIT_OPEN': ('runtime', True, 503, '站点运行时暂时熔断，稍后将自动重试'),
    'L3_RUNTIME_CREDENTIALS_REQUIRED': ('runtime', False, 401, '站点需要有效的 Cookie 或登录凭据'),
    'L3_RUNTIME_RESTARTED': ('runtime', True, 503, '站点运行时已重启，请重试'),
    'L3_RUNTIME_CRASHED': ('runtime', True, 503, '站点运行时异常退出'),
    'L3_RUNTIME_PROTOCOL_ERROR': ('runtime', True, 502, '站点运行时通信协议异常'),
    # L4 route/parser
    'L4_PLAY_ROUTE_INVALID': ('parse', False, 422, '播放路由结果无效'),
    'L4_PARSE_FAILED': ('parse', True, 502, '播放地址解析失败'),
    'L4_PARSE_TIMEOUT': ('parse', True, 504, '播放地址解析超时'),
    'L4_PARSE_CANCELLED': ('parse', True, 499, '播放地址解析已取消'),
    'L4_PARSE_UNAVAILABLE': ('parse', False, 424, '当前配置未含匹配该线路的解析接口（parse=1）'),
    # L5 media reachability
    'L5_MEDIA_UNREACHABLE': ('media', True, 502, '媒体地址不可达'),
    'L5_MEDIA_HTTP_ERROR': ('media', True, 502, '媒体服务器拒绝访问'),
    'L5_MEDIA_TIMEOUT': ('media', True, 504, '媒体探测超时'),
    'L5_MEDIA_CANCELLED': ('media', True, 499, '媒体探测已取消'),
    'L5_MEDIA_INVALID': ('media', False, 422, '地址返回的不是可播放媒体'),
    # L6 player/first frame
    'L6_PLAYER_MISSING': ('player', False, 424, '未检测到可用播放器'),
    'L6_PLAYER_START_FAILED': ('player', True, 502, '播放器启动失败'),
    'L6_PLAYER_START_TIMEOUT': ('player', True, 504, '播放器未在时限内加载媒体'),
    'L6_PLAYER_CANCELLED': ('player', True, 499, '播放请求已取消'),
    'L6_PLAYER_DRM_UNSUPPORTED': ('player', False, 422, '桌面播放器不支持该 DRM'),
}

_SENSITIVE_PATTERNS = (
    (re.compile(r'([?&](?:token|access_token|refresh_token|api[_-]?key|secret|password)=)[^&#\s]*', re.I), r'\1[REDACTED]'),
    (re.compile(r'((?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,;]+', re.I), r'\1[REDACTED]'),
    (re.compile(r'((?:cookie|set-cookie|bduss|__puus?)\s*[:=]\s*)[^\r\n,}\]]*', re.I), r'\1[REDACTED]'),
    (re.compile(r'((?:password|passwd|pwd|token|secret|api[_-]?key)\s*["\']?\s*[:=]\s*["\']?)[^\s,\'"}\]]+', re.I), r'\1[REDACTED]'),
)


def redact_sensitive(value: Any, limit: int = 500) -> str:
    """返回适合 UI/日志的单行脱敏文本。"""
    text = str(value or '').replace('\x00', '').replace('\r', ' ').replace('\n', ' ')
    for pattern, replacement in _SENSITIVE_PATTERNS:
        text = pattern.sub(replacement, text)
    text = re.sub(r'\s+', ' ', text).strip()
    limit = max(32, min(int(limit or 500), 16000))
    return text if len(text) <= limit else text[:limit - 1] + '…'


@dataclass
class RuntimeError(Exception):
    """可序列化、可抛出的统一运行时错误模型。"""

    code: str
    message: str = ''
    stage: str = ''
    retryable: bool | None = None
    site_key: str = ''
    runtime: str = ''
    request_id: str = ''
    play_session_id: str = ''
    details: Mapping[str, Any] = field(default_factory=dict)
    raw_error: str = ''
    http_status: int = 0

    def __post_init__(self):
        spec = ERROR_SPECS.get(self.code)
        if spec is None:
            raise ValueError('unknown runtime error code: %s' % self.code)
        default_stage, default_retryable, default_http, user_message = spec
        self.stage = self.stage or default_stage
        if self.retryable is None:
            self.retryable = default_retryable
        self.http_status = int(self.http_status or default_http)
        self.message = redact_sensitive(self.message or user_message, 500)
        self.raw_error = redact_sensitive(self.raw_error or '', 1000)
        Exception.__init__(self, self.message)

    def with_request(self, request):
        if request is not None:
            self.request_id = self.request_id or getattr(request, 'request_id', '')
            self.play_session_id = self.play_session_id or getattr(request, 'play_session_id', '')
            self.site_key = self.site_key or getattr(request, 'site_key', '')
        return self

    def to_dict(self, include_raw: bool = False):
        payload = {
            'code': self.code,
            'stage': self.stage,
            'retryable': bool(self.retryable),
            'siteKey': self.site_key,
            'runtime': self.runtime,
            'message': self.message,
        }
        if self.request_id:
            payload['requestId'] = self.request_id
        if self.play_session_id:
            payload['playSessionId'] = self.play_session_id
        if self.details:
            payload['details'] = dict(self.details)
        if include_raw and self.raw_error:
            payload['rawError'] = self.raw_error
        return payload

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any] | None, *, fallback_code='L3_RUNTIME_CALL_FAILED'):
        """从 Worker 的 JSON 错误帧恢复稳定错误对象。

        Worker 数据来自隔离进程，字段必须重新经过错误目录和脱敏逻辑，不能
        直接反序列化任意异常对象。
        """
        data = dict(payload or {})
        code = str(data.get('code') or fallback_code)
        if code not in ERROR_SPECS:
            code = fallback_code
        return cls(
            code,
            message=str(data.get('message') or ''),
            site_key=str(data.get('siteKey') or ''),
            runtime=str(data.get('runtime') or ''),
            request_id=str(data.get('requestId') or ''),
            play_session_id=str(data.get('playSessionId') or ''),
            details=data.get('details') if isinstance(data.get('details'), Mapping) else {},
            raw_error=str(data.get('rawError') or ''),
        )


def error_from_exception(exc: Exception, *, stage: str = 'runtime', request=None,
                         site_key: str = '', runtime: str = '') -> RuntimeError:
    """把旧异常映射到稳定错误码；不向 UI 泄露完整原始异常。"""
    if isinstance(exc, RuntimeError):
        return exc.with_request(request)
    timeout_types = (TimeoutError, asyncio.TimeoutError,
                     concurrent.futures.TimeoutError)
    cancelled_types = (InterruptedError, KeyboardInterrupt,
                       concurrent.futures.CancelledError)
    if _requests_exceptions is not None:
        timeout_types += (_requests_exceptions.Timeout,)
    # asyncio.CancelledError is a BaseException on supported Python versions,
    # so it must be checked explicitly before the generic failure branches.
    is_async_cancel = isinstance(exc, asyncio.CancelledError)
    if isinstance(exc, timeout_types):
        code = {
            'config': 'L1_CONFIG_TIMEOUT', 'site': 'L2_SITE_TIMEOUT',
            'parse': 'L4_PARSE_TIMEOUT', 'media': 'L5_MEDIA_TIMEOUT',
            'player': 'L6_PLAYER_START_TIMEOUT',
        }.get(stage, 'L3_RUNTIME_TIMEOUT')
    elif isinstance(exc, cancelled_types) or is_async_cancel:
        code = {
            'config': 'L1_CONFIG_CANCELLED', 'site': 'L2_SITE_CANCELLED',
            'parse': 'L4_PARSE_CANCELLED', 'media': 'L5_MEDIA_CANCELLED',
            'player': 'L6_PLAYER_CANCELLED',
        }.get(stage, 'L3_RUNTIME_CANCELLED')
    elif stage == 'config':
        code = 'L1_CONFIG_PARSE_FAILED'
    elif stage == 'site':
        code = 'L2_SITE_BUILD_FAILED'
    elif stage == 'parse':
        code = 'L4_PARSE_FAILED'
    elif stage == 'media':
        code = 'L5_MEDIA_UNREACHABLE'
    elif stage == 'player':
        code = 'L6_PLAYER_START_FAILED'
    else:
        code = 'L3_RUNTIME_CALL_FAILED'
    err = RuntimeError(code, raw_error=str(exc), site_key=site_key, runtime=runtime)
    return err.with_request(request)
