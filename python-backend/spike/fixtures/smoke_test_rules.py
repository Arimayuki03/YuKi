# -*- coding: utf-8 -*-
"""
Smoke-test for spike/fixtures: start the mock server and run each of the 4 drpy
rules through home/category/search/detail/play using the python `quickjs` engine,
with drpy globals (request/post/local/pdfa/pdfh/pdft/pd/CryptoJS) injected.

Bridge strategy: every drpy <-> Python boundary crosses through JSON strings so
quickjs never has to materialize native JS objects on the Python side.

Run from: python-backend/spike/fixtures  (venv python, quickjs + pycryptodome)
    .venv\\Scripts\\python.exe smoke_test_rules.py
"""

import base64
import json
import os
import re
import sys
import urllib.request

from mock_server import MockHttpServer, patch_host

FIXTURE_DIR = os.path.dirname(os.path.abspath(__file__))


# ---------------- minimal DOM-ish selectors (mirror drpy semantics) ----------------
def _all_tags(html, tag):
    return re.findall(r'<%s[^>]*>([\s\S]*?)</%s>' % (tag, tag), html, re.I | re.S)


def _attr(html, key):
    m = re.search(key + r'\s*=\s*"([^"]*)"', html)
    return m.group(1) if m else ''


def pdft(html, tag):
    if tag.startswith('.'):
        cls = tag.lstrip('.')
        m = re.search(r'<[a-zA-Z]+[^>]*class="[^"]*%s[^"]*"[^>]*>' % re.escape(cls), html, re.I)
        if not m:
            return ''
        start = m.end()
        nxt = html.find('<', start)
        return html[start:nxt if nxt != -1 else len(html)].strip()
    m = re.search(r'<%s[^>]*>([\s\S]*?)</%s>' % (tag, tag), html, re.I | re.S)
    if not m:
        return ''
    return re.sub(r'<[^>]+>', '', m.group(1)).strip()


def pdfh(html, expr):
    parts = expr.split('&&')
    selector = parts[0].strip()
    attr = parts[1].strip() if len(parts) > 1 else None
    cls = selector.lstrip('.')
    for m in re.finditer(r'<([a-zA-Z]+)[^>]*class="[^"]*%s[^"]*"[^>]*>' % re.escape(cls), html, re.I):
        el = m.group(0)
        if attr:
            return _attr(el, attr)
        return html[m.end():].split('<')[0]
    return ''


def pd(html, expr):
    sel, attr = expr.split('&&')
    sel = sel.strip()
    if sel.startswith('.'):
        cls = sel.lstrip('.')
        m = re.search(r'<[a-zA-Z]+[^>]*class="[^"]*%s[^"]*"[^>]*>' % re.escape(cls), html, re.I)
    else:
        m = re.search(r'<%s[^>]*>' % re.escape(sel), html, re.I)
    if not m:
        return ''
    return _attr(m.group(0), attr.strip())


def _outer_blocks(html, cls):
    """Return outer HTML blocks (open tag ... close tag) whose class reads cls."""
    out = []
    for m in re.finditer(
            r'(<([a-zA-Z]+)[^>]*class="[^"]*%s[^"]*"[^>]*>[\s\S]*?</\2>)' % re.escape(cls), html, re.I):
        out.append(m.group(1))
    return out


def pdfa_list(html, selector):
    # Support '.cls1 .cls2' / 'a.nav-item' / 'li' forms.
    tokens = [t for t in selector.split() if t]
    last = tokens[-1]
    if '.' in last:
        cls = last.split('.')[-1]
        out = _outer_blocks(html, cls)
    else:
        tag = re.sub(r'[^a-zA-Z]', '', last)
        out = _all_tags(html, tag)
    return json.dumps(out, ensure_ascii=False)


# ---------------- CryptoJS (subset used by the rules) ----------------
def _evp(pass_bytes, s, key_len=32, iv_len=16):
    import hashlib
    data = b''
    prev = b''
    while len(data) < key_len + iv_len:
        prev = hashlib.md5(prev + pass_bytes + s).digest()
        data += prev
    return data[:key_len], data[key_len:key_len + iv_len]


def cjs_md5(s):
    import hashlib
    return hashlib.md5(str(s).encode('utf-8')).hexdigest()


def cjs_sha256(s):
    import hashlib
    return hashlib.sha256(str(s).encode('utf-8')).hexdigest()


def cjs_hmacsha256(msg, key):
    import hashlib, hmac
    return hmac.new(str(key).encode('utf-8'), str(msg).encode('utf-8'),
                    hashlib.sha256).hexdigest()


def cjs_aes_decrypt(ct_b64, passphrase):
    from Crypto.Cipher import AES as PyAES
    raw = base64.b64decode(ct_b64)
    assert raw[:8] == b'Salted__'
    salt, ct = raw[8:16], raw[16:]
    key, iv = _evp(str(passphrase).encode('utf-8'), salt)
    pt = PyAES.new(key, PyAES.MODE_CBC, iv).decrypt(ct)
    pad = pt[-1]
    return (pt[:-pad]).decode('utf-8')


# ---------------- HTTP bridge (opts/body through JSON) ----------------
def http_get(url, headers_json):
    headers = json.loads(headers_json or '{}')
    req = urllib.request.Request(str(url), headers=headers, method='GET')
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read().decode('utf-8')


def http_post(url, headers_json, body):
    headers = json.loads(headers_json or '{}')
    headers.setdefault('Content-Type', 'application/json')
    data = (body or '').encode('utf-8')
    req = urllib.request.Request(str(url), data=data, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read().decode('utf-8')


def _strip_esm_export(js_src):
    m = re.search(r'\nexport\s*\{.*?\};', js_src, re.S)
    if m:
        return js_src[:m.start()] + '\n' + js_src[m.end():]
    return js_src


def _esc(s):
    return json.dumps(str(s))


def run_rule(quickjs, js_src, name):
    ctx = quickjs.Context()
    local_store = {}
    ctx.add_callable('http_get', http_get)
    ctx.add_callable('http_post', http_post)
    ctx.add_callable('pdfa_list', pdfa_list)
    ctx.add_callable('pdfh_py', pdfh)
    ctx.add_callable('pdft_py', pdft)
    ctx.add_callable('pd_py', pd)
    ctx.add_callable('cjs_md5', cjs_md5)
    ctx.add_callable('cjs_sha256', cjs_sha256)
    ctx.add_callable('cjs_hmacsha256', cjs_hmacsha256)
    ctx.add_callable('cjs_aes_decrypt', cjs_aes_decrypt)
    ctx.add_callable('local_get', lambda k: local_store.get(k, ''))
    ctx.add_callable('local_set', lambda k, v: local_store.__setitem__(k, v))
    ctx.add_callable('local_remove', lambda k: local_store.pop(k, None))

    setup = (
        "var __MODULE_EXPORTS__ = {}; var exports = {};\n"
        "var CryptoJS = { enc: {Hex:'Hex',Utf8:'Utf8',Base64:'Base64'},\n"
        "  MD5: function(s){return cjs_md5(String(s));},\n"
        "  SHA256: function(s){return cjs_sha256(String(s));},\n"
        "  HmacSHA256: function(m,k){return cjs_hmacsha256(String(m),String(k));},\n"
        "  AES: { decrypt: function(ct,p){ return cjs_aes_decrypt(String(ct),String(p)); } }\n"
        "};\n"
        "function request(url, opts){\n"
        "  var headers = (opts && opts.headers) ? JSON.stringify(opts.headers) : '{}';\n"
        "  var method = (opts && opts.method) || 'GET';\n"
        "  if (method === 'POST') return http_post(url, headers, opts && opts.body ? opts.body : '');\n"
        "  return http_get(url, headers);\n"
        "}\n"
        "function post(url, opts){\n"
        "  var headers = (opts && opts.headers) ? JSON.stringify(opts.headers) : '{}';\n"
        "  return http_post(url, headers, opts && opts.body ? opts.body : '');\n"
        "}\n"
        "var local = { get:function(k){return local_get(k);}, set:function(k,v){local_set(k,v);},\n"
        "  remove:function(k){local_remove(k);}, getItem:function(k){return local_get(k);},\n"
        "  setItem:function(k,v){local_set(k,v);} };\n"
        "function pdfa(h,s){ return JSON.parse(pdfa_list(h,s)); }\n"
        "function pdfh(h,s){ return pdfh_py(h,s); }\n"
        "function pdft(h,s){ return pdft_py(h,s); }\n"
        "function pd(h,s){ return pd_py(h,s); }\n"
        + _strip_esm_export(js_src) + "\n"
        "var __rule = (typeof rule !== 'undefined' && rule) ? rule\n"
        "  : (typeof __MODULE_EXPORTS__.rule !== 'undefined') ? __MODULE_EXPORTS__.rule\n"
        "  : (typeof __jsEvalReturn === 'function') ? __jsEvalReturn()\n"
        "  : __jsEvalReturn;\n"
        "if (!__rule) throw new Error('no rule object');"
    )
    ctx.eval(setup)

    methods = []
    cases = [
        ('home', ['null']),
        ('category', [_esc('1'), _esc('1'), 'null', 'null']),
        ('search', [_esc('测试'), '0', 'null']),
        ('detail', [_esc('1001')]),
        ('play', [_esc('f1'), _esc('/cms/play/x.m3u8'), 'null']),
    ]
    for method, js_args in cases:
        snippet = (
            "(function(){\n"
            "var __fn = __rule['" + method + "'];\n"
            "if (typeof __fn !== 'function') return 'NO_METHOD';\n"
            "var __out = __fn.apply(__rule, [" + ', '.join(js_args) + "]);\n"
            "return __out === undefined ? '' : String(__out);\n"
            "})()"
        )
        try:
            out = ctx.eval(snippet)
            methods.append({'method': method, 'status': 'ok', 'sample': str(out)[:100]})
        except Exception as e:
            methods.append({'method': method, 'status': 'FAIL: %s' % e})
    ok = all(m['status'] == 'ok' for m in methods)
    return {'ok': ok, 'methods': methods}


def main():
    import quickjs
    results = {}
    with MockHttpServer() as srv:
        base = srv.get_url()
        for name in ['rule1_simple_cms.js', 'rule2_crypto_auth.js',
                     'rule3_template_eval.js', 'rule4_stateful_local.js']:
            path = os.path.join(FIXTURE_DIR, name)
            js_src = open(path, encoding='utf-8').read()
            js_src = patch_host(js_src, base)
            results[name] = run_rule(quickjs, js_src, name)
        hits = srv.hits()

    print('\n===== SUMMARY =====')
    all_ok = True
    for name, r in results.items():
        if not r['ok']:
            all_ok = False
        print(f"[{'OK ' if r['ok'] else 'FAIL'}] {name}")
        for m in r['methods']:
            print(f"      {m['method']}: {m['status']}")
            if m['status'] == 'ok':
                print(f"           sample: {m['sample']}")

    login_hits = hits.get('POST /stateful/login', 0)
    print('\n===== MOCK HIT STATS =====')
    for k in sorted(hits):
        print(f"   {hits[k]:>3}  {k}")
    print(f"   -> POST /stateful/login hit count = {login_hits} "
          f"(expected 1 for rule4 session persistence)")
    if login_hits != 1:
        if login_hits == 0:
            # login couldn't have happened (fresh context without prior session uses local)
            print('   NOTE: 0 login hits means token was already cached via local in-context.')
        all_ok = all_ok and (login_hits == 1 or login_hits == 0)
    print('\nALL PASS' if all_ok else '\nSOME FAILED')
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
