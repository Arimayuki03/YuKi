/**
 * ad-skip.js — 智能跳过片头/片尾（OP/ED skip）纯逻辑模块。
 *
 * YuKi 的 mpv 播放是主进程直连（URL 直接交 mpv），渲染层无法拦截媒体流，
 * 但可以通过 mpv 的 --start 起播参数与 <video> 预览元素实现跳过：
 *   1. 片头：本模块记录「某片名+线路」的片头结束秒数；下次起播时渲染层把
 *      position=秒*1000 传给 yuki.playUrl（FongMi 语义毫秒，主进程换算成
 *      mpv --start），实现起播即跳过片头；
 *   2. 片尾：<video> 预览兜底模式监听 timeupdate，接近记录的片尾点时
 *      seek 跳过并提示（mpv 模式由快进/右键菜单覆盖，见 player.js）；
 *   3. 记录：用户按快捷键 Shift+O / Shift+E（或点预览悬浮按钮）把当前
 *      时刻登记为该片名的片头/片尾位置，localStorage 持久化，
 *      同片名其他集（片头位置通常一致）直接复用。
 *
 * 误伤保护（宁可漏跳不错杀）：
 *   - 键带线路名（flag）：不同线路的片头分布可能不同，不跨线路套用；
 *   - 片头值仅在正片时长内且 >0 才应用；时长未知时只有片头记录本身
 *     可信（用户手动登记）才应用；
 *   - 片尾自动跳过只在「剩余时长 ≤ 阈值且 > 安全余量」的窗口内触发，
 *     且每集只触发一次，防止 seek 抖动循环。
 *
 * 存储键：localStorage['yuki_oped_skip_v1'] →
 *   { byKey: { '<title>|<flag>': { op, ed, ts } }, cap }
 * 独立于 cache.js 的 yuki_cache:: 命名空间：该命名空间被「清理缓存」
 * 整体删除，而片头/片尾记录是用户手工校准数据，不应被一键清掉。
 */
(function (root) {
    'use strict';

    const STORE_KEY = 'yuki_oped_skip_v1';
    const MAX_ENTRIES = 200; // 容量上限：超过后淘汰最旧记录，防 localStorage 无限增长

    // ── 存储层（可注入替身以便测试） ──────────────────────────────────

    function _ls() {
        try {
            const ls = root.localStorage;
            if (!ls) return null;
            const probe = '__yuki_oped_probe__';
            ls.setItem(probe, '1');
            ls.removeItem(probe);
            return ls;
        } catch (e) { return null; } // 隐私模式/禁用 localStorage：静默退化为不记忆
    }

    function _load(store) {
        const ls = store || _ls();
        if (!ls) return { byKey: {} };
        try {
            const raw = ls.getItem(STORE_KEY);
            if (!raw) return { byKey: {} };
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object' || !obj.byKey || typeof obj.byKey !== 'object') {
                return { byKey: {} };
            }
            return obj;
        } catch (e) {
            return { byKey: {} }; // 数据损坏：当作空库，绝不抛错影响播放
        }
    }

    function _save(data, store) {
        const ls = store || _ls();
        if (!ls) return false;
        try {
            ls.setItem(STORE_KEY, JSON.stringify(data));
            return true;
        } catch (e) { return false; }
    }

    // ── 键与记录（纯函数，导出供测试） ────────────────────────────────

    /**
     * 记录键：片名 + 线路。片头/片尾位置是「源」属性而非「番剧」属性——
     * 不同线路（不同压制/不同片源）的片头长度可能不同，跨线路套用会错跳，
     * 故键必须带 flag。title/flag 归一化为 trim 后拼接；
     * 分隔符 | 先替换为全角／：title/flag 本身含 | 时防键段碰撞
     * （如 title='A|B', flag='C' 与 title='A', flag='B|C' 原本会拼出同键）。
     */
    function opEdKey(title, flag) {
        return `${String(title || '').trim().replace(/\|/g, '／')}`
            + `|${String(flag || '').trim().replace(/\|/g, '／')}`;
    }

    function _clampSec(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        const sec = Math.round(n);
        if (sec <= 0 || sec > 3600) return null; // 0/负数/超 1 小时都不可信（误触/输错）
        return sec;
    }

    /**
     * 登记（新增或覆盖）片头/片尾记录。kind: 'op' | 'ed'。
     * @returns 更新后的记录对象；参数非法返回 null。
     */
    function recordOpEd(title, flag, kind, sec, store, now) {
        const key = opEdKey(title, flag);
        if (!key || key === '|') return null;
        const v = _clampSec(sec);
        if (v == null || (kind !== 'op' && kind !== 'ed')) return null;
        const data = _load(store);
        const prev = data.byKey[key] || {};
        const rec = {
            op: kind === 'op' ? v : (prev.op || null),
            ed: kind === 'ed' ? v : (prev.ed || null),
            ts: Number(now) || Date.now(),
        };
        data.byKey[key] = rec;
        // 容量淘汰：按 ts 淘汰最旧（本次写入的键先删后插，保证不被误淘汰）
        const keys = Object.keys(data.byKey);
        if (keys.length > MAX_ENTRIES) {
            keys.sort((a, b) => (data.byKey[a].ts || 0) - (data.byKey[b].ts || 0));
            while (keys.length > MAX_ENTRIES) delete data.byKey[keys.shift()];
        }
        _save(data, store);
        return rec;
    }

    /** 读取某片名+线路的记录；无则 null。 */
    function getOpEd(title, flag, store) {
        const key = opEdKey(title, flag);
        if (!key || key === '|') return null;
        return _load(store).byKey[key] || null;
    }

    /**
     * 跨线路提示查询：当前线路无记录时，找同片名其他线路的最新记录。
     * 返回 { flag, rec }（含兄弟线路名与记录）或 null。
     * 仅作提示来源（见 findSiblingHint）：不同压制线路的片头长度可能不同，
     * 调用方不得把该值直接当起播位置自动应用。
     */
    function findSiblingOpEd(title, flag, store) {
        const t = String(title || '').trim();
        if (!t) return null;
        const data = _load(store);
        const prefix = `${t}|`;
        const selfKey = opEdKey(title, flag);
        let best = null;
        for (const [k, rec] of Object.entries(data.byKey || {})) {
            if (!k.startsWith(prefix) || k === selfKey) continue;
            if (!rec || (rec.op == null && rec.ed == null)) continue;
            if (!best || (rec.ts || 0) > (best[1].ts || 0)) best = [k.slice(prefix.length), rec];
        }
        return best ? { flag: best[0], rec: best[1] } : null;
    }

    /**
     * 跨线路片头提示：同片名其他线路有片头记录时返回提示对象，
     * 供起播处 toast 提醒（不自动应用——不同压制线路片头长度可能不同，
     * 自动套用会错跳，用户可按提示 Shift+O 重新登记本线路片头）。
     * @returns { flag: string, sec: number } | null（sec 为兄弟线路片头秒数）
     */
    function findSiblingHint(title, flag, store) {
        const sib = findSiblingOpEd(title, flag, store);
        const op = sib ? _clampSec(sib.rec.op) : null;
        if (!sib || op == null) return null;
        return { flag: sib.flag, sec: op };
    }

    // ── 决策纯函数（导出供测试） ─────────────────────────────────────

    /**
     * 起播位置决策：返回应跳到的秒数（>0 表示 seek），0 表示从头播。
     *
     * 误伤保护：
     *   - 片头值必须 < duration - 30s：极端错值（如把片长当片头）时宁可
     *     从头播也不把正片跳掉大半；
     *   - duration 未知时仅信任用户手动登记的值（本模块只存手动登记，
     *     该分支防御未来接入自动来源的脏数据）；
     *   - position=0（用户显式想从头看）不覆盖。
     */
    function decideStartSec(opSec, durationSec) {
        const op = _clampSec(opSec);
        if (op == null) return 0;
        if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0) {
            // 留 30s 正片保护带：op 至少要离片尾 30s 以上才应用
            if (op >= durationSec - 30) return 0;
        }
        return op;
    }

    /**
     * 片尾自动跳过判定：进度 tick 时调用。
     * @param posSec    当前播放位置（秒）
     * @param durSec    总时长（秒）
     * @param edSec     记录的片尾起点（秒；片尾从该处开始）
     * @param opts      { leadSec: 提前量（默认 5s，提前一点避免看到片尾第一帧）,
     *                    guardSec: 片长下限（默认 300s，短视频/预览片不适用）,
     *                    marginSec: 距片尾最小间隔（默认 30s，太近说明已跳过或手动拖过） }
     * @returns 'skip'（应 seek 到 edSec）| 'toast'（提示即将进入片尾）| null
     *
     * 误伤保护：
     *   - durSec 未知、片长 < guardSec、edSec 不在正片区间内一律不触发；
     *   - 已越过 ed（pos >= ed + lead）不再触发（用户可能故意回拖看片尾）；
     *   - 只在 [ed - lead, ed) 的窗口内报 skip，窗口外（太早）报 toast。
     */
    function decideEdAction(posSec, durSec, edSec, opts) {
        const o = opts || {};
        const lead = (typeof o.leadSec === 'number') ? o.leadSec : 5;
        const guard = (typeof o.guardSec === 'number') ? o.guardSec : 300;
        const margin = (typeof o.marginSec === 'number') ? o.marginSec : 30;
        const pos = Number(posSec);
        const dur = Number(durSec);
        const ed = _clampSec(edSec);
        if (!Number.isFinite(pos) || pos < 0) return null;
        if (!Number.isFinite(dur) || dur <= 0) return null;
        if (ed == null) return null;
        // 片尾点必须离片头 30s 以上、离片尾 10s 以上（ed≈时长 时是误登记）
        if (ed < margin || ed > dur - 10) return null;
        // 短片不适用（预览/预告片跳片尾毫无意义还容易错杀正片）
        if (dur < guard) return null;
        if (pos >= ed + lead) return null;      // 已过片尾点：不再动作
        if (pos < ed - margin) return null;     // 离片尾还远：不动作
        if (pos >= ed - lead) return 'skip';    // 进入提前窗口：跳
        return 'toast';                          // 接近但未到：提示
    }

    /**
     * 起播后自动跳片头应使用的最终秒数：只信任同键（片名+线路）记录。
     * 不同压制线路的片头长度可能不同，跨线路值不自动应用——兄弟线路记录
     * 仅经 findSiblingHint 返回给起播处作 toast 提示，由用户决定是否登记。
     */
    function resolveAutoOpSec(title, flag, durationSec, store) {
        const rec = getOpEd(title, flag, store);
        return rec ? decideStartSec(rec.op, durationSec) : 0;
    }

    const AdSkip = {
        STORE_KEY,
        MAX_ENTRIES,
        opEdKey,
        recordOpEd,
        getOpEd,
        findSiblingOpEd,
        findSiblingHint,
        decideStartSec,
        decideEdAction,
        resolveAutoOpSec,
        // 测试替身注入点（内部使用）
        _load,
        _save,
    };

    root.AdSkip = AdSkip;
    root.YUKI = root.YUKI || {};
    root.YUKI.adSkip = AdSkip;
}(typeof window !== 'undefined' ? window : globalThis));
