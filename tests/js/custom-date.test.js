'use strict';
/**
 * 日期筛选自绘日历（js/custom-date.js）单测。
 *
 * 用户要求「时间筛选器展开状态需要美化」：原生 <input type="date"> 展开的日历由
 * Chromium 自己绘制、CSS 无钩子。本组测试锁三块：
 *   ① 纯函数：ISO 解析/格式化、月偏移（跨年）、月长、42 格月视图（周一起对齐、
 *      前后补月、闰年 2 月）；
 *   ② 命中范围：只接管 input[type=date]（disabled/readOnly/data-native-date 退出）；
 *   ③ 行为：指针按下被 preventDefault（原生日历不再弹出）→ 弹层渲染 42 格 →
 *      点某天写回 value 并派发 input/change；Esc/滚轮关闭；min/max 之外的日期禁用。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('src/renderer/js/custom-date.js');
const CSS = read('src/renderer/css/ui.css');
const HTML = read('src/renderer/index.html');

// ---------------------------------------------------------------- 迷你 DOM 桩

function makeClassList(el) {
    const set = new Set();
    return {
        add(...cs) { cs.forEach((c) => { if (c) set.add(c); }); el._cls = Array.from(set).join(' '); },
        remove(...cs) { cs.forEach((c) => set.delete(c)); el._cls = Array.from(set).join(' '); },
        contains(c) { return set.has(c); },
        _set: set,
        // className 赋值时同步（真实 DOM 里 className 与 classList 是同一份数据）
        syncFrom(str) {
            set.clear();
            String(str || '').split(/\s+/).forEach((c) => { if (c) set.add(c); });
            el._cls = Array.from(set).join(' ');
        },
    };
}

function makeEl(tag, attrs) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        children: [], style: {}, attrs: Object.assign({}, attrs || {}),
        listeners: {}, isConnected: true, parentElement: null, _cls: '', _html: '',
        className: '', value: '', type: attrs && attrs.type ? attrs.type : '',
    };
    el.classList = makeClassList(el);
    // className 与 classList 同源（组件里用 className 赋值、用 closest('.x') 查）
    let _className = '';
    Object.defineProperty(el, 'className', {
        configurable: true,
        get() { return _className; },
        set(v) { _className = String(v || ''); el.classList.syncFrom(_className); },
    });
    Object.defineProperty(el, 'innerHTML', {
        get() { return el._html; },
        set(v) {
            el._html = String(v);
            // 迷你解析：抽出带 data-iso 的日期格与 data-nav/data-act 按钮
            el.children = [];
            const re = /<(button)[^>]*?(data-iso="[^"]*"|data-nav="[^"]*"|data-act="[^"]*")[^>]*>/g;
            let m;
            while ((m = re.exec(el._html)) !== null) {
                const child = makeEl('button');
                const a = /data-iso="([^"]*)"/.exec(m[0]);
                const n = /data-nav="([^"]*)"/.exec(m[0]);
                const c = /data-act="([^"]*)"/.exec(m[0]);
                if (a) child.attrs['data-iso'] = a[1];
                if (n) child.attrs['data-nav'] = n[1];
                if (c) child.attrs['data-act'] = c[1];
                if (/\sdisabled[\s>]/.test(m[0])) { child.disabled = true; child.attrs.disabled = ''; } // 真实 DOM：属性与 IDL 双向反射
                child.parentElement = el;
                el.children.push(child);
            }
        },
    });
    el.appendChild = (c) => { c.parentElement = el; c.parentNode = el; el.children.push(c); return c; };
    el.insertBefore = (c, ref) => {
        const i = el.children.indexOf(ref);
        if (i >= 0) el.children.splice(i, 0, c); else el.children.push(c);
        c.parentElement = el; c.parentNode = el;
        return c;
    };
    Object.defineProperty(el, 'parentNode', { configurable: true, get() { return el.parentElement; }, set(v) { el.parentElement = v; } });
    el.contains = (node) => {
        if (node === el) return true;
        if (!node) return false;
        let cur = node;
        while (cur) { if (cur === el) return true; cur = cur.parentElement; }
        return false;
    };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
    el.hasAttribute = (k) => Object.prototype.hasOwnProperty.call(el.attrs, k);
    el.removeAttribute = (k) => { delete el.attrs[k]; };
    el.addEventListener = (t, fn) => { (el.listeners[t] = el.listeners[t] || []).push(fn); };
    el.querySelectorAll = (sel) => {
        const s = String(sel);
        if (s === 'input[type="date"]') {
            const out = [];
            const walk = (node) => {
                (node.children || []).forEach((c) => { if (c.tagName === 'INPUT' && c.type === 'date') out.push(c); walk(c); });
            };
            walk(el);
            return out;
        }
        if (s.charAt(0) === '.' && s.indexOf('[') < 0) {
            const cls = s.slice(1);
            return el.children.filter((c) => c.classList && c.classList.contains(cls));
        }
        if (s === '.yuki-date-cell') return el.children.filter((c) => 'data-iso' in c.attrs);
        if (s.charAt(0) === '[' && s.endsWith(']')) {
            const k = s.slice(1, -1);
            return el.children.filter((c) => Object.prototype.hasOwnProperty.call(c.attrs, k));
        }
        return [];
    };
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
    el.closest = (sel) => {
        const list = String(sel).split(',').map((s) => s.trim());
        let cur = el;
        while (cur) {
            const hit = list.some((s) => {
                if (s === 'input') return cur.tagName === 'INPUT';
                if (s === 'button') return cur.tagName === 'BUTTON';
                if (s.charAt(0) === '[') {
                    const k = s.slice(1, -1);
                    return Object.prototype.hasOwnProperty.call(cur.attrs, k);
                }
                if (s.charAt(0) === '.') return !!(cur.classList && cur.classList.contains(s.slice(1)));
                return cur.tagName === s.toUpperCase();
            });
            if (hit) return cur;
            cur = cur.parentElement;
        }
        return null;
    };
    el.getBoundingClientRect = () => ({ left: 100, top: 50, right: 300, bottom: 86, width: 200, height: 36 });
    el.focus = () => { el._focused = true; };
    el.dispatchEvent = (ev) => { (el.listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; };
    return el;
}

function loadCustomDate(inputAttrs) {
    const listeners = { doc: {}, win: {} };
    const body = makeEl('body');
    const documentStub = {
        body,
        documentElement: makeEl('html'),
        addEventListener(type, fn) { (listeners.doc[type] = listeners.doc[type] || []).push(fn); },
        createElement: (tag) => makeEl(tag),
    };
    const context = {
        console, Math, Date, JSON, String, Array, Object, Number, Map, Set, RegExp, Promise,
        setTimeout, clearTimeout,
        document: documentStub,
        innerWidth: 1200, innerHeight: 800,
        addEventListener(type, fn) { (listeners.win[type] = listeners.win[type] || []).push(fn); },
        Event: function Event(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); },
        getComputedStyle: () => ({ zoom: '1' }),
        escHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${SRC}\n;globalThis.__D = YukiCustomDate;`, context, { filename: 'custom-date.js' });
    const input = makeEl('input', Object.assign({ type: 'date' }, inputAttrs || {}));
    return { D: context.__D, body, listeners, input };
}

// ---------------------------------------------------------------- 纯函数

test('ISO 解析/格式化：非法日期不猜（2 月 30 日不算合法）', () => {
    const { D } = loadCustomDate();
    assert.equal(JSON.stringify(D._parseISO('2026-10-05')), JSON.stringify({ y: 2026, m: 10, d: 5 }));
    assert.equal(D._parseISO(''), null);
    assert.equal(D._parseISO('2026-13-01'), null);
    assert.equal(D._parseISO('2026-02-30'), null);
    assert.equal(D._parseISO('2026-02-29'), null, '2026 不是闰年');
    assert.equal(JSON.stringify(D._parseISO('2024-02-29')), JSON.stringify({ y: 2024, m: 2, d: 29 }));
    assert.equal(D._fmtISO(2026, 1, 5), '2026-01-05');
});

test('月偏移跨年、月长（含闰年）', () => {
    const { D } = loadCustomDate();
    assert.equal(JSON.stringify(D._addMonths(2026, 1, -1)), JSON.stringify({ y: 2025, m: 12 }));
    assert.equal(JSON.stringify(D._addMonths(2026, 12, 1)), JSON.stringify({ y: 2027, m: 1 }));
    assert.equal(D._daysInMonth(2026, 2), 28);
    assert.equal(D._daysInMonth(2024, 2), 29);
    assert.equal(D._daysInMonth(2026, 4), 30);
});

test('月视图：42 格、周一对齐、前后补月、月份内日期连续', () => {
    const { D } = loadCustomDate();
    // 2026-10-01 是周四 → 前面补 3 天（9/28 9/29 9/30）
    const grid = D._buildMonthGrid(2026, 10);
    assert.equal(grid.length, 42);
    assert.equal(grid[0].iso, '2026-09-28');
    assert.equal(grid[0].inMonth, false);
    assert.equal(grid[3].iso, '2026-10-01');
    assert.equal(grid[3].inMonth, true);
    const inMonth = grid.filter((c) => c.inMonth);
    assert.equal(inMonth.length, 31, '10 月 31 天');
    assert.equal(inMonth[0].iso, '2026-10-01');
    assert.equal(inMonth[30].iso, '2026-10-31');
    // 首格必须是周一（2 月 2026 从周日开始 → 补 6 天）
    const feb = D._buildMonthGrid(2026, 2);
    assert.equal(feb[0].iso, '2026-01-26', '2026-02-01 是周日 → 前面补到周一 1/26');
    assert.equal(feb.filter((c) => c.inMonth).length, 28);
});

test('min/max 越界判定（字符串即日期序）', () => {
    const { D } = loadCustomDate();
    assert.equal(D._outOfRange('2026-10-01', '2026-10-05', ''), true);
    assert.equal(D._outOfRange('2026-10-06', '2026-10-05', ''), false);
    assert.equal(D._outOfRange('2026-10-06', '', '2026-10-05'), true);
    assert.equal(D._outOfRange('2025-12-31', '2026-01-01', '2026-12-31'), true);
    assert.equal(D._outOfRange('2026-06-01', '', ''), false);
});

test('_matchDateInput：只接管可编辑的 input[type=date]', () => {
    const { D } = loadCustomDate();
    const ok = makeEl('input', { type: 'date' });
    assert.equal(D._matchDateInput(ok), ok);
    const native = makeEl('input', { type: 'date', 'data-native-date': '' });
    assert.equal(D._matchDateInput(native), null, 'data-native-date 显式退出');
    const dis = makeEl('input', { type: 'date' });
    dis.disabled = true;
    assert.equal(D._matchDateInput(dis), null);
    const ro = makeEl('input', { type: 'date' });
    ro.readOnly = true;
    assert.equal(D._matchDateInput(ro), null);
    const text = makeEl('input', { type: 'text' });
    assert.equal(D._matchDateInput(text), null);
});

// ---------------------------------------------------------------- 行为

test('按下日期框：preventDefault（原生日历不弹）+ 自绘日历打开并渲染 42 格', () => {
    const { D, body, listeners, input } = loadCustomDate();
    input.attrs.value = '2026-10-05';
    input.value = '2026-10-05';
    let prevented = false;
    listeners.doc.pointerdown[0]({ target: input, preventDefault() { prevented = true; } });
    assert.equal(prevented, true, '按下被取消 → 系统日历不会出现');
    assert.equal(D.isOpen(), true);
    const panel = D._panel();
    assert.ok(body.children.indexOf(panel) >= 0, '弹层挂在 body');
    const cells = panel.querySelectorAll('[data-iso]');
    assert.equal(cells.length, 42, '6×7 网格');
    const title = /<span class="yuki-date-title">([^<]*)</.exec(panel.innerHTML);
    assert.equal(title && title[1], '2026 年 10 月', '标题跟随当前值所在月');
});

test('点某天：写回 value 并派发 input/change；同值不派发', () => {
    const { D, listeners, input } = loadCustomDate();
    input.value = '2026-10-05';
    listeners.doc.pointerdown[0]({ target: input, preventDefault() { } });
    const panel = D._panel();
    const seen = [];
    input.addEventListener('change', (e) => seen.push(e.type));
    input.addEventListener('input', (e) => seen.push(e.type));
    const cell = panel.querySelectorAll('[data-iso]').find((c) => c.attrs['data-iso'] === '2026-10-12');
    listeners.doc.click[0]({ target: cell, preventDefault() { }, stopPropagation() { } });
    assert.equal(input.value, '2026-10-12');
    assert.equal(JSON.stringify(seen), JSON.stringify(['input', 'change']));
    assert.equal(D.isOpen(), false, '选完收起');

    // 再开一次，点同一天 → 不派发 change
    seen.length = 0;
    listeners.doc.pointerdown[0]({ target: input, preventDefault() { } });
    const same = D._panel().querySelectorAll('[data-iso]').find((c) => c.attrs['data-iso'] === '2026-10-12');
    listeners.doc.click[0]({ target: same, preventDefault() { }, stopPropagation() { } });
    assert.equal(seen.length, 0, '同值不派发（与原生一致）');
});

test('min/max 之外的日期渲染为 disabled，点了不生效', () => {
    const { D, listeners, input } = loadCustomDate({ min: '2026-10-10', max: '2026-10-20' });
    input.value = '2026-10-15';
    listeners.doc.pointerdown[0]({ target: input, preventDefault() { } });
    const cells = D._panel().querySelectorAll('[data-iso]');
    const early = cells.find((c) => c.attrs['data-iso'] === '2026-10-05');
    const mid = cells.find((c) => c.attrs['data-iso'] === '2026-10-15');
    assert.equal(early.disabled, true, '低于 min 的日期禁用');
    assert.equal(mid.disabled, undefined, '区间内可用');
    listeners.doc.click[0]({ target: early, preventDefault() { }, stopPropagation() { } });
    assert.equal(input.value, '2026-10-15', '禁用日点击不写值');
});

test('导航/今天/清除/关闭 四条按钮链路', () => {
    const { D, listeners, input } = loadCustomDate();
    input.value = '2026-10-05';
    listeners.doc.pointerdown[0]({ target: input, preventDefault() { } });
    const panel = D._panel();
    // 下个月
    const next = panel.querySelectorAll('[data-nav]').find((b) => b.attrs['data-nav'] === '1');
    listeners.doc.click[0]({ target: next, preventDefault() { }, stopPropagation() { } });
    assert.match(D._panel().innerHTML, /2026 年 11 月/);
    // 上一年
    const prevYear = D._panel().querySelectorAll('[data-nav]').find((b) => b.attrs['data-nav'] === '-12');
    listeners.doc.click[0]({ target: prevYear, preventDefault() { }, stopPropagation() { } });
    assert.match(D._panel().innerHTML, /2025 年 11 月/);
    // 清除 → value 空 + change
    let changed = 0;
    input.addEventListener('change', () => { changed += 1; });
    const clearBtn = D._panel().querySelectorAll('[data-act]').find((b) => b.attrs['data-act'] === 'clear');
    listeners.doc.click[0]({ target: clearBtn, preventDefault() { }, stopPropagation() { } });
    assert.equal(input.value, '');
    assert.equal(changed, 1, '清除也派发 change（页面据此重筛）');
    assert.equal(D.isOpen(), false);
});

test('Esc 关闭；页面滚动关闭', () => {
    const { D, listeners, input } = loadCustomDate();
    input.value = '2026-10-05';
    listeners.doc.pointerdown[0]({ target: input, preventDefault() { } });
    assert.equal(D.isOpen(), true);
    listeners.doc.keydown[0]({ key: 'Escape', preventDefault() { }, stopPropagation() { } });
    assert.equal(D.isOpen(), false, 'Esc 关闭');
    listeners.doc.pointerdown[0]({ target: input, preventDefault() { } });
    listeners.win.scroll[0]({ target: makeEl('div') });
    assert.equal(D.isOpen(), false, '页面滚动关闭');
});

// ---------------------------------------------------------------- 样式与接线

test('样式锚点：日历弹层圆角/主题色/层级与各状态齐全，页面已加载组件', () => {
    const panelRule = CSS.slice(CSS.indexOf('.yuki-date-panel {'), CSS.indexOf('.yuki-date-panel {') + 420);
    assert.match(panelRule, /border-radius:var\(--radius-lg\)/, '圆角');
    assert.match(panelRule, /background:var\(--md-surface-container-high\)/, '主题色底');
    assert.match(panelRule, /z-index:1340/, '与下拉弹层同层（高于对话框/浮层）');
    assert.match(CSS, /\.yuki-date-cell\.is-selected[\s\S]{0,80}background:var\(--md-primary\)/, '选中日主题色');
    assert.match(CSS, /\.yuki-date-cell\.is-today \{[^}]*accent-border/, '今天有描边标记');
    assert.match(CSS, /\.yuki-date-cell\.is-disabled \{[^}]*cursor:not-allowed/, '禁用日不可点');
    assert.match(HTML, /<script src="js\/custom-date\.js" defer><\/script>/, '页面加载自绘日历');
});

// ---------------------------------------------------------------- 装饰层（彻底封死原生日历）

test('decorate：把日期输入套进 wrap 并盖一层透明触发按钮（幂等）', () => {
    const { D, input } = loadCustomDate();
    const host = makeEl('div');
    host.appendChild(input);
    input.type = 'date';
    D.decorate(input);
    assert.equal(input.getAttribute('data-yuki-date'), '1', '打上已装饰标记');
    const wrap = input.parentElement;
    assert.ok(String(wrap.className).indexOf('yuki-date-wrap') === 0, '外层 wrap（并继承 input 原有的样式类）');
    assert.equal(input.className, 'yuki-date-input', 'input 退化为隐形值容器');
    assert.equal(wrap.tagName, 'SPAN');
    const trigger = wrap.children.find((c) => c.tagName === 'BUTTON');
    assert.ok(trigger, '透明触发按钮存在');
    assert.equal(trigger.getAttribute('tabindex'), '-1', '触发层不进 Tab 序（键盘仍落在 input）');
    // 幂等：再装饰一次不会多套一层
    D.decorate(input);
    assert.equal(input.parentElement, wrap, '重复装饰不改结构');
});

test('点透明触发层即打开自绘日历（不再有原生面板的机会）', () => {
    const { D, listeners, input } = loadCustomDate();
    const host = makeEl('div');
    host.appendChild(input);
    D.decorate(input);
    const wrap = input.parentElement;
    const trigger = wrap.children.find((c) => c.tagName === 'BUTTON');
    let prevented = false;
    listeners.doc.pointerdown[0]({ target: trigger, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(D.isOpen(), true, '自绘日历打开');
    assert.equal(D._panel().querySelectorAll('[data-iso]').length, 42);
});

test('样式锚点：wrap 内的原生 input 关闭指针事件（这才是原生日历不再出现的保证）', () => {
    const wrapRule = CSS.slice(CSS.indexOf('.yuki-date-wrap {'), CSS.indexOf('.yuki-date-wrap {') + 200);
    assert.match(wrapRule, /position:relative/, 'wrap 作为盒子的定位上下文');
    assert.match(wrapRule, /display:flex; align-items:center/, 'wrap 用 flex 让文字/图标垂直居中');
    assert.match(CSS, /\.yuki-date-wrap > \.yuki-date-input \{[^}]*opacity:0; pointer-events:none/,
        '原生 input 完全隐形且不接指针（原生日历与分段文字都不会出现）');
    assert.match(CSS, /\.yuki-date-wrap > \.yuki-date-trigger \{[^}]*position:absolute; inset:0/, '触发层盖满输入框');
    // 组件启动即装饰（首帧就不再是原生可点状态）
    const src = read('src/renderer/js/custom-date.js');
    assert.match(src, /decorateAll\(\);/, 'init 阶段装饰全部日期输入');
    assert.match(src, /MutationObserver/, '动态注入的日期输入也会被装饰');
});

// ---------------------------------------------------------------- 取消输入功能

test('decorate：日期框设为只读（键盘/分段编辑失效），并渲染占位/值标签', () => {
    const { D, input } = loadCustomDate();
    const host = makeEl('div');
    host.appendChild(input);
    D.decorate(input);
    assert.equal(input.readOnly, true, '只读：用户改不动值');
    assert.equal(input.getAttribute('aria-readonly'), 'true');
    assert.equal(input.getAttribute('inputmode'), 'none');
    const wrap = input.parentElement;
    const label = wrap.children.find((c) => c.className === 'yuki-date-label');
    assert.ok(label, '显示层标签存在');
    assert.equal(label.textContent, '选择日期', '空值显示占位文案');
    assert.equal(wrap.getAttribute('data-empty'), '1', '空态标记（占位用弱化色）');
    // 图标：原生 indicator 在 appearance:none 下根本不渲染 → 必须自绘（像素截图实证）
    assert.ok(wrap.children.some((c) => c.className === 'yuki-date-icon'), '自绘日历图标存在');
});

test('标签随值同步：选日/清空/页面直接写 .val() 都要更新', () => {
    const { D, listeners, input } = loadCustomDate();
    const host = makeEl('div');
    host.appendChild(input);
    D.decorate(input);
    const wrap = input.parentElement;
    const label = wrap.children.find((c) => c.className === 'yuki-date-label');

    // ① 页面代码直接写值（重置筛选就是这么干的，不派发事件）
    input.value = '2026-10-08';
    assert.equal(label.textContent, '2026-10-08', '直接赋值也同步标签');
    assert.equal(wrap.getAttribute('data-empty'), '0');

    // ② 走日历选日
    listeners.doc.pointerdown[0]({ target: input, preventDefault() { } });
    const cell = D._panel().querySelectorAll('[data-iso]').find((c) => c.attrs['data-iso'] === '2026-10-09');
    listeners.doc.click[0]({ target: cell, preventDefault() { }, stopPropagation() { } });
    assert.equal(label.textContent, '2026-10-09');

    // ③ 清除
    listeners.doc.pointerdown[0]({ target: input, preventDefault() { } });
    const clearBtn = D._panel().querySelectorAll('[data-act]').find((b) => b.attrs['data-act'] === 'clear');
    listeners.doc.click[0]({ target: clearBtn, preventDefault() { }, stopPropagation() { } });
    assert.equal(label.textContent, '选择日期', '清空后回到占位');
    assert.equal(wrap.getAttribute('data-empty'), '1');
});

test('样式锚点：wrap 即盒子、文字/图标走流内居中（只读选择器）', () => {
    // 三次失败尝试的最终结论：原生 input 必须整体隐形（opacity:0），否则 Chromium 在
    // appearance:none 下会把日期文字画在**顶部**，和任何居中方案都会错位。
    assert.match(CSS, /\.yuki-date-wrap > \.yuki-date-input \{[^}]*opacity:0; pointer-events:none/,
        '原生 input 隐形且不接指针');
    assert.match(CSS, /\.yuki-date-wrap > \.yuki-date-input::-webkit-datetime-edit \{ display:none; \}/,
        '原生 年/月/日 分段整体不绘制');
    assert.match(CSS, /\.yuki-date-wrap > \.yuki-date-input::-webkit-calendar-picker-indicator \{ display:none; \}/,
        '原生日历按钮关掉（与自绘图标互斥，避免重复）');
    // 盒子与居中：wrap 是 flex、gap 8；标签在流内；图标靠右
    const wrapRule = CSS.slice(CSS.indexOf('.yuki-date-wrap {'), CSS.indexOf('.yuki-date-wrap {') + 200);
    assert.match(wrapRule, /display:flex; align-items:center/, 'wrap 用 flex 垂直居中');
    const labelRule = CSS.slice(CSS.indexOf('.yuki-date-label {'), CSS.indexOf('.yuki-date-label {') + 400);
    assert.match(labelRule, /flex:1 1 auto/, '标签占据剩余宽度');
    assert.ok(!/position:absolute/.test(labelRule), '标签不再绝对定位（叠在原生输入上必然错位）');
    assert.match(CSS, /\.yuki-date-icon \{[^}]*margin-left:auto/, '图标靠右且同处流内');
    assert.match(CSS, /\.yuki-date-wrap\[data-empty="1"\] > \.yuki-date-label \{[^}]*on-surface-variant/, '空态占位弱化');
    assert.match(CSS, /\.yuki-date-wrap:focus-within \{[^}]*accent-ring/, '焦点反馈由 wrap 承担');
});
