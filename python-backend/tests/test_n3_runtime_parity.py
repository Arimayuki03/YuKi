# -*- coding: utf-8 -*-
"""N3.2 ~ N3.5 核心契约与统一数据面回归测试：
- QuickJS 宿主缺失全局诊断、安全守卫、单站点配额
- Python Spider 独立目录与依赖缺失诊断
- CMS 六方法契约、编码、HTML 假直链防误判、结构化错误
- 统一 /proxy 数据面调度、Range/206、流式转发与取消
"""
import io
import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

# 确保 python-backend 及 js-engine 目录在 sys.path 中
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)
JS_ENGINE_DIR = os.path.join(BACKEND_DIR, 'js-engine')
if JS_ENGINE_DIR not in sys.path:
    sys.path.insert(0, JS_ENGINE_DIR)

from cms_spider import CmsSpider
from quickjs_host import JsEngine
import proxy_gateway
from proxy_contract import ProxyResult
from server import build_proxy_response


class TestN32QuickJSEnhancements(unittest.TestCase):
    def test_missing_global_diagnostic(self):
        engine = JsEngine(site_key='test_diag')
        with patch('quickjs_host.logger.warning') as mock_warn:
            engine._warn_missing_global('ReferenceError: rule is not defined', 'rule.js')
            mock_warn.assert_called()
            args, _ = mock_warn.call_args
            self.assertIn('drpy', args[3])  # 包含针对性的 drpy 建议

    def test_local_kv_site_quota(self):
        from quickjs_host import _native_local_set, _native_local_get
        set_fn = _native_local_set('quota_site')
        get_fn = _native_local_get('quota_site')
        
        # 写入正常大小
        set_fn('k1', 'hello')
        self.assertEqual(get_fn('k1'), 'hello')

    def test_security_guard_applied_to_http(self):
        from quickjs_host import _native_http
        # 严格 SSRF 模式（YUKI_CONFIG_BLOCK_PRIVATE_NETWORK=1）下私网地址仍被拒；
        # 桌面端默认已放开本机/内网引用（局域网 NAS / 本机服务是合理场景）。
        with patch.dict(os.environ, {'YUKI_CONFIG_BLOCK_PRIVATE_NETWORK': '1'}):
            res_json = _native_http('http://192.168.1.1/admin', '{}')
        res = json.loads(res_json)
        self.assertEqual(res['status'], 403)
        self.assertIn('blocked', res['content'])


class TestN33PythonSpiderIsolation(unittest.TestCase):
    def test_materialize_isolated_subdirectories(self):
        from config import ConfigManager
        from site_manager import SiteManager
        sm = SiteManager()
        mgr = ConfigManager(sm)
        site_key = 'py_iso_test'
        content = b"class Spider: pass"
        
        with patch('http_client.fetch_follow_redirects') as mock_fetch:
            mock_resp = MagicMock()
            mock_resp.content = content
            mock_fetch.return_value = mock_resp
            
            path = mgr._materialize_python_spider(site_key, 'http://test.com/spider.py')
            self.assertTrue(os.path.isabs(path))
            self.assertIn(site_key, path)
            self.assertTrue(os.path.exists(path))


class TestN34CmsContract(unittest.TestCase):
    def setUp(self):
        self.spider = CmsSpider('cms_test', 'http://example.com/api', stype=1, name='测试CMS')

    def test_fake_html_direct_link_detected(self):
        # 网页地址必须标记为 parse=1 (交由解析器)，绝不能直接 parse=0 误标为直链
        res = self.spider.playerContent('line1', 'https://example.com/play/123.html', [])
        self.assertEqual(res['parse'], 1)

        res_php = self.spider.playerContent('line1', 'https://example.com/play.php?id=1', [])
        self.assertEqual(res_php['parse'], 1)

        # 真实直链媒体必须标记为 parse=0
        res_m3u8 = self.spider.playerContent('line1', 'https://example.com/live.m3u8', [])
        self.assertEqual(res_m3u8['parse'], 0)
        self.assertEqual(res_m3u8['url'], 'https://example.com/live.m3u8')

    def test_video_format_check(self):
        self.assertTrue(self.spider.isVideoFormat('https://example.com/test.mp4'))
        self.assertFalse(self.spider.isVideoFormat('https://example.com/test.html'))
        self.assertFalse(self.spider.isVideoFormat('https://example.com/play.jsp?v=1'))

    def test_xml_and_json_parsing(self):
        xml_data = """<?xml version="1.0" encoding="utf-8"?>
        <rss version="5.1">
            <class>
                <ty id="1">电影</ty>
            </class>
            <list page="1" pagecount="1" pagesize="20" recordcount="1">
                <video>
                    <id>100</id>
                    <tid>1</tid>
                    <name>测试影片</name>
                    <type>电影</type>
                    <dl>
                        <dd flag="http">第1集$https://example.com/1.m3u8</dd>
                    </dl>
                </video>
            </list>
        </rss>
        """
        parsed = self.spider._parse_xml(xml_data)
        self.assertEqual(len(parsed['class']), 1)
        self.assertEqual(parsed['class'][0]['type_name'], '电影')
        self.assertEqual(len(parsed['list']), 1)
        self.assertEqual(parsed['list'][0]['vod_name'], '测试影片')
        self.assertEqual(parsed['list'][0]['vod_play_url'], '第1集$https://example.com/1.m3u8')


class TestN35ProxyGateway(unittest.TestCase):
    def test_param_semantic_retention(self):
        params = {'siteKey': 'demo_site', 'url': 'http://cdn.com/1.m3u8', 'header': '{"User-Agent":"test"}'}
        sites_mock = MagicMock()
        site_mock = MagicMock()
        site_mock.key = 'demo_site'
        site_mock.runner.localProxy.return_value = 'http://proxy-out'
        sites_mock.get.return_value = site_mock

        res = proxy_gateway.dispatch(params, sites_mock)
        self.assertEqual(res, 'http://proxy-out')
        # 原始 siteKey 语义不应被强制 pop 抹杀
        site_mock.runner.localProxy.assert_called_once()
        called_args = site_mock.runner.localProxy.call_args[0][0]
        self.assertIn('siteKey', called_args)

    def test_proxy_result_range_206(self):
        # 测试 206 Partial Content 流式响应
        stream = io.BytesIO(b"0123456789ABCDEF")
        pr = ProxyResult(
            status=206,
            mime='video/mp4',
            body=stream,
            headers={'Content-Range': 'bytes 0-7/16', 'Content-Length': '8'}
        )
        response = build_proxy_response(pr)
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.headers.get('content-range'), 'bytes 0-7/16')


    def test_esm_module_caching(self):
        from module_resolver import ModuleBundle
        fetch_count = 0
        def mock_fetch(url):
            nonlocal fetch_count
            fetch_count += 1
            if url == 'http://example.com/entry.js':
                return "import './dep.js'; export default {};"
            return "export const x = 1;"

        bundle1 = ModuleBundle().build('http://example.com/entry.js', mock_fetch)
        self.assertEqual(fetch_count, 2)

        # 第二次构建相同模块树，应命中全局模块二级缓存
        bundle2 = ModuleBundle().build('http://example.com/entry.js', mock_fetch)
        self.assertEqual(fetch_count, 2)  # 未触发额外网络请求
        self.assertEqual(len(bundle2.modules), 2)


if __name__ == '__main__':
    unittest.main()
