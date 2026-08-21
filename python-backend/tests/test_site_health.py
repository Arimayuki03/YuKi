# -*- coding: utf-8 -*-
"""G0.3 configured/built/initialized/healthy 与能力模型测试。"""
import os
import sys
import unittest
import zipfile
from unittest import mock

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ROOT = os.environ.get('VPC_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
if BASE not in sys.path:
    sys.path.insert(0, BASE)

from jar_bridge import JarBridge  # noqa: E402
from config import ConfigManager  # noqa: E402
from runner import Runner  # noqa: E402
from site_manager import Site, SiteManager  # noqa: E402
from runtime.errors import RuntimeError  # noqa: E402
from runtime.health import SiteHealth, infer_site_health  # noqa: E402


class SiteHealthTest(unittest.TestCase):
    def test_config_summary_and_diagnostics_separate_all_four_counts(self):
        class Spider:
            def init(self, _ext=''):
                return None

            def getName(self):
                return 'fixture'

            def destroy(self):
                return None

        class Manager(ConfigManager):
            def _build_site(self, item, _base='', _jar=''):
                if item['key'] == 'broken':
                    raise RuntimeError('L3_RUNTIME_INIT_FAILED', site_key='broken',
                                       runtime='python', details={'built': True})
                site = Site(item['key'], item['api'])
                site.runner = Runner(Spider())
                site.health = infer_site_health(item)
                site.health.mark_built().mark_initialized().mark_healthy()
                return site

        sites = SiteManager()
        manager = Manager(sites)
        prepared = manager._prepare({'sites': [
            {'key': 'ok', 'type': 3, 'api': 'inline.py'},
            {'key': 'broken', 'type': 3, 'api': 'inline.py'},
        ]}, '(inline)')
        summary = prepared['summary']
        self.assertEqual((summary['configured'], summary['built'],
                          summary['initialized'], summary['healthy']), (2, 2, 1, 1))
        manager._apply(prepared)
        state = manager.state()
        self.assertEqual(len(state['sites']), 1, '内容 UI 只获得 healthy 站点')
        self.assertEqual(len(state['diagnostics']), 2, '诊断仍保留不可用站点')

    def test_unbuilt_configured_entry_stays_in_diagnostics(self):
        class Manager(ConfigManager):
            def _build_site(self, _item, _base='', _jar=''):
                return None

        manager = Manager(SiteManager())
        prepared = manager._prepare({'sites': [
            {'key': 'unbuilt', 'type': 3, 'api': 'missing.py'},
        ]}, '(inline)')
        summary = prepared['summary']
        self.assertEqual(summary['configured'], 1)
        self.assertEqual(summary['built'], 0)
        self.assertEqual(summary['initialized'], 0)
        self.assertEqual(summary['healthy'], 0)
        self.assertEqual(len(prepared['diagnostics']), 1)
        self.assertEqual(prepared['diagnostics'][0].last_error.code,
                         'L2_SITE_BUILD_FAILED')
        manager._apply(prepared)
        state = manager.state()
        self.assertEqual(state['summary']['configured'], 1)
        self.assertEqual(state['summary']['healthy'], 0)
        self.assertEqual(state['diagnostics'][0]['siteKey'], 'unbuilt')

    def test_normal_lifecycle_and_capabilities(self):
        health = infer_site_health({'key': 'ok', 'type': 3, 'api': 'inline.py'})
        health.mark_built().mark_initialized().mark_healthy()
        result = health.to_dict()
        self.assertTrue(all(result[key] for key in ('configured', 'built', 'initialized', 'healthy')))
        self.assertEqual(result['runtime'], 'python')
        self.assertIn('player', result['capabilities'])

    def test_direct_plugin_registration_uses_health_lifecycle(self):
        class Spider:
            def init(self, _ext=''):
                return None

            def getName(self):
                return 'direct'

            def destroy(self):
                return None

        manager = SiteManager()
        site = Site('direct', 'inline.py')
        manager._register(site, Spider())
        self.assertTrue(site.health.healthy)
        self.assertEqual(manager.diagnostics[0].site_key, 'direct')

    def test_exception_keeps_built_but_not_healthy(self):
        health = SiteHealth('broken', runtime='js', compatibility='C1').mark_built()
        health.record_failure(RuntimeError('L3_RUNTIME_INIT_FAILED', site_key='broken'))
        self.assertTrue(health.built)
        self.assertFalse(health.initialized)
        self.assertFalse(health.healthy)
        self.assertEqual(health.state, 'unavailable')

    def test_timeout_is_distinct_health_state(self):
        health = SiteHealth('slow', runtime='python').mark_built().mark_initialized()
        health.record_failure(RuntimeError('L3_RUNTIME_TIMEOUT', site_key='slow'))
        self.assertEqual(health.state, 'timeout')
        self.assertFalse(health.healthy)

    def test_cancel_is_distinct_health_state(self):
        health = SiteHealth('cancel', runtime='python').mark_built().mark_initialized()
        health.record_failure(RuntimeError('L3_RUNTIME_CANCELLED', site_key='cancel'))
        self.assertEqual(health.state, 'cancelled')
        self.assertFalse(health.healthy)

    def test_dex_native_jar_uses_jvm_fallback(self):
        os.makedirs(ROOT, exist_ok=True)
        path = os.path.join(ROOT, 'g0-android-fixture.jar')
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('classes.dex', b'dex\n035 android/content/Context')
            archive.writestr('lib/arm64-v8a/libfixture.so', b'fixture')
        try:
            JarBridge._require_available_runtime(path, 'android-site', portable_only=True)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
    def test_android_callback_cannot_resurrect_health_without_worker(self):
        health = SiteHealth('android-late', runtime='android', compatibility='C2')
        health.mark_built().mark_initialized()
        health.record_success('home')
        self.assertFalse(health.healthy)
        self.assertEqual(health.state, 'requires_android')
        self.assertEqual(health.last_error.code, 'L2_SITE_REQUIRES_ANDROID')

    def test_config_keeps_requires_android_code_instead_of_wrapping_as_jar_failure(self):
        manager = ConfigManager(SiteManager())
        required = RuntimeError(
            'L2_SITE_REQUIRES_ANDROID', site_key='android-site', runtime='android')
        with mock.patch('java_probe.find_java', return_value='java'), \
                mock.patch('jar_bridge.JarBridge.download_jar', side_effect=required):
            with self.assertRaises(RuntimeError) as caught:
                manager._build_site({
                    'key': 'android-site', 'name': 'Android', 'type': 3,
                    'api': 'csp_Android', 'jar': 'https://fixture.invalid/android.jar',
                })
        self.assertEqual(caught.exception.code, 'L2_SITE_REQUIRES_ANDROID')
        self.assertEqual(caught.exception.runtime, 'android')


if __name__ == '__main__':
    unittest.main(verbosity=2)
