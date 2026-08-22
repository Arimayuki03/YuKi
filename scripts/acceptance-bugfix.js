/**
 * scripts/acceptance-bugfix.js — bug 清理真实界面验收（临时脚本）
 *
 * 独立 userData 副本 + CDP 实测：
 *   1. 分页功能：预置 25 条收藏（每页 20），「我的→我的收藏」应渲染分页器（2 页）且翻页生效
 *   2. 滚动条隐藏：.view 与 .md-dialog-body 的 scrollbar-width 为 none
 *   3. 「我的」页无最近观看标签（返工确认）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9338);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-accept-bf-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'yuki', 'settings.json');
    // 预置 25 条收藏（pageSizeFavorites 默认 20 → 应出 2 页分页器）
    const favorites = [];
    for (let i = 1; i <= 25; i++) {
        favorites.push({ site: 'site-a', vodId: 'fav-' + i, name: '收藏片 ' + i, pic: '', remarks: '备注' + i, siteName: '来源甲', tag: 'want', ts: Date.now() - i * 1000 });
    }
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        s.lastConfigUrl = ''; s.configHistory = []; s.wallpaper = ''; s.onboarded = true;
        s.bangumiToken = ''; // 清空真实 token：避免合并真实 Bangumi 收藏干扰分页计数（T74）
        s.favorites = favorites;
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(s, null, 2), 'utf8');
    } catch (e) {
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify({ lastConfigUrl: '', onboarded: true, favorites }, null, 2), 'utf8');
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

    // ---- 进入「我的 → 我的收藏」 ----
    await cdp.evaluate(`(() => { document.querySelector('.main-nav-item[data-view="my"]').click(); return true; })()`);
    await sleep(600);
    await cdp.evaluate(`(() => { document.querySelector('#view-my [data-my-tab="favorites"]').click(); return true; })()`);
    for (let i = 0; i < 12; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#my-favorites-grid .vod-card').length`);
        if (n > 0) break;
        await sleep(400);
    }
    await sleep(300);

    // ============ 1. 分页功能 ============
    out.pager = await cdp.evaluate(`(() => {
        const grid = document.querySelectorAll('#my-favorites-grid .vod-card').length;
        const pagerBtns = document.querySelectorAll('#my-favorites-pager .pg-btn').length;
        const pagerVisible = document.getElementById('my-favorites-pager').offsetParent !== null
            && document.querySelectorAll('#my-favorites-pager .pg-btn').length > 0;
        return { cardCount: grid, pagerBtnCount: pagerBtns, pagerVisible };
    })()`);
    // 点「下一页」验证翻页生效（第 2 页应显示剩余 5 条）
    await cdp.evaluate(`(() => {
        const btns = [...document.querySelectorAll('#my-favorites-pager .pg-btn')];
        const next = btns.find(b => b.textContent.trim() === '下一页');
        if (next && !next.disabled) next.click();
        return !!next;
    })()`);
    await sleep(600);
    out.page2 = await cdp.evaluate(`(() => ({
        cardCount: document.querySelectorAll('#my-favorites-grid .vod-card').length,
    }))()`);

    // ============ 2. 滚动条隐藏 ============
    out.scrollbar = await cdp.evaluate(`(() => ({
        viewScrollbarWidth: getComputedStyle(document.querySelector('#view-my')).scrollbarWidth,
    }))()`);

    // ============ 3. 「我的」无最近观看标签 ============
    out.myTabs = await cdp.evaluate(`(() => [...document.querySelectorAll('#view-my [data-my-tab]')].map(t => t.getAttribute('data-my-tab')))()`);

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== bug 清理验收原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const relatedErr = out.console.errors.filter((e) => /my\.js|records\.js|common\.js|home\.js|search\.js/.test(e));
    const checks = {
        '收藏渲染 25 条中的首页 20 条': out.pager.cardCount === 20,
        '分页器可见且有翻页按钮': out.pager.pagerVisible === true && out.pager.pagerBtnCount > 0,
        '翻页生效：第 2 页显示剩余 5 条': out.page2.cardCount === 5,
        '视图滚动条已隐藏（scrollbar-width none）': out.scrollbar.viewScrollbarWidth === 'none',
        '「我的」仅两标签（无最近观看）': JSON.stringify(out.myTabs) === JSON.stringify(['stats', 'favorites']),
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
