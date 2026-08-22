/**
 * scripts/acceptance-popular.js — Kazumi 首页推荐真实界面验收（临时脚本）
 *
 * 独立 userData 副本 + CDP 实测：
 *   1. 「推荐」导航项存在且可进入
 *   2. 推荐网格渲染 Bangumi 趋势卡片（封面/排名角标，依赖网络数据）
 *   3. 点击卡片进入统一详情页（#view-detail，非弹窗，T74）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9339);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-accept-pop-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'yuki', 'settings.json');
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        s.lastConfigUrl = ''; s.configHistory = []; s.wallpaper = ''; s.onboarded = true;
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(s, null, 2), 'utf8');
    } catch (e) {
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify({ lastConfigUrl: '', onboarded: true }, null, 2), 'utf8');
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

    // ============ 1. 推荐导航项存在 ============
    out.nav = await cdp.evaluate(`(() => ({
        popularNavExists: !!document.querySelector('.main-nav-item[data-view="popular"]'),
        popularViewExists: !!document.getElementById('view-popular'),
    }))()`);

    // ---- 进入推荐页并等待卡片（趋势走网络，给足时间） ----
    await cdp.evaluate(`(() => { document.querySelector('.main-nav-item[data-view="popular"]').click(); return true; })()`);
    for (let i = 0; i < 30; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#popular-grid .bangumi-card').length`);
        if (n > 0) break;
        await sleep(500);
    }
    await sleep(400);

    // ============ 2. 推荐网格渲染 ============
    out.grid = await cdp.evaluate(`(() => {
        const cards = [...document.querySelectorAll('#popular-grid .bangumi-card')];
        return {
            cardCount: cards.length,
            viewActive: !!document.querySelector('#view-popular.active'),
            hasRankBadge: cards.some(c => c.querySelector('.bangumi-rank-badge')),
            hasCover: cards.some(c => c.querySelector('.vod-cover img')),
            firstName: cards.length ? (cards[0].querySelector('.vod-name') || {}).textContent.trim() : '',
        };
    })()`);

    // ============ 3. 点击卡片进统一详情页（非弹窗，T74） ============
    let clicked = false;
    if (out.grid.cardCount > 0) {
        clicked = await cdp.evaluate(`(() => { const c = document.querySelector('#popular-grid .bangumi-card'); if (c) c.click(); return !!c; })()`);
        let banner = false;
        for (let i = 0; i < 20; i++) {
            banner = await cdp.evaluate(`!!document.querySelector('#view-detail.active #detail-body .detail-title')`);
            if (banner) break;
            await sleep(500);
        }
        out.detail = await cdp.evaluate(`(() => ({
            clicked: ${clicked},
            detailViewActive: !!document.querySelector('#view-detail.active'),
            popularDeactivated: !document.querySelector('#view-popular.active'),
            hasTitle: !!document.querySelector('#view-detail.active #detail-body .detail-title'),
            hasCover: !!document.querySelector('#view-detail.active #detail-body .detail-cover img'),
            sourceDialogOpen: getComputedStyle(document.getElementById('kazumiSourceDialog')).display !== 'none',
        }))()`);
    } else {
        out.detail = { clicked: false, skipped: '无卡片（网络无数据）' };
    }

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== 推荐页验收原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const relatedErr = out.console.errors.filter((e) => /popular\.js|common\.js|kazumi\.js|app\.js/.test(e));
    const checks = {
        '推荐导航项与视图存在': out.nav.popularNavExists === true && out.nav.popularViewExists === true,
        '进入推荐页后视图激活': out.grid.viewActive === true,
        '推荐网格渲染卡片（依赖网络）': out.grid.cardCount > 0,
        '卡片含排名角标': out.grid.hasRankBadge === true,
        '卡片含封面': out.grid.hasCover === true,
        '点击卡片进入统一详情页（非弹窗）': out.detail.detailViewActive === true && out.detail.popularDeactivated === true && out.detail.hasTitle === true && out.detail.hasCover === true && out.detail.sourceDialogOpen === false,
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
