'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

/** 在 VM 中加载 common.js（顶层仅 $(document).on 一个调用，用最小 $ stub）。 */
function loadCommon() {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/js/common.js'), 'utf8');
    const context = {
        console, Map, Set, Promise, Date, Math, JSON, String, Array, parseInt, parseFloat,
        setTimeout, clearTimeout, URLSearchParams,
        $: () => ({ on() { return this; } }),
        window: {},
        document: {},
        IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
        fetch: async () => ({ ok: true, text: async () => '' }),
        AbortSignal: { timeout: () => ({}) },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__chain = vodCoverChain; globalThis.__next = coverChainNext; globalThis.__ph = vodPlaceholder;`,
        context, { filename: 'common.js' });
    return context;
}

/** 模拟 <img> DOM 元素（dataset/classList/src）；cardSource 提供时模拟 closest('.vod-card')。 */
function fakeImg(html, cardSource) {
    const src = (html.match(/src="([^"]*)"/) || [])[1] || '';
    const fb = (html.match(/data-fb="([^"]*)"/) || [])[1] || '';
    const img = {
        dataset: { fb }, src,
        classList: { add() {} },
        attrs: {},
        setAttribute(name, value) { this.attrs[name] = String(value); },
    };
    img.closest = () => (cardSource !== undefined ? { dataset: { source: cardSource } } : null);
    return img;
}

test('vodCoverChain：按序尝试多来源，失败逐级切换，最终落占位图（T74）', () => {
    const ctx = loadCommon();
    const html = ctx.__chain(['https://s4.anilist.co/x.jpg', 'https://api.trace.moe/image/abc'], true);
    const img = fakeImg(html);
    assert.equal(img.src, 'https://s4.anilist.co/x.jpg');   // 主图 = AniList 封面
    assert.equal(img.dataset.fb, 'https://api.trace.moe/image/abc'); // 兜底 = trace.moe 帧

    // 主图加载失败 → 切到帧
    ctx.__next(img);
    assert.equal(img.src, 'https://api.trace.moe/image/abc');
    assert.equal(img.dataset.fb, '');
    // 帧也失败 → 落占位图（不再留空框）
    ctx.__next(img);
    assert.equal(img.src, ctx.__ph());
});

test('vodCoverChain：无候选源时直接占位图并标 data-cover-missing', () => {
    const ctx = loadCommon();
    const html = ctx.__chain([], true);
    assert.match(html, new RegExp(ctx.__ph()));
    assert.match(html, /data-cover-missing="1"/);
});

test('vodCoverChain：图片带淡入与加载策略', () => {
    const ctx = loadCommon();
    const html = ctx.__chain(['https://a/b.jpg'], true);
    assert.match(html, /loading="eager"/);
    assert.match(html, /referrerpolicy="no-referrer"/);
    assert.match(html, /onload="coverFadeIn\(this\)"/);
});

test('coverChainNext：Kazumi/Bangumi 卡链耗尽补标 data-cover-missing（供补拉管线重试，T78）', () => {
    const ctx = loadCommon();
    const html = ctx.__chain(['https://a/b.jpg'], true); // 单候选 → 一次失败即耗尽
    const kazumi = fakeImg(html, 'kazumi:baimao');
    ctx.__next(kazumi);
    assert.equal(kazumi.src, ctx.__ph());
    assert.equal(kazumi.attrs['data-cover-missing'], '1');

    const bangumi = fakeImg(html, 'bangumi');
    ctx.__next(bangumi);
    assert.equal(bangumi.attrs['data-cover-missing'], '1');

    // 非 Bangumi 系卡片保持原行为：不标 missing
    const plain = fakeImg(html, 'cspby');
    ctx.__next(plain);
    assert.equal(plain.attrs['data-cover-missing'], undefined);

    // 无卡片上下文（如以图搜番结果）不抛错、不标记
    const orphan = fakeImg(html);
    ctx.__next(orphan);
    assert.equal(orphan.src, ctx.__ph());
    assert.equal(orphan.attrs['data-cover-missing'], undefined);
});
