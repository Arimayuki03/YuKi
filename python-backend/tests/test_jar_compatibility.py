# -*- coding: utf-8 -*-
"""JAR/DEX 兼容性分级只做诊断，不把高风险能力误报为可用。"""

from __future__ import annotations

import os
import sys
import zipfile
import unittest

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
FIXTURE = os.path.join(ROOT, 'compat-fixture.jar')
if BASE not in sys.path:
    sys.path.insert(0, BASE)

from jar_bridge import classify_jar_compatibility  # noqa: E402


class TestJarCompatibility(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.makedirs(ROOT, exist_ok=True)
        with zipfile.ZipFile(FIXTURE, 'w') as archive:
            archive.writestr('classes.dex', b'dex\n035')
            archive.writestr('com/example/Drm.class', b'android/webkit/WebView widevine drm')
            archive.writestr('lib/arm64-v8a/libdemo.so', b'')

    @classmethod
    def tearDownClass(cls):
        try:
            os.remove(FIXTURE)
        except OSError:
            pass

    def test_reports_highest_risk_level_and_signals(self):
        report = classify_jar_compatibility(FIXTURE)
        self.assertEqual(report['level'], 'L4')
        self.assertTrue(report['hasDex'])
        self.assertTrue(report['hasNative'])
        self.assertIn('drm-or-device-license', report['signals'])


if __name__ == '__main__':
    unittest.main()
