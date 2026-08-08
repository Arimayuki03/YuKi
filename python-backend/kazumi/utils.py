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
