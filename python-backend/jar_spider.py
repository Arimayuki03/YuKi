# -*- coding: utf-8 -*-
"""JarSpider：把 JVM 内 TVBox JAR spider 适配为 base.spider.Spider 接口。

与 JsSpider 同构：方法名/参数对齐 TV 端契约，返回 JSON 字符串由本层解析为
Python 对象交给 Runner/app。底层经 JarBridge 与 JVM 子进程通信（见 jar_bridge.py）。

TVBox jar 契约（CatVodTV/TVBoxOSC Spider）：
  init(String) / homeContent(boolean) / categoryContent(tid,pg,filter,extend)
  detailContent(List<String>) / searchContent(key,quick[,pg]) / playerContent(flag,id,vipFlags)
"""
import json
import logging

from base.spider import Spider

logger = logging.getLogger('vpc.jarspider')


def _load_pan_cookies():
    """读取用户配置的网盘 Cookie（供 JVM 侧注入蜘蛛）；读取失败返回 None。"""
    try:
        from pan_cookies import load_pan_cookies
        return load_pan_cookies() or None
    except Exception:
        return None


class JarSpider(Spider):
    """JAR spider 适配器。工厂注入 bridge / class_name / site_name 到子类。"""

    bridge = None
    class_name = ''
    site_name = ''

    _inited = False
    _init_failed = False   # init 失败后置 True：业务方法短路返回空结果，不再发起必然失败的 JVM 调用
    _ext = ''
    last_error = ''  # 最近一次桥调用错误（供 server 层附加到响应，前端可提示具体原因）

    def init(self, extend=''):
        if extend is None:
            ext = ''
        elif isinstance(extend, str):
            ext = extend.strip()
        elif isinstance(extend, dict):
            ext = json.dumps(extend, ensure_ascii=False) if extend else ''
        else:
            ext = str(extend) if extend else ''
        self._ext = ext
        # 显式 init：skip_init=True 直接走桥调用；失败时 _call 已置 _init_failed，可阻止业务方法。
        self._call('init', self._ext, skip_init=True)
        self._inited = True

    def getName(self):
        return self.site_name

    def homeContent(self, filter):
        if self._init_failed:
            return {}
        return self._json(self._call('homeContent', bool(filter)), {})

    def homeVideoContent(self, pg='1'):
        if self._init_failed:
            return {'list': []}
        return self._json(self._call('homeVideoContent', str(pg)), {'list': []})

    def categoryContent(self, tid, pg, filter, extend):
        if self._init_failed:
            return {}
        return self._json(self._call('categoryContent', str(tid), str(pg),
                                     bool(filter), extend or {}), {})

    def detailContent(self, ids):
        if self._init_failed:
            return {'list': []}
        # TVBox jar 蜘蛛需要 String[]，传 list 即可。
        # 上游 jar 内部解析 bug（Fmys/Ddyy/Jinpai/Mogg 的 NPE/ClassCastException）不可在此层修复，
        # 只需确保任何失败都兜底返回 {'list': []}，last_error 由 _call 记录，server 层附加友好原因透传前端。
        try:
            id_list = list(ids) if isinstance(ids, (list, tuple)) else [str(ids)]
        except Exception as e:
            if not self.last_error:
                self.last_error = str(e)[:300]
            return {'list': []}
        result = self._json(self._call('detailContent', id_list), {})
        if not isinstance(result, dict):
            # 蜘蛛返回裸串/非 dict（异常后桥接层可能给回不可解析内容）→ 归一为空详情
            if not self.last_error:
                self.last_error = '站点接口返回格式不正确'
            return {'list': []}
        return result

    def searchContent(self, key, quick, pg='1'):
        if self._init_failed:
            return {'list': []}
        return self._json(self._call('searchContent', key, self._truthy(quick), str(pg)),
                          {'list': []})

    def playerContent(self, flag, id, vipFlags):
        raw = self._call('playerContent', flag, id, list(vipFlags) if vipFlags else [])
        result = self._json(raw, {'url': id, 'parse': 1})
        if result is None:
            # 蜘蛛明确返回 null（如网盘 Cookie 无效、分享失效）→ 附加可读提示
            if not self.last_error:
                self.last_error = '网盘解析失败：Cookie 无效或已过期，或分享链接已失效'
            return {'url': id, 'parse': 1}
        return result

    def liveContent(self, url):
        return self._call('liveContent', url) or ''

    def localProxy(self, param):
        raw = self._call('proxy', json.dumps(param or {}, ensure_ascii=False))
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return raw

    def isVideoFormat(self, url):
        return self._truthy(self._call('isVideoFormat', url))

    def manualVideoCheck(self):
        return self._truthy(self._call('manualVideoCheck'))

    def action(self, action):
        return self._json(self._call('action', json.dumps(action or {}, ensure_ascii=False)), {})

    def destroy(self):
        # destroy 是终态：runner 应答后进程自行退出，进程退出属正常语义，静默吞掉
        if self.bridge is None:
            return
        try:
            self.bridge.call('destroy')
        except Exception:
            pass

    def _call(self, method, *args, skip_init=False):
        if self.bridge is None:
            return None
        if not self._inited and not skip_init and method != 'init':
            try:
                # TVBox 标准：无 ext 配置时传空字符串（蜘蛛 init 内通常「非空才覆盖
                # 内置默认配置」）。传 '{}' 会覆盖掉内置 baseUrl（如 Guazi 源报
                # "no scheme was found for {}/App..."），故空配置必须传空串。
                ext = self._ext if self._ext and self._ext.strip() else ''
                self.bridge.call('init', ext, class_name=self.class_name)
                self._inited = True
                self._init_failed = False
            except Exception as e:
                # 仅当 init 成功才认为已初始化；失败标记 _init_failed，
                # 业务方法据此短路，避免对坏蜘蛛反复发起必然失败的 JVM 调用。
                logger.warning('jar auto-init %s failed: %s', self.class_name, e)
                self._init_failed = True
        # init 失败（含显式 init 失败）后，非 init 业务调用不再发起必然失败的 JVM 调用。
        if self._init_failed and not skip_init and method != 'init':
            return None
        try:
            self.last_error = ''
            result = self.bridge.call(method, *args, class_name=self.class_name,
                                      pan_cookies=_load_pan_cookies())
            if method == 'init':
                self._init_failed = False
            return result
        except Exception as e:
            if method == 'init':
                # 显式 init 路径（skip_init=True 直接走此处）：失败同样标记，阻止后续业务调用。
                self._init_failed = True
            self.last_error = str(e)[:300]
            logger.warning('jar call %s.%s failed: %s', self.class_name, method, e)
            return None

    @staticmethod
    def _json(raw, default=None):
        if raw is None:
            return default
        if isinstance(raw, (dict, list)):
            return raw
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _truthy(v):
        if v is None:
            return False
        if isinstance(v, bool):
            return v
        return str(v).lower() in ('1', 'true', 'yes')


def make_jar_spider_class(key, bridge, name, class_name):
    """为每个 jar 站点生成独立子类（规避基类单例），返回已装配实例。

    同时把站点的 ext 配置写进类属性，供首次调用前的自动 init 使用。
    """
    cls = type(f'JarSpider_{key}', (JarSpider,), {
        'bridge': bridge,
        'class_name': class_name,
        'site_name': name,
        '_ext': '',
    })
    return cls()