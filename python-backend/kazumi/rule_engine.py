# -*- coding: utf-8 -*-
"""Kazumi 规则引擎：搜索与剧集编排、HTTP 执行。

对齐 Kazumi lib/services/plugin/rule_engine.dart。
"""
import json
import logging
import threading

import requests

from .models import RuleExecutionConfig, RuleSearchTrace, RuleChapterTrace, PluginSearchResponse
from .xpath_strategy import XPathRuleStrategy
from .api_strategy import ApiRuleStrategy
from .utils import get_random_ua, SearchErrorException, ChapterErrorException, NoResultException, CaptchaRequiredException

logger = logging.getLogger('vpc.kazumi.engine')


class RuleEngine:
    """Kazumi 规则执行引擎。"""

    def __init__(self, log_failures=True, cookie_jar=None):
        self._xpath_strategy = XPathRuleStrategy()
        self._api_strategy = ApiRuleStrategy()
        self._log_failures = log_failures
        self.cookie_jar = cookie_jar  # CookieJar 实例（解析/验证会话持久化的 Cookie，见 cookie_jar.py）

    # ---------------------------------------------------------------- 搜索

    def search(self, config, keyword, cancel_token=None, filters=None):
        """执行规则搜索，返回 RuleSearchTrace。

        filters（任务三 part2，可选）：{'tag','year','sort'} 类型/年份/排序筛选值。
        规则通过在模板中引用占位符「opt-in」使用它们：
          - XPath 模式：searchURL 含 @tag/@year/@sort 才替换（不含则忽略，优雅降级）；
          - API 模式：request 的 url/query/body 引用 @tag/@year/@sort 才注入（未引用不影响）。
        不声明占位的规则原样只用 @keyword 搜索，对齐 Kazumi 仅传 keyword 的行为。"""
        filters = filters or {}
        try:
            if config.search_mode == 'api':
                variables = {'keyword': keyword}
                # 可选筛选变量：加入模板变量表；仅当规则 url/query/body 引用 @tag 等时才生效。
                for key in ('tag', 'year', 'sort'):
                    variables[key] = str(filters.get(key) or '')
                request = self._api_strategy.prepare_request(
                    config.search_api_config.get('request', {}),
                    variables,
                )
            else:
                request = self._xpath_strategy.prepare_search_request(config, keyword, filters)
        except Exception as e:
            self._log_failure(config, 'search request preparation', e)
            raise SearchErrorException(config.plugin_name, cause=e)

        raw = self._execute_request(request, config, phase='search request',
                                    wrap_error=lambda e: SearchErrorException(config.plugin_name, cause=e),
                                    cancel_token=cancel_token)
        try:
            if config.search_mode == 'api':
                parsed = self._api_strategy.parse_search(raw, config.search_api_config)
            else:
                parsed = self._xpath_strategy.parse_search(raw, config)
            if not parsed.items:
                raise NoResultException(config.plugin_name)
            self._log_diagnostics(config, 'search', parsed.diagnostics)
            return RuleSearchTrace(
                raw_response=raw,
                response=PluginSearchResponse(plugin_name=config.plugin_name, data=parsed.items),
                matched_fragments=parsed.matched_fragments,
                diagnostics=parsed.diagnostics,
            )
        except CaptchaRequiredException:
            raise
        except NoResultException:
            raise
        except Exception as e:
            self._log_failure(config, 'search response parsing', e)
            raise SearchErrorException(config.plugin_name, cause=e)

    # ---------------------------------------------------------------- 剧集

    def query_chapters(self, config, source, cancel_token=None):
        """解析剧集线路，返回 RuleChapterTrace。"""
        try:
            if config.chapter_mode == 'api':
                request = self._api_strategy.prepare_request(
                    config.chapter_api_config.get('request', {}),
                    {'source': source},
                )
            else:
                request = self._xpath_strategy.prepare_chapter_request(config, source)
        except Exception as e:
            self._log_failure(config, 'chapter request preparation', e)
            raise ChapterErrorException(config.plugin_name, cause=e)

        raw = self._execute_request(request, config, phase='chapter request',
                                    wrap_error=lambda e: ChapterErrorException(config.plugin_name, cause=e),
                                    cancel_token=cancel_token)
        try:
            if config.chapter_mode == 'api':
                parsed = self._api_strategy.parse_chapters(
                    raw, config.chapter_api_config, source=source, base_url=config.base_url)
            else:
                parsed = self._xpath_strategy.parse_chapters(raw, config)
            if not parsed.roads:
                raise ChapterErrorException(config.plugin_name)
            self._log_diagnostics(config, 'chapter', parsed.diagnostics)
            return RuleChapterTrace(
                raw_response=raw,
                roads=parsed.roads,
                diagnostics=parsed.diagnostics,
            )
        except ChapterErrorException:
            raise
        except Exception as e:
            self._log_failure(config, 'chapter response parsing', e)
            raise ChapterErrorException(config.plugin_name, cause=e)

    # ---------------------------------------------------------------- 验证码处理

    def search_with_captcha_retry(self, config, keyword, cancel_token=None, filters=None):
        """搜索，遇到验证码时返回需要验证的状态（由前端决定是否打开验证窗口）。"""
        try:
            return self.search(config, keyword, cancel_token, filters=filters)
        except CaptchaRequiredException as e:
            # 返回需要验证的状态与验证页 URL
            return {
                'captcha_required': True,
                'plugin_name': e.plugin_name,
                'captcha_url': config.search_url.replace('@keyword', keyword),
            }

    # ---------------------------------------------------------------- HTTP 执行

    def _execute_request(self, request, config, phase, wrap_error, cancel_token=None):
        try:
            return self._do_request(request, config, cancel_token)
        except Exception as e:
            self._log_failure(config, phase, e)
            raise wrap_error(e)

    def _do_request(self, request, config, cancel_token=None):
        headers = {
            'referer': f'{config.base_url}/',
            'user-agent': config.user_agent or get_random_ua(),
        }
        # 规则自定义 headers 覆盖（小写键名冲突时规则优先）
        for k, v in (request.headers or {}).items():
            headers[k.lower()] = v
        # 持久化 Cookie（PluginCookieManager）：解析/验证会话获取的 Cookie 自动带上
        if self.cookie_jar:
            ck = self.cookie_jar.cookie_header(request.url)
            if ck:
                headers.setdefault('cookie', ck)

        if cancel_token and cancel_token.is_set():
            raise requests.exceptions.RequestException('cancelled')

        if request.method == 'POST':
            if request.body_type == 'json':
                headers.setdefault('content-type', 'application/json')
                rsp = requests.post(request.url, headers=headers, params=request.query,
                                    json=request.body, timeout=10)
            else:
                headers.setdefault('content-type', 'application/x-www-form-urlencoded')
                rsp = requests.post(request.url, headers=headers, params=request.query,
                                    data=request.body, timeout=10)
        else:
            rsp = requests.get(request.url, headers=headers, params=request.query, timeout=10)
        rsp.encoding = 'utf-8'
        rsp.raise_for_status()
        return rsp.text

    # ---------------------------------------------------------------- 日志

    def _log_diagnostics(self, config, phase, diagnostics):
        if not self._log_failures or not diagnostics:
            return
        preview = '; '.join(diagnostics[:3])
        logger.warning('[%s] %s skipped %d node(s): %s', config.plugin_name, phase, len(diagnostics), preview)

    def _log_failure(self, config, phase, error):
        if not self._log_failures:
            return
        logger.warning('[%s] %s failed: %s', config.plugin_name, phase, error)
