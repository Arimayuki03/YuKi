/**
 * Rule 4: 依赖 local.get / local.set 做 cookie / token 缓存和 session 维持的规则
 * 特点：
 * 1. 使用 local.get 和 local.set (或 setItem/getItem) 进行持久化/跨调用会话缓存。
 * 2. 模拟需要登录态、Cookie/SessionId 维持的站点访问逻辑（如失效重登、带 Cookie 请求）。
 * 3. 验证 drpy JS 宿主对 local 存储对象的桥接能力与状态持久化机制。
 */

var rule = {
    title: '状态缓存与Session维持规则',
    host: 'http://127.0.0.1:9999',

    // 辅助函数：确保已登录并获取有效的 session_token / session_id
    _ensureAuth: function() {
        var token = '';
        var sessionId = '';

        // 尝试从 local 存储读取缓存的凭证
        if (typeof local !== 'undefined' && local.get) {
            token = local.get('rule4_token') || '';
            sessionId = local.get('rule4_session_id') || '';
        }

        // 如果没有凭证，则调用 /stateful/login 进行登录并存入 local
        if (!token || !sessionId) {
            var loginRes = post(this.host + '/stateful/login', {
                body: JSON.stringify({ user: 'mock_tester', pass: 'secret_123' }),
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            var data = JSON.parse(loginRes || '{}');
            if (data.code === 0) {
                token = data.token;
                sessionId = data.session_id;
                if (typeof local !== 'undefined' && local.set) {
                    local.set('rule4_token', token);
                    local.set('rule4_session_id', sessionId);
                }
            }
        }

        return {
            token: token,
            sessionId: sessionId
        };
    },

    _getAuthHeaders: function() {
        var auth = this._ensureAuth();
        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Cookie': 'session_token=' + auth.token,
            'X-Session-ID': auth.sessionId
        };
    },

    home: function(filter) {
        var headers = this._getAuthHeaders();
        var res = request(this.host + '/stateful/home', {
            headers: headers
        });
        var data = JSON.parse(res);
        return JSON.stringify({
            class: data.class,
            list: data.list
        });
    },

    category: function(tid, pg, filter, extend) {
        var headers = this._getAuthHeaders();
        var reqUrl = this.host + '/stateful/category?tid=' + (tid || 's1') + '&pg=' + (pg || '1');
        var res = request(reqUrl, {
            headers: headers
        });
        var data = JSON.parse(res);
        return JSON.stringify({
            page: data.page,
            pagecount: data.pagecount,
            list: data.list
        });
    },

    detail: function(id) {
        var headers = this._getAuthHeaders();
        var res = request(this.host + '/stateful/detail?id=' + id, {
            headers: headers
        });
        var data = JSON.parse(res);
        return JSON.stringify({
            list: [data.data]
        });
    },

    search: function(wd, quick, pg) {
        var headers = this._getAuthHeaders();
        var res = request(this.host + '/stateful/search?wd=' + encodeURIComponent(wd), {
            headers: headers
        });
        var data = JSON.parse(res);
        return JSON.stringify({
            page: parseInt(pg || '1', 10),
            list: data.list
        });
    },

    play: function(flag, id, flags) {
        var auth = this._ensureAuth();
        // 播放地址带上 session token 参数
        return JSON.stringify({
            parse: 0,
            url: id,
            header: {
                'Cookie': 'session_token=' + auth.token,
                'X-Session-ID': auth.sessionId
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
