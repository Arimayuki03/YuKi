// 组件测试（白盒）：src/main/ffmpeg.js —— 探测 / 自动下载 / 抓帧全部私有分支。
// 手法：用 node:vm 加载真实源码文本，注入 fs / child_process / https / process 替身，
// 并把未导出的私有函数（makeThumb / thumbOutputOk / downloadFile / ffmpegLock / findFile /
// sha256File / _pumpThumb …）挂到 globalThis.__mod 上直测。
// 纪律：全程不出网、不执行真实 ffmpeg——子进程一律桩，execSync 默认直接抛错兜底。
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const REPO_ROOT = path.join(__dirname, '..', '..');
const REAL_SRC = path.join(REPO_ROOT, 'src', 'main');

const TMP_DIRS = [];
/** 临时仓库根/工作目录：统一登记，after 钩子清理。 */
function mktmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yuki-ffmpeg-'));
    TMP_DIRS.push(d);
    return d;
}
after(() => {
    for (const d of TMP_DIRS) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 已清理 */ }
    }
});

const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

// ---------------------------------------------------------------- 工具：假进程 / 假响应

/** 假子进程：只实现 ffmpeg.js 用到的 kill / on，事件由测试手动 _emit 触发。 */
function makeProc() {
    const listeners = {};
    const p = {
        killed: false,
        killedWith: null,
        on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return p; },
        once(ev, fn) { return p.on(ev, fn); },
        kill(sig) { p.killed = true; p.killedWith = sig || 'SIGTERM'; return true; },
        _emit(ev, ...a) { for (const fn of (listeners[ev] || []).slice()) fn(...a); },
    };
    return p;
}

/**
 * 计划驱动的 spawn 桩：第 n 次 spawn 取 plan[n]（越界取最后一项）。
 * step: { write:false 不落产物 | bytes 自定义内容 | code 退出码 | delay | error 触发 error 事件
 *         | hang 永不退出（超时场景） | manual 完全交给测试驱动 }
 */
function planSpawn(plan, procs) {
    return (calls, bin, args, opts) => {
        const i = calls.spawn.length;
        calls.spawn.push({ bin, args: args.slice(), opts });
        const step = plan[Math.min(i, plan.length - 1)] || {};
        const out = String(args[args.length - 1]);
        const proc = makeProc();
        if (procs) procs.push(proc);
        if (step.manual || step.hang) return proc;
        realSetTimeout(() => {
            if (step.error) { proc._emit('error', new Error(step.error)); return; }
            if (step.write !== false) fs.writeFileSync(out, step.bytes === undefined ? 'fake-jpg' : step.bytes);
            proc._emit('exit', step.code === undefined ? 0 : step.code);
        }, step.delay === undefined ? 5 : step.delay);
        return proc;
    };
}

/** 假 https 响应：statusCode/headers 可控，body 走 PassThrough 灌给写盘流。 */
function makeResponse(content, status = 200, headers = {}) {
    const stream = new PassThrough();
    const rsp = {
        statusCode: status,
        headers,
        destroyed: false,
        resumed: false,
        on(ev, fn) { stream.on(ev, fn); return rsp; },
        once(ev, fn) { stream.once(ev, fn); return rsp; },
        pipe(dest) { return stream.pipe(dest); },
        resume() { rsp.resumed = true; stream.resume(); return rsp; },
        destroy() { rsp.destroyed = true; stream.destroy(); return rsp; },
    };
    realSetTimeout(() => stream.end(content), 1);
    return rsp;
}

/** 假 https 请求对象：只实现 ffmpeg.js 用到的 on / destroy。 */
function makeReq() {
    const listeners = {};
    const req = {
        destroyed: false,
        on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return req; },
        destroy() { req.destroyed = true; return req; },
        _emit(ev, ...a) { for (const fn of (listeners[ev] || []).slice()) fn(...a); },
    };
    return req;
}

// ---------------------------------------------------------------- 模块加载器（VM + 注入桩）

/**
 * 在 VM 中加载 ffmpeg.js。
 * opts: { realRoot 用真实仓库根 | root 指定临时根 | platform 覆盖 process.platform
 *         | existsSync/readFileSync 覆盖 fs | spawn(calls,bin,args,opts)
 *         | execSync(cmd,opts) | httpsGet(url,opts,cb) }
 * 返回 { mod（含私有函数）, calls（副作用记录）, root }。
 */
function loadFfmpeg(opts = {}) {
    const root = opts.realRoot ? REPO_ROOT : (opts.root || mktmp());
    const dirname = path.join(root, 'src', 'main');
    const source = fs.readFileSync(path.join(REAL_SRC, 'ffmpeg.js'), 'utf8');
    const calls = { spawn: [], execSync: [], httpsGet: [], mkdir: [], rmSync: [], rm: [], copy: [] };

    // fs 替身：默认透传真实 fs（临时根下写盘安全），只记录关注点
    const fsStub = Object.assign({}, fs);
    if (opts.existsSync) fsStub.existsSync = opts.existsSync;
    if (opts.readFileSync) fsStub.readFileSync = opts.readFileSync;
    fsStub.mkdirSync = (p, o) => { calls.mkdir.push(String(p)); return fs.mkdirSync(p, o); };
    fsStub.rmSync = (p, o) => { calls.rmSync.push(String(p)); return fs.rmSync(p, o); };
    fsStub.rm = (p, o, cb) => { calls.rm.push(String(p)); return fs.rm(p, o, cb); };
    fsStub.copyFileSync = (s, d) => { calls.copy.push([String(s), String(d)]); return fs.copyFileSync(s, d); };

    // process 替身：platform 只读不可写，用 Proxy 转发到真实 process，只覆盖 platform
    const procStub = new Proxy({ platform: opts.platform || process.platform }, {
        get(t, k) { return Object.prototype.hasOwnProperty.call(t, k) ? t[k] : process[k]; },
    });

    const requireStub = (id) => {
        if (id === 'fs') return fsStub;
        if (id === 'path') return path;
        if (id === 'crypto') return crypto;
        if (id === 'https') return { get: (url, o, cb) => { calls.httpsGet.push(String(url)); return opts.httpsGet(url, o, cb); } };
        if (id === 'child_process') {
            return {
                spawn: (bin, args, o) => (opts.spawn || ((c, b, a, oo) => { c.spawn.push({ bin: b, args: a.slice(), opts: oo }); return makeProc(); }))(calls, bin, args, o),
                execSync: (cmd, o) => {
                    calls.execSync.push({ cmd: String(cmd), opts: o });
                    return opts.execSync ? opts.execSync(String(cmd), o) : (() => { throw new Error('ffmpeg.test: execSync 未桩'); })();
                },
            };
        }
        throw new Error('ffmpeg.test: 未预期的 require(' + id + ')'); // electron：非 Electron 环境
    };

    // 虚拟时钟：把 30s（抓帧超时）/10min（下载超时）压到 30ms，长尾等待不拖慢单测
    const timers = new Map();
    let tid = 0;
    const vSetTimeout = (fn, ms) => {
        const id = ++tid;
        const delay = typeof ms === 'number' && ms > 1000 ? 30 : (ms || 0);
        timers.set(id, realSetTimeout(() => { timers.delete(id); fn(); }, delay));
        return id;
    };
    const vClearTimeout = (id) => { const t = timers.get(id); if (t) { realClearTimeout(t); timers.delete(id); } };

    const context = {
        console, Buffer,
        process: procStub,
        require: requireStub,
        module: { exports: {} },
        __dirname: dirname,
        __filename: path.join(dirname, 'ffmpeg.js'),
        setTimeout: vSetTimeout,
        clearTimeout: vClearTimeout,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${source}
;globalThis.__mod = {
    findFfmpeg, ensureFfmpeg, isEnsuring, thumb, urlThumb,
    makeThumb, makeUrlThumb, thumbOutputOk, _pumpThumb,
    downloadFile, ffmpegLock, findFile, sha256File,
    DOWNLOAD_TIMEOUT_MS, THUMB_EXT, URL_THUMB_UA, FFMPEG_URL_FALLBACK,
    _getEnsuring: () => _ensuring,
    _setEnsuring: (v) => { _ensuring = v; },
    _getActive: () => _ensuringActive,
    _setActive: (v) => { _ensuringActive = v; },
    _getQueue: () => _thumbQueue,
    _getRunning: () => _thumbRunning,
};`, context, { filename: 'ffmpeg.js' });

    return { mod: context.__mod, calls, root };
}

/** 在临时根里放一个「已安装」的 vendor ffmpeg，供 findFfmpeg 命中。 */
function installVendorBin(root) {
    const p = path.join(root, 'vendor', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'fake-binary');
    return p;
}

/** 写临时 binaries.lock.json（ffmpeg 段可控）。 */
function writeLock(root, ffmpeg) {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'binaries.lock.json'), JSON.stringify({ ffmpeg }));
}

const STAGE_OF = (root) => path.join(root, 'vendor', '.tmp');
/** 判断被 rmSync 的路径是不是 vendor/.tmp（stage 目录）本身。 */
const dotmp = (p) => path.basename(path.resolve(String(p))) === '.tmp';

/**
 * 结果对象跨 VM 原型域：{ok,path} 字面量带的是 VM 的 Object.prototype，
 * 直接 deepStrictEqual 会因原型不同误判（值相同也判不等）。统一按字段断言。
 */
function expectFail(r, msg) {
    assert.strictEqual(r && r.ok, false, msg || 'ok 应为 false');
    assert.strictEqual(r && r.path, undefined, msg ? `${msg}（失败结果不应带 path）` : '失败结果不应带 path');
}

// ================================================================ findFfmpeg：探测优先级

test('findFfmpeg：vendor 内置命中即返回，且不再查 PATH（省掉 execSync 开销）', () => {
    const root = mktmp();
    const bin = installVendorBin(root);
    const { mod, calls } = loadFfmpeg({
        root,
        execSync: () => { throw new Error('不应查 PATH'); },
    });
    assert.strictEqual(mod.findFfmpeg(), bin, 'vendor 优先于 PATH');
    assert.strictEqual(calls.execSync.length, 0, 'vendor 命中时不应执行 where/command -v');
});

test('findFfmpeg：Windows 走 where ffmpeg，多行输出只取首行', () => {
    const { mod, calls } = loadFfmpeg({
        platform: 'win32',
        execSync: (cmd) => {
            assert.strictEqual(cmd, 'where ffmpeg');
            return Buffer.from('C:\\bin\\ffmpeg.exe\r\nD:\\other\\ffmpeg.exe\r\n');
        },
    });
    assert.strictEqual(mod.findFfmpeg(), 'C:\\bin\\ffmpeg.exe');
    assert.strictEqual(calls.execSync.length, 1);
});

test('findFfmpeg：非 Windows 走 command -v ffmpeg（命令与分支不同）', () => {
    const { mod, calls } = loadFfmpeg({
        platform: 'linux',
        execSync: (cmd) => {
            assert.strictEqual(cmd, 'command -v ffmpeg', 'POSIX 分支用 command -v');
            return Buffer.from('/usr/local/bin/ffmpeg\n');
        },
    });
    assert.strictEqual(mod.findFfmpeg(), '/usr/local/bin/ffmpeg');
    assert.strictEqual(calls.execSync[0].opts.windowsHide, true, '探测不应弹出控制台窗口');
});

test('findFfmpeg：PATH 探测命令抛错（不在 PATH）→ 返回 null 且不外抛', () => {
    const { mod } = loadFfmpeg({
        platform: 'win32',
        execSync: () => { throw new Error('where: 找不到文件'); },
    });
    assert.strictEqual(mod.findFfmpeg(), null, '探测失败必须静默返回 null');
});

test('findFfmpeg：where 输出全空白 → 返回 null（首行为空串不能当路径）', () => {
    const { mod } = loadFfmpeg({ platform: 'win32', execSync: () => Buffer.from('  \r\n \r\n') });
    assert.strictEqual(mod.findFfmpeg(), null);
});

// ================================================================ ffmpegLock：锁定源读取

test('ffmpegLock：真实 scripts/binaries.lock.json 读出 url+sha256（供应链校验前提）', () => {
    const { mod } = loadFfmpeg({ realRoot: true });
    const lock = mod.ffmpegLock();
    assert.ok(lock, '仓库应带锁定的 ffmpeg 段');
    assert.match(lock.url, /^https:\/\//, '锁定源必须是 https');
    assert.match(lock.sha256, /^[0-9a-f]{64}$/, 'sha256 必须是 64 位 hex');
});

test('ffmpegLock：lock 文件缺失 → null（调用方据此拒绝下载）', () => {
    const { mod } = loadFfmpeg(); // 临时根里没有 scripts/binaries.lock.json
    assert.strictEqual(mod.ffmpegLock(), null);
});

test('ffmpegLock：lock 缺 sha256 / 非法 JSON → null（绝不下载未校验二进制）', () => {
    const root = mktmp();
    writeLock(root, { url: 'https://ffmpeg.test/a.zip' }); // 有 url 无 sha256
    const a = loadFfmpeg({ root });
    assert.strictEqual(a.mod.ffmpegLock(), null, '缺 sha256 应视为无锁定源');

    const root2 = mktmp();
    writeLock(root2, { url: 'https://ffmpeg.test/a.zip', sha256: 'deadbeef' });
    const b = loadFfmpeg({ root: root2, readFileSync: () => '{ 坏 JSON' });
    assert.strictEqual(b.mod.ffmpegLock(), null, '解析失败应兜底 null 而非抛错');
});

// ================================================================ ensureFfmpeg / isEnsuring

test('ensureFfmpeg：已安装则直接返回路径，isEnsuring 恒 false 且不建 stage', async () => {
    const root = mktmp();
    const bin = installVendorBin(root);
    const { mod, calls } = loadFfmpeg({ root, httpsGet: () => { throw new Error('不应下载'); } });
    const r = await mod.ensureFfmpeg();
    assert.strictEqual(r, bin, '已安装直接复用');
    assert.strictEqual(mod.isEnsuring(), false, '未进入下载流程时不能报「后台下载中」');
    assert.strictEqual(calls.mkdir.length, 0, '不应创建 vendor/.tmp');
    assert.strictEqual(calls.httpsGet.length, 0, '不应发起下载');
});

test('ensureFfmpeg：并发单飞——两次调用复用同一 Promise，只下载一次', async () => {
    const root = mktmp();
    writeLock(root, { url: 'https://ffmpeg.test/a.zip', sha256: 'x'.repeat(64) });
    const { mod, calls } = loadFfmpeg({ root, httpsGet: () => makeReq() }); // 挂起：永不回调
    const p1 = mod.ensureFfmpeg();
    const p2 = mod.ensureFfmpeg();
    assert.strictEqual(p1, p2, '并发必须复用同一 Promise（isEnsuring 的语义基础）');
    assert.strictEqual(mod._getEnsuring(), p1, '模块内部单飞槽应持有该 Promise');
    const rs = await Promise.all([p1, p2]);
    assert.deepStrictEqual([rs[0], rs[1]], [null, null], '下载挂起最终超时兜底为 null');
    assert.strictEqual(calls.httpsGet.length, 1, '单飞：190MB 只能下一次');
    assert.strictEqual(mod._getEnsuring(), null, '结束后清空单飞槽，失败可重试');
});

test('isEnsuring：下载进行中为 true，结束后回落 false', async () => {
    const root = mktmp();
    writeLock(root, { url: 'https://ffmpeg.test/a.zip', sha256: 'x'.repeat(64) });
    const { mod } = loadFfmpeg({ root, httpsGet: () => makeReq() });
    assert.strictEqual(mod.isEnsuring(), false, '初始态应为 false');
    const p = mod.ensureFfmpeg();
    assert.strictEqual(mod.isEnsuring(), true, 'm3u8 下载据此提示「后台下载中」');
    assert.strictEqual(await p, null);
    assert.strictEqual(mod.isEnsuring(), false, '收尾必须复位，否则 UI 永久显示下载中');
    assert.strictEqual(mod._getActive(), false);
});

test('ensureFfmpeg：非 Windows 未安装 → null（交给系统包管理器，不下载）', async () => {
    const root = mktmp();
    const { mod, calls } = loadFfmpeg({
        root,
        platform: 'linux',
        execSync: () => { throw new Error('not in PATH'); },
        httpsGet: () => { throw new Error('不应下载'); },
    });
    assert.strictEqual(await mod.ensureFfmpeg(), null);
    assert.strictEqual(mod.isEnsuring(), false, '非 Windows 不进入下载态');
    assert.strictEqual(calls.httpsGet.length, 0);
    assert.strictEqual(calls.mkdir.length, 0);
});

test('ensureFfmpeg：无 lock → 拒绝下载未校验二进制（null，不建 stage 不出网）', async () => {
    const root = mktmp();
    const { mod, calls } = loadFfmpeg({ root, httpsGet: () => { throw new Error('不应下载'); } });
    assert.strictEqual(await mod.ensureFfmpeg(), null);
    assert.strictEqual(calls.httpsGet.length, 0, '缺少 url/sha256 时绝不出网');
    assert.ok(!calls.mkdir.some((p) => String(p).includes('.tmp')), '不应创建 stage 目录');
});

test('ensureFfmpeg：sha256 不匹配 → 放弃安装、清理 stage、不落 exe', async () => {
    const root = mktmp();
    writeLock(root, { url: 'https://ffmpeg.test/a.zip', sha256: 'a'.repeat(64) }); // 必然不匹配
    const { mod, calls } = loadFfmpeg({
        root,
        httpsGet: (url, o, cb) => { const req = makeReq(); realSetTimeout(() => cb(makeResponse('tampered-zip')), 0); return req; },
        execSync: () => { throw new Error('不应解压'); },
    });
    assert.strictEqual(await mod.ensureFfmpeg(), null, '校验失败必须放弃安装');
    assert.strictEqual(calls.copy.length, 0, '被篡改的包不能拷进 vendor');
    assert.strictEqual(calls.execSync.filter((e) => e.cmd.includes('yuki-ffmpeg.zip')).length, 0,
        '校验不过绝不解压（不计 findFfmpeg 的 where 探测）');
    // archive 在校验失败处被立即删、stage 在 catch 里整目录删：两者都要发生
    assert.ok(calls.rmSync.some((p) => path.basename(String(p)) === 'yuki-ffmpeg.zip'),
        '被篡改的归档必须当场删除');
    assert.ok(calls.rmSync.some((p) => dotmp(p)), 'stage 必须清理，避免残留半截 zip');
    assert.strictEqual(fs.existsSync(path.join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe')), false,
        '校验失败不得在 vendor 留下 exe');
});

test('ensureFfmpeg：全流程成功——下载→校验→tar 解压→递归找 exe→拷出→清 stage', async () => {
    const root = mktmp();
    const content = Buffer.from('fake-ffmpeg-zip');
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    writeLock(root, { url: 'https://ffmpeg.test/ff.zip', sha256: sha });
    const tars = [];
    const { mod, calls } = loadFfmpeg({
        root,
        httpsGet: (url, o, cb) => { const req = makeReq(); realSetTimeout(() => cb(makeResponse(content)), 0); return req; },
        execSync: (cmd, o) => {
            // findFfmpeg 的 where 探测：本用例库内无 PATH 命中（vendor 是唯一来源）
            if (!cmd.includes('yuki-ffmpeg.zip')) throw new Error('where: 找不到文件');
            tars.push({ cmd, opts: o });
            // 模拟 tar -xf：在解压目录的深层子目录里产出 ffmpeg.exe
            // 模拟 tar -xf：在解压目录的深层子目录里产出 ffmpeg.exe
            const binDir = path.join(o.cwd, 'yuki-ffmpeg-extract', 'ffmpeg-n9.0-win64', 'bin');
            fs.mkdirSync(binDir, { recursive: true });
            fs.writeFileSync(path.join(binDir, 'ffmpeg.exe'), 'binary');
        },
    });
    const target = path.join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe');
    // 落盘前的 vendor/ffmpeg 目录此刻还不存在（mkdir 在 ensure 内部完成），先建好再比较
    assert.strictEqual(await mod.ensureFfmpeg(), path.resolve(target), '成功返回 vendor 目标路径');
    assert.strictEqual(tars.length, 1, '只解压一次');
    assert.match(tars[0].cmd, /-xf/, '解压命令必须带 -xf');
    assert.match(tars[0].cmd, /yuki-ffmpeg\.zip/, '解压对象为 stage 里的归档');
    assert.match(tars[0].cmd, /yuki-ffmpeg-extract/, '解压目标为 stage 内的相对目录名');
    assert.strictEqual(tars[0].opts.cwd, path.resolve(STAGE_OF(root)), 'cwd 指向 stage，规避盘符冒号解析');
    assert.strictEqual(calls.copy.length, 1, '找到的 ffmpeg.exe 拷到 vendor');
    assert.ok(calls.copy[0][0].endsWith('ffmpeg.exe'));
    assert.strictEqual(calls.copy[0][1], path.resolve(target));
    assert.ok(calls.rmSync.some((p) => dotmp(p)), '成功后同样要清 stage');
    assert.strictEqual(calls.httpsGet[0], 'https://ffmpeg.test/ff.zip', 'URL 取锁定值');
});

test('ensureFfmpeg：lock 有 url 时严格用锁定 url（不走兜底常量）', async () => {
    const root = mktmp();
    const content = Buffer.from('z');
    writeLock(root, { url: 'https://ffmpeg.test/pinned.zip', sha256: crypto.createHash('sha256').update(content).digest('hex') });
    const { mod, calls } = loadFfmpeg({
        root,
        httpsGet: (url, o, cb) => { const req = makeReq(); realSetTimeout(() => cb(makeResponse(content)), 0); return req; },
        execSync: (cmd, o) => {
            const binDir = path.join(o.cwd, 'yuki-ffmpeg-extract', 'bin');
            fs.mkdirSync(binDir, { recursive: true });
            fs.writeFileSync(path.join(binDir, 'ffmpeg.exe'), 'binary');
        },
    });
    const installed = await mod.ensureFfmpeg();
    assert.strictEqual(calls.httpsGet[0], 'https://ffmpeg.test/pinned.zip', '锁定 url 优先于兜底常量');
    assert.notStrictEqual(calls.httpsGet[0], mod.FFMPEG_URL_FALLBACK, '有锁定源时不该用兜底常量');
    assert.strictEqual(installed, path.resolve(path.join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe')), '应完成安装');
});

test('ensureFfmpeg：下载请求 error → 兜底 null，且失败后单飞槽复位可重试', async () => {
    const root = mktmp();
    writeLock(root, { url: 'https://ffmpeg.test/a.zip', sha256: 'x'.repeat(64) });
    const reqs = [];
    const { mod, calls } = loadFfmpeg({
        root,
        httpsGet: () => { const req = makeReq(); reqs.push(req); realSetTimeout(() => req._emit('error', new Error('ENOTFOUND')), 2); return req; },
    });
    assert.strictEqual(await mod.ensureFfmpeg(), null, '网络失败不抛出');
    assert.strictEqual(reqs[0].destroyed, true, '失败路径必须销毁在途请求，否则 socket 悬挂');
    assert.strictEqual(await mod.ensureFfmpeg(), null, '第二次调用应重新尝试（槽已复位）');
    assert.strictEqual(calls.httpsGet.length, 2, '失败后允许重试');
});

// ================================================================ downloadFile：重定向/状态/超时

test('downloadFile：跟随 3xx 重定向并最终写盘', async () => {
    const root = mktmp();
    const dest = path.join(root, 'out.zip');
    const hops = [];
    const { mod } = loadFfmpeg({
        root,
        httpsGet: (url, o, cb) => {
            hops.push(url);
            const req = makeReq();
            realSetTimeout(() => cb(makeResponse('body', hops.length < 3 ? 302 : 200, { location: `https://ffmpeg.test/h${hops.length + 1}` })), 0);
            return req;
        },
    });
    const got = await mod.downloadFile('https://ffmpeg.test/h1', dest);
    assert.strictEqual(got, dest);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'body');
    assert.strictEqual(hops.length, 3, '应连续跟随 302');
});

test('downloadFile：重定向超过 5 次 → reject（防跳死循环）', async () => {
    const root = mktmp();
    const { mod } = loadFfmpeg({
        root,
        httpsGet: (url, o, cb) => { const req = makeReq(); realSetTimeout(() => cb(makeResponse('', 302, { location: 'https://ffmpeg.test/next' })), 0); return req; },
    });
    await assert.rejects(mod.downloadFile('https://ffmpeg.test/x', path.join(root, 'o.zip')), /too many redirects/);
});

test('downloadFile：非 200 → reject「HTTP xxx」且响应被 resume 释放', async () => {
    const root = mktmp();
    let rsp;
    const { mod } = loadFfmpeg({
        root,
        httpsGet: (url, o, cb) => { const req = makeReq(); rsp = makeResponse('', 404); realSetTimeout(() => cb(rsp), 0); return req; },
    });
    await assert.rejects(mod.downloadFile('https://ffmpeg.test/x', path.join(root, 'o.zip')), /HTTP 404/);
    assert.strictEqual(rsp.resumed, true, '错误响应必须 resume，否则连接悬挂');
});

test('downloadFile：总超时到点 reject（10min 由虚拟时钟压缩）', async () => {
    const root = mktmp();
    const { mod } = loadFfmpeg({ root, httpsGet: () => makeReq() }); // 永不响应
    assert.strictEqual(mod.DOWNLOAD_TIMEOUT_MS, 10 * 60 * 1000, '超时常量本身应是 10 分钟');
    await assert.rejects(mod.downloadFile('https://ffmpeg.test/x', path.join(root, 'o.zip')), /download timeout \(10 min\)/);
});

// ================================================================ 私有工具：findFile / sha256File / thumbOutputOk

test('findFile：递归找到深层 ffmpeg.exe；找不到返回 null', () => {
    const root = mktmp();
    const deep = path.join(root, 'pkg', 'bin');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'ffmpeg.exe'), 'x');
    const { mod } = loadFfmpeg({ root });
    assert.strictEqual(mod.findFile(root, 'ffmpeg.exe'), path.join(deep, 'ffmpeg.exe'), '应穿透多层目录');
    assert.strictEqual(mod.findFile(root, 'mpv.exe'), null);
});

test('sha256File：流式摘要与 crypto 全量摘要一致', async () => {
    const root = mktmp();
    const f = path.join(root, 'blob');
    const body = crypto.randomBytes(2048);
    fs.writeFileSync(f, body);
    const { mod } = loadFfmpeg({ root });
    assert.strictEqual(await mod.sha256File(f), crypto.createHash('sha256').update(body).digest('hex'));
});

test('thumbOutputOk：0 字节残留判失败并删除（防缓存永久命中坏图）', () => {
    const root = mktmp();
    const jpg = path.join(root, 'a.jpg');
    fs.writeFileSync(jpg, '');
    const { mod } = loadFfmpeg({ root });
    assert.strictEqual(mod.thumbOutputOk(jpg), false);
    assert.strictEqual(fs.existsSync(jpg), false, '0 字节坏图必须当场删除');
    assert.strictEqual(mod.thumbOutputOk(path.join(root, 'missing.jpg')), false, '不存在按失败处理');
    fs.writeFileSync(jpg, 'jpeg-bytes');
    assert.strictEqual(mod.thumbOutputOk(jpg), true, '非 0 字节判成功');
});

// ================================================================ thumb：本地抓帧

/** 建一个可抓帧的本地视频文件（内容随意，抓帧全靠桩）。 */
function makeVideo(root, name, body = 'video') {
    const p = path.join(root, name);
    fs.writeFileSync(p, body);
    return p;
}

test('thumb：已知非视频扩展名直接拒绝，不入队不起进程', async () => {
    const root = mktmp();
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([]) });
    for (const bad of ['a.txt', 'b.jpg', 'c.srt', 'd.nfo', 'e.zip']) {
        const r = await mod.thumb(path.join(root, bad), path.join(root, 'cache'));
        expectFail(r, `${bad} 应被拒`);
    }
    assert.strictEqual(calls.spawn.length, 0, '拒绝路径不应 spawn');
    assert.strictEqual(mod._getQueue().length, 0, '拒绝路径不应进队列');
});

test('thumb：无扩展名（旧版存量文件）放行给 ffmpeg 探测', async () => {
    const root = mktmp();
    const video = makeVideo(root, 'noext-video');
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([{ write: true }]) });
    installVendorBin(root);
    const r = await mod.thumb(video, path.join(root, 'cache'));
    assert.strictEqual(r.ok, true, '无后缀文件不应被扩展名白名单拦掉');
    assert.strictEqual(calls.spawn.length, 1);
});

test('thumb：参数拼装为 -y -ss 5 -i <视频> -frames:v 1 -vf scale=480:-2 <输出>', async () => {
    const root = mktmp();
    const bin = installVendorBin(root);
    const video = makeVideo(root, 'v.mp4');
    const cacheDir = path.join(root, 'cache');
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([{ write: true }]) });
    const r = await mod.thumb(video, cacheDir);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.spawn[0].bin, bin, '必须用 findFfmpeg 探测到的二进制');
    assert.strictEqual(calls.spawn[0].args.join('|'),
        `-y|-ss|5|-i|${video}|-frames:v|1|-vf|scale=480:-2|${r.path}`);
    assert.strictEqual(calls.spawn[0].opts.windowsHide, true);
});

test('thumb：缓存 key 为 md5(路径|mtimeMs|size)——同一文件二次命中不重抓', async () => {
    const root = mktmp();
    installVendorBin(root);
    const video = makeVideo(root, 'v.mp4');
    const cacheDir = path.join(root, 'cache');
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([{ write: true }]) });
    const r1 = await mod.thumb(video, cacheDir);
    const st = fs.statSync(video);
    const expectKey = crypto.createHash('md5').update(`${video}|${st.mtimeMs}|${st.size}`).digest('hex');
    assert.strictEqual(path.basename(r1.path), `${expectKey}.jpg`, 'key 必须含路径/mtime/大小三要素');

    const r2 = await mod.thumb(video, cacheDir);
    assert.strictEqual(r2.path, r1.path, '同文件应命中缓存');
    assert.strictEqual(calls.spawn.length, 1, '命中缓存不得再起 ffmpeg');
});

test('thumb：文件被改写（size/mtime 变化）→ key 失效重新抓帧', async () => {
    const root = mktmp();
    installVendorBin(root);
    const video = makeVideo(root, 'v.mp4', 'short');
    const cacheDir = path.join(root, 'cache');
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([{ write: true }, { write: true }]) });
    const r1 = await mod.thumb(video, cacheDir);
    fs.writeFileSync(video, 'much-longer-content-after-edit'); // size 变化
    const r2 = await mod.thumb(video, cacheDir);
    assert.notStrictEqual(r2.path, r1.path, '内容变化后 key 必须不同');
    assert.strictEqual(calls.spawn.length, 2);
});

test('thumb：5s 处无帧 → 自动从头重试（第二次参数不带 -ss）', async () => {
    const root = mktmp();
    installVendorBin(root);
    const video = makeVideo(root, 'short.mkv');
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([{ write: false }, { write: true }]) });
    const r = await mod.thumb(video, path.join(root, 'cache'));
    assert.strictEqual(r.ok, true, '重试成功应返回 ok');
    assert.strictEqual(calls.spawn.length, 2, '首次无产物必须重试一次');
    assert.ok(calls.spawn[0].args.includes('5'), '首次带 -ss 5');
    assert.strictEqual(calls.spawn[1].args.includes('-ss'), false, '重试从头抓，不带 -ss');
    assert.ok(calls.spawn[1].args.includes('scale=480:-2'), '重试同样缩到 480 宽');
});

test('thumb：两次都失败 → ok:false，且遗留的 0 字节 jpg 被清掉', async () => {
    const root = mktmp();
    installVendorBin(root);
    const video = makeVideo(root, 'broken.mp4');
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([{ write: false }, { bytes: '' }]) });
    const r = await mod.thumb(video, path.join(root, 'cache'));
    expectFail(r, '两次都失败应判负');
    assert.strictEqual(calls.spawn.length, 2);
    const st = fs.statSync(video);
    const key = crypto.createHash('md5').update(`${video}|${st.mtimeMs}|${st.size}`).digest('hex');
    assert.strictEqual(fs.existsSync(path.join(root, 'cache', key + '.jpg')), false, '0 字节残留必须删除');
});

test('thumb：文件不存在（statSync 抛错）→ ok:false，不起进程', async () => {
    const root = mktmp();
    installVendorBin(root);
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([]) });
    const r = await mod.thumb(path.join(root, 'gone.mp4'), path.join(root, 'cache'));
    expectFail(r, '源不存在应判负');
    assert.strictEqual(calls.spawn.length, 0, '源不存在不应起 ffmpeg');
});

test('thumb：空路径输入 → ok:false（无扩展名放行后 statSync 兜底）', async () => {
    const root = mktmp();
    installVendorBin(root);
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([]) });
    expectFail(await mod.thumb('', path.join(root, 'cache')), '空路径应被拒');
    assert.strictEqual(calls.spawn.length, 0);
});

test('thumb：与 urlThumb 的入参净化差异——thumb 对 null/数字漏保护（现存缺陷，见报告）', async () => {
    // ffmpeg.js:291 path.extname(videoPath) 对非字符串会抛 TypeError，而 urlThumb
    // 在 ffmpeg.js:302 先做 String(url || '') 净化。二者契约不对称，此处固化现状：
    // thumb 走 Promise reject，urlThumb 走 resolve({ok:false})。
    const root = mktmp();
    installVendorBin(root);
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([]) });
    for (const bad of [null, undefined, 123, {}]) {
        await assert.rejects(mod.thumb(bad, path.join(root, 'cache')), TypeError,
            `thumb(${String(bad)}) 应因缺少入参净化而 reject`);
    }
    for (const bad of [null, undefined, 123, {}]) {
        expectFail(await mod.urlThumb(bad, path.join(root, 'cache')),
            `urlThumb(${String(bad)}) 应被 String(url||'') 净化后判负`);
    }
    assert.strictEqual(calls.spawn.length, 0, '非法入参都不应起 ffmpeg');
});

test('thumb：系统无 ffmpeg（探测为 null）→ ok:false', async () => {
    const root = mktmp();
    const video = makeVideo(root, 'v.mp4');
    const { mod, calls } = loadFfmpeg({ root, execSync: () => { throw new Error('no ffmpeg in PATH'); } });
    assert.strictEqual(mod.findFfmpeg(), null);
    expectFail(await mod.thumb(video, path.join(root, 'cache')));
    assert.strictEqual(calls.spawn.length, 0, '没有二进制时不能尝试 spawn');
});

test('thumb：30s 超时杀进程并清理半写 jpg（损坏容器不占死并发额度）', async () => {
    const root = mktmp();
    installVendorBin(root);
    const video = makeVideo(root, 'hang.mp4');
    const cacheDir = path.join(root, 'cache');
    const procs = [];
    const { mod, calls } = loadFfmpeg({
        root,
        spawn: (c, bin, args, o) => { c.spawn.push({ bin, args: args.slice(), opts: o }); const p = makeProc(); procs.push(p); return p; }, // 永不退出
    });
    const pending = mod.thumb(video, cacheDir);
    await sleep(20);
    // 模拟 ffmpeg 卡死前已写出半截文件
    const st = fs.statSync(video);
    const key = crypto.createHash('md5').update(`${video}|${st.mtimeMs}|${st.size}`).digest('hex');
    const out = path.join(cacheDir, key + '.jpg');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(out, 'half-written');
    const r = await pending;
    expectFail(r, '超时必须判负而不是永挂');
    assert.strictEqual(procs[0].killed, true, '超时必须 kill 掉 ffmpeg 进程');
    assert.strictEqual(calls.spawn.length, 1, '超时后不应再走重试分支');
    await sleep(50); // discardPartialOutput 是异步 rm
    assert.strictEqual(fs.existsSync(out), false, '半写 jpg 必须清除，否则缓存永久命中坏图');
    // 超时后迟到到达的 exit 事件走 discard 分支，同样不能复活结果
    procs[0]._emit('exit', 1);
    await sleep(20);
    assert.strictEqual(fs.existsSync(out), false);
});

test('thumb：spawn 触发 error（二进制损坏/权限）→ ok:false 不抛', async () => {
    const root = mktmp();
    installVendorBin(root);
    const video = makeVideo(root, 'v.mp4');
    const { mod } = loadFfmpeg({ root, spawn: planSpawn([{ error: 'EACCES' }]) });
    expectFail(await mod.thumb(video, path.join(root, 'cache')));
});

test('thumb：并发上限 4——投 6 个任务，同时在跑不超过 4', async () => {
    const root = mktmp();
    installVendorBin(root);
    const cacheDir = path.join(root, 'cache');
    const procs = [];
    const videos = [];
    for (let i = 0; i < 6; i++) videos.push(makeVideo(root, `v${i}.mp4`, `body-${i}`));
    const { mod, calls } = loadFfmpeg({
        root,
        spawn: (c, bin, args, o) => { c.spawn.push({ bin, args: args.slice(), opts: o }); const p = makeProc(); procs.push(p); return p; },
    });
    const pendings = videos.map((v) => mod.thumb(v, cacheDir));
    await sleep(20);
    assert.strictEqual(calls.spawn.length, 4, '首批只能起 4 个（并发上限）');
    assert.strictEqual(mod._getQueue().length, 2, '其余 2 个留在队列里');
    assert.strictEqual(mod._getRunning(), 4);

    // 放行首批：写出产物后触发 exit，队列应自动续跑
    for (let i = 0; i < 4; i++) {
        fs.writeFileSync(calls.spawn[i].args[calls.spawn[i].args.length - 1], 'jpg');
        procs[i]._emit('exit', 0);
    }
    await sleep(30);
    assert.strictEqual(calls.spawn.length, 6, '首批完成后队列应自动补充');
    for (let i = 4; i < 6; i++) {
        fs.writeFileSync(calls.spawn[i].args[calls.spawn[i].args.length - 1], 'jpg');
        procs[i]._emit('exit', 0);
    }
    const rs = await Promise.all(pendings);
    assert.strictEqual(rs.filter((x) => x.ok).length, 6, '6 个任务最终全部成功');
    assert.strictEqual(mod._getRunning(), 0, '计数必须归零，否则后续任务永久排队');
});

// ================================================================ urlThumb：直链抓帧

test('urlThumb：协议白名单内外差异（http/https/rtmp/rtmps 放行，ftp/file/空/null 拒绝）', async () => {
    const root = mktmp();
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([]) });
    const deny = ['ftp://h/a.mp4', 'file:///C:/a.mp4', 'C:\\a.mp4', '', null, undefined, 123];
    for (const u of deny) {
        expectFail(await mod.urlThumb(u, path.join(root, 'c')), String(u));
    }
    assert.strictEqual(calls.spawn.length, 0, '非法协议不应起进程');
    assert.strictEqual(mod._getQueue().length, 0, '非法协议不应入队');

    // 放行侧：协议名大小写不敏感——判据是「确实起了带该 URL 的抓帧进程」而非只看返回值
    installVendorBin(root); // 放行侧需要 findFfmpeg 命中，否则进程起不来
    const allow = loadFfmpeg({ root, spawn: planSpawn([{ hang: true }]) });
    assert.strictEqual(allow.mod.findFfmpeg() !== null, true, '抓帧前置：二进制应可探测');
    for (const u of ['HTTP://h/a.m3u8', 'rtmp://h/live', 'rtmps://h/live']) {
        const before = allow.calls.spawn.length;
        const p = allow.mod.urlThumb(u, path.join(root, 'c'));
        p.catch(() => {}); // 桩挂起不退出，任务不会完结；结果丢弃
        await sleep(15);
        assert.strictEqual(allow.calls.spawn.length, before + 1, `${u} 应被放行并起抓帧进程`);
        assert.ok(allow.calls.spawn[before].args.includes(u), `${u} 必须原样传给 ffmpeg`);
    }
});

test('urlThumb：参数比本地多 -hide_banner 与 -user_agent（远程站点反爬需要）', async () => {
    const root = mktmp();
    const bin = installVendorBin(root);
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([{ write: true }]) });
    const url = 'https://cdn.test/live.m3u8';
    const r = await mod.urlThumb(url, path.join(root, 'cache'));
    assert.strictEqual(r.ok, true);
    const args = calls.spawn[0].args;
    assert.strictEqual(calls.spawn[0].bin, bin);
    assert.ok(args.includes('-hide_banner'), 'URL 抓帧带 -hide_banner');
    assert.ok(args.includes('-user_agent'), 'URL 抓帧带 -user_agent');
    assert.strictEqual(args[args.indexOf('-user_agent') + 1], mod.URL_THUMB_UA, 'UA 常量');
    assert.match(mod.URL_THUMB_UA, /Mozilla/, 'UA 需伪装浏览器');
    assert.strictEqual(args.join('|'),
        `-y|-hide_banner|-user_agent|${mod.URL_THUMB_UA}|-ss|5|-i|${url}|-frames:v|1|-vf|scale=480:-2|${r.path}`);
});

test('urlThumb：缓存 key 为 md5(url)（远程无 mtime/size 可比）', async () => {
    const root = mktmp();
    installVendorBin(root);
    const url = 'https://cdn.test/v.mp4';
    const cacheDir = path.join(root, 'cache');
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([{ write: true }]) });
    const r1 = await mod.urlThumb(url, cacheDir);
    assert.strictEqual(path.basename(r1.path), `${crypto.createHash('md5').update(url).digest('hex')}.jpg`);
    const r2 = await mod.urlThumb(url, cacheDir);
    assert.strictEqual(r2.path, r1.path, '同 URL 命中缓存');
    assert.strictEqual(calls.spawn.length, 1, '命中缓存不再抓帧');
});

test('urlThumb：首次 -ss 5 失败后从头重试；两次都失败 → ok:false 并清理空文件', async () => {
    const root = mktmp();
    installVendorBin(root);
    const url = 'https://cdn.test/dead.mp4';
    const cacheDir = path.join(root, 'cache');
    const { mod, calls } = loadFfmpeg({ root, spawn: planSpawn([{ write: false }, { bytes: '' }]) });
    expectFail(await mod.urlThumb(url, cacheDir));
    assert.strictEqual(calls.spawn.length, 2, '远程同样有从头重试');
    assert.strictEqual(calls.spawn[1].args.includes('-ss'), false);
    const out = path.join(cacheDir, `${crypto.createHash('md5').update(url).digest('hex')}.jpg`);
    assert.strictEqual(fs.existsSync(out), false, '失败的 0 字节输出必须删除');
});

test('urlThumb：30s 超时杀进程并判负（死链/慢站不长期占用额度）', async () => {
    const root = mktmp();
    installVendorBin(root);
    const procs = [];
    const { mod, calls } = loadFfmpeg({
        root,
        spawn: (c, bin, args, o) => { c.spawn.push({ bin, args: args.slice(), opts: o }); const p = makeProc(); procs.push(p); return p; },
    });
    const url = 'https://cdn.test/slow.mp4';
    const r = await mod.urlThumb(url, path.join(root, 'cache'));
    expectFail(r, 'URL 抓帧超时应判负');
    assert.strictEqual(procs[0].killed, true, '超时必须 kill');
    assert.strictEqual(calls.spawn.length, 1, '超时后不重试');
});

test('urlThumb：无 ffmpeg → ok:false（与 thumb 共用 findFfmpeg 兜底）', async () => {
    const root = mktmp();
    const { mod, calls } = loadFfmpeg({ root, execSync: () => { throw new Error('no ffmpeg'); } });
    expectFail(await mod.urlThumb('https://cdn.test/a.mp4', path.join(root, 'c')));
    assert.strictEqual(calls.spawn.length, 0);
});

// ================================================================ 常量/白名单（防回归）

test('THUMB_EXT：常见视频扩展名在白名单，非视频不在（扩展名大小写无关）', () => {
    const { mod } = loadFfmpeg();
    for (const ext of ['.mp4', '.mkv', '.ts', '.flv', '.avi', '.mov', '.wmv', '.mpg', '.mpeg', '.m4v', '.webm', '.m2ts']) {
        assert.strictEqual(mod.THUMB_EXT.has(ext), true, ext);
    }
    for (const ext of ['.txt', '.jpg', '.srt', '.ass', '.zip', '.exe']) {
        assert.strictEqual(mod.THUMB_EXT.has(ext), false, ext);
    }
});
