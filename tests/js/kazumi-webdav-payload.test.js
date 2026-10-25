/**
 * 白盒单元测试：WebDAV 同步载荷（内容升级 + 版本标识 + 兼容恢复）。
 *
 * 覆盖三件事：
 * 1. 三张表的静态一致性（源码级断言，加载方式同 kazumi-alias.test.js：node:vm 注入
 *    全局桩后取 Kazumi 执行真实函数）：
 *    - WEBDAV_RESTORE_ALLOWED 与 WEBDAV_SETTINGS_EXCLUDE / WEBDAV_RESTORE_DENIED 无交集；
 *    - 主进程 SETTINGS_SET_ALLOWED（src/main/index.js）里的每个键都被三表之一覆盖，
 *      即自己的备份不会在恢复时冒出「未知键」；且允许表 ⊆ 主进程白名单（否则
 *      settingsSet 被静默 ignored，恢复看着成功实则没落盘）；
 *    - 本版新增键确实进了同步范围/允许表，机器相关键确实被排除。
 * 2. 载荷组装：子开关裁剪 + 设置快照把新键带上、把机器态/凭据/webDav* 剔掉。
 * 3. 恢复容错：旧备份（无 _meta）按 v1 恢复、缺键保留本地、未知键忽略并上报、
 *    已知拒绝键静默忽略不计入上报、类型不符跳过且不影响其它键、单键失败不拖垮整批、
 *    非法 scheme 拒绝 / 内网地址放行。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = read('src/renderer/js/kazumi.js');
const MAIN_SRC = read('src/main/index.js');
const HTML = read('src/renderer/index.html');

/** 摊平沙箱对象（跨 realm deepEqual 会挂在原型上）。 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** 从源码里取 `const NAME = new Set([...])` 的字符串项（不执行脚本，纯文本）。 */
function tableOf(name, src = SRC) {
    const head = `const ${name} = new Set([`;
    const i = src.indexOf(head);
    assert.ok(i >= 0, `未找到 ${name}`);
    const j = src.indexOf(']);', i);
    return src.slice(i + head.length, j).match(/'[A-Za-z0-9_]+'/g).map((s) => s.slice(1, -1));
}

/** 取函数体文本（从 `签名` 到下一个顶格 `};`/`}` 之前的粗略切分，够用于文本断言）。 */
function bodyOf(signature, src = SRC, span = 4000) {
    const i = src.indexOf(signature);
    assert.ok(i >= 0, `未找到 ${signature}`);
    return src.slice(i, i + span);
}

// ---------------------------------------------------------------- 通用桩

function makeJq() {
    const nodes = new Map();
    function node(sel) {
        if (!nodes.has(sel)) {
            nodes.set(sel, {
                sel, length: 1, handlers: {},
                on(ev, a, b) { const fn = typeof a === 'function' ? a : b; (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; },
                off() { return this; }, html() { return this; }, text() { return this; },
                find() { return this; }, filter() { return this; }, closest() { return this; },
                each() { return this; }, data() { return undefined; },
                val() { return ''; }, prop() { return this; }, attr() { return this; },
                trigger() { return this; }, remove() { return this; }, appendTo() { return this; },
                toggle() { return this; }, show() { return this; }, hide() { return this; }, is() { return false; },
            });
        }
        return nodes.get(sel);
    }
    const $ = (arg) => (arg && typeof arg === 'object' ? arg : node(String(arg)));
    $.nodes = nodes;
    return $;
}

/** 加载 kazumi.js（通用桩）。writes 记录 settingsSet/recSet 的落盘。 */
function loadKazumi(opts = {}) {
    const $ = makeJq();
    const settingsValue = opts.settings || {};
    const writes = [];
    const toasts = [];
    const logs = [];
    const actions = [];
    const ctx = {
        console: {
            log: (...a) => logs.push({ level: 'log', args: a }),
            warn: (...a) => logs.push({ level: 'warn', args: a }),
            error: (...a) => logs.push({ level: 'error', args: a }),
        },
        Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, RegExp, URL,
        parseInt, parseFloat, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
        document: { body: {}, addEventListener() { }, removeEventListener() { }, getElementById: () => null },
        MutationObserver: function () { this.observe = () => { }; },
        EventSource: function () { this.close = () => { }; this.addEventListener = () => { }; },
        $, openDialog: () => { }, closeDialog: () => { },
        escHtml: (s) => String(s == null ? '' : s),
        warnToast: (m) => toasts.push(String(m)),
        showLoading: () => { }, hideLoading: () => { },
        apiUrl: (u) => u,
        confirmDialog: async () => true,
        applySkin: () => { },
        recSet: async (k, v) => { writes.push({ key: k, value: plain(v) }); },
        SettingsSnapshot: { invalidate() { } },
        doAction: (action, kv) => {
            actions.push({ action, kv });
            const table = opts.responses || {};
            // 未显式给出响应时按「成功」兜底：便于只测载荷组装的用例不为响应操心
            const rsp = (action in table) ? table[action] : { code: 200 };
            return Promise.resolve(rsp);
        },
        window: {
            yuki: {
                settingsGet: async () => settingsValue,
                settingsSet: async (k, v) => {
                    if (opts.failKeys && opts.failKeys.includes(k)) throw new Error('write failed');
                    if (opts.ignoredKeys && opts.ignoredKeys.includes(k)) return { value: undefined, ignored: true };
                    writes.push({ key: k, value: plain(v) });
                    return { value: v };
                },
            },
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(`${SRC}\n;globalThis.__testKazumi = Kazumi;`, ctx, { filename: 'kazumi.js' });
    const kazumi = ctx.__testKazumi;
    kazumi.hasEnabledRules = () => true;
    return { kazumi, ctx, $, writes, toasts, logs, actions, settingsValue };
}

/** 找一个键最后一次写入的值。 */
const lastWrite = (writes, key) => writes.filter((w) => w.key === key).pop();

// ---------------------------------------------------------------- 1. 表一致性

test('三张表：允许表与排除表/拒绝表无交集，且排除表内部无重复', () => {
    const allowed = tableOf('WEBDAV_RESTORE_ALLOWED');
    const exclude = tableOf('WEBDAV_SETTINGS_EXCLUDE');
    const denied = tableOf('WEBDAV_RESTORE_DENIED');
    assert.ok(allowed.length > 60, `允许表应有足够规模，实际 ${allowed.length}`);
    assert.deepEqual(allowed.filter((k) => exclude.includes(k)), [],
        '允许表与排除表交集非空：既不上传又能恢复 = 死键/自相矛盾');
    assert.deepEqual(allowed.filter((k) => denied.includes(k)), [],
        '允许表与拒绝表交集非空：同一键既恢复又拒绝');
    [['WEBDAV_SETTINGS_EXCLUDE', exclude], ['WEBDAV_RESTORE_ALLOWED', allowed],
    ['WEBDAV_RESTORE_DENIED', denied]].forEach(([n, arr]) => {
        assert.deepEqual(arr.filter((k, i) => arr.indexOf(k) !== i), [], `${n} 内有重复项`);
    });
});

test('主进程白名单全覆盖：已知设置键都落在三表之一，允许表全部可写', () => {
    // SETTINGS_SET_ALLOWED 是「本机可能存在的设置键」的权威清单（渲染层写入口）
    const allowed = tableOf('WEBDAV_RESTORE_ALLOWED');
    const exclude = tableOf('WEBDAV_SETTINGS_EXCLUDE');
    const denied = tableOf('WEBDAV_RESTORE_DENIED');
    const mainKeys = tableOf('SETTINGS_SET_ALLOWED', MAIN_SRC);
    assert.ok(mainKeys.length > 100, `主进程白名单应有足够规模，实际 ${mainKeys.length}`);

    const uncovered = mainKeys.filter((k) => !exclude.includes(k) && !allowed.includes(k) && !denied.includes(k));
    assert.deepEqual(uncovered, [],
        '这些键既不在排除表也不在允许/拒绝表：恢复自己的备份时会被当成「未知键」上报');

    const notWritable = allowed.filter((k) => !mainKeys.includes(k));
    assert.deepEqual(notWritable, [],
        '允许表里的键主进程未放行：恢复时 settingsSet 被静默 ignored（看着成功实则没落盘）');
});

test('本版新增键：进同步范围与允许表；机器相关键进排除表', () => {
    const allowed = tableOf('WEBDAV_RESTORE_ALLOWED');
    const exclude = tableOf('WEBDAV_SETTINGS_EXCLUDE');
    const denied = tableOf('WEBDAV_RESTORE_DENIED');

    // 用户数据/偏好：纳入恢复
    ['searchHistory', 'kazumiAliasMap', 'favoritesSort', 'favoritesFilter',
        'historySort', 'historyFilter'].forEach((k) => {
        assert.ok(allowed.includes(k), `${k} 应在恢复允许表内`);
        assert.ok(!exclude.includes(k), `${k} 不应在排除表内（用户数据应随设置快照上传）`);
    });
    // 补漏的纯偏好键（此前上传了却恢复不了）
    ['opEdSkip', 'opEdSave', 'translateEnable', 'translateTrigger', 'translateTarget',
        'translateLLMEnable', 'translateLLMModel', 'kazumiAutoUpdateOnStart'].forEach((k) => {
        assert.ok(allowed.includes(k), `${k} 应在恢复允许表内`);
    });
    // 机器相关/敏感键：上传与恢复双向排除
    ['bangumiLastSyncAt', 'bangumiToken', 'dandanAppSecret', 'translateLLMKey', 'captchaLLMKey',
        'mpvPath', 'externalPlayerPath', 'cacheDir', 'dlDir', 'wallpaper', 'settingsCat',
        'onboarded', 'logLastCleanupAt'].forEach((k) => {
        assert.ok(exclude.includes(k), `${k} 应在排除表内`);
        assert.ok(denied.includes(k), `${k} 应在拒绝表内（外来快照携带时也不能恢复）`);
        assert.ok(!allowed.includes(k), `${k} 不应在允许表内`);
    });
    // webDav* 自身全量排除（URL/凭据/远程目录/证书/自动同步/启动拉取/子开关）
    ['webDavUrl', 'webDavUsername', 'webDavPassword', 'webDavRemoteDir', 'webDavSslSkip',
        'webDavStartupPull', 'webDavAutoEnable', 'webDavAutoMinutes', 'webDavEnable',
        'webDavEnableCollect', 'webDavEnableHistory', 'webDavEnableRules',
        'webDavEnableSettings', 'webDavEnableStats'].forEach((k) => {
        assert.ok(exclude.includes(k), `${k} 应在排除表内（本机怎么连远端，机器绑定）`);
        assert.ok(!allowed.includes(k), `${k} 不应在允许表内`);
    });
    // 敏感 URL/连接目标类：上传与恢复双向排除——恢复侧拒绝它们是防云端快照改写
    // 本机连接目标；上传侧也排除是防本机私有地址/凭据被写进云端（proxyUrl 可能
    // 内嵌 user:pass，配置源 URL 可能带私有 token）。
    ['lastConfigUrl', 'configHistory', 'probeSourceUrl', 'proxyUrl', 'proxyTestUrl',
        'bangumiMirrorRoot', 'proxyEnable'].forEach((k) => {
        assert.ok(exclude.includes(k), `${k} 应在排除表内（不上传）`);
        assert.ok(denied.includes(k), `${k} 应在拒绝表内`);
        assert.ok(!allowed.includes(k), `${k} 不应在允许表内`);
    });
    // LLM Base（服务地址）是唯一刻意保留上传的 URL 类键：仅用于跨设备诊断，
    // 恢复侧仍拒绝（见 kazumi.js 排除表注释）。
    ['translateLLMBase', 'captchaLLMBase'].forEach((k) => {
        assert.ok(denied.includes(k), `${k} 应在拒绝表内`);
        assert.ok(!allowed.includes(k), `${k} 不应在允许表内`);
        assert.ok(!exclude.includes(k), `${k} 应保留上传（诊断用途）`);
    });
});

test('恢复形态表覆盖容器类键（数组/对象），且不与「标量槽位」规则冲突', () => {
    const arrays = tableOf('WEBDAV_RESTORE_ARRAY_KEYS');
    const objects = tableOf('WEBDAV_RESTORE_OBJECT_KEYS');
    const allowed = tableOf('WEBDAV_RESTORE_ALLOWED');
    assert.deepEqual(arrays.filter((k) => objects.includes(k)), [], '同一键不能既要求数组又要求对象');
    // 形态表的键要么在允许表内，要么是走独立文件通道的键（watchStats：不进设置
    // 快照，故不在允许表里，但它的写入口同样要过形态校验）
    const CHANNEL_KEYS = ['watchStats'];
    arrays.concat(objects).forEach((k) => {
        assert.ok(allowed.includes(k) || CHANNEL_KEYS.includes(k), `${k} 不在允许表内也不是独立通道键`);
    });
    // 关键容器键必须登记（形态错了会真出错）
    ['searchHistory', 'blockWords', 'recentWatches', 'probedSites', 'customLives']
        .forEach((k) => assert.ok(arrays.includes(k), `${k} 应登记为数组键`));
    ['watchStats', 'watchProgress', 'lastSourceMap', 'liveProbeCache', 'kazumiAliasMap',
        'favoritesFilter', 'historyFilter', 'playerHotkeys', 'blockedReason', 'probedAt', 'probeFp']
        .forEach((k) => assert.ok(objects.includes(k), `${k} 应登记为对象键`));
    // 不进允许表的键不必登记形态（登了也是死配置）；configHistory 属 URL 类拒绝键
    assert.equal(arrays.includes('configHistory') || objects.includes('configHistory'), false);
    assert.ok(tableOf('WEBDAV_RESTORE_DENIED').includes('configHistory'));
});

// ---------------------------------------------------------------- 2. 载荷组装

test('载荷组装：子开关裁剪 + 设置快照带新键、剔除机器态/凭据/webDav*', async () => {
    const { kazumi, actions } = loadKazumi({
        settings: {
            favorites: [{ uid: 'f1' }], history: [{ uid: 'h1' }],
            watchStats: { totalSeconds: 5 },
            // 本版新增的用户数据/偏好：应进快照
            searchHistory: [{ word: '芙莉莲', ts: 1 }],
            kazumiAliasMap: { 't:芙莉莲': [{ alias: '葬送', ts: 1 }] },
            favoritesSort: 'score', historyFilter: { from: '2026-01-01' },
            // 机器态/敏感/本机路径：不应进快照
            bangumiLastSyncAt: 1750000000000, bangumiToken: 'tok',
            dandanAppSecret: 'sec', translateLLMKey: 'llmk',
            webDavUrl: 'https://nas.example/dav', webDavPassword: 'pw',
            webDavRemoteDir: '/x', webDavAutoEnable: true, webDavEnableStats: true,
            mpvPath: 'C:/mpv.exe', cacheDir: 'C:/cache', settingsCat: 'play',
            webDavRestoreBackup: { ts: 1 },
            // URL/连接目标类：上传会泄露私有地址/凭据，且恢复侧本就拒绝
            proxyUrl: 'http://user:pass@127.0.0.1:7890', proxyTestUrl: 'https://example.com/generate_204',
            proxyEnable: true, lastConfigUrl: 'https://priv.example/config.json?token=abc',
            configHistory: ['https://priv.example/config.json?token=abc'],
            probeSourceUrl: 'https://priv.example/config.json', bangumiMirrorRoot: 'bangumi.vip',
            // LLM Base 是刻意保留上传的诊断字段（恢复侧仍拒绝）
            translateLLMBase: 'https://llm.example/v1',
        },
    });
    kazumi._rules = [{ name: 'r1' }];
    kazumi._rulesLoaded = true;
    const ok = await kazumi.webdavSync('https://nas.example/dav', 'u', 'p', '');
    assert.equal(ok, true);
    const kv = actions.filter((a) => a.action === 'kazumiWebdavSync').pop().kv;
    const data = JSON.parse(kv.data);
    assert.deepEqual(Object.keys(data).sort(),
        ['favorites', 'history', 'kazumiRules', 'settings', 'watchStats']);
    assert.equal(data.settings.searchHistory[0].word, '芙莉莲');
    assert.deepEqual(data.settings.kazumiAliasMap, { 't:芙莉莲': [{ alias: '葬送', ts: 1 }] });
    assert.equal(data.settings.favoritesSort, 'score');
    assert.deepEqual(data.settings.historyFilter, { from: '2026-01-01' });
    // LLM Base 保留上传（诊断），但不能因此把凭据带出去
    assert.equal(data.settings.translateLLMBase, 'https://llm.example/v1');
    ['bangumiLastSyncAt', 'bangumiToken', 'dandanAppSecret', 'translateLLMKey',
        'webDavUrl', 'webDavPassword', 'webDavRemoteDir', 'webDavAutoEnable', 'webDavEnableStats',
        'mpvPath', 'cacheDir', 'settingsCat', 'webDavRestoreBackup',
        'proxyUrl', 'proxyTestUrl', 'proxyEnable', 'lastConfigUrl',
        'configHistory', 'probeSourceUrl', 'bangumiMirrorRoot'].forEach((k) => {
        assert.equal(k in data.settings, false, `${k} 不应出现在设置快照里`);
    });
    // 版本标识由后端生成：渲染层不参与，也不得占用保留键
    assert.equal('_meta' in data, false, '版本文件由后端写入，渲染层不应塞 _meta');
});

test('载荷组装：子开关关闭则剔除对应数据；全关时拒绝同步', async () => {
    const base = { favorites: [], history: [], watchStats: {}, kazumiAliasMap: {} };
    const off = loadKazumi({
        settings: { ...base, webDavEnableRules: false, webDavEnableCollect: false, webDavEnableStats: false },
    });
    off.kazumi._rules = []; off.kazumi._rulesLoaded = true;
    assert.equal(await off.kazumi.webdavSync('https://nas.example/dav', '', '', ''), true);
    const data = JSON.parse(off.actions.pop().kv.data);
    assert.deepEqual(Object.keys(data).sort(), ['history', 'settings']);

    const none = loadKazumi({
        settings: {
            ...base, webDavEnableRules: false, webDavEnableCollect: false,
            webDavEnableHistory: false, webDavEnableSettings: false, webDavEnableStats: false,
        },
    });
    none.kazumi._rulesLoaded = true;
    assert.equal(await none.kazumi.webdavSync('https://nas.example/dav', '', '', ''), false);
    assert.equal(none.actions.length, 0, '未选择任何内容时不应发起请求');
    assert.ok(none.toasts.some((t) => t.includes('未选择任何要同步的内容')));
});

// ---------------------------------------------------------------- 3. 恢复容错

test('恢复：旧备份（云端无版本标识）按 v1 兼容恢复并在提示里说明', async () => {
    const { kazumi, toasts } = loadKazumi({
        settings: { searchHistory: [{ word: '本地' }] },
        responses: {
            kazumiWebdavRestore: {
                code: 200,
                data: { settings: { searchHistory: [{ word: '云端' }] } },
                meta: { schemaVersion: 1, legacy: true }, // 旧备份：后端兜底值
                warnings: [],
            },
        },
    });
    assert.equal(await kazumi.webdavRestore('https://nas.example/dav', '', '', ''), true);
    assert.equal(kazumi._lastWebdavRestoreReport.schemaVersion, 1);
    assert.ok(toasts.some((t) => t.includes('旧版备份')), `应说明旧版兼容：${toasts}`);
});

test('恢复：v2 备份带版本号；缺键保留本地（不用 undefined 覆盖）', async () => {
    const { kazumi, writes, toasts } = loadKazumi({
        settings: {
            searchHistory: [{ word: '本地' }],
            favoritesSort: 'recent',      // 云端没带 → 必须保持本地值
            kazumiAliasMap: { 't:x': [] }, // 云端没带 → 保持
        },
        responses: {
            kazumiWebdavRestore: {
                code: 200,
                data: { settings: { favoritesFilter: { scoreMin: 8 } } },
                meta: { schemaVersion: 2, legacy: false, app: 'YuKi', files: ['settings'] },
                warnings: [],
            },
        },
    });
    assert.equal(await kazumi.webdavRestore('https://nas.example/dav', '', '', ''), true);
    const report = kazumi._lastWebdavRestoreReport;
    assert.equal(report.schemaVersion, 2);
    assert.deepEqual(lastWrite(writes, 'favoritesFilter').value, { scoreMin: 8 });
    assert.equal(writes.some((w) => w.key === 'favoritesSort'), false, '云端缺失的键不得被覆盖');
    assert.equal(writes.some((w) => w.key === 'kazumiAliasMap'), false);
    assert.equal(writes.some((w) => w.key === 'searchHistory'), false);
    assert.ok(toasts.some((t) => t.includes('恢复完成')), toasts.join('|'));
});

test('恢复：未知键忽略并上报；已知拒绝键静默忽略（不计入上报/提示）', async () => {
    const { kazumi, writes, toasts, logs } = loadKazumi({
        settings: {},
        responses: {
            kazumiWebdavRestore: {
                code: 200,
                data: {
                    settings: {
                        favoritesSort: 'name',            // 允许 → 恢复
                        proxyUrl: 'http://evil.example',  // 拒绝 → 静默忽略
                        bangumiToken: 'tok',              // 拒绝 → 静默忽略
                        futureUnknownKey: { a: 1 },       // 未知 → 忽略并上报
                    },
                },
                meta: { schemaVersion: 2 },
                warnings: ['版本标识不是有效 JSON，按旧版备份（v1）恢复：x'],
            },
        },
    });
    assert.equal(await kazumi.webdavRestore('https://nas.example/dav', '', '', ''), true);
    const report = kazumi._lastWebdavRestoreReport;
    assert.deepEqual(plain(report.ignored), ['futureUnknownKey']);
    assert.deepEqual(plain(report.denied).sort(), ['bangumiToken', 'proxyUrl']);
    assert.deepEqual(plain(report.skipped), []);
    assert.deepEqual(plain(report.failed), []);
    assert.equal(plain(report.warnings).length, 1, '后端 warning 应带回报告');
    assert.equal(writes.some((w) => w.key === 'proxyUrl'), false, '拒绝键绝不落盘');
    assert.equal(writes.some((w) => w.key === 'bangumiToken'), false);
    assert.ok(toasts.some((t) => t.includes('1 项本机不识别已忽略')), toasts.join('|'));
    assert.ok(logs.some((l) => l.level === 'warn'), '明细应进 console');
});

test('恢复：类型不符跳过该键并给原因，其余键照常恢复', async () => {
    const { kazumi, writes, toasts } = loadKazumi({
        settings: { blockWords: ['本地词'] },
        responses: {
            kazumiWebdavRestore: {
                code: 200,
                data: {
                    settings: {
                        blockWords: { not: 'array' },      // 期望数组 → 跳过
                        kazumiAliasMap: [],                // 期望对象 → 跳过
                        favoritesSort: ['x'],              // 标量槽位收到数组 → 跳过
                        historySort: 'time-asc',           // 正常 → 恢复
                        glass: null,                       // 标量槽位收到 null → 放行（回默认）
                    },
                },
                meta: { schemaVersion: 2 },
                warnings: [],
            },
        },
    });
    assert.equal(await kazumi.webdavRestore('https://nas.example/dav', '', '', ''), true);
    const report = kazumi._lastWebdavRestoreReport;
    assert.equal(plain(report.skipped).length, 3);
    assert.ok(plain(report.skipped).some((s) => s.includes('blockWords') && s.includes('期望数组')), plain(report.skipped).join('|'));
    assert.ok(plain(report.skipped).some((s) => s.includes('kazumiAliasMap') && s.includes('期望对象')));
    assert.ok(plain(report.skipped).some((s) => s.includes('favoritesSort') && s.includes('期望单值')));
    assert.equal(writes.some((w) => w.key === 'blockWords'), false, '类型不符的键不得落盘');
    assert.equal(writes.some((w) => w.key === 'kazumiAliasMap'), false);
    assert.equal(lastWrite(writes, 'historySort').value, 'time-asc');
    assert.ok(writes.some((w) => w.key === 'glass'));
    assert.ok(toasts.some((t) => t.includes('3 项类型不符已跳过')), toasts.join('|'));
});

test('恢复：单键写失败/主进程未放行 → 记账继续，不拖垮其余键', async () => {
    const { kazumi, writes, toasts } = loadKazumi({
        settings: {},
        failKeys: ['historySort'],
        ignoredKeys: ['glass'],
        responses: {
            kazumiWebdavRestore: {
                code: 200,
                data: {
                    settings: {
                        historySort: 'time-asc',   // 写抛异常
                        glass: true,               // 主进程未放行（返回 ignored）
                        favoritesSort: 'name',     // 正常
                        kazumiAliasMap: { 't:a': [] }, // 正常
                    },
                },
                meta: { schemaVersion: 2 },
                warnings: [],
            },
        },
    });
    assert.equal(await kazumi.webdavRestore('https://nas.example/dav', '', '', ''), true);
    const report = kazumi._lastWebdavRestoreReport;
    assert.deepEqual(plain(report.failed).sort(), ['glass（主进程未放行该设置键）', 'historySort']);
    assert.equal(lastWrite(writes, 'favoritesSort').value, 'name', '失败键之后的键仍要写入');
    assert.deepEqual(lastWrite(writes, 'kazumiAliasMap').value, { 't:a': [] });
    assert.ok(toasts.some((t) => t.includes('2 项写入失败')), toasts.join('|'));
});

test('恢复：顶层通道类型不符只跳过该通道，同批设置键仍恢复（此前整批失败）', async () => {
    const { kazumi, writes, toasts } = loadKazumi({
        settings: {},
        responses: {
            kazumiWebdavRestore: {
                code: 200,
                data: {
                    kazumiRules: { not: 'array' },   // 期望数组 → 跳过并记账
                    favorites: { not: 'array' },     // 期望数组 → 跳过并记账
                    history: [{ uid: 'h1' }],        // 正常
                    watchStats: 'broken',            // 期望对象 → 跳过
                    settings: { favoritesSort: 'name' },
                },
                meta: { schemaVersion: 2 },
                warnings: [],
            },
        },
    });
    assert.equal(await kazumi.webdavRestore('https://nas.example/dav', '', '', ''), true);
    const report = kazumi._lastWebdavRestoreReport;
    assert.deepEqual(plain(report.skipped).map((s) => s.split('（')[0]).sort(),
        ['favorites', 'kazumiRules', 'watchStats']);
    assert.equal(plain(report.failed).length, 0);
    assert.equal(writes.some((w) => w.key === 'kazumiRules'), false);
    assert.deepEqual(lastWrite(writes, 'history').value, [{ uid: 'h1' }]);
    assert.equal(lastWrite(writes, 'favoritesSort').value, 'name', '设置键不该被坏掉的规则数组连坐');
    assert.equal(toasts.some((t) => t.includes('恢复失败')), false, '可恢复部分不得整体判失败');
});

test('恢复：覆盖前备份包含所有将写入且与本机有差异的允许键', async () => {
    const { kazumi, writes } = loadKazumi({
        settings: { favoritesSort: 'recent', searchHistory: [{ word: '旧' }], glass: true },
        responses: {
            kazumiWebdavRestore: {
                code: 200,
                data: {
                    settings: {
                        favoritesSort: 'name',          // 有差异 → 备份
                        searchHistory: [{ word: '新' }], // 有差异 → 备份
                        glass: true,                     // 无差异 → 不备份
                    },
                    history: [{ uid: 'h2' }],
                },
                meta: { schemaVersion: 2 },
                warnings: [],
            },
        },
    });
    assert.equal(await kazumi.webdavRestore('https://nas.example/dav', '', '', ''), true);
    const backup = lastWrite(writes, 'webDavRestoreBackup').value;
    assert.equal(backup.favoritesSort, 'recent');
    assert.deepEqual(backup.searchHistory, [{ word: '旧' }]);
    assert.equal(Object.prototype.hasOwnProperty.call(backup, 'glass'), false, '无差异的键不占备份体积');
    assert.equal(Object.prototype.hasOwnProperty.call(backup, 'history'), true, '独立通道的本地原值同样入备份');
    assert.equal(backup.history, null, '本机原本没有该数据 → 记 null 供找回');
});

test('恢复：空数据/失败不误报成功（保留既有语义）', async () => {
    const { kazumi, toasts } = loadKazumi({
        settings: {},
        responses: { kazumiWebdavRestore: { code: 500, msg: '云端没有找到任何可恢复的数据' } },
    });
    assert.equal(await kazumi.webdavRestore('https://nas.example/dav', '', '', ''), false);
    assert.ok(toasts.some((t) => t.includes('恢复失败') && t.includes('没有找到任何可恢复的数据')), toasts.join('|'));
});

// ---------------------------------------------------------------- 4. 地址策略

test('地址校验：仅 http/https；非法 scheme 拒绝且给中文原因；内网/环回放行并给提示', () => {
    const { kazumi } = loadKazumi();
    ['file:///tmp/x', 'dict://127.0.0.1:2628/', 'ftp://nas/x', 'gopher://x/1'].forEach((u) => {
        const r = kazumi._webdavUrlCheck(u);
        assert.equal(r.ok, false, `${u} 应拒绝`);
        assert.match(r.reason, /http\/https/, u);
        assert.match(r.reason, /不被支持/, u);
    });
    assert.equal(kazumi._webdavUrlCheck('nas.local/dav').ok, false);
    assert.match(kazumi._webdavUrlCheck('nas.local/dav').reason, /协议前缀/);
    assert.equal(kazumi._webdavUrlCheck('').ok, false);

    [['http://192.168.1.9:5005/dav', /内网/], ['https://10.0.0.3/dav', /内网/],
    ['http://127.0.0.1:8080/dav', /内网|本机/], ['http://nas.local/dav', /内网|本机/],
    ['http://[::1]:8080/dav', /内网|本机/]].forEach(([u, re]) => {
        const r = kazumi._webdavUrlCheck(u);
        assert.equal(r.ok, true, `${u} 必须放行（自建 NAS/内网是主流用法）`);
        assert.match(r.hint, re, u);
    });
    const pub = kazumi._webdavUrlCheck('https://dav.jianguoyun.com/dav');
    assert.equal(pub.ok, true);
    assert.equal(pub.hint, '', '公网 https 无额外提示');
    assert.match(kazumi._webdavUrlCheck('http://dav.example.com/dav').hint, /明文 http/);
});

test('地址策略接入所有入口：非法地址不发请求，内网地址正常走', async () => {
    // 非法：同步 / 恢复 / 测试 / 保存都不该发起网络调用
    const bad = loadKazumi({ settings: {} });
    for (const fn of ['webdavSync', 'webdavRestore']) {
        assert.equal(await bad.kazumi[fn]('file:///tmp/x', '', '', ''), false, fn);
    }
    await bad.kazumi.webdavTestUI();
    await bad.kazumi.webdavSyncUI();
    await bad.kazumi.webdavRestoreUI();
    assert.equal(bad.actions.length, 0, '非法地址不得发起 action 请求');
    assert.ok(bad.toasts.every((t) => !t.includes('恢复失败：网址')), bad.toasts.join('|'));
    assert.ok(bad.toasts.some((t) => t.includes('http/https')), bad.toasts.join('|'));

    // 内网：正常发起（并只做提示）
    const good = loadKazumi({
        settings: {},
        responses: { kazumiWebdavRestore: { code: 200, data: { history: [] }, meta: { schemaVersion: 2 } } },
    });
    assert.equal(await good.kazumi.webdavRestore('http://192.168.1.9:5005/dav', '', '', ''), true);
    assert.equal(good.actions.length, 1);
    assert.equal(good.actions[0].kv.url, 'http://192.168.1.9:5005/dav');
});

// ---------------------------------------------------------------- 5. 设置页回填一致性

test('_prefillWebdav 与子开关 handler 一致：每个开关都回填、且读写同一设置键', () => {
    const prefill = bodyOf('async _prefillWebdav()', SRC, 1600);
    // HTML 里的 WebDAV 开关/选择控件
    const ids = ['webdav_enable', 'webdav_enable_history', 'webdav_enable_collect',
        'webdav_enable_settings', 'webdav_enable_stats', 'webdav_enable_rules',
        'webdav_auto_enable', 'webdav_startup_pull', 'webdav_ssl_skip', 'webdav_auto_interval'];
    ids.forEach((id) => {
        assert.match(HTML, new RegExp(`id="${id}"`), `界面缺少 #${id}`);
        assert.ok(prefill.includes(`#${id}`), `_prefillWebdav 未回填 #${id}（用户会以为设置没保存）`);
    });
    // 地址/账号/目录/密码四个输入框也要回填
    ['webdav_url', 'webdav_username', 'webdav_password', 'webdav_remote_dir'].forEach((id) => {
        assert.ok(prefill.includes(`#${id}`), `_prefillWebdav 未回填 #${id}`);
    });
    // 每个开关的 change handler 写入的键，必须与 prefill 读取的键一致
    ids.filter((id) => id !== 'webdav_auto_interval').forEach((id) => {
        const at = SRC.indexOf(`$('#${id}').on('change'`);
        assert.ok(at > 0, `#${id} 缺少 change handler（开关改了不落盘）`);
        const seg = SRC.slice(at, at + 300);
        const m = /settingsSet\('([A-Za-z0-9_]+)'/.exec(seg);
        assert.ok(m, `#${id} 的 handler 未写入设置键`);
        assert.ok(prefill.includes(`s.${m[1]}`), `#${id} 写入 ${m[1]} 但 prefill 未读同名键`);
    });
    // 主开关关闭时的联动：必须把子开关一并落盘为 false，否则重开主开关后
    // 子开关看似关闭却仍是旧值（界面与持久化不一致）
    const masterAt = SRC.indexOf(`$('#webdav_enable').on('change'`);
    const masterSeg = SRC.slice(masterAt, masterAt + 1400);
    ['webDavEnableHistory', 'webDavEnableCollect', 'webDavEnableSettings',
        'webDavEnableStats', 'webDavEnableRules', 'webDavAutoEnable', 'webDavStartupPull']
        .forEach((k) => {
            assert.ok(masterSeg.includes(`settingsSet('${k}', false)`), `主开关关闭未联动落盘 ${k}`);
        });
});

test('主开关重新启用时兜底内容开关：避免「已启用但没有任何同步内容」死角', () => {
    const masterAt = SRC.indexOf(`$('#webdav_enable').on('change'`);
    const masterSeg = SRC.slice(masterAt, masterAt + 3000);
    // 关闭方向仍清空（既有语义，上面用例已锁），因此重开时子开关必然全灭——必须补默认。
    assert.ok(masterSeg.includes('if (!hasAny)'), '启用方向缺少「五项内容全都没选」兜底判定');
    // 兜底只恢复五项**内容**开关（DOM + 持久化同写）
    ['#webdav_enable_history', '#webdav_enable_collect', '#webdav_enable_settings',
        '#webdav_enable_stats', '#webdav_enable_rules'].forEach((sel) => {
        assert.ok(masterSeg.includes(`'${sel}'`), `启用方向未恢复 ${sel}`);
    });
    assert.ok(masterSeg.includes('settingsSet(key, true)'), '兜底必须同时落盘（否则重开应用又回到全灭）');
    assert.ok(masterSeg.includes(".prop('checked', true)"), '兜底必须同步 DOM 勾选态');
    // 自动化开关不替用户决定：启用方向不得自动打开定时同步/启动即恢复
    assert.ok(!/settingsSet\('webDavAutoEnable', true\)/.test(masterSeg), '不得自动打开定时同步');
    assert.ok(!/settingsSet\('webDavStartupPull', true\)/.test(masterSeg), '不得自动打开启动即恢复');
});
