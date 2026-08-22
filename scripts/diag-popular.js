'use strict';
/* 诊断（临时）：真实配置 + CDP，量化「推荐」页切换卡顿来源。
 * 测：①showView('popular') 同步切换耗时 ②Bangumi trends 网络耗时 ③长任务 ④网格填充耗时 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9354);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-diag-pop-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'yuki', 'settings.json');
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        s.wallpaper = ''; s.onboarded = true; s.bangumiToken = '';
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(s, null, 2), 'utf8');
    } catch (e) { console.error('读取 settings 失败', e.message); process.exit(2); }
    const electronArgs = [ROOT, '--remote-debugging-port=' + PORT, '--user-data-dir=' + tmpUserData, '--no-first-run'];
    console.log('[diag] userData =', tmpUserData);
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
    if (!version) { console.error('CDP 未就绪\n' + appLog.slice(-2000)); cleanup(2); }
    let page = null;
    for (let i = 0; i < 30; i++) {
        try {
            const targets = await getJson('/json/list');
            page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url || '')) || targets.find((t) => t.type === 'page');
            if (page) break;
        } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!page) { console.error('无渲染页\n' + appLog.slice(-2000)); cleanup(2); }
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
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 等站点载入
    for (let i = 0; i < 90; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#site-select option').length`);
        if (n > 20) break;
        await sleep(1000);
    }
    await sleep(4000);

    const out = {};

    // 0. 点开前先看后台预载状态（preload 是否已把数据准备好）
    out.preloadState = await cdp.evaluate(`(() => ({
        items: Popular._items.length,
        tag: Popular._tag,
        inited: Popular._inited,
        cacheRaw: localStorage.getItem('popular_cache') ? 'has' : 'none',
    }))()`);

    // 1. showView 同步切换耗时（首次点击，触发加载）
    await cdp.evaluate(`(() => {
        window.__lt = [];
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); })
            .observe({ type: 'longtask', buffered: false });
        return true;
    })()`);
    const syncMs = await cdp.evaluate(`(() => {
        const t0 = performance.now();
        App.showView('popular');
        return performance.now() - t0;
    })()`);
    out.showViewSyncMs = Math.round(syncMs);

    // 2. 等网格填充（首次网络加载）计时
    const t0grid = await cdp.evaluate(`performance.now()`);
    let gridMs = -1, cards = 0, status = '';
    for (let i = 0; i < 80; i++) {
        cards = await cdp.evaluate(`document.querySelectorAll('#popular-grid .bangumi-card').length`);
        status = await cdp.evaluate(`(document.getElementById('popular-status') || {}).textContent || ''`);
        if (cards > 0 || status) break;
        await sleep(250);
    }
    gridMs = await cdp.evaluate(`performance.now()`) - t0grid;
    out.firstGridMs = Math.round(gridMs);
    out.cards = cards;
    out.status = status;

    // 3. 再次切换（_items 已缓存，应瞬间）对比
    const backMs = await cdp.evaluate(`(() => { App.showView('home'); const t0 = performance.now(); App.showView('popular'); return performance.now() - t0; })()`);
    out.reSwitchSyncMs = Math.round(backMs);

    // 4. 长任务
    await sleep(500);
    out.longTasks = await cdp.evaluate(`window.__lt || []`);
    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };

    // 5. 直接测后端 trends 网络耗时
    const t0b = Date.now();
    try {
        const rsp = await cdp.evaluate(`doAction('kazumiBangumiTrends', { limit: 24, offset: 0 }, '/kazumi/action').then(r => ({ n: (r && r.trends || []).length })).catch(e => ({ err: String(e).slice(0, 60) }))`, true);
        out.backendTrends = { ms: Date.now() - t0b, ...rsp };
    } catch (e) { out.backendTrends = { ms: Date.now() - t0b, err: String(e).slice(0, 60) }; }

    console.log('\n===== 推荐页切换卡顿诊断 =====');
    console.log(JSON.stringify(out, null, 2));
    const relatedErr = out.console.errors.filter((e) => /popular\.js|common\.js|kazumi\.js/.test(e));
    console.log('\n===== 判定线索 =====');
    console.log('首次 showView 同步耗时:', out.showViewSyncMs + 'ms');
    console.log('首次网格填充耗时:', out.firstGridMs + 'ms', '(cards=' + out.cards + ', status=' + out.status + ')');
    console.log('再次切换同步耗时:', out.reSwitchSyncMs + 'ms');
    console.log('长任务(ms):', JSON.stringify(out.longTasks));
    console.log('后端 trends 网络耗时:', out.backendTrends && out.backendTrends.ms + 'ms', out.backendTrends && (out.backendTrends.err || ('n=' + out.backendTrends.n)));
    console.log('home.js/popular 相关控制台错误:', relatedErr.length);
    cleanup(0);
})().catch((e) => { console.error('diag 异常:', e); process.exit(2); });
