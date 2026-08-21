/**
 * panels.js — 工具面板（源配置 / 本地文件）
 *
 * UX 批次重构：移除搜索、推送、弹幕面板（用户不再需要）；
 * 源配置独立成页（输入框 + 历史源列表，点击载入、可删除）；
 * 设置已独立为侧栏底部「设置」视图（控件绑定仍在本文件 initSettingsPanel）；
 * 缓存清理前先展示占用大小；本地文件管理逻辑保持不变。
 * 需解析的影片链接（parse=1）由 player.js 自动解析载入播放，无需手动推送。
 */
/* global $, doAction, getJson, escHtml, escPath, fmtSize, warnToast, showLoading, hideLoading, renderStatusBar,
          openDialog, closeDialog, registerEsc, confirmDialog, Home, Live, Downloads, About, Player, createRuntimeId,
          applyMisansFont */

const icDir = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23F5A623'><path d='M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'/></svg>`;
const icFile = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23717970'><path d='M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z'/></svg>`;

let currentRoot = '';
let currentFile = '';
let currentParent = '';
let dirNavStack = [];
let pendingDelFolder = null;
let _assetStatus = null; // 最近一次资产就绪状态缓存（Anime4K 开关提示用）

// ---------------------------------------------------------------- 面板切换

/** 本地文件板块（T28：原工具面板页签移除后直显）：首次进入懒加载根目录列表。 */
function ensureLocalPanel() {
    const list = document.getElementById('file_list');
    if (list && list.innerHTML === '') listFile('');
}

// ---------------------------------------------------------------- 源配置

let _configLoadAbort = null;
let _configLoadRequestId = '';

/** 载入配置（名称固定 config）：URL 或 JSON 均可；异步任务轮询 configTask。
 *  配置进度必须展示：获取仓库 → 解析配置 → 检测站点 → 初始化运行时 → 可用/降级/不支持数量。
 *  支持中途主动取消，取消后保留旧配置。 */
async function setting() {
    let text = $('#setting_text').val().trim();
    if (!text) { warnToast('请输入配置地址或 JSON'); return; }

    if (text.startsWith('http://') || text.startsWith('https://')) {
        text = asciiUrl(text);
    }

    if (_configLoadAbort) {
        _configLoadAbort.abort();
    }
    const abortCtrl = new AbortController();
    _configLoadAbort = abortCtrl;
    const requestId = createRuntimeId('cfg');
    _configLoadRequestId = requestId;

    let barEl = $('#config-loading-bar');
    if (!barEl.length) {
        $('#setting_text').closest('.tool-card').append(
            `<div id="config-loading-bar" class="tip-line" style="margin-top:8px;display:flex;align-items:center;justify-content:space-between;">
                <span class="config-progress-text">正在载入配置…</span>
                <button type="button" id="config-cancel-btn" class="md-btn md-btn-sm md-btn-tonal" style="padding:2px 8px;margin-left:8px;">取消</button>
            </div>`
        );
        barEl = $('#config-loading-bar');
    }
    const updateProgressUi = (stepText) => {
        barEl.find('.config-progress-text').text(stepText);
        barEl.show();
    };

    $('#config-cancel-btn').off('click').on('click', async () => {
        abortCtrl.abort();
        try { await doAction('cancelConfig', { requestId }); } catch (e) { /* best-effort */ }
        barEl.hide();
        warnToast('已取消配置载入，保留原配置');
    });

    updateProgressUi('获取仓库 → 解析配置…');
    let rsp;
    try {
        rsp = await doAction('setting', { text, name: 'config', requestId }, null, {
            requestId, signal: abortCtrl.signal, timeoutMs: 15000,
        });
    } catch (e) {
        barEl.hide();
        if (abortCtrl.signal.aborted) {
            warnToast('已取消配置载入');
            return;
        }
        warnToast('请求失败');
        return;
    }

    if (rsp && rsp.code === 202) {
        const stages = [
            '获取仓库 → 解析配置',
            '解析配置 → 检测站点',
            '检测站点 → 初始化运行时',
            '初始化运行时 → 校验可用性',
        ];
        for (let i = 0; i < 150; i++) {
            if (abortCtrl.signal.aborted || _configLoadRequestId !== requestId) {
                barEl.hide();
                return;
            }
            await new Promise((r) => setTimeout(r, 1500));
            if (abortCtrl.signal.aborted || _configLoadRequestId !== requestId) {
                barEl.hide();
                return;
            }
            let task = null;
            try {
                task = await doAction('configTask', {}, null, {
                    requestId, signal: abortCtrl.signal, timeoutMs: 8000,
                });
            } catch (e) { continue; }

            if (!task || task.status === 'loading') {
                const stageIdx = Math.min(stages.length - 1, Math.floor(i / 2));
                updateProgressUi(`${stages[stageIdx]}…`);
                continue;
            }
            barEl.hide();
            if (task.status === 'done' && task.summary) {
                applyConfigResult(task.summary, text);
            } else {
                const msg = String((task && task.msg) || '未知错误');
                if (task.stage === 'cancelled' || msg.includes('cancelled')) {
                    warnToast('配置加载已取消，保留旧配置');
                } else {
                    warnToast(`配置载入失败：${msg.slice(0, 80)}`);
                }
            }
            return;
        }
        barEl.hide();
        warnToast('配置仍在载入中，请稍后切换站点查看结果');
        return;
    }
    barEl.hide();
    if (rsp && rsp.code === 200 && rsp.summary) {
        applyConfigResult(rsp.summary, text);
    } else if (rsp && rsp.code === 409) {
        warnToast('已有一个配置载入正在进行，请稍后再试');
    } else {
        const msg = (rsp && rsp.msg) ? String(rsp.msg) : '网络错误或源不可达';
        warnToast(`配置载入失败：${msg.slice(0, 80)}`);
    }
}

/** 配置载入完成后同步设置、首页和直播页。 */
function refreshConfigViews() {
    const refreshes = [];
    if (typeof Home !== 'undefined' && Home.loadSites) {
        refreshes.push(Promise.resolve().then(() => Home.loadSites()));
    }
    if (typeof Live !== 'undefined' && Live.load) {
        refreshes.push(Promise.resolve().then(() => Live.load()));
    }
    refreshes.forEach((task) => task.catch(() => {}));
}

/** 根据加载摘要提示并持久化 URL。 */
function applyConfigResult(sm, text) {
    renderConfigDiagnostics(sm);
    const configured = Number(sm.configured ?? sm.sites ?? 0);
    const built = Number(sm.built ?? sm.sites_built ?? sm.sites ?? 0);
    const initialized = Number(sm.initialized ?? built);
    const healthy = Number(sm.healthy ?? sm.sites ?? 0);
    const degraded = Number(sm.degraded ?? 0);
    const unsupported = Number(sm.unsupported ?? (configured - healthy - degraded));
    const safeUnsupported = unsupported >= 0 ? unsupported : 0;

    const progressSummary = `获取仓库 → 解析配置 → 检测 ${configured} 个站点 → 初始化运行时 → 可用 ${healthy} / 降级 ${degraded} / 不支持 ${safeUnsupported}`;
    const parts = [
        progressSummary,
        `${sm.parses || 0} 个解析`,
    ];
    if (sm.skipped && sm.skipped.length) parts.push(`跳过 ${sm.skipped.length} 个`);
    const jarN = sm.jarSites || 0;
    if (jarN) parts.push(`含 ${jarN} 个 JAR 源${sm.javaOk ? '' : '（需安装 JRE）'}`);

    const panN = sm.panSites || 0;
    if (panN) parts.push(`含 ${panN} 个网盘源（播放需配置 Cookie，见设置→源设置→网盘账号）`);

    const build = sm.build_errors || {};
    const diagnostics = [
        ['L1 解析失败', sm.parse_errors],
        ['L2 类型不支持', build.type_unsupported],
        ['L3 JAR 失败', build.jar_failed],
        ['L3 JS 失败', build.js_failed],
        ['L3 Python 失败', build.py_failed],
    ].filter(([, count]) => Number(count) > 0)
        .map(([label, count]) => `${label} ${count}`);
    if (diagnostics.length) parts.push(`诊断：${diagnostics.join('、')}`);

    if (/^https?:\/\//i.test(text.trim())) {
        window.vpc.settingsSet('lastConfigUrl', text.trim());
        addConfigHistory(text.trim());
    }
    refreshConfigViews();

    if (healthy > 0 || degraded > 0) {
        warnToast(parts.join(' · '));
    } else {
        const hint = `${progressSummary}。` +
            '此配置当前没有被健康检查标记为可用，仍已同步到首页；请查看设置中的诊断信息。';
        warnToast(`配置已解析但没有可用站点：${hint}`);
    }
}
function renderConfigDiagnostics(data) {
    const box = $('#config_diagnostics').empty();
    const summary = data && data.summary ? data.summary : data || {};
    const diagnostics = Array.isArray(data && data.diagnostics) ? data.diagnostics : [];
    const skipped = Array.isArray(summary.skipped) ? summary.skipped : [];
    const configured = Number(summary.configured ?? diagnostics.length ?? 0);
    const built = Number(summary.built ?? 0);
    const initialized = Number(summary.initialized ?? 0);
    const healthy = Number(summary.healthy ?? diagnostics.filter((item) => item.healthy).length);
    const degraded = Number(summary.degraded ?? diagnostics.filter((item) => item.state === 'degraded' || item.state === 'credentials_required').length);
    const unsupported = Number(summary.unsupported ?? diagnostics.filter((item) => item.state === 'unsupported' || item.runtime === 'android').length);

    $('<div class="history-item" style="font-weight:600;"></div>')
        .text(`配置 ${configured} · 建成 ${built} · 初始化 ${initialized} · 可用 ${healthy} · 降级 ${degraded} · 不支持 ${unsupported}`)
        .appendTo(box);

    const runtimeGroups = {};
    const errorGroups = {};
    diagnostics.forEach((item) => {
        if (!item) return;
        const rt = item.runtime || 'unknown';
        runtimeGroups[rt] = (runtimeGroups[rt] || 0) + 1;
        if (!item.healthy) {
            const err = item.lastError || {};
            const code = err.code || item.state || 'UNAVAILABLE';
            errorGroups[code] = (errorGroups[code] || 0) + 1;
        }
    });

    const rtSummary = Object.entries(runtimeGroups).map(([rt, c]) => `${rt}: ${c}`).join(' · ');
    if (rtSummary) {
        $('<div class="history-item" style="color:var(--md-primary);"></div>')
            .text(`运行时分布: ${rtSummary}`)
            .appendTo(box);
    }
    const errSummary = Object.entries(errorGroups).map(([c, cnt]) => `${c} (${cnt})`).join(' · ');
    if (errSummary) {
        $('<div class="history-item" style="color:var(--md-error);"></div>')
            .text(`错误层级统计: ${errSummary}`)
            .appendTo(box);
    }

    const unavailable = diagnostics.filter((item) => item && !item.healthy).map((item) => {
        const error = item.lastError || {};
        const isAndroid = item.runtime === 'android' || (error.code === 'L2_SITE_REQUIRES_ANDROID');
        const reason = isAndroid ? '仅支持 Android / 当前上限 C1 / 请改用可移植源' : `${error.code || ''} ${error.message || ''}`.trim();
        return `${item.siteKey || '?'} · ${item.state || 'unavailable'} · ${reason}`;
    });
    [...skipped, ...unavailable].slice(0, 50).forEach((reason) => {
        $('<div class="history-item"></div>').text(String(reason)).appendTo(box);
    });
    if (!skipped.length && !unavailable.length) {
        $('<div class="tip-line"></div>').text(healthy ? '当前没有不可用站点' : '尚无配置诊断').appendTo(box);
    }
}

/** 历史源：成功后记入 settings.configHistory（最新在前，去重，上限 10 条）。 */
async function addConfigHistory(url) {
    try {
        const s = (await window.vpc.settingsGet()) || {};
        let list = Array.isArray(s.configHistory) ? s.configHistory : [];
        list = list.filter((x) => x !== url);
        list.unshift(url);
        if (list.length > 10) list = list.slice(0, 10);
        await window.vpc.settingsSet('configHistory', list);
        window._cfgHistoryCache = list;
        renderConfigHistory(list);
    } catch (e) { /* 历史保存失败不影响主流程 */ }
}

function renderConfigHistory(list) {
    const box = $('#config_history');
    box.empty();
    if (!(list || []).length) {
        box.html('<div class="tip-line">暂无历史源，成功载入一个配置 URL 后会自动记录。</div>');
        return;
    }
    list.forEach((u, i) => {
        let name = u;
        try { name = decodeURIComponent(u); } catch (e) { /* 非法编码保留原文 */ }
        if (name.length > 70) name = name.slice(0, 70) + '…';
        box.append(`<div class="history-item" data-idx="${i}" title="${escHtml(u)}">
            <span class="history-url">${escHtml(name)}</span>
            <button class="history-btn history-del" data-idx="${i}" title="删除该历史源">✕</button>
        </div>`);
    });
}

/** 点击历史源载入；点 ✕ 删除。 */
async function useHistoryConfig(url) {
    $('#setting_text').val(url);
    return setting();
}
async function removeConfigHistory(idx) {
    try {
        const s = (await window.vpc.settingsGet()) || {};
        const list = Array.isArray(s.configHistory) ? s.configHistory : [];
        // T33：删除类操作统一二次确认
        if (!await confirmDialog('删除该历史源记录？（仅移除记录，不影响已载入的配置）', { okText: '删除' })) return;
        list.splice(idx, 1);
        await window.vpc.settingsSet('configHistory', list);
        window._cfgHistoryCache = list;
        renderConfigHistory(list);
    } catch (e) { warnToast('删除失败'); }
}

// ---------------------------------------------------------------- 设置：缓存

// refreshCacheSize 防抖：上次成功刷新 3s 内不重复发起（连续切页/多次触发时省请求）。
let _cacheSizeLastTs = 0;

/**
 * 展示当前缓存占用（清理按钮同步显示总量，行文案展示分类明细）。
 * 并行请求后端 cacheSize 与主进程 app 缓存大小（若 preload 暴露 getAppCacheSize），
 * 合并 bytes/items 后渲染。8s 超时；失败静默但 console.debug；3s 内不重复发起。
 * @param {boolean} force 忽略防抖（清理后强制刷新用）
 */
async function refreshCacheSize(force) {
    const now = Date.now();
    if (!force && now - _cacheSizeLastTs < 3000) return; // 防抖：3s 内不重复
    _cacheSizeLastTs = now;
    try {
        // 主进程 app 缓存大小接口可能未暴露（主进程任务补齐前）：容错为 null，不强依赖。
        const appSizeP = (window.vpc && typeof window.vpc.getAppCacheSize === 'function')
            ? window.vpc.getAppCacheSize().catch(() => null)
            : Promise.resolve(null);
        const [backendR, appR] = await Promise.all([
            doAction('cacheSize', {}, null, 8000).catch(() => null),
            appSizeP,
        ]);

        let localBytes = 0;
        try { if (typeof localCacheStats === 'function') localBytes = localCacheStats().bytes || 0; } catch (e) { /* ignore */ }

        let backendBytes = 0, backendItems = 0, backendOk = false;
        if (backendR && backendR.code === 200) {
            backendOk = true;
            backendBytes = backendR.bytes || 0;
            backendItems = backendR.items || 0;
        }
        let appBytes = 0, appOk = false;
        if (appR && (appR.ok || typeof appR.bytes === 'number')) {
            appOk = true;
            appBytes = (typeof appR.bytes === 'number' ? appR.bytes : appR.cleanedBytes) || 0;
        }

        // 后端与 app 均不可用时保持原文案不变（静默）。
        if (!backendOk && !appOk && localBytes <= 0) return;

        const total = backendBytes + appBytes + localBytes;
        // 行文案：分类 breakdown（无 app 接口时省略应用分项）。
        const parts = [`本地 ${fmtSize(localBytes)}`, `后端 ${fmtSize(backendBytes)}`];
        if (appOk) parts.push(`应用 ${fmtSize(appBytes)}`);
        parts.push(`${backendItems} 文件`);
        $('#cache_size_line').text(`当前缓存占用：${fmtSize(total)}（${parts.join(' · ')}）`);
        $('#cache_clear').text(total > 0 ? `清理缓存（${fmtSize(total)}）` : '清理缓存');
    } catch (e) {
        console.debug('[cache] refreshCacheSize failed', e);
    }
}

async function clearCache() {
    // 并发守卫：清理进行中重复点击直接忽略。
    if (clearCache._busy) return;
    // T40：清理前二次确认（文案保持不变）
    if (!await confirmDialog('清理缓存？将清除影片爬虫缓存、下载临时文件、本地预览图与解析会话缓存。已载入的源与已下载文件不受影响。', { okText: '清理' })) return;
    clearCache._busy = true;
    const $btn = $('#cache_clear');
    $btn.prop('disabled', true);
    showLoading();

    let backendBytes = 0, backendMsg = '', backendItems = 0, appBytes = 0, appDetail = null, localBytes = 0, ok = false;
    // 本地命名空间清理前占用（用于 breakdown 的释放量估算）。
    let localBefore = 0;
    try { if (typeof localCacheStats === 'function') localBefore = localCacheStats().bytes || 0; } catch (e) { /* ignore */ }

    try {
        // 并行清理后端与主进程侧缓存（互不依赖）；本地持久化缓存同步执行（不阻塞网络）。
        const appClearP = (window.vpc && typeof window.vpc.clearAppCaches === 'function')
            ? window.vpc.clearAppCaches()
            : Promise.resolve(null);
        const [backendRes, appRes] = await Promise.allSettled([
            doAction('clearCache', {}, null, 8000),
            appClearP,
        ]);

        // 任务十一：清理渲染层本地持久化缓存（vpc_cache:: 命名空间：推荐榜单/时间表等），
        // 先 prune 过期再全清（同步、不阻塞网络）。
        try { if (typeof localCachePrune === 'function') localCachePrune(); } catch (e) { /* ignore */ }
        try { if (typeof localCacheClearAll === 'function') localCacheClearAll(); } catch (e) { /* ignore */ }
        // 顺带清理旧版独立缓存键（Bangumi 封面匹配 / 首页空分类探测 / 旧推荐缓存）
        try {
            localStorage.removeItem('kazumi_bgm_cover');
            localStorage.removeItem('vpc_home_empty_classes');
            localStorage.removeItem('popular_cache');
        } catch (e) { /* ignore */ }

        // 收集后端 breakdown
        if (backendRes.status === 'fulfilled') {
            const r = backendRes.value;
            if (r && r.code === 200) { ok = true; backendBytes = r.bytes || 0; backendMsg = r.msg || ''; backendItems = r.items || 0; }
        }
        // 收集主进程 app breakdown
        if (appRes.status === 'fulfilled') {
            const r2 = appRes.value;
            if (r2 && r2.ok) { ok = true; appBytes = r2.cleanedBytes || 0; appDetail = r2.detail || null; }
        }
        // 本地释放量 = 清理前后差（清理后应为 0，取前值为准）。
        let localAfter = 0;
        try { if (typeof localCacheStats === 'function') localAfter = localCacheStats().bytes || 0; } catch (e) { /* ignore */ }
        localBytes = Math.max(0, localBefore - localAfter);
        if (localBytes > 0) ok = true;
    } catch (e) {
        console.debug('[cache] clearCache error', e);
    } finally {
        hideLoading();
        clearCache._busy = false;
        $btn.prop('disabled', false);
        refreshCacheSize(true);
    }

    if (ok) {
        const total = backendBytes + appBytes + localBytes;
        warnToast(`已释放 ${fmtSize(total)}（后端 ${fmtSize(backendBytes)} · 应用 ${fmtSize(appBytes)} · 本地 ${fmtSize(localBytes)}）`);
        // 明细日志（后端消息 / 文件数 / 应用分项）供排查。
        if (backendMsg || backendItems || appDetail) {
            console.info('[cache] cleared', { backendBytes, backendItems, backendMsg, appBytes, appDetail, localBytes });
        }
    } else {
        warnToast('缓存清理失败');
    }
}

// ---------------------------------------------------------------- 设置：直播源

/** URL 中文域名（IDN）转 punycode，后端拉取才不会失败。 */
function asciiUrl(u) {
    try { return new URL(u).href; } catch (e) { return u; }
}

/**
 * 添加自定义直播源（持久化 settings.customLives，最新在前，去重）。
 * 支持三种输入（TVBox 式）：
 * - txt / m3u 直播源地址（存为 {name,url}）
 * - 粘贴的 TVBox 配置 JSON（提取 lives 数组批量导入）
 * - .json 配置地址（后端 fetchText 拉取后提取 lives）
 */
async function addLiveSource() {
    const raw = $('#live_src_url').val().trim();
    if (!raw) { warnToast('请输入直播源地址或 TVBox 配置'); return; }
    // 直接粘贴的 TVBox 配置 JSON
    if (raw.startsWith('{')) {
        let cfg = null;
        try { cfg = JSON.parse(raw); } catch (e) { warnToast('JSON 解析失败，请检查配置内容'); return; }
        if (!await importTvboxLives(cfg)) warnToast('配置中没有可用的 lives 直播源');
        return;
    }
    if (!/^https?:\/\//i.test(raw)) { warnToast('请输入 http/https 地址或直接粘贴 JSON 配置'); return; }
    const url = asciiUrl(raw);
    // TVBox 配置地址（.json）：拉取后提取 lives 批量导入
    if (/\.json(\?|#|$)/i.test(raw.split('#')[0])) {
        showLoading();
        try {
            const data = await doAction('fetchText', { url });
            const cfg = JSON.parse((data && data.text) || '');
            if (!await importTvboxLives(cfg)) warnToast('该配置中没有可用的 lives 直播源');
        } catch (e) {
            warnToast('配置读取或解析失败，请确认地址是 TVBox 配置（含 lives）');
        } finally { hideLoading(); }
        return;
    }
    // 普通 txt / m3u 直播源
    try {
        const s = (await window.vpc.settingsGet()) || {};
        let list = Array.isArray(s.customLives) ? s.customLives : [];
        const dup = list.some((x) => (typeof x === 'string' ? x : x.url) === url);
        if (dup) { warnToast('该直播源已添加'); return; }
        list.unshift({ name: url, url });
        if (list.length > 30) list = list.slice(0, 30);
        await window.vpc.settingsSet('customLives', list);
        $('#live_src_url').val('');
        renderLiveSources(list);
        warnToast('直播源已添加，到直播页下拉切换即可');
        // 置脏 + 立即刷新直播视图源列表（下次进入直播页也会强制重载）
        if (typeof Live !== 'undefined') { Live._dirty = true; if (Live._inited && Live.load) Live.load(); }
    } catch (e) { warnToast('添加失败'); }
}

/** 从 TVBox 配置对象提取 lives（展平嵌套 channels、归一化 proxy:// 形式）批量导入。 */
async function importTvboxLives(cfg) {
    const lives = Array.isArray(cfg && cfg.lives) ? cfg.lives : [];
    if (!lives.length || typeof Live === 'undefined') return 0;
    const flat = [];
    lives.forEach((l) => {
        if (l && Array.isArray(l.channels)) {
            l.channels.forEach((c) => (c.urls || []).forEach((u) => flat.push({ name: c.name || l.name || '', url: u })));
        } else {
            flat.push(l);
        }
    });
    const norm = flat.map((l) => Live.normalizeLive(l)).filter(Boolean);
    if (!norm.length) return 0;
    const s = (await window.vpc.settingsGet()) || {};
    let list = Array.isArray(s.customLives) ? s.customLives : [];
    let added = 0;
    norm.forEach((n) => {
        const dup = list.some((x) => (typeof x === 'string' ? x : x.url) === n.url);
        if (!dup) { list.unshift({ name: n.name, url: n.url }); added++; }
    });
    if (!added) { warnToast('该配置里的直播源都已添加'); return norm.length; }
    if (list.length > 30) list = list.slice(0, 30);
    await window.vpc.settingsSet('customLives', list);
    $('#live_src_url').val('');
    renderLiveSources(list);
    warnToast(`已从 TVBox 配置导入 ${added} 个直播源`);
    Live._dirty = true;
    if (Live._inited && Live.load) Live.load();
    return added;
}

function renderLiveSources(list) {
    const box = $('#live_src_list');
    box.empty();
    if (!(list || []).length) {
        box.html('<div class="tip-line">暂无自定义直播源。配置里自带的直播源会直接出现在直播页。</div>');
        return;
    }
    list.forEach((u, i) => {
        const name = typeof u === 'string' ? u : (u.name || u.url);
        const url = typeof u === 'string' ? u : u.url;
        const short = name.length > 70 ? name.slice(0, 70) + '…' : name;
        box.append(`<div class="history-item" title="${escHtml(url)}">
            <span class="history-url">${escHtml(short)}</span>
            <button class="history-btn live-src-del" data-idx="${i}" title="删除该直播源">✕</button>
        </div>`);
    });
}

async function removeLiveSource(idx) {
    try {
        const s = (await window.vpc.settingsGet()) || {};
        const list = Array.isArray(s.customLives) ? s.customLives : [];
        // T33：删除类操作统一二次确认
        if (!await confirmDialog('删除该直播源？', { okText: '删除' })) return;
        list.splice(idx, 1);
        await window.vpc.settingsSet('customLives', list);
        renderLiveSources(list);
        if (typeof Live !== 'undefined') { Live._dirty = true; if (Live._inited && Live.load) Live.load(); }
    } catch (e) { warnToast('删除失败'); }
}

// ---------------------------------------------------------------- 本地文件
// 本地文件板块：浏览白名单根目录下的文件/文件夹（主进程 file-manager 防路径穿越），
// 点击视频经 mpv 播放，支持上传（复制）/新建文件夹/右键删除/切换根目录。
// currentRoot=当前目录相对路径；dirNavStack 供 Esc 逐级回退。

// 分页：过滤后的项目（文件夹→视频→音频）统一排布，每页 LOCAL_PAGE_SIZE 条，
// 状态缓存于 _localPage（listFile 拉一次，翻页纯本地切片不重拉）。
const LOCAL_PAGE_SIZE = 100;
let _localPage = null;   // { path, parent, dirs, videos, audios }
let _localPageNo = 1;

/** 上级目录项（..，非根目录时置顶）。 */
function buildParentItem() {
    return `<a class="file-item" href="javascript:void(0)" onclick="goParent()">
    <img class="file-icon" src="${icDir}" alt="">
    <div class="file-info"><div class="file-name">..</div></div>
    </a>`;
}

/** 文件夹项：点击进入；右键弹删除文件夹确认。 */
function buildDirItem(name, time, path) {
    const ep = escPath(path);
    return `<a class="file-item" href="javascript:void(0)" oncontextmenu="showDelFolderDialog('${ep}',currentRoot);return false" onclick="enterDir('${ep}')">
    <img class="file-icon" src="${icDir}" alt="">
    <div class="file-info"><div class="file-name">${escHtml(name)}</div><div class="file-time">${escHtml(time)}</div></div>
    </a>`;
}

/** 文件项：点击弹信息确认框（可提交播放）；右键弹删除文件确认。 */
function buildFileItem(name, time, path) {
    const ep = escPath(path);
    return `<a class="file-item" href="javascript:void(0)" oncontextmenu="showDelFileDialog('${ep}');return false" onclick="selectFile('${ep}')">
    <img class="file-icon" src="${icFile}" alt="">
    <div class="file-info"><div class="file-name">${escHtml(name)}</div><div class="file-time">${escHtml(time)}</div></div>
    </a>`;
}

// 视频扩展名（与主进程 ffmpeg 抓帧/播放白名单一致）
const LOCAL_VIDEO_EXTS = ['.mp4', '.mkv', '.ts', '.flv', '.avi', '.mov', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm', '.m2ts'];
// 音频扩展名（与主进程 file-manager AUDIO_EXTS 一致；mpv 可直接播放）
const LOCAL_AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.oga', '.opus', '.m4a', '.wma', '.ape'];
function isLocalVideo(name) {
    const i = String(name).lastIndexOf('.');
    return i > 0 && LOCAL_VIDEO_EXTS.includes(String(name).slice(i).toLowerCase());
}
function isLocalAudio(name) {
    const i = String(name).lastIndexOf('.');
    return i > 0 && LOCAL_AUDIO_EXTS.includes(String(name).slice(i).toLowerCase());
}

/** 视频卡片（网格布局；预览图由 loadLocalThumbs 异步填充）。 */
function buildVideoCard(name, time, path) {
    const ep = escPath(path);
    return `<div class="local-card" data-thumb-rel="${ep}" oncontextmenu="showDelFileDialog('${ep}');return false" onclick="selectFile('${ep}')" title="${escHtml(name)}">
    <div class="local-thumb ph"><img src="${icFile}" alt=""></div>
    <div class="local-name">${escHtml(name)}</div>
    <div class="local-time">${escHtml(time)}</div>
    </div>`;
}

/** 异步加载视频预览图（主进程 ffmpeg 抓帧限并发；失败/缺 ffmpeg 保持占位图）。 */
function loadLocalThumbs() {
    $('#file_list .local-card').each(function () {
        const el = this;
        const rel = el.getAttribute('data-thumb-rel');
        if (!rel) return;
        window.vpc.fileThumb(rel).then((r) => {
            // 目录已切换则丢弃结果；仍同卡片才回填
            if (!r || !r.ok || !el.isConnected || el.getAttribute('data-thumb-rel') !== rel) return;
            const ph = el.querySelector('.local-thumb.ph');
            if (!ph) return;
            const img = document.createElement('img');
            img.className = 'local-thumb';
            img.src = 'file:///' + String(r.path).replace(/\\/g, '/');
            img.alt = '';
            ph.replaceWith(img);
        });
    });
}

/** 进入子目录（当前目录压栈供回退）。 */
function enterDir(path) {
    dirNavStack.push(currentRoot);
    listFile(path);
}

/** 返回上级目录（根目录时无效）。 */
function goParent() {
    if (currentParent !== '.') {
        dirNavStack.push(currentRoot);
        listFile(currentParent);
    }
}

/** 选中文件：展示路径信息确认框（确认后经 vpc:file-push 交 mpv 播放）。 */
function selectFile(path) {
    currentFile = path;
    $("#fileUrl").text("file:/" + path);
    openDialog('fileInfoDialog');
}

/** 信息确认框回调：yes===1 时提交播放（视频/音频；不支持的格式/缺 mpv 给对应提示）。 */
function pushFile(yes) {
    closeDialog('fileInfoDialog');
    if (yes !== 1) return;
    const target = String(currentFile || '').trim();
    if (!target) { warnToast('未选中文件'); return; }
    // 本地媒体直接交给主进程 mpv 播放；首播冷启动可能因 IPC 竞态短暂失败，自动重试一次
    const doPush = (rel, isRetry) => window.vpc.filePush(rel).then((r) => {
        if (r && r.ok) {
            warnToast('已在 mpv 窗口播放');
            // 记入历史记录（本地文件播放）：取文件名作为标题，来源标记「本地文件」
            try {
                const rel2 = String(currentFile || '');
                const name = rel2.split(/[\\/]/).pop() || rel2 || '本地文件';
                if (typeof Records !== 'undefined' && Records.recordPlay && !window._incognito) {
                    Records.recordPlay({
                        site: 'local',
                        siteName: '本地文件',
                        vodId: rel2,
                        name: name,
                        pic: '',
                        remarks: '本地文件',
                        episode: '',
                        seconds: 0,
                        totalEps: 0,
                    }).catch(() => { /* 历史记录失败不影响播放 */ });
                }
            } catch (e) { /* ignore */ }
            return;
        }
        // 首播 IPC 超时/提前退出的偶发失败（二次点击成功即为此竞态），自动重试一次
        if (!isRetry && r && (r.reason === 'mpv-start-timeout' || r.reason === 'mpv-exited-before-playback' || r.reason === 'mpv-exited')) {
            setTimeout(() => doPush(rel, true), 500);
            return;
        }
        if (r && r.reason === 'not-video') warnToast('仅支持直接播放视频/音频文件');
        else if (r && r.reason === 'file-not-found') warnToast('文件不存在或已被移动');
        else if (r && r.reason === 'path-denied') warnToast('路径不在白名单内');
        else if (r && r.reason === 'mpv-missing') warnToast('未检测到播放器，请在 设置 → 扩展 指定 mpv.exe 路径，或下载内置播放器');
        else if (r && r.reason === 'mpv-start-timeout') warnToast('播放器启动超时，请重试');
        else warnToast('播放失败' + (r && r.reason ? `：${r.reason}` : ''));
    }).catch(() => warnToast('播放失败'));
    doPush(target, false);
}

/** 未选根目录时的引导态（白名单未设置）。 */
function renderNeedRoot() {
    $('#file_list').html('<div class="tip-line">尚未选择根目录（白名单）</div>' +
        '<div style="text-align:center;padding:12px">' +
        '<button class="md-btn md-btn-filled" onclick="pickRoot()">选择根目录</button></div>');
    $('#local-pager').hide();
}

/** 刷新当前目录（不动导航栈；外部删除/拷入文件后手动同步视图；
 *  内容无变化时跳过重渲避免列表闪烁，T40）。 */
function refreshLocal() {
    listFile(currentRoot, true);
}

/** 分页条上/下一页回调（包装一层：顶层 let 不挂 window，inline onclick 不直接引用）。 */
function localPrev() { gotoLocalPage(_localPageNo - 1); }
function localNext() { gotoLocalPage(_localPageNo + 1); }

/** 分页条回调：页码夹紧合法区间后重新渲染当前页（纯本地切片，不重拉目录）。 */
function gotoLocalPage(n) {
    if (!_localPage) return;
    const total = _localPage.dirs.length + _localPage.videos.length + _localPage.audios.length;
    const pages = Math.max(1, Math.ceil(total / LOCAL_PAGE_SIZE));
    _localPageNo = Math.min(Math.max(1, n), pages);
    renderLocalPage();
    $('#view-tools').scrollTop(0);
}

/** 渲染当前页：页内仍保持 目录行 → 视频卡片网格 → 音频行 的分段顺序。 */
function renderLocalPage() {
    const st = _localPage;
    const items = st.dirs.concat(st.videos, st.audios);
    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / LOCAL_PAGE_SIZE));
    const page = Math.min(_localPageNo, pages);
    const slice = items.slice((page - 1) * LOCAL_PAGE_SIZE, page * LOCAL_PAGE_SIZE);
    const dirs = slice.filter((n) => n.dir === 1);
    const videos = slice.filter((n) => n.dir !== 1 && isLocalVideo(n.name));
    const audios = slice.filter((n) => n.dir !== 1 && isLocalAudio(n.name));
    // T54：先拼串再一次性写入 DOM，避免在 backdrop-filter 卡片内多次 append
    //      触发反复重栅格化导致的背景细闪
    const parts = [];
    if (st.parent !== '.') parts.push(buildParentItem());
    dirs.forEach((node) => parts.push(buildDirItem(node.name, node.time, node.path)));
    if (videos.length) parts.push(`<div class="local-grid">${videos.map((n) => buildVideoCard(n.name, n.time, n.path)).join('')}</div>`);
    audios.forEach((node) => parts.push(buildFileItem(node.name, node.time, node.path)));
    if (!total && st.parent === '.') parts.push('<div class="tip-line">（无视频/音频文件）</div>');
    $('#file_list').html(parts.join(''));
    if (videos.length) loadLocalThumbs();
    // 分页条：仅多于一页时展示
    if (pages > 1) {
        $('#local-page-info').text(`第 ${page} / ${pages} 页 · 共 ${total} 项`);
        $('#local-prev').prop('disabled', page <= 1);
        $('#local-next').prop('disabled', page >= pages);
        $('#local-pager').show();
    } else {
        $('#local-pager').hide();
    }
}

/** 弹系统目录选择框设定白名单根目录，成功后刷新列表。 */
function pickRoot() {
    window.vpc.filePickRoot().then((r) => {
        if (r && r.ok) {
            dirNavStack = [];
            listFile('');
        } else if (r && r.reason !== 'canceled') {
            warnToast('选择失败');
        }
    }).catch(() => warnToast('选择失败'));
}

/** 目录指纹（T40 刷新防闪烁）：路径 + 各条目 dir/名/时间序列化；
 *  刷新后指纹不变则跳过重渲（避免缩略图重拉导致列表闪烁）。 */
function _localFp(st) {
    return st.path + '|' + st.dirs.concat(st.videos, st.audios)
        .map((n) => `${n.dir ? 1 : 0}:${n.name}:${n.time}`).join(',');
}

/** 拉取并渲染目录列表（200ms 未返回先显示 loading；needRoot 转引导态；分页重置回第一页；silent=手动刷新，内容无变化不重渲）。 */
let _listSeq = 0; // M-30d：目录导航序号——快速连续导航时旧目录迟到响应丢弃
function listFile(relPath, silent) {
    const seq = ++_listSeq;
    const prevFp = silent && _localPage && _localPageNo === 1 ? _localFp(_localPage) : '';
    const loadingTimer = setTimeout(() => showLoading(), 200);
    window.vpc.fileList(relPath || '').then((info) => {
        clearTimeout(loadingTimer);
        hideLoading();
        if (seq !== _listSeq) return; // M-30d：旧目录迟到响应丢弃，防覆盖新目录/导航栈错位
        if (!info) { warnToast('载入失败'); return; }
        if (info.needRoot) { currentRoot = ''; currentParent = '.'; renderNeedRoot(); return; }
        const parent = info.parent;
        currentRoot = info.path || '';
        currentParent = parent;
        const array = info.files || [];
        // 仅展示文件夹与视频/音频，其余文件隐藏；缓存供分页切片
        const dirs = [], videos = [], audios = [];
        array.forEach(node => {
            if (node.dir === 1) dirs.push(node);
            else if (isLocalVideo(node.name)) videos.push(node);
            else if (isLocalAudio(node.name)) audios.push(node);
        });
        const next = { path: currentRoot, parent, dirs, videos, audios };
        if (prevFp && prevFp === _localFp(next)) { warnToast('目录内容无变化'); return; }
        _localPage = next;
        _localPageNo = 1;
        renderLocalPage();
    }).catch(() => {
        clearTimeout(loadingTimer);
        hideLoading();
        warnToast('载入失败');
    });
}

// 上传由主进程系统文件对话框选择 + 复制（无需经渲染层 FormData）
function uploadFile() {
    window.vpc.fileUpload(currentRoot || '').then((r) => {
        if (r && r.ok) {
            warnToast(`已复制 ${r.copied} 个文件`);
            listFile(currentRoot);
        } else if (r && r.reason !== 'canceled') {
            warnToast('上传失败');
        }
    }).catch(() => warnToast('上传失败'));
}

function showNewFolderDialog() {
    openDialog('newFolder');
}

function confirmNewFolder(yes) {
    closeDialog('newFolder');
    const name = $('#newFolderContent').val().trim();
    $('#newFolderContent').val('');
    if (yes !== 1 || name.length === 0) return;
    showLoading();
    window.vpc.fileNewFolder(currentRoot, name).then((r) => {
        hideLoading();
        if (r && r.ok) listFile(currentRoot);
        else warnToast('新增失败');
    }).catch(() => {
        hideLoading();
        warnToast('新增失败');
    });
}

function showDelFolderDialog(path, refreshPath) {
    pendingDelFolder = { path, refreshPath };
    $('#delFolderContent').text('是否删除 ' + path);
    openDialog('delFolder');
}

function confirmDelFolder(yes) {
    closeDialog('delFolder');
    if (yes !== 1 || !pendingDelFolder) { pendingDelFolder = null; return; }
    const { path, refreshPath } = pendingDelFolder;
    pendingDelFolder = null;
    showLoading();
    window.vpc.fileDelFolder(path).then((r) => {
        hideLoading();
        if (r && r.ok) listFile(refreshPath);
        else warnToast('删除失败');
    }).catch(() => {
        hideLoading();
        warnToast('删除失败');
    });
}

function showDelFileDialog(path) {
    currentFile = path;
    $('#delFileContent').text('是否删除 ' + path);
    openDialog('delFile');
}

function confirmDelFile(yes) {
    closeDialog('delFile');
    if (yes !== 1) return;
    showLoading();
    window.vpc.fileDelFile(currentFile).then((r) => {
        hideLoading();
        if (r && r.ok) listFile(currentRoot);
        else warnToast('删除失败');
    }).catch(() => {
        hideLoading();
        warnToast('删除失败');
    });
}

// ---------------------------------------------------------------- 初始化（app.js 启动时调用一次）

function initAuxPanels() {
    // T28：工具面板改本地文件独立板块，页签与 showToolPanel 已删；
    // 源配置迁入设置→源设置，控件 id 不变，绑定维持原位
    // 历史源：点击载入 / ✕ 删除
    $('#config_history')
        .on('click', '.history-del', function (e) {
            e.stopPropagation();
            removeConfigHistory(parseInt($(this).data('idx'), 10));
        })
        .on('click', '.history-item', function () {
            const list = (window._cfgHistoryCache || []);
            const u = list[parseInt($(this).data('idx'), 10)];
            if (u) useHistoryConfig(u);
        });
    // 目录返回交由全局 Esc 派发（common.js dispatchEsc）
    registerEsc(function () {
        if (dirNavStack.length) { listFile(dirNavStack.pop()); return true; }
        return false;
    });
    $('#setting_text').on('keydown', function (e) { if (e.key === 'Enter') { this.blur(); setting(); } });
    $('#newFolderContent').on('keydown', function (e) { if (e.key === 'Enter') { this.blur(); confirmNewFolder(1); } });
    initSettingsPanel();
}

// ---------------------------------------------------------------- mpv 键位自定义（T8）

/** 字号档位吸附（T12）：任意数值/旧档位 → 最近的明确档位 */
const SIZE_TIERS = [80, 90, 100, 110, 125, 150];
function snapSizeTier(v) {
    const n = parseInt(v, 10) || 100;
    let best = 100;
    for (const t of SIZE_TIERS) if (Math.abs(t - n) < Math.abs(best - n)) best = t;
    return String(best);
}

// 动作表与主进程 HK_DEF_KEYS 一致：[id, 说明, 默认键]
const HK_UI_ACTIONS = [
    ['pause', '暂停 / 继续', 'SPACE'],
    ['seekBack', '快退', 'LEFT'],
    ['seekFwd', '快进', 'RIGHT'],
    ['volUp', '音量加', 'UP'],
    ['volDown', '音量减', 'DOWN'],
    ['speedDown', '倍速减', '['],
    ['speedUp', '倍速加', ']'],
    ['speedReset', '恢复原速', 'BS'],
    ['frameBack', '上一帧', ','],
    ['frameFwd', '下一帧', '.'],
    ['fullscreen', '全屏切换', 'f'],
    ['screenshot', '截图', 's'],
];
let _hkKeys = HK_UI_ACTIONS.reduce((m, a) => { m[a[0]] = a[2]; return m; }, {});
let _hkCapturing = null; // 正在捕获的动作 id
let _hkNativeHandler = null; // 捕获阶段的 document keydown 监听（先于全局 Esc 派发）

const _hkEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 重复绑定的键名集合：同一键绑了两个动作时红标提示（mpv 以后绑定为准）。 */
function hkConflicts() {
    const seen = new Set(), dup = new Set();
    for (const v of Object.values(_hkKeys)) { if (seen.has(v)) dup.add(v); seen.add(v); }
    return dup;
}

function renderHotkeyRows() {
    const dup = hkConflicts();
    $('#hotkey_rows').html(HK_UI_ACTIONS.map(([id, label]) => `
        <div class="hk-row${dup.has(_hkKeys[id]) ? ' conflict' : ''}" data-action="${id}">
            <span class="hk-label">${label}</span>
            <button type="button" class="hk-key${_hkCapturing === id ? ' capturing' : ''}" data-action="${id}">${_hkCapturing === id ? '按新键…（Esc 取消）' : _hkEsc(_hkKeys[id])}</button>
        </div>`).join(''));
}

/** 浏览器键盘事件 → mpv 键名；不支持的键返回 null。Shift+字母按 mpv 习惯转大写。 */
function hkEvToKey(e) {
    const k = e.key;
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return null; // 单按修饰键不算
    let base = '';
    if (k === ' ') base = 'SPACE';
    else if (k === 'ArrowLeft') base = 'LEFT';
    else if (k === 'ArrowRight') base = 'RIGHT';
    else if (k === 'ArrowUp') base = 'UP';
    else if (k === 'ArrowDown') base = 'DOWN';
    else if (k === 'Backspace') base = 'BS';
    else if (k === 'Enter') base = 'ENTER';
    else if (k === 'Escape') base = 'ESC';
    else if (k === 'Tab') base = 'TAB';
    else if (k === 'Home') base = 'HOME';
    else if (k === 'End') base = 'END';
    else if (k === 'PageUp') base = 'PGUP';
    else if (k === 'PageDown') base = 'PGDWN';
    else if (k === 'Delete') base = 'DEL';
    else if (k === 'Insert') base = 'INS';
    else if (/^F\d{1,2}$/i.test(k)) base = k.toUpperCase();
    else if (k.length === 1) {
        if (/[A-Za-z]/.test(k)) base = e.shiftKey ? k.toUpperCase() : k.toLowerCase();
        else base = k;
    } else return null;
    let mod = '';
    if (e.ctrlKey) mod += 'Ctrl+';
    if (e.altKey) mod += 'Alt+';
    // Shift+字母已转大写表达；其余 Shift 组合不支持
    if (e.shiftKey && !/[A-Za-z]/.test(k)) return null;
    return mod + base;
}

function hkStopListener() {
    if (_hkNativeHandler) { document.removeEventListener('keydown', _hkNativeHandler, true); _hkNativeHandler = null; }
}

function hkCancelCapture() {
    _hkCapturing = null;
    hkStopListener();
    renderHotkeyRows();
}

/** 步长 + 键位一起持久化，并通知主进程重写 mpv input.conf。 */
async function saveHotkeys() {
    const hk = {
        seek: Math.max(1, Math.min(120, parseInt($('#set_hotkey_seek').val(), 10) || 5)),
        vol: Math.max(1, Math.min(20, parseInt($('#set_hotkey_vol').val(), 10) || 5)),
        speed: Math.max(0.05, Math.min(1, parseFloat($('#set_hotkey_speed').val()) || 0.1)),
        keys: Object.assign({}, _hkKeys),
    };
    $('#set_hotkey_seek').val(hk.seek);
    $('#set_hotkey_vol').val(hk.vol);
    $('#set_hotkey_speed').val(hk.speed);
    await window.vpc.settingsSet('playerHotkeys', hk);
    if (window.vpc.updateHotkeys) window.vpc.updateHotkeys();
}

// ---------------------------------------------------------------- 网盘 Cookie（JAR 网盘源播放，T-jar-cookie）

const PAN_COOKIE_ORDER = ['quark', 'uc', 'tianyi', 'baidu', 'p123', 'xunlei'];
const PAN_COOKIE_HINT = {
    quark: '夸克网盘 · 扫码登录或粘贴 Cookie（pan.quark.cn）',
    uc: 'UC 网盘 · 粘贴 Cookie（drive.uc.cn）',
    tianyi: '天翼云盘 · 粘贴 Cookie（cloud.189.cn）',
    baidu: '百度网盘 · 粘贴 Cookie（pan.baidu.com，需含 BDUSS）',
    p123: '123 云盘 · 粘贴 Cookie（www.123pan.com）',
    xunlei: '迅雷云盘 · 粘贴 Cookie（pan.xunlei.com）',
};
let _panCookies = {};

/** 读取后端保存的网盘 Cookie 并渲染输入框（后端不支持时静默）。 */
async function loadPanCookieFields() {
    try {
        const r = await doAction('panCookie', { act: 'get' });
        _panCookies = (r && r.cookies) || {};
        const names = (r && r.names) || {};
        const box = $('#pan_cookie_fields').empty();
        PAN_COOKIE_ORDER.forEach((key) => {
            const label = (names && names[key]) || key;
            const hint = PAN_COOKIE_HINT[key] || '';
            const has = !!(_panCookies[key] || '').trim();
            box.append(
                `<div class="pan-cookie-item ${has ? 'pan-cookie-filled' : ''}">` +
                `<div class="pan-cookie-head"><span class="pan-cookie-name">${escHtml(label)}</span>` +
                `<span class="pan-cookie-state">${has ? '已配置' : '未配置'}</span></div>` +
                `<div class="tip-line pad0 pan-cookie-hint">${escHtml(hint)}</div>` +
                `<div class="pan-cookie-input-wrap">` +
                `<textarea id="pan_cookie_${key}" class="md-input pan-cookie-input pan-cookie-masked" rows="2"></textarea>` +
                `<button type="button" class="pan-cookie-eye" data-for="pan_cookie_${key}" title="显示/隐藏 Cookie">👁</button>` +
                `</div>` +
                '</div>');
            $(`#pan_cookie_${key}`).val(_panCookies[key] || '');
        });
    } catch (e) { /* 后端不支持时静默 */ }
}

/** 收集输入框内容并保存到后端；空值清空对应项。 */
async function savePanCookies() {
    const cookies = {};
    PAN_COOKIE_ORDER.forEach((key) => {
        const v = $(`#pan_cookie_${key}`).val().trim();
        if (v) cookies[key] = v;
    });
    try {
        const r = await doAction('panCookie', { act: 'set', cookies: JSON.stringify(cookies) });
        if (r && r.code === 200) {
            const n = Object.keys(cookies).length;
            _panCookies = cookies;
            await loadPanCookieFields(); // 重建输入框，按最新状态刷新「已配置/未配置」徽标
            const warns = Array.isArray(r.warnings) ? r.warnings : [];
            const status = $('#pan_cookie_status');
            if (warns.length) {
                status.html(`<span style="color:var(--md-error)">已保存 ${n} 项，但有以下问题：</span><br>` +
                    warns.map((w) => '⚠ ' + escHtml(w)).join('<br>'));
                warnToast(`已保存 ${n} 项，但有 ${warns.length} 个警告（见下方提示）`);
            } else {
                status.text(n ? `已保存 ${n} 项网盘 Cookie；保存后重新进入网盘影片的播放即可生效` : '已清空全部网盘 Cookie')
                    .css('color', 'var(--md-primary)');
                warnToast(n ? `已保存 ${n} 项网盘 Cookie` : '已清空网盘 Cookie');
            }
        } else {
            $('#pan_cookie_status').text('保存失败').css('color', 'var(--md-error)');
            warnToast('保存失败');
        }
    } catch (e) {
        $('#pan_cookie_status').text('保存失败：' + (e && e.message ? e.message : e)).css('color', 'var(--md-error)');
        warnToast('保存失败');
    }
}

function initPanCookiePanel() {
    loadPanCookieFields();
    $('#pan_cookie_save').on('click', savePanCookies);
    $('#pan_cookie_clear').on('click', async () => {
        if (!await confirmDialog('确定清空全部网盘 Cookie？清空后需重新登录或粘贴才能播放网盘源影片。', { okText: '清空' })) return;
        PAN_COOKIE_ORDER.forEach((k) => $(`#pan_cookie_${k}`).val(''));
        savePanCookies();
    });
    // 输入内容变化时实时刷新「已配置/未配置」徽标
    $('#pan_cookie_fields').on('input', 'textarea', (e) => {
        const key = String(e.currentTarget.id || '').replace('pan_cookie_', '');
        if (!key) return;
        const has = !!String(e.currentTarget.value || '').trim();
        $(e.currentTarget).closest('.pan-cookie-item')
            .toggleClass('pan-cookie-filled', has)
            .find('.pan-cookie-state').text(has ? '已配置' : '未配置');
    });
    // Cookie 遮蔽显示（与 Bangumi token 一致，默认隐藏文字）：聚焦显示明文便于
    // 编辑，失焦自动重新遮蔽；右上角眼睛按钮手动切换。焦点转移到眼睛时不触发遮蔽。
    $('#pan_cookie_fields').on('focusin', 'textarea', (e) => {
        $(e.currentTarget).removeClass('pan-cookie-masked');
    });
    $('#pan_cookie_fields').on('focusout', 'textarea', (e) => {
        const to = e.relatedTarget;
        if (to && to.closest && $(to).closest('.pan-cookie-eye').length) return;
        $(e.currentTarget).addClass('pan-cookie-masked');
    });
    $('#pan_cookie_fields').on('click', '.pan-cookie-eye', (e) => {
        const $t = $('#' + String($(e.currentTarget).data('for') || ''));
        if (!$t.length) return;
        if ($t.hasClass('pan-cookie-masked')) $t.removeClass('pan-cookie-masked').trigger('focus');
        else $t.blur(); // blur → focusout → 重新遮蔽
    });
    $('#pan_cookie_qr').on('click', openQuarkQrLogin);
    $('#pan_qr_refresh').on('click', () => {
        // 取消/失败后重试：关闭旧窗口（如有）并重新打开
        _panQrClosed = true;
        try { window.vpc.panQrCancel(); } catch (e) { /* ignore */ }
        setTimeout(() => openQuarkQrLogin(), 200);
    });
    $('#pan_qr_close').on('click', () => {
        _panQrClosed = true;
        try { window.vpc.panQrCancel(); } catch (e) { /* ignore */ }
        closeDialog('panQrDialog');
    });
}

// ---------------------------------------------------------------- 夸克扫码登录

let _panQrClosed = false;

/** 打开夸克扫码登录：弹出官方登录窗口 → 等待登录 → 自动保存 Cookie。 */
async function openQuarkQrLogin() {
    _panQrClosed = false;
    $('#pan_qr_img').html('<span style="color:var(--md-outline);font-size:13px;">正在打开登录窗口…</span>');
    $('#pan_qr_tip').text('正在打开夸克官方登录页面，请在弹出的窗口中用「夸克 App」扫码登录…')
        .css('color', '');
    $('#pan_qr_refresh').hide();
    openDialog('panQrDialog');
    let res = null;
    try {
        // 官方页面方案：主进程开官方落地页窗口，官方 JS 完成登录后收割完整 Cookie
        res = await window.vpc.panQrLogin();
    } catch (e) { /* 下方统一处理 */ }
    if (_panQrClosed) return;
    if (res && res.ok && res.cookies) {
        $('#pan_qr_tip').text('登录成功，正在保存 Cookie…').css('color', 'var(--md-primary)');
        // 保存到后端（quark 项）并刷新输入框
        try {
            await doAction('panCookie', { act: 'set', cookies: JSON.stringify({ quark: res.cookies }) });
        } catch (e) { /* 保存失败提示见下 */ }
        await loadPanCookieFields();
        $('#pan_cookie_status').text('夸克扫码登录成功，Cookie 已自动保存').css('color', 'var(--md-primary)');
        $('#pan_qr_tip').text('登录成功，Cookie 已自动保存').css('color', 'var(--md-primary)');
        setTimeout(() => closeDialog('panQrDialog'), 1200);
    } else {
        $('#pan_qr_tip').text(String((res && res.message) || '登录取消'))
            .css('color', 'var(--md-error)');
    }
}

function stopQuarkQrTimers() { /* 官方窗口方案无需前端定时器 */ }

function initSettingsPanel() {
    // 设置一级菜单（T12）：点大类只显示对应二级详情卡片；记忆上次分类
    const showSetCat = (cat) => {
        // 先回顶再切换分类：分类卡片高度差异大，容器行高随之变化，
        // 若在滚动中途切换，吸顶导航的 sticky 行程会突变导致按钮列表上下跳动。
        // 先滚回顶部让导航处于文档流顶部，行高变化即无位移。
        $('#view-settings').scrollTop(0);
        $('#settings-nav .settings-nav-item').removeClass('active')
            .filter(`[data-cat="${cat}"]`).addClass('active');
        $('#view-settings .tool-card[data-setcat]').each(function () {
            $(this).toggle(String($(this).data('setcat')) === cat);
        });
        if (cat === 'about' && typeof About !== 'undefined' && About.enter) About.enter();
    };
    showSetCat('appearance'); // 先按默认分类收纳，回填后切到记忆分类
    $('#settings-nav').on('click', '.settings-nav-item', function () {
        const cat = String($(this).data('cat'));
        showSetCat(cat);
        window.vpc.settingsSet('settingsCat', cat);
    });
    // 播放设置：载入持久化值，改动即存
    window.vpc.settingsGet().then((s) => {
        s = s || {};
        // 分类重新划分后旧记忆值（cache/asset）可能失效：仅在分类仍存在时恢复，否则回退外观
        if (s.settingsCat && $(`#view-settings .tool-card[data-setcat="${String(s.settingsCat).replace(/"/g, '')}"]`).length) showSetCat(s.settingsCat);
        if (s.playerVolume) $('#set_volume').val(s.playerVolume);
        // 上次配置回填 + 历史源列表
        if (s.lastConfigUrl) $('#setting_text').val(s.lastConfigUrl);
        const list = Array.isArray(s.configHistory) ? s.configHistory : [];
        window._cfgHistoryCache = list;
        renderConfigHistory(list);
        getJson('/sites').then(renderConfigDiagnostics).catch(() => {});
        // 自定义直播源列表
        renderLiveSources(Array.isArray(s.customLives) ? s.customLives : []);
        // 外观：各选项回填 + 壁纸路径缓存
        if (s.theme) $('#set_theme').val(s.theme);
        if (s.customTheme) $('#set_theme_pick').val(s.customTheme);
        if (s.colorMode) $('#set_colormode').val(s.colorMode);
        // 界面缩放/字体大小档位回填（空=标准 100；兼容旧数值/ xs/sm/lg/xl 档位，吸附到最近档位）
        const _legacyPct = { xs: 80, sm: 90, lg: 110, xl: 125 };
        $('#set_fontsize').val(snapSizeTier(s.fontSize ? (parseInt(s.fontSize, 10) || _legacyPct[s.fontSize] || 100) : 100));
        $('#set_textsize').val(snapSizeTier(s.textSize ? (parseInt(s.textSize, 10) || _legacyPct[s.textSize] || 100) : 100));
        if (s.textColor) {
            // 预设项回填下拉，自定义色回填取色器
            if ($('#set_textcolor option[value="' + s.textColor + '"]').length) $('#set_textcolor').val(s.textColor);
            $('#set_textcolor_pick').val(s.textColor);
        }
        if (s.wallpaperDim) $('#set_walldim').val(s.wallpaperDim);
        $('#set_system_titlebar').prop('checked', s.systemTitleBar === true);
        $('#set_anim').prop('checked', s.animEnabled !== false); // 界面动画（T73：改为与 MiSans 一致的开关）
        $('#set_glass').prop('checked', s.glass === true); // 毛玻璃效果（默认关）
        // 每页条数（T39：首页/搜索/收藏/历史各自一项；首页兼容旧键 listPageSize）
        if (s.pageSizeHome || s.listPageSize) $('#set_pagesize_home').val(s.pageSizeHome || s.listPageSize);
        if (s.pageSizeSearch) $('#set_pagesize_search').val(s.pageSizeSearch);
        if (s.pageSizeFavorites) $('#set_pagesize_fav').val(s.pageSizeFavorites);
        if (s.pageSizeHistory) $('#set_pagesize_history').val(s.pageSizeHistory);
        if (s.pageSizeLive) $('#set_pagesize_live').val(s.pageSizeLive);
        if (s.pageSizePopular) $('#set_pagesize_popular').val(s.pageSizePopular);
        $('#set_pan_fast_path').prop('checked', s.panFastPath !== false);
        $('#set_media_probe').prop('checked', s.mediaProbe !== false);
        $('#set_auto_line_fallback').prop('checked', s.autoLineFallback !== false);
        $('#set_legacy_parser').prop('checked', s.legacyParser !== false);
        // 源设置：后台自动检测/屏蔽无内容源（默认沿用旧行为）
        $('#set_source_autodetect').prop('checked', s.sourceAutoDetect !== false);
        window._wallpaperUrl = s.wallpaper ? toFileUrl(s.wallpaper) : '';
        // 播放偏好：默认倍速 / 连播 / 续播 / 后台播放
        $('#set_speed').val(String(s.playerSpeed || '1'));
        if (s.playerAlang) $('#set_alang').val(s.playerAlang);
        if (s.playerSlang) $('#set_slang').val(s.playerSlang);
         $('#set_autonext').prop('checked', s.autoNext !== false);
         $('#set_resumepos').prop('checked', s.resumePos !== false);
         $('#set_bgplay').prop('checked', s.bgPlay !== false);
         if (s.watchStatsEnabled !== false) $('#set_watchstats').prop('checked', true);
         else $('#set_watchstats').prop('checked', false);
         $('#set_simuldl').prop('checked', !!s.simulDownload); // 边下边播（默认关）
        $('#set_danmaku').prop('checked', !!s.danmakuEnable); // 自动加载弹幕（默认关）
        $('#set_hls_adfilter').prop('checked', !!s.hlsAdFilter); // m3u8 广告过滤（默认关）
        $('#set_anime4k').prop('checked', !!s.anime4k);
        // 系统：关闭行为 / 隐身模式 / 缓存位置
        $('#set_closeaction').val(s.closeAction || 'tray');
        $('#set_incognito').prop('checked', !!s.incognito);
        // 系统：启动进入页面 / 应用内错误提示；外观：MiSans 字体
        $('#set_startup_view').val(s.startupView || 'home');
        $('#set_error_toast').prop('checked', s.errorToast !== false);
        $('#set_use_misans').prop('checked', s.useMisansFont !== false);
        // 源设置：CatVod 详情页自动匹配 Bangumi 数据（T74 开关，默认关）
        $('#set_catvod_bgm_match').prop('checked', s.catvodBgmMatch === true);
        // 系统：网络代理
        $('#set_proxy_url').val(s.proxyUrl || '');
        // 代理开关严格按持久化值回填（proxyEnable === true 才开），避免旧版本/脏数据下误显示为开
        $('#set_proxy_enable').prop('checked', s.proxyEnable === true);
        // 系统：代理连通性测试：回填上次测试 URL
        $('#set_proxy_test_url').val(s.proxyTestUrl || '');
        // 系统：日志级别 + 定时清空日志
        $('#set_log_level').val(String(s.logLevel || 'INFO'));
        $('#set_log_autocleanup').prop('checked', s.logAutoCleanup === true);
        $('#set_log_cleanup_days').val(s.logCleanupDays ? String(s.logCleanupDays) : '');
        refreshCacheDirLine(s.cacheDir);
        // 下载：目录展示（读持久化值，不拉起 aria2）+ 并发数回填
        refreshDlDirLine(s.dlDir);
        $('#set_dl_concurrency').val(String(s.dlConcurrency || '3'));
        $('#set_dl_split').val(String(s.dlSplitConcurrency || '5'));
        // 快捷键步长回填
        const hk = s.playerHotkeys || {};
        if (hk.seek) $('#set_hotkey_seek').val(hk.seek);
        if (hk.vol) $('#set_hotkey_vol').val(hk.vol);
        if (hk.speed) $('#set_hotkey_speed').val(hk.speed);
        if (hk.keys && typeof hk.keys === 'object') {
            for (const [id] of HK_UI_ACTIONS) if (hk.keys[id]) _hkKeys[id] = hk.keys[id];
        }
        renderHotkeyRows();
        if (s.anime4kMode) $('#set_anime4k_mode').val(s.anime4kMode);
        // 屏蔽源计数行
        updateBlockedLine(s);
    }).catch(() => { });
    $('#set_volume').on('change', function () {
        const v = Math.max(0, Math.min(100, parseInt(this.value, 10) || 0));
        this.value = v;
        window.vpc.settingsSet('playerVolume', v);
    });
    // 直播源：添加 / 删除
    $('#live_src_add').on('click', addLiveSource);
    $('#live_src_url').on('keydown', function (e) { if (e.key === 'Enter') { this.blur(); addLiveSource(); } });
    $('#live_src_list').on('click', '.live-src-del', function () {
        removeLiveSource(parseInt($(this).data('idx'), 10));
    });
    // 直链播放：粘贴链接 → 自动解析 → mpv
    $('#direct_play_go').on('click', playDirectLink);
    $('#direct_play_url').on('keydown', function (e) { if (e.key === 'Enter') { this.blur(); playDirectLink(); } });
    // 外观：主题/明暗/缩放/壁纸遮罩即时生效并持久化
    // 主题：选内置预设时清自定义色；取色器选色时清预设（两者互斥）
    $('#set_theme').on('change', function () {
        window.vpc.settingsSet('theme', this.value);
        window.vpc.settingsSet('customTheme', '');
        applySkin({ theme: this.value, customColor: '' });
    });
    $('#set_theme_pick').on('change', function () {
        window.vpc.settingsSet('customTheme', this.value);
        $('#set_theme').val('');
        window.vpc.settingsSet('theme', '');
        applySkin({ customColor: this.value });
    });
    $('#set_theme_clear').on('click', async () => {
        // T40：恢复默认主题前二次确认
        if (!await confirmDialog('恢复默认主题？自定义主题色会一并清除。', { okText: '恢复' })) return;
        $('#set_theme').val('');
        window.vpc.settingsSet('theme', '');
        window.vpc.settingsSet('customTheme', '');
        applySkin({ theme: '', customColor: '' });
    });
    $('#set_colormode').on('change', function () {
        window.vpc.settingsSet('colorMode', this.value);
        applySkin({ colorMode: this.value });
    });
    $('#set_fontsize').on('change', function () {
        // 明确档位下拉（T12）：选中即生效，100 为标准
        const v = parseInt(this.value, 10) || 100;
        window.vpc.settingsSet('fontSize', v === 100 ? '' : v);
        applySkin({ fontSize: v });
    });
    // 字体大小（仅文字）与字体颜色
    $('#set_textsize').on('change', function () {
        const v = parseInt(this.value, 10) || 100;
        window.vpc.settingsSet('textSize', v === 100 ? '' : v);
        applySkin({ textSize: v });
    });
    const applyTextColor = (c) => {
        window.vpc.settingsSet('textColor', c);
        applySkin({ textColor: c });
    };
    $('#set_textcolor').on('change', function () {
        if (this.value) $('#set_textcolor_pick').val(this.value);
        applyTextColor(this.value);
    });
    $('#set_textcolor_pick').on('change', function () {
        $('#set_textcolor').val('');
        applyTextColor(this.value);
    });
    $('#set_textcolor_clear').on('click', async () => {
        // T40：恢复默认字体颜色前二次确认
        if (!await confirmDialog('恢复默认字体颜色？', { okText: '恢复' })) return;
        $('#set_textcolor').val('');
        applyTextColor('');
    });
    // 快捷键步长/键位：持久化并通知主进程重写 mpv input.conf（saveHotkeys 见上方键位模块）
    $('#set_hotkey_seek, #set_hotkey_vol, #set_hotkey_speed').on('change', async () => {
        await saveHotkeys();
        warnToast('快捷键已保存，下次起播生效');
    });
    // 键位捕获：点击键位按钮后监听下一个按键；Esc 取消。
    // 用捕获阶段原生监听：先于全局 Esc 派发（冒泡），避免取消时顺带关闭设置页
    $('#hotkey_rows').on('click', '.hk-key', function () {
        _hkCapturing = String($(this).data('action'));
        renderHotkeyRows();
        hkStopListener();
        _hkNativeHandler = (e) => {
            if (!_hkCapturing) { hkStopListener(); return; }
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { hkCancelCapture(); return; }
            const k = hkEvToKey(e);
            if (!k) return; // 单按修饰键/不支持的键，继续等
            const action = _hkCapturing;
            _hkKeys[action] = k;
            _hkCapturing = null;
            hkStopListener();
            renderHotkeyRows();
            saveHotkeys();
            if (hkConflicts().has(k)) warnToast(`注意：${k} 绑定了多个动作，播放时后绑定者生效`);
            else warnToast(`已将「${HK_UI_ACTIONS.find((a) => a[0] === action)[1]}」设为 ${k}，下次起播生效`);
        };
        document.addEventListener('keydown', _hkNativeHandler, true);
    });
    // 恢复默认键位（T40：二次确认）
    $('#hotkey_reset').on('click', async () => {
        if (!await confirmDialog('恢复默认快捷键？自定义键位会一并清除。', { okText: '恢复' })) return;
        _hkKeys = HK_UI_ACTIONS.reduce((m, a) => { m[a[0]] = a[2]; return m; }, {});
        hkCancelCapture();
        await saveHotkeys();
        warnToast('已恢复默认键位，下次起播生效');
    });
    // 打开截图目录（T46：mpv 截图功能）
    $('#hotkey_screenshot_dir').on('click', async () => {
        const r = await window.vpc.mpvScreenshotDir();
        if (!r || !r.ok) warnToast('打开截图目录失败：' + ((r && r.reason) || '未知错误'));
    });
    // 默认倍速：持久化并通知主进程（下次起播生效）
    $('#set_speed').on('change', function () {
        window.vpc.settingsSet('playerSpeed', parseFloat(this.value) || 1);
        if (window.vpc.updatePlayerPrefs) window.vpc.updatePlayerPrefs();
        warnToast('默认倍速已保存，下次起播生效');
    });
    // mpv 语言偏好（音轨/字幕）：持久化并通知主进程，下次起播注入 --alang/--slang
    $('#set_alang').on('change', function () {
        window.vpc.settingsSet('playerAlang', this.value);
        if (window.vpc.updatePlayerPrefs) window.vpc.updatePlayerPrefs();
        warnToast('音轨语言偏好已保存，下次起播生效');
    });
    $('#set_slang').on('change', function () {
        window.vpc.settingsSet('playerSlang', this.value);
        if (window.vpc.updatePlayerPrefs) window.vpc.updatePlayerPrefs();
        warnToast('字幕语言偏好已保存，下次起播生效');
    });
    // 自动连播 / 记忆位置 / 后台播放开关
    $('#set_autonext').on('change', function () {
        window.vpc.settingsSet('autoNext', this.checked);
        warnToast(this.checked ? '已开启自动连播' : '已关闭自动连播（只播当前集）');
    });
    $('#set_resumepos').on('change', function () {
        window.vpc.settingsSet('resumePos', this.checked);
        if (window.vpc.updatePlayerPrefs) window.vpc.updatePlayerPrefs();
        warnToast(this.checked ? '已开启记忆播放位置' : '已关闭记忆播放位置');
    });
    $('#set_bgplay').on('change', function () {
        window.vpc.settingsSet('bgPlay', this.checked);
    });
    $('#set_watchstats').on('change', function () {
        window.vpc.settingsSet('watchStatsEnabled', this.checked);
        warnToast(this.checked ? '已开启观看统计' : '已关闭观看统计（已有数据保留）');
    });
    // 边下边播：仅持久化，主进程起播时读取（无需通知，下次起播即生效）
    $('#set_simuldl').on('change', function () {
        window.vpc.settingsSet('simulDownload', this.checked);
        warnToast(this.checked ? '已开启边下边播（下次起播生效）' : '已关闭边下边播');
    });
    // 自动加载弹幕：仅持久化，播放时 player.js 读取（下次起播生效）
    $('#set_danmaku').on('change', function () {
        window.vpc.settingsSet('danmakuEnable', this.checked);
        warnToast(this.checked ? '已开启自动加载弹幕（下次起播生效）' : '已关闭自动加载弹幕');
    });
    // m3u8 广告过滤：仅持久化，addHls 时主进程读取（下一个任务生效）
    $('#set_hls_adfilter').on('change', function () {
        window.vpc.settingsSet('hlsAdFilter', this.checked);
        warnToast(this.checked ? '已开启 m3u8 广告过滤（实验性）' : '已关闭 m3u8 广告过滤');
    });
    $('#set_pan_fast_path').on('change', async function () {
        const enabled = this.checked;
        await window.vpc.settingsSet('panFastPath', enabled);
        try {
            const result = await window.vpc.setPanFastPath(enabled);
            warnToast(result && result.ok
                ? `已${enabled ? '开启' : '关闭'}夸克网盘快路径，后端正在重启`
                : `设置已保存，但后端重启失败：${(result && result.reason) || '未知错误'}`);
        } catch (e) {
            warnToast('设置已保存，后端将在下次启动时生效');
        }
    });
    $('#set_media_probe').on('change', async function () {
        const enabled = this.checked;
        await window.vpc.settingsSet('mediaProbe', enabled);
        warnToast(enabled ? '已开启起播前媒体流探测' : '已关闭起播探测（直接交由播放器处理）');
    });
    $('#set_auto_line_fallback').on('change', async function () {
        const enabled = this.checked;
        await window.vpc.settingsSet('autoLineFallback', enabled);
        warnToast(enabled ? '已开启同影片备用线路自动回退' : '已关闭备用线路自动回退');
    });
    $('#set_legacy_parser').on('change', async function () {
        const enabled = this.checked;
        await window.vpc.settingsSet('legacyParser', enabled);
        warnToast(enabled ? '已开启简易解析器与 iframe 跟随' : '已关闭简易解析器与 iframe 跟随');
    });
    // 源自动检测：关闭后停止后台探测，并恢复展示历史上被自动屏蔽的源
    $('#set_source_autodetect').on('change', async function () {
        const enabled = this.checked;
        let saved = false;
        try {
            if (typeof Home !== 'undefined' && Home.setAutoProbeEnabled) Home.setAutoProbeEnabled(enabled);
            await window.vpc.settingsSet('sourceAutoDetect', enabled);
            saved = true;
            const s = (await window.vpc.settingsGet()) || {};
            s.sourceAutoDetect = enabled;
            updateBlockedLine(s);
            if (typeof Home !== 'undefined' && Home._inited) await Home.loadSites();
            warnToast(enabled
                ? '已开启源自动检测（可能自动隐藏无内容源）'
                : '已关闭源自动检测，历史被屏蔽的源已恢复显示');
        } catch (e) {
            if (!saved) {
                this.checked = !enabled;
                if (typeof Home !== 'undefined' && Home.setAutoProbeEnabled) Home.setAutoProbeEnabled(!enabled);
                warnToast('源自动检测设置保存失败');
            } else {
                warnToast('源自动检测已保存，但源列表刷新失败');
            }
        }
    });
    // Anime4K 动漫超分：持久化并通知主进程（下次起播注入着色器；文件缺失自动跳过）。
    // 开启时按资产状态提示真实可用性（着色器未下载/不完整则本次开关暂不生效）
    $('#set_anime4k').on('change', function () {
        window.vpc.settingsSet('anime4k', this.checked);
        if (window.vpc.updatePlayerPrefs) window.vpc.updatePlayerPrefs();
        if (this.checked) {
            const a4k = _assetStatus && _assetStatus.anime4k;
            if (a4k && !a4k.ready) {
                warnToast('Anime4K 着色器尚未就绪（自动下载中或下载失败），开关暂不生效');
            } else {
                warnToast('已开启 Anime4K 超分（下次起播生效）');
            }
        } else {
            warnToast('已关闭 Anime4K 超分');
        }
    });
    // Anime4K 档位：持久化并通知主进程（下次起播注入对应着色器链）
    $('#set_anime4k_mode').on('change', function () {
        window.vpc.settingsSet('anime4kMode', this.value);
        if (window.vpc.updatePlayerPrefs) window.vpc.updatePlayerPrefs();
        warnToast('Anime4K 档位已保存，下次起播生效');
    });
    // 界面动画开关（T73：由下拉改为与 MiSans 一致的开关）
    $('#set_anim').on('change', function () {
        const on = this.checked;
        window.vpc.settingsSet('animEnabled', on);
        applySkin({ animEnabled: on });
    });
    // 毛玻璃效果开关：卡片/面板背景启用 backdrop-filter 模糊，透出下层内容
    $('#set_glass').on('change', function () {
        const on = this.checked;
        window.vpc.settingsSet('glass', on);
        applySkin({ glass: on });
    });
    // 每页影片数量（T39：首页/搜索/收藏/历史各自持久化，作废渲染层缓存，下次进列表页生效）
    [['#set_pagesize_home', 'pageSizeHome'], ['#set_pagesize_search', 'pageSizeSearch'],
     ['#set_pagesize_fav', 'pageSizeFavorites'], ['#set_pagesize_history', 'pageSizeHistory'],
     ['#set_pagesize_live', 'pageSizeLive'], ['#set_pagesize_popular', 'pageSizePopular']].forEach(([sel, key]) => {
        $(sel).on('change', function () {
            window.vpc.settingsSet(key, this.value);
            if (typeof invalidatePageSizeCache === 'function') invalidatePageSizeCache();
            warnToast('每页条数已保存，下次进入对应页面生效');
        });
    });
    // 关闭主窗口行为
    $('#set_closeaction').on('change', function () {
        window.vpc.settingsSet('closeAction', this.value);
    });
    // 启动进入页面
    $('#set_startup_view').on('change', function () {
        window.vpc.settingsSet('startupView', this.value);
    });
    // 应用内错误提示开关
    $('#set_error_toast').on('change', function () {
        window.vpc.settingsSet('errorToast', this.checked);
        if (typeof setErrorToastEnabled === 'function') setErrorToastEnabled(this.checked);
    });
    // MiSans 界面字体开关（即时生效：注入/卸载字体 <link>，不整页 reload——
    // reload 会重启渲染层并把用户从设置页踢回首页）
    $('#set_use_misans').on('change', async function () {
        window.vpc.settingsSet('useMisansFont', this.checked);
        await applyMisansFont(this.checked);
    });
    // 源设置：CatVod 详情页自动匹配 Bangumi 数据（T74 开关，默认关）
    $('#set_catvod_bgm_match').on('change', function () {
        window.vpc.settingsSet('catvodBgmMatch', this.checked);
    });
    // 网络代理：保存并应用（先连通性测试，通过才启用 —— 仿 Kazumi proxyConfigured 门；重启后端使 Python requests 生效）
    $('#set_proxy_save').on('click', async () => {
        const url = $('#set_proxy_url').val().trim();
        const enable = $('#set_proxy_enable').prop('checked');
        if (enable && !url) { warnToast('请填写代理地址'); return; }
        if (enable) {
            // 开启前先走连通性测试：失败则不启用（避免保存一个不可用代理，与 Kazumi 一致）
            const testUrl = $('#set_proxy_test_url').val().trim() || 'https://www.google.com/generate_204';
            $('#set_proxy_test_result').text('测试中…').css('color', 'var(--md-on-surface-variant)');
            let r;
            try { r = await window.vpc.testProxy({ proxyUrl: url, url: testUrl }); } catch (e) { r = null; }
            if (!r || !r.ok) {
                $('#set_proxy_test_result').text('启用失败：' + ((r && r.reason) || '连通性测试未通过')).css('color', 'var(--md-error)');
                $('#set_proxy_enable').prop('checked', false);
                warnToast('代理连通性测试未通过，未启用');
                return;
            }
            $('#set_proxy_test_result').text(`✓ 连通 · ${r.elapsedMs}ms`).css('color', 'var(--md-primary)');
        }
        try {
            const r = await window.vpc.setProxy({ url, enable });
            warnToast(r && r.ok ? '代理已保存并应用（后端已重启）' : (r && r.reason ? `保存失败：${r.reason}` : '保存失败'));
        } catch (e) { warnToast('保存失败'); }
    });
    // 代理连通性测试：用「代理地址」走一次 HEAD；结果就地显示并记测试 URL
    $('#set_proxy_test').on('click', async () => {
        const proxyUrl = $('#set_proxy_url').val().trim();
        let testUrl = $('#set_proxy_test_url').val().trim() || 'https://www.google.com/generate_204';
        if (!proxyUrl) { warnToast('请先填写代理地址'); return; }
        $('#set_proxy_test_result').text('测试中…');
        window.vpc.settingsSet('proxyTestUrl', testUrl);
        try {
            const r = await window.vpc.testProxy({ proxyUrl, url: testUrl });
            if (r && r.ok) {
                const sc = r.statusCode || 0;
                const via = r.viaSocks ? 'SOCKS5 隧道' : (r.viaTunnel ? 'HTTPS 隧道' : 'HTTP 转发');
                // 任何 2xx/3xx（含 302 跳转）都说明代理链路可用（代理已把请求转发出去并拿到响应）
                const okConn = sc >= 200 && sc < 400;
                const statusDesc = sc === 204 ? '204 无内容' : sc === 302 ? '302 跳转' : `HTTP ${sc}`;
                const head = `${okConn ? '✓ 连通' : '⚠ 返回 ' + sc} · ${r.elapsedMs}ms`;
                const detail = `${r.proxy || '代理'} → ${r.testHost || testUrl}（${via}，${statusDesc}）`;
                $('#set_proxy_test_result').text(`${head}\n${detail}`).css('color', okConn ? 'var(--md-primary)' : 'var(--md-error)').attr('title', detail);
            } else {
                $('#set_proxy_test_result').text(`✗ 未连通（${(r && r.proxy) || '代理'}）\n${(r && r.reason) || '未知原因'}`).css('color', 'var(--md-error)');
            }
        } catch (e) {
            $('#set_proxy_test_result').text('测试请求失败').css('color', 'var(--md-error)');
        }
    });
    // 隐身模式（不记历史）
    $('#set_incognito').on('change', function () {
        window.vpc.settingsSet('incognito', this.checked);
        window._incognito = this.checked;
        warnToast(this.checked ? '隐身模式已开启：不再记录播放历史' : '隐身模式已关闭');
    });
    // 缓存位置：选目录 → 确认后重启后端生效
    $('#cache_dir_pick').on('click', pickCacheDir);
    // 缓存位置：恢复默认
    $('#cache_dir_reset').on('click', async () => {
        try {
            const r = await window.vpc.pickCacheDir('__default__');
            if (r && r.ok) {
                $('#cache_dir_line').text('缓存位置：默认');
                warnToast('已恢复默认缓存位置（后端已重启）');
            } else if (r && r.reason && r.reason !== 'cancelled') {
                warnToast(`恢复失败：${r.reason}`);
            }
        } catch (e) { warnToast('恢复失败'); }
    });
    // 下载目录：主进程弹目录选择框，持久化并重启下载引擎
    $('#set_dl_dir_pick').on('click', async () => {
        let r;
        try { r = await window.vpc.download.pickDir(); } catch (e) { return; }
        if (r && r.ok) {
            refreshDlDirLine(r.dir);
            warnToast('已更换下载目录（进行中任务已中断，重新继续即可续传）');
        } else if (r && r.reason && r.reason !== 'cancelled') {
            warnToast(`更换目录失败：${r.reason}`);
        }
    });
    // 打开下载目录：直接拉起资源管理器（未更换过则打开系统默认下载目录）
    $('#set_dl_open').on('click', async () => {
        try {
            const r = await window.vpc.download.openDir();
            if (!r || !r.ok) warnToast('打开下载目录失败');
        } catch (e) { warnToast('打开下载目录失败'); }
    });
    // 并发任务数：即时生效（aria2 changeGlobalOption）并持久化；引擎未启动时仅持久化
    $('#set_dl_concurrency').on('change', async function () {
        const r = await window.vpc.download.control('setConcurrency', { n: parseInt(this.value, 10) || 3 });
        if (r && r.ok) warnToast(`并发任务数已设为 ${r.n}`);
        else warnToast('已保存，将在下载引擎启动后生效');
    });
    // 分片并发数（单文件分片/每服务器连接数）：即时生效并持久化
    $('#set_dl_split').on('change', async function () {
        const r = await window.vpc.download.control('setSplit', { n: parseInt(this.value, 10) || 5 });
        if (r && r.ok) warnToast(`分片并发数已设为 ${r.n}`);
        else warnToast('已保存，将在下载引擎启动后生效');
    });
    // 恢复默认设置（二次确认：先说明范围，再最终确认；应用自动重启）
    $('#set_reset').on('click', async () => {
        if (!await confirmDialog('将恢复外观/播放等偏好设置为默认值。\n不会删除收藏、历史与已载入的源。继续？')) return;
        if (!await confirmDialog('最终确认：立即恢复默认设置？应用将自动重启。', { okText: '立即重启' })) return;
        try { await window.vpc.settingsReset(); } catch (e) { /* 重启即断开 IPC */ }
    });
    $('#set_walldim').on('change', function () {
        window.vpc.settingsSet('wallpaperDim', this.value);
        applySkin({ dim: this.value });
    });
    $('#set_wallpaper').on('click', chooseWallpaper);
    $('#clear_wallpaper').on('click', clearWallpaper);
    // 网盘 Cookie（JAR 网盘源播放）
    initPanCookiePanel();
    // 系统标题栏开关：保存设置后提示重启
    $('#set_system_titlebar').on('change', async function () {
        await window.vpc.settingsSet('systemTitleBar', this.checked);
        warnToast(this.checked ? '已开启系统标题栏，重启后生效' : '已关闭系统标题栏（无边框模式），重启后生效');
    });
    // 屏蔽源：查看列表（key 映射为可读源名，取不到时回退 key）
    $('#blocked_view').on('click', async () => {
        try {
            const s = (await window.vpc.settingsGet()) || {};
            const keys = Array.isArray(s.blockedSites) ? s.blockedSites : [];
            const box = $('#blocked_list').empty();
            if (!keys.length) {
                box.html('<div class="tip-line">暂无被屏蔽的源。</div>');
            } else {
                const all = (typeof Home !== 'undefined' && Home._allSites) || [];
                keys.forEach((k) => {
                    const hit = all.find((x) => x.key === k);
                    box.append(`<div class="history-item"><span class="history-url">${escHtml((hit && hit.name) || k)}</span></div>`);
                });
            }
            openDialog('blockedDialog');
        } catch (e) { warnToast('读取屏蔽列表失败'); }
    });
    // 屏蔽源：恢复并重新探测
    $('#blocked_restore').on('click', async () => {
        if (!await confirmDialog('确定恢复全部被屏蔽的源？恢复后这些源会重新加入源列表；若开启自动检测，之后会再次探测。', { okText: '恢复' })) return;
        try {
            await window.vpc.settingsSet('blockedSites', []);
            await window.vpc.settingsSet('probedSites', []);
            const s = (await window.vpc.settingsGet()) || {};
            updateBlockedLine(s);
            if (typeof Home !== 'undefined' && Home._inited) Home.loadSites();
            warnToast(s.sourceAutoDetect === false ? '已恢复全部源（自动检测已关闭）' : '已恢复全部源，将重新探测');
        } catch (e) { warnToast('恢复失败'); }
    });
    $('#cache_clear').on('click', clearCache);
    refreshCacheSize();
    // 资产就绪状态（ffmpeg / mpv / aria2 / Anime4K），启动时静默加载不弹通知
    refreshAssetStatus(true);
    $('#asset-refresh').on('click', () => refreshAssetStatus(false));
    // 统一播放器指定：mpv → 内置全功能；VLC/PotPlayer → 作为主播放器（无 mpv 也能播）
    refreshPlayerLine();
    $('#pick_player').on('click', async () => {
        const r = await window.vpc.pickPlayer();
        if (r && r.ok) {
            if (r.mode === 'internal-mpv') warnToast('已指定 mpv（内置全功能：弹幕/连播/统计）');
            else warnToast(`已指定 ${r.kind || '外部'} 播放器作主播放器（无弹幕/连播/统计）`);
            refreshPlayerLine();
            refreshAssetStatus();
        } else if (r && r.reason !== 'cancelled') {
            warnToast('指定失败：' + r.reason);
        }
    });
    $('#clear_player').on('click', async () => {
        const r = await window.vpc.clearPlayer();
        if (r && r.ok) {
            warnToast(r.available ? '已恢复为自动发现 mpv' : '已恢复默认，但未检测到 mpv（可点「下载内置播放器」或重新指定）');
            refreshPlayerLine();
            refreshAssetStatus();
        }
    });
    // 一键补装内置播放器（mpv）：未检测到播放器时按钮才显示（见 refreshAssetStatus）
    $('#download_mpv').on('click', async () => {
        const btn = $('#download_mpv');
        if (btn.prop('disabled')) return;
        btn.prop('disabled', true).text('下载中…');
        warnToast('正在下载内置播放器（mpv），首次约需数十兆流量，请稍候…');
        try {
            const r = await window.vpc.downloadMpv();
            if (r && r.ok) {
                warnToast(r.already ? '内置播放器已就绪' : '内置播放器安装完成，现在可以播放视频了');
                refreshPlayerLine();
                refreshAssetStatus();
            } else if (r && r.reason === 'downloading') {
                warnToast('下载已在进行中，请稍候…');
            } else {
                warnToast('下载失败：' + ((r && r.reason) || '未知错误') + '（可改用「指定播放器」选择本机 mpv.exe，或指定 VLC/PotPlayer 作主播放器）');
            }
        } catch (e) {
            warnToast('下载失败：' + (e.message || '未知错误'));
        } finally {
            btn.prop('disabled', false).text('下载内置播放器');
        }
    });
    // mpv 异步启动失败（安装时取消内置播放器后文件缺失、损坏、无权限）：友好提示而非静默
    window.vpc.onPlayerSpawnError(() => {
        warnToast('未检测到播放器，请在 设置 → 组件状态 指定 mpv.exe，或点「下载内置播放器」');
        refreshAssetStatus();
        refreshPlayerLine();
    });
    // 局域网推送到达 → 提示（mpv 已由主进程直接接管播放）
    window.vpc.onPushReceived((info) => {
        warnToast(`收到推送，已开始播放：${(info.url || '').slice(0, 60)}`);
    });
    // 定时关机：设定 N 分钟后关机
    $('#set_shutdown_set').on('click', async () => {
        const minutes = parseInt($('#set_shutdown_minutes').val(), 10) || 0;
        const r = await window.vpc.shutdownTimer(minutes);
        if (r && r.ok) warnToast(r.msg || (minutes > 0 ? `已设定 ${minutes} 分钟后关机` : '已取消定时关机'));
    });
    // 日志查看器：打开 + 翻页 + 按文件筛选
    let _logPage = 1;
    let _logPages = 1;      // 已知总页数（loadLogPage 返回后更新），供“下一页”提前钳位
    let _logSource = '';    // 当前筛选的日志文件（空 = 全部）
    $('#log-viewer-open').on('click', async () => {
        _logPage = 1;
        _logSource = '';
        openDialog('logViewerDialog');
        await loadLogPage();
    });
    $('#log-prev').on('click', async () => { if (_logPage > 1) { _logPage--; await loadLogPage(); } });
    // 提前钳位：点过末页不再请求空白页（旧逻辑的钳位在请求返回后才生效，会先闪一次空 body）
    $('#log-next').on('click', async () => { if (_logPage < _logPages) { _logPage++; await loadLogPage(); } });
    // 切换日志来源：回到第 1 页重新载入
    $('#log-source').on('change', async () => {
        _logSource = $('#log-source').val() || '';
        _logPage = 1;
        await loadLogPage();
    });
    // 清空日志：确认后清空目录，并刷新为第一页
    $('#log-clear').on('click', async () => {
        if (!await confirmDialog('清空全部应用日志？此操作不可撤销。', { okText: '清空' })) return;
        try {
            const r = await window.vpc.clearLogs();
            if (r && r.ok) {
                const failed = (r.failed && r.failed.length) ? `，${r.failed.length} 个文件占用未删除（${r.failed.join('、')}）` : '';
                warnToast(`已清空 ${r.removed || 0} 个日志文件${failed}`);
            } else {
                warnToast('清空失败');
            }
            _logPage = 1;
            await loadLogPage();
        } catch (e) { warnToast('清空日志失败'); }
    });
    // 日志级别：立即生效并持久化（DEBUG 会显著增加磁盘写入，提示用户）
    $('#set_log_level').on('change', async function () {
        const level = String(this.value || 'INFO').toUpperCase();
        try {
            const r = await window.vpc.setLogLevel(level);
            warnToast(`日志级别已设为 ${(r && r.level) || level}（新日志立即按此级别过滤）`);
        } catch (e) { warnToast('保存日志级别失败'); }
    });
    // 定时清空日志开关 + 周期：立即生效并持久化
    $('#set_log_autocleanup').on('change', async function () {
        const enabled = this.checked;
        let days = parseInt($('#set_log_cleanup_days').val(), 10) || 0;
        if (enabled && days <= 0) { days = 7; $('#set_log_cleanup_days').val('7'); }
        try {
            await window.vpc.setLogCleanup({ enabled, days });
            warnToast(enabled ? `已开启定时清空日志（每 ${days} 天一次）` : '已关闭定时清空日志');
        } catch (e) { warnToast('保存定时清空设置失败'); }
    });
    $('#set_log_cleanup_days').on('change', async function () {
        let days = Math.max(1, Math.min(90, parseInt(this.value, 10) || 7));
        this.value = String(days);
        const enabled = $('#set_log_autocleanup').prop('checked');
        try {
            await window.vpc.setLogCleanup({ enabled, days });
            if (enabled) warnToast(`清理周期已设为 ${days} 天`);
        } catch (e) { warnToast('保存清理周期失败'); }
    });
    async function loadLogPage() {
        // 切换来源/翻页不先清空，避免闪一次「载入中…」空白（仅首次为空时占位）
        if (!$('#log-viewer-body .log-line').length) $('#log-viewer-body').html('<div class="tip-line">载入中…</div>');
        try {
            const r = await window.vpc.getLogs(_logPage, 50, _logSource);
            if (!r || !r.ok) { $('#log-viewer-body').html('<div class="tip-line">无日志</div>'); return; }
            const total = r.total || 0;
            const ps = r.pageSize || 50;
            const pages = Math.max(1, Math.ceil(total / ps));
            _logPages = pages;
            _logPage = Math.min(_logPage, pages);
            // 同步来源下拉（首次或来源集合变化时重建 option）
            const sources = r.sources || [];
            const sel = $('#log-source');
            const existing = sel.find('option').map(function () { return this.value; }).get().filter(Boolean);
            if (existing.join('|') !== sources.join('|')) {
                sel.html('<option value="">全部日志</option>' + sources.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join(''));
                sel.val(_logSource);
            }
            $('#log-page-info').text(`第 ${_logPage} / ${pages} 页 · 共 ${total} 行`);
            const html = (r.logs || []).map(l => `<div class="log-line"><span class="log-line-file">[${escHtml(l.file)}]</span><span class="log-line-text">${escHtml(l.line)}</span></div>`).join('');
            $('#log-viewer-body').html(html || '<div class="tip-line">无日志</div>');
        } catch (e) { $('#log-viewer-body').html('<div class="tip-line">日志载入失败</div>'); }
    }
    // 首次引导：首次启动显示，确认后不再弹出
    (async () => {
        try {
            const s = (await window.vpc.settingsGet()) || {};
            if (!s.onboarded) {
                openDialog('onboardingDialog');
                $('#onboarding-confirm').off('click').on('click', () => {
                    closeDialog('onboardingDialog');
                    window.vpc.onboardingDone();
                });
            }
        } catch (e) { /* 首次运行无 settings */ }
    })();
}

/**
 * 直链播放：与 parse=1 线路同一套解析链路——
 * 媒体直链/流协议直交 mpv；网页链接先走 parses 接口，
 * 失败再用隐藏窗口抓取页面自身播放器的媒体请求。
 */
async function playDirectLink() {
    const url = $('#direct_play_url').val().trim();
    if (!url) { warnToast('请先粘贴视频链接'); return; }
    if (!/^(https?:|rtmp:|rtsp:)/i.test(url)) { warnToast('链接格式不支持（http/https/rtmp/rtsp）'); return; }
    // T70：直链播放也注册 Player 会话，退出时计入观看统计（此前绕过 _rememberSession 导致不统计）
    const regSession = (r) => {
        if (r && r.ok && typeof Player !== 'undefined' && Player._rememberSession) {
            Player._curMeta = { site: '', siteName: '直链', title: '直链播放', subtitle: '', vodId: '' };
            Player._rememberSession(r);
        }
    };
    // rtmp/rtsp 与媒体直链无需解析
    if (/^(rtmp:|rtsp:)/i.test(url) || /\.(m3u8|mp4|flv|mov|mkv|webm|ts)(\?|#|$)/i.test(url.split('?')[0])) {
        const r = await window.vpc.playUrl(url, { title: '直链播放' });
        if (r && r.ok) {
            if (r.viaExternal) warnToast('已交外部播放器播放');
            else { regSession(r); warnToast('已在 mpv 窗口播放'); }
        } else warnToast('播放失败：' + ((r && r.reason) || '未知错误'));
        return;
    }
    showLoading();
    warnToast('正在后台解析播放地址…');
    let resolved = null;
    try { resolved = await window.vpc.resolveParse(url); } catch (e) { /* 无解析接口 */ }
    if (!(resolved && resolved.ok)) {
        try {
            const cap = await window.vpc.captureDirect(url);
            if (cap && cap.ok) resolved = cap;
        } catch (e) { /* 抓取异常 */ }
    }
    hideLoading();
    if (resolved && resolved.ok) {
        const r = await window.vpc.playUrl(resolved.url, { title: '直链播放', header: resolved.header });
        if (r && r.ok) {
            if (r.viaExternal) warnToast('已交外部播放器播放');
            else { regSession(r); warnToast('已在 mpv 窗口播放'); }
            return;
        }
    }
    warnToast('未能解析该链接，请确认链接有效');
}

/** 选择本地图片作壁纸（主进程文件对话框），路径持久化。 */
async function chooseWallpaper() {
    let r;
    try { r = await window.vpc.pickWallpaper(); } catch (e) { return; }
    if (!r || !r.ok || !r.path) return;
    window.vpc.settingsSet('wallpaper', r.path);
    window._wallpaperUrl = toFileUrl(r.path);
    applySkin({ wallpaperUrl: window._wallpaperUrl });
    warnToast('壁纸已设置');
}

/** 移除壁纸（T40：二次确认）。 */
async function clearWallpaper() {
    if (!await confirmDialog('移除当前背景壁纸？', { okText: '移除' })) return;
    window.vpc.settingsSet('wallpaper', '');
    window._wallpaperUrl = '';
    applySkin({ wallpaperUrl: '' });
    warnToast('壁纸已移除');
}

/** 缓存位置展示行。 */
function refreshCacheDirLine(dir) {
    const el = $('#cache_dir_line');
    if (dir) el.text(`缓存位置：${dir}`).attr('title', dir);
    else el.text('缓存位置：默认（用户目录下 .video-pc）').attr('title', '');
}

/** 下载目录展示行（设置页「下载」卡片）。 */
function refreshDlDirLine(dir) {
    const el = $('#set_dl_dir_line');
    if (dir) el.text(`下载目录：${dir}`).attr('title', dir);
    else el.text('下载目录：默认（系统下载目录）').attr('title', '');
}

/** 更换缓存目录：主进程弹目录选择框，确认后重启后端生效。 */
async function pickCacheDir() {
    let r;
    try { r = await window.vpc.pickCacheDir(''); } catch (e) { return; }
    if (!r || r.reason === 'cancelled') return;
    if (r.reason === 'need-restart' && r.path) {
        if (!await confirmDialog(`将缓存目录改为：\n${r.path}\n\n后端将重启以生效，继续？`)) return;
        try {
            const r2 = await window.vpc.pickCacheDir(r.path);
            if (r2 && r2.ok) {
                refreshCacheDirLine(r2.path);
                warnToast('缓存位置已更换，后端重启中…');
            } else {
                warnToast('更换失败：' + ((r2 && r2.reason) || '未知错误'));
            }
        } catch (e) { warnToast('更换失败'); }
    }
}

/** 屏蔽源计数行。 */
function updateBlockedLine(s) {
    const n = Array.isArray(s && s.blockedSites) ? s.blockedSites.length : 0;
    if (s && s.sourceAutoDetect === false) {
        $('#blocked_line').text(n > 0
            ? `自动检测已关闭；${n} 个历史屏蔽源当前全部显示。`
            : '自动检测已关闭；不会后台探测、隐藏或屏蔽源。');
        return;
    }
    $('#blocked_line').text(n > 0
        ? `已自动屏蔽 ${n} 个无内容源；恢复后会重新探测。`
        : '自动屏蔽首页和分类均无内容的源，避免下拉里出现空源。');
}

/** 资产就绪状态：查询主进程各二进制（ffmpeg/mpv/aria2/Anime4K）是否有
 *  效，渲染为就绪/下载中/缺失图标行。首次进入设置页自动刷新，也可手动刷新。 */
async function refreshAssetStatus(silent) {
    const box = $('#asset-status-list');
    // 不立即清空旧内容，避免刷新时闪烁；仅在无内容时显示查询中
    if (!box.children().length) box.html('<div class="tip-line">查询中…</div>');
    let status;
    try {
        status = await window.vpc.assetStatus();
    } catch (e) {
        box.html('<div class="tip-line" style="color:var(--md-error)">查询失败</div>');
        warnToast('扩展状态查询失败');
        return;
    }
    if (!status) { box.html('<div class="tip-line">暂无扩展信息</div>'); return; }
    _assetStatus = status; // 缓存供 Anime4K 开关启用时提示真实着色器状态
    const items = [
        { key: 'ffmpeg', label: 'ffmpeg（视频缩略图 / m3u8 下载合成）', s: status.ffmpeg },
        { key: 'mpv', label: 'mpv 播放器（视频播放引擎）', s: status.mpv },
        { key: 'aria2', label: 'aria2 下载引擎（多线程下载）', s: status.aria2 },
        { key: 'anime4k', label: 'Anime4K 着色器（动漫实时超分）', s: status.anime4k },
        { key: 'java', label: 'Java 运行环境（JAR 影视源解析引擎）', s: status.java || {} },
    ];
    const rows = items.map(({ key, label, s }) => {
        let icon, cls, hint;
        if (s.ready) {
            icon = '✔'; cls = 'asset-ok';
            hint = '已就绪'; // T24：mpv 完整路径只进悬停 title，避免长路径撑破行
        } else if (s.downloading) {
            icon = '⏳'; cls = 'asset-downloading'; hint = '后台下载中…';
        } else {
            icon = '✘'; cls = 'asset-missing'; hint = '未安装';
        }
        const tip = (key === 'mpv' && s.ready && s.path) ? `已就绪 · ${s.path}` : hint;
        return `<div class="asset-row ${cls}" title="${escHtml(tip)}">
            <span class="asset-icon">${icon}</span>
            <span class="asset-label">${escHtml(label)}</span>
            <span class="asset-hint">${escHtml(hint)}</span>
        </div>`;
    }).join('');
box.html(rows);
    // 手动点击刷新时弹出消息通知；启动初始化（silent=true）静默跳过
    if (!silent) {
        const summary = items.map(({ label, s }) => {
            const name = label.replace(/（.*）$/, '');
            if (s.ready) return `${name} ✔`;
            if (s.downloading) return `${name} ⏳`;
            return `${name} ✘`;
        }).join('、');
        warnToast(`扩展状态已刷新：${summary}`);
    }
    // 播放器缺失时高亮「下载内置播放器」按钮，就绪则隐藏（避免误导用户重复下载）
    const dlBtn = $('#download_mpv');
    if (status.mpv && status.mpv.ready) dlBtn.hide();
    else dlBtn.show();
}

/** 播放器状态行：统一显示内置 mpv 与外部播放器配置。HTML 已含「播放器：」前缀，此处只填值。 */
async function refreshPlayerLine() {
    const line = $('#player_line');
    const clearBtn = $('#clear_player');
    if (!line.length) return;
    const kindLabel = { vlc: 'VLC', potplayer: 'PotPlayer', mpv: 'mpv', other: '其他' };
    try {
        const cfg = await window.vpc.playerConfig();
        if (cfg.mode === 'external') {
            const label = kindLabel[cfg.kind] || '外部';
            line.text(`${label} · ${cfg.path}（外部模式，无弹幕/连播/统计）`);
            line.attr('title', cfg.path);
            clearBtn.show();
        } else if (cfg.path) {
            line.text(`mpv · ${cfg.path}（内置全功能）`);
            line.attr('title', cfg.path);
            clearBtn.show();
        } else {
            line.text(cfg.available ? 'mpv（内置自动发现，就绪）' : 'mpv（未找到，请安装或指定播放器）');
            line.removeAttr('title');
            clearBtn.hide();
        }
    } catch (e) {
        line.text('查询失败');
        clearBtn.hide();
    }
}

(function (root) {
    root.VPC = root.VPC || {};
    root.VPC.panels = { applyConfigResult, initAuxPanels, initSettingsPanel };
}(typeof window !== 'undefined' ? window : globalThis));
