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

    def tearDown(self):
        # ConfigManager now owns spawn Workers; tests must exercise the same
        # explicit lifecycle as configuration reload/application shutdown.
        self.sites.destroy_all()

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
        """惰性初始化后，坏 JS 不再在载入期失败（L3:js 推迟到首次调用）。

        载入期为几十上百个站点各拉起 Worker 校验脚本代价过高（见
        `ConfigManager._initialize_site`），因此坏脚本站点照常建成，
        `[L3:js]` 只会出现在运行期诊断，不再进建站聚合。
        """
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
        self.assertEqual(summary['sites'], 1,
                         '坏 JS 站点在惰性初始化下照常建成')
        self.assertEqual(summary['build_errors']['js_failed'], 0)
        self.assertEqual(len(summary['skipped']), 0)

    def test_drpy_failure_categorization(self):
        """验证 drpy 源被固定标记为 unsupported 并进入分层诊断（引擎已移除）"""
        config = {
            'sites': [
                {'key': 'drpy1', 'name': 'Drpy源', 'type': 3,
                 'api': 'http://example.com/drpy_spider.js'},
            ]
        }
        summary = self.cfg.load(json.dumps(config))
        self.assertEqual(summary['sites'], 0)
        self.assertTrue(len(summary['skipped']) > 0)
        self.assertTrue(any('drpy' in s.lower() or '[L3:' in s or '[L2:' in s
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
        # bad_type(type99) 与 drpy 源在载入期必然跳过（R6 / drpy 固定 unsupported）；
        # 坏 JS 站点因惰性初始化照常建成——L3:js 推迟到首次调用。
        self.assertEqual(summary['sites'], 1)
        self.assertEqual(len(summary['skipped']), 2)
        # 至少有 type_unsupported
        self.assertTrue(summary['build_errors']['type_unsupported'] >= 1)

    def test_successful_site_no_errors(self):
        """验证成功加载的站点不计入错误统计

        api 用公网 IP 字面量：域名（如 example.com）在本机/部分网络环境会被
        解析到内网段，触发安全护栏的 private_network_blocked，与测试语义无关。
        """
        config = {
            'sites': [
                {'key': 'cms1', 'name': 'CMS源', 'type': 0,
                 'api': 'http://93.184.216.34/api.php/provide/vod/'},
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
        # 覆盖点必须是 `fetch_text_diagnostics`：配置加载走的是它，`fetch_text`
        # 只是它的薄包装，patch 后者等于没 patch（这里会真的去打那个地址）。
        import config as config_module
        original = config_module.fetch_text_diagnostics
        try:
            config_module.fetch_text_diagnostics = lambda _url, **_kw: {
                'text': '', 'status': 0, 'finalUrl': '', 'error': '',
                'etag': '', 'lastModified': '', 'contentHash': '', 'size': 0,
                'redirects': [], 'disguise': '', 'encoding': '', 'blocked': '',
            }
            with self.assertRaisesRegex(ValueError, r'^\[L1:fetch\]'):
                self.cfg.load('https://example.invalid/config.json')
        finally:
            config_module.fetch_text_diagnostics = original

    def test_parse_one_without_parses_gets_l4_message(self):
        """没有解析器时 L4 只是**非致命** warning：播放地址还在，渲染层继续走
        隐藏窗口嗅探（对齐上游 ParseJob 的 type 0 回退），不能把整条线路判死。"""
        import server
        from server import _attach_jar_error

        server.config_mgr.parses = []
        body = _attach_jar_error(None, json.dumps({'url': 'https://example/video', 'parse': 1}), flag='f')
        data = json.loads(body)
        self.assertIn('当前配置未含可用的解析接口', data['warning']['message'])
        self.assertEqual(data['warning']['code'], 'L4_PARSE_UNAVAILABLE')
        self.assertNotIn('error', data)
        self.assertEqual(data['url'], 'https://example/video')
        # 没有地址才是真的无从播放：保留致命 error，由 HTTP 层提升为 424。
        body = _attach_jar_error(None, json.dumps({'url': '', 'parse': 1}), flag='f')
        self.assertEqual(json.loads(body)['error']['code'], 'L4_PARSE_UNAVAILABLE')

    def test_parse_one_with_ext_flag_parser_is_not_reported_unavailable(self):
        """真实 TVBox 配置把线路白名单写在 ``ext.flag``，且上游只把它当偏好：
        线路没被任何解析器点名也不能判定「无解析接口」。"""
        import server
        from server import _attach_jar_error

        server.config_mgr.parses = [
            {'name': '解析1', 'type': 1, 'url': 'https://jx.test/?url=',
             'ext': {'flag': ['qiyi', 'qq']}},
        ]
        try:
            for flag in ('qiyi', 'm3u8', ''):
                data = json.loads(_attach_jar_error(
                    None, json.dumps({'url': 'https://example/video', 'parse': 1}), flag=flag))
                self.assertNotIn('error', data)
                self.assertNotIn('warning', data)
        finally:
            server.config_mgr.parses = []

    def test_quickjs_missing_global_is_logged(self):
        engine = JsEngine(site_key='diagnostic-test')
        src = 'export function __jsEvalReturn() { return { homeContent() { return missingHostGlobal; } }; }'
        engine.load_spider(src)
        with self.assertLogs('yuki.jsengine', level='WARNING') as logs:
            engine.call('homeContent')
        self.assertTrue(any('宿主未提供的全局 <missingHostGlobal>' in line for line in logs.output))


if __name__ == '__main__':
    unittest.main()
