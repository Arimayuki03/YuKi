# -*- coding: utf-8 -*-
"""Kazumi Cookie 持久化（对齐 Kazumi PluginCookieManager）。

解析/验证过程中浏览器会话（Electron 隐藏窗口 partition session）拿到的 Cookie，
由主进程经 kazumiCookieSet 推送落盘到 ~/.video-pc/kazumi/cookies.json，
规则引擎发请求时经 cookie_header() 自动带上，避免重启后需重新验证。

数据格式：{ domain: [{'name','value'}, ...] }（domain 小写，含父域匹配）。
线程安全：threading.Lock 保护读写。
"""
import json
import logging
import os
import threading
from urllib.parse import urlparse

import hoststate

logger = logging.getLogger('vpc.kazumi.cookie')


class CookieJar:
    def __init__(self, file_path=None):
        self._lock = threading.Lock()
        self._file = file_path or os.path.join(hoststate.get_data_dir(), 'kazumi', 'cookies.json')
        self._domains = {}
        self._load()

    def _load(self):
        with self._lock:
            try:
                if os.path.exists(self._file):
                    with open(self._file, encoding='utf-8') as f:
                        data = json.load(f)
                    if isinstance(data, dict):
                        self._domains = data
            except Exception as e:
                logger.warning('[kazumi] cookie load failed: %s', e)
                self._domains = {}

    def _save(self):
        with self._lock:
            try:
                os.makedirs(os.path.dirname(self._file), exist_ok=True)
                tmp = self._file + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(self._domains, f, ensure_ascii=False, indent=2)
                os.replace(tmp, self._file)
            except Exception as e:
                logger.warning('[kazumi] cookie save failed: %s', e)

    def set_domain_cookies(self, domain, cookies):
        """保存一个域名的 Cookie 列表（同名校覆盖）。cookies: [{'name','value'},...]。"""
        if not domain:
            return
        domain = str(domain).strip().lower().lstrip('.')
        if not domain:
            return
        merged = {}
        with self._lock:
            for c in self._domains.get(domain, []) or []:
                if c and c.get('name'):
                    merged[str(c['name'])] = {'name': str(c['name']), 'value': str(c.get('value') or '')}
            for c in cookies or []:
                if c and c.get('name') is not None:
                    merged[str(c['name'])] = {'name': str(c['name']), 'value': str(c.get('value') or '')}
            self._domains[domain] = list(merged.values())
        self._save()
        logger.info('[kazumi] cookies saved for %s: %d', domain, len(merged))

    def cookie_header(self, url):
        """按 URL 主机取匹配 Cookie（精确或父域），拼成 Cookie 头字符串；无则空串。"""
        try:
            host = (urlparse(url).hostname or '').lower()
        except Exception:
            return ''
        if not host:
            return ''
        parts = []
        with self._lock:
            for domain, cookies in self._domains.items():
                if not domain or not cookies:
                    continue
                if host == domain or host.endswith('.' + domain):
                    for c in cookies:
                        if c and c.get('value'):
                            parts.append(f"{c['name']}={c['value']}")
        return '; '.join(parts)

    def has_cookies(self):
        with self._lock:
            return any(bool(v) for v in self._domains.values())

    def list_all(self):
        with self._lock:
            return {d: list(c) for d, c in self._domains.items() if c}

    def clear(self):
        with self._lock:
            self._domains = {}
        self._save()
        logger.info('[kazumi] cookies cleared')
