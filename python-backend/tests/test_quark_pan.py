# -*- coding: utf-8 -*-
"""夸克网盘 jar 优先/降级/快路径行为回归。"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import hoststate
from jar_spider import JarSpider


class FakeJarSpider(JarSpider):
    def __init__(self, response):
        self.response = response
        self.calls = []
        self._inited = True

    def _call(self, method, *args, **kwargs):
        self.calls.append((method, args))
        return self.response


class TestQuarkPan(unittest.TestCase):
    def setUp(self):
        self.original = hoststate.get_pan_fast_path()

    def tearDown(self):
        hoststate.configure(pan_fast_path=self.original)

    @staticmethod
    def pan_id():
        return json.dumps([{'folder': 'fid/with space', 'shareId': ''}], ensure_ascii=False)

    def test_fast_path_can_short_circuit(self):
        hoststate.configure(pan_fast_path=True)
        spider = FakeJarSpider({'url': 'http://jar.example/video.mp4', 'parse': 0})
        result = spider.playerContentRaw('f', self.pan_id(), [])
        self.assertEqual(result['parse'], 0)
        self.assertIn('fileId=fid%2Fwith%20space', result['url'])
        self.assertEqual(spider.calls, [])

    def test_fast_path_carries_share_file_token(self):
        hoststate.configure(pan_fast_path=True)
        value = json.dumps([{
            'folder': 'fid-share', 'shareId': 'share-1',
            'share_fid_token': 'token-1',
        }], ensure_ascii=False)
        spider = FakeJarSpider({'url': 'http://jar.example/video.mp4', 'parse': 0})
        result = spider.playerContentRaw('f', value, [])
        self.assertIn('shareId=share-1', result['url'])
        self.assertIn('fileId=fid-share', result['url'])
        self.assertIn('fileToken=token-1', result['url'])
        self.assertEqual(spider.calls, [])

    def test_fast_path_accepts_json_object_and_url_encoded_id(self):
        hoststate.configure(pan_fast_path=True)
        value = '%7B%22fileId%22%3A%22fid-object%22%2C%22share_id%22%3A%22share-2%22%7D'
        params = JarSpider._quark_play_params(value)
        self.assertEqual(params['fileId'], 'fid-object')
        self.assertEqual(params['shareId'], 'share-2')
        spider = FakeJarSpider({'url': 'http://jar.example/video.mp4', 'parse': 0})
        result = spider.playerContentRaw('f', value, [])
        self.assertIn('fileId=fid-object', result['url'])
        self.assertIn('shareId=share-2', result['url'])
        self.assertEqual(spider.calls, [])

    def test_jar_result_wins_when_fast_path_is_off(self):
        hoststate.configure(pan_fast_path=False)
        spider = FakeJarSpider({'url': 'https://cdn.example/video.m3u8', 'parse': 0})
        result = spider.playerContentRaw('f', self.pan_id(), [])
        self.assertEqual(result['url'], 'https://cdn.example/video.m3u8')
        self.assertEqual(spider.calls[0][0], 'playerContent')

    def test_legacy_go_proxy_result_is_replaced_by_pan_proxy(self):
        hoststate.configure(pan_fast_path=False)
        stale = 'http://127.0.0.1:7944/?url=https%3A%2F%2Fdl-pc-zb.drive.quark.cn%2Fstale.mp4&proxytype=go&thread=32'
        spider = FakeJarSpider({'url': stale, 'parse': 0, 'header': {'User-Agent': 'fixture'}})
        result = spider.playerContentRaw('f', self.pan_id(), [])
        self.assertIn('do=pan', result['url'])
        self.assertIn('fileId=fid%2Fwith%20space', result['url'])
        self.assertEqual(result['parse'], 0)
        self.assertEqual(result['header'], {'User-Agent': 'fixture'})
        self.assertEqual(spider.calls[0][0], 'playerContent')

    def test_degraded_jar_result_falls_back_to_go_proxy(self):
        hoststate.configure(pan_fast_path=False)
        spider = FakeJarSpider({'url': self.pan_id(), 'parse': 1})
        result = spider.playerContentRaw('f', self.pan_id(), [])
        self.assertEqual(result['parse'], 0)
        self.assertIn('do=pan', result['url'])
        self.assertIn('fileId=fid%2Fwith%20space', result['url'])

    def test_folder_parser_is_tolerant_of_extra_fields(self):
        folder, share_id = JarSpider._quark_folder_id(
            json.dumps([{'folder': 'fid', 'shareId': '', 'name': 'episode', 'extra': 1}]))
        self.assertEqual((folder, share_id), ('fid', ''))


if __name__ == '__main__':
    unittest.main()
