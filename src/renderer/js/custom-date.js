/**
 * custom-date.js — 日期筛选框的**自绘日历弹层**。
 *
 * 背景与 custom-select.js 同源：<input type="date"> 展开后的日历面板由 Chromium 自己
 * 绘制（Windows 上是原生日历弹窗），CSS 没有任何钩子——主题色、圆角、字号、暗色模式
 * 一律进不去。用户要求「时间筛选器展开状态需要美化」，唯一做法是自己画日历。
 *
 * 设计取舍（与 custom-select 完全一致）：**不替换、不隐藏原生 input**。
 *   - input 仍是唯一的值容器：jQuery 的 .val() 读写、页面的 .on('change') 绑定、
 *     min/max 属性联动（Bangumi 筛选里起止日期互设上下界）全部照旧，零同步问题；
 *   - 指针按下时 preventDefault + 自绘日历 → 原生日历不会弹出；
 *   - 选日写回 value 并派发 input + change（与原生 input 行为一致）。
 *
 * 作用范围：input[type="date"] （datetime-local/time/month 仍走原生，它们没有
 * 统一的日历语义，自绘反而更容易出错；需要时加 data-native-date 显式退出）。
 *
 * 「取消输入功能」（用户要求）：日期框只作为**选择器**存在——原生 input 被设为
 * readOnly（键盘也改不动），字段上显示的是我们自己渲染的 `YYYY-MM-DD` 标签或
 * 「选择日期」占位，点一下就开日历，不存在"半截输入/分段编辑/年·月·日 待填"这类
 * 困惑。input 仍是值容器（.val()/change/min-max 语义不变），只是失去输入能力。
 *
 * ⚠ 为什么还要「包装 + 透明触发层」：只靠 pointerdown/mousedown 的 preventDefault
 * 并不能可靠阻止 Chromium 打开原生日期面板（实测用户机上仍会弹出默认日历，两个
 * 日历叠在一起）。稳妥做法是让原生 input **收不到指针事件**：外面套一层
 * `<span class="yuki-date-wrap">`，再盖一个透明 button（.yuki-date-trigger）接住
 * 点击——input 上 pointer-events:none，原生面板永远没有机会弹出；输入框本身仍可
 * 用 Tab 聚焦、键盘输入，值容器语义完好（.val()/change/min-max 全部照旧）。
 */
/* global escHtml */
(function (root) {
    'use strict';
    const doc = root.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;

    const PANEL_ID = 'yuki-date-panel';
    const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']; // 周一起（isoweekday 口径）
    const VIEWPORT_PAD = 8;
    const GAP = 6;
    const CELL_W = 36;
    const CELL_H = 34;

    let panelEl = null;
    let state = null; // { input, view: {y, m}, sel: 'YYYY-MM-DD'|'', min, max, focusIso }

    // ------------------------------------------------------------ 纯函数（单测面）

    function pad2(n) { return String(n).padStart(2, '0'); }

    /** 'YYYY-MM-DD' → {y,m,d}；非法/空返回 null（m 为 1-12）。 */
    function parseISO(s) {
        const str = String(s == null ? '' : s).trim();
        const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return null;
        const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        const dt = new Date(y, mo - 1, d);
        if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
        return { y, m: mo, d };
    }

    /** {y,m,d} → 'YYYY-MM-DD'（m 为 1-12）。 */
    function fmtISO(y, m, d) {
        return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
    }

    /** 月偏移（m 为 1-12，delta 可负可正）。 */
    function addMonths(y, m, delta) {
        const total = (y * 12 + (m - 1)) + Number(delta || 0);
        return { y: Math.floor(total / 12), m: (total % 12) + 1 };
    }

    function daysInMonth(y, m) {
        return new Date(y, m, 0).getDate(); // m 为 1-12：下月第 0 天 = 本月最后一天
    }

    /** 某天是周几（1=周一 … 7=周日）。 */
    function isoWeekday(y, m, d) {
        const w = new Date(y, m - 1, d).getDay();
        return w === 0 ? 7 : w;
    }

    /**
     * 生成 6×7 = 42 格的月视图（首格对齐周一）。
     * 返回 [{ y,m,d, iso, inMonth, weekday }]；调用方再叠加 today/selected/disabled。
     */
    function buildMonthGrid(y, m, todayISO) {
        const first = isoWeekday(y, m, 1);      // 本月 1 号是周几
        const lead = first - 1;                 // 前面要补几天（上月）
        const out = [];
        const prev = addMonths(y, m, -1);
        const prevDays = daysInMonth(prev.y, prev.m);
        for (let i = lead - 1; i >= 0; i--) {
            const d = prevDays - i;
            out.push({ y: prev.y, m: prev.m, d, iso: fmtISO(prev.y, prev.m, d), inMonth: false });
        }
        const cur = daysInMonth(y, m);
        for (let d = 1; d <= cur; d++) {
            out.push({ y, m, d, iso: fmtISO(y, m, d), inMonth: true });
        }
        const next = addMonths(y, m, 1);
        let d2 = 1;
        while (out.length < 42) { out.push({ y: next.y, m: next.m, d: d2, iso: fmtISO(next.y, next.m, d2), inMonth: false }); d2++; }
        void todayISO;
        return out.slice(0, 42);
    }

    function monthLabel(y, m) { return `${y} 年 ${m} 月`; }

    /** 当前本地日期 ISO（今天）。 */
    function todayISO() {
        const now = new Date();
        return fmtISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
    }

    /** input 的 min/max（ISO 或 ''）。 */
    function boundsOf(input) {
        return {
            min: parseISO(input && input.getAttribute && input.getAttribute('min')) ? String(input.getAttribute('min')).slice(0, 10) : '',
            max: parseISO(input && input.getAttribute && input.getAttribute('max')) ? String(input.getAttribute('max')).slice(0, 10) : '',
        };
    }

    /** 该日是否在 [min,max] 之外（字符串比较即日期比较）。 */
    function outOfRange(iso, min, max) {
        if (min && iso < min) return true;
        if (max && iso > max) return true;
        return false;
    }

    // ------------------------------------------------------------ DOM

    function esc(s) {
        if (typeof escHtml === 'function') return escHtml(s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function ensurePanel() {
        if (panelEl && panelEl.isConnected !== false) return panelEl;
        const el = doc.createElement('div');
        el.id = PANEL_ID;
        el.className = 'yuki-date-panel';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', '选择日期');
        el.setAttribute('data-yuki-date-ui', '');
        el.style.display = 'none';
        doc.body.appendChild(el);
        panelEl = el;
        return el;
    }

    function isPanelNode(el) {
        return !!(panelEl && el && (el === panelEl || (typeof panelEl.contains === 'function' && panelEl.contains(el))));
    }

    function isOpen() { return !!(panelEl && panelEl.classList.contains('show')); }

    function rootZoom() {
        try {
            const z = parseFloat(root.getComputedStyle(doc.documentElement).zoom);
            return (Number.isFinite(z) && z > 0) ? z : 1;
        } catch (e) { return 1; }
    }

    /** 字段上显示的文本：有值显示 ISO（与筛选 chip 同口径），空值显示占位。 */
    function labelTextOf(value) {
        const cur = parseISO(value);
        return cur ? fmtISO(cur.y, cur.m, cur.d) : '选择日期';
    }

    /** 同步 wrap 上的显示标签与空态标记（值被页面代码改掉时也要跟上）。 */
    function syncLabel(input) {
        const wrap = input && input.parentElement;
        if (!wrap || !wrap.classList || !wrap.classList.contains('yuki-date-wrap')) return;
        const label = wrap.querySelector ? wrap.querySelector('.yuki-date-label') : null;
        const val = String(input.value || '');
        if (label) label.textContent = labelTextOf(val);
        const empty = parseISO(val) ? '0' : '1';
        if (wrap.getAttribute && wrap.getAttribute('data-empty') !== empty) wrap.setAttribute('data-empty', empty);
    }

    /** 让 `input.value = x` / `.val(x)` 也触发一次标签同步（页面在「重置筛选」时
     *  直接写值、不派发事件，只靠 change 监听会留下过期文案）。 */
    function patchValueSync(input) {
        const proto = Object.getPrototypeOf(input);
        const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        try {
            if (desc && desc.get && desc.set) {
                Object.defineProperty(input, 'value', {
                    configurable: true,
                    get() { return desc.get.call(input); },
                    set(v) { desc.set.call(input, v); syncLabel(input); },
                });
            } else {
                let store = input.value;
                Object.defineProperty(input, 'value', {
                    configurable: true,
                    get() { return store; },
                    set(v) { store = v; syncLabel(input); },
                });
            }
        } catch (e) { /* 打不了补丁：退回 change 监听（少数环境） */ }
    }

    /** 装饰：给原生日期输入套一层 wrap + 标签层 + 透明触发层（幂等）。 */
    function decorate(input) {
        if (!input || !input.parentNode || typeof doc.createElement !== 'function') return input;
        if (input.hasAttribute && input.hasAttribute('data-yuki-date')) return input;
        try {
            const wrap = doc.createElement('span');
            // 视觉外壳整体搬到 wrap 上：把 input 原有的类（.md-input/.rec-input/.rec-date…）
            // 一起拷过去 → 宽高/圆角/边框/主题色/悬停态与原来完全一致，而**文字由 wrap 的
            // flex 正常流居中**（原生输入框在 appearance:none 下会把文字画在顶部，绝对定位
            // 的标签于是和它错位——这就是"文字不居中的来源"）。
            wrap.className = 'yuki-date-wrap ' + String(input.className || '');
            input.parentNode.insertBefore(wrap, input);
            wrap.appendChild(input);
            input.className = 'yuki-date-input';
            // 原生输入退化为"隐形值容器"：不参与视觉、不接指针、不抢焦点
            input.setAttribute('style',
                (input.getAttribute('style') || '')
                + ';position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none;margin:0;');
            // 「取消输入功能」：只读 → 键盘/分段编辑全部失效，只剩"点开日历"
            input.readOnly = true;
            input.setAttribute('aria-readonly', 'true');
            input.setAttribute('autocomplete', 'off');
            input.setAttribute('inputmode', 'none');
            // 文字走 wrap 的正常流：flex + align-items:center 保证垂直居中，不依赖任何
            // 绝对定位/行高换算
            const label = doc.createElement('span');
            label.className = 'yuki-date-label';
            label.textContent = labelTextOf(input.value);
            wrap.appendChild(label);
            // 日历图标必须自绘：.md-input 带 appearance:none，Chromium 在这种输入框上
            // **根本不渲染** ::-webkit-calendar-picker-indicator（像素截图实证：字段里空无一物）。
            // 图形与配色对齐设计系统的线性图标（与 .md-select 的 chevron 同尺寸同色）。
            const icon = doc.createElement('span');
            icon.className = 'yuki-date-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" '
                + 'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
                + '<rect x="3.25" y="5" width="17.5" height="15.75" rx="3"></rect>'
                + '<path d="M8 3v4M16 3v4M3.5 10h17"></path></svg>';
            wrap.appendChild(icon);
            const trigger = doc.createElement('button');
            trigger.type = 'button';
            trigger.className = 'yuki-date-trigger';
            trigger.setAttribute('tabindex', '-1');
            trigger.setAttribute('aria-label', (input.getAttribute && input.getAttribute('title')) || '选择日期');
            trigger.setAttribute('data-yuki-date-trigger', '');
            wrap.appendChild(trigger);
            input.setAttribute('data-yuki-date', '1');
            // 面板收起后焦点回到字段本身（Tab 序自然），分段高亮已由 CSS 压掉
            patchValueSync(input);
            syncLabel(input);
            // 值被别的路径改掉（setAttribute('value')/原生控件行为）时也同步
            input.addEventListener('change', () => syncLabel(input));
            input.addEventListener('input', () => syncLabel(input));
        } catch (e) { /* 装饰失败：退回「只靠 preventDefault」的旧路径 */ }
        return input;
    }

    /** 把页面上所有日期输入补上装饰（含后续动态注入的）。 */
    function decorateAll(scope) {
        const rootEl = scope || doc;
        let list = [];
        try { list = rootEl.querySelectorAll ? rootEl.querySelectorAll('input[type="date"]') : []; } catch (e) { list = []; }
        for (let i = 0; i < list.length; i++) decorate(list[i]);
    }

    function matchDateInput(el) {
        if (!el || typeof el.closest !== 'function') return null;
        const input = el.closest('input');
        if (!input) return null;
        if (String(input.type || '').toLowerCase() !== 'date') return null;
        // readOnly 的日期框：若是**我们自己**设的只读（已装饰，取消输入功能），
        // 仍要能打开日历；只有用户/页面自己写的 readonly 才跳过接管。
        const ownReadonly = input.hasAttribute && input.hasAttribute('data-yuki-date');
        if (input.disabled) return null;
        if (input.readOnly && !ownReadonly) return null;
        if (input.hasAttribute('data-native-date')) return null;
        return input;
    }

    function cellHtml(cell, st) {
        const isToday = cell.iso === todayISO();
        const isSel = cell.iso === st.sel;
        const disabled = outOfRange(cell.iso, st.min, st.max);
        const cls = 'yuki-date-cell'
            + (cell.inMonth ? '' : ' is-out')
            + (isToday ? ' is-today' : '')
            + (isSel ? ' is-selected' : '')
            + (disabled ? ' is-disabled' : '');
        return `<button type="button" class="${cls}" data-iso="${cell.iso}"`
            + `${disabled ? ' disabled aria-disabled="true"' : ''}`
            + ` aria-selected="${isSel ? 'true' : 'false'}">${cell.d}</button>`;
    }

    function render() {
        if (!state) return;
        const st = state;
        const grid = buildMonthGrid(st.view.y, st.view.m, todayISO());
        const rows = [];
        for (let r = 0; r < 6; r++) {
            rows.push('<div class="yuki-date-row">' + grid.slice(r * 7, r * 7 + 7).map((c) => cellHtml(c, st)).join('') + '</div>');
        }
        panelEl.innerHTML = `<div class="yuki-date-head">`
            + `<button type="button" class="yuki-date-nav" data-nav="-12" title="上一年">«</button>`
            + `<button type="button" class="yuki-date-nav" data-nav="-1" title="上个月">‹</button>`
            + `<span class="yuki-date-title">${esc(monthLabel(st.view.y, st.view.m))}</span>`
            + `<button type="button" class="yuki-date-nav" data-nav="1" title="下个月">›</button>`
            + `<button type="button" class="yuki-date-nav" data-nav="12" title="下一年">»</button>`
            + '</div>'
            + `<div class="yuki-date-week">${WEEK_LABELS.map((w) => `<span>${w}</span>`).join('')}</div>`
            + `<div class="yuki-date-grid">${rows.join('')}</div>`
            + '<div class="yuki-date-foot">'
            + '<button type="button" class="yuki-date-btn" data-act="today">今天</button>'
            + '<button type="button" class="yuki-date-btn" data-act="clear">清除</button>'
            + '<button type="button" class="yuki-date-btn yuki-date-btn-primary" data-act="close">关闭</button>'
            + '</div>';
    }

    function place(input) {
        const z = rootZoom();
        const r = input.getBoundingClientRect();
        const vw = (root.innerWidth || 1024) / z;
        const vh = (root.innerHeight || 768) / z;
        const rect = { left: r.left / z, top: r.top / z, bottom: r.bottom / z, width: r.width / z };
        const pw = panelEl.offsetWidth || (CELL_W * 7 + 24);
        const ph = panelEl.offsetHeight || (CELL_H * 6 + 96);
        let left = rect.left;
        if (left + pw > vw - VIEWPORT_PAD) left = Math.max(VIEWPORT_PAD, vw - VIEWPORT_PAD - pw);
        let top = rect.bottom + GAP;
        if (top + ph > vh - VIEWPORT_PAD) top = Math.max(VIEWPORT_PAD, rect.top - GAP - ph);
        panelEl.style.left = Math.round(left) + 'px';
        panelEl.style.top = Math.round(top) + 'px';
        panelEl.style.maxHeight = Math.round(vh - VIEWPORT_PAD * 2) + 'px';
    }

    function open(input) {
        if (!input) return;
        const r = input.getBoundingClientRect();
        if (!r.width && !r.height) return; // 不可见（隐藏面板/未布局）不弹
        if (isOpen() && state && state.input === input) { close(); return; }
        close();
        ensurePanel();
        const cur = parseISO(input.value);
        const today = parseISO(todayISO());
        const base = cur || today || { y: 2026, m: 1, d: 1 };
        const b = boundsOf(input);
        state = {
            input,
            view: { y: base.y, m: base.m },
            sel: cur ? fmtISO(cur.y, cur.m, cur.d) : '',
            min: b.min, max: b.max,
        };
        panelEl.style.display = '';
        render();
        place(input);
        panelEl.classList.add('show');
        input.setAttribute('aria-expanded', 'true');
        // 不聚焦原生 input：Chromium 会给日期分段画上高亮背景（用户反馈的「日期块状」）。
        // 焦点交给面板，键盘照样可用（Esc/PageUp/PageDown 走全局监听）。
        try {
            panelEl.tabIndex = -1;
            panelEl.focus({ preventScroll: true });
        } catch (e) { /* 旧环境忽略 */ }
    }

    function close() {
        const prev = state && state.input;
        if (panelEl) {
            panelEl.classList.remove('show');
            panelEl.style.display = 'none';
        }
        if (prev && prev.setAttribute) prev.setAttribute('aria-expanded', 'false');
        state = null;
    }

    /** 选日：写回原生 input 并派发 input + change（顺序与原生一致）。 */
    function choose(iso) {
        const st = state;
        if (!st || !iso) return;
        const input = st.input;
        const before = String(input.value || '').slice(0, 10);
        close();
        if (before === iso) return; // 与原生一致：同值不派发 change
        input.value = iso;
        syncLabel(input);
        try { input.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        try {
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
            try { if (typeof root.jQuery === 'function') root.jQuery(input).trigger('change'); } catch (e2) { /* ignore */ }
        }
    }

    /** 清空：value='' + 派发（部分浏览器对 date 的 '' 赋值会被忽略，用 removeAttribute 兜底）。 */
    function clearValue() {
        const st = state;
        if (!st) return;
        const input = st.input;
        close();
        input.value = '';
        if (String(input.value || '') !== '') input.removeAttribute('value');
        syncLabel(input);
        try {
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) { /* ignore */ }
    }

    function shiftMonth(delta) {
        if (!state) return;
        const next = addMonths(state.view.y, state.view.m, delta);
        state.view = next;
        render();
        place(state.input);
    }

    // ------------------------------------------------------------ 事件

    /** 透明触发层 → 它包裹的日期输入。 */
    function inputOfTrigger(el) {
        if (!el || typeof el.closest !== 'function') return null;
        const trigger = el.closest('.yuki-date-trigger');
        if (!trigger) return null;
        const wrap = trigger.parentNode;
        const input = wrap && wrap.querySelector ? wrap.querySelector('input[type="date"]') : null;
        return input ? matchDateInput(input) || input : null;
    }

    function onPointerDown(e) {
        if (isPanelNode(e.target)) {
            if (e.preventDefault) e.preventDefault();
            return;
        }
        const viaTrigger = inputOfTrigger(e.target);
        if (viaTrigger) {
            if (e.preventDefault) e.preventDefault();
            decorate(viaTrigger);
            open(viaTrigger);
            return;
        }
        const input = matchDateInput(e.target);
        if (input) {
            if (e.preventDefault) e.preventDefault(); // 阻止原生日历弹出（装饰层缺失时的兜底）
            decorate(input);
            open(input);
            return;
        }
        if (isOpen()) close();
    }

    function onKeyDown(e) {
        if (!e) return;
        if (!isOpen()) {
            const input = matchDateInput(e.target);
            if (input && (e.altKey && e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                open(input);
            }
            return;
        }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
        if (e.key === 'PageUp') { e.preventDefault(); shiftMonth(-1); return; }
        if (e.key === 'PageDown') { e.preventDefault(); shiftMonth(1); return; }
        if (e.key === 'Tab') { close(); return; }
    }

    function onClick(e) {
        if (!isPanelNode(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        const t = e.target;
        const nav = t.closest && t.closest('[data-nav]');
        if (nav) { shiftMonth(parseInt(nav.getAttribute('data-nav'), 10) || 0); return; }
        const act = t.closest && t.closest('[data-act]');
        if (act) {
            const a = act.getAttribute('data-act');
            if (a === 'today') choose(todayISO());
            else if (a === 'clear') clearValue();
            else close();
            return;
        }
        const cell = t.closest && t.closest('[data-iso]');
        if (cell) {
            if (cell.hasAttribute('disabled')) return;
            choose(cell.getAttribute('data-iso'));
        }
    }

    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('mousedown', (e) => {
        if (isPanelNode(e.target)) { if (e.preventDefault) e.preventDefault(); return; }
        const input = matchDateInput(e.target);
        if (input && e.preventDefault) e.preventDefault();
    }, true);
    doc.addEventListener('click', (e) => {
        // 透明触发层：click 也走同一入口（不同 Chromium 版本开面板的时机不同）
        const viaTrigger = inputOfTrigger(e.target);
        if (viaTrigger) {
            if (e.preventDefault) e.preventDefault();
            if (!isOpen() || (state && state.input !== viaTrigger)) open(viaTrigger);
            return;
        }
        const input = matchDateInput(e.target);
        if (input && e.preventDefault) e.preventDefault();
        onClick(e);
    }, true);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('wheel', () => { if (isOpen()) close(); }, { capture: true, passive: true });
    root.addEventListener('scroll', (e) => { if (isOpen() && !isPanelNode(e && e.target)) close(); }, true);
    root.addEventListener('resize', () => { if (isOpen()) close(); });

    // 启动即装饰：让原生 input 从第一帧起就收不到指针事件（彻底杜绝原生面板）
    decorateAll();
    if (typeof root.MutationObserver === 'function' && doc.body) {
        let pending = 0;
        const mo = new root.MutationObserver(() => {
            if (pending) return;
            pending = 1;
            const run = () => { pending = 0; decorateAll(); };
            if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(run);
            else setTimeout(run, 30);
        });
        try { mo.observe(doc.body, { childList: true, subtree: true }); } catch (e) { /* observe 失败不影响主链路 */ }
    }

    const CustomDate = {
        open, close, isOpen,
        decorate, decorateAll, syncLabel, labelTextOf,
        // 单测面
        _parseISO: parseISO,
        _fmtISO: fmtISO,
        _addMonths: addMonths,
        _daysInMonth: daysInMonth,
        _buildMonthGrid: buildMonthGrid,
        _monthLabel: monthLabel,
        _outOfRange: outOfRange,
        _matchDateInput: matchDateInput,
        _panel: () => panelEl,
    };
    root.YukiCustomDate = CustomDate;
    root.YUKI = root.YUKI || {};
    root.YUKI.customDate = CustomDate;
}(typeof window !== 'undefined' ? window : globalThis));
