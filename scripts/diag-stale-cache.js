'use strict';
/* 诊断（临时）：真实配置 + CDP，复现「修改后回到页面不立即生效、需手动刷新」。
 * ①打开分类(动作片)缓存页面 ②模拟修改（换每页条数 / 重新载入配置） ③再开分类看是否用旧缓存 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.VPC_CDP_PORT || 9358);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-diag-stale-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'video-pc', 'settings.json');
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        s.wallpaper = ''; s.onboarded = true; s.bangumiToken = '';
        s.pageSizeHome = 20;
        delete s.listPageSize;
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

    for (let i = 0; i < 90; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#site-select option').length`);
        if (n > 20) break;
        await sleep(1000);
    }
    await sleep(3000);
    const out = {};

    await cdp.evaluate(`$('#site-select').val('量子资源').trigger('change'); true`);
    for (let i = 0; i < 60; i++) {
        const has = await cdp.evaluate(`[...document.querySelectorAll('#home-class .class-tab')].some(t => t.textContent.trim() === '电影片')`);
        if (has) break;
        await sleep(500);
    }
    await sleep(1500);

    // 打开 动作片(tid 6)，pageSize=20 → 应 20 条
    await cdp.evaluate(`Home.loadCategory('6', 1); true`);
    for (let i = 0; i < 30; i++) {
        const n = await cdp.evaluate(`Home._catItems.length`);
        if (n > 0) break;
        await sleep(300);
    }
    out.before = await cdp.evaluate(`(() => ({
        size: Home._pageSize() , catItems: Home._catItems.length,
        pageCacheSize: Home._pageCache ? Home._pageCache.size : 0,
        winSize: Home._catWin.size,
    }))()`);
    out.before.catItems = await cdp.evaluate(`Home._catItems.length`);
    out.before.pageSize = await cdp.evaluate(`pageSizeOf('pageSizeHome').then(v => v)`, true);

    // ===== 场景A：修改每页条数 20→36 =====
    await cdp.evaluate(`window.vpc.settingsSet('pageSizeHome', 36).then(() => invalidatePageSizeCache())`, true);
    // 立即再开分类（缓存应已失效 → 36 条；否则先用旧缓存 20 条）
    await cdp.evaluate(`Home.loadCategory('6', 1); true`);
    const t0 = Date.now();
    let firstCatItems = -1;
    for (let i = 0; i < 20; i++) {
        firstCatItems = await cdp.evaluate(`Home._catItems.length`);
        if (firstCatItems > 0) break;
        await sleep(100);
    }
    out.afterSizeChange_firstRead = { ms: Date.now() - t0, catItems: firstCatItems };
    await sleep(1500); // 等 _refreshCatPage 后台刷新
    out.afterSizeChange_final = await cdp.evaluate(`Home._catItems.length`);

    // ===== 场景B：重新载入配置（loadSites）后，缓存是否作废 =====
    await cdp.evaluate(`Home.loadCategory('7', 1); true`); // 喜剧片，建缓存
    await sleep(1200);
    out.cacheBeforeReload = await cdp.evaluate(`(() => ({ pageCache: Home._pageCache ? Home._pageCache.size : 0, catWin: Home._catWin.size }))()`);
    await cdp.evaluate(`Home.loadSites(); true`); // 模拟配置重载
    await sleep(2500);
    out.cacheAfterReload = await cdp.evaluate(`(() => ({ pageCache: Home._pageCache ? Home._pageCache.size : 0, catWin: Home._catWin.size }))()`);

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== 缓存失效诊断 =====');
    console.log(JSON.stringify(out, null, 2));
    console.log('\n===== 判定线索 =====');
    console.log('场景A：改每页条数 20→36 后首读分类条数 =', out.afterSizeChange_firstRead.catItems, '(应 36；若 20=旧缓存未失效)');
    console.log('场景A：后台刷新后 =', out.afterSizeChange_final);
    console.log('场景B：配置重载前 pageCache/catWin =', JSON.stringify(out.cacheBeforeReload));
    console.log('场景B：配置重载后 pageCache/catWin =', JSON.stringify(out.cacheAfterReload), '(应 0/0；若非 0=缓存未作废)');
    cleanup(0);
})().catch((e) => { console.error('diag 异常:', e); process.exit(2); });
