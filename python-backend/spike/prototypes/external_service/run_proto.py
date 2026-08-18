# -*- coding: utf-8 -*-
"""方案3【外部 drpy 服务】原型 —— 端到端实测 + 评测驱动。

覆盖四部分（对应任务要求）：

    [A] 契约实测    ExternalDrpySpider 实现 base Spider 接口，五方法 +
                    辅助方法返回标准 dict（自动托管服务进程，零配置接入）；
    [B] 进程保活    杀死外部服务子进程，看门狗退避重启、适配器自动恢复；
    [C] 网络开销    冷连接 vs 稳态 keep-alive、传输+序列化 vs 服务端计算、
                    payload 大小（demo_cms vs demo_movie）的影响；
    [D] 部署风险    端口自动分配、固定端口冲突、--token 鉴权（防端口裸奔）。

运行（从 python-backend 目录）:
    .venv/Scripts/python.exe spike/prototypes/external_service/run_proto.py

退出码: 0 = 全部通过；1 = 存在失败断言。
"""

import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # python-backend/
PROTO_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))       # 使 base 包可导入
sys.path.insert(0, str(PROTO_DIR))  # 与 spike/fixtures 一致的平级模块导入

from external_service_spider import (  # noqa: E402
    DrpyServiceClient,
    DrpyServiceError,
    ExternalDrpySpider,
    ManagedDrpyService,
    create_external_spider,
)

SERVICE_SCRIPT = PROTO_DIR / 'drpy_service.py'

_PASS = 0


def check(cond, label, detail=''):
    """断言式检查：失败累积计数并继续。"""
    global _PASS
    mark = 'PASS' if cond else 'FAIL'
    if not cond:
        _PASS += 1
    print(f'  [{mark}] {label}' + (f'  ({detail})' if detail else ''))
    return cond


def section(title):
    print(f'\n=== {title} ===')


# ---------------------------------------------------------------- A. 契约实测
def test_contract():
    section('A. 契约实测：ExternalDrpySpider 实现 base Spider 接口（自动托管进程）')
    spider = create_external_spider(rule='demo_movie')  # base_url 缺省 → 自动拉起独立服务
    try:
        spider.init('spike-proto')
        ok = True
        # getName / getDependence
        ok &= check(spider.getName() == 'demo_movie', 'getName() == rule 名', spider.getName())
        ok &= check(isinstance(spider.getDependence(), list), 'getDependence() 返回 list')

        # homeContent
        home = spider.homeContent(False)
        ok &= check(set(home) >= {'class', 'list', 'filters'}, 'homeContent() 返回 {class,list,filters}')
        ok &= check(len(home['list']) == 12, 'homeContent().list 含 12 条', f"len={len(home['list'])}")
        ok &= check(all(v.get('vod_id') and v.get('vod_name') and 'vod_pic' in v
                        for v in home['list']), 'homeContent() 每条 vod 为标准字段')

        # homeVideoContent / categoryContent
        hvc = spider.homeVideoContent()
        ok &= check(isinstance(hvc.get('list'), list) and len(hvc['list']) > 0,
                    'homeVideoContent() 返回 {list}')
        cat = spider.categoryContent('movie', '2', False, {})
        ok &= check(set(cat) >= {'list', 'page', 'pagecount'}, 'categoryContent() 返回分页字段')

        # detailContent —— 标准播放字段（3 线 × 24 集，大 payload）
        det = spider.detailContent(['h01'])
        item = det['list'][0]
        ok &= check('vod_play_from' in item and 'vod_play_url' in item,
                    'detailContent() 返回 vod_play_from/vod_play_url')
        ok &= check(item['vod_play_from'].count('$$$') == 2, '3 条播放线路')
        ok &= check(len(item['vod_play_url'].split('$$$')[0].split('#')) == 24,
                    '每条线路 24 集')

        # searchContent / playerContent
        sea = spider.searchContent('测试', False, '1')
        ok &= check(len(sea['list']) == 8, 'searchContent() 返回 8 条', f"len={len(sea['list'])}")
        pla = spider.playerContent('demo_movie', 'h01', [])
        ok &= check(isinstance(pla.get('url'), str) and bool(pla['url']),
                    'playerContent() 返回 url 字段', pla.get('url'))

        # 辅助方法（可远程也可本地语义）
        lp = spider.localProxy({'path': '/x'})
        ok &= check(isinstance(lp, list) and len(lp) == 3, 'localProxy() 返回 [status, ct, body]')
        ok &= check(isinstance(spider.isVideoFormat('http://a/b.mp4'), bool), 'isVideoFormat() bool')
        ok &= check(isinstance(spider.manualVideoCheck(), bool), 'manualVideoCheck() bool')
        ok &= check(isinstance(spider.action({'do': 'x'}), dict), 'action() dict')
        ok &= check(isinstance(spider.liveContent('http://x'), dict), 'liveContent() dict')

        # 客户端统计
        st = spider.stats()
        ok &= check(st['calls'] >= 14 and st['errors'] == 0,
                    '客户端统计无错误', f"calls={st['calls']} errors={st['errors']}")

        if ok:
            print('  [PASS] A 段全部通过：base Spider 接口 -> 外部服务 REST -> 标准 dict')
    finally:
        spider.destroy()
    return ok


# ---------------------------------------------------------------- B. 进程保活
def test_keepalive():
    section('B. 进程保活：子进程被杀 -> 看门狗重启 -> 适配器自动恢复')
    spider = create_external_spider(rule='demo_stateful', timeout=8.0)
    managed = spider.service
    ok = True
    try:
        pid0 = managed.proc.pid
        url0 = managed.base_url
        det0 = spider.detailContent(['v1'])
        check(det0['list'][0]['vod_id'] == 'v1', '重启前调用正常')

        managed.kill_for_test()          # 模拟外部服务进程意外死亡
        deadline = time.time() + 25
        while time.time() < deadline and (managed.proc is None
                                          or managed.proc.poll() is not None
                                          or managed.restart_count == 0):
            time.sleep(0.5)
        ok &= check(managed.restart_count >= 1, '看门狗检测到死亡并完成重启',
                    f'restart_count={managed.restart_count}')
        ok &= check(managed.proc is not None and managed.proc.pid != pid0,
                    '新子进程已拉起（pid 变化）', f'{pid0} -> {managed.proc.pid}')

        # 适配器必须自动恢复（on_restart 回调更新 base_url + 重建连接）
        det1 = spider.detailContent(['v1'])
        ok &= check(det1['list'][0]['vod_id'] == 'v1', '重启后适配器无需人工干预即可调用')
        pla = spider.playerContent('demo_stateful', 'v1', [])
        ok &= check('session=' in pla['url'], '服务端会话状态随进程重建可用')

        # 事件日志可审计
        ev = [m for _, m in managed.events if m.startswith('restarting')]
        ok &= check(len(ev) >= 1, '保活事件已记录', ev[0] if ev else '')
    finally:
        spider.destroy()
        check(managed.proc is None, 'destroy() 回收子进程（无孤儿进程）')
    return ok


# ---------------------------------------------------------------- C. 网络开销
def _fmt_ms(v):
    return f'{v:8.3f} ms' if v is not None else '      n/a'


def test_overhead():
    section('C. 网络开销：冷连接 / keep-alive 稳态 / 传输 vs 计算 / payload 大小')
    ok = True

    # C1: 零人工延迟 —— 纯传输 + 序列化开销
    svc0 = ManagedDrpyService(port=0, latency_ms=0)
    svc0.start()
    spider0 = ExternalDrpySpider(service=svc0, rule='demo_movie', timeout=8.0)
    try:
        b_home = spider0.benchmark('homeContent', n=100, warmup=5, name='demo_movie.homeContent (0ms)')
        b_det = spider0.benchmark('detailContent', ['h01'], n=100, warmup=5,
                                  name='demo_movie.detailContent (0ms)')
        print('  [metric] 零人工延迟（纯传输+序列化开销）:')
        for m in (b_home, b_det):
            print(f'    {m["benchmark"]:<42} cold={_fmt_ms(m["cold_connect_ms"])} '
                  f'avg={_fmt_ms(m["avg_ms"])} p95={_fmt_ms(m["p95_ms"])} '
                  f'bytes/call={m["bytes_per_call"]}')
            print(f'      service(计算)={_fmt_ms(m["service_ms"])} '
                  f'net_overhead(传输+序列化)={_fmt_ms(m["net_overhead_ms"])} '
                  f'占比={m["overhead_pct"]}%')
        ok &= check(b_home['cold_connect_ms'] is not None and b_home['cold_connect_ms'] > b_home['avg_ms'],
                    '冷连接 > 稳态（新建 TCP 连接有额外开销）',
                    f"cold={b_home['cold_connect_ms']} vs avg={b_home['avg_ms']}")
        ok &= check(b_det['net_overhead_ms'] is not None and b_det['net_overhead_ms'] < 5.0,
                    '单次调用传输+序列化开销 < 5ms', f"{b_det['net_overhead_ms']} ms")
    finally:
        spider0.destroy()

    # C2: 8ms 人工延迟 —— 规则计算占主导时网络开销占比
    svc8 = ManagedDrpyService(port=0, latency_ms=8)
    svc8.start()
    spider8 = ExternalDrpySpider(service=svc8, rule='demo_movie', timeout=8.0)
    try:
        b8 = spider8.benchmark('homeContent', n=60, warmup=3, name='demo_movie.homeContent (8ms sim)')
        print('  [metric] 8ms 人工延迟（模拟真实规则计算/上游耗时）:')
        print(f'    {b8["benchmark"]:<42} avg={_fmt_ms(b8["avg_ms"])} '
              f'service(计算)={_fmt_ms(b8["service_ms"])} '
              f'net_overhead(传输+序列化)={_fmt_ms(b8["net_overhead_ms"])} '
              f'占比={b8["overhead_pct"]}%')
        ok &= check(b8['service_ms'] is not None and 7.0 <= b8['service_ms'] <= 12.0,
                    '服务端耗时≈模拟延迟', f"{b8['service_ms']} ms")
        ok &= check(b8['overhead_pct'] < 30.0,
                    '规则计算主导时网络开销占比被摊薄', f"{b8['overhead_pct']}%")
    finally:
        spider8.destroy()

    # C3: payload 大小对比（小规则 vs 大规则 detail）
    svc_p = ManagedDrpyService(port=0, latency_ms=0)
    svc_p.start()
    small = ExternalDrpySpider(service=svc_p, rule='demo_cms', timeout=8.0)
    try:
        b_small = small.benchmark('detailContent', ['c1'], n=100, warmup=5,
                                  name='demo_cms.detailContent (小 payload)')
        b_big = spider_p_big(svc_p)
        print('  [metric] payload 大小对开销的影响:')
        print(f'    {b_small["benchmark"]:<38} bytes/call={b_small["bytes_per_call"]} '
              f'avg={_fmt_ms(b_small["avg_ms"])}')
        print(f'    {b_big["benchmark"]:<38} bytes/call={b_big["bytes_per_call"]} '
              f'avg={_fmt_ms(b_big["avg_ms"])}')
        ok &= check(b_big['bytes_per_call'] > b_small['bytes_per_call'] * 3,
                    '大规则 payload 显著大于小规则',
                    f"{b_small['bytes_per_call']} -> {b_big['bytes_per_call']} B")
        ok &= check(b_big['avg_ms'] < b_small['avg_ms'] + 5.0,
                    'payload 变大对单次调用延迟影响有限（loopback）',
                    f"Δavg ≈ {round(b_big['avg_ms'] - b_small['avg_ms'], 3)} ms")
    finally:
        small.destroy()
    return ok


def spider_p_big(svc):
    big = ExternalDrpySpider(service=svc, rule='demo_movie', timeout=8.0)
    try:
        return big.benchmark('detailContent', ['h01'], n=100, warmup=5,
                             name='demo_movie.detailContent (大 payload)')
    finally:
        big.destroy()


# ---------------------------------------------------------------- D. 部署风险
def test_deployment():
    section('D. 部署与端口占用风险：自动分配 / 端口冲突 / Bearer 鉴权')
    ok = True

    # D1: --port 0 自动分配，多实例并存互不冲突
    s1 = ManagedDrpyService(port=0)
    s2 = ManagedDrpyService(port=0)
    s1.start()
    s2.start()
    try:
        ok &= check(s1.base_url != s2.base_url, '两个托管实例端口互不冲突',
                    f'{s1.base_url} vs {s2.base_url}')
        c1 = DrpyServiceClient(s1.base_url, timeout=5.0)
        c2 = DrpyServiceClient(s2.base_url, timeout=5.0)
        ok &= check(c1.ping() is not None and c2.ping() is not None, '两实例健康检查均通过')
        c1.close()
        c2.close()
    finally:
        s1.stop()
        s2.stop()

    # D2: 固定端口冲突 —— 第二次启动必须干净失败并给出可执行提示
    s_fixed = ManagedDrpyService(port=0)
    s_fixed.start()
    try:
        port = int(s_fixed.base_url.rsplit(':', 1)[-1])
        env = dict(os.environ)
        env.setdefault('PYTHONIOENCODING', 'utf-8')
        env.setdefault('PYTHONUTF8', '1')
        proc = subprocess.run(
            [sys.executable, str(SERVICE_SCRIPT), '--port', str(port)],
            capture_output=True, text=True, encoding='utf-8', errors='replace',
            timeout=20, env=env, cwd=str(SERVICE_SCRIPT.parent))
        ok &= check(proc.returncode == 2, '端口被占时第二实例以退出码 2 干净失败',
                    f'returncode={proc.returncode}')
        ok &= check('FATAL' in (proc.stdout + proc.stderr),
                    '给出明确错误与换端口提示', (proc.stdout + proc.stderr).strip().splitlines()[-1])
        ok &= check(DrpyServiceClient(s_fixed.base_url, timeout=5.0).ping() is not None,
                    '第一实例不受冲突影响，仍健康')
    finally:
        s_fixed.stop()

    # D3: --token 鉴权 —— 端口暴露时未授权调用被拒
    svc_auth = ManagedDrpyService(port=0, token='sekrit-token-2026')
    svc_auth.start()
    try:
        anon = ExternalDrpySpider(service=svc_auth, rule='demo_cms', timeout=5.0)
        try:
            # 同一 keep-alive 连接上连续两次 401：回归锁定「401 必须排空请求体」
            # 否则残留 body 会污染下一条请求（HTTP/1.1 keep-alive 语法错误）。
            rejected = 0
            for _ in range(2):
                try:
                    anon.homeContent(False)
                except DrpyServiceError as exc:
                    if '401' in str(exc):
                        rejected += 1
                    else:
                        ok &= check(False, f'无 token 调用应以 401 拒绝，实际 {exc}')
            ok &= check(rejected == 2, '无 token 调用被拒绝（连续 2 次，同连接 401）',
                        f'rejected={rejected}')
        finally:
            anon.destroy()
        authed = ExternalDrpySpider(service=svc_auth, rule='demo_cms', token='sekrit-token-2026',
                                    timeout=5.0)
        try:
            home = authed.homeContent(False)
            ok &= check(len(home['list']) > 0, '携带 Bearer token 调用成功')
        finally:
            authed.destroy()
    finally:
        svc_auth.stop()
    return ok


# ---------------------------------------------------------------- 主流程
def main():
    # Windows 控制台默认 GBK：统一输出 UTF-8，保证评测报告可读
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    print('=' * 72)
    print('方案3【外部 drpy 服务】原型 — 端到端实测与评测')
    print(f'Python {sys.version.split()[0]} | 服务脚本 {SERVICE_SCRIPT.name}')
    print('=' * 72)

    results = {
        'A 契约实测': test_contract(),
        'B 进程保活': test_keepalive(),
        'C 网络开销': test_overhead(),
        'D 部署风险': test_deployment(),
    }

    print('\n' + '=' * 72)
    print('评测汇总')
    print('=' * 72)
    for name, ok in results.items():
        print(f'  [{"PASS" if ok else "FAIL"}] {name}')
    failed = sum(1 for ok in results.values() if not ok) + _PASS
    print(f'\n结果: {"ALL PASS" if failed == 0 else f"{failed} 项失败"}')
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
