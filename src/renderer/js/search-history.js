/**
 * search-history.js — 搜索历史（搜索框下方历史面板 + 单击即搜 + 持久化）
 *
 * 需求口径（用户原话的落地）：「搜索框下面的空白区域显示历史搜索记录，可点击快捷搜索，
 * 可对记录做快捷管理，持久化的关键词不再回填到搜索框而是以历史记录的方式呈现」。
 * 因此本模块同时取代了旧的「关键词回填」体验：原先切页/重启会把上次的词塞回输入框
 * （用户被动接受一个词），现在改为输入框聚焦时在正下方列出历史，由用户主动挑。
 *
 * 四处入口共用同一份历史，并保留来源维度（同一词在不同页面各算一条）：
 *   aggregate（搜索页·聚合搜索）/ kazumi（搜索页·Kazumi 源）/ bangumi（搜索页·Bangumi）/ home（首页当前源）
 * 交叉点击：点别来源的条目会切到该来源的页签/视图后再发起检索（见 _dispatch）。
 *
 * 存储（settings 键 searchHistory，结构 [{ word, source, ts }]）：
 *   - 按 word+source 去重：重复搜索只把该条时间上移，不产生新条（历史是「用过什么」而非流水账）；
 *     同一词在不同来源各自成条——用户要求「按来源可分组」，合并成一条会让分组失去意义。
 *   - 上限 MAX_ITEMS 条，超出淘汰最旧（ts 最小）。上限按「够用且不撑爆 settings.json」定：
 *     单条 ~60B，100 条约 6KB，与 favorites/history 同量级。
 *   - 读侧容错：非数组/条目非对象/字段缺失/ts 非法一律清洗丢弃并按 ts 倒序重排，
 *     任何异常都降级为空数组、绝不抛错（历史是体验优化，不能影响搜索主流程）。
 *
 * 为何读走 settingsGet 而不是 SettingsSnapshot：快照只在设置页控件的 change 事件上失效
 * （settings-snapshot.js 的写失效信号源收窄到 #view-settings），而本模块的写入是
 * 程序化 settingsSet、不经过任何控件 change——快照会把旧值当新鲜值一直供着（最长 90s 兜底）。
 * preload 的 settingsSet 是写穿透缓存（写完同步更新缓存该键），所以「本页写完立即读」
 * 走 settingsGet 拿到的就是新值，语义与本模块需要的完全一致。
 *
 * 面板形态：fixed 定位浮层（坐标由输入框 getBoundingClientRect 推出）——不插进各页
 * search-bar/view-toolbar 的 flex 布局里，避免为四个宿主各改一次 DOM 结构与 CSS 优先级。
 * 面板自身 max-height + 滚动，历史再多也不撑破页面。
 */
/* global $, escHtml, confirmDialog, Search, Home, BangumiSearch, App */

(function () {
    'use strict';

    const root = typeof window !== 'undefined' ? window : globalThis;

    const SETTINGS_KEY = 'searchHistory';
    const MAX_ITEMS = 100;      // 总条数上限（超出淘汰最旧）
    const PREVIEW_PER_GROUP = 8; // 每组默认只显最近 N 条，其余折叠在「展开」后
    const SOURCES = ['aggregate', 'kazumi', 'bangumi', 'home'];
    const LABELS = { aggregate: '聚合搜索', kazumi: 'Kazumi 源', bangumi: 'Bangumi', home: '首页（当前源）' };
    const PANEL_ID = 'search-his-panel';
    const GAP = 6;              // 面板与输入框的间距（px）

    // ---------------------------------------------------------------- 存储层

    let _list = [];              // 内存镜像：写入先落这里（本页立即可见），落盘异步跟随
    let _loaded = false;         // 是否已从 settings 载入过一次
    let _loadP = null;           // 在途载入（并发首读合并）
    let _chain = Promise.resolve(); // 写操作串行链（见 _mutate）

    const _norm = (v) => String(v == null ? '' : v).trim();
    const _isSource = (s) => SOURCES.indexOf(String(s)) >= 0;

    /**
     * 容错清洗：任意输入 → 规范数组。非数组→[]；条目非对象/word 空/source 非法→丢弃；
     * ts 非法→记 0（视作最旧，排序垫底并优先被上限淘汰）；同 word+source 重复→保留较新时间。
     * 结尾按 ts 倒序（新→旧）再截到上限，保证内存里始终是「可渲染的规范态」。
     */
    function sanitize(raw) {
        if (!Array.isArray(raw)) return [];
        const seen = Object.create(null);
        const out = [];
        raw.forEach((it) => {
            if (!it || typeof it !== 'object') return;
            const word = _norm(it.word);
            const source = _isSource(it.source) ? String(it.source) : '';
            if (!word || !source) return;
            const ts = Number(it.ts);
            const item = { word, source, ts: (Number.isFinite(ts) && ts > 0) ? ts : 0 };
            const key = source + '\u0000' + word;
            const prev = seen[key];
            if (prev) { if (item.ts > prev.ts) prev.ts = item.ts; return; }
            seen[key] = item;
            out.push(item);
        });
        out.sort((a, b) => b.ts - a.ts); // ts 相等时 V8 稳定排序保插入序
        return out.slice(0, MAX_ITEMS);
    }

    /** 读全量设置一次并清洗进内存。失败/环境不可用一律降级为空历史（不抛错、不重试）。 */
    function ensure() {
        if (_loaded) return Promise.resolve(_list);
        if (_loadP) return _loadP;
        const read = (() => {
            try {
                if (!root.yuki || typeof root.yuki.settingsGet !== 'function') return null;
                return root.yuki.settingsGet();
            } catch (e) { return null; } // 同步抛错（沙箱/通道异常）按无历史处理
        })();
        _loadP = Promise.resolve(read).then((all) => {
            const raw = (all && typeof all === 'object') ? all[SETTINGS_KEY] : null;
            _list = sanitize(raw);
            _loaded = true;
            _loadP = null;
            return _list;
        }, () => { _loaded = true; _loadP = null; return _list; });
        return _loadP;
    }

    /** 落盘（settingsSet 白名单键）。失败静默：内存仍是最新，本次会话内功能不受影响。 */
    function flush() {
        const yuki = root.yuki;
        if (!yuki || typeof yuki.settingsSet !== 'function') return Promise.resolve(false);
        try {
            return Promise.resolve(yuki.settingsSet(SETTINGS_KEY, _list.map((it) => ({ word: it.word, source: it.source, ts: it.ts }))))
                .then(() => true, () => false);
        } catch (e) { return Promise.resolve(false); }
    }

    /**
     * 写操作串行化：所有变更先等首读（ensure）完成再动 _list，避免「盘上有 50 条历史、
     * 首次搜索时内存还是空的」被 flush 成只剩 1 条。链上后一段永远等前一段 settle，
     * 因此并发 record/remove/clear 不会互相覆盖。
     */
    function _mutate(mutator) {
        // mutator 包 try：本模块对调用方的契约是「永不因历史功能打断搜索主流程」，
        // 任何异常都吞成 false，绝不让返回的 Promise 变 rejected（调用方不 catch）。
        const p = _chain.then(() => ensure()).then(() => {
            try { mutator(); } catch (e) { return false; }
            return flush();
        }, () => false);
        _chain = p.then(() => undefined, () => undefined);
        return p;
    }

    /**
     * 记录一次「真正发起的搜索」（输入过程不记录——需求明确禁止每次 keystroke 落盘）。
     * 命中同 word+source 时把该条上移到最前并刷新时间；否则新增在最前，超出上限截尾。
     */
    function record(word, source) {
        const w = _norm(word);
        const src = _isSource(source) ? String(source) : '';
        _hide(); // 面板的使命就是「挑一个词去搜」，搜了即收，避免遮挡结果
        if (!w || !src) return Promise.resolve(false);
        return _mutate(() => {
            _list = [{ word: w, source: src, ts: Date.now() }]
                .concat(_list.filter((it) => !(it.word === w && it.source === src)));
            if (_list.length > MAX_ITEMS) _list = _list.slice(0, MAX_ITEMS);
        });
    }

    /** 删除单条（word+source 精确匹配）。 */
    function remove(word, source) {
        const w = _norm(word);
        const src = _isSource(source) ? String(source) : '';
        if (!w || !src) return Promise.resolve(false);
        return _mutate(() => {
            _list = _list.filter((it) => !(it.word === w && it.source === src));
        });
    }

    /** 清空全部历史（调用方负责二次确认）。 */
    function clear() {
        return _mutate(() => { _list = []; });
    }

    /** 内存副本（调用方只读消费；不外泄内部引用，防止被就地改乱）。 */
    function list() {
        return _list.map((it) => ({ word: it.word, source: it.source, ts: it.ts }));
    }

    /** 按来源分组（顺序固定 = SOURCES 声明序，空组不返回）。组内已是新→旧序。 */
    function grouped() {
        return SOURCES.map((s) => ({
            source: s,
            label: LABELS[s],
            items: _list.filter((it) => it.source === s),
        })).filter((g) => g.items.length);
    }

    // ---------------------------------------------------------------- 执行层

    /** 把一条历史词交给对应来源去搜：同来源直接搜；跨来源先切视图/页签再搜。 */
    function _dispatch(source, word) {
        const w = _norm(word);
        if (!w || !_isSource(source)) return false;
        _hide();
        // 抑制窗口：切视图会触发宿主 focus()（App.showView('search') → Search.focus），
        // 焦点会让面板立刻重新弹出来盖住刚发起的搜索。抑制一小段，用户随后主动点输入框
        // （>250ms）照常能打开。
        _suppressAt = Date.now() + 250;
        const $jq = (typeof $ === 'function') ? $ : null;
        if (!$jq) return false;
        if (typeof App !== 'undefined' && App && typeof App.showView === 'function' && App.currentView !== 'search' && source !== 'home') {
            App.showView('search');
        }
        if (source === 'home') {
            if (typeof App !== 'undefined' && App && typeof App.showView === 'function' && App.currentView !== 'home') App.showView('home');
            $jq('#home-search').val(w);
            if (typeof Home !== 'undefined' && Home && typeof Home.searchCurrent === 'function') Home.searchCurrent();
            return true;
        }
        if (source === 'aggregate') {
            $jq('#search-keyword').val(w);
            if (typeof Search !== 'undefined' && Search && Search.agg) Search.agg.run();
            return true;
        }
        if (source === 'kazumi') {
            $jq('#kazumi-search-keyword').val(w);
            if (typeof Search !== 'undefined' && Search && Search.kz) Search.kz.run();
            return true;
        }
        // Bangumi：面板所属页签不等于目标页签时先切页签（切页签会 init + 聚焦目标输入框）
        if (typeof Search !== 'undefined' && Search && Search._stab !== 'bangumi') {
            const $tab = $jq('#search-tabs .class-tab[data-stab="bangumi"]');
            if ($tab && $tab.length) $tab.trigger('click');
        }
        $jq('#bgm-search-keyword').val(w);
        if (typeof BangumiSearch !== 'undefined' && BangumiSearch && typeof BangumiSearch._submitFromInput === 'function') {
            BangumiSearch._submitFromInput();
        }
        return true;
    }

    // ---------------------------------------------------------------- 面板（DOM 层）

    let _panel = null;                      // 面板 jQuery 对象（懒建，挂在 body 下）
    let _cur = null;                        // 面板当前服务的挂载点 { sel, source, el, $input }
    const _boundMap = Object.create(null);  // sel → 挂载点（幂等）
    const _expanded = Object.create(null);  // source → true：该组展开全部（默认只显最近 PREVIEW_PER_GROUP 条）
    let _keys = [];                         // 键盘导航顺序（'source\u0000word'）
    let _activeKey = '';
    let _suppressAt = 0;
    let _docBound = false;

    const _keyOf = (source, word) => source + '\u0000' + word;

    /** 转义走 common.js 的 escHtml（H-6：含单引号）；缺席时用等价兜底，绝不裸拼 HTML。 */
    function _esc(s) {
        if (typeof escHtml === 'function') return escHtml(s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function isOpen() {
        return !!(_panel && _cur && _panel.hasClass && _panel.hasClass('show'));
    }

    function _hide() {
        _keys = [];
        _activeKey = '';
        _cur = null;
        if (_panel) _panel.removeClass('show');
    }

    /** 面板定位：贴着当前输入框正下方；输入框滚出视口则收起（fixed 层不跟着滚）。 */
    function _place() {
        if (!_panel || !_cur || !_cur.el) return;
        const el = _cur.el;
        if (typeof el.getBoundingClientRect !== 'function') return; // 桩环境：不定位
        const r = el.getBoundingClientRect();
        const vh = root.innerHeight || 0;
        const vw = root.innerWidth || 0;
        const dom = _panel[0];
        if (!dom) return;
        if (r.bottom < 0 || (vh && r.top > vh)) { _hide(); return; }
        const w = Math.max(Math.round(r.width) || 0, 220);
        let left = Math.round(r.left);
        if (vw) left = Math.max(8, Math.min(left, vw - w - 8));
        dom.style.left = left + 'px';
        dom.style.top = Math.round(r.bottom + GAP) + 'px';
        dom.style.width = w + 'px';
    }

    function _bindDoc() {
        if (_docBound) return;
        _docBound = true;
        const $jq = (typeof $ === 'function') ? $ : null;
        if (!$jq) return;
        // 点击面板/输入框之外即收起（用 mousedown：早于 focus 迁移，避免与新输入框的
        // focus 打开动作打架——先收起旧的，再由 focus 打开新的）
        $jq(document).on('mousedown', (e) => {
            if (!isOpen()) return;
            const t = e.target;
            if (_panel && _panel[0] && t && _panel[0].contains && _panel[0].contains(t)) return;
            if (_cur && _cur.el && t === _cur.el) return;
            _hide();
        });
        // 滚动/缩放时跟着输入框走（scroll 不冒泡，捕获段监听才能收到内部滚动容器的）
        try {
            document.addEventListener('scroll', () => { if (isOpen()) _place(); }, true);
            root.addEventListener('resize', () => { if (isOpen()) _place(); });
        } catch (e) { /* 桩环境无事件通道：仅失去跟随，不影响功能 */ }
    }

    function _panelEl() {
        if (_panel) return _panel;
        const $jq = (typeof $ === 'function') ? $ : null;
        if (!$jq || typeof document === 'undefined' || !document.body) return null;
        try {
            _panel = $jq(`<div class="search-his-panel" id="${PANEL_ID}" role="listbox" aria-label="搜索历史"></div>`)
                .appendTo(document.body);
        } catch (e) { return null; }
        // 整块面板 mousedown 一律 preventDefault：否则点条目会先让输入框失焦（blur 后
        // click 仍会派发，但宿主若有 blur 逻辑就会先跑一遍），统一按「点完仍停在输入框」处理。
        _panel.on('mousedown', (e) => { if (e && e.preventDefault) e.preventDefault(); });
        _panel.on('click', '.search-his-del', (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            // 用 attr 取原始字符串：jQuery .data() 会把纯数字词解析成 number（"123" → 123）
            const el = $jq(e.currentTarget);
            remove(el.attr('data-word'), el.attr('data-source')).then(() => _rerender());
        });
        _panel.on('click', '.search-his-item', (e) => {
            const el = $jq(e.currentTarget);
            _dispatch(String(el.attr('data-source') || ''), String(el.attr('data-word') || ''));
        });
        _panel.on('click', '.search-his-more', (e) => {
            const src = String($jq(e.currentTarget).attr('data-source') || '');
            if (!src) return;
            _expanded[src] = true;
            _rerender();
            _place();
        });
        _panel.on('click', '.search-his-clear', async () => {
            if (!_list.length) return;
            // 破坏性操作无条件二次确认：确认框不可用（异常环境）时宁可不执行
            if (typeof confirmDialog !== 'function') return;
            const ok = await confirmDialog(`清空全部 ${_list.length} 条搜索历史？此操作不可撤销。`, { okText: '清空' });
            if (!ok) return;
            await clear();
            _rerender();
        });
        return _panel;
    }

    function _render() {
        if (!_panel) return false;
        const groups = grouped();
        if (!groups.length) { _panel.html('').removeClass('show'); return false; }
        let html = '';
        _keys = [];
        groups.forEach((g) => {
            const expanded = !!_expanded[g.source];
            const shown = expanded ? g.items : g.items.slice(0, PREVIEW_PER_GROUP);
            html += `<div class="search-his-group"><div class="search-his-group-title">${_esc(g.label)}</div>`;
            shown.forEach((it) => {
                _keys.push(_keyOf(g.source, it.word));
                const w = _esc(it.word);
                html += `<div class="search-his-item" role="option" data-source="${_esc(g.source)}" data-word="${w}" title="${w}">`
                    + `<span class="search-his-word">${w}</span>`
                    + `<span class="search-his-del" role="button" title="删除这条记录" data-source="${_esc(g.source)}" data-word="${w}">×</span>`
                    + '</div>';
            });
            if (!expanded && g.items.length > shown.length) {
                html += `<div class="search-his-more" role="button" data-source="${_esc(g.source)}">展开该组剩余 ${g.items.length - shown.length} 条</div>`;
            }
            html += '</div>';
        });
        html += '<div class="search-his-foot"><span class="search-his-clear" role="button" title="清空全部搜索历史">清空历史</span></div>';
        _panel.html(html);
        _mark();
        return true;
    }

    /** 重绘后按数据重算是否还有内容；空了就收起（避免留一个空壳）。 */
    function _rerender() {
        if (!_render()) { _hide(); return; }
        _place();
    }

    function _mark() {
        if (!_panel || !_panel.find) return;
        _panel.find('.search-his-item').removeClass('active').filter(function () {
            const k = _keyOf(String($(this).attr('data-source') || ''), String($(this).attr('data-word') || ''));
            return k === _activeKey;
        }).addClass('active');
        const dom = _panel[0];
        if (!dom || !dom.querySelector) return;
        const act = dom.querySelector('.search-his-item.active');
        if (act && act.scrollIntoView) { try { act.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 忽略 */ } }
    }

    function _move(dir) {
        if (!_keys.length) return;
        const cur = _keys.indexOf(_activeKey);
        _activeKey = _keys[cur < 0 ? (dir > 0 ? 0 : _keys.length - 1) : (cur + dir + _keys.length) % _keys.length];
        _mark();
    }

    function _runActive() {
        if (!_activeKey) return false;
        const i = _activeKey.indexOf('\u0000');
        return _dispatch(_activeKey.slice(0, i), _activeKey.slice(i + 1));
    }

    /** 打开面板（宿主输入框 focus / input 时调用）。无历史时不弹空面板。 */
    function _open(entry) {
        if (Date.now() < _suppressAt) return;
        _cur = entry;
        ensure().then(() => {
            if (_cur !== entry) return;      // 期间已收起/切到别的框
            if (!_list.length) return;
            if (!_panelEl()) return;
            _render();
            if (!_panel.hasClass('show')) _panel.addClass('show');
            _place();
        }, () => { /* 载入失败：不弹 */ });
    }

    /**
     * 键盘：上/下移动高亮、回车执行高亮项、Esc 收起。
     * 只在「面板已打开」时消费按键，其余情况原样放行（宿主自己的回车搜索不受影响）；
     * 消费时 stopImmediatePropagation——本绑定先于宿主的同元素 keydown（见 attach 注释），
     * 不拦会让宿主的回车先跑掉、高亮项根本没机会生效。
     */
    function _onKey(e, entry) {
        if (!e || _cur !== entry || !isOpen()) return;
        if (e.key === 'Escape') {
            _hide();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            // 面板已消费本次 Esc：不再冒泡给 document 上的全局 Esc 派发（common.js
            // dispatchEsc：关对话框/封面浮层/视图级返回），避免一次按键关两层
            if (e.stopPropagation) e.stopPropagation();
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (e.preventDefault) e.preventDefault();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            _move(e.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (e.key === 'Enter' && _activeKey) {
            if (e.preventDefault) e.preventDefault();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            _runActive();
        }
    }

    /**
     * 把一个输入框接入历史面板。sel 为输入框选择器，source 为它对应的来源。
     * 幂等：重复 attach 只保留首绑。
     * 调用方须在宿主自己的同元素 keydown（回车搜索）之前调用本函数——键盘导航依赖
     * 先绑先跑（见 _onKey）。
     */
    function attach(sel, source) {
        if (typeof $ !== 'function' || !sel || !_isSource(source)) return false;
        if (_boundMap[sel]) return true;
        let $input = null;
        try { $input = $(sel); } catch (e) { $input = null; }
        if (!$input || !$input.length) return false;
        const entry = { sel, source: String(source), el: $input[0] || null, $input };
        _boundMap[sel] = entry;
        _bindDoc();
        $input.on('keydown', (e) => _onKey(e, entry));
        // 展开时机（用户裁决）：**主动点击搜索框**才展开，不再监听 focus。
        // 宿主的切页签/切视图会程序化 focus 输入框（Search.focus、BangumiSearch 页签
        // 切换），focus 即展开的表现就是「一打开搜索页，历史面板自己弹出来盖住页面」。
        // pointerdown 而不是 click：click 要等松开，按住输入框准备打字时面板就该在。
        $input.on('pointerdown', () => _open(entry));
        // 有输入也弹（键盘直接打字时同样算主动使用；空值回删到空时不再弹）
        $input.on('input', () => { if (String($input.val() || '') !== '') _open(entry); });
        return true;
    }

    const SearchHistory = {
        SETTINGS_KEY, MAX_ITEMS, SOURCES, PREVIEW_PER_GROUP,
        sanitize, ensure, list, grouped,
        record, remove, clear,
        attach, hide: _hide, isOpen, dispatch: _dispatch,
        // 测试/诊断用的内部钩子（面板 DOM 与抑制窗口）
        _panel: () => _panel,
        _setSuppress: (ms) => { _suppressAt = Date.now() + (Number(ms) || 0); },
    };

    root.SearchHistory = SearchHistory;
    const ns = root.YUKI || {};
    ns.searchHistory = SearchHistory;
    root.YUKI = ns;
})();
