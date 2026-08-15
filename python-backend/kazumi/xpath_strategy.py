# -*- coding: utf-8 -*-
"""Kazumi XPath 规则策略（lxml 实现）。

对齐 Kazumi lib/services/plugin/xpath_rule_strategy.dart。
关键：Kazumi XPath 是相对节点查询，必须在正确的上下文节点上执行。
"""
import logging
import re

from lxml import html as lxml_html
from lxml import etree

from .models import SearchItem, Road, PreparedRuleRequest, RuleSearchParseResult, RuleChapterParseResult
from .utils import normalize_episode_url, XPathRuleFormatException, CaptchaRequiredException, NoResultException

logger = logging.getLogger('vpc.kazumi.xpath')


class XPathRuleStrategy:
    """XPath 规则搜索与剧集解析。"""

    # ---------------------------------------------------------------- 请求构造

    def prepare_search_request(self, config, keyword, filters=None):
        query_url = config.search_url.replace('@keyword', keyword)
        # 可选筛选（任务三 part2）：仅当 searchURL 声明了 @tag/@year/@sort 占位才替换，
        # 未声明的规则原样保留（占位不存在时 replace 是空操作），实现 opt-in 与优雅降级。
        filters = filters or {}
        for key in ('tag', 'year', 'sort'):
            query_url = query_url.replace('@' + key, str(filters.get(key) or ''))
        if not config.use_post:
            return PreparedRuleRequest(method='GET', url=query_url, include_cookies=True)
        # POST：URL 去 query，query 作为表单 body
        from urllib.parse import urlparse, parse_qs, urlunparse
        parsed = urlparse(query_url)
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        url = urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, '', parsed.fragment))
        return PreparedRuleRequest(method='POST', url=url, body_type='form', body=query, include_cookies=True)

    def prepare_chapter_request(self, config, source):
        url = normalize_episode_url(config.base_url, source)
        return PreparedRuleRequest(method='GET', url=url)

    # ---------------------------------------------------------------- 搜索解析

    def parse_search(self, raw, config):
        root = self._document_element(raw)
        # 反爬检测（本期仅识别，不实现验证流程）
        if self._detects_captcha(raw, config.anti_crawler_config, root):
            raise CaptchaRequiredException(config.plugin_name)

        items = []
        fragments = []
        diagnostics = []
        nodes = self._run_selector('searchList', config.search_list,
                                   lambda: root.xpath(config.search_list))
        for index, node in enumerate(nodes):
            try:
                name_node = self._run_selector('searchName', config.search_name,
                                               lambda: node.xpath(self._node_relative(config.search_name)))
                name = self._node_text(name_node[0]) if name_node else ''
                src_node = self._run_selector('searchResult', config.search_result,
                                              lambda: node.xpath(self._node_relative(config.search_result)))
                src = ''
                if src_node:
                    first = src_node[0]
                    src = first.strip() if isinstance(first, str) else (first.get('href') or '').strip()
                if not name or not src:
                    diagnostics.append(f'搜索节点 {index} 缺少名称或来源，已跳过')
                    continue
                items.append(SearchItem(name=name, src=normalize_episode_url(config.base_url, src)))
                fragments.append(etree.tostring(node, encoding='unicode')[:200])
            except XPathRuleFormatException:
                raise
            except Exception as e:
                diagnostics.append(f'搜索节点 {index} 解析失败: {e}')
        return RuleSearchParseResult(items=items, matched_fragments=fragments, diagnostics=diagnostics)

    # ---------------------------------------------------------------- 剧集解析

    def parse_chapters(self, raw, config):
        root = self._document_element(raw)
        roads = []
        diagnostics = []
        road_nodes = self._run_selector('chapterRoads', config.chapter_roads,
                                        lambda: root.xpath(config.chapter_roads))
        for road_index, road_node in enumerate(road_nodes):
            try:
                urls = []
                names = []
                episode_nodes = self._run_selector('chapterResult', config.chapter_result,
                                                   lambda: road_node.xpath(self._node_relative(config.chapter_result)))
                for episode_index, episode_node in enumerate(episode_nodes):
                    try:
                        source = episode_node.get('href', '').strip()
                        if not source:
                            diagnostics.append(f'线路 {road_index} 的剧集节点 {episode_index} 缺少 URL，已跳过')
                            continue
                        name = ' '.join(episode_node.text_content().split())
                        urls.append(normalize_episode_url(config.base_url, source))
                        names.append(name or f'第{episode_index + 1}集')
                    except Exception as e:
                        diagnostics.append(f'线路 {road_index} 的剧集节点 {episode_index} 解析失败: {e}')
                if not urls:
                    diagnostics.append(f'线路 {road_index} 没有有效剧集，已跳过')
                    continue
                roads.append(Road(name=f'播放线路{len(roads) + 1}', data=urls, identifier=names))
            except XPathRuleFormatException:
                raise
            except Exception as e:
                diagnostics.append(f'线路节点 {road_index} 解析失败: {e}')
        return RuleChapterParseResult(roads=roads, diagnostics=diagnostics)

    # ---------------------------------------------------------------- 反爬检测（仅识别）

    def _detects_captcha(self, raw, anti_crawler_config, root):
        if not anti_crawler_config or not anti_crawler_config.get('enabled'):
            return False
        detect_value = (anti_crawler_config.get('captchaDetectValue') or '').strip()
        detect_type = anti_crawler_config.get('captchaDetectType', 1)
        if detect_value:
            if detect_type == 2:  # text
                return detect_value in raw
            if detect_type == 3:  # regex
                try:
                    return bool(re.search(detect_value, raw, re.I | re.S))
                except Exception:
                    return False
            # xpath（默认）
            return bool(root.xpath(detect_value))
        # 兜底：检测验证码图片/按钮 XPath
        for field in ('captchaImage', 'captchaButton'):
            expr = (anti_crawler_config.get(field) or '').strip()
            if expr and root.xpath(expr):
                return True
        return False

    # ---------------------------------------------------------------- 工具

    @staticmethod
    def _node_relative(expr):
        """把 Kazumi 规则里文档级 `//` 查询归一化为节点相对查询。

        Kazumi 的 searchName/searchResult/chapterResult 均以 searchList/chapterRoads 节点为上下文
        （Dart 端 node.queryXPath(...) 是节点内查询），但规则文本沿用 `//` 前缀。
        lxml 的 node.xpath('//x') 却是**文档根查询**，导致取到整页首个匹配而非节点内匹配
        （7sefun 搜索因此返回空）。规则里 `//a` → `.//a`、`/a` → `./a`。
        已以 `.` 或 `./` 开头的表达式原样返回。"""
        e = (expr or '').strip()
        if e.startswith('/'):
            return '.' + e
        return e

    @staticmethod
    def _node_text(node):
        """取节点文本：`/text()` 选出的结果是 str 直接用；元素取 text_content。"""
        if isinstance(node, str):
            return node.strip()
        return node.text_content().strip()

    def _document_element(self, raw):
        try:
            doc = lxml_html.fromstring(raw)
            if doc is None:
                raise XPathRuleFormatException('HTML 响应没有根节点', kind='invalidDocument')
            return doc
        except XPathRuleFormatException:
            raise
        except Exception as e:
            raise XPathRuleFormatException('HTML 响应解析失败', kind='invalidDocument', cause=e)

    def _run_selector(self, field, expression, query):
        label = {
            'searchList': '搜索结果列表',
            'searchName': '条目名称',
            'searchResult': '条目链接',
            'chapterRoads': '播放线路列表',
            'chapterResult': '剧集列表',
        }.get(field, field)
        if not expression.strip():
            raise XPathRuleFormatException(f'{label} XPath 不能为空', kind='invalidSelector', field=field, expression=expression)
        try:
            return query()
        except XPathRuleFormatException:
            raise
        except Exception as e:
            raise XPathRuleFormatException(f'{label} XPath 无效: {expression}', kind='invalidSelector', field=field, expression=expression, cause=e)
