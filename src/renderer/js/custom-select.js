/**
 * custom-select.js — 筛选栏下拉框的**自绘展开列表**。
 *
 * 背景：原生 <select> 展开后的选项列表由 Chromium/系统绘制（Windows 上是系统弹窗），
 * CSS 完全没有钩子——收起态控件能改圆角/配色，弹出列表永远是方角 + 系统字体
 * （用户在设置里换的主题、字号都进不去）。唯一能让"下拉圆角 + 统一主题样式"成立的做法
 * 是自己画列表。
 *
 * 设计取舍（关键）：**不替换、不隐藏原生 <select>**，只接管"点开"这一下。
 *   - 原生 select 仍是唯一的「值容器」：jQuery 的 .val() 读写、页面里所有
 *     .on('change') 绑定、动态重建选项（toolbar 注入 / 来源下拉 .html(...)）全部照旧，
 *     零改动、零同步问题（收起态显示的文字由浏览器自己渲染，不存在"标签与值不一致"）；
 *   - 指针按下时 preventDefault + 自绘弹层 → 原生弹出层不会出现；
 *   - 选中时写回 selectedIndex 并派发 input + change（与原生 <select> 的行为一致），
 *     页面逻辑拿到的就是它期待的那次 change。
 *
 * 为什么用 document 捕获而不是逐个初始化：筛选栏控件由各视图动态注入（records.js 的
 * recToolbarHtml / _syncSiteOptions 会重写选项），逐元素挂载就得处理"元素被重建"。
 * 捕获阶段按 closest('select.md-select') 命中，任何后注入的控件天然生效。
 *
 * 作用范围：带 .md-select 的单选 select（multiple / size>1 走原生；加 data-native-select
 * 可显式退出）。键盘可访问性保留：Tab 聚焦后方向键仍是原生改值（会派发 change），
 * Alt+↓ / Space / Enter 打开自绘列表。
 */
/* global escHtml */
(function (root) {
    'use strict';
    const doc = root.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;

    const PANEL_ID = 'yuki-select-panel';
    const MAX_PANEL_H = 340;   // 与 CSS 的 max-height 一致
    const VIEWPORT_PAD = 8;
    const GAP = 6;             // 控件与弹层的间距

    let panelEl = null;
    let state = null;          // { sel, items, active }

    function esc(s) {
        if (typeof escHtml === 'function') return escHtml(s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** 命中自绘范围内的 select（单选、启用、未被显式退出）。 */
    function matchSelect(el) {
        if (!el || typeof el.closest !== 'function') return null;
        const sel = el.closest('select');
        if (!sel || sel.multiple || Number(sel.size) > 1) return null;
        if (sel.disabled || sel.hasAttribute('data-native-select')) return null;
        if (!/(^|\s)md-select(\s|$)/.test(String(sel.className || ''))) return null;
        return sel;
    }

    function isPanelNode(el) {
        return !!(panelEl && el && (el === panelEl || (typeof panelEl.contains === 'function' && panelEl.contains(el))));
    }

    function isOpen() { return !!(panelEl && panelEl.classList.contains('show')); }

    /** 页面缩放（设置 → 外观）时 getBoundingClientRect 是视口坐标，而 fixed 定位落在
     *  root 的局部坐标里——两者差一个 zoom 系数，不除回去弹层会整体偏移。 */
    function rootZoom() {
        try {
            const z = parseFloat(root.getComputedStyle(doc.documentElement).zoom);
            return (Number.isFinite(z) && z > 0) ? z : 1;
        } catch (e) { return 1; }
    }

    /** 拍平选项（含 optgroup 分组标题），index 用 option.index（= selectedIndex 口径）。 */
    function collectItems(sel) {
        const items = [];
        const opts = sel.querySelectorAll('option');
        for (let i = 0; i < opts.length; i++) {
            const opt = opts[i];
            const group = (opt.parentElement && opt.parentElement.tagName === 'OPTGROUP') ? opt.parentElement : null;
            items.push({
                index: opt.index,
                label: String(opt.label || opt.textContent || ''),
                disabled: !!opt.disabled || !!(group && group.disabled),
                group: group ? String(group.label || '') : '',
            });
        }
        return items;
    }

    function ensurePanel() {
        if (panelEl && panelEl.isConnected !== false) return panelEl;
        const el = doc.createElement('div');
        el.id = PANEL_ID;
        el.className = 'yuki-sel-panel';
        el.setAttribute('role', 'listbox');
        el.setAttribute('data-yuki-sel-ui', '');
        el.style.display = 'none';
        doc.body.appendChild(el);
        panelEl = el;
        return el;
    }

    function render(sel) {
        const items = collectItems(sel);
        const cur = sel.selectedIndex;
        let html = '';
        let lastGroup = null;
        items.forEach((it, i) => {
            if (it.group && it.group !== lastGroup) {
                html += `<div class="yuki-sel-group">${esc(it.group)}</div>`;
                lastGroup = it.group;
            }
            const cls = 'yuki-sel-item'
                + (it.index === cur ? ' is-checked' : '')
                + (it.disabled ? ' is-disabled' : '')
                + (i === 0 ? ' is-first' : '');
            html += `<div class="${cls}" role="option" data-idx="${it.index}" aria-selected="${it.index === cur ? 'true' : 'false'}">`
                + `<span class="yuki-sel-label">${esc(it.label)}</span>`
                + '<span class="yuki-sel-check" aria-hidden="true">✓</span></div>';
        });
        if (!items.length) html = '<div class="yuki-sel-empty">无可选项</div>';
        panelEl.innerHTML = html;
        state.items = items;
        state.active = items.findIndex((it) => it.index === cur && !it.disabled);
        if (state.active < 0) state.active = items.findIndex((it) => !it.disabled);
        markActive();
    }

    function itemNodes() {
        return panelEl ? Array.prototype.slice.call(panelEl.querySelectorAll('.yuki-sel-item')) : [];
    }

    function markActive() {
        itemNodes().forEach((node, i) => {
            const on = i === state.active;
            if (on) node.classList.add('is-active'); else node.classList.remove('is-active');
            if (on && node.scrollIntoView) {
                try { node.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 旧环境忽略 */ }
            }
        });
    }

    function place(sel) {
        const z = rootZoom();
        const r = sel.getBoundingClientRect();
        const vw = (root.innerWidth || 1024) / z;
        const vh = (root.innerHeight || 768) / z;
        const rect = { left: r.left / z, top: r.top / z, bottom: r.bottom / z, width: r.width / z, height: r.height / z };
        panelEl.style.minWidth = Math.max(120, Math.round(rect.width)) + 'px';
        panelEl.style.maxHeight = Math.min(MAX_PANEL_H, Math.max(120, vh - VIEWPORT_PAD * 2)) + 'px';
        // 先给宽度再量高度（宽度影响换行 → 高度）
        const pw = Math.max(rect.width, panelEl.offsetWidth || rect.width);
        const ph = panelEl.offsetHeight || 0;
        let left = rect.left;
        if (left + pw > vw - VIEWPORT_PAD) left = Math.max(VIEWPORT_PAD, vw - VIEWPORT_PAD - pw);
        let top = rect.bottom + GAP;
        if (top + ph > vh - VIEWPORT_PAD) top = Math.max(VIEWPORT_PAD, rect.top - GAP - ph);
        panelEl.style.left = Math.round(left) + 'px';
        panelEl.style.top = Math.round(top) + 'px';
    }

    function open(sel) {
        if (!sel) return;
        const r = sel.getBoundingClientRect();
        if (!r.width && !r.height) return; // 不可见（隐藏面板/未布局）不弹
        if (isOpen() && state && state.sel === sel) { close(); return; } // 再点一次 = 收起
        close();
        ensurePanel();
        state = { sel, items: [], active: -1 };
        panelEl.style.display = '';
        render(sel);
        place(sel);
        panelEl.classList.add('show');
        markActive(); // 显示后再滚一次：render 时 display:none，scrollIntoView 无效（长列表要停在当前项）
        sel.setAttribute('aria-expanded', 'true');
        try { sel.focus({ preventScroll: true }); } catch (e) { /* 旧环境忽略 */ }
    }

    function close() {
        if (!panelEl || !panelEl.classList.contains('show')) {
            if (panelEl) { panelEl.classList.remove('show'); panelEl.style.display = 'none'; }
            state = null;
            return;
        }
        const sel = state && state.sel;
        panelEl.classList.remove('show');
        panelEl.style.display = 'none';
        if (sel) sel.setAttribute('aria-expanded', 'false');
        state = null;
    }

    /** 选中第 index 个 option：写回值 + 派发 input/change（与原生 <select> 同序）。 */
    function choose(index) {
        const st = state;
        if (!st) return;
        const sel = st.sel;
        const item = st.items.find((it) => it.index === index);
        close();
        if (!item || item.disabled) return;
        if (sel.selectedIndex === index) return; // 与原生一致：选同一项不派发 change
        sel.selectedIndex = index;
        // 焦点留在控件上（原生 select 的行为）：键盘用户选完可以直接接着 Tab/方向键
        try { sel.focus({ preventScroll: true }); } catch (e) { /* 旧环境忽略 */ }
        try {
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
            // 极端环境无 Event 构造器：退回复用 jQuery 触发（页面监听多数走 jQuery）
            try { if (typeof root.jQuery === 'function') root.jQuery(sel).trigger('change'); } catch (e2) { /* ignore */ }
        }
    }

    function moveActive(delta) {
        if (!state || !state.items.length) return;
        const n = state.items.length;
        let i = state.active;
        for (let step = 0; step < n; step++) {
            i = (i + delta + n) % n;
            if (!state.items[i].disabled) { state.active = i; break; }
        }
        markActive();
    }

    // ------------------------------------------------------------ 事件（捕获阶段接管）

    function onPointerDown(e) {
        if (isPanelNode(e.target)) {
            // 弹层内的按下不要抢焦点/不要触发页面其它"点外部关闭"逻辑
            if (e.preventDefault) e.preventDefault();
            return;
        }
        const sel = matchSelect(e.target);
        if (sel) {
            // 关键：阻止原生弹出列表（Chromium 在 pointerdown/mousedown 上打开它）
            if (e.preventDefault) e.preventDefault();
            open(sel);
            return;
        }
        if (isOpen()) close();
    }

    function onKeyDown(e) {
        if (!e) return;
        const openNow = isOpen();
        if (openNow) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); return; }
            if (e.key === 'Home') { e.preventDefault(); state.active = -1; moveActive(1); return; }
            if (e.key === 'End') { e.preventDefault(); state.active = 0; moveActive(-1); return; }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const item = state.items[state.active];
                if (item) choose(item.index);
                return;
            }
            if (e.key === 'Tab') { close(); return; }
            return;
        }
        // 未展开：Alt+↓ / Space / Enter 在自绘范围内打开列表
        const sel = matchSelect(e.target);
        if (!sel) return;
        const isAltDown = !!e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp');
        const isOpenKey = e.key === ' ' || e.key === 'Enter';
        if (isAltDown || isOpenKey) {
            e.preventDefault();
            open(sel);
        }
    }

    function onScrollOrWheel(e) {
        if (!isOpen()) return;
        if (e && isPanelNode(e.target)) return; // 弹层自身滚动不关
        close();
    }

    doc.addEventListener('pointerdown', onPointerDown, true);
    // 兜底：个别环境/输入设备只发 mousedown（且原生弹层也可能挂在 mousedown 上）
    doc.addEventListener('mousedown', (e) => {
        if (isPanelNode(e.target)) { if (e.preventDefault) e.preventDefault(); return; }
        const sel = matchSelect(e.target);
        if (sel && e.preventDefault) e.preventDefault();
    }, true);
    // 再补一道 mouseup：个别平台把弹出动作挂在释放上，双保险不改变其它默认行为
    doc.addEventListener('mouseup', (e) => {
        const sel = matchSelect(e.target);
        if (sel && e.preventDefault) e.preventDefault();
    }, true);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('click', (e) => {
        // 面板项：在 click 上落选（pointerdown 已 preventDefault，不会丢焦点）
        if (!isPanelNode(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        const node = e.target.closest ? e.target.closest('.yuki-sel-item') : null;
        if (!node) return;
        const idx = parseInt(node.getAttribute('data-idx'), 10);
        if (Number.isFinite(idx)) choose(idx);
    }, true);
    doc.addEventListener('wheel', onScrollOrWheel, { capture: true, passive: true });
    root.addEventListener('scroll', onScrollOrWheel, true);
    root.addEventListener('resize', () => { if (isOpen()) close(); });

    const CustomSelect = {
        open,
        close,
        isOpen,
        // 单测/诊断面
        _collectItems: collectItems,
        _matchSelect: matchSelect,
        _panel: () => panelEl,
    };
    root.YukiCustomSelect = CustomSelect;
    root.YUKI = root.YUKI || {};
    root.YUKI.customSelect = CustomSelect;
}(typeof window !== 'undefined' ? window : globalThis));
