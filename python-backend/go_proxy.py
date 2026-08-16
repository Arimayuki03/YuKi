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
import threading
import time
import urllib.parse

import requests

logger = logging.getLogger('vpc.goproxy')

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
# 分享转存结果缓存：pwd_id → 转存后的文件 fid（转存一次，后续播放秒开）。
# 持久化到磁盘：后端重启不重复转存、也不占用网盘空间（转存一次永久可用）。
_SAVE_CACHE = {}
# 分享解析缓存：pwd_id → {ts, stoken, fid, fid_token}（5 分钟 TTL，避免重复 token/detail）
_SHARE_CACHE = {}
_SHARE_CACHE_TTL = 300
# 转存缓存持久化文件（放用户数据目录，幂等创建）
_SAVE_CACHE_FILE = None


def _save_cache_file():
    global _SAVE_CACHE_FILE
    if _SAVE_CACHE_FILE is None:
        try:
            d = os.path.join(os.path.expanduser('~'), '.video-pc', 'cache')
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
    try:
        p = _save_cache_file()
        if p:
            with open(p, 'w', encoding='utf-8') as f:
                f.write(json.dumps(_SAVE_CACHE, ensure_ascii=False))
    except Exception:
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
        return 0, total - 1
    return start, end


def _fetch(url, headers, start, end, timeout=60):
    """单段请求：GET Range=bytes=start-end，流式返回 response。"""
    h = dict(headers)
    h['Range'] = 'bytes=%d-%d' % (start, end)
    return requests.get(url, headers=h, stream=True, timeout=timeout,
                        verify=False, allow_redirects=True)


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
            r = requests.post(
                'https://drive.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
                headers={**headers, 'Content-Type': 'application/json'},
                data=_json.dumps({'pwd_id': pwd_id, 'passcode': ''}),
                timeout=20, verify=False)
            stoken = ((r.json() or {}).get('data') or {}).get('stoken', '')
            if not stoken:
                raise ValueError('share token empty')
            r2 = requests.get(
                'https://drive.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=%s&stoken=%s'
                % (pwd_id, stoken),
                headers=headers, timeout=20, verify=False)
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


def _quark_v2play(fid, headers):
    """v2/play 取播放直链；分享文件未转存（file not found）返回 None。"""
    import json as _json
    r = requests.post(
        'https://drive-pc.quark.cn/1/clouddrive/file/v2/play?pr=ucpro&fr=pc&uc_param_str=',
        headers={**headers, 'Content-Type': 'application/json'},
        data=_json.dumps({'fid': fid, 'resolutions': 'normal,low,high,super,2k,4k',
                          'supports': 'fmp4,m3u8'}),
        timeout=25, verify=False, allow_redirects=False)
    try:
        j = r.json()
    except Exception:
        return None
    if 'file not found' in (j.get('message') or ''):
        return None
    # 递归找第一个 http(s) 直链（play_info.urls 结构随接口版本变化）
    found = [None]

    def walk(node):
        if found[0]:
            return
        if isinstance(node, dict):
            if 'url' in node and isinstance(node.get('url'), str) and node['url'].startswith('http'):
                found[0] = node['url']
                return
            for v in node.values():
                walk(v)
                if found[0]:
                    return
        elif isinstance(node, list):
            for v in node:
                walk(v)
                if found[0]:
                    return
    walk(j)
    return found[0]


def _quark_save_share(pwd_id, stoken, fid, fid_token, headers):
    """转存分享文件：sharepage/save → 轮询任务 → 新 fid（网盘内）。

    返回转存后的 fid；失败抛异常。
    """
    import json as _json
    import time as _time
    body = {"pdir_fid": "0", "pwd_id": pwd_id, "scene": "link", "stoken": stoken,
            "to_pdir_fid": "0", "fid_list": [fid], "fid_token_list": [fid_token]}
    r = requests.post(
        'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc&uc_param_str=&__t=%d'
        % int(_time.time() * 1000),
        headers={**headers, 'Content-Type': 'application/json'},
        data=_json.dumps(body), timeout=25, verify=False)
    tid = ((r.json() or {}).get('data') or {}).get('task_id', '')
    if not tid:
        raise ValueError('save task id empty')
    for _ in range(12):
        _time.sleep(1)
        try:
            r2 = requests.get(
                'https://drive-pc.quark.cn/1/clouddrive/task?pr=ucpro&fr=pc&uc_param_str=&task_id=%s' % tid,
                headers=headers, timeout=20, verify=False)
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


def _quark_share_play_url(pwd_id, headers):
    """夸克分享完整播放链路：token → detail →（进目录找视频）→ v2/play 或转存后播放。

    转存结果按 pwd_id 缓存（进程内）：首次播放转存（约 5-15s），同分享再次
    播放直接 v2/play 秒开，避免重复转存占用网盘空间与等待。缓存失效
    （v2/play 404）时自动重新转存。
    解析结果（stoken/detail）另缓存 5 分钟，避免重复 token/detail 请求触发限流。
    夸克 API 偶发空响应（限流抖动），重试间隔递增（1/2/4s）。
    """
    import json as _json
    import time as _time
    now = _time.time()
    cached_fid = _SAVE_CACHE.get(pwd_id)
    if cached_fid:
        try:
            url = _quark_v2play(cached_fid, headers)
            if url:
                return url
        except Exception:
            pass
        _SAVE_CACHE.pop(pwd_id, None)  # 缓存失效（文件被删/转存过期）→ 重新转存
    last_err = None
    for attempt in range(3):
        try:
            # 解析缓存（5 分钟内同分享直接复用 stoken/detail，跳过 token/detail 请求）
            sc = _SHARE_CACHE.get(pwd_id)
            if sc and (now - sc.get('ts', 0)) < _SHARE_CACHE_TTL and sc.get('fid'):
                stoken, fid, fid_token = sc['stoken'], sc['fid'], sc['fid_token']
            else:
                r = requests.post(
                    'https://drive.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
                    headers={**headers, 'Content-Type': 'application/json'},
                    data=_json.dumps({'pwd_id': pwd_id, 'passcode': ''}),
                    timeout=20, verify=False)
                stoken = ((r.json() or {}).get('data') or {}).get('stoken', '')
                if not stoken:
                    raise ValueError('share token empty')
                base = 'https://drive.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=%s&stoken=%s'
                detail_url = base % (pwd_id, stoken)
                r2 = requests.get(detail_url, headers=headers, timeout=20, verify=False)
                lst = ((r2.json() or {}).get('data') or {}).get('list') or []
                if not lst:
                    raise ValueError('share has no files')
                f = _quark_pick_video(lst)
                if f is None:
                    # 根目录只有文件夹：进入第一个目录找视频（夸克对 pdir_fid 限流严重）
                    folder = lst[0]
                    lst2 = []
                    for sub in range(4):
                        r3 = requests.get(detail_url + '&pdir_fid=%s' % str(folder.get('fid', '')),
                                          headers=headers, timeout=20, verify=False)
                        lst2 = ((r3.json() or {}).get('data') or {}).get('list') or []
                        if lst2:
                            break
                        _time.sleep(0.8 * (sub + 1))
                    f = _quark_pick_video(lst2)
                if f is None:
                    raise ValueError('share has no video file')
                fid = str(f.get('fid', ''))
                fid_token = str(f.get('share_fid_token') or '')
                _SHARE_CACHE[pwd_id] = {'ts': _time.time(), 'stoken': stoken,
                                        'fid': fid, 'fid_token': fid_token}
            url = _quark_v2play(fid, headers)
            if url:
                return url
            new_fid = _quark_save_share(pwd_id, stoken, fid, fid_token, headers)
            if new_fid:
                _SAVE_CACHE[pwd_id] = new_fid  # 转存一次，后续秒开（含重启后）
                _persist_save_cache()
            return _quark_v2play(new_fid, headers)
        except Exception as e:
            last_err = e
            if attempt < 2:
                _time.sleep(1.0 * (attempt + 1))
    raise last_err or ValueError('share play failed')


def _quark_download_url(share_id, file_id, file_token, headers):
    """夸克分享文件取流：POST file/download（新版接口）→ 302 Location 真实直链。

    返回直链 URL；无 Location 抛异常。
    """
    if not share_id or not file_id:
        raise ValueError('missing share/file id')
    import json as _json
    r = requests.post(
        'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str=',
        headers={**headers, 'Content-Type': 'application/json'},
        data=_json.dumps({'fid': file_id, 'uid': 0, 'scene': 'share',
                          'shareId': share_id, 'token': file_token}),
        timeout=25, verify=False, allow_redirects=False)
    loc = r.headers.get('Location', '')
    if not loc:
        raise ValueError('download no location (status %s)' % r.status_code)
    return loc


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
                            q.put(chunk)  # 满则阻塞（背压）
                        q.put(None)  # 段结束哨兵
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
            q.put(last_err)

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

    def do_GET(self):
        self._handle()

    def do_HEAD(self):
        self._handle(head_only=True)

    def _handle(self, head_only=False):
        try:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            do = q.get('do', [''])[0]

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
            url = urllib.parse.unquote_plus(raw)
            if not url.startswith(('http://', 'https://')):
                self.send_response(400)
                self.end_headers()
                return
            thread_n = 32
            try:
                thread_n = int(q.get('thread', ['32'])[0])
            except ValueError:
                pass
            # Cookie：请求头自带（mpv --http-header-fields）优先，否则用已配置的网盘 Cookie
            cookie = self.headers.get('Cookie', '')
            if not cookie:
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
                cr = probe.headers.get('Content-Range', '')
                if '/' in cr:
                    total = int(cr.rsplit('/', 1)[1])
                ctype = probe.headers.get('Content-Type') or ctype
            except (TypeError, ValueError):
                total = None
            finally:
                probe.close()
            if total is None or total <= 0:
                # 无长度信息（HLS 等）：退化单线程透传
                self._stream_single(url, headers, head_only)
                return

            rng = self.headers.get('Range')
            start, end = _parse_range(rng, total)
            length = end - start + 1

            if rng:
                self.send_response(206)
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, total))
            else:
                self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(length))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            if head_only:
                return

            if length < 4 * 1024 * 1024 or thread_n <= 1:
                self._stream_single(url, headers, head_only, start=start, end=end)
                return
            w = _SegStream(url, headers, start, end, thread_n)
            w.start()
            w.stream(self.wfile)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        except Exception as e:
            logger.warning('go-proxy request failed: %s', e, exc_info=True)
            try:
                self.send_response(502)
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
        share_id = urllib.parse.unquote_plus(q.get('shareId', [''])[0])
        file_id = urllib.parse.unquote_plus(q.get('fileId', [''])[0])
        file_token = urllib.parse.unquote_plus(q.get('fileToken', [''])[0])
        cookie = self.headers.get('Cookie', '')
        if not cookie:
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
        try:
            if site != 'quark':
                self.send_response(400)
                self.end_headers()
                return
            url = None
            if (not share_id) and 'pan.quark.cn/s/' in file_id:
                pwd = file_id.split('/s/')[-1].split('?')[0].strip()
                url = _quark_share_play_url(pwd, headers)
            elif share_id and file_id:
                # 蜘蛛已解析出分享参数：分享文件直链（file/download POST）或转存
                try:
                    url = _quark_download_url(share_id, file_id, file_token, headers)
                except Exception:
                    url = None
                if not url:
                    url = _quark_v2play(file_id, headers)
            if not url:
                self.send_response(502)
                self.end_headers()
                return
            self._stream_forward(url, headers, head_only)
        except Exception as e:
            logger.warning('go-proxy pan request failed: %s', e)
            try:
                self.send_response(502)
                self.end_headers()
            except Exception:
                pass

    def _stream_forward(self, url, headers, head_only):
        """通用取流转发：探测长度 → 分段并发/单线程 → 写回。"""
        probe = _fetch(url, headers, 0, 0, timeout=30)
        total = None
        ctype = 'video/mp4'
        try:
            cr = probe.headers.get('Content-Range', '')
            if '/' in cr:
                total = int(cr.rsplit('/', 1)[1])
            ctype = probe.headers.get('Content-Type') or ctype
        except (TypeError, ValueError):
            total = None
        finally:
            probe.close()
        if total is None or total <= 0:
            self._stream_single(url, headers, head_only)
            return
        rng = self.headers.get('Range')
        start, end = _parse_range(rng, total)
        length = end - start + 1
        if rng:
            self.send_response(206)
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, total))
        else:
            self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        if head_only:
            return
        if length < 4 * 1024 * 1024:
            self._stream_single(url, headers, head_only, start=start, end=end)
            return
        w = _SegStream(url, headers, start, end, MAX_THREADS)
        w.start()
        w.stream(self.wfile)

    def _stream_single(self, url, headers, head_only, start=0, end=None):
        """单线程流式转发指定区间。"""
        try:
            r = _fetch(url, headers, start, end if end is not None else start, timeout=30)
            try:
                for chunk in r.iter_content(SEG_CHUNK):
                    if not chunk:
                        continue
                    self.wfile.write(chunk)
            finally:
                r.close()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


def start_go_proxy():
    """启动本地代理服务（幂等：已监听则复用）。

    主端口 9978（FongMi 蜘蛛启动时扫描 9978-10000 找 go-proxy），
    另起 EXTRA_PORTS（1314，jar 硬编码的播放转发模板）监听。
    返回 server 对象或 None。
    """
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
    return servers[0] if servers else None
