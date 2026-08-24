# -*- coding: utf-8 -*-
"""PC 端宿主主服务（FastAPI）。

端点：
- GET  /health            健康检查（免 token）
- GET/POST /cache         spider 缓存协议 get/set/del（免 token，仅 127.0.0.1）
- GET/POST /proxy         spider localProxy 媒体代理（免 token）
- POST /action            内容 API + 面板指令（需 token）

本地文件面板（原 /file /upload 等占位）Phase 5 起改走 Electron 主进程
file-manager IPC，后端不再提供该组端点。

启动时打印：YUKI_BACKEND_READY port=<p> token=<t>（供 python-bridge 解析）。
"""
import os
import sys
import json
import asyncio
import time
import socket
import secrets
import logging
import hashlib
import multiprocessing
from logging.handlers import RotatingFileHandler
import re
import threading
import urllib.parse
from contextlib import asynccontextmanager

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
from runtime.contracts import RuntimeRequest, RuntimeResponse, bind_runtime_request, current_runtime_request
from runtime.errors import (
    RuntimeError as RuntimeContractError,
    error_from_exception,
    redact_sensitive,
)

logger = logging.getLogger('yuki.server')

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

_config_task = {
    'status': 'idle',
    'summary': None,
    'msg': '',
    'stage': 'idle',
    'requestId': '',
    'progress': {'stage': 'idle', 'configured': 0, 'current': 0, 'total': 0, 'healthy': 0, 'degraded': 0, 'unsupported': 0}
}
_config_cancel_event = None
_config_lock = threading.Lock()

# playerContent 稳定结果缓存（key=site|flag|id → {result, ts}，60s 有效期）。
# 带签名的 CDN/旧 go-proxy 地址不缓存，避免换集后继续拿到 412。
_player_content_cache = {}
_PLAYER_CACHE_TTL = 60
# 清理路径的并发保护（L-19）：多线程 dispatch 同时触发清理时锁内迭代淘汰
_player_cache_lock = threading.Lock()

# 当前控制面请求登记表。它只负责把客户端取消/超时信号送到正在运行的
# Spider/JAR 调用；真正的进程隔离和失控 Worker 终止仍属于 S1。
_active_runtime_requests = {}
_active_runtime_lock = threading.Lock()


def _register_runtime_request(request):
    with _active_runtime_lock:
        _active_runtime_requests[request.request_id] = request


def _unregister_runtime_request(request):
    with _active_runtime_lock:
        if _active_runtime_requests.get(request.request_id) is request:
            _active_runtime_requests.pop(request.request_id, None)


def cancel_runtime_request(request_id, reason='cancelled'):
    """Cancel one traced request and synchronously stop its active Worker.

    Registration and hard process termination are reported separately so a
    caller cannot interpret an event/Future cancellation as completed work.
    """
    request_id = str(request_id or '')
    with _active_runtime_lock:
        request = _active_runtime_requests.get(request_id)
    if request is None:
        return {'registered': False, 'workerTerminated': False}
    request.cancel(reason)
    terminated = False
    for site in list(sites.sites):
        cancel = getattr(getattr(site, 'runner', None), 'cancel_request', None)
        if callable(cancel) and cancel(request_id, reason):
            terminated = True
    return {'registered': True, 'workerTerminated': terminated}


def _runtime_request_is_active(request_id):
    with _active_runtime_lock:
        return str(request_id or '') in _active_runtime_requests


def _runtime_control_error(request, timed_out=False):
    code = 'L3_RUNTIME_TIMEOUT' if timed_out else 'L3_RUNTIME_CANCELLED'
    error = RuntimeContractError(code).with_request(request)
    return error.http_status, json.dumps(
        RuntimeResponse.failure(request, error, runtime='runtime').to_dict(),
        ensure_ascii=False)


async def _watch_action_disconnect(request, runtime_request):
    """Poll client disconnects while a synchronous Spider runs in a thread.

    The event is cooperative: the running call observes it at the Runner and
    dispatch boundaries.  S1 remains responsible for killing a non-cooperative
    Worker; G0 must nevertheless stop returning false success after a client
    has gone away.
    """
    while True:
        try:
            if await request.is_disconnected():
                runtime_request.cancel('cancelled')
                return 'cancelled'
        except Exception:
            # A transport exception is equivalent to a disconnected client.
            runtime_request.cancel('cancelled')
            return 'cancelled'
        await asyncio.sleep(0.05)


def _is_ephemeral_play_result(result):
    """判断 playerContent 是否包含不能复用的短期播放地址。

    夸克 CDN 签名地址和旧 go-proxy 地址都可能在几十秒内失效；缓存它们
    会让下一次点击继续拿到 412。统一 ``do=pan`` 地址本身稳定，可以缓存，
    因为真正的 CDN 地址由 Provider 在取流时动态解析。
    """
    try:
        data = json.loads(result) if isinstance(result, str) else result
        url = str((data or {}).get('url') or '') if isinstance(data, dict) else ''
        if not url:
            return False
        if any(data.get(key) is True for key in ('oneTime', 'ephemeral', 'skipCache')):
            return True
        if str(data.get('cache') or '').lower() in ('0', 'false', 'no', 'off'):
            return True
        if data.get('expireAt') or data.get('expiresAt'):
            return True
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or '').lower()
        query = urllib.parse.parse_qs(parts.query, keep_blank_values=True)
        if str(query.get('proxytype', [''])[0]).lower() == 'go':
            return True
        if host in ('127.0.0.1', 'localhost'):
            return False
        if host.endswith('.quark.cn') or host.endswith('.myquark.cn'):
            return True
        volatile = {
            'auth_key', 'token', 'sign', 'signature', 'expires', 'expire',
            'expire_at', 'expires_at', 'deadline', 'policy', 'credential',
            'x-expires', 'x-oss-expires', 'x-amz-expires',
            'x-amz-signature', 'x-amz-credential', 'wssecret', 'wstime',
        }
        return any(str(key).lower() in volatile for key in query)
    except (TypeError, ValueError, AttributeError):
        return False

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
        return redact_sensitive(text, 16000)


def _ensure_std_streams():
    """标准流缺失时兜底成 devnull，禁止任何库因 sys.stdout is None 崩溃。

    PyInstaller --windowed 产物是 GUI 子系统 exe，本身没有控制台；而 Windows 上
    multiprocessing spawn 的 CreateProcess 传 bInheritHandles=False，子进程也拿不到
    父进程的管道句柄。两者叠加后 Python 把 sys.stdout/stderr 置为 None，凡是假设
    标准流存在的代码都会炸——例如 uvicorn 的 ColourizedFormatter 会调
    sys.stdout.isatty()，最终表现为 ValueError: Unable to configure formatter。
    """
    for name, mode in (('stdin', 'r'), ('stdout', 'w'), ('stderr', 'w')):
        if getattr(sys, name, None) is not None:
            continue
        try:
            stream = open(os.devnull, mode, encoding='utf-8')
        except OSError:
            continue
        setattr(sys, name, stream)
        # logging.handleError()/traceback 直接取 sys.__stderr__，同样要补
        dunder = '__%s__' % name
        if getattr(sys, dunder, None) is None:
            setattr(sys, dunder, stream)


def _setup_logging():
    """控制台 + UTF-8 轮转文件；单文件 5 MiB，保留 5 份。"""
    log_dir = os.environ.get('YUKI_LOG_DIR') or hoststate.get_log_dir()
    os.makedirs(log_dir, exist_ok=True)
    formatter = _RedactingFormatter('%(asctime)s %(name)s %(levelname)s %(message)s')
    root = logging.getLogger()
    root.handlers.clear()
    # 级别由 Electron 主进程经 YUKI_LOG_LEVEL 注入（设置页“日志级别”），缺省 INFO
    root.setLevel(getattr(logging, os.environ.get('YUKI_LOG_LEVEL', 'INFO').upper(), logging.INFO))
    if sys.stderr is not None:  # --windowed 构建可能没有标准流
        console = logging.StreamHandler(sys.stderr)
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
        'configured': 0,
        'built': 0,
        'initialized': 0,
        'healthy': 0,
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
        # 与 ConfigManager._prepare 的 summary 形状保持一致（C2.1/C2.3/C2.4）：
        # 失败摘要缺键会让前端在「加载失败」和「字段为 0」之间读出 undefined。
        'runtimes': {},
        'unknownTypes': [],
        'unknownFields': [],
        'blocked': 0,
        'requiresAndroid': 0,
        'extExpanded': 0,
        'extFailed': 0,
        'hidden': 0,
        'reused': False,
        'snapshotId': '',
    }


def _form_flag(form, name):
    """表单开关：只有显式的真值才算开。

    本地文件读取和强制重建这两个开关必须由宿主 UI 显式带上；`form` 里缺键、空串
    或 `"0"/"false"` 都视为关，避免把「参数没传」读成「用户同意」。
    """
    return str((form or {}).get(name, '')).strip().lower() in ('1', 'true', 'yes', 'on')


def cancel_config_task(reason='cancelled'):
    global _config_cancel_event
    with _config_lock:
        if _config_cancel_event is not None:
            _config_cancel_event.set()
        if _config_task['status'] == 'loading':
            # 代际失效 + 任务序号自增：被取消的加载线程之后不得回写状态，
            # 也不得在装配完成时把半路结果 swap 进运行中配置。
            config_mgr.cancel_active_load()
            _config_task['seq'] = _config_task.get('seq', 0) + 1
            retained = getattr(config_mgr, 'last_healthy_snapshot', None)
            payload = {
                'status': 'error',
                'msg': reason,
                'stage': 'cancelled',
                'summary': _empty_config_summary(0),
            }
            if retained is not None and retained is getattr(config_mgr, 'snapshot', None):
                payload['retained'] = {
                    'snapshotId': retained.snapshot_id,
                    'healthy': retained.healthy_count,
                    'sites': len(retained.sites),
                }
            _config_task.update(payload)
            return True
    return False


def _update_config_task(seq, payload):
    """加载线程回写任务状态：序号不匹配说明已被更新的加载接管，直接丢弃。"""
    with _config_lock:
        if _config_task.get('seq') != seq:
            return False
        _config_task.update(payload)
        return True


def _config_progress_reporter(seq):
    """把 ConfigManager 的加载进度写入 _config_task.progress（前端进度条）。

    进度按「实际完成的站点数」上报；seq 不匹配（被更新请求接管）时丢弃，
    防止旧线程污染新任务的进度。
    """
    def report(stage, current, total):
        with _config_lock:
            if _config_task.get('seq') != seq or _config_task.get('status') != 'loading':
                return
            prev = _config_task.get('progress') or {}
            _config_task['progress'] = {
                'stage': str(stage),
                'configured': int(total or prev.get('configured') or 0),
                'current': int(current), 'total': int(total),
                'healthy': prev.get('healthy', 0),
                'degraded': prev.get('degraded', 0),
                'unsupported': prev.get('unsupported', 0),
            }
    return report


def _config_load_worker(text, *, allow_local_file=False, force=False, cancel_event=None, request_id='', seq=0):
    try:
        summary = config_mgr.load(text, allow_local_file=allow_local_file, force=force,
                                  cancel_event=cancel_event,
                                  progress_cb=_config_progress_reporter(seq))
        _update_config_task(seq, {
            'status': 'done',
            'summary': summary,
            'msg': '',
            'stage': 'done',
            'requestId': request_id,
        })
        logger.info('config load done: %s sites', summary.get('sites'))
    except Exception as e:
        logger.exception('config load failed')
        message = str(e)
        retained = getattr(config_mgr, 'last_healthy_snapshot', None)
        payload = {
            'status': 'error',
            'summary': _empty_config_summary(1 if '[L1:parse]' in message else 0),
            'msg': message,
            'stage': 'error',
            'requestId': request_id,
        }
        if retained is not None and retained is getattr(config_mgr, 'snapshot', None):
            payload['retained'] = {
                'snapshotId': retained.snapshot_id,
                'healthy': retained.healthy_count,
                'sites': len(retained.sites),
            }
        _update_config_task(seq, payload)


def _config_load_async(text, *, allow_local_file=False, force=False, request_id='', user=False):
    """启动后台加载；无法启动（不允许接管）时返回 None。

    接管规则：加载是全局单例任务，但「用户导入」必须能接管任何进行中的加载
    （启动恢复 / 主进程自动重载 / 上一次导入）——大仓库的自动重载动辄数分钟，
    若它一直占着 loading 态，用户每次点导入都只会收到 BUSY，表现为「所有导入
    都报错」。反向不成立：**自动重载不得接管任何进行中的加载**——启动恢复进行
    到一半时被自动重载取消（换慢速网络重载），用户会看到恢复永远不出结果、
    首页一直停在示例源。自动重载遇到 loading 一律 BUSY，等下一轮时机。
    """
    global _config_cancel_event
    with _config_lock:
        stale_event = None
        if _config_task['status'] == 'loading':
            if not user:
                return None          # 自动重载对任何进行中的加载让位（含启动恢复）
            stale_event = _config_cancel_event  # 用户导入接管一切进行中的加载
        if stale_event is not None:
            # 接管：唤醒旧线程的取消检查点，代际失效其最终 swap；
            # 旧线程稍后在检查点自行消亡，状态经 seq 不再回写。
            stale_event.set()
            config_mgr.cancel_active_load()
            logger.info('config load superseded by request %s', request_id or '(auto)')
        _config_cancel_event = threading.Event()
        _config_task['seq'] = _config_task.get('seq', 0) + 1
        seq = _config_task['seq']
        _config_task.update({
            'status': 'loading',
            'summary': None,
            'msg': '',
            'stage': 'fetching',
            'requestId': str(request_id or ''),
            'user': bool(user),
            'seq': seq,
            'progress': {'stage': 'fetching', 'configured': 0, 'current': 0, 'total': 0, 'healthy': 0, 'degraded': 0, 'unsupported': 0}
        })
        cancel_evt = _config_cancel_event
    threading.Thread(target=_config_load_worker, args=(text,),
                     kwargs={'allow_local_file': allow_local_file, 'force': force,
                             'cancel_event': cancel_evt, 'request_id': request_id,
                             'seq': seq},
                     daemon=True).start()
    return True


def _config_restore_worker(source_url, *, seq=0):
    """启动期磁盘缓存恢复（后台线程）。

    复用 ``_config_task`` 契约上报 loading→done/error/idle：主进程 auto-reload
    与渲染端 configTask 轮询据此感知「恢复进行中/已完成」。恢复不可用
    （无缓存/来源不匹配）时回到 idle，交还给常规网络重载决策。
    """
    try:
        summary = config_mgr.restore_cached(source_url,
                                            progress_cb=_config_progress_reporter(seq))
    except Exception:
        logger.warning('config disk cache restore failed', exc_info=True)
        retained = getattr(config_mgr, 'last_healthy_snapshot', None)
        payload = {
            'status': 'error',
            'summary': _empty_config_summary(0),
            'msg': 'disk cache restore failed',
            'stage': 'error',
            'requestId': 'startup-restore',
        }
        if retained is not None and retained is getattr(config_mgr, 'snapshot', None):
            payload['retained'] = {
                'snapshotId': retained.snapshot_id,
                'healthy': retained.healthy_count,
                'sites': len(retained.sites),
            }
        _update_config_task(seq, payload)
        return
    if summary:
        _update_config_task(seq, {
            'status': 'done',
            'summary': summary,
            'msg': '',
            'stage': 'done',
            'requestId': 'startup-restore',
        })
    else:
        _update_config_task(seq, {
            'status': 'idle',
            'summary': None,
            'msg': '',
            'stage': 'idle',
            'requestId': '',
        })
    if summary:
        logger.info('config restored from disk cache: %s sites',
                    summary.get('healthy', summary.get('sites', 0)))
    else:
        logger.info('config disk cache restore unavailable; keeping default sites')


def _start_config_restore_async(source_url):
    """标记 loading 并启动恢复线程；已在加载中时跳过。"""
    with _config_lock:
        if _config_task['status'] == 'loading':
            return
        _config_task['seq'] = _config_task.get('seq', 0) + 1
        _config_task.update({
            'status': 'loading',
            'summary': None,
            'msg': '',
            'stage': 'restoring',
            'requestId': 'startup-restore',
            'user': False,
            'seq': _config_task['seq'],
            'progress': {'stage': 'restoring', 'configured': 0, 'current': 0,
                         'total': 0, 'healthy': 0, 'degraded': 0, 'unsupported': 0},
        })
        seq = _config_task['seq']
    threading.Thread(target=_config_restore_worker, args=(source_url,),
                     kwargs={'seq': seq},
                     name='config-restore', daemon=True).start()


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
        raise RuntimeContractError(
            'L2_SITE_NOT_FOUND', site_key=str(form.get('site') or ''))
    return site


def _runtime_site_call(site, capability, callback):
    """执行一次 Spider 调用并把结果写回 SiteHealth。"""
    request = current_runtime_request()
    if request is not None:
        request.raise_if_cancelled()
    try:
        result = callback()
        # A synchronous Spider may return after the request deadline or after
        # the client cancelled it.  Do not turn that late result into a
        # successful health sample.
        if request is not None:
            request.raise_if_cancelled()
        spider = getattr(getattr(site, 'runner', None), 'spider', None)
        last_error = str(getattr(spider, 'last_error', '') or '')
        if last_error:
            raise RuntimeContractError(
                'L3_RUNTIME_CALL_FAILED',
                site_key=site.key,
                runtime=site.health.runtime,
                raw_error=last_error,
            )
        site.health.record_success(capability)
        state = getattr(site.runner, 'runtime_state', None)
        if callable(state):
            site.health.apply_runtime_state(state())
        return result
    except Exception as exc:
        error = error_from_exception(
            exc, stage='runtime', request=request,
            site_key=site.key, runtime=site.health.runtime)
        site.health.record_failure(error)
        state = getattr(site.runner, 'runtime_state', None)
        if callable(state):
            site.health.apply_runtime_state(state())
        raise error from exc


def _bool(v):
    return str(v).lower() in ('1', 'true', 'yes')


def _is_timeout_text(value):
    text = str(value or '').lower()
    return 'timeout' in text or 'timed out' in text or 'deadline exceeded' in text


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


def _usable_parsers():
    """配置里真正能执行的解析器：有 ``url``，或 type=4（聚合，遍历其他解析器）。"""
    usable = []
    for item in getattr(config_mgr, 'parses', None) or []:
        if not isinstance(item, dict):
            continue
        try:
            type_value = int(item.get('type') or 0)
        except (TypeError, ValueError):
            type_value = 0
        if str(item.get('url') or '').strip() or type_value == 4:
            usable.append(item)
    return usable


def _has_usable_parser():
    """配置里是否有任何可用解析器（不按线路筛）。

    对齐上游 ``VodConfig.getParses(type, flag)`` 的
    ``filter.isEmpty() ? items : filter``——解析器的 ``ext.flag`` 只是**偏好**，
    没有解析器声明这条线路时回退到全部解析器，绝不因为「没有解析器点名这条线路」
    就拒绝解析。旧实现 ``_parse_matches_flag`` 把 ``name``/``id`` 当作 flag 逐项
    比较（真实 TVBox 配置的线路白名单在 ``ext.flag``，``name`` 一般是「解析1」这类
    标签），于是任何正常配置都会被误判成「无匹配解析接口」，把本可解析的线路判死。

    线路级筛选交给主进程 `src/main/parse-window.js` 的 ``matchesFlag``——那一侧
    真正执行解析、也需要按 flag 排候选顺序；后端只回答「配置里到底有没有解析器」。
    """
    return bool(_usable_parsers())


def _attach_jar_error(ru, body, ensure_list=False, flag=''):
    """jar 蜘蛛最近一次调用失败时，把错误原因附加到响应 JSON 的 error 字段，
    前端可据此提示「站点接口异常」而非笼统的「暂无内容/未取得详情」。

    ensure_list=True（detailContent 用）：失败时要保证内部结果含 list（空数组），
    使旧调用方仍可诊断「无 vod + 有 error」。HTTP 端点随后会把结构化
    error 提升为非 2xx RuntimeResponse，避免 200 假成功。
    """
    sp = getattr(ru, 'spider', None)
    err = getattr(sp, 'last_error', '') if sp is not None else ''
    fallback = (err and _friendly_jar_error(err)) or '站点接口异常或风控，暂时无法获取内容'

    def _error_payload(code, raw='', details=None):
        error = RuntimeContractError(code, runtime='jar', raw_error=raw,
                                     details=details or {})
        return error.to_dict()

    try:
        data = json.loads(body)
        if isinstance(data, dict):
            if err:
                code = 'L3_RUNTIME_TIMEOUT' if 'timeout' in str(err).lower() else 'L3_RUNTIME_CALL_FAILED'
                data['error'] = _error_payload(code, err)
            elif data.get('parse') in (1, '1', True) and not _has_usable_parser():
                # L4：配置没有可执行解析器时**不**判定为线路失败。上游
                # ``ParseJob.setParse`` 在没有解析器时回退到 type 0 网页嗅探
                # （桌面端对应 `captureDirect` 隐藏窗口），渲染层也已实现该兜底。
                # 若在这里写 ``error``，`_decorate_action_body` 会把 200 提升成 424
                # 并丢掉 url/parse/header，渲染层只能整条线路判死并自动跳下一条
                # ——而下一条线路同样没有解析器，用户看到的就是无意义的线路轮换。
                # 因此有播放地址时只挂非致命 ``warning``（渲染层照常尝试嗅探，
                # 失败时才用它解释原因）；地址为空才是真的无从播放。
                payload = _error_payload(
                    'L4_PARSE_UNAVAILABLE', 'parse=1 without configured parser',
                    details={'flag': str(flag)} if flag else None)
                if str(data.get('url') or '').strip():
                    data['warning'] = payload
                else:
                    data['error'] = payload
            if ensure_list:
                data.setdefault('list', [])
            return json.dumps(data, ensure_ascii=False)
        if ensure_list:
            # 非 dict 响应（蜘蛛异常后桥接返回奇怪类型）→ 归一为 {list:[], error}
            return json.dumps({'list': [], 'error': _error_payload(
                'L3_RUNTIME_CALL_FAILED', fallback)}, ensure_ascii=False)
    except (TypeError, ValueError):
        if ensure_list:
            # 完全无法解析为 JSON 时仍返回规范结构，避免前端拿到裸串无从判断
            return json.dumps({'list': [], 'error': _error_payload(
                'L3_RUNTIME_CALL_FAILED', fallback)}, ensure_ascii=False)
    return body


def _normalize_play_result(body, flag='', site=None, original_id=''):
    """归一化 FongMi ``playerContent``，未知扩展字段全部保留。"""
    site_headers = getattr(site, 'headers', {}) if site is not None else {}
    site_play_url = getattr(site, 'play_url', '') if site is not None else ''
    data = normalize_play_result(body, site_headers=site_headers,
                                 site_play_url=site_play_url,
                                 flag=flag, original_id=original_id)
    return json.dumps(data, ensure_ascii=False)


# 全局 spider 并发上限（C3）：阻塞 spider 调用经 anyio 默认线程池（~40 线程）
# 无节制执行；超载请求在此排队而非线程暴涨/雪崩。16 = 线程池容量的 40%。
# 注意：aggregate_search 内部的 8 线程池不经此信号量（自身已限），无嵌套死锁。
_SPIDER_SEMAPHORE = threading.BoundedSemaphore(16)


def dispatch_action(form, runtime_request=None):
    """返回 (status_code, body_text)。spider 调用均为同步阻塞，由调用方放线程池。"""
    request = runtime_request or RuntimeRequest.from_action(form)
    _register_runtime_request(request)
    with bind_runtime_request(request):
        try:
            request.raise_if_cancelled()
            with _SPIDER_SEMAPHORE:
                return _dispatch_action_inner(form)
        except RuntimeContractError as error:
            # L2_SITE_NOT_FOUND 是客户端路由未命中（渲染端预渲染的站点在磁盘缓存
            # 恢复窗口期还没上后端），不是后端故障——每次启动都会出现，按 WARNING
            # 记只会刷屏；响应里已带结构化错误，降为 INFO。
            _log = (logger.info if error.code == 'L2_SITE_NOT_FOUND' else logger.warning)
            _log(
                'runtime request failed requestId=%s code=%s site=%s raw=%s',
                request.request_id, error.code, request.site_key,
                redact_sensitive(error.raw_error, 800))
            response = RuntimeResponse.failure(request, error, runtime=error.runtime)
            return error.http_status, json.dumps(response.to_dict(), ensure_ascii=False)
        except Exception as exc:
            error = error_from_exception(exc, request=request, site_key=request.site_key)
            logger.exception('runtime request failed requestId=%s', request.request_id)
            response = RuntimeResponse.failure(request, error, runtime=error.runtime)
            return error.http_status, json.dumps(response.to_dict(), ensure_ascii=False)
        finally:
            _unregister_runtime_request(request)


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
            req_id = str(form.get('requestId') or '')
            if name in ('config', '配置') and text:
                # 带 requestId 的是渲染端用户导入，可接管进行中的后台加载；
                # 不带的是主进程自动重载，不得打断用户正在等结果的导入。
                if _config_load_async(text, allow_local_file=_form_flag(form, 'localFile'),
                                      force=_form_flag(form, 'force'), request_id=req_id,
                                      user=bool(req_id)) is None:
                    raise RuntimeContractError('L1_CONFIG_BUSY')
                return 200, '{"code":202,"msg":"config loading"}'
            logger.info('setting: %s=%s', name, text)
            return 200, '{"code":200,"msg":"setting received"}'
        if do == 'loadConfig':
            req_id = str(form.get('requestId') or '')
            if _config_load_async(form.get('url', ''),
                                  allow_local_file=_form_flag(form, 'localFile'),
                                  force=_form_flag(form, 'force'), request_id=req_id,
                                  user=bool(req_id)) is None:
                raise RuntimeContractError('L1_CONFIG_BUSY')
            return 200, '{"code":202,"msg":"config loading"}'
        if do == 'cancelConfig':
            cancelled = cancel_config_task(form.get('reason', 'user cancelled'))
            return 200, json.dumps({'code': 200, 'cancelled': cancelled}, ensure_ascii=False)
        if do == 'configTask':
            # 配置加载是独立后台任务；轮询端点必须保留旧版的顶层
            # ``status/msg`` 契约，否则前端只能显示「未知错误」。同时附带
            # 脱敏后的结构化错误，供诊断页使用，不把它当成 Spider 请求失败。
            if _config_task.get('status') == 'error':
                msg = str(_config_task.get('msg') or 'config task failed')
                code = 'L1_CONFIG_TIMEOUT' if _is_timeout_text(msg) else 'L1_CONFIG_PARSE_FAILED'
                error = RuntimeContractError(code, raw_error=msg)
                payload = {'code': 200, **_config_task,
                           'msg': error.raw_error or error.message,
                           'error': error.to_dict()}
                return 200, json.dumps(payload, ensure_ascii=False, default=str)
            return 200, json.dumps({'code': 200, **_config_task},
                                   ensure_ascii=False, default=str)
        if do == 'cacheSize':
            # 缓存占用统计（供面板清理前展示）：总字节/文件数 + TTL 过期条目 + 分项明细
            total, items = _cache_size()
            expired = 0
            kv_bytes = 0
            try:
                kv_bytes, _, expired = cache_store.stats()
            except Exception:
                kv_bytes, expired = 0, 0
            js_local, dl_cache = _cache_paths()
            js_bytes = 0
            if os.path.isfile(js_local):
                try:
                    js_bytes = os.path.getsize(js_local)
                except OSError:
                    js_bytes = 0
            dl_bytes = 0
            if os.path.isdir(dl_cache):
                dl_bytes, _ = _dir_size(dl_cache)
            player_items = 0
            try:
                with _player_cache_lock:
                    player_items = len(_player_content_cache)
            except Exception:
                player_items = 0
            repo_bytes = 0
            try:
                repo_path = getattr(config_mgr._repository_cache(), 'path', '')
                if repo_path and os.path.isfile(repo_path):
                    repo_bytes = os.path.getsize(repo_path)
            except Exception:
                repo_bytes = 0
            return 200, json.dumps({
                'code': 200,
                'bytes': total,
                'items': items,
                'expired': expired,
                'breakdown': {
                    'kv': kv_bytes,
                    'jsLocal': js_bytes,
                    'dlCache': dl_bytes,
                    'playerCache': player_items,
                    'repoCache': repo_bytes,
                },
            }, ensure_ascii=False)
        if do == 'clearConfigCache':
            config_mgr._repository_cache().clear()
            config_mgr.cache_restored = False
            config_mgr.cache_age = 0
            return 200, '{"code":200,"msg":"config cache cleared"}'
        if do == 'clearCache':
            # 缓存清理：spider KV 缓存 + JS 本地存储 + 下载缓存目录
            # + 播放内容内存缓存 + 网盘签名 URL 缓存 + KV 配额状态（返回结构化明细）
            import shutil
            freed, _ = _cache_size()
            removed = cache_store.clear()
            extra = 0
            js_local, dl_cache = _cache_paths()
            js_removed = 0
            if os.path.exists(js_local):
                try:
                    os.remove(js_local)
                    extra += 1
                    js_removed = 1
                except OSError:
                    pass
            dl_removed = 0
            if os.path.isdir(dl_cache):
                shutil.rmtree(dl_cache, ignore_errors=True)
                extra += 1
                dl_removed = 1
            # 播放内容内存缓存
            player_removed = 0
            try:
                with _player_cache_lock:
                    player_removed = len(_player_content_cache)
                    _player_content_cache.clear()
            except Exception:
                player_removed = 0
            # 网盘签名 URL 缓存（pan 模块可能未安装）
            signed_cleared = False
            try:
                from pan.cache import clear_signed_url_cache
                clear_signed_url_cache()
                signed_cleared = True
            except Exception:
                signed_cleared = False
            # 重置 KV 配额状态（下次访问强制重新核算）
            try:
                with _kv_quota_lock:
                    _kv_quota_state['checked'] = 0.0
                    _kv_quota_state['exceeded'] = False
            except Exception:
                pass
            detail = {
                'kv': removed,
                'jsLocal': js_removed,
                'dlCache': dl_removed,
                'playerCache': player_removed,
                'signedUrlCache': signed_cleared,
            }
            logger.info(
                'cache cleared: kv=%s jsLocal=%s dlCache=%s player=%s signedUrl=%s (%s bytes freed)',
                removed, js_removed, dl_removed, player_removed, signed_cleared, freed)
            return 200, json.dumps({
                'code': 200,
                'bytes': freed,
                'removed': removed,
                'extra': extra,
                'detail': detail,
                'msg': '已删除 %d 项缓存' % (removed + extra + player_removed),
            }, ensure_ascii=False)
        if do == 'fetchText':
            # 直播源等外部文本拉取（渲染层直接 fetch 会被 CORS 拦截）
            from config import fetch_text_diagnostics
            fetched = fetch_text_diagnostics(form.get('url', ''))
            text = fetched.pop('text', '')
            upstream_error = fetched.get('error') or ''
            upstream_status = int(fetched.get('status') or 0)
            if upstream_error or upstream_status >= 400 or not text.strip():
                code = 'L1_CONFIG_TIMEOUT' if _is_timeout_text(upstream_error) else 'L1_CONFIG_FETCH_FAILED'
                raise RuntimeContractError(
                    code,
                    raw_error=upstream_error or ('upstream HTTP %s' % upstream_status),
                    details={'upstream': {k: fetched.get(k) for k in ('status', 'finalUrl', 'failureDomain')}})
            return 200, json.dumps({'code': 200, 'text': text[:500000],
                                    'upstream': fetched}, ensure_ascii=False)
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
                    raise RuntimeContractError('L3_RUNTIME_INVALID_REQUEST', raw_error='cookies must be a JSON object')
                if not isinstance(cookies, dict):
                    raise RuntimeContractError('L3_RUNTIME_INVALID_REQUEST', raw_error='cookies must be a JSON object')
                saved, warnings = save_pan_cookies(cookies)
                # 凭据缺失是不可自动重试错误；Cookie 更新只提前放行一次半开
                # 探测，不清空配置也不持续刷请求。
                for configured_site in list(sites.sites):
                    force = getattr(configured_site.runner, 'force_half_open', None)
                    if callable(force):
                        force()
                        configured_site.health.force_half_open()
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
                    raise RuntimeContractError('L3_RUNTIME_CALL_FAILED', raw_error=str(e)) from e
            if act == 'qrPoll':
                # 轮询扫码状态；成功时后端已自动保存 Cookie
                from pan_login import quark_qr_poll
                token = form.get('token', '')
                try:
                    res = quark_qr_poll(token)
                    return 200, json.dumps({'code': 200, **res}, ensure_ascii=False)
                except Exception as e:
                    logger.warning('pan qr poll failed: %s', e)
                    raise RuntimeContractError('L3_RUNTIME_CALL_FAILED', raw_error=str(e)) from e
            if act == 'qrRender':
                # 渲染二维码 PNG（主进程扫码登录模式：token 由主进程 Chromium 获取）
                from pan_login import render_qr_png
                text = form.get('text', '')
                if not text:
                    raise RuntimeContractError('L3_RUNTIME_INVALID_REQUEST', raw_error='missing text')
                png = render_qr_png(text)
                return 200, json.dumps({'code': 200, 'qr_png': png}, ensure_ascii=False)
            raise RuntimeContractError('L3_RUNTIME_INVALID_REQUEST', raw_error='unknown panCookie act')
        if do == 'file':
            logger.info('file play: %s', form.get('path'))
            return 200, '{"code":200,"msg":"file received"}'

        if do == 'runtimeRetry':
            site = _site_or_error(form)
            force = getattr(site.runner, 'force_half_open', None)
            if callable(force):
                force()
                site.health.force_half_open()
            return 200, json.dumps({'code': 200, 'siteKey': site.key,
                                    'state': site.health.state}, ensure_ascii=False)

        # ---- 多源聚合搜索（Phase 1 基础版：线程池并发 + 超时合并）----
        if do == 'search':
            word = form.get('word', '')
            return 200, json.dumps(aggregate_search(word), ensure_ascii=False)

        site = _site_or_error(form)
        sites.set_recent(site.key)
        ru = site.runner

        if do == 'parseExt':
            # FongMi parse type=2 lives in the most recently applicable
            # portable Spider JAR (Json<key>.parse), not in BrowserWindow.
            jar_site = site if sites._kind(site) == 'jar' else sites.recent('jar')
            if jar_site is None or not callable(getattr(jar_site.runner, 'jsonExt', None)):
                raise RuntimeContractError(
                    'L2_SITE_UNSUPPORTED', raw_error='parse type=2 requires a portable parser JAR')
            try:
                jxs = json.loads(form.get('jxs', '{}') or '{}')
            except (TypeError, ValueError):
                jxs = {}
            if not isinstance(jxs, dict):
                jxs = {}
            raw = _runtime_site_call(
                jar_site, 'parse', lambda: jar_site.runner.jsonExt(
                    form.get('key', ''), jxs, form.get('url', '')))
            if isinstance(raw, str):
                return 200, raw
            return 200, json.dumps(raw, ensure_ascii=False)

        # ---- Spider 内容 API（契约见 PHASE0_依赖矩阵.md 第 3 节）----
        if do == 'homeContent':
            return 200, _attach_jar_error(ru, _runtime_site_call(
                site, 'home', lambda: spider_app.homeContent(ru, _bool(form.get('filter', 'false')))))
        if do == 'homeVideoContent':
            return 200, _attach_jar_error(ru, _runtime_site_call(
                site, 'home', lambda: spider_app.homeVideoContent(ru, form.get('pg', '1'))))
        if do == 'categoryContent':
            return 200, _attach_jar_error(ru, _runtime_site_call(
                site, 'category', lambda: spider_app.categoryContent(
                    ru, form.get('tid', ''), form.get('pg', '1'),
                    _bool(form.get('filter', 'false')), form.get('extend', '{}'))))
        if do == 'detailContent':
            return 200, _attach_jar_error(ru, _runtime_site_call(
                site, 'detail', lambda: spider_app.detailContent(
                    ru, form.get('ids', '[]'))))
        if do == 'searchContent':
            return 200, _runtime_site_call(
                site, 'search', lambda: spider_app.searchContent(
                    ru, form.get('word', form.get('key', '')),
                    form.get('quick', '0'), form.get('pg', '1')))
        if do == 'playerContent':
            # 60s 缓存：换线路又切回原线路时跳过重复解析
            vip_raw = form.get('vipFlags', '[]')
            try:
                vip_key = json.dumps(json.loads(vip_raw), ensure_ascii=False, sort_keys=True)
            except (TypeError, ValueError):
                vip_key = str(vip_raw)
            cache_key = f"{site.key}|{form.get('flag', '')}|{form.get('id', '')}|{vip_key}"
            refresh = _form_flag(form, 'refresh')
            cached = _player_content_cache.get(cache_key)
            if refresh and cached:
                with _player_cache_lock:
                    _player_content_cache.pop(cache_key, None)
                cached = None
            if (cached and not _is_ephemeral_play_result(cached.get('result'))
                    and (time.time() - cached['ts']) < _PLAYER_CACHE_TTL):
                return 200, cached['result']
            # 旧版本进程可能已经把一次性 CDN 地址放进内存缓存；命中时先删掉，
            # 让本次请求重新调用 JAR/Provider 获取可用地址。
            if cached and _is_ephemeral_play_result(cached.get('result')):
                with _player_cache_lock:
                    _player_content_cache.pop(cache_key, None)
            raw_result = _runtime_site_call(
                site, 'player', lambda: spider_app.playerContent(
                    ru, form.get('flag', ''), form.get('id', ''), form.get('vipFlags', '[]')))
            result = _normalize_play_result(raw_result, form.get('flag', ''), site,
                                            form.get('id', ''))
            result = _attach_jar_error(ru, result, flag=form.get('flag', ''))
            if not _is_ephemeral_play_result(result):
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
            return 200, _runtime_site_call(
                site, 'live', lambda: spider_app.liveContent(ru, form.get('url', '')))
        if do == 'action':
            return 200, _runtime_site_call(
                site, 'action', lambda: spider_app.action(ru, form.get('action', '{}')))
        raise RuntimeContractError('L3_RUNTIME_INVALID_REQUEST', raw_error='unknown do: %s' % do)
    except RuntimeContractError:
        raise
    except ValueError as e:
        raise RuntimeContractError(
            'L2_SITE_INVALID', raw_error=str(e), site_key=str(form.get('site') or '')) from e
    except Exception as e:
        raise error_from_exception(
            e, stage='runtime', request=current_runtime_request(),
            site_key=str(form.get('site') or '')) from e


def _search_source_pages(runner, word, max_pages=50, deadline=None, site_key='', request=None):
    """单源搜索拉全部页合并去重（T38：取消 3 页限制，CMS 源搜索接口
    服务端分页 limit=20）；遇空页/短页/整页无新增即停（防部分源伪分页死循环），
    max_pages 仅作安全防护上限，异常不抛。"""
    merged = []
    seen = set()
    for pg in range(1, max_pages + 1):
        if request is not None:
            request.raise_if_cancelled()
        if deadline is not None:
            remaining_ms = int(max(0, deadline - time.monotonic()) * 1000)
            if remaining_ms <= 0:
                break
        else:
            remaining_ms = 20000
        try:
            page_request = request or RuntimeRequest.create(
                site_key=site_key, method='searchContent', deadline_ms=remaining_ms,
                args={'word': word, 'pg': str(pg)})
            with bind_runtime_request(page_request):
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


def _iter_aggregate_search(word, timeout=20, max_inflight=16):
    """按总预算和最大在途数产出单源结果。

    Future 只代表协调线程；超时/取消时必须调用 Runner.cancel_active() 杀掉
    实际 Worker。线程池不使用会隐式 wait=True 的上下文管理器。
    """
    site_list = [s for s in sites.sites if getattr(s, 'searchable', True)]
    if not site_list or not word:
        return
    parent_request = current_runtime_request()
    if parent_request is not None:
        timeout = min(float(timeout), max(0.001, parent_request.remaining_ms / 1000.0))
    timeout = max(0.001, float(timeout))
    # Reserve a small scheduler/serialization margin inside the advertised
    # budget. Without it, returning exactly at the monotonic deadline can be
    # observed a few milliseconds late by the caller under full-suite load.
    return_margin = min(0.05, max(0.002, timeout * 0.025))
    response_deadline = time.monotonic() + max(0.001, timeout - return_margin)
    # Worker 强杀和进程树 join 也是调用总耗时的一部分，不能等业务预算耗尽后
    # 再额外追加清理时间。短预算至少预留一半，常规 20s 预算预留至多 3.5s。
    cleanup_reserve = min(3.5, max(0.1, timeout * 0.2), timeout * 0.5)
    deadline = response_deadline - cleanup_reserve
    limit = max(1, min(int(max_inflight), len(site_list)))
    pool = ThreadPoolExecutor(max_workers=limit, thread_name_prefix='aggregate-search')
    pending = {}
    next_index = 0

    def submit_available():
        nonlocal next_index
        while next_index < len(site_list) and len(pending) < limit:
            site = site_list[next_index]
            next_index += 1
            request = RuntimeRequest.create(
                site_key=site.key,
                method='searchContent',
                deadline_ms=max(1, int((deadline - time.monotonic()) * 1000)),
                args={'word': word},
            )
            future = pool.submit(
                _search_source_pages, site.runner, word, 50, deadline, site.key, request)
            pending[future] = (site, request)

    submit_available()
    try:
        while pending and time.monotonic() < deadline:
            if parent_request is not None:
                parent_request.raise_if_cancelled()
            done, _ = concurrent.futures.wait(
                tuple(pending), timeout=min(0.05, max(0, deadline - time.monotonic())),
                return_when=concurrent.futures.FIRST_COMPLETED)
            if not done:
                continue
            for future in done:
                site, _request = pending.pop(future)
                error = None
                items = []
                try:
                    items = future.result()
                except Exception as exc:
                    error = exc
                    logger.warning('search source %s failed: %s', site.key, exc)
                yield site, items, error
            submit_available()
    finally:
        reason = ('cancelled' if parent_request is not None and parent_request.cancelled
                  else 'timeout')
        terminators = []
        for future, (site, request) in list(pending.items()):
            request.cancel(reason)
            cancel = getattr(site.runner, 'cancel_request', None)
            if callable(cancel):
                thread = threading.Thread(
                    target=cancel, args=(request.request_id, reason), daemon=True,
                    name='search-cancel-%s' % site.key)
                thread.start()
                terminators.append(thread)
            # 只用来阻止尚未开始的协调任务；不把返回值当成 Worker 已结束。
            future.cancel()
        # 多个坏源并行强杀；总耗时取最慢进程树回收，而不是 N 倍串行累加。
        for thread in terminators:
            remaining = max(0.0, response_deadline - time.monotonic())
            if remaining <= 0:
                break
            thread.join(timeout=remaining)
        pool.shutdown(wait=False, cancel_futures=True)


def aggregate_search(word, timeout=20):
    """在整体预算内合并已完成健康结果，坏源不会拖住返回。"""
    merged = []
    for site, items, _error in _iter_aggregate_search(word, timeout=timeout):
        for item in items:
            item.setdefault('source', site.key)
            merged.append(item)
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


def _decorate_action_body(status, body, request):
    """成功保持 CatVod 扁平结果；失败保持 RuntimeResponse 包络。"""
    try:
        payload = json.loads(body)
    except (TypeError, ValueError):
        return status, body
    if not isinstance(payload, dict):
        return status, body
    if payload.get('ok') is False and isinstance(payload.get('error'), dict):
        # dispatch_action already produced a RuntimeResponse failure.  Keep
        # its status and envelope intact (including cancellation/deadline
        # codes) instead of wrapping it a second time.
        return status, json.dumps(payload, ensure_ascii=False)
    if status < 400 and isinstance(payload.get('error'), dict):
        # Legacy Spider/JAR methods may return a normal CatVod object with an
        # ``error`` field.  It is still a runtime failure: HTTP 200 would make
        # callers treat the response as a successful content result.  Promote
        # the embedded L1-L6 code to the uniform error envelope.
        embedded = payload.get('error') or {}
        code = str(embedded.get('code') or 'L3_RUNTIME_CALL_FAILED')
        try:
            error = RuntimeContractError(
                code,
                stage=str(embedded.get('stage') or ''),
                retryable=embedded.get('retryable'),
                site_key=request.site_key,
                runtime=(sites.get(request.site_key).health.runtime
                         if request.site_key and sites.get(request.site_key) else ''),
                raw_error=json.dumps(embedded, ensure_ascii=False),
                details=embedded.get('details') or {},
            ).with_request(request)
        except ValueError:
            error = RuntimeContractError(
                'L3_RUNTIME_CALL_FAILED', site_key=request.site_key,
                raw_error=json.dumps(embedded, ensure_ascii=False)).with_request(request)
        response = RuntimeResponse.failure(request, error, runtime=error.runtime)
        return error.http_status, json.dumps(response.to_dict(), ensure_ascii=False)
    site = sites.get(request.site_key) if request.site_key else None
    runtime_methods = {
        'homeContent', 'homeVideoContent', 'categoryContent', 'searchContent',
        'detailContent', 'playerContent', 'parseExt', 'liveContent', 'action',
    }
    if status < 400 and request.method in runtime_methods and payload.get('error'):
        raw = payload.get('error')
        error = RuntimeContractError(
            'L3_RUNTIME_CALL_FAILED',
            site_key=request.site_key,
            runtime=site.health.runtime if site is not None else '',
            raw_error=json.dumps(raw, ensure_ascii=False) if isinstance(raw, dict) else str(raw),
        ).with_request(request)
        response = RuntimeResponse.failure(request, error, runtime=error.runtime)
        return error.http_status, json.dumps(response.to_dict(), ensure_ascii=False)
    payload.setdefault('requestId', request.request_id)
    if request.play_session_id:
        payload.setdefault('playSessionId', request.play_session_id)
    payload.setdefault('ok', status < 400)
    payload.setdefault('runtime', site.health.runtime if site is not None else '')
    payload.setdefault('elapsedMs', request.elapsed_ms)
    return status, json.dumps(payload, ensure_ascii=False)


def _dispatch_proxy_with_context(param, request):
    with bind_runtime_request(request):
        return do_local_proxy(param)


# ---------------------------------------------------------------- 应用装配

def create_app():
    global cache_store, kazumi_mgr, kazumi_engine, kazumi_cookies
    cache_store = CacheStore(os.path.join(hoststate.get_cache_dir(), 'kv'))
    kazumi_mgr = PluginManager()
    kazumi_cookies = CookieJar()
    kazumi_engine = RuleEngine(cookie_jar=kazumi_cookies)
    # FongMi localProxy（127.0.0.1:7944 go-proxy）兼容转发服务：网盘 jar 蜘蛛
    # 生成的播放地址指向该端口，PC 端需自建等价服务（见 go_proxy.py）
    try:
        import go_proxy
        go_proxy.start_go_proxy()
    except Exception as e:
        logger.warning('go-proxy start failed: %s', e)
    def shutdown_runtime_resources():
        """无论正常退出、设置重置还是测试关闭，都走同一回收链路。"""
        destroy_sites = getattr(sites, 'destroy_all', None)
        if callable(destroy_sites):
            destroy_sites()
        try:
            from runtime.supervisor import destroy_all_supervisors
            destroy_all_supervisors()
        except Exception:
            pass
        try:
            from jar_bridge import JarBridge
            JarBridge.destroy_all()
        except Exception:
            pass
        try:
            import go_proxy
            go_proxy.stop_go_proxy()
        except Exception:
            pass

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            shutdown_runtime_resources()

    fastapi_app = FastAPI(title='yuki backend', lifespan=lifespan)

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

    @fastapi_app.api_route('/runtime/cancel', methods=['POST'])
    async def runtime_cancel_endpoint(request: Request):
        """Cancel a registered /action request by requestId.

        This is a control-plane acknowledgement; it does not claim that an
        arbitrary Python thread has already stopped.  Cooperative runtimes
        observe the request event, while S1 will provide hard Worker kills.
        """
        try:
            data = await request.json()
        except Exception:
            data = {}
        request_id = str((data or {}).get('requestId') or request.headers.get('x-request-id') or '')
        state = (cancel_runtime_request(request_id, 'cancelled') if request_id else
                 {'registered': False, 'workerTerminated': False})
        deadline = time.monotonic() + 1.5
        while state['registered'] and _runtime_request_is_active(request_id) \
                and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        completed = not _runtime_request_is_active(request_id)
        return JSONResponse({
            'ok': True,
            'requestId': request_id,
            'cancelled': bool(state['registered']),
            'registered': bool(state['registered']),
            'workerTerminated': bool(state['workerTerminated']),
            'completed': bool(completed),
        })

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
            for site, items, error in _iter_aggregate_search(word, timeout=20):
                payload = json.dumps({
                    'source': site.key,
                    'name': site.name,
                    'list': items,
                    'status': 'error' if error else ('success' if items else 'noresult'),
                }, ensure_ascii=False)
                yield f'data: {payload}\n\n'
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
        runtime_request = RuntimeRequest.create(
            request_id=param.get('requestId') or request.headers.get('x-request-id', ''),
            play_session_id=param.get('playSessionId', ''),
            site_key=param.get('siteKey', ''), method='proxy', args=param,
        )
        try:
            result = await run_in_threadpool(
                _dispatch_proxy_with_context, param, runtime_request)
        except Exception as exc:
            error = error_from_exception(
                exc, stage='media', request=runtime_request,
                site_key=runtime_request.site_key)
            logger.warning('proxy dispatch failed requestId=%s code=%s: %s',
                           runtime_request.request_id, error.code,
                           redact_sensitive(error.raw_error), exc_info=True)
            payload = RuntimeResponse.failure(
                runtime_request, error, runtime='proxy').to_dict()
            headers = {'X-Request-Id': runtime_request.request_id}
            if runtime_request.play_session_id:
                headers['X-Play-Session-Id'] = runtime_request.play_session_id
            return JSONResponse(payload, status_code=error.http_status, headers=headers)
        response = build_proxy_response(result)
        response.headers['X-Request-Id'] = runtime_request.request_id
        if runtime_request.play_session_id:
            response.headers['X-Play-Session-Id'] = runtime_request.play_session_id
        return response

    @fastapi_app.api_route('/action', methods=['POST'])
    async def action_endpoint(request: Request):
        form = {k: v for k, v in (await request.form()).items()}
        runtime_request = RuntimeRequest.from_action(
            form, request_id=request.headers.get('x-request-id', ''))
        form['requestId'] = runtime_request.request_id
        if runtime_request.play_session_id:
            form['playSessionId'] = runtime_request.play_session_id
        action_task = asyncio.create_task(run_in_threadpool(
            dispatch_action, form, runtime_request))
        disconnect_task = asyncio.create_task(
            _watch_action_disconnect(request, runtime_request))
        try:
            done, _ = await asyncio.wait(
                {action_task, disconnect_task},
                timeout=runtime_request.deadline_ms / 1000.0,
                return_when=asyncio.FIRST_COMPLETED)
            if action_task in done:
                try:
                    status, body = action_task.result()
                except asyncio.CancelledError:
                    # The thread-pool wrapper may be cancelled at the same
                    # boundary as the deadline/disconnect watcher.  Convert
                    # that race into the same structured contract instead of
                    # letting Starlette emit an unstructured 500.
                    status, body = _runtime_control_error(
                        runtime_request,
                        timed_out=runtime_request.deadline_exceeded)
                except RuntimeContractError as error:
                    error = error.with_request(runtime_request)
                    status = error.http_status
                    body = json.dumps(RuntimeResponse.failure(
                        runtime_request, error, runtime=error.runtime).to_dict(),
                        ensure_ascii=False)
                except Exception as exc:
                    error = error_from_exception(
                        exc, request=runtime_request,
                        site_key=runtime_request.site_key)
                    status = error.http_status
                    body = json.dumps(RuntimeResponse.failure(
                        runtime_request, error, runtime=error.runtime).to_dict(),
                        ensure_ascii=False)
            elif disconnect_task in done:
                runtime_request.cancel('cancelled')
                action_task.cancel()
                status, body = _runtime_control_error(runtime_request, timed_out=False)
            else:
                runtime_request.expire()
                action_task.cancel()
                status, body = _runtime_control_error(runtime_request, timed_out=True)
        finally:
            disconnect_task.cancel()
            if not action_task.done():
                # The worker may still be unwinding cooperatively.  Consume a
                # late exception without holding the HTTP request open.
                action_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        status, body = _decorate_action_body(status, body, runtime_request)
        headers = {'X-Request-Id': runtime_request.request_id}
        if runtime_request.play_session_id:
            headers['X-Play-Session-Id'] = runtime_request.play_session_id
        return PlainTextResponse(body, status_code=status,
                                 media_type='application/json; charset=utf-8',
                                 headers=headers)

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

    # Bangumi 封面代理转发（host 白名单，防 SSRF）：渲染层 <img> 直连 lain.bgm.tv
    # 被墙/慢时封面拉不出（历史/搜索页 kazumi 卡全是该图床），改经本地后端转发
    # （http_client 走应用代理/系统代理配置），官方域名失败自动换镜像 lain.bangumi.pro
    # 重试。响应带长缓存头，重复渲染由浏览器缓存兜住不再回源。
    _bangumi_cover_hosts = frozenset(('lain.bgm.tv', 'lain.bangumi.tv', 'lain.bangumi.pro'))

    @fastapi_app.get('/kazumi/cover')
    async def kazumi_cover(url: str = ''):
        import http_client

        def _fetch(target):
            rsp = http_client.get(target, timeout=(5, 20), verify=True)
            if rsp.status_code != 200:
                raise RuntimeError(f'HTTP {rsp.status_code}')
            body = rsp.content or b''
            if not body or len(body) > 8 * 1024 * 1024:
                raise RuntimeError('empty or oversized cover')
            ctype = (rsp.headers.get('content-type') or '').split(';')[0].strip()
            if ctype and not ctype.startswith('image/'):
                raise RuntimeError(f'not an image: {ctype}')
            return body, (ctype or 'image/jpeg')

        try:
            # 旧渲染层曾持久化损坏组合（/r/{n}/pic/cover/{非l}/，lain CDN 对其返回
            # HTTP 400）：真实缩放由 r 宽度前缀承担，段应固定为 l——这里归一化自愈，
            # 让带病记录的封面也能经代理拉回（裸路径 /pic/cover/{lcmgs}/ 合法，不动）。
            if re.search(r'/r/\d+/pic/cover/', url, re.I):
                url = re.sub(r'(/pic/cover/)[a-z](/)', r'\1l\2', url, flags=re.I)
            parts = urllib.parse.urlsplit(url)
            if parts.scheme not in ('http', 'https') or parts.hostname not in _bangumi_cover_hosts:
                return JSONResponse({'code': 403, 'msg': 'host not allowed'}, status_code=403)
            candidates = [url]
            if parts.hostname != 'lain.bangumi.pro':
                candidates.append(urllib.parse.urlunsplit(
                    parts._replace(scheme='https', netloc='lain.bangumi.pro')))
            last_err = None
            for target in candidates:
                try:
                    body, ctype = await run_in_threadpool(_fetch, target)
                    return Response(content=body, media_type=ctype,
                                    headers={'Cache-Control': 'private, max-age=604800'})
                except Exception as e:
                    last_err = e
            logger.warning('[kazumi] cover proxy failed for %s: %s', url, last_err)
            return JSONResponse({'code': 502, 'msg': 'cover fetch failed'}, status_code=502)
        except Exception as e:
            logger.warning('[kazumi] cover proxy bad request: %s', e)
            return JSONResponse({'code': 400, 'msg': 'bad url'}, status_code=400)

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
            data = kazumi_mgr.bangumi_trends(min(limit, 120), max(offset, 0))
            return 200, json.dumps({'code': 200, 'trends': data.get('items', []), 'total': data.get('total', 0)}, ensure_ascii=False)

        if do == 'kazumiBangumiListByTag':
            def _build():
                tag = form.get('tag', '')
                limit = int(form.get('limit', '100'))
                offset = int(form.get('offset', '0'))
                data = kazumi_mgr.bangumi_list_by_tag(tag, min(limit, 120), max(offset, 0))
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
            ssl_verify = form.get('sslVerify', '1') != '0'
            remote_dir = form.get('remoteDir', '')
            try:
                data = json.loads(data_str)
            except Exception:
                data = {}
            ok = kazumi_mgr.webdav_sync(url, username, password, data,
                                        ssl_verify=ssl_verify, remote_dir=remote_dir)
            return (200 if ok else 500), json.dumps({'code': 200 if ok else 500, 'msg': 'sync ok' if ok else 'sync failed'}, ensure_ascii=False)

        if do == 'kazumiWebdavRestore':
            url = form.get('url', '')
            username = form.get('username', '')
            password = form.get('password', '')
            names_str = form.get('names', '[]')
            ssl_verify = form.get('sslVerify', '1') != '0'
            remote_dir = form.get('remoteDir', '')
            try:
                names = json.loads(names_str)
            except Exception:
                names = []
            result = kazumi_mgr.webdav_restore(url, username, password, names,
                                               ssl_verify=ssl_verify, remote_dir=remote_dir)
            # 失败（连接错误/无数据）返回 500 + 原因：此前恒 200 空数据，渲染层把
            # 空对象当成功提示「恢复完成」，网址输错时误导用户（同步端点早有对齐语义）
            if not result.get('ok'):
                msg = str(result.get('error') or 'restore failed')
                return 500, json.dumps({'code': 500, 'msg': msg}, ensure_ascii=False)
            return 200, json.dumps({'code': 200, 'data': result.get('files') or {}}, ensure_ascii=False)

        if do == 'kazumiWebdavTest':
            url = form.get('url', '')
            username = form.get('username', '')
            password = form.get('password', '')
            ssl_verify = form.get('sslVerify', '1') != '0'
            remote_dir = form.get('remoteDir', '')
            result = kazumi_mgr.webdav_test(url, username, password,
                                            ssl_verify=ssl_verify, remote_dir=remote_dir)
            if not result.get('ok'):
                msg = str(result.get('error') or 'connect failed')
                return 500, json.dumps({'code': 500, 'msg': msg}, ensure_ascii=False)
            return 200, json.dumps({'code': 200}, ensure_ascii=False)

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
    port = int(os.environ.get('YUKI_PORT') or pick_free_port())
    token = os.environ.get('YUKI_TOKEN') or secrets.token_hex(16)
    pan_fast_path = os.environ.get('YUKI_PAN_FAST_PATH')
    runtime_android_worker = os.environ.get('YUKI_ANDROID_WORKER_ENABLED')
    media_probe = os.environ.get('YUKI_MEDIA_PROBE')
    auto_line_fallback = os.environ.get('YUKI_AUTO_LINE_FALLBACK')
    legacy_parser = os.environ.get('YUKI_LEGACY_PARSER')

    def _env_bool(val, default=True):
        if val is None:
            return default
        return str(val).strip().lower() not in ('0', 'false', 'no', 'off')

    hoststate.configure(
        port=port,
        token=token,
        pan_fast_path=_env_bool(pan_fast_path, True),
        runtime_android_worker=False,  # A4.1 No-Go 政策硬锁定
        media_probe=_env_bool(media_probe, True),
        auto_line_fallback=_env_bool(auto_line_fallback, True),
        legacy_parser=_env_bool(legacy_parser, True),
    )
    # 自定义缓存目录（主进程设置页指定，经 YUKI_CACHE_DIR 传入）；py 插件目录跟随
    cache_dir = os.environ.get('YUKI_CACHE_DIR')
    if cache_dir:
        hoststate.configure(cache_dir=cache_dir,
                            plugins_dir=os.path.join(cache_dir, 'py'))
    hoststate.ensure_dirs()
    config_mgr.configure_repository_cache()
    _setup_logging()
    last_cached_url = os.environ.get('YUKI_LAST_CONFIG_URL', '')
    fastapi_app = create_app()
    # READY 不再等待磁盘缓存恢复：大配置（数百站点）+ 慢镜像 jar 下载会让同步
    # 恢复耗时数分钟，期间 YUKI_BACKEND_READY 迟迟不打印，主进程拿不到端口/token、
    # 渲染端 waitBackend 拿不到 backend info——整个窗口在事件绑定前呈「卡死」态。
    # 先以内置示例源兜底就绪，恢复移入后台线程（经 _config_task 上报状态，
    # 主进程 auto-reload 会等它结束再决策是否需要网络重载）。
    load_default_sites()
    # READY 行是主进程/渲染端 waitBackend 的唯一启动信号，必须尽力发出；但打包版里
    # 父进程可能在子进程刚启动时就退出（如旧版本双开后第二实例被关闭），stdout 管道
    # 随之失效，Windows 上写入抛 OSError [Errno 22] Invalid argument。服务本身仍能
    # 健康运行（健康检查走 HTTP），吞掉写失败即可——否则未处理异常会让 PyInstaller
    # 弹「脚本执行出错」错误框。
    try:
        print(f'YUKI_BACKEND_READY port={port} token={token}', flush=True)
    except OSError:
        logger.warning('READY 行写入 stdout 失败（管道失效），已忽略')
    if last_cached_url:
        _start_config_restore_async(last_cached_url)
    import uvicorn
    # log_config=None：跳过 uvicorn 自己的 dictConfig。它的 ColourizedFormatter 用
    # sys.stdout.isatty() 探测颜色，标准流为 None 时抛 ValueError: Unable to
    # configure formatter 'default'；跳过后 uvicorn 日志沿 root 传播进上面的脱敏
    # 轮转文件，打包版才留得下服务器日志。
    uvicorn.run(fastapi_app, host='127.0.0.1', port=port,
                log_level='warning', log_config=None)


if __name__ == '__main__':
    # 冻结产物（PyInstaller onefile）里 multiprocessing spawn 靠重新执行本 exe 创建
    # Worker，必须先让 freeze_support 认领 --multiprocessing-fork 并接管子进程。缺
    # 这一行时子进程会把 main() 整个再跑一遍（再起一个 uvicorn，并递归拉起更多
    # Worker），运行时 Worker 永远不上报 booted，于是每个站点都在启动屏障上超时成
    # L3_RUNTIME_TIMEOUT。
    _ensure_std_streams()
    multiprocessing.freeze_support()
    main()
