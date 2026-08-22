# -*- coding: utf-8 -*-
"""CacheStore 上限/淘汰/TTL + JS local KV 隔离/配额 单元测试（C2）。

用法：<venv>/python tests/test_cache_store.py
"""
import json
import os
import sys
import time
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)
sys.path.insert(0, os.path.join(BASE, 'js-engine'))
TEST_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
os.makedirs(TEST_ROOT, exist_ok=True)

from cache_store import CacheStore  # noqa: E402


class TestCacheStore(unittest.TestCase):

    def setUp(self):
        self.dir = TEST_ROOT
        self.store = CacheStore(self.dir)
        # 受管运行器可能复用 TEST_ROOT；先清掉上一次进程留下的 JSON，
        # 保持原来每个测试独立目录的语义。
        self.store.clear()

    def tearDown(self):
        self.store.clear()

    def test_set_get_roundtrip_and_mem_layer(self):
        self.store.set('k1', 'v1')
        self.assertEqual(self.store.get('k1'), 'v1')
        self.assertIn('k1', self.store.mem)

    def test_expired_get_returns_empty_and_file_removed(self):
        self.store.set('k2', 'v2', ttl=60)
        path = self.store._path('k2')
        # 伪造过期：直接改写文件层 exp，并清内存层强制走文件路径
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'value': 'v2', 'exp': time.time() - 1}, f)
        self.store.mem.pop('k2', None)
        self.assertEqual(self.store.get('k2'), '')
        self.assertFalse(os.path.exists(path))

    def test_eviction_keeps_total_under_cap(self):
        self.store.max_bytes = 4096
        for i in range(20):
            self.store.set('key%02d' % i, 'x' * 1024)   # 每条约 1KB+
        total, entries, _ = self.store.stats()
        self.assertLessEqual(total, 4096)
        self.assertLess(entries, 20)

    def test_eviction_prefers_expired_then_oldest(self):
        self.store.set('old', 'a' * 2048)
        self.store.set('expired', 'b' * 2048)
        # 伪造 expired 条目过期（文件 + 记账）
        path = self.store._path('expired')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'value': 'b' * 2048, 'exp': time.time() - 1}, f)
        self.store._account_set('expired', os.path.basename(path),
                                os.path.getsize(path), time.time() - 1)
        time.sleep(0.02)
        self.store.set('new', 'c' * 2048)
        self.store.max_bytes = 4600   # 触发淘汰：需删至少一个 2KB 条目
        self.store.set('trigger', 'd' * 100)
        # expired 应被优先淘汰；old（更旧）先于 new/trigger
        self.assertEqual(self.store.get('expired'), '')
        self.assertEqual(self.store.get('new'), 'c' * 2048)
        self.assertEqual(self.store.get('trigger'), 'd' * 100)

    def test_stats_counters_track_set_delete(self):
        self.store.set('a', '1')
        self.store.set('b', '2')
        total, entries, expired = self.store.stats()
        self.assertEqual(entries, 2)
        self.assertGreater(total, 0)
        self.assertEqual(expired, 0)
        self.store.delete('a')
        _, entries, _ = self.store.stats()
        self.assertEqual(entries, 1)
        # stats 不改文件：与真实目录对账
        real = [fn for fn in os.listdir(self.dir) if fn.endswith('.json')]
        self.assertEqual(len(real), entries)

    def test_clear_resets_accounting(self):
        self.store.set('a', '1')
        removed = self.store.clear()
        self.assertEqual(removed, 1)
        total, entries, _ = self.store.stats()
        self.assertEqual((total, entries), (0, 0))

    def test_scan_picks_up_preexisting_files(self):
        # 模拟历史遗留文件（未经本实例 set）：扫描后 stats 正确计数
        name = self.store._name_of('legacy')
        with open(os.path.join(self.dir, name), 'w', encoding='utf-8') as f:
            json.dump({'value': 'x', 'exp': 0}, f)
        # setUp 为隔离旧文件已执行过一次 clear，重新实例化以验证“首次扫描”
        # 能发现外部预先存在的条目。
        store = CacheStore(self.dir)
        total, entries, _ = store.stats()
        self.assertEqual(entries, 1)
        self.assertGreater(total, 0)


class TestJsLocalKvScoping(unittest.TestCase):
    """quickjs_host local KV：站点隔离 / 旧数据兜底 / 配额（C2/M-24）。"""

    def setUp(self):
        import quickjs_host as qh
        self.qh = qh
        self.tmpdir = TEST_ROOT
        qh.LOCAL_KV_DIR = self.tmpdir
        qh.LOCAL_KV_FILE = os.path.join(self.tmpdir, 'js_local-test.json')
        try:
            os.remove(qh.LOCAL_KV_FILE)
        except OSError:
            pass

    def tearDown(self):
        try:
            os.remove(self.qh.LOCAL_KV_FILE)
        except OSError:
            pass

    def test_site_isolation(self):
        set_a = self.qh._native_local_set('siteA')
        get_a = self.qh._native_local_get('siteA')
        get_b = self.qh._native_local_get('siteB')
        set_a('token', 'abc')
        self.assertEqual(get_a('token'), 'abc')
        self.assertEqual(get_b('token'), '')          # 站点 B 读不到 A 的数据

    def test_legacy_flat_key_fallback_and_migration(self):
        # 迁移前的裸键数据：scoped 读取兜底可见；set 后迁移到 scoped 并清裸键
        self.qh._local_kv_save({'legacy': 'v0'})
        get_a = self.qh._native_local_get('siteA')
        set_a = self.qh._native_local_set('siteA')
        self.assertEqual(get_a('legacy'), 'v0')
        set_a('legacy', 'v1')
        data = self.qh._local_kv_load()
        self.assertEqual(data.get('siteA' + self.qh.KV_SCOPE_SEP + 'legacy'), 'v1')
        self.assertNotIn('legacy', data)

    def test_value_quota_rejects_oversize(self):
        set_a = self.qh._native_local_set('siteA')
        get_a = self.qh._native_local_get('siteA')
        set_a('big', 'x' * (self.qh.KV_MAX_VALUE_BYTES + 1))
        self.assertEqual(get_a('big'), '')            # 超单值上限被拒

    def test_total_quota_rejects_write(self):
        set_a = self.qh._native_local_set('siteA')
        get_a = self.qh._native_local_get('siteA')
        self.qh.KV_MAX_TOTAL_BYTES = 2048             # 压低总额做测试
        try:
            set_a('k1', 'x' * 1024)
            set_a('k2', 'y' * 1024)
            set_a('k3', 'z' * 1024)                   # 超总额，整次写被拒
            self.assertEqual(get_a('k3'), '')
            self.assertEqual(get_a('k1'), 'x' * 1024)  # 已有数据不受影响
        finally:
            self.qh.KV_MAX_TOTAL_BYTES = 2 * 1024 * 1024

    def test_delete_removes_scoped_and_legacy(self):
        set_a = self.qh._native_local_set('siteA')
        del_a = self.qh._native_local_delete('siteA')
        set_a('k', 'v')
        self.qh._local_kv_save({**self.qh._local_kv_load(), 'k': 'legacy'})
        del_a('k')
        self.assertEqual(self.qh._local_kv_load(), {})


if __name__ == '__main__':
    unittest.main(verbosity=1)
