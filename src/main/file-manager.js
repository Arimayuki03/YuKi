/**
 * file-manager.js — 本地文件管理（Phase 5）
 *
 * 职责：目录浏览 / 新建文件夹 / 复制上传 / 删除（文件与目录），
 * 所有操作经 resolveSafe() 做路径规范化 + 根目录白名单校验（防穿越）。
 *
 * 根目录（白名单）持久化在 <userData>/file-manager.json；
 * 未设置时 list 返回 { needRoot: true }，由渲染层引导选择。
 */
const fs = require('fs');
const path = require('path');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.ts', '.flv', '.avi', '.mov', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm', '.m2ts']);
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.oga', '.opus', '.m4a', '.wma', '.ape']);

class FileManager {
    constructor(userDataPath) {
        this._configPath = path.join(userDataPath, 'file-manager.json');
        this.root = this._loadRoot();
    }

    _loadRoot() {
        try {
            const cfg = JSON.parse(fs.readFileSync(this._configPath, 'utf8'));
            return cfg.root && fs.existsSync(cfg.root) ? path.resolve(cfg.root) : null;
        } catch (e) { return null; }
    }

    /** 设置白名单根目录并持久化。 */
    setRoot(dir) {
        const abs = path.resolve(String(dir || ''));
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
            throw new Error('root not a directory');
        }
        this.root = abs;
        fs.mkdirSync(path.dirname(this._configPath), { recursive: true });
        fs.writeFileSync(this._configPath, JSON.stringify({ root: abs }), 'utf8');
        return abs;
    }

    /**
     * 白名单校验：rel 相对根目录规范化后必须仍在根内。
     * rel 允许 '' / null（根自身）；拒绝 '..'、绝对路径、盘符跳转等穿越。
     */
    resolveSafe(rel) {
        if (!this.root) throw new Error('root not set');
        const p = path.resolve(this.root, String(rel || ''));
        if (p !== this.root && !p.startsWith(this.root + path.sep)) {
            throw new Error('path outside whitelist');
        }
        return p;
    }

    /** 浏览目录，返回格式与原 /file 占位一致：{parent, path, files:[{dir,name,time,path}]}。 */
    list(rel) {
        const dir = this.resolveSafe(rel);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            throw new Error('not a directory');
        }
        const relOf = (p) => path.relative(this.root, p);
        const parent = dir === this.root ? '.' : relOf(path.dirname(dir));
        const files = fs.readdirSync(dir, { withFileTypes: true })
            .map((e) => {
                const full = path.join(dir, e.name);
                let st = null;
                try { st = fs.statSync(full); } catch (err) { /* 无权限/失效项跳过时间 */ }
                return {
                    dir: e.isDirectory() ? 1 : 0,
                    name: e.name,
                    time: st ? new Date(st.mtimeMs).toLocaleString('zh-TW') : '',
                    path: relOf(full),
                };
            })
            .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh-Hant'));
        return { parent, path: relOf(dir), files };
    }

    /** 新建文件夹（名称内不允许分隔符与 ..）。 */
    newFolder(rel, name) {
        const n = String(name || '').trim();
        if (!n || /[\\/]/.test(n) || n === '.' || n === '..') throw new Error('invalid name');
        const dir = this.resolveSafe(path.join(String(rel || ''), n));
        fs.mkdirSync(dir);
        return path.relative(this.root, dir);
    }

    /** 删除文件（仅限白名单内的普通文件）。 */
    delFile(rel) {
        const p = this.resolveSafe(rel);
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('not a file');
        fs.unlinkSync(p);
    }

    /** 删除目录（递归；拒绝删根目录自身）。 */
    delFolder(rel) {
        const p = this.resolveSafe(rel);
        if (p === this.root) throw new Error('cannot delete root');
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('not a directory');
        fs.rmSync(p, { recursive: true, force: true });
    }

    isVideo(name) {
        return VIDEO_EXTS.has(path.extname(String(name || '')).toLowerCase());
    }

    isAudio(name) {
        return AUDIO_EXTS.has(path.extname(String(name || '')).toLowerCase());
    }

    /** 可交 mpv 播放的媒体文件（视频 + 音频）。 */
    isMedia(name) {
        const ext = path.extname(String(name || '')).toLowerCase();
        return VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext);
    }
}

module.exports = FileManager;
