/**
 * cache.js — 渲染层核心业务数据本地持久化（任务十一）
 *
 * 提供带 TTL 与总容量上限的 localStorage 缓存封装，供高频只读业务数据
 * （推荐榜单、番剧时间表、Bangumi 元数据匹配等）落盘复用，切页/重启即时上屏。
 *
 * 设计要点：
 *   - 每条目 JSON 结构 { v: value, e: 过期时间戳(0=永久), t: 写入时间戳 }。
 *   - 统一键前缀 vpc_cache::，与其他 localStorage 键隔离，clearAll 只清本命名空间。
 *   - 总容量上限 ~1.5MB：写入前预估体积，超限按最旧写入时间(t)淘汰直至可容纳；
 *     仍 QuotaExceededError 时静默放弃（缓存是优化，失败不影响主流程）。
 *   - 只由调用方缓存成功响应；本层不判定数据有效性（读回过期即视为未命中）。
 */
/* global window */

(function () {
    'use strict';

    const root = typeof window !== 'undefined' ? window : globalThis;
    const NS = 'vpc_cache::';           // 命名空间前缀
    const MAX_BYTES = 1.5 * 1024 * 1024; // 总容量上限 ~1.5MB（本命名空间内所有条目字符串长度之和）

    function _ls() {
        try { return root.localStorage; } catch (e) { return null; }
    }

    /** 遍历本命名空间的所有条目键（不触碰其他 localStorage 键）。 */
    function _nsKeys(ls) {
        const out = [];
        for (let i = 0; i < ls.length; i++) {
            const k = ls.key(i);
            if (k && k.indexOf(NS) === 0) out.push(k);
        }
        return out;
    }

    /** 估算本命名空间已占用字节数（键 + 值的字符长度近似）。 */
    function _usedBytes(ls) {
        let total = 0;
        _nsKeys(ls).forEach((k) => {
            const v = ls.getItem(k);
            total += k.length + (v ? v.length : 0);
        });
        return total;
    }

    /** 按写入时间(t) 升序淘汰最旧条目，直到剩余空间可容纳 need 字节（或清空本命名空间）。 */
    function _evictUntil(ls, need) {
        const entries = _nsKeys(ls).map((k) => {
            let t = 0;
            try { t = (JSON.parse(ls.getItem(k)) || {}).t || 0; } catch (e) { t = 0; }
            return { k, t, size: k.length + (ls.getItem(k) || '').length };
        });
        entries.sort((a, b) => a.t - b.t); // 最旧在前
        let used = entries.reduce((s, e) => s + e.size, 0);
        for (const e of entries) {
            if (used + need <= MAX_BYTES) break;
            ls.removeItem(e.k);
            used -= e.size;
        }
    }

    /**
     * 读取缓存值：未命中/已过期/解析失败均返回 null（过期条目惰性删除）。
     * @param {string} key 业务键（不含命名空间前缀）
     */
    function localCacheGet(key) {
        const ls = _ls();
        if (!ls) return null;
        const full = NS + key;
        let raw;
        try { raw = ls.getItem(full); } catch (e) { return null; }
        if (!raw) return null;
        let obj;
        try { obj = JSON.parse(raw); } catch (e) { try { ls.removeItem(full); } catch (e2) { /* ignore */ } return null; }
        if (!obj || typeof obj !== 'object') return null;
        if (obj.e && Date.now() >= obj.e) {
            try { ls.removeItem(full); } catch (e) { /* ignore */ }
            return null;
        }
        return obj.v === undefined ? null : obj.v;
    }

    /**
     * 写入缓存值（带 TTL 与容量上限）。失败静默（缓存是优化，不影响主流程）。
     * @param {string} key 业务键
     * @param {*} value 任意可 JSON 序列化的值
     * @param {number} ttlMs 过期毫秒数；<=0 或省略表示永不过期
     */
    function localCacheSet(key, value, ttlMs) {
        const ls = _ls();
        if (!ls) return false;
        const full = NS + key;
        const now = Date.now();
        const payload = { v: value, e: (ttlMs && ttlMs > 0) ? now + ttlMs : 0, t: now };
        let str;
        try { str = JSON.stringify(payload); } catch (e) { return false; }
        const need = full.length + str.length;
        // 单条目超过总上限：不缓存（否则会把其他条目全淘汰仍存不下）
        if (need > MAX_BYTES) return false;
        try {
            // 预清理：为新条目腾出空间（先减去将被覆盖的旧值体积）
            let projected = _usedBytes(ls) + need;
            const old = ls.getItem(full);
            if (old) projected -= (full.length + old.length);
            if (projected > MAX_BYTES) _evictUntil(ls, need);
            ls.setItem(full, str);
            return true;
        } catch (e) {
            // QuotaExceededError：激进淘汰后重试一次，仍失败则放弃
            try {
                _evictUntil(ls, need);
                ls.setItem(full, str);
                return true;
            } catch (e2) { return false; }
        }
    }

    /** 删除单个缓存条目。 */
    function localCacheDel(key) {
        const ls = _ls();
        if (!ls) return;
        try { ls.removeItem(NS + key); } catch (e) { /* ignore */ }
    }

    /**
     * 清空本命名空间下的全部缓存（设置页「清理缓存」调用）。返回删除条目数。
     * 只清 vpc_cache:: 前缀键，不影响 kazumi_bgm_cover / vpc_home_empty_classes 等
     * 独立业务键（这些由各自模块的清理入口负责）。
     */
    function localCacheClearAll() {
        const ls = _ls();
        if (!ls) return 0;
        const keys = _nsKeys(ls);
        keys.forEach((k) => { try { ls.removeItem(k); } catch (e) { /* ignore */ } });
        return keys.length;
    }

    // 挂到全局（脚本以 <script defer> 顺序加载，非模块化）
    root.localCacheGet = localCacheGet;
    root.localCacheSet = localCacheSet;
    root.localCacheDel = localCacheDel;
    root.localCacheClearAll = localCacheClearAll;
    root.VPC = root.VPC || {};
    root.VPC.cache = {
        get: localCacheGet,
        set: localCacheSet,
        del: localCacheDel,
        clearAll: localCacheClearAll,
    };
})();
