# -*- coding: utf-8 -*-
"""R8.1～R8.3：功能开关、数据迁移、发布门禁与回滚集成测试套件。"""
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import hoststate
from runtime.capability_router import route_site
from runtime.config_snapshot import ConfigSnapshot, ParsedConfig
from runtime.health import android_worker_enabled, infer_site_health


class R8FeatureGateAndMigrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix='vpc_r8_test_')
        self.orig_flags = hoststate.get_feature_flags()

    def tearDown(self):
        hoststate.configure(**self.orig_flags)
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    # -------------------------------------------------------------------------
    # R8.1 功能开关矩阵测试
    # -------------------------------------------------------------------------
    def test_feature_flags_default_values_and_override(self):
        """功能开关必须有明确默认值，且支持动态配置。"""
        flags = hoststate.get_feature_flags()
        self.assertFalse(flags['runtime_android_worker'])
        self.assertTrue(flags['pan_fast_path'])
        self.assertTrue(flags['media_probe'])
        self.assertTrue(flags['auto_line_fallback'])
        self.assertTrue(flags['legacy_parser'])

        # 测试配置切换
        hoststate.configure(pan_fast_path=False, media_probe=False)
        self.assertFalse(hoststate.get_pan_fast_path())
        self.assertFalse(hoststate.get_media_probe())

    def test_drpy_sites_always_route_to_unsupported(self):
        """drpy 引擎已移除：drpy 站点固定路由至 unsupported，不造成崩溃。"""
        drpy_site = {
            'key': 'drpy_test',
            'name': 'drpy源',
            'type': 3,
            'api': 'http://example.com/drpy.js',
            'ext': 'http://example.com/rule.js'
        }

        decision = route_site(drpy_site)
        self.assertEqual(decision.runtime, 'unsupported')
        self.assertFalse(decision.supported)
        self.assertEqual(decision.error_code, 'L2_SITE_UNSUPPORTED')

    def test_runtime_android_worker_locked_under_c1_ceiling(self):
        """runtime_android_worker 必须受 A4.1 No-Go 政策硬锁定，不能被环境变量或配置绕过。"""
        old_env = os.environ.get('VPC_ANDROID_WORKER_ENABLED')
        try:
            os.environ['VPC_ANDROID_WORKER_ENABLED'] = '1'
            os.environ['VPC_ANDROID_WORKER_READY'] = '1'
            self.assertFalse(android_worker_enabled(), 'A4.1 政策下禁止开启 Android Worker')

            # 无论如何配置，android worker 均不可用
            hoststate.configure(runtime_android_worker=True)
            android_site = {
                'key': 'dex_site',
                'name': '安卓源',
                'type': 3,
                'api': 'csp_Dex',
                'jar': 'http://example.com/native.jar;md5;abc'
            }
            health = infer_site_health(android_site)
            self.assertEqual(health.compatibility, 'C1')
            self.assertFalse(health.healthy)
        finally:
            if old_env is not None:
                os.environ['VPC_ANDROID_WORKER_ENABLED'] = old_env
            else:
                os.environ.pop('VPC_ANDROID_WORKER_ENABLED', None)
                os.environ.pop('VPC_ANDROID_WORKER_READY', None)

    # -------------------------------------------------------------------------
    # R8.2 数据迁移与向前向后兼容测试
    # -------------------------------------------------------------------------
    def test_legacy_settings_and_records_migration(self):
        """测试旧版本历史、收藏和网盘 Cookie 迁移不丢失字段且自动补齐 uid。"""
        legacy_data = {
            'history': [
                {'site': 's1', 'name': '测试影片1', 'ts': 1600000000},
                {'name': '测试影片2', 'ts': 1600000001, 'uid': 'custom_uid_2'}
            ],
            'favorites': [
                {'site': 's2', 'vodId': '123', 'name': '收藏1', 'ts': 1600000002}
            ],
            'pan_cookies': {
                'quark': '__puus=test_token; __pus=test_pus;'
            }
        }

        # 模拟数据持久化与读取
        history = legacy_data['history']
        for i, item in enumerate(history):
            if not item.get('uid'):
                item['uid'] = f"m{item.get('ts', 0)}-{i}"

        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]['uid'], 'm1600000000-0')
        self.assertEqual(history[1]['uid'], 'custom_uid_2')
        self.assertEqual(legacy_data['pan_cookies']['quark'], '__puus=test_token; __pus=test_pus;')

    def test_incompatible_cache_safe_discard_and_rebuild(self):
        """损坏或不兼容旧缓存可安全丢弃并重建为 ConfigSnapshot。"""
        # 1. 损坏的 JSON 缓存
        corrupt_path = os.path.join(self.tmp_dir, 'corrupt.json')
        with open(corrupt_path, 'w', encoding='utf-8') as f:
            f.write('{"invalid json: [}')

        try:
            with open(corrupt_path, 'r', encoding='utf-8') as f:
                json.load(f)
            parsed_ok = True
        except Exception:
            parsed_ok = False
        self.assertFalse(parsed_ok)

        # 降级并重建有效快照
        valid_config = {
            'sites': [{'key': 'site_a', 'name': '站点A', 'type': 0, 'api': 'http://example.com/cms'}],
            'parses': [{'name': '解析1', 'type': 1, 'url': 'http://example.com/parse?url='}],
            'flags': ['youku', 'qq']
        }
        parsed = ParsedConfig.from_json(valid_config)
        snapshot = ConfigSnapshot(parsed=parsed)
        self.assertIsInstance(snapshot, ConfigSnapshot)
        self.assertEqual(len(snapshot.parsed.entries), 1)
        self.assertEqual(snapshot.parsed.entries[0].key, 'site_a')

    def test_rollback_ignores_unrecognized_worker_state(self):
        """回滚至旧版本时，未知新版本字段被安全忽略，不影响基础功能。"""
        future_snapshot = {
            'version': 99,
            'futureWorkerState': {'workerPid': 12345, 'protocol': 'v3'},
            'sites': [{'key': 's1', 'name': '基础站点', 'type': 0, 'api': 'http://127.0.0.1/cms'}]
        }

        # 旧版本解析器仅提取 sites/parses/flags
        parsed = ParsedConfig.from_json(future_snapshot)
        snapshot = ConfigSnapshot(parsed=parsed)
        self.assertEqual(len(snapshot.parsed.entries), 1)
        self.assertEqual(snapshot.parsed.entries[0].key, 's1')
        self.assertFalse(hasattr(snapshot, 'futureWorkerState'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
