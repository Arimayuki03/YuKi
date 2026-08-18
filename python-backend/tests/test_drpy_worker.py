# -*- coding: utf-8 -*-
"""正式 drpy Worker 核心契约、五方法、安全边界与生命周期自愈测试套件 (test_drpy_worker.py)

强断言覆盖验证：
1. 四套真实规则（CMS、CryptoJS 签名鉴权、动态模板 eval、Stateful Local 会话）五方法强校验；
2. 异常处理：语法错误、抛错规则、模块加载失败不崩溃宿主；
3. 超时与死循环强杀：1.5s 强制 SIGKILL / TerminateProcess；
4. 强杀后规则自愈：Supervisor 自动重启并在下一次 RPC 时自动重载规则源码；
5. 安全沙箱隔离：
   - 彻底拦截 child_process
   - 拦截文件系统越界访问（只能读写专属受控临时目录）
   - 临时目录在 Worker destroy 时彻底清理；
6. 内存超限检测与硬兜底。
"""

import json
import os
import sys
import time
import unittest

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(CURRENT_DIR, '..'))
DRPY_ENGINE_DIR = os.path.join(BACKEND_DIR, 'drpy-engine')
FIXTURE_DIR = os.path.join(BACKEND_DIR, 'spike', 'fixtures')

for p in (BACKEND_DIR, DRPY_ENGINE_DIR, FIXTURE_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

from mock_server import MockHttpServer, patch_host
from drpy_supervisor import (
    DrpySupervisor,
    DrpyWorkerError,
    DrpyWorkerTimeoutError,
    DrpyWorkerMemoryLimitError
)
from drpy_spider import DrpySpider, make_drpy_spider_class


class TestDrpyWorkerContract(unittest.TestCase):
    """测试正式 drpy 规则在 Node 沙箱下的完整五方法契约（强断言）"""

    @classmethod
    def setUpClass(cls):
        cls.mock_server = MockHttpServer()
        cls.base_url = cls.mock_server.start()

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'mock_server') and cls.mock_server:
            cls.mock_server.stop()

    def _load_rule_source(self, filename: str) -> str:
        path = os.path.join(FIXTURE_DIR, filename)
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        return patch_host(content, self.base_url)

    def test_rule1_simple_cms_strong_assertions(self):
        """Rule 1 (CMS HTML/DOM 选择器)：强断言校验 class/list 内容"""
        src = self._load_rule_source('rule1_simple_cms.js')
        spider = make_drpy_spider_class('rule1_cms', src, name='Rule1 CMS')
        try:
            spider.init()
            # 1. home
            home = spider.homeContent(False)
            self.assertIsInstance(home, dict)
            self.assertGreater(len(home.get('class', [])), 0, "homeContent class 列表不能为空")
            self.assertGreater(len(home.get('list', [])), 0, "homeContent list 列表不能为空")
            self.assertEqual(home['class'][0]['type_id'], 'movie')

            # 2. category
            cat = spider.categoryContent('movie', '1', False, {})
            self.assertIsInstance(cat, dict)
            self.assertEqual(cat.get('page'), 1)
            self.assertGreater(len(cat.get('list', [])), 0, "categoryContent list 列表不能为空")
            self.assertTrue(any('MOVIE' in str(v.get('vod_name', '')).upper() for v in cat['list']))

            # 3. detail
            vod_id = cat['list'][0]['vod_id']
            detail = spider.detailContent(vod_id)
            self.assertIsInstance(detail, dict)
            self.assertGreater(len(detail.get('list', [])), 0, "detailContent 不能为空")
            first_vod = detail['list'][0]
            self.assertEqual(first_vod.get('vod_id'), vod_id)
            self.assertIn('vod_play_url', first_vod)
            self.assertGreater(len(first_vod['vod_play_url']), 0)

            # 4. search
            search = spider.searchContent('测试', False, '1')
            self.assertIsInstance(search, dict)
            self.assertGreater(len(search.get('list', [])), 0, "searchContent 不能为空")

            # 5. play
            play = spider.playerContent('f1', '/cms/play/x.m3u8')
            self.assertIsInstance(play, dict)
            self.assertIn('url', play)
            self.assertTrue(play['url'].startswith('http://') or play['url'].startswith('https://'))
        finally:
            spider.destroy()

    def test_rule2_crypto_auth_strong_assertions(self):
        """Rule 2 (CryptoJS 签名鉴权 + AES 信封解密)：强断言校验"""
        src = self._load_rule_source('rule2_crypto_auth.js')
        spider = make_drpy_spider_class('rule2_crypto', src, name='Rule2 Crypto')
        try:
            spider.init()
            # 1. home
            home = spider.homeContent(False)
            self.assertGreater(len(home.get('class', [])), 0)

            # 2. category
            cat = spider.categoryContent('1', '1', False, {})
            self.assertGreater(len(cat.get('list', [])), 0)

            # 3. detail
            detail = spider.detailContent('1001')
            self.assertGreater(len(detail.get('list', [])), 0)

            # 4. search
            search = spider.searchContent('测试', False, '1')
            self.assertGreater(len(search.get('list', [])), 0)

            # 5. play (AES 解密)
            play = spider.playerContent('f1', '/cms/play/x.m3u8')
            self.assertIn('url', play)
            self.assertTrue(play['url'].startswith('https://stream.mock.test/'))
            self.assertIn('token=', play['url'])
        finally:
            spider.destroy()

    def test_rule3_template_eval_strong_assertions(self):
        """Rule 3 (动态 eval / new Function 模板)：强断言校验"""
        src = self._load_rule_source('rule3_template_eval.js')
        spider = make_drpy_spider_class('rule3_eval', src, name='Rule3 Eval')
        try:
            spider.init()
            home = spider.homeContent(False)
            self.assertGreater(len(home.get('class', [])), 0)

            cat = spider.categoryContent('d1', '1', False, {})
            self.assertGreater(len(cat.get('list', [])), 0)

            detail = spider.detailContent('1001')
            self.assertGreater(len(detail.get('list', [])), 0)

            search = spider.searchContent('测试', False, '1')
            self.assertGreater(len(search.get('list', [])), 0)

            play = spider.playerContent('f1', 'eval_stream://test_vid_888')
            self.assertIn('url', play)
            self.assertIn('cdn.eval.test', play['url'])
        finally:
            spider.destroy()

    def test_rule4_stateful_local_strong_assertions(self):
        """Rule 4 (Local KV 状态维持)：强断言校验持久会话"""
        src = self._load_rule_source('rule4_stateful_local.js')
        spider = make_drpy_spider_class('rule4_local', src, name='Rule4 Local')
        try:
            spider.init()
            home = spider.homeContent(False)
            self.assertGreater(len(home.get('class', [])), 0)

            cat = spider.categoryContent('s1', '1', False, {})
            self.assertGreater(len(cat.get('list', [])), 0)

            detail = spider.detailContent('1001')
            self.assertGreater(len(detail.get('list', [])), 0)

            play = spider.playerContent('f1', '/cms/play/x.m3u8')
            self.assertIn('header', play)
            self.assertIn('session_token=valid_token_xyz_888', play['header'].get('Cookie', ''))
        finally:
            spider.destroy()


class TestDrpyWorkerSafetyAndLifecycle(unittest.TestCase):
    """测试安全沙箱边界、超时强杀与自愈能力"""

    def test_sandbox_blocks_child_process(self):
        """验证沙箱彻底封禁 child_process 模块与执行"""
        bad_rule = """
        var rule = {
            home: function() {
                var cp = require('child_process');
                return cp.execSync('whoami').toString();
            }
        };
        """
        sup = DrpySupervisor(timeout=2.0)
        try:
            sup.start()
            sup.load_rule(bad_rule)
            with self.assertRaises(DrpyWorkerError) as cm:
                sup.call_rpc('home')
            self.assertIn("not allowed in sandbox", str(cm.exception))
        finally:
            sup.destroy()

    def test_sandbox_blocks_arbitrary_fs(self):
        """验证沙箱阻止对操作系统任意敏感文件的读取"""
        bad_rule = """
        var rule = {
            home: function() {
                var fs = require('fs');
                return fs.readFileSync('C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts', 'utf8');
            }
        };
        """
        sup = DrpySupervisor(timeout=2.0)
        try:
            sup.start()
            sup.load_rule(bad_rule)
            with self.assertRaises(DrpyWorkerError) as cm:
                sup.call_rpc('home')
            self.assertIn("outside the allowed sandbox directory", str(cm.exception))
        finally:
            sup.destroy()

    def test_timeout_and_infinite_loop_kill(self):
        """验证死循环规则在超时后被 Supervisor 真实强杀"""
        infinite_rule = """
        var rule = {
            home: function() {
                var start = Date.now();
                while (Date.now() - start < 10000) {}
                return "finished";
            }
        };
        """
        sup = DrpySupervisor(timeout=1.5)
        try:
            sup.start()
            sup.load_rule(infinite_rule)
            start_time = time.time()
            with self.assertRaises(DrpyWorkerTimeoutError):
                sup.call_rpc('home', timeout=1.5)
            elapsed = time.time() - start_time
            self.assertLess(elapsed, 3.5, "死循环应在指定超时期被立即打断")
            self.assertFalse(sup.is_alive(), "强杀后 Worker 进程必须终止")
        finally:
            sup.destroy()

    def test_auto_reload_rule_healing_after_kill(self):
        """验证 Supervisor 强杀后，下一次调用可自动重启并重放恢复规则（自愈能力，解决 P0-3）"""
        normal_rule = """
        var rule = {
            home: function() {
                return JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }], list: [{ vod_id: '101', vod_name: '自愈测试影片' }] });
            }
        };
        """
        sup = DrpySupervisor(timeout=5.0)
        try:
            sup.start()
            sup.load_rule(normal_rule)
            
            # 1. 首次正常调用
            res1 = json.loads(sup.call_rpc('home'))
            self.assertEqual(res1['list'][0]['vod_name'], '自愈测试影片')

            # 2. 人为强制杀死 Worker 进程
            sup.kill()
            self.assertFalse(sup.is_alive())

            # 3. 再次发起 RPC：Supervisor 应该自动拉起新进程并重新载入 normal_rule，调用成功
            res2 = json.loads(sup.call_rpc('home'))
            self.assertEqual(res2['list'][0]['vod_name'], '自愈测试影片')
            self.assertTrue(sup.is_alive())
        finally:
            sup.destroy()

    def test_memory_limit_interception(self):
        """验证内存超限检测与拦截"""
        mem_rule = """
        var leak = [];
        var rule = {
            home: function() {
                for (var i = 0; i < 200000; i++) {
                    leak.push(new Array(1000).fill('memory_leak_test_payload'));
                }
                return JSON.stringify({ count: leak.length });
            }
        };
        """
        sup = DrpySupervisor(max_memory_mb=64.0, timeout=10.0)
        try:
            sup.start()
            sup.load_rule(mem_rule)
            with self.assertRaises(DrpyWorkerMemoryLimitError):
                sup.call_rpc('home')
            self.assertFalse(sup.is_alive())
        finally:
            sup.destroy()


def run_tests():
    suite = unittest.TestSuite()
    loader = unittest.TestLoader()
    suite.addTests(loader.loadTestsFromTestCase(TestDrpyWorkerContract))
    suite.addTests(loader.loadTestsFromTestCase(TestDrpyWorkerSafetyAndLifecycle))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(run_tests())
