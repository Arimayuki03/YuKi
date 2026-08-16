import os
import requests
from importlib.machinery import SourceFileLoader
import json


def spider(cache, api):
    name = os.path.basename(api)
    path = cache + "/" + name
    download(path, api)
    name = name.split(".")[0]
    return SourceFileLoader(name, path).load_module().Spider()


def download(path, api):
    if api.startswith('http'):
        writeFile(path, redirect(api).content)
    else:
        writeFile(path, str.encode(api))


def writeFile(path, content):
    with open(path, 'wb') as f:
        f.write(content)


def _system_proxies():
    """读取 Windows 系统代理（WinINET 注册表），启用时返回 requests proxies dict。

    TVBox 生态大量源（github raw / jsdelivr / pastebin 等）在部分网络下需要
    代理才能访问；app.redirect / fetch_text 走系统代理可让 PC 端与手机 TVBox
    行为一致。仅当系统代理启用且目标非本机时使用；代理不可用自动回退直连。
    """
    try:
        import winreg
        key_path = r'Software\Microsoft\Windows\CurrentVersion\Internet Settings'
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as k:
            enable, _ = winreg.QueryValueEx(k, 'ProxyEnable')
            server, _ = winreg.QueryValueEx(k, 'ProxyServer')
            bypass, _ = winreg.QueryValueEx(k, 'ProxyOverride')
        if not enable or not server:
            return {}
        proxies = {}
        if '=' in server:
            # 按协议指定：http=host:port;https=host:port
            for part in server.split(';'):
                if '=' in part:
                    proto, addr = part.split('=', 1)
                    proto = proto.strip().lower()
                    addr = addr.strip()
                    if proto and addr:
                        proxies[proto] = 'http://' + addr
        else:
            proxies = {'http': 'http://' + server, 'https': 'http://' + server}
        return proxies
    except Exception:
        return {}


def _should_bypass_proxy(url, bypass):
    """按 WinINET ProxyOverride 语义判断是否直连（本机/通配符/分号列表）。"""
    try:
        from urllib.parse import urlparse
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
            # 无点号主机名视为局域网
            if host.count('.') == 0:
                return True
        elif item.startswith('*.'):
            if host.endswith(item[1:]):
                return True
        elif item.startswith('*'):
            if host.endswith(item[1:]):
                return True
        elif item and item in host:
            return True
    return False


def _fetch(url, timeout=15):
    """requests GET：优先系统代理，失败回退直连；返回 Response 或 None。

    UA 使用 okhttp（TVBox 客户端同款）：大量 TVBox 生态接口按 UA 分流
    （浏览器 UA 返回下载页/HTML，okhttp UA 才返回配置 JSON，如 菜妮丝/王二小/游魂）。
    """
    headers = {'User-Agent': 'okhttp/4.9.3'}
    last = None
    try:
        import winreg
        enable = 0
        server = ''
        bypass = ''
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r'Software\Microsoft\Windows\CurrentVersion\Internet Settings') as k:
            enable, _ = winreg.QueryValueEx(k, 'ProxyEnable')
            server, _ = winreg.QueryValueEx(k, 'ProxyServer')
            bypass, _ = winreg.QueryValueEx(k, 'ProxyOverride')
    except Exception:
        enable, server, bypass = 0, '', ''
    if enable and server and not _should_bypass_proxy(url, bypass):
        try:
            return requests.get(url, headers=headers, allow_redirects=False,
                                verify=False, timeout=timeout, proxies=_system_proxies())
        except Exception as e:
            last = e
    try:
        return requests.get(url, headers=headers, allow_redirects=False,
                            verify=False, timeout=timeout)
    except Exception as e:
        if last:
            raise last from e
        raise


def redirect(url, timeout=15):
    rsp = _fetch(url, timeout=timeout)
    if rsp is None:
        return rsp
    if 'Location' in rsp.headers:
        return redirect(rsp.headers['Location'], timeout=timeout)
    return rsp


def str2json(content):
    return json.loads(content)


def getDependence(ru):
    result = ru.getDependence()
    return result


def getName(ru):
    result = ru.getName()
    return result


def init(ru, extend):
    ru.init(extend)


def homeContent(ru, filter):
    result = ru.homeContent(filter)
    formatJo = json.dumps(result, ensure_ascii=False)
    return formatJo


def homeVideoContent(ru, pg='1'):
    # T76：「全部」总览 feed 支持分页（pg 可选，默认首页语义不变）
    result = ru.homeVideoContent(pg)
    formatJo = json.dumps(result, ensure_ascii=False)
    return formatJo


def categoryContent(ru, tid, pg, filter, extend):
    result = ru.categoryContent(tid, pg, filter, str2json(extend))
    formatJo = json.dumps(result, ensure_ascii=False)
    return formatJo


def detailContent(ru, array):
    result = ru.detailContent(str2json(array))
    formatJo = json.dumps(result, ensure_ascii=False)
    return formatJo


def searchContent(ru, key, quick, pg='1'):
    result = ru.searchContent(key, quick, pg)
    formatJo = json.dumps(result, ensure_ascii=False)
    return formatJo


def playerContent(ru, flag, id, vipFlags):
    result = ru.playerContent(flag, id, str2json(vipFlags))
    formatJo = json.dumps(result, ensure_ascii=False)
    return formatJo


def liveContent(ru, url):
    result = ru.liveContent(url)
    return result


def localProxy(ru, param):
    result = ru.localProxy(str2json(param))
    return result


def action(ru, action):
    result = ru.action(action)
    formatJo = json.dumps(result, ensure_ascii=False)
    return formatJo


def destroy(ru):
    ru.destroy()


def run():
    pass


if __name__ == '__main__':
    run()
