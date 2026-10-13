# -*- coding: utf-8 -*-
"""Bangumi 收藏同步「最新修改时间优先」冲突裁决单元测试（T46 增强）。

覆盖：优先级白名单与旧值（'0'/'1'）迁移、时间基准归一（本地 ms ts / Bangumi
updated_at ISO-8601 带时区，含 7 位小数秒与缺时区）、缺时间/相等时间回落既有规则、
非法时间容错、lastSyncAt 缺失与既有增量规则、以及同步链路出口 URL 的安全验收
（scheme + 环回/私有/保留地址拒绝，且拒绝发生在发请求之前）。

全部离线：远端收藏用 mock 注入，不触网。
运行：python-backend\\.venv\\Scripts\\python.exe python-backend\\tests\\test_kazumi_sync_priority.py
"""
import json
import os
import sys
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(HERE)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

TEST_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BACKEND_DIR, '.test-runtime')
os.makedirs(TEST_ROOT, exist_ok=True)
os.environ['YUKI_DATA_DIR'] = os.path.join(TEST_ROOT, 'kazumi-data')
os.makedirs(os.environ['YUKI_DATA_DIR'], exist_ok=True)

import hoststate  # noqa: E402
hoststate.configure(data_dir=os.environ['YUKI_DATA_DIR'])

from unittest import mock  # noqa: E402
from kazumi.plugin_manager import PluginManager, BANGUMI_MIRROR_ROOT  # noqa: E402


def epoch_ms(dt):
    """aware datetime → 毫秒时间戳（对齐 records.js 的 favorites.ts = Date.now()）。"""
    return int(dt.timestamp() * 1000)


class TestBangumiSyncPriority(unittest.TestCase):
    """同步优先级/时间基准纯函数 + 三方合并裁决（mock 远端，不触网）。"""

    def setUp(self):
        self.mgr = PluginManager()
        self.mgr._plugins = []
        # 归位镜像状态（mirror.json 跨用例共享，set_mirror 会落盘）
        self.mgr.enable_bangumi_proxy = False
        self.mgr.enable_git_proxy = False
        self.mgr.mirror_root = BANGUMI_MIRROR_ROOT

    def _plan(self, local, remote, priority='newest', last_sync_at=0):
        with mock.patch.object(self.mgr, '_bangumi_all_collections', return_value=remote):
            return self.mgr.bangumi_sync_collections('tok', local, priority=priority,
                                                    last_sync_at=last_sync_at)

    # ------------------------------------------------------------ 优先级取值

    def test_priority_whitelist_and_legacy_migration(self):
        # 新值原样通过，旧下拉值 '0'/'1' 按语义迁移（'1' 绝不能回落成 local：语义相反）
        m = self.mgr
        self.assertEqual(m.normalize_sync_priority('local'), 'local')
        self.assertEqual(m.normalize_sync_priority('remote'), 'remote')
        self.assertEqual(m.normalize_sync_priority('newest'), 'newest')
        self.assertEqual(m.normalize_sync_priority('0'), 'local')
        self.assertEqual(m.normalize_sync_priority('1'), 'remote')
        self.assertEqual(m.normalize_sync_priority('  NEWEST '), 'newest')
        self.assertEqual(m.normalize_sync_priority('1'), 'remote')
        # 非法/缺失回落默认 local
        self.assertEqual(m.normalize_sync_priority('bogus'), 'local')
        self.assertEqual(m.normalize_sync_priority(''), 'local')
        self.assertEqual(m.normalize_sync_priority(None), 'local')
        self.assertEqual(m.normalize_sync_priority(object()), 'local')
        # known 判定与白名单一致（server.py 据此记录「非法值已回落」）
        self.assertTrue(m.sync_priority_is_known('newest'))
        self.assertTrue(m.sync_priority_is_known('0'))
        self.assertFalse(m.sync_priority_is_known('bogus'))
        self.assertFalse(m.sync_priority_is_known(''))

    def test_invalid_priority_behaves_like_local(self):
        # 合并入口收到非法 value：按 local 裁决，行为与不传 priority 一致
        remote = [{'subject_id': 20, 'type': 2, 'updated_at': '2026-10-12T13:20:11+08:00'}]
        local = [{'subjectId': '20', 'type': 3, 'ts': epoch_ms(datetime(2026, 1, 1, tzinfo=timezone.utc)), 'name': 'x'}]
        plan = self._plan(local, remote, priority='bogus')
        self.assertEqual(plan['priority'], 'local')
        self.assertEqual(plan['conflict'][0]['resolved'], 'local')
        self.assertEqual(plan['conflict'][0]['resolvedBy'], 'local')
        self.assertEqual([u['subjectId'] for u in plan['upload']], ['20'])

    # ------------------------------------------------------------ 时间基准归一

    def test_parse_sync_time_units_and_timezone(self):
        m = self.mgr
        # 毫秒 / 秒 / 纯数字串统一到同一基准
        dt = datetime(2026, 10, 12, 5, 20, 11, tzinfo=timezone.utc)
        ms = epoch_ms(dt)
        self.assertEqual(m.parse_sync_time(ms), dt)
        self.assertEqual(m.parse_sync_time(ms / 1000.0), dt)
        self.assertEqual(m.parse_sync_time(str(ms)), dt)
        self.assertEqual(m.parse_sync_time(str(int(ms / 1000))), dt)
        # 带时区 ISO：+08:00 表示的是 05:20:11Z（按字符串直接比较会得出错误的大小关系）
        self.assertEqual(m.parse_sync_time('2026-10-12T13:20:11+08:00'), dt)
        # 'Z' 后缀与 7 位小数秒（Bangumi 官方 OpenAPI 示例形态）
        self.assertEqual(m.parse_sync_time('2022-06-19T18:44:13.6140127+08:00'),
                         datetime(2022, 6, 19, 10, 44, 13, 614012, tzinfo=timezone.utc))
        self.assertEqual(m.parse_sync_time('2026-10-12T05:20:11Z'), dt)
        # 缺时区：按本机时区解释后转 UTC（与 datetime.fromisoformat + astimezone 同口径）
        naive = '2026-10-12T13:20:11'
        expect = datetime.fromisoformat(naive).astimezone(timezone.utc)
        self.assertEqual(m.parse_sync_time(naive), expect)

    def test_parse_sync_time_invalid_tolerated(self):
        m = self.mgr
        for bad in ('garbage', 'not-a-time', '', '   ', None, 0, -1, '0', False, True, [], {}):
            self.assertIsNone(m.parse_sync_time(bad), repr(bad))
        # 超出合理区间（<2000 / >2100）视为脏数据：宁可回落规则，也不让脏时间永远获胜
        self.assertIsNone(m.parse_sync_time('1999-12-31T23:59:59+00:00'))
        self.assertIsNone(m.parse_sync_time('9999-01-01T00:00:00+00:00'))
        self.assertIsNone(m.parse_sync_time(100))          # 1970 年的秒级时间戳
        self.assertIsNone(m.parse_sync_time('2026-13-45T99:99:99'))

    # ------------------------------------------------------------ 冲突裁决

    def test_newest_remote_newer_wins(self):
        # 远端 updated_at 较新 → 远端胜：不上传、计入 skipped、进 pull（覆盖本地展示/状态）
        remote_dt = datetime(2026, 10, 12, 5, 20, 11, tzinfo=timezone.utc)
        local_dt = datetime(2026, 10, 1, 0, 0, 0, tzinfo=timezone.utc)
        remote = [{'subject_id': 20, 'type': 2, 'updated_at': '2026-10-12T13:20:11+08:00'},
                  {'subject_id': 99, 'type': 1, 'updated_at': '2026-10-12T13:20:11+08:00'}]
        local = [{'subjectId': '20', 'type': 3, 'ts': epoch_ms(local_dt), 'name': '冲突番'}]
        plan = self._plan(local, remote)
        self.assertEqual(plan['upload'], [])
        self.assertEqual(plan['skipped'], 1)
        self.assertEqual(len(plan['conflict']), 1)
        c = plan['conflict'][0]
        self.assertEqual(c['resolved'], 'remote')
        self.assertEqual(c['resolvedBy'], 'newest')
        self.assertEqual(c['localType'], 3)
        self.assertEqual(c['remoteType'], 2)
        self.assertEqual(c['name'], '冲突番')
        self.assertEqual(c['localTsSec'], local_dt.timestamp())
        self.assertEqual(c['remoteTsSec'], remote_dt.timestamp())
        self.assertEqual(c['remoteUpdatedAt'], '2026-10-12T13:20:11+08:00')
        # pull = 远端独有 + 远端胜出的冲突项（各一条，不重复）
        self.assertEqual(sorted(str(it['subject_id']) for it in plan['pull']), ['20', '99'])

    def test_newest_local_newer_wins(self):
        # 本地 ts 较新 → 本地胜：进 upload、不计 skipped、不进 pull
        remote_dt = datetime(2026, 10, 1, 0, 0, 0, tzinfo=timezone.utc)
        local_dt = datetime(2026, 10, 12, 5, 20, 11, tzinfo=timezone.utc)
        remote = [{'subject_id': 20, 'type': 2, 'updated_at': '2026-10-01T08:00:00+08:00'}]
        local = [{'subjectId': '20', 'type': 3, 'ts': epoch_ms(local_dt), 'name': '本地新'}]
        plan = self._plan(local, remote)
        self.assertEqual([u['subjectId'] for u in plan['upload']], ['20'])
        self.assertEqual(plan['skipped'], 0)
        self.assertEqual(plan['pull'], [])
        c = plan['conflict'][0]
        self.assertEqual(c['resolved'], 'local')
        self.assertEqual(c['resolvedBy'], 'newest')
        self.assertEqual(c['localTsSec'], local_dt.timestamp())
        self.assertEqual(c['remoteTsSec'], remote_dt.timestamp())

    def test_newest_timezone_aware_not_string_compare(self):
        # 远端 13:20:11+08:00 = 05:20:11Z。
        # 本地 06:00Z（晚 40 分钟）→ 本地胜；本地 02:00Z（早 3 小时）→ 远端胜。
        remote = [{'subject_id': 20, 'type': 2, 'updated_at': '2026-10-12T13:20:11+08:00'}]
        later = self._plan([{'subjectId': '20', 'type': 3, 'ts': epoch_ms(datetime(2026, 10, 12, 6, 0, tzinfo=timezone.utc)), 'name': 'l'}], remote)
        self.assertEqual(later['conflict'][0]['resolved'], 'local')
        self.assertEqual(later['conflict'][0]['resolvedBy'], 'newest')
        earlier = self._plan([{'subjectId': '20', 'type': 3, 'ts': epoch_ms(datetime(2026, 10, 12, 2, 0, tzinfo=timezone.utc)), 'name': 'e'}], remote)
        self.assertEqual(earlier['conflict'][0]['resolved'], 'remote')
        self.assertEqual(earlier['conflict'][0]['resolvedBy'], 'newest')

    def test_newest_fallback_when_times_missing(self):
        # 任一侧缺时间 → 回落既有规则（默认本地胜），且 resolvedBy='fallback' 让前端能看出回退原因
        remote = [{'subject_id': 20, 'type': 2}]  # 无 updated_at
        local = [{'subjectId': '20', 'type': 3, 'ts': epoch_ms(datetime(2026, 10, 12, tzinfo=timezone.utc)), 'name': 'x'}]
        plan = self._plan(local, remote)
        c = plan['conflict'][0]
        self.assertEqual((c['resolved'], c['resolvedBy']), ('local', 'fallback'))
        self.assertIsNone(c['remoteTsSec'])
        self.assertIsNone(c['remoteUpdatedAt'])
        self.assertEqual([u['subjectId'] for u in plan['upload']], ['20'])

        # 本地 ts 缺失（0/None）
        remote2 = [{'subject_id': 20, 'type': 2, 'updated_at': '2026-10-12T13:20:11+08:00'}]
        for bad_ts in (0, None):
            plan2 = self._plan([{'subjectId': '20', 'type': 3, 'ts': bad_ts, 'name': 'x'}], remote2)
            c2 = plan2['conflict'][0]
            self.assertEqual((c2['resolved'], c2['resolvedBy']), ('local', 'fallback'))
            self.assertIsNone(c2['localTsSec'])

    def test_newest_fallback_when_times_invalid(self):
        # 非法时间同样回落（不抛异常、不猜值）
        remote = [{'subject_id': 20, 'type': 2, 'updated_at': 'not-a-time'}]
        local = [{'subjectId': '20', 'type': 3, 'ts': 'oops', 'name': 'x'}]
        plan = self._plan(local, remote)
        c = plan['conflict'][0]
        self.assertEqual((c['resolved'], c['resolvedBy']), ('local', 'fallback'))
        self.assertIsNone(c['localTsSec'])
        self.assertIsNone(c['remoteTsSec'])

    def test_newest_fallback_when_times_equal(self):
        # 完全相等（同一时刻的不同表示）→ 无法判别 → 回落既有规则
        dt = datetime(2026, 10, 12, 5, 20, 11, tzinfo=timezone.utc)
        remote = [{'subject_id': 20, 'type': 2, 'updated_at': '2026-10-12T13:20:11+08:00'}]
        local = [{'subjectId': '20', 'type': 3, 'ts': epoch_ms(dt), 'name': 'x'}]
        plan = self._plan(local, remote)
        c = plan['conflict'][0]
        self.assertEqual((c['resolved'], c['resolvedBy']), ('local', 'fallback'))
        self.assertEqual(c['localTsSec'], c['remoteTsSec'])

    def test_remote_priority_unchanged(self):
        # 既有 'remote' 语义不变：一律远端胜，不看时间
        remote = [{'subject_id': 20, 'type': 2, 'updated_at': '2020-01-01T00:00:00+08:00'}]
        local = [{'subjectId': '20', 'type': 3, 'ts': epoch_ms(datetime(2026, 10, 12, tzinfo=timezone.utc)), 'name': 'x'}]
        plan = self._plan(local, remote, priority='remote')
        self.assertEqual(plan['upload'], [])
        self.assertEqual(plan['skipped'], 1)
        self.assertEqual((plan['conflict'][0]['resolved'], plan['conflict'][0]['resolvedBy']),
                         ('remote', 'remote'))

    def test_local_priority_and_last_sync_rule_unchanged(self):
        # 既有 'local' 语义：默认本地胜；仅 ts<lastSyncAt（本地自上次同步未改动）时远端胜
        remote = [{'subject_id': 20, 'type': 2, 'updated_at': '2026-10-12T13:20:11+08:00'}]
        fresh = [{'subjectId': '20', 'type': 3, 'ts': 100, 'name': 'x'}]
        p1 = self._plan(fresh, remote, priority='local')
        self.assertEqual((p1['conflict'][0]['resolved'], p1['conflict'][0]['resolvedBy']), ('local', 'local'))
        self.assertEqual([u['subjectId'] for u in p1['upload']], ['20'])
        # lastSyncAt 缺失（0/None）→ 与既有行为一致（本地胜），不受影响
        for missing in (0, None):
            pm = self._plan(fresh, remote, priority='local', last_sync_at=missing)
            self.assertEqual(pm['conflict'][0]['resolved'], 'local')
        # 既有增量规则命中 → 远端胜，resolvedBy 标明是 lastSync 规则（不是 newest）
        p2 = self._plan([{'subjectId': '20', 'type': 3, 'ts': 50, 'name': 'x'}], remote,
                        priority='local', last_sync_at=100)
        self.assertEqual((p2['conflict'][0]['resolved'], p2['conflict'][0]['resolvedBy']), ('remote', 'lastSync'))
        self.assertEqual(p2['upload'], [])
        self.assertEqual(p2['skipped'], 1)

    def test_newest_fallback_can_still_hit_last_sync_rule(self):
        # newest 回落时沿用既有规则：缺时间 + ts<lastSyncAt → 远端胜，但 resolvedBy 仍是 'fallback'
        remote = [{'subject_id': 20, 'type': 2}]
        local = [{'subjectId': '20', 'type': 3, 'ts': 50, 'name': 'x'}]
        plan = self._plan(local, remote, last_sync_at=100)
        self.assertEqual((plan['conflict'][0]['resolved'], plan['conflict'][0]['resolvedBy']),
                         ('remote', 'fallback'))

    def test_plan_shape_backward_compatible(self):
        # 既有键一个不少，新键只在冲突明细里增量出现（前端/旧消费方不会因结构变化而崩）
        remote = [{'subject_id': 10, 'type': 2}, {'subject_id': 99, 'type': 1}]
        local = [{'subjectId': '10', 'type': 2, 'ts': 1, 'name': 'a'},
                 {'subjectId': '30', 'type': 1, 'ts': 1, 'name': 'b'}]
        plan = self._plan(local, remote, priority='local')
        for key in ('upload', 'pull', 'conflict', 'skipped', 'remoteTotal', 'localTotal'):
            self.assertIn(key, plan)
        self.assertEqual(plan['remoteTotal'], 2)
        self.assertEqual(plan['localTotal'], 2)
        self.assertEqual(plan['skipped'], 1)
        self.assertEqual(sorted(u['subjectId'] for u in plan['upload']), ['30'])
        self.assertEqual([str(it['subject_id']) for it in plan['pull']], ['99'])
        self.assertEqual(plan['conflict'], [])  # 无冲突（10 两侧一致）

    def test_unchanged_types_are_not_conflicts(self):
        # 两侧 type 一致时恒为 skipped，不产生 conflict，也不消耗任何时间判定
        remote = [{'subject_id': 20, 'type': 3, 'updated_at': '2026-10-12T13:20:11+08:00'}]
        plan = self._plan([{'subjectId': '20', 'type': 3, 'ts': 1, 'name': 'x'}], remote)
        self.assertEqual(plan['conflict'], [])
        self.assertEqual(plan['skipped'], 1)
        self.assertEqual(plan['upload'], [])

    # ------------------------------------------------------------ 出口 URL 安全验收

    def test_check_bangumi_url_matrix(self):
        m = self.mgr
        # 允许：官方、官方镜像、普通自建域名（含 http，scheme 校验只挡非 http(s)）
        for ok in ('https://api.bgm.tv/v0/me', 'https://api.bangumi.vip/v0/me',
                   'http://api.bgm.tv/v0/me', 'https://api.my-mirror.example.com',
                   'https://api.1.2.3.4'):  # 公网 IP 字面量不属于私网/保留段
            self.assertIsNone(m.check_bangumi_url(ok), ok)
        # 拒绝：非 http(s)
        for bad in ('ftp://api.bgm.tv', 'file:///etc/passwd', 'ws://api.bgm.tv', '', None):
            self.assertIsNotNone(m.check_bangumi_url(bad), repr(bad))
        # 拒绝：环回/私网/保留地址与保留名字（含 IPv4-mapped IPv6）
        for blocked in ('https://localhost/x', 'https://api.localhost/x', 'https://127.0.0.1',
                        'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://10.0.0.5',
                        'https://192.168.1.5', 'https://172.16.0.9', 'https://169.254.169.254',
                        'https://0.0.0.0', 'https://[fe80::1]/x', 'https://bgm.internal',
                        'https://api.local', 'https://mirror.home.arpa',
                        # 镜像根域名被写成裸 IP 时真实 host 带 api./next. 前缀，也要拦住
                        'https://api.127.0.0.1', 'https://api.192.168.1.5', 'https://next.10.0.0.5'):
            self.assertIsNotNone(m.check_bangumi_url(blocked), blocked)

    def test_sync_blocked_url_rejected_before_network(self):
        # 自建镜像指向内网/保留名：发请求前就拒绝，error 可诊断，绝不静默放行
        self.mgr.set_mirror(bangumi=True, root='mirror.internal')
        with mock.patch.object(self.mgr, '_bangumi_all_collections',
                               side_effect=AssertionError('不应发起网络请求')) as net:
            plan = self.mgr.bangumi_sync_collections(
                'tok', [{'subjectId': '20', 'type': 3, 'ts': 1, 'name': 'x'}], priority='newest')
        net.assert_not_called()
        self.assertIn('已拒绝请求', plan['error'])
        self.assertIn('api.mirror.internal', plan['error'])
        self.assertEqual(plan['upload'], [])
        self.assertEqual(plan['conflict'], [])

        # 裸 IP 根域名（api.{root} 形态）同样拦住
        self.mgr.set_mirror(bangumi=True, root='192.168.1.5')
        with mock.patch.object(self.mgr, '_bangumi_all_collections',
                               side_effect=AssertionError('不应发起网络请求')) as net2:
            plan2 = self.mgr.bangumi_sync_collections('tok', [], priority='newest')
        net2.assert_not_called()
        self.assertIn('已拒绝请求', plan2['error'])

    def test_apply_plan_skips_blocked_base_keeps_official_fallback(self):
        # 双基址兜底：镜像被拒但官方仍可用 → 照常上传；请求 URL 必须是官方（被拒地址不发请求）
        self.mgr.set_mirror(bangumi=True, root='mirror.internal')

        class FakeRsp:
            status_code = 200

        with mock.patch.object(self.mgr, '_bangumi_username', return_value='alice'), \
                mock.patch('time.sleep'), \
                mock.patch('requests.request', return_value=FakeRsp()) as req:
            result = self.mgr.bangumi_apply_sync_plan('tok', [{'subjectId': '20', 'type': 3}], op_delay=0)
        self.assertEqual(result['uploaded'], 1)
        self.assertEqual(result['failed'], 0)
        self.assertTrue(req.call_args_list)
        for call in req.call_args_list:
            self.assertIn('api.bgm.tv', call[0][1])
        self.assertNotIn('mirror.internal', str(req.call_args_list))

    def test_apply_plan_all_bases_blocked_returns_error(self):
        # 两个候选基址都被拒（无镜像也被替换成私网名）时整体失败，且不发任何请求，
        # 错误信息保留可诊断原因（而非「未知错误」）
        self.mgr.set_mirror(bangumi=True, root='127.0.0.1')
        with mock.patch.object(self.mgr, '_bangumi_username', return_value='alice') as uname, \
                mock.patch.object(self.mgr, 'check_bangumi_url', return_value='测试用拒绝原因'), \
                mock.patch('requests.request', side_effect=AssertionError('不应发起网络请求')):
            result = self.mgr.bangumi_apply_sync_plan('tok', [{'subjectId': '20', 'type': 3}], op_delay=0)
        self.assertEqual(result['uploaded'], 0)
        self.assertEqual(result['failed'], 1)
        self.assertEqual(result['error'], '测试用拒绝原因')
        # 校验先于用户名解析：被拒地址连一次 /v0/me 都不会发
        uname.assert_not_called()


class TestBangumiSyncDispatch(unittest.TestCase):
    """server.dispatch_kazumi_action('kazumiBangumiSync')：priority 白名单回落 + lastSyncAt 校验。

    只测端点胶水（参数校验/归一/透传），合并逻辑用假的 bangumi_sync_collections 顶替。
    """

    def setUp(self):
        import server as server_mod
        self.server = server_mod
        self.mgr = PluginManager()
        self.mgr._plugins = []
        self.mgr.enable_bangumi_proxy = False
        self.mgr.mirror_root = BANGUMI_MIRROR_ROOT
        self._patch = mock.patch.object(server_mod, 'kazumi_mgr', self.mgr)
        self._patch.start()
        self.addCleanup(self._patch.stop)
        self.captured = {}

        def fake_sync(token, favorites, priority='local', last_sync_at=0):
            self.captured.update({'token': token, 'favorites': favorites,
                                  'priority': priority, 'last_sync_at': last_sync_at})
            return {'upload': [], 'pull': [], 'conflict': [], 'skipped': 0,
                    'remoteTotal': 0, 'localTotal': len(favorites or []), 'priority': priority}

        self._sync_patch = mock.patch.object(self.mgr, 'bangumi_sync_collections', side_effect=fake_sync)
        self._sync_patch.start()
        self.addCleanup(self._sync_patch.stop)

    def _dispatch(self, **form):
        form.setdefault('do', 'kazumiBangumiSync')
        form.setdefault('token', 'tok')
        status, body = self.server.dispatch_kazumi_action(form)
        return status, json.loads(body)

    def test_priority_whitelist_and_fallback(self):
        # 非法值回落 local；旧值 '0'/'1' 按语义迁移；新值透传；缺失回落 local
        for raw, expect in (('bogus', 'local'), ('', 'local'), ('1', 'remote'), ('0', 'local'),
                            ('remote', 'remote'), ('newest', 'newest'), ('LOCAL', 'local')):
            _status, body = self._dispatch(priority=raw)
            self.assertEqual(self.captured['priority'], expect, repr(raw))
            self.assertEqual(body['plan']['priority'], expect)
        _status, _body = self._dispatch()  # 缺失 priority
        self.assertEqual(self.captured['priority'], 'local')

    def test_last_sync_at_validation(self):
        # 缺失 / 空串 / "null" / "undefined" → 0（按未提供处理）
        for raw in (None, '', 'null', 'undefined', 'None'):
            form = {} if raw is None else {'lastSyncAt': raw}
            self._dispatch(**form)
            self.assertEqual(self.captured['last_sync_at'], 0, repr(raw))
        # 毫秒/秒时间戳 → epoch 秒（统一基准后再交给合并逻辑）
        self._dispatch(lastSyncAt='1750000000000')
        self.assertAlmostEqual(self.captured['last_sync_at'], 1750000000.0, places=3)
        self._dispatch(lastSyncAt='1750000000')
        self.assertAlmostEqual(self.captured['last_sync_at'], 1750000000.0, places=3)
        # ISO-8601 带时区 → epoch 秒
        self._dispatch(lastSyncAt='2026-10-12T13:20:11+08:00')
        self.assertAlmostEqual(self.captured['last_sync_at'],
                               datetime(2026, 10, 12, 5, 20, 11, tzinfo=timezone.utc).timestamp(), places=3)
        # 非法值 → 0（不猜值）
        for bad in ('garbage', '2026-13-45T99:99:99', '[]'):
            self._dispatch(lastSyncAt=bad)
            self.assertEqual(self.captured['last_sync_at'], 0, repr(bad))

    def test_favorites_payload_passthrough_and_bad_json(self):
        # favorites 非法 JSON / 非数组 → 空表（不 500）；正常数组透传
        _s, body = self._dispatch(favorites='[]')
        self.assertEqual(self.captured['favorites'], [])
        self.assertEqual(body['code'], 200)
        for bad in ('not-json', '{"a":1}'):
            self._dispatch(favorites=bad)
            self.assertEqual(self.captured['favorites'], [])
        _s, _b = self._dispatch(favorites=json.dumps([{'subjectId': '20', 'type': 3}]))
        self.assertEqual(self.captured['favorites'], [{'subjectId': '20', 'type': 3}])


if __name__ == '__main__':
    unittest.main()
