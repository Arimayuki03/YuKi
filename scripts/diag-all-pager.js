'use strict';
/* 诊断（临时）：真实配置 + CDP，验证「全部」标签分页（T76）。
 * pageSizeHome=36：①全部第 1 页自适应首页有分页器 ②翻第 2 页显示源总览 feed 36 条且与第 1 页不同 ③第 3 页 ④分页数 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9357);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-diag-allp-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'yuki', 'settings.json');
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        s.wallpaper = ''; s.onboarded = true; s.bangumiToken = '';
        s.pageSizeHome = 36;
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
    // 等「全部」第 1 页的分页器出现（_probeHomeFeedTotal 后台定页数）
    let pg1 = null;
    for (let i = 0; i < 30; i++) {
        pg1 = await cdp.evaluate(`(() => ({
            page: Home.page, pagecount: Home.pagecount, homeList: Home._homeList.length,
            pagerBtns: document.querySelectorAll('#home-pager .pg-btn').length,
            mode: Home.mode,
        }))()`);
        if (pg1.pagerBtns > 0) break;
        await sleep(500);
    }
    out.page1 = pg1;
    out.page1Ids = await cdp.evaluate(`Home._homeList.slice(0,5).map(v => v.vod_id)`);

    // 后端 homeVideoContent 分页确认
    out.backendPg2 = await cdp.evaluate(`doAction('homeVideoContent', { site: '量子资源', pg: '2' }).then(d => ({ n: (d && d.list || []).length, total: d && d.total, pagecount: d && d.pagecount })).catch(e => ({ err: String(e).slice(0,60) }))`, true);

    // 干净地逐页 await _fetchHomeFeed（避免并发竞态）
    out.feedPg2 = await cdp.evaluate(`Home._fetchHomeFeed(2, 36).then(() => (() => { const w = Home._catWin.get('量子资源|__all__'); return { homeList: Home._homeList.length, pagecount: Home.pagecount, win: { sourcePg: w.sourcePg, items: w.items.length, total: w.total } }; })())`, true);
    out.feedPg3 = await cdp.evaluate(`Home._fetchHomeFeed(3, 36).then(() => (() => { const w = Home._catWin.get('量子资源|__all__'); return { homeList: Home._homeList.length, pagecount: Home.pagecount, win: { sourcePg: w.sourcePg, items: w.items.length } }; })())`, true);
    out.pagesDiff = await cdp.evaluate(`(() => {
        const ids1 = Home._catWin.get('量子资源|__all__').items.slice(0, 5).map(v => v.vod_id);
        const ids2 = Home._catWin.get('量子资源|__all__').items.slice(36, 41).map(v => v.vod_id);
        return JSON.stringify(ids1) !== JSON.stringify(ids2);
    })()`);
    out.feedPg2Ids = await cdp.evaluate(`Home._homeList.slice(0,5).map(v => v.vod_id)`);

    // 真实翻页：回到「全部」第 1 页，等分页器出现后点「下一页」按钮
    await cdp.evaluate(`Home.loadHome(1); true`);
    for (let i = 0; i < 30; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#home-pager .pg-btn').length`);
        if (n > 0) break;
        await sleep(400);
    }
    const clicked = await cdp.evaluate(`(() => {
        const btn = [...document.querySelectorAll('#home-pager .pg-btn')].find(b => b.textContent.trim() === '下一页');
        if (btn) { btn.click(); return true; }
        return false;
    })()`);
    let clickResult = null;
    for (let i = 0; i < 40; i++) {
        const p = await cdp.evaluate(`Home.page`);
        const n = await cdp.evaluate(`Home._homeList.length`);
        if (p === 2 && n > 20) { clickResult = { page: p, cards: n }; break; }
        await sleep(300);
    }
    out.realClick = { clicked, ...(clickResult || {}) };
    out.realClickGrid = await cdp.evaluate(`document.querySelectorAll('#home-grid .vod-card').length`);

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== 「全部」标签分页诊断 =====');
    console.log(JSON.stringify(out, null, 2));
    console.log('\n===== 判定线索 =====');
    console.log('第1页: page=' + out.page1.page + ' pagecount=' + out.page1.pagecount + ' 卡片=' + out.page1.homeList + ' 分页按钮=' + out.page1.pagerBtns);
    console.log('后端 homeVideoContent pg=2: ' + JSON.stringify(out.backendPg2));
    console.log('feed第2页: ' + JSON.stringify(out.feedPg2));
    console.log('feed第3页: ' + JSON.stringify(out.feedPg3));
    console.log('feed前5与第36-40条不同: ' + out.pagesDiff);
    console.log('真实点「下一页」: ' + JSON.stringify(out.realClick) + ' 网格卡片=' + out.realClickGrid);
    cleanup(0);
})().catch((e) => { console.error('diag 异常:', e); process.exit(2); });
