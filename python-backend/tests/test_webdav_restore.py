# -*- coding: utf-8 -*-
"""WebDAV 恢复语义回环测试。

旧实现逐文件吞异常、空结果恒当成功返回 → 渲染层提示「恢复完成」但实际什么都没
恢复（网址输错时最典型）。新实现返回 {'files','ok','error','meta','warnings'}：
- 连接错误 / 非 404 的 HTTP 错误 → ok=False + error；
- 单文件 404 视为云端无该数据（不算失败），全部 404 → ok=False（无可恢复数据）；
- 部分成功 → ok=True 且 files 只含拿到的数据。
载荷版本标识（2026-10 内容升级）：
- 云端有 _meta.json（schemaVersion=2）→ meta 原样带回；
- 云端没有（旧备份，404）/损坏/结构异常 → meta={'schemaVersion':1,'legacy':True}
  + warnings，且 ok 照常为 True——历史备份必须继续可恢复；
- 更高版本（schemaVersion>2）→ 照常恢复，只在 warnings 里提示；
- _meta.json 永远不进 files（它不是可恢复的数据项，混进去会让「全 404 却提示成功」复发）。
不访问外网：monkeypatch plugin_manager.http_client.get。
"""

from __future__ import annotations

import os
import sys
import unittest

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import kazumi.plugin_manager as pm  # noqa: E402


class _Rsp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError('no json')
        return self._body


class _WebdavBase(unittest.TestCase):
    """共用桩：把 http_client.get 换成按 URL 分派的假实现，记录访问过的 URL。

    不含测试方法（纯基类）：避免子类继承时把用例重复跑一遍。"""

    def setUp(self):
        self._orig = pm.http_client.get
        self.calls = []

        def fake_get(url, **kwargs):
            self.calls.append(url)
            return self._respond(url)

        pm.http_client.get = fake_get

    def tearDown(self):
        pm.http_client.get = self._orig

    def _respond(self, url):  # 被子类/用例覆写
        return _Rsp(200, {'v': 1})


class WebdavRestoreTests(_WebdavBase):
    def test_connection_error_fails_loudly(self):
        def boom(url, **kwargs):
            raise OSError('dns lookup failed')

        pm.http_client.get = boom
        r = pm.PluginManager.webdav_restore(None, 'https://bad.example/dav', '', '', ['favorites'])
        self.assertFalse(r['ok'])
        self.assertIn('dns lookup failed', r['error'])
        self.assertEqual(r['files'], {})

    def test_http_500_fails_loudly(self):
        self._respond = lambda url: _Rsp(500)
        r = pm.PluginManager.webdav_restore(None, 'https://x/dav', '', '', ['favorites'])
        self.assertFalse(r['ok'])
        self.assertIn('500', r['error'])

    def test_all_404_means_nothing_to_restore(self):
        self._respond = lambda url: _Rsp(404)
        r = pm.PluginManager.webdav_restore(None, 'https://x/dav', '', '', ['favorites', 'history'])
        self.assertFalse(r['ok'])
        self.assertIn('没有找到任何可恢复的数据', r['error'])

    def test_partial_404_still_ok(self):
        def respond(url):
            if url.endswith('/favorites.json'):
                return _Rsp(404)
            return _Rsp(200, {'items': [1, 2]})

        self._respond = respond
        r = pm.PluginManager.webdav_restore(None, 'https://x/dav', '', '', ['favorites', 'history'])
        self.assertTrue(r['ok'])
        self.assertEqual(list(r['files'].keys()), ['history'])
        self.assertEqual(r['files']['history'], {'items': [1, 2]})

    def test_bad_json_fails_loudly(self):
        self._respond = lambda url: _Rsp(200, None)
        r = pm.PluginManager.webdav_restore(None, 'https://x/dav', '', '', ['favorites'])
        self.assertFalse(r['ok'])
        self.assertIn('JSON', r['error'])


class WebdavPayloadVersionTests(_WebdavBase):
    """版本标识：新备份可识别、旧备份按 v1 兼容恢复。"""

    URL = 'https://nas.example/dav'
    DIR = 'https://nas.example/dav/YuKiSync'

    def _by_url(self, mapping, default=None):
        """按 URL 结尾分派响应；default 为兜底（None 表示 404）。"""
        def respond(url):
            for suffix, rsp in mapping.items():
                if url.endswith(suffix):
                    return rsp
            if default is not None:
                return default
            return _Rsp(404)
        self._respond = respond

    def test_legacy_backup_without_meta_restores_as_v1(self):
        """硬约束：云端没有 _meta.json（旧备份）必须照常恢复，绝不因读不到版本拒绝。"""
        self._by_url({
            '/settings.json': _Rsp(200, {'searchHistory': [{'word': '测试'}]}),
            '/favorites.json': _Rsp(200, [{'site': 's', 'vodId': '1'}]),
        })
        r = pm.PluginManager.webdav_restore(None, self.URL, '', '', ['favorites', 'settings'])
        self.assertTrue(r['ok'], r.get('error'))
        self.assertEqual(r['error'], '')
        self.assertEqual(r['meta']['schemaVersion'], 1)
        self.assertTrue(r['meta']['legacy'])
        self.assertEqual(list(r['files'].keys()), ['favorites', 'settings'])
        self.assertEqual(r['warnings'], [], '旧备份是正常路径，不该报 warning')

    def test_v2_backup_reports_schema_version(self):
        """往返：v2 备份的 _meta.json 原样带回，legacy=False。"""
        self._by_url({
            '/_meta.json': _Rsp(200, {
                'app': 'YuKi', 'schemaVersion': 2, 'appVersion': '0.3.2',
                'createdAt': '2026-10-14T00:00:00Z', 'files': ['favorites', 'settings'],
            }),
            '/settings.json': _Rsp(200, {'kazumiAliasMap': {}}),
            '/favorites.json': _Rsp(200, []),
        })
        r = pm.PluginManager.webdav_restore(None, self.URL, '', '', ['favorites', 'settings'])
        self.assertTrue(r['ok'])
        self.assertEqual(r['meta']['schemaVersion'], 2)
        self.assertFalse(r['meta']['legacy'])
        self.assertEqual(r['meta']['files'], ['favorites', 'settings'])
        self.assertNotIn('_meta', r['files'], '版本文件不是可恢复数据项')
        self.assertEqual(r['warnings'], [])

    def test_meta_malformed_falls_back_to_v1_without_failing(self):
        """_meta.json 损坏 → 按 v1 兼容恢复；只记 warning，不写 error、不改变 ok。"""
        self._by_url({
            '/_meta.json': _Rsp(200, None),  # .json() 抛 ValueError
            '/favorites.json': _Rsp(200, [1]),
        })
        r = pm.PluginManager.webdav_restore(None, self.URL, '', '', ['favorites'])
        self.assertTrue(r['ok'])
        self.assertEqual(r['error'], '')
        self.assertEqual(r['meta']['schemaVersion'], 1)
        self.assertTrue(any('版本标识' in w for w in r['warnings']), r['warnings'])

    def test_meta_without_schema_field_falls_back_to_v1(self):
        self._by_url({
            '/_meta.json': _Rsp(200, {'app': 'YuKi', 'schemaVersion': True}),
            '/favorites.json': _Rsp(200, [1]),
        })
        r = pm.PluginManager.webdav_restore(None, self.URL, '', '', ['favorites'])
        self.assertTrue(r['ok'])
        self.assertEqual(r['meta']['schemaVersion'], 1, 'JSON true 不能被当成版本号 1')
        self.assertTrue(any('schemaVersion' in w for w in r['warnings']), r['warnings'])

    def test_meta_future_schema_warns_but_still_restores(self):
        self._by_url({
            '/_meta.json': _Rsp(200, {'schemaVersion': 99}),
            '/favorites.json': _Rsp(200, [1]),
        })
        r = pm.PluginManager.webdav_restore(None, self.URL, '', '', ['favorites'])
        self.assertTrue(r['ok'], '更高版本不拒绝恢复：拒绝会让用户彻底拿不到数据')
        self.assertEqual(r['meta']['schemaVersion'], 99)
        self.assertTrue(any('更高版本' in w for w in r['warnings']), r['warnings'])

    def test_meta_only_means_nothing_to_restore(self):
        """只有 _meta.json 时仍算「无可恢复数据」——meta 不能冒充数据项。"""
        self._by_url({'/_meta.json': _Rsp(200, {'schemaVersion': 2})})
        r = pm.PluginManager.webdav_restore(None, self.URL, '', '', ['favorites', 'settings'])
        self.assertFalse(r['ok'])
        self.assertIn('没有找到任何可恢复的数据', r['error'])
        self.assertEqual(r['meta']['schemaVersion'], 2, '失败结果里仍带上版本，便于排障')

    def test_missing_data_file_keeps_others(self):
        """云端缺某个数据文件（404）→ 该键跳过，其余照常恢复。"""
        self._by_url({
            '/_meta.json': _Rsp(200, {'schemaVersion': 2, 'files': ['favorites', 'history']}),
            '/history.json': _Rsp(200, [{'n': 1}]),
        })
        r = pm.PluginManager.webdav_restore(None, self.URL, '', '', ['favorites', 'history'])
        self.assertTrue(r['ok'])
        self.assertEqual(list(r['files'].keys()), ['history'])

    def test_meta_read_is_attempted_once_and_first(self):
        self._by_url({
            '/_meta.json': _Rsp(200, {'schemaVersion': 2}),
            '/favorites.json': _Rsp(200, [1]),
        })
        pm.PluginManager.webdav_restore(None, self.URL, '', '', ['favorites'])
        self.assertTrue(self.calls[0].endswith('/_meta.json'), self.calls)
        self.assertEqual(len([c for c in self.calls if c.endswith('/_meta.json')]), 1)

    def test_unknown_setting_keys_pass_through_untouched(self):
        """后端不裁剪 settings 内容：未知键原样带回，过滤是渲染层允许表的职责。

        这样后端不持有「哪些键可恢复」的知识（单一真相在渲染层），也不会悄悄吞数据。
        """
        payload = {'searchHistory': [{'word': 'x'}], 'futureUnknownKey': {'a': 1}}
        self._by_url({'/settings.json': _Rsp(200, payload)})
        r = pm.PluginManager.webdav_restore(None, self.URL, '', '', ['settings'])
        self.assertTrue(r['ok'])
        self.assertEqual(r['files']['settings'], payload)


class WebdavUrlPolicyTests(_WebdavBase):
    """地址策略：非法 scheme 拒绝（中文原因）；内网/环回地址必须放行。"""

    def test_illegal_scheme_rejected_without_request(self):
        for url in ('file:///tmp/x', 'dict://127.0.0.1:2628/', 'ftp://nas/x'):
            r = pm.PluginManager.webdav_restore(None, url, '', '', ['favorites'])
            self.assertFalse(r['ok'], url)
            self.assertIn('http/https', r['error'], url)
            self.assertIn('不被支持', r['error'], url)
        self.assertEqual(self.calls, [], '非法 scheme 不该发出任何请求')

    def test_missing_scheme_rejected(self):
        r = pm.PluginManager.webdav_restore(None, 'nas.local/dav', '', '', ['favorites'])
        self.assertFalse(r['ok'])
        self.assertIn('协议前缀', r['error'])
        self.assertEqual(self.calls, [])

    def test_empty_url_rejected(self):
        r = pm.PluginManager.webdav_restore(None, '', '', '', ['favorites'])
        self.assertFalse(r['ok'])
        self.assertIn('不能为空', r['error'])

    def test_private_and_loopback_hosts_allowed(self):
        """自建 NAS / 内网 WebDAV 是主流用法：私有、环回、链路本地地址全部放行。"""
        for url in ('http://192.168.1.9:5005/dav', 'https://10.0.0.3/dav',
                    'http://127.0.0.1:8080/dav', 'http://nas.local/dav',
                    'http://169.254.10.10/dav'):
            self.calls.clear()
            self._respond = lambda u: _Rsp(200, [1]) if u.endswith('/favorites.json') else _Rsp(404)
            r = pm.PluginManager.webdav_restore(None, url, '', '', ['favorites'])
            self.assertTrue(r['ok'], f'{url} 应放行: {r.get("error")}')
            self.assertTrue(any(u.startswith('http') for u in self.calls), url)

    def test_url_guard_reports_hints_without_blocking(self):
        hints = pm._webdav_url_guard('http://192.168.1.9:5005/dav')[1]
        self.assertTrue(any('内网' in h for h in hints), hints)
        self.assertTrue(any('明文 http' in h for h in hints), hints)
        self.assertEqual(pm._webdav_url_guard('https://dav.jianguoyun.com/dav')[1], [])
        hints6 = pm._webdav_url_guard('http://[::1]:8080/dav')[1]
        self.assertTrue(any('回环' in h for h in hints6), hints6)
        # 地址内嵌凭据：提示改用账号框（凭据别出现在同步日志里）
        hints_cred = pm._webdav_url_guard('https://u:p@nas.example/dav')[1]
        self.assertTrue(any('用户名/密码' in h for h in hints_cred), hints_cred)

    def test_invalid_remote_dir_rejected_before_request(self):
        self._respond = lambda u: _Rsp(200, [1])
        r = pm.PluginManager.webdav_restore(None, 'https://x/dav', '', '', ['favorites'],
                                            remote_dir='../evil')
        self.assertFalse(r['ok'])
        self.assertIn('..', r['error'])
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
