'use strict';
/* 诊断：模拟 _probeClasses 对真实 量子资源 源探测所有分类（空/错误/耗时） */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function postJson(url, form) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const body = new URLSearchParams(form).toString();
        const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, (r) => {
            let b = ''; r.on('data', (c) => b += c); r.on('end', () => resolve({ status: r.statusCode, text: b }));
        });
        req.on('error', reject); req.setTimeout(40000, () => req.destroy(new Error('timeout')));
        req.end(body);
    });
}

(async () => {
    const py = path.join(ROOT, 'python-backend', '.venv', 'Scripts', 'python.exe');
    const child = spawn(py, [path.join(ROOT, 'python-backend', 'server.py')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    let ready = null;
    for (let i = 0; i < 60; i++) {
        const m = log.match(/VPC_BACKEND_READY port=(\d+) token=(\S+)/);
        if (m) { ready = { port: m[1], token: m[2] }; break; }
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) { console.error('backend not ready\n' + log.slice(-2000)); child.kill(); process.exit(1); }
    const base = `http://127.0.0.1:${ready.port}`;
    const url = (p) => `${base}${p}?token=${ready.token}`;
    console.log('backend ready', ready.port);

    // 加载真实配置
    const CONFIG = 'https://cdn.jsdelivr.net/gh/yangxiaoge/tvbox_cust@master/tvbox/%E5%A4%9A%E4%BB%93adult.json';
    console.log('loadConfig...');
    let r = await postJson(url('/action'), { do: 'loadConfig', url: CONFIG });
    console.log('loadConfig resp:', r.status, r.text.slice(0, 120));
    for (let i = 0; i < 240; i++) {
        const t = await postJson(url('/action'), { do: 'configTask' });
        const st = JSON.parse(t.text);
        if (st.status === 'done' || st.status === 'error') { console.log('config task:', st.status, (st.summary && ('sites=' + st.summary.sites)) || st.msg); break; }
        await new Promise((r2) => setTimeout(r2, 1000));
    }

    // homeContent 量子资源
    const site = '量子资源';
    const home = JSON.parse((await postJson(url('/action'), { do: 'homeContent', site, filter: 'false' })).text);
    const classes = (home.class || []);
    console.log('classes total:', classes.length);
    console.log('all class names:', classes.map((c) => `${c.type_id}:${c.type_name}`).join(', '));

    // 模拟 _probeClasses：并发 4 探测每个分类 categoryContent pg=1
    const results = {};
    let idx = 0;
    const t0 = Date.now();
    const probeOne = async (c) => {
        const tid = String(c.type_id != null ? c.type_id : '');
        const st = Date.now();
        try {
            const resp = await postJson(url('/action'), { do: 'categoryContent', site, tid, pg: '1', filter: 'false', extend: '{}' });
            const d = JSON.parse(resp.text);
            const len = ((d && d.list) || []).length;
            results[tid] = { name: c.type_name, status: resp.status, listLen: len, ms: Date.now() - st, code: d && d.code };
        } catch (e) {
            results[tid] = { name: c.type_name, status: 'REJECT', ms: Date.now() - st, err: String(e).slice(0, 60) };
        }
    };
    const worker = async () => { while (idx < classes.length) { await probeOne(classes[idx++]); } };
    await Promise.all(Array.from({ length: Math.min(4, classes.length) }, worker));
    const totalMs = Date.now() - t0;
    console.log('probe total ms:', totalMs);

    const empty = [], ok = [], err = [], reject = [];
    for (const c of classes) {
        const tid = String(c.type_id != null ? c.type_id : '');
        const r = results[tid] || {};
        if (r.status === 'REJECT') reject.push(`${tid}:${c.type_name}(${r.ms}ms ${r.err || ''})`);
        else if (r.status >= 400) err.push(`${tid}:${c.type_name} http${r.status} code${r.code} ${r.ms}ms`);
        else if (r.listLen === 0) empty.push(`${tid}:${c.type_name}`);
        else ok.push(`${tid}:${c.type_name}=${r.listLen}`);
    }
    console.log('\n=== EMPTY (should hide) ===\n' + (empty.join('\n') || '(none)'));
    console.log('\n=== OK (keep) ===\n' + ok.join(', '));
    console.log('\n=== HTTP ERROR (d.list undefined → probe treats as empty→hidden) ===\n' + (err.join('\n') || '(none)'));
    console.log('\n=== REJECT (fetch timeout/net → probe keeps visible!) ===\n' + (reject.join('\n') || '(none)'));
    child.kill();
    process.exit(0);
})().catch((e) => { console.error('diag error:', e); process.exit(2); });
