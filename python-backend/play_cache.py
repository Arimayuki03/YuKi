# -*- coding: utf-8 -*-
"""playerContent 解析结果持久缓存（RM-4）。

目的：重开同一集 / 重启应用后跳过查源直接起播（对标 Animeko 6.1.0
「在线源查询缓存」）。与 server.py 的 60s 内存缓存、playlist-proxy 的
会话级缓存互补——内存层管会话内换线路往返，本模块管跨会话与跨重启。

设计边界：
- 存储复用 CacheStore（内存 + 文件两级、原子写、TTL、容量淘汰），
  目录 ``<cache_dir>/play-cache/``，实例级容量上限 16MB（单条结果
  JSON 约 0.3~2KB，足够数万条目）。
- 只缓存「稳定」结果：写入与读出两侧都过 server.py 的
  ``_is_ephemeral_play_result`` 门（签名 CDN / 网盘一次性地址 /
  显式过期标记不落盘），读侧复检防止历史中毒条目回流。
- TTL 默认 2h：覆盖「重启应用后继续观看」「关掉重开同一集」高频
  场景。失效兜底由渲染层起播失败自动 refresh=1 重解析闭环，server
  侧 refresh 同时淘汰持久层。
- key 与 server.py 内存缓存一致：``site.key|flag|id|vip_key``（站点
  +集 + 线路 + vipFlags 都影响结果）。
"""
import os

from cache_store import CacheStore

# 持久层 TTL（秒）。模块级常量便于测试 monkeypatch。
PERSIST_TTL_SECONDS = 2 * 60 * 60
# 持久层容量上限：仅统计文件层（CacheStore 记账口径），超出先淘汰过期、
# 再按 mtime 淘汰最旧。每条结果 ≤ 数 KB，16MB 足够。
MAX_TOTAL_BYTES = 16 * 1024 * 1024

_store_instance = None
_store_dir = None  # 测试注入目录；None 时按 hoststate 常规解析


def set_dir_for_tests(dirpath):
    """测试钩子：替换存储目录并丢弃单例（下次访问按新目录重建）。"""
    global _store_instance, _store_dir
    _store_instance = None
    _store_dir = dirpath


def _store():
    global _store_instance
    if _store_instance is None:
        import hoststate
        base = _store_dir or os.path.join(hoststate.get_cache_dir(), 'play-cache')
        inst = CacheStore(base)
        inst.max_bytes = MAX_TOTAL_BYTES
        _store_instance = inst
    return _store_instance


def get_result(key):
    """命中返回缓存的 result JSON 字符串；缺失/过期返回 None。"""
    try:
        value = _store().get(key)
    except Exception:
        return None
    return value or None


def store_result(key, result_str, ttl=None):
    """写入一条解析结果（JSON 字符串）。失败静默——缓存不影响主链路。"""
    if not result_str or not key:
        return
    seconds = PERSIST_TTL_SECONDS if ttl is None else ttl
    try:
        _store().set(key, result_str, max(1, int(seconds)))
    except Exception:
        pass


def invalidate(key):
    """失效重解析：删除一条（内存层 + 文件层）。"""
    try:
        _store().delete(key)
    except Exception:
        pass


def clear_all():
    """清空全部解析结果缓存，返回删除的文件数。"""
    try:
        return _store().clear()
    except Exception:
        return 0


def stats():
    """返回 (bytes, entries, expired)，供 /cache 统计展示。"""
    try:
        return _store().stats()
    except Exception:
        return (0, 0, 0)
