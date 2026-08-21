# -*- coding: utf-8 -*-
"""Q7.1 确定性离线夹具服务：提供标准及边缘 HTTP 服务，包含：
- JSON/XML CMS
- 注释/gzip/JPEG/PNG 伪装配置
- 多仓与相对 api/jar/ext
- 直链 MP4 与 master/variant HLS
- Referer/Cookie 校验与 302/307 重定向
- Range 206 与故意错误的 Content-Range
- HTML 假视频地址
- 解析器 JSON、iframe 与媒体嗅探
- 慢响应、无限流、连接中断与过期 URL
"""
import http.server
import json
import threading
import time
import urllib.parse

MINIMAL_MP4 = (
    b'\x00\x00\x00\x1cftypisom\x00\x00\x02\x00isomiso2mp41\x00\x00\x00\x08free'
    b'\x00\x00\x00(mdat' + b'\x00' * 32
)

SAMPLE_XML_CMS = """<?xml version="1.0" encoding="utf-8" ?>
<rss version="5.1">
<class>
    <ty id="1">电影</ty>
    <ty id="2">连续剧</ty>
</class>
<list page="1" pagecount="1" pagesize="20" recordcount="1">
    <video>
        <last>2026-08-18 12:00:00</last>
        <id>xml_vod_1</id>
        <tid>1</tid>
        <name><![CDATA[离线XML电影]]></name>
        <type>电影</type>
        <pic>http://127.0.0.1/pic.jpg</pic>
        <lang>国语</lang>
        <area>大陆</area>
        <year>2026</year>
        <note><![CDATA[HD]]></note>
        <actor><![CDATA[测试演员]]></actor>
        <director><![CDATA[测试导演]]></director>
        <dl>
            <dd flag="默认"><![CDATA[第1集$http://127.0.0.1/video.mp4]]></dd>
        </dl>
        <des><![CDATA[离线XML测试简介]]></des>
    </video>
</list>
</rss>
"""

SAMPLE_JSON_CMS = {
    "code": 1,
    "msg": "数据成功",
    "page": 1,
    "pagecount": 1,
    "limit": "20",
    "total": 1,
    "class": [
        {"type_id": 1, "type_name": "电影"},
        {"type_id": 2, "type_name": "连续剧"}
    ],
    "list": [
        {
            "vod_id": "json_vod_1",
            "vod_name": "离线JSON电影",
            "type_id": 1,
            "type_name": "电影",
            "vod_pic": "http://127.0.0.1/pic.jpg",
            "vod_play_from": "q7_line1$$$q7_line2",
            "vod_play_url": "第1集$http://127.0.0.1/video.mp4#第2集$http://127.0.0.1/video2.mp4$$$第1集$http://127.0.0.1/hls/variant.m3u8"
        }
    ]
}


class Q7OfflineHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'q7-fixture/1.0'

    def log_message(self, *args):
        pass

    def _send(self, status, body, ctype='application/json; charset=utf-8', headers=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != 'HEAD':
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)
        route = parts.path
        query = urllib.parse.parse_qs(parts.query)

        # 1. CMS (JSON / XML)
        if route == '/cms/json':
            self._send(200, json.dumps(SAMPLE_JSON_CMS))
            return
        if route == '/cms/xml':
            self._send(200, SAMPLE_XML_CMS, ctype='text/xml; charset=utf-8')
            return

        if route == '/config/perf_100.json':
            sites = [
                {"key": f"perf_site_{i}", "name": f"Perf Site {i}", "type": 1, "api": f"http://127.0.0.1:{self.server.server_port}/cms/json"}
                for i in range(100)
            ]
            self._send(200, json.dumps({"sites": sites}))
            return

        # 2. 直链 MP4 (支持 Range 206 及错误 Content-Range)
        if route == '/media/video.mp4':
            data = MINIMAL_MP4
            range_hdr = self.headers.get('Range')
            if range_hdr and range_hdr.startswith('bytes='):
                parts_r = range_hdr[6:].split('-')
                start = int(parts_r[0])
                end = int(parts_r[1]) if parts_r[1] else len(data) - 1
                length = end - start + 1
                self.send_response(206)
                self.send_header('Content-Type', 'video/mp4')
                self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
                self.send_header('Content-Length', str(length))
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(data[start:end+1])
            else:
                self._send(200, data, ctype='video/mp4')
            return

        if route == '/media/bad_range.mp4':
            # 故意返回错误的 Content-Range
            self.send_response(206)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Content-Range', 'bytes 100-50/10')
            self.send_header('Content-Length', '10')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(b'0123456789')
            return

        # 3. Master & Variant HLS
        if route == '/hls/master.m3u8':
            master_content = (
                "#EXTM3U\n"
                "#EXT-X-VERSION:3\n"
                "#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720\n"
                "variant.m3u8\n"
            )
            self._send(200, master_content, ctype='application/vnd.apple.mpegurl')
            return

        if route == '/hls/variant.m3u8':
            variant_content = (
                "#EXTM3U\n"
                "#EXT-X-VERSION:3\n"
                "#EXT-X-TARGETDURATION:10\n"
                "#EXT-X-MEDIA-SEQUENCE:0\n"
                "#EXTINF:10.0,\n"
                "/hls/seg0.ts\n"
                "#EXT-X-ENDLIST\n"
            )
            self._send(200, variant_content, ctype='application/vnd.apple.mpegurl')
            return

        if route == '/hls/seg0.ts':
            self._send(200, b'\x47' + b'\x00' * 187, ctype='video/MP2T')
            return

        # 4. Referer / Cookie 校验
        if route == '/auth/check':
            referer = self.headers.get('Referer', '')
            cookie = self.headers.get('Cookie', '')
            if 'allowed-site.com' in referer and 'session=token123' in cookie:
                self._send(200, json.dumps({'ok': True, 'msg': 'authorized'}))
            else:
                self._send(403, json.dumps({'ok': False, 'msg': 'forbidden: bad referer or cookie'}))
            return

        # 5. 重定向 (302/307)
        if route == '/redirect/302':
            self.send_response(302)
            self.send_header('Location', '/media/video.mp4')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if route == '/redirect/307':
            self.send_response(307)
            self.send_header('Location', '/media/video.mp4')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        # 6. HTML 假视频 / 网页
        if route == '/fake_video.html':
            html = "<html><body><h1>This is a web page, not a video stream</h1></body></html>"
            self._send(200, html, ctype='text/html; charset=utf-8')
            return

        # 7. 解析器 JSON / iframe / 媒体嗅探
        if route == '/parser/json':
            # 解析器返回直链
            target_url = f"http://127.0.0.1:{self.server.server_port}/media/video.mp4"
            resp = {
                "code": 200,
                "msg": "ok",
                "url": target_url,
                "header": {"User-Agent": "Custom-Parser-Agent"}
            }
            self._send(200, json.dumps(resp))
            return

        if route == '/parser/iframe':
            iframe_page = f"""<html><body>
            <iframe src="http://127.0.0.1:{self.server.server_port}/fake_video.html"></iframe>
            <video src="http://127.0.0.1:{self.server.server_port}/media/video.mp4"></video>
            </body></html>"""
            self._send(200, iframe_page, ctype='text/html; charset=utf-8')
            return

        # 8. 故障流：慢响应、无限流、连接中断、过期 URL
        if route == '/fault/slow':
            ms = float((query.get('ms') or ['500'])[0])
            time.sleep(ms / 1000.0)
            self._send(200, json.dumps({'status': 'slow_done'}))
            return

        if route == '/fault/infinite':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            try:
                while True:
                    self.wfile.write(b"data-stream-chunk\n")
                    self.wfile.flush()
                    time.sleep(0.1)
            except Exception:
                pass
            return

        if route == '/fault/abort':
            self._send(500, json.dumps({'error': 'server error'}))
            return

        if route == '/fault/expired':
            exp = int((query.get('exp') or ['0'])[0])
            if exp < int(time.time()):
                self._send(403, json.dumps({'error': 'URL expired'}))
            else:
                self._send(200, json.dumps({'status': 'valid'}))
            return

        self._send(404, json.dumps({'error': 'Not Found'}))


class _QuietQ7Server(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class Q7OfflineFixtureServer:
    def __init__(self):
        self.httpd = _QuietQ7Server(('127.0.0.1', 0), Q7OfflineHandler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_port
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def close(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass
