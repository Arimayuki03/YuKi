# -*- coding: utf-8 -*-
"""site_manager 白盒单元测试：站点列表解析、跨仓合并优先级、去重/排序稳定性、
本地与远程插件装载、recent 选择、destroy_all 释放，以及站点能力字段推导。

与既有测试的互补边界（避免重复覆盖）：
- `test_site_health.py` 覆盖 SiteHealth 四态与 `_prepare/_apply` 的计数口径；
- `test_config_snapshot.py` 覆盖 C2.1 快照与 C2.3 字段矩阵；
- `test_capability_router.py` 覆盖 route_site 的规则表本身。
本文件因此只测 **site_manager 自身的状态机与装载路径**，字段矩阵只测
「落到 Site 上的那一份」（`Site` 的默认值与能力集合口径）。

文件系统与子进程一律 mock / tempfile（沙箱固定在 YUKI_TEST_ROOT 或
python-backend/.test-tmp 下），不碰真实用户数据目录，不出网。

用法：python-backend/.venv/Scripts/python.exe python-backend/tests/test_site_manager.py
"""
import hashlib
import json
import os
import sys
import tempfile
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..'))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import hoststate                                        # noqa: E402
from runtime.config_cache import ConfigRepositoryCache                 # noqa: E402
from runtime.config_snapshot import (                   # noqa: E402
    ParsedConfig, normalize_site_entry)
from runtime.capability_router import capabilities_for, route_site   # noqa: E402
from runtime.errors import RuntimeError as RuntimeContractError      # noqa: E402
from runtime.health import SiteHealth, infer_site_health             # noqa: E402
import config                                           # noqa: E402
import site_manager                                     # noqa: E402
from site_manager import Site, SiteManager              # noqa: E402

# 沙箱根目录：优先 YUKI_TEST_ROOT（run_all.py 注入），否则用仓库内 .test-tmp
_SANDBOX_ROOT = os.environ.get('YUKI_TEST_ROOT') or os.path.join(BASE, '.test-tmp')


def _sandbox():
    """每次调用开一个新的临时目录（永不落在真实 ~/.yuki 下）。"""
    os.makedirs(_SANDBOX_ROOT, exist_ok=True)
    return tempfile.mkdtemp(prefix='site-mgr-', dir=_SANDBOX_ROOT)


def _configure_hoststate(root):
    hoststate.configure(
        port=19999, token='site-manager-token',
        data_dir=root,
        cache_dir=os.path.join(root, 'cache'),
        plugins_dir=os.path.join(root, 'cache', 'py'),
        log_dir=os.path.join(root, 'logs'))


class _InProcessRunner:
    """替换 `site_manager.Runner`（供 `_register` 用）：只记录，不起子进程。"""

    instances = []

    def __init__(self, spider):
        self.spider = spider
        self.inits = []
        self.destroyed = 0
        _InProcessRunner.instances.append(self)

    def init(self, ext=''):
        self.inits.append(ext)
        return None

    def destroy(self):
        self.destroyed += 1
        return None


class _FakeRunner:
    """替换 SupervisedRunner / Runner：只记录，绝不 spawn 子进程。"""

    instances = []

    def __init__(self, spec=None, policy=None):
        self.spec = dict(spec or {})
        self.inits = []
        self.destroyed = 0
        _FakeRunner.instances.append(self)

    def init(self, ext=''):
        self.inits.append(ext)
        return None

    def destroy(self):
        self.destroyed += 1
        return None


class _BoomRunner(_FakeRunner):
    """destroy 抛异常的 runner：destroy_all 必须吞掉。"""

    def destroy(self):
        raise RuntimeError('destroy boom')


def _manifest(sites=None):
    """`ConfigManager._validate` / `_dedupe_depot_sites` 消费的最小 prepared 形状。"""
    return {
        'sites': list(sites or []),
        'source_url': 'http://main.invalid/m.json',
        'diagnostics': [],
        'summary': {'skipped': [], 'sites': len(sites or [])},
    }


def _site(key, api='http://x.invalid/a', *, kind='', healthy=True, runner=None):
    """构造一个带 health 的 Site；runner 缺省用记录型替身。"""
    site = Site(key, api)
    site.spider_type = kind
    site.health = infer_site_health({'key': key, 'api': api, 'type': 0})
    if healthy:
        site.health.mark_built().mark_initialized().mark_healthy()
    site.runner = runner or _FakeRunner({'site_key': key})
    return site


def _manager():
    """ConfigManager + 干净 SiteManager（多仓偏好钉死，避免用例间经磁盘互相影响）。"""
    mgr = config.ConfigManager(SiteManager())
    mgr._repo_pref_loaded = True
    mgr.last_repo_name = ''
    mgr._save_repo_pref = lambda _name: None
    return mgr


# ------------------------------------------------------- 站点列表解析（C2.3 入口）


def test_site_defaults_follow_fongmi_getters():
    """Site 的默认开关/超时必须等于 FongMi Site.java 的 getter 默认值。"""
    site = Site('demo', 'inline.py')
    assert site.key == 'demo'
    assert site.display_name == 'demo'
    assert site.name == 'demo'
    assert site.spider_type == ''
    assert site.searchable is True
    assert site.quick_search is True
    assert site.filterable is True
    assert site.changeable is True
    assert site.danmaku is True
    assert site.hide is False
    assert site.index is False
    assert site.timeout_ms == 15000          # Constant.TIMEOUT_PLAY = 15s
    assert site.categories == []
    assert site.play_url == ''
    assert site.click == ''
    assert site.style is None
    assert site.entry is None
    assert site.ext_detail is None
    assert isinstance(site.health, SiteHealth)
    assert site.health.site_key == 'demo'


def test_site_name_falls_back_to_key_when_display_name_empty():
    """`name` 属性：display_name 为空串/None 时回落 key（`Site.name` 的短路分支）。"""
    site = Site('fallback', 'inline.py')
    assert site.name == 'fallback'
    site.display_name = ''
    assert site.name == 'fallback', '空 display_name 必须回落 key'
    site.display_name = None
    assert site.name == 'fallback'
    site.display_name = '展示名'
    assert site.name == '展示名'


def test_parsed_config_keeps_valid_entries_and_marks_bad_ones():
    """列表解析：缺字段 / 非 dict 项 / 空列表 —— 坏条目被标记而不是被静默丢弃。"""
    parsed = ParsedConfig.from_json({'sites': [
        {'key': 'ok', 'api': 'http://a.invalid/1', 'type': 0},
        {'name': '缺 key'},                      # 缺 key
        {'key': '缺 api'},                        # 缺 api
        'i-am-a-string',                          # 非 dict 项
        123,                                      # 非 dict 项（数字）
        None,                                     # 非 dict 项（null）
        {'key': '未知名段', 'api': 'http://b.invalid/2', 'futureField': 1},
    ]}, base_url='http://cfg.invalid/tv.json')
    assert len(parsed.entries) == 7, '一条都不能少：坏条目要能被诊断页解释'
    valid = [e for e in parsed.entries if e.valid]
    assert [e.key for e in valid] == ['ok', '未知名段']
    reasons = [e.invalid_reason for e in parsed.entries if not e.valid]
    assert reasons.count('site 条目不是 JSON 对象') == 3
    assert reasons.count('site 条目缺少 key 或 api') == 2
    # 未知字段保留在 raw 里（不因未知而报废整条）
    future = next(e for e in parsed.entries if e.key == '未知名段')
    assert future.unknown_fields == ['futureField']
    assert future.raw['futureField'] == 1
    assert future.name == '未知名段', '未声明 name 时以 key 为展示名'


def test_empty_sites_list_and_missing_sites_key():
    """空列表 / 没有 sites 键：解析层给空列表，加载层拒绝（而不是当成空配置放行）。"""
    assert ParsedConfig.from_json({}).entries == []
    assert ParsedConfig.from_json({'sites': []}).entries == []
    assert ParsedConfig.from_json({'sites': None}).entries == [], 'sites=null 同 Gson 空集合'
    mgr = _manager()
    try:
        mgr.load(json.dumps({'spider': 'http://x.invalid/s.jar'}))
    except ValueError as exc:
        assert '[L1:parse] invalid config: missing sites' in str(exc), str(exc)
    else:
        raise AssertionError('缺少 sites 的配置必须被加载层拒绝')
    assert mgr.sites.sites == [], '被拒的加载不得留下半装配站点'


def test_duplicate_keys_are_all_parsed_and_rejected_by_validate():
    """重复 key：解析层照单全收（保序），校验层按 L1 拒绝并给出 duplicateKeys。"""
    items = [
        {'key': 'dup', 'name': 'A', 'type': 0, 'api': 'http://a.invalid/1'},
        {'key': 'dup', 'name': 'B', 'type': 0, 'api': 'http://b.invalid/2'},
    ]
    parsed = ParsedConfig.from_json({'sites': items})
    assert [e.key for e in parsed.entries] == ['dup', 'dup']
    assert [e.name for e in parsed.entries] == ['A', 'B']
    mgr = _manager()
    prepared = _manifest([_site('dup', 'http://a.invalid/1'),
                          _site('dup', 'http://b.invalid/2')])
    try:
        mgr._validate(prepared)
    except RuntimeContractError as exc:
        assert exc.details['duplicateKeys'] == ['dup']
        assert 'duplicate site keys: dup' in str(exc.raw_error)
    else:
        raise AssertionError('重复 key 必须被 _validate 拒绝')


# ------------------------------------------------------------------ 合并优先级


def test_merge_priority_keeps_first_declaration_by_key():
    """跨仓合并 sites：主条目优先，`existing` 里的 key 不再重复构建。"""
    mgr = _manager()
    mgr._build_site = lambda item, base='', jar='': _site(item['key'], item['api'])
    prepared = _manifest([_site('a', 'http://main.invalid/a')])
    sub = {
        'http://main.invalid/m.json': {'sites': [
            {'key': 'a', 'api': 'http://main.invalid/a'}]},
        'http://sub.invalid/s.json': {'sites': [
            {'key': 'a', 'api': 'http://sub.invalid/ dup'},     # 与已有 key 重复
            {'key': 'b', 'api': 'http://sub.invalid/b'}]},
    }
    mgr._merge_sites(prepared, sub)
    assert [s.key for s in prepared['sites']] == ['a', 'b']
    assert prepared['sites'][0].api == 'http://main.invalid/a', '主条目的站点必须保留'
    assert len(prepared['diagnostics']) == 1, '只给新增的 b 记诊断，不给被跳过的重复项'


def test_merge_priority_across_sub_repos_prefers_earlier():
    """跨附加仓：先出现者优先（与串行版语义一致），第二个仓的同 key 不再构建。"""
    mgr = _manager()
    built = []
    def fake_build(item, base='', jar=''):
        built.append((item['key'], base))
        return _site(item['key'], item['api'])
    mgr._build_site = fake_build
    prepared = _manifest()
    sub = {
        'http://sub1.invalid/1.json': {'sites': [{'key': 'k', 'api': 'http://1.invalid/k'}]},
        'http://sub2.invalid/2.json': {'sites': [{'key': 'k', 'api': 'http://2.invalid/k'}]},
    }
    mgr._merge_sites(prepared, sub)
    assert [s.key for s in prepared['sites']] == ['k']
    assert len(built) == 1, '同 key 只构建一次（先出现者）'
    assert built[0][1] == 'http://sub1.invalid/1.json', '构建基址取该条目所属子仓'


def test_merge_lives_dedupes_by_url_keeping_primary():
    """跨仓合并 lives：按 url 集合去重，主条目优先保留（仓漂移时直播源不翻倍）。"""
    mgr = _manager()
    prepared = _manifest()
    sub = {
        'http://main.invalid/m.json': {'lives': [
            {'name': '主仓', 'url': 'http://live.invalid/1.m3u8'}]},
        'http://sub.invalid/s.json': {'lives': [
            {'name': '副仓同址', 'url': 'http://live.invalid/1.m3u8'},
            {'name': '副仓新址', 'url': 'http://live.invalid/2.m3u8'}]},
    }
    mgr._merge_lives(prepared, sub)
    assert [l['name'] for l in prepared['lives']] == ['主仓', '副仓新址'], \
        '同 url 只留主仓那条，新址追加在后'
    # 无 url 的条目直接跳过；channels 嵌套形式按展平后的 url 参与去重
    mgr._merge_lives(prepared, {
        'http://main.invalid/m.json': {'lives': [
            {'name': '主仓', 'url': 'http://live.invalid/1.m3u8'},
            {'name': '无址', 'url': ''},
            {'name': '通道组', 'channels': [
                {'name': 'C1', 'urls': ['http://live.invalid/3.m3u8']}]}]},
        'http://sub.invalid/s.json': {'lives': [
            {'name': '副仓同通道', 'channels': [
                {'name': 'C1', 'urls': ['http://live.invalid/3.m3u8']}]},
            {'name': '副仓新址', 'url': 'http://live.invalid/2.m3u8'}]}})
    assert [l['name'] for l in prepared['lives']] == ['主仓', '通道组', '副仓新址'], \
        '空 url 跳过；channels 展平后与直链同池去重'


# ------------------------------------------------------ 名称去重与排序稳定性


def test_duplicate_display_names_collapse_in_name_index():
    """同名站点：按 name 建索引会静默丢站点（last wins），按 key 建索引才完整。"""
    manager = SiteManager()
    for key in ('src_a', 'src_b', 'src_c'):
        site = _site(key, 'http://%s.invalid/' % key)
        site.display_name = '同名源'
        manager.sites.append(site)
    assert len(manager.sites) == 3
    by_name = {s.name: s.key for s in manager.sites}
    assert len(by_name) == 1, '按展示名建索引：三条塌成一条'
    assert by_name['同名源'] == 'src_c', '塌成最后注册的那条（诊断页会指向错的站点）'
    by_key = {s.key: s.name for s in manager.sites}
    assert len(by_key) == 3, '按 key 建索引才不丢站点'
    assert manager.get('src_a').name == '同名源'


def test_stable_sort_preserves_registration_order():
    """排序稳定性：同 key（如同 spider_type / 同健康态）的站点保持注册顺序。"""
    manager = SiteManager()
    for key in ('s1', 's2', 's3', 's4'):
        manager.sites.append(_site(key, 'http://x.invalid/', kind='py'))
    for key in ('j1', 'j2'):
        manager.sites.append(_site(key, 'http://x.invalid/', kind='jar'))
    order = sorted(manager.sites, key=lambda s: s.spider_type)
    assert [s.key for s in order] == ['j1', 'j2', 's1', 's2', 's3', 's4'], \
        'Python 排序稳定：同组内保持注册顺序'
    # 多级排序（健康与否）后，组内顺序依旧稳定（此处改用「健康检查」作为次级键）
    manager.sites[0].health.record_failure(RuntimeContractError(
        'L3_RUNTIME_CALL_FAILED', site_key='s1'))
    degraded_first = sorted(manager.sites, key=lambda s: s.health.healthy)
    assert degraded_first[0].key == 's1', '不健康的排到最前'
    assert [s.key for s in degraded_first[1:3]] == ['s2', 's3'], \
        '健康组内仍保持注册顺序（s4 在 j1/j2 之前）'
    assert [s.key for s in degraded_first[3:]] == ['s4', 'j1', 'j2']


# ---------------------------------------------------------- 站点装载（白盒）


def test_register_gives_direct_plugin_the_health_lifecycle():
    """`_register`：直连插件也要走 built/initialized/healthy，并记 _recent_key。"""
    manager = SiteManager()

    class Spider:
        def getName(self):
            return 'direct'

    with mock.patch('site_manager.Runner', _InProcessRunner):
        first = Site('direct', 'inline.py', '{"a":1}')
        manager._register(first, Spider())
        second = Site('second', 'inline.py')
        manager._register(second, Spider())
    assert first.runner.inits == ['{"a":1}'], 'runner.init 必须带站点 ext'
    assert second.runner.inits == ['']
    assert first.health.runtime == 'python'
    assert first.health.compatibility == 'C1'
    assert first.health.built and first.health.initialized and first.health.healthy
    assert manager.diagnostics[0].site_key == 'direct'
    assert [s.key for s in manager.sites] == ['direct', 'second']
    assert manager._recent_key == 'direct', '_recent_key 只在第一个注册时落定'
    assert isinstance(first.runner, _InProcessRunner)
    assert first.runner.spider.site_key == 'direct', 'spider.site_key 必须被打上'


def test_register_tolerates_spider_without_site_key_attribute():
    """`_register`：`spider.site_key = ...` 抛异常要被吞掉（不影响建站）。"""

    class FrozenSpider:
        @property
        def site_key(self):
            return 'frozen'

        def init(self, ext=''):
            return None

    manager = SiteManager()
    with mock.patch('site_manager.Runner', _InProcessRunner):
        manager._register(Site('frozen', 'inline.py'), FrozenSpider())
    assert manager.sites[0].key == 'frozen'
    assert manager.sites[0].health.healthy, 'site_key 写不进去不影响健康标记'


def test_load_api_derives_plugin_path_from_key_and_api():
    """`load_api`：key 消毒 + api 摘要 + basename 共同决定落盘路径（不出网）。"""
    root = _sandbox()
    plugins = os.path.join(root, 'cache', 'py')
    _configure_hoststate(root)
    written = {}

    def fake_download(path, api):
        written['path'] = path
        written['api'] = api
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as handle:
            handle.write(b'# fixture spider\n')

    manager = SiteManager()
    with mock.patch('site_manager.SupervisedRunner', _FakeRunner), \
            mock.patch.object(site_manager.spider_app, 'download', fake_download):
        api = 'https://cdn.invalid/path/spider.py?x=1'
        site = manager.load_api('demo', api, '{"ext":1}')
        assert written['api'] == api
        assert os.path.realpath(written['path']).startswith(
            os.path.realpath(plugins) + os.sep), '落盘必须在 plugins 目录内'
        digest = hashlib.sha256(api.encode('utf-8')).hexdigest()[:12]
        assert os.path.basename(site.runner.spec['path']) == 'demo-%s-spider.py' % digest
        assert site.runner.inits == ['{"ext":1}']
        assert site.health.runtime == 'python' and site.health.healthy
        assert manager.diagnostics[0].site_key == 'demo'
        # 内联源码（非 http）：basename 固定 inline.py
        inline = manager.load_api('inline site', 'print(1)', '')
        assert os.path.basename(inline.runner.spec['path']).endswith('-inline.py'), \
            '非 http 的 api 一律按 inline.py 命名'
        assert os.path.basename(inline.runner.spec['path']).startswith('inline_site-'), \
            'key 里的空格要被消毒成下划线'
        # 超长 key 截断到 48
        long_site = manager.load_api('k' * 100, 'https://cdn.invalid/a.js')
        assert len(os.path.basename(long_site.runner.spec['path'])) < 100


def test_load_api_rejects_path_outside_plugins_dir():
    """`load_api` 的目录穿越护栏：解析出的路径不在 plugins 根下就抛 ValueError。"""
    root = _sandbox()
    outside = os.path.join(root, 'outside')
    os.makedirs(outside, exist_ok=True)
    plugins = os.path.join(root, 'cache', 'py')
    _configure_hoststate(root)
    real = os.path.realpath
    state = {'n': 0}

    def fake_realpath(path):
        """第一次调用算 path（伪造成逃逸），第二次算 root。"""
        state['n'] += 1
        if state['n'] == 1:
            return os.path.join(outside, 'escaped.py')
        return real(plugins) + os.sep

    manager = SiteManager()
    with mock.patch.object(site_manager.os.path, 'realpath', fake_realpath), \
            mock.patch('site_manager.SupervisedRunner', _FakeRunner), \
            mock.patch.object(site_manager.spider_app, 'download', lambda p, a: None):
        try:
            manager.load_api('evil', 'https://cdn.invalid/spider.py')
        except ValueError as exc:
            assert 'bad site key: evil' in str(exc), str(exc)
        else:
            raise AssertionError('逃逸出 plugins 目录的路径必须被拒绝')
    assert manager.sites == [], '被拒的装载不得留下站点'


def test_load_local_uses_basename_and_realpath():
    """`load_local`：name 取文件名主干，path 取 realpath，且不起子进程。"""
    root = _sandbox()
    _configure_hoststate(root)
    plugin = os.path.join(root, 'spiders', 'demo.py')
    os.makedirs(os.path.dirname(plugin), exist_ok=True)
    with open(plugin, 'w', encoding='utf-8') as handle:
        handle.write('# -*- coding: utf-8 -*-\n')
    manager = SiteManager()
    with mock.patch('site_manager.SupervisedRunner', _FakeRunner):
        site = manager.load_local('demo', plugin, 'ext-1')
    spec = site.runner.spec
    assert spec['kind'] == 'python'
    assert spec['site_key'] == 'demo'
    assert spec['name'] == 'demo', 'name 取 basename 去扩展名'
    assert spec['path'] == os.path.realpath(plugin), '必须 realpath，避免子进程按相对路径找错'
    assert site.runner.inits == ['ext-1']
    assert site.health.healthy and manager.diagnostics[0].site_key == 'demo'
    assert manager.get('demo') is site


def test_get_and_set_recent_semantics():
    """`get` / `set_recent`：空列表、默认首项、精确命中、未命中与非法 key。"""
    manager = SiteManager()
    assert manager.get() is None, '空列表任何取法都是 None'
    assert manager.get('nope') is None
    a = _site('a')
    b = _site('b')
    manager.sites.extend([a, b])
    assert manager.get() is a, 'key=None 取第一个'
    assert manager.get('b') is b
    assert manager.get('missing') is None
    manager.set_recent('b')
    assert manager._recent_key == 'b'
    manager.set_recent('not-registered')
    assert manager._recent_key == 'b', '未注册 key 不得改写 recent'
    manager.set_recent('')
    assert manager._recent_key == 'b', '空 key 不得改写 recent'
    manager.set_recent(None)
    assert manager._recent_key == 'b'


def test_kind_detection_from_spider_type_and_module():
    """`_kind`：显式 spider_type 最优先，其次按 runner.spider 的模块名回退到 py。"""

    class Spider:
        pass

    def spider_in(module):
        cls = type('Spider', (), {})
        cls.__module__ = module
        return cls()

    def site_with(spider_module='', spider_type=''):
        site = _site('k')
        site.spider_type = spider_type
        site.runner = _FakeRunner()
        site.runner.spider = spider_in(spider_module) if spider_module else Spider()
        return site

    assert SiteManager._kind(site_with(spider_type='JAR')) == 'jar', '大小写不敏感'
    assert SiteManager._kind(site_with(spider_type='Py')) == 'py'
    assert SiteManager._kind(site_with(spider_module='jar_spider')) == 'jar'
    assert SiteManager._kind(site_with(spider_module='js_spider')) == 'js'
    assert SiteManager._kind(site_with(spider_module='cms_spider')) == 'cms'
    assert SiteManager._kind(site_with(spider_module='some.other.module')) == 'py'
    assert SiteManager._kind(site_with()) == 'py', '未知模块一律回退 py'
    bare = _site('bare')
    bare.runner = None
    assert SiteManager._kind(bare) == 'py', 'runner 缺失不得抛异常'


def test_recent_selection_order_and_kind_filter():
    """`recent`：recent 优先 → 逆序（最近注册）→ kind 过滤 → 无匹配返回 None。"""
    manager = SiteManager()
    assert manager.recent() is None, '空列表返回 None'
    py1 = _site('py1', kind='py')
    jar1 = _site('jar1', kind='jar')
    js1 = _site('js1', kind='js')
    py2 = _site('py2', kind='py')
    manager.sites.extend([py1, jar1, js1, py2])
    assert manager.recent() is py2, '无 recent 时取最近注册的那个'
    manager.set_recent('jar1')
    assert manager.recent() is jar1, 'recent 优先于注册顺序'
    assert manager.recent('JS') is js1, 'kind 大小写不敏感'
    assert manager.recent('cms') is None, '没有该 kind 时返回 None'
    assert manager.recent('jar') is jar1
    # recent 指向的站点被移除后回落到「最近注册」
    manager.sites.remove(jar1)
    assert manager.recent() is py2, 'recent 悬空时按注册逆序回落'
    assert manager.recent('jar') is None
    assert manager.recent('py') is py2


def test_destroy_all_releases_sites_and_swallows_errors():
    """`destroy_all`：逐个 destroy（吞异常）→ 清空三处状态 → 关 JVM/监督者。"""
    manager = SiteManager()
    boom = _site('boom', runner=_BoomRunner())
    ok = _site('ok', runner=_FakeRunner())
    manager.sites.extend([boom, ok])
    manager.diagnostics.extend([boom.health, ok.health])
    manager._recent_key = 'ok'
    destroyed = []
    with mock.patch('jar_bridge.JarBridge.destroy_all',
                    side_effect=lambda: destroyed.append('jar')), \
            mock.patch('runtime.supervisor.destroy_all_supervisors',
                       side_effect=lambda: destroyed.append('supervisor')):
        manager.destroy_all()
    assert manager.sites == []
    assert manager.diagnostics == []
    assert manager._recent_key is None
    assert ok.runner.destroyed == 1
    assert destroyed == ['jar', 'supervisor'], 'JVM 与监督者都要被关停（且顺序固定）'
    # 关停链路自身抛异常也要被吞掉：热重载不能被一次清理失败打断
    with mock.patch('jar_bridge.JarBridge.destroy_all',
                    side_effect=RuntimeError('jvm boom')):
        manager.destroy_all()
    assert manager.sites == [], '第二次 destroy_all 幂等且仍吞异常'


# --------------------------------------------- 启用/禁用切换与持久化兜底


def _toggle_store(root):
    """站点启用状态的落盘介质：复用真实的磁盘缓存层（原子写 + 哈希校验）。"""
    return ConfigRepositoryCache(os.path.join(root, 'site-toggle'))


def test_site_toggle_persists_across_reload():
    """启用/禁用切换的持久化往返：关掉一个站点 → 落盘 → 重读仍是关。"""
    root = _sandbox()
    _configure_hoststate(root)
    store = _toggle_store(root)
    manager = SiteManager()
    for key in ('a', 'b', 'c'):
        manager.sites.append(_site(key))
    enabled = {s.key: True for s in manager.sites}

    def persist():
        return store.save('yuki://site-toggle', json.dumps(enabled, sort_keys=True))

    def restore():
        cached = store.load()
        return json.loads(cached.text) if cached is not None else {}

    assert persist() is True
    enabled['b'] = False                      # 禁用 b
    assert persist() is True
    reloaded = restore()
    assert reloaded == {'a': True, 'b': False, 'c': True}, '往返保真'
    assert [s.key for s in manager.sites if reloaded.get(s.key, True)] == ['a', 'c'], \
        '禁用的站点不进内容页'
    # 再切回来：重复切换也要落盘生效（不是"只会关不会开"）
    enabled['b'] = True
    assert persist() is True
    assert restore()['b'] is True
    # 站点被移除后，重读出的孤儿 key 不影响现存站点
    manager.sites.pop()
    assert [s.key for s in manager.sites if restore().get(s.key, True)] == ['a', 'b']


def test_toggle_file_corrupted_or_empty_falls_back_to_all_enabled():
    """损坏 JSON / 空文件 / 版本号不符：缓存层返回 None，上层回退「全部启用」。"""
    root = _sandbox()
    _configure_hoststate(root)
    store = _toggle_store(root)
    manager = SiteManager()
    for key in ('a', 'b'):
        manager.sites.append(_site(key))
    defaults = {s.key: True for s in manager.sites}

    def visible(mapping):
        return [s.key for s in manager.sites if mapping.get(s.key, True)]

    assert store.save('yuki://site-toggle', json.dumps(defaults)) is True
    assert visible(json.loads(store.load().text)) == ['a', 'b']
    # 损坏 JSON（哈希校验失败）→ None → 回退默认（全部启用，不静默清空站点）
    with open(store.path, 'w', encoding='utf-8') as handle:
        handle.write('{"version":1,"contentHash":"deadbeef","text":"{oops"}')
    assert store.load() is None, '哈希不符必须判无效'
    assert visible(defaults) == ['a', 'b']
    # 空文件 → 同样无效
    with open(store.path, 'w', encoding='utf-8') as handle:
        handle.write('')
    assert store.load() is None
    # text 不是字符串 / 版本号不符 → 无效
    with open(store.path, 'w', encoding='utf-8') as handle:
        json.dump({'version': 99, 'text': '{}', 'contentHash': ''}, handle)
    assert store.load() is None
    # 未落盘过（文件不存在）→ 直接 None
    fresh = _toggle_store(_sandbox())
    assert fresh.load() is None
    assert visible(defaults) == ['a', 'b'], '任何兜底分支都不该把站点判成全禁用'


def test_toggle_save_failure_is_reported_but_in_memory_applies():
    """落盘失败（权限/只读）：save 返回 False，内存里的切换仍然生效。"""
    root = _sandbox()
    _configure_hoststate(root)
    store = _toggle_store(root)
    manager = SiteManager()
    for key in ('a', 'b'):
        manager.sites.append(_site(key))
    enabled = {'a': True, 'b': True}
    assert store.save('yuki://site-toggle', json.dumps(enabled)) is True
    enabled['b'] = False
    with mock.patch('runtime.config_cache.tempfile.mkstemp',
                    side_effect=PermissionError('read-only')):
        assert store.save('yuki://site-toggle', json.dumps(enabled)) is False, \
            '权限错误必须被吞成 False（启动期不得因一次写失败崩掉）'
    assert store.load().text == json.dumps({'a': True, 'b': True}), \
        '写失败时磁盘保留上一份（不写半个文件）'
    assert [s.key for s in manager.sites if enabled.get(s.key, True)] == ['a'], \
        '内存态的禁用立即生效，落盘失败不影响本次会话'


def test_corrupt_config_json_raises_actionable_parse_error():
    """损坏 JSON / 直播源误用：给出可操作的 [L1:parse] 提示，而不是裸 JSONDecodeError。"""
    try:
        config.parse_config_json('{"sites": [')
    except ValueError as exc:
        assert '[L1:parse]' in str(exc), str(exc)
        assert '不是有效的 JSON' in str(exc)
    else:
        raise AssertionError('损坏 JSON 必须抛 ValueError')
    # 直播源被当成配置粘贴：单独引导到正确的入口
    try:
        config.parse_config_json('央视频道,#genre#\nCCTV1,http://x/1.m3u8')
    except ValueError as exc:
        assert '直播源' in str(exc), str(exc)
    else:
        raise AssertionError('直播源必须被识别并给出专门提示')
    # 空正文 / 空白正文：不是合法 JSON
    for bad in ('', '   \n  '):
        try:
            config.parse_config_json(bad)
        except ValueError:
            pass
        else:
            raise AssertionError('空正文不得被当成合法配置')
    # 带注释的 JSON 能剥注释后解出（TVBox 仓常见形态）
    assert config.parse_config_json(
        '{\n// 整行注释\n"sites": [{"key":"a","api":"http://x/1"}] // 行内注释\n}'
    )['sites'][0]['key'] == 'a'
    # URL 里的 // 不能被当成注释吃掉
    cfg = config.parse_config_json(
        '{"sites":[{"key":"a","api":"https://cdn.invalid/tv.json"}]}')
    assert cfg['sites'][0]['api'] == 'https://cdn.invalid/tv.json'


# ------------------------------------------------------------ 站点能力字段推导


def test_site_capability_fields_derive_from_config():
    """能力集合：按 FongMi 整型开关语义推导，unsupported 运行时一律无能力。"""
    js = {'key': 'js1', 'name': 'JS源', 'type': 4, 'api': 'http://x.invalid/a.js'}
    decision = route_site(js)
    caps = capabilities_for(js, decision)
    assert decision.runtime == 'js'
    assert 'search' in caps and 'quickSearch' in caps
    assert 'filter' in caps and 'changeable' in caps
    assert caps == sorted(caps), '能力集合必须有序（诊断页直接序列化）'
    # searchable=2（FongMi 里 isSearchable() 为 false）：search 与 quickSearch 都消失
    off = {'key': 'off', 'type': 0, 'api': 'http://x.invalid/p/', 'searchable': 2}
    caps_off = capabilities_for(off, route_site(off))
    assert 'search' not in caps_off and 'quickSearch' not in caps_off
    assert 'home' in caps_off and 'player' in caps_off, '基础能力不受开关影响'
    # filterable=0 / changeable=0 各自只摘掉自己那一项
    no_filter = {'key': 'nf', 'type': 0, 'api': 'http://x.invalid/p/', 'filterable': 0}
    caps_nf = capabilities_for(no_filter, route_site(no_filter))
    assert 'filter' not in caps_nf and 'changeable' in caps_nf
    no_change = {'key': 'nc', 'type': 0, 'api': 'http://x.invalid/p/', 'changeable': 0}
    assert 'changeable' not in capabilities_for(no_change, route_site(no_change))
    # drpy → unsupported：能力集合必须为空（不能"看起来能搜"）
    drpy = {'key': 'd', 'type': 3, 'api': 'http://x.invalid/drpy.js'}
    assert route_site(drpy).runtime == 'unsupported'
    assert capabilities_for(drpy, route_site(drpy)) == []


def test_health_capabilities_are_sorted_and_deduped():
    """`infer_site_health`：能力去重排序；显式传入时仍按 searchable 语义收敛。"""
    health = infer_site_health({'key': 's', 'type': 0, 'api': 'http://x.invalid/p/'},
                               capabilities=['home', 'home', '', 'player'])
    assert health.capabilities == ['home', 'player'], '去重 + 排序 + 去空'
    assert health.runtime == 'cms'
    # 显式能力里带 search，但配置说 searchable=2 → 收敛掉 search
    trimmed = infer_site_health(
        {'key': 's2', 'type': 0, 'api': 'http://x.invalid/p/', 'searchable': 2},
        capabilities=['home', 'search'])
    assert trimmed.capabilities == ['home'], '显式能力也要服从 searchable 语义'
    # 字段矩阵到 Site 的默认路径：Site() 的健康对象不含能力，靠 _assemble 覆盖
    raw = Site('s3', 'http://x.invalid/p/')
    assert raw.health.capabilities == []
    entry = normalize_site_entry(
        {'key': 's3', 'type': 0, 'api': 'http://x.invalid/p/', 'searchable': 2})
    assert entry.searchable is False, 'Site 与字段矩阵必须同口径'


if __name__ == '__main__':
    failures = 0
    total = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith('test_') or not callable(fn):
            continue
        total += 1
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - 汇总 runner 需要拿到所有失败
            failures += 1
            print('FAIL %s: %s: %s' % (name, type(exc).__name__, exc))
        else:
            print('PASS %s' % name)
    print('---- %d/%d passed ----' % (total - failures, total))
    if failures:
        sys.exit(1)
    print('ALL PASS')
