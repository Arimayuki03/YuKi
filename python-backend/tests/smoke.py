# -*- coding: utf-8 -*-
"""Phase 1 冒烟测试：在进程内拉起后端，逐项验证核心端点。

覆盖：/health、token 鉴权、/action 内容 API、/cache 协议（含 spider
HTTP 回环 setCache/getCache/delCache）、/proxy localProxy。
用法：<venv>/python tests/smoke.py
"""
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.parse

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)


def _pick_port(preferred):
    """优先用固定端口；被占用或被 Windows 保留端口区间拒绝（WinError 10013）时退回系统空闲端口。"""
    for port in (preferred, 0):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(('127.0.0.1', port))
            return s.getsockname()[1]
        except OSError:
            if port == 0:
                raise
        finally:
            s.close()


TOKEN = 'smoke-token'

import hoststate  # noqa: E402
import play_cache  # noqa: E402


# 父进程已选定端口时直接复用：multiprocessing spawn 会把本模块顶层在 worker
# 子进程重跑一遍（__mp_main__），若重新 _pick_port 会得到与宿主不同的端口，
# worker 里 spider 的 HTTP 回环（setCache/getCache/代理）就会打到死端口。
def _host_setup():
    """宿主侧一次性初始化（只在 __main__ 进程跑）。

    P1-5 / P3-19-③：此前 port/token 的 hoststate.configure、YUKI_PORT/TOKEN
    环境变量、play_cache 目录重定向全部写在模块顶层——spawn 出的 Worker
    子进程复跑这段（__mp_main__），Worker 里 hoststate 被顶层面数「顺手」
    配好，恰好掩盖了「Worker 进程 hoststate 全空」的真实缺口（KV 打到 :0、
    getProxyUrl 产出坏地址、JVM token 为空）。现在宿主初始化收进本函数
    （由 main() 调用），Worker 子进程的 hoststate 必须由
    supervised_runner.spec 注入 + site_worker._build 自行 configure（P1-5
    修复）自给，冒烟断言 #7/#7.5 对此直接验收。
    """
    port = int(os.environ.get('YUKI_PORT') or 0) or _pick_port(8321)
    os.environ['YUKI_PORT'] = str(port)
    os.environ['YUKI_TOKEN'] = TOKEN

    hoststate.configure(port=port, token=TOKEN)
    hoststate.ensure_dirs()

    # RM-4：playerContent 持久缓存测试专用目录（避免污染真实 ~/.yuki/cache）。
    # 单例惰性解析，必须在首个 playerContent 请求前重定向。
    play_cache.set_dir_for_tests(tempfile.mkdtemp(prefix='yuki-smoke-playcache-'))
    return port


if __name__ == '__main__':
    # 仅宿主进程执行；spawn 的 Worker 子进程（__mp_main__）不得复跑这段。
    PORT = _host_setup()

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

    # 3.1 RM-4：解析结果持久缓存——内存层清空后由 play-cache 供数；refresh=1 穿透
    PC_KEY = 'demo|demo|demo://ep1|[]'
    PC_SENTINEL = json.dumps({'url': 'https://persisted.example/hit.mp4'})
    play_cache.store_result(PC_KEY, PC_SENTINEL)
    server._player_content_cache.clear()
    code, body = req('POST', '/action',
                     data={'do': 'playerContent', 'flag': 'demo', 'id': 'demo://ep1', 'vipFlags': '[]'})
    data = json.loads(body)
    check('playerContent persists-cache hit (memory cleared)',
          code == 200 and data.get('url') == 'https://persisted.example/hit.mp4', body[:120])
    code, body = req('POST', '/action',
                     data={'do': 'playerContent', 'flag': 'demo', 'id': 'demo://ep1',
                           'vipFlags': '[]', 'refresh': '1'})
    data = json.loads(body)
    check('playerContent refresh=1 bypasses persist cache',
          code == 200 and data.get('url') == 'https://media.w3.org/2010/05/sintel/trailer.mp4', body[:120])
    check('playerContent refresh=1 repopulates persist cache',
          play_cache.get_result(PC_KEY) is not None and play_cache.get_result(PC_KEY) != PC_SENTINEL,
          repr(play_cache.get_result(PC_KEY))[:120])

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

    # 7.5 P1-5：Worker 进程 hoststate 必须由 spec 注入自给（supervised_runner
    # setdefault + site_worker._build configure）。此前 smoke 顶层 configure 被
    # spawn 子进程复跑（__mp_main__）恰好掩盖该缺口——现在顶层不再 configure，
    # Worker 侧全空就会在这里现形：KV 回环打到 :0、getProxyUrl 端口为 0。
    # Worker 侧真实观感取自 Worker 进程内的 getProxyUrl 返回值（而非宿主
    # hoststate），端口非 0 且与宿主一致 = 注入链路生效。
    worker_proxy_url = ''
    try:
        raw = sp.getProxyUrl()
        # sp.getProxyUrl 经 RPC 到 Worker：spider 基类在 Worker 进程里用
        # Worker 自己的 hoststate 拼地址，返回值即 Worker 侧真实观感。
        worker_proxy_url = str(raw or '')
    except Exception as e:  # Worker hoststate 全空时 KV/代理调用会失败
        check('worker hoststate injected (P1-5)', False, f'getProxyUrl failed: {e}')
    else:
        from urllib.parse import urlsplit as _urlsplit
        try:
            worker_port = _urlsplit(worker_proxy_url).port or 0
        except ValueError:
            worker_port = 0
        check('worker hoststate injected (P1-5)',
              worker_port == PORT,
              f'worker getProxyUrl={worker_proxy_url!r} expected port {PORT}')

    print()
    print(f'RESULT: {len(PASSED)} passed, {len(FAILED)} failed')
    srv.should_exit = True
    sys.exit(1 if FAILED else 0)


if __name__ == '__main__':
    main()
