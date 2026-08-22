/**
 * scripts/acceptance-detail-card.js — 统一详情页验收（临时脚本）
 *
 * 独立 userData 副本 + CDP 实测：进入推荐页 → 点击卡片 → 统一详情页（T74，#view-detail）
 * 验证自适应头部字段：标题/封面/元信息/Bangumi 收藏同步按钮组/开始观看/页签栏/概览内容。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9340);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-accept-dc-'));
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

    // ---- 进推荐页，等卡片，点第一张进统一详情页 ----
    await cdp.evaluate(`(() => { document.querySelector('.main-nav-item[data-view="popular"]').click(); return true; })()`);
    for (let i = 0; i < 30; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#popular-grid .bangumi-card').length`);
        if (n > 0) break;
        await sleep(500);
    }
    await cdp.evaluate(`(() => { const c = document.querySelector('#popular-grid .bangumi-card'); if (c) c.click(); return !!c; })()`);
    for (let i = 0; i < 24; i++) {
        const ok = await cdp.evaluate(`!!document.querySelector('#view-detail.active #detail-body .detail-title')`);
        if (ok) break;
        await sleep(500);
    }
    await sleep(300);

    // ---- 统一详情页字段核查（T74） ----
    out.card = await cdp.evaluate(`(() => {
        const body = document.querySelector('#view-detail.active #detail-body');
        if (!body) return { exists: false };
        return {
            exists: true,
            hasTitle: !!body.querySelector('.detail-title'),
            hasCover: !!body.querySelector('.detail-cover img'),
            hasMeta: !!body.querySelector('.detail-meta'),
            hasColBtns: !!body.querySelector('.kazumi-col-btns'),
            hasStartBtn: !!body.querySelector('#detail-kazumi-start'),
            hasTabs: body.querySelectorAll('.detail-tab').length >= 3,
            hasOverview: !!body.querySelector('#detail-tab-content'),
        };
    })()`);

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== 统一详情页验收原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const relatedErr = out.console.errors.filter((e) => /kazumi\.js|common\.js|popular\.js|detail\.js/.test(e));
    const c = out.card || {};
    const checks = {
        '统一详情页渲染': c.exists === true,
        '含标题与封面': c.hasTitle === true && c.hasCover === true,
        '含元信息（日期/评分）': c.hasMeta === true,
        '含 Bangumi 收藏同步按钮组': c.hasColBtns === true,
        '含「开始观看」（Kazumi 源）': c.hasStartBtn === true,
        '含页签栏': c.hasTabs === true,
        '概览内容区渲染': c.hasOverview === true,
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
