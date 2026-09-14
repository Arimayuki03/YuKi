# -*- coding: utf-8 -*-
"""play_cache（RM-4 解析结果持久缓存）单元测试。

覆盖：读写往返、跨实例持久化（重启模拟）、TTL 过期、失效重解析
（invalidate）、清空、统计、空值/损坏文件健壮性。
"""
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
if os.path.dirname(HERE) not in sys.path:
    sys.path.insert(0, os.path.dirname(HERE))

import play_cache


class PlayCacheTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='yuki-test-playcache-')
        play_cache.set_dir_for_tests(self._tmp.name)

    def tearDown(self):
        play_cache.set_dir_for_tests(None)
        self._tmp.cleanup()

    def test_roundtrip(self):
        result = json.dumps({'url': 'https://cdn.example/a.mp4'})
        play_cache.store_result('site-a|flag1|ep1|[]', result)
        self.assertEqual(play_cache.get_result('site-a|flag1|ep1|[]'), result)

    def test_persists_across_restart(self):
        key = 'site-a|flag1|ep2|[]'
        result = json.dumps({'url': 'https://cdn.example/b.m3u8'})
        play_cache.store_result(key, result)
        # 模拟重启：丢弃内存单例（同目录重建），文件层仍在
        play_cache.set_dir_for_tests(self._tmp.name)
        self.assertEqual(play_cache.get_result(key), result)

    def test_ttl_expiry(self):
        key = 'site-a|flag1|ep3|[]'
        with mock.patch.object(play_cache, 'PERSIST_TTL_SECONDS', 1):
            play_cache.store_result(key, json.dumps({'url': 'https://cdn.example/c.mp4'}))
            self.assertIsNotNone(play_cache.get_result(key))
        time.sleep(1.1)
        self.assertIsNone(play_cache.get_result(key), '过期条目应返回 None')

    def test_default_ttl_is_two_hours(self):
        key = 'site-a|flag1|ep4|[]'
        play_cache.store_result(key, json.dumps({'url': 'https://cdn.example/d.mp4'}))
        name = hashlib.sha1(key.encode('utf-8')).hexdigest() + '.json'
        with open(os.path.join(self._tmp.name, name), 'r', encoding='utf-8') as f:
            data = json.load(f)
        exp = data.get('exp', 0)
        self.assertTrue(exp > time.time() + 7000, '默认 TTL 应为 2h 量级')
        self.assertTrue(exp < time.time() + 7400)

    def test_invalidate(self):
        key = 'site-a|flag1|ep5|[]'
        play_cache.store_result(key, json.dumps({'url': 'https://cdn.example/e.mp4'}))
        play_cache.invalidate(key)
        self.assertIsNone(play_cache.get_result(key))
        # 不存在的 key 失效不抛错
        play_cache.invalidate('no-such-key')

    def test_clear_all(self):
        play_cache.store_result('k1', json.dumps({'url': 'u1'}))
        play_cache.store_result('k2', json.dumps({'url': 'u2'}))
        removed = play_cache.clear_all()
        self.assertEqual(removed, 2)
        self.assertIsNone(play_cache.get_result('k1'))
        self.assertIsNone(play_cache.get_result('k2'))

    def test_stats(self):
        play_cache.store_result('k1', json.dumps({'url': 'u1'}))
        play_cache.store_result('k2', json.dumps({'url': 'u2'}))
        total, entries, expired = play_cache.stats()
        self.assertGreater(total, 0)
        self.assertEqual(entries, 2)
        self.assertEqual(expired, 0)

    def test_empty_inputs_ignored(self):
        play_cache.store_result('k1', '')
        play_cache.store_result('', json.dumps({'url': 'u'}))
        self.assertIsNone(play_cache.get_result('k1'))
        # 空值读写均不抛错

    def test_corrupt_file_returns_none(self):
        key = 'site-a|flag1|bad|[]'
        name = hashlib.sha1(key.encode('utf-8')).hexdigest() + '.json'
        with open(os.path.join(self._tmp.name, name), 'w', encoding='utf-8') as f:
            f.write('{not-json')
        self.assertIsNone(play_cache.get_result(key), '损坏文件应安全降级为未命中')

    def test_overwrite_refreshes_value(self):
        key = 'site-a|flag1|ep6|[]'
        play_cache.store_result(key, json.dumps({'url': 'old'}))
        play_cache.store_result(key, json.dumps({'url': 'new'}))
        self.assertEqual(play_cache.get_result(key), json.dumps({'url': 'new'}))


if __name__ == '__main__':
    unittest.main(verbosity=1)
