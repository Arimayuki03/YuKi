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

import hoststate

from .plugin import Plugin
from .utils import NoResultException, CaptchaRequiredException

logger = logging.getLogger('vpc.kazumi.manager')

# 内置默认规则目录（随应用打包，首次启动自动导入）
_BUILTIN_RULES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')

# Bangumi API 端点（对齐 Kazumi api_endpoints.dart）
# 2026-06 起 bgm.tv/bangumi.tv/chii.in 在国内被屏蔽，统一切到 bangumi.lol 镜像
# （api.bangumi.lol / next.bangumi.lol），api.kazumi.fyi 留作签名镜像兜底
BANGUMI_API = 'https://api.bangumi.lol'
BANGUMI_API_NEXT = 'https://next.bangumi.lol'
BANGUMI_MIRROR = 'https://api.bangumi.lol'

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
        self._task_lock = threading.Lock()   # 保护有效性检测/批量更新的运行状态
        self._validity_running = False
        self._validity_results = []          # list[{'name','validity','msg'}]
        self._update_running = False
        self._update_results = []            # list[{'name','ok','msg','oldVersion','newVersion','updated'}]
        self._load()
        self._import_builtin_rules()

    @staticmethod
    def _now():
        """当前时间字符串（ISO-8601 本地时间）。"""
        return time.strftime('%Y-%m-%d %H:%M:%S')

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

    def check_validity(self, engine, keyword='海贼王', names=None, max_workers=4):
        """对启用规则执行有效性检测（搜索测试关键词），同步执行，返回结果列表。

        engine: RuleEngine 实例；names: 指定规则名（不传则检测全部启用规则）。
        每个规则用 ThreadPoolExecutor 并发搜索，写回 validity 与 validity_checked_at。
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
                results.append({'name': name, 'validity': status, 'msg': msg})
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

        def _worker():
            try:
                self._validity_results = self.check_validity(engine, keyword=keyword, names=names)
            except Exception as e:
                logger.warning('[kazumi] validity check error: %s', e)
            finally:
                with self._task_lock:
                    self._validity_running = False

        threading.Thread(target=_worker, daemon=True).start()
        return True

    def validity_status(self):
        with self._task_lock:
            return {'running': self._validity_running, 'results': list(self._validity_results)}

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

    def batch_update(self, names=None, max_workers=4):
        """批量更新规则（从商店拉取最新版，4 并发），同步执行，返回结果列表。

        对每个已安装规则：拉取商店最新版 → 版本较新则 add() 覆盖（保留安装时间）。
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
            results = list(pool.map(_update_one, targets))
        logger.info('[kazumi] batch update done: %d rules', len(results))
        return results

    def start_batch_update(self, names=None):
        """后台启动批量更新；返回 True 表示已启动，False 表示已有更新在跑。"""
        with self._task_lock:
            if self._update_running:
                return False
            self._update_running = True
            self._update_results = []

        def _worker():
            try:
                self._update_results = self.batch_update(names=names)
            except Exception as e:
                logger.warning('[kazumi] batch update error: %s', e)
            finally:
                with self._task_lock:
                    self._update_running = False

        threading.Thread(target=_worker, daemon=True).start()
        return True

    def update_status(self):
        with self._task_lock:
            return {'running': self._update_running, 'results': list(self._update_results)}

    # ---------------------------------------------------------------- Bangumi 元数据

    def bangumi_search(self, keyword, limit=10):
        """Bangumi 番剧搜索（next.bangumi.lol）。"""
        import requests
        try:
            rsp = requests.get(
                f'{BANGUMI_API_NEXT}/p1/search/subjects',
                params={'limit': limit, 'offset': 0, 'keyword': keyword},
                timeout=(5, 8),
                verify=False,
            )
            rsp.raise_for_status()
            data = rsp.json()
            return data.get('data', []) or []
        except Exception as e:
            logger.warning('[kazumi] bangumi search failed: %s', e)
            return []

    def bangumi_info(self, subject_id):
        """Bangumi 番剧详情（api.bangumi.lol）。"""
        import requests
        try:
            rsp = requests.get(
                f'{BANGUMI_API}/v0/subjects/{subject_id}',
                timeout=(5, 8),
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi info failed: %s', e)
            return None

    def bangumi_calendar(self):
        """Bangumi 每日放送（next.bangumi.lol），带重试。"""
        import requests
        for attempt in range(3):
            try:
                rsp = requests.get(
                    f'{BANGUMI_API_NEXT}/p1/calendar',
                    timeout=(5, 8),  # 连接 5s，读取 8s
                    verify=False,
                )
                rsp.raise_for_status()
                return rsp.json()
            except Exception as e:
                logger.warning('[kazumi] bangumi calendar attempt %d failed: %s', attempt + 1, e)
                if attempt < 2:
                    import time
                    time.sleep(2)
        return []

    def bangumi_trends(self):
        """Bangumi 番剧趋势榜单（next.bangumi.lol）。"""
        import requests
        try:
            rsp = requests.get(
                f'{BANGUMI_API_NEXT}/p1/trending/subjects',
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi trends failed: %s', e)
            return []

    def bangumi_episodes(self, subject_id):
        """Bangumi 番剧分集信息（api.bangumi.lol）。"""
        import requests
        try:
            rsp = requests.get(
                f'{BANGUMI_API}/v0/episodes',
                params={'subject_id': subject_id},
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi episodes failed: %s', e)
            return None

    def bangumi_characters(self, subject_id):
        """Bangumi 番剧角色信息（api.bangumi.lol）。"""
        import requests
        try:
            rsp = requests.get(
                f'{BANGUMI_API}/v0/subjects/{subject_id}/characters',
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi characters failed: %s', e)
            return []

    def bangumi_staff(self, subject_id):
        """Bangumi 番剧制作人员（api.bangumi.lol）。"""
        import requests
        try:
            rsp = requests.get(
                f'{BANGUMI_API}/v0/subjects/{subject_id}/persons',
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi staff failed: %s', e)
            return []

    def bangumi_comments(self, subject_id, limit=20, offset=0):
        """Bangumi 番剧评论（next.bangumi.lol）。"""
        import requests
        try:
            rsp = requests.get(
                f'{BANGUMI_API_NEXT}/p1/subjects/{subject_id}/comments',
                params={'limit': limit, 'offset': offset},
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi comments failed: %s', e)
            return []

    def bangumi_relations(self, subject_id):
        """Bangumi 番剧关联（前传/续作链，api.bangumi.lol）。"""
        import requests
        try:
            rsp = requests.get(
                f'{BANGUMI_API}/v0/subjects/{subject_id}/subjects',
                timeout=10,
                verify=False,
            )
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi relations failed: %s', e)
            return []

    # ---------------------------------------------------------------- Bangumi 用户收藏同步

    # 收藏类型：0 想看 / 1 看过 / 2 在看 / 3 搁置 / 4 抛弃
    BANGUMI_COLLECTION_TYPES = {0: '想看', 1: '看过', 2: '在看', 3: '搁置', 4: '抛弃'}

    @staticmethod
    def _bangumi_auth_headers(token):
        """带 token 的鉴权头（Bangumi API 要求 User-Agent + Bearer）。"""
        return {
            'Authorization': f'Bearer {token}',
            'User-Agent': 'video-pc/0.1.0 (https://github.com/); kazumi',
        }

    def bangumi_me(self, token):
        """当前用户信息（需 token；返回 None 表示 token 无效或网络失败）。"""
        import requests
        if not token:
            return None
        try:
            rsp = requests.get(f'{BANGUMI_API}/v0/me',
                               headers=self._bangumi_auth_headers(token), timeout=(5, 8), verify=False)
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi me failed: %s', e)
            return None

    def bangumi_user_collections(self, token, subject_type=2, limit=100, offset=0):
        """当前用户收藏列表（subject_type=2 动画），条目含 subject_id/type/name。"""
        import requests
        if not token:
            return []
        try:
            rsp = requests.get(f'{BANGUMI_API}/v0/users/-/collections',
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
        try:
            rsp = requests.get(f'{BANGUMI_API}/v0/users/-/collections/{subject_id}',
                               headers=self._bangumi_auth_headers(token), timeout=(5, 8), verify=False)
            if rsp.status_code == 404:
                return None
            rsp.raise_for_status()
            return rsp.json()
        except Exception as e:
            logger.warning('[kazumi] bangumi collection get failed: %s', e)
            return None

    def bangumi_update_collection(self, token, subject_id, collection_type):
        """设置/更新收藏类型（对齐 updateBangumiById）；type: 0想看 1看过 2在看 3搁置 4抛弃。
        PUT 创建或更新均适用；失败回退 POST（个别实现二者接口语义不同）。返回 (ok, msg)。"""
        import requests
        if not token:
            return False, '缺少 Bangumi token'
        body = {'type': int(collection_type)}
        headers = self._bangumi_auth_headers(token)
        last = None
        for method in ('PUT', 'POST'):
            try:
                rsp = requests.request(method, f'{BANGUMI_API}/v0/users/-/collections/{subject_id}',
                                       json=body, headers=headers, timeout=(5, 8), verify=False)
                rsp.raise_for_status()
                return True, 'ok'
            except Exception as e:
                last = e
        logger.warning('[kazumi] bangumi collection update failed: %s', last)
        return False, str(last)[:80]

    def bangumi_delete_collection(self, token, subject_id):
        """删除收藏。返回 (ok, msg)。"""
        import requests
        if not token:
            return False, '缺少 Bangumi token'
        try:
            rsp = requests.delete(f'{BANGUMI_API}/v0/users/-/collections/{subject_id}',
                                  headers=self._bangumi_auth_headers(token), timeout=(5, 8), verify=False)
            rsp.raise_for_status()
            return True, 'ok'
        except Exception as e:
            logger.warning('[kazumi] bangumi collection delete failed: %s', e)
            return False, str(e)[:80]

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
