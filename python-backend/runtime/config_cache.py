# -*- coding: utf-8 -*-
"""Small, integrity-checked disk cache for the last repository document."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from dataclasses import dataclass

CACHE_VERSION = 1
MAX_CONFIG_BYTES = 12 * 1024 * 1024


@dataclass
class CachedConfig:
    source_url: str
    text: str
    saved_at: float
    final_url: str = ''
    etag: str = ''
    last_modified: str = ''
    content_hash: str = ''
    transport: str = 'disk-cache'
    documents: dict[str, str] | None = None


class ConfigRepositoryCache:
    def __init__(self, directory):
        self.directory = os.path.abspath(str(directory)) if directory else ''
        self.path = os.path.join(self.directory, 'latest.json') if self.directory else ''

    def save(self, source_url, text, *, fetch=None, documents=None):
        if not self.path or not text:
            return False
        raw = str(text).encode('utf-8')
        if len(raw) > MAX_CONFIG_BYTES:
            return False
        payload = {
            'version': CACHE_VERSION,
            'sourceUrl': str(source_url or ''),
            'finalUrl': str(getattr(fetch, 'final_url', '') or ''),
            'etag': str(getattr(fetch, 'etag', '') or ''),
            'lastModified': str(getattr(fetch, 'last_modified', '') or ''),
            'savedAt': time.time(),
            'contentHash': hashlib.sha256(raw).hexdigest(),
            'text': str(text),
            'documents': ({str(k): str(v) for k, v in (documents or {}).items()}
                          if documents else {}),
        }
        try:
            os.makedirs(self.directory, mode=0o700, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix='.latest-', suffix='.tmp', dir=self.directory)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                    json.dump(payload, stream, ensure_ascii=False, separators=(',', ':'))
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(tmp, self.path)
            finally:
                try:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
                except OSError:
                    pass
            return True
        except (OSError, TypeError, ValueError):
            return False

    def load(self):
        if not self.path:
            return None
        try:
            with open(self.path, encoding='utf-8') as stream:
                payload = json.load(stream)
            if not isinstance(payload, dict) or payload.get('version') != CACHE_VERSION:
                return None
            text = payload.get('text')
            if not isinstance(text, str) or not text:
                return None
            raw = text.encode('utf-8')
            digest = hashlib.sha256(raw).hexdigest()
            if len(raw) > MAX_CONFIG_BYTES or digest != payload.get('contentHash'):
                return None
            return CachedConfig(
                source_url=str(payload.get('sourceUrl') or ''), text=text,
                saved_at=float(payload.get('savedAt') or 0),
                final_url=str(payload.get('finalUrl') or ''),
                etag=str(payload.get('etag') or ''),
                last_modified=str(payload.get('lastModified') or ''),
                content_hash=digest,
                documents=({str(k): str(v) for k, v in payload.get('documents', {}).items()}
                           if isinstance(payload.get('documents', {}), dict) else {}),
            )
        except (OSError, TypeError, ValueError, UnicodeError):
            return None

    def clear(self):
        try:
            if self.path:
                os.unlink(self.path)
        except OSError:
            pass
