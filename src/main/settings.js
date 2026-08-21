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

// 敏感键（凭据类）：落盘时经 electron safeStorage 加密（存为 enc:<base64>），
// 读取时自动解密；内存中始终为明文，settings.get/all 返回原值（渲染层无感知）。
// 旧版明文值读取兼容（无 enc: 前缀按明文处理，下次写盘自动转为密文）。
const SENSITIVE_KEYS = new Set(['dandanAppSecret', 'bangumiToken', 'webDavPassword']);
const ENC_PREFIX = 'enc:';

class Settings {
    constructor(dir) {
        this.file = path.join(dir, 'settings.json');
        this._data = this._load();
    }

    _load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            for (const k of Object.keys(data)) {
                if (SENSITIVE_KEYS.has(k)) data[k] = this._decrypt(data[k]);
            }
            return data;
        }
        catch (e) { return {}; }
    }

    /** 解密单个值：enc:<base64> → 明文；解密失败（换机器/凭据失效）返回原值。 */
    _decrypt(v) {
        if (typeof v !== 'string' || !v.startsWith(ENC_PREFIX)) return v;
        try {
            const { safeStorage } = require('electron');
            if (safeStorage && safeStorage.isEncryptionAvailable()) {
                return safeStorage.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64'));
            }
        } catch (e) { /* 解密失败按原值处理 */ }
        return v;
    }

    /** 加密单个值：敏感键非空字符串 → enc:<base64>；safeStorage 不可用时保持明文。 */
    _encrypt(k, v) {
        if (!SENSITIVE_KEYS.has(k) || typeof v !== 'string' || v === '') return v;
        try {
            const { safeStorage } = require('electron');
            if (safeStorage && safeStorage.isEncryptionAvailable()) {
                return ENC_PREFIX + safeStorage.encryptString(v).toString('base64');
            }
        } catch (e) { /* 加密失败保持明文 */ }
        return v;
    }

    all() { return { ...this._data }; }
    get(key) { return this._data[key]; }

    set(key, value) {
        this._data[key] = value;
        this._flush();
        return value;
    }

    delete(key) {
        if (key in this._data) { delete this._data[key]; this._flush(); }
    }

    _flush() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            // 落盘副本：敏感键加密后写盘（内存对象保持明文，get/all 仍返回原值）
            const out = {};
            for (const [k, v] of Object.entries(this._data)) out[k] = this._encrypt(k, v);
            fs.writeFileSync(this.file, JSON.stringify(out, null, 2), 'utf8');
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
