# -*- coding: utf-8 -*-
"""Kazumi 规则引擎工具函数与异常定义。"""
import random
import re
from urllib.parse import urljoin, urlparse, urlunparse


class KazumiError(Exception):
    """Kazumi 规则引擎基础异常。"""
    pass


class XPathRuleFormatException(KazumiError):
    """XPath 规则格式错误。"""
    def __init__(self, message, kind='', field='', expression='', cause=None):
        super().__init__(message)
        self.kind = kind
        self.field = field
        self.expression = expression
        self.cause = cause


class ApiRuleFormatException(KazumiError):
    """API 规则格式错误。"""
    pass


class CaptchaRequiredException(KazumiError):
    """需要验证码验证。"""
    def __init__(self, plugin_name):
        super().__init__(f'{plugin_name} requires captcha verification')
        self.plugin_name = plugin_name


class NoResultException(KazumiError):
    """搜索无结果。"""
    def __init__(self, plugin_name):
        super().__init__(f'{plugin_name} returned no search results')
        self.plugin_name = plugin_name


class BgmFieldError(KazumiError):
    """Bangumi 评分/吐槽字段校验失败（rate 超出 0-10 / comment 超长等）。

    dispatch 层未捕获时按既有兜底转 500，但 rate/comment 的调用方
    （bangumi_apply_sync_plan）会显式捕获并归一为 400 语义的单条失败结果。"""
    def __init__(self, message, field=''):
        super().__init__(message)
        self.field = field


class SearchErrorException(KazumiError):
    """搜索执行错误。"""
    def __init__(self, plugin_name, cause=None):
        msg = f'{plugin_name} search failed'
        if cause:
            msg += f' ({cause})'
        super().__init__(msg)
        self.plugin_name = plugin_name
        self.cause = cause


class ChapterErrorException(KazumiError):
    """剧集解析错误。"""
    def __init__(self, plugin_name, cause=None):
        msg = f'{plugin_name} chapter query failed'
        if cause:
            msg += f' ({cause})'
        super().__init__(msg)
        self.plugin_name = plugin_name
        self.cause = cause


# 随机 UA 池（对齐 Kazumi 行为：规则未指定 UA 时随机取一个）
RANDOM_UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
]


def get_random_ua():
    return random.choice(RANDOM_UA_POOL)


def normalize_episode_url(base_url, raw):
    """集数源站 URL 归一化（完全对齐 Kazumi Dart 实现）。

    规则：
    1. 去除首尾空白；空输入返回空串。
    2. 已是绝对 URL（有 scheme+host）→ 保留。
    3. 相对路径 → 用 urljoin(base_url, raw) 补全。
    4. 同站（同 host+port）且 scheme 不同 → 统一到 base_url 的 scheme。
    5. 去除 path 多余尾斜杠（根路径保留）。
    6. 去除空 query。
    7. 幂等。
    """
    trimmed = raw.strip()
    if not trimmed:
        return ''

    base_url = (base_url or '').strip()
    has_valid_base = bool(base_url)
    if has_valid_base:
        try:
            parsed_base = urlparse(base_url)
            has_valid_base = bool(parsed_base.scheme and parsed_base.netloc)
        except Exception:
            has_valid_base = False

    # 已是绝对 URL
    try:
        parsed_raw = urlparse(trimmed)
        if parsed_raw.scheme and parsed_raw.netloc:
            resolved = parsed_raw
        elif has_valid_base:
            resolved = urlparse(urljoin(base_url, trimmed))
        else:
            return trimmed
    except Exception:
        return trimmed

    if not resolved.netloc:
        return trimmed

    # 同站协议统一
    if has_valid_base:
        try:
            parsed_base = urlparse(base_url)
            if (parsed_base.scheme in ('http', 'https')
                    and resolved.scheme in ('http', 'https')
                    and resolved.scheme != parsed_base.scheme
                    and resolved.netloc == parsed_base.netloc):
                resolved = resolved._replace(scheme=parsed_base.scheme)
        except Exception:
            pass

    # 去 path 尾斜杠（根路径保留）
    path = resolved.path
    while len(path) > 1 and path.endswith('/'):
        path = path[:-1]

    # 去空 query
    query = resolved.query if resolved.query else ''

    return urlunparse((resolved.scheme, resolved.netloc, path, resolved.params, query, resolved.fragment))


def is_http_url(url):
    return bool(re.match(r'^https?://', url, re.I))


# ---------------------------------------------------------------- 图片验证码检测（animeko WebCaptchaDetector 思路移植）

# 已知图片验证码 URL/页面特征词（规则宁可漏报不误报：命中才触发自动识别）。
# 词表覆盖常见站点命名：captcha.php / CheckCode.aspx / imgcode.asp / vcode 等；
# 子词匹配（如 imageVerify.php）也算命中——误报代价仅一次无谓识别尝试，可接受。
_CAPTCHA_WORD_RE = re.compile(
    r'captcha|verify|rand_code|code_img|imgcode|checkcode|seccode|vcode', re.I)


def looks_like_image_captcha_url(url):
    """URL 启发式判定是否为图片验证码地址（animeko WebCaptchaDetector 的 URL 规则位）。

    只做「便宜预判」（animeko CaptchaSolver.canAttempt 的定位）：命中特征词才认为是
    验证码图，误报代价仅一次无谓识别，漏报代价是退回手动输入——两向都安全。"""
    u = str(url or '')
    return bool(re.match(r'^https?://', u, re.I)) and bool(_CAPTCHA_WORD_RE.search(u))


def detect_image_captcha_html(html):
    """HTML 启发式检测图片验证码（对齐 animeko WebCaptchaDetector.detect 的分类器定位）。

    预留接口：当前 kazumi 主链路仅消费 looks_like_image_captcha_url（本函数
    仍被测试引用，行为不变）。返回 True 表示页面疑似包含需 OCR 的图片验证码
    输入（<img> 引用验证码地址 + 单字符短输入框特征）。仅决定 UI 文案与是否
    自动拉取识别，判错代价低。"""
    h = str(html or '')
    if not h or not _CAPTCHA_WORD_RE.search(h):
        return False
    # 特征组合：验证码 img 标签 + 短输入框（maxlength<=6）同页出现
    has_captcha_img = bool(re.search(
        r'<img[^>]+(?:captcha|verify|rand_code|imgcode|checkcode|seccode|vcode)', h, re.I))
    has_short_input = bool(re.search(r'<input[^>]+maxlength\s*=\s*["\']?[1-6]\b', h, re.I))
    return has_captcha_img and has_short_input
