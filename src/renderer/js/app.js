/**
 * app.js — 主 UI 路由与启动（Phase 2）
 *
 * 桌面布局：左侧主导航（首页/搜索/工具面板）+ 右侧视图区。
 * 启动：等待后端就绪 → 初始化各视图 → 默认显示首页。
 * 全局 Esc 派发给 common.js dispatchEsc（先关对话框，再视图处理器）。
 */
/* global $, waitBackend, warnToast, dispatchEsc, showLoading, hideLoading, doAction, applySkin, applyMisansFont, toFileUrl, setBackendInfo, UIState, Home, Search, BangumiSearch, Detail, Player, Downloads, Live, Favorites, HistoryView, My, initAuxPanels, ensureLocalPanel, Kazumi, Timeline, Popular */

const App = {
    currentView: 'home',
    _auxInited: false,
    _configWatch: null, // 配置任务后台守望轮询句柄（waitConfigDone 超时后启动，单例）
    // 视图导航历史栈：鼠标侧键后退弹栈、前进走重做栈（仅视图级，不含弹窗）
    _navStack: [],
    _navForward: [],
    // 分支级位置记忆（移动端 Tab 式分栈）：四个内容分支各自记住最后停留的位置——
    // 从某分支打开过详情，则该分支的记忆是那条详情（附 site|vodId 内容指纹），
    // 点该分支导航回到详情；其他分支不受影响、直通各自的根页面。
    // 单例详情被其他分支换片后，旧记忆指纹失配自动回根，绝不显示错误的影片。
    // 停留在详情页时点内容分支导航 = 去那个页面（直进目标根，「点击其他页面不受影响」）。
    _branchViews: ['home', 'search', 'popular', 'timeline'],
    _branchLast: { home: 'home', search: 'search', popular: 'popular', timeline: 'timeline' },
    // 页级缓存（任务十一）：只读浏览视图在 TTL 内再次切入时跳过 enter 网络重拉。
    // 仅收录只读视图（home/popular/timeline/my-统计）；history/收藏/下载等反映用户操作的视图绝不缓存。
    _cacheableViews: { home: 60000, popular: 60000, timeline: 60000 },
    _viewLoadedAt: {}, // name → 上次 enter 完成时间戳
    _scrollPos: {},    // name → 离开视图时的 scrollTop（返回时恢复浏览位置）

    /** 该视图是否在 TTL 内已加载过（可跳过 enter 重拉）。 */
    _viewFresh(name) {
        const ttl = this._cacheableViews[name];
        if (!ttl) return false;
        const at = this._viewLoadedAt[name] || 0;
        return at > 0 && (Date.now() - at) < ttl;
    },

    /** 当前详情页的内容指纹（site|vodId）：单例容器被换片后旧记忆据此自动失效。
     *  open()/openBangumi() 先写 Detail.site/vodId 再 showView，此处读取已是新内容。 */
    _detailKey() {
        try {
            if (typeof Detail === 'undefined') return '';
            return `${String(Detail.site || '')}|${String(Detail.vodId || '')}`;
        } catch (e) { return ''; }
    },

    /** 主导航点击的目标视图：该分支记住了自己的详情子页、且指纹与当前单例详情
     *  一致时回到详情；否则直通分支根。页面状态记忆总开关关闭时同样直通。
     *  停留在详情页时点内容分支导航：直进目标分支根（「点击其他页面不受影响」）。 */
    navTarget(branch) {
        if (this._branchViews.indexOf(branch) < 0) return branch; // 直播/历史/我的等无子页分支直通
        if (typeof UIState !== 'undefined' && UIState.isEnabled && !UIState.isEnabled()) return branch;
        if (this.currentView === 'detail') return branch;
        const mem = this._branchLast[branch];
        if (mem && mem.v === 'detail'
            && document.getElementById('view-detail')
            && this._detailKey() === mem.key) return 'detail';
        return branch;
    },

    /** 视图切换主入口：opts.push === false 时不入栈（后退/前进自身切换用，避免栈膨胀）；
     *  opts.refresh === true 时强制重拉（忽略页级缓存 TTL）。 */
    showView(name, opts) {
        // 旧收藏路由并入「我的」收藏页签（左侧独立收藏入口已移除）
        let myTab = null;
        if (name === 'favorites') { name = 'my'; myTab = 'favorites'; }
        const fromView = this.currentView; // 详情归属判定用：进入详情前所在视图
        // 「新开详情」标记：仅 Detail.open/openBangumi 装载新内容时置位；导航恢复、
        // 鼠标侧键返回、嵌套快照恢复等「重新展示」路径不带此标记，不改写记忆
        const freshDetail = name === 'detail' && this._detailOpening === true;
        this._detailOpening = false;
        // 切走前保存当前视图滚动位置：.view 靠 display:none 切换，Chromium 会把
        // 隐藏滚动容器的 scrollTop 归零——详情页返回搜索页等场景将回不到原浏览位置
        if (name !== this.currentView) {
            const curEl = document.getElementById('view-' + this.currentView);
            if (curEl) this._scrollPos[this.currentView] = curEl.scrollTop;
        }
        this.currentView = name;
        $('.main-nav-item').removeClass('active');
        $(`.main-nav-item[data-view="${name}"]`).addClass('active');
        $('.view').removeClass('active');
        $(`#view-${name}`).addClass('active');
        // 恢复目标视图上次离开时的浏览位置。display:block 后需等两帧布局建立，
        // 同步赋值会被重置；详情页每次进入都是新内容，固定回顶部
        const backTop = (name === 'detail') ? 0 : (this._scrollPos[name] || 0);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const el = document.getElementById('view-' + name);
            if (el) el.scrollTop = backTop;
        }));
        // 页级缓存：可缓存的只读视图在 TTL 内再次切入 → 跳过 enter 网络重拉（refresh=true 强制刷新）
        const forceRefresh = !!(opts && opts.refresh);
        const skipEnter = !forceRefresh && this._cacheableViews[name] && this._viewFresh(name);
        if (name === 'home' && typeof Home !== 'undefined' && Home.onViewShown && !skipEnter) { Home.onViewShown(); this._viewLoadedAt.home = Date.now(); } // T80：设置里改过每页条数，回来自动按新条数重载
        if (name === 'search') {
            Search.focus();
            // 改过「每页影片数量-搜索」后回来：按新条数立即重绘现有结果（无需重新搜索）
            if (Search.onViewShown) Search.onViewShown();
        }
        if (name === 'downloads') Downloads.enter();
        if (name === 'live') Live.enter();
        if (name === 'history') HistoryView.enter();
        if (name === 'my') My.enter(myTab);
        if (name === 'tools') ensureLocalPanel(); // T28：本地文件独立板块，首次进入懒加载
        if (name === 'timeline') {
            const firstTl = (typeof Timeline !== 'undefined') && !Timeline._inited; // init() 首次会自行 load()，避免重复拉取
            Timeline.init();
            // TTL 内再次切入：跳过收藏集合重建与日历重拉——DOM 原样保留，切回即显
            // 上次内容（收藏状态变更由 FavHub 订阅实时同步，无需每次进页重扫重绘）。
            // 过期/首次才重建过滤集合并刷新日历。
            if (!skipEnter) {
                Timeline.refreshCollections(); // 重建收藏过滤集合（仅本地，无日历网络）
                if (!firstTl) Timeline.load(); // 再次切入且已过期 → 刷新日历（TTL 内则跳过）
            }
            this._viewLoadedAt.timeline = Date.now();
        } // 番剧时间表（Bangumi）
        if (name === 'popular' && !skipEnter) { Popular.enter(); this._viewLoadedAt.popular = Date.now(); } // Kazumi 首页推荐（Bangumi 趋势，T62）
        // 分支位置记忆更新：仅「新开详情」且来源是四分支之一时，该分支记住这条详情
        // （附内容指纹，换片后失配自动回根）；恢复展示/回根视图时按对应规则改写，
        // 其他入口（历史/收藏/下载等）打开的详情不属于四个内容分支，不写记忆。
        if (name === 'detail') {
            if (freshDetail && this._branchViews.indexOf(fromView) >= 0) {
                this._branchLast[fromView] = { v: 'detail', key: this._detailKey() };
            }
        } else if (this._branchViews.indexOf(name) >= 0) {
            this._branchLast[name] = name;
        }
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
     * 避免首页停留在内置示例源（但最多等 15s——网络慢时不能一直卡在全局 loading；
     * 超时未完成也继续进首页，配置完成后 onConfigReloaded 会刷新站点）。
     * 重载状态以主进程 configState 为准（它掌握发起时机），
     * configTask 作为后端侧双重确认。
     * opts.quiet=true 时为后台静默模式：不操作全局 loading 遮罩（首页已有缓存
     * 即时上屏，遮罩反而遮挡画面），完成后仅 toast 提示。
     */
    async waitConfigDone(opts) {
        const quiet = !!(opts && opts.quiet);
        let loaded = 0;
        let stillBusy = false;
        for (let i = 0; i < 15; i++) {
            let busy = false;
            try {
                const st = await window.yuki.configState();
                busy = !!(st && st.reloading);
            } catch (e) { /* IPC 异常忽略 */ }
            let t = null;
            try { t = await doAction('configTask', {}); } catch (e) { /* 后端未就绪，以 configState 为准 */ }
            if (typeof Home !== 'undefined' && Home.renderRestoreProgress) Home.renderRestoreProgress(t);
            if (t && t.status === 'loading') busy = true;
            if (t && t.status === 'done' && t.summary && Number(t.summary.healthy ?? t.summary.sites) > 0) {
                loaded = Number(t.summary.healthy ?? t.summary.sites);
            }
            // 观察到空闲 = 窗口期内正常完成：清掉 busy 标记、跳出。此前 stillBusy
            // 一旦置位就不再清除，导致正常完成后仍误启动 watchConfigTask——守望
            // 会在 3s 后对着已完成的任务再触发一轮重复的 loadSites/Live.load，
            // 与 onConfigReloaded 事件的刷新叠加，全局遮罩连续闪现两次。
            if (!busy) { stillBusy = false; break; }
            stillBusy = true;
            if (!quiet) showLoading();
            await new Promise((r) => setTimeout(r, 1000));
        }
        if (!quiet) hideLoading();
        if (loaded > 0) warnToast(`已自动载入上次配置：${loaded} 个站点`);
        // 15s 超时仍在加载（大配置磁盘恢复/慢网络重载）：转入后台守望——
        // 恢复/重载完成时若错过主进程 onConfigReloaded 事件（等待窗口已过、
        // 或自动重载因 loading 被后端拒收），这里兜底刷新首页，否则用户会
        // 一直停在示例源，表现为「重启后不加载缓存」。
        if (stillBusy) this.watchConfigTask();
        return loaded;
    },

    /** 后台守望配置任务：每 3s 查 configTask，离开 loading 即刷新首页/直播页。
     *  单例（重复调用共享一个轮询），最长 5 分钟自动停止；轮询同时驱动恢复进度条。 */
    watchConfigTask() {
        if (this._configWatch) return;
        let polls = 0;
        const timer = setInterval(async () => {
            polls += 1;
            let t = null;
            try { t = await doAction('configTask', {}); } catch (e) { /* 后端瞬断忽略 */ }
            if (typeof Home !== 'undefined' && Home.renderRestoreProgress) Home.renderRestoreProgress(t);
            const busy = !t || t.status === 'loading';
            if (busy && polls < 100) return;
            clearInterval(timer);
            this._configWatch = null;
            if (t && t.status === 'done') {
                if (typeof Home !== 'undefined' && Home._inited && Home.loadSites) {
                    Promise.resolve().then(() => Home.loadSites({ silent: true })).catch(() => {});
                }
                if (typeof Live !== 'undefined' && Live._inited && Live.load) {
                    Promise.resolve().then(() => Live.load({ silent: true })).catch(() => {});
                }
            }
        }, 3000);
        this._configWatch = timer;
    },

    initNav() {
        $('.main-nav-item').on('click', (e) => {
            const v = String($(e.currentTarget).data('view') || '');
            // 分支位置记忆：点主导航回到该分支上次停留处（首页/搜索/推荐/时间表的
            // 详情子页）；已在分支内再点主导航 → 回分支根。其余分支直通。
            this.showView(this.navTarget(v));
        });
        // 侧栏收缩/展开（只显示图标），状态持久化
        $('#nav-collapse').on('click', () => {
            const collapsed = document.body.classList.toggle('nav-collapsed');
            window.yuki.settingsSet('navCollapsed', collapsed);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') dispatchEsc();
        });
    },

    /** 回到顶部：监听各视图滚动（scroll 不冒泡，直接绑定），超一屏显示悬浮按钮。
     *  顶部固定条为常驻显示（不再随滚动隐藏），这里只需确保其 .visible 类存在。 */
    initBackTop() {
        const btn = document.getElementById('back-top');
        $('.view').on('scroll', function () {
            const st = this.scrollTop;
            btn.classList.toggle('show', st > 400);
        });
        btn.addEventListener('click', () => {
            const v = document.querySelector('.view.active');
            if (!v) return;
            // 平滑回顶标记：滚动补偿类逻辑（如吐槽续拉锚点回拨）据此避让，
            // 防止与进行中的平滑动画抢滚动条造成画面割裂。
            v._yukiSmoothTop = true;
            const clear = () => { v._yukiSmoothTop = false; };
            if ('onscrollend' in v) v.addEventListener('scrollend', clear, { once: true });
            else setTimeout(clear, 1500);
            // 已在顶部时 scrollend 可能不触发，兜底再清一次
            setTimeout(clear, 3000);
            v.scrollTo({ top: 0, behavior: 'smooth' });
        });
    },
};

$(async function bootstrap() {
    // 渲染端未捕获错误落盘：转发到主进程 electron-main.log（脱敏由主进程 writer 负责）。
    // 尽早注册，晚于此的启动错误也能被记录。
    const _forwardRendererError = (level, message) => {
        try { if (window.yuki && window.yuki.logRenderer) window.yuki.logRenderer(level, String(message || '').slice(0, 4000)); } catch (e) { /* 上报失败不影响运行 */ }
    };
    window.addEventListener('error', (e) => {
        const msg = e && e.error && e.error.stack ? e.error.stack : `${e && e.message} @ ${e && e.filename}:${e && e.lineno}:${e && e.colno}`;
        _forwardRendererError('ERROR', `window.onerror: ${msg}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
        const r = e && e.reason;
        const msg = r && r.stack ? r.stack : (r && r.message) || String(r);
        _forwardRendererError('ERROR', `unhandledrejection: ${msg}`);
    });

    // 尽早读取本地设置（主题/启动页/字体开关，无需等后端）
    let s = {};
    try { s = (await window.yuki.settingsGet()) || {}; } catch (e) { /* 首次运行无 settings */ }

    // 页面状态记忆总开关（设置 → 外观）：同步给 ui-state.js（各页持久化读写的唯一门禁）。
    // 须在任何视图 init/enter 之前生效——启动恢复路径据此决定是否还原上次状态。默认开。
    if (typeof UIState !== 'undefined' && UIState.setEnabled) UIState.setEnabled(s.uiStateMemory !== false);

    // 载入内置 MiSans 字体（打包内置、无运行时下载；开关关闭时回退系统字体，T61 / 2.11）
    await applyMisansFont(s.useMisansFont !== false);

    // 尽早恢复主题/壁纸/明暗/缩放/字号（只依赖本地 settings，无需等后端）
    try {
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
            glass: s.glass === true,
        });
        // 侧栏收缩状态恢复
        if (s.navCollapsed) document.body.classList.add('nav-collapsed');
        // 隐身模式缓存（detail.js 记历史前检查）
        window._incognito = !!s.incognito;
        // 应用内错误提示开关（2.8）
        if (typeof setErrorToastEnabled === 'function') setErrorToastEnabled(s.errorToast !== false);
    } catch (e) { /* 首次运行无 settings */ }

    // 后端重启（如更换缓存目录）后更新连接信息
    if (window.yuki.onBackendReady) window.yuki.onBackendReady((info) => setBackendInfo(info));

    // 配置自动重载完成事件必须在等待后端前注册；主进程可能在后端就绪后立即完成重载。
    if (window.yuki.onConfigReloaded) {
        window.yuki.onConfigReloaded((info) => {
            if (!info || !info.ok) return;
            // 完成事件是权威信号：停掉可能仍在跑的后台守望轮询（waitConfigDone
            // 15s 超时兜底）。否则事件刷新后守望又在 3s 内重复触发一轮
            // loadSites/Live.load，首页/直播遮罩连续闪现两次。
            if (App._configWatch) { clearInterval(App._configWatch); App._configWatch = null; }
            if (typeof Player !== 'undefined' && Player.resetVipFlags) Player.resetVipFlags();
            if (typeof Home !== 'undefined' && Home._inited && Home.loadSites) {
                Promise.resolve().then(() => Home.loadSites({ silent: true })).catch(() => {});
            }
            if (typeof Live !== 'undefined' && Live._inited && Live.load) {
                Promise.resolve().then(() => Live.load({ silent: true })).catch(() => {});
            }
        });
    }

    // UI 骨架先行绑定：此前导航/窗口按钮在 waitBackend 成功后才绑定，后端启动慢
    // （大配置磁盘恢复、慢镜像 jar 下载）时整个窗口没有任何事件处理器——表现为
    // 「页面卡死无反应，不能进行交互」，只能任务管理器强杀。先绑骨架再等后端，
    // 等待期间用户可正常切换视图/最小化/关闭窗口。
    App.initNav();
    App.initBackTop();
    // 鼠标侧键前进/后退：主进程 app-command 转发 + 渲染层 mousedown 兜底（双通道去重）
    if (window.yuki.onMouseNav) window.yuki.onMouseNav((p) => App.mouseNav(p && p.dir));
    App.initMouseButtons();
    // 无边框模式：窗口控制按钮 + body 标记
    (async () => {
        try {
            const s = await window.yuki.settingsGet();
            if (s && s.systemTitleBar !== true) document.body.classList.add('frameless');
        } catch (e) { /* 默认无边框 */ document.body.classList.add('frameless'); }
        if (window.yuki.winMinimize) $('#win-min').on('click', () => window.yuki.winMinimize());
        if (window.yuki.winMaximize) $('#win-max').on('click', () => window.yuki.winMaximize());
        if (window.yuki.winClose) $('#win-close').on('click', () => window.yuki.winClose());
    })();

    showLoading('正在启动后端服务…', { blocking: true });
    const ok = await waitBackend();
    hideLoading();
    if (!ok) {
        warnToast('后端启动失败，请检查 python-backend');
        return;
    }
    Player.init();
    Detail.init();
    Search.init();
    if (typeof BangumiSearch !== 'undefined' && BangumiSearch.init) BangumiSearch.init();
    Live.init();
    // Kazumi 规则引擎前端模块（kimi UI，glm5.2 后端端点）
    if (typeof Kazumi !== 'undefined' && Kazumi.init) Kazumi.init();
    // 首页先上屏：有站点缓存则预渲染秒出真实列表；无缓存由首页显示「正在恢复
    // 上次的配置…」提示（后端恢复最坏 ~45s，全局 loading 根本等不完）。
    // 配置恢复/自动重载一律后台等待——此前无缓存时会用全局遮罩阻塞 15-25s，
    // 等完照样是示例源，体验极差；完成后由 configTask 守望/重载事件自动刷新。
    await Home.init();
    App.waitConfigDone({ quiet: true }).catch(() => { /* 后台轮询失败不影响启动 */ });
    // 辅助面板（工具面板）惰性初始化一次
    if (!App._auxInited) { initAuxPanels(); App._auxInited = true; }
    // 启动进入页面（设置里可配置默认页；校验视图存在，否则首页）。
    // 启动等待期间用户若已自行切换到其他视图（_navStack 非空），则尊重当前
    // 视图不再强制跳转——修复「启动加载完成后被自动拽回首页」的问题。
    if (!App._navStack.length) {
        const startupView = (s.startupView && document.getElementById('view-' + s.startupView)) ? s.startupView : 'home';
        App.showView(startupView);
    }
    // 后台预载推荐数据（本地缓存 + 刷新），点开推荐页即时显示、无首次网络等待
    if (typeof Popular !== 'undefined' && Popular.preload) Popular.preload();
});

(function (root) {
    root.YUKI = root.YUKI || {};
    root.YUKI.app = App;
}(typeof window !== 'undefined' ? window : globalThis));
