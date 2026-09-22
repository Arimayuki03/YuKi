# -*- coding: utf-8 -*-
"""进程级 TTL 内存缓存（会话内提速共享底座）。

服务对象（缓存优化任务）：
- Spider 内容 API（homeContent/categoryContent/detailContent/searchContent）：
  切源往返、翻页重访、重复搜索不再逐次实时查源；
- Kazumi 规则源搜索（kazumiSearch / /search/kazumi-stream）与章节
  （kazumiChapters）：同关键词重复搜索命中即回，不再全量请求各规则源。

设计要点：
- 纯内存、进程生命周期内有效；跨重启场景由 play_cache / 渲染层 cache.js
  等持久层负责，本模块专注「会话内高频重复调用」的热路径。
- 命名空间（ns）隔离；值只存 JSON 字符串（调用方自行序列化），单条与总量
  双上限，防止大响应挤爆内存；超限按 LRU（最近访问序）淘汰。
- 条数/字节总账（_total_entries/_total_chars）在锁内增量维护：稳态写入
  O(1)，只有真正超限才扫描淘汰，避免每次 set 都做一遍全表统计。
- invalid_* 系列供配置热替换、插件增删等变更点整体失效，避免陈旧数据
  跨配置/跨插件存活；mutate() 供需要「读旧值→改→写回」复合值的调用方
  （如 kazumi 流索引追加）做锁内原子更新，防止跨请求读改写竞态丢数据。
- 所有方法不向上抛错语义由调用方负责：本模块只在参数非法时静默返回，
  内部数据结构操作不依赖外部 IO，不会产生运行时异常路径。
"""
import time
from collections import OrderedDict
from threading import Lock

# 单条 value 上限（字符数）：home/detail/search 响应均在几十 KB 内，512KB 是
# 富余护栏——超限条目拒绝写入，防个别异常大响应挤占内存。
MAX_VALUE_CHARS = 512 * 1024
# 全局条目总数上限：超出按「最久未访问」淘汰（LRU）。
MAX_TOTAL_ENTRIES = 4096
# 全局总字节（字符数）预算：条数护栏挡不住「少量条目 × 大 value」的体积膨胀
# （4096 × 512KB 理论上限约 2GB），64MB 对本进程的缓存语义足够宽裕。
MAX_TOTAL_CHARS = 64 * 1024 * 1024

# ns -> 默认 TTL（秒）。调用方可 set_value 时逐条覆盖；测试按既有惯例
# 直接 monkeypatch 本表或逐条传 ttl。
DEFAULT_TTL = {
    'spider:home': 600,
    'spider:category': 600,
    'spider:detail': 1800,
    'spider:search': 600,
    'kazumi:search': 600,
    # kazumi SSE 流的单源 payload 与整词索引独立命名空间：与全量搜索 body
    # 分仓后，二者 TTL/淘汰/整体失效互不牵连。
    'kazumi:stream': 600,
    'kazumi:chapters': 1800,
}

_lock = Lock()
# ns -> OrderedDict[key -> [value, exp, last_access]]（OrderedDict 维护 LRU 序）
_store = {}
# 全局总账（仅 _lock 内更新）：稳态写入无需全表扫描即可判断超限
_total_entries = 0
_total_chars = 0


def _clamp_ttl(ns, ttl):
    seconds = DEFAULT_TTL.get(ns, 600) if ttl is None else ttl
    try:
        return max(1, int(seconds))
    except (TypeError, ValueError):
        return 600


def _put_locked(bucket, key, value, now, seconds):
    """锁内写入一条并同步总账（调用方持 _lock；bucket 已存在）。"""
    global _total_entries, _total_chars
    old = bucket.get(key)
    if old is not None:
        _total_chars -= len(old[0])
        bucket.move_to_end(key)
    else:
        _total_entries += 1
    bucket[key] = [value, now + seconds, now]
    _total_chars += len(value)


def _drop_locked(bucket, key):
    """锁内删除一条并同步总账（调用方持 _lock；key 已确认存在）。"""
    global _total_entries, _total_chars
    meta = bucket.pop(key)
    _total_chars -= len(meta[0])
    _total_entries -= 1


def _evict_locked():
    """条数或总字节超预算时，从最久未访问的条目开始删。

    总账判断 O(1)；超限时按「每个命名空间桶首项 = 该桶 LRU 最旧」一轮收集
    候选、按 last_access 排序后成批删除——不再每删 1 条就全命名空间重扫
    （旧实现最坏 O(n²) 且全程持全局锁）。若一批删完仍超限（单条大 value），
    再收集下一轮。"""
    while _total_entries > MAX_TOTAL_ENTRIES or _total_chars > MAX_TOTAL_CHARS:
        # 单轮候选：每个非空桶的第一个条目（OrderedDict 首项，桶内最旧）。
        candidates = []
        for n, b in _store.items():
            if not b:
                continue
            k, meta = next(iter(b.items()))
            candidates.append((meta[2], n, k))
        if not candidates:
            break
        candidates.sort()
        evicted = False
        for _at, ns, key in candidates:
            if _total_entries <= MAX_TOTAL_ENTRIES and _total_chars <= MAX_TOTAL_CHARS:
                break
            bucket = _store.get(ns)
            # 期间无并发写（持 _lock），桶与条目必然仍在；防御式判空兜底。
            if not bucket or key not in bucket:
                continue
            _drop_locked(bucket, key)
            evicted = True
        if not evicted:
            break


def set_value(ns, key, value, ttl=None):
    """写入一条缓存。value 必须是字符串（约定为 JSON）；参数非法静默忽略。"""
    if not ns or not key or not isinstance(value, str):
        return
    if len(value) > MAX_VALUE_CHARS:
        return
    seconds = _clamp_ttl(ns, ttl)
    now = time.monotonic()
    with _lock:
        bucket = _store.get(ns)
        if bucket is None:
            bucket = OrderedDict()
            _store[ns] = bucket
        _put_locked(bucket, key, value, now, seconds)
        _evict_locked()


def get_value(ns, key):
    """命中返回缓存字符串；缺失/过期返回 None（过期条目惰性删除）。"""
    if not ns or not key:
        return None
    now = time.monotonic()
    with _lock:
        bucket = _store.get(ns)
        if not bucket or key not in bucket:
            return None
        value, exp, _ = bucket[key]
        if now >= exp:
            _drop_locked(bucket, key)
            return None
        bucket.move_to_end(key)
        bucket[key][2] = now
        return value


def mutate(ns, key, mutator, ttl=None):
    """锁内原子更新 (ns, key)：mutator(旧值字符串或 None) → 新值字符串。

    供「读旧值→追加→写回」型复合值（如 kazumi 流索引登记）使用；调用方若
    自行 get+set 拼读改写，两个并发流交错时后写者会静默覆盖前者丢登记。
    约束：mutator 必须是纯计算，绝不可回调本模块任何公开 API
    （threading.Lock 不可重入，重入即死锁）；返回 None 或超长值不写入。"""
    if not ns or not key or not callable(mutator):
        return
    now = time.monotonic()
    seconds = _clamp_ttl(ns, ttl)
    with _lock:
        bucket = _store.get(ns)
        old = None
        if bucket is not None and key in bucket:
            value, exp, _ = bucket[key]
            if now < exp:
                old = value
            else:
                _drop_locked(bucket, key)  # 过期视同缺失
        new = mutator(old)
        if not isinstance(new, str) or len(new) > MAX_VALUE_CHARS:
            return
        if bucket is None:
            bucket = OrderedDict()
            _store[ns] = bucket
        _put_locked(bucket, key, new, now, seconds)
        _evict_locked()


def delete_value(ns, key):
    """删除单条缓存（幂等；缺失静默）。"""
    if not ns or not key:
        return
    with _lock:
        bucket = _store.get(ns)
        if bucket and key in bucket:
            _drop_locked(bucket, key)


def invalidate(ns):
    """清空一个命名空间（配置热替换 / 插件变更整体失效）。"""
    if not ns:
        return
    global _total_entries, _total_chars
    with _lock:
        bucket = _store.pop(ns, None)
        if bucket:
            _total_entries -= len(bucket)
            _total_chars -= sum(len(meta[0]) for meta in bucket.values())


def invalidate_prefix(ns, key_prefix):
    """按 key 前缀失效（生产调用方：SSE 流超时后的整词缓存清除，
    见 server._kazumi_stream_cache_invalidate_word；亦供按站点清某源全部条目）。"""
    if not ns or not key_prefix:
        return
    global _total_entries, _total_chars
    with _lock:
        bucket = _store.get(ns)
        if not bucket:
            return
        stale = [k for k in bucket if str(k).startswith(key_prefix)]
        if not stale:
            return
        _total_entries -= len(stale)
        _total_chars -= sum(len(bucket[k][0]) for k in stale)
        for k in stale:
            del bucket[k]


def clear_all():
    """清空全部命名空间（设置面板「清理缓存」时一并回收内存层）。"""
    global _total_entries, _total_chars
    with _lock:
        _store.clear()
        _total_entries = 0
        _total_chars = 0


def stats():
    """各命名空间活条目数与字节量：{ns: {'items': n, 'chars': m}}。

    供 /action do=cacheSize 内存层分项统计；过期未清条目不计入（惰性删除口径）。"""
    now = time.monotonic()
    with _lock:
        out = {}
        for ns, bucket in _store.items():
            items = 0
            chars = 0
            for value, exp, _ in bucket.values():
                if now < exp:
                    items += 1
                    chars += len(value)
            if items:
                out[ns] = {'items': items, 'chars': chars}
        return out
