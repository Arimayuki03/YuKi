# -*- coding: utf-8 -*-
"""签名播放 URL 缓存：过期刷新、账号隔离和 single-flight。"""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

from pan.cache import SignedUrlCache, extract_expire_at, make_cache_key  # noqa: E402
from pan.models import PlayUrl  # noqa: E402


class TestPanCache(unittest.TestCase):
    def test_extracts_second_and_millisecond_expiry(self):
        now = 1_700_000_000
        self.assertEqual(extract_expire_at('https://cdn.test/a?Expires=1700000300', now=now), 1700000300)
        self.assertEqual(extract_expire_at('https://cdn.test/a?e=1700000300000', now=now), 1700000300)

    def test_key_contains_only_credential_fingerprint(self):
        key = make_cache_key('quark', {'fileId': 'fid'}, {'Cookie': 'secret-cookie'})
        self.assertNotIn('secret-cookie', key)
        self.assertNotEqual(key, make_cache_key('quark', {'fileId': 'fid'}, {'Cookie': 'other-cookie'}))

    def test_single_flight_resolves_once(self):
        cache = SignedUrlCache(refresh_skew=0, fallback_ttl=60)
        calls = {'n': 0}
        lock = threading.Lock()

        def resolve():
            with lock:
                calls['n'] += 1
            time.sleep(0.05)
            return PlayUrl('https://cdn.test/video.mp4?Expires=4102444800', file_id='fid')

        results = []
        threads = [threading.Thread(target=lambda: results.append(cache.resolve('k', resolve))) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(calls['n'], 1)
        self.assertEqual(len(results), 8)
        self.assertTrue(all(item and item.url.endswith('Expires=4102444800') for item in results))

    def test_refresh_invalidates_cached_value(self):
        cache = SignedUrlCache(refresh_skew=0, fallback_ttl=60)
        calls = {'n': 0}

        def resolve():
            calls['n'] += 1
            return PlayUrl(f'https://cdn.test/{calls["n"]}.mp4', file_id='fid')

        first = cache.resolve('k', resolve)
        cached = cache.resolve('k', resolve)
        refreshed = cache.resolve('k', resolve, refresh=True)
        self.assertEqual(first.url, cached.url)
        self.assertEqual(refreshed.url, 'https://cdn.test/2.mp4')
        self.assertEqual(calls['n'], 2)


if __name__ == '__main__':
    unittest.main()
