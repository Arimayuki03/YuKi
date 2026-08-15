# -*- coding: utf-8 -*-
"""/cache 端点存储：内存 + 文件两级。

复刻原版协议：value 以原始字符串存取，spider 侧自行解析 JSON 与 expiresAt。
文件层按 key 的 sha1 命名，避免路径注入。

TTL 支持（任务十一）：set(key, value, ttl=0) 可选过期秒数，
落盘为 {'value':..., 'exp': 绝对过期时间戳}；exp=0 表示永不过期（向后兼容，
旧调用 set(key,value) 等价 ttl=0）。get 命中过期条目时返回空串并惰性删除文件。
"""
import os
import time
import json
import hashlib
import threading


class CacheStore:
    def __init__(self, dirpath):
        self.dir = dirpath
        # mem: key -> (value, exp)   exp==0 表示永不过期
        self.mem = {}
        self.lock = threading.Lock()
        os.makedirs(dirpath, exist_ok=True)

    def _path(self, key):
        name = hashlib.sha1(key.encode('utf-8')).hexdigest()
        return os.path.join(self.dir, name + '.json')

    @staticmethod
    def _expired(exp):
        return exp and time.time() >= exp

    def get(self, key):
        with self.lock:
            hit = self.mem.get(key)
        if hit is not None:
            value, exp = hit
            if self._expired(exp):
                self.delete(key)  # 惰性清理内存 + 文件
                return ''
            return value
        path = self._path(key)
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                value = data.get('value', '')
                exp = data.get('exp', 0) or 0
            except (OSError, ValueError):
                return ''
            if self._expired(exp):
                self.delete(key)  # 过期文件惰性删除
                return ''
            with self.lock:
                self.mem[key] = (value, exp)
            return value
        return ''

    def set(self, key, value, ttl=0):
        """ttl>0 时按秒计过期；ttl<=0（默认）永不过期，向后兼容旧签名。"""
        exp = (time.time() + ttl) if ttl and ttl > 0 else 0
        with self.lock:
            self.mem[key] = (value, exp)
        try:
            with open(self._path(key), 'w', encoding='utf-8') as f:
                json.dump({'value': value, 'exp': exp}, f, ensure_ascii=False)
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

    def stats(self):
        """统计文件层缓存：返回 (bytes, entries, expired)。
        expired 为已过期但尚未惰性清理的条目数（供面板 TTL 感知展示）。"""
        total = 0
        entries = 0
        expired = 0
        now = time.time()
        try:
            for fn in os.listdir(self.dir):
                if not fn.endswith('.json'):
                    continue
                path = os.path.join(self.dir, fn)
                try:
                    total += os.path.getsize(path)
                    entries += 1
                    with open(path, 'r', encoding='utf-8') as f:
                        exp = (json.load(f).get('exp', 0) or 0)
                    if exp and now >= exp:
                        expired += 1
                except (OSError, ValueError):
                    pass
        except OSError:
            pass
        return total, entries, expired
