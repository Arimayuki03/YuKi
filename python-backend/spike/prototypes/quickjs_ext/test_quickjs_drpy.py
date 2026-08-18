# -*- coding: utf-8 -*-
"""drpy QuickJS 扩展原型综合测试与兼容性验证套件。

覆盖验证：
1. 完整 drpy 契约环境注入（cheerio, pdfa, pdfh, pdft, pd, CryptoJS, req, request, post, local, joinUrl 等）。
2. CPU 执行时限 (time_limit) 与死循环中断。
3. 内存配额 (memory_limit) 与大量内存分配拦截。
4. QuickJS 无原生事件循环/微任务调度边界测试：同步 req()、Promise/async 方法解析。
5. 统一 Python 调用适配器 QuickJsDrpySpider 与 4 套真实/仿真 drpy 规则（CMS、CryptoJS、动态模板、Stateful Local）的 e2e 联调。
"""

import json
import os
import sys
import time
import unittest

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(CURRENT_DIR, '..', '..', '..'))
FIXTURE_DIR = os.path.abspath(os.path.join(CURRENT_DIR, '..', '..', 'fixtures'))

for p in (BACKEND_DIR, CURRENT_DIR, FIXTURE_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

from mock_server import MockHttpServer, patch_host
from quickjs_drpy_engine import QuickJsDrpyEngine
from quickjs_drpy_spider import QuickJsDrpySpider, make_quickjs_drpy_spider


class TestQuickJsDrpyEngine(unittest.TestCase):
    """测试 QuickJS drpy 引擎基础环境与契约全局注入"""

    def setUp(self):
        self.engine = QuickJsDrpyEngine(site_key='unit_test_site')

    def test_drpy_globals_injected(self):
        """验证所有必要的 drpy 全局变量与函数类型"""
        types = {
            'cheerio': 'function',
            'CryptoJS': 'object',
            'pdfa': 'function',
            'pdfh': 'function',
            'pdft': 'function',
            'pd': 'function',
            'joinUrl': 'function',
            'urljoin': 'function',
            'req': 'function',
            'request': 'function',
            'post': 'function',
            'local': 'object',
            'atob': 'function',
            'btoa': 'function',
            'dayjs': 'function',
            'md5X': 'function',
        }
        for name, expected_type in types.items():
            actual = self.engine.ctx.eval(f"typeof globalThis.{name}")
            self.assertEqual(
                actual,
                expected_type,
                f"Global '{name}' expected type '{expected_type}', got '{actual}'",
            )

    def test_dom_selectors(self):
        """验证 pdfa / pdfh / pdft / pd DOM 选择器功能"""
        html = """
        <div class="container">
            <div class="nav-menu">
                <a class="nav-item" href="/category/movie"><span>电影</span></a>
                <a class="nav-item" href="/category/tv"><span>电视剧</span></a>
            </div>
            <div class="card-list">
                <div class="card" data-id="101">
                    <img src="/poster1.jpg" alt="海报1"/>
                    <h3 class="title">流浪地球</h3>
                    <p class="desc">科幻冒险</p>
                </div>
            </div>
        </div>
        """
        # 将 html 注入上下文测试
        self.engine.ctx.eval(f"var testHtml = {json.dumps(html)};")
        
        # 1. pdfa
        items_cnt = self.engine.ctx.eval("pdfa(testHtml, '.nav-menu a.nav-item').length")
        self.assertEqual(items_cnt, 2)
        
        # 2. pdft
        t1 = self.engine.ctx.eval("pdft(testHtml, '.card .title')")
        self.assertEqual(t1, '流浪地球')
        
        # 3. pdfh (带属性与不带属性)
        h_text = self.engine.ctx.eval("pdfh(testHtml, '.card .desc')")
        self.assertEqual(h_text, '科幻冒险')
        
        # 4. pd
        src = self.engine.ctx.eval("pd(testHtml, '.card img&&src')")
        self.assertEqual(src, '/poster1.jpg')
        
        # 5. pdft / pd on child html snippet
        child_html = self.engine.ctx.eval("pdfa(testHtml, '.nav-menu a.nav-item')[0]")
        c_title = self.engine.ctx.eval(f"pdft({json.dumps(child_html)}, 'span')")
        c_href = self.engine.ctx.eval(f"pd({json.dumps(child_html)}, 'a&&href')")
        self.assertEqual(c_title, '电影')
        self.assertEqual(c_href, '/category/movie')

    def test_join_url(self):
        """验证 joinUrl 相对/绝对路径解析能力"""
        cases = [
            ("http://example.com/a/b/c", "d", "http://example.com/a/b/d"),
            ("http://example.com/a/b/", "d", "http://example.com/a/b/d"),
            ("http://example.com/a/b", "/root", "http://example.com/root"),
            ("http://example.com/a/b", "http://other.com/x", "http://other.com/x"),
            ("https://example.com/a", "//cdn.example.com/lib.js", "https://cdn.example.com/lib.js"),
        ]
        for base, rel, expected in cases:
            res = self.engine.ctx.eval(f"joinUrl({json.dumps(base)}, {json.dumps(rel)})")
            self.assertEqual(res, expected)

    def test_cryptojs_algorithms(self):
        """验证 CryptoJS 各加密算法"""
        # MD5
        md5_res = self.engine.ctx.eval("CryptoJS.MD5('hello').toString()")
        self.assertEqual(md5_res, "5d41402abc4b2a76b9719d911017c592")

        # SHA256
        sha_res = self.engine.ctx.eval("CryptoJS.SHA256('hello').toString()")
        self.assertEqual(sha_res, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")

        # HmacSHA256
        hmac_res = self.engine.ctx.eval("CryptoJS.HmacSHA256('message', 'secret').toString(CryptoJS.enc.Hex)")
        self.assertEqual(hmac_res, "8b5f48702995c1598c573db1e21866a9b825d4a794d169d7060a03605796360b")

        # AES encrypt / decrypt
        aes_test = """
        (function() {
            var secret = 'my_secret_passphrase';
            var original = 'Drpy QuickJS Secret Payload 2026';
            var cipher = CryptoJS.AES.encrypt(original, secret).toString();
            var decrypted = CryptoJS.AES.decrypt(cipher, secret).toString(CryptoJS.enc.Utf8);
            return decrypted;
        })()
        """
        aes_dec = self.engine.ctx.eval(aes_test)
        self.assertEqual(aes_dec, 'Drpy QuickJS Secret Payload 2026')

    def test_local_storage_contract(self):
        """验证 local 存储双级命名空间及别名契约"""
        self.engine.ctx.eval("local.set('key1', 'val1');")
        self.assertEqual(self.engine.ctx.eval("local.get('key1')"), 'val1')
        self.assertEqual(self.engine.ctx.eval("local.getItem('key1')"), 'val1')

        # 两级 kv 模式
        self.engine.ctx.eval("local.set('user_ns', 'token', 'token_123456');")
        self.assertEqual(self.engine.ctx.eval("local.get('user_ns', 'token')"), 'token_123456')

        # 删除
        self.engine.ctx.eval("local.delete('key1');")
        self.assertEqual(self.engine.ctx.eval("local.get('key1')"), '')


class TestResourceLimitsAndAsyncBoundaries(unittest.TestCase):
    """测试 CPU、内存时限与 QuickJS 缺乏 Node 原生事件循环时的兼容性与边界"""

    def test_time_limit_interrupts_infinite_loop(self):
        """测试 time_limit 超时机制，确保死循环代码能被可靠中断，不冻结宿主"""
        engine = QuickJsDrpyEngine()
        engine.set_time_limit(1.0)
        start = time.time()
        with self.assertRaises(Exception) as cm:
            engine.ctx.eval("while(true) {}")
        elapsed = time.time() - start
        self.assertLess(elapsed, 2.5, "Infinite loop should be interrupted within time limit")
        self.assertIn("interrupted", str(cm.exception).lower())
        engine.set_time_limit(0)

    def test_memory_limit_catches_large_allocations(self):
        """测试 memory_limit 内存超限保护"""
        # cat.js 本身解析加载需要约 20~30MB 堆内存，测试设为 40MB 并在分配超大数组时拦截
        engine = QuickJsDrpyEngine(memory_limit_mb=40.0)
        with self.assertRaises(Exception):
            engine.ctx.eval("""
            var big = [];
            for (var i = 0; i < 10000000; i++) {
                big.push('chunk_payload_alloc_exceed_limits_' + i);
            }
            """)

    def test_promise_and_microtask_drain_boundary(self):
        """验证在缺乏 Node 事件循环时，Promise 微任务通过 execute_pending_job() 的调度机制与边界"""
        engine = QuickJsDrpyEngine()
        
        # 1. 挂载一个返回 Promise 的异步规则方法
        fake_async_rule = """
        var rule = {
            title: 'Async Promise Test Rule',
            home: async function() {
                var step1 = await Promise.resolve('data_step_1');
                var step2 = await (new Promise(function(resolve) {
                    resolve(step1 + '_step_2');
                }));
                return JSON.stringify({ result: step2 });
            }
        };
        """
        self.assertTrue(engine.load_spider(fake_async_rule))
        res_raw = engine.call('home')
        self.assertIsNotNone(res_raw)
        res = json.loads(res_raw)
        self.assertEqual(res.get('result'), 'data_step_1_step_2')

    def test_sync_req_in_async_and_sync_flows(self):
        """验证 req() / request() 在普通同步函数与 async 函数中的行为"""
        # 使用 mock 回调拦截网络
        def mock_http(url, opt_json):
            return json.dumps({
                'ok': True,
                'status': 200,
                'code': 200,
                'content': '<html><body><h1>Mock Sync Response</h1></body></html>',
                'headers': {'Content-Type': 'text/html'}
            })

        engine = QuickJsDrpyEngine(custom_http_handler=mock_http)
        rule_src = """
        var rule = {
            title: 'Sync Req in Diverse Contexts',
            // 纯同步使用 req / request
            syncMethod: function() {
                var html = req('http://test.mock/sync');
                var title = pdft(html, 'h1');
                return JSON.stringify({ title: title });
            },
            // async 函数中使用同步 req
            asyncMethod: async function() {
                var html = request('http://test.mock/async');
                var title = pdft(html, 'h1');
                return JSON.stringify({ title: title + '_from_async' });
            }
        };
        """
        self.assertTrue(engine.load_spider(rule_src))
        
        # 测试同步调用
        sync_res = json.loads(engine.call('syncMethod'))
        self.assertEqual(sync_res.get('title'), 'Mock Sync Response')

        # 测试 async 调用
        async_res = json.loads(engine.call('asyncMethod'))
        self.assertEqual(async_res.get('title'), 'Mock Sync Response_from_async')


class TestQuickJsDrpySpiderE2E(unittest.TestCase):
    """测试统一 Python 适配器 QuickJsDrpySpider 与真实 4 套 drpy 规则的完整调用流程"""

    @classmethod
    def setUpClass(cls):
        cls.mock_server = MockHttpServer()
        cls.base_url = cls.mock_server.start()

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'mock_server') and cls.mock_server:
            cls.mock_server.stop()

    def _load_fixture(self, filename: str) -> str:
        path = os.path.join(FIXTURE_DIR, filename)
        with open(path, encoding='utf-8') as f:
            content = f.read()
        return patch_host(content, self.base_url)

    def test_rule1_simple_cms_full_flow(self):
        """测试 Rule 1: 简单 HTML / DOM CMS 解析规则"""
        js_src = self._load_fixture('rule1_simple_cms.js')
        spider = make_quickjs_drpy_spider('rule1', 'CMS站点', js_src)
        
        # 1. homeContent
        home = spider.homeContent()
        self.assertIn('class', home)
        self.assertIn('list', home)
        self.assertTrue(len(home['class']) > 0)
        self.assertTrue(len(home['list']) > 0)
        self.assertEqual(home['class'][0]['type_id'], 'movie')

        # 2. categoryContent
        cat = spider.categoryContent('movie', '1')
        self.assertEqual(cat.get('page'), 1)
        self.assertTrue(len(cat.get('list', [])) > 0)

        # 3. detailContent
        detail = spider.detailContent('1001')
        self.assertIn('list', detail)
        self.assertEqual(detail['list'][0]['vod_id'], '1001')
        self.assertIn('vod_play_url', detail['list'][0])

        # 4. searchContent
        search = spider.searchContent('测试', quick=False, pg='1')
        self.assertEqual(search.get('page'), 1)
        self.assertTrue(len(search.get('list', [])) > 0)

        # 5. playerContent
        play = spider.playerContent('f1', '/cms/play/x.m3u8')
        self.assertIn('url', play)
        self.assertIn(self.base_url, play['url'])

    def test_rule2_crypto_auth_full_flow(self):
        """测试 Rule 2: CryptoJS 加密鉴权/Token 计算类规则"""
        js_src = self._load_fixture('rule2_crypto_auth.js')
        spider = make_quickjs_drpy_spider('rule2', 'Crypto站点', js_src)

        # 1. homeContent
        home = spider.homeContent()
        self.assertTrue(len(home.get('class', [])) > 0)

        # 2. categoryContent
        cat = spider.categoryContent('1', '1')
        self.assertEqual(cat.get('page'), 1)
        self.assertTrue(len(cat.get('list', [])) > 0)

        # 3. detailContent
        detail = spider.detailContent('1001')
        self.assertEqual(detail['list'][0]['vod_id'], '1001')

        # 4. searchContent
        search = spider.searchContent('测试', False, '1')
        self.assertTrue(len(search.get('list', [])) > 0)

        # 5. playerContent (AES 解密验证)
        play = spider.playerContent('f1', '/cms/play/x.m3u8')
        self.assertIn('url', play)
        self.assertTrue(play['url'].startswith('https://stream.mock.test/'))
        self.assertIn('token=', play['url'])

    def test_rule3_template_eval_full_flow(self):
        """测试 Rule 3: 动态代码执行、模板解析与二级解析规则"""
        js_src = self._load_fixture('rule3_template_eval.js')
        spider = make_quickjs_drpy_spider('rule3', '动态模板站点', js_src)

        # 1. homeContent
        home = spider.homeContent()
        self.assertTrue(len(home.get('class', [])) > 0)

        # 2. categoryContent
        cat = spider.categoryContent('d1', '1')
        self.assertEqual(cat.get('page'), 1)

        # 3. detailContent
        detail = spider.detailContent('1001')
        self.assertEqual(detail['list'][0]['vod_id'], '1001')

        # 4. searchContent
        search = spider.searchContent('测试', False, '1')
        self.assertTrue(len(search.get('list', [])) > 0)

        # 5. playerContent
        play = spider.playerContent('f1', 'eval_stream://test_vid_888')
        self.assertIn('url', play)
        self.assertIn('cdn.eval.test', play['url'])

    def test_rule4_stateful_local_full_flow(self):
        """测试 Rule 4: local 状态存储与跨调用 session 维持规则"""
        js_src = self._load_fixture('rule4_stateful_local.js')
        spider = make_quickjs_drpy_spider('rule4_state', 'Stateful站点', js_src)

        # 连续调用多个 API，验证跨调用 session 维持
        home = spider.homeContent()
        self.assertTrue(len(home.get('class', [])) > 0)

        cat = spider.categoryContent('s1', '1')
        self.assertEqual(cat.get('page'), 1)

        detail = spider.detailContent('1001')
        self.assertEqual(detail['list'][0]['vod_id'], '1001')

        search = spider.searchContent('测试', False, '1')
        self.assertTrue(len(search.get('list', [])) > 0)

        play = spider.playerContent('f1', '/cms/play/x.m3u8')
        self.assertIn('header', play)
        self.assertIn('session_token=valid_token_xyz_888', play['header'].get('Cookie', ''))


def run_tests():
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(TestQuickJsDrpyEngine))
    suite.addTests(loader.loadTestsFromTestCase(TestResourceLimitsAndAsyncBoundaries))
    suite.addTests(loader.loadTestsFromTestCase(TestQuickJsDrpySpiderE2E))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(run_tests())
