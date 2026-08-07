/**
 * downloads.js — 下载管理视图
 *
 * 全部经主进程 IPC（window.vpc.download）操作 aria2c：
 * - init 惰性拉起 aria2c 并启动主进程 1s 轮询（vpc:dl-list 推送）
 * - 下载目录与并发数在「设置 → 下载」卡片维护（本页不再展示目录）
 * - 新增：HTTP/磁力链接（输入框，回车可加）或 .torrent/.metalink 文件
 * - 队列操作：暂停/继续/删除/清除已完成
 * - 一键播放：取任务产出中第一个视频文件 → mpv
 */
/* global $, warnToast, fmtSize, App, confirmDialog */

const STATUS_ZH = {
    active: '下载中', waiting: '等待中', paused: '已暂停',
    complete: '已完成', error: '错误', removed: '已移除',
};

const VIDEO_EXTS = ['.mp4', '.mkv', '.ts', '.flv', '.avi', '.mov', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm', '.m2ts'];

const Downloads = {
    _inited: false,
    _tasks: [],

    async enter() {
        if (!this._inited) await this.init();
    },

    async init() {
        this._inited = true;
        $('#dl-add').on('click', () => this.addUri());
        $('#dl-add-file').on('click', () => this.addFile());
        $('#dl-clear').on('click', () => this.clearDone());
        $('#dl-clear-failed').on('click', () => this.clearFailed());
        $('#dl-uri').on('keydown', (e) => { if (e.key === 'Enter') this.addUri(); });
        $('#dl-list').on('click', (e) => this.onAction(e));

        window.vpc.download.onList((items) => this.render(items));
        window.vpc.download.onEvent((ev) => {
            if (ev.type === 'completed') warnToast(`下载完成：${ev.task.name || ev.task.gid}`);
            if (ev.type === 'error') warnToast(`下载失败：${ev.task.name || ev.task.gid}`);
        });
        window.vpc.download.onGoto(() => App.showView('downloads'));

        const r = await window.vpc.download.control('init', {});
        if (!r.ok) {
            if (r.reason === 'aria2-missing') {
                this._tip('aria2c 未安装：在 video-pc 目录执行 node scripts/download-binaries.js aria2 后重启应用');
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

    async addUri() {
        const uri = $('#dl-uri').val().trim();
        if (!uri) return;
        // m3u8 切片流 aria2 无法处理，走 ffmpeg 合成通道
        const isM3u8 = /\.m3u8(\?|#|$)/i.test(uri.split('?')[0]);
        const r = await window.vpc.download.control(isM3u8 ? 'addHls' : 'add', { uri });
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
        const r = await window.vpc.download.control('addFile', {});
        if (!r.ok && r.reason && r.reason !== 'cancelled') warnToast(`新增失败：${r.reason}`);
        else if (r.ok) warnToast('已加入下载队列');
    },

    async clearDone() {
        const r = await window.vpc.download.control('clear', {});
        if (!r.ok) warnToast(`清除失败：${r.reason}`);
    },

    /** 删除全部失败任务及其未完成产物（会删磁盘上的残留文件，先确认）。 */
    async clearFailed() {
        const ok = await confirmDialog('删除所有失败任务？其未下载完成的残留文件也会一并删除。', { okText: '删除' });
        if (!ok) return;
        const r = await window.vpc.download.control('clearFailed', {});
        if (!r.ok) warnToast(`删除失败：${r.reason}`);
        else warnToast(r.n ? `已删除 ${r.n} 个失败任务` : '当前没有失败任务');
    },

    async onAction(e) {
        const btn = $(e.target).closest('[data-act]')[0];
        if (!btn) return;
        const gid = btn.getAttribute('data-gid');
        const act = btn.getAttribute('data-act');
        const task = this._tasks.find((t) => t.gid === gid);
        if (act === 'play') return this.play(task);
        if (act === 'remove' && !await confirmDialog('删除该下载任务？已下载的文件不会被删除。', { okText: '删除' })) return;
        window.vpc.download.control(act, { gid }).then((r) => {
            if (!r.ok) warnToast(`操作失败：${r.reason}`);
        });
    },

    async play(task) {
        if (!task || !task.files || !task.files.length) { warnToast('找不到输出文件'); return; }
        const video = task.files.find((f) => VIDEO_EXTS.includes('.' + f.split('.').pop().toLowerCase()));
        if (!video) { warnToast('输出文件中没有可播放的视频'); return; }
        const r = await window.vpc.download.play(video);
        if (!r.ok) {
            warnToast(r.reason === 'mpv-missing' ? 'mpv 未安装：node scripts/download-binaries.js mpv' : `播放失败：${r.reason}`);
        } else {
            warnToast('已在 mpv 窗口播放');
        }
    },

    // ------------------------------------------------------------ 渲染

    render(items) {
        this._tasks = items || [];
        const list = $('#dl-list');
        if (!this._tasks.length) {
            list.html('<div class="tip-line">暂无下载任务，粘贴链接或选择种子文件开始下载</div>');
            return;
        }
        this._tip('');
        list.html(this._tasks.map((t) => this._itemHtml(t)).join(''));
    },

    _itemHtml(t) {
        const status = STATUS_ZH[t.status] || t.status;
        const bar = t.status === 'complete' ? 100 : (t.percent || 0);
        const isHls = t.kind === 'hls';
        let info;
        if (t.status === 'error') {
            info = `<span style="color:var(--md-error);">${this._esc(t.errorMessage || '未知错误')}</span>`;
        } else if (isHls) {
            // ffmpeg 合成无字节进度，按播放列表时长折算百分比；时长探测失败则不显示恒 0 的百分比
            info = t.status === 'active' ? (t.percent ? `切片合成中 ${t.percent}%` : '切片合成中…') : (t.status === 'complete' ? '已完成' : '等待中');
        } else {
            info = `${fmtSize(t.done)} / ${fmtSize(t.total)}${t.total ? ` · ${t.percent}%` : ''}` +
              (t.status === 'active' ? ` · ${fmtSize(t.speed)}/s${t.connections ? ` · 连线 ${t.connections}` : ''}` : '');
        }
        let btns = '';
        if (t.status === 'active' || t.status === 'waiting') {
            // ffmpeg 合成任务不支持暂停
            btns = isHls ? '' : `<button class="md-btn" data-act="pause" data-gid="${t.gid}">暂停</button>`;
        } else if (t.status === 'paused') {
            btns = `<button class="md-btn md-btn-tonal" data-act="unpause" data-gid="${t.gid}">继续</button>`;
        } else if (t.status === 'complete') {
            btns = `<button class="md-btn md-btn-tonal" data-act="play" data-gid="${t.gid}">▶ 播放</button>`;
        }
        btns += `${btns ? ' ' : ''}<button class="md-btn" data-act="remove" data-gid="${t.gid}">删除</button>`;
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
