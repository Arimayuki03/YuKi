'use strict';
/**
 * A-02 统一 skeleton 骨架（第一阶段基建）单元测试：
 * common.js skeletonHtml(kind, opts) 三形态结构 + 无效 kind 兜底 + ui.css 无 shimmer。
 *
 * 加载方式：fs.readFileSync + node:vm，注入最小全局桩（照抄 common-utils.test.js
 * 的写法；skeletonHtml 是纯字符串拼装函数，实际只依赖函数声明提升，桩仅保证
 * common.js 其余顶层代码可加载）。
 *
 * 防回归点：
 * - 类名体系锁定 .sk-* 前缀（ui.css 三形态样式与其一一对应，改名即失配）；
 * - kind 无效静默回落 'card'（骨架是过渡态视觉，不因拼写失误中断加载主流程）；
 * - ui.css 永远不出现 sk-shimmer——§1.1 裁决「静态灰块 + 一次性淡入」，shimmer
 *   仅是未来可选增强，此断言防未来误加循环动画破坏裁决。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '../../src/renderer/js/common.js');
const CSS = path.join(__dirname, '../../src/renderer/css/ui.css');

/** 在 VM 中加载 common.js，只取 skeletonHtml（桩同 common-utils.test.js 的极简集）。 */
function loadCommon() {
    const source = fs.readFileSync(SRC, 'utf8');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, Number,
        parseInt, parseFloat, setTimeout, clearTimeout, URLSearchParams,
        $: () => ({ length: 0, on() {}, off() {}, each() {}, find() { return this; }, children() { return this; }, addClass() { return this; }, removeClass() { return this; }, hasClass() { return false; }, html() { return this; }, text() { return this; }, css() { return this; }, empty() { return this; } }),
        document: {
            addEventListener() {}, removeEventListener() {},
            querySelector: () => null, querySelectorAll: () => [],
            getElementById: () => null,
            createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false } }),
            documentElement: {
                classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                style: { setProperty() {}, removeProperty() {} },
                dataset: {},
            },
            body: { style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {} }, dataset: {} },
            head: { appendChild() {} },
        },
        window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        fetch: async () => ({ ok: true, text: async () => '' }),
        AbortSignal: { timeout: () => ({}) },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}
;globalThis.__api = { skeletonHtml };`, context, { filename: 'common.js' });
    return context.__api;
}

const { skeletonHtml } = loadCommon();

// ① 三形态返回结构正确（类名/块数）

test('hero 形态：sk-root sk-hero 容器 + 封面块 + 信息区（2 标题条 + 3 meta 行）', () => {
    const html = skeletonHtml('hero');
    assert.ok(html.includes('class="sk-root sk-hero"'), '根容器类名');
    assert.ok(html.includes('sk-hero-cover'), '封面大块');
    assert.ok(html.includes('sk-hero-info'), '信息卡容器');
    assert.equal((html.match(/sk-hero-title(?=[" ])/g) || []).length, 2, '标题条两行（-short 变体不计入）');
    assert.equal((html.match(/sk-hero-meta(?=[" ])/g) || []).length, 3, 'meta 行三条');
    assert.equal((html.match(/sk-line /g) || []).length, 5, '信息条均为 sk-line');
    assert.ok(html.includes('aria-hidden="true"'), '无内容语义，读屏跳过');
});

test('card 形态：sk-cards 网格 + count 个 sk-card（图块 + 两行文字条），默认 6', () => {
    const html = skeletonHtml('card');
    assert.ok(html.includes('class="sk-root sk-cards"'), '根容器类名');
    assert.equal((html.match(/class="sk-card"/g) || []).length, 6, '默认 6 张卡');
    assert.equal((html.match(/sk-card-cover/g) || []).length, 6, '每卡一个图块');
    assert.equal((html.match(/sk-card-name(?=[" ])/g) || []).length, 12, '每卡两行文字条（-short 变体不计入）');

    const n3 = skeletonHtml('card', { count: 3 });
    assert.equal((n3.match(/class="sk-card"/g) || []).length, 3, 'count=3 生效');
    const n20 = skeletonHtml('card', { count: 20 });
    assert.equal((n20.match(/class="sk-card"/g) || []).length, 12, 'count 越界上取 12');
    const n0 = skeletonHtml('card', { count: 0 });
    assert.equal((n0.match(/class="sk-card"/g) || []).length, 1, 'count 下取 1（不为 0）');
    const nBad = skeletonHtml('card', { count: 'abc' });
    assert.equal((nBad.match(/class="sk-card"/g) || []).length, 6, '非法 count 回落默认 6');
});

test('comment 形态：sk-comment 卡（28px 圆头像 + 名字条 + 两行文字条）', () => {
    const html = skeletonHtml('comment');
    assert.ok(html.includes('class="sk-root sk-comment"'), '根容器类名');
    assert.ok(html.includes('sk-comment-avatar'), '头像圆块');
    assert.ok(html.includes('sk-comment-name'), '名字条');
    assert.equal((html.match(/sk-comment-text(?=[" ])/g) || []).length, 2, '正文条两行（-short 变体不计入）');
    assert.ok(!html.includes('sk-head-line'), '缺省不垫头部工具条（第一阶段结构不变）');
});

test('episode 形态：sk-eps 网格 + count 个 sk-ep（集号条 + 名称条），默认 8', () => {
    const html = skeletonHtml('episode');
    assert.ok(html.includes('class="sk-root sk-eps"'), '根容器类名');
    assert.equal((html.match(/class="sk-ep"/g) || []).length, 8, '默认 8 格（4 列 × 两行量级）');
    assert.equal((html.match(/sk-ep-no(?=[" ])/g) || []).length, 8, '每格集号条');
    assert.equal((html.match(/sk-ep-name(?=[" ])/g) || []).length, 8, '每格名称条');
    const n4 = skeletonHtml('episode', { count: 4 });
    assert.equal((n4.match(/class="sk-ep"/g) || []).length, 4, 'count=4 生效');
    const nBad = skeletonHtml('episode', { count: 0 });
    assert.equal((nBad.match(/class="sk-ep"/g) || []).length, 1, 'count 下取 1');
    assert.equal((html.match(/class="sk-root/g) || []).length, 1, '唯一 sk-root（整组一次淡入）');
});

test('comment header 变体：整组唯一 sk-root.sk-tab 包头部行 + 列表体（骨架高度匹配）', () => {
    // header:true = 计数胶囊 + 按钮（对齐吐槽工具条 / 选集讨论页签头）
    const h1 = skeletonHtml('comment', { count: 4, header: true });
    assert.equal((h1.match(/class="sk-root/g) || []).length, 1, '带头部仍是唯一 sk-root（整组一次淡入）');
    assert.ok(h1.includes('sk-root sk-tab'), '组合根容器 sk-tab');
    assert.ok(h1.includes('sk-head-line'), '头部工具条行');
    assert.equal((h1.match(/sk-chip(?=[" ])/g) || []).length, 1, '计数胶囊一条');
    assert.equal((h1.match(/sk-btn(?=[" ])/g) || []).length, 1, '按钮条一条');
    assert.equal((h1.match(/sk-comment-avatar/g) || []).length, 4, '列表体 4 行不变');
    // header:'chip' = 仅计数胶囊一行（对齐选集讨论列表首行 .ep-comments-count）
    const chip = skeletonHtml('comment', { count: 3, header: 'chip' });
    assert.equal((chip.match(/class="sk-root/g) || []).length, 1, 'chip 变体同样唯一 sk-root');
    assert.ok(chip.includes('sk-root sk-tab') && chip.includes('sk-head-line'), 'chip 变体仍包头部行');
    assert.equal((chip.match(/sk-chip(?=[" ])/g) || []).length, 1, 'chip 变体仅计数胶囊');
    assert.ok(!chip.includes('sk-btn'), 'chip 变体无按钮条');
    assert.equal((chip.match(/sk-comment-avatar/g) || []).length, 3, '列表体 3 行不变');
    // 头部行在列表体之前（结构对齐真实渲染：工具条 → 评论卡）
    assert.ok(chip.indexOf('sk-head-line') < chip.indexOf('sk-comment-avatar'), '头部行先于列表体');
});

// ② kind 无效时兜底（回落 card——论证见 skeletonHtml JSDoc：占位渲染不应抛错中断主流程）

test('kind 无效/缺省回落 card 形态（静默兜底，不抛错）', () => {
    assert.doesNotThrow(() => skeletonHtml('nonsense'));
    const bad = skeletonHtml('nonsense');
    assert.ok(bad.includes('sk-cards'), '未知 kind 回落 card');
    assert.equal(bad, skeletonHtml('card'), '与显式 card 输出一致');
    const empty = skeletonHtml('');
    assert.ok(empty.includes('sk-cards'), '空串回落 card');
    const undef = skeletonHtml();
    assert.ok(undef.includes('sk-cards'), '缺省回落 card');
    assert.doesNotThrow(() => skeletonHtml(null, { count: 2 }));
});

// ③ 纯静态无 shimmer：断言 ui.css 无 sk-shimmer 类 / 循环动画（防未来误加，§1.1 裁决锁定）

test('ui.css 骨架区无 shimmer/循环动画（静态灰块裁决防回归）', () => {
    const css = fs.readFileSync(CSS, 'utf8');
    assert.ok(css.includes('skFadeIn'), '骨架样式已落地（skFadeIn 一次性淡入）');
    assert.ok(!css.includes('sk-shimmer'), '不得出现 sk-shimmer 类');
    // sk- 相关规则块内不得有 infinite（循环）动画——全文件层面 skeleton 无限循环即违规
    const skRules = css.split('}').filter((chunk) => chunk.includes('.sk-'));
    for (const chunk of skRules) {
        assert.ok(!/animation[^;]*infinite/.test(chunk), `sk- 规则不得含 infinite 循环：${chunk.slice(0, 80)}`);
    }
    assert.ok(/html:not\(\.glass-on\) \.sk-root \{ animation:skFadeIn/.test(css), '淡入门控走 html:not(.glass-on)（T54 同因先例）');
    // 三态底色必须走令牌而非硬编码色值
    assert.ok(!/\.sk-[a-z-]+\s*\{[^}]*#[0-9a-fA-F]{3,8}/.test(css), '骨架块不硬编码色值（走 --md-* 令牌）');
});
