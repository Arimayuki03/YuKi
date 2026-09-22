# -*- coding: utf-8 -*-
"""真实世界常见 CatVod/TVBox 配置格式的兼容性回归（解析层 + 装配层，离线）。

用户报告「catvod 源网站导入不了」后针对公共仓格式特例补的回归网。
所有样例均取自真实公共仓的公开格式形态（饭太硬/菜妮丝/老刘备等），但
**内容为本地写死的 fixture**，不联网、不下载 jar、不起 Worker——只验证
config 层「能不能把这份配置读进来、归一成正确的路由结论」。

覆盖形态（每条注明出处）：
- 干净 JSON 快通道 / // 与 # 注释 / 行内注释（老刘备、苹果CMS parses 区）
- GBK 编码正文（Windows 记事本保存的本地配置）
- JPEG 尾部 base64 伪装（饭太硬.net/tv、哈基米.png）
- 顶层 spider 数组（菜妮丝 tv.菜妮丝.top、王小二放牛娃）
- 顶层 spider「;;;」主备串（饭太硬系）
- type 写成字符串（手写仓笔误，Gson 静默转整数）
- 站点省略 type 且 api 为 csp_ 类名（FongMi BaseLoader 按 api 形态装载）
- 多仓条目字符串/多键名形态（游魂/老刘备/小盒子多仓）
- 直播源误粘 / HTML 错误页的可操作报错
"""
import base64
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, BASE)

import config  # noqa: E402
from runtime.capability_router import route_site  # noqa: E402
from runtime.config_snapshot import normalize_site_entry, split_jar_ref  # noqa: E402
from runtime.ext_resolver import detect_text  # noqa: E402


class ParseLayerTest(unittest.TestCase):
    """parse_config_json / fetch 辅助层：文本进 → dict 出。"""

    def test_clean_json_fast_path(self):
        cfg = config.parse_config_json(json.dumps(
            {'sites': [{'key': 'a', 'name': 'A', 'type': 3, 'api': 'csp_X'}]}))
        self.assertEqual(len(cfg['sites']), 1)

    def test_comment_lines_and_inline_comments(self):
        # 老刘备/小盒子等仓整行 //；苹果CMS parses 区整行 #；行内 //（分享等）。
        text = (
            '// 主配置\n'
            '{\n'
            '  //站点列表\n'
            '  "spider": "https://x/y.jar;md5;etag",  // 共享 jar\n'
            '  "sites": [\n'
            '    //{"key":"hidden","name":"H","type":3,"api":"csp_H"},\n'
            '    {"key":"a","name":"A","type":3,"api":"csp_X"}  // 末尾注释\n'
            '  ],\n'
            '  "lives": []\n'
            '}\n'
            '# 尾部 # 注释')
        cfg = config.parse_config_json(text)
        self.assertEqual([s['key'] for s in cfg['sites']], ['a'])
        self.assertIn('md5', cfg['spider'])

    def test_urls_in_comment_keep_full_url(self):
        # URL 里的 //（https://）必须原样保留，不能被行内剥除吃掉。
        text = '{"sites": [{"key": "a", "api": "https://x/api.php?ac=list"}]} // tail'
        cfg = config.parse_config_json(text)
        self.assertEqual(cfg['sites'][0]['api'], 'https://x/api.php?ac=list')

    def test_gbk_encoded_text(self):
        # Windows 记事本保存的本地配置常为 GBK：按字节读入后 detect_text 兜底。
        raw = ('{\n  "sites": [{"key":"a","name":"中文站","type":0,'
               '"api":"http://x/api.php?ac=list"}]}\n').encode('gb18030')
        text, encoding = detect_text(raw)
        self.assertEqual(encoding, 'gb18030')
        cfg = config.parse_config_json(text)
        self.assertEqual(cfg['sites'][0]['name'], '中文站')

    def test_image_tail_disguise(self):
        # 饭太硬.net/tv、哈基米.png：JPEG 尾部追加 base64 配置。
        cfg_json = json.dumps(
            {'spider': 'https://x/y.jar;md5',
             'sites': [{'key': 'a', 'name': 'A', 'type': 3, 'api': 'csp_X'}]},
            ensure_ascii=False)
        b64 = base64.b64encode(cfg_json.encode('utf-8')).decode('ascii')
        fake_jpeg = (b'\xff\xd8\xff\xe0\x00\x10JFIF' + b'\x00' * 64 + b'\xff\xd9'
                     + b'\n' + b64.encode('ascii'))
        img_cfg = config._image_tail_config(fake_jpeg)
        self.assertIsNotNone(img_cfg)
        cfg = config.parse_config_json(img_cfg)
        self.assertEqual(len(cfg['sites']), 1)

    def test_live_txt_misinput_gives_actionable_error(self):
        # 直播源误粘进配置框：报错要指路（去直播源入口），不是裸 JSONDecodeError。
        with self.assertRaises(ValueError) as ctx:
            config.parse_config_json('央视频道,#genre#\nCCTV1,http://x/1.m3u8')
        self.assertIn('直播源', str(ctx.exception))

    def test_html_body_error_names_the_cause(self):
        # 拉到 HTML 错误页：报错要带内容开头，便于判断是地址错还是网络劫持。
        with self.assertRaises(ValueError) as ctx:
            config.parse_config_json('<!DOCTYPE html><html><body>404</body></html>')
        self.assertIn('CatVod', str(ctx.exception))
        self.assertIn('DOCTYPE', str(ctx.exception))


class SpiderFieldTest(unittest.TestCase):
    """顶层 spider 字段的各种真实世界写法。"""

    def setUp(self):
        self.mgr = config.ConfigManager(None)
        self.base = 'http://src/tv.json'

    def test_plain_url_with_md5(self):
        got = self.mgr._resolve_spider_jar({'spider': 'https://a/1.jar;md5'}, self.base)
        self.assertEqual(got, 'https://a/1.jar;md5')

    def test_relative_path_resolved(self):
        got = self.mgr._resolve_spider_jar({'spider': './lib/spider.jar'}, self.base)
        self.assertEqual(got, 'http://src/lib/spider.jar')

    def test_dual_backup_semicolon_string(self):
        # 饭太硬系：;;; 分隔主备地址；整串保留给 norm_jar_src 的分号解析。
        raw = 'https://a/1.jar;md5;;;https://b/2.jar;md5'
        got = self.mgr._resolve_spider_jar({'spider': raw}, self.base)
        self.assertEqual(got, raw)

    def test_list_takes_first_resolvable_mirror(self):
        # 菜妮丝 tv.菜妮丝.top、王小二放牛娃：spider 写成镜像数组，依序取第一个
        # 能解析成 http(s) 的地址（相对条目按配置 URL 解析后同样参与）。
        got = self.mgr._resolve_spider_jar(
            {'spider': ['./x.jar', 'https://a/1.jar;md5']}, self.base)
        self.assertEqual(got, 'http://src/x.jar')
        got = self.mgr._resolve_spider_jar(
            {'spider': ['', 'https://a/1.jar;md5', 'https://b/2.jar']}, self.base)
        self.assertEqual(got, 'https://a/1.jar;md5')

    def test_list_with_relative_first_entry(self):
        got = self.mgr._resolve_spider_jar(
            {'spider': ['./lib/spider.jar;md5', 'https://b/2.jar']},
            'http://src/dir/tv.json')
        self.assertEqual(got, 'http://src/dir/lib/spider.jar;md5')

    def test_list_with_no_usable_entry_returns_empty(self):
        got = self.mgr._resolve_spider_jar({'spider': ['assets://x', '', 123]}, self.base)
        self.assertEqual(got, '')

    def test_non_string_scalar_ignored(self):
        self.assertEqual(self.mgr._resolve_spider_jar({'spider': 123}, self.base), '')

    def test_blocked_scheme_still_rejected(self):
        self.assertEqual(
            self.mgr._resolve_spider_jar({'spider': 'assets://x.jar'}, self.base), '')

    def test_unresolved_spider_logs_actionable_warning(self):
        # spider 存在但解析不出 http：必须有可操作的 L1 诊断（此前整仓 csp_
        # 站点静默跳过，用户只看到一批 no shared jar）。
        import logging
        records = []

        class Capture(logging.Handler):
            def emit(self, record):
                records.append(record)

        logger = logging.getLogger('yuki.config')
        handler = Capture()
        logger.addHandler(handler)
        try:
            mgr = config.ConfigManager(None)
            mgr._ctx = config._LoadContext('')
            prepared = mgr._prepare({'spider': 'assets://bad', 'sites': []}, '(inline)')
            self.assertEqual(prepared['summary']['configured'], 0)
        finally:
            logger.removeHandler(handler)
        self.assertTrue(any(
            r.levelno == logging.WARNING and '顶层 spider' in r.getMessage()
            for r in records))


class AssemblyLayerTest(unittest.TestCase):
    """站点条目归一 + 路由：真实仓手写形态不能被误判。"""

    def route(self, item, base_url='', shared_spider=''):
        entry = normalize_site_entry(item, base_url=base_url,
                                     shared_spider=shared_spider)
        decision = route_site(entry.raw, api=entry.api, ext=entry.ext,
                              site_key=entry.key)
        return entry, decision

    def test_cainisi_style_spider_array_and_js_fallbacks(self):
        # 菜妮丝风格：spider 数组 + js0/js1 备用字段 + 字符串 type + 无 type csp_。
        cfg = {
            'spider': ['https://a/1.jar;md5', 'https://b/2.jar'],
            'sites': [
                {'key': 's1', 'name': 'JS0', 'type': 3, 'api': 'csp_X',
                 'js0': 'https://fallback/x.js'},
                {'key': 's2', 'name': 'NoType', 'api': 'csp_Y',
                 'js1': 'https://fallback/y.js'},
                {'key': 's3', 'name': 'StrType', 'type': '1',
                 'api': 'https://cms.example.com/api.php/provide/vod'},
                {'key': 's4', 'name': 'JS4', 'type': 4, 'api': 'https://x/site.js'},
            ],
        }
        mgr = config.ConfigManager(None)
        shared = mgr._resolve_spider_jar(cfg, 'http://src/')
        self.assertEqual(shared, 'https://a/1.jar;md5')

        entry, decision = self.route(cfg['sites'][0], shared_spider=shared)
        self.assertEqual((decision.runtime, decision.supported), ('jar', True))
        # 共享 jar 按「;md5」拆开归一：jar 走 split_jar_ref，md5 单独存放。
        self.assertEqual(entry.jar, 'https://a/1.jar')
        self.assertEqual(entry.jar_md5, 'md5')

        # 无 type 的 csp_ 条目：FongMi BaseLoader 按 api 形态装载 JAR spider。
        _entry, decision = self.route(cfg['sites'][1], shared_spider=shared)
        self.assertEqual((decision.runtime, decision.rule), ('jar', 'R4-jvm-jar'))

        # type 写成字符串（"1"）：Gson 静默转整数，路由按数值判定。
        _entry, decision = self.route(cfg['sites'][2])
        self.assertEqual((decision.runtime, decision.rule), ('cms', 'R1-cms'))

        _entry, decision = self.route(cfg['sites'][3])
        self.assertEqual((decision.runtime, decision.rule), ('js', 'R3-quickjs'))

    def test_fantaiying_style_site_level_relative_jar(self):
        entry, decision = self.route(
            {'key': 'csp_B', 'name': 'B', 'type': 3, 'api': 'csp_B',
             'jar': './lib/custom.jar;abc123'},
            base_url='http://src/dir/tv.json')
        self.assertEqual((decision.runtime, decision.needs_jar), ('jar', True))
        self.assertEqual(entry.jar, 'http://src/dir/lib/custom.jar')
        self.assertEqual(entry.jar_md5, 'abc123')

    def test_omitted_type_csp_entry_routes_to_jar(self):
        # 条目**省略** type 且 api 为 csp_ 类名：FongMi BaseLoader 按 api 形态
        # 装载 JAR spider，不能因 Gson 的 int 缺省 0 就按 CMS 报「api 非 http」。
        _entry, decision = self.route({'key': 's2', 'name': 'NoType', 'api': 'csp_Y'})
        self.assertEqual((decision.runtime, decision.rule), ('jar', 'R4-jvm-jar'))
        self.assertTrue(decision.needs_jar)

    def test_explicit_zero_type_csp_entry_still_invalid(self):
        # 显式 type: 0/1 是 CMS 契约声明：api 不是 http 接口仍要如实报错
        # （既有 test_capability_router.test_r1_requires_http_api 锁定的语义）。
        _entry, decision = self.route({'key': 's2', 'name': 'NoType',
                                       'type': 0, 'api': 'csp_Y'})
        self.assertEqual(decision.error_code, 'L2_SITE_INVALID')
        self.assertEqual(decision.rule, 'R1-cms')

    def test_type_zero_with_non_jar_non_http_api_still_invalid(self):
        # 真正的 CMS 笔误（api 不是接口也不是 jar）仍要如实报错。
        _entry, decision = self.route({'key': 'a', 'api': 'ftp://x/y'})
        self.assertEqual(decision.error_code, 'L2_SITE_INVALID')

    def test_zero_type_csp_entry_builds_with_actionable_error_without_jar(self):
        # 装配层：零 type + csp_ 且无共享 jar 时，报错必须指出「缺顶层 spider」，
        # 而不是旧版的「no shared jar」——整仓失败时用户无从排查。
        mgr = config.ConfigManager(None)
        mgr._ctx = config._LoadContext('')
        with self.assertRaises(ValueError) as ctx:
            mgr._build_site({'key': 'x', 'api': 'csp_A'})
        self.assertIn('顶层 spider', str(ctx.exception))
        self.assertIn('csp_A', str(ctx.exception))

    def test_split_jar_ref_triple_segment(self):
        # FongMi 标准 url;md5;值：头段是 URL，尾段是校验值。
        head, md5 = split_jar_ref('https://x/spider.jar;md5;abc123')
        self.assertEqual(head, 'https://x/spider.jar')
        self.assertEqual(md5, 'md5;abc123')


class MultiRepoEntryTest(unittest.TestCase):
    """多仓（顶层 urls）条目的手写形态。"""

    def setUp(self):
        self.mgr = config.ConfigManager(None)

    def test_string_and_dict_forms(self):
        forms = ['http://a/1.json',
                 {'name': '主', 'url': 'http://a/1.json'},
                 {'name': '备', 'urlStr': 'http://b/2.json'},
                 {'title': '标', 'sourceUrl': 'http://c/3.json'},
                 {'key': '键', 'link': 'http://d/4.json'},
                 {'name': '空', 'url': ''}]
        out = [self.mgr._normalize_repo_entry(x) for x in forms]
        self.assertEqual([o['url'] for o in out[:5]],
                         ['http://a/1.json', 'http://a/1.json', 'http://b/2.json',
                          'http://c/3.json', 'http://d/4.json'])
        # 空 url 的 dict 条目保留（url 为空串，多仓循环里 `if not sub: continue` 跳过）
        self.assertEqual(out[5], {'name': '空', 'url': ''})

    def test_dotted_key_manifest_normalizes(self):
        # 部分影视仓把仓名直接作为对象 key。
        cfg = {'urls': {'主仓': 'http://a/1.json',
                        '备仓': {'url': 'http://b/2.json', 'name': 'x'}}}
        mgr = config.ConfigManager(None)
        repo_urls = cfg['urls']
        normalized = [dict(value, name=key) if isinstance(value, dict)
                      else {'name': key, 'url': value}
                      for key, value in repo_urls.items()]
        self.assertEqual(normalized[0]['name'], '主仓')
        self.assertEqual(normalized[1]['url'], 'http://b/2.json')


if __name__ == '__main__':
    unittest.main(verbosity=2)
