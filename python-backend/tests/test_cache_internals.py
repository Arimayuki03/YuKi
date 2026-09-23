# -*- coding: utf-8 -*-
"""缓存三模块白盒单测：play_cache（持久层）/ cache_store（磁盘 KV）/ mem_cache（会话层）。

与既有测试的互补边界（避免重复覆盖）：

- ``test_play_cache.py``：读写往返、跨实例持久化、TTL 过期（真实 sleep）、
  统计、损坏文件。本文件补**内部私有分支**：key 构造的四段语义与路径注入
  防护、TTL 下限钳制、单例并发构造、容量上限继承、目录不存在自动创建、
  空/短 key、非 dict 内容的兜底、** stats() 被损坏文件打断 **（源码缺陷）。
- ``test_cache_store.py``：上限淘汰、过期惰性删除、扫描、clear。本文件补
  ``_cleanup_tmp_files`` 的启动清理、``_path/_name_of`` 的 sha1 命名与路径
  注入防护、覆盖写的记账去重、单条超限自淘汰、delete 对未落盘 key 的记账
  修正、``_evict_if_needed`` 的「先过期后最旧」选择序。
- ``test_mem_cache.py``：TTL/LRU/命名空间/前缀失效/mutate/总账。本文件补
  ``_clamp_ttl`` 的非法值与命名空间默认表、「过期边界 now >= exp」、跨命名空间
  LRU 的候选收集序、``invalidate``/``invalidate_prefix`` 的总账与空桶分支、
  ``stats`` 的惰性删除口径、并发读写不破坏总账。

风格沿用 test_mem_cache.py：模块级 ``def test_xxx`` + 裸 ``assert`` + 中文
docstring。时间推进用 mock（改内部时间戳或 patch ``time.time``/``time.monotonic``），
禁止 sleep；临时目录用 ``tempfile.mkdtemp``；不出网、不起子进程。
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time

import unittest.mock as mock

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(HERE)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import play_cache  # noqa: E402
from cache_store import CacheStore  # noqa: E402
import mem_cache  # noqa: E402

# 测试期间把 hoststate 缓存目录指到临时根，避免污染真实 profile。
_TMP_ROOT = tempfile.mkdtemp(prefix='yuki-test-cache-internals-')
_TEST_CACHE_DIR = os.path.join(_TMP_ROOT, 'cache')

# 本文件依赖 run_all.py 的子进程隔离模型。atexit 恢复的实际收益：
# 1) 修复 pytest 直跑时的临时目录泄漏（退出时 rmtree _TMP_ROOT）；
# 2) 进程退出时写回 env/hoststate，不留永久改动。
# 注意它**不能**阻止 pytest 同进程合并运行时、在后续测试文件执行期间看到指向
# 临时目录的 hoststate（恢复发生在全部测试结束之后）——合并运行不在支持范围。
# 快照在 setdefault 之前记录，保证恢复写回的是真正的宿主原值。
_ORIG_ENV = {
    'YUKI_CACHE_DIR': os.environ.get('YUKI_CACHE_DIR'),
    'YUKI_DATA_DIR': os.environ.get('YUKI_DATA_DIR'),
}
os.environ.setdefault('YUKI_CACHE_DIR', _TEST_CACHE_DIR)
os.environ.setdefault('YUKI_DATA_DIR', os.path.join(_TMP_ROOT, 'data'))

import hoststate  # noqa: E402
hoststate.configure(cache_dir=_TEST_CACHE_DIR,
                    data_dir=os.path.join(_TMP_ROOT, 'data'))


def _restore_globals():
    """atexit：恢复 env 与 hoststate，并清理临时根。

    hoststate 目录按恢复后的 env 重新推导（与 hoststate 导入期 `_ENV_DATA_DIR or
    _HOME` 的口径一致）——不用导入后的 get_cache_dir()/get_data_dir() 快照，
    因为那时 env 已被 setdefault 改写，快照到的会是测试临时目录。
    """
    for key, val in _ORIG_ENV.items():
        if val is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = val
    try:
        env_data = (os.environ.get('YUKI_DATA_DIR') or '').strip()
        env_cache = (os.environ.get('YUKI_CACHE_DIR') or '').strip()
        data_dir = env_data or os.path.join(os.path.expanduser('~'), '.yuki')
        cache_dir = env_cache or os.path.join(data_dir, 'cache')
        hoststate.configure(cache_dir=cache_dir, data_dir=data_dir)
    except Exception:
        pass
    shutil.rmtree(_TMP_ROOT, ignore_errors=True)


import atexit
atexit.register(_restore_globals)


def _tmpdir(prefix):
    return tempfile.mkdtemp(prefix=prefix)


def _rmtree(path):
    shutil.rmtree(path, ignore_errors=True)


def _advance(seconds):
    """返回 patcher：把 cache_store 视角的 time.time 整体前移 seconds 秒。"""
    real = time.time
    return mock.patch('cache_store.time.time', lambda: real() + seconds)


def _monotonic_advance(seconds):
    real = time.monotonic
    return mock.patch.object(mem_cache.time, 'monotonic',
                             lambda: real() + seconds)


# ================================================================ play_cache


class _PlayDir:
    """把 play_cache 指向临时目录并在退出时还原单例。"""

    def __init__(self, prefix='yuki-test-playcache-'):
        self.prefix = prefix

    def __enter__(self):
        self._tmp = _tmpdir(self.prefix)
        play_cache.set_dir_for_tests(self._tmp)
        return self._tmp, play_cache._store()

    def __exit__(self, *exc):
        play_cache.set_dir_for_tests(None)
        _rmtree(self._tmp)
        return False


def test_play_cache_key_is_four_segment_site_flag_id_vip():
    """key 构造以源码为准：``site.key|flag|id|vip_key``——四段各自变化都换条目。"""
    with _PlayDir() as (tmp, store):
        variants = {
            'siteA|flag1|ep1|[]': 'base',
            'siteB|flag1|ep1|[]': '换站点',
            'siteA|flag2|ep1|[]': '换线路',
            'siteA|flag1|ep2|[]': '换集',
            'siteA|flag1|ep1|["vip"]': '换 vipFlags',
        }
        for key, payload in variants.items():
            play_cache.store_result(key, json.dumps({'url': payload}))
        for key, payload in variants.items():
            assert play_cache.get_result(key) == json.dumps({'url': payload}), key
        # 五条互不相同 → 落五个文件
        assert len([n for n in os.listdir(tmp) if n.endswith('.json')]) == 5
        assert len(store.mem) == 5


def test_play_cache_key_with_pipe_in_segment_still_disambiguates():
    """分隔符 ``|`` 出现在段内时按原文参与 sha1，不产生路径/键碰撞。"""
    with _PlayDir() as (tmp, store):
        k1 = 'site|flag|a|b|[]'
        k2 = 'site|flag|a|[]|b'
        play_cache.store_result(k1, json.dumps({'url': 'one'}))
        play_cache.store_result(k2, json.dumps({'url': 'two'}))
        assert play_cache.get_result(k1) == json.dumps({'url': 'one'})
        assert play_cache.get_result(k2) == json.dumps({'url': 'two'})
        assert store._name_of(k1) != store._name_of(k2)


def test_play_cache_key_is_hashed_no_path_traversal():
    """key 只经 sha1 落文件名：含 ../ 与分隔符的恶意 key 不产生目录逃逸。"""
    with _PlayDir() as (tmp, store):
        evil = '../../../../../../windows/win.ini'
        play_cache.store_result(evil, json.dumps({'url': 'https://x/y.mp4'}))
        name = hashlib.sha1(evil.encode('utf-8')).hexdigest() + '.json'
        entries = os.listdir(tmp)
        assert entries == [name], entries
        assert os.path.isfile(os.path.join(tmp, name))
        assert not os.path.exists(os.path.join(tmp, '..', 'win.ini'))
        assert play_cache.get_result(evil) == json.dumps({'url': 'https://x/y.mp4'})
        assert store.mem  # 内存层同样按原文 key 索引


def test_play_cache_unicode_and_oversized_keys():
    """中文 key 与超长 key 都能往返（sha1 定长，不受 key 长度影响）。"""
    with _PlayDir() as (tmp, store):
        cn = '站点甲|线路①|第1集|["vip"]'
        long_key = 'L' * 8192
        play_cache.store_result(cn, json.dumps({'url': 'https://x/cn.mp4'}))
        play_cache.store_result(long_key, json.dumps({'url': 'https://x/long.mp4'}))
        assert play_cache.get_result(cn) == json.dumps({'url': 'https://x/cn.mp4'})
        assert play_cache.get_result(long_key) == json.dumps({'url': 'https://x/long.mp4'})
        assert all(len(n) == 45 for n in os.listdir(tmp))   # sha1(40) + '.json'


def test_play_cache_store_rejects_empty_key_or_value():
    """空 key / 空 value 静默忽略：不落盘、不建条目（缓存失败不得影响主链路）。"""
    with _PlayDir() as (tmp, store):
        play_cache.store_result('', json.dumps({'url': 'u'}))
        play_cache.store_result(None, json.dumps({'url': 'u'}))
        play_cache.store_result('k1', '')
        play_cache.store_result('k1', None)
        play_cache.store_result('k2', '0')
        assert play_cache.get_result('k1') is None
        assert play_cache.get_result('') is None
        assert play_cache.get_result('k2') == '0', "'0' 是真值字符串，应落盘"
        assert len(os.listdir(tmp)) == 1, '只有 k2 落盘'
        assert list(store.mem) == ['k2']


def test_play_cache_ttl_is_clamped_to_at_least_one_second():
    """TTL 下限钳制：ttl<=0 时按 max(1, int(ttl)) 落 1 秒，永远不过期成 0。"""
    with _PlayDir() as (_tmp, store):
        play_cache.store_result('clamp0', json.dumps({'url': 'a'}), ttl=0)
        play_cache.store_result('clampneg', json.dumps({'url': 'b'}), ttl=-10)
        play_cache.store_result('clamp1', json.dumps({'url': 'c'}), ttl=1)
        now = time.time()
        for key in ('clamp0', 'clampneg', 'clamp1'):
            exp = store.mem[key][1]
            assert 0 < exp - now <= 2.0, (key, exp - now)
        with _advance(3):
            assert play_cache.get_result('clamp0') is None
            assert play_cache.get_result('clampneg') is None
            assert play_cache.get_result('clamp1') is None


def test_play_cache_explicit_ttl_overrides_default():
    """显式 ttl 覆盖默认 2h：短 TTL 条目先过期，长 TTL 条目仍在。"""
    with _PlayDir() as (_tmp, store):
        play_cache.store_result('short', json.dumps({'url': 'a'}), ttl=30)
        play_cache.store_result('long', json.dumps({'url': 'b'}), ttl=7200)
        with _advance(60):
            assert play_cache.get_result('short') is None
            assert play_cache.get_result('long') == json.dumps({'url': 'b'})


def test_play_cache_expiry_removes_file_and_mem_entry():
    """过期失效：get 命中过期条目 → 返回 None 且惰性删除文件 + 内存条目。"""
    with _PlayDir() as (tmp, store):
        key = 'expire-me'
        play_cache.store_result(key, json.dumps({'url': 'a'}), ttl=60)
        name = os.path.join(tmp, store._name_of(key))
        assert os.path.exists(name)
        assert key in store.mem
        with _advance(3600):
            assert play_cache.get_result(key) is None
        assert not os.path.exists(name), '过期文件必须被惰性删除'
        assert key not in store.mem
        assert play_cache.stats() == (0, 0, 0)


def test_play_cache_invalidate_then_reparse():
    """失效重解析：invalidate 删掉内存层与文件层，之后可重新写入新结果。"""
    with _PlayDir() as (tmp, store):
        key = 'siteA|flag1|ep9|[]'
        old = json.dumps({'url': 'https://cdn/old.mp4'})
        new = json.dumps({'url': 'https://cdn/new.mp4'})
        play_cache.store_result(key, old)
        assert play_cache.get_result(key) == old
        play_cache.invalidate(key)
        assert play_cache.get_result(key) is None
        assert not os.path.exists(os.path.join(tmp, store._name_of(key)))
        assert key not in store.mem
        play_cache.store_result(key, new)          # 重新解析后落新值
        assert play_cache.get_result(key) == new
        play_cache.invalidate('never-existed')     # 幂等，不抛错


def test_play_cache_non_dict_payload_silently_degrades_get():
    """损坏文件内容（合法 JSON 但不是 dict）→ get 安全降级为未命中。

    【源码缺陷】cache_store.get 的 ``except (OSError, ValueError)`` 未覆盖
    ``AttributeError``：文件里是 ``[1,2]`` / ``"str"`` 这类**合法 JSON 但非 dict**
    时，``data.get`` 抛 AttributeError 穿透 get_result 之外的调用方（本模块靠
    自己的 ``except Exception`` 兜住，但直接用 CacheStore 的代码会炸）。
    """
    with _PlayDir() as (tmp, store):
        key = 'list-payload'
        with open(os.path.join(tmp, store._name_of(key)), 'w', encoding='utf-8') as fp:
            fp.write('[1,2]')
        assert play_cache.get_result(key) is None, '损坏文件应安全降级为未命中'
        # 直接走 CacheStore 时该缺陷暴露（记录而非断言，避免把缺陷固化成期望）
        store._scanned = False
        try:
            store.get(key)
            raised = None
        except AttributeError as exc:
            raised = exc
        assert raised is not None, 'CacheStore.get 对非 dict payload 抛 AttributeError'
        assert 'get' in str(raised)


def test_play_cache_stats_breaks_on_non_dict_payload():
    """【源码缺陷】stats() 的首次扫描遇到非 dict payload 会整体抛出。

    cache_store._ensure_scanned:80 对扫描到的每个文件执行 ``json.load(f).get('exp', 0)``
    且只捕 ``(OSError, ValueError)``；非 dict 的合法 JSON 抛 AttributeError，
    打断扫描 → play_cache.stats() 走 except Exception 返回 (0,0,0)，**整个持久层
    的统计在此后永久失真**（/cache 面板看到的 play-cache 体积恒为 0）。
    """
    with _PlayDir() as (tmp, store):
        with open(os.path.join(tmp, store._name_of('broken')), 'w',
                  encoding='utf-8') as fp:
            fp.write('"not-an-object"')
        for i in range(3):
            play_cache.store_result('ok-%d' % i, json.dumps({'url': 'u%d' % i}))
        store._scanned = False          # 强制走「首次扫描」路径
        assert play_cache.stats() == (0, 0, 0), '扫描被打断 → 统计静默归零'
        # 未走扫描时（记账已增量维护）统计正常，说明失真只发生在首次扫描
        store._scanned = True
        assert play_cache.stats()[1] == 3


def test_play_cache_clear_all_resets_accounting():
    """clear_all：删除全部文件并把记账与内存层一并归零，返回删除文件数。"""
    with _PlayDir() as (tmp, store):
        for i in range(4):
            play_cache.store_result('c%d' % i, json.dumps({'url': 'u'}))
        removed = play_cache.clear_all()
        assert removed == 4, removed
        assert not [n for n in os.listdir(tmp) if n.endswith('.json')]
        assert store._total == 0
        assert store._files == {} and store._key_by_name == {}
        assert not store.mem
        assert play_cache.clear_all() == 0      # 二次清空幂等


def test_play_cache_creates_directory_when_missing():
    """目录不存在自动创建：指向多级不存在的路径也要能落盘。"""
    root = _tmpdir('yuki-test-playcache-missing-')
    try:
        target = os.path.join(root, 'a', 'b', 'play-cache')
        play_cache.set_dir_for_tests(target)
        store = play_cache._store()
        assert os.path.isdir(target)
        play_cache.store_result('k', json.dumps({'url': 'u'}))
        assert os.path.isfile(os.path.join(target, store._name_of('k')))
        assert play_cache.get_result('k') == json.dumps({'url': 'u'})
    finally:
        play_cache.set_dir_for_tests(None)
        _rmtree(root)


def test_play_cache_singleton_is_built_once_under_concurrency():
    """并发首访只构造一个实例（P3-3）：后写者不得覆盖先写者的实例级记账。"""
    root = _tmpdir('yuki-test-playcache-single-')
    try:
        play_cache.set_dir_for_tests(root)
        seen = []
        lock = threading.Lock()
        barrier = threading.Barrier(12)

        def worker():
            barrier.wait()
            store = play_cache._store()
            with lock:
                seen.append(id(store))

        threads = [threading.Thread(target=worker) for _ in range(12)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=15)
        assert not any(t.is_alive() for t in threads)
        assert len(set(seen)) == 1, '并发首访产生了多个 CacheStore 实例'
        assert play_cache._store().max_bytes == play_cache.MAX_TOTAL_BYTES
        assert play_cache._store().max_bytes == 16 * 1024 * 1024
    finally:
        play_cache.set_dir_for_tests(None)
        _rmtree(root)


def test_play_cache_set_dir_drops_singleton():
    """set_dir_for_tests 换目录即丢弃单例：下次访问按新目录重建（重启模拟）。"""
    first = _tmpdir('yuki-test-playcache-a-')
    second = _tmpdir('yuki-test-playcache-b-')
    try:
        play_cache.set_dir_for_tests(first)
        play_cache.store_result('k', json.dumps({'url': 'in-a'}))
        store_a = play_cache._store()
        play_cache.set_dir_for_tests(second)
        store_b = play_cache._store()
        assert store_b is not store_a
        assert store_b.dir == second
        assert play_cache.get_result('k') is None, '新目录读不到旧目录的条目'
        assert os.path.isfile(os.path.join(first, store_a._name_of('k')))
    finally:
        play_cache.set_dir_for_tests(None)
        _rmtree(first)
        _rmtree(second)


def test_play_cache_concurrent_writes_are_safe():
    """并发写入安全：多线程同时 store/get 不抛错、不丢条目、记账与磁盘一致。"""
    with _PlayDir() as (tmp, store):
        errors = []

        def worker(i):
            try:
                for j in range(12):
                    key = 'k%d-%d' % (i, j)
                    play_cache.store_result(key, json.dumps({'url': 'u%d%d' % (i, j)}))
                    play_cache.get_result(key)
            except Exception as exc:                       # noqa: BLE001
                errors.append(repr(exc))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        assert not any(t.is_alive() for t in threads)
        assert errors == [], errors[:3]
        assert play_cache.stats()[1] == 96
        real = len([n for n in os.listdir(tmp) if n.endswith('.json')])
        assert real == 96, real
        assert store._total == play_cache.stats()[0]


def test_play_cache_overwrite_refreshes_and_does_not_double_count():
    """覆盖写：值被刷新，记账按新 size 替换（不重复累加）。"""
    with _PlayDir() as (_tmp, store):
        key = 'ow'
        play_cache.store_result(key, json.dumps({'url': 'short'}))
        first_total = store._total
        play_cache.store_result(key, json.dumps({'url': 'x' * 500}))
        assert play_cache.get_result(key) == json.dumps({'url': 'x' * 500})
        assert store._total > first_total
        assert len(store._files) == 1, '同名条目只占一条记账'
        assert store._total == store._files[store._name_of(key)][0]


def test_play_cache_capacity_is_inherited_from_module_constant():
    """容量上限：实例级 max_bytes 由 MAX_TOTAL_BYTES 注入，超限按最旧淘汰。"""
    with _PlayDir() as (_tmp, store):
        assert store.max_bytes == play_cache.MAX_TOTAL_BYTES
        store.max_bytes = 2048
        for i in range(12):
            play_cache.store_result('big-%02d' % i, json.dumps({'url': 'y' * 400}))
        assert store._total <= 2048, store._total
        assert play_cache.stats()[1] < 12
        assert play_cache.get_result('big-11') is not None, '最新写入必须存活'


def test_play_cache_get_result_missing_returns_none_not_empty():
    """读侧语义：未命中返回 None（不是 CacheStore 的空串），失败一律静默。"""
    with _PlayDir():
        assert play_cache.get_result('nope') is None
        assert play_cache.get_result('') is None
        assert play_cache.get_result(None) is None


# =============================================================== cache_store


def test_cache_store_directory_is_created_and_tmp_files_cleaned():
    """构造即建目录 + 启动清理：目录不存在自动创建，崩溃残留 *.tmp* 被回收。"""
    root = _tmpdir('yuki-test-store-init-')
    try:
        target = os.path.join(root, 'x', 'y', 'kv')
        os.makedirs(target)
        for name in ('a.tmp123-456', 'b.json.tmp999-1', 'keep.json'):
            with open(os.path.join(target, name), 'w', encoding='utf-8') as fp:
                fp.write('{}')
        CacheStore(target)          # 构造即触发清理
        left = sorted(os.listdir(target))
        assert left == ['keep.json'], left
        # 多级不存在的目录同样自动创建
        deep = os.path.join(root, 'p', 'q', 'kv')
        assert os.path.isdir(CacheStore(deep).dir)
    finally:
        _rmtree(root)


def test_cache_store_cleanup_survives_unreadable_directory():
    """启动清理容错：目录不可列出 / 文件删不掉时静默跳过，不阻断构造。"""
    root = _tmpdir('yuki-test-store-cleanup-')
    try:
        store = CacheStore(root)
        with mock.patch('os.listdir', side_effect=OSError('denied')):
            store._cleanup_tmp_files()          # 不得抛出
        with open(os.path.join(root, 'x.tmp1-1'), 'w', encoding='utf-8') as fp:
            fp.write('{}')
        with mock.patch('os.remove', side_effect=OSError('locked')):
            store._cleanup_tmp_files()          # 删除失败同样静默
        assert os.path.exists(os.path.join(root, 'x.tmp1-1'))
    finally:
        _rmtree(root)


def test_cache_store_key_hashing_prevents_path_injection():
    """key 规范化：sha1 命名把任意非法字符（/ \\ : * ? " < > | NUL）挡在文件名外。"""
    root = _tmpdir('yuki-test-store-keys-')
    try:
        store = CacheStore(root)
        keys = ['a/b', '..\\..\\evil', 'C:\\x\\y', '*?"<>|', 'k\x00nul',
                ' ', '\n\t', '中文键', 'x' * 4096, '../../etc/passwd']
        for key in keys:
            store.set(key, 'v:' + key[:8])
            assert store.get(key) == 'v:' + key[:8], key
        names = sorted(os.listdir(root))
        assert len(names) == len(keys)
        for name in names:
            assert name.endswith('.json') and len(name) == 45, name
            assert all(ch not in name for ch in '/\\:*?"<>|'), name
        assert store._name_of('a/b') == hashlib.sha1(b'a/b').hexdigest() + '.json'
        assert store._path('a/b') == os.path.join(root, store._name_of('a/b'))
    finally:
        _rmtree(root)


def test_cache_store_empty_key_is_usable_but_distinct():
    """空 key 也能往返（sha1('') 是合法文件名），与 '0'/' ' 互不碰撞。"""
    root = _tmpdir('yuki-test-store-emptykey-')
    try:
        store = CacheStore(root)
        store.set('', 'empty')
        store.set(' ', 'space')
        store.set('0', 'zero')
        assert store.get('') == 'empty'
        assert store.get(' ') == 'space'
        assert store.get('0') == 'zero'
        assert len({store._name_of(k) for k in ('', ' ', '0')}) == 3
    finally:
        _rmtree(root)


def test_cache_store_roundtrip_and_delete_never_written_key():
    """set/get/delete 往返 + 删除「只进内存未落盘」的 key：记账不得变负。"""
    root = _tmpdir('yuki-test-store-rt-')
    try:
        store = CacheStore(root)
        store.set('k1', 'v1', ttl=60)
        assert store.get('k1') == 'v1'
        assert store.mem['k1'][0] == 'v1'
        store.delete('k1')
        assert store.get('k1') == ''
        assert 'k1' not in store.mem
        assert not os.path.exists(os.path.join(root, store._name_of('k1')))
        # 未落盘的 key（记账里没有）→ 删除后记账仍为 0，不出现负值
        store.mem['ghost'] = ('x', 0)
        store.delete('ghost')
        assert store._total == 0
        assert store.stats() == (0, 0, 0)
        store.delete('never-existed')           # 幂等
        assert store.stats() == (0, 0, 0)
    finally:
        _rmtree(root)


def test_cache_store_ttl_expiry_lazy_deletes_file():
    """TTL 过期：内存命中过期 → 返回空串并删文件；文件层过期同样惰性删除。"""
    root = _tmpdir('yuki-test-store-ttl-')
    try:
        store = CacheStore(root)
        store.set('mem-exp', 'v', ttl=30)
        store.set('file-exp', 'v', ttl=30)
        store.mem.pop('file-exp', None)        # 强制走文件路径
        path = os.path.join(root, store._name_of('file-exp'))
        assert os.path.exists(path)
        with _advance(31):
            assert store.get('mem-exp') == ''
            assert store.get('file-exp') == ''
        assert 'mem-exp' not in store.mem
        assert not os.path.exists(path)
        assert store.stats() == (0, 0, 0)
    finally:
        _rmtree(root)


def test_cache_store_zero_or_negative_ttl_never_expires():
    """ttl<=0（默认）永不过期：exp 记 0，时间推进后仍然命中（向后兼容）。"""
    root = _tmpdir('yuki-test-store-noexp-')
    try:
        store = CacheStore(root)
        store.set('forever', 'v')
        store.set('neg', 'v', ttl=-100)
        assert store.mem['forever'][1] == 0
        assert store.mem['neg'][1] == 0
        with _advance(10 ** 6):
            assert store.get('forever') == 'v'
            assert store.get('neg') == 'v'
    finally:
        _rmtree(root)


def test_cache_store_expired_entry_is_preferred_as_eviction_victim():
    """淘汰顺序：先挑已过期条目，再按 mtime 挑最旧（test_cache_store 之外的
    私有分支：验证「过期优先」在同批候选里真的先于「最旧」）。"""
    root = _tmpdir('yuki-test-store-evictorder-')
    try:
        store = CacheStore(root)
        store.max_bytes = 10 ** 6
        store.set('older', 'a' * 100)          # mtime 更旧，但未过期
        store.set('expired', 'b' * 100)
        store.set('newer', 'c' * 100)
        path = os.path.join(root, store._name_of('expired'))
        with open(path, 'w', encoding='utf-8') as fp:
            json.dump({'value': 'b' * 100, 'exp': time.time() - 1}, fp)
        store._account_set('expired', os.path.basename(path),
                           os.path.getsize(path), time.time() - 1)
        store.mem.pop('expired', None)
        store.max_bytes = 250                  # 只够两条 → 必须淘汰一条
        store._evict_if_needed()
        assert store.get('expired') == '', '过期条目必须被优先淘汰'
        assert store.get('older') == 'a' * 100
        assert store.get('newer') == 'c' * 100
    finally:
        _rmtree(root)


def test_cache_store_single_oversized_entry_self_evicts():
    """单条就超过容量上限：写完立刻把自己淘汰掉（不能留下超限或死循环）。"""
    root = _tmpdir('yuki-test-store-selfevict-')
    try:
        store = CacheStore(root)
        store.max_bytes = 10
        store.set('huge', 'x' * 4096)
        assert store.get('huge') == ''
        assert store._total == 0
        assert store.stats() == (0, 0, 0)
        assert not [n for n in os.listdir(root) if n.endswith('.json')]
    finally:
        _rmtree(root)


def test_cache_store_evict_purges_mem_entry_of_victim():
    """淘汰受害者时同步清掉它的内存条目（否则 get 会从 mem 里读回已删数据）。"""
    root = _tmpdir('yuki-test-store-evictmem-')
    try:
        store = CacheStore(root)
        for i in range(6):
            store.set('k%d' % i, 'x' * 200)
        assert len(store.mem) == 6
        store.max_bytes = 500
        store.set('trigger', 'y' * 200)
        assert store._total <= 500
        for key in list(store.mem):
            assert store.mem[key][0] == store.get(key) or store.get(key) == ''
        stale = [k for k in store.mem
                 if not os.path.exists(os.path.join(root, store._name_of(k)))]
        assert stale == [], '被淘汰的条目必须从 mem 里一并清掉：%s' % stale
    finally:
        _rmtree(root)


def test_cache_store_get_prefers_mem_over_stale_file():
    """锁内复核：文件读在锁外，期间并发 set 写进 mem 的新值优先于文件陈旧值。"""
    root = _tmpdir('yuki-test-store-recheck-')
    try:
        store = CacheStore(root)
        store.set('race', 'file-value', ttl=0)
        store.mem.pop('race', None)
        real_open = open
        calls = {'n': 0}

        def write_then_open(*args, **kwargs):
            """模拟「内存层未命中、准备读文件」期间另一线程把新值写进 mem。"""
            if args and store._name_of('race') in str(args[0]):
                calls['n'] += 1
                store.mem['race'] = ('mem-value', 0)
            return real_open(*args, **kwargs)

        with mock.patch('builtins.open', side_effect=write_then_open):
            assert store.get('race') == 'mem-value', '复核命中应以 mem 为准'
        assert calls['n'] == 1
        # 复核到的是**已过期**的 mem 条目 → 按缺失处理，不回灌陈旧文件值
        store.mem['race'] = ('stale', 1)      # exp=1（1970 年）恒过期
        assert store.get('race') == ''
        assert 'race' not in store.mem
    finally:
        _rmtree(root)


def test_cache_store_concurrent_set_get_keeps_accounting_consistent():
    """并发读写：无异常、记账条目数与磁盘文件数一致、总量等于实际字节和。"""
    root = _tmpdir('yuki-test-store-concurrent-')
    try:
        store = CacheStore(root)
        errors = []

        def worker(i):
            try:
                for j in range(15):
                    key = 'k%d-%d' % (i, j)
                    store.set(key, 'v' * 60)
                    store.get(key)
            except Exception as exc:                       # noqa: BLE001
                errors.append(repr(exc))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        assert not any(t.is_alive() for t in threads)
        assert errors == [], errors[:3]
        total, entries, _expired = store.stats()
        real = [n for n in os.listdir(root) if n.endswith('.json')]
        assert entries == len(real) == 120, (entries, len(real))
        assert total == sum(os.path.getsize(os.path.join(root, n)) for n in real)
    finally:
        _rmtree(root)


def test_cache_store_clear_resets_every_layer():
    """clear：删全部 .json（保留无关文件）、返回删除数、记账与内存归零。"""
    root = _tmpdir('yuki-test-store-clear-')
    try:
        store = CacheStore(root)
        store.set('a', '1')
        store.set('b', '2')
        with open(os.path.join(root, 'notes.txt'), 'w', encoding='utf-8') as fp:
            fp.write('keep me')
        with open(os.path.join(root, 'x.tmp7-7'), 'w', encoding='utf-8') as fp:
            fp.write('{}')
        assert store.clear() == 2
        assert sorted(os.listdir(root)) == ['notes.txt', 'x.tmp7-7']
        assert store.mem == {} and store._files == {} and store._key_by_name == {}
        assert store._total == 0 and store._scanned is True
    finally:
        _rmtree(root)


def test_cache_store_clear_survives_unremovable_file():
    """clear 容错：个别文件删不掉（占用/只读）时其余照删，不抛错。"""
    root = _tmpdir('yuki-test-store-clearfail-')
    try:
        store = CacheStore(root)
        store.set('a', '1')
        store.set('b', '2')
        real_remove = os.remove

        def picky(path):
            if path.endswith(store._name_of('a')):
                raise OSError('locked')
            return real_remove(path)
        with mock.patch('os.remove', side_effect=picky):
            assert store.clear() == 1
        assert store._total == 0 and store._files == {}
    finally:
        _rmtree(root)


def test_cache_store_stats_counts_expired_but_unreaped():
    """stats 的 expired 口径：已过期但尚未惰性清理的条目单独计数。

    注意记账里只有**文件层**条目的过期态：内存层条目（未走 delete）即使已
    过期也不计入 expired——这正是「过期未清」的语义边界。
    """
    root = _tmpdir('yuki-test-store-expiredstats-')
    try:
        store = CacheStore(root)
        store.set('live', 'v', ttl=3600)
        store.set('dying', 'v', ttl=30)
        store.mem.pop('dying', None)           # 只留文件层，进入 stats 记账视野
        assert store.stats()[2] == 0
        with _advance(31):
            total, entries, expired = store.stats()
            assert entries == 2
            assert expired == 1
            assert total > 0
            dying_size = store._files[store._name_of('dying')][0]
            # 惰性删除发生在读侧：过期条目被 get 命中时才清掉（stats 自己不动文件）
            assert store.get('dying') == ''
            after_total, after_entries, after_expired = store.stats()
            assert after_entries == 1 and after_expired == 0
            assert after_total == total - dying_size
        assert not os.path.exists(os.path.join(root, store._name_of('dying')))
    finally:
        _rmtree(root)


# ================================================================== mem_cache


def _mc_reset():
    mem_cache.clear_all()


def test_mem_cache_clamp_ttl_matrix():
    """_clamp_ttl：命名空间默认表 / 显式覆盖 / 非法值与负值的下限钳制。"""
    assert mem_cache._clamp_ttl('spider:home', None) == 600
    assert mem_cache._clamp_ttl('spider:category', None) == 600
    assert mem_cache._clamp_ttl('spider:detail', None) == 1800
    assert mem_cache._clamp_ttl('spider:search', None) == 600
    assert mem_cache._clamp_ttl('kazumi:search', None) == 600
    assert mem_cache._clamp_ttl('kazumi:stream', None) == 600
    assert mem_cache._clamp_ttl('kazumi:chapters', None) == 1800
    assert mem_cache._clamp_ttl('totally:unknown', None) == 600, '未登记 ns 默认 600'
    assert mem_cache._clamp_ttl('x', 1) == 1
    assert mem_cache._clamp_ttl('x', 0) == 1, '0 → 下限 1s'
    assert mem_cache._clamp_ttl('x', -5) == 1, '负值 → 下限 1s'
    assert mem_cache._clamp_ttl('x', 'abc') == 600, '非数字 → 默认 600'
    assert mem_cache._clamp_ttl('x', None) == 600
    assert mem_cache._clamp_ttl('x', 2.9) == 2, '浮点截断为 int'
    assert mem_cache._clamp_ttl('x', True) == 1


def test_mem_cache_expiry_boundary_is_inclusive():
    """TTL 边界：判定是 ``now >= exp``（到点即失效，不是之后一拍）。

    大偏移断言未到期命中、再用 ``now`` 断言失效——去掉 1ms 真实时钟竞窗
    （机器负载高时 GC/线程抢占可能跨过 1ms 窗口造成偶发失败）。
    """
    _mc_reset()
    mem_cache.set_value('t:bound', 'k', 'v', ttl=60)
    bucket = mem_cache._store['t:bound']
    now = time.monotonic()
    bucket['k'][1] = now + 60                       # 远未来：无竞态窗口
    assert mem_cache.get_value('t:bound', 'k') == 'v', '未到点仍命中'
    bucket = mem_cache._store['t:bound']
    bucket['k'][1] = now                            # 恰好等于 now
    assert mem_cache.get_value('t:bound', 'k') is None, 'now >= exp 即失效'
    assert 'k' not in mem_cache._store['t:bound'], '过期条目被惰性删除'


def test_mem_cache_lru_order_refreshes_on_read_and_write():
    """LRU 序：get 命中与覆盖写都把条目标记为最近访问（move_to_end）。"""
    _mc_reset()
    old = mem_cache.MAX_TOTAL_ENTRIES
    try:
        mem_cache.MAX_TOTAL_ENTRIES = 3
        for index, key in enumerate(('a', 'b', 'c')):
            mem_cache.set_value('t:lru', key, key, ttl=600)
            # 拉开 last_access，保证 LRU 序稳定（不依赖真时钟的分辨率）
            mem_cache._store['t:lru'][key][2] = 1000.0 + index
        order_before = list(mem_cache._store['t:lru'])
        assert order_before == ['a', 'b', 'c']
        assert mem_cache.get_value('t:lru', 'a') == 'a'     # a 变为最近
        assert list(mem_cache._store['t:lru']) == ['b', 'c', 'a']
        mem_cache.set_value('t:lru', 'b', 'b2', ttl=600)    # 覆盖写也刷新
        assert list(mem_cache._store['t:lru']) == ['c', 'a', 'b']
        mem_cache.set_value('t:lru', 'd', 'd', ttl=600)     # 淘汰 c（最旧）
        assert mem_cache.get_value('t:lru', 'c') is None
        assert mem_cache.get_value('t:lru', 'a') == 'a'
        assert mem_cache.get_value('t:lru', 'b') == 'b2'
        assert mem_cache.get_value('t:lru', 'd') == 'd'
    finally:
        mem_cache.MAX_TOTAL_ENTRIES = old
        _mc_reset()


def test_mem_cache_lru_eviction_is_global_across_namespaces():
    """LRU 是全局的：候选取每个命名空间桶的首项，按 last_access 跨 ns 淘汰。"""
    _mc_reset()
    old_entries, old_chars = mem_cache.MAX_TOTAL_ENTRIES, mem_cache.MAX_TOTAL_CHARS
    try:
        mem_cache.MAX_TOTAL_ENTRIES = 3
        mem_cache.MAX_TOTAL_CHARS = 10 ** 9
        now0 = time.monotonic()
        # 三个命名空间各一条，last_access 依次变新（都比即将写入的第 4 条旧）
        mem_cache.set_value('ns:1', 'k1', 'a', ttl=600)
        mem_cache.set_value('ns:2', 'k2', 'b', ttl=600)
        mem_cache.set_value('ns:3', 'k3', 'c', ttl=600)
        mem_cache._store['ns:1']['k1'][2] = now0 - 3.0   # 全局最久未访问
        mem_cache._store['ns:2']['k2'][2] = now0 - 2.0
        mem_cache._store['ns:3']['k3'][2] = now0 - 1.0
        assert mem_cache._total_entries == 3
        mem_cache.set_value('ns:4', 'k4', 'd', ttl=600)     # 超限 → 淘汰全局最旧
        assert mem_cache.get_value('ns:1', 'k1') is None, '跨 ns 最久未访问者出局'
        assert mem_cache.get_value('ns:2', 'k2') == 'b'
        assert mem_cache.get_value('ns:3', 'k3') == 'c'
        assert mem_cache.get_value('ns:4', 'k4') == 'd'
        assert mem_cache._total_entries == 3
    finally:
        mem_cache.MAX_TOTAL_ENTRIES = old_entries
        mem_cache.MAX_TOTAL_CHARS = old_chars
        _mc_reset()


def test_mem_cache_capacity_cap_evicts_until_under_limit():
    """容量上限：持续写入后条目数收敛到 MAX_TOTAL_ENTRIES，总账随淘汰同步。"""
    _mc_reset()
    old = mem_cache.MAX_TOTAL_ENTRIES
    try:
        mem_cache.MAX_TOTAL_ENTRIES = 5
        for i in range(40):
            mem_cache.set_value('t:cap', 'k%d' % i, 'v%d' % i, ttl=600)
        assert mem_cache._total_entries == 5
        assert sum(len(b) for b in mem_cache._store.values()) == 5
        alive = [mem_cache.get_value('t:cap', 'k%d' % i) for i in range(35, 40)]
        assert alive == ['v%d' % i for i in range(35, 40)], '最近写入的必须存活'
        assert mem_cache.get_value('t:cap', 'k0') is None
    finally:
        mem_cache.MAX_TOTAL_ENTRIES = old
        _mc_reset()


def test_mem_cache_namespace_isolation_and_invalidate_bookkeeping():
    """命名空间隔离：同 key 在不同 ns 互不影响；invalidate 只清目标 ns 并同步总账。"""
    _mc_reset()
    mem_cache.set_value('t:x', 'k', 'xx', ttl=600)
    mem_cache.set_value('t:y', 'k', 'yyyy', ttl=600)
    assert mem_cache.get_value('t:x', 'k') == 'xx'
    assert mem_cache.get_value('t:y', 'k') == 'yyyy'
    assert mem_cache._total_entries == 2
    assert mem_cache._total_chars == 6
    mem_cache.invalidate('t:x')
    assert mem_cache.get_value('t:x', 'k') is None
    assert mem_cache.get_value('t:y', 'k') == 'yyyy'
    assert mem_cache._total_entries == 1
    assert mem_cache._total_chars == 4
    mem_cache.invalidate('t:missing')          # 空 ns：静默
    mem_cache.invalidate('')                   # 空 ns 名：静默
    assert mem_cache._total_entries == 1
    assert 't:x' not in mem_cache._store


def test_mem_cache_invalidate_prefix_edge_cases():
    """前缀失效：全匹配/部分匹配/空前缀/不存在的 ns/前缀为空串的分支。"""
    _mc_reset()
    mem_cache.set_value('t:p', 'a|1', '1', ttl=600)
    mem_cache.set_value('t:p', 'a|2', '2', ttl=600)
    mem_cache.set_value('t:p', 'b|1', '3', ttl=600)
    assert mem_cache._total_entries == 3 and mem_cache._total_chars == 3
    mem_cache.invalidate_prefix('t:p', 'a|')
    assert mem_cache.get_value('t:p', 'a|1') is None
    assert mem_cache.get_value('t:p', 'a|2') is None
    assert mem_cache.get_value('t:p', 'b|1') == '3'
    assert mem_cache._total_entries == 1 and mem_cache._total_chars == 1
    mem_cache.invalidate_prefix('t:p', 'zzz')          # 无匹配：原样保留
    assert mem_cache._total_entries == 1
    mem_cache.invalidate_prefix('t:missing', 'a')      # ns 不存在
    assert mem_cache._total_entries == 1
    mem_cache.invalidate_prefix('', 'a')               # 空 ns
    mem_cache.invalidate_prefix('t:p', '')             # 空前缀
    assert mem_cache._total_entries == 1
    # 前缀是 key 的全称也匹配（startswith 语义）
    mem_cache.invalidate_prefix('t:p', 'b|1')
    assert mem_cache.get_value('t:p', 'b|1') is None
    assert mem_cache._total_entries == 0


def test_mem_cache_stats_uses_lazy_expiry_accounting():
    """stats 口径：过期未清条目不计入；命中后原 ns 从统计里消失。"""
    _mc_reset()
    mem_cache.set_value('t:s1', 'k', 'vv', ttl=600)
    mem_cache.set_value('t:s2', 'k', 'v', ttl=600)
    stats = mem_cache.stats()
    assert stats['t:s1'] == {'items': 1, 'chars': 2}
    assert stats['t:s2'] == {'items': 1, 'chars': 1}
    # 手动把 t:s2 设为过期：stats 立即不计（惰性删除口径）
    mem_cache._store['t:s2']['k'][1] = time.monotonic() - 0.001
    assert 't:s2' not in mem_cache.stats()
    assert mem_cache.get_value('t:s2', 'k') is None
    assert mem_cache._total_entries == 1
    assert mem_cache.stats() == {'t:s1': {'items': 1, 'chars': 2}}


def test_mem_cache_concurrent_access_keeps_bookkeeping_consistent():
    """并发安全：多线程 set/get/delete/mutate 后全局总账与 _store 实际内容一致。"""
    _mc_reset()
    errors = []

    def writer(i):
        try:
            for j in range(30):
                mem_cache.set_value('t:c%d' % (i % 3), 'k%d' % j, 'v' * 8, ttl=600)
                mem_cache.get_value('t:c%d' % (i % 3), 'k%d' % j)
        except Exception as exc:                           # noqa: BLE001
            errors.append(repr(exc))

    def mutator():
        try:
            for j in range(20):
                mem_cache.mutate('t:m', 'idx', lambda old: (old or '') + 'x')
        except Exception as exc:                           # noqa: BLE001
            errors.append(repr(exc))

    def killer():
        try:
            for j in range(20):
                mem_cache.delete_value('t:c0', 'k%d' % j)
        except Exception as exc:                           # noqa: BLE001
            errors.append(repr(exc))

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(6)]
    threads.append(threading.Thread(target=mutator))
    threads.append(threading.Thread(target=killer))
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not any(t.is_alive() for t in threads)
    assert errors == [], errors[:3]
    expect_entries = sum(len(b) for b in mem_cache._store.values())
    expect_chars = sum(len(m[0]) for b in mem_cache._store.values()
                       for m in b.values())
    assert mem_cache._total_entries == expect_entries
    assert mem_cache._total_chars == expect_chars
    _mc_reset()


def test_mem_cache_oversize_and_bad_arguments_are_rejected():
    """参数护栏：超长 value 拒写；ns/key/value 非法时静默忽略且不建桶。"""
    _mc_reset()
    mem_cache.set_value('t:big', 'k', 'x' * (mem_cache.MAX_VALUE_CHARS + 1), ttl=600)
    assert mem_cache.get_value('t:big', 'k') is None
    assert 't:big' not in mem_cache._store, '被拒的写入不得建空桶'
    mem_cache.set_value('t:big', 'k', 'x' * mem_cache.MAX_VALUE_CHARS, ttl=600)
    assert mem_cache.get_value('t:big', 'k') is not None, '恰好等于上限可写'
    assert mem_cache._total_entries == 1
    mem_cache.set_value('', 'k', 'v')
    mem_cache.set_value('t:ns', '', 'v')
    mem_cache.set_value('t:ns', 'k', None)
    mem_cache.set_value('t:ns', 'k2', 123)
    assert mem_cache.get_value('t:ns', 'k') is None
    assert mem_cache.get_value('t:ns', 'k2') is None
    assert mem_cache.get_value('', 'k') is None
    assert mem_cache.get_value('t:ns', '') is None
    _mc_reset()


def test_mem_cache_mutate_rejects_oversize_and_non_string():
    """mutate 护栏：返回非字符串/超长值都不写入，且原值保持不变。"""
    _mc_reset()
    mem_cache.set_value('t:m', 'k', 'orig', ttl=600)
    mem_cache.mutate('t:m', 'k', lambda old: 123)
    assert mem_cache.get_value('t:m', 'k') == 'orig'
    mem_cache.mutate('t:m', 'k', lambda old: 'x' * (mem_cache.MAX_VALUE_CHARS + 1))
    assert mem_cache.get_value('t:m', 'k') == 'orig'
    mem_cache.mutate('t:m', 'k', lambda old: b'bytes')
    assert mem_cache.get_value('t:m', 'k') == 'orig'
    assert mem_cache._total_entries == 1
    _mc_reset()


def test_mem_cache_clear_all_resets_global_state():
    """clear_all：清空全部命名空间并把全局总账归零（设置面板「清理缓存」）。"""
    _mc_reset()
    for ns in ('t:a', 't:b'):
        for i in range(3):
            mem_cache.set_value(ns, 'k%d' % i, 'v' * 10, ttl=600)
    assert mem_cache._total_entries == 6 and mem_cache._total_chars == 60
    mem_cache.clear_all()
    assert mem_cache._store == {}
    assert mem_cache._total_entries == 0
    assert mem_cache._total_chars == 0
    assert mem_cache.stats() == {}


if __name__ == '__main__':
    passed = 0
    failed = []
    for name, fn in sorted(globals().items()):
        if not (name.startswith('test_') and callable(fn)):
            continue
        try:
            fn()
        except Exception as exc:                      # noqa: BLE001 汇总 runner
            failed.append((name, exc))
            print('FAIL %s: %s: %s' % (name, type(exc).__name__, exc))
        else:
            passed += 1
            print('PASS %s' % name)
    print('----')
    print('TOTAL %d PASS %d FAIL %d' % (passed + len(failed), passed, len(failed)))
    if failed:
        for name, exc in failed:
            print('FAILED %s -> %s' % (name, exc))
        sys.exit(1)
    _rmtree(_TMP_ROOT)
    print('ALL PASS')
