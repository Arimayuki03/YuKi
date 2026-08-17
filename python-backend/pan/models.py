# -*- coding: utf-8 -*-
"""Provider 层使用的稳定数据模型。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class PanFile:
    id: str
    name: str = ''
    parent_id: str = ''
    is_dir: bool = False
    size: int = 0
    mime: str = ''
    updated_at: str = ''
    playable: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class ShareInfo:
    provider: str
    share_id: str
    title: str = ''
    files: list[PanFile] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class PlayUrl:
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    expire_at: float = 0.0
    file_id: str = ''
    provider: str = ''
    request: dict[str, Any] = field(default_factory=dict)
