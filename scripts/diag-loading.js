/**
 * scripts/diag-loading.js — 诊断「界面卡在载入中」：起隔离实例，观察启动后
 * 渲染层状态（全局 loading 浮层是否可见、当前视图、Home 初始化），并驱动
 * 「搜索 → 进详情」复现卡住的步骤，采集控制台错误。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.VPC_CDP_PORT || 9345);

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
            if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); }
            else if (m.method) { for (const h of this.handlers) { try { h(m); } catch (e) { } } }
        };
    }
    on(fn) { this.handlers.push(fn); }
    send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
    async evaluate(expression, awaitPromise = false) {
        const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        if (r.exceptionDetails) throw new Error('eval exception: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
        return r.result ? r.result.value : undefined;
    }
}

(async () => {
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-diag-'));
    const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-diag-cache-'));
    const src = path.join(process.env.APPDATA || '', 'video-pc', 'settings.json');
    try { const s = JSON.parse(fs.readFileSync(src, 'utf8')); s.onboarded = true; s.wallpaper = ''; fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(s, null, 2), 'utf8'); } catch (e) { fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify({ onboarded: true }, null, 2), 'utf8'); }

    const child = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + PORT, '--user-data-dir=' + tmpUserData, '--no-first-run'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VPC_CACHE_DIR: tmpCache } });
    let appLog = '';
    child.stdout.on('data', (d) => { appLog += d.toString(); });
    child.stderr.on('data', (d) => { appLog += d.toString(); });
    const cleanup = (code) => { try { child.kill('SIGKILL'); } catch (e) { } setTimeout(() => { try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (e) { } try { fs.rmSync(tmpCache, { recursive: true, force: true }); } catch (e) { } process.exit(code); }, 800); };
    process.on('SIGINT', () => cleanup(130));

    let version = null;
    for (let i = 0; i < 60; i++) { try { version = await getJson('/json/version'); if (version) break; } catch (e) { } await new Promise((r) => setTimeout(r, 500)); }
    if (!version) { console.error('CDP 端口未就绪\n' + appLog.slice(-1500)); cleanup(2); }
    let page = null;
    for (let i = 0; i < 30; i++) { try { const t = await getJson('/json/list'); page = t.find((x) => x.type === 'page' && /index\.html/.test(x.url || '')) || t.find((x) => x.type === 'page'); if (page) break; } catch (e) { } await new Promise((r) => setTimeout(r, 500)); }
    if (!page) { console.error('找不到渲染页\n' + appLog.slice(-1500)); cleanup(2); }
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    cdp.on((m) => {
        if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) { const t = (m.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' '); cdp.errors.push(String(t).slice(0, 300)); }
        if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; cdp.errors.push('EXCEPTION: ' + (((d.exception && d.exception.description) || d.text) + '').slice(0, 300)); }
    });
    for (let i = 0; i < 40; i++) { try { if (await cdp.evaluate('document.readyState') === 'complete') break; } catch (e) { } await new Promise((r) => setTimeout(r, 500)); }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const out = {};
    // 启动后 5s 与 15s 两次采样：loading 浮层是否可见、当前视图、Home 状态
    await sleep(6000);
    out.t6 = await cdp.evaluate(`(() => ({
        loadingVisible: document.getElementById('loadingToast') ? getComputedStyle(document.getElementById('loadingToast')).display !== 'none' : null,
        currentView: (typeof App !== 'undefined') ? App.currentView : '?',
        homeActive: !!document.querySelector('#view-home.active'),
        homeInited: (typeof Home !== 'undefined') ? Home._inited : '?',
        site: (typeof Home !== 'undefined') ? Home.site : '?',
        siteCount: document.querySelectorAll('#site-select option').length,
    }))()`);
    await sleep(10000);
    out.t16 = await cdp.evaluate(`(() => ({
        loadingVisible: document.getElementById('loadingToast') ? getComputedStyle(document.getElementById('loadingToast')).display !== 'none' : null,
        currentView: (typeof App !== 'undefined') ? App.currentView : '?',
        homeActive: !!document.querySelector('#view-home.active'),
        homeGridCards: document.querySelectorAll('#home-grid .vod-card').length,
    }))()`);

    // 驱动：搜索 → 进详情 → 观察详情 body 与 loading 状态
    try {
        out.search = await cdp.evaluate(`(async () => {
            const sNav = document.querySelector('.main-nav-item[data-view="search"]');
            if (sNav) sNav.click();
            await new Promise(r => setTimeout(r, 300));
            const kw = document.getElementById('search-keyword');
            kw.value = '海贼王'; kw.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('search-go').click();
            for (let i = 0; i < 24; i++) { if (document.querySelectorAll('#search-results .vod-card').length) break; await new Promise(r => setTimeout(r, 500)); }
            const cards = document.querySelectorAll('#search-results .vod-card');
            const first = cards[0];
            if (!first) return { step: 'no-search-results', cardCount: cards.length, loading: getComputedStyle(document.getElementById('loadingToast')).display !== 'none' };
            first.click();
            for (let i = 0; i < 30; i++) { if (document.querySelector('#detail-body .detail-title') || document.querySelector('#detail-body .tip-line')) break; await new Promise(r => setTimeout(r, 500)); }
            return {
                step: 'detail',
                detailActive: !!document.querySelector('#view-detail.active'),
                loading: getComputedStyle(document.getElementById('loadingToast')).display !== 'none',
                detailText: (document.querySelector('#detail-body') || {}).innerText ? document.querySelector('#detail-body').innerText.slice(0, 120) : '',
                detailBody: (document.querySelector('#detail-body') || {}).innerHTML ? document.querySelector('#detail-body').innerHTML.slice(0, 200) : '',
            };
        })()`, true);
    } catch (e) { out.search = { error: String(e).slice(0, 300) }; }
    await sleep(500);
    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };

    console.log('\n===== 诊断结果 =====');
    console.log(JSON.stringify(out, null, 2));
    cleanup(0);
})().catch((e) => { console.error('诊断脚本异常:', e); process.exit(2); });
