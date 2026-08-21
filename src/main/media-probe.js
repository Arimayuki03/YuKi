'use strict';

/** Lightweight, bounded validation before a network URL reaches mpv. */

const MEDIA_TYPES = /^(video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|mp4|ogg))/i;
const HLS_TYPES = /(?:mpegurl|m3u8)/i;
const HTML_TYPES = /(?:text\/html|application\/xhtml\+xml)/i;
const JSON_TYPES = /(?:application|text)\/(?:[^;]+\+)?json/i;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const EXPIRE_KEYS = new Set(['expires', 'expire', 'expire_at', 'expires_at', 'deadline',
    'x-expires', 'x-oss-expires']);

function mergeHeaders(...sources) {
    const out = {};
    const keys = new Map();
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        for (const [rawKey, rawValue] of Object.entries(source)) {
            if (rawValue === null || rawValue === undefined || rawValue === '') continue;
            const key = String(rawKey).trim();
            if (!key) continue;
            const lower = key.toLowerCase();
            const old = keys.get(lower);
            if (old) delete out[old];
            keys.set(lower, key);
            out[key] = String(rawValue);
        }
    }
    return out;
}

function headerValue(headers, name) {
    if (!headers) return '';
    const wanted = String(name).toLowerCase();
    if (typeof headers.get === 'function') return headers.get(name) || '';
    const key = Object.keys(headers).find((item) => item.toLowerCase() === wanted);
    return key ? String(headers[key] || '') : '';
}

function responseCookies(headers) {
    if (!headers) return [];
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
    const value = headerValue(headers, 'set-cookie');
    return value ? [value] : [];
}

function mergeCookieHeader(headers, setCookies) {
    const existing = headerValue(headers, 'cookie');
    const values = new Map();
    for (const pair of String(existing || '').split(';')) {
        const index = pair.indexOf('=');
        if (index > 0) values.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    for (const raw of setCookies || []) {
        const pair = String(raw || '').split(';', 1)[0];
        const index = pair.indexOf('=');
        if (index > 0) values.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    if (!values.size) return mergeHeaders(headers);
    return mergeHeaders(headers, { Cookie: [...values].map(([k, v]) => `${k}=${v}`).join('; ') });
}

function playbackHeaders(probeHeaders, originalHeaders) {
    const out = mergeHeaders(probeHeaders);
    for (const key of Object.keys(out)) {
        if (key.toLowerCase() === 'range') delete out[key];
        if (key.toLowerCase() === 'accept' && !headerValue(originalHeaders, 'accept')) delete out[key];
    }
    const originalAccept = headerValue(originalHeaders, 'accept');
    return originalAccept ? mergeHeaders(out, { Accept: originalAccept }) : out;
}

function expiredSignedUrl(rawUrl, nowMs = Date.now()) {
    try {
        const url = new URL(String(rawUrl || ''));
        for (const [key, raw] of url.searchParams) {
            if (!EXPIRE_KEYS.has(key.toLowerCase())) continue;
            let value = Number(raw);
            if (!Number.isFinite(value) || value <= 0) continue;
            if (value > 10_000_000_000) value /= 1000;
            // Small values are relative TTLs (for example X-Amz-Expires), not
            // absolute dates and cannot be judged without a signing date.
            if (value > 100_000_000 && value <= nowMs / 1000 + 5) return true;
        }
    } catch (e) { /* invalid URLs are handled by the caller */ }
    return false;
}

// 本机 go-proxy 取流地址（网盘 do=pan、?url= 直链转发）不做媒体探测。
// go-proxy 按 query 分发、不看路径，所以只认 loopback + do/url 参数。
// 探测这条链路只会误杀：
//  - do=pan 的 HEAD 会让后端完整跑一遍夸克解析（token → detail → v2/play，
//    必要时 sharepage/save 转存并轮询任务，实测 5-20s），8s 预算必然超时 →
//    media-probe-probe-timeout，mpv 根本起不来；
//  - 即便赶上，Range: bytes=0-1 只回 2 字节，容器魔数判不出来，而夸克 CDN
//    的 application/octet-stream 也过不了 MEDIA_TYPES → not-media；
//  - HEAD + ranged GET 还会让签名解析跑两遍（多一次转存/取签名）。
// 这条链路的上游状态校验与签名过期刷新已由 go_proxy._stream_forward 承担，
// 上游非 2xx 会原样回给 mpv，探测提供不了额外保护。
function isLocalProxyStreamUrl(rawUrl) {
    try {
        const url = new URL(String(rawUrl || ''));
        if (!/^https?:$/i.test(url.protocol)) return false;
        if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) return false;
        return url.searchParams.get('do') === 'pan' || !!url.searchParams.get('url');
    } catch (e) { return false; }
}

function looksLikeHtmlOrLogin(bytes) {
    const text = Buffer.from(bytes || []).toString('utf8').replace(/^\uFEFF/, '').trimStart().slice(0, 4096);
    if (!text) return '';
    if (/^(?:<!doctype\s+html|<html|<head|<body|<form)\b/i.test(text)) {
        return /(?:login|sign[ -]?in|登录|验证码|password)/i.test(text) ? 'login-page' : 'html-response';
    }
    if (/^[{[]/.test(text) && /(?:error|message|code|login|unauthorized|forbidden)/i.test(text)) {
        return 'json-error';
    }
    return '';
}

function isHls(bytes) {
    const text = Buffer.from(bytes || []).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    return text.startsWith('#EXTM3U') || text === '#E'; // exact bytes=0-1 response
}

function hasMediaMagic(bytes) {
    const b = Buffer.from(bytes || []);
    if (!b.length) return false;
    if (b[0] === 0x47) return true; // MPEG-TS
    if (b.length >= 4 && b.subarray(0, 4).toString('ascii') === 'FLV\x01') return true;
    if (b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return true;
    if (b.length >= 8 && b.subarray(4, 8).toString('ascii') === 'ftyp') return true;
    if (b.length >= 4 && ['OggS', 'RIFF'].includes(b.subarray(0, 4).toString('ascii'))) return true;
    if (b.length >= 3 && b.subarray(0, 3).toString('ascii') === 'ID3') return true;
    return b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
}

async function readPrefix(response, limit = 4096) {
    if (!response.body || typeof response.body.getReader !== 'function') {
        const data = Buffer.from(await response.arrayBuffer());
        return data.subarray(0, limit);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (size < limit) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value || []);
            chunks.push(chunk.subarray(0, Math.max(0, limit - size)));
            size += chunk.length;
            if (size >= limit) break;
        }
    } finally {
        try { await reader.cancel(); } catch (e) { /* already closed */ }
    }
    return Buffer.concat(chunks).subarray(0, limit);
}

async function requestFollowing(url, method, headers, signal, fetchImpl, maxRedirects = 5) {
    let current = String(url);
    let requestHeaders = mergeHeaders(headers);
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
        const response = await fetchImpl(current, {
            method, headers: requestHeaders, redirect: 'manual', signal,
        });
        requestHeaders = mergeCookieHeader(requestHeaders, responseCookies(response.headers));
        if (!REDIRECTS.has(response.status)) {
            return { response, url: response.url || current, headers: requestHeaders, redirects };
        }
        const location = headerValue(response.headers, 'location');
        if (!location || redirects === maxRedirects) {
            return { response, url: current, headers: requestHeaders, redirects };
        }
        try { if (response.body) await response.body.cancel(); } catch (e) { /* ignore */ }
        current = new URL(location, current).toString();
    }
    throw new Error('redirect loop');
}

async function probeMedia(rawUrl, options = {}) {
    const url = String(rawUrl || '').trim();
    const trace = { url, finalUrl: url, headers: mergeHeaders(options.headers) };
    if (!/^https?:\/\//i.test(url)) return { ok: true, skipped: true, reason: 'non-http', ...trace };
    if (options.skipProbe) return { ok: true, skipped: true, reason: 'skip-probe', ...trace };
    if (isLocalProxyStreamUrl(url)) return { ok: true, skipped: true, reason: 'local-proxy', ...trace };
    if (expiredSignedUrl(url, options.nowMs)) return { ok: false, reason: 'expired-url', ...trace };

    const fetchImpl = options.fetch || globalThis.fetch;
    if (typeof fetchImpl !== 'function') return { ok: false, reason: 'probe-unavailable', ...trace };
    const controller = new AbortController();
    const timeoutMs = Math.max(100, Number(options.timeoutMs) || 8000);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const external = options.signal;
    const onAbort = () => controller.abort();
    if (external) {
        if (external.aborted) controller.abort();
        else external.addEventListener('abort', onAbort, { once: true });
    }

    try {
        let activeHeaders = trace.headers;
        const head = await requestFollowing(url, 'HEAD', activeHeaders, controller.signal, fetchImpl);
        activeHeaders = head.headers;
        const headType = headerValue(head.response.headers, 'content-type');
        const disposition = headerValue(head.response.headers, 'content-disposition');
        if (head.response.status === 401 || head.response.status === 403) {
            return { ok: false, reason: `http-${head.response.status}`, status: head.response.status,
                ...trace, finalUrl: head.url, headers: activeHeaders };
        }
        if (head.response.ok && (MEDIA_TYPES.test(headType)
                || /filename=.*\.(?:m3u8|mp4|mkv|webm|ts|flv)/i.test(disposition))) {
            return { ok: true, via: 'head', status: head.response.status, contentType: headType,
                ...trace, finalUrl: head.url, headers: activeHeaders };
        }
        if (head.response.ok && (HTML_TYPES.test(headType) || JSON_TYPES.test(headType))) {
            return { ok: false, reason: HTML_TYPES.test(headType) ? 'html-response' : 'json-error',
                status: head.response.status, contentType: headType,
                ...trace, finalUrl: head.url, headers: activeHeaders };
        }

        const rangeHeaders = mergeHeaders(activeHeaders, { Range: 'bytes=0-1', Accept: '*/*' });
        const ranged = await requestFollowing(head.url, 'GET', rangeHeaders, controller.signal, fetchImpl);
        const status = ranged.response.status;
        const contentType = headerValue(ranged.response.headers, 'content-type');
        if (status === 401 || status === 403) {
            return { ok: false, reason: `http-${status}`, status, contentType,
                ...trace, finalUrl: ranged.url, headers: playbackHeaders(ranged.headers, activeHeaders) };
        }
        if (status !== 200 && status !== 206) {
            return { ok: false, reason: `http-${status}`, status, contentType,
                ...trace, finalUrl: ranged.url, headers: playbackHeaders(ranged.headers, activeHeaders) };
        }
        const bytes = await readPrefix(ranged.response);
        const fake = looksLikeHtmlOrLogin(bytes);
        if (HTML_TYPES.test(contentType) || JSON_TYPES.test(contentType) || fake) {
            return { ok: false, reason: fake || (HTML_TYPES.test(contentType) ? 'html-response' : 'json-error'),
                status, contentType, ...trace, finalUrl: ranged.url, headers: playbackHeaders(ranged.headers, activeHeaders) };
        }
        if (MEDIA_TYPES.test(contentType) || HLS_TYPES.test(contentType) || isHls(bytes) || hasMediaMagic(bytes)) {
            return { ok: true, via: 'range', status, contentType,
                ...trace, finalUrl: ranged.url, headers: playbackHeaders(ranged.headers, activeHeaders) };
        }
        return { ok: false, reason: 'not-media', status, contentType,
            ...trace, finalUrl: ranged.url, headers: playbackHeaders(ranged.headers, activeHeaders) };
    } catch (error) {
        if (controller.signal.aborted) {
            return { ok: false, reason: timedOut ? 'probe-timeout' : 'probe-cancelled', ...trace };
        }
        return { ok: false, reason: 'probe-network-error', error: String(error && error.message || error), ...trace };
    } finally {
        clearTimeout(timer);
        if (external) external.removeEventListener('abort', onAbort);
    }
}

module.exports = { probeMedia, mergeHeaders, expiredSignedUrl, looksLikeHtmlOrLogin,
    hasMediaMagic, isLocalProxyStreamUrl };
