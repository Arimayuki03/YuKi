# -*- coding: utf-8 -*-
"""/cache 端点存储：内存 + 文件两级。

复刻原版协议：value 以原始字符串存取，spider 侧自行解析 JSON 与 expiresAt。
文件层按 key 的 sha1 命名，避免路径注入。
"""
import os
import json
import hashlib
import threading


class CacheStore:
    def __init__(self, dirpath):
        self.dir = dirpath
        self.mem = {}
        self.lock = threading.Lock()
        os.makedirs(dirpath, exist_ok=True)

    def _path(self, key):
        name = hashlib.sha1(key.encode('utf-8')).hexdigest()
        return os.path.join(self.dir, name + '.json')

    def get(self, key):
        with self.lock:
            if key in self.mem:
                return self.mem[key]
        path = self._path(key)
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    value = json.load(f).get('value', '')
                with self.lock:
                    self.mem[key] = value
                return value
            except (OSError, ValueError):
                return ''
        return ''

    def set(self, key, value):
        with self.lock:
            self.mem[key] = value
        try:
            with open(self._path(key), 'w', encoding='utf-8') as f:
                json.dump({'value': value}, f, ensure_ascii=False)
        except OSError:
            pass

    def delete(self, key):
        with self.lock:
            self.mem.pop(key, None)
        path = self._path(key)
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass

    def clear(self):
        """清空内存与文件层全部缓存，返回删除的文件数。"""
        with self.lock:
            self.mem.clear()
        removed = 0
        try:
            for fn in os.listdir(self.dir):
                if fn.endswith('.json'):
                    try:
                        os.remove(os.path.join(self.dir, fn))
                        removed += 1
                    except OSError:
                        pass
        except OSError:
            pass
        return removed
