# -*- coding: utf-8 -*-
"""夸克网盘 jar 优先/降级/快路径行为回归。"""
import json
import os
import sys
import unittest
from unittest.mock import patch
from urllib.parse import unquote

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import go_proxy
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
        # 默认视为已登录（本机存有夸克 Cookie）：快路径行为用例关注的是
        # vodId 分流本身；无 Cookie 的门禁行为由专门的用例覆盖。
        self._cookie_patch = patch('jar_spider._quark_cookie_present', return_value=True)
        self._cookie_patch.start()

    def tearDown(self):
        self._cookie_patch.stop()
        hoststate.configure(pan_fast_path=self.original)

    @staticmethod
    def pan_id():
        return json.dumps([{'folder': 'fid/with space', 'shareId': ''}], ensure_ascii=False)

    @staticmethod
    def share_pwd_id():
        """公开分享 + pwd_id：PC 侧能用 sharepage/token 建立分享会话。"""
        return json.dumps([{
            'folder': 'fid-3087', 'shareId': 'share-1', 'pwd_id': '3087d71e8e10',
            'share_fid_token': 'zeCfV4Mll6+sQ/V1fV3t1XGTZyu/0hcccUv3YMTnbgI=',
        }], ensure_ascii=False)

    def test_fast_path_short_circuits_jar_and_preserves_quality_and_plus_token(self):
        hoststate.configure(pan_fast_path=True)
        spider = FakeJarSpider({'url': 'http://jar.example/video.mp4', 'parse': 0})
        result = spider.playerContentRaw('quark原画11', self.share_pwd_id(), [])
        self.assertEqual(spider.calls, [])
        self.assertEqual(result['quality'], 'quark原画11')
        self.assertIn('quality=quark%E5%8E%9F%E7%94%BB11', result['url'])
        self.assertIn('pwdId=3087d71e8e10', result['url'])
        self.assertIn('fileToken=zeCfV4Mll6%2BsQ%2FV1fV3t1XGTZyu%2F0hcccUv3YMTnbgI%3D', result['url'])

    def test_opaque_five_part_id_carries_the_share_pwd_id(self):
        """5 段式 vodId 的第三段是分享 pwd_id，必须带进 do=pan。

        没有它 PC 侧建不起分享会话（file/download?scene=share → 400 code=14001，
        v2/play → 404 code=21001）。
        """
        hoststate.configure(pan_fast_path=True)
        opaque = ('e82821cd12fc4fc388ebefc2a386dfd4++06804dc9322f93683f01266834acc048'
                  '++3087d71e8e10++zeCfV4Mll6+sQ/V1fV3t1XGTZyu/0hcccUv3YMTnbgI='
                  '++2225762855')
        params = JarSpider._quark_play_params(opaque)
        self.assertEqual(params['shareId'], 'e82821cd12fc4fc388ebefc2a386dfd4')
        self.assertEqual(params['fileId'], '06804dc9322f93683f01266834acc048')
        self.assertEqual(params['pwdId'], '3087d71e8e10')
        self.assertTrue(JarSpider._pan_resolvable(params))

        spider = FakeJarSpider(None)
        result = spider.playerContentRaw('quark原画11', opaque, [])
        self.assertEqual(spider.calls, [])
        self.assertIn('shareId=e82821cd12fc4fc388ebefc2a386dfd4', result['url'])
        self.assertIn('fileId=06804dc9322f93683f01266834acc048', result['url'])
        self.assertIn('pwdId=3087d71e8e10', result['url'])
        self.assertIn('fileToken=zeCfV4Mll6%2BsQ%2FV1fV3t1XGTZyu%2F0hcccUv3YMTnbgI%3D', result['url'])

    def test_opaque_id_does_not_guess_a_fid_shaped_middle_part(self):
        # 第三段又是 32 位 hex（另一个 fid/share_id）时不能当 pwd_id 用，
        # 否则 sharepage/token 必失败，还白丢了 JAR 这条能解的路。
        opaque = ('e82821cd12fc4fc388ebefc2a386dfd4++06804dc9322f93683f01266834acc048'
                  '++06804dc9322f93683f01266834acc048++token++123')
        params = JarSpider._quark_play_params(opaque)
        self.assertNotIn('pwdId', params)
        self.assertFalse(JarSpider._pan_resolvable(params))
        self.assertEqual(JarSpider._vod_id_shape(opaque), 'opaque parts=5 lens=32,32,32,5,3')

    def test_share_without_pwd_id_is_left_to_the_jar(self):
        """只有 shareId+fid+fid_token 的公开分享不能走 PC 快路径。

        share_fid_token 只在 sharepage/token 建立的分享会话里有效，PC 侧没有
        pwd_id 就建不起会话：实测 file/download?scene=share 回 400 code=14001、
        v2/play 回 404 code=21001，do=pan 只能回 502，mpv 直接退出。JAR 在
        detailContent 阶段就持有分享会话，这类 vodId 必须交回它解析，
        失败时也要保留 JAR 的错误原因，而不是伪装成一条必失败的 do=pan。
        """
        hoststate.configure(pan_fast_path=True)
        value = json.dumps([{'folder': 'fid-share', 'shareId': 'share-1',
                             'share_fid_token': 'token-1'}], ensure_ascii=False)
        params = JarSpider._quark_play_params(value)
        self.assertFalse(JarSpider._pan_resolvable(params))
        self.assertEqual(JarSpider._vod_id_shape(value),
                         'params=fileId,fileToken,shareId')

        # JAR 明确返回 null（Cookie 失效/分享失效）：保留可读原因，
        # 不替换成一条必然 502 的 do=pan。
        spider = FakeJarSpider('null')
        result = spider.playerContentRaw('quark原画11', value, [])
        self.assertEqual(spider.calls[0][0], 'playerContent')
        self.assertNotIn('do=pan', result['url'])
        self.assertTrue(spider.last_error)

    def test_jar_resolved_cdn_url_keeps_credentialed_stream_channel(self):
        """PC 侧解不开时，JAR 解出的裸 CDN 直链只补取流通道，不换成 do=pan。

        换成 do=pan 等于把「JAR 已经解出来、只差 Cookie」变成「后端必回 502」。
        """
        hoststate.configure(pan_fast_path=True)
        value = json.dumps([{'folder': 'fid-share', 'shareId': 'share-1',
                             'share_fid_token': 'token-1'}], ensure_ascii=False)
        spider = FakeJarSpider(
            {'url': 'https://dl-pc-zb.drive.quark.cn/resolved.mp4', 'parse': 0})
        result = spider.playerContentRaw('f', value, [])
        self.assertEqual(spider.calls[0][0], 'playerContent')
        self.assertNotIn('do=pan', result['url'])
        self.assertIn('proxytype=go', result['url'])
        self.assertIn('dl-pc-zb.drive.quark.cn', unquote(result['url']))
        self.assertEqual(result['parse'], 0)

    def test_fast_path_accepts_json_object_and_url_encoded_id(self):
        hoststate.configure(pan_fast_path=True)
        value = '%7B%22fileId%22%3A%22fid-object%22%2C%22share_id%22%3A%22share-2%22%7D'
        params = JarSpider._quark_play_params(value)
        self.assertEqual(params['fileId'], 'fid-object')
        self.assertEqual(params['shareId'], 'share-2')
        # 同一编码形式带上 pwdId 后 PC 侧解得开 → 短路 JAR。
        with_pwd = ('%7B%22fileId%22%3A%22fid-object%22%2C%22share_id%22%3A%22share-2%22'
                    '%2C%22pwd_id%22%3A%22pwd-2%22%7D')
        spider = FakeJarSpider({'url': with_pwd, 'parse': 1})
        result = spider.playerContentRaw('f', with_pwd, [])
        self.assertIn('fileId=fid-object', result['url'])
        self.assertIn('shareId=share-2', result['url'])
        self.assertIn('pwdId=pwd-2', result['url'])
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

    def test_bare_quark_cdn_result_is_replaced_by_pan_proxy(self):
        # 裸 CDN 直链交给 mpv 时不带 Cookie，上游必 403/412；换成 do=pan。
        hoststate.configure(pan_fast_path=False)
        spider = FakeJarSpider(
            {'url': 'https://dl-pc-zb.drive.quark.cn/one-shot.mp4', 'parse': 0})
        result = spider.playerContentRaw('f', self.pan_id(), [])
        self.assertIn('do=pan', result['url'])
        self.assertEqual(result['parse'], 0)

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

    def test_fast_path_skipped_when_no_quark_cookie_stored(self):
        """无本机夸克 Cookie：快路径跳过交回 JAR（部分站点 jar 自带凭据）。

        Provider 取流匿名必败（v2/play 401 code=31001），此时把可解析的
        vodId 短路成 do=pan 只会得到 502；JAR 先行才有机会出直链。
        """
        hoststate.configure(pan_fast_path=True)
        with patch('jar_spider._quark_cookie_present', return_value=False):
            spider = FakeJarSpider({'url': 'http://jar.example/video.mp4', 'parse': 0})
            result = spider.playerContentRaw('quark原画11', self.share_pwd_id(), [])
        self.assertEqual(spider.calls[0][0], 'playerContent')
        self.assertEqual(result['url'], 'http://jar.example/video.mp4')

    def test_no_cookie_pan_request_fails_fast_with_502(self):
        """go-proxy 无 Cookie 的 do=pan 请求：立即 502，不打上游接口。

        回归背景：未登录时旧链路仍会跑完 token→v2play(401/31001)→
        download(400/14001)→转存→个人盘重试（约 11 次上游请求、4 秒），
        最后才回 502。门禁必须在任何上游调用前拒绝。
        """
        import io

        handler = object.__new__(go_proxy._Handler)
        handler.headers = {}
        handler.command = 'GET'
        handler.events = []
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: handler.events.append(('status', status))
        handler.send_header = lambda key, value: handler.events.append(('header', key, value))
        handler.end_headers = lambda: handler.events.append(('end',))

        def _no_upstream(*args, **kwargs):
            raise AssertionError('upstream call must not happen without cookie')

        with patch('pan_cookies.load_pan_cookies', return_value={}), \
                patch.object(go_proxy, '_qpost', _no_upstream), \
                patch.object(go_proxy, '_qget', _no_upstream):
            handler._handle_pan({'do': ['pan'], 'site': ['quark'],
                                 'pwdId': ['pwd-1'], 'fileId': ['fid-1']})
        self.assertIn(('status', 502), handler.events)
        self.assertNotIn(('status', 200), handler.events)
        self.assertIn(b'quark login required', handler.wfile.getvalue())

    def test_cookie_header_pan_request_bypasses_the_gate(self):
        """请求头自带 Cookie（jar 转发场景）时不走 502 门禁，照常进入取流。"""
        import io

        class _FakeProvider:
            key = 'quark'

            def __init__(self):
                self.seen_headers = None

            def resolve_play_url(self, params, *, headers, refresh=False):
                self.seen_headers = dict(headers)

                class _Play:
                    url = 'https://cdn.test/fid-9.mp4'
                    headers = {'User-Agent': 'fixture'}

                return _Play()

        provider = _FakeProvider()
        handler = object.__new__(go_proxy._Handler)
        handler.headers = {'Cookie': '__pus=fixture'}
        handler.command = 'GET'
        handler.events = []
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: handler.events.append(('status', status))
        handler.send_header = lambda key, value: handler.events.append(('header', key, value))
        handler.end_headers = lambda: handler.events.append(('end',))
        handler._stream_forward = (
            lambda url, headers, head_only, refresh=None:
            handler.events.append(('stream', url)))

        with patch('pan.registry.registry.get', return_value=provider), \
                patch('pan_cookies.load_pan_cookies',
                      side_effect=AssertionError(
                          'storage must not be read when header has cookie')):
            handler._handle_pan({'do': ['pan'], 'site': ['quark'],
                                 'shareId': ['share-9'], 'fileId': ['fid-9'],
                                 'fileToken': ['tok-9']})
        # 未被门禁拦截：进入 Provider 取流（stub 不发状态行，故无任何 status 事件）。
        self.assertEqual([e for e in handler.events if e[0] == 'status'], [])
        self.assertEqual([e for e in handler.events if e[0] == 'stream'],
                         [('stream', 'https://cdn.test/fid-9.mp4')])
        # 取流沿用请求头透传的 Cookie（Provider 收到的 headers 带 Cookie）。
        self.assertEqual(provider.seen_headers.get('Cookie'), '__pus=fixture')


class _FakeResponse:
    def __init__(self, payload, status=200, headers=None):
        self._payload = payload
        self.status_code = status
        self.headers = headers or {}

    def json(self):
        return self._payload

    def close(self):
        pass


class TestQuarkShareFilePlay(unittest.TestCase):
    """公开分享中指定文件的取流：必须先建分享会话，且只播被点的那一集。"""

    def setUp(self):
        go_proxy._SHARE_CACHE.clear()

    def tearDown(self):
        go_proxy._SHARE_CACHE.clear()

    def test_share_session_is_established_before_playing_the_requested_fid(self):
        calls = []

        def fake_qpost(url, **kwargs):
            calls.append(url)
            return _FakeResponse({'data': {'stoken': 'stoken-1'}})

        def fake_v2play(fid, headers, quality=''):
            calls.append(('v2play', fid, quality))
            return 'https://cdn.test/%s.mp4' % fid

        with patch.object(go_proxy, '_qpost', fake_qpost), \
                patch.object(go_proxy, '_quark_v2play', fake_v2play):
            url = go_proxy._quark_share_file_play_url(
                'pwd-1', 'fid-ep7', 'token-ep7', {'Cookie': 'secret'},
                quality='原画', share_id='share-1')
        self.assertEqual(url, 'https://cdn.test/fid-ep7.mp4')
        self.assertIn('share/sharepage/token', calls[0])
        self.assertEqual(calls[1], ('v2play', 'fid-ep7', '原画'))
        # stoken 入缓存，同一分享的下一集不再重新申请。
        self.assertEqual(go_proxy._SHARE_CACHE['pwd-1']['stoken'], 'stoken-1')
        with patch.object(go_proxy, '_qpost', fake_qpost), \
                patch.object(go_proxy, '_quark_v2play', fake_v2play):
            go_proxy._quark_share_file_play_url(
                'pwd-1', 'fid-ep8', 'token-ep8', {'Cookie': 'secret'})
        self.assertEqual([c for c in calls if isinstance(c, str)], [calls[0]])

    def test_requested_fid_is_saved_when_share_play_is_refused(self):
        """v2/play 与 file/download 都被拒时转存**这一集**，不退回第一个视频。"""
        saved = {}

        def fake_save(pwd_id, stoken, fid, fid_token, headers):
            saved.update({'pwd_id': pwd_id, 'stoken': stoken, 'fid': fid,
                          'fid_token': fid_token})
            return 'personal-fid'

        def fake_download(share_id, file_id, file_token, headers):
            raise ValueError('download URL unavailable (status 400)')

        with patch.object(go_proxy, '_qpost',
                          lambda url, **kwargs: _FakeResponse({'data': {'stoken': 'stoken-2'}})), \
                patch.object(go_proxy, '_quark_v2play', lambda *a, **k: None), \
                patch.object(go_proxy, '_quark_download_url', fake_download), \
                patch.object(go_proxy, '_quark_save_share', fake_save), \
                patch.object(go_proxy, '_quark_personal_play_url',
                             lambda fid, headers, retries=1, quality='':
                             'https://cdn.test/%s.mp4' % fid):
            url = go_proxy._quark_share_file_play_url(
                'pwd-2', 'fid-ep7', 'token-ep7', {}, share_id='share-1')
        self.assertEqual(url, 'https://cdn.test/personal-fid.mp4')
        self.assertEqual(saved, {'pwd_id': 'pwd-2', 'stoken': 'stoken-2',
                                 'fid': 'fid-ep7', 'fid_token': 'token-ep7'})

    def test_missing_pwd_id_fails_fast_without_network(self):
        # pwd_id 为空时无法建立分享会话，不能盲发请求。
        calls = []
        with patch.object(go_proxy, '_qpost', lambda *a, **k: calls.append(a) or None):
            with self.assertRaises(ValueError):
                go_proxy._quark_share_file_play_url('', 'fid', 'token', {})
        self.assertEqual(calls, [])


class TestQuarkShareStaleMetadataRefresh(unittest.TestCase):
    """聚合站页面缓存的 fid/share_fid_token 过期后的自愈行为。

    真实案例（夸克盘社）：vodId 里的 fileId/fileToken 是分享发布时的快照，
    分享者更新文件后夸克轮换令牌——转存报 41020「转存文件token校验异常」，
    v2/play 21001、file/download 14001。修复：转存失败后实时拉取分享目录树，
    用当前条目重定位（fileId 优先、shareId 参数次之）再转存一次。
    """

    def setUp(self):
        go_proxy._SAVE_CACHE.pop('pwd-2:fid-ep7', None)
        go_proxy._SAVE_CACHE.pop('pwd-2:share-1', None)
        go_proxy._SHARE_CACHE.pop('pwd-2', None)

    def tearDown(self):
        go_proxy._SAVE_CACHE.pop('pwd-2:fid-ep7', None)
        go_proxy._SAVE_CACHE.pop('pwd-2:share-1', None)
        go_proxy._SHARE_CACHE.pop('pwd-2', None)

    @staticmethod
    def _fake_qget(entries_by_pdir):
        """按请求里的 pdir_fid 返回预置列表，未命中返回空列表。"""

        def fake_qget(url, **kwargs):
            pdir = ''
            for seg in str(url).split('&'):
                if seg.startswith('pdir_fid='):
                    pdir = seg.split('=', 1)[1]
            return _FakeResponse({'data': {'list': entries_by_pdir.get(pdir, [])}})
        return fake_qget

    def test_save_retried_with_fresh_token_from_share_tree(self):
        saved = []

        def fake_save(pwd_id, stoken, fid, fid_token, headers):
            saved.append((fid, fid_token))
            if fid_token == 'token-stale':
                raise ValueError('save task id empty')
            return 'personal-fid'

        tree = {'0': [{'fid': 'dir-1', 'dir': True},
                      {'fid': 'fid-other', 'share_fid_token': 't-x', 'file': True}],
                'dir-1': [{'fid': 'share-1', 'share_fid_token': 'token-live',
                           'file': True}]}

        with patch.object(go_proxy, '_qpost',
                          lambda url, **kwargs:
                          _FakeResponse({'data': {'stoken': 'stoken-9'}}) if
                          'sharepage/token' in str(url) else None), \
                patch.object(go_proxy, '_qget', self._fake_qget(tree)), \
                patch.object(go_proxy, '_quark_v2play', lambda *a, **k: None), \
                patch.object(go_proxy, '_quark_download_url',
                             lambda *a, **k: (_ for _ in ()).throw(
                                 ValueError('download URL unavailable'))), \
                patch.object(go_proxy, '_quark_save_share', fake_save), \
                patch.object(go_proxy, '_quark_personal_play_url',
                             lambda fid, headers, retries=1, quality='':
                             'https://cdn.test/%s.mp4' % fid):
            url = go_proxy._quark_share_file_play_url(
                'pwd-2', 'fid-ep7', 'token-stale', {}, share_id='share-1')
        self.assertEqual(url, 'https://cdn.test/personal-fid.mp4')
        # 第一次用原值失败；自愈后用目录树里的新鲜条目（shareId 位的活 fid）
        self.assertEqual(saved, [('fid-ep7', 'token-stale'),
                                 ('share-1', 'token-live')])

    def test_refresh_miss_keeps_original_failure(self):
        def fake_save(pwd_id, stoken, fid, fid_token, headers):
            raise ValueError('save task id empty')

        with patch.object(go_proxy, '_qpost',
                          lambda url, **kwargs:
                          _FakeResponse({'data': {'stoken': 'stoken-9'}}) if
                          'sharepage/token' in str(url) else None), \
                patch.object(go_proxy, '_qget', self._fake_qget({})), \
                patch.object(go_proxy, '_quark_v2play', lambda *a, **k: None), \
                patch.object(go_proxy, '_quark_download_url',
                             lambda *a, **k: ''), \
                patch.object(go_proxy, '_quark_save_share', fake_save), \
                patch.object(go_proxy, '_quark_personal_play_url',
                             lambda fid, headers, retries=1, quality='': ''):
            with self.assertRaises(ValueError):
                go_proxy._quark_share_file_play_url(
                    'pwd-2', 'fid-ep7', 'token-stale', {}, share_id='share-1')

    def test_valid_tokens_skip_tree_lookup(self):
        """令牌有效时转存一把过：除既有文件夹兜底外，无额外目录树遍历。"""
        qget_calls = []
        fake_qget = self._fake_qget({})

        def counting_qget(url, **kwargs):
            qget_calls.append(str(url))
            return fake_qget(url, **kwargs)

        with patch.object(go_proxy, '_qpost',
                          lambda url, **kwargs:
                          _FakeResponse({'data': {'stoken': 'stoken-9'}}) if
                          'sharepage/token' in str(url) else None), \
                patch.object(go_proxy, '_qget', counting_qget), \
                patch.object(go_proxy, '_quark_v2play', lambda *a, **k: None), \
                patch.object(go_proxy, '_quark_download_url',
                             lambda *a, **k: ''), \
                patch.object(go_proxy, '_quark_save_share',
                             lambda *a, **k: 'personal-fid'), \
                patch.object(go_proxy, '_quark_personal_play_url',
                             lambda fid, headers, retries=1, quality='':
                             'https://cdn.test/x.mp4'):
            url = go_proxy._quark_share_file_play_url(
                'pwd-2', 'fid-ok', 'token-ok', {})
        self.assertEqual(url, 'https://cdn.test/x.mp4')
        # 只允许既有文件夹兜底的这一次 detail（对原 fid），不得触发树遍历
        self.assertEqual(len(qget_calls), 1)
        self.assertIn('pdir_fid=fid-ok', qget_calls[0])


if __name__ == '__main__':
    unittest.main()
