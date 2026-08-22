/**
 * ESLint flat config —— 首轮零误伤策略：
 * - src/main、src/preload、scripts、tests：CommonJS/Node 环境，no-undef 全开
 * - src/renderer：浏览器 + jQuery 全局；跨文件互调的遗留全局函数显式声明在
 *   RENDERER_LEGACY_GLOBALS（D1 渲染层模块化完成后逐步清空）
 * 规则只开 no-undef / no-unused-vars，存量清零后再逐步收紧。
 */
const globals = require('globals');

// 渲染层跨文件遗留全局（无构建工具、<script> 顺序加载时代的互相调用）。
// 新代码禁止加入此列表；D1 命名空间化（YUKI.<module>.<fn>）迁移后逐个删除。
const RENDERER_LEGACY_GLOBALS = [
    // 页面对象/视图控制器
    'App', 'Home', 'Detail', 'Search', 'Timeline', 'Records', 'Kazumi',
    'BangumiSearch', 'Favorites', 'FavHub', 'Popular',
    // common.js 提供的工具函数
    'applySkin', 'vodCoverImg', 'vodCoverChain', 'bangumiCover', 'bangumiCoverImg',
    'bangumiMirrorUrl', 'truncateTitle', 'toFileUrl', 'openDialog', 'closeDialog',
    'confirmDialog', 'localCacheClearAll', 'setErrorToastEnabled', 'invalidatePageSizeCache',
    // 其他文件提供的跨页函数（按需补充）
    'localCacheGet', 'localCacheSet', 'localCacheDel', 'localCacheStats', 'localCachePrune',
].reduce((acc, name) => ({ ...acc, [name]: 'readonly' }), {});

module.exports = [
    {
        ignores: [
            'node_modules/**', 'dist/**', 'python-dist/**', 'python-dist-tmp/**',
            'vendor/**', 'build/**', 'python-backend/**', 'tmp/**',
            'src/renderer/js/jquery.min.js',   // 第三方压缩库（UMD 包装触发误报）
        ],
    },
    {
        files: ['src/main/**/*.js', 'src/preload/**/*.js', 'scripts/**/*.js', 'tests/js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
        },
    },
    {
        files: ['src/renderer/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'script',
            globals: { ...globals.browser, ...globals.jquery, ...RENDERER_LEGACY_GLOBALS },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
        },
    },
];
