/**
 * my.js — 「我的」页面（观看统计 + 最近观看）
 *
 * 观看统计（settings.watchStats）：{ totalSeconds, sessionCount, titles, daily }
 *   - 累计观看时长（totalSeconds，秒）、观看次数（sessionCount）、观看部数（titles 键数）
 *   - 近 7 天每日时长条形图（daily：YYYY-MM-DD -> 秒）
 * 最近观看（settings.recentWatches）：[{site, vodId, name, pic, remarks, siteName, seconds, percent, ts}]
 *   - 最新在前，上限 50；有 site|vodId 的卡片点击进详情
 * 埋点在 player.js _recordWatch（mpv 退出时累计，见 player.js）。
 */
/* global $, escHtml, warnToast, Detail, vodCoverImg, renderPagerBox */

const My = {
    _inited: false,
    _page: 1,
    _size: 24, // 最近观看每页条数（固定，避免引入设置项）

    init() {
        if (this._inited) return;
        this._inited = true;
        // 最近观看卡片：有站点信息进详情，否则仅提示（Kazumi 等无 vodId 源）
        $('#view-my').on('click', '.vod-card', function (e) {
            const el = $(e.currentTarget).closest('.vod-card');
            const site = String(el.data('site') || '');
            const id = String(el.data('id') || '');
            const name = String(el.data('name') || '');
            if (site && id) Detail.open(site, id, name);
            else warnToast('该条目缺少站点信息，无法打开详情');
        });
    },

    async enter() {
        this.init();
        await this.render();
    },

    async render() {
        const s = (await window.vpc.settingsGet()) || {};
        this._renderStats(s.watchStats || null);
        this._renderRecent(Array.isArray(s.recentWatches) ? s.recentWatches : []);
    },

    // ---------------------------------------------------------------- 观看统计

    _renderStats(stats) {
        const total = (stats && stats.totalSeconds) || 0;
        const sessions = (stats && stats.sessionCount) || 0;
        const titles = (stats && stats.titles) ? Object.keys(stats.titles).length : 0;
        $('#my-stat-hours').text(this._fmtDur(total));
        $('#my-stat-sessions').text(sessions);
        $('#my-stat-titles').text(titles);
        // 近 7 天条形图（含今天）
        const daily = (stats && stats.daily) || {};
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            days.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, seconds: daily[key] || 0 });
        }
        const max = Math.max(1, ...days.map((d) => d.seconds));
        $('#my-stats-daily').html(days.map((d) => `
            <div class="my-bar-col" title="${d.label} ${this._fmtDur(d.seconds)}">
                <div class="my-bar" style="height:${Math.round(d.seconds / max * 100)}%"></div>
                <span class="my-bar-label">${d.label}</span>
            </div>`).join(''));
    },

    /** 秒数 → 「X 小时 Y 分」/「Y 分钟」/「Y 秒」。 */
    _fmtDur(sec) {
        sec = Math.max(0, Math.round(sec || 0));
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        if (h > 0) return `${h} 小时 ${m} 分`;
        if (m > 0) return `${m} 分钟`;
        return `${s} 秒`;
    },

    // ---------------------------------------------------------------- 最近观看

    _renderRecent(list) {
        const grid = $('#my-recent-grid');
        const pager = $('#my-recent-pager');
        if (!list.length) {
            grid.html('<div class="tip-line">暂无观看记录。播放任意影片后会自动出现在这里。</div>');
            pager.empty();
            return;
        }
        const pagecount = Math.ceil(list.length / this._size);
        this._page = Math.min(Math.max(1, this._page), pagecount);
        const slice = list.slice((this._page - 1) * this._size, this._page * this._size);
        grid.html(slice.map((v) => this._recentCard(v)).join(''));
        if (pagecount > 1) {
            renderPagerBox(pager, { page: this._page, pagecount, onJump: (pg) => { this._page = pg; this.render(); } });
        } else {
            pager.empty();
        }
    },

    /** 最近观看卡片：封面 + 片名 + 集名 + 观看进度条 + 时长。 */
    _recentCard(v) {
        const duration = this._fmtDur(v.seconds);
        const progress = (v.percent != null && v.percent > 0)
            ? `<div class="rec-progress" title="观至 ${v.percent}%">
                 <div class="rec-progress-bar" style="width:${Math.min(100, Math.round(v.percent))}%"></div>
               </div>`
            : '';
        return `<div class="vod-card" data-site="${escHtml(v.site || '')}" data-id="${escHtml(v.vodId || '')}" data-name="${escHtml(v.name)}" tabindex="0">
            <div class="vod-cover">${vodCoverImg(v.pic)}${v.siteName ? `<span class="rec-site" title="来源：${escHtml(v.siteName)}">源：${escHtml(v.siteName)}</span>` : ''}
                <span class="my-watch-dur">${escHtml(duration)}</span>
            </div>
            <div class="vod-name" title="${escHtml(v.name)}">${escHtml(v.name)}</div>
            <div class="vod-remarks">${escHtml(v.remarks || '')}</div>
            ${progress}
        </div>`;
    },
};
