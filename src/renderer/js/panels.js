/**
 * panels.js — 工具面板（源配置 / 本地文件）
 *
 * UX 批次重构：移除搜索、推送、弹幕面板（用户不再需要）；
 * 源配置独立成页（输入框 + 历史源列表，点击载入、可删除）；
 * 设置已独立为侧栏底部「设置」视图（控件绑定仍在本文件 initSettingsPanel）；
 * 缓存清理前先展示占用大小；本地文件管理逻辑保持不变。
 * 需解析的影片链接（parse=1）由 player.js 自动解析载入播放，无需手动推送。
 */
/* global $, doAction, escHtml, escPath, fmtSize, warnToast, showLoading, hideLoading,
          openDialog, closeDialog, registerEsc, Home, Live, Downloads */

const icDir = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23F5A623'><path d='M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'/></svg>`;
const icFile = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23717970'><path d='M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z'/></svg>`;

let currentRoot = '';
let currentFile = '';
let currentParent = '';
let dirNavStack = [];
let pendingDelFolder = null;
let _assetStatus = null; // 最近一次资产就绪状态缓存（Anime4K 开关提示用）

// ---------------------------------------------------------------- 面板切换

function showToolPanel(name) {
    $('.tools-tab').removeClass('active');
    $(`.tools-tab[data-panel="${name}"]`).addClass('active');
    $('.tool-panel').removeClass('active');
    $(`#${name}`).addClass('active');
    if (name === 'tool-local' && document.getElementById('file_list').innerHTML === '') listFile('');
}

// ---------------------------------------------------------------- 源配置

/** 载入配置（名称固定 config）：URL 或 JSON 均可；异步任务轮询 configTask。 */
async function setting() {
    const text = $('#setting_text').val().trim();
    if (!text) { warnToast('请输入配置地址或 JSON'); return; }
    showLoading();
    let rsp;
    try {
        rsp = await doAction('setting', { text, name: 'config' });
    } catch (e) {
        hideLoading();
        warnToast('请求失败');
        return;
    }
    // 后端异步加载（code:202）：轮询 configTask 直到 done/error（最长 5 分钟）
    if (rsp && rsp.code === 202) {
        for (let i = 0; i < 150; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            let task = null;
            try { task = await doAction('configTask', {}); } catch (e) { continue; }
            if (!task || task.status === 'loading') continue;
            hideLoading();
            if (task.status === 'done' && task.summary) {
                applyConfigResult(task.summary, text);
            } else {
                warnToast(`配置载入失败：${String((task && task.msg) || '未知错误').slice(0, 80)}`);
            }
            return;
        }
        hideLoading();
        warnToast('配置仍在载入中，请稍后切换站点查看结果');
        return;
    }
    hideLoading();
    if (rsp && rsp.code === 200 && rsp.summary) {
        applyConfigResult(rsp.summary, text);
    } else if (rsp && rsp.code === 409) {
        warnToast('已有一个配置载入正在进行，请稍后再试');
    } else {
        const msg = (rsp && rsp.msg) ? String(rsp.msg) : '网络错误或源不可达';
        warnToast(`配置载入失败：${msg.slice(0, 80)}`);
    }
}

/** 根据加载摘要提示并（成功时）持久化 URL + 刷新站点列表。 */
function applyConfigResult(sm, text) {
    if (sm.sites > 0) {
        warnToast(`配置已载入：${sm.sites} 个站点、${sm.parses} 个解析` +
            (sm.skipped && sm.skipped.length ? `（跳过 ${sm.skipped.length} 个）` : ''));
        // 成功才持久化，下次启动自动重载；并记入历史源
        if (/^https?:\/\//i.test(text.trim())) {
            window.vpc.settingsSet('lastConfigUrl', text.trim());
            addConfigHistory(text.trim());
        }
        if (typeof Home !== 'undefined' && Home.loadSites) Home.loadSites();
        if (typeof Live !== 'undefined' && Live.load) Live.load();
    } else {
        warnToast('载入 0 个站点：此配置可能仅含 TVBox jar 型源（csp_XXX）或 drpy 源，PC 侧仅支持 Python/JS 爬虫源');
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
    setting();
}

async function removeConfigHistory(idx) {
    try {
        const s = (await window.vpc.settingsGet()) || {};
        const list = Array.isArray(s.configHistory) ? s.configHistory : [];
        list.splice(idx, 1);
        await window.vpc.settingsSet('configHistory', list);
        window._cfgHistoryCache = list;
        renderConfigHistory(list);
    } catch (e) { warnToast('删除失败'); }
}

// ---------------------------------------------------------------- 设置：缓存

/** 展示当前缓存占用（清理按钮同步显示大小）。 */
async function refreshCacheSize() {
    try {
        const r = await doAction('cacheSize', {});
        if (r && r.code === 200) {
            $('#cache_size_line').text(`当前缓存占用：${fmtSize(r.bytes)}（${r.items} 个文件）`);
            $('#cache_clear').text(r.bytes > 0 ? `清理缓存（${fmtSize(r.bytes)}）` : '清理缓存');
        }
    } catch (e) { /* 统计失败不影响面板 */ }
}

async function clearCache() {
    try {
        const r = await doAction('clearCache', {});
        if (r && r.code === 200) {
            warnToast(`缓存已清理，释放 ${fmtSize(r.bytes || 0)}（${r.msg || '完成'}）`);
            refreshCacheSize();
        } else {
            warnToast('缓存清理失败');
        }
    } catch (e) { warnToast('缓存清理失败'); }
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
        }).catch(() => { });
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

/** 追加一条列表项。 */
function addFile(node) {
    $('#file_list').append(node);
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
    // 本地媒体直接交给主进程 mpv 播放
    window.vpc.filePush(currentFile).then((r) => {
        if (r && r.ok) warnToast('已在 mpv 窗口播放');
        else if (r && r.reason === 'not-video') warnToast('仅支持直接播放视频/音频文件');
        else if (r && r.reason === 'mpv-missing') warnToast('未检测到 mpv：执行 node scripts/download-binaries.js 安装');
        else warnToast('播放失败');
    }).catch(() => warnToast('播放失败'));
}

/** 未选根目录时的引导态（白名单未设置）。 */
function renderNeedRoot() {
    $('#file_list').html('<div class="tip-line">尚未选择根目录（白名单）</div>' +
        '<div style="text-align:center;padding:12px">' +
        '<button class="md-btn md-btn-filled" onclick="pickRoot()">选择根目录</button></div>');
    $('#local-pager').hide();
}

/** 刷新当前目录（不动导航栈；外部删除/拷入文件后手动同步视图）。 */
function refreshLocal() {
    listFile(currentRoot);
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
    $('#file_list').html('');
    if (st.parent !== '.') addFile(buildParentItem());
    dirs.forEach((node) => addFile(buildDirItem(node.name, node.time, node.path)));
    if (videos.length) {
        addFile(`<div class="local-grid">${videos.map((n) => buildVideoCard(n.name, n.time, n.path)).join('')}</div>`);
        loadLocalThumbs();
    }
    audios.forEach((node) => addFile(buildFileItem(node.name, node.time, node.path)));
    if (!total && st.parent === '.') addFile('<div class="tip-line">（无视频/音频文件）</div>');
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

/** 拉取并渲染目录列表（200ms 未返回先显示 loading；needRoot 转引导态；分页重置回第一页）。 */
function listFile(relPath) {
    const loadingTimer = setTimeout(() => $('#loadingToast').show(), 200);
    window.vpc.fileList(relPath || '').then((info) => {
        clearTimeout(loadingTimer);
        $('#loadingToast').hide();
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
        _localPage = { path: currentRoot, parent, dirs, videos, audios };
        _localPageNo = 1;
        renderLocalPage();
    }).catch(() => {
        clearTimeout(loadingTimer);
        $('#loadingToast').hide();
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
    $('#loadingToast').show();
    window.vpc.fileNewFolder(currentRoot, name).then((r) => {
        $('#loadingToast').hide();
        if (r && r.ok) listFile(currentRoot);
        else warnToast('新增失败');
    }).catch(() => {
        $('#loadingToast').hide();
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
    $('#loadingToast').show();
    window.vpc.fileDelFolder(path).then((r) => {
        $('#loadingToast').hide();
        if (r && r.ok) listFile(refreshPath);
        else warnToast('删除失败');
    }).catch(() => {
        $('#loadingToast').hide();
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
    $('#loadingToast').show();
    window.vpc.fileDelFile(currentFile).then((r) => {
        $('#loadingToast').hide();
        if (r && r.ok) listFile(currentRoot);
        else warnToast('删除失败');
    }).catch(() => {
        $('#loadingToast').hide();
        warnToast('删除失败');
    });
}

// ---------------------------------------------------------------- 初始化（app.js 启动时调用一次）

function initAuxPanels() {
    showToolPanel('tool-source');
    // 面板切换
    $('.tools-tab').on('click', (e) => showToolPanel(String($(e.currentTarget).data('panel'))));
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

function initSettingsPanel() {
    // 设置一级菜单（T12）：点大类只显示对应二级详情卡片；记忆上次分类
    const showSetCat = (cat) => {
        $('#settings-nav .settings-nav-item').removeClass('active')
            .filter(`[data-cat="${cat}"]`).addClass('active');
        $('#view-settings .tool-card[data-setcat]').each(function () {
            $(this).toggle(String($(this).data('setcat')) === cat);
        });
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
        if (s.settingsCat) showSetCat(s.settingsCat);
        if (s.playerVolume) $('#set_volume').val(s.playerVolume);
        // 上次配置回填 + 历史源列表
        if (s.lastConfigUrl) $('#setting_text').val(s.lastConfigUrl);
        const list = Array.isArray(s.configHistory) ? s.configHistory : [];
        window._cfgHistoryCache = list;
        renderConfigHistory(list);
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
        $('#set_anim').val(s.animEnabled !== false ? 'on' : 'off'); // 界面动画（T22：筛选框）
        if (s.listPageSize) $('#set_pagesize').val(s.listPageSize); // 每页条数（空=自动）
        window._wallpaperUrl = s.wallpaper ? toFileUrl(s.wallpaper) : '';
        // 播放偏好：默认倍速 / 连播 / 续播 / 后台播放
        $('#set_speed').val(String(s.playerSpeed || '1'));
        if (s.playerAlang) $('#set_alang').val(s.playerAlang);
        if (s.playerSlang) $('#set_slang').val(s.playerSlang);
        $('#set_autonext').prop('checked', s.autoNext !== false);
        $('#set_resumepos').prop('checked', s.resumePos !== false);
        $('#set_bgplay').prop('checked', s.bgPlay !== false);
        $('#set_simuldl').prop('checked', !!s.simulDownload); // 边下边播（默认关）
        $('#set_anime4k').prop('checked', !!s.anime4k);
        // 系统：关闭行为 / 隐身模式 / 缓存位置
        $('#set_closeaction').val(s.closeAction || 'tray');
        $('#set_incognito').prop('checked', !!s.incognito);
        refreshCacheDirLine(s.cacheDir);
        // mpv 视频缓冲缓存：模式 + 目录展示（目录未设置时显示默认路径）
        $('#set_cache_mode').val(s.playerCacheMode === 'disk' ? 'disk' : 'memory');
        refreshMpvCacheDirLine(s.playerCacheDir);
        // 下载：目录展示（读持久化值，不拉起 aria2）+ 并发数回填
        refreshDlDirLine(s.dlDir);
        $('#set_dl_concurrency').val(String(s.dlConcurrency || '3'));
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
    $('#set_theme_clear').on('click', () => {
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
    $('#set_textcolor_clear').on('click', () => {
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
    // 恢复默认键位
    $('#hotkey_reset').on('click', async () => {
        _hkKeys = HK_UI_ACTIONS.reduce((m, a) => { m[a[0]] = a[2]; return m; }, {});
        hkCancelCapture();
        await saveHotkeys();
        warnToast('已恢复默认键位，下次起播生效');
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
    // 边下边播：仅持久化，主进程起播时读取（无需通知，下次起播即生效）
    $('#set_simuldl').on('change', function () {
        window.vpc.settingsSet('simulDownload', this.checked);
        warnToast(this.checked ? '已开启边下边播（下次起播生效）' : '已关闭边下边播');
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
    // 界面动画筛选框（T22：由开关改为下拉）
    $('#set_anim').on('change', function () {
        const on = this.value === 'on';
        window.vpc.settingsSet('animEnabled', on);
        applySkin({ animEnabled: on });
    });
    // 每页影片数量：持久化并作废渲染层缓存，下次进列表页生效
    $('#set_pagesize').on('change', function () {
        window.vpc.settingsSet('listPageSize', this.value);
        if (typeof invalidatePageSizeCache === 'function') invalidatePageSizeCache();
        warnToast('每页条数已保存，下次进入列表页生效');
    });
    // 关闭主窗口行为
    $('#set_closeaction').on('change', function () {
        window.vpc.settingsSet('closeAction', this.value);
    });
    // 隐身模式（不记历史）
    $('#set_incognito').on('change', function () {
        window.vpc.settingsSet('incognito', this.checked);
        window._incognito = this.checked;
        warnToast(this.checked ? '隐身模式已开启：不再记录播放历史' : '隐身模式已关闭');
    });
    // 缓存位置：选目录 → 确认后重启后端生效
    $('#cache_dir_pick').on('click', pickCacheDir);
    // mpv 视频缓冲缓存模式：切内存自动清硬盘缓存；切磁盘沿用已记忆目录（下次起播生效）
    $('#set_cache_mode').on('change', async function () {
        const mode = this.value === 'disk' ? 'disk' : 'memory';
        let r;
        try { r = await window.vpc.setPlayerCache(mode, ''); } catch (e) { r = null; }
        if (r && r.ok) {
            refreshMpvCacheDirLine(r.dir);
            warnToast(r.cleanedBytes > 0
                ? (mode === 'memory' ? `已切换为内存缓冲，清理硬盘缓存 ${fmtSize(r.cleanedBytes)}` : `已切换为硬盘缓冲，清理旧缓存 ${fmtSize(r.cleanedBytes)}`)
                : (mode === 'memory' ? '已切换为内存缓冲（下次起播生效）' : '已切换为硬盘缓冲（下次起播生效）'));
        } else {
            warnToast('切换失败：' + ((r && r.reason) || '未知错误'));
        }
    });
    // 更换 mpv 硬盘缓存目录：选目录 → 确认 → 提交（旧目录残留自动清理）
    $('#set_cache_dir_pick').on('click', async () => {
        let r;
        try { r = await window.vpc.pickFolder(); } catch (e) { return; }
        if (!r || !r.ok) return; // 取消静默
        const dir = r.path;
        if (!await confirmDialog(`将 mpv 硬盘缓存目录改为：\n${dir}\n\n原目录残留的 mpv 缓存会被清理（新目录内容不受影响）。继续？`)) return;
        const r2 = await window.vpc.setPlayerCache('disk', dir);
        if (r2 && r2.ok) {
            $('#set_cache_mode').val('disk');
            refreshMpvCacheDirLine(r2.dir);
            warnToast(r2.cleanedBytes > 0
                ? `已更换缓存目录，清理旧缓存 ${fmtSize(r2.cleanedBytes)}（下次起播生效）`
                : '已更换缓存目录（下次起播生效）');
        } else {
            warnToast('更换失败：' + ((r2 && r2.reason) || '未知错误'));
        }
    });
    // 清空 mpv 硬盘缓存（不改变模式/目录；占用中的文件跳过）
    $('#set_cache_clear').on('click', async () => {
        if (!await confirmDialog('将清空 mpv 硬盘缓存目录中的缓存文件。\n正在播放中的缓存文件可能被跳过。继续？')) return;
        let r;
        try { r = await window.vpc.clearPlayerCache(); } catch (e) { r = null; }
        if (r && r.ok) {
            warnToast(r.cleanedBytes > 0 ? `硬盘缓存已清空，释放 ${fmtSize(r.cleanedBytes)}` : '硬盘缓存目录已是空的');
        } else {
            warnToast('清理失败：' + ((r && r.reason) || '未知错误'));
        }
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
    // 版本号（主进程 app.getVersion）
    if (window.vpc.appVersion) {
        window.vpc.appVersion().then((v) => $('#app_version').text(`版本号：${v}`)).catch(() => { });
    }
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
        try {
            await window.vpc.settingsSet('blockedSites', []);
            await window.vpc.settingsSet('probedSites', []);
            updateBlockedLine({});
            if (typeof Home !== 'undefined' && Home._inited) Home.loadSites();
            warnToast('已恢复全部源，将重新探测');
        } catch (e) { warnToast('恢复失败'); }
    });
    $('#cache_clear').on('click', clearCache);
    refreshCacheSize();
    // 资产就绪状态（ffmpeg / mpv / aria2 / Anime4K）
    refreshAssetStatus();
    $('#asset-refresh').on('click', refreshAssetStatus);
    // 自定义 mpv 播放器路径：选择本地安装的 mpv.exe 替代内置版本
    refreshMpvPathLine();
    $('#pick_mpv_path').on('click', async () => {
        const r = await window.vpc.pickMpv();
        if (r && r.ok) {
            warnToast(`已指定 mpv: ${r.path.slice(-40)}`);
            refreshMpvPathLine();
            refreshAssetStatus();
        } else if (r && r.reason !== 'cancelled') {
            warnToast('指定失败：' + r.reason);
        }
    });
    $('#clear_mpv_path').on('click', async () => {
        const r = await window.vpc.clearMpvPath();
        if (r && r.ok) {
            warnToast(r.available ? '已恢复为自动发现 mpv' : '已清除自定义路径，但未检测到 mpv（请安装或重新指定）');
            refreshMpvPathLine();
            refreshAssetStatus();
        }
    });
    // 局域网推送到达 → 提示（mpv 已由主进程直接接管播放）
    window.vpc.onPushReceived((info) => {
        warnToast(`收到推送，已开始播放：${(info.url || '').slice(0, 60)}`);
    });
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
    // rtmp/rtsp 与媒体直链无需解析
    if (/^(rtmp:|rtsp:)/i.test(url) || /\.(m3u8|mp4|flv|mov|mkv|webm|ts)(\?|#|$)/i.test(url.split('?')[0])) {
        const r = await window.vpc.playUrl(url, { title: '直链播放' });
        if (r && r.ok) warnToast('已在 mpv 窗口播放');
        else warnToast('播放失败：' + ((r && r.reason) || '未知错误'));
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
        if (r && r.ok) { warnToast('已在 mpv 窗口播放'); return; }
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

/** 移除壁纸。 */
async function clearWallpaper() {
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

/** mpv 硬盘缓存目录展示行（未设置时显示默认路径）。 */
function refreshMpvCacheDirLine(dir) {
    const el = $('#mpv_cache_dir_line');
    if (dir) el.text(`mpv 缓存目录：${dir}`).attr('title', dir);
    else el.text('mpv 缓存目录：默认（用户目录下 mpv-cache）').attr('title', '');
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
    $('#blocked_line').text(n > 0
        ? `已自动屏蔽 ${n} 个无内容源；恢复后会重新探测。`
        : '自动屏蔽探测后无内容的源，避免下拉里出现空源。');
}

/** 资产就绪状态：查询主进程各二进制（ffmpeg/mpv/aria2/Anime4K）是否有
 *  效，渲染为就绪/下载中/缺失图标行。首次进入设置页自动刷新，也可手动刷新。 */
async function refreshAssetStatus() {
    const box = $('#asset-status-list').html('<div class="tip-line">查询中…</div>');
    let status;
    try { status = await window.vpc.assetStatus(); } catch (e) {
        box.html('<div class="tip-line" style="color:var(--md-error)">查询失败</div>');
        return;
    }
    if (!status) { box.html('<div class="tip-line">暂无扩展信息</div>'); return; }
    _assetStatus = status; // 缓存供 Anime4K 开关启用时提示真实着色器状态
    const items = [
        { key: 'ffmpeg', label: 'ffmpeg（视频缩略图 / m3u8 下载合成）', s: status.ffmpeg },
        { key: 'mpv', label: 'mpv 播放器（视频播放引擎）', s: status.mpv },
        { key: 'aria2', label: 'aria2 下载引擎（多线程下载）', s: status.aria2 },
        { key: 'anime4k', label: 'Anime4K 着色器（动漫实时超分）', s: status.anime4k },
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
}

/** 自定义 mpv 路径显示行：自动发现 vs 手动指定。 */
async function refreshMpvPathLine() {
    const line = $('#mpv_path_line');
    const clearBtn = $('#clear_mpv_path');
    try {
        const info = await window.vpc.mpvPath();
        if (info.customPath) {
            line.text(`mpv 路径：${info.customPath}`);
            line.attr('title', info.customPath);
            clearBtn.show();
        } else {
            line.text(info.available ? 'mpv 路径：自动发现（内置 / PATH）' : 'mpv 路径：未找到（请安装或指定路径）');
            line.removeAttr('title');
            clearBtn.hide();
        }
    } catch (e) {
        line.text('mpv 路径：查询失败');
        clearBtn.hide();
    }
}
