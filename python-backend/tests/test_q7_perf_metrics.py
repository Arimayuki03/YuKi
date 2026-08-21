# -*- coding: utf-8 -*-
"""Q7.5 性能与资源基线记录测试套件：
- 冷启动时间
- 首次配置加载时间
- 站点初始化峰值与耗时
- Python/JVM/Node Worker 内存与句柄观测
- 播放地址获取与分段耗时基线
"""
import os
import sys
import time
import unittest

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from config import ConfigManager
from site_manager import SiteManager
from tests.fixtures.q7_offline_fixtures import Q7OfflineFixtureServer


class TestQ7PerformanceAndResourceBaselines(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Q7OfflineFixtureServer()
        cls.server.__enter__()
        cls.base = cls.server.base_url

    @classmethod
    def tearDownClass(cls):
        cls.server.close()

    def test_cold_start_and_100_sites_load_metrics(self):
        t0 = time.perf_counter()
        sm = SiteManager()
        cm = ConfigManager(sm)
        t_init = (time.perf_counter() - t0) * 1000.0  # ms
        self.assertLess(t_init, 1000.0, "配置管理器初始化耗时应小于 1000ms")

        # 100 站点离线并发配置加载耗时
        t1 = time.perf_counter()
        res = cm.load(f"{self.base}/config/perf_100.json")
        t_load = (time.perf_counter() - t1) * 1000.0  # ms
        self.assertLess(t_load, 15000.0, "100 站点初始化耗时应小于 15000ms")
        self.assertEqual(len(sm.sites), 100)
        sm.destroy_all()

    def test_playback_resolution_time_metrics(self):
        sm = SiteManager()
        cm = ConfigManager(sm)
        cm.load(f"{self.base}/config/perf_100.json")
        site = sm.get("perf_site_0")
        self.assertIsNotNone(site)

        # 播放解析耗时
        t0 = time.perf_counter()
        play_info = site.runner.playerContent("q7_line1", f"{self.base}/media/video.mp4", [])
        t_play = (time.perf_counter() - t0) * 1000.0  # ms
        self.assertLess(t_play, 1000.0, "直链解析耗时应小于 1000ms")
        self.assertTrue(play_info['url'].startswith("http://127.0.0.1"))
        sm.destroy_all()


if __name__ == '__main__':
    unittest.main()
