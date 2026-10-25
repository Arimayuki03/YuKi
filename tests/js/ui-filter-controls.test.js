'use strict';
/**
 * 界面契约（CSS/HTML 源码锚点）：筛选栏控件圆角、时间筛选器外观、卡片动作按钮
 * 悬停显隐、toast 层级、评分/排名输入框宽度。
 *
 * 为什么要锚定源码而不是只跑 DOM：这些是"看起来没坏、用起来不对"的问题——
 *  - 圆角被同名规则的后者覆盖（.rec-select/.rec-input 曾把 12px 覆盖回 10px）；
 *  - 拖动/悬停类规则被更高或更靠后的规则盖掉（.dragging 输给 .loaded）；
 *  - toast 压在图片浮层底下（点击复制地址"没有任何提示"）。
 * 单测里没有真实合成器与层叠上下文，只能锁住"规则本身写对了"。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const CSS = read('src/renderer/css/ui.css');
const HTML = read('src/renderer/index.html');

test('筛选栏下拉/输入统一使用控件圆角令牌（14px），且后续同名规则不得覆盖回小圆角', () => {
    // 14px 是有意校准过的量级：10→12px 在 36px 高的控件上肉眼几乎无差别（用户反馈
    // 「看起来没实现」），14px 才是一眼能看出圆角的档位。
    assert.match(CSS, /--radius-control:\s*14px;/, '控件圆角令牌存在');
    assert.match(CSS, /\.md-select \{[^}]*border-radius:var\(--radius-control\)/, '.md-select 用控件圆角');
    assert.match(CSS, /\.md-input \{[^}]*border-radius:var\(--radius-control\)/, '.md-input 用控件圆角');
    // 覆盖点（历史上就栽在这几条：后来居上的同名规则把 .md-input/.md-select 的圆角改回 10px）
    for (const sel of ['.rec-select', '.rec-input', '.home-search']) {
        const re = new RegExp(sel.replace('.', '\\.') + ' \\{[^}]*border-radius:var\\(--radius-control\\)');
        assert.match(CSS, re, `${sel} 必须跟随控件圆角`);
    }
});

test('时间筛选器（原生 date 输入）有主题化日历按钮与数字等宽排版', () => {
    assert.match(CSS, /input\[type="date"\]\.md-input::-webkit-calendar-picker-indicator/, '日历按钮定制');
    assert.match(CSS, /html\.dark input\[type="date"\]\.md-input::-webkit-calendar-picker-indicator[\s,][\s\S]{0,400}\{ filter:invert/, '暗色主题反色（深底上可见）');
    assert.match(CSS, /input\[type="date"\]\.md-input[^{]*\{[^}]*font-variant-numeric:tabular-nums/, '日期数字等宽');
    // 日期选择栏加长到 200px（用户要求：yyyy-mm-dd 留足呼吸，不再被裁）
    assert.match(CSS, /\.rec-date \{ width:200px;/, '日期输入宽度');
});

test('评分/排名区间输入框加长到 118px，且去掉原生步进箭头', () => {
    assert.match(CSS, /\.rec-num \{ width:\s*118px;/, '区间输入宽度');
    assert.match(CSS, /input\[type="number"\]\.rec-num::-webkit-inner-spin-button[^{]*\{[^}]*-webkit-appearance:none/, '去掉步进箭头');
});

test('卡片动作按钮（续播 ▶ / 收藏 ⋯）默认隐藏、悬停与菜单展开时浮现', () => {
    const base = CSS.slice(CSS.indexOf('.rec-play-btn, .rec-fav-btn {'), CSS.indexOf('.rec-play-btn, .rec-fav-btn {') + 900);
    assert.match(base, /opacity:0;\s*visibility:hidden;/, '基态不可见');
    assert.match(CSS, /\.vod-card:hover \.rec-play-btn, \.vod-card:hover \.rec-fav-btn/, '鼠标移入卡片浮现');
    assert.match(CSS, /\.rec-fav-btn\.menu-open/, '菜单展开期间按钮常显（否则锚点消失）');
    assert.match(CSS, /@media \(hover: none\)[\s\S]{0,120}\.rec-play-btn, \.rec-fav-btn \{ opacity:1;/, '触摸设备退回常显');
});

test('toast 层级高于图片浮层与人物浮层（否则「已复制图片地址」被盖住看不见）', () => {
    const z = (sel) => {
        const i = CSS.indexOf(sel);
        assert.ok(i >= 0, sel + ' 规则存在');
        const m = /z-index:\s*(\d+)/.exec(CSS.slice(i, i + 400));
        assert.ok(m, sel + ' 声明了 z-index');
        return Number(m[1]);
    };
    const toast = z('#warnToast {');
    const cover = z('#cover-float {');
    const charF = z('#char-float {');
    assert.ok(toast > cover, `toast(${toast}) 必须高于图片浮层(${cover})`);
    assert.ok(toast > charF, `toast(${toast}) 必须高于人物浮层(${charF})`);
    assert.ok(toast < 1999, '不得压过窗口标题栏层（1999/2000）');
});

test('收藏页按钮布局：来源/状态两排 tabs 合并为一行，排序与筛选并入搜索工具条', () => {
    // 静态标记：只剩一排 .rec-bar（带 rec-bar-tabs 与两个分区标签）
    const block = HTML.slice(HTML.indexOf('id="my-panel-favorites"'), HTML.indexOf('id="view-direct"'));
    const bars = (block.match(/class="rec-bar( rec-bar-tabs)?"/g) || []).length;
    assert.equal(bars, 1, '收藏面板只留一排 tabs');
    assert.match(block, /class="rec-bar rec-bar-tabs"/);
    assert.match(block, /<span class="rec-filter-label"[^>]*>来源<\/span>/);
    assert.match(block, /<span class="rec-filter-label"[^>]*>状态<\/span>/);
    // 排序下拉与筛选按钮由 records.js 注入到 .view-toolbar、紧挨搜索框右侧
    const rec = read('src/renderer/js/records.js');
    assert.match(rec, /function recSortFilterHtml/, '控件条片段函数存在');
    assert.match(rec, /\$search\.last\(\)\.after\(controls\)/, '排序/筛选插到搜索框右侧');
    // 多选按钮的位置由 DOM 顺序决定（不再用 order/auto 边距推到最右）：
    // 收藏页在「同步 Bangumi」右侧紧挨着，历史页在「筛选」右侧紧挨着。
    assert.ok(!/margin-left:auto/.test(CSS.slice(CSS.indexOf('收藏/历史工具条排布'), CSS.indexOf('收藏/历史工具条排布') + 800)),
        '工具条不再用 margin-left:auto 把按钮推到右边');
    const html = read('src/renderer/index.html');
    const favBar = html.slice(html.indexOf('id="my-favorites-bgm-sync"'), html.indexOf('id="my-favorites-bgm-sync"') + 400);
    assert.match(favBar, /id="my-favorites-bgm-sync"[\s\S]{0,300}id="my-favorites-multidel"/, '收藏页多选紧挨同步 Bangumi');
    const hisBar = html.slice(html.indexOf('id="view-history-search"'), html.indexOf('id="view-history-search"') + 700);
    assert.match(hisBar, /id="view-history-multidel"[\s\S]{0,200}id="view-history-clear"/, '历史页多选与清空相邻');
});

test('历史页筛选器：面板化（与收藏页同款交互）且面板内下拉不会撑破格子', () => {
    const rec = read('src/renderer/js/records.js');
    assert.match(rec, /function recHistoryPanelHtml/, '历史筛选面板工厂存在');
    assert.match(rec, /id="\$\{viewName\}-filter-btn"/, '工具栏留筛选按钮');
    assert.match(rec, /id="\$\{viewName\}-filter-apply"/, '面板有应用按钮');
    // 面板内控件允许收缩：.md-select 基线 min-width:200px 在窄面板里会横向溢出
    assert.match(CSS, /\.rec-filter-panel \.md-select[^{]*\{[^}]*min-width:0/, '面板内 select 可收缩');
    assert.match(CSS, /\.rec-filter-panel \.rec-select \{[^}]*flex:0 1 200px/, '面板内 select 弹性宽度');
});

test('卡片 ✕/✎ 有悬停反馈（放大 + 主题色底），不再是"移上去毫无变化"', () => {
    const del = CSS.slice(CSS.indexOf('.rec-del {'), CSS.indexOf('.rec-del {') + 900);
    assert.match(del, /transition:[^;]*transform/, '✕ 有 transform 过渡');
    assert.match(CSS, /\.rec-del:hover \{[^}]*background:var\(--md-error\)/, '✕ 悬停变危险色');
    assert.match(CSS, /\.rec-edit:hover \{[^}]*background:var\(--md-primary\)/, '✎ 悬停变主题色');
    assert.match(CSS, /\.rec-del:hover, \.rec-edit:hover \{[^}]*transform:scale/, '悬停放大');
});

test('卡片动作按钮：点击后不因 :focus-within 常显（移开鼠标必须消失）', () => {
    // 用户报「点六态按钮后移鼠标，六态按钮和播放按钮不隐藏」——根因是 :focus-within：
    // 鼠标点击会把焦点留在按钮上，只要卡片内还有焦点，两枚按钮就一直可见。
    const idx = CSS.indexOf('.vod-card:hover .rec-play-btn');
    const block = CSS.slice(idx, CSS.indexOf('}', idx) + 1); // 只取规则本体，别把下方解释性注释算进来
    assert.ok(!/:focus-within/.test(block), '浮现条件里不得再用 :focus-within');
    assert.match(block, /\.rec-fav-btn\.menu-open/, '菜单展开期间仍要常显（锚点不能消失）');
    assert.match(CSS, /\.rec-play-btn:focus-visible, \.rec-fav-btn:focus-visible/, '键盘可达性由 :focus-visible 兜住');
});

test('四枚卡片按钮（▶ ⋯ ✕ ✎）悬停动效一致：同款过渡 + 同款放大/回弹', () => {
    const grab = (sel) => {
        const i = CSS.indexOf(sel);
        assert.ok(i >= 0, sel + ' 规则存在');
        return CSS.slice(i, CSS.indexOf('}', i) + 1); // 整条规则（含多行 transition 列表）
    };
    const play = grab('.rec-play-btn, .rec-fav-btn {');
    const del = grab('.rec-del {');
    const edit = grab('.rec-edit {');
    for (const [name, block] of [['▶/⋯', play], ['✕', del], ['✎', edit]]) {
        assert.match(block, /transition:[^;]*transform/, `${name} 过渡含 transform`);
        assert.match(block, /transition:[^;]*box-shadow/, `${name} 过渡含 box-shadow`);
        assert.match(block, /transition:[^;]*opacity/, `${name} 过渡含 opacity`);
        assert.match(block, /var\(--dur-fast\) var\(--ease\)/, `${name} 用统一时长/缓动`);
    }
    assert.match(CSS, /\.rec-play-btn:hover, \.rec-fav-btn:hover \{[^}]*transform:scale\(1\.15\)/, '▶/⋯ 悬停放大 1.15');
    assert.match(CSS, /\.rec-del:hover, \.rec-edit:hover \{[^}]*transform:scale\(1\.15\)/, '✕/✎ 悬停放大 1.15（同一档位）');
    assert.match(CSS, /\.rec-play-btn:active, \.rec-fav-btn:active \{[^}]*scale\(0\.94\)/, '▶/⋯ 回弹');
    assert.match(CSS, /\.rec-del:active, \.rec-edit:active \{[^}]*scale\(0\.94\)/, '✕/✎ 回弹（同一档位）');
});
