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

    def test_jar_result_wins_when_fast_path_is_off(self):
        hoststate.configure(pan_fast_path=False)
        spider = FakeJarSpider({'url': 'https://cdn.example/video.m3u8', 'parse': 0})
        result = spider.playerContentRaw('f', self.pan_id(), [])
        self.assertEqual(result['url'], 'https://cdn.example/video.m3u8')
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
