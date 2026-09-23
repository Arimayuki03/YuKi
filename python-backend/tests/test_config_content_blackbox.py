# -*- coding: utf-8 -*-
"""配置加载 ↔ 内容 API 的**端到端黑盒契约**测试。

与既有套件的分工（先读后写，避免重复覆盖）：

* ``test_config_snapshot.py``           —— C2.1 三层模型的**结构**与替换语义（mock runner）
* ``test_config_realworld_formats.py``  —— 解析层对真实世界畸形配置的容错
* ``test_ext_semantics.py``             —— ext 归一/展开的取值契约
* ``test_capability_router.py``         —— ``route_site`` 纯函数的规则表
* ``test_http_api_blackbox.py``         —— HTTP 端点层（鉴权/状态码/Content-Type）
* ``test_config_supersede.py``          —— 导入接管与代际守卫

本文件只测**外部可见的端到端契约**：真实配置夹具（loopback HTTP 夹具服务或临时
目录里的本地 JSON）→ 真实 ``ConfigManager`` 装配（真起 Worker 子进程）→ 真实内容
API 调用。全程不 mock 任何内部函数，也不发任何外网请求。

纪律：
* 配置夹具全部本地：`tests/offline_config_server.py` 的 127.0.0.1 夹具服务，或
  ``tempfile.mkdtemp()`` 里现写的 JSON 文件；
* 沙箱隔离：`YUKI_TEST_ROOT`/`YUKI_DATA_DIR`/`YUKI_CACHE_DIR` 全部指向临时目录，
  绝不碰真实用户目录 ``~/.yuki``；
* Windows spawn 语义：hoststate 配置与站点加载只在 ``main()`` 里做，避免
  multiprocessing 复跑模块顶层时把 Worker 再拉一遍；
* 禁止 sleep 真实等待。

用法：<venv>/python python-backend/tests/test_config_content_blackbox.py
"""
import json
import logging
import multiprocessing
import os
import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
for _path in (BASE, HERE):
    if _path not in sys.path:
        sys.path.insert(0, _path)

# 模块级只做「纯 import」，不起服务、不建目录、不加载站点（spawn 子进程序列化
# __main__ 时会复跑本模块，任何副作用都会被放大成重复 Worker）。
import hoststate            # noqa: E402
import server               # noqa: E402
from runtime.errors import RuntimeError as ContractError  # noqa: E402

DEMO_PATH = os.path.join(BASE, 'spiders', 'demo.py')

_CTX = {
    'root': '',
    'play_dir': '',
    'fixture': None,
    'managers': [],
}

# ---------------------------------------------------------------------------
# 夹具构造：本地 demo spider 的命名变体（每站点一份独立源码 → 独立内容哈希目录）
# ---------------------------------------------------------------------------
# 变体只改「显示名/片名前缀」，契约形状与 demo.py 完全一致。改名的目的是让
# 「并发调用是否串源」可以被外部观测：若两个站点的响应互相串了，vod_name 前缀
# 就会对不上站点名，断言立刻命中。
def _spider_source(tag):
    with open(DEMO_PATH, encoding='utf-8') as handle:
        src = handle.read()
    return src.replace('示例源', tag).replace('示例影片', tag)


def _spider_entry(key, tag, **extra):
    entry = {'key': key, 'name': key, 'type': 3, 'api': _spider_source(tag)}
    entry.update(extra)
    return entry


def _tmp_json(name, payload):
    """在沙箱里写一个本地 JSON 配置文件，返回路径（夹具全在本地）。"""
    path = os.path.join(_CTX['root'], name)
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(payload if isinstance(payload, str)
                     else json.dumps(payload, ensure_ascii=False))
    return path


def _spider_dir(name):
    """沙箱内新建独立目录：每个变体的落盘路径彼此隔离。"""
    path = os.path.join(_CTX['root'], 'spiders', name)
    os.makedirs(path, exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# 装配助手
# ---------------------------------------------------------------------------
def _guard_isolated():
    """沙箱隔离守卫：pytest 直跑必须 fail-fast。

    本文件的所有隔离设施（YUKI_TEST_ROOT/YUKI_DATA_DIR/YUKI_CACHE_DIR、
    hoststate.configure、play_cache.set_dir_for_tests）只在 ``main() -> _host_setup()``
    里执行。直接 pytest 收集本文件会进程内直跑 → ``hoststate._HOME`` 回落真实
    ``~/.yuki``：_install_demo spawn 真实 Worker 子进程、_install_variants 把
    spider 源码写进真实 ~/.yuki/cache/py、act() 写真实 play-cache——每个可能
    产生副作用的入口都必须先过这道守卫。
    """
    if not os.environ.get('YUKI_TEST_ROOT'):
        raise RuntimeError(
            'test_config_content_blackbox 必须独立运行：python tests/test_config_content_blackbox.py，'
            '不得用 pytest 直接收集（YUKI_TEST_ROOT 未设置 → 隔离未建立，会污染真实 ~/.yuki）')


def _fresh_manager():
    """独立 SiteManager 的 ConfigManager（配置类用例，不污染 server 的站点表）。"""
    _guard_isolated()
    from config import ConfigManager
    from site_manager import SiteManager

    mgr = ConfigManager(SiteManager())
    # 多仓偏好持久化在 YUKI_DATA_DIR/last_repo.txt，不钉住会让用例之间通过磁盘
    # 互相影响，回退顺序的断言就成了「看上一个用例跑了什么」。
    mgr._repo_pref_loaded = True
    mgr.last_repo_name = ''
    mgr._save_repo_pref = lambda _name: None
    _CTX['managers'].append(mgr)
    return mgr


def _live_manager():
    """接管 server.sites 的 ConfigManager（内容 API 用例：装配结果直接可被调用）。"""
    _guard_isolated()
    from config import ConfigManager

    mgr = ConfigManager(server.sites)
    mgr._repo_pref_loaded = True
    mgr.last_repo_name = ''
    mgr._save_repo_pref = lambda _name: None
    _CTX['managers'].append(mgr)
    return mgr


def _reset_runtime():
    """清掉本轮已装载的站点与其 Worker。

    必须每次重装载前调用：`destroy_all()` 是**全局**回收（含「当前没在使用」的
    Worker 进程），一个用例若装了独立 SiteManager 再销毁，会把 server 侧 demo 的
    Worker 一起带走——后续用例复用旧 Site 对象就会拿到 L3_RUNTIME_RESTARTED。
    """
    for mgr in _CTX['managers']:
        try:
            mgr.sites.destroy_all()
        except Exception:
            pass
    _CTX['managers'] = []
    try:
        server.sites.destroy_all()
    except Exception:
        pass


def _install_demo():
    """重建 demo 站点（每个内容用例独立装载，不跨用例复用 runner）。"""
    _guard_isolated()
    _reset_runtime()
    server.load_default_sites()
    return server.sites.get('demo')


def _install_variants(tags):
    """重建 N 个互不相同的本地 Python 站点（tag 即站点名/片名前缀）。"""
    _guard_isolated()
    _reset_runtime()
    mgr = _live_manager()
    mgr.load(json.dumps({'sites': [_spider_entry('site_%s' % tag, tag)
                                   for tag in tags]}))
    return mgr


def fixture():
    _guard_isolated()
    if _CTX['fixture'] is None:
        import offline_config_server
        _CTX['fixture'] = offline_config_server.FixtureServer().__enter__()
    return _CTX['fixture']


# ---------------------------------------------------------------------------
# 内容 API 助手：走 server.dispatch_action（真实运行时：Runner → Worker 子进程）
# ---------------------------------------------------------------------------
def act(**form):
    """返回 (status, body_text)；body 成功时是 CatVod 扁平 JSON，失败时是错误包络。"""
    return server.dispatch_action(dict(form))


def ok_body(status, text, label=''):
    assert status == 200, (label, status, text[:300])
    payload = json.loads(text)
    assert isinstance(payload, dict), (label, text[:300])
    return payload


def err_body(status, text, label=''):
    assert status >= 400, (label, status, text[:300])
    payload = json.loads(text)
    assert payload.get('ok') is False, (label, text[:300])
    error = payload.get('error')
    assert isinstance(error, dict), (label, text[:300])
    return payload, error


def _keys(mgr):
    return [site.key for site in mgr.sites.sites]


# ===========================================================================
# 一、配置加载：单仓解析结果
# ===========================================================================
def test_single_repo_parses_declared_site_count_and_order():
    """黑盒意图：单仓配置的站点列表——configured 等于声明条数，成功装配的站点按
    配置顺序出现，未能装配的条目不进运行站点表但仍在诊断列表里。"""
    mgr = _fresh_manager()
    summary = mgr.load(fixture().config('single.json'))
    assert summary['configured'] == 6, ('configured', summary['configured'])
    assert summary['sites'] == len(_keys(mgr)), (summary['sites'], _keys(mgr))
    # 顺序：解析顺序即配置顺序（前三条是能装配的 CMS/CMS/JS）
    built = _keys(mgr)
    assert built == ['cms_json', 'cms_xml', 'js_remote'], built
    # 声明了 6 条，诊断页必须能解释每一条（含建不起来的）
    assert len(mgr.sites.diagnostics) == 6, len(mgr.sites.diagnostics)
    assert mgr.snapshot.parsed.to_dict()['siteCount'] == 6


def test_single_repo_capability_matrix_defaults():
    """黑盒意图：字段矩阵按 FongMi Site.java getter 语义落到 Site 上——渲染层直接
    依赖这些布尔字段，值必须等于配置声明而非「有字段就为真」。"""
    mgr = _fresh_manager()
    mgr.load(fixture().config('single.json'))
    site = mgr.sites.get('cms_json')
    assert site is not None
    # single.json 的 cms_json：searchable=1 quickSearch=1 filterable=1
    # changeable=0 danmaku=0 hide=0 indexs=1 timeout=8 categories=[...]
    assert site.searchable is True, site.searchable
    assert site.quick_search is True, site.quick_search
    assert site.filterable is True, site.filterable
    assert site.changeable is False, site.changeable
    assert site.danmaku is False, site.danmaku
    assert site.hide is False, site.hide
    assert site.index is True, site.index
    assert site.timeout_ms == 8000, site.timeout_ms
    assert site.categories == ['电影', '电视剧'], site.categories
    assert site.style == {'type': 'rect', 'ratio': 1.33}, site.style
    assert site.headers == {'User-Agent': 'okhttp/3.15'}, site.headers
    assert site.display_name == 'CMS JSON', site.display_name
    assert site.play_url == 'https://fixture.invalid/play?u=', site.play_url
    assert site.click == 'document.title', site.click


def test_single_repo_unbuildable_entries_become_diagnostics():
    """黑盒意图：装配失败的条目不静默消失——每条都留一条带错误码的 skip 记录与
    诊断项，且失败被归类到具体运行时桶（jar/py），不是一堆「other」。"""
    mgr = _fresh_manager()
    summary = mgr.load(fixture().config('single.json'))
    skipped = summary['skipped']
    assert len(skipped) == 3, skipped
    joined = ' || '.join(skipped)
    assert 'py_remote' in joined and 'jar_class' in joined and 'jar_direct' in joined, joined
    assert summary['build_errors']['jar_failed'] == 2, summary['build_errors']
    assert summary['build_errors']['py_failed'] == 1, summary['build_errors']
    # 每条失败都带稳定错误码（L1-L6），不是自由文本
    for line in skipped:
        assert '[L2_SITE_BUILD_FAILED]' in line or '[L2_SITE' in line, line
    assert len(mgr.sites.diagnostics) == 6, len(mgr.sites.diagnostics)


def test_local_json_file_config_builds_site():
    """黑盒意图：本地磁盘上的 JSON 配置文件（tempfile 写入）能走完整链路装配出站点，
    且快照记录 transport=file 与真实文件路径（用户导入本地文件的可见结果）。"""
    mgr = _fresh_manager()
    path = _tmp_json('local_site.json', {'sites': [_spider_entry('local_one', 'LocalOne')]})
    summary = mgr.load(path)
    assert summary['sites'] == 1, summary
    assert _keys(mgr) == ['local_one'], _keys(mgr)
    site = mgr.sites.get('local_one')
    assert site.health.runtime == 'python', site.health.runtime
    assert site.health.state == 'healthy', site.health.state
    fetch = mgr.snapshot.fetch
    assert fetch.transport == 'file', fetch.transport
    assert os.path.realpath(fetch.source_url) == os.path.realpath(path), fetch.source_url


def test_empty_site_list_is_accepted_as_zero_sites():
    """黑盒意图：显式声明空站点列表是合法配置（如实呈现「这个仓没有源」），
    必须装配成功并留下可诊断的快照，而不是报错或保留旧配置。"""
    mgr = _fresh_manager()
    summary = mgr.load(json.dumps({'sites': []}))
    assert summary['configured'] == 0, summary
    assert summary['sites'] == 0, summary
    assert _keys(mgr) == [], _keys(mgr)
    assert mgr.snapshot is not None
    assert mgr.snapshot.parsed.to_dict()['siteCount'] == 0


def test_empty_object_config_is_rejected_with_l1_parse():
    """黑盒意图：`{}` 这种空配置是 L1 解析错误（缺 sites），且失败不留下半装配状态。"""
    mgr = _fresh_manager()
    try:
        mgr.load(json.dumps({}))
    except ValueError as exc:
        assert '[L1:parse]' in str(exc), str(exc)
        assert 'missing sites' in str(exc), str(exc)
    else:
        raise AssertionError('空对象配置应当被拒绝')
    assert _keys(mgr) == [], _keys(mgr)
    assert mgr.snapshot is None, mgr.snapshot


def test_malformed_json_is_rejected_with_l1_parse():
    """黑盒意图：非法 JSON 抛出可读的 [L1:parse] ValueError（不是裸 JSONDecodeError），
    且错误消息带上内容开头，便于用户定位粘错了什么。"""
    mgr = _fresh_manager()
    try:
        mgr.load('{ this is not json at all')
    except ValueError as exc:
        text = str(exc)
        assert '[L1:parse]' in text, text
        assert 'JSON' in text, text
    else:
        raise AssertionError('非法 JSON 应当被拒绝')


def test_entry_without_api_is_recorded_as_structured_skip():
    """黑盒意图：缺 api 的条目不炸整次加载——作为一条带错误码的 skip 记账，
    其余条目照常装配。"""
    mgr = _fresh_manager()
    summary = mgr.load(json.dumps({'sites': [
        {'key': 'no_api', 'name': 'NoApi', 'type': 1},
        _spider_entry('has_api', 'HasApi'),
    ]}))
    assert summary['configured'] == 2, summary
    assert summary['sites'] == 1, summary
    assert _keys(mgr) == ['has_api'], _keys(mgr)
    assert any('no_api' in line for line in summary['skipped']), summary['skipped']
    assert summary['build_errors']['other'] == 1, summary['build_errors']


def test_unknown_type_is_unsupported_without_guessing():
    """黑盒意图：未知 type 不得被猜成 CMS/JS——判定为 unsupported 并保留 type 值，
    诊断页要能回答「为什么不支持」。"""
    mgr = _fresh_manager()
    summary = mgr.load(json.dumps({'sites': [
        {'key': 'future', 'name': 'Future', 'type': 99,
         'api': 'https://fixture.invalid/future/'},
        _spider_entry('ok_site', 'OkSite'),
    ]}))
    assert summary['sites'] == 1, summary
    assert _keys(mgr) == ['ok_site'], _keys(mgr)
    assert 99 in summary['unknownTypes'], summary['unknownTypes']
    health = [h for h in mgr.sites.diagnostics if h.site_key == 'future']
    assert len(health) == 1, mgr.sites.diagnostics
    assert health[0].runtime == 'unsupported', health[0].runtime
    assert health[0].capabilities == [], health[0].capabilities


def test_string_type_is_tolerated_like_gson():
    """黑盒意图：`"type": "1"`（TVBox 手写仓常见笔误）按 Gson 语义当整数 1 处理，
    条目正常装配而不是被判非法。"""
    mgr = _fresh_manager()
    summary = mgr.load(json.dumps({'sites': [
        {'key': 'str_type', 'name': 'StrType', 'type': '1',
         'api': 'https://fixture.invalid/cms/provide/vod/'},
    ]}))
    assert summary['sites'] == 1, summary
    assert _keys(mgr) == ['str_type'], _keys(mgr)
    site = mgr.sites.get('str_type')
    assert site.health.runtime == 'cms', site.health.runtime
    assert site.entry.type == 1, site.entry.type


def test_duplicate_site_keys_are_rejected_and_previous_config_survives():
    """黑盒意图：单仓配置里重复的站点 key 是**校验错误**（L1_CONFIG_PARSE_FAILED，
    details 带 duplicateKeys），且校验不通过时上一份健康配置继续服务。"""
    mgr = _fresh_manager()
    mgr.load(json.dumps({'sites': [_spider_entry('keep_me', 'KeepMe')]}))
    assert _keys(mgr) == ['keep_me'], _keys(mgr)
    try:
        mgr.load(json.dumps({'sites': [
            _spider_entry('dup', 'DupA'),
            _spider_entry('dup', 'DupB'),
        ]}))
    except ContractError as exc:
        assert exc.code == 'L1_CONFIG_PARSE_FAILED', exc.code
        assert exc.details.get('duplicateKeys') == ['dup'], exc.details
    else:
        raise AssertionError('重复站点 key 应当被校验拒绝')
    # 旧配置继续可用（C2.1：validate 不通过不清空站点）
    assert _keys(mgr) == ['keep_me'], _keys(mgr)
    assert mgr.state()['summary']['healthy'] == 1, mgr.state()['summary']


def test_changed_content_swaps_snapshot():
    """黑盒意图：内容变化时快照真的被换掉（swapCount 递增），运行站点表等于新配置的
    站点集合——「点了导入但站点没变」必须能从外部观测到。"""
    mgr = _fresh_manager()
    first = mgr.load(json.dumps({'sites': [_spider_entry('a_one', 'AOne')]}))
    second = mgr.load(json.dumps({'sites': [_spider_entry('b_two', 'BTwo'),
                                            _spider_entry('b_three', 'BThree')]}))
    assert first['snapshotId'] != second['snapshotId'], (first['snapshotId'],
                                                         second['snapshotId'])
    assert mgr.swap_count == 2, mgr.swap_count
    assert _keys(mgr) == ['b_two', 'b_three'], _keys(mgr)
    assert mgr.state()['swapCount'] == 2, mgr.state()['swapCount']


def test_same_content_reuses_running_snapshot():
    """黑盒意图：同内容重复加载复用运行中快照（reused=True），不重建站点、不重启
    Worker——站点对象身份保持不变。"""
    mgr = _fresh_manager()
    payload = json.dumps({'sites': [_spider_entry('reuse_me', 'ReuseMe')]})
    first = mgr.load(payload)
    site_before = mgr.sites.get('reuse_me')
    second = mgr.load(payload)
    assert second.get('reused') is True, second
    assert mgr.reuse_count == 1, mgr.reuse_count
    assert mgr.swap_count == 1, mgr.swap_count
    assert second['snapshotId'] == first['snapshotId'], (second, first)
    assert mgr.sites.get('reuse_me') is site_before, '同内容重载不得重建站点对象'


# ===========================================================================
# 二、多仓（顶层 urls）
# ===========================================================================
def test_depot_falls_back_and_records_trail():
    """黑盒意图：多仓按声明顺序回退到第一个可用子仓，轨迹里能看到「试过谁、选中谁、
    谁因何失败」——用户看到的失败原因必须等于真实原因。"""
    mgr = _fresh_manager()
    summary = mgr.load(fixture().config('depot.json'))
    trail = summary['depot']
    assert trail['isDepot'] is True, trail
    assert trail['declared'] == 3, trail
    assert trail['selected']['name'] == 'good-second', trail['selected']
    assert trail['fallbackOrder'] == ['broken-first', 'good-second'], trail['fallbackOrder']
    reasons = [item['reason'] for item in trail['failures']]
    assert reasons and 'HTTP 404' in reasons[0], reasons
    assert mgr.snapshot.fetch.transport == 'depot', mgr.snapshot.fetch.transport
    # 运行中快照的源是「用户输入的多仓地址」，最终 URL 是选中的子仓
    assert mgr.snapshot.fetch.source_url == fixture().config('depot.json')


def test_depot_merges_sites_and_lives_from_extra_repos():
    """黑盒意图：多仓合并是「只增不删」——主仓站点原样保留，其余子仓的站点与直播源
    按 key/url 去重后追加（避免单一仓命中时直播源消失）。"""
    mgr = _fresh_manager()
    mgr.load(fixture().config('depot.json'))
    keys = _keys(mgr)
    assert 'depot_good_cms' in keys, keys
    assert 'depot_extra_cms' in keys, keys
    names = [live.get('name') for live in mgr.lives]
    assert 'depot-good-live' in names and 'depot-extra-live' in names, names
    assert len(mgr.lives) == len(set(names)), names


def test_depot_zero_site_entry_is_skipped_not_selected():
    """黑盒意图：子仓「声明了站点但一个都装配不出来」时不算选中，继续回退到下一条，
    而不是把空仓当成结果（depot_fallback.json 的第一条正是这种）。"""
    mgr = _fresh_manager()
    mgr.load(fixture().config('depot_fallback.json'))
    assert mgr.snapshot.depot.selected_name == 'good-second', mgr.snapshot.depot
    reasons = [item['reason'] for item in mgr.snapshot.depot.failures]
    assert '0 sites' in reasons, reasons
    assert _keys(mgr) == ['depot_good_cms'], _keys(mgr)


def test_depot_with_all_entries_bad_raises_l1_fetch():
    """黑盒意图：所有子仓都不可用时整次加载失败（L1:fetch，带上第一条的真实原因），
    且不留下任何运行站点。"""
    mgr = _fresh_manager()
    try:
        mgr.load(fixture().config('depot_all_bad.json'))
    except ValueError as exc:
        assert '[L1:fetch]' in str(exc), str(exc)
        assert 'all multi-repo entries failed' in str(exc), str(exc)
    else:
        raise AssertionError('全部子仓失败时应当整体报错')
    assert _keys(mgr) == [], _keys(mgr)
    assert mgr.snapshot is None, mgr.snapshot


# ===========================================================================
# 三、站点能力推导（渲染层依赖的契约）
# ===========================================================================
def _load_capability_sites(extra_entries):
    mgr = _fresh_manager()
    mgr.load(json.dumps({'sites': extra_entries}))
    return mgr


def test_capability_defaults_are_all_enabled():
    """黑盒意图：什么都不声明的站点按 FongMi 默认全开（home/detail/player/proxy +
    search/quickSearch/filter/changeable），渲染层不必猜默认值。"""
    mgr = _load_capability_sites([_spider_entry('plain', 'Plain')])
    site = mgr.sites.get('plain')
    caps = site.health.capabilities
    for cap in ('home', 'detail', 'player', 'proxy', 'search', 'quickSearch',
                'filter', 'changeable'):
        assert cap in caps, (cap, caps)
    assert site.searchable and site.filterable and site.changeable and site.danmaku
    assert site.timeout_ms == 15000, site.timeout_ms


def test_searchable_zero_removes_search_capability():
    """黑盒意图：searchable=0 的站点在能力集合里没有 search/quickSearch——否则渲染层
    会发出注定失败的搜索请求。"""
    mgr = _load_capability_sites([
        _spider_entry('nosearch', 'NoSearch', searchable=0),
        _spider_entry('searchable', 'Searchable', searchable=1),
    ])
    off = mgr.sites.get('nosearch').health.capabilities
    on = mgr.sites.get('searchable').health.capabilities
    assert 'search' not in off, off
    assert 'quickSearch' not in off, off
    assert 'home' in off and 'detail' in off, off
    assert 'search' in on, on


def test_searchable_two_is_not_searchable():
    """黑盒意图：searchable=2（FongMi 里「可搜但被关掉」）不算可搜——只认 1，
    否则字段矩阵与能力集合会自相矛盾。"""
    mgr = _load_capability_sites([_spider_entry('s2', 'S2', searchable=2)])
    site = mgr.sites.get('s2')
    assert site.searchable is False, site.searchable
    assert 'search' not in site.health.capabilities, site.health.capabilities


def test_filterable_and_changeable_drive_capability_set():
    """黑盒意图：filterable/changeable 的开关直接决定 filter/changeable 能力是否进入
    集合（换源入口与筛选入口由渲染层按此开关显示）。"""
    mgr = _load_capability_sites([
        _spider_entry('no_filter', 'NoFilter', filterable=0),
        _spider_entry('no_change', 'NoChange', changeable=0),
        _spider_entry('both', 'Both', filterable=1, changeable=1),
    ])
    assert 'filter' not in mgr.sites.get('no_filter').health.capabilities
    assert 'changeable' not in mgr.sites.get('no_change').health.capabilities
    both = mgr.sites.get('both').health.capabilities
    assert 'filter' in both and 'changeable' in both, both


def test_site_timeout_field_drives_timeout_ms():
    """黑盒意图：站点级 timeout（秒）落到 timeout_ms，缺省 15s 且 max(timeout,1)。
    站点级超时不生效会让慢源拖死整个请求预算。"""
    mgr = _load_capability_sites([
        _spider_entry('t7', 'T7', timeout=7),
        _spider_entry('t0', 'T0', timeout=0),
        _spider_entry('tdef', 'TDef'),
    ])
    assert mgr.sites.get('t7').timeout_ms == 7000, mgr.sites.get('t7').timeout_ms
    assert mgr.sites.get('t0').timeout_ms == 1000, mgr.sites.get('t0').timeout_ms
    assert mgr.sites.get('tdef').timeout_ms == 15000, mgr.sites.get('tdef').timeout_ms
    assert mgr.sites.get('t7').entry.timeout_declared is True


def test_hide_and_indexs_flags_reach_site():
    """黑盒意图：hide/indexs 落到 Site 并被聚合进 summary（hide 站点仍可按 key 直达，
    但首页/搜索不展示）。"""
    mgr = _load_capability_sites([
        _spider_entry('hidden', 'Hidden', hide=1),
        _spider_entry('indexed', 'Indexed', indexs=1),
        _spider_entry('normal', 'Normal'),
    ])
    assert mgr.sites.get('hidden').hide is True
    assert mgr.sites.get('indexed').index is True
    assert mgr.sites.get('normal').hide is False
    assert mgr.sites.get('normal').index is False
    assert mgr.snapshot.summary['hidden'] == 1, mgr.snapshot.summary.get('hidden')


def test_categories_accepts_list_and_comma_string():
    """黑盒意图：categories 既接受数组也接受逗号分隔串，统一成字符串列表
    （分类白名单，空列表 = 不过滤）。"""
    mgr = _load_capability_sites([
        _spider_entry('clist', 'CList', categories=['电影', '综艺']),
        _spider_entry('cstr', 'CStr', categories='电影, 纪录片'),
        _spider_entry('cnone', 'CNone'),
    ])
    assert mgr.sites.get('clist').categories == ['电影', '综艺']
    assert mgr.sites.get('cstr').categories == ['电影', '纪录片']
    assert mgr.sites.get('cnone').categories == []


def test_unsupported_runtime_advertises_no_capabilities():
    """黑盒意图：unsupported 运行时的站点能力集合为空——渲染层据此隐藏入口，
    而不是显示一个点了必失败的分类页。"""
    mgr = _fresh_manager()
    mgr.load(fixture().config('unknown_type.json'))
    health = [h for h in mgr.sites.diagnostics
              if h.site_key == 'future_type' or h.runtime == 'unsupported']
    assert health, [h.site_key for h in mgr.sites.diagnostics]
    for item in health:
        if item.runtime == 'unsupported':
            assert item.capabilities == [], (item.site_key, item.capabilities)
            assert item.state == 'unsupported', item.state


# ===========================================================================
# 四、内容 API 端到端（CatVod 契约）
# ===========================================================================
def test_home_content_matches_catvod_contract():
    """黑盒意图：homeContent 返回 CatVod 扁平结构——class 是 {type_id,type_name} 列表
    且非空，list 是数组且非空，每项带 vod_id/vod_name。"""
    _install_demo()
    payload = ok_body(*act(do='homeContent', site='demo'), label='homeContent')
    classes = payload.get('class')
    assert isinstance(classes, list) and classes, payload
    for item in classes:
        assert isinstance(item.get('type_id'), str) and item['type_id'], item
        assert isinstance(item.get('type_name'), str) and item['type_name'], item
    listing = payload.get('list')
    assert isinstance(listing, list) and listing, payload
    for item in listing:
        assert isinstance(item.get('vod_id'), str) and item['vod_id'], item
        assert isinstance(item.get('vod_name'), str) and item['vod_name'], item


def test_category_content_pagination_fields():
    """黑盒意图：categoryContent 返回 list + 分页字段（page/pagecount/limit/total），
    page 回显请求页码（渲染层据此决定是否还有下一页）。"""
    _install_demo()
    payload = ok_body(*act(do='categoryContent', site='demo', tid='movie', pg='3'),
                      label='categoryContent')
    assert isinstance(payload.get('list'), list), payload
    for field in ('page', 'pagecount', 'limit', 'total'):
        assert field in payload, (field, payload)
        assert isinstance(payload[field], int), (field, payload)
    assert payload['page'] == 3, payload
    assert payload['pagecount'] >= 1, payload


def test_detail_content_play_source_shape():
    """黑盒意图：detailContent 返回单元素 list，条目带 vod_id/vod_play_from/
    vod_play_url，播放串是「名$url#名$url」的分集形态。"""
    _install_demo()
    payload = ok_body(*act(do='detailContent', site='demo', ids='["demo-1"]'),
                      label='detailContent')
    listing = payload.get('list')
    assert isinstance(listing, list) and len(listing) == 1, payload
    vod = listing[0]
    assert vod.get('vod_id') == 'demo-1', vod
    assert isinstance(vod.get('vod_play_from'), str) and vod['vod_play_from'], vod
    assert isinstance(vod.get('vod_play_url'), str) and vod['vod_play_url'], vod
    episodes = [seg for seg in vod['vod_play_url'].split('#') if seg]
    assert len(episodes) == 2, episodes
    for seg in episodes:
        assert '$' in seg, seg


def test_search_content_echoes_keyword():
    """黑盒意图：searchContent 的结果与关键词对应（换关键词换结果），且返回 list +
    vod_id/vod_name 的 CatVod 形态。"""
    _install_demo()
    payload = ok_body(*act(do='searchContent', site='demo', word='黑盒关键词'),
                      label='searchContent')
    listing = payload.get('list')
    assert isinstance(listing, list) and listing, payload
    assert '黑盒关键词' in listing[0]['vod_name'], listing[0]
    assert isinstance(listing[0].get('vod_id'), str) and listing[0]['vod_id'], listing[0]


def test_player_content_normalized_fields():
    """黑盒意图：playerContent 结果被宿主归一化成统一播放契约（url/parse/header/
    jx/flag/...），渲染层与播放器按这套字段消费。"""
    _install_demo()
    payload = ok_body(*act(do='playerContent', site='demo', flag='demo',
                           id='demo://ep1', vipFlags='[]'), label='playerContent')
    for field in ('url', 'parse', 'header', 'jx', 'flag', 'playUrl', 'headers',
                  'format', 'subs', 'msg', 'code'):
        assert field in payload, (field, payload)
    assert isinstance(payload['url'], str) and payload['url'], payload
    assert payload['parse'] == 0, payload
    assert payload['flag'] == 'demo', payload
    assert isinstance(payload['header'], dict), payload


def test_home_video_content_shape():
    """黑盒意图：homeVideoContent（「全部」总览 feed）返回 {list: [...]} 且与
    homeContent 的首页列表同源同形。"""
    _install_demo()
    payload = ok_body(*act(do='homeVideoContent', site='demo'), label='homeVideoContent')
    listing = payload.get('list')
    assert isinstance(listing, list) and listing, payload
    home = ok_body(*act(do='homeContent', site='demo'), label='homeContent')
    assert [item['vod_id'] for item in listing] == [item['vod_id'] for item in home['list']]


def test_local_demo_spider_end_to_end_via_site_manager():
    """黑盒意图：不经配置层，直接用 site_manager 加载本地 demo spider（进程外 Worker）
    走完五个内容方法——返回类型与关键字段符合 CatVod 契约。"""
    from site_manager import SiteManager

    manager = SiteManager()
    try:
        site = manager.load_local('demo_direct', DEMO_PATH)
        assert site.health.runtime == 'python', site.health.runtime
        home = site.runner.homeContent(False)
        assert isinstance(home, dict) and home['list'] and home['class']
        category = site.runner.categoryContent('movie', '1', False, {})
        assert isinstance(category, dict) and isinstance(category['list'], list)
        assert category['page'] == 1, category
        detail = site.runner.detailContent(['demo-1'])
        assert isinstance(detail['list'], list) and detail['list'][0]['vod_id'] == 'demo-1'
        search = site.runner.searchContent('direct', '0', '1')
        assert 'direct' in search['list'][0]['vod_name'], search
        player = site.runner.playerContent('demo', 'demo://ep2', [])
        assert player['url'].startswith('https://'), player
        assert site.runner.getName() == '示例源', site.runner.getName()
    finally:
        manager.destroy_all()


def test_search_word_alias_key_is_equivalent():
    """黑盒意图：searchContent 的关键词支持 word 与 key 两种参数名（TVBox 两种写法
    都在用），同值必须得到同结果。"""
    _install_demo()
    by_word = ok_body(*act(do='searchContent', site='demo', word='alias-kw'),
                      label='by word')
    by_key = ok_body(*act(do='searchContent', site='demo', key='alias-kw'),
                     label='by key')
    assert by_word['list'][0]['vod_name'] == by_key['list'][0]['vod_name'], (by_word,
                                                                             by_key)


def test_detail_content_uses_first_id():
    """黑盒意图：detailContent 传多个 id 时按首个 id 返回结果（CatVod 的批量约定由
    各 spider 自决，这里固定「首个 id 决定 vod_id」这条可见行为）。"""
    _install_demo()
    payload = ok_body(*act(do='detailContent', site='demo', ids='["first-id","second-id"]'),
                      label='detail multi ids')
    assert payload['list'][0]['vod_id'] == 'first-id', payload


# ===========================================================================
# 五、错误处理契约（结构化错误，不穿透）
# ===========================================================================
def test_unknown_site_key_returns_l2_site_not_found():
    """黑盒意图：未知站点 key → 404 + L2_SITE_NOT_FOUND 包络（与「参数错」的 400
    区分开），且 siteKey 回显请求里的 key。"""
    _install_demo()
    status, text = act(do='homeContent', site='site-that-does-not-exist')
    payload, error = err_body(status, text, label='unknown site')
    assert status == 404, (status, text[:200])
    assert error['code'] == 'L2_SITE_NOT_FOUND', error
    assert error['siteKey'] == 'site-that-does-not-exist', error
    assert error['stage'] == 'site', error
    assert payload['requestId'], payload


def test_unsupported_action_returns_l3_invalid_request():
    """黑盒意图：不支持的动作 → 400 + L3_RUNTIME_INVALID_REQUEST，不抛异常穿透，
    也不退化成 500。"""
    _install_demo()
    status, text = act(do='definitelyNotAnAction', site='demo')
    _payload, error = err_body(status, text, label='unknown do')
    assert status == 400, (status, text[:200])
    assert error['code'] == 'L3_RUNTIME_INVALID_REQUEST', error
    assert error['stage'] == 'runtime', error
    assert error['retryable'] is False, error


def test_missing_do_parameter_returns_structured_error():
    """黑盒意图：完全不带 do 参数 → 400 结构化错误（不是 KeyError 穿透成 500）。"""
    _install_demo()
    status, text = act(site='demo')
    _payload, error = err_body(status, text, label='missing do')
    assert status == 400, (status, text[:200])
    assert error['code'] == 'L3_RUNTIME_INVALID_REQUEST', error


def test_missing_site_falls_back_to_first_site():
    """黑盒意图：不带 site 时按「最近/首个站点」分发（TVBox 老客户端不带 siteKey 的
    写法），返回 200 的正常内容而非报错。"""
    _install_demo()
    payload = ok_body(*act(do='homeContent'), label='default site')
    assert payload['list'], payload
    assert payload['list'][0]['vod_name'].startswith('示例影片'), payload


def test_malformed_ids_returns_structured_runtime_error():
    """黑盒意图：ids 不是合法 JSON 数组 → 结构化运行时错误（502 + L3 码），
    请求不会把 JSONDecodeError 抛到调用方。"""
    _install_demo()
    status, text = act(do='detailContent', site='demo', ids='[not-json')
    payload, error = err_body(status, text, label='bad ids')
    assert status == 502, (status, text[:200])
    assert error['code'].startswith('L3'), error
    assert error['siteKey'] == 'demo', error
    assert payload['ok'] is False and payload['result'] is None, payload


def test_non_numeric_page_returns_structured_runtime_error():
    """黑盒意图：非法分页参数（pg 非数字）→ 结构化错误而非 500；而数字型边界页码
    （0/负数）由 spider 自行解释并原样回显。"""
    _install_demo()
    status, text = act(do='categoryContent', site='demo', tid='movie', pg='not-a-number')
    _payload, error = err_body(status, text, label='bad pg')
    assert status == 502, (status, text[:200])
    assert error['code'].startswith('L3'), error
    payload = ok_body(*act(do='categoryContent', site='demo', tid='movie', pg='0'),
                      label='pg=0')
    assert payload['page'] == 0, payload


def test_malformed_vip_flags_returns_structured_runtime_error():
    """黑盒意图：vipFlags 不是合法 JSON 时同样是结构化错误；合法但未知的播放 id
    按 demo 契约原样回落成该 id（不报错、不返回空）。"""
    _install_demo()
    status, text = act(do='playerContent', site='demo', flag='demo',
                       id='demo://ep1', vipFlags='{oops')
    _payload, error = err_body(status, text, label='bad vipFlags')
    assert status == 502, (status, text[:200])
    assert error['code'].startswith('L3'), error
    payload = ok_body(*act(do='playerContent', site='demo', flag='demo',
                           id='unknown://id', vipFlags='[]'), label='unknown id')
    assert payload['url'] == 'unknown://id', payload


def test_error_envelope_leaks_no_stacktrace():
    """黑盒意图：错误响应体不含栈帧/源码路径（脱敏契约），只给稳定错误码与消息。"""
    _install_demo()
    status, text = act(do='detailContent', site='demo', ids='[broken')
    assert status >= 400, (status, text[:200])
    for marker in ('Traceback', 'File "', '.py", line', 'site_manager.py', 'server.py'):
        assert marker not in text, (marker, text[:400])


# ===========================================================================
# 六、幂等与隔离
# ===========================================================================
def test_repeated_home_content_is_identical():
    """黑盒意图：同一请求连续调用结果完全一致（缓存命中与直出两条路径给出同一份
    内容），不存在「第二次变空」这类缓存污染。"""
    _install_demo()
    first = ok_body(*act(do='homeContent', site='demo'), label='first')
    second = ok_body(*act(do='homeContent', site='demo'), label='second')
    third = ok_body(*act(do='homeContent', site='demo'), label='third')
    assert first == second == third, (first, second, third)


def test_repeated_player_content_is_stable():
    """黑盒意图：同一集连续解析得到同一播放地址（60s 缓存 + 持久层不会给出漂移的
    直链）。"""
    _install_demo()
    args = dict(do='playerContent', site='demo', flag='demo', id='demo://ep1',
                vipFlags='[]')
    first = ok_body(*act(**args), label='play first')
    second = ok_body(*act(**args), label='play second')
    assert first['url'] == second['url'], (first, second)
    assert first['parse'] == second['parse'] == 0, (first, second)


def test_concurrent_home_content_not_cross_sourced():
    """黑盒意图：并发调用多个站点时每个响应都来自自己的源（按站点名一一对应），
    不出现「A 的请求拿到 B 的内容」这种串源。"""
    tags = ['Alpha', 'Bravo', 'Charlie', 'Delta']
    _install_variants(tags)

    def one(index):
        status, text = act(do='homeContent', site='site_%s' % tags[index])
        payload = ok_body(status, text, label='concurrent home %d' % index)
        return tags[index], payload['list'][0]['vod_name']

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(one, range(len(tags))))
    for tag, name in results:
        assert name.startswith(tag), (tag, name, results)
    assert [tag for tag, _ in results] == tags, results


def test_concurrent_search_matches_keyword_per_site():
    """黑盒意图：并发搜索时「站点」与「关键词」双维度一一对应——既不串源，也不串
    关键词（缓存键必须同时含二者）。"""
    tags = ['Echo', 'Foxtrot', 'Golf', 'Hotel']
    _install_variants(tags)

    def one(index):
        tag = tags[index]
        keyword = 'kw-%s' % tag
        status, text = act(do='searchContent', site='site_%s' % tag, word=keyword)
        payload = ok_body(status, text, label='concurrent search %d' % index)
        return tag, keyword, payload['list'][0]['vod_name']

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(one, range(len(tags))))
    assert len(results) == len(tags), results
    for tag, keyword, name in results:
        assert keyword in name, (tag, keyword, name)
    assert len({name for _, _, name in results}) == len(tags), results


def test_concurrent_multi_method_calls_keep_site_identity():
    """黑盒意图：同一站点并发走不同内容方法（home/detail/search）时，每个响应都属于
    请求指定的站点——进程外 Runner 的并发上下文不得互相覆盖。"""
    tags = ['India', 'Juliet']
    _install_variants(tags)

    def one(index):
        tag = tags[index]
        site_key = 'site_%s' % tag
        home = ok_body(*act(do='homeContent', site=site_key), label='home')
        detail = ok_body(*act(do='detailContent', site=site_key, ids='["id-%s"]' % tag),
                         label='detail')
        search = ok_body(*act(do='searchContent', site=site_key, word='w-%s' % tag),
                         label='search')
        return (tag,
                home['list'][0]['vod_name'].startswith(tag),
                detail['list'][0]['vod_id'] == 'id-%s' % tag,
                ('w-%s' % tag) in search['list'][0]['vod_name'])

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(one, range(len(tags))))
    for tag, home_ok, detail_ok, search_ok in results:
        assert home_ok and detail_ok and search_ok, (tag, results)


def test_site_state_fields_stable_after_content_calls():
    """黑盒意图：内容调用成功后站点健康状态保持 healthy 且运行时标签不变——
    /sites 面板消费的字段不得因为一次调用而漂移。"""
    mgr = _install_variants(['Kilo'])
    before = mgr.state()['sites'][0]
    ok_body(*act(do='homeContent', site='site_Kilo'), label='home')
    ok_body(*act(do='searchContent', site='site_Kilo', word='w'), label='search')
    after = mgr.state()['sites'][0]
    assert before['key'] == after['key'] == 'site_Kilo', (before, after)
    assert after['runtime'] == before['runtime'] == 'python', (before, after)
    assert after['healthy'] is True, after
    assert after['state'] == before['state'] == 'healthy', (before, after)
    assert after['lastError'] is None, after


def test_diagnostic_view_exposes_configured_vs_healthy():
    """黑盒意图：/sites 的 summary 同时给出 configured/built/initialized/healthy 四个
    计数——「导入看起来健康」不等于「声明的源都可用」，两者必须可分。"""
    mgr = _fresh_manager()
    mgr.load(json.dumps({'sites': [
        _spider_entry('good_one', 'GoodOne'),
        {'key': 'bad_one', 'name': 'BadOne', 'type': 99,
         'api': 'https://fixture.invalid/bad/'},
    ]}))
    state = mgr.state()
    summary = state['summary']
    assert summary['configured'] == 2, summary
    assert summary['built'] == 1, summary
    assert summary['healthy'] == 1, summary
    assert state['unsupportedCount'] == 1, state['unsupportedCount']
    assert len(state['sites']) == 1, state['sites']
    assert state['sites'][0]['spiderType'] == 'py', state['sites'][0]


# ===========================================================================
# runner
# ===========================================================================
def _host_setup():
    """宿主侧一次性初始化（只在 __main__ 进程跑）。"""
    root = tempfile.mkdtemp(prefix='yuki-cbc-')
    _CTX['root'] = root
    os.environ['YUKI_TEST_ROOT'] = root
    os.environ['YUKI_DATA_DIR'] = os.path.join(root, 'data')
    os.environ['YUKI_CACHE_DIR'] = os.path.join(root, 'cache')

    hoststate.configure(
        data_dir=os.path.join(root, 'data'),
        cache_dir=os.path.join(root, 'cache'),
        plugins_dir=os.path.join(root, 'cache', 'py'),
        log_dir=os.path.join(root, 'logs'),
        port=0, token='')
    hoststate.ensure_dirs()

    # RM-4：playerContent 持久缓存目录重定向，避免污染真实 ~/.yuki/cache
    import play_cache
    play_dir = tempfile.mkdtemp(prefix='yuki-cbc-play-')
    play_cache.set_dir_for_tests(play_dir)
    _CTX['play_dir'] = play_dir

    # 配置装配会为每个失败条目 logger.error 整段 traceback（预期内），压掉以保持
    # 输出可读；断言失败仍由 runner 打印。
    logging.disable(logging.ERROR)


def _teardown():
    for mgr in _CTX['managers']:
        try:
            mgr.sites.destroy_all()
        except Exception:
            pass
    _CTX['managers'] = []
    try:
        server.sites.destroy_all()
    except Exception:
        pass
    if _CTX['fixture'] is not None:
        try:
            _CTX['fixture'].close()
        except Exception:
            pass
        _CTX['fixture'] = None
    for key in ('root', 'play_dir'):
        path = _CTX.get(key) or ''
        if path and os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        _CTX[key] = ''


if __name__ == '__main__':
    multiprocessing.freeze_support()
    _host_setup()
    passed, failed = [], []
    try:
        for name, fn in sorted(globals().items()):
            if not (name.startswith('test_') and callable(fn)):
                continue
            try:
                fn()
            except Exception as exc:
                failed.append((name, '%s: %s' % (type(exc).__name__, exc)))
                print('FAIL %s -> %s: %s' % (name, type(exc).__name__, exc))
            else:
                passed.append(name)
                print('PASS %s' % name)
    finally:
        _teardown()
    print()
    print('RESULT: %d passed, %d failed' % (len(passed), len(failed)))
    for name, detail in failed:
        print('  FAILED %s: %s' % (name, detail))
    sys.exit(1 if failed else 0)
