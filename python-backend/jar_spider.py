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
        self._call('init', self._ext, skip_init=True)
        self._inited = True

    def getName(self):
        return self.site_name

    def homeContent(self, filter):
        return self._json(self._call('homeContent', bool(filter)), {})

    def homeVideoContent(self, pg='1'):
        return self._json(self._call('homeVideoContent', str(pg)), {'list': []})

    def categoryContent(self, tid, pg, filter, extend):
        return self._json(self._call('categoryContent', str(tid), str(pg),
                                     bool(filter), extend or {}), {})

    def detailContent(self, ids):
        # TVBox jar 蜘蛛需要 String[]，传 list 即可。
        id_list = list(ids) if isinstance(ids, (list, tuple)) else [str(ids)]
        return self._json(self._call('detailContent', id_list), {})

    def searchContent(self, key, quick, pg='1'):
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
        # 我的夸克网盘兜底：jar 转存链路（sharepage/save 需 pwd_id）对网盘内文件
        # 必失败 → url 空。此时 vodId 是 [{"folder":"<fid>","shareId":"",...}]，
        # 直接用 folder 拼 go-proxy do=pan URL（go-proxy 已支持 shareId 空 + 纯 fid）。
        # 端口用 go-proxy 主端口常量 9978（EXTRA_PORTS 7944/1314 为兼容旧 jar 硬编码）。
        if not (result or {}).get('url'):
            try:
                vid = json.loads(id) if isinstance(id, str) and id.lstrip().startswith('[') else None
                folder = ''
                share_id = ''
                if isinstance(vid, list) and vid:
                    folder = str((vid[0] or {}).get('folder') or '')
                    share_id = str((vid[0] or {}).get('shareId') or '')
                if folder and not share_id:
                    result = {'url': 'http://127.0.0.1:9978/proxy?do=pan&site=quark&fileId=%s'
                                      % folder,
                              'parse': 0, 'header': result.get('header') or {}}
            except Exception:
                pass
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
            except Exception as e:
                logger.warning('jar auto-init %s failed: %s', self.class_name, e)
            finally:
                # 无论 init 成败均标记已初始化：蜘蛛可能带内置默认配置，
                # 业务方法照常调用（与 TVBox 宿主行为一致）。
                self._inited = True
        try:
            self.last_error = ''
            result = self.bridge.call(method, *args, class_name=self.class_name,
                                      pan_cookies=_load_pan_cookies())
            return result
        except Exception as e:
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
