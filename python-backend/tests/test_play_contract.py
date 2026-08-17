# -*- coding: utf-8 -*-
"""FongMi playerContent result and proxy URL contract tests."""

from __future__ import annotations

import os
import sys
import unittest

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

from play_contract import normalize_play_result  # noqa: E402
from proxy_contract import decode_proxy_body, normalize_proxy_url  # noqa: E402


class TestPlayContract(unittest.TestCase):
    def test_jx_header_aliases_and_extended_fields(self):
        result = normalize_play_result({
            'url': 'https://media.test/a.m3u8',
            'jx': 1,
            'header': '{"Referer":"https://site.test/"}',
            'headers': {'user-agent': 'spider-agent'},
            'format': 'application/x-mpegURL',
            'subs': '[{"url":"https://site.test/a.vtt"}]',
            'drm': {'scheme': 'widevine'},
            'position': 12000,
            'custom': {'keep': True},
        }, site_headers={'User-Agent': 'site-agent'}, flag='线路A')
        self.assertEqual(result['parse'], 1)
        self.assertEqual(result['header']['Referer'], 'https://site.test/')
        self.assertEqual(result['header']['user-agent'], 'spider-agent')
        self.assertEqual(result['subs'][0]['url'], 'https://site.test/a.vtt')
        self.assertEqual(result['position'], 12000)
        self.assertEqual(result['custom'], {'keep': True})

    def test_empty_url_is_not_replaced_by_original_id(self):
        result = normalize_play_result({'parse': 1}, flag='f', original_id='episode-page')
        self.assertEqual(result['url'], '')
        self.assertIn('empty url', result['error'])

    def test_bare_url_adapter(self):
        result = normalize_play_result('https://media.test/v.mp4')
        self.assertEqual(result['url'], 'https://media.test/v.mp4')
        self.assertEqual(result['parse'], 0)

    def test_proxy_url_is_encoded_once_and_site_scoped(self):
        value = normalize_proxy_url(
            'proxy://do=js&url=https%3A%2F%2Fmedia.test%2Fa%3Fx%3D1%2525',
            site_key='site A',
            proxy_base='http://127.0.0.1:1234/proxy',
        )
        self.assertTrue(value.startswith('http://127.0.0.1:1234/proxy?'))
        self.assertIn('siteKey=site+A', value)
        self.assertIn('x%3D1%2525', value)

    def test_legacy_spider_proxy_port_maps_to_control_port(self):
        value = normalize_proxy_url(
            'http://127.0.0.1:7944/proxy?do=py&siteKey=s1&x=a%2Bb',
            proxy_base='http://127.0.0.1:4321/proxy',
        )
        self.assertTrue(value.startswith('http://127.0.0.1:4321/proxy?'))
        self.assertIn('x=a%2Bb', value)

    def test_legacy_pan_url_stays_on_data_plane(self):
        value = 'http://127.0.0.1:9978/proxy?do=pan&fileId=fid'
        self.assertEqual(normalize_proxy_url(value, proxy_base='http://127.0.0.1:4321/proxy'), value)

    def test_post_body_decoder_keeps_binary_body(self):
        fields, raw = decode_proxy_body(b'do=py&fileId=fid+1', 'application/x-www-form-urlencoded')
        self.assertEqual(fields, {'do': 'py', 'fileId': 'fid 1'})
        self.assertIsNone(raw)
        fields, raw = decode_proxy_body(b'\x00\xff', 'application/octet-stream')
        self.assertEqual(fields, {})
        self.assertEqual(raw, b'\x00\xff')


if __name__ == '__main__':
    unittest.main()
