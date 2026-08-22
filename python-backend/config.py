# -*- coding: utf-8 -*-
"""CatVod config JSON 解析与站点装配（支持热更新）。

配置格式（CatVod 标准，粘贴 URL 或内联 JSON 均可）：
{
  "spider": "xxx.jar;md5"   ← TV 端 jar，PC 侧忽略（仅日志提示）
  "sites": [{"key","name","type","api","searchable","quickSearch","filterable","ext"}]
  "parses": [...], "flags": [...], "lives": [...], "wallpaper": "..."
}

type 处理：
- 3 = Python spider（api 为 http 地址或内联源码，走原 app.spider 协议）
- 4 = JS spider（api 为 http 地址或内联源码，quickjs 宿主加载）
- 其他（0/1 等）本期跳过并记录。
"""
import os
import json
import logging
import hashlib
import re
import time
import threading
from urllib.parse import urlparse
from urllib.parse import urljoin
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError

import app as spider_app
import hoststate
from site_manager import Site
from js_spider import make_js_spider_class
from runtime.errors import RuntimeError as RuntimeContractError, error_from_exception, redact_sensitive
from runtime.health import infer_site_health
from runtime.supervised_runner import SupervisedRunner
from runtime.capability_router import capabilities_for, refine_with_jar, route_site
from runtime.config_security import (
    ARTIFACTS, ConfigSecurityError, ConfigSecurityPolicy, SourceTrust,
    fetch_guarded, guard_local_config_path, guard_url)
from runtime.config_snapshot import (
    ConfigFetchResult, ConfigSnapshot, ParsedConfig, RepoTrail, content_hash,
    make_fetch_result, normalize_site_entry)
from runtime.ext_resolver import ExtCancelled, ExtResolver
from runtime.config_cache import ConfigRepositoryCache

logger = logging.getLogger('yuki.config')

# 多仓扫描上限：防止条目过多导致加载时间不可控
MAX_MULTI_REPO_ENTRIES = 12

# 单次配置加载的总预算（秒）。ext 展开、子仓回退都在这个预算内，
# 超出后按 L1_CONFIG_TIMEOUT 结束，不无限等待。
CONFIG_LOAD_BUDGET = float(os.environ.get('YUKI_CONFIG_LOAD_BUDGET') or 90)
# 磁盘缓存恢复预算：恢复要「快」，远小于常规加载预算；预算耗尽保留已建成部分。
RESTORE_LOAD_BUDGET = float(os.environ.get('YUKI_RESTORE_LOAD_BUDGET') or 45)
# 恢复模式的合并阶段上限：主条目建完即可用，附加仓合并（可能撞死镜像）只给零头。
RESTORE_MERGE_BUDGET = float(os.environ.get('YUKI_RESTORE_MERGE_BUDGET') or 8)

# 内置 JVM runner jar（与 python-backend 同层 vendor/，开发与打包路径均兼容）
DEFAULT_RUNNER_JAR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'vendor', 'spider-runner.jar')


def fetch_text(url, timeout=15):
    """http(s) 递归跟重定向取文本（受 C2.5 安全边界约束）。失败返回 ''。

    兼容三类 TVBox 生态特殊接口：
    - 图片伪装接口（饭太硬系）：JPEG/PNG 尾部嵌入 base64 的配置 JSON，自动解出；
    - gzip 压缩：自动解压（带解压后体积上限，防压缩炸弹）；
    - 常规 JSON/直播源：原样返回文本。
    """
    return fetch_text_diagnostics(url, timeout=timeout)['text']


def fetch_text_diagnostics(url, timeout=15, *, policy=None, trust=None, kind='config',
                           raise_blocked=False):
    """与 :func:`fetch_text` 同路径，同时返回 ConfigSnapshot 需要的下载元数据。

    `trust` 缺省时把 `url` 自身当作信任根——用户直接输入的地址（配置源、直播源）
    即使指向内网也属于显式选择；而配置**内部**派生出来的地址必须由调用方显式传入
    真正的信任根，否则远端仓可以借它探测本机服务（C2.5）。

    `raise_blocked=True` 时安全边界拒绝直接上抛（配置加载需要区分「取不到」和
    「被拒绝」）；默认捕获成 `blocked` 字段，保持既有旁路调用方的容错语义。
    """
    from urllib.parse import urlsplit
    policy = policy or ConfigSecurityPolicy.from_env()
    trust = trust if trust is not None else SourceTrust.for_source(url, policy=policy)
    result = {
        'text': '', 'status': 0, 'finalUrl': '',
        'failureDomain': (urlsplit(str(url)).hostname or ''), 'error': '',
        'etag': '', 'lastModified': '', 'contentHash': '', 'size': 0,
        'redirects': [], 'disguise': '', 'encoding': '', 'blocked': '',
    }
    started = time.monotonic()
    try:
        response = fetch_guarded(url, policy=policy, trust=trust, kind=kind,
                                 timeout=_timeout_pair(timeout))
        result['status'] = int(response.status or 0)
        result['finalUrl'] = response.final_url or str(url)
        result['failureDomain'] = urlsplit(result['finalUrl']).hostname or result['failureDomain']
        result['etag'] = response.etag
        result['lastModified'] = response.last_modified
        result['redirects'] = list(response.redirects)
        raw = response.raw
        if response.decompressed:
            result['disguise'] = 'gzip'
        if response.error:
            result['error'] = response.error
            return result
        img_cfg = _image_tail_config(raw)
        if img_cfg is not None:
            result['disguise'] = 'image'
            result['text'] = img_cfg
            result['contentHash'] = content_hash(img_cfg)
            result['size'] = len(raw)
            result['encoding'] = 'base64/utf-8'
            return result
        from runtime.ext_resolver import detect_text
        declared = ''
        ctype = str(response.headers.get('content-type') or '')
        if 'charset=' in ctype.lower():
            declared = ctype.lower().split('charset=', 1)[1].split(';')[0].strip()
        text, encoding = detect_text(raw, declared)
        result['text'] = text
        result['encoding'] = encoding
        result['contentHash'] = content_hash(raw)
        result['size'] = len(raw)
        return result
    except ConfigSecurityError as exc:
        logger.warning('fetch_text %s blocked: %s', url, exc.reason)
        if raise_blocked:
            raise
        result['error'] = str(exc)
        result['blocked'] = exc.reason
        return result
    except Exception as e:
        logger.warning('fetch_text %s failed: %s', url, str(e)[:80])
        result['error'] = str(e)[:240]
        return result
    finally:
        result['elapsedMs'] = int((time.monotonic() - started) * 1000)


def _timeout_pair(timeout):
    """把存量的单值超时归一成 (connect, read) 组合。"""
    if isinstance(timeout, (tuple, list)) and len(timeout) == 2:
        return (float(timeout[0]), float(timeout[1]))
    try:
        value = float(timeout)
    except (TypeError, ValueError):
        value = 15.0
    return (min(5.0, value), value)


def _image_tail_config(raw):
    """图片伪装接口：JPEG/PNG 尾部嵌入 base64 的配置 JSON（如 饭太硬.net/tv、哈基米.png）。

    文件头为 JFIF/JPEG 或 PNG 图片，尾部追加一段长 base64；base64 解码后是配置 JSON。
    非图片或解码失败返回 None。
    """
    if not raw:
        return None

    # 检测 JPEG 或 PNG 魔数
    is_jpeg = raw[:3] == b'\xff\xd8\xff'
    is_png = raw[:8] == b'\x89PNG\r\n\x1a\n'

    if not (is_jpeg or is_png):
        return None

    try:
        import re
        import base64
        t = raw.decode('ascii', errors='ignore')
        segs = re.findall(r'[A-Za-z0-9+/=]{100,}', t)
        if not segs:
            return None
        text = base64.b64decode(segs[-1]).decode('utf-8', errors='replace').lstrip()
        if text.startswith('{'):
            return text
    except Exception:
        pass
    return None


def _strip_json_comment_lines(text):
    """剥 TVBox 配置常见的注释与首尾空白。

    覆盖三类形态：
    - 整行注释：行首 `//...`（老刘备/小盒子/苹果CMS 等）与 `#...`（苹果CMS parses 区）；
    - 行内注释：`{//数据接口...`（分享等）。
    为避免误伤 URL（https://...），行内 `//` 仅当前一字符不是 ':' 时视为注释
    （URL 的 `//` 前必为 ':'，注释的 `//` 前为 {、,、空白等）。
    """
    import re
    lines = []
    for l in (text or '').split('\n'):
        s = l.strip()
        if s.startswith('//') or s.startswith('#'):
            continue
        # 行内注释：// 前不是 ':'（排除 https://）且不在字符串值内部
        l = re.sub(r'(?<!:)\/\/[^"\n]*', ' ', l)
        lines.append(l)
    return '\n'.join(lines).strip()


def _looks_like_live_source(text):
    """判断文本是否为直播源（TXT / M3U）而非 CatVod 配置 JSON。

    TXT 直播源：含「,#genre#」分组行；M3U：以 #EXTM3U 开头或含 #EXTINF。
    命中任一即视为直播源，用于把「误把直播源当配置载入」引导到正确入口。
    """
    head = (text or '').lstrip()[:4096]
    if not head:
        return False
    if head.startswith('#EXTM3U') or '#EXTINF' in head:
        return True
    if ',#genre#' in head:
        return True
    return False


def parse_config_json(text):
    """解析 CatVod 配置 JSON；非 JSON 时抛出可读的 ValueError（而非裸 JSONDecodeError）。

    先尝试严格解析；成功说明是干净 JSON，直接返回——注释剥除只作为兜底。
    （不能无条件先剥：合法 JSON 字符串值内部也可能含 "//"（如内嵌 JS spider
    源码的注释），行内剥除会把它们连同后续代码一起吃掉，损坏源码。）
    最常见的误用是把直播源地址（.txt/.m3u）粘进「配置」框——这里显式识别并给出
    可操作的引导，避免用户只看到 'Expecting value: line 1 column 1'。
    """
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    text = _strip_json_comment_lines(text)
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError) as e:
        if _looks_like_live_source(text):
            raise ValueError(
                '[L1:parse] 这是直播源（txt/m3u），不是配置。请到「设置 → 源设置 → 直播源」'
                '添加该地址，而不是从这里载入配置。'
            ) from e
        snippet = (text or '').strip()[:80].replace('\n', ' ')
        raise ValueError(
            '[L1:parse] 配置不是有效的 JSON（无法解析）。请确认地址返回的是 CatVod 配置文件。'
            '内容开头：%r' % snippet
        ) from e


class _LoadContext:
    """一次配置加载的共享上下文：安全策略、信任根、ext 解析器、预算与取消信号。

    `_prepare` / `_build_site` 的签名被既有测试以三位置参数固定
    （`test_site_health.py` 里有子类覆盖），所以上下文挂在管理器上而不是加参数。
    一次 `load()` 内部即使并发构建站点，也只读同一个上下文对象。
    """

    def __init__(self, source, *, policy=None, allow_local_file=False,
                 cancel_event=None, budget=None, generation=0,
                 salvage_partial=False):
        self.policy = policy or ConfigSecurityPolicy.from_env(
            **({'allow_local_file': True} if allow_local_file else {}))
        # 顶层来源是用户在设置里亲手输入/选择的那一个地址，本身就构成「显式选择」：
        # 本地路径可读、同源子资源继承信任。`allow_local_file` 只是宿主侧的额外声明
        # 位（例如文件选择对话框），不改变这一点；配置**内部**派生出来的地址永远走
        # `guard_url`，本地路径与 file:// 在那里被无条件拒绝。
        self.trust = SourceTrust.for_source(
            source, policy=self.policy, user_selected_local_file=True)
        self.allow_local_file = bool(allow_local_file)
        self.cancel_event = cancel_event
        self.started = time.monotonic()
        budget = CONFIG_LOAD_BUDGET if budget is None else float(budget)
        self.deadline = self.started + budget if budget > 0 else None
        self.ext = ExtResolver(policy=self.policy, trust=self.trust,
                               cancel_event=cancel_event)
        self.artifacts = []
        # 所属加载的代际（0 = 低层测试直接构造的上下文，不参与代际守卫）
        self.generation = int(generation)
        # 构建期预算耗尽时保留已建成站点继续 swap（磁盘缓存恢复用）：
        # 恢复讲究「快」，预算内没建完的站点记为跳过，而不是整体失败回退网络重载。
        self.salvage_partial = bool(salvage_partial)

    def check(self):
        """取消/超时检查点。装配的每一步都要过一次，否则取消无法真正生效。"""
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise RuntimeContractError('L1_CONFIG_CANCELLED')
        if self.deadline is not None and time.monotonic() > self.deadline:
            raise RuntimeContractError(
                'L1_CONFIG_TIMEOUT', raw_error='config load budget exhausted')

    def remaining(self):
        if self.deadline is None:
            return None
        return max(0.0, self.deadline - time.monotonic())

    def record_artifact(self, kind, url, path):
        try:
            fingerprint = ARTIFACTS.register(kind, url, path)
        except Exception:
            return None
        self.artifacts.append(fingerprint.to_dict())
        return fingerprint


class ConfigManager:
    def __init__(self, site_manager):
        self.sites = site_manager
        self.parses = []
        self.flags = []
        self.lives = []
        self.wallpaper = ''
        self.source_url = ''
        # T40：多仓最近一次成功的条目名；重载时优先该条目，
        # 避免不同次载入命中不同仓导致 lives 等数据漂移（直播源消失）
        self.last_repo_name = ''
        self._repo_pref_loaded = False
        # C2.1：下载结果 / 解析结果 / 运行中配置分离。
        self.snapshot = None                 # 运行中的 ConfigSnapshot
        self.last_healthy_snapshot = None    # 最近一份 healthy>0 的快照（失败回退用）
        self.swap_count = 0
        self.reuse_count = 0
        self._ctx = None
        self._ctx_lock = threading.Lock()
        # 加载代际：新加载（或接管/取消）自增，旧加载即便跑到装配完成，
        # 最终 swap 也会因代际不匹配被拒绝——防止被放弃的旧加载覆盖新配置。
        self._load_generation = 0
        self._progress_cb = None   # 本次 load 的进度回调（恢复/导入进度条）
        self.repository_cache = None
        self.cache_restored = False
        self.cache_age = 0
        self._cache_documents = {}
        self._cache_manifest_text = ''
        self._restoring_documents = {}

    def configure_repository_cache(self):
        """Bind the repository cache after hoststate has loaded user directories."""
        self.repository_cache = ConfigRepositoryCache(
            os.path.join(hoststate.get_cache_dir(), 'config'))

    def _repository_cache(self):
        if self.repository_cache is None:
            self.configure_repository_cache()
        return self.repository_cache

    # ------------------------------------------------ 多仓条目偏好（T40）

    @staticmethod
    def _repo_pref_file():
        try:
            d = hoststate.get_data_dir()
            if d:
                os.makedirs(d, exist_ok=True)
                return os.path.join(d, 'last_repo.txt')
        except Exception:
            pass
        return ''

    def _repo_pref(self):
        """上次成功的多仓条目名（跨进程持久化，惰性读盘一次）。"""
        if not self._repo_pref_loaded:
            self._repo_pref_loaded = True
            p = self._repo_pref_file()
            if p:
                try:
                    with open(p, encoding='utf-8') as f:
                        self.last_repo_name = f.read().strip()
                except Exception:
                    pass
        return self.last_repo_name

    def _save_repo_pref(self, name):
        self.last_repo_name = name or ''
        p = self._repo_pref_file()
        if not p:
            return
        try:
            with open(p, 'w', encoding='utf-8') as f:
                f.write(self.last_repo_name)
        except Exception:
            pass

    @staticmethod
    def _normalize_repo_entry(item):
        """兼容 TVBox/FongMi 多仓常见的 URL 条目写法。"""
        if isinstance(item, str):
            value = item.strip()
            return {'name': '', 'url': value} if value else None
        if not isinstance(item, dict):
            return None
        url = (item.get('url') or item.get('urlStr') or item.get('source')
               or item.get('sourceUrl') or item.get('link') or '')
        if isinstance(url, (dict, list)):
            return None
        name = item.get('name') or item.get('title') or item.get('key') or ''
        return {'name': str(name), 'url': str(url).strip()}

    def _resolve_repo_url(self, base, sub):
        """多仓子仓地址：相对路径以多仓配置源 URL 为基址，并过 C2.5 安全边界。

        子仓地址来自**远端配置内容**：`guard_url` 会拒掉 `file://`、本地磁盘路径，
        以及严格模式（YUKI_CONFIG_BLOCK_PRIVATE_NETWORK=1）下跨源的内网/回环地址；
        默认策略允许子仓指向局域网 NAS / 本机服务。
        """
        ctx = self._context()
        return guard_url(str(sub), policy=ctx.policy, trust=ctx.trust,
                         kind='config', base_url=str(base) if str(base).startswith('http') else '')

    def _context(self, source=None, **kwargs):
        """取当前加载上下文；直接调用 `_build_site` 的低层测试会拿到一个默认上下文。"""
        if self._ctx is None:
            self._ctx = _LoadContext(source if source is not None else '', **kwargs)
        return self._ctx

    def load(self, url_or_json, _depth=0, _text=None, *, allow_local_file=False,
             force=False, cancel_event=None, budget=None, salvage_partial=False,
             progress_cb=None):
        """下载 → 解析 → 装配 → 校验 → 原子替换；返回加载摘要 dict。

        C2.1 的四条：
        - 下载结果（`ConfigFetchResult`）、解析结果（`ParsedConfig`）和运行中配置
          （`ConfigSnapshot`）三层分离；
        - 顺序固定为 prepare → validate → atomic swap；
        - validate 不通过时**不清空站点**，上一份健康配置继续可用；
        - 同内容重复加载直接复用运行中快照，不重启任何 Worker。
        """
        with self._ctx_lock:
            self._load_generation += 1
            self._ctx = _LoadContext(url_or_json, allow_local_file=allow_local_file,
                                     cancel_event=cancel_event, budget=budget,
                                     generation=self._load_generation,
                                     salvage_partial=salvage_partial)
        if not getattr(self, '_restoring_cache', False):
            self.cache_restored = False
            self.cache_age = 0
        self._cache_documents = {}
        self._cache_manifest_text = ''
        self._progress_cb = progress_cb   # 进度回调只在本次 load 生命周期内有效
        ctx = self._ctx
        try:
            return self._load_inner(url_or_json, ctx, _text=_text, force=force)
        finally:
            self._progress_cb = None
            # 只清理自己的上下文：加载可被新请求接管，旧线程退出时清掉的
            # 必须不是新加载刚装上的 ctx（否则新加载的取消/预算检查失锚）。
            with self._ctx_lock:
                if self._ctx is ctx:
                    self._ctx = None

    def cancel_active_load(self):
        """使进行中的加载失效（被新导入接管 / 用户取消）。

        代际自增后，旧加载在下一个检查点收到取消，即便它已经越过所有检查点
        跑到装配完成，`_validate_and_swap` 的代际守卫也会拒绝它的 swap 并
        释放其 Worker——被放弃的加载绝不能覆盖新配置。
        """
        with self._ctx_lock:
            self._load_generation += 1
            ctx = self._ctx
        if ctx is not None and ctx.cancel_event is not None:
            ctx.cancel_event.set()

    def _report_progress(self, stage, current, total):
        """向宿主上报加载进度（恢复/导入进度条）。回调异常绝不影响加载本身。"""
        cb = getattr(self, '_progress_cb', None)
        if cb is None:
            return
        try:
            cb(str(stage), max(0, int(current)), max(0, int(total)))
        except Exception:
            logger.debug('progress callback failed', exc_info=True)

    def _load_inner(self, url_or_json, ctx, *, _text=None, force=False):
        ctx.check()
        if _text is not None:
            text = _text
            cached_restore = bool(getattr(self, '_restoring_cache', False))
            source = (str(url_or_json) if str(url_or_json).startswith(('http://', 'https://'))
                      else '(inline)')
            fetch = make_fetch_result(
                source,
                transport='disk-cache' if cached_restore else ('inline' if source == '(inline)' else 'memory'),
                raw=str(_text).encode('utf-8', errors='replace'),
                final_url=str(url_or_json) if source != '(inline)' else '',
                started=ctx.started, from_cache=cached_restore)
        else:
            text, fetch = self._fetch_config_document(url_or_json, ctx)
        cfg = parse_config_json(text)
        ctx.check()
        repo_urls = cfg.get('urls')
        if isinstance(repo_urls, dict):
            # 兼容部分影视仓把仓名直接作为对象 key 的写法。
            repo_urls = [dict(value, name=key) if isinstance(value, dict)
                         else {'name': key, 'url': value}
                         for key, value in repo_urls.items()]
            cfg = dict(cfg)
            cfg['urls'] = repo_urls
        if (not isinstance(cfg.get('sites'), list)
                and isinstance(cfg.get('urls'), list) and cfg['urls']):
            manifest_base = fetch.base_url or str(url_or_json)
            self._cache_documents = {str(manifest_base): str(text)}
            self._cache_manifest_text = str(text)
            return self._load_depot(url_or_json, cfg, fetch, ctx, force=force)
        if not isinstance(cfg.get('sites'), list):
            raise ValueError('[L1:parse] invalid config: missing sites')
        # 同内容复用：内容哈希一致且运行中快照仍有 healthy 站点时直接复用，
        # 不重建站点、不重启任何 Worker（C2.1 验收第二条）。
        reused = self._reuse_if_same_content(fetch.content_hash, force=force)
        if reused is not None:
            return reused
        prepared = self._prepare(cfg, fetch.base_url or url_or_json, fetch=fetch)
        prepared['_cache_text'] = text
        prepared['snapshot'].source_hash = fetch.content_hash
        return self._validate_and_swap(prepared, force=force, ctx=ctx)

    def restore_cached(self, source_url='', progress_cb=None):
        """Restore the last validated repository without network access."""
        cached = self._repository_cache().load()
        if cached is None:
            return None
        source = str(source_url or cached.source_url or '')
        if not source.startswith(('http://', 'https://')):
            return None
        if source_url and str(cached.source_url or '') != source:
            logger.info('config cache source mismatch; ignoring cached repository')
            return None
        try:
            self._restoring_documents = dict(cached.documents or {})
            self._restoring_documents.setdefault(source, cached.text)
            self._restoring_cache = True
            # 恢复限时 + 部分保留：恢复是「快速兜底路径」，个别站点的外链 ext/jar
            # 不在缓存里时会走网络（死镜像单请求就能挂 30-60s），不设上限会把恢复
            # 拖到分钟级——期间 /sites 一直是示例源，用户看到的就是「重启不加载缓存」。
            # 预算内建成的站点立即生效，没建完的记为跳过，由后续网络重载补全。
            summary = self.load(source, _text=cached.text,
                                budget=RESTORE_LOAD_BUDGET, salvage_partial=True,
                                progress_cb=progress_cb)
            if self.snapshot is not None:
                self.snapshot.fetch.final_url = cached.final_url or self.snapshot.fetch.final_url
                self.snapshot.fetch.etag = cached.etag
                self.snapshot.fetch.last_modified = cached.last_modified
                self.snapshot.fetch.content_hash = cached.content_hash or self.snapshot.fetch.content_hash
            self.cache_restored = True
            self.cache_age = max(0, int(time.time() - cached.saved_at))
            summary['cached'] = True
            summary['cacheAge'] = self.cache_age
            return summary
        except Exception:
            logger.warning('cached config restore failed', exc_info=True)
            return None
        finally:
            self._restoring_cache = False
            self._restoring_documents = {}


    def _load_depot(self, url_or_json, cfg, fetch, ctx, *, force=False):
        """顶层 `urls` 仓库集：按序回退到第一个可用子仓，并记录完整轨迹。"""
        if str(fetch.transport) == 'depot':
            raise ValueError('[L1:parse] multi-repo nesting too deep')
        raw_entries = cfg.get('urls') or []
        normalized = [self._normalize_repo_entry(item) for item in raw_entries]
        normalized = [item for item in normalized if item is not None]
        trail = RepoTrail(is_depot=True, declared=len(raw_entries))
        entries = normalized[:MAX_MULTI_REPO_ENTRIES]
        if len(raw_entries) > MAX_MULTI_REPO_ENTRIES:
            trail.truncated = len(raw_entries) - len(entries)
            logger.info('multi-repo: only first %s of %s entries tried',
                        MAX_MULTI_REPO_ENTRIES, len(cfg['urls']))
        # T40：优先重试上次成功的条目（置顶），保持 lives 等数据稳定
        pref = self._repo_pref()
        trail.preferred_name = pref or ''
        if pref:
            entries = sorted(entries, key=lambda it: 0 if (it or {}).get('name') == pref else 1)
        sub_cfgs = {}   # 成功解析的子仓配置（含主条目），供 T44 跨仓合并
        chosen = None
        manifest_base = fetch.base_url or str(url_or_json)
        for entry_index, item in enumerate(entries):
            ctx.check()
            self._report_progress('fetch', entry_index + 1, len(entries))
            name = (item or {}).get('name')
            try:
                sub = self._resolve_repo_url(manifest_base, (item or {}).get('url', ''))
            except ConfigSecurityError as exc:
                trail.record_failure(name, (item or {}).get('url', ''), exc.reason)
                logger.warning('multi-repo entry blocked [%s]: %s', name, exc.reason)
                continue
            if not sub:
                continue
            trail.record_attempt(name, sub)
            for attempt in range(2 if name and name == pref else 1):
                try:
                    logger.info('multi-repo: trying entry %s', name)
                    sub_text, sub_fetch = self._fetch_config_document(sub, ctx, depot=True)
                    self._cache_documents[str(sub)] = str(sub_text)
                    sub_cfg = parse_config_json(sub_text)
                    if not isinstance(sub_cfg.get('sites'), list) or not sub_cfg['sites']:
                        raise ValueError('entry has no sites')
                    sub_cfgs[sub] = sub_cfg
                    # 复用判据必须同时覆盖多仓清单与选中子仓的正文：只看清单会在
                    # 子仓内容变化时错误复用，只看子仓会在仓切换时漏掉变化。
                    digest = content_hash('%s|%s|%s' % (
                        fetch.content_hash, sub, sub_fetch.content_hash))
                    reused = self._reuse_if_same_content(digest, force=force)
                    if reused is not None:
                        return reused
                    prepared = self._prepare(sub_cfg, sub_fetch.base_url or sub,
                                             fetch=sub_fetch, depot=trail)
                    prepared['_cache_manifest_text'] = self._cache_manifest_text
                    prepared['snapshot'].source_hash = digest
                    if prepared['summary']['sites'] > 0:
                        chosen = (item, prepared, sub)
                        break
                    # 该子仓一个站点都没建成：丢弃它已经起好的 Worker，再试下一条。
                    self._discard(prepared, reason='0 sites built')
                    logger.warning('multi-repo entry [%s] built 0 sites, try next', name)
                    trail.record_failure(name, sub, '0 sites')
                    break
                except RuntimeContractError:
                    raise
                except Exception as e:
                    if attempt == 0 and name and name == pref:
                        # T44：偏好条目偶发超时时再给一次机会，避免仓漂移
                        logger.info('multi-repo: retry preferred entry %s once', name)
                        continue
                    logger.warning('multi-repo entry failed [%s]: %s', name, e)
                    trail.record_failure(name, sub, str(e))
                    break
            if chosen:
                break
        if not chosen:
            first = trail.failures[0]['reason'] if trail.failures else 'empty'
            raise ValueError('[L1:fetch] all multi-repo entries failed; first error: %s' % first)
        item, prepared, sub = chosen
        trail.selected_name = str(item.get('name') or '')
        trail.selected_url = sub
        self._merge_repo_extras(prepared, sub_cfgs, entries, manifest_base=manifest_base)
        trail.merged = [u for u in sub_cfgs if u != prepared['source_url']]
        # 运行中快照记录「用户输入的多仓地址」为源，选中子仓为最终 URL。
        prepared['snapshot'].fetch.source_url = str(url_or_json)
        prepared['snapshot'].fetch.transport = 'depot'
        # `_prepare` 里那份 depot 视图是**选中之前**拍的：那时 selected/merged 还是空的，
        # snapshotId 也还没带子仓名。导入结果页读的是这个 summary，不刷新的话会显示
        # 「多仓，但没选中任何条目、没合并任何仓」，和 `state()` 里的快照自相矛盾。
        # 多仓兼容：不同子仓经常重复声明同一个 key；主仓/先出现者优先，
        # 不应因为重复项让已经成功构建的整份多仓快照被校验丢弃。
        self._dedupe_depot_sites(prepared)
        prepared['summary']['depot'] = trail.to_dict()
        prepared['summary']['snapshotId'] = prepared['snapshot'].snapshot_id
        summary = self._validate_and_swap(prepared, force=force, ctx=ctx)
        self._save_repo_pref(item.get('name'))
        return summary

    # ---------------------------------------------------- validate / swap

    def _validate(self, prepared, *, force=False):
        """整体校验。失败抛错，调用方不会进入 swap，旧配置继续服务。

        两条判据：

        1. 站点 key 必须唯一——重复 key 会让 `/site?key=` 的路由结果不确定；
        2. 声明了站点但**一个都没建成**时，只有在「已有一份健康的运行中配置」时
           才拒绝替换。空状态下 0 站点是需要如实呈现给用户的结果（诊断页要列出
           每条失败原因），此时替换是正确行为；已有健康配置时替换成 0 站点等于
           把可用的东西换成不可用的，属于 C2.1 要挡住的场景。
        """
        summary = prepared.get('summary') or {}
        keys = [site.key for site in (prepared.get('sites') or [])]
        duplicates = sorted({k for k in keys if keys.count(k) > 1})
        if duplicates:
            raise RuntimeContractError(
                'L1_CONFIG_PARSE_FAILED',
                raw_error='duplicate site keys: %s' % ','.join(duplicates),
                details={'duplicateKeys': duplicates})
        configured = int(summary.get('configured') or 0)
        built = int(summary.get('built') or 0)
        retained = self.last_healthy_snapshot
        if configured > 0 and built == 0 and retained is not None and not force:
            reason = (summary.get('skipped') or ['no site could be built'])[0]
            raise RuntimeContractError(
                'L1_CONFIG_PARSE_FAILED',
                message='[L1:validate] 新配置 %d 个站点全部装配失败，已保留原配置（%d 个可用站点）'
                        % (configured, retained.healthy_count),
                raw_error='no site could be built: %s' % reason,
                details={'configured': configured, 'built': 0,
                         'retainedSnapshot': retained.snapshot_id,
                         'retainedHealthy': retained.healthy_count})
        return True

    def _validate_and_swap(self, prepared, *, force=False, ctx=None):
        # 代际守卫：加载被新请求接管/取消后，旧线程即便跑到这里也不得 swap，
        # 否则会用被放弃的旧配置覆盖新加载刚换上的站点。
        ctx = ctx or self._context()
        if ctx.generation and ctx.generation != self._load_generation:
            self._discard(prepared, reason='superseded by a newer load')
            raise RuntimeContractError(
                'L1_CONFIG_CANCELLED',
                message='[L1:cancel] 配置加载已被更新的请求接管，本次结果已丢弃',
                raw_error='superseded by a newer load (gen %d != %d)'
                          % (ctx.generation, self._load_generation))
        try:
            self._validate(prepared, force=force)
        except Exception:
            self._discard(prepared, reason='validate rejected')
            raise
        self._apply(prepared)
        if prepared.get('snapshot') is not None:
            source = str(prepared['snapshot'].fetch.source_url or '')
            cache_text = (prepared.get('_cache_manifest_text') or
                          prepared.get('_cache_text', ''))
            if (source.startswith(('http://', 'https://')) and cache_text
                    and prepared['snapshot'].fetch.transport not in ('inline', 'disk-cache')):
                try:
                    self._repository_cache().save(
                        source, cache_text, fetch=prepared['snapshot'].fetch,
                        documents=self._cache_documents)
                except Exception:
                    logger.debug('config repository cache write failed', exc_info=True)
        return prepared['summary']

    def _discard(self, prepared, *, reason=''):
        """销毁一份**未被采用**的准备结果。

        多仓回退会为每个候选子仓真正起 Worker；不销毁被放弃的候选，进程和 JVM
        就会残留到下一次加载，看起来像「加载一次泄一批」。
        """
        snapshot = prepared.get('snapshot') if isinstance(prepared, dict) else None
        if snapshot is not None:
            snapshot.state = 'rejected'
            snapshot.reject_reason = str(reason or '')
        bridges = {}
        for site in (prepared.get('sites') or []):
            bridge = getattr(site.runner, 'bridge', None)
            if bridge is not None:
                bridges[id(bridge)] = bridge
            try:
                site.runner.destroy()
            except Exception:
                pass
        live = set()
        for site in self.sites.sites:
            bridge = getattr(site.runner, 'bridge', None)
            if bridge is not None:
                live.add(id(bridge))
        for bid, bridge in bridges.items():
            if bid not in live:
                try:
                    bridge.destroy()
                except Exception:
                    pass
        if reason:
            logger.info('config snapshot discarded (%s): %d prepared sites released',
                        reason, len(prepared.get('sites') or []))

    def _reuse_if_same_content(self, digest, *, force=False):
        """同内容重复加载：复用运行中快照，不重启任何 Worker。

        只在运行中快照仍有 healthy 站点时复用；全站点不健康时用户重新载入是合理的
        恢复动作，必须真正重建。
        """
        current = self.snapshot
        if force or current is None or not digest:
            return None
        if current.source_hash != digest:
            return None
        if current.healthy_count <= 0:
            return None
        self.reuse_count += 1
        current.fetch.from_cache = True
        summary = dict(current.summary or {})
        summary['reused'] = True
        summary['snapshotId'] = current.snapshot_id
        logger.info('config unchanged (%s): reusing running snapshot, %d workers kept',
                    digest[:12], len(current.sites))
        return summary

    @staticmethod
    def _resolve_spider_jar(cfg, base_url):
        """解析 config 顶层 spider（TVBox 共享 jar）为可下载的 http 地址（保留 ;md5）。

        形态：'https://x/fun.jar;md5' / './jar/x.jar'（相对 config 源）。
        注意：TVBox 生态的 jar 经常伪装成 .jpg/.png/.bin 等后缀（防直链/防封），
        因此这里**不做后缀限制**；是否为真正 jar 由下载环节按内容魔数校验
        （zip PK / dex），非 jar 的顶层 spider（如 drpy .js）会在那里跳过并记录。
        """
        raw = str(cfg.get('spider') or '').strip()
        if not raw:
            return ''
        head, sep, tail = raw.partition(';')
        head = head.strip()
        if head.startswith('./') or head.startswith('../'):
            head = urljoin(base_url, head) if base_url else ''
        if not head.startswith('http'):
            return ''
        return head + (';' + tail.strip() if sep else '')

    def _prepare(self, cfg, source, *, fetch=None, depot=None):
        """纯构建：解析 config 并构建新站点列表，不触碰现有全局状态。

        产出 `prepared` dict（既有形状，供 `_apply` 与既有测试使用）并额外挂上
        C2.1 的 :class:`ConfigSnapshot`——下载结果、解析结果（站点字段矩阵）、
        多仓轨迹、路由结论与安全策略都在里面，`_apply` 只负责把它装上去。

        签名保持 `(cfg, source)` 两位置参数：`tests/test_site_health.py` 直接调用
        并以子类覆盖 `_build_site`，改签名会静默绕开被测路径。
        """
        ctx = self._context(source)
        summary = {
            'sites': 0,
            'configured': 0,
            'built': 0,
            'initialized': 0,
            'healthy': 0,
            'sites_built': 0,
            'skipped': [],
            'parse_errors': 0,
            'parses': 0,
            'flags': 0,
            'lives': 0,
            'panSites': 0,
            'build_errors': {
                'type_unsupported': 0,  # [L2:type] 不支持的 type
                'jar_failed': 0,        # [L3:jar] jar 相关失败
                'js_failed': 0,         # [L3:js] JS spider 失败
                'cms_failed': 0,        # [L3:cms] CMS spider 失败
                'py_failed': 0,         # [L3:py] Python spider 失败
                'other': 0,             # 其他未分类错误
            },
            # C2.1/C2.3/C2.4：路由与字段矩阵的聚合视图（新增键，不改既有键语义）
            'runtimes': {},
            'unknownTypes': [],
            'unknownFields': [],
            'blocked': 0,
            'requiresAndroid': 0,
            'extExpanded': 0,
            'extFailed': 0,
            'hidden': 0,
            'reused': False,
            'snapshotId': '',
        }
        base_url = source if str(source).startswith('http') else ''
        # TVBox 标准：顶层 spider 是所有 csp_ 站点共享的 jar；解析出 http 地址后
        # 供 type=3 且 api 为类名（csp_XXX）的站点加载（见 _build_site）。
        spider_jar = self._resolve_spider_jar(cfg, base_url)
        if cfg.get('spider'):
            logger.info('config.spider=%s → shared jar: %s', cfg['spider'], spider_jar or '(not a jar / unresolved)')
        parsed = ParsedConfig.from_json(cfg, base_url=base_url, shared_spider=spider_jar)
        new_sites = []
        diagnostics = []
        items = cfg.get('sites') or []
        summary['configured'] = len(items)
        summary['unknownFields'] = list(parsed.unknown_fields)
        # 路由结论对每一条都算——包括建不起来的条目。诊断页要能回答「为什么不支持」，
        # 而不是只看到一条泛化的装配失败。
        routes = []
        for entry in parsed.entries:
            decision = route_site(entry.raw, api=entry.api, ext=entry.ext,
                                  site_key=entry.key)
            entry.route = decision
            routes.append(decision)
            summary['runtimes'][decision.runtime] = summary['runtimes'].get(decision.runtime, 0) + 1
            if not decision.supported and decision.site_type not in (0, 1, 3, 4):
                if decision.site_type not in summary['unknownTypes']:
                    summary['unknownTypes'].append(decision.site_type)
            if entry.hide:
                summary['hidden'] += 1
            if entry.is_pan:
                summary['panSites'] += 1
        # 站点构建并发化（jar 下载/子蜘蛛抓取耗时为主，串行会让导入明显卡顿）。
        # 预算兜底：fut.result() 必须带剩余预算超时——单个站点挂死（慢镜像 jar、
        # 失联 ext、worker 子进程卡住）曾把整次装配拖到无限期，READY 迟迟不打印，
        # 前端整体卡死。不用 with：__exit__ 会 join 全部线程，挂死任务会卡住退出；
        # 改为 finally 里放弃等待并取消未开跑的任务（已运行线程随进程生命周期终结）。
        # 结果按条目顺序收集：预算在队头某站点上耗尽时，后面**已经建成**的站点
        # 也要一并收走（保序），只有仍挂起的才跳过——否则队首一个死镜像 ext 会
        # 把整份磁盘恢复拖垮（恢复走 salvage_partial，详见下方 ctx.check）。
        def _record_outcome(item, site, exc):
            """一个站点 future 的定论记账（成功 / None / 站点自身异常）。"""
            if exc is not None:
                err_msg = str(exc)
                logger.error('load site %s failed: %s', item.get('key'), exc, exc_info=exc)
                health = infer_site_health(item)
                error = exc if isinstance(exc, RuntimeContractError) else error_from_exception(
                    exc, stage='site', site_key=health.site_key, runtime=health.runtime)
                if isinstance(error, RuntimeContractError) and error.runtime == 'android':
                    health.runtime = 'android'
                    health.compatibility = 'C2'
                if isinstance(error, RuntimeContractError) and error.details.get('built'):
                    health.mark_built()
                health.record_failure(error, stage='site')
                diagnostics.append(health)
                summary['built'] += int(health.built)
                summary['sites_built'] += int(health.built)
                # 过渡期保留既有 [L2:type]/[L3:js] 细分类，后接稳定 L1-L6
                # 错误码；原始文本先脱敏并限长，诊断页仍能解释 drpy/JS 等根因。
                legacy = redact_sensitive(err_msg, 240)
                runtime_tag = {
                    'jar': '[L3:jar]', 'js': '[L3:js]',
                    'cms': '[L3:cms]', 'python': '[L3:py]',
                }.get(error.runtime or health.runtime, '')
                if runtime_tag and runtime_tag not in legacy:
                    legacy = runtime_tag + ' ' + legacy
                summary['skipped'].append(
                    f"{item.get('key', '?')}: {legacy} [{error.code}] {error.message}")
                if error.code in ('L1_CONFIG_BLOCKED', 'L2_SITE_BLOCKED'):
                    summary['blocked'] += 1
                if error.code == 'L2_SITE_REQUIRES_ANDROID':
                    summary['requiresAndroid'] += 1
                # 任务五：按层级标签聚合错误计数
                if error.code in ('L2_SITE_UNSUPPORTED', 'L2_SITE_REQUIRES_ANDROID') or '[L2:type]' in err_msg:
                    summary['build_errors']['type_unsupported'] += 1
                elif health.runtime == 'jar' or error.runtime == 'jar' or '[L3:jar]' in err_msg:
                    summary['build_errors']['jar_failed'] += 1
                elif health.runtime == 'js' or error.runtime == 'js' or '[L3:js]' in err_msg:
                    summary['build_errors']['js_failed'] += 1
                elif health.runtime == 'cms' or error.runtime == 'cms' or '[L3:cms]' in err_msg:
                    summary['build_errors']['cms_failed'] += 1
                elif health.runtime == 'python' or error.runtime == 'python' or '[L3:py]' in err_msg:
                    summary['build_errors']['py_failed'] += 1
                else:
                    summary['build_errors']['other'] += 1
                return
            if site:
                new_sites.append(site)
                diagnostics.append(site.health)
                summary['sites'] += 1
                summary['sites_built'] += 1
                summary['built'] += int(site.health.built)
                summary['initialized'] += int(site.health.initialized)
                summary['healthy'] += int(site.health.healthy)
                resolved = getattr(site, 'ext_detail', None)
                if resolved is not None:
                    summary['extExpanded'] += int(bool(resolved.expanded_ok))
                    summary['extFailed'] += int(bool(resolved.error))
                return
            # A configured entry that cannot produce a Site object
            # is still a diagnostic entry.  Omitting it makes the
            # configured count collapse to "objects built" and
            # lets an import look healthier than it is.
            health = infer_site_health(item)
            error = RuntimeContractError(
                'L2_SITE_BUILD_FAILED', site_key=health.site_key,
                runtime=health.runtime,
                raw_error='site entry could not be built')
            health.record_failure(error, stage='site')
            diagnostics.append(health)
            summary['skipped'].append(
                f"{item.get('key', '?')}: [L2:site] site entry could not be built "
                f"[{error.code}] {error.message}")
            summary['build_errors']['other'] += 1

        pool = ThreadPoolExecutor(max_workers=8)
        try:
            futures = [pool.submit(self._build_site, item, base_url, spider_jar) for item in items]
            self._report_progress('build', 0, len(items))
            # 进度用独立线程按完成数上报：收集中循环会被队头挂死站点阻塞，
            # 循环内上报会让进度长时间停在原地（队头卡 30s 时进度 0/64 不动）。
            progress_stop = threading.Event()

            def _progress_ticker():
                while not progress_stop.wait(0.5):
                    self._report_progress(
                        'build', sum(1 for f in futures if f.done()), len(items))

            if getattr(self, '_progress_cb', None) is not None:
                threading.Thread(target=_progress_ticker, daemon=True,
                                 name='config-build-progress').start()
            try:
                outcomes = [None] * len(items)   # (site, exc) | None=未定论（跳过）
                collected = 0
                budget_exhausted = False
                for i, (item, fut) in enumerate(zip(items, futures)):
                    try:
                        site = fut.result(timeout=ctx.remaining())
                    except Exception as e:
                        # 区分「站点自身抛错」与「预算等待超时」：future 未完成说明异常
                        # 来自等待上限而非站点。停止等待，先收走其余已完成的结果。
                        if not fut.done():
                            budget_exhausted = True
                            logger.warning('site build wait exceeded config load budget; stop waiting (%s)',
                                           item.get('key'))
                            break
                        outcomes[i] = (None, e)
                    else:
                        outcomes[i] = (site, None)
                    collected = i + 1
                if budget_exhausted:
                    # 救援：把已完成却被队头挂死站点挡住的结果按序收走；仍挂起的跳过。
                    for i, (item, fut) in enumerate(zip(items, futures)):
                        if i < collected:
                            continue
                        if not fut.done():
                            continue
                        try:
                            outcomes[i] = (fut.result(), None)
                        except Exception as e:
                            outcomes[i] = (None, e)
                for item, outcome in zip(items, outcomes):
                    if outcome is None:
                        continue
                    _record_outcome(item, outcome[0], outcome[1])
                self._report_progress('build', len(outcomes), len(items))
            finally:
                progress_stop.set()
        finally:
            # 放弃等待而非 join：挂死的构建线程无法强杀，join 会把装配卡在退出路上。
            pool.shutdown(wait=False, cancel_futures=True)
        # 取消/超时：构建过程中已经真的起了 Worker 子进程，直接上抛会把它们留成孤儿
        # （下一次加载看起来像「加载一次泄一批」）。先释放已建成的部分再上抛。
        # 例外：salvage_partial（磁盘缓存恢复）在**预算耗尽**且已有建成站点时
        # 保留部分结果继续 swap——恢复要快，被慢镜像 ext 卡住的少数站点记跳过即可，
        # 整体失败回退网络重载反而让用户长时间停留在示例源。取消仍然立即上抛。
        try:
            ctx.check()
        except RuntimeContractError as error:
            if (getattr(ctx, 'salvage_partial', False)
                    and error.code == 'L1_CONFIG_TIMEOUT' and new_sites):
                logger.warning(
                    'restore budget exhausted: keep %d/%d built sites, skip the rest',
                    len(new_sites), len(items))
            else:
                self._discard({'sites': new_sites},
                              reason='cancelled or timed out during build')
                raise
        # 装配阶段可能细化路由（R4 → R5：拿到 JAR 字节分级后才知道要不要 Android），
        # 快照必须存**最终**结论，否则诊断页显示的是下载前的乐观判断。
        refined = [getattr(h, 'route', None) for h in diagnostics]
        if len(refined) == len(routes):
            routes = [new if new is not None else old for new, old in zip(refined, routes)]
        parses = cfg.get('parses') or []
        flags = cfg.get('flags') or []
        lives = cfg.get('lives') or []
        summary['parses'] = len(parses)
        summary['flags'] = len(flags)
        summary['lives'] = len(lives)
        source_url = source if str(source).startswith('http') else '(inline)'
        if fetch is None:
            fetch = make_fetch_result(source_url, transport='inline',
                                      raw=json.dumps(cfg, sort_keys=True,
                                                     ensure_ascii=False).encode('utf-8'),
                                      started=ctx.started)
        snapshot = ConfigSnapshot(
            fetch=fetch, parsed=parsed, depot=depot or RepoTrail(),
            sites=new_sites, diagnostics=diagnostics, summary=summary, routes=routes,
            security={'policy': ctx.policy.to_dict(), 'trust': ctx.trust.to_dict()},
            artifacts=list(ctx.artifacts), source_hash=fetch.content_hash)
        summary['snapshotId'] = snapshot.snapshot_id
        summary['depot'] = snapshot.depot.to_dict()
        summary['security'] = dict(snapshot.security)
        return {
            'sites': new_sites,
            'parses': parses,
            'flags': flags,
            'lives': lives,
            'wallpaper': cfg.get('wallpaper') or '',
            'source_url': source_url,
            'summary': summary,
            'diagnostics': diagnostics,
            'snapshot': snapshot,
        }

    def _apply(self, prepared):
        """热替换：先整体原子替换，再销毁旧站点。

        L-22：旧序（先 destroy_all 再 extend）存在空窗期——并发请求在
        销毁与安装之间到达会 404。改为先把 sites 列表整体换血，请求立即
        看到新站点，旧站点随后销毁。
        M-17 配套：不再无条件关停全部 JVM——仅回收新配置不再引用的桥
        （同 jar 热重载复用进程，不再杀-重启）。
        C2.1：`snapshot` 与站点列表在同一步安装，因此任何时刻 `self.snapshot`
        描述的都是**当前真正在跑**的那份配置，不会出现「快照已换、站点未换」的中间态。
        """
        old = list(self.sites.sites)
        old_bridges = {}
        for s in old:
            b = getattr(s.runner, 'bridge', None)
            if b is not None:
                old_bridges[id(b)] = b
        snapshot = prepared.get('snapshot')
        previous = self.snapshot
        self.sites.sites[:] = prepared['sites']
        self.parses = prepared['parses']
        self.flags = prepared['flags']
        self.lives = prepared['lives']
        self.wallpaper = prepared['wallpaper']
        self.source_url = prepared['source_url']
        self.sites.diagnostics[:] = prepared.get('diagnostics') or []
        if snapshot is not None:
            self.swap_count += 1
            snapshot.state = 'running'
            snapshot.loaded_at = time.time()
            snapshot.swap_seq = self.swap_count
            self.snapshot = snapshot
            if snapshot.healthy_count > 0:
                self.last_healthy_snapshot = snapshot
        if previous is not None and previous is not snapshot:
            previous.state = 'retired'
        for s in old:
            try:
                s.runner.destroy()
            except Exception:
                pass
        # 回收新配置不再引用的 JVM 桥（同 jar 复用，换掉的才关停）
        new_bridge_ids = set()
        for s in self.sites.sites:
            b = getattr(s.runner, 'bridge', None)
            if b is not None:
                new_bridge_ids.add(id(b))
        for bid, b in old_bridges.items():
            if bid not in new_bridge_ids:
                try:
                    b.destroy()
                except Exception:
                    pass

    # ------------------------------------------------ 多仓合并（T44）

    def _dedupe_depot_sites(self, prepared):
        """多仓最终保护：主仓及先合并的仓库保留同 key 的第一项。"""
        sites = list(prepared.get('sites') or [])
        if not sites:
            return
        kept = []
        seen = set()
        duplicates = []
        for site in sites:
            key = str(getattr(site, 'key', '') or '').strip()
            if not key or key not in seen:
                kept.append(site)
                if key:
                    seen.add(key)
                continue
            duplicates.append(key)
        kept_bridges = {id(getattr(site.runner, 'bridge', None))
                        for site in kept
                        if getattr(site.runner, 'bridge', None) is not None}
        for site in sites:
            if site in kept:
                continue
            bridge = getattr(site.runner, 'bridge', None)
            if id(bridge) in kept_bridges:
                continue
            try:
                site.runner.destroy()
            except Exception:
                pass
        if not duplicates:
            return
        prepared['sites'][:] = kept
        summary = prepared.setdefault('summary', {})
        summary['duplicateKeys'] = sorted(set(duplicates))
        summary['duplicatesSkipped'] = len(duplicates)
        summary.setdefault('skipped', []).extend(
            f'{key}: duplicate site key skipped [L1:duplicate]' for key in duplicates)
        # diagnostics 保留所有原始条目的健康记录（包括被去重的条目），便于诊断页
        # 解释配置声明数；只有最终运行中的 sites 列表移除重复 Runner。
        summary['sites'] = len(kept)
        summary['built'] = sum(int(s.health.built) for s in kept)
        summary['initialized'] = sum(int(s.health.initialized) for s in kept)
        summary['healthy'] = sum(int(s.health.healthy) for s in kept)
        summary['sites_built'] = summary['built']
        logger.info('multi-repo merge: skipped %d duplicate site keys', len(duplicates))

    def _merge_repo_extras(self, prepared, sub_cfgs, entries, *, manifest_base=''):
        """T44：主条目出影片源，其余条目的 lives/sites 并行补拉后合并去重。

        避免单一仓命中时直播源缺失/视频源变少（仓漂移）。
        只增不删：主条目内容原样保留，合并失败静默跳过。
        """
        # 预算已耗尽（磁盘恢复 salvage 后必然如此）：合并是增强项，逐站点检查点
        # 会立刻全部停止，先抓附加仓正文只是白等一轮网络超时——直接跳过。
        ctx = self._context()
        try:
            ctx.check()
        except RuntimeContractError as error:
            if error.code == 'L1_CONFIG_CANCELLED':
                raise
            logger.warning('multi-repo merge skipped (load budget exhausted)')
            return
        if getattr(ctx, 'salvage_partial', False) and ctx.deadline is not None:
            # 磁盘恢复模式：主条目已建成即可用，合并只给零头时间——附加仓的
            # 死镜像站点（单个 ext/jar 挂 30s+）会把恢复尾巴拖长，进度条停在
            # 满格长时间不动（表现为「打开后检测进度直接是满的」）。
            ctx.deadline = min(ctx.deadline, time.monotonic() + RESTORE_MERGE_BUDGET)
        primary_src = prepared['source_url']
        pending = []   # 尚未拉取过的条目 url（选中之后直接 break，未及拉取）
        for it in entries:
            try:
                u = self._resolve_repo_url(manifest_base or primary_src, (it or {}).get('url', ''))
            except ConfigSecurityError as exc:
                logger.info('multi-repo merge: entry blocked (%s)', exc.reason)
                continue
            if u and u != primary_src and u not in sub_cfgs:
                pending.append(u)

        def fetch(url):
            try:
                return url, json.loads(self._fetch_config_document(
                    url, self._context(url), depot=True)[0])
            except Exception as e:
                logger.warning('multi-repo merge: fetch %s failed: %s', url, str(e)[:60])
                return url, None

        if pending:
            with ThreadPoolExecutor(max_workers=min(4, len(pending))) as pool:
                for url, cfg in pool.map(fetch, pending):
                    if cfg is not None:
                        sub_cfgs[url] = cfg
        self._merge_lives(prepared, sub_cfgs)
        self._merge_sites(prepared, sub_cfgs)
        prepared['summary']['lives'] = len(prepared['lives'])
        prepared['summary']['sites'] = len(prepared['sites'])
        prepared['summary']['built'] = sum(int(s.health.built) for s in prepared['sites'])
        prepared['summary']['initialized'] = sum(int(s.health.initialized) for s in prepared['sites'])
        prepared['summary']['healthy'] = sum(int(s.health.healthy) for s in prepared['sites'])
        prepared['summary']['sites_built'] = prepared['summary']['built']
        prepared['summary']['configured'] = len(prepared.get('diagnostics') or [])

    @staticmethod
    def _iter_live_urls(l):
        """展平一条 live 的所有实际 url（兼容字符串与嵌套 channels 形式）。"""
        if isinstance(l, str):
            yield l
            return
        if isinstance(l, list):
            for item in l:
                yield from ConfigManager._iter_live_urls(item)
            return
        if isinstance(l, dict) and isinstance(l.get('channels'), list):
            for c in l['channels']:
                yield from ConfigManager._iter_live_urls(c)
        elif isinstance(l, dict):
            values = l.get('urls') or l.get('url') or ''
            yield from ConfigManager._iter_live_urls(values)

    def _merge_lives(self, prepared, sub_cfgs):
        """跨仓合并 lives：按 url 去重，主条目优先保留。"""
        merged, seen = [], set()
        for cfg in [sub_cfgs.get(prepared['source_url'])] + [c for u, c in sub_cfgs.items()
                                                              if u != prepared['source_url']]:
            if not cfg:
                continue
            for l in (cfg.get('lives') or []):
                urls = [u for u in self._iter_live_urls(l) if u]
                key = '|'.join(sorted(urls)) if urls else json.dumps(l, sort_keys=True)[:200]
                if not urls or key in seen:
                    continue
                seen.add(key)
                merged.append(l)
        prepared['lives'] = merged

    def _merge_sites(self, prepared, sub_cfgs):
        """跨仓合并 sites：按 key 去重（主条目优先），其余条目的站点追加构建。"""
        existing = {s.key for s in prepared['sites']}
        added = 0
        # 合并是「只增不删」的增强：主条目已经建好，附加仓的站点要受加载预算
        # 约束——死镜像 jar/ext 单项就要挂 60-90s，几百个附加站点串行构建曾把
        # 整次导入拖到数分钟（任务一直 loading，期间所有新导入都被 BUSY 拒绝）。
        # 预算耗尽时保留已合并部分并停止（不失败整个导入）；取消仍要上抛。
        # 构建放线程池、按剩余预算收结果：串行逐个 _build_site 时，一个撞上
        # 死镜像的站点会以自身 HTTP 超时（60s+）卡住整个合并阶段——预算检查
        # 只在站点之间生效，进度条停在半格长时间不动。收结果带超时即可在
        # 预算点放弃等待（挂死线程随后自行消亡，不阻塞装配）。
        # 合并阶段按处理条数上报进度（build 满格后任务可能还要合并几十秒）。
        ctx = self._context()
        merge_sources = [(url, cfg) for url, cfg in sub_cfgs.items()
                         if url != prepared['source_url']]
        # 预先按 key 去重（主条目优先；跨附加仓先出现者优先，与串行版语义一致）
        targets = []   # (key, item, url, sub_spider_jar)
        for url, cfg in merge_sources:
            # 每个子仓的 csp_ 站点用该仓自己的顶层 spider jar 加载
            sub_spider_jar = self._resolve_spider_jar(cfg, url if str(url).startswith('http') else '')
            for item in cfg.get('sites') or []:
                key = item.get('key') or ''
                if not key or key in existing:
                    continue
                existing.add(key)
                targets.append((key, item, url, sub_spider_jar))
        merge_total = len(targets)
        merge_done = 0

        def _record_merge_result(key, item, site, exc):
            nonlocal added
            if exc is not None:
                if isinstance(exc, RuntimeContractError) and exc.code == 'L1_CONFIG_CANCELLED':
                    raise exc
                logger.warning('multi-repo merge site [%s] failed: %s', key, str(exc)[:60])
                health = infer_site_health(item)
                error = exc if isinstance(exc, RuntimeContractError) else error_from_exception(
                    exc, stage='site', site_key=health.site_key, runtime=health.runtime)
                if error.code == 'L2_SITE_REQUIRES_ANDROID':
                    health.runtime = 'android'
                    health.compatibility = 'C2'
                if error.details.get('built'):
                    health.mark_built()
                health.record_failure(error, stage='site')
                prepared.setdefault('diagnostics', []).append(health)
                prepared.setdefault('summary', {}).setdefault('skipped', []).append(
                    f"{key}: {redact_sensitive(str(exc), 240)} [{error.code}] {error.message}")
                prepared.setdefault('summary', {}).setdefault('build_errors', {}).setdefault(
                    'other', 0)
                prepared['summary']['build_errors']['other'] += 1
                return
            if site:
                prepared['sites'].append(site)
                prepared.setdefault('diagnostics', []).append(site.health)
                added += 1
                return
            health = infer_site_health(item)
            error = RuntimeContractError(
                'L2_SITE_BUILD_FAILED', site_key=health.site_key,
                runtime=health.runtime,
                raw_error='site entry could not be built')
            health.record_failure(error, stage='site')
            prepared.setdefault('diagnostics', []).append(health)
            prepared.setdefault('summary', {}).setdefault('skipped', []).append(
                f"{key}: [L2:site] site entry could not be built "
                f"[{error.code}] {error.message}")
            prepared.setdefault('summary', {}).setdefault('build_errors', {}).setdefault(
                'other', 0)
            prepared['summary']['build_errors']['other'] += 1

        if not targets:
            return
        pool = ThreadPoolExecutor(max_workers=4)
        try:
            futures = [pool.submit(self._build_site, item, url, jar)
                       for _, item, url, jar in targets]
            for (key, item, _url, _jar), fut in zip(targets, futures):
                remaining = ctx.remaining()
                try:
                    if remaining is not None and remaining <= 0:
                        raise FuturesTimeoutError()
                    site = fut.result(timeout=remaining)
                except Exception as e:
                    if isinstance(e, FuturesTimeoutError) or not fut.done():
                        logger.warning(
                            'multi-repo merge stopped at [%s]: load budget exhausted '
                            '(%d sites merged)', key, added)
                        return
                    _record_merge_result(key, item, None, e)
                else:
                    _record_merge_result(key, item, site, None)
                merge_done += 1
                self._report_progress('merge', merge_done, merge_total)
        finally:
            # 放弃等待而非 join：挂死的合并线程随其自身 HTTP 超时消亡。
            pool.shutdown(wait=False, cancel_futures=True)
        if added:
            logger.info('multi-repo merge: +%d sites from other entries', added)

    # ------------------------------------------------------------ 明细

    def _fetch_config_document(self, url_or_json, ctx, *, depot=False):
        """取回配置正文并产出 :class:`ConfigFetchResult`（C2.1 的下载层）。

        三种来源，全部经过 C2.5 边界：
        - http(s)：`fetch_text_diagnostics` → 受限取回（限长/限跳转/限解压/私网守卫）；
        - 内联 JSON：直接使用；
        - 本地文件：`guard_local_config_path`（只有顶层用户选择的路径能走到这里，
          子仓/站点资源里的本地路径在 `guard_url` 就被拒了）。
        """
        source = str(url_or_json).strip()
        started = time.monotonic()
        ctx.check()
        if source.lower().startswith(('http://', 'https://')):
            cached_text = self._restoring_documents.get(source)
            if cached_text is not None:
                return cached_text, make_fetch_result(
                    source, transport='depot' if depot else 'disk-cache',
                    raw=str(cached_text).encode('utf-8', errors='replace'),
                    final_url=source, started=started, from_cache=True)
            remaining = ctx.remaining()
            budget = 30.0 if remaining is None else max(3.0, min(30.0, remaining))
            diag = fetch_text_diagnostics(source, timeout=budget, policy=ctx.policy,
                                          trust=ctx.trust, kind='config',
                                          raise_blocked=True)
            status = int(diag.get('status') or 0)
            # 非 2xx 的响应体不是配置。TVBox 生态里 404/403 常带一段 HTML 或 JSON
            # 错误页，把它当正文解析会把「地址错了」报成 `[L1:parse] 不是有效的
            # JSON`；多仓回退时更会把「这一条挂了」记成「这一条没有 sites」，
            # 用户看到的失败原因和真实原因完全不同。
            if status and not 200 <= status < 300:
                raise ValueError('[L1:fetch] 配置地址返回 HTTP %d%s' % (
                    status, ('：' + redact_sensitive(diag.get('error'), 160))
                    if diag.get('error') else ''))
            text = diag.get('text') or ''
            if not text.strip():
                raise ValueError('[L1:fetch] 配置地址不可达或返回空内容%s' % (
                    '：' + redact_sensitive(diag.get('error'), 160) if diag.get('error') else ''))
            fetch = ConfigFetchResult(
                source_url=source,
                final_url=str(diag.get('finalUrl') or source),
                transport='depot' if depot else 'http',
                status=int(diag.get('status') or 0),
                etag=str(diag.get('etag') or ''),
                last_modified=str(diag.get('lastModified') or ''),
                content_hash=str(diag.get('contentHash') or content_hash(text)),
                size=int(diag.get('size') or 0),
                redirects=list(diag.get('redirects') or []),
                disguise=str(diag.get('disguise') or ''),
                encoding=str(diag.get('encoding') or ''),
                elapsed_ms=int(diag.get('elapsedMs') or (time.monotonic() - started) * 1000),
                fetched_at=time.time(),
            )
            return text, fetch
        if source.startswith('{') or source.startswith('['):
            return source, make_fetch_result('(inline)', transport='inline',
                                             raw=source.encode('utf-8', errors='replace'),
                                             started=started)
        if depot:
            # 子仓地址来自远端内容，只允许 http(s)：本地路径与伪协议已被
            # `_resolve_repo_url` 的 guard_url 拒绝，走到这里说明是空/畸形值。
            raise ValueError('[L1:fetch] multi-repo entry is not an http(s) config url')
        real = guard_local_config_path(source, policy=ctx.policy, trust=ctx.trust)
        # L-23：Windows 记事本保存的本地配置常为 GBK——按字节读，
        # utf-8 失败回退 gb18030，仍失败容错替换
        with open(real, 'rb') as handle:
            raw = handle.read()
        from runtime.ext_resolver import detect_text
        text, encoding = detect_text(raw)
        if not text.strip():
            raise ValueError('[L1:fetch] 本地配置文件为空')
        fetch = make_fetch_result(real, transport='file', raw=raw, final_url=real,
                                  encoding=encoding, started=started)
        return text, fetch

    def _fetch_config(self, url_or_json):
        """兼容入口：只要正文（多仓合并等旁路使用）。"""
        return self._fetch_config_document(url_or_json, self._context(url_or_json))[0]

    def _guard_site_url(self, url, *, kind, site_key='', runtime='', base_url=''):
        """站点级资源地址（api / jar / ext）过 C2.5 边界，拒绝时给 L2 结构化错误。"""
        ctx = self._context(base_url)
        try:
            return guard_url(url, policy=ctx.policy, trust=ctx.trust, kind=kind,
                             base_url=base_url if str(base_url).startswith('http') else '',
                             site_key=site_key)
        except ConfigSecurityError as exc:
            raise RuntimeContractError(
                exc.code, message=str(exc), site_key=site_key, runtime=runtime,
                raw_error='%s %s: %s' % (kind, exc.reason, redact_sensitive(exc.url, 200)),
                details={'reason': exc.reason, 'scope': exc.scope, 'kind': kind}) from exc

    def _build_site(self, item, base_url='', spider_jar=''):
        """按 config 条目构建 Site（不注册）；不支持时抛结构化错误。

        C2.3：字段矩阵由 `normalize_site_entry` 产出（未知字段整条保留在 `raw`）。
        C2.4：运行时判定全部来自 `route_site` / `refine_with_jar`——本函数不再自己
        用 if/elif 猜运行时，也不做任何降级尝试；不支持就是不支持。
        C2.5：api/jar/ext 只要是 http(s) 地址都先过 `guard_url`。
        C2.2：ext 按运行时契约选值——type=4/JS 用展开后的文本，其余用原始字符串。

        spider_jar：config 顶层共享 jar 的 http 地址（TVBox 标准），供
        api 为类名（csp_XXX）的站点加载类；站点条目自带 `jar` 时优先站点 jar。
        """
        ctx = self._context(base_url)
        ctx.check()
        data = item if isinstance(item, dict) else {}
        key = str(data.get('key') or '')
        name = str(data.get('name') or key)
        raw_type = data.get('type')
        if raw_type is not None:
            # `null` 按 Gson 语义等于 0（见 capability_router.route_site），只有真正
            # 写错类型（"abc"、{}）才算非法；否则这里会和路由结论互相矛盾。
            try:
                int(raw_type)
            except (TypeError, ValueError) as e:
                raise ValueError(f"[L2:type] invalid type for {key or '?'}") from e
        raw_api = str(data.get('api') or '')
        if not key or not raw_api:
            raise ValueError('[L2:site] site entry requires key and api')
        if (raw_api.startswith('./') or raw_api.startswith('../')) and not base_url:
            raise ValueError('[L1:resolve] relative api without config URL')

        entry = normalize_site_entry(data, base_url=base_url, shared_spider=spider_jar)
        api = entry.api
        if api.lower().startswith(('http://', 'https://')):
            api = self._guard_site_url(api, kind='api', site_key=key, base_url=base_url)

        decision = route_site(data, api=api, ext=entry.ext, site_key=key)
        entry.route = decision
        health = infer_site_health(data, capabilities=capabilities_for(data, decision))
        health.runtime = decision.runtime
        health.compatibility = decision.compatibility
        health.route = decision
        if decision.error_code:
            # drpy / 未知 type / 缺 api：保留 `[L2:type]` 文本标签供既有分层聚合识别，
            # 同时带上稳定错误码与判定依据（rule + reason），不猜测按 CMS 或 JS 处理。
            raise RuntimeContractError(
                decision.error_code, site_key=key, runtime=decision.runtime,
                message='[L2:type] %s' % decision.reason,
                raw_error='%s: %s' % (decision.rule, decision.reason),
                details={'rule': decision.rule, 'route': decision.to_dict()})

        # FongMi SiteApi.java:73：只有 type=4（JS）在 homeContent 前 fetchExt()；
        # type=3 的 spider 拿到的是**原始** ext 字符串，自己决定要不要去取。
        try:
            resolved = ctx.ext.resolve(entry.ext, base_url, site_key=key,
                                       expand=(decision.runtime == 'js'),
                                       deadline=ctx.deadline)
        except ExtCancelled as exc:
            # 取消要一路上抛成 L1（整次加载结束），不能退化成「这个站点 ext 取失败」。
            raise RuntimeContractError(
                'L1_CONFIG_CANCELLED', site_key=key, runtime=decision.runtime,
                raw_error=str(exc)) from exc
        ext = resolved.for_runtime(decision.runtime)
        entry.ext_origin = resolved.origin
        entry.ext_expanded = bool(resolved.expanded_ok)
        ctx.check()

        effective_jar = ''
        if decision.needs_jar and entry.jar:
            effective_jar = self._guard_site_url(
                entry.jar, kind='jar', site_key=key, runtime=decision.runtime,
                base_url=base_url)
            if entry.jar_md5:
                effective_jar = '%s;%s' % (effective_jar, entry.jar_md5)

        if decision.needs_jar:
            # jar 内 Java 爬虫类（TVBox csp_*.jar）或 .jar 直链：类加载与调用只发生在
            # JVM Worker 子进程（见 runtime/supervisor.py），宿主进程不加载第三方类。
            runner = self._load_jar_runner(
                key, name, api, effective_jar, ext=ext, base_url=base_url)
            if runner is None:
                logger.info('skip site %s: jar runtime unavailable or no shared spider jar', key)
                raise ValueError('[L3:jar] jar runtime unavailable or no shared jar')
            report = getattr(runner, 'jar_report', None)
            if report:
                # R4 → R5 细化：拿到字节分级后决定 portable JVM 或 dex2jar/JVM 回退。
                decision = refine_with_jar(decision, report)
                entry.route = decision
                health.runtime = decision.runtime
                health.compatibility = decision.compatibility
                health.route = decision
                if decision.error_code:
                    try:
                        runner.destroy()
                    except Exception:
                        pass
                    raise RuntimeContractError(
                        decision.error_code, site_key=key, runtime=decision.runtime,
                        raw_error='%s: %s' % (decision.rule, decision.reason),
                        details={'rule': decision.rule, 'route': decision.to_dict(),
                                 'jarLevel': decision.jar_level,
                                 'signals': list(decision.jar_signals)})
            site = self._assemble(key, api, ext, data, entry, health, runner, 'jar', resolved)
            self._initialize_site(site, ext)
            logger.info('site built: %s (%s, type=jar/%s)', key, name, decision.rule)
            return site

        if decision.runtime == 'js':
            runner = SupervisedRunner({
                'kind': 'js', 'site_key': key, 'name': name, 'api': api,
                'proxy_port': hoststate.get_port(), 'ext': ext,
            })
            spider_type = 'js'
        elif decision.runtime == 'python':
            path = self._materialize_python_spider(key, api, base_url=base_url)
            runner = SupervisedRunner({
                'kind': 'python', 'site_key': key, 'name': name, 'path': path, 'ext': ext,
            })
            spider_type = 'py'
        elif decision.runtime == 'cms':
            # CMS 站源（苹果 CMS JSON/XML 接口）：纯 HTTP 直连，无运行时依赖
            runner = SupervisedRunner({
                'kind': 'cms', 'site_key': key, 'name': name,
                'api': api, 'stype': entry.type, 'ext': ext,
            })
            spider_type = 'cms'
        else:
            # 路由已声明 supported 却没有装配分支 = 宿主自身的漏洞，如实报错而不是
            # 静默降级到某个「大概能跑」的运行时。
            raise RuntimeContractError(
                'L2_SITE_UNSUPPORTED', site_key=key, runtime=decision.runtime,
                message='[L2:type] 路由到 %s 但宿主没有对应装配分支' % decision.runtime,
                raw_error='no assembler for runtime %s (%s)' % (decision.runtime, decision.rule),
                details={'rule': decision.rule, 'route': decision.to_dict()})

        site = self._assemble(key, api, ext, data, entry, health, runner, spider_type, resolved)
        self._initialize_site(site, ext)
        logger.info('site built: %s (%s, type=%s)', key, name, entry.type)
        return site

    @staticmethod
    def _assemble(key, api, ext, item, entry, health, runner, spider_type, resolved=None):
        """把字段矩阵装到 Site 上。

        代理地址必须携带站点上下文；否则多个 JS/Python/CMS 源同时播放时，旧的
        recent loader 选择会把请求送到另一站点，因此 `spider_type` 由调用方按
        路由结论显式给出，不在这里再猜一次。
        """
        site = Site(key, api, ext)
        site.display_name = str(item.get('name') or key)
        site.health = health
        site.headers = dict(entry.header)
        site.spider_type = spider_type
        site.runner = runner
        # C2.3 字段矩阵（此前只有 searchable/quickSearch/filterable 被读进 Site）
        site.searchable = entry.searchable
        site.quick_search = entry.quick_search
        site.filterable = entry.filterable
        site.changeable = entry.changeable
        site.danmaku = entry.danmaku
        site.hide = entry.hide
        site.index = entry.index
        site.timeout_ms = entry.timeout_ms
        site.categories = list(entry.categories)
        site.play_url = entry.play_url
        site.click = entry.click
        site.style = entry.style
        site.entry = entry
        site.ext_detail = resolved
        return site

    @staticmethod
    def _initialize_site(site, ext=''):
        """完成建站与就绪标记。
        
        为避免导入/切换源时瞬间为几十上百个站点同时拉起独立的 Worker 进程
        （导致内存与 CPU 暴涨），此处采用惰性初始化（Lazy Init）：
        - 记录 ext 与 built 状态，不在此处拉起子进程；
        - 子进程在用户首次调用站点（如点开详情、首页、搜索）时按需拉起并执行 init。
        """
        site.health.mark_built().mark_initialized().mark_healthy()

    def _resolve_ext(self, ext, base_url):
        """兼容入口：把 ext 归一成字符串并解析相对路径，**不**发起网络请求。

        真正的语义在 :mod:`runtime.ext_resolver`（C2.2：FongMi `ExtAdapter` 的任意
        JSON → String，加 `Site.fetchExt` 的 http 展开）。这里只保留旧调用点用的
        「解相对路径」这一步，`expand=False` 因此不会有 IO——展开时机由
        `_build_site` 按运行时决定，不能藏在这个到处被调用的工具函数里。
        """
        return self._context(base_url).ext.resolve(
            ext, base_url, expand=False).canonical

    def _load_python_spider(self, key, api):
        try:
            if api.startswith('http'):
                return spider_app.spider(hoststate.get_plugins_dir(), api)
            # 内联源码：直接落盘后加载（原 app.spider 对非 http 会按文件名处理，
            # 内联源码无文件名，这里显式以 key 命名）
            # H-4：key 来自远端配置，白名单化防路径穿越（../、..\、C:\ 等；
            # Windows 上 os.path.join 遇绝对路径第二参数会直接采用后者）
            import re as _re
            safe_key = _re.sub(r'[^\w.-]', '_', str(key))[:64] or 'site'
            path = os.path.join(hoststate.get_plugins_dir(), f'{safe_key}.py')
            if not os.path.realpath(path).startswith(
                    os.path.realpath(hoststate.get_plugins_dir()) + os.sep):
                raise ValueError(f'bad site key: {key}')
            with open(path, 'wb') as f:
                f.write(api.encode('utf-8'))
            from importlib.machinery import SourceFileLoader
            return SourceFileLoader(safe_key, path).load_module().Spider()
        except Exception as e:
            raise ValueError(f'[L3:py] python spider load failed: {e}') from e

    def _materialize_python_spider(self, key, api, base_url=''):
        """只下载/落盘远程 Python 到隔离目录，不在宿主进程 import 或执行。"""
        try:
            safe_key = re.sub(r'[^\w.-]', '_', str(key))[:48] or 'site'
            if api.startswith('http'):
                basename = os.path.basename(urlparse(str(api)).path) or 'spider.py'
                basename = re.sub(r'[^\w.-]', '_', basename)[:48] or 'spider.py'
            else:
                basename = 'inline.py'

            # 先下载获取内容，计算真实内容哈希
            if api.startswith('http'):
                import http_client
                rsp = http_client.fetch_follow_redirects(api, timeout=15)
                content = rsp.content
            else:
                content = api.encode('utf-8')

            content_digest = hashlib.sha256(content).hexdigest()[:16]
            site_dir = os.path.realpath(os.path.join(hoststate.get_plugins_dir(), safe_key, content_digest))
            root = os.path.realpath(hoststate.get_plugins_dir()) + os.sep
            if not (site_dir + os.sep).startswith(root):
                raise ValueError(f'bad site key or directory traversal: {key}')

            os.makedirs(site_dir, exist_ok=True)
            path = os.path.join(site_dir, basename)
            with open(path, 'wb') as f:
                f.write(content)

            self._context(base_url).record_artifact('python', api, path)
            return path
        except Exception as e:
            raise ValueError(f'[L3:py] python spider materialize failed: {e}') from e

    def _load_cms_spider(self, key, name, api, stype):
        from cms_spider import CmsSpider
        if not api.startswith('http'):
            raise ValueError('[L3:cms] cms site needs http api')
        return CmsSpider(key, api, stype, name)

    def _load_js_spider(self, key, name, api):
        try:
            from quickjs_host import JsEngine   # js-engine 目录（server.py 已加入 sys.path）
            engine = JsEngine(site_key=key)   # site_key：local KV 按站点隔离（M-24/C2）
            engine.proxy_port = hoststate.get_port()   # js2Proxy 生成后端代理 URL 用
            try:
                if api.startswith('http'):
                    # 多模块 ESM：递归抓取 import 依赖后展平执行（单文件也兼容）
                    ok = engine.load_spider_url(api, fetch_text)
                else:
                    ok = engine.load_spider(api)
            except Exception as e:
                raise ValueError(f'[L3:js] spider load/execute failed: {e}')
            if not ok:
                raise ValueError('[L3:js] spider produced no __JS_SPIDER__ (need __jsEvalReturn/default export)')
            return make_js_spider_class(key, engine, name)
        except Exception as e:
            # 任务五：确保所有 JS 相关错误都带有 [L3:js] 标签
            err_msg = str(e)
            if not err_msg.startswith('[L3:js]'):
                raise ValueError(f'[L3:js] {err_msg}') from e
            raise

    def _load_jar_spider(self, key, name, api, spider_jar=''):
        """装配 jar spider：jar 落盘（带 md5 校验）→ JarBridge → JarSpider 适配。

        api 有两种形态：
        - 'https://x/csp_MaoYan.jar[;md5]'：站点自带 jar 直链，class 从文件名推断。
        - 'csp_MaoYan'：纯类名，jar 来自 config 顶层共享 spider（spider_jar）。
        无 java 运行时或无法定位 jar 时返回 None（调用方跳过该站点）；其余异常向上抛。
        """
        import java_probe
        from jar_bridge import JarBridge
        from jar_spider import make_jar_spider_class
        try:
            jar_url, md5, class_name = JarBridge.norm_jar_src(api)
            if not jar_url:
                # api 是纯类名（csp_XXX）：用 config 顶层共享 jar 下载，class 取 api。
                if api.startswith('csp_') and spider_jar:
                    jar_url, md5, _ = JarBridge.norm_jar_src(spider_jar)
                    class_name = api
                if not jar_url:
                    logger.info('skip site %s: csp_ class but no shared spider jar', key)
                    return None
            jar_path = JarBridge.download_jar(
                jar_url, md5, site_key=key,
                portable_only=False)
            # Download and convert before checking Java so DEX sources can enter
            # the same JVM Worker path as standard JARs.
            if not java_probe.find_java():
                raise ValueError('[L3:jar] jar runtime unavailable (java not found)')
            # 映射类名：DEX→JVM 转换后的 jar 中类在 com.github.catvod.spider.<name>
            class_name = JarBridge.map_class_name(jar_path, class_name)
            # 按 jar 文件共享 JVM 子进程：同一 jar 的所有 csp_XXX 站点共用一个桥
            bridge = JarBridge.get_or_create(jar_path, runner_jar=DEFAULT_RUNNER_JAR)
            return make_jar_spider_class(key, bridge, name, class_name)
        except RuntimeContractError:
            raise
        except Exception as e:
            # 旧的直接构造入口只保留给低层兼容测试；生产配置走
            # _load_jar_runner，不在宿主进程加载第三方类。
            err_msg = str(e)
            if not err_msg.startswith('[L3:jar]'):
                raise ValueError(f'[L3:jar] {err_msg}') from e
            raise

    def _load_jar_runner(self, key, name, api, spider_jar='', ext='', base_url=''):
        """下载并分级 JAR；实际类加载与调用只发生在 Supervisor Worker/JVM。

        返回的 runner 上附 `jar_report`（`classify_jar_compatibility` 的字节分级）
        与 `jar_path`，供 C2.4 的 :func:`refine_with_jar` 把 R4 细化成 R4/R5。
        分级在这里显式再算一次而不是复用 `download_jar` 内部结论：`download_jar`
        只在需要拒绝时抛错，成功路径不返回报告，路由拿不到 level/signals 就只能
        靠「没抛错」反推「可以跑」——那正是旧实现误判 Android JAR 的原因。
        """
        import java_probe
        from jar_bridge import JarBridge, classify_jar_compatibility
        try:
            jar_url, md5, class_name = JarBridge.norm_jar_src(api)
            if not jar_url:
                if api.startswith('csp_') and spider_jar:
                    jar_url, md5, _ = JarBridge.norm_jar_src(spider_jar)
                    class_name = api
                if not jar_url:
                    return None
            jar_path = JarBridge.download_jar(
                jar_url, md5, site_key=key,
                portable_only=False)
            if not java_probe.find_java():
                raise ValueError('[L3:jar] jar runtime unavailable (java not found)')
            class_name = JarBridge.map_class_name(jar_path, class_name)
            runner = SupervisedRunner({
                'kind': 'jar', 'site_key': key, 'name': name,
                'jar_path': jar_path, 'class_name': class_name,
                'runner_jar': DEFAULT_RUNNER_JAR, 'ext': ext,
            })
            runner.jar_path = jar_path
            try:
                runner.jar_report = classify_jar_compatibility(jar_path)
            except Exception as exc:            # 分级失败不能当成「可跑」
                runner.jar_report = {'level': 'L?', 'signals': ['classify-failed'],
                                     'hasDex': False, 'hasNative': False,
                                     'error': str(exc)}
            self._context(base_url).record_artifact('jar', jar_url, jar_path)
            return runner
        except RuntimeContractError:
            raise
        except Exception as e:
            text = str(e)
            if not text.startswith('[L3:jar]'):
                raise ValueError(f'[L3:jar] {text}') from e
            raise

    # ------------------------------------------------------------ 查询

    def state(self):
        healthy_sites = [s for s in self.sites.sites if s.health.healthy]
        diagnostics = [h.to_dict() for h in self.sites.diagnostics]
        snapshot = self.snapshot
        degraded_count = sum(1 for h in diagnostics if h.get('state') in ('degraded', 'credentials_required'))
        unsupported_count = sum(1 for h in diagnostics if h.get('state') == 'unsupported' or h.get('runtime') in ('android', 'unsupported'))
        healthy_count = sum(int(h.get('healthy', False)) for h in diagnostics)
        configured_count = len(diagnostics)
        payload = {
            'source': self.source_url,
            'repo': self.last_repo_name,
            'parses': self.parses,
            'flags': self.flags,
            'lives': self.lives,
            'wallpaper': self.wallpaper,
            'summary': {
                'configured': configured_count,
                'built': sum(int(h.get('built', False)) for h in diagnostics),
                'initialized': sum(int(h.get('initialized', False)) for h in diagnostics),
                'healthy': healthy_count,
            },
            'degradedCount': degraded_count,
            'unsupportedCount': unsupported_count,
            'sites': [{'key': s.key, 'name': s.name, 'searchable': s.searchable,
                       'spiderType': getattr(s, 'spider_type', ''),
                       # api 参与渲染层探测结论的内容指纹（probeFp）：多仓合并下不同仓
                       # 常用同名 key 指向不同站点，前端需凭 api/spider 判别结论是否仍适用
                       'api': getattr(s, 'api', ''),
                       **s.health.to_dict()}
                      for s in self.sites.sites],
            'diagnostics': diagnostics,
            # C2.1：当前运行快照。`swapCount`/`reuseCount` 区分「真的换了配置」与
            # 「同内容命中复用」，否则诊断页无法解释「点了导入但站点对象没变」。
            'swapCount': int(self.swap_count),
            'reuseCount': int(self.reuse_count),
            'snapshot': snapshot.to_dict() if snapshot is not None else None,
            'depot': snapshot.depot.to_dict() if snapshot is not None else None,
            'security': dict(snapshot.security) if snapshot is not None else {},
            'cached': bool(self.cache_restored),
            'cacheAge': int(self.cache_age) if self.cache_restored else None,
        }
        last_healthy = self.last_healthy_snapshot
        if last_healthy is not None and last_healthy is not snapshot:
            # 新配置被拒后仍在跑的旧健康配置：必须能在诊断页上被看到，
            # 否则「保留旧配置」这件事从外部无法证实。
            payload['lastHealthySnapshot'] = {
                'snapshotId': last_healthy.snapshot_id,
                'state': last_healthy.state,
                'swapSeq': int(last_healthy.swap_seq),
                'healthy': last_healthy.healthy_count,
                'source': redact_sensitive(last_healthy.source_label, 300),
            }
        return payload
