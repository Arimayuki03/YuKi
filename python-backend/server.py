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
from logging.handlers import RotatingFileHandler
import re
import threading

# 抑制 urllib3 InsecureRequestWarning（PC 端大量 verify=False 请求）
try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass

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

# Kazumi 规则引擎（与 CatVod 隔离，独立模块）
from kazumi.plugin_manager import PluginManager
from kazumi.plugin import Plugin
from kazumi.rule_engine import RuleEngine
from kazumi.cookie_jar import CookieJar

logger = logging.getLogger('vpc.server')

TOKEN_EXEMPT = ('/health', '/cache', '/proxy')

sites = SiteManager()
config_mgr = ConfigManager(sites)
cache_store = None  # create_app() 时初始化（依赖 hoststate 目录）

# Kazumi 规则引擎实例（create_app 时初始化）
kazumi_mgr = None
kazumi_engine = None
kazumi_cookies = None

# Phase 4 弹幕队列：面板 do=danmaku 入队；主进程播放器轮询 /danmaku?do=poll 取走
_danmaku_queue = []
_danmaku_clock = time.time()

# 配置加载异步任务（多仓扫描可达分钟级，不能阻塞 /action 请求）
_config_task = {'status': 'idle', 'summary': None, 'msg': ''}

# playerContent 结果缓存（key=site|flag|id → {result, ts}，60s 有效期）
# 换线路又切回原线路时避免重复解析
_player_content_cache = {}
_PLAYER_CACHE_TTL = 60


class _RedactingFormatter(logging.Formatter):
    """在最终格式化文本上遮盖令牌、Cookie、Authorization 和密码。"""

    _patterns = (
        (re.compile(r'([?&](?:token|access_token|refresh_token|api[_-]?key|secret|password)=)[^&#\s]*', re.I), r'\1[REDACTED]'),
        (re.compile(r'((?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,;]+', re.I), r'\1[REDACTED]'),
        (re.compile(r'((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]*', re.I), r'\1[REDACTED]'),
        (re.compile(r'((?:password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*)[\'\"]?[^\s,\'\"}\]]+', re.I), r'\1[REDACTED]'),
    )

    def format(self, record):
        text = super().format(record)
        for pattern, replacement in self._patterns:
            text = pattern.sub(replacement, text)
        return text


def _setup_logging():
    """控制台 + UTF-8 轮转文件；单文件 5 MiB，保留 5 份。"""
    log_dir = os.environ.get('VPC_LOG_DIR') or hoststate.get_log_dir()
    os.makedirs(log_dir, exist_ok=True)
    formatter = _RedactingFormatter('%(asctime)s %(name)s %(levelname)s %(message)s')
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(logging.INFO)
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    root.addHandler(console)
    rotating = RotatingFileHandler(
        os.path.join(log_dir, 'python-backend.log'),
        maxBytes=5 * 1024 * 1024,
        backupCount=5,
        encoding='utf-8',
    )
    rotating.setFormatter(formatter)
    root.addHandler(rotating)

    def log_uncaught(exc_type, exc_value, exc_traceback):
        if issubclass(exc_type, KeyboardInterrupt):
            return sys.__excepthook__(exc_type, exc_value, exc_traceback)
        logger.critical('uncaught exception', exc_info=(exc_type, exc_value, exc_traceback))

    sys.excepthook = log_uncaught
    if hasattr(threading, 'excepthook'):
        threading.excepthook = lambda args: logger.critical(
            'uncaught thread exception: %s', args.thread.name,
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback))
    logger.info('Python backend logging started: %s', log_dir)


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
            return 200, spider_app.homeVideoContent(ru, form.get('pg', '1'))
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
            # 60s 缓存：换线路又切回原线路时跳过重复解析
            cache_key = f"{site.key}|{form.get('flag', '')}|{form.get('id', '')}"
            cached = _player_content_cache.get(cache_key)
            if cached and (time.time() - cached['ts']) < _PLAYER_CACHE_TTL:
                return 200, cached['result']
            result = spider_app.playerContent(
                ru, form.get('flag', ''), form.get('id', ''), form.get('vipFlags', '[]'))
            _player_content_cache[cache_key] = {'result': result, 'ts': time.time()}
            # 防无限增长，超过 1024 项时清理过期项
            if len(_player_content_cache) > 1024:
                now = time.time()
                stale = [k for k, v in _player_content_cache.items() if (now - v['ts']) > _PLAYER_CACHE_TTL]
                for k in stale:
                    del _player_content_cache[k]
            return 200, result
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


def _guess_image_type(raw):
    """按文件头判断图片类型（trace.moe 上传需正确 Content-Type；Kazumi 硬编码 jpeg，PNG 会被拒）。"""
    if not raw:
        return 'image/jpeg'
    if raw[:2] == b'\xff\xd8':
        return 'image/jpeg'
    if raw[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    if raw[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'image/webp'
    return 'image/jpeg'


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
    global cache_store, kazumi_mgr, kazumi_engine, kazumi_cookies
    cache_store = CacheStore(os.path.join(hoststate.get_cache_dir(), 'kv'))
    kazumi_mgr = PluginManager()
    kazumi_cookies = CookieJar()
    kazumi_engine = RuleEngine(cookie_jar=kazumi_cookies)
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
        return {'status': 'ok', 'sites': [s.key for s in sites.sites],
                'kazumiRules': kazumi_mgr.list_all() if kazumi_mgr else []}

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
        """SSE 流式聚合搜索：先发 event: meta（总源数，供前端确定进度条），每源完成推一条 data，全部结束发 event: done。"""
        def gen():
            site_list = [s for s in sites.sites if getattr(s, 'searchable', True)]
            if not word or not site_list:
                yield 'event: done\ndata: {}\n\n'
                return
            yield f'event: meta\ndata: {json.dumps({"total": len(site_list)})}\n\n'
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

    @fastapi_app.get('/search/kazumi-stream')
    def kazumi_search_stream(word: str = Query('')):
        """SSE 流式 Kazumi 规则源搜索（T73）：每个规则源完成即推一条 data，全部结束发 event: done。
        结果项与 kazumiSearch 一致（{pluginName, data}）；验证码源带 captcha/captchaUrl。"""
        def gen():
            if not word:
                yield 'event: done\ndata: {}\n\n'
                return
            plugins = list(kazumi_mgr.enabled_plugins())
            if not plugins:
                yield 'event: done\ndata: {}\n\n'
                return

            def _search_one(plugin):
                try:
                    trace = kazumi_engine.search_with_captcha_retry(plugin.execution_config(), word)
                    if isinstance(trace, dict) and trace.get('captcha_required'):
                        return {'pluginName': plugin.name, 'captcha': True, 'captchaUrl': trace.get('captcha_url', '')}
                    data = [vars(it) for it in trace.response.data]
                    return {'pluginName': plugin.name, 'data': data, 'status': 'success' if data else 'noresult'}
                except Exception as e:
                    logger.warning('[kazumi] kazumi-search-stream failed: %s: %s', plugin.name, e)
                    return {'pluginName': plugin.name, 'error': True, 'msg': str(e)[:80]}

            with ThreadPoolExecutor(max_workers=min(8, len(plugins))) as pool:
                futures = {pool.submit(_search_one, p): p for p in plugins}
                for fut in as_completed(futures, timeout=120):
                    r = fut.result(timeout=0.1)
                    if r is None:
                        continue
                    payload = json.dumps({
                        'source': 'kazumi:' + r['pluginName'], 'name': r['pluginName'],
                        'list': r.get('data', []),
                        'status': r.get('captcha') and 'captcha' or r.get('status') or ('error' if r.get('error') else 'noresult'),
                        'captcha': r.get('captcha') or False,
                        'captchaUrl': r.get('captchaUrl', ''),
                        'msg': r.get('msg', ''),
                    }, ensure_ascii=False)
                    yield f'data: {payload}\n\n'
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

    # ------------------------------------------------------------ Kazumi 规则引擎端点

    @fastapi_app.api_route('/kazumi/action', methods=['POST'])
    async def kazumi_action_endpoint(request: Request):
        form = {k: v for k, v in (await request.form()).items()}
        status, body = await run_in_threadpool(dispatch_kazumi_action, form)
        return PlainTextResponse(body, status_code=status,
                                 media_type='application/json; charset=utf-8')

    return fastapi_app


def dispatch_kazumi_action(form):
    """Kazumi 规则引擎端点分发（与 CatVod /action 物理隔离）。"""
    do = form.get('do', '')
    try:
        if do == 'kazumiList':
            return 200, json.dumps({'code': 200, 'list': kazumi_mgr.list_all()}, ensure_ascii=False)

        if do == 'kazumiAdd':
            raw = form.get('json', '')
            plugin = Plugin.from_json(raw)
            ok, msg = kazumi_mgr.add(plugin)
            return (200 if ok else 400), json.dumps({'code': 200 if ok else 400, 'msg': msg}, ensure_ascii=False)

        if do == 'kazumiRemove':
            name = form.get('name', '')
            ok = kazumi_mgr.remove(name)
            return (200 if ok else 404), json.dumps({'code': 200 if ok else 404, 'msg': 'ok' if ok else 'not found'}, ensure_ascii=False)

        if do == 'kazumiGet':
            name = form.get('name', '')
            plugin = kazumi_mgr.get(name)
            if not plugin:
                return 404, json.dumps({'code': 404, 'msg': 'not found'}, ensure_ascii=False)
            return 200, json.dumps({'code': 200, 'rule': plugin.to_json()}, ensure_ascii=False)

        if do == 'kazumiToggle':
            name = form.get('name', '')
            enabled = form.get('enabled', '1').lower() in ('1', 'true', 'yes')
            ok = kazumi_mgr.toggle(name, enabled)
            return (200 if ok else 404), json.dumps({'code': 200 if ok else 404, 'msg': 'ok' if ok else 'not found'}, ensure_ascii=False)

        if do == 'kazumiReorder':
            try:
                names = json.loads(form.get('names', '[]') or '[]')
            except Exception:
                names = []
            ok, msg = kazumi_mgr.reorder(names)
            return (200 if ok else 400), json.dumps({'code': 200 if ok else 400, 'msg': msg}, ensure_ascii=False)

        if do == 'kazumiSetMirror':
            bangumi = form.get('bangumi', '')
            git = form.get('git', '')
            state = kazumi_mgr.set_mirror(
                bangumi=bangumi.lower() in ('1', 'true', 'yes') if bangumi != '' else None,
                git=git.lower() in ('1', 'true', 'yes') if git != '' else None,
            )
            return 200, json.dumps({'code': 200, 'mirror': state}, ensure_ascii=False)

        if do == 'kazumiSearch':
            keyword = form.get('keyword', '')
            plugin_filter = form.get('plugin', '').strip()
            if not keyword:
                return 200, json.dumps({'code': 200, 'results': []}, ensure_ascii=False)
            plugins = list(kazumi_mgr.enabled_plugins())
            if plugin_filter:
                # 单源重查（SourceSheet 别名/手动/重试/验证后重试）
                plugins = [p for p in plugins if p.name == plugin_filter]
            results = [None] * len(plugins)
            def _search_one(idx, plugin):
                try:
                    trace = kazumi_engine.search_with_captcha_retry(plugin.execution_config(), keyword)
                    if isinstance(trace, dict) and trace.get('captcha_required'):
                        results[idx] = {'pluginName': plugin.name, 'captcha': True, 'captchaUrl': trace.get('captcha_url', '')}
                    else:
                        data = [vars(it) for it in trace.response.data]
                        results[idx] = {'pluginName': plugin.name, 'data': data, 'status': 'success' if data else 'noresult'}
                        logger.info('[kazumi] search ok: %s (%d items)', plugin.name, len(data))
                except Exception as e:
                    logger.warning('[kazumi] search failed: %s: %s', plugin.name, e)
                    results[idx] = {'pluginName': plugin.name, 'error': True, 'msg': str(e)[:80]}
            with ThreadPoolExecutor(max_workers=min(8, len(plugins))) as pool:
                pool.map(lambda args: _search_one(*args), enumerate(plugins))
            return 200, json.dumps({'code': 200, 'results': [r for r in results if r is not None]}, ensure_ascii=False)

        if do == 'kazumiChapters':
            plugin_name = form.get('pluginName', '')
            src = form.get('src', '')
            plugin = kazumi_mgr.get(plugin_name)
            if not plugin:
                return 404, json.dumps({'code': 404, 'msg': 'plugin not found'}, ensure_ascii=False)
            trace = kazumi_engine.query_chapters(plugin.execution_config(), src)
            return 200, json.dumps({'code': 200, 'roads': [
                {'name': r.name, 'data': r.data, 'identifier': r.identifier}
                for r in trace.roads
            ]}, ensure_ascii=False)

        if do == 'kazumiResolve':
            plugin_name = form.get('pluginName', '')
            url = form.get('url', '')
            plugin = kazumi_mgr.get(plugin_name)
            if not plugin:
                return 404, json.dumps({'code': 404, 'msg': 'plugin not found'}, ensure_ascii=False)
            # 返回播放页 URL 与规则 headers，由前端 Player 走 captureDirect
            headers = plugin.build_http_headers()
            return 200, json.dumps({
                'code': 200,
                'pageUrl': plugin.build_full_url(url),
                'userAgent': headers.get('user-agent', ''),
                'referer': headers.get('referer', ''),
                # 旧解析器标记：useLegacyParser=true 时前端走 iframe src 监听而非媒体请求拦截
                'useLegacyParser': bool(plugin.use_legacy_parser),
            }, ensure_ascii=False)

        # ---- 在线规则商店 ----
        if do == 'kazumiShopCatalog':
            catalog = kazumi_mgr.fetch_shop_catalog()
            return 200, json.dumps({'code': 200, 'catalog': catalog}, ensure_ascii=False)

        if do == 'kazumiShopInstall':
            name = form.get('name', '')
            if not name:
                return 400, json.dumps({'code': 400, 'msg': 'name required'}, ensure_ascii=False)
            plugin = kazumi_mgr.fetch_shop_rule(name)
            if not plugin:
                return 404, json.dumps({'code': 404, 'msg': 'rule not found or download failed'}, ensure_ascii=False)
            ok, msg = kazumi_mgr.add(plugin)
            return (200 if ok else 400), json.dumps({'code': 200 if ok else 400, 'msg': msg}, ensure_ascii=False)

        # ---- 规则有效性检测 / 批量更新 ----
        if do == 'kazumiCheckValidity':
            keyword = form.get('keyword', '') or '海贼王'
            names = [n for n in form.get('names', '').split(',') if n] or None
            started = kazumi_mgr.start_validity_check(kazumi_engine, keyword=keyword, names=names)
            return (200 if started else 409), json.dumps(
                {'code': 200 if started else 409, 'started': started}, ensure_ascii=False)

        if do == 'kazumiValidityStatus':
            return 200, json.dumps({'code': 200, **kazumi_mgr.validity_status()}, ensure_ascii=False)

        if do == 'kazumiBatchUpdate':
            names = [n for n in form.get('names', '').split(',') if n] or None
            started = kazumi_mgr.start_batch_update(names=names)
            return (200 if started else 409), json.dumps(
                {'code': 200 if started else 409, 'started': started}, ensure_ascii=False)

        if do == 'kazumiUpdateStatus':
            return 200, json.dumps({'code': 200, **kazumi_mgr.update_status()}, ensure_ascii=False)

        # ---- Cookie 持久化（PluginCookieManager） ----
        if do == 'kazumiCookieSet':
            domain = form.get('domain', '').strip()
            raw = form.get('cookies', '')
            try:
                cookies = json.loads(raw) if raw else []
            except Exception:
                cookies = []
            if not domain:
                return 400, json.dumps({'code': 400, 'msg': 'domain required'}, ensure_ascii=False)
            kazumi_cookies.set_domain_cookies(domain, cookies)
            return 200, json.dumps({'code': 200, 'ok': True}, ensure_ascii=False)

        if do == 'kazumiCookieList':
            return 200, json.dumps({'code': 200, 'cookies': kazumi_cookies.list_all(),
                                    'count': sum(len(v) for v in kazumi_cookies.list_all().values())}, ensure_ascii=False)

        if do == 'kazumiCookieClear':
            kazumi_cookies.clear()
            return 200, json.dumps({'code': 200, 'ok': True}, ensure_ascii=False)

        # ---- Bangumi 元数据 ----
        if do == 'kazumiBangumiSearch':
            keyword = form.get('keyword', '')
            limit = int(form.get('limit', '10'))
            results = kazumi_mgr.bangumi_search(keyword, limit)
            return 200, json.dumps({'code': 200, 'results': results}, ensure_ascii=False)

        if do == 'kazumiBangumiInfo':
            subject_id = form.get('id', '')
            info = kazumi_mgr.bangumi_info(subject_id)
            return 200, json.dumps({'code': 200, 'info': info}, ensure_ascii=False)

        if do == 'kazumiBangumiCalendar':
            data = kazumi_mgr.bangumi_calendar()
            return 200, json.dumps({'code': 200, 'calendar': data}, ensure_ascii=False)

        if do == 'kazumiBangumiSeason':
            start = form.get('start', '')
            end = form.get('end', '')
            data = kazumi_mgr.bangumi_season_calendar(start, end)
            return 200, json.dumps({'code': 200, 'calendar': data}, ensure_ascii=False)

        if do == 'kazumiBangumiTrends':
            limit = int(form.get('limit', '24'))
            offset = int(form.get('offset', '0'))
            data = kazumi_mgr.bangumi_trends(min(limit, 50), max(offset, 0))
            return 200, json.dumps({'code': 200, 'trends': data.get('items', []), 'total': data.get('total', 0)}, ensure_ascii=False)

        if do == 'kazumiBangumiListByTag':
            tag = form.get('tag', '')
            limit = int(form.get('limit', '100'))
            offset = int(form.get('offset', '0'))
            data = kazumi_mgr.bangumi_list_by_tag(tag, min(limit, 200), max(offset, 0))
            return 200, json.dumps({'code': 200, 'items': data.get('items', []), 'total': data.get('total', 0)}, ensure_ascii=False)

        if do == 'kazumiBangumiEpisodes':
            subject_id = form.get('id', '')
            data = kazumi_mgr.bangumi_episodes(subject_id)
            return 200, json.dumps({'code': 200, 'episodes': data}, ensure_ascii=False)

        if do == 'kazumiBangumiCharacters':
            subject_id = form.get('id', '')
            data = kazumi_mgr.bangumi_characters(subject_id)
            return 200, json.dumps({'code': 200, 'characters': data}, ensure_ascii=False)

        if do == 'kazumiBangumiCharacter':
            character_id = form.get('id', '')
            info = kazumi_mgr.bangumi_character_detail(character_id)
            return 200, json.dumps({'code': 200, 'info': info}, ensure_ascii=False)

        if do == 'kazumiBangumiStaff':
            subject_id = form.get('id', '')
            data = kazumi_mgr.bangumi_staff(subject_id)
            return 200, json.dumps({'code': 200, 'staff': data}, ensure_ascii=False)

        if do == 'kazumiBangumiComments':
            subject_id = form.get('id', '')
            limit = int(form.get('limit', '20'))
            offset = int(form.get('offset', '0'))
            data = kazumi_mgr.bangumi_comments(subject_id, limit, offset)
            return 200, json.dumps({'code': 200, 'comments': data}, ensure_ascii=False)

        if do == 'kazumiBangumiRelations':
            subject_id = form.get('id', '')
            data = kazumi_mgr.bangumi_relations(subject_id)
            return 200, json.dumps({'code': 200, 'relations': data}, ensure_ascii=False)

        # ---- Bangumi 用户收藏同步（需 token） ----
        if do == 'kazumiBangumiMe':
            token = form.get('token', '')
            me = kazumi_mgr.bangumi_me(token)
            return 200, json.dumps({'code': 200, 'me': me, 'valid': bool(me)}, ensure_ascii=False)

        if do == 'kazumiBangumiCollections':
            token = form.get('token', '')
            limit = int(form.get('limit', '100'))
            items = kazumi_mgr.bangumi_user_collections(token, limit=min(limit, 200))
            return 200, json.dumps({'code': 200, 'items': items}, ensure_ascii=False)

        if do == 'kazumiBangumiCollectionGet':
            token = form.get('token', '')
            subject_id = form.get('id', '')
            info = kazumi_mgr.bangumi_collection(token, subject_id)
            return 200, json.dumps({'code': 200, 'collection': info}, ensure_ascii=False)

        if do == 'kazumiBangumiCollectionSet':
            token = form.get('token', '')
            subject_id = form.get('id', '')
            ctype = int(form.get('type', '0'))
            ok, msg = kazumi_mgr.bangumi_update_collection(token, subject_id, ctype)
            return (200 if ok else 400), json.dumps({'code': 200 if ok else 400, 'msg': msg}, ensure_ascii=False)

        if do == 'kazumiBangumiCollectionDel':
            token = form.get('token', '')
            subject_id = form.get('id', '')
            ok, msg = kazumi_mgr.bangumi_delete_collection(token, subject_id)
            return (200 if ok else 400), json.dumps({'code': 200 if ok else 400, 'msg': msg}, ensure_ascii=False)

        # ---- 弹弹 play 弹幕 ----
        if do == 'kazumiDanmakuSearch':
            title = form.get('title', '')
            results = kazumi_mgr.danmaku_search(title)
            return 200, json.dumps({'code': 200, 'results': results}, ensure_ascii=False)

        if do == 'kazumiDanmakuEpisode':
            bangumi_id = int(form.get('bangumiId', '0'))
            episode = int(form.get('episode', '1'))
            episode_id = kazumi_mgr.danmaku_get_episode_id(bangumi_id, episode)
            return 200, json.dumps({'code': 200, 'episodeId': episode_id}, ensure_ascii=False)

        if do == 'kazumiDanmakuComments':
            episode_id = int(form.get('episodeId', '0'))
            comments = kazumi_mgr.danmaku_get_comments(episode_id)
            return 200, json.dumps({'code': 200, 'comments': comments}, ensure_ascii=False)

        # ---- 以图搜番（trace.moe） ----
        if do == 'kazumiImageSearch':
            # 前端上传图片 base64 或 URL（对齐 Kazumi trace_api.dart：POST + anilistInfo=2 取完整元数据）
            # T74 修复：trace.moe URL 搜索返回 403（反爬/需它自行抓取），统一改为后端先下载字节再原始上传；
            # Content-Type 按文件头判断（Kazumi 硬编码 jpeg，PNG 上传会被拒）。
            image_url = form.get('url', '')
            image_b64 = form.get('base64', '')
            results = []
            error = ''
            try:
                import requests as req
                ua = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'}
                raw = None
                if image_url:
                    ir = req.get(image_url, timeout=15, verify=False, headers=ua)
                    ir.raise_for_status()
                    raw = ir.content
                elif image_b64:
                    import base64
                    raw = base64.b64decode(image_b64)
                if raw:
                    rsp = req.post('https://api.trace.moe/search', params={'anilistInfo': 2},
                                   data=raw, headers={**ua, 'Content-Type': _guess_image_type(raw)},
                                   timeout=20, verify=False)
                    if rsp.status_code != 200:
                        error = f'trace.moe {rsp.status_code}'
                    else:
                        results = (rsp.json().get('result') or []) if rsp.headers.get('content-type', '').startswith('application/json') else []
                else:
                    error = '未收到图片'
            except Exception as e:
                logger.warning('[kazumi] image search failed: %s', e)
                error = str(e)[:100]
            return 200, json.dumps({'code': 200, 'results': results, 'error': error}, ensure_ascii=False)

        # ---- WebDAV 同步 ----
        if do == 'kazumiWebdavSync':
            url = form.get('url', '')
            username = form.get('username', '')
            password = form.get('password', '')
            data_str = form.get('data', '{}')
            try:
                data = json.loads(data_str)
            except Exception:
                data = {}
            ok = kazumi_mgr.webdav_sync(url, username, password, data)
            return (200 if ok else 500), json.dumps({'code': 200 if ok else 500, 'msg': 'sync ok' if ok else 'sync failed'}, ensure_ascii=False)

        if do == 'kazumiWebdavRestore':
            url = form.get('url', '')
            username = form.get('username', '')
            password = form.get('password', '')
            names_str = form.get('names', '[]')
            try:
                names = json.loads(names_str)
            except Exception:
                names = []
            result = kazumi_mgr.webdav_restore(url, username, password, names)
            return 200, json.dumps({'code': 200, 'data': result}, ensure_ascii=False)

        return 400, json.dumps({'code': 400, 'msg': f'unknown do: {do}'}, ensure_ascii=False)
    except Exception as e:
        logger.exception('[kazumi] dispatch error do=%s', do)
        return 500, json.dumps({'code': 500, 'msg': str(e).replace('"', "'")}, ensure_ascii=False)


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
    port = int(os.environ.get('VPC_PORT') or pick_free_port())
    token = os.environ.get('VPC_TOKEN') or secrets.token_hex(16)
    hoststate.configure(port=port, token=token)
    # 自定义缓存目录（主进程设置页指定，经 VPC_CACHE_DIR 传入）；py 插件目录跟随
    cache_dir = os.environ.get('VPC_CACHE_DIR')
    if cache_dir:
        hoststate.configure(cache_dir=cache_dir,
                            plugins_dir=os.path.join(cache_dir, 'py'))
    hoststate.ensure_dirs()
    _setup_logging()
    load_default_sites()
    fastapi_app = create_app()
    print(f'VPC_BACKEND_READY port={port} token={token}', flush=True)
    import uvicorn
    uvicorn.run(fastapi_app, host='127.0.0.1', port=port, log_level='warning')


if __name__ == '__main__':
    main()
