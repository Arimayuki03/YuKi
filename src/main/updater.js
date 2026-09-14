/**
 * updater.js — electron-updater 接线（RM-2 应用内 GitHub 检测更新）
 *
 * - 更新源：package.json `build.publish`（GitHub Releases）；CI 随安装包上传
 *   `latest.yml` 与 `.exe.blockmap`（release.yml），Draft Release publish 后才可被检测到。
 * - 打包模式：启动静默检查一次。设置 autoUpdate（默认关）= 开时静默下载 + 退出安装；
 *   关（默认）= 仅提醒，用户在设置页点「下载更新」后再下载（检查前动态应用 autoDownload）。
 * - 开发模式不访问更新源；手动检查 IPC 返回明确的 development 语义而非报错。
 * - 代理：electron-updater 在主进程经 Electron net（默认 session）发请求，
 *   应用内设置的 session 代理对其检查/下载链路生效，无需额外配置。
 * - createUpdaterController 为纯逻辑（依赖注入），可脱离 Electron 单测。
 */

let electronApp = null;
let electronIpcMain = null;
try {
    const e = require('electron');
    electronApp = e.app || null;
    electronIpcMain = e.ipcMain || null;
} catch (e) { /* test runner / non-electron environment */ }

/** 事件 → 渲染层状态归一与手动操作（checking/available/not-available/downloading/
 *  downloaded/error）。@param getAutoUpdatePref () => boolean|undefined 设置项读取器 */
function createUpdaterController({ autoUpdater, publish, getAutoUpdatePref }) {
    let inflight = null; // 启动静默检查进行中时手动点击复用同一 promise，避免并发检查

    autoUpdater.on('checking-for-update', () => publish('checking'));
    autoUpdater.on('update-available', (info) => publish('available', { version: info && info.version }));
    autoUpdater.on('update-not-available', () => publish('not-available'));
    autoUpdater.on('download-progress', (p) => publish('downloading', {
        percent: Math.round((p && p.percent) || 0),
    }));
    autoUpdater.on('update-downloaded', (info) => publish('downloaded', { version: info && info.version }));
    autoUpdater.on('error', (error) => {
        inflight = null;
        publish('error', { message: String((error && error.message) || error) });
    });

    /** 每次检查前应用设置：开 = 静默下载 + 退出安装；关（默认）= 仅提醒。 */
    function applyAutoDownloadPref() {
        // 仅显式为 true 才自动下载（默认关）：未设置/脏数据回落为仅提醒，不静默下载
        const on = (typeof getAutoUpdatePref === 'function') ? getAutoUpdatePref() === true : false;
        autoUpdater.autoDownload = on;
        autoUpdater.autoInstallOnAppQuit = true;
        return on;
    }

    return {
        /** 启动静默检查 / 手动检查共用；返回进行中的检查 promise（去重复用）。 */
        check() {
            if (inflight) return inflight;
            applyAutoDownloadPref();
            inflight = Promise.resolve(autoUpdater.checkForUpdates()).finally(() => { inflight = null; });
            return inflight;
        },
        /** 手动下载（autoUpdate 关时设置页「下载更新」按钮）。 */
        async download() {
            await autoUpdater.downloadUpdate();
        },
        /** 退出并安装已下载的更新。 */
        install() {
            autoUpdater.quitAndInstall();
        },
    };
}

/**
 * 主进程接线：注册手动检查/下载/安装 IPC（开发模式同样注册，返回 development 语义），
 * 打包模式再接 electron-updater 启动静默检查。
 * @param getWindow () => BrowserWindow（状态推送给渲染层）
 * @param deps.settings Settings 实例（读 autoUpdate）
 */
function setupAutoUpdater(getWindow, deps = {}) {
    if (!electronApp || !electronIpcMain) return { enabled: false, reason: 'no-electron-runtime' };

    const settings = deps.settings || null;
    let controller = null; // 开发模式保持 null：IPC 返回 development 语义而非报错

    electronIpcMain.handle('yuki:check-for-updates', async () => {
        if (!controller) return { ok: false, reason: 'development' };
        try { await controller.check(); return { ok: true }; }
        catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    });
    electronIpcMain.handle('yuki:update-download', async () => {
        if (!controller) return { ok: false, reason: 'development' };
        try { await controller.download(); return { ok: true }; }
        catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    });
    electronIpcMain.handle('yuki:update-install', () => {
        if (!controller) return { ok: false, reason: 'development' };
        controller.install();
        return { ok: true };
    });

    if (!electronApp.isPackaged) return { enabled: false, reason: 'development' };
    let autoUpdater;
    try {
        ({ autoUpdater } = require('electron-updater'));
    } catch (e) {
        console.warn('[updater] electron-updater unavailable:', e.message || e);
        return { enabled: false, reason: 'dependency-missing' };
    }

    const publish = (state, extra = {}) => {
        const payload = { state, ...extra };
        console.log('[updater]', state, extra.message || '');
        const win = typeof getWindow === 'function' ? getWindow() : null;
        if (win && !win.isDestroyed()) win.webContents.send('yuki:update-state', payload);
    };
    controller = createUpdaterController({
        autoUpdater,
        publish,
        getAutoUpdatePref: () => (settings && typeof settings.get === 'function') ? settings.get('autoUpdate') : undefined,
    });
    // 启动静默检查：错误已经 autoUpdater 'error' 事件 publish，此处只兜日志
    controller.check().catch((e) => console.warn('[updater] 启动检查失败:', (e && e.message) || e));
    return { enabled: true };
}

module.exports = { setupAutoUpdater, createUpdaterController };
