# -*- coding: utf-8 -*-
"""夸克 Provider：复用现有、已验证的 Quark API 快路径。"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlsplit

from .base import PanProvider
from .cache import make_cache_key, signed_url_cache
from .models import PlayUrl


class QuarkProvider(PanProvider):
    key = 'quark'
    name = '夸克网盘'

    def validate_cookie(self, cookie: str) -> list[str]:
        value = str(cookie or '').strip()
        if not value:
            return ['缺少夸克 Cookie']
        if '__pus' not in value and '__puus' not in value and 'cookie' not in value.lower():
            return ['Cookie 未包含常见夸克登录字段，可能已过期']
        return []

    @staticmethod
    def _direct_personal_url(gp, file_id: str, headers: dict[str, str],
                             quality: str = '') -> str:
        """我的网盘 fid：v2/play 失败时回退 file/download。"""
        resolver = getattr(gp, '_quark_personal_play_url', None)
        if callable(resolver):
            try:
                try:
                    resolved = resolver(file_id, headers, retries=1,
                                        quality=quality)
                except TypeError:
                    # 兼容旧版桥接函数/第三方测试实现。
                    resolved = resolver(file_id, headers, retries=1)
                if resolved:
                    return resolved
            except Exception:
                pass
        try:
            try:
                url = gp._quark_v2play(file_id, headers, quality)
            except TypeError:
                url = gp._quark_v2play(file_id, headers)
        except Exception:
            # ``v2/play`` 对权限、文件类型和接口版本错误有时直接抛异常，
            # 不能让异常阻断个人文件的 download API 回退。
            url = ''
        if url:
            return url
        response = gp._qpost(
            'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str=',
            headers={**headers, 'Content-Type': 'application/json'},
            data=json.dumps({'fids': [file_id]}), timeout=25, verify=True,
            allow_redirects=False,
        )
        location = response.headers.get('Location', '') if getattr(response, 'headers', None) else ''
        if isinstance(location, str) and location.startswith(('http://', 'https://')):
            return location
        data = (response.json() or {}).get('data') or []
        entries = data if isinstance(data, list) else [data]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            url = entry.get('download_url') or entry.get('url') or ''
            if isinstance(url, str) and url:
                return url
        return ''

    @staticmethod
    def _quality_key(value: str) -> str:
        text = str(value or '').strip().lower().split('#', 1)[0].strip()
        return {
            'quark普画': 'normal', '普画': 'normal', '普清': 'normal',
            'normal': 'normal', 'low': 'low', '标清': 'low',
            'high': 'high', '高清': 'high', 'super': 'super',
            'original': 'original', 'origin': 'original', '原画': 'original',
            '至臻': 'original', '夸克原画': 'original', 'quark原画': 'original',
            'quark原画11': 'original',
            '2k': '2k', '4k': '4k',
        }.get(text, text)

    @classmethod
    def _select_quality(cls, quality: str, candidates: list[tuple[str, str]]) -> str:
        if not candidates:
            return ''
        wanted = cls._quality_key(quality)
        if wanted:
            for label, url in candidates:
                if cls._quality_key(label) == wanted:
                    return url
            for label, url in candidates:
                label_key = cls._quality_key(label)
                if wanted in label_key or label_key in wanted:
                    return url
        return candidates[0][1]

    @staticmethod
    def _share_file_url(gp, pwd_id: str, file_id: str, file_token: str,
                        headers: dict[str, str], quality: str = '',
                        share_id: str = '') -> str:
        """公开分享中指定文件的取流（需要 pwd_id 建立分享会话）。"""
        resolver = getattr(gp, '_quark_share_file_play_url', None)
        if not callable(resolver):
            return ''
        try:
            return resolver(pwd_id, file_id, file_token, headers,
                            quality=quality, share_id=share_id) or ''
        except TypeError:
            # 兼容旧版桥接函数/第三方测试实现（无 quality/share_id 参数）。
            try:
                return resolver(pwd_id, file_id, file_token, headers) or ''
            except Exception:
                return ''
        except Exception:
            return ''

    def _resolve_uncached(self, params: dict[str, Any], *, headers: dict[str, str]) -> PlayUrl | None:
        gp = __import__('go_proxy')
        share_id = str(params.get('shareId') or '')
        file_id = str(params.get('fileId') or '')
        file_token = str(params.get('fileToken') or '')
        pwd_id = str(params.get('pwdId') or params.get('pwd_id') or '')
        share_url = str(params.get('shareUrl') or params.get('share_url') or '')
        quality = str(params.get('quality') or params.get('resolution') or '')
        url = str(params.get('url') or share_url or '')
        if not pwd_id:
            for candidate in (share_url, url):
                try:
                    parts = urlsplit(candidate)
                    path = parts.path or ''
                    marker = '/s/'
                    if marker in path.lower():
                        suffix = path[path.lower().find(marker) + len(marker):]
                        if suffix:
                            pwd_id = suffix.strip('/')
                            break
                except (TypeError, ValueError):
                    pass
        if not file_id and url:
            file_id = url
        resolved = ''
        if pwd_id and file_id and 'pan.quark.cn/s/' not in file_id:
            # 分享内指定文件：share_fid_token 只在 sharepage/token 建立的会话里
            # 有效，所以这条必须排在下面的无会话尝试之前——否则
            # file/download?scene=share 回 400 code=14001「非法token」、v2/play
            # 回 404 code=21001，整条链路只会以 502 结束。
            resolved = self._share_file_url(gp, pwd_id, file_id, file_token,
                                            headers, quality, share_id)
        if resolved:
            pass
        elif not share_id and pwd_id:
            try:
                resolved = gp._quark_share_play_url(pwd_id, headers, quality) or ''
            except TypeError:
                resolved = gp._quark_share_play_url(pwd_id, headers) or ''
        elif not share_id and 'pan.quark.cn/s/' in file_id:
            pwd = file_id.split('/s/', 1)[-1].split('?', 1)[0].split('#', 1)[0].strip()
            try:
                resolved = gp._quark_share_play_url(pwd, headers, quality) or ''
            except TypeError:
                resolved = gp._quark_share_play_url(pwd, headers) or ''
        elif not share_id and file_id:
            try:
                resolved = self._direct_personal_url(gp, file_id, headers,
                                                     quality=quality)
            except Exception:
                resolved = ''
        elif share_id and file_id:
            try:
                resolved = gp._quark_download_url(share_id, file_id, file_token, headers) or ''
            except Exception:
                resolved = ''
            if not resolved:
                try:
                    resolved = gp._quark_v2play(file_id, headers, quality) or ''
                except TypeError:
                    # 保持与旧版测试/桥接函数的二参数兼容。
                    resolved = gp._quark_v2play(file_id, headers) or ''
            # 不再回退到 share_play_url 的首集：多集分享下这会把“点了第 N 集”
            # 播成“第 1 集”（串集）。单文件分享的兜底已由上面的
            # pwd_id+file_id → _share_file_url 覆盖；此处失败后交由最后的
            # 个人网盘回退（已转存）处理，仍失败则返回 None 而非错集。
        # 已转存到我的网盘的资源：分享 fid 的 share/download、v2/play 可能因
        # 权限/版本返回 400(14001)/404(21001)，但同一 fileId 在个人网盘侧
        # 的 v2/play + file/download 仍可出直链。必须在所有分享链路都失败后
        # 再试一次个人网盘回退，否则“已转存但不能播”。
        if not resolved and file_id and 'pan.quark.cn/s/' not in file_id:
            try:
                resolved = self._direct_personal_url(gp, file_id, headers,
                                                     quality=quality) or ''
            except Exception:
                resolved = ''
        if not resolved:
            return None
        quality = str(params.get('quality') or params.get('resolution') or '')
        quality_key = self._quality_key(quality)
        original_quality = quality_key == 'original'
        return PlayUrl(url=resolved, headers=dict(headers), file_id=file_id,
                       provider=self.key, request=dict(params), quality=quality,
                       original=original_quality,
                       transcoded=bool(quality and not original_quality),
                       one_time=True)

    def resolve_play_url(self, params: dict[str, Any], *, headers: dict[str, str],
                         refresh: bool = False) -> PlayUrl | None:
        request = dict(params or {})
        key = make_cache_key(self.key, request, headers)
        return signed_url_cache.resolve(
            key,
            lambda: self._resolve_uncached(request, headers=headers),
            refresh=refresh,
        )
