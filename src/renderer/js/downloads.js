/**
 * downloads.js — 下载管理视图
 *
 * 全部经主进程 IPC（window.yuki.download）操作 aria2c：
 * - init 惰性拉起 aria2c 并启动主进程 1s 轮询（yuki:dl-list 推送）
 * - 下载目录与并发数在「设置 → 下载」卡片维护（本页不再展示目录）
 * - 新增：HTTP/磁力链接（输入框，回车可加）或 .torrent/.metalink 文件
 * - 队列操作：暂停/继续/删除/清除已完成
 * - 一键播放：取任务产出中第一个视频文件 → mpv
 */
/* global $, warnToast, fmtSize, App, confirmDialog, openDialog, closeDialog, localPlayToast */

const STATUS_ZH = {
    active: '下载中', waiting: '等待中', paused: '已暂停',
    complete: '已完成', error: '错误', removed: '已移除',
};

const VIDEO_EXTS = ['.mp4', '.mkv', '.ts', '.flv', '.avi', '.mov', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm', '.m2ts'];

const Downloads = {
    _inited: false,
    _tasks: [],
    _order: new Map(),   // gid → 首次出现序号（稳定显示顺序，见 render）
    _addedAt: new Map(), // gid → 首次出现/记录时间（按时间排序用）
    _sort: 'default',    // default 队列顺序 | name 名称 | time 最新在前

    async enter() {
        if (!this._inited) await this.init();
    },

    async init() {
        this._inited = true;
        $('#dl-add').on('click', () => this.addUri());
        $('#dl-add-file').on('click', () => this.addFile());
        $('#dl-open-dir').on('click', () => this.openDir());
        $('#dl-clear').on('click', () => this.clearDone());
        $('#dl-clear-failed').on('click', () => this.clearFailed());
        $('#dl-pause-all').on('click', () => this.pauseAll());
        $('#dl-resume-all').on('click', () => this.resumeAll());
        $('#dl-uri').on('keydown', (e) => { if (e.key === 'Enter') this.addUri(); });
        $('#dl-list').on('click', (e) => this.onAction(e));
        // 排序：默认（引擎队列序）/ 名称 / 最新添加；选择持久化，切换即按当前列表重排
        try { this._sort = localStorage.getItem('dl_sort') || 'default'; } catch (e) { /* ignore */ }
        $('#dl-sort').val(this._sort);
        $('#dl-sort').on('change', (e) => {
            this._sort = String(e.currentTarget.value || 'default');
            try { localStorage.setItem('dl_sort', this._sort); } catch (e2) { /* ignore */ }
            this.render(this._tasks);
        });

        window.yuki.download.onList((items) => this.render(items));
        window.yuki.download.onEvent((ev) => {
            if (ev.type === 'completed') warnToast(`下载完成：${ev.task.name || ev.task.gid}`);
            if (ev.type === 'error') warnToast(`下载失败：${ev.task.name || ev.task.gid}`);
        });
        window.yuki.download.onGoto(() => App.showView('downloads'));

        const r = await window.yuki.download.control('init', {});
        if (!r.ok) {
            if (r.reason === 'aria2-missing') {
                this._tip('aria2c 未安装：在 yuki 目录执行 node scripts/download-binaries.js aria2 后重启应用');
            } else {
                this._tip(`下载引擎启动失败：${r.reason}`);
            }
        }
    },

    _tip(msg) {
        if (!msg) { $('#dl-tip').hide(); return; }
        $('#dl-tip').text(msg).show();
    },

    // ------------------------------------------------------------ 操作

    async openDir() {
        try {
            const r = await window.yuki.download.openDir();
            if (!r || !r.ok) warnToast(`打开下载目录失败${r && r.reason ? `：${r.reason}` : ''}`);
        } catch (e) {
            warnToast('打开下载目录失败');
        }
    },

    async addUri() {
        const uri = $('#dl-uri').val().trim();
        // T40：空输入点新建也给反馈（此前静默无响应）
        if (!uri) { warnToast('请先在上方输入框粘贴视频链接'); $('#dl-uri').trigger('focus'); return; }
        // m3u8 切片流 aria2 无法处理，走 ffmpeg 合成通道
        const isM3u8 = /\.m3u8(\?|#|$)/i.test(uri.split('?')[0]);
        const r = await window.yuki.download.control(isM3u8 ? 'addHls' : 'add', { uri });
        if (!r.ok) {
            if (r.reason === 'ffmpeg-downloading') warnToast('ffmpeg 正在后台自动下载（约 90MB），完成后重试即可');
            else if (r.reason === 'aria2-missing' || r.reason === 'ffmpeg-missing') warnToast('下载引擎未就绪（启动时后台准备中，请稍后重试）');
            else warnToast(`新增失败：${r.reason}`);
            return;
        }
        $('#dl-uri').val('');
        warnToast('已加入下载队列');
    },

    async addFile() {
        const r = await window.yuki.download.control('addFile', {});
        if (!r.ok && r.reason && r.reason !== 'cancelled') warnToast(`新增失败：${r.reason}`);
        else if (r.ok) warnToast('已加入下载队列');
    },

    async clearDone() {
        // 仅从列表移除已完成任务，保留磁盘上已下载的文件
        if (!await confirmDialog('清除所有已完成任务？仅移除下载列表记录，已下载的文件会保留。', { okText: '清除' })) return;
        const r = await window.yuki.download.control('clear', {});
        if (!r.ok) warnToast(`清除失败：${r.reason}`);
        else warnToast('已清除完成列表（文件已保留）');
    },

    /** 删除全部失败任务及其未完成产物（会删磁盘上的残留文件，先确认）。 */
    async clearFailed() {
        const ok = await confirmDialog('删除所有失败任务？其未下载完成的残留文件也会一并删除。', { okText: '删除' });
        if (!ok) return;
        const r = await window.yuki.download.control('clearFailed', {});
        if (!r.ok) warnToast(`删除失败：${r.reason}`);
        else warnToast(r.n ? `已删除 ${r.n} 个失败任务` : '当前没有失败任务');
    },

    /** 全部暂停（aria2 任务与 m3u8 合成任务均支持）。 */
    async pauseAll() {
        const r = await window.yuki.download.control('pauseAll', {});
        if (!r.ok) warnToast(`全部暂停失败：${r.reason}`);
        else if (!r.n) warnToast('当前没有进行中的任务');
        else warnToast(`已暂停 ${r.n} 个任务`);
    },

    /** 全部开始（恢复所有已暂停任务）。 */
    async resumeAll() {
        const r = await window.yuki.download.control('unpauseAll', {});
        if (!r.ok) warnToast(`全部开始失败：${r.reason}`);
        else if (!r.n) warnToast('当前没有已暂停的任务');
        else warnToast(`已开始 ${r.n} 个任务`);
    },

    async onAction(e) {
        const btn = $(e.target).closest('[data-act]')[0];
        if (!btn) return;
        const gid = btn.getAttribute('data-gid');
        const act = btn.getAttribute('data-act');
        const task = this._tasks.find((t) => t.gid === gid);
        if (act === 'play') return this.play(task);
        if (act === 'remove') return this.removeTask(task);
        window.yuki.download.control(act, { gid }).then((r) => {
            if (!r.ok) warnToast(`操作失败：${r.reason}`);
            else if (r.resumed) warnToast('已恢复下载（任务已重新加入队列）');
        });
    },

    /** 删除任务：弹窗让用户选「仅移除任务（保留文件）」还是「连文件一起删除」。
     *  此前固定删文件且无选择；且进行中任务的分片临时目录/.aria2 控制文件有残留。 */
    async removeTask(task) {
        if (!task) return;
        const choice = await this._confirmRemove(task);
        if (!choice) return;
        const r = await window.yuki.download.control('remove', {
            gid: task.gid,
            deleteFiles: choice === 'files',
        });
        if (!r) { warnToast('删除失败'); return; }
        if (!r.ok) warnToast(`删除失败：${r.reason}`);
        else if (choice === 'files') warnToast('已删除任务及文件');
        else warnToast('已移除任务（文件保留在下载目录）');
    },

    /** 删除确认弹窗（三键：连文件删除 / 仅移除任务 / 取消）。返回 'files' | 'task' | null。
     *  resolve 挂 window 供 closeDialog 的 Esc 兜底按取消处理（同 confirmDialog 模式）。 */
    _confirmRemove(task) {
        return new Promise((resolve) => {
            const name = String((task && task.name) || (task && task.gid) || '');
            $('#dl_remove_name').text(name.length > 60 ? name.slice(0, 60) + '…' : name);
            window._dlRemoveResolve = (v) => {
                window._dlRemoveResolve = null;
                closeDialog('dlRemoveDialog');
                resolve(v);
            };
            openDialog('dlRemoveDialog');
        });
    },

    async play(task) {
        if (!task || !task.files || !task.files.length) { warnToast('找不到输出文件'); return; }
        let video = task.files.find((f) => VIDEO_EXTS.includes('.' + f.split('.').pop().toLowerCase()));
        // 无扩展名文件兜底：修复前的存量任务可能存出无后缀文件（新任务在主进程完成时
        // 已自动补 .mp4）——取唯一/首个无后缀文件交给 mpv 实际探测，不再直接拒绝
        if (!video) video = (task.files.length === 1) ? task.files[0]
            : task.files.find((f) => !/\.[a-z0-9]{1,5}$/i.test(f));
        if (!video) { warnToast('输出文件中没有可播放的视频'); return; }
        const r = await window.yuki.download.play(video);
        if (!r) { warnToast('播放失败'); return; }
        if (!r.ok) {
            warnToast(r.reason === 'mpv-missing' ? 'mpv 未安装：node scripts/download-binaries.js mpv' : `播放失败：${r.reason}`);
            return;
        }
        localPlayToast(r);
        // 记入历史记录（下载文件播放）：site='download' 保持「下载文件」身份，vodId 存绝对文件路径，
        // 历史卡据此异步抓帧封面（recCard 对 site='local'/'download' 打 data-local-path → fillLocalCovers）
        try {
            const name = String(video).split(/[\\/]/).pop() || video || '下载视频';
            if (typeof Records !== 'undefined' && Records.recordPlay && !window._incognito) {
                Records.recordPlay({
                    site: 'download',
                    siteName: '下载文件',
                    vodId: video,
                    name: name,
                    pic: '',
                    remarks: '下载文件',
                    episode: '',
                    seconds: 0,
                    totalEps: 0,
                }).catch(() => { /* 历史记录失败不影响播放 */ });
            }
        } catch (e) { /* ignore */ }
    },

    // ------------------------------------------------------------ 渲染

    render(items) {
        this._tasks = items || [];
        // 登记首次出现序号/时间：aria2 列表按 [active, waiting, stopped] 分组拼接，
        // 全部开始/暂停的 RPC 过渡期任务在分组间迁移，推送顺序短暂变化——
        // 卡片按「首次出现顺序」稳定排列，不再跟着跳动后再跳回
        const now = Date.now();
        for (const t of this._tasks) {
            if (!t || !t.gid) continue;
            if (!this._order.has(t.gid)) {
                this._order.set(t.gid, this._order.size);
                this._addedAt.set(t.gid, t.addedAt || now);
            }
        }
        // 清理已消失任务的登记（防 Map 无限增长；相对顺序不变）
        if (this._order.size > this._tasks.length * 2 + 50) {
            const live = new Set(this._tasks.map((t) => t.gid));
            for (const k of [...this._order.keys()]) {
                if (!live.has(k)) { this._order.delete(k); this._addedAt.delete(k); }
            }
        }
        // 排序：default 队列序（首次出现序）| name 名称 | time 最新在前
        if (this._sort === 'name') {
            this._tasks.sort((a, b) => String(a.name || a.gid).localeCompare(String(b.name || b.gid), 'zh-Hans-CN'));
        } else if (this._sort === 'time') {
            this._tasks.sort((a, b) => (this._addedAt.get(b.gid) || 0) - (this._addedAt.get(a.gid) || 0));
        } else {
            this._tasks.sort((a, b) => (this._order.get(a.gid) || 0) - (this._order.get(b.gid) || 0));
        }
        // 总网速（T15）：汇总进行中任务速度，空闲时也显示 0 B/s；必须早于下方提前返回
        const speed = this._tasks.reduce((a, t) => a + (t.status === 'active' ? (t.speed || 0) : 0), 0);
        $('#dl-speed').text(`总速度 ${fmtSize(speed)}/s`).show();
        const list = $('#dl-list');
        if (!this._tasks.length) {
            list.empty(); // 空列表留白，不显示引导文案（T11）
            this._fps = [];
            return;
        }
        this._tip('');
        // T31 性能：主进程每秒推送一次列表，无变化时跳过 DOM 重建；
        // gid 序列不变时按指纹只换有变化的条目，避免整列表 reflow 与封面/按钮状态丢失
        const fps = this._tasks.map((t) => this._fp(t));
        const prev = this._fps || [];
        const sameSeq = prev.length === fps.length && this._tasks.every((t, i) => (this._prevGids || [])[i] === t.gid);
        if (sameSeq && fps.every((f, i) => f === prev[i])) { this._prevGids = this._tasks.map((t) => t.gid); return; }
        if (sameSeq) {
            const children = list.children();
            fps.forEach((f, i) => {
                if (f !== prev[i]) children[i].outerHTML = this._itemHtml(this._tasks[i]);
            });
        } else {
            list.html(this._tasks.map((t) => this._itemHtml(t)).join(''));
        }
        this._fps = fps;
        this._prevGids = this._tasks.map((t) => t.gid);
    },

    /** 条目渲染指纹（T31）：影响 HTML 输出的字段集，全同则跳过该条目更新 */
    _fp(t) {
        return [t.gid, t.name, t.status, t.percent, t.done, t.total, t.speed, t.connections, t.errorMessage].join('|');
    },

    _itemHtml(t) {
        const status = STATUS_ZH[t.status] || t.status;
        const bar = t.status === 'complete' ? 100 : (t.percent || 0);
        const isHls = t.kind === 'hls';
        let info;
        if (t.status === 'error') {
            info = `<span style="color:var(--md-error);">${this._esc(t.errorMessage || '未知错误')}</span>`;
        } else if (isHls) {
            // ffmpeg 按播放列表时长折算百分比，并用输出 size 差分显示实时速度
            info = t.status === 'active'
                ? `${t.percent ? `切片合成中 ${t.percent}%` : '切片合成中…'} · ${fmtSize(t.speed || 0)}/s`
                : (t.status === 'complete' ? '已完成' : (t.status === 'paused' ? `已暂停（${t.percent || 0}%，继续时断点续传）` : '等待中'));
        } else {
            info = `${fmtSize(t.done)} / ${fmtSize(t.total)}${t.total ? ` · ${t.percent}%` : ''}` +
              (t.status === 'active' ? ` · ${fmtSize(t.speed)}/s${t.connections ? ` · 连线 ${t.connections}` : ''}` : '');
        }
        let btns = '';
        if (t.status === 'active' || t.status === 'waiting') {
            btns = `<button class="md-btn md-btn-tonal" data-act="pause" data-gid="${t.gid}">暂停</button>`;
        } else if (t.status === 'paused') {
            btns = `<button class="md-btn md-btn-tonal" data-act="unpause" data-gid="${t.gid}">继续</button>`;
        } else if (t.status === 'complete') {
            btns = `<button class="md-btn md-btn-tonal" data-act="play" data-gid="${t.gid}">▶ 播放</button>`;
        }
        btns += `${btns ? ' ' : ''}<button class="md-btn md-btn-tonal" data-act="remove" data-gid="${t.gid}">删除</button>`;
        return `<div class="dl-item">
            <div class="dl-item-top"><span class="dl-name" title="${this._esc(t.name)}">${this._esc(t.name || t.gid)}</span><span class="dl-status dl-st-${t.status}">${status}</span></div>
            <div class="dl-bar"><div class="dl-bar-fill" style="width:${bar}%;"></div></div>
            <div class="dl-item-bottom"><span>${info}</span><span>${btns}</span></div>
        </div>`;
    },

    _esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },
};

// 删除确认弹窗按钮（index.html 内联 onclick 调用；resolve 由 _confirmRemove 挂到 window）
function dlRemoveFiles() { if (window._dlRemoveResolve) window._dlRemoveResolve('files'); }
function dlRemoveTaskOnly() { if (window._dlRemoveResolve) window._dlRemoveResolve('task'); }
function dlRemoveCancel() { if (window._dlRemoveResolve) window._dlRemoveResolve(null); }

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.downloads = Downloads;
}(typeof window !== 'undefined' ? window : globalThis));
