const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('2A: about is a settings category and legacy UI is removed', () => {
    const html = read('src/renderer/index.html');

    assert.match(html, /data-cat="about"/);
    assert.equal((html.match(/data-setcat="about"/g) || []).length, 4);
    assert.doesNotMatch(html, /data-view="about"|id="view-about"/);
    // 2.11：外观卡已新增「MiSans 界面字体」开关，故不再断言无 MiSans 文案
    assert.doesNotMatch(html, /set_pip_|id="app_version"|画中画/);
    assert.match(html, /set_use_misans/);
});

test('2A/T61: MiSans font bundled via vpc:font-css (no runtime-download/PiP hooks)', () => {
    const sources = [
        read('src/renderer/js/app.js'),
        read('src/renderer/js/panels.js'),
        read('src/preload/preload.js'),
        read('src/main/index.js'),
    ].join('\n');

    // T61：内置 MiSans 经 vpc:font-css 注入 <link>（打包内置、无运行时下载），主进程 require misans
    assert.match(sources, /vpc:font-css/);
    assert.match(sources, /require\(['"]\.\/misans['"]\)/);
    // 无运行时下载就绪事件（内置无需异步 ready）；画中画钩子仍保持移除
    assert.doesNotMatch(sources, /onFontReady|vpc:font-ready/);
    assert.doesNotMatch(sources, /pipOpen|pipClose|vpc:pip-open|vpc:pip-close|set_pip_/);
});

test('2A/T61: MiSans-first font stack and navigation order are explicit', () => {
    const css = read('src/renderer/css/ui.css');

    // T61：字体栈 MiSans 优先、回退 system-ui（打包内置）
    assert.match(css, /font-family:\s*MiSans,\s*system-ui/);
    assert.match(css, /\.main-nav-item\[data-view="settings"\]\s*\{\s*order:98;/);
    assert.match(css, /\.nav-collapse-btn\s*\{\s*order:99;/);
});

test('2.4/2.8/2.9/2.10/2.11/3.1/3.2/4.1: 新增设置控件与镜像开关存在于界面', () => {
    const html = read('src/renderer/index.html');
    const need = [
        'set_startup_view',    // 2.10 启动页面
        'set_error_toast',     // 2.8 错误提示开关
        'set_use_misans',      // 2.11 MiSans 字体开关
        'set_proxy_url',       // 2.9 代理地址
        'set_proxy_enable',    // 2.9 代理开关
        'set_dl_split',        // 2.4 分片并发
        'bangumi_token_link',  // 3.1 获取 token 链接
        'bangumi_sync_priority', // 3.1 同步优先级
        'bangumi_immediate_toast', // 3.1 即时同步提示
        'bangumi_sync_now',    // 3.1 立即同步
        'webdav_enable',       // 3.2 WebDAV 主开关
        'webdav_enable_history', // 3.2 观看记录同步
        'webdav_enable_collect', // 3.2 收藏同步
        'webdav_save',         // 3.2 保存配置
        'set_bangumi_mirror',  // 4.1 Bangumi 镜像
        'set_git_mirror',      // 4.1 规则仓库镜像
        'search-tabs',         // 2.3 搜索页签
        'image-search-panel',  // 2.3 以图搜番
        'popular-tags',        // 2.1 推荐标签
        'log-clear',           // 2.7 清空日志
    ];
    for (const id of need) {
        assert.match(html, new RegExp(`id="${id}"`), `缺少控件 #${id}`);
    }
});
