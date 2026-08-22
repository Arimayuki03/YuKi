'use strict';
/* 诊断（临时）：真实配置 + CDP，确认每页影片数量 >20 不生效的环节。
 * 设 pageSizeHome=36：①首页 _homeList 自适应填充能否到 36 ②分类页(动作片) _catItems 能否到 36 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9356);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-diag-ps-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'yuki', 'settings.json');
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        s.wallpaper = ''; s.onboarded = true; s.bangumiToken = '';
        s.pageSizeHome = 36; s.pageSizeSearch = 36;
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
    // 首页填充：等 _homeList 达到目标 36（量子首个分类稀疏，需跨分类推进，给足时间）
    for (let i = 0; i < 60; i++) {
        const len = await cdp.evaluate(`Home._homeList.length`);
        if (len >= 36) break;
        await sleep(500);
    }
    await sleep(1200); // 让填充收尾
    out.adaptiveTarget = await cdp.evaluate(`Home._adaptiveTarget().then(v => v)`, true);
    out.homeListLen = await cdp.evaluate(`Home._homeList.length`);
    out.homeCards = await cdp.evaluate(`document.querySelectorAll('#home-grid .vod-card').length`);
    out.fillTid = await cdp.evaluate(`Home._fillTid`);
    out.fillPg = await cdp.evaluate(`Home._fillPg`);

    // 分类页：动作片(tid 6)
    await cdp.evaluate(`Home.loadCategory('6', 1); true`);
    for (let i = 0; i < 40; i++) {
        const len = await cdp.evaluate(`Home._catItems.length`);
        if (len > 0) break;
        await sleep(300);
    }
    await sleep(500);
    out.catItemsLen = await cdp.evaluate(`Home._catItems.length`);
    out.catCards = await cdp.evaluate(`document.querySelectorAll('#home-grid .vod-card').length`);
    out.catPagecount = await cdp.evaluate(`Home.pagecount`);
    out.catPage1Ids = await cdp.evaluate(`Home._catItems.slice(0,3).map(v => v.vod_id)`);

    // 翻到第 2 页，验证合并窗口继续且内容不同（等 _catItems 首 3 个 id 变化才算加载完）
    await cdp.evaluate(`Home.loadCategory('6', 2); true`);
    let diff = false;
    for (let i = 0; i < 40; i++) {
        const ids = await cdp.evaluate(`Home._catItems.slice(0,3).map(v => v.vod_id)`);
        if (JSON.stringify(ids) !== JSON.stringify(out.catPage1Ids)) { diff = true; break; }
        await sleep(300);
    }
    await sleep(500);
    out.catPage2Len = await cdp.evaluate(`Home._catItems.length`);
    out.catPage2Ids = await cdp.evaluate(`Home._catItems.slice(0,3).map(v => v.vod_id)`);
    out.pagesDiffer = diff;
    out.catWinState = await cdp.evaluate(`(() => { const w = Home._catWin.get('量子资源|6'); return w ? { sourcePg: w.sourcePg, items: w.items.length } : null; })()`);

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== 每页影片数量(36) 生效诊断 =====');
    console.log(JSON.stringify(out, null, 2));
    console.log('\n===== 判定线索 =====');
    console.log('pageSizeOf(首页) =', out.adaptiveTarget, '(期望 36)');
    console.log('首页填充: _homeList.length =', out.homeListLen, ', 卡片 =', out.homeCards, '(期望 36)');
    console.log('首页填充分类: _fillTid =', out.fillTid, ', _fillPg =', out.fillPg);
    console.log('分类页(动作片): _catItems.length =', out.catItemsLen, ', 卡片 =', out.catCards, ', pagecount =', out.catPagecount);
    cleanup(0);
})().catch((e) => { console.error('diag 异常:', e); process.exit(2); });
