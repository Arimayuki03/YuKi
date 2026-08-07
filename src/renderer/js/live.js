/**
 * live.js — 直播视图
 *
 * 数据链路：GET /sites 取 config 的 lives 列表 + settings.customLives
 * （自定义源在“工具面板 → 源配置 → 直播源”维护，支持 txt/m3u 地址
 * 与 TVBox 式配置导入的 {name,url} 条目）→ 选中频道源后经后端
 * do=fetchText 取回 txt/m3u 文本 → 解析为「分组 + 频道」渲染，
 * 点击频道交主进程 mpv 播放。
 * 支持格式：
 * - TXT：分组行「组名,#genre#」+ 频道行「频道名,地址1,地址2...」（多地址作备用线路）
 * - M3U：#EXTINF:-1 group-title="组名",频道名 后跟地址行
 * 播放：首地址交主进程 mpv；未真正开播时主进程自动切换备用线路
 * （vpc:play-retry/failed 事件提示）。
 */
/* global $, getJson, doAction, escHtml, warnToast, showLoading, hideLoading, listPageSize, renderPagerBox */

const Live = {
    lives: [],
    channels: [],      // [{group, name, url}]
    group: '',
    _page: 1,          // 频道列表当前页（T34：客户端分页，同首页分页器规格）
    _pageSize: 0,      // 每页频道数：影片每页条数 ×3（频道行紧凑），切源时刷新
    _inited: false,
    _dirty: false,     // 自定义直播源增删后置脏，下次进入直播页强制重载下拉
    _probeToken: 0,    // 探测批次令牌：切源/刷新自增，旧批次结果返回时比对后丢弃

    init() {
        if (this._inited) return;
        this._inited = true;
        $('#live-select').on('change', () => this.loadChannels(false));
        // T35：手动刷新才重新探测可用性，平时进页/切源直接用本地缓存
        $('#live-refresh').on('click', () => this.loadChannels(true));
        $('#live-groups').on('click', '.class-tab', (e) => {
            const g = String($(e.currentTarget).data('group'));
            $('#live-groups .class-tab').removeClass('active');
            $(e.currentTarget).addClass('active');
            this.group = g;
            this._page = 1; // 切分组回第一页
            this.renderList();
        });
        $('#live-list').on('click', '.live-item', (e) => {
            const idx = parseInt($(e.currentTarget).data('idx'), 10);
            const ch = this.channels[idx];
            if (!ch) return;
            const urls = (ch.urls && ch.urls.length) ? ch.urls : [ch.url];
            window.vpc.playUrl(urls[0], {
                title: ch.name,
                subtitle: ch.group && ch.group !== '未分组' ? ch.group : '',
                fallbackUrls: urls.slice(1),
            }).then((r) => {
                if (r && r.ok) warnToast(`正在播放：${ch.name}`);
                else if (r && r.reason === 'mpv-missing') warnToast('mpv 未安装：node scripts/download-binaries.js mpv');
                else if (r && r.reason === 'resolve-failed') warnToast('频道地址解析失败，换条线路试试');
                else warnToast(`播放失败${r && r.reason ? `（${r.reason}）` : ''}`);
            }).catch(() => warnToast('播放失败'));
        });
        // 备用线路切换提示（主进程检测到首播未开播时自动重试）
        if (window.vpc.onPlayRetry) {
            window.vpc.onPlayRetry(() => warnToast('当前线路无法播放，正在切换备用线路…'));
        }
        if (window.vpc.onPlayFailed) {
            window.vpc.onPlayFailed(() => warnToast('该频道所有线路均无法播放'));
        }
    },

    /** 中文域名（IDN）转 punycode：浏览器 URL 自动转换 hostname，后端拉取才不会失败。 */
    _asciiUrl(u) {
        try { return new URL(u).href; } catch (e) { return u; }
    },

    /** 归一化 lives 条目：支持 http url 与 TVBox proxy://do=live&ext=<base64 url> 两种形式。 */
    normalizeLive(l) {
        if (!l) return null;
        let url = String(l.url || '');
        if (url.startsWith('proxy://')) {
            const m = /ext=([^&]+)/.exec(url);
            if (!m) return null;
            try { url = atob(decodeURIComponent(m[1])); } catch (e) { return null; }
        }
        if (!/^https?:\/\//i.test(url)) return null;
        return { name: l.name || url, url: this._asciiUrl(url) };
    },

    /** 从 /sites 拉取 lives + 设置里自定义的直播源（配置载入完成后调用）。 */
    async load() {
        ++this._probeToken; // 作废进行中的探测批次（重载下拉）
        try {
            const st = await getJson('/sites');
            // 部分配置用 {group, channels:[{name, urls}]} 嵌套形式，先展平再归一化
            const flat = [];
            ((st && st.lives) || []).forEach((l) => {
                if (l && Array.isArray(l.channels)) {
                    l.channels.forEach((c) => {
                        (c.urls || []).forEach((u) => flat.push({ name: c.name || l.name || '', url: u }));
                    });
                } else {
                    flat.push(l);
                }
            });
            this.lives = flat.map((l) => this.normalizeLive(l)).filter(Boolean);
        } catch (e) {
            this.lives = [];
        }
        try {
            const s = (await window.vpc.settingsGet()) || {};
            // customLives 兼容旧版纯 URL 字符串与新版 {name,url} 条目（TVBox 配置导入）
            (Array.isArray(s.customLives) ? s.customLives : []).forEach((l) => {
                if (typeof l === 'string') {
                    const url = this._asciiUrl(l);
                    this.lives.push({ name: url, url, custom: true });
                } else if (l && l.url) {
                    const url = this._asciiUrl(l.url);
                    this.lives.push({ name: l.name || url, url, custom: true });
                }
            });
        } catch (e) { /* 无自定义源 */ }
        const sel = $('#live-select').empty();
        if (!this.lives.length) {
            sel.append('<option value="">（无直播源）</option>');
            $('#live-groups').empty();
            $('#live-list').html('<div class="tip-line">当前配置没有直播源。可到“设置 → 源设置 → 直播源”添加 txt/m3u 直播源或导入 TVBox 配置，也可载入含 lives 的配置。</div>');
            return;
        }
        this.lives.forEach((l, i) => sel.append(`<option value="${i}">${escHtml(l.name || l.url)}</option>`));
        await this.loadChannels();
    },

    /** force=true（手动点刷新）才重新探测；否则优先用本地可用性缓存（T35）。 */
    async loadChannels(force) {
        const idx = parseInt($('#live-select').val(), 10);
        const live = this.lives[idx];
        if (!live) return;
        const token = ++this._probeToken; // 作废旧探测批次（切源/刷新）
        // T34：每页频道数跟随「每页影片数量」（频道行紧凑取 3 倍，至少 60；T38 起无「自动」回退）
        this._pageSize = Math.max(60, ((await listPageSize()) * 3));
        this._page = 1;
        $('#live-status').hide();
        showLoading();
        try {
            const data = await doAction('fetchText', { url: live.url });
            const text = (data && data.text) || '';
            const channels = live.url.split('?')[0].endsWith('.m3u') || text.trim().startsWith('#EXTM3U')
                ? this.parseM3u(text)
                : this.parseTxt(text);
            // T35：有本地可用性缓存且非手动刷新 → 直接按缓存过滤，不再探测
            let cacheHit = false;
            if (!force && channels.length) {
                try {
                    const s = (await window.vpc.settingsGet()) || {};
                    const c = (s.liveProbeCache || {})[live.url];
                    if (c && Array.isArray(c.dead)) {
                        const dead = {};
                        c.dead.forEach((u) => { dead[u] = 1; });
                        this.channels = channels.filter((ch) => !dead[ch.url]);
                        cacheHit = true;
                    }
                } catch (e) { /* 无缓存走首次探测 */ }
            }
            if (!cacheHit) this.channels = channels;
            this.group = '';
            this.renderGroups();
            this.renderList();
            if (!this.channels.length) {
                // 网页/非直播源内容解析不出频道：给出可操作的提示
                const isHtml = /<html|<!doctype/i.test(text);
                $('#live-list').html(isHtml
                    ? '<div class="tip-line">该地址返回的是网页而非直播源（txt / m3u），无法解析出频道。请改用直播源文件地址（通常以 .txt / .m3u 结尾）。</div>'
                    : '<div class="tip-line">直播源没有解析到频道（所有频道均不可用或地址无效）</div>');
                return;
            }
            if (cacheHit) {
                // T35：缓存命中提示（手动刷新可重新探测）
                const hidden = channels.length - this.channels.length;
                $('#live-status').text(hidden > 0
                    ? `已按缓存结果过滤 ${hidden} 个不可用频道 · 点「刷新」重新检测`
                    : '已按缓存结果载入 · 点「刷新」重新检测').show();
                setTimeout(() => { if (token === this._probeToken) $('#live-status').hide(); }, 5000);
                return;
            }
        } catch (e) {
            if (token === this._probeToken) $('#live-list').html('<div class="tip-line">直播源载入失败</div>');
            return;
        } finally {
            if (token === this._probeToken) hideLoading();
        }
        // 频道立即渲染完毕，可用性在后台静默分批探测（首次进入/手动刷新；不再占用 loading 遮罩）
        if (window.vpc && window.vpc.probeUrls) this._probeChannels(token, live.url);
    },

    /** 静默分批探测频道可用性：每批 50 串行 probeUrls，返回后原地过滤并刷新列表。
     *  token 与当前 _probeToken 不一致（已切源/刷新）时丢弃本批结果；
     *  探测完成后写入本地缓存（T35：下次进入直接用，手动刷新才重探）。 */
    async _probeChannels(token, liveUrl) {
        const BATCH = 50;
        const status = $('#live-status');
        const all = this.channels.slice();
        const kept = new Array(all.length).fill(true);
        let done = 0;
        const alive = () => token === this._probeToken;

        status.text(`正在检测频道可用性 0/${all.length} …`).show();
        try {
            for (let i = 0; i < all.length; i += BATCH) {
                if (!alive()) return;
                const batch = all.slice(i, i + BATCH);
                const results = await window.vpc.probeUrls(batch.map((c) => c.url));
                if (!alive()) return; // 探测期间已切源/刷新，丢弃本批
                results.forEach((ok, j) => { kept[i + j] = !!ok; });
                done += results.length;
                this.channels = all.filter((c, k) => kept[k]);
                // 保持当前选中分组：该分组已被过滤空则回退「全部」
                if (this.group && !this.channels.some((c) => c.group === this.group)) this.group = '';
                this.renderGroups();
                this.renderList();
                status.text(`正在检测频道可用性 ${done}/${all.length} …`).show();
            }
            if (!alive()) return;
            const hidden = all.length - this.channels.length;
            status.text(hidden > 0 ? `已过滤 ${hidden} 个不可用频道` : '全部频道可用').show();
            setTimeout(() => { if (alive()) status.hide(); }, 5000);
            // T35：探测结果落盘（下次进页/切源直接按缓存过滤）
            this._saveProbeCache(liveUrl, all, kept);
        } catch (e) {
            // 探测异常：静默清空状态位，保留全部频道（撤销已过滤结果）
            if (alive()) {
                this.channels = all;
                this.renderGroups();
                this.renderList();
                status.hide();
            }
        }
    },

    /** T35：可用性探测结果写入 settings.liveProbeCache（按源 URL 索引，最多留 20 个源，超出丢最旧）。 */
    async _saveProbeCache(url, all, kept) {
        try {
            const s = (await window.vpc.settingsGet()) || {};
            const cache = s.liveProbeCache || {};
            cache[url] = { ts: Date.now(), dead: all.filter((c, i) => !kept[i]).map((c) => c.url) };
            const keys = Object.keys(cache);
            if (keys.length > 20) {
                keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
                delete cache[keys[0]];
            }
            await window.vpc.settingsSet('liveProbeCache', cache);
        } catch (e) { /* 写缓存失败不影响本次探测结果展示 */ }
    },

    /** TXT 直播源：组名,#genre# 为分组行；频道名,url[,url...] 为频道行（多地址留作备用线路）。 */
    parseTxt(text) {
        const out = [];
        let group = '未分组';
        String(text).split(/\r?\n/).forEach((line) => {
            line = line.trim();
            if (!line) return;
            if (line.endsWith(',#genre#')) {
                group = line.slice(0, -',#genre#'.length).trim() || '未分组';
                return;
            }
            const ci = line.indexOf(',');
            if (ci <= 0) return;
            const name = line.slice(0, ci).trim();
            const urls = line.slice(ci + 1).split(',')
                .map((u) => u.trim())
                .filter((u) => /^(https?|rtmp|rtsp):\/\//i.test(u));
            if (name && urls.length) out.push({ group, name, url: urls[0], urls });
        });
        return out;
    },

    /** M3U 直播源：#EXTINF 携带 group-title 与频道名。 */
    parseM3u(text) {
        const out = [];
        const lines = String(text).split(/\r?\n/);
        let pending = null;
        lines.forEach((raw) => {
            const line = raw.trim();
            if (!line) return;
            if (line.startsWith('#EXTINF')) {
                const gm = /group-title="([^"]*)"/.exec(line);
                const nm = line.split(',').slice(1).join(',').trim();
                pending = { group: (gm && gm[1]) || '未分组', name: nm || '频道' };
            } else if (!line.startsWith('#') && pending) {
                if (/^(https?|rtmp|rtsp):\/\//i.test(line)) {
                    out.push({ group: pending.group, name: pending.name, url: line, urls: [line] });
                }
                pending = null;
            }
        });
        return out;
    },

    renderGroups() {
        const box = $('#live-groups').empty();
        const groups = [];
        this.channels.forEach((c) => { if (groups.indexOf(c.group) < 0) groups.push(c.group); });
        // 按 this.group 标记 active（探测刷新原地重渲染时保持当前选中分组，勿总重置为「全部」）
        const tab = (g, label) => `<span class="class-tab${this.group === g ? ' active' : ''}" data-group="${escHtml(g)}">${escHtml(label)}</span>`;
        box.append(tab('', '全部'));
        groups.forEach((g) => box.append(tab(g, g)));
    },

    renderList() {
        const box = $('#live-list').empty();
        // T34 分页：先按分组过滤再切片，索引保留在完整 channels 中的位置（点击播放用）
        const shown = [];
        this.channels.forEach((c, i) => {
            if (!this.group || c.group === this.group) shown.push({ c, i });
        });
        if (!shown.length) {
            box.html('<div class="tip-line">该分组下没有频道</div>');
            $('#live-pager').empty();
            return;
        }
        const size = this._pageSize || 108;
        const pagecount = Math.ceil(shown.length / size);
        this._page = Math.min(Math.max(1, this._page), pagecount);
        shown.slice((this._page - 1) * size, this._page * size).forEach(({ c, i }) => {
            box.append(`<div class="live-item" data-idx="${i}" tabindex="0">
                <span class="live-name">${escHtml(c.name)}</span>
                <span class="live-group">${escHtml(c.group)}</span></div>`);
        });
        renderPagerBox($('#live-pager'), {
            page: this._page,
            pagecount,
            onJump: (pg) => { this._page = pg; this.renderList(); },
        });
    },

    /** 视图切入时惰性加载（首次进入或直播源有变更才拉取）。 */
    enter() {
        if (this._dirty || !this.lives.length) {
            this._dirty = false;
            this.load();
        }
    },
};
