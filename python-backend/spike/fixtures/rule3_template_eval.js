/**
 * Rule 3: 动态代码执行、jinja/正则替换或二级动态解析类规则
 * 特点：
 * 1. 使用 eval / Function / 正则表达式从网页 JS 脚本或嵌入变量中提取动态结构体。
 * 2. 处理 Base64 解码与二级动态构造 stream play url。
 * 3. 验证 JS 引擎的动态语法执行、作用域隔离和正则匹配能力。
 */

// Base64 解码兜底链：atob -> CryptoJS.enc.Base64 -> 纯 JS 实现（裸 quickjs 也可运行）
var _b64decode = function (s) {
    s = String(s || '');
    if (typeof atob === 'function') {
        return atob(s);
    }
    if (typeof CryptoJS !== 'undefined' && CryptoJS.enc && CryptoJS.enc.Base64) {
        var words = CryptoJS.enc.Base64.parse(s);
        return CryptoJS.enc.Utf8.stringify(words);
    }
    var table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '', i = 0;
    s = s.replace(/[^A-Za-z0-9+/=]/g, '');
    while (i < s.length) {
        var e1 = table.indexOf(s.charAt(i++));
        var e2 = table.indexOf(s.charAt(i++));
        var e3 = table.indexOf(s.charAt(i++));
        var e4 = table.indexOf(s.charAt(i++));
        var c1 = (e1 << 2) | (e2 >> 4);
        var c2 = ((e2 & 15) << 4) | (e3 >> 2);
        var c3 = ((e3 & 3) << 6) | e4;
        out += String.fromCharCode(c1);
        if (e3 !== 64) out += String.fromCharCode(c2);
        if (e4 !== 64) out += String.fromCharCode(c3);
    }
    return out;
};

var rule = {
    title: '动态代码与模板二级解析',
    host: 'http://127.0.0.1:9999',

    home: function(filter) {
        var html = request(this.host + '/dynamic/home');
        // 使用正则提取 script 内嵌的 JS 变量 pageConfig
        var match = html.match(/var\s+pageConfig\s*=\s*(\{[\s\S]*?\});/);
        var pageConfig = {};
        if (match && match[1]) {
            // 通过 Function 或 eval 动态执行获取 JS 对象
            pageConfig = (new Function('return ' + match[1]))();
        }

        var classes = (pageConfig.cate || []).map(function(item) {
            return {
                type_id: item.id,
                type_name: item.name
            };
        });

        var list = (pageConfig.recom || []).map(function(item) {
            return {
                vod_id: item.id,
                vod_name: item.name,
                vod_pic: item.pic,
                vod_remarks: item.note
            };
        });

        return JSON.stringify({
            class: classes,
            list: list
        });
    },

    category: function(tid, pg, filter, extend) {
        var jsContent = request(this.host + '/dynamic/category?tid=' + (tid || 'd1') + '&pg=' + (pg || '1'));
        // 动态执行 JS 代码片断
        var sandboxCode = jsContent + '; return typeof __DATA__ !== "undefined" ? __DATA__ : null;';
        var data = (new Function(sandboxCode))() || { items: [], page: 1, totalPage: 1 };

        var list = (data.items || []).map(function(item) {
            return {
                vod_id: item.vid,
                vod_name: item.title,
                vod_pic: item.thumb,
                vod_remarks: item.desc
            };
        });

        return JSON.stringify({
            page: data.page,
            pagecount: data.totalPage,
            list: list
        });
    },

    detail: function(id) {
        var html = request(this.host + '/dynamic/detail?id=' + id);
        // 从 HTML 自定义属性中提取 base64 数据
        var matchPayload = html.match(/data-payload="([A-Za-z0-9+/=]+)"/);
        var payloadJson = '{}';
        if (matchPayload && matchPayload[1]) {
            payloadJson = _b64decode(matchPayload[1]);
        }

        var detailObj = JSON.parse(payloadJson || '{}');
        var playUrls = (detailObj.urls || []).map(function(u) {
            return u.name + '$' + u.raw;
        }).join('#');

        var vod = {
            vod_id: detailObj.id || id,
            vod_name: detailObj.name,
            vod_pic: detailObj.cover,
            vod_actor: detailObj.actor,
            vod_content: detailObj.summary,
            vod_play_from: '动态专线',
            vod_play_url: playUrls
        };

        return JSON.stringify({
            list: [vod]
        });
    },

    search: function(wd, quick, pg) {
        var html = request(this.host + '/dynamic/search?wd=' + encodeURIComponent(wd));
        var match = html.match(/window\.__SEARCH_RESULTS__\s*=\s*(\[[\s\S]*?\]);/);
        var searchList = [];
        if (match && match[1]) {
            var rawArr = eval('(' + match[1] + ')');
            searchList = (rawArr || []).map(function(item) {
                return {
                    vod_id: item.id,
                    vod_name: item.name,
                    vod_pic: item.pic,
                    vod_remarks: item.note
                };
            });
        }

        return JSON.stringify({
            page: parseInt(pg || '1', 10),
            list: searchList
        });
    },

    play: function(flag, id, flags) {
        // 二级解析：模拟从 detail 取得的 eval_stream:// 提取并计算直链
        // 动态执行 seed 算法
        var seed = 1337;
        var cleanRaw = id.replace(/eval_stream:\/\//, '');
        var finalStream = 'https://cdn.eval.test/' + cleanRaw + '.m3u8?seed=' + seed + '&t=' + Date.now();

        return JSON.stringify({
            parse: 0,
            url: finalStream,
            header: {
                'Referer': this.host + '/dynamic/detail'
            }
        });
    }
};

// ---- 标准导出（多协议兼容，与 rule1/rule2 保持一致） ----
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
