/**
 * detail.js — 详情页（Phase 2）
 *
 * doAction('detailContent', {site, ids}) → list[0] 渲染视频信息；
 * 解析 vod_play_from / vod_play_url（$$$ 分源、# 分集、$ 名址分隔），
 * 线路切换 + 选集，集数点击交给 Player.play()。
 */
/* global $, doAction, escHtml, stripHtml, normalizePic, warnToast, showLoading, hideLoading, registerEsc, openDialog, closeDialog, App, Player, Records */

const Detail = {
    site: '',
    vodId: '',
    backView: 'home',
    sources: [],
    activeSource: 0,
    _epDesc: false, // 选集展示顺序（false=正序 true=倒序；会话内跨影片保持）
    _escBound: false,
    _lastVod: null, // 最近一次渲染的 vod 数据（收藏/标记/重试用）

    init() {
        if (this._escBound) return;
        this._escBound = true;
        $('#detail-back').on('click', () => this.back());
        $('#detail-body')
            .on('click', '.play-src', (e) => {
                const idx = parseInt($(e.currentTarget).data('idx'), 10);
                this.selectSource(idx);
            })
            .on('click', '.ep-btn', (e) => {
                const el = $(e.currentTarget);
                const idx = parseInt(el.data('idx'), 10);
                this._playEpisode(idx);
            })
            // 封面点击放大：原图保留在原位，另开全屏浮层（滚轮缩放，点击关闭）
            .on('click', '.detail-cover img', (e) => {
                this._openCoverFloat($(e.currentTarget).attr('src'));
            })
            // 选集勾选（批量下载用）：阻止冒泡避免触发播放
            .on('click', '.ep-check', (e) => {
                e.stopPropagation();
                $(e.currentTarget).toggleClass('checked');
                this._syncDlBar();
            })
            // 单集快捷下载
            .on('click', '.ep-dl-one', (e) => {
                e.stopPropagation();
                const idx = parseInt($(e.currentTarget).data('idx'), 10);
                this._downloadEps(this.sources[this.activeSource], [idx]);
            })
            // 全选 / 下载勾选集
            .on('change', '#ep-check-all', (e) => {
                $('#ep-list .ep-check').toggleClass('checked', e.currentTarget.checked);
                this._syncDlBar();
            })
            .on('click', '#ep-dl-selected', () => this.downloadSelected())
            // 选集正序/倒序切换
            .on('click', '#ep-order', () => this.toggleEpOrder())
            // 播放勾选集：勾选的多集一次性加入 mpv 播放列表顺序连播
            .on('click', '#ep-play-selected', () => this.playSelected())
            // 收藏切换
            .on('click', '#detail-fav', () => this.toggleFav())
            // 想看/已看：未收藏先收藏再置标签；已高亮的按钮再点一次取消标记
            .on('click', '#detail-tag-want', () => this.setTag('want'))
            .on('click', '#detail-tag-seen', () => this.setTag('seen'));
        // Esc 返回（全局派发，详情激活时消费）
        registerEsc(() => {
            if (App.currentView === 'detail') { this.back(); return true; }
            return false;
        });
    },

    open(site, vodId, fallbackName) {
        if (!site || !vodId) { warnToast('缺少站点或视频 ID'); return; }
        this.backView = App.currentView === 'detail' ? this.backView : App.currentView;
        this.site = site;
        this.vodId = vodId;
        this.vodName = fallbackName || '';
        App.showView('detail');
        this.load();
    },

    back() {
        App.showView(this.backView || 'home');
    },

    /** 封面放大：原图不动，全屏浮层展示；滚轮放大/缩小，点击任意处关闭。 */
    _openCoverFloat(src) {
        if (!src) return;
        let wrap = document.getElementById('cover-float');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'cover-float';
            wrap.innerHTML = '<img referrerpolicy="no-referrer" alt="">';
            document.body.appendChild(wrap);
            wrap.addEventListener('click', () => wrap.classList.remove('show'));
            // 滚轮缩放：按步长渐进调整宽度（160px ~ 95% 窗口宽）
            wrap.addEventListener('wheel', (ev) => {
                ev.preventDefault();
                const img = wrap.firstChild;
                const cur = img.getBoundingClientRect().width;
                const next = Math.max(160, Math.min(window.innerWidth * 0.95, cur * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
                img.style.width = next + 'px';
            }, { passive: false });
        }
        const img = wrap.firstChild;
        img.removeAttribute('style'); // 清掉上次滚轮缩放残留的内联宽度
        img.src = src;
        wrap.classList.add('show');
    },

    async load() {
        showLoading();
        $('#detail-body').html('<div class="tip-line">载入中…</div>');
        try {
            const data = await doAction('detailContent', { site: this.site, ids: JSON.stringify([this.vodId]) });
            const vod = (data && data.list && data.list[0]) || null;
            if (!vod) { $('#detail-body').html('<div class="tip-line">未取得详情</div>'); return; }
            if (vod.vod_name) this.vodName = vod.vod_name;
            // 打开详情即记入播放历史（同片去重置顶；记录源+封面供收藏/历史页展示）；
            // 隐身模式（设置页开关）下不记录
            if (typeof Records !== 'undefined' && !window._incognito) {
                Records.addHistory({
                    site: this.site, vodId: this.vodId,
                    name: vod.vod_name || this.vodName, pic: vod.vod_pic, remarks: vod.vod_remarks,
                    siteName: this._siteName(this.site),
                });
            }
            this.sources = this.parsePlay(vod);
            this.activeSource = 0;
            await this._restoreLastSource();
            this.render(vod);
        } catch (e) {
            $('#detail-body').html('<div class="tip-line">详情载入失败</div>');
            warnToast('详情载入失败');
        } finally {
            hideLoading();
        }
    },

    parsePlay(vod) {
        const froms = String(vod.vod_play_from || '').split('$$$').filter(Boolean);
        const urls = String(vod.vod_play_url || '').split('$$$');
        return froms.map((from, i) => ({
            from,
            episodes: String(urls[i] || '').split('#').filter(Boolean).map((e) => {
                const idx = e.indexOf('$');
                return idx > 0 ? { name: e.slice(0, idx), url: e.slice(idx + 1) } : { name: e, url: e };
            }),
        })).filter((s) => s.episodes.length);
    },

    metaLine(vod) {
        const bits = [vod.type_name, vod.vod_year, vod.vod_area, vod.vod_remarks].filter(Boolean);
        return bits.map(escHtml).join(' · ');
    },

    /** 简介文本 → 段落数组：先按换行拆；无换行的超长段按句末标点切分再
     *  贪心合并（每段约 140 字），避免一整块粘连看不清。 */
    _paras(text) {
        const raw = String(text).split(/\n+/).map((t) => t.trim()).filter(Boolean);
        const out = [];
        for (const seg of raw) {
            if (seg.length <= 160) { out.push(seg); continue; }
            const sents = seg.split(/(?<=[。！？!?；;])\s*/).filter(Boolean);
            let buf = '';
            for (const s of sents) {
                if (buf && buf.length + s.length > 140) { out.push(buf); buf = s; }
                else buf += s;
            }
            if (buf) out.push(buf);
        }
        return out;
    },

    render(vod) {
        this._lastVod = vod;
        // 封面标签统一由 common.js vodCoverImg 生成（T31：无图时显兜底占位图）
        // 源数据简介常带 <p>/<br> 等 HTML 标签：剥离后自动分段（含无换行超长段的按句拆分）
        // 简介置于封面右侧信息栏（导演/演员之下），带「简介」标签
        const descText = stripHtml(vod.vod_content);
        let desc = '';
        if (descText) {
            const paras = this._paras(descText).map((t) => `<p>${escHtml(t)}</p>`).join('');
            desc = `<div class="detail-desc-label">简介</div><div class="detail-desc">${paras}</div>`;
        }
        let html = `
        <div class="detail-head">
            <div class="detail-cover">${vodCoverImg(vod.vod_pic)}</div>
            <div class="detail-info">
                <div class="detail-title">${escHtml(vod.vod_name || this.vodName)}</div>
                <div class="detail-meta">${this.metaLine(vod)}</div>
                ${vod.vod_director ? `<div class="detail-sub">导演：${escHtml(vod.vod_director)}</div>` : ''}
                ${vod.vod_actor ? `<div class="detail-sub">演员：${escHtml(vod.vod_actor)}</div>` : ''}
                ${desc}
                <div class="detail-actions"><button id="detail-fav" class="md-btn md-btn-tonal md-btn-sm">☆ 收藏</button><button id="detail-tag-want" class="md-btn md-btn-tonal md-btn-sm">想看</button><button id="detail-tag-seen" class="md-btn md-btn-tonal md-btn-sm">已看</button></div>
            </div>
        </div>`;

        this._refreshFavBtn();
        this._refreshTagBtns();

        if (!this.sources.length) {
            html += '<div class="tip-line">该视频暂无播放源</div>';
            $('#detail-body').html(html);
            return;
        }
        html += `<div class="play-srcs">${this.sources.map((s, i) =>
            `<span class="play-src ${i === this.activeSource ? 'active' : ''}" data-idx="${i}">${escHtml(s.from)} (${s.episodes.length})</span>`).join('')}</div>`;
        // 全选/勾选操作栏紧跟视频源按钮（T19）；倒序按钮置播放勾选集左侧、同款样式（T21）
        html += `<div class="ep-dl-bar">
            <label class="ep-dl-check-all"><input type="checkbox" id="ep-check-all">全选</label>
            <span class="dl-spacer"></span>
            <span class="ep-dl-count" id="ep-dl-count"></span>
            <button id="ep-order" class="md-btn md-btn-tonal md-btn-sm"></button>
            <button id="ep-play-selected" class="md-btn md-btn-tonal md-btn-sm">▶ 播放勾选集</button>
            <button id="ep-dl-selected" class="md-btn md-btn-tonal md-btn-sm">⬇ 下载勾选集</button>
        </div>`;
        html += `<div class="ep-toolbar"><span class="ep-count" id="ep-count"></span></div>`;
        html += '<div id="ep-list" class="ep-grid"></div>';
        $('#detail-body').html(html);
        this.renderEpisodes();
    },

    /** 站点 key → 可读源名（收藏/历史卡片展示用，取不到时回退 key）。 */
    _siteName(key) {
        try {
            const all = (typeof Home !== 'undefined' && Home._allSites) || [];
            const s = all.find((x) => x.key === key);
            return (s && s.name) || key;
        } catch (e) { return key; }
    },

    /** 收藏按钮状态同步。 */
    async _refreshFavBtn() {
        if (typeof Records === 'undefined') return;
        const fav = await Records.isFavorite(this.site, this.vodId);
        $('#detail-fav').text(fav ? '★ 已收藏（点击取消）' : '☆ 收藏');
    },

    /** 想看/已看按钮高亮同步（未收藏两键均不亮）。 */
    async _refreshTagBtns() {
        if (typeof Records === 'undefined') return;
        const tag = await Records.getFavTag(this.site, this.vodId);
        $('#detail-tag-want').toggleClass('tag-active', tag === 'want');
        $('#detail-tag-seen').toggleClass('tag-active', tag === 'seen');
    },

    /** 标记想看/已看：未收藏先收藏再置标签；点击已生效的按钮则取消标记。 */
    async setTag(tag) {
        if (typeof Records === 'undefined') return;
        const vod = this._lastVod;
        if (!vod) return;
        const cur = await Records.getFavTag(this.site, this.vodId);
        const next = (cur === tag) ? '' : tag; // 再点一次 = 取消
        await Records.setFavTag({
            site: this.site, vodId: this.vodId,
            name: vod.vod_name || this.vodName, pic: vod.vod_pic, remarks: vod.vod_remarks,
            siteName: this._siteName(this.site),
        }, next);
        if (next === '') warnToast('已取消想看/已看标记');
        else warnToast(next === 'seen' ? '已标记为已看（并加入收藏）' : '已标记为想看（并加入收藏）');
        this._refreshFavBtn();
        this._refreshTagBtns();
    },

    /** 收藏/取消收藏当前影片。 */
    async toggleFav() {
        const vod = this._lastVod;
        if (!vod || typeof Records === 'undefined') return;
        const added = await Records.toggleFavorite({
            site: this.site, vodId: this.vodId,
            name: vod.vod_name || this.vodName, pic: vod.vod_pic, remarks: vod.vod_remarks,
            siteName: this._siteName(this.site),
        });
        warnToast(added ? '已收藏，可在“收藏”页查看' : '已取消收藏');
        this._refreshFavBtn();
    },

    selectSource(idx) {
        if (idx < 0 || idx >= this.sources.length) return;
        this.activeSource = idx;
        $('#detail-body .play-src').removeClass('active');
        $(`#detail-body .play-src[data-idx="${idx}"]`).addClass('active');
        this.renderEpisodes();
        // 记住本次选择的线路（按影片 key 持久化，下次进入同片自动恢复）
        this._saveLastSource();
    },

    /** 持久化当前影片最后使用的线路索引。 */
    async _saveLastSource() {
        if (!this.site || !this.vodId) return;
        try {
            const s = (await window.vpc.settingsGet()) || {};
            const map = (s.lastSourceMap && typeof s.lastSourceMap === 'object') ? s.lastSourceMap : {};
            map[`${this.site}|${this.vodId}`] = this.activeSource;
            await window.vpc.settingsSet('lastSourceMap', map);
        } catch (e) { /* 保存失败不影响主流程 */ }
    },

    /** 恢复上次使用的线路索引；未记录或索引越界则保持默认 0。 */
    async _restoreLastSource() {
        if (!this.site || !this.vodId) return;
        try {
            const s = (await window.vpc.settingsGet()) || {};
            const map = (s.lastSourceMap && typeof s.lastSourceMap === 'object') ? s.lastSourceMap : {};
            const idx = map[`${this.site}|${this.vodId}`];
            if (typeof idx === 'number' && idx >= 0 && idx < this.sources.length) {
                this.activeSource = idx;
            }
        } catch (e) { /* 读取失败使用默认值 */ }
    },

    /** 播放当前线路的指定集；失败自动尝试下一线路，直到成功或全部线路耗尽。 */
    async _playEpisode(idx) {
        const src = this.sources[this.activeSource];
        if (!src) return;
        const ep = src.episodes[idx];
        if (!ep) return;
        const startSrc = this.activeSource;
        let tried = 0;
        while (tried < this.sources.length) {
            const curSrc = this.sources[this.activeSource];
            const curEp = curSrc.episodes[idx];
            if (!curEp) { this._advanceSource(); tried++; continue; }
            if (tried > 0) {
                warnToast(`线路「${curSrc.from}」尝试中…`);
                // 切换线路时同步更新 UI 标签
                $('#detail-body .play-src').removeClass('active');
                $(`#detail-body .play-src[data-idx="${this.activeSource}"]`).addClass('active');
                this.renderEpisodes();
                this._saveLastSource();
            }
            const result = await Player.play(
                this.site, curSrc.from, curEp.url,
                this.vodName || '', curEp.name,
                curSrc.episodes, idx,
            );
            if (result && result.ok) return; // 起播成功
            // mpv 缺失是全局问题，换线路也没用
            if (result && result.reason === 'mpv-missing') return;
            // 其余失败（解析失败/取地址失败等）自动尝试下一线路
            this._advanceSource();
            tried++;
        }
        warnToast(`全部 ${this.sources.length} 条线路均播放失败`);
        // 恢复到最初选择的线路
        if (this.activeSource !== startSrc) {
            this.selectSource(startSrc);
        }
    },

    /** 切换到下一条线路（循环）。 */
    _advanceSource() {
        if (this.sources.length <= 1) return;
        this.activeSource = (this.activeSource + 1) % this.sources.length;
    },

    /** 选集正序/倒序切换（按钮文案表示点击后的目标方向）。 */
    toggleEpOrder() {
        this._epDesc = !this._epDesc;
        this.renderEpisodes();
    },

    renderEpisodes() {
        const src = this.sources[this.activeSource];
        const box = $('#ep-list').empty();
        if (!src) return;
        $('#ep-count').text(`共 ${src.episodes.length} 集`);
        $('#ep-order').text(this._epDesc ? '⇅ 切正序' : '⇅ 切倒序');
        // 倒序仅翻转展示顺序，data-idx 仍为原下标（播放/下载/连播链不受影响）
        const order = src.episodes.map((_, i) => i);
        if (this._epDesc) order.reverse();
        order.forEach((i) => {
            const ep = src.episodes[i];
            box.append(`<button class="ep-btn" data-idx="${i}" title="${escHtml(ep.url)}">` +
                `<span class="ep-check" data-idx="${i}" title="勾选后可批量播放/下载"></span>` +
                `<span class="ep-name">${escHtml(ep.name)}</span>` +
                `<span class="ep-dl-one" data-idx="${i}" title="下载本集">⬇</span></button>`);
        });
        $('#ep-check-all').prop('checked', false);
        this._syncDlBar();
    },

    /** 勾选计数与按钮文案同步。 */
    _syncDlBar() {
        const n = $('#ep-list .ep-check.checked').length;
        $('#ep-dl-count').text(n ? `已勾选 ${n} 集` : '');
        $('#ep-dl-selected').text(n ? `⬇ 下载勾选集（${n}）` : '⬇ 下载勾选集');
        $('#ep-play-selected').text(n ? `▶ 播放勾选集（${n}）` : '▶ 播放勾选集');
    },

    /** 播放勾选集：按勾选顺序组成连播链交 Player.play（每集播完 mpv 退出后
     *  由渲染层自动起播下一集，直链/解析源同逻辑），从第一勾集开始。
     *  首集播放失败时自动尝试下一线路。 */
    async playSelected() {
        const src = this.sources[this.activeSource];
        if (!src) return;
        const idxs = $('#ep-list .ep-check.checked')
            .map(function () { return parseInt($(this).data('idx'), 10); })
            .get().sort((a, b) => a - b);
        if (!idxs.length) { warnToast('请先勾选要播放的集'); return; }
        // 首集走自动重试逻辑：失败会尝试下一线路再起播
        const firstIdx = idxs[0];
        const startSrc = this.activeSource;
        let tried = 0;
        let ok = false;
        while (tried < this.sources.length) {
            const curSrc = this.sources[this.activeSource];
            const curEp = curSrc.episodes[firstIdx];
            if (!curEp) { this._advanceSource(); tried++; continue; }
            if (tried > 0) {
                warnToast(`线路「${curSrc.from}」尝试中…`);
                $('#detail-body .play-src').removeClass('active');
                $(`#detail-body .play-src[data-idx="${this.activeSource}"]`).addClass('active');
                this.renderEpisodes();
                this._saveLastSource();
            }
            // 从当前线路取所有勾选集对应的条目
            const eps = idxs.map((i) => curSrc.episodes[i]).filter(Boolean);
            if (!eps.length) { this._advanceSource(); tried++; continue; }
            const first = eps[0];
            let autoNext = true;
            try { autoNext = ((await window.vpc.settingsGet()) || {}).autoNext !== false; } catch (e) { /* 读失败默认连播 */ }
            if (eps.length > 1) {
                warnToast(autoNext ? `已加入播放列表 ${eps.length} 集，将自动连播` : '自动连播已关闭，仅播放勾选的第一集');
            }
            const result = await Player.play(this.site, curSrc.from, first.url, this.vodName || '', first.name, eps, 0);
            if (result && result.ok) { ok = true; break; }
            if (result && result.reason === 'mpv-missing') break;
            this._advanceSource();
            tried++;
        }
        if (!ok && this.activeSource !== startSrc) {
            this.selectSource(startSrc);
        }
    },

    /** 下载当前勾选的集（多选批量；单集勾一个即可）。 */
    downloadSelected() {
        const src = this.sources[this.activeSource];
        if (!src) return;
        const idxs = $('#ep-list .ep-check.checked')
            .map(function () { return parseInt($(this).data('idx'), 10); })
            .get().sort((a, b) => a - b);
        if (!idxs.length) { warnToast('请先勾选要下载的集'); return; }
        this._downloadEps(src, idxs);
    },

    /** 逐集解析出可下载直链后交 aria2；m3u8 切片流经 ffmpeg 自动合成（addHls）。 */
    async _downloadEps(src, idxs) {
        if (!src || !idxs.length) return;
        showLoading();
        let added = 0, ffmpegMissing = false, ffmpegDownloading = false, failed = 0;
        for (const i of idxs) {
            const ep = src.episodes[i];
            if (!ep) continue;
            const r = await this._resolveDownloadUrl(src.from, ep.url);
            if (!r) { failed++; continue; }
            const isM3u8 = /\.m3u8(\?|#|$)/i.test(r.url.split('?')[0]);
            // 文件名：片名 - 集名，补上链接自带的扩展名（m3u8 固定合成为 mp4）
            const ext = isM3u8 ? '.mp4' : (r.url.split('?')[0].match(/\.(mp4|flv|mov|mkv|webm|avi|ts)$/i) || [''])[0];
            const out = `${this.vodName || '视频'} - ${ep.name}${ext}`;
            try {
                const res = await window.vpc.download.control(isM3u8 ? 'addHls' : 'add', { uri: r.url, out, header: r.header });
                if (res && res.ok) added++;
                else if (res && res.reason === 'ffmpeg-downloading') ffmpegDownloading = true;
                else if (res && res.reason === 'ffmpeg-missing') ffmpegMissing = true;
                else failed++;
            } catch (e) { failed++; }
        }
        hideLoading();
        const bits = [];
        if (added) bits.push(`已加入下载 ${added} 集，可在“下载”页查看`);
        if (ffmpegDownloading) bits.push('ffmpeg 正在后台自动下载（约 90MB），完成后重试即可');
        if (ffmpegMissing) bits.push('ffmpeg 未就绪，部分 m3u8 切片流暂无法合成（启动时后台下载中，请稍后重试）');
        if (failed) bits.push(`${failed} 集取不到下载地址`);
        warnToast(bits.join('；') || '没有可下载的集');
    },

    /** 集地址 → 可下载直链：playerContent 判断 parse，需要时走解析接口。 */
    async _resolveDownloadUrl(flag, url) {
        try {
            const rsp = await doAction('playerContent', {
                site: this.site, flag, id: url, vipFlags: JSON.stringify([]),
            });
            const data = (rsp && typeof rsp === 'object') ? rsp : {};
            const u = data.url || url;
            if (parseInt(data.parse, 10) !== 1) return { url: u };
            // parse=1：已是媒体直链直接用，否则走解析接口（带 Referer 头供下载）
            if (/\.(mp4|flv|mov|mkv|webm|ts|m3u8)(\?|#|$)/i.test(u.split('?')[0])) return { url: u };
            const r = await window.vpc.resolveParse(u);
            if (r && r.ok) return { url: r.url, header: r.header };
        } catch (e) { /* 单集失败不阻断批量 */ }
        return null;
    },
};
