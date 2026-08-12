/**
 * common.js — 渲染进程共享工具（Phase 2 起从 panels.js 抽出）
 *
 * 职责：后端连接信息（port/token）、带 token 的 URL 拼装、/action 封装、
 * HTML 转义、对话框栈、Toast、Esc 处理器注册。
 * 依赖：jQuery（先于本文件加载）。主 UI 各视图（home/search/detail）与
 * 辅助面板（panels.js）共用本文件的全局函数。
 */
/* global $, doAction */

let backend = { base: '', token: '' };

/** 后端重启（如更换缓存目录）后端口/令牌会变，主进程经 backend-ready 推新值。 */
function setBackendInfo(info) {
    if (info && info.base) backend = info;
}
const dialogStack = [];          // 打开中的对话框 id 栈（Esc 优先关闭）
const escHandlers = [];          // 视图级 Esc 处理器（返回 true 表示已消费）
let _confirmResolve = null;      // 确认对话框待决回调（Esc/遮罩关闭按取消处理）

// ---------------------------------------------------------------- backend

function apiUrl(path) {
    const sep = path.includes('?') ? '&' : '?';
    return backend.base + path + sep + 'token=' + encodeURIComponent(backend.token);
}

async function waitBackend() {
    for (let i = 0; i < 30; i++) {
        const info = window.vpc ? await window.vpc.getBackendInfo() : null;
        if (info) { backend = info; return true; }
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

/** POST /action（表单编码），自动 JSON 解析返回；30s 超时防永久挂起。
 *  path 默认 '/action'，Kazumi 引擎调用传 '/kazumi/action'。 */
async function doAction(action, kv, path) {
    const rsp = await fetch(apiUrl(path || '/action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...kv, do: action }).toString(),
        signal: AbortSignal.timeout(30000),
    });
    const text = await rsp.text();
    try { return JSON.parse(text); } catch (e) { return text; }
}

/** GET 请求并尽量解析 JSON；30s 超时。 */
async function getJson(path) {
    const rsp = await fetch(apiUrl(path), { signal: AbortSignal.timeout(30000) });
    const text = await rsp.text();
    try { return JSON.parse(text); } catch (e) { return text; }
}

// ---------------------------------------------------------------- 转义

function escPath(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 卡片标题限字（T74）：超长标题粗截断为 max 字符（完整标题保留在 title 悬浮提示）。
 * 仅为 DOM 长度保险（避免过长串进入后续精确截断），不再承担视觉省略——
 * 精确的两行截断 + '…' 由 fitVodTitle 在网格渲染后按实际列宽完成。
 */
function truncateTitle(text, max) {
    const s = String(text || '');
    const n = (max > 0) ? max : 60;
    return s.length <= n ? s : s.slice(0, n);
}

/**
 * 卡片标题「恰好两行」精确截断（T74 白块根因收尾）：
 * CSS -webkit-line-clamp 只隐藏超行文本的显示，超出的行仍参与布局与绘制，
 * 会触发 Chromium 把超行文本画成白色块的绘制缺陷。此函数对单个 .vod-name
 * 精确测量——临时解除 line-clamp（max-height 恒为两行高，故 clientHeight
 * 即两行高度）读 scrollHeight 判溢出；溢出则二分求「加入省略号后仍不超两行」
 * 的最长前缀并改写 textContent。DOM 中不再存在任何超出两行的文字（无超行 →
 * 无白块）；省略号由 JS 显式补 '…'，CSS clamp 因无溢出不会再画第二个。
 */
function fitVodTitle(el) {
    const cs = el.style;
    cs.webkitLineClamp = 'none';
    const over = el.scrollHeight > el.clientHeight;
    cs.webkitLineClamp = '2';
    if (!over) return;

    const text = el.textContent;
    // 二分求「加省略号后仍不超两行」的最长前缀：'…' 全角比半个拉丁字符宽，
    // 必须在测量里一起算，否则拉丁标题截完后仍会多绕一行。
    const fits = (n) => {
        el.textContent = text.slice(0, n) + '…';
        cs.webkitLineClamp = 'none';
        const ok = el.scrollHeight <= el.clientHeight;
        cs.webkitLineClamp = '2';
        return ok;
    };
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (fits(mid)) lo = mid; else hi = mid - 1;
    }
    el.textContent = text.slice(0, lo) + '…';
}

/** 对容器内已渲染卡片的 .vod-name 逐个做恰好两行截断（各网格渲染后调用）。 */
function fitVodTitles(container) {
    const $box = $(container);
    if (!$box.length) return;
    $box.find('.vod-name').each(function () { fitVodTitle(this); });
}

/**
 * 全量重适配卡片标题（窗口缩放/响应式断点/字号调整后调用）：
 * .vod-name 的 title 属性恒为完整标题，先据其恢复完整文本，再按当前
 * 实际列宽重新精确截断，保证任何宽度下 DOM 都不存在超行文字。
 */
function refitVodTitles() {
    $('.vod-name').each(function () {
        const full = this.getAttribute('title');
        if (full != null && this.textContent !== full) this.textContent = full;
        fitVodTitle(this);
    });
}

// 窗口宽度变化（响应式断点 T66 / 缩放）后按新列宽重新精确截断卡片标题；防抖 300ms
let _refitT = 0;
$(window).on('resize', () => {
    clearTimeout(_refitT);
    _refitT = setTimeout(refitVodTitles, 300);
});

/* ---------------- 封面图统一渲染（T31 可维护性：三处渲染点收口于此，避免参数漂移） ---------------- */

/**
 * 无封面/拉取失败统一兜底图：独立设计的资产文件
 * （assets/cover-fallback.svg，渐变底 + 胶片齿孔 + 播放标志）。
 */
function vodPlaceholder() {
    return 'assets/cover-fallback.svg';
}

/**
 * 封面淡入（T14）：img 初始 opacity:0，加载完成加 loaded 过渡显现，
 * 避免加载完成瞬间突然弹出/换兜底图时的闪烁；complete 检查兼容缓存命中时
 * load 事件可能先于属性挂载触发的情况。
 * T41：横屏封面也算有封面——加载完成后检出横图加 landscape 类，
 * 卡片内改 contain 完整显示（此前固定竖版框裁中间细条，看似没封面）。
 */
function coverFadeIn(img) {
    const show = () => {
        if (img.naturalWidth > img.naturalHeight) img.classList.add('landscape');
        img.classList.add('loaded');
    };
    if (img.complete && img.naturalWidth) { show(); return; }
    img.addEventListener('load', show, { once: true });
}

/**
 * 统一生成封面 img 标签（T31）：
 * - loading=lazy + decoding=async：列表页首屏外封面延迟加载/异步解码，降主线程卡顿
 *   eager=true 时改立即加载（搜索等「当前页封面需立刻显示」的场景，T59）
 * - referrerpolicy=no-referrer：大量图床带防盗链，不带 Referer 才能取到封面
 * - onload 淡入 / onerror 换兜底图（换后置空 onerror 防死循环）
 */
function vodCoverImg(pic, eager) {
    const p = normalizePic(pic);
    // T42：无封面卡标 data-cover-missing，供 fillMissingCovers 后台从详情补拉
    const miss = p ? '' : ' data-cover-missing="1"';
    const src = escHtml(p || vodPlaceholder());
    const load = eager ? 'eager' : 'lazy';
    return `<img src="${src}" alt="" loading="${load}" decoding="async" referrerpolicy="no-referrer"${miss} onload="coverFadeIn(this)" onerror="this.onerror=null;this.src='${vodPlaceholder()}';this.classList.add('loaded')">`;
}

/** 封面加载失败时切到下一候选源（T74，配合 vodCoverChain 的 data-fb 链）；链耗尽落占位图。 */
function coverChainNext(img) {
    const list = (img && img.dataset && img.dataset.fb) ? String(img.dataset.fb).split('||') : [];
    if (list.length) {
        img.dataset.fb = list.slice(1).join('||');
        img.src = list[0];
        return;
    }
    img.onerror = null;
    img.src = vodPlaceholder();
    img.classList.add('loaded');
}

/**
 * 封面多级兜底（T74）：按序尝试 pics（如 AniList 封面 → trace.moe 匹配帧），全部失败落占位图并淡入。
 * 用于以图搜番等封面来源可能被墙/不稳定的场景——onerror 走 coverChainNext 逐级切换，不留空框。
 */
function vodCoverChain(pics, eager) {
    const chain = (pics || []).map((p) => normalizePic(p)).filter(Boolean);
    if (!chain.length) return vodCoverImg('', eager);
    const first = escHtml(chain[0]);
    const rest = chain.slice(1).map((s) => escHtml(s)).join('||');
    const load = eager ? 'eager' : 'lazy';
    return `<img src="${first}" alt="" loading="${load}" decoding="async" referrerpolicy="no-referrer"${rest ? ` data-fb="${rest}"` : ''} onload="coverFadeIn(this)" onerror="coverChainNext(this)">`;
}

/**
 * Bangumi 封面按渲染尺寸选源（T75 1080p 锯齿根因）：
 * Bangumi /v0 images 对象含 {large, common, medium, small, grid}，large 约 ~600px+。
 * 网格卡实际渲染仅 140-220px，用 large 让浏览器大幅降采样 → 1080p 屏出现锯齿
 * （4K 像素足够掩盖）。改按渲染尺寸取更接近的变体（card/grid → common/medium），
 * 详情大图 → large，让降采样比例更温和、锯齿消失。切勿用 image-rendering:crisp-edges（更糟）。
 *
 * 参数 imagesOrUrl 可为 images 对象，或旧缓存里的裸封面 URL 字符串
 * （历史上存的是 large URL）——字符串走 lain.bgm.tv 路径段替换降级，优雅迁移旧缓存。
 * size：'detail'（大图，取 large）| 'card' | 'grid'（网格卡，取 common/medium）。
 */
const _BGM_SIZE_SEG = { large: 'l', common: 'c', medium: 'm', small: 's', grid: 'g' };

/** 把 lain.bgm.tv 封面 URL 的尺寸路径段（/pic/cover/{l,c,m,g,s}/）替换为目标变体；非该格式原样返回。 */
function bangumiResizeUrl(url, variant) {
    const seg = _BGM_SIZE_SEG[variant];
    const u = String(url || '');
    if (!seg || !u) return u;
    return u.replace(/(\/pic\/cover\/)[lcmgs](\/)/i, `$1${seg}$2`);
}

function bangumiCover(imagesOrUrl, size) {
    // 旧缓存：裸 URL 字符串（历史存 large）。detail 保留大图；card/grid 降级到 common 减锯齿。
    if (typeof imagesOrUrl === 'string') {
        const url = imagesOrUrl;
        if (!url) return '';
        return (size === 'detail') ? url : bangumiResizeUrl(url, 'common');
    }
    const images = imagesOrUrl;
    if (!images || typeof images !== 'object') return '';
    const chains = {
        detail: ['large', 'common', 'medium', 'small', 'grid'],
        card: ['common', 'medium', 'large', 'small', 'grid'],
        grid: ['common', 'medium', 'small', 'large', 'grid'],
    };
    const chain = chains[size] || chains.card;
    for (const k of chain) {
        if (images[k]) return images[k];
    }
    return '';
}

/** Bangumi 卡片（推荐/时间表共用，T62）：封面 + 排名角标 + 片名 + 评分/播出日期。 */
function bangumiCard(item) {
    const name = item.name_cn || item.name || '';
    const cover = bangumiCover(item.images, 'card');
    const rating = item.rating || {};
    const score = rating.score ? `⭐${rating.score}` : '';
    const rank = rating.rank ? `<span class="bangumi-rank-badge" title="Bangumi 排名 #${rating.rank}">#${rating.rank}</span>` : '';
    const air = item.air_date || '';
    return `<div class="vod-card bangumi-card" data-id="${item.id}" data-name="${escHtml(name)}" tabindex="0">
        <div class="vod-cover">${vodCoverImg(cover)}${rank}</div>
        <div class="vod-name" title="${escHtml(name)}">${escHtml(truncateTitle(name))}</div>
        <div class="vod-remarks">${escHtml([score, air].filter(Boolean).join(' · '))}</div>
    </div>`;
}

/** 去除富文本简介中的 HTML 标签（源数据常带 <p>/<br> 等），保留段落换行与文字。 */
function stripHtml(s) {
    return String(s || '')
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        // 开/闭合块级标签都转换行（部分源数据缺闭合标签）
        .replace(/<\/(p|div|li|tr|table|h[1-6]|dd|dt)>/gi, '\n')
        .replace(/<(p|div|li|tr|h[1-6]|dd|dt)(\s[^>]*)?\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * 封面 URL 归一化：// 开头补 https；非 http(s)/data 协议（相对路径、
 * 脏数据）视为无封面返回空串（由占位图兜底）；空格转义防请求 400。
 */
function normalizePic(pic) {
    let p = String(pic || '').trim();
    if (!p) return '';
    if (p.startsWith('//')) p = 'https:' + p;
    if (!/^(https?:|data:)/i.test(p)) return '';
    return p.split(' ').join('%20');
}

/**
 * 封面补拉（T42/T43）：部分源列表数据不带 vod_pic 但详情里有，占位图卡片
 * 后台取 detailContent 补上封面。优先级设计：用户点开详情 > 搜索拉页 >
 * 封面补拉——Detail.open 调 abortCoverFill() 立即中止后台补拉让路；
 * 只补当前屏幕可见卡片（IntersectionObserver，上下预热 300px），并发 10。
 * 卡片需带 data-id/data-source；isValid 返回 false（已切源/切页）即中止；
 * 卡片已不在 DOM（重渲染）则跳过写入。
 */
let _coverFillGen = 0;         // 世代：abortCoverFill 自增使在途补拉全部失效
const _coverFillPools = new Map(); // poolKey → {queue,busy,limit,seen,ios}；搜索各来源共用一个并发池
let _coverFillGlobalBusy = 0;  // 全局最多 10 个详情补拉，避免多个页面同时压垮后端
const COVER_FILL_GLOBAL_LIMIT = 10;
const _coverCache = new Map(); // 'site|id' → pic：补拉成功的封面 URL 缓存，重绘/切源复用，避免重复 detailContent

/** 命中已补拉过的封面 URL（无则返回 ''）。供列表重绘时直接使用，省一次详情请求与占位闪烁。 */
function getCachedCover(site, id) {
    return _coverCache.get(String(site) + '|' + String(id)) || '';
}

/** 中止后台封面补拉（用户点开详情等高优操作时调用，给详情请求让路）。 */
function abortCoverFill() {
    _coverFillGen++;
    for (const pool of _coverFillPools.values()) {
        pool.queue.length = 0;
        for (const io of pool.ios.values()) {
            try { io.disconnect(); } catch (e) { /* ignore */ }
        }
        pool.ios.clear();
    }
    _coverFillPools.clear();
}

/**
 * 补拉列表缺失封面。
 * options.concurrency：该任务池并发数；options.eager=true 时当前视口优先并补完整页；
 * options.poolKey：多个容器共享并发额度（搜索页各来源使用同一个 search 池）。
 */
function fillMissingCovers(container, isValid, options) {
    const box = $(container);
    if (!box.length) return;
    const opts = options || {};
    const poolKey = String(opts.poolKey || container);
    let pool = _coverFillPools.get(poolKey);
    if (!pool) {
        pool = { queue: [], busy: 0, limit: 10, seen: new WeakSet(), ios: new Map() };
        _coverFillPools.set(poolKey, pool);
    }
    pool.limit = Math.max(1, Math.min(COVER_FILL_GLOBAL_LIMIT, parseInt(opts.concurrency, 10) || 10));
    const gen = _coverFillGen;
    const alive = () => gen === _coverFillGen && (!isValid || isValid());
    const cards = box.find('.vod-cover img[data-cover-missing="1"]')
        .closest('.vod-card')
        .filter(function () {
            return String($(this).data('id') || '') !== '' && !pool.seen.has(this);
        });
    if (!cards.length) { _coverFillPump(pool); return; }

    const enqueue = (el, front) => {
        if (pool.seen.has(el)) return;
        pool.seen.add(el);
        const item = { el, alive };
        if (front) pool.queue.unshift(item); else pool.queue.push(item);
    };
    const isViewportVisible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom >= 0 && rect.top <= window.innerHeight;
    };

    // 同一容器重建观察器时断开旧实例；共享池中的其他来源观察器继续有效。
    const oldIo = pool.ios.get(container);
    if (oldIo) {
        try { oldIo.disconnect(); } catch (e) { /* ignore */ }
        pool.ios.delete(container);
    }

    if (opts.eager || typeof IntersectionObserver === 'undefined') {
        const all = cards.toArray().sort((a, b) => Number(isViewportVisible(b)) - Number(isViewportVisible(a)));
        all.forEach((el) => enqueue(el, false));
        _coverFillPump(pool);
        return;
    }

    const io = new IntersectionObserver((entries) => {
        entries.forEach((ent) => {
            if (!ent.isIntersecting) return;
            io.unobserve(ent.target);
            if (!alive() || !document.contains(ent.target)) return;
            enqueue(ent.target, isViewportVisible(ent.target));
        });
        _coverFillPump(pool);
    }, { rootMargin: '300px 0px' });
    pool.ios.set(container, io);
    setTimeout(() => {
        // 安全释放：长时间未滚到的卡片下次渲染会重建观察器
        try { io.disconnect(); } catch (e) { /* ignore */ }
        if (pool.ios.get(container) === io) pool.ios.delete(container);
    }, 120000);
    cards.each(function () { io.observe(this); });
}

/** 按任务池限制 + 全局限制调度；搜索中为 3，搜索完成后提升为 6。 */
function _coverFillPump(pool) {
    while (pool.busy < pool.limit && _coverFillGlobalBusy < COVER_FILL_GLOBAL_LIMIT && pool.queue.length) {
        const item = pool.queue.shift();
        pool.busy++;
        _coverFillGlobalBusy++;
        _coverFillOne(pool, item).finally(() => {
            pool.busy--;
            _coverFillGlobalBusy--;
            _coverFillPump(pool);
            for (const other of _coverFillPools.values()) {
                if (other !== pool && other.queue.length) _coverFillPump(other);
            }
        });
    }
}

async function _coverFillOne(pool, item) {
    const el = $(item.el);
    if (!item.alive() || !document.contains(item.el)) { pool.seen.delete(item.el); return; }
    const site = String(el.data('source') || '');
    const id = String(el.data('id') || '');
    if (!site || !id) { pool.seen.delete(item.el); return; }
    let pic = '';
    try {
        if (String(site).startsWith('kazumi:') && typeof Kazumi !== 'undefined' && Kazumi.getBangumiCover) {
            // Kazumi 源列表无源封面：按片名从 Bangumi 拉取（内存 + localStorage 缓存去重，T73）
            pic = normalizePic(await Kazumi.getBangumiCover(String(el.data('name') || '')));
        } else {
            const d = await doAction('detailContent', { site, ids: JSON.stringify([id]) });
            const vod = (d && d.list && d.list[0]) || null;
            pic = normalizePic(vod && vod.vod_pic);
        }
    } catch (e) {
        pool.seen.delete(item.el);
        return;
    }
    if (!pic || !item.alive() || !document.contains(item.el)) {
        pool.seen.delete(item.el);
        return;
    }
    // 缓存补拉结果：列表重绘（如搜索切源）可直接复用，避免重复 detailContent
    const ckey = String(site) + '|' + String(id);
    _coverCache.set(ckey, pic);
    if (_coverCache.size > 2000) { // 防无限增长，淘汰最旧
        const oldest = _coverCache.keys().next().value;
        _coverCache.delete(oldest);
    }
    el.removeAttr('data-cover-missing');
    // eager：补上的封面立即加载（此前 lazy 在隐藏/折叠区不触发，切源后看着「加载不出」）
    el.find('.vod-cover').html(vodCoverImg(pic, true));
    // Kazumi 卡封面补上后 .html() 会覆盖 .vod-cover 内绝对定位的源徽章，需重插（T73）
    if (String(site).startsWith('kazumi:')) {
        el.find('.vod-cover').prepend(`<div class="kazumi-badge">${escHtml(String(site).slice(7))}</div>`);
    }
}

/** 字节数 → 可读大小。 */
function fmtSize(n) {
    if (!n || n <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// ---------------------------------------------------------------- 分页

let _pageSizeCache = {}; // 每页条数设置缓存（key → 值；变更后由 invalidatePageSizeCache 整体作废）
const PAGE_SIZE_OPTIONS = [10, 16, 20, 24, 36, 60, 120];

/**
 * 分页面每页条数设置（T39：首页/搜索/收藏/历史可单独设置）。
 * key：pageSizeHome / pageSizeSearch / pageSizeFavorites / pageSizeHistory / pageSizeLive / pageSizePopular；
 * 返回 20/24/36/60/120，空/非法默认 20；首页额外回退旧键 listPageSize（兼容升级前设置）。
 */
async function pageSizeOf(key) {
    if (_pageSizeCache[key]) return _pageSizeCache[key];
    try {
        const s = (await window.vpc.settingsGet()) || {};
        let n = parseInt(s[key], 10);
        if (!(PAGE_SIZE_OPTIONS.indexOf(n) >= 0) && key === 'pageSizeHome') {
            n = parseInt(s.listPageSize, 10); // 旧版单一设置迁移
        }
        _pageSizeCache[key] = PAGE_SIZE_OPTIONS.indexOf(n) >= 0 ? n : 20;
    } catch (e) { _pageSizeCache[key] = 20; }
    return _pageSizeCache[key];
}

/** 设置页变更每页条数后调用，使缓存整体作废（下次进列表页即生效）；同时作废首页分类内容缓存。 */
function invalidatePageSizeCache() {
    _pageSizeCache = {};
    if (typeof Home !== 'undefined' && Home.invalidatePageCaches) Home.invalidatePageCaches(); // T77
}

/**
 * 统一分页器：首页/上一页/页码（当前页±2 连号 + 首尾页，空隙省略号）/下一页/末页 + 跳转输入。
 * opts: { page, pagecount, onJump }；pagecount ≤ 1 时清空不渲染。
 */
function renderPagerBox($box, opts) {
    $box = $($box);
    $box.empty().off('.vpager');
    const page = opts.page || 1;
    const total = opts.pagecount || 0;
    if (total <= 1) return;
    const btn = (pg, label, dis, extra) =>
        `<button class="md-btn md-btn-tonal pg-btn ${extra || ''}" data-pg="${pg}" ${dis ? 'disabled' : ''}>${label}</button>`;
    // 页码序列：当前页±2 + 首尾页，空隙处插入省略号占位
    const nums = [1, total, page - 2, page - 1, page, page + 1, page + 2]
        .filter((p) => p >= 1 && p <= total)
        .filter((p, i, a) => a.indexOf(p) === i)
        .sort((a, b) => a - b);
    const seq = [];
    let prev = 0;
    nums.forEach((p) => {
        if (p - prev > 1) seq.push('<span class="pg-dots">…</span>');
        seq.push(p === page
            ? `<button class="md-btn pg-btn pg-btn-active" data-pg="${p}">${p}</button>`
            : btn(p, p, false));
        prev = p;
    });
    const jump = `<span class="pg-jump">第 <input class="md-input pg-jump-input" type="number" min="1" max="${total}" placeholder="${page}"> 页</span>`;
    $box.html(
        btn(1, '首页', page <= 1)
        + btn(page - 1, '上一页', page <= 1)
        + seq.join('')
        + btn(page + 1, '下一页', page >= total)
        + btn(total, '末页', page >= total)
        + jump
    );
    $box.on('click.vpager', '.pg-btn', (e) => {
        const pg = parseInt($(e.currentTarget).attr('data-pg'), 10);
        if (pg >= 1 && pg <= total && opts.onJump) opts.onJump(pg);
    });
    // 跳转输入：回车触发，越界钳制到合法值并回填
    $box.on('keydown.vpager', '.pg-jump-input', (e) => {
        if (e.key !== 'Enter') return;
        let pg = parseInt(e.currentTarget.value, 10);
        if (!Number.isFinite(pg)) pg = page;
        pg = Math.min(total, Math.max(1, pg));
        e.currentTarget.value = pg;
        e.currentTarget.blur();
        if (opts.onJump) opts.onJump(pg);
    });
}

// ---------------------------------------------------------------- 对话框 / Esc

function openDialog(id) {
    // overlay 为 flex 居中容器：不能用 show()（会恢复成 block 导致弹窗靠左上）
    const el = $('#' + id);
    clearTimeout(el.data('_outT')); // T30：取消退场延迟隐藏，防重开同 id 时被误藏
    el.removeClass('dlg-out').css('display', 'flex');
    if (dialogStack.indexOf(id) < 0) dialogStack.push(id);
}

function closeDialog(id) {
    const el = $('#' + id);
    // T30：退场动画（.dlg-out 淡出缩小）后再隐藏；no-anim 下过渡被禁也不影响隐藏时机
    clearTimeout(el.data('_outT'));
    el.addClass('dlg-out');
    el.data('_outT', setTimeout(() => el.hide().removeClass('dlg-out'), 150));
    const i = dialogStack.lastIndexOf(id);
    if (i >= 0) dialogStack.splice(i, 1);
    // 确认框被 Esc/其他方式关闭时按取消处理，避免 Promise 挂死
    if (id === 'confirmDialog' && _confirmResolve) {
        const r = _confirmResolve; _confirmResolve = null; r(false);
    }
}

/** 注册视图级 Esc 处理器；handler 返回 true 表示消费掉 Esc。 */
function registerEsc(handler) {
    escHandlers.push(handler);
    return handler;
}

function unregisterEsc(handler) {
    const i = escHandlers.indexOf(handler);
    if (i >= 0) escHandlers.splice(i, 1);
}

/** 全局 Esc 派发：先关对话框，再关封面放大浮层，最后自顶向下询问视图处理器。 */
function dispatchEsc() {
    if (dialogStack.length) {
        closeDialog(dialogStack[dialogStack.length - 1]);
        return;
    }
    // 详情页封面放大浮层不属于对话框系统，单独关闭
    const cf = document.getElementById('cover-float');
    if (cf && cf.classList.contains('show')) { cf.classList.remove('show'); return; }
    for (let i = escHandlers.length - 1; i >= 0; i--) {
        try { if (escHandlers[i]() === true) return; } catch (e) { /* ignore */ }
    }
}

/**
 * 主题风格确认对话框（替代系统 window.confirm，与整体 UI 配色一致）。
 * 返回 Promise<boolean>：确定=true；取消 / Esc 关闭=false。
 */
function confirmDialog(msg, opts) {
    opts = opts || {};
    // 并发守卫：上一个确认框未处理完即按取消结掉，避免 Promise 挂死
    if (_confirmResolve) { const old = _confirmResolve; _confirmResolve = null; old(false); }
    return new Promise((resolve) => {
        $('#confirm_content').text(msg);
        $('#confirm_ok').text(opts.okText || '确定');
        $('#confirm_cancel').text(opts.cancelText || '取消');
        const done = (v) => {
            _confirmResolve = null;
            closeDialog('confirmDialog');
            resolve(v);
        };
        $('#confirm_ok').off('click').on('click', () => done(true));
        $('#confirm_cancel').off('click').on('click', () => done(false));
        _confirmResolve = resolve;
        openDialog('confirmDialog');
    });
}

// ---------------------------------------------------------------- Toast / Loading

let warnToastTimer = null;

function warnToast(msg) {
    // 应用内错误提示开关（2.8）：关闭时错误类提示静默（成功/信息类 toast 不受影响）
    if (!_errorToastOn && /(失败|无法|不能|未找到|出错|错误|无效)/.test(String(msg))) return;
    $('#warnToastContent').text(msg);
    $('#warnToast').removeClass('out').show();
    if (warnToastTimer) clearTimeout(warnToastTimer);
    // 展示时长随文案长度伸缩（1.6~5s），长提示不会看不完就消失
    const dur = Math.min(5000, Math.max(1600, String(msg).length * 80));
    // T30：退场淡出（snackOut）替代瞬间消失
    warnToastTimer = setTimeout(() => {
        $('#warnToast').addClass('out');
        warnToastTimer = setTimeout(() => {
            $('#warnToast').hide().removeClass('out'); warnToastTimer = null;
        }, 200);
    }, dur);
}

// 应用内错误提示开关（2.8）：关闭时错误类 toast 不弹出（成功/信息 toast 不受影响）
let _errorToastOn = true;
function setErrorToastEnabled(on) { _errorToastOn = !!on; }
/** 错误提示：受「应用内错误提示」设置控制，关闭时静默。 */
function errToast(msg) { if (!_errorToastOn) return; warnToast(msg); }

// T30：loading 淡入（CSS ldIn）+ 淡出（.out 过渡）；隐藏延迟与过渡时长对齐
let _loadingHideT = null;
function showLoading() {
    clearTimeout(_loadingHideT);
    $('#loadingToast').removeClass('out').show();
}
function hideLoading() {
    const el = $('#loadingToast');
    if (!el.is(':visible')) return;
    el.addClass('out');
    _loadingHideT = setTimeout(() => el.hide().removeClass('out'), 160);
}

/**
 * 统一进度条渲染（T82）：spinner 元素一次创建、后续只更新文字/进度条/计数，
 * 避免每次 .html() 重建导致旋转动画重置卡顿。结构与 .ss-* 复用。
 * opts: { text, recv, total, done, items, unit }；total>0 定宽，否则 indeterminate。
 */
function renderStatusBar($el, opts) {
    const o = opts || {};
    const isDone = !!o.done;
    const hasTotal = o.total > 0;
    const recv = Math.max(0, o.recv || 0);
    // 首次构建结构——spinner 只创建一次，之后保持稳定
    if (!$el.children('.ss-bar').length) {
        $el.html('<span class="ss-spinner"></span><span class="ss-text"></span>'
            + '<span class="ss-bar"><span class="ss-fill"></span></span><span class="ss-count"></span>');
    }
    $el.toggleClass('done', isDone);
    $el.find('.ss-text').text(o.text || '');
    const pct = isDone ? 100 : (hasTotal ? Math.round(Math.min(recv, o.total) / o.total * 100) : 0);
    $el.find('.ss-bar').toggleClass('indeterminate', !isDone && !hasTotal);
    $el.find('.ss-fill').css('width', (isDone || hasTotal) ? pct + '%' : '');
    const bits = [];
    if (!isDone) {
        if (hasTotal) bits.push(`${Math.min(recv, o.total)}/${o.total}${o.unit || ''}`);
        else if (recv) bits.push(`${recv}${o.unit || ''}`);
        if (o.items !== undefined) bits.push(`${o.items} 条结果`);
    }
    $el.find('.ss-count').text(bits.join(' · '));
    return $el;
}

// ---------------------------------------------------------------- 换肤

/** 本地路径转 file:// URL（壁纸图片引用）。 */
function toFileUrl(p) {
    if (!p) return '';
    return encodeURI('file:///' + String(p).replace(/\\/g, '/'));
}

/**
 * 应用皮肤（主题色 / 明暗模式 / 缩放 / 字体 / 壁纸）：
 * - theme → <html data-color>，ui.css 内置多套变量覆写；
 * - colorMode → auto/light/dark，auto 时跟随系统深浅色（监听系统变化）；
 * - fontSize → 整页 zoom 数值百分比（60~200，100 为标准；兼容旧档位 xs/sm/lg/xl）；
 * - textSize → 仅文字等比缩放数值百分比（80~200），不改布局尺寸；
 * - textColor → 自定义主文字颜色（覆写 on-surface 变量，空为默认）；
 * - animEnabled → 界面动画开关（false 时 html.no-anim 禁用全部过渡）；
 * - wallpaperUrl → body 铺图，dim 控制内容遮罩强度。
 * 传入部分字段即可，未传字段沿用上次值。
 */
const _skin = { theme: '', customColor: '', wallpaperUrl: '', colorMode: 'auto', fontSize: '', textSize: '', textColor: '', dim: '', animEnabled: true };

// ---- 自定义主题色：由单个基色推导 Material 浅色/深色两套变量 ----

function _hexToHsl(hex) {
    const m = String(hex).match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d) {
        const s = d / (1 - Math.abs(2 * l - 1));
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h = ((h * 60) + 360) % 360;
        return [h, s * 100, l * 100];
    }
    return [0, 0, l * 100];
}

const _hsl = (h, s, l) => `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;

/** 基色 → 浅/深两套主色变量（注入 <style>，html.theme-custom / html.dark.theme-custom 生效）。 */
function _customThemeCss(hex) {
    const hsl = _hexToHsl(hex);
    if (!hsl) return '';
    const [h, s] = hsl;
    const sat = Math.max(30, Math.min(85, s));
    return `
html.theme-custom {
    --md-primary:${_hsl(h, sat, 36)}; --md-on-primary:#FFFFFF;
    --md-primary-container:${_hsl(h, Math.min(70, sat), 88)}; --md-on-primary-container:${_hsl(h, sat, 12)};
    --md-secondary-container:${_hsl(h, Math.min(50, sat), 84)}; --md-on-secondary-container:${_hsl(h, sat, 15)};
}
html.dark.theme-custom {
    --md-primary:${_hsl(h, Math.min(75, sat), 72)}; --md-on-primary:${_hsl(h, sat, 15)};
    --md-primary-container:${_hsl(h, Math.min(60, sat), 30)}; --md-on-primary-container:${_hsl(h, Math.min(70, sat), 88)};
    --md-secondary-container:${_hsl(h, Math.min(45, sat), 26)}; --md-on-secondary-container:${_hsl(h, Math.min(60, sat), 85)};
}`;
}

let _customThemeEl = null;
function _applyCustomTheme(hex) {
    const el = document.documentElement;
    if (!hex) {
        el.classList.remove('theme-custom');
        if (_customThemeEl) { _customThemeEl.remove(); _customThemeEl = null; }
        return;
    }
    if (!_customThemeEl) {
        _customThemeEl = document.createElement('style');
        document.head.appendChild(_customThemeEl);
    }
    _customThemeEl.textContent = _customThemeCss(hex);
    el.classList.add('theme-custom');
}

/** 旧多档值兼容映射；数值输入钳制在 60~200 防布局崩坏。 */
const _FONT_LEGACY = { xs: 80, sm: 90, lg: 110, xl: 125 };
function _fontSizePct(v) {
    if (v == null || v === '') return 100;
    if (typeof v === 'string' && _FONT_LEGACY[v]) return _FONT_LEGACY[v];
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return 100;
    return Math.min(200, Math.max(60, n));
}

/**
 * 字体大小（仅文字）：按各元素基准字号等比缩放，注入临时样式表覆写；
 * 100% 时移除注入恢复默认（基准值取自 ui.css 各选择器原始字号）。
 */
const _TEXT_SCALE_BASE = [
    ['.view', 14], ['.vod-name', 13], ['.vod-remarks', 11], ['.rec-site', 10.5],
    ['.tip-line', 12], ['.class-tab', 13],
    ['.md-select, .main-nav-item, .live-name', 14],
    ['.md-input', 16], ['.detail-title', 24],
    ['.detail-meta, .detail-sub', 13], ['.detail-desc', 14],
];
let _textScaleEl = null;
function _applyTextScale(pct) {
    if (_textScaleEl) { _textScaleEl.remove(); _textScaleEl = null; }
    if (!pct || pct === 100) return;
    const rules = _TEXT_SCALE_BASE
        .map((it) => `${it[0]} { font-size:${(it[1] * pct / 100).toFixed(1)}px; }`)
        .join('\n');
    _textScaleEl = document.createElement('style');
    _textScaleEl.textContent = rules;
    document.head.appendChild(_textScaleEl);
}

function applySkin(opts) {
    Object.assign(_skin, opts || {});
    const el = document.documentElement;
    // 禁用动画：全局关掉 transition/animation
    el.classList.toggle('no-anim', _skin.animEnabled === false);
    // 自定义主题色优先于内置预设；无自定义时才落 data-color
    if (_skin.customColor) {
        delete el.dataset.color;
        _applyCustomTheme(_skin.customColor);
    } else {
        _applyCustomTheme('');
        if (_skin.theme) el.dataset.color = _skin.theme;
        else delete el.dataset.color;
    }
    // 界面缩放：数值百分比写 html 内联 zoom（100 恢复）
    const fsPct = _fontSizePct(_skin.fontSize);
    el.style.zoom = fsPct === 100 ? '' : (fsPct / 100);
    // 字体大小：数值百分比仅缩放文字
    _applyTextScale(_fontSizePct(_skin.textSize));
    // 自定义文字颜色：覆写主文字变量；恢复默认时移除行内覆写
    if (_skin.textColor) {
        el.style.setProperty('--md-on-surface', _skin.textColor);
        el.style.setProperty('--md-on-surface-variant', _skin.textColor);
    } else {
        el.style.removeProperty('--md-on-surface');
        el.style.removeProperty('--md-on-surface-variant');
    }
    if (_skin.wallpaperUrl) {
        document.body.style.backgroundImage = `url("${_skin.wallpaperUrl}")`;
        document.body.classList.add('has-wallpaper');
        if (_skin.dim) document.body.dataset.dim = _skin.dim;
        else delete document.body.dataset.dim;
    } else {
        document.body.style.backgroundImage = '';
        document.body.classList.remove('has-wallpaper');
        delete document.body.dataset.dim;
    }
    _applyColorMode();
    // 字号/界面缩放变化会改变卡片列宽与文字宽度：按新布局重新精确截断标题（T74 收尾）
    refitVodTitles();
}

/** 明暗模式落到 html.dark 类（CSS 里深浅两套变量均挂在此类上）。 */
function _applyColorMode() {
    const m = _skin.colorMode || 'auto';
    const dark = m === 'dark' || (m === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
}
try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => _applyColorMode());
} catch (e) { /* 旧内核无 addEventListener */ }

// ⓘ 信息点（T7）：长说明收起为小圆点，点击展开/收起详情；短说明保持内联
$(document).on('click', '.info-dot', function () {
    $(this).closest('.info-tip').toggleClass('open');
});
