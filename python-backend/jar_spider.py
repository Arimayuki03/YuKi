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
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit

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


def _quark_cookie_present():
    """本机是否存有可用的夸克 Cookie。

    Provider 取流（v2/play / file/download）匿名必被夸克拒绝（实测 v2/play
    回 401 code=31001），快路径与 do=pan 兜底都依赖这份 Cookie。
    """
    cookies = _load_pan_cookies() or {}
    return bool(str(cookies.get('quark') or '').strip())


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
    def _quark_play_params(id):
        """从夸克 vodId 提取统一 do=pan 参数。

        不同夸克 JAR 会把同一份信息编码成 JSON 数组、JSON 对象或 URL 编码
        的 JSON；同时字段名可能是 folder/fid/fileId、shareId/share_id。
        统一归一后由 go-proxy 负责真正解析短期播放地址。
        """
        raw = str(id or '').strip()
        if not raw:
            return None
        if 'pan.quark.cn/s/' in raw:
            return {'fileId': raw}

        # Several Quark JARs use an opaque five-part id rather than JSON:
        # shareId++fileId++pwdId++fileToken++size.  Do not split or decode the
        # token more than once; its base64 value may contain '+'.
        parts = raw.split('++')
        if len(parts) >= 4 and all(parts[:2]):
            result = {
                'shareId': parts[0],
                'fileId': parts[1],
                'fileToken': parts[3],
            }
            # 第三段在实测样本里是公开分享的 pwd_id（形如 pan.quark.cn/s/<pwd_id>，
            # 12 位 alnum），而 shareId/fid 都是 32 位 hex。带上它，PC 侧才能用
            # sharepage/token 建立分享会话；没有会话时 file/download?scene=share
            # 回 400 code=14001「非法token」、v2/play 回 404 code=21001。
            # 形状不符（例如又是 32 位 hex，或长得像 base64 token）时不猜，
            # 让 _pan_resolvable 判成解不开，交回 JAR 解析。
            candidate = str(parts[2] or '').strip()
            if (re.fullmatch(r'[0-9a-zA-Z]{6,24}', candidate)
                    and not re.fullmatch(r'[0-9a-f]{32}', candidate)):
                result['pwdId'] = candidate
            return result

        decoded = raw
        for _ in range(2):
            try:
                candidate = unquote(decoded)
            except Exception:
                break
            if candidate == decoded:
                break
            decoded = candidate
        try:
            value = json.loads(decoded)
        except (TypeError, ValueError):
            return None

        def objects(node):
            if isinstance(node, dict):
                yield node
                for child in node.values():
                    yield from objects(child)
            elif isinstance(node, list):
                for child in node:
                    yield from objects(child)

        for item in objects(value):
            def pick(*keys):
                for key in keys:
                    val = item.get(key)
                    if val is not None and str(val).strip():
                        return str(val).strip()
                return ''

            file_id = pick('folder', 'fileId', 'file_id', 'fid')
            if not file_id:
                continue
            share_id = pick('shareId', 'share_id', 'shareid')
            file_token = pick('fileToken', 'file_token', 'shareToken',
                              'share_token', 'share_fid_token', 'fid_token')
            pwd_id = pick('pwdId', 'pwd_id', 'passwordId', 'password_id')
            share_url = pick('shareUrl', 'share_url', 'shareURL')
            if not share_url:
                candidate_url = pick('url', 'share_link', 'shareLink')
                if 'pan.quark.cn/s/' in candidate_url:
                    share_url = candidate_url
            result = {'fileId': file_id, 'shareId': share_id,
                      'fileToken': file_token}
            if pwd_id:
                result['pwdId'] = pwd_id
            if share_url:
                result['shareUrl'] = share_url
            return result
        return None

    @staticmethod
    def _pan_resolvable(params):
        """PC 侧 Quark Provider 是否真解得开这条 vodId。

        - 我的网盘文件（无 shareId）：v2/play / file/download 直接出直链；
        - 公开分享且带 pwdId / shareUrl（含 ``pan.quark.cn/s/`` 链接）：可以先
          sharepage/token 建立分享会话（stoken），再按 fid 出直链，必要时转存兜底；
        - 只有 shareId + fid + share_fid_token 的公开分享解不开：share_fid_token
          只在 stoken 建立的分享会话里有效，而 stoken 只能用 pwd_id 申请。实测
          file/download?scene=share 回 400 code=14001「非法token」、v2/play 回
          404 code=21001，go-proxy 只能回 502，mpv 立刻退出（media 未开始播放）。
          这种 vodId 必须交回 JAR：它在 detailContent 阶段就持有分享会话，能自己
          出直链，并连带返回取流所需的 Cookie 头。
        """
        if not params or not params.get('fileId'):
            return False
        if not str(params.get('shareId') or ''):
            return True
        return bool(params.get('pwdId') or params.get('shareUrl'))

    @staticmethod
    def _vod_id_shape(raw):
        """只描述夸克 vodId 的结构，绝不输出取值。

        vodId 里含 share_fid_token 等凭据，不能进日志；但不同 JAR 的编码形状
        直接决定 PC 侧能不能建立分享会话，取流失败时必须能据此诊断。
        """
        text = str(raw or '')
        if not text:
            return 'empty'
        parts = text.split('++')
        if len(parts) > 1:
            return 'opaque parts=%d lens=%s' % (
                len(parts), ','.join(str(len(p)) for p in parts[:8]))
        params = JarSpider._quark_play_params(text) or {}
        if params:
            return 'params=%s' % ','.join(sorted(k for k, v in params.items() if v))
        return 'unknown len=%d' % len(text)

    @staticmethod
    def _wrap_local_go_proxy(url):
        """把裸夸克 CDN 直链包进本机 go-proxy 的 ``?url=`` 取流通道。

        PC 侧解不开这条 vodId 时（见 _pan_resolvable），JAR 自己解出来的一次性
        签名直链是唯一可播的地址，但直接交给 mpv 就不带网盘 Cookie/Referer，
        上游一律 403。``?url=`` 通道会按域名白名单补上已配置的夸克 Cookie 与
        Referer，并负责 Range/分段下载；请求头自带的 Cookie（JAR 返回的 header）
        仍然优先透传。
        """
        return 'http://127.0.0.1:9978/proxy?' + urlencode(
            [('url', str(url or '')), ('proxytype', 'go'), ('thread', '8')],
            quote_via=quote)

    @staticmethod
    def _quark_folder_id(id):
        """兼容旧调用方：返回 (file_id, share_id)。"""
        params = JarSpider._quark_play_params(id) or {}
        return str(params.get('fileId') or ''), str(params.get('shareId') or '')

    @staticmethod
    def _quark_pan_url(params, flag=''):
        if not params or not params.get('fileId'):
            return None
        query = [('do', 'pan'), ('site', 'quark')]
        for key in ('shareId', 'fileId', 'fileToken', 'pwdId'):
            value = str(params.get(key) or '')
            if value:
                query.append((key, value))
        # Keep the selected line available to the native provider.  The raw
        # flag is intentionally encoded rather than interpreted here: JAR
        # sites may use arbitrary Unicode/numbered line names.
        if flag:
            query.append(('quality', str(flag)))
        share_url = str(params.get('shareUrl') or '')
        if share_url and 'pan.quark.cn/s/' in share_url:
            query.append(('shareUrl', share_url))
        return 'http://127.0.0.1:9978/proxy?' + urlencode(query, quote_via=quote)

    @staticmethod
    def _is_legacy_go_proxy_url(url):
        """判断 JAR 返回的旧版 ``7944/?url=...&proxytype=go`` 地址。

        这类地址包着夸克短期签名 URL，缓存或转存稍有延迟就会变成
        HTTP 412。能识别出同一集的统一 pan 参数时，应交给当前 Provider
        动态重新申请地址，而不是把旧 CDN 地址继续交给 mpv。
        """
        try:
            parts = urlsplit(str(url or ''))
            if (parts.scheme.lower() not in ('http', 'https')
                    or (parts.hostname or '').lower() not in ('127.0.0.1', 'localhost')
                    or (parts.port or (443 if parts.scheme.lower() == 'https' else 80))
                    not in (7944, 9978, 1314)):
                return False
            query = parse_qs(parts.query, keep_blank_values=True)
            return (str(query.get('proxytype', [''])[0]).lower() == 'go'
                    and bool(query.get('url', [''])[0]))
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _is_bare_quark_cdn_url(url):
        """判断 JAR 直接返回的裸夸克 CDN 直链（未经本地代理）。

        与 ``_is_legacy_go_proxy_url`` 同一个问题、更严重：这类地址是一次性
        签名，且交给 mpv 时不带网盘 Cookie/Referer，上游一律 403/412。识别出
        同一集的 pan 参数时，换成 do=pan 让 go-proxy 带凭据取流并在签名失效
        时刷新。
        """
        try:
            parts = urlsplit(str(url or ''))
            if parts.scheme.lower() not in ('http', 'https'):
                return False
            host = (parts.hostname or '').lower()
            return host.endswith(('.quark.cn', '.myquark.cn', '.uc.cn'))
        except (TypeError, ValueError):
            return False

    def playerContent(self, flag, id, vipFlags):
        # 端口泛化拦截（任务二机制A）：所有 jar 播放地址的单一流经点
        result = _ensure_local_proxy_ports(self.playerContentRaw(flag, id, vipFlags))
        return _normalize_proxy_scheme(result, self.site_key)

    def playerContentRaw(self, flag, id, vipFlags):
        # 夸克取流按 vodId 能不能在 PC 侧解开来分流（判据见 _pan_resolvable）：
        # - 我的网盘文件 / 带 pwdId·shareUrl 的公开分享：走宿主 Provider 的
        #   do=pan 快路径（pan_fast_path 默认开；关闭时退回 JAR 优先，保留完整
        #   JAR 协议语义，JAR 失败再兜底 do=pan）。JAR 自己的取流链路依赖
        #   Android Context/chmod 与 sharepage/save 转存，在 PC 上要么失败
        #   （pwd_id 空 → 400，w.l() 对无 data 响应 NPE），要么只给一次性签名。
        # - 只有 shareId+fid+fid_token 的公开分享：PC 侧建不起分享会话，必须
        #   JAR 优先，且不能把它的结果替换成必然 502 的 do=pan。
        import hoststate
        # 新一次播放先清理同线程上一次 JAR 错误；有效的 pan 回退不应被
        # server._attach_jar_error 转成 error，阻断前端继续播放。
        self.last_error = ''
        pan_params = self._quark_play_params(id)
        pan_url = self._quark_pan_url(pan_params, flag=flag)
        pan_resolvable = self._pan_resolvable(pan_params)
        # 快路径 Cookie 门禁：无本机夸克 Cookie 时 Provider 取流必然全链失败
        # （匿名 sharepage/token 能过，但 v2/play 401、download 14001，最后
        # 只剩 502）。此时跳过快路径交回 JAR——部分站点 jar 自带凭据仍有会话；
        # JAR 失败后的 do=pan 兜底由 go-proxy 无 Cookie 快速失败接住（不再
        # 跑 v2play/download/save 重试风暴），渲染层给出扫码登录引导。
        if pan_url and pan_resolvable and hoststate.get_pan_fast_path() \
                and not _quark_cookie_present():
            logger.info('quark fast path skipped: 本机未存储夸克 Cookie，'
                        '交回 JAR 解析：%s', self._vod_id_shape(id))
        elif pan_url and pan_resolvable and hoststate.get_pan_fast_path():
            return {'url': pan_url, 'parse': 0, 'header': {},
                    'flag': str(flag or ''), 'quality': str(flag or '')}
        if pan_url and not pan_resolvable:
            logger.info('quark vodId 缺少分享会话参数（pwd_id/分享链接），'
                        '交回 JAR 解析：%s', self._vod_id_shape(id))
        # jar 优先路径：先走 jar playerContent
        raw = self._call('playerContent', flag, id, list(vipFlags) if vipFlags else [])
        result = self._json(raw, {'url': id, 'parse': 1})
        if result is None:
            # 蜘蛛明确返回 null（如网盘 Cookie 无效、分享失效）→ 附加可读提示
            if not self.last_error:
                self.last_error = '网盘解析失败：Cookie 无效或已过期，或分享链接已失效'
            result = {'url': id, 'parse': 1}

        # 兜底：jar 失败/退化（url 空/[] 或仍是原样 id）且命中网盘格式 → go-proxy URL
        url = (result or {}).get('url') if isinstance(result, dict) else None
        # 旧 JAR 可能已经返回了 7944 go-proxy 地址，或干脆返回裸夸克 CDN 直链。
        # 即使它们看起来是完整 URL，也只是一次性的 CDN 签名（裸直链还缺
        # Cookie）；替换为 do=pan 后，go-proxy 才能带凭据取流，并在
        # 401/403/404/410/412 时刷新 Provider 地址。
        # 前提是 PC 侧真解得开（_pan_resolvable）：解不开时 do=pan 只会回 502，
        # 而 JAR 那条地址配合它自己返回的 header（Cookie/UA）反而能播，
        # 替换等于把「可能能播」换成「必定不能播」。
        native_fallback = bool(pan_url) and pan_resolvable
        stale_jar_url = isinstance(url, str) and (
            self._is_legacy_go_proxy_url(url) or self._is_bare_quark_cdn_url(url))
        if native_fallback and stale_jar_url:
            self.last_error = ''
            result = dict(result) if isinstance(result, dict) else {}
            result.update({'url': pan_url, 'parse': 0})
            result['header'] = result.get('header') or {}
        elif native_fallback and (not url or (isinstance(url, str) and url == id)):
            self.last_error = ''
            header = result.get('header') if isinstance(result, dict) else {}
            result = dict(result) if isinstance(result, dict) else {}
            result.update({'url': pan_url, 'parse': 0, 'header': header or {}})
        elif (not pan_resolvable and stale_jar_url
                and isinstance(url, str) and self._is_bare_quark_cdn_url(url)):
            # PC 侧解不开：保留 JAR 解出的直链，只补上取流通道（Cookie/Referer/
            # Range）。裸直链直接给 mpv 会 403。
            self.last_error = ''
            result = dict(result) if isinstance(result, dict) else {}
            result.update({'url': self._wrap_local_go_proxy(url), 'parse': 0})
            result['header'] = result.get('header') or {}
        return result

    def liveContent(self, url):
        return self._call('liveContent', url) or ''

    def jsonExt(self, key, jxs, url):
        """Execute FongMi parse type=2 in this portable JAR."""
        return self.bridge.call('__json_ext', str(key or ''), dict(jxs or {}),
                                str(url or ''), class_name=self.class_name)

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
