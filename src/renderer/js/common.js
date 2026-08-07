/**
 * common.js — 渲染进程共享工具（Phase 2 起从 panels.js 抽出）
 *
 * 职责：后端连接信息（port/token）、带 token 的 URL 拼装、/action 封装、
 * HTML 转义、对话框栈、Toast、Esc 处理器注册。
 * 依赖：jQuery（先于本文件加载）。主 UI 各视图（home/search/detail）与
 * 辅助面板（panels.js）共用本文件的全局函数。
 */
/* global $ */

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

/** POST /action（表单编码），自动 JSON 解析返回；30s 超时防永久挂起。 */
async function doAction(action, kv) {
    const rsp = await fetch(apiUrl('/action'), {
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
 */
function coverFadeIn(img) {
    if (img.complete && img.naturalWidth) { img.classList.add('loaded'); return; }
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
}

/**
 * 统一生成封面 img 标签（T31）：
 * - loading=lazy + decoding=async：列表页首屏外封面延迟加载/异步解码，降主线程卡顿
 * - referrerpolicy=no-referrer：大量图床带防盗链，不带 Referer 才能取到封面
 * - onload 淡入 / onerror 换兜底图（换后置空 onerror 防死循环）
 */
function vodCoverImg(pic) {
    const src = escHtml(normalizePic(pic) || vodPlaceholder());
    return `<img src="${src}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onload="coverFadeIn(this)" onerror="this.onerror=null;this.src='${vodPlaceholder()}'">`;
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

/** 字节数 → 可读大小。 */
function fmtSize(n) {
    if (!n || n <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// ---------------------------------------------------------------- 分页

let _pageSizeCache = null; // 每页条数设置缓存（变更后由 invalidatePageSizeCache 作废）

/** 每页条数设置：返回 24/36/60/120；0 = 自动（由调用方按窗口自适应）。 */
async function listPageSize() {
    if (_pageSizeCache !== null) return _pageSizeCache;
    try {
        const s = (await window.vpc.settingsGet()) || {};
        const n = parseInt(s.listPageSize, 10);
        _pageSizeCache = [24, 36, 60, 120].indexOf(n) >= 0 ? n : 0;
    } catch (e) { _pageSizeCache = 0; }
    return _pageSizeCache;
}

/** 设置页变更每页条数后调用，使缓存作废（下次进列表页即生效）。 */
function invalidatePageSizeCache() { _pageSizeCache = null; }

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
