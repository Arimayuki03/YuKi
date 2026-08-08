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


if __name__ == '__main__':
    unittest.main()
