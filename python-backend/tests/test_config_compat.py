# -*- coding: utf-8 -*-
"""影视仓兼容性套件（TVBOX_COMPAT_PLAN 任务一）。

用法：
  python tests/test_config_compat.py                    # 全量跑语料并对比基线
  python tests/test_config_compat.py --only 哈基米       # 只跑名字含关键字的仓库
  python tests/test_config_compat.py --update-baseline  # 重拍基线
  python tests/test_config_compat.py --one <idx>        # 子进程模式（跑单仓，输出 JSON）

设计要点：
- 每仓一个子进程（--one）：任意仓库的 jar/JS 是不受信代码，崩溃/泄漏被子进程
  吸收，主进程只做编排与基线对比；
- 子进程用临时 data_dir/cache_dir/plugins_dir（hoststate.configure），不污染
  ~/.yuki；结束时 JarBridge.destroy_all() 优雅关停 JVM；
- 四阶段探测：S1 拉取(fetch_text 真实路径，含伪装/gzip/IDN) → S2 解析建站
  (config_mgr.load) → S3 建站率 → S4 首页冒烟(抽样 ≤12 站，每站 12s 超时)；
- 基线对比：fetch/parse 必须 100%（配置层回归即硬失败）；建站率/首页成功率
  聚合值允许 -5pp 网络抖动容差。
"""
import argparse
import json
import os
import subprocess
import sys
import time
import signal
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor, wait

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
CORPUS = os.path.join(HERE, 'compat_repos.json')
BASELINE = os.path.join(HERE, 'compat_baseline.json')
PROGRESS = os.path.join(HERE, 'compat_progress.jsonl')   # 逐仓增量落盘（随时可看/断点续跑）
REPORT = os.path.join(HERE, 'compat_report.txt')
REPORT_JSON = os.path.join(HERE, 'compat_report.json')
FIXTURES = os.path.join(HERE, 'fixtures')
COMPAT_TMP_ROOT = os.path.join(
    os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-runtime'), 'compat')
os.makedirs(COMPAT_TMP_ROOT, exist_ok=True)

REPO_TIMEOUT = float(os.environ.get('YUKI_COMPAT_REPO_TIMEOUT', '180'))
                         # 单仓子进程硬超时（秒）。原 420s 过长且 jar 密集仓
                         # 在 Windows PIPE 模式下因 pipe 缓冲区满而死锁——
                         # 改用文件重定向后，多数仓 <60s 完成，180s 足够兜底。
HOME_PROBE_MAX = 12      # 每仓首页冒烟站点数上限
HOME_PROBE_TIMEOUT = float(os.environ.get('YUKI_COMPAT_HOME_TIMEOUT', '12'))
HOME_PROBE_BUDGET = float(os.environ.get('YUKI_COMPAT_HOME_BUDGET', '45'))
RATE_TOLERANCE = 0.05    # 聚合率对比容差（±5pp 网络抖动）


def _stage(state='not_tested', reason=''):
    return {'state': state, 'reason': str(reason or '')[:300]}


def _compat_temp_path(prefix, create_dir=False):
    path = os.path.join(COMPAT_TMP_ROOT, '%s%s' % (prefix, uuid.uuid4().hex))
    if create_dir:
        os.makedirs(path, exist_ok=False)
    return path


def _start_fixture_server(repo):
    """为 fixture:// 仓库启动只监听 loopback 的静态服务。"""
    if not repo.get('fixture'):
        return None, repo['url']
    import functools
    import http.server
    import threading

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=FIXTURES)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True,
                              name='compat-fixture-http')
    thread.start()
    quoted = urllib.parse.quote(str(repo['fixture']).replace('\\', '/'))
    return server, 'http://127.0.0.1:%d/%s' % (server.server_port, quoted)


def _network_exit(repo):
    if repo.get('fixture'):
        return 'loopback'
    explicit = os.environ.get('YUKI_COMPAT_NETWORK_EXIT', '').strip()
    if explicit:
        return explicit[:120]
    proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('HTTP_PROXY') or ''
    if proxy:
        try:
            return 'proxy:' + (urllib.parse.urlsplit(proxy).hostname or 'configured')
        except Exception:
            return 'proxy:configured'
    return 'direct/unknown'


# ------------------------------------------------------------ 子进程模式：跑单仓

def _start_http_backend(tmp):
    """在子进程内启动生产 FastAPI 路径，返回 (server, base, token)。"""
    import socket
    import threading
    import uvicorn
    import hoststate

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    token = 'compat'
    hoststate.configure(port=port, token=token,
                        data_dir=tmp, cache_dir=os.path.join(tmp, 'cache'),
                        plugins_dir=os.path.join(tmp, 'cache', 'py'),
                        log_dir=os.path.join(tmp, 'logs'))
    import server
    app = server.create_app()
    instance = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port,
                                               log_level='error'))
    thread = threading.Thread(target=instance.run, daemon=True, name='compat-http')
    instance._compat_thread = thread
    thread.start()
    import requests
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            if requests.get(f'http://127.0.0.1:{port}/health', timeout=1).ok:
                return instance, f'http://127.0.0.1:{port}', token
        except Exception:
            time.sleep(0.1)
    instance.should_exit = True
    raise RuntimeError('[L1:fetch] compat HTTP backend did not start')


def _http_action(base, token, data, timeout=20):
    import requests
    payload_data = dict(data or {})
    request_id = str(payload_data.get('requestId') or ('compat-' + uuid.uuid4().hex))
    payload_data['requestId'] = request_id
    rsp = requests.post(base + '/action', data=payload_data,
                        headers={'x-token': token, 'x-request-id': request_id},
                        timeout=timeout)
    try:
        payload = rsp.json()
    except ValueError:
        payload = {'code': rsp.status_code, 'msg': rsp.text[:200]}
    if isinstance(payload, dict):
        payload.setdefault('code', rsp.status_code)
    return rsp.status_code, payload


def _cancel_http_action(base, token, request_id, timeout=3):
    """Cancel one exact action and return only observable cleanup facts."""
    import requests
    request_id = str(request_id or '')
    if not request_id:
        return {'cancelled': False, 'completed': False, 'workerTerminated': False}
    try:
        rsp = requests.post(
            base + '/runtime/cancel',
            params={'token': token},
            json={'requestId': request_id},
            headers={'x-token': token, 'x-request-id': request_id},
            timeout=timeout,
        )
        result = rsp.json()
        return result if isinstance(result, dict) else {}
    except Exception as exc:
        return {'cancelled': False, 'completed': False,
                'workerTerminated': False, 'reason': str(exc)}


def _load_via_http(base, token, url):
    """调用真实 loadConfig/configTask 链路，失败时由上层重试一次。"""
    status, started = _http_action(base, token, {'do': 'loadConfig', 'url': url}, timeout=20)
    if status not in (200, 202):
        raise ValueError('[L1:fetch] loadConfig HTTP %s: %s' % (status, started))
    deadline = time.time() + 60
    while time.time() < deadline:
        status, task = _http_action(base, token, {'do': 'configTask'}, timeout=10)
        if status != 200:
            raise ValueError('[L1:fetch] configTask HTTP %s' % status)
        if task.get('status') == 'done':
            return task.get('summary') or {}
        if task.get('status') == 'error':
            raise ValueError(task.get('msg') or '[L1:parse] config task failed')
        time.sleep(0.5)
    raise TimeoutError('[L1:parse] configTask timeout')

def run_one(repo):
    """进程内探测单个仓库，返回记录 dict。"""
    repo = dict(repo)
    fixture_instance, resolved_url = _start_fixture_server(repo)
    repo['url'] = resolved_url
    tmp = _compat_temp_path('yuki-compat-', create_dir=True)
    os.environ['YUKI_PORT'] = '0'
    os.environ['YUKI_TOKEN'] = 'compat'
    sys.path.insert(0, BASE)
    sys.path.insert(0, os.path.join(BASE, 'js-engine'))

    import hoststate
    hoststate.configure(
        port=0, token='compat',
        data_dir=tmp,
        cache_dir=os.path.join(tmp, 'cache'),
        plugins_dir=os.path.join(tmp, 'cache', 'py'),
        log_dir=os.path.join(tmp, 'logs'),
    )
    hoststate.ensure_dirs()

    rec = {
        'name': repo['name'], 'tags': repo.get('tags', []),
        'fetch': 0, 'parse': 0, 'sites': 0, 'skipped_n': 0,
        'configured': 0, 'built': 0, 'initialized': 0, 'healthy': 0,
        'skipped': [], 'build_errors': {}, 'parse_errors': 0,
        'build_rate': 0.0, 'home_ok': 0, 'home_total': 0, 'home_rate': 0.0,
        'sites_detail': [],
        'stages': {key: _stage() for key in ('S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6')},
        'networkExit': _network_exit(repo),
        'failureDomains': [], 'upstreamHttp': [],
        'note': '',
    }

    # ---- S1 拉取（真实 HTTP /action fetchText 路径）----
    http_instance = None
    try:
        http_instance, base, token = _start_http_backend(tmp)
        for attempt in range(2):
            print('[compat] S1 fetch start (attempt %d)' % (attempt + 1), file=sys.stderr, flush=True)
            try:
                status, payload = _http_action(base, token,
                                               {'do': 'fetchText', 'url': repo['url']}, timeout=20)
                text = payload.get('text') or ''
                upstream = payload.get('upstream') or {}
                if upstream.get('status'):
                    rec['upstreamHttp'].append(int(upstream['status']))
                if upstream.get('failureDomain') and (not text or int(upstream.get('status') or 0) >= 400):
                    rec['failureDomains'].append(str(upstream['failureDomain']))
                if status == 200 and text.strip():
                    rec['fetch'] = 1
                    rec['stages']['S0'] = _stage('passed')
                    print('[compat] S1 fetch done: %d chars' % len(text), file=sys.stderr, flush=True)
                    break
                rec['note'] = '[L1:fetch] empty response (attempt %d)' % (attempt + 1)
            except Exception as e:
                rec['note'] = '[L1:fetch] %s' % str(e)[:120]
            if attempt == 0:
                time.sleep(0.3)
    except Exception as e:
        rec['note'] = '[L1:fetch] %s' % str(e)[:120]
    if not rec['fetch']:
        rec['stages']['S0'] = _stage('failed', rec['note'])
        return _finish(rec, tmp, http_instance, fixture_instance)

    # ---- S2 解析 + 建站（真实 HTTP loadConfig → configTask 轮询）----
    print('[compat] S2 load start', file=sys.stderr, flush=True)
    summary = None
    errors = []
    for attempt in range(2):
        try:
            summary = _load_via_http(base, token, repo['url'])
            if summary.get('sites', 0) or attempt == 1:
                break
        except Exception as e:
            errors.append(str(e)[:120])
            if attempt == 0:
                time.sleep(0.3)
    if summary is None:
        rec['note'] = errors[-1] if errors else '[L1:parse] no summary'
        rec['stages']['S1'] = _stage('failed', rec['note'])
        return _finish(rec, tmp, http_instance, fixture_instance)
    print('[compat] S2 load done', file=sys.stderr, flush=True)
    built = int(summary.get('sites') or 0)
    skipped = summary.get('skipped') or []
    rec['sites'] = built
    rec['skipped_n'] = len(skipped)
    rec['skipped'] = [str(item) for item in skipped]
    rec['build_errors'] = summary.get('build_errors') or {}
    rec['parse_errors'] = int(summary.get('parse_errors') or 0)
    rec['configured'] = int(summary.get('configured') or built + len(skipped))
    rec['built'] = int(summary.get('built') or summary.get('sites_built') or built)
    rec['initialized'] = int(summary.get('initialized') or 0)
    rec['healthy'] = int(summary.get('healthy') or 0)
    rec['parse'] = 1
    rec['stages']['S1'] = _stage('passed')
    if built <= 0:
        rec['note'] = 'S2 no sites built; skipped=%s' % [str(s)[:60] for s in skipped[:3]]
        rec['stages']['S2'] = _stage('failed', rec['note'])
        return _finish(rec, tmp, http_instance, fixture_instance)
    rec['stages']['S2'] = _stage('passed' if rec['healthy'] else 'failed',
                                        '' if rec['healthy'] else 'no healthy sites')
    rec['build_rate'] = built / max(1, built + len(skipped))

    # ---- S4 首页冒烟（通过真实 HTTP /action，抽样 jar 优先）----
    import requests
    state = requests.get(base + '/sites', headers={'x-token': token}, timeout=10).json()
    all_sites = state.get('sites') or []
    rec['sites_detail'] = [dict(item) for item in (state.get('diagnostics') or [])]
    by_key = {item.get('siteKey'): item for item in rec['sites_detail']}
    probe = ([s for s in all_sites if s.get('spiderType') == 'jar'][:4] +
             [s for s in all_sites if s.get('spiderType') != 'jar'][:HOME_PROBE_MAX])[:HOME_PROBE_MAX]

    probe_control = {}

    def probe_home(site):
        outcome = {'key': site.get('key'), 'home': _stage(), 'play': _stage(), 'media': _stage()}
        request_id = 'compat-probe-' + uuid.uuid4().hex
        control = {'requestId': request_id, 'runtimeActive': False}
        probe_control[site.get('key')] = control

        def action(data):
            control['runtimeActive'] = True
            try:
                return _http_action(
                    base, token, {**data, 'requestId': request_id},
                    timeout=HOME_PROBE_TIMEOUT)
            finally:
                control['runtimeActive'] = False

        try:
            status, r = action({
                'do': 'homeContent', 'site': site.get('key', ''),
            })
            if status != 200 or (isinstance(r.get('error'), dict)):
                error = r.get('error') or {}
                outcome['home'] = _stage('failed', error.get('code') or error.get('message') or status)
                return outcome
            if r and (r.get('list') or r.get('class')):
                outcome['home'] = _stage('passed')
            else:
                outcome['home'] = _stage('failed', 'empty home')
                return outcome
            items = r.get('list') or []
            vod_id = str((items[0] if items else {}).get('vod_id') or '')
            if not vod_id:
                outcome['play'] = _stage('not_tested', 'home has no vod_id')
                return outcome
            d_status, detail = action({
                'do': 'detailContent', 'site': site.get('key', ''),
                'ids': json.dumps([vod_id], ensure_ascii=False),
            })
            vod = ((detail.get('list') or [{}])[0]) if d_status == 200 else {}
            play_from = str(vod.get('vod_play_from') or '').split('$$$')[0]
            play_group = str(vod.get('vod_play_url') or '').split('$$$')[0]
            episode_id = play_group.split('#')[0].split('$')[-1] if play_group else ''
            if not episode_id:
                outcome['play'] = _stage('failed', 'detail has no episode id')
                return outcome
            p_status, play = action({
                'do': 'playerContent', 'site': site.get('key', ''),
                'flag': play_from, 'id': episode_id, 'vipFlags': '[]',
            })
            media_url = str(play.get('url') or '')
            if p_status != 200 or not media_url:
                error = play.get('error') or {}
                outcome['play'] = _stage('failed',
                    error.get('code') if isinstance(error, dict) else error or 'empty url')
                return outcome
            outcome['play'] = _stage('passed')
            try:
                media_rsp = requests.get(media_url, headers={'Range': 'bytes=0-1'},
                                         timeout=HOME_PROBE_TIMEOUT, stream=True)
                content_type = str(media_rsp.headers.get('content-type') or '').lower()
                if media_rsp.status_code in (200, 206) and 'text/html' not in content_type:
                    outcome['media'] = _stage('passed')
                else:
                    outcome['media'] = _stage('failed', 'HTTP %s %s' % (
                        media_rsp.status_code, content_type))
                media_rsp.close()
            except Exception as exc:
                outcome['media'] = _stage('failed', str(exc))
            return outcome
        except Exception as e:
            timed_out = isinstance(e, (TimeoutError, requests.Timeout)) or 'timed out' in str(e).lower()
            outcome['home'] = _stage(
                'timeout' if timed_out else 'failed', str(e))
            return outcome

    pool = ThreadPoolExecutor(max_workers=min(4, max(1, len(probe))))
    futures = {pool.submit(probe_home, site): site for site in probe}
    done, pending = wait(futures, timeout=HOME_PROBE_BUDGET)
    outcomes = []
    for fut in done:
        try:
            outcomes.append(fut.result(timeout=0.1))
        except Exception as exc:
            outcomes.append({'key': futures[fut].get('key'), 'home': _stage('failed', exc),
                             'play': _stage(), 'media': _stage()})
    for fut in pending:
        site = futures[fut]
        control = probe_control.get(site.get('key')) or {}
        cancel_state = {}
        if control.get('runtimeActive'):
            cancel_state = _cancel_http_action(
                base, token, control.get('requestId'), timeout=3)
        # Future.cancel() is only allowed to prevent a task that has not
        # started.  A running probe is called cancelled only after the exact
        # backend request reports both Worker termination and dispatch cleanup.
        never_started = fut.cancel()
        confirmed = bool(
            cancel_state.get('cancelled')
            and cancel_state.get('workerTerminated')
            and cancel_state.get('completed'))
        if confirmed:
            try:
                fut.result(timeout=2)
            except Exception:
                pass
            confirmed = fut.done()
        remaining_state = ('cancelled' if confirmed else 'not_tested')
        remaining_reason = ('exact request Worker terminated' if confirmed else
                            'probe budget exceeded before cleanup confirmation')
        if never_started:
            remaining_reason = 'probe did not start before budget expired'
        outcomes.append({'key': futures[fut].get('key'),
                         'home': _stage('timeout', 'home probe budget exceeded'),
                         'play': _stage(remaining_state, remaining_reason),
                         'media': _stage(remaining_state, remaining_reason)})
    # 关键：不能使用 ``with ThreadPoolExecutor``，其 __exit__ 会 wait=True。
    pool.shutdown(wait=False, cancel_futures=True)
    rec['home_total'] = len(probe)
    for outcome in outcomes:
        if outcome['home']['state'] == 'passed':
            rec['home_ok'] += 1
        health = by_key.get(outcome.get('key'))
        if health is not None:
            health['home'] = outcome['home']
            health['play'] = outcome['play']
            health['media'] = outcome['media']
            # The config summary is an init snapshot.  Once the compatibility
            # probe has observed a failed/timeout home call, the report must
            # not continue presenting that site as end-to-end healthy.
            if outcome['home']['state'] != 'passed':
                health['healthy'] = False
                health['state'] = outcome['home']['state']
                health['lastError'] = {
                    'code': ('L3_RUNTIME_TIMEOUT'
                             if outcome['home']['state'] == 'timeout'
                             else 'L3_RUNTIME_CANCELLED'
                             if outcome['home']['state'] == 'cancelled'
                             else 'L3_RUNTIME_CALL_FAILED'),
                    'stage': 'runtime',
                    'retryable': True,
                    'siteKey': health.get('siteKey', outcome.get('key') or ''),
                    'runtime': health.get('runtime', ''),
                    'message': str(outcome['home'].get('reason') or 'home probe failed')[:240],
                }
                health['consecutiveFailures'] = max(1, int(health.get('consecutiveFailures') or 0) + 1)
    if pending:
        rec['note'] = (rec['note'] + ' | ' if rec['note'] else '') + 'S3 home timeout/cancel=%d' % len(pending)
    if rec['home_total']:
        rec['home_rate'] = rec['home_ok'] / rec['home_total']
    rec['healthy'] = sum(1 for item in rec['sites_detail'] if item.get('healthy'))
    home_timed_out = any(item['home']['state'] == 'timeout' for item in outcomes)
    home_state = 'passed' if rec['home_ok'] else ('timeout' if home_timed_out else 'failed')
    rec['stages']['S3'] = _stage(home_state,
                                  '' if rec['home_ok'] else 'no home probe passed')
    play_ok = sum(1 for item in outcomes if item['play']['state'] == 'passed')
    media_ok = sum(1 for item in outcomes if item['media']['state'] == 'passed')
    rec['stages']['S4'] = _stage('passed' if play_ok else 'not_tested',
                                  '' if play_ok else 'no routable fixture episode')
    rec['stages']['S5'] = _stage('passed' if media_ok else 'not_tested',
                                  '' if media_ok else 'no media URL reached')
    rec['stages']['S6'] = _stage('not_tested', 'Python compatibility suite does not launch mpv')
    return _finish(rec, tmp, http_instance, fixture_instance)


def _finish(rec, tmp, http_instance=None, fixture_instance=None):
    """走生产销毁链关停 Worker/JVM/端口并清理临时目录。"""
    try:
        import server
        server.sites.destroy_all()
    except Exception:
        pass
    try:
        from jar_bridge import JarBridge
        JarBridge.destroy_all()
    except Exception:
        pass
    if http_instance is not None:
        http_instance.should_exit = True
        thread = getattr(http_instance, '_compat_thread', None)
        if thread is not None:
            thread.join(timeout=1)
            if thread.is_alive():
                # The test host already ran the production resource teardown
                # above. Do not leave Uvicorn's graceful keep-alive wait to
                # keep the per-repository process alive after its result.
                http_instance.force_exit = True
                thread.join(timeout=3)
    if fixture_instance is not None:
        try:
            fixture_instance.shutdown()
            fixture_instance.server_close()
        except Exception:
            pass
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    return rec


# ------------------------------------------------------------ 主进程：编排 + 基线对比

def _terminate_process_tree(proc):
    """强制结束兼容子进程及其 JVM/Python 后代，并等待句柄回收。"""
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == 'nt':
            result = subprocess.run(
                ['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=10, check=False,
            )
            if result.returncode != 0:
                proc.kill()
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    try:
        proc.wait(timeout=10)
    except Exception:
        pass


def _pid_exists(pid):
    """Check a fixture descendant without adding a psutil dependency."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == 'nt':
        try:
            result = subprocess.run(
                ['tasklist', '/FI', 'PID eq %d' % pid, '/NH'],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=5, check=False)
            text = result.stdout.decode(errors='replace')
            return ('No tasks are running' not in text
                    and '没有运行的任务' not in text
                    and str(pid) in text)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return False
    return True


def _fixture_child_pid(path):
    try:
        with open(path, encoding='ascii') as f:
            return int(f.read().strip())
    except (OSError, TypeError, ValueError):
        return None


def _empty_record(repo, note):
    return {
        'name': repo.get('name', ''), 'tags': repo.get('tags', []),
        'fetch': 0, 'parse': 0, 'sites': 0, 'skipped_n': 0,
        'configured': 0, 'built': 0, 'initialized': 0, 'healthy': 0,
        'skipped': [], 'build_errors': {}, 'parse_errors': 0,
        'build_rate': 0.0, 'home_ok': 0, 'home_total': 0,
        'home_rate': 0.0, 'sites_detail': [],
        'stages': {key: _stage('failed' if key == 'S0' else 'not_tested', note if key == 'S0' else '')
                   for key in ('S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6')},
        'termination': {'mode': 'not_started', 'forced': False},
        'networkExit': _network_exit(repo), 'failureDomains': [],
        'upstreamHttp': [], 'note': note,
    }

def run_corpus(repos, resume=False):
    """逐仓起子进程执行（串行：JVM/网络资源可控，失败互不影响）。

    每仓结果立刻追加到 compat_progress.jsonl——长跑可随时查看进度、
    中断后 --resume 续跑不重复已完成的仓库。
    """
    done = {}
    if resume and os.path.exists(PROGRESS):
        for line in open(PROGRESS, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                done[r['name']] = r
            except ValueError:
                continue
    if not done:
        open(PROGRESS, 'w', encoding='utf-8').close()   # 新一轮：清空进度
    results = []
    first_fetch_failure_at = None
    offline = False
    for i, repo in enumerate(repos):
        if repo['name'] in done:
            print('[%2d/%d] %s ...（resume 命中，跳过）' % (i + 1, len(repos), repo['name']), flush=True)
            results.append(done[repo['name']])
            continue
        print('[%2d/%d] %s ...' % (i + 1, len(repos), repo['name']), flush=True)
        t0 = time.time()
        # 子进程输出重定向到临时文件，而非 capture_output=True（PIPE）。
        # 原因：jar spider 初始化会向 stderr 打印大量堆栈（10KB+），
        # Windows 默认 4KB 管道缓冲区塞满后子进程阻塞在 write()，
        # 父进程只在 run() 结束才读 → 死锁，表现为子进程卡到 420s 超时。
        out_path = _compat_temp_path('yuki-compat-out-')
        err_path = _compat_temp_path('yuki-compat-err-')
        p = None
        child_pid_path = _compat_temp_path('yuki-compat-child-')
        recorded_child_pid = None
        forced_termination = False
        try:
            env = dict(os.environ, PYTHONIOENCODING='utf-8')
            # Timeout/infinite fixtures spawn one untrusted Python descendant;
            # the parent records its PID so the test proves tree termination,
            # not merely that the top-level child stopped responding.
            env['YUKI_COMPAT_CHILD_PID_FILE'] = child_pid_path
            if repo.get('fixture'):
                env.setdefault('YUKI_COMPAT_HOME_TIMEOUT', '0.75')
                env.setdefault('YUKI_COMPAT_HOME_BUDGET', '1.5')
            with open(out_path, 'w', encoding='utf-8') as out_f, \
                 open(err_path, 'w', encoding='utf-8') as err_f:
                popen_args = {
                    'args': [sys.executable, os.path.abspath(__file__),
                             '--one-name', repo['name']],
                    'stdout': out_f, 'stderr': err_f,
                    'env': env, 'cwd': BASE,
                }
                if os.name == 'nt':
                    popen_args['creationflags'] = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
                else:
                    popen_args['start_new_session'] = True
                p = subprocess.Popen(**popen_args)
                try:
                    p.wait(timeout=REPO_TIMEOUT)
                except subprocess.TimeoutExpired:
                    forced_termination = True
                    child_pid = _fixture_child_pid(child_pid_path)
                    _terminate_process_tree(p)
                    child_alive = _pid_exists(child_pid)
                    # The child writes its complete record before the parent
                    # kills the process.  Preserve that evidence instead of
                    # replacing a real timeout with an empty crash record.
                    try:
                        with open(out_path, encoding='utf-8', errors='replace') as f:
                            out_text = f.read()
                        line = [l for l in out_text.splitlines()
                                if l.startswith('COMPAT_RESULT ')]
                        rec = json.loads(line[-1][len('COMPAT_RESULT '):]) if line else None
                    except Exception:
                        rec = None
                    if rec is None:
                        rec = _empty_record(repo, 'runner timeout (%ss); process tree terminated' % REPO_TIMEOUT)
                    rec['termination'] = {
                        'mode': 'process_tree', 'forced': True,
                        'descendantPids': [child_pid] if child_pid else [],
                        'descendantsAlive': bool(child_alive),
                    }
                    rec['note'] = (rec.get('note') + ' | ' if rec.get('note') else '') + \
                        'parent process tree terminated after %ss' % REPO_TIMEOUT
            with open(out_path, encoding='utf-8', errors='replace') as f:
                out_text = f.read() if not forced_termination else out_text
            with open(err_path, encoding='utf-8', errors='replace') as f:
                err_text = f.read()
            line = [l for l in out_text.splitlines()
                    if l.startswith('COMPAT_RESULT ')]
            if p.returncode == 0 and line:
                rec = json.loads(line[-1][len('COMPAT_RESULT '):])
            else:
                if not forced_termination:
                    rec = _empty_record(repo, 'runner crashed rc=%s: %s' % (
                        p.returncode, err_text[-160:]))
        finally:
            if p is not None and p.poll() is None:
                _terminate_process_tree(p)
            recorded_child_pid = _fixture_child_pid(child_pid_path)
            for _p in (out_path, err_path):
                try:
                    os.remove(_p)
                except OSError:
                    pass
            try:
                os.remove(child_pid_path)
            except OSError:
                pass
        rec['elapsed'] = round(time.time() - t0, 1)
        if not forced_termination:
            descendant_alive = _pid_exists(recorded_child_pid)
            rec['termination'] = {
                'mode': 'natural', 'forced': False,
                'descendantPids': [recorded_child_pid] if recorded_child_pid else [],
                'descendantsAlive': bool(descendant_alive),
            }
            if descendant_alive:
                if os.name == 'nt':
                    subprocess.run(
                        ['taskkill', '/PID', str(recorded_child_pid), '/T', '/F'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        timeout=5, check=False)
                else:
                    try:
                        os.kill(recorded_child_pid, signal.SIGKILL)
                    except OSError:
                        pass
        rec.setdefault('termination', {'mode': 'natural', 'forced': False})
        results.append(rec)
        if not rec.get('fetch'):
            if first_fetch_failure_at is None:
                first_fetch_failure_at = time.time()
            if not any(r.get('fetch') for r in results) and time.time() - first_fetch_failure_at >= 30:
                offline = True
        else:
            first_fetch_failure_at = None
        # 增量落盘：任何时刻中断，已完成仓库的结果不丢
        with open(PROGRESS, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        print('       fetch=%s parse=%s sites=%d build=%.0f%% home=%d/%d %s' % (
            rec['fetch'], rec['parse'], rec['sites'], rec['build_rate'] * 100,
            rec['home_ok'], rec['home_total'],
            ('(%s)' % rec['note'][:70]) if rec.get('note') else ''), flush=True)
        if offline:
            for skipped_repo in repos[i + 1:]:
                results.append({
                    **_empty_record(skipped_repo, 'SKIP: offline (all S0 fetches failed)'),
                    'elapsed': 0.0,
                })
            break
    return results, offline


def aggregate(results):
    n = len(results) or 1
    reasons = {}
    for record in results:
        for reason in record.get('skipped', []) or []:
            import re
            match = re.search(r'\[L\d:[^\]]+\]', str(reason))
            key = match.group(0) if match else 'unlabelled'
            reasons[key] = reasons.get(key, 0) + 1
    return {
        'repos': n,
        'fetch_rate': sum(r['fetch'] for r in results) / n,
        'parse_rate': sum(r['parse'] for r in results) / n,
        'avg_build_rate': sum(r['build_rate'] for r in results) / n,
        'avg_home_rate': sum(r['home_rate'] for r in results
                             if r['home_total']) / max(1, sum(1 for r in results if r['home_total'])),
        'skipped_total': sum(r.get('skipped_n', 0) for r in results),
        'configured_total': sum(r.get('configured', 0) for r in results),
        'built_total': sum(r.get('built', 0) for r in results),
        'initialized_total': sum(r.get('initialized', 0) for r in results),
        'healthy_total': sum(r.get('healthy', 0) for r in results),
        'forced_terminations': sum(int((r.get('termination') or {}).get('forced', False))
                                   for r in results),
        'stage_passed': {
            stage: sum(1 for r in results if (r.get('stages') or {}).get(stage, {}).get('state') == 'passed')
            for stage in ('S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6')
        },
        'skipped_reasons': dict(sorted(reasons.items())),
    }


def print_report(results, agg):
    print()
    print('%-18s %-4s %-4s %-4s %-4s %-4s %-4s %-4s %s' % (
        'repo', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'note'))
    for r in results:
        stages = r.get('stages') or {}
        marker = lambda key: str((stages.get(key) or {}).get('state', '-'))[:4]
        print('%-18s %-4s %-4s %-4s %-4s %-4s %-4s %-4s %s' % (
            r['name'][:17], *(marker(key) for key in ('S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6')),
            (r.get('note') or '')[:60]))
    print('---- 汇总: 拉取 %d/%d · 解析 %d/%d · 平均建站率 %.0f%% · 平均首页成功率 %.0f%%' % (
        sum(r['fetch'] for r in results), agg['repos'],
        sum(r['parse'] for r in results), agg['repos'],
        agg['avg_build_rate'] * 100, agg['avg_home_rate'] * 100))
    print('---- 状态: configured=%d · built=%d · initialized=%d · healthy=%d' % (
        agg.get('configured_total', 0), agg.get('built_total', 0),
        agg.get('initialized_total', 0), agg.get('healthy_total', 0)))
    if agg.get('skipped_reasons'):
        print('---- skipped 原因: %s' % ' · '.join(
            '%s=%d' % (key, value) for key, value in agg['skipped_reasons'].items()))


def compare_baseline(results, agg):
    """基线回归：fetch/parse 必须持平（100%）；聚合率容差 -5pp。返回 (ok, 详情)。"""
    if not os.path.exists(BASELINE):
        return True, '无基线（首次运行，请 --update-baseline 拍快照）'
    base = json.load(open(BASELINE, encoding='utf-8'))
    ba = base.get('aggregate') or {}
    if agg.get('mode') == 'public':
        return True, '公共仓只生成趋势报告，不参与确定性离线基线门禁'
    problems = []
    if agg['fetch_rate'] < ba.get('fetch_rate', 1.0):
        problems.append('拉取率回归: %.0f%% -> %.0f%%' % (ba['fetch_rate'] * 100, agg['fetch_rate'] * 100))
    if agg['parse_rate'] < ba.get('parse_rate', 1.0):
        problems.append('解析率回归: %.0f%% -> %.0f%%' % (ba['parse_rate'] * 100, agg['parse_rate'] * 100))
    for key, label in (('avg_build_rate', '平均建站率'), ('avg_home_rate', '平均首页成功率')):
        if agg[key] < ba.get(key, 0.0) - RATE_TOLERANCE:
            problems.append('%s回归: %.0f%% -> %.0f%%（容差 %dpp）' % (
                label, ba[key] * 100, agg[key] * 100, int(RATE_TOLERANCE * 100)))
    # 逐仓：基线里 fetch/parse=1 的仓掉了才算回归（单仓网络抖动不放大）
    base_repos = {r['name']: r for r in base.get('repos', [])}
    for r in results:
        b = base_repos.get(r['name'])
        if b and b.get('parse') and not r['parse']:
            problems.append('%s: 基线可解析 → 现在解析失败 (%s)' % (r['name'], (r.get('note') or '')[:60]))
    return (not problems), ('; '.join(problems) if problems else '与基线一致（±5pp 容差内）')


def compare_expectations(repos, results):
    expected = {repo['name']: repo.get('expect') or {} for repo in repos}
    problems = []
    for record in results:
        for stage, wanted in expected.get(record.get('name'), {}).items():
            actual = ((record.get('stages') or {}).get(stage) or {}).get('state')
            if actual != wanted:
                problems.append('%s %s: expected %s, got %s' % (
                    record.get('name'), stage, wanted, actual))
    return (not problems), problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--one', type=int, default=None, help='子进程模式：跑语料中第 N 个仓库')
    ap.add_argument('--one-name', default='', help=argparse.SUPPRESS)
    ap.add_argument('--only', default='', help='只跑名字包含该关键字的仓库')
    ap.add_argument('--offline', action='store_true', help='只跑确定性本地夹具（默认）')
    ap.add_argument('--public', action='store_true', help='跑 21 仓公共语料（结果受外网影响）')
    ap.add_argument('--update-baseline', action='store_true', help='用本次结果重拍基线')
    ap.add_argument('--resume', action='store_true', help='续跑：跳过 compat_progress.jsonl 已记录的仓库')
    args = ap.parse_args()

    corpus = json.load(open(CORPUS, encoding='utf-8'))
    all_repos = list(corpus.get('offline') or []) + list(corpus.get('repos') or [])
    repos = list(corpus.get('repos') or []) if args.public else list(corpus.get('offline') or [])
    if args.public and args.update_baseline:
        raise SystemExit('公共仓结果受外网影响，不能更新确定性基线；请使用 --offline --update-baseline')

    if args.one is not None:
        rec = run_one(all_repos[args.one])
        print('COMPAT_RESULT ' + json.dumps(rec, ensure_ascii=False), flush=True)
        return

    if args.one_name:
        matched = [repo for repo in all_repos if repo.get('name') == args.one_name]
        if not matched:
            raise SystemExit('unknown compatibility repo: %s' % args.one_name)
        rec = run_one(matched[0])
        print('COMPAT_RESULT ' + json.dumps(rec, ensure_ascii=False), flush=True)
        return

    if args.only:
        repos = [r for r in repos if args.only in r['name']] or repos

    mode = 'public' if args.public else 'offline'
    print('影视仓兼容性套件：%d 个仓库 · 模式 %s · 单仓超时 %ss · 首页抽样 ≤%d 站%s\n' % (
        len(repos), mode, REPO_TIMEOUT, HOME_PROBE_MAX,
        ' · resume 续跑' if args.resume else ''))
    results, offline = run_corpus(repos, resume=args.resume)
    agg = aggregate(results)
    agg['offline'] = offline
    agg['mode'] = mode
    print_report(results, agg)
    # 报告同步落盘（后台长跑时无需等终端缓冲）
    import io as _io
    import contextlib
    with open(REPORT, 'w', encoding='utf-8') as rf:
        with contextlib.redirect_stdout(_io.StringIO()) as buf:
            print_report(results, agg)
            ok2, detail2 = compare_baseline(results, agg)
            print('\n基线对比: %s — %s' % ('PASS' if ok2 else 'FAIL', detail2))
        rf.write(buf.getvalue())
        print('\n（报告已写入 %s）' % REPORT)
    with open(REPORT_JSON, 'w', encoding='utf-8') as rf:
        json.dump({'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
                   'offline': offline, 'aggregate': agg, 'repos': results},
                  rf, ensure_ascii=False, indent=2)
    print('（结构化报告已写入 %s）' % REPORT_JSON)

    fixtures_ok, fixture_problems = compare_expectations(repos, results)
    if any(repo.get('expect') for repo in repos):
        print('\n离线期望: %s%s' % (
            'PASS' if fixtures_ok else 'FAIL',
            '' if fixtures_ok else ' — ' + '; '.join(fixture_problems)))
        if not fixtures_ok:
            sys.exit(1)

    if offline:
        print('\n兼容性套件：SKIP — 当前环境疑似离线，未将网络失败判为回归')
        return

    if args.update_baseline:
        json.dump({'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
                   'aggregate': agg, 'repos': results},
                  open(BASELINE, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print('\n基线已更新: %s' % BASELINE)
        return

    ok, detail = compare_baseline(results, agg)
    print('\n基线对比: %s — %s' % ('PASS' if ok else 'FAIL', detail))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
