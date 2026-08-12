# 侦查记录 A — 推荐页 / 直播页 / 搜索载入条

来源：explore agent `bg_4a540dfe`（只读，未改动文件）

## 推荐页（热门番组）

- 视图全部在 `src/renderer/js/popular.js`（169 行），DOM 外壳 `src/renderer/index.html:146-158`。
- 导航项 `index.html:40-42`（`data-view="popular"`）；`app.js:35` → `Popular.enter()`；`app.js:202` → `Popular.preload()`。
- **点击卡片不会弹标签**：`popular.js:36-43` → `kazumi.js:1304 openBangumiInfoPage()` → `detail.js:146 Detail.openBangumi()`。
- **标签弹窗挂在工具栏按钮上**：`popular.js:45` 绑定 `#popular-tag-btn` → `popular.js:130-148 _openTagDialog()`，填充 `#popular-tag-list` 的 `.popular-tag-option`，再 `openDialog('popularTagDialog')`。
- 附属物（改造时一并处理）：
  - 标签常量 `popular.js:13-16 POPULAR_TAGS`（15 个）
  - 弹窗 DOM `index.html:1089-1098`（`#popularTagDialog` / `#popular-tag-list`）
  - 弹窗选项样式 `ui.css:875-878`（`.popular-tag-option`）
- **本项目没有自定义下拉组件**，所有下拉都是原生 `<select class="md-select">` + `.on('change')`。
  - 基础样式 `ui.css:668-681`：`.md-select` 高 44px；`.view-toolbar .md-select` 高 40px / min-width 180px；`.md-select-sm` 高 32px
  - 最佳范例：`index.html:128-133` + `timeline.js:52-61`（change）、`timeline.js:100-119`（动态 option/optgroup 构建）
  - 其他范例：首页源 `index.html:86` + `home.js:49-51,129-135`；直播源 `index.html:163` + `live.js:45,132-141`；设置页约 20 个 select `index.html:355-808`
  - 备选 chip 风格 `.class-tab` `ui.css:688-695`（`live.js:314`、`timeline.js:43` 在用）
- **推荐页没有每页数量设置**：硬编码 `popular.js:18 POPULAR_PAGE_SIZE = 24`，用于 `popular.js:28 _size`，分页数学 `popular.js:86`、`popular.js:161-167`。`Popular` 从不调用 `pageSizeOf`。
- 现有 5 个 pageSize key 在 `common.js:423-441`：`PAGE_SIZE_OPTIONS = [10,16,20,24,36,60,120]`，`pageSizeOf(key)` 支持 `pageSizeHome / pageSizeSearch / pageSizeFavorites / pageSizeHistory / pageSizeLive`，未知值回退 20。
  - 消费方：`home.js:479-480`、`timeline.js:242`（均 pageSizeHome）、`search.js:197`、`records.js:368,510-511`、`live.js:151`
  - 设置 UI `index.html:412-474`（5 个 select）；载入 `panels.js:764-768`；保存 `panels.js:993-1001`；缓存失效 `common.js:444-447`
  - 新增 `pageSizePopular` 接线点：`index.html:413` 加 select、`panels.js:995` 注册、`panels.js:768` 恢复、`popular.js:28`/`load()` 改 `await pageSizeOf('pageSizePopular')`；24 已是合法选项

## 直播页

- 只有一个 `<select>`：`#live-select`（`index.html:161-170`）。频道分组是 chip 不是 select（`live.js:48-55` 点击、`live.js:309-319 renderGroups`）。
- change 处理 `live.js:45`；option 构建 `live.js:132-141`；回读 `live.js:146`。
- **`redirect` 在本仓库源码中不存在**。已 grep `src/`、`docs/`、`python-backend/`、`settings.json`；只有无关的 HTTP 重定向参数（`main/index.js:111`、`hls-downloader.js:32`、`ffmpeg.js:46-52`、`python-backend/app.py:27`）。`settings.customLives` 为 `[]`。
- 它来自远端 TVBox 配置：`settings.lastConfigUrl` 是多仓索引，子仓 `lives` 首项形如
  `{"group":"redirect","channels":[{"name":"live","urls":["proxy://do=live&type=txt&ext=<base64>"]}]}`，
  另一子仓是 `{"group":"redirect","channels":[{"name":"redirect",...}]}`。
- 扁平化 `live.js:100-141`：`live.js:109` 标签回退为 `c.name || l.name`，故两子仓分别产出 `live` 与 `redirect`。`normalizeLive`（`live.js:87-97`）负责 base64 解码 `proxy://do=live&ext=`。
- **默认选中是隐式的**：无 `.val(...)`、无 `selected` 属性，浏览器自动选 index 0，随后 `loadChannels()`（`live.js:141`）读 `$('#live-select').val()` → `"0"`。
- 后端合并顺序确定：`python-backend/config.py:248-262 _merge_lives`（主仓优先、按 url 去重）；`.video-pc/last_repo.txt` 目前锁定 `bizhangjie🈲1`，index 0 稳定是 redirect 项。
- **修改点**：在 `live.js:140` 与 `live.js:141` 之间插入默认索引选择。此处 `this.lives` 已规范化为 `{name,url}`；覆盖首次加载、配置变更（`app.js:179` 再调 `Live.load()`）与 `_dirty` 重入（`live.js:350-355`）。
- 「正在检测频道可用性 N/M」在 `_probeChannels`（`live.js:206-236`）三处，全部往 `#live-status` 写纯文本，**目前无进度条**：
  - `live.js:217` 初始 `0/${all.length}`
  - `live.js:231` 每批 50 个后更新 → 即 `1100/5860`
  - `live.js:235` 完成态「已过滤 N 个不可用频道」/「全部频道可用」，5s 后隐藏
  - 异常分支 `live.js:245`
- DOM `<span id="live-status" class="tip-line" style="display:none">`（`index.html:165`），样式 `ui.css:498-501`（`margin-left:auto;padding:0;flex:none;white-space:nowrap`）。
- 探测启动 `live.js:203`；IPC `preload.js:123 probeUrls` → `vpc:probe-urls`。`#live-status` 也被缓存命中提示复用（`live.js:190-193`），隐藏于 `live.js:153`。
- 注意：`#live-status` 在 `.view-toolbar` 内且 `margin-left:auto`，而 `.search-status` 是整宽 block，所以进度条应作为工具栏后的**新兄弟元素**，照抄首页做法。

## 搜索页载入条（要复用的那个）

- 复用目标是 `.search-status`，**不是** `#loadingToast`（`index.html:1116-1124` + `common.js:602-611` 全屏遮罩）。
- 空壳 DOM `index.html:119`：`<div id="search-status" class="search-status" style="display:none"></div>`。
- 内部结构由共享函数一次性生成：`common.js:613-641 renderStatusBar($el, opts)`，`opts = {text, recv, total, done, items, unit}`。
  - 结构 `.ss-spinner / .ss-text / .ss-bar > .ss-fill / .ss-count`，只创建一次，之后只改文字与宽度，spinner 动画不重置
  - `{recv, total}` 正好产出 `1100/5860` 并驱动 `.ss-fill` 宽度；不传 `total` 则为 indeterminate 滑动条
  - 显示/隐藏由调用方负责（`.show()` / `.hide()`）
- 完整 CSS `ui.css:747-766`（`.search-status` 与全部 `.ss-*`，含 `@keyframes sspin`、`@keyframes sslide`、`.done` 态），末尾 `#home-probe-bar { margin-top:8px; }`。
- 搜索页包装层 `search.js:143-191 _setStatus(text, opts)` 加了防闪烁：首个结果或 1s 后才显示（`search.js:157-175`）；`done:true` 渲染完成态再 1.5s 隐藏（`search.js:176-189`）。状态字段 `search.js:25-27`，`stop()` 重置 `search.js:133-141`，分页可见性守卫 `search.js:48-49`。调用点 `search.js:207,235,242,252,268,288,290,291,305,310,319,320`。
- **直播页应照抄首页**（已用同一条进度条做后台探测）：
  - `index.html:91` `<div id="home-probe-bar" class="search-status" style="display:none"></div>`
  - `home.js:193-205 _updateProbeBar(done)` 调 `renderStatusBar`
  - 生命周期 `home.js:147-164 _startProbe(total)`、`home.js:167-183 _endProbe()`、`home.js:186-191 _probeOneDone()`（同样 1s 显示延迟 / 1.5s 完成后隐藏）
  - 声明在 `home.js:44`；`renderStatusBar` 列在 `home.js:8` / `search.js:12` 的全局注释里——若在 live.js 使用需补到 `live.js:15`

## 验证

`package.json` 有 `scripts/check-js.js`；`tests/js/` 含 `popular-cache.test.js`、`timeline.test.js`、`home-probe.test.js`。`home-probe.test.js` 正好覆盖要镜像的进度条生命周期。
