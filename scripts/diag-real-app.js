'use strict';
/* 诊断（临时）：真实配置 + CDP，验证首页空分类隐藏覆盖「全部源」。
 * A. 后台扫描（_probeAllClasses）：未选中的源也被自动探测（_clsProbed 置位、持久化落盘）
 * B. 逐个切换源：探测完成后空分类从分类栏消失、非空分类保留 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9353);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-diag-all-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'yuki', 'settings.json');
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        s.wallpaper = ''; s.onboarded = true; s.bangumiToken = '';
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(s, null, 2), 'utf8');
    } catch (e) {
        console.error('无法读取真实 settings:', e.message);
        process.exit(2);
    }
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

    // 等站点载入
    let sites = 0;
    for (let i = 0; i < 90; i++) {
        sites = await cdp.evaluate(`document.querySelectorAll('#site-select option').length`);
        if (sites > 20) break;
        await sleep(1000);
    }
    console.log('[diag] sites loaded:', sites);
    const out = {};

    // ============ A. 后台全源扫描：等待未选中源被自动探测 ============
    let sweepProbed = [];
    for (let i = 0; i < 120; i++) {
        const probed = await cdp.evaluate(`Object.keys(Home._clsProbed).filter(k => Home._clsProbed[k] === true)`);
        if (probed.length >= 5) { sweepProbed = probed; break; }
        await sleep(1000);
    }
    if (!sweepProbed.length) sweepProbed = await cdp.evaluate(`Object.keys(Home._clsProbed).filter(k => Home._clsProbed[k] === true)`);
    out.sweepProbedCount = sweepProbed.length;
    out.sweepProbedSample = sweepProbed.slice(0, 8);
    out.sweepProbedHasQzl = sweepProbed.includes('量子资源');
    const persistedAll = await cdp.evaluate(`(() => { try { const d = JSON.parse(localStorage.getItem('yuki_home_empty_classes') || '{}'); return { keys: Object.keys(d).length, hasQzl: !!d['量子资源'] }; } catch (e) { return { err: 1 }; } })()`);
    out.persistedAfterSweep = persistedAll;

    // ============ B. 逐个切换源，验证探测 + 隐藏 ============
    const switchTo = async (name) => {
        const ok = await cdp.evaluate(`(() => {
            if (!$('#site-select option[value="${name}"]').length) return false;
            $('#site-select').val('${name}').trigger('change');
            return true;
        })()`);
        return ok;
    };
    const waitRender = async (expectedTab) => {
        for (let i = 0; i < 60; i++) {
            const tabs = await cdp.evaluate(`[...document.querySelectorAll('#home-class .class-tab')].map(t => t.textContent.trim())`);
            if (tabs.includes(expectedTab)) return true;
            await sleep(500);
        }
        return false;
    };
    const waitProbeDone = async (site) => {
        for (let i = 0; i < 80; i++) {
            const done = await cdp.evaluate(`Home._clsProbed['${site}'] === true`);
            if (done) return i * 0.5;
            await sleep(500);
        }
        return -1;
    };
    const inspect = async (site) => {
        const tabs = await cdp.evaluate(`[...document.querySelectorAll('#home-class .class-tab')].map(t => t.textContent.trim())`);
        const empty = await cdp.evaluate(`Home._emptyCls['${site}'] ? [...Home._emptyCls['${site}']] : []`);
        const dataTids = await cdp.evaluate(`[...document.querySelectorAll('#home-class .class-tab')].map(t => t.getAttribute('data-tid'))`);
        const hiddenEmpty = empty.every((t) => !dataTids.includes(t));
        return { tabs: tabs.length, empty, hiddenEmpty };
    };

    const targets = ['量子资源', '新浪资源', '豆瓣资源'];
    out.sources = {};
    for (const name of targets) {
        if (!(await switchTo(name))) { out.sources[name] = { switched: false }; continue; }
        const rendered = await waitRender(name === '量子资源' ? '电影片' : undefined);
        const probeSec = await waitProbeDone(name);
        const insp = await inspect(name);
        out.sources[name] = { switched: true, rendered, probeSec, ...insp };
    }

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== 全源空分类隐藏诊断 =====');
    console.log(JSON.stringify(out, null, 2));

    const relatedErr = out.console.errors.filter((e) => /home\.js/.test(e));
    const checks = {
        '后台扫描已自动探测 ≥5 个未选中源': out.sweepProbedCount >= 5,
        '持久化已含多个源的空分类': (out.persistedAfterSweep.keys || 0) >= 3,
        '量子资源：探测完成且空分类全部从栏中消失': out.sources['量子资源'] && out.sources['量子资源'].probeSec >= 0 && out.sources['量子资源'].hiddenEmpty === true,
        '量子资源：空分类已检测（>0）': out.sources['量子资源'] && out.sources['量子资源'].empty.length > 0,
        '新浪资源：探测完成且空分类消失': out.sources['新浪资源'] && out.sources['新浪资源'].probeSec >= 0 && out.sources['新浪资源'].hiddenEmpty === true,
        '豆瓣资源：探测完成且空分类消失': out.sources['豆瓣资源'] && out.sources['豆瓣资源'].probeSec >= 0 && out.sources['豆瓣资源'].hiddenEmpty === true,
        '无 home.js 相关控制台错误': relatedErr.length === 0,
    };
    console.log('\n===== 判定 =====');
    let allPass = true;
    for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS' : 'FAIL') + '  ' + k); if (!v) allPass = false; }
    if (out.console.errors.length) console.log('\n--- 控制台错误 ---\n' + out.console.errors.join('\n'));
    console.log('\nOVERALL: ' + (allPass ? 'PASS' : 'FAIL'));
    cleanup(allPass ? 0 : 1);
})().catch((e) => { console.error('diag 异常:', e); process.exit(2); });
