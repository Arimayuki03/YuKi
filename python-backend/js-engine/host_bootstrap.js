// host_bootstrap.js — quickjs 宿主引导（在 Python 侧注入原生函数后 eval）
//
// 原生回调约定（quickjs-ng 限制：原生函数只能接收/返回标量）：
//   _native_http(url, options_json_str) -> json_str  同步 HTTP（Python requests）
//   _native_log(level, msg)             -> null      日志回传

// ---------- console ----------
(function () {
    function fmt(args) {
        return Array.prototype.map.call(args, function (a) {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
    }
    globalThis.console = {
        log: function () { _native_log('info', fmt(arguments)); },
        info: function () { _native_log('info', fmt(arguments)); },
        warn: function () { _native_log('warn', fmt(arguments)); },
        error: function () { _native_log('error', fmt(arguments)); },
        debug: function () { _native_log('debug', fmt(arguments)); },
    };
})();

// ---------- 全局别名（对齐原 http.js 尾部） ----------
(function () {
    function defineGlobalAlias(name) {
        var descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        if (descriptor && !descriptor.configurable) return;
        Object.defineProperty(globalThis, name, {
            enumerable: true,
            configurable: true,
            get: function () { return globalThis; },
            set: function () {},
        });
    }
    ['global', 'window', 'self'].forEach(defineGlobalAlias);
})();

// ---------- HTTP（对齐原 http.js 语义） ----------
function _http(url, options) {
    return JSON.parse(_native_http(String(url), JSON.stringify(options || {})));
}

function http(url, options) {
    options = options || {};
    if (options.async === false) return _http(url, options);
    // 宿主无事件循环：同步执行后用已兑现的 Promise 包装，保持调用形态兼容
    return new Promise(function (resolve) {
        try {
            resolve(_http(url, options));
        } catch (err) {
            console.error(err && err.name, err && err.message);
            resolve({ ok: false, status: 500, url: url });
        }
    });
}

globalThis.http = http;
globalThis.req = function (url, options) {
    return http(url, Object.assign({ async: false }, options || {}));
};
globalThis.log = function () { console.log.apply(console, arguments); };

// ---------- local KV（对齐 TVBox local API：key+kv 两级命名空间） ----------
globalThis.local = {
    get: function (key, kv) {
        try { return _native_local_get(String(key) + '\u0001' + String(kv)); } catch (e) { return ''; }
    },
    set: function (key, kv, value) {
        try { _native_local_set(String(key) + '\u0001' + String(kv), String(value)); } catch (e) {}
    },
    delete: function (key, kv) {
        try { _native_local_delete(String(key) + '\u0001' + String(kv)); } catch (e) {}
    },
};

// ---------- md5X（TVBox 内置 md5 hex） ----------
globalThis.md5X = function (text) {
    try { return _native_md5(String(text)); } catch (e) { return ''; }
};

// ---------- js2Proxy（TVBox 签名：need, siteType, siteKey, flag, header） ----------
globalThis.js2Proxy = function (need, siteType, siteKey, flag, header) {
    try { return _native_js2proxy(String(siteKey), String(flag || '')); } catch (e) { return ''; }
};

// ---------- TextEncoder / TextDecoder（quickjs 无内置，仅支持 utf-8） ----------
if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = function () {};
    globalThis.TextEncoder.prototype.encode = function (str) {
        str = String(str === undefined ? '' : str);
        var bytes = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.codePointAt(i);
            if (c > 0xffff) i++;
            if (c < 0x80) bytes.push(c);
            else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
            else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
            else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
        var out = new Uint8Array(bytes.length);
        for (var j = 0; j < bytes.length; j++) out[j] = bytes[j];
        return out;
    };
}
if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = function () {};
    globalThis.TextDecoder.prototype.decode = function (bytes) {
        bytes = bytes || [];
        var out = '', i = 0;
        while (i < bytes.length) {
            var b = bytes[i], c;
            if (b < 0x80) { c = b; i += 1; }
            else if (b < 0xe0) { c = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); i += 2; }
            else if (b < 0xf0) { c = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3; }
            else { c = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); i += 4; }
            out += String.fromCodePoint(c);
        }
        return out;
    };
}
