/**
 * app.js — 主 UI 路由与启动（Phase 2）
 *
 * 桌面布局：左侧主导航（首页/搜索/工具面板）+ 右侧视图区。
 * 启动：等待后端就绪 → 初始化各视图 → 默认显示首页。
 * 全局 Esc 派发给 common.js dispatchEsc（先关对话框，再视图处理器）。
 */
/* global $, waitBackend, warnToast, dispatchEsc, showLoading, hideLoading, doAction, applySkin, toFileUrl, setBackendInfo, Home, Search, Detail, Player, Downloads, Live, Favorites, HistoryView, initAuxPanels, ensureLocalPanel, Kazumi */

const App = {
    currentView: 'home',
    _auxInited: false,
    // 视图导航历史栈：鼠标侧键后退弹栈、前进走重做栈（仅视图级，不含弹窗）
    _navStack: [],
    _navForward: [],

    /** opts.push === false 时不入栈（后退/前进自身切换用，避免栈膨胀）。 */
    showView(name, opts) {
        this.currentView = name;
        $('.main-nav-item').removeClass('active');
        $(`.main-nav-item[data-view="${name}"]`).addClass('active');
        $('.view').removeClass('active');
        $(`#view-${name}`).addClass('active');
        if (name === 'search') Search.focus();
        if (name === 'downloads') Downloads.enter();
        if (name === 'live') Live.enter();
        if (name === 'favorites') Favorites.enter();
        if (name === 'history') HistoryView.enter();
        if (name === 'tools') ensureLocalPanel(); // T28：本地文件独立板块，首次进入懒加载
        if (!opts || opts.push !== false) {
            if (this._navStack[this._navStack.length - 1] !== name) {
                this._navStack.push(name);
                this._navForward = []; // 新跳转清空前进链
            }
        }
    },

    /** 鼠标侧键：后退弹栈回上一视图；前进从重做栈取。栈底不弹（停留在首页）。
     *  双通道触发（主进程 app-command IPC + 渲染层 mousedown button 3/4），400ms 去重防双跳。 */
    mouseNav(dir) {
        const now = Date.now();
        if (now - (this._navLast || 0) < 400) return;
        this._navLast = now;
        if (dir === 'back') {
            if (this._navStack.length < 2) return;
            const cur = this._navStack.pop();
            this._navForward.push(cur);
            this.showView(this._navStack[this._navStack.length - 1], { push: false });
        } else if (dir === 'forward') {
            const next = this._navForward.pop();
            if (next) this.showView(next, { push: false });
        }
    },

    /** 渲染层兜底：部分鼠标/驱动不走 WM_APPCOMMAND，Chromium 仍会把
     *  XBUTTON1/2 派发为 mousedown button=3/4，直接在此拦截（与 IPC 通道去重）。 */
    initMouseButtons() {
        document.addEventListener('mousedown', (e) => {
            if (e.button === 3) this.mouseNav('back');
            else if (e.button === 4) this.mouseNav('forward');
        });
    },

    /**
     * 启动时若主进程正在自动重载上次配置，等它完成再渲染首页，
     * 避免首页停留在内置示例源（最长等 180s）。
     * 重载状态以主进程 configState 为准（它掌握发起时机），
     * configTask 作为后端侧双重确认。
     */
    async waitConfigDone() {
        let loaded = 0;
        for (let i = 0; i < 90; i++) {
            let busy = false;
            try {
                const st = await window.vpc.configState();
                busy = !!(st && st.reloading);
            } catch (e) { /* IPC 异常忽略 */ }
            let t = null;
            try { t = await doAction('configTask', {}); } catch (e) { /* 后端未就绪，以 configState 为准 */ }
            if (t && t.status === 'loading') busy = true;
            if (t && t.status === 'done' && t.summary && t.summary.sites > 0) loaded = t.summary.sites;
            if (!busy) break;
            showLoading();
            await new Promise((r) => setTimeout(r, 2000));
        }
        hideLoading();
        if (loaded > 0) warnToast(`已自动载入上次配置：${loaded} 个站点`);
        return loaded;
    },

    initNav() {
        $('.main-nav-item').on('click', (e) => {
            const v = $(e.currentTarget).data('view');
            this.showView(v);
        });
        // 侧栏收缩/展开（只显示图标），状态持久化
        $('#nav-collapse').on('click', () => {
            const collapsed = document.body.classList.toggle('nav-collapsed');
            window.vpc.settingsSet('navCollapsed', collapsed);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') dispatchEsc();
        });
    },

    /** 回到顶部：监听各视图滚动（scroll 不冒泡，直接绑定），超一屏显示悬浮按钮。 */
    initBackTop() {
        const btn = document.getElementById('back-top');
        $('.view').on('scroll', function () {
            btn.classList.toggle('show', this.scrollTop > 400);
        });
        btn.addEventListener('click', () => {
            const v = document.querySelector('.view.active');
            if (v) v.scrollTo({ top: 0, behavior: 'smooth' });
        });
    },
};

$(async function bootstrap() {
    // 尽早恢复主题/壁纸/明暗/缩放/字体（只依赖本地 settings，无需等后端）
    try {
        const s = (await window.vpc.settingsGet()) || {};
        applySkin({
            theme: s.theme || '',
            customColor: s.customTheme || '',
            colorMode: s.colorMode || 'auto',
            fontSize: s.fontSize || '',
            textSize: s.textSize || '',
            textColor: s.textColor || '',
            dim: s.wallpaperDim || '',
            animEnabled: s.animEnabled !== false,
            wallpaperUrl: s.wallpaper ? toFileUrl(s.wallpaper) : '',
        });
        // 侧栏收缩状态恢复
        if (s.navCollapsed) document.body.classList.add('nav-collapsed');
        // 隐身模式缓存（detail.js 记历史前检查）
        window._incognito = !!s.incognito;
    } catch (e) { /* 首次运行无 settings */ }

    // 后端重启（如更换缓存目录）后更新连接信息
    if (window.vpc.onBackendReady) window.vpc.onBackendReady((info) => setBackendInfo(info));

    const ok = await waitBackend();
    if (!ok) {
        warnToast('后端启动失败，请检查 python-backend');
        return;
    }
    // 自动重载完成事件尽早注册（防事件早于监听注册而丢失）；
    // 若首页已初始化则刷新站点，否则由后续 Home.init 直接载入新站点
    if (window.vpc.onConfigReloaded) {
        window.vpc.onConfigReloaded((info) => {
            if (!info || !info.ok) return;
            if (typeof Home !== 'undefined' && Home._inited) Home.loadSites();
            if (typeof Live !== 'undefined' && Live._inited) Live.load();
        });
    }
    App.initNav();
    App.initBackTop();
    // 鼠标侧键前进/后退：主进程 app-command 转发 + 渲染层 mousedown 兜底（双通道去重）
    if (window.vpc.onMouseNav) window.vpc.onMouseNav((p) => App.mouseNav(p && p.dir));
    App.initMouseButtons();
    Player.init();
    Detail.init();
    Search.init();
    Live.init();
    // Kazumi 规则引擎前端模块（kimi UI，glm5.2 后端端点）
    if (typeof Kazumi !== 'undefined' && Kazumi.init) Kazumi.init();
    // 有上次配置时：先等主进程自动重载完成，再首次渲染首页（避免显示示例源）
    await App.waitConfigDone();
    await Home.init();
    // 辅助面板（工具面板）惰性初始化一次
    if (!App._auxInited) { initAuxPanels(); App._auxInited = true; }
    App.showView('home');
});
