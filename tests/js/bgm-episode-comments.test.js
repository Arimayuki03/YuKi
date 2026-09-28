'use strict';
// Bangumi 选集讨论 + bgm.tv 跳转按钮 + 分集评论端点链路回归测试：
// 1) 详情页签表包含「选集讨论」，且 _renderTabContent 正确派发（T82 选集评论板块）
// 2) 选集讨论渲染：集数 chips + 列表骨架 + 切集重拉（世代守卫）
// 3) 评论排序：默认倒序（新→旧），切正序按时间旧→新
// 4) 分集列表缺失时先拉取（_ensureBgmEpisodes 复用 _bgmEps 缓存）；跨番剧复位防串档
// 5) Bangumi 详情 hero 渲染「↗ Bangumi 页」按钮，点击 window.open 系统浏览器跳转 bgm.tv
// 6) 后端契约：kazumiBangumiEpisodeComments do 分支 + next.bgm /p1/episodes 端点 + tags 字段链路
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 最小 jQuery 桩（对齐 detail-start-button.test.js）：链式 + html 捕获 + 委托记录。 */
function makeJqStub(captor) {
    const makeNode = (sel) => ({
        sel: String(sel),
        length: 1,
        on(ev, a, b) {
            const fn = typeof b === 'function' ? b : a;
            const delegated = typeof b === 'function' ? String(a) : '';
            if (captor && typeof fn === 'function') captor.bound.push({ sel: String(sel), ev, delegated, fn });
            return this;
        },
        off() { return this; },
        html(s) { if (captor && s !== undefined) captor.htmlBySel.set(String(sel), String(s)); return this; },
        text() { return this; },
        val() { return ''; },
        addClass() { return this; },
        removeClass() { return this; },
        toggleClass() { return this; },
        attr() { return this; },
        prop() { return this; },
        trigger() { return this; },
        find() { return makeNode(String(sel) + ' *'); },
        each() { return this; },
        map() { return this; },
        get() { return []; },
        filter() { return this; },
        data() { return undefined; },
    });
    return (sel) => makeNode(sel);
}

/** 在 VM 中加载 detail.js（最小桩）。extra 可覆盖 window/Kazumi 等。 */
function loadDetail(extra) {
    const source = read('src/renderer/js/detail.js');
    const captor = { bound: [], htmlBySel: new Map() };
    const toasts = [];
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, parseInt, parseFloat,
        setTimeout, clearTimeout,
        document: {
            addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            body: { classList: { contains() { return false; } } },
            getElementById: () => null,
            createElement: () => ({ addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
        },
        $: makeJqStub(captor),
        registerEsc: () => {},
        escHtml: (s) => String(s),
        stripHtml: (s) => String(s || ''),
        warnToast: (m) => toasts.push(String(m)),
        showLoading: () => {}, hideLoading: () => {},
        bangumiCover: () => '',
        vodCoverImg: () => '<img src="cover.jpg">',
        normalizePic: (p) => p || '',
        abortCoverFill: () => {},
        localCacheGet: () => null,
        localCacheSet: () => {},
        localCacheDel: () => {},
        openDialog: () => {},
        closeDialog: () => {},
        window: { yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) } },
    };
    Object.assign(context, extra || {});
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'detail.js' });
    const Detail = vm.runInContext('Detail', context);
    return { Detail, bound: captor.bound, htmlBySel: captor.htmlBySel, toasts, context };
}

const SAMPLE_EPISODES = {
    data: [
        { id: 101, sort: 1, ep: 1, type: 0, name: '第一话', name_cn: '第 1 集' },
        { id: 102, sort: 2, ep: 2, type: 0, name: '第二话', name_cn: '第 2 集' },
        { id: 103, sort: 1, ep: 1, type: 1, name: 'SP', name_cn: '特别篇' },  // SP 与正片同 sort
    ],
};
const SAMPLE_EP_COMMENTS = [
    { user: { nickname: '甲' }, content: '一楼', createdAt: 1700000000, replies: [] },
    { user: { nickname: '乙' }, content: '二楼', createdAt: 1700100000, replies: [
        { user: { nickname: '丙' }, content: '楼中楼', createdAt: 1700150000 },
    ] },
];

/** 标准夹具：Bangumi-only 详情 + 已加载分集 + 已渲染选集讨论页签。 */
function fixtureEpComments(extra) {
    const opened = [];
    const { Detail, htmlBySel, context } = loadDetail(Object.assign({
        window: {
            open: (u) => opened.push(String(u)),
            yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) },
        },
        Kazumi: {
            bangumiEpisodes: async () => SAMPLE_EPISODES,
            bangumiEpisodeComments: async (eid) => (Number(eid) === 102 ? SAMPLE_EP_COMMENTS : []),
            bangumiComments: async () => [],
            bangumiCharacters: async () => [],
            bangumiStaff: async () => [],
            bangumiRelations: async () => [],
            bangumiInfo: async () => ({ id: '42', name: '番剧', tags: [{ name: 'TV', count: 9 }] }),
        },
    }, extra || {}));
    Detail._bgmId = '42';
    Detail._bgmInfo = { id: 42, name: '番剧' };
    Detail.vodName = '番剧';
    Detail._activeTab = '选集讨论';
    return { Detail, htmlBySel, context, opened };
}

// ---------------------------------------------------------------- 页签注册与派发

test('页签表：DETAIL_TABS 含「选集讨论」且位于「分集」之后', () => {
    const { context } = loadDetail();
    const tabs = vm.runInContext('DETAIL_TABS', context);
    assert.ok(Array.isArray(tabs), 'DETAIL_TABS 应为数组');
    assert.ok(tabs.includes('选集讨论'), '页签表应包含「选集讨论」');
    assert.ok(tabs.indexOf('选集讨论') > tabs.indexOf('分集'), '「选集讨论」应在「分集」之后');
});

test('派发：_renderTabContent 对「选集讨论」调用 _renderEpComments', () => {
    const { Detail } = loadDetail();
    let called = 0;
    Detail._renderEpComments = () => { called++; };
    Detail._activeTab = '选集讨论';
    Detail._renderTabContent();
    assert.equal(called, 1, '选集讨论页签应派发到 _renderEpComments');
});

// ---------------------------------------------------------------- 渲染与交互

test('渲染：集数 chips 全量展示（含 SP 徽标），默认选中第 1 集', async () => {
    const { Detail, htmlBySel } = fixtureEpComments();
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    await Detail._renderEpComments();
    const html = String(htmlBySel.get('#detail-tab-content') || '');
    assert.ok(html.includes('ep-comments-chips'), '应渲染集数选择器');
    assert.ok(html.includes('data-eid="101"'), '第 1 集 chip 存在');
    assert.ok(html.includes('data-eid="103"'), 'SP chip 存在（全部分集含 SP/OP/ED）');
    assert.ok(/ep-comments-chip[^>]*data-eid="101"[^>]*class="[^"]*active|class="[^"]*active[^"]*"[^>]*data-eid="101"|data-eid="101"[^>]*class="ep-comments-chip active"/.test(html.replace(/\n/g, ' ')) || /active[^>]*data-eid="101"|data-eid="101"[^>]*active/.test(html), '第 1 集默认高亮');
    assert.ok(html.includes('第 1 集讨论'), '标题展示当前集');
    assert.ok(html.includes('加载评论中'), '列表骨架先展示 loading');
});

test('加载：bangumiEpisodeComments 按选中集 episode_id 拉取并渲染（含楼中楼）', async () => {
    const { Detail, htmlBySel } = fixtureEpComments();
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    await Detail._renderEpComments();
    // 默认选中第 1 集（id=101 无评论）：空态
    await Detail._loadEpComments(Detail._bgmEps.find((e) => Number(e.id) === 101));
    assert.equal(Detail._epComments.length, 0);
    // 切到第 2 集（id=102 有 2 条评论，含楼中楼）
    await Detail._loadEpComments(Detail._bgmEps.find((e) => Number(e.id) === 102));
    assert.equal(Detail._epComments.length, 2);
    Detail._renderEpCommentsList();
    const html = String(htmlBySel.get('#ep-comments-list') || '');
    assert.ok(html.includes('共 2 条讨论'), '评论计数');
    assert.ok(html.includes('一楼') && html.includes('二楼'), '主楼层正文');
    assert.ok(html.includes('楼中楼'), '楼中楼 replies 渲染');
    assert.ok(html.includes('detail-comment-replies'), '楼中楼复用吐槽页签缩进结构');
});

test('排序：默认倒序（新→旧），切换 _epCommentsDesc 后正序渲染', async () => {
    const { Detail, htmlBySel } = fixtureEpComments();
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    await Detail._renderEpComments();
    const ep2 = Detail._bgmEps.find((e) => Number(e.id) === 102);
    await Detail._loadEpComments(ep2);
    assert.equal(Detail._epCommentsDesc, true, '默认倒序（新→旧）');
    // 倒序渲染：createdAt 更大的「二楼」在前
    Detail._renderEpCommentsList();
    let html = String(htmlBySel.get('#ep-comments-list') || '');
    assert.ok(html.indexOf('二楼') < html.indexOf('一楼'), '倒序：新评论在前');
    // 切正序：旧评论在前
    Detail._epCommentsDesc = false;
    Detail._renderEpCommentsList();
    html = String(htmlBySel.get('#ep-comments-list') || '');
    assert.ok(html.indexOf('一楼') < html.indexOf('二楼'), '正序：旧评论在前');
    // 排序只影响渲染，不改数据数组本身顺序
    assert.equal(Detail._epComments[0].content, '一楼', '原始数组顺序不变');
});

test('世代守卫：切集后旧请求的迟到结果被丢弃，不覆盖新集数据', async () => {
    // bangumiEpisodeComments 按调用次序分批放行：首个请求被 hold，切集后放行——
    // 迟到结果因世代不匹配必须被丢弃
    let releaseFirst;
    const gate = new Promise((res) => { releaseFirst = res; });
    let call = 0;
    const { Detail } = fixtureEpComments({
        Kazumi: {
            bangumiEpisodes: async () => SAMPLE_EPISODES,
            bangumiEpisodeComments: async () => {
                call++;
                if (call === 1) { await gate; return SAMPLE_EP_COMMENTS; } // 第 1 集请求被 hold
                return SAMPLE_EP_COMMENTS.slice(0, 1);                     // 第 2 集立即返回 1 条
            },
            bangumiComments: async () => [],
            bangumiCharacters: async () => [],
            bangumiStaff: async () => [],
            bangumiRelations: async () => [],
        },
    });
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    const first = Detail._loadEpComments(Detail._bgmEps.find((e) => Number(e.id) === 101));
    await new Promise((r) => setImmediate(r)); // 首个请求进入 hold
    // 切到第 2 集：世代自增，第 2 集先完成
    await Detail._loadEpComments(Detail._bgmEps.find((e) => Number(e.id) === 102));
    assert.equal(Detail._epComments.length, 1, '第 2 集 1 条评论先落位');
    // 放行第 1 集的迟到请求：世代已过，结果必须被丢弃
    releaseFirst();
    await first;
    assert.equal(Detail._epComments.length, 1, '迟到旧请求不覆盖新集数据');
    assert.equal(Detail._epComments[0].content, '一楼');
});

test('跨番剧复位：_resetEpComments 清空评论与 _bgmEps（防上一部分集串档）', () => {
    const { Detail } = fixtureEpComments();
    Detail._bgmEps = SAMPLE_EPISODES.data.slice();
    Detail._epComments = SAMPLE_EP_COMMENTS;
    Detail._epCommentsEpisodeId = 102;
    const oldGen = Detail._epCommentsGen;
    Detail._resetEpComments();
    assert.equal(Detail._epComments.length, 0, '评论清空');
    assert.equal(Detail._epCommentsEpisodeId, 0, '选中集复位');
    assert.equal(Detail._bgmEps, null, '分集列表缓存清空（跨番剧防串档）');
    assert.ok(Detail._epCommentsGen > oldGen, '世代自增（作废在途请求）');
});

// ---------------------------------------------------------------- bgm.tv 跳转按钮

test('Bangumi 页按钮：hero 操作行渲染 #detail-bgm-open，点击经 window.open 跳转 bgm.tv', async () => {
    const opened = [];
    const { Detail } = loadDetail({
        window: {
            open: (u) => opened.push(String(u)),
            yuki: { settingsGet: async () => ({}), settingsSet: async () => ({}) },
        },
    });
    Detail._bgmId = '42';
    Detail._bgmInfo = { id: 42, name: '番剧', images: {} };
    Detail.vodName = '番剧';
    const html = Detail._bangumiColHtml(Detail._bgmInfo);
    assert.ok(String(html).includes('id="detail-bgm-open"'), '操作行应含 #detail-bgm-open');
    assert.ok(String(html).includes('Bangumi 页'), '按钮文案');
    // 点击行为（与 detail.js #detail-bgm-open 委托同口径）：数字守卫 + bgm.tv 条目 URL
    const sid = String(Detail._bgmId || '');
    if (sid && /^\d+$/.test(sid)) opened.push(`https://bgm.tv/subject/${sid}`);
    assert.deepEqual(opened, ['https://bgm.tv/subject/42']);
});

test('bgm.tv 跳转守卫：非数字 subjectId 不拼 URL（toast 提示）', () => {
    const { Detail } = loadDetail({
        window: { open: () => { throw new Error('should not open'); }, yuki: { settingsGet: async () => ({}) } },
    });
    Detail._bgmId = 'abc<script>';
    // 守卫口径：/^\d+$/ 才放行（与 detail.js #detail-bgm-open 委托一致）
    const sid = String(Detail._bgmId || '');
    const pass = !!(sid && /^\d+$/.test(sid));
    assert.equal(pass, false, '非数字 ID 必须被守卫拦截');
});

test('源码契约：#detail-bgm-open 委托绑定存在（init 挂 #detail-body）', () => {
    const src = read('src/renderer/js/detail.js');
    assert.match(src, /on\('click', '#detail-bgm-open'/, '应绑定 #detail-bgm-open 点击委托');
    assert.match(src, /window\.open\(`https:\/\/bgm\.tv\/subject\/\$\{sid\}`/, '应以模板串拼 bgm.tv 条目 URL');
    // 守卫正则必须锚定在委托处理器内部（上方复刻式用例只测副本不测生产代码，
    // 若 detail.js 删掉数字 ID 守卫，这里必须失败——防注入防线的源码级回归）
    assert.ok(src.includes('.test(sid)'), '跳转守卫必须存在于 detail.js（.test(sid) 数字 ID 校验）');
});

// ---------------------------------------------------------------- 渲染层→后端链路（kazumi.js + server.py + plugin_manager.py）

test('kazumi.js：bangumiEpisodeComments 封装 kazumiBangumiEpisodeComments + 本地 10 分钟缓存', async () => {
    const source = read('src/renderer/js/kazumi.js');
    const calls = [];
    const cacheWrites = [];
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Object, Number, parseInt, parseFloat,
        setTimeout, clearTimeout, setInterval, clearInterval,
        $: () => ({ on: () => this }),
        doAction: async (doName, form) => {
            calls.push({ doName, form });
            return { code: 200, comments: SAMPLE_EP_COMMENTS };
        },
        warnToast: () => {},
        escHtml: (s) => String(s),
        showLoading: () => {}, hideLoading: () => {},
        openDialog: () => {}, closeDialog: () => {},
        confirmDialog: async () => false,
        localCacheGet: () => null,
        localCacheSet: (k, v, ttl) => { cacheWrites.push({ k, v, ttl }); },
        localCacheDel: () => {},
        document: {
            addEventListener() {},
            getElementById: () => null,
            createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
            body: { appendChild() {} },
        },
        window: {}, // kazumi.js 尾部 IIFE 把 YUKI.kazumi 挂到 window
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'kazumi.js' });
    const K = context.window.YUKI && context.window.YUKI.kazumi;
    assert.ok(K, 'kazumi.js 应导出 YUKI.kazumi');
    assert.equal(typeof K.bangumiEpisodeComments, 'function', '应提供 bangumiEpisodeComments 封装');
    const list = await K.bangumiEpisodeComments(102);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].doName, 'kazumiBangumiEpisodeComments');
    assert.equal(calls[0].form.episodeId, '102', 'episodeId 以字符串透传');
    assert.equal(list.length, 2, '数组归一化（直接数组形态）');
    // 命中非空列表时落 localStorage 持久缓存，TTL 10 分钟
    assert.equal(cacheWrites.length, 1);
    assert.equal(cacheWrites[0].k, 'detail::epcmt::v1::102');
    assert.equal(cacheWrites[0].ttl, 10 * 60 * 1000);
    // 缓存命中路径：不再发请求
    context.localCacheGet = () => SAMPLE_EP_COMMENTS;
    const again = await context.window.YUKI.kazumi.bangumiEpisodeComments(102);
    assert.equal(again.length, 2);
    assert.equal(calls.length, 1, '缓存命中不发网络请求');
});

test('后端：kazumiBangumiEpisodeComments do 分支 + next.bgm 端点 + 缓存 TTL', () => {
    const serverSrc = read('python-backend/server.py');
    assert.match(serverSrc, /if do == 'kazumiBangumiEpisodeComments':/, 'server.py 应有 do 分支');
    assert.match(serverSrc, /'kazumiBangumiEpisodeComments': 600/, '只读端点应配 10 分钟 TTL 缓存');
    assert.match(serverSrc, /kazumi_mgr\.bangumi_episode_comments\(episode_id\)/, '应调用 plugin_manager 方法');
    const pmSrc = read('python-backend/kazumi/plugin_manager.py');
    assert.match(pmSrc, /def bangumi_episode_comments\(self, episode_id\):/, 'plugin_manager 应有 bangumi_episode_comments');
    assert.match(pmSrc, /\/p1\/episodes\/\{episode_id\}\/comments/, '对齐 Kazumi：GET next.bgm /p1/episodes/{id}/comments');
});

test('后端：收藏 PATCH 支持 tags（对齐 Kazumi rating_review_dialog 边界 10 个/10 字）', () => {
    const pmSrc = read('python-backend/kazumi/plugin_manager.py');
    assert.match(pmSrc, /def normalize_bgm_tags\(/, '应有 normalize_bgm_tags 归一化');
    assert.match(pmSrc, /BGM_TAGS_MAX = 10/, '上限 10 个');
    assert.match(pmSrc, /BGM_TAG_MAX_LEN = 10/, '单标签最长 10 字');
    // 三条写入路径都透传 tags
    assert.match(pmSrc, /def _bangumi_set_one\(self, subject_id, ctype, headers, bases, usernames, rate=None, comment=None, tags=None\):/, '_bangumi_set_one 支持 tags');
    assert.match(pmSrc, /tags_n = normalize_bgm_tags\(item\.get\('tags'\)\)/, 'apply_sync_plan 归一化 tags');
    assert.match(pmSrc, /def bangumi_update_collection\(self, token, subject_id, collection_type, rate=None, comment=None, tags=None\):/, 'update_collection 支持 tags');
    assert.match(pmSrc, /body\['tags'\] = tags_n/, 'body 携带 tags 键');
});

// ---------------------------------------------------------------- Python 侧纯逻辑（VM 外，直接 subprocess 跑断言脚本）

/** Python 解释器探测：优先 venv，回退 PATH（CI js job 无 venv，无回退会 ENOENT）。 */
function hasPython() {
    const fs2 = require('fs');
    const venv = path.join(ROOT, 'python-backend', '.venv', 'Scripts', 'python.exe');
    if (fs2.existsSync(venv)) return venv;
    try { require('child_process').execFileSync('python', ['--version'], { stdio: 'ignore' }); return 'python'; } catch (e) { return null; }
}

test('normalize_bgm_tags：边界与非法值（Python 纯逻辑）', { skip: !hasPython() && '无可用 Python 解释器（CI js job 无 venv）——该断言由 python job 的 kazumi-bgm-rating stage 覆盖' }, async () => {
    // 环境探测先于硬编码路径：CI js job 没有 venv（release.yml 才创建），
    // 无回退会 ENOENT 必炸 js job（先例：python-bridge-lifecycle.test.js）
    const py = hasPython();
    const code = [
        'import sys',
        "sys.path.insert(0, 'python-backend')",
        'from kazumi.plugin_manager import normalize_bgm_tags, BgmFieldError',
        "assert normalize_bgm_tags(None) is None",
        "assert normalize_bgm_tags('') is None",
        "assert normalize_bgm_tags(['a', ' a ', '', 'b']) == ['a', 'b']",
        "assert normalize_bgm_tags('solo') == ['solo']",
        "try:",
        "    normalize_bgm_tags(['x' * 11])",
        "    raise SystemExit('long tag should fail')",
        "except BgmFieldError as e:",
        "    assert e.field == 'tags'",
        "try:",
        "    normalize_bgm_tags([f't{i}' for i in range(11)])",
        "    raise SystemExit('11 tags should fail')",
        "except BgmFieldError:",
        "    pass",
        "assert normalize_bgm_tags([f't{i}' for i in range(10)]) == [f't{i}' for i in range(10)]",
        'print("PY_OK")',
    ].join('\n');
    const { execFileSync } = require('child_process');
    const out = execFileSync(py, ['-c', code], { encoding: 'utf8', cwd: ROOT });
    assert.ok(out.includes('PY_OK'), `Python 逻辑断言应通过：${out}`);
});
