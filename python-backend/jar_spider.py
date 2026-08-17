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
import re
import threading
from urllib.parse import quote

from base.spider import Spider
import hoststate
from proxy_contract import normalize_proxy_url

logger = logging.getLogger('vpc.jarspider')


def _load_pan_cookies():
    """读取用户配置的网盘 Cookie（供 JVM 侧注入蜘蛛）；读取失败返回 None。"""
    try:
        from pan_cookies import load_pan_cookies
        return load_pan_cookies() or None
    except Exception:
        return None


def _ensure_local_proxy_ports(result):
    """播放 URL 指向本机端口时按需补监听（TVBOX_COMPAT_PLAN 任务二·机制A）。

    jar 家族把 127.0.0.1:<port> 硬编码进字节码，宿主穷举端口追不上新 jar；
    播放地址全部流经 playerContent 返回值，在此拦截并动态起同协议监听
    （go_proxy._Handler），配合 jar 加载期字节扫描（jar_bridge·机制B）双保险。
    """
    if not isinstance(result, dict):
        return result
    url = result.get('url')
    if isinstance(url, str):
        m = re.match(r'^https?://127\.0\.0\.1:(\d+)(/|$)', url)
        if m:
            try:
                from go_proxy import ensure_listener
                ensure_listener(int(m.group(1)))
            except Exception:
                pass
    return result


def _normalize_proxy_scheme(result, site_key=''):
    """把 CatVod/FongMi 的 ``proxy://`` 播放地址转为 PC HTTP 网关。

    直播源常见 ``proxy://do=live&ext=...``，JAR 播放代理也可能返回同样
    的 scheme。只处理可明确解析的 query 形式；其余 URL 原样保留，避免猜
    测第三方自定义 scheme。
    """
    if not isinstance(result, dict):
        return result
    url = result.get('url')
    if not isinstance(url, str) or not url.lower().startswith('proxy://'):
        return result
    suffix = url[len('proxy://'):].lstrip('?')
    if not suffix or ('://' in suffix and '=' not in suffix):
        return result
    result['url'] = normalize_proxy_url(
        'proxy://' + suffix,
        site_key=site_key,
        spider_type='jar',
        proxy_base=hoststate.get_proxy_url(True),
        proxy_token=hoststate.get_token(),
    )
    result.setdefault('parse', 0)
    return result


class JarSpider(Spider):
    """JAR spider 适配器。工厂注入 bridge / class_name / site_name 到子类。"""

    bridge = None
    class_name = ''
    site_name = ''
    site_key = ''

    _inited = False
    _ext = ''

    # 最近一次桥调用错误（供 server 层附加到响应，前端可提示具体原因）。
    # M-27b：改线程局部——多站点并发搜索时，A 站点的错误不再附着到 B 站点的
    # 成功响应上（server 在同一线程内写入读取，语义不变）。
    @property
    def last_error(self):
        tls = getattr(self, '_tls', None)
        return tls.last_error if tls is not None else ''

    @last_error.setter
    def last_error(self, value):
        if not hasattr(self, '_tls'):
            self._tls = threading.local()
        self._tls.last_error = value

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

    @staticmethod
    def _quark_folder_id(id):
        """从 vodId 提取我的夸克网盘文件 fid。

        我的网盘文件 vodId 是 [{"folder":"<fid>","shareId":"",...}]（shareId 空）。
        返回 (folder, share_id)；非该结构返回 ('', '')。
        """
        try:
            vid = json.loads(id) if isinstance(id, str) and id.lstrip().startswith('[') else None
            if isinstance(vid, list) and vid and isinstance(vid[0], dict):
                return str(vid[0].get('folder') or ''), str(vid[0].get('shareId') or '')
        except Exception:
            pass
        return '', ''

    def playerContent(self, flag, id, vipFlags):
        # 端口泛化拦截（任务二机制A）：所有 jar 播放地址的单一流经点
        result = _ensure_local_proxy_ports(self.playerContentRaw(flag, id, vipFlags))
        return _normalize_proxy_scheme(result, self.site_key)

    def playerContentRaw(self, flag, id, vipFlags):
        # 任务三：夸克特判降级为协议层兜底。
        # 我的夸克网盘文件（shareId 空 + folder fid）：ea3f jar 的取流链路
        # （sharepage/save 转存）对网盘内文件必失败（pwd_id 空 → 400），
        # 且 w.l() 对无 data 响应会 NPE。这类文件不依赖 jar —— go-proxy
        # 直接 v2/play 或 file/download 取直链。
        #
        # 架构调整（TVBOX_COMPAT_PLAN 任务三）：
        # - 旧实现：检测格式 → 前置短路（绑定特定 jar 的 vodId 假设）
        # - 新实现：jar 优先 → 失败/退化时兜底拼 go-proxy URL
        # - 快路径开关 pan_fast_path（默认 True 保持现有行为，False 全走 jar）
        import hoststate
        folder, share_id = self._quark_folder_id(id)
        pan_url = None
        if folder and not share_id:
            pan_url = 'http://127.0.0.1:9978/proxy?do=pan&site=quark&fileId=%s' % quote(str(folder), safe='')
            # 快路径：前置短路（现有行为，现有用户零感知）
            if hoststate.get_pan_fast_path():
                return {'url': pan_url, 'parse': 0, 'header': {}}

        # jar 优先路径：先走 jar playerContent
        raw = self._call('playerContent', flag, id, list(vipFlags) if vipFlags else [])
        result = self._json(raw, {'url': id, 'parse': 1})
        if result is None:
            # 蜘蛛明确返回 null（如网盘 Cookie 无效、分享失效）→ 附加可读提示
            if not self.last_error:
                self.last_error = '网盘解析失败：Cookie 无效或已过期，或分享链接已失效'
            result = {'url': id, 'parse': 1}

        # 兜底：jar 失败/退化（url 空/[] 或仍是原样 id）且命中网盘格式 → go-proxy URL
        url = (result or {}).get('url')
        if pan_url and (not url or (isinstance(url, str) and url == id)):
            result = {'url': pan_url, 'parse': 0, 'header': result.get('header') or {}}
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

    def proxy_static(self, param):
        """调用 FongMi jar 级静态 ``Proxy.proxy(Map)`` 数据面。

        ``BaseLoader.proxy`` 在没有 siteKey 时走 JarLoader 的静态 Proxy；
        服务器通过最近的 JarSpider 找到共享 bridge。没有静态类的旧 jar
        退回实例 ``proxy(String)``，这样原有简化 jar 仍可工作。
        """
        if self.bridge is None:
            return None
        try:
            return self.bridge.call_proxy(
                param or {}, class_name=self.class_name,
                pan_cookies=_load_pan_cookies())
        except Exception as e:
            logger.info('static jar proxy unavailable for %s, fallback instance: %s',
                        self.class_name, e)
            return self.localProxy(param)

    def isVideoFormat(self, url):
        return self._truthy(self._call('isVideoFormat', url))

    def manualVideoCheck(self):
        return self._truthy(self._call('manualVideoCheck'))

    def action(self, action):
        return self._json(self._call('action', json.dumps(action or {}, ensure_ascii=False)), {})

    def destroy(self):
        # M-17：destroy 只是 spider 级清理（SpiderRunner 不再因此退出进程），
        # 进程级关停统一走 JarBridge.destroy/__shutdown（site_manager.destroy_all）
        if self.bridge is None:
            return
        try:
            self.bridge.call('destroy', class_name=self.class_name)
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
        'site_key': key,
        '_ext': '',
    })
    return cls()
