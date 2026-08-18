# -*- coding: utf-8 -*-
"""正式 drpy Spider 适配器模块 (drpy_spider.py)

继承系统 base.spider.Spider 规范，将爬虫请求桥接至 DrpySupervisor 与底层 Node Worker 运行器，
实现 CatVod 标准五方法及周边能力。
"""

import json
import logging
import os
from typing import Any, Dict, List, Optional, Union

try:
    from base.spider import Spider
except ImportError:
    import sys
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
    from base.spider import Spider

from drpy_supervisor import DrpySupervisor, DrpyWorkerError, DrpyWorkerTimeoutError

logger = logging.getLogger('vpc.drpy_spider')


class DrpySpider(Spider):
    """
    DrpySpider:
    基于独立 Node.js Worker 进程运行的正式 drpy 规则适配器。
    """
    _supervisor: Optional[DrpySupervisor] = None
    rule_source: str = ""
    site_name: str = ""
    site_key: str = ""
    last_error: str = ""

    def __init__(
        self,
        rule_source: str = "",
        site_name: str = "",
        site_key: str = "",
        node_path: Optional[str] = None,
        timeout: float = 15.0,
        max_memory_mb: float = 256.0
    ):
        super().__init__()
        self.rule_source = rule_source
        self.site_name = site_name
        self.site_key = site_key
        self.last_error = ""
        self._supervisor = DrpySupervisor(
            node_path=node_path,
            timeout=timeout,
            max_memory_mb=max_memory_mb,
            site_key=site_key
        )
        if self.rule_source:
            self._supervisor.start()
            self._supervisor.load_rule(self.rule_source)

    def load_source(self, rule_source: str):
        """载入/切换 drpy 规则源码"""
        self.rule_source = rule_source
        if not self._supervisor.is_alive():
            self._supervisor.start()
        self._supervisor.load_rule(rule_source)

    def init(self, extend: Union[str, dict] = ''):
        """初始化站点，支持字符串或对象协议"""
        self.last_error = ""
        ext = extend if isinstance(extend, str) else json.dumps(extend or '', ensure_ascii=False)
        try:
            self._supervisor.call_rpc('init', [ext])
        except Exception as e:
            self.last_error = str(e)
            logger.warning(f"DrpySpider [{self.site_name}] init error: {e}")

    def getName(self) -> str:
        return self.site_name or self.site_key

    def homeContent(self, filter: bool = False) -> Dict[str, Any]:
        self.last_error = ""
        raw = self._safe_call('home', [bool(filter)])
        return self._parse_json(raw, {'class': [], 'list': []})

    def homeVideoContent(self) -> Dict[str, Any]:
        self.last_error = ""
        raw = self._safe_call('homeVod', [])
        return self._parse_json(raw, {'list': []})

    def categoryContent(self, tid: str, pg: str, filter: bool, extend: Union[dict, str, None]) -> Dict[str, Any]:
        self.last_error = ""
        raw = self._safe_call('category', [str(tid), str(pg), bool(filter), extend or {}])
        return self._parse_json(raw, {'page': int(pg or 1), 'list': []})

    def detailContent(self, ids: Union[str, List[str]]) -> Dict[str, Any]:
        self.last_error = ""
        id_str = ','.join(ids) if isinstance(ids, list) else str(ids)
        raw = self._safe_call('detail', [id_str])
        return self._parse_json(raw, {'list': []})

    def searchContent(self, key: str, quick: bool, pg: str = '1') -> Dict[str, Any]:
        self.last_error = ""
        raw = self._safe_call('search', [str(key), bool(quick), str(pg)])
        return self._parse_json(raw, {'page': int(pg or 1), 'list': []})

    def playerContent(self, flag: str, id: str, vipFlags: Optional[List[str]] = None) -> Dict[str, Any]:
        self.last_error = ""
        raw = self._safe_call('play', [str(flag), str(id), vipFlags or []])
        return self._parse_json(raw, {'parse': 0, 'url': id})

    def localProxy(self, param: Any) -> Any:
        self.last_error = ""
        raw = self._safe_call('proxy', [param or {}])
        return self._parse_json(raw, raw)

    def isVideoFormat(self, url: str) -> bool:
        res = self._safe_call('isVideoFormat', [url])
        return self._truthy(res)

    def manualVideoCheck(self) -> bool:
        res = self._safe_call('manualVideoCheck', [])
        return self._truthy(res)

    def action(self, action: Any) -> Dict[str, Any]:
        self.last_error = ""
        raw = self._safe_call('action', [action])
        return self._parse_json(raw, {})

    def destroy(self):
        """销毁底层 Supervisor 与 Worker 进程"""
        if self._supervisor:
            self._supervisor.destroy()

    def _safe_call(self, method: str, args: list) -> Any:
        if not self._supervisor:
            return None
        try:
            return self._supervisor.call_rpc(method, args)
        except Exception as e:
            self.last_error = str(e)
            logger.warning(f"DrpySpider [{self.site_name}] call '{method}' failed: {e}")
            raise

    @staticmethod
    def _parse_json(raw: Any, default: Any = None) -> Any:
        if raw is None:
            return default
        if isinstance(raw, (dict, list)):
            return raw
        if isinstance(raw, str):
            trimmed = raw.strip()
            if (trimmed.startswith('{') and trimmed.endswith('}')) or (trimmed.startswith('[') and trimmed.endswith(']')):
                try:
                    return json.loads(trimmed)
                except Exception:
                    return default
        return default

    @staticmethod
    def _truthy(v: Any) -> bool:
        if isinstance(v, bool):
            return v
        return str(v).lower() in ('1', 'true', 'yes')


def make_drpy_spider_class(
    key: str,
    rule_source: str,
    name: str = "",
    node_path: Optional[str] = None,
    timeout: float = 15.0,
    max_memory_mb: float = 256.0
) -> DrpySpider:
    """动态类工厂：为每个站点创建独立 Spider 类与隔离 Supervisor 实例"""
    cls = type(
        f'DrpySpider_{key}',
        (DrpySpider,),
        {'site_name': name or key, 'site_key': key}
    )
    return cls(
        rule_source=rule_source,
        site_name=name or key,
        site_key=key,
        node_path=node_path,
        timeout=timeout,
        max_memory_mb=max_memory_mb
    )
