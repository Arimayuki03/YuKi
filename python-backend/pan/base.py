# -*- coding: utf-8 -*-
"""网盘 Provider 最小宿主契约。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from .models import PlayUrl, ShareInfo


class PanProvider(ABC):
    key = ''
    name = ''

    def validate_cookie(self, cookie: str) -> list[str]:
        return [] if str(cookie or '').strip() else ['cookie missing']

    @abstractmethod
    def resolve_play_url(self, params: dict[str, Any], *, headers: dict[str, str]) -> PlayUrl | None:
        """把统一 ``do=pan`` 参数解析为短期播放 URL。"""

    def resolve_share(self, url: str, *, headers: dict[str, str]) -> ShareInfo | None:
        return None

    def list_files(self, request: Any) -> Any:
        raise NotImplementedError(f'{self.key} provider does not implement browsing')

    def refresh_play_url(self, play: PlayUrl, *, headers: dict[str, str]) -> PlayUrl | None:
        return self.resolve_play_url({'fileId': play.file_id}, headers=headers)

