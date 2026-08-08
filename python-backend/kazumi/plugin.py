# -*- coding: utf-8 -*-
"""Kazumi Plugin 类：JSON 序列化/反序列化、规则执行入口。

对齐 Kazumi lib/plugins/plugins.dart 的 Plugin 模型与执行逻辑。
"""
import json

from .models import RuleExecutionConfig, SearchItem, Road
from .utils import normalize_episode_url, get_random_ua, is_http_url


class RuleMode:
    XPATH = 'xpath'
    API = 'api'

    @staticmethod
    def normalize(value):
        return 'api' if value == 'api' else 'xpath'


def _camel_to_snake(name):
    """searchList -> search_list，chapterRoads -> chapter_roads。"""
    import re
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


class Plugin:
    """Kazumi 规则（api <= 8）。"""

    def __init__(self, **kwargs):
        self.api = str(kwargs.get('api', '1'))
        self.type = kwargs.get('type', 'anime')
        self.name = kwargs.get('name', '')
        self.version = str(kwargs.get('version', ''))
        self.muli_sources = bool(kwargs.get('muliSources', True))
        self.use_webview = bool(kwargs.get('useWebview', True))
        self.use_native_player = bool(kwargs.get('useNativePlayer', True))
        self.use_post = bool(kwargs.get('usePost', False))
        self.use_legacy_parser = bool(kwargs.get('useLegacyParser', False))
        self.ad_blocker = bool(kwargs.get('adBlocker', False))
        self.user_agent = kwargs.get('userAgent', '')
        self.base_url = kwargs.get('baseURL', '')  # 注意 JSON key 是大写 URL
        self.search_url = kwargs.get('searchURL', '')
        self.search_list = kwargs.get('searchList', '')
        self.search_name = kwargs.get('searchName', '')
        self.search_result = kwargs.get('searchResult', '')
        self.chapter_roads = kwargs.get('chapterRoads', '')
        self.chapter_result = kwargs.get('chapterResult', '')
        self.referer = kwargs.get('referer', '')
        self.search_mode = RuleMode.normalize(kwargs.get('searchMode'))
        self.chapter_mode = RuleMode.normalize(kwargs.get('chapterMode'))
        self.search_api_config = kwargs.get('searchApiConfig') or {}
        self.chapter_api_config = kwargs.get('chapterApiConfig') or {}
        self.anti_crawler_config = kwargs.get('antiCrawlerConfig') or {}
        self.enabled = bool(kwargs.get('enabled', True))
        # 安装/更新时间追踪（ISO-8601 字符串）
        self.installed_at = kwargs.get('installed_at', '')
        self.updated_at = kwargs.get('updated_at', '')
        # 有效性追踪（valid / invalid / unknown）
        self.validity = kwargs.get('validity', 'unknown')
        self.validity_checked_at = kwargs.get('validity_checked_at', '')

    @classmethod
    def from_json(cls, data):
        if isinstance(data, str):
            data = json.loads(data)
        return cls(**data)

    def to_json(self):
        return {
            'api': self.api,
            'type': self.type,
            'name': self.name,
            'version': self.version,
            'muliSources': self.muli_sources,
            'useWebview': self.use_webview,
            'useNativePlayer': self.use_native_player,
            'usePost': self.use_post,
            'useLegacyParser': self.use_legacy_parser,
            'adBlocker': self.ad_blocker,
            'userAgent': self.user_agent,
            'baseURL': self.base_url,
            'searchURL': self.search_url,
            'searchList': self.search_list,
            'searchName': self.search_name,
            'searchResult': self.search_result,
            'chapterRoads': self.chapter_roads,
            'chapterResult': self.chapter_result,
            'referer': self.referer,
            'searchMode': self.search_mode,
            'chapterMode': self.chapter_mode,
            'searchApiConfig': self.search_api_config,
            'chapterApiConfig': self.chapter_api_config,
            'antiCrawlerConfig': self.anti_crawler_config,
            'enabled': self.enabled,
            'installed_at': self.installed_at,
            'updated_at': self.updated_at,
            'validity': self.validity,
            'validity_checked_at': self.validity_checked_at,
        }

    @property
    def requires_newer_client(self):
        try:
            return int(self.api) > 8
        except (ValueError, TypeError):
            return True

    @property
    def uses_api_search(self):
        return self.search_mode == RuleMode.API

    def execution_config(self):
        return RuleExecutionConfig(
            plugin_name=self.name,
            base_url=self.base_url,
            use_post=self.use_post,
            search_mode=self.search_mode,
            chapter_mode=self.chapter_mode,
            search_url=self.search_url,
            search_list=self.search_list,
            search_name=self.search_name,
            search_result=self.search_result,
            chapter_roads=self.chapter_roads,
            chapter_result=self.chapter_result,
            search_api_config=self.search_api_config,
            chapter_api_config=self.chapter_api_config,
            anti_crawler_config=self.anti_crawler_config,
            user_agent=self.user_agent,
            referer=self.referer,
        )

    def build_http_headers(self):
        """播放/下载请求头（仅用于最终媒体资源，不用于 API 请求）。"""
        base = self.base_url.rstrip('/')
        return {
            'user-agent': self.user_agent or get_random_ua(),
            'referer': self.referer or (base + '/' if base else ''),
        }

    def build_full_url(self, url_item):
        return normalize_episode_url(self.base_url, url_item)

    def validate(self):
        """导入校验，返回错误信息或 None。"""
        if not self.name or not self.name.strip():
            return '规则缺少 name 字段'
        if self.requires_newer_client:
            return f'规则 API 版本过高（当前支持小于等于 8，实际为 {self.api}）'
        if self.search_mode not in (RuleMode.XPATH, RuleMode.API):
            return 'searchMode 必须为 xpath 或 api'
        if self.chapter_mode not in (RuleMode.XPATH, RuleMode.API):
            return 'chapterMode 必须为 xpath 或 api'
        if self.search_mode == RuleMode.XPATH:
            for field in ('searchList', 'searchName', 'searchResult'):
                if not getattr(self, _camel_to_snake(field), '').strip():
                    return f'XPath 模式缺少 {field}'
        if self.chapter_mode == RuleMode.XPATH:
            for field in ('chapterRoads', 'chapterResult'):
                if not getattr(self, _camel_to_snake(field), '').strip():
                    return f'XPath 模式缺少 {field}'
        if self.search_mode == RuleMode.API:
            req = (self.search_api_config.get('request') or {})
            if not req.get('url', '').strip():
                return 'API 模式 searchApiConfig.request.url 不能为空'
        if self.chapter_mode == RuleMode.API:
            req = (self.chapter_api_config.get('request') or {})
            if not req.get('url', '').strip():
                return 'API 模式 chapterApiConfig.request.url 不能为空'
        return None
