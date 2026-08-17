# -*- coding: utf-8 -*-
"""网盘 Cookie 加密存储回归。"""

from __future__ import annotations

import json
import os
import shutil
import sys
import unittest

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ROOT = os.environ.get('VPC_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
DATA_DIR = os.path.join(ROOT, 'pan-cookies')
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import hoststate  # noqa: E402
import pan_cookies  # noqa: E402


class TestPanCookies(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(DATA_DIR, ignore_errors=True)
        os.makedirs(DATA_DIR, exist_ok=True)
        hoststate.configure(data_dir=DATA_DIR)
        pan_cookies._cache.update({'path': '', 'mtime': 0.0, 'data': {}})

    def tearDown(self):
        shutil.rmtree(DATA_DIR, ignore_errors=True)

    def test_cookie_file_is_encrypted_and_roundtrips(self):
        value = '__pus=super-secret; __puus=another-secret'
        saved, warnings = pan_cookies.save_pan_cookies({'quark': value})
        self.assertEqual(saved['quark'], value)
        self.assertEqual(warnings, [])
        path = os.path.join(DATA_DIR, 'pan_cookies.json')
        with open(path, encoding='utf-8') as f:
            raw = f.read()
        self.assertIn('"encrypted": true', raw)
        self.assertNotIn('super-secret', raw)
        self.assertEqual(pan_cookies.load_pan_cookies()['quark'], value)

    def test_legacy_plaintext_is_migrated(self):
        path = os.path.join(DATA_DIR, 'pan_cookies.json')
        value = {'quark': '__pus=legacy-secret'}
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(value, f)
        pan_cookies._cache.update({'path': '', 'mtime': 0.0, 'data': {}})
        self.assertEqual(pan_cookies.load_pan_cookies(), value)
        with open(path, encoding='utf-8') as f:
            migrated = f.read()
        self.assertIn('"encrypted": true', migrated)

    def test_clear_also_removes_signed_url_cache(self):
        from pan.cache import signed_url_cache
        signed_url_cache.put('test', __import__('pan.models', fromlist=['PlayUrl']).PlayUrl(
            'https://cdn.test/a.mp4'))
        pan_cookies.save_pan_cookies({})
        self.assertIsNone(signed_url_cache.get('test'))


if __name__ == '__main__':
    unittest.main()
