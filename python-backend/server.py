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
import hashlib
from logging.handlers import RotatingFileHandler
import re
import threading
import urllib.parse

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

import concurrent.futures
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
from proxy_contract import (
    decode_proxy_body,
    iter_body,
    is_streaming,
    merge_request_params,
    normalize_proxy_result,
    proxy_token_values,
)
from proxy_gateway import dispatch as dispatch_proxy
from play_contract import normalize_play_result

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
# 弹幕队列并发保护（L-14）：入队/取走为 swap 语义，需锁内原子交换
_danmaku_lock = threading.Lock()
# 弹幕队列上限：超出丢最旧，防内存无限增长
_DANMAKU_QUEUE_MAX = 5000

# 配置加载异步任务（多仓扫描可达分钟级，不能阻塞 /action 请求）
_config_task = {'status': 'idle', 'summary': None, 'msg': ''}

# playerContent 结果缓存（key=site|flag|id → {result, ts}，60s 有效期）
# 换线路又切回原线路时避免重复解析
_player_content_cache = {}
_PLAYER_CACHE_TTL = 60
# 清理路径的并发保护（L-19）：多线程 dispatch 同时触发清理时锁内迭代淘汰
_player_cache_lock = threading.Lock()

# /cache KV 目录总量配额（H-5c）：超 512MB 拒绝新写入；检查结果缓存 60s
# 避免每次写入都全目录统计
_KV_QUOTA_BYTES = 512 * 1024 * 1024
_kv_quota_state = {'checked': 0.0, 'exceeded': False}
_kv_quota_lock = threading.Lock()


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


def _empty_config_summary(parse_errors=0):
    return {
        'sites': 0,
        'sites_built': 0,
        'skipped': [],
        'parse_errors': int(parse_errors),
        'parses': 0,
        'flags': 0,
        'lives': 0,
        'panSites': 0,
        'build_errors': {
            'type_unsupported': 0,
            'jar_failed': 0,
            'js_failed': 0,
            'cms_failed': 0,
            'py_failed': 0,
            'other': 0,
        },
    }


def _config_load_worker(text):
    try:
        summary = config_mgr.load(text)
        _config_task.update({'status': 'done', 'summary': summary, 'msg': ''})
        logger.info('config load done: %s sites', summary.get('sites'))
    except Exception as e:
        logger.exception('config load failed')
        message = str(e)
        _config_task.update({
            'status': 'error',
            'summary': _empty_config_summary(1 if '[L1:parse]' in message else 0),
            'msg': message,
        })


def _config_load_async(text):
    """启动后台加载；已在加载中返回 None。"""
    if _config_task['status'] == 'loading':
        return None
    _config_task.update({'status': 'loading', 'summary': None, 'msg': ''})
    threading.Thread(target=_config_load_worker, args=(text,), daemon=True).start()
    return True


def _danmaku_reset():
    global _danmaku_clock
    with _danmaku_lock:
        _danmaku_queue.clear()
        _danmaku_clock = time.time()


def _danmaku_push(text):
    """弹幕入队（锁内），队列超过上限时丢最旧。"""
    with _danmaku_lock:
        _danmaku_queue.append(text)
        if len(_danmaku_queue) > _DANMAKU_QUEUE_MAX:
            del _danmaku_queue[:len(_danmaku_queue) - _DANMAKU_QUEUE_MAX]


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


def _browser_origin_rejected(request):
    """浏览器来源防御（H-5b）：非本机 Origin 或 Sec-Fetch-Site: cross-site
    的请求拒绝。spider 用 requests 调用 /cache /proxy 不带这些头不受影响；
    恶意网页跨站打 127.0.0.1（CSRF / DNS rebinding）会带这些头。"""
    origin = request.headers.get('origin')
    if origin:
        host = urllib.parse.urlparse(origin).hostname
        if host not in ('127.0.0.1', 'localhost'):
            return True
    if (request.headers.get('sec-fetch-site') or '').strip().lower() == 'cross-site':
        return True
    return False


def _kv_quota_exceeded():
    """KV 目录总量配额（H-5c）：超 512MB 拒绝新写入；统计结果缓存 60s。"""
    now = time.time()
    with _kv_quota_lock:
        if now - _kv_quota_state['checked'] < 60:
            return _kv_quota_state['exceeded']
    try:
        total, _items = _dir_size(cache_store.dir)
    except Exception:
        total = 0
    exceeded = total > _KV_QUOTA_BYTES
    with _kv_quota_lock:
        flipped = exceeded and not _kv_quota_state['exceeded']
        _kv_quota_state['checked'] = now
        _kv_quota_state['exceeded'] = exceeded
    if flipped:
        logger.warning('KV 缓存目录超过 %dMB 配额，/cache 新写入将被拒绝（可从设置面板清理缓存）',
                       _KV_QUOTA_BYTES // (1024 * 1024))
    return exceeded


def _friendly_jar_error(err):
    """把 jar 蜘蛛的原始异常翻译为用户可读的提示。"""
    e = err or ''
    if 'InvocationTargetException' in e or 'JsonSyntaxException' in e or 'MalformedJson' in e \
            or 'IllegalStateException' in e:
        return '站点接口异常或风控，暂时无法获取内容'
    if 'TimeoutError' in e or 'timeout' in e.lower():
        return '站点响应超时'
    if 'ClassNotFoundException' in e or 'NoClassDefFoundError' in e:
        return 'jar 缺少类定义（可能需更新爬虫运行环境）'
    if 'NoSuchMethodError' in e or 'NoSuchFieldError' in e or 'AbstractMethodError' in e:
        return 'jar 与运行环境不兼容（缺少接口，可能需更新爬虫运行环境）'
    return e[:120]


def _parse_matches_flag(flag):
    """判断 config parses 是否至少有一个可能处理当前线路的解析器。"""
    parses = getattr(config_mgr, 'parses', None) or []
    if not parses:
        return False
    if not flag:
        return True
    for item in parses:
        if not isinstance(item, dict):
            return True
        values = []
        for key in ('flag', 'flags', 'name', 'id'):
            value = item.get(key)
            if isinstance(value, (list, tuple)):
                values.extend(str(v) for v in value)
            elif value is not None:
                values.append(str(value))
        if not values or str(flag) in values:
            return True
    return False


def _attach_jar_error(ru, body, ensure_list=False, flag=''):
    """jar 蜘蛛最近一次调用失败时，把错误原因附加到响应 JSON 的 error 字段，
    前端可据此提示「站点接口异常」而非笼统的「暂无内容/未取得详情」。

    ensure_list=True（detailContent 用）：失败时要保证 body 含 list（空数组），
    使前端「无 vod + 有 error」可稳定判定，且严格返回 200 + {list: [], error}，
    绝不走 dispatch 的 500 分支。
    """
    sp = getattr(ru, 'spider', None)
    err = getattr(sp, 'last_error', '') if sp is not None else ''
    fallback = (err and _friendly_jar_error(err)) or '站点接口异常或风控，暂时无法获取内容'
    try:
        data = json.loads(body)
        if isinstance(data, dict):
            if err:
                data['error'] = _friendly_jar_error(err)
            elif data.get('parse') in (1, '1', True) and not _parse_matches_flag(flag):
                # L4：让配置缺少 parses（或没有匹配当前 flag）变成可诊断响应，
                # 而不是让渲染层只能看到一个泛化的播放失败。
                data['error'] = '当前配置未含匹配该线路的解析接口（parse=1）'
            if ensure_list:
                data.setdefault('list', [])
            return json.dumps(data, ensure_ascii=False)
        if ensure_list:
            # 非 dict 响应（蜘蛛异常后桥接返回奇怪类型）→ 归一为 {list:[], error}
            return json.dumps({'list': [], 'error': fallback}, ensure_ascii=False)
    except (TypeError, ValueError):
        if ensure_list:
            # 完全无法解析为 JSON 时仍返回规范结构，避免前端拿到裸串无从判断
            return json.dumps({'list': [], 'error': fallback}, ensure_ascii=False)
    return body


def _normalize_play_result(body, flag='', site=None, original_id=''):
    """归一化 FongMi ``playerContent``，未知扩展字段全部保留。"""
    site_headers = getattr(site, 'headers', {}) if site is not None else {}
    data = normalize_play_result(body, site_headers=site_headers,
                                 flag=flag, original_id=original_id)
    return json.dumps(data, ensure_ascii=False)


# 全局 spider 并发上限（C3）：阻塞 spider 调用经 anyio 默认线程池（~40 线程）
# 无节制执行；超载请求在此排队而非线程暴涨/雪崩。16 = 线程池容量的 40%。
# 注意：aggregate_search 内部的 8 线程池不经此信号量（自身已限），无嵌套死锁。
_SPIDER_SEMAPHORE = threading.BoundedSemaphore(16)


def dispatch_action(form):
    """返回 (status_code, body_text)。spider 调用均为同步阻塞，由调用方放线程池。"""
    with _SPIDER_SEMAPHORE:
        return _dispatch_action_inner(form)


def _dispatch_action_inner(form):
    do = form.get('do', '')
    try:
        # ---- 面板指令（弹幕入队 / 配置热更新；推送已由主进程 push-server 接管）----
        if do == 'danmaku':
            text = form.get('text', '')
            if text:
                _danmaku_push(text)
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
            # TTL 感知：附带 KV 缓存里已过期待清理的条目数（供面板展示）
            expired = 0
            try:
                _, _, expired = cache_store.stats()
            except Exception:
                expired = 0
            return 200, json.dumps({'code': 200, 'bytes': total, 'items': items, 'expired': expired})
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
        if do == 'panCookie':
            # 网盘 Cookie 配置（JAR 网盘源播放用）：act=get 读取 / act=set 保存
            from pan_cookies import load_pan_cookies, save_pan_cookies, PAN_COOKIE_KEYS, _PROVIDER_NAMES
            act = form.get('act', 'get')
            if act == 'get':
                return 200, json.dumps({'code': 200, 'cookies': load_pan_cookies(),
                                        'keys': list(PAN_COOKIE_KEYS),
                                        'names': _PROVIDER_NAMES}, ensure_ascii=False)
            if act == 'set':
                try:
                    cookies = json.loads(form.get('cookies', '{}'))
                except ValueError:
                    return 400, '{"code":400,"msg":"cookies 需为 JSON 对象"}'
                saved, warnings = save_pan_cookies(cookies)
                return 200, json.dumps({'code': 200, 'cookies': saved, 'warnings': warnings},
                                       ensure_ascii=False)
            if act == 'qrCreate':
                # 夸克网盘二维码登录：返回二维码图片 + 轮询用 token
                from pan_login import quark_qr_create
                try:
                    info = quark_qr_create()
                    return 200, json.dumps({'code': 200, **info}, ensure_ascii=False)
                except Exception as e:
                    logger.warning('pan qr create failed: %s', e)
                    return 200, json.dumps({'code': 500, 'msg': '获取二维码失败：%s' % str(e)[:100]},
                                           ensure_ascii=False)
            if act == 'qrPoll':
                # 轮询扫码状态；成功时后端已自动保存 Cookie
                from pan_login import quark_qr_poll
                token = form.get('token', '')
                try:
                    res = quark_qr_poll(token)
                    return 200, json.dumps({'code': 200, **res}, ensure_ascii=False)
                except Exception as e:
                    logger.warning('pan qr poll failed: %s', e)
                    return 200, json.dumps({'code': 500, 'status': 'error',
                                            'message': '轮询失败：%s' % str(e)[:100]},
                                           ensure_ascii=False)
            if act == 'qrRender':
                # 渲染二维码 PNG（主进程扫码登录模式：token 由主进程 Chromium 获取）
                from pan_login import render_qr_png
                text = form.get('text', '')
                if not text:
                    return 400, '{"code":400,"msg":"缺少 text"}'
                png = render_qr_png(text)
                return 200, json.dumps({'code': 200, 'qr_png': png}, ensure_ascii=False)
            return 400, '{"code":400,"msg":"unknown panCookie act"}'
        if do == 'file':
            logger.info('file play: %s', form.get('path'))
            return 200, '{"code":200,"msg":"file received"}'

        # ---- 多源聚合搜索（Phase 1 基础版：线程池并发 + 超时合并）----
        if do == 'search':
            word = form.get('word', '')
            return 200, json.dumps(aggregate_search(word), ensure_ascii=False)

        site = _site_or_error(form)
        sites.set_recent(site.key)
        ru = site.runner

        # ---- Spider 内容 API（契约见 PHASE0_依赖矩阵.md 第 3 节）----
        if do == 'homeContent':
            return 200, _attach_jar_error(ru, spider_app.homeContent(ru, _bool(form.get('filter', 'false'))))
        if do == 'homeVideoContent':
            return 200, _attach_jar_error(ru, spider_app.homeVideoContent(ru, form.get('pg', '1')))
        if do == 'categoryContent':
            return 200, _attach_jar_error(ru, spider_app.categoryContent(
                ru, form.get('tid', ''), form.get('pg', '1'),
                _bool(form.get('filter', 'false')), form.get('extend', '{}')))
        if do == 'detailContent':
            return 200, _attach_jar_error(ru, spider_app.detailContent(
                ru, form.get('ids', '[]')))
        if do == 'searchContent':
            return 200, spider_app.searchContent(
                ru, form.get('word', form.get('key', '')),
                form.get('quick', '0'), form.get('pg', '1'))
        if do == 'playerContent':
            # 60s 缓存：换线路又切回原线路时跳过重复解析
            vip_raw = form.get('vipFlags', '[]')
            try:
                vip_key = json.dumps(json.loads(vip_raw), ensure_ascii=False, sort_keys=True)
            except (TypeError, ValueError):
                vip_key = str(vip_raw)
            cache_key = f"{site.key}|{form.get('flag', '')}|{form.get('id', '')}|{vip_key}"
            cached = _player_content_cache.get(cache_key)
            if cached and (time.time() - cached['ts']) < _PLAYER_CACHE_TTL:
                return 200, cached['result']
            raw_result = spider_app.playerContent(
                ru, form.get('flag', ''), form.get('id', ''), form.get('vipFlags', '[]'))
            result = _normalize_play_result(raw_result, form.get('flag', ''), site,
                                            form.get('id', ''))
            result = _attach_jar_error(ru, result, flag=form.get('flag', ''))
            with _player_cache_lock:
                _player_content_cache[cache_key] = {'result': result, 'ts': time.time()}
                # 防无限增长：超过 1024 项先清过期；仍无过期项则按 ts 淘汰最旧 10%
                if len(_player_content_cache) > 1024:
                    now = time.time()
                    stale = [k for k, v in _player_content_cache.items()
                             if (now - v['ts']) > _PLAYER_CACHE_TTL]
                    for k in stale:
                        del _player_content_cache[k]
                    if len(_player_content_cache) > 1024:
                        drop = max(1, len(_player_content_cache) // 10)
                        oldest = sorted(_player_content_cache,
                                        key=lambda k: _player_content_cache[k]['ts'])[:drop]
                        for k in oldest:
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
        # as_completed + 整体 deadline（C3）：原先按提交顺序逐个 result(timeout)，
        # 慢源在前时总耗时被放大为 timeout×N；改整体超时，先到先合并。
        deadline = time.time() + timeout
        done, pending = concurrent.futures.wait(
            futures, timeout=timeout, return_when=concurrent.futures.ALL_COMPLETED)
        for fut in done:
            s = futures[fut]
            try:
                # 剩余预算交给 result（wait 返回的 done 集合正常已就绪，防御性保留）
                items = fut.result(timeout=max(0.1, deadline - time.time()))
                for item in items:
                    item.setdefault('source', s.key)
                    merged.append(item)
            except Exception as e:
                logger.warning('search source %s failed: %s', s.key, e)
        for fut in pending:
            fut.cancel()
            logger.warning('search source %s timed out (%ss)', futures[fut].key, timeout)
    return {'list': merged}


def do_local_proxy(param):
    """统一代理调度入口（保留旧导入名，便于现有测试/插件调用）。"""
    return dispatch_proxy(param, sites)


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
    """把 Spider/JAR proxy 返回值转换成 HTTP 响应。

    FongMi 的 proxy body 可能是 InputStream/requests raw，不能调用
    ``.content`` 或 ``bytes(...)`` 将整部视频读入内存。小型 bytes/JSON
    仍走普通 Response；可读对象和 iterator 走 StreamingResponse。
    """
    normalized = normalize_proxy_result(result)
    headers = dict(normalized.headers or {})
    status = int(normalized.status or 200)
    mime = normalized.mime or headers.get('Content-Type') or 'application/octet-stream'

    location = headers.get('Location') or headers.get('location')
    if 300 <= status < 400 and location:
        return RedirectResponse(location, status_code=status, headers=headers)

    if is_streaming(normalized):
        def stream():
            try:
                yield from iter_body(normalized.body)
            finally:
                if callable(normalized.close):
                    try:
                        normalized.close()
                    except Exception:
                        pass

        return StreamingResponse(stream(), status_code=status, media_type=mime, headers=headers)

    body = normalized.body
    try:
        if isinstance(body, str):
            body = body.encode('utf-8')
        elif body is None:
            body = b''
        elif not isinstance(body, (bytes, bytearray, memoryview)):
            body = str(body).encode('utf-8', 'replace')
        return Response(content=bytes(body), status_code=status, media_type=mime, headers=headers)
    finally:
        if callable(normalized.close):
            try:
                normalized.close()
            except Exception:
                pass


# ---------------------------------------------------------------- 应用装配

def create_app():
    global cache_store, kazumi_mgr, kazumi_engine, kazumi_cookies
    cache_store = CacheStore(os.path.join(hoststate.get_cache_dir(), 'kv'))
    kazumi_mgr = PluginManager()
    kazumi_cookies = CookieJar()
    kazumi_engine = RuleEngine(cookie_jar=kazumi_cookies)
    # FongMi localProxy（127.0.0.1:7944 go-proxy）兼容转发服务：网盘 jar 蜘蛛
    # 生成的播放地址指向该端口，PC 端需自建等价服务（见 go_proxy.py）
    if not globals().get('_go_proxy_started'):
        globals()['_go_proxy_started'] = True
        try:
            import go_proxy
            go_proxy.start_go_proxy()
        except Exception as e:
            logger.warning('go-proxy start failed: %s', e)
    fastapi_app = FastAPI(title='video-pc backend')

    @fastapi_app.middleware('http')
    async def token_auth(request: Request, call_next):
        path = request.url.path
        # 精确匹配免 token 路径（H-5a）：原 startswith 会放过 /healthX、
        # /cacheXXX 等同前缀路径
        if path not in TOKEN_EXEMPT:
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
                _danmaku_push(text)
            return JSONResponse({'code': 200, 'queued': len(_danmaku_queue)})
        if do == 'reset':
            _danmaku_reset()
            return JSONResponse({'code': 200})
        # 锁内原子交换（L-14）：避免 poll 与并发入队交错丢弹幕
        with _danmaku_lock:
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
            # 手动管理线程池（M-20）：shutdown(wait=False) 避免卡死的 worker
            # 阻塞生成器退出导致 done 事件发不出去
            pool = ThreadPoolExecutor(max_workers=min(8, len(site_list)))
            try:
                futures = {
                    pool.submit(_search_source_pages, s.runner, word): s
                    for s in site_list
                }
                try:
                    # T38：单源拉全部页耗时变长，放宽到 120s；超时/异常也必须
                    # 落到最后的 done 事件，防前端进度条挂死
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
            finally:
                pool.shutdown(wait=False)
            yield 'event: done\ndata: {}\n\n'
        return StreamingResponse(gen(), media_type='text/event-stream')

    @fastapi_app.get('/search/kazumi-stream')
    def kazumi_search_stream(word: str = Query(''), tag: str = Query(''),
                             year: str = Query(''), sort: str = Query('')):
        """SSE 流式 Kazumi 规则源搜索（T73）：每个规则源完成即推一条 data，全部结束发 event: done。
        结果项与 kazumiSearch 一致（{pluginName, data}）；验证码源带 captcha/captchaUrl。

        可选筛选参数 tag/year/sort（任务三 part 2）：作为模板变量 @tag/@year/@sort
        注入声明支持它们的规则源搜索请求（searchURL 含 @tag 等占位，或 API 模式 query 引用）。
        不声明这些占位的规则源忽略筛选、返回未过滤结果（优雅降级，对齐 Kazumi 仅传 keyword 的行为）。"""
        filters = {'tag': tag, 'year': year, 'sort': sort}
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
                    trace = kazumi_engine.search_with_captcha_retry(plugin.execution_config(), word, filters=filters)
                    if isinstance(trace, dict) and trace.get('captcha_required'):
                        return {'pluginName': plugin.name, 'captcha': True, 'captchaUrl': trace.get('captcha_url', '')}
                    data = [vars(it) for it in trace.response.data]
                    return {'pluginName': plugin.name, 'data': data, 'status': 'success' if data else 'noresult'}
                except Exception as e:
                    logger.warning('[kazumi] kazumi-search-stream failed: %s: %s', plugin.name, e)
                    return {'pluginName': plugin.name, 'error': True, 'msg': str(e)[:80]}

            # 手动管理线程池（M-20）：as_completed 超时/异常也要发 done 事件，
            # shutdown(wait=False) 防卡死 worker 阻塞生成器退出
            pool = ThreadPoolExecutor(max_workers=min(8, len(plugins)))
            try:
                futures = {pool.submit(_search_one, p): p for p in plugins}
                try:
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
                except Exception as e:
                    logger.warning('kazumi sse search overall timeout: %s', e)
            finally:
                pool.shutdown(wait=False)
            yield 'event: done\ndata: {}\n\n'
        return StreamingResponse(gen(), media_type='text/event-stream')

    @fastapi_app.api_route('/cache', methods=['GET', 'POST'])
    def cache_endpoint(request: Request, do: str = Query('get'), key: str = Query(''),
                       value: str = Form('')):
        # 浏览器来源防御（H-5b）：spider 用 requests 调用不带这些头，不受影响
        if _browser_origin_rejected(request):
            return JSONResponse({'code': 403, 'msg': 'forbidden'}, status_code=403)
        if do == 'set':
            # 配额（H-5c）：单 value 上限 1MB，防止把 KV 缓存当任意存储打爆磁盘
            if len(value.encode('utf-8', 'replace')) > 1024 * 1024:
                logger.warning('/cache do=set 拒绝写入：单 value 超过 1MB 上限（key=%s…）', str(key)[:40])
                return JSONResponse({'code': 413, 'msg': 'value too large'}, status_code=413)
            if _kv_quota_exceeded():
                return JSONResponse({'code': 413, 'msg': 'cache quota exceeded'}, status_code=413)
            cache_store.set(key, value)
        elif do == 'del':
            cache_store.delete(key)
        else:
            return PlainTextResponse(cache_store.get(key))
        return PlainTextResponse('')

    @fastapi_app.api_route('/proxy', methods=['GET', 'POST'])
    async def proxy_endpoint(request: Request):
        # 浏览器来源防御（H-5b）：同 /cache
        if _browser_origin_rejected(request):
            return JSONResponse({'code': 403, 'msg': 'forbidden'}, status_code=403)
        query = dict(request.query_params)
        supplied_proxy_token = query.get('token', '')
        if supplied_proxy_token and not hoststate.valid_proxy_token(supplied_proxy_token):
            return JSONResponse({'code': 401, 'msg': 'invalid proxy token'}, status_code=401)
        form = {}
        raw_body = None
        if request.method == 'POST':
            # FongMi /proxy 会把 POST 参数并入 params。multipart 上传文件
            # 不属于媒体代理控制面，文件字段只保留文件名，避免把 UploadFile
            # 对象塞进 JS/JVM JSON 桥。
            content_type = request.headers.get('content-type', '')
            body = await request.body()
            # urlencoded/JSON body 先走契约解码；multipart 仍由 Starlette
            # 处理文件字段，避免 UploadFile 对象进入 JSON/JVM 桥。
            decoded, raw_body = decode_proxy_body(body, content_type)
            form.update(decoded)
            if not decoded and content_type.lower().startswith('multipart/form-data'):
                try:
                    form_data = await request.form()
                    for key, value in form_data.items():
                        form[key] = getattr(value, 'filename', None) or value
                    raw_body = None
                except Exception:
                    pass
        # 兼容 POST 代理时，token 也可能放在 JSON/form 或专用请求头中。
        # /proxy 为旧 FongMi 地址保留免 token 入口，但只要调用方主动
        # 携带 token，就必须在所有传输位置执行相同的校验，不能靠把 token
        # 从 query 移到 body 绕过数据面鉴权。
        supplied_tokens = proxy_token_values(query, request.headers, form)
        if any(value and not hoststate.valid_proxy_token(value)
               for value in supplied_tokens):
            return JSONResponse({'code': 401, 'msg': 'invalid proxy token'}, status_code=401)
        param = merge_request_params(query, dict(request.headers), form, raw_body)
        try:
            result = await run_in_threadpool(do_local_proxy, param)
        except Exception as exc:
            logger.warning('proxy dispatch failed: %s', exc, exc_info=True)
            result = (502, 'text/plain; charset=utf-8',
                      f'proxy dispatch failed: {str(exc)[:240]}'.encode('utf-8'), {})
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
        headers = {}
        # 只读 Bangumi 元数据：附 Cache-Control（浏览器/中间层可短期复用；后端已按 TTL 落盘缓存）
        ttl = _BANGUMI_CACHE_TTL.get(form.get('do', ''), 0)
        if ttl > 0 and status == 200:
            headers['Cache-Control'] = 'max-age=1800'
        return PlainTextResponse(body, status_code=status,
                                 media_type='application/json; charset=utf-8',
                                 headers=headers)

    return fastapi_app


# 只读 Bangumi 元数据端点 → TTL（秒）。命中缓存直接返回落盘 JSON，
# ?refresh=1 绕过。info/episodes 变动罕见给 30min，search/listByTag 结果时效性稍强给 10min。
_BANGUMI_CACHE_TTL = {
    'kazumiBangumiInfo': 1800,
    'kazumiBangumiEpisodes': 1800,
    'kazumiBangumiSearch': 600,
    'kazumiBangumiSearchFilter': 600,
    'kazumiBangumiListByTag': 600,
    # 角色列表现会并发补全每个角色的中文名（多次详情请求），开销大且变动罕见 → 缓存 30min
    'kazumiBangumiCharacters': 1800,
}


def _bangumi_cache_key(do, form):
    """按 endpoint + 相关参数 hash 生成缓存键（忽略 token/refresh 等无关项）。"""
    keys = ('id', 'keyword', 'limit', 'offset', 'tag',
            'tags', 'sort', 'dateStart', 'dateEnd',
            'rankMin', 'rankMax', 'scoreMin', 'scoreMax', 'weekdays')
    parts = [do] + ['%s=%s' % (k, form.get(k, '')) for k in keys]
    raw = '|'.join(parts)
    return 'bgm:' + hashlib.sha1(raw.encode('utf-8')).hexdigest()


def _cached_bangumi(do, form, builder):
    """TTL 缓存包装：命中未过期缓存直接返回；否则调 builder() 生成 body，
    仅成功（code==200 且有实际数据）才写缓存。返回 (status, body)。
    builder 返回 (status, body)。?refresh=1 跳过读缓存但仍回写。"""
    ttl = _BANGUMI_CACHE_TTL.get(do, 0)
    if ttl <= 0 or cache_store is None:
        return builder()
    refresh = str(form.get('refresh', '')).lower() in ('1', 'true', 'yes')
    ckey = _bangumi_cache_key(do, form)
    if not refresh:
        cached = cache_store.get(ckey)
        if cached:
            return 200, cached
    status, body = builder()
    # 只缓存成功且非空响应，绝不缓存错误/空结果
    if status == 200 and _bangumi_body_ok(do, body):
        cache_store.set(ckey, body, ttl)
    return status, body


def _bangumi_body_ok(do, body):
    """判定响应是否值得缓存：code==200 且核心数据字段非空。"""
    try:
        d = json.loads(body)
    except (ValueError, TypeError):
        return False
    if d.get('code') != 200:
        return False
    if do == 'kazumiBangumiInfo':
        return bool(d.get('info'))
    if do == 'kazumiBangumiEpisodes':
        return bool(d.get('episodes'))
    if do == 'kazumiBangumiSearch':
        return bool(d.get('results'))
    if do == 'kazumiBangumiSearchFilter':
        return bool(d.get('items'))
    if do == 'kazumiBangumiListByTag':
        return bool(d.get('items'))
    if do == 'kazumiBangumiCharacters':
        return bool(d.get('characters'))
    return True


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
            # 空插件列表直接返回（M-23）：max_workers=0 会让线程池抛异常变 500
            if not plugins:
                return 200, json.dumps({'code': 200, 'results': []}, ensure_ascii=False)
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
            def _build():
                keyword = form.get('keyword', '')
                limit = int(form.get('limit', '10'))
                results = kazumi_mgr.bangumi_search(keyword, limit)
                return 200, json.dumps({'code': 200, 'results': results}, ensure_ascii=False)
            return _cached_bangumi(do, form, _build)

        # 带筛选的 Bangumi 搜索（复刻 Kazumi 搜索工作台：标签/排序/日期/排名/评分/星期）。
        # tags/weekdays 以逗号分隔透传；数值筛选空串视为不限。
        if do == 'kazumiBangumiSearchFilter':
            def _build():
                def _num(key):
                    raw = form.get(key, '')
                    if raw == '' or raw is None:
                        return None
                    try:
                        return float(raw) if '.' in str(raw) else int(raw)
                    except (TypeError, ValueError):
                        return None
                tags = [t.strip() for t in form.get('tags', '').split(',') if t.strip()]
                weekdays = [w.strip() for w in form.get('weekdays', '').split(',') if w.strip()]
                data = kazumi_mgr.bangumi_search_filtered(
                    keyword=form.get('keyword', ''),
                    tags=tags,
                    sort=form.get('sort', 'heat'),
                    date_start=form.get('dateStart', ''),
                    date_end=form.get('dateEnd', ''),
                    rank_min=_num('rankMin'),
                    rank_max=_num('rankMax'),
                    score_min=_num('scoreMin'),
                    score_max=_num('scoreMax'),
                    weekdays=weekdays,
                    limit=int(form.get('limit', '20')),
                    offset=int(form.get('offset', '0')),
                )
                return 200, json.dumps({'code': 200, 'items': data.get('items', []),
                                        'total': data.get('total', 0),
                                        'rawCount': data.get('raw_count', 0)}, ensure_ascii=False)
            return _cached_bangumi(do, form, _build)

        if do == 'kazumiBangumiInfo':
            def _build():
                subject_id = form.get('id', '')
                info = kazumi_mgr.bangumi_info(subject_id)
                return 200, json.dumps({'code': 200, 'info': info}, ensure_ascii=False)
            return _cached_bangumi(do, form, _build)

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
            def _build():
                tag = form.get('tag', '')
                limit = int(form.get('limit', '100'))
                offset = int(form.get('offset', '0'))
                data = kazumi_mgr.bangumi_list_by_tag(tag, min(limit, 200), max(offset, 0))
                return 200, json.dumps({'code': 200, 'items': data.get('items', []), 'total': data.get('total', 0)}, ensure_ascii=False)
            return _cached_bangumi(do, form, _build)

        if do == 'kazumiBangumiEpisodes':
            def _build():
                subject_id = form.get('id', '')
                data = kazumi_mgr.bangumi_episodes(subject_id)
                return 200, json.dumps({'code': 200, 'episodes': data}, ensure_ascii=False)
            return _cached_bangumi(do, form, _build)

        if do == 'kazumiBangumiCharacters':
            def _build():
                subject_id = form.get('id', '')
                data = kazumi_mgr.bangumi_characters(subject_id)
                return 200, json.dumps({'code': 200, 'characters': data}, ensure_ascii=False)
            return _cached_bangumi(do, form, _build)

        if do == 'kazumiBangumiCharacter':
            character_id = form.get('id', '')
            info = kazumi_mgr.bangumi_character_detail(character_id)
            return 200, json.dumps({'code': 200, 'info': info}, ensure_ascii=False)

        if do == 'kazumiBangumiCharacterComments':
            character_id = form.get('id', '')
            data = kazumi_mgr.bangumi_character_comments(character_id)
            return 200, json.dumps({'code': 200, 'comments': data}, ensure_ascii=False)

        if do == 'kazumiBangumiStaff':
            subject_id = form.get('id', '')
            data = kazumi_mgr.bangumi_staff(subject_id)
            return 200, json.dumps({'code': 200, 'staff': data}, ensure_ascii=False)
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
            # all=1（默认）：分页拉全量（任务六 6.1，>100 收藏也完整）；all=0：兼容旧单页行为
            fetch_all = str(form.get('all', '1')).lower() not in ('0', 'false', '')
            if fetch_all:
                items = kazumi_mgr._bangumi_all_collections(token)
            else:
                limit = int(form.get('limit', '100'))
                offset = int(form.get('offset', '0'))
                items = kazumi_mgr.bangumi_user_collections(token, limit=min(limit, 100), offset=max(offset, 0))
            return 200, json.dumps({'code': 200, 'items': items}, ensure_ascii=False)

        # ---- Bangumi 收藏批量同步（任务六 6.1：三方合并计划 + 并发上传） ----
        if do == 'kazumiBangumiSync':
            # 生成同步计划：拉远端全量收藏 → 与本地收藏三方合并 → {upload,pull,conflict,skipped}
            token = form.get('token', '')
            priority = form.get('priority', 'local')
            try:
                last_sync_at = float(form.get('lastSyncAt', '0') or 0)
            except (TypeError, ValueError):
                last_sync_at = 0
            try:
                local_favorites = json.loads(form.get('favorites', '[]'))
            except Exception:
                local_favorites = []
            if not isinstance(local_favorites, list):
                local_favorites = []
            plan = kazumi_mgr.bangumi_sync_collections(token, local_favorites,
                                                       priority=priority, last_sync_at=last_sync_at)
            return 200, json.dumps({'code': 200, 'plan': plan}, ensure_ascii=False)

        if do == 'kazumiBangumiSyncApply':
            # 并发执行同步计划的上传部分（ThreadPoolExecutor max_workers=3，每请求 250ms 限速）
            token = form.get('token', '')
            try:
                uploads = json.loads(form.get('uploads', '[]'))
            except Exception:
                uploads = []
            if not isinstance(uploads, list):
                uploads = []
            result = kazumi_mgr.bangumi_apply_sync_plan(token, uploads)
            return 200, json.dumps({'code': 200, 'result': result}, ensure_ascii=False)

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
                import http_client
                ua = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'}
                raw = None
                if image_url:
                    ir = http_client.get(image_url, timeout=15, verify=True, headers=ua)
                    ir.raise_for_status()
                    raw = ir.content
                elif image_b64:
                    import base64
                    raw = base64.b64decode(image_b64)
                if raw:
                    rsp = http_client.post('https://api.trace.moe/search', params={'anilistInfo': 2},
                                   data=raw, headers={**ua, 'Content-Type': _guess_image_type(raw)},
                                   timeout=20, verify=True)
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
    pan_fast_path = os.environ.get('VPC_PAN_FAST_PATH')
    hoststate.configure(
        port=port,
        token=token,
        **({'pan_fast_path': str(pan_fast_path).strip().lower() not in ('0', 'false', 'no', 'off')}
           if pan_fast_path is not None else {}),
    )
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
