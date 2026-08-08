# Kazumi 功能整合差距分析

> 版本：v1.0（2026-08-09）  
> 基于 Kazumi v2.2.6 源码（lib/ 321 个文件）与 video-pc 当前实现对比。  
> 已整合功能标记 ✅，未整合标记 ❌，部分整合标记 ⚠️。

---

## 1. 核心规则系统（规则/插件引擎）

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 规则模型（Plugin） | ✅ 完整 schema（api/type/name/version/muliSources/useWebview/useNativePlayer/usePost/useLegacyParser/adBlocker/userAgent/baseURL/searchURL/searchList/searchName/searchResult/chapterRoads/chapterResult/referer/searchMode/chapterMode/searchApiConfig/chapterApiConfig/antiCrawlerConfig） | ✅ 已实现（api≤8 校验，字段完整） | 无 |
| XPath 策略 | ✅ 完整实现（lxml，相对节点查询，URL 归一化） | ✅ 已实现 | 无 |
| API 策略（JSONPath） | ✅ 受限 JSONPath（$ . [index\|*\|'key']），模板渲染 | ✅ 已实现（jsonpath-ng） | 无 |
| 规则搜索 | ✅ RuleEngine 编排，并发查询 | ✅ 已实现（ThreadPoolExecutor，并行度 5） | 无 |
| 规则剧集解析 | ✅ chapterRoads/chapterResult 解析 | ✅ 已实现 | 无 |
| 规则管理 | ✅ PluginsController（CRUD/启用禁用/持久化） | ✅ 已实现（PluginManager） | 无 |
| 规则导入/导出 | ✅ kazumi:// base64 分享链接 | ✅ 已实现（粘贴导入） | 无 |
| 内置默认规则 | ✅ assets/plugins/ 3 个规则（7sefun/DM84/enlie） | ✅ 已实现（首次启动自动导入） | 无 |
| 在线规则商店 | ✅ KazumiRules 仓库浏览/安装/更新 | ✅ 已实现（GitHub/GitCode 镜像） | 无 |
| 规则编辑器 | ✅ PluginEditorPage（可视化编辑规则） | ❌ 未实现 | 需可视化编辑器 |
| 规则测试 | ✅ PluginTestPage（测试规则搜索/剧集） | ❌ 未实现 | 需测试面板 |
| 规则有效性追踪 | ✅ PluginValidityTracker（搜索有效集合） | ❌ 未实现 | 可后续补充 |
| 规则安装时间追踪 | ✅ PluginInstallTimeTracker | ❌ 未实现 | 可后续补充 |
| 规则批量更新 | ✅ 4 并发批量更新 | ❌ 未实现 | 可后续补充 |

---

## 2. 视频源获取机制

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 番剧源（站点/线路） | ✅ 规则搜索得到番剧详情页 URL | ✅ 已实现 | 无 |
| 剧集源（播放页） | ✅ chapterResult 提取剧集播放页 URL | ✅ 已实现 | 无 |
| 真实视频流提取 | ✅ 无头 WebView 三机制（拦截 m3u8/Range 请求 + JS 注入钩住 fetch/XHR + 扫描 video 标签 + 1s 轮询） | ⚠️ 复用现有 captureDirect（单机制：拦截媒体请求） | 需增强 JS 注入与轮询兜底 |
| 旧解析器（useLegacyParser） | ✅ iframe src 监听 + decodeVideoSource | ❌ 未实现 | 可后续补充 |
| 广告过滤（adBlocker） | ✅ HLS 广告过滤 | ❌ 未实现 | 可后续补充 |
| 验证码反爬 | ✅ AntiCrawlerConfig（图片/自动点击/自定义 JS） | ⚠️ 基础识别 + 手动过验证 | 需自动过验证流程 |
| Cookie 管理 | ✅ PluginCookieManager（验证后保存 Cookie） | ❌ 未实现 | 需 Cookie 持久化 |
| 视频源解析池 | ✅ VideoSourceResolverPool（1-5 worker，single-flight） | ❌ 未实现（复用现有单窗口） | 可后续补充 |

---

## 3. 番剧元数据（Bangumi API）

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 番剧搜索 | ✅ bangumiSearch | ✅ 已实现 | 无 |
| 番剧详情 | ✅ getBangumiInfoByID | ✅ 已实现 | 无 |
| 番剧封面/简介/评分 | ✅ 完整展示 | ✅ 已实现（Kazumi 源弹窗顶部横幅） | 无 |
| 番剧时间表 | ✅ getCalendar / getCalendarBySearch | ❌ 未实现 | 需新增页面 |
| 番剧榜单 | ✅ getBangumiList / getBangumiTrendsList | ❌ 未实现 | 需新增页面 |
| 番剧关联 | ✅ getBangumiRelationsByID（前传/续作链） | ❌ 未实现 | 可后续补充 |
| 番剧分集信息 | ✅ getBangumiEpisodeByID | ❌ 未实现 | 可后续补充 |
| 番剧评论 | ✅ getBangumiCommentsByID | ❌ 未实现 | 可后续补充 |
| 角色/Staff | ✅ getBangumiStaffByID / getCharatersByBangumiID | ❌ 未实现 | 可后续补充 |
| 用户收藏同步 | ✅ updateBangumiById / addOrUpdateBangumiEvaluationBySubjectID | ❌ 未实现 | 需 Bangumi token |

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
| Anime4K 超分 | ✅ 三档位（efficiency/quality/restore） | ✅ 已实现（三档位） | 无 |
| 外部播放器 | ✅ MethodChannel 启动外部播放器 | ❌ 未实现 | 可后续补充 |
| 画中画（PiP） | ✅ Android PiP + 桌面 mini 窗 | ❌ 未实现 | 可后续补充 |
| 截屏 | ✅ PlayerScreenshotService | ❌ 未实现 | 可后续补充 |
| 定时关机 | ✅ TimedShutdownService | ❌ 未实现 | 可后续补充 |
| DLNA 投屏 | ✅ dlna_dart | ❌ 未实现 | 可后续补充 |
| 音频会话 | ✅ audio_service / audio_session | ❌ 未实现 | 可后续补充 |
| 弹幕渲染 | ✅ canvas_danmaku | ❌ 未实现（占位） | 需弹幕引擎 |

---

## 5. 弹幕系统

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 弹幕 API | ✅ DanDanPlay 开放平台（api.dandanplay.net） | ❌ 未实现（占位） | 需签名密钥（DANDANAPI_APPID/DANDANAPI_KEY） |
| 弹幕签名 | ✅ HMAC-SHA256 | ❌ 未实现 | 需实现签名算法 |
| 弹幕数据模型 | ✅ DanmakuEntry / DanmakuEpisodeResponse | ❌ 未实现 | 需数据模型 |
| 弹幕渲染 | ✅ canvas_danmaku | ❌ 未实现 | 需弹幕渲染引擎 |
| 弹幕开关/速度 | ✅ PlayerDanmakuController | ❌ 未实现 | 可后续补充 |
| 离线弹幕 | ✅ 下载时缓存弹幕 JSON | ❌ 未实现 | 可后续补充 |
| 弹幕屏蔽 | ✅ 屏蔽词列表 | ❌ 未实现 | 可后续补充 |

---

## 6. 下载系统

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 下载管理 | ✅ DownloadManager（队列/并发/暂停/恢复/取消） | ✅ 已实现（aria2c + HLS 合成） | 无 |
| M3U8 下载 | ✅ 分段下载 + 广告过滤 + 断点续传 | ✅ 已实现（ffmpeg 合成） | 无 |
| 直接下载 | ✅ Range 断点续传 | ✅ 已实现（aria2c） | 无 |
| 下载通知 | ✅ flutter_foreground_task（Android 前台） | ✅ 已实现（系统通知） | 无 |
| 下载记录 | ✅ DownloadRecord / DownloadEpisode | ❌ 未实现（无持久化下载记录） | 可后续补充 |
| 弹幕缓存 | ✅ 下载时缓存弹幕 | ❌ 未实现 | 可后续补充 |

---

## 7. 同步服务

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| WebDAV 同步 | ✅ webdav_client | ❌ 未实现 | 需 WebDAV 配置与同步逻辑 |
| Bangumi 同步 | ✅ BangumiSyncService | ❌ 未实现 | 需 Bangumi token |
| 一起看（SyncPlay） | ✅ SyncPlay 协议客户端 | ❌ 未实现 | 需 SyncPlay 协议实现 |
| 跨设备同步 | ✅ WebDAV + Bangumi | ❌ 未实现 | 可后续补充 |

---

## 8. WebView 子系统

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 视频源解析 WebView | ✅ 多平台实现（Windows/Linux/macOS/iOS/Android） | ⚠️ 复用现有 captureDirect（Electron BrowserWindow） | 需增强 JS 注入 |
| 验证码 WebView | ✅ CaptchaWebviewController（三平台实现） | ⚠️ 基础识别 + 手动过验证 | 需自动过验证 |
| 异步会话 | ✅ AsyncSession / AsyncSerialQueue / AsyncSingleFlight | ❌ 未实现 | 可后续补充 |

---

## 9. 页面与 UI

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 首页 | ✅ PopularPage（无限滚动番剧网格 + 标签下拉） | ✅ 已实现（CatVod 首页） | 无 |
| 番剧时间表 | ✅ TimelinePage（星期 TabBar + 季度选择） | ❌ 未实现 | 需新增页面 |
| 追番列表 | ✅ CollectPage（WebDAV/Bangumi 同步） | ❌ 未实现 | 需新增页面 |
| 我的 | ✅ MyPage（观看统计 + 最近观看） | ❌ 未实现 | 需新增页面 |
| 搜索 | ✅ SearchPage（多源搜索 + 历史 + 标签） | ✅ 已实现（聚合搜索） | 无 |
| 以图搜番 | ✅ ImageSearchPage（trace.moe） | ❌ 未实现（占位） | 需图片上传与识别 |
| 详情页 | ✅ InfoPage（概览/吐槽/角色/关联/制作人员） | ⚠️ 部分实现（CatVod 详情 + Kazumi 源弹窗横幅） | 需完整详情页 |
| 播放页 | ✅ VideoPage（弹幕画布 + 集/路切换 + 一起看） | ⚠️ 部分实现（mpv 独立窗口，无弹幕/一起看） | 需弹幕与一起看 |
| 下载页 | ✅ DownloadPage（记录卡片 + 速度/状态） | ✅ 已实现（下载管理） | 无 |
| 历史页 | ✅ HistoryPage（续播 + 删除） | ✅ 已实现（历史记录） | 无 |
| 设置页 | ✅ SettingsPage（播放/资源/应用/其他） | ✅ 已实现（设置中心） | 无 |
| 规则编辑器 | ✅ PluginEditorPage | ❌ 未实现 | 需可视化编辑器 |
| 规则商店 | ✅ PluginShopPage | ✅ 已实现（在线商店） | 无 |
| 首次引导 | ✅ OnboardingPage（免责声明→镜像→规则商店） | ❌ 未实现 | 可后续补充 |
| 日志查看 | ✅ LogsPage（分页日志查看器） | ❌ 未实现 | 可后续补充 |
| 关于页 | ✅ AboutPage（缓存清理 + 退出行为 + 更新源） | ⚠️ 部分实现（设置页系统板块） | 可后续补充 |

---

## 10. 主题与国际化

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 主题色 | ✅ 动态色 + 预设主题 | ✅ 已实现（6 套内置 + 自定义） | 无 |
| 明暗模式 | ✅ auto/light/dark | ✅ 已实现 | 无 |
| 壁纸 | ✅ 支持 | ✅ 已实现 | 无 |
| 字体 | ✅ MiSans 内置 | ❌ 未实现（系统字体） | 可后续补充 |
| 国际化 | ✅ 仅简体中文 | ✅ 已实现（硬编码中文） | 无 |

---

## 11. 平台配置

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 平台支持 | ✅ Android/Windows/macOS/Linux/iOS/HarmonyOS | ⚠️ Windows（Electron 跨平台但未测 macOS/Linux） | 需多平台测试 |
| 代码签名 | ✅ SignPath（Windows） | ❌ 未实现 | 可后续补充 |
| 自动更新 | ✅ upgrader | ❌ 未实现 | 可后续补充 |
| CI/CD | ✅ GitHub Actions | ❌ 未实现 | 可后续补充 |

---

## 12. 测试与 CI

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 单元测试 | ✅ 16 个测试文件 | ✅ 已实现（32 个 Kazumi 测试） | 无 |
| 组件测试 | ✅ widget 测试 | ❌ 未实现 | 可后续补充 |
| CI | ✅ pr.yaml / release.yaml | ❌ 未实现 | 可后续补充 |

---

## 13. 优先级建议

### 高优先级（建议下期实现）
1. **番剧时间表**：Bangumi 每日放送，用户追番必备。
2. **追番列表**：收藏 + 观看进度追踪，与现有收藏/历史合并。
3. **完整详情页**：Bangumi 番剧详情（角色/评论/关联）。
4. **弹幕系统**：弹弹 play API（需申请签名密钥）。
5. **以图搜番**：trace.moe 图片识别。

### 中优先级（可后续补充）
6. **规则编辑器**：可视化编辑 XPath/JSONPath。
7. **规则测试面板**：测试规则搜索/剧集解析。
8. **WebDAV 同步**：跨设备收藏/历史同步。
9. **一起看（SyncPlay）**：多人同步播放。
10. **DLNA 投屏**：投屏到电视。

### 低优先级（可选）
11. **外部播放器**：调用系统播放器。
12. **画中画**：桌面 mini 窗。
13. **定时关机**：播放完成后关机。
14. **日志查看器**：分页查看应用日志。
15. **首次引导**：新用户向导。

---

## 14. 技术债务与风险

1. **弹幕签名密钥**：弹弹 play API 需申请 DANDANAPI_APPID/DANDANAPI_KEY，未申请前无法实现弹幕。
2. **Bangumi 镜像签名**：Bangumi 镜像 API 需 KAZUMI_APPID/KAZUMI_KEY，未申请前部分端点不可用。
3. **验证码自动过验证**：当前仅实现手动过验证，自动过验证（图片识别/自动点击）复杂度高。
4. **Cookie 持久化**：验证后 Cookie 未持久化，重启后需重新验证。
5. **视频源解析池**：当前复用单窗口 captureDirect，并发解析时可能冲突。

---

*本文档基于 Kazumi v2.2.6 源码（lib/ 321 个文件）与 video-pc 当前实现对比整理。*
