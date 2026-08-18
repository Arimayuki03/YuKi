# -*- coding: utf-8 -*-
"""C2.4 Capability Router 测试：R1–R6 判定顺序与「不猜、不降级」。

四类路径：正常（每条规则命中预期运行时）、异常（不支持给稳定错误码而非猜测）、
超时（JAR 分级不可读时不静默当成可跑）、取消（取消不改变路由结论的确定性）。

核心不变量：路由是**纯函数**。同一条目在诊断页（`infer_site_health`）和装配路径
（`config._build_site`）上必须得到同一个结论——两边规则各写一份正是本模块要消除的
缺陷，因此这里专门断言两边一致，以及路由与加载器对 Android JAR 的判据完全相同。
"""
import os
import sys
import threading
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
for _path in (BASE, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from jar_bridge import JarBridge, classify_jar_compatibility  # noqa: E402
from runtime.capability_router import (  # noqa: E402
    ANDROID_ONLY_SIGNALS, COMPATIBILITY, WORKERS, capabilities_for, is_drpy,
    looks_like_jar, refine_with_jar, route_site)
from runtime.errors import RuntimeError as RuntimeContractError  # noqa: E402
from runtime.health import android_worker_enabled, infer_site_health  # noqa: E402

TEST_ROOT = os.environ.get('VPC_TEST_ROOT') or os.path.join(BASE, '.test-runtime')


def site(**kw):
    data = {'key': kw.pop('key', 'k'), 'type': kw.pop('type', 3),
            'api': kw.pop('api', 'https://fixture.invalid/x')}
    data.update(kw)
    return data


class RouteOrderTest(unittest.TestCase):
    """R1 → R6 的判定顺序本身就是契约，顺序变了行为就变了。"""

    # ------------------------------------------------------------ R1 CMS

    def test_r1_cms_json_and_xml(self):
        for stype in (0, 1):
            got = route_site(site(type=stype, api='https://fixture.invalid/provide/vod/'))
            self.assertEqual((got.runtime, got.worker, got.rule),
                             ('cms', 'cms', 'R1-cms'), stype)
            self.assertEqual(got.compatibility, 'C1')
            self.assertTrue(got.supported)
            self.assertFalse(got.needs_jar)

    def test_r1_wins_over_script_suffix(self):
        """type=0/1 是 HTTP 接口契约；即使地址长得像脚本也不改判。"""
        got = route_site(site(type=1, api='https://fixture.invalid/api.py'))
        self.assertEqual(got.rule, 'R1-cms')
        self.assertEqual(got.runtime, 'cms')

    def test_r1_requires_http_api(self):
        got = route_site(site(type=1, api='csp_NotAnHttpApi'))
        self.assertEqual(got.error_code, 'L2_SITE_INVALID')
        self.assertEqual(got.rule, 'R1-cms')
        self.assertFalse(got.supported)

    # --------------------------------------------------------- R2 Python

    def test_r2_python_by_suffix(self):
        for api in ('https://fixture.invalid/py/site.py',
                    'https://fixture.invalid/py/site.py?v=2',
                    'https://fixture.invalid/py/site.py.txt'):
            got = route_site(site(type=3, api=api))
            self.assertEqual((got.runtime, got.worker), ('python', 'python'), api)
            self.assertEqual(got.rule, 'R2-python', api)

    def test_r2_beats_type4_because_suffix_is_more_specific(self):
        """R2 在 R3 之前：`.py` 的实体是 Python 源，type 只是声明。"""
        got = route_site(site(type=4, api='https://fixture.invalid/x/site.py'))
        self.assertEqual(got.runtime, 'python')
        self.assertEqual(got.rule, 'R2-python')

    def test_r2_covers_type3_without_suffix(self):
        got = route_site(site(type=3, api='https://fixture.invalid/spider/inline'))
        self.assertEqual(got.runtime, 'python')
        self.assertEqual(got.rule, 'R2-python')

    # ----------------------------------------------------- R3 QuickJS/drpy

    def test_r3_quickjs_by_type_and_by_suffix(self):
        for entry in (site(type=4, api='https://fixture.invalid/js/site.js'),
                      site(type=4, api='https://fixture.invalid/js/opaque'),
                      site(type=3, api='https://fixture.invalid/js/site.js')):
            got = route_site(entry)
            self.assertEqual((got.runtime, got.worker), ('js', 'quickjs'), entry['api'])
            self.assertEqual(got.rule, 'R3-quickjs', entry['api'])

    def test_json_is_not_misread_as_js(self):
        """FongMi 用 `api.contains(".js")`，`config.json` 会被误判成 JS。

        这里按最后一段的后缀判定，所以 `.json` 不进 R3；`.js.txt` 这类真伪装仍进。
        """
        got = route_site(site(type=3, api='https://fixture.invalid/sub/config.json'))
        self.assertNotEqual(got.runtime, 'js')
        self.assertEqual(got.rule, 'R2-python')
        disguised = route_site(site(type=3, api='https://fixture.invalid/a/site.js.txt'))
        self.assertEqual(disguised.runtime, 'js')

    def test_drpy_is_its_own_class_not_broken_js(self):
        """drpy 依赖 pdfa/pdfh/pdft 等宿主全局，由独立 Node Worker (C1) 承载。"""
        for entry in (site(type=4, api='https://fixture.invalid/drpy2.min.js'),
                      site(type=3, api='https://fixture.invalid/lib/dr_py/index.js'),
                      site(type=4, api='https://fixture.invalid/x.js',
                           ext='https://fixture.invalid/drpy/rule.js')):
            got = route_site(entry, ext=entry.get('ext', ''))
            self.assertEqual(got.runtime, 'drpy', entry['api'])
            self.assertEqual(got.rule, 'R3-drpy', entry['api'])
            self.assertEqual(got.error_code, '', entry['api'])
            self.assertEqual(got.worker, 'drpy', 'drpy 由独立 Node Worker 承载')
            self.assertEqual(got.compatibility, 'C1')
            self.assertTrue(got.supported)

    def test_drpy_detection_does_not_fire_on_unrelated_words(self):
        for api in ('https://fixture.invalid/js/predrive.js',
                    'https://fixture.invalid/js/andropy.js'):
            self.assertFalse(is_drpy(api), api)

    # ------------------------------------------------------------ R4/R5

    def test_r4_jar_needs_byte_level_classification_first(self):
        for api in ('csp_Fixture', 'https://fixture.invalid/jar/site.jar'):
            got = route_site(site(type=3, api=api))
            self.assertEqual(got.runtime, 'jar', api)
            self.assertEqual(got.rule, 'R4-jvm-jar', api)
            self.assertTrue(got.needs_jar, api)
            self.assertTrue(looks_like_jar(api), api)

    # --------------------------------------------------------- R6 兜底

    def test_r6_unknown_type_is_unsupported_without_guessing(self):
        got = route_site(site(type=99, api='https://fixture.invalid/x'))
        self.assertEqual(got.runtime, 'unsupported')
        self.assertEqual(got.rule, 'R6-unsupported')
        self.assertEqual(got.error_code, 'L2_SITE_UNSUPPORTED')
        self.assertEqual(got.worker, '')
        self.assertNotIn(got.runtime, ('cms', 'js', 'python'),
                         '未知 type 不得被猜成任何已知运行时')

    def test_r6_invalid_type_and_missing_api(self):
        self.assertEqual(route_site(site(type='abc')).error_code, 'L2_SITE_INVALID')
        self.assertEqual(route_site(site(type=None)).runtime, 'cms',
                         'type 缺省按 FongMi 取 0 → CMS')
        self.assertEqual(route_site({'key': 'k', 'type': 3, 'api': ''}).error_code,
                         'L2_SITE_INVALID')

    def test_worker_and_compatibility_tables_cover_every_runtime(self):
        self.assertEqual(set(WORKERS), set(COMPATIBILITY))
        for runtime, worker in WORKERS.items():
            if COMPATIBILITY[runtime] == 'C0':
                self.assertEqual(worker, '', runtime)
            else:
                self.assertTrue(worker, runtime)

    def test_routing_is_pure_and_order_independent(self):
        entries = [site(key='a', type=1, api='https://fixture.invalid/a'),
                   site(key='b', type=4, api='https://fixture.invalid/b.js'),
                   site(key='c', type=3, api='csp_C'),
                   site(key='d', type=77, api='https://fixture.invalid/d')]
        first = [route_site(e).to_dict() for e in entries]
        second = [route_site(e).to_dict() for e in reversed(entries)][::-1]
        self.assertEqual(first, second, '路由必须是纯函数：与调用顺序无关')


class RefineWithJarTest(unittest.TestCase):
    """R4 → R5：拿到字节分级后才知道是 portable JVM 还是 Android-only。"""

    def setUp(self):
        self.base = route_site(site(key='jarred', type=3, api='csp_Fixture'))
        self.assertTrue(self.base.needs_jar)

    def test_portable_jar_stays_on_r4(self):
        got = refine_with_jar(self.base, {'level': 'L0', 'signals': [],
                                          'hasDex': False, 'hasNative': False},
                              android_enabled=False)
        self.assertEqual((got.runtime, got.rule), ('jar', 'R4-jvm-jar'))
        self.assertEqual(got.error_code, '')
        self.assertTrue(got.supported)
        self.assertEqual(got.jar_level, 'L0')

    def test_dex_native_and_android_signals_all_land_on_r5(self):
        cases = [
            {'level': 'L1', 'signals': ['dex'], 'hasDex': True, 'hasNative': False},
            {'level': 'L3', 'signals': ['native-library'], 'hasDex': False,
             'hasNative': True},
            {'level': 'L2', 'signals': ['android-ui-or-webview'], 'hasDex': False,
             'hasNative': False},
            {'level': 'L4', 'signals': ['drm-or-device-license'], 'hasDex': False,
             'hasNative': False},
            # 关键回归：只有 android-api 信号、level 仍是 L1、既无 dex 也无 native。
            # 这类 JAR 曾被路由判为「portable」而加载器判为「需要 Android」。
            {'level': 'L1', 'signals': ['android-api'], 'hasDex': False,
             'hasNative': False},
        ]
        for report in cases:
            got = refine_with_jar(self.base, report, android_enabled=False)
            self.assertEqual(got.runtime, 'android', report)
            self.assertEqual(got.rule, 'R5-android', report)
            self.assertEqual(got.compatibility, 'C2', report)
            self.assertEqual(got.error_code, 'L2_SITE_REQUIRES_ANDROID', report)
            self.assertNotEqual(got.rule, 'R4-jvm-jar',
                               '已知 Android-only 的 JAR 绝不回落普通 JVM')

    def test_no_go_policy_overrides_a_simulated_ready_worker(self):
        got = refine_with_jar(self.base,
                              {'level': 'L1', 'signals': ['dex'], 'hasDex': True,
                               'hasNative': False},
                              android_enabled=True)
        self.assertEqual((got.runtime, got.rule), ('android', 'R5-android'))
        self.assertEqual(got.error_code, 'L2_SITE_REQUIRES_ANDROID')
        self.assertFalse(got.supported)
        self.assertFalse(got.details.get('androidWorkerEnabled'))
        self.assertTrue(got.details.get('androidWorkerHandshake'))
        self.assertEqual(got.details.get('supportCeiling'), 'C1')
        self.assertEqual(got.details.get('androidWorkerDecision'), 'NO_GO')

    def test_non_jar_decision_is_returned_untouched(self):
        cms = route_site(site(type=1, api='https://fixture.invalid/a'))
        self.assertIs(refine_with_jar(cms, {'level': 'L4', 'hasDex': True}), cms)
        self.assertIsNone(refine_with_jar(None, {'level': 'L0'}))

    def test_unreadable_report_is_recorded_not_laundered_into_l0(self):
        """分级读不出来（损坏/被占用）时，报告必须如实说「未知」。

        `config._load_jar_runner` 在分级抛错时写入 `level='L?'` +
        `signals=['classify-failed']`。没有 Android 信号仍走 R4（此时 JVM 里能不能
        找到类要到调用期才知道，那是 L3），但分级结论不能被洗成干净的 L0——诊断页
        必须能区分「确认可移植」和「没看清」。
        """
        got = refine_with_jar(self.base,
                              {'level': 'L?', 'signals': ['classify-failed'],
                               'hasDex': False, 'hasNative': False, 'error': 'boom'},
                              android_enabled=False)
        self.assertEqual(got.rule, 'R4-jvm-jar')
        self.assertEqual(got.jar_level, 'L?')
        self.assertNotEqual(got.jar_level, 'L0', '没看清不能当成确认可移植')
        self.assertIn('classify-failed', got.jar_signals)


class RouterMatchesLoaderTest(unittest.TestCase):
    """路由与真实加载器必须用同一判据；两边漂移就会出现「说能跑却跑不起来」。"""

    def test_android_signal_sets_are_identical(self):
        loader_signals = {'android-api', 'android-ui-or-webview', 'native-library',
                          'drm-or-device-license'}
        self.assertEqual(set(ANDROID_ONLY_SIGNALS), loader_signals,
                         '与 jar_bridge._require_available_runtime 的判据必须完全一致')

    def test_real_android_jar_is_rejected_by_both_paths(self):
        os.makedirs(TEST_ROOT, exist_ok=True)
        path = os.path.join(TEST_ROOT, 'c24-android-fixture.jar')
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('classes.dex', b'dex\n035 android/content/Context')
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        report = classify_jar_compatibility(path)
        self.assertTrue(report['hasDex'])

        saved = {k: os.environ.pop(k, None)
                 for k in ('VPC_ANDROID_WORKER_ENABLED', 'VPC_ANDROID_WORKER_READY')}
        try:
            self.assertFalse(android_worker_enabled())
            decision = refine_with_jar(
                route_site(site(key='android-site', type=3, api='csp_Android')), report)
            self.assertEqual(decision.error_code, 'L2_SITE_REQUIRES_ANDROID')
            with self.assertRaises(RuntimeContractError) as caught:
                JarBridge._require_available_runtime(path, 'android-site',
                                                     portable_only=True)
            self.assertEqual(caught.exception.code, decision.error_code,
                             '加载器与路由必须给出同一个错误码')
        finally:
            for key, value in saved.items():
                if value is not None:
                    os.environ[key] = value

    def test_no_go_policy_cannot_be_enabled_by_handshake_flags(self):
        saved = {k: os.environ.get(k)
                 for k in ('VPC_ANDROID_WORKER_ENABLED', 'VPC_ANDROID_WORKER_READY')}

        def restore():
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        self.addCleanup(restore)
        for enabled, ready, expected in (('1', None, False), (None, '1', False),
                                         ('1', '1', False), ('0', '1', False)):
            for key, value in (('VPC_ANDROID_WORKER_ENABLED', enabled),
                               ('VPC_ANDROID_WORKER_READY', ready)):
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            self.assertEqual(android_worker_enabled(), expected, (enabled, ready))


class HealthAgreesWithRouterTest(unittest.TestCase):
    """诊断页与装配路径不能各说一套。"""

    ENTRIES = [
        site(key='cms', type=1, api='https://fixture.invalid/cms'),
        site(key='py', type=3, api='https://fixture.invalid/s.py'),
        site(key='js', type=4, api='https://fixture.invalid/s.js'),
        site(key='drpy', type=4, api='https://fixture.invalid/drpy.js'),
        site(key='jar', type=3, api='csp_X'),
        site(key='weird', type=99, api='https://fixture.invalid/x'),
    ]

    def test_runtime_and_compatibility_match_for_every_shape(self):
        for entry in self.ENTRIES:
            decision = route_site(entry, site_key=entry['key'])
            health = infer_site_health(entry)
            self.assertEqual(health.runtime, decision.runtime, entry['key'])
            self.assertEqual(health.compatibility, decision.compatibility, entry['key'])
            self.assertIsNotNone(health.route, entry['key'])
            self.assertEqual(health.route.rule, decision.rule, entry['key'])

    def test_unsupported_runtimes_advertise_no_capabilities(self):
        for key in ('drpy', 'weird'):
            entry = next(e for e in self.ENTRIES if e['key'] == key)
            self.assertEqual(infer_site_health(entry).capabilities, [],
                             '不支持的站点不能对 UI 宣称任何能力')

    def test_capability_flags_use_fongmi_integer_semantics(self):
        decision = route_site(site(type=1, api='https://fixture.invalid/a'))
        # searchable=2 在 FongMi 里 isSearchable() 为 false，能力集合必须一致。
        caps = capabilities_for(site(type=1, api='https://fixture.invalid/a',
                                     searchable=2), decision)
        self.assertNotIn('search', caps)
        self.assertNotIn('quickSearch', caps)
        caps = capabilities_for(site(type=1, api='https://fixture.invalid/a'), decision)
        self.assertIn('search', caps)
        self.assertIn('quickSearch', caps)
        caps = capabilities_for(site(type=1, api='https://fixture.invalid/a',
                                     quickSearch=0, changeable=0, filterable=0), decision)
        self.assertIn('search', caps)
        self.assertNotIn('quickSearch', caps)
        self.assertNotIn('changeable', caps)
        self.assertNotIn('filter', caps)


class TimeoutAndCancelTest(unittest.TestCase):
    """路由是纯函数：超时与取消都不能改变它的结论，也不能让它自己去等 IO。"""

    def test_routing_makes_no_network_calls(self):
        import http_client

        calls = []

        def fail(*args, **kwargs):
            calls.append(args)
            raise AssertionError('route_site 不得发起网络请求')

        original = http_client.get
        http_client.get = fail
        try:
            for entry in (site(type=1, api='https://fixture.invalid/a'),
                          site(type=4, api='https://fixture.invalid/a.js'),
                          site(type=3, api='csp_X')):
                route_site(entry)
        finally:
            http_client.get = original
        self.assertEqual(calls, [])

    def test_decision_is_stable_under_concurrent_use(self):
        """装配阶段是并发的（`_prepare` 用线程池）；路由必须线程安全且结论一致。"""
        entry = site(key='shared', type=3, api='csp_Shared')
        results, errors = [], []

        def worker():
            try:
                results.append(route_site(entry).to_dict())
            except Exception as exc:            # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(16)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 16)
        self.assertEqual(len({repr(r) for r in results}), 1)

    def test_cancelled_load_does_not_change_classification(self):
        cancel = threading.Event()
        before = route_site(site(type=99, api='https://fixture.invalid/x')).to_dict()
        cancel.set()
        after = route_site(site(type=99, api='https://fixture.invalid/x')).to_dict()
        self.assertEqual(before, after)


if __name__ == '__main__':
    unittest.main(verbosity=2)
