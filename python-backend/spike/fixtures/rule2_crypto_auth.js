/**
 * Rule 2: 包含 CryptoJS 加密鉴权/Token 计算类规则
 * 特点：
 * 1. 使用 CryptoJS.MD5, SHA256, HmacSHA256, AES 计算动态请求签名(X-Signature)和鉴权Header。
 * 2. 模拟前后端接口防刷与防篡改签名校验机制。
 * 3. 覆盖 home, category, search, detail, play 鉴权流程。
 */

var rule = {
    title: 'CryptoJS加密鉴权API',
    host: 'http://127.0.0.1:9999',
    appKey: 'mock_app_key_2026',
    appSecret: 'mock_secret_xyz_987654321',

    // 辅助函数：生成签名请求头
    _getSignHeaders: function(path, params) {
        var timestamp = Math.floor(Date.now() / 1000).toString();
        var nonce = Math.random().toString(36).substring(2, 10);
        
        // 构造待签名串: path + sorted params + timestamp + nonce + secret
        var paramKeys = Object.keys(params || {}).sort();
        var paramStr = '';
        for (var i = 0; i < paramKeys.length; i++) {
            var k = paramKeys[i];
            paramStr += '&' + k + '=' + params[k];
        }
        var rawSignStr = path + '?' + paramStr + '&t=' + timestamp + '&nonce=' + nonce + '&key=' + this.appKey;
        
        // 使用 SHA256 / MD5 进行多层哈希签名
        var md5Hash = CryptoJS.MD5(rawSignStr).toString();
        var signature = CryptoJS.HmacSHA256(md5Hash, this.appSecret).toString(CryptoJS.enc.Hex);

        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json',
            'X-Auth-Token': 'Bearer ' + CryptoJS.SHA256(this.appKey + ':' + timestamp).toString(),
            'X-Signature': signature,
            'X-Timestamp': timestamp,
            'X-Nonce': nonce
        };
    },

    home: function(filter) {
        var path = '/api/crypto/nav';
        var headers = this._getSignHeaders(path, {});
        var res = request(this.host + path, {
            headers: headers,
            method: 'GET'
        });
        var data = JSON.parse(res);
        return JSON.stringify({
            class: data.classes,
            list: data.recommend
        });
    },

    category: function(tid, pg, filter, extend) {
        var path = '/api/crypto/list';
        var params = {
            tid: tid,
            pg: pg || '1'
        };
        var headers = this._getSignHeaders(path, params);
        var res = request(this.host + path + '?tid=' + params.tid + '&pg=' + params.pg, {
            headers: headers,
            method: 'GET'
        });
        var data = JSON.parse(res);
        return JSON.stringify({
            page: data.page,
            pagecount: data.pagecount,
            total: data.total,
            list: data.list
        });
    },

    detail: function(id) {
        var path = '/api/crypto/detail';
        var params = { id: id };
        var headers = this._getSignHeaders(path, params);
        var res = request(this.host + path + '?id=' + id, {
            headers: headers,
            method: 'GET'
        });
        var data = JSON.parse(res);
        return JSON.stringify({
            list: [data.data]
        });
    },

    search: function(wd, quick, pg) {
        var path = '/api/crypto/search';
        var params = { wd: wd };
        var headers = this._getSignHeaders(path, params);
        var res = request(this.host + path + '?wd=' + encodeURIComponent(wd), {
            headers: headers,
            method: 'GET'
        });
        var data = JSON.parse(res);
        return JSON.stringify({
            page: parseInt(pg || '1', 10),
            list: data.list
        });
    },

    play: function(flag, id, flags) {
        var path = '/api/crypto/play_sign';
        var params = { play_id: id };
        var headers = this._getSignHeaders(path, params);
        var res = request(this.host + path + '?play_id=' + encodeURIComponent(id), {
            headers: headers,
            method: 'GET'
        });
        var data = JSON.parse(res);

        // 播放直链以 AES 信封返回（OpenSSL Salted 格式），此处解密二次解析
        var url = data.url;
        var parseFlag = data.parse;
        if (data.data && typeof data.data === 'string') {
            var plain = CryptoJS.AES.decrypt(data.data, this.appSecret)
                .toString(CryptoJS.enc.Utf8);
            var inner = JSON.parse(plain);
            url = inner.url || url;
            parseFlag = typeof inner.parse !== 'undefined' ? inner.parse : parseFlag;
        }

        return JSON.stringify({
            parse: parseFlag,
            url: url,
            header: headers
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
