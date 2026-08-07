# -*- coding: utf-8 -*-
"""PC 端宿主主服务（FastAPI）。

端点：
- GET  /health            健康检查（免 token）
- GET/POST /cache         spider 缓存协议 get/set/del（免 token，仅 127.0.0.1）
- GET/POST /proxy         spider localProxy 媒体代理（免 token）
- POST /action            内容 API + 面板指令（需 token）

本地文件面板（原 /file /upload 等占位）Phase 5 起改走 Electron 主进程
file-manager IPC，后端不再提供该组端点。

启动时打印：VPC_BACKEND_READY port=<p> token=<t>（供 python-bridge 解析）。
"""
import os
import sys
import json
import time
import socket
import secrets
import logging
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
# js-engine 目录名含连字符，直接加入 sys.path 按模块导入
_JS_ENGINE_DIR = os.path.join(BASE_DIR, 'js-engine')
if _JS_ENGINE_DIR not in sys.path:
    sys.path.insert(0, _JS_ENGINE_DIR)

import compat  # noqa: F401  # SourceFileLoader.load_module 兼容层（3.12+）
import hoststate

from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import FastAPI, Request, Response, Query, Form
from fastapi.responses import PlainTextResponse, JSONResponse, RedirectResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from cache_store import CacheStore
from site_manager import SiteManager
from config import ConfigManager
import app as spider_app

logger = logging.getLogger('vpc.server')

TOKEN_EXEMPT = ('/health', '/cache', '/proxy')

sites = SiteManager()
config_mgr = ConfigManager(sites)
cache_store = None  # create_app() 时初始化（依赖 hoststate 目录）

# Phase 4 弹幕队列：面板 do=danmaku 入队；主进程播放器轮询 /danmaku?do=poll 取走
_danmaku_queue = []
_danmaku_clock = time.time()

# 配置加载异步任务（多仓扫描可达分钟级，不能阻塞 /action 请求）
_config_task = {'status': 'idle', 'summary': None, 'msg': ''}


def _config_load_worker(text):
    try:
        summary = config_mgr.load(text)
        _config_task.update({'status': 'done', 'summary': summary, 'msg': ''})
        logger.info('config load done: %s sites', summary.get('sites'))
    except Exception as e:
        logger.exception('config load failed')
        _config_task.update({'status': 'error', 'summary': None, 'msg': str(e)})


def _config_load_async(text):
    """启动后台加载；已在加载中返回 None。"""
    if _config_task['status'] == 'loading':
        return None
    _config_task.update({'status': 'loading', 'summary': None, 'msg': ''})
    threading.Thread(target=_config_load_worker, args=(text,), daemon=True).start()
    return True


def _danmaku_reset():
    global _danmaku_clock
    _danmaku_queue.clear()
    _danmaku_clock = time.time()


# ---------------------------------------------------------------- 分发逻辑

def _site_or_error(form):
    site = sites.get(form.get('site') or None)
    if site is None:
        raise ValueError('no site loaded')
    return site


def _bool(v):
    return str(v).lower() in ('1', 'true', 'yes')


def _cache_paths():
    """缓存清理/统计涉及的路径：spider KV 目录 + JS 本地存储 + 下载缓存目录。"""
    return (
        os.path.join(hoststate.get_data_dir(), 'js_local.json'),
        os.path.join(hoststate.get_cache_dir(), 'dl'),
    )


def _dir_size(dirpath):
    total, items = 0, 0
    try:
        for root, _dirs, files in os.walk(dirpath):
            for fn in files:
                try:
                    total += os.path.getsize(os.path.join(root, fn))
                    items += 1
                except OSError:
                    pass
    except OSError:
        pass
    return total, items


def _cache_size():
    """统计全部缓存占用字节数与文件数（供前端清理前展示）。"""
    total, items = _dir_size(cache_store.dir)
    js_local, dl_cache = _cache_paths()
    if os.path.isfile(js_local):
        try:
            total += os.path.getsize(js_local)
            items += 1
        except OSError:
            pass
    if os.path.isdir(dl_cache):
        t, n = _dir_size(dl_cache)
        total += t
        items += n
    return total, items


def dispatch_action(form):
    """返回 (status_code, body_text)。spider 调用均为同步阻塞，由调用方放线程池。"""
    do = form.get('do', '')
    try:
        # ---- 面板指令（弹幕入队 / 配置热更新；推送已由主进程 push-server 接管）----
        if do == 'danmaku':
            text = form.get('text', '')
            if text:
                _danmaku_queue.append(text)
            logger.info('danmaku queued (%s in queue): %s', len(_danmaku_queue), text[:60])
            return 200, '{"code":200,"msg":"danmaku queued"}'
        if do == 'setting':
            name = form.get('name', '')
            text = form.get('text', '')
            if name in ('config', '配置') and text:
                if _config_load_async(text) is None:
                    return 409, '{"code":409,"msg":"config loading in progress"}'
                return 200, '{"code":202,"msg":"config loading"}'
            logger.info('setting: %s=%s', name, text)
            return 200, '{"code":200,"msg":"setting received"}'
        if do == 'loadConfig':
            if _config_load_async(form.get('url', '')) is None:
                return 409, '{"code":409,"msg":"config loading in progress"}'
            return 200, '{"code":202,"msg":"config loading"}'
        if do == 'configTask':
            return 200, json.dumps({'code': 200, **_config_task},
                                   ensure_ascii=False, default=str)
        if do == 'cacheSize':
            total, items = _cache_size()
            return 200, json.dumps({'code': 200, 'bytes': total, 'items': items})
        if do == 'clearCache':
            # 缓存清理：spider KV 缓存 + JS 本地存储 + 下载缓存目录（返回释放字节数）
            import shutil
            freed, _ = _cache_size()
            removed = cache_store.clear()
            extra = 0
            js_local, dl_cache = _cache_paths()
            if os.path.exists(js_local):
                try:
                    os.remove(js_local)
                    extra += 1
                except OSError:
                    pass
            if os.path.isdir(dl_cache):
                shutil.rmtree(dl_cache, ignore_errors=True)
                extra += 1
            logger.info('cache cleared: %s kv + %s extra (%s bytes)', removed, extra, freed)
            return 200, json.dumps({'code': 200, 'bytes': freed,
                                    'msg': '已删除 %d 项缓存' % (removed + extra)},
                                   ensure_ascii=False)
        if do == 'fetchText':
            # 直播源等外部文本拉取（渲染层直接 fetch 会被 CORS 拦截）
            from config import fetch_text
            text = fetch_text(form.get('url', ''))
            return 200, json.dumps({'code': 200, 'text': text[:500000]}, ensure_ascii=False)
        if do == 'file':
            logger.info('file play: %s', form.get('path'))
            return 200, '{"code":200,"msg":"file received"}'

        # ---- 多源聚合搜索（Phase 1 基础版：线程池并发 + 超时合并）----
        if do == 'search':
            word = form.get('word', '')
            return 200, json.dumps(aggregate_search(word), ensure_ascii=False)

        site = _site_or_error(form)
        ru = site.runner

        # ---- Spider 内容 API（契约见 PHASE0_依赖矩阵.md 第 3 节）----
        if do == 'homeContent':
            return 200, spider_app.homeContent(ru, _bool(form.get('filter', 'false')))
        if do == 'homeVideoContent':
            return 200, spider_app.homeVideoContent(ru)
        if do == 'categoryContent':
            return 200, spider_app.categoryContent(
                ru, form.get('tid', ''), form.get('pg', '1'),
                _bool(form.get('filter', 'false')), form.get('extend', '{}'))
        if do == 'detailContent':
            return 200, spider_app.detailContent(ru, form.get('ids', '[]'))
        if do == 'searchContent':
            return 200, spider_app.searchContent(
                ru, form.get('word', form.get('key', '')),
                form.get('quick', '0'), form.get('pg', '1'))
        if do == 'playerContent':
            return 200, spider_app.playerContent(
                ru, form.get('flag', ''), form.get('id', ''), form.get('vipFlags', '[]'))
        if do == 'liveContent':
            return 200, spider_app.liveContent(ru, form.get('url', ''))
        if do == 'action':
            return 200, spider_app.action(ru, form.get('action', '{}'))
        return 400, '{"code":400,"msg":"unknown do: %s"}' % json.dumps(do)
    except ValueError as e:
        return 404, '{"code":404,"msg":"%s"}' % e
    except Exception as e:
        logger.exception('dispatch error do=%s', do)
        return 500, '{"code":500,"msg":"%s"}' % str(e).replace('"', "'")


def _search_source_pages(runner, word, max_pages=50):
    """单源搜索拉全部页合并去重（T38：取消 3 页限制，CMS 源搜索接口
    服务端分页 limit=20）；遇空页/短页/整页无新增即停（防部分源伪分页死循环），
    max_pages 仅作安全防护上限，异常不抛。"""
    merged = []
    seen = set()
    for pg in range(1, max_pages + 1):
        try:
            data = json.loads(spider_app.searchContent(runner, word, '0', str(pg)))
        except Exception:
            break
        items = data.get('list') or []
        if not items:
            break
        added = 0
        for it in items:
            key = it.get('vod_id') or it.get('vod_name')
            if key in seen:
                continue
            seen.add(key)
            merged.append(it)
            added += 1
        if len(items) < 10:  # 短页视为末页（部分源 list 短于分页条数）
            break
        if added == 0:  # 整页全是重复：该源无真实分页，停
            break
    return merged


def aggregate_search(word, timeout=60):
    """线程池并发搜索全部可搜站点（T38 起单源拉全部页，耗时变长放宽超时），
    单源超时/异常不拖累整体。"""
    merged = []
    site_list = [s for s in sites.sites if getattr(s, 'searchable', True)]
    if not site_list or not word:
        return {'list': merged}
    with ThreadPoolExecutor(max_workers=min(8, len(site_list))) as pool:
        futures = {
            pool.submit(_search_source_pages, s.runner, word): s
            for s in site_list
        }
        for fut, s in futures.items():
            try:
                items = fut.result(timeout=timeout)
                for item in items:
                    item.setdefault('source', s.key)
                    merged.append(item)
            except Exception as e:
                logger.warning('search source %s failed: %s', s.key, e)
    return {'list': merged}


def do_local_proxy(param):
    param = dict(param)
    site = sites.get(param.pop('site', None))
    if site is None:
        return None
    return site.runner.localProxy(param)


def build_proxy_response(result):
    if result is None:
        return Response(status_code=404)
    if isinstance(result, str):
        return RedirectResponse(result, status_code=302)
    if isinstance(result, (list, tuple)) and len(result) >= 2:
        code = int(result[0])
        mime = result[1]
        body = result[2] if len(result) > 2 else b''
        if hasattr(body, 'content'):      # requests.Response
            body = body.content
        elif isinstance(body, str):
            body = body.encode('utf-8')
        headers = result[3] if len(result) > 3 and isinstance(result[3], dict) else None
        return Response(content=body, status_code=code, media_type=mime, headers=headers)
    if isinstance(result, dict):
        return JSONResponse(result)
    return Response(content=str(result).encode('utf-8'))


# ---------------------------------------------------------------- 应用装配

def create_app():
    global cache_store
    cache_store = CacheStore(os.path.join(hoststate.get_cache_dir(), 'kv'))
    fastapi_app = FastAPI(title='video-pc backend')

    @fastapi_app.middleware('http')
    async def token_auth(request: Request, call_next):
        path = request.url.path
        if not path.startswith(TOKEN_EXEMPT):
            token = request.headers.get('x-token') or request.query_params.get('token')
            if token != hoststate.get_token():
                return JSONResponse({'code': 401, 'msg': 'invalid token'}, status_code=401)
        return await call_next(request)

    @fastapi_app.get('/health')
    def health():
        return {'status': 'ok', 'sites': [s.key for s in sites.sites]}

    @fastapi_app.get('/sites')
    def sites_state():
        return config_mgr.state()

    @fastapi_app.api_route('/danmaku', methods=['GET', 'POST'])
    def danmaku_endpoint(do: str = Query('poll'), text: str = Form('')):
        """Phase 4 弹幕中转：do=post 入队；do=reset 起播时清队重置时钟；
        do=poll 取走全部并返回相对上一批的时间偏移 baseSec（供 ASS 定位）。"""
        global _danmaku_clock
        if do == 'post':
            if text:
                _danmaku_queue.append(text)
            return JSONResponse({'code': 200, 'queued': len(_danmaku_queue)})
        if do == 'reset':
            _danmaku_reset()
            return JSONResponse({'code': 200})
        items = list(_danmaku_queue)
        _danmaku_queue.clear()
        base = time.time() - _danmaku_clock
        _danmaku_clock = time.time()
        return JSONResponse({'items': items, 'baseSec': round(base, 2)})

    @fastapi_app.get('/search/stream')
    def search_stream(word: str = Query('')):
        """SSE 流式聚合搜索：每个源完成即推一条 data，全部结束发 event: done。"""
        def gen():
            site_list = [s for s in sites.sites if getattr(s, 'searchable', True)]
            if not word or not site_list:
                yield 'event: done\ndata: {}\n\n'
                return
            with ThreadPoolExecutor(max_workers=min(8, len(site_list))) as pool:
                futures = {
                    pool.submit(_search_source_pages, s.runner, word): s
                    for s in site_list
                }
                try:
                    # T38：单源拉全部页耗时变长，放宽到 120s；超时仍发 done 事件防前端挂死
                    for fut in as_completed(futures, timeout=120):
                        s = futures[fut]
                        try:
                            items = fut.result(timeout=0.1)
                        except Exception as e:
                            logger.warning('sse search source %s failed: %s', s.key, e)
                            items = []
                        payload = json.dumps({'source': s.key, 'name': s.name, 'list': items},
                                             ensure_ascii=False)
                        yield f'data: {payload}\n\n'
                except Exception as e:
                    logger.warning('sse search overall timeout: %s', e)
            yield 'event: done\ndata: {}\n\n'
        return StreamingResponse(gen(), media_type='text/event-stream')

    @fastapi_app.api_route('/cache', methods=['GET', 'POST'])
    def cache_endpoint(do: str = Query('get'), key: str = Query(''),
                       value: str = Form('')):
        if do == 'set':
            cache_store.set(key, value)
        elif do == 'del':
            cache_store.delete(key)
        else:
            return PlainTextResponse(cache_store.get(key))
        return PlainTextResponse('')

    @fastapi_app.api_route('/proxy', methods=['GET', 'POST'])
    async def proxy_endpoint(request: Request):
        param = dict(request.query_params)
        if request.method == 'POST':
            param.update(dict(await request.form()))
        result = await run_in_threadpool(do_local_proxy, param)
        return build_proxy_response(result)

    @fastapi_app.api_route('/action', methods=['POST'])
    async def action_endpoint(request: Request):
        form = {k: v for k, v in (await request.form()).items()}
        status, body = await run_in_threadpool(dispatch_action, form)
        return PlainTextResponse(body, status_code=status,
                                 media_type='application/json; charset=utf-8')

    return fastapi_app


def load_default_sites():
    demo_path = os.path.join(BASE_DIR, 'spiders', 'demo.py')
    if os.path.exists(demo_path):
        try:
            sites.load_local('demo', demo_path)
        except Exception:
            logger.exception('load demo site failed')


def pick_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(name)s %(levelname)s %(message)s')
    port = int(os.environ.get('VPC_PORT') or pick_free_port())
    token = os.environ.get('VPC_TOKEN') or secrets.token_hex(16)
    hoststate.configure(port=port, token=token)
    # 自定义缓存目录（主进程设置页指定，经 VPC_CACHE_DIR 传入）；py 插件目录跟随
    cache_dir = os.environ.get('VPC_CACHE_DIR')
    if cache_dir:
        hoststate.configure(cache_dir=cache_dir,
                            plugins_dir=os.path.join(cache_dir, 'py'))
    hoststate.ensure_dirs()
    load_default_sites()
    fastapi_app = create_app()
    print(f'VPC_BACKEND_READY port={port} token={token}', flush=True)
    import uvicorn
    uvicorn.run(fastapi_app, host='127.0.0.1', port=port, log_level='warning')


if __name__ == '__main__':
    main()
