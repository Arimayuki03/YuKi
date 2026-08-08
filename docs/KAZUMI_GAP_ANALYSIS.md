# Kazumi 功能整合差距分析

> 版本：v2.0（2026-08-09）  
> 基于 Kazumi v2.2.6 源码（lib/ 321 个文件）与 video-pc 当前实现对比。  
> 已整合功能标记 ✅，未整合标记 ❌，部分整合标记 ⚠️。  
> 全部 15 项优先级功能已完成（高 5 + 中 5 + 低 5）。

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
| 规则有效性追踪 | ✅ PluginValidityTracker | ❌ 未实现 | 可后续补充 |
| 规则安装时间追踪 | ✅ PluginInstallTimeTracker | ❌ 未实现 | 可后续补充 |
| 规则批量更新 | ✅ 4 并发批量更新 | ❌ 未实现 | 可后续补充 |

---

## 2. 视频源获取机制

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 番剧源（站点/线路） | ✅ 规则搜索得到番剧详情页 URL | ✅ 已实现 | 无 |
| 剧集源（播放页） | ✅ chapterResult 提取剧集播放页 URL | ✅ 已实现 | 无 |
| 真实视频流提取 | ✅ 无头 WebView 三机制 | ⚠️ 复用现有 captureDirect（单机制：拦截媒体请求） | 需增强 JS 注入与轮询兜底 |
| 旧解析器（useLegacyParser） | ✅ iframe src 监听 | ❌ 未实现 | 可后续补充 |
| 广告过滤（adBlocker） | ✅ HLS 广告过滤 | ❌ 未实现 | 可后续补充 |
| 验证码反爬 | ✅ AntiCrawlerConfig | ⚠️ 基础识别 + 手动过验证 | 需自动过验证流程 |
| Cookie 管理 | ✅ PluginCookieManager | ❌ 未实现 | 需 Cookie 持久化 |
| 视频源解析池 | ✅ VideoSourceResolverPool | ❌ 未实现（复用现有单窗口） | 可后续补充 |

---

## 3. 番剧元数据（Bangumi API）

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 番剧搜索 | ✅ bangumiSearch | ✅ 已实现 | 无 |
| 番剧详情 | ✅ getBangumiInfoByID | ✅ 已实现 | 无 |
| 番剧封面/简介/评分 | ✅ 完整展示 | ✅ 已实现（Kazumi 源弹窗顶部横幅） | 无 |
| 番剧时间表 | ✅ getCalendar | ✅ 已实现（timeline.js 独立页面） | 无 |
| 番剧榜单 | ✅ getBangumiTrendsList | ✅ 已实现（bangumi_trends 端点） | 无 |
| 番剧关联 | ✅ getBangumiRelationsByID | ✅ 已实现（详情弹窗关联页签） | 无 |
| 番剧分集信息 | ✅ getBangumiEpisodeByID | ✅ 已实现（详情弹窗分集页签） | 无 |
| 番剧评论 | ✅ getBangumiCommentsByID | ✅ 已实现（详情弹窗评论页签） | 无 |
| 角色/Staff | ✅ getBangumiStaffByID / getCharatersByBangumiID | ✅ 已实现（详情弹窗角色/制作页签） | 无 |
| 用户收藏同步 | ✅ updateBangumiById | ❌ 未实现 | 需 Bangumi token |

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
| 截屏 | ✅ PlayerScreenshotService | ❌ 未实现 | 可后续补充 |
| 定时关机 | ✅ TimedShutdownService | ✅ 已实现（N 分钟倒计时 → 停 mpv → 系统关机） | 无 |
| DLNA 投屏 | ✅ dlna_dart | ✅ 已实现（UPnP SSDP 发现 + SetAVTransportURI/Play/Stop） | 无 |
| 音频会话 | ✅ audio_service / audio_session | ❌ 未实现（桌面端无系统媒体控制器） | 可后续补充 |
| 弹幕渲染 | ✅ canvas_danmaku | ❌ 未实现（弹幕 API 已接入，渲染引擎待补充） | 需弹幕渲染引擎 |

---

## 5. 弹幕系统

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 弹幕 API | ✅ DanDanPlay 开放平台 | ✅ 已实现（HMAC-SHA256 签名） | 无 |
| 弹幕签名 | ✅ HMAC-SHA256 | ✅ 已实现 | 无 |
| 弹幕数据模型 | ✅ DanmakuEntry / DanmakuEpisodeResponse | ✅ 已实现 | 无 |
| 弹幕渲染 | ✅ canvas_danmaku | ❌ 未实现（mpv 独立窗口无法直接渲染） | 需弹幕渲染引擎 |
| 弹幕开关/速度 | ✅ PlayerDanmakuController | ❌ 未实现 | 可后续补充 |
| 离线弹幕 | ✅ 下载时缓存弹幕 JSON | ❌ 未实现 | 可后续补充 |
| 弹幕屏蔽 | ✅ 屏蔽词列表 | ❌ 未实现 | 可后续补充 |

---

## 6. 下载系统

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 下载管理 | ✅ DownloadManager | ✅ 已实现（aria2c + HLS 合成） | 无 |
| M3U8 下载 | ✅ 分段下载 + 广告过滤 + 断点续传 | ✅ 已实现（ffmpeg 合成） | 无 |
| 直接下载 | ✅ Range 断点续传 | ✅ 已实现（aria2c） | 无 |
| 下载通知 | ✅ flutter_foreground_task | ✅ 已实现（系统通知） | 无 |
| 下载记录 | ✅ DownloadRecord / DownloadEpisode | ❌ 未实现（无持久化下载记录） | 可后续补充 |
| 弹幕缓存 | ✅ 下载时缓存弹幕 | ❌ 未实现 | 可后续补充 |

---

## 7. 同步服务

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| WebDAV 同步 | ✅ webdav_client | ✅ 已实现（收藏/历史/规则上传/恢复） | 无 |
| Bangumi 同步 | ✅ BangumiSyncService | ❌ 未实现 | 需 Bangumi token |
| 一起看（SyncPlay） | ✅ SyncPlay 协议客户端 | ✅ 已实现（TCP+TLS，Hello/State/Set/Chat 协议） | 无 |
| 跨设备同步 | ✅ WebDAV + Bangumi | ⚠️ 部分实现（WebDAV 已完成，Bangumi 同步需 token） | 需 Bangumi token |

---

## 8. WebView 子系统

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 视频源解析 WebView | ✅ 多平台实现 | ⚠️ 复用现有 captureDirect（Electron BrowserWindow） | 需增强 JS 注入 |
| 验证码 WebView | ✅ CaptchaWebviewController | ⚠️ 基础识别 + 手动过验证 | 需自动过验证 |
| 异步会话 | ✅ AsyncSession / AsyncSerialQueue / AsyncSingleFlight | ❌ 未实现 | 可后续补充 |

---

## 9. 页面与 UI

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 首页 | ✅ PopularPage | ✅ 已实现（CatVod 首页） | 无 |
| 番剧时间表 | ✅ TimelinePage | ✅ 已实现（timeline.js + Bangumi API） | 无 |
| 追番列表 | ✅ CollectPage | ✅ 已实现（收藏进度追踪 + 进度条） | 无 |
| 我的 | ✅ MyPage（观看统计 + 最近观看） | ❌ 未实现 | 需新增页面 |
| 搜索 | ✅ SearchPage | ✅ 已实现（聚合搜索） | 无 |
| 以图搜番 | ✅ ImageSearchPage | ✅ 已实现（URL/base64 上传） | 无 |
| 详情页 | ✅ InfoPage | ✅ 已实现（Bangumi 完整详情弹窗：概览/分集/角色/评论/关联/制作） | 无 |
| 播放页 | ✅ VideoPage | ⚠️ 部分实现（mpv 独立窗口，弹幕 API 已接入但无渲染引擎） | 需弹幕渲染 |
| 下载页 | ✅ DownloadPage | ✅ 已实现（下载管理） | 无 |
| 历史页 | ✅ HistoryPage | ✅ 已实现（历史记录） | 无 |
| 设置页 | ✅ SettingsPage | ✅ 已实现（设置中心 + Kazumi 规则板块 + WebDAV 同步） | 无 |
| 规则编辑器 | ✅ PluginEditorPage | ✅ 已实现（可视化表单编辑 + 测试） | 无 |
| 规则商店 | ✅ PluginShopPage | ✅ 已实现（在线商店弹窗） | 无 |
| 首次引导 | ✅ OnboardingPage | ✅ 已实现（欢迎弹窗 + 快速上手指南） | 无 |
| 日志查看 | ✅ LogsPage | ✅ 已实现（分页日志查看器弹窗） | 无 |
| 关于页 | ✅ AboutPage | ⚠️ 部分实现（设置页系统板块含版本号/缓存清理/退出行为） | 可后续补充 |

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
| 代码签名 | ✅ SignPath | ❌ 未实现 | 可后续补充 |
| 自动更新 | ✅ upgrader | ❌ 未实现 | 可后续补充 |
| CI/CD | ✅ GitHub Actions | ❌ 未实现 | 可后续补充 |

---

## 12. 测试与 CI

| 功能 | Kazumi 原版 | video-pc 现状 | 差距 |
|------|------------|--------------|------|
| 单元测试 | ✅ 16 个测试文件 | ✅ 已实现（32 个 Kazumi 测试 + smoke 13 + phase3 25） | 无 |
| 组件测试 | ✅ widget 测试 | ❌ 未实现 | 可后续补充 |
| CI | ✅ pr.yaml / release.yaml | ❌ 未实现 | 可后续补充 |

---

## 13. 优先级建议

### 高优先级（已全部完成 ✅）
1. **番剧时间表**：Bangumi 每日放送。✅ 已实现
2. **追番列表**：收藏 + 观看进度追踪。✅ 已实现
3. **完整详情页**：Bangumi 番剧详情（角色/评论/关联/制作人员）。✅ 已实现
4. **弹幕系统**：弹弹 play API。✅ API 已接入（渲染引擎待补充）
5. **以图搜番**：trace.moe 图片识别。✅ 已实现

### 中优先级（已全部完成 ✅）
6. **规则编辑器**：可视化编辑 XPath/JSONPath。✅ 已实现
7. **规则测试面板**：测试规则搜索/剧集解析。✅ 已实现
8. **WebDAV 同步**：跨设备收藏/历史同步。✅ 已实现
9. **一起看（SyncPlay）**：多人同步播放。✅ 已实现
10. **DLNA 投屏**：投屏到电视。✅ 已实现

### 低优先级（已全部完成 ✅）
11. **外部播放器**：VLC 自动探测 + 自定义路径 + Referer 注入。✅ 已实现
12. **画中画**：桌面 mini 窗（无边框置顶 320x180）。✅ 已实现
13. **定时关机**：N 分钟倒计时 → 停 mpv → 系统关机。✅ 已实现
14. **日志查看器**：分页查看应用日志。✅ 已实现
15. **首次引导**：新用户向导。✅ 已实现

---

## 14. 技术债务与风险

1. **弹幕签名密钥**：弹弹 play API 需申请 DANDANAPI_APPID/DANDANAPI_KEY，未申请前无法实际加载弹幕。
2. **Bangumi 镜像签名**：Bangumi 镜像 API 需 KAZUMI_APPID/KAZUMI_KEY，未申请前部分端点不可用。
3. **验证码自动过验证**：当前仅实现手动过验证，自动过验证复杂度高。
4. **Cookie 持久化**：验证后 Cookie 未持久化，重启后需重新验证。
5. **视频源解析池**：当前复用单窗口 captureDirect，并发解析时可能冲突。
6. **弹幕渲染**：弹幕 API 已接入但 mpv 独立窗口无法直接渲染弹幕，需额外弹幕渲染引擎。
7. **未捕获异常兜底**：已添加全局 process.on('uncaughtException') 兜底防进程崩溃。

---

## 15. 功能统计

| 类别 | 已完成 | 部分实现 | 未实现 |
|------|--------|---------|--------|
| 核心规则系统 | 11 | 0 | 3 |
| 视频源获取 | 2 | 2 | 4 |
| 番剧元数据 | 9 | 0 | 1 |
| 播放器与媒体 | 10 | 0 | 3 |
| 弹幕系统 | 3 | 0 | 4 |
| 下载系统 | 4 | 0 | 2 |
| 同步服务 | 2 | 1 | 1 |
| WebView | 0 | 2 | 1 |
| 页面与 UI | 13 | 2 | 1 |
| 主题与国际化 | 4 | 0 | 1 |
| 平台配置 | 0 | 1 | 3 |
| 测试与 CI | 1 | 0 | 2 |
| **合计** | **59** | **8** | **26** |
| **完成率** | **63%** | **9%** | **28%** |

> 注：核心功能（规则引擎/播放/搜索/下载/Bangumi/SyncPlay/DLNA/WebDAV/编辑器/时间表等）已全部完成，剩余未实现项多为边缘功能或需第三方密钥/平台特定能力。

---

*本文档基于 Kazumi v2.2.6 源码（lib/ 321 个文件）与 video-pc 当前实现对比整理。*
