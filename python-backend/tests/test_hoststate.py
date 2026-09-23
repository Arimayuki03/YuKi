# -*- coding: utf-8 -*-
"""hoststate 白盒单元测试：宿主目录/端口/开关状态机、legacy home 迁移、
resources/vendor 根解析，以及两条紧贴 hoststate 的宿主能力——
java_probe 的**外部二进制探测**（缓存/失效/超时/并发）与
proxy_gateway 的**端点路由映射**（含未知端点兜底）。

与既有测试的互补边界：
- `test_resources_root.py` 已覆盖 resources_root 的三种形态（env/冻结/开发兜底）；
  本文件只补 vendor_dir 拼接与「env 指向不存在目录」的回退分支。
- `test_jar_phase.py` 用真机 java 跑探测冒烟；本文件把 subprocess 全 mock 掉，
  只测探测**控制流**（候选顺序、缓存、超时、并发），不 spawn 任何外部二进制。
- `test_proxy_gateway.py` 覆盖 dispatch 的静态/实例代理选择；本文件补
  `_site_key` 命名兼容与「未知 do / 空站点表」的兜底返回。

沙箱：所有目录落在 YUKI_TEST_ROOT 或 python-backend/.test-tmp 下，不碰真实 ~/.yuki；
不出网、不 sleep、不 spawn 子进程（subprocess.run 一律 mock）。

用法：python-backend/.venv/Scripts/python.exe python-backend/tests/test_hoststate.py
"""
import importlib
import os
import sys
import tempfile
import threading
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import hoststate               # noqa: E402
import java_probe              # noqa: E402
from proxy_gateway import _site_key, dispatch, is_spider_proxy_request  # noqa: E402

# 沙箱根目录：优先 YUKI_TEST_ROOT（run_all.py 注入），否则用仓库内 .test-tmp
_SANDBOX_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-tmp')


def _sandbox():
    os.makedirs(_SANDBOX_ROOT, exist_ok=True)
    return tempfile.mkdtemp(prefix='hoststate-', dir=_SANDBOX_ROOT)


def _touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as handle:
        handle.write(b'MZ')


def _configure(root):
    """把 hoststate 钉到沙箱；`run_all.py` 之外单跑本文件时这一步是唯一护栏。"""
    hoststate.configure(
        port=19998, token='hoststate-token',
        data_dir=root,
        cache_dir=os.path.join(root, 'cache'),
        plugins_dir=os.path.join(root, 'cache', 'py'),
        log_dir=os.path.join(root, 'logs'))


# 导入即钉死到沙箱：`hoststate.ensure_dirs()` 一旦走到真实 ~/.yuki 就会覆盖
# 用户数据目录。这里在**任何测试跑起来之前**先隔离（`importlib.reload` 的用例
# 自己负责收尾）。
_root = _sandbox()
hoststate.configure(
    port=19998, token='hoststate-token',
    data_dir=_root,
    cache_dir=os.path.join(_root, 'cache'),
    plugins_dir=os.path.join(_root, 'cache', 'py'),
    log_dir=os.path.join(_root, 'logs'))


def _java_run(version_text='openjdk version "17.0.10" 2026-01-01', **kwargs):
    """造一个 subprocess.run 替身：返回带 stderr 的结果对象。"""

    def run(_cmd, **kw):
        result = mock.Mock()
        result.stdout = ''
        result.stderr = version_text
        result.returncode = 0
        return result

    return run


# ------------------------------------------------------------ 状态机与目录


def test_state_defaults_and_configure_override():
    """configure() 逐键覆盖；未配置的键保持模块默认（port=0 / token=''）。"""
    root = _sandbox()
    _configure(root)
    assert hoststate.get_port() == 19998
    assert hoststate.get_token() == 'hoststate-token'
    assert hoststate.get_data_dir() == root
    assert hoststate.get_cache_dir() == os.path.join(root, 'cache')
    assert hoststate.get_plugins_dir() == os.path.join(root, 'cache', 'py')
    assert hoststate.get_log_dir() == os.path.join(root, 'logs')
    hoststate.configure(port=0, token='')
    assert hoststate.get_port() == 0
    assert hoststate.get_token() == ''
    # 单点覆盖不波及其它键
    hoststate.configure(port=12345)
    assert hoststate.get_token() == ''
    assert hoststate.get_plugins_dir() == os.path.join(root, 'cache', 'py')


def test_feature_flags_defaults_and_toggle():
    """五个功能开关：默认态、任意值都被 bool() 归一、android worker 硬锁 False。"""
    flags = hoststate.get_feature_flags()
    assert set(flags) == {'runtime_android_worker', 'pan_fast_path', 'media_probe',
                          'auto_line_fallback', 'legacy_parser'}
    assert flags['runtime_android_worker'] is False, 'A4.1 No-Go：Android Worker 硬锁'
    assert flags['pan_fast_path'] is True
    assert flags['media_probe'] is True
    assert flags['auto_line_fallback'] is True
    assert flags['legacy_parser'] is True
    try:
        hoststate.configure(media_probe=0, auto_line_fallback='', legacy_parser=None,
                            pan_fast_path=False)
        assert hoststate.get_media_probe() is False
        assert hoststate.get_auto_line_fallback() is False
        assert hoststate.get_legacy_parser() is False
        assert hoststate.get_pan_fast_path() is False
        # 缺键时按默认值补（_state 被外部整体替换的兜底路径）
        hoststate._state.pop('media_probe', None)
        assert hoststate.get_media_probe() is True, '缺键回落到默认 True'
        assert hoststate.get_feature_flags()['media_probe'] is True
    finally:
        # 之前只恢复了 media_probe，其余三个开关一直泄漏到后续用例；
        # 当前文件内恰无其它用例读这些开关、且 test_env_dirs 的 reload 会重置，才未暴露。
        hoststate.configure(media_probe=True, auto_line_fallback=True,
                            legacy_parser=True, pan_fast_path=True)


def test_proxy_url_and_token_validation():
    """get_proxy_url 用配置的端口；valid_proxy_token 空 token 保持旧地址兼容。"""
    hoststate.configure(port=9978, token='secret-token')
    assert hoststate.get_proxy_url() == 'http://127.0.0.1:9978/proxy'
    assert hoststate.get_proxy_url(local=False) == 'http://127.0.0.1:9978/proxy', \
        'local 语义在 PC 端无差异'
    assert hoststate.valid_proxy_token('') is True, '不带 token：兼容旧 FongMi 地址'
    assert hoststate.valid_proxy_token(None) is True
    assert hoststate.valid_proxy_token('secret-token') is True
    assert hoststate.valid_proxy_token('wrong') is False
    assert hoststate.valid_proxy_token('secret-toke') is False, '必须是全等比对'
    # 未配置 token（空 expected）：任何非空 token 都拒绝（避免"随便带个值就过"）
    hoststate.configure(token='')
    assert hoststate.valid_proxy_token('') is True
    assert hoststate.valid_proxy_token('anything') is False, \
        '宿主没开 token 时不接受任意非空值'
    hoststate.configure(token='hoststate-token')


def test_env_dirs_are_read_at_import_and_overridable():
    """YUKI_DATA_DIR / YUKI_CACHE_DIR 在**模块导入时**读取；重导入即生效。"""
    assert hoststate._ENV_DATA_DIR == os.environ.get('YUKI_DATA_DIR', '').strip()
    assert hoststate._ENV_CACHE_DIR == os.environ.get('YUKI_CACHE_DIR', '').strip()
    root = _sandbox()
    env_cache = os.path.join(root, 'env-cache')
    saved = {k: os.environ.get(k) for k in ('YUKI_DATA_DIR', 'YUKI_CACHE_DIR')}
    try:
        os.environ['YUKI_DATA_DIR'] = root
        os.environ['YUKI_CACHE_DIR'] = env_cache
        importlib.reload(hoststate)
        assert hoststate.get_data_dir() == root, 'YUKI_DATA_DIR 覆盖 ~/.yuki'
        assert hoststate.get_cache_dir() == env_cache, 'YUKI_CACHE_DIR 独立覆盖'
        assert hoststate.get_plugins_dir() == os.path.join(env_cache, 'py')
        assert hoststate.get_log_dir() == os.path.join(root, 'logs'), \
            'log_dir 跟随 data_dir，不跟随 cache_dir'
        # 只给 DATA_DIR：cache 回落到 data_dir/cache
        os.environ.pop('YUKI_CACHE_DIR', None)
        importlib.reload(hoststate)
        assert hoststate.get_cache_dir() == os.path.join(root, 'cache')
        # 空字符串 / 纯空白视为未设置
        os.environ['YUKI_DATA_DIR'] = '   '
        importlib.reload(hoststate)
        assert hoststate.get_data_dir() == hoststate._HOME, '空白 env 等同未设置'
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        importlib.reload(hoststate)
        _configure(_sandbox())


def test_ensure_dirs_creates_every_directory():
    """ensure_dirs：四个目录一次性建齐且幂等（exist_ok）。"""
    root = _sandbox()
    _configure(root)
    hoststate.ensure_dirs()
    for path in (hoststate.get_data_dir(), hoststate.get_cache_dir(),
                 hoststate.get_plugins_dir(), hoststate.get_log_dir()):
        assert os.path.isdir(path), path
    hoststate.ensure_dirs()   # 幂等：重复调用不得抛异常
    assert os.path.isdir(hoststate.get_plugins_dir())


def test_ensure_dirs_propagates_permission_error():
    """ensure_dirs 没有兜底：makedirs 抛 OSError 会直接上抛（当前实现如实记录）。"""
    root = _sandbox()
    _configure(root)
    with mock.patch('hoststate.os.makedirs',
                    side_effect=PermissionError('read-only volume')):
        try:
            hoststate.ensure_dirs()
        except PermissionError:
            propagates = True
        else:
            propagates = False
    assert propagates, '当前实现不吞权限错误（启动时缺写权限会直接失败）'


def test_vendor_dir_follows_resources_root():
    """vendor_dir = resources_root/vendor；env 指向不存在目录时回退开发根。"""
    root = _sandbox()
    os.environ['YUKI_RESOURCES_ROOT'] = root
    try:
        assert hoststate.resources_root() == os.path.realpath(root)
        assert hoststate.vendor_dir() == os.path.join(os.path.realpath(root), 'vendor')
    finally:
        os.environ.pop('YUKI_RESOURCES_ROOT', None)
    os.environ['YUKI_RESOURCES_ROOT'] = os.path.join(root, 'no', 'such')
    try:
        assert hoststate.resources_root() == os.path.abspath(
            os.path.join(BASE, '..')), 'env 不是目录时回退仓库根'
        assert hoststate.vendor_dir().endswith(os.sep + 'vendor')
    finally:
        os.environ.pop('YUKI_RESOURCES_ROOT', None)


def test_legacy_home_migration_copies_only_into_empty_home():
    """_migrate_legacy_home：目标非空不动；目标空则整体搬迁；异常静默。"""
    root = _sandbox()
    # legacy/target 名字由 _migrate_legacy_home 固定为 ~/.video-pc 与 ~/.yuki，
    # 因此只能伪造 ~ 本身：把 ~ 换成沙箱（isolated 目录，绝不到真实 home）。
    legacy = os.path.join(root, '.video-pc')
    target = os.path.join(root, '.yuki')
    _touch(os.path.join(legacy, 'cfg', 'tv.json'))
    _touch(os.path.join(legacy, 'note.txt'))
    # 目标不存在 → 创建并整体搬迁
    with mock.patch.object(hoststate.os.path, 'expanduser',
                           side_effect=lambda p: p.replace('~', root, 1)), \
            mock.patch.object(hoststate, '_HOME', target):
        hoststate._migrate_legacy_home()
    assert os.path.isfile(os.path.join(target, 'note.txt'))
    assert os.path.isfile(os.path.join(target, 'cfg', 'tv.json')), '目录递归复制'
    assert not os.path.exists(legacy), '复制成功后旧目录被清除'
    # 目标非空 → 不动（保新数据）
    os.makedirs(legacy, exist_ok=True)
    _touch(os.path.join(legacy, 'again.txt'))
    with mock.patch.object(hoststate.os.path, 'expanduser',
                           side_effect=lambda p: p.replace('~', root, 1)), \
            mock.patch.object(hoststate, '_HOME', target):
        hoststate._migrate_legacy_home()
    assert os.path.isdir(legacy), '目标非空：旧目录保留原样'
    assert not os.path.exists(os.path.join(target, 'again.txt'))
    # 无 legacy 目录 → 直接返回（连 target 都不会创建）
    empty_root = _sandbox()
    with mock.patch.object(hoststate.os.path, 'expanduser',
                           side_effect=lambda p: p.replace('~', empty_root, 1)), \
            mock.patch.object(hoststate, '_HOME', os.path.join(empty_root, '.yuki')):
        hoststate._migrate_legacy_home()
    assert not os.path.exists(os.path.join(empty_root, '.yuki')), \
        '没有 legacy 时不得凭空创建目标目录'
    # 迁移期间抛异常（listdir 失败）→ 静默（try/except pass 兜底）
    boom_root = _sandbox()
    _touch(os.path.join(boom_root, '.video-pc', 'x.txt'))
    with mock.patch.object(hoststate.os.path, 'expanduser',
                           side_effect=lambda p: p.replace('~', boom_root, 1)), \
            mock.patch.object(hoststate, '_HOME', os.path.join(boom_root, '.yuki')), \
            mock.patch.object(hoststate.os, 'listdir', side_effect=OSError('denied')):
        hoststate._migrate_legacy_home()
    assert os.path.isdir(os.path.join(boom_root, '.video-pc')), \
        '异常发生在复制之前：旧目录保留，迁移整体跳过'


# ------------------------------------------------------ java_probe 二进制探测


def test_java_candidates_follow_declared_priority():
    """候选顺序：YUKI_JAVA_BIN → YUKI_JAVA_HOME → 内置 JRE → JAVA_HOME → PATH。"""
    root = _sandbox()
    user_bin = os.path.join(root, 'mybin', 'java.exe')
    user_home = os.path.join(root, 'myhome', 'bin', 'java.exe')
    jre = os.path.join(root, 'vendor', 'jre', 'bin', 'java.exe')
    jh = os.path.join(root, 'jh', 'bin', 'java.exe')
    from_path = os.path.join(root, 'path', 'java.exe')
    for path in (user_bin, user_home, jre, jh, from_path):
        _touch(path)
    env = {'YUKI_JAVA_BIN': '"%s"' % user_bin,       # 带引号也要被剥掉
           'YUKI_JAVA_HOME': root + '\\myhome\\',
           'JAVA_HOME': os.path.join(root, 'jh')}
    with mock.patch.dict(os.environ, env), \
            mock.patch.object(java_probe, '_resources_root', return_value=root), \
            mock.patch.object(java_probe.shutil, 'which', return_value=from_path):
        got = java_probe._candidates()
    assert got == [user_bin, user_home, jre, jh, from_path], got

    # 以下子断言需要「一个干净的沙箱 + 空的 java 相关环境变量」：本机真实
    # JDK（JAVA_HOME/PATH）一旦混入，候选列表就不是被测的那个。
    def candidates_in(clean_root, extra_env=None):
        env = {'YUKI_JAVA_BIN': '', 'YUKI_JAVA_HOME': '', 'JAVA_HOME': ''}
        env.update(extra_env or {})
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(java_probe, '_resources_root', return_value=clean_root), \
                mock.patch.object(java_probe.shutil, 'which', return_value=None):
            return java_probe._candidates()

    # YUKI_JAVA_BIN 指向不存在的文件 → 该来源不进候选
    empty = _sandbox()
    assert candidates_in(empty, {'YUKI_JAVA_BIN': os.path.join(empty, 'nope.exe')}) == []
    # 空值 / 纯空白视为未设置
    assert candidates_in(empty, {'YUKI_JAVA_BIN': '   ', 'JAVA_HOME': ''}) == []
    # JAVA_HOME 存在但 bin/java 不在 → 不进候选
    assert candidates_in(empty, {'JAVA_HOME': os.path.join(empty, 'empty-home')}) == []
    # 内置 JRE：存在即入候选（且只取一个，不重复追加 java.exe 与 java）
    jre_root = _sandbox()
    _touch(os.path.join(jre_root, 'vendor', 'jre', 'bin', 'java.exe'))
    _touch(os.path.join(jre_root, 'vendor', 'jre', 'bin', 'java'))
    assert candidates_in(jre_root) == [
        os.path.join(jre_root, 'vendor', 'jre', 'bin', 'java.exe')], '同一来源只取一个'
    # resources 子目录同样被接受（打包布局）
    res_root = _sandbox()
    _touch(os.path.join(res_root, 'resources', 'jre', 'bin', 'java.exe'))
    assert candidates_in(res_root) == [
        os.path.join(res_root, 'resources', 'jre', 'bin', 'java.exe')]


def test_find_java_returns_first_executable_candidate():
    """find_java：命中第一个能跑出版本号的候选，并把 bin/version 写进缓存。"""
    java_probe.clear_cache()
    root = _sandbox()
    good = os.path.join(root, 'good', 'java.exe')
    _touch(good)
    env = {'YUKI_JAVA_BIN': good}
    with mock.patch.dict(os.environ, env), \
            mock.patch.object(java_probe, '_resources_root', return_value=root), \
            mock.patch.object(java_probe.shutil, 'which', return_value=None), \
            mock.patch('java_probe.subprocess.run',
                       side_effect=_java_run('openjdk version "17.0.10"')):
        found = java_probe.find_java()
    assert found == good
    assert java_probe.java_version() == '17.0.10'
    java_probe.clear_cache()


def test_find_java_returns_none_when_nothing_runnable():
    """找不到（无候选 / 全部跑不出版本号）→ None，且 version 被清空。"""
    java_probe.clear_cache()
    root = _sandbox()
    with mock.patch.object(java_probe, '_resources_root', return_value=root), \
            mock.patch.object(java_probe.shutil, 'which', return_value=None), \
            mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop('JAVA_HOME', None)
        os.environ.pop('YUKI_JAVA_BIN', None)
        os.environ.pop('YUKI_JAVA_HOME', None)
        assert java_probe.find_java() is None, '无候选直接返回 None'
        assert java_probe.java_version() == ''
    # 有候选但输出里没有版本号 → 视为不可用，继续下一个
    exe = os.path.join(root, 'silent', 'java.exe')
    _touch(exe)
    with mock.patch.dict(os.environ, {'YUKI_JAVA_BIN': exe}), \
            mock.patch.object(java_probe, '_resources_root', return_value=root), \
            mock.patch.object(java_probe.shutil, 'which', return_value=None), \
            mock.patch('java_probe.subprocess.run',
                       side_effect=_java_run('no version here')):
        assert java_probe.find_java() is None, '输出无版本号 → 判为不可用'
        assert java_probe.java_version() == ''
    java_probe.clear_cache()


def test_find_java_tolerates_empty_path_and_unrunnable_binary():
    """空路径候选被跳过；非可执行（OSError）/ 退出码非零也要被吞掉。

    之前用 ``side_effect=AssertionError`` 钉 ``if not cand: continue`` 分支，
    但 ``java_probe._version`` 用 ``except Exception`` 吞掉一切异常——即使守卫
    被删、``_version('')`` 真去 spawn，AssertionError 也被吞成 ``''``，
    ``find_java()`` 照样返回 None，断言恒绿。改为对 ``subprocess.run`` 打
    ``mock.Mock()`` 计数：空候选下探测次数必须为 0，这才能真实拦截守卫被删的回归。
    """
    java_probe.clear_cache()
    root = _sandbox()
    # 空路径：_candidates 里出现 '' 时被 continue 跳过（真实来源已被 isfile 拦掉，
    # 这里直接验证 find_java 的 `if not cand: continue` 分支）
    spy_run = mock.Mock(side_effect=AssertionError('空路径不得 spawn 进程'))
    with mock.patch.object(java_probe, '_candidates', return_value=['']), \
            mock.patch('java_probe.subprocess.run', spy_run):
        assert java_probe.find_java() is None
    assert spy_run.call_count == 0, '空候选不得发起任何子进程探测'
    # 非可执行文件：OSError（PermissionError / WinError 193）被 _version 吞成 ''
    exe = os.path.join(root, 'notexec', 'java.exe')
    _touch(exe)
    with mock.patch.object(java_probe, '_candidates', return_value=[exe]), \
            mock.patch('java_probe.subprocess.run',
                       side_effect=PermissionError('not executable')):
        assert java_probe.find_java() is None
        assert java_probe.java_version() == ''
    # 退出码非零但 stderr 有版本号：按内容判定（java -version 写在 stderr）
    with mock.patch.object(java_probe, '_candidates', return_value=[exe]), \
            mock.patch('java_probe.subprocess.run',
                       side_effect=_java_run('java version "1.8.0_402"')):
        assert java_probe.find_java() == exe
        assert java_probe.java_version() == '1.8.0_402'
    java_probe.clear_cache()


def test_find_java_probe_timeout_is_swallowed():
    """探测超时（subprocess.TimeoutExpired）：该候选判废，不为整次探测抛异常。"""
    java_probe.clear_cache()
    root = _sandbox()
    slow = os.path.join(root, 'slow', 'java.exe')
    fast = os.path.join(root, 'fast', 'java.exe')
    _touch(slow)
    _touch(fast)

    def run(cmd, **_kw):
        if cmd[0] == slow:
            raise java_probe.subprocess.TimeoutExpired(cmd, 10)
        return _java_run('openjdk version "21.0.1"')(cmd)

    with mock.patch.object(java_probe, '_candidates', return_value=[slow, fast]), \
            mock.patch('java_probe.subprocess.run', side_effect=run):
        assert java_probe.find_java() == fast, '超时候选被跳过，继续下一个'
    assert java_probe.java_version() == '21.0.1'
    java_probe.clear_cache()
    # 全部超时 → None
    with mock.patch.object(java_probe, '_candidates', return_value=[slow]), \
            mock.patch('java_probe.subprocess.run',
                       side_effect=java_probe.subprocess.TimeoutExpired(['x'], 10)):
        assert java_probe.find_java() is None
        assert java_probe.java_version() == ''
    java_probe.clear_cache()


def test_probe_cache_hit_and_invalidation():
    """探测结果缓存：命中不再 spawn；clear_cache 后重新探测（换路径即换结论）。"""
    java_probe.clear_cache()
    root = _sandbox()
    first = os.path.join(root, 'v17', 'java.exe')
    second = os.path.join(root, 'v21', 'java.exe')
    _touch(first)
    _touch(second)
    calls = []

    def run(cmd, **_kw):
        calls.append(cmd[0])
        return _java_run('openjdk version "17.0.10"')(cmd)

    with mock.patch.object(java_probe, '_candidates', return_value=[first]), \
            mock.patch('java_probe.subprocess.run', side_effect=run):
        assert java_probe.find_java() == first
        for _ in range(5):
            assert java_probe.find_java() == first, '缓存命中返回同一结果'
        assert calls == [first], '命中缓存后不得重复 spawn 二进制'
        # 失效后重新探测（候选已换成 v21）
        java_probe.clear_cache()
        assert java_probe.java_version() == '', 'clear_cache 同时清掉版本号'
        with mock.patch.object(java_probe, '_candidates', return_value=[second]):
            assert java_probe.find_java() == second
        assert calls == [first, second]
    java_probe.clear_cache()


def test_probe_cache_is_not_negative():
    """探测失败**不**进负缓存：连续两次失败会 spawn 两次（当前实现的代价）。"""
    java_probe.clear_cache()
    root = _sandbox()
    exe = os.path.join(root, 'bad', 'java.exe')
    _touch(exe)
    calls = []

    def run(cmd, **_kw):
        calls.append(cmd[0])
        return _java_run('garbage')(cmd)

    with mock.patch.object(java_probe, '_candidates', return_value=[exe]), \
            mock.patch('java_probe.subprocess.run', side_effect=run):
        assert java_probe.find_java() is None
        assert java_probe.find_java() is None
    assert calls == [exe, exe], '失败不缓存：每次 find_java 都会重跑一遍探测'
    java_probe.clear_cache()


def test_concurrent_probe_after_cache_warm_does_not_duplicate():
    """并发：缓存已热时，8 个线程并发 find_java 只会有一次二进制探测。"""
    java_probe.clear_cache()
    root = _sandbox()
    exe = os.path.join(root, 'shared', 'java.exe')
    _touch(exe)
    calls = []
    gate = threading.Barrier(8)

    def run(cmd, **_kw):
        calls.append(cmd[0])
        return _java_run('openjdk version "17.0.10"')(cmd)

    with mock.patch.object(java_probe, '_candidates', return_value=[exe]), \
            mock.patch('java_probe.subprocess.run', side_effect=run):
        java_probe.find_java()          # 预热缓存
        results = []

        def worker():
            gate.wait()
            results.append(java_probe.find_java())

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
    assert results == [exe] * 8
    assert calls == [exe], '并发下不得重复 spawn（缓存命中路径）'
    java_probe.clear_cache()


def test_java_version_does_not_trigger_a_probe():
    """java_version 只读缓存：未探测过返回 ''，绝不顺手发起一次探测。"""
    java_probe.clear_cache()
    with mock.patch('java_probe.subprocess.run',
                    side_effect=AssertionError('java_version 不得触发探测')):
        assert java_probe.java_version() == ''
    java_probe.clear_cache()


# ------------------------------------------------------------ 端点路由映射


class _RouteSite:
    """dispatch 只用到 key / spider_type / runner 上的 localProxy|proxy。"""

    def __init__(self, key, kind=''):
        self.key = key
        self.spider_type = kind
        self.runner = self
        self.local_calls = []
        self.static_calls = []

    def localProxy(self, params):
        self.local_calls.append(dict(params))
        return self.key + ':local'

    def proxy(self, params):
        self.static_calls.append(dict(params))
        return self.key + ':static'


def test_site_key_resolution_accepts_both_spellings():
    """`_site_key`：siteKey 优先于 site，空值不算显式；do=pan 一律不给站点上下文。"""
    assert _site_key({'siteKey': 'a'}, None, 'py') == ('a', True)
    assert _site_key({'site': 'b'}, None, 'py') == ('b', True)
    assert _site_key({'siteKey': 'a', 'site': 'b'}, None, 'py') == ('a', True)
    assert _site_key({'siteKey': '', 'site': 'b'}, None, 'py') == ('b', True), \
        '空 siteKey 回落到 site（旧命名兼容）'
    assert _site_key({}, None, 'py') == (None, False)
    assert _site_key({'siteKey': None, 'site': None}, None, 'py') == (None, False)
    assert _site_key({'siteKey': 0}, None, 'py') == ('0', True), '非字符串也要 str() 归一'
    assert _site_key({'siteKey': 'q'}, None, 'pan') == (None, False), \
        'do=pan 的 site 是 Provider 名，不能当 Spider 上下文'


def test_dispatch_routes_by_endpoint_and_recent_kind():
    """dispatch：do=ck 直接回 ok；显式 key 命中；无 key 时按 do 选最近同类站点。"""
    sites = _SitesStub()
    sites.add(_RouteSite('py-site', 'py'))
    sites.add(_RouteSite('js-site', 'js'))
    sites.add(_RouteSite('jar-site', 'jar'))
    assert dispatch({'do': 'ck'}, sites) == 'ok'
    assert dispatch({'siteKey': 'py-site', 'do': 'py'}, sites) == 'py-site:local'
    assert dispatch({'do': 'js'}, sites) == 'js-site:local', 'do=js → 最近的 js 站点'
    assert dispatch({'do': 'jar'}, sites) == 'jar-site:static', \
        'jar 站点且非显式 key → 走静态 Proxy（FongMi JarLoader 语义）'
    assert sites.recent_key == 'jar-site', '选中后必须 set_recent'
    # 未知 do：kind=None → 落到 recent(None)（最近注册的那个），不是报错；
    # 该站点又是 jar 且非显式指定 → 走静态 Proxy，因此拼出 ':static'
    assert dispatch({'do': 'totally-unknown'}, sites) == 'jar-site:static', \
        '未知 do 视为「不指定 kind」，回落到最近使用的站点'


def test_dispatch_unknown_endpoint_without_sites_returns_none():
    """未知端点 + 空站点表：返回 None（调用方转 404），不得抛异常。"""
    empty = _SitesStub()
    assert dispatch({'do': 'totally-unknown'}, empty) is None
    assert dispatch({'do': ''}, empty) is None
    assert dispatch({}, empty) is None
    assert empty.recent_key is None, '空站点表不得留下 recent 状态'
    # 有站点但 runner 缺失 → 同样 None（不抛 AttributeError）
    bare = _SitesStub()
    site = _RouteSite('broken')
    site.runner = None
    bare.add(site)
    assert dispatch({'siteKey': 'broken', 'do': 'py'}, bare) is None


def test_dispatch_strips_host_token_before_calling_spider():
    """宿主 token 是本地网关上下文，不得作为参数传给第三方 Spider。"""
    previous = hoststate.get_token()
    hoststate.configure(token='gw-token')
    try:
        sites = _SitesStub()
        site = _RouteSite('py-site', 'py')
        sites.add(site)
        assert dispatch({'siteKey': 'py-site', 'do': 'py', 'token': 'gw-token',
                         'x': '1'}, sites) == 'py-site:local'
        assert site.local_calls[-1] == {'siteKey': 'py-site', 'do': 'py', 'x': '1'}, \
            '与宿主一致的 token 必须被剥掉'
    finally:
        hoststate.configure(token=previous)


def test_is_spider_proxy_request_marks_spider_endpoints():
    """is_spider_proxy_request：do=js/py/jar 或带 siteKey 才算 Spider 代理请求。"""
    assert is_spider_proxy_request({'do': 'js'}) is True
    assert is_spider_proxy_request({'do': 'PY'}) is True, '大小写不敏感'
    assert is_spider_proxy_request({'do': 'jar'}) is True
    assert is_spider_proxy_request({'do': 'py', 'siteKey': 'a'}) is True
    assert is_spider_proxy_request({'siteKey': 'a'}) is True
    assert is_spider_proxy_request({'do': 'cms'}) is False, 'cms 不在这份口径里'
    assert is_spider_proxy_request({'do': 'pan'}) is False
    assert is_spider_proxy_request({}) is False
    assert is_spider_proxy_request(None) is False


class _SitesStub:
    """SiteManager 的最小替身：只实现 dispatch 需要的 get/recent/set_recent。"""

    def __init__(self):
        self.sites = []
        self.recent_key = None

    def add(self, site):
        self.sites.append(site)

    def get(self, key=None):
        if not self.sites:
            return None
        if key is None:
            return self.sites[0]
        for site in self.sites:
            if site.key == key:
                return site
        return None

    def recent(self, kind=None):
        """与 `SiteManager.recent` 同语义：recent → 注册逆序 → kind 过滤，无匹配 None。"""
        wanted = str(kind or '').lower()
        for site in reversed(self.sites):
            if not wanted or site.spider_type == wanted:
                return site
        return None

    def set_recent(self, key):
        self.recent_key = key


if __name__ == '__main__':
    failures = 0
    total = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith('test_') or not callable(fn):
            continue
        total += 1
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - 汇总 runner 需要拿到所有失败
            failures += 1
            print('FAIL %s: %s: %s' % (name, type(exc).__name__, exc))
        else:
            print('PASS %s' % name)
    print('---- %d/%d passed ----' % (total - failures, total))
    if failures:
        sys.exit(1)
    print('ALL PASS')
