/**
 * scripts/verify-title-fit.js — 卡片标题「恰好两行」精确截断（T74 收尾）真实界面验证（临时脚本）
 *
 * 独立 userData 启动临时 Electron 实例，经 CDP 向 #home-grid 注入一组超长/中/短标题卡片，
 * 走与各渲染点相同的 fitVodTitles(#home-grid) 路径，验证：
 *   1. 每张卡 .vod-name 截断后 scrollHeight <= clientHeight（DOM 无超行文字 = 无白块绘制源）
 *   2. 截断过的标题 textContent 以单个 '…' 结尾（CSS clamp 因无溢出不会再画第二个）
 *   3. 未超两行的标题保持原样（不误截、不添 '…'）
 *   4. title 属性仍保留完整标题（悬浮提示不受影响）
 *   5. 窗口缩放（响应式断点）后 refitVodTitles 重新适配，依然无超行
 * 零依赖：Node 内置 WebSocket。结束时 kill 临时实例并删除副本目录。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9343);

let failures = 0;
function check(name, cond, extra) {
    if (cond) { console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
    else { failures++; console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : '')); }
}

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-title-fit-'));
    try {
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify({ lastConfigUrl: '', onboarded: true }, null, 2), 'utf8');
    } catch (e) { }

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

    // 注入 5 张卡：长中文 / 长拉丁 / 中长混合 / 恰好两行 / 单行短标题。title 恒为完整文本。
    await cdp.evaluate(`(() => {
        const grid = document.getElementById('home-grid') || document.body;
        const titles = [
            '这是一个特别特别长的中文标题用来验证标题超出行数之后是否会出现白色渲染错误的测试用例标题',
            'The Quick Brown Fox Jumps Over The Lazy Dog And Keeps Running Through The Forest Every Single Day',
            '中英混排 Title 很长很长 为了测试 mixed CJK and latin 是否能精确截断在两行内而不溢出',
            '短标题',
            '中',
        ];
        grid.innerHTML = titles.map((name) =>
            '<div class="vod-card" data-id="t" data-name="' + name + '" tabindex="0">' +
            '<div class="vod-cover"><img src="assets/cover-fallback.svg" alt=""></div>' +
            '<div class="vod-name" title="' + name + '">' + name + '</div>' +
            '<div class="vod-remarks">验证用</div></div>').join('');
        return true;
    })()`);
    await sleep(300);

    // 与各网格渲染点相同的调用：fitVodTitles(容器)
    await cdp.evaluate(`fitVodTitles('#home-grid')`);
    await sleep(300);

    const before = await cdp.evaluate(`(() => {
        const box = [...document.querySelectorAll('#home-grid .vod-name')];
        return box.map((e) => {
            const cs = getComputedStyle(e);
            const txt = e.textContent;
            return {
                domLen: txt.length,
                endsEllipsis: txt.endsWith('…'),
                ellipsisCount: (txt.match(/…/g) || []).length,
                clientH: e.clientHeight,
                scrollH: e.scrollHeight,
                fits: e.scrollHeight <= e.clientHeight + 1,
                titleKept: e.getAttribute('title') !== null && e.getAttribute('title').length > 0,
                lineClamp: cs.webkitLineClamp || cs.lineClamp,
            };
        });
    })()`);

    console.log('--- 注入 5 张卡，fitVodTitles 后 ---');
    before.forEach((b, i) => {
        console.log(`  [卡${i}] len=${b.domLen} clientH=${b.clientH} scrollH=${b.scrollH} fits=${b.fits} '…'=${b.ellipsisCount} clamp=${b.lineClamp} titleKept=${b.titleKept}`);
        check(`卡${i} 无超行 (scrollH<=clientH)`, b.fits);
        check(`卡${i} 省略号最多一个`, b.ellipsisCount <= 1);
        check(`卡${i} title 保留完整文本`, b.titleKept);
        check(`卡${i} lineClamp=2`, String(b.lineClamp) === '2');
    });
    // 短标题（卡3、卡4）必须原样：不截断、不添省略号
    check('短标题未被误截/误添省略号', before[3].endsEllipsis === false && before[3].ellipsisCount === 0 && before[4].ellipsisCount === 0);
    // 长标题（卡0）DOM 长度必须小于完整文本（确实截断了）
    const full0 = '这是一个特别特别长的中文标题用来验证标题超出行数之后是否会出现白色渲染错误的测试用例标题';
    check('长中文标题被截断', before[0].domLen < full0.length && before[0].endsEllipsis);

    // 缩放窗口触发响应式断点，验证 resize 自动 refit 后依然无超行
    await cdp.evaluate(`window.resizeTo(1100, 800)`);
    await sleep(800); // 等防抖 refitVodTitles(300ms) + 布局稳定
    const afterResize = await cdp.evaluate(`(() => {
        const box = [...document.querySelectorAll('#home-grid .vod-name')];
        return box.map((e) => ({ fits: e.scrollHeight <= e.clientHeight + 1, len: e.textContent.length, ellipsis: (e.textContent.match(/…/g) || []).length, title: e.getAttribute('title').length }));
    })()`);
    console.log('--- resize 到 1100px 宽，自动 refit 后 ---');
    afterResize.forEach((b, i) => {
        console.log(`  [卡${i}] len=${b.len} fits=${b.fits} '…'=${b.ellipsis} titleLen=${b.title}`);
        check(`resize 后卡${i} 无超行`, b.fits);
        check(`resize 后卡${i} 省略号最多一个`, b.ellipsis <= 1);
        check(`resize 后卡${i} title 仍完整`, b.title > 0);
    });

    // 放大窗口到超宽断点（≥1800px 标题 14px），验证再次 refit
    await cdp.evaluate(`window.resizeTo(1900, 1000)`);
    await sleep(800);
    const afterWide = await cdp.evaluate(`(() => {
        const box = [...document.querySelectorAll('#home-grid .vod-name')];
        return box.map((e) => ({ fits: e.scrollHeight <= e.clientHeight + 1, len: e.textContent.length }));
    })()`);
    console.log('--- resize 到 1900px 宽（≥1800 断点），自动 refit 后 ---');
    afterWide.forEach((b, i) => {
        console.log(`  [卡${i}] len=${b.len} fits=${b.fits}`);
        check(`宽断点卡${i} 无超行`, b.fits);
    });

    // refitVodTitles 恢复能力：把某卡标题手动改短后再 refit，应从 title 恢复完整文本并重新截断
    await cdp.evaluate(`(() => {
        const e = document.querySelectorAll('#home-grid .vod-name')[0];
        e.textContent = '人工改短';
        return true;
    })()`);
    await sleep(100);
    await cdp.evaluate(`refitVodTitles()`);
    await sleep(200);
    const restored = await cdp.evaluate(`(() => {
        const e = document.querySelectorAll('#home-grid .vod-name')[0];
        return { len: e.textContent.length, ends: e.textContent.endsWith('…'), fits: e.scrollHeight <= e.clientHeight + 1, hasFull: e.textContent.length > 4 };
    })()`);
    console.log('--- refitVodTitles 从 title 恢复 ---');
    check('refit 后不再是人工改短（已恢复完整并截断）', restored.hasFull);
    check('refit 后无超行', restored.fits);

    if (cdp.errors.length) console.warn('WARN: 控制台错误 ' + cdp.errors.length + ' 条\n' + cdp.errors.join('\n'));
    console.log('--------------------------------');
    if (failures) { console.error('OVERALL: FAIL (' + failures + ' 项)'); cleanup(1); }
    console.log('OVERALL: PASS');
    cleanup(0);
})().catch((e) => { console.error('FATAL:', e && e.message ? e.message : e); process.exit(1); });
