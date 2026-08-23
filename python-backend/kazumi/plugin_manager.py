# -*- coding: utf-8 -*-
"""Kazumi 规则管理器：规则 CRUD、持久化、启�?禁用�?

持久化：~/.yuki/kazumi/plugins.json（单文件存储全部规则）�?
线程安全：threading.Lock 保护规则列表读写�?
"""
import json
import logging
import os
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import hoststate
import http_client

from .plugin import Plugin
from .utils import NoResultException, CaptchaRequiredException

logger = logging.getLogger('yuki.kazumi.manager')

# 代理：应用内「代理设置」由主进程注入 HTTP(S)_PROXY 环境变量，
# http_client.system_proxies 环境变量优先读取（C1 收编后不再依赖 requests trust_env）。

# 内置默认规则目录（随应用打包，首次启动自动导入）
_BUILTIN_RULES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')

# Bangumi API 端点（对齐 Kazumi api_endpoints.dart：bangumiAPIDomain / bangumiAPINextDomain）
# 2026-08-09 按用户要求从旧镜像（bangumi.lol）改回官方域名 api.bgm.tv / next.bgm.tv；
# 2026-08-21 按用户要求镜像域名整体切换为 bangumi.pro。
# （api.bangumi.tv 域名已被占用/不可达，官方 API 主机实为 api.bgm.tv）。
# api.kazumi.fyi 为 Kazumi 官方镜像，留作签名镜像兜底。
BANGUMI_API = 'https://api.bgm.tv'
BANGUMI_API_NEXT = 'https://next.bgm.tv'
# 全域名反代镜像（bangumi.pro，对齐镜像站说明：api.bgm.tv → api.bangumi.pro，next.bgm.tv → next.bangumi.pro）
BANGUMI_MIRROR_API = 'https://api.bangumi.pro'
BANGUMI_MIRROR_NEXT = 'https://next.bangumi.pro'
BANGUMI_MIRROR = 'https://api.kazumi.fyi'  # 旧 kazumi 专属镜像（仅部分路径），保留常量向后兼容
# bangumi 官方 API 的 WAF 会拦截 python-requests 默认 UA（部分端点直接 403），必须带应用 UA
BANGUMI_UA = 'yuki/0.1.0 (https://github.com/); kazumi'

# 弹弹 play API（对齐 Kazumi danmaku_api.dart）
DANDAN_API = 'https://api.dandanplay.net'
# 签名密钥（环境变量注入，对齐 Kazumi --dart-define）
DANDAN_APPID = os.environ.get('DANDANAPI_APPID', '')
DANDAN_KEY = os.environ.get('DANDANAPI_KEY', '')

# WebDAV 同步（对齐 Kazumi webdav_client）
WEBDAV_SYNC_ROOT = '/kazumiSync'


class PluginManager:
    """Kazumi 规则 CRUD 与持久化。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._plugins = []  # list[Plugin]
        self._file = os.path.join(hoststate.get_data_dir(), 'kazumi', 'plugins.json')
        self._username_cache = None  # Bangumi 当前用户名缓存（5 分钟 TTL，R1 收藏接口需真实用户名）
        self._username_ts = 0
        self._task_lock = threading.Lock()   # 保护有效性检测/批量更新的运行状态
        self._validity_running = False
        self._validity_results = []          # list[{'name','validity','msg'}]
        self._validity_total = 0             # 本次检测目标规则总数（进度条 N/M 的 M）
        self._update_running = False
        self._update_results = []            # list[{'name','ok','msg','oldVersion','newVersion','updated'}]
        self._update_total = 0               # 本次批量更新目标规则总数
        # 镜像开关（4.1，对齐 Kazumi enableBangumiProxy/enableGitProxy）：Bangumi 公开接口走 api.kazumi.fyi
        self.enable_bangumi_proxy = False
        self.enable_git_proxy = False
        self._load()
        self._import_builtin_rules()
        self._load_mirror_state()

    @staticmethod
    def _now():
        """当前时间字符串（ISO-8601 本地时间）。"""
        return time.strftime('%Y-%m-%d %H:%M:%S')

    # ---------------------------------------------------------------- 镜像源（4.1）

    def _base_api(self):
        """api.bgm.tv 类接口基址：镜像开启时走全域名反代 api.bangumi.pro（无需签名，全路径可用）。"""
        return BANGUMI_MIRROR_API if self.enable_bangumi_proxy else BANGUMI_API

    def _base_next(self):
        """next.bgm.tv 类接口基址：镜像开启时走 next.bangumi.pro。"""
        return BANGUMI_MIRROR_NEXT if self.enable_bangumi_proxy else BANGUMI_API_NEXT

    def set_mirror(self, bangumi=None, git=None):
        """设置镜像开关（持久化到后端内存 + 落盘镜像状态文件）；返回当前状态。"""
        with self._lock:
            if bangumi is not None:
                self.enable_bangumi_proxy = bool(bangumi)
            if git is not None:
                self.enable_git_proxy = bool(git)
            self._save_mirror_state()
        return {'bangumi': self.enable_bangumi_proxy, 'git': self.enable_git_proxy}

    # ---------------------------------------------------------------- 镜像开关持久化

    def _mirror_state_file(self):
        try:
            d = hoststate.get_data_dir()
            if d:
                os.makedirs(os.path.join(d, 'kazumi'), exist_ok=True)
                return os.path.join(d, 'kazumi', 'mirror.json')
        except Exception:
            pass
        return ''

    def _load_mirror_state(self):
        """启动时恢复镜像开关（此前开关只存前端 settings，后端重启后丢失）。"""
        try:
            fp = self._mirror_state_file()
            if not fp or not os.path.exists(fp):
                return
            with open(fp, encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                self.enable_bangumi_proxy = bool(data.get('bangumi'))
                self.enable_git_proxy = bool(data.get('git'))
                logger.info('[kazumi] mirror state restored: %s', data)
        except Exception as e:
            logger.warning('[kazumi] mirror state load failed: %s', e)

    def _save_mirror_state(self):
        try:
            fp = self._mirror_state_file()
            if not fp:
                return
            with open(fp, 'w', encoding='utf-8') as f:
                json.dump({'bangumi': self.enable_bangumi_proxy, 'git': self.enable_git_proxy}, f)
        except Exception as e:
            logger.warning('[kazumi] mirror state save failed: %s', e)

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
                now = self._now()
                plugin.installed_at = now
                plugin.updated_at = now
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
                # M-19：单条坏记录（含未知字段/类型不符）跳过而非整体清空——
                # 原先任一条抛错即走 except 备份后置空，下次 _save 把空列表写回，
                # 用户全部规则丢失
                plugins = []
                for item in (data if isinstance(data, list) else []):
                    try:
                        plugins.append(Plugin.from_json(item))
                    except Exception as e:
                        logger.warning('[kazumi] 跳过不兼容规则记录: %s', e)
                self._plugins = plugins
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
                'baseURL': p.base_url,
                'searchURL': p.search_url,
                'installed_at': p.installed_at,
                'updated_at': p.updated_at,
                'validity': p.validity,
                'validity_checked_at': p.validity_checked_at,
            } for p in self._plugins]

    def reorder(self, names):
        """按给定名称顺序重排规则并持久化（顺序即 plugins.json 数组顺序，对齐 Kazumi onReorder）。
        未提及的规则追加在末尾、保持原相对顺序。返回 (ok, msg)。"""
        names = names or []
        with self._lock:
            by_name = {p.name.lower(): p for p in self._plugins}
            order = []
            seen = set()
            for name in names:
                key = str(name).strip().lower()
                if key in by_name and key not in seen:
                    order.append(by_name[key])
                    seen.add(key)
            for p in self._plugins:
                if p.name.lower() not in seen:
                    order.append(p)
                    seen.add(p.name.lower())
            self._plugins = order
        self._save()
        return True, 'ok'

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
        now = self._now()
        with self._lock:
            for i, p in enumerate(self._plugins):
                if p.name.lower() == plugin.name.lower():
                    # 更新：保留首次安装时间，记录更新时间
                    plugin.installed_at = p.installed_at or now
                    plugin.updated_at = now
                    self._plugins[i] = plugin
                    replaced = True
                    break
            if not replaced:
                plugin.installed_at = now
                plugin.updated_at = now
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

    # ---------------------------------------------------------------- 有效性检测

    def check_validity(self, engine, keyword='海贼王', names=None, max_workers=4, on_result=None):
        """对启用规则执行有效性检测（搜索测试关键词），同步执行，返回结果列表。

        engine: RuleEngine 实例；names: 指定规则名（不传则检测全部启用规则）。
        每个规则用 ThreadPoolExecutor 并发搜索，写回 validity 与 validity_checked_at。
        on_result(result_dict): 可选回调，每完成一条即调用一次（后台任务用它把进度写入共享状态）。
        """
        with self._lock:
            targets = [p for p in self._plugins if p.enabled]
        if names:
            name_set = {n.lower() for n in names}
            targets = [p for p in targets if p.name.lower() in name_set]
        if not targets:
            return []
        now = self._now()
        results = []

        def _check_one(plugin):
            try:
                trace = engine.search(plugin.execution_config(), keyword)
                n = len(trace.response.data) if trace.response else 0
                if n > 0:
                    return (plugin.name, 'valid', f'搜索到 {n} 条结果')
                return (plugin.name, 'invalid', '搜索无结果')
            except CaptchaRequiredException:
                return (plugin.name, 'captcha', '需要验证码验证')
            except NoResultException:
                return (plugin.name, 'invalid', '搜索无结果')
            except Exception as e:
                return (plugin.name, 'invalid', str(e)[:80])

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            for name, status, msg in pool.map(_check_one, targets):
                item = {'name': name, 'validity': status, 'msg': msg}
                results.append(item)
                if on_result:
                    on_result(item)
                with self._lock:
                    for p in self._plugins:
                        if p.name.lower() == name.lower():
                            p.validity = status
                            p.validity_checked_at = now
                            break
        self._save()
        logger.info('[kazumi] validity check done: %d rules', len(results))
        return results

    def start_validity_check(self, engine, keyword='海贼王', names=None):
        """后台启动有效性检测；返回 True 表示已启动，False 表示已有检测在跑。"""
        with self._task_lock:
            if self._validity_running:
                return False
            self._validity_running = True
            self._validity_results = []
            # 预计算目标总数，供进度条显示 N/M（M 在检测开始前即确定）
            with self._lock:
                targets = [p for p in self._plugins if p.enabled]
            if names:
                name_set = {n.lower() for n in names}
                targets = [p for p in targets if p.name.lower() in name_set]
            self._validity_total = len(targets)

        def _on_result(item):
            # 每完成一条即追加进共享结果，使 validity_status 运行期间也能返回 done 进度
            with self._task_lock:
                self._validity_results.append(item)

        def _worker():
            try:
                self.check_validity(engine, keyword=keyword, names=names, on_result=_on_result)
            except Exception as e:
                logger.warning('[kazumi] validity check error: %s', e)
            finally:
                with self._task_lock:
                    self._validity_running = False

        threading.Thread(target=_worker, daemon=True).start()
        return True

    def validity_status(self):
        with self._task_lock:
            results = list(self._validity_results)
            total = self._validity_total or len(results)
            return {'running': self._validity_running, 'results': results,
                    'done': len(results), 'total': total}

    # ---------------------------------------------------------------- 批量更新

    @staticmethod
    def _version_key(version):
        """版本号转可比较元组（忽略非数字段，如 '2.0.1' -> (2,0,1)）。"""
        parts = re.findall(r'\d+', str(version or ''))
        return tuple(int(x) for x in parts)

    def _should_update(self, current, latest):
        """最新版 > 当前版 才更新；版本无法解析时视为不更新。"""
        ck, lk = self._version_key(current), self._version_key(latest)
        if not ck or not lk:
            return False
        return lk > ck

    def batch_update(self, names=None, max_workers=4, on_result=None):
        """批量更新规则（从商店拉取最新版，4 并发），同步执行，返回结果列表。

        对每个已安装规则：拉取商店最新版 → 版本较新则 add() 覆盖（保留安装时间）。
        on_result(result_dict): 可选回调，每完成一条即调用一次（后台任务用它把进度写入共享状态）。
        """
        with self._lock:
            targets = list(self._plugins)
        if names:
            name_set = {n.lower() for n in names}
            targets = [p for p in targets if p.name.lower() in name_set]
        if not targets:
            return []
        results = []

        def _update_one(plugin):
            try:
                latest = self.fetch_shop_rule(plugin.name)
            except Exception as e:
                return {'name': plugin.name, 'ok': False, 'msg': f'商店下载失败: {str(e)[:60]}'}
            if latest is None:
                return {'name': plugin.name, 'ok': False, 'msg': '商店中未找到该规则'}
            old = plugin.version
            new = latest.version
            if not self._should_update(old, new):
                return {'name': plugin.name, 'ok': True, 'msg': '已是最新版本',
                        'oldVersion': old, 'newVersion': new, 'updated': False}
            latest.installed_at = plugin.installed_at  # 保留首次安装时间
            ok, _ = self.add(latest)
            return {'name': plugin.name, 'ok': ok, 'msg': '更新成功' if ok else '更新失败',
                    'oldVersion': old, 'newVersion': new, 'updated': ok}

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            for item in pool.map(_update_one, targets):
                results.append(item)
                if on_result:
                    on_result(item)
        logger.info('[kazumi] batch update done: %d rules', len(results))
        return results

    def start_batch_update(self, names=None):
        """后台启动批量更新；返回 True 表示已启动，False 表示已有更新在跑。"""
        with self._task_lock:
            if self._update_running:
                return False
            self._update_running = True
            self._update_results = []
            with self._lock:
                targets = list(self._plugins)
            if names:
                name_set = {n.lower() for n in names}
                targets = [p for p in targets if p.name.lower() in name_set]
            self._update_total = len(targets)

        def _on_result(item):
            with self._task_lock:
                self._update_results.append(item)

        def _worker():
            try:
                self.batch_update(names=names, on_result=_on_result)
            except Exception as e:
                logger.warning('[kazumi] batch update error: %s', e)
            finally:
                with self._task_lock:
                    self._update_running = False

        threading.Thread(target=_worker, daemon=True).start()
        return True

    def update_status(self):
        with self._task_lock:
            results = list(self._update_results)
            total = self._update_total or len(results)
            return {'running': self._update_running, 'results': results,
                    'done': len(results), 'total': total}

    # ---------------------------------------------------------------- Bangumi 元数据

    def bangumi_search(self, keyword, limit=10):
        """Bangumi 番剧搜索（POST api.bgm.tv/v0/search/subjects，对齐 Kazumi buildBangumiSearchParams）。

        注意：旧实现用 GET next.bgm.tv/p1/search/subjects，该路由在官方 API 上不存在（404）。
        Kazumi 标准为 POST /v0/search/subjects + JSON body（keyword/sort/filter）。"""
        try:
            body = {
                'keyword': keyword,
                'sort': 'heat',
                'filter': {'type': [2], 'tag': [], 'rank': ['>=0', '<=99999'], 'nsfw': False},
            }
            rsp = http_client.post(
                f'{self._base_api()}/v0/search/subjects',
                params={'limit': limit, 'offset': 0},
                json=body,
                headers={'User-Agent': BANGUMI_UA},
                timeout=(5, 10),
                verify=True,
            )
            rsp.raise_for_status()
            data = rsp.json()
            items = data.get('data', []) if isinstance(data, dict) else data
            return items or []
        except Exception as e:
            logger.warning('[kazumi] bangumi search failed: %s', e)
            return []

    @staticmethod
    def _build_number_filter(low, high):
        """构造 Bangumi 数值区间过滤（对齐 Kazumi _buildNumberFilter：min→>=，max→<=）。"""
        out = []
        if low is not None:
            out.append('>=%s' % low)
        if high is not None:
            out.append('<=%s' % high)
        return out

    def bangumi_search_filtered(self, keyword='', tags=None, sort='heat',
                                date_start='', date_end='',
                                rank_min=None, rank_max=None,
                                score_min=None, score_max=None,
                                weekdays=None, limit=20, offset=0):
        """带筛选的 Bangumi 番剧搜索（对齐 Kazumi buildBangumiSearchParams + bangumiSearch）。

        复刻 Kazumi 搜索工作台的全部筛选维度：关键词、标签（AND 语义）、
        排序（heat/rank/score/match）、播出日期区间、排名区间、评分区间、放送星期。
        POST api.bgm.tv/v0/search/subjects，结果经日历归一化补 name_cn/air_date，
        按 id 去重后返回 {items, total}。镜像开启时经 _base_api() 走全域名反代。"""
        tags = list(tags or [])
        try:
            weekdays = sorted({int(w) for w in (weekdays or []) if str(w).strip()})
        except (TypeError, ValueError):
            weekdays = []   # L-25：非数字入参不再 500
        # rank：显式区间优先；sort=rank 时用 Kazumi 的 >0 下限，否则 >=0
        rank_filter = self._build_number_filter(rank_min, rank_max)
        if not rank_filter:
            rank_filter = ['>0', '<=99999'] if sort == 'rank' else ['>=0', '<=99999']
        filter_body = {
            'type': [2],
            'tag': tags,
            'rank': rank_filter,
            'nsfw': False,
        }
        if date_start and date_end:
            filter_body['air_date'] = ['>=' + str(date_start), '<' + str(date_end)]
        score_filter = self._build_number_filter(score_min, score_max)
        if score_filter:
            filter_body['rating'] = score_filter
        if weekdays:
            filter_body['air_weekday'] = weekdays
        body = {
            'keyword': keyword or '',
            'sort': sort or 'heat',
            'filter': filter_body,
        }
        try:
            rsp = http_client.post(
                f'{self._base_api()}/v0/search/subjects',
                params={'limit': min(int(limit), 50), 'offset': max(int(offset), 0)},
                json=body,
                headers={'User-Agent': BANGUMI_UA},
                timeout=(5, 10),
                verify=True,
            )
            rsp.raise_for_status()
            data = rsp.json()
            raw = data.get('data', []) if isinstance(data, dict) else data
            items = []
            seen = set()
            if isinstance(raw, list):
                for entry in raw:
                    item = self._normalize_calendar_item(entry)
                    if item and item.get('id') and item['id'] not in seen:
                        seen.add(item['id'])
                        items.append(item)
            total = data.get('total', len(items)) if isinstance(data, dict) else len(items)
            return {'items': items, 'total': total, 'raw_count': len(raw) if isinstance(raw, list) else 0}
        except Exception as e:
            logger.warning('[kazumi] bangumi search filtered failed: %s', e)
            return {'items': [], 'total': 0, 'raw_count': 0}

    def bangumi_info(self, subject_id):
        """Bangumi 番剧详情（api.bgm.tv）。"""
        try:
            rsp = http_client.get(
                f'{self._base_api()}/v0/subjects/{subject_id}',
                headers={'User-Agent': BANGUMI_UA},
                timeout=(5, 8),
                verify=True,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi info failed: %s', e)
            return None

    @staticmethod
    def _calendar_air_date(subject):
        """从 Bangumi 日历 subject 中提取统一的 YYYY-MM-DD 日期。"""
        for key in ('air_date', 'airDate', 'date'):
            value = subject.get(key)
            if value:
                match = re.search(r'(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?', str(value))
                if match:
                    return f'{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}'
        info = str(subject.get('info') or '')
        match = re.search(r'(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?', info)
        if match:
            return f'{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}'
        return ''

    @classmethod
    def _normalize_calendar_item(cls, entry):
        """把 next.bgm.tv 的 {subject, watchers} 项转成前端扁平条目。"""
        if not isinstance(entry, dict):
            return None
        subject = entry.get('subject') if isinstance(entry.get('subject'), dict) else entry
        if not isinstance(subject, dict) or not subject.get('id'):
            return None
        item = dict(subject)
        item['name_cn'] = item.get('name_cn') or item.get('nameCN') or item.get('name') or ''
        item['air_date'] = item.get('air_date') or cls._calendar_air_date(item)
        if 'watchers' in entry:
            item['watchers'] = entry['watchers']
        return item

    @classmethod
    def _normalize_calendar(cls, data):
        """统一不同 Bangumi 日历接口返回形状为 [{weekday:{id}, items:[...]}]。"""
        if isinstance(data, list):
            result = []
            for index, day in enumerate(data, 1):
                if not isinstance(day, dict):
                    continue
                weekday = day.get('weekday')
                weekday_id = weekday.get('id') if isinstance(weekday, dict) else weekday
                try:
                    weekday_id = int(weekday_id or index)
                except (TypeError, ValueError):
                    weekday_id = index
                raw_items = day.get('items') or day.get('subjects') or []
                items = [item for item in (cls._normalize_calendar_item(x) for x in raw_items) if item]
                result.append({'weekday': {'id': weekday_id}, 'items': items})
            return result

        if not isinstance(data, dict):
            return []
        result = []
        for weekday_id in range(1, 8):
            raw_items = data.get(str(weekday_id), data.get(weekday_id, []))
            if not isinstance(raw_items, list):
                raw_items = []
            items = [item for item in (cls._normalize_calendar_item(x) for x in raw_items) if item]
            result.append({'weekday': {'id': weekday_id}, 'items': items})
        return result

    def bangumi_calendar(self):
        """Bangumi 每日放送（next.bgm.tv），转换为稳定的前端数据结构。"""
        for attempt in range(3):
            try:
                rsp = http_client.get(
                    f'{self._base_next()}/p1/calendar',
                    headers={'User-Agent': BANGUMI_UA},
                    timeout=(5, 8),  # 连接 5s，读取 8s
                    verify=True,
                )
                rsp.raise_for_status()
                return self._normalize_calendar(rsp.json())
            except Exception as e:
                logger.warning('[kazumi] bangumi calendar attempt %d failed: %s', attempt + 1, e)
                if attempt < 2:
                    import time
                    time.sleep(2)
        return []

    @staticmethod
    def _season_weekday(air_date):
        """由 YYYY-MM-DD 计算星期（isoweekday：1=周一..7=周日）；无效返回 1。"""
        try:
            y, m, d = (int(x) for x in str(air_date).split('-')[:3])
            return date(y, m, d).isoweekday()
        except (ValueError, TypeError):
            return 1

    def bangumi_season_calendar(self, start, end, max_pages=4, page_size=20):
        """季度放送检索（对齐 Kazumi getSchedulesBySeason）。

        POST api.bgm.tv/v0/search/subjects 按 air_date 区间过滤 type=2（动画），
        sort=rank 拉取多页后按 id 去重，复用日历归一化补 name_cn/air_date，
        再按播出星期分桶为 [{weekday:{id}, items:[...]}]（与 bangumi_calendar 同形状）。
        镜像开启时经 _base_api() 走全域名反代 api.bangumi.pro（免签名，全路径可用）。
        start/end 形如 YYYY-MM-DD；失败或无结果返回 []。"""
        if not start or not end:
            return []
        body = {
            'keyword': '',
            'sort': 'rank',
            'filter': {
                'type': [2],
                'tag': ['日本'],
                'air_date': ['>=' + str(start), '<' + str(end)],
                'rank': ['>0', '<=99999'],
                'nsfw': True,
            },
        }
        merged = {}
        try:
            for page in range(max_pages):
                rsp = http_client.post(
                    f'{self._base_api()}/v0/search/subjects',
                    params={'limit': page_size, 'offset': page * page_size},
                    json=body,
                    headers={'User-Agent': BANGUMI_UA},
                    timeout=(5, 10),
                    verify=True,
                )
                rsp.raise_for_status()
                data = rsp.json()
                rows = data.get('data', []) if isinstance(data, dict) else data
                if not isinstance(rows, list) or not rows:
                    break
                for row in rows:
                    if isinstance(row, dict) and row.get('id') and row['id'] not in merged:
                        merged[row['id']] = row
                if len(rows) < page_size:
                    break
        except Exception as e:
            logger.warning('[kazumi] bangumi season calendar failed: %s', e)
            return []
        buckets = {i: [] for i in range(1, 8)}
        for row in merged.values():
            item = self._normalize_calendar_item({'subject': row})
            if not item:
                continue
            buckets[self._season_weekday(item.get('air_date'))].append(item)
        return [{'weekday': {'id': wd}, 'items': buckets[wd]} for wd in range(1, 8)]

    def bangumi_trends(self, limit=24, offset=0):
        """Bangumi 番剧趋势榜单（next.bgm.tv /p1/trending/subjects），返回归一化 {items,total}。
        镜像开启时经 _base_next() 走全域名反代 next.bangumi.pro（免签名，全路径可用）。
        注意：该端点必须传 type/limit/offset，否则返回 400。"""
        # 官方/镜像趋势（镜像开启时 _base_next() 指向 next.bangumi.pro）
        try:
            rsp = http_client.get(
                f'{self._base_next()}/p1/trending/subjects',
                params={'type': 2, 'limit': limit, 'offset': offset},
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=True,
            )
            rsp.raise_for_status()
            data = rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi trends failed: %s', e)
            return {'items': [], 'total': 0}
        raw = data.get('data', []) if isinstance(data, dict) else data
        items = []
        if isinstance(raw, list):
            for entry in raw:
                item = self._normalize_calendar_item(entry)
                if item:
                    items.append(item)
        total = data.get('total', len(items)) if isinstance(data, dict) else len(items)
        return {'items': items, 'total': total}

    def bangumi_list_by_tag(self, tag, limit=100, offset=0):
        """按标签搜索番剧（对齐 Kazumi getBangumiList：POST /v0/search/subjects + tag filter）。
        tag 为空时返回热门排行（日本限定），非空时按标签筛选。"""
        try:
            if tag:
                body = {
                    'keyword': '',
                    'sort': 'rank',
                    'filter': {'type': [2], 'tag': [tag], 'rank': ['>=2', '<=99999'], 'nsfw': False},
                }
            else:
                body = {
                    'keyword': '',
                    'sort': 'rank',
                    'filter': {'type': [2], 'tag': ['日本'], 'rank': ['>=2', '<=1050'], 'nsfw': False},
                }
            rsp = http_client.post(
                f'{self._base_api()}/v0/search/subjects',
                params={'limit': limit, 'offset': offset},
                json=body,
                headers={'User-Agent': BANGUMI_UA},
                timeout=(5, 10),
                verify=True,
            )
            rsp.raise_for_status()
            data = rsp.json()
            raw = data.get('data', []) if isinstance(data, dict) else data
            items = []
            if isinstance(raw, list):
                for entry in raw:
                    item = self._normalize_calendar_item(entry)
                    if item:
                        items.append(item)
            total = data.get('total', len(items)) if isinstance(data, dict) else len(items)
            return {'items': items, 'total': total}
        except Exception as e:
            logger.warning('[kazumi] bangumi list by tag failed: %s', e)
            return {'items': [], 'total': 0}

    def bangumi_episodes(self, subject_id):
        """Bangumi 番剧分集信息（api.bgm.tv）。"""
        try:
            rsp = http_client.get(
                f'{self._base_api()}/v0/episodes',
                params={'subject_id': subject_id},
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=True,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi episodes failed: %s', e)
            return None

    def bangumi_characters(self, subject_id):
        """Bangumi 番剧角色信息（api.bgm.tv）。

        列表端点 /v0/subjects/{id}/characters 只返回原名（多为日文），无中文名；
        中文名藏在单角色详情 /v0/characters/{id} 的 infobox「别名」项里。故拉到列表后
        并发补全每个角色的 name_cn（有界线程池，best-effort：单个失败保留原名），
        供前端「角色卡片默认用简体中文名」渲染。首次较慢，由 server 层 TTL 缓存兜住重复访问。
        """
        try:
            rsp = http_client.get(
                f'{self._base_api()}/v0/subjects/{subject_id}/characters',
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=True,
            )
            rsp.raise_for_status()
            chars = rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi characters failed: %s', e)
            return []
        if not isinstance(chars, list) or not chars:
            return chars if isinstance(chars, list) else []
        self._enrich_characters_name_cn(chars)
        return chars

    def _enrich_characters_name_cn(self, chars):
        """并发为角色列表补全 name_cn（就地写入）：逐个拉 /v0/characters/{id} 详情，
        从 infobox 提取简体中文名。有界并发≤6，单角色失败/无中文名时不写（保留原名回退）。"""
        def _fill(ch):
            if not isinstance(ch, dict):
                return
            cid = ch.get('id')
            if not cid or ch.get('name_cn'):
                return
            info = self.bangumi_character_detail(cid)
            cn = self._pick_char_name_cn(info)
            if cn and cn != (ch.get('name') or ''):
                ch['name_cn'] = cn
        targets = [c for c in chars if isinstance(c, dict) and c.get('id') and not c.get('name_cn')]
        if not targets:
            return
        try:
            with ThreadPoolExecutor(max_workers=min(6, len(targets))) as pool:
                list(pool.map(_fill, targets))
        except Exception as e:
            logger.warning('[kazumi] enrich character name_cn failed: %s', e)

    @staticmethod
    def _pick_char_name_cn(info):
        """从角色详情提取简体中文名。优先级：
        1) 基本信息 infobox 里的「简体中文名」项（Bangumi 角色资料常见字段，最准确）；
        2) 显式 name_cn 字段（部分接口/镜像返回）；
        3) infobox「别名/中文名」项里含「中文/简体」的值。
        infobox 可能是 [{key, value}]（value 又可能是 [{k, v}] 或字符串）。对齐前端 _pickCharNameCn。"""
        if not isinstance(info, dict):
            return ''
        ib = info.get('infobox') if isinstance(info.get('infobox'), list) else []

        # 1) 基本信息里的「简体中文名」（精确 key 命中，优先级最高）
        for it in ib:
            if not isinstance(it, dict):
                continue
            k = str(it.get('key') or '').strip()
            if k in ('简体中文名', '简体中文', '中文名'):
                v = it.get('value')
                if isinstance(v, str) and v.strip():
                    return v.strip()
                if isinstance(v, list):
                    for x in v:
                        if isinstance(x, dict) and x.get('v'):
                            return str(x['v'])

        # 2) 显式 name_cn 字段
        if info.get('name_cn'):
            return str(info['name_cn'])

        # 3) 别名项里的中文/简体值兜底
        alias_keys = ('别名', 'alternate name', 'alias')
        for it in ib:
            if not isinstance(it, dict):
                continue
            k = str(it.get('key') or '').strip().lower()
            if k not in [a.lower() for a in alias_keys]:
                continue
            v = it.get('value')
            if isinstance(v, list):
                # [{k:'简体中文', v:'...'}] 形式：优先含「中文/简体」的项
                for x in v:
                    if isinstance(x, dict) and ('中文' in str(x.get('k') or '') or '简体' in str(x.get('k') or '')):
                        if x.get('v'):
                            return str(x['v'])
                for x in v:
                    if isinstance(x, dict) and x.get('v'):
                        return str(x['v'])
            elif isinstance(v, str) and v.strip():
                m = re.search(r'(?:简体)?中文\s*[:：]\s*([^\n;；/、]+)', v)
                if m:
                    return m.group(1).strip()
                return re.split(r'[\n;；/、]', v)[0].strip()
        return ''

    def bangumi_character_detail(self, character_id):
        """单个角色详情（api.bgm.tv /v0/characters/{id}）：资料 + 简介。"""
        try:
            rsp = http_client.get(
                f'{self._base_api()}/v0/characters/{character_id}',
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=True,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi character detail failed: %s', e)
            return None

    def bangumi_character_comments(self, character_id):
        """单个角色吐槽（next.bgm.tv /p1/characters/{id}/comments）。"""
        try:
            rsp = http_client.get(
                f'{self._base_next()}/p1/characters/{character_id}/comments',
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=True,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi character comments failed: %s', e)
            return []

    def bangumi_staff(self, subject_id):
        """Bangumi 番剧制作人员（api.bgm.tv）。"""
        try:
            rsp = http_client.get(
                f'{self._base_api()}/v0/subjects/{subject_id}/persons',
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=True,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi staff failed: %s', e)
            return []
    def bangumi_comments(self, subject_id, limit=20, offset=0):
        """Bangumi 番剧评论（next.bgm.tv）。"""
        try:
            rsp = http_client.get(
                f'{self._base_next()}/p1/subjects/{subject_id}/comments',
                params={'limit': limit, 'offset': offset},
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=True,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi comments failed: %s', e)
            return []

    def bangumi_relations(self, subject_id):
        """Bangumi 番剧关联（前传/续作链，api.bgm.tv）。"""
        try:
            rsp = http_client.get(
                f'{self._base_api()}/v0/subjects/{subject_id}/subjects',
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=True,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi relations failed: %s', e)
            return []

    # ---------------------------------------------------------------- Bangumi 用户收藏同步

    # 收藏类型（Bangumi API）：1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃
    BANGUMI_COLLECTION_TYPES = {1: '想看', 2: '看过', 3: '在看', 4: '搁置', 5: '抛弃'}

    @staticmethod
    def _normalize_bangumi_token(token):
        """规范化 Token：去空白、兼容用户粘贴的 `Bearer xxx` 全头。"""
        if not token:
            return ''
        t = str(token).strip()
        if t.lower().startswith('bearer '):
            t = t[7:].strip()
        return t

    @staticmethod
    def _bangumi_auth_headers(token):
        """带 token 的鉴权头（Bangumi API 要求 User-Agent + Bearer）。"""
        norm = PluginManager._normalize_bangumi_token(token)
        return {
            'Authorization': f'Bearer {norm}',
            'User-Agent': BANGUMI_UA,
        }

    def bangumi_me(self, token):
        """当前用户信息（需 token；返回 None 表示 token 无效或网络失败）。"""
        token = self._normalize_bangumi_token(token)
        if not token:
            return None
        try:
            rsp = http_client.get(f'{self._base_api()}/v0/me',
                               headers=self._bangumi_auth_headers(token), timeout=(5, 8), verify=True)
            if getattr(rsp, 'status_code', None) in (401, 403):
                logger.warning('[kazumi] bangumi me 401/403: Token 无效或已过期，请在 https://bgm.tv/settings/token 重新获取')
                return None
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            # requests HTTPError 携带 response，显式识别 401/403
            try:
                resp = getattr(e, 'response', None)
                code = getattr(resp, 'status_code', None)
                if code in (401, 403):
                    logger.warning('[kazumi] bangumi me 401/403: Token 无效或已过期，请在 https://bgm.tv/settings/token 重新获取')
                    return None
            except Exception:
                pass
            logger.warning('[kazumi] bangumi me failed: %s', e)
            return None

    def _bangumi_username(self, token):
        """当前用户名（/v0/me 获取，缓存 5 分钟）。

        R1 根因：`/v0/users/-/collections` 的 `-` 在未鉴权/无效 token 时会被当作字面用户名，
        官方 API 返回 404 "user doesn't exist"。对齐 Kazumi（api_endpoints.dart bangumiGetCollection
        用 `{username}` 占位），先取真实用户名再拼 URL。token 无效返回 None。"""
        import time
        now = time.time()
        if self._username_cache and now - self._username_ts < 300:
            return self._username_cache
        me = self.bangumi_me(token)
        username = (me or {}).get('username')
        if username:
            self._username_cache = username
            self._username_ts = now
        return username

    def bangumi_user_collections(self, token, subject_type=2, limit=100, offset=0):
        """当前用户收藏列表（subject_type=2 动画），条目含 subject_id/type/name。
        R1：改用真实用户名（_bangumi_username），不再用 `/v0/users/-/collections`。
        注意：Bangumi API 该端点 limit 上限为 100，超出返回 400，此处统一钳制。"""
        token = self._normalize_bangumi_token(token)
        if not token:
            return []
        limit = max(1, min(int(limit or 100), 100))
        username = self._bangumi_username(token)
        if not username:
            logger.warning('[kazumi] bangumi collections: 无法获取用户名（token 无效或网络失败）')
            return []
        try:
            rsp = http_client.get(f'{self._base_api()}/v0/users/{username}/collections',
                               params={'subject_type': subject_type, 'limit': limit, 'offset': offset},
                               headers=self._bangumi_auth_headers(token), timeout=(5, 10), verify=True)
            if getattr(rsp, 'status_code', None) in (401, 403):
                logger.warning('[kazumi] bangumi collections 401/403: Token 无效或已过期')
                return []
            rsp.raise_for_status()
            data = rsp.json()
            return data.get('data', []) or []
        except Exception as e:
            try:
                resp = getattr(e, 'response', None)
                code = getattr(resp, 'status_code', None)
                if code in (401, 403):
                    logger.warning('[kazumi] bangumi collections 401/403: Token 无效或已过期')
                    return []
            except Exception:
                pass
            logger.warning('[kazumi] bangumi collections failed: %s', e)
            return []

    def bangumi_collection(self, token, subject_id):
        """单个 subject 的收藏状态；未收藏返回 None。"""
        token = self._normalize_bangumi_token(token)
        if not token:
            return None
        username = self._bangumi_username(token)
        if not username:
            logger.warning('[kazumi] bangumi collection get: 无法获取用户名（token 无效）')
            return None
        try:
            rsp = http_client.get(f'{self._base_api()}/v0/users/{username}/collections/{subject_id}',
                               headers=self._bangumi_auth_headers(token), timeout=(5, 8), verify=True)
            if getattr(rsp, 'status_code', None) == 404:
                return None
            if getattr(rsp, 'status_code', None) in (401, 403):
                logger.warning('[kazumi] bangumi collection get 401/403: Token 无效或已过期')
                return None
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            try:
                resp = getattr(e, 'response', None)
                code = getattr(resp, 'status_code', None)
                if code in (401, 403):
                    logger.warning('[kazumi] bangumi collection get 401/403: Token 无效或已过期')
                    return None
            except Exception:
                pass
            logger.warning('[kazumi] bangumi collection get failed: %s', e)
            return None

    def bangumi_update_collection(self, token, subject_id, collection_type):
        """设置/更新收藏类型（对齐 Kazumi updateBangumiById：POST /v0/users/-/collections/{id}）。

        依次尝试 {POST, PUT} × {`-` 通配当前用户, 真实用户名} × {当前基址, 官方/镜像另一基址}，
        首个 2xx 即成功。Bangumi 官方与镜像均支持 `-` 通配（需有效 token）；POST 为 Kazumi 原版
        写法（PUT 等价）；真实用户名 GET 收藏正常，但写接口在个别镜像/网络下返回 404，故都覆盖。
        type: 0想看 1看过 2在看 3搁置 4抛弃（Bangumi 收藏类型）。返回 (ok, msg)。"""
        import requests
        token = self._normalize_bangumi_token(token)
        if not token:
            return False, '缺少 Bangumi token'
        # 先验证 token 有效性，刷新 username 缓存
        self._username_cache = None
        self._username_ts = 0
        username = self._bangumi_username(token)
        if not username:
            return False, 'Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取并在设置中保存'
        body = {'type': int(collection_type)}
        headers = self._bangumi_auth_headers(token)
        bases = [self._base_api()]
        alt = BANGUMI_API if self._base_api() != BANGUMI_API else BANGUMI_MIRROR_API
        if alt not in bases:
            bases.append(alt)
        usernames = ['-', username] if username != '-' else ['-']
        auth_err = None   # 401/403 鉴权类错误（最有指导意义，优先返回）
        other_err = None  # 其他（404/网络等）
        for base in bases:
            for uname in usernames:
                for method in ('POST', 'PUT'):
                    try:
                        url = f'{base}/v0/users/{uname}/collections/{subject_id}'
                        rsp = requests.request(method, url, json=body, headers=headers, timeout=(5, 8), verify=True)
                        # Bangumi 收藏写接口成功返回 2xx（含 202 Accepted）；只认 200/201/204 会把
                        # 202 误判为失败 → 前端弹「同步失败」但实际已同步。统一按 2xx 判定成功。
                        if 200 <= rsp.status_code < 300:
                            return True, 'ok'
                        msg = f'{method} {url} -> {rsp.status_code}'
                        if rsp.status_code in (401, 403):
                            auth_err = msg
                        else:
                            other_err = msg
                    except Exception as e:
                        msg = f'{method} {base}/v0/users/{uname}/collections/{subject_id} ERR {str(e)[:80]}'
                        other_err = msg
        # 401 鉴权失败给出可操作提示，其余保持原始诊断
        if auth_err:
            last = 'Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取并在设置中保存'
        else:
            last = other_err or '未知错误'
        logger.warning('[kazumi] bangumi collection update failed: %s', last)
        return False, last

    def bangumi_delete_collection(self, token, subject_id):
        """删除收藏（对齐 Kazumi deleteBangumiById：DELETE /v0/users/-/collections/{id}）。返回 (ok, msg)。"""
        import requests
        token = self._normalize_bangumi_token(token)
        if not token:
            return False, '缺少 Bangumi token'
        # subject_id 必须是有效整数，否则 Bangumi API 返回 404
        try:
            subject_id = int(subject_id)
        except (TypeError, ValueError):
            return False, '无效的 subject_id'
        self._username_cache = None
        self._username_ts = 0
        username = self._bangumi_username(token)
        if not username:
            return False, 'Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取并在设置中保存'
        headers = self._bangumi_auth_headers(token)
        bases = [self._base_api()]
        alt = BANGUMI_API if self._base_api() != BANGUMI_API else BANGUMI_MIRROR_API
        if alt not in bases:
            bases.append(alt)
        # DELETE 操作用真实用户名优先（- 通配符对 DELETE 不可靠，会返回 404）
        usernames = [username, '-'] if username != '-' else ['-']
        auth_err = None
        other_err = None
        for base in bases:
            for uname in usernames:
                try:
                    url = f'{base}/v0/users/{uname}/collections/{subject_id}'
                    rsp = requests.request('DELETE', url, headers=headers, timeout=(5, 8), verify=True)
                    if 200 <= rsp.status_code < 300:
                        return True, 'ok'
                    # 404 在 DELETE 上视为「已不在收藏中」，幂等成功
                    if rsp.status_code == 404:
                        return True, 'ok (already not collected)'
                    msg = f'DELETE {url} -> {rsp.status_code}'
                    if rsp.status_code in (401, 403):
                        auth_err = msg
                    else:
                        other_err = msg
                except Exception as e:
                    other_err = f'DELETE {base}/v0/users/{uname}/collections/{subject_id} ERR {str(e)[:80]}'
        if auth_err:
            last = 'Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取并在设置中保存'
        else:
            last = other_err or '未知错误'
        logger.warning('[kazumi] bangumi collection delete failed: %s', last)
        return False, last

    # ---------------------------------------------------------------- 收藏批量同步（任务六 6.1）

    def _bangumi_all_collections(self, token, subject_type=2, per_page=100, page_delay=0.25):
        """获取当前用户【全部】收藏（分页遍历 5 种收藏类型 1..5）。

        对齐 Kazumi bangumi_api.dart getBangumiCollectibles：
          - 逐收藏类型（1想看 2看过 3在看 4搁置 5抛弃）分页拉取，每页 limit=100；
          - 依据响应 `total` 循环 offset += limit 直到取完；
          - 页间 250ms 限速（page_delay），单页失败（429/5xx/网络）容忍：小退避后中止该类型继续下一类型；
          - 返回按 subject_id 去重的合并列表（每项保留原始 subject/subject_id，并回填 type）。

        与 bangumi_user_collections（单页、上限 100）区别：本方法拉全量供同步用，不截断。"""
        token = self._normalize_bangumi_token(token)
        if not token:
            return []
        username = self._bangumi_username(token)
        if not username:
            logger.warning('[kazumi] bangumi all collections: 无法获取用户名（token 无效或网络失败）')
            return []
        per_page = max(1, min(int(per_page or 100), 100))
        headers = self._bangumi_auth_headers(token)
        base = self._base_api()
        merged = {}  # subject_id -> item（去重）
        url = f'{base}/v0/users/{username}/collections'
        for ctype in (1, 2, 3, 4, 5):
            offset = 0
            total = None
            while True:
                data = None
                for attempt in range(2):  # 单页最多 1 次退避重试（429/5xx）
                    try:
                        rsp = http_client.get(url, params={'subject_type': subject_type, 'type': ctype,
                                                         'limit': per_page, 'offset': offset},
                                           headers=headers, timeout=(5, 10), verify=True)
                        code = getattr(rsp, 'status_code', None)
                        if code in (401, 403):
                            logger.warning('[kazumi] bangumi collections page 401/403: Token 无效或已过期')
                            return []  # 鉴权失败直接终止，避免后续无效请求
                        if code == 429 or (isinstance(code, int) and 500 <= code < 600):
                            time.sleep(0.5)
                            continue  # 退避后重试本页
                        rsp.raise_for_status()
                        data = rsp.json() or {}
                        break
                    except Exception as e:
                        try:
                            resp = getattr(e, 'response', None)
                            code = getattr(resp, 'status_code', None)
                            if code in (401, 403):
                                logger.warning('[kazumi] bangumi collections page 401/403: Token 无效或已过期')
                                return []
                        except Exception:
                            pass
                        logger.warning('[kazumi] bangumi collections page failed type=%s offset=%s: %s',
                                       ctype, offset, e)
                        data = None
                        break
                if data is None:
                    break  # 本类型分页失败，容忍并继续下一类型
                rows = data.get('data', []) or []
                if total is None:
                    try:
                        total = int(data.get('total', 0) or 0)
                    except (TypeError, ValueError):
                        total = 0
                for it in rows:
                    sid = it.get('subject_id')
                    if sid is None:
                        continue
                    if it.get('type') is None:
                        it['type'] = ctype
                    merged[sid] = it
                offset += per_page
                if not rows or (total is not None and offset >= total):
                    break
                time.sleep(page_delay)  # Kazumi 风格页间限速
        return list(merged.values())

    def bangumi_sync_collections(self, token, local_favorites, priority='local', last_sync_at=0):
        """Kazumi 风格三方合并（collect_sync_merger.dart planBangumi）：拉取远端全量收藏，
        与本地收藏（已在渲染端解析出 subjectId + type）比对，生成同步计划。

        local_favorites: list[{subjectId|bangumiId, type(1-5), ts(unix), name}]
        priority: 冲突时优先方（'local' 本地覆盖远端 / 'remote' 远端保留）。
        last_sync_at: unix 秒；本地 ts < last_sync_at 且远端已存在的冲突视为「本地未改动」→ 远端胜（跳过上传）。

        返回 plan:
          upload   本地新增 + 冲突且本地胜（需上传的 {subjectId,type,name}）
          pull     远端独有（渲染端合并进网格用的原始远端条目）
          conflict 双方都有但 type 不同的明细（含 resolved: local/remote）
          skipped  已同步一致 + 冲突且远端胜 的计数（去重/增量的核心）"""
        token = self._normalize_bangumi_token(token)
        if not token:
            return {'upload': [], 'pull': [], 'conflict': [], 'skipped': 0,
                    'remoteTotal': 0, 'localTotal': len(local_favorites or []),
                    'error': '缺少 Bangumi token'}
        remote_list = self._bangumi_all_collections(token)
        # 若远端拉取因 401 返回空且 token 经校验无效，补 error 提示（_bangumi_all_collections 已在 401 时直接返回 []）
        # 为保证测试中 mock _bangumi_all_collections 时不误判，仅当 remote 为空且用户名确实获取失败时附加错误
        if not remote_list:
            # 轻量校验：尝试获取用户名，失败则视为 token 无效（避免把“空收藏”误判为鉴权失败，需同时满足本地有数据）
            if local_favorites and not self._bangumi_username(token):
                return {'upload': [], 'pull': [], 'conflict': [], 'skipped': 0,
                        'remoteTotal': 0, 'localTotal': len(local_favorites or []),
                        'error': 'Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取并在设置中保存'}
        remote = {}
        for it in remote_list:
            sid = it.get('subject_id')
            if sid is None:
                continue
            try:
                remote[str(sid)] = int(it.get('type') or 0)
            except (TypeError, ValueError):
                remote[str(sid)] = 0
        try:
            last_sync_at = float(last_sync_at or 0)
        except (TypeError, ValueError):
            last_sync_at = 0
        upload, conflict = [], []
        skipped = 0
        seen_local = set()
        for f in (local_favorites or []):
            sid = str(f.get('subjectId') or f.get('bangumiId') or '').strip()
            if not sid or sid == '0':
                continue
            try:
                ltype = int(f.get('type') or 0)
            except (TypeError, ValueError):
                ltype = 0
            if ltype <= 0:
                continue
            seen_local.add(sid)
            name = f.get('name', '')
            rtype = remote.get(sid)
            try:
                ts = float(f.get('ts') or 0)
            except (TypeError, ValueError):
                ts = 0
            if rtype is None:
                upload.append({'subjectId': sid, 'type': ltype, 'name': name})  # 本地独有
            elif rtype == ltype:
                skipped += 1  # 已同步且一致 → 跳过（去重）
            else:
                # 冲突：默认本地胜；但「本地未改动（ts<last_sync_at）」或 priority=remote 时远端胜
                local_wins = priority != 'remote' and not (last_sync_at and ts and ts < last_sync_at)
                conflict.append({'subjectId': sid, 'localType': ltype, 'remoteType': rtype,
                                 'resolved': 'local' if local_wins else 'remote'})
                if local_wins:
                    upload.append({'subjectId': sid, 'type': ltype, 'name': name})
                else:
                    skipped += 1
        pull = [it for it in remote_list if str(it.get('subject_id')) not in seen_local]
        return {'upload': upload, 'pull': pull, 'conflict': conflict, 'skipped': skipped,
                'remoteTotal': len(remote_list), 'localTotal': len(local_favorites or [])}

    def _bangumi_set_one(self, subject_id, ctype, headers, bases, usernames):
        """单条收藏写入（并发上传内部用）：沿用 bangumi_update_collection 的
        {POST,PUT} × usernames × bases 兜底逻辑，但用预解析好的 username/headers/bases，
        不重置用户名缓存（并发场景复用）。429/5xx 小退避后继续尝试其他组合。返回 (ok, msg)。"""
        import requests
        body = {'type': int(ctype)}
        auth_err = None
        other_err = None
        for base in bases:
            for uname in usernames:
                for method in ('POST', 'PUT'):
                    try:
                        url = f'{base}/v0/users/{uname}/collections/{subject_id}'
                        rsp = requests.request(method, url, json=body, headers=headers,
                                               timeout=(5, 8), verify=True)
                        if 200 <= rsp.status_code < 300:
                            return True, 'ok'
                        if rsp.status_code == 429 or 500 <= rsp.status_code < 600:
                            time.sleep(0.5)  # 限速/服务端错误：退避后继续兜底
                        msg = f'{method} {url} -> {rsp.status_code}'
                        if rsp.status_code in (401, 403):
                            auth_err = msg
                        else:
                            other_err = msg
                    except Exception as e:
                        other_err = f'{method} {base}/v0/users/{uname}/collections/{subject_id} ERR {str(e)[:80]}'
        if auth_err:
            return False, 'Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取并在设置中保存'
        return False, (other_err or '未知错误')

    def bangumi_apply_sync_plan(self, token, uploads, max_workers=3, op_delay=0.25):
        """并发执行同步计划的上传部分（ThreadPoolExecutor，max_workers≤3，每请求前 250ms 限速）。

        对齐 Kazumi async_serial_queue 的限速上传，但用有界并发提速。username 只解析一次并复用
        （不像 bangumi_update_collection 每条重置缓存），避免每条上传都打一次 /v0/me。
        uploads: list[{subjectId, type}]。返回 {uploaded, failed, results:[{subjectId,ok,msg}]}。"""
        token = self._normalize_bangumi_token(token)
        if not token:
            return {'uploaded': 0, 'failed': 0, 'results': [], 'error': '缺少 Bangumi token'}
        uploads = list(uploads or [])
        if not uploads:
            return {'uploaded': 0, 'failed': 0, 'results': []}
        username = self._bangumi_username(token)
        if not username:
            return {'uploaded': 0, 'failed': len(uploads), 'results': [], 'error': 'Bangumi Token 无效或已过期（401），请前往 https://bgm.tv/settings/token 重新获取并在设置中保存'}
        headers = self._bangumi_auth_headers(token)
        bases = [self._base_api()]
        alt = BANGUMI_API if self._base_api() != BANGUMI_API else BANGUMI_MIRROR_API
        if alt not in bases:
            bases.append(alt)
        usernames = ['-', username] if username != '-' else ['-']

        def _apply(item):
            sid = item.get('subjectId') or item.get('id')
            try:
                ctype = int(item.get('type') or 0)
            except (TypeError, ValueError):
                ctype = 0
            if not sid or ctype <= 0:
                return {'subjectId': sid, 'ok': False, 'msg': 'invalid item'}
            time.sleep(op_delay)  # 每 worker 请求前限速（3 worker 稳态 ≈ 每 250ms 一批，尊重 ~5 req/s）
            ok, msg = self._bangumi_set_one(sid, ctype, headers, bases, usernames)
            return {'subjectId': sid, 'ok': ok, 'msg': msg}

        results = []
        uploaded = 0
        failed = 0
        workers = max(1, min(int(max_workers or 3), 3))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for r in pool.map(_apply, uploads):
                results.append(r)
                if r['ok']:
                    uploaded += 1
                else:
                    failed += 1
        return {'uploaded': uploaded, 'failed': failed, 'results': results}

    # ---------------------------------------------------------------- 弹弹 play 弹幕

    def _dandan_creds(self):
        """DanDanPlay AppId/AppSecret：优先读环境变量（构建注入），其次运行时环境（主进程按设置注入并重启后端）。
        运行时动态读取，便于用户在设置里填入凭据后重启后端即生效（不再依赖模块加载时的常量）。"""
        appid = os.environ.get('DANDANAPI_APPID', '') or DANDAN_APPID
        key = os.environ.get('DANDANAPI_KEY', '') or DANDAN_KEY
        return appid, key

    def _dandan_signature(self, path, timestamp):
        """弹弹 play API 签名（HMAC-SHA256）。"""
        import hashlib
        import base64
        appid, key = self._dandan_creds()
        if not appid or not key:
            return ''
        data = appid + str(timestamp) + path + key
        digest = hashlib.sha256(data.encode('utf-8')).digest()
        return base64.b64encode(digest).decode('utf-8')

    def danmaku_search(self, title):
        """弹弹 play 番剧搜索（获取 DanDanBangumiID）。"""
        import time
        appid, key = self._dandan_creds()
        if not appid or not key:
            logger.warning('[kazumi] danmaku: missing DANDANAPI_APPID/DANDANAPI_KEY')
            return []
        try:
            ts = int(time.time())
            path = '/api/v2/search/anime'
            headers = {
                'X-AppId': appid,
                'X-Timestamp': str(ts),
                'X-Signature': self._dandan_signature(path, ts),
                'X-Auth': '1',
            }
            rsp = http_client.get(
                f'{DANDAN_API}{path}',
                params={'keyword': title},
                headers=headers,
                timeout=10,
                verify=True,
            )
            rsp.raise_for_status()
            data = rsp.json()
            return data.get('animes', []) or []
        except Exception as e:
            logger.warning('[kazumi] danmaku search failed: %s', e)
            return []

    def danmaku_get_episode_id(self, bangumi_id, episode):
        """从 Bangumi ID 获取弹弹 play 分集弹幕 ID。"""
        import time
        appid, key = self._dandan_creds()
        if not appid or not key:
            return 0
        try:
            ts = int(time.time())
            path = f'/api/v2/bangumi/bgmtv/{bangumi_id}'
            headers = {
                'X-AppId': appid,
                'X-Timestamp': str(ts),
                'X-Signature': self._dandan_signature(path, ts),
                'X-Auth': '1',
            }
            rsp = http_client.get(
                f'{DANDAN_API}{path}',
                headers=headers,
                timeout=10,
                verify=True,
            )
            rsp.raise_for_status()
            data = rsp.json()
            # 弹弹 play 分集命名规则：bangumiId * 10000 + episode
            return bangumi_id * 10000 + episode
        except Exception as e:
            logger.warning('[kazumi] danmaku episode id failed: %s', e)
            return 0

    def danmaku_get_comments(self, episode_id):
        """获取弹幕评论（弹弹 play）。"""
        import time
        appid, key = self._dandan_creds()
        if not appid or not key:
            return []
        try:
            ts = int(time.time())
            path = f'/api/v2/comment/{episode_id}'
            headers = {
                'X-AppId': appid,
                'X-Timestamp': str(ts),
                'X-Signature': self._dandan_signature(path, ts),
                'X-Auth': '1',
            }
            rsp = http_client.get(
                f'{DANDAN_API}{path}',
                params={'withRelated': 'true'},
                headers=headers,
                timeout=10,
                verify=True,
            )
            rsp.raise_for_status()
            data = rsp.json()
            return data.get('comments', []) or []
        except Exception as e:
            logger.warning('[kazumi] danmaku comments failed: %s', e)
            return []

    # ---------------------------------------------------------------- WebDAV 同步

    def webdav_sync(self, webdav_url, username, password, data):
        """WebDAV 同步（收藏/历史/规则上传到远程）。"""
        import requests
        from requests.auth import HTTPBasicAuth
        try:
            auth = HTTPBasicAuth(username, password) if username else None
            # 确保同步目录存在
            sync_dir = f'{webdav_url.rstrip("/")}{WEBDAV_SYNC_ROOT}'
            try:
                requests.request('MKCOL', sync_dir, auth=auth, timeout=10, verify=True)
            except Exception:
                pass  # 目录可能已存在
            # 上传数据文件
            for name, content in data.items():
                file_url = f'{sync_dir}/{name}.json'
                rsp = requests.put(
                    file_url,
                    data=json.dumps(content, ensure_ascii=False).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    auth=auth,
                    timeout=15,
                    verify=True,
                )
                rsp.raise_for_status()
            logger.info('[kazumi] webdav sync ok: %d files', len(data))
            return True
        except Exception as e:
            logger.warning('[kazumi] webdav sync failed: %s', e)
            return False

    def webdav_restore(self, webdav_url, username, password, names):
        """WebDAV 恢复（从远程下载收藏/历史/规则）。

        返回 {'files': {name: data}, 'ok': bool, 'error': str}：
        - 单个文件 404 视为「云端没有该数据」（从未同步过对应项），不算失败；
        - 连接失败/DNS 错误/非 404 的 HTTP 错误 → ok=False + error 原因。
        此前逐文件吞异常、空结果也当成功返回，网址输错时渲染层提示「恢复完成」。
        """
        from requests.auth import HTTPBasicAuth
        result = {'files': {}, 'ok': False, 'error': ''}
        try:
            auth = HTTPBasicAuth(username, password) if username else None
            sync_dir = f'{webdav_url.rstrip("/")}{WEBDAV_SYNC_ROOT}'
            for name in names:
                file_url = f'{sync_dir}/{name}.json'
                try:
                    rsp = http_client.get(file_url, auth=auth, timeout=15, verify=True)
                except Exception as e:
                    result['error'] = f'{name}: {e}'
                    logger.warning('[kazumi] webdav restore failed: %s', result['error'])
                    return result
                if rsp.status_code == 200:
                    try:
                        result['files'][name] = rsp.json()
                    except Exception as e:
                        result['error'] = f'{name}: 响应不是有效 JSON ({e})'
                        logger.warning('[kazumi] webdav restore failed: %s', result['error'])
                        return result
                elif rsp.status_code == 404:
                    continue  # 云端没有该数据，跳过（其余文件仍可恢复）
                else:
                    result['error'] = f'{name}: HTTP {rsp.status_code}'
                    logger.warning('[kazumi] webdav restore failed: %s', result['error'])
                    return result
            if not result['files']:
                result['error'] = '云端没有找到任何可恢复的数据（请先「同步到云端」）'
                logger.warning('[kazumi] webdav restore: nothing to restore')
                return result
            result['ok'] = True
            logger.info('[kazumi] webdav restore ok: %d files', len(result['files']))
            return result
        except Exception as e:
            result['error'] = str(e)
            logger.warning('[kazumi] webdav restore failed: %s', e)
            return result

    # ---------------------------------------------------------------- 在线规则商店

    # catalog 缓存（5 分钟 TTL，避免安装规则时重复拉取）
    _shop_catalog_cache = None
    _shop_catalog_ts = 0

    def fetch_shop_catalog(self):
        """从 KazumiRules 仓库拉取规则目录（index.json），5 分钟缓存。
        镜像开关（enable_git_proxy）开启时强制 GitCode 镜像；关闭时按「GitCode 优先、GitHub 备用」的双地址容错。"""
        import time
        now = time.time()
        if self._shop_catalog_cache and now - self._shop_catalog_ts < 300:
            return self._shop_catalog_cache
        if self.enable_git_proxy:
            urls = ['https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/raw/main/index.json']
        else:
            urls = [
                'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/raw/main/index.json',
                'https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json',
            ]
        for url in urls:
            try:
                rsp = http_client.get(url, timeout=10, verify=True)
                rsp.raise_for_status()
                data = rsp.json()
                logger.info('[kazumi] shop catalog loaded: %d rules from %s', len(data), url)
                self._shop_catalog_cache = data
                self._shop_catalog_ts = now
                return data
            except Exception as e:
                logger.warning('[kazumi] shop catalog %s failed: %s', url, e)
        return []

    def fetch_shop_rule(self, name):
        """从 KazumiRules 仓库下载单个规则；镜像开关开启时强制 GitCode 镜像。"""
        # M-25：name 来自请求参数，直接拼进仓库 URL——basename + 白名单字符，
        # 防 ../ 路径注入与特殊字符
        name = os.path.basename(str(name).strip())
        if not name or not re.match(r'^[\w\u4e00-\u9fa5.-]+$', name):
            raise ValueError(f'bad rule name: {name!r}')
        if self.enable_git_proxy:
            urls = [f'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/raw/main/{name}.json']
        else:
            urls = [
                f'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/raw/main/{name}.json',
                f'https://raw.githubusercontent.com/Predidit/KazumiRules/main/{name}.json',
            ]
        for url in urls:
            try:
                rsp = http_client.get(url, timeout=10, verify=True)
                rsp.raise_for_status()
                plugin = Plugin.from_json(rsp.json())
                plugin.validate()   # M-25：下载后先校验再返回（防坏规则入库）
                return plugin
            except Exception as e:
                logger.warning('[kazumi] shop rule %s from %s failed: %s', name, url, e)
        return None
