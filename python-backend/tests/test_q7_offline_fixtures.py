# -*- coding: utf-8 -*-
"""Q7.1 确定性离线用例测试套件"""
import os
import sys
import unittest
import requests

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from tests.fixtures.q7_offline_fixtures import Q7OfflineFixtureServer, MINIMAL_MP4
from cms_spider import CmsSpider
from play_contract import normalize_play_result


class TestQ7DeterministicOfflineFixtures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Q7OfflineFixtureServer()
        cls.server.__enter__()
        cls.base = cls.server.base_url

    @classmethod
    def tearDownClass(cls):
        cls.server.close()

    def test_json_and_xml_cms(self):
        # JSON CMS
        cms_json = CmsSpider('q7_json', f'{self.base}/cms/json', stype=1, name='Q7 JSON')
        cms_json.init('')
        home_json = cms_json.homeContent(True)
        self.assertTrue(len(home_json.get('class', [])) >= 2)
        detail_json = cms_json.detailContent(['json_vod_1'])
        self.assertEqual(detail_json['list'][0]['vod_id'], 'json_vod_1')

        # XML CMS
        cms_xml = CmsSpider('q7_xml', f'{self.base}/cms/xml', stype=0, name='Q7 XML')
        cms_xml.init('')
        home_xml = cms_xml.homeContent(True)
        self.assertTrue(len(home_xml.get('class', [])) >= 2)
        detail_xml = cms_xml.detailContent(['xml_vod_1'])
        self.assertEqual(detail_xml['list'][0]['vod_id'], 'xml_vod_1')

    def test_mp4_direct_and_range_206(self):
        url = f'{self.base}/media/video.mp4'
        # 1. 完整 GET
        r = requests.get(url, timeout=5)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, MINIMAL_MP4)

        # 2. Range 206
        r_range = requests.get(url, headers={'Range': 'bytes=0-9'}, timeout=5)
        self.assertEqual(r_range.status_code, 206)
        self.assertEqual(len(r_range.content), 10)
        self.assertIn('Content-Range', r_range.headers)

        # 3. Bad Content-Range
        r_bad = requests.get(f'{self.base}/media/bad_range.mp4', headers={'Range': 'bytes=0-9'}, timeout=5)
        self.assertEqual(r_bad.status_code, 206)

    def test_master_and_variant_hls(self):
        # master m3u8
        r_master = requests.get(f'{self.base}/hls/master.m3u8', timeout=5)
        self.assertEqual(r_master.status_code, 200)
        self.assertIn('variant.m3u8', r_master.text)

        # variant m3u8
        r_var = requests.get(f'{self.base}/hls/variant.m3u8', timeout=5)
        self.assertEqual(r_var.status_code, 200)
        self.assertIn('EXT-X-ENDLIST', r_var.text)

    def test_referer_and_cookie_auth(self):
        # 未授权
        r_unauth = requests.get(f'{self.base}/auth/check', timeout=5)
        self.assertEqual(r_unauth.status_code, 403)

        # 授权
        headers = {
            'Referer': 'https://allowed-site.com/video/1',
            'Cookie': 'session=token123; other=abc'
        }
        r_auth = requests.get(f'{self.base}/auth/check', headers=headers, timeout=5)
        self.assertEqual(r_auth.status_code, 200)
        self.assertTrue(r_auth.json().get('ok'))

    def test_redirect_302_307(self):
        for r_path in ('/redirect/302', '/redirect/307'):
            r = requests.get(f'{self.base}{r_path}', allow_redirects=True, timeout=5)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.content, MINIMAL_MP4)

    def test_fake_video_html_detection(self):
        # 网页不应被当作纯视频流
        r = requests.get(f'{self.base}/fake_video.html', timeout=5)
        self.assertEqual(r.status_code, 200)
        self.assertIn('text/html', r.headers.get('Content-Type', ''))
        # 验证 normalize_play_result 和 probe 对 HTML 的处理
        cms = CmsSpider('q7_fake', f'{self.base}/cms/json', stype=1)
        p_res = cms.playerContent('line', f'{self.base}/fake_video.html', [])
        self.assertEqual(p_res['parse'], 1)  # 自动识别为需要二次解析

    def test_parser_json_and_iframe(self):
        # Parser JSON
        r_parser = requests.get(f'{self.base}/parser/json', timeout=5)
        self.assertEqual(r_parser.status_code, 200)
        p_data = r_parser.json()
        norm = normalize_play_result(p_data)
        self.assertTrue(norm['url'].startswith('http://127.0.0.1'))

        # Parser iframe
        r_iframe = requests.get(f'{self.base}/parser/iframe', timeout=5)
        self.assertEqual(r_iframe.status_code, 200)
        self.assertIn('<iframe', r_iframe.text)

    def test_fault_slow_abort_expired(self):
        # 慢响应超时
        with self.assertRaises(requests.exceptions.Timeout):
            requests.get(f'{self.base}/fault/slow?ms=400', timeout=0.1)

        # 慢响应完成
        r_slow = requests.get(f'{self.base}/fault/slow?ms=50', timeout=2)
        self.assertEqual(r_slow.status_code, 200)

        # 过期 URL
        r_exp = requests.get(f'{self.base}/fault/expired?exp=1000', timeout=5)
        self.assertEqual(r_exp.status_code, 403)


if __name__ == '__main__':
    unittest.main()
