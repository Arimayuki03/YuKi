/**
 * 自动截取 README 界面预览截图（assets/screenshots/*.png）。
 *
 * 手法对齐 scripts/acceptance-*.js 的「临时调试实例 + CDP 驱动」既有范式：
 * - 独立 userData 副本（清空 lastConfigUrl/bangumiToken/wallpaper，不碰真实用户数据）；
 * - electron --remote-debugging-port 启动，等 CDP 就绪后导航各视图；
 * - Page.captureScreenshot 输出 PNG（窗口尺寸由 main 进程 BrowserWindow 决定，
 *   启动参数经 --window-size 拉到 1600x1000 对齐旧截图 1600px 宽规格）。
 *
 * 内容源：
 * - 首页：内置「示例源」（demo spider，零外网依赖，固定 mock 数据）；
 * - 推荐/时间表：Bangumi 公开 API（真实数据，无需 token）；
 * - 详情页：点击首页示例影片卡进入（CatVod 详情版面）；
 * - 设置：source（源设置）与 kazumi（规则管理）两个分类；
 * - 我的收藏：预置种子数据（与 acceptance-my-watch 同款）。
 *
 * 用法：node scripts/take-screenshots.js [--out <dir>]
 *   默认输出 <repo>/build/screenshots-staging/（确认后才覆盖 assets/screenshots/）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9337);
const OUT_DIR = (() => {
    const i = process.argv.indexOf('--out');
    if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
    return path.join(ROOT, 'build', 'screenshots-staging');
})();

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
    constructor(url) { this.url = url; this.id = 0; this.pend = new Map(); this.handlers = []; }
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
    // ---- 独立 userData：清空真实痕迹 + 预置收藏种子 ----
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-shot-'));
    const seed = {
        lastConfigUrl: '', configHistory: [], wallpaper: '', onboarded: true,
        bangumiToken: '', webDavUrl: '', webDavUsername: '', webDavPassword: '',
        proxyEnable: false, proxyUrl: '',
        watchStats: { totalSeconds: 0, sessionCount: 0, titles: {}, daily: {} },
        recentWatches: [],
        favorites: [
            { site: 'demo', vodId: 'fav-1', name: '收藏片 A', pic: '', remarks: '全 12 集', siteName: '示例源', tag: 'want', ts: Date.now() },
            { site: 'demo', vodId: 'fav-2', name: '收藏片 B', pic: '', remarks: '更新中', siteName: '示例源', tag: 'seen', ts: Date.now() - 1000 },
        ],
    };
    fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(seed, null, 2), 'utf8');

    const electronArgs = [
        ROOT, '--remote-debugging-port=' + PORT, '--user-data-dir=' + tmpUserData,
        '--no-first-run', '--window-size=1600,1000',
    ];
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log('[shot] userData =', tmpUserData);
    console.log('[shot] out dir  =', OUT_DIR);
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

    // ---- 等 CDP 就绪 ----
    let version = null;
    for (let i = 0; i < 60; i++) {
        try { version = await getJson('/json/version'); if (version) break; } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!version) { console.error('CDP 端口未就绪\n' + appLog.slice(-2000)); cleanup(2); }

    // ---- 找主渲染页 ----
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
    console.log('[shot] page =', page.url);

    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---- 等渲染层就绪 + 后端握手 ----
    for (let i = 0; i < 40; i++) {
        try { if (await cdp.evaluate('document.readyState') === 'complete') break; } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    await sleep(4000); // 等启动链路（后端就绪/渲染）

    const shot = async (name) => {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const f = path.join(OUT_DIR, name + '.png');
        fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
        console.log('[shot] saved:', f);
    };
    const nav = async (view) => {
        await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="${view}"]'); if (el) el.click(); return !!el; })()`);
    };

    // ============ 1. 首页（示例源） ============
    await nav('home');
    await sleep(1500);
    // 等站点列表与 feed 渲染（示例源数据本地即回，最多再等 8s）
    for (let i = 0; i < 16; i++) {
        const ready = await cdp.evaluate(`(() => {
            const cards = document.querySelectorAll('#home-grid .vod-card').length;
            return { cards, hasSite: !!document.querySelector('#site-select option') };
        })()`);
        if (ready.cards > 0) { console.log('[shot] home ready, cards =', ready.cards); break; }
        await sleep(500);
    }
    await shot('home');

    // ============ 2. Bangumi 详情页（时间表点番剧卡进入：评分/收藏同步版面） ============
    await nav('timeline');
    for (let i = 0; i < 20; i++) {
        const cards = await cdp.evaluate(`document.querySelectorAll('#timeline-grid .bangumi-card').length`);
        if (cards > 0) break;
        await sleep(500);
    }
    await sleep(1500);
    await cdp.evaluate(`(() => { const c = document.querySelector('#timeline-grid .bangumi-card'); if (c) c.click(); return !!c; })()`);
    for (let i = 0; i < 20; i++) {
        const ok = await cdp.evaluate(`!!document.querySelector('#view-detail.active')`);
        if (ok) break;
        await sleep(500);
    }
    await sleep(2500); // 等 Bangumi 匹配/评分区块渲染
    await shot('bangumi-detail');

    // ============ 3. 推荐（Bangumi 热门，真实数据） ============
    await nav('popular');
    for (let i = 0; i < 20; i++) {
        const cards = await cdp.evaluate(`document.querySelectorAll('#view-popular .bangumi-card, #view-popular .vod-card').length`);
        if (cards > 0) { console.log('[shot] popular cards =', cards); break; }
        await sleep(500);
    }
    await sleep(1500); // 等封面图加载
    await shot('recommend');

    // ============ 4. 时间表（本周在播，真实数据） ============
    await nav('timeline');
    for (let i = 0; i < 20; i++) {
        const cards = await cdp.evaluate(`document.querySelectorAll('#timeline-grid .bangumi-card').length`);
        if (cards > 0) { console.log('[shot] timeline cards =', cards); break; }
        await sleep(500);
    }
    await sleep(1500);
    await shot('timeline');

    // ============ 5. 我的收藏（预置种子 + Bangumi 空态降级） ============
    await nav('my');
    await sleep(800);
    await cdp.evaluate(`(() => { const el = document.querySelector('#view-my [data-my-tab="favorites"]'); if (el) el.click(); return !!el; })()`);
    await sleep(800);
    await shot('favorites');

    // ============ 6. 设置 · CatVod 源配置（左侧 data-cat 分类导航切换） ============
    await nav('settings');
    await sleep(800);
    await cdp.evaluate(`(() => { const el = document.querySelector('#settings-nav .settings-nav-item[data-cat="source"]'); if (el) el.click(); return !!el; })()`);
    await sleep(800);
    await shot('settings-catvod');

    // ============ 7. 设置 · Kazumi 规则管理 ============
    await cdp.evaluate(`(() => { const el = document.querySelector('#settings-nav .settings-nav-item[data-cat="kazumi"]'); if (el) el.click(); return !!el; })()`);
    await sleep(800);
    await shot('settings-kazumi');

    console.log('[shot] done.');
    cleanup(0);
})().catch((e) => { console.error('[shot] fatal:', e); process.exit(1); });
