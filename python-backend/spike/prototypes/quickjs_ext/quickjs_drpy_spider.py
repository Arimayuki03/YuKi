# -*- coding: utf-8 -*-
"""QuickJsDrpySpider: 将 drpy QuickJS 执行引擎包装为统一的 base.spider.Spider 适配器。

实现 base Spider 契约：
- init(extend)
- homeContent(filter)
- homeVideoContent()
- categoryContent(tid, pg, filter, extend)
- detailContent(ids)
- searchContent(key, quick, pg)
- playerContent(flag, id, vipFlags)
- liveContent(url)
- localProxy(param)
- isVideoFormat(url)
- manualVideoCheck()
- action(action)
- destroy()

返回标准 dict / list / str / bool 数据结构。
"""

import json
import logging
import os
import sys
from typing import Any, Dict, List, Optional, Union

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(ENGINE_DIR, '..', '..', '..'))

for p in (BACKEND_DIR, ENGINE_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

from base.spider import Spider
from quickjs_drpy_engine import QuickJsDrpyEngine

logger = logging.getLogger('vpc.drpy_spider')


class QuickJsDrpySpider(Spider):
    """drpy 专用 QuickJS Spider 适配器。"""

    def __init__(
        self,
        site_key: str = '',
        site_name: str = '',
        rule_source: Optional[str] = None,
        time_limit: float = 30.0,
        memory_limit_mb: float = 256.0,
        custom_http_handler=None,
    ):
        super().__init__()
        self.site_key = str(site_key or '')
        self.site_name = str(site_name or site_key or 'QuickJsDrpySpider')
        self.engine = QuickJsDrpyEngine(
            site_key=self.site_key,
            time_limit=time_limit,
            memory_limit_mb=memory_limit_mb,
            custom_http_handler=custom_http_handler,
        )
        if rule_source:
            self.load_rule(rule_source)

    def load_rule(self, rule_source: str) -> bool:
        """加载 drpy 规则源码。"""
        return self.engine.load_spider(rule_source)

    def load_rule_url(self, entry_url: str, fetch_text) -> bool:
        """从 URL 加载多模块 drpy 规则。"""
        return self.engine.load_spider_url(entry_url, fetch_text)

    # ------------------------------------------------------------ base Spider 接口实现

    def init(self, extend: Any = '') -> None:
        """初始化 drpy 规则。"""
        ext = extend if isinstance(extend, str) else json.dumps(extend or '', ensure_ascii=False)
        if getattr(self.engine, 'init_protocol', 'string') == 'fongmi':
            self._call('init', {'skey': self.site_key, 'stype': 3, 'ext': ext})
        else:
            self._call('init', ext)

    def getName(self) -> str:
        return self.site_name

    def homeContent(self, filter: bool = False) -> Dict[str, Any]:
        """获取首页分类与推荐。返回标准 dict：{ 'class': [...], 'list': [...] }。"""
        raw = self._call('home', bool(filter))
        return self._to_dict(raw, {'class': [], 'list': []})

    def homeVideoContent(self) -> Dict[str, Any]:
        """获取首页视频列表。返回标准 dict：{ 'list': [...] }。"""
        raw = self._call('homeVod') or self._call('homeVideo')
        return self._to_dict(raw, {'list': []})

    def categoryContent(
        self,
        tid: str,
        pg: str = '1',
        filter: bool = False,
        extend: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """获取分类列表。返回标准 dict：{ 'page': 1, 'pagecount': 1, 'limit': 20, 'total': 20, 'list': [...] }。"""
        raw = self._call('category', str(tid), str(pg), bool(filter), extend or {})
        return self._to_dict(raw, {'page': int(pg or 1), 'list': []})

    def detailContent(self, ids: Union[str, List[str]]) -> Dict[str, Any]:
        """获取视频详情。返回标准 dict：{ 'list': [...] }。"""
        id_str = ','.join(ids) if isinstance(ids, list) else str(ids)
        raw = self._call('detail', id_str)
        return self._to_dict(raw, {'list': []})

    def searchContent(
        self,
        key: str,
        quick: bool = False,
        pg: str = '1',
    ) -> Dict[str, Any]:
        """搜索视频。返回标准 dict：{ 'page': 1, 'list': [...] }。"""
        raw = self._call('search', str(key), self._truthy(quick), str(pg))
        return self._to_dict(raw, {'page': int(pg or 1), 'list': []})

    def playerContent(
        self,
        flag: str,
        id: str,
        vipFlags: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """解析播放直链。返回标准 dict：{ 'parse': 0, 'url': '...', 'header': {...} }。"""
        raw = self._call('play', str(flag), str(id), vipFlags or [])
        return self._to_dict(raw, {'parse': 0, 'url': id, 'header': {}})

    def liveContent(self, url: str) -> str:
        """直播流直链。返回 str。"""
        raw = self._call('live', str(url))
        return str(raw or '')

    def localProxy(self, param: Dict[str, Any]) -> Any:
        """本地代理转发请求。"""
        raw = self._call('proxy', param or {})
        return self._to_json(raw, raw)

    def isVideoFormat(self, url: str) -> bool:
        """判断是否为直链视频格式。"""
        raw = self._call('isVideoFormat', str(url))
        return self._truthy(raw)

    def manualVideoCheck(self) -> bool:
        """是否手动检查嗅探视频。"""
        raw = self._call('manualVideoCheck')
        return self._truthy(raw)

    def action(self, action: Dict[str, Any]) -> Dict[str, Any]:
        """自定义操作指令。"""
        raw = self._call('action', action or {})
        return self._to_dict(raw, {})

    def destroy(self) -> None:
        """销毁释放资源。"""
        try:
            self._call('destroy')
        except Exception:
            pass

    # ------------------------------------------------------------ 内部辅助方法

    def _call(self, method: str, *args) -> Optional[str]:
        if not self.engine:
            return None
        try:
            return self.engine.call(method, *args)
        except Exception as e:
            logger.warning('drpy spider call %s failed: %s', method, e)
            return None

    @staticmethod
    def _to_json(raw: Optional[str], default: Any = None) -> Any:
        if raw is None:
            return default
        if not isinstance(raw, str):
            return raw
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _to_dict(raw: Optional[str], default: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if default is None:
            default = {}
        if raw is None:
            return default
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, str):
            try:
                data = json.loads(raw)
                return data if isinstance(data, dict) else default
            except (TypeError, ValueError):
                return default
        return default

    @staticmethod
    def _truthy(v: Any) -> bool:
        if isinstance(v, bool):
            return v
        return str(v).lower() in ('1', 'true', 'yes')


def make_quickjs_drpy_spider(
    site_key: str,
    site_name: str,
    rule_source: str,
    time_limit: float = 30.0,
    memory_limit_mb: float = 256.0,
    custom_http_handler=None,
) -> QuickJsDrpySpider:
    """工厂方法：为站点创建隔离的 QuickJsDrpySpider 实例。"""
    cls = type(
        f'QuickJsDrpySpider_{site_key}',
        (QuickJsDrpySpider,),
        {}
    )
    return cls(
        site_key=site_key,
        site_name=site_name,
        rule_source=rule_source,
        time_limit=time_limit,
        memory_limit_mb=memory_limit_mb,
        custom_http_handler=custom_http_handler,
    )
