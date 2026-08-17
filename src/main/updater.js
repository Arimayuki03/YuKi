/**
 * electron-updater 接线。开发模式不访问更新源；打包模式启动一次检查，
 * 下载完成后按 electron-updater 的标准 app.quitAndInstall() 流程在退出时安装。
 */
const { app } = require('electron');

function setupAutoUpdater(getWindow) {
    if (!app.isPackaged) return { enabled: false, reason: 'development' };
    let autoUpdater;
    try {
        ({ autoUpdater } = require('electron-updater'));
    } catch (e) {
        console.warn('[updater] electron-updater unavailable:', e.message || e);
        return { enabled: false, reason: 'dependency-missing' };
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const publish = (state, extra = {}) => {
        const payload = { state, ...extra };
        console.log('[updater]', state, extra.message || '');
        const win = typeof getWindow === 'function' ? getWindow() : null;
        if (win && !win.isDestroyed()) win.webContents.send('vpc:update-state', payload);
    };
    autoUpdater.on('checking-for-update', () => publish('checking'));
    autoUpdater.on('update-available', (info) => publish('available', { version: info.version }));
    autoUpdater.on('update-not-available', () => publish('not-available'));
    autoUpdater.on('download-progress', (progress) => publish('downloading', {
        percent: Math.round(progress.percent || 0),
    }));
    autoUpdater.on('update-downloaded', (info) => publish('downloaded', { version: info.version }));
    autoUpdater.on('error', (error) => publish('error', { message: String(error && error.message || error) }));
    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
        publish('error', { message: String(error && error.message || error) });
    });
    return { enabled: true };
}

module.exports = { setupAutoUpdater };
