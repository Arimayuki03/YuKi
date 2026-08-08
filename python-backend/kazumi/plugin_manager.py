# -*- coding: utf-8 -*-
"""Kazumi 规则管理器：规则 CRUD、持久化、启用/禁用。

持久化：~/.video-pc/kazumi/plugins.json（单文件存储全部规则）。
线程安全：threading.Lock 保护规则列表读写。
"""
import json
import logging
import os
import shutil
import threading

import hoststate

from .plugin import Plugin

logger = logging.getLogger('vpc.kazumi.manager')

# 内置默认规则目录（随应用打包，首次启动自动导入）
_BUILTIN_RULES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')

# Bangumi API 端点（对齐 Kazumi api_endpoints.dart）
BANGUMI_API = 'https://api.bgm.tv'
BANGUMI_API_NEXT = 'https://next.bgm.tv'
BANGUMI_MIRROR = 'https://api.kazumi.fyi'


class PluginManager:
    """Kazumi 规则 CRUD 与持久化。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._plugins = []  # list[Plugin]
        self._file = os.path.join(hoststate.get_data_dir(), 'kazumi', 'plugins.json')
        self._load()
        self._import_builtin_rules()

    # ---------------------------------------------------------------- 内置规则

    def _import_builtin_rules(self):
        """首次启动（plugins.json 不存在）时自动导入内置默认规则。"""
        if os.path.exists(self._file):
            return  # 已有用户规则，不覆盖
        if not os.path.isdir(_BUILTIN_RULES_DIR):
            return
        imported = 0
        for fn in os.listdir(_BUILTIN_RULES_DIR):
            if not fn.endswith('.json'):
                continue
            path = os.path.join(_BUILTIN_RULES_DIR, fn)
            try:
                with open(path, encoding='utf-8') as f:
                    plugin = Plugin.from_json(json.load(f))
                err = plugin.validate()
                if err:
                    logger.warning('[kazumi] builtin rule %s invalid: %s', fn, err)
                    continue
                self._plugins.append(plugin)
                imported += 1
            except Exception as e:
                logger.warning('[kazumi] builtin rule %s load failed: %s', fn, e)
        if imported:
            self._save()
            logger.info('[kazumi] imported %d builtin rules', imported)

    # ---------------------------------------------------------------- 持久化

    def _load(self):
        with self._lock:
            try:
                if not os.path.exists(self._file):
                    self._plugins = []
                    return
                with open(self._file, encoding='utf-8') as f:
                    data = json.load(f)
                self._plugins = [Plugin.from_json(item) for item in data]
                logger.info('[kazumi] loaded %d rules from %s', len(self._plugins), self._file)
            except Exception as e:
                logger.exception('[kazumi] load plugins failed: %s', e)
                # 损坏恢复：备份并初始化为空列表
                try:
                    bak = self._file + '.bak'
                    shutil.copy2(self._file, bak)
                    logger.warning('[kazumi] corrupted plugins.json backed up to %s', bak)
                except Exception:
                    pass
                self._plugins = []

    def _save(self):
        with self._lock:
            try:
                os.makedirs(os.path.dirname(self._file), exist_ok=True)
                tmp = self._file + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump([p.to_json() for p in self._plugins], f, ensure_ascii=False, indent=2)
                # 原子替换
                if os.path.exists(self._file):
                    shutil.copy2(self._file, self._file + '.bak')
                os.replace(tmp, self._file)
                logger.info('[kazumi] saved %d rules to %s', len(self._plugins), self._file)
            except Exception as e:
                logger.exception('[kazumi] save plugins failed: %s', e)

    # ---------------------------------------------------------------- CRUD

    def list_all(self):
        with self._lock:
            return [{
                'name': p.name,
                'version': p.version,
                'enabled': p.enabled,
                'useWebview': p.use_webview,
                'api': p.api,
            } for p in self._plugins]

    def get(self, name):
        with self._lock:
            for p in self._plugins:
                if p.name.lower() == name.lower():
                    return p
            return None

    def add(self, plugin):
        """导入或更新规则；返回 (ok, msg)。"""
        err = plugin.validate()
        if err:
            return False, err
        replaced = False
        with self._lock:
            for i, p in enumerate(self._plugins):
                if p.name.lower() == plugin.name.lower():
                    self._plugins[i] = plugin
                    replaced = True
                    break
            if not replaced:
                self._plugins.append(plugin)
        self._save()
        logger.info('[kazumi] %s rule: %s', 'updated' if replaced else 'added', plugin.name)
        return True, 'updated' if replaced else 'added'

    def remove(self, name):
        found = False
        with self._lock:
            for i, p in enumerate(self._plugins):
                if p.name.lower() == name.lower():
                    del self._plugins[i]
                    found = True
                    break
        if found:
            self._save()
            logger.info('[kazumi] removed rule: %s', name)
        return found

    def toggle(self, name, enabled):
        found = False
        with self._lock:
            for p in self._plugins:
                if p.name.lower() == name.lower():
                    p.enabled = enabled
                    found = True
                    break
        if found:
            self._save()
            logger.info('[kazumi] %s rule: %s', 'enabled' if enabled else 'disabled', name)
        return found

    def enabled_plugins(self):
        with self._lock:
            return [p for p in self._plugins if p.enabled]

    def has_enabled(self):
        with self._lock:
            return any(p.enabled for p in self._plugins)

    # ---------------------------------------------------------------- Bangumi 元数据

    def bangumi_search(self, keyword, limit=10):
        """Bangumi 番剧搜索（next.bgm.tv）。"""
        import requests
        try:
            rsp = requests.get(
                f'{BANGUMI_API_NEXT}/p1/search/subjects',
                params={'limit': limit, 'offset': 0, 'keyword': keyword},
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            data = rsp.json()
            return data.get('data', []) or []
        except Exception as e:
            logger.warning('[kazumi] bangumi search failed: %s', e)
            return []

    def bangumi_info(self, subject_id):
        """Bangumi 番剧详情（api.bgm.tv）。"""
        import requests
        try:
            rsp = requests.get(
                f'{BANGUMI_API}/v0/subjects/{subject_id}',
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi info failed: %s', e)
            return None

    def bangumi_calendar(self):
        """Bangumi 每日放送（next.bgm.tv）。"""
        import requests
        try:
            rsp = requests.get(
                f'{BANGUMI_API_NEXT}/p1/calendar',
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi calendar failed: %s', e)
            return []

    # ---------------------------------------------------------------- 在线规则商店

    def fetch_shop_catalog(self):
        """从 KazumiRules 仓库拉取规则目录（index.json）。"""
        import requests
        urls = [
            'https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json',
            'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/raw/main/index.json',
        ]
        for url in urls:
            try:
                rsp = requests.get(url, timeout=10, verify=False)
                rsp.raise_for_status()
                data = rsp.json()
                logger.info('[kazumi] shop catalog loaded: %d rules from %s', len(data), url)
                return data
            except Exception as e:
                logger.warning('[kazumi] shop catalog %s failed: %s', url, e)
        return []

    def fetch_shop_rule(self, name):
        """从 KazumiRules 仓库下载单个规则。"""
        import requests
        urls = [
            f'https://raw.githubusercontent.com/Predidit/KazumiRules/main/{name}.json',
            f'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/raw/main/{name}.json',
        ]
        for url in urls:
            try:
                rsp = requests.get(url, timeout=10, verify=False)
                rsp.raise_for_status()
                return Plugin.from_json(rsp.json())
            except Exception as e:
                logger.warning('[kazumi] shop rule %s from %s failed: %s', name, url, e)
        return None
