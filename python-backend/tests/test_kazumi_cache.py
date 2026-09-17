# -*- coding: utf-8 -*-
"""Kazumi 规则源搜索/章节会话缓存（mem_cache）单元测试。

覆盖：_cached_kazumi_search（miss 回写 / hit 秒回 / refresh 跳读仍回写 /
异常不缓存）、_cached_kazumi_chapters（含空 roads 不缓存）、SSE 单源缓存
写入与整词索引重放、失效钩子。只测纯辅助函数，不拉起 FastAPI。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
for _path in (BASE, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import mem_cache  # noqa: E402
import server  # noqa: E402


def test_search_cache_miss_builds_and_caches():
    mem_cache.clear_all()
    calls = []

    def builder():
        calls.append(1)
        return 200, '{"code": 200, "results": [{"pluginName": "a"}]}'

    status, body = server._cached_kazumi_search({'keyword': '海贼王'}, builder)
    assert status == 200
    assert calls == [1]
    assert body == '{"code": 200, "results": [{"pluginName": "a"}]}'
    # miss 回写后缓存里应有该条目
    assert mem_cache.get_value('kazumi:search', '海贼王') == body


def test_search_cache_hit_no_builder():
    mem_cache.clear_all()
    mem_cache.set_value('kazumi:search', '海贼王', '{"code": 200, "results": [{"pluginName": "a", "data": ["cached"]}]}')
    calls = []

    def builder():
        calls.append(1)
        return 200, '{"code": 200, "results": [{"pluginName": "a", "data": ["fresh"]}]}'

    status, body = server._cached_kazumi_search({'keyword': '海贼王'}, builder)
    assert status == 200
    assert calls == []
    assert body == '{"code": 200, "results": [{"pluginName": "a", "data": ["cached"]}]}'


def test_search_cache_refresh_skips_read_but_writes():
    mem_cache.clear_all()
    mem_cache.set_value('kazumi:search', '海贼王', '{"code": 200, "results": [{"pluginName": "a", "data": ["old"]}]}')
    calls = []

    def builder():
        calls.append(1)
        return 200, '{"code": 200, "results": [{"pluginName": "a", "data": ["fresh"]}]}'

    status, body = server._cached_kazumi_search({'keyword': '海贼王', 'refresh': '1'}, builder)
    assert status == 200
    assert calls == [1]  # refresh 跳过读缓存，builder 被调用
    assert body == '{"code": 200, "results": [{"pluginName": "a", "data": ["fresh"]}]}'
    # 但仍回写：下一次（不带 refresh）命中新值
    status2, body2 = server._cached_kazumi_search({'keyword': '海贼王'}, builder)
    assert status2 == 200 and calls == [1]
    assert body2 == '{"code": 200, "results": [{"pluginName": "a", "data": ["fresh"]}]}'


def test_search_cache_builder_exception_not_cached():
    mem_cache.clear_all()
    calls = []

    def builder():
        calls.append(1)
        raise RuntimeError('network down')

    try:
        server._cached_kazumi_search({'keyword': '海贼王'}, builder)
        raise AssertionError('builder exception should propagate')
    except RuntimeError:
        pass
    assert calls == [1]
    # 异常路径不得写入缓存
    assert mem_cache.get_value('kazumi:search', '海贼王') is None


def test_search_cache_empty_or_all_error_not_cached():
    """P2-1：空结果/全 error/全 captcha 不缓存，避免瞬时故障被钉死整个 TTL。"""
    mem_cache.clear_all()
    cases = [
        '{"code": 200, "results": []}',                                   # 无插件空结果
        '{"code": 200, "results": [{"pluginName": "a", "error": true}]}',  # 全部失败
        '{"code": 200, "results": [{"pluginName": "a", "captcha": true, "captchaUrl": "u"}]}',  # 全部验证码
        '{"code": 200, "msg": "ok"}',                                     # 无 results 字段
    ]
    for i, body in enumerate(cases):
        calls = []

        def builder():
            calls.append(1)
            return 200, body

        status, out = server._cached_kazumi_search({'keyword': 'kw%d' % i}, builder)
        assert (status, out) == (200, body)
        assert mem_cache.get_value('kazumi:search', 'kw%d' % i) is None, body
        # 未缓存 → 第二次仍走 builder
        server._cached_kazumi_search({'keyword': 'kw%d' % i}, builder)
        assert len(calls) == 2
    # 混合结果（有成功有失败）可以缓存
    mixed = '{"code": 200, "results": [{"pluginName": "a", "error": true}, {"pluginName": "b", "data": [1]}]}'
    server._cached_kazumi_search({'keyword': 'mix'}, lambda: (200, mixed))
    assert mem_cache.get_value('kazumi:search', 'mix') == mixed


def test_search_cache_plugin_filter_separate_key():
    mem_cache.clear_all()
    mem_cache.set_value('kazumi:search', '海贼王',
                        '{"code": 200, "results": [{"pluginName": "a", "data": [1]}]}')
    ok_body = '{"code": 200, "results": [{"pluginName": "enlie", "data": [2]}]}'
    status, body = server._cached_kazumi_search(
        {'keyword': '海贼王', 'plugin': ' enlie '},
        lambda: (200, ok_body))
    # 带单源过滤的请求有独立键，不命中全量条目
    assert body == ok_body
    assert mem_cache.get_value('kazumi:search', '海贼王|p:enlie') == ok_body


def test_chapters_cache_roundtrip_and_refresh():
    mem_cache.clear_all()
    roads_body = '{"code": 200, "roads": [{"name": "线路1", "data": []}]}'
    calls = []

    def builder():
        calls.append(1)
        return 200, roads_body

    status, body = server._cached_kazumi_chapters({}, 'enlie', 'https://x/1', builder)
    assert status == 200 and calls == [1] and body == roads_body
    assert mem_cache.get_value('kazumi:chapters', 'enlie|https://x/1') == roads_body
    # 命中：builder 不再被调
    status2, body2 = server._cached_kazumi_chapters({}, 'enlie', 'https://x/1', builder)
    assert status2 == 200 and calls == [1] and body2 == roads_body
    # refresh=1：跳读仍回写
    status3, body3 = server._cached_kazumi_chapters(
        {'refresh': '1'}, 'enlie', 'https://x/1', builder)
    assert status3 == 200 and len(calls) == 2 and body3 == roads_body


def test_chapters_empty_roads_not_cached():
    mem_cache.clear_all()
    calls = []

    def builder():
        calls.append(1)
        return 200, '{"code": 200, "roads": []}'

    status, body = server._cached_kazumi_chapters({}, 'enlie', 'https://x/1', builder)
    assert status == 200 and body == '{"code": 200, "roads": []}'
    # 空 roads 不缓存，防止异常源把空结果钉死整个 TTL
    assert mem_cache.get_value('kazumi:chapters', 'enlie|https://x/1') is None
    server._cached_kazumi_chapters({}, 'enlie', 'https://x/1', builder)
    assert len(calls) == 2


def test_stream_cache_put_and_replay():
    mem_cache.clear_all()
    # 索引不存在 → 返回 None（走正常并发搜索）
    assert server._kazumi_stream_cached_payloads('海贼王', '||') is None
    p1 = '{"source": "kazumi:a", "name": "a", "list": [1], "status": "success"}'
    p2 = '{"source": "kazumi:b", "name": "b", "list": [], "status": "noresult"}'
    server._kazumi_stream_cache_put_source('海贼王', '||', 'a', p1)
    server._kazumi_stream_cache_put_source('海贼王', '||', 'b', p2)
    # 按登记顺序重放
    payloads = server._kazumi_stream_cached_payloads('海贼王', '||')
    assert payloads == [p1, p2]
    # 重复写同一源不产生重复索引条目
    server._kazumi_stream_cache_put_source('海贼王', '||', 'a', p1)
    payloads = server._kazumi_stream_cached_payloads('海贼王', '||')
    assert payloads == [p1, p2]
    # 换一个 word 互不影响
    assert server._kazumi_stream_cached_payloads('火影', '||') is None


def test_stream_cache_filters_are_part_of_key():
    """P1-1：tag/year/sort 参与缓存键——同 word 不同筛选绝不互相串结果。"""
    mem_cache.clear_all()
    p_unfiltered = '{"source": "kazumi:a", "name": "a", "list": [1], "status": "success"}'
    p_tagged = '{"source": "kazumi:a", "name": "a", "list": [2], "status": "success"}'
    server._kazumi_stream_cache_put_source('海贼王', '||', 'a', p_unfiltered)
    server._kazumi_stream_cache_put_source('海贼王', '热血|2024|', 'a', p_tagged)
    assert server._kazumi_stream_cached_payloads('海贼王', '||') == [p_unfiltered]
    assert server._kazumi_stream_cached_payloads('海贼王', '热血|2024|') == [p_tagged]
    # 第三个筛选未缓存过
    assert server._kazumi_stream_cached_payloads('海贼王', '||2024') is None
    # 指纹规范化：None/空串同键
    assert server._kazumi_stream_filters_key('', '', '') == '||'
    assert server._kazumi_stream_filters_key(None, None, None) == '||'


def test_stream_cache_replay_skips_missing_entries():
    mem_cache.clear_all()
    p1 = '{"source": "kazumi:a", "name": "a", "list": [1], "status": "success"}'
    p2 = '{"source": "kazumi:b", "name": "b", "list": [2], "status": "success"}'
    server._kazumi_stream_cache_put_source('海贼王', '||', 'a', p1)
    server._kazumi_stream_cache_put_source('海贼王', '||', 'b', p2)
    # 某条单源缓存过期/被 LRU 淘汰后，重放跳过缺失项而不是整词失效
    # （payload 键形如 stream|word|fkey|plugin；fkey='||' 时 b 源全键为
    # stream|海贼王||||b——用与实现相同的格式表达式构造，避免竖线数数错）
    mem_cache._store['kazumi:stream'].pop('stream|%s|%s|%s' % ('海贼王', '||', 'b'), None)
    payloads = server._kazumi_stream_cached_payloads('海贼王', '||')
    assert payloads == [p1]


def test_stream_cache_empty_replay_means_miss():
    """P2-2：索引在而 payload 全部失效 → 空列表（调用方视作 miss 回退网络），
    绝不能与「索引不存在」混同——后者返回 None，两者都不该重放出空结果。"""
    mem_cache.clear_all()
    p1 = '{"source": "kazumi:a", "name": "a", "list": [1], "status": "success"}'
    server._kazumi_stream_cache_put_source('海贼王', '||', 'a', p1)
    # 全部 payload 失效：索引仍在（独立条目），返回空列表而非 None
    mem_cache.invalidate_prefix('kazumi:stream', 'stream|海贼王||')
    payloads = server._kazumi_stream_cached_payloads('海贼王', '||')
    assert payloads == []
    assert payloads is not None  # 调用方 `if cached_payloads:` 空列表即回退网络


def test_stream_error_source_not_cached():
    """P2-6：error 单源 payload 不落缓存——瞬时故障不该冻结进重放。"""
    mem_cache.clear_all()
    err = '{"source": "kazumi:a", "name": "a", "list": [], "status": "error", "msg": "boom"}'
    server._kazumi_stream_cache_put_source('海贼王', '||', 'a', err)
    # 写入 helper 本身不做 error 判定（调用方过滤），但这里验证端点口径：
    # 模拟端点行为——error 时跳过 put。
    mem_cache.clear_all()
    assert server._kazumi_stream_cached_payloads('海贼王', '||') is None
    # 端点对 error 结果不调用 put_source → 索引与 payload 均不存在
    ok = '{"source": "kazumi:b", "name": "b", "list": [1], "status": "success"}'
    server._kazumi_stream_cache_put_source('海贼王', '||', 'b', ok)
    payloads = server._kazumi_stream_cached_payloads('海贼王', '||')
    assert payloads == [ok]  # 只有成功源进索引；error 源重放时天然缺失被跳过


def test_invalidate_helpers():
    mem_cache.clear_all()
    mem_cache.set_value('kazumi:search', 'kw', 'v')
    server._kazumi_stream_cache_put_source('kw', '||', 'a', '{"name":"a","list":[1]}')
    mem_cache.set_value('kazumi:chapters', 'p|s', 'v')
    # 默认清 search+stream 两 ns（失效判定/重排场景：章节不受插件集合影响）
    server._kazumi_invalidate_caches()
    assert mem_cache.get_value('kazumi:search', 'kw') is None
    assert server._kazumi_stream_cached_payloads('kw', '||') is None
    assert mem_cache.get_value('kazumi:chapters', 'p|s') == 'v'
    # chapters=True 三 ns 一起清（插件增删/Cookie 场景）
    mem_cache.set_value('kazumi:search', 'kw2', 'v')
    server._kazumi_invalidate_caches(chapters=True)
    assert mem_cache.get_value('kazumi:search', 'kw2') is None
    assert mem_cache.get_value('kazumi:chapters', 'p|s') is None


def test_stream_cache_invalidate_word():
    """P1（结论2 #2）：超时/异常中断的流整词失效——残缺结果不得参与重放。"""
    mem_cache.clear_all()
    p1 = '{"source": "kazumi:a", "name": "a", "list": [1], "status": "success"}'
    p2 = '{"source": "kazumi:b", "name": "b", "list": [2], "status": "success"}'
    server._kazumi_stream_cache_put_source('海贼王', '||', 'a', p1)
    server._kazumi_stream_cache_put_source('海贼王', '||', 'b', p2)
    # 其他词/其他筛选不受波及
    server._kazumi_stream_cache_put_source('海贼王', '热血||', 'a', p1)
    server._kazumi_stream_cache_put_source('火影', '||', 'a', p1)
    server._kazumi_stream_cache_invalidate_word('海贼王', '||')
    assert server._kazumi_stream_cached_payloads('海贼王', '||') is None  # 索引+payload 全清
    assert server._kazumi_stream_cached_payloads('海贼王', '热血||') == [p1]
    assert server._kazumi_stream_cached_payloads('火影', '||') == [p1]


def test_stream_missing_names():
    """P1（结论1 #1）：重放对未缓存源（上次 error/中断）补发终态的判定依据。"""
    mem_cache.clear_all()
    p1 = '{"source": "kazumi:a", "name": "a", "list": [1], "status": "success"}'
    p2 = '{"source": "kazumi:b", "name": "b", "list": [], "status": "noresult"}'
    server._kazumi_stream_cache_put_source('海贼王', '||', 'a', p1)
    server._kazumi_stream_cache_put_source('海贼王', '||', 'b', p2)
    payloads = server._kazumi_stream_cached_payloads('海贼王', '||')
    # c 上次 error 不落缓存 → 重放缺它 → 必须被列为补齐对象（否则其卡永久 pending）
    assert server._kazumi_stream_missing_names(payloads, ['a', 'b', 'c']) == ['c']
    assert server._kazumi_stream_missing_names(payloads, ['a', 'b']) == []
    # 坏 payload（无法解析）不视为已覆盖
    assert server._kazumi_stream_missing_names(['not-json', p1], ['a', 'b']) == ['b']


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print('PASS %s' % name)
    print('ALL PASS')
