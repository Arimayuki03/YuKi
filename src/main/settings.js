/**
 * settings.js — 设置持久化（Phase 7.2）
 *
 * JSON 文件存于 <userData>/settings.json；简单键值（含嵌套对象），写即落盘。
 * 约定键：
 * - lastConfigUrl  最近一次成功加载的配置 URL（启动自动重载）
 * - danmakuEnable 播放时是否自动加载弹幕（默认关闭，panels.js「设置 → 播放」开关）
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
        let raw = null;
        try {
            raw = fs.readFileSync(this.file, 'utf8');
        } catch (e) {
            return {};   // 文件不存在 = 首次启动，正常
        }
        try {
            const data = JSON.parse(raw);
            for (const k of Object.keys(data)) {
                if (SENSITIVE_KEYS.has(k)) data[k] = this._decrypt(data[k]);
            }
            return data;
        } catch (e) {
            // 解析失败原样返回 {} 会把「文件损坏」静默降级成「全新安装」——
            // 收藏/历史/观看统计全部消失且用户无从知道发生过什么。这里至少把坏文件
            // 另存一份留证（可人工恢复），并在日志里显式告警。
            const bak = `${this.file}.corrupt-${Date.now()}`;
            try { fs.copyFileSync(this.file, bak); } catch (e2) { /* 备份失败不阻断启动 */ }
            console.error(`[settings] settings.json 解析失败，已按空配置启动；损坏文件备份为 ${bak}`);
            return {};
        }
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
        // 落盘副本：敏感键加密后写盘（内存对象保持明文，get/all 仍返回原值）
        const out = {};
        for (const [k, v] of Object.entries(this._data)) out[k] = this._encrypt(k, v);
        const json = JSON.stringify(out, null, 2);
        // 原子写：writeFileSync 是「truncate → 写入」两阶段，在这中间崩溃/断电/被
        // 强杀，settings.json 就是一份截断的非法 JSON，下次启动即触发 _load 的损坏
        // 分支——用户数据（收藏/历史/统计）全丢。改为写同目录临时文件 → fsync →
        // rename（同分区 rename 原子），任何时刻磁盘上要么旧内容要么新内容。
        // 与 dl-record.js 的既有范式保持一致。
        const tmp = `${this.file}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const fd = fs.openSync(tmp, 'w');
            try {
                fs.writeSync(fd, json);
                try { fs.fsyncSync(fd); } catch (e) { /* 部分文件系统不支持，忽略 */ }
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmp, this.file);
        } catch (e) {
            // 写失败仅本次会话生效（与原行为一致），但不能把残_tmp 留在目录里
            try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
        }
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
