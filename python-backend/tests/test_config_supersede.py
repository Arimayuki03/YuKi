# -*- coding: utf-8 -*-
"""导入接管（supersede）契约：用户导入必须能接管进行中的后台加载。

回归背景：大仓库的启动恢复 / 主进程自动重载曾长期占住 loading 态（多仓合并
串行构建附加站点，死镜像单项就要挂 60-90s），期间用户每次点导入都收到
L1_CONFIG_BUSY——表现为「所有导入都报错」。加载任务仍是全局单例，但接管
规则变为：用户导入（带 requestId）可接管任何进行中的加载；自动重载（无
requestId）不得打断用户正在等结果的导入。被接管的旧线程不得回写任务状态。
"""
import os
import sys
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
for _path in (BASE, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import server  # noqa: E402


def _wait_status(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with server._config_lock:
            if predicate(server._config_task):
                return True
        time.sleep(0.02)
    return False


class SupersedeTest(unittest.TestCase):
    def setUp(self):
        self._saved_task = dict(server._config_task)
        server._config_task.update({
            'status': 'idle', 'summary': None, 'msg': '', 'stage': 'idle',
            'requestId': '', 'user': False, 'seq': 0,
        })
        self._orig_load = server.config_mgr.load
        self._orig_cancel = server.config_mgr.cancel_active_load
        # 接管路径会触碰真管理器的代际状态；单测里换成无操作存根。
        server.config_mgr.cancel_active_load = lambda: None
        self.addCleanup(self._restore)

    def _restore(self):
        server.config_mgr.load = self._orig_load
        server.config_mgr.cancel_active_load = self._orig_cancel
        server._config_task.clear()
        server._config_task.update(self._saved_task)

    def _block_load_by_url(self):
        """按 URL 阻塞 config_mgr.load：各 URL 一个释放闸，方便精确控制新旧
        两个加载线程的完成顺序。"""
        gates = {}

        def fake_load(text, **_kwargs):
            gate = gates.setdefault(str(text), threading.Event())
            gate.wait(10)
            return {'sites': 1, 'healthy': 1, 'configured': 1}
        server.config_mgr.load = fake_load
        return gates

    def test_user_import_supersedes_background_load(self):
        gates = self._block_load_by_url()
        old_url, new_url = 'http://x.invalid/auto.json', 'http://x.invalid/user.json'

        self.assertTrue(server._config_load_async(old_url),
                        '空闲时后台加载应直接启动')
        self.assertFalse(server._config_task['user'])

        self.assertTrue(server._config_load_async(new_url, request_id='cfg-9', user=True),
                        '用户导入必须能接管进行中的后台加载')
        self.assertTrue(server._config_task['user'])
        self.assertEqual(server._config_task['requestId'], 'cfg-9')

        # 新任务先完成；旧线程随后完成时不得回写状态
        gates[new_url].set()
        self.assertTrue(_wait_status(lambda t: t['status'] == 'done'),
                        '新加载应在放行后完成')
        gates[old_url].set()
        self.assertTrue(_wait_status(
            lambda t: t['status'] == 'done' and t['requestId'] == 'cfg-9'),
            '旧线程完成后必须保持新任务的结果')
        time.sleep(0.2)
        self.assertEqual(server._config_task['requestId'], 'cfg-9',
                         '被接管的旧线程不得回写任务状态')

    def test_auto_reload_never_supersedes_user_import(self):
        gates = self._block_load_by_url()
        user_url = 'http://x.invalid/user.json'

        self.assertTrue(server._config_load_async(user_url, request_id='cfg-1', user=True))
        self.assertIsNone(server._config_load_async('http://x.invalid/auto.json'),
                           '自动重载不得打断用户正在等结果的导入')
        self.assertEqual(server._config_task['requestId'], 'cfg-1')

        gates[user_url].set()
        self.assertTrue(_wait_status(
            lambda t: t['status'] == 'done' and t['requestId'] == 'cfg-1'),
            '用户导入应正常完成，不被自动重载影响')

    def test_auto_reload_never_supersedes_startup_restore(self):
        """回归：启动恢复（后台加载）进行到一半时，主进程自动重载不得取消它换
        慢速网络重载——否则恢复永远不出结果，首页一直停在示例源。"""
        gates = self._block_load_by_url()
        restore_url = 'http://x.invalid/repo.json'

        self.assertTrue(server._config_load_async(restore_url),
                        '空闲时后台加载（恢复/自动重载）直接启动')
        self.assertIsNone(server._config_load_async('http://x.invalid/auto.json'),
                           '自动重载对进行中的后台加载一律 BUSY，不得接管')
        self.assertFalse(server._config_task['user'])
        self.assertEqual(server._config_task['requestId'], '')

        gates[restore_url].set()
        self.assertTrue(_wait_status(lambda t: t['status'] == 'done'),
                        '后台加载不被自动重载影响，正常完成')

    def test_newest_user_import_wins(self):
        gates = self._block_load_by_url()
        self.assertTrue(server._config_load_async('http://x.invalid/u1.json',
                                                  request_id='cfg-1', user=True))
        self.assertTrue(server._config_load_async('http://x.invalid/u2.json',
                                                  request_id='cfg-2', user=True),
                        '用户的最新导入接管上一次导入')
        self.assertEqual(server._config_task['requestId'], 'cfg-2')
        for gate in gates.values():
            gate.set()
        self.assertTrue(_wait_status(
            lambda t: t['status'] == 'done' and t['requestId'] == 'cfg-2'))

    def test_progress_reporter_only_writes_current_seq(self):
        """进度上报器按任务序号守卫：被接管的旧线程不得污染新任务的进度条。"""
        with server._config_lock:
            server._config_task.update({'status': 'loading', 'seq': 7,
                                        'progress': {'stage': 'fetching', 'current': 0, 'total': 0}})
        reporter = server._config_progress_reporter(7)
        reporter('build', 3, 64)
        with server._config_lock:
            self.assertEqual(server._config_task['progress']['current'], 3)
            self.assertEqual(server._config_task['progress']['total'], 64)
            self.assertEqual(server._config_task['progress']['stage'], 'build')
        stale = server._config_progress_reporter(6)  # 旧任务的序号
        stale('build', 99, 64)
        with server._config_lock:
            self.assertEqual(server._config_task['progress']['current'], 3,
                             '旧序号的上报被丢弃')


if __name__ == '__main__':
    unittest.main()
