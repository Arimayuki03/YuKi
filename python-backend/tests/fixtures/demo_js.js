// demo_js.js — JS spider 测试夹具（__jsEvalReturn 协议形态）
// 覆盖：exports 协议、req() 同步 HTTP 存在性、cheerio/CryptoJS 全局注入、
// 异步方法（home 返回 Promise）、同步方法（search）。
export function __jsEvalReturn() {
    return {
        init: function (ext) {
            globalThis.__EXT__ = ext || '';
        },
        home: function (filter) {
            var self = this;
            return new Promise(function (resolve) {
                resolve(JSON.stringify({
                    class: [{ type_id: 'js', type_name: 'JS分类' }],
                    list: [{ vod_id: 'js-1', vod_name: 'JS示例影片', vod_remarks: 'HD' }],
                    filters: {},
                    meta: {
                        hasReq: typeof req === 'function',
                        hasCheerio: typeof cheerio === 'function' || typeof cheerio === 'object',
                        hasCrypto: typeof CryptoJS === 'object',
                        extSeen: globalThis.__EXT__ || '',
                    },
                }));
            });
        },
        homeVod: function () {
            return JSON.stringify({ list: [] });
        },
        category: function (tid, pg, filter, extend) {
            return JSON.stringify({ list: [], page: pg, pagecount: 1, total: 0 });
        },
        detail: function (ids) {
            return JSON.stringify({
                list: [{ vod_id: ids, vod_name: 'JS详情', vod_play_from: 'jsdemo', vod_play_url: '第1集$js://ep1' }],
            });
        },
        search: function (wd, quick, pg) {
            return JSON.stringify({
                list: [{ vod_id: 'js-search-1', vod_name: wd + '(JS结果)', vod_remarks: String(quick) }],
            });
        },
        play: function (flag, id, vipFlags) {
            return JSON.stringify({ url: id, parse: 0 });
        },
        proxy: function (param) {
            return JSON.stringify(['js-proxy-ok', param && param.k]);
        },
    };
}
