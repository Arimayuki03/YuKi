/**
 * scripts/diag-play.js — 诊断「点集数播放后一直卡在载入中」：
 * 隔离实例 → 首页第一张卡 → 详情 → 点第一集 → 观察全局 loading 浮层、
 * 渲染层 play 状态与后端请求，60s 内每 2s 采样一次。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9347);

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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-')); const tc = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
    const src = path.join(process.env.APPDATA || '', 'yuki', 'settings.json');
    try { const s = JSON.parse(fs.readFileSync(src, 'utf8')); s.onboarded = true; s.wallpaper = ''; fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(s, null, 2)); } catch (e) {}
    const c = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + PORT, '--user-data-dir=' + tmp, '--no-first-run'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, YUKI_CACHE_DIR: tc } });
    let al = ''; c.stdout.on('data', (d) => { al += d; }); c.stderr.on('data', (d) => { al += d; });
    const clean = (code) => { try { c.kill('SIGKILL'); } catch (e) { } setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { } try { fs.rmSync(tc, { recursive: true, force: true }); } catch (e) { } process.exit(code); }, 800); };
    process.on('SIGINT', () => clean(130));
    let v = null; for (let i = 0; i < 60; i++) { try { v = await getJson('/json/version'); if (v) break; } catch (e) { } await new Promise((r) => setTimeout(r, 500)); }
    if (!v) { console.error('CDP fail\n' + al.slice(-1200)); clean(2); }
    let pg = null; for (let i = 0; i < 30; i++) { try { const t = await getJson('/json/list'); pg = t.find((x) => x.type === 'page' && /index\.html/.test(x.url || '')) || t.find((x) => x.type === 'page'); if (pg) break; } catch (e) { } await new Promise((r) => setTimeout(r, 500)); }
    const cdp = new CDP(pg.webSocketDebuggerUrl); await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    cdp.on((m) => { if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) { const t = (m.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' '); cdp.errors.push(String(t).slice(0, 200)); } if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; cdp.errors.push('EXC: ' + (((d.exception && d.exception.description) || d.text) + '').slice(0, 200)); } });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) { try { if (await cdp.evaluate('document.readyState') === 'complete') break; } catch (e) { } await new Promise((r) => setTimeout(r, 500)); }
    // 等首页就绪（最多 40s）
    let home = false;
    for (let i = 0; i < 40; i++) { const r = await cdp.evaluate('(typeof Home!=="undefined")?Home._inited:false'); if (r === true) { home = true; break; } await sleep(1000); }
    if (!home) { console.log('首页未就绪\n' + al.slice(-1200)); clean(2); }

    const out = {};
    // 进入首页第一张卡 → 详情 → 点第一集
    out.step = await cdp.evaluate(`(async () => {
        const card = document.querySelector('#home-grid .vod-card');
        if (!card) return { step: 'no-home-card', grid: document.querySelectorAll('#home-grid .vod-card').length, homeText: (document.querySelector('#home-grid')||{}).innerText ? document.querySelector('#home-grid').innerText.slice(0,80) : '' };
        card.click();
        for (let i = 0; i < 30; i++) { if (document.querySelector('#detail-body .ep-btn')) break; await new Promise(r => setTimeout(r, 500)); }
        const ep = document.querySelector('#detail-body .ep-btn');
        if (!ep) return { step: 'no-episode', detail: (document.querySelector('#detail-body')||{}).innerText ? document.querySelector('#detail-body').innerText.slice(0,100) : '' };
        const info = { step: 'playing', hasEpisode: !!ep, loadingAtClick: getComputedStyle(document.getElementById('loadingToast')).display !== 'none' };
        ep.click();
        return info;
    })()`, true);

    // 每 3s 采样 loading 浮层 + 播放状态，持续 45s
    out.timeline = [];
    for (let i = 0; i < 15; i++) {
        await sleep(3000);
        const s = await cdp.evaluate(`(() => ({
            t: ${(i + 1) * 3},
            loading: getComputedStyle(document.getElementById('loadingToast')).display !== 'none',
            playerDialog: document.getElementById('playerDialog') ? getComputedStyle(document.getElementById('playerDialog')).display !== 'none' : null,
            playerSeq: (typeof Player !== 'undefined') ? !!Player._seq : null,
            playerSession: (typeof Player !== 'undefined') ? Player._session : null,
            playerDialogNote: document.getElementById('player-note') ? (document.getElementById('player-note').style.display !== 'none' ? document.getElementById('player-note').textContent.slice(0,60) : '') : '',
        }))()`);
        out.timeline.push(s);
        if (s.loading === false && s.playerDialog !== true && s.playerSeq !== true) { out.timeline.push({ t: (i + 1) * 3, note: '（loading 已清除且无对话框，播放可能已结束/未起播）' }); break; }
    }
    out.console = { errors: cdp.errors.slice(0, 15), errorCount: cdp.errors.length };
    console.log('\n===== 播放诊断 =====');
    console.log(JSON.stringify(out, null, 2));
    clean(0);
})().catch((e) => { console.error('诊断异常:', e); process.exit(2); });
