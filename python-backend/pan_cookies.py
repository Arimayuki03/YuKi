# -*- coding: utf-8 -*-
"""网盘 Cookie 配置存储（夸克/UC/天翼/百度/P123/迅雷）。

供 JAR（TVBox）网盘源使用：用户在设置页粘贴网盘 Cookie 后，
JarSpider 在每次调用 JVM 桥时附带该配置，SpiderRunner 注入蜘蛛。

存储：<data_dir>/pan_cookies.json（Windows DPAPI 密文；非 Windows 使用
AES-GCM 本地密钥）；带 mtime 缓存避免每次调用都读盘。
"""
import json
import os
import base64
import ctypes
import logging
import secrets
import threading
import time

import hoststate

logger = logging.getLogger('yuki.pan-cookies')

PAN_COOKIE_KEYS = ('quark', 'uc', 'tianyi', 'baidu', 'p123', 'xunlei')
_PROVIDER_NAMES = {
    'quark': '夸克网盘',
    'uc': 'UC 网盘',
    'tianyi': '天翼云盘',
    'baidu': '百度网盘',
    'p123': '123 云盘',
    'xunlei': '迅雷云盘',
}

_cache = {'path': '', 'mtime': 0.0, 'data': {}}
# 保存串行化：避免并发 os.replace 同一目标在 Windows 上互抛建议锁
_SAVE_LOCK = threading.Lock()
_CACHE_LOCK = threading.RLock()


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ('cbData', ctypes.c_uint32),
        ('pbData', ctypes.POINTER(ctypes.c_ubyte)),
    ]


def _dpapi_transform(raw: bytes, *, decrypt: bool) -> bytes:
    """调用 Windows DPAPI；明文只存在于调用栈和 DPAPI 返回缓冲区。"""

    if os.name != 'nt':
        raise RuntimeError('Windows DPAPI is unavailable')
    crypt32 = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    fn = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    fn.argtypes = [
        ctypes.POINTER(_DataBlob), ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
        ctypes.POINTER(_DataBlob),
    ]
    fn.restype = ctypes.c_int
    source_buf = ctypes.create_string_buffer(raw)
    source = _DataBlob(
        len(raw), ctypes.cast(source_buf, ctypes.POINTER(ctypes.c_ubyte)))
    result = _DataBlob()
    # CRYPTPROTECT_UI_FORBIDDEN = 0x1; no UI can be shown by a background host.
    if not fn(ctypes.byref(source), None, None, None, None, 1,
              ctypes.byref(result)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        kernel32.LocalFree(result.pbData)


def _fallback_key_path():
    return os.path.join(hoststate.get_data_dir(), 'pan_cookies.key')


def _fallback_key():
    """非 Windows 的本地密钥兜底（Linux/macOS 无 DPAPI）。"""

    path = _fallback_key_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(path, 'rb') as f:
            key = f.read()
        if len(key) == 32:
            return key
    except OSError:
        pass
    key = secrets.token_bytes(32)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        fd = os.open(path, flags, 0o600)
        try:
            os.write(fd, key)
        finally:
            os.close(fd)
    except FileExistsError:
        with open(path, 'rb') as f:
            key = f.read()
    if len(key) != 32:
        raise RuntimeError('invalid local Cookie encryption key')
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key


def _encrypt(raw: bytes) -> tuple[str, str]:
    if os.name == 'nt':
        return 'dpapi', base64.b64encode(_dpapi_transform(raw, decrypt=False)).decode('ascii')
    try:
        from Crypto.Cipher import AES
    except ImportError as exc:
        raise RuntimeError('Cookie encryption requires Windows DPAPI or pycryptodome') from exc
    nonce = secrets.token_bytes(12)
    cipher = AES.new(_fallback_key(), AES.MODE_GCM, nonce=nonce)
    encrypted, tag = cipher.encrypt_and_digest(raw)
    return 'aes-gcm', base64.b64encode(nonce + tag + encrypted).decode('ascii')


def _decrypt(cipher_name: str, encoded: str) -> bytes:
    payload = base64.b64decode(str(encoded or ''), validate=True)
    if cipher_name == 'dpapi':
        return _dpapi_transform(payload, decrypt=True)
    if cipher_name == 'aes-gcm':
        from Crypto.Cipher import AES
        if len(payload) < 28:
            raise ValueError('encrypted Cookie payload is truncated')
        nonce, tag, encrypted = payload[:12], payload[12:28], payload[28:]
        cipher = AES.new(_fallback_key(), AES.MODE_GCM, nonce=nonce)
        return cipher.decrypt_and_verify(encrypted, tag)
    raise ValueError('unsupported Cookie encryption cipher')


def _secure_document(cleaned):
    raw = json.dumps(cleaned, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    cipher, encoded = _encrypt(raw)
    return {'version': 1, 'encrypted': True, 'cipher': cipher, 'data': encoded}


def _write_secure(path, cleaned):
    document = _secure_document(cleaned)
    tmp = '%s.tmp%d-%d' % (path, os.getpid(), threading.get_ident())
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(document, f, ensure_ascii=False, indent=2)
        _os_replace_retry(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _os_replace_retry(src, dst, attempts=4):
    """Windows 下目标被并发读/替换时 os.replace 可能短暂 Access Denied，重试。"""
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.05)


def _path():
    return os.path.join(hoststate.get_data_dir(), 'pan_cookies.json')


def load_pan_cookies():
    """读取全部网盘 Cookie 配置（{key: cookie}）。带 mtime 缓存。"""
    p = _path()
    try:
        mtime = os.path.getmtime(p)
    except OSError:
        mtime = 0.0
    migrate = False
    with _CACHE_LOCK:
        if p == _cache['path'] and mtime == _cache['mtime'] and _cache['data'] is not None:
            return dict(_cache['data'])
        data = {}
        legacy = False
        try:
            with open(p, encoding='utf-8') as f:
                document = json.load(f)
            if isinstance(document, dict) and document.get('encrypted'):
                raw = json.loads(_decrypt(document.get('cipher', ''), document.get('data', '')).decode('utf-8'))
            else:
                # 兼容旧版本明文文件；成功读到后尽快迁移为加密格式。
                raw = document
                legacy = isinstance(raw, dict)
            if isinstance(raw, dict):
                data = {k: str(v).strip() for k, v in raw.items()
                        if k in PAN_COOKIE_KEYS and str(v).strip()}
        except (OSError, ValueError, TypeError, UnicodeError) as exc:
            if os.path.exists(p):
                logger.warning('网盘 Cookie 读取失败（内容不会输出）：%s', exc)
            data = {}
        _cache['path'] = p
        _cache['mtime'] = mtime
        _cache['data'] = data
        migrate = legacy
        result = dict(data)
    # 不在 CACHE_LOCK 内等待 SAVE_LOCK，避免读取旧明文和并发保存形成锁反转。
    if migrate:
        try:
            with _SAVE_LOCK:
                _write_secure(p, result)
            with _CACHE_LOCK:
                _cache['mtime'] = os.path.getmtime(p)
        except Exception as exc:
            logger.warning('网盘 Cookie 加密迁移失败：%s', exc)
    return result


# 各网盘要求的关键 Cookie 字段（jar 蜘蛛硬性校验，缺失则该网盘无法播放）
_REQUIRED_FIELDS = {
    'quark': '__pus',
    'uc': '__pus',
    'baidu': 'BDUSS',
    'tianyi': '',   # 天翼云盘蜘蛛未校验特定字段
    'p123': '',
    'xunlei': '',
}


def validate_pan_cookie(key, value):
    """校验单个网盘 Cookie 是否可被蜘蛛使用，返回问题列表（空=无问题）。"""
    issues = []
    v = str(value or '').strip()
    if not v:
        return issues
    # Cookie 必须形如 k=v; k2=v2
    if '=' not in v:
        issues.append(f'{_PROVIDER_NAMES.get(key, key)} Cookie 不是标准格式：应为「字段=值; 字段2=值2; …」（例如 __puus=xxx; __pus=xxx）')
        return issues
    if v.lower().lstrip().startswith('cookie'):
        issues.append('请只粘贴 Cookie 内容本身，不要带「Cookie: 」前缀')
    req = _REQUIRED_FIELDS.get(key, '')
    if req and req not in v:
        issues.append(f'{_PROVIDER_NAMES.get(key, key)} Cookie 缺少关键字段「{req}」，蜘蛛将无法使用该 Cookie（可能不完整或已过期）')
    return issues


def save_pan_cookies(cookies):
    """保存网盘 Cookie 配置；返回实际保存的 dict。非法键/空值丢弃。
    同时返回校验问题列表（不阻止保存，仅提示）。"""
    cleaned = {k: str(v).strip() for k, v in (cookies or {}).items()
               if k in PAN_COOKIE_KEYS and str(v).strip()}
    warnings = []
    for k, v in cleaned.items():
        warnings.extend(validate_pan_cookie(k, v))
    p = _path()
    try:
        with _SAVE_LOCK:
            # 原子替换（M-28）：避免写一半时被并发读取到残缺 JSON；Cookie
            # 文件本身只保存 DPAPI/AES-GCM 密文。
            _write_secure(p, cleaned)
        with _CACHE_LOCK:
            _cache['path'] = p
            _cache['mtime'] = os.path.getmtime(p)
            _cache['data'] = cleaned
    except OSError as e:
        raise RuntimeError(f'网盘 Cookie 保存失败: {e}')
    except Exception as e:
        raise RuntimeError(f'网盘 Cookie 加密保存失败: {e}') from e
    try:
        from pan.cache import clear_signed_url_cache
        clear_signed_url_cache()
    except Exception:
        pass
    return cleaned, warnings
