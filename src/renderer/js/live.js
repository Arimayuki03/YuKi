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
/* global $, getJson, doAction, escHtml, warnToast, showLoading, hideLoading */

const Live = {
    lives: [],
    channels: [],      // [{group, name, url}]
    group: '',
    _inited: false,
    _dirty: false,     // 自定义直播源增删后置脏，下次进入直播页强制重载下拉

    init() {
        if (this._inited) return;
        this._inited = true;
        $('#live-select').on('change', () => this.loadChannels());
        $('#live-refresh').on('click', () => this.loadChannels());
        $('#live-groups').on('click', '.class-tab', (e) => {
            const g = String($(e.currentTarget).data('group'));
            $('#live-groups .class-tab').removeClass('active');
            $(e.currentTarget).addClass('active');
            this.group = g;
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
            $('#live-list').html('<div class="tip-line">当前配置没有直播源。可到“工具面板 → 源配置 → 直播源”添加 txt/m3u 直播源或导入 TVBox 配置，也可载入含 lives 的配置。</div>');
            return;
        }
        this.lives.forEach((l, i) => sel.append(`<option value="${i}">${escHtml(l.name || l.url)}</option>`));
        await this.loadChannels();
    },

    async loadChannels() {
        const idx = parseInt($('#live-select').val(), 10);
        const live = this.lives[idx];
        if (!live) return;
        showLoading();
        try {
            const data = await doAction('fetchText', { url: live.url });
            const text = (data && data.text) || '';
            const channels = live.url.split('?')[0].endsWith('.m3u') || text.trim().startsWith('#EXTM3U')
                ? this.parseM3u(text)
                : this.parseTxt(text);
            this.channels = channels;
            this.group = '';
            this.renderGroups();
            this.renderList();
            // 网页/非直播源内容解析不出频道：给出可操作的提示
            if (!this.channels.length) {
                const isHtml = /<html|<!doctype/i.test(text);
                $('#live-list').html(isHtml
                    ? '<div class="tip-line">该地址返回的是网页而非直播源（txt / m3u），无法解析出频道。请改用直播源文件地址（通常以 .txt / .m3u 结尾）。</div>'
                    : '<div class="tip-line">直播源没有解析到频道（所有频道均不可用或地址无效）</div>');
            }
            // 探活：检测频道可用性，过滤不可用频道
            if (this.channels.length && window.vpc && window.vpc.probeUrls) {
                try {
                    const results = await window.vpc.probeUrls(channels.map((c) => c.url));
                    const filtered = channels.filter((c, i) => results[i]);
                    const hidden = channels.length - filtered.length;
                    this.channels = filtered;
                    this.renderGroups();
                    this.renderList();
                    if (hidden > 0) warnToast(`已隐藏 ${hidden} 个不可用频道，剩余 ${filtered.length} 个`);
                } catch (e) { /* 探测失败不阻塞 */ }
            }
        } catch (e) {
            $('#live-list').html('<div class="tip-line">直播源载入失败</div>');
        } finally {
            hideLoading();
        }
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
        box.append('<span class="class-tab active" data-group="">全部</span>');
        groups.forEach((g) => box.append(`<span class="class-tab" data-group="${escHtml(g)}">${escHtml(g)}</span>`));
    },

    renderList() {
        const box = $('#live-list').empty();
        this.channels.forEach((c, i) => {
            if (this.group && c.group !== this.group) return;
            box.append(`<div class="live-item" data-idx="${i}" tabindex="0">
                <span class="live-name">${escHtml(c.name)}</span>
                <span class="live-group">${escHtml(c.group)}</span></div>`);
        });
        if (!box.children().length) box.html('<div class="tip-line">该分组下没有频道</div>');
    },

    /** 视图切入时惰性加载（首次进入或直播源有变更才拉取）。 */
    enter() {
        if (this._dirty || !this.lives.length) {
            this._dirty = false;
            this.load();
        }
    },
};
