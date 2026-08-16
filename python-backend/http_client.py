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
from urllib.parse import urljoin, urlparse

import requests
from requests.adapters import HTTPAdapter
from requests.cookies import RequestsCookieJar


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


def fetch_follow_redirects(url, timeout=TIMEOUT_NORMAL, max_redirects=5, headers=None):
    """手动跟随重定向取最终响应（app.redirect 的收编版）。

    修复原实现两个问题：无深度上限（循环重定向 → RecursionError）、
    Location 为相对路径时未 urljoin（拼出非法 URL）。
    """
    hdr = dict(headers or {})
    hdr.setdefault('User-Agent', DEFAULT_UA)
    current = url
    for _ in range(max_redirects + 1):
        rsp = _send('GET', current, timeout=timeout, allow_redirects=False, headers=hdr)
        if rsp is None or rsp.status_code not in _REDIRECT_STATUSES or 'Location' not in rsp.headers:
            return rsp
        current = urljoin(current, rsp.headers['Location'])
    raise ValueError(f'too many redirects (>{max_redirects}): {url}')
