/**
 * scripts/acceptance-system.js — 系统类页面功能验收（临时脚本）
 *
 * 独立 userData 副本 + CDP 实测：
 *   1. 设置页：各分类导航与卡片渲染（外观/播放/快捷键/下载/缓存/扩展/源设置/Kazumi/系统/关于）
 *   2. Kazumi 规则页：规则列表渲染（18 条）、行控件
 *   3. 直播页：视图与容器（无直播源时引导态）
 *   4. 下载页：结构（输入/按钮/列表容器）
 *   5. 本地文件页：结构（根目录引导态）
 *   6. 直链页：输入与播放按钮
 *   7. 控制台错误采集
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9342);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-accept-sys-'));
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
    const nav = async (view) => { await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="${view}"]'); if (el) el.click(); return !!el; })()`); await sleep(700); };

    // ============ 1. 设置页各分类 ============
    await nav('settings');
    out.settings = await cdp.evaluate(`(() => {
        const cats = [...document.querySelectorAll('#settings-nav .settings-nav-item')].map(e => e.getAttribute('data-cat'));
        return { viewActive: !!document.querySelector('#view-settings.active'), cats };
    })()`);
    // 逐个点击分类，确认对应卡片出现
    out.settings.catCards = {};
    for (const cat of (out.settings.cats || [])) {
        await cdp.evaluate(`(() => { const el = document.querySelector('#settings-nav .settings-nav-item[data-cat="${cat}"]'); if (el) el.click(); return !!el; })()`);
        await sleep(400);
        const n = await cdp.evaluate(`document.querySelectorAll('#view-settings .tool-card[data-setcat="${cat}"]:not([style*="display: none"])').length || document.querySelectorAll('#view-settings .tool-card[data-setcat="${cat}"]').length`);
        out.settings.catCards[cat] = n;
    }

    // ============ 2. Kazumi 规则页（在设置 Kazumi 分类内） ============
    await cdp.evaluate(`(() => { const el = document.querySelector('#settings-nav .settings-nav-item[data-cat="kazumi"]'); if (el) el.click(); return !!el; })()`);
    for (let i = 0; i < 12; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#kazumi_rule_list .kazumi-rule-row').length`);
        if (n > 0) break;
        await sleep(400);
    }
    out.kazumi = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('#kazumi_rule_list .kazumi-rule-row')];
        return {
            ruleCount: rows.length,
            countBadge: (document.getElementById('kazumi_rule_count') || {}).textContent || '',
            rowHasToggle: rows.length ? !!rows[0].querySelector('.kazumi-rule-toggle') : false,
            rowHasEdit: rows.length ? !!rows[0].querySelector('.kazumi-rule-edit') : false,
            rowHasDel: rows.length ? !!rows[0].querySelector('.kazumi-rule-del') : false,
        };
    })()`);

    // ============ 3. 直播页 ============
    await nav('live');
    out.live = await cdp.evaluate(`(() => ({
        viewActive: !!document.querySelector('#view-live.active'),
        selectExists: !!document.getElementById('live-select'),
        groupsExist: !!document.getElementById('live-groups'),
        listExist: !!document.getElementById('live-list'),
    }))()`);

    // ============ 4. 下载页 ============
    await nav('downloads');
    out.downloads = await cdp.evaluate(`(() => ({
        viewActive: !!document.querySelector('#view-downloads.active'),
        uriInput: !!document.getElementById('dl-uri'),
        addBtn: !!document.getElementById('dl-add'),
        openDirBtn: !!document.getElementById('dl-open-dir'),
        listExist: !!document.getElementById('dl-list'),
    }))()`);

    // ============ 5. 本地文件页 ============
    await nav('tools');
    out.local = await cdp.evaluate(`(() => ({
        viewActive: !!document.querySelector('#view-tools.active'),
        panelExist: !!document.getElementById('tool-local'),
        fileListExist: !!document.getElementById('file_list'),
    }))()`);

    // ============ 6. 直链页 ============
    await nav('direct');
    out.direct = await cdp.evaluate(`(() => ({
        viewActive: !!document.querySelector('#view-direct.active'),
        urlInput: !!document.getElementById('direct_play_url'),
        playBtn: !!document.getElementById('direct_play_go'),
    }))()`);

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== 系统页验收原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const relatedErr = out.console.errors.filter((e) => /panels\.js|kazumi\.js|live\.js|downloads\.js|app\.js/.test(e));
    const expectedCats = ['appearance', 'play', 'hotkey', 'download', 'cache', 'asset', 'source', 'kazumi', 'system', 'about'];
    const catsOk = expectedCats.every((c) => (out.settings.cats || []).includes(c));
    const catCardsOk = Object.values(out.settings.catCards || {}).every((n) => n >= 1);
    const checks = {
        '设置页激活且 10 个分类导航齐全': out.settings.viewActive === true && catsOk,
        '设置页每个分类都有卡片渲染': catCardsOk,
        'Kazumi 规则列表渲染（≥1 条）': out.kazumi.ruleCount >= 1,
        'Kazumi 规则行含开关/编辑/删除控件': out.kazumi.rowHasToggle === true && out.kazumi.rowHasEdit === true && out.kazumi.rowHasDel === true,
        '直播页激活且容器齐全': out.live.viewActive === true && out.live.selectExists === true && out.live.listExist === true,
        '下载页激活且输入/按钮/列表齐全（含打开目录）': out.downloads.viewActive === true && out.downloads.uriInput === true && out.downloads.openDirBtn === true && out.downloads.listExist === true,
        '本地文件页激活且面板存在': out.local.viewActive === true && out.local.panelExist === true && out.local.fileListExist === true,
        '直链页激活且输入/播放按钮存在': out.direct.viewActive === true && out.direct.urlInput === true && out.direct.playBtn === true,
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
