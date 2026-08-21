# -*- coding: utf-8 -*-
"""Kazumi 规则引擎单元测试（glm5.2 编写，kimi 审核）。

覆盖：Plugin 序列化、XPath/API 策略、URL 归一化、PluginManager、RuleEngine。
"""
import os
import sys
import json
import uuid
import unittest

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(BASE_DIR)
sys.path.insert(0, BACKEND_DIR)
TEST_ROOT = os.environ.get('VPC_TEST_ROOT') or os.path.join(BACKEND_DIR, '.test-runtime')
os.makedirs(TEST_ROOT, exist_ok=True)


def test_file(prefix='vpc-test-'):
    return os.path.join(TEST_ROOT, prefix + uuid.uuid4().hex + '.json')


os.environ['VPC_DATA_DIR'] = os.path.join(TEST_ROOT, 'kazumi-data')
os.makedirs(os.environ['VPC_DATA_DIR'], exist_ok=True)

import hoststate
hoststate.configure(data_dir=os.environ['VPC_DATA_DIR'])

from kazumi.plugin import Plugin
from kazumi.plugin_manager import PluginManager
from kazumi.rule_engine import RuleEngine
from kazumi.cookie_jar import CookieJar
from kazumi.xpath_strategy import XPathRuleStrategy
from kazumi.api_strategy import ApiRuleStrategy, RestrictedJsonPath
from kazumi.utils import normalize_episode_url


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

    def test_parse_search_double_slash_is_node_relative(self):
        # R2：Kazumi 规则 searchName/searchResult 用 `//` 前缀，须为节点内查询（对齐 Dart queryXPath）
        html = '''
        <html><body>
          <div class="item"><a href="/nav">导航</a><a href="/vod/1">标题1</a></div>
          <div class="item"><a href="/nav">导航</a><a href="/vod/2">标题2</a></div>
        </body></html>
        '''
        config = Plugin.from_json({
            'api': '5', 'name': 'test', 'baseURL': 'https://example.com',
            'searchList': '//div[@class="item"]', 'searchName': '//a[2]', 'searchResult': '//a[2]',
        }).execution_config()
        result = self.strategy.parse_search(html, config)
        self.assertEqual(len(result.items), 2)
        self.assertEqual(result.items[0].name, '标题1')
        self.assertEqual(result.items[0].src, 'https://example.com/vod/1')
        self.assertEqual(result.items[1].name, '标题2')

    def test_parse_search_text_selector(self):
        # R2：`/text()` 选中结果是 str，需直接取用而非 text_content()
        html = '<div class="item"><div>片名</div><a href="/vod/1">x</a></div>'
        config = Plugin.from_json({
            'api': '5', 'name': 'test', 'baseURL': 'https://example.com',
            'searchList': '//div[@class="item"]', 'searchName': '//div[1]/text()', 'searchResult': '//a',
        }).execution_config()
        result = self.strategy.parse_search(html, config)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].name, '片名')
        self.assertEqual(result.items[0].src, 'https://example.com/vod/1')


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

    # ---------------------------------------------------------------- 手动排序（2.5）

    def _rule(self, name):
        return Plugin.from_json({'api': '5', 'name': name, 'searchList': '//div', 'searchName': '//a', 'searchResult': '//a', 'chapterRoads': '//ul', 'chapterResult': '//li/a'})

    def test_reorder_persists_given_order(self):
        for name in ('a', 'b', 'c'):
            self.mgr.add(self._rule(name))
        ok, msg = self.mgr.reorder(['c', 'a', 'b'])
        self.assertTrue(ok)
        self.assertEqual([p['name'] for p in self.mgr.list_all()], ['c', 'a', 'b'])

    def test_reorder_appends_unmentioned_in_original_order(self):
        for name in ('a', 'b', 'c'):
            self.mgr.add(self._rule(name))
        self.mgr.add(self._rule('d'))
        self.mgr.reorder(['c', 'a'])
        # b 未提及 → 追加在末尾，保持原有相对顺序（c,a,b,d 中 b 在 d 前）
        self.assertEqual([p['name'] for p in self.mgr.list_all()], ['c', 'a', 'b', 'd'])

    def test_reorder_case_insensitive(self):
        for name in ('a', 'b', 'c'):
            self.mgr.add(self._rule(name))
        self.mgr.reorder(['A', 'C'])
        self.assertEqual([p['name'] for p in self.mgr.list_all()], ['a', 'c', 'b'])

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
        self.jar = CookieJar(file_path=test_file('cookies-'))

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

        jar = CookieJar(file_path=test_file('cookies-'))
        jar.set_domain_cookies('example.com', [{'name': 'sid', 'value': 'xyz'}])
        engine = RuleEngine(cookie_jar=jar)

        captured = {}

        class FakeRsp:
            encoding = 'utf-8'
            text = '<html></html>'

            def raise_for_status(self):
                pass

        orig = re_mod.http_client.get

        def fake_get(url, **kw):
            captured['cookie'] = kw.get('headers', {}).get('cookie', '')
            return FakeRsp()

        re_mod.http_client.get = fake_get
        try:
            cfg = types.SimpleNamespace(base_url='https://example.com', user_agent='')
            req = PreparedRuleRequest(method='GET', url='https://example.com/s', headers={})
            engine._do_request(req, cfg)
        finally:
            re_mod.requests.get = orig
        self.assertIn('sid=xyz', captured['cookie'])


class TestBangumiSync(unittest.TestCase):
    """Bangumi 用户收藏同步（mock requests，不触网）。"""

    def setUp(self):
        self.mgr = PluginManager()
        self.mgr._plugins = []

    def test_domain_is_official_bgm_tv(self):
        # 2026-08-09 改回官方域名 api.bgm.tv / next.bgm.tv（对齐 Kazumi api_endpoints.dart）
        from kazumi.plugin_manager import BANGUMI_API, BANGUMI_API_NEXT
        self.assertIn('api.bgm.tv', BANGUMI_API)
        self.assertIn('next.bgm.tv', BANGUMI_API_NEXT)
        self.assertNotIn('bangumi.pro', BANGUMI_API)
        self.assertNotIn('bangumi.pro', BANGUMI_API_NEXT)

    def test_me_with_token(self):
        from unittest import mock
        me = {'id': 1, 'username': 'alice', 'nickname': '爱丽丝'}

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return me

        with mock.patch('http_client.get', return_value=FakeRsp()) as m:
            result = self.mgr.bangumi_me('tok')
        self.assertEqual(result, me)
        url = m.call_args[0][0]
        self.assertIn('api.bgm.tv/v0/me', url)
        self.assertEqual(m.call_args[1]['headers']['Authorization'], 'Bearer tok')

    def test_me_empty_token(self):
        self.assertIsNone(self.mgr.bangumi_me(''))

    def test_user_collections(self):
        from unittest import mock
        data = {'data': [{'subject_id': 1, 'type': 2, 'subject': {'name_cn': '番剧A'}}]}

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return data

        with mock.patch.object(self.mgr, '_bangumi_username', return_value='alice') as um, \
                mock.patch('http_client.get', return_value=FakeRsp()) as m:
            items = self.mgr.bangumi_user_collections('tok', limit=50)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['type'], 2)
        um.assert_called_once_with('tok')
        self.assertIn('/v0/users/alice/collections', m.call_args[0][0])
        self.assertNotIn('/v0/users/-/collections', m.call_args[0][0])

    def test_bangumi_username_resolves(self):
        # R1：收藏接口先 /v0/me 拿真实用户名（`-` 会被当字面用户名返回 404）
        from unittest import mock

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return {'username': 'alice', 'nickname': '爱丽丝'}

        with mock.patch('http_client.get', return_value=FakeRsp()) as m:
            username = self.mgr._bangumi_username('tok')
        self.assertEqual(username, 'alice')
        self.assertIn('api.bgm.tv/v0/me', m.call_args[0][0])
        self.assertEqual(self.mgr._username_cache, 'alice')

    def test_bangumi_username_invalid_token(self):
        from unittest import mock
        with mock.patch('http_client.get', side_effect=Exception('401')):
            username = self.mgr._bangumi_username('bad-token')
        self.assertIsNone(username)

    def test_search_post_v0(self):
        # R6：搜索改为 POST api.bgm.tv/v0/search/subjects（对齐 Kazumi buildBangumiSearchParams）
        from unittest import mock
        items = [{'id': 311310, 'name_cn': '番剧A'}]

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return {'data': items}

        with mock.patch('http_client.post', return_value=FakeRsp()) as m:
            result = self.mgr.bangumi_search('海贼王', limit=5)
        self.assertEqual(result, items)
        url = m.call_args[0][0]
        self.assertIn('api.bgm.tv/v0/search/subjects', url)
        self.assertEqual(m.call_args[1]['params'], {'limit': 5, 'offset': 0})
        body = m.call_args[1]['json']
        self.assertEqual(body['keyword'], '海贼王')
        self.assertEqual(body['sort'], 'heat')
        self.assertEqual(body['filter']['type'], [2])

    def test_trends_with_params(self):
        # /p1/trending/subjects 必须带 type/limit/offset，否则官方 API 返回 400
        from unittest import mock

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return {'data': []}

        with mock.patch('http_client.get', return_value=FakeRsp()) as m:
            self.mgr.bangumi_trends()
        self.assertIn('next.bgm.tv/p1/trending/subjects', m.call_args[0][0])
        self.assertEqual(m.call_args[1]['params'], {'type': 2, 'limit': 24, 'offset': 0})

    def test_calendar_normalizes_weekday_map(self):
        from unittest import mock

        data = {
            '1': [{
                'subject': {
                    'id': 42,
                    'name': 'Original',
                    'nameCN': '中文名',
                    'info': '12话 / 2026年7月6日 / 制作组',
                    'images': {'large': 'https://example.com/cover.jpg'},
                },
                'watchers': 123,
            }],
            '2': [],
        }

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return data

        with mock.patch('http_client.get', return_value=FakeRsp()):
            calendar = self.mgr.bangumi_calendar()
        self.assertEqual(len(calendar), 7)
        self.assertEqual(calendar[0]['weekday']['id'], 1)
        self.assertEqual(calendar[0]['items'][0]['id'], 42)
        self.assertEqual(calendar[0]['items'][0]['name_cn'], '中文名')
        self.assertEqual(calendar[0]['items'][0]['air_date'], '2026-07-06')
        self.assertEqual(calendar[0]['items'][0]['watchers'], 123)

    def test_update_collection_put_ok(self):
        from unittest import mock

        class FakeRsp:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return {}

        # 对齐 T74 全矩阵实现：首个尝试为 POST + `-` 通配用户，2xx 即成功。
        with mock.patch.object(self.mgr, '_bangumi_username', return_value='alice'), \
                mock.patch('requests.request', return_value=FakeRsp()) as m:
            ok, msg = self.mgr.bangumi_update_collection('tok', '42', 2)
        self.assertTrue(ok)
        self.assertEqual(m.call_args[0][0], 'POST')
        self.assertEqual(m.call_args[1]['json'], {'type': 2})
        self.assertIn('/collections/42', m.call_args[0][1])

    def test_update_collection_fallback(self):
        from unittest import mock
        calls = {'n': 0}

        class Rsp:
            def __init__(self, code):
                self.status_code = code

            def raise_for_status(self):
                pass

            def json(self):
                return {}

        def fake_request(method, url, **kw):
            calls['n'] += 1
            # 首个组合返回非 2xx，回退到下一组合成功
            return Rsp(500 if calls['n'] == 1 else 200)

        with mock.patch.object(self.mgr, '_bangumi_username', return_value='alice'), \
                mock.patch('requests.request', side_effect=fake_request):
            ok, _ = self.mgr.bangumi_update_collection('tok', '42', 1)
        self.assertTrue(ok)
        self.assertEqual(calls['n'], 2)  # 首个组合失败后回退下一组合成功

    def test_delete_collection(self):
        from unittest import mock

        class FakeRsp:
            status_code = 200

            def raise_for_status(self):
                pass

        # 实现走 requests.request('DELETE', ...)，首个 `-` 通配用户 2xx 即成功。
        with mock.patch.object(self.mgr, '_bangumi_username', return_value='alice'), \
                mock.patch('requests.request', return_value=FakeRsp()) as m:
            ok, msg = self.mgr.bangumi_delete_collection('tok', '42')
        self.assertTrue(ok)
        self.assertEqual(m.call_args[0][0], 'DELETE')
        self.assertIn('/collections/42', m.call_args[0][1])

    def test_missing_token(self):
        ok, msg = self.mgr.bangumi_update_collection('', '42', 2)
        self.assertFalse(ok)

    def test_all_collections_paginates_all_types(self):
        # 任务六 6.1：_bangumi_all_collections 分页遍历 5 种收藏类型，按 subject_id 去重合并
        from unittest import mock

        pages = {}
        # type=1 两页（total=150），其余类型各 0 条
        pages[(1, 0)] = {'total': 150, 'data': [{'subject_id': i, 'type': 1} for i in range(0, 100)]}
        pages[(1, 100)] = {'total': 150, 'data': [{'subject_id': i, 'type': 1} for i in range(100, 150)]}

        class FakeRsp:
            def __init__(self, payload):
                self._p = payload
                self.status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return self._p

        def fake_get(url, params=None, headers=None, timeout=None, verify=None):
            key = (params.get('type'), params.get('offset'))
            return FakeRsp(pages.get(key, {'total': 0, 'data': []}))

        with mock.patch.object(self.mgr, '_bangumi_username', return_value='alice'), \
                mock.patch('time.sleep'), \
                mock.patch('http_client.get', side_effect=fake_get):
            items = self.mgr._bangumi_all_collections('tok', page_delay=0)
        self.assertEqual(len(items), 150)  # 完整 150 条（跨两页），未截断在 100
        self.assertTrue(all('type' in it for it in items))

    def test_all_collections_page_failure_tolerated(self):
        # 单页抛错时容忍：中止该类型继续，不整体失败
        from unittest import mock

        class FakeRsp:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return {'total': 1, 'data': [{'subject_id': 7, 'type': 3}]}

        calls = {'n': 0}

        def fake_get(url, params=None, headers=None, timeout=None, verify=None):
            calls['n'] += 1
            if params.get('type') == 1:
                raise Exception('boom')  # type=1 全失败
            if params.get('type') == 3:
                return FakeRsp()
            # 其他类型无数据
            class Empty(FakeRsp):
                def json(self):
                    return {'total': 0, 'data': []}
            return Empty()

        with mock.patch.object(self.mgr, '_bangumi_username', return_value='alice'), \
                mock.patch('time.sleep'), \
                mock.patch('http_client.get', side_effect=fake_get):
            items = self.mgr._bangumi_all_collections('tok', page_delay=0)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['subject_id'], 7)

    def test_sync_collections_three_way_merge(self):
        # 三方合并：本地独有→upload；一致→skipped；冲突本地胜→upload；远端独有→pull
        from unittest import mock
        remote = [
            {'subject_id': 10, 'type': 2, 'subject': {'name_cn': '一致'}},   # 与本地一致
            {'subject_id': 20, 'type': 2, 'subject': {'name_cn': '冲突'}},   # 与本地冲突
            {'subject_id': 99, 'type': 1, 'subject': {'name_cn': '远端独有'}},  # 远端独有
        ]
        local = [
            {'subjectId': '10', 'type': 2, 'ts': 100, 'name': '一致'},   # skipped
            {'subjectId': '20', 'type': 3, 'ts': 100, 'name': '冲突'},   # upload（本地胜）
            {'subjectId': '30', 'type': 1, 'ts': 100, 'name': '本地独有'},  # upload
        ]
        with mock.patch.object(self.mgr, '_bangumi_all_collections', return_value=remote):
            plan = self.mgr.bangumi_sync_collections('tok', local, priority='local')
        up_ids = sorted(u['subjectId'] for u in plan['upload'])
        self.assertEqual(up_ids, ['20', '30'])
        self.assertEqual(plan['skipped'], 1)         # subject 10 一致
        self.assertEqual(len(plan['pull']), 1)       # subject 99 远端独有
        self.assertEqual(plan['pull'][0]['subject_id'], 99)
        self.assertEqual(len(plan['conflict']), 1)

    def test_sync_collections_incremental_skips_unchanged(self):
        # 增量：本地 ts < lastSyncAt 且远端已存在的冲突 → 远端胜（跳过上传）
        from unittest import mock
        remote = [{'subject_id': 20, 'type': 2}]
        local = [{'subjectId': '20', 'type': 3, 'ts': 50, 'name': 'x'}]  # ts=50 < lastSyncAt=100
        with mock.patch.object(self.mgr, '_bangumi_all_collections', return_value=remote):
            plan = self.mgr.bangumi_sync_collections('tok', local, priority='local', last_sync_at=100)
        self.assertEqual(plan['upload'], [])
        self.assertEqual(plan['skipped'], 1)
        self.assertEqual(plan['conflict'][0]['resolved'], 'remote')

    def test_apply_sync_plan_concurrent(self):
        # 并发上传：max_workers=3，用户名只解析一次，成功计数正确
        from unittest import mock

        class FakeRsp:
            status_code = 200

        uploads = [{'subjectId': str(i), 'type': (i % 5) + 1} for i in range(6)]
        with mock.patch.object(self.mgr, '_bangumi_username', return_value='alice') as um, \
                mock.patch('time.sleep'), \
                mock.patch('requests.request', return_value=FakeRsp()):
            result = self.mgr.bangumi_apply_sync_plan('tok', uploads, op_delay=0)
        self.assertEqual(result['uploaded'], 6)
        self.assertEqual(result['failed'], 0)
        um.assert_called_once_with('tok')  # 用户名只解析一次（并发复用）

    # ---------------------------------------------------------------- 镜像源（4.1）

    def test_set_mirror_switches_public_endpoint_base(self):
        from kazumi.plugin_manager import BANGUMI_API, BANGUMI_API_NEXT, BANGUMI_MIRROR_API, BANGUMI_MIRROR_NEXT
        # 默认官方
        self.assertEqual(self.mgr._base_api(), BANGUMI_API)
        self.assertEqual(self.mgr._base_next(), BANGUMI_API_NEXT)
        # 开启 Bangumi 镜像 → 全域名反代 api.bangumi.pro / next.bangumi.pro
        self.mgr.set_mirror(bangumi=True)
        self.assertEqual(self.mgr._base_api(), BANGUMI_MIRROR_API)
        self.assertEqual(self.mgr._base_next(), BANGUMI_MIRROR_NEXT)
        # 关闭恢复官方
        self.mgr.set_mirror(bangumi=False)
        self.assertEqual(self.mgr._base_api(), BANGUMI_API)
        self.assertEqual(self.mgr._base_next(), BANGUMI_API_NEXT)

    def test_mirror_enabled_trends_uses_mirror(self):
        # 镜像开启 → 推荐走 next.bangumi.pro（全域名反代），且 nameCN 归一到 name_cn
        from kazumi.plugin_manager import BANGUMI_MIRROR_NEXT
        from unittest import mock

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return {'data': [{'id': 1, 'name': '番A', 'nameCN': '番A中', 'rating': {'score': 8.0}}]}

        self.mgr.enable_bangumi_proxy = True
        with mock.patch('http_client.get', return_value=FakeRsp()) as m:
            out = self.mgr.bangumi_trends(limit=5)
        self.assertIn(BANGUMI_MIRROR_NEXT + '/p1/trending/subjects', m.call_args[0][0])
        self.assertEqual(out['items'][0]['name_cn'], '番A中')
        self.assertEqual(out['total'], 1)

    def test_mirror_enabled_search_uses_mirror(self):
        # 镜像开启 → 搜索走 api.bangumi.pro（免签名，全路径可用）
        from kazumi.plugin_manager import BANGUMI_MIRROR_API
        from unittest import mock

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return {'data': [{'id': 1, 'name_cn': '番A'}]}

        self.mgr.enable_bangumi_proxy = True
        with mock.patch('http_client.post', return_value=FakeRsp()) as m:
            out = self.mgr.bangumi_search('测试', limit=3)
        self.assertIn(BANGUMI_MIRROR_API + '/v0/search/subjects', m.call_args[0][0])
        self.assertEqual(len(out), 1)

    def test_mirror_enabled_season_calendar_uses_mirror(self):
        # 镜像开启 → 季度放送检索（v0/search/subjects POST）走 api.bangumi.pro
        from kazumi.plugin_manager import BANGUMI_MIRROR_API
        from unittest import mock

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return {'data': []}

        self.mgr.enable_bangumi_proxy = True
        with mock.patch('http_client.post', return_value=FakeRsp()) as m:
            self.mgr.bangumi_season_calendar('2026-07-01', '2026-10-01')
        self.assertIn(BANGUMI_MIRROR_API + '/v0/search/subjects', m.call_args[0][0])

    def test_mirror_disabled_trends_uses_official(self):
        # 镜像关闭 → 推荐仍走官方 next.bgm.tv（回归保护）
        from kazumi.plugin_manager import BANGUMI_API_NEXT
        from unittest import mock

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return {'data': []}

        self.mgr.enable_bangumi_proxy = False
        with mock.patch('http_client.get', return_value=FakeRsp()) as m:
            self.mgr.bangumi_trends(limit=5)
        self.assertIn(BANGUMI_API_NEXT + '/p1/trending/subjects', m.call_args[0][0])

    def test_mirror_enabled_auth_collections_uses_mirror(self):
        # 全域名反代也代理鉴权/收藏接口（镜像开启时走 api.bangumi.pro）
        from kazumi.plugin_manager import BANGUMI_MIRROR_API
        from unittest import mock
        self.mgr.enable_bangumi_proxy = True
        with mock.patch.object(self.mgr, '_bangumi_username', return_value='alice'), \
                mock.patch('http_client.get') as m:
            class FakeRsp:
                def raise_for_status(self):
                    pass

                def json(self):
                    return {'data': []}
            m.return_value = FakeRsp()
            self.mgr.bangumi_user_collections('tok', limit=10)
        self.assertIn(BANGUMI_MIRROR_API + '/v0/users/alice/collections', m.call_args[0][0])

    def test_character_detail(self):
        from unittest import mock

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return {'id': 123, 'name': '角色A', 'summary': '简介'}

        with mock.patch('http_client.get', return_value=FakeRsp()) as m:
            info = self.mgr.bangumi_character_detail('123')
        self.assertEqual(info['name'], '角色A')
        self.assertIn('/v0/characters/123', m.call_args[0][0])


class TestBangumiSeason(unittest.TestCase):
    """Bangumi 季度放送检索（mock requests.post，不触网）。"""

    def setUp(self):
        self.mgr = PluginManager()
        self.mgr._plugins = []

    def test_season_calendar_merges_and_buckets(self):
        from unittest import mock
        from datetime import date
        pages = {
            0: [
                {'id': 1, 'name': 'A', 'name_cn': '番A', 'date': '2026-07-06',
                 'rating': {'rank': 5, 'score': 8.0, 'total': 100}, 'images': {'large': 'http://x/a.jpg'}},
                {'id': 2, 'name': 'B', 'name_cn': '番B', 'date': '2026-07-07',
                 'rating': {'rank': 9, 'score': 7.0, 'total': 50}, 'images': {'large': 'http://x/b.jpg'}},
            ],
            2: [
                {'id': 2, 'name': 'B', 'name_cn': '番B', 'date': '2026-07-07'},  # 与第 1 页重复 → 去重
                {'id': 3, 'name': 'C', 'name_cn': '番C'},                        # 无播出日期 → weekday 1
            ],
            4: [],
        }

        class FakeRsp:
            def __init__(self, rows):
                self._rows = rows

            def raise_for_status(self):
                pass

            def json(self):
                return {'data': self._rows, 'total': len(self._rows)}

        def fake_post(url, params=None, json=None, **kw):
            return FakeRsp(pages.get(params['offset'], []))

        with mock.patch('http_client.post', side_effect=fake_post) as m:
            calendar = self.mgr.bangumi_season_calendar('2026-07-01', '2026-10-01', page_size=2)
        # 7 个星期桶
        self.assertEqual(len(calendar), 7)
        all_items = [it for d in calendar for it in d['items']]
        # 去重后 3 条（id=2 跨页重复只算一次）
        self.assertEqual(sorted(it['id'] for it in all_items), [1, 2, 3])
        # id=1 落入其播出日期对应的星期桶
        wd1 = date(2026, 7, 6).isoweekday()
        bucket = calendar[wd1 - 1]
        self.assertEqual(bucket['weekday']['id'], wd1)
        self.assertIn(1, [it['id'] for it in bucket['items']])
        # 无日期条目落入 weekday 1 桶
        self.assertIn(3, [it['id'] for it in calendar[0]['items']])
        # 请求 body：sort=rank + air_date 区间 + type=2
        first_body = m.call_args_list[0][1]['json']
        self.assertEqual(first_body['sort'], 'rank')
        self.assertEqual(first_body['filter']['air_date'], ['>=2026-07-01', '<2026-10-01'])
        self.assertEqual(first_body['filter']['type'], [2])

    def test_season_calendar_empty_args(self):
        self.assertEqual(self.mgr.bangumi_season_calendar('', ''), [])
        self.assertEqual(self.mgr.bangumi_season_calendar(None, '2026-10-01'), [])

    def test_season_calendar_request_failure(self):
        from unittest import mock
        with mock.patch('http_client.post', side_effect=Exception('net down')):
            self.assertEqual(self.mgr.bangumi_season_calendar('2026-07-01', '2026-10-01'), [])

    def test_season_weekday_helper(self):
        from datetime import date
        self.assertEqual(self.mgr._season_weekday('2026-07-06'), date(2026, 7, 6).isoweekday())
        self.assertEqual(self.mgr._season_weekday('bad'), 1)
        self.assertEqual(self.mgr._season_weekday(None), 1)


class TestBangumiTrends(unittest.TestCase):
    """Bangumi 趋势榜单归一化（mock requests.get，不触网）。"""

    def setUp(self):
        self.mgr = PluginManager()
        self.mgr._plugins = []

    def test_trends_unwraps_subject_and_normalizes(self):
        from unittest import mock
        payload = {
            'total': 2,
            'data': [
                {'subject': {'id': 1, 'name': 'A', 'nameCN': '番A', 'date': '2026-07-06',
                             'rating': {'rank': 5, 'score': 8.0, 'total': 100},
                             'images': {'large': 'http://x/a.jpg'}}, 'watchers': 9},
                {'subject': {'id': 2, 'name': 'B', 'name_cn': '番B'}},
            ],
        }

        class FakeRsp:
            def raise_for_status(self):
                pass

            def json(self):
                return payload

        with mock.patch('http_client.get', return_value=FakeRsp()) as m:
            out = self.mgr.bangumi_trends(limit=24, offset=0)
        self.assertEqual(out['total'], 2)
        self.assertEqual(len(out['items']), 2)
        self.assertEqual(out['items'][0]['name_cn'], '番A')       # nameCN → name_cn
        self.assertEqual(out['items'][0]['air_date'], '2026-07-06')
        self.assertEqual(out['items'][0]['rating']['rank'], 5)
        self.assertEqual(out['items'][1]['name_cn'], '番B')
        params = m.call_args[1]['params']
        self.assertEqual(params['type'], 2)
        self.assertEqual(params['limit'], 24)
        self.assertEqual(params['offset'], 0)

    def test_trends_failure_returns_empty(self):
        from unittest import mock
        with mock.patch('http_client.get', side_effect=Exception('net down')):
            out = self.mgr.bangumi_trends()
        self.assertEqual(out, {'items': [], 'total': 0})


if __name__ == '__main__':
    unittest.main()
