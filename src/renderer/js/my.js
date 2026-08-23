/**
 * my.js — 「我的」页面（观看统计 + 我的收藏）
 *
 * 观看统计（settings.watchStats）：{ totalSeconds, sessionCount, titles, daily, bySite }
 *   - 累计观看时长（totalSeconds，秒）、观看次数（sessionCount）、观看部数（titles 键数）、近 30 天时长
 *   - 近 7 天每日时长条形图（daily：YYYY-MM-DD -> 秒）
 *   - 按星期分布（近 30 天，由 daily 聚合）
 *   - 分来源统计（bySite 全量累计；旧数据回退 history 最近 200 次）
 *   - 最常观看（watchStats.titles 次数，归一化近似重复片名后排名）
 * 我的收藏：复用 records.js makeRecordView 工厂（容器 #my-panel-favorites）。
 * 埋点在 player.js _recordWatch（mpv 退出时累计）。
 */
/* global $, makeRecordView, doAction, escHtml, vodCoverImg, warnToast, Kazumi, localCacheGet, localCacheSet, localCacheDel */

// Bangumi 账号收藏本地持久缓存（cache.js）：切页/重启即时上屏，只在收藏状态变动或手动同步时刷新。
// 无 TTL（0=永久）——账号收藏仅由「本地收藏变更(FavHub)/同步按钮」触发失效，不靠时间过期。
const MY_BGMCOL_KEY = 'my::bgmcol::v1';

const My = {
    _inited: false,
    _tab: 'stats',
    _favorites: null,

    init() {
        if (this._inited) return;
        this._inited = true;
        this._favorites = makeRecordView('my-favorites', 'favorites', '暂无收藏。打开影片详情页点“收藏”按钮即可添加。', true, true, 'pageSizeFavorites', '#my-panel-favorites');
        // 把 Bangumi 收藏合并进收藏网格（1.2/2.2）：_extra 在渲染时追加到本地收藏后统一展示/筛选
        this._favorites._extra = () => this._getBangumiItems();
        this._favorites.init();
        // 订阅收藏变更（Kazumi CollectController.loadCollectibles 模式）：
        // 详情页/收藏页任何收藏状态变更后，FavHub.changed 广播，此处失效并强制重拉 Bangumi 收藏持久缓存，
        // 再按需重渲染。持久缓存平时不靠时间过期，只在此处（收藏状态变动）与同步按钮处刷新。
        if (typeof FavHub !== 'undefined' && FavHub.onChanged) {
            this._unsubFav = FavHub.onChanged(async () => {
                this._bgmCache = null;                     // 失效内存缓存
                if (typeof localCacheDel === 'function') { try { localCacheDel(MY_BGMCOL_KEY); } catch (e) { /* ignore */ } }
                await this._getBangumiItems(true);         // 强制重拉并回写持久缓存（收藏状态已更新）
                if (typeof App === 'undefined' || App.currentView !== 'my') return;
                if (this._tab === 'favorites' && this._favorites) this._favorites.render();
                else if (this._tab === 'stats') this.render(); // 统计页「我的收藏」部数同步刷新
            });
        }
        $('#view-my').on('click', '[data-my-tab]', (e) => this.selectTab(String($(e.currentTarget).data('my-tab') || 'stats')));
        // 同步 Bangumi 按钮：先把本地可匹配收藏单向上传到账号，再拉取/合并远端收藏重渲染网格
        $('#my-favorites-bgm-sync').on('click', async () => {
            const token = (typeof Kazumi !== 'undefined' && Kazumi._getBangumiToken) ? await Kazumi._getBangumiToken() : '';
            if (!token) { warnToast('请先在 设置 → Kazumi 规则 → Bangumi 同步 保存 Token'); return; }
            // 弹出进度对话框（仿 Kazumi _BangumiSyncProgressDialog）
            My._openSyncProgress();
            // 上传本地收藏（匹配 → set 收藏类型 → 回写 bangumiId），单条失败不中断；onProgress 驱动进度条
            let up = null;
            if (typeof Kazumi !== 'undefined' && Kazumi.uploadFavoritesToBangumi) {
                try {
                    up = await Kazumi.uploadFavoritesToBangumi((done, total) => My._updateSyncProgress(done, total, '上传本地收藏'));
                } catch (e) { up = null; }
            }
            My._updateSyncProgress(0, 0, '拉取 Bangumi 收藏');
            this._bgmCache = null; // 失效缓存，强制重拉
            // 同步改变了 Bangumi 账号收藏：作废时间表的账号收藏缓存，下次进入时间表重拉最新过滤集合
            if (typeof Timeline !== 'undefined' && Timeline.invalidateColCache) Timeline.invalidateColCache();
            await this._getBangumiItems(true);
            if (this._favorites) await this._favorites.render();
            My._closeSyncProgress();
            if (up) warnToast(`已同步 Bangumi：上传 ${up.uploaded} · 跳过 ${up.skipped}${up.failed ? ` · 失败 ${up.failed}` : ''}`, { summary: true });
            else warnToast('已同步 Bangumi 收藏');
        });
        // 清空播放统计：确认后重置 watchStats 并刷新统计页
        $('#my-stats-clear').on('click', async () => {
            if (!await confirmDialog('清空全部播放统计数据？此操作不可撤销。', { okText: '清空' })) return;
            try {
                await window.yuki.settingsSet('watchStats', { totalSeconds: 0, sessionCount: 0, titles: {}, daily: {}, bySite: {} });
                this._renderStats(null, []);
                warnToast('已清空播放统计');
            } catch (e) { warnToast('清空失败'); }
        });
    },

    /** Bangumi 收藏（合并进收藏网格用）：拉取当前用户收藏，映射为收藏条目（site='bangumi'、tag 对应状态）。
     *  持久缓存（localStorage）：切页/重启即时上屏，不靠时间过期——只在收藏状态变动(FavHub)或
     *  点同步按钮时 force 重拉。force 之外命中缓存直接返回，避免每次进页面都等网络（加载慢/统计页收藏显示不出）。
     *  无 Token/失败返回空数组（不影响本地收藏展示）。 */
    async _getBangumiItems(force) {
        // 内存缓存优先（同一会话内多次渲染复用，最快）
        if (!force && Array.isArray(this._bgmCache)) return this._bgmCache;
        // 持久缓存命中：即时返回并回填内存；不触发网络（数据由收藏变更/同步显式刷新）
        if (!force && typeof localCacheGet === 'function') {
            try {
                const cached = localCacheGet(MY_BGMCOL_KEY);
                if (Array.isArray(cached)) { this._bgmCache = cached; this._bgmCacheTs = Date.now(); return cached; }
            } catch (e) { /* ignore */ }
        }
        try {
            const token = (typeof Kazumi !== 'undefined' && Kazumi._getBangumiToken) ? await Kazumi._getBangumiToken() : '';
            if (!token) {
                // 无 Token 只置空内存缓存（本会话不再展示账号收藏），不写持久缓存——
                // 此前 _saveBgmCol([]) 会把空列表永久落盘，用户后配 Token 时收藏页
                // 命中空持久缓存显示「暂无收藏」，需再手动同步一次才恢复。
                this._bgmCache = []; this._bgmCacheTs = Date.now();
                return [];
            }
            const rsp = await doAction('kazumiBangumiCollections', { token, all: 1 }, '/kazumi/action');
            const items = (rsp && rsp.items) || [];
            // Bangumi 收藏 type：1想看 2看过 3在看 4搁置 5抛弃
            const typeToTag = { 1: 'want', 2: 'seen', 3: 'watching', 4: 'hold', 5: 'dropped' };
            const mapped = items.map((it) => {
                const subj = it.subject || {};
                const name = subj.name_cn || subj.name || it.name || ('subject ' + it.subject_id);
                const cover = bangumiCover(subj.images, 'card');   // 收藏网格卡封面（T75）
                return {
                    site: 'bangumi',
                    siteName: 'Bangumi',
                    vodId: String(it.subject_id || ''),
                    name,
                    pic: cover,
                    remarks: '',
                    tag: typeToTag[it.type] || 'want',
                    bangumi: true,
                    ts: Date.now(),
                };
            });
            this._bgmCache = mapped;
            this._bgmCacheTs = Date.now();
            this._saveBgmCol(mapped);
            return mapped;
        } catch (e) {
            // 网络失败时优先返回内存/持久缓存，避免收藏网格与统计页部数空白
            if (Array.isArray(this._bgmCache)) return this._bgmCache;
            if (typeof localCacheGet === 'function') {
                try { const c = localCacheGet(MY_BGMCOL_KEY); if (Array.isArray(c)) return c; } catch (e2) { /* ignore */ }
            }
            return [];
        }
    },

    /** 写 Bangumi 账号收藏持久缓存（无 TTL，仅显式失效）。 */
    _saveBgmCol(list) {
        if (typeof localCacheSet !== 'function' || !Array.isArray(list)) return;
        try { localCacheSet(MY_BGMCOL_KEY, list, 0); } catch (e) { /* 缓存失败忽略 */ }
    },

    /** 作废 Bangumi 收藏缓存（内存 + 持久）并强制重拉，返回最新条目。
     *  设置页「Bangumi 同步」成功后调用——此前该入口只清内存缓存，_extra() 渲染
     *  时仍命中 localStorage 旧持久缓存，表现为「设置页同步后收藏页不刷新」。 */
    async refreshBangumi() {
        this._bgmCache = null;
        if (typeof localCacheDel === 'function') { try { localCacheDel(MY_BGMCOL_KEY); } catch (e) { /* ignore */ } }
        // 同步改变了账号收藏：时间表的收藏过滤集合一并作废
        if (typeof Timeline !== 'undefined' && Timeline.invalidateColCache) Timeline.invalidateColCache();
        return this._getBangumiItems(true);
    },

    async enter(tab) {
        this.init();
        if (tab) this._tab = tab;
        this.selectTab(this._tab, false);
        await this.render();
    },

    selectTab(tab, rerender = true) {
        this._tab = ['stats', 'favorites'].includes(tab) ? tab : 'stats';
        $('#view-my [data-my-tab]').removeClass('active');
        $(`#view-my [data-my-tab="${this._tab}"]`).addClass('active');
        $('#my-panel-stats').toggle(this._tab === 'stats');
        $('#my-panel-favorites').toggle(this._tab === 'favorites');
        if (rerender) this.render();
    },

    async render() {
        const s = (await window.yuki.settingsGet()) || {};
        if (this._tab === 'stats') {
            this._renderStats(s.watchStats || null, Array.isArray(s.history) ? s.history : []);
            // 我的收藏分类部数（本地 favorites + Bangumi 收藏合并计数）：仿 Kazumi _CollectHero
            await this._renderCollections(Array.isArray(s.favorites) ? s.favorites : []);
        } else {
            // 收藏页签：渲染本地收藏 + 合并的 Bangumi 收藏（_favorites._extra）
            await this._favorites.enter();
        }
    },

    // ---------------------------------------------------------------- 观看统计

    _renderStats(stats, history) {
        const total = (stats && stats.totalSeconds) || 0;
        const sessions = (stats && stats.sessionCount) || 0;
        const titles = (stats && stats.titles) ? Object.keys(stats.titles).length : 0;
        $('#my-stat-hours').text(this._fmtDur(total));
        $('#my-stat-sessions').text(sessions);
        $('#my-stat-titles').text(titles);
        // 近 30 天条形图数据源（含今天）：daily 只保留 30 天
        const daily = (stats && stats.daily) || {};
        // 顶部磁贴：近 30 天累计时长
        const weekTotal = Object.keys(daily).reduce((sum, k) => sum + (daily[k] || 0), 0);
        $('#my-stat-week').text(this._fmtDur(weekTotal));
        // 近 7 天条形图（含今天）
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            days.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, seconds: daily[key] || 0 });
        }
        const max = Math.max(1, ...days.map((d) => d.seconds));
        $('#my-stats-daily').html(days.map((d) => `
            <div class="my-bar-col" title="${escHtml(`${d.label} ${this._fmtDur(d.seconds)}`)}">
                <div class="my-bar" style="height:${Math.round(d.seconds / max * 100)}%"></div>
                <span class="my-bar-label">${escHtml(d.label)}</span>
            </div>`).join(''));
        this._renderWeekday(daily);
        this._renderSource(stats, history);
        this._renderTop(stats);
    },

    /** 我的收藏分类部数（看在看/想看/看过/抛弃/搁置 各多少部）。
     *  本地 favorites（tag 字段）+ Bangumi 收藏（type 1-5）合并计数，按 Bangumi 标签语义展示。
     *  自身重复条目（同一 bangumiId 本地与远端各有一条）按 bangumiId 去重，避免双计。 */
    async _renderCollections(localFavs) {
        const order = [
            { tag: 'watching', label: '在看' },
            { tag: 'want', label: '想看' },
            { tag: 'seen', label: '看过' },
            { tag: 'dropped', label: '抛弃' },
            { tag: 'hold', label: '搁置' },
        ];
        const counts = { watching: 0, want: 0, seen: 0, dropped: 0, hold: 0 };
        const seen = new Set(); // 按 bangumiId 去重
        // 本地收藏
        try {
            (localFavs || []).forEach((f) => {
                if (!f) return;
                const tag = (f.tag === undefined || f.tag === null) ? 'want' : f.tag;
                if (counts[tag] === undefined) return;
                const k = f.bangumiId ? 'bgm:' + f.bangumiId : ('loc:' + (f.uid || (f.site + '|' + f.vodId)));
                if (seen.has(k)) return;
                seen.add(k);
                counts[tag] += 1;
            });
        } catch (e) { /* ignore */ }
        // 远端 Bangumi 收藏（合并计数，按 subject_id 去重）
        try {
            const bgm = await this._getBangumiItems();
            const typeToTag = { 1: 'want', 2: 'seen', 3: 'watching', 4: 'hold', 5: 'dropped' };
            (bgm || []).forEach((it) => {
                const tag = typeToTag[it.tag] || it.tag;
                if (counts[tag] === undefined) return;
                const k = 'bgm:' + it.vodId;
                if (seen.has(k)) return;
                seen.add(k);
                counts[tag] += 1;
            });
        } catch (e) { /* 远端失败不影响本地计数 */ }
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        $('#my-stats-collections').html(
            `<div class="my-stats-coll-total">合计 <strong>${total}</strong> 部</div>` +
            `<div class="my-stats-coll-grid">${order.map((o) =>
                `<div class="my-stats-coll-box" data-tag="${escHtml(o.tag)}" title="${escHtml(o.label)}"><span class="my-stats-coll-num">${counts[o.tag]}</span><span class="my-stats-coll-lb">${escHtml(o.label)}</span></div>`
            ).join('')}</div>`
        );
    },

    /** 按星期分布（近 30 天，数据源 daily）：把每日时长按星期几聚合成 7 根柱。 */
    _renderWeekday(daily) {
        const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
        const buckets = [0, 0, 0, 0, 0, 0, 0]; // 索引 0..6 = 周一..周日
        Object.keys(daily).forEach((key) => {
            const parts = String(key).split('-');
            if (parts.length !== 3) return;
            const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
            if (isNaN(d.getTime())) return;
            const idx = (d.getDay() + 6) % 7; // JS getDay: 0=周日 → 归一到 周一=0
            buckets[idx] += daily[key] || 0;
        });
        const max = Math.max(1, ...buckets);
        $('#my-stats-weekday').html(buckets.map((sec, i) => `
            <div class="my-bar-col" title="${escHtml(`${names[i]} ${this._fmtDur(sec)}`)}">
                <div class="my-bar" style="height:${Math.round(sec / max * 100)}%"></div>
                <span class="my-bar-label">${escHtml(names[i])}</span>
            </div>`).join(''));
    },

    /** 分来源统计（累计时长）：优先用 watchStats.bySite（全量累计，无窗口）；
     *  旧数据无 bySite 时回退 history（最近 200 次播放）的 siteName/site + lastDuration，并明示口径。 */
    _renderSource(stats, history) {
        const bySite = (stats && stats.bySite) || {};
        let agg = {};
        let scope = '累计';
        if (Object.keys(bySite).length) {
            agg = bySite;
        } else {
            (history || []).forEach((h) => {
                const isPlay = (h && (h.kind === 'play' || (h.playCount || 0) > 0));
                const sec = Math.round((h && h.lastDuration) || 0);
                if (!isPlay || sec <= 0) return;
                const key = String(h.siteName || h.site || '未知来源');
                agg[key] = (agg[key] || 0) + sec;
            });
            scope = '最近 200 次播放';
        }
        $('#my-stats-source-tip').text(`分来源统计（${scope}·时长）`);
        const rows = Object.keys(agg).map((k) => ({ label: k, value: agg[k] }))
            .sort((a, b) => b.value - a.value).slice(0, 10);
        this._renderRankList('#my-stats-source', rows, (v) => this._fmtDur(v));
    },

    /** 最常观看（按观看次数）：watchStats.titles 记的是次数；先归一化近似重复键再排名。 */
    _renderTop(stats) {
        const titles = (stats && stats.titles) || {};
        const merged = {}; // normKey -> { label, value }
        Object.keys(titles).forEach((name) => {
            const norm = this._normTitle(name);
            if (!norm) return;
            const cnt = titles[name] || 0;
            if (!merged[norm]) merged[norm] = { label: name, value: 0 };
            merged[norm].value += cnt;
            // 显示名取更长的变体（通常信息更全，如带空格的正式名）
            if (name.length > merged[norm].label.length) merged[norm].label = name;
        });
        const rows = Object.keys(merged).map((k) => merged[k])
            .sort((a, b) => b.value - a.value).slice(0, 10);
        this._renderRankList('#my-stats-top', rows, (v) => `${v} 次`);
    },

    /** 归一化片名用于合并近似重复键（如「碧蓝之海 第三季」vs「碧蓝之海第三季」）：
     *  去除空白与常见分隔符、转小写。仅用于分组，不改变展示名。 */
    _normTitle(name) {
        return String(name || '').toLowerCase().replace(/[\s·・:：\-—_,，。.、!！?？]/g, '').trim();
    },

    /** 通用横向排行渲染：rows=[{label,value}]，fmt(value)->字符串。value 最大者为满条。 */
    _renderRankList(sel, rows, fmt) {
        const $el = $(sel);
        if (!rows || !rows.length) {
            $el.html('<div class="my-stats-empty">暂无数据</div>');
            return;
        }
        const max = Math.max(1, ...rows.map((r) => r.value));
        $el.html(rows.map((r) => `
            <div class="my-rank-row">
                <span class="my-rank-name" title="${escHtml(String(r.label))}">${escHtml(String(r.label))}</span>
                <span class="my-rank-track"><span class="my-rank-fill" style="width:${Math.round(r.value / max * 100)}%"></span></span>
                <span class="my-rank-val">${escHtml(fmt(r.value))}</span>
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

    // ---------------------------------------------- Bangumi 同步进度对话框
    /** 打开同步进度对话框（仿 Kazumi _BangumiSyncProgressDialog）。 */
    _openSyncProgress() {
        try {
            $('#bgm-sync-progress-text').text('准备同步 Bangumi 状态…');
            $('#bgmSyncProgressDialog .ss-fill').css('width', '0%');
            $('#bgm-sync-progress-count').text('');
            openDialog('bgmSyncProgressDialog');
        } catch (e) { /* ignore */ }
    },
    /** 更新同步进度（done/total 来自 uploadFavoritesToBangumi 的 onProgress 回调）。 */
    _updateSyncProgress(done, total, text) {
        try {
            if (text) $('#bgm-sync-progress-text').text(text);
            const t = Math.max(0, Number(total) || 0);
            const d = Math.max(0, Number(done) || 0);
            const pct = t > 0 ? Math.min(100, Math.round(d / t * 100)) : 0;
            $('#bgmSyncProgressDialog .ss-fill').css('width', pct + '%');
            $('#bgm-sync-progress-count').text(t > 0 ? `${d} / ${t}` : '');
        } catch (e) { /* ignore */ }
    },
    /** 关闭同步进度对话框。 */
    _closeSyncProgress() {
        try { closeDialog('bgmSyncProgressDialog'); } catch (e) { /* ignore */ }
    },
};

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.my = My;
}(typeof window !== 'undefined' ? window : globalThis));
