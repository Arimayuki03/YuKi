'use strict';
// 回归测试：外部播放器（VLC/PotPlayer/mpv 外部模式）spawn 选项禁止 windowsHide。
//
// 根因（2026-08-25 复现实锤）：Node/libuv 在 Windows 上为 windowsHide:true 设置
// STARTUPINFO 的 STARTF_USESHOWWINDOW=SW_HIDE；VLC(Qt) 主窗口以 SW_SHOWDEFAULT
// 显示时继承该值 → 进程存活但主窗口永久隐藏（EnumWindows 观测 visible=False，
// 去掉该开关后同进程同参数 visible=True）。PotPlayer 忽略该标志故此前未暴露。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const indexJs = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');

test('外部播放器 spawn 不携带 windowsHide（否则 VLC 主窗口被隐藏）', () => {
    // 外部播放器的 spawn 位点统一为 spawn(execPath, <args>, {...}) 形态
    // （args 为数组字面量或标识符均可）；内置 mpv 走 MpvPlayer.play 自行显式管理
    // 窗口显隐，不受此约束。
    const sites = [...indexJs.matchAll(/spawn\(execPath,\s*([^,]+),\s*\{([^}]*)\}/g)];
    assert.ok(sites.length >= 1, `应能找到外部播放器 spawn 位点，实际 ${sites.length} 个`);
    for (const [, , opts] of sites) {
        assert.ok(!/windowsHide/.test(opts),
            `外部播放器 spawn 选项含 windowsHide，会隐藏 VLC 主窗口：{${opts.trim()}}`);
    }
});

test('launchExternalPlayer 仅声明一次（同名重复声明会静默遮蔽前者）', () => {
    const count = (indexJs.match(/function launchExternalPlayer\(/g) || []).length;
    assert.equal(count, 1, `发现 ${count} 处 launchExternalPlayer 函数声明，后者会无声覆盖前者`);
});

// ---- R21（2026-08-26）：VLC 本地文件只拉窗口不播放 ----
// 根因：file-push/dl-play 传 C:/path 形态，VLC MRL 解析把盘符当未知 scheme 静默
// 放弃加载；且 vlc 分支旧实现 URL 在前、开关缀后（尾随 token 有被当内容条目的歧义）。

test('toExternalLocalUrl 存在：VLC 本地文件必须走 file:// URI（C:/ 盘符形态会被 VLC 当未知协议）', () => {
    assert.ok(indexJs.includes('function toExternalLocalUrl('),
        '应存在 toExternalLocalUrl 转换函数');
    // 转换函数内必须用 pathToFileURL（标准 file:// URI，百分号编码空格/中文）
    const fnSrc = indexJs.match(/function toExternalLocalUrl\([\s\S]*?\n    \}/)?.[0] || '';
    assert.ok(fnSrc.includes('pathToFileURL'),
        'VLC 分支应经 pathToFileURL 生成 file:/// URI');
});

test('file-push 与 dl-play 两处本地文件入口都必经 toExternalLocalUrl 再交外部播放器', () => {
    const sites = [...indexJs.matchAll(/const extUrl = toExternalLocalUrl\(abs, extKind\);/g)];
    assert.equal(sites.length, 2,
        `本地文件两处入口（yuki:file-push / yuki:dl-play）都应调用 toExternalLocalUrl，实际 ${sites.length} 处`);
});

test('buildExternalPlayerArgs：vlc/mpv 分支选项在前、URL 置末（防尾随 token 歧义）', () => {
    for (const kind of ['vlc', 'mpv']) {
        const m = indexJs.match(new RegExp(`if \\(kind === '${kind}'\\) \\{([\\s\\S]*?)return \\{ args`));
        assert.ok(m, `应能定位 buildExternalPlayerArgs 的 ${kind} 分支`);
        const body = m[1];
        assert.ok(!/const args = \[\s*url/.test(body),
            `${kind} 分支不应以 [url] 开头（URL 必须是最后一个参数）`);
        assert.ok(body.includes('args.push(url)'),
            `${kind} 分支应以 args.push(url) 收尾（选项在前、内容在后）`);
        const urlPos = body.indexOf('args.push(url)');
        for (const opt of ['--http-header-fields', '--no-video-title-show', '--title=']) {
            const pos = body.indexOf(opt);
            if (pos >= 0) assert.ok(pos < urlPos,
                `${kind} 分支中 ${opt} 应位于 URL 之前`);
        }
    }
});

// ---- R22（2026-08-26）：VLC 在线视频播放失败 ----
// 根因：① vlc 分支误用 mpv 的 --http-header-fields（VLC 报 unknown option 拒绝加载，
// 头从未生效）；② page 线路裸直链场景 VLC 默认 UA 被 CDN WAF 封锁 → 403；③ 代理对
// static/catvod 的 UA-only 会话 302 直连，播放器裸连丢头同因失败。

test('vlc 分支使用 VLC 真实开关（--http-user-agent/--http-referrer），禁止 mpv 语法', () => {
    const m = indexJs.match(/if \(kind === 'vlc'\) \{([\s\S]*?)return \{ args/);
    assert.ok(m, '应能定位 buildExternalPlayerArgs 的 vlc 分支');
    const body = m[1];
    assert.ok(body.includes('--http-user-agent='), '应使用 --http-user-agent 下发 UA');
    assert.ok(body.includes('--http-referrer='), '应使用 --http-referrer 下发 Referer');
    // 只查实际参数构造（push 调用），注释里的说明性提及不算
    const pushes = body.match(/args\.push\([^;]*\)/g) || [];
    assert.ok(pushes.length >= 1, 'vlc 分支应有参数 push');
    for (const p of pushes) {
        assert.ok(!p.includes('--http-header-fields'),
            `vlc 分支禁止生成 mpv 的 --http-header-fields 参数（VLC unknown option 直接拒载）：${p}`);
    }
});

test('launchExternalPlayerItems：VLC 裸直链补默认浏览器 UA（CDN WAF 封锁 VLC 默认 UA）', () => {
    const m = indexJs.match(/const spawnArgs = kind === 'vlc'\s*\?\s*\[([\s\S]*?)\]\s*:\s*\[target\]/);
    assert.ok(m, 'launchExternalPlayerItems 应按 kind 为 VLC 追加默认 UA 开关');
    assert.ok(m[1].includes("'--http-user-agent=Mozilla/5.0'"),
        'VLC 应下发 --http-user-agent=Mozilla/5.0（sniffMediaExt 同款探测 UA）');
});

// ---- R23（2026-08-26）：PotPlayer 播 m3u8 被识别成 MPEG TS ----
// 根因（本机 PotPlayer 26.06.30 请求矩阵实测）：CDN 清单响应缺 Content-Type 或
// application/octet-stream 时，PotPlayer 走「未知内容」原始流路径（Icy-MetaData/
// WINAMP 探测）把 m3u8 当 MPEG TS；查询串与 video/mp2t 谎报 CT 均无碍。修复：
// PotPlayer 的 http(s) HLS 直链一律包静态管道，由代理回写标准 mpegurl+定长。

test('R23：pipeWrapAuthUrl 对 PotPlayer 的 HLS 直链强制包装（kind 门控 + .m3u8 提示）', () => {
    const fnSrc = indexJs.match(/async function pipeWrapAuthUrl\([\s\S]*?\n    \}/)?.[0] || '';
    assert.ok(fnSrc, '应能定位 pipeWrapAuthUrl 函数体');
    assert.ok(fnSrc.includes("=== 'potplayer'"),
        '应按外部播放器类型判定（仅 PotPlayer 需要 CT 规范化包装）');
    assert.ok(/isPot && hint === '\.m3u8'/.test(fnSrc),
        '无鉴权头时仅在嗅探提示为 HLS（.m3u8）时包装，mp4/flv 维持裸直链');
    assert.ok(fnSrc.includes('forcePipe'),
        '注册时应携带 forcePipe——无头会话 302 直连 CDN 会复现误判');
});

test('R23：launchExternalPlayerItems 将播放器类型传入 resolveExternalItems', () => {
    assert.ok(indexJs.includes('await resolveExternalItems(items, kind)'),
        'resolveExternalItems 需要 kind 才能在 pipeWrapAuthUrl 内做 potplayer 门控');
});

test('R23：playlist-proxy 对 forcePipe 会话不再 302（needAuth || sess.forcePipe）', () => {
    const ppSrc = fs.readFileSync(path.join(__dirname, '../../src/main/playlist-proxy.js'), 'utf8');
    assert.ok(ppSrc.includes('needAuth || sess.forcePipe'),
        '_serveResolved 管道分流条件必须放行 forcePipe 会话');
    assert.ok(ppSrc.includes("headers['User-Agent'] = 'Mozilla/5.0'"),
        '_pipeRemote 无会话头时应补默认浏览器 UA（部分 CDN WAF 拒收无 UA 请求）');
});

test('R23：yuki:external-player 单集入口同样经 pipeWrapAuthUrl 规范化', () => {
    const m = indexJs.match(/ipcMain\.handle\('yuki:external-player'[\s\S]*?launchExternalPlayer\(extPlayer, target, header\)/);
    assert.ok(m, 'yuki:external-player 应在起播前经 pipeWrapAuthUrl 包装 target');
});

// ---- R24（2026-08-26）：VLC 播 kazumi 源失败 ----
// 根因：kazumi/catvod 整季队列走 m3u 文件入口，writeExtPlaylistFile 产出裸盘符
// 路径（C:\...\ext-xxx.m3u）直接交 VLC——MRL 解析把 C: 当未知 URI scheme 静默
// 拒载 → 空窗口不播（R21 同根因，当时只修了 file-push/dl-play 两个本地文件入口，
// 漏掉列表文件入口；PotPlayer/mpv 对裸路径兼容故未暴露）。

test('R24：launchExternalPlayerItems 的 m3u 列表文件必须经 toExternalLocalUrl（VLC 需 file:/// URI）', () => {
    const m = indexJs.match(/let target = isSingle \? resolved\[0\]\.url\s*:\s*toExternalLocalUrl\(writeExtPlaylistFile\(resolved\), kind\)/);
    assert.ok(m,
        '多集列表 writeExtPlaylistFile 产物应过 toExternalLocalUrl——裸盘符路径会被 VLC MRL 当未知 scheme 拒载');
});

test('R24：单条目 http(s) 直链不经本地路径转换（toExternalLocalUrl 会破坏 URL 形态）', () => {
    // toExternalLocalUrl 的 vlc 分支走 pathToFileURL，只接受本地路径；
    // 单条目分支必须保持 resolved[0].url 原样（http 直链/代理地址）
    const m = indexJs.match(/const isSingle = resolved\.length === 1;\s*let target = isSingle \? resolved\[0\]\.url/);
    assert.ok(m, 'isSingle 分支应直接使用 resolved[0].url，不走 toExternalLocalUrl');
});
