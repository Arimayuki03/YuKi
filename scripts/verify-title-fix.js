/**
 * scripts/verify-title-fix.js — 卡片标题白块修复真实界面验证（临时脚本）
 *
 * 独立 userData 启动临时 Electron 实例，经 CDP 向 #home-grid 注入超长标题卡片，验证：
 *   1. .vod-name 计算样式 wordBreak === 'normal'（不再 break-all）、-webkit-line-clamp === '2'
 *   2. 注入长标题后 el.scrollHeight <= el.clientHeight（无溢出绘制 = 白块根因消除）
 *   3. 截图（正常态 + hover 态）供目视对比
 *   4. 控制台错误采集
 * 零依赖：Node 内置 WebSocket。结束时 kill 临时实例并删除副本目录。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.VPC_CDP_PORT || 9340);
const SHOT_DIR = path.join(os.tmpdir(), 'vpc-title-fix-shots');

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-title-fix-'));
    try {
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify({ lastConfigUrl: '', onboarded: true }, null, 2), 'utf8');
    } catch (e) { }
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const child = spawn(ELECTRON, [ROOT, '--remote-debugging-port=' + PORT, '--user-data-dir=' + tmpUserData, '--no-first-run'], { stdio: ['ignore', 'pipe', 'pipe'] });
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

    // 注入两张超长标题卡（CJK 50 字 + 拉丁 60 字），不依赖后端数据
    await cdp.evaluate(`(() => {
        const grid = document.getElementById('home-grid') || document.body;
        const longCjk = '这是一个特别特别长的中文标题用来验证标题超出行数之后是否会出现白色渲染错误的测试用例标题'.repeat(2); // 52 字
        const longLatin = 'The Quick Brown Fox Jumps Over The Lazy Dog And Keeps Running Through The Forest Every Single Day For Hours'.repeat(2); // >60
        const mk = (name) => '<div class="vod-card" data-id="t" data-name="'+name+'" tabindex="0">' +
            '<div class="vod-cover"><img src="assets/cover-fallback.svg" alt=""></div>' +
            '<div class="vod-name" title="'+name+'">'+name+'</div>' +
            '<div class="vod-remarks">验证用</div></div>';
        grid.innerHTML = mk(longCjk) + mk(longLatin);
        return true;
    })()`);
    await sleep(500);
    // 各网格渲染点同路径：渲染后按实际列宽把标题 JS 截到恰好两行（T74 收尾）
    await cdp.evaluate(`fitVodTitles('#home-grid')`);
    await sleep(300);

    const out = await cdp.evaluate(`(() => {
        const els = [...document.querySelectorAll('.vod-name')];
        const one = els[0];
        const cs = getComputedStyle(one);
        return {
            count: els.length,
            wordBreak: cs.wordBreak,
            overflowWrap: cs.overflowWrap,
            lineClamp: cs.webkitLineClamp || cs.lineClamp,
            boxOrient: cs.webkitBoxOrient || cs.boxOrient,
            display: cs.display,
            // 每个标题盒：DOM 文本长度 / 可视高度 / 滚动高度（溢出绘制根因指标）
            boxes: els.map((e) => ({
                domLen: e.textContent.length,
                clientH: e.clientHeight,
                scrollH: e.scrollHeight,
                clipped: e.scrollHeight > e.clientHeight + 1,
            })),
        };
    })()`);
    console.log('[verify] computed:', JSON.stringify(out, null, 2));

    const shot = async (name) => {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const f = path.join(SHOT_DIR, name + '.png');
        fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
        console.log('[verify] screenshot saved:', f);
    };

    // 正常态截图
    await shot('after-fix-idle');

    // hover 态：卡片 hover 会 transform:translateY(-3px) 提升合成层，白块可能与合成相关——模拟鼠标悬停再截图
    const rect = await cdp.evaluate(`(() => { const r = document.querySelector('.vod-card').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await sleep(400);
    await shot('after-fix-hover');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await sleep(300);

    // A/B：把 word-break:break-all 重新注入回 .vod-name，观察是否复现白块触发条件（验证根因）
    await cdp.evaluate(`(() => {
        const s = document.createElement('style');
        s.id = 'ab-breakall';
        s.textContent = '.vod-name { word-break:break-all !important; }';
        document.head.appendChild(s);
        return true;
    })()`);
    await sleep(400);
    await shot('ab-breakall-idle');

    const wordBreakAfter = await cdp.evaluate(`getComputedStyle(document.querySelector('.vod-name')).wordBreak`);
    console.log('[verify] wordBreak after A/B inject =', wordBreakAfter);

    // 汇总
    const allClipped = out.boxes.filter((b) => b.clipped);
    console.log('--------------------------------');
    if (out.count !== 2) { console.error('FAIL: 卡片注入数 != 2'); cleanup(2); }
    if (out.wordBreak !== 'normal') { console.error('FAIL: wordBreak =', out.wordBreak); cleanup(2); }
    if (out.lineClamp !== '2') { console.error('FAIL: lineClamp =', out.lineClamp); cleanup(2); }
    if (allClipped.length) { console.error('FAIL: 溢出绘制盒 =', JSON.stringify(allClipped)); cleanup(2); }
    if (cdp.errors.length) { console.error('WARN: 控制台错误 ' + cdp.errors.length + ' 条\n' + cdp.errors.join('\n')); }
    console.log('[verify] computed styles OK（wordBreak=normal, lineClamp=2, 无溢出绘制盒）');
    console.log('[verify] 截图目录 =', SHOT_DIR, '（请目视 after-fix-idle.png / after-fix-hover.png 无白块，ab-breakall-idle.png 对照）');
    console.log('OVERALL: PASS');
    cleanup(0);
})().catch((e) => { console.error('FATAL:', e && e.message ? e.message : e); process.exit(1); });
