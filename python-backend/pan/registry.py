# -*- coding: utf-8 -*-
"""Provider 注册表；未实现的网盘不会伪装成可用的空适配器。"""

from __future__ import annotations

from collections.abc import Iterable

from .base import PanProvider
from .models import PlayUrl
from .quark import QuarkProvider


class PanProviderRegistry:
    def __init__(self, providers: Iterable[PanProvider] | None = None):
        self._providers: dict[str, PanProvider] = {}
        for provider in providers or (QuarkProvider(),):
            self.register(provider)

    def register(self, provider: PanProvider) -> None:
        key = str(provider.key or '').strip().lower()
        if not key:
            raise ValueError('provider key is required')
        self._providers[key] = provider

    def get(self, key: str | None) -> PanProvider | None:
        return self._providers.get(str(key or '').strip().lower())

    def keys(self) -> list[str]:
        return sorted(self._providers)

    def resolve(self, key: str, params: dict, *, headers: dict[str, str],
                refresh: bool = False) -> PlayUrl | None:
        provider = self.get(key)
        if provider is None:
            return None
        return provider.resolve_play_url(params, headers=headers, refresh=refresh)


registry = PanProviderRegistry()
