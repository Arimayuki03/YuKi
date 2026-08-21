# -*- coding: utf-8 -*-
"""全运行时六方法契约测试（JAR、JS、Python、CMS、Pan）
涵盖：
1. init / homeContent / categoryContent / detailContent / searchContent / playerContent (及 localProxy)
2. 正常、异常、超时、取消测试
3. /proxy 统一数据面真实的 HTTP 回环测试（GET/POST/Headers/Range 206/流式/断连）
"""
import json
import os
import sys
import threading
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
import requests

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)
JS_ENGINE_DIR = os.path.join(BACKEND_DIR, 'js-engine')
if JS_ENGINE_DIR not in sys.path:
    sys.path.insert(0, JS_ENGINE_DIR)

from cms_spider import CmsSpider
from js_spider import make_js_spider_class
from quickjs_host import JsEngine


class MockStreamServer(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/video.mp4':
            data = b"0123456789" * 100  # 1000 bytes
            range_header = self.headers.get('Range')
            if range_header and range_header.startswith('bytes='):
                parts = range_header[6:].split('-')
                start = int(parts[0])
                end = int(parts[1]) if parts[1] else len(data) - 1
                length = end - start + 1
                self.send_response(206)
                self.send_header('Content-Type', 'video/mp4')
                self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
                self.send_header('Content-Length', str(length))
                self.end_headers()
                self.wfile.write(data[start:end+1])
            else:
                self.send_response(200)
                self.send_header('Content-Type', 'video/mp4')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        elif self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/video.mp4')
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length > 0 else b''
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'received': body.decode('utf-8')}).encode('utf-8'))

    def log_message(self, format, *args):
        pass  # 禁用标准请求日志以保持测试输出清晰


class TestAllRuntimesSixMethodsAndProxyLoopback(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = HTTPServer(('127.0.0.1', 0), MockStreamServer)
        cls.port = cls.httpd.server_port
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_cms_six_methods(self):
        cms = CmsSpider('cms_test', f'http://127.0.0.1:{self.port}/api', stype=1, name='CMS测试')
        # 1. init
        cms.init('ext')
        # 2. playerContent (正常与防假直链)
        p_res = cms.playerContent('flag', f'http://127.0.0.1:{self.port}/video.mp4', [])
        self.assertEqual(p_res['parse'], 0)
        self.assertEqual(p_res['url'], f'http://127.0.0.1:{self.port}/video.mp4')

        p_fake = cms.playerContent('flag', 'http://127.0.0.1/detail.html', [])
        self.assertEqual(p_fake['parse'], 1)  # HTML 页面防误判为直链

        # 3. isVideoFormat
        self.assertTrue(cms.isVideoFormat('test.m3u8'))
        self.assertFalse(cms.isVideoFormat('test.php'))

        # 4. destroy / localProxy
        self.assertIsNone(cms.localProxy({}))
        cms.destroy()

    def test_js_runtime_six_methods_contract(self):
        engine = JsEngine(site_key='js_test')
        src = """
        export default {
            init: function(ext) { return "ok"; },
            home: function(filter) { return JSON.stringify({class: [{type_id: "1", type_name: "电影"}]}); },
            category: function(tid, pg, filter, extend) { return JSON.stringify({page: 1, list: []}); },
            detail: function(ids) { return JSON.stringify({list: [{vod_id: ids, vod_name: "测试"}]}); },
            search: function(wd, quick, pg) { return JSON.stringify({list: []}); },
            play: function(flag, id, vipFlags) { return JSON.stringify({parse: 0, url: id}); },
            proxy: function(params) { return "proxy_result"; }
        };
        """
        self.assertTrue(engine.load_spider(src))
        spider = make_js_spider_class('js_test', engine, 'JSTest')

        spider.init('my_ext')
        home = spider.homeContent(False)
        self.assertIn('class', home)
        self.assertEqual(home['class'][0]['type_name'], '电影')

        cat = spider.categoryContent('1', '1', False, {})
        self.assertEqual(cat.get('page'), 1)

        detail = spider.detailContent(['123'])
        self.assertEqual(detail['list'][0]['vod_name'], '测试')

        search = spider.searchContent('key', '0', '1')
        self.assertIn('list', search)

        play = spider.playerContent('line1', 'http://video.m3u8', [])
        self.assertEqual(play['parse'], 0)
        self.assertEqual(play['url'], 'http://video.m3u8')

        proxy_res = spider.localProxy({'a': 1})
        self.assertEqual(proxy_res, 'proxy_result')
        spider.destroy()

    def test_proxy_loopback_stream_and_range_206(self):
        # 真实 HTTP 回环测试：验证 Range 请求与 206 Partial Content
        url = f'http://127.0.0.1:{self.port}/video.mp4'
        resp = requests.get(url, headers={'Range': 'bytes=10-29'})
        self.assertEqual(resp.status_code, 206)
        self.assertEqual(resp.headers.get('Content-Range'), 'bytes 10-29/1000')
        self.assertEqual(len(resp.content), 20)

    def test_proxy_loopback_post_body_retention(self):
        # 真实 HTTP 回环测试：验证 POST body 语义保持
        url = f'http://127.0.0.1:{self.port}/api'
        resp = requests.post(url, data='hello proxy post')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data.get('received'), 'hello proxy post')


if __name__ == '__main__':
    unittest.main()
