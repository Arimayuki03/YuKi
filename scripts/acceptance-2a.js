/**
 * scripts/acceptance-2a.js — 2A 实际界面验收（临时脚本）
 *
 * 用独立 userData 副本（清空 lastConfigUrl，避免启动 auto-reload 拉站点/弹窗）
 * 以 --remote-debugging-port 启动临时 Electron 实例，经 CDP 实测 PROGRESS.md §4
 * 的 2A 验收项：
 *   1. 设置导航顺序：设置位于左侧功能项末尾(order 98)、收缩按钮在其下(order 99)
 *   2. 关于分类：设置内「关于」渲染版本号与系统信息
 *   3. 系统页：无画中画控件、无版本号
 *   4. 页面：MiSans 内置字体打包内置（file:// 注入 <link>，非网络下载；T61 起方向由移除改为内置）
 *   5. 控制台错误采集
 * 零依赖：使用 Node 24 内置 WebSocket。结束时 kill 临时实例并删除副本目录。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.VPC_CDP_PORT || 9333);

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
    // ---- 准备独立 userData（复制设置但清空 lastConfigUrl / configHistory，禁用壁纸） ----
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-accept-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'video-pc', 'settings.json');
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        s.lastConfigUrl = '';
        s.configHistory = [];
        s.wallpaper = '';
        s.onboarded = true; // 跳过首次引导
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(s, null, 2), 'utf8');
    } catch (e) { /* 无设置则以全新态运行 */ }

    const electronArgs = [ROOT, '--remote-debugging-port=' + PORT, '--user-data-dir=' + tmpUserData, '--no-first-run'];
    console.log('[accept] userData =', tmpUserData);
    console.log('[accept] launching electron on port', PORT);
    const child = spawn(ELECTRON, electronArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let appLog = '';
    child.stdout.on('data', (d) => { appLog += d.toString(); });
    child.stderr.on('data', (d) => { appLog += d.toString(); });

    const cleanup = (code) => {
        try { child.kill('SIGKILL'); } catch (e) { }
        // 清理临时 userData（尽力而为）
        setTimeout(() => { try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (e) { } }, 800);
        process.exit(code);
    };
    process.on('SIGINT', () => cleanup(130));

    // ---- 等待 CDP 就绪 ----
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
    console.log('[accept] page =', page.url);

    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.on((m) => {
        if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
            const txt = (m.params.args || []).map((a) => (a.value !== undefined ? a.value : (a.description || a.type))).join(' ');
            (m.params.type === 'error' ? cdp.errors : cdp.console).push(String(txt).slice(0, 300));
        }
        if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            cdp.errors.push('EXCEPTION: ' + (((d.exception && d.exception.description) || d.text) + '').slice(0, 300));
        }
    });

    // ---- 等渲染层就绪 ----
    for (let i = 0; i < 40; i++) {
        try { if (await cdp.evaluate('document.readyState') === 'complete') break; } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 2500)); // 等启动链路（后端就绪/渲染）
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const out = {};

    // ============ 1. 导航顺序（真实几何排序，非 DOM 序） ============
    out.navOrder = await cdp.evaluate(`(() => {
        const nav = document.querySelector('#main-nav');
        const items = [...document.querySelectorAll('.main-nav-item[data-view]')];
        const settings = items.find(el => el.getAttribute('data-view') === 'settings');
        const collapse = document.querySelector('.nav-collapse-btn');
        // 真实几何排序：按渲染后 top 坐标
        const sortedByTop = [...items].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
            .map(el => el.getAttribute('data-view'));
        const settingsRect = settings ? settings.getBoundingClientRect() : null;
        const collapseRect = collapse ? collapse.getBoundingClientRect() : null;
        // 其余功能项（不含 settings）的最大 bottom
        const others = items.filter(el => el.getAttribute('data-view') !== 'settings');
        const othersMaxBottom = Math.max(...others.map(el => el.getBoundingClientRect().bottom));
        const cs = settings ? getComputedStyle(settings) : null;
        const cc = collapse ? getComputedStyle(collapse) : null;
        return {
            domOrder: items.map(el => el.getAttribute('data-view')),
            sortedByTop,
            settingsExists: !!settings,
            settingsOrder: cs ? cs.order : null,
            settingsVisuallyLastOfNavItems: sortedByTop.length ? sortedByTop[sortedByTop.length - 1] === 'settings' : false,
            settingsBelowAllOthers: settingsRect ? settingsRect.top >= othersMaxBottom - 1 : false,
            collapseExists: !!collapse,
            collapseOrder: cc ? cc.order : null,
            collapseBelowSettings: (settingsRect && collapseRect) ? collapseRect.top >= settingsRect.top : false,
            collapseAtNavBottom: (collapseRect && nav) ? Math.abs(collapseRect.bottom - nav.getBoundingClientRect().bottom) < 60 : false,
            aboutNavExists: !!document.querySelector('.main-nav-item[data-view="about"]'),
            aboutViewExists: !!document.querySelector('#view-about'),
        };
    })()`);

    // ============ 2. 系统分类：无画中画 / 无版本号（先切到设置→系统） ============
    await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="settings"]'); if (el) el.click(); return !!el; })()`);
    await sleep(600);
    await cdp.evaluate(`(() => { const el = document.querySelector('#settings-nav .settings-nav-item[data-cat="system"]'); if (el) el.click(); return !!el; })()`);
    await sleep(700);
    out.systemPage = await cdp.evaluate(`(() => {
        // 系统分类 = #view-settings 下 data-setcat="system" 的可见卡片
        const sysCards = [...document.querySelectorAll('#view-settings .tool-card[data-setcat="system"]')].filter(c => c.offsetParent !== null);
        const sysText = sysCards.map(c => c.innerText || '').join('\\n');
        const pipEls = [...document.querySelectorAll('#view-settings [id*="pip" i], #view-settings [class*="pip" i]')].map(e => e.id || e.className);
        // 版本号控件只应出现在关于分类，不应出现在系统分类
        const sysHasVersionEl = sysCards.some(c => c.querySelector('#app_version, #about-version, [data-version]'));
        return {
            settingsViewExists: !!document.querySelector('#view-settings'),
            systemCardCount: sysCards.length,
            pipElementCount: pipEls.length,
            pipEls: pipEls.slice(0, 5),
            systemTextHasPip: /画中画/.test(sysText),
            systemTextHasVersionLabel: /版本/.test(sysText),
            sysHasVersionEl,
            systemSnippet: sysText.replace(/\\s+/g, ' ').slice(0, 300),
        };
    })()`);

    // ============ 3. 设置 → 关于分类 ============
    // （已在系统分类步骤切到设置视图，这里直接点关于）
    const aboutClicked = await cdp.evaluate(`(() => {
        const about = document.querySelector('#settings-nav .settings-nav-item[data-cat="about"]');
        if (about) { about.click(); return 'settings-nav'; }
        const any = [...document.querySelectorAll('[data-cat]')].find(e => e.getAttribute('data-cat') === 'about');
        if (any) { any.click(); return 'data-cat'; }
        return false;
    })()`);
    await sleep(1200); // 关于分类可能异步拉 vpc:app-info
    out.about = await cdp.evaluate(`(() => {
        // 关于分类 = #view-settings 下 data-setcat="about" 的卡片
        const aboutCards = [...document.querySelectorAll('#view-settings .tool-card[data-setcat="about"]')].filter(c => c.offsetParent !== null);
        const text = aboutCards.map(c => c.innerText || '').join('\\n');
        const versionElText = (document.querySelector('#about-version') || {}).innerText || '';
        const sysinfoText = (document.querySelector('#about-sysinfo') || {}).innerText || '';
        const versionMatch = (versionElText + ' ' + text).match(/v?([0-9]+\\.[0-9]+\\.[0-9]+)/);
        return {
            clickedAbout: ${JSON.stringify(aboutClicked)},
            aboutCardCount: aboutCards.length,
            versionElText: versionElText.trim(),
            versionText: versionMatch ? versionMatch[0].trim() : null,
            hasElectron: /Electron/i.test(sysinfoText + ' ' + text),
            hasChromium: /Chromium|Chrome/i.test(sysinfoText + ' ' + text),
            hasNode: /Node/i.test(sysinfoText + ' ' + text),
            hasPlatform: /操作系统|platform|win32|Windows/i.test(sysinfoText + ' ' + text),
            snippet: text.replace(/\\s+/g, ' ').slice(0, 400),
        };
    })()`);

    // ============ 4. 页面无 MiSans 动态注入 ============
    out.font = await cdp.evaluate(`(() => {
        const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.href);
        const misansLinks = links.filter(h => /misans/i.test(h));
        const styleText = [...document.querySelectorAll('style')].map(s => s.textContent).join('\\n');
        const hasFontFaceInject = /@font-face[^}]*MiSans/i.test(styleText);
        return {
            stylesheetLinks: links,
            misansLinkCount: misansLinks.length,
            misansLinks,
            hasFontFaceInject,
            rootFontFamily: getComputedStyle(document.documentElement).fontFamily,
        };
    })()`);

    // ============ 5. 控制台错误 ============
    await sleep(500);
    out.console = { errors: cdp.errors, errorCount: cdp.errors.length, warnings: cdp.console.slice(0, 10), warningCount: cdp.console.length };

    console.log('\n===== 2A 验收原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const checks = {
        '设置视觉位于功能项末尾(几何排序最后 + order 98)': out.navOrder.settingsVisuallyLastOfNavItems && out.navOrder.settingsBelowAllOthers && out.navOrder.settingsOrder === '98',
        '收缩按钮在设置之下(order 99 + 视觉在设置下方/贴导航底)': out.navOrder.collapseExists && out.navOrder.collapseOrder === '99' && out.navOrder.collapseBelowSettings && out.navOrder.collapseAtNavBottom,
        '左侧无独立关于入口/视图': !out.navOrder.aboutNavExists && !out.navOrder.aboutViewExists,
        '系统页无画中画': out.systemPage.pipElementCount === 0 && !out.systemPage.systemTextHasPip,
        '系统页无版本号': !out.systemPage.systemTextHasVersionLabel && !out.systemPage.sysHasVersionEl,
        '关于分类渲染版本号': out.about.aboutCardCount >= 1 && !!out.about.versionText && out.about.versionText !== '-',
        '关于分类渲染系统信息': out.about.hasElectron || out.about.hasChromium || out.about.hasNode,
        'MiSans 内置字体已加载（file:// 打包内置，非网络下载）': out.font.misansLinkCount >= 1 && out.font.misansLinks.every((h) => h.startsWith('file://')),
        '无控制台错误': out.console.errorCount === 0,
    };
    console.log('\n===== 判定 =====');
    let allPass = true;
    for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS' : 'FAIL') + '  ' + k); if (!v) allPass = false; }
    console.log('\nOVERALL: ' + (allPass ? 'PASS' : 'FAIL'));
    if (!allPass) console.log('\n--- 应用日志尾部 ---\n' + appLog.slice(-1500));
    cleanup(allPass ? 0 : 1);
})().catch((e) => { console.error('验收脚本异常:', e); process.exit(2); });
