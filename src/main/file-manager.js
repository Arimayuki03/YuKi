/**
 * file-manager.js — 本地文件管理（Phase 5）
 *
 * 职责：目录浏览 / 新建文件夹 / 复制上传 / 删除（文件与目录），
 * 所有操作经 resolveSafe() 做路径规范化 + 根目录白名单校验（防穿越）。
 *
 * 根目录（白名单）持久化在 <userData>/file-manager.json；
 * 未设置时 list 返回 { needRoot: true }，由渲染层引导选择。
 *
 * P2-7：delFolder 在白名单根（默认=下载目录）内可递归删除任意子树——补三道防线：
 * (a) 拒绝删除根目录本身（原有）；(b) 原生确认框二次确认（渲染层已有确认交互，
 * 此处为主进程最后防线——渲染层被注入时一次 IPC 调用即删整个媒体库）；(c) 在写
 * 互斥：目录下存在进行中的下载任务（持久化记录 active/waiting/paused）时拒绝删除。
 * electron/dialog 与活动任务探测经 opts 注入（本文件保持纯 Node 可单测；
 * index.js 装配时传入真实依赖）。
 */
const fs = require('fs');
const path = require('path');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.ts', '.flv', '.avi', '.mov', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm', '.m2ts']);
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.oga', '.opus', '.m4a', '.wma', '.ape']);

class FileManager {
    /**
     * @param {string} userDataPath 持久化目录
     * @param {object} [opts] 可选依赖注入
     * @param {(p: {type:string, title:string, message:string, detail:string, buttons:string[]})=>Promise<number>} [opts.confirm]
     *        原生确认框（返回所选按钮下标；缺省视为用户放弃，fail-closed）
     * @param {()=>Array<{dir?:string, status:string}>} [opts.getRecords]
     *        下载持久化记录提供者（在写互斥判定用）
     */
    constructor(userDataPath, opts = {}) {
        this._configPath = path.join(userDataPath, 'file-manager.json');
        this._confirm = typeof opts.confirm === 'function' ? opts.confirm : null;
        this._getRecords = typeof opts.getRecords === 'function' ? opts.getRecords : null;
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

    /** 判断目标目录内（含子树）是否有进行中的下载任务产物：
     *  持久化记录 active/waiting/paused 任务的 dir / 产物文件路径落在目标内即算。 */
    _hasActiveTaskUnder(dir) {
        let records;
        try { records = (this._getRecords && this._getRecords()) || []; } catch (e) { records = []; }
        const norm = (p) => {
            try { return path.resolve(String(p)).toLowerCase(); } catch (e) { return ''; }
        };
        const target = norm(dir);
        if (!target) return false;
        for (const r of records) {
            if (!r || !['active', 'waiting', 'paused'].includes(r.status)) continue;
            if (r.dir && norm(r.dir) === target) return true; // 任务级目录即目标本身（或子树根）
            for (const f of (r.files || [])) {
                if (!f || f === '.') continue;
                const fp = norm(f);
                if (!fp) continue;
                if (fp === target || fp.startsWith(target + path.sep)) return true;
            }
        }
        return false;
    }

    /** 删除目录（递归；拒绝删根目录自身）。
     *  P2-7 加固：原生确认框二次确认（主进程最后防线）+ 在写互斥（目录内有
     *  进行中的下载任务即拒绝）。确认框依赖未注入（单测/早期调用）时 fail-closed
     *  视为用户放弃——宁可少删，不可误删。 */
    async delFolder(rel) {
        const p = this.resolveSafe(rel);
        if (p === this.root) throw new Error('cannot delete root');
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('not a directory');
        // (c) 在写互斥：目标目录（含子树）内有进行中的下载任务 → 拒绝删除，
        //     避免边下边删造成产物损坏/任务异常
        if (this._hasActiveTaskUnder(p)) {
            throw new Error('folder has active downloads');
        }
        // (b) 原生确认框（最后防线）：渲染层已有确认交互，此处拦的是渲染层被注入/
        //     逻辑误传直发 IPC 的场景。列出将删除的目录绝对路径。
        if (this._confirm) {
            const choice = await this._confirm({
                type: 'warning',
                title: '删除文件夹',
                message: `确定要删除文件夹吗？`,
                detail: `将永久递归删除以下目录及其全部内容（不可恢复）：\n${p}`,
                buttons: ['删除', '取消'],
            });
            if (choice !== 0) throw new Error('delete cancelled');
        } else {
            throw new Error('delete cancelled: no confirm dialog');
        }
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
