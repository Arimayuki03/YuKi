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
        self.assertTrue(play.one_time)

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

    def test_share_file_falls_back_to_sharepage_chain(self):
        # pwdId+fileId 的多集分享应走会话级解析，而非回退到首集。
        provider = QuarkProvider()
        fake = type('FakeGoProxy', (), {})()
        captured = {}
        fake._quark_download_url = lambda *args: ''
        fake._quark_v2play = lambda *args: ''

        def share_file(pwd_id, file_id, file_token, headers, quality='', share_id=''):
            captured.update({'pwd_id': pwd_id, 'file_id': file_id,
                             'quality': quality, 'share_id': share_id})
            return 'https://cdn.test/sharepage.mp4'

        fake._quark_share_file_play_url = share_file
        with patch.dict(sys.modules, {'go_proxy': fake}):
            play = provider.resolve_play_url({
                'shareId': 'share-id', 'fileId': 'fid',
                'fileToken': 'token', 'pwdId': 'public-pwd',
                'quality': '夸克原画#0101',
            }, headers={'Cookie': 'secret'}, refresh=True)
        self.assertEqual(play.url, 'https://cdn.test/sharepage.mp4')
        self.assertEqual(captured, {'pwd_id': 'public-pwd', 'file_id': 'fid',
                                    'quality': '夸克原画#0101', 'share_id': 'share-id'})
        self.assertTrue(play.original)

    def test_share_file_all_paths_failed_returns_none(self):
        provider = QuarkProvider()
        fake = type('FakeGoProxy', (), {})()
        fake._quark_download_url = lambda *args: ''
        fake._quark_v2play = lambda *args: ''
        fake._quark_share_play_url = lambda *args: ''
        with patch.dict(sys.modules, {'go_proxy': fake}):
            play = provider.resolve_play_url({
                'shareId': 'share-id', 'fileId': 'fid', 'fileToken': 'token',
            }, headers={}, refresh=True)
        self.assertIsNone(play)

        provider = QuarkProvider()
        fake = type('FakeGoProxy', (), {})()
        captured = {}
        fake._quark_download_url = lambda share, fid, token, headers: captured.update(
            {'share': share, 'fid': fid, 'token': token}) or 'https://cdn.test/share-json.mp4'
        with patch.dict(sys.modules, {'go_proxy': fake}):
            play = provider.resolve_play_url({
                'shareId': 'share', 'fileId': 'fid', 'fileToken': 'a+b/c==',
                'quality': '夸克原画#0101'}, headers={}, refresh=True)
        self.assertEqual(play.url, 'https://cdn.test/share-json.mp4')
        self.assertEqual(captured['token'], 'a+b/c==')
        self.assertTrue(play.original)

    def test_share_file_with_pwd_id_uses_the_session_scoped_resolver_first(self):
        """带 pwd_id 时先建分享会话再按 fid 取流。

        share_fid_token 只在 sharepage/token 建立的会话里有效：先试无会话的
        file/download?scene=share（400 code=14001）和 v2/play（404 code=21001）
        只会白跑两次请求，最后以 502 结束。会话解析必须排在最前。
        """
        provider = QuarkProvider()
        fake = type('FakeGoProxy', (), {})()
        order = []
        captured = {}

        def share_file(pwd_id, file_id, file_token, headers, quality='', share_id=''):
            order.append('share-file')
            captured.update({'pwd_id': pwd_id, 'file_id': file_id,
                             'file_token': file_token, 'quality': quality,
                             'share_id': share_id})
            return 'https://cdn.test/ep7.mp4'

        fake._quark_share_file_play_url = share_file
        fake._quark_download_url = lambda *args: order.append('download') or ''
        fake._quark_v2play = lambda *args: order.append('v2play') or ''
        fake._quark_share_play_url = lambda *args: order.append('first-video') or ''
        with patch.dict(sys.modules, {'go_proxy': fake}):
            play = provider.resolve_play_url({
                'shareId': 'share-1', 'fileId': 'fid-ep7', 'fileToken': 'token-ep7',
                'pwdId': 'pwd-1', 'quality': '夸克原画#0101',
            }, headers={'Cookie': 'secret'}, refresh=True)
        self.assertEqual(play.url, 'https://cdn.test/ep7.mp4')
        self.assertEqual(order, ['share-file'])
        self.assertEqual(captured, {'pwd_id': 'pwd-1', 'file_id': 'fid-ep7',
                                    'file_token': 'token-ep7',
                                    'quality': '夸克原画#0101', 'share_id': 'share-1'})
        self.assertTrue(play.original)

    def test_share_link_as_file_id_still_uses_the_whole_share_flow(self):
        # fileId 其实是 pan.quark.cn/s/ 链接时没有具体 fid，只能整份分享解析。
        provider = QuarkProvider()
        fake = type('FakeGoProxy', (), {})()
        fake._quark_share_file_play_url = lambda *a, **k: 'https://cdn.test/wrong.mp4'
        fake._quark_share_play_url = lambda pwd, headers, quality='': 'https://cdn.test/share-%s.mp4' % pwd
        with patch.dict(sys.modules, {'go_proxy': fake}):
            play = provider.resolve_play_url(
                {'fileId': 'https://pan.quark.cn/s/abc123def456'}, headers={}, refresh=True)
        self.assertEqual(play.url, 'https://cdn.test/share-abc123def456.mp4')

    def test_quality_uses_unified_original_transcode_model(self):
        provider = QuarkProvider()
        fake = type('FakeGoProxy', (), {})()
        fake._quark_v2play = lambda file_id, headers: 'https://cdn.test/original.mp4'
        with patch.dict(sys.modules, {'go_proxy': fake}):
            play = provider.resolve_play_url(
                {'fileId': 'quality-fixture', 'quality': 'original'}, headers={}, refresh=True)
        self.assertEqual(play.quality, 'original')
        self.assertTrue(play.original)
        self.assertFalse(play.transcoded)
        self.assertEqual(play.variants, [])

    def test_quality_aliases_are_marked_original(self):
        provider = QuarkProvider()
        fake = type('FakeGoProxy', (), {})()
        fake._quark_v2play = lambda file_id, headers: 'https://cdn.test/original.mp4'
        with patch.dict(sys.modules, {'go_proxy': fake}):
            for quality in ('至臻', 'quark原画11', '夸克原画#0101'):
                play = provider.resolve_play_url(
                    {'fileId': 'quality-fixture', 'quality': quality}, headers={}, refresh=True)
                self.assertTrue(play.original)
                self.assertFalse(play.transcoded)

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
