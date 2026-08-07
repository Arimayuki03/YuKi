# -*- coding: utf-8 -*-
"""站点（spider 插件）管理：加载、初始化、分发。

两种加载途径（对应原 app.spider 的两种 api 形态 + 本地插件目录）：
- load_api(key, api, ext): api 为 http 地址或内联源码，走恢复版 app.spider()
- load_local(key, path, ext): 直接加载本地 spiders/ 目录下的 .py 文件
"""
import os
import logging
from importlib.machinery import SourceFileLoader

import app as spider_app          # 恢复版插件入口（字节码校验一致）
import hoststate
from runner import Runner

logger = logging.getLogger('vpc.sites')


class Site:
    def __init__(self, key, api, ext=''):
        self.key = key
        self.api = api
        self.ext = ext
        self.runner = None
        self.searchable = True      # config 的 searchable 标志
        self.quick_search = True    # quickSearch
        self.filterable = True      # filterable

    @property
    def name(self):
        if self.runner is None:
            return self.key
        try:
            return self.runner.getName() or self.key
        except Exception:
            return self.key


class SiteManager:
    def __init__(self):
        self.sites = []

    def _register(self, site, spider):
        site.runner = Runner(spider)
        site.runner.init(site.ext)
        self.sites.append(site)
        logger.info('site loaded: %s (%s)', site.key, site.name)

    def load_api(self, key, api, ext=''):
        """http 地址 / 内联源码 → 原 app.spider(cache, api) 协议。"""
        site = Site(key, api, ext)
        spider = spider_app.spider(hoststate.get_plugins_dir(), api)
        self._register(site, spider)
        return site

    def load_local(self, key, path, ext=''):
        """本地 spiders/ 目录插件：模块顶层类名约定为 Spider。"""
        site = Site(key, path, ext)
        name = os.path.splitext(os.path.basename(path))[0]
        module = SourceFileLoader(name, path).load_module()
        self._register(site, module.Spider())
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

    def destroy_all(self):
        for site in self.sites:
            try:
                site.runner.destroy()
            except Exception:
                pass
        self.sites.clear()
