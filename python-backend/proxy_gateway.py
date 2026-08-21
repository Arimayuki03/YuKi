# -*- coding: utf-8 -*-
"""统一的 FongMi ``/proxy`` 调度层。

这个模块只做“请求应该交给哪个 Spider”的控制面工作，返回值仍保持
``ProxyResult`` 能接受的形态。FastAPI 和旧的 7944/9978/1314 HTTP 监听器
都调用这里，因此旧端口不会再各自实现一套 recent Spider 选择逻辑。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import urlencode


def _site_key(params: dict[str, Any], sites: Any, do: str) -> tuple[str | None, bool]:
    """返回 ``(site_key, explicit)``，兼容 siteKey/site 两种命名，不破坏 params 原始语义。"""
    if do == 'pan':
        # do=pan 的 site/siteKey 属于 Provider/旧 URL 上下文，不应把网盘
        # 请求误当成 SiteManager 站点代理。
        return None, False
    raw = params.get('siteKey')
    if raw in (None, ''):
        legacy = params.get('site')
        # do=pan 的 site 是 Provider 名称，不是 SiteManager key。
        if do == 'pan' and sites.get(legacy) is None:
            return None, False
        raw = legacy
    if raw in (None, ''):
        return None, False
    return str(raw), True


def _pan_fallback_url(params: Mapping[str, Any]) -> str | None:
    """返回旧 go-proxy 兼容 URL；不在模块导入时启动监听器。

    ``params`` 在统一入口中还包含 HTTP 请求头（例如 ``cookie``、
    ``authorization``）。这些值不能拼进 URL：除了泄露凭据，也会让
    重定向后的旧数据面错误地把请求头当成业务参数。旧 ``_handle_pan``
    会从客户端请求头或本地加密 Cookie 存储中获取夸克 Cookie。
    """
    try:
        import go_proxy

        blocked = {
            'cookie', 'authorization', 'proxy-authorization', 'set-cookie',
            'user-agent', 'referer', 'range', 'content-length', 'content-type',
            '_body',
        }
        query = urlencode({str(k): v for k, v in params.items()
                           if v is not None and str(k).lower() not in blocked},
                          doseq=True)
        return f"http://127.0.0.1:{int(go_proxy.PORT)}/proxy" + (f"?{query}" if query else '')
    except Exception:
        return None


def dispatch(params: Mapping[str, Any] | None, sites: Any) -> Any:
    """按 FongMi BaseLoader/JarLoader 语义选择 localProxy/静态 Proxy。

    优先级：明确 ``siteKey`` → ``do=js/py`` 最近同类 Spider → 最近 JAR
    静态 Proxy → 站点实例 localProxy。``do=pan`` 在没有站点 key 时回到
    Provider/旧数据面 URL，避免把网盘 Provider 名误当成 Spider。
    """
    param = dict(params or {})
    do = str(param.get('do') or '').lower()
    # 宿主鉴权 token 是本地网关上下文，不应进入第三方 Spider 参数。
    try:
        import hoststate
        expected = str(hoststate.get_token() or '')
        if expected:
            for key in list(param):
                if (str(key).lower() in ('token', 'x-proxy-token', 'proxy-token')
                        and str(param.get(key) or '') == expected):
                    param.pop(key, None)
    except Exception:
        pass
    if do == 'ck':
        return 'ok'

    site_key, explicit = _site_key(param, sites, do)
    site = sites.get(site_key) if site_key else None
    if site is None and do != 'pan':
        kind = do if do in ('js', 'py', 'jar', 'cms') else None
        site = sites.recent(kind)

    if do == 'pan':
        # 网盘请求必须走旧 go-proxy 数据面，而不是在这里把 Provider 的
        # signed URL 变成 302。旧数据面负责：
        #
        # * 从请求头或 pan_cookies.py 加载夸克 Cookie；
        # * 保留 PlayUrl.headers，并将 Range/Referer/UA 传给 CDN；
        # * 处理探测、206、seek、过期刷新和上游失败；
        # * 对分享直链失败执行 v2/play/转存回退。
        #
        # 统一入口之前直接返回 play.url，会丢失这些请求头；而且 FastAPI
        # 的重定向不会可靠地携带 mpv 的 Cookie。因此恢复 8 月 17 日已验证
        # 的协议层路径：只生成本地 do=pan URL，由 9978 Handler 取流。
        return _pan_fallback_url(param)
    if site is None or getattr(site, 'runner', None) is None:
        return None

    sites.set_recent(site.key)
    if not explicit and getattr(site, 'spider_type', '') == 'jar':
        proxy = getattr(site.runner, 'proxy', None)
        if callable(proxy):
            return proxy(param)
    local_proxy = getattr(site.runner, 'localProxy', None)
    if not callable(local_proxy):
        return None
    return local_proxy(param)


def is_spider_proxy_request(params: Mapping[str, Any] | None) -> bool:
    """判断旧 HTTP 数据面是否应转交统一调度层。"""
    p = params or {}
    do = str(p.get('do') or '').lower()
    return do in ('js', 'py', 'jar') or bool(p.get('siteKey'))
