/**
 * settings.js — 设置持久化（Phase 7.2）
 *
 * JSON 文件存于 <userData>/settings.json；简单键值（含嵌套对象），写即落盘。
 * 约定键：
 * - lastConfigUrl  最近一次成功加载的配置 URL（启动自动重载）
 * - danmaku        播放时是否加载弹幕（默认 true）
 * - playerVolume   mpv 默认音量（0-100，0 表示不设置）
 */
const fs = require('fs');
const path = require('path');

class Settings {
    constructor(dir) {
        this.file = path.join(dir, 'settings.json');
        this.userDataDir = dir;
        this._data = this._load();
    }

    _load() {
        try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
        catch (e) { return {}; }
    }

    /** mpv 硬盘缓存默认目录（<userData>/mpv-cache）；切到磁盘模式且未手动选过时使用。 */
    defaultCacheDir() {
        return path.join(this.userDataDir, 'mpv-cache');
    }

    all() { return { ...this._data }; }
    get(key) { return this._data[key]; }

    set(key, value) {
        this._data[key] = value;
        this._flush();
        return value;
    }

    _flush() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this._data, null, 2), 'utf8');
        } catch (e) { /* 写入失败仅本次会话生效 */ }
    }

    /** 恢复默认设置：清空偏好类键，保留用户数据类键（收藏/历史/已载入源等）。 */
    reset(keepKeys = []) {
        const kept = {};
        for (const k of keepKeys) {
            if (k in this._data) kept[k] = this._data[k];
        }
        this._data = kept;
        this._flush();
        return this.all();
    }
}

module.exports = Settings;
