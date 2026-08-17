"""任务五：分层诊断增强验证。

验证 config 加载失败时能正确识别并聚合层级错误（L2:type / L3:jar/js/cms/py）。
"""
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'js-engine')))

import json
import unittest
from config import ConfigManager
from site_manager import SiteManager
from quickjs_host import JsEngine


class TestLayeredDiagnostics(unittest.TestCase):
    def setUp(self):
        self.sites = SiteManager()
        self.cfg = ConfigManager(self.sites)

    def test_type_unsupported_categorization(self):
        """验证不支持的 type 被分类为 L2:type 错误"""
        config = {
            'sites': [
                {'key': 'bad1', 'name': '不支持type15', 'type': 15, 'api': 'http://x'},
                {'key': 'bad2', 'name': '不支持type2', 'type': 2, 'api': 'http://y'},
            ]
        }
        summary = self.cfg.load(json.dumps(config))
        self.assertEqual(summary['sites'], 0)
        self.assertEqual(len(summary['skipped']), 2)
        self.assertEqual(summary['build_errors']['type_unsupported'], 2)
        # 验证 skipped 消息包含层级标签
        self.assertTrue(any('[L2:type]' in s for s in summary['skipped']))

    def test_jar_failure_categorization(self):
        """验证 jar 失败被分类为 L3:jar 错误"""
        config = {
            'spider': 'http://404.example.com/notfound.jar',
            'sites': [
                {'key': 'jar1', 'name': 'JAR源', 'type': 3, 'api': 'csp_Test'},
            ]
        }
        summary = self.cfg.load(json.dumps(config))
        # jar 下载失败会导致站点跳过
        self.assertTrue(summary['build_errors']['jar_failed'] > 0 or
                       any('[L3:jar]' in str(s) for s in summary['skipped']))

    def test_js_failure_categorization(self):
        """验证 JS spider 失败被分类为 L3:js 错误"""
        bad_js = '''
// 故意缺少 __jsEvalReturn 和 default export
function badSpider() { return {}; }
'''
        config = {
            'sites': [
                {'key': 'js1', 'name': 'JS源', 'type': 4, 'api': bad_js},
            ]
        }
        summary = self.cfg.load(json.dumps(config))
        self.assertEqual(summary['sites'], 0)
        self.assertTrue(summary['build_errors']['js_failed'] > 0)
        self.assertTrue(any('[L3:js]' in s for s in summary['skipped']))

    def test_drpy_failure_categorization(self):
        """验证 drpy 源被分类为 L2:type 错误"""
        config = {
            'sites': [
                {'key': 'drpy1', 'name': 'Drpy源', 'type': 3,
                 'api': 'http://example.com/drpy_spider.js'},
            ]
        }
        summary = self.cfg.load(json.dumps(config))
        self.assertEqual(summary['sites'], 0)
        self.assertTrue(summary['build_errors']['type_unsupported'] > 0)
        self.assertTrue(any('[L2:type]' in s and 'drpy' in s.lower()
                           for s in summary['skipped']))

    def test_mixed_errors_aggregation(self):
        """验证混合错误能正确聚合到各个层级"""
        config = {
            'sites': [
                {'key': 'bad_type', 'name': '不支持', 'type': 99, 'api': 'x'},
                {'key': 'bad_js', 'name': 'JS失败', 'type': 4, 'api': 'bad js code'},
                {'key': 'drpy', 'name': 'Drpy', 'type': 3, 'api': 'http://x/drpy.js'},
            ]
        }
        summary = self.cfg.load(json.dumps(config))
        self.assertEqual(summary['sites'], 0)
        # 至少有 type_unsupported 和 js_failed
        self.assertTrue(summary['build_errors']['type_unsupported'] >= 2)
        self.assertTrue(summary['build_errors']['js_failed'] >= 1)

    def test_successful_site_no_errors(self):
        """验证成功加载的站点不计入错误统计"""
        config = {
            'sites': [
                {'key': 'cms1', 'name': 'CMS源', 'type': 0,
                 'api': 'http://example.com/api.php/provide/vod/'},
            ]
        }
        summary = self.cfg.load(json.dumps(config))
        self.assertEqual(summary['sites'], 1)
        self.assertEqual(len(summary['skipped']), 0)
        # 所有错误计数应为 0
        for count in summary['build_errors'].values():
            self.assertEqual(count, 0)

    def test_l1_parse_error_is_tagged(self):
        with self.assertRaisesRegex(ValueError, r'^\[L1:parse\]'):
            self.cfg.load('{not-json')

    def test_l1_fetch_error_is_exposed_in_task_summary(self):
        # 直接覆盖 fetch 结果，避免该测试依赖网络。
        import config as config_module
        original = config_module.fetch_text
        try:
            config_module.fetch_text = lambda _url: ''
            with self.assertRaisesRegex(ValueError, r'^\[L1:fetch\]'):
                self.cfg.load('https://example.invalid/config.json')
        finally:
            config_module.fetch_text = original

    def test_parse_one_without_parses_gets_l4_message(self):
        import server
        from server import _attach_jar_error

        server.config_mgr.parses = []
        body = _attach_jar_error(None, json.dumps({'url': 'https://example/video', 'parse': 1}), flag='f')
        self.assertIn('当前配置未含匹配该线路的解析接口', body)

    def test_quickjs_missing_global_is_logged(self):
        engine = JsEngine(site_key='diagnostic-test')
        src = 'export function __jsEvalReturn() { return { homeContent() { return missingHostGlobal; } }; }'
        engine.load_spider(src)
        with self.assertLogs('vpc.jsengine', level='WARNING') as logs:
            engine.call('homeContent')
        self.assertTrue(any('宿主未提供的全局 <missingHostGlobal>' in line for line in logs.output))


if __name__ == '__main__':
    unittest.main()
