# -*- coding: utf-8 -*-
"""Kazumi 规则引擎单元测试（glm5.2 编写，kimi 审核）。

覆盖：Plugin 序列化、XPath/API 策略、URL 归一化、PluginManager、RuleEngine。
"""
import os
import sys
import json
import tempfile
import unittest

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(BASE_DIR)
sys.path.insert(0, BACKEND_DIR)
os.environ['VPC_DATA_DIR'] = tempfile.mkdtemp()

import hoststate
hoststate.configure(data_dir=os.environ['VPC_DATA_DIR'])

from kazumi.plugin import Plugin, RuleMode
from kazumi.plugin_manager import PluginManager
from kazumi.rule_engine import RuleEngine
from kazumi.cookie_jar import CookieJar
from kazumi.xpath_strategy import XPathRuleStrategy
from kazumi.api_strategy import ApiRuleStrategy, RestrictedJsonPath
from kazumi.utils import normalize_episode_url, get_random_ua


class TestPlugin(unittest.TestCase):
    def test_from_json_defaults(self):
        p = Plugin.from_json({'name': 'test'})
        self.assertEqual(p.name, 'test')
        self.assertEqual(p.api, '1')
        self.assertEqual(p.type, 'anime')
        self.assertTrue(p.enabled)

    def test_from_json_full(self):
        data = {
            'api': '5', 'name': 'enlie', 'version': '1.0',
            'baseURL': 'https://example.com', 'searchURL': 'https://example.com/s?wd=@keyword',
            'searchList': '//div', 'searchName': '//a', 'searchResult': '//a',
            'chapterRoads': '//ul', 'chapterResult': '//li/a',
        }
        p = Plugin.from_json(data)
        self.assertEqual(p.api, '5')
        self.assertEqual(p.version, '1.0')
        self.assertEqual(p.base_url, 'https://example.com')

    def test_to_json_roundtrip(self):
        data = {'api': '5', 'name': 'test', 'baseURL': 'https://example.com'}
        p = Plugin.from_json(data)
        p2 = Plugin.from_json(p.to_json())
        self.assertEqual(p2.name, 'test')
        self.assertEqual(p2.api, '5')

    def test_validate_ok(self):
        p = Plugin.from_json({
            'api': '5', 'name': 'test',
            'searchList': '//div', 'searchName': '//a', 'searchResult': '//a',
            'chapterRoads': '//ul', 'chapterResult': '//li/a',
        })
        self.assertIsNone(p.validate())

    def test_validate_missing_name(self):
        p = Plugin.from_json({'api': '5'})
        self.assertIsNotNone(p.validate())

    def test_validate_high_api(self):
        p = Plugin.from_json({'api': '9', 'name': 'test'})
        self.assertIsNotNone(p.validate())

    def test_validate_xpath_missing_field(self):
        p = Plugin.from_json({'api': '5', 'name': 'test', 'searchList': '//div'})
        self.assertIsNotNone(p.validate())

    def test_build_http_headers(self):
        p = Plugin.from_json({'name': 'test', 'baseURL': 'https://example.com'})
        h = p.build_http_headers()
        self.assertIn('user-agent', h)
        self.assertEqual(h['referer'], 'https://example.com/')

    def test_build_full_url(self):
        p = Plugin.from_json({'name': 'test', 'baseURL': 'https://example.com'})
        self.assertEqual(p.build_full_url('/vod/1'), 'https://example.com/vod/1')


class TestNormalizeUrl(unittest.TestCase):
    def test_relative(self):
        self.assertEqual(normalize_episode_url('https://example.com/', '/vod/1'), 'https://example.com/vod/1')

    def test_absolute(self):
        self.assertEqual(normalize_episode_url('https://example.com/', 'https://example.com/vod/1'), 'https://example.com/vod/1')

    def test_protocol_same_host(self):
        self.assertEqual(normalize_episode_url('https://example.com/', 'http://example.com/vod/1'), 'https://example.com/vod/1')

    def test_trailing_slash(self):
        self.assertEqual(normalize_episode_url('https://example.com/', '/vod/1/'), 'https://example.com/vod/1')

    def test_empty_query(self):
        self.assertEqual(normalize_episode_url('https://example.com/', '/vod/1?'), 'https://example.com/vod/1')

    def test_empty(self):
        self.assertEqual(normalize_episode_url('https://example.com/', ''), '')

    def test_idempotent(self):
        once = normalize_episode_url('https://example.com/', '/vod/1/')
        twice = normalize_episode_url('https://example.com/', once)
        self.assertEqual(once, twice)


class TestXPathStrategy(unittest.TestCase):
    def setUp(self):
        self.strategy = XPathRuleStrategy()
        self.config = Plugin.from_json({
            'api': '5', 'name': 'test', 'baseURL': 'https://example.com',
            'searchURL': 'https://example.com/s?wd=@keyword',
            'searchList': '//div[@class="item"]', 'searchName': './/a', 'searchResult': './/a',
            'chapterRoads': '//ul[@class="road"]', 'chapterResult': './/li/a',
        }).execution_config()

    def test_prepare_search_get(self):
        req = self.strategy.prepare_search_request(self.config, 'test')
        self.assertEqual(req.method, 'GET')
        self.assertIn('wd=test', req.url)

    def test_parse_search(self):
        html = '''
        <div class="item"><a href="/vod/1">Title 1</a></div>
        <div class="item"><a href="/vod/2">Title 2</a></div>
        '''
        result = self.strategy.parse_search(html, self.config)
        self.assertEqual(len(result.items), 2)
        self.assertEqual(result.items[0].name, 'Title 1')
        self.assertEqual(result.items[0].src, 'https://example.com/vod/1')

    def test_parse_chapters(self):
        html = '''
        <ul class="road"><li><a href="/play/1">第1集</a></li><li><a href="/play/2">第2集</a></li></ul>
        <ul class="road"><li><a href="/play/3">第3集</a></li></ul>
        '''
        result = self.strategy.parse_chapters(html, self.config)
        self.assertEqual(len(result.roads), 2)
        self.assertEqual(result.roads[0].name, '播放线路1')
        self.assertEqual(len(result.roads[0].data), 2)
        self.assertEqual(result.roads[0].identifier[0], '第1集')

    def test_parse_search_missing_name(self):
        html = '<div class="item"><a href="/vod/1"></a></div>'
        result = self.strategy.parse_search(html, self.config)
        self.assertEqual(len(result.items), 0)
        self.assertTrue(len(result.diagnostics) > 0)


class TestApiStrategy(unittest.TestCase):
    def setUp(self):
        self.strategy = ApiRuleStrategy()

    def test_jsonpath_validate_ok(self):
        RestrictedJsonPath.validate('$.data[*]')
        RestrictedJsonPath.validate('$.name')
        RestrictedJsonPath.validate("$.data[0].name")

    def test_jsonpath_validate_recursive_rejected(self):
        with self.assertRaises(Exception):
            RestrictedJsonPath.validate('$.data..name')

    def test_jsonpath_read(self):
        doc = {'data': [{'name': 'a'}, {'name': 'b'}]}
        values = RestrictedJsonPath.read(doc, '$.data[*].name')
        self.assertEqual(values, ['a', 'b'])

    def test_parse_search(self):
        config = {
            'request': {'url': 'https://api.example.com/search'},
            'listPath': '$.data[*]', 'namePath': '$.name', 'sourcePath': '$.url',
        }
        raw = json.dumps({'data': [{'name': 'a', 'url': 'u1'}, {'name': 'b', 'url': 'u2'}]})
        result = self.strategy.parse_search(raw, config)
        self.assertEqual(len(result.items), 2)

    def test_parse_chapters_nested(self):
        config = {
            'request': {'url': 'https://api.example.com/chapter'},
            'format': 'nested',
            'roadsPath': '$.roads[*]', 'roadNamePath': '$.name',
            'episodesPath': '$.episodes[*]', 'episodeNamePath': '$.name', 'episodeUrlPath': '$.url',
        }
        raw = json.dumps({'roads': [{'name': '线路1', 'episodes': [{'name': '第1集', 'url': '/p1'}]}]})
        result = self.strategy.parse_chapters(raw, config, source='src', base_url='https://example.com')
        self.assertEqual(len(result.roads), 1)
        self.assertEqual(result.roads[0].name, '线路1')

    def test_parse_chapters_delimited(self):
        config = {
            'request': {'url': 'https://api.example.com/chapter'},
            'format': 'delimited',
            'roadNamesPath': '$.names', 'roadEpisodesPath': '$.episodes',
            'roadSeparator': '$$$', 'episodeSeparator': '#', 'fieldSeparator': '$',
        }
        raw = json.dumps({'names': '线路1$$$线路2', 'episodes': '第1集$/p1#第2集$/p2$$$第3集$/p3'})
        result = self.strategy.parse_chapters(raw, config, source='src', base_url='https://example.com')
        self.assertEqual(len(result.roads), 2)
        self.assertEqual(result.roads[0].name, '线路1')
        self.assertEqual(len(result.roads[0].data), 2)


class TestPluginManager(unittest.TestCase):
    def setUp(self):
        self.mgr = PluginManager()
        # 清空内置规则，隔离测试
        self.mgr._plugins = []

    def test_add_and_list(self):
        p = Plugin.from_json({'api': '5', 'name': 'test', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        ok, msg = self.mgr.add(p)
        self.assertTrue(ok)
        self.assertEqual(msg, 'added')
        self.assertEqual(len(self.mgr.list_all()), 1)

    def test_add_duplicate_updates(self):
        p = Plugin.from_json({'api': '5', 'name': 'test', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        self.mgr.add(p)
        p2 = Plugin.from_json({'api': '6', 'name': 'test', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        ok, msg = self.mgr.add(p2)
        self.assertTrue(ok)
        self.assertEqual(msg, 'updated')
        self.assertEqual(len(self.mgr.list_all()), 1)
        self.assertEqual(self.mgr.get('test').api, '6')

    def test_remove(self):
        p = Plugin.from_json({'api': '5', 'name': 'test', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        self.mgr.add(p)
        self.assertTrue(self.mgr.remove('test'))
        self.assertEqual(len(self.mgr.list_all()), 0)

    def test_toggle(self):
        p = Plugin.from_json({'api': '5', 'name': 'test', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        self.mgr.add(p)
        self.assertTrue(self.mgr.toggle('test', False))
        self.assertFalse(self.mgr.has_enabled())
        self.assertTrue(self.mgr.toggle('test', True))
        self.assertTrue(self.mgr.has_enabled())

    # ---------------------------------------------------------------- 安装时间追踪

    def test_install_time_tracked(self):
        p = Plugin.from_json({'api': '5', 'name': 'test', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        self.mgr.add(p)
        item = self.mgr.list_all()[0]
        self.assertTrue(item['installed_at'])
        self.assertTrue(item['updated_at'])
        self.assertEqual(item['validity'], 'unknown')

    def test_update_time_changes_but_install_preserved(self):
        p = Plugin.from_json({'api': '5', 'name': 'test', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        self.mgr.add(p)
        installed = self.mgr.list_all()[0]['installed_at']
        # 更新同名校验：installed_at 保留，updated_at 变化
        p2 = Plugin.from_json({'api': '6', 'name': 'test', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        self.mgr.add(p2)
        item = self.mgr.list_all()[0]
        self.assertEqual(item['installed_at'], installed)
        self.assertTrue(item['updated_at'])

    # ---------------------------------------------------------------- 有效性检测

    class _FakeEngine:
        """模拟 RuleEngine：按插件名返回固定结果。"""
        def __init__(self, valid=(), invalid=(), captcha=()):
            self.valid = set(valid)
            self.invalid = set(invalid)
            self.captcha = set(captcha)

        def search(self, config, keyword):
            from kazumi.models import PluginSearchResponse
            from kazumi.utils import NoResultException, CaptchaRequiredException
            name = config.plugin_name
            if name in self.captcha:
                raise CaptchaRequiredException(name)
            if name in self.invalid:
                raise NoResultException(name)
            return type('T', (), {'response': PluginSearchResponse(plugin_name=name, data=[1, 2, 3])})()

    def test_check_validity(self):
        self.mgr.add(Plugin.from_json({'api': '5', 'name': 'good', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'}))
        self.mgr.add(Plugin.from_json({'api': '5', 'name': 'bad', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'}))
        engine = self._FakeEngine(valid=('good',), invalid=('bad',))
        results = self.mgr.check_validity(engine, keyword='测试')
        by_name = {r['name']: r for r in results}
        self.assertEqual(by_name['good']['validity'], 'valid')
        self.assertEqual(by_name['bad']['validity'], 'invalid')
        # 状态已写回
        self.assertEqual(self.mgr.get('good').validity, 'valid')
        self.assertTrue(self.mgr.get('good').validity_checked_at)

    def test_check_validity_captcha_and_disabled_skipped(self):
        self.mgr.add(Plugin.from_json({'api': '5', 'name': 'cap', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'}))
        self.mgr.add(Plugin.from_json({'api': '5', 'name': 'disabled', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'}))
        self.mgr.toggle('disabled', False)
        engine = self._FakeEngine(captcha=('cap',), invalid=('disabled',))
        results = self.mgr.check_validity(engine)
        by_name = {r['name']: r for r in results}
        self.assertEqual(by_name['cap']['validity'], 'captcha')
        self.assertNotIn('disabled', by_name)  # 禁用规则不检测

    def test_start_validity_check_background(self):
        self.mgr.add(Plugin.from_json({'api': '5', 'name': 'good', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'}))
        engine = self._FakeEngine(valid=('good',))
        self.assertTrue(self.mgr.start_validity_check(engine))
        self.assertFalse(self.mgr.start_validity_check(engine))  # 已在运行，拒绝重复
        # 等待后台完成
        for _ in range(50):
            if not self.mgr.validity_status()['running']:
                break
            import time
            time.sleep(0.1)
        status = self.mgr.validity_status()
        self.assertFalse(status['running'])
        self.assertEqual(status['results'][0]['validity'], 'valid')

    # ---------------------------------------------------------------- 批量更新

    def test_batch_update(self):
        self.mgr.add(Plugin.from_json({'api': '5', 'name': 'oldrule', 'version': '1.0', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'}))
        # 商店返回 v2.0
        latest = Plugin.from_json({'api': '5', 'name': 'oldrule', 'version': '2.0', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        self.mgr.fetch_shop_rule = lambda name: latest
        results = self.mgr.batch_update()
        self.assertEqual(results[0]['updated'], True)
        self.assertEqual(self.mgr.get('oldrule').version, '2.0')

    def test_batch_update_skip_when_latest(self):
        self.mgr.add(Plugin.from_json({'api': '5', 'name': 'same', 'version': '2.0', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'}))
        latest = Plugin.from_json({'api': '5', 'name': 'same', 'version': '2.0', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        self.mgr.fetch_shop_rule = lambda name: latest
        results = self.mgr.batch_update()
        self.assertEqual(results[0]['updated'], False)
        self.assertEqual(results[0]['msg'], '已是最新版本')

    def test_batch_update_shop_missing(self):
        self.mgr.add(Plugin.from_json({'api': '5', 'name': 'ghost', 'version': '1.0', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'}))
        self.mgr.fetch_shop_rule = lambda name: None
        results = self.mgr.batch_update()
        self.assertEqual(results[0]['ok'], False)
        self.assertIn('未找到', results[0]['msg'])

    def test_start_batch_update_background(self):
        self.mgr.add(Plugin.from_json({'api': '5', 'name': 'oldrule', 'version': '1.0', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'}))
        latest = Plugin.from_json({'api': '5', 'name': 'oldrule', 'version': '3.0', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        self.mgr.fetch_shop_rule = lambda name: latest
        self.assertTrue(self.mgr.start_batch_update())
        for _ in range(50):
            if not self.mgr.update_status()['running']:
                break
            import time
            time.sleep(0.1)
        status = self.mgr.update_status()
        self.assertFalse(status['running'])
        self.assertTrue(status['results'][0]['updated'])


class TestRuleEngine(unittest.TestCase):
    def setUp(self):
        self.engine = RuleEngine()

    def test_search_invalid_xpath(self):
        p = Plugin.from_json({'api': '5', 'name': 'test', 'searchURL': 'https://example.com/s?wd=@keyword', 'searchList': 'invalid xpath //', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})
        with self.assertRaises(Exception):
            self.engine.search(p.execution_config(), 'test')

    def test_query_chapters_invalid_xpath(self):
        p = Plugin.from_json({'api': '5', 'name': 'test', 'searchURL': 'https://example.com/s?wd=@keyword', 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': 'invalid xpath //', 'chapterResult': '//li/a'})
        with self.assertRaises(Exception):
            self.engine.query_chapters(p.execution_config(), 'https://example.com/vod/1')


class TestCookieJar(unittest.TestCase):
    """Cookie 持久化（PluginCookieManager 对齐）。"""

    def setUp(self):
        self.jar = CookieJar(file_path=os.path.join(tempfile.mkdtemp(), 'cookies.json'))

    def test_set_and_header(self):
        self.jar.set_domain_cookies('example.com', [
            {'name': 'sid', 'value': 'abc'}, {'name': 'theme', 'value': 'dark'},
        ])
        h = self.jar.cookie_header('https://example.com/path')
        self.assertIn('sid=abc', h)
        self.assertIn('theme=dark', h)

    def test_parent_domain_match(self):
        self.jar.set_domain_cookies('example.com', [{'name': 'sid', 'value': 'abc'}])
        self.assertIn('sid=abc', self.jar.cookie_header('https://sub.example.com/x'))

    def test_other_domain_not_attached(self):
        self.jar.set_domain_cookies('example.com', [{'name': 'sid', 'value': 'abc'}])
        self.assertEqual(self.jar.cookie_header('https://other.org/'), '')

    def test_persist_reload(self):
        self.jar.set_domain_cookies('a.com', [{'name': 'k', 'value': 'v'}])
        jar2 = CookieJar(file_path=self.jar._file)
        self.assertIn('k=v', jar2.cookie_header('https://a.com/'))

    def test_clear(self):
        self.jar.set_domain_cookies('a.com', [{'name': 'k', 'value': 'v'}])
        self.jar.clear()
        self.assertEqual(self.jar.cookie_header('https://a.com/'), '')


class TestRuleEngineCookie(unittest.TestCase):
    """RuleEngine 发请求时自动带持久化 Cookie。"""

    def test_cookie_attached_to_request(self):
        import types
        from kazumi.cookie_jar import CookieJar
        from kazumi.models import PreparedRuleRequest
        import kazumi.rule_engine as re_mod

        jar = CookieJar(file_path=os.path.join(tempfile.mkdtemp(), 'cookies.json'))
        jar.set_domain_cookies('example.com', [{'name': 'sid', 'value': 'xyz'}])
        engine = RuleEngine(cookie_jar=jar)

        captured = {}

        class FakeRsp:
            encoding = 'utf-8'
            text = '<html></html>'

            def raise_for_status(self):
                pass

        orig = re_mod.requests.get

        def fake_get(url, **kw):
            captured['cookie'] = kw.get('headers', {}).get('cookie', '')
            return FakeRsp()

        re_mod.requests.get = fake_get
        try:
            cfg = types.SimpleNamespace(base_url='https://example.com', user_agent='')
            req = PreparedRuleRequest(method='GET', url='https://example.com/s', headers={})
            engine._do_request(req, cfg)
        finally:
            re_mod.requests.get = orig
        self.assertIn('sid=xyz', captured['cookie'])


if __name__ == '__main__':
    unittest.main()
