// spider-loader.js — 对齐原 assets/js/lib/spider.js 的加载协议
//
// 前置：spider 源码已经 esm_transform 转换为脚本，exports 收集在
// globalThis.__MODULE_EXPORTS__（对应原协议的 `import * as spider from '%s'`）。
if (!globalThis.__JS_SPIDER__) {
    var spider = globalThis.__MODULE_EXPORTS__;
    if (spider.__jsEvalReturn) {
        globalThis.req = http;
        globalThis.__JS_SPIDER__ = spider.__jsEvalReturn();
    } else if (spider.default) {
        globalThis.__JS_SPIDER__ = typeof spider.default === 'function' ? spider.default() : spider.default;
    }
}

// ---------- 宿主方法调用桥 ----------
// 返回约定：字符串(方法原始返回，通常为 JSON 串) / '__PROMISE__'(异步方法)
globalThis.__YUKI_CALL__ = function (method, argsJson) {
    try {
        var s = globalThis.__JS_SPIDER__;
        if (!s || typeof s[method] !== 'function') {
            return JSON.stringify({ __yuki_err__: 'no method: ' + method });
        }
        var args = argsJson ? JSON.parse(argsJson) : [];
        var r = s[method].apply(s, args);
        if (r && typeof r.then === 'function') {
            globalThis.__YUKI_PENDING__ = true;
            globalThis.__YUKI_RESULT__ = undefined;
            r.then(
                function (v) { globalThis.__YUKI_RESULT__ = v; globalThis.__YUKI_PENDING__ = false; },
                function (e) { globalThis.__YUKI_RESULT__ = { __yuki_err__: String(e && e.message || e) }; globalThis.__YUKI_PENDING__ = false; }
            );
            return '__PROMISE__';
        }
        return typeof r === 'string' ? r : JSON.stringify(r === undefined ? null : r);
    } catch (e) {
        return JSON.stringify({ __yuki_err__: String(e && e.message || e) });
    }
};

globalThis.__YUKI_FETCH_RESULT__ = function () {
    var v = globalThis.__YUKI_RESULT__;
    return typeof v === 'string' ? v : JSON.stringify(v === undefined ? null : v);
};
