# -*- coding: utf-8 -*-
"""批次 1 安全修复回归（P1-2 / P1-3 / P1-4 / P1-5 / P2-1 / P2-10）。

全部离线可跑（不真起服务器、不碰网盘）：
- P1-2/P2-10：``_is_ephemeral_play_result`` volatile 检查前置 + 失败/残缺
  结果 fail-closed，主 token 不再随 play-cache 明文落盘；
- P1-3：go_proxy ``do=pan`` token 门禁 + ``_hls_proxy_wrap`` 仅校验通过后
  附 token + server ``_attach_go_proxy_channel_token`` 对 do=pan 补 token；
- P1-4：``cleanup_jvm_cookie_files`` 只删 TVBox cookie 文件、幂等、目录缺失不抛；
- P1-5：``SupervisedRunner`` spec setdefault 注入 + ``SiteRuntimeWorker._build``
  的 hoststate.configure（monkeypatch 记录参数，不真起 Worker 进程）；
- P2-1：server / go_proxy 两侧 Host 头白名单（DNS rebinding 防御）。
"""

from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import go_proxy  # noqa: E402
import hoststate  # noqa: E402
import jar_bridge  # noqa: E402
import server  # noqa: E402
from runtime.site_worker import SiteRuntimeWorker  # noqa: E402
from runtime.supervised_runner import SupervisedRunner  # noqa: E402


TOKEN = 'sec-regress-token'


class _CIDict(dict):
    """大小写不敏感 headers 桩（模拟 starlette Headers / email.Message 的
    .get 语义，实际实现按小写键比对）。"""

    def get(self, key, default=None):
        return dict.get(self, str(key).lower(), default)


def _fake_request(headers):
    """server 侧 Request 桩：只需要 .headers.get 语义。"""
    return types.SimpleNamespace(
        headers=_CIDict({str(k).lower(): v for k, v in dict(headers or {}).items()}))


class TestEphemeralPlayResult(unittest.TestCase):
    """P1-2/P2-10：play-cache 只收「无签名、无 error、可复用」的稳定结果。"""

    def test_local_url_with_token_is_ephemeral(self):
        # jar 调 Proxy.getUrl(true) 自拼 ?token=<主token> 的载体（P1-2 主链路）
        url = 'http://127.0.0.1:9978/proxy?do=jar&x=1&token=%s' % ('a' * 40)
        self.assertTrue(server._is_ephemeral_play_result({'url': url}))
        # JSON 字符串入参同样覆盖
        self.assertTrue(server._is_ephemeral_play_result(json.dumps({'url': url})))

    def test_clean_local_url_is_stable(self):
        for host in ('127.0.0.1', 'localhost'):
            url = 'http://%s:9978/proxy?do=py&siteKey=demo' % host
            self.assertFalse(server._is_ephemeral_play_result({'url': url}), url)

    def test_proxytype_go_is_ephemeral(self):
        url = 'http://127.0.0.1:7944/?url=https%3A%2F%2Fcdn.example.com%2Fa.mp4&proxytype=go'
        self.assertTrue(server._is_ephemeral_play_result({'url': url}))

    def test_remote_signed_urls_are_ephemeral(self):
        self.assertTrue(server._is_ephemeral_play_result(
            {'url': 'https://cdn.example.com/v.mp4?sign=xyz&expires=999'}))
        self.assertTrue(server._is_ephemeral_play_result(
            {'url': 'https://cdn.example.com/v.mp4?X-Amz-Signature=abc'}))

    def test_local_url_with_volatile_param_is_ephemeral(self):
        # 回归点（P1-2 修复本体）：volatile 检查必须先于本地 host 短路。
        # 旧实现里该 URL 被判「稳定」落盘——任何未来往本地地址加签名参数
        # 的新通道都会自动落盘（审查新发现 #6）。
        url = 'http://127.0.0.1:9978/proxy?do=x&expires=12345'
        self.assertTrue(server._is_ephemeral_play_result({'url': url}))

    def test_failed_results_are_ephemeral(self):
        # P2-10：失败结果绝不落盘（含「有 url 但 error 非空」的混合形态）
        self.assertTrue(server._is_ephemeral_play_result({'url': '', 'error': 'boom'}))
        self.assertTrue(server._is_ephemeral_play_result({'error': 'boom'}))
        self.assertTrue(server._is_ephemeral_play_result(
            {'url': 'https://cdn.example.com/a.mp4', 'error': 'boom'}))
        self.assertTrue(server._is_ephemeral_play_result(
            '{"url": "", "error": "boom"}'))

    def test_plain_remote_mp4_is_stable(self):
        self.assertFalse(server._is_ephemeral_play_result(
            {'url': 'https://media.w3.org/2010/05/sintel/trailer.mp4'}))

    def test_quark_hosts_are_ephemeral(self):
        self.assertTrue(server._is_ephemeral_play_result(
            {'url': 'https://dl.quark.cn/file/x'}))

    def test_non_dict_and_broken_inputs_fail_closed(self):
        for broken in (None, 123, [1, 2], 'not-json', object()):
            self.assertTrue(server._is_ephemeral_play_result(broken), repr(broken))


class _PanHandlerFixture(unittest.TestCase):
    """go_proxy._Handler 的最小桩（沿用 test_goproxy_segstream 的模式）。"""

    def setUp(self):
        self.old_state = {'port': hoststate.get_port(), 'token': hoststate.get_token()}
        hoststate.configure(token=TOKEN)
        self.handler = object.__new__(go_proxy._Handler)
        self.handler.headers = {}
        self.handler.command = 'GET'
        self.handler._headers_sent = False
        self.events = []
        self.pan_calls = []
        self.handler.send_response = lambda s: self.events.append(('status', s))
        self.handler.send_header = lambda k, v: self.events.append(('header', k, v))
        self.handler.end_headers = lambda: self.events.append(('end',))
        self.wfile = io.BytesIO()
        self.handler.wfile = self.wfile

    def tearDown(self):
        hoststate.configure(**self.old_state)

    def _fake_pan(self, handler_self, q, head_only=False, valid_token=''):
        self.pan_calls.append({'q': q, 'valid_token': valid_token})

    def _get(self, query, headers=None):
        self.handler.headers = dict(headers or {})
        self.handler.path = '/proxy' + (query or '')
        with patch.object(go_proxy, '_fetch', return_value=object()), \
                patch.object(go_proxy._Handler, '_handle_pan', self._fake_pan):
            self.handler._handle()


class TestGoProxyPanTokenGate(_PanHandlerFixture):
    """P1-3：do=pan 与 ？url= 同权鉴权，无 token 的本机任意进程被拒。"""

    def test_missing_token_rejected(self):
        self._get('?do=pan&site=quark&shareId=s1&fileId=f1')
        self.assertIn(('status', 401), self.events)
        self.assertNotIn(('status', 200), self.events)
        self.assertIn(b'requires valid token', self.wfile.getvalue())
        self.assertEqual(self.pan_calls, [])

    def test_wrong_token_rejected(self):
        self._get('?do=pan&site=quark&fileId=f1&token=wrong')
        self.assertIn(('status', 401), self.events)
        self.assertEqual(self.pan_calls, [])

    def test_valid_token_query_reaches_pan(self):
        self._get('?do=pan&site=quark&fileId=f1&token=' + TOKEN)
        self.assertNotIn(('status', 401), self.events)
        self.assertEqual(len(self.pan_calls), 1)
        self.assertEqual(self.pan_calls[0]['valid_token'], TOKEN)

    def test_valid_token_header_reaches_pan(self):
        self._get('?do=pan&site=quark&fileId=f1',
                  headers={'X-Proxy-Token': TOKEN})
        self.assertNotIn(('status', 401), self.events)
        self.assertEqual(self.pan_calls[0]['valid_token'], TOKEN)


class TestHlsWrapTokenDiscipline(_PanHandlerFixture):
    """P1-3：HLS 重写只在调用方已通过 token 校验时附加 token。"""

    def test_hls_wrap_without_token_has_no_token_param(self):
        out = go_proxy._hls_proxy_wrap('https://cdn.example.com/seg0.ts')
        self.assertTrue(out.startswith('http://127.0.0.1:%d/proxy?url=' % go_proxy.PORT))
        self.assertNotIn('token=', out)

    def test_hls_wrap_with_validated_token_appends_it(self):
        out = go_proxy._hls_proxy_wrap('https://cdn.example.com/seg0.ts', token=TOKEN)
        self.assertIn('token=' + TOKEN, out)

    def test_rewrite_playlist_token_follows_argument(self):
        text = '#EXTM3U\nhttps://cdn.example.com/seg0.ts\n'
        plain = go_proxy._rewrite_hls_playlist('https://cdn.example.com/master.m3u8', text)
        self.assertNotIn('token=', plain)
        signed = go_proxy._rewrite_hls_playlist(
            'https://cdn.example.com/master.m3u8', text, token=TOKEN)
        self.assertIn('token=' + TOKEN, signed)
        self.assertIn('seg0.ts', signed)

    def test_send_hls_playlist_reuses_request_token(self):
        # _send_hls_playlist 是 go_proxy 模块级函数（self 显式传入），
        # 重写出的分片必须带上调用方已通过校验的 token（P1-3）。
        resp = types.SimpleNamespace(
            status_code=200, content=b'#EXTM3U\nhttps://cdn.example.com/seg0.ts\n',
            headers={'Content-Type': 'application/vnd.apple.mpegurl'},
            close=lambda: None)
        with patch.object(go_proxy, '_fetch', return_value=resp):
            ok = go_proxy._send_hls_playlist(
                self.handler, 'https://cdn.example.com/master.m3u8', {}, False,
                token=TOKEN)
        self.assertTrue(ok)
        self.assertIn(('status', 200), self.events)
        body = self.wfile.getvalue().decode('utf-8')
        self.assertIn('token=' + TOKEN, body)
        self.assertIn('seg0.ts', body)


class TestServerAttachesPanToken(unittest.TestCase):
    """P1-3：_attach_go_proxy_channel_token 对缺 token 的 do=pan 地址补 token。"""

    def setUp(self):
        self.old_state = {'port': hoststate.get_port(), 'token': hoststate.get_token()}
        hoststate.configure(token=TOKEN)

    def tearDown(self):
        hoststate.configure(**self.old_state)

    def _normalize_url(self, raw):
        return json.loads(server._normalize_play_result({'url': raw}))['url']

    def test_do_pan_without_url_gets_token(self):
        raw = 'http://127.0.0.1:9978/proxy?do=pan&site=quark&fileId=f1'
        out = self._normalize_url(raw)
        self.assertIn('token=' + TOKEN, out)

    def test_do_pan_with_token_not_duplicated(self):
        raw = 'http://127.0.0.1:9978/proxy?do=pan&site=quark&fileId=f1&token=' + TOKEN
        self.assertEqual(self._normalize_url(raw), raw)

    def test_non_pan_channels_still_untouched(self):
        raw = 'http://127.0.0.1:9978/proxy?do=js&siteKey=demo'
        self.assertNotIn('token=', self._normalize_url(raw))


class TestJarCookieCleanup(unittest.TestCase):
    """P1-4：强杀 JVM 后补删 TVBox/*_cookie.txt 明文登录态。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='yuki-sec-jar-')
        self.tvbox = os.path.join(self.tmp, 'TVBox')
        os.makedirs(self.tvbox)
        self._orig_dir = jar_bridge._JVM_COOKIE_DIR
        jar_bridge._JVM_COOKIE_DIR = self.tvbox

    def tearDown(self):
        jar_bridge._JVM_COOKIE_DIR = self._orig_dir
        shutil.rmtree(self.tmp, ignore_errors=True)

    @staticmethod
    def _seed(tvbox):
        cookie_names = ('quark_cookie.txt', 'uc_cookie.txt', 'bili_cookie.txt')
        keep_names = ('playlist.json', 'sub.ass', 'other_cookie.bak')
        for name in cookie_names + keep_names:
            with open(os.path.join(tvbox, name), 'wb') as f:
                f.write(b'secret')
        return cookie_names, keep_names

    def test_deletes_only_cookie_files(self):
        cookie_names, keep_names = self._seed(self.tvbox)
        jar_bridge.cleanup_jvm_cookie_files()
        for name in cookie_names:
            self.assertFalse(os.path.exists(os.path.join(self.tvbox, name)), name)
        for name in keep_names:
            self.assertTrue(os.path.exists(os.path.join(self.tvbox, name)), name)

    def test_idempotent(self):
        self._seed(self.tvbox)
        jar_bridge.cleanup_jvm_cookie_files()
        jar_bridge.cleanup_jvm_cookie_files()  # 第二次为空 cookie 集，不抛
        # cookie 文件已被首次清理删光；非 cookie 文件保留（不重复删 ≠ 全清空）
        for name in ('playlist.json', 'sub.ass', 'other_cookie.bak'):
            self.assertTrue(os.path.exists(os.path.join(self.tvbox, name)), name)
        for name in ('quark_cookie.txt', 'uc_cookie.txt', 'bili_cookie.txt'):
            self.assertFalse(os.path.exists(os.path.join(self.tvbox, name)), name)

    def test_missing_dir_is_safe(self):
        jar_bridge._JVM_COOKIE_DIR = os.path.join(self.tmp, 'no-such-dir')
        jar_bridge.cleanup_jvm_cookie_files()  # 目录缺失直接返回，不抛

    def test_mixed_case_suffix_still_removed(self):
        with open(os.path.join(self.tvbox, 'Quark_Cookie.TXT'), 'wb') as f:
            f.write(b'x')
        jar_bridge.cleanup_jvm_cookie_files()
        self.assertEqual(os.listdir(self.tvbox), [])


class TestWorkerHoststateInjection(unittest.TestCase):
    """P1-5：宿主经 spec 注入 proxy_port/proxy_token/data_dir，Worker 自行 configure。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='yuki-sec-worker-')
        self.old_state = {
            'port': hoststate.get_port(),
            'token': hoststate.get_token(),
            'data_dir': hoststate.get_data_dir(),
        }
        self.spider_file = os.path.join(self.tmp, 'stub_spider.py')
        with open(self.spider_file, 'w', encoding='utf-8') as f:
            f.write('class Spider:\n    pass\n')

    def tearDown(self):
        hoststate.configure(**self.old_state)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_supervised_runner_spec_setdefault(self):
        hoststate.configure(port=12345, token='spec-token', data_dir=self.tmp)
        runner = SupervisedRunner({'kind': 'python', 'site_key': 'spec-test',
                                   'path': self.spider_file})
        try:
            spec = runner.supervisor.spec
            self.assertEqual(spec.get('proxy_port'), 12345)
            self.assertEqual(spec.get('proxy_token'), 'spec-token')
            self.assertEqual(str(spec.get('data_dir')), self.tmp)
        finally:
            runner.destroy()

    def test_supervised_runner_does_not_override_existing_spec(self):
        hoststate.configure(port=12345, token='spec-token', data_dir=self.tmp)
        explicit_dir = os.path.join(self.tmp, 'explicit')
        runner = SupervisedRunner({'kind': 'python', 'site_key': 'spec-test2',
                                   'path': self.spider_file,
                                   'proxy_port': 22222,
                                   'proxy_token': 'explicit-token',
                                   'data_dir': explicit_dir})
        try:
            spec = runner.supervisor.spec
            self.assertEqual(spec.get('proxy_port'), 22222)
            self.assertEqual(spec.get('proxy_token'), 'explicit-token')
            self.assertEqual(str(spec.get('data_dir')), explicit_dir)
        finally:
            runner.destroy()

    def test_site_worker_configures_hoststate_from_spec(self):
        recorded = {}

        def fake_configure(**kwargs):
            recorded.update(kwargs)

        with patch.object(hoststate, 'configure', fake_configure):
            worker = SiteRuntimeWorker({'kind': 'python', 'site_key': 'cfg-sp',
                                        'path': self.spider_file,
                                        'proxy_port': 23456,
                                        'proxy_token': 'tok-worker',
                                        'data_dir': self.tmp})
        try:
            self.assertEqual(recorded, {'port': 23456, 'token': 'tok-worker',
                                        'data_dir': self.tmp})
        finally:
            worker.destroy()

    def test_site_worker_configure_failure_is_swallowed(self):
        # configure 抛错时 _build 不得带崩 Worker 构造（fail-soft 与实现一致）
        def boom(**kwargs):
            raise RuntimeError('disk gone')

        with patch.object(hoststate, 'configure', boom):
            worker = SiteRuntimeWorker({'kind': 'python', 'site_key': 'cfg-sp2',
                                        'path': self.spider_file,
                                        'proxy_port': 23456,
                                        'proxy_token': 'tok-worker',
                                        'data_dir': self.tmp})
        worker.destroy()
        self.assertIsNotNone(worker.runner)


class TestHostHeaderWhitelist(unittest.TestCase):
    """P2-1：server / go_proxy 两侧 Host 头白名单（DNS rebinding 防御）。"""

    def test_server_whitelist(self):
        reject = server._browser_origin_rejected
        self.assertFalse(reject(_fake_request({'Host': '127.0.0.1:9978'})))
        self.assertFalse(reject(_fake_request({'Host': 'localhost'})))
        self.assertFalse(reject(_fake_request({})))  # 无 Host 的非浏览器客户端放行
        for bad in ('evil.com', 'evil.com:80', '127.0.0.1.evil.com', '2130706433'):
            self.assertTrue(reject(_fake_request({'Host': bad})), bad)
        # 已知解析边界（记录现状，非浏览器可达）：urlsplit 按第一个冒号切
        # host/port，'127.0.0.1:9978.evil.com' 的 hostname 是 '127.0.0.1' 而
        # 被放行。浏览器无法产出该 Host（URL 端口段非数字即非法），本机进程
        # 本就不受该白名单约束（数据面另有 token 门禁），故不构成可利用缺口。
        self.assertFalse(reject(
            _fake_request({'Host': '127.0.0.1:9978.evil.com'})))

    def test_server_health_guard(self):
        guard = server._host_header_allowed
        self.assertTrue(guard(_fake_request({'Host': '127.0.0.1:8321'})))
        self.assertTrue(guard(_fake_request({})))
        self.assertFalse(guard(_fake_request({'Host': 'evil.com'})))
        self.assertFalse(guard(_fake_request({'Host': '[::1'})))  # 畸形 Host 拒绝

    def test_server_origin_rules_still_apply_after_host_pass(self):
        reject = server._browser_origin_rejected
        self.assertTrue(reject(_fake_request(
            {'Host': '127.0.0.1:9978', 'Origin': 'https://evil.com'})))
        self.assertTrue(reject(_fake_request(
            {'Host': '127.0.0.1:9978', 'Sec-Fetch-Site': 'cross-site'})))

    def test_go_proxy_whitelist(self):
        handler = object.__new__(go_proxy._Handler)
        cases = (
            ({'Host': '127.0.0.1:9978'}, False),
            ({'Host': 'localhost'}, False),
            ({}, False),
            ({'Host': 'evil.com'}, True),
            ({'Host': 'evil.com:80'}, True),
            ({'Host': '127.0.0.1.evil.com'}, True),
        )
        for headers, expected_reject in cases:
            handler.headers = dict(headers)
            self.assertEqual(handler._reject_browser(), expected_reject, headers)

    def test_go_proxy_origin_rules_still_apply_after_host_pass(self):
        handler = object.__new__(go_proxy._Handler)
        handler.headers = {'Host': '127.0.0.1:9978', 'Origin': 'https://evil.com'}
        self.assertTrue(handler._reject_browser())
        handler.headers = {'Host': '127.0.0.1:9978', 'Sec-Fetch-Site': 'cross-site'}
        self.assertTrue(handler._reject_browser())


if __name__ == '__main__':
    unittest.main()
