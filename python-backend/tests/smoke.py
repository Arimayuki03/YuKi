# -*- coding: utf-8 -*-
"""Phase 1 冒烟测试：在进程内拉起后端，逐项验证核心端点。

覆盖：/health、token 鉴权、/action 内容 API、/cache 协议（含 spider
HTTP 回环 setCache/getCache/delCache）、/proxy localProxy。
用法：<venv>/python tests/smoke.py
"""
import json
import os
import sys
import threading
import time
import urllib.request
import urllib.parse

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

PORT = 8321
TOKEN = 'smoke-token'

os.environ['VPC_PORT'] = str(PORT)
os.environ['VPC_TOKEN'] = TOKEN

import hoststate  # noqa: E402

hoststate.configure(port=PORT, token=TOKEN)
hoststate.ensure_dirs()

import java_probe  # noqa: E402

# 测试环境可能装有 JDK（本机验证用）；测试逻辑不依赖 java 具体存在与否，
# 只保证探测函数可调用且不抛异常。
java_probe.clear_cache()

import server  # noqa: E402
import uvicorn  # noqa: E402

PASSED, FAILED = [], []


def check(name, cond, detail=''):
    if cond:
        PASSED.append(name)
        print(f'[PASS] {name}')
    else:
        FAILED.append(name)
        print(f'[FAIL] {name} {detail}')


def req(method, path, data=None, with_token=True):
    url = f'http://127.0.0.1:{PORT}{path}'
    if with_token:
        url += ('&' if '?' in url else '?') + 'token=' + TOKEN
    body = None
    headers = {}
    if data is not None:
        body = urllib.parse.urlencode(data).encode('utf-8')
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=20) as rsp:
            return rsp.status, rsp.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8')


def main():
    server.load_default_sites()
    app = server.create_app()
    cfg = uvicorn.Config(app, host='127.0.0.1', port=PORT, log_level='error')
    srv = uvicorn.Server(cfg)
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)

    # 1. 健康检查
    code, body = req('GET', '/health', with_token=False)
    check('/health', code == 200 and 'ok' in body, body)

    # 2. token 鉴权：无 token 访问 /action 应 401
    code, _ = req('POST', '/action', data={'do': 'homeContent'}, with_token=False)
    check('/action rejects bad token', code == 401, str(code))

    # 3. 内容 API
    code, body = req('POST', '/action', data={'do': 'homeContent'})
    data = json.loads(body)
    check('/action homeContent', code == 200 and len(data.get('class', [])) == 2, body[:120])

    code, body = req('POST', '/action',
                     data={'do': 'searchContent', 'word': '测试', 'quick': '0'})
    data = json.loads(body)
    check('/action searchContent', code == 200 and data['list'][0]['vod_name'].startswith('测试'), body[:120])

    code, body = req('POST', '/action', data={'do': 'search', 'word': '聚合'})
    data = json.loads(body)
    check('/action aggregate search', code == 200 and data['list'][0].get('source') == 'demo', body[:120])

    code, body = req('POST', '/action',
                     data={'do': 'playerContent', 'flag': 'demo', 'id': 'demo://ep1', 'vipFlags': '[]'})
    data = json.loads(body)
    check('/action playerContent', code == 200
          and data.get('url') == 'https://media.w3.org/2010/05/sintel/trailer.mp4', body[:120])

    # 4. /cache 端点协议
    req('POST', '/cache?do=set&key=smoke_k', data={'value': 'hello-cache'})
    code, body = req('GET', '/cache?do=get&key=smoke_k', with_token=False)
    check('/cache set+get', body == 'hello-cache', body)
    req('GET', '/cache?do=del&key=smoke_k', with_token=False)
    code, body = req('GET', '/cache?do=get&key=smoke_k', with_token=False)
    check('/cache del', body == '', body)

    # 5. spider → 宿主 HTTP 回环（setCache/getCache/delCache + expiresAt 语义）
    sp = server.sites.get().runner.spider
    check('spider.setCache', sp.setCache('loop_k', {'v': 1}) == 'succeed')
    got = sp.getCache('loop_k')
    check('spider.getCache', got == {'v': 1}, repr(got))
    sp.setCache('exp_k', {'expiresAt': int(time.time()) - 10})
    check('spider.getCache expired -> None', sp.getCache('exp_k') is None)

    # 6. /proxy localProxy
    code, body = req('GET', '/proxy?do=py&x=1', with_token=False)
    check('/proxy localProxy', code == 200 and body == 'demo-proxy-ok', body)

    # 7. getProxyUrl 形态
    check('spider.getProxyUrl',
          sp.getProxyUrl() == f'http://127.0.0.1:{PORT}/proxy?do=py&siteKey=demo', sp.getProxyUrl())

    print()
    print(f'RESULT: {len(PASSED)} passed, {len(FAILED)} failed')
    srv.should_exit = True
    sys.exit(1 if FAILED else 0)


if __name__ == '__main__':
    main()
