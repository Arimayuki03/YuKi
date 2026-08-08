/**
 * dl-record.js — 下载记录持久化（T46）
 *
 * aria2c 的 stopped 记录只存在其进程内存里，应用重启（或更换下载目录重启引擎）
 * 后完成/失败任务即丢失。本模块在任务完成/失败时把记录落盘到
 * <userData>/dl-records.json，推送任务列表时把「本会话不存在的持久化记录」补回
 * （按 gid 去重，会话内已有则不补），从而下载历史跨重启可见、可一键播放。
 *
 * 删除/清除任务时同步删除对应持久化记录，避免「删除后又复活」。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_RECORDS = 200; // 上限防无限增长，超出丢最旧

class DlRecordStore {
    constructor() {
        this._file = null; // 惰性解析（app.getPath 需在 ready 后调用，延迟到首次读写）
        this._records = [];
        this._loaded = false;
    }

    _filePath() {
        if (!this._file) {
            this._file = path.join(app.getPath('userData'), 'dl-records.json');
        }
        return this._file;
    }

    _load() {
        try {
            if (fs.existsSync(this._filePath())) {
                const data = JSON.parse(fs.readFileSync(this._filePath(), 'utf8'));
                if (Array.isArray(data)) return data;
            }
        } catch (e) { /* 损坏则重置 */ }
        return [];
    }

    /** 首次读写前懒加载（模块顶层的 app.getPath 不可靠，延迟到 ready 后的首次调用）。 */
    _ensureLoaded() {
        if (this._loaded) return;
        this._records = this._load();
        this._loaded = true;
    }

    _save() {
        try {
            fs.mkdirSync(path.dirname(this._filePath()), { recursive: true });
            const tmp = this._filePath() + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this._records, null, 2));
            fs.renameSync(tmp, this._filePath());
        } catch (e) { /* 落盘失败不阻断播放/下载 */ }
    }

    /** 记录一次任务完成/失败；同 gid 覆盖为最新（本会话内重复事件不产生重复记录）。 */
    add(record) {
        if (!record || !record.gid) return;
        this._ensureLoaded();
        this._records = this._records.filter((r) => r.gid !== record.gid);
        this._records.unshift(record);
        if (this._records.length > MAX_RECORDS) this._records.length = MAX_RECORDS;
        this._save();
    }

    /** 全部持久化记录（最新在前）。 */
    all() {
        this._ensureLoaded();
        return this._records.slice();
    }

    /** 删除单条记录（任务删除时调用，防复活）。 */
    remove(gid) {
        this._ensureLoaded();
        const before = this._records.length;
        this._records = this._records.filter((r) => r.gid !== gid);
        if (this._records.length !== before) this._save();
    }

    /** 清除全部记录（清空已完成任务时调用）。 */
    clear() {
        this._ensureLoaded();
        if (!this._records.length) return;
        this._records = [];
        this._save();
    }

    /** 删除全部失败记录（清空失败任务时调用，残留文件另由调用方删除）。 */
    clearErrors() {
        this._ensureLoaded();
        const before = this._records.length;
        this._records = this._records.filter((r) => r.status !== 'error');
        if (this._records.length !== before) this._save();
    }
}

module.exports = DlRecordStore;
