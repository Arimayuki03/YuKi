# -*- coding: utf-8 -*-
"""Kazumi 子包白盒单元测试（utils / xpath_strategy / models / cookie_jar / api_strategy / captcha）。

定位：与既有三种 kazumi 测试**互补**，专攻内部私有分支，不做端到端重复覆盖。
  - test_kazumi.py             —— Plugin/PluginManager/RuleEngine 黑盒主干 + 少量策略用例
  - test_kazumi_cache.py       —— 搜索/章节/串流缓存
  - test_kazumi_bgm_rating.py  —— Bangumi 评分吐槽 + 验证码 payload 契约
  - test_kazumi_cover_proxy.py —— 封面代理与镜像回退

本文件因此专攻：
  - xpath_strategy._node_relative / _node_text / _document_element / _run_selector / _detects_captcha
  - cookie_jar 域名匹配矩阵、_same_site、持久化往返、损坏/legacy 兜底
  - utils.normalize_episode_url 边界矩阵、is_http_url、验证码启发式
  - models 默认值隔离 / 序列化往返 / 缺字段
  - api_strategy RestrictedJsonPath 词法分支、_render_template/_render_value/_string_value、章节分支
  - captcha 识别成功/噪声/异常/无识别器兜底

风格对齐 test_mem_cache.py：纯 assert 函数式用例 + 末尾汇总 runner。
文件系统用 tempfile.mkdtemp，全程无真实网络。
"""
import json
import os
import sys
import tempfile
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(HERE)
sys.path.insert(0, BACKEND_DIR)
# 隔离真实 profile：YUKI_DATA_DIR 必须在 import hoststate 之前生效
_TEST_DATA = tempfile.mkdtemp(prefix='kazumi-utils-test-')
os.environ['YUKI_DATA_DIR'] = _TEST_DATA

from lxml import html as lxml_html  # noqa: E402

from kazumi import captcha as captcha_mod  # noqa: E402
from kazumi.api_strategy import ApiRuleStrategy, RestrictedJsonPath  # noqa: E402
from kazumi.cookie_jar import CookieJar  # noqa: E402
from kazumi.models import (  # noqa: E402
    PluginSearchResponse,
    PreparedRuleRequest,
    Road,
    RuleChapterParseResult,
    RuleChapterTrace,
    RuleExecutionConfig,
    RuleSearchParseResult,
    RuleSearchTrace,
    SearchItem,
)
from kazumi.utils import (  # noqa: E402
    ApiRuleFormatException,
    CaptchaRequiredException,
    KazumiError,
    XPathRuleFormatException,
    detect_image_captcha_html,
    get_random_ua,
    is_http_url,
    looks_like_image_captcha_url,
    normalize_episode_url,
)
from kazumi.xpath_strategy import XPathRuleStrategy  # noqa: E402


# ---------------------------------------------------------------- 测试夹具

def _tmp_file(prefix='cookies-'):
    """临时目录内的独立 cookie 文件路径（彼此隔离，互不影响）。"""
    return os.path.join(tempfile.mkdtemp(prefix='kzu-'), prefix + 'c.json')


def _cfg(**kwargs):
    """构造 RuleExecutionConfig，仅在关心字段上覆盖默认值。"""
    base = dict(
        plugin_name='p',
        base_url='https://example.com',
        use_post=False,
        search_mode='xpath',
        chapter_mode='xpath',
        search_url='https://example.com/s?wd=@keyword&tag=@tag&year=@year&sort=@sort',
        search_list='//div[@class="item"]',
        search_name='//a',
        search_result='//a',
        chapter_roads='//ul[@class="road"]',
        chapter_result='//li/a',
    )
    base.update(kwargs)
    return RuleExecutionConfig(**base)


class _FakeOcr:
    """ddddocr 桩：classification 返回值/异常可注入，并记录调用入参。"""
    def __init__(self, result):
        self.result = result
        self.seen = []

    def classification(self, data):
        self.seen.append(data)
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


# ================================================================ xpath_strategy: XPath 归一化矩阵

def test_node_relative_absolute_path_becomes_dot_slash():
    """绝对路径 `/a` 归一化为 `./a`（以 searchList 节点为上下文的子节点查询）。"""
    assert XPathRuleStrategy._node_relative('/a') == './a'
    assert XPathRuleStrategy._node_relative('/div/span') == './div/span'


def test_node_relative_r2_double_slash_becomes_dot_double_slash():
    """核心 R2 规则：文档级 `//a` → 节点相对 `.//a`（避免命中整页首个匹配）。"""
    assert XPathRuleStrategy._node_relative('//a') == './/a'
    assert XPathRuleStrategy._node_relative('//a[2]') == './/a[2]'
    assert XPathRuleStrategy._node_relative('//a/text()') == './/a/text()'
    assert XPathRuleStrategy._node_relative('//a/@href') == './/a/@href'


def test_node_relative_already_relative_is_untouched():
    """已以 `.` 开头（`.//a` / `./a` / `.`）或裸轴/属性选择器的表达式原样返回。"""
    assert XPathRuleStrategy._node_relative('.//a') == './/a'
    assert XPathRuleStrategy._node_relative('./a') == './a'
    assert XPathRuleStrategy._node_relative('.') == '.'
    assert XPathRuleStrategy._node_relative('descendant::a') == 'descendant::a'
    assert XPathRuleStrategy._node_relative('child::li') == 'child::li'
    assert XPathRuleStrategy._node_relative('@href') == '@href'
    assert XPathRuleStrategy._node_relative('a') == 'a'


def test_node_relative_predicate_and_function_forms():
    """含谓词 `[@attr]`、含位置/函数（text()/contains()）的表达式只改前缀，不动内部。"""
    assert XPathRuleStrategy._node_relative('//div[@class="road"]') == './/div[@class="road"]'
    assert XPathRuleStrategy._node_relative('//*[contains(@class,"item")]') == './/*[contains(@class,"item")]'
    assert XPathRuleStrategy._node_relative('/li[position()=2]/a') == './li[position()=2]/a'


def test_node_relative_wildcard_and_multi_slash():
    """通配符与多重斜杠：只补一个前导 `.`，不折叠内部斜杠（保持 XPath 语义）。"""
    assert XPathRuleStrategy._node_relative('/*') == './*'
    assert XPathRuleStrategy._node_relative('///a') == './//a'
    assert XPathRuleStrategy._node_relative('//') == './/'
    assert XPathRuleStrategy._node_relative('/') == './'


def test_node_relative_whitespace_and_empty():
    """首尾空白被 strip；空串/纯空白返回空串；None 兜底为空串。"""
    assert XPathRuleStrategy._node_relative('  //a  ') == './/a'
    assert XPathRuleStrategy._node_relative('\t/a\n') == './a'
    assert XPathRuleStrategy._node_relative('') == ''
    assert XPathRuleStrategy._node_relative('   ') == ''
    assert XPathRuleStrategy._node_relative(None) == ''


def test_node_relative_non_string_raises_attribute_error():
    """非字符串入参不被静默吞掉：白盒契约是抛 AttributeError（调用方 _run_selector 已包裹外层）。"""
    try:
        XPathRuleStrategy._node_relative(5)
    except AttributeError:
        return
    raise AssertionError('非字符串入参应透出 AttributeError')


def test_node_relative_is_idempotent():
    """R2 幂等：归一化结果再归一化必须不变（规则可被重复处理而不漂移）。"""
    for expr in ['//a', '/a', './/a', './a', '//div[@class="x"]/a', '//', 'descendant::a', '@href', '']:
        once = XPathRuleStrategy._node_relative(expr)
        assert XPathRuleStrategy._node_relative(once) == once, expr


def test_node_relative_semantics_under_node_context():
    """语义验证：`//a` 归一化后在各自节点内查询，而非退回文档根取同一批节点。"""
    html = ('<html><body>'
            '<div class="road"><a href="/r1a">A</a><a href="/r1b">B</a></div>'
            '<div class="road"><a href="/r2a">C</a><a href="/r2b">D</a></div>'
            '</body></html>')
    root = lxml_html.fromstring(html)
    roads = root.xpath('//div[@class="road"]')
    first_hrefs = [a.get('href') for a in roads[0].xpath(XPathRuleStrategy._node_relative('//a'))]
    second_hrefs = [a.get('href') for a in roads[1].xpath(XPathRuleStrategy._node_relative('//a'))]
    assert first_hrefs == ['/r1a', '/r1b']
    assert second_hrefs == ['/r2a', '/r2b']
    # 未归一化则 lxml 按文档根查询，两个节点拿到完全相同的结果（正是原 bug）
    assert [a.get('href') for a in roads[0].xpath('//a')] == [a.get('href') for a in roads[1].xpath('//a')]


# ---------------------------------------------------------------- xpath_strategy: 辅助私有方法

def test_node_text_element_and_string_branches():
    """_node_text 双分支：`/text()` 结果是 str 直接 strip；元素是 text_content().strip()。"""
    doc = lxml_html.fromstring('<div><b> X </b> tail </div>')
    assert XPathRuleStrategy._node_text(doc) == 'X  tail'
    assert XPathRuleStrategy._node_text('  hi  ') == 'hi'
    assert XPathRuleStrategy._node_text('') == ''


def test_document_element_ok_and_failure():
    """_document_element：正常解析返回根节点；空串/畸形输入抛 invalidDocument。"""
    assert XPathRuleStrategy()._document_element('<p>x</p>').tag == 'p'
    for bad in ['', '   ', '\n\t']:
        try:
            XPathRuleStrategy()._document_element(bad)
        except XPathRuleFormatException as exc:
            assert exc.kind == 'invalidDocument', bad
        else:
            raise AssertionError('非法文档应抛异常: %r' % bad)


def test_run_selector_empty_expression():
    """_run_selector：空/纯空白表达式 → invalidSelector（field/expression 透出便于诊断）。"""
    strategy = XPathRuleStrategy()
    for expr in ['', '   ', '\n']:
        try:
            strategy._run_selector('searchList', expr, lambda: [])
        except XPathRuleFormatException as exc:
            assert exc.kind == 'invalidSelector'
            assert exc.field == 'searchList'
            assert exc.expression == expr
        else:
            raise AssertionError('空表达式应被拦截: %r' % expr)


def test_run_selector_wraps_arbitrary_query_exception():
    """_run_selector：任意底层异常统一包装为 XPathRuleFormatException 并保留 cause。"""
    strategy = XPathRuleStrategy()
    try:
        strategy._run_selector('chapterResult', 'bad //', lambda: (_ for _ in ()).throw(ValueError('boom')))
    except XPathRuleFormatException as exc:
        assert exc.kind == 'invalidSelector'
        assert exc.field == 'chapterResult'
        assert isinstance(exc.cause, ValueError)
    else:
        raise AssertionError('底层异常应被包装')
    # 未知 field 名回落到 field 原值的文案分支
    try:
        strategy._run_selector('unknownField', 'x', lambda: '')
    except XPathRuleFormatException:
        raise AssertionError('非空表达式 + 正常查询不应抛异常')
    assert strategy._run_selector('chapterRoads', '//ul', lambda: [1, 2]) == [1, 2]


def test_run_selector_re_raises_rule_format_exception_as_is():
    """_run_selector：查询内部已抛 XPathRuleFormatException 时原样上抛（不二次包装）。"""
    inner = XPathRuleFormatException('inner', kind='invalidDocument')
    try:
        XPathRuleStrategy()._run_selector('searchList', '//div', lambda: (_ for _ in ()).throw(inner))
    except XPathRuleFormatException as exc:
        assert exc is inner
    else:
        raise AssertionError('应原样透传')


# ================================================================ xpath_strategy: 反爬检测

def test_detects_captcha_disabled_and_empty():
    """反爬未启用 / 配置为空 → 一律不判定为验证码（宁可漏报）。"""
    root = lxml_html.fromstring('<div class="cap">x</div>')
    s = XPathRuleStrategy()
    assert s._detects_captcha('x', None, root) is False
    assert s._detects_captcha('x', {}, root) is False
    assert s._detects_captcha('x', {'enabled': False, 'captchaDetectValue': 'x'}, root) is False


def test_detects_captcha_text_type():
    """detectType=2（纯文本包含）：命中子串才算，大小写敏感。"""
    root = lxml_html.fromstring('<body>x</body>')
    s = XPathRuleStrategy()
    cfg = {'enabled': True, 'captchaDetectValue': '安全验证', 'captchaDetectType': 2}
    assert s._detects_captcha('<p>请完成安全验证</p>', cfg, root) is True
    assert s._detects_captcha('<p>normal</p>', cfg, root) is False


def test_detects_captcha_regex_type_and_invalid_regex():
    """detectType=3（正则，忽略大小写 + DOTALL）；非法正则吞异常返回 False，不炸主流程。"""
    root = lxml_html.fromstring('<body>x</body>')
    s = XPathRuleStrategy()
    assert s._detects_captcha('<p>AbC</p>', {'enabled': True, 'captchaDetectValue': 'aBc', 'captchaDetectType': 3}, root) is True
    assert s._detects_captcha('<p>x</p>', {'enabled': True, 'captchaDetectValue': 'zzz', 'captchaDetectType': 3}, root) is False
    bad = {'enabled': True, 'captchaDetectValue': '([unclosed', 'captchaDetectType': 3}
    assert s._detects_captcha('<p>x</p>', bad, root) is False


def test_detects_captcha_xpath_type_and_fallback_fields():
    """默认=xpath 判定；detectValue 为空时回退 captchaImage/captchaButton 两个兜底字段。"""
    root = lxml_html.fromstring('<body><img class="cap" src="/captcha.php"/></body>')
    s = XPathRuleStrategy()
    assert s._detects_captcha('x', {'enabled': True, 'captchaDetectValue': '//img[@class="cap"]'}, root) is True
    assert s._detects_captcha('x', {'enabled': True, 'captchaDetectValue': '//img[@class="nope"]'}, root) is False
    assert s._detects_captcha('x', {'enabled': True, 'captchaImage': '//img[@class="cap"]'}, root) is True
    assert s._detects_captcha('x', {'enabled': True, 'captchaButton': '//img[@class="cap"]'}, root) is True
    assert s._detects_captcha('x', {'enabled': True, 'captchaImage': '   ', 'captchaButton': ''}, root) is False


def test_parse_search_raises_captcha_required():
    """反爬命中时 parse_search 抛 CaptchaRequiredException 且携带 plugin_name。"""
    html = '<div class="item"><a href="/v/1">请先完成安全验证</a></div>'
    config = _cfg(anti_crawler_config={'enabled': True, 'captchaDetectValue': '安全验证', 'captchaDetectType': 2})
    try:
        XPathRuleStrategy().parse_search(html, config)
    except CaptchaRequiredException as exc:
        assert exc.plugin_name == 'p'
        assert 'requires captcha verification' in str(exc)
    else:
        raise AssertionError('应抛出 CaptchaRequiredException')


# ================================================================ xpath_strategy: 请求构造/解析

def test_prepare_search_request_filters_opt_in():
    """@tag/@year/@sort 为 opt-in：未传 filters 时占位被替换为空串（不是保留占位符）。"""
    req = XPathRuleStrategy().prepare_search_request(_cfg(), 'kw')
    assert req.method == 'GET'
    assert req.include_cookies is True
    assert req.url == 'https://example.com/s?wd=kw&tag=&year=&sort='
    full = XPathRuleStrategy().prepare_search_request(_cfg(), 'kw', {'tag': '动画', 'year': 2024, 'sort': 'time'})
    assert full.url == 'https://example.com/s?wd=kw&tag=动画&year=2024&sort=time'


def test_prepare_search_request_post_moves_query_to_body():
    """POST：URL 去掉 query，query 首值作为表单 body（重复键取第一个，对齐 Dart）。"""
    req = XPathRuleStrategy().prepare_search_request(
        _cfg(use_post=True, search_url='https://example.com/s?wd=@keyword&p=1&p=2'), 'kw')
    assert req.method == 'POST'
    assert req.url == 'https://example.com/s'
    assert req.body_type == 'form'
    assert req.body == {'wd': 'kw', 'p': '1'}
    assert req.include_cookies is True


def test_prepare_chapter_request_uses_base_url():
    """剧集请求走 normalize_episode_url 补全，且默认不带 Cookie（仅搜索请求带）。"""
    req = XPathRuleStrategy().prepare_chapter_request(_cfg(), '/vod/1')
    assert req.method == 'GET'
    assert req.url == 'https://example.com/vod/1'
    assert req.include_cookies is False


def test_parse_search_collects_diagnostics_and_skips_incomplete_nodes():
    """条目缺 name 或 src 时不入结果，但要留下中文诊断而不是崩。"""
    html = ('<div class="item"><a href="/v/1"></a></div>'
            '<div class="item"><b>无名无链接</b></div>'
            '<div class="item"><a href="/v/3">正常</a></div>')
    res = XPathRuleStrategy().parse_search(html, _cfg())
    assert [i.src for i in res.items] == ['https://example.com/v/3']
    assert len(res.diagnostics) == 2
    assert res.matched_fragments[0].startswith('<div class="item">')
    assert len(res.matched_fragments[0]) <= 200  # 片段截断上限


def test_parse_search_accepts_string_nodes_from_text_and_attr_selectors():
    """text()/@href 选出的是 str 分支：src 走 str.strip()，不走 .get('href')。"""
    html = '<div class="item"><span>片名</span><b>/rel/1</b><a href="/attr/1">忽略</a></div>'
    res = XPathRuleStrategy().parse_search(
        html, _cfg(search_name='//span/text()', search_result='//b/text()'))
    assert [(i.name, i.src) for i in res.items] == [('片名', 'https://example.com/rel/1')]
    res_attr = XPathRuleStrategy().parse_search(
        html, _cfg(search_name='//span/text()', search_result='//a/@href'))
    assert res_attr.items[0].src == 'https://example.com/attr/1'


def test_parse_chapters_node_relative_isolates_roads():
    """线路隔离：同一 `//li/a` 规则在每条线路节点内部各取各的，不串到别条线路。"""
    html = ('<ul class="road"><li><a href="/a1">A1</a></li><li><a href="/a2">A2</a></li></ul>'
            '<ul class="road"><li><a href="/b1">B1</a></li></ul>')
    res = XPathRuleStrategy().parse_chapters(html, _cfg(chapter_result='//li/a'))
    assert [r.data for r in res.roads] == [
        ['https://example.com/a1', 'https://example.com/a2'],
        ['https://example.com/b1'],
    ]
    assert [r.name for r in res.roads] == ['播放线路1', '播放线路2']


def test_parse_chapters_missing_href_and_empty_text_fallback():
    """无 href 的剧集节点丢弃并留诊断；文本为空时集数名回落到 `第N集`（按 enumerate 序号）。"""
    html = ('<ul class="road"><li><a href="/p1">第1集</a></li>'
            '<li><a>无链接</a></li><li><a href="  /p2  "></a></li></ul>'
            '<ul class="road"></ul>')
    res = XPathRuleStrategy().parse_chapters(html, _cfg())
    assert res.roads[0].identifier == ['第1集', '第3集']
    assert res.roads[0].data == ['https://example.com/p1', 'https://example.com/p2']
    assert len(res.roads) == 1  # 空线路被跳过
    assert any('缺少 URL' in d for d in res.diagnostics)
    assert any('没有有效剧集' in d for d in res.diagnostics)


def test_parse_chapters_invalid_selector_propagates():
    """线路层/剧集层的 XPathRuleFormatException 原样上抛，不退化为空结果。"""
    strategy = XPathRuleStrategy()
    try:
        strategy.parse_chapters('<ul class="road"><li><a href="/p">x</a></li></ul>',
                                _cfg(chapter_result='//a[[['))
    except XPathRuleFormatException as exc:
        assert exc.kind == 'invalidSelector'
        assert exc.field == 'chapterResult'
    else:
        raise AssertionError('非法剧集选择器应上抛')


# ================================================================ utils: URL 归一化

def test_normalize_relative_and_root_relative():
    """相对路径与根相对路径：以 base_url 的 host 解析，中文路径不做百分号编码（原文保留）。"""
    assert normalize_episode_url('https://example.com/', '/vod/1') == 'https://example.com/vod/1'
    assert normalize_episode_url('https://example.com/base/dir/', './x') == 'https://example.com/base/dir/x'
    assert normalize_episode_url('https://example.com/base/dir/', '../up/1') == 'https://example.com/base/up/1'
    assert normalize_episode_url('https://example.com/', '/vod/中文') == 'https://example.com/vod/中文'


def test_normalize_protocol_relative_url():
    """协议相对 `//host/path`：继承 base 的 scheme（这是浏览器/join 的标准行为）。"""
    assert normalize_episode_url('https://example.com/', '//cdn.example.com/x') == 'https://cdn.example.com/x'
    assert normalize_episode_url('https://example.com/', '//example.com/a/') == 'https://example.com/a'


def test_normalize_query_and_fragment_preserved():
    """非空 query / fragment 原样保留；空 query（`?`）被剔除。"""
    assert normalize_episode_url('https://example.com/', '/v/1?a=1&b=2') == 'https://example.com/v/1?a=1&b=2'
    assert normalize_episode_url('https://example.com/', '/v/1#frag') == 'https://example.com/v/1#frag'
    assert normalize_episode_url('https://example.com/', '/v/1?') == 'https://example.com/v/1'
    assert normalize_episode_url('https://example.com/', '/v/1?a=%E4%B8%AD') == 'https://example.com/v/1?a=%E4%B8%AD'


def test_normalize_same_site_scheme_unified():
    """同站（同 netloc）不同 scheme → 统一到 base 的 scheme；跨站不动。"""
    assert normalize_episode_url('https://example.com/', 'http://example.com/v/1') == 'https://example.com/v/1'
    assert normalize_episode_url('http://example.com/', 'https://example.com/v/1') == 'http://example.com/v/1'
    assert normalize_episode_url('https://example.com/', 'http://other.org/v/1') == 'http://other.org/v/1'


def test_normalize_host_case_and_port_preserved():
    """netloc 原样透出（不小写化）；对齐 Dart 实现允许此差异，仅记录契约。"""
    got = normalize_episode_url('https://example.com/', 'HTTPS://EXAMPLE.COM/A')
    assert got == 'https://EXAMPLE.COM/A'  # scheme 统一 + 尾斜杠清理，host 大小写不动


def test_normalize_invalid_base_falls_back_to_input():
    """base 不是绝对 URL 时无法解析：相对路径原样返回，不臆造 scheme。"""
    assert normalize_episode_url('', '/vod/1') == '/vod/1'
    assert normalize_episode_url('example.com', '/vod/1') == '/vod/1'
    assert normalize_episode_url('   ', '/vod/1') == '/vod/1'


def test_normalize_empty_and_whitespace_input():
    """空串/纯空白返回空串；首尾空白与制表换行被 trim。"""
    assert normalize_episode_url('https://example.com/', '') == ''
    assert normalize_episode_url('https://example.com/', '   ') == ''
    assert normalize_episode_url('https://example.com/', '  \t /vod/1 \n ') == 'https://example.com/vod/1'


def test_normalize_exotic_schemes_are_returned_verbatim():
    """非 http(s) 且有 netloc 的 URL（ftp/js）按绝对 URL 处理，原样返回。"""
    assert normalize_episode_url('https://example.com/', 'ftp://h/a') == 'ftp://h/a'
    assert normalize_episode_url('https://example.com/', 'javascript:alert(1)') == 'javascript:alert(1)'


def test_normalize_trailing_slash_stripping_and_idempotence():
    """尾斜杠剥离根路径除外；多次归一化结果稳定（幂等）。"""
    assert normalize_episode_url('https://example.com/', '/vod/1/') == 'https://example.com/vod/1'
    assert normalize_episode_url('https://example.com/', '/') == 'https://example.com/'
    once = normalize_episode_url('https://example.com/', '//cdn.example.com/x/')
    twice = normalize_episode_url('https://example.com/', once)
    triple = normalize_episode_url('https://example.com/', twice)
    assert once == twice == triple == 'https://cdn.example.com/x'


def test_normalize_non_string_raw_raises():
    """白盒：raw=None 不做静默兜底，直接 AttributeError（调用方需自行保证字符串）。"""
    try:
        normalize_episode_url('https://example.com/', None)
    except AttributeError:
        return
    raise AssertionError('None 应透出 AttributeError')


def test_is_http_url_matrix():
    """is_http_url：大小写不敏感；非 http(s)、空串一律 False。"""
    assert is_http_url('https://a.com') is True
    assert is_http_url('HTTP://a.com') is True
    assert is_http_url('http://a.com') is True
    assert is_http_url('ftp://a.com') is False
    assert is_http_url('//a.com') is False
    assert is_http_url('') is False


def test_get_random_ua_from_pool():
    """随机 UA 必须落在一个非空 UA 池内（规则未指定 UA 时的兜底来源）。"""
    from kazumi.utils import RANDOM_UA_POOL
    assert RANDOM_UA_POOL
    for _ in range(5):
        assert get_random_ua() in RANDOM_UA_POOL


# ================================================================ utils: 验证码启发式

def test_looks_like_image_captcha_url_needs_http_scheme():
    """必须同时满足 http(s) 前缀 + 特征词；协议相对地址与非 http scheme 均不命中。"""
    assert looks_like_image_captcha_url('https://ex.com/captcha.php') is True
    assert looks_like_image_captcha_url('HTTPS://EX.COM/VERIFY.ASPX') is True
    assert looks_like_image_captcha_url('//ex.com/captcha.php') is False
    assert looks_like_image_captcha_url('ftp://ex.com/captcha.php') is False
    assert looks_like_image_captcha_url('javascript:captcha') is False


def test_looks_like_image_captcha_url_subword_and_negative():
    """子词命中（imageVerify.php / vcode）；纯搜索地址与 None 不命中。"""
    assert looks_like_image_captcha_url('https://ex.com/include/imageVerify.php') is True
    assert looks_like_image_captcha_url('https://ex.com/api/vcode?ts=1') is True
    assert looks_like_image_captcha_url('https://ex.com/search?wd=关键词') is False
    assert looks_like_image_captcha_url('') is False
    assert looks_like_image_captcha_url(None) is False


def test_detect_image_captcha_html_combination_rule():
    """HTML 判定是「验证码 img + 短输入框」合取；缺任一项不命中，大小写不敏感。"""
    assert detect_image_captcha_html('<img src="/CAPTCHA.PHP"/><input maxlength=4>') is True
    assert detect_image_captcha_html('<img src="/captcha.php"/><input maxlength="6"/>') is True
    assert detect_image_captcha_html('<img src="/captcha.php"/><input maxlength="9"/>') is False
    assert detect_image_captcha_html('<img src="/pic.png"/><input maxlength="4"/>') is False
    assert detect_image_captcha_html('') is False
    assert detect_image_captcha_html(None) is False


def test_captcha_exception_hierarchy():
    """异常层级：所有 kazumi 异常均派生 KazumiError，便于上层统一兜底。"""
    from kazumi.utils import ChapterErrorException, NoResultException, SearchErrorException
    assert isinstance(XPathRuleFormatException('m'), KazumiError)
    assert isinstance(ApiRuleFormatException('m'), KazumiError)
    assert isinstance(CaptchaRequiredException('pl'), KazumiError)
    assert isinstance(NoResultException('pl'), KazumiError)
    assert SearchErrorException('pl', cause='timeout').cause == 'timeout'
    assert ChapterErrorException('pl').plugin_name == 'pl'
    detailed = XPathRuleFormatException('m', kind='k', field='f', expression='e')
    assert (detailed.kind, detailed.field, detailed.expression) == ('k', 'f', 'e')


# ================================================================ models

def test_model_defaults_are_not_shared():
    """dataclass 的 list/dict 默认值用 default_factory：不同实例之间不共享可变对象。"""
    a, b = Road(name='A'), Road(name='B')
    a.data.append('/x')
    assert b.data == []
    assert a.identifier is not b.identifier
    c = PreparedRuleRequest(method='GET', url='u')
    assert c.headers == {} and c.query == {} and c.body is None
    c.headers['k'] = 'v'
    assert PreparedRuleRequest(method='GET', url='u').headers == {}


def test_model_asdict_roundtrip():
    """asdict 序列化后字段名一一对应，可原样重建（嵌套层退化为 dict，判等仍成立）。"""
    from dataclasses import asdict
    resp = PluginSearchResponse(plugin_name='pl', data=[SearchItem(name='n', src='s')])
    flat = asdict(resp)
    assert flat == {'plugin_name': 'pl', 'data': [{'name': 'n', 'src': 's'}]}
    # 嵌套层退化为 dict：朴素 `**asdict` 重建后与原地对象**不判等**（asdict 递归降级所致）
    assert PluginSearchResponse(**flat) != resp
    # 回装嵌套层后才真正相等（这就是「序列化往返」的完整口径）
    assert PluginSearchResponse(plugin_name=flat['plugin_name'],
                                data=[SearchItem(**i) for i in flat['data']]) == resp
    roads = RuleChapterParseResult(roads=[Road(name='L1', data=['/a'], identifier=['第1集'])])
    flat_roads = asdict(roads)
    assert RuleChapterParseResult(**flat_roads) != roads
    assert RuleChapterParseResult(roads=[Road(**r) for r in flat_roads['roads']],
                                  diagnostics=flat_roads['diagnostics']) == roads
    # 标量层往返：SearchItem/Road/PreparedRuleRequest 无嵌套，重建后严格相等
    assert SearchItem(**asdict(SearchItem(name='n', src='s'))) == SearchItem(name='n', src='s')
    assert Road(**asdict(Road(name='L', data=['/a'], identifier=['1']))) == Road(name='L', data=['/a'], identifier=['1'])
    req = PreparedRuleRequest(method='POST', url='u', body_type='json', body={'a': 1})
    assert PreparedRuleRequest(**asdict(req)) == req
    trace = RuleSearchTrace(raw_response='raw', response=resp, matched_fragments=['f'])
    assert asdict(trace)['raw_response'] == 'raw'
    assert asdict(RuleChapterTrace(raw_response='r', roads=[Road(name='L')]))['raw_response'] == 'r'


def test_model_nested_asdict_needs_rehydration_helper():
    """白盒注意点：asdict 把嵌套 dataclass 递归成 dict，直接取用 item.name 会 AttributeError。"""
    from dataclasses import asdict
    resp = PluginSearchResponse(plugin_name='pl', data=[SearchItem(name='n', src='s')])
    flat_item = asdict(resp)['data'][0]
    assert isinstance(flat_item, dict) and flat_item['name'] == 'n'
    assert SearchItem(**flat_item).name == 'n'


def test_model_result_containers_default_to_empty_lists():
    """结果容器（搜索/章节）三个列表字段默认空且相互独立，可原地 append 累加。"""
    s1, s2 = RuleSearchParseResult(), RuleSearchParseResult()
    s1.items.append(SearchItem(name='n', src='s'))
    s1.diagnostics.append('d')
    assert s2.items == [] and s2.matched_fragments == [] and s2.diagnostics == []
    assert s1.items is not s2.items
    c1, c2 = RuleChapterParseResult(), RuleChapterParseResult()
    c1.roads.append(Road(name='L'))
    assert c2.roads == [] and c2.diagnostics == []


def test_model_missing_required_field_raises_type_error():
    """必填字段缺失是 TypeError（构造期失败，不会产出半初始化对象）。"""
    try:
        SearchItem(name='only-name')
    except TypeError as exc:
        assert 'src' in str(exc)
    else:
        raise AssertionError('缺 src 应抛 TypeError')


def test_rule_execution_config_required_and_optional_fields():
    """RuleExecutionConfig：10 个必填位置字段 + 6 个带默认值的可选字段。"""
    cfg = _cfg()
    assert (cfg.plugin_name, cfg.use_post, cfg.search_mode) == ('p', False, 'xpath')
    assert cfg.search_api_config == {} and cfg.chapter_api_config == {}
    assert cfg.anti_crawler_config == {} and cfg.user_agent == '' and cfg.referer == ''
    optional = RuleExecutionConfig(
        'pl', 'https://b', True, 'api', 'api', 'u', 'l', 'n', 'r', 'cr', 'cres', {}, {}, {}, 'ua', 'ref')
    assert optional.user_agent == 'ua' and optional.referer == 'ref'


def test_road_and_search_item_are_comparable_value_objects():
    """值语义：字段相同的两个对象判等（@dataclass 自动生成 __eq__，可做断言与去重）。"""
    assert SearchItem(name='n', src='s') == SearchItem(name='n', src='s')
    assert SearchItem(name='n', src='s') != SearchItem(name='n', src='other')
    assert Road(name='L', data=['/a']) != Road(name='L', data=['/b'])
    # 未声明 frozen：dataclass 默认不生成 __hash__，不可哈希（进 set 会 TypeError）
    try:
        hash(SearchItem(name='n', src='s'))
    except TypeError as exc:
        assert 'unhashable' in str(exc)
    else:
        raise AssertionError('默认 @dataclass 应不可哈希')


# ================================================================ cookie_jar

def test_cookie_domain_normalized_on_write():
    """域名写入前被 strip + 小写 + 去前导点；同名 cookie 后者覆盖前者。"""
    jar = CookieJar(file_path=_tmp_file())
    jar.set_domain_cookies('.Example.COM ', [{'name': 'sid', 'value': 'v1'}, {'name': 'sid', 'value': 'v2'}])
    assert list(jar.list_all()) == ['example.com']
    assert jar.list_all()['example.com'] == [{'name': 'sid', 'value': 'v2'}]


def test_cookie_exact_and_parent_domain_match():
    """精确匹配与父域匹配：example.com 的 cookie 覆盖自身及任意层子域。"""
    jar = CookieJar(file_path=_tmp_file())
    jar.set_domain_cookies('example.com', [{'name': 'sid', 'value': 'abc'}])
    for host in ('example.com', 'sub.example.com', 'a.b.example.com'):
        assert jar.cookie_header('https://%s/x' % host) == 'sid=abc', host


def test_cookie_sub_domain_does_not_match_sibling_rule():
    """子域的 cookie 不回吐给父域/兄弟域（方向性：只有结尾 `.domain` 才算命中）。"""
    jar = CookieJar(file_path=_tmp_file())
    jar.set_domain_cookies('sub.example.com', [{'name': 'sid', 'value': 'abc'}])
    assert jar.cookie_header('https://sub.example.com/') == 'sid=abc'
    assert jar.cookie_header('https://deep.sub.example.com/') == 'sid=abc'
    assert jar.cookie_header('https://example.com/') == ''
    assert jar.cookie_header('https://other.example.com/') == ''


def test_cookie_cross_domain_isolation():
    """跨域严格的 Tail-on 匹配：`notexample.com` 不会命中 `example.com` 规则。"""
    jar = CookieJar(file_path=_tmp_file())
    jar.set_domain_cookies('example.com', [{'name': 'sid', 'value': 'abc'}])
    assert jar.cookie_header('https://notexample.com/') == ''
    assert jar.cookie_header('https://example.com.evil.org/') == ''
    jar.set_domain_cookies('other.org', [{'name': 'o', 'value': '1'}])
    assert jar.cookie_header('https://example.com/') == 'sid=abc'
    assert jar.cookie_header('https://other.org/') == 'o=1'


def test_cookie_empty_value_filtered_and_multi_cookie_joined():
    """空 value 不进 Cookie 头（否则会发出无意义的 `k=`）；多个 cookie 用 `; ` 连接。"""
    jar = CookieJar(file_path=_tmp_file())
    jar.set_domain_cookies('a.com', [{'name': 'k', 'value': 'v'}, {'name': 'empty', 'value': ''},
                                     {'name': 'nn', 'value': None}])
    assert jar.cookie_header('https://a.com/') == 'k=v'
    assert jar.list_all()['a.com'] == [{'name': 'k', 'value': 'v'},
                                       {'name': 'empty', 'value': ''},
                                       {'name': 'nn', 'value': ''}]


def test_cookie_all_extras_dropped_including_expiry_field():
    """只保留 name/value：过期时间等元信息不被存储，过期 cookie 需调用方自行剔除。"""
    jar = CookieJar(file_path=_tmp_file())
    jar.set_domain_cookies('a.com', [{'name': 'old', 'value': 'x', 'expires': 1, 'path': '/deep', 'secure': True}])
    assert jar.list_all()['a.com'] == [{'name': 'old', 'value': 'x'}]
    assert jar.cookie_header('https://a.com/') == 'old=x'


def test_cookie_same_name_different_domain_kept_separate():
    """同名 cookie 在不同域各自独立保存，互不覆盖。"""
    jar = CookieJar(file_path=_tmp_file())
    jar.set_domain_cookies('a.com', [{'name': 'sid', 'value': '1'}])
    jar.set_domain_cookies('b.com', [{'name': 'sid', 'value': '2'}])
    assert jar.cookie_header('https://a.com/') == 'sid=1'
    assert jar.cookie_header('https://b.com/') == 'sid=2'
    assert sorted(jar.list_all()) == ['a.com', 'b.com']


def test_cookie_multiple_matching_domains_contribute():
    """多个命中域同时贡献 cookie（父域 + 精确域叠加），拼接顺序取决于内部 dict 插入序。"""
    jar = CookieJar(file_path=_tmp_file())
    jar.set_domain_cookies('example.com', [{'name': 'parent', 'value': 'p'}])
    jar.set_domain_cookies('sub.example.com', [{'name': 'child', 'value': 'c'}])
    header = jar.cookie_header('https://sub.example.com/')
    assert set(header.split('; ')) == {'parent=p', 'child=c'}


def test_cookie_same_site_gate_blocks_third_party_url():
    """高危#10 护栏：URL 与规则 base_url 不同域时不带 cookie（防把登录态交给第三方）。"""
    jar = CookieJar(file_path=_tmp_file())
    jar.set_domain_cookies('example.com', [{'name': 'sid', 'value': 'abc'}])
    assert jar.cookie_header('https://sub.example.com/', 'https://example.com/') == 'sid=abc'
    assert jar.cookie_header('https://steal.org/', 'https://example.com/') == ''
    # base_url 无法解析出 host → 无从建立同域关系，宁可不发
    assert jar.cookie_header('https://sub.example.com/', 'not-a-url') == ''
    # base_url 为空（旧调用方兼容）→ 退回放宽的父域语义
    assert jar.cookie_header('https://sub.example.com/', '') == 'sid=abc'


def test_cookie_same_site_helper_matrix():
    """_same_site：双向尾点匹配 + 末尾点容忍 + 大小写归一；空串一侧必 False。"""
    same = CookieJar._same_site
    assert same('example.com', 'example.com') is True
    assert same('a.b.example.com', 'example.com') is True
    assert same('example.com', 'a.b.example.com') is True
    assert same('example.com.', 'example.com') is True
    assert same('EXAMPLE.COM', 'example.com') is True
    assert same('example.com', 'other.com') is False
    assert same('', 'example.com') is False
    assert same('example.com', '') is False


def test_cookie_invalid_url_and_empty_jar():
    """空 jar 与畸形 URL：一律返回空串而不是抛异常（调用方直接拼 header 即可）。"""
    jar = CookieJar(file_path=_tmp_file())
    assert jar.list_all() == {}
    assert jar.has_cookies() is False
    for bad in ('', 'not-a-url', 'http://', 'ftp://x/'):
        assert jar.cookie_header(bad) == '', bad
    jar.set_domain_cookies('a.com', [{'name': 'k', 'value': 'v'}])
    for bad in ('', 'not-a-url', 'http://'):
        assert jar.cookie_header(bad) == '', bad


def test_cookie_invalid_domain_write_is_noop():
    """空/纯空白/None 域名写入被静默忽略，不污染 jar。"""
    jar = CookieJar(file_path=_tmp_file())
    for bad in ('', '   ', None, '.'):
        jar.set_domain_cookies(bad, [{'name': 'a', 'value': 'b'}])
    jar.set_domain_cookies(None, None)
    assert jar.list_all() == {}
    assert jar.has_cookies() is False


def test_cookie_persistence_roundtrip():
    """落盘 → 新建实例读回，域名/条目完全一致（内容是加密壳，不落明文）。"""
    path = _tmp_file()
    jar = CookieJar(file_path=path)
    jar.set_domain_cookies('a.com', [{'name': 'k', 'value': 'v'}, {'name': 'k2', 'value': 'v2'}])
    with open(path, encoding='utf-8') as fp:
        on_disk = json.load(fp)
    assert on_disk.get('encrypted') is True and on_disk.get('version') == 1
    assert set(on_disk) == {'version', 'encrypted', 'cipher', 'data'}
    fresh = CookieJar(file_path=path)
    assert fresh.list_all() == jar.list_all()
    assert fresh.cookie_header('https://a.com/') == 'k=v; k2=v2'


def test_cookie_clear_persists_and_has_cookies_flag():
    """clear 写回磁盘：新实例读到的也是空 jar，has_cookies 同步为 False。"""
    path = _tmp_file()
    jar = CookieJar(file_path=path)
    jar.set_domain_cookies('a.com', [{'name': 'k', 'value': 'v'}])
    assert jar.has_cookies() is True
    jar.clear()
    assert jar.has_cookies() is False
    assert CookieJar(file_path=path).list_all() == {}


def test_cookie_corrupted_file_falls_back_to_empty():
    """损坏文件（非法 JSON / 非 dict / 密文 data 非法 base64）一律兜底为空 jar，不崩。"""
    cases = ('{not json', '[1,2,3]', '"str"', 'null',
             json.dumps({'encrypted': True, 'cipher': 'dpapi', 'data': '!!!not-b64!!!'}))
    for content in cases:
        path = os.path.join(tempfile.mkdtemp(prefix='kzu-bad-'), 'c.json')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        jar = CookieJar(file_path=path)
        assert jar.list_all() == {}, content
        assert jar.has_cookies() is False
        # 兜底后可正常写入，自癒
        jar.set_domain_cookies('a.com', [{'name': 'k', 'value': 'v'}])
        assert jar.cookie_header('https://a.com/') == 'k=v'


def test_cookie_missing_file_is_empty():
    """首次运行（文件不存在）：静默视为空 jar，不写盘也不报错。"""
    path = os.path.join(tempfile.mkdtemp(prefix='kzu-new-'), 'nested', 'c.json')
    jar = CookieJar(file_path=path)
    assert jar.list_all() == {}
    assert os.path.exists(path) is False


def test_cookie_legacy_plaintext_migrated_to_encrypted():
    """旧版明文文件：读入内存并原样可用，同时就地加密重写（下一次读取走密文分支）。"""
    path = os.path.join(tempfile.mkdtemp(prefix='kzu-legacy-'), 'c.json')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(json.dumps({'legacy.com': [{'name': 'k', 'value': 'v'}]}))
    jar = CookieJar(file_path=path)
    assert jar.cookie_header('https://legacy.com/') == 'k=v'
    with open(path, encoding='utf-8') as fp:
        assert json.load(fp).get('encrypted') is True
    assert CookieJar(file_path=path).cookie_header('https://legacy.com/') == 'k=v'


# ================================================================ api_strategy: RestrictedJsonPath

def test_jsonpath_validate_accepts_supported_shapes():
    """白名单语法：`$` 开头 + `.key` / `[n]` / `[*]` / `['k']` / `["k"]`，含 $ 与 - 也允许。"""
    for expr in ['$', '$.a', '$.a.b', '$[0]', '$[*]', '$["a"]', "$['a b']", '$.a[0]',
                 "$.data['k-1']", '$[0][1]', '$.a-b', '$.a$', '$._x', '$.9', '$[ 0 ]']:
        RestrictedJsonPath.validate(expr)  # 不抛即可


def test_jsonpath_validate_rejects_recursive_and_filters():
    """递归下降 `..` 与过滤器 `[?()]` 属禁止集（安全边界：不支持高阶 JSONPath）。"""
    for expr in ['$..a', '$.data..name', '$.a[?(@.b)]', '$[?(1)]']:
        try:
            RestrictedJsonPath.validate(expr)
        except ApiRuleFormatException:
            pass
        else:
            raise AssertionError('应被拒绝: %s' % expr)


def test_jsonpath_validate_rejects_malformed():
    """非 `$` 开头、孤 `.`、未转义片段、缺 `]` 均报错且错误信息含原表达式。"""
    for expr in ['', 'data', '$a', '$$', '$.', '$[', "$.a['b]['c']"]:
        try:
            RestrictedJsonPath.validate(expr)
        except ApiRuleFormatException as exc:
            assert expr in str(exc)
        else:
            raise AssertionError('应被拒绝: %r' % expr)
    # 片段类错误信息只带 `[片段]` 而不带整串（契约：定位到出错片段即可）
    try:
        RestrictedJsonPath.validate('$[abc]')
    except ApiRuleFormatException as exc:
        assert '[abc]' in str(exc)
    else:
        raise AssertionError('应被拒绝: $[abc]')


def test_jsonpath_find_bracket_end_handles_quotes_and_escapes():
    """_find_bracket_end 分支：引号内的 `]` 不算结尾，反斜杠转义生效。"""
    assert RestrictedJsonPath._find_bracket_end("$['a]b']", 1) == 7
    assert RestrictedJsonPath._find_bracket_end('$["a\\"]b"]', 1) == 9
    assert RestrictedJsonPath._find_bracket_end('$[0]', 1) == 3
    try:
        RestrictedJsonPath._find_bracket_end('$[0', 1)
    except ApiRuleFormatException as exc:
        assert '缺少 ]' in str(exc)
    else:
        raise AssertionError('缺右括号应报错')


def test_jsonpath_read_and_read_first():
    """read 返回全部匹配值；read_first 取首个，无匹配返回 None。"""
    doc = {'data': [{'name': 'a', 'url': 'u1'}, {'name': 'b'}]}
    assert RestrictedJsonPath.read(doc, '$.data[*].name') == ['a', 'b']
    assert RestrictedJsonPath.read_first(doc, '$.data[0].url') == 'u1'
    assert RestrictedJsonPath.read_first(doc, '$.missing') is None
    assert RestrictedJsonPath.read({'a b': 7}, "$['a b']") == [7]


def test_jsonpath_read_propagates_parse_failure():
    """read 先 validate 后求值：非法表达式拦在第一道门，不到 jsonpath_ng。"""
    try:
        RestrictedJsonPath.read({'a': 1}, '$.data..name')
    except ApiRuleFormatException as exc:
        assert '不支持的 JSONPath' in str(exc)
    else:
        raise AssertionError('非法表达式应被拦下')


# ================================================================ api_strategy: 模板与工具

def test_render_template_substitutes_and_encodes():
    """@var 替换；encode=True 走 percent-encoding（含斜杠与中文一并编码）。"""
    s = ApiRuleStrategy()
    assert s._render_template('/p/@source/@id', {'source': 's/1', 'id': 5}) == '/p/s/1/5'
    assert s._render_template('/p/@source', {'source': '中文 x'}, encode=True) == '/p/%E4%B8%AD%E6%96%87%20x'
    assert s._render_template('/p/@source', {'source': 'a/b'}, encode=True) == '/p/a%2Fb'


def test_render_template_ignores_email_like_at():
    """前一个字符是标识符成分时不替换：`a@host.com/@id` 里的 @host 保持原样。"""
    s = ApiRuleStrategy()
    assert s._render_template('a@host.com/@id', {'id': 1}) == 'a@host.com/1'


def test_render_template_missing_variable_raises():
    """缺变量：抛 ApiRuleFormatException 并指明变量名（不静默填空）。"""
    s = ApiRuleStrategy()
    try:
        s._render_template('/p/@nope', {})
    except ApiRuleFormatException as exc:
        assert '@nope' in str(exc)
    else:
        raise AssertionError('缺变量应报错')


def test_render_value_exact_and_nested():
    """_render_value 分支：整串 `@name` 走原值替换；list/dict 递归；非字符串原样返回。"""
    s = ApiRuleStrategy()
    assert s._render_value('@n', {'n': 3}) == 3
    assert s._render_value(5, {}) == 5
    assert s._render_value(None, {}) is None
    assert s._render_value(['@a', 'x/@a'], {'a': 1}) == [1, 'x/1']
    assert s._render_value({'k': '@a'}, {'a': 2}) == {'k': 2}
    try:
        s._render_value('@missing', {})
    except ApiRuleFormatException as exc:
        assert '@missing' in str(exc)
    else:
        raise AssertionError('缺变量应报错')


def test_render_map_stringifies_keys():
    """headers/query 渲染：键统一转 str 后也参与模板替换。"""
    s = ApiRuleStrategy()
    assert s._render_map({'X-@h': 'v-@v'}, {'h': 'Host', 'v': 1}) == {'X-Host': 'v-1'}
    assert s._render_map({}, {}) == {}
    assert s._render_map(None, {}) == {}


def test_string_value_normalization():
    """_string_value：None→''，str→strip 后值，其他→str()（True 变 'True' 是既定契约）。"""
    s = ApiRuleStrategy()
    assert s._string_value(None) == ''
    assert s._string_value('  a  ') == 'a'
    assert s._string_value(12) == '12'
    assert s._string_value(True) == 'True'
    assert s._string_value(1.5) == '1.5'


def test_decode_response_valid_and_invalid():
    """decode_response：合法 JSON 原样返回；非法 JSON 抛 ApiRuleFormatException。"""
    s = ApiRuleStrategy()
    assert s.decode_response('{"a":1}') == {'a': 1}
    try:
        s.decode_response('{bad')
    except ApiRuleFormatException as exc:
        assert '不是有效 JSON' in str(exc)
    else:
        raise AssertionError('非法 JSON 应报错')


def test_prepare_request_validation_matrix():
    """prepare_request 守门顺序：method → url 非空 → url 绝对性；POST+bodyType 才渲染 body。"""
    s = ApiRuleStrategy()
    try:
        s.prepare_request({'method': 'PUT', 'url': 'https://a.com'}, {})
    except ApiRuleFormatException as exc:
        assert 'PUT' in str(exc)
    else:
        raise AssertionError('PUT 应被拒')
    try:
        s.prepare_request({'url': ''}, {})
    except ApiRuleFormatException as exc:
        assert '不能为空' in str(exc)
    else:
        raise AssertionError('空 URL 应被拒')
    try:
        s.prepare_request({'url': 'a.com'}, {})
    except ApiRuleFormatException as exc:
        assert '无效' in str(exc)
    else:
        raise AssertionError('相对 URL 应被拒')
    # GET 即使声明 bodyType 也不渲染 body（has_body 需 method==POST）
    get_req = s.prepare_request({'url': 'https://a.com/@id', 'bodyType': 'json', 'body': {'k': '@id'}}, {'id': 7})
    assert get_req.body is None and get_req.url == 'https://a.com/7'
    post_req = s.prepare_request({'method': 'post', 'url': 'https://a.com/@id', 'bodyType': 'json',
                                  'body': {'k': '@id'}, 'headers': {'X': '@id'}}, {'id': 7})
    assert post_req.method == 'POST' and post_req.body == {'k': 7} and post_req.body_type == 'json'
    # headers 值走 _render_value：整串 `@id` 命中原值替换，int 原样透出（不强制字符串化）
    assert post_req.headers == {'X': 7}


def test_validate_chapter_config_requires_url_source():
    """必须给出 episodeUrlPath 或 episodePage 之一，否则拒绝；episodePage.url 不能为空。"""
    s = ApiRuleStrategy()
    s.validate_chapter_config({'episodesPath': '$.e[*]', 'episodeNamePath': '$.n', 'episodeUrlPath': '$.u'})
    for bad in ({'episodesPath': '$.e[*]', 'episodeNamePath': '$.n'},
                {'episodesPath': '$.e[*]', 'episodeNamePath': '$.n', 'episodePage': {'url': ''}}):
        try:
            s.validate_chapter_config(bad)
        except ApiRuleFormatException:
            pass
        else:
            raise AssertionError('缺播放入口应被拒: %r' % bad)
    s.validate_chapter_config({'episodesPath': '$.e[*]', 'episodeNamePath': '$.n',
                               'episodePage': {'url': 'https://a/@episodeUrl'}})
    # variables 里每个路径都要过 JSONPath 白名单
    try:
        s.validate_chapter_config({'variables': {'v': 'nope'}, 'episodesPath': '$.e[*]',
                                  'episodeNamePath': '$.n', 'episodeUrlPath': '$.u'})
    except ApiRuleFormatException as exc:
        assert 'nope' in str(exc)
    else:
        raise AssertionError('非法变量路径应被拒')


def test_validate_delimited_config_requires_separators():
    """delimited 形态：两个路径 + 三个分隔符缺一不可。"""
    s = ApiRuleStrategy()
    ok = {'format': 'delimited', 'roadNamesPath': '$.n', 'roadEpisodesPath': '$.e',
          'roadSeparator': '$$$', 'episodeSeparator': '#', 'fieldSeparator': '$'}
    s.validate_chapter_config(ok)
    for missing in ('roadSeparator', 'episodeSeparator', 'fieldSeparator'):
        partial = {k: v for k, v in ok.items() if k != missing}
        try:
            s.validate_chapter_config(partial)
        except ApiRuleFormatException as exc:
            assert '分隔符' in str(exc)
        else:
            raise AssertionError('缺 %s 应被拒' % missing)


def test_resolve_episode_url_direct_and_templated():
    """无 episodePage 直接归一化；有模板时合并已有 query 与渲染后的 query。"""
    s = ApiRuleStrategy()
    assert s._resolve_episode_url({}, {}, '/rel/1', 0, 0, 'https://ex.com') == 'https://ex.com/rel/1'
    page = {'url': 'https://ex.com/play?u=@episodeUrl&n=@episodeNumber&r=@roadNumber&ri=@roadIndex&ei=@episodeIndex',
            'query': {'src': '@source'}}
    got = s._resolve_episode_url({'episodePage': page}, {'source': '/src'}, '/p1', 1, 2, 'https://ex.com')
    assert got == 'https://ex.com/play?u=%2Fp1&n=3&r=2&ri=1&ei=2&src=%2Fsrc'
    for bad_page, msg in (({'url': ''}, '模板不能为空'), ({'url': 'rel/@x'}, '无效')):
        try:
            s._resolve_episode_url({'episodePage': bad_page}, {'x': 1}, 'u', 0, 0, 'https://ex.com')
        except ApiRuleFormatException as exc:
            assert msg in str(exc)
        else:
            raise AssertionError('应被拒: %r' % bad_page)


def test_parse_chapters_nested_diagnostics_and_road_fallback_name():
    """nested：空 URL 剧集丢弃；空线路整体丢弃；无 roadNamePath/roadsPath 时名称回落。"""
    s = ApiRuleStrategy()
    cfg = {'roadsPath': '$.roads[*]', 'roadNamePath': '$.name', 'episodesPath': '$.episodes[*]',
           'episodeNamePath': '$.name', 'episodeUrlPath': '$.url'}
    raw = json.dumps({'roads': [{'name': 'L1', 'episodes': [{'name': 'e1', 'url': '/p1'}, {'name': 'e2', 'url': ''}]},
                                {'name': 'L2', 'episodes': []}]})
    res = s.parse_chapters(raw, cfg, source='/src', base_url='https://ex.com')
    assert [(r.name, r.data, r.identifier) for r in res.roads] == [('L1', ['https://ex.com/p1'], ['e1'])]
    assert any('缺少 URL' in d for d in res.diagnostics)
    assert any('没有有效剧集' in d for d in res.diagnostics)
    # 无 roadsPath：整份文档作为唯一线路，名称回落 `播放线路N`
    flat = s.parse_chapters(json.dumps({'episodes': [{'name': 'e1', 'url': '/p1'}]}),
                            {'episodesPath': '$.episodes[*]', 'episodeNamePath': '$.name',
                             'episodeUrlPath': '$.url'}, source='/src', base_url='https://ex.com')
    assert [(r.name, r.data) for r in flat.roads] == [('播放线路1', ['https://ex.com/p1'])]


def test_parse_chapters_delimited_missing_field_separator():
    """delimited：缺 fieldSeparator 的条目丢弃并留诊断；空 grouped 线路跳过。"""
    s = ApiRuleStrategy()
    cfg = {'format': 'delimited', 'roadNamesPath': '$.names', 'roadEpisodesPath': '$.eps',
           'roadSeparator': '$$$', 'episodeSeparator': '#', 'fieldSeparator': '$'}
    raw = json.dumps({'names': 'L1$$$L2', 'eps': 'e1$/p1#bad-no-sep#e2$/p2$$$e3$/p3'})
    res = s.parse_chapters(raw, cfg, source='/src', base_url='https://ex.com')
    assert [(r.name, r.data, r.identifier) for r in res.roads] == [
        ('L1', ['https://ex.com/p1', 'https://ex.com/p2'], ['e1', 'e2']),
        ('L2', ['https://ex.com/p3'], ['e3'])]
    assert any('缺少字段分隔符' in d for d in res.diagnostics)
    # roadNames 短于线路数：多余线路名称回落
    short = s.parse_chapters(json.dumps({'names': 'L1', 'eps': 'e1$/p1$$$e2$/p2'}), cfg,
                             source='/src', base_url='https://ex.com')
    assert [r.name for r in short.roads] == ['L1', '播放线路2']


def test_parse_chapters_missing_root_variable_raises():
    """variables 声明的路径取不到值时立即抛错（后续 URL 渲染依赖它，不能带着空值继续）。"""
    s = ApiRuleStrategy()
    raw = json.dumps({'episodes': [{'name': 'e1', 'url': '/p1'}]})
    cfg = {'variables': {'v': '$.nope'}, 'episodesPath': '$.episodes[*]',
           'episodeNamePath': '$.name', 'episodeUrlPath': '$.url'}
    try:
        s.parse_chapters(raw, cfg, source='/src', base_url='https://ex.com')
    except ApiRuleFormatException as exc:
        assert 'v' in str(exc) and '$.nope' in str(exc)
    else:
        raise AssertionError('变量未匹配应抛错')


def test_parse_search_api_missing_name_or_source():
    """API 搜索：缺 name/source 的条目跳过并留诊断；identified 全部有效时无诊断。"""
    s = ApiRuleStrategy()
    cfg = {'listPath': '$.data[*]', 'namePath': '$.name', 'sourcePath': '$.url'}
    raw = json.dumps({'data': [{'name': 'a', 'url': 'u1'}, {'name': '', 'url': 'u2'},
                               {'name': 'c'}, {'name': 'd', 'url': 'u4'}]})
    res = s.parse_search(raw, cfg)
    assert [(i.name, i.src) for i in res.items] == [('a', 'u1'), ('d', 'u4')]
    assert len(res.diagnostics) == 2
    assert res.matched_fragments[0] == '{"name": "a", "url": "u1"}'


def test_validate_search_config_paths():
    """validate_search_config：默认路径合法即通过；任一路径非法则以 ApiRuleFormatException 失败。"""
    s = ApiRuleStrategy()
    s.validate_search_config({})
    try:
        s.validate_search_config({'listPath': 'data[*]'})
    except ApiRuleFormatException:
        pass
    else:
        raise AssertionError('非 $ 开头的 listPath 应被拒')


# ================================================================ captcha

def test_ocr_available_reflects_module_state_without_crashing():
    """无 ddddocr 时 ocr_available() 返回 False 且 tried 置位（不会每次重复 import）。"""
    captcha_mod.reset_ocr_cache()
    prior = captcha_mod._ocr_holder['tried']
    available = captcha_mod.ocr_available()
    assert isinstance(available, bool)
    assert captcha_mod._ocr_holder['tried'] is True
    assert prior is False  # reset 后确实清空过（cache 语义）
    assert captcha_mod._ocr_holder['ocr'] is (False if not available else captcha_mod._ocr_holder['ocr'])


def test_load_ocr_double_checked_locking_constructs_once():
    """双检锁：并发下重模型构造只发生一次；失败后 tried 永久置位，不再重试 import。"""
    import threading
    captcha_mod.reset_ocr_cache()
    construct_calls = []
    gate = threading.Event()

    def fake_cls(show_ad=False):
        construct_calls.append(show_ad)
        gate.wait(timeout=5)
        return _FakeOcr('ab12')

    fake_module = mock.MagicMock()
    fake_module.DdddOcr = fake_cls
    barrier = threading.Barrier(8)
    results = []

    def probe():
        barrier.wait(timeout=5)
        results.append(captcha_mod.ocr_available())

    with mock.patch.dict(sys.modules, {'ddddocr': fake_module}):
        threads = [threading.Thread(target=probe) for _ in range(8)]
        for t in threads:
            t.start()
        gate.set()
        for t in threads:
            t.join(timeout=5)
    assert len(construct_calls) == 1, '并发下必须只构造一次'
    assert results == [True] * 8


def test_load_ocr_failure_is_permanently_cached():
    """import 失败/构造异常 → tried=True 且 ocr=False，后续调用直接返回 None（不反复失败）。"""
    captcha_mod.reset_ocr_cache()
    with mock.patch.dict(sys.modules, {}):
        real_import = __builtins__['__import__'] if isinstance(__builtins__, dict) else __builtins__.__import__
        attempts = []

        def failing_import(name, *a, **k):
            if name == 'ddddocr':
                attempts.append(name)
                raise ImportError('no ddddocr here')
            return real_import(name, *a, **k)

        builtins_dict = __builtins__ if isinstance(__builtins__, dict) else vars(__builtins__)
        old = builtins_dict['__import__']
        builtins_dict['__import__'] = failing_import
        try:
            assert captcha_mod._load_ocr() is None
            assert captcha_mod._load_ocr() is None
        finally:
            builtins_dict['__import__'] = old
    assert len(attempts) == 1, 'tried 置位后不应重复 import'
    assert captcha_mod._ocr_holder == {'ocr': False, 'tried': True}


def test_is_plausible_captcha_text_boundaries():
    """长度门槛 [3,8]（strip 后）+ 可打印字符域；控制字符一律拒绝。"""
    assert captcha_mod._CAPTCHA_LEN_MIN == 3 and captcha_mod._CAPTCHA_LEN_MAX == 8
    for text in ['ab3', 'abcdef', 'a' * 8, '   ab3   ']:
        assert captcha_mod.is_plausible_captcha_text(text) is True, text
    for text in ['', None, 'ab', 'a' * 9, 'a\tb', 'a\nb']:
        assert captcha_mod.is_plausible_captcha_text(text) is False, text


def test_recognize_success_returns_text_and_raw_bytes_passthrough():
    """成功路径：classification 收到原始 bytes，strip 后返回文本。"""
    fake = _FakeOcr('  w2x9  ')
    with mock.patch.object(captcha_mod, '_load_ocr', return_value=fake):
        assert captcha_mod.recognize_captcha_bytes(b'image-bytes') == 'w2x9'
    assert fake.seen == [b'image-bytes']


def test_recognize_degrades_on_implausible_result():
    """结果不可信（过短/过长/含控制字符）→ 返回 None，不把噪声透给调用方。"""
    for bad in ['x' * 30, 'ab', '']:
        with mock.patch.object(captcha_mod, '_load_ocr', return_value=_FakeOcr(bad)):
            assert captcha_mod.recognize_captcha_bytes(b'img') is None, bad


def test_recognize_degrades_without_recognizer():
    """无识别器（可选依赖缺席）→ 直接 None，绝不抛异常打断搜索/登录主链路。"""
    for payload in (b'', b'\x00', None, [], {}):
        with mock.patch.object(captcha_mod, '_load_ocr', return_value=None):
            assert captcha_mod.recognize_captcha_bytes(payload) is None
    # 空 bytes 是 falsy，连识别器都不会去取
    assert captcha_mod.recognize_captcha_bytes(b'') is None
    assert captcha_mod.recognize_captcha_bytes(None) is None


def test_recognize_swallows_classification_exception():
    """classification 抛任何异常都被吞掉并降级 None（模型损坏/图片非法不应冒泡）。"""
    for boom in (RuntimeError('model broken'), ValueError('bad image'), TypeError('x')):
        with mock.patch.object(captcha_mod, '_load_ocr', return_value=_FakeOcr(boom)):
            assert captcha_mod.recognize_captcha_bytes(b'img') is None


def test_recognize_non_string_result_is_coerced():
    """识别器返回非字符串（如 int）时按 str() 处理，仍受合法性门槛约束。"""
    with mock.patch.object(captcha_mod, '_load_ocr', return_value=_FakeOcr(12345)):
        assert captcha_mod.recognize_captcha_bytes(b'img') == '12345'
    with mock.patch.object(captcha_mod, '_load_ocr', return_value=_FakeOcr(7)):
        assert captcha_mod.recognize_captcha_bytes(b'img') is None


def test_reset_ocr_cache_clears_state():
    """reset_ocr_cache：测试钩子，清掉 ocr/tried 两个槽位便于注入桩。"""
    captcha_mod._ocr_holder['ocr'] = _FakeOcr('abcd')
    captcha_mod._ocr_holder['tried'] = True
    captcha_mod.reset_ocr_cache()
    assert captcha_mod._ocr_holder == {'ocr': None, 'tried': False}


# ================================================================ 汇总 runner

if __name__ == '__main__':
    passed = 0
    failed = 0
    for name in sorted(globals()):
        if not name.startswith('test_'):
            continue
        fn = globals()[name]
        if not callable(fn):
            continue
        try:
            fn()
            print('PASS %s' % name)
            passed += 1
        except Exception as exc:  # noqa: BLE001 - runner 需要捕获一切以统计
            failed += 1
            print('FAIL %s: %s: %s' % (name, type(exc).__name__, exc))
    print('---- %d passed, %d failed ----' % (passed, failed))
    sys.exit(1 if failed else 0)
