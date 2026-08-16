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

# 文件层总量上限（C2）：超出时先淘汰已过期条目，仍超则按 mtime 淘汰最旧。
# 50MB 足够容纳 Bangumi 元数据 + spider KV 等常规用途。
MAX_TOTAL_BYTES = 50 * 1024 * 1024


class CacheStore:
    def __init__(self, dirpath):
        self.dir = dirpath
        # mem: key -> (value, exp)   exp==0 表示永不过期
        self.mem = {}
        self.lock = threading.Lock()
        # 文件层记账（C2）：name(sha1) -> [size, exp, mtime]；惰性扫描一次后增量维护，
        # stats() 不再全量读盘
        self._scanned = False
        self._files = {}
        self._key_by_name = {}
        self._total = 0
        self.max_bytes = MAX_TOTAL_BYTES   # 实例级可覆盖（测试用）
        os.makedirs(dirpath, exist_ok=True)

    def _path(self, key):
        name = hashlib.sha1(key.encode('utf-8')).hexdigest()
        return os.path.join(self.dir, name + '.json')

    @staticmethod
    def _name_of(key):
        return hashlib.sha1(key.encode('utf-8')).hexdigest() + '.json'

    def _ensure_scanned(self):
        """首次访问时扫描文件层建账（O(n) 一次，之后增量维护）。"""
        if self._scanned:
            return
        with self.lock:
            if self._scanned:
                return
            files = {}
            total = 0
            try:
                for fn in os.listdir(self.dir):
                    if not fn.endswith('.json'):
                        continue
                    path = os.path.join(self.dir, fn)
                    try:
                        size = os.path.getsize(path)
                        exp = 0
                        try:
                            with open(path, 'r', encoding='utf-8') as f:
                                exp = (json.load(f).get('exp', 0) or 0)
                        except (OSError, ValueError):
                            pass
                        files[fn] = [size, exp, os.path.getmtime(path)]
                        total += size
                    except OSError:
                        pass
            except OSError:
                pass
            self._files = files
            self._total = total
            self._scanned = True

    def _account_set(self, key, name, size, exp):
        with self.lock:
            old = self._files.get(name)
            if old:
                self._total -= old[0]
            try:
                self._files[name] = [size, exp, os.path.getmtime(os.path.join(self.dir, name))]
            except OSError:
                self._files[name] = [size, exp, time.time()]
            self._total += size
            self._key_by_name[name] = key

    def _evict_if_needed(self):
        """超过 max_bytes 时：先淘汰已过期条目，仍超则按 mtime 淘汰最旧。"""
        self._ensure_scanned()
        while self._total > self.max_bytes:
            with self.lock:
                now = time.time()
                victim = None
                for fn, meta in self._files.items():
                    if meta[1] and now >= meta[1]:
                        victim = fn
                        break
                if victim is None:
                    victim = min(self._files.items(), key=lambda kv: kv[1][2])[0] if self._files else None
                if victim is None:
                    return
                size = self._files.pop(victim)[0]
                self._total -= size
                key = self._key_by_name.pop(victim, None)
            try:
                os.remove(os.path.join(self.dir, victim))
            except OSError:
                pass
            if key is not None:
                with self.lock:
                    self.mem.pop(key, None)

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
                self._key_by_name[self._name_of(key)] = key
            return value
        return ''

    def set(self, key, value, ttl=0):
        """ttl>0 时按秒计过期；ttl<=0（默认）永不过期，向后兼容旧签名。"""
        exp = (time.time() + ttl) if ttl and ttl > 0 else 0
        with self.lock:
            self.mem[key] = (value, exp)
        # 原子写（M-28）：先写同目录临时文件再 os.replace，避免进程中断
        # 留下半截 JSON；失败时清理临时文件
        path = self._path(key)
        # 临时文件名带 pid + 线程 id：同 key 并发写入时各自独立，避免互相抢句柄
        tmp = '%s.tmp%d-%d' % (path, os.getpid(), threading.get_ident())
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump({'value': value, 'exp': exp}, f, ensure_ascii=False)
            for i in range(4):
                try:
                    os.replace(tmp, path)
                    break
                except PermissionError:
                    # Windows：目标被并发读/替换时短暂拒绝，重试
                    if i == 3:
                        raise
                    time.sleep(0.05)
            self._account_set(key, os.path.basename(path),
                              os.path.getsize(path), exp)
            self._evict_if_needed()
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass

    def delete(self, key):
        with self.lock:
            self.mem.pop(key, None)
        path = self._path(key)
        name = os.path.basename(path)
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
        self._ensure_scanned()
        with self.lock:
            meta = self._files.pop(name, None)
            if meta:
                self._total -= meta[0]
            self._key_by_name.pop(name, None)

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
        with self.lock:
            self._files.clear()
            self._key_by_name.clear()
            self._total = 0
            self._scanned = True
        return removed

    def stats(self):
        """统计文件层缓存：返回 (bytes, entries, expired)。

        C2 起基于记账数据（惰性扫描一次后增量维护），不再全量读盘。
        expired 为已过期但尚未惰性清理的条目数（供面板 TTL 感知展示）。"""
        self._ensure_scanned()
        now = time.time()
        with self.lock:
            total = self._total
            entries = len(self._files)
            expired = sum(1 for meta in self._files.values()
                          if meta[1] and now >= meta[1])
        return total, entries, expired
