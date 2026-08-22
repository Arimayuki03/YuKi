/**
 * scripts/acceptance-empty-class.js — 首页空分类自动隐藏真实界面验收（临时脚本）
 *
 * 独立 userData 副本 + CDP 实测，利用后端内置的离线 demo 源（spiders/demo.py）：
 *   homeContent 返回 电影/剧集 两个分类，categoryContent 恒返回空 list → 完全确定性、不依赖外网。
 *
 * 1. 空分类全隐藏：demo 两个分类均无影片 → 探测后分类栏只剩「全部」
 * 2. 混合保留：CDP 桩 doAction 令 剧集 返回内容、电影 仍空 → 重探测后分类栏为「全部 + 剧集」，
 *    持久化 localStorage['yuki_home_empty_classes'] 的 demo 仅剩 电影
 * 3. 持久化：探测结果写入 localStorage（重启后首屏即过滤，无闪现）
 * 4. 无 home.js 相关控制台错误
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9346);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-accept-ec-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'yuki', 'settings.json');
    const seed = { lastConfigUrl: '', configHistory: [], wallpaper: '', onboarded: true, bangumiToken: '' };
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        Object.assign(s, seed);
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(s, null, 2), 'utf8');
    } catch (e) {
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(seed, null, 2), 'utf8');
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
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};

    // 等首页 demo 源载入（站点下拉有选项）
    let ready = false;
    for (let i = 0; i < 30; i++) {
        ready = await cdp.evaluate(`document.querySelectorAll('#site-select option').length >= 1 && !!document.getElementById('home-class')`);
        if (ready) break;
        await sleep(500);
    }
    if (!ready) { console.error('首页未就绪\n' + appLog.slice(-2000)); cleanup(2); }
    await sleep(1500); // 等首屏渲染

    // ============ 1. 空分类全隐藏（demo 两分类均无影片 → 只剩「全部」） ============
    let tabs1 = -1;
    for (let i = 0; i < 30; i++) {
        tabs1 = await cdp.evaluate(`document.querySelectorAll('#home-class .class-tab').length`);
        if (tabs1 === 1) break;
        await sleep(300);
    }
    out.tabLabels1 = await cdp.evaluate(`[...document.querySelectorAll('#home-class .class-tab')].map(t => t.textContent.trim())`);
    out.tabs1 = tabs1;
    out.demoSelected = await cdp.evaluate(`document.getElementById('site-select').value`);
    out.persisted1 = await cdp.evaluate(`(() => { try { const d = JSON.parse(localStorage.getItem('yuki_home_empty_classes') || '{}'); return d['demo'] && d['demo'].empty ? [...d['demo'].empty].sort() : null; } catch (e) { return 'ERR'; } })()`);

    // ============ 2. 混合：桩 doAction 令 剧集 有内容、电影 仍空 → 重探测后「全部 + 剧集」 ============
    await cdp.evaluate(`(() => {
        window.__origDoAction = window.doAction;
        window.doAction = async (action, kv) => {
            if (action === 'categoryContent' && kv && kv.tid === 'serie') return { list: [{ vod_id: 's1', vod_name: '剧集 1' }] };
            if (action === 'categoryContent') return { list: [] };
            return window.__origDoAction(action, kv);
        };
        // 重置探测状态，模拟「新会话」重新探测（demo 分类需重新判定）
        Home._clsProbed = {}; Home._clsStarted = {}; Home._okCls = {}; Home._emptyCls = {};
        Home.loadHome();
        return true;
    })()`);
    let tabs2 = -1;
    for (let i = 0; i < 30; i++) {
        tabs2 = await cdp.evaluate(`document.querySelectorAll('#home-class .class-tab').length`);
        if (tabs2 === 2) break;
        await sleep(300);
    }
    out.tabLabels2 = await cdp.evaluate(`[...document.querySelectorAll('#home-class .class-tab')].map(t => t.textContent.trim())`);
    out.tabs2 = tabs2;
    out.persisted2 = await cdp.evaluate(`(() => { try { const d = JSON.parse(localStorage.getItem('yuki_home_empty_classes') || '{}'); return d['demo'] && d['demo'].empty ? [...d['demo'].empty].sort() : null; } catch (e) { return 'ERR'; } })()`);

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== 空分类隐藏验收原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const relatedErr = out.console.errors.filter((e) => /home\.js/.test(e));
    const checks = {
        '首页选中内置 demo 源': out.demoSelected === 'demo',
        '空分类全隐藏：探测后分类栏仅「全部」（电影/剧集被隐藏）': out.tabs1 === 1 && JSON.stringify(out.tabLabels1) === JSON.stringify(['全部']),
        '空分类结果持久化：demo → [movie,serie]': JSON.stringify(out.persisted1) === JSON.stringify(['movie', 'serie']),
        '混合重探测：剧集有内容保留、电影空隐藏 → [全部,剧集]': out.tabs2 === 2 && JSON.stringify(out.tabLabels2) === JSON.stringify(['全部', '剧集']),
        '持久化更新：demo 仅剩 [movie]': JSON.stringify(out.persisted2) === JSON.stringify(['movie']),
        '无 home.js 相关控制台错误': relatedErr.length === 0,
    };
    console.log('\n===== 判定 =====');
    let allPass = true;
    for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS' : 'FAIL') + '  ' + k); if (!v) allPass = false; }
    if (out.console.errors.length) console.log('\n--- 全部控制台错误 ---\n' + out.console.errors.join('\n'));
    console.log('\nOVERALL: ' + (allPass ? 'PASS' : 'FAIL'));
    if (!allPass) console.log('\n--- 应用日志尾部 ---\n' + appLog.slice(-1500));
    cleanup(allPass ? 0 : 1);
})().catch((e) => { console.error('验收脚本异常:', e); process.exit(2); });
