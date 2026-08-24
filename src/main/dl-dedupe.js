/**
 * dl-dedupe.js — 同源同集下载去重（边下边播/手动下载共用）
 *
 * 问题：边下边播（simulDownload）在每次起播成功后都会把当前集追加进下载队列，
 * 重播/续播同一集会反复新建重复任务；详情页/Kazumi 手动批量下载同样无检测，
 * 且与边下边播互相叠加（同一集两条任务、两份文件）。
 *
 * 方案：以「站点|剧名(vodId)|集名」为稳定 key（直链带签名时效、跨会话变化，
 * 不能作 key）。入队时立即向 DlRecordStore 写一条携带 epKey 的完整记录，
 * 查重按记录状态判定：
 *   - complete 且产物文件仍在 → { state:'done', file }   （跳过）
 *   - active/waiting/paused 且任务仍存活     → { state:'downloading' }（跳过）
 *   - error / 文件已删 / 引擎中已无此任务的孤儿记录 → null（放行重下）
 * 记录删除沿用既有链路（remove/clearFailed/clear），去重状态随之自动失效——
 * 「清除列表」即允许重新下载，与用户直觉一致。
 *
 * 本模块不持有 Electron 依赖：store/liveProvider/fsExists 均注入，便于单测。
 */
const DEFAULT_FS = { existsSync: () => false };
let fsLike = DEFAULT_FS;

/** 单测注入 fs 替身；生产环境无需调用。 */
function setFs(impl) { fsLike = impl || DEFAULT_FS; }

/** 进行中状态集合（aria2 与 HLS 任务语义一致）。 */
const ACTIVE_STATES = ['active', 'waiting', 'paused'];

/**
 * 归一化并拼接去重 key。任一要素缺失返回 ''（信息不全不去重，兼容
 * 下载页手输 URL 等无上下文入口）。小写 + trim 抑制大小写/首尾空格差异。
 */
function buildKey(input) {
    const p = input || {};
    const s = String(p.site || '').trim().toLowerCase();
    const v = String(p.vod || '').trim().toLowerCase();
    const e = String(p.episode || '').trim().toLowerCase();
    if (!s || !v || !e) return '';
    return `${s}|${v}|${e}`;
}

class DlDedupe {
    /**
     * @param store DlRecordStore 实例（dl-record.js）
     * @param liveProvider async () => [{gid, status}] 当前引擎内全部任务
     *   （aria2 listAll + hls.list 的扁平合并）；仅在需要存活复核时调用。
     */
    constructor(store, liveProvider) {
        this.store = store;
        this.liveProvider = liveProvider || (async () => []);
        // gid → epKey 会话登记：入队到首次落盘记录之间以及后续改写记录时，
        // 用它把 epKey 回填进新记录（dlRecords.add 按 gid 整条替换）。
        this._keyByGid = new Map();
    }

    /** 入队成功后调用：登记 gid→epKey 并立即写一条可自恢复的初始记录。
     *  initialRecord 需含 kind/name/files/status/uri/header 等恢复字段（gid 缺省
     *  由本方法补齐）；后续 persistInProgress 会按真实进度覆盖同 gid 记录，
     *  epKey 经 stamp 保留。 */
    bind(gid, epKey, initialRecord) {
        if (!gid || !epKey) return;
        this._keyByGid.set(gid, epKey);
        this.store.add({ gid, ...initialRecord, epKey });
    }

    /** 给即将写入的记录补 epKey：优先取会话登记，其次取已有记录（跨重启后
     *  Map 为空但旧记录仍带 epKey，改写时不丢）。 */
    stamp(gid, existingRecord) {
        return (this._keyByGid.get(gid))
            || (existingRecord && existingRecord.epKey)
            || undefined;
    }

    /** gid 迁移（目录迁移重排/重启后恢复重新入队）：旧 gid 记录即将删除，
     *  把 epKey 转移到新 gid。 */
    carry(oldGid, newGid) {
        const key = oldGid ? this._keyByGid.get(oldGid) : '';
        let rec = null;
        if (!key && oldGid) {
            rec = this.store.all().find((r) => r.gid === oldGid);
        }
        const k = key || (rec && rec.epKey) || '';
        if (k && newGid) this._keyByGid.set(newGid, k);
        return k;
    }

    /** 任务被删除：清掉会话登记（持久化记录由调用方走 dlRecords.remove 删除）。 */
    drop(gid) { this._keyByGid.delete(gid); }

    /**
     * 查询某集的下载状态。命中返回 { state:'downloading' | 'done', file?, gid? }，
     * 未命中（允许重新下载）返回 null。epKey 为空直接 null。
     */
    async check(epKey) {
        if (!epKey) return null;
        // 最新在前：unshift 语义保证同名 key 命中的是最近一次任务
        const rec = this.store.all().find((r) => r.epKey === epKey);
        if (!rec) return null;
        if (rec.status === 'complete') {
            const file = (rec.files || []).find((f) => f && f !== '.' && fsLike.existsSync(f));
            // 成品文件已被手动清理 → 视为未下载，放行重下
            return file ? { state: 'done', file, gid: rec.gid } : null;
        }
        if (ACTIVE_STATES.includes(rec.status)) {
            // 孤儿记录防护：引擎里确无此任务（如重启后未恢复）不算下载中
            try {
                const live = await this.liveProvider();
                const t = (live || []).find((x) => x && x.gid === rec.gid);
                if (t && ACTIVE_STATES.includes(t.status)) {
                    return { state: 'downloading', gid: rec.gid };
                }
            } catch (e) { /* 引擎异常按未命中处理，不阻塞播放 */ }
        }
        return null; // error/removed 或孤儿记录 → 放行
    }
}

module.exports = { DlDedupe, buildKey, setFs, ACTIVE_STATES };
