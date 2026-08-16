import os
import http_client
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


def _fetch(url, timeout=15):
    """GET（不自动跟重定向；okhttp UA；代理优先+失败回退直连）。

    UA 与代理语义已收编到 http_client（WinINET/环境变量双来源）。
    verify 保持 False 与历史行为一致（TLS 收紧属 CODE_REVIEW H-2 批次）。
    """
    return http_client.get(url, timeout=timeout, allow_redirects=False, verify=False)


def redirect(url, timeout=15):
    """递归跟重定向取最终响应（收编到 http_client：深度上限 5 + 相对 Location urljoin）。"""
    return http_client.fetch_follow_redirects(url, timeout=timeout)


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
