# -*- coding: utf-8 -*-
"""Kazumi 规则管理器：规则 CRUD、持久化、启用/禁用。

持久化：~/.video-pc/kazumi/plugins.json（单文件存储全部规则）。
线程安全：threading.Lock 保护规则列表读写。
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

from .plugin import Plugin
from .utils import NoResultException, CaptchaRequiredException

logger = logging.getLogger('vpc.kazumi.manager')

# 内置默认规则目录（随应用打包，首次启动自动导入）
_BUILTIN_RULES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')

# Bangumi API 端点（对齐 Kazumi api_endpoints.dart：bangumiAPIDomain / bangumiAPINextDomain）
# 2026-08-09 按用户要求从 bangumi.lol 镜像改回官方域名 api.bgm.tv / next.bgm.tv
# （api.bangumi.tv 域名已被占用/不可达，官方 API 主机实为 api.bgm.tv）。
# api.kazumi.fyi 为 Kazumi 官方镜像，留作签名镜像兜底。
BANGUMI_API = 'https://api.bgm.tv'
BANGUMI_API_NEXT = 'https://next.bgm.tv'
# 全域名反代镜像（bangumi.lol，对齐镜像站说明：api.bgm.tv → api.bangumi.lol，next.bgm.tv → next.bangumi.lol）
BANGUMI_MIRROR_API = 'https://api.bangumi.lol'
BANGUMI_MIRROR_NEXT = 'https://next.bangumi.lol'
BANGUMI_MIRROR = 'https://api.kazumi.fyi'  # 旧 kazumi 专属镜像（仅部分路径），保留常量向后兼容
# bangumi 官方 API 的 WAF 会拦截 python-requests 默认 UA（部分端点直接 403），必须带应用 UA
BANGUMI_UA = 'video-pc/0.1.0 (https://github.com/); kazumi'

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

    @staticmethod
    def _now():
        """当前时间字符串（ISO-8601 本地时间）。"""
        return time.strftime('%Y-%m-%d %H:%M:%S')

    # ---------------------------------------------------------------- 镜像源（4.1）

    def _base_api(self):
        """api.bgm.tv 类接口基址：镜像开启时走全域名反代 api.bangumi.lol（无需签名，全路径可用）。"""
        return BANGUMI_MIRROR_API if self.enable_bangumi_proxy else BANGUMI_API

    def _base_next(self):
        """next.bgm.tv 类接口基址：镜像开启时走 next.bangumi.lol。"""
        return BANGUMI_MIRROR_NEXT if self.enable_bangumi_proxy else BANGUMI_API_NEXT

    def set_mirror(self, bangumi=None, git=None):
        """设置镜像开关（持久化到后端内存）；返回当前状态。"""
        with self._lock:
            if bangumi is not None:
                self.enable_bangumi_proxy = bool(bangumi)
            if git is not None:
                self.enable_git_proxy = bool(git)
        return {'bangumi': self.enable_bangumi_proxy, 'git': self.enable_git_proxy}

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
        import requests
        try:
            body = {
                'keyword': keyword,
                'sort': 'heat',
                'filter': {'type': [2], 'tag': [], 'rank': ['>=0', '<=99999'], 'nsfw': False},
            }
            rsp = requests.post(
                f'{self._base_api()}/v0/search/subjects',
                params={'limit': limit, 'offset': 0},
                json=body,
                headers={'User-Agent': BANGUMI_UA},
                timeout=(5, 10),
                verify=False,
            )
            rsp.raise_for_status()
            data = rsp.json()
            items = data.get('data', []) if isinstance(data, dict) else data
            return items or []
        except Exception as e:
            logger.warning('[kazumi] bangumi search failed: %s', e)
            return []

    def bangumi_info(self, subject_id):
        """Bangumi 番剧详情（api.bgm.tv）。"""
        import requests
        try:
            rsp = requests.get(
                f'{self._base_api()}/v0/subjects/{subject_id}',
                headers={'User-Agent': BANGUMI_UA},
                timeout=(5, 8),
                verify=False,
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
        import requests
        for attempt in range(3):
            try:
                rsp = requests.get(
                    f'{self._base_next()}/p1/calendar',
                    headers={'User-Agent': BANGUMI_UA},
                    timeout=(5, 8),  # 连接 5s，读取 8s
                    verify=False,
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
        镜像开启时经 _base_api() 走全域名反代 api.bangumi.lol（免签名，全路径可用）。
        start/end 形如 YYYY-MM-DD；失败或无结果返回 []。"""
        import requests
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
                rsp = requests.post(
                    f'{self._base_api()}/v0/search/subjects',
                    params={'limit': page_size, 'offset': page * page_size},
                    json=body,
                    headers={'User-Agent': BANGUMI_UA},
                    timeout=(5, 10),
                    verify=False,
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
        镜像开启时经 _base_next() 走全域名反代 next.bangumi.lol（免签名，全路径可用）。
        注意：该端点必须传 type/limit/offset，否则返回 400。"""
        import requests
        # 官方/镜像趋势（镜像开启时 _base_next() 指向 next.bangumi.lol）
        try:
            rsp = requests.get(
                f'{self._base_next()}/p1/trending/subjects',
                params={'type': 2, 'limit': limit, 'offset': offset},
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=False,
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
        import requests
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
            rsp = requests.post(
                f'{self._base_api()}/v0/search/subjects',
                params={'limit': limit, 'offset': offset},
                json=body,
                headers={'User-Agent': BANGUMI_UA},
                timeout=(5, 10),
                verify=False,
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
        import requests
        try:
            rsp = requests.get(
                f'{self._base_api()}/v0/episodes',
                params={'subject_id': subject_id},
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi episodes failed: %s', e)
            return None

    def bangumi_characters(self, subject_id):
        """Bangumi 番剧角色信息（api.bgm.tv）。"""
        import requests
        try:
            rsp = requests.get(
                f'{self._base_api()}/v0/subjects/{subject_id}/characters',
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi characters failed: %s', e)
            return []

    def bangumi_character_detail(self, character_id):
        """单个角色详情（api.bgm.tv /v0/characters/{id}）：资料 + 简介。"""
        import requests
        try:
            rsp = requests.get(
                f'{self._base_api()}/v0/characters/{character_id}',
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi character detail failed: %s', e)
            return None

    def bangumi_staff(self, subject_id):
        """Bangumi 番剧制作人员（api.bgm.tv）。"""
        import requests
        try:
            rsp = requests.get(
                f'{self._base_api()}/v0/subjects/{subject_id}/persons',
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi staff failed: %s', e)
            return []

    def bangumi_comments(self, subject_id, limit=20, offset=0):
        """Bangumi 番剧评论（next.bgm.tv）。"""
        import requests
        try:
            rsp = requests.get(
                f'{self._base_next()}/p1/subjects/{subject_id}/comments',
                params={'limit': limit, 'offset': offset},
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi comments failed: %s', e)
            return []

    def bangumi_relations(self, subject_id):
        """Bangumi 番剧关联（前传/续作链，api.bgm.tv）。"""
        import requests
        try:
            rsp = requests.get(
                f'{self._base_api()}/v0/subjects/{subject_id}/subjects',
                headers={'User-Agent': BANGUMI_UA},
                timeout=10,
                verify=False,
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
    def _bangumi_auth_headers(token):
        """带 token 的鉴权头（Bangumi API 要求 User-Agent + Bearer）。"""
        return {
            'Authorization': f'Bearer {token}',
            'User-Agent': BANGUMI_UA,
        }

    def bangumi_me(self, token):
        """当前用户信息（需 token；返回 None 表示 token 无效或网络失败）。"""
        import requests
        if not token:
            return None
        try:
            rsp = requests.get(f'{self._base_api()}/v0/me',
                               headers=self._bangumi_auth_headers(token), timeout=(5, 8), verify=False)
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
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
        import requests
        if not token:
            return []
        limit = max(1, min(int(limit or 100), 100))
        username = self._bangumi_username(token)
        if not username:
            logger.warning('[kazumi] bangumi collections: 无法获取用户名（token 无效或网络失败）')
            return []
        try:
            rsp = requests.get(f'{self._base_api()}/v0/users/{username}/collections',
                               params={'subject_type': subject_type, 'limit': limit, 'offset': offset},
                               headers=self._bangumi_auth_headers(token), timeout=(5, 10), verify=False)
            rsp.raise_for_status()
            data = rsp.json()
            return data.get('data', []) or []
        except Exception as e:
            logger.warning('[kazumi] bangumi collections failed: %s', e)
            return []

    def bangumi_collection(self, token, subject_id):
        """单个 subject 的收藏状态；未收藏返回 None。"""
        import requests
        if not token:
            return None
        username = self._bangumi_username(token)
        if not username:
            logger.warning('[kazumi] bangumi collection get: 无法获取用户名（token 无效）')
            return None
        try:
            rsp = requests.get(f'{self._base_api()}/v0/users/{username}/collections/{subject_id}',
                               headers=self._bangumi_auth_headers(token), timeout=(5, 8), verify=False)
            if rsp.status_code == 404:
                return None
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi collection get failed: %s', e)
            return None

    def bangumi_update_collection(self, token, subject_id, collection_type):
        """设置/更新收藏类型（对齐 Kazumi updateBangumiById：POST /v0/users/-/collections/{id}）。

        依次尝试 {POST, PUT} × {`-` 通配当前用户, 真实用户名} × {当前基址, 官方/镜像另一基址}，
        首个 2xx 即成功。Bangumi 官方与镜像均支持 `-` 通配（需有效 token）；POST 为 Kazumi 原版
        写法（PUT 等价）；真实用户名 GET 收藏正常，但写接口在个别镜像/网络下返回 404，故都覆盖。
        type: 0想看 1看过 2在看 3搁置 4抛弃（Bangumi 收藏类型）。返回 (ok, msg)。"""
        import requests
        if not token:
            return False, '缺少 Bangumi token'
        # 先验证 token 有效性，刷新 username 缓存
        self._username_cache = None
        self._username_ts = 0
        username = self._bangumi_username(token)
        if not username:
            return False, 'Bangumi token 无效或网络不可达，请检查设置中的 Token'
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
                        rsp = requests.request(method, url, json=body, headers=headers, timeout=(5, 8), verify=False)
                        if rsp.status_code in (200, 201, 204):
                            return True, 'ok'
                        msg = f'{method} {url} -> {rsp.status_code}'
                        if rsp.status_code in (401, 403):
                            auth_err = msg
                        else:
                            other_err = msg
                    except Exception as e:
                        msg = f'{method} {base}/v0/users/{uname}/collections/{subject_id} ERR {str(e)[:80]}'
                        other_err = msg
        last = auth_err or other_err or '未知错误'
        logger.warning('[kazumi] bangumi collection update failed: %s', last)
        return False, last

    def bangumi_delete_collection(self, token, subject_id):
        """删除收藏（对齐 Kazumi deleteBangumiById：DELETE /v0/users/-/collections/{id}）。返回 (ok, msg)。"""
        import requests
        if not token:
            return False, '缺少 Bangumi token'
        self._username_cache = None
        self._username_ts = 0
        username = self._bangumi_username(token)
        if not username:
            return False, 'Bangumi token 无效或网络不可达'
        headers = self._bangumi_auth_headers(token)
        bases = [self._base_api()]
        alt = BANGUMI_API if self._base_api() != BANGUMI_API else BANGUMI_MIRROR_API
        if alt not in bases:
            bases.append(alt)
        usernames = ['-', username] if username != '-' else ['-']
        auth_err = None
        other_err = None
        for base in bases:
            for uname in usernames:
                try:
                    url = f'{base}/v0/users/{uname}/collections/{subject_id}'
                    rsp = requests.request('DELETE', url, headers=headers, timeout=(5, 8), verify=False)
                    if rsp.status_code in (200, 201, 204):
                        return True, 'ok'
                    msg = f'DELETE {url} -> {rsp.status_code}'
                    if rsp.status_code in (401, 403):
                        auth_err = msg
                    else:
                        other_err = msg
                except Exception as e:
                    other_err = f'DELETE {base}/v0/users/{uname}/collections/{subject_id} ERR {str(e)[:80]}'
        last = auth_err or other_err or '未知错误'
        logger.warning('[kazumi] bangumi collection delete failed: %s', last)
        return False, last

    # ---------------------------------------------------------------- 弹弹 play 弹幕

    def _dandan_signature(self, path, timestamp):
        """弹弹 play API 签名（HMAC-SHA256）。"""
        import hashlib
        import base64
        if not DANDAN_APPID or not DANDAN_KEY:
            return ''
        data = DANDAN_APPID + str(timestamp) + path + DANDAN_KEY
        digest = hashlib.sha256(data.encode('utf-8')).digest()
        return base64.b64encode(digest).decode('utf-8')

    def danmaku_search(self, title):
        """弹弹 play 番剧搜索（获取 DanDanBangumiID）。"""
        import requests
        import time
        if not DANDAN_APPID or not DANDAN_KEY:
            logger.warning('[kazumi] danmaku: missing DANDANAPI_APPID/DANDANAPI_KEY')
            return []
        try:
            ts = int(time.time())
            path = '/api/v2/search/anime'
            headers = {
                'X-AppId': DANDAN_APPID,
                'X-Timestamp': str(ts),
                'X-Signature': self._dandan_signature(path, ts),
                'X-Auth': '1',
            }
            rsp = requests.get(
                f'{DANDAN_API}{path}',
                params={'keyword': title},
                headers=headers,
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            data = rsp.json()
            return data.get('animes', []) or []
        except Exception as e:
            logger.warning('[kazumi] danmaku search failed: %s', e)
            return []

    def danmaku_get_episode_id(self, bangumi_id, episode):
        """从 Bangumi ID 获取弹弹 play 分集弹幕 ID。"""
        import requests
        import time
        if not DANDAN_APPID or not DANDAN_KEY:
            return 0
        try:
            ts = int(time.time())
            path = f'/api/v2/bangumi/bgmtv/{bangumi_id}'
            headers = {
                'X-AppId': DANDAN_APPID,
                'X-Timestamp': str(ts),
                'X-Signature': self._dandan_signature(path, ts),
                'X-Auth': '1',
            }
            rsp = requests.get(
                f'{DANDAN_API}{path}',
                headers=headers,
                timeout=10,
                verify=False,
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
        import requests
        import time
        if not DANDAN_APPID or not DANDAN_KEY:
            return []
        try:
            ts = int(time.time())
            path = f'/api/v2/comment/{episode_id}'
            headers = {
                'X-AppId': DANDAN_APPID,
                'X-Timestamp': str(ts),
                'X-Signature': self._dandan_signature(path, ts),
                'X-Auth': '1',
            }
            rsp = requests.get(
                f'{DANDAN_API}{path}',
                params={'withRelated': 'true'},
                headers=headers,
                timeout=10,
                verify=False,
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
                requests.request('MKCOL', sync_dir, auth=auth, timeout=10, verify=False)
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
                    verify=False,
                )
                rsp.raise_for_status()
            logger.info('[kazumi] webdav sync ok: %d files', len(data))
            return True
        except Exception as e:
            logger.warning('[kazumi] webdav sync failed: %s', e)
            return False

    def webdav_restore(self, webdav_url, username, password, names):
        """WebDAV 恢复（从远程下载收藏/历史/规则）。"""
        import requests
        from requests.auth import HTTPBasicAuth
        result = {}
        try:
            auth = HTTPBasicAuth(username, password) if username else None
            sync_dir = f'{webdav_url.rstrip("/")}{WEBDAV_SYNC_ROOT}'
            for name in names:
                file_url = f'{sync_dir}/{name}.json'
                try:
                    rsp = requests.get(file_url, auth=auth, timeout=15, verify=False)
                    if rsp.status_code == 200:
                        result[name] = rsp.json()
                except Exception:
                    pass
            logger.info('[kazumi] webdav restore ok: %d files', len(result))
        except Exception as e:
            logger.warning('[kazumi] webdav restore failed: %s', e)
        return result

    # ---------------------------------------------------------------- 在线规则商店

    # catalog 缓存（5 分钟 TTL，避免安装规则时重复拉取）
    _shop_catalog_cache = None
    _shop_catalog_ts = 0

    def fetch_shop_catalog(self):
        """从 KazumiRules 仓库拉取规则目录（index.json），5 分钟缓存。"""
        import time
        now = time.time()
        if self._shop_catalog_cache and now - self._shop_catalog_ts < 300:
            return self._shop_catalog_cache
        import requests
        # 优先 GitCode 镜像（国内可达），GitHub 作为备用
        urls = [
            'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/raw/main/index.json',
            'https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json',
        ]
        for url in urls:
            try:
                rsp = requests.get(url, timeout=10, verify=False)
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
        """从 KazumiRules 仓库下载单个规则，优先 GitCode 镜像。"""
        import requests
        urls = [
            f'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/raw/main/{name}.json',
            f'https://raw.githubusercontent.com/Predidit/KazumiRules/main/{name}.json',
        ]
        for url in urls:
            try:
                rsp = requests.get(url, timeout=10, verify=False)
                rsp.raise_for_status()
                return Plugin.from_json(rsp.json())
            except Exception as e:
                logger.warning('[kazumi] shop rule %s from %s failed: %s', name, url, e)
        return None
