# -*- coding: utf-8 -*-
"""FongMi localProxy（go-proxy）兼容服务：监听 127.0.0.1:7944。

TVBox/FongMi 系 jar 蜘蛛（如 Quark）生成的播放地址形如
  http://127.0.0.1:7944/?url=<URL编码的下载地址>&proxytype=go&thread=<N>
原生由 App 内置的本地 go-proxy 程序提供。PC 端没有该程序，这里用
Python 实现等价的转发服务：

1. 解码 url 参数（Java URLEncoder 语义：+ 表示空格 → unquote_plus）
2. 用已配置的网盘 Cookie（pan_cookies.json 的 quark 项；请求头带 Cookie 时优先）
   与浏览器 UA/Referer 请求目标地址
3. 支持 Range（拖动进度条需 206）、流式转发
4. 多线程分段下载：夸克 CDN 对单连接限速（实测 ~0.8 Mbps），官方 go-proxy
   靠 thread=<N> 开 N 个并发连接分段拉流绕过限速（实测 8 并发 ≈ 114 Mbps）。
   这里同样按 thread 参数把目标区间切成 N 段并发下载，通过有界队列
   边下边按序转发（带背压，内存占用有上限）。
5. HTTP/1.0：每请求独立连接，避免 keep-alive 复用导致 mpv seek 时协议错乱。
"""
import http.server
import logging
import os
import json
import queue
import re
import threading
import time
import urllib.parse
import urllib.request

import requests

logger = logging.getLogger('yuki.goproxy')


# 系统代理解析收编到 http_client（环境变量优先 + WinINET 兜底，全后端唯一实现）
from http_client import system_proxies as _system_proxies


# 带系统代理的 requests session：所有夸克 API 请求走代理（快路径），
# 避免部分进程里 requests 默认 trust_env 读不到 WinINET 退化直连（暴慢）。
_qses = requests.Session()
_qses.trust_env = False
_qses.proxies.update(_system_proxies())

# 共享 _qses 的并发保护（L-18）：Session 非线程安全，且上游 Set-Cookie 落进
# 共享 jar 后会在后续请求里覆盖显式传入的 Cookie 头（跨请求污染凭据）。
# 方案：全局锁串行化 + 每次响应后清空 jar，Cookie 一律走显式 headers。
# 不用 thread-local session：ThreadingHTTPServer 每连接一线程，线程局部
# session 会退化成每请求新建连接池，丢掉共享连接池的快路径；而夸克 API
# 均为秒级短 JSON 请求，播放流走 _fetch 的独立连接，锁串行化无感知。
_QSES_LOCK = threading.Lock()


def _qget(url, **kw):
    with _QSES_LOCK:
        try:
            return _qses.get(url, **kw)
        finally:
            try:
                _qses.cookies.clear()
            except Exception:
                pass


def _qpost(url, **kw):
    with _QSES_LOCK:
        try:
            return _qses.post(url, **kw)
        finally:
            try:
                _qses.cookies.clear()
            except Exception:
                pass


# 自动附加网盘 Cookie 的目标域名白名单（H-1c）：仅夸克/UC 系域名，
# 防止把网盘凭据发给任意目标 URL；客户端请求头自带的 Cookie 始终透传不受限。
def _cookie_host_allowed(url):
    try:
        host = (urllib.parse.urlparse(url).hostname or '').lower()
    except ValueError:
        return False
    return host in ('quark.cn', 'myquark.cn', 'uc.cn') or \
        host.endswith(('.quark.cn', '.myquark.cn', '.uc.cn'))

# FongMi 蜘蛛期望的本地代理协议：
# - 端口：不同 jar 蜘蛛把 127.0.0.1:<port> 硬编码进字节码，跨 jar 差异很大：
#   fm-jvm.jar（夸克盘社/百度）硬编码 unexported 7944；ea3f 4K 网盘、欧歌等
#   硬编码 9978；另有 1314（播放转发模板）。为覆盖全部 jar，必须**同时监听**
#   这些端口。否则某个 jar 生成的播放 URL 指向它硬编码的端口但无人监听 →
#   播放失败（本次"夸克不能播"即因 7944 被移除导致）。
# - do=ck：健康检查（部分蜘蛛启动时扫描端口，GET /proxy?do=ck 返回 ok 即命中）。
# - do=pan：网盘（夸克/UC）分享文件取流；?url=<encoded>：通用下载转发（分段并发）。
PORT = 9978
# 覆盖各 jar 硬编码的播放/代理端口：7944(FM网盘)、1314(播放转发模板)、9978(主)
EXTRA_PORTS = [7944, 1314]
BROWSER_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
# 并发上限：与官方 thread=32 一致；32 连接即可跑满带宽
MAX_THREADS = 32
SEG_CHUNK = 262144
QUEUE_DEPTH = 24  # 每段在途 chunk 上限（背压：下载过快时阻塞下载线程）
# 夸克签名直链失效/尚未完成转存时，Provider 可以重新申请播放地址。
# 412 是当前 CDN 对失效签名最常见的响应之一，不能只按 401/403 处理。
_REFRESHABLE_UPSTREAM_STATUSES = frozenset((401, 403, 404, 410, 412))
# 分享转存结果缓存：pwd_id → 转存后的文件 fid（转存一次，后续播放秒开）。
# 持久化到磁盘：后端重启不重复转存、也不占用网盘空间（转存一次永久可用）。
_SAVE_CACHE = {}
# 分享解析缓存：pwd_id → {ts, stoken, fid, fid_token}（5 分钟 TTL，避免重复 token/detail）
_SHARE_CACHE = {}
_SHARE_CACHE_TTL = 300
_SHARE_CACHE_MAX = 512   # C2：条目上限（触顶全清，过期即清）
# 转存缓存持久化文件（放用户数据目录，幂等创建）
_SAVE_CACHE_FILE = None
# _SAVE_CACHE 条目上限（C2）：超限在持久化前删最早插入的条目
_SAVE_CACHE_MAX = 2000
# _SAVE_CACHE 持久化的并发保护：多个请求同时转存时避免互相覆盖
_SAVE_LOCK = threading.Lock()


def _save_cache_file():
    global _SAVE_CACHE_FILE
    if _SAVE_CACHE_FILE is None:
        try:
            import hoststate
            d = os.path.join(hoststate.get_cache_dir())
            os.makedirs(d, exist_ok=True)
            _SAVE_CACHE_FILE = os.path.join(d, 'quark_save_cache.json')
        except Exception:
            _SAVE_CACHE_FILE = ''
    return _SAVE_CACHE_FILE


def _load_save_cache():
    try:
        p = _save_cache_file()
        if p and os.path.isfile(p):
            with open(p, encoding='utf-8') as f:
                data = json.loads(f.read())
            if isinstance(data, dict):
                _SAVE_CACHE.update(data)
    except Exception:
        pass


def _persist_save_cache():
    # 原子写（同目录临时文件 + os.replace）+ 加锁：避免并发写互相截断，
    # 也避免进程中断留下半截 JSON
    p = _save_cache_file()
    if not p:
        return
    with _SAVE_LOCK:
        data = json.dumps(_SAVE_CACHE, ensure_ascii=False)
        # 临时文件名带 pid + 线程 id，避免与其他写入方抢同名句柄
        tmp = '%s.tmp%d-%d' % (p, os.getpid(), threading.get_ident())
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                f.write(data)
            os.replace(tmp, p)
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass


_load_save_cache()


def _parse_range(rng, total):
    """解析客户端 Range 头 → (start, end) 闭区间；无 Range 返回 (0, total-1)。"""
    if not rng:
        return 0, total - 1
    r = rng.strip().lower()
    if not r.startswith('bytes='):
        return 0, total - 1
    spec = r[len('bytes='):].split(',')[0].strip()
    if '-' not in spec:
        return 0, total - 1
    a, b = spec.split('-', 1)
    try:
        if a == '':
            n = int(b)
            start = max(0, total - n)
            end = total - 1
        else:
            start = int(a)
            end = int(b) if b else total - 1
    except ValueError:
        return 0, total - 1
    if start < 0:
        start = 0
    if end >= total:
        end = total - 1
    if start > end:
        # 越界/倒置 Range：返回 None，调用方回 416（Content-Range: bytes */total）
        return None
    return start, end


def _fetch(url, headers, start, end=None, timeout=60):
    """单段请求：GET Range=bytes=start-end，流式返回 response。

    end 为 None 表示开放区间（目标无长度信息，如 HLS）：不带 Range 头
    整段请求，避免发出 bytes=start-start 的零字节区间。
    """
    h = dict(headers)
    if end is not None:
        h['Range'] = 'bytes=%d-%d' % (start, end)
    return requests.get(url, headers=h, stream=True, timeout=timeout,
                        verify=True, allow_redirects=True,
                        proxies=_system_proxies() or None)


# 明确的媒体 Content-Type：原样透传。
_MEDIA_CONTENT_TYPE = re.compile(
    r'^(?:video/|audio/'
    r'|application/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|mp4|ogg))', re.I)
# 明确的文本/接口 Content-Type：也原样透传。这类响应意味着上游给的是错误页
# 或接口 JSON（HTTP 200 的软失败），标成视频只会让 mpv 报「无法识别的格式」，
# 掩盖真正原因。
_TEXTUAL_CONTENT_TYPE = re.compile(
    r'^(?:text/|application/(?:[^;]*\+)?(?:json|xml)|application/xhtml)', re.I)


def _forward_content_type(upstream, default='video/mp4'):
    """归一化回给播放器的 Content-Type。

    夸克 file/download 直链回的是 application/octet-stream（也见过
    application/force-download 一类）。按 Content-Type 猜容器的一方（mpv 的
    格式探测、宿主播放前的媒体探测）会把这些泛型二进制判成「非媒体」而拒播，
    所以统一归到默认视频类型；明确的媒体类型与明确的文本/接口类型都原样透传。
    """
    value = str(upstream or '').strip()
    if _MEDIA_CONTENT_TYPE.match(value) or _TEXTUAL_CONTENT_TYPE.match(value):
        return value
    return default


def _is_hls_ctype(ctype):
    """上游 Content-Type 是否为 HLS 播放列表。"""
    return 'mpegurl' in str(ctype or '').lower()


_HLS_URI_ATTR_RE = re.compile(r'(URI=")([^"]*)(")')


def _hls_proxy_wrap(abs_url):
    """分片/子列表/KEY 统一包回本代理 ？url= 转发。

    凭据由该分支按夸克/UC 域名白名单注入；嵌套的变体播放列表经同一分支
    会再次被识别为 m3u8 并重写，任意深度都能走通。
    """
    return 'http://127.0.0.1:%d/proxy?url=%s' % (
        PORT, urllib.parse.quote(abs_url, safe=''))


def _rewrite_hls_line(line, base_url):
    """重写单行：非标签行=分片/子列表 URI；标签行只改写 URI="..." 属性。

    返回 None 表示空行（丢弃）；无法解析为 http(s) 的行原样保留。
    """
    stripped = line.strip()
    if not stripped:
        return None
    if stripped.startswith('#'):
        if 'URI="' not in stripped:
            return line

        def _sub(m):
            uri = m.group(2)
            if not uri:
                return m.group(0)
            if not uri.lower().startswith(('http://', 'https://')):
                uri = urllib.parse.urljoin(base_url, uri)
            if not uri.lower().startswith(('http://', 'https://')):
                return m.group(0)  # data: 等非 http URI 不包装
            return m.group(1) + _hls_proxy_wrap(uri) + m.group(3)

        return _HLS_URI_ATTR_RE.sub(_sub, line)
    if not stripped.lower().startswith(('http://', 'https://')):
        stripped = urllib.parse.urljoin(base_url, stripped)
    if not stripped.lower().startswith(('http://', 'https://')):
        return line
    return _hls_proxy_wrap(stripped)


def _rewrite_hls_playlist(base_url, text):
    """重写 HLS 播放列表：所有分片/子列表/AES KEY 地址改为经本代理转发。

    背景：do=pan 把夸克 v2/play 返回的 m3u8 原文透传给 mpv 时，相对分片
    （media-xxx.ts?auth_key=...）会被按 127.0.0.1 代理基址解析 → 404；
    绝对分片则绕过代理直连 CDN——缺 Cookie/Referer 时被拒。两种都必须包
    成 ?url= 转发才能播放。
    """
    out = []
    for line in text.splitlines():
        rewritten = _rewrite_hls_line(line, base_url)
        if rewritten is not None:
            out.append(rewritten)
    return '\n'.join(out) + '\n'


def _send_hls_playlist(self, url, headers, head_only):
    """整体取回上游 m3u8、重写后回给客户端。返回是否成功。"""
    resp = _fetch(url, headers, 0, None, timeout=30)
    try:
        status = int(resp.status_code or 502)
        if status not in (200, 206):
            self.send_response(status if 400 <= status <= 599 else 502)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return True  # 已应答（错误状态），调用方无需再处理
        text = resp.content.decode('utf-8', 'replace')
    finally:
        resp.close()
    body = _rewrite_hls_playlist(url, text).encode('utf-8')
    self.send_response(200)
    self.send_header('Content-Type', 'application/vnd.apple.mpegurl')
    self.send_header('Content-Length', str(len(body)))
    self.end_headers()
    if not head_only:
        self.wfile.write(body)
    return True


def _quark_detail_url(pwd_id, stoken, pdir_fid=''):
    """拼夸克分享 detail URL（stoken 必须 URL 编码）。

    stoken 含 +/= 等字符，直接拼进 URL 会被当作空格 → 夸克返回
    code:14001「非法token」。编码后才能正确取到分享文件列表。
    """
    import urllib.parse as _up
    u = ('https://drive.quark.cn/1/clouddrive/share/sharepage/detail'
         '?pr=ucpro&fr=pc&pwd_id=%s&stoken=%s' % (pwd_id, _up.quote(stoken, safe='')))
    if pdir_fid:
        u += '&pdir_fid=%s' % pdir_fid
    return u


def _quark_resolve_share(pwd_id, headers):
    """夸克分享解析：sharepage/token → sharepage/detail → (share_id, file_id, token)。

    返回首个文件的分享参数（供 file/download 取流）。夸克 API 偶发返回空
    list（限流抖动），空结果重试最多 3 次；仍失败抛异常。
    """
    import json as _json
    import time as _time
    last_err = None
    for attempt in range(3):
        try:
            r = _qpost(
                'https://drive.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
                headers={**headers, 'Content-Type': 'application/json'},
                data=_json.dumps({'pwd_id': pwd_id, 'passcode': ''}),
                timeout=20, verify=True)
            stoken = ((r.json() or {}).get('data') or {}).get('stoken', '')
            if not stoken:
                raise ValueError('share token empty')
            r2 = _qget(_quark_detail_url(pwd_id, stoken),
                           headers=headers, timeout=20, verify=True)
            d = ((r2.json() or {}).get('data') or {})
            lst = d.get('list') or []
            if not lst:
                raise ValueError('share has no files')
            first = lst[0]
            return stoken, str(first.get('fid', '')), str(first.get('share_token') or stoken)
        except Exception as e:
            last_err = e
            if attempt < 2:
                _time.sleep(0.5 * (attempt + 1))
    raise last_err or ValueError('share resolve failed')


def _quark_quality_key(value):
    """归一 Quark/FongMi 线路名，允许线路带 ``#0101`` 后缀。"""
    text = str(value or '').strip().lower()
    text = text.split('#', 1)[0].strip()
    aliases = {
        'quark普画': 'normal', '普画': 'normal', '普清': 'normal',
        'normal': 'normal', 'low': 'low', '标清': 'low',
        'high': 'high', '高清': 'high', 'super': 'super',
        '至臻': 'original', '原画': 'original', 'origin': 'original',
        'original': 'original', 'quark原画': 'original', '夸克原画': 'original',
        'quark原画11': 'original',
        '2k': '2k', '4k': '4k',
    }
    return aliases.get(text, text)


def _quark_response_meta(response):
    """返回不含凭据/正文的 Quark 响应诊断元数据。"""
    status = getattr(response, 'status_code', 0)
    try:
        payload = response.json() or {}
    except Exception:
        return 'status=%s json=invalid' % status
    if not isinstance(payload, dict):
        return 'status=%s json=%s' % (status, type(payload).__name__)
    code = payload.get('code')
    has_message = bool(payload.get('message') or payload.get('msg'))
    data = payload.get('data')
    shape = type(data).__name__
    return 'status=%s code=%s message=%s data=%s' % (
        status, code if code is not None else '-', has_message, shape)


def _quark_share_tree_lookup(pwd_id, stoken, headers, max_items=512, max_depth=3):
    """遍历分享目录树（BFS），返回 {fid: 当前条目} 映射。

    背景：聚合站页面常缓存分享发布时的旧 fid/share_fid_token；分享者更新
    文件后夸克会轮换令牌，拿旧 token 去转存必报 41020「转存文件token校验
    异常」。sharepage/detail 实时返回的列表携带当前有效的 share_fid_token，
    用它按 fid 重新定位目标文件即可自愈。

    条目结构（data.list）：dir=true 为文件夹；file_fid_token 字段名是
    share_fid_token。BFS 限深限量，防止超大分享拖死取流。
    """
    found = {}
    queue = [('0', 0)]
    seen = set()
    while queue and len(found) < max_items:
        pdir, depth = queue.pop(0)
        if pdir in seen or depth > max_depth:
            continue
        seen.add(pdir)
        try:
            r = _qget(_quark_detail_url(pwd_id, stoken, pdir),
                      headers=headers, timeout=20, verify=True)
            items = ((r.json() or {}).get('data') or {}).get('list') or []
        except Exception:
            continue
        for it in items:
            if not isinstance(it, dict):
                continue
            fid = str(it.get('fid') or '')
            if not fid:
                continue
            found[fid] = it
            if it.get('dir') and depth < max_depth:
                queue.append((fid, depth + 1))
    return found


def _quark_v2play(fid, headers, quality=''):
    """v2/play 取播放直链，并按请求线路从 play_info 候选中选择。"""
    import json as _json
    r = _qpost(
        'https://drive-pc.quark.cn/1/clouddrive/file/v2/play?pr=ucpro&fr=pc&uc_param_str=',
        headers={**headers, 'Content-Type': 'application/json'},
        data=_json.dumps({'fid': fid, 'resolutions': 'normal,low,high,super,2k,4k',
                          'supports': 'fmp4,m3u8'}),
        timeout=25, verify=True, allow_redirects=False)
    try:
        j = r.json()
    except Exception:
        logger.warning('quark upstream stage=v2play %s', _quark_response_meta(r))
        return None
    if getattr(r, 'status_code', 200) >= 400:
        logger.warning('quark upstream stage=v2play %s', _quark_response_meta(r))
    if 'file not found' in str(j.get('message') or '').lower():
        logger.warning('quark upstream stage=v2play unavailable %s', _quark_response_meta(r))
        return None
    wanted = _quark_quality_key(quality)
    candidates = []

    def walk(node, inherited=''):
        if isinstance(node, dict):
            label = (node.get('resolution') or node.get('quality') or node.get('name')
                     or node.get('format') or inherited)
            url = node.get('url')
            if isinstance(url, str) and url.startswith(('http://', 'https://')):
                candidates.append((str(label or ''), url))
            for key, value in node.items():
                if key not in ('url',):
                    walk(value, str(label or key or inherited))
        elif isinstance(node, list):
            for value in node:
                walk(value, inherited)
    walk(j)
    if not candidates:
        return None
    if wanted:
        for label, url in candidates:
            if _quark_quality_key(label) == wanted:
                return url
        # Some API responses put the resolution in a sibling key/name.  A
        # substring match is safe after normalization and preserves fallback.
        for label, url in candidates:
            if wanted in _quark_quality_key(label) or _quark_quality_key(label) in wanted:
                return url
    return candidates[0][1]


def _quark_personal_download_url(fid, headers):
    """用个人网盘文件 fid 请求 download 直链。

    夸克的 v2/play 对部分转存文件会返回 21001，但 file/download 仍能
    返回有效的 download_url；两条接口都尝试才能避免“转存成功但不能播”。
    """
    if not fid:
        return None
    import json as _json
    try:
        r = _qpost(
            'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str=',
            headers={**headers, 'Content-Type': 'application/json'},
            data=_json.dumps({'fids': [str(fid)]}), timeout=25, verify=True,
            allow_redirects=False)
        location = r.headers.get('Location', '') if getattr(r, 'headers', None) else ''
        if isinstance(location, str) and location.startswith(('http://', 'https://')):
            return location
        try:
            payload = r.json() or {}
        except Exception:
            return None
        entries = payload.get('data') or []
        if isinstance(entries, dict):
            entries = [entries]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            url = entry.get('download_url') or entry.get('url') or ''
            if isinstance(url, str) and url.startswith(('http://', 'https://')):
                return url
    except Exception:
        return None
    return None


def _quark_personal_play_url(fid, headers, retries=1, quality=''):
    """解析个人 fid 的可播放 URL，兼容转存任务刚完成的短暂延迟。"""
    import time as _time
    attempts = max(1, int(retries) + 1)
    for attempt in range(attempts):
        try:
            url = _quark_v2play(str(fid), headers, quality)
        except TypeError:
            # 兼容旧的二参数桥接函数。
            try:
                url = _quark_v2play(str(fid), headers)
            except Exception:
                url = None
        except Exception:
            url = None
        if url:
            return url
        try:
            url = _quark_personal_download_url(str(fid), headers)
        except Exception:
            url = None
        if url:
            return url
        if attempt + 1 < attempts:
            _time.sleep(min(3.0, 0.6 * (attempt + 1)))
    return None


def _quark_save_share(pwd_id, stoken, fid, fid_token, headers):
    """转存分享文件：sharepage/save → 轮询任务 → 新 fid（网盘内）。

    返回转存后的 fid；失败抛异常。
    """
    import json as _json
    import time as _time
    body = {"pdir_fid": "0", "pwd_id": pwd_id, "scene": "link", "stoken": stoken,
            "to_pdir_fid": "0", "fid_list": [fid], "fid_token_list": [fid_token]}
    r = _qpost(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc&uc_param_str=&__t=%d'
        % int(_time.time() * 1000),
        headers={**headers, 'Content-Type': 'application/json'},
        data=_json.dumps(body), timeout=25, verify=True)
    tid = ((r.json() or {}).get('data') or {}).get('task_id', '')
    if not tid:
        raise ValueError('save task id empty')
    for _ in range(12):
        _time.sleep(1)
        try:
            r2 = _qget(
                'https://drive-pc.quark.cn/1/clouddrive/task?pr=ucpro&fr=pc&uc_param_str=&task_id=%s' % tid,
                headers=headers, timeout=20, verify=True)
            sa = ((r2.json() or {}).get('data') or {}).get('save_as') or {}
            fids = sa.get('save_as_select_top_fids') or sa.get('save_as_top_fids') or []
            if fids:
                return str(fids[0])
        except Exception:
            pass
    raise ValueError('save task timeout')


def _quark_pick_video(lst):
    """从分享文件列表挑第一个非目录条目（视频/文件）；全目录返回 None。"""
    for f in lst or []:
        if f.get('file_type') != 0:
            return f
    return None


def _quark_share_play_url(pwd_id, headers, quality=''):
    """夸克分享完整播放链路：token → detail →（进目录找视频）→ v2/play 直链。

    分享文件原始 fid 的 v2/play 直接可出直链（实测 3s 内），**不需要转存**。
    磁盘转存文件会被夸克清理而失效，转而依赖轻量解析缓存：
    - _SHARE_CACHE 缓存 stoken + 原始分享 fid（5 分钟），秒开且不失效；
    - 分享文件 v2/play 偶尔被夸克拒时，fallback 到转存一次再播放。
    夸克 API 偶发空响应（限流抖动），重试间隔递增。
    """
    import json as _json
    import time as _time
    last_err = None
    for attempt in range(3):
        try:
            now = _time.time()
            # 转存结果持久化后必须真正验证 fid；旧版本只写不读，且失效
            # fid 会一直留在缓存中，导致每次播放都拿到坏地址。
            cached_fid = str(_SAVE_CACHE.get(pwd_id) or '')
            if cached_fid:
                cached_url = _quark_personal_play_url(cached_fid, headers, retries=1,
                                                       quality=quality)
                if cached_url:
                    return cached_url
                _SAVE_CACHE.pop(pwd_id, None)
                _persist_save_cache()
            sc = _SHARE_CACHE.get(pwd_id)
            if sc and (now - sc.get('ts', 0)) >= _SHARE_CACHE_TTL:
                sc = _SHARE_CACHE.pop(pwd_id, None)   # 过期即清（C2：原先只跳过）
            if sc and (now - sc.get('ts', 0)) < _SHARE_CACHE_TTL and sc.get('fid'):
                stoken, fid, fid_token = sc['stoken'], sc['fid'], sc['fid_token']
            else:
                r = _qpost(
                    'https://drive.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
                    headers={**headers, 'Content-Type': 'application/json'},
                    data=_json.dumps({'pwd_id': pwd_id, 'passcode': ''}),
                    timeout=20, verify=True)
                stoken = ((r.json() or {}).get('data') or {}).get('stoken', '')
                if not stoken:
                    raise ValueError('share token empty')
                detail_url = _quark_detail_url(pwd_id, stoken)
                r2 = _qget(detail_url, headers=headers, timeout=20, verify=True)
                lst = ((r2.json() or {}).get('data') or {}).get('list') or []
                if not lst:
                    raise ValueError('share has no files')
                f = _quark_pick_video(lst)
                if f is None:
                    # 根目录只有文件夹：进入第一个目录找视频（夸克对 pdir_fid 限流严重）
                    folder = lst[0]
                    lst2 = []
                    for sub in range(4):
                        r3 = _qget(_quark_detail_url(pwd_id, stoken, str(folder.get('fid', ''))),
                                       headers=headers, timeout=20, verify=True)
                        lst2 = ((r3.json() or {}).get('data') or {}).get('list') or []
                        if lst2:
                            break
                        _time.sleep(0.8 * (sub + 1))
                    f = _quark_pick_video(lst2)
                if f is None:
                    raise ValueError('share has no video file')
                fid = str(f.get('fid', ''))
                fid_token = str(f.get('share_fid_token') or '')
                if len(_SHARE_CACHE) >= _SHARE_CACHE_MAX:
                    _SHARE_CACHE.clear()   # C2：触顶全清（条目均为 300s TTL，代价低）
                _SHARE_CACHE[pwd_id] = {'ts': _time.time(), 'stoken': stoken,
                                        'fid': fid, 'fid_token': fid_token}
            # 优先分享文件原始 fid 直链（快、不失效）
            url = _quark_v2play(fid, headers, quality)
            if url:
                _SAVE_CACHE.pop(pwd_id, None)
                return url
            # 分享文件 v2/play 被拒：转存一次兜底（期间 mpv 等待 120s 足够）
            new_fid = _quark_save_share(pwd_id, stoken, fid, fid_token, headers)
            if new_fid:
                _SAVE_CACHE[pwd_id] = new_fid
                _persist_save_cache()
            playable = _quark_personal_play_url(new_fid, headers, retries=4,
                                                  quality=quality)
            if playable:
                return playable
            raise ValueError('saved file has no playable URL')
        except Exception as e:
            last_err = e
            if attempt < 2:
                _time.sleep(1.0 * (attempt + 1))
    raise last_err or ValueError('share play failed')


def _quark_share_stoken(pwd_id, headers):
    """申请（并缓存）公开分享的会话 token（stoken）。

    分享文件的 share_fid_token 只在 stoken 建立的分享会话里有效：没有会话时
    ``file/download?scene=share`` 回 400 code=14001「非法token」、``v2/play``
    回 404 code=21001。与 _quark_share_play_url 共用 _SHARE_CACHE（5 分钟
    TTL），同一分享的多集播放不会反复申请。
    """
    import json as _json
    import time as _time
    now = _time.time()
    cached = _SHARE_CACHE.get(pwd_id) or {}
    if cached.get('stoken') and (now - cached.get('ts', 0)) < _SHARE_CACHE_TTL:
        return str(cached['stoken'])
    _SHARE_CACHE.pop(pwd_id, None)
    r = _qpost(
        'https://drive.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
        headers={**headers, 'Content-Type': 'application/json'},
        data=_json.dumps({'pwd_id': pwd_id, 'passcode': ''}),
        timeout=20, verify=True)
    stoken = ((r.json() or {}).get('data') or {}).get('stoken', '')
    if not stoken:
        logger.warning('quark upstream stage=share-token %s', _quark_response_meta(r))
        raise ValueError('share token empty')
    if len(_SHARE_CACHE) >= _SHARE_CACHE_MAX:
        _SHARE_CACHE.clear()
    _SHARE_CACHE[pwd_id] = {'ts': _time.time(), 'stoken': str(stoken),
                            'fid': str(cached.get('fid') or ''),
                            'fid_token': str(cached.get('fid_token') or '')}
    return str(stoken)


def _quark_share_file_play_url(pwd_id, file_id, file_token, headers, quality='',
                               share_id=''):
    """公开分享里**指定**文件的取流：建立分享会话 → 该 fid 出直链 → 转存兜底。

    与 _quark_share_play_url 的区别是不重新挑文件：后者只取分享里的第一个视频，
    用在多集分享上必然串集。这里用调用方（JAR vodId）给的 fid /
    share_fid_token，先 sharepage/token 建立会话，再按原始分享 fid 取直链；夸克
    拒掉分享 fid 时才转存一次，用新的个人 fid 播放。
    已转存到个人网盘的资源：分享 fid 的 v2/play 可能因 21001/14001 失败，
    但同一 fid 在个人空间的 v2/play + file/download 仍可出直链，放在最后兜底。
    部分资源 fileId 实际是文件夹 fid（file_type==0）：此时按 pdir_fid 进目录
    找首个视频再取流/转存，避免“已转存但不能播”。
    """
    if not pwd_id or not file_id:
        raise ValueError('missing pwd/file id')
    import time as _time
    last_err = None
    # 元数据刷新只做一轮：目录树内容不会在 0.8s 重试间隔内变化
    refreshed = False

    def _resolve_folder_fid(target_fid, stoken_value):
        """若 fid 是文件夹则进目录找首个视频，返回 (fid, token) 或原值。"""
        try:
            detail_url = _quark_detail_url(pwd_id, stoken_value, str(target_fid))
            r_detail = _qget(detail_url, headers=headers, timeout=20, verify=True)
            lst = ((r_detail.json() or {}).get('data') or {}).get('list') or []
            picked = _quark_pick_video(lst)
            if picked is not None:
                return str(picked.get('fid') or target_fid), str(picked.get('share_fid_token') or file_token)
        except Exception:
            pass
        return target_fid, file_token

    for attempt in range(2):
        try:
            stoken = _quark_share_stoken(pwd_id, headers)
            # 文件夹 fid 兜底：先尝试一次目录解析，避免后续 save 存错对象
            eff_fid, eff_token = file_id, file_token
            url = _quark_v2play(eff_fid, headers, quality)
            if not url and share_id:
                try:
                    url = _quark_download_url(share_id, eff_fid, eff_token, headers)
                except Exception:
                    url = ''
                if url:
                    return url
            if not url:
                # 可能是文件夹 fid：进目录找首个视频后再试一次
                alt_fid, alt_token = _resolve_folder_fid(eff_fid, stoken)
                if alt_fid != eff_fid:
                    eff_fid, eff_token = alt_fid, alt_token
                    url = _quark_v2play(eff_fid, headers, quality)
                    if url:
                        return url
                    if share_id:
                        try:
                            url = _quark_download_url(share_id, eff_fid, eff_token, headers)
                        except Exception:
                            url = ''
                        if url:
                            return url
            if url:
                return url
            try:
                new_fid = _quark_save_share(pwd_id, stoken, eff_fid, eff_token,
                                            headers)
            except Exception:
                # 元数据过期自愈：JAR/聚合站 vodId 携带的 fid/share_fid_token 是
                # 页面缓存的快照，分享者更新文件后夸克轮换令牌——直接转存会报
                # 41020「转存文件token校验异常」。实时拉取分享目录树，用当前
                # 条目（fid + 有效 token）重定位后再转存一次。匹配顺序：
                # fileId → shareId 参数（部分 JAR 格式两段语义错位，真实文件
                # fid 反而落在 shareId 位）。找不到候选则维持原错误上抛。
                if refreshed:
                    raise
                refreshed = True
                try:
                    tree = _quark_share_tree_lookup(pwd_id, stoken, headers)
                except Exception:
                    tree = {}
                picked = False
                for cand in (str(eff_fid or ''), str(share_id or '')):
                    ent = tree.get(cand) if cand else None
                    if isinstance(ent, dict) and not ent.get('dir'):
                        tok = str(ent.get('share_fid_token') or '')
                        cur_fid = str(ent.get('fid') or cand)
                        if tok:
                            eff_fid, eff_token = cur_fid, tok
                            picked = True
                            break
                if not picked:
                    raise
                new_fid = _quark_save_share(pwd_id, stoken, eff_fid, eff_token,
                                            headers)
            playable = _quark_personal_play_url(new_fid, headers, retries=4,
                                                quality=quality)
            if playable:
                # per-file 转存缓存：同一 pwd 下多集不互相覆盖。
                # 不再覆盖单 pwd 键：多集分享下它会被最后一集的 fid 覆盖，
                # 导致后续对同分享的首集 fallback 取到错集（串集）。
                try:
                    key = '%s:%s' % (pwd_id, file_id)
                    _SAVE_CACHE[key] = new_fid
                    # 若目标是文件夹 fid 转换后的视频，也缓存转换后 fid 映射
                    if eff_fid != file_id:
                        _SAVE_CACHE['%s:%s' % (pwd_id, eff_fid)] = new_fid
                    _persist_save_cache()
                except Exception:
                    pass
                return playable
            raise ValueError('saved share file has no playable URL')
        except Exception as e:
            last_err = e
            # stoken 可能已失效（分享被重开/会话过期）：清缓存后重申请一次。
            _SHARE_CACHE.pop(pwd_id, None)
            if attempt == 0:
                _time.sleep(0.8)
    # 已转存但分享链路失败的最后一档：直接用个人空间 fid 试 v2/play/download
    try:
        # 先查 per-file 转存缓存
        cached = _SAVE_CACHE.get('%s:%s' % (pwd_id, file_id))
        if cached:
            url = _quark_personal_play_url(cached, headers, retries=1, quality=quality)
            if url:
                return url
        url = _quark_personal_play_url(file_id, headers, retries=1, quality=quality)
        if url:
            return url
    except Exception:
        pass
    raise last_err or ValueError('share file play failed')


def _quark_download_url(share_id, file_id, file_token, headers):
    """夸克分享文件取流：file/download 返回重定向或 JSON 直链。"""
    if not share_id or not file_id:
        raise ValueError('missing share/file id')
    import json as _json
    r = _qpost(
        'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str=',
        headers={**headers, 'Content-Type': 'application/json'},
        data=_json.dumps({'fid': file_id, 'uid': 0, 'scene': 'share',
                          'shareId': share_id, 'token': file_token}),
        timeout=25, verify=True, allow_redirects=False)
    location = r.headers.get('Location', '') if getattr(r, 'headers', None) else ''
    if isinstance(location, str) and location.startswith(('http://', 'https://')):
        return location
    try:
        payload = r.json() or {}
    except Exception:
        logger.warning('quark upstream stage=download %s', _quark_response_meta(r))
        payload = {}
    data = payload.get('data') if isinstance(payload, dict) else None
    entries = data if isinstance(data, list) else [data]
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        url = entry.get('download_url') or entry.get('url') or entry.get('downloadUrl') or ''
        if isinstance(url, str) and url.startswith(('http://', 'https://')):
            return url
    status = getattr(r, 'status_code', 0)
    logger.warning('quark upstream stage=download URL unavailable %s',
                   _quark_response_meta(r))
    raise ValueError('download URL unavailable (status %s)' % status)


class _SegStream:
    """多线程分段下载 + 有界队列流水线按序转发。

    段 i 的下载线程把 chunk 放入队列 i（容量有限 → 背压）；转发线程按
    段 0..n-1 顺序消费，保证输出字节序与文件一致。
    """

    def __init__(self, url, headers, start, end, n):
        self.url = url
        self.headers = headers
        self.range_start = start
        self.range_end = end
        self.n = max(1, min(n, MAX_THREADS))
        self._queues = [queue.Queue(maxsize=QUEUE_DEPTH) for _ in range(self.n)]
        self._cancel = threading.Event()
        self._threads = []

    def _put(self, q, item):
        """入队（带超时重试）：队列满时每秒检查一次 _cancel，消费端断开后
        丢弃返回，避免下载线程被满队列永久阻塞（线程泄漏）。"""
        while not self._cancel.is_set():
            try:
                q.put(item, timeout=1.0)
                return True
            except queue.Empty:
                continue
        return False

    def _dl(self, i):
        total = self.range_end - self.range_start + 1
        seg = (total + self.n - 1) // self.n
        s = self.range_start + i * seg
        e = min(self.range_start + (i + 1) * seg - 1, self.range_end)
        q = self._queues[i]
        # 段下载失败（403 风控 / 5xx / 网络抖动）重试 3 次，退避后仍失败才中断流，
        # 避免单次瞬时失败直接打断播放（mpv 缓存耗尽即卡顿）。
        last_err = None
        for attempt in range(3):
            if self._cancel.is_set():
                return
            try:
                r = _fetch(self.url, self.headers, s, e)
                try:
                    if r.status_code in (200, 206):
                        for chunk in r.iter_content(SEG_CHUNK):
                            if self._cancel.is_set():
                                return
                            if not chunk:
                                continue
                            if not self._put(q, chunk):
                                return
                        self._put(q, None)  # 段结束哨兵（已取消则丢弃）
                        return
                    last_err = RuntimeError('段 %d HTTP %d' % (i, r.status_code))
                    logger.warning('go-proxy 段 %d/%d HTTP %d（重试 %d/3）', i, self.n, r.status_code, attempt + 1)
                finally:
                    r.close()
            except Exception as ex:
                last_err = RuntimeError('%s' % str(ex)[:100])
            time.sleep(0.3 * (attempt + 1))  # 0.3s / 0.6s / 0.9s 退避
        if not self._cancel.is_set():
            logger.warning('go-proxy 段 %d/%d 下载失败，中断流: %s', i, self.n, last_err)
            self._put(q, last_err)

    def start(self):
        for i in range(self.n):
            t = threading.Thread(target=self._dl, args=(i,), daemon=True)
            self._threads.append(t)
            t.start()

    def stream(self, out):
        """按段顺序消费队列写入 out；任一段出错即中断并取消其余下载。"""
        try:
            for i in range(self.n):
                q = self._queues[i]
                while True:
                    item = q.get()
                    if item is None:
                        break
                    if isinstance(item, Exception):
                        raise item
                    out.write(item)
        except BaseException:
            self._cancel.set()
            raise
        finally:
            self._cancel.set()


class _Handler(http.server.BaseHTTPRequestHandler):
    # HTTP/1.0：每个请求独立连接，避免 keep-alive 复用导致 mpv 起播后
    # seek（大 Range）复用同一连接发送第二个请求时协议错乱（ResponseNotReady）。
    protocol_version = 'HTTP/1.0'

    def log_message(self, *args):  # 静默访问日志
        pass

    def send_response(self, code, message=None):
        # 标记已发状态行（L-15）：异常分支据此避免重复 send_response，
        # 否则会产生两行状态行破坏响应协议
        self._headers_sent = True
        super().send_response(code, message)

    def _reject_browser(self):
        """浏览器来源防御（H-1b）：mpv/requests 发的请求没有 Origin /
        Sec-Fetch-Site 头；恶意网页跨站请求 127.0.0.1（盗流/探测）会带
        非本机 Origin 或 Sec-Fetch-Site: cross-site → 拒绝。"""
        origin = self.headers.get('Origin')
        if origin:
            try:
                host = urllib.parse.urlparse(origin).hostname
            except ValueError:
                return True
            if host not in ('127.0.0.1', 'localhost'):
                return True
        if (self.headers.get('Sec-Fetch-Site') or '').strip().lower() == 'cross-site':
            return True
        return False

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def do_HEAD(self):
        self._handle(head_only=True)

    def _handle(self, head_only=False):
        self._headers_sent = False
        try:
            if self._reject_browser():
                body = b'forbidden'
                self.send_response(403)
                self.send_header('Content-Type', 'text/plain')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if not head_only:
                    self.wfile.write(body)
                return
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query,
                                      keep_blank_values=True)
            do = q.get('do', [''])[0]
            supplied_token = q.get('token', [''])[0]
            if supplied_token:
                try:
                    import hoststate
                    if not hoststate.valid_proxy_token(supplied_token):
                        body = b'invalid proxy token'
                        self.send_response(401)
                        self.send_header('Content-Type', 'text/plain; charset=utf-8')
                        self.send_header('Content-Length', str(len(body)))
                        self.end_headers()
                        if not head_only:
                            self.wfile.write(body)
                        return
                except Exception:
                    self.send_response(401)
                    self.end_headers()
                    return

            body = None
            if self.command == 'POST':
                try:
                    length = int(self.headers.get('Content-Length', '0') or 0)
                except (TypeError, ValueError):
                    length = 0
                if 0 < length <= 8 * 1024 * 1024:
                    body = self.rfile.read(length)

            # 旧 7944/9978/1314 端口也必须能承载 JS/Python/JAR 的
            # localProxy。网盘 do=pan 与 url= 直链仍由下方的高吞吐实现处理。
            spider_params = {k: (v[-1] if len(v) == 1 else v) for k, v in q.items()}
            if do in ('js', 'py', 'jar') or (spider_params.get('siteKey') and do != 'pan'):
                self._handle_spider_proxy(spider_params, body, head_only)
                return

            # FongMi 本地代理协议：健康检查（蜘蛛启动时扫描端口用）
            if do == 'ck':
                body = b'ok'
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if not head_only:
                    self.wfile.write(body)
                return

            # FongMi 本地代理协议：网盘分享文件取流（夸克/UC/百度等）
            if do == 'pan':
                self._handle_pan(q, head_only)
                return

            raw = q.get('url', [''])[0]
            # parse_qs 已按 + → 空格语义解码过一次，不再重复 unquote_plus
            # （重复解码会破坏含 % 字符的正常 URL）；仅兼容个别 jar 双重
            # 编码：解码后仍含 %3A%2F%2F 形式的 scheme 时再补一次。
            url = raw
            if '%3a%2f%2f' in url[:32].lower():
                url = urllib.parse.unquote_plus(url)
            if not url.startswith(('http://', 'https://')):
                self.send_response(400)
                self.end_headers()
                return
            thread_n = 32
            try:
                thread_n = int(q.get('thread', ['32'])[0])
            except ValueError:
                pass
            # Cookie：请求头自带（mpv --http-header-fields）始终透传优先；
            # 自动附加已配置网盘 Cookie 仅限夸克/UC 域名（白名单防凭据外发）
            cookie = self.headers.get('Cookie', '')
            if not cookie and _cookie_host_allowed(url):
                try:
                    from pan_cookies import load_pan_cookies
                    cookie = load_pan_cookies().get('quark', '') or ''
                except Exception:
                    cookie = ''
            headers = {'User-Agent': BROWSER_UA, 'Referer': 'https://pan.quark.cn/'}
            if cookie:
                headers['Cookie'] = cookie

            # 探测总长度与 Content-Type（Range: bytes=0-0 → Content-Range: bytes 0-0/total）
            probe = _fetch(url, headers, 0, 0, timeout=30)
            total = None
            ctype = 'video/mp4'
            try:
                if probe.status_code not in (200, 206):
                    status = int(probe.status_code or 502)
                    logger.warning('go-proxy 上游 HTTP %d（旧 url 代理探测失败）', status)
                    body = ('upstream HTTP %d' % status).encode('ascii', 'replace')
                    self.send_response(status if 400 <= status <= 599 else 502)
                    self.send_header('Content-Type', 'text/plain; charset=utf-8')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    if not head_only:
                        self.wfile.write(body)
                    return
                cr = probe.headers.get('Content-Range', '')
                if '/' in cr:
                    total = int(cr.rsplit('/', 1)[1])
                ctype = _forward_content_type(probe.headers.get('Content-Type'), ctype)
            except (TypeError, ValueError):
                total = None
            finally:
                probe.close()
            if total is None or total <= 0:
                # 无长度信息（HLS 等）。m3u8 同样整体取回并重写分片地址——
                # do=pan 重写过的嵌套变体列表会经 ?url= 回到此处，二次重写
                # 保证任意深度嵌套的分片都落在代理内。
                if _is_hls_ctype(ctype):
                    _send_hls_playlist(self, url, headers, head_only)
                    return
                # 无长度信息（HLS 等）：先发 200 + 探测到的 Content-Type，
                # 不发 Content-Length，按开放区间（不带 Range）直接透传
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.end_headers()
                if head_only:
                    return
                self._stream_single(url, headers, head_only)
                return

            rng = self.headers.get('Range')
            parsed = _parse_range(rng, total)
            if parsed is None:
                # 越界/倒置 Range：416 + Content-Range: bytes */total
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % total)
                self.end_headers()
                return
            start, end = parsed
            length = end - start + 1

            if rng:
                self.send_response(206)
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, total))
            else:
                self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(length))
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
            if head_only:
                return

            # 单连接透传已能跑 ~4.5MB/s；大 Range 才分段，并发封顶 8（夸克 CDN 峰值
            # 为 8 连接并发，更高只增开销）。thread 参数尊重但有上限 8。
            eff = min(max(thread_n, 1), 8)
            if length < 32 * 1024 * 1024 or eff <= 1:
                self._stream_single(url, headers, head_only, start=start, end=end)
                return
            w = _SegStream(url, headers, start, end, eff)
            w.start()
            w.stream(self.wfile)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        except Exception as e:
            logger.warning('go-proxy request failed: %s', e, exc_info=True)
            if getattr(self, '_headers_sent', False):
                # 已发过状态行（L-15）：再 send_response 会产生重复状态行，
                # 只记录并关闭连接止损
                self.close_connection = True
                return
            try:
                self.send_response(502)
                self.end_headers()
            except Exception:
                pass

    def _handle_spider_proxy(self, query, body=None, head_only=False):
        """在旧数据面端口复用统一 Python Spider/JAR 调度和流桥。"""
        try:
            from proxy_contract import (decode_proxy_body, iter_body,
                                        merge_request_params, normalize_proxy_result,
                                        proxy_token_values)
            from proxy_gateway import dispatch
            import server

            fields, raw_body = decode_proxy_body(body, self.headers.get('Content-Type', ''))
            supplied_tokens = proxy_token_values(query, self.headers, fields)
            import hoststate
            if any(value and not hoststate.valid_proxy_token(value)
                   for value in supplied_tokens):
                body = b'invalid proxy token'
                self.send_response(401)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if not head_only:
                    self.wfile.write(body)
                return
            params = merge_request_params(query, dict(self.headers), fields,
                                           raw_body if raw_body is not None else None)
            result = normalize_proxy_result(dispatch(params, server.sites))
            headers = dict(result.headers or {})
            headers.setdefault('Content-Type', result.mime or 'application/octet-stream')
            self.send_response(int(result.status or 200))
            for key, value in headers.items():
                if value is not None:
                    self.send_header(str(key), str(value))
            self.end_headers()
            if head_only:
                return
            try:
                for chunk in iter_body(result.body):
                    if chunk:
                        self.wfile.write(chunk)
            finally:
                if callable(result.close):
                    try:
                        result.close()
                    except Exception:
                        pass
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        except Exception as e:
            logger.warning('legacy proxy gateway failed: %s', e, exc_info=True)
            if not getattr(self, '_headers_sent', False):
                try:
                    self.send_response(502)
                    self.send_header('Content-Type', 'text/plain; charset=utf-8')
                    self.end_headers()
                except Exception:
                    pass

    def _handle_pan(self, q, head_only=False):
        """网盘分享取流：do=pan&site=quark&shareId=&fileId=&fileToken=...

        蜘蛛 playerContent 返回该协议 URL（127.0.0.1:<port>/proxy?do=pan...）。
        若蜘蛛未解析出 shareId（分享解析失败兜底，fileId 为分享 URL），
        这里自行解析分享（token → detail → 首个文件）再取流。
        """
        site = q.get('site', [''])[0]
        # parse_qs already performs the single percent-decoding pass.  A
        # second unquote_plus would turn literal '+' characters in Quark
        # base64 tokens into spaces and invalidate the share request.
        share_id = q.get('shareId', q.get('share_id', ['']))[0]
        file_id = q.get('fileId', q.get('file_id', ['']))[0]
        file_token = q.get('fileToken', q.get('file_token', ['']))[0]
        pwd_id = q.get('pwdId', q.get('pwd_id', ['']))[0]
        share_url = q.get('shareUrl', q.get('share_url', ['']))[0]
        quality = q.get('quality', q.get('resolution', ['']))[0]
        cookie = self.headers.get('Cookie', '')
        if not cookie:
            # pan 链路目标均为 drive.quark.cn / drive-pc.quark.cn 等固定夸克
            # 域名，天然满足 Cookie 白名单；请求头自带 Cookie 始终透传优先
            try:
                from pan_cookies import load_pan_cookies
                cookie = (load_pan_cookies() or {}).get('quark', '') or ''
            except Exception:
                cookie = ''
        headers = {'User-Agent': BROWSER_UA, 'Referer': 'https://pan.quark.cn/'}
        if cookie:
            headers['Cookie'] = cookie
        if site != 'quark':
            self.send_response(400)
            self.end_headers()
            return
        if not cookie.strip():
            # 无 Cookie 时整条 Provider 链路必然失败：匿名 sharepage/token 能
            # 建会话，但 v2/play 必回 401 code=31001、file/download 回 400
            # code=14001，随后还会白跑转存+个人盘重试（约 11 次上游请求、4 秒）。
            # 这里快速失败：单条日志 + 立即 502，渲染层据 do=pan 地址给出
            # 「配置网盘 Cookie」引导。
            logger.warning('quark pan request rejected: 本机未存储夸克 Cookie，'
                           '请在设置中扫码登录（share=%s pwd=%s）',
                           bool(share_id), bool(pwd_id or share_url))
            body = b'quark login required: no pan cookie'
            self.send_response(502)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
            return
        try:
            # Provider registry 是新的抽象入口；下面保留旧分支作为兼容
            # fallback，便于第三方站点/老测试在迁移期间继续工作。
            from pan.registry import registry
            provider = registry.get(site)
            if provider is not None:
                play = provider.resolve_play_url({
                    'shareId': share_id,
                    'fileId': file_id,
                    'fileToken': file_token,
                    'pwdId': pwd_id,
                    'shareUrl': share_url,
                    'quality': quality,
                }, headers=headers)
                if play is None or not play.url:
                    # pwd 标记区分两类失败：有分享会话参数却解析失败（凭据/
                    # 分享本身的问题）vs 压根没带 pwd_id/分享链接（vodId 只有
                    # shareId+fid，PC 侧建不起分享会话，应交回 JAR 解析）。
                    logger.warning(
                        'quark play URL unavailable: share=%s pwd=%s file=%s',
                        bool(share_id), bool(pwd_id or share_url), file_id[:80])
                    body = b'quark play URL unavailable'
                    self.send_response(502)
                    self.send_header('Content-Type', 'text/plain; charset=utf-8')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    if not head_only:
                        self.wfile.write(body)
                    return
                def refresh_play():
                    fresh = provider.resolve_play_url({
                        'shareId': share_id,
                        'fileId': file_id,
                        'fileToken': file_token,
                        'pwdId': pwd_id,
                        'shareUrl': share_url,
                        'quality': quality,
                    }, headers=headers, refresh=True)
                    if fresh is None or not fresh.url:
                        return None
                    return fresh.url, (fresh.headers or headers)

                self._stream_forward(play.url, play.headers or headers, head_only,
                                     refresh=refresh_play)
                return
            if site != 'quark':
                self.send_response(400)
                self.end_headers()
                return
            url = None
            if (not share_id) and 'pan.quark.cn/s/' in file_id:
                pwd = file_id.split('/s/')[-1].split('?')[0].strip()
                url = _quark_share_play_url(pwd, headers)
            elif (not share_id) and file_id and 'pan.quark.cn/s/' not in file_id:
                # 我的夸克网盘文件（shareId 空、fileId 为纯 fid）：
                # 不经 jar 转存（ea3f 转存链路 pwd_id 为空必失败），
                # 直接 v2/play 取直链；失败退 file/download（网盘内文件无 share 语义）。
                try:
                    url = _quark_v2play(file_id, headers)
                except Exception:
                    url = None
                if not url:
                    try:
                        import json as _json
                        r = _qpost(
                            'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str=',
                            headers={**headers, 'Content-Type': 'application/json'},
                            data=_json.dumps({'fids': [file_id]}),
                            timeout=25, verify=True, allow_redirects=False)
                        d = ((r.json() or {}).get('data') or [{}])[0]
                        url = d.get('download_url') or ''
                    except Exception:
                        url = None
            elif share_id and file_id:
                # 蜘蛛已解析出分享参数：分享文件直链（file/download POST）或转存
                try:
                    url = _quark_download_url(share_id, file_id, file_token, headers)
                except Exception:
                    url = None
                if not url:
                    url = _quark_v2play(file_id, headers)
                # 已转存但分享链路失败：回退个人网盘 fid 直链
                if not url:
                    url = _quark_personal_play_url(file_id, headers, retries=1) or None
            if not url:
                self.send_response(502)
                self.end_headers()
                return
            self._stream_forward(url, headers, head_only)
        except Exception as e:
            logger.warning('go-proxy pan request failed: %s', e)
            if getattr(self, '_headers_sent', False):
                # 已发过状态行（L-15）：不再重复 send_response，关闭连接止损
                self.close_connection = True
                return
            try:
                self.send_response(502)
                self.end_headers()
            except Exception:
                pass

    def _stream_forward(self, url, headers, head_only, refresh=None):
        """通用取流转发：探测长度 → 分段并发/单线程 → 写回。

        并发上限 8：实测夸克 CDN 8 并发即达带宽峰值（12MB/s），更高并发
        只增加连接开销反而略降。小 Range（<32MB）用单连接透传，避免分
        段过多退化。
        """
        # 签名 URL 过期时，先用 Provider single-flight 刷新一次；不要在
        # 后续 Range 分段里无限重试，避免把 401/403 变成隐形死循环。
        # 部分夸克直链在签名失效或风控时回 200 + JSON/HTML（软失败），
        # 按文本 Content-Type 同样视为可刷新错误，避免把错误页当视频推给 mpv。
        def _is_soft_error(resp):
            try:
                ct = str(resp.headers.get('Content-Type') or '').strip()
                if _TEXTUAL_CONTENT_TYPE.match(ct):
                    return True
            except Exception:
                pass
            return False

        probe = None
        for attempt in range(2):
            probe = _fetch(url, headers, 0, 0, timeout=30)
            soft = _is_soft_error(probe)
            need_refresh = (probe.status_code in _REFRESHABLE_UPSTREAM_STATUSES or soft)
            if (not need_refresh or not callable(refresh) or attempt):
                # 软失败但无刷新回调时，同样视为失败而非直接透传错误页
                if soft and not callable(refresh):
                    # 尝试一次 Provider 刷新已在上层处理过，这里直接按 502 结束
                    pass
                break
            try:
                replacement = refresh()
            finally:
                probe.close()
            if not replacement:
                probe = _fetch(url, headers, 0, 0, timeout=30)
                break
            url, headers = replacement
        if probe is None:
            self.send_response(502)
            self.end_headers()
            return
        if probe.status_code not in (200, 206):
            status = int(probe.status_code or 502)
            probe.close()
            self.send_response(status if 400 <= status <= 599 else 502)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        total = None
        ctype = 'video/mp4'
        try:
            cr = probe.headers.get('Content-Range', '')
            if '/' in cr:
                total = int(cr.rsplit('/', 1)[1])
            ctype = _forward_content_type(probe.headers.get('Content-Type'), ctype)
        except (TypeError, ValueError):
            total = None
        finally:
            probe.close()
        if total is None or total <= 0:
            # 无长度信息（HLS 等）。m3u8 播放列表必须整体取回并重写分片地址：
            # 相对分片按代理基址解析必 404，绝对分片直连 CDN 缺凭据被拒。
            if _is_hls_ctype(ctype):
                if _send_hls_playlist(self, url, headers, head_only):
                    return
            # 其余未知长度流：先发 200 + 探测到的 Content-Type，
            # 不发 Content-Length，按开放区间（不带 Range）直接透传
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.end_headers()
            if head_only:
                return
            self._stream_single(url, headers, head_only)
            return
        rng = self.headers.get('Range')
        parsed = _parse_range(rng, total)
        if parsed is None:
            # 越界/倒置 Range：416 + Content-Range: bytes */total
            self.send_response(416)
            self.send_header('Content-Range', 'bytes */%d' % total)
            self.end_headers()
            return
        start, end = parsed
        length = end - start + 1
        if rng:
            self.send_response(206)
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, total))
        else:
            self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()
        if head_only:
            return
        # 单连接透传已能跑 ~4.5MB/s，小 Range 不值得分段（分段过细并发退化）；
        # 大 Range 用 8 并发（夸克 CDN 峰值约为 8 连接并发）。
        if length < 32 * 1024 * 1024:
            self._stream_single(url, headers, head_only, start=start, end=end)
            return
        w = _SegStream(url, headers, start, end, 8)
        w.start()
        w.stream(self.wfile)

    def _stream_single(self, url, headers, head_only, start=0, end=None):
        """单线程流式转发指定区间；end=None 表示开放区间（请求不带 Range 头）。

        上游非 200/206 时不透传错误体（L-16，Content-Length 已声明，写入
        错误体会破坏协议）：未发响应头时回 502，已发头则直接断连止损；
        上游 200 忽略 Range 时按已声明的区间长度截断写入。
        """
        try:
            r = _fetch(url, headers, start, end, timeout=30)
            try:
                if r.status_code not in (200, 206):
                    logger.warning('go-proxy 上游 HTTP %d（单流转发中断）', r.status_code)
                    if not getattr(self, '_headers_sent', False):
                        try:
                            self.send_response(502)
                            self.end_headers()
                        except Exception:
                            pass
                    else:
                        self.close_connection = True
                    return
                remain = None if end is None else (end - start + 1)
                for chunk in r.iter_content(SEG_CHUNK):
                    if not chunk:
                        continue
                    if remain is not None:
                        if remain <= 0:
                            break
                        if len(chunk) > remain:
                            chunk = chunk[:remain]
                        remain -= len(chunk)
                    self.wfile.write(chunk)
            finally:
                r.close()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


_base_servers = []


def start_go_proxy():
    """启动本地代理服务（幂等：已监听则复用）。

    主端口 9978（FongMi 蜘蛛启动时扫描 9978-10000 找 go-proxy），
    另起 EXTRA_PORTS（1314，jar 硬编码的播放转发模板）监听。
    返回 server 对象或 None。
    """
    global _base_servers
    if _base_servers:
        return _base_servers[0]
    servers = []
    for port in [PORT] + list(EXTRA_PORTS):
        try:
            srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), _Handler)
        except OSError as e:
            logger.warning('go-proxy %d 启动失败（端口可能已被占用）: %s', port, e)
            continue
        t = threading.Thread(target=srv.serve_forever, daemon=True,
                             name='go-proxy-%d' % port)
        t.start()
        servers.append(srv)
        logger.info('go-proxy listening on 127.0.0.1:%d（FongMi localProxy 兼容，多线程分段）', port)
    _base_servers = servers
    return servers[0] if servers else None


# ---- 端口泛化（TVBOX_COMPAT_PLAN 任务二）-------------------------------
# jar 家族把 127.0.0.1:<port> 硬编码进字节码（7944/9978/1314 只是已知三家），
# 穷举永远追不上新 jar。改为按需补监听：播放 URL 流经点（jar_spider）与
# jar 加载期字节扫描（jar_bridge）都会调 ensure_listener，同一 _Handler 协议。
_extra_servers = {}
_extra_servers_lock = threading.Lock()
EXTRA_LISTENER_CAP = 16   # 泛化监听上限（防异常 jar 打满端口）


def ensure_listener(port):
    """幂等按需监听（只绑 127.0.0.1）。

    返回 True=本端口可用（已在监听/新起成功/被外部进程占用）；
    False=拒绝（保护端口/超范围/达上限）。bind 失败视为"已有服务"——
    被占用的可能正是真代理，播放 URL 能连通即达成目的。
    """
    try:
        port = int(port)
    except (TypeError, ValueError):
        return False
    protected = {PORT} | set(EXTRA_PORTS)
    try:
        import hoststate
        backend_port = int(hoststate.get_port() or 0)
        if backend_port > 0:
            protected.add(backend_port)   # 绝不把代理 Handler 挂到后端 API 端口
    except Exception:
        pass
    if port in protected or not (1024 <= port <= 65535):
        return False
    with _extra_servers_lock:
        if port in _extra_servers:
            return True
        if len(_extra_servers) >= EXTRA_LISTENER_CAP:
            logger.warning('go-proxy 泛化监听达上限(%d)，忽略端口 %d', EXTRA_LISTENER_CAP, port)
            return False
        try:
            srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), _Handler)
        except OSError:
            return True   # 已被其他进程监听，视为覆盖
        threading.Thread(target=srv.serve_forever, daemon=True,
                         name='go-proxy-auto-%d' % port).start()
        _extra_servers[port] = srv
        logger.info('go-proxy 泛化监听已启动: 127.0.0.1:%d', port)
        return True


def stop_go_proxy():
    """关闭全部固定/动态监听器；配置重置和应用退出共用。"""
    global _base_servers
    with _extra_servers_lock:
        servers = list(_base_servers) + list(_extra_servers.values())
        _base_servers = []
        _extra_servers.clear()
    for server in servers:
        try:
            server.shutdown()
        except Exception:
            pass
        try:
            server.server_close()
        except Exception:
            pass
