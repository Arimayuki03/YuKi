# -*- coding: utf-8 -*-
"""WebDAV 连接测试语义回环测试。

webdav_test 用 PROPFIND（Depth 0）探测同步目录：
- 200/207 → ok；
- 401/403 → 认证失败（用户名或密码错误）；
- 其他状态码（多为 404）→ 先 MKCOL 建目录再复测一次；
- 网络/DNS/SSL 异常 → ok=False + 异常原因。
不访问外网：monkeypatch 全局 requests.request（webdav_test 内部局部 import，
sys.modules 缓存使补丁对生产代码同样生效）。
"""

from __future__ import annotations

import os
import sys
import unittest

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import kazumi.plugin_manager as pm  # noqa: E402
import requests  # noqa: E402


class _Rsp:
    def __init__(self, status):
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise OSError(f'HTTP {self.status_code}')


class WebdavConnTests(unittest.TestCase):
    def setUp(self):
        self._orig_request = requests.request
        self._orig_put = requests.put
        self.calls = []       # [(method, url), ...]
        self.kwargs_log = []  # 每次调用的 kwargs（校验 verify 透传）

    def tearDown(self):
        requests.request = self._orig_request
        requests.put = self._orig_put

    def _install(self, responses):
        """按顺序返回预设响应的假 requests.request。"""
        def fake(method, url, **kwargs):
            self.calls.append((method, url))
            self.kwargs_log.append(kwargs)
            return responses.pop(0)

        requests.request = fake

    def _boom(self, method, url, **kwargs):
        self.calls.append((method, url))
        raise OSError('certificate verify failed')

    URL = 'https://nas.example/dav'

    def test_propfind_207_ok(self):
        self._install([_Rsp(207)])
        r = pm.PluginManager.webdav_test(None, self.URL, 'u', 'p')
        self.assertTrue(r['ok'])
        self.assertEqual(r['error'], '')
        self.assertEqual([c[0] for c in self.calls], ['PROPFIND'])

    def test_auth_failed_reported(self):
        self._install([_Rsp(401)])
        r = pm.PluginManager.webdav_test(None, self.URL, 'u', 'wrong')
        self.assertFalse(r['ok'])
        self.assertIn('认证失败', r['error'])

    def test_404_creates_dir_then_ok(self):
        self._install([_Rsp(404), _Rsp(201), _Rsp(207)])
        r = pm.PluginManager.webdav_test(None, self.URL, '', '')
        self.assertTrue(r['ok'])
        self.assertEqual([(m, u) for m, u in self.calls], [
            ('PROPFIND', f'{self.URL}/YuKiSync'),
            ('MKCOL', f'{self.URL}/YuKiSync'),
            ('PROPFIND', f'{self.URL}/YuKiSync'),
        ])

    def test_mkcol_recheck_still_fails(self):
        self._install([_Rsp(404), _Rsp(201), _Rsp(502)])
        r = pm.PluginManager.webdav_test(None, self.URL, '', '')
        self.assertFalse(r['ok'])
        self.assertIn('502', r['error'])

    def test_connection_error_fails_loudly(self):
        requests.request = self._boom
        r = pm.PluginManager.webdav_test(None, self.URL, '', '')
        self.assertFalse(r['ok'])
        self.assertIn('certificate verify failed', r['error'])

    def test_ssl_verify_passthrough(self):
        # 默认校验证书；ssl_verify=False 时逐请求透传（自签名服务器开关）
        self._install([_Rsp(207)])
        pm.PluginManager.webdav_test(None, self.URL, '', '')
        self.assertIs(self.kwargs_log[0].get('verify'), True)
        self._install([_Rsp(207)])
        pm.PluginManager.webdav_test(None, self.URL, '', '', ssl_verify=False)
        self.assertIs(self.kwargs_log[1].get('verify'), False)

    def test_custom_remote_dir_composition(self):
        # 自定义远程目录：自动补前导斜杠、去尾斜杠，拼在服务器地址后
        self._install([_Rsp(207)])
        r = pm.PluginManager.webdav_test(None, self.URL, '', '', remote_dir='mySync')
        self.assertTrue(r['ok'])
        self.assertEqual(self.calls[0][1], f'{self.URL}/mySync')
        self._install([_Rsp(207)])
        pm.PluginManager.webdav_test(None, self.URL + '/', '', '', remote_dir='/a/b/')
        self.assertEqual(self.calls[1][1], f'{self.URL}/a/b')

    def test_remote_dir_traversal_rejected(self):
        # 含 '..' 的远程目录直接拒绝（防写穿到盘根），不发任何请求
        r = pm.PluginManager.webdav_test(None, self.URL, '', '', remote_dir='../evil')
        self.assertFalse(r['ok'])
        self.assertIn('..', r['error'])
        self.assertEqual(self.calls, [])

    def test_sync_uses_custom_dir(self):
        # sync 与 restore 共用同一拼接规则：自定义目录 + 文件名拼出上传地址。
        # 注意 sync 的 MKCOL 走 requests.request、上传走 requests.put，两者都要打桩；
        # 末尾多一次 _meta.json（版本标识）PUT，见 test_sync_writes_version_meta_last
        def fake(method, url, **kwargs):
            self.calls.append((method, url))
            return _Rsp(201) if method == 'PUT' else _Rsp(200)

        def fake_put(url, **kwargs):
            self.calls.append(('PUT', url))
            self.kwargs_log.append(kwargs)
            return _Rsp(201)

        requests.request = fake
        requests.put = fake_put
        ok = pm.PluginManager.webdav_sync(None, self.URL, '', '', {'favorites': []}, remote_dir='p1')
        self.assertTrue(ok)
        self.assertEqual(
            [('MKCOL', f'{self.URL}/p1'), ('PUT', f'{self.URL}/p1/favorites.json'),
             ('PUT', f'{self.URL}/p1/_meta.json')],
            self.calls,
        )

    def test_sync_writes_version_meta_last(self):
        """版本标识：数据文件先写、_meta.json 最后写，且内容声明 schemaVersion。"""
        import json

        def fake_put(url, **kwargs):
            self.calls.append(('PUT', url))
            self.kwargs_log.append(kwargs)
            return _Rsp(201)

        requests.request = lambda method, url, **kw: _Rsp(200)
        requests.put = fake_put
        ok = pm.PluginManager.webdav_sync(None, self.URL, '', '',
                                          {'favorites': [], 'settings': {'a': 1}})
        self.assertTrue(ok)
        self.assertEqual([u.rsplit('/', 1)[1] for _, u in self.calls],
                         ['favorites.json', 'settings.json', '_meta.json'])
        meta = json.loads(self.kwargs_log[-1]['data'].decode('utf-8'))
        self.assertEqual(meta['schemaVersion'], pm.WEBDAV_PAYLOAD_VERSION)
        self.assertEqual(meta['files'], ['favorites', 'settings'], 'files 为升序清单')
        self.assertIn('createdAt', meta)
        self.assertNotIn('_meta', meta['files'])

    def test_sync_meta_carries_app_version_from_env(self):
        """appVersion 来自主进程注入的 YUKI_APP_VERSION（未注入时空串，不影响同步）。"""
        import json
        import os

        def fake_put(url, **kwargs):
            self.calls.append(('PUT', url))
            self.kwargs_log.append(kwargs)
            return _Rsp(201)

        requests.request = lambda method, url, **kw: _Rsp(200)
        requests.put = fake_put
        old = os.environ.get('YUKI_APP_VERSION')
        try:
            os.environ['YUKI_APP_VERSION'] = '9.9.9-test'
            pm.PluginManager.webdav_sync(None, self.URL, '', '', {'favorites': []})
            meta = json.loads(self.kwargs_log[-1]['data'].decode('utf-8'))
            self.assertEqual(meta['appVersion'], '9.9.9-test')
        finally:
            if old is None:
                os.environ.pop('YUKI_APP_VERSION', None)
            else:
                os.environ['YUKI_APP_VERSION'] = old

    def test_sync_skips_reserved_meta_key_in_payload(self):
        """payload 里出现保留键 _meta 时不得覆盖后端生成的版本文件内容。"""
        def fake_put(url, **kwargs):
            self.calls.append(('PUT', url))
            self.kwargs_log.append(kwargs)
            return _Rsp(201)

        requests.request = lambda method, url, **kw: _Rsp(200)
        requests.put = fake_put
        pm.PluginManager.webdav_sync(None, self.URL, '', '', {'_meta': {'schemaVersion': 999}})
        self.assertEqual([u for _, u in self.calls], [f'{self.URL}/YuKiSync/_meta.json'])

    def test_sync_rejects_illegal_scheme_without_request(self):
        def fake_put(url, **kwargs):  # pragma: no cover - 不应被调用
            self.calls.append(('PUT', url))
            return _Rsp(201)

        requests.request = lambda method, url, **kw: _Rsp(200)
        requests.put = fake_put
        self.assertFalse(pm.PluginManager.webdav_sync(None, 'file:///tmp/x', '', '', {'favorites': []}))
        self.assertFalse(pm.PluginManager.webdav_sync(None, 'nas.local/dav', '', '', {'favorites': []}))
        self.assertEqual(self.calls, [])

    def test_sync_allows_loopback_and_private_hosts(self):
        """自建 NAS/内网地址必须放行（本场景主流用法），不因私网被拦。"""
        def fake_put(url, **kwargs):
            self.calls.append(('PUT', url))
            return _Rsp(201)

        requests.request = lambda method, url, **kw: _Rsp(200)
        requests.put = fake_put
        for url in ('http://127.0.0.1:5005/dav', 'http://192.168.1.9:5005/dav'):
            self.calls.clear()
            self.assertTrue(pm.PluginManager.webdav_sync(None, url, '', '', {'favorites': []}), url)
            self.assertTrue(any(u.startswith(url) for _, u in self.calls), url)

    def test_test_reports_hint_for_private_host(self):
        """测试连接成功时附地址提示（内网/明文 http），失败判定不受影响。"""
        self._install([_Rsp(207)])
        r = pm.PluginManager.webdav_test(None, 'http://192.168.1.9:5005/dav', '', '')
        self.assertTrue(r['ok'])
        self.assertIn('内网', r['note'])
        self._install([_Rsp(207)])
        r2 = pm.PluginManager.webdav_test(None, 'https://dav.jianguoyun.com/dav', '', '')
        self.assertEqual(r2['note'], '', '公网 https 无提示')

    def test_test_rejects_illegal_scheme_with_chinese_reason(self):
        r = pm.PluginManager.webdav_test(None, 'file:///tmp/x', '', '')
        self.assertFalse(r['ok'])
        self.assertIn('http/https', r['error'])
        self.assertIn('不被支持', r['error'])
        self.assertEqual(self.calls, [])

    def test_validate_webdav_url_public_helper(self):
        self.assertTrue(any('内网' in h for h in pm.PluginManager.validate_webdav_url(None, 'http://10.1.2.3/dav')))
        self.assertEqual(pm.PluginManager.validate_webdav_url(None, 'https://x.example/dav'), [])
        with self.assertRaises(ValueError):
            pm.PluginManager.validate_webdav_url(None, 'gopher://x/1')


if __name__ == '__main__':
    unittest.main()
