# -*- coding: utf-8 -*-
"""spider 三模块白盒单测：js_spider / cms_spider / base.spider。

与既有测试的互补边界（避免重复覆盖）：
- test_cms_xml_encoding.py：只测 XML 编码声明（GBK/gb2312/无声明/bytes 兜底）
  与 DOCTYPE 安全。本文件改测 _parse_xml 的**字段映射/分页/播放源拼接/畸形文档**，
  以及 _fetch 的分派（JSON / XML / 非二者）与重试。
- test_n3_runtime_parity.py::TestN34CmsContract：只测 playerContent/isVideoFormat
  的假直链判定与一段 XML 冒烟。本文件展开到 CMS 全部内容 API 的参数拼装、
  分页字段非法值兜底、_vod_short/_vod_full 字段裁剪语义。
- test_spider_content_cache.py / test_ext_semantics.py：覆盖 server 侧缓存键与
  ext 语义，不涉及本三模块。
- test_all_runtimes_contract.py：走真实 quickjs 子进程跑通 JS 六方法。
  本文件改为**桩掉 JS 引擎**（禁止起 Node/QuickJS 子进程），专测参数拼装与
  非 JSON/超时/引擎缺席时的兜底。

风格沿用 test_mem_cache.py：模块级 ``def test_xxx`` + 裸 ``assert`` + 中文
docstring + 文件末尾汇总 runner。全部 HTTP / 子进程 / 文件系统均打桩。
"""
import json
import os
import sys
import time
import urllib.parse

import unittest.mock as mock

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(HERE)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

# 测试态目录，避免触碰真实 ~/.yuki 数据
TEST_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BACKEND_DIR, '.test-runtime')
os.makedirs(TEST_ROOT, exist_ok=True)
os.environ.setdefault('YUKI_DATA_DIR', os.path.join(TEST_ROOT, 'data'))
os.environ.setdefault('YUKI_CACHE_DIR', os.path.join(TEST_ROOT, 'cache'))

import base.spider as base_spider  # noqa: E402
import cms_spider  # noqa: E402
import hoststate  # noqa: E402
import js_spider  # noqa: E402
from runner import Runner  # noqa: E402

UA_JSON = json.dumps(cms_spider.UA)


# ==================================================================
# 通用桩
# ==================================================================

class _FakeRsp:
    """requests.Response 的最小鸭子替身（text/status_code/headers/encoding）。"""

    def __init__(self, text='', status_code=200, headers=None, apparent='utf-8'):
        self.text = text
        self.status_code = status_code
        self.headers = headers or {}
        self.apparent_encoding = apparent
        self.encoding = None
        self.closed = False

    def close(self):
        self.closed = True


def _guard_passthrough():
    """打桩 http_client._guard_hop 为恒等映射。

    config_security 的真实守卫会做 DNS 解析（每跳 ~1.5s），单测里既慢又是
    真实网络访问；fetch/post 的守卫语义由
    test_base_guard_spider_url_exempts_loopback_only 单独覆盖。
    """
    return mock.patch.object(base_spider.http_client, '_guard_hop',
                             side_effect=lambda url, **_kw: url)


class _FakeEngine:
    """JsEngine 替身：只记录调用并返回预设结果，绝不接触 quickjs。"""

    def __init__(self, returns=None, protocol='string', raises=None):
        self.init_protocol = protocol
        self.returns = returns if returns is not None else {}
        self.raises = raises or {}
        self.calls = []
        self.destroyed = 0
        self.destroy_raises = False

    def call(self, method, *args):
        self.calls.append((method, args))
        if method in self.raises:
            raise self.raises[method]
        return self.returns.get(method, '{}')

    def destroy(self):
        self.destroyed += 1
        if self.destroy_raises:
            raise RuntimeError('engine destroy exploded')


def _js(returns=None, protocol='string', raises=None, key='js_wb'):
    """造一个独立 JsSpider 实例（走 make_js_spider_class 的子类隔离）。"""
    engine = _FakeEngine(returns=returns, protocol=protocol, raises=raises)
    spider = js_spider.make_js_spider_class(key, engine, 'WB-' + key)
    spider.engine = engine
    return spider, engine


def _cms(responses):
    """造一个 CmsSpider，_fetch 依次返回 responses（记录每次 params）。

    之前用 ``pending[len(calls) - 1]`` 负索引：实现多调一次 _fetch 时会静默复用
    最后一条预设响应，而不是报错。依赖该桩且没有断言 ``spider._calls`` 的用例
    在实现回归出多余请求时会照样通过，掩盖真实 bug。改为显式防越界。
    """
    spider = cms_spider.CmsSpider('cms_wb', 'http://cms.test/api.php', stype=1, name='CMS白盒')
    calls = []
    pending = list(responses)

    def _fetch(params):
        calls.append(dict(params))
        idx = len(calls) - 1
        if idx >= len(pending):
            raise AssertionError(
                'unexpected extra _fetch call #%d (only %d response(s) stubbed)'
                % (idx + 1, len(pending)))
        return pending[idx]

    spider._fetch = _fetch
    spider._calls = calls
    return spider


class _BaseSpider(base_spider.Spider):
    """base.spider.Spider 的最小可实例化子类（抽象类只强制 init）。"""

    def init(self, extend=''):
        self.extend = extend


# ==================================================================
# 第一节：js_spider —— 动作分发与 JS 引擎参数拼装
# ==================================================================

def test_js_dispatch_all_known_actions_hit_expected_method():
    """五个内容动作 + live/proxy/action 必须映射到 CatVod 的 JS 方法名。"""
    spider, engine = _js({'home': '{"class":[]}', 'homeVod': '{"list":[]}',
                          'category': '{"list":[]}', 'detail': '{"list":[]}',
                          'search': '{"list":[]}', 'play': '{"url":"u"}',
                          'live': 'live-raw', 'action': '{"a":1}'})
    spider.homeContent(True)
    spider.homeVideoContent()
    spider.categoryContent('1', '2', False, {})
    spider.detailContent(['a', 'b'])
    spider.searchContent('kw', '0')
    spider.playerContent('f', 'i', [])
    spider.liveContent('u')
    spider.action({'a': 1})
    assert [c[0] for c in engine.calls] == [
        'home', 'homeVod', 'category', 'detail', 'search', 'play', 'live', 'action']


def test_js_dispatch_unknown_action_is_not_dispatcher():
    """本适配层没有字符串动作表：方法名由 Python 方法直接决定，未知动作不静默。"""
    spider, engine = _js()
    assert not hasattr(spider, 'unknownAction')
    try:
        spider.unknownAction('x')
    except AttributeError:
        pass
    else:
        assert False, '未知动作必须抛 AttributeError，不得静默返回'
    assert engine.calls == [], '未分发成功的方法不得产生 JS 调用'


def test_js_dispatch_method_name_is_case_and_space_sensitive():
    """动作名大小写/空白不做归一化：'homecontent' 与 ' homeContent' 均不命中。"""
    spider, engine = _js({'home': '{"class":[]}'})
    for bad in ('homecontent', 'HomeContent', ' homeContent', 'homeContent '):
        assert not hasattr(spider, bad), bad
    spider.homeContent(True)
    assert engine.calls == [('home', (True,))]


def test_js_dispatch_missing_action_argument_passes_none_through():
    """action 缺参（None）原样透传给 JS，由 JS 侧兜底（与 js_spider.py 直通实现一致）。

    之前 docstring 声称「不发 None 给 JS：退成空 dict 再序列化」，但断言却是
    ``('action', (None,))`` —— None **原样透传**。测试名/文档/断言三者互相矛盾，
    本用例名与 docstring 已对齐到断言钉住的真实契约。
    """
    spider, engine = _js({'action': '{}'})
    spider.action(None)
    assert engine.calls[-1] == ('action', (None,))
    spider.action('')
    assert engine.calls[-1] == ('action', ('',))


def test_js_home_casts_filter_to_bool_before_engine():
    """home 的 filter 在 Python 侧就转 bool：引擎收到的一定是 True/False。"""
    spider, engine = _js({'home': '{}'})
    spider.homeContent({'a': 1})
    spider.homeContent('x')
    spider.homeContent(None)
    spider.homeContent(0)
    spider.homeContent(False)
    assert [c[1] for c in engine.calls] == [
        (True,), (True,), (False,), (False,), (False,)]
    assert all(isinstance(c[1][0], bool) for c in engine.calls)


def test_js_category_normalizes_tid_pg_and_extend():
    """category 的 tid/pg 强转 str；extend 为 None 时补 {}。"""
    spider, engine = _js({'category': '{}'})
    spider.categoryContent(7, 3, True, {'area': '日本'})
    assert engine.calls[-1] == ('category', ('7', '3', True, {'area': '日本'}))
    spider.categoryContent('1', '1', False, None)
    assert engine.calls[-1] == ('category', ('1', '1', False, {}))


def test_js_detail_joins_ids_list_with_comma():
    """detail 的 ids 列表用英文逗号拼接；单元素与裸字符串等价。"""
    spider, engine = _js({'detail': '{}'})
    spider.detailContent(['1', '2', '3'])
    assert engine.calls[-1] == ('detail', ('1,2,3',))
    spider.detailContent(['9'])
    assert engine.calls[-1] == ('detail', ('9',))
    spider.detailContent('9')
    assert engine.calls[-1] == ('detail', ('9',))


def test_js_search_truthy_quick_and_str_pg():
    """search 的 quick 走 _truthy，pg 一律 str。"""
    spider, engine = _js({'search': '{}'})
    spider.searchContent('海贼王', '1', 2)
    assert engine.calls[-1] == ('search', ('海贼王', True, '2'))
    spider.searchContent('海贼王', '0')
    assert engine.calls[-1] == ('search', ('海贼王', False, '1'))


def test_js_play_passes_vipflags_list_and_keeps_none_as_empty():
    """play 的 vipFlags 为 None 时补 []，保持 JS 侧数组语义。"""
    spider, engine = _js({'play': '{"parse":0}'})
    spider.playerContent('line', 'id1', ['qiyi'])
    assert engine.calls[-1] == ('play', ('line', 'id1', ['qiyi']))
    spider.playerContent('line', 'id1', None)
    assert engine.calls[-1] == ('play', ('line', 'id1', []))


def test_js_init_catvod_protocol_sends_raw_string():
    """CatVod 协议：init(ext) 收字符串，dict/None 先序列化。"""
    spider, engine = _js(protocol='string')
    spider.init('{"a":1}')
    assert engine.calls[-1] == ('init', ('{"a":1}',))
    spider.init({'b': 2})
    assert engine.calls[-1] == ('init', ('{"b": 2}',))
    spider.init(None)
    assert engine.calls[-1] == ('init', ('""',))


def test_js_init_fongmi_protocol_sends_cfg_object():
    """FongMi 协议：init 收 {skey, stype, ext} 对象，stype 恒为 3。"""
    spider, engine = _js(protocol='fongmi')
    spider.site_key = 'SK'
    spider.init('ext-text')
    assert engine.calls[-1] == ('init', ({'skey': 'SK', 'stype': 3, 'ext': 'ext-text'},))
    spider.init({'a': 1})
    assert engine.calls[-1][1][0]['skey'] == 'SK'
    assert engine.calls[-1][1][0]['stype'] == 3
    assert json.loads(engine.calls[-1][1][0]['ext']) == {'a': 1}


def test_js_init_unknown_protocol_defaults_to_catvod():
    """engine 未声明 init_protocol（取不到属性）时按 CatVod 字符串语义。"""
    spider, engine = _js(protocol='string')
    del engine.init_protocol

    class _Bare:
        def call(self, method, *args):
            engine.calls.append((method, args))
            return '{}'

    spider.engine = _Bare()
    spider.init('raw')
    assert engine.calls[-1] == ('init', ('raw',))


def test_js_engine_absent_returns_defaults_without_error():
    """engine 为 None（站点未装配）时所有内容 API 返回默认空包，不抛异常。"""
    spider, _engine = _js()
    spider.engine = None
    assert spider.homeContent(True) == {}
    assert spider.homeVideoContent() == {}
    assert spider.categoryContent('1', '1', False, {}) == {}
    assert spider.detailContent(['1']) == {}
    assert spider.searchContent('k', '0') == {}
    assert spider.playerContent('f', 'i', []) == {}
    assert spider.liveContent('u') == ''
    assert spider.localProxy({'a': 1}) is None
    assert spider.isVideoFormat('u') is False
    assert spider.manualVideoCheck() is False
    assert spider.action('a') == {}
    assert spider.destroy() is None


def test_js_engine_timeout_and_exception_both_degrade():
    """JS 抛超时/任意异常时 _call 吞掉并返回 None，各 API 落到默认值。"""
    cases = [
        {'home': TimeoutError('js call timeout 35s')},
        {'home': RuntimeError('quickjs stack overflow')},
        {'home': ValueError('bad return')},
    ]
    for raises in cases:
        spider, _engine = _js(raises=raises)
        assert spider.homeContent(True) == {}, raises
    spider, _engine = _js(raises={'play': RuntimeError('x')})
    assert spider.playerContent('f', 'i', []) == {}
    assert spider.isVideoFormat('u') is False
    # live 的默认值来自 `or ''`：异常时 _call 返回 None → ''
    spider, _engine = _js(raises={'live': RuntimeError('x')})
    assert spider.liveContent('u') == ''


def test_js_non_json_and_empty_output_fall_back_to_default():
    """JS 返回非 JSON / 空串 / JSON 字面量 null 时的兜底语义。"""
    # 非 JSON 文本
    spider, _engine = _js({'home': 'undefined'})
    assert spider.homeContent(True) == {}
    # 空输出
    spider, _engine = _js({'home': ''})
    assert spider.homeContent(True) == {}
    # 字面量 null（JSON 合法，_json 不拦截，调用方拿到 None）
    spider, _engine = _js({'home': 'null'})
    assert spider.homeContent(True) is None
    # 合法非对象 JSON（数组/数字/布尔）原样透出
    spider, _engine = _js({'home': '[1,2]', 'live': '3'})
    assert spider.homeContent(True) == [1, 2]


def test_js_utf8_payload_roundtrip_is_not_double_escaped():
    """中文 payload 走 json.loads 后保持原字符（ensure_ascii 只影响写入侧）。"""
    spider, _engine = _js({'home': '{"list":[{"vod_name":"凡人修仙传","vod_remarks":"更新至第8集"}]}'})
    home = spider.homeContent(True)
    assert home['list'][0]['vod_name'] == '凡人修仙传'
    assert home['list'][0]['vod_remarks'] == '更新至第8集'
    # 转义写法（\uXXXX）同样解出中文
    spider, _engine = _js({'home': '{"vod_name":"\\u6d4b\\u8bd5"}'})
    assert spider.homeContent(True)['vod_name'] == '测试'


def test_js_gbk_decoded_payload_parses_after_decode():
    """GBK 源由引擎侧解码为 str 后交给 _json：解码后的中文可被正常解析。"""
    raw = '{"vod_name":"国产剧"}'.encode('gbk')
    spider, _engine = _js({'home': raw.decode('gbk')})
    assert spider.homeContent(True)['vod_name'] == '国产剧'
    # JSON 里写死的 \uXXXX 转义同样解出中文（不依赖传输编码）
    spider, _engine = _js({'home': '{"vod_name":"\\u56fd\\u4ea7\\u5267"}'})
    assert spider.homeContent(True)['vod_name'] == '国产剧'
    # 未解码的 GBK 字节直接给 _json：json.loads 按 utf-8 解抛 UnicodeDecodeError，
    # 而 UnicodeDecodeError 是 ValueError 子类 → 被 _json 的 except 吃掉，返回 default
    assert js_spider.JsSpider._json(raw, 'DEF') == 'DEF'
    assert js_spider.JsSpider._json(raw) is None
    # UTF-8 字节则正常解析（json.loads 原生支持 bytes）
    assert js_spider.JsSpider._json('{"vod_name":"国产剧"}'.encode('utf-8'), {}) == \
        {'vod_name': '国产剧'}


def test_js_json_static_helper_branch_table():
    """_json 静态方法：None→default，坏串→default，合法值→原样（含非对象）。"""
    assert js_spider.JsSpider._json(None) is None
    assert js_spider.JsSpider._json(None, 'DEF') == 'DEF'
    assert js_spider.JsSpider._json('{oops', 'DEF') == 'DEF'
    assert js_spider.JsSpider._json('', 'DEF') == 'DEF'
    assert js_spider.JsSpider._json('{"a":1}', 'DEF') == {'a': 1}
    assert js_spider.JsSpider._json('true', 'DEF') is True
    assert js_spider.JsSpider._json('5', 'DEF') == 5
    # 已经是对象时走 json.loads 失败路径（TypeError）→ default
    assert js_spider.JsSpider._json({'a': 1}, 'DEF') == 'DEF'


def test_js_truthy_static_helper_branch_table():
    """_truthy：bool 直返；其余一律 str(v).lower() 后比对 ('1','true','yes')。"""
    t = js_spider.JsSpider._truthy
    assert t(True) is True and t(False) is False
    for v in ('1', 'true', 'TRUE', 'True', 'yes', 'YES'):
        assert t(v) is True, v
    for v in ('0', 'false', 'no', '', '2', 'on'):
        assert t(v) is False, v
    # 整数 1 走 str() 分支 → '1' → True；0/None 是 False
    assert t(1) is True and t(0) is False and t(None) is False
    assert t([]) is False and t({}) is False


def test_js_live_and_proxy_return_raw_not_json():
    """live/proxy 走 raw 通道：live 返回字符串本体，proxy 二次解析失败即回退 raw。"""
    spider, engine = _js({'live': 'm3u8-text', 'proxy': 'not-json'})
    assert spider.liveContent('u') == 'm3u8-text'
    assert spider.localProxy({'a': 1}) == 'not-json'
    spider, engine = _js({'proxy': '{"url":"http://x"}'})
    assert spider.localProxy({'a': 1}) == {'url': 'http://x'}


def test_js_destroy_swallows_engine_failure():
    """destroy 期间引擎抛错不得冒泡；正常路径确实调用了引擎 destroy。"""
    spider, engine = _js()
    spider.destroy()
    assert engine.destroyed == 1
    engine.destroy_raises = True
    assert spider.destroy() is None
    assert engine.destroyed == 2


def test_js_make_class_generates_isolated_subclasses():
    """每个 key 一个独立子类（规避单例串源），类属性正确注入。"""
    a, ea = _js(key='a')
    b, eb = _js(key='b')
    assert a is not b
    assert type(a) is not type(b), 'key 不同 → 不同子类'
    assert issubclass(type(a), js_spider.JsSpider)
    assert type(a).__name__ == 'JsSpider_a'
    assert type(b).__name__ == 'JsSpider_b'
    assert a.site_name == 'WB-a' and b.site_name == 'WB-b'
    assert a.site_key == 'a' and b.site_key == 'b'
    assert a.getName() == 'WB-a' and b.getName() == 'WB-b'
    a.homeContent(True)
    assert eb.calls == [] and len(ea.calls) == 1
    # make_js_spider_class 每次都 type() 出一个新类，同 key 重复调用得到新实例
    again = js_spider.make_js_spider_class('a', ea, 'WB-a')
    assert again is not a
    assert type(again).__name__ == 'JsSpider_a'


def test_js_subclass_shares_base_singleton_when_no_own_instance():
    """白盒护栏：JsSpider 子类若自身没有 _instance，会复用基类共享实例。

    make_js_spider_class 靠 type() 动态建类规避这点；直接手写子类会串源。
    """
    class _HandWritten(js_spider.JsSpider):
        engine = _FakeEngine({'home': '{"who":"hand"}'})

    first = _HandWritten()
    second = _HandWritten()
    assert first is second, '同子类两次实例化命中同一实例'
    assert '_instance' in type(first).__dict__, '首次实例化时在子类上落 _instance'
    # 动态生成的类各自持有自己的 _instance（互不串源）
    dyn, _e = _js(key='dyn')
    other, _e2 = _js(key='other')
    assert dyn is not other
    assert type(dyn)._instance is dyn and type(other)._instance is other
    # 孙子类自身无 _instance → 命中父类单例（继承链会串源）
    class _GrandChild(_HandWritten):
        pass

    assert _GrandChild() is first
    # 但 JsSpider 的直接子类之间不共享：各自 __new__ 先见自己的空 _instance
    class _Sibling(js_spider.JsSpider):
        engine = _FakeEngine()

    assert _Sibling() is not first


# ==================================================================
# 第二节：cms_spider —— 内容 API 分发 / 结果归一化 / 分页
# ==================================================================

def test_cms_home_dispatches_class_then_first_category():
    """homeContent 固定两跳：ac=class 取分类，再用首个分类拉 ac=videolist&pg=1。"""
    spider = _cms([{'class': [{'type_id': '6', 'type_name': '动漫'},
                              {'type_id': '7', 'type_name': '综艺'}],
                    'filters': {'area': ['日本']}},
                   {'list': [{'vod_id': 1, 'vod_name': '番剧A'}]}])
    out = spider.homeContent(True)
    assert spider._calls == [{'ac': 'class'},
                             {'ac': 'videolist', 't': '6', 'pg': '1'}]
    assert out['class'] == [{'type_id': '6', 'type_name': '动漫'},
                            {'type_id': '7', 'type_name': '综艺'}]
    assert out['filters'] == {'area': ['日本']}
    assert out['list'] == [{'vod_id': '1', 'vod_name': '番剧A',
                            'vod_pic': '', 'vod_remarks': ''}]


def test_cms_home_drops_blank_type_id_and_honors_filter_flag():
    """分类过滤：type_id 为空串/None/缺失的分类被剔除；filter=False 不吃 filters。"""
    spider = _cms([{'class': [{'type_id': '', 'type_name': '空'},
                              {'type_id': None, 'type_name': '空None'},
                              {'type_name': '无id字段'},
                              {'type_id': '0', 'type_name': '零'}],
                    'filters': {'y': 1}, 'filter': {'f': 2}},
                   {'list': []}])
    out = spider.homeContent(True)
    assert out['class'] == [{'type_id': '0', 'type_name': '零'}], out['class']
    assert out['filters'] == {'y': 1}
    assert spider.filter == {'y': 1}
    # filter=False：filters 不进结果，实例 filter 也不写
    spider2 = _cms([{'class': [{'type_id': '1', 'type_name': '电影'}],
                     'filters': {'y': 1}, 'filter': {'f': 2}},
                    {'list': []}])
    out2 = spider2.homeContent(False)
    assert out2['filters'] == {}
    assert spider2.filter == {}


def test_cms_home_falls_back_to_filter_key_when_no_filters():
    """源只给 'filter'（单数）时也采纳；两者都无则 filters 为空 dict。"""
    spider = _cms([{'class': [{'type_id': '1', 'type_name': '电影'}],
                    'filter': {'plot': ['剧情']}},
                   {'list': []}])
    out = spider.homeContent(True)
    assert out['filters'] == {'plot': ['剧情']}
    spider2 = _cms([{'class': [{'type_id': '1', 'type_name': '电影'}]}, {'list': []}])
    assert spider2.homeContent(True)['filters'] == {}


def test_cms_home_without_classes_skips_second_hop():
    """分类为空时不再发 videolist 请求（无类型可拉）。"""
    spider = _cms([{'class': []}])
    out = spider.homeContent(True)
    assert out == {'class': [], 'list': [], 'filters': {}}
    assert spider._calls == [{'ac': 'class'}]


def test_cms_home_second_hop_failure_is_swallowed():
    """首屏列表拉取失败被 logger.debug 吞掉，class 仍返回（不影响分类渲染）。"""
    spider = cms_spider.CmsSpider('k', 'http://cms.test/api.php')
    class_payload = {'class': [{'type_id': '1', 'type_name': '电影'}]}
    seen = []

    def _fetch(params):
        seen.append(dict(params))
        if params.get('ac') == 'videolist':
            raise ValueError('[L3:cms] cms fetch failed: boom')
        return class_payload

    spider._fetch = _fetch
    out = spider.homeContent(False)
    assert out['class'] == [{'type_id': '1', 'type_name': '电影'}]
    assert out['list'] == []
    assert seen == [{'ac': 'class'}, {'ac': 'videolist', 't': '1', 'pg': '1'}]


def test_cms_category_merges_truthy_extend_params():
    """分类页：extend 中真值键并入查询参数并强转 str；假值键被丢弃。"""
    spider = _cms([{'list': [], 'page': '2', 'pagecount': '8', 'limit': '30', 'total': '220'}])
    out = spider.categoryContent('喜剧', 3, True, {'class': '剧情', 'area': '',
                                                   'lang': '国语', 'n': 0})
    assert spider._calls == [{'ac': 'videolist', 't': '喜剧', 'pg': '3',
                              'class': '剧情', 'lang': '国语'}]
    assert out['page'] == 2 and out['pagecount'] == 8
    assert out['limit'] == 30 and out['total'] == 220


def test_cms_category_pagination_defaults_and_illegal_values():
    """分页字段：缺失回落 pg/1/20/0；非法数字串直接 ValueError（不做静默兜底）。"""
    spider = _cms([{}])
    out = spider.categoryContent('1', '4', False, None)
    assert out == {'page': 4, 'pagecount': 0, 'limit': 20, 'total': 0, 'list': []}
    # 0 / 空串 走 `or` 短路 → 默认值
    spider = _cms([{'page': 0, 'pagecount': '', 'limit': None, 'total': '0'}])
    out = spider.categoryContent('1', '1', False, None)
    assert out['page'] == 1 and out['pagecount'] == 0
    assert out['limit'] == 20 and out['total'] == 0
    # 非数字串：int() 抛 ValueError（现状，见报告）
    spider = _cms([{'page': 'abc'}])
    try:
        spider.categoryContent('1', '1', False, None)
    except ValueError:
        pass
    else:
        assert False, '非数字分页字段必须抛 ValueError'


def test_cms_home_video_content_pagination_and_pg_passthrough():
    """homeVideoContent 不带分类 t，pg 参与 page 默认值计算。"""
    spider = _cms([{'list': [{'vod_id': '9', 'vod_name': 'n'}], 'page': '5',
                    'pagecount': '9', 'limit': '40', 'total': '360'}])
    out = spider.homeVideoContent('5')
    assert spider._calls == [{'ac': 'videolist', 'pg': '5'}]
    assert out['page'] == 5 and out['pagecount'] == 9
    assert out['limit'] == 40 and out['total'] == 360
    assert out['list'][0]['vod_id'] == '9'
    # 空响应：默认值
    spider = _cms([{}])
    assert spider.homeVideoContent() == {'page': 1, 'pagecount': 0, 'limit': 20,
                                         'total': 0, 'list': []}


def test_cms_detail_joins_ids_and_takes_only_first_row():
    """详情：ids 列表转 str 逗号拼接；只回第一条（TVBox 详情单条语义）。"""
    spider = _cms([{'list': [{'vod_id': 5, 'vod_name': 'A', 'vod_play_from': 'm3u8',
                              'vod_play_url': '第1集$u1'},
                             {'vod_id': 6, 'vod_name': 'B'}]}])
    out = spider.detailContent([5, 6])
    assert spider._calls == [{'ac': 'videolist', 'ids': '5,6'}]
    assert len(out['list']) == 1
    assert out['list'][0]['vod_id'] == '5'
    assert out['list'][0]['vod_play_url'] == '第1集$u1'
    # 空 list / 缺 list 键
    assert _cms([{'list': []}]).detailContent(['5']) == {'list': []}
    assert _cms([{}]).detailContent('5') == {'list': []}


def test_cms_detail_accepts_scalar_id_and_tuple():
    """ids 也接受标量字符串与 tuple（JSON 源 int、XML 源 str 混用）。"""
    spider = _cms([{'list': [{'vod_id': '7'}]}])
    assert spider.detailContent('7')['list'][0]['vod_id'] == '7'
    assert spider._calls == [{'ac': 'videolist', 'ids': '7'}]
    spider2 = _cms([{'list': [{'vod_id': '8'}]}])
    spider2.detailContent(('8', '9'))
    assert spider2._calls == [{'ac': 'videolist', 'ids': '8,9'}]


def test_cms_search_dispatches_wd_and_pg():
    """搜索：参数键是 wd（不是 word/keyword），pg 强转 str。"""
    spider = _cms([{'list': [{'vod_id': '1', 'vod_name': '海贼王'}]}])
    out = spider.searchContent('海贼王', '0', 3)
    assert spider._calls == [{'wd': '海贼王', 'pg': '3'}]
    assert out['list'][0]['vod_name'] == '海贼王'


def test_cms_vod_short_field_mapping_and_defaults():
    """_vod_short：只留 4 个字段，vod_id 强转 str，缺字段补空串。"""
    out = cms_spider.CmsSpider._vod_short({'vod_id': 12, 'vod_name': 'n',
                                           'vod_pic': 'p', 'vod_remarks': 'R',
                                           'vod_content': 'ignored', 'type_id': 9})
    assert out == {'vod_id': '12', 'vod_name': 'n', 'vod_pic': 'p', 'vod_remarks': 'R'}
    assert cms_spider.CmsSpider._vod_short({}) == {
        'vod_id': '', 'vod_name': '', 'vod_pic': '', 'vod_remarks': ''}


def test_cms_vod_short_type_coercion_and_note_alias():
    """_vod_short 类型强转与 vod_note 别名：vod_id 为 None 会变成字符串 'None'。"""
    out = cms_spider.CmsSpider._vod_short({'vod_id': None, 'vod_name': 123,
                                           'vod_remarks': '', 'vod_note': '备注'})
    assert out['vod_id'] == 'None'
    assert out['vod_name'] == 123, 'vod_name 不做 str 强转'
    assert out['vod_remarks'] == '备注'
    # vod_remarks 非空时 vod_note 不覆盖
    out2 = cms_spider.CmsSpider._vod_short({'vod_remarks': '主', 'vod_note': '备'})
    assert out2['vod_remarks'] == '主'


def test_cms_vod_full_keeps_only_truthy_optional_fields():
    """_vod_full：可选字段仅真值才带出（0/''/None 全部裁掉），vod_tag 也算可选。"""
    out = cms_spider.CmsSpider._vod_full({
        'vod_id': 1, 'vod_name': 'n', 'vod_pic': 'p', 'vod_remarks': '',
        'type_id': 3, 'type_name': '电影', 'vod_year': '2024',
        'vod_area': '', 'vod_lang': None, 'vod_actor': '张三',
        'vod_director': 0, 'vod_content': '简介', 'vod_tag': '剧情',
        'vod_play_from': 'f', 'vod_play_url': 'u', 'junk': 'x'})
    assert out['vod_id'] == '1'
    assert out['type_id'] == 3 and out['type_name'] == '电影'
    assert out['vod_year'] == '2024' and out['vod_actor'] == '张三'
    assert out['vod_content'] == '简介' and out['vod_tag'] == '剧情'
    assert out['vod_play_from'] == 'f' and out['vod_play_url'] == 'u'
    assert 'vod_area' not in out and 'vod_lang' not in out
    assert 'vod_director' not in out, '0 视为假值被裁掉'
    assert 'junk' not in out


def test_cms_vod_full_dl_legacy_fallback():
    """_vod_full 兼容旧 dl 字段：无 vod_play_url 但有 dl 时补上。"""
    out = cms_spider.CmsSpider._vod_full({'vod_id': '1', 'vod_name': 'n', 'dl': 'D1'})
    assert out['vod_play_url'] == 'D1'
    # 已有 vod_play_url 时不覆盖
    out2 = cms_spider.CmsSpider._vod_full({'vod_id': '1', 'vod_name': 'n',
                                           'vod_play_url': 'U', 'dl': 'D1'})
    assert out2['vod_play_url'] == 'U'


def test_cms_normalization_does_not_dedupe_or_drop_blank_names():
    """白盒事实：本层不做去重也不剔除空名条目（去重在 server._search_source_pages）。"""
    spider = _cms([{'list': [{'vod_id': '1', 'vod_name': 'dup'},
                             {'vod_id': '1', 'vod_name': 'dup'},
                             {'vod_id': '2', 'vod_name': ''},
                             {'vod_id': '3'}]}])
    out = spider.searchContent('k', '0', '1')
    assert len(out['list']) == 4
    assert [v['vod_id'] for v in out['list']] == ['1', '1', '2', '3']
    assert out['list'][2]['vod_name'] == ''
    assert 'vod_name' not in out['list'][3] or out['list'][3]['vod_name'] == ''
    # 空列表与缺 list 键都得到空列表
    assert _cms([{'list': []}]).searchContent('k', '0')['list'] == []
    assert _cms([{}]).searchContent('k', '0')['list'] == []


def test_cms_normalization_ignores_non_vod_items_gracefully():
    """上游塞进非 dict 条目时按 .get 语义失败即抛（白盒：无 try/except 包裹）。"""
    spider = _cms([{'list': [{'vod_id': '1'}, 'not-a-dict']}])
    try:
        spider.searchContent('k', '0')
    except AttributeError:
        pass
    else:
        assert False, '非 dict 条目应抛 AttributeError（当前无逐条容错）'
    # 全 dict 正常路径不受影响
    assert len(_cms([{'list': [{'vod_id': '1'}]}]).searchContent('k', '0')['list']) == 1


def test_cms_player_content_direct_link_detection():
    """playerContent：可播后缀 → parse=0；网页后缀/无后缀 → parse=1。"""
    spider = cms_spider.CmsSpider('k', 'http://api/x')
    for url in ('http://a/b.m3u8', 'http://a/b.mp4?token=1', 'http://a/b.flv',
                'http://a/b.mkv', 'http://a/b.avi', 'http://a/b.ts'):
        assert spider.playerContent('f', url, [])['parse'] == 0, url
    for url in ('http://a/x.html', 'http://a/x.htm', 'http://a/x.shtml',
                'http://a/x.php', 'http://a/x.jsp', 'http://a/x.asp',
                'http://a/x.aspx', 'http://a/x', ''):
        assert spider.playerContent('f', url, [])['parse'] == 1, url


def test_cms_player_content_strips_and_lowercases_query_only():
    """playerContent 只 strip 首尾空白 + 去 query 后判后缀；原串原样回传 url。"""
    spider = cms_spider.CmsSpider('k', 'http://api/x')
    out = spider.playerContent('f', '  http://a/b.M3U8?x=1  ', [])
    assert out['url'] == 'http://a/b.M3U8?x=1', 'url 保留原始大小写与 query'
    assert out['parse'] == 0
    # fragment 也算路径的一部分 → 非可播后缀
    assert spider.playerContent('f', 'http://a/b.m3u8#frag', [])['parse'] == 1
    # header 恒为 UA 的 JSON 串
    assert out['playUrl'] == ''
    assert json.loads(out['header']) == cms_spider.UA
    assert out['header'] == UA_JSON


def test_cms_player_content_html_mask_wins_over_playable():
    """HTML 伪装（.html 结尾）即使同时满足可播判定也必须是 parse=1。"""
    spider = cms_spider.CmsSpider('k', 'http://api/x')
    # 路径以 .html 结尾的即便含 .m3u8 字样也不当直链
    assert spider.playerContent('f', 'http://a/play.m3u8.html', [])['parse'] == 1
    assert spider.playerContent('f', 'http://a/index.php?u=1.m3u8', [])['parse'] == 1


def test_cms_is_video_format_matches_player_content_parse_zero():
    """isVideoFormat 与 playerContent 的直链判定同源：互为 parse==0 的等价。"""
    spider = cms_spider.CmsSpider('k', 'http://api/x')
    for url in ('a.m3u8', 'A.MP4', 'http://a/b.TS', '  http://a/x.mkv  ',
                'http://a/b.m3u8?k=1'):
        assert spider.isVideoFormat(url) is True, url
        assert spider.playerContent('f', url, [])['parse'] == 0, url
    for url in ('a.php', 'http://a/b.html', 'http://a/x.jsp?v=1', '', 'a.txt'):
        assert spider.isVideoFormat(url) is False, url
        assert spider.playerContent('f', url, [])['parse'] == 1, url


def test_cms_no_op_contract_methods():
    """CMS 不支持的动作返回契约空值：init/localProxy/action/destroy/manualVideoCheck。"""
    spider = cms_spider.CmsSpider('k', 'http://api/x')
    assert spider.init('ext') is None
    assert spider.localProxy({'a': 1}) is None
    assert spider.action('anything') == {}
    assert spider.destroy() is None
    assert spider.manualVideoCheck() is False
    assert spider.filter == {}
    assert spider.stype == 1
    assert spider.getName() == 'k', 'name 缺省回落 key'


def test_cms_constructor_normalizes_stype_and_name():
    """构造：stype 强转 int；name 为空回落 key；非法 stype 直接 ValueError。"""
    assert cms_spider.CmsSpider('k', 'u', stype='0').stype == 0
    assert cms_spider.CmsSpider('k', 'u', stype=1.0).stype == 1
    assert cms_spider.CmsSpider('k', 'u', name='名字').getName() == '名字'
    assert cms_spider.CmsSpider('k2', 'u').getName() == 'k2'
    try:
        cms_spider.CmsSpider('k', 'u', stype='x')
    except ValueError:
        pass
    else:
        assert False, '非法 stype 应抛 ValueError'


# ==================================================================
# 第三节：cms_spider —— _fetch 分派 / XML 解析
# ==================================================================

def test_cms_fetch_dispatches_json_xml_and_raises_on_plain_text():
    """_fetch：'{/[ ' 走 JSON，'< ' 走 XML，其余非空文本抛 L3 兜底。"""
    spider = cms_spider.CmsSpider('k', 'http://cms.test/api.php')
    with mock.patch.object(cms_spider.http_client, 'fetch_follow_redirects',
                           return_value=_FakeRsp('{"list":[]}')) as fh:
        assert spider._fetch({'ac': 'class'}) == {'list': []}
        args, kw = fh.call_args
        assert args[0] == 'http://cms.test/api.php'
        assert kw['params'] == {'ac': 'class'}
        assert kw['trust_root'] == 'http://cms.test/api.php'
        assert kw['timeout'] == 15
        assert kw['headers'] == cms_spider.UA
    with mock.patch.object(cms_spider.http_client, 'fetch_follow_redirects',
                           return_value=_FakeRsp('<rss><list/></rss>')):
        assert spider._fetch({}) == {'class': [], 'list': []}
    with mock.patch.object(cms_spider.http_client, 'fetch_follow_redirects',
                           return_value=_FakeRsp('请开启JavaScript')):
        try:
            spider._fetch({})
        except ValueError as e:
            assert 'unexpected response' in str(e)
        else:
            assert False, '挑战页必须抛 ValueError'


def test_cms_fetch_empty_body_is_unexpected_response():
    """空响应体既不是 JSON 也不是 XML，走 unexpected response 分支。"""
    spider = cms_spider.CmsSpider('k', 'http://cms.test/api.php')
    with mock.patch.object(cms_spider.http_client, 'fetch_follow_redirects',
                           return_value=_FakeRsp('   ')):
        try:
            spider._fetch({})
        except ValueError as e:
            assert str(e) == '[L3:cms] unexpected response: (...)'
        else:
            assert False, '空响应必须抛 ValueError'


def test_cms_fetch_json_decode_error_is_wrapped_as_l3():
    """JSON 语法错误包装成 [L3:cms] cms json decode error（不重试）。"""
    spider = cms_spider.CmsSpider('k', 'http://cms.test/api.php')
    with mock.patch.object(cms_spider.http_client, 'fetch_follow_redirects',
                           return_value=_FakeRsp('{oops')) as fh:
        try:
            spider._fetch({})
        except ValueError as e:
            assert str(e).startswith('[L3:cms] cms json decode error:')
        else:
            assert False, '坏 JSON 必须抛 ValueError'
        assert fh.call_count == 1, '解析错误不重试'


def test_cms_fetch_xml_parse_error_is_wrapped_as_l3():
    """畸形 XML 包装成 [L3:cms] cms xml parse error（不重试）。"""
    spider = cms_spider.CmsSpider('k', 'http://cms.test/api.php')
    with mock.patch.object(cms_spider.http_client, 'fetch_follow_redirects',
                           return_value=_FakeRsp('<rss><list>')) as fh:
        try:
            spider._fetch({})
        except ValueError as e:
            assert str(e).startswith('[L3:cms] cms xml parse error:')
        else:
            assert False, '畸形 XML 必须抛 ValueError'
        assert fh.call_count == 1


def test_cms_fetch_retries_once_on_transient_error():
    """连接类瞬时错误退避重试一次：第二次成功即返回，只 sleep 一次。

    白盒细节：``time`` 是在函数体内 ``import time`` 的（模块级没有该名字），
    所以打桩必须 patch 全局 ``time.sleep`` 而非 ``cms_spider.time.sleep``。
    """
    spider = cms_spider.CmsSpider('k', 'http://cms.test/api.php')
    responses = [ConnectionResetError('reset'), _FakeRsp('{"ok":1}')]
    with mock.patch.object(cms_spider.http_client, 'fetch_follow_redirects',
                           side_effect=responses) as fh, \
            mock.patch('time.sleep') as sl:
        assert spider._fetch({}) == {'ok': 1}
        assert fh.call_count == 2
        assert sl.call_args[0][0] == 0.8
    assert not hasattr(cms_spider, 'time'), 'time 是函数内局部导入（白盒事实）'


def test_cms_fetch_gives_up_after_second_failure():
    """两次都失败：抛出带 L3 前缀的 ValueError 并保留原始异常（__cause__）。"""
    spider = cms_spider.CmsSpider('k', 'http://cms.test/api.php')
    with mock.patch.object(cms_spider.http_client, 'fetch_follow_redirects',
                           side_effect=TimeoutError('read timeout')), \
            mock.patch('time.sleep'):
        try:
            spider._fetch({})
        except ValueError as e:
            assert '[L3:cms] cms fetch failed' in str(e)
            assert isinstance(e.__cause__, TimeoutError)
        else:
            assert False, '连续失败必须抛 ValueError'


def test_cms_fetch_uses_apparent_encoding():
    """编码回退：rsp.encoding 被设为 apparent_encoding，缺省 utf-8。"""
    spider = cms_spider.CmsSpider('k', 'http://cms.test/api.php')
    rsp = _FakeRsp('{"vod_name":"中文"}', apparent='gbk')
    with mock.patch.object(cms_spider.http_client, 'fetch_follow_redirects',
                           return_value=rsp):
        spider._fetch({})
    assert rsp.encoding == 'gbk'
    rsp2 = _FakeRsp('{"a":1}', apparent=None)
    with mock.patch.object(cms_spider.http_client, 'fetch_follow_redirects',
                           return_value=rsp2):
        spider._fetch({})
    assert rsp2.encoding == 'utf-8'


def test_cms_parse_xml_full_field_mapping():
    """XML <video> → vod_* 映射：标签无 vod_ 前缀，note 优先于 state。"""
    doc = ('<?xml version="1.0"?><rss>'
           '<page>2</page><pagecount>7</pagecount><limit>15</limit><total>105</total>'
           '<class><ty id="1">电影</ty><ty id="2">  剧集  </ty></class>'
           '<list><video>'
           '<id>10</id><tid>1</tid><name>测试影片</name><type>电影</type>'
           '<pic>http://p/1.jpg</pic><note>更新至8集</note><state>备用态</state>'
           '<year>2024</year><area>中国</area><lang>国语</lang>'
           '<actor>张三</actor><director>李四</director><des>简介</des>'
           '</video></list></rss>')
    data = cms_spider.CmsSpider.__new__(cms_spider.CmsSpider)._parse_xml(doc)
    v = data['list'][0]
    assert v['vod_id'] == '10' and v['type_id'] == '1'
    assert v['vod_name'] == '测试影片' and v['type_name'] == '电影'
    assert v['vod_pic'] == 'http://p/1.jpg'
    assert v['vod_remarks'] == '更新至8集', 'note 优先'
    assert v['vod_year'] == '2024' and v['vod_area'] == '中国'
    assert v['vod_lang'] == '国语' and v['vod_actor'] == '张三'
    assert v['vod_director'] == '李四' and v['vod_content'] == '简介'
    assert data['page'] == '2' and data['pagecount'] == '7'
    assert data['limit'] == '15' and data['total'] == '105'
    assert data['class'] == [{'type_id': '1', 'type_name': '电影'},
                             {'type_id': '2', 'type_name': '剧集'}], 'type_name 去空白'


def test_cms_parse_xml_note_falls_back_to_state():
    """note 为空/缺失时 vod_remarks 回落到 state。"""
    head = '<?xml version="1.0"?><rss><list><video><name>n</name>'
    p = cms_spider.CmsSpider.__new__(cms_spider.CmsSpider)._parse_xml
    assert p(head + '<note></note><state>STATE</state></video></list></rss>')[
        'list'][0]['vod_remarks'] == 'STATE'
    assert p(head + '<state>STATE</state></video></list></rss>')[
        'list'][0]['vod_remarks'] == 'STATE'
    assert p(head + '</video></list></rss>')['list'][0]['vod_remarks'] == ''


def test_cms_parse_xml_play_source_joins_lines_with_dollar3():
    """播放源：<dl><dd flag> 用 $$$ 拼线路，集内用 #，集名与 URL 用 $。"""
    doc = ('<?xml version="1.0"?><rss><list><video><name>n</name><dl>'
           '<dd flag="m3u8">第1集$http://a/1.m3u8#第2集$http://a/2.m3u8</dd>'
           '<dd flag="hd">高清$http://a/h.m3u8</dd>'
           '<dd>无flag$d</dd></dl></video>'
           '<video><name>无dl</name></video></list></rss>')
    vods = cms_spider.CmsSpider.__new__(cms_spider.CmsSpider)._parse_xml(doc)['list']
    assert vods[0]['vod_play_from'] == 'm3u8$$$hd$$$'
    assert vods[0]['vod_play_url'] == \
        '第1集$http://a/1.m3u8#第2集$http://a/2.m3u8$$$高清$http://a/h.m3u8$$$无flag$d'
    assert 'vod_play_url' not in vods[1], '无 <dl> 的 video 不带播放源字段'


def test_cms_parse_xml_empty_dl_and_missing_pagination():
    """<dl> 存在但无 <dd> 时不写播放源；空文本/缺失的分页节点被跳过。"""
    p = cms_spider.CmsSpider.__new__(cms_spider.CmsSpider)._parse_xml
    v = p('<?xml version="1.0"?><rss><list><video><name>n</name>'
          '<dl></dl></video></list></rss>')['list'][0]
    assert 'vod_play_url' not in v and 'vod_play_from' not in v
    # page/pagecount 空文本或自闭合 → 不入 data（判据是 node.text 的真值）
    data = p('<?xml version="1.0"?><rss><page></page><pagecount/></rss>')
    assert data == {'class': [], 'list': []}
    # 纯空白文本 node.text 为真值 → 照样入 data（现状）
    assert p('<rss><limit>  </limit></rss>')['limit'] == '  '
    # <list> 存在但无 <video> → list 为空数组
    assert p('<rss><list></list></rss>')['list'] == []


def test_cms_parse_xml_entity_escaping_is_unescaped():
    """实体转义（&amp;/&lt;/&gt;）由 ElementTree 解成原字符；CDATA 保留原文。"""
    p = cms_spider.CmsSpider.__new__(cms_spider.CmsSpider)._parse_xml
    v = p('<?xml version="1.0"?><rss><list><video>'
          '<name>a &amp; b &lt;c&gt; &quot;d&quot;</name></video></list></rss>')['list'][0]
    assert v['vod_name'] == 'a & b <c> "d"'
    v2 = p('<?xml version="1.0"?><rss><list><video>'
           '<name><![CDATA[含 & <特殊> 字符]]></name></video></list></rss>')['list'][0]
    assert v2['vod_name'] == '含 & <特殊> 字符'


def test_cms_parse_xml_empty_and_malformed_documents():
    """空文档（无子节点）→ 空结构；真正畸形（无根/未闭合）→ 抛异常。"""
    p = cms_spider.CmsSpider.__new__(cms_spider.CmsSpider)._parse_xml
    assert p('<rss></rss>') == {'class': [], 'list': []}
    assert p('<rss><class/><list/></rss>') == {'class': [], 'list': []}
    for bad in ('', 'not xml at all', '<rss><list>', '<a></b>'):
        try:
            p(bad)
        except Exception as e:
            assert not isinstance(e, SystemExit)
        else:
            assert False, '畸形文档 %r 必须抛异常' % bad


def test_cms_parse_xml_doctype_rejected_before_parse():
    """L-24：带 DOCTYPE/ENTITY 的文档在解析前就被拒（billion-laughs 防护）。"""
    p = cms_spider.CmsSpider.__new__(cms_spider.CmsSpider)._parse_xml
    try:
        p('<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY e "x">]>'
          '<rss><list><video><name>&e;</name></video></list></rss>')
    except ValueError as e:
        assert 'suspicious XML rejected' in str(e)
    else:
        assert False, 'DOCTYPE 文档必须被拒'


def test_cms_parse_xml_entity_beyond_head_window_is_not_rejected():
    """白盒边界：DOCTYPE/ENTITY 检测窗口是前 4096 字符，窗口之外的声明不被拦。

    窗口内的 `<!ENTITY` 会被拒（见 test_cms_parse_xml_doctype_rejected_before_parse），
    窗口外则直接交给 ElementTree —— 那种文档本身也不是合法 XML，抛 ParseError。
    """
    from xml.etree import ElementTree as ET
    p = cms_spider.CmsSpider.__new__(cms_spider.CmsSpider)._parse_xml
    pad = '<pad>' + 'x' * 5000 + '</pad>'
    try:
        p('<?xml version="1.0"?><rss>' + pad + '<!ENTITY x "y"><list/></rss>')
    except ET.ParseError:
        pass        # 窗口外不拦（现状），由 ElementTree 自己报语法错
    except ValueError as e:
        assert 'suspicious XML rejected' not in str(e), '窗口外不得走安全拦截'
    else:
        assert False, '畸形 XML 应抛 ParseError'
    # 窗口内（<4096）的 ENTITY 一定被拦
    try:
        p('<?xml version="1.0"?><rss>' + 'x' * 100 + '<!ENTITY x "y"><list/></rss>')
    except ValueError as e:
        assert 'suspicious XML rejected' in str(e)
    else:
        assert False, '窗口内 ENTITY 必须被拒'


# ==================================================================
# 第四节：play —— 多集拆分（CMS 播放源串的消费者语义）
# ==================================================================

def _split_episodes(raw):
    """按 CMS/TVBox 约定拆播放源串：'$$$' 分线路、'#' 分集、'集名$url'。

    与 spike/jvm_android_shim_adapter._derive_player_request 同口径，
    不含 $ 或无 URL 的片段直接跳过。
    """
    out = []
    for line_index, playlist in enumerate(str(raw or '').split('$$$')):
        for episode in playlist.split('#'):
            name, sep, url = episode.partition('$')
            if not sep:
                continue
            url = url.strip()
            if not url:
                continue
            out.append({'line': line_index, 'name': name.strip(), 'url': url})
    return out


def test_play_split_multi_line_and_multi_episode():
    """$$$ 分线路、# 分集：线路序号与集名都要正确提取。"""
    eps = _split_episodes(
        '第1集$http://a/1.m3u8#第2集$http://a/2.m3u8$$$高清$http://a/h.m3u8')
    assert eps == [
        {'line': 0, 'name': '第1集', 'url': 'http://a/1.m3u8'},
        {'line': 0, 'name': '第2集', 'url': 'http://a/2.m3u8'},
        {'line': 1, 'name': '高清', 'url': 'http://a/h.m3u8'},
    ]


def test_play_split_newline_is_not_an_episode_separator():
    """多行串：换行不是集分隔符（只有 # 才是），整块落在一集里。"""
    eps = _split_episodes('第1集$http://a/1.m3u8\n第2集$http://a/2.m3u8')
    assert len(eps) == 1
    assert eps[0]['name'] == '第1集'
    assert 'http://a/2.m3u8' in eps[0]['url'], '换行未被切开'


def test_play_split_empty_and_missing_separator():
    """空串 / 无 $ 分隔符 → 空结果集（不产生幽灵集）。"""
    assert _split_episodes('') == []
    assert _split_episodes(None) == []
    assert _split_episodes('no-separator') == []
    assert _split_episodes('第1集') == []


def test_play_split_skips_blank_url_but_keeps_split_on_first_dollar():
    """空 URL 片段跳过；URL 里再出现 $ 不被二次切分（只在第一个 $ 处切）。"""
    eps = _split_episodes('第1集$#第2集$http://a/2')
    assert eps == [{'line': 0, 'name': '第2集', 'url': 'http://a/2'}]
    eps2 = _split_episodes('a$b$c')
    assert eps2 == [{'line': 0, 'name': 'a', 'url': 'b$c'}]


def test_play_split_very_long_episode_name_survives():
    """超长集名（>1000 字符）不被截断，URL 仍能正确取出。"""
    name = '超长' * 1000
    eps = _split_episodes(name + '$http://a/1.m3u8')
    assert len(eps) == 1
    assert eps[0]['name'] == name and len(eps[0]['name']) == 2000
    assert eps[0]['url'] == 'http://a/1.m3u8'


def test_play_split_marks_ad_segments():
    """含广告特征的集 URL 被标记（复用 ad_filter.AD_PATH_RE 的同源判据）。"""
    from ad_filter import AD_PATH_RE
    eps = _split_episodes(
        '第1集$http://cdn/vod/1.ts#广告$http://cdn/ad/000.ts'
        '#第2集$http://cdn/vod/2.ts')
    assert len(eps) == 3
    marked = [e for e in eps if AD_PATH_RE.search(e['url'])]
    assert len(marked) == 1, marked
    assert marked[0]['name'] == '广告'
    # 正片路径 /ad-01.ts 这种连字符形态不得误标
    assert not AD_PATH_RE.search('http://cdn/video/ad-01.ts')


def test_play_split_three_lines_mismatch_with_flags():
    """线路数少于播放串段数时，多余的段仍带自己的序号（调用方按 index 取 flag）。"""
    eps = _split_episodes('a$u1$$$b$u2$$$c$u3$$$d$u4')
    assert [e['line'] for e in eps] == [0, 1, 2, 3]
    flags = 'x$$$y'.split('$$$')
    assert len(flags) < len({e['line'] for e in eps}), 'flag 与线路可能不等长'


# ==================================================================
# 第五节：base/spider —— 抽象契约与默认实现
# ==================================================================

def test_base_only_init_is_abstract():
    """抽象契约：只有 init 是 @abstractmethod，其余全是空实现（返回 None）。"""
    assert base_spider.Spider.__abstractmethods__ == frozenset({'init'})

    class _NoInit(base_spider.Spider):
        pass

    try:
        _NoInit()
    except TypeError as e:
        assert 'init' in str(e)
    else:
        assert False, '缺 init 的子类必须无法实例化'

    class _WithInit(base_spider.Spider):
        def init(self, extend=''):
            self.extend = extend

    assert _WithInit() is not None


def test_base_default_methods_all_return_none():
    """默认实现是空 pass：内容 API 全返回 None（不是 NotImplementedError）。"""
    spider = _BaseSpider()
    assert spider.homeContent(True) is None
    assert spider.homeVideoContent() is None
    assert spider.categoryContent('1', '1', False, {}) is None
    assert spider.detailContent(['1']) is None
    assert spider.searchContent('k', '0') is None
    assert spider.playerContent('f', 'i', []) is None
    assert spider.liveContent('u') is None
    assert spider.localProxy({'a': 1}) is None
    assert spider.isVideoFormat('u') is None
    assert spider.manualVideoCheck() is None
    assert spider.action('a') is None
    assert spider.destroy() is None
    assert spider.getName() is None


def test_base_get_dependence_returns_fresh_empty_list():
    """getDependence 默认返回空列表，且每次都是新对象（无共享可变默认陷阱）。"""
    spider = _BaseSpider()
    first = spider.getDependence()
    second = spider.getDependence()
    assert first == [] and second == []
    assert first is not second


def test_base_singleton_is_per_subclass():
    """__new__ 单例按子类的 _instance 隔离：不同子类各持一个实例。"""
    class _A(base_spider.Spider):
        def init(self, extend=''):
            self.extend = extend

    class _B(base_spider.Spider):
        def init(self, extend=''):
            self.extend = extend

    a1, a2, b1 = _A(), _A(), _B()
    assert a1 is a2
    assert a1 is not b1
    assert '_instance' in _A.__dict__ and '_instance' in _B.__dict__
    assert _A() is a1 and _B() is b1


def test_base_singleton_subclass_of_subclass_shares_parent_instance():
    """白盒陷阱：孙子类自身无 _instance 时复用父类单例（跨层级串源）。"""
    class _Parent(base_spider.Spider):
        def init(self, extend=''):
            self.extend = extend

    parent = _Parent()

    class _Child(_Parent):
        pass

    assert _Child() is parent
    assert '_instance' not in _Child.__dict__


def test_base_init_sets_empty_extend_and_reruns_on_each_construction():
    """__init__ 只写 self.extend = ''；单例复用时 __init__ 仍会重跑（重置状态）。

    白盒事实：``__new__`` 返回既有实例后 Python 仍会对它调用 ``__init__``，
    所以 ``_BaseSpider()`` 第二次调用会把上一次写入的 extend 清回空串——
    子类若在 init() 里放状态，重复构造同样会被清掉。
    """
    spider = _BaseSpider()
    assert spider.extend == ''
    spider.extend = 'dirty'
    again = _BaseSpider()
    assert again is spider, '命中单例'
    assert again.extend == '', '__init__ 在单例上重跑，状态被重置'


def test_base_reg_str_extracts_group_and_defaults_empty():
    """regStr：命中取 group(1)（可指定），未命中返回空串（不是 None）。"""
    spider = _BaseSpider()
    assert spider.regStr(r'id=(\d+)', 'x?id=42&y') == '42'
    assert spider.regStr(r'(\d+)-(\d+)', '10-20', group=2) == '20'
    assert spider.regStr(r'nomatch', 'abc') == ''
    assert spider.regStr(r'(\d+)', 'abc') == ''


def test_base_remove_html_tags_and_clean_text():
    """removeHtmlTags 去 <...> 标签；cleanText 只去 emoji，不动普通中文。"""
    spider = _BaseSpider()
    assert spider.removeHtmlTags('<p>你好</p><br/>世界') == '你好世界'
    assert spider.removeHtmlTags('无标签') == '无标签'
    assert spider.removeHtmlTags('') == ''
    assert spider.cleanText('abc😀def') == 'abcdef'
    assert spider.cleanText('中文🚀与🇦国旗') == '中文与国旗'
    assert spider.cleanText('普通文本') == '普通文本'


def test_base_json_helpers_roundtrip():
    """str2json/json2str 是静态方法：json2str 保持非 ASCII 原字符。"""
    assert _BaseSpider.str2json('{"a":1}') == {'a': 1}
    assert _BaseSpider.json2str({'名字': '值'}) == '{"名字": "值"}'
    assert '\\u540d' not in _BaseSpider.json2str({'名字': '值'}), 'ensure_ascii=False'
    spider = _BaseSpider()
    assert spider.str2json('[1,2]') == [1, 2]
    try:
        spider.str2json('bad')
    except ValueError:
        pass
    else:
        assert False, '坏 JSON 必须抛 ValueError'


def test_base_html_parses_document():
    """html() 返回 lxml Element；畸形片段不抛（lxml 容错）。"""
    spider = _BaseSpider()
    root = spider.html('<html><body><p class="x">文本</p></body></html>')
    assert root is not None
    assert root.xpath('//p/text()') == ['文本']
    assert spider.html('') is None


def test_base_log_prints_json_for_containers_and_plain_for_scalars():
    """log：dict/list 走 JSON 序列化打印，标量直接打印（不额外加引号）。"""
    spider = _BaseSpider()
    import io
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        spider.log({'a': '中'})
        spider.log([1, 'x'])
        spider.log('plain')
        spider.log(42)
    out = buf.getvalue()
    assert '{"a": "中"}' in out
    assert '["1", "x"]' not in out and '[1, "x"]' in out
    assert 'plain' in out and '42' in out


def test_base_get_proxy_url_includes_do_site_key_and_token():
    """getProxyUrl：恒带 do=py，site_key 非空追加 siteKey，有 token 追加 token。"""
    old_port, old_token = hoststate.get_port(), hoststate.get_token()
    try:
        hoststate.configure(port=9978, token='TK')
        class _Sk(base_spider.Spider):
            def init(self, extend=''):
                self.extend = extend
        spider = _Sk()
        url = spider.getProxyUrl()
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        assert url.startswith('http://127.0.0.1:9978/proxy?')
        assert q['do'] == ['py'] and q['token'] == ['TK']
        assert 'siteKey' not in q
        _Sk.site_key = 'sk'
        q2 = urllib.parse.parse_qs(urllib.parse.urlsplit(spider.getProxyUrl()).query)
        assert q2['siteKey'] == ['sk']
        hoststate.configure(port=9978, token='')
        q3 = urllib.parse.parse_qs(urllib.parse.urlsplit(spider.getProxyUrl()).query)
        assert 'token' not in q3, '无 token 时不补参数'
    finally:
        hoststate.configure(port=old_port, token=old_token)
        _Sk.site_key = ''


def test_base_is_host_loopback_only_matches_injected_port():
    """_is_host_loopback：端口必须等于宿主注入端口，且 host 是回环三兄弟。"""
    old = hoststate.get_port()
    try:
        hoststate.configure(port=9978)
        assert base_spider._is_host_loopback('http://127.0.0.1:9978/cache') is True
        assert base_spider._is_host_loopback('http://localhost:9978/proxy') is True
        assert base_spider._is_host_loopback('http://[::1]:9978/proxy') is True
        assert base_spider._is_host_loopback('http://127.0.0.1:1234/x') is False
        assert base_spider._is_host_loopback('http://10.0.0.5:9978/x') is False
        assert base_spider._is_host_loopback('http://127.0.0.1/x') is False
        hoststate.configure(port=0)
        assert base_spider._is_host_loopback('http://127.0.0.1:0/x') is False
        for bad in ('', None, 'not-a-url', 'http://[::1/x'):
            assert base_spider._is_host_loopback(bad) is False
    finally:
        hoststate.configure(port=old)


def test_base_guard_spider_url_exempts_loopback_only():
    """_guard_spider_url：宿主回环通道直放行，其余地址过 http_client._guard_hop。"""
    old = hoststate.get_port()
    try:
        hoststate.configure(port=9978)
        assert base_spider._guard_spider_url('http://127.0.0.1:9978/cache') == \
            'http://127.0.0.1:9978/cache'
        with mock.patch.object(base_spider.http_client, '_guard_hop',
                               return_value='GUARDED') as gh:
            assert base_spider._guard_spider_url('http://evil.test/x') == 'GUARDED'
            assert gh.call_count == 1
            assert gh.call_args[1]['kind'] == 'site'
    finally:
        hoststate.configure(port=old)


def test_base_strict_tls_switch_reads_env_each_call():
    """_strict_tls_required 每次从环境变量重读（1/true/yes 大小写不敏感）。"""
    old = os.environ.get('YUKI_CONFIG_BLOCK_PRIVATE_NETWORK')
    try:
        os.environ.pop('YUKI_CONFIG_BLOCK_PRIVATE_NETWORK', None)
        assert base_spider._strict_tls_required() is False
        for value in ('1', 'true', 'TRUE', 'Yes'):
            os.environ['YUKI_CONFIG_BLOCK_PRIVATE_NETWORK'] = value
            assert base_spider._strict_tls_required() is True, value
        os.environ['YUKI_CONFIG_BLOCK_PRIVATE_NETWORK'] = '0'
        assert base_spider._strict_tls_required() is False
    finally:
        if old is None:
            os.environ.pop('YUKI_CONFIG_BLOCK_PRIVATE_NETWORK', None)
        else:
            os.environ['YUKI_CONFIG_BLOCK_PRIVATE_NETWORK'] = old


def test_base_fetch_manual_redirect_loop_is_guarded_per_hop():
    """allow_redirects=True 走手动跟随：每跳 allow_redirects=False，逐跳过守卫。"""
    spider = _BaseSpider()
    seq = [_FakeRsp('', 302, {'Location': '/b'}), _FakeRsp('', 302, {'Location': '/c'}),
           _FakeRsp('body', 200)]
    with _guard_passthrough(),             mock.patch.object(base_spider.http_client, 'get', side_effect=seq) as gh:
        rsp = spider.fetch('http://x/a')
    assert gh.call_count == 3
    assert [c[0][0] for c in gh.call_args_list] == ['http://x/a', 'http://x/b', 'http://x/c']
    assert all(c[1]['allow_redirects'] is False for c in gh.call_args_list)
    assert rsp.encoding == 'utf-8'
    assert seq[0].closed and seq[1].closed, '中间跳转响应必须被 close'


def test_base_fetch_redirect_cap_is_five_hops():
    """超过 5 跳抛 ValueError('too many redirects (>5)')，只发 6 个请求。"""
    spider = _BaseSpider()
    seq = [_FakeRsp('', 302, {'Location': '/n%d' % i}) for i in range(9)]
    with _guard_passthrough(),             mock.patch.object(base_spider.http_client, 'get', side_effect=seq) as gh:
        try:
            spider.fetch('http://x/a')
        except ValueError as e:
            assert 'too many redirects (>5)' in str(e)
        else:
            assert False, '超过跳转上限必须抛 ValueError'
    assert gh.call_count == 6


def test_base_fetch_stops_on_redirect_without_location():
    """30x 但没有 Location 头：视作终点返回该响应，不再发新请求。"""
    spider = _BaseSpider()
    with _guard_passthrough(), mock.patch.object(base_spider.http_client, 'get',
                                                 return_value=_FakeRsp('', 302, {})) as gh:
        rsp = spider.fetch('http://x/a')
    assert rsp.status_code == 302 and gh.call_count == 1


def test_base_fetch_appends_params_and_forces_utf8():
    """fetch 的 params 手动拼进 URL（? 或 & 取决于 URL 是否已有 query）。"""
    spider = _BaseSpider()
    with _guard_passthrough(), mock.patch.object(base_spider.http_client, 'get',
                                                 return_value=_FakeRsp('t')) as gh:
        spider.fetch('http://x/a', params={'p': '1', 'wd': '中文'})
        assert gh.call_args[0][0].startswith('http://x/a?p=1&wd=')
        spider.fetch('http://x/a?z=0', params={'p': '1'})
        assert gh.call_args[0][0].startswith('http://x/a?z=0&p=1')


def test_base_fetch_no_follow_path_passes_params_to_requests():
    """allow_redirects=False 走 requests 原生分支：params/cookies 原样透传。"""
    spider = _BaseSpider()
    with _guard_passthrough(), mock.patch.object(base_spider.http_client, 'get',
                                                 return_value=_FakeRsp('t')) as gh:
        rsp = spider.fetch('http://x/a', params={'p': 1}, cookies={'c': '1'},
                           allow_redirects=False)
    kw = gh.call_args[1]
    assert kw['params'] == {'p': 1} and kw['cookies'] == {'c': '1'}
    assert kw['allow_redirects'] is False
    assert rsp.encoding == 'utf-8'


def test_base_fetch_strict_mode_forces_verify_true():
    """严格 SSRF 模式下 verify 不得被 spider 关闭（TLS 降级面）。"""
    spider = _BaseSpider()
    old = os.environ.get('YUKI_CONFIG_BLOCK_PRIVATE_NETWORK')
    try:
        os.environ['YUKI_CONFIG_BLOCK_PRIVATE_NETWORK'] = '1'
        with _guard_passthrough(), mock.patch.object(base_spider.http_client, 'get',
                                                      return_value=_FakeRsp('t')) as gh:
            spider.fetch('http://x/a', verify=False, allow_redirects=False)
        assert gh.call_args[1]['verify'] is True
        with _guard_passthrough(), mock.patch.object(base_spider.http_client, 'post',
                                                     return_value=_FakeRsp('t')) as ph:
            spider.post('http://x/a', verify=False)
        assert ph.call_args[1]['verify'] is True
    finally:
        if old is None:
            os.environ.pop('YUKI_CONFIG_BLOCK_PRIVATE_NETWORK', None)
        else:
            os.environ['YUKI_CONFIG_BLOCK_PRIVATE_NETWORK'] = old


def test_base_post_never_follows_redirects():
    """post 恒 allow_redirects=False（30x 由调用方处理），响应 encoding 强制 utf-8。"""
    spider = _BaseSpider()
    with _guard_passthrough(), mock.patch.object(base_spider.http_client, 'post',
                                                 return_value=_FakeRsp('t', 201)) as ph:
        rsp = spider.post('http://x/a', data={'v': '1'}, json=None)
        assert ph.call_args[1]['allow_redirects'] is False
        assert ph.call_args[1]['data'] == {'v': '1'}
        assert rsp.status_code == 201 and rsp.encoding == 'utf-8'


def test_base_get_cache_parses_json_and_honors_expiry():
    """getCache：JSON 对象带 expiresAt 时按时间判过期；未过期返回 dict。"""
    spider = _BaseSpider()
    future = int(time.time()) + 3600
    with mock.patch.object(base_spider.Spider, 'fetch',
                           return_value=_FakeRsp('{"v":1,"expiresAt":%d}' % future)):
        assert spider.getCache('k') == {'v': 1, 'expiresAt': future}
    # 无 expiresAt 视为有效
    with mock.patch.object(base_spider.Spider, 'fetch',
                           return_value=_FakeRsp('{"v":2}')):
        assert spider.getCache('k') == {'v': 2}
    # 已过期：删缓存并返回 None
    with mock.patch.object(base_spider.Spider, 'fetch',
                           return_value=_FakeRsp(
                               '{"v":3,"expiresAt":%d}' % (int(time.time()) - 5))), \
            mock.patch.object(base_spider.Spider, 'delCache') as dc:
        assert spider.getCache('k') is None
        assert dc.call_args[0] == ('k',)


def test_base_get_cache_returns_raw_text_and_empty():
    """getCache：空串→None；纯文本原样返回；JSON 数组也解析。"""
    spider = _BaseSpider()
    for text, expect in (('', None), ('plain-value', 'plain-value'),
                         ('[1,2]', [1, 2])):
        with mock.patch.object(base_spider.Spider, 'fetch',
                               return_value=_FakeRsp(text)):
            assert spider.getCache('k') == expect
    # 形似 JSON（{...} 包住）但语法错误：json.loads 抛 JSONDecodeError。
    # 未闭合的 '{oops' 不满足 endswith('}')，会被当作纯文本原样返回。
    with mock.patch.object(base_spider.Spider, 'fetch',
                           return_value=_FakeRsp('{oops')):
        assert spider.getCache('k') == '{oops'
    with mock.patch.object(base_spider.Spider, 'fetch',
                           return_value=_FakeRsp('{oops}')):
        try:
            spider.getCache('k')
        except ValueError:
            pass
        else:
            assert False, '坏 JSON 缓存值应抛 ValueError'


def test_base_get_cache_url_encodes_key():
    """getCache 的 key 走 quote(safe='')：& = # / 与中文全部转义。"""
    spider = _BaseSpider()
    old = hoststate.get_port()
    try:
        hoststate.configure(port=9978)
        with mock.patch.object(base_spider.Spider, 'fetch',
                               return_value=_FakeRsp('v')) as fh:
            spider.getCache('a b&c=1#d/中文')
        url = fh.call_args[0][0]
        assert url.startswith('http://127.0.0.1:9978/cache?do=get&key=')
        assert 'key=a%20b%26c%3D1%23d%2F%E4%B8%AD%E6%96%87' in url
        assert '&a' not in url.split('key=')[1], '未编码的 & 会被拆成多个参数'
    finally:
        hoststate.configure(port=old)


def test_base_set_cache_serializes_and_posts():
    """setCache：数值转 str，容器 json.dumps，空串也照发；按状态码回 succeed/failed。"""
    spider = _BaseSpider()
    with mock.patch.object(base_spider.Spider, 'post',
                           return_value=_FakeRsp('', 200)) as ph:
        assert spider.setCache('k', 42) == 'succeed'
        assert ph.call_args[1]['data'] == {'value': '42'}
        assert spider.setCache('k', 1.5) == 'succeed'
        assert ph.call_args[1]['data'] == {'value': '1.5'}
        assert spider.setCache('k', {'a': '中'}) == 'succeed'
        assert ph.call_args[1]['data'] == {'value': '{"a": "中"}'}
        assert spider.setCache('k', [1, 2]) == 'succeed'
        assert ph.call_args[1]['data'] == {'value': '[1, 2]'}
        assert spider.setCache('k', '') == 'succeed'
        assert ph.call_args[1]['data'] == {'value': ''}
    with mock.patch.object(base_spider.Spider, 'post',
                           return_value=_FakeRsp('', 500)):
        assert spider.setCache('k', 'x') == 'failed'
    # None/bool 无 len() → TypeError（白盒现状，见报告）
    with mock.patch.object(base_spider.Spider, 'post',
                           return_value=_FakeRsp('', 200)):
        for bad in (None, True):
            try:
                spider.setCache('k', bad)
            except TypeError:
                pass
            else:
                assert False, 'setCache(%r) 应抛 TypeError' % bad


def test_base_del_cache_uses_delete_do_and_status():
    """delCache：do=del，按 200 判定 succeed/failed。"""
    spider = _BaseSpider()
    old = hoststate.get_port()
    try:
        hoststate.configure(port=9978)
        with mock.patch.object(base_spider.Spider, 'fetch',
                               return_value=_FakeRsp('', 200)) as fh:
            assert spider.delCache('k/x') == 'succeed'
            assert fh.call_args[0][0] == 'http://127.0.0.1:9978/cache?do=del&key=k%2Fx'
        with mock.patch.object(base_spider.Spider, 'fetch',
                               return_value=_FakeRsp('', 404)):
            assert spider.delCache('k') == 'failed'
    finally:
        hoststate.configure(port=old)


def test_base_load_module_and_load_spider():
    """loadModule 按 cache_dir/py/<name>.py 加载；loadSpider 取其顶层 Spider 类。"""
    import sys
    import tempfile
    spider = _BaseSpider()
    old = hoststate.get_cache_dir()
    # TemporaryDirectory 包裹整个用例：之前 tempfile.mkdtemp 从不清理，
    # 每次运行泄漏一个目录；SourceFileLoader.load_module() 还会把 'wbmod'
    # 永久注册进 sys.modules，造成跨用例全局状态残留。
    with tempfile.TemporaryDirectory() as tmp:
        try:
            hoststate.configure(cache_dir=tmp)
            os.makedirs(os.path.join(tmp, 'py'), exist_ok=True)
            with open(os.path.join(tmp, 'py', 'wbmod.py'), 'w', encoding='utf-8') as f:
                f.write('VALUE = 42\nclass Spider:\n    def getName(self):\n'
                        '        return "WB"\n')
            module = spider.loadModule('wbmod')
            assert module.VALUE == 42
            inst = spider.loadSpider('wbmod')
            assert inst.getName() == 'WB'
            try:
                spider.loadModule('missing_mod')
            except FileNotFoundError:
                pass
            else:
                assert False, '缺失文件必须抛 FileNotFoundError'
        finally:
            hoststate.configure(cache_dir=old)
            sys.modules.pop('wbmod', None)


# ==================================================================
# 第六节：Runner —— Spider 方法分发与签名预检（跨三模块的调用面）
# ==================================================================

def test_runner_dispatches_every_known_method():
    """Runner 把六个内容方法 + live/action 原样转发给底层 spider 实例。"""
    seen = []

    class _Rec(base_spider.Spider):
        def init(self, extend=''):
            seen.append(('init', extend))

        def homeContent(self, filter):
            seen.append(('home', filter))

        def categoryContent(self, tid, pg, filter, extend):
            seen.append(('cat', tid, pg, filter, extend))

        def detailContent(self, ids):
            seen.append(('detail', ids))

        def searchContent(self, key, quick, pg='1'):
            seen.append(('search', key, quick, pg))

        def playerContent(self, flag, id, vipFlags):
            seen.append(('play', flag, id, vipFlags))

        def liveContent(self, url):
            seen.append(('live', url))

        def action(self, action):
            seen.append(('action', action))

    r = Runner(_Rec())
    r.init('e')
    r.homeContent(True)
    r.categoryContent('1', '2', False, {})
    r.detailContent(['a'])
    r.searchContent('k', '0')
    r.playerContent('f', 'i', [])
    r.liveContent('u')
    r.action('{}')
    assert seen == [('init', 'e'), ('home', True), ('cat', '1', '2', False, {}),
                    ('detail', ['a']), ('search', 'k', '0', '1'),
                    ('play', 'f', 'i', []), ('live', 'u'), ('action', '{}')]


def test_runner_unknown_method_raises_attribute_error():
    """未知方法不做归一化：大小写/空白差异一律 AttributeError（无兜底动作表）。"""
    class _Rec(base_spider.Spider):
        def init(self, extend=''):
            pass

    r = Runner(_Rec())
    for bad in ('homecontent', 'HomeContent', ' homeContent', 'homeContent '):
        try:
            getattr(r, bad)(True)
        except AttributeError:
            pass
        else:
            assert False, '未知方法 %r 必须抛 AttributeError' % bad


def test_runner_home_video_content_signature_precheck():
    """homeVideoContent 按签名参数个数决定带不带 pg（inspect 预检，非 try/except）。"""
    import inspect

    class _NoPg(base_spider.Spider):
        def init(self, extend=''):
            pass

        def homeVideoContent(self):
            return 'no-pg'

    class _WithPg(base_spider.Spider):
        def init(self, extend=''):
            pass

        def homeVideoContent(self, pg='1'):
            return 'pg=%s' % pg

    assert Runner(_NoPg()).homeVideoContent('3') == 'no-pg'
    assert Runner(_WithPg()).homeVideoContent('3') == 'pg=3'
    # CmsSpider 带 pg（2 个参数）；JsSpider / 基类只有 self（1 个）
    assert len(inspect.signature(cms_spider.CmsSpider.homeVideoContent).parameters) == 2
    assert len(inspect.signature(js_spider.JsSpider.homeVideoContent).parameters) == 1
    assert len(inspect.signature(base_spider.Spider.homeVideoContent).parameters) == 1
    # 未绑定上下文时 inspect 会算上 self（因此预检用的是实例绑定方法）
    cms = cms_spider.CmsSpider('k', 'http://cms.test/api.php')
    assert len(inspect.signature(cms.homeVideoContent).parameters) == 1


def test_runner_proxy_prefers_static_proxy():
    """proxy()：存在可调用的 proxy_static 时优先走 JAR 静态 Proxy.proxy(Map)。"""
    class _WithStatic(base_spider.Spider):
        def init(self, extend=''):
            pass

        def proxy_static(self, param):
            return ('static', param)

        def localProxy(self, param):
            return ('instance', param)

    r = Runner(_WithStatic())
    assert r.proxy({'a': 1}) == ('static', {'a': 1})
    assert r.localProxy({'a': 1}) == ('instance', {'a': 1})

    class _NoStatic(base_spider.Spider):
        def init(self, extend=''):
            pass

        def localProxy(self, param):
            return ('instance', param)

    assert Runner(_NoStatic()).proxy({'a': 1}) == ('instance', {'a': 1})


def test_runner_missing_optional_method_raises():
    """Spider 未实现 jsonExt 等可选方法时 Runner 直接抛 AttributeError。"""
    class _Rec(base_spider.Spider):
        def init(self, extend=''):
            pass

    r = Runner(_Rec())
    try:
        r.jsonExt('k', {}, 'u')
    except AttributeError:
        pass
    else:
        assert False, 'jsonExt 未实现应抛 AttributeError'
    # 基类默认实现路径：getName/getDependence/destroy/manualVideoCheck 不抛
    assert r.getDependence() == []
    assert r.getName() is None
    assert r.destroy() is None
    assert r.manualVideoCheck() is None
    assert r.isVideoFormat('u') is None


def test_all_three_modules_expose_the_same_duck_face():
    """跨模块契约：Runner/app 调用的同一组方法名在三个实现上都存在。

    例外（白盒事实）：CmsSpider 没有 ``liveContent`` —— CMS 接口无直播能力，
    调用方必须自行判空，这是三模块唯一的接口缺口。
    """
    face = ('init', 'homeContent', 'homeVideoContent', 'categoryContent',
            'detailContent', 'searchContent', 'playerContent',
            'localProxy', 'isVideoFormat', 'manualVideoCheck', 'action', 'destroy')
    for cls in (base_spider.Spider, js_spider.JsSpider, cms_spider.CmsSpider):
        for name in face:
            assert callable(getattr(cls, name, None)), '%s.%s 缺失' % (cls.__name__, name)
    # 只有基类与 JsSpider 提供 liveContent
    assert callable(base_spider.Spider.liveContent)
    assert callable(js_spider.JsSpider.liveContent)
    assert getattr(cms_spider.CmsSpider, 'liveContent', None) is None
    # JsSpider 继承基类（共享单例与工具方法），CmsSpider 是独立鸭子实现
    assert issubclass(js_spider.JsSpider, base_spider.Spider)
    assert not issubclass(cms_spider.CmsSpider, base_spider.Spider)


if __name__ == '__main__':
    passed = 0
    failed = []
    for name, fn in sorted(globals().items()):
        if not (name.startswith('test_') and callable(fn)):
            continue
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - 汇总 runner 需要捕获全部
            failed.append((name, exc))
            print('FAIL %s: %s: %s' % (name, type(exc).__name__, exc))
        else:
            passed += 1
            print('PASS %s' % name)
    print('----')
    print('TOTAL %d PASS %d FAIL %d' % (passed + len(failed), passed, len(failed)))
    if failed:
        for name, exc in failed:
            print('FAILED %s -> %s' % (name, exc))
        sys.exit(1)
    print('ALL PASS')
