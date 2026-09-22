# -*- coding: utf-8 -*-
"""夸克 Provider：复用现有、已验证的 Quark API 快路径。"""

from __future__ import annotations

import inspect
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
            kwargs = {'retries': 1}
            # 按 inspect.signature 判参（同 _share_file_url），
            # 避免 except TypeError 把桥内自身 TypeError 误判成旧签名。
            if QuarkProvider._accepts_kw(resolver, 'quality'):
                kwargs['quality'] = quality
            try:
                resolved = resolver(file_id, headers, **kwargs)
                if resolved:
                    return resolved
            except Exception:
                pass
        resolver = getattr(gp, '_quark_v2play', None)
        try:
            if callable(resolver) and QuarkProvider._accepts_kw(resolver, 'quality'):
                url = resolver(file_id, headers, quality=quality)
            else:
                url = resolver(file_id, headers)
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

    @classmethod
    def _call_bridged(cls, resolver, *args, quality: str = '') -> str:
        """按签名判定后调用桥接函数；resolver 缺失/失败返回空串。

        用 inspect.signature 判定是否支持 quality 关键字（替代 except TypeError
        降参重试）：桥内代码自身的 TypeError 不再被误判成“旧签名”，避免
        同一请求重复打上游并掩盖真实错误。"""
        if not callable(resolver):
            return ''
        try:
            if cls._accepts_kw(resolver, 'quality'):
                return resolver(*args, quality=quality) or ''
            return resolver(*args) or ''
        except Exception:
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
    def _accepts_kw(func, name: str) -> bool:
        """函数签名是否接受关键字参数 name（**kwargs 也算接受）。"""
        try:
            sig = inspect.signature(func)
        except (TypeError, ValueError):
            # 拿不到签名（C 扩展等）时保守假设支持 quality：随后带 quality 的调用
            # 若真不支持会抛 TypeError，由各调用方的 except Exception 吞掉并走
            # 降级链路（代价是丢一次直链机会，不会误判成旧签名重试）。
            return True
        param = sig.parameters.get(name)
        if param is not None:
            return param.kind in (param.POSITIONAL_OR_KEYWORD,
                                  param.KEYWORD_ONLY)
        return any(p.kind == p.VAR_KEYWORD for p in sig.parameters.values())

    @staticmethod
    def _share_file_url(gp, pwd_id: str, file_id: str, file_token: str,
                        headers: dict[str, str], quality: str = '',
                        share_id: str = '') -> str:
        """公开分享中指定文件的取流（需要 pwd_id 建立分享会话）。"""
        resolver = getattr(gp, '_quark_share_file_play_url', None)
        if not callable(resolver):
            return ''
        kwargs = {}
        # 按 inspect.signature 判参，不用 except TypeError：桥内代码自身的
        # TypeError（解析/序列化 bug）会被误判成“旧签名”而带降参重试，
        # 既重复打上游又掩盖真实错误。
        if QuarkProvider._accepts_kw(resolver, 'quality'):
            kwargs['quality'] = quality
        if QuarkProvider._accepts_kw(resolver, 'share_id'):
            kwargs['share_id'] = share_id
        try:
            return resolver(pwd_id, file_id, file_token, headers, **kwargs) or ''
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
        # “分享首集”分支（_quark_share_play_url 只取分享里第一个视频）只在
        # 没有具体 fid 时才允许进入：否则 _share_file_url 失败后落回首集，
        # 多集分享“点第 N 集播第 1 集”（串集）。
        pinned_fid = bool(file_id) and 'pan.quark.cn/s/' not in file_id
        if pwd_id and pinned_fid:
            # 分享内指定文件：share_fid_token 只在 sharepage/token 建立的会话里
            # 有效，所以这条必须排在下面的无会话尝试之前——否则
            # file/download?scene=share 回 400 code=14001「非法token」、v2/play
            # 回 404 code=21001，整条链路只会以 502 结束。
            resolved = self._share_file_url(gp, pwd_id, file_id, file_token,
                                            headers, quality, share_id)
        if resolved:
            pass
        elif not share_id and pwd_id and not pinned_fid:
            resolved = self._call_bridged(
                gp._quark_share_play_url, pwd_id, headers, quality=quality)
        elif not share_id and 'pan.quark.cn/s/' in file_id:
            pwd = file_id.split('/s/', 1)[-1].split('?', 1)[0].split('#', 1)[0].strip()
            resolved = self._call_bridged(
                gp._quark_share_play_url, pwd, headers, quality=quality)
        elif not share_id and pinned_fid:
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
                # v2/play 降级同样按签名判参，不用 except TypeError。
                resolver = getattr(gp, '_quark_v2play', None)
                try:
                    if callable(resolver) and QuarkProvider._accepts_kw(resolver, 'quality'):
                        resolved = resolver(file_id, headers, quality=quality) or ''
                    else:
                        resolved = resolver(file_id, headers) or ''
                except Exception:
                    resolved = ''
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
