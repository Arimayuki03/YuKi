# -*- coding: utf-8 -*-
"""夸克 Provider：复用现有、已验证的 Quark API 快路径。"""

from __future__ import annotations

import json
from typing import Any

from .base import PanProvider
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
    def _direct_personal_url(gp, file_id: str, headers: dict[str, str]) -> str:
        """我的网盘 fid：v2/play 失败时回退 file/download。"""
        try:
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
        data = (response.json() or {}).get('data') or []
        entries = data if isinstance(data, list) else [data]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            url = entry.get('download_url') or entry.get('url') or ''
            if isinstance(url, str) and url:
                return url
        return ''

    def resolve_play_url(self, params: dict[str, Any], *, headers: dict[str, str]) -> PlayUrl | None:
        gp = __import__('go_proxy')
        share_id = str(params.get('shareId') or '')
        file_id = str(params.get('fileId') or '')
        file_token = str(params.get('fileToken') or '')
        url = str(params.get('url') or '')
        if not file_id and url:
            file_id = url
        resolved = ''
        if not share_id and 'pan.quark.cn/s/' in file_id:
            pwd = file_id.split('/s/', 1)[-1].split('?', 1)[0].strip()
            resolved = gp._quark_share_play_url(pwd, headers) or ''
        elif not share_id and file_id:
            try:
                resolved = self._direct_personal_url(gp, file_id, headers)
            except Exception:
                resolved = ''
        elif share_id and file_id:
            try:
                resolved = gp._quark_download_url(share_id, file_id, file_token, headers) or ''
            except Exception:
                resolved = ''
            if not resolved:
                resolved = gp._quark_v2play(file_id, headers) or ''
        if not resolved:
            return None
        return PlayUrl(url=resolved, headers=dict(headers), file_id=file_id, provider=self.key)
