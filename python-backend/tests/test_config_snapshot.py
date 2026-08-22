# -*- coding: utf-8 -*-
"""C2.1 ConfigSnapshot 标准模型 + C2.3 站点字段矩阵。

验收点按任务书拆成六组，每组都覆盖正常/异常/超时/取消四类路径：

* :class:`ThreeLayerSeparationTest` —— 下载结果 / 解析结果 / 运行中配置真的是三层：
  解析层不含运行时对象、可整体丢弃；`base_url` 以**最终** URL 为准；快照 id 能区分
  多仓里的不同子仓；外发视图脱敏。
* :class:`FieldMatrixTest` —— C2.3 字段矩阵按 FongMi `Site.java` 语义取默认值，
  未知字段与未知 type 的原始条目整条保留（纯解析，零 IO）。
* :class:`ConfigShapeTest` —— 明文 / 正文 gzip / 传输层 gzip / JPEG 伪装 / PNG 伪装 /
  带注释 / 多跳跳转 / 非 2xx 七种形态都由离线夹具覆盖，且四种「同一份配置的不同
  载体」必须解出**同一个内容哈希**。
* :class:`PrepareValidateSwapTest` —— 顺序固定 prepare → validate → atomic swap；
  校验不通过时旧健康配置继续服务；同内容重载复用运行中快照不重启 Worker。
* :class:`DepotTest` —— 多仓轨迹、失败回退原因、条目上限截断、嵌套深度上限。
* :class:`TimeoutAndCancelTest` —— 预算耗尽与取消都归因到 L1，且不留下半装配状态。

全部走 `tests/offline_config_server.py` 的 loopback 夹具，不出网。
"""
import json
import os
import sys
import threading
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
for _path in (BASE, HERE, os.path.join(BASE, 'js-engine')):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from offline_config_server import FixtureServer, json_fixture, read_fixture  # noqa: E402
from runtime.config_snapshot import (  # noqa: E402
    DEFAULT_SITE_TIMEOUT_MS, ConfigFetchResult, ConfigSnapshot, ParsedConfig,
    RepoTrail, SiteEntry, content_hash, normalize_site_entry, site_flag,
    split_jar_ref)
from runtime.errors import RuntimeError as RuntimeContractError  # noqa: E402

# 站点资源全部指向 RFC 6761 保留后缀，永远解析不到；用作「解析层不该联网」的探针。
PARSE_BASE = 'https://cdn.fixture.invalid/sub/tv.json'


class _RecordingRunner:
    """替换 `config.SupervisedRunner`：只记录，不起子进程。

    刻意**不**提供 `spider` 属性——`_initialize_site` 会读 `runner.spider.last_error`
    来判断「对象建起来了但初始化失败」，缺失即视为无错误，正好让 CMS/JS 站点走到
    healthy，从而把测试焦点留在快照与替换语义上，而不是运行时可用性。
    """

    instances = []

    def __init__(self, spec):
        self.spec = dict(spec or {})
        self.inits = []
        self.destroyed = 0
        _RecordingRunner.instances.append(self)

    def init(self, ext=''):
        self.inits.append(ext)

    def destroy(self):
        self.destroyed += 1


class _FixtureCase(unittest.TestCase):
    """共享一个 loopback 夹具服务 + 一个干净的 ConfigManager 工厂。"""

    @classmethod
    def setUpClass(cls):
        # 沙箱隔离：本套件的 `mgr.load(...)` 走到 _validate_and_swap 会写
        # ConfigRepositoryCache（hoststate 缓存目录）与 last_repo.txt。hoststate
        # 未配置时默认指向真实用户目录 ~/.yuki——直接 `python -m unittest`
        # 单跑本文件（不经 run_all 的 TEST_ENV）会把用户真实仓库缓存覆盖成
        # 测试夹具（表现为应用重启后磁盘恢复失效、首页停在示例源）。
        # run_all.py 已注入 YUKI_DATA_DIR/YUKI_CACHE_DIR；这里再显式钉到
        # 测试沙箱，双保险。
        import tempfile

        import hoststate
        sandbox_root = os.path.join(BASE, '.test-tmp')
        os.makedirs(sandbox_root, exist_ok=True)
        cls._sandbox = tempfile.mkdtemp(prefix='cfg-snap-', dir=sandbox_root)
        hoststate.configure(
            data_dir=cls._sandbox,
            cache_dir=os.path.join(cls._sandbox, 'cache'),
            plugins_dir=os.path.join(cls._sandbox, 'cache', 'py'),
            log_dir=os.path.join(cls._sandbox, 'logs'))
        cls.fx = FixtureServer().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()
        import shutil
        shutil.rmtree(cls._sandbox, ignore_errors=True)

    def setUp(self):
        _RecordingRunner.instances = []
        patcher = mock.patch('config.SupervisedRunner', _RecordingRunner)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.managers = []

    def tearDown(self):
        for mgr in self.managers:
            try:
                mgr.sites.destroy_all()
            except Exception:
                pass

    def manager(self):
        from config import ConfigManager
        from site_manager import SiteManager

        mgr = ConfigManager(SiteManager())
        # 多仓偏好会把「上次成功的条目」置顶并额外重试一次。它是持久化到
        # YUKI_DATA_DIR/last_repo.txt 的，不固定住的话用例之间会通过磁盘互相影响，
        # 多仓回退顺序的断言就成了「看上一个用例跑了什么」。
        mgr._repo_pref_loaded = True
        mgr.last_repo_name = ''
        mgr._save_repo_pref = lambda _name: None
        self.managers.append(mgr)
        return mgr

    def fetch(self, url):
        """只跑下载层，不解析、不装配。"""
        from config import _LoadContext

        mgr = self.manager()
        return mgr._fetch_config_document(url, _LoadContext(url))


# ---------------------------------------------------------------- C2.1 三层分离


class ThreeLayerSeparationTest(unittest.TestCase):
    def test_parsed_config_holds_no_runtime_objects(self):
        """解析结果必须是纯数据：validate 不通过时它要能被整体丢弃且无副作用。"""
        parsed = ParsedConfig.from_json(json_fixture('single.json'), base_url=PARSE_BASE)
        self.assertEqual(len(parsed.entries), 6)
        for entry in parsed.entries:
            self.assertIsInstance(entry, SiteEntry)
            self.assertIsNone(entry.route, '路由结论属于装配阶段，解析层不得预判')
            json.dumps(entry.raw)                    # 原始条目仍是纯 JSON 值
            json.dumps(entry.to_dict())              # 诊断视图可序列化
        json.dumps(parsed.to_dict())
        json.dumps(parsed.raw_top_level)
        self.assertNotIn('sites', parsed.raw_top_level,
                         'sites 已经在 entries 里，顶层不再存第二份')
        self.assertEqual(parsed.flags, ['youku', 'qq', 'iqiyi'],
                         '逗号分隔的 flags 也要展开成列表')
        self.assertEqual(len(parsed.lives), 1)
        self.assertEqual(parsed.spider,
                         './jar/shared.jar;00000000000000000000000000000000',
                         '顶层 spider 原样保留，解析相对路径是装配层的事')

    def test_parsing_never_touches_the_network(self):
        import http_client

        def explode(*_args, **_kwargs):
            raise AssertionError('解析层发起了网络请求')

        with mock.patch.object(http_client, 'get', explode), \
                mock.patch.object(http_client, 'post', explode):
            ParsedConfig.from_json(json_fixture('relative.json'), base_url=PARSE_BASE)
            ParsedConfig.from_json(json_fixture('unknown_type.json'), base_url=PARSE_BASE)

    def test_base_url_prefers_the_final_url(self):
        """相对 api/jar/ext 必须按**跳转后**的地址解析，否则整仓相对路径全错。"""
        redirected = ConfigFetchResult(source_url='https://a.invalid/tv.json',
                                       final_url='https://b.invalid/sub/tv.json')
        self.assertEqual(redirected.base_url, 'https://b.invalid/sub/tv.json')
        direct = ConfigFetchResult(source_url='https://a.invalid/tv.json')
        self.assertEqual(direct.base_url, 'https://a.invalid/tv.json')
        local = ConfigFetchResult(source_url=r'C:\repo\tv.json',
                                  final_url=r'C:\repo\tv.json', transport='file')
        self.assertEqual(local.base_url, '', '非 http 来源不能当相对路径基址')
        self.assertEqual(ConfigFetchResult(transport='inline').base_url, '')

    def test_content_hash_is_content_addressed(self):
        self.assertEqual(content_hash('{"a":1}'), content_hash(b'{"a":1}'),
                         'str/bytes 必须同哈希，否则同内容判定随载体漂移')
        self.assertNotEqual(content_hash('{"a":1}'), content_hash('{"a": 1}'))
        self.assertEqual(len(content_hash(b'')), 64)

    def test_snapshot_id_distinguishes_depot_entries(self):
        """多仓下同一份清单会选中不同子仓，快照 id 必须能把它们分开。"""
        fetch = ConfigFetchResult(content_hash=content_hash('{"urls":[]}'))
        plain = ConfigSnapshot(fetch=fetch)
        first = ConfigSnapshot(fetch=fetch, depot=RepoTrail(is_depot=True,
                                                           selected_name='alpha'))
        second = ConfigSnapshot(fetch=fetch, depot=RepoTrail(is_depot=True,
                                                            selected_name='beta'))
        self.assertNotEqual(first.snapshot_id, second.snapshot_id)
        self.assertTrue(first.snapshot_id.startswith(plain.snapshot_id))
        self.assertEqual(ConfigSnapshot().snapshot_id, 'nohash')

    def test_snapshot_view_is_serializable_and_redacted(self):
        secret = 'https://cdn.fixture.invalid/tv.json?token=super-secret-value'
        snapshot = ConfigSnapshot(
            fetch=ConfigFetchResult(source_url=secret, final_url=secret,
                                    redirects=[secret],
                                    content_hash=content_hash('x')),
            parsed=ParsedConfig.from_json(json_fixture('single.json'),
                                          base_url=PARSE_BASE),
            reject_reason='validate rejected: %s' % secret)
        payload = snapshot.to_dict(include_entries=True)
        blob = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn('super-secret-value', blob, '外发视图不得带出 token')
        self.assertEqual(payload['state'], 'prepared')
        self.assertEqual(payload['swapSeq'], 0)
        self.assertEqual(len(payload['entries']), 6)
        self.assertEqual(payload['sites'], 0, '未装配的快照站点数为 0')

    def test_healthy_and_built_counts_read_the_site_health(self):
        class _Health:
            def __init__(self, built, healthy):
                self.built, self.healthy = built, healthy

        class _Site:
            def __init__(self, built, healthy):
                self.health = _Health(built, healthy)

        snapshot = ConfigSnapshot(sites=[_Site(True, True), _Site(True, False),
                                         _Site(False, False)])
        self.assertEqual((snapshot.built_count, snapshot.healthy_count), (2, 1))


# ------------------------------------------------------------- C2.3 字段矩阵


class FieldMatrixTest(unittest.TestCase):
    """纯解析层，零 IO：字段语义错了必须在这里就暴露，而不是等站点跑不起来。"""

    def entries(self, name, **kwargs):
        parsed = ParsedConfig.from_json(json_fixture(name), base_url=PARSE_BASE,
                                        **kwargs)
        return {entry.key: entry for entry in parsed.entries}, parsed

    def test_full_matrix_of_a_declared_cms_site(self):
        entries, _ = self.entries('single.json')
        entry = entries['cms_json']
        self.assertEqual((entry.key, entry.name, entry.type),
                         ('cms_json', 'CMS JSON', 1))
        self.assertEqual(entry.api, 'https://fixture.invalid/cms/provide/vod/')
        self.assertEqual(entry.timeout_ms, 8000)
        self.assertTrue(entry.timeout_declared)
        self.assertTrue(entry.searchable)
        self.assertTrue(entry.quick_search)
        self.assertTrue(entry.filterable)
        self.assertFalse(entry.changeable, 'changeable=0 必须关')
        self.assertFalse(entry.danmaku, 'danmaku=0 必须关')
        self.assertFalse(entry.hide)
        self.assertTrue(entry.index, 'indexs=1 必须开')
        self.assertEqual(entry.categories, ['电影', '电视剧'])
        self.assertEqual(entry.play_url, 'https://fixture.invalid/play?u=')
        self.assertEqual(entry.click, 'document.title')
        self.assertEqual(entry.style, {'type': 'rect', 'ratio': 1.33})
        self.assertEqual(entry.header, {'User-Agent': 'okhttp/3.15'})
        self.assertTrue(entry.valid)
        self.assertEqual(entry.unknown_fields, ['vodPlayerBlacklist'])
        self.assertEqual(entry.raw['vodPlayerBlacklist'], 'keep-me',
                         '未知字段整条保留，供后续按真实上游契约补适配器')

    def test_defaults_follow_fongmi_site_getters(self):
        """未声明的开关取 FongMi 默认值，`searchable=2` 按 isSearchable() 算关。"""
        entries, _ = self.entries('single.json')
        entry = entries['cms_xml']
        self.assertFalse(entry.searchable,
                         'FongMi isSearchable() 只认 1，2 表示可搜但被关掉')
        self.assertTrue(entry.quick_search)
        self.assertTrue(entry.filterable)
        self.assertTrue(entry.changeable)
        self.assertTrue(entry.danmaku)
        self.assertFalse(entry.hide)
        self.assertFalse(entry.index)
        self.assertFalse(entry.timeout_declared)
        self.assertEqual(entry.timeout_ms, DEFAULT_SITE_TIMEOUT_MS)
        self.assertEqual(entry.timeout_ms, 15000, 'Constant.TIMEOUT_PLAY = 15s')
        self.assertEqual(entry.categories, [])
        self.assertEqual(entry.header, {})
        self.assertIsNone(entry.style)

    def test_site_flag_semantics(self):
        self.assertTrue(site_flag(None, 1))
        self.assertFalse(site_flag(None, 0))
        self.assertTrue(site_flag(1, 0))
        self.assertFalse(site_flag(0, 1))
        self.assertFalse(site_flag(2, 1), 'searchable=2 → false')
        self.assertFalse(site_flag('nonsense', 0), '脏值退回默认值而不是抛错')
        self.assertTrue(site_flag(True, 0))

    def test_timeout_is_seconds_with_a_one_second_floor(self):
        self.assertEqual(normalize_site_entry(
            {'key': 'k', 'api': 'http://x.invalid', 'timeout': 0}).timeout_ms, 1000)
        self.assertEqual(normalize_site_entry(
            {'key': 'k', 'api': 'http://x.invalid', 'timeout': -5}).timeout_ms, 1000)
        self.assertEqual(normalize_site_entry(
            {'key': 'k', 'api': 'http://x.invalid', 'timeout': 30}).timeout_ms, 30000)
        entry = normalize_site_entry({'key': 'k', 'api': 'http://x.invalid',
                                      'timeout': 'abc'})
        self.assertEqual(entry.timeout_ms, 15000, '非数字 timeout 退回默认 15s')
        self.assertTrue(entry.timeout_declared, '声明过就是声明过，只是值不可用')

    def test_header_accepts_object_alias_and_json_in_string(self):
        as_object = normalize_site_entry({'key': 'k', 'api': 'http://x.invalid',
                                          'header': {'Referer': 'https://a.invalid/'}})
        self.assertEqual(as_object.header, {'Referer': 'https://a.invalid/'})
        alias = normalize_site_entry({'key': 'k', 'api': 'http://x.invalid',
                                      'headers': {'Cookie': 'a=1'}})
        self.assertEqual(alias.header, {'Cookie': 'a=1'}, 'headers 是常见别名')
        in_string = normalize_site_entry({'key': 'k', 'api': 'http://x.invalid',
                                          'header': '{"User-Agent":"okhttp/3.15"}'})
        self.assertEqual(in_string.header, {'User-Agent': 'okhttp/3.15'},
                         'FongMi HeaderAdapter：字符串里的 JSON 也要吃下')
        broken = normalize_site_entry({'key': 'k', 'api': 'http://x.invalid',
                                       'header': '{not json'})
        self.assertEqual(broken.header, {}, '坏 header 不能让整条站点报废')
        self.assertTrue(broken.valid)
        self.assertEqual(normalize_site_entry(
            {'key': 'k', 'api': 'http://x.invalid', 'header': 'plain'}).header, {})

    def test_categories_accept_list_and_comma_string(self):
        self.assertEqual(normalize_site_entry(
            {'key': 'k', 'api': 'http://x.invalid',
             'categories': ['电影', '', '剧集']}).categories, ['电影', '剧集'])
        self.assertEqual(normalize_site_entry(
            {'key': 'k', 'api': 'http://x.invalid',
             'categories': '电影, 剧集 ,'}).categories, ['电影', '剧集'])

    def test_style_is_normalized_or_dropped(self):
        from runtime.config_snapshot import normalize_style

        self.assertEqual(normalize_style({'type': 'oval', 'ratio': '1.5'}),
                         {'type': 'oval', 'ratio': 1.5})
        self.assertEqual(normalize_style({'type': 'list'}), {'type': 'list'})
        self.assertEqual(normalize_style({'ratio': 'x'}), None,
                         '不可用的 style 返回 None，由运行时回退 rect')
        self.assertEqual(normalize_style('rect'), None)

    def test_unknown_type_and_unknown_top_field_survive_intact(self):
        """未知 type 的条目不能被丢掉——诊断页要能说明「这条为什么没跑」。"""
        entries, parsed = self.entries('unknown_type.json')
        self.assertIn('brandNewTopField', parsed.unknown_fields)
        self.assertEqual(parsed.raw_top_level['brandNewTopField'], {'kept': True})
        future = entries['future_type']
        self.assertEqual(future.type, 99, '未知 type 原样保留，不折叠成 0')
        self.assertEqual(future.raw['type'], 99)
        self.assertEqual(future.unknown_fields, ['brandNewSiteField'])
        self.assertEqual(future.raw['brandNewSiteField'], [1, 2, 3])
        self.assertTrue(future.valid, '未知 type 不等于条目非法')

    def test_null_type_is_zero_like_gson(self):
        self.assertEqual(normalize_site_entry(
            {'key': 'k', 'api': 'http://x.invalid', 'type': None}).type, 0)
        self.assertEqual(normalize_site_entry(
            {'key': 'k', 'api': 'http://x.invalid'}).type, 0)

    def test_malformed_entries_are_marked_not_dropped(self):
        parsed = ParsedConfig.from_json(
            {'sites': ['oops', {'name': 'no key', 'api': 'http://x.invalid'},
                       {'key': 'no_api'}]},
            base_url=PARSE_BASE)
        self.assertEqual(len(parsed.entries), 3, '非法条目也要留在矩阵里')
        self.assertFalse(parsed.entries[0].valid)
        self.assertEqual(parsed.entries[0].invalid_reason, 'site 条目不是 JSON 对象')
        self.assertFalse(parsed.entries[1].valid)
        self.assertIn('key', parsed.entries[1].invalid_reason)
        self.assertFalse(parsed.entries[2].valid)

    def test_ext_is_preserved_as_the_raw_json_value(self):
        """ext 归一化与展开是运行时契约（C2.2）；矩阵层只能原样带过去。

        压成字符串会让 type=3/type=4 的差别在这里就消失（`SiteApi.java:73`
        只对 type=4 展开），后面再也补不回来。
        """
        entries, _ = self.entries('single.json')
        self.assertEqual(entries['js_remote'].ext, '{"cate":"all"}')
        self.assertEqual(entries['py_remote'].ext, 'plain-text-ext')
        self.assertEqual(entries['cms_xml'].ext, '', '未声明 ext → 空字符串')
        rel, _ = self.entries('relative.json')
        self.assertEqual(rel['rel_js'].ext, {'host': './lib/host.json', 'keep': 7},
                         '对象形态的 ext 必须保持对象，内部相对路径由 ExtResolver 解')
        self.assertEqual(rel['rel_js'].to_dict()['extType'], 'dict')
        self.assertEqual(rel['rel_cms'].ext, './lib/site_ext.json')

    def test_relative_api_jar_and_play_url_resolve_against_the_config_url(self):
        entries, _ = self.entries('relative.json')
        self.assertEqual(entries['rel_js'].api,
                         'https://cdn.fixture.invalid/sub/js/rel_site.js')
        self.assertEqual(entries['rel_cms'].play_url,
                         'https://cdn.fixture.invalid/sub/play/')
        self.assertEqual(entries['rel_cms'].api,
                         'https://fixture.invalid/rel/provide/vod/',
                         '绝对地址不能被基址改写')
        jar = entries['rel_jar']
        self.assertEqual(jar.jar, 'https://cdn.fixture.invalid/sub/jar/site.jar')
        self.assertEqual(jar.jar_md5, '2' * 32)
        self.assertTrue(jar.jar_from_site)

    def test_site_jar_beats_the_shared_spider(self):
        entries, _ = self.entries('single.json')
        shared = entries['jar_class']
        self.assertEqual(shared.jar, 'https://cdn.fixture.invalid/sub/jar/shared.jar',
                         '未声明站点 jar 时继承顶层 spider（并按配置 URL 解相对路径）')
        self.assertEqual(shared.jar_md5, '0' * 32)
        self.assertFalse(shared.jar_from_site)
        own = entries['jar_direct']
        self.assertEqual(own.jar, 'https://fixture.invalid/jar/site.jar')
        self.assertEqual(own.jar_md5, '1' * 32)
        self.assertTrue(own.jar_from_site, '站点自带 jar 优先于共享 spider')

    def test_shared_spider_override_is_used_when_given(self):
        """装配层传入的是**已解析成 http 的**共享 jar；矩阵层必须用它而不是原始值。"""
        entries, parsed = self.entries(
            'single.json', shared_spider='https://cdn.invalid/x.jar;' + 'a' * 32)
        self.assertEqual(entries['jar_class'].jar, 'https://cdn.invalid/x.jar')
        self.assertEqual(entries['jar_class'].jar_md5, 'a' * 32)
        self.assertEqual(parsed.spider,
                         './jar/shared.jar;00000000000000000000000000000000',
                         '顶层原始 spider 仍然原样保留')

    def test_split_jar_ref_keeps_disguised_suffixes(self):
        """TVBox 的 jar 常伪装成 .jpg/.png/.bin，拆引用时不能按后缀过滤。"""
        self.assertEqual(split_jar_ref('https://x.invalid/f.jpg;abc'),
                         ('https://x.invalid/f.jpg', 'abc'))
        self.assertEqual(split_jar_ref('./j/f.bin', PARSE_BASE),
                         ('https://cdn.fixture.invalid/sub/j/f.bin', ''))
        self.assertEqual(split_jar_ref(''), ('', ''))
        self.assertEqual(split_jar_ref('https://x.invalid/f.jar;'),
                         ('https://x.invalid/f.jar', ''))

    def test_pan_sites_are_flagged_by_api(self):
        self.assertTrue(normalize_site_entry(
            {'key': 'k', 'api': 'https://x.invalid/quark/api'}).is_pan)
        self.assertFalse(normalize_site_entry(
            {'key': 'k', 'api': 'https://x.invalid/cms/api'}).is_pan)


# --------------------------------------------------------------- 配置形态


class ConfigShapeTest(_FixtureCase):
    """七种配置形态的离线夹具；只跑下载层，不装配站点。"""

    def test_four_carriers_of_one_config_agree_on_the_content_hash(self):
        expected_text = read_fixture('single.json')
        expected_hash = content_hash(expected_text)
        shapes = {
            'single.json': '',            # 明文
            'single.json.gz': 'gzip',     # 正文本身是 gzip（tv.json.gz 直链）
            'disguise.jpg': 'image',      # JPEG 尾附 base64（饭太硬系）
            'disguise.png': 'image',      # PNG 尾附 base64（哈基米系）
        }
        for name, disguise in shapes.items():
            text, fetch = self.fetch(self.fx.config(name))
            self.assertEqual(fetch.status, 200, name)
            self.assertEqual(fetch.disguise, disguise, name)
            self.assertEqual(json.loads(text), json_fixture('single.json'), name)
            self.assertEqual(text, expected_text, name)
            self.assertEqual(fetch.content_hash, expected_hash,
                             '%s 与明文必须同哈希，否则同内容判定随载体漂移' % name)
        # 明文与「正文 gzip」在解压后是同一串字节，因此体积也必须相同。
        self.assertEqual(self.fetch(self.fx.config('single.json'))[1].size,
                         self.fetch(self.fx.config('single.json.gz'))[1].size)

    def test_transport_level_gzip_is_handled_below_us(self):
        """CDN 发 Content-Encoding: gzip 时由传输层解掉，宿主看到的是明文。

        这一支与 `single.json.gz` 是不同的形态：前者的体积上限落在流式读取
        （对解码后的字节计量），后者落在宿主自己的解压上限。两条都要有夹具。
        """
        text, fetch = self.fetch(self.fx.url('config-encoded/single.json'))
        self.assertEqual(fetch.status, 200)
        self.assertEqual(fetch.disguise, '', '传输层压缩不算「伪装」')
        self.assertEqual(fetch.content_hash, content_hash(read_fixture('single.json')))
        self.assertEqual(json.loads(text), json_fixture('single.json'))

    def test_image_disguise_reports_its_decoding(self):
        _text, fetch = self.fetch(self.fx.config('disguise.jpg'))
        self.assertEqual(fetch.encoding, 'base64/utf-8')
        self.assertGreater(fetch.size, len(read_fixture('single.json')),
                           '图片形态的 size 是图片本身的字节数')

    def test_comments_are_stripped_without_eating_urls(self):
        from config import parse_config_json

        text, fetch = self.fetch(self.fx.config('commented.json'))
        self.assertEqual(fetch.status, 200)
        cfg = parse_config_json(text)
        self.assertEqual(len(cfg['sites']), 1)
        self.assertEqual(cfg['sites'][0]['api'],
                         'https://fixture.invalid/commented/provide/vod/',
                         'URL 里的 // 不能被当成行内注释剥掉')

    def test_redirect_chain_defines_the_relative_base(self):
        text, fetch = self.fetch(self.fx.url('hop/2'))
        self.assertEqual(fetch.status, 200)
        self.assertEqual(len(fetch.redirects), 2)
        self.assertTrue(fetch.redirects[0].endswith('/hop/2'))
        self.assertTrue(fetch.redirects[1].endswith('/hop/1'))
        self.assertTrue(fetch.final_url.endswith('/hop/0'))
        self.assertEqual(fetch.base_url, fetch.final_url,
                         '相对 api/jar/ext 要按最终 URL 解析')
        self.assertNotEqual(fetch.base_url, fetch.source_url)
        self.assertEqual(json.loads(text), json_fixture('single.json'))

    def test_non_2xx_body_is_a_fetch_error_not_a_config(self):
        """404/403 常带一段 HTML 或 JSON 错误页，把它当正文解析会报错到 L1:parse。"""
        with self.assertRaisesRegex(ValueError, r'^\[L1:fetch\].*404'):
            self.fetch(self.fx.config('does_not_exist.json'))

    def test_empty_body_is_reported_as_unreachable(self):
        with self.assertRaisesRegex(ValueError, r'^\[L1:fetch\].*空内容'):
            self.fetch(self.fx.url('ext/empty'))

    def test_inline_json_needs_no_transport(self):
        text, fetch = self.fetch('{"sites": []}')
        self.assertEqual(text, '{"sites": []}')
        self.assertEqual(fetch.transport, 'inline')
        self.assertEqual(fetch.base_url, '')
        self.assertEqual(fetch.content_hash, content_hash('{"sites": []}'))


# --------------------------------------------- prepare → validate → swap


class PrepareValidateSwapTest(_FixtureCase):
    def test_order_is_prepare_then_validate_then_atomic_swap(self):
        mgr = self.manager()
        order = []
        real_prepare, real_validate, real_apply = mgr._prepare, mgr._validate, mgr._apply

        def prepare(*args, **kwargs):
            order.append('prepare')
            self.assertEqual(len(mgr.sites.sites), 0)
            return real_prepare(*args, **kwargs)

        def validate(prepared, **kwargs):
            order.append('validate')
            # 校验发生在替换**之前**：这一步失败必须什么都还没换上去。
            self.assertEqual(len(mgr.sites.sites), 0, 'validate 前不得安装新站点')
            self.assertIsNone(mgr.snapshot)
            self.assertEqual(prepared['snapshot'].state, 'prepared')
            return real_validate(prepared, **kwargs)

        def apply_(prepared):
            order.append('apply')
            return real_apply(prepared)

        mgr._prepare, mgr._validate, mgr._apply = prepare, validate, apply_
        summary = mgr.load(self.fx.config('depot_good.json'))
        self.assertEqual(order, ['prepare', 'validate', 'apply'])
        self.assertEqual(summary['built'], 1)
        self.assertEqual(mgr.snapshot.state, 'running')
        self.assertEqual(mgr.snapshot.swap_seq, 1)
        self.assertEqual(mgr.swap_count, 1)
        self.assertIs(mgr.last_healthy_snapshot, mgr.snapshot)

    def test_first_load_installs_the_snapshot_together_with_the_sites(self):
        mgr = self.manager()
        summary = mgr.load(self.fx.config('depot_good.json'))
        snapshot = mgr.snapshot
        self.assertEqual(summary['snapshotId'], snapshot.snapshot_id)
        self.assertEqual(snapshot.source_hash, snapshot.fetch.content_hash)
        self.assertEqual([s.key for s in mgr.sites.sites], ['depot_good_cms'])
        self.assertIs(snapshot.sites[0], mgr.sites.sites[0],
                      '快照与运行中站点列表必须是同一批对象')
        self.assertEqual(snapshot.fetch.transport, 'http')
        self.assertEqual(snapshot.fetch.base_url, self.fx.config('depot_good.json'))
        self.assertEqual(len(snapshot.routes), 1)
        self.assertEqual(snapshot.routes[0].runtime, 'cms')
        self.assertGreater(snapshot.loaded_at, 0)
        self.assertIn('policy', snapshot.security)
        json.dumps(mgr.state())

    def test_same_content_reload_reuses_the_running_snapshot(self):
        mgr = self.manager()
        mgr.load(self.fx.config('depot_good.json'))
        first_sites = list(mgr.sites.sites)
        first_snapshot = mgr.snapshot
        created = len(_RecordingRunner.instances)

        summary = mgr.load(self.fx.config('depot_good.json'))
        self.assertTrue(summary['reused'])
        self.assertEqual(mgr.reuse_count, 1)
        self.assertEqual(mgr.swap_count, 1, '同内容不算一次替换')
        self.assertIs(mgr.snapshot, first_snapshot)
        self.assertTrue(mgr.snapshot.fetch.from_cache)
        self.assertEqual(len(_RecordingRunner.instances), created,
                         '同内容重载不得新建 Worker')
        for before, after in zip(first_sites, mgr.sites.sites):
            self.assertIs(before, after)
        self.assertEqual([r.destroyed for r in _RecordingRunner.instances], [0] * created)

    def test_force_rebuilds_even_when_the_content_is_identical(self):
        mgr = self.manager()
        mgr.load(self.fx.config('depot_good.json'))
        old_runner = _RecordingRunner.instances[0]
        old_snapshot = mgr.snapshot

        summary = mgr.load(self.fx.config('depot_good.json'), force=True)
        self.assertFalse(summary['reused'])
        self.assertEqual(mgr.swap_count, 2)
        self.assertEqual(mgr.reuse_count, 0)
        self.assertIsNot(mgr.snapshot, old_snapshot)
        self.assertEqual(old_snapshot.state, 'retired')
        self.assertEqual(old_runner.destroyed, 1, '被替换掉的 Worker 必须回收')
        self.assertEqual(len(_RecordingRunner.instances), 2)

    def test_reuse_is_refused_when_nothing_in_the_running_snapshot_is_healthy(self):
        """全站点不健康时重新载入是合理的恢复动作，必须真正重建。"""
        mgr = self.manager()
        mgr.load(self.fx.config('depot_good.json'))
        for site in mgr.sites.sites:
            site.health.healthy = False
        self.assertEqual(mgr.snapshot.healthy_count, 0)

        summary = mgr.load(self.fx.config('depot_good.json'))
        self.assertFalse(summary['reused'])
        self.assertEqual(mgr.reuse_count, 0)
        self.assertEqual(mgr.swap_count, 2)

    def test_a_config_that_builds_nothing_keeps_the_old_healthy_one(self):
        mgr = self.manager()
        mgr.load(self.fx.config('depot_good.json'))
        healthy_snapshot = mgr.snapshot
        healthy_sites = list(mgr.sites.sites)

        with self.assertRaises(RuntimeContractError) as caught:
            mgr.load(json.dumps({'sites': [
                {'key': 'future', 'name': '未来 type', 'type': 99,
                 'api': 'https://fixture.invalid/future/'}]}))
        error = caught.exception
        self.assertEqual(error.code, 'L1_CONFIG_PARSE_FAILED')
        self.assertIn('[L1:validate]', error.message)
        self.assertEqual(error.details['configured'], 1)
        self.assertEqual(error.details['built'], 0)
        self.assertEqual(error.details['retainedSnapshot'], healthy_snapshot.snapshot_id)
        self.assertEqual(error.details['retainedHealthy'], 1)
        # 旧配置继续服务：站点、快照、诊断都没被动过。
        self.assertEqual(mgr.sites.sites, healthy_sites)
        self.assertIs(mgr.snapshot, healthy_snapshot)
        self.assertEqual(mgr.snapshot.state, 'running')
        self.assertEqual(mgr.swap_count, 1)
        self.assertIs(mgr.last_healthy_snapshot, healthy_snapshot)
        self.assertEqual(healthy_sites[0].health.healthy, True)

    def test_zero_sites_is_applied_when_there_is_nothing_to_protect(self):
        """空状态下 0 站点是要如实呈现的结果，不能被「保留旧配置」的规则挡住。"""
        mgr = self.manager()
        summary = mgr.load(json.dumps({'sites': [
            {'key': 'future', 'name': '未来 type', 'type': 99,
             'api': 'https://fixture.invalid/future/'}]}))
        self.assertEqual((summary['configured'], summary['built']), (1, 0))
        self.assertEqual(len(summary['skipped']), 1)
        self.assertEqual(mgr.swap_count, 1)
        self.assertEqual(mgr.snapshot.state, 'running')
        self.assertIsNone(mgr.last_healthy_snapshot)
        self.assertEqual(len(mgr.sites.diagnostics), 1,
                         '建不起来的条目也要留下诊断')

    def test_duplicate_keys_are_rejected_and_their_workers_released(self):
        """重复 key 会让 `/site?key=` 的路由不确定；被拒的候选必须当场回收。"""
        mgr = self.manager()
        with self.assertRaises(RuntimeContractError) as caught:
            mgr.load(json.dumps({'sites': [
                {'key': 'dup', 'name': 'A', 'type': 1,
                 'api': 'https://fixture.invalid/a/provide/vod/'},
                {'key': 'dup', 'name': 'B', 'type': 1,
                 'api': 'https://fixture.invalid/b/provide/vod/'}]}))
        self.assertEqual(caught.exception.details['duplicateKeys'], ['dup'])
        self.assertEqual(mgr.sites.sites, [])
        self.assertIsNone(mgr.snapshot)
        self.assertEqual(mgr.swap_count, 0)
        self.assertEqual(len(_RecordingRunner.instances), 2)
        for runner in _RecordingRunner.instances:
            self.assertEqual(runner.destroyed, 1, '被拒配置起的 Worker 不能残留')

    def test_full_config_reports_every_stage_of_the_lifecycle(self):
        """六种站点形态一次载入：built/healthy/skipped 必须逐条对得上。

        `fixture.invalid` 与 loopback 上不存在的 jar 让 python/jar 三条如实失败——
        这正是「站点对象建起来了」不等于「可用」的地方。
        """
        mgr = self.manager()
        summary = mgr.load(self.fx.config('single.json'))
        self.assertEqual(summary['configured'], 6)
        self.assertEqual(summary['built'], 3)
        self.assertEqual(summary['healthy'], 3)
        self.assertEqual(sorted(s.key for s in mgr.sites.sites),
                         ['cms_json', 'cms_xml', 'js_remote'])
        self.assertEqual(len(summary['skipped']), 3)
        reasons = {line.split(':', 1)[0]: line for line in summary['skipped']}
        self.assertIn('[L3:py]', reasons['py_remote'])
        self.assertIn('[L3:jar]', reasons['jar_class'])
        self.assertIn('[L3:jar]', reasons['jar_direct'])
        self.assertEqual(summary['runtimes'],
                         {'cms': 2, 'js': 1, 'python': 1, 'jar': 2})
        self.assertEqual(summary['unknownTypes'], [])
        self.assertEqual(summary['hidden'], 0)
        self.assertEqual(len(mgr.sites.diagnostics), 6, '失败的条目也要有诊断')
        state = mgr.state()
        self.assertEqual(state['summary'],
                         {'configured': 6, 'built': 3, 'initialized': 3, 'healthy': 3})
        self.assertEqual(state['snapshot']['parsed']['siteCount'], 6)
        self.assertEqual(state['snapshot']['state'], 'running')
        self.assertEqual(state['swapCount'], 1)
        json.dumps(state)

    def test_field_matrix_reaches_the_built_site(self):
        mgr = self.manager()
        mgr.load(self.fx.config('single.json'))
        site = next(s for s in mgr.sites.sites if s.key == 'cms_json')
        self.assertEqual(site.timeout_ms, 8000)
        self.assertFalse(site.changeable)
        self.assertFalse(site.danmaku)
        self.assertTrue(site.index)
        self.assertEqual(site.categories, ['电影', '电视剧'])
        self.assertEqual(site.play_url, 'https://fixture.invalid/play?u=')
        self.assertEqual(site.click, 'document.title')
        self.assertEqual(site.style, {'type': 'rect', 'ratio': 1.33})
        self.assertEqual(site.headers, {'User-Agent': 'okhttp/3.15'})
        self.assertEqual(site.entry.raw['vodPlayerBlacklist'], 'keep-me')
        xml = next(s for s in mgr.sites.sites if s.key == 'cms_xml')
        self.assertFalse(xml.searchable, 'searchable=2 一路到 Site 都是关')
        self.assertEqual(xml.timeout_ms, 15000)


# ------------------------------------------------------------ 多仓（depot）


class DepotTest(_FixtureCase):
    def test_first_working_entry_is_selected_and_the_trail_is_recorded(self):
        mgr = self.manager()
        summary = mgr.load(self.fx.config('depot.json'))
        depot = summary['depot']
        self.assertTrue(depot['isDepot'])
        self.assertEqual(depot['declared'], 3)
        self.assertEqual(depot['truncated'], 0)
        self.assertEqual([item['name'] for item in depot['attempted']],
                         ['broken-first', 'good-second'],
                         '选中即停：第三条不该被尝试')
        self.assertEqual(depot['selected']['name'], 'good-second')
        self.assertEqual(depot['selected']['url'], self.fx.config('depot_good.json'))
        self.assertEqual([f['name'] for f in depot['failures']], ['broken-first'])
        self.assertIn('404', depot['failures'][0]['reason'],
                      '失败原因要说「这一条 404」，而不是「这一条没有 sites」')
        # 跨仓合并（只增不删）：主条目出影片源，其余条目补 lives/sites。
        self.assertEqual(sorted(s.key for s in mgr.sites.sites),
                         ['depot_extra_cms', 'depot_good_cms'])
        self.assertEqual(sorted(l['name'] for l in mgr.lives),
                         ['depot-extra-live', 'depot-good-live'])
        self.assertEqual(len(depot['merged']), 1)
        snapshot = mgr.snapshot
        self.assertEqual(snapshot.fetch.transport, 'depot')
        self.assertEqual(snapshot.fetch.source_url, self.fx.config('depot.json'),
                         '快照的源是用户输入的多仓地址')
        self.assertTrue(snapshot.snapshot_id.endswith('-good-second'))
        self.assertEqual(summary['snapshotId'], snapshot.snapshot_id)
        self.assertEqual(mgr.state()['depot']['selected']['name'], 'good-second')

    def test_depot_reuse_key_covers_both_the_manifest_and_the_chosen_entry(self):
        mgr = self.manager()
        mgr.load(self.fx.config('depot.json'))
        digest = mgr.snapshot.source_hash
        self.assertNotEqual(digest, mgr.snapshot.fetch.content_hash,
                            '多仓的复用判据不能只看清单')
        summary = mgr.load(self.fx.config('depot.json'))
        self.assertTrue(summary['reused'])
        self.assertEqual(mgr.snapshot.source_hash, digest)

    def test_entry_list_is_truncated_and_the_tail_is_never_fetched(self):
        from config import MAX_MULTI_REPO_ENTRIES

        mgr = self.manager()
        declared = len(json_fixture('depot_truncate.json')['urls'])
        dropped = declared - MAX_MULTI_REPO_ENTRIES
        self.assertGreater(dropped, 0,
                           '夹具条目数必须多于上限，否则这条根本没在测截断')
        tail = ['trunc_tail_a.json', 'trunc_tail_b.json'][-dropped:]
        before = [self.fx.hits('/config/%s' % name) for name in tail]
        summary = mgr.load(self.fx.config('depot_truncate.json'))
        depot = summary['depot']
        self.assertEqual(depot['declared'], declared)
        self.assertEqual(depot['truncated'], dropped)
        self.assertEqual(len(depot['attempted']), MAX_MULTI_REPO_ENTRIES)
        self.assertEqual(depot['selected']['name'], 'good')
        for name, hits in zip(tail, before):
            # `_merge_repo_extras` 收到的是**截断后**的条目表，所以被截掉的尾部
            # 连「补拉 lives/sites」这一步也不会去打。
            self.assertEqual(self.fx.hits('/config/%s' % name), hits,
                             '截断掉的条目连合并阶段也不能去打')

    def test_nested_depot_is_refused_at_depth_one(self):
        """子仓再是一个多仓清单时必须停住——否则远端内容能驱动无界递归抓取。"""
        mgr = self.manager()
        before = self.fx.hits('/config/depot_good.json')
        with self.assertRaisesRegex(
                ValueError, r'^\[L1:fetch\] all multi-repo entries failed'):
            mgr.load(self.fx.config('depot_nested.json'))
        self.assertEqual(self.fx.hits('/config/depot_good.json'), before,
                         '内层清单里的子仓一个都不能被抓')
        self.assertEqual(mgr.sites.sites, [])
        self.assertIsNone(mgr.snapshot)

    def test_all_entries_failing_raises_with_the_first_reason(self):
        mgr = self.manager()
        with self.assertRaisesRegex(ValueError, r'404'):
            mgr.load(self.fx.config('depot_all_bad.json'))
        self.assertEqual(mgr.sites.sites, [])
        self.assertIsNone(mgr.snapshot)

    def test_a_sub_repo_that_builds_nothing_falls_through_to_the_next(self):
        """候选子仓一个站点都没建成时要继续回退，并且回收它已经起好的 Worker。"""
        mgr = self.manager()
        summary = mgr.load(self.fx.config('depot_fallback.json'))
        self.assertEqual(summary['depot']['selected']['name'], 'good-second')
        self.assertEqual([f['reason'] for f in summary['depot']['failures']],
                         ['0 sites'],
                         '「声明了站点但一个都装配不出来」要和「拉不到」分开报')
        self.assertEqual(sorted(s.key for s in mgr.sites.sites), ['depot_good_cms'])
        # 被弃候选进入 T44 合并：它的 lives 不需要 spider，按「只增不删」并入；
        # 它那个 type=99 的站点则以 L2 装配失败留在诊断里，而不是悄悄消失。
        self.assertEqual(sorted(l['name'] for l in mgr.lives),
                         ['depot-empty-live', 'depot-good-live'])
        health = {d.site_key: d for d in mgr.sites.diagnostics}
        self.assertIn('depot_empty_future', health)
        self.assertFalse(health['depot_empty_future'].built)
        self.assertTrue(health['depot_good_cms'].healthy)

    def test_sub_repo_pointing_at_a_private_address_is_blocked_in_strict_mode(self):
        """严格 SSRF 模式（YUKI_CONFIG_BLOCK_PRIVATE_NETWORK=1）：子仓地址来自远端
        内容，不能借它探测本机/内网服务。

        清单本身是从 loopback 取回的，所以这一条同时在验证「同源信任是
        scheme+host+port，而不是只要沾上本机就全放行」。桌面端默认已放开
        （局域网 NAS / 本机服务子仓是合理场景），严格模式仅作为可选项保留。
        """
        mgr = self.manager()
        with mock.patch.dict(os.environ, {'YUKI_CONFIG_BLOCK_PRIVATE_NETWORK': '1'}):
            with self.assertRaises(ValueError) as caught:
                mgr.load(self.fx.config('depot_private.json'))
        self.assertRegex(str(caught.exception),
                         r'^\[L1:fetch\] all multi-repo entries failed')
        self.assertIn('private_network_blocked', str(caught.exception))
        self.assertEqual(mgr.sites.sites, [])


# ---------------------------------------------------------- 超时 / 取消


class TimeoutAndCancelTest(_FixtureCase):
    def test_budget_exhaustion_is_reported_as_l1_timeout(self):
        mgr = self.manager()
        with self.assertRaises(RuntimeContractError) as caught:
            mgr.load(self.fx.url('slow.json?ms=1500'), budget=0.3)
        self.assertEqual(caught.exception.code, 'L1_CONFIG_TIMEOUT')
        self.assertEqual(mgr.sites.sites, [], '超时不得留下半装配的配置')
        self.assertIsNone(mgr.snapshot)
        self.assertEqual(mgr.swap_count, 0)

    def test_load_reports_build_progress(self):
        """加载过程向宿主上报进度（恢复/导入进度条）：单仓报 build 阶段站点完成数，
        多仓另报 fetch 阶段子仓序号；回调异常不影响加载。"""
        mgr = self.manager()
        records = []
        summary = mgr.load(self.fx.config('single.json'),
                           progress_cb=lambda s, c, t: records.append((s, c, t)))
        builds = [r for r in records if r[0] == 'build']
        self.assertTrue(builds, '单仓加载应上报 build 进度')
        total = summary['configured']
        self.assertEqual(builds[-1][1], total, '最终 build 进度 = 站点总数')
        self.assertEqual(builds[-1][2], total)

        mgr2 = self.manager()
        records2 = []
        mgr2.load(self.fx.config('depot_fallback.json'),
                  progress_cb=lambda s, c, t: records2.append((s, c, t)))
        self.assertTrue(any(r[0] == 'fetch' for r in records2), '多仓加载应上报 fetch 进度')
        self.assertTrue(any(r[0] == 'build' for r in records2), '多仓加载应上报 build 进度')
        self.assertTrue(any(r[0] == 'merge' for r in records2), '多仓合并应上报 merge 进度')
        merges = [r for r in records2 if r[0] == 'merge']
        self.assertEqual(merges[-1][1], merges[-1][2], '合并进度最终收满')

    def test_restore_merge_phase_is_budget_capped(self):
        """恢复模式（salvage_partial）下合并阶段只给零头时间：构建满格后附加仓
        的死镜像站点曾把恢复尾巴拖长，进度条停在满格长时间不动。"""
        import time as _time

        from config import _LoadContext, RESTORE_MERGE_BUDGET

        mgr = self.manager()
        ctx = _LoadContext('https://x.invalid/repo.json', budget=300,
                           salvage_partial=True)
        with mgr._ctx_lock:
            mgr._ctx = ctx
        try:
            prepared = {'sites': [], 'source_url': 'https://x.invalid/primary.json',
                        'diagnostics': [], 'lives': [],
                        'summary': {'skipped': [], 'build_errors': {}}}
            mgr._merge_repo_extras(prepared, {}, [], manifest_base='')
            self.assertLessEqual(ctx.deadline, _time.monotonic() + RESTORE_MERGE_BUDGET + 1,
                                 '恢复模式的合并阶段截止时间被压到零头预算内')
        finally:
            with mgr._ctx_lock:
                mgr._ctx = None
        # 回调抛异常不影响加载主流程
        mgr3 = self.manager()
        summary3 = mgr3.load(self.fx.config('single.json'),
                             progress_cb=lambda *a: (_ for _ in ()).throw(RuntimeError('boom')))
        self.assertGreaterEqual(summary3['sites'], 1)

    def test_restore_salvages_partial_build_on_budget_timeout(self):
        """磁盘恢复（salvage_partial）：构建期预算耗尽时保留已建成站点继续 swap，
        而不是整体失败——恢复被个别慢站点（死镜像 ext）拖垮时，回退网络重载会
        让用户长时间停在示例源（「重启后不加载缓存」）。取消仍须整体失败。"""
        import time as _time

        from config import ConfigManager
        from site_manager import SiteManager

        class _SlowSecondSite(ConfigManager):
            def _build_site(self, item, base_url='', spider_jar=''):
                if item.get('key') == 'slow':
                    _time.sleep(1.5)  # 超过 budget，模拟死镜像 ext 下载
                return super()._build_site(item, base_url, spider_jar)

        cfg = {'sites': [
            {'key': 'fast', 'name': 'F', 'type': 1, 'api': 'https://fixture.invalid/a/provide/vod/'},
            {'key': 'slow', 'name': 'S', 'type': 1, 'api': 'https://fixture.invalid/b/provide/vod/'},
        ]}
        mgr = _SlowSecondSite(SiteManager())
        mgr._repo_pref_loaded = True
        mgr.last_repo_name = ''
        self.managers.append(mgr)
        summary = mgr.load(json.dumps(cfg), budget=0.6, salvage_partial=True)
        self.assertGreaterEqual(summary['sites'], 1, '预算内建成的站点保留生效')
        self.assertIsNotNone(mgr.snapshot, '部分结果照常 swap')
        self.assertEqual([s.key for s in mgr.sites.sites], ['fast'])

        # 既有契约不变：非恢复模式的构建期超时仍整体失败
        mgr2 = _SlowSecondSite(SiteManager())
        mgr2._repo_pref_loaded = True
        mgr2.last_repo_name = ''
        self.managers.append(mgr2)
        with self.assertRaises(RuntimeContractError) as caught:
            mgr2.load(json.dumps(cfg), budget=0.6)
        self.assertEqual(caught.exception.code, 'L1_CONFIG_TIMEOUT')
        self.assertIsNone(mgr2.snapshot)

    def test_cancel_before_the_first_request_sends_nothing(self):
        mgr = self.manager()
        cancel = threading.Event()
        cancel.set()
        before = self.fx.hits('/config/single.json')
        with self.assertRaises(RuntimeContractError) as caught:
            mgr.load(self.fx.config('single.json'), cancel_event=cancel)
        self.assertEqual(caught.exception.code, 'L1_CONFIG_CANCELLED')
        self.assertEqual(self.fx.hits('/config/single.json'), before,
                         '已取消的加载不得再发请求')
        self.assertEqual(mgr.sites.sites, [])

    def test_cancel_during_build_releases_every_worker_it_started(self):
        """构建过程中已经真起了 Worker；取消必须回收，否则「加载一次泄一批」。"""
        from config import ConfigManager
        from site_manager import SiteManager

        cancel = threading.Event()

        class _CancelDuringBuild(ConfigManager):
            def _build_site(self, item, base_url='', spider_jar=''):
                site = super()._build_site(item, base_url, spider_jar)
                cancel.set()
                return site

        mgr = _CancelDuringBuild(SiteManager())
        mgr._repo_pref_loaded = True
        mgr.last_repo_name = ''
        self.managers.append(mgr)
        with self.assertRaises(RuntimeContractError) as caught:
            mgr.load(json.dumps({'sites': [
                {'key': 'a', 'name': 'A', 'type': 1,
                 'api': 'https://fixture.invalid/a/provide/vod/'},
                {'key': 'b', 'name': 'B', 'type': 1,
                 'api': 'https://fixture.invalid/b/provide/vod/'}]}),
                cancel_event=cancel)
        self.assertEqual(caught.exception.code, 'L1_CONFIG_CANCELLED')
        self.assertEqual(mgr.sites.sites, [])
        self.assertIsNone(mgr.snapshot)
        self.assertTrue(_RecordingRunner.instances, '至少要有一个站点真的建起来过')
        for runner in _RecordingRunner.instances:
            self.assertEqual(runner.destroyed, 1)

    def test_cancel_during_depot_fallback_stops_the_scan(self):
        """取消要在「下一条子仓」之前生效，否则一次取消会把整张清单扫完。

        清单从 loopback 取回，条目是相对地址——同源，所以不会被私网守卫拦掉，
        这一条才落在「取消」而不是「被拒」上。
        """
        mgr = self.manager()
        cancel = threading.Event()
        real_fetch = mgr._fetch_config_document
        before = self.fx.hits('/config/depot_good.json')

        def fetch_document(url, ctx, *, depot=False):
            text, fetch = real_fetch(url, ctx, depot=depot)
            if depot:
                # 第一条子仓已经取回；从这一刻起任何后续抓取都是「取消后仍在扫」。
                cancel.set()
            return text, fetch

        mgr._fetch_config_document = fetch_document
        with self.assertRaises(RuntimeContractError) as caught:
            mgr.load(self.fx.config('depot_fallback.json'), cancel_event=cancel)
        self.assertEqual(caught.exception.code, 'L1_CONFIG_CANCELLED')
        self.assertEqual(self.fx.hits('/config/depot_good.json'), before,
                         '取消后不得继续扫描后续子仓')
        self.assertEqual(mgr.sites.sites, [])
        self.assertIsNone(mgr.snapshot)

    def test_load_context_is_cleared_after_every_load(self):
        """上下文泄漏会让下一次加载沿用上一次的取消信号与预算。"""
        mgr = self.manager()
        mgr.load(self.fx.config('depot_good.json'))
        self.assertIsNone(mgr._ctx)
        with self.assertRaises(ValueError):
            mgr.load(self.fx.config('does_not_exist.json'))
        self.assertIsNone(mgr._ctx)

    def test_superseded_load_cannot_swap_its_result(self):
        """被新请求接管（仅代际失效，无取消事件）的加载：可以跑完装配，
        但最终 swap 必须被拒绝且释放 Worker——否则旧加载会覆盖新配置。"""
        import time as _time

        mgr = self.manager()
        outcome = {}

        def run():
            try:
                outcome['summary'] = mgr.load(self.fx.url('slow.json?ms=800'))
            except Exception as exc:  # noqa: BLE001
                outcome['error'] = exc

        worker = threading.Thread(target=run)
        worker.start()
        for _ in range(200):
            with mgr._ctx_lock:
                started = mgr._ctx is not None
            if started:
                break
            _time.sleep(0.01)
        self.assertTrue(started, '加载线程未在预期时间内创建上下文')
        mgr.cancel_active_load()
        worker.join(20)
        self.assertIsInstance(outcome.get('error'), RuntimeContractError)
        self.assertEqual(outcome['error'].code, 'L1_CONFIG_CANCELLED')
        self.assertIsNone(mgr.snapshot, '被接管的加载不得留下运行中快照')
        self.assertEqual(mgr.swap_count, 0)
        # 接管后管理器仍可正常加载新配置
        summary = mgr.load(self.fx.config('single.json'))
        self.assertGreaterEqual(summary['sites'], 1)

    def test_merge_sites_stops_when_budget_exhausted(self):
        """附加仓合并受加载预算约束：预算耗尽时保留已合并部分并停止，
        而不是让死镜像站点把整个导入拖到数分钟。取消则仍要上抛。"""
        import time as _time

        from config import _LoadContext

        mgr = self.manager()
        prepared = {'sites': [], 'source_url': 'https://x.invalid/primary.json',
                    'diagnostics': [], 'lives': [],
                    'summary': {'skipped': [], 'build_errors': {}}}
        extra_cfg = {'sites': [
            {'key': 'merge_slow', 'name': 'slow', 'type': 0,
             'api': 'https://x.invalid/api.php'},
            {'key': 'merge_slow2', 'name': 'slow2', 'type': 0,
             'api': 'https://x.invalid/api2.php'}]}
        sub_cfgs = {'https://x.invalid/primary.json': {'sites': []},
                    'https://x.invalid/extra.json': extra_cfg}

        ctx = _LoadContext('https://x.invalid/primary.json', budget=0.001)
        _time.sleep(0.01)  # 让预算过期
        with mgr._ctx_lock:
            mgr._ctx = ctx
        try:
            mgr._merge_sites(prepared, sub_cfgs)
        finally:
            with mgr._ctx_lock:
                mgr._ctx = None
        self.assertEqual(prepared['sites'], [], '预算耗尽后不得再构建附加站点')

        cancel = threading.Event()
        cancel.set()
        ctx_cancel = _LoadContext('https://x.invalid/primary.json',
                                  cancel_event=cancel)
        with mgr._ctx_lock:
            mgr._ctx = ctx_cancel
        try:
            with self.assertRaises(RuntimeContractError) as caught:
                mgr._merge_sites(prepared, sub_cfgs)
        finally:
            with mgr._ctx_lock:
                mgr._ctx = None
        self.assertEqual(caught.exception.code, 'L1_CONFIG_CANCELLED',
                         '合并阶段的取消必须上抛，不能当成站点失败吞掉')


if __name__ == '__main__':
    unittest.main()
