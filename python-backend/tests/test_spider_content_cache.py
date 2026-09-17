# -*- coding: utf-8 -*-
"""Spider 内容 API 会话级内存缓存单测：key 规范化、可缓存判定、命中/回写语义。

覆盖（仿 test_mem_cache.py 风格，自写断言 + __main__ 循环，不用 pytest）：
- _spider_cache_key：四个 do 的参数规范化；
- _spider_body_cacheable：正常 body 可缓存 / 失败包络与空结果不可缓存；
- _cached_spider_content：miss 调 builder 并回写、hit 不再调 builder、
  refresh=1 跳过读但仍回写、失败包络不缓存。
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(HERE)
sys.path.insert(0, BACKEND_DIR)
# import server 会构造 SiteManager/ConfigManager，但不触网不建目录（惰性）；
# 仍按既有测试惯例把目录指到测试根，保证环境变量先于 hoststate 初始化就绪。
TEST_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BACKEND_DIR, '.test-runtime')
os.makedirs(TEST_ROOT, exist_ok=True)
os.environ.setdefault('YUKI_DATA_DIR', os.path.join(TEST_ROOT, 'data'))
os.environ.setdefault('YUKI_CACHE_DIR', os.path.join(TEST_ROOT, 'cache'))

import mem_cache  # noqa: E402
import server  # noqa: E402


def test_spider_cache_key_uses_relevant_params_per_do():
    mem_cache.clear_all()
    site_key = 'siteA'
    # homeContent：只取 filter
    k1 = server._spider_cache_key('homeContent', site_key, {'filter': 'true', 'pg': '9'})
    assert k1 == 'siteA|homeContent|filter=true', k1
    assert server._spider_cache_key('homeContent', site_key, {'filter': 'false'}) == \
        'siteA|homeContent|filter=false'
    # categoryContent：tid+pg+filter+extend（extend 原文参与，忽略无关 token）
    k3 = server._spider_cache_key('categoryContent', site_key,
                                  {'tid': '1', 'pg': '2', 'filter': 'true', 'extend': '{}',
                                   'token': 'x'})
    assert k3 == 'siteA|categoryContent|tid=1|pg=2|filter=true|extend={}', k3
    # detailContent：ids 原文
    k4 = server._spider_cache_key('detailContent', site_key, {'ids': '123,456'})
    assert k4 == 'siteA|detailContent|ids=123,456', k4
    # searchContent：word+quick+pg（word 允许 key 别名，但缓存键按生效字段 word 取值）
    k5 = server._spider_cache_key('searchContent', site_key,
                                  {'word': '海贼王', 'quick': '1', 'pg': '3'})
    assert k5 == 'siteA|searchContent|word=海贼王|quick=1|pg=3', k5
    # 同语义不同顺序的 form 应命中同一键
    assert server._spider_cache_key('searchContent', site_key,
                                    {'pg': '3', 'quick': '1', 'word': '海贼王'}) == k5
    # P1-4 回归：word 与 key 别名同值同键——只传 key 的请求不得落到空 word 键下
    assert server._spider_cache_key('searchContent', site_key,
                                    {'key': '海贼王', 'quick': '1', 'pg': '3'}) == k5
    # 别名换值必须产生不同键（跨关键词不得命中同一条目）
    k_alias = server._spider_cache_key('searchContent', site_key,
                                       {'key': '火影', 'quick': '1', 'pg': '3'})
    assert k_alias == 'siteA|searchContent|word=火影|quick=1|pg=3', k_alias
    assert k_alias != k5


def test_spider_body_cacheable():
    mem_cache.clear_all()
    ok_home = '{"code":200,"list":[{"a":1}],"class":[{"t":2}]}'
    ok_search = '{"code":200,"list":[{"v":1}]}'
    assert server._spider_body_cacheable('homeContent', ok_home) is True
    assert server._spider_body_cacheable('searchContent', ok_search) is True
    assert server._spider_body_cacheable('detailContent',
                                         '{"code":200,"list":[{"v":1}]}') is True
    assert server._spider_body_cacheable('categoryContent',
                                         '{"list":[],"class":[{"t":1}]}') is True
    # code!=200（失败包络）不可缓存
    assert server._spider_body_cacheable('homeContent',
                                         '{"code":404,"msg":"nf","list":[]}') is False
    # 空 list 不可缓存（search/detail 严格按 list；home/category 全空也不行）
    assert server._spider_body_cacheable('searchContent', '{"code":200,"list":[]}') is False
    assert server._spider_body_cacheable('detailContent', '{"code":200,"list":[]}') is False
    assert server._spider_body_cacheable('homeContent',
                                         '{"code":200,"list":[],"class":[]}') is False
    # 带 error 字段的包装后失败响应不可缓存
    assert server._spider_body_cacheable(
        'homeContent', '{"code":200,"list":[{"a":1}],"error":{"code":"L3"}}') is False
    # 非 JSON 不可缓存
    assert server._spider_body_cacheable('homeContent', 'not-json') is False
    # 结论1 #4 回归：失败码黑名单——TVBox 旧 CMS 约定 code:1 即成功
    # （fixtures/q7_offline_fixtures.SAMPLE_JSON_CMS），jar 蜘蛛原样透传
    # （jar_spider._json 不裁字段），白名单 (200,None) 会令这类源全部静默不缓存
    assert server._spider_body_cacheable(
        'detailContent', '{"code":1,"msg":"数据成功","list":[{"v":1}]}') is True
    assert server._spider_body_cacheable(
        'searchContent', '{"code":"1","list":[{"v":1}]}') is True
    # 明确失败码（0/负数/≥400）与非数值 code（包络不明）仍拒缓存
    assert server._spider_body_cacheable('detailContent', '{"code":0,"list":[{"v":1}]}') is False
    assert server._spider_body_cacheable('detailContent', '{"code":-1,"list":[{"v":1}]}') is False
    assert server._spider_body_cacheable('detailContent', '{"code":500,"list":[{"v":1}]}') is False
    assert server._spider_body_cacheable('detailContent', '{"code":"abc","list":[{"v":1}]}') is False


class _FakeSite:
    """_cached_spider_content 只读 site.key，桩掉即可。"""
    def __init__(self, key):
        self.key = key


def test_cached_spider_content_miss_write_hit():
    mem_cache.clear_all()
    site = _FakeSite('siteB')
    form = {'pg': '1'}
    body = '{"code":200,"list":[{"v":1}]}'
    calls = []

    def builder():
        calls.append(1)
        return 200, body

    # miss：调 builder 并回写
    status, out = server._cached_spider_content('searchContent', site, form, builder)
    assert (status, out) == (200, body)
    assert len(calls) == 1
    # hit：不再调 builder
    status2, out2 = server._cached_spider_content('searchContent', site, form, builder)
    assert (status2, out2) == (200, body)
    assert len(calls) == 1
    # 不同参数是不同条目，需再次调 builder
    server._cached_spider_content('searchContent', site, {'pg': '2'}, builder)
    assert len(calls) == 2
    # 不同站点隔离
    server._cached_spider_content('searchContent', _FakeSite('siteC'), form, builder)
    assert len(calls) == 3


def test_cached_spider_content_refresh_bypasses_read_but_writes():
    mem_cache.clear_all()
    site = _FakeSite('siteB')
    body_old = '{"code":200,"list":[{"v":"old"}]}'
    body_new = '{"code":200,"list":[{"v":"new"}]}'
    server._cached_spider_content('searchContent', site, {'word': 'w'},
                                  lambda: (200, body_old))
    calls = []

    def builder():
        calls.append(1)
        return 200, body_new

    # refresh=1：跳过读缓存（拿到新 body），但仍回写
    status, out = server._cached_spider_content(
        'searchContent', site, {'word': 'w', 'refresh': '1'}, builder)
    assert (status, out) == (200, body_new)
    assert len(calls) == 1
    # 随后的普通请求命中回写的新 body
    status2, out2 = server._cached_spider_content('searchContent', site, {'word': 'w'}, builder)
    assert (status2, out2) == (200, body_new)
    assert len(calls) == 1


def test_cached_spider_content_failure_envelope_not_cached():
    mem_cache.clear_all()
    site = _FakeSite('siteB')
    calls = []

    def fail_builder():
        calls.append(1)
        return 200, '{"code":404,"msg":"nope","list":[]}'

    # 失败包络：照常返回但不写缓存，后续请求仍走 builder
    status, out = server._cached_spider_content('searchContent', site, {'word': 'w'},
                                                fail_builder)
    assert (status, out) == (200, '{"code":404,"msg":"nope","list":[]}')
    assert len(calls) == 1
    server._cached_spider_content('searchContent', site, {'word': 'w'}, fail_builder)
    assert len(calls) == 2
    # 非 200 status 同样不缓存（builder 返回错误状态时每次都应重新执行）
    err_body = '{"code":200,"list":[{"v":1}]}'
    status3, out3 = server._cached_spider_content('searchContent', site, {'word': 'w'},
                                                  lambda: (500, err_body))
    assert (status3, out3) == (500, err_body)
    calls.append(1)
    assert len(calls) == 3
    assert 'spider:search' not in mem_cache._store


def test_cached_spider_content_unknown_do_passthrough():
    mem_cache.clear_all()
    site = _FakeSite('siteB')
    # 未登记的 do 直接透传 builder（homeVideoContent 等不缓存路径的护栏）
    status, out = server._cached_spider_content('homeVideoContent', site, {},
                                                lambda: (200, '{"code":200,"list":[]}'))
    assert (status, out) == (200, '{"code":200,"list":[]}')
    assert not mem_cache._store


def test_ns_default_ttl_used():
    mem_cache.clear_all()
    site = _FakeSite('siteB')
    server._cached_spider_content('detailContent', site, {'ids': '9'},
                                  lambda: (200, '{"code":200,"list":[{"v":1}]}'))
    # set_value 未传 ttl → 走 DEFAULT_TTL['spider:detail']=1800（远大于即时过期）
    key = server._spider_cache_key('detailContent', 'siteB', {'ids': '9'})
    bucket = mem_cache._store.get('spider:detail')
    assert bucket is not None and key in bucket
    _, exp, _ = bucket[key]
    # 默认 TTL 1800s：断言过期时刻确实在未来（弱断言 exp>0 会放过任何过期值）
    assert exp > time.monotonic() + 1000
    # 不应写到其他 ns
    assert not any(ns.startswith('spider:') and ns != 'spider:detail'
                   for ns in mem_cache._store)


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print('PASS %s' % name)
    print('ALL PASS')
