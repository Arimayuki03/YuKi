/**
 * search.js — 多源聚合搜索（Phase 2）
 *
 * 走 SSE 端点 GET /search/stream?word=，后端每个源完成即推一条 data：
 *   data: {"source": key, "name": 名称, "list": [...]}
 * 全部结束发 event: done。逐源流式追加渲染；结果项点击进详情。
 * 来源筛选：每收到一个源生成一枚筛选标签，点击只看该源结果。
 * 分页（T6）：每个源分组内部用统一分页器翻页，每页 SEARCH_PAGE_SIZE 条，
 * 数据已由 SSE 一次给全，纯前端切片，避免单源千百条撑爆 DOM。
 */
/* global $, apiUrl, escHtml, warnToast, Detail, vodCard, renderPagerBox */

const SEARCH_PAGE_SIZE = 30;

const Search = {
    es: null,
    _inited: false,
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
        // 来源筛选标签：全部 / 单源
        $('#search-filters').on('click', '.class-tab', (e) => {
            const el = $(e.currentTarget);
            $('#search-filters .class-tab').removeClass('active');
            el.addClass('active');
            const src = el.data('src') || '';
            $('#search-results .src-group').each(function () {
                $(this).toggle(!src || $(this).data('source') === src);
            });
        });
    },

    focus() {
        $('#search-keyword').trigger('focus');
    },

    stop() {
        if (this.es) { try { this.es.close(); } catch (e) { /* ignore */ } this.es = null; }
    },

    run() {
        const word = $('#search-keyword').val().trim();
        if (!word) { warnToast('请输入关键字'); return; }
        this.stop();
        $('#search-results').empty();
        this._grpLists = {}; // 新搜索：重置分组数据
        this._grpSeq = 0;
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
        box.append(head + `<div class="vod-grid" id="${gid}-grid"></div><div class="pager" id="${gid}-pager"></div></div>`);
        this._renderGrpPage(gid, 1);
    },

    /** 分组翻页渲染：按 SEARCH_PAGE_SIZE 切片 + 统一分页器。 */
    _renderGrpPage(gid, page) {
        const grp = this._grpLists[gid];
        if (!grp) return;
        const pagecount = Math.ceil(grp.list.length / SEARCH_PAGE_SIZE);
        const slice = grp.list.slice((page - 1) * SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE);
        const cards = slice.map((v) => {
            const html = vodCard(v);
            return html.replace('class="vod-card"', `class="vod-card" data-source="${escHtml(grp.src)}"`);
        }).join('');
        $(`#${gid}-grid`).html(cards);
        renderPagerBox($(`#${gid}-pager`), { page, pagecount, onJump: (pg) => this._renderGrpPage(gid, pg) });
    },
};
