/**
 * timeline.js — 番剧时间表（Bangumi 每日放送）
 *
 * 数据链路：POST /kazumi/action do=kazumiBangumiCalendar → 按星期分组渲染。
 * 卡片点击进详情（Bangumi 详情弹窗）。
 */
/* global $, doAction, escHtml, warnToast, showLoading, hideLoading, renderPagerBox, pageSizeOf, vodCoverImg, coverFadeIn */

const Timeline = {
    _inited: false,
    _calendar: [],      // 原始日历数据
    _weekday: 1,        // 当前选中星期（1-7）
    _season: '',        // 当前季度（YYYYQn）
    _page: 1,
    _pageSize: 20,

    async init() {
        if (this._inited) return;
        this._inited = true;
        $('#timeline-refresh').on('click', () => this.load());
        $('#timeline-weekdays').on('click', '.class-tab', (e) => {
            const wd = parseInt($(e.currentTarget).data('weekday'), 10);
            if (wd >= 1 && wd <= 7) {
                this._weekday = wd;
                this._page = 1;
                this._renderWeekdays();
                this._renderGrid();
            }
        });
        $('#timeline-season').on('change', () => {
            this._season = $('#timeline-season').val();
            this._page = 1;
            this._renderGrid();
        });
        await this.load();
    },

    async load() {
        showLoading();
        try {
            const rsp = await doAction('kazumiBangumiCalendar', {}, '/kazumi/action');
            this._calendar = (rsp && rsp.calendar) || [];
            this._buildSeasons();
            this._renderWeekdays();
            this._renderGrid();
        } catch (e) {
            warnToast('时间表载入失败');
        } finally {
            hideLoading();
        }
    },

    /** 从日历数据提取季度列表（去重，最新在前）。 */
    _buildSeasons() {
        const seasons = new Set();
        this._calendar.forEach((day) => {
            (day.items || []).forEach((item) => {
                if (item.air_date) {
                    const m = String(item.air_date).match(/^(\d{4})-(\d{2})/);
                    if (m) seasons.add(`${m[1]}Q${Math.ceil(parseInt(m[2], 10) / 3)}`);
                }
            });
        });
        const list = Array.from(seasons).sort().reverse();
        this._season = list[0] || '';
        const sel = $('#timeline-season').empty();
        list.forEach((s) => sel.append(`<option value="${s}"${s === this._season ? ' selected' : ''}>${s}</option>`));
    },

    _renderWeekdays() {
        const names = ['一', '二', '三', '四', '五', '六', '日'];
        const box = $('#timeline-weekdays').empty();
        for (let i = 1; i <= 7; i++) {
            box.append(`<span class="class-tab ${i === this._weekday ? 'active' : ''}" data-weekday="${i}">周${names[i - 1]}</span>`);
        }
    },

    async _renderGrid() {
        const size = await pageSizeOf('pageSizeHome'); // 复用首页每页条数
        this._pageSize = size;
        const day = this._calendar.find((d) => d.weekday && d.weekday.id === this._weekday);
        let items = (day && day.items) || [];
        // 季度筛选
        if (this._season) {
            items = items.filter((item) => {
                if (!item.air_date) return false;
                const m = String(item.air_date).match(/^(\d{4})-(\d{2})/);
                return m && `${m[1]}Q${Math.ceil(parseInt(m[2], 10) / 3)}` === this._season;
            });
        }
        const pagecount = Math.max(1, Math.ceil(items.length / size));
        const slice = items.slice((this._page - 1) * size, this._page * size);
        const grid = $('#timeline-grid').empty();
        if (!slice.length) {
            grid.html('<div class="tip-line">该日暂无番剧更新</div>');
        } else {
            slice.forEach((item) => {
                grid.append(this._renderCard(item));
            });
        }
        renderPagerBox($('#timeline-pager'), {
            page: this._page,
            pagecount,
            onJump: (pg) => { this._page = pg; this._renderGrid(); },
        });
    },

    _renderCard(item) {
        const name = item.name_cn || item.name || '';
        const cover = (item.images && (item.images.large || item.images.common || item.images.medium)) || '';
        const score = item.rating && item.rating.score ? `评分 ${item.rating.score}` : '';
        const air = item.air_date || '';
        return `<div class="vod-card bangumi-card" data-id="${item.id}" data-name="${escHtml(name)}" tabindex="0">
            <div class="vod-cover">${vodCoverImg(cover)}</div>
            <div class="vod-name" title="${escHtml(name)}">${escHtml(name)}</div>
            <div class="vod-remarks">${escHtml([air, score].filter(Boolean).join(' · '))}</div>
        </div>`;
    },
};
