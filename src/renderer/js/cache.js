/**
 * cache.js — 渲染层核心业务数据本地持久化（任务十一；B-10 容量治理双池化）
 *
 * 提供带 TTL 与总容量上限的 localStorage 缓存封装，供高频只读业务数据
 * （推荐榜单、番剧时间表、Bangumi 元数据匹配等）落盘复用，切页/重启即时上屏。
 *
 * 设计要点：
 *   - 每条目 JSON 结构 { v: value, e: 过期时间戳(0=永久), t: 写入时间戳 }。
 *   - 双命名空间池（B-10，优化.md 裁决「轻量方案优先：大 payload 走独立命名空间」，
 *     IndexedDB 迁移作备选非必要不上——本实现为纯治理不扩容）：
 *       · 小条目池 yuki_cache::（默认）：容量 1.5MB，承载高频小条目（封面补拉、
 *         Bangumi 匹配、bgmextra、catwin、sites/class 等），相互淘汰影响可控。
 *       · 大条目池 yuki_bigcache::：容量 3MB，承载 feed 快照 / 搜索快照 /
 *         详情整包等 KB~百 KB 级条目。两池独立记账、独立 LRU（按 t 淘汰），
 *         大条目不再把高频小条目挤出小池（1.5MB 池里一条长剧 vod_play_url
 *         可达数百 KB，旧单池下一次读详情即可淘汰几十条封面/匹配缓存）。
 *   - 路由规则（写）：调用方可用第 4 参 opts.pool 显式指定 'big'；未指定时按
 *     序列化体积 ≥ BIG_ROUTE_BYTES（256KB）自动落大池（兜底分流，无需各写入点
 *     预估体积）。写入成功后本层即删除另一池的同 key 旧条目（M6 写后排他），
 *     保证「同一业务键任意时刻只存在于一个池」——读/删（localCacheGet/Del）
 *     两池透明尝试因此无歧义；对调用方完全兼容——不传 opts 时行为与旧单池
 *     语义一致（小条目仍进小池）。
 *   - 超限按最旧写入时间(t)淘汰直至可容纳；仍 QuotaExceededError 时静默放弃
 *     （缓存是优化，失败不影响主流程）。
 *   - 只由调用方缓存成功响应；本层不判定数据有效性（读回过期即视为未命中）。
 *   - 旧版单池时代已落盘的 yuki_cache:: 大条目不做迁移，随 TTL 过期自然淘汰
 *     （读侧双池透明，迁移前后均能命中）。
 */
/* global window */

(function () {
    'use strict';

    const root = typeof window !== 'undefined' ? window : globalThis;
    // B-10 双池命名空间：小条目池沿用旧前缀（存量条目自然延续），大条目池独立前缀。
    const NS = 'yuki_cache::';           // 小条目池前缀（默认池）
    const NS_BIG = 'yuki_bigcache::';    // 大条目池前缀（B-10 新增）
    const MAX_BYTES = 1.5 * 1024 * 1024; // 小条目池容量上限 ~1.5MB（本池所有条目字符串长度之和）
    const MAX_BYTES_BIG = 3 * 1024 * 1024; // 大条目池容量上限 ~3MB（独立记账，与小池互不挤占）
    // B-10：写入未显式指定池时，序列化体积达到该阈值的条目自动路由到大池。
    // 取值依据：小池承载的常规条目（封面 ~150B、bgmextra 数十 KB、feed 数十 KB）
    // 远低于此值；一条长剧 vod 整包（vod_play_url）可达数百 KB，正是需要隔离的对象。
    const BIG_ROUTE_BYTES = 256 * 1024;
    // L35 容量口径澄清：本层容量记账（MAX_BYTES/MAX_BYTES_BIG/need 等比较）按
    // str.length（UTF-16 码元）近似估算字节——中文/emoji 等多码元字符的实际
    // UTF-8 字节更高（一个中文码元 2 字节 vs UTF-8 3 字节）。口径为淘汰预算
    // （相对量级比较）而非精确配额，真实磁盘占用以浏览器 localStorage 实现为准。

    function _ls() {
        try { return root.localStorage; } catch (e) { return null; }
    }

    /** 遍历指定前缀命名空间的所有条目键（不触碰其他 localStorage 键）。 */
    function _nsKeys(ls, ns) {
        const out = [];
        for (let i = 0; i < ls.length; i++) {
            const k = ls.key(i);
            if (k && k.indexOf(ns) === 0) out.push(k);
        }
        return out;
    }

    // （历史：_usedBytes 全量估算法已被 _evictUntil 的「单次遍历返回预计写入后
    // 用量」取代（2026-10-02 性能优化），无调用点后删除。）

    /** 按写入时间(t) 升序淘汰最旧条目，直到指定池剩余空间可容纳 need 字节（或清空该池）。
     *  每条目只 getItem 一次并单次 JSON.parse 取 t，同时按字符长度算 size（避免旧实现的双取双解析）。
     *  B-10：在调用方所属池内淘汰——两池互不挤占是本任务的核心语义。
     *
     *  @param {string} [skipKey] 即将被本条写入覆盖的完整键：其旧体积不计入用量
     *    （写入会替换它，不是新增占用）。
     *  @returns {number} 淘汰后该池的**预计写入后用量**（含 need，已扣除 skipKey 旧值），
     *    供调用方判断是否需要放弃写入；未超限时不做任何删除（快路径，零副作用）。 */
    function _evictUntil(ls, ns, need, skipKey) {
        const maxBytes = ns === NS_BIG ? MAX_BYTES_BIG : MAX_BYTES;
        const entries = _nsKeys(ls, ns).map((k) => {
            const raw = ls.getItem(k) || '';
            let t = 0;
            try { t = (JSON.parse(raw) || {}).t || 0; } catch (e) { t = 0; }
            return { k, t, size: k.length + raw.length };
        });
        entries.sort((a, b) => a.t - b.t); // 最旧在前
        let used = entries.reduce((s, e) => s + e.size, 0);
        if (skipKey) {
            // 同 key 覆盖：旧值体积会被本条写入替换掉，不计入增量
            const prev = entries.find((e) => e.k === skipKey);
            if (prev) used -= prev.size;
        }
        let projected = used + need;
        if (projected <= maxBytes) return projected; // 快路径：无需淘汰
        for (const e of entries) {
            if (projected <= maxBytes) break;
            if (skipKey && e.k === skipKey) continue; // 不淘汰即将被覆盖的键
            ls.removeItem(e.k);
            projected -= e.size;
        }
        return projected;
    }

    /** B-10：业务键归属哪个池。写路由已定池的键直接返回；读/删按「大池优先」
     *  探测（大池条目体积大、命中成本低，先查一次 getItem 即可定位）。定位无
     *  歧义的保障不在本函数，而在写侧：localCacheSet 成功后即删除另一池同 key
     *  条目（M6 写后排他），任意时刻同一业务键只存在于其中一个池。返回实际
     *  命中的完整键或 null。 */
    function _locate(ls, key) {
        const fullBig = NS_BIG + key;
        let raw = null;
        try { raw = ls.getItem(fullBig); } catch (e) { return null; }
        if (raw !== null) return fullBig;
        return NS + key;
    }

    /**
     * 统计缓存占用（B-10 双池口径）：{bytes, count, expired, big}。
     * 每条目只读一次 raw：bytes 为两池键+值字符长度之和，count 为条目数，
     * expired 为已过期（e && Date.now()>=e）条目数（不做删除，只统计），
     * big 为大条目池 {bytes, count}（panels.js 设置页「本地」分项沿用顶层
     * bytes 口径不变，大池占用并入总数；需要分池明细时读 big 子对象）。
     */
    function localCacheStats() {
        const ls = _ls();
        if (!ls) return { bytes: 0, count: 0, expired: 0, big: { bytes: 0, count: 0 } };
        const now = Date.now();
        let bytes = 0, count = 0, expired = 0;
        let bigBytes = 0, bigCount = 0;
        const scan = (ns, isBig) => {
            _nsKeys(ls, ns).forEach((k) => {
                const raw = ls.getItem(k) || '';
                bytes += k.length + raw.length;
                count += 1;
                if (isBig) { bigBytes += k.length + raw.length; bigCount += 1; }
                try {
                    const obj = JSON.parse(raw);
                    if (obj && obj.e && now >= obj.e) expired += 1;
                } catch (e) { /* 解析失败不计入过期 */ }
            });
        };
        scan(NS, false);
        scan(NS_BIG, true);
        return { bytes, count, expired, big: { bytes: bigBytes, count: bigCount } };
    }

    /**
     * 主动清理两池下已过期（e && Date.now()>=e）条目，返回删除条目数。
     * 供设置页清理时调用或启动时惰性调用（不触碰未过期/永久条目与其他 localStorage 键）。
     */
    function localCachePrune() {
        const ls = _ls();
        if (!ls) return 0;
        const now = Date.now();
        let removed = 0;
        [NS, NS_BIG].forEach((ns) => {
            _nsKeys(ls, ns).forEach((k) => {
                const raw = ls.getItem(k);
                if (!raw) return;
                let obj;
                try { obj = JSON.parse(raw); } catch (e) { return; }
                if (obj && obj.e && now >= obj.e) {
                    try { ls.removeItem(k); removed += 1; } catch (e2) { /* ignore */ }
                }
            });
        });
        return removed;
    }

    /**
     * 读取缓存值：未命中/已过期/解析失败均返回 null（过期条目惰性删除）。
     * B-10：大池优先探测后回落小池，两池透明——调用方无需关心条目落在哪一池
     * （写侧 M6 排他保证同 key 只在一池；含旧单池时代写入 yuki_cache:: 的存量
     * 条目，迁移期读侧始终兼容）。
     * @param {string} key 业务键（不含命名空间前缀）
     */
    function localCacheGet(key) {
        const ls = _ls();
        if (!ls) return null;
        let full = null;
        try { full = _locate(ls, key); } catch (e) { return null; }
        if (!full) return null;
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
     * 读取缓存值（含已过期条目，stale-while-revalidate 专用）：命中返回
     * { value, at, expired }——value 为缓存值，at 为写入时间戳，expired 标记
     * 是否已过 TTL。未命中/解析失败返回 null；过期条目**不删除**（调用方
     * revalidate 成功后会覆盖重写，失败时陈旧条目仍是下次的垫场数据）。
     * 与 localCacheGet 的分工：get 是「新鲜度敏感」读（过期即未命中），
     * peek 是「先垫场后校准」读（详情 SWR 等场景），语义不可混用。
     * @param {string} key 业务键（不含命名空间前缀）
     */
    function localCachePeek(key) {
        const ls = _ls();
        if (!ls) return null;
        let full = null;
        try { full = _locate(ls, key); } catch (e) { return null; }
        if (!full) return null;
        let raw;
        try { raw = ls.getItem(full); } catch (e) { return null; }
        if (!raw) return null;
        let obj;
        try { obj = JSON.parse(raw); } catch (e) { return null; }
        if (!obj || typeof obj !== 'object' || obj.v === undefined) return null;
        return { value: obj.v, at: Number(obj.t) || 0, expired: !!(obj.e && Date.now() >= obj.e) };
    }

    /**
     * 写入缓存值（带 TTL 与容量上限）。失败静默（缓存是优化，不影响主流程）。
     * @param {string} key 业务键
     * @param {*} value 任意可 JSON 序列化的值
     * @param {number} ttlMs 过期毫秒数；<=0 或省略表示永不过期
     * @param {object} [opts] B-10 可选参数：{ pool: 'small'|'big' } 显式指定池；
     *   省略时按序列化体积 ≥ BIG_ROUTE_BYTES 自动路由大池。写入成功后另一池同
     *   key 旧条目随之删除（M6 写后排他，双池永不共存同 key）。不传 opts 时小
     *   条目行为与旧单池完全一致（仍进 yuki_cache:: 池）。
     */
    function localCacheSet(key, value, ttlMs, opts) {
        const ls = _ls();
        if (!ls) return false;
        // B-10 池路由：显式 opts.pool 优先；否则写前序列化后按体积阈值判定。
        // 序列化本来就要做（旧实现同样先 stringify 再算 need），阈值判定零额外开销。
        let str;
        try {
            // 单一时间基准：e（过期时刻）与 t（写入时刻）必须同源，分两次
            // Date.now() 可能跨越毫秒边界，让同一条目的两个时间戳不自洽。
            const now = Date.now();
            const payload = { v: value, e: (ttlMs && ttlMs > 0) ? now + ttlMs : 0, t: now };
            str = JSON.stringify(payload);
        } catch (e) { return false; }
        let ns = NS;
        if (opts && (opts.pool === 'big' || opts.pool === 'small')) {
            ns = opts.pool === 'big' ? NS_BIG : NS;
        } else if (str.length >= BIG_ROUTE_BYTES) {
            ns = NS_BIG; // 体积兜底：巨型条目（长剧 vod 整包等）自动隔离进大池
        }
        const full = ns + key;
        const maxBytes = ns === NS_BIG ? MAX_BYTES_BIG : MAX_BYTES;
        const need = full.length + str.length;
        // 单条目超过本池总上限：不缓存（否则会把本池其他条目全淘汰仍存不下）
        if (need > maxBytes) return false;
        try {
        // 预清理：为新条目腾出空间（先减去将被覆盖的旧值体积；同 key 换池覆盖时
        // 旧值在另一池——按 M6 写后排他语义，本条写入成功后另一池同 key 旧条目
        // 会被删除，此处只按本池旧值减免，另一池遗留由下方写后删除收口）。
        // 性能优化（2026-10-02）：原先 _usedBytes(ls, ns) 全量遍历一次算出用量，
        // 超限后 _evictUntil 又全量映射 + 逐条 JSON.parse 再排序——大池上千条时
        // 同一批数据被扫两遍，同步阻塞渲染进程。改为只扫一次：由 _evictUntil
        // 直接返回预计写入后用量（未超限时它不做任何删除）。
        // L34：projected > maxBytes 分支已删——need > maxBytes 在进入 try 前已提前
        // return false，_evictUntil 淘汰到底（清空全池）后 projected 最多为 need，
        // 该分支不可达（历史代码此处 return false，删除不影响返回值语义）。
        const projected = _evictUntil(ls, ns, need, full);
        ls.setItem(full, str);
            // M6 写后排他：删掉另一池的同 key 旧条目，落实「同一业务键任意时刻
            // 只存在于一个池」——否则换池覆盖（小体积写入后体积增长跨过 256KB
            // 阈值换大池，或反向，或 ttl=0 收藏键等永久条目换池）后，读侧「大池
            // 优先」会一直命中另一池的陈旧旧值，覆盖刚写入的新值（last-write-wins
            // 破坏）。removeItem 对不存在的键是 no-op，成本可忽略。
            try { ls.removeItem((ns === NS_BIG ? NS : NS_BIG) + key); } catch (e2) { /* ignore */ }
            return true;
        } catch (e) {
            // QuotaExceededError：激进淘汰后重试一次，仍失败则放弃
            // L32：重试与主路径同口径传 skipKey——否则按「新键不存在」重新估算，
            // 会把即将被覆盖的同 key 旧值也计入用量并可能将其淘汰（过度淘汰）
            try {
                _evictUntil(ls, ns, need, full);
                ls.setItem(full, str);
                try { ls.removeItem((ns === NS_BIG ? NS : NS_BIG) + key); } catch (e3) { /* ignore */ }
                return true;
            } catch (e2) { return false; }
        }
    }

    /**
     * 删除单个缓存条目。B-10：两池透明探测删除，调用方无需关心条目所在池。
     */
    function localCacheDel(key) {
        const ls = _ls();
        if (!ls) return;
        // 直接按两池前缀各删一次（removeItem 对不存在的键是 no-op，无额外探测成本）
        try { ls.removeItem(NS_BIG + key); } catch (e) { /* ignore */ }
        try { ls.removeItem(NS + key); } catch (e) { /* ignore */ }
    }

    /**
     * 清空两池全部缓存（设置页「清理缓存」调用）。返回删除条目数。
     * 只清 yuki_cache:: / yuki_bigcache:: 前缀键，不影响 kazumi_bgm_cover /
     * yuki_home_empty_classes 等独立业务键（这些由各自模块的清理入口负责）。
     */
    function localCacheClearAll() {
        const ls = _ls();
        if (!ls) return 0;
        const keys = _nsKeys(ls, NS).concat(_nsKeys(ls, NS_BIG));
        keys.forEach((k) => { try { ls.removeItem(k); } catch (e) { /* ignore */ } });
        return keys.length;
    }

    // 挂到全局（脚本以 <script defer> 顺序加载，非模块化）
    root.localCacheGet = localCacheGet;
    root.localCachePeek = localCachePeek;
    root.localCacheSet = localCacheSet;
    root.localCacheDel = localCacheDel;
    root.localCacheClearAll = localCacheClearAll;
    root.localCacheStats = localCacheStats;
    root.localCachePrune = localCachePrune;
    root.YUKI = root.YUKI || {};
    root.YUKI.cache = {
        get: localCacheGet,
        peek: localCachePeek,
        set: localCacheSet,
        del: localCacheDel,
        clearAll: localCacheClearAll,
        stats: localCacheStats,
        prune: localCachePrune,
    };
})();
