/**
 * scripts/acceptance-t55.js — T54/T55 + YuKi 更名真实界面验收（临时脚本）
 *
 * 用独立 userData 副本（清空 lastConfigUrl、跳过引导）启动临时 Electron 实例，经 CDP 实测：
 *   1. 软件名 YuKi：document.title / 关于分类应用名
 *   2. Kazumi 规则页布局：全宽分类（grid-column 1/-1）、规则行两行信息结构、清空按钮危险色
 *   3. 本地文件页背景闪烁修复：#view-tools 不再应用 viewIn 入场动画，模糊卡保留 backdrop-filter
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
const PORT = Number(process.env.YUKI_CDP_PORT || 9335);

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
    constructor(url) { this.url = url; this.id = 0; this.pend = new Map(); this.handlers = []; this.console = []; this.errors = []; }
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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-accept-t55-'));
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

    // ============ 1. 软件名 YuKi（title + 关于分类应用名） ============
    await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="settings"]'); if (el) el.click(); return !!el; })()`);
    await sleep(600);
    await cdp.evaluate(`(() => { const el = document.querySelector('#settings-nav .settings-nav-item[data-cat="about"]'); if (el) el.click(); return !!el; })()`);
    await sleep(900);
    out.brand = await cdp.evaluate(`(() => ({
        title: document.title,
        aboutName: (document.querySelector('.about-name') || {}).textContent || '',
        aboutVersion: (document.querySelector('#about-version') || {}).textContent || '',
    }))()`);

    // ============ 2. Kazumi 规则页布局 ============
    await cdp.evaluate(`(() => { const el = document.querySelector('#settings-nav .settings-nav-item[data-cat="kazumi"]'); if (el) el.click(); return !!el; })()`);
    await sleep(900);
    // 等规则列表渲染（后端加载 18 条规则后 refreshRuleList）
    for (let i = 0; i < 20; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#kazumi_rule_list .kazumi-rule-row').length`);
        if (n > 0) break;
        await sleep(500);
    }
    out.kazumi = await cdp.evaluate(`(() => {
        const cards = [...document.querySelectorAll('.settings-grid .tool-card[data-setcat="kazumi"]')];
        const firstCard = cards[0];
        const gridCol = firstCard ? getComputedStyle(firstCard).gridColumn : '';
        const gridRow = [...document.querySelectorAll('#kazumi_rule_list .kazumi-rule-row')];
        const firstRow = gridRow[0];
        const hasMain = firstRow ? !!firstRow.querySelector('.kazumi-rule-main') : false;
        const hasName = firstRow ? !!firstRow.querySelector('.kazumi-rule-name') : false;
        const nameWordBreak = firstRow ? getComputedStyle(firstRow.querySelector('.kazumi-rule-name')).wordBreak : '';
        const timesRows = gridRow.filter(r => r.querySelector('.kazumi-rule-times')).length;
        const rowCursor = firstRow ? getComputedStyle(firstRow).cursor : '';
        const clearBtn = document.getElementById('kazumi_rule_clear');
        return {
            kazumiCardCount: cards.length,
            firstCardGridColumn: gridCol,
            rowCount: gridRow.length,
            hasMain, hasName, nameWordBreak, timesRows, rowCursor,
            clearIsDanger: clearBtn ? clearBtn.classList.contains('md-btn-danger-tonal') : false,
        };
    })()`);

    // ============ 3. 本地文件页：无入场动画 + 模糊卡保留 ============
    await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="tools"]'); if (el) el.click(); return !!el; })()`);
    await sleep(800);
    out.local = await cdp.evaluate(`(() => {
        const view = document.getElementById('view-tools');
        const viewAnim = view ? getComputedStyle(view).animationName : '';
        const card = document.querySelector('#tool-local .tool-card');
        const cardBackdrop = card ? getComputedStyle(card).backdropFilter || getComputedStyle(card).webkitBackdropFilter : '';
        // 对照：其他视图仍应有 viewIn 入场动画
        const home = document.getElementById('view-home');
        return {
            toolsActive: view ? view.classList.contains('active') : false,
            toolsViewAnimation: viewAnim,           // 期望 none（被排除出 viewIn）
            cardBackdropFilter: cardBackdrop,        // 期望保留 blur(8px)
        };
    })()`);
    // 切回首页验证对照视图仍带动画
    await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="home"]'); if (el) el.click(); return !!el; })()`);
    await sleep(600);
    out.local.homeViewAnimation = await cdp.evaluate(`getComputedStyle(document.getElementById('view-home')).animationName`);

    await sleep(400);
    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };

    console.log('\n===== T54/T55 + YuKi 验收原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const relatedErr = out.console.errors.filter((e) => /kazumi\.js|panels\.js|index\.js|my\.js/.test(e));
    const checks = {
        '软件名：document.title 为 YuKi': out.brand.title === 'YuKi',
        '软件名：关于分类应用名为 YuKi': out.brand.aboutName.trim() === 'YuKi',
        'Kazumi：7 张卡均渲染（含 Bangumi 封面缓存）': out.kazumi.kazumiCardCount === 7,
        'Kazumi：分类卡进入全宽组（grid-column 1 / -1）': out.kazumi.firstCardGridColumn === '1 / -1',
        'Kazumi：规则行渲染且含两行信息主块': out.kazumi.rowCount > 0 && out.kazumi.hasMain && out.kazumi.hasName,
        'Kazumi：规则名不再 break-all（word-break normal）': out.kazumi.nameWordBreak === 'normal',
        'Kazumi：至少一行展示安装/更新时间': out.kazumi.timesRows >= 1,
        'Kazumi：规则行去掉误导 pointer': out.kazumi.rowCursor === 'default',
        'Kazumi：清空按钮为危险色': out.kazumi.clearIsDanger === true,
        '本地文件：#view-tools 不再应用 viewIn 入场动画': out.local.toolsActive && out.local.toolsViewAnimation === 'none',
        '本地文件：模糊卡仍保留 backdrop-filter blur': /blur\(8px\)/.test(out.local.cardBackdropFilter),
        '对照：首页视图仍有入场动画': out.local.homeViewAnimation === 'viewIn',
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
