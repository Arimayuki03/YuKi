/**
 * scripts/acceptance-rework.js — 返工项真实界面验收（临时脚本）
 *
 * 验收两项返工：
 *   A. 「我的」页移除「最近观看」标签（仅剩 观看统计/我的收藏 两标签，无 recent 面板）
 *   B. 时间表卡片点击进入统一详情页（#view-detail，非弹窗，T74）；返回键回时间表
 * 独立 userData 副本 + CDP；结束 kill 并清理副本。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.VPC_CDP_PORT || 9337);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-accept-rw-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'video-pc', 'settings.json');
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        s.lastConfigUrl = ''; s.configHistory = []; s.wallpaper = ''; s.onboarded = true;
        s.favorites = [
            { site: 'site-a', vodId: 'fav-1', name: '收藏片 A', pic: '', remarks: '全 12 集', siteName: '来源甲', tag: 'want', ts: Date.now() },
            { site: 'site-b', vodId: 'fav-2', name: '收藏片 B', pic: '', remarks: '全 24 集', siteName: '来源乙', tag: 'seen', ts: Date.now() - 1000 },
        ];
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

    // ============ A. 「我的」页两标签（无最近观看） ============
    await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="my"]'); if (el) el.click(); return !!el; })()`);
    await sleep(800);
    out.my = await cdp.evaluate(`(() => {
        const tabs = [...document.querySelectorAll('#view-my [data-my-tab]')].map(t => t.getAttribute('data-my-tab'));
        return {
            tabs,
            tabCount: tabs.length,
            hasRecentTab: tabs.includes('recent'),
            recentPanelExists: !!document.getElementById('my-panel-recent'),
            favPanelExists: !!document.getElementById('my-panel-favorites'),
            statsPanelExists: !!document.getElementById('my-panel-stats'),
        };
    })()`);

    // ============ B. 时间表卡片 → 二级详情页（非弹窗） ============
    await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="timeline"]'); if (el) el.click(); return !!el; })()`);
    for (let i = 0; i < 20; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#timeline-grid .bangumi-card').length`);
        if (n > 0) break;
        await sleep(500);
    }
    // 点击第一张卡片
    await cdp.evaluate(`(() => { const c = document.querySelector('#timeline-grid .bangumi-card'); if (c) c.click(); return !!c; })()`);
    // 等统一详情页渲染（bangumiInfo 走网络）
    let banner = false;
    for (let i = 0; i < 20; i++) {
        banner = await cdp.evaluate(`!!document.querySelector('#view-detail.active #detail-body .detail-title')`);
        if (banner) break;
        await sleep(500);
    }
    out.detailPage = await cdp.evaluate(`(() => ({
        detailViewActive: !!document.querySelector('#view-detail.active'),
        timelineDeactivated: !document.querySelector('#view-timeline.active'),
        hasTitle: !!document.querySelector('#view-detail.active #detail-body .detail-title'),
        hasTabs: document.querySelectorAll('#view-detail.active #detail-body .detail-tab').length >= 3,
        sourceDialogOpen: getComputedStyle(document.getElementById('kazumiSourceDialog')).display !== 'none',
        backBtnExists: !!document.getElementById('detail-back'),
    }))()`);

    // 点返回键回时间表
    await cdp.evaluate(`(() => { const b = document.getElementById('detail-back'); if (b) b.click(); return !!b; })()`);
    await sleep(600);
    out.back = await cdp.evaluate(`(() => ({
        timelineActive: !!document.querySelector('#view-timeline.active'),
        detailDeactivated: !document.querySelector('#view-detail.active'),
    }))()`);

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== 返工验收原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const relatedErr = out.console.errors.filter((e) => /my\.js|timeline\.js|kazumi\.js|app\.js|detail\.js/.test(e));
    const checks = {
        '我的页仅两标签（stats/favorites）': out.my.tabCount === 2 && JSON.stringify(out.my.tabs) === JSON.stringify(['stats', 'favorites']),
        '我的页无最近观看标签': out.my.hasRecentTab === false,
        '我的页无最近观看面板 DOM': out.my.recentPanelExists === false,
        '我的页保留统计与收藏面板': out.my.statsPanelExists && out.my.favPanelExists,
        '时间表卡片点击进入统一详情页（T74）': out.detailPage.detailViewActive === true && out.detailPage.timelineDeactivated === true,
        '统一详情页渲染标题与页签': out.detailPage.hasTitle === true && out.detailPage.hasTabs === true,
        '统一详情页打开时源弹窗未弹出（非弹窗）': out.detailPage.sourceDialogOpen === false,
        '统一详情页有返回按钮': out.detailPage.backBtnExists === true,
        '返回键回到时间表': out.back.timelineActive === true && out.back.detailDeactivated === true,
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
