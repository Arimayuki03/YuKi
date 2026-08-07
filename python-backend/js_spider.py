# -*- coding: utf-8 -*-
"""JsSpider：把 JS spider（quickjs 内运行）适配为 base.spider.Spider 接口。

CatVod JS spider 方法名映射（TV 端契约）：
  home(filter) / homeVod() / category(tid,pg,filter,extend) / detail(ids串)
  search(wd,quick[,pg]) / play(flag,id,vipFlags) / live(url) / proxy(param)
  isVideoFormat(url) / manualVideoCheck() / action(action) / destroy()
方法返回 JSON 字符串，本适配层解析为 Python 对象交给 Runner/app。

注意：base Spider 的 __new__ 单例按类属性 _instance 隔离，多个 JS 站点
必须各自使用独立子类（make_js_spider_class 动态生成），否则共享实例。
"""
import json
import logging

from base.spider import Spider

logger = logging.getLogger('vpc.jsspider')


class JsSpider(Spider):
    engine = None       # JsEngine 实例（由工厂注入到子类）
    site_name = ''
    site_key = ''       # init 时透传给 JS 侧（FongMi 协议 cfg.skey）

    def init(self, extend=''):
        ext = extend if isinstance(extend, str) else json.dumps(extend or '', ensure_ascii=False)
        if getattr(self.engine, 'init_protocol', 'string') == 'fongmi':
            # FongMi/TVBox 协议（jadehh 等多模块源）：cfg 为对象 {skey, stype, ext}
            self._call('init', {'skey': self.site_key, 'stype': 3, 'ext': ext})
        else:
            # CatVod 单文件 spider：init(ext) 收字符串
            self._call('init', ext)

    def getName(self):
        return self.site_name

    # ------------------------------------------------------------ 内容 API

    def homeContent(self, filter):
        return self._json(self._call('home', bool(filter)), {})

    def homeVideoContent(self):
        return self._json(self._call('homeVod'), {})

    def categoryContent(self, tid, pg, filter, extend):
        return self._json(self._call('category', str(tid), str(pg), bool(filter), extend or {}), {})

    def detailContent(self, ids):
        return self._json(self._call('detail', ','.join(ids) if isinstance(ids, list) else str(ids)), {})

    def searchContent(self, key, quick, pg='1'):
        return self._json(self._call('search', key, self._truthy(quick), str(pg)), {})

    def playerContent(self, flag, id, vipFlags):
        return self._json(self._call('play', flag, id, vipFlags or []), {})

    def liveContent(self, url):
        return self._call('live', url) or ''

    def localProxy(self, param):
        raw = self._call('proxy', param or {})
        return self._json(raw, raw)

    def isVideoFormat(self, url):
        return self._truthy(self._call('isVideoFormat', url))

    def manualVideoCheck(self):
        return self._truthy(self._call('manualVideoCheck'))

    def action(self, action):
        return self._json(self._call('action', action), {})

    def destroy(self):
        self._call('destroy')

    # ------------------------------------------------------------ 工具

    def _call(self, method, *args):
        if self.engine is None:
            return None
        try:
            return self.engine.call(method, *args)
        except Exception as e:
            logger.warning('js call %s failed: %s', method, e)
            return None

    @staticmethod
    def _json(raw, default=None):
        if raw is None:
            return default
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _truthy(v):
        if isinstance(v, bool):
            return v
        return str(v).lower() in ('1', 'true', 'yes')


def make_js_spider_class(key, engine, name):
    """为每个 JS 站点生成独立子类（规避基类单例共享），返回已装配的实例。"""
    cls = type(f'JsSpider_{key}', (JsSpider,),
               {'engine': engine, 'site_name': name, 'site_key': key})
    return cls()
