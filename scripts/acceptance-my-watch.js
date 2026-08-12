/**
 * scripts/acceptance-my-watch.js — 「我的」页与观看统计真实界面验收（临时脚本）
 *
 * 用独立 userData 副本（清空 lastConfigUrl，预置 favorites/watchStats
 * 测试数据）以 --remote-debugging-port 启动临时 Electron 实例，经 CDP 实测：
 *   1. 观看统计链：断流重连同一观看链只补增量、观看次数不重复（渲染层真实 IPC 写入）
 *   2. ended 按会话归属（旧会话 ended 不误判新会话）
 *   3. 「我的」页两标签切换（观看统计/我的收藏；最近观看已按需求移除）
 *   4. 收藏面板：卡片渲染、搜索过滤、标签筛选、多选删除（含确认对话框）
 *   5. 旧收藏路由重定向到「我的 → 我的收藏」
 *   6. 控制台错误采集
 * 零依赖：使用 Node 内置 WebSocket。结束时 kill 临时实例并删除副本目录。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.VPC_CDP_PORT || 9334);

function getJson(p) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(new Error('timeout')); });
    });
}

class CDP {
    constructor(url) { this.url = url; this.id = 0; this.pend = new Map(); this.handlers = []; this.console = []; this.errors = []; }
    async connect() {
        this.ws = new WebSocket(this.url);
        await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws connect failed')); });
        this.ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.id && this.pend.has(m.id)) {
                const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id);
                if (m.error) rej(new Error(m.error.message)); else res(m.result);
            } else if (m.method) {
                for (const h of this.handlers) { try { h(m); } catch (e) { } }
            }
        };
    }
    on(fn) { this.handlers.push(fn); }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((res, rej) => {
            this.pend.set(id, { res, rej });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression, awaitPromise = false) {
        const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        if (r.exceptionDetails) throw new Error('eval exception: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
        return r.result ? r.result.value : undefined;
    }
}

(async () => {
    // ---- 准备独立 userData：复制真实设置但清空 auto-reload，预置测试数据 ----
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-accept-my-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'video-pc', 'settings.json');
    const seed = {
        lastConfigUrl: '', configHistory: [], wallpaper: '', onboarded: true,
        bangumiToken: '', // 清空真实 token：避免「我的→收藏」合并真实 Bangumi 收藏干扰计数（T74）
        watchStats: { totalSeconds: 0, sessionCount: 0, titles: {}, daily: {} },
        recentWatches: [
            { site: 'site-a', vodId: 'vod-1', name: '测试番剧 A', pic: '', remarks: '第 1 集', siteName: '来源甲', seconds: 300, percent: 42, ts: Date.now() },
            { site: 'site-b', vodId: 'vod-2', name: '测试番剧 B', pic: '', remarks: '第 2 集', siteName: '来源乙', seconds: 60, percent: 10, ts: Date.now() - 1000 },
        ],
        favorites: [
            { site: 'site-a', vodId: 'fav-1', name: '收藏片 A', pic: '', remarks: '全 12 集', siteName: '来源甲', tag: 'want', ts: Date.now() },
            { site: 'site-b', vodId: 'fav-2', name: '收藏片 B', pic: '', remarks: '全 24 集', siteName: '来源乙', tag: 'seen', ts: Date.now() - 1000 },
            { site: 'site-c', vodId: 'fav-3', name: '收藏片 C', pic: '', remarks: '更新中', siteName: '来源丙', tag: 'want', ts: Date.now() - 2000 },
        ],
    };
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        Object.assign(s, seed);
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(s, null, 2), 'utf8');
    } catch (e) {
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(seed, null, 2), 'utf8');
    }

    const electronArgs = [ROOT, '--remote-debugging-port=' + PORT, '--user-data-dir=' + tmpUserData, '--no-first-run'];
    console.log('[accept] userData =', tmpUserData);
    console.log('[accept] launching electron on port', PORT);
    const child = spawn(ELECTRON, electronArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let appLog = '';
    child.stdout.on('data', (d) => { appLog += d.toString(); });
    child.stderr.on('data', (d) => { appLog += d.toString(); });

    const cleanup = (code) => {
        try { child.kill('SIGKILL'); } catch (e) { }
        setTimeout(() => { try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (e) { } }, 800);
        process.exit(code);
    };
    process.on('SIGINT', () => cleanup(130));

    // ---- 等待 CDP 就绪 ----
    let version = null;
    for (let i = 0; i < 60; i++) {
        try { version = await getJson('/json/version'); if (version) break; } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!version) { console.error('CDP 端口未就绪\n' + appLog.slice(-2000)); cleanup(2); }

    // ---- 找主渲染页 ----
    let page = null;
    for (let i = 0; i < 30; i++) {
        try {
            const targets = await getJson('/json/list');
            page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url || '')) || targets.find((t) => t.type === 'page');
            if (page) break;
        } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!page) { console.error('找不到渲染页\n' + appLog.slice(-2000)); cleanup(2); }
    console.log('[accept] page =', page.url);

    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.on((m) => {
        if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
            const txt = (m.params.args || []).map((a) => (a.value !== undefined ? a.value : (a.description || a.type))).join(' ');
            (m.params.type === 'error' ? cdp.errors : cdp.console).push(String(txt).slice(0, 300));
        }
        if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            cdp.errors.push('EXCEPTION: ' + (((d.exception && d.exception.description) || d.text) + '').slice(0, 300));
        }
    });

    // ---- 等渲染层就绪 ----
    for (let i = 0; i < 40; i++) {
        try { if (await cdp.evaluate('document.readyState') === 'complete') break; } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 2500)); // 等启动链路（后端就绪/渲染）
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const out = {};

    // ============ 1. 观看统计链：断流重连只补增量、次数不重复（渲染层真实链路） ============
    out.watchChain = await cdp.evaluate(`(async () => {
        const before = ((await window.vpc.settingsGet()) || {}).watchStats || { totalSeconds: 0, sessionCount: 0, titles: {}, daily: {} };
        Player._curMeta = { site: 'site-x', vodId: 'vod-x', title: '链式测试片', subtitle: '第 1 集' };
        Player._rememberSession({ ok: true, sessionId: 9001 });
        Player._recordWatch({ sessionId: 9001, pos: 30, duration: 120 });   // 首次断流退出
        await Player._watchWrite;
        Player._adoptSession({ sessionId: 9002 });                          // 主进程重连 → 新会话并入旧链
        const meta2 = Player._watchSessions.get(9002);
        const chainId = meta2 ? meta2.chainId : null;
        Player._recordWatch({ sessionId: 9002, pos: 60, duration: 120 });   // 重连后播到 60s
        await Player._watchWrite;
        const after = ((await window.vpc.settingsGet()) || {}).watchStats;
        return {
            deltaTotalSeconds: after.totalSeconds - before.totalSeconds,    // 应为 60（30 + 增量 30），而非 90
            deltaSessionCount: after.sessionCount - before.sessionCount,    // 应为 1，重连不再 +1
            titleCount: (after.titles || {})['链式测试片'] || 0,             // 应为 1
            chainMax: chainId !== null ? (Player._watchChainMax.get(chainId) || 0) : -1, // 应为 60
        };
    })()`, true);

    // ============ 2. ended 按会话归属 ============
    out.endedSession = await cdp.evaluate(`(() => {
        Player._endedAt = 0; Player._endedSessions.clear();
        Player._session = 7001;
        Player._onEnded({ sessionId: 7001 });
        const curDone = Player._isDone({ sessionId: 7001, pos: null, duration: null });
        // 模拟新集起播后旧会话延迟 ended：不应污染新会话判定
        Player._endedAt = 0; Player._endedSessions.clear();
        Player._session = 7002;
        Player._onEnded({ sessionId: 7001 });
        const newDone = Player._isDone({ sessionId: 7002, pos: null, duration: null });
        Player._onEnded({ sessionId: 7002 });
        const newDone2 = Player._isDone({ sessionId: 7002, pos: null, duration: null });
        return { curDone, newDone, newDone2 };
    })()`);

    // ============ 3. 「我的」页两标签切换（观看统计/我的收藏） ============
    await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="my"]'); if (el) el.click(); return !!el; })()`);
    await sleep(800);
    out.tabs = {};
    for (const tab of ['stats', 'favorites']) {
        await cdp.evaluate(`(() => { const el = document.querySelector('#view-my [data-my-tab="${tab}"]'); if (el) el.click(); return !!el; })()`);
        await sleep(600);
        out.tabs[tab] = await cdp.evaluate(`(() => {
            const active = document.querySelector('#view-my [data-my-tab].active');
            return {
                activeTab: active ? active.getAttribute('data-my-tab') : null,
                myViewActive: !!document.querySelector('#view-my.active'),
                statsVisible: document.querySelector('#my-panel-stats').offsetParent !== null,
                favVisible: document.querySelector('#my-panel-favorites').offsetParent !== null,
            };
        })()`);
    }

    // ============ 4. 收藏面板：渲染/搜索/标签/多选删除 ============
    await cdp.evaluate(`(() => { document.querySelector('#view-my [data-my-tab="favorites"]').click(); return true; })()`);
    await sleep(700);
    out.fav = await cdp.evaluate(`(() => {
        const cards = [...document.querySelectorAll('#my-favorites-grid .vod-card')];
        return {
            cardCount: cards.length,                                    // 种子 3 条
            names: cards.map(c => c.querySelector('.vod-name') ? c.querySelector('.vod-name').textContent.trim() : ''),
            hasDelBtn: cards.every(c => c.querySelector('.rec-del')),
            hasCheck: cards.every(c => c.querySelector('.rec-check')),
            tagBtns: ['my-favorites-tagwant', 'my-favorites-tagseen', 'my-favorites-delchecked', 'my-favorites-multidel'].map(id => !!document.getElementById(id)),
        };
    })()`);
    // 搜索过滤
    await cdp.evaluate(`(() => { const el = document.getElementById('my-favorites-search'); el.value = '收藏片 A'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(500);
    out.fav.searchCount = await cdp.evaluate(`document.querySelectorAll('#my-favorites-grid .vod-card').length`); // 应为 1
    await cdp.evaluate(`(() => { const el = document.getElementById('my-favorites-search'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(500);
    // 标签筛选（已看）
    await cdp.evaluate(`(() => { const el = document.querySelector('#my-favorites-tags [data-tag="seen"]'); if (el) el.click(); return !!el; })()`);
    await sleep(500);
    out.fav.seenCount = await cdp.evaluate(`document.querySelectorAll('#my-favorites-grid .vod-card').length`); // 应为 1
    await cdp.evaluate(`(() => { const el = document.querySelector('#my-favorites-tags [data-tag=""]'); if (el) el.click(); return !!el; })()`);
    await sleep(500);
    // 多选删除流程（勾选第 1 张 → 删除勾选 → 确认）
    await cdp.evaluate(`(() => { document.getElementById('my-favorites-multidel').click(); return true; })()`);
    await sleep(300);
    out.fav.selecting = await cdp.evaluate(`document.querySelector('#my-favorites-grid').classList.contains('selecting')`);
    await cdp.evaluate(`(() => { const chk = document.querySelector('#my-favorites-grid .rec-check'); if (chk) chk.click(); return !!chk; })()`);
    await sleep(300);
    await cdp.evaluate(`(() => { document.getElementById('my-favorites-delchecked').click(); return true; })()`);
    await sleep(600);
    out.fav.confirmShown = await cdp.evaluate(`(() => { const d = document.getElementById('confirmDialog'); if (!d) return false; const cs = getComputedStyle(d); return cs.display !== 'none' && !d.classList.contains('dlg-out'); })()`);
    await cdp.evaluate(`(() => { const ok = document.getElementById('confirm_ok'); if (ok) ok.click(); return !!ok; })()`);
    await sleep(900);
    out.fav.afterDelete = await cdp.evaluate(`(() => ({
        cardCount: document.querySelectorAll('#my-favorites-grid .vod-card').length,   // 应为 2
        storedCount: 0, // 下一行异步补
    }))()`);
    out.fav.storedCount = await cdp.evaluate(`(async () => { const s = (await window.vpc.settingsGet()) || {}; return (s.favorites || []).length; })()`, true); // 应为 2

    // ============ 5. 观看统计面板数值（链式测试已写入 60s / 1 次 / 1 部） ============
    await cdp.evaluate(`(() => { document.querySelector('#view-my [data-my-tab="stats"]').click(); return true; })()`);
    await sleep(700);
    out.stats = await cdp.evaluate(`(() => ({
        hours: (document.getElementById('my-stat-hours') || {}).textContent || '',
        sessions: (document.getElementById('my-stat-sessions') || {}).textContent || '',
        titles: (document.getElementById('my-stat-titles') || {}).textContent || '',
        dailyBars: document.querySelectorAll('#my-stats-daily .my-bar-col').length,   // 应为 7
    }))()`);

    // ============ 7. 旧收藏路由重定向 ============
    out.redirect = await cdp.evaluate(`(() => {
        App.showView('favorites');
        return {
            currentView: App.currentView,                              // 应为 'my'
            myActive: !!document.querySelector('#view-my.active'),
            favTabActive: !!(document.querySelector('#view-my [data-my-tab="favorites"].active')),
            favPanelVisible: document.querySelector('#my-panel-favorites').offsetParent !== null,
        };
    })()`);
    await sleep(500);

    // ============ 8. 控制台错误 ============
    await sleep(500);
    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length, warnings: cdp.console.slice(0, 10), warningCount: cdp.console.length };

    console.log('\n===== 「我的」页与观看统计验收原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const relatedErr = out.console.errors.filter((e) => /my\.js|records\.js|player\.js|app\.js|detail\.js|kazumi\.js/.test(e));
    const checks = {
        '观看链去重：重连后总时长 30+增量30=60（非 90）': out.watchChain.deltaTotalSeconds === 60,
        '观看链去重：观看次数不重复（只 +1）': out.watchChain.deltaSessionCount === 1,
        '观看链去重：标题计数不重复（=1）': out.watchChain.titleCount === 1,
        '观看链去重：链内最大进度为 60': out.watchChain.chainMax === 60,
        'ended 会话归属：当前会话 ended 判看完': out.endedSession.curDone === true,
        'ended 会话归属：旧会话 ended 不误判新会话': out.endedSession.newDone === false,
        'ended 会话归属：新会话自身 ended 判看完': out.endedSession.newDone2 === true,
        '我的页激活且两标签 active 状态正确': out.tabs.stats.activeTab === 'stats' && out.tabs.favorites.activeTab === 'favorites',
        '标签切换面板显隐正确（stats）': out.tabs.stats.statsVisible && !out.tabs.stats.favVisible,
        '标签切换面板显隐正确（favorites）': out.tabs.favorites.favVisible && !out.tabs.favorites.statsVisible,
        '收藏面板渲染 3 张卡片且带删除/勾选控件': out.fav.cardCount === 3 && out.fav.hasDelBtn && out.fav.hasCheck,
        '收藏面板工具按钮齐全（标记/删除/多选）': out.fav.tagBtns.every(Boolean),
        '收藏搜索过滤生效（剩 1 条）': out.fav.searchCount === 1,
        '收藏标签筛选生效（已看 1 条）': out.fav.seenCount === 1,
        '多选模式进入（selecting）': out.fav.selecting === true,
        '多选删除弹出确认框': out.fav.confirmShown === true,
        '确认删除后卡片剩 2 张': out.fav.afterDelete.cardCount === 2,
        '确认删除后 settings.favorites 剩 2 条': out.fav.storedCount === 2,
        '观看统计数值正确（1 分钟 / 1 次 / 1 部 / 7 天柱）': out.stats.hours.includes('1 分钟') && out.stats.sessions === '1' && out.stats.titles === '1' && out.stats.dailyBars === 7,
        '旧收藏路由重定向到「我的 → 我的收藏」': out.redirect.currentView === 'my' && out.redirect.myActive && out.redirect.favTabActive && out.redirect.favPanelVisible,
        '无本轮相关文件控制台错误': relatedErr.length === 0,
    };
    console.log('\n===== 判定 =====');
    let allPass = true;
    for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS' : 'FAIL') + '  ' + k); if (!v) allPass = false; }
    if (out.console.errors.length) console.log('\n--- 全部控制台错误（含无关项） ---\n' + out.console.errors.join('\n'));
    console.log('\nOVERALL: ' + (allPass ? 'PASS' : 'FAIL'));
    if (!allPass) console.log('\n--- 应用日志尾部 ---\n' + appLog.slice(-1500));
    cleanup(allPass ? 0 : 1);
})().catch((e) => { console.error('验收脚本异常:', e); process.exit(2); });
