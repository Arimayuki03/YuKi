# -*- coding: utf-8 -*-
"""Kazumi 规则引擎：搜索与剧集编排、HTTP 执行。

对齐 Kazumi lib/services/plugin/rule_engine.dart。
"""
import logging
import threading
import time
from urllib.parse import urlparse

import requests
import http_client

from .models import RuleSearchTrace, RuleChapterTrace, PluginSearchResponse
from .xpath_strategy import XPathRuleStrategy
from .api_strategy import ApiRuleStrategy
from .utils import (get_random_ua, SearchErrorException, ChapterErrorException,
                    NoResultException, CaptchaRequiredException,
                    looks_like_image_captcha_url)
from . import captcha as _captcha_mod

logger = logging.getLogger('yuki.kazumi.engine')

# 手动跟重定向的跳数上限（对齐 http_client.fetch_follow_redirects 的 5 跳口径）
_MAX_RULE_REDIRECTS = 5

# 域名 → 最近一次验证码自动解题成功的时间（monotonic 秒）。
# solve 成功后前端立即重搜会撞站点搜索频率限制（提示页无结果节点，表现为
# NoResultException）——search_with_captcha_retry 据此对刚验证的源做一次
# 隔 3.5s 的短重试（进程内即可，重启后 Cookie 已有效、频率窗口早过）。
_RECENT_SOLVED = {}

# 域名 → 最后一次请求时刻（monotonic）：solve 与搜索共用节流（_throttle_site），
# 保证验证通过返回前端时距上次站点请求 ≥3.6s，避开「搜索间隔 3 秒」风控窗。
_SITE_LAST_REQUEST = {}

# _throttle_site 的锁：「读 last / 算 wait / 预占名额」必须原子，否则并发搜索
# 同一域时双双通过间隔检查（check-then-act 竞态）。sleep 刻意放锁外——
# 长达 min_gap 的等待不能持有锁阻塞其他域的节流。
_THROTTLE_LOCK = threading.Lock()


# 验证码取图门禁（_looks_like_image）的图片魔数白名单。MacCMS/ThinkPHP
# verify 端点的输出格式由站点 GD/Imagick 配置决定，PNG 之外 JPEG/GIF/WebP
# 同样常见——此前只认 PNG 魔数，非 PNG 源会把 3 轮重试全烧在
# image_fetch_failed 上、永不进 OCR（下层 ddddocr/小模型链路本就支持多格式）。
_IMAGE_MAGIC_PREFIXES = (
    b'\x89PNG\r\n\x1a\n',  # PNG
    b'\xff\xd8\xff',        # JPEG（SOI 起始）
    b'GIF87a',              # GIF 87a
    b'GIF89a',              # GIF 89a
)


def _looks_like_image(content):
    """响应体是否为图片（前导魔数白名单），solve_captcha 取图门禁用。

    WebP 无固定前导魔数（RIFF 容器）：以 'RIFF' + bytes[8:12]=='WEBP' 判定。
    以 '<' 开头（<!DOCTYPE / <html 等）是 HTML 拦截页，绝不当作图片——保留
    原有「取到 HTML → 换图重试」的拒绝路径。空内容同样拒绝。"""
    if not content or content[:1] == b'<':
        return False
    if content.startswith(_IMAGE_MAGIC_PREFIXES):
        return True
    return content[:4] == b'RIFF' and content[8:12] == b'WEBP'


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
        except CaptchaRequiredException:
            raise  # 章节页验证码拦截：透传给端点转结构化状态（前端自动解题）
        except ChapterErrorException:
            raise
        except Exception as e:
            self._log_failure(config, 'chapter response parsing', e)
            raise ChapterErrorException(config.plugin_name, cause=e)

    # ---------------------------------------------------------------- 验证码处理

    def search_with_captcha_retry(self, config, keyword, cancel_token=None, filters=None,
                                  llm_cfg=None):
        """搜索，遇到验证码时返回需要验证的状态（由前端决定是否打开验证窗口）。

        验证码 payload 只携带纯计算字段，零额外网络请求（本结果经 SSE 逐源
        推送，对单源延迟敏感，验证码兜底不允许拖慢主链路）：
          - captcha_url：触发验证码的搜索页地址（前端打开验证窗口用，唯一
            被渲染层消费的字段）；
          - captcha_url_classified：URL 启发式分类结果（utils.looks_like_image_captcha_url，
            对齐 animeko WebCaptchaDetector「纯分类器」定位——只决定 UI 文案，
            判错代价低，宁可漏报不误报）；
          - ocr_available：后端是否具备图片验证码自动识别能力（captcha.ocr_available；
            tiny-CNN 权重缺失且视觉 LLM 未配置时为 False）。
        验证码图片地址（规则 captchaImage XPath 解析）不在本路径自动抓取：
        消费方出现时按需调用 _captcha_image_url。

        llm_cfg 透传 ocr_available 探测（视觉 LLM 已配置时前端「⚡可自动」
        提示更准确；本方法自身不发 LLM 请求）。"""
        def _captcha_payload(exc):
            """组装验证码结构化 payload（外层 except 与 NoResult 重试分支共用，
            见下方重试分支——server.py 只消费 dict，异常绝不能逃逸本函数）。"""
            page_url = config.search_url.replace('@keyword', keyword)
            classified = looks_like_image_captcha_url(page_url)
            return {
                'captcha_required': True,
                'plugin_name': exc.plugin_name,
                'captcha_url': page_url,
                'captcha_url_classified': classified,
                'ocr_available': _captcha_mod.ocr_available(llm_cfg),
            }

        try:
            return self.search(config, keyword, cancel_token, filters=filters)
        except CaptchaRequiredException as e:
            return _captcha_payload(e)
        except NoResultException:
            # 验证刚通过的源：solve 成功后前端立即重搜，会撞站点的搜索频率
            # 限制（如 2kdm 系「搜索时间间隔为3秒」——提示页无结果节点，表现
            # 为 NoResultException，2026-09-29 日志+浏览器双重复盘实证）。对
            # 该域做一次隔 4s 的短重试；未验证过的源不重试（真无结果不该被
            # 拖慢）。重试前先过节流（距上次请求 <4s 则补齐）。
            if self.cookie_jar and self.cookie_jar.has_cookies() \
                    and self._recently_solved(config):
                if not (cancel_token and cancel_token.is_set()):
                    self._throttle_site(config.base_url, min_gap=4.0)
                    try:
                        return self.search(config, keyword, cancel_token, filters=filters)
                    except CaptchaRequiredException as e:
                        # 重试又撞验证码：说明新会话也失效了。返回结构化
                        # payload 让前端再走解题流程，而不是让异常逃逸出
                        # 本方法破坏「遇验证码返回 dict」契约。
                        return _captcha_payload(e)
            raise

    def captcha_ocr_available(self, llm_cfg=None):
        """验证码自动识别能力探测（供端点组装 payload；懒加载封装在此，
        避免调用方直接 import captcha 模块）。llm_cfg 供 LLM 级探测
        （未配置时只探测 tiny-CNN）。"""
        return _captcha_mod.ocr_available(llm_cfg)

    def _recently_solved(self, config, ttl=60):
        """该源域名是否在 ttl 秒内刚完成验证码自动解题（频率窗口重试的门槛）。"""
        key = (urlparse(config.base_url or '').hostname or '').lower()
        if not key:
            return False
        now = time.monotonic()
        solved = _RECENT_SOLVED.get(key)
        if solved and now - solved <= ttl:
            return True
        if solved:
            _RECENT_SOLVED.pop(key, None)
        return False

    def _captcha_image_url(self, config, cancel_token=None):
        """从规则反爬配置提取验证码图片地址（captchaImage XPath 首个节点 / <img> src）。

        独立成方法便于测试桩替换；任何解析失败返回 ''（展示兜底是可选信息，
        绝不让它把验证码处理主链路带崩）。仅在消费方需要展示验证码图时按需
        调用，不在任何请求主路径上自动触发。

        抓取必须走 _send_guarded 而非裸 http_client.get：captchaImage 抓的页面
        地址由规则派生，与搜索主链路同级不可信——逐跳 SSRF 守卫
        （_guard_hop(kind='site')）+ 禁用自动跟重定向（公网规则源 302 到内网
        是教科书式 SSRF 通道）；会话 Cookie 亦由 cookie_jar 按 base_url 同域
        派生，与验证会话保持一致。"""
        try:
            anti = getattr(config, 'anti_crawler_config', None) or {}
            expr = (anti.get('captchaImage') or '').strip()
            if not expr:
                return ''
            from urllib.parse import urljoin, urlparse, urlunparse
            page_url = config.search_url.replace('@keyword', '')
            rsp = self._send_guarded(
                'GET', page_url, config, cancel_token=cancel_token,
                headers={'referer': f'{config.base_url}/', 'user-agent': get_random_ua()},
                timeout=(5, 8), verify=True)
            status = getattr(rsp, 'status_code', None)
            # status_code 取不到（兼容无状态码的响应替身）视为成功，对齐 _send_guarded 口径
            if status is not None and status != 200:
                return ''
            html = rsp.text or ''
            sel = self._xpath_strategy  # 复用其 HTML 文档解析
            root = sel._document_element(html)
            nodes = root.xpath(expr)
            if not nodes:
                return ''
            node = nodes[0]
            src = ''
            if hasattr(node, 'get'):
                src = node.get('src') or node.get('data-src') or ''
            else:
                src = str(node)
            src = src.strip()
            if not src:
                return ''
            # 相对路径绝对化（对齐 utils.normalize_episode_url 的归一思想）
            absu = urljoin(page_url, src)
            p = urlparse(absu)
            if p.scheme not in ('http', 'https') or not p.netloc:
                return ''
            return urlunparse((p.scheme, p.netloc, p.path, p.params, p.query, ''))
        except Exception:
            return ''

    # ---------------------------------------------------------------- 验证码自动解题

    # MacCMS 系验证码交互的常见端点形态（相对 base_url）：
    #   图片：/index.php/verify/index.html（刷新会话内的验证码）
    #   提交：/index.php/ajax/verify_check（POST 表单 type=search&verify=<码>，
    #         与站点 JS 的 MAC.Ajax 'post' 口径一致；响应 code==1 为通过）
    # 规则未声明 captchaImage XPath 时按该约定探测；声明了则优先规则。
    _MACCMS_VERIFY_IMAGE = '/index.php/verify/index.html'
    _MACCMS_VERIFY_CHECK = '/index.php/ajax/verify_check'

    def solve_captcha(self, config, cancel_token=None, max_attempts=3, llm_cfg=None,
                      prefer_llm=False):
        """图片验证码自动解题：建会话 → 取图 → OCR 识别 → 表单提交 → 复验。

        独立动作端点（/kazumi/action?do=kazumiCaptchaSolve）专用，绝不挂在
        搜索主链路上——主链路 payload 契约保持零网络请求。识别失败/提交后
        仍检出验证码即换一张图重试，共 ≤ max_attempts 轮，仍失败返回
        {'ok': False}，由前端回落人工验证窗口（该路径始终可用）。

        会话机制（2026-09-29 修复，三源全败的根因）：验证码答案由站点记在
        「发图那次请求的会话」里，取图与提交必须共享同一 PHPSESSID。进程
        共享 Session 挂 _NoStoreCookiePolicy（禁 Cookie 落地），原实现每次
        请求都是陌生会话——答案永远对不上，必败。故这里建独立
        requests.Session 存会话 Cookie：先请求搜索页建会话（站点同时把
        验证码答案绑到该会话），再取图/提交/复验。

        每跳仍过 http_client._guard_hop（kind='site'，与 _send_guarded 同
        一 SSRF 守卫口径；规则派生地址同级不可信）。成功时验证会话 Cookie
        显式落盘 cookie_jar（重启后免重验，与人工窗口同一生效链路）。
        """
        from urllib.parse import urljoin
        base = (config.base_url or '').rstrip('/')
        if not base:
            return {'ok': False, 'reason': 'no_base_url'}
        anti = getattr(config, 'anti_crawler_config', None) or {}
        has_rule_image = bool((anti.get('captchaImage') or '').strip())
        ua = config.user_agent or get_random_ua()
        referer = f'{base}/'
        page_url = config.search_url.replace('@keyword', '')

        sess = requests.Session()
        sess.trust_env = False  # 代理不走 trust_env 环境变量，显式解析见下
        headers = {'referer': referer, 'user-agent': ua}
        # C1：验证会话不走 trust_env——代理经 http_client.system_proxies 显式
        # 解析（优先环境变量=应用内「代理设置」主进程注入，其次 WinINET 系统代理
        # 注册表），与 _send/get/post 主链路同一口径。否则依赖代理的用户主搜索
        # 正常而 solve 的独立会话直连失败，永远 session_init_failed。
        proxies = http_client.system_proxies(base) or None
        # C2（2026-10-01）：代理连接失败自动回退直连——与主链路 _request 的
        # ProxyError→直连重试兜底同口径（http_client「代理连接失败自动回退直连」）。
        # 实证场景：代理软件退出但 WinINET/环境变量残留 127.0.0.1:7897，主搜索
        # 靠主链路兜底直连 200，solve 却因独立会话无此兜底而 session_init_failed，
        # 自动解题白丢给人工窗口。回退发生在请求层：单次请求 ProxyError 且配了
        # 代理时去代理重发一次；回退是会话级的（代理真挂了每跳都会失败，逐次
        # 重试只会双倍慢），后续请求直接裸连。代理在重试间隙恢复的场景：下次
        # solve 重新解析，不在此处理。
        proxies_failed = [False]  # 闭包可变标志：requests 层能否直连回退

        def _site_request(method, url, **kw):
            """独立会话单次请求 + 代理失败直连回退（口径同主链路 _request）。"""
            use_proxies = None if proxies_failed[0] else proxies
            try:
                return sess.request(method, url, proxies=use_proxies, **kw)
            except requests.exceptions.ProxyError:
                if not proxies:
                    raise
                proxies_failed[0] = True
                logger.info('[%s] 验证会话代理不可达，本次 solve 回退直连', config.plugin_name)
                return sess.request(method, url, proxies=None, **kw)

        def _guarded_get(url, extra_headers=None, timeout=(5, 10)):
            """独立会话 GET，每跳过 SSRF 守卫（手动跟重定向，口径同 _send_guarded）。

            发出前过 _throttle_site：solve 过程的请求同样计入站点频率窗，
            不节流会让复验/后续搜索连锁撞「搜索间隔 3 秒」提示页。"""
            from urllib.parse import urljoin as _urljoin
            current = http_client._guard_hop(url, kind='site')
            current_headers = {**headers, **(extra_headers or {})}
            for _ in range(_MAX_RULE_REDIRECTS + 1):
                if cancel_token and cancel_token.is_set():
                    raise requests.exceptions.RequestException('cancelled')
                self._throttle_site(base, min_gap=1.2)
                rsp = _site_request('GET', current, headers=dict(current_headers),
                                    timeout=timeout,
                                    allow_redirects=False, verify=True)
                status = getattr(rsp, 'status_code', None)
                if status not in http_client._REDIRECT_STATUSES or 'Location' not in rsp.headers:
                    return rsp
                rsp.close()
                nxt = _urljoin(current, rsp.headers.get('Location') or '')
                # 跨 host 跳转不带 referer（M-1，口径同 _send_guarded）：首跳
                # referer 是规则 base_url 的标识，交给 Location 指向的第三方
                # 没有正当性。对当跳 headers 副本操作，不污染外层 headers。
                if self._hop_host(nxt) != self._hop_host(current):
                    current_headers.pop('referer', None)
                current = http_client._guard_hop(nxt, kind='site', trust_redirect=True)
            raise ValueError(f'too many redirects (>{_MAX_RULE_REDIRECTS}): {url}')

        def _guarded_post(url, data, extra_headers=None, timeout=(5, 10)):
            """独立会话 POST（verify_check 表单），守卫口径同 _guarded_get。"""
            from urllib.parse import urljoin as _urljoin
            current = http_client._guard_hop(url, kind='site')
            current_headers = {**headers, **(extra_headers or {})}
            for _ in range(_MAX_RULE_REDIRECTS + 1):
                if cancel_token and cancel_token.is_set():
                    raise requests.exceptions.RequestException('cancelled')
                self._throttle_site(base, min_gap=1.2)
                rsp = _site_request('POST', current, data=data,
                                    headers=dict(current_headers), timeout=timeout,
                                    allow_redirects=False, verify=True)
                status = getattr(rsp, 'status_code', None)
                if status not in http_client._REDIRECT_STATUSES or 'Location' not in rsp.headers:
                    return rsp
                rsp.close()
                nxt = _urljoin(current, rsp.headers.get('Location') or '')
                # 跨 host 跳转不带 referer（M-1，口径同 _guarded_get/_send_guarded）
                if self._hop_host(nxt) != self._hop_host(current):
                    current_headers.pop('referer', None)
                current = http_client._guard_hop(nxt, kind='site', trust_redirect=True)
            raise ValueError(f'too many redirects (>{_MAX_RULE_REDIRECTS}): {url}')

        # 0) 建会话：先请求搜索页，站点 Set-Cookie 会话并预绑定验证码状态
        try:
            # 会话生命周期收口：失败路径（session_init_failed /
            # image_fetch_failed / 取消 / 异常）此前直接 return，连接池里的
            # TCP 连接要等 GC 或服务端超时才释放。自动解题在多个源上会
            # 连续触发，连接会累积——finally 统一 close。
            try:
                _guarded_get(page_url)
            except requests.exceptions.RequestException as e:
                # 取消以 RequestException('cancelled') 传播，保持 cancelled 语义
                if cancel_token and cancel_token.is_set():
                    return {'ok': False, 'reason': 'cancelled'}
                logger.warning('[%s] 验证会话建立失败: %s', config.plugin_name, e)
                return {'ok': False, 'reason': 'session_init_failed'}
            except Exception as e:
                logger.warning('[%s] 验证会话建立失败: %s', config.plugin_name, e)
                return {'ok': False, 'reason': 'session_init_failed'}

            for attempt in range(1, max_attempts + 1):
                if cancel_token and cancel_token.is_set():
                    return {'ok': False, 'reason': 'cancelled'}
                # 1) 取图：规则声明 captchaImage 时从验证页解析（与人工窗口同源），
                #    否则按 MacCMS 约定端点直取
                image_url = ''
                if has_rule_image:
                    image_url = self._captcha_image_url(config, cancel_token=cancel_token)
                if not image_url:
                    image_url = urljoin(base, self._MACCMS_VERIFY_IMAGE)
                try:
                    rsp = _guarded_get(image_url)
                    status = getattr(rsp, 'status_code', None)
                    content = rsp.content or b''
                    # 取到 HTML（跳回验证页/拦截页）说明图端点不可用，直接换图重试；
                    # 非图片内容同样处理——魔数白名单见 _looks_like_image（PNG/JPEG/
                    # GIF/WebP，此前只认 PNG 会把 GIF/JPEG/WebP 源全烧成 image_fetch_failed）
                    if (status is not None and status != 200) or not _looks_like_image(content):
                        if attempt == max_attempts:
                            return {'ok': False, 'reason': 'image_fetch_failed', 'attempts': attempt}
                        continue
                except ValueError as e:
                    logger.warning('[%s] 验证码取图重定向异常: %s', config.plugin_name, e)
                    return {'ok': False, 'reason': 'image_fetch_failed', 'attempts': attempt}
                except Exception as e:
                    logger.warning('[%s] 验证码取图失败: %s', config.plugin_name, e)
                    return {'ok': False, 'reason': 'image_fetch_failed', 'attempts': attempt}

                # 2) OCR 识别（两级链，失败换图重试）。llm_cfg 按次透传给
                #    第二级视觉 LLM 识别（未配置时该级静默跳过）。
                #    prefer_llm=True 时两级次序倒置（先 LLM 后小模型）——
                #    详见 kazumi/captcha.py recognize_captcha_bytes。
                code = _captcha_mod.recognize_captcha_bytes(
                    content, llm_cfg=llm_cfg, prefer_llm=prefer_llm)
                if not code:
                    continue

                # 3) 提交：MacCMS verify_check 用 POST 表单（与站点 JS 提交一致，
                #    GET 同端点不被接受）。响应体 code==1 才是真成功——code:1002
                #    「验证码错误」也回 200。**不能**以"复验页不再检出验证码"作为
                #    成功标准：答案错误时站点把搜索页替换成「请勿频繁操作」提示页，
                #    该页无 captchaImage 节点，会被检测器误判为放行（2026-09-29
                #    三源全败复盘实证），必须逐次校验提交响应。
                check_url = urljoin(base, self._MACCMS_VERIFY_CHECK)
                try:
                    check_rsp = _guarded_post(check_url, {'type': 'search', 'verify': code},
                                              {'x-requested-with': 'XMLHttpRequest'})
                except Exception as e:
                    logger.warning('[%s] 验证码提交失败: %s', config.plugin_name, e)
                    continue
                check_ok = False
                try:
                    import json as _json
                    check_body = _json.loads((check_rsp.text or '').strip() or '{}')
                    check_ok = check_body.get('code') == 1
                except Exception:
                    check_ok = False
                if not check_ok:
                    logger.info('[%s] 验证码答案被拒（第 %d 轮，换图重试）',
                                config.plugin_name, attempt)
                    continue

                # 4) 复验：提交已确认成功，再请求搜索页确认验证码态解除。
                #    频率提示页（「请不要频繁操作」）等 2s 重试一次，绝不把
                #    提示页误判为放行——只认验证码态消失。
                try:
                    rsp = _guarded_get(page_url)
                    html = rsp.text or ''
                    if '请不要频繁操作' in html or '搜索时间间隔' in html:
                        time.sleep(2.5)
                        rsp = _guarded_get(page_url)
                        html = rsp.text or ''
                except Exception as e:
                    logger.warning('[%s] 验证码复验失败: %s', config.plugin_name, e)
                    return {'ok': False, 'reason': 'recheck_failed', 'attempts': attempt}
                detected = self._xpath_strategy._detects_captcha(
                    html, anti, self._xpath_strategy._document_element(html))
                if not detected:
                    self._persist_session_cookies(base, sess)
                    _RECENT_SOLVED[(urlparse(base).hostname or '').lower()] = time.monotonic()
                    # 预留频率冷却窗：solve 过程的取图/提交/复验密集请求会吃掉
                    # 站点「搜索间隔 N 秒」的窗口（2kdm 系 3s，提示页算一次搜索）。
                    # 前端拿到 ok 后立即重搜，不预留就会撞提示页 → no result →
                    # 源被前端折叠成"消失"（2026-09-29 浏览器实测：验证态本身
                    # 正常，连发第二次必撞提示页）。max(0, 3.6 - 距上次请求)。
                    self._throttle_site(base, min_gap=3.6)
                    return {'ok': True, 'code': code, 'attempts': attempt}
            return {'ok': False, 'reason': 'max_attempts', 'attempts': max_attempts}
        finally:
            try:
                sess.close()
            except Exception:
                pass

    def _throttle_site(self, base_url, min_gap=3.6):
        """站点搜索频率冷却：距该域上次请求不足 min_gap 秒时 sleep 补齐。

        solve/搜索共用（按域名记录最后请求时刻）；误差 ±0.1s。
        并发口径（修复 check-then-act 竞态）：「读 last → 算 wait → 登记
        发送时刻」在 _THROTTLE_LOCK 内原子完成，同域并发调用不再双双通过
        间隔检查；sleep 刻意放锁外——min_gap 级的等待不能持锁阻塞其他域。
        登记值为本次请求的（预定）发送时刻：需等待者先登记 now+wait 再在
        锁外补睡，后到者据此排到 min_gap 之后，语义与逐次记录发送时刻一致。"""
        key = (urlparse(base_url).hostname or '').lower()
        if not key:
            return
        with _THROTTLE_LOCK:
            now = time.monotonic()
            last = _SITE_LAST_REQUEST.get(key)
            wait = min_gap - (now - last) if last else 0
            # 名额预占：>0.1s 容差外的等待把预定发送时刻（now+wait）登记进
            # 表，锁外补睡期间同域并发调用看到的已是占用态；≤0.1s 直接放行。
            _SITE_LAST_REQUEST[key] = now + wait if wait > 0.1 else now
        if wait > 0.1:
            time.sleep(wait)

    def _persist_session_cookies(self, base_url, session=None):
        """把验证会话 Cookie 落盘 cookie_jar（与人工窗口同一生效链路）。

        solve_captcha 用独立 requests.Session 持有验证会话（PHPSESSID 等），
        成功后从这里显式收割落盘；session 缺席时回退收割共享 Session
        （历史口径，兜底无独立会话的调用方）。重启后由 cookie_header 同域
        派生生效，免重复验证。"""
        if not self.cookie_jar:
            return
        try:
            from urllib.parse import urlparse as _urlparse
            domain = (_urlparse(base_url).hostname or '').lower()
            if not domain:
                return
            cookies = []
            jar = session.cookies if session is not None else http_client.get_session().cookies
            for c in jar:
                c_domain = (getattr(c, 'domain', '') or '').lstrip('.')
                if domain == c_domain or domain.endswith('.' + c_domain) \
                        or c_domain.endswith('.' + domain):
                    cookies.append({'name': c.name, 'value': c.value, 'domain': c_domain})
            if cookies:
                self.cookie_jar.set_domain_cookies(domain, cookies)
        except Exception as e:
            logger.warning('[kazumi] 验证会话 Cookie 落盘失败（不影响验证结果）: %s', e)

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
