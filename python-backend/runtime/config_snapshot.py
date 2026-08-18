# -*- coding: utf-8 -*-
"""C2.1 ConfigSnapshot 标准模型 + C2.3 站点字段矩阵。

三层分离（此前三者混在 `ConfigManager` 的散装属性里）：

* :class:`ConfigFetchResult` —— **下载结果**：源 URL、最终 URL、状态码、ETag、
  Last-Modified、内容哈希、字节数、跳转链、伪装形态、耗时。
* :class:`ParsedConfig` —— **解析结果**：站点条目矩阵 + 顶层字段，纯数据，不含任何
  运行时对象，因此可以在 validate 阶段被整体丢弃。
* :class:`ConfigSnapshot` —— **运行中配置**：解析结果 + 已装配站点 + 多仓轨迹 +
  加载时间，作为原子替换的单位。

字段矩阵按 FongMi `Site.java` 的 getter 语义取默认值（`type=0`、`hide=0`、
`indexs=0`、`searchable/quickSearch/changeable/danmaku=1`、`timeout` 缺省
`TIMEOUT_PLAY=15s` 且 `max(timeout,1)` 秒），未知字段整条保留在 `raw` 里并单列
`unknown_fields`，供后续按真实上游契约补适配器——不猜测语义、不丢弃。
"""
import hashlib
import json
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

from .errors import redact_sensitive

# FongMi Constant.TIMEOUT_PLAY = 15s；站点 timeout 字段单位是秒，且 max(timeout, 1)。
DEFAULT_SITE_TIMEOUT_MS = 15000

# 站点条目里我们已经理解语义的字段。不在此列的一律进 unknown_fields，
# 但**不会**被丢弃：raw 保留整条原始条目。
KNOWN_SITE_FIELDS = frozenset({
    'key', 'name', 'type', 'api', 'ext', 'jar', 'click', 'playUrl',
    'hide', 'indexs', 'timeout', 'searchable', 'quickSearch', 'filterable',
    'changeable', 'danmaku', 'categories', 'header', 'headers', 'style',
})

# 顶层已理解字段。
KNOWN_TOP_FIELDS = frozenset({
    'sites', 'urls', 'spider', 'parses', 'flags', 'lives', 'wallpaper',
    'msg', 'logo', 'warningText', 'video', 'live', 'parse', 'drives',
    'headers', 'header', 'ijk', 'ads', 'doh', 'rules', 'hosts', 'proxy',
    'homepage', 'heat', 'hotList', 'sitesFilter', 'style', 'name', 'version',
})

_PAN_KEYWORDS = ('quark', 'uc', 'baidu', 'tianyi', '123pan', 'xunlei', 'aliyun',
                 'alipan', 'aliyundrive', 'pikpak')


def content_hash(payload):
    """配置正文指纹。bytes/str 都接受；用于同内容重载判定与快照 id。"""
    if isinstance(payload, str):
        payload = payload.encode('utf-8', errors='replace')
    return hashlib.sha256(payload or b'').hexdigest()


def _as_int(value, default):
    try:
        if value is None or isinstance(value, bool):
            return int(default) if value is None else int(bool(value))
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def site_flag(value, default):
    """FongMi 的整型开关：缺省取 default，`== 1` 才算开。

    注意 `searchable=2` 在 FongMi 里表示「可搜但被用户关掉」，`isSearchable()`
    返回 false，所以这里也只认 1。

    公开而非私有：`capability_router.capabilities_for` 必须用同一份语义，否则会出现
    「字段矩阵说不可搜、能力集合说可搜」的自相矛盾（能力是按同一条目推导的）。
    """
    if value is None:
        return int(default) == 1
    if isinstance(value, bool):
        return value
    return _as_int(value, default) == 1


def normalize_header(value):
    """FongMi HeaderAdapter：JSON 对象或「内含 JSON 的字符串」都归一成 dict。"""
    if isinstance(value, dict):
        return {str(k): ('' if v is None else str(v)) for k, v in value.items()}
    if isinstance(value, str) and value.strip().startswith('{'):
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, ValueError):
            return {}
        if isinstance(parsed, dict):
            return {str(k): ('' if v is None else str(v)) for k, v in parsed.items()}
    return {}


def normalize_style(value):
    """FongMi Style：`{type, ratio}`；非法值返回 None（运行时回退 rect）。"""
    if isinstance(value, dict):
        style = {}
        if value.get('type') is not None:
            style['type'] = str(value.get('type'))
        try:
            if value.get('ratio') is not None:
                style['ratio'] = float(value.get('ratio'))
        except (TypeError, ValueError):
            pass
        return style or None
    return None


def resolve_relative(value, base_url):
    """相对地址（`./x`、`../x`）按**最终配置 URL** 解析；其余原样返回。"""
    text = str(value or '').strip()
    if not text:
        return ''
    if (text.startswith('./') or text.startswith('../')) and base_url:
        return urljoin(base_url, text)
    return text


def split_jar_ref(value, base_url=''):
    """拆 `url;md5[;class]` 形态的 jar 引用，并按配置 URL 解析相对路径。

    TVBox 的 jar 常伪装成 .jpg/.png/.bin，所以这里**不按后缀过滤**；是否是真 jar
    由下载环节按 zip/dex 魔数校验。
    """
    raw = str(value or '').strip()
    if not raw:
        return '', ''
    head, sep, tail = raw.partition(';')
    head = resolve_relative(head.strip(), base_url)
    return head, (tail.strip() if sep else '')


@dataclass
class SiteEntry:
    """一条站点配置的完整字段矩阵 + 原始条目 + 路由结论。"""

    key: str = ''
    name: str = ''
    type: int = 0
    api: str = ''
    ext: object = ''
    jar: str = ''
    jar_md5: str = ''
    click: str = ''
    play_url: str = ''
    hide: bool = False
    index: bool = False
    timeout_ms: int = DEFAULT_SITE_TIMEOUT_MS
    timeout_declared: bool = False
    searchable: bool = True
    quick_search: bool = True
    filterable: bool = True
    changeable: bool = True
    danmaku: bool = True
    categories: list = field(default_factory=list)
    header: dict = field(default_factory=dict)
    style: object = None
    raw: dict = field(default_factory=dict)
    unknown_fields: list = field(default_factory=list)
    shared_spider: str = ''
    jar_from_site: bool = False
    ext_origin: str = ''
    ext_expanded: bool = False
    route: object = None
    valid: bool = True
    invalid_reason: str = ''

    def to_dict(self, *, include_raw=False):
        payload = {
            'key': self.key, 'name': self.name, 'type': int(self.type),
            'api': redact_sensitive(self.api, 300),
            'jar': redact_sensitive(self.jar, 300),
            'jarFromSite': bool(self.jar_from_site),
            'hide': bool(self.hide), 'indexs': bool(self.index),
            'timeoutMs': int(self.timeout_ms),
            'timeoutDeclared': bool(self.timeout_declared),
            'searchable': bool(self.searchable),
            'quickSearch': bool(self.quick_search),
            'filterable': bool(self.filterable),
            'changeable': bool(self.changeable),
            'danmaku': bool(self.danmaku),
            'categories': list(self.categories),
            'headerKeys': sorted(self.header.keys()),
            'style': self.style,
            'click': redact_sensitive(self.click, 200),
            'playUrl': redact_sensitive(self.play_url, 200),
            'extType': type(self.ext).__name__,
            'extOrigin': redact_sensitive(self.ext_origin, 300),
            'extExpanded': bool(self.ext_expanded),
            'unknownFields': list(self.unknown_fields),
            'valid': bool(self.valid),
        }
        if self.invalid_reason:
            payload['invalidReason'] = self.invalid_reason
        if self.route is not None:
            payload['route'] = self.route.to_dict()
        if include_raw:
            payload['raw'] = dict(self.raw)
        return payload

    @property
    def is_pan(self):
        blob = str(self.api or '').lower()
        return any(word in blob for word in _PAN_KEYWORDS)


def normalize_site_entry(item, *, base_url='', shared_spider=''):
    """把一条原始 site 条目归一成 :class:`SiteEntry`。

    只做「读字段 + 解相对路径 + 记未知字段」，不发起网络请求、不做路由判定，
    因此可以在 validate 阶段被无副作用地丢弃。
    """
    data = dict(item or {}) if isinstance(item, dict) else {}
    key = str(data.get('key') or '').strip()
    entry = SiteEntry(
        key=key,
        name=str(data.get('name') or key),
        type=_as_int(data.get('type'), 0),
        raw=data,
        shared_spider=str(shared_spider or ''),
    )
    entry.unknown_fields = sorted(str(k) for k in data.keys() if k not in KNOWN_SITE_FIELDS)
    if not isinstance(item, dict):
        entry.valid = False
        entry.invalid_reason = 'site 条目不是 JSON 对象'
        return entry

    entry.api = resolve_relative(data.get('api'), base_url)
    # `ext` 原样保留（可以是字符串/对象/数组/数字）。归一化成字符串、解析内部相对
    # 路径、以及决定要不要按 `Site.fetchExt` 展开，全部由 C2.2 的 ExtResolver 按
    # **运行时契约**做：type=4 拿展开后的文本、type=3 拿原始字符串，矩阵层若提前
    # 压成一个值，两种契约就只剩一种了。
    entry.ext = '' if data.get('ext') is None else data.get('ext')
    # 站点级 jar 优先于顶层共享 spider（FongMi Site.objectFrom 的同一优先级）。
    site_jar, site_md5 = split_jar_ref(data.get('jar'), base_url)
    if site_jar:
        entry.jar, entry.jar_md5, entry.jar_from_site = site_jar, site_md5, True
    else:
        entry.jar, entry.jar_md5 = split_jar_ref(shared_spider, base_url)
    entry.click = str(data.get('click') or '')
    entry.play_url = resolve_relative(data.get('playUrl'), base_url)
    entry.hide = site_flag(data.get('hide'), 0)
    entry.index = site_flag(data.get('indexs'), 0)
    if data.get('timeout') is not None:
        entry.timeout_declared = True
        entry.timeout_ms = max(1, _as_int(data.get('timeout'), 15)) * 1000
    entry.searchable = site_flag(data.get('searchable'), 1)
    entry.quick_search = site_flag(data.get('quickSearch'), 1)
    # filterable 是 TVBox 扩展字段（FongMi Site 无此字段）；沿用桌面端既有默认 1。
    entry.filterable = site_flag(data.get('filterable'), 1)
    entry.changeable = site_flag(data.get('changeable'), 1)
    entry.danmaku = site_flag(data.get('danmaku'), 1)
    categories = data.get('categories')
    if isinstance(categories, list):
        entry.categories = [str(v) for v in categories if str(v or '').strip()]
    elif isinstance(categories, str) and categories.strip():
        entry.categories = [v.strip() for v in categories.split(',') if v.strip()]
    entry.header = normalize_header(data.get('header') if data.get('header') is not None
                                    else data.get('headers'))
    entry.style = normalize_style(data.get('style'))
    if not entry.key or not entry.api:
        entry.valid = False
        entry.invalid_reason = 'site 条目缺少 key 或 api'
    return entry


@dataclass
class ConfigFetchResult:
    """下载结果。与解析结果分离，便于「同内容」判定和条件请求。"""

    source_url: str = ''
    final_url: str = ''
    transport: str = 'inline'          # http / file / inline
    status: int = 0
    etag: str = ''
    last_modified: str = ''
    content_hash: str = ''
    size: int = 0
    redirects: list = field(default_factory=list)
    disguise: str = ''                 # gzip / image / ''
    encoding: str = ''
    elapsed_ms: int = 0
    fetched_at: float = 0.0
    from_cache: bool = False

    @property
    def base_url(self):
        """相对 api/jar/ext 的解析基址：**最终** URL 优先于源 URL。"""
        for candidate in (self.final_url, self.source_url):
            if str(candidate or '').lower().startswith(('http://', 'https://')):
                return candidate
        return ''

    def to_dict(self):
        return {
            'sourceUrl': redact_sensitive(self.source_url, 300),
            'finalUrl': redact_sensitive(self.final_url, 300),
            'transport': self.transport,
            'status': int(self.status),
            'etag': self.etag,
            'lastModified': self.last_modified,
            'contentHash': self.content_hash,
            'size': int(self.size),
            'redirects': [redact_sensitive(u, 200) for u in self.redirects],
            'disguise': self.disguise,
            'encoding': self.encoding,
            'elapsedMs': int(self.elapsed_ms),
            'fetchedAt': int(self.fetched_at * 1000) if self.fetched_at else 0,
            'fromCache': bool(self.from_cache),
        }


@dataclass
class RepoTrail:
    """多仓（顶层 `urls` 仓库集）轨迹：尝试顺序、选中条目、失败回退顺序。"""

    is_depot: bool = False
    declared: int = 0
    considered: list = field(default_factory=list)   # [{name, url}] 实际尝试顺序
    selected_name: str = ''
    selected_url: str = ''
    preferred_name: str = ''
    failures: list = field(default_factory=list)     # [{name, url, reason}]
    merged: list = field(default_factory=list)       # 参与 lives/sites 合并的子仓
    truncated: int = 0

    def record_attempt(self, name, url):
        self.considered.append({'name': str(name or ''), 'url': redact_sensitive(url, 200)})

    def record_failure(self, name, url, reason):
        self.failures.append({'name': str(name or ''), 'url': redact_sensitive(url, 200),
                              'reason': redact_sensitive(reason, 200)})

    def to_dict(self):
        return {
            'isDepot': bool(self.is_depot),
            'declared': int(self.declared),
            'truncated': int(self.truncated),
            'attempted': list(self.considered),
            'selected': {'name': self.selected_name,
                         'url': redact_sensitive(self.selected_url, 200)},
            'preferred': self.preferred_name,
            'fallbackOrder': [item['name'] for item in self.considered],
            'failures': list(self.failures),
            'merged': [redact_sensitive(u, 200) for u in self.merged],
        }


@dataclass
class ParsedConfig:
    """解析结果：纯数据，不含任何运行时对象。"""

    entries: list = field(default_factory=list)
    spider: str = ''
    parses: list = field(default_factory=list)
    flags: list = field(default_factory=list)
    lives: list = field(default_factory=list)
    wallpaper: str = ''
    header: dict = field(default_factory=dict)
    unknown_fields: list = field(default_factory=list)
    raw_top_level: dict = field(default_factory=dict)

    @classmethod
    def from_json(cls, cfg, *, base_url='', shared_spider=None):
        data = dict(cfg or {})
        spider = str(data.get('spider') or '').strip()
        shared = shared_spider if shared_spider is not None else spider
        entries = [normalize_site_entry(item, base_url=base_url, shared_spider=shared)
                   for item in (data.get('sites') or [])]
        flags = data.get('flags') or []
        if isinstance(flags, str):
            flags = [v.strip() for v in flags.split(',') if v.strip()]
        return cls(
            entries=entries,
            spider=spider,
            parses=list(data.get('parses') or []),
            flags=list(flags),
            lives=list(data.get('lives') or []),
            wallpaper=str(data.get('wallpaper') or ''),
            header=normalize_header(data.get('header') if data.get('header') is not None
                                    else data.get('headers')),
            unknown_fields=sorted(str(k) for k in data.keys() if k not in KNOWN_TOP_FIELDS),
            raw_top_level={k: v for k, v in data.items() if k != 'sites'},
        )

    def to_dict(self):
        return {
            'siteCount': len(self.entries),
            'spider': redact_sensitive(self.spider, 300),
            'parses': len(self.parses),
            'flags': list(self.flags),
            'lives': len(self.lives),
            'wallpaper': redact_sensitive(self.wallpaper, 300),
            'headerKeys': sorted(self.header.keys()),
            'unknownFields': list(self.unknown_fields),
        }


@dataclass
class ConfigSnapshot:
    """运行中配置的原子替换单位。"""

    fetch: ConfigFetchResult = field(default_factory=ConfigFetchResult)
    parsed: ParsedConfig = field(default_factory=ParsedConfig)
    depot: RepoTrail = field(default_factory=RepoTrail)
    sites: list = field(default_factory=list)          # 已装配 Site 对象
    diagnostics: list = field(default_factory=list)    # SiteHealth
    summary: dict = field(default_factory=dict)
    routes: list = field(default_factory=list)         # RouteDecision
    security: dict = field(default_factory=dict)
    artifacts: list = field(default_factory=list)
    loaded_at: float = 0.0
    state: str = 'prepared'    # prepared / running / rejected / retired
    reject_reason: str = ''
    # 「同内容重复加载」判据。单仓等于正文哈希；多仓覆盖清单 + 选中子仓地址与正文，
    # 因此子仓内容变化或仓切换都不会被误判成同内容。
    source_hash: str = ''
    swap_seq: int = 0

    @property
    def snapshot_id(self):
        parts = [self.fetch.content_hash[:16] or 'nohash']
        if self.depot.selected_name:
            parts.append(self.depot.selected_name)
        return '-'.join(parts)

    @property
    def healthy_count(self):
        return sum(1 for site in self.sites if getattr(site.health, 'healthy', False))

    @property
    def built_count(self):
        return sum(1 for site in self.sites if getattr(site.health, 'built', False))

    @property
    def source_label(self):
        url = self.fetch.source_url
        return url if str(url).lower().startswith(('http://', 'https://')) else '(inline)'

    def to_dict(self, *, include_entries=False):
        payload = {
            'snapshotId': self.snapshot_id,
            'state': self.state,
            'swapSeq': int(self.swap_seq),
            'sourceHash': self.source_hash[:16],
            'loadedAt': int(self.loaded_at * 1000) if self.loaded_at else 0,
            'fetch': self.fetch.to_dict(),
            'parsed': self.parsed.to_dict(),
            'depot': self.depot.to_dict(),
            'sites': len(self.sites),
            'healthy': self.healthy_count,
            'routes': [route.to_dict() for route in self.routes],
            'security': dict(self.security),
            'artifacts': list(self.artifacts),
        }
        if self.reject_reason:
            payload['rejectReason'] = redact_sensitive(self.reject_reason, 300)
        if include_entries:
            payload['entries'] = [entry.to_dict() for entry in self.parsed.entries]
        return payload


def make_fetch_result(source_url, *, transport='inline', raw=b'', final_url='',
                      status=0, etag='', last_modified='', redirects=None,
                      disguise='', encoding='', started=None, from_cache=False):
    now = time.time()
    return ConfigFetchResult(
        source_url=str(source_url or ''),
        final_url=str(final_url or ''),
        transport=transport,
        status=int(status or 0),
        etag=str(etag or ''),
        last_modified=str(last_modified or ''),
        content_hash=content_hash(raw),
        size=len(raw or b''),
        redirects=list(redirects or []),
        disguise=str(disguise or ''),
        encoding=str(encoding or ''),
        elapsed_ms=int(max(0.0, now - started) * 1000) if started else 0,
        fetched_at=now,
        from_cache=bool(from_cache),
    )


def host_of(url):
    try:
        return urlsplit(str(url or '')).hostname or ''
    except ValueError:
        return ''
