/**
 * 测试有效性守卫：断言必须真的会被执行。
 *
 * 回归背景（2026-09 审查 P0）：download-remove.test.js 把三条断言写在**未被 await 的
 * `.then()`** 里。node:test 在同步 test 回调返回时即判定用例通过，`.then()` 中的断言
 * 在「用例已结束」之后才跑，失败只落成文件级 unhandledRejection，用例本身永远打 ✔。
 * 实测把期望值改成错误字符串，该用例仍报 pass——整个 remove 顺序契约（防 aria2 边写
 * 边删）实际是裸奔的。
 *
 * 这类失效无法靠「跑一遍看绿不绿」发现，只能静态拦。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('node:path');

const TESTS_DIR = __dirname;

function testFiles() {
    return fs.readdirSync(TESTS_DIR)
        .filter((f) => f.endsWith('.test.js'))
        .map((f) => path.join(TESTS_DIR, f));
}

/** 从 openIdx（指向 '{'）起做花括号配对，返回体文本与结束位置；忽略字符串/注释内的括号。 */
function matchBraces(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i += 1) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
        if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; if (!i) break; continue; }
        if (c === '\'' || c === '"' || c === '`') {
            const q = c;
            i += 1;
            while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
            continue;
        }
        if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (depth === 0) return { body: src.slice(openIdx + 1, i), end: i }; }
    }
    return { body: src.slice(openIdx + 1), end: src.length };
}

/** 取包含 pos 的语句起点：回退到上一个顶层分号 / 换行缩进回落处。 */
function statementStart(src, pos) {
    let i = pos;
    while (i > 0) {
        const c = src[i - 1];
        if (c === ';' || c === '{' || c === '}' || c === '\n') break;
        i -= 1;
    }
    // 允许跨行拼接的语句：再吞掉行首缩进
    while (i < src.length && /\s/.test(src[i])) i += 1;
    return i;
}

/** 把注释替换成等长空白（保留偏移与行号），避免说明文字里的 `.then(` 被当成代码。 */
function stripComments(src) {
    const out = src.split('');
    let i = 0;
    const blank = (from, to) => {
        for (let k = from; k < to && k < out.length; k += 1) {
            if (out[k] !== '\n') out[k] = ' ';
        }
    };
    while (i < src.length) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') {
            const end = src.indexOf('\n', i);
            blank(i, end < 0 ? src.length : end);
            i = end < 0 ? src.length : end;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end < 0 ? src.length : end + 2;
            blank(i, stop);
            i = stop;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') {
            const q = c;
            let j = i + 1;
            while (j < src.length && src[j] !== q) { if (src[j] === '\\') j += 1; j += 1; }
            // 字符串内容同样置空：测试标题里写的「.then()」字样不是代码
            blank(i, Math.min(j + 1, src.length));
            i = j + 1;
            continue;
        }
        i += 1;
    }
    return out.join('');
}

test('断言不得写在无人等待的 .then() 里（否则用例永远打勾）', () => {
    const offenders = [];
    for (const file of testFiles()) {
        const raw = fs.readFileSync(file, 'utf8');
        const src = stripComments(raw);
        const re = /\.then\s*\(/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            const thenIdx = m.index;
            // 定位回调体的 { —— 形如 .then(() => { / .then(function () { / .then(async () => {
            const after = src.slice(thenIdx, thenIdx + 120);
            const braceRel = after.indexOf('{');
            if (braceRel < 0) continue;
            const openIdx = thenIdx + braceRel;
            const { body } = matchBraces(src, openIdx);
            // 只看断言确实写在**这个回调体内部**的情形（不再用固定行窗口，避免把
            // 相邻行的断言误算进来）
            if (!/\bassert\.[A-Za-z]+\s*\(/.test(body)) continue;
            // 该 .then 链的返回值若被 await / return / 赋值 / push 收集，node:test
            // 会等到它，断言有效——只有「裸表达式语句」才是无人等待
            const start = statementStart(src, thenIdx);
            const stmt = src.slice(start, thenIdx);
            if (/\bawait\b[^;]*$/.test(stmt) || /^\s*return\b/.test(src.slice(start, thenIdx + 40))
                || /=\s*$/.test(stmt) || /\.push\s*\($|\.push\s*\([^)]*$/.test(stmt)
                || /\breturn\b/.test(stmt)) continue;
            const line = src.slice(0, thenIdx).split(/\r?\n/).length;
            offenders.push(`${path.basename(file)}:${line}`);
            re.lastIndex = openIdx + body.length;
        }
    }
    assert.deepEqual(offenders, [],
        '以下位置的断言处在无人 await/return 的 .then() 中，永远不会使用例失败：\n  '
        + offenders.join('\n  ')
        + '\n改法：把 test 回调标为 async，直接 await 被测流程后再断言。');
});

test('test 回调体内不得出现悬空的未 await 异步调用后立即断言', () => {
    // 典型误写：(async () => {...})() 不带 await，随后同步 assert
    const offenders = [];
    for (const file of testFiles()) {
        const src = fs.readFileSync(file, 'utf8');
        const lines = src.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            // 形如 `})();` 结尾的 IIFE 异步调用且行首不是 await
            if (/^\s*\(async\s*\(\)\s*=>\s*\{/.test(line)) {
                offenders.push(`${path.basename(file)}:${i + 1}`);
            }
        }
    }
    assert.deepEqual(offenders, [],
        '以下用例用 (async () => {...})() 起了一个没人等的异步块：\n  ' + offenders.join('\n  ')
        + '\n应改为 async test + await。');
});

test('测试文件不得整体被 skip/only 静默旁路', () => {
    const offenders = [];
    for (const file of testFiles()) {
        const src = fs.readFileSync(file, 'utf8');
        if (/\btest\.(skip|todo)\s*\(/.test(src)) {
            offenders.push(path.basename(file) + '（test.skip/todo）');
        }
        if (/\btest\.(only)\s*\(/.test(src)) {
            offenders.push(path.basename(file) + '（test.only 会让其它用例不跑）');
        }
    }
    assert.deepEqual(offenders, [],
        '存在被旁路的测试文件，会让「全绿」失真：\n  ' + offenders.join('\n  '));
});
