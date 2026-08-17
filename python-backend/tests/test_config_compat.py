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
  ~/.video-pc；结束时 JarBridge.destroy_all() 优雅关停 JVM；
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
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
CORPUS = os.path.join(HERE, 'compat_repos.json')
BASELINE = os.path.join(HERE, 'compat_baseline.json')
PROGRESS = os.path.join(HERE, 'compat_progress.jsonl')   # 逐仓增量落盘（随时可看/断点续跑）
REPORT = os.path.join(HERE, 'compat_report.txt')
REPORT_JSON = os.path.join(HERE, 'compat_report.json')

REPO_TIMEOUT = 180       # 单仓子进程硬超时（秒）。原 420s 过长且 jar 密集仓
                         # 在 Windows PIPE 模式下因 pipe 缓冲区满而死锁——
                         # 改用文件重定向后，多数仓 <60s 完成，180s 足够兜底。
HOME_PROBE_MAX = 12      # 每仓首页冒烟站点数上限
HOME_PROBE_TIMEOUT = 12  # 单站 homeContent 超时（秒）
RATE_TOLERANCE = 0.05    # 聚合率对比容差（±5pp 网络抖动）


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
    rsp = requests.post(base + '/action', data=data,
                        headers={'x-token': token}, timeout=timeout)
    try:
        payload = rsp.json()
    except ValueError:
        payload = {'code': rsp.status_code, 'msg': rsp.text[:200]}
    if isinstance(payload, dict):
        payload.setdefault('code', rsp.status_code)
    return rsp.status_code, payload


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
    tmp = tempfile.mkdtemp(prefix='vpc-compat-')
    os.environ['VPC_PORT'] = '0'
    os.environ['VPC_TOKEN'] = 'compat'
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
        'skipped': [], 'build_errors': {}, 'parse_errors': 0,
        'build_rate': 0.0, 'home_ok': 0, 'home_total': 0, 'home_rate': 0.0,
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
                if status == 200 and text.strip():
                    rec['fetch'] = 1
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
        return _finish(rec, tmp, http_instance)

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
        return _finish(rec, tmp, http_instance)
    print('[compat] S2 load done', file=sys.stderr, flush=True)
    built = int(summary.get('sites') or 0)
    skipped = summary.get('skipped') or []
    rec['sites'] = built
    rec['skipped_n'] = len(skipped)
    rec['skipped'] = [str(item) for item in skipped]
    rec['build_errors'] = summary.get('build_errors') or {}
    rec['parse_errors'] = int(summary.get('parse_errors') or 0)
    if built <= 0:
        rec['note'] = 'S2 no sites built; skipped=%s' % [str(s)[:60] for s in skipped[:3]]
        return _finish(rec, tmp, http_instance)
    rec['parse'] = 1
    rec['build_rate'] = built / max(1, built + len(skipped))

    # ---- S4 首页冒烟（通过真实 HTTP /action，抽样 jar 优先）----
    import requests
    state = requests.get(base + '/sites', headers={'x-token': token}, timeout=10).json()
    all_sites = state.get('sites') or []
    probe = ([s for s in all_sites if s.get('spiderType') == 'jar'][:4] +
             [s for s in all_sites if s.get('spiderType') != 'jar'][:HOME_PROBE_MAX])[:HOME_PROBE_MAX]

    def probe_home(site):
        try:
            _, r = _http_action(base, token, {'do': 'homeContent', 'site': site.get('key', '')},
                                timeout=HOME_PROBE_TIMEOUT)
            if r and (r.get('list') or r.get('class')):
                return site.get('key'), True, ''
            return site.get('key'), False, 'empty home'
        except Exception as e:
            return site.get('key'), False, str(e)[:80]

    with ThreadPoolExecutor(max_workers=4) as pool:
        futs = [pool.submit(probe_home, s) for s in probe]
        try:
            for fut in as_completed(futs, timeout=HOME_PROBE_TIMEOUT * max(1, len(probe) // 2 + 2)):
                key, ok, why = fut.result(timeout=HOME_PROBE_TIMEOUT)
                rec['home_total'] += 1
                if ok:
                    rec['home_ok'] += 1
        except Exception as e:
            rec['note'] = (rec['note'] + ' | ' if rec['note'] else '') + 'S4 timeout: %s' % str(e)[:60]
    if rec['home_total']:
        rec['home_rate'] = rec['home_ok'] / rec['home_total']
    return _finish(rec, tmp, http_instance)


def _finish(rec, tmp, http_instance=None):
    """优雅关停 JVM 并清理临时目录（失败不影响结果上报）。"""
    try:
        from jar_bridge import JarBridge
        JarBridge.destroy_all()
    except Exception:
        pass
    if http_instance is not None:
        http_instance.should_exit = True
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    return rec


# ------------------------------------------------------------ 主进程：编排 + 基线对比

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
        out_fd, out_path = tempfile.mkstemp(prefix='vpc-compat-out-')
        err_fd, err_path = tempfile.mkstemp(prefix='vpc-compat-err-')
        os.close(out_fd)
        os.close(err_fd)
        try:
            env = dict(os.environ, PYTHONIOENCODING='utf-8')
            with open(out_path, 'w', encoding='utf-8') as out_f, \
                 open(err_path, 'w', encoding='utf-8') as err_f:
                p = subprocess.run(
                    [sys.executable, os.path.abspath(__file__), '--one', str(i)],
                    stdout=out_f, stderr=err_f,
                    timeout=REPO_TIMEOUT, env=env, cwd=BASE)
            with open(out_path, encoding='utf-8', errors='replace') as f:
                out_text = f.read()
            with open(err_path, encoding='utf-8', errors='replace') as f:
                err_text = f.read()
            line = [l for l in out_text.splitlines()
                    if l.startswith('COMPAT_RESULT ')]
            if p.returncode == 0 and line:
                rec = json.loads(line[-1][len('COMPAT_RESULT '):])
            else:
                rec = {k: repos[i].get(k, '') for k in ('name', 'tags')}
                rec.update({'fetch': 0, 'parse': 0, 'sites': 0, 'skipped_n': 0,
                            'build_rate': 0.0, 'home_ok': 0, 'home_total': 0,
                            'home_rate': 0.0,
                            'note': 'runner crashed rc=%s: %s' % (
                                p.returncode, err_text[-160:])})
        except subprocess.TimeoutExpired:
            rec = {k: repos[i].get(k, '') for k in ('name', 'tags')}
            rec.update({'fetch': 0, 'parse': 0, 'sites': 0, 'skipped_n': 0,
                        'build_rate': 0.0, 'home_ok': 0, 'home_total': 0,
                        'home_rate': 0.0, 'note': 'runner timeout (%ss)' % REPO_TIMEOUT})
        finally:
            for _p in (out_path, err_path):
                try:
                    os.remove(_p)
                except OSError:
                    pass
        rec['elapsed'] = round(time.time() - t0, 1)
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
                    'name': skipped_repo['name'], 'tags': skipped_repo.get('tags', []),
                    'fetch': 0, 'parse': 0, 'sites': 0, 'skipped_n': 0,
                    'skipped': [], 'build_errors': {}, 'parse_errors': 0,
                    'build_rate': 0.0, 'home_ok': 0, 'home_total': 0,
                    'home_rate': 0.0, 'note': 'SKIP: offline (all S1 fetches failed)',
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
        'skipped_reasons': dict(sorted(reasons.items())),
    }


def print_report(results, agg):
    print()
    print('%-14s %-6s %-6s %-8s %-9s %s' % ('repo', 'fetch', 'parse', 'build', 'home', 'note'))
    for r in results:
        print('%-14s %-6s %-6s %-8s %-9s %s' % (
            r['name'][:13], r['fetch'], r['parse'],
            '%.0f%%' % (r['build_rate'] * 100),
            ('%d/%d' % (r['home_ok'], r['home_total'])) if r['home_total'] else '-',
            (r.get('note') or '')[:60]))
    print('---- 汇总: 拉取 %d/%d · 解析 %d/%d · 平均建站率 %.0f%% · 平均首页成功率 %.0f%%' % (
        sum(r['fetch'] for r in results), agg['repos'],
        sum(r['parse'] for r in results), agg['repos'],
        agg['avg_build_rate'] * 100, agg['avg_home_rate'] * 100))
    if agg.get('skipped_reasons'):
        print('---- skipped 原因: %s' % ' · '.join(
            '%s=%d' % (key, value) for key, value in agg['skipped_reasons'].items()))


def compare_baseline(results, agg):
    """基线回归：fetch/parse 必须持平（100%）；聚合率容差 -5pp。返回 (ok, 详情)。"""
    if not os.path.exists(BASELINE):
        return True, '无基线（首次运行，请 --update-baseline 拍快照）'
    base = json.load(open(BASELINE, encoding='utf-8'))
    ba = base.get('aggregate') or {}
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--one', type=int, default=None, help='子进程模式：跑语料中第 N 个仓库')
    ap.add_argument('--only', default='', help='只跑名字包含该关键字的仓库')
    ap.add_argument('--update-baseline', action='store_true', help='用本次结果重拍基线')
    ap.add_argument('--resume', action='store_true', help='续跑：跳过 compat_progress.jsonl 已记录的仓库')
    args = ap.parse_args()

    corpus = json.load(open(CORPUS, encoding='utf-8'))
    repos = corpus['repos']

    if args.one is not None:
        rec = run_one(repos[args.one])
        print('COMPAT_RESULT ' + json.dumps(rec, ensure_ascii=False))
        return

    if args.only:
        repos = [r for r in repos if args.only in r['name']] or repos

    print('影视仓兼容性套件：%d 个仓库 · 单仓超时 %ds · 首页抽样 ≤%d 站%s\n' % (
        len(repos), REPO_TIMEOUT, HOME_PROBE_MAX,
        ' · resume 续跑' if args.resume else ''))
    results, offline = run_corpus(repos, resume=args.resume)
    agg = aggregate(results)
    agg['offline'] = offline
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
