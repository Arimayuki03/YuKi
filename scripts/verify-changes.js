/**
 * scripts/verify-changes.js — 对本次 23 项改动做真实界面实测（临时隔离实例 + CDP）
 *
 * 用独立 userData 副本（复制真实 settings：保留 lastConfigUrl 让站点自动载入、
 * 保留 bangumiToken 让 Bangumi 功能可用）以 --remote-debugging-port 启动临时
 * Electron 实例，经 CDP 实测：
 *   1. 应用启动、无 JS 控制台错误
 *   2. 新增设置控件齐全（2.4/2.8/2.9/2.10/2.11/3.1/3.2/4.1）
 *   3. 搜索页三页签切换（2.3）
 *   4. 历史记录：注入真实播放退出事件 → settings.history 记录次数/集名/时长（1.8）
 *   5. 观看统计：pos 缺失回退计次（1.4）
 *   6. 我的收藏页签与 6 状态标签栏（2.2）
 *   7. Kazumi 已安装规则排序按钮（2.5）
 *   8. 推荐页标签筛选（2.1，依赖网络，仅报告）
 *   9. 二级详情返回（1.1，依赖网络，仅报告）
 * 结束自动 kill 临时实例并删除副本目录，不影响真实数据。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9340);

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
    constructor(url) { this.url = url; this.id = 0; this.pend = new Map(); this.handlers = []; this.errors = []; this.console = []; }
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
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-verify-'));
    const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-verify-cache-'));
    const srcSettings = path.join(process.env.APPDATA || '', 'yuki', 'settings.json');
    try {
        const s = JSON.parse(fs.readFileSync(srcSettings, 'utf8'));
        s.onboarded = true; s.wallpaper = ''; s.lastSourceMap = {};
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify(s, null, 2), 'utf8');
    } catch (e) {
        fs.writeFileSync(path.join(tmpUserData, 'settings.json'), JSON.stringify({ onboarded: true }, null, 2), 'utf8');
    }

    const electronArgs = [ROOT, '--remote-debugging-port=' + PORT, '--user-data-dir=' + tmpUserData, '--no-first-run'];
    const child = spawn(ELECTRON, electronArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, YUKI_CACHE_DIR: tmpCache }, // 隔离后端缓存，避免碰真实 ~/.yuki/cache
    });
    let appLog = '';
    child.stdout.on('data', (d) => { appLog += d.toString(); });
    child.stderr.on('data', (d) => { appLog += d.toString(); });

    const cleanup = (code) => {
        try { child.kill('SIGKILL'); } catch (e) { }
        setTimeout(() => { try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (e) { } }, 800);
        setTimeout(() => { try { fs.rmSync(tmpCache, { recursive: true, force: true }); } catch (e) { } }, 800);
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
        if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
            const txt = (m.params.args || []).map((a) => (a.value !== undefined ? a.value : (a.description || a.type))).join(' ');
            (m.params.type === 'error' ? cdp.errors : cdp.console).push(String(txt).slice(0, 300));
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
    // 等后端就绪 + 站点载入（lastConfigUrl 自动重载，网络可用时较快）
    await new Promise((r) => setTimeout(r, 5000));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const out = {};
    const checks = [];

    // ============ 1. 应用启动 + 无 JS 错误 ============
    out.boot = await cdp.evaluate(`(() => ({
        homeActive: !!document.querySelector('#view-home.active'),
        appReady: !!document.querySelector('.main-nav-item'),
        siteCount: document.querySelectorAll('#site-select option').length,
        backendBase: (typeof window.yuki !== 'undefined') ? 'ok' : 'missing',
    }))()`);

    // ============ 2. 新增设置控件齐全 ============
    const needIds = ['set_startup_view', 'set_error_toast', 'set_use_misans', 'set_proxy_url', 'set_proxy_enable',
        'set_dl_split', 'bangumi_token_link', 'bangumi_sync_priority', 'bangumi_immediate_toast', 'bangumi_sync_now',
        'webdav_enable', 'webdav_enable_history', 'webdav_enable_collect', 'webdav_save',
        'set_bangumi_mirror', 'set_git_mirror', 'search-tabs', 'image-search-panel', 'popular-tags', 'log-clear'];
    out.settingsControls = await cdp.evaluate(`(() => {
        const ids = ${JSON.stringify(needIds)};
        const missing = ids.filter((id) => !document.getElementById(id));
        return { total: ids.length, missing };
    })()`);

    // ============ 3. 搜索页三页签切换（2.3） ============
    out.searchTabs = await cdp.evaluate(`(async () => {
        const sNav = document.querySelector('.main-nav-item[data-view="search"]');
        if (sNav) sNav.click();
        await new Promise(r => setTimeout(r, 300));
        const stab = (name) => document.querySelector('#search-tabs [data-stab="'+name+'"]');
        const aggVisible = () => document.getElementById('search-bar-agg').offsetParent !== null;
        const imgVisible = () => document.getElementById('image-search-panel').offsetParent !== null;
        const base = { agg: aggVisible(), img: imgVisible() };
        stab('image').click();
        await new Promise(r => setTimeout(r, 150));
        const afterImage = { agg: aggVisible(), img: imgVisible() };
        stab('kazumi').click();
        await new Promise(r => setTimeout(r, 150));
        const afterKazumi = { agg: aggVisible(), img: imgVisible() };
        stab('aggregate').click();
        await new Promise(r => setTimeout(r, 150));
        const afterAgg = { agg: aggVisible(), img: imgVisible() };
        return { base, afterImage, afterKazumi, afterAgg };
    })()`, true);

    // ============ 4. 历史记录：注入真实播放退出 → history 记录（1.8） ============
    out.history = await cdp.evaluate(`(async () => {
        const before = ((await window.yuki.settingsGet()) || {}).history || [];
        const beforeLen = before.length;
        Player._curMeta = { site: 'site-x', vodId: 'vod-x', title: '实测影片', subtitle: '第 1 集' };
        Player._rememberSession({ ok: true, sessionId: 9101 });
        Player._recordWatch({ sessionId: 9101, pos: 60, duration: 120 });
        await Player._watchWrite;
        const h = ((await window.yuki.settingsGet()) || {}).history || [];
        const it = h.find(x => x.vodId === 'vod-x');
        return {
            added: h.length - beforeLen,
            playCount: it ? it.playCount : 0,
            lastEpisode: it ? it.lastEpisode : '',
            lastDuration: it ? it.lastDuration : 0,
        };
    })()`, true);

    // ============ 5. 观看统计：pos 缺失回退计次（1.4） ============
    out.watchFallback = await cdp.evaluate(`(async () => {
        const s0 = ((await window.yuki.settingsGet()) || {});
        const b = (s0.watchStats || { sessionCount: 0, titles: {} });
        const beforeCount = b.sessionCount || 0;
        Player._curMeta = { title: '实测无进度' };
        Player._rememberSession({ ok: true, sessionId: 9102 });
        Player._recordWatch({ sessionId: 9102, pos: null, duration: null });
        await Player._watchWrite;
        const s1 = ((await window.yuki.settingsGet()) || {}).watchStats || {};
        return { deltaCount: (s1.sessionCount || 0) - beforeCount, titleCount: (s1.titles || {})['实测无进度'] || 0 };
    })()`, true);

    // ============ 6. 我的收藏页签 + 6 状态标签（2.2） ============
    out.myFav = await cdp.evaluate(`(async () => {
        const myNav = document.querySelector('.main-nav-item[data-view="my"]');
        if (myNav) myNav.click();
        await new Promise(r => setTimeout(r, 400));
        const tab = document.querySelector('#view-my [data-my-tab="favorites"]');
        if (tab) tab.click();
        await new Promise(r => setTimeout(r, 500));
        const tags = [...document.querySelectorAll('#my-favorites-tags .class-tab')].map(t => t.getAttribute('data-tag'));
        const cards = document.querySelectorAll('#my-favorites-grid .vod-card').length;
        return { tags, cards, hasSyncBtn: !!document.getElementById('my-favorites-bgm-sync') };
    })()`, true);

    // ============ 7. Kazumi 规则排序按钮（2.5） ============
    out.rules = await cdp.evaluate(`(async () => {
        const sNav = document.querySelector('.main-nav-item[data-view="settings"]');
        if (sNav) sNav.click();
        await new Promise(r => setTimeout(r, 300));
        const kazumiNav = document.querySelector('#settings-nav [data-cat="kazumi"]');
        if (kazumiNav) kazumiNav.click();
        await new Promise(r => setTimeout(r, 800));
        return {
            rows: document.querySelectorAll('#kazumi_rule_list .kazumi-rule-row').length,
            moveBtns: document.querySelectorAll('#kazumi_rule_list .kazumi-rule-move').length,
            draggable: document.querySelectorAll('#kazumi_rule_list .kazumi-rule-row[draggable="true"]').length,
        };
    })()`, true);

    // ============ 8. 推荐页标签筛选（2.1；网络不可达时用离线注入验证 UI 逻辑） ============
    out.popular = await cdp.evaluate(`(async () => {
        const pNav = document.querySelector('.main-nav-item[data-view="popular"]');
        if (pNav) pNav.click();
        for (let i = 0; i < 20; i++) {
            if (document.querySelectorAll('#popular-grid .bangumi-card').length) break;
            await new Promise(r => setTimeout(r, 500));
        }
        const liveCards = document.querySelectorAll('#popular-grid .bangumi-card').length;
        if (!liveCards) {
            // 离线：注入假数据验证标签筛选 UI（2.1）
            Popular._items = [
                { id: 1, name: '番剧A', tags: [{ name: '奇幻', count: 5 }, { name: '冒险', count: 3 }] },
                { id: 2, name: '番剧B', tags: [{ name: '恋爱', count: 4 }] },
            ];
            Popular._tag = '';
            Popular._renderTags();
            Popular._renderGrid();
            const chipCount = document.querySelectorAll('#popular-tags .class-tab').length;
            const fantasy = document.querySelector('#popular-tags .class-tab[data-tag="奇幻"]');
            if (fantasy) fantasy.click();
            const filtered = document.querySelectorAll('#popular-grid .bangumi-card').length;
            const names = [...document.querySelectorAll('#popular-grid .bangumi-card .vod-name')].map(n => n.textContent.trim());
            return { liveCards, offline: { chipCount, filtered, names } };
        }
        return { liveCards, tagChips: document.querySelectorAll('#popular-tags .class-tab').length };
    })()`, true);

    // ============ 9. 二级详情返回（1.1，网络） ============
    try {
        out.navBack = await cdp.evaluate(`(async () => {
            const card = document.querySelector('#popular-grid .bangumi-card');
            if (!card) return { skipped: '网络不可达 Bangumi，无卡片可测（返回逻辑已有单测覆盖）' };
            card.click();
            for (let i = 0; i < 20; i++) {
                if (document.querySelector('#view-bangumi-info.active') && document.querySelector('#bangumi-info-body .bangumi-info-card')) break;
                await new Promise(r => setTimeout(r, 500));
            }
            const infoActive = !!document.querySelector('#view-bangumi-info.active');
            const back = document.getElementById('bangumi-info-back');
            if (back) back.click();
            await new Promise(r => setTimeout(r, 300));
            return { infoActive, backToPopular: App.currentView === 'popular', currentView: App.currentView };
        })()`, true);
    } catch (e) { out.navBack = { error: String(e).slice(0, 200) }; }

    // ============ 10. 控制台错误 ============
    await sleep(500);
    out.console = { errors: cdp.errors.slice(0, 20), errorCount: cdp.errors.length, warnings: cdp.console.slice(0, 10), warningCount: cdp.console.length };

    console.log('\n===== 真实界面实测原始结果 =====');
    console.log(JSON.stringify(out, null, 2));

    const related = out.console.errors.filter((e) => /app\.js|kazumi\.js|records\.js|player\.js|search\.js|my\.js|common\.js|panels\.js|popular\.js/.test(e));
    const define = (k, ok, note) => { checks.push([k, !!ok, note]); };

    define('应用启动且首页激活', out.boot.homeActive && out.boot.appReady && out.boot.backendBase === 'ok', JSON.stringify(out.boot));
    define('新增设置控件齐全（20/20）', out.settingsControls.missing.length === 0, 'missing=' + JSON.stringify(out.settingsControls.missing));
    define('搜索页三页签切换（聚合/Kazumi/以图搜番）',
        out.searchTabs.base.agg && !out.searchTabs.base.img
        && out.searchTabs.afterImage.img && !out.searchTabs.afterImage.agg
        && out.searchTabs.afterKazumi.agg && !out.searchTabs.afterKazumi.img
        && out.searchTabs.afterAgg.agg && !out.searchTabs.afterAgg.img,
        JSON.stringify(out.searchTabs));
    define('历史记录：注入播放退出后 history 新增并记录次数/集名/时长', out.history.added >= 1 && out.history.playCount === 1 && out.history.lastEpisode === '第 1 集' && out.history.lastDuration === 60, JSON.stringify(out.history));
    define('观看统计：pos 缺失仍计 1 次/1 部', out.watchFallback.deltaCount === 1 && out.watchFallback.titleCount === 1, JSON.stringify(out.watchFallback));
    define('我的收藏：6 状态标签 + 同步按钮', out.myFav.tags.length === 6 && out.myFav.hasSyncBtn, JSON.stringify(out.myFav));
    define('Kazumi 规则列表含排序按钮且可拖拽', out.rules.rows > 0 && out.rules.moveBtns >= 2 && out.rules.draggable > 0, JSON.stringify(out.rules));
    // 推荐页标签筛选：在线有卡片则看真实 chips；网络不可达则用离线注入验证（2.1）
    if (out.popular.liveCards > 0) {
        define('推荐页标签筛选（真实网络）', out.popular.tagChips > 0, JSON.stringify(out.popular));
    } else {
        define('推荐页标签筛选（离线注入验证 UI 逻辑）', out.popular.offline && out.popular.offline.chipCount > 0 && out.popular.offline.filtered === 1, JSON.stringify(out.popular));
    }
    // 二级详情返回（1.1）：网络不可达时跳过（不判 FAIL）
    if (out.navBack.skipped) {
        console.log('SKIP  二级详情返回回到推荐页（网络）：' + out.navBack.skipped);
    } else {
        define('二级详情返回回到推荐页（网络）', out.navBack.backToPopular === true, JSON.stringify(out.navBack));
    }
    define('无本轮相关 JS 控制台错误', related.length === 0, 'errors=' + related.length);

    console.log('\n===== 判定 =====');
    let allPass = true;
    for (const [k, ok, note] of checks) {
        const tag = ok ? 'PASS' : 'FAIL';
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + k);
        if (note) console.log('       ' + String(note).slice(0, 220));
        if (!ok) allPass = false;
    }
    if (out.console.errors.length) console.log('\n--- 全部控制台错误 ---\n' + out.console.errors.join('\n'));
    console.log('\nOVERALL: ' + (allPass ? 'PASS' : 'FAIL'));
    if (!allPass) console.log('\n--- 应用日志尾部 ---\n' + appLog.slice(-1500));
    cleanup(allPass ? 0 : 1);
})().catch((e) => { console.error('验证脚本异常:', e); process.exit(2); });
