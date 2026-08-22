# -*- coding: utf-8 -*-
"""夸克网盘二维码扫码登录（自动保存 Cookie）。

逆向自夸克网页版登录流程（pan.quark.cn 静态页 bundle）：
  1. GET  uop.quark.cn/cas/ajax/getTokenForQrcodeLogin       → data.members.token
  2. 二维码内容 = https://su.quark.cn/4_eMHBJ?token=<t>&client_id=532&ssb=weblogin&uc_biz_str=...
  3. 每 2s 轮询 GET uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?token=<t>
     → status==2000000 时 data.members.service_ticket（未扫码 50004001）
  4. GET  pan.quark.cn/account/info?st=<ST>                  → 服务端 Set-Cookie 完成登录
  5. 收集 session 中的 quark.cn Cookie，保存到 pan_cookies.json 的 quark 项

实现说明：使用 curl_cffi 的 chrome 指纹（TLS/HTTP2 与真实浏览器一致），
避免服务端把脚本来源的 token 判定为风控对象（表现：手机端扫码确认时报「登录请求过期」）。
"""
import io
import logging
import threading
import time
import urllib.parse

from pan_cookies import save_pan_cookies

logger = logging.getLogger('yuki.panlogin')

BROWSER_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
QR_BASE = 'https://su.quark.cn/4_eMHBJ'
# 与网页版完全一致：uc_biz_str 等 query 值需 URL 编码（url.format → querystring.stringify），
# 未编码的 | @ : 会导致夸克 App 扫码后校验失败，提示「登录请求过期」。
UC_BIZ_STR = 'S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0'


def _scan_page(token):
    """构造二维码内容 URL（与网页版 Hk() 输出一致：全参数 URL 编码）。"""
    return QR_BASE + '?' + urllib.parse.urlencode({
        'token': token,
        'client_id': '532',
        'ssb': 'weblogin',
        'uc_param_str': '',
        'uc_biz_str': UC_BIZ_STR,
    })


# token -> (session, created_ts, lock)；并发轮询共用同一 session 保证 Cookie 连续
_sessions = {}
_lock = threading.Lock()
# 夸克侧二维码 token 实测约 3 分钟（180s 有效、210s 过期 50004002）。
# 本地会话比它略短，确保 expired 判断早于夸克侧失效；前端 170s 自动换新兜底。
SESSION_TTL = 200


def _new_session():
    """curl_cffi session：chrome 指纹 + 完整浏览器请求头（与网页版一致）。"""
    try:
        from curl_cffi import requests as cr
    except ImportError:
        cr = None
    if cr is None:
        raise RuntimeError('缺少 curl_cffi（pip install curl_cffi），无法进行扫码登录')
    s = cr.Session(impersonate='chrome')
    s.headers.update({
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
    })
    # 先访问主页拿 ctoken（后续接口需要）
    try:
        s.get('https://pan.quark.cn/', timeout=20)
    except Exception as e:
        logger.warning('pan.quark.cn 预热失败（可能不影响登录）: %s', e)
    # 切换到页面内 API 请求头（模拟浏览器 fetch 到 uop.quark.cn）
    s.headers.update({
        'Referer': 'https://pan.quark.cn/',
        'Origin': 'https://pan.quark.cn',
        'Accept': 'application/json, text/plain, */*',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
    })
    return s


def _cleanup():
    now = time.time()
    with _lock:
        for tok in [t for t, (_, ts, _l) in _sessions.items() if now - ts > SESSION_TTL]:
            del _sessions[tok]


def quark_qr_create():
    """创建扫码登录会话：返回 {token, qr_text, qr_png(base64)}。"""
    _cleanup()
    s = _new_session()
    r = s.get('https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin', timeout=20)
    r.raise_for_status()
    d = r.json()
    members = (d.get('data') or {}).get('members') or {}
    token = members.get('token') or ''
    if not token:
        raise RuntimeError('获取二维码失败：' + str(d.get('message') or d)[:120])
    qr_text = _scan_page(token)
    with _lock:
        _sessions[token] = (s, time.time(), threading.Lock())
    png = _render_qr_png(qr_text)
    logger.info('qr created token=%s', token[:26])
    return {'token': token, 'qr_text': qr_text, 'qr_png': png}


def _render_qr_png(text):
    """用 qrcode 库渲染二维码 PNG（base64 data URI）。库缺失时返回 None。"""
    try:
        import qrcode
        import base64
        qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M,
                           box_size=6, border=2)
        qr.add_data(text)
        qr.make(fit=True)
        img = qr.make_image(fill_color='black', back_color='white')
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
    except Exception as e:
        logger.warning('qrcode render failed: %s', e)
        return None


def quark_qr_poll(token):
    """轮询扫码状态。返回 {status, message, cookies?}：
    waiting=未扫码 / ok=登录成功已保存 / expired=过期 / error=失败"""
    with _lock:
        item = _sessions.get(token)
    if not item:
        return {'status': 'expired', 'message': '二维码已失效，请重新获取'}
    s, created, lk = item
    if time.time() - created > SESSION_TTL:
        return {'status': 'expired', 'message': '二维码已过期，请重新获取'}
    with lk:
        try:
            r = s.get('https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken',
                      params={'token': token}, timeout=20)
            d = r.json()
        except Exception as e:
            logger.warning('qrcode poll failed: %s', e)
            return {'status': 'error', 'message': '轮询失败：%s' % str(e)[:80]}
    status = d.get('status')
    if status == 2000000:
        st = ((d.get('data') or {}).get('members') or {}).get('service_ticket') or ''
        logger.info('qr confirmed token=%s st=%s', token[:26], st[:16])
        if not st:
            return {'status': 'error', 'message': '登录成功但未取得票据，请重试'}
        return _exchange_st(s, st)
    if status == 50004001:
        return {'status': 'waiting', 'message': '等待扫码…'}
    if status in (50001000, 50001001, 50004002):
        return {'status': 'expired', 'message': '二维码已过期，请重新获取'}
    msg = str(d.get('message') or d)[:100]
    logger.info('qrcode poll status=%s msg=%s token=%s', status, msg, token[:20])
    return {'status': 'waiting', 'message': '等待扫码…'}


def render_qr_png(text):
    """渲染任意文本为二维码 PNG data URI（主进程扫码登录用）。"""
    return _render_qr_png(text)


def _exchange_st(s, st):
    """用 service_ticket 兑换登录态：GET account/info?st=，随后收集 Set-Cookie 保存。"""
    try:
        r = s.get('https://pan.quark.cn/account/info', params={'st': st}, timeout=20)
        body = r.text[:200]
    except Exception as e:
        logger.warning('exchange st failed: %s', e)
        return {'status': 'error', 'message': '兑换登录态失败：%s' % str(e)[:80]}
    # 收集 quark 相关域 Cookie（__puus/__pus/ctoken/_UP_* 等）
    parts = []
    try:
        jar = s.cookies
        items = jar.items() if hasattr(jar, 'items') else []
    except Exception:
        items = []
    for name, value in items:
        if 'quark.cn' in name.lower() or 'uc.cn' in name.lower():
            parts.append('%s=%s' % (name, value))
    # curl_cffi cookie 对象形态兜底
    if not parts:
        for c in getattr(s.cookies, 'cookies', []) or []:
            name = getattr(c, 'name', '')
            value = getattr(c, 'value', '')
            if name:
                parts.append('%s=%s' % (name, value))
    if not parts:
        logger.warning('account/info 未取得 Cookie: %s %s', r.status_code, body[:120])
        return {'status': 'error', 'message': '登录后未取得 Cookie（HTTP %s），请重试' % r.status_code}
    cookie_str = '; '.join(parts)
    try:
        saved, warnings = save_pan_cookies({'quark': cookie_str})
    except Exception as e:
        return {'status': 'error', 'message': 'Cookie 保存失败：%s' % str(e)[:80]}
    logger.info('quark qrcode login ok, %d cookie fields%s',
                len(parts), ('，警告：' + '；'.join(warnings)) if warnings else '')
    return {'status': 'ok', 'message': '登录成功，Cookie 已自动保存（%d 个字段）' % len(parts),
            'cookies': saved.get('quark', ''), 'warnings': warnings}
