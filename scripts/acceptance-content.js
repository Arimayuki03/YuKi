/**
 * scripts/acceptance-content.js — 内容类页面功能验收（临时脚本）
 *
 * 独立 userData 副本（预置 history/watchStats/favorites）+ CDP 实测：
 *   1. 首页：站点下拉、视图激活
 *   2. 搜索页：输入框/按钮结构
 *   3. 历史页：种子数据卡片渲染、分页
 *   4. 「我的」页：观看统计数值、收藏卡片
 *   5. 控制台错误采集
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.VPC_CDP_PORT || 9341);

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
    constructor(url) { this.url = url; this.id = 0; this.pend = new Map(); this.handlers = []; this.errors = []; }
    async connect() {
        this.ws = new WebSocket(this.url);
        await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws connect failed')); });
        this.ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.id && this.pend.has(m.id)) {
                const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id);
                if (m.error) rej(new Error(m.error.message)); else res(m.result);
            } else if (m.method) { for (const h of this.handlers) { try { h(m); } catch (e) { } } }
        };
    }
    on(fn) { this.handlers.push(fn); }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
    }
    async evaluate(expression, awaitPromise = false) {
        const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        if (r.exceptionDetails) throw new Error('eval exception: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
        return r.result ? r.result.value : undefined;
    }
}

(async () => {
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-accept-ct-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'video-pc', 'settings.json');
    // 预置历史（25 条测分页）+ 观看统计 + 收藏
    const history = [];
    for (let i = 1; i <= 25; i++) history.push({ site: 'site-a', siteName: '源甲', vodId: 'h-' + i, name: '历史片 ' + i, pic: '', remarks: '第' + i + '集', ts: Date.now() - i * 1000 });
    const seed = {
        lastConfigUrl: '', configHistory: [], wallpaper: '', onboarded: true,
        bangumiToken: '', // 清空真实 token：避免「我的→收藏」合并真实 Bangumi 收藏干扰计数（T74）
        history,
        watchStats: { totalSeconds: 3725, sessionCount: 3, titles: { '测试番 A': 2, '测试番 B': 1 }, daily: {} },
        favorites: [
            { site: 'site-a', vodId: 'f-1', name: '收藏片 1', pic: '', remarks: '全12集', siteName: '源甲', tag: 'want', ts: Date.now() },
            { site: 'site-b', vodId: 'f-2', name: '收藏片 2', pic: '', remarks: '更新中', siteName: '源乙', tag: 'seen', ts: Date.now() - 1000 },
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

    let version = null;
    for (let i = 0; i < 60; i++) {
        try { version = await getJson('/json/version'); if (version) break; } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!version) { console.error('CDP 端口未就绪\n' + appLog.slice(-2000)); cleanup(2); }

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
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            const txt = (m.params.args || []).map((a) => (a.value !== undefined ? a.value : (a.description || a.type))).join(' ');
            cdp.errors.push(String(txt).slice(0, 300));
        }
        if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            cdp.errors.push('EXCEPTION: ' + (((d.exception && d.exception.description) || d.text) + '').slice(0, 300));
        }
    });

    for (let i = 0; i < 40; i++) {
        try { if (await cdp.evaluate('document.readyState') === 'complete') break; } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 2500));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const nav = async (view) => { await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="${view}"]'); if (el) el.click(); return !!el; })()`); await sleep(700); };

    // ============ 1. 首页 ============
    out.home = await cdp.evaluate(`(() => ({
        viewActive: !!document.querySelector('#view-home.active'),
        siteOptions: document.querySelectorAll('#site-select option').length,
        classTabsExist: !!document.getElementById('home-class'),
        gridExist: !!document.getElementById('home-grid'),
    }))()`);

    // ============ 2. 搜索页 ============
    await nav('search');
    out.search = await cdp.evaluate(`(() => ({
        viewActive: !!document.querySelector('#view-search.active'),
        inputExists: !!document.getElementById('search-keyword'),
        btnExists: !!document.getElementById('search-go'),
        resultsExist: !!document.getElementById('search-results'),
    }))()`);

    // ============ 3. 历史页 ============
    await nav('history');
    for (let i = 0; i < 10; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#view-history-grid .vod-card').length`);
        if (n > 0) break;
        await sleep(400);
    }
    out.history = await cdp.evaluate(`(() => ({
        viewActive: !!document.querySelector('#view-history.active'),
        cardCount: document.querySelectorAll('#view-history-grid .vod-card').length,
        pagerVisible: document.querySelectorAll('#view-history-pager .pg-btn').length > 0,
    }))()`);

    // ============ 4. 我的页 ============
    await nav('my');
    await sleep(500);
    out.myStats = await cdp.evaluate(`(() => ({
        viewActive: !!document.querySelector('#view-my.active'),
        hours: (document.getElementById('my-stat-hours') || {}).textContent || '',
        sessions: (document.getElementById('my-stat-sessions') || {}).textContent || '',
        titles: (document.getElementById('my-stat-titles') || {}).textContent || '',
        dailyBars: document.querySelectorAll('#my-stats-daily .my-bar-col').length,
    }))()`);
    await cdp.evaluate(`(() => { document.querySelector('#view-my [data-my-tab="favorites"]').click(); return true; })()`);
    for (let i = 0; i < 10; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#my-favorites-grid .vod-card').length`);
        if (n > 0) break;
        await sleep(400);
    }
    out.myFav = await cdp.evaluate(`(() => ({
        cardCount: document.querySelectorAll('#my-favorites-grid .vod-card').length,
    }))()`);

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== 内容页验收原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const relatedErr = out.console.errors.filter((e) => /home\.js|search\.js|records\.js|my\.js|app\.js/.test(e));
    const checks = {
        '首页激活且站点下拉有选项': out.home.viewActive === true && out.home.siteOptions >= 1,
        '首页分类/网格容器存在': out.home.classTabsExist === true && out.home.gridExist === true,
        '搜索页激活且输入框/按钮/结果区存在': out.search.viewActive === true && out.search.inputExists === true && out.search.btnExists === true && out.search.resultsExist === true,
        '历史页渲染 25 条种子中的首页 20 条': out.history.cardCount === 20,
        '历史页分页器可见': out.history.pagerVisible === true,
        '我的页统计：1 小时 2 分 / 3 次 / 2 部': out.myStats.hours.includes('1 小时 2 分') && out.myStats.sessions === '3' && out.myStats.titles === '2',
        '我的页近 7 天柱状图 7 柱': out.myStats.dailyBars === 7,
        '我的页收藏卡片渲染 2 条': out.myFav.cardCount === 2,
        '无本轮相关文件控制台错误': relatedErr.length === 0,
    };
    console.log('\n===== 判定 =====');
    let allPass = true;
    for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS' : 'FAIL') + '  ' + k); if (!v) allPass = false; }
    if (out.console.errors.length) console.log('\n--- 全部控制台错误 ---\n' + out.console.errors.join('\n'));
    console.log('\nOVERALL: ' + (allPass ? 'PASS' : 'FAIL'));
    if (!allPass) console.log('\n--- 应用日志尾部 ---\n' + appLog.slice(-1500));
    cleanup(allPass ? 0 : 1);
})().catch((e) => { console.error('验收脚本异常:', e); process.exit(2); });
