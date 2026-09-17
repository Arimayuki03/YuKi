/**
 * 渲染层跨文件全局契约测试。
 *
 * 回归背景（2026-09 全项目审查 P0）：player.js 的播放失败弹窗调用
 * `openSettingsPanel('pan' | 'player')`，但整个仓库**从未定义过**这个函数——
 * panels.js 导出的是 initSettingsPanel。三重机制合谋把这个 bug 藏住了：
 *   1. `if (typeof openSettingsPanel === 'function')` 守卫让缺失时静默无操作；
 *   2. player.js 文件头写了 `/* global ... openSettingsPanel *\/`，eslint 的
 *      no-undef 因此直接采信「它存在」，连 warning 都不产生；
 *   3. CI 当时根本不跑 lint（见 .github/workflows/ci.yml）。
 * 于是「配置网盘 Cookie」这个播放失败后最重要的自助入口点了完全没反应，
 * 而所有自动化检查全绿。
 *
 * 本文件把第 2 条那个「自我声明、无人核实」的洞补上：渲染层任何脚本用
 * /* global *\/ 声明过的名字，必须能在某个渲染层脚本的顶层定义里找到，
 * 或在 eslint 配置的已知全局白名单里。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, '../../src/renderer/js');
const THIRD_PARTY = new Set(['jquery.min.js']);

/** 读全部渲染层脚本源码（跳过第三方压缩库）。 */
function readRendererScripts() {
    return fs.readdirSync(RENDERER_DIR)
        .filter((f) => f.endsWith('.js') && !THIRD_PARTY.has(f))
        .map((f) => ({ name: f, src: fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8') }));
}

/**
 * 顶层声明 = 经典脚本的全局绑定（本项目无构建工具，<script> 顺序加载共享脚本作用域）。
 * 只认行首缩进为 0 的 function / const / let / var，与「脚本顶层」语义一致；
 * 嵌套在函数或 IIFE 内部的同名声明不算全局，正好是我们想要的严格度。
 */
function topLevelDeclarations(src) {
    const found = new Set();
    const patterns = [
        /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
        /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
        /^(?:const|let|var)\s*\{([^}]*)\}/gm,   // 解构：逐个取标识符
        // IIFE 模块通过 root.X / window.X / globalThis.X 挂出的全局（如 UIState、App
        // 命名空间），同样是运行时真实存在的全局，必须计入
        /(?:^|[^\w$.])(?:root|window|globalThis)\.([A-Za-z_$][\w$]*)\s*=(?!=)/gm,
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(src)) !== null) {
            if (m[1] && m[1].includes(',')) {
                for (const part of m[1].split(',')) {
                    const id = part.trim().split(/[:=\s]/)[0];
                    if (/^[A-Za-z_$][\w$]*$/.test(id)) found.add(id);
                }
            } else if (m[1]) {
                found.add(m[1]);
            }
        }
    }
    return found;
}

/** 收集文件头 /* global a, b, c *\/ 声明的名字。 */
function globalDirectives(src) {
    const names = [];
    const re = /\/\*\s*global\s+([\s\S]*?)\*\//g;
    let m;
    while ((m = re.exec(src)) !== null) {
        for (const raw of m[1].split(',')) {
            const name = raw.trim().split(/\s+/)[0];
            if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
        }
    }
    return names;
}

/** eslint 配置里的已知全局（browser + jquery + 跨页遗留白名单）。 */
function knownGlobals() {
    const config = require('../../eslint.config.js');
    const rendererBlock = config.find((block) => (block.files || [])
        .some((f) => String(f).startsWith('src/renderer')));
    return new Set(Object.keys((rendererBlock && rendererBlock.languageOptions
        && rendererBlock.languageOptions.globals) || {}));
}

test('渲染层 /* global */ 声明的名字必须真的有定义（跨文件契约防失配）', () => {
    const scripts = readRendererScripts();
    const defined = new Set();
    for (const { src } of scripts) {
        for (const name of topLevelDeclarations(src)) defined.add(name);
    }
    const known = knownGlobals();
    const dangling = [];
    for (const { name, src } of scripts) {
        for (const declared of globalDirectives(src)) {
            if (!defined.has(declared) && !known.has(declared)) {
                dangling.push(`${name} → ${declared}`);
            }
        }
    }
    assert.deepEqual(dangling, [],
        '以下 /* global */ 声明在所有渲染层脚本里都找不到顶层定义（点了没反应的静默失效源头）：\n  '
        + dangling.join('\n  '));
});

test('openSettingsPanel 已定义并由 panels.js 导出（P0 回归锚点）', () => {
    const panelsSrc = fs.readFileSync(path.join(RENDERER_DIR, 'panels.js'), 'utf8');
    assert.match(panelsSrc, /^function openSettingsPanel\(/m,
        'panels.js 必须顶层定义 openSettingsPanel（player.js 依赖它）');
    assert.match(panelsSrc, /root\.YUKI\.panels\s*=\s*\{[^}]*\bopenSettingsPanel\b/,
        'openSettingsPanel 必须挂到 YUKI.panels 导出，供跨模块显式访问');
});

test('播放失败弹窗不得再用 typeof 守卫静默吞掉缺失函数', () => {
    const playerSrc = fs.readFileSync(path.join(RENDERER_DIR, 'player.js'), 'utf8');
    // 允许保留 typeof 判断，但缺失分支必须有 console.error（静默失败是本次 P0 的根因）
    const silent = /if\s*\(\s*typeof\s+openSettingsPanel\s*===\s*'function'\s*\)\s*openSettingsPanel/;
    assert.equal(silent.test(playerSrc), false,
        'openSettingsPanel 缺失时必须显式告警，不能静默 return');
    assert.match(playerSrc, /console\.error\([^)]*openSettingsPanel/,
        'player.js 需为 openSettingsPanel 缺失提供显式告警路径');
});

test('player.js 传给 openSettingsPanel 的分类名可被解析（别名或真实大类）', () => {
    const panelsSrc = fs.readFileSync(path.join(RENDERER_DIR, 'panels.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    const realCats = new Set([...html.matchAll(/data-cat="([^"]+)"/g)].map((m) => m[1]));
    assert.ok(realCats.size >= 8, 'index.html 应能解析出设置大类，实际 ' + realCats.size);
    const aliasBlock = panelsSrc.match(/const SETTINGS_CAT_ALIAS\s*=\s*\{([^}]*)\}/);
    assert.ok(aliasBlock, 'panels.js 需有 SETTINGS_CAT_ALIAS 映射');
    const alias = {};
    for (const pair of aliasBlock[1].split(',')) {
        const [k, v] = pair.split(':').map((s) => s && s.trim().replace(/['"]/g, ''));
        if (k && v) alias[k] = v;
    }
    const playerSrc = fs.readFileSync(path.join(RENDERER_DIR, 'player.js'), 'utf8');
    const used = [...playerSrc.matchAll(/gotoSettings\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(used.length >= 2, '应能解析出 player.js 使用的分类，实际 ' + used.length);
    for (const cat of used) {
        const resolved = alias[cat] || cat;
        assert.ok(realCats.has(resolved),
            `player.js 请求的分类「${cat}」解析为「${resolved}」，但设置页不存在该大类`);
    }
});
