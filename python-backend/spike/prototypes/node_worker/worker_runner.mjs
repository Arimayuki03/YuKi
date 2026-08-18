/**
 * worker_runner.mjs
 * Node.js 沙箱隔离运行器，支持 drpy 规则执行与 JSON-RPC 2.0 stdio IPC 通信。
 */

import vm from 'node:vm';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as cheerio from 'cheerio';
import CryptoJS from 'crypto-js';
import dayjs from 'dayjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SYNC_HTTP_SCRIPT = path.join(__dirname, 'sync_http.cjs');

// ----------------------------------------------------------------------------
// 1. 安全受控临时目录与受控 fs
// ----------------------------------------------------------------------------
const WORKER_TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'drpy_worker_'));

function ensureSafePath(targetPath) {
    const resolved = path.resolve(WORKER_TEMP_DIR, targetPath);
    if (!resolved.startsWith(WORKER_TEMP_DIR)) {
        throw new Error(`[SecurityError] Access denied: file path "${targetPath}" is outside the allowed sandbox directory.`);
    }
    return resolved;
}

const safeFs = {
    readFileSync(p, options) {
        return fs.readFileSync(ensureSafePath(p), options);
    },
    writeFileSync(p, data, options) {
        return fs.writeFileSync(ensureSafePath(p), data, options);
    },
    existsSync(p) {
        try {
            return fs.existsSync(ensureSafePath(p));
        } catch {
            return false;
        }
    },
    unlinkSync(p) {
        return fs.unlinkSync(ensureSafePath(p));
    },
    mkdirSync(p, options) {
        return fs.mkdirSync(ensureSafePath(p), options);
    },
    readdirSync(p, options) {
        return fs.readdirSync(ensureSafePath(p), options);
    },
    statSync(p, options) {
        return fs.statSync(ensureSafePath(p), options);
    },
    tempDir: WORKER_TEMP_DIR
};

// ----------------------------------------------------------------------------
// 2. drpy DOM 选择器实现 (基于 cheerio 与 drpy 选择器语义)
// ----------------------------------------------------------------------------
function pdfa(html, selector) {
    if (!html || !selector) return [];
    try {
        const $ = typeof html === 'function' ? html : cheerio.load(String(html));
        const elements = $(selector);
        const result = [];
        elements.each((_, el) => {
            result.push($.html(el));
        });
        return result;
    } catch {
        return [];
    }
}

function pdfh(html, expr) {
    if (!html || !expr) return '';
    try {
        const $ = typeof html === 'function' ? html : cheerio.load(String(html));
        const parts = expr.split('&&');
        const selector = parts[0].trim();
        const attr = parts.length > 1 ? parts[1].trim() : null;
        const el = selector ? $(selector).first() : $.root();
        if (!el || el.length === 0) return '';
        if (attr) {
            if (attr === 'text') return el.text().trim();
            if (attr === 'html') return el.html() || '';
            return el.attr(attr) || '';
        }
        return el.text().trim();
    } catch {
        return '';
    }
}

function pdft(html, tag) {
    if (!html || !tag) return '';
    try {
        const $ = typeof html === 'function' ? html : cheerio.load(String(html));
        const el = $(tag).first();
        if (!el || el.length === 0) return '';
        return el.text().trim();
    } catch {
        return '';
    }
}

function pd(html, expr) {
    if (!html || !expr) return '';
    try {
        const $ = typeof html === 'function' ? html : cheerio.load(String(html));
        const parts = expr.split('&&');
        const selector = parts[0].trim();
        const attr = parts.length > 1 ? parts[1].trim() : 'href';
        const el = selector ? $(selector).first() : $.root();
        if (!el || el.length === 0) return '';
        return el.attr(attr) || '';
    } catch {
        return '';
    }
}

// ----------------------------------------------------------------------------
// 3. drpy 同步网络请求 (通过受控外部 sync_http 子进程，完全沙箱隔离)
// ----------------------------------------------------------------------------
function syncHttpRequest(url, options = {}) {
    const payload = JSON.stringify({ url, options });
    try {
        const stdout = execFileSync(process.execPath, [SYNC_HTTP_SCRIPT, payload], {
            encoding: options.buffer ? 'buffer' : 'utf-8',
            timeout: (options.timeout || 10) * 1000,
            maxBuffer: 50 * 1024 * 1024
        });
        return stdout;
    } catch (e) {
        process.stderr.write(`[syncHttpRequest error] ${e.message}\n`);
        return '';
    }
}

function drpyRequest(url, opts = {}) {
    return syncHttpRequest(url, opts);
}

function drpyPost(url, opts = {}) {
    const mergedOpts = Object.assign({}, opts, { method: 'POST' });
    return syncHttpRequest(url, mergedOpts);
}

// ----------------------------------------------------------------------------
// 4. 沙箱环境管理与 Rule 容器
// ----------------------------------------------------------------------------
class RuleWorker {
    constructor() {
        this.ruleObj = null;
        this.context = null;
        this.localStore = new Map();
        this.initContext();
    }

    initContext() {
        const local = {
            get: (key) => this.localStore.get(String(key)) || '',
            set: (key, val) => this.localStore.set(String(key), String(val)),
            remove: (key) => this.localStore.delete(String(key)),
            clear: () => this.localStore.clear(),
            getItem: (key) => this.localStore.get(String(key)) || '',
            setItem: (key, val) => this.localStore.set(String(key), String(val)),
            removeItem: (key) => this.localStore.delete(String(key))
        };

        const sandbox = {
            // drpy DOM 工具
            pdfa,
            pdfh,
            pdft,
            pd,
            // 基础工具库
            CryptoJS,
            dayjs,
            cheerio,
            // 存储
            local,
            // 网络
            request: drpyRequest,
            req: drpyRequest,
            post: drpyPost,
            fetch: globalThis.fetch,
            // 基础全局对象与函数
            console: {
                log: (...args) => process.stderr.write(`[Rule Log] ${args.join(' ')}\n`),
                error: (...args) => process.stderr.write(`[Rule Error] ${args.join(' ')}\n`),
                warn: (...args) => process.stderr.write(`[Rule Warn] ${args.join(' ')}\n`),
                info: (...args) => process.stderr.write(`[Rule Info] ${args.join(' ')}\n`)
            },
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            URL,
            URLSearchParams,
            Buffer,
            TextEncoder,
            TextDecoder,
            atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
            btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
            JSON,
            Math,
            Date,
            RegExp,
            Array,
            Object,
            String,
            Number,
            Boolean,
            Promise,
            Error,
            TypeError,
            RangeError,
            SyntaxError,
            parseInt,
            parseFloat,
            isNaN,
            isFinite,
            encodeURI,
            decodeURI,
            encodeURIComponent,
            decodeURIComponent,
            escape,
            unescape,
            // 安全受控文件系统
            fs: safeFs,
            // 容器导出对象
            exports: {},
            module: { exports: {} },
            __MODULE_EXPORTS__: {},
            // 严格禁止规则直接执行任意外部子进程
            child_process: undefined,
            process: {
                env: {},
                nextTick: process.nextTick,
                version: process.version,
                memoryUsage: () => process.memoryUsage()
            },
            require: (mod) => {
                if (mod === 'crypto-js') return CryptoJS;
                if (mod === 'dayjs') return dayjs;
                if (mod === 'cheerio') return cheerio;
                if (mod === 'fs') return safeFs;
                throw new Error(`[SecurityError] Module "${mod}" is not allowed in sandbox.`);
            }
        };

        sandbox.global = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.window = sandbox;

        this.context = vm.createContext(sandbox);
    }

    loadRule(ruleSource) {
        this.initContext();
        
        // 去除可能的 export { ... } ESM 语法，转换为内部挂载
        let transformed = ruleSource.replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
        transformed = transformed.replace(/^\s*export\s+default\s+/gm, 'var __default_export = ');
        
        const wrapper = `
        (function() {
            ${transformed}
            var targetRule = null;
            if (typeof rule !== 'undefined' && rule) {
                targetRule = rule;
            } else if (typeof __MODULE_EXPORTS__ !== 'undefined' && __MODULE_EXPORTS__.rule) {
                targetRule = __MODULE_EXPORTS__.rule;
            } else if (typeof exports !== 'undefined' && exports.rule) {
                targetRule = exports.rule;
            } else if (typeof module !== 'undefined' && module.exports && module.exports.rule) {
                targetRule = module.exports.rule;
            } else if (typeof __jsEvalReturn === 'function') {
                targetRule = __jsEvalReturn();
            } else if (typeof __jsEvalReturn !== 'undefined') {
                targetRule = __jsEvalReturn;
            } else if (typeof __default_export !== 'undefined') {
                targetRule = __default_export;
            }
            return targetRule;
        })()
        `;

        const script = new vm.Script(wrapper, { filename: 'drpy_rule.js' });
        this.ruleObj = script.runInContext(this.context, { timeout: 10000 });
        if (!this.ruleObj) {
            throw new Error('Failed to extract rule object from script.');
        }
        return true;
    }

    async callMethod(method, params = []) {
        if (!this.ruleObj) {
            throw new Error('No rule loaded.');
        }
        const fn = this.ruleObj[method];
        if (typeof fn !== 'function') {
            if (method === 'init') {
                if (typeof this.ruleObj.init === 'function') {
                    return await this.ruleObj.init.apply(this.ruleObj, params);
                }
                return null;
            }
            throw new Error(`Method "${method}" is not a function on rule.`);
        }
        
        const result = await fn.apply(this.ruleObj, params);
        if (result === undefined) return null;
        return result;
    }

    destroy() {
        this.ruleObj = null;
        this.context = null;
        this.localStore.clear();
        try {
            if (fs.existsSync(WORKER_TEMP_DIR)) {
                fs.rmSync(WORKER_TEMP_DIR, { recursive: true, force: true });
            }
        } catch {
            // ignore cleanup errors
        }
    }
}

// ----------------------------------------------------------------------------
// 5. JSON-RPC 2.0 stdio 调度
// ----------------------------------------------------------------------------
const worker = new RuleWorker();

function sendResponse(id, result, error = null) {
    const payload = {
        jsonrpc: '2.0',
        id: id ?? null
    };
    if (error) {
        payload.error = {
            code: error.code || -32603,
            message: error.message || String(error),
            data: error.data
        };
    } else {
        payload.result = result;
    }
    process.stdout.write(JSON.stringify(payload) + '\n');
}

async function handleRpcRequest(request) {
    const { id, method, params } = request;
    try {
        switch (method) {
            case 'loadRule': {
                const ruleSource = Array.isArray(params) ? params[0] : params.ruleSource;
                worker.loadRule(ruleSource);
                sendResponse(id, { success: true });
                break;
            }
            case 'init': {
                const extend = Array.isArray(params) ? params[0] : (params?.extend ?? '');
                const res = await worker.callMethod('init', [extend]);
                sendResponse(id, res);
                break;
            }
            case 'home': {
                const filter = Array.isArray(params) ? params[0] : (params?.filter ?? false);
                const res = await worker.callMethod('home', [filter]);
                sendResponse(id, res);
                break;
            }
            case 'homeVod':
            case 'homeVideo': {
                const res = await worker.callMethod('homeVod', []);
                sendResponse(id, res);
                break;
            }
            case 'category': {
                const args = Array.isArray(params) ? params : [params.tid, params.pg, params.filter, params.extend];
                const res = await worker.callMethod('category', args);
                sendResponse(id, res);
                break;
            }
            case 'detail': {
                const args = Array.isArray(params) ? params : [params.id];
                const res = await worker.callMethod('detail', args);
                sendResponse(id, res);
                break;
            }
            case 'search': {
                const args = Array.isArray(params) ? params : [params.wd || params.key, params.quick, params.pg];
                const res = await worker.callMethod('search', args);
                sendResponse(id, res);
                break;
            }
            case 'play': {
                const args = Array.isArray(params) ? params : [params.flag, params.id, params.flags || params.vipFlags];
                const res = await worker.callMethod('play', args);
                sendResponse(id, res);
                break;
            }
            case 'proxy':
            case 'localProxy': {
                const args = Array.isArray(params) ? params : [params.param];
                const res = await worker.callMethod('proxy', args);
                sendResponse(id, res);
                break;
            }
            case 'call': {
                const methodName = Array.isArray(params) ? params[0] : params.method;
                const methodArgs = Array.isArray(params) ? params.slice(1) : (params.args || []);
                const res = await worker.callMethod(methodName, methodArgs);
                sendResponse(id, res);
                break;
            }
            case 'getMemoryUsage': {
                sendResponse(id, process.memoryUsage());
                break;
            }
            case 'ping': {
                sendResponse(id, 'pong');
                break;
            }
            case 'destroy': {
                worker.destroy();
                sendResponse(id, { destroyed: true });
                process.exit(0);
                break;
            }
            default:
                sendResponse(id, null, { code: -32601, message: `Method "${method}" not found.` });
        }
    } catch (err) {
        sendResponse(id, null, {
            code: -32000,
            message: err.message || String(err),
            data: err.stack
        });
    }
}

// 监听 stdin 逐行 JSON-RPC 消息
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
        const json = JSON.parse(trimmed);
        handleRpcRequest(json);
    } catch (err) {
        sendResponse(null, null, { code: -32700, message: `Parse error: ${err.message}` });
    }
});

process.on('SIGTERM', () => {
    worker.destroy();
    process.exit(0);
});

process.on('SIGINT', () => {
    worker.destroy();
    process.exit(0);
});
