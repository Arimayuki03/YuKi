# -*- coding: utf-8 -*-
"""Kazumi 规则引擎数据模型（与 Kazumi Dart 模型对齐）。"""
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class SearchItem:
    name: str
    src: str


@dataclass
class Road:
    name: str
    data: List[str] = field(default_factory=list)       # 剧集 URL 列表（播放页地址，非直链）
    identifier: List[str] = field(default_factory=list)  # 剧集名称列表


@dataclass
class PluginSearchResponse:
    plugin_name: str
    data: List[SearchItem] = field(default_factory=list)


@dataclass
class RuleExecutionConfig:
    plugin_name: str
    base_url: str
    use_post: bool
    search_mode: str      # 'xpath' | 'api'
    chapter_mode: str
    search_url: str
    search_list: str
    search_name: str
    search_result: str
    chapter_roads: str
    chapter_result: str
    search_api_config: dict = field(default_factory=dict)
    chapter_api_config: dict = field(default_factory=dict)
    anti_crawler_config: dict = field(default_factory=dict)
    user_agent: str = ''
    referer: str = ''


@dataclass
class PreparedRuleRequest:
    method: str
    url: str
    headers: dict = field(default_factory=dict)
    query: dict = field(default_factory=dict)
    body_type: str = 'none'   # 'none' | 'json' | 'form'
    body: Optional[object] = None
    include_cookies: bool = False


@dataclass
class RuleSearchParseResult:
    items: List[SearchItem] = field(default_factory=list)
    matched_fragments: List[str] = field(default_factory=list)
    diagnostics: List[str] = field(default_factory=list)


@dataclass
class RuleChapterParseResult:
    roads: List[Road] = field(default_factory=list)
    diagnostics: List[str] = field(default_factory=list)


@dataclass
class RuleSearchTrace:
    raw_response: str
    response: PluginSearchResponse
    matched_fragments: List[str] = field(default_factory=list)
    diagnostics: List[str] = field(default_factory=list)


@dataclass
class RuleChapterTrace:
    raw_response: str
    roads: List[Road] = field(default_factory=list)
    diagnostics: List[str] = field(default_factory=list)
