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
from urllib.parse import urljoin
from concurrent.futures import ThreadPoolExecutor

import app as spider_app
import hoststate
import java_probe
from runner import Runner
from site_manager import Site
from js_spider import make_js_spider_class

logger = logging.getLogger('vpc.config')

# 多仓扫描上限：防止条目过多导致加载时间不可控
MAX_MULTI_REPO_ENTRIES = 12

# 内置 JVM runner jar（与 python-backend 同层 vendor/，开发与打包路径均兼容）
DEFAULT_RUNNER_JAR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'vendor', 'spider-runner.jar')


def fetch_text(url, timeout=15):
    """http(s) 递归跟重定向取文本（委托 app.redirect，15s 超时）。失败返回 ''。

    兼容三类 TVBox 生态特殊接口：
    - 图片伪装接口（饭太硬系）：JPEG/PNG 尾部嵌入 base64 的配置 JSON，自动解出；
    - gzip 压缩：自动解压；
    - 常规 JSON/直播源：原样返回文本。
    """
    try:
        from app import redirect
        import gzip
        rsp = redirect(url)
        if rsp is None:
            return ''
        raw = rsp.content

        # gzip 解压：检测魔数 \x1f\x8b
        if raw[:2] == b'\x1f\x8b':
            try:
                raw = gzip.decompress(raw)
            except Exception as e:
                logger.warning('gzip decompress failed for %s: %s', url, str(e)[:80])
                # 解压失败时回退原始内容（可能误判）

        img_cfg = _image_tail_config(raw)
        if img_cfg is not None:
            return img_cfg
        return raw.decode('utf-8', errors='replace')
    except Exception as e:
        logger.warning('fetch_text %s failed: %s', url, str(e)[:80])
        return ''


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
                '这是直播源（txt/m3u），不是配置。请到「设置 → 源设置 → 直播源」'
                '添加该地址，而不是从这里载入配置。'
            ) from e
        snippet = (text or '').strip()[:80].replace('\n', ' ')
        raise ValueError(
            '配置不是有效的 JSON（无法解析）。请确认地址返回的是 CatVod 配置文件。'
            '内容开头：%r' % snippet
        ) from e


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

    # ------------------------------------------------------------ 入口

    def _resolve_repo_url(self, base, sub):
        """多仓子仓相对路径（./x.json）以多仓配置源 URL 为基址解析为绝对地址。"""
        if str(sub).startswith('./') or str(sub).startswith('../'):
            if str(base).startswith('http'):
                return urljoin(base, sub)
        return sub

    def load(self, url_or_json, _depth=0, _text=None):
        """解析并整体热替换站点；返回加载摘要 dict。

        失败不破坏现有站点：新内容全部构建成功后才一次性热替换。
        """
        text = _text if _text is not None else self._fetch_config(url_or_json)
        cfg = parse_config_json(text)
        # 多仓格式（顶层 urls 列表）：预检后按序尝试直到第一条成功（限一层递归防循环）
        if not isinstance(cfg.get('sites'), list) and isinstance(cfg.get('urls'), list) and cfg['urls']:
            if _depth >= 1:
                raise ValueError('multi-repo nesting too deep')
            errors = []
            entries = cfg['urls'][:MAX_MULTI_REPO_ENTRIES]
            if len(cfg['urls']) > MAX_MULTI_REPO_ENTRIES:
                logger.info('multi-repo: only first %s of %s entries tried',
                            MAX_MULTI_REPO_ENTRIES, len(cfg['urls']))
            # T40：优先重试上次成功的条目（置顶），保持 lives 等数据稳定
            pref = self._repo_pref()
            if pref:
                entries = sorted(entries,
                                 key=lambda it: 0 if (it or {}).get('name') == pref else 1)
            sub_cfgs = {}   # 成功解析的子仓配置（含主条目），供 T44 跨仓合并
            chosen = None
            for item in entries:
                sub = self._resolve_repo_url(url_or_json, (item or {}).get('url', ''))
                if not sub:
                    continue
                name = item.get('name')
                try:
                    logger.info('multi-repo: trying entry %s', name)
                    sub_text = self._fetch_config(sub)
                    sub_cfg = parse_config_json(sub_text)
                    if not isinstance(sub_cfg.get('sites'), list) or not sub_cfg['sites']:
                        raise ValueError('entry has no sites')
                    sub_cfgs[sub] = sub_cfg
                    prepared = self._prepare(sub_cfg, sub)
                    if prepared['summary']['sites'] > 0:
                        chosen = (item, prepared)
                        break
                    logger.warning('multi-repo entry [%s] built 0 sites, try next', name)
                    errors.append('%s: 0 sites' % name)
                except Exception as e:
                    # T44：偏好条目偶发超时时再给一次机会，避免仓漂移
                    if name and name == self._repo_pref():
                        try:
                            logger.info('multi-repo: retry preferred entry %s once', name)
                            sub_text = self._fetch_config(sub)
                            sub_cfg = parse_config_json(sub_text)
                            if isinstance(sub_cfg.get('sites'), list) and sub_cfg['sites']:
                                sub_cfgs[sub] = sub_cfg
                                prepared = self._prepare(sub_cfg, sub)
                                if prepared['summary']['sites'] > 0:
                                    chosen = (item, prepared)
                                    break
                        except Exception as e2:
                            logger.warning('multi-repo retry failed [%s]: %s', name, e2)
                    logger.warning('multi-repo entry failed [%s]: %s', name, e)
                    errors.append('%s: %s' % (name, str(e)[:60]))
            if not chosen:
                raise ValueError('all multi-repo entries failed; first error: %s' % (errors[0] if errors else 'empty'))
            item, prepared = chosen
            self._merge_repo_extras(prepared, sub_cfgs, entries)
            self._apply(prepared)
            self._save_repo_pref(item.get('name'))
            return prepared['summary']
        if not isinstance(cfg.get('sites'), list):
            raise ValueError('invalid config: missing sites')
        prepared = self._prepare(cfg, url_or_json)
        self._apply(prepared)
        return prepared['summary']

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

    def _prepare(self, cfg, source):
        """纯构建：解析 config 并构建新站点列表，不触碰现有全局状态。"""
        summary = {'sites': 0, 'skipped': [], 'parses': 0, 'flags': 0, 'lives': 0, 'panSites': 0}
        base_url = source if str(source).startswith('http') else ''
        # TVBox 标准：顶层 spider 是所有 csp_ 站点共享的 jar；解析出 http 地址后
        # 供 type=3 且 api 为类名（csp_XXX）的站点加载（见 _build_site）。
        spider_jar = self._resolve_spider_jar(cfg, base_url)
        if cfg.get('spider'):
            logger.info('config.spider=%s → shared jar: %s', cfg['spider'], spider_jar or '(not a jar / unresolved)')
        new_sites = []
        items = cfg.get('sites') or []
        # 站点构建并发化（jar 下载/子蜘蛛抓取耗时为主，串行会让导入明显卡顿）
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(self._build_site, item, base_url, spider_jar) for item in items]
            for item, fut in zip(items, futures):
                try:
                    site = fut.result()
                    if site:
                        new_sites.append(site)
                        summary['sites'] += 1
                        # 统计网盘源：api 包含 quark/uc/baidu/tianyi 等关键词
                        api_lower = str(item.get('api', '')).lower()
                        if any(kw in api_lower for kw in ['quark', 'uc', 'baidu', 'tianyi', '123pan', 'xunlei']):
                            summary['panSites'] += 1
                    else:
                        summary['skipped'].append(item.get('key', '?'))
                except Exception as e:
                    logger.exception('load site %s failed: %s', item.get('key'), e)
                    summary['skipped'].append(f"{item.get('key', '?')}: {e}")
        parses = cfg.get('parses') or []
        flags = cfg.get('flags') or []
        lives = cfg.get('lives') or []
        summary['parses'] = len(parses)
        summary['flags'] = len(flags)
        summary['lives'] = len(lives)
        return {
            'sites': new_sites,
            'parses': parses,
            'flags': flags,
            'lives': lives,
            'wallpaper': cfg.get('wallpaper') or '',
            'source_url': source if str(source).startswith('http') else '(inline)',
            'summary': summary,
        }

    def _apply(self, prepared):
        """热替换：销毁旧站点并安装新内容（全部就绪后才调用）。"""
        self.sites.destroy_all()
        self.sites.sites.extend(prepared['sites'])
        self.parses = prepared['parses']
        self.flags = prepared['flags']
        self.lives = prepared['lives']
        self.wallpaper = prepared['wallpaper']
        self.source_url = prepared['source_url']

    # ------------------------------------------------ 多仓合并（T44）

    def _merge_repo_extras(self, prepared, sub_cfgs, entries):
        """T44：主条目出影片源，其余条目的 lives/sites 并行补拉后合并去重。

        避免单一仓命中时直播源缺失/视频源变少（仓漂移）。
        只增不删：主条目内容原样保留，合并失败静默跳过。
        """
        primary_src = prepared['source_url']
        pending = []   # 尚未拉取过的条目 url（选中之后直接 break，未及拉取）
        for it in entries:
            u = self._resolve_repo_url(primary_src, (it or {}).get('url', ''))
            if u and u != primary_src and u not in sub_cfgs:
                pending.append(u)

        def fetch(url):
            try:
                return url, json.loads(self._fetch_config(url))
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

    @staticmethod
    def _iter_live_urls(l):
        """展平一条 live 的所有实际 url（兼容嵌套 channels 形式）。"""
        if isinstance(l, dict) and isinstance(l.get('channels'), list):
            for c in l['channels']:
                for u in ((c or {}).get('urls') or []):
                    yield str(u)
        else:
            yield str((l or {}).get('url') or '')

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
        for url, cfg in sub_cfgs.items():
            if url == prepared['source_url']:
                continue
            # 每个子仓的 csp_ 站点用该仓自己的顶层 spider jar 加载
            sub_spider_jar = self._resolve_spider_jar(cfg, url if str(url).startswith('http') else '')
            for item in cfg.get('sites') or []:
                key = item.get('key') or ''
                if not key or key in existing:
                    continue
                try:
                    site = self._build_site(item, url, sub_spider_jar)
                    if site:
                        prepared['sites'].append(site)
                        existing.add(key)
                        added += 1
                except Exception as e:
                    logger.warning('multi-repo merge site [%s] failed: %s', key, str(e)[:60])
        if added:
            logger.info('multi-repo merge: +%d sites from other entries', added)

    # ------------------------------------------------------------ 明细

    def _fetch_config(self, url_or_json):
        s = str(url_or_json).strip()
        if s.startswith('http'):
            return fetch_text(s)
        if s.startswith('{'):
            return s
        if os.path.exists(s):
            with open(s, encoding='utf-8') as f:
                return f.read()
        raise ValueError('unsupported config source')

    def _build_site(self, item, base_url='', spider_jar=''):
        """按 config 条目构建 Site（不注册）；不支持返回 None。

        spider_jar：config 顶层共享 jar 的 http 地址（TVBox 标准），供
        type=3 且 api 为类名（csp_XXX）的站点加载类。
        站点条目自带 `jar` 字段（站点级独立 jar，如 欧歌/菜妮丝 等接口）
        时优先使用站点 jar，回退顶层共享 jar。
        """
        key = item.get('key') or ''
        name = item.get('name') or key
        stype = int(item.get('type', 0))
        api = str(item.get('api') or '')
        ext = item.get('ext') or ''
        if not key or not api:
            return None

        # 相对路径 api（如 ./js/tiantian.js）：以 config 源 URL 为基址解析
        if api.startswith('./') or api.startswith('../'):
            if not base_url:
                logger.info('skip site %s: relative api without base url', key)
                return None
            api = urljoin(base_url, api)

        # 站点级独立 jar（TVBox 站点条目 `jar` 字段；可带 ;md5）。相对路径按配置源解析。
        site_jar = str(item.get('jar') or '').strip()
        if site_jar and not site_jar.startswith('http'):
            if base_url:
                site_jar = urljoin(base_url, site_jar)
            else:
                site_jar = ''
        effective_jar = site_jar or spider_jar

        if stype == 3 and api.startswith('csp_'):
            # jar 内 Java 爬虫类（TVBox csp_*.jar）：经 JVM 子进程桥加载（见 jar_bridge.py）
            # api 为纯类名（csp_XXX）时，jar 来自站点 `jar` 字段或 config 顶层共享 spider。
            spider = self._load_jar_spider(key, name, api, effective_jar)
            if spider is None:
                logger.info('skip site %s: jar runtime unavailable or no shared spider jar', key)
                return None
            site = Site(key, api, ext)
            site.spider_type = 'jar'
            site.runner = Runner(spider)
            site.searchable = bool(item.get('searchable', 1))
            site.quick_search = bool(item.get('quickSearch', 1))
            site.filterable = bool(item.get('filterable', 1))
            # 把 ext 配置存到蜘蛛实例上，自动 init 时使用正确的 ext（关键！）
            # 相对路径（./lib/x.json，如 Bili 系蜘蛛的 json 配置）相对配置源 URL 解析为绝对地址
            ext = self._resolve_ext(ext, base_url)
            if ext:
                ext_str = ext if isinstance(ext, str) else json.dumps(ext, ensure_ascii=False) if ext else ''
                if ext_str:
                    spider._ext = ext_str
            logger.info('site built: %s (%s, type=jar)', key, name)
            return site

        # jar 直链 api（.jar 后缀）或 jar 内类名（csp_ 开头）之外的形态：若 api 是 http .jar 直链
        # （如部分源直接以 jar URL 作为 api），同样走 jar 装配
        if stype == 3 and api.split('?')[0].lower().endswith('.jar'):
            spider = self._load_jar_spider(key, name, api)
            if spider is None:
                logger.info('skip site %s: jar runtime unavailable (java not found)', key)
                return None
            site = Site(key, api, ext)
            site.spider_type = 'jar'
            site.runner = Runner(spider)
            site.searchable = bool(item.get('searchable', 1))
            site.quick_search = bool(item.get('quickSearch', 1))
            site.filterable = bool(item.get('filterable', 1))
            ext = self._resolve_ext(ext, base_url)
            if ext:
                ext_str = ext if isinstance(ext, str) else json.dumps(ext, ensure_ascii=False) if ext else ''
                if ext_str:
                    spider._ext = ext_str
            logger.info('site built: %s (%s, type=jar-url)', key, name)
            return site

        if 'drpy' in api.lower():
            # drpy 框架源（依赖 drpy 服务端），PC 侧无 drpy 运行时，跳过
            logger.info('skip site %s: drpy source not supported on PC', key)
            return None

        # JS 爬虫：type=4，或 type=3 且 api 为 http .js 直链（CatVod/TVBox JS 协议）
        is_js = stype == 4 or (stype == 3 and api.startswith('http') and api.split('?')[0].endswith('.js'))
        if is_js:
            spider = self._load_js_spider(key, name, api)
        elif stype == 3:
            spider = self._load_python_spider(key, api)
        elif stype in (0, 1):
            # CMS 站源（苹果 CMS JSON/XML 接口）：纯 HTTP 直连，无运行时依赖
            spider = self._load_cms_spider(key, name, api, stype)
        else:
            logger.info('skip site %s: unsupported type %s', key, stype)
            return None

        site = Site(key, api, ext)
        site.runner = Runner(spider)
        site.searchable = bool(item.get('searchable', 1))
        site.quick_search = bool(item.get('quickSearch', 1))
        site.filterable = bool(item.get('filterable', 1))
        site.runner.init(ext)
        logger.info('site built: %s (%s, type=%s)', key, name, stype)
        return site

    def _resolve_ext(self, ext, base_url):
        """把 ext 配置中的相对路径（./lib/x.json）解析为相对配置源的绝对 URL。

        多个配置把蜘蛛配置（如 csp_Bili 的 json 文件）写成 ./lib/xxx.json，
        蜘蛛在 JVM 内直接 fetch ext 值，必须拿到完整 URL 才能工作。
        递归处理 dict/str；绝对 URL / 非路径字符串原样返回。
        """
        if isinstance(ext, dict):
            return {k: self._resolve_ext(v, base_url) for k, v in ext.items()}
        if isinstance(ext, str):
            e = ext.strip()
            if (e.startswith('./') or e.startswith('../')) and base_url:
                return urljoin(base_url, e)
            return e
        return ext

    def _load_python_spider(self, key, api):
        if api.startswith('http'):
            return spider_app.spider(hoststate.get_plugins_dir(), api)
        # 内联源码：直接落盘后加载（原 app.spider 对非 http 会按文件名处理，
        # 内联源码无文件名，这里显式以 key 命名）
        path = os.path.join(hoststate.get_plugins_dir(), f'{key}.py')
        with open(path, 'wb') as f:
            f.write(api.encode('utf-8'))
        from importlib.machinery import SourceFileLoader
        return SourceFileLoader(key, path).load_module().Spider()

    def _load_cms_spider(self, key, name, api, stype):
        from cms_spider import CmsSpider
        if not api.startswith('http'):
            raise ValueError('cms site needs http api')
        return CmsSpider(key, api, stype, name)

    def _load_js_spider(self, key, name, api):
        from quickjs_host import JsEngine   # js-engine 目录（server.py 已加入 sys.path）
        engine = JsEngine()
        engine.proxy_port = hoststate.get_port()   # js2Proxy 生成后端代理 URL 用
        try:
            if api.startswith('http'):
                # 多模块 ESM：递归抓取 import 依赖后展平执行（单文件也兼容）
                ok = engine.load_spider_url(api, fetch_text)
            else:
                ok = engine.load_spider(api)
        except Exception as e:
            raise ValueError(f'js spider load/execute failed: {e}')
        if not ok:
            raise ValueError('js spider produced no __JS_SPIDER__ (need __jsEvalReturn/default export)')
        return make_js_spider_class(key, engine, name)

    def _load_jar_spider(self, key, name, api, spider_jar=''):
        """装配 jar spider：jar 落盘（带 md5 校验）→ JarBridge → JarSpider 适配。

        api 有两种形态：
        - 'https://x/csp_MaoYan.jar[;md5]'：站点自带 jar 直链，class 从文件名推断。
        - 'csp_MaoYan'：纯类名，jar 来自 config 顶层共享 spider（spider_jar）。
        无 java 运行时或无法定位 jar 时返回 None（调用方跳过该站点）；其余异常向上抛。
        """
        import java_probe
        if not java_probe.find_java():
            return None
        from jar_bridge import JarBridge
        from jar_spider import make_jar_spider_class
        jar_url, md5, class_name = JarBridge.norm_jar_src(api)
        if not jar_url:
            # api 是纯类名（csp_XXX）：用 config 顶层共享 jar 下载，class 取 api。
            if api.startswith('csp_') and spider_jar:
                jar_url, md5, _ = JarBridge.norm_jar_src(spider_jar)
                class_name = api
            if not jar_url:
                logger.info('skip site %s: csp_ class but no shared spider jar', key)
                return None
        jar_path = JarBridge.download_jar(jar_url, md5, site_key=key)
        # 映射类名：DEX→JVM 转换后的 jar 中类在 com.github.catvod.spider.<name>
        class_name = JarBridge.map_class_name(jar_path, class_name)
        # 按 jar 文件共享 JVM 子进程：同一 jar 的所有 csp_XXX 站点共用一个桥
        bridge = JarBridge.get_or_create(jar_path, runner_jar=DEFAULT_RUNNER_JAR)
        return make_jar_spider_class(key, bridge, name, class_name)

    # ------------------------------------------------------------ 查询

    def state(self):
        return {
            'source': self.source_url,
            'repo': self.last_repo_name,
            'parses': self.parses,
            'flags': self.flags,
            'lives': self.lives,
            'wallpaper': self.wallpaper,
            'sites': [{'key': s.key, 'name': s.name, 'searchable': s.searchable,
                       'spiderType': getattr(s, 'spider_type', '')}
                      for s in self.sites.sites],
        }
