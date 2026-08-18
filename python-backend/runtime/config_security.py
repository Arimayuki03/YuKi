# -*- coding: utf-8 -*-
"""C2.5 配置安全边界。

配置随源携带，宿主只保证契约——因此配置文本是**不可信输入**，配置里出现的每一个
URL 也都是不可信输入。本模块把「允许从哪里取、最多取多少、能不能碰本机」集中成
一处可测边界，而不是散落在 `_fetch_config` / `_build_site` / `jar_bridge` 各自的
`startswith('http')` 判断里。

四条规则：

1. **协议白名单**：默认只接受 `http`/`https`。本地文件必须由用户在宿主侧显式选择
   （`allow_local_file`），远端配置内的任何路径都不能落到文件系统；`file://`、
   `C:\\...`、`\\\\server\\share`、`assets://`、`proxy://` 一律拒绝。
2. **体积与跳转上限**：响应体按流式计数截断，跳转次数、解压后体积、多仓递归深度、
   `ext` 展开深度都有硬上限，避免压缩炸弹与循环仓。
3. **私网同源继承**（浏览器 Private Network Access 模型）：用户亲手输入的根地址
   即使指向 `127.0.0.1`/内网也视为显式选择，**同源**子资源继承这份信任；但从公网
   源取回的配置若引用回环/内网地址，默认拒绝——否则远端仓可以静默扫本机端口。
   需要跨源访问内网时由 `allow_private_network` 显式打开。
4. **下载物指纹**：JAR/JS/Python 落盘时登记 sha256，内容变化必须重新评估能力与
   权限，不能沿用上一次的分级结论。

被拒绝时抛 :class:`ConfigSecurityError`，它同时携带稳定错误码
（`L1_CONFIG_BLOCKED` / `L2_SITE_BLOCKED` / `L1_CONFIG_TOO_LARGE`）和给诊断页用的
`[L1:security]` / `[L2:security]` 文本标签，因此既能进结构化响应，也能被既有的
分层聚合逻辑识别。
"""
import gzip
import ipaddress
import os
import socket
import threading
import zlib
from dataclasses import dataclass, field, replace
from urllib.parse import urljoin, urlsplit, urlunsplit

from .errors import RuntimeError as RuntimeContractError, redact_sensitive

ALLOWED_SCHEMES = ('http', 'https')

# 明确拒绝的伪协议：FongMi 的 UrlUtil.convert 会把 assets:// / proxy:// / file://
# 重写成 Android 侧路径，桌面宿主没有对应沙箱，不能让远端配置借它们落到本地。
BLOCKED_SCHEMES = ('file', 'assets', 'proxy', 'data', 'jar', 'javascript', 'ftp', 'smb')

# 上限：配置正文 / 解压后正文 / 单个 ext 展开 / 跳转次数 / 多仓递归 / ext 递归。
MAX_CONFIG_BYTES = 8 * 1024 * 1024
MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024
MAX_EXT_BYTES = 2 * 1024 * 1024
MAX_REDIRECTS = 5
MAX_DEPOT_DEPTH = 1
MAX_EXT_DEPTH = 2
MAX_LOCAL_CONFIG_BYTES = 32 * 1024 * 1024

_DNS_CACHE = {}
_DNS_LOCK = threading.Lock()


class ConfigSecurityError(ValueError):
    """安全边界拒绝。既是 ValueError（兼容既有 except 分支），也带稳定错误码。"""

    def __init__(self, reason, message, *, code='L1_CONFIG_BLOCKED', url='', scope=''):
        self.reason = str(reason)
        self.code = str(code)
        self.url = str(url or '')
        self.scope = str(scope or '')
        tag = '[L2:security]' if str(code).startswith('L2') else '[L1:security]'
        super().__init__('%s %s' % (tag, message))

    def to_runtime_error(self, *, site_key='', runtime=''):
        return RuntimeContractError(
            self.code, site_key=site_key, runtime=runtime,
            raw_error=str(self),
            details={'reason': self.reason, 'scope': self.scope,
                     'url': redact_sensitive(self.url, 200)})


# --------------------------------------------------------------- 主机分级


def _is_ip_literal(host):
    try:
        ipaddress.ip_address(host.strip('[]'))
        return True
    except ValueError:
        return False


def _ip_scope(addr):
    try:
        ip = ipaddress.ip_address(addr.strip('[]'))
    except ValueError:
        return 'invalid'
    if ip.is_loopback:
        return 'loopback'
    if ip.is_unspecified:
        # 0.0.0.0 / :: 在多数栈上等价于回环，按最严处理。
        return 'loopback'
    if ip.is_link_local or ip.is_private or ip.is_reserved or ip.is_multicast:
        return 'private'
    if getattr(ip, 'ipv4_mapped', None) is not None:
        return _ip_scope(str(ip.ipv4_mapped))
    return 'public'


# DNS 解析用的硬上限。解析只是「这个域名是否指向内网」的补充判据，不能成为配置
# 加载的阻塞点：慢/不可达的 DNS 会把每个站点都拖住。超时按 'unknown' 处理，
# 后续真正的连接失败才是权威信号。
DNS_SCOPE_TIMEOUT = 1.5


def _resolve_scope(host, timeout=DNS_SCOPE_TIMEOUT):
    """DNS 解析后取最严格的分级；失败/超时返回 'unknown'（连接阶段自然会失败）。"""
    with _DNS_LOCK:
        if host in _DNS_CACHE:
            return _DNS_CACHE[host]
    box = {'scope': 'unknown'}

    def lookup():
        try:
            infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
            scopes = {_ip_scope(item[4][0]) for item in infos}
            for candidate in ('loopback', 'private', 'invalid', 'public'):
                if candidate in scopes:
                    box['scope'] = candidate
                    return
        except Exception:
            box['scope'] = 'unknown'

    worker = threading.Thread(target=lookup, name='dns-scope', daemon=True)
    worker.start()
    worker.join(timeout)
    scope = box['scope']
    if worker.is_alive():
        # 解析还没回来：本次按 unknown 放行，且**不写缓存**，下次重新判定。
        return 'unknown'
    with _DNS_LOCK:
        _DNS_CACHE[host] = scope
    return scope


def host_scope(host, *, resolve=True):
    """把主机名归入 loopback / private / public / unknown / invalid。

    IP 字面量直接判定；`localhost`、`*.localhost`、`*.local`、`*.home.arpa`、
    `*.internal` 按约定视为本机/内网；其余主机名可选做一次带缓存的 DNS 解析，
    覆盖 `a.example.com → 192.168.x.x` 这类指向内网的公网域名。
    """
    host = str(host or '').strip().lower().rstrip('.')
    if not host:
        return 'invalid'
    if _is_ip_literal(host):
        return _ip_scope(host)
    if host == 'localhost' or host.endswith('.localhost'):
        return 'loopback'
    if host.endswith('.local') or host.endswith('.home.arpa') or host.endswith('.internal'):
        return 'private'
    # RFC 6761/2606 保留后缀永远不解析。跳过 DNS 不是放宽规则（它们不属于内网），
    # 只是避免每个这类地址都白等一次解析超时。
    if host.endswith('.invalid') or host.endswith('.test') or host == 'invalid':
        return 'unknown'
    if not resolve:
        return 'unknown'
    return _resolve_scope(host)


def reset_dns_cache():
    """测试与「配置更新后重新评估」用；不清缓存会让 DNS 变化被旧结论遮住。"""
    with _DNS_LOCK:
        _DNS_CACHE.clear()


# --------------------------------------------------------------- 策略与信任根


@dataclass(frozen=True)
class ConfigSecurityPolicy:
    """一次配置加载全程共享的上限与开关。"""

    max_config_bytes: int = MAX_CONFIG_BYTES
    max_decompressed_bytes: int = MAX_DECOMPRESSED_BYTES
    max_ext_bytes: int = MAX_EXT_BYTES
    max_redirects: int = MAX_REDIRECTS
    max_depot_depth: int = MAX_DEPOT_DEPTH
    max_ext_depth: int = MAX_EXT_DEPTH
    max_local_config_bytes: int = MAX_LOCAL_CONFIG_BYTES
    allow_local_file: bool = False
    allow_private_network: bool = False
    resolve_hostnames: bool = True

    @classmethod
    def from_env(cls, **overrides):
        def flag(name):
            return str(os.environ.get(name, '')).lower() in ('1', 'true', 'yes')

        def size(name, default):
            try:
                value = int(str(os.environ.get(name, '') or 0))
            except (TypeError, ValueError):
                return default
            return value if value > 0 else default

        base = cls(
            max_config_bytes=size('VPC_CONFIG_MAX_BYTES', MAX_CONFIG_BYTES),
            max_decompressed_bytes=size('VPC_CONFIG_MAX_DECOMPRESSED_BYTES',
                                        MAX_DECOMPRESSED_BYTES),
            max_ext_bytes=size('VPC_CONFIG_MAX_EXT_BYTES', MAX_EXT_BYTES),
            max_redirects=size('VPC_CONFIG_MAX_REDIRECTS', MAX_REDIRECTS),
            max_depot_depth=size('VPC_CONFIG_MAX_DEPOT_DEPTH', MAX_DEPOT_DEPTH),
            max_ext_depth=size('VPC_CONFIG_MAX_EXT_DEPTH', MAX_EXT_DEPTH),
            allow_local_file=flag('VPC_CONFIG_ALLOW_LOCAL_FILE'),
            allow_private_network=flag('VPC_CONFIG_ALLOW_PRIVATE_NETWORK'),
            resolve_hostnames=not flag('VPC_CONFIG_SKIP_DNS_SCOPE'),
        )
        return replace(base, **overrides) if overrides else base

    def to_dict(self):
        return {
            'maxConfigBytes': int(self.max_config_bytes),
            'maxDecompressedBytes': int(self.max_decompressed_bytes),
            'maxExtBytes': int(self.max_ext_bytes),
            'maxRedirects': int(self.max_redirects),
            'maxDepotDepth': int(self.max_depot_depth),
            'maxExtDepth': int(self.max_ext_depth),
            'allowLocalFile': bool(self.allow_local_file),
            'allowPrivateNetwork': bool(self.allow_private_network),
        }


@dataclass(frozen=True)
class SourceTrust:
    """信任根：用户显式选择的那一个配置来源。

    `origin` 是根地址的 scheme://host:port；`scope` 是它的主机分级。用户输入
    `http://127.0.0.1:8000/tv.json` 时 scope='loopback'，该 origin 下的子资源继承
    信任；而 scope='public' 的根配置引用 loopback/private 地址属于跨源提权，默认拒绝。
    """

    root: str = ''
    origin: str = ''
    scope: str = 'inline'
    user_selected_local_file: bool = False

    @classmethod
    def for_source(cls, source, *, policy=None, user_selected_local_file=False):
        policy = policy or ConfigSecurityPolicy()
        text = str(source or '').strip()
        if not text or text.startswith('{'):
            return cls(root='(inline)', origin='', scope='inline')
        parts = urlsplit(text)
        if parts.scheme in ALLOWED_SCHEMES and parts.hostname:
            scope = host_scope(parts.hostname, resolve=policy.resolve_hostnames)
            return cls(root=text, origin=_origin_of(parts), scope=scope)
        return cls(root=text, origin='', scope='local',
                   user_selected_local_file=bool(user_selected_local_file))

    def trusts(self, url):
        """URL 是否与信任根同源（scheme+host+port 完全一致）。"""
        if not self.origin:
            return False
        parts = urlsplit(str(url or ''))
        return bool(parts.hostname) and _origin_of(parts) == self.origin

    def to_dict(self):
        return {'root': redact_sensitive(self.root, 300), 'origin': self.origin,
                'scope': self.scope}


def _origin_of(parts):
    port = parts.port or (443 if parts.scheme == 'https' else 80)
    return '%s://%s:%s' % (parts.scheme, (parts.hostname or '').lower(), port)


# --------------------------------------------------------------- URL 守卫


def _looks_like_local_path(text):
    s = str(text or '')
    if s.startswith('\\\\') or s.startswith('//?/'):
        return True
    if len(s) >= 3 and s[1] == ':' and s[2] in ('\\', '/') and s[0].isalpha():
        return True
    if s.startswith('/') and not s.startswith('//'):
        return True
    return False


def guard_url(url, *, policy, trust, kind='config', base_url='', site_key=''):
    """校验并归一化一个来自配置的资源地址；不合规抛 :class:`ConfigSecurityError`。

    `kind` 只影响错误码层级（config → L1，其余 → L2）与诊断文本，不放宽任何规则。
    相对地址按 `base_url`（最终配置 URL）解析后再校验——先解析后校验，避免
    `./../../etc/passwd` 之类在校验后才被拼成越界地址。
    """
    code = 'L1_CONFIG_BLOCKED' if kind == 'config' else 'L2_SITE_BLOCKED'
    raw = str(url or '').strip()
    if not raw:
        raise ConfigSecurityError('empty', '%s 地址为空' % kind, code=code)
    if base_url and (raw.startswith('./') or raw.startswith('../')):
        raw = urljoin(base_url, raw)
    # 本地磁盘路径必须在解析 scheme **之前**判掉：`urlsplit('C:\\x\\tv.json')` 会把盘符
    # 当成 scheme `c`，于是 `D:/tv.json` 被报成「不支持的协议 d://」——诊断页看到的
    # 原因就和真实问题（引用了本地磁盘路径）不一致。`file://` 等伪协议不是这个形状，
    # 仍然落到下面的 scheme_blocked。
    if _looks_like_local_path(raw):
        raise ConfigSecurityError(
            'local_path_blocked',
            '配置不允许引用本地磁盘路径（%s）' % kind, code=code, url=raw)
    parts = urlsplit(raw)
    scheme = (parts.scheme or '').lower()
    if scheme in BLOCKED_SCHEMES:
        raise ConfigSecurityError(
            'scheme_blocked',
            '配置不允许使用 %s:// 地址（%s）；本地资源需用户在宿主侧显式选择' % (scheme, kind),
            code=code, url=raw)
    if not scheme:
        raise ConfigSecurityError(
            'relative_without_base',
            '相对地址缺少配置 URL 基址，无法解析（%s）' % kind, code=code, url=raw)
    if scheme not in ALLOWED_SCHEMES:
        raise ConfigSecurityError(
            'scheme_not_allowed',
            '仅支持 http/https 配置来源，收到 %s://（%s）' % (scheme, kind), code=code, url=raw)
    host = parts.hostname or ''
    if not host:
        raise ConfigSecurityError('no_host', '%s 地址缺少主机名' % kind, code=code, url=raw)
    scope = host_scope(host, resolve=policy.resolve_hostnames)
    if scope == 'invalid':
        raise ConfigSecurityError('invalid_host', '%s 地址主机名无效' % kind,
                                  code=code, url=raw, scope=scope)
    if scope in ('loopback', 'private'):
        if not (policy.allow_private_network or trust.trusts(raw)):
            raise ConfigSecurityError(
                'private_network_blocked',
                '配置引用了本机/内网地址（%s，%s）。远端配置不能静默访问本地服务；'
                '确需访问请在设置中显式开启本地网络访问。' % (host, kind),
                code=code, url=raw, scope=scope)
    return urlunsplit((scheme, parts.netloc, parts.path, parts.query, ''))


def guard_local_config_path(path, *, policy, trust):
    """本地配置文件：仅当用户显式选择该文件时可读，且有体积上限。"""
    text = str(path or '').strip()
    if not (policy.allow_local_file or trust.user_selected_local_file):
        raise ConfigSecurityError(
            'local_file_not_selected',
            '本地配置文件需要用户显式选择后才能载入', code='L1_CONFIG_BLOCKED', url=text)
    real = os.path.realpath(text)
    if not os.path.isfile(real):
        raise ConfigSecurityError('local_file_missing', '本地配置文件不存在',
                                  code='L1_CONFIG_FETCH_FAILED', url=text)
    try:
        size = os.path.getsize(real)
    except OSError as exc:
        raise ConfigSecurityError('local_file_unreadable', '本地配置文件不可读',
                                  code='L1_CONFIG_FETCH_FAILED', url=text) from exc
    if size > policy.max_local_config_bytes:
        raise ConfigSecurityError(
            'local_file_too_large',
            '本地配置文件超出 %d 字节上限' % policy.max_local_config_bytes,
            code='L1_CONFIG_TOO_LARGE', url=text)
    return real


# --------------------------------------------------------------- 受限取回


@dataclass
class GuardedResponse:
    """受限取回的结果；`raw` 已按上限截断校验，绝不含未计量的字节。"""

    url: str = ''
    final_url: str = ''
    status: int = 0
    raw: bytes = b''
    headers: dict = field(default_factory=dict)
    redirects: list = field(default_factory=list)
    etag: str = ''
    last_modified: str = ''
    encoding: str = ''
    decompressed: bool = False
    error: str = ''

    @property
    def ok(self):
        return 200 <= int(self.status or 0) < 300 and not self.error


def read_capped(response, limit, *, kind='config'):
    """流式读响应体，超过 `limit` 立即断开——不能先收完再判断长度。"""
    limit = max(1, int(limit))
    chunks, total = [], 0
    try:
        for chunk in response.iter_content(64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > limit:
                response.close()
                raise ConfigSecurityError(
                    'response_too_large',
                    '%s 响应超出 %d 字节上限' % (kind, limit),
                    code='L1_CONFIG_TOO_LARGE' if kind == 'config' else 'L2_SITE_BLOCKED',
                    url=str(getattr(response, 'url', '') or ''))
            chunks.append(chunk)
    finally:
        try:
            response.close()
        except Exception:
            pass
    return b''.join(chunks)


def decompress_capped(raw, limit, *, kind='config'):
    """gzip/deflate 按上限增量解压，防压缩炸弹；非压缩内容原样返回。

    返回 ``(bytes, decompressed_flag)``。检测到魔数但解压失败时返回原始字节
    （可能是魔数误判），只在**成功解压且超限**时报错——压缩炸弹正落在这一支。
    """
    if not raw or len(raw) < 2:
        return raw, False
    if raw[:2] == b'\x1f\x8b':
        wbits = 16 + zlib.MAX_WBITS
    elif raw[:1] == b'\x78' and raw[1:2] in (b'\x01', b'\x5e', b'\x9c', b'\xda'):
        wbits = zlib.MAX_WBITS
    else:
        return raw, False
    limit = max(1, int(limit))
    out, total = [], 0
    try:
        obj = zlib.decompressobj(wbits)
        for start in range(0, len(raw), 64 * 1024):
            piece = obj.decompress(raw[start:start + 64 * 1024], limit + 1 - total)
            total += len(piece)
            out.append(piece)
            if total > limit:
                raise ConfigSecurityError(
                    'decompressed_too_large',
                    '%s 解压后超出 %d 字节上限' % (kind, limit),
                    code='L1_CONFIG_TOO_LARGE' if kind == 'config' else 'L2_SITE_BLOCKED')
            if obj.unused_data or obj.eof:
                break
        tail = obj.flush()
        total += len(tail)
        out.append(tail)
        if total > limit:
            raise ConfigSecurityError(
                'decompressed_too_large',
                '%s 解压后超出 %d 字节上限' % (kind, limit),
                code='L1_CONFIG_TOO_LARGE' if kind == 'config' else 'L2_SITE_BLOCKED')
    except ConfigSecurityError:
        raise
    except Exception:
        # gzip 魔数误判（例如恰好以 \x1f\x8b 开头的二进制），回退原文
        try:
            return gzip.decompress(raw), True
        except Exception:
            return raw, False
    return b''.join(out), True


_REDIRECT_STATUSES = (301, 302, 303, 307, 308)


def fetch_guarded(url, *, policy, trust, kind='config', timeout=None,
                  headers=None, limit=None, session_get=None):
    """按安全边界取回一个配置资源。

    与 `http_client.fetch_follow_redirects` 的区别：每一跳都重新过 `guard_url`
    （跳转是绕过 SSRF 检查最常见的路径——`http://evil/x` 302 到
    `http://127.0.0.1:9978/` 必须在跟随前被拒），响应体流式限长，解压限量。
    """
    from http_client import TIMEOUT_NORMAL, get as http_get

    getter = session_get or http_get
    timeout = timeout or TIMEOUT_NORMAL
    limit = int(limit or (policy.max_config_bytes if kind == 'config' else policy.max_ext_bytes))
    current = guard_url(url, policy=policy, trust=trust, kind=kind)
    out = GuardedResponse(url=current)
    for hop in range(int(policy.max_redirects) + 1):
        response = getter(current, timeout=timeout, headers=dict(headers or {}),
                          allow_redirects=False, stream=True)
        if response is None:
            out.error = 'empty response'
            return out
        status = int(getattr(response, 'status_code', 0) or 0)
        location = response.headers.get('Location') if getattr(response, 'headers', None) else None
        if status in _REDIRECT_STATUSES and location:
            try:
                response.close()
            except Exception:
                pass
            if hop >= int(policy.max_redirects):
                raise ConfigSecurityError(
                    'too_many_redirects',
                    '%s 跳转次数超过 %d 次上限' % (kind, policy.max_redirects),
                    code='L1_CONFIG_BLOCKED' if kind == 'config' else 'L2_SITE_BLOCKED',
                    url=current)
            out.redirects.append(current)
            # 跳转目标同样要过守卫：不能因为第一跳是公网就放行后续内网跳转。
            current = guard_url(urljoin(current, location), policy=policy,
                                trust=trust, kind=kind)
            continue
        out.status = status
        out.final_url = str(getattr(response, 'url', '') or current)
        out.headers = {k.lower(): v for k, v in dict(getattr(response, 'headers', {}) or {}).items()}
        out.etag = str(out.headers.get('etag') or '')
        out.last_modified = str(out.headers.get('last-modified') or '')
        declared = out.headers.get('content-length')
        if declared and str(declared).isdigit() and int(declared) > limit:
            try:
                response.close()
            except Exception:
                pass
            raise ConfigSecurityError(
                'response_too_large',
                '%s 声明长度 %s 超出 %d 字节上限' % (kind, declared, limit),
                code='L1_CONFIG_TOO_LARGE' if kind == 'config' else 'L2_SITE_BLOCKED',
                url=current)
        raw = read_capped(response, limit, kind=kind)
        raw, out.decompressed = decompress_capped(
            raw, policy.max_decompressed_bytes if kind == 'config' else limit, kind=kind)
        out.raw = raw
        out.encoding = str(getattr(response, 'encoding', '') or '')
        return out
    raise ConfigSecurityError(
        'too_many_redirects', '%s 跳转次数超过上限' % kind,
        code='L1_CONFIG_BLOCKED' if kind == 'config' else 'L2_SITE_BLOCKED', url=url)


# --------------------------------------------------------------- 下载物指纹


@dataclass
class ArtifactFingerprint:
    """落盘的第三方代码指纹；内容变化必须重评能力，不能沿用旧分级。"""

    kind: str = ''
    url: str = ''
    path: str = ''
    sha256: str = ''
    size: int = 0
    changed: bool = True

    def to_dict(self):
        return {'kind': self.kind, 'url': redact_sensitive(self.url, 200),
                'sha256': self.sha256, 'size': int(self.size),
                'changed': bool(self.changed)}


class ArtifactRegistry:
    """按 (kind, url) 记录 sha256；同 URL 内容变化时 `changed=True` 触发重评。"""

    def __init__(self):
        self._seen = {}
        self._lock = threading.Lock()

    def register(self, kind, url, path):
        import hashlib
        digest, size = '', 0
        try:
            hasher = hashlib.sha256()
            with open(path, 'rb') as handle:
                while True:
                    chunk = handle.read(256 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    hasher.update(chunk)
            digest = hasher.hexdigest()
        except OSError:
            digest, size = '', 0
        key = (str(kind), str(url))
        with self._lock:
            previous = self._seen.get(key)
            self._seen[key] = digest
        changed = previous != digest
        return ArtifactFingerprint(kind=str(kind), url=str(url), path=str(path),
                                   sha256=digest, size=size, changed=changed)

    def snapshot(self):
        with self._lock:
            return {'%s:%s' % (kind, url): digest for (kind, url), digest in self._seen.items()}


ARTIFACTS = ArtifactRegistry()
