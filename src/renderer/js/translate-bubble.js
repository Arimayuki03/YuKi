/**
 * translate-bubble.js — 划词翻译气泡。
 *
 * 选中界面文本（简介/评论/搜索结果等 DOM 文本）→ 弹出 Material 3 风格翻译
 * 气泡；翻译请求经 Python 后端 POST /translate（免费端点 microsoft/google
 * 互备 + 可选 LLM），后端侧缓存 24h。
 *
 * 纯逻辑移植自 auto-translate 扩展（MIT, © 2026 Arimayuki03）：
 *   - placeFixedInViewport：body/html 挂 transform/zoom 时 fixed 定位防漂移
 *     的两点采样反解仿射映射（placement.ts，原样移植）；
 *   - 选中检测/去重/关闭路径框架（content/bubble.ts，按本应用重写）。
 * UI 为 YuKi 原生风格（ui.css 的 .yuki-tr-* 段，复用 --md-* 主题变量）。
 *
 * 设置键（经 SETTINGS_SET_ALLOWED 白名单）：
 *   translateEnable(默认 false——设置页显式开启后划词才生效) /
 *   translateTrigger('button'|'auto'，默认 auto 选中即译) /
 *   translateTarget('zh-CN'|'zh-TW'|'en'|'ja') / translateLLMEnable /
 *   translateLLMBase / translateLLMKey / translateLLMModel
 *
 * 单测：tests/js/translate-bubble.test.js（VM 沙箱，只测纯逻辑函数）。
 */
/* global apiUrl */
(function (root) {
    'use strict';

    const DEDUP_WINDOW_MS = 3000;
    const MAX_RECENT = 100;
    const MAX_TEXT = 5000;

    /** 目标语言码 → 展示名（气泡徽标/设置下拉共用）。 */
    const TARGET_LABELS = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', 'en': 'English', 'ja': '日本語' };
    const PROVIDER_LABELS = { llm: 'LLM', microsoft: 'Edge', google: 'Google' };

    // ------------------------------------------------------------ 纯逻辑（单测面）

    /**
     * fixed 浮层的视口级定位（auto-translate placement.ts 原样移植）。
     * 站点在 body/html 上挂 transform/filter/zoom（GPU 合成、毛玻璃、缩放动画）
     * 时，position:fixed 的包含块不再是视口，getBoundingClientRect 量出的视口
     * 坐标会被按包含块坐标系解释——浮层错位约一个滚动距离。两点采样反解仿射
     * 映射 rendered = O + k × local，一次写入即精确（纯平移与等比缩放通吃）。
     * 调用前需让元素可见（未渲染元素 rect 全 0，量不到映射）。
     */
    function placeFixedInViewport(el, x, y, doc) {
        const d = doc || root.document;
        if (!d || !d.documentElement) return { left: x, top: y };
        const html = d.documentElement;
        if (el.parentElement !== html) html.appendChild(el);
        el.style.left = '0px';
        el.style.top = '0px';
        const o = el.getBoundingClientRect();
        // 无布局环境（测试沙箱）或未渲染：rect 全 0，量不到映射，按视口语义直接写
        if (o.width <= 0 && o.height <= 0) {
            el.style.left = `${Math.round(x)}px`;
            el.style.top = `${Math.round(y)}px`;
            return { left: x, top: y };
        }
        el.style.left = '100px';
        el.style.top = '100px';
        const p = el.getBoundingClientRect();
        // 平移失真采样得 k=1；缩放失真（zoom）解出实际比例。k 退化（异常布局）时按 1 处理
        const kx = Math.abs(p.left - o.left) > 1e-6 ? (p.left - o.left) / 100 : 1;
        const ky = Math.abs(p.top - o.top) > 1e-6 ? (p.top - o.top) / 100 : 1;
        const lx = Math.round((x - o.left) / kx);
        const ly = Math.round((y - o.top) / ky);
        el.style.left = `${lx}px`;
        el.style.top = `${ly}px`;
        return { left: x, top: y };
    }

    /**
     * 选区锚点坐标 → 视口内气泡坐标：选区下方 8px，放不下翻到上方，
     * 左右 clamp 进视口（auto-translate bubble.ts position 逻辑）。
     */
    function bubblePointForRect(rect, w, h, vw, vh) {
        const width = w || 40;
        const height = h || 20;
        let left = rect.left;
        let top = rect.bottom + 8;
        if (top + height > (vh || 99999)) top = rect.top - height - 8;
        left = Math.min(Math.max(left, 8), Math.max(8, (vw || 99999) - width - 8));
        top = Math.min(Math.max(top, 8), (vh || 99999) - height - 8);
        return { left, top };
    }

    /**
     * mouseup 事件 → 划词判定。返回选中文本或 null（不触发翻译）。
     * 规则：选区非折叠、≥2 字符；起点/终点都不是输入类控件（输入框内选中文本
     * 是编辑操作的一部分，划词翻译反而碍事）。
     */
    function pickSelectionText(sel, startEl, endEl) {
        if (!sel || sel.isCollapsed) return null;
        const text = String(sel.toString() || '').trim();
        if (text.length < 2) return null;
        if (isEditable(startEl) || isEditable(endEl)) return null;
        return text;
    }

    function isEditable(el) {
        if (!el || !el.closest) return false;
        return !!el.closest('input, textarea, [contenteditable="true"], [contenteditable=""]');
    }

    /**
     * 捕获阶段 click 是否该被抑制（划选松手后的那次 click 防误导航）：
     * 仅当「选区非折叠 ≥2 字符」且「点击坐标落在选区矩形（外扩 6px 容差）内」
     * 时吞掉——误导航的唯一形态是松手点正落在被划选的卡片上；点到页面上
     * 其他任何位置（导航/按钮/菜单）都不吞，划选后即可正常进行其他操作。
     * rect 不可得（测试沙箱/无 range）时退回旧口径：非折叠即吞。
     */
    function shouldSuppressClick(sel, x, y, tolerance) {
        if (!sel || sel.isCollapsed) return false;
        if (String(sel.toString() || '').trim().length < 2) return false;
        const pad = tolerance == null ? 6 : tolerance;
        if (typeof x !== 'number' || typeof y !== 'number' || sel.rangeCount === 0) return true;
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return true;
        // 多行选区 getBoundingClientRect 是包围盒，用包围盒判定即可覆盖首尾行
        return x >= rect.left - pad && x <= rect.right + pad
            && y >= rect.top - pad && y <= rect.bottom + pad;
    }

    /** 在途划词去重：3 秒窗口内同文本不重复请求（auto-translate 同策略）。 */
    function createDeduper(nowMs) {
        const recent = new Map();
        const now = () => (typeof nowMs === 'function' ? nowMs() : Date.now());
        return {
            /** 已在窗口内出现过返回 true（并刷新时间戳），否则登记并返回 false。 */
            seen(text) {
                const t = now();
                for (const [k, ts] of recent) {
                    if (t - ts >= DEDUP_WINDOW_MS) recent.delete(k);
                    else break; // Map 迭代序 = 插入序，遇到未过期的即可停
                }
                const last = recent.get(text);
                if (last !== undefined && t - last < DEDUP_WINDOW_MS) {
                    recent.set(text, t);
                    return true;
                }
                recent.set(text, t);
                if (recent.size > MAX_RECENT) {
                    const oldest = recent.keys().next().value;
                    if (oldest !== undefined) recent.delete(oldest);
                }
                return false;
            },
        };
    }

    /**
     * 翻译请求体构造（锁后端 /translate 契约）。settings: 设置快照；
     * targetOverride 供重试时用当前设置目标语言。返回 {body, target}。
     */
    function buildTranslatePayload(text, settings, targetOverride) {
        const s = settings || {};
        const target = targetOverride || s.translateTarget || 'zh-CN';
        const body = { text: String(text || '').slice(0, MAX_TEXT), to: target };
        if (s.translateLLMEnable) {
            body.prefer = 'llm';
            body.llm = {
                base: String(s.translateLLMBase || '').trim(),
                key: String(s.translateLLMKey || '').trim(),
                model: String(s.translateLLMModel || '').trim(),
            };
        }
        return { body, target };
    }

    // ------------------------------------------------------------ DOM 气泡

    let bubbleEl = null;      // 气泡或「译」触发钮（统一走 close() 回收）
    let activeAbort = null;
    let settingsCache = { translateEnable: false, translateTrigger: 'auto', translateTarget: 'zh-CN' };

    function isInsideOurUI(target) {
        return !!target && typeof target.closest === 'function'
            && !!target.closest('[data-yuki-tr-ui]');
    }

    function getSettings() {
        if (root.window === root && root.yuki && root.yuki.settingsGet) {
            return root.yuki.settingsGet();
        }
        return Promise.resolve(settingsCache);
    }

    /** 复制文本（execCommand 兜底，auto-translate ui.ts 同款）。 */
    function copyText(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).catch(() => {});
                return true;
            }
        } catch (e) { /* fallthrough */ }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (e) {
            return false;
        }
    }

    function buildBubble(text) {
        const el = document.createElement('div');
        el.className = 'yuki-tr-bubble yuki-tr-loading';
        el.setAttribute('data-yuki-tr-ui', '');

        const head = document.createElement('div');
        head.className = 'yuki-tr-head';
        const badge = document.createElement('span');
        badge.className = 'yuki-tr-badge';
        badge.textContent = '翻译';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'yuki-tr-close';
        closeBtn.type = 'button';
        closeBtn.textContent = '✕';
        closeBtn.title = '关闭';
        closeBtn.addEventListener('click', () => close());
        head.append(badge, closeBtn);

        const body = document.createElement('div');
        body.className = 'yuki-tr-body';
        body.innerHTML = '<span class="yuki-tr-spinner"></span>翻译中…';

        const actions = document.createElement('div');
        actions.className = 'yuki-tr-actions';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'md-btn md-btn-tonal yuki-tr-mini';
        copyBtn.type = 'button';
        copyBtn.textContent = '复制';
        copyBtn.addEventListener('click', () => {
            const ok = copyText((body.textContent || '').trim());
            copyBtn.textContent = ok ? '已复制' : '复制失败';
            setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
        });
        actions.appendChild(copyBtn);

        el.append(head, body, actions);
        return { el, body, badge, actions, copyBtn };
    }

    /** 触发钮（button 模式）：选区旁的小圆钮，点击才翻译。 */
    function buildTriggerBtn(rect, text) {
        const btn = document.createElement('button');
        btn.className = 'yuki-tr-trigger';
        btn.type = 'button';
        btn.setAttribute('data-yuki-tr-ui', '');
        btn.textContent = '译';
        btn.title = '翻译选中文字';
        appendToViewportLayer(btn);
        positionAt(btn, rect);
        btn.addEventListener('click', () => {
            btn.remove();
            openBubble(rect, text);
        });
        return btn;
    }

    function appendToViewportLayer(el) {
        // 挂 <html> 下：body 带 transform 的页面由 placeFixedInViewport 兜底
        document.documentElement.appendChild(el);
    }

    function positionAt(el, rect) {
        const w = el.offsetWidth || 40;
        const h = el.offsetHeight || 20;
        const pt = bubblePointForRect(rect, w, h, window.innerWidth, window.innerHeight);
        placeFixedInViewport(el, pt.left, pt.top);
    }

    function close() {
        if (activeAbort) { try { activeAbort.abort(); } catch (e) { /* noop */ } }
        activeAbort = null;
        if (bubbleEl) { bubbleEl.remove(); bubbleEl = null; }
    }

    async function openBubble(rect, text) {
        close();
        const parts = buildBubble(text);
        bubbleEl = parts.el;
        appendToViewportLayer(parts.el);
        positionAt(parts.el, rect);

        await renderTranslation(parts, text, rect);
    }

    async function renderTranslation(parts, text, rect) {
        const { body, badge, actions, copyBtn } = parts;
        const el = parts.el; // 当次气泡元素：await 期间可能已被 close()/新划词替换
        body.innerHTML = '<span class="yuki-tr-spinner"></span>翻译中…';
        body.classList.remove('yuki-tr-error');
        badge.textContent = '翻译';

        let payload;
        try {
            const fresh = await getSettings();
            if (fresh && typeof fresh === 'object') settingsCache = fresh;
        } catch (e) { /* 读失败沿用上次快照 */ }
        const target = TARGET_LABELS[settingsCache.translateTarget] ? settingsCache.translateTarget : 'zh-CN';
        payload = buildTranslatePayload(text, settingsCache, target);

        // 气泡在等待设置期间被关闭/被新划词替换：不再发请求（也不接管 activeAbort）
        if (bubbleEl !== el) return;
        activeAbort = new AbortController();

        try {
            const rsp = await fetch(apiUrl('/translate'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload.body),
                signal: activeAbort.signal,
            });
            const data = await rsp.json().catch(() => null);
            if (bubbleEl !== el) return; // 响应返回前气泡已关闭/被新划词替换
            if (rsp.ok && data && data.code === 0 && data.text) {
                body.textContent = data.text;
                badge.textContent = `${PROVIDER_LABELS[data.provider] || data.provider} → ${TARGET_LABELS[target] || target}`;
            } else {
                const msg = (data && data.msg) || `HTTP ${rsp.status}`;
                showError(body, actions, copyBtn, msg, () => renderTranslation(parts, text, rect));
            }
            // 译文/错误态就位后气泡从「翻译中…」的小尺寸长到最终高度（正文
            // max-height 40vh），按初始小尺寸定的位会向下溢出视口被边缘裁掉
            // （实测底部截断）——按最终尺寸重定位一次：下方放不下自动翻到
            // 选区上方并钳回视口。重排同步读取 offsetHeight（强制 layout），
            // 拿到的就是渲染后高度。
            if (el && rect) positionAt(el, rect);
        } catch (err) {
            if (bubbleEl !== el) return; // 主动关闭/新划词触发的 abort：静默
            showError(body, actions, copyBtn, (err && err.name === 'TimeoutError') ? '请求超时' : '网络错误',
                () => renderTranslation(parts, text, rect));
            if (el && rect) positionAt(el, rect);
        }
    }

    function showError(body, actions, copyBtn, msg, retry) {
        body.classList.add('yuki-tr-error');
        body.textContent = `翻译失败：${msg}`;
        copyBtn.style.display = 'none';
        let retryBtn = actions.querySelector('.yuki-tr-retry');
        if (!retryBtn) {
            retryBtn = document.createElement('button');
            retryBtn.className = 'md-btn md-btn-tonal yuki-tr-mini yuki-tr-retry';
            retryBtn.type = 'button';
            actions.prepend(retryBtn);
        }
        retryBtn.textContent = '重试';
        retryBtn.style.display = '';
        retryBtn.onclick = () => {
            copyBtn.style.display = '';
            retryBtn.style.display = 'none';
            retry();
        };
    }

    // ------------------------------------------------------------ 事件挂载

    function init() {
        const deduper = createDeduper();
        let mouseupGen = 0; // await 期间用户可能已关闭/重开气泡：世代号防旧响应串档

        document.addEventListener('mouseup', async (e) => {
            if (isInsideOurUI(e.target)) return;
            const sel = window.getSelection();
            const text = pickSelectionText(sel, sel && sel.anchorNode && sel.anchorNode.parentElement,
                sel && sel.focusNode && sel.focusNode.parentElement);
            if (!text) { close(); return; }

            const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
            if (!rect || (rect.width === 0 && rect.height === 0)) return;

            // 刷新设置快照（划词是低频手势，一次读取可接受；失败沿用快照）
            const gen = ++mouseupGen;
            try {
                const fresh = await getSettings();
                if (fresh && typeof fresh === 'object') settingsCache = fresh;
            } catch (err) { /* 沿用快照 */ }
            // await 期间发生了新的划词（世代号前进）：本次丢弃，由新划词接管
            if (gen !== mouseupGen) return;
            // 缺键（undefined）同视为关：设置页显式开启（=== true）后划词才生效
            if (settingsCache.translateEnable !== true) { close(); return; }

            // 连划去重登记放在全部闸门之后：开关未开/rect 无效的 mouseup
            // 不占用 3 秒去重窗口；窗口内重复 mouseup 同文本仍只触发一次
            if (deduper.seen(text)) return;

            close(); // 连续划词：回收上一气泡/触发钮
            if (settingsCache.translateTrigger === 'auto') {
                openBubble(rect, text);
            } else {
                bubbleEl = buildTriggerBtn(rect, text);
            }
        });

        document.addEventListener('mousedown', (e) => {
            if (!isInsideOurUI(e.target)) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
        });
        let scrollRaf = 0;
        window.addEventListener('scroll', (e) => {
            // 捕获阶段会收到子元素滚动：气泡正文内滚动阅读不关，仅页面滚动关
            if (bubbleEl && e.target instanceof Node && bubbleEl.contains(e.target)) return;
            if (scrollRaf) return;
            scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; close(); });
        }, true);

        // 划选松手后的那次 click 会命中被划选的卡片（搜索卡→详情）：
        // 仅当点击落在选区矩形内时吞掉；点向页面其他位置（导航/按钮/菜单）
        // 一律放行并顺手折叠旧选区——划选后可立即进行其他操作，不被卡住。
        // 气泡自身 UI（✕/译/复制）在 isInsideOurUI 处优先放行。
        document.addEventListener('click', (e) => {
            if (isInsideOurUI(e.target)) return;
            if (shouldSuppressClick(window.getSelection(), e.clientX, e.clientY)) {
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            // 未被吞的 click 视为「用户已转向其他操作」：折叠残留选区，
            // 让输入框聚焦/按钮高亮等后续交互不再被旧选区视觉干扰
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.rangeCount) sel.removeAllRanges();
        }, true);
    }

    if (root.document && typeof root.document.addEventListener === 'function') {
        init();
    }

    // ------------------------------------------------------------ 导出

    const YukiTranslate = {
        // 纯逻辑（单测面）
        placeFixedInViewport,
        bubblePointForRect,
        pickSelectionText,
        shouldSuppressClick,
        createDeduper,
        buildTranslatePayload,
        isEditable,
        // 运行时入口
        close,
        copyText,
        reloadSettings: async () => { settingsCache = (await getSettings()) || settingsCache; return settingsCache; },
        _settings: () => settingsCache,
    };

    root.YukiTranslate = YukiTranslate;
    root.YUKI = root.YUKI || {};
    root.YUKI.translate = YukiTranslate;
}(typeof window !== 'undefined' ? window : globalThis));
