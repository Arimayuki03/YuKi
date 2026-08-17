# -*- coding: utf-8 -*-
"""Native Provider contract tests (network calls are mocked)."""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

from pan.quark import QuarkProvider  # noqa: E402
from pan.registry import PanProviderRegistry  # noqa: E402


class TestPanProvider(unittest.TestCase):
    def test_registry_does_not_claim_unimplemented_provider(self):
        registry = PanProviderRegistry()
        self.assertEqual(registry.keys(), ['quark'])
        self.assertIsNone(registry.get('baidu'))

    def test_cookie_validation_is_non_destructive(self):
        provider = QuarkProvider()
        self.assertTrue(provider.validate_cookie(''))
        self.assertEqual(provider.validate_cookie('__pus=ok;'), [])

    def test_personal_file_resolves_to_short_url(self):
        provider = QuarkProvider()
        fake = type('FakeGoProxy', (), {})()
        fake._quark_v2play = lambda file_id, headers: 'https://cdn.test/%s.mp4' % file_id
        with patch.dict(sys.modules, {'go_proxy': fake}):
            play = provider.resolve_play_url({'fileId': 'fid-1'}, headers={'Cookie': 'secret'})
        self.assertEqual(play.url, 'https://cdn.test/fid-1.mp4')
        self.assertEqual(play.file_id, 'fid-1')
        self.assertNotEqual(play.headers, {})

    def test_share_file_falls_back_to_v2_play(self):
        provider = QuarkProvider()
        fake = type('FakeGoProxy', (), {})()
        fake._quark_download_url = lambda *args: ''
        fake._quark_v2play = lambda file_id, headers: 'https://cdn.test/share.mp4'
        with patch.dict(sys.modules, {'go_proxy': fake}):
            play = provider.resolve_play_url(
                {'shareId': 'share', 'fileId': 'fid', 'fileToken': 'token'},
                headers={},
            )
        self.assertEqual(play.url, 'https://cdn.test/share.mp4')

    def test_personal_file_falls_back_when_v2_play_raises(self):
        provider = QuarkProvider()
        fake = type('FakeGoProxy', (), {})()

        def broken_v2_play(file_id, headers):
            raise RuntimeError('v2/play unavailable')

        class Response:
            @staticmethod
            def json():
                return {'data': {'download_url': 'https://cdn.test/fallback.mp4'}}

        fake._quark_v2play = broken_v2_play
        fake._qpost = lambda *args, **kwargs: Response()
        with patch.dict(sys.modules, {'go_proxy': fake}):
            play = provider.resolve_play_url({'fileId': 'fid-fallback'}, headers={})
        self.assertEqual(play.url, 'https://cdn.test/fallback.mp4')


if __name__ == '__main__':
    unittest.main()
