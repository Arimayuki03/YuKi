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
    vm.runInContext(`${source}\n;globalThis.__cover = bangumiCover; globalThis.__resize = bangumiResizeUrl;`,
        context, { filename: 'common.js' });
    return context;
}

const IMAGES = {
    large: 'https://lain.bgm.tv/pic/cover/l/aa/bb/1_x.jpg',
    common: 'https://lain.bgm.tv/pic/cover/c/aa/bb/1_x.jpg',
    medium: 'https://lain.bgm.tv/pic/cover/m/aa/bb/1_x.jpg',
    small: 'https://lain.bgm.tv/pic/cover/s/aa/bb/1_x.jpg',
    grid: 'https://lain.bgm.tv/pic/cover/g/aa/bb/1_x.jpg',
};

test('bangumiCover：网格/卡片尺寸取 common（避免 1080p large 降采样锯齿，T75）', () => {
    const { __cover } = loadCommon();
    assert.equal(__cover(IMAGES, 'card'), IMAGES.common);
    assert.equal(__cover(IMAGES, 'grid'), IMAGES.common);
});

test('bangumiCover：详情大图尺寸取 large（T75）', () => {
    const { __cover } = loadCommon();
    assert.equal(__cover(IMAGES, 'detail'), IMAGES.large);
});

test('bangumiCover：card 兜底链 common→medium→large→small→grid', () => {
    const { __cover } = loadCommon();
    assert.equal(__cover({ medium: IMAGES.medium, large: IMAGES.large }, 'card'), IMAGES.medium);
    assert.equal(__cover({ large: IMAGES.large, small: IMAGES.small }, 'card'), IMAGES.large);
    assert.equal(__cover({ small: IMAGES.small, grid: IMAGES.grid }, 'card'), IMAGES.small);
    assert.equal(__cover({ grid: IMAGES.grid }, 'card'), IMAGES.grid);
});

test('bangumiCover：detail 兜底链 large→common→medium→small→grid', () => {
    const { __cover } = loadCommon();
    assert.equal(__cover({ common: IMAGES.common, medium: IMAGES.medium }, 'detail'), IMAGES.common);
    assert.equal(__cover({ grid: IMAGES.grid }, 'detail'), IMAGES.grid);
});

test('bangumiCover：未知/缺省 size 视为 card', () => {
    const { __cover } = loadCommon();
    assert.equal(__cover(IMAGES), IMAGES.common);
    assert.equal(__cover(IMAGES, 'whatever'), IMAGES.common);
});

test('bangumiCover：空/非法输入返回空串', () => {
    const { __cover } = loadCommon();
    assert.equal(__cover(null, 'card'), '');
    assert.equal(__cover(undefined, 'detail'), '');
    assert.equal(__cover({}, 'card'), '');
    assert.equal(__cover('', 'card'), '');
});

test('bangumiCover：旧缓存裸 large URL 迁移——card 降级到 common（路径段 /l/→/c/）', () => {
    const { __cover } = loadCommon();
    // 历史 localStorage 存的是 large URL 字符串
    assert.equal(__cover(IMAGES.large, 'card'), IMAGES.common);
    assert.equal(__cover(IMAGES.large, 'grid'), IMAGES.common);
});

test('bangumiCover：旧缓存裸 URL 在 detail 尺寸保持原样（大图不降级）', () => {
    const { __cover } = loadCommon();
    assert.equal(__cover(IMAGES.large, 'detail'), IMAGES.large);
});

test('bangumiCover：非 lain.bgm.tv 格式的裸 URL 原样返回（优雅容错）', () => {
    const { __cover } = loadCommon();
    const other = 'https://example.com/cover.jpg';
    assert.equal(__cover(other, 'card'), other);
});

test('bangumiResizeUrl：仅替换 /pic/cover/{lcmgs}/ 尺寸段', () => {
    const { __resize } = loadCommon();
    assert.equal(__resize(IMAGES.large, 'common'), IMAGES.common);
    assert.equal(__resize(IMAGES.large, 'medium'), IMAGES.medium);
    assert.equal(__resize('https://example.com/x.jpg', 'common'), 'https://example.com/x.jpg');
    assert.equal(__resize('', 'common'), '');
});

// ---- T78 回归：lain CDN 缩放由 /r/{宽}/ 前缀承担，段固定为 l；r 前缀 + 非 l 段返回 HTTP 400 ----

test('bangumiResizeUrl：API 形式（/r/宽/l/）card 变体保持合法组合，不再产出 r+非l 段', () => {
    const { __resize } = loadCommon();
    const api = 'https://lain.bangumi.pro/r/400/pic/cover/l/13/c5/400602_ZI8Y9.jpg';
    assert.equal(__resize(api, 'card'), api); // card=common 宽度 400，幂等且合法
    assert.equal(
        __resize('https://lain.bgm.tv/r/800/pic/cover/l/a/b/1.jpg', 'card'),
        'https://lain.bgm.tv/r/400/pic/cover/l/a/b/1.jpg');
});

test('bangumiResizeUrl：API 形式各变体按 r 宽度前缀映射（large 移除前缀）', () => {
    const { __resize } = loadCommon();
    const base = 'https://lain.bgm.tv/r/400/pic/cover/l/a/b/1.jpg';
    assert.equal(__resize(base, 'medium'), 'https://lain.bgm.tv/r/800/pic/cover/l/a/b/1.jpg');
    assert.equal(__resize(base, 'small'), 'https://lain.bgm.tv/r/200/pic/cover/l/a/b/1.jpg');
    assert.equal(__resize(base, 'grid'), 'https://lain.bgm.tv/r/100/pic/cover/l/a/b/1.jpg');
    assert.equal(__resize(base, 'large'), 'https://lain.bgm.tv/pic/cover/l/a/b/1.jpg');
});

test('bangumiResizeUrl：已持久化的损坏组合（r 前缀+非 l 段）就地自愈为段 l', () => {
    const { __resize } = loadCommon();
    assert.equal(
        __resize('https://lain.bangumi.pro/r/400/pic/cover/c/3c/ec/247_MnPPU.jpg', 'card'),
        'https://lain.bangumi.pro/r/400/pic/cover/l/3c/ec/247_MnPPU.jpg');
});
