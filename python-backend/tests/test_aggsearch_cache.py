# -*- coding: utf-8 -*-
"""聚合搜索 SSE 流（/search/stream）整词缓存（B-01）单测。

覆盖（仿 test_kazumi_cache.py / test_spider_content_cache.py 风格，自写断言
+ __main__ 循环，不用 pytest）：
- _aggsearch_cache_put_source / _aggsearch_cached_payloads：miss→落缓存→
  按登记顺序重放、error/空 list 源不落缓存、全部失败整词不落缓存；
- 键编码：timeout 并入键，不同预算互不串台；
- _aggsearch_missing_keys：重放对未缓存源补齐判定；
- search_stream 端点级：首次走源并落缓存、二次命中不调源完整重放、
  refresh=1 旁路（跳过重放仍回写）、TTL 过期后重新走源；
- 流中断整词失效。

端点驱动方式：从 create_app() 路由表取 /search/stream 的 endpoint，
直接迭代其返回的 StreamingResponse.body_iterator（同步生成器，无需起服务）；
spider_app.searchContent 打桩，sites.sites 打桩为最小 Site 桩。
"""
import asyncio
import json
import os
import sys
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
for _path in (BASE, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)
# import server 会构造 SiteManager/ConfigManager，但不触网不建目录（惰性）；
# 仍按既有测试惯例把目录指到测试根，保证环境变量先于 hoststate 初始化就绪。
TEST_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-runtime')
os.makedirs(TEST_ROOT, exist_ok=True)
os.environ.setdefault('YUKI_DATA_DIR', os.path.join(TEST_ROOT, 'data'))
os.environ.setdefault('YUKI_CACHE_DIR', os.path.join(TEST_ROOT, 'cache'))

import mem_cache  # noqa: E402
import server  # noqa: E402

NS = server._AGGSEARCH_NS


def _payload(site_key, name, items):
    return json.dumps({'source': site_key, 'name': name, 'list': items,
                       'status': 'success' if items else 'noresult'},
                      ensure_ascii=False)


# ---------------------------------------------------------------------------
# 纯辅助函数层
# ---------------------------------------------------------------------------

def test_put_and_replay_roundtrip():
    mem_cache.clear_all()
    # 索引不存在 → 返回 None（走正常并发搜索）
    assert server._aggsearch_cached_payloads('海贼王', 20) is None
    p1 = _payload('siteA', '源A', [{'v': 1}])
    p2 = _payload('siteB', '源B', [{'v': 2}])
    server._aggsearch_cache_put_source('海贼王', 20, 'siteA', p1)
    server._aggsearch_cache_put_source('海贼王', 20, 'siteB', p2)
    # 按登记顺序重放
    assert server._aggsearch_cached_payloads('海贼王', 20) == [p1, p2]
    # 重复写同一源不产生重复索引条目
    server._aggsearch_cache_put_source('海贼王', 20, 'siteA', p1)
    assert server._aggsearch_cached_payloads('海贼王', 20) == [p1, p2]
    # 换一个 word 互不影响
    assert server._aggsearch_cached_payloads('火影', 20) is None


def test_timeout_is_part_of_key():
    """timeout 并入缓存键：不同预算下结果集大小不同（短预算掐掉部分源），
    绝不能互相重放。"""
    mem_cache.clear_all()
    p20 = _payload('siteA', '源A', [{'v': 'full'}])
    p5 = _payload('siteA', '源A', [{'v': 'partial'}])
    server._aggsearch_cache_put_source('海贼王', 20, 'siteA', p20)
    server._aggsearch_cache_put_source('海贼王', 5, 'siteA', p5)
    assert server._aggsearch_cached_payloads('海贼王', 20) == [p20]
    assert server._aggsearch_cached_payloads('海贼王', 5) == [p5]
    assert server._aggsearch_cached_payloads('海贼王', 10) is None
    # 键格式：word\x1ftimeout=N（\x1f 定界防 word 含 '|' 的碰撞，审查3.5/L9）
    assert server._aggsearch_cache_key('海贼王', 20) == '海贼王\x1ftimeout=20'


def test_word_with_pipe_does_not_collide():
    """word 含 '|' 时不得与其他 word/源构造出同一键（review01 L11 碰撞串）。

    键以 \x1f 定界：\x1f 控制字符不会出现在正常 word/站点 key 中，原 '|' 系
    碰撞串——word='x' + site='a|timeout=20|b' 与 word='x|timeout=20|a' +
    site='b' 同键——失效。"""
    mem_cache.clear_all()
    pa = _payload('a|timeout=20|b', 'A', [{'v': 1}])
    pb = _payload('b', 'B', [{'v': 2}])
    server._aggsearch_cache_put_source('x', 20, 'a|timeout=20|b', pa)
    server._aggsearch_cache_put_source('x|timeout=20|a', 20, 'b', pb)
    assert server._aggsearch_cached_payloads('x', 20) == [pa]
    assert server._aggsearch_cached_payloads('x|timeout=20|a', 20) == [pb]
    # 前缀失效不误伤：清 word='x' 不影响 word='x|timeout=20|a' 的缓存
    server._aggsearch_cache_invalidate_word('x', 20)
    assert server._aggsearch_cached_payloads('x|timeout=20|a', 20) == [pb]


def test_error_and_empty_source_not_cached():
    """error 单源不落缓存（调用方过滤）——瞬时故障不该被冻结进重放。
    空 list（noresult）自审查3.5/L9 修复后照常落缓存（见
    test_noresult_is_cached_and_replayed）。"""
    mem_cache.clear_all()
    err = json.dumps({'source': 'siteA', 'name': '源A', 'list': [],
                      'status': 'error', 'msg': 'boom'}, ensure_ascii=False)
    server._aggsearch_cache_put_source('海贼王', 20, 'siteA', err)
    assert server._aggsearch_cached_payloads('海贼王', 20) is None  # 索引未登记
    # 非 JSON 的坏 payload 同样不收
    server._aggsearch_cache_put_source('海贼王', 20, 'siteC', 'not-json')
    assert server._aggsearch_cached_payloads('海贼王', 20) is None
    # error payload 混入仍被 put 内护栏拦截（双重保险）
    ok = _payload('siteD', '源D', [{'v': 1}])
    server._aggsearch_cache_put_source('海贼王', 20, 'siteD', ok)
    assert server._aggsearch_cached_payloads('海贼王', 20) == [ok]


def test_noresult_is_cached_and_replayed():
    """审查3.5/L9：noresult（空 list）payload 照常落缓存按原状态重放——
    对齐 kazumi 流先例。空结果是该源的真实答案，若不落缓存，重放只能进
    misses 被误补发成 error（「无结果」变「查询失败」）且 TTL 内拿不到缓存。"""
    mem_cache.clear_all()
    empty = _payload('siteB', '源B', [])
    server._aggsearch_cache_put_source('海贼王', 20, 'siteB', empty)
    assert server._aggsearch_cached_payloads('海贼王', 20) == [empty]
    # 重放集合含 noresult 源 → 它不算 miss
    class _S:
        def __init__(self, key, name):
            self.key = key
            self.name = name
    assert server._aggsearch_missing_keys([empty], [_S('siteB', '源B')]) == []


def test_all_sources_failed_word_not_cached():
    """全部源失败（error）→ 索引与 payload 均不存在，整词下次仍走真实检索。"""
    mem_cache.clear_all()
    err_a = json.dumps({'source': 'siteA', 'list': [], 'status': 'error'}, ensure_ascii=False)
    server._aggsearch_cache_put_source('海贼王', 20, 'siteA', err_a)
    # 无任何成功源 → 无索引 → miss
    assert server._aggsearch_cached_payloads('海贼王', 20) is None
    # mem_cache 层面无残留条目
    assert not mem_cache._store.get(NS)


def test_missing_keys_replay_fillup():
    mem_cache.clear_all()
    p1 = _payload('siteA', '源A', [{'v': 1}])
    server._aggsearch_cache_put_source('海贼王', 20, 'siteA', p1)
    payloads = server._aggsearch_cached_payloads('海贼王', 20)

    class _S:
        def __init__(self, key, name):
            self.key = key
            self.name = name

    sites = [_S('siteA', '源A'), _S('siteB', '源B'), _S('siteC', '源C')]
    # b/c 上次 error/中断不落缓存 → 必须被列为补齐对象（否则其卡永久 pending）
    missing = server._aggsearch_missing_keys(payloads, sites)
    assert [(m['key'], m['name']) for m in missing] == [('siteB', '源B'), ('siteC', '源C')]
    assert server._aggsearch_missing_keys([p1], sites[:1]) == []
    # 坏 payload 不视为已覆盖
    missing2 = server._aggsearch_missing_keys(['not-json'], sites)
    assert [m['key'] for m in missing2] == ['siteA', 'siteB', 'siteC']


def test_invalidate_word():
    mem_cache.clear_all()
    p1 = _payload('siteA', '源A', [{'v': 1}])
    server._aggsearch_cache_put_source('海贼王', 20, 'siteA', p1)
    server._aggsearch_cache_put_source('火影', 20, 'siteA', p1)
    server._aggsearch_cache_invalidate_word('海贼王', 20)
    assert server._aggsearch_cached_payloads('海贼王', 20) is None
    assert server._aggsearch_cached_payloads('火影', 20) == [p1]


def test_replay_skips_expired_payloads_keeps_others():
    """某条单源 payload 过期/LRU 淘汰后重放跳过缺失项，索引仍在。"""
    mem_cache.clear_all()
    p1 = _payload('siteA', '源A', [{'v': 1}])
    p2 = _payload('siteB', '源B', [{'v': 2}])
    server._aggsearch_cache_put_source('海贼王', 20, 'siteA', p1)
    server._aggsearch_cache_put_source('海贼王', 20, 'siteB', p2)
    mem_cache._store[NS].pop(server._aggsearch_payload_key('海贼王', 20, 'siteB'), None)
    assert server._aggsearch_cached_payloads('海贼王', 20) == [p1]


def test_empty_replay_means_miss():
    """索引在而 payload 全部失效 → 空列表（调用方视作 miss 回退网络）。"""
    mem_cache.clear_all()
    p1 = _payload('siteA', '源A', [{'v': 1}])
    server._aggsearch_cache_put_source('海贼王', 20, 'siteA', p1)
    # 前缀与 _aggsearch_payload_key 的 \x1f 定界格式保持同步（审查3.5/L9 键改造）
    mem_cache.invalidate_prefix(NS, 'aggsearch\x1f海贼王\x1ftimeout=20\x1f')
    payloads = server._aggsearch_cached_payloads('海贼王', 20)
    assert payloads == [] and payloads is not None


# ---------------------------------------------------------------------------
# 端点级：search_stream SSE 流
# ---------------------------------------------------------------------------

class _FakeSite:
    """search_stream 只读 key/name/searchable；_iter_aggregate_search 被打桩
    不会真正触达 runner，桩掉即可。"""

    def __init__(self, key, name=None):
        self.key = key
        self.name = name or key
        self.searchable = True
        self.runner = None


def _drain_sse(gen):
    """消费 SSE 生成器，返回解析后的 (meta, [data payloads], done) 三元组。

    StreamingResponse 会把同步生成器包进 iterate_in_threadpool（async
    generator），两种形态都支持。"""
    def _parse(text, meta, payloads, done):
        for block in text.split('\n\n'):
            block = block.strip()
            if not block:
                continue
            if block.startswith('event: meta'):
                meta = json.loads(block.split('\n', 1)[1][len('data: '):])
            elif block.startswith('event: done'):
                done = True
            elif block.startswith('data: '):
                payloads.append(json.loads(block[len('data: '):]))
        return meta, payloads, done

    if hasattr(gen, '__anext__'):
        async def _arun():
            meta, payloads, done = None, [], False
            async for chunk in gen:
                meta, payloads, done = _parse(chunk, meta, payloads, done)
            return meta, payloads, done
        return asyncio.run(_arun())

    meta, payloads, done = None, [], False
    for chunk in gen:
        meta, payloads, done = _parse(chunk, meta, payloads, done)
    return meta, payloads, done


def _stream_endpoint():
    app = server.create_app()
    return next(route.endpoint for route in app.routes
                if getattr(route, 'path', '') == '/search/stream')


class SearchStreamCacheTest(unittest.TestCase):
    def setUp(self):
        mem_cache.clear_all()
        self._orig_sites = server.sites.sites
        server.sites.sites = [_FakeSite('siteA', '源A'), _FakeSite('siteB', '源B')]
        self.endpoint = _stream_endpoint()

    def tearDown(self):
        server.sites.sites = self._orig_sites
        mem_cache.clear_all()

    def _patch_iter(self, results_by_word):
        """打桩 _iter_aggregate_search：按 (word, timeout) 返回预置结果并计数。"""
        calls = []

        def fake_iter(word, timeout=20, max_inflight=16):
            calls.append((word, timeout))
            for site, items, error in results_by_word.get(word, []):
                yield site, items, error

        return mock.patch.object(server, '_iter_aggregate_search', fake_iter), calls

    def _run(self, patcher, *args, **kwargs):
        """打桩并完整消费 SSE 流（生成器 body 只在迭代时执行）。"""
        with patcher:
            meta, payloads, done = _drain_sse(
                self.endpoint(*args, **kwargs).body_iterator)
        return meta, payloads, done

    def test_first_search_walks_sources_and_caches(self):
        site_a, site_b = server.sites.sites
        items_a = [{'vod_id': '1', 'vod_name': 'x'}]
        items_b = [{'vod_id': '2', 'vod_name': 'y'}]
        patcher, calls = self._patch_iter({'海贼王': [
            (site_a, items_a, None), (site_b, items_b, None)]})
        meta, payloads, done = self._run(patcher, word='海贼王')
        assert calls == [('海贼王', 20)]
        assert done and meta == {'total': 2}
        assert [p['source'] for p in payloads] == ['siteA', 'siteB']
        assert payloads[0]['status'] == 'success'
        # 落缓存：索引登记了两个源
        assert server._aggsearch_cached_payloads('海贼王', 20) == [
            _payload('siteA', '源A', items_a), _payload('siteB', '源B', items_b)]

    def test_second_search_replays_without_source_calls(self):
        site_a, site_b = server.sites.sites
        items_a = [{'vod_id': '1', 'vod_name': 'x'}]
        patcher, calls = self._patch_iter({'海贼王': [
            (site_a, items_a, None), (site_b, [], None)]})
        self._run(patcher, word='海贼王')
        # 第二次：b 源是 noresult（空 list 落缓存，审查3.5/L9），原样重放
        patcher2, calls2 = self._patch_iter({})
        meta, payloads, done = self._run(patcher2, word='海贼王')
        assert calls2 == []  # 二次不调源
        assert meta == {'total': 2}  # 重放 2（含 noresult 源）
        assert len(payloads) == 2
        assert payloads[0]['source'] == 'siteA'
        assert payloads[0]['list'] == items_a
        # b 上次 noresult → 按原状态重放，不再误补发 error
        assert payloads[1]['source'] == 'siteB'
        assert payloads[1]['status'] == 'noresult'
        assert done

    def test_refresh_bypasses_replay_but_writes(self):
        site_a, site_b = server.sites.sites
        items_old = [{'vod_id': '1', 'vod_name': 'old'}]
        items_new = [{'vod_id': '9', 'vod_name': 'new'}]
        patcher, calls = self._patch_iter({'海贼王': [(site_a, items_old, None),
                                                     (site_b, [], None)]})
        self._run(patcher, word='海贼王')
        patcher2, calls2 = self._patch_iter({'海贼王': [(site_a, items_new, None),
                                                       (site_b, [], None)]})
        # refresh=1：跳过重放强制实时检索
        meta, payloads, done = self._run(patcher2, word='海贼王', refresh='1')
        assert calls2 == [('海贼王', 20)]
        assert payloads[0]['list'] == items_new
        assert meta == {'total': 2} and done
        # 但仍回写：随后的普通请求命中新值
        patcher3, calls3 = self._patch_iter({})
        _meta, payloads3, _done = self._run(patcher3, word='海贼王')
        assert calls3 == []
        assert payloads3[0]['list'] == items_new

    def test_error_source_not_cached_success_still_cached(self):
        """某源 error：该源不进缓存 payload；成功源照常落缓存可重放。"""
        site_a, site_b = server.sites.sites
        items_a = [{'vod_id': '1', 'vod_name': 'x'}]
        patcher, calls = self._patch_iter({'海贼王': [
            (site_a, items_a, None), (site_b, [], RuntimeError('boom'))]})
        _meta, payloads, done = self._run(patcher, word='海贼王')
        assert calls == [('海贼王', 20)]
        assert payloads[1]['status'] == 'error'  # 实时链路照常推送 error
        assert done
        # 缓存里只有 a 源；重放时 b 补发终态
        assert server._aggsearch_cached_payloads('海贼王', 20) == [
            _payload('siteA', '源A', items_a)]
        patcher2, calls2 = self._patch_iter({})
        _meta, payloads2, _done = self._run(patcher2, word='海贼王')
        assert calls2 == []
        assert [p['source'] for p in payloads2] == ['siteA', 'siteB']
        assert payloads2[1]['status'] == 'error'

    def test_replay_trims_stale_sites(self):
        """审查3.5/L10：重放前按当前 site_list 裁剪——已删除/不可检索源的
        TTL 内旧 payload 不得重放，meta.total 同步收缩；若全部源被裁掉则
        视作 miss 回退真实检索。"""
        site_a, site_b = server.sites.sites
        items_a = [{'vod_id': '1', 'vod_name': 'x'}]
        items_b = [{'vod_id': '2', 'vod_name': 'y'}]
        patcher, _calls = self._patch_iter({'海贼王': [
            (site_a, items_a, None), (site_b, items_b, None)]})
        self._run(patcher, word='海贼王')
        # 配置变更：siteB 消失，siteA 仍可检索 → 只重放 siteA
        server.sites.sites = [_FakeSite('siteA', '源A')]
        patcher2, calls2 = self._patch_iter({})
        meta, payloads, done = self._run(patcher2, word='海贼王')
        assert calls2 == []
        assert meta == {'total': 1}
        assert [p['source'] for p in payloads] == ['siteA']
        assert done
        # 配置变更：siteA 也消失 → 全裁掉，回退真实检索
        server.sites.sites = [_FakeSite('siteC', '源C')]
        patcher3, calls3 = self._patch_iter({'海贼王': [
            (server.sites.sites[0], [{'vod_id': '3'}], None)]})
        _meta, payloads3, _done = self._run(patcher3, word='海贼王')
        assert calls3 == [('海贼王', 20)]  # 走了真实检索，未重放旧源
        assert [p['source'] for p in payloads3] == ['siteC']

    def test_all_failed_not_cached_next_search_walks_again(self):
        site_a, site_b = server.sites.sites
        patcher, _calls = self._patch_iter({'海贼王': [
            (site_a, [], RuntimeError('boom')), (site_b, [], RuntimeError('boom'))]})
        _meta, payloads, _done = self._run(patcher, word='海贼王')
        assert all(p['status'] == 'error' for p in payloads)
        assert not mem_cache._store.get(NS)
        # 第二次仍走真实检索（结果恢复后照常落缓存）
        patcher2, calls2 = self._patch_iter({'海贼王': [
            (site_a, [{'vod_id': '1'}], None), (site_b, [{'vod_id': '2'}], None)]})
        self._run(patcher2, word='海贼王')
        assert calls2 == [('海贼王', 20)]

    def test_ttl_expiry_rewalks_sources(self):
        site_a, site_b = server.sites.sites
        items_v1 = [{'vod_id': '1', 'vod_name': 'v1'}]
        items_v2 = [{'vod_id': '2', 'vod_name': 'v2'}]
        patcher, calls = self._patch_iter({'海贼王': [(site_a, items_v1, None),
                                                     (site_b, [], None)]})
        self._run(patcher, word='海贼王')
        # 直接操纵 mem_cache 模拟 TTL 过期：把 ns 内全部条目过期时刻拨回过去
        bucket = mem_cache._store.get(NS)
        assert bucket
        now = time.monotonic()
        for meta in bucket.values():
            meta[1] = now - 1
        patcher2, calls2 = self._patch_iter({'海贼王': [(site_a, items_v2, None),
                                                       (site_b, [], None)]})
        _meta, payloads, _done = self._run(patcher2, word='海贼王')
        assert calls2 == [('海贼王', 20)]
        assert payloads[0]['list'] == items_v2

    def test_generator_abort_invalidates_word(self):
        """流异常中断：整词失效，残缺结果集不得参与重放（Kazumi 先例口径）。

        用 athrow 向包装生成器注入异常（消费侧崩溃的生产同形路径）；
        siteA 已落缓存但结果集残缺，finally 必须把整词清掉。"""
        site_a, site_b = server.sites.sites
        patcher, _calls = self._patch_iter({'海贼王': [
            (site_a, [{'vod_id': '1'}], None), (site_b, [], None)]})

        async def _crash_mid_stream():
            out = []
            with patcher:
                resp = self.endpoint(word='海贼王')
                try:
                    async for chunk in resp.body_iterator:
                        out.append(chunk)
                        if len(out) == 2:  # meta + 第一条 data（siteA 已落缓存）
                            # athrow 注入的异常从包装生成器向外传播（生产中
                            # uvicorn 断连走 cancel，同形触发底层 finally）
                            await resp.body_iterator.athrow(RuntimeError('client crashed'))
                            break
                except RuntimeError:
                    pass
            return out

        asyncio.run(_crash_mid_stream())
        assert server._aggsearch_cached_payloads('海贼王', 20) is None

    def test_empty_word_or_no_sites_short_circuit(self):
        assert _drain_sse(self.endpoint(word='').body_iterator) == (None, [], True)
        server.sites.sites = []
        assert _drain_sse(self.endpoint(word='海贼王').body_iterator) == (None, [], True)
        assert not mem_cache._store.get(NS)


if __name__ == '__main__':
    # 既有惯例（test_kazumi_cache.py）：纯函数层自跑 + unittest 驱动端点级；
    # 两者都绿才打印 ALL PASS。
    # 注意：exit=False 会让 unittest 失败时**不**结束本进程，脚本继续往下跑、
    # 照样打印 ALL PASS 并以 0 退出——run_all 只按 returncode 判成败，于是端点级
    # 用例全绿/全红都判 PASS，门禁形同虚设。必须显式把 wasSuccessful 转成退出码。
    res = unittest.main(argv=[sys.argv[0], 'SearchStreamCacheTest'],
                        exit=False, verbosity=1)
    if not res.result.wasSuccessful():
        sys.exit(1)
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print('PASS %s' % name)
    print('ALL PASS')
