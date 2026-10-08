# -*- coding: utf-8 -*-
"""封面图片磁盘缓存（B-08，优化.md 批次 B-2 方案 B）。

问题：/kazumi/cover 代理 URL 含随机端口 + token（server.py 每次启动
pick_free_port() + secrets.token_hex(16)），Chromium 以完整 URL 为 HTTP
缓存键 → 跨重启一次都不命中，端点的七天缓存头结构性落空；每次冷启动
所有封面重新回源图床（lain.bgm.tv 被墙/慢场景下首屏极慢）。

方案 B（优化.md 推荐，渲染层零改动）：后端按「归一化封面 URL 的 sha1」
落盘字节，缓存键与端口/token 解耦，重启后依旧命中。方案 A（主进程
yuki-img:// 自定义协议）需动 preload/协议层，改动面大，不选。

存储设计（手法对齐 cache_store.py：记账 + 惰性扫描 + tmp 原子写 +
过期先淘 + mtime 兜底淘汰；值是二进制图片字节，不适用 CacheStore 的
JSON 字符串封装，故独立实现）：
- 目录 ``<cache>/covers/``，文件名 = sha1(url) + '.bin'，单文件自描述：
  首行头部 ``exp|ctype\\n``（绝对过期时刻 + content-type），其后为原始字节。
- TTL 7 天（对齐端点 Cache-Control 的 max-age）：get 读头部过期判定，
  惰性删除；不做主动重验（优化.md 简化口径，7 天兜底）。
- 配额 200MB：超出先淘汰已过期条目，仍超按 mtime 淘汰最旧；命中时
  utime 触摸 mtime（LRU 语义）——过期判定取自头部、LRU 只动 mtime，
  两者解耦，热条目不会被触摸续期成永不超期。
- 原子写：tmp（带 pid+tid）+ os.replace，Windows PermissionError 重试
  （同 cache_store.set）；进程级 init 清一次 *.tmp* 崩溃残留。
- 路径白名单（L2）：缓存键先过字符集/长度白名单（sha1 hex 均兼容），
  拼路径后再 realpath 前缀复核，杜绝 ../、盘符等把文件写到缓存目录外。
- 记账锁纪律（L3）：记账与文件操作同锁完成（put 换文件+入账、淘汰销账
  +删除、clear 删除+清账），消除并发 get/put/clear 的容量计数漂移。
- 缓存中毒面（口径沿用 _bangumi_body_ok 的「只缓存成功且非空」）：put
  只收非空且 ≤8MB 的字节；端点 _fetch 已保证 200 + image/* + 大小上限
  才调 put，404/超时/HTML 错误页不留任何文件。
"""
import os
import re
import time
import hashlib
import logging
import threading

logger = logging.getLogger('yuki.cover-cache')

# TTL（秒）：7 天，与 /kazumi/cover 响应的 max-age=604800 对齐
TTL_SECONDS = 7 * 24 * 60 * 60
# 目录总量上限：封面约 20~200KB/张，200MB ≈ 数千张，覆盖重图标+历史记录页规模
MAX_TOTAL_BYTES = 200 * 1024 * 1024
# 单条上限：对齐 /kazumi/cover 的 8MB 拒收阈值（_fetch 已拦，put 再拦一道）
MAX_ENTRY_BYTES = 8 * 1024 * 1024

# 头部行 content-type 段的白名单字符：畸形 ctype 不得破坏 ``exp|ctype\n``
# 行结构（ctype 由远端 Content-Type 而来，存侧消毒一次）。
_CTYPE_OK = frozenset(
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/+-.;= ')

# 路径白名单（L2）：缓存键直接拼进文件路径，必须先验合法性再落盘。
# 现有正常键 = sha1 hex（40 位小写十六进制），白名单全兼容；显式拒绝
# 含路径分隔符 / 盘符 / 空白等不安全字符的键（恶意/异常输入不缓存）。
_KEY_OK_RE = re.compile(r'^[A-Za-z0-9._:-]{1,128}$')


class CoverStore:
    """二进制 KV 磁盘仓：sha1 键 → (字节, ctype)，记账 + 惰性扫描 + 配额淘汰。"""

    def __init__(self, dirpath, max_bytes=MAX_TOTAL_BYTES, ttl=TTL_SECONDS):
        self.dir = dirpath
        self.ttl = ttl
        self.max_bytes = max_bytes
        self.lock = threading.Lock()
        # 记账（C2 手法）：name -> [size, exp, mtime]；惰性扫描一次后增量维护
        self._scanned = False
        self._files = {}
        self._total = 0
        os.makedirs(dirpath, exist_ok=True)
        self._cleanup_tmp_files()

    # ---------------------------------------------------------------- 基础

    def _cleanup_tmp_files(self):
        """删除目录内崩溃残留的临时文件（*.tmp<pid>-<tid> 形态）。"""
        try:
            for fn in os.listdir(self.dir):
                if '.tmp' in fn:
                    try:
                        os.remove(os.path.join(self.dir, fn))
                    except OSError:
                        pass
        except OSError:
            pass

    def _path(self, key):
        return os.path.join(self.dir, key + '.bin')

    @staticmethod
    def _key_allowed(key):
        """L2 白名单第一道：字符集/长度校验（正常 sha1 hex 键全兼容）。"""
        return bool(key) and _KEY_OK_RE.match(key) is not None

    def _check_path_in_root(self, key):
        """L2 白名单第二道：realpath 前缀复核（防符号链接/目录变更逃逸）。
        不在缓存根内抛 ValueError（调用方按拒绝缓存处理）。"""
        root = os.path.realpath(self.dir)
        real = os.path.realpath(self._path(key))
        if os.path.commonpath([root, real]) != root:
            raise ValueError('cover cache key escapes cache dir: %r' % (key,))

    def _checked_path(self, key):
        """两道白名单都过后返回落盘路径；不合规记 debug 日志并返回 None。"""
        if not self._key_allowed(key):
            logger.debug('cover_cache: reject illegal key %r', key)
            return None
        try:
            self._check_path_in_root(key)
        except ValueError as exc:
            logger.debug('cover_cache: %s', exc)
            return None
        return self._path(key)

    @staticmethod
    def _read_exp(path):
        """读文件头部行的 exp；损坏返回 1.0（视作已过期 → 惰性删除）。"""
        try:
            with open(path, 'rb') as f:
                head = f.readline(256)
            return float(head.partition(b'|')[0])
        except (OSError, ValueError):
            return 1.0

    def _ensure_scanned(self):
        """首次访问时扫描文件层建账（读每个 .bin 的头部行取 exp，O(n) 一次）。"""
        if self._scanned:
            return
        with self.lock:
            if self._scanned:
                return
            files = {}
            total = 0
            try:
                for fn in os.listdir(self.dir):
                    if not fn.endswith('.bin'):
                        continue
                    path = os.path.join(self.dir, fn)
                    try:
                        size = os.path.getsize(path)
                        exp = self._read_exp(path)
                        files[fn] = [size, exp, os.path.getmtime(path)]
                        total += size
                    except OSError:
                        pass
            except OSError:
                pass
            self._files = files
            self._total = total
            self._scanned = True

    def _remove_entry(self, name):
        """按记账名删除文件并修正账目（惰性过期/损坏清理共用）。

        L3 锁纪律：销账与文件删除同锁完成，避免并发 put/clear 把刚入账的
        字节数误销或已删文件重复入账。os.remove 快，不构成锁瓶颈。"""
        with self.lock:
            meta = self._files.pop(name, None)
            if meta:
                self._total -= meta[0]
            try:
                os.remove(os.path.join(self.dir, name))
            except OSError:
                pass

    def _evict_if_needed(self):
        """超过 max_bytes 时：先淘汰已过期条目，仍超则按 mtime 淘汰最旧（LRU 序）。"""
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
                    victim = min(self._files.items(),
                                 key=lambda kv: kv[1][2])[0] if self._files else None
                if victim is None:
                    return
                size = self._files.pop(victim)[0]
                self._total -= size
            try:
                os.remove(os.path.join(self.dir, victim))
            except OSError:
                pass

    # ---------------------------------------------------------------- 读写

    def get(self, key):
        """命中返回 (字节, content-type)；缺失/过期/损坏返回 None。

        L2 白名单：键不合法（../、盘符、超长等）直接拒绝返回 None。
        文件读在锁外：os.replace 原子性保证读到的不是半截文件；读到后被
        并发淘汰也无碍（字节本身仍是合法图片）。记账在而文件不在（外部
        删除）时自愈修正账目。"""
        path = self._checked_path(key)
        if path is None:
            return None
        self._ensure_scanned()
        name = key + '.bin'
        try:
            with open(path, 'rb') as f:
                data = f.read()
        except OSError:
            with self.lock:
                meta = self._files.pop(name, None)
                if meta:
                    self._total -= meta[0]
            return None
        head, sep, payload = data.partition(b'\n')
        if not sep or not payload:
            self._remove_entry(name)  # 半截/空文件：惰性删除
            return None
        try:
            exp_s, _, ctype_raw = head.partition(b'|')
            exp = float(exp_s)
            ctype = ctype_raw.decode('ascii') or 'image/jpeg'
        except (ValueError, UnicodeDecodeError):
            self._remove_entry(name)
            return None
        if exp and time.time() >= exp:
            self._remove_entry(name)  # TTL 过期：惰性删除（7 天兜底，无主动重验）
            return None
        # LRU 触摸：mtime 只服务淘汰序，过期判定取自头部（互不干扰）
        now = time.time()
        try:
            os.utime(path, (now, now))
        except OSError:
            pass
        with self.lock:
            meta = self._files.get(name)
            if meta:
                meta[2] = now
        if not ctype.startswith('image/'):
            ctype = 'image/jpeg'  # 存侧已消毒，这里再兜底
        return payload, ctype

    def put(self, key, body, ctype=''):
        """写入一条（原子写 + 记账 + 配额淘汰）。失败静默，返回是否落盘。"""
        # 中毒面护栏：空体/超单条上限一律不收（成功响应才应走到这里）
        if not key or not body or len(body) > MAX_ENTRY_BYTES:
            return False
        path = self._checked_path(key)
        if path is None:  # L2：白名单外键拒绝缓存
            return False
        ctype = ''.join(c for c in str(ctype or 'image/jpeg') if c in _CTYPE_OK).strip()
        if not ctype.startswith('image/'):
            ctype = 'image/jpeg'
        exp = time.time() + self.ttl
        name = key + '.bin'
        # 临时文件名带 pid + 线程 id：同 key 并发写入各自独立（同 cache_store.set）
        tmp = '%s.tmp%d-%d' % (path, os.getpid(), threading.get_ident())
        try:
            with open(tmp, 'wb') as f:
                f.write(b'%f|%s\n' % (exp, ctype.encode('ascii')))
                f.write(body)
            for i in range(4):
                try:
                    os.replace(tmp, path)
                    break
                except PermissionError:
                    # Windows：目标被并发读/替换时短暂拒绝，重试
                    if i == 3:
                        raise
                    time.sleep(0.05)
            # L3 锁纪律：以锁内读到的文件大小为准换文件 + 入账，一锁完成，
            # 消除并发 get（自愈销账）/clear（清账）交错导致的计数漂移。
            with self.lock:
                size = os.path.getsize(path)
                old = self._files.get(name)
                if old:
                    self._total -= old[0]
                self._files[name] = [size, exp, time.time()]
                self._total += size
            self._evict_if_needed()
            return True
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass
            return False

    # ---------------------------------------------------------------- 面板

    def clear(self):
        """清空全部条目，返回删除的文件数（tmp 残留留给 init 清理，同 cache_store）。

        L3 锁纪律：先在锁内摘账，再逐个删除文件（与 put 换文件入账互斥，
        不会出现「删除后 put 把旧账重新入账」或「计数漏减」）。"""
        self._ensure_scanned()
        removed = 0
        with self.lock:
            # 只摘账不清字典（L16 前的 names 死变量已删）：文件删除走下面的
            # listdir 全量扫描，不依赖 _files 的键集
            self._files.clear()
            self._total = 0
            self._scanned = True
        try:
            for fn in os.listdir(self.dir):
                if fn.endswith('.bin'):
                    try:
                        os.remove(os.path.join(self.dir, fn))
                        removed += 1
                    except OSError:
                        pass
        except OSError:
            pass
        return removed

    def stats(self):
        """返回 (bytes, entries, expired)，供 /cache cacheSize 统计展示。"""
        self._ensure_scanned()
        now = time.time()
        with self.lock:
            total = self._total
            entries = len(self._files)
            expired = sum(1 for meta in self._files.values()
                          if meta[1] and now >= meta[1])
        return total, entries, expired


# ---------------------------------------------------------------------------
# 进程级单例（play_cache 同款手法：惰性构造 + 测试目录注入）
# ---------------------------------------------------------------------------

_store_instance = None
_store_dir = None  # 测试注入目录；None 时按 hoststate 常规解析
_store_lock = threading.Lock()


def set_dir_for_tests(dirpath):
    """测试钩子：替换存储目录并丢弃单例（下次访问按新目录重建）。"""
    global _store_instance, _store_dir
    with _store_lock:
        _store_instance = None
        _store_dir = dirpath


def _store():
    global _store_instance
    if _store_instance is None:
        with _store_lock:
            if _store_instance is None:
                import hoststate
                base = _store_dir or os.path.join(hoststate.get_cache_dir(), 'covers')
                _store_instance = CoverStore(base)
    return _store_instance


def key_for(url):
    """缓存键：归一化封面 URL 的 sha1——与端口/token 解耦，重启后仍命中。"""
    return hashlib.sha1(url.encode('utf-8')).hexdigest()


def key_allowed(key):
    """模块级白名单查询（测试/调用方自检用）：合法键 True。"""
    return CoverStore._key_allowed(key)


def get(key):
    """命中返回 (字节, ctype)；缺失/过期/损坏返回 None。失败静默。"""
    try:
        return _store().get(key)
    except Exception:
        return None


def put(key, body, ctype=''):
    """写入一条；失败静默（缓存不影响主链路）。"""
    try:
        return _store().put(key, body, ctype)
    except Exception:
        return False


def stats():
    """返回 (bytes, entries, expired)，供 /cache cacheSize 统计。"""
    try:
        return _store().stats()
    except Exception:
        return (0, 0, 0)


def clear_all():
    """清空全部封面缓存，返回删除的文件数。"""
    try:
        return _store().clear()
    except Exception:
        return 0
