# -*- coding: utf-8 -*-
"""夸克会话自动刷新：Set-Cookie 轮换捕获/合并落盘/保活标记 回归。"""
import os
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import go_proxy
from pan_cookies import save_pan_cookies


class Types:
    """轻量命名空间，替代 requests Cookie 对象。"""
    def __init__(self, name='', value='', domain=''):
        self.name = name
        self.value = value
        self.domain = domain


class FakeJar(list):
    def clear(self):
        del self[:]


class TestQuarkDomainFilter(unittest.TestCase):
    def test_quark_domains_accepted(self):
        self.assertTrue(go_proxy._is_quark_domain('quark.cn'))
        self.assertTrue(go_proxy._is_quark_domain('.quark.cn'))
        self.assertTrue(go_proxy._is_quark_domain('drive.quark.cn'))
        self.assertTrue(go_proxy._is_quark_domain('drive-pc.quark.cn'))
        self.assertTrue(go_proxy._is_quark_domain('video-play-c-zb.drive.quark.cn'))

    def test_foreign_domains_rejected(self):
        self.assertFalse(go_proxy._is_quark_domain('uc.cn'))
        self.assertFalse(go_proxy._is_quark_domain('quark.com'))
        self.assertFalse(go_proxy._is_quark_domain('evil-quark.cn'))
        self.assertFalse(go_proxy._is_quark_domain(''))
        self.assertFalse(go_proxy._is_quark_domain(None))


class TestCookieStringSplit(unittest.TestCase):
    def test_split_preserves_order_and_ignores_junk(self):
        pairs = go_proxy._split_cookie_string('__pus=a; __puus=b;; c; k=v; ')
        self.assertEqual(list(pairs.items()),
                         [('__pus', 'a'), ('__puus', 'b'), ('k', 'v')])

    def test_split_empty(self):
        self.assertEqual(go_proxy._split_cookie_string(''), {})
        self.assertEqual(go_proxy._split_cookie_string(None), {})


class TestRotationMerge(unittest.TestCase):
    def setUp(self):
        # 隔离：合并函数读 load_pan_cookies / 写 save_pan_cookies，
        # 节流状态每次重置；写盘走记录器不打真实加密存储。
        self.saved = []
        self.stored = {'quark': '__pus=old; __puus=old; foo=bar'}
        patcher_load = patch('pan_cookies.load_pan_cookies',
                             side_effect=lambda: dict(self.stored))
        patcher_save = patch('pan_cookies.save_pan_cookies',
                             side_effect=lambda cookies, **kw: self.saved.append((cookies, kw)))
        patcher_load.start()
        patcher_save.start()
        self.addCleanup(patcher_load.stop)
        self.addCleanup(patcher_save.stop)
        with go_proxy._ROTATE_LOCK:
            go_proxy._ROTATE_STATE.update(
                {'last_write': 0.0, 'pending': None, 'timer': None})

    def tearDown(self):
        with go_proxy._ROTATE_LOCK:
            timer = go_proxy._ROTATE_STATE.get('timer')
        if timer:
            timer.cancel()

    def _wait_persisted(self, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.saved:
                return self.saved[0]
            time.sleep(0.02)
        self.fail('rotation persist did not happen in time')

    def test_merge_updates_existing_and_appends_new(self):
        go_proxy._merge_quark_cookie_rotation(
            {'__puus': 'new', '__pus': 'old', 'extra': '1'})
        cookies, kwargs = self._wait_persisted()
        self.assertEqual(kwargs.get('clear_cache'), False)
        merged = dict(x.split('=', 1) for x in cookies['quark'].split('; '))
        self.assertEqual(merged, {'__pus': 'old', '__puus': 'new',
                                  'foo': 'bar', 'extra': '1'})
        # 保序：既有键相对顺序不变，新键追加在尾部
        order = [x.split('=', 1)[0] for x in cookies['quark'].split('; ')]
        self.assertEqual(order[:3], ['__pus', '__puus', 'foo'])

    def test_merge_no_change_skips_write(self):
        go_proxy._merge_quark_cookie_rotation({'__pus': 'old', '__puus': 'old'})
        time.sleep(0.2)
        self.assertEqual(self.saved, [])

    def test_throttle_coalesces_burst_into_one_write(self):
        go_proxy._ROTATE_STATE['last_write'] = time.time()  # 刚写过 → 节流窗口内
        go_proxy._merge_quark_cookie_rotation({'__puus': 'r1'})
        go_proxy._merge_quark_cookie_rotation({'__puus': 'r2'})
        time.sleep(0.2)
        self.assertEqual(self.saved, [])          # 窗口内不立即落盘
        with go_proxy._ROTATE_LOCK:
            pending = go_proxy._ROTATE_STATE['pending']
        self.assertIsNotNone(pending)
        self.assertEqual(pending.get('__puus'), 'r2')  # 后值覆盖前值
        go_proxy._flush_pending_rotation()
        self.assertEqual(len(self.saved), 1)
        cookies, _ = self.saved[0]
        self.assertIn('__puus=r2', cookies['quark'])
        with go_proxy._ROTATE_LOCK:
            self.assertIsNone(go_proxy._ROTATE_STATE['pending'])

    def test_other_providers_preserved_on_rotation(self):
        self.stored.update({'uc': 'uc_key=1', 'baidu': 'BDUSS=x'})
        go_proxy._merge_quark_cookie_rotation({'__puus': 'rotated'})
        cookies, _ = self._wait_persisted()
        self.assertEqual(cookies.get('uc'), 'uc_key=1')
        self.assertEqual(cookies.get('baidu'), 'BDUSS=x')
        self.assertIn('__puus=rotated', cookies['quark'])


class TestHarvestFromJar(unittest.TestCase):
    def setUp(self):
        self.harvested_calls = []
        patcher = patch.object(go_proxy, '_merge_quark_cookie_rotation',
                               side_effect=lambda h: self.harvested_calls.append(h))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fake_session = type('S', (), {})()
        self.fake_session.cookies = FakeJar([
            Types('__pus', 'v1', '.quark.cn'),
            Types('__puus', 'v2', 'drive.quark.cn'),
            Types('other', 'x', '.uc.cn'),           # 外域丢弃
            Types('empty', '', '.quark.cn'),          # 空值丢弃
            Types(None, 'v', '.quark.cn'),            # 无名丢弃
        ])
        self.original_session = go_proxy._qses
        go_proxy._qses = self.fake_session
        self.addCleanup(setattr, go_proxy, '_qses', self.original_session)

    def test_harvest_keeps_only_quark_named_pairs(self):
        harvested = go_proxy._harvest_quark_rotation()
        self.assertEqual(harvested, {'__pus': 'v1', '__puus': 'v2'})
        self.assertEqual(self.harvested_calls, [harvested])

    def test_harvest_empty_does_not_call_merge(self):
        self.fake_session.cookies.clear()
        harvested = go_proxy._harvest_quark_rotation()
        self.assertEqual(harvested, {})
        self.assertEqual(self.harvested_calls, [])


class TestSaveClearCacheFlag(unittest.TestCase):
    def setUp(self):
        import hoststate
        self._tmp = os.path.join(os.path.abspath(os.path.dirname(__file__)),
                                 '.test-tmp', 'pan-cookie-flag')
        os.makedirs(self._tmp, exist_ok=True)
        patcher = patch('hoststate.get_data_dir', return_value=self._tmp)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(hoststate.invalidate_caches if hasattr(hoststate, 'invalidate_caches') else lambda: None)

    def _clear_recorder(self):
        import pan.cache as cache_mod
        calls = []
        original = cache_mod.clear_signed_url_cache
        cache_mod.clear_signed_url_cache = lambda: calls.append(1)
        self.addCleanup(setattr, cache_mod, 'clear_signed_url_cache', original)
        return calls

    def test_default_clears_signed_url_cache(self):
        calls = self._clear_recorder()
        save_pan_cookies({'quark': '__pus=a; __puus=b'})
        self.assertEqual(len(calls), 1)

    def test_background_rotation_keeps_signed_url_cache(self):
        calls = self._clear_recorder()
        save_pan_cookies({'quark': '__pus=c; __puus=d'}, clear_cache=False)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
