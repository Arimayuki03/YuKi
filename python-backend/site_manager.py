# -*- coding: utf-8 -*-
"""站点（spider 插件）管理：加载、初始化、分发。

两种加载途径（对应原 app.spider 的两种 api 形态 + 本地插件目录）：
- load_api(key, api, ext): api 为 http 地址或内联源码，走恢复版 app.spider()
- load_local(key, path, ext): 直接加载本地 spiders/ 目录下的 .py 文件
"""
import os
import logging
import hashlib
import re
from urllib.parse import urlparse

import app as spider_app          # 恢复版插件入口（字节码校验一致）
import hoststate
from runner import Runner
from runtime.health import SiteHealth
from runtime.supervised_runner import SupervisedRunner

logger = logging.getLogger('yuki.sites')


class Site:
    def __init__(self, key, api, ext=''):
        self.key = key
        self.display_name = key
        self.api = api
        self.ext = ext
        self.runner = None
        # 运行时类型（jar/js/py/cms）。FongMi /proxy 在没有 siteKey 时
        # 需要按最近使用的同类 Spider 分发 do=js/do=py。
        self.spider_type = ''
        # 配置站点级请求头；playerContent 结果归一化时按
        # site → Spider → parser 的顺序合并，避免站点默认 UA/Referer 丢失。
        self.headers = {}
        self.searchable = True      # config 的 searchable 标志
        self.quick_search = True    # quickSearch
        self.filterable = True      # filterable
        # C2.3 字段矩阵的其余项（此前只读了 searchable/quickSearch/filterable，
        # 其他字段解析后被丢弃，站点级超时和 hide/indexs 因此完全失效）。
        # 语义取 FongMi `Site.java` 的 getter：见 runtime/config_snapshot.py。
        self.changeable = True      # 允许换源
        self.danmaku = True         # 允许弹幕
        self.hide = False           # 首页/搜索隐藏（仍可按 key 直达）
        self.index = False          # indexs：详情页优先展示分类索引
        self.timeout_ms = 15000     # 站点级请求超时（FongMi TIMEOUT_PLAY 默认 15s）
        self.categories = []        # 分类白名单（空 = 不过滤）
        self.play_url = ''          # 播放地址前缀/嗅探规则
        self.click = ''             # 点击脚本（TVBox 扩展）
        self.style = None           # {type, ratio}；None = 运行时回退 rect
        self.entry = None           # SiteEntry：完整矩阵 + 原始条目 + 未知字段
        self.ext_detail = None      # ResolvedExt：ext 归一/展开的过程与结论
        self.health = SiteHealth(key)

    @property
    def name(self):
        return self.display_name or self.key


class SiteManager:
    def __init__(self):
        self.sites = []
        # 包含未建成/不兼容站点，供诊断页展示；内容页只消费 healthy sites。
        self.diagnostics = []
        self._recent_key = None

    def _register(self, site, spider):
        try:
            spider.site_key = site.key
        except Exception:
            pass
        site.runner = Runner(spider)
        site.runner.init(site.ext)
        # Direct demo/plugin registration predates ConfigManager's staged
        # builder.  Give it the same health lifecycle so a Site object is not
        # silently usable while `/sites` reports it as uninitialized.
        site.health.runtime = 'python'
        site.health.compatibility = 'C1'
        site.health.mark_built().mark_initialized().mark_healthy()
        self.sites.append(site)
        self.diagnostics.append(site.health)
        if self._recent_key is None:
            self._recent_key = site.key
        logger.info('site loaded: %s (%s)', site.key, site.name)

    def load_api(self, key, api, ext=''):
        """http 地址 / 内联源码 → 原 app.spider(cache, api) 协议。"""
        site = Site(key, api, ext)
        safe_key = re.sub(r'[^\w.-]', '_', str(key))[:48] or 'site'
        basename = os.path.basename(urlparse(str(api)).path) if str(api).startswith('http') else 'inline.py'
        basename = re.sub(r'[^\w.-]', '_', basename or 'spider.py')[:48]
        digest = hashlib.sha256(str(api).encode('utf-8')).hexdigest()[:12]
        path = os.path.realpath(os.path.join(
            hoststate.get_plugins_dir(), f'{safe_key}-{digest}-{basename}'))
        root = os.path.realpath(hoststate.get_plugins_dir()) + os.sep
        if not path.startswith(root):
            raise ValueError('bad site key: %s' % key)
        spider_app.download(path, api)
        site.runner = SupervisedRunner({
            'kind': 'python', 'site_key': key, 'name': key, 'path': path,
        })
        site.runner.init(ext)
        site.health.runtime = 'python'
        site.health.compatibility = 'C1'
        site.health.mark_built().mark_initialized().mark_healthy()
        self.sites.append(site)
        self.diagnostics.append(site.health)
        return site

    def load_local(self, key, path, ext=''):
        """本地 spiders/ 目录插件：模块顶层类名约定为 Spider。"""
        site = Site(key, path, ext)
        site.runner = SupervisedRunner({
            'kind': 'python', 'site_key': key,
            'name': os.path.splitext(os.path.basename(path))[0],
            'path': os.path.realpath(path),
        })
        site.runner.init(ext)
        site.health.runtime = 'python'
        site.health.compatibility = 'C1'
        site.health.mark_built().mark_initialized().mark_healthy()
        self.sites.append(site)
        self.diagnostics.append(site.health)
        return site

    def get(self, key=None):
        if not self.sites:
            return None
        if key is None:
            return self.sites[0]
        for site in self.sites:
            if site.key == key:
                return site
        return None

    def set_recent(self, key):
        """记录最近一次进入内容/播放链路的站点。

        FongMi 的 JAR/JS/Python 本地代理在部分 URL 中不带 siteKey，
        BaseLoader 会使用最近的 loader。PC 端用显式 key 保存这一状态，
        避免并发请求依赖列表顺序。
        """
        if key and any(site.key == key for site in self.sites):
            self._recent_key = key

    @staticmethod
    def _kind(site):
        kind = str(getattr(site, 'spider_type', '') or '').lower()
        if kind:
            return kind
        spider = getattr(getattr(site, 'runner', None), 'spider', None)
        module = str(getattr(getattr(spider, '__class__', None), '__module__', '')).lower()
        if 'jar_spider' in module:
            return 'jar'
        if 'js_spider' in module:
            return 'js'
        if 'cms_spider' in module:
            return 'cms'
        return 'py'

    def recent(self, kind=None):
        """返回最近站点；kind 可为 jar/js/py/cms。"""
        ordered = []
        if self._recent_key:
            current = self.get(self._recent_key)
            if current is not None:
                ordered.append(current)
        ordered.extend(site for site in reversed(self.sites) if site not in ordered)
        wanted = str(kind or '').lower()
        for site in ordered:
            if not wanted or self._kind(site) == wanted:
                return site
        return None

    def destroy_all(self):
        # M-17：spider 级 destroy 只做清理不退进程（SpiderRunner 不再有
        # destroy=终态语义）；全部站点卸载后再统一关停 JVM 进程并清桥缓存，
        # 避免热重载时同 jar 站点"杀-重启-杀"风暴
        for site in self.sites:
            try:
                site.runner.destroy()
            except Exception:
                pass
        self.sites.clear()
        self.diagnostics.clear()
        self._recent_key = None
        try:
            from jar_bridge import JarBridge
            JarBridge.destroy_all()
        except Exception:
            pass
        try:
            from runtime.supervisor import destroy_all_supervisors
            destroy_all_supervisors()
        except Exception:
            pass
