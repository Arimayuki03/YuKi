/**
 * search.js — 多源聚合搜索（Phase 2）
 *
 * 走 SSE 端点 GET /search/stream?word=，后端每个源完成即推一条 data：
 *   data: {"source": key, "name": 名称, "list": [...]}
 * 全部结束发 event: done。逐源流式追加渲染；结果项点击进详情。
 * 来源筛选：每收到一个源生成一枚筛选标签，点击只看该源结果。
 * 分页（T38）：「全部」视图每组限显前 20 条（无分页器，超出的点上
 * 方来源标签进单源视图）；单源视图启用统一分页器，每页 20 条翻
 * 看该源全部结果；数据已由 SSE 一次给全，纯前端切片，避免千百条撑爆 DOM。
 */
/* global $, apiUrl, escHtml, warnToast, Detail, vodCard, renderPagerBox */

const SEARCH_PAGE_SIZE = 20; // T38：固定每页 20 条，超过即分页（不再走「自动」估算）

const Search = {
    es: null,
    _inited: false,
    _curSrc: '',     // 当前筛选源（空 = 「全部」视图，限显前 20 条）
    _grpSeq: 0,      // 分组 id 自增序号（分页容器唯一定位）
    _grpLists: {},   // gid → { src, list }（SSE 已给全量，纯前端切片翻页）

    init() {
        if (this._inited) return;
        this._inited = true;
        $('#search-go').on('click', () => this.run());
        $('#search-keyword').on('keydown', (e) => {
            if (e.key === 'Enter') { e.target.blur(); this.run(); }
        });
        $('#search-results').on('click', '.vod-card', (e) => {
            const el = $(e.currentTarget);
            Detail.open(el.data('source'), el.data('id'), el.data('name'));
        });
        // 来源筛选标签：全部（限显前 20 条）/ 单源（分页看全部）
        $('#search-filters').on('click', '.class-tab', (e) => {
            const el = $(e.currentTarget);
            $('#search-filters .class-tab').removeClass('active');
            el.addClass('active');
            this._curSrc = String(el.data('src') || '');
            $('#search-results .src-group').each(function () {
                $(this).toggle(!this._curSrc || $(this).data('source') === this._curSrc);
            }.bind(this));
            // 切换视图后重渲：全部→限显首页，单源→启用分页器
            Object.keys(this._grpLists).forEach((gid) => this._paintGrp(gid, 1));
        });
    },

    focus() {
        $('#search-keyword').trigger('focus');
    },

    stop() {
        if (this.es) { try { this.es.close(); } catch (e) { /* ignore */ } this.es = null; }
    },

    async run() {
        const word = $('#search-keyword').val().trim();
        if (!word) { warnToast('请输入关键字'); return; }
        this.stop();
        $('#search-results').empty();
        this._grpLists = {}; // 新搜索：重置分组数据
        this._grpSeq = 0;
        this._curSrc = '';
        // 重置来源筛选栏（默认「全部」）
        $('#search-filters').html('<span class="class-tab active" data-src="">全部</span>').show();
        $('#search-status').text('搜寻中…').show();

        const url = apiUrl('/search/stream?word=' + encodeURIComponent(word));
        const es = new EventSource(url);
        this.es = es;
        let sources = 0;
        let items = 0;

        es.onmessage = (ev) => {
            let payload;
            try { payload = JSON.parse(ev.data); } catch (e) { return; }
            const list = payload.list || [];
            sources += 1;
            items += list.length;
            this.renderGroup(payload, list);
            $('#search-status').text(`已接收 ${sources} 个源 · ${items} 条结果…`);
        };

        es.addEventListener('done', () => {
            es.close();
            this.es = null;
            $('#search-status').text(items ? `完成：${sources} 个源 · ${items} 条结果` : '无结果');
            if (!items) $('#search-results').html('<div class="tip-line">无结果</div>');
        });

        es.onerror = () => {
            // 服务端 done 后关闭连接也会触发 error；若已收到结果则视为正常结束
            if (this.es === null) return;
            es.close();
            this.es = null;
            if (!sources) { $('#search-status').text('搜寻失败'); warnToast('搜寻失败'); }
            else { $('#search-status').text(`完成：${sources} 个源 · ${items} 条结果`); }
        };
    },

    renderGroup(payload, list) {
        const box = $('#search-results');
        const src = payload.source || '';
        const total = list.length;
        const head = `<div class="src-group" data-source="${escHtml(src)}"><div class="src-head">${escHtml(payload.name || src)} <span class="src-count">${total}</span></div>`;
        // 来源筛选标签：带结果数，点击只看该源
        $('#search-filters').append(`<span class="class-tab" data-src="${escHtml(src)}" title="只看该源的结果">${escHtml(payload.name || src)}（${total}）</span>`);
        if (!total) { box.append(head + '<div class="tip-line">该源无结果</div></div>'); return; }
        // 组内分页：数据已全量在手，纯前端切片，统一分页器驱动
        const gid = 'sg' + (this._grpSeq++);
        this._grpLists[gid] = { src, list };
        box.append(head + `<div class="vod-grid" id="${gid}-grid"></div><div class="src-hint tip-line" id="${gid}-hint" style="display:none">仅显示前 ${SEARCH_PAGE_SIZE} 条 · 点上方来源标签分页看全部</div><div class="pager" id="${gid}-pager"></div></div>`);
        this._paintGrp(gid, 1);
    },

    /**
     * 分组渲染（T38）：「全部」视图每组限显前 SEARCH_PAGE_SIZE 条不出分页器
     * （优先按源分类浏览）；点来源标签进单源视图后启用分页器翻看全部。
     */
    _paintGrp(gid, page) {
        const grp = this._grpLists[gid];
        if (!grp) return;
        const focused = this._curSrc && grp.src === this._curSrc;
        const size = SEARCH_PAGE_SIZE;
        const pagecount = focused ? Math.ceil(grp.list.length / size) : 1;
        const slice = grp.list.slice((page - 1) * size, page * size);
        const cards = slice.map((v) => {
            const html = vodCard(v);
            return html.replace('class="vod-card"', `class="vod-card" data-source="${escHtml(grp.src)}"`);
        }).join('');
        $(`#${gid}-grid`).html(cards);
        $(`#${gid}-hint`).toggle(!focused && grp.list.length > size);
        renderPagerBox($(`#${gid}-pager`), focused
            ? { page, pagecount, onJump: (pg) => this._paintGrp(gid, pg) }
            : { page: 1, pagecount: 1 });
    },
};
