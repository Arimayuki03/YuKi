# -*- coding: utf-8 -*-
"""Kazumi 规则引擎：搜索与剧集编排、HTTP 执行。

对齐 Kazumi lib/services/plugin/rule_engine.dart。
"""
import logging
from urllib.parse import urlparse

import requests
import http_client

from .models import RuleSearchTrace, RuleChapterTrace, PluginSearchResponse
from .xpath_strategy import XPathRuleStrategy
from .api_strategy import ApiRuleStrategy
from .utils import get_random_ua, SearchErrorException, ChapterErrorException, NoResultException, CaptchaRequiredException

logger = logging.getLogger('yuki.kazumi.engine')

# 手动跟重定向的跳数上限（对齐 http_client.fetch_follow_redirects 的 5 跳口径）
_MAX_RULE_REDIRECTS = 5


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
        # 持久化 Cookie（PluginCookieManager）：cookie_header 内部按规则 baseURL
        # 同域过滤（高危#10），第三方域名不会带走验证会话 Cookie
        if self.cookie_jar:
            ck = self.cookie_jar.cookie_header(request.url, base_url=config.base_url)
            if ck:
                headers.setdefault('cookie', ck)

        if cancel_token and cancel_token.is_set():
            raise requests.exceptions.RequestException('cancelled')

        if request.method == 'POST':
            if request.body_type == 'json':
                headers.setdefault('content-type', 'application/json')
                rsp = self._send_guarded('POST', request.url, config, cancel_token=cancel_token,
                                         headers=headers, params=request.query,
                                         json=request.body, timeout=10)
            else:
                headers.setdefault('content-type', 'application/x-www-form-urlencoded')
                rsp = self._send_guarded('POST', request.url, config, cancel_token=cancel_token,
                                         headers=headers, params=request.query,
                                         data=request.body, timeout=10)
        else:
            rsp = self._send_guarded('GET', request.url, config, cancel_token=cancel_token,
                                     headers=headers, params=request.query, timeout=10)
        rsp.encoding = 'utf-8'
        rsp.raise_for_status()
        return rsp.text

    def _send_guarded(self, method, url, config, cancel_token=None, **kw):
        """高危#9：规则请求过 SSRF 守卫并手动逐跳跟随重定向。

        规则（baseURL/searchURL/API url）来自第三方规则源，与远端 spider/JS 同级
        不可信：每一跳都过 `http_client._guard_hop(kind='site')`（对齐
        base/spider._guard_spider_url 的口径——trust_root 留空，无受信 origin）。
        requests 的自动跟重定向会在库内静默跳到任意 Location（公网规则源 302 到
        内网是教科书式 SSRF 通道），因此禁用并手动跟随，跳转目标以
        `trust_redirect=True` 复检（不继承任何信任）。
        查询参数在首跳守卫前拼进 URL，保证被校验的地址与实际发出的地址一致。
        单跳仍经 http_client.get/post（入参透传 requests；传输层含高危#12
        基础入口守卫钩子）。

        M-1（跨域凭据泄漏）：首跳 headers 里的 Cookie（验证会话）与 referer
        是为「规则的 base_url 同域」准备的；手动跟重定向时若原样带给跨域跳转
        目标，等于把登录态交给 Location 指向的任意第三方（绕过高危#10 的
        同域边界）。因此每一跳重新派生 Cookie
        （`cookie_jar.cookie_header(current_url, base_url=...)`，非同域自然为
        空）；跳转目标 host 与当前 host 不同源时删掉 referer——Location 是
        远端内容派生的地址，其 host 不构成 referrer 的正当来源。
        """
        params = kw.pop('params', None)
        if params:
            from urllib.parse import urlencode
            query_str = urlencode(params)
            url = f"{url}{'&' if '?' in url else '?'}{query_str}"
        headers = dict(kw.pop('headers', None) or {})
        from urllib.parse import urljoin
        current = http_client._guard_hop(url, kind='site')
        jar_cookie_active = False
        for _ in range(_MAX_RULE_REDIRECTS + 1):
            if cancel_token and cancel_token.is_set():
                raise requests.exceptions.RequestException('cancelled')
            # 每跳重派生 Cookie（M-1）：非 base_url 同域的跳转目标拿不到会话
            # Cookie。仅跟踪 jar 派生的值；规则自带的静态 cookie 头（如固定
            # token）不属于会话态，保持原行为不清理。
            if self.cookie_jar:
                ck = self.cookie_jar.cookie_header(current, base_url=config.base_url)
                if ck:
                    headers['cookie'] = ck
                    jar_cookie_active = True
                elif jar_cookie_active:
                    headers.pop('cookie', None)
                    jar_cookie_active = False
            kw['headers'] = dict(headers)
            rsp = (http_client.post(current, allow_redirects=False, **kw) if method == 'POST'
                   else http_client.get(current, allow_redirects=False, **kw))
            # status_code 取不到（兼容无状态码的响应替身）视为非 3xx，原样返回
            status = getattr(rsp, 'status_code', None)
            if rsp is None or status not in http_client._REDIRECT_STATUSES \
                    or 'Location' not in rsp.headers:
                return rsp
            try:
                rsp.close()
            except Exception:
                pass
            nxt = urljoin(current, rsp.headers.get('Location') or '')
            # 跨 host 跳转不带 referer（M-1）：首跳 referer 是规则 base_url 的
            # 标识，交给 Location 指向的第三方没有正当性
            if self._hop_host(nxt) != self._hop_host(current):
                headers.pop('referer', None)
            current = http_client._guard_hop(nxt, kind='site', trust_redirect=True)
        raise ValueError(f'too many redirects (>{_MAX_RULE_REDIRECTS}): {url}')

    @staticmethod
    def _hop_host(url):
        try:
            return (urlparse(url).hostname or '').lower()
        except Exception:
            return ''

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
