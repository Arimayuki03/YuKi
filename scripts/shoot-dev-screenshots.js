/**
 * 连接「npm start 开发版」实例截图（用户要求：截真实开发版 + 真实配置数据）。
 *
 * 前提：主进程已带 --remote-debugging-port=9333 启动（由本脚本的启动器负责，
 * 或手动 npm start 时自行附加）。本文件只做 CDP 连接 + 导航 + 截图，
 * 不复制 userData——截的就是开发实例本身。
 *
 * 用法：node scripts/shoot-dev-screenshots.js [--out <dir>] [--port 9333]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(argOf('--port', 9333));
const OUT_DIR = path.resolve(argOf('--out', path.join(ROOT, 'build', 'screenshots-dev')));

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
    constructor(url) { this.url = url; this.id = 0; this.pend = new Map(); }
    async connect() {
        this.ws = new WebSocket(this.url);
        await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws connect failed')); });
        this.ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.id && this.pend.has(m.id)) {
                const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id);
                if (m.error) rej(new Error(m.error.message)); else res(m.result);
            }
        };
    }
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
    fs.mkdirSync(OUT_DIR, { recursive: true });
    let version = null;
    for (let i = 0; i < 90; i++) {
        try { version = await getJson('/json/version'); if (version) break; } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!version) { console.error('[shot-dev] CDP 端口 ' + PORT + ' 未就绪——开发实例是否已带 --remote-debugging-port 启动？'); process.exit(2); }

    let page = null;
    for (let i = 0; i < 40; i++) {
        try {
            const targets = await getJson('/json/list');
            page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url || '')) || targets.find((t) => t.type === 'page');
            if (page) break;
        } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!page) { console.error('[shot-dev] 找不到渲染页'); process.exit(2); }
    console.log('[shot-dev] page =', page.url);

    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < 40; i++) {
        try { if (await cdp.evaluate('document.readyState') === 'complete') break; } catch (e) { }
        await sleep(500);
    }
    // 等后端握手与首屏数据（开发版连真实配置，首屏可能是真实源 feed）
    for (let i = 0; i < 30; i++) {
        const ready = await cdp.evaluate(`(() => ({
            cards: document.querySelectorAll('#home-grid .vod-card, #home-grid .bangumi-card').length,
            grid: !!document.querySelector('#home-grid'),
        }))()`);
        if (ready.cards > 0) { console.log('[shot-dev] home cards =', ready.cards); break; }
        await sleep(1000);
    }
    await sleep(3000); // 等封面图批量加载

    const shot = async (name) => {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const f = path.join(OUT_DIR, name + '.png');
        fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
        console.log('[shot-dev] saved:', f);
    };
    const nav = async (view) => {
        await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="${view}"]'); if (el) el.click(); return !!el; })()`);
    };
    const waitCards = async (sel, max = 24) => {
        for (let i = 0; i < max; i++) {
            const n = await cdp.evaluate(`document.querySelectorAll('${sel}').length`);
            if (n > 0) { console.log('[shot-dev] cards in', sel, '=', n); return; }
            await sleep(500);
        }
    };

    // 1. 首页（真实配置的当前源）
    await shot('home');

    // 2. 推荐
    await nav('popular');
    await waitCards('#view-popular .bangumi-card, #view-popular .vod-card');
    await sleep(2500);
    await shot('recommend');

    // 3. 时间表
    await nav('timeline');
    await waitCards('#timeline-grid .bangumi-card');
    await sleep(2000);
    await shot('timeline');

    // 4. Bangumi 详情（时间表首卡点入）
    await cdp.evaluate(`(() => { const c = document.querySelector('#timeline-grid .bangumi-card'); if (c) c.click(); return !!c; })()`);
    for (let i = 0; i < 20; i++) {
        if (await cdp.evaluate(`!!document.querySelector('#view-detail.active')`)) break;
        await sleep(500);
    }
    await sleep(3000);
    await shot('bangumi-detail');

    // 5. 返回时间表 → 我的收藏
    await cdp.evaluate(`(() => { const b = document.querySelector('#detail-back, .detail-back'); if (b) b.click(); return !!b; })()`);
    await sleep(1200);
    await nav('my');
    await sleep(800);
    await cdp.evaluate(`(() => { const el = document.querySelector('#view-my [data-my-tab="favorites"]'); if (el) el.click(); return !!el; })()`);
    await sleep(1500);
    await shot('favorites');

    // 6. 设置 · CatVod 源
    await nav('settings');
    await sleep(800);
    await cdp.evaluate(`(() => { const el = document.querySelector('#settings-nav .settings-nav-item[data-cat="source"]'); if (el) el.click(); return !!el; })()`);
    await sleep(800);
    await shot('settings-catvod');

    // 7. 设置 · Kazumi 规则
    await cdp.evaluate(`(() => { const el = document.querySelector('#settings-nav .settings-nav-item[data-cat="kazumi"]'); if (el) el.click(); return !!el; })()`);
    await sleep(800);
    await shot('settings-kazumi');

    console.log('[shot-dev] done.');
    process.exit(0);
})().catch((e) => { console.error('[shot-dev] fatal:', e); process.exit(1); });
