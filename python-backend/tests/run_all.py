# -*- coding: utf-8 -*-
"""One-shot backend regression: smoke + phase3 + py_compile all sources.

Usage: <venv>/python python-backend/tests/run_all.py
Exits 0 only if every stage passes. Output kept ASCII (PowerShell safety).
"""
import os
import py_compile
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)  # python-backend/
PY = sys.executable
TEST_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
os.makedirs(TEST_ROOT, exist_ok=True)
TEST_ENV = {**os.environ, 'YUKI_TEST_ROOT': TEST_ROOT,
            'YUKI_DATA_DIR': os.path.join(TEST_ROOT, 'data'),
            'YUKI_CACHE_DIR': os.path.join(TEST_ROOT, 'cache')}

STAGES = [
    ('smoke', [PY, os.path.join(HERE, 'smoke.py')]),
    ('phase3', [PY, os.path.join(HERE, 'test_phase3.py')]),
    ('kazumi', [PY, os.path.join(HERE, 'test_kazumi.py')]),
    ('kazumi-cover-proxy', [PY, os.path.join(HERE, 'test_kazumi_cover_proxy.py')]),
    ('webdav-restore', [PY, os.path.join(HERE, 'test_webdav_restore.py')]),
    ('webdav-conn', [PY, os.path.join(HERE, 'test_webdav_conn.py')]),
    ('cache', [PY, os.path.join(HERE, 'test_cache_store.py')]),
    # 会话内 TTL 内存缓存底座（spider 内容 / kazumi 搜索章节共用）
    ('mem-cache', [PY, os.path.join(HERE, 'test_mem_cache.py')]),
    # spider 内容 API 会话级缓存：key 规范化 / 可缓存判定 / 命中回写语义
    ('spider-content-cache', [PY, os.path.join(HERE, 'test_spider_content_cache.py')]),
    # Kazumi 规则源搜索/章节的会话缓存（复用 mem_cache 底座）
    ('kazumi-cache', [PY, os.path.join(HERE, 'test_kazumi_cache.py')]),
    # RM-4：playerContent 解析结果持久缓存（跨重启跳过查源 + 失效重解析）
    ('play-cache', [PY, os.path.join(HERE, 'test_play_cache.py')]),
    ('layered-diagnostics', [PY, os.path.join(HERE, 'test_layered_diagnostics.py')]),
    ('runtime-contract', [PY, os.path.join(HERE, 'test_runtime_contract.py')]),
    ('runtime-supervisor', [PY, os.path.join(HERE, 'test_runtime_supervisor.py')]),
    ('site-health', [PY, os.path.join(HERE, 'test_site_health.py')]),
    ('config-compat', [PY, os.path.join(HERE, 'test_config_compat.py'), '--offline']),
    ('port-generalization', [PY, os.path.join(HERE, 'test_port_generalization.py')]),
    ('quark-pan', [PY, os.path.join(HERE, 'test_quark_pan.py')]),
    ('proxy-contract', [PY, os.path.join(HERE, 'test_proxy_contract.py')]),
    ('proxy-gateway', [PY, os.path.join(HERE, 'test_proxy_gateway.py')]),
    ('proxy-http', [PY, os.path.join(HERE, 'test_proxy_http.py')]),
    ('proxy-stream', [PY, os.path.join(HERE, 'test_proxy_stream.py')]),
    # #7/#8 回归：_SegStream 队列满背压不炸线程 + /proxy?url= 通道 token 门禁
    ('goproxy-segstream-url-auth', [PY, os.path.join(HERE, 'test_goproxy_segstream_and_url_auth.py')]),
    # HTTP 守卫回归：YUKI_CONFIG_* 环境边界（TEST_ENV 已注入 YUKI_TEST_ROOT，不碰真实 profile）
    ('http-guard-regression', [PY, os.path.join(HERE, 'test_http_guard_regression.py')]),
    ('play-contract', [PY, os.path.join(HERE, 'test_play_contract.py')]),
    ('pan-provider', [PY, os.path.join(HERE, 'test_pan_provider.py')]),
    ('jar-proxy', [PY, os.path.join(HERE, 'test_jar_proxy.py')]),
    ('jar-phase', [PY, os.path.join(HERE, 'test_jar_phase.py')]),
    ('jar-e2e', [PY, os.path.join(HERE, 'test_jar_e2e.py')]),
    ('jar-supervisor', [PY, os.path.join(HERE, 'test_jar_supervisor.py')]),
    # dex2jar 生命周期：jar 反编译子进程的 spawn/收敛/超时契约
    ('dex2jar-lifecycle', [PY, os.path.join(HERE, 'test_dex2jar_lifecycle.py')]),
    ('pan-cache', [PY, os.path.join(HERE, 'test_pan_cache.py')]),
    ('pan-cookies', [PY, os.path.join(HERE, 'test_pan_cookies.py')]),
    ('jar-compatibility', [PY, os.path.join(HERE, 'test_jar_compatibility.py')]),
    # C2.1~C2.5：配置快照 / ext 语义 / 站点字段矩阵 / 能力路由 / 配置安全边界。
    # 全部走 tests/offline_config_server.py 的 loopback 夹具，不出网。
    ('config-snapshot', [PY, os.path.join(HERE, 'test_config_snapshot.py')]),
    # 导入接管契约：用户导入可接管进行中的后台加载（自动重载/启动恢复）。
    ('config-supersede', [PY, os.path.join(HERE, 'test_config_supersede.py')]),
    ('ext-semantics', [PY, os.path.join(HERE, 'test_ext_semantics.py')]),
    ('capability-router', [PY, os.path.join(HERE, 'test_capability_router.py')]),
    ('config-security', [PY, os.path.join(HERE, 'test_config_security.py')]),
    ('android-worker-spike', [PY, os.path.join(HERE, 'test_android_worker_spike.py')]),
    # N3.2~N3.5 契约回归（Python spider 隔离/CMS 契约/统一数据面）。不接入 run_all
    # 的话文件损坏（如语法错误）不会惊动任何人——2026-09 就发生过一次。
    ('n3-runtime-parity', [PY, os.path.join(HERE, 'test_n3_runtime_parity.py')]),
    # quickjs 宿主限额契约：CPU/内存/栈 fail-closed（缺 API 或设置失败即拒绝加载站点）
    ('quickjs-host-limits', [PY, os.path.join(HERE, 'test_quickjs_host_limits.py')]),
    # Q7.1 ~ Q7.5 全套验收套件
    ('q7-offline-fixtures', [PY, os.path.join(HERE, 'test_q7_offline_fixtures.py')]),
    ('q7-runtime-contracts', [PY, os.path.join(HERE, 'test_q7_runtime_contracts.py')]),
    ('q7-fault-injection', [PY, os.path.join(HERE, 'test_q7_fault_injection.py')]),
    ('q7-perf-metrics', [PY, os.path.join(HERE, 'test_q7_perf_metrics.py')]),
    # R8.1 ~ R8.3 功能开关、数据迁移与发布门禁
    ('r8-release-gates', [PY, os.path.join(HERE, 'test_r8_release_gates.py')]),
    # 打包版入口契约：freeze_support / 标准流兜底 / uvicorn log_config
    ('frozen-entrypoint', [PY, os.path.join(HERE, 'test_frozen_entrypoint.py')]),
    # vendor/resources 根解析契约：jar 运行时资产在冻结产物里的定位
    ('resources-root', [PY, os.path.join(HERE, 'test_resources_root.py')]),
    # ── 以下 6 个此前长期游离在回归之外（2026-09 全项目审查发现）──────────────
    # 上方注释写的教训（「不接入 run_all 的话文件损坏不会惊动任何人」）在补注册表时
    # 又被漏了一次。现已由 _check_stage_coverage() 做成机器门禁，不再依赖人工记忆。
    # 熔断器核心语义：半开探测/取消后不重计满开放时间——supervisor 放行判定直接依赖它
    ('circuit', [PY, os.path.join(HERE, 'test_circuit.py')]),
    # 四类运行时（jar/js/cms/python）统一契约面：能力路由与错误目录一致性
    ('all-runtimes-contract', [PY, os.path.join(HERE, 'test_all_runtimes_contract.py')]),
    # 夸克网盘 session 刷新状态机：pan_login.py 此前无任何直接覆盖
    ('quark-session-refresh', [PY, os.path.join(HERE, 'test_quark_session_refresh.py')]),
    # G0.1 兼容夹具的正常/异常/超时/无限循环退出语义（离线，可进 CI）
    ('config-compat-offline', [PY, os.path.join(HERE, 'test_config_compat_offline.py')]),
    # 苹果 CMS XML 编码（GBK/GB2312 站点曾 100% 解析失败）与 XXE 防护
    ('cms-xml-encoding', [PY, os.path.join(HERE, 'test_cms_xml_encoding.py')]),
    # SiteHealth 并发一致性：无锁时诊断快照会读到自相矛盾的组合
    ('health-concurrency', [PY, os.path.join(HERE, 'test_health_concurrency.py')]),
]

# 有意不作为独立 stage 运行的 tests/test_*.py → 原因。
# 新增测试文件若既不接入 STAGES、也不在此登记，_check_stage_coverage() 会让回归失败。
EXEMPT_TESTS = {
    # 由上面的 'config-compat' stage 以 `--offline` 参数调用，不是没有接入
    'test_config_compat.py': '已作为 config-compat stage（--offline）接入',
}

# 编译门禁不排除 tests/：审查时 SKIP_DIRS 含 'tests' 导致「[compile] 110 py files」
# 这个数字根本不含任何测试文件，孤儿测试文件连语法坏了都发现不了（实测 tests 下
# 65 个 .py 全部编译干净，纳入后覆盖 110 → 175）。
SKIP_DIRS = {'.venv', '__pycache__'}


def compile_all():
    bad = []
    n = 0
    for root, dirs, files in os.walk(BASE):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f.endswith('.py'):
                n += 1
                p = os.path.join(root, f)
                try:
                    py_compile.compile(p, doraise=True)
                except py_compile.PyCompileError as e:
                    bad.append(f'{p}: {e.msg}')
    print(f'[compile] {n} py files, {len(bad)} errors')
    for b in bad:
        print(f'  [FAIL] {b}')
    return not bad


def _check_stage_coverage():
    """守住「写了测试但没接入回归」这类静默失效。

    tests/ 下每个 test_*.py 都必须被某个 stage 引用（或直接以其它脚本运行），
    否则该文件即使永远通过也拦不住任何回归——审查时就有 4 个这样的孤儿文件，
    其中包含熔断器与网盘 session 刷新这类高风险实现。
    """
    import glob
    import re
    with open(os.path.join(HERE, 'run_all.py'), encoding='utf-8') as fp:
        src = fp.read()
    head, _, _ = src.partition('EXEMPT_TESTS = {')
    registered = set(re.findall(r"['\"](test_[A-Za-z0-9_]+\.py)['\"]", head))
    found = {os.path.basename(p) for p in glob.glob(os.path.join(HERE, 'test_*.py'))}
    missing = sorted(found - registered - set(EXEMPT_TESTS))
    stale = sorted((registered | set(EXEMPT_TESTS)) - found)
    for name in missing:
        print(f'  [FAIL] {name} 未被任何 stage 接入，也不在 EXEMPT_TESTS 中')
    for name in stale:
        print(f'  [FAIL] stage/EXEMPT 引用的 {name} 不存在（文件已删除或改名）')
    return not missing and not stale


def main():
    # 单阶段超时（秒）：子测试若挂死（如 stream 回归在旧代码上会 hang），
    # 没有超时会占住 CI 数小时；可用 YUKI_STAGE_TIMEOUT 覆盖。
    stage_timeout = int(os.environ.get('YUKI_STAGE_TIMEOUT') or 900)
    ok = True
    print('===== stage: coverage-self-check =====')
    covered = _check_stage_coverage()
    print(f'===== coverage-self-check: {"PASS" if covered else "FAIL"} =====\n')
    ok = covered and ok
    for name, cmd in STAGES:
        print(f'===== stage: {name} =====')
        try:
            r = subprocess.run(cmd, cwd=BASE, env=TEST_ENV, timeout=stage_timeout)
            passed = r.returncode == 0
        except subprocess.TimeoutExpired:
            print(f'  [note] stage exceeded {stage_timeout}s, terminated (hang guard)')
            passed = False
        ok = ok and passed
        print(f'===== {name}: {"PASS" if passed else "FAIL"} =====\n')
    print('===== stage: compile =====')
    ok = compile_all() and ok
    print()
    print(f'RUN_ALL: {"ALL PASS" if ok else "FAILED"}')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
