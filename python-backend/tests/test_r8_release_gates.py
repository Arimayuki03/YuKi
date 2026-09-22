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
import pan_cookies
from runtime.capability_router import route_site
from runtime.config_snapshot import ConfigSnapshot, ParsedConfig
from runtime.health import android_worker_enabled, infer_site_health


class R8FeatureGateAndMigrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix='yuki_r8_test_')
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
        old_env = os.environ.get('YUKI_ANDROID_WORKER_ENABLED')
        try:
            os.environ['YUKI_ANDROID_WORKER_ENABLED'] = '1'
            os.environ['YUKI_ANDROID_WORKER_READY'] = '1'
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
                os.environ['YUKI_ANDROID_WORKER_ENABLED'] = old_env
            else:
                os.environ.pop('YUKI_ANDROID_WORKER_ENABLED', None)
                os.environ.pop('YUKI_ANDROID_WORKER_READY', None)

    # -------------------------------------------------------------------------
    # R8.2 数据迁移与向前向后兼容测试
    # -------------------------------------------------------------------------
    def test_pan_cookie_migration_preserves_fields(self):
        """旧版明文 pan_cookies.json 迁移到加密格式：字段不丢、uid 语义等价
        （拼写、去空白）、磁盘上不再有明文。走真实 load_pan_cookies()
        迁移路径，不允许测试自造数据自证。"""
        from pan_cookies import load_pan_cookies  # noqa: PLC0415

        legacy = {
            'quark': '  __puus=migrate-token; __pus=migrate_pus  ',
            'uc': '__pus=uc-token;'
        }
        path = os.path.join(self.tmp_dir, 'pan_cookies.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(legacy, f)
        hoststate.configure(data_dir=self.tmp_dir)
        pan_cookies._cache.update({'path': '', 'mtime': 0.0, 'data': {}})
        try:
            loaded = load_pan_cookies()
            # 字段不丢；值被 strip（旧实现保留原串的等价规范化）
            self.assertEqual(loaded.get('quark'),
                             '__puus=migrate-token; __pus=migrate_pus')
            self.assertEqual(loaded.get('uc'), '__pus=uc-token;')
            # 迁移后磁盘上必须是加密形态，明文 cookie 不再可读
            with open(path, encoding='utf-8') as f:
                on_disk = f.read()
            self.assertIn('"encrypted"', on_disk)
            self.assertNotIn('migrate-token', on_disk)
            self.assertNotIn('uc-token', on_disk)
        finally:
            pan_cookies._cache.update({'path': '', 'mtime': 0.0, 'data': {}})

    def test_legacy_records_uid_backfill_contract(self):
        """历史记录 uid 回填契约：缺 uid 的旧记录按 ts 序补 m<ts>-<i>，
        已有 uid 不覆盖。旧测试直接在测试体内自造+自证（假绿，P3-19-②）。
        真实实现在渲染层 src/renderer/js/records.js 的 ensureRecUids——这里经
        QuickJS 加载真实源码文件并执行真实函数，对同一契约断言。"""
        sys.path.insert(0, os.path.join(BASE, 'js-engine'))
        from quickjs_host import JsEngine  # noqa: PLC0415

        records_js = os.path.join(
            BASE, '..', 'src', 'renderer', 'js', 'records.js')
        self.assertTrue(os.path.isfile(records_js), records_js)
        with open(records_js, encoding='utf-8') as f:
            source = f.read()
        engine = JsEngine(site_key='r8_uid_backfill')
        try:
            # records.js 顶层只声明函数/常量，无 DOM/window 依赖，可直接 eval；
            # 末尾把内部函数挂到 globalThis 供脚本取用。
            engine.ctx.eval(source + '\n;globalThis.__ensureRecUids = ensureRecUids;')
            hist_json = json.dumps([
                {'site': 's1', 'name': '测试影片1', 'ts': 1600000000},
                {'name': '测试影片2', 'ts': 1600000001, 'uid': 'custom_uid_2'},
            ])
            got = json.loads(engine.ctx.eval(
                '(function(){var h=' + hist_json + ';'
                'var changed=__ensureRecUids(h);'
                'return JSON.stringify([changed, h]);})()'))
        finally:
            engine.destroy()
        changed, history = got
        self.assertTrue(changed, '存在缺 uid 记录时必须报告需要持久化')
        # 缺 uid 的记录按 m{ts}-{index} 确定性回填（与渲染层兼容约定一致）
        self.assertEqual(history[0]['uid'], 'm1600000000-0')
        # 已有 uid 原样保留，不被覆盖
        self.assertEqual(history[1]['uid'], 'custom_uid_2')

    def test_incompatible_cache_safe_discard_and_rebuild(self):
        """损坏或不兼容旧缓存可安全丢弃并重建。走真实实现
        runtime/config_cache.ConfigRepositoryCache（last.json 完整性校验缓存）：
        损坏 JSON / 版本不匹配 / 哈希不符都必须优雅降级返回 None（可重建），
        写入的合法载荷必须能原样读回。"""
        from runtime.config_cache import ConfigRepositoryCache, CACHE_VERSION  # noqa: PLC0415

        cache_dir = os.path.join(self.tmp_dir, 'config-cache')
        store = ConfigRepositoryCache(cache_dir)
        self.assertIsNone(store.load(), '空目录 load 必须返回 None')
        os.makedirs(cache_dir, exist_ok=True)  # 手工落脏数据需要目录先存在

        # 1. 损坏的 JSON 缓存：load 不得抛异常，降级为 None（可安全重建）
        with open(store.path, 'w', encoding='utf-8') as f:
            f.write('{"invalid json: [}')
        self.assertIsNone(store.load(), '损坏 JSON 必须降级为 None')

        # 2. 未来版本缓存（version 不匹配）同样整份丢弃
        with open(store.path, 'w', encoding='utf-8') as f:
            json.dump({'version': CACHE_VERSION + 99, 'text': 'future'}, f)
        self.assertIsNone(store.load(), '未知版本必须整份丢弃')

        # 3. 正文哈希与内容不符（被篡改/截断）也不可信
        payload = {
            'version': CACHE_VERSION, 'sourceUrl': 'https://fixture.invalid/tv.json',
            'text': '真实正文', 'contentHash': '0' * 64,
        }
        with open(store.path, 'w', encoding='utf-8') as f:
            json.dump(payload, f)
        self.assertIsNone(store.load(), 'contentHash 不符必须拒绝')

        # 4. 合法写入（save 走真实的 tmp+fsync+replace 落盘链路）必须原样读回
        self.assertTrue(store.save('https://fixture.invalid/tv.json', '真实正文'))
        loaded = store.load()
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.text, '真实正文')
        self.assertEqual(loaded.source_url, 'https://fixture.invalid/tv.json')

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
