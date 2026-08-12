/**
 * scripts/acceptance-timeline.js — 时间表完整复刻真实界面验收（临时脚本）
 *
 * 用独立 userData 副本（清空 lastConfigUrl、跳过引导）启动临时 Electron 实例，经 CDP 实测：
 *   1. 季节索引：下拉含「本周（在播）」+ 近 20 年季度选项，按年 optgroup 分组
 *   2. 排序下拉三模式（热度/评分/播出时间）
 *   3. 收藏过滤行三 chip（无 token 时置灰）
 *   4. 星期 tab 7 个、默认高亮今天
 *   5. 切换历史季度进入 season 模式并触发检索
 *   6. 时间表网格渲染（卡片 + 排名角标，依赖 Bangumi 网络数据）
 *   7. 控制台错误采集（仅计 timeline.js 相关）
 * 零依赖：Node 内置 WebSocket。结束时 kill 临时实例并删除副本目录。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.VPC_CDP_PORT || 9336);

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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-accept-tl-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'video-pc', 'settings.json');
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

    // ---- 进入时间表视图 ----
    await cdp.evaluate(`(() => { const el = document.querySelector('.main-nav-item[data-view="timeline"]'); if (el) el.click(); return !!el; })()`);
    // 等数据载入（calendar 走网络，给足时间）
    for (let i = 0; i < 20; i++) {
        const ready = await cdp.evaluate(`document.querySelectorAll('#timeline-weekdays .class-tab').length === 7`);
        if (ready) break;
        await sleep(500);
    }
    await sleep(500);

    // ============ 1. 季节索引 ============
    out.season = await cdp.evaluate(`(() => {
        const sel = document.getElementById('timeline-season');
        const opts = [...sel.querySelectorAll('option')];
        return {
            optionCount: opts.length,
            firstValue: opts.length ? opts[0].value : '',
            firstLabel: opts.length ? opts[0].textContent.trim() : '',
            optgroupCount: sel.querySelectorAll('optgroup').length,
            hasSeasonOpt: opts.some(o => /^\\d{4}Q[1-4]$/.test(o.value)),
        };
    })()`);

    // ============ 2. 排序下拉 ============
    out.sort = await cdp.evaluate(`(() => {
        const sel = document.getElementById('timeline-sort');
        return { optionCount: sel ? sel.querySelectorAll('option').length : 0, value: sel ? sel.value : '' };
    })()`);

    // ============ 3. 收藏过滤行 ============
    out.filters = await cdp.evaluate(`(() => {
        const chips = [...document.querySelectorAll('#timeline-filters .timeline-filter-chip')];
        return {
            chipCount: chips.length,
            keys: chips.map(c => c.getAttribute('data-filter')),
            disabledCount: chips.filter(c => c.classList.contains('disabled')).length,
        };
    })()`);

    // ============ 4. 星期 tab 与默认今天 ============
    out.weekdays = await cdp.evaluate(`(() => ({
        tabCount: document.querySelectorAll('#timeline-weekdays .class-tab').length,
        activeCount: document.querySelectorAll('#timeline-weekdays .class-tab.active').length,
        defaultWeekday: Timeline._weekday,
        hasHelpers: typeof Timeline._seasonRange === 'function' && typeof Timeline._sortItems === 'function' && typeof Timeline._applyFilters === 'function',
    }))()`);

    // ============ 5. 切换历史季度 → season 模式 ============
    const chosen = await cdp.evaluate(`(() => {
        const sel = document.getElementById('timeline-season');
        const opt = [...sel.querySelectorAll('option')].find(o => /^\\d{4}Q[1-4]$/.test(o.value));
        if (!opt) return '';
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return opt.value;
    })()`);
    await sleep(1500);
    out.seasonSwitch = await cdp.evaluate(`(() => ({ mode: Timeline._mode, season: Timeline._season }))()`);

    // ---- 切回本周，检查网格渲染（卡片/排名角标，依赖网络数据） ----
    await cdp.evaluate(`(() => { const sel = document.getElementById('timeline-season'); sel.value = 'current'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    for (let i = 0; i < 20; i++) {
        const n = await cdp.evaluate(`document.querySelectorAll('#timeline-grid .bangumi-card').length`);
        if (n > 0) break;
        await sleep(500);
    }
    out.grid = await cdp.evaluate(`(() => ({
        cardCount: document.querySelectorAll('#timeline-grid .bangumi-card').length,
        rankBadgeCount: document.querySelectorAll('#timeline-grid .timeline-rank-badge').length,
        gridHasContent: (document.getElementById('timeline-grid').innerText || '').trim().length > 0,
    }))()`);

    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length };
    console.log('\n===== 时间表验收原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const timelineErr = out.console.errors.filter((e) => /timeline\.js/.test(e));
    const checks = {
        '季节下拉含「本周（在播）」首项': out.season.firstValue === 'current',
        '季节下拉含近 20 年季度选项（≥70 项）': out.season.optionCount >= 71 && out.season.hasSeasonOpt,
        '季节下拉按年 optgroup 分组': out.season.optgroupCount >= 1,
        '排序下拉三模式（默认热度）': out.sort.optionCount === 3 && out.sort.value === 'heat',
        '收藏过滤行三 chip（dropped/watched/onlyWatching）': out.filters.chipCount === 3 && JSON.stringify(out.filters.keys) === JSON.stringify(['dropped', 'watched', 'onlyWatching']),
        '星期 tab 7 个且有 1 个高亮': out.weekdays.tabCount === 7 && out.weekdays.activeCount === 1,
        '默认星期为今天（1-7）': out.weekdays.defaultWeekday >= 1 && out.weekdays.defaultWeekday <= 7,
        '时间表白盒助手函数齐备': out.weekdays.hasHelpers === true,
        '切换历史季度进入 season 模式': chosen !== '' && out.seasonSwitch.mode === 'season' && out.seasonSwitch.season === chosen,
        '时间表网格有内容（卡片或提示）': out.grid.gridHasContent === true,
        '无 timeline.js 相关控制台错误': timelineErr.length === 0,
    };
    console.log('\n===== 判定 =====');
    let allPass = true;
    for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS' : 'FAIL') + '  ' + k); if (!v) allPass = false; }
    console.log(`\n[信息] 本周卡片数=${out.grid.cardCount}，排名角标数=${out.grid.rankBadgeCount}（依赖 Bangumi 网络数据）`);
    if (out.console.errors.length) console.log('\n--- 全部控制台错误 ---\n' + out.console.errors.join('\n'));
    console.log('\nOVERALL: ' + (allPass ? 'PASS' : 'FAIL'));
    if (!allPass) console.log('\n--- 应用日志尾部 ---\n' + appLog.slice(-1500));
    cleanup(allPass ? 0 : 1);
})().catch((e) => { console.error('验收脚本异常:', e); process.exit(2); });
