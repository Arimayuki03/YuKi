# -*- coding: utf-8 -*-
"""封面话数徽章批量详情链路测试。

kazumiBangumiInfoBatch（封面徽章整页一次往返）三层：
1. PluginManager.bangumi_info_batch —— 逐 id 并发复用 bangumi_info（mock
   http_client.get，不触网），失败条目置 None 不拖垮整批，>60 截断。
2. server.dispatch_kazumi_action('kazumiBangumiInfoBatch') —— 逐 id 先查单条
   磁盘缓存（与 kazumiBangumiInfo 同键同 TTL），缺失的才回源；回源成功回写
   单条缓存（下次批量/单条双路径都零网络）。cache_store 用真实 CacheStore
   指向临时目录（对齐 test_cache_store.py 隔离写法）。
3. 批量整包 _cached_bangumi 包装（_bangumi_body_ok 判定 infos 全部非 None：
   部分失败不缓存整包，失败 id 下次重发回源自愈）。

渲染端（kazumi.js bangumiInfoBatch / timeline.js _attachEpBadges）见
tests/js/timeline.test.js 与 bgm-info-batch.test.js。
"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 测试隔离：单独运行本文件（pytest / 直接执行）时也必须脱离真实 ~/.yuki
# profile。import server 与 PluginManager() 构造会经由 hoststate 读写
# data_dir/cache_dir，故 configure 必须先于一切被测模块 import（对齐
# test_kazumi.py / test_cache_internals.py 的既有写法）。
_TMP_ROOT = tempfile.mkdtemp(prefix='yuki-test-bgminfo-batch-')
_ORIG_ENV = {
    'YUKI_DATA_DIR': os.environ.get('YUKI_DATA_DIR'),
    'YUKI_CACHE_DIR': os.environ.get('YUKI_CACHE_DIR'),
}
os.environ.setdefault('YUKI_DATA_DIR', os.path.join(_TMP_ROOT, 'data'))
os.environ.setdefault('YUKI_CACHE_DIR', os.path.join(_TMP_ROOT, 'cache'))

import hoststate  # noqa: E402
hoststate.configure(data_dir=os.path.join(_TMP_ROOT, 'data'),
                    cache_dir=os.path.join(_TMP_ROOT, 'cache'))


def _restore_env_and_dirs():
    """atexit：恢复 env 与 hoststate 并清理临时根。快照在 setdefault 之前
    记录，保证恢复写回的是真正的宿主原值（目录推导口径同 hoststate 导入期
    `_ENV_DATA_DIR or ~/.yuki`）。"""
    for key, val in _ORIG_ENV.items():
        if val is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = val
    try:
        env_data = (os.environ.get('YUKI_DATA_DIR') or '').strip()
        env_cache = (os.environ.get('YUKI_CACHE_DIR') or '').strip()
        data_dir = env_data or os.path.join(os.path.expanduser('~'), '.yuki')
        cache_dir = env_cache or os.path.join(data_dir, 'cache')
        hoststate.configure(data_dir=data_dir, cache_dir=cache_dir)
    except Exception:
        pass
    shutil.rmtree(_TMP_ROOT, ignore_errors=True)


import atexit  # noqa: E402
import shutil  # noqa: E402
atexit.register(_restore_env_and_dirs)

from kazumi.plugin_manager import PluginManager  # noqa: E402


def _fake_rsp(payload):
    class FakeRsp:
        def raise_for_status(self):
            pass

        def json(self):
            return payload
    return FakeRsp()


class TestBangumiInfoBatch(unittest.TestCase):
    """PluginManager.bangumi_info_batch：并发逐 id 拉取。"""

    def setUp(self):
        self.mgr = PluginManager()
        self.mgr._plugins = []
        from kazumi.plugin_manager import BANGUMI_MIRROR_ROOT
        self.mgr.enable_bangumi_proxy = False
        self.mgr.enable_git_proxy = False
        self.mgr.mirror_root = BANGUMI_MIRROR_ROOT

    def test_batch_returns_all_ids(self):
        """全部成功：每个 id 返回详情，URL 指向 /v0/subjects/{id}。"""
        urls = []

        def fake_get(url, **kw):
            urls.append(url)
            sid = url.rsplit('/', 1)[-1]
            return _fake_rsp({'id': int(sid), 'name': f'subject-{sid}', 'eps': 12})

        with mock.patch('http_client.get', side_effect=fake_get):
            result = self.mgr.bangumi_info_batch(['100', '200', '300'])
        self.assertEqual(set(result.keys()), {'100', '200', '300'})
        for sid in ('100', '200', '300'):
            self.assertEqual(result[sid]['eps'], 12)
        self.assertEqual(len(urls), 3)

    def test_batch_single_failure_isolated(self):
        """单条失败（HTTP 异常）不拖垮整批：失败 id 为 None，其余正常。"""

        def fake_get(url, **kw):
            sid = url.rsplit('/', 1)[-1]
            if sid == '200':
                raise RuntimeError('network down')
            return _fake_rsp({'id': int(sid), 'eps': 12})

        with mock.patch('http_client.get', side_effect=fake_get):
            result = self.mgr.bangumi_info_batch(['100', '200', '300'])
        self.assertIsNone(result['200'])
        self.assertEqual(result['100']['eps'], 12)
        self.assertEqual(result['300']['eps'], 12)

    def test_batch_empty_and_truncation(self):
        """空入参零请求；超过 60 条上限截断（防滥用）。"""

        def fake_get(url, **kw):
            return _fake_rsp({'id': 1, 'eps': 1})

        with mock.patch('http_client.get', side_effect=fake_get) as m:
            self.assertEqual(self.mgr.bangumi_info_batch([]), {})
            self.assertEqual(self.mgr.bangumi_info_batch(None), {})
            m.assert_not_called()
        with mock.patch('http_client.get', side_effect=fake_get):
            result = self.mgr.bangumi_info_batch([str(i) for i in range(1, 71)])
        self.assertEqual(len(result), 60, '超限截断到 60')


class TestBangumiInfoBatchDispatch(unittest.TestCase):
    """dispatch_kazumi_action('kazumiBangumiInfoBatch')：逐 id 缓存复用 + 回写。"""

    def setUp(self):
        import cache_store as cache_store_mod
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = cache_store_mod.CacheStore(os.path.join(self._tmp.name, 'kv'))
        self.mgr = PluginManager()
        self.mgr._plugins = []
        import server as server_mod
        self.server = server_mod
        # 隔离真实缓存目录 + 管理器单例
        self._patches = [
            mock.patch.object(server_mod, 'cache_store', self.store),
            mock.patch.object(server_mod, 'kazumi_mgr', self.mgr),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

    def _dispatch(self, ids, refresh=''):
        form = {'do': 'kazumiBangumiInfoBatch', 'ids': ids}
        if refresh:
            form['refresh'] = refresh
        return self.server.dispatch_kazumi_action(form)

    def test_fetch_miss_write_and_reuse(self):
        """首趟回源并回写单条缓存；第二趟（refresh 跳过整包缓存）逐 id 命中零网络。"""
        calls = []

        def fake_get(url, **kw):
            calls.append(url)
            sid = url.rsplit('/', 1)[-1]
            return _fake_rsp({'id': int(sid), 'name': f's{sid}', 'eps': 12})

        with mock.patch('http_client.get', side_effect=fake_get):
            status, body = self._dispatch('100,200')
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data['infos']['100']['eps'], 12)
        self.assertEqual(data['infos']['200']['eps'], 12)
        self.assertEqual(len(calls), 2, '两条 id 各回源一次')
        # 回写校验：单条键（kazumiBangumiInfo 同键）可读
        cached = self.store.get(self.server._bangumi_cache_key('kazumiBangumiInfo', {'id': '100'}))
        self.assertTrue(cached)
        self.assertEqual(json.loads(cached)['info']['eps'], 12)

        # 第二趟：整包缓存命中直接返回（零网络）；refresh=1 跳过整包但仍逐 id
        # 命中单条缓存——两次都不应再触网
        with mock.patch('http_client.get', side_effect=fake_get):
            status2, body2 = self._dispatch('100,200')
        self.assertEqual(json.loads(body2)['infos']['100']['eps'], 12)
        with mock.patch('http_client.get', side_effect=fake_get) as m2:
            status3, body3 = self._dispatch('100,200', refresh='1')
        m2.assert_not_called()
        self.assertEqual(json.loads(body3)['infos']['200']['eps'], 12)
        self.assertEqual(len(calls), 2, '后续路径全部零回源')

    def test_partial_cache_hit_only_fetches_missing(self):
        """一半 id 有缓存、一半缺失：只对缺失条目回源。"""

        def fake_get(url, **kw):
            sid = url.rsplit('/', 1)[-1]
            return _fake_rsp({'id': int(sid), 'eps': 7})

        # 预置 100 的单条缓存
        self.store.set(
            self.server._bangumi_cache_key('kazumiBangumiInfo', {'id': '100'}),
            json.dumps({'code': 200, 'info': {'id': 100, 'eps': 7}}),
            self.server._BANGUMI_CACHE_TTL['kazumiBangumiInfo'],
        )
        with mock.patch('http_client.get', side_effect=fake_get) as m:
            status, body = self._dispatch('100,200')
        self.assertEqual(status, 200)
        infos = json.loads(body)['infos']
        self.assertEqual(infos['100']['eps'], 7, '缓存命中直出')
        self.assertEqual(infos['200']['eps'], 7, '缺失条目回源')
        self.assertEqual(m.call_count, 1, '只对缺失的 200 回源')

    def test_different_id_sets_use_distinct_batch_keys(self):
        """回归锁（徽章不拉取 bug）：不同 id 集的整包缓存必须各自成键。

        旧 _bangumi_cache_key 参数表不含 ids——所有批次共用同一个整包键，
        首个批次（如时间表周一的 3 个 id）写入后，30 分钟内其他页面/星期的
        批量请求全部命中旧批次，前端按当前页 id 查不到值 → 徽章静默不拉取。"""

        def fake_get(url, **kw):
            sid = url.rsplit('/', 1)[-1]
            return _fake_rsp({'id': int(sid), 'eps': 12})

        with mock.patch('http_client.get', side_effect=fake_get):
            _, body_a = self._dispatch('100,200')  # 首个批次写整包缓存
        # 换一批完全不同的 id：不得命中上一批的整包缓存（旧行为会零网络返回 100/200）
        with mock.patch('http_client.get', side_effect=fake_get) as m:
            _, body_b = self._dispatch('300,400')
        self.assertEqual(m.call_count, 2, '新 id 集必须真实回源（不顶用旧批次缓存）')
        infos_b = json.loads(body_b)['infos']
        self.assertEqual(set(infos_b.keys()), {'300', '400'})
        self.assertIsNotNone(infos_b['300'], '新批次 id 不得返回 None')
        self.assertIsNotNone(infos_b['400'])
        # 首个批次照常命中自己的整包缓存（零网络）
        with mock.patch('http_client.get', side_effect=fake_get) as m2:
            _, body_a2 = self._dispatch('100,200')
        m2.assert_not_called()
        self.assertEqual(set(json.loads(body_a2)['infos'].keys()), {'100', '200'})
        # 键隔离语义单测：同 do 不同 ids → 不同键；同 ids → 同键
        k1 = self.server._bangumi_cache_key('kazumiBangumiInfoBatch', {'ids': '100,200'})
        k2 = self.server._bangumi_cache_key('kazumiBangumiInfoBatch', {'ids': '300,400'})
        k3 = self.server._bangumi_cache_key('kazumiBangumiInfoBatch', {'ids': '100,200'})
        self.assertNotEqual(k1, k2)
        self.assertEqual(k1, k3)

    def test_all_failed_not_persisted_as_batch(self):
        """整批全失败：infos 全 None，_bangumi_body_ok 判 False 不写整包缓存。"""
        with mock.patch('http_client.get', side_effect=RuntimeError('down')):
            status, body = self._dispatch('100')
        self.assertEqual(status, 200)
        self.assertIsNone(json.loads(body)['infos']['100'])
        self.assertFalse(self.server._bangumi_body_ok(
            'kazumiBangumiInfoBatch', body), '全空 infos 不值得缓存')
        ok_body = json.dumps({'code': 200, 'infos': {'100': {'id': 100, 'eps': 1}}})
        self.assertTrue(self.server._bangumi_body_ok('kazumiBangumiInfoBatch', ok_body))

    def test_partial_failure_not_persisted_as_batch(self):
        """回归锁（59/60 失败整包被缓存 bug）：任一 id 失败得 None 就不缓存整包。

        旧 _bangumi_body_ok 用 any(infos.values())——只要有一个 id 成功就把
        整包缓存 30min；瞬时网络抖动得 None 的 id 前端不写 localStorage，
        翻页重发永远命中陈旧 None 包 → 徽章静默缺失且无自愈。新语义要求
        全部 id 取到才缓存；per-id 磁盘缓存已聚合成功条目，下次重发仅对
        失败 id 回源自愈。"""
        with mock.patch('http_client.get', side_effect=RuntimeError('down')):
            status, body = self._dispatch('100,200,300')
        infos = json.loads(body)['infos']
        self.assertIsNone(infos['100'])
        self.assertIsNone(infos['200'])
        self.assertIsNone(infos['300'])
        self.assertFalse(self.server._bangumi_body_ok(
            'kazumiBangumiInfoBatch', body), '部分成功（含 None）不得缓存整包')

        # 行为锁：第二趟（refresh=1 跳过读缓存仍走回写路径）重发同批 id，
        # 回源成功后 infos 全非 None，才写入整包缓存；第三趟零网络命中。
        def fake_get(url, **kw):
            sid = url.rsplit('/', 1)[-1]
            return _fake_rsp({'id': int(sid), 'eps': 12})

        with mock.patch('http_client.get', side_effect=fake_get):
            _, body2 = self._dispatch('100,200,300', refresh='1')
        self.assertTrue(self.server._bangumi_body_ok('kazumiBangumiInfoBatch', body2))
        with mock.patch('http_client.get', side_effect=fake_get) as m:
            _, body3 = self._dispatch('100,200,300')
        m.assert_not_called()
        self.assertEqual(json.loads(body3)['infos']['200']['eps'], 12)

        # 判定语义单测边界：空 infos dict 也判 False（防 any 时代的 falsy 回归）
        self.assertFalse(self.server._bangumi_body_ok(
            'kazumiBangumiInfoBatch', json.dumps({'code': 200, 'infos': {}})))


if __name__ == '__main__':
    unittest.main()
