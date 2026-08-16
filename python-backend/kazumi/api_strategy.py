# -*- coding: utf-8 -*-
"""Kazumi API 规则策略（受限 JSONPath 实现）。

对齐 Kazumi lib/services/plugin/api_rule_strategy.dart。
受限 JSONPath：仅支持 $ . [index|*|'key']，禁止递归下降与过滤器。
"""
import json
import re
from urllib.parse import quote, urlparse, parse_qsl

from jsonpath_ng import parse as jsonpath_parse

from .models import SearchItem, Road, PreparedRuleRequest, RuleSearchParseResult, RuleChapterParseResult
from .utils import normalize_episode_url, ApiRuleFormatException


class RestrictedJsonPath:
    """受限 JSONPath 校验与读取。"""

    @staticmethod
    def validate(expression):
        if not expression or not expression.startswith('$'):
            raise ApiRuleFormatException(f'JSONPath 必须以 $ 开头: {expression}')
        index = 1
        while index < len(expression):
            char = expression[index]
            if char == '.':
                index += 1
                start = index
                while index < len(expression) and re.match(r'[A-Za-z0-9_$-]', expression[index]):
                    index += 1
                if index == start:
                    raise ApiRuleFormatException(f'不支持的 JSONPath: {expression}')
                continue
            if char == '[':
                end = RestrictedJsonPath._find_bracket_end(expression, index)
                content = expression[index + 1:end].strip()
                is_index = bool(re.match(r'^\d+$', content))
                is_wildcard = content == '*'
                is_quoted = len(content) >= 2 and (
                    (content.startswith("'") and content.endswith("'"))
                    or (content.startswith('"') and content.endswith('"'))
                )
                if not (is_index or is_wildcard or is_quoted):
                    raise ApiRuleFormatException(f'不支持的 JSONPath 片段: [{content}]')
                index = end + 1
                continue
            raise ApiRuleFormatException(f'不支持的 JSONPath: {expression}')

    @staticmethod
    def _find_bracket_end(expression, start):
        quote_char = None
        escaped = False
        for i in range(start + 1, len(expression)):
            char = expression[i]
            if escaped:
                escaped = False
                continue
            if char == '\\':
                escaped = True
                continue
            if quote_char:
                if char == quote_char:
                    quote_char = None
                continue
            if char in ("'", '"'):
                quote_char = char
                continue
            if char == ']':
                return i
        raise ApiRuleFormatException(f'JSONPath 缺少 ]: {expression}')

    @staticmethod
    def read(document, expression):
        RestrictedJsonPath.validate(expression)
        try:
            return [match.value for match in jsonpath_parse(expression).find(document)]
        except Exception as e:
            raise ApiRuleFormatException(f'JSONPath 解析失败 {expression}: {e}')

    @staticmethod
    def read_first(document, expression):
        values = RestrictedJsonPath.read(document, expression)
        return values[0] if values else None


class ApiRuleStrategy:
    """API/JSONPath 规则搜索与剧集解析。"""

    def decode_response(self, raw):
        try:
            return json.loads(raw)
        except Exception as e:
            raise ApiRuleFormatException(f'API 响应不是有效 JSON: {e}')

    # ---------------------------------------------------------------- 请求构造

    def prepare_request(self, config, variables):
        method = config.get('method', 'GET').upper()
        if method not in ('GET', 'POST'):
            raise ApiRuleFormatException(f'仅支持 GET/POST，当前为 {method}')
        url = self._render_template(config.get('url', '').strip(), variables, encode=True)
        if not url:
            raise ApiRuleFormatException('API 请求 URL 不能为空')
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            raise ApiRuleFormatException(f'API 请求 URL 无效: {url}')
        body_type = config.get('bodyType', 'none')
        has_body = method == 'POST' and body_type != 'none'
        return PreparedRuleRequest(
            method=method,
            url=url,
            headers=self._render_map(config.get('headers', {}), variables),
            query=self._render_map(config.get('query', {}), variables),
            body_type=body_type,
            body=self._render_value(config.get('body'), variables) if has_body else None,
            include_cookies=True,
        )

    # ---------------------------------------------------------------- 搜索解析

    def validate_search_config(self, config):
        RestrictedJsonPath.validate(config.get('listPath', '$.data[*]'))
        RestrictedJsonPath.validate(config.get('namePath', '$.name'))
        RestrictedJsonPath.validate(config.get('sourcePath', '$.url'))

    def parse_search(self, raw, config):
        self.validate_search_config(config)
        document = self.decode_response(raw)
        nodes = RestrictedJsonPath.read(document, config.get('listPath', '$.data[*]'))
        results = []
        fragments = []
        diagnostics = []
        for index, node in enumerate(nodes):
            try:
                name = self._string_value(RestrictedJsonPath.read_first(node, config.get('namePath', '$.name')))
                source = self._string_value(RestrictedJsonPath.read_first(node, config.get('sourcePath', '$.url')))
                if not name or not source:
                    diagnostics.append(f'搜索节点 {index} 缺少名称或来源，已跳过')
                    continue
                results.append(SearchItem(name=name, src=source))
                fragments.append(json.dumps(node, ensure_ascii=False)[:200])
            except ApiRuleFormatException:
                raise
            except Exception as e:
                diagnostics.append(f'搜索节点 {index} 解析失败: {e}')
        return RuleSearchParseResult(items=results, matched_fragments=fragments, diagnostics=diagnostics)

    # ---------------------------------------------------------------- 剧集解析

    def validate_chapter_config(self, config):
        for path in (config.get('variables') or {}).values():
            RestrictedJsonPath.validate(path)
        if config.get('format') == 'delimited':
            RestrictedJsonPath.validate(config.get('roadNamesPath', ''))
            RestrictedJsonPath.validate(config.get('roadEpisodesPath', ''))
            if not config.get('roadSeparator') or not config.get('episodeSeparator') or not config.get('fieldSeparator'):
                raise ApiRuleFormatException('章节分隔符不能为空')
            return
        if config.get('roadsPath', '').strip():
            RestrictedJsonPath.validate(config.get('roadsPath', ''))
        if config.get('roadNamePath', '').strip():
            RestrictedJsonPath.validate(config.get('roadNamePath', ''))
        RestrictedJsonPath.validate(config.get('episodesPath', '$.episodes[*]'))
        RestrictedJsonPath.validate(config.get('episodeNamePath', '$.name'))
        if config.get('episodeUrlPath', '').strip():
            RestrictedJsonPath.validate(config.get('episodeUrlPath', ''))
        elif not config.get('episodePage'):
            raise ApiRuleFormatException('必须配置播放入口地址路径或播放页地址模板')
        if config.get('episodePage') and not config['episodePage'].get('url', '').strip():
            raise ApiRuleFormatException('播放页地址模板不能为空')

    def parse_chapters(self, raw, config, source, base_url):
        self.validate_chapter_config(config)
        document = self.decode_response(raw)
        root_variables = {'source': source}
        for key, path in (config.get('variables') or {}).items():
            value = RestrictedJsonPath.read_first(document, path)
            if value is None:
                raise ApiRuleFormatException(f'章节响应变量 {key} 未匹配到值: {path}')
            root_variables[key] = value
        diagnostics = []
        if config.get('format') == 'delimited':
            roads = self._parse_delimited(document, config, root_variables, base_url, diagnostics)
        else:
            roads = self._parse_nested(document, config, root_variables, base_url, diagnostics)
        return RuleChapterParseResult(roads=roads, diagnostics=diagnostics)

    def _parse_nested(self, document, config, root_variables, base_url, diagnostics):
        has_roads = bool(config.get('roadsPath', '').strip())
        road_nodes = RestrictedJsonPath.read(document, config['roadsPath']) if has_roads else [document]
        roads = []
        for road_index, road_node in enumerate(road_nodes):
            try:
                road_name = ''
                if has_roads and config.get('roadNamePath', '').strip():
                    road_name = self._string_value(RestrictedJsonPath.read_first(road_node, config['roadNamePath']))
                episode_nodes = RestrictedJsonPath.read(road_node, config.get('episodesPath', '$.episodes[*]'))
                urls = []
                names = []
                for episode_index, episode_node in enumerate(episode_nodes):
                    try:
                        episode_name = self._string_value(RestrictedJsonPath.read_first(episode_node, config.get('episodeNamePath', '$.name')))
                        raw_url = ''
                        if config.get('episodeUrlPath', '').strip():
                            raw_url = self._string_value(RestrictedJsonPath.read_first(episode_node, config['episodeUrlPath']))
                        page_url = self._resolve_episode_url(config, root_variables, raw_url=raw_url,
                                                             road_index=road_index, episode_index=episode_index,
                                                             base_url=base_url)
                        if not page_url:
                            diagnostics.append(f'线路 {road_index} 的剧集节点 {episode_index} 缺少 URL，已跳过')
                            continue
                        urls.append(page_url)
                        names.append(episode_name or f'第{episode_index + 1}集')
                    except ApiRuleFormatException:
                        raise
                    except Exception as e:
                        diagnostics.append(f'线路 {road_index} 的剧集节点 {episode_index} 解析失败: {e}')
                if not urls:
                    diagnostics.append(f'线路节点 {road_index} 没有有效剧集，已跳过')
                    continue
                roads.append(Road(name=road_name or f'播放线路{len(roads) + 1}', data=urls, identifier=names))
            except ApiRuleFormatException:
                raise
            except Exception as e:
                diagnostics.append(f'线路节点 {road_index} 解析失败: {e}')
        return roads

    def _parse_delimited(self, document, config, root_variables, base_url, diagnostics):
        names_value = self._string_value(RestrictedJsonPath.read_first(document, config.get('roadNamesPath', '')))
        episodes_value = self._string_value(RestrictedJsonPath.read_first(document, config.get('roadEpisodesPath', '')))
        if not episodes_value:
            return []
        road_names = names_value.split(config.get('roadSeparator', '$$$'))
        road_groups = episodes_value.split(config.get('roadSeparator', '$$$'))
        roads = []
        for road_index, group in enumerate(road_groups):
            urls = []
            names = []
            entries = group.split(config.get('episodeSeparator', '#'))
            for episode_index, entry in enumerate(entries):
                entry = entry.strip()
                if not entry:
                    continue
                sep = config.get('fieldSeparator', '$')
                sep_index = entry.find(sep)
                if sep_index < 0:
                    diagnostics.append(f'线路 {road_index} 的剧集条目 {episode_index} 缺少字段分隔符，已跳过')
                    continue
                name = entry[:sep_index].strip()
                raw_url = entry[sep_index + len(sep):].strip()
                try:
                    page_url = self._resolve_episode_url(config, root_variables, raw_url=raw_url,
                                                         road_index=road_index, episode_index=episode_index,
                                                         base_url=base_url)
                    if not page_url:
                        diagnostics.append(f'线路 {road_index} 的剧集条目 {episode_index} 缺少 URL，已跳过')
                        continue
                    urls.append(page_url)
                    names.append(name or f'第{episode_index + 1}集')
                except ApiRuleFormatException:
                    raise
                except Exception as e:
                    diagnostics.append(f'线路 {road_index} 的剧集条目 {episode_index} 解析失败: {e}')
            if not urls:
                diagnostics.append(f'线路 {road_index} 没有有效剧集，已跳过')
                continue
            configured_name = road_names[road_index].strip() if road_index < len(road_names) else ''
            roads.append(Road(name=configured_name or f'播放线路{len(roads) + 1}', data=urls, identifier=names))
        return roads

    def _resolve_episode_url(self, config, root_variables, raw_url, road_index, episode_index, base_url):
        page = config.get('episodePage')
        if not page:
            return normalize_episode_url(base_url, raw_url)
        if not page.get('url', '').strip():
            raise ApiRuleFormatException('播放页地址模板不能为空')
        variables = {
            **root_variables,
            'episodeUrl': raw_url,
            'roadIndex': road_index,
            'roadNumber': road_index + 1,
            'episodeIndex': episode_index,
            'episodeNumber': episode_index + 1,
        }
        path = self._render_template(page['url'], variables, encode=True)
        parsed = urlparse(path)
        if not parsed.scheme:
            raise ApiRuleFormatException(f'剧集页面 URL 无效: {path}')
        rendered_query = self._render_map(page.get('query', {}), variables)
        merged_query = {**dict(parse_qsl(parsed.query)), **{k: str(v) for k, v in rendered_query.items()}}  # M-18：parsed.query 是字符串，dict() 直接展开必抛 ValueError（剧集全消失）
        from urllib.parse import urlencode
        query_str = urlencode(merged_query)
        return normalize_episode_url(base_url, parsed._replace(query=query_str).geturl())

    # ---------------------------------------------------------------- 模板渲染

    def _render_map(self, input_map, variables):
        return {self._render_template(str(k), variables): self._render_value(v, variables)
                for k, v in (input_map or {}).items()}

    def _render_value(self, value, variables):
        if isinstance(value, str):
            exact = re.match(r'^@([A-Za-z_][A-Za-z0-9_]*)$', value)
            if exact:
                name = exact.group(1)
                if name not in variables:
                    raise ApiRuleFormatException(f'缺少模板变量 @{name}')
                return variables[name]
            return self._render_template(value, variables)
        if isinstance(value, list):
            return [self._render_value(item, variables) for item in value]
        if isinstance(value, dict):
            return {k: self._render_value(v, variables) for k, v in value.items()}
        return value

    def _render_template(self, template, variables, encode=False):
        def repl(match):
            name = match.group(1)
            if name not in variables:
                raise ApiRuleFormatException(f'缺少模板变量 @{name}')
            value = str(variables[name] or '')
            return quote(value, safe='') if encode else value
        return re.sub(r'(?<![A-Za-z0-9_])@([A-Za-z_][A-Za-z0-9_]*)', repl, template)

    def _string_value(self, value):
        if value is None:
            return ''
        return value.strip() if isinstance(value, str) else str(value)
