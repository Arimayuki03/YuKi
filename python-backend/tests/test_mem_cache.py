# -*- coding: utf-8 -*-
"""mem_cache 单元测试：TTL、LRU 淘汰、命名空间隔离与失效语义。"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import mem_cache  # noqa: E402


def test_set_get_roundtrip():
    mem_cache.clear_all()
    mem_cache.set_value('t:ns', 'k1', '{"a":1}', ttl=60)
    assert mem_cache.get_value('t:ns', 'k1') == '{"a":1}'


def test_expire():
    mem_cache.clear_all()
    mem_cache.set_value('t:ns', 'k2', 'v', ttl=1)
    assert mem_cache.get_value('t:ns', 'k2') == 'v'
    # TTL 边界：过期后视为未命中（惰性删除）
    bucket = mem_cache._store['t:ns']
    bucket['k2'][1] = time.monotonic() - 0.001
    assert mem_cache.get_value('t:ns', 'k2') is None
    assert 'k2' not in mem_cache._store['t:ns']


def test_ns_isolation():
    mem_cache.clear_all()
    mem_cache.set_value('t:a', 'k', 'va', ttl=60)
    mem_cache.set_value('t:b', 'k', 'vb', ttl=60)
    assert mem_cache.get_value('t:a', 'k') == 'va'
    assert mem_cache.get_value('t:b', 'k') == 'vb'
    mem_cache.invalidate('t:a')
    assert mem_cache.get_value('t:a', 'k') is None
    assert mem_cache.get_value('t:b', 'k') == 'vb'


def test_invalidate_prefix():
    mem_cache.clear_all()
    mem_cache.set_value('t:ns', 'siteA|home', '1', ttl=60)
    mem_cache.set_value('t:ns', 'siteA|detail|1', '2', ttl=60)
    mem_cache.set_value('t:ns', 'siteB|home', '3', ttl=60)
    mem_cache.invalidate_prefix('t:ns', 'siteA|')
    assert mem_cache.get_value('t:ns', 'siteA|home') is None
    assert mem_cache.get_value('t:ns', 'siteA|detail|1') is None
    assert mem_cache.get_value('t:ns', 'siteB|home') == '3'


def test_lru_eviction():
    mem_cache.clear_all()
    old_limit = mem_cache.MAX_TOTAL_ENTRIES
    try:
        mem_cache.MAX_TOTAL_ENTRIES = 3
        mem_cache.set_value('t:ns', 'a', '1', ttl=60)
        time.sleep(0.005)
        mem_cache.set_value('t:ns', 'b', '2', ttl=60)
        time.sleep(0.005)
        mem_cache.set_value('t:ns', 'c', '3', ttl=60)
        time.sleep(0.005)
        # 访问 a，使 b 成为最久未访问
        mem_cache.get_value('t:ns', 'a')
        mem_cache.set_value('t:ns', 'd', '4', ttl=60)
        assert mem_cache.get_value('t:ns', 'a') == '1'
        assert mem_cache.get_value('t:ns', 'b') is None
        assert mem_cache.get_value('t:ns', 'c') == '3'
        assert mem_cache.get_value('t:ns', 'd') == '4'
    finally:
        mem_cache.MAX_TOTAL_ENTRIES = old_limit


def test_total_chars_budget_eviction():
    """P2-3：总字节（字符数）预算——少量条目 × 大 value 的体积膨胀也要被淘汰。"""
    mem_cache.clear_all()
    old_limit = mem_cache.MAX_TOTAL_CHARS
    try:
        # 预算 100 字符：两条 60 字符的大 value 共存必然超限，最旧的先被淘汰
        mem_cache.MAX_TOTAL_CHARS = 100
        big1 = 'x' * 60
        big2 = 'y' * 60
        mem_cache.set_value('t:ns', 'big1', big1, ttl=60)
        time.sleep(0.005)
        mem_cache.set_value('t:ns', 'big2', big2, ttl=60)
        assert mem_cache.get_value('t:ns', 'big1') is None  # 超预算淘汰最旧
        assert mem_cache.get_value('t:ns', 'big2') == big2
    finally:
        mem_cache.MAX_TOTAL_CHARS = old_limit


def test_oversize_rejected():
    mem_cache.clear_all()
    mem_cache.set_value('t:ns', 'big', 'x' * (mem_cache.MAX_VALUE_CHARS + 1), ttl=60)
    assert mem_cache.get_value('t:ns', 'big') is None


def test_bad_args_noop():
    mem_cache.clear_all()
    mem_cache.set_value('', 'k', 'v')
    mem_cache.set_value('t:ns', '', 'v')
    mem_cache.set_value('t:ns', 'k', None)
    assert mem_cache.get_value('t:ns', 'k') is None


def test_stats_counts_live_entries():
    mem_cache.clear_all()
    mem_cache.set_value('t:one', 'k', 'vv', ttl=60)
    mem_cache.set_value('t:two', 'k', 'v', ttl=1)
    s = mem_cache.stats()
    assert s.get('t:one') == {'items': 1, 'chars': 2}
    assert s.get('t:two', {}).get('items') == 1  # 未过期仍计入
    bucket = mem_cache._store['t:two']
    bucket['k'][1] = time.monotonic() - 0.001
    s = mem_cache.stats()
    assert 't:two' not in s


def test_mutate_atomic_append():
    """P1（结论2 #1）：mutate 在锁内完成读-改-写，供索引追加类复合值使用。"""
    mem_cache.clear_all()

    def _append(old):
        assert old is None  # 首写：无旧值
        return '["a"]'

    mem_cache.mutate('t:ns', 'idx', _append)
    assert mem_cache.get_value('t:ns', 'idx') == '["a"]'

    def _append2(old):
        assert old == '["a"]'  # 二次写：拿到旧值
        return '["a","b"]'

    mem_cache.mutate('t:ns', 'idx', _append2)
    assert mem_cache.get_value('t:ns', 'idx') == '["a","b"]'
    # 总账：mutate 覆盖写只计 1 条
    assert mem_cache._total_entries == 1


def test_mutate_edge_cases():
    mem_cache.clear_all()
    mem_cache.set_value('t:ns', 'k', 'v1', ttl=60)
    # 返回 None → 不写入；原值保持
    mem_cache.mutate('t:ns', 'k', lambda old: None)
    assert mem_cache.get_value('t:ns', 'k') == 'v1'
    # 返回超长 → 拒绝写入（与 set_value 同口径）
    mem_cache.mutate('t:ns', 'k', lambda old: 'x' * (mem_cache.MAX_VALUE_CHARS + 1))
    assert mem_cache.get_value('t:ns', 'k') == 'v1'
    # 过期条目视同缺失：mutator 收到 None，且过期项被清（总账同步）
    bucket = mem_cache._store['t:ns']
    bucket['k'][1] = time.monotonic() - 0.001
    seen = []
    mem_cache.mutate('t:ns', 'k', lambda old: seen.append(old) or 'fresh')
    assert seen == [None]
    assert mem_cache.get_value('t:ns', 'k') == 'fresh'
    # 参数非法静默
    mem_cache.mutate('', 'k', lambda old: 'v')
    mem_cache.mutate('t:ns', '', lambda old: 'v')
    mem_cache.mutate('t:ns', 'k', None)


def test_delete_value():
    mem_cache.clear_all()
    mem_cache.set_value('t:ns', 'a', '1', ttl=60)
    mem_cache.delete_value('t:ns', 'a')
    assert mem_cache.get_value('t:ns', 'a') is None
    mem_cache.delete_value('t:ns', 'a')        # 幂等
    mem_cache.delete_value('t:missing', 'a')   # ns 不存在
    assert mem_cache._total_entries == 0
    assert mem_cache._total_chars == 0


def test_global_accounting_consistency():
    """增量总账必须与 _store 实际内容一致：覆盖淘汰/覆盖写/前缀失效/整 ns 失效。"""
    mem_cache.clear_all()
    old_entries = mem_cache.MAX_TOTAL_ENTRIES
    old_chars = mem_cache.MAX_TOTAL_CHARS
    try:
        mem_cache.MAX_TOTAL_ENTRIES = 4
        mem_cache.MAX_TOTAL_CHARS = 10 ** 9
        for i in range(10):
            mem_cache.set_value('t:a', 'k%d' % i, 'x' * 10, ttl=60)
        assert mem_cache._total_entries == 4  # 恰好收敛到上限
        # 覆盖写不重复计数
        mem_cache.set_value('t:a', 'k9', 'y' * 10, ttl=60)
        assert mem_cache._total_entries == 4
        mem_cache.MAX_TOTAL_ENTRIES = old_entries
        mem_cache.MAX_TOTAL_CHARS = 100
        big = 'z' * 60
        mem_cache.set_value('t:b', 'big1', big, ttl=60)
        mem_cache.set_value('t:b', 'big2', big, ttl=60)  # 字节超限 → 最旧被逐
        expect_entries = sum(len(b) for b in mem_cache._store.values())
        expect_chars = sum(len(m[0]) for b in mem_cache._store.values() for m in b.values())
        assert mem_cache._total_entries == expect_entries
        assert mem_cache._total_chars == expect_chars
        mem_cache.MAX_TOTAL_CHARS = old_chars
        mem_cache.invalidate_prefix('t:a', 'k')
        mem_cache.invalidate('t:b')
        assert mem_cache._total_entries == sum(len(b) for b in mem_cache._store.values()) == 0
        assert mem_cache._total_chars == 0
    finally:
        mem_cache.MAX_TOTAL_ENTRIES = old_entries
        mem_cache.MAX_TOTAL_CHARS = old_chars
        mem_cache.clear_all()


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print('PASS %s' % name)
    print('ALL PASS')
