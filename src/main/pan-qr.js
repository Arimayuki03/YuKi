/**
 * pan-qr.js — 夸克网盘扫码登录（主进程实现）
 *
 * 为什么放主进程：扫码登录的 token 由 uop.quark.cn 签发，服务端会对
 * 「获取来源」做风控。Python requests/curl_cffi 的 TLS 指纹与真实浏览器
 * 不同，拿到的 token 在手机 App 确认时会被拒绝（提示「登录请求过期」）。
 * 这里用 Electron 主进程的 net.request（Chromium 网络栈，TLS/HTTP2 指纹
 * 与真实 Chrome 一致）+ 手动维护的 cookie 集合完整走一遍官方流程：
 *
 *   1. GET  pan.quark.cn/                                    → 预热，种 ctoken
 *   2. GET  uop.quark.cn/cas/ajax/getTokenForQrcodeLogin
 *          ?client_id=532&v=1.2&request_id=<uuid>            → data.members.token
 *   3. 轮询 GET uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken
 *          ?client_id=532&v=1.2&request_id=<uuid>&token=
 *      → status==2000000 时 data.members.service_ticket（未扫码 50004001）
 *   4. GET  pan.quark.cn/account/info?st=<ST>                → 响应 Set-Cookie 完成登录
 *   5. 汇总各响应 Set-Cookie 中的 quark 域 Cookie 返回
 *
 * 关键：
 *   - client_id / v / request_id 必须与网页版一致（request_id 用同一个
 *     UUID 贯穿整个会话），否则服务端不认 token，App 确认时报「登录请求过期」。
 *   - Electron net.request 不会自动把 Set-Cookie 存入 session（实测
 *     cookies.get 为空），必须手动解析响应头 Set-Cookie 并在后续请求
 *     手动携带，否则兑换后收集不到 __puus/__pus。
 */
const { net } = require('electron');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const QR_BASE = 'https://su.quark.cn/4_eMHBJ';
const UC_BIZ_STR = 'S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0';

// 会话级 cookie 集合：name -> { value, domain }（手动维护，net.request 不自动存）
let sessionCookies = {};
// 会话级 request_id：与网页版一致，同一个 UUID 贯穿 token 获取与轮询
let sessionRequestId = '';

function _requestId() {
    if (!sessionRequestId) sessionRequestId = crypto.randomUUID();
    return sessionRequestId;
}

function _apiParams(extra = {}) {
    return new URLSearchParams({
        client_id: '532',
        v: '1.2',
        request_id: _requestId(),
        ...extra,
    });
}

/** 解析 Set-Cookie 响应头（字符串或数组），更新会话 cookie 集合 */
function _absorbSetCookies(setCookieHeader) {
    if (!setCookieHeader) return;
    const list = Array.isArray(setCookieHeader) ? setCookieHeader : [String(setCookieHeader)];
    for (const raw of list) {
        const first = String(raw).split(';')[0] || '';
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (!name) continue;
        const dom = (String(raw).match(/domain=([^;]+)/i) || [])[1] || '';
        sessionCookies[name] = { value, domain: dom.trim().toLowerCase() };
    }
}

/** 组装当前会话的 Cookie 头（仅 quark/uc 域 + 无域名的） */
function _cookieHeader() {
    const parts = [];
    for (const [name, c] of Object.entries(sessionCookies)) {
        const dom = c.domain || '';
        if (dom && !dom.includes('quark.cn') && !dom.includes('uc.cn')) continue;
        parts.push(`${name}=${c.value}`);
    }
    return parts.join('; ');
}

/** net.request GET 并返回 { status, headers, text }（自动带会话 Cookie 并吸收 Set-Cookie） */
function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        let req;
        try {
            req = net.request({ url });
        } catch (e) {
            reject(e);
            return;
        }
        req.setHeader('User-Agent', UA);
        req.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
        req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
        const ck = _cookieHeader();
        if (ck) req.setHeader('Cookie', ck);
        for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
        req.on('response', (res) => {
            let body = '';
            res.on('data', (c) => { body += c.toString('utf8'); });
            res.on('end', () => {
                const hs = {};
                try { for (const k of Object.keys(res.headers)) hs[k.toLowerCase()] = res.headers[k]; } catch (e) { /* ignore */ }
                _absorbSetCookies(hs['set-cookie']);
                resolve({ status: res.statusCode, headers: hs, text: body });
            });
            res.on('error', (e) => reject(e));
        });
        req.on('error', (e) => reject(e));
        req.end();
    });
}

/** 构造二维码内容 URL（与网页版 Hk() 输出一致：全参数 URL 编码） */
function scanPage(token) {
    const qs = new URLSearchParams({
        token, client_id: '532', ssb: 'weblogin',
        uc_param_str: '', uc_biz_str: UC_BIZ_STR,
    });
    return `${QR_BASE}?${qs.toString()}`;
}

/** 预热：访问 pan.quark.cn 种 ctoken */
async function warmup() {
    try {
        await httpGet('https://pan.quark.cn/');
    } catch (e) {
        console.warn('[pan-qr] warmup failed:', e.message);
    }
}

/** 获取二维码：返回 { token, qr_text } */
async function qrCreate() {
    sessionRequestId = crypto.randomUUID(); // 每次重新扫码换新会话
    sessionCookies = {};                     // 清空旧会话 cookie
    await warmup();
    const url = 'https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?' + _apiParams().toString();
    const r = await httpGet(url, {
        Referer: 'https://pan.quark.cn/',
        Origin: 'https://pan.quark.cn',
        Accept: 'application/json, text/plain, */*',
        'x-requested-with': 'XMLHttpRequest',
    });
    let d;
    try { d = JSON.parse(r.text); } catch (e) { throw new Error('获取二维码失败：非 JSON 响应'); }
    const token = ((d.data || {}).members || {}).token || '';
    if (!token) throw new Error('获取二维码失败：' + String(d.message || r.text).slice(0, 120));
    return { token, qr_text: scanPage(token) };
}

/**
 * 轮询扫码状态；确认后自动兑换并收集 Cookie。
 * 返回 { status: 'waiting'|'ok'|'expired'|'error', message, cookies?, warnings? }
 */
async function qrPoll(token) {
    const url = 'https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?' +
        _apiParams({ token }).toString();
    const r = await httpGet(url, {
        Referer: 'https://pan.quark.cn/',
        Origin: 'https://pan.quark.cn',
        Accept: 'application/json, text/plain, */*',
        'x-requested-with': 'XMLHttpRequest',
    });
    let d;
    try { d = JSON.parse(r.text); } catch (e) { return { status: 'error', message: '轮询响应异常' }; }
    const status = d.status;
    if (status === 2000000) {
        const st = ((d.data || {}).members || {}).service_ticket || '';
        if (!st) return { status: 'error', message: '登录成功但未取得票据' };
        return exchangeAndCollect(st);
    }
    if (status === 50004001) return { status: 'waiting', message: '等待扫码…' };
    if (status === 50004002 || status === 50001000 || status === 50001001) {
        return { status: 'expired', message: '二维码已过期，请重新获取' };
    }
    return { status: 'waiting', message: '等待扫码…' };
}

/** 生成浏览器 uuid() 风格的随机标识（b-user-id / __sdid，与网页版 JS 同格式） */
function genBrowserUuid() {
    const t = () => (65536 * (1 + Math.random()) | 0).toString(16).substring(1);
    return t() + t() + '-' + t() + '-' + t() + '-' + t() + '-' + t() + t() + t();
}

/** 用 ST 兑换登录态并收集 Cookie */
async function exchangeAndCollect(st) {
    let r;
    try {
        // 网页版登录后按序请求的接口：account/info 兑换 ST → drive-pc member/config 下发 __puus
        const apiHeaders = {
            Referer: 'https://pan.quark.cn/',
            Accept: 'application/json, text/plain, */*',
            'x-requested-with': 'XMLHttpRequest',
        };
        r = await httpGet('https://pan.quark.cn/account/info?st=' + encodeURIComponent(st), apiHeaders);
        await httpGet('https://drive-pc.quark.cn/1/clouddrive/member?fetch_subscribe=true&_ch=home', apiHeaders);
        await httpGet('https://drive-pc.quark.cn/1/clouddrive/config', apiHeaders);
        await httpGet('https://pan.quark.cn/account/info', apiHeaders);
    } catch (e) {
        return { status: 'error', message: '兑换登录态失败：' + String(e.message || e).slice(0, 80) };
    }
    // 补齐浏览器 JS 自动生成的设备标识（CDN 校验需要，网页版由前端脚本生成）
    if (!sessionCookies['b-user-id']) {
        sessionCookies['b-user-id'] = { value: genBrowserUuid(), domain: '' };
    }
    if (!sessionCookies['__sdid']) {
        sessionCookies['__sdid'] = { value: genBrowserUuid(), domain: '' };
    }
    console.log('[pan-qr] account/info status=' + r.status + ' set-cookie=' +
        JSON.stringify(r.headers['set-cookie'] || []));
    // 收集 quark/uc 域 Cookie（含 ctoken/__puus/__pus/b-user-id 等）
    const parts = [];
    for (const [name, c] of Object.entries(sessionCookies)) {
        const dom = c.domain || '';
        if (dom && !dom.includes('quark.cn') && !dom.includes('uc.cn')) continue;
        parts.push(`${name}=${c.value}`);
    }
    console.log('[pan-qr] collected cookie names: ' + parts.map((p) => p.split('=')[0]).join(', '));
    if (!parts.length) {
        console.log('[pan-qr] sessionCookies:', JSON.stringify(Object.keys(sessionCookies)));
        return { status: 'error', message: '登录后未取得 Cookie，请重试' };
    }
    return {
        status: 'ok',
        message: `登录成功，Cookie 已自动保存（${parts.length} 个字段）`,
        cookies: parts.join('; '),
    };
}

/** 登录完成后清理会话 */
async function cleanup() {
    sessionRequestId = '';
    sessionCookies = {};
}

module.exports = { qrCreate, qrPoll, cleanup };
