# -*- coding: utf-8 -*-
"""统一 HTTP 客户端 —— 进程级连接池 + 超时分档 + WinINET 系统代理收编。

此前全后端只有 go_proxy 的 _qses 一个显式 Session，其余散点 requests.get/post
每次调用新建 TCP 连接（聚合搜索 8 并发 × 多站时握手开销显著）；超时散落
5/10/15/30/60s 多档不统一；WinINET 系统代理读取在 app.py / go_proxy.py /
jar_bridge.py 重复实现三份且语义有微妙差异。

设计要点：
- 共享 Session 但 Cookie jar 挂 BlockAll 策略：响应 Set-Cookie 一律不落地，
  并发下无 jar 竞态，也绝不覆盖调用方显式传入的 Cookie 头（go_proxy L-18
  结论的全局版）。需要 Cookie 状态的调用方自行管理（显式 headers 或专用
  Session，如 go_proxy._qses）。
- 代理：优先环境变量（应用内「代理设置」由主进程注入，kazumi 链路原行为），
  其次显式读 WinINET 注册表（TVBox 源/夸克链路；requests 的 trust_env 在
  部分进程读不到注册表 → 退化直连取流暴慢），带 ProxyOverride bypass 语义；
  代理连接失败自动回退直连（app.py 原行为）。Session 关闭 trust_env 后
  环境变量代理改由 system_proxies() 显式解析，语义不变。
- verify 默认 True；确有需要坏证书兼容的调用方显式传 verify=False。
"""
import threading
from http.cookiejar import DefaultCookiePolicy
from urllib.parse import urljoin, urlparse, urlencode

import requests
from requests.adapters import HTTPAdapter
from requests.cookies import RequestsCookieJar
from requests.structures import CaseInsensitiveDict


class _NoStoreCookiePolicy(DefaultCookiePolicy):
    """禁用 Cookie 落地（Python 3.14 移除了 http.cookiejar.BlockAll，自定义等价实现）。"""

    def set_ok(self, cookie, request):
        return False

# 超时分档（连接, 读）——新代码按场景选档；存量调用方保留原值以免行为漂移
TIMEOUT_FAST = (3, 5)      # spider 基类档：快接口
TIMEOUT_NORMAL = (5, 15)   # 配置拉取 / 常规 API
TIMEOUT_SLOW = (10, 60)    # 大文件 / 慢源

# TVBox 生态接口大量按 UA 分流（浏览器 UA 返回下载页/HTML，okhttp UA 才返回
# 配置 JSON，如 菜妮丝/王二小/游魂）——默认 okhttp（TVBox 客户端同款）。
DEFAULT_UA = 'okhttp/4.9.3'

_session = None
_session_lock = threading.Lock()


def get_session():
    """进程级共享 Session（连接池：每主机 16 并发连接；无 Cookie 状态）。"""
    global _session
    if _session is None:
        with _session_lock:
            if _session is None:
                s = requests.Session()
                s.trust_env = False
                jar = RequestsCookieJar()
                jar.set_policy(_NoStoreCookiePolicy())
                s.cookies = jar
                adapter = HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=0)
                s.mount('http://', adapter)
                s.mount('https://', adapter)
                _session = s
    return _session


def _read_wininet():
    """读 WinINET 注册表 → (proxies dict, bypass str)；未启用/非 Windows 返回 ({}, '')。"""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r'Software\Microsoft\Windows\CurrentVersion\Internet Settings') as k:
            enable, _ = winreg.QueryValueEx(k, 'ProxyEnable')
            server, _ = winreg.QueryValueEx(k, 'ProxyServer')
            try:
                bypass, _ = winreg.QueryValueEx(k, 'ProxyOverride')
            except OSError:
                bypass = ''
        if not enable or not server:
            return {}, ''
        proxies = {}
        if '=' in server:
            # 按协议指定：http=host:port;https=host:port（取 go_proxy 版语义：
            # 无 http/https 条目时回退第一个可用地址）
            parts = {}
            for seg in server.split(';'):
                if '=' in seg:
                    p, a = seg.split('=', 1)
                    parts[p.strip().lower()] = a.strip()
            for proto in ('http', 'https'):
                if parts.get(proto):
                    proxies[proto] = 'http://' + parts[proto]
            if not proxies:
                for addr in parts.values():
                    if addr:
                        proxies = {'http': 'http://' + addr, 'https': 'http://' + addr}
                        break
        else:
            proxies = {'http': 'http://' + server, 'https': 'http://' + server}
        return proxies, bypass or ''
    except Exception:
        return {}, ''


def _should_bypass(url, bypass):
    """WinINET ProxyOverride 语义：<local>/通配符/子串命中 → 直连。"""
    try:
        host = (urlparse(url).hostname or '').lower()
    except Exception:
        return True
    if host in ('127.0.0.1', 'localhost', '::1'):
        return True
    if not bypass:
        return False
    for item in (bypass or '').split(';'):
        item = item.strip().lower()
        if not item:
            continue
        if item == '<local>':
            if host.count('.') == 0:
                return True
        elif item.startswith('*'):
            if host.endswith(item[1:]):
                return True
        elif item in host:
            return True
    return False


def system_proxies(url=None):
    """解析本请求应使用的代理（收编项目两套既有语义）。

    优先级：
    1. 环境变量 HTTP(S)_PROXY/ALL_PROXY（应用内「代理设置」由主进程注入，
       kazumi 链路原依赖 requests trust_env 读取；Session 已关 trust_env，
       这里显式解析以保持该行为，含 NO_PROXY 豁免语义）；
    2. WinINET 系统代理注册表（TVBox 源/夸克链路；url 给定时按
       ProxyOverride 判定直连）。
    """
    try:
        env = requests.utils.get_environ_proxies(url or '')
        if env:
            return env
    except Exception:
        pass
    proxies, bypass = _read_wininet()
    if not proxies:
        return {}
    if url and _should_bypass(url, bypass):
        return {}
    return proxies


def system_proxy_addr():
    """系统代理地址 (host, port)；未启用返回 None（jar_bridge 转 JVM 属性用）。"""
    proxies = system_proxies()
    addr = proxies.get('https') or proxies.get('http') or ''
    try:
        p = urlparse(addr)
    except Exception:
        return None
    if p.hostname and p.port:
        return p.hostname, p.port
    return None


def _send(method, url, *, proxy=True, timeout=TIMEOUT_NORMAL, **kw):
    """走共享 Session 发请求；代理失败回退直连（连接层异常才回退，HTTP 错误不回退）。"""
    if proxy:
        proxies = system_proxies(url)
        if proxies:
            try:
                return get_session().request(method, url, proxies=proxies, timeout=timeout, **kw)
            except requests.exceptions.RequestException:
                pass
    return get_session().request(method, url, timeout=timeout, **kw)


def _with_default_ua(kw):
    headers = dict(kw.pop('headers', None) or {})
    headers.setdefault('User-Agent', DEFAULT_UA)
    kw['headers'] = headers
    return kw


def get(url, *, timeout=TIMEOUT_NORMAL, proxy=True, **kw):
    """GET（参数透传 requests：params/headers/cookies/verify/stream/…）。"""
    return _send('GET', url, proxy=proxy, timeout=timeout, **_with_default_ua(kw))


def post(url, *, timeout=TIMEOUT_NORMAL, proxy=True, **kw):
    """POST（参数透传 requests：params/data/json/headers/cookies/verify/…）。"""
    return _send('POST', url, proxy=proxy, timeout=timeout, **_with_default_ua(kw))


_REDIRECT_STATUSES = (301, 302, 303, 307, 308)

# 响应体流式读取上限（全量入内存前按块计量，超限立刻断连）：
# - CMS API：榜单/分类页是本路径的常态负载，10MB 覆盖极端大站（含 type=0 XML），
#   仍远小于此前「无上限全量入内存」的最坏情况；
# - Python 站点源：正常 spider 单文件远小于 1MB，10MB 绰绰有余；
# - app.redirect() 兜底下载（site_manager.load_api 落盘执行）：同档放宽到 32MB，
#   与配置层解压后上限（MAX_DECOMPRESSED_BYTES）一致。
MAX_API_RESPONSE_BYTES = 10 * 1024 * 1024
MAX_REDIRECT_BODY_BYTES = 32 * 1024 * 1024

_CHUNK_SIZE = 64 * 1024


def _security_guard():
    """取守卫三元组；config_security 缺席时返回 None（守卫禁用，行为同旧版）。"""
    try:
        from runtime.config_security import ConfigSecurityError, ConfigSecurityPolicy, SourceTrust, guard_url
    except Exception:
        return None
    return guard_url, ConfigSecurityPolicy, SourceTrust, ConfigSecurityError


def _guard_hop(url, *, kind, trust_root='', trust_redirect=False):
    """对一跳 URL 过 SSRF 守卫（复用配置层同一套策略机制）。

    策略每跳都从环境变量重新构造（YUKI_CONFIG_BLOCK_PRIVATE_NETWORK=1 打开严格
    SSRF 防护后，本路径与配置正文路径同步生效；默认桌面策略放行本机/内网引用，
    局域网 CMS/NAS 源不受影响）。

    信任根：`trust_root` 非空时以其建立信任（同一 scheme://host:port 的地址继承
    信任——「用户亲手输入的根地址的同源子资源」语义，与配置层一致）；为空时
    **没有**受信 origin，严格模式下任何私网地址都会被拒。`trust_redirect=True`
    （跟随 30x）时显式忽略信任根：重定向目标是**远端响应内容**给出的地址而非
    用户输入，公网源 302 到内网是教科书式 SSRF/提权通道，严格模式下必须在
    跟随前被拒。守卫模块缺席时返回原地址（守卫禁用，行为同旧版）。
    """
    guard = _security_guard()
    if guard is None:
        return url
    guard_url, policy_cls, source_trust_cls, _ = guard
    policy = policy_cls.from_env()
    if trust_redirect:
        trust = source_trust_cls()
    else:
        trust = (source_trust_cls.for_source(trust_root, policy=policy)
                 if trust_root else source_trust_cls())
    return guard_url(url, policy=policy, trust=trust, kind=kind)


class _CappedResponse:
    """requests.Response 的轻量替身：内容已流式读取并限量。

    仅暴露调用方（cms_spider / config / app.redirect）实际消费的属性，
    以鸭子类型兼容 requests.Response。
    """

    def __init__(self, response, content, encoding):
        self.status_code = int(getattr(response, 'status_code', 0) or 0)
        self.headers = CaseInsensitiveDict(getattr(response, 'headers', None) or {})
        self.url = str(getattr(response, 'url', '') or '')
        self.content = content
        self.encoding = encoding
        self._apparent_encoding = None

    @property
    def apparent_encoding(self):
        # 与 requests.Response.apparent_encoding 同源（requests.compat.chardet
        # 在 requests 2.32+ 即 charset_normalizer），结果一致但只算一次。
        if self._apparent_encoding is None:
            try:
                from requests.compat import chardet
                result = chardet.detect(self.content[:4096])
                self._apparent_encoding = (result or {}).get('encoding') or ''
            except Exception:
                self._apparent_encoding = ''
        return self._apparent_encoding

    @property
    def text(self):
        return self.content.decode(self.encoding or 'utf-8', errors='replace')

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f'{self.status_code} for {self.url}')

    def close(self):
        pass

    def iter_content(self, chunk_size=_CHUNK_SIZE):
        for start in range(0, len(self.content), max(1, chunk_size)):
            yield self.content[start:start + chunk_size]


def _read_capped(response, limit):
    """流式读响应体并按块计量；超限立刻断连，避免无上限全量入内存。

    本路径**不做**解压（调用方不解压，传输层 gzip 由 requests/urllib3 透明处理），
    因此无需 config_security.decompress_capped 的压缩炸弹防护。
    """
    limit = max(1, int(limit))
    chunks, total = [], 0
    try:
        for chunk in response.iter_content(_CHUNK_SIZE):
            if not chunk:
                continue
            total += len(chunk)
            if total > limit:
                response.close()
                raise ValueError(
                    f'response body exceeds {limit} bytes cap: '
                    f'{str(getattr(response, "url", "") or "")}')
            chunks.append(chunk)
    finally:
        try:
            response.close()
        except Exception:
            pass
    return b''.join(chunks)


def fetch_follow_redirects(url, params=None, timeout=TIMEOUT_NORMAL, max_redirects=5,
                           headers=None, *, kind='site', max_bytes=None, trust_root=''):
    """手动跟随重定向取最终响应（app.redirect 的收编版）。

    修复原实现两个问题：无深度上限（循环重定向 → RecursionError）、
    Location 为相对路径时未 urljoin（拼出非法 URL）。

    C2.5 安全边界（问题 #9）：每一跳都重新过 `guard_url`——跳转是绕过 SSRF 检查
    最常见的路径（`http://evil/x` 302 到 `http://127.0.0.1:9978/` 必须在跟随前被
    拒），策略机制与配置层完全一致（`YUKI_CONFIG_BLOCK_PRIVATE_NETWORK=1` 生效，
    默认桌面策略放行本机/内网引用）。响应体流式限长（默认 10MB，见
    `MAX_API_RESPONSE_BYTES` 注释），全量入内存前必须有 cap。

    kind 只影响守卫的错误码层级（'config' → L1，其余 → L2），不放宽规则。
    trust_root 的语义见 `_guard_hop`：CMS API / 远程 Python 源这类「用户在配置里
    直接填写的根地址」应把该地址自身传入（第一跳继承同源信任，局域网 CMS 在
    严格模式下仍可用）；留空表示无受信 origin。重定向目标一律**不继承**信任
    （远端内容派生的地址，严格模式下跨源私网必拒）。
    返回 requests 鸭子类型兼容对象（.content/.text/.encoding/.apparent_encoding/
    .status_code/.headers/.url/.raise_for_status）。
    """
    hdr = dict(headers or {})
    hdr.setdefault('User-Agent', DEFAULT_UA)
    if params:
        query_str = urlencode(params)
        sep = '&' if '?' in url else '?'
        current = f"{url}{sep}{query_str}"
    else:
        current = url
    current = _guard_hop(current, kind=kind, trust_root=trust_root)
    for _ in range(max_redirects + 1):
        rsp = _send('GET', current, timeout=timeout, allow_redirects=False,
                    headers=hdr, stream=True)
        if rsp is None or rsp.status_code not in _REDIRECT_STATUSES or 'Location' not in rsp.headers:
            body = _read_capped(rsp, int(max_bytes or MAX_API_RESPONSE_BYTES))
            return _CappedResponse(
                rsp, body, str(getattr(rsp, 'encoding', '') or ''))
        location = rsp.headers.get('Location') or ''
        # 3xx 响应以 stream=True 取得且 body 从不读取：不显式 close 则该连接永不归还
        # pool_maxsize=16 的连接池（socket 要等 GC），每一跳泄漏一个 slot。TVBox 源
        # 大量 302 到镜像，命中率高；同仓 go_proxy._fetch 的等价逻辑是显式 close 的。
        # 取完 Location 就立刻关，必须早于 _guard_hop——否则下一跳被 SSRF 守卫拦下
        # 抛异常时，这一跳的响应又会被漏掉。
        try:
            rsp.close()
        except Exception:
            pass
        current = _guard_hop(urljoin(current, location), kind=kind, trust_redirect=True)
    # 走到这里说明每次迭代都在循环内 close 过并重定向；此处无需再收尾释放
    raise ValueError(f'too many redirects (>{max_redirects}): {url}')
