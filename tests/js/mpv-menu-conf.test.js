// 组件测试：mpv-menu-conf.js — 中文右键菜单定义（menu.conf）的格式合法性
//
// select.lua 对格式极其挑剔：字段用 TAB 分隔、层级靠行首空白长度判定、
// 条件表达式（checked=/hidden=/disabled=）语法错误会让整个菜单打不开。
// 此处对生成结果做结构级校验，并抽查命令列未被翻译改动。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { MENU_CONF_ZH } = require('../../src/main/mpv-menu-conf');

const LINES = MENU_CONF_ZH.split('\n').filter((l) => l !== '');

test('MENU_CONF_ZH: 以换行结尾、无 CRLF 混入', () => {
    assert.ok(MENU_CONF_ZH.endsWith('\n'));
    assert.ok(!MENU_CONF_ZH.includes('\r'));
});

test('MENU_CONF_ZH: 非空行的文案字段非空且不含 & 助记符', () => {
    for (const line of LINES) {
        const indent = line.match(/^ */)[0].length;
        const rest = line.slice(indent);
        assert.ok(indent % 4 === 0, `缩进应为 4 空格的倍数：${line}`);
        const label = rest.split('\t')[0];
        assert.ok(label.length > 0, `文案字段为空：${line}`);
        assert.ok(!label.includes('&'), `不应残留 & 助记符：${line}`);
    }
});

test('MENU_CONF_ZH: 层级只逐级递进（select.lua 不允许跨级加深）', () => {
    let prev = -1; // 前一个非空行的缩进空格数；-1 表示尚未见到首行
    for (const line of LINES) {
        const cur = line.match(/^ */)[0].length;
        if (prev < 0) assert.equal(cur, 0, '首个条目应为顶级');
        else if (cur > prev) assert.equal(cur, prev + 4, `跨级加深：${line}`);
        prev = cur;
    }
});

test('MENU_CONF_ZH: 动态子菜单标记齐全（$ 开头第二字段不可改动）', () => {
    const markers = [
        '$playlist', '$tracks', '$video-tracks', '$audio-tracks', '$sub-tracks',
        '$secondary-sub-tracks', '$chapters', '$editions', '$audio-devices', '$profiles',
    ];
    for (const m of markers) {
        assert.ok(LINES.some((l) => l.split('\t')[1] === m), `缺少动态子菜单标记 ${m}`);
    }
});

test('MENU_CONF_ZH: 命令与条件表达式原样保留（抽查）', () => {
    // 顶层动作
    assert.ok(LINES.includes('退出\tquit'));
    assert.ok(LINES.includes('播放\tcycle pause\thidden=not pause and not idle_active\tdisabled=idle_active'));
    // 复杂条件逐字保留（属性名/比较式不可翻译）
    assert.ok(
        LINES.some((l) => l.includes('checked=hwdec_current and hwdec_current ~= "no"')),
        '硬件解码条目的 checked 表达式被改动');
    assert.ok(
        LINES.some((l) => l.includes('checked=math.abs(get("current-window-scale", 0) - 1) < 0.1')),
        '窗口缩放条目的 checked 表达式被改动');
    assert.ok(
        LINES.some((l) => l.includes('disabled=not sid or p["current-tracks/sub/codec"] == "dvb_subtitle"')),
        '按字幕行跳转条目的 disabled 表达式被改动');
});
