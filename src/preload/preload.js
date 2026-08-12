/**
 * preload.js — contextBridge 安全暴露（contextIsolation 开启，nodeIntegration 关闭）
 */
const { contextBridge, ipcRenderer } = require('electron');

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
    /** 内置 MiSans 字体 CSS 的 file:// URL 列表（渲染层注入 <link>；空数组回退系统字体，T61） */
    fontCss: () => ipcRenderer.invoke('vpc:font-css'),
    /** 设置持久化（userData/settings.json） */
    settingsGet: () => ipcRenderer.invoke('vpc:settings-get'),
    settingsSet: (key, value) => ipcRenderer.invoke('vpc:settings-set', key, value),
    /** 恢复默认设置（清偏好类键，保留收藏/历史/源），应用自动重启 */
    settingsReset: () => ipcRenderer.invoke('vpc:settings-reset'),
    /** 缓存位置：不传 dir 弹目录选择框（返回 need-restart+path）；传 dir 提交并重启后端 */
    pickCacheDir: (dir) => ipcRenderer.invoke('vpc:pick-cache-dir', dir || ''),
    /** 通用目录选择（mpv 硬盘缓存目录用）：{ok, path} | {ok:false, reason:'cancelled'} */
    pickFolder: () => ipcRenderer.invoke('vpc:pick-folder'),
    /** 设置 mpv 视频缓冲缓存（mode='memory'|'disk'，dir 为硬盘缓存目录，空串沿用已记忆目录）：
     *  返回 {ok, mode, dir, cleanedBytes}（切内存/换路径时自动清理旧目录缓存） */
    setPlayerCache: (mode, dir) => ipcRenderer.invoke('vpc:set-player-cache', mode, dir || ''),
    /** 清空 mpv 硬盘缓存（不改变模式/目录）：{ok, cleanedBytes} */
    clearPlayerCache: () => ipcRenderer.invoke('vpc:clear-player-cache'),
    /** 快捷键步长变更后通知主进程重写 mpv input.conf */
    updateHotkeys: () => ipcRenderer.invoke('vpc:update-hotkeys'),
    /** 播放偏好（默认倍速 / 记忆位置）变更后通知主进程，下次起播生效 */
    updatePlayerPrefs: () => ipcRenderer.invoke('vpc:update-player-prefs'),
    /** mpv 截图：当前帧存 PNG（{ok, path} | {ok:false, reason}） */
    mpvScreenshot: () => ipcRenderer.invoke('vpc:mpv-screenshot'),
    /** 打开截图目录：{ok, dir} | {ok:false, reason} */
    mpvScreenshotDir: () => ipcRenderer.invoke('vpc:mpv-screenshot-dir'),
    /** 启动自动重载 lastConfigUrl 完成 */
    onConfigReloaded: (cb) => ipcRenderer.on('vpc:config-reloaded', (_e, info) => cb(info)),
    /** 鼠标侧键前进/后退事件 { dir: 'back'|'forward' }（渲染层维护视图历史栈） */
    onMouseNav: (cb) => ipcRenderer.on('vpc:mouse-nav', (_e, info) => cb(info)),
    /** 直播频道探活：批量检测 HTTP/HTTPS 流地址可达性，返回布尔数组 */
    probeUrls: (urls) => ipcRenderer.invoke('vpc:probe-urls', urls),
    /** 自定义 mpv 播放器路径：选择本地 mpv.exe 替代内置版本 */
    pickMpv: () => ipcRenderer.invoke('vpc:pick-mpv'),
    clearMpvPath: () => ipcRenderer.invoke('vpc:clear-mpv-path'),
    mpvPath: () => ipcRenderer.invoke('vpc:mpv-path'),
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
    /** 外部播放器：用 VLC/PotPlayer 等外部播放器播放 */
    externalPlayer: (url, opts) => ipcRenderer.invoke('vpc:external-player', url, opts || {}),
    pickExternalPlayer: () => ipcRenderer.invoke('vpc:pick-external-player'),
    /** 定时关机：设定 N 分钟后关机（0 = 取消） */
    shutdownTimer: (minutes) => ipcRenderer.invoke('vpc:shutdown-timer', minutes),
    /** 代理设置：{url, enable}；应用后重启后端使 Python requests 生效 */
    setProxy: (opts) => ipcRenderer.invoke('vpc:set-proxy', opts),
    /** 日志查看器：分页获取应用日志（source 可选，按日志文件筛选） */
    getLogs: (page, pageSize, source) => ipcRenderer.invoke('vpc:get-logs', page, pageSize, source),
    /** 渲染端错误上报：window.onerror / unhandledrejection 转发到主进程日志 */
    logRenderer: (level, message) => ipcRenderer.invoke('vpc:log-renderer', level, message),
    /** 日志查看器：清空应用日志 */
    clearLogs: () => ipcRenderer.invoke('vpc:clear-logs'),
    /** 首次引导：标记已完成 */
    onboardingDone: () => ipcRenderer.invoke('vpc:onboarding-done'),
});
