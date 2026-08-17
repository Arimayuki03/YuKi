/**
 * preload.js — contextBridge 安全暴露（contextIsolation 开启，nodeIntegration 关闭）
 */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// 设置读取内存缓存：settingsGet 被几乎每个页面渲染多次调用（收藏/历史/统计/首页屏蔽源
// 等都读同一份 settings.json），每次都走 IPC + 主进程内存对象。这里做写穿透缓存：
//   - 读：命中未过期缓存直接返回深拷贝（TTL 兜底，防主进程侧直写 mpvPath/dlDir 等造成陈旧）
//   - 写：settingsSet 后同步更新缓存该键，后续读立即可见（无需等下次 IPC）
//   - 深拷贝返回：调用方普遍就地修改返回的数组（recGet→list.unshift→recSet），
//     共享引用会污染缓存，故读写均用 structuredClone 隔离。
let _settingsCache = null;
let _settingsCacheTs = 0;
const _SETTINGS_TTL = 3000; // 3s：同一次交互内的连续读走缓存，跨交互/外部直写在 TTL 后自愈
function _clone(v) {
    try { return structuredClone(v); } catch (e) { try { return JSON.parse(JSON.stringify(v)); } catch (e2) { return v; } }
}

contextBridge.exposeInMainWorld('vpc', {
    /** 返回 { port, token, base } 或 null（超时未就绪） */
    getBackendInfo: () => ipcRenderer.invoke('backend-info'),
    /** 启动自动重载状态 { reloading, url }（首屏等待用） */
    configState: () => ipcRenderer.invoke('vpc:config-state'),
    onBackendReady: (cb) => {
        ipcRenderer.on('backend-ready', (_e, info) => cb(info));
    },
    onBackendState: (cb) => {
        ipcRenderer.on('backend-state', (_e, state) => cb(state));
    },
    /**
     * 播放入口（Phase 4 起由 mpv 接管）。
     * 连播由渲染层驱动：每次只交单集，播完经 onPlayerExit 推进下一集。
     * 返回 { ok, sessionId } —— ok=true 表示 mpv 已接管；
     * ok=false 且 reason='mpv-missing' 时渲染层走 <video> 预览兜底。
     */
    playUrl: (url, meta) => ipcRenderer.invoke('vpc:play', { url, meta }),
    /** 播放控制：cmd ∈ pause/resume/toggle/seek/volume/speed/quit */
    playerControl: (cmd, value) => ipcRenderer.invoke('vpc:player', cmd, value),
    /** 播放器状态 { available, playing } */
    playerState: () => ipcRenderer.invoke('vpc:player-state'),
    /** 单集播完事件 {sessionId, playlistPos, queueLen}（渲染层按会话记录「看完」时间戳，供退出判定兜底） */
    onPlayerEnded: (cb) => {
        ipcRenderer.on('vpc:player-ended', (_e, info) => cb(info));
    },
    /** mpv 进程退出（整单播完或关闭）；附退出时进度 {pos, duration}，供渲染层连播判定 */
    onPlayerExit: (cb) => {
        ipcRenderer.on('vpc:player-exit', (_e, info) => cb(info));
    },
    /** 断流重连起播新会话 {sessionId}：渲染层更新会话号，重连集播完仍可继续连播 */
    onPlayerSession: (cb) => {
        ipcRenderer.on('vpc:player-session', (_e, info) => cb(info));
    },
    /** 直播备用线路切换中 / 全部失败 */
    onPlayRetry: (cb) => {
        ipcRenderer.on('vpc:play-retry', (_e, info) => cb(info));
    },
    onPlayFailed: (cb) => {
        ipcRenderer.on('vpc:play-failed', (_e, info) => cb(info));
    },
    /** Phase 5 本地文件管理（白名单根目录 + 防穿越，rel 均为根目录相对路径） */
    fileRoot: () => ipcRenderer.invoke('vpc:file-root'),
    filePickRoot: () => ipcRenderer.invoke('vpc:file-pick-root'),
    fileList: (rel) => ipcRenderer.invoke('vpc:file-list', rel || ''),
    /** 本地视频预览图（ffmpeg 抓帧，md5 缓存）：{ok, path} | {ok:false} */
    fileThumb: (rel) => ipcRenderer.invoke('vpc:file-thumb', rel),
    fileUpload: (rel) => ipcRenderer.invoke('vpc:file-upload', rel || ''),
    fileNewFolder: (rel, name) => ipcRenderer.invoke('vpc:file-new-folder', rel || '', name),
    fileDelFile: (rel) => ipcRenderer.invoke('vpc:file-del-file', rel),
    fileDelFolder: (rel) => ipcRenderer.invoke('vpc:file-del-folder', rel),
    /** 本地视频播放（mpv 接管；非视频/缺 mpv 返回 ok:false） */
    filePush: (rel) => ipcRenderer.invoke('vpc:file-push', rel),
    /** Phase 6 下载管理（aria2c）：action ∈ init/add/addFile/pickDir/pause/unpause/remove/clear */
    download: {
        control: (action, payload) => ipcRenderer.invoke('vpc:dl', action, payload || {}),
        /** 更换下载目录（系统对话框，持久化，重启下载引擎） */
        pickDir: () => ipcRenderer.invoke('vpc:dl', 'pickDir', {}),
        /** 打开下载目录（资源管理器；未更换过则系统默认下载目录） */
        openDir: () => ipcRenderer.invoke('vpc:dl-open-dir'),
        /** 主进程 1s 轮询推送的全量任务列表 */
        onList: (cb) => ipcRenderer.on('vpc:dl-list', (_e, items) => cb(items)),
        /** { type: 'completed'|'error', task } */
        onEvent: (cb) => ipcRenderer.on('vpc:dl-event', (_e, data) => cb(data)),
        /** 点完成通知时跳回下载视图 */
        onGoto: (cb) => ipcRenderer.on('vpc:dl-goto', () => cb()),
        /** 播放已下载的视频文件（mpv 接管） */
        play: (filePath) => ipcRenderer.invoke('vpc:dl-play', filePath),
    },
    /** Phase 7 推送：手动推送 URL 直接交 mpv */
    pushUrl: (url) => ipcRenderer.invoke('vpc:push-url', url),
    /** 局域网推送服务信息 { ip, port, token } */
    pushInfo: () => ipcRenderer.invoke('vpc:push-info'),
    /** 局域网推送到达事件（mpv 已由主进程接管） */
    onPushReceived: (cb) => ipcRenderer.on('vpc:push-received', (_e, info) => cb(info)),
    /** VIP 解析：目标地址 → 直链 {ok, url, header, via} | {ok:false, reason} */
    resolveParse: (url) => ipcRenderer.invoke('vpc:parse', url),
    /** 无解析接口时的兜底：隐藏窗口直开链接抓播放器发出的媒体请求（share 分享页）。
     *  legacy=true 走旧解析器（useLegacyParser）：监听 iframe src 并跟随。 */
    captureDirect: (url, legacy) => ipcRenderer.invoke('vpc:capture-direct', { url, legacy: !!legacy }),
    /** 验证码源验证（T73）：可见窗口供用户交互，关闭后收割 Cookie 交由后端持久化 */
    captchaVerify: (url) => ipcRenderer.invoke('vpc:captcha-verify', { url }),
    /** 换肤：选择本地图片作壁纸（系统文件对话框，返回路径） */
    pickWallpaper: () => ipcRenderer.invoke('vpc:pick-wallpaper'),
    /** 应用版本号（关于分类展示） */
    appVersion: () => ipcRenderer.invoke('vpc:app-version'),
    /** 关于页系统信息：{version, platform, arch, electron, chromium, node, v8} */
    appInfo: () => ipcRenderer.invoke('vpc:app-info'),
    /** 窗口控制（无边框模式下的最小化/最大化/关闭） */
    winMinimize: () => ipcRenderer.invoke('vpc:win-minimize'),
    winMaximize: () => ipcRenderer.invoke('vpc:win-maximize'),
    winClose: () => ipcRenderer.invoke('vpc:win-close'),
    /** 内置 MiSans 字体 CSS 的 file:// URL 列表（渲染层注入 <link>；空数组回退系统字体，T61） */
    fontCss: () => ipcRenderer.invoke('vpc:font-css'),
    /** 设置持久化（userData/settings.json） */
    settingsGet: async () => {
        if (_settingsCache && Date.now() - _settingsCacheTs < _SETTINGS_TTL) {
            return _clone(_settingsCache);
        }
        const all = await ipcRenderer.invoke('vpc:settings-get');
        _settingsCache = all || {};
        _settingsCacheTs = Date.now();
        return _clone(_settingsCache);
    },
    settingsSet: async (key, value) => {
        const r = await ipcRenderer.invoke('vpc:settings-set', key, value);
        // 写穿透：更新缓存该键，后续读立即可见（缓存未初始化则不猜整体，下次读拉全量）
        if (_settingsCache) { _settingsCache[String(key)] = _clone(value); _settingsCacheTs = Date.now(); }
        return r;
    },
    /** 恢复默认设置（清偏好类键，保留收藏/历史/源），应用自动重启 */
    settingsReset: () => { _settingsCache = null; return ipcRenderer.invoke('vpc:settings-reset'); },
    /** 缓存位置：不传 dir 弹目录选择框（返回 need-restart+path）；传 dir 提交并重启后端 */
    pickCacheDir: (dir) => ipcRenderer.invoke('vpc:pick-cache-dir', dir || ''),
    /** 通用目录选择（mpv 硬盘缓存目录用）：{ok, path} | {ok:false, reason:'cancelled'} */
    pickFolder: () => ipcRenderer.invoke('vpc:pick-folder'),
    /** 设置 mpv 视频缓冲缓存（mode='memory'|'disk'，dir 为硬盘缓存目录，空串沿用已记忆目录）：
     *  返回 {ok, mode, dir, cleanedBytes}（切内存/换路径时自动清理旧目录缓存） */
    setPlayerCache: (mode, dir) => ipcRenderer.invoke('vpc:set-player-cache', mode, dir || ''),
    /** 清空 mpv 硬盘缓存（不改变模式/目录）：{ok, cleanedBytes} */
    clearPlayerCache: () => ipcRenderer.invoke('vpc:clear-player-cache'),
    /** 统一清理主进程侧本地缓存（mpv 缓存 / 预览图 / 解析窗口会话）：{ok, cleanedBytes, detail} */
    clearAppCaches: () => ipcRenderer.invoke('vpc:clear-app-caches'),
    /** 快捷键步长变更后通知主进程重写 mpv input.conf */
    updateHotkeys: () => ipcRenderer.invoke('vpc:update-hotkeys'),
    /** 播放偏好（默认倍速 / 记忆位置）变更后通知主进程，下次起播生效 */
    updatePlayerPrefs: () => ipcRenderer.invoke('vpc:update-player-prefs'),
    /** mpv 截图：当前帧存 PNG（{ok, path} | {ok:false, reason}） */
    mpvScreenshot: () => ipcRenderer.invoke('vpc:mpv-screenshot'),
    /** 弹幕装载（方案 A）：把整集弹弹 play 弹幕转 ASS 推给 mpv（{ok, count} | {ok:false, reason}） */
    loadDanmaku: (comments) => ipcRenderer.invoke('vpc:load-danmaku', comments),
    /** 打开截图目录：{ok, dir} | {ok:false, reason} */
    mpvScreenshotDir: () => ipcRenderer.invoke('vpc:mpv-screenshot-dir'),
    /** 启动自动重载 lastConfigUrl 完成 */
    onConfigReloaded: (cb) => ipcRenderer.on('vpc:config-reloaded', (_e, info) => cb(info)),
    /** 打包版自动更新状态：checking/available/downloading/downloaded/error */
    onUpdateState: (cb) => ipcRenderer.on('vpc:update-state', (_e, info) => cb(info)),
    /** 鼠标侧键前进/后退事件 { dir: 'back'|'forward' }（渲染层维护视图历史栈） */
    onMouseNav: (cb) => ipcRenderer.on('vpc:mouse-nav', (_e, info) => cb(info)),
    /** 直播频道探活：批量检测 HTTP/HTTPS 流地址可达性，返回布尔数组 */
    probeUrls: (urls) => ipcRenderer.invoke('vpc:probe-urls', urls),
    /** 自定义 mpv 播放器路径：选择本地 mpv.exe 替代内置版本 */
    pickMpv: () => ipcRenderer.invoke('vpc:pick-mpv'),
    clearMpvPath: () => ipcRenderer.invoke('vpc:clear-mpv-path'),
    mpvPath: () => ipcRenderer.invoke('vpc:mpv-path'),
    /** 一键补装内置播放器（mpv）：下载到 userData/vendor 并自动生效 {ok, path} | {ok:false, reason} */
    downloadMpv: () => ipcRenderer.invoke('vpc:download-mpv'),
    /** mpv 下载进行中状态推送 { downloading } */
    onMpvDownloadState: (cb) => ipcRenderer.on('vpc:mpv-download-state', (_e, info) => cb(info)),
    /** mpv 进程异步启动失败（文件被删/损坏/无权限）：渲染层给友好提示 { code, reason } */
    onPlayerSpawnError: (cb) => ipcRenderer.on('vpc:player-spawn-error', (_e, info) => cb(info)),
    /** 资产就绪状态：ffmpeg / mpv / aria2 / Anime4K 是否就绪 */
    assetStatus: () => ipcRenderer.invoke('vpc:asset-status'),
    /** SyncPlay 一起看：连接/断开/状态/文件/聊天 */
    syncplay: {
        connect: (opts) => ipcRenderer.invoke('vpc:syncplay-connect', opts),
        disconnect: () => ipcRenderer.invoke('vpc:syncplay-disconnect'),
        sendState: (pos, paused, seek) => ipcRenderer.invoke('vpc:syncplay-state', pos, paused, seek),
        sendFile: (name, duration) => ipcRenderer.invoke('vpc:syncplay-file', name, duration),
        sendChat: (msg) => ipcRenderer.invoke('vpc:syncplay-chat', msg),
        onState: (cb) => ipcRenderer.on('vpc:syncplay-state', (_e, info) => cb(info)),
        onChat: (cb) => ipcRenderer.on('vpc:syncplay-chat', (_e, info) => cb(info)),
        onFile: (cb) => ipcRenderer.on('vpc:syncplay-file', (_e, info) => cb(info)),
        onUsers: (cb) => ipcRenderer.on('vpc:syncplay-users', (_e, info) => cb(info)),
        onDisconnect: (cb) => ipcRenderer.on('vpc:syncplay-disconnect', () => cb()),
        onError: (cb) => ipcRenderer.on('vpc:syncplay-error', (_e, info) => cb(info)),
    },
    /** DLNA 投屏：搜索设备/投屏/停止 */
    dlna: {
        search: () => ipcRenderer.invoke('vpc:dlna-search'),
        cast: (deviceUrl, mediaUrl, title) => ipcRenderer.invoke('vpc:dlna-cast', deviceUrl, mediaUrl, title),
        stop: (deviceUrl) => ipcRenderer.invoke('vpc:dlna-stop', deviceUrl),
        onDevices: (cb) => ipcRenderer.on('vpc:dlna-devices', (_e, devices) => cb(devices)),
        onError: (cb) => ipcRenderer.on('vpc:dlna-error', (_e, info) => cb(info)),
    },
    /** 外部播放器：在弹窗/手动场景主动唤起 VLC/PotPlayer/mpv 或系统默认程序（opts.header 带 Referer/UA） */
    externalPlayer: (url, opts) => ipcRenderer.invoke('vpc:external-player', url, opts || {}),
    /** 统一「指定播放器」：选 mpv → 内置全功能；选 VLC/PotPlayer → 作为主播放器 */
    pickPlayer: () => ipcRenderer.invoke('vpc:pick-player'),
    /** 当前播放器配置 { mode:'external'|'internal-mpv', path, kind, available } */
    playerConfig: () => ipcRenderer.invoke('vpc:player-config'),
    /** 恢复默认播放器（回内置自动发现 mpv） */
    clearPlayer: () => ipcRenderer.invoke('vpc:clear-player'),
    /** 定时关机：设定 N 分钟后关机（0 = 取消） */
    shutdownTimer: (minutes) => ipcRenderer.invoke('vpc:shutdown-timer', minutes),
    /** 代理设置：{url, enable}；应用后重启后端使 Python requests 生效 */
    setProxy: (opts) => ipcRenderer.invoke('vpc:set-proxy', opts),
    /** 夸克网盘 JAR 快路径开关；修改后重启 Python 后端生效 */
    setPanFastPath: (enabled) => ipcRenderer.invoke('vpc:set-pan-fast-path', !!enabled),
    /** 代理连通性测试：{proxyUrl, url}；不改变持久化设置，返回 {ok, statusCode, elapsedMs, reason} */
    testProxy: (opts) => ipcRenderer.invoke('vpc:test-proxy', opts),
    /** 弹幕凭据：{appid, secret}；保存并重启后端使弹弹 play 弹幕生效 */
    setDandan: (opts) => ipcRenderer.invoke('vpc:set-dandan', opts),
    /** 日志查看器：分页获取应用日志（source 可选，按日志文件筛选） */
    getLogs: (page, pageSize, source) => ipcRenderer.invoke('vpc:get-logs', page, pageSize, source),
    /** 渲染端错误上报：window.onerror / unhandledrejection 转发到主进程日志 */
    logRenderer: (level, message) => ipcRenderer.invoke('vpc:log-renderer', level, message),
    /** 日志查看器：清空应用日志 */
    clearLogs: () => ipcRenderer.invoke('vpc:clear-logs'),
    /** 日志级别：'DEBUG'|'INFO'|'WARN'|'ERROR'，立即生效并持久化 */
    setLogLevel: (level) => ipcRenderer.invoke('vpc:set-log-level', level),
    /** 定时清空日志：{enabled, days}，立即生效并持久化 */
    setLogCleanup: (opts) => ipcRenderer.invoke('vpc:set-log-cleanup', opts),
    /** 首次引导：标记已完成 */
    onboardingDone: () => ipcRenderer.invoke('vpc:onboarding-done'),
    /** 夸克网盘扫码登录（官方页面方案）：
     *  打开官方落地页登录窗口，官方 JS 完成全部流程后收割完整 Cookie（含 __puus）。
     *  panQrLogin() → {ok, cookies} | {ok:false, message}（等待用户扫码，最长 5 分钟）
     *  panQrCancel() → 取消登录（关闭窗口） */
    panQrLogin: () => ipcRenderer.invoke('vpc:pan-qr-login'),
    panQrCancel: () => ipcRenderer.invoke('vpc:pan-qr-cancel'),
    /** 界面缩放：用 Electron 页面级缩放（webFrame）替代 CSS zoom，
     *  避免 CSS zoom 破坏 unicode-range 子集化的 MiSans 字体匹配（回退系统字体的 bug）。 */
    setZoomFactor: (factor) => { try { webFrame.setZoomFactor(factor); } catch (e) { /* ignore */ } },
});
