/**
 * search.js — 多源聚合搜索（Phase 2）
 *
 * 走 SSE 端点 GET /search/stream?word=，后端每个源完成即推一条 data：
 *   data: {"source": key, "name": 名称, "list": [...]}
 * 全部结束发 event: done。逐源流式追加渲染；结果项点击进详情。
 * 来源筛选：每收到一个源生成一枚筛选标签，点击只看该源结果。
 * 分页：每个源分组默认展示 SEARCH_PAGE_SIZE 条，超出部分折叠，
 * 点击「展开全部 N 条」一次性展示，避免单源千百条撑爆 DOM。
 */
/* global $, apiUrl, escHtml, warnToast, Detail, vodCard */

const SEARCH_PAGE_SIZE = 30;

const Search = {
    es: null,
    _inited: false,

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
        // 搜索结果分组展开/收起
        $('#search-results')
            .on('click', '.src-expand', function () {
                const grp = $(this).closest('.src-group');
                grp.find('.src-fold').show();
                $(this).hide();
                grp.find('.src-collapse').show();
            })
            .on('click', '.src-collapse', function () {
                const grp = $(this).closest('.src-group');
                grp.find('.src-fold').hide();
                $(this).hide();
                grp.find('.src-expand').show();
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
        // 超过 SEARCH_PAGE_SIZE 条时折叠：首屏仅展示前 SEARCH_PAGE_SIZE 条，
        // 底部附加「展开全部 N 条」按钮，点击一次性展示剩余条目
        const show = list.slice(0, SEARCH_PAGE_SIZE);
        const hidden = list.slice(SEARCH_PAGE_SIZE);
        const cards = show.map((v) => {
            const html = vodCard(v);
            return html.replace('class="vod-card"', `class="vod-card" data-source="${escHtml(src)}"`);
        }).join('');
        let fold = '';
        if (hidden.length) {
            const hiddenCards = hidden.map((v) => {
                const html = vodCard(v);
                return html.replace('class="vod-card"', `class="vod-card" data-source="${escHtml(src)}"`);
            }).join('');
            fold = `<div class="src-fold" style="display:none">${hiddenCards}</div>
                <button class="src-expand md-btn md-btn-tonal md-btn-sm" data-src="${escHtml(src)}">展开全部 ${total} 条（已显示 ${SEARCH_PAGE_SIZE} 条）</button>
                <button class="src-collapse md-btn md-btn-tonal md-btn-sm" data-src="${escHtml(src)}" style="display:none">收起</button>`;
        }
        box.append(head + `<div class="vod-grid">${cards}</div>${fold}</div>`);
    },
};
