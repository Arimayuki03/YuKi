'use strict';
// 时间表封面卡片「番剧主要分类」徽标（timeline.js pickMainTag / _fetchInfos /
// _attachTagBadges / _insertTagBadge）回归测试：
// 1) 纯函数：白名单命中与未命中、count 最高者胜、同 count 稳定排序、非类型标签被
//    排除（TV/日本/放送季…哪怕 count 压倒性）、别名归一、空/畸形输入 → ''
// 2) DOM 顺序硬断言：集数徽标 → 分类徽标 → 收藏徽标（用户指定位置），且到达顺序无关
// 3) 数据链路：与话数徽章共享同一次批量回源（零重复请求）、条目自带 tags 零回源、
//    超过后端单批 60 上限时分批、批量失败静默不显示
// 4) 重挂路径（FavHub 广播 / 收藏映射重建）分类徽标不被连带销毁且位置不漂移
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '../../src/renderer/js/timeline.js');

/** 在 VM 沙箱载入 timeline.js（同 timeline.test.js 口径），返回 Timeline 对象。 */
function loadTimeline(extra = {}) {
    const source = fs.readFileSync(SRC, 'utf8');
    const context = {
        console, Date, Math, JSON, String, Number, Array, Map, Set, Object,
        parseInt, parseFloat, Promise, setTimeout, clearTimeout, isNaN,
        ...extra,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__testTimeline = Timeline;`, context, { filename: 'timeline.js' });
    return context.__testTimeline;
}

// ---------------------------------------------------------------- 纯函数：pickMainTag

/** 断言口径：VM 沙箱内产出的对象与宿主的原型不同（assert/strict 的 deepStrictEqual
 *  会因跨 realm 原型不相等而误报），故把结果投影成「原始写法→规范分类」的字符串。
 *  空结果（无命中/畸形输入）投影为 ''，两种返回形态一并覆盖。 */
function tagOf(p) { return p === '' ? '' : `${p.tag}→${p.category}`; }

test('pickMainTag：白名单命中，count 最高者胜（用户口径「标签最多的一种分类」）', () => {
    const t = loadTimeline();
    assert.equal(
        tagOf(t.pickMainTag([{ name: '恋爱', count: 320 }, { name: '奇幻', count: 810 }, { name: '日常', count: 400 }])),
        '奇幻→奇幻');
});

test('pickMainTag：非类型标签被排除——TV/日本/放送季/来源 count 压倒性也不参与', () => {
    const t = loadTimeline();
    const p = t.pickMainTag([
        { name: 'TV', count: 9999 },
        { name: '日本', count: 5000 },
        { name: '2026年10月', count: 3000 },
        { name: '漫画改', count: 2000 },
        { name: '原创', count: 1800 },
        { name: '女性向', count: 900 },
        { name: '恋爱', count: 50 },
    ]);
    assert.equal(tagOf(p), '恋爱→恋爱');
});

test('pickMainTag：别名归一（规范名用于展示，tag 保留原始写法供 title）', () => {
    const t = loadTimeline();
    const cases = [
        ['爱情', '恋爱'], ['恋爱喜剧', '恋爱'],
        ['喜剧', '搞笑'], ['幽默', '搞笑'],
        ['SF', '科幻'], ['科学幻想', '科幻'], ['硬科幻', '科幻'],
        ['魔法', '奇幻'], ['魔幻', '奇幻'],
        ['机甲', '机战'], ['机器人', '机战'],
        ['竞技', '运动'], ['体育', '运动'],
        ['轻百合', '百合'], ['BL', '耽美'],
        ['时间旅行', '穿越'], ['时间循环', '轮回'],
        ['转生', '异世界'], ['丧尸', '恐怖'],
    ];
    for (const [raw, category] of cases) {
        const p = t.pickMainTag([{ name: raw, count: 7 }]);
        assert.equal(tagOf(p), `${raw}→${category}`, `「${raw}」应归一到「${category}」且保留原始写法`);
    }
    // 站内 ASCII 标签大小写混用（SF/sf）：不建小写键会漏命中
    assert.equal(tagOf(t.pickMainTag([{ name: 'sf', count: 3 }])), 'sf→科幻');
    assert.equal(tagOf(t.pickMainTag([{ name: 'bl', count: 3 }])), 'bl→耽美');
});

test('pickMainTag：count 并列 → 白名单优先级（表序），与输入顺序无关', () => {
    const t = loadTimeline();
    const a = t.pickMainTag([{ name: '奇幻', count: 500 }, { name: '恋爱', count: 500 }]);
    const b = t.pickMainTag([{ name: '恋爱', count: 500 }, { name: '奇幻', count: 500 }]);
    assert.equal(tagOf(a), '恋爱→恋爱', '并列时取表内更靠前（更常见）的分类');
    assert.equal(tagOf(a), tagOf(b), '结果不依赖输入顺序（确定性）');
    // 同分类不同别名并列：名称字典序定原始写法（title 提示也确定，不随输入序抖动）
    const c = t.pickMainTag([{ name: '爱情', count: 50 }, { name: '恋爱', count: 50 }]);
    const d = t.pickMainTag([{ name: '恋爱', count: 50 }, { name: '爱情', count: 50 }]);
    assert.equal(tagOf(c), '恋爱→恋爱');
    assert.equal(tagOf(c), tagOf(d));
});

test('pickMainTag：字符串标签/缺 count/非法 count 降级为 0 且不报错', () => {
    const t = loadTimeline();
    // 裸字符串数组（部分镜像形态）：count 视为 0，并列时按表序取
    assert.equal(tagOf(t.pickMainTag(['日常', '恋爱'])), '恋爱→恋爱');
    assert.equal(tagOf(t.pickMainTag([{ name: '恋爱' }])), '恋爱→恋爱');
    assert.equal(tagOf(t.pickMainTag([{ name: '恋爱', count: 'x' }])), '恋爱→恋爱');
    // 数字字符串正常比较
    assert.equal(t.pickMainTag([{ name: '日常', count: '50' }, { name: '恋爱', count: 49 }]).category, '日常');
    assert.equal(tagOf(t.pickMainTag([null, undefined, {}, { name: '' }, { count: 9 }])), '');
});

test('pickMainTag：空/畸形输入与「只有非类型标签」→ 空串（不显示徽标，绝不回退 TV）', () => {
    const t = loadTimeline();
    assert.equal(t.pickMainTag([]), '');
    assert.equal(t.pickMainTag(null), '');
    assert.equal(t.pickMainTag(undefined), '');
    assert.equal(t.pickMainTag('恋爱'), '');
    assert.equal(t.pickMainTag({ name: '恋爱', count: 9 }), '');
    assert.equal(t.pickMainTag([{ name: 'TV', count: 9999 }]), '');
    assert.equal(t.pickMainTag([{ name: '日本', count: 9999 }, { name: 'OVA', count: 8000 }]), '');
    // 别名表不吸进放送季/受众/来源/制作方（白名单外的常见「高 count」标签抽样）
    for (const n of ['2026年10月', '轻小说改', '游戏改', '完结', '第2季', '男性向', '里番', '京阿尼', '芳文社', '摇滚']) {
        assert.equal(t.pickMainTag([{ name: n, count: 8888 }]), '', `「${n}」不应命中类型白名单`);
    }
});

// ---------------------------------------------------------------- 迷你 DOM 桩
// timeline.test.js 的桩把 DOM 记录成平铺字符串，无法表达「同一行内子节点的先后」
// ——而本次验收点正是 DOM 顺序（集数徽标 → 分类徽标 → 收藏徽标），故本文件自带
// 保留父子结构的迷你 DOM：只实现徽标管线用到的标签/选择器/操作，不做通用浏览器模拟。

class El {
    constructor(tag, attrs = {}) {
        this.tag = tag;
        this.attrs = attrs;
        this.classes = String(attrs.class || '').split(/\s+/).filter(Boolean);
        this.children = [];
        this.text = '';
        this.parent = null;
    }
    has(c) { return this.classes.indexOf(c) >= 0; }
    get outerHTML() { return serializeEl(this); }
}

function serializeEl(el) {
    const cls = el.classes.length ? ` class="${el.classes.join(' ')}"` : '';
    const attrs = Object.keys(el.attrs).filter((k) => k !== 'class').map((k) => ` ${k}="${el.attrs[k]}"`).join('');
    return `<${el.tag}${cls}${attrs}>${el.text}${el.children.map(serializeEl).join('')}</${el.tag}>`;
}

/** 解析本测试涉及的简单 HTML（span/div + class/title/data-id 属性）。 */
function parseHtml(html) {
    const roots = [];
    const stack = [{ children: roots, text: '' }];
    const re = /<([a-zA-Z]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*(\/?)>|<\/([a-zA-Z]+)>|([^<]+)/g;
    let m;
    while ((m = re.exec(String(html == null ? '' : html))) !== null) {
        if (m[5] !== undefined) { stack[stack.length - 1].text += m[5]; continue; }
        if (m[4] !== undefined) { stack.pop(); continue; }
        const attrs = {};
        const are = /([a-zA-Z-]+)="([^"]*)"/g;
        let am;
        while ((am = are.exec(m[2] || '')) !== null) attrs[am[1]] = am[2];
        const el = new El(m[1], attrs);
        const top = stack[stack.length - 1];
        // 父指针必须在此建立（根伪节点无 tag 不算父）：生产代码的 before()/remove()
        // 依赖 parent 定位，缺父指针会让「插在收藏徽标之前」静默失效
        el.parent = top.tag ? top : null;
        top.children.push(el);
        if (!m[3]) stack.push(el);
    }
    return roots;
}

function descendants(el) {
    const out = [];
    (el.children || []).forEach((c) => { out.push(c); out.push(...descendants(c)); });
    return out;
}

function matchStep(el, step) {
    const cm = /^\.([A-Za-z0-9_-]+)/.exec(step);
    if (!cm || !el.has(cm[1])) return false;
    const dm = /\[data-id="([^"]*)"\]/.exec(step);
    if (dm && el.attrs['data-id'] !== dm[1]) return false;
    return true;
}

function findFirst(root, sel) {
    let scope = root;
    let found = null;
    for (const step of String(sel).trim().split(/\s+/).filter(Boolean)) {
        found = descendants(scope).find((el) => matchStep(el, step)) || null;
        if (!found) return null;
        scope = found;
    }
    return found;
}

function emptyWrap() {
    const noop = () => emptyWrap();
    return { length: 0, 0: undefined, find: noop, append: noop, prepend: noop, before: noop, remove: noop, html: () => '', text: () => '' };
}

function wrap(el) {
    if (!el) return emptyWrap();
    const self = {
        length: 1, 0: el,
        find: (sel) => wrap(findFirst(el, sel)),
        append: (h) => { const ns = parseHtml(h); ns.forEach((n) => { n.parent = el; }); el.children.push(...ns); return self; },
        prepend: (h) => { const ns = parseHtml(h); ns.forEach((n) => { n.parent = el; }); el.children.unshift(...ns); return self; },
        before: (h) => {
            const p = el.parent;
            if (!p) return self;
            const ns = parseHtml(h);
            ns.forEach((n) => { n.parent = p; });
            p.children.splice(p.children.indexOf(el), 0, ...ns);
            return self;
        },
        remove: () => {
            const p = el.parent;
            if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); el.parent = null; }
            return self;
        },
        html: () => el.text + el.children.map(serializeEl).join(''),
        text: () => el.text + el.children.map((c) => c.text).join(''),
    };
    return self;
}

/** grid.find('.bangumi-card[data-id="N"] .vod-cover')：按需创建卡面节点并记账。 */
function makeGridDom(cards) {
    return {
        find(sel) {
            const m = /\.bangumi-card\[data-id="(.+?)"\] \.vod-cover/.exec(sel);
            if (!m) return emptyWrap();
            const id = m[1];
            if (!cards[id]) cards[id] = new El('div', { class: 'vod-cover' });
            return wrap(cards[id]);
        },
    };
}

/** 详情批量的通用桩：每条返回完整条目（含 tags），并记账每次批量请求的 id 数。 */
function makeKazumi(batchCalls, mkInfo) {
    return {
        bangumiInfoBatch: async (ids) => {
            batchCalls.push(ids.length);
            const out = {};
            ids.forEach((id) => { out[id] = mkInfo(id); });
            return out;
        },
    };
}

const INFO_OF = (tags, eps = 12) => ({ eps, date: '2020-01-06', tags });

// ---------------------------------------------------------------- DOM 顺序与落位

test('徽标插入顺序：集数徽标 → 分类徽标 → 收藏徽标（DOM 顺序硬断言）', async () => {
    const cards = {};
    const grid = makeGridDom(cards);
    const batchCalls = [];
    const t = loadTimeline({
        escHtml: (s) => String(s),
        Kazumi: makeKazumi(batchCalls, () => INFO_OF([{ name: 'TV', count: 999 }, { name: '恋爱', count: 60 }])),
    });
    t._colStateMap = new Map([['100', 3]]);
    const items = [{ id: 100 }];
    t._attachFavBadges(grid, items);        // 与 _renderGrid 同序：收藏徽标先行
    await t._attachEpBadges(grid, items);   // 话数徽章（异步补挂）
    await t._attachTagBadges(grid, items);  // 分类徽标（异步补挂）
    const html = cards['100'].outerHTML;
    const iEp = html.indexOf('timeline-ep-badge');
    const iTag = html.indexOf('timeline-tag-badge');
    const iFav = html.indexOf('vod-fav-badge');
    assert.ok(iEp >= 0, '话数徽章存在');
    assert.ok(iTag > iEp, '分类徽标在集数徽标之后');
    assert.ok(iFav > iTag, '收藏徽标在分类徽标之后（用户指定位置）');
    assert.match(html, /title="Bangumi 主要分类：恋爱"/);
    assert.match(html, />恋爱<\/span>/);
    // 三枚徽章同处一个行容器（行是 absolute 定位锚点，多于一个即布局错乱）
    assert.equal((html.match(/vod-fav-row/g) || []).length, 1);
});

test('到达顺序无关：分类徽标先到、话数徽章后到，顺序仍是 集数 → 分类 → 收藏', async () => {
    const cards = {};
    const grid = makeGridDom(cards);
    const t = loadTimeline({
        escHtml: (s) => String(s),
        Kazumi: makeKazumi([], () => INFO_OF([{ name: '奇幻', count: 100 }])),
    });
    t._colStateMap = new Map([['100', 2]]);
    const items = [{ id: 100 }];
    t._attachFavBadges(grid, items);
    await t._attachTagBadges(grid, items); // 分类先到（此时行内只有收藏徽标）
    await t._attachEpBadges(grid, items);  // 话数后到（prepend 行首）
    const html = cards['100'].outerHTML;
    assert.ok(html.indexOf('timeline-ep-badge') < html.indexOf('timeline-tag-badge'));
    assert.ok(html.indexOf('timeline-tag-badge') < html.indexOf('vod-fav-badge'));
});

test('未收藏卡：分类徽标自建徽标行并吸回直挂封面的集数徽标（不重复、不重叠）', async () => {
    const cards = {};
    const grid = makeGridDom(cards);
    const t = loadTimeline({
        escHtml: (s) => String(s),
        Kazumi: makeKazumi([], () => INFO_OF([{ name: '日常', count: 300 }])),
    });
    t._colStateMap = new Map(); // 未收藏：_attachFavBadges 零 DOM
    const items = [{ id: 100 }];
    t._attachFavBadges(grid, items);
    await t._attachEpBadges(grid, items);  // 无行 → 话数徽章直挂 .vod-cover（既有行为）
    await t._attachTagBadges(grid, items); // 分类徽标建行并把话数徽章吸回行首
    const html = cards['100'].outerHTML;
    assert.equal((html.match(/timeline-ep-badge/g) || []).length, 1, '集数徽标不重复堆积');
    assert.equal((html.match(/timeline-tag-badge/g) || []).length, 1);
    assert.equal((html.match(/vod-fav-row/g) || []).length, 1);
    assert.ok(html.indexOf('timeline-ep-badge') > html.indexOf('vod-fav-row'), '话数徽章在行内（不再直挂封面）');
    assert.ok(html.indexOf('timeline-tag-badge') > html.indexOf('timeline-ep-badge'));
});

test('无类型标签命中 → 不产生任何节点（不空占位、绝不回退 TV）', async () => {
    const cards = {};
    const grid = makeGridDom(cards);
    const t = loadTimeline({
        escHtml: (s) => String(s),
        Kazumi: makeKazumi([], () => INFO_OF([{ name: 'TV', count: 999 }, { name: '日本', count: 800 }])),
    });
    grid.find('.bangumi-card[data-id="100"] .vod-cover'); // 预置卡面，验证「零改动」而非「零查询」
    await t._attachTagBadges(grid, [{ id: 100 }]);
    assert.equal(cards['100'].outerHTML, '<div class="vod-cover"></div>');
});

test('_attachTagBadges：空列表/无 id 条目零操作零请求；tags 为空数组走回源', async () => {
    const cards = {};
    const grid = makeGridDom(cards);
    const batchCalls = [];
    const t = loadTimeline({
        escHtml: (s) => String(s),
        Kazumi: makeKazumi(batchCalls, () => INFO_OF([{ name: '悬疑', count: 42 }])),
    });
    await t._attachTagBadges(grid, []);
    await t._attachTagBadges(grid, [null, {}, { name: 'x' }]);
    assert.equal(batchCalls.length, 0, '无有效 id 不发请求');
    await t._attachTagBadges(grid, [{ id: 7, tags: [] }]); // 空 tags 视为缺失 → 回源
    assert.deepEqual(batchCalls, [1]);
    assert.match(cards['7'].outerHTML, /timeline-tag-badge/);
});

// ---------------------------------------------------------------- 数据链路

test('分类徽标与话数徽章共享同一次批量回源（零重复请求）', async () => {
    const cards = {};
    const grid = makeGridDom(cards);
    const batchCalls = [];
    const t = loadTimeline({
        escHtml: (s) => String(s),
        Kazumi: makeKazumi(batchCalls, () => INFO_OF([{ name: '战斗', count: 90 }])),
    });
    t._colStateMap = new Map([['100', 2], ['200', 2]]);
    const items = [{ id: 100 }, { id: 200 }];
    t._attachFavBadges(grid, items);
    // 同一 tick 并发两路（与 _renderGrid 的调用序一致）：应共享在途 Promise
    await Promise.all([t._attachEpBadges(grid, items), t._attachTagBadges(grid, items)]);
    assert.deepEqual(batchCalls, [2], '两枚徽标合计只发一次批量请求');
    assert.match(cards['100'].outerHTML, /timeline-ep-badge/);
    assert.match(cards['100'].outerHTML, /timeline-tag-badge/);
});

test('季度检索条目自带 tags → 零批量回源（就地取分类）', async () => {
    const cards = {};
    const grid = makeGridDom(cards);
    const batchCalls = [];
    const t = loadTimeline({
        escHtml: (s) => String(s),
        Kazumi: makeKazumi(batchCalls, () => { throw new Error('不应回源'); }),
    });
    // v0/search/subjects 形态：条目自带 tags（含非类型标签）与 eps
    await t._attachTagBadges(grid, [{ id: 9, tags: [{ name: 'TV', count: 999 }, { name: '日常', count: 300 }] }]);
    assert.equal(batchCalls.length, 0, '自带 tags 不回源');
    assert.match(cards['9'].outerHTML, />日常<\/span>/);
});

test('超过后端单批上限（60）时分批回源——否则第 61 条起被静默截断', async () => {
    const cards = {};
    const grid = makeGridDom(cards);
    const batchCalls = [];
    const t = loadTimeline({
        escHtml: (s) => String(s),
        Kazumi: makeKazumi(batchCalls, () => INFO_OF([{ name: '奇幻', count: 5 }])),
    });
    const items = Array.from({ length: 61 }, (_, i) => ({ id: 1000 + i }));
    await t._attachTagBadges(grid, items);
    assert.deepEqual(batchCalls, [60, 1], '按 60 上限分成两批（串行）');
    assert.match(cards['1060'].outerHTML, /timeline-tag-badge/, '第 61 条也拿到徽标');
});

test('批量补齐失败 → 静默不显示徽标（不外溢、不空占位）', async () => {
    const cards = {};
    const grid = makeGridDom(cards);
    const t = loadTimeline({
        escHtml: (s) => String(s),
        Kazumi: { bangumiInfoBatch: async () => { throw new Error('network down'); } },
    });
    grid.find('.bangumi-card[data-id="100"] .vod-cover');
    await t._attachTagBadges(grid, [{ id: 100 }]); // 不抛
    assert.equal(cards['100'].outerHTML, '<div class="vod-cover"></div>');
    // 失败不被单槽缓存钉死：下一次同集合调用会重试（此处第二次成功，断言重试与恢复）
    let retried = 0;
    const t2 = loadTimeline({
        escHtml: (s) => String(s),
        Kazumi: {
            bangumiInfoBatch: async (ids) => {
                retried++;
                if (retried === 1) throw new Error('first fail');
                const out = {};
                ids.forEach((id) => { out[id] = INFO_OF([{ name: '推理', count: 3 }]); });
                return out;
            },
        },
    });
    const cards2 = {};
    const grid2 = makeGridDom(cards2);
    await t2._attachTagBadges(grid2, [{ id: 5 }]);
    await t2._attachTagBadges(grid2, [{ id: 5 }]);
    assert.equal(retried, 2, '失败后同集合重新请求（不驻留空结果）');
    assert.match(cards2['5'].outerHTML, /timeline-tag-badge/);
});

// ---------------------------------------------------------------- 重挂与集成

test('重挂徽标行（FavHub 广播/收藏映射重建）后分类徽标不丢且位置不漂移', async () => {
    const cards = {};
    const grid = makeGridDom(cards);
    const t = loadTimeline({
        escHtml: (s) => String(s),
        Kazumi: makeKazumi([], () => INFO_OF([{ name: '音乐', count: 700 }])),
    });
    t._colStateMap = new Map([['100', 2]]);
    const items = [{ id: 100 }];
    t._attachFavBadges(grid, items);
    await t._attachEpBadges(grid, items);
    await t._attachTagBadges(grid, items);
    t._attachFavBadges(grid, items); // 重挂（行被删重建）
    const html = cards['100'].outerHTML;
    assert.equal((html.match(/vod-fav-row/g) || []).length, 1);
    assert.match(html, /timeline-tag-badge/, '重挂后分类徽标必须保留');
    const iEp = html.indexOf('timeline-ep-badge');
    const iTag = html.indexOf('timeline-tag-badge');
    const iFav = html.indexOf('vod-fav-badge');
    assert.ok(iEp >= 0 && iEp < iTag && iTag < iFav, '重挂后顺序仍是 集数 → 分类 → 收藏');
    // 重复补挂幂等：同卡再次调用只保留一枚分类徽标（换分类时也是替换而非叠加）
    await t._attachTagBadges(grid, items);
    const html2 = cards['100'].outerHTML;
    assert.equal((html2.match(/timeline-tag-badge/g) || []).length, 1, '重复补挂不叠标签');
});

test('_renderGrid：网格写入后异步补挂分类徽标（不阻塞首屏，失败不影响渲染）', async () => {
    const seen = [];
    const grid = makeGridDom({});
    const t = loadTimeline({
        $: (sel) => {
            if (sel === '#timeline-grid') {
                return { empty() { return this; }, html() { return this; }, find(s) { return grid.find(s); }, on() { return this; } };
            }
            return {
                empty() { return this; }, html() { return this; }, on() { return this; }, val() { return ''; },
                text() { return this; }, append() { return this; }, find() { return { length: 0, on() {} }; },
            };
        },
        pageSizeOf: async () => 20,
        renderPagerBox: () => {},
        bangumiCard: (item) => `<div class="vod-card bangumi-card" data-id="${item.id}"></div>`,
        bangumiNetGuide: () => '<div class="tip-line">guide</div>',
        fitVodTitles: () => {},
        playCardsEnter: () => {},
        escHtml: (s) => String(s),
        warnToast: () => {},
        showLoading: () => {},
        hideLoading: () => {},
        Kazumi: {},
        FavHub: { onChanged: () => () => {} },
        UIState: { get: () => null, set: () => {} },
        localCacheGet: () => null,
        localCacheSet: () => {},
        recGet: async () => [],
        doAction: async () => ({ items: [] }),
    });
    t._attachEpBadges = async () => {};
    t._attachTagBadges = (g, items) => { seen.push(items.map((it) => it.id)); return Promise.resolve(); };
    t._calendar = [{ weekday: { id: 1 }, items: [{ id: 11 }, { id: 22 }] }];
    t._weekday = 1;
    t._page = 1;
    await t._renderGrid();
    assert.deepEqual(seen, [[11, 22]], '_renderGrid 应对当前页条目调用 _attachTagBadges');
});
