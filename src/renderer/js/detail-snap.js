/**
 * detail-snap.js — 详情页列表快照写入侧（A-01 第一阶段，优化.md 批次 A-3 表格 A-01）
 *
 * 目标：详情页缓存（detail::vod::v1）未命中时首屏从「白等 30s 上限」提速为
 * 「立即出 hero（封面+标题+meta）」。列表卡片在用户点开详情的那一刻已经持有
 * 封面/标题等展示字段，顺手把它们写进短 TTL 快照；第二阶段（后续代理交付）
 * 由 detail.js 的 open()/openBangumi() 读快照先行半渲染，detailContent 返回后
 * 以详情结果为权威数据整页覆盖（merge 策略：详情结果优先）。
 *
 * 设计要点：
 *   - 独立小模块而非并入 cache.js：cache.js 是无业务语义的纯 KV 封装
 *     （localCacheGet/Set/Del/ClearAll/Stats/Prune），快照的字段裁剪、结构校验
 *     与 site|vodId 回读一致性校验都是详情页业务语义，按仓库「cache.js 只做
 *     通用持久化、业务键各自封装」的惯例独立成模块（先例：home.js B-05 的
 *     _catWinCache* 同样是调用方侧封装）。
 *   - key：detail::snap::v1::<site|vodId>（优化.md 指定），与 detail.js 既有
 *     detail::vod::v1:: 的 cacheKey 拼法（site|vodId）一致；经 cache.js 落盘，
 *     在 yuki_cache:: 命名空间内，localCacheClearAll 全清自然覆盖，无需单独清理。
 *   - TTL 2h（优化.md「短 TTL」）：快照只是封面+标题的「感知提速」垫场数据，
 *     过期宁缺勿错——回读过期即视为未命中（cache.js 惰性删除）。
 *   - 条目体积极小（四字段白名单 + site/vodId/ts，字段各截 500 字符，单条 ~2KB
 *     上限），远低于 cache.js 单条拒绝阈值与大池配额，不做特殊容量治理（L39
 *     取舍见 SNAP_FIELD_MAX_CHARS 处注释）。
 *   - 写入 fire-and-forget：快照是纯优化，任何失败静默不影响 Detail.open 主流程。
 *   - 不存 vod_play_url：那是 detailContent 返回后的 detail::vod::v1 的事。
 */
/* global window, localCacheSet, localCacheGet, localCacheDel */

(function () {
    'use strict';

    const root = typeof window !== 'undefined' ? window : globalThis;
    const SNAP_PREFIX = 'detail::snap::v1::'; // + site|vodId（优化.md 指定 key）
    const SNAP_TTL_MS = 2 * 60 * 60 * 1000;   // 短 TTL 2h：详情结果才是权威数据
    // L39：本模块 put 的字段白名单（pic/name/remarks/year，各 String 截前 500 字符）
    // 保证单条上限 ~2KB——远低于 cache.js 大池 3MB 单条拒绝阈值（MAX_BYTES_BIG，
    // need > maxBytes 时静默 return false 不触发淘汰），不会挤占大池。阈值维护在
    // cache.js（容量记账的唯一权威），此处不重复定义，仅记录取舍得失：个别超长
    // 简介/标题被截断是快照垫场可接受的损失（详情结果是权威数据，到达即整页覆盖）。
    const SNAP_FIELD_MAX_CHARS = 500; // 单字段截断上限（防个别源的超长 remarks/year 撑大条目）

    /**
     * 快照 key 与 detail.js load() 的 cacheKey 拼法保持一致：site|vodId。
     * S2：归一化口径与 put/get 一致——仅 null/undefined 归一为空串（== null），
     * 不用 `||`（否则 site=0 等假值会被错误吞成空串导致 key 漂移）。
     */
    function snapKey(site, vodId) {
        return SNAP_PREFIX + String(site == null ? '' : site) + '|' + String(vodId == null ? '' : vodId);
    }

    /** 可入快照的四字段白名单（优化.md：卡片已持有 vod_pic/vod_name/vod_remarks/vod_year）。
     *  undefined/null/空串字段直接剔除（部分快照合法：调用方缺年份等字段时跳过该字段）；
     *  保留字段截前 SNAP_FIELD_MAX_CHARS 字符——个别源把整段简介塞进 vod_remarks 时
     *  快照条目仍守住 ~2KB 量级（L39 容量语义，取舍见常量处注释）。 */
    function _trimFields(fields) {
        if (!fields || typeof fields !== 'object') return null;
        const out = {};
        let kept = 0;
        ['pic', 'name', 'remarks', 'year'].forEach((f) => {
            const v = fields[f];
            if (v === undefined || v === null) return;
            const s = String(v).trim();
            if (!s) return;
            out[f] = s.length > SNAP_FIELD_MAX_CHARS ? s.slice(0, SNAP_FIELD_MAX_CHARS) : s;
            kept += 1;
        });
        return kept ? out : null;
    }

    /**
     * 写入快照（fire-and-forget，失败静默）。调用方在 Detail.open 前顺手调用，
     * 传卡片已持有的展示字段；字段名统一为 pic/name/remarks/year（调用方各自
     * 完成映射，如 vod_pic→pic）。site/vodId 写进条目，回读时校验一致性。
     * @param {string} site 站点标识（Bangumi 详情传 ''，与 Detail.openBangumi 的 this.site 一致）
     * @param {string|number} vodId 影片/条目 ID
     * @param {{pic?:string, name?:string, remarks?:string, year?:string|number}} fields
     */
    function put(site, vodId, fields) {
        try {
            if (typeof localCacheSet !== 'function') return false;
            const s = String(site == null ? '' : site);
            const id = String(vodId == null ? '' : vodId);
            if (!id) return false; // 无 ID 无法定位，不写（配合 Detail.open 的 !vodId 守卫语义）
        const trimmed = _trimFields(fields);
        if (!trimmed) return false; // 一个可用字段都没有：写了也无 hero 可渲染
        // 本地缓存层（cache.js localCacheSet）对 need > 3MB 的条目已有静默拒收兜底；
        // 本模块白名单+截断使条目恒 ~2KB 量级，正常路径永不触达该阈值（L39）。
        return localCacheSet(snapKey(s, id), { site: s, vodId: id, ...trimmed, ts: Date.now() }, SNAP_TTL_MS);
        } catch (e) {
            return false; // 快照是优化，失败不影响主流程
        }
    }

    /**
     * 读取快照（结构校验 + site|vodId 一致性校验）。未命中/过期/畸形/键不一致
     * 一律返回 null——脏数据不得进入详情页渲染链路（对齐 home.js _catWinCacheGet 口径）。
     * 第二阶段由 detail.js open()/openBangumi() 调用；本阶段仅写入侧就绪。
     * @returns {{site:string, vodId:string, pic?:string, name?:string, remarks?:string, year?:string, ts:number}|null}
     */
    function get(site, vodId) {
        try {
            if (typeof localCacheGet !== 'function') return null;
            const s = String(site == null ? '' : site);
            const id = String(vodId == null ? '' : vodId);
            if (!id) return null;
            const d = localCacheGet(snapKey(s, id)); // 过期/未命中/解析失败均返回 null
            if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
            if (String(d.site || '') !== s || String(d.vodId || '') !== id) return null; // 键内容不一致不信任
            if (typeof d.ts !== 'number' || !isFinite(d.ts)) return null;
            const fields = _trimFields(d);
            if (!fields) return null;
            return { site: s, vodId: id, ...fields, ts: d.ts };
        } catch (e) {
            return null;
        }
    }

    /** 删除单个快照（当前仅备用：TTL 2h + localCacheClearAll 全清已覆盖失效语义）。 */
    function del(site, vodId) {
        try {
            if (typeof localCacheDel !== 'function') return;
            localCacheDel(snapKey(String(site == null ? '' : site), String(vodId == null ? '' : vodId)));
        } catch (e) { /* ignore */ }
    }

    // 挂全局：与 cache.js 同款 IIFE + root 导出惯例；第二阶段 detail.js 经
    // /* global */ 声明直接引用（无构建工具、<script defer> 顺序加载共享作用域）。
    root.DetailSnap = { put, get, del, key: snapKey, TTL_MS: SNAP_TTL_MS, PREFIX: SNAP_PREFIX };
})();
