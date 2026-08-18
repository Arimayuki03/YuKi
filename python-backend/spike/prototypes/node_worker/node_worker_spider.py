# -*- coding: utf-8 -*-
"""
NodeWorkerSpider 适配器
实现 base.spider.Spider 标准接口，将 Spider 请求桥接至 NodeSupervisor / worker_runner，
并完成返回值 JSON 到标准 Python dict 的反序列化与异常容错。
"""

import json
import logging
import os
from typing import Any, Dict, List, Optional, Union

# 动态引入项目根目录下的 base.spider.Spider
try:
    from base.spider import Spider
except ImportError:
    import sys
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')))
    from base.spider import Spider

from .node_supervisor import NodeSupervisor, NodeWorkerError

logger = logging.getLogger('vpc.node_worker_spider')


class NodeWorkerSpider(Spider):
    """
    NodeWorkerSpider:
    把基于 Node.js 独立 Worker 进程运行的 drpy 规则适配为系统标准的 base.spider.Spider 接口。
    """
    _supervisor: Optional[NodeSupervisor] = None
    rule_source: str = ""
    site_name: str = ""
    site_key: str = ""

    def __init__(
        self,
        rule_source: str = "",
        site_name: str = "",
        site_key: str = "",
        node_path: str = "node",
        timeout: float = 10.0,
        max_memory_mb: float = 256.0
    ):
        super().__init__()
        self.rule_source = rule_source
        self.site_name = site_name
        self.site_key = site_key
        self._supervisor = NodeSupervisor(
            node_path=node_path,
            timeout=timeout,
            max_memory_mb=max_memory_mb
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
        ext = extend if isinstance(extend, str) else json.dumps(extend or '', ensure_ascii=False)
        try:
            self._supervisor.call_rpc('init', [ext])
        except Exception as e:
            logger.warning(f"NodeWorkerSpider [{self.site_name}] init error: {e}")

    def getName(self) -> str:
        return self.site_name

    def homeContent(self, filter: bool = False) -> Dict[str, Any]:
        raw = self._safe_call('home', [bool(filter)])
        return self._parse_json(raw, {'class': [], 'list': []})

    def homeVideoContent(self) -> Dict[str, Any]:
        raw = self._safe_call('homeVod', [])
        return self._parse_json(raw, {'list': []})

    def categoryContent(self, tid: str, pg: str, filter: bool, extend: Union[dict, str, None]) -> Dict[str, Any]:
        raw = self._safe_call('category', [str(tid), str(pg), bool(filter), extend or {}])
        return self._parse_json(raw, {'page': int(pg or 1), 'list': []})

    def detailContent(self, ids: Union[str, List[str]]) -> Dict[str, Any]:
        id_str = ','.join(ids) if isinstance(ids, list) else str(ids)
        raw = self._safe_call('detail', [id_str])
        return self._parse_json(raw, {'list': []})

    def searchContent(self, key: str, quick: bool, pg: str = '1') -> Dict[str, Any]:
        raw = self._safe_call('search', [str(key), bool(quick), str(pg)])
        return self._parse_json(raw, {'page': int(pg or 1), 'list': []})

    def playerContent(self, flag: str, id: str, vipFlags: Optional[List[str]] = None) -> Dict[str, Any]:
        raw = self._safe_call('play', [str(flag), str(id), vipFlags or []])
        return self._parse_json(raw, {'parse': 0, 'url': id})

    def localProxy(self, param: Any) -> Any:
        raw = self._safe_call('proxy', [param or {}])
        return self._parse_json(raw, raw)

    def isVideoFormat(self, url: str) -> bool:
        res = self._safe_call('isVideoFormat', [url])
        return self._truthy(res)

    def manualVideoCheck(self) -> bool:
        res = self._safe_call('manualVideoCheck', [])
        return self._truthy(res)

    def action(self, action: Any) -> Dict[str, Any]:
        raw = self._safe_call('action', [action])
        return self._parse_json(raw, {})

    def destroy(self):
        """销毁 Supervisor 和底层 Worker 进程"""
        if self._supervisor:
            self._supervisor.destroy()

    # ----------------- 辅助方法 -----------------

    def _safe_call(self, method: str, args: list) -> Any:
        if not self._supervisor:
            return None
        try:
            return self._supervisor.call_rpc(method, args)
        except Exception as e:
            logger.warning(f"NodeWorkerSpider [{self.site_name}] call '{method}' failed: {e}")
            return None

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


def make_node_worker_spider(
    key: str,
    rule_source: str,
    name: str = "",
    node_path: str = "node",
    timeout: float = 10.0,
    max_memory_mb: float = 256.0
) -> NodeWorkerSpider:
    """
    工厂方法：为每一个独立的 key 动态创建独立的 Spider 子类与实例，
    规避基类 Spider 单例共享。
    """
    cls = type(
        f'NodeWorkerSpider_{key}',
        (NodeWorkerSpider,),
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
