/**
 * Rule 1: Simple HTML/DOM CMS 解析规则
 * 特点：
 * 1. 使用标准 pdfa / pdfh / pdft / pd DOM 选择器进行 HTML 节点定位与属性提取。
 * 2. 覆盖 home, category, search, detail, play 全流程。
 * 3. 兼容标准 drpy rule 规范及 __jsEvalReturn 导出。
 */

var rule = {
    title: '简单HTML-CMS解析',
    host: 'http://127.0.0.1:9999',
    url: '/cms/category/fyclass?page=fypage',
    searchUrl: '/cms/search?wd=**&page=fypage',
    searchable: 2,
    quickSearch: 0,
    filterable: 0,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    timeout: 5000,
    class_name: '电影&电视剧&动漫',
    class_url: 'movie&tv&anime',
    play_parse: true,

    // 一级/首页解析
    home: function(filter) {
        var html = request(this.host + '/cms');
        var classes = [];
        var nav_elements = pdfa(html, '.nav-menu a.nav-item');
        for (var i = 0; i < nav_elements.length; i++) {
            var item = nav_elements[i];
            var type_name = pdft(item, 'a');
            var href = pd(item, 'a&&href');
            var type_id = href.replace('/cms/category/', '').replace('/', '');
            classes.push({
                type_id: type_id,
                type_name: type_name
            });
        }

        var list = [];
        var items = pdfa(html, '.module-items .module-item');
        for (var j = 0; j < items.length; j++) {
            var card = items[j];
            var title = pdfh(card, '.module-item-title&&title') || pdft(card, '.module-item-title');
            var pic = pd(card, 'img&&src');
            var link = pd(card, 'a&&href');
            var remarks = pdft(card, '.module-item-text');
            var vod_id = link.replace('/cms/detail/', '');
            list.push({
                vod_id: vod_id,
                vod_name: title,
                vod_pic: pic,
                vod_remarks: remarks
            });
        }

        return JSON.stringify({
            class: classes,
            list: list
        });
    },

    // 分类页解析
    category: function(tid, pg, filter, extend) {
        var reqUrl = this.host + '/cms/category/' + tid + '?page=' + (pg || '1');
        var html = request(reqUrl);
        var list = [];
        var items = pdfa(html, '.module-items .module-item');
        for (var i = 0; i < items.length; i++) {
            var card = items[i];
            var title = pdfh(card, '.module-item-title&&title');
            var pic = pd(card, 'img&&src');
            var link = pd(card, 'a&&href');
            var remarks = pdft(card, '.module-item-text');
            var vod_id = link.replace('/cms/detail/', '');
            list.push({
                vod_id: vod_id,
                vod_name: title,
                vod_pic: pic,
                vod_remarks: remarks
            });
        }

        return JSON.stringify({
            page: parseInt(pg || '1', 10),
            pagecount: 10,
            limit: 20,
            total: 200,
            list: list
        });
    },

    // 详情页解析
    detail: function(id) {
        var detailUrl = this.host + '/cms/detail/' + id;
        var html = request(detailUrl);

        var title = pdft(html, '.video-title');
        var pic = pd(html, '.video-cover&&src');
        var tags = pdft(html, '.video-tags');
        var year = pdft(html, '.video-year');
        var area = pdft(html, '.video-area');
        var actor = pdft(html, '.video-actor');
        var director = pdft(html, '.video-director');
        var desc = pdft(html, '.video-desc');

        var tabs = [];
        var tab_nodes = pdfa(html, '.playlist-tab .tab-item');
        for (var i = 0; i < tab_nodes.length; i++) {
            tabs.push(pdft(tab_nodes[i], 'span'));
        }
        if (tabs.length === 0) {
            tabs = ['默认播放'];
        }

        var playLists = [];
        var content_nodes = pdfa(html, '.playlist-content ul.episode-list');
        for (var k = 0; k < content_nodes.length; k++) {
            var ul = content_nodes[k];
            var ep_nodes = pdfa(ul, 'li');
            var epList = [];
            for (var m = 0; m < ep_nodes.length; m++) {
                var aNode = ep_nodes[m];
                var name = pdft(aNode, 'a');
                var href = pd(aNode, 'a&&href');
                epList.push(name + '$' + href);
            }
            playLists.push(epList.join('#'));
        }

        var vod = {
            vod_id: id,
            vod_name: title,
            vod_pic: pic,
            vod_type: tags,
            vod_year: year,
            vod_area: area,
            vod_actor: actor,
            vod_director: director,
            vod_content: desc,
            vod_play_from: tabs.join('$$$'),
            vod_play_url: playLists.join('$$$')
        };

        return JSON.stringify({
            list: [vod]
        });
    },

    // 搜索解析
    search: function(wd, quick, pg) {
        var searchUrl = this.host + '/cms/search?wd=' + encodeURIComponent(wd) + '&page=' + (pg || '1');
        var html = request(searchUrl);
        var list = [];
        var items = pdfa(html, '.search-result-list .module-item');
        for (var i = 0; i < items.length; i++) {
            var card = items[i];
            var title = pdfh(card, '.module-item-title&&title');
            var pic = pd(card, 'img&&src');
            var link = pd(card, 'a&&href');
            var remarks = pdft(card, '.module-item-text');
            var vod_id = link.replace('/cms/detail/', '');
            list.push({
                vod_id: vod_id,
                vod_name: title,
                vod_pic: pic,
                vod_remarks: remarks
            });
        }
        return JSON.stringify({
            page: parseInt(pg || '1', 10),
            list: list
        });
    },

    // 播放解析
    play: function(flag, id, flags) {
        // 直接返回播放地址
        var finalUrl = id;
        if (id.indexOf('http') !== 0) {
            finalUrl = this.host + id;
        }
        return JSON.stringify({
            parse: 0,
            url: finalUrl,
            header: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        });
    }
};

// ---- 标准导出（多协议兼容） ----
// 1) __jsEvalReturn(): 函数协议，TVBox/spider-loader 宿主以 spider.__jsEvalReturn() 取规则对象
// 2) exports.rule / exports.__jsEvalReturn: CommonJS 形态（node require / 部分 drpy 加载器）
// 3) export {}: ESM 命名导出（quickjs 宿主 esm_transform 收集到 __MODULE_EXPORTS__）
var __jsEvalReturn = function () {
    return rule;
};
if (typeof exports !== 'undefined') {
    exports.rule = rule;
    exports.__jsEvalReturn = __jsEvalReturn;
}
export { __jsEvalReturn, rule };
