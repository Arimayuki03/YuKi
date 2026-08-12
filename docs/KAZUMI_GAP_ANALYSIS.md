# Kazumi 功能整合差距分析

> - 版本：v2.2（2026-08-10）
> - 基于 Kazumi v2.2.6 源码（lib/ 321 个文件）与 video-pc 当前实现对比。
> - 标记：✅ 已实现，⚠️ 部分实现，⏸ 产品范围外或暂缓，❌ 当前范围内未实现。
> - “Kazumi 接入完成”指既定双引擎接入范围完成，不代表与 Flutter 原版 1:1 等价。

## 当前结论

- 规则、搜索、播放解析、下载、Bangumi、WebDAV、SyncPlay、DLNA 和主要页面均已接入。
- 弹幕产品功能已明确关闭；保留的 DanDanPlay/ASS 代码属于兼容基础，不列入当前待办。
- 主要剩余工作是验证码自动化（暂不交付）、跨平台验证、代码签名、自动更新和 CI/CD。
- 按当前产品范围统计，87 项中 79 项完成、3 项部分完成、5 项延后，完成率约 91%。

---

## 1. 核心规则系统（规则/插件引擎）

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 规则模型（Plugin） | ✅ 完整 schema | ✅ 已实现（api≤8 校验，字段完整） | 无 |
| XPath 策略 | ✅ lxml，相对节点查询，URL 归一化 | ✅ 已实现 | 无 |
| API 策略（JSONPath） | ✅ 受限 JSONPath，模板渲染 | ✅ 已实现（jsonpath-ng） | 无 |
| 规则搜索 | ✅ RuleEngine 编排，并发查询 | ✅ 已实现（ThreadPoolExecutor，并行度 5） | 无 |
| 规则剧集解析 | ✅ chapterRoads/chapterResult 解析 | ✅ 已实现 | 无 |
| 规则管理 | ✅ PluginsController（CRUD/启用禁用/持久化） | ✅ 已实现（PluginManager） | 无 |
| 规则导入/导出 | ✅ kazumi:// base64 分享链接 | ✅ 已实现（粘贴导入） | 无 |
| 内置默认规则 | ✅ assets/plugins/ 3 个规则 | ✅ 已实现（首次启动自动导入） | 无 |
| 在线规则商店 | ✅ KazumiRules 仓库浏览/安装/更新 | ✅ 已实现（GitHub/GitCode 镜像） | 无 |
| 规则编辑器 | ✅ PluginEditorPage | ✅ 已实现（可视化表单编辑 + 保存/测试） | 无 |
| 规则测试 | ✅ PluginTestPage | ✅ 已实现（编辑器内置测试按钮） | 无 |
| 规则有效性追踪 | ✅ PluginValidityTracker | ✅ 已实现（后台并发搜索测试关键词，标记 valid/invalid/captcha，UI 徽标） | 无 |
| 规则安装时间追踪 | ✅ PluginInstallTimeTracker | ✅ 已实现（installedAt/updatedAt 持久化，列表悬停展示） | 无 |
| 规则批量更新 | ✅ 4 并发批量更新 | ✅ 已实现（后台 4 并发商店检查+版本比较+更新） | 无 |

---

## 2. 视频源获取机制

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 番剧源（站点/线路） | ✅ 规则搜索得到番剧详情页 URL | ✅ 已实现 | 无 |
| 剧集源（播放页） | ✅ chapterResult 提取剧集播放页 URL | ✅ 已实现 | 无 |
| 真实视频流提取 | ✅ 无头 WebView 三机制 | ✅ 已实现（webRequest 拦截媒体请求 + JS 注入轮询 video 元素 + 旧解析器 iframe 监听三机制） | 无 |
| 旧解析器（useLegacyParser） | ✅ iframe src 监听 | ✅ 已实现（useLegacyParser 规则走 iframe src 监听并跟随，限深防环） | 无 |
| 广告过滤（adBlocker） | ✅ HLS 广告过滤 | ✅ 已实现（m3u8 下载前过滤 CUE-OUT/CUE-IN + 广告路径分段，设置项开关） | 无 |
| 验证码反爬 | ✅ AntiCrawlerConfig | ⚠️ 已实现（T74：搜索页/选源弹窗源卡标记「需验证」，点击打开可见验证窗口供手动过验证，关闭后收割 Cookie 并自动重查该源） | 仍为手动过验证；自动验证（图片码/点击/脚本三型）暂不交付 |
| Cookie 管理 | ✅ PluginCookieManager | ✅ 已实现（CookieJar 落盘 kazumi/cookies.json，解析会话 Cookie 回传，规则引擎请求自动带上，设置页查看/清除） | 无 |
| 视频源解析池 | ✅ VideoSourceResolverPool | ✅ 已实现（3 独立 partition 槽位并发解析，互不冲突） | 无 |

---

## 3. 番剧元数据（Bangumi API）

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 番剧搜索 | ✅ bangumiSearch | ✅ 已实现 | 无 |
| 番剧详情 | ✅ getBangumiInfoByID | ✅ 已实现 | 无 |
| 番剧封面/简介/评分 | ✅ 完整展示 | ✅ 已实现（统一详情页头部：封面/标题/评分/日期） | 无 |
| 番剧时间表 | ✅ getCalendar + 季度检索/季节索引/排序/收藏过滤 | ✅ 已实现（timeline.js：本周放送 + 近 20 年季度检索、热度/评分/播出排序、收藏过滤、排名角标） | 无 |
| 番剧榜单 | ✅ getBangumiTrendsList | ✅ 已实现（bangumi_trends 端点） | 无 |
| 番剧关联 | ✅ getBangumiRelationsByID | ✅ 已实现（统一详情页关联页签） | 无 |
| 番剧分集信息 | ✅ getBangumiEpisodeByID | ✅ 已实现（统一详情页分集页签/Bangumi-only 概览分集） | 无 |
| 番剧评论 | ✅ getBangumiCommentsByID | ✅ 已实现（统一详情页吐槽页签） | 无 |
| 角色/Staff | ✅ getBangumiStaffByID / getCharatersByBangumiID | ✅ 已实现（统一详情页角色/制作页签） | 无 |
| 用户收藏同步 | ✅ updateBangumiById | ✅ 已实现（设置页 Bangumi 同步卡：token 管理/测试连接/我的收藏/删除；统一详情页收藏按钮同步；T74 收藏写入走 POST/PUT × `-`/真实用户名 × 官方/镜像矩阵） | 无 |

---

## 4. 播放器与媒体服务

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 播放器 | ✅ media_kit（mpv/libmpv） | ✅ 已实现（mpv 独立窗口） | 无 |
| 硬件加速 | ✅ 支持 | ✅ 已实现 | 无 |
| 高刷适配 | ✅ 支持 | ✅ 已实现 | 无 |
| 倍速播放 | ✅ 支持 | ✅ 已实现 | 无 |
| 播放位置记忆 | ✅ 支持 | ✅ 已实现（watch-later） | 无 |
| 自动连播 | ✅ 支持 | ✅ 已实现（渲染层驱动） | 无 |
| Anime4K 超分 | ✅ 三档位 | ✅ 已实现（三档位） | 无 |
| 外部播放器 | ✅ MethodChannel | ✅ 已实现（VLC 自动探测 + 自定义路径 + Referer 注入） | 无 |
| 画中画（PiP） | ✅ Android PiP + 桌面 mini 窗 | ✅ 已实现（无边框置顶 mini 窗 320x180） | 无 |
| 截屏 | ✅ PlayerScreenshotService | ✅ 已实现（mpv screenshot-to-file，快捷键 s 存图，settings 打开截图目录） | 无 |
| 定时关机 | ✅ TimedShutdownService | ✅ 已实现（N 分钟倒计时 → 停 mpv → 系统关机） | 无 |
| DLNA 投屏 | ✅ dlna_dart | ✅ 已实现（UPnP SSDP 发现 + SetAVTransportURI/Play/Stop） | 无 |
| 音频会话 | ✅ audio_service / audio_session | ❌ 未实现（桌面端无系统媒体控制器） | 可后续补充 |
| 弹幕渲染 | ✅ canvas_danmaku | ⏸ 产品功能关闭，保留 ASS/API 基础 | 不列入当前待办 |

---

## 5. 弹幕系统

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 弹幕 API | ✅ DanDanPlay 开放平台 | ✅ 保留兼容实现（HMAC-SHA256 签名） | 产品未启用 |
| 弹幕签名 | ✅ HMAC-SHA256 | ✅ 已实现 | 产品未启用 |
| 弹幕数据模型 | ✅ DanmakuEntry / DanmakuEpisodeResponse | ✅ 已实现 | 产品未启用 |
| 弹幕渲染 | ✅ canvas_danmaku | ⏸ 产品范围外 | 不列入当前待办 |
| 弹幕开关/速度 | ✅ PlayerDanmakuController | ⏸ 产品范围外 | 不列入当前待办 |
| 离线弹幕 | ✅ 下载时缓存弹幕 JSON | ⏸ 产品范围外 | 不列入当前待办 |
| 弹幕屏蔽 | ✅ 屏蔽词列表 | ⏸ 产品范围外 | 不列入当前待办 |

---

## 6. 下载系统

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 下载管理 | ✅ DownloadManager | ✅ 已实现（aria2c + HLS 合成） | 无 |
| M3U8 下载 | ✅ 分段下载 + 广告过滤 + 断点续传 | ✅ 已实现（ffmpeg 合成） | 无 |
| 直接下载 | ✅ Range 断点续传 | ✅ 已实现（aria2c） | 无 |
| 下载通知 | ✅ flutter_foreground_task | ✅ 已实现（系统通知） | 无 |
| 下载记录 | ✅ DownloadRecord / DownloadEpisode | ✅ 已实现（dl-records.json 持久化，跨重启恢复，删除/清除同步） | 无 |
| 弹幕缓存 | ✅ 下载时缓存弹幕 | ⏸ 产品范围外 | 不列入当前待办 |

---

## 7. 同步服务

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| WebDAV 同步 | ✅ webdav_client | ✅ 已实现（收藏/历史/规则上传/恢复） | 无 |
| Bangumi 同步 | ✅ BangumiSyncService | ✅ 已实现（Access Token 收藏同步：统一详情页追番 + 设置页收藏管理） | 无 |
| 一起看（SyncPlay） | ✅ SyncPlay 协议客户端 | ✅ 已实现（TCP+TLS，Hello/State/Set/Chat 协议） | 无 |
| 跨设备同步 | ✅ WebDAV + Bangumi | ✅ 已实现（WebDAV 收藏/历史 + Bangumi 收藏双向同步） | 无 |

---

## 8. WebView 子系统

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 视频源解析 WebView | ✅ 多平台实现 | ✅ 已实现（Electron BrowserWindow 三机制：webRequest 拦截 + JS 注入轮询 + iframe 监听） | 无 |
| 验证码 WebView | ✅ CaptchaWebviewController | ⚠️ 基础识别 + 手动过验证 | 需自动过验证 |
| 异步会话 | ✅ AsyncSession / AsyncSerialQueue / AsyncSingleFlight | ✅ 已实现（AsyncSingleFlight 同 key 并发去重 / AsyncSerialQueue FIFO 串行，接入 captureDirect 去重） | 无 |

---

## 9. 页面与 UI

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 首页 | ✅ PopularPage | ✅ 已实现（CatVod 首页 + 「推荐」Bangumi 趋势榜，T62） | 无 |
| 番剧时间表 | ✅ TimelinePage | ✅ 已实现（timeline.js + Bangumi API：本周放送、近 20 年季节索引、排序、收藏过滤、排名/评分展示、统一详情页） | 无 |
| 追番列表 | ✅ CollectPage | ✅ 已实现（收藏进度追踪 + 进度条） | 无 |
| 我的 | ✅ MyPage（观看统计 + 最近观看） | ✅ 已实现（观看统计 + 我的收藏；最近观看并入左侧历史页，T58 移除） | 无 |
| 搜索 | ✅ SearchPage | ✅ 已实现（聚合搜索） | 无 |
| 以图搜番 | ✅ ImageSearchPage | ✅ 已实现（URL/base64 上传） | 无 |
| 详情页 | ✅ InfoPage | ✅ 已实现（T74 统一详情页 #view-detail：CatVod 源/Bangumi-only 自适应，概览/分集/角色/评论/关联/制作，收藏同步 + 开始观看；原 #view-bangumi-info 已移除） | 无 |
| 播放页 | ✅ VideoPage | ✅ 已实现（mpv 独立窗口；弹幕不在当前产品范围） | 无 |
| 下载页 | ✅ DownloadPage | ✅ 已实现（下载管理） | 无 |
| 历史页 | ✅ HistoryPage | ✅ 已实现（历史记录） | 无 |
| 设置页 | ✅ SettingsPage | ✅ 已实现（设置中心 + Kazumi 规则板块 + WebDAV 同步） | 无 |
| 规则编辑器 | ✅ PluginEditorPage | ✅ 已实现（可视化表单编辑 + 测试） | 无 |
| 规则商店 | ✅ PluginShopPage | ✅ 已实现（在线商店弹窗） | 无 |
| 首次引导 | ✅ OnboardingPage | ✅ 已实现（欢迎弹窗 + 快速上手指南） | 无 |
| 日志查看 | ✅ LogsPage | ✅ 已实现（分页日志查看器弹窗） | 无 |
| 关于页 | ✅ AboutPage | ✅ 已实现（独立视图：应用标识/版本/技术栈/致谢/系统信息） | 无 |

---

## 10. 主题与国际化

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 主题色 | ✅ 动态色 + 预设主题 | ✅ 已实现（6 套内置 + 自定义） | 无 |
| 明暗模式 | ✅ auto/light/dark | ✅ 已实现 | 无 |
| 壁纸 | ✅ 支持 | ✅ 已实现 | 无 |
| 字体 | ✅ MiSans 内置 | ✅ 已实现（download-binaries misans 下载子集化 woff2，未就绪回退系统字体） | 无 |
| 国际化 | ✅ 仅简体中文 | ✅ 已实现（硬编码中文） | 无 |

---

## 11. 平台配置

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 平台支持 | ✅ Android/Windows/macOS/Linux/iOS/HarmonyOS | ⚠️ Windows（Electron 跨平台但未测 macOS/Linux） | 需多平台测试 |
| 代码签名 | ✅ SignPath | ❌ 未实现 | 可后续补充 |
| 自动更新 | ✅ upgrader | ❌ 未实现 | 可后续补充 |
| CI/CD | ✅ GitHub Actions | ❌ 未实现 | 可后续补充 |

---

## 12. 测试与 CI

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 单元测试 | ✅ 16 个测试文件 | ✅ 已实现（55 个 Kazumi 测试 + smoke 13 + phase3 25） | 无 |
| 组件测试 | ✅ widget 测试 | ✅ 已实现（node --test 27 个 JS 单测：downloader/mpv-player/hls-filter/dl-record） | 无 |
| CI | ✅ pr.yaml / release.yaml | ❌ 未实现 | 可后续补充 |

---

## 13. 原优先级结果

以下是整合阶段使用过的优先级清单。当前待办以 [../PROGRESS.md](../PROGRESS.md) 为准。

### 高优先级
1. **番剧时间表**：Bangumi 每日放送。✅ 已实现
2. **追番列表**：收藏 + 观看进度追踪。✅ 已实现
3. **完整详情页**：Bangumi 番剧详情（角色/评论/关联/制作人员）。✅ 已实现
4. **弹幕系统**：API 与基础代码已接入；产品功能后来明确关闭，不再继续补渲染引擎。
5. **以图搜番**：trace.moe 图片识别。✅ 已实现

### 中优先级（已完成）
6. **规则编辑器**：可视化编辑 XPath/JSONPath。✅ 已实现
7. **规则测试面板**：测试规则搜索/剧集解析。✅ 已实现
8. **WebDAV 同步**：跨设备收藏/历史同步。✅ 已实现
9. **一起看（SyncPlay）**：多人同步播放。✅ 已实现
10. **DLNA 投屏**：投屏到电视。✅ 已实现

### 低优先级（已完成）
11. **外部播放器**：VLC 自动探测 + 自定义路径 + Referer 注入。✅ 已实现
12. **画中画**：桌面 mini 窗（无边框置顶 320x180）。✅ 已实现
13. **定时关机**：N 分钟倒计时 → 停 mpv → 系统关机。✅ 已实现
14. **日志查看器**：分页查看应用日志。✅ 已实现
15. **首次引导**：新用户向导。✅ 已实现

---

## 14. 技术债务与风险

1. **弹幕兼容代码**：若未来重新启用弹幕，需要申请 `DANDANAPI_APPID`/`DANDANAPI_KEY` 并重新评估渲染方案；当前不属于产品待办。
2. **Bangumi 镜像签名**：Bangumi 镜像 API 的签名端点（KAZUMI_APPID/KAZUMI_KEY）未申请前部分端点不可用；用户收藏同步走的是 Access Token（已接入）。
3. **验证码自动过验证**：当前仅实现手动过验证，自动过验证复杂度高。
4. **Cookie 持久化**：已实现（验证后 Cookie 落盘，重启复用）；但仅覆盖解析会话，验证码页需再次手动过验证时自动过验证未覆盖。
5. **视频源解析池**：已实现（3 槽位独立 partition 并发解析）；前端批量解析仍串行，池为并发预留。
6. **弹幕渲染**：mpv 独立窗口无法直接叠加前端弹幕。该功能当前关闭，只有重新进入产品范围时才需要设计额外渲染层。
7. **未捕获异常兜底**：已添加全局 process.on('uncaughtException') 兜底防进程崩溃。
8. **HLS 广告过滤**：下载路径已实现（CUE-OUT/CUE-IN + 广告路径分段，设置开关）；播放路径（mpv 实时过滤）未实现。

---

## 15. 功能统计

| 类别 | 已完成 | 部分实现 | 延后 | 范围外 |
|------|--------|---------|------|--------|
| 核心规则系统 | 14 | 0 | 0 | 0 |
| 视频源获取 | 7 | 1 | 0 | 0 |
| 番剧元数据 | 10 | 0 | 0 | 0 |
| 播放器与媒体 | 11 | 0 | 1 | 1 |
| 弹幕系统 | 3 | 0 | 0 | 4 |
| 下载系统 | 5 | 0 | 0 | 1 |
| 同步服务 | 4 | 0 | 0 | 0 |
| WebView | 2 | 1 | 0 | 0 |
| 页面与 UI | 16 | 0 | 0 | 0 |
| 主题与国际化 | 5 | 0 | 0 | 0 |
| 平台配置 | 0 | 1 | 3 | 0 |
| 测试与 CI | 2 | 0 | 1 | 0 |
| **合计** | **79** | **3** | **5** | **6** |

> 当前产品范围排除 6 个弹幕相关项目，剩余 87 项中完成 79 项，完成率约 91%。“延后”主要是桌面音频会话、签名、自动更新和 CI/CD；“部分实现”主要是验证码自动化与跨平台验证。

---

*本文档基于 Kazumi v2.2.6 源码（lib/ 321 个文件）与 video-pc 当前实现对比整理。*
