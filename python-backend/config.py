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

import app as spider_app
import hoststate
from runner import Runner
from site_manager import Site
from js_spider import make_js_spider_class

logger = logging.getLogger('vpc.config')

# 多仓扫描上限：防止条目过多导致加载时间不可控
MAX_MULTI_REPO_ENTRIES = 12


def fetch_text(url):
    """http(s) 递归跟重定向取文本（复用恢复版 app.redirect）。"""
    return spider_app.redirect(url).content.decode('utf-8', errors='replace')


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

    def load(self, url_or_json, _depth=0, _text=None):
        """解析并整体热替换站点；返回加载摘要 dict。

        失败不破坏现有站点：新内容全部构建成功后才一次性热替换。
        """
        text = _text if _text is not None else self._fetch_config(url_or_json)
        cfg = json.loads(text)
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
            for item in entries:
                sub = (item or {}).get('url', '')
                if not sub:
                    continue
                try:
                    logger.info('multi-repo: trying entry %s', item.get('name'))
                    sub_text = self._fetch_config(sub)
                    sub_cfg = json.loads(sub_text)
                    if not isinstance(sub_cfg.get('sites'), list) or not sub_cfg['sites']:
                        raise ValueError('entry has no sites')
                    prepared = self._prepare(sub_cfg, sub)
                    if prepared['summary']['sites'] > 0:
                        self._apply(prepared)
                        self._save_repo_pref(item.get('name'))
                        return prepared['summary']
                    logger.warning('multi-repo entry [%s] built 0 sites, try next', item.get('name'))
                    errors.append('%s: 0 sites' % item.get('name'))
                except Exception as e:
                    logger.warning('multi-repo entry failed [%s]: %s', item.get('name'), e)
                    errors.append('%s: %s' % (item.get('name'), str(e)[:60]))
            raise ValueError('all multi-repo entries failed; first error: %s' % (errors[0] if errors else 'empty'))
        if not isinstance(cfg.get('sites'), list):
            raise ValueError('invalid config: missing sites')
        prepared = self._prepare(cfg, url_or_json)
        self._apply(prepared)
        return prepared['summary']

    def _prepare(self, cfg, source):
        """纯构建：解析 config 并构建新站点列表，不触碰现有全局状态。"""
        summary = {'sites': 0, 'skipped': [], 'parses': 0, 'flags': 0, 'lives': 0}
        if cfg.get('spider'):
            logger.info('config.spider(jar) ignored on PC: %s', cfg['spider'])
        base_url = source if str(source).startswith('http') else ''
        new_sites = []
        for item in cfg.get('sites') or []:
            try:
                site = self._build_site(item, base_url)
                if site:
                    new_sites.append(site)
                    summary['sites'] += 1
                else:
                    summary['skipped'].append(item.get('key', '?'))
            except Exception as e:
                logger.exception('load site %s failed', item.get('key'))
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

    def _build_site(self, item, base_url=''):
        """按 config 条目构建 Site（不注册）；不支持返回 None。"""
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

        if stype == 3 and api.startswith('csp_'):
            # jar 内 Java 爬虫类（TVBox spider.jar），PC 侧无 jar 运行时，跳过
            logger.info('skip site %s: jar-based csp class not supported on PC', key)
            return None

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
        if api.startswith('http'):
            # 多模块 ESM：递归抓取 import 依赖后展平执行（单文件也兼容）
            if not engine.load_spider_url(api, fetch_text):
                raise ValueError('js spider produced no __JS_SPIDER__ (need __jsEvalReturn/default export)')
        else:
            if not engine.load_spider(api):
                raise ValueError('js spider produced no __JS_SPIDER__ (need __jsEvalReturn/default export)')
        return make_js_spider_class(key, engine, name)

    # ------------------------------------------------------------ 查询

    def state(self):
        return {
            'source': self.source_url,
            'repo': self.last_repo_name,
            'parses': self.parses,
            'flags': self.flags,
            'lives': self.lives,
            'wallpaper': self.wallpaper,
            'sites': [{'key': s.key, 'name': s.name, 'searchable': s.searchable}
                      for s in self.sites.sites],
        }
