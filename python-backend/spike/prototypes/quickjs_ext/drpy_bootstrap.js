// drpy_bootstrap.js — drpy 契约环境扩展与选择器注入
//
// 本文件在 host_bootstrap.js 与 cat.js 之后加载，为 QuickJS 注入完整的 drpy 运行环境：
// 1. DOM 选择器：pdfa, pdfh, pdft, pd (基于内置的 cheerio 引擎)
// 2. URL 拼接工具：joinUrl / urljoin
// 3. 网络请求别名及同步包装：request, req, post
// 4. 本地存储包装：local (支持 get/set/delete/remove/getItem/setItem/removeItem/clear)
// 5. 密码学与工具：CryptoJS, md5X, dayjs 等
// 6. Base64 编码解码：atob, btoa
// 7. rule 协议导出桥接与加载检测

(function () {
    // ---------- 0. Web Crypto / crypto.getRandomValues 垫片 ----------
    // QuickJS 宿主默认无原生 crypto.getRandomValues，会导致 CryptoJS.AES.encrypt 抛出
    // "Native crypto module could not be used to get secure random number."
    if (typeof globalThis.crypto === 'undefined') {
        globalThis.crypto = {};
    }
    if (typeof globalThis.crypto.getRandomValues === 'undefined') {
        globalThis.crypto.getRandomValues = function (typedArray) {
            if (!typedArray || typeof typedArray.length === 'undefined') {
                return typedArray;
            }
            for (var i = 0; i < typedArray.length; i++) {
                typedArray[i] = Math.floor(Math.random() * 256);
            }
            return typedArray;
        };
    }

    // ---------- 1. URL 拼接工具 (joinUrl / urljoin) ----------
    function joinUrl(baseUrl, relativeUrl) {
        if (!relativeUrl) return baseUrl || '';
        if (!baseUrl) return relativeUrl || '';
        baseUrl = String(baseUrl).trim();
        relativeUrl = String(relativeUrl).trim();
        
        // 已经是绝对路径协议
        if (/^[a-zA-Z][a-zA-Z0-9+-.]*:/.test(relativeUrl) || relativeUrl.startsWith('//')) {
            if (relativeUrl.startsWith('//')) {
                var schema = baseUrl.startsWith('https:') ? 'https:' : 'http:';
                return schema + relativeUrl;
            }
            return relativeUrl;
        }

        // 解析 baseUrl 的 protocol, host, pathname
        var m = baseUrl.match(/^([a-zA-Z][a-zA-Z0-9+-.]*:\/\/)([^/]+)(.*)$/);
        if (!m) {
            if (baseUrl.endsWith('/') && relativeUrl.startsWith('/')) {
                return baseUrl + relativeUrl.substring(1);
            }
            if (!baseUrl.endsWith('/') && !relativeUrl.startsWith('/')) {
                return baseUrl + '/' + relativeUrl;
            }
            return baseUrl + relativeUrl;
        }

        var proto = m[1];
        var host = m[2];
        var path = m[3] || '/';

        if (relativeUrl.startsWith('/')) {
            return proto + host + relativeUrl;
        }

        // 相对当前 path
        var lastSlash = path.lastIndexOf('/');
        var basePath = (lastSlash !== -1) ? path.substring(0, lastSlash + 1) : '/';
        var combined = basePath + relativeUrl;

        // 处理 . 和 ..
        var segments = combined.split('/');
        var resolved = [];
        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            if (seg === '' && i !== 0 && i !== segments.length - 1) continue;
            if (seg === '.') continue;
            if (seg === '..') {
                if (resolved.length > 0 && resolved[resolved.length - 1] !== '') {
                    resolved.pop();
                }
            } else {
                resolved.push(seg);
            }
        }
        return proto + host + resolved.join('/');
    }

    globalThis.joinUrl = joinUrl;
    globalThis.urljoin = joinUrl;

    // ---------- 2. drpy DOM 选择器实现 (基于 cheerio) ----------
    // 支持直接传入 HTML 字符串或 cheerio 对象

    function _getCheerioRoot(html) {
        if (!html) return null;
        if (typeof html === 'function' && html.root) {
            return html;
        }
        if (typeof cheerio !== 'undefined' && cheerio.load) {
            return cheerio.load(String(html), { decodeEntities: false });
        }
        return null;
    }

    function pdfa(html, selector) {
        if (!html || !selector) return [];
        try {
            var $ = _getCheerioRoot(html);
            if (!$) return [];
            var elements = $(selector);
            var result = [];
            elements.each(function (i, el) {
                result.push($.html(el));
            });
            return result;
        } catch (e) {
            return [];
        }
    }

    function pdfh(html, expr) {
        if (!html || !expr) return '';
        try {
            var $ = _getCheerioRoot(html);
            if (!$) return '';
            var parts = String(expr).split('&&');
            var selector = parts[0].trim();
            var attr = parts.length > 1 ? parts[1].trim() : null;
            var el = $(selector).first();
            if (!el || el.length === 0) return '';
            if (attr) {
                if (attr === 'text') return el.text().trim();
                if (attr === 'html') return el.html() || '';
                return el.attr(attr) || '';
            }
            return el.text().trim();
        } catch (e) {
            return '';
        }
    }

    function pdft(html, tag) {
        if (!html || !tag) return '';
        try {
            var $ = _getCheerioRoot(html);
            if (!$) return '';
            var el = $(tag).first();
            if (!el || el.length === 0) return '';
            return el.text().trim();
        } catch (e) {
            return '';
        }
    }

    function pd(html, expr) {
        if (!html || !expr) return '';
        try {
            var $ = _getCheerioRoot(html);
            if (!$) return '';
            var parts = String(expr).split('&&');
            var selector = parts[0].trim();
            var attr = parts.length > 1 ? parts[1].trim() : 'href';
            var el = $(selector).first();
            if (!el || el.length === 0) return '';
            return el.attr(attr) || '';
        } catch (e) {
            return '';
        }
    }

    globalThis.pdfa = pdfa;
    globalThis.pdfh = pdfh;
    globalThis.pdft = pdft;
    globalThis.pd = pd;

    // ---------- 3. 网络请求扩展 (request / req / post / fetch) ----------
    // drpy 标准习惯：
    // request(url, opts) / req(url, opts) -> 默认同步返回 body 文本 (也可根据 opts 返回完整结构)
    // post(url, opts) -> 默认同步 POST 请求并返回 body 文本

    function _syncRequest(url, options) {
        var opt = options || {};
        var res = _http(url, opt);
        // 如果 opt 明确要求返回完整 response 对象 (如 returnFull: true)，返回对象
        if (opt.returnFull || opt.withHeaders) {
            return res;
        }
        // 否则 drpy 契约默认返回 content 字符串
        return res ? (res.content !== undefined ? res.content : res.data || '') : '';
    }

    globalThis.request = function (url, options) {
        return _syncRequest(url, options);
    };

    globalThis.post = function (url, options) {
        var opt = Object.assign({}, options || {}, { method: 'POST' });
        return _syncRequest(url, opt);
    };

    // 覆盖/增强 req 保证完全同步返回字符串或对象
    globalThis.req = function (url, options) {
        var opt = options || {};
        if (opt.async === true) {
            return http(url, opt);
        }
        return _syncRequest(url, opt);
    };

    // ---------- 4. 本地存储扩展 (local 支持更多常用别名) ----------
    // host_bootstrap.js 中注入的是 local.get(key, kv) -> _native_local_get(key + '\u0001' + kv)
    if (globalThis.local) {
        var rawGet = globalThis.local.get;
        var rawSet = globalThis.local.set;
        var rawDel = globalThis.local.delete;

        globalThis.local.get = function (key, kv) {
            if (kv === undefined) {
                // 单参数模式：统一使用 key 作为第一级分类 'default'
                return rawGet('default', String(key));
            }
            return rawGet(String(key), String(kv));
        };
        globalThis.local.set = function (key, kv, value) {
            if (value === undefined) {
                return rawSet('default', String(key), String(kv));
            }
            return rawSet(String(key), String(kv), String(value));
        };
        globalThis.local.delete = function (key, kv) {
            if (kv === undefined) {
                return rawDel('default', String(key));
            }
            return rawDel(String(key), String(kv));
        };
        globalThis.local.remove = function (key, kv) {
            return globalThis.local.delete(key, kv);
        };
        globalThis.local.getItem = function (key, kv) {
            return globalThis.local.get(key, kv);
        };
        globalThis.local.setItem = function (key, kv, value) {
            return globalThis.local.set(key, kv, value);
        };
        globalThis.local.removeItem = function (key, kv) {
            return globalThis.local.delete(key, kv);
        };
        globalThis.local.clear = function () {};
    }

    // ---------- 5. Base64 编码解码 (atob / btoa) ----------
    if (typeof globalThis.atob === 'undefined') {
        globalThis.atob = function (str) {
            str = String(str || '').replace(/=+$/, '');
            if (str.length % 4 === 1) {
                throw new Error('InvalidCharacterError: The string to be decoded is not correctly encoded.');
            }
            var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
            var output = '';
            for (var bc = 0, bs = 0, buffer, i = 0;
                (buffer = str.charAt(i++));
                ~buffer && ((bs = bc % 4 ? bs * 64 + buffer : buffer), bc++ % 4)
                    ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
                    : 0
            ) {
                buffer = chars.indexOf(buffer);
            }
            return output;
        };
    }

    if (typeof globalThis.btoa === 'undefined') {
        globalThis.btoa = function (str) {
            var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
            var output = '';
            for (var block = 0, charCode, i = 0, map = chars;
                str.charAt(i | 0) || ((map = '='), i % 1);
                output += map.charAt(63 & (block >> (8 - (i % 1) * 8)))
            ) {
                charCode = str.charCodeAt((i += 3 / 4));
                if (charCode > 0xff) {
                    throw new Error('InvalidCharacterError: The string to be encoded contains characters outside of the Latin1 range.');
                }
                block = (block << 8) | charCode;
            }
            return output;
        };
    }

    // ---------- 6. drpy rule 多规范统一挂载解析 ----------
    globalThis.__DRPY_EXTRACT_RULE__ = function () {
        var r = null;
        if (typeof globalThis.rule !== 'undefined' && globalThis.rule) {
            r = globalThis.rule;
        } else if (typeof globalThis.__MODULE_EXPORTS__ !== 'undefined' && globalThis.__MODULE_EXPORTS__.rule) {
            r = globalThis.__MODULE_EXPORTS__.rule;
        } else if (typeof globalThis.exports !== 'undefined' && globalThis.exports.rule) {
            r = globalThis.exports.rule;
        } else if (typeof globalThis.__jsEvalReturn === 'function') {
            r = globalThis.__jsEvalReturn();
        } else if (typeof globalThis.__jsEvalReturn !== 'undefined' && globalThis.__jsEvalReturn) {
            r = globalThis.__jsEvalReturn;
        } else if (typeof globalThis.__JS_SPIDER__ !== 'undefined' && globalThis.__JS_SPIDER__) {
            r = globalThis.__JS_SPIDER__;
        }
        if (r) {
            globalThis.__JS_SPIDER__ = r;
            globalThis.rule = r;
        }
        return r;
    };
})();
