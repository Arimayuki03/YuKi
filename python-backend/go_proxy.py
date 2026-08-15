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
import queue
import threading
import urllib.parse

import requests

logger = logging.getLogger('vpc.goproxy')

PORT = 7944
BROWSER_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
# 并发上限：与官方 thread=32 一致；32 连接即可跑满带宽
MAX_THREADS = 32
SEG_CHUNK = 262144
QUEUE_DEPTH = 24  # 每段在途 chunk 上限（背压：下载过快时阻塞下载线程）


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
        try:
            r = _fetch(self.url, self.headers, s, e)
            try:
                if r.status_code not in (200, 206):
                    q.put(RuntimeError('段 %d HTTP %d' % (i, r.status_code)))
                    return
                for chunk in r.iter_content(SEG_CHUNK):
                    if self._cancel.is_set():
                        return
                    if not chunk:
                        continue
                    q.put(chunk)  # 满则阻塞（背压）
            finally:
                r.close()
        except Exception as ex:
            if not self._cancel.is_set():
                q.put(RuntimeError('%s' % str(ex)[:100]))
            return
        finally:
            try:
                q.put(None)  # 段结束哨兵
            except queue.Full:
                pass

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
            raw = q.get('url', [''])[0]
            url = urllib.parse.unquote_plus(raw)
            if not url.startswith(('http://', 'https://')):
                self.send_response(400)
                self.end_headers()
                return
            thread_n = 4
            try:
                thread_n = int(q.get('thread', ['4'])[0])
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
    """启动 7944 转发服务（幂等：已监听则复用）。返回 server 对象或 None。"""
    try:
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), _Handler)
    except OSError as e:
        logger.warning('go-proxy %d 启动失败（端口可能已被占用）: %s', PORT, e)
        return None
    t = threading.Thread(target=srv.serve_forever, daemon=True,
                         name='go-proxy-7944')
    t.start()
    logger.info('go-proxy listening on 127.0.0.1:%d（FongMi localProxy 兼容，多线程分段）', PORT)
    return srv
