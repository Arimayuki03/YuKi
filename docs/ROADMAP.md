# YuKi 开发路线图

> 文档版本 v1.2（2026-09-22）
> 对标基线：Kazumi v2.3.1（2026-09-07 发布）、Animeko v6.1.0（2026-08-28 发布）；本项目基线：0.2.1 立项（2026-09-14 落地 RM-1/2/4/5），当前已发布至 0.2.5（三轮安全修复 + 会话级 TTL 内存缓存）。
> 执行状态唯一入口仍是 [PROGRESS.md](../PROGRESS.md)：本文只维护「为什么做、做到什么程度算完」；任一项动工时在 PROGRESS.md 登记批次与验收，完成后在本文对应小节标注完成日期并链接测试证据。

## 1. 目标与定位原则

YuKi 的差异化定位：**聚合播放器 + TVBox/CatVod 生态纵深 + 桌面深度体验 + 本地优先隐私**。对标 Kazumi / Animeko 时遵循三条原则：

1. **不照搬移动端特性**：两者是全平台移动优先产品，iOS/Android 适配、触控手势等不在 YuKi 范围。
2. **最小侵入红线不变**：新增功能不得触碰 CatVod 核心链路（app.py、runner.py、base/spider.py、config.py、site_manager.py 等），新逻辑进独立模块。
3. **每项立项都要有明确收益**：要么是用户可感知的体验收益，要么是发布安全/迭代效率收益。

## 2. 对标项目最新版本动向

### 2.1 Kazumi v2.2.6 → v2.3.1

本地 [KAZUMI.md](KAZUMI.md) 第二部分差距对照基于 v2.2.6，**基线已落后 5 个版本**，需择机更新。期间动向：

- **v2.3.1**：时间表/追番/我的/播放页/规则管理/同步设置六大页面全量 UI 重设计；改进 Bangumi 同步流程。
- **v2.3.0**：**规则批量导入**；弹幕性能优化与倍速下弹幕时长修正、透明度修复、手动检索匹配修复；无效/失效视频源的错误提示优化；下载选集自动定位当前播放集数。
- **v2.2.9**：弹幕检索匹配优化；历史记录进入播放页时选集列表定位到当前集数。
- **v2.2.8**：Windows 部分视频源只能播放 5 秒零碎片段的修复；兼容更多非标准视频流；桌面端 UI 性能优化。
- **v2.2.7**：Windows 视频解析器优化。

要点：Kazumi 近期重心在 **UI 打磨、弹幕细节、批量效率与播放定位**，未引入新的大赛道。

### 2.2 Animeko v6.0.0 → v6.1.0

- **v6.1.0**：**在线源查询缓存**（有缓存时跳过查源，大幅加速开播）；**画质增强超分**（Android/Windows/macOS）；播放页一起看入口；**PikPak 加速缓存 BT 源**；**新缓存管理页面**；mpv 内核支持自定义参数；BT 可配置额外 trackers；详情页图片点击放大。
- **v6.0.0**：**一起看（SyncPlay）**与自动选源改进；桌面端切换 **mpv 内核**；**进度条悬停/拖动帧预览**；**播放信息叠加面板**（码率/解码器）；**数据源多平台图片验证码自动处理**；实验性 HLS 贴片广告过滤；跳过 85s 按钮时长可配（80/85/90）；缓存与数据源管理多选批量操作。

要点：Animeko 在 **开播速度（缓存）、BT 体系、一起看、播放器信息透明化** 上持续加深。

## 3. 差距矩阵与独有优势

| 维度 | YuKi 0.2.1 现状 | Kazumi 2.3.1 | Animeko 6.1.0 | 结论 |
|---|---|---|---|---|
| 内容引擎 | CatVod（Python/QuickJS/JAR）+ Kazumi 双引擎 + 直播 + 网盘源 | 仅 XPath 规则 | BT/Mikan/动漫花园/Jellyfin/Emby/自定义 | **YuKi 领先**（TVBox 生态独占） |
| 播放器 | mpv 独立窗口、Anime4K 三档、外部播放器、边下边播 | media_kit 内置+外部 | mpv 内核+超分+帧预览+信息面板 | 基本持平，细节有差距 |
| 弹幕 | 自动加载已实现（弹弹play→ASS→mpv，默认关），产品化项未做 | 核心体验，持续打磨 | 核心体验，聚合多源+自有服务器 | 基础已通，差产品化打磨 |
| 一起看/投屏 | syncplay-client/dlna-caster 主进程 IPC 已接线，缺渲染层 UI | SyncPlay 已上线 | 一起看已上线 | 差一层 UI 接线 |
| 追番与 Bangumi | 手动收藏同步 + 分集进度自动上报（RM-5，默认关） | 同步流程持续改进 | 看完自动云同步进度 | 闭环已通，差默认体验 |
| 下载与缓存 | aria2c+ffmpeg，番剧子目录（RM-1） | 基础下载 | BT 流播+缓存管理页 | 结构化管理差距缩小 |
| 开播速度 | 三级缓存（内存 60s + 持久 2h + 会话级）+ 会话级 TTL 内存缓存（0.2.5） | — | 源查询缓存跳过查源 | 已对齐 |
| UI/UX | 0.2.0 视觉系统升级 | 2.3.1 全页面重设计 | 持续打磨 | 方向一致，零散小差距 |
| 平台与发布 | 仅 Windows 验证，无签名，应用内更新已上线（RM-2） | 6 平台+签名+应用内更新 | 全平台+签名+多渠道 | 发布工程差距（签名/多平台） |

**需要守住的独有优势（竞品均无）**：TVBox/CatVod 生态（JAR spider、多仓、站点健康模型与熔断）、夸克网盘源（扫码登录/转存/风控策略）、局域网推送接收（push-server）、直链播放、严格本地优先 + 无遥测 + 56 阶段 Python 回归的工程纪律。

## 4. 立项 RM-1：下载自动创建番剧文件夹

### 目标

下载产物按「番剧/影片」分文件夹管理：同一部作品的所有集数落在 `<下载目录>/<番剧名>/` 下，剧集文件以集名命名，避免大量文件平铺在下载根目录。

### 现状（代码事实）

- 所有任务平铺：aria2 引擎使用全局 `--dir`（`src/main/downloader.js` `start(dir)`，取设置项 `dlDir`，默认系统下载目录）；任务仅传 `out` 文件名（`src/main/index.js` 下载入口：清洗非法字符后 150 字截断）。
- HLS 合成任务 `hls.add({ url, out, header, adFilter, concurrency })` 固定写引擎全局目录（`src/main/hls-downloader.js`）。
- RPC 任务级选项经 `_proxyOpts` 透传、无白名单（downloader.js），aria2 RPC 本身支持**任务级 `dir` 覆盖**全局 `--dir`，引擎参数无需改动。
- 记录落盘 `src/main/dl-record.js`（userData/dl-records.json）；一键播放 `yuki:dl-play` 与本地推送解析已有「dlRoot + 相对路径 + `inside()` 防穿越守卫」模式（index.js 约 1389/1437 行）。
- 去重键「站点|剧名|集名」（`src/main/dl-dedupe.js`）；0.2.0 已实现「更换下载目录并迁移在途任务」。

### 方案

1. 新设置项 `dlSeriesFolder`（默认开启）：设置页「下载」卡片加开关「按番剧创建文件夹」。
2. 新增路径段清洗工具（可单测）：非法字符 → `_`；去尾部空格与点；Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）追加 `_`；截断 80 字符（为根目录 + 集名 + 扩展名留出 MAX_PATH 余量）；空结果回退「未命名番剧」。
3. 下载编排统一走一个布局辅助：文件夹 = 清洗后的 `meta.title`（番剧/影片名），文件 = 清洗后的 `meta.subtitle`（集名，缺省回退现标题逻辑）+ 扩展名。
   - aria2 直链/种子：`addUri(url, { dir: path.join(dlRoot, folder), out: file })`。
   - HLS：`hls.add` 增加 `dir` 参数（缺省沿用引擎目录，向后兼容），ffmpeg 输出与 `.aria2` 同级落子目录。
4. 记录与播放：任务记录保留任务目录与相对路径；一键播放、删除（含删文件）、更换下载目录迁移优先按「dlRoot + 相对路径」解析，复用 `inside()` 守卫，换目录后不失效。
5. 范围控制：仅新任务生效，存量平铺文件不迁移（设置项说明注明）；去重键不变，同番剧自动并入同一文件夹。

### 剩余验收项

- [x] 下载编排统一番剧布局：aria2 直链/磁链任务级 `dir`、HLS `add` 增 `dir` 参数（产物与分片目录入夹）、四条入队路径（add/addHls/边下边播逐集链/原生队列 `enqueueSimulDownload`）全部接入（2026-09-14）。
- [x] 记录与恢复链路兼容子目录：记录持久化 `dir` 字段、重启恢复/单个与全部继续落回原子目录、更换下载目录迁移保持两级结构（`.aria2`/分片目录随迁）、删除任务后空番剧目录清理（2026-09-14）。
- [x] 一键播放/打开下载目录按绝对路径工作在子目录内（`inside(dlRoot)` 守卫天然覆盖一级子目录）（2026-09-14）。
- [x] 清洗工具单测覆盖非法字符/保留名/超长/尾点尾空格/空串：`tests/js/dl-layout.test.js` 12 例 + `tests/js/dl-series-folder.test.js` 4 例（migrateDir 结构保持/dir 参数/平铺兜底）（2026-09-14）。
- [ ] 实机验收：同一番剧连续下载多集落 `<dlDir>/<番剧名>/`、断点续传、更换目录迁移、去重不误判（待用户在真实环境跑一轮）。
- [x] `npm run test:all` 全绿（2026-09-14，含安全加固批次与 RM-1）。

### 当前状态

代码完成（2026-09-14）：`src/main/dl-layout.js` 布局合成与清洗，`hls-downloader.js` 任务级 `dir` 与迁移结构保持，`index.js` 四条入队路径 + 持久化/恢复/迁移/删除链路接线，设置项 `dlSeriesFolder`（默认开）。实机 QA 待用户验证。

## 5. 立项 RM-2：应用内 GitHub 检测更新

### 目标

打包版应用内可检测 GitHub Releases 上的新版本：手动「立即检查」+ 启动静默检查，下载后重启安装，形成 0.1.0 以来「发新版需用户手动重装」缺口的闭环。

### 现状（代码事实）

- `src/main/updater.js` 已接 electron-updater：打包模式启动静默检查一次，`autoDownload`/`autoInstallOnAppQuit` 开启，状态经 `yuki:update-state`（checking/available/not-available/downloading/downloaded/error）推渲染层；开发模式禁用。
- **缺口 1**：package.json `build` 无 `publish` 配置 → electron-updater 无更新源，打包后检查必然失败。
- **缺口 2**：`.github/workflows/release.yml` 以 `--publish never` 构建且仅上传 `dist/*.exe`，未上传 `latest.yml` 与 `.exe.blockmap` → GitHub provider 无版本元数据可用。
- **缺口 3**：渲染层无任何更新 UI；无手动检查 IPC；系统代理设置未透传 electron-updater。

### 方案

1. package.json 增加 `build.publish = { "provider": "github", "owner": "Arimayuki03", "repo": "YuKi" }`。
2. release.yml：softprops/action-gh-release 的 files 增加 `dist/latest.yml` 与 `dist/*.exe.blockmap`；保持现有 Draft + 人工润色 Notes 后 publish 的流程（Draft 期间应用内检测不到，正式 publish 后生效，语义安全）。
3. updater.js 增强：
   - 新 IPC `yuki:check-for-updates`（手动检查；开发模式返回明确的 `development` 语义而非报错）。
   - 新设置项 `autoUpdate`（默认关）：开 = 静默下载 + 退出安装；关（默认）= 发现新版本仅提醒，用户点击后再下载（动态切 `autoDownload`）；另设 `updateNotify`（默认开）：启动检查发现新版本时弹窗提示并可一键下载（`autoUpdate` 开启时静默下载、不弹窗）。
   - 验证系统代理设置对 electron-updater 检查/下载链路的生效方式（Electron net 代理 / requestHeaders），保证受限网络环境可用。
4. 渲染层：设置 → 系统新增「软件更新」卡片——当前版本号、立即检查按钮、状态行（检查中 / 已是最新 / 发现 vX.Y.Z / 下载中 N% / 重启并安装 / 失败原因），监听 `yuki:update-state`；下载完成 toast 提示。

### 剩余验收项

- [x] 更新源配置闭环：package.json `build.publish`（GitHub provider，Arimayuki03/YuKi）+ release.yml 随安装包上传 `dist/latest.yml` 与 `dist/*.exe.blockmap`（electron-updater 无版本元数据必然失败的缺口 1/2 已补）（2026-09-14）。
- [x] updater.js 增强：`yuki:check-for-updates` / `yuki:update-download` / `yuki:update-install` IPC（开发模式返回明确 `development` 语义）；`autoUpdate` 设置（默认关，检查前动态应用 `autoDownload`）；系统代理经 Electron 默认 session 对检查/下载链路生效（electron-updater 主进程走 Electron net，无需额外接线）（2026-09-14）。
- [x] 渲染层：设置 → 系统「软件更新」卡片——当前版本、自动下载开关、立即检查/下载更新/重启并安装按钮、状态行（检查中/已是最新/发现 vX/下载中 N%/已就绪/失败原因），监听 `yuki:update-state`，下载完成 toast（2026-09-14）。
- [x] IPC 与状态映射单测：`tests/js/updater-controller.test.js` 6 例（事件归一/开关语义/in-flight 去重/error 恢复/退出安装/非 Electron 环境语义）（2026-09-14）。
- [ ] 发布 v0.2.2 后：v0.2.1 安装版在应用内能发现新版本 → 下载 → 重启并安装成功，用户数据保留（需真实 Release，待建仓后实测）。
- [ ] Draft（未 publish）Release 不会被检测为可更新（GitHub provider 拉不到 Draft 资产属预期行为，随上条实测确认）。
- [ ] 系统代理受限网络下检查/下载实测（依赖真实更新源）。
- [x] `npm run test:all` 全绿（2026-09-14）。

### 当前状态

代码完成（2026-09-14）：缺口 1/2（publish 配置与 CI 元数据上传）、缺口 3（手动检查 IPC + autoUpdate 开关 + 更新 UI）全部补齐；真实发布链路验收（v0.2.1 → v0.2.2 升级、Draft 语义、代理环境）待建仓发版后实测。

## 6. 立项 RM-4：解析结果持久缓存

### 目标

playerContent 解析结果（直链/清单）按「站点+线路+集」持久缓存：重开同一集、重启应用后跳过查源直接起播（实测解析一次 2~5s），与 server.py 60s 内存缓存、playlist-proxy 会话级缓存互补成三级供数。对标 Animeko 6.1.0「在线源查询缓存（有缓存时跳过查源，大幅加速开播）」。

### 现状（代码事实）

- 所有 playerContent 查询（主播放链、playlist-proxy 逐集懒解析、手动下载取址）都汇入后端 `/action do=playerContent` 单一漏斗；该处已有 **60s 内存缓存**（`server.py`，key=`site|flag|id|vipFlags`），带 `_is_ephemeral_play_result` 门（签名 CDN/网盘一次性地址/显式过期标记不缓存）——但重启即失、TTL 过短，重开同一集/重启应用必须重新查源。
- playlist-proxy 会话缓存（2h TTL、上限 8 个）仅进程内、随会话生灭。
- 起播即失败无自动重解析：渲染层断流重连（refresh=1）要求 `pos>=15`，缓存直链在 TTL 内被源站侧失效时会是用户可见的播放失败。

### 方案

1. 新增 `python-backend/play_cache.py`（独立模块，不触碰 CatVod 核心链路）：复用 `CacheStore` 的内存+文件两级存储（`<cache_dir>/play-cache/`，原子写/容量淘汰），实例级上限 16MB，TTL 2h。
2. server.py 接线三处：写路径在 ephemeral 门内同步落持久层；读路径内存层未命中后查持久层（读侧复检 ephemeral 门防中毒回流，命中回填内存层）；`refresh=1` 同时淘汰内存层与持久层。
3. 失效重解析闭环（渲染层）：`yuki:player-exit` 增加 `endReason` 字段；`_onExit` 对「起播即失败」（end-file reason=error 且几乎零进度）自动 refresh=1 重解析一次（沿用既有 `_reconnectAttempts<1` 单次上限，真死源不循环）。
4. 缓存可清理：接入既有 `clearCache` 端点（设置 → 缓存 → 清理缓存），`/cache` 统计 breakdown 增加 `playerCachePersist`，`_cache_size` 计入 play-cache 目录。
5. 范围控制：Kazumi 源不在本期（二段解析含隐藏窗口抓流，产物可能是本地临时文件，不宜按 URL 缓存）；原生队列起播失败不走自动重解析（退出路径既有边界）；网盘 ephemeral 结果天然被门挡住不入缓存。

### 剩余验收项

- [x] `python-backend/play_cache.py` 持久缓存模块 + server.py 三处接线（写/读/refresh），ephemeral 双侧过滤与内存层回填（2026-09-14）。
- [x] 失效重解析闭环：`endReason` 透传 + 渲染层起播失败自动 refresh=1 重解析（单次上限防循环）（2026-09-14）。
- [x] 缓存清理与统计接线：`clearCache`/`/cache` breakdown/`_cache_size` 三处（2026-09-14）。
- [x] 单测：`tests/test_play_cache.py` 10 例（往返/跨重启/TTL 过期/失效/清空/统计/空值/损坏文件）接入 run_all.py `play-cache` 阶段；smoke 新增 3 例 dispatch 级集成（内存清空后持久层供数、refresh=1 穿透、重查源回填）；`tests/js/player-watch.test.js` +3 例（起播失败触发/单次上限/quit 与 Kazumi 与 eof 不触发）（2026-09-14）。
- [x] `npm run test:all` 全绿（2026-09-14：run_all.py 42 阶段含 play-cache、编译 108 文件 0 error、JS 单元 458/458、ESLint 0 error、Ruff 全过）。
- [ ] 实机验收：重开同一集/重启应用后起播速度对比、慢源（2~5s 解析）跳过查源的实际感知、失效直链自动重解析的用户体验（待用户真实环境验证）。

### 当前状态

代码完成（2026-09-14）。三级缓存供数与失效重解析闭环就绪；实机开播加速感知待用户验证。

## 7. 立项 RM-5：Bangumi 观看进度自动上报

### 目标

看完一集自动向 Bangumi 账号上报该集「看过」，并联动收藏状态（未收藏/想看 → 在看；看完全部本篇 → 看过），与既有手动/自动收藏同步（`bangumiAutoSyncStatus` 收藏状态变动自动同步、批量「标记已看」）形成完整闭环。对标 Animeko「看完自动云同步进度」；Kazumi 2.3.1 亦在持续改进同步流程。

### 现状（代码事实）

- 收藏状态同步已闭环：详情页追番按钮 / 收藏批量标记经 `Kazumi.setBangumiCollection`（后端 `bangumi_update_collection` 全矩阵写 `/v0/users/-/collections/{id}`）；单条自动同步 `_autoSyncFavItem` 挂在 `bangumiAutoSyncStatus` 开关（默认关）。
- **缺口 1**：观看行为不产生任何 Bangumi 写入——看完一集（mpv ended / 退出时剩余<8s）没有上报通道。
- **缺口 2**：无分集级 API 接线——后端只有条目级收藏端点，未接 Bangumi v0 分集收藏（`PATCH/GET /v0/users/-/collections/{subject_id}/episodes`）。
- **缺口 3**：播放会话与 Bangumi 条目的映射（片名 → subject、集名 → episode_id）不存在；`getBangumiMatch`（片名匹配+持久缓存）与 `bangumi_episodes`（分集列表）两个既有组件可复用。

### 方案

1. 后端（不触碰 CatVod 核心链路）：`plugin_manager.py` 新增 `bangumi_update_episode_collection`（PATCH 批量分集收藏，body `{episode_id:[ids], type:2}`，服务端重算条目完成度）与 `bangumi_episode_collections`（GET 分集收藏查询）；沿用既有「`-` 通配/真实用户名 × 官方/镜像基址」矩阵兜底。`server.py` 接线 `kazumiBangumiEpisodeWatched` / `kazumiBangumiEpisodeCollections` 两个 action。
2. 渲染层 `kazumi.js` 新增进度上报模块（与收藏同步同域）：准入过滤（仅 CatVod 带 vodId / kazumi: 源；直链、本地/下载文件、Bangumi 条目不做片名匹配防误标）→ `getBangumiMatch` 解析 subject → 分集列表 10 分钟缓存 → 集数解析（第N集/第N话/Episode N/EP N/纯数字/前导数字，`季` 不误判）优先、分集名精确兜底（只认 type=0 本篇，匹配不到宁缺勿错标）→ 串行链逐集打点 → 收藏联动（未收藏/想看 → 在看；最后一集看完且远端本篇全看过 → 看过；搁置/抛弃/已看过不动）。
3. 播放触发点（`player.js`）：逐集会话在 `_onExit`「看完」判定后按会话绑定 meta 上报（不能用 `_seq`——末集/单集播完时连播链为 null；无会话号的旧协议路径才回退 `_currentPlayback`）；原生连播队列在 `_onEnded` 逐集 ended 上报（≥15s 门槛与统计同口径），最终退出不重复上报。
4. 设置：`bangumiProgressSync`（默认关，本地优先隐私立场与既有自动同步开关一致）接入 settings-set 白名单与「Bangumi 同步」卡开关。
5. 范围控制：跳看/中途退出/外部播放器（无 pos/分集上下文）不上报；上报全程 fire-and-forget 不阻塞播放；失败 toast 5 分钟节流（Token 失效给 401 指引）。

### 剩余验收项

- [x] 后端分集收藏接线：`bangumi_update_episode_collection` / `bangumi_episode_collections` + `kazumiBangumiEpisodeWatched` / `kazumiBangumiEpisodeCollections` 两个 action（2026-09-14）。
- [x] 渲染层上报模块：准入过滤、subject/分集双级解析（集数优先、名称兜底、宁缺勿错标）、收藏联动（在看/看过）、串行链与失败节流（2026-09-14）。
- [x] 播放触发点：逐集会话 `_onExit`（含末集 `_seq=null` 场景）+ 原生队列 `_onEnded` 逐集上报、退出不重复（2026-09-14）。
- [x] 设置项 `bangumiProgressSync`（默认关）：白名单 + Bangumi 同步卡开关 UI + 回填（2026-09-14）。
- [x] 单测：`test_kazumi.py` +5 例（PATCH 矩阵/回退/入参拒绝/GET 归一化/401 短路）；`tests/js/bgm-progress.test.js` 12 例（开关/打点/集名形态/名称兜底/宁缺勿错/在看联动/看过联动/搁置抛弃不动/准入过滤/无 Token/失败节流/kazumi 源）；`tests/js/player-watch.test.js` +4 例（看完触发含末集/未看完不触发/原生队列逐集+退出去重/模块缺失静默）（2026-09-14）。
- [x] `npm run test:all` 全绿（2026-09-14：run_all.py 全阶段含 kazumi 90 例、编译 108 文件 0 error、JS 单元 474/474、ESLint 0 error、Ruff 全过）。
- [ ] 实机验收：开启开关后连播一季，Bangumi 端分集进度逐集点亮、看完自动「在看/看过」；重看已看集不产生脏数据；直链/本地播放不误报（待用户真实 Token 环境验证）。

### 当前状态

代码完成（2026-09-14）。分集打点与收藏联动闭环就绪；实机同步效果（真实 Token、连播一季的进度点亮）待用户验证。

## 8. 路线总览

### P0（1~2 个版本内，低成本高感知）

| 编号 | 事项 | 一句话说明 | 对标依据 |
|---|---|---|---|
| RM-1 | 下载自动创建番剧文件夹 | 见 §4，结构化下载产物 | 通用体验（Animeko 缓存管理同理） |
| RM-2 | 应用内 GitHub 检测更新 | 见 §5，打通迭代闭环 | 两者均有应用内更新 |
| RM-3 | 弹幕产品化 | 自动加载已落地（DanDanPlay 匹配 → ASS 写入 → mpv 加载，默认关）；剩余：透明度/遮挡/屏蔽词、倍速下时长修正参照 Kazumi 2.3.0 | Kazumi/Animeko 核心体验；YuKi 链路已通 |
| RM-4 | 解析结果持久缓存 | 见 §6，实现与验收记录 | Animeko 6.1.0「在线源查询缓存」 |
| RM-5 | Bangumi 观看进度自动上报 | 见 §7，实现与验收记录 | Animeko 云同步进度；Kazumi 2.3.1 改进同步流程 |
| RM-6 | 体验小快赢包 | 规则批量导入、下载/详情选集定位当前集、mpv 自定义参数项、播放信息快捷面板（mpv stats）、缓存管理页（鼠标侧键返回、详情图片点击放大已在 0.2.x 实现） | Kazumi 2.2.9/2.3.0 + Animeko 6.0/6.1 |

### P1（中期）

| 编号 | 事项 | 一句话说明 | 对标依据 |
|---|---|---|---|
| RM-7 | 一起看（SyncPlay）落地 | 补渲染层房间 UI 与入口（syncplay-client.js 与 IPC 已接线） | Kazumi SyncPlay、Animeko 6.0 |
| RM-8 | DLNA 投屏收尾 | 补发现/投屏/停止 UI（dlna-caster.js 与 IPC 已接线） | Kazumi dlna_dart |
| RM-9 | Jellyfin/Emby 媒体库源 | 以 Provider 形式接入本地媒体库 | Animeko 核心场景之一 |
| RM-10 | 播放器进阶 | 进度条帧预览、跳过片头时长可配 | Animeko 6.0 |

### P2（战略/工程）

| 编号 | 事项 | 一句话说明 | 对标依据 |
|---|---|---|---|
| RM-11 | 跨平台验证与 CI 矩阵 | macOS/Linux 实机验证 → release.yml 启用对应 job；评估 Windows ARM64 | 两者均全平台 |
| RM-12 | 代码签名 | Windows 证书与签名链路 | 两者均签名 |
| RM-13 | drpy（N3）运行时 | TVBox 生态纵深，竞品不会跟进 | YuKi 独有赛道 |
| RM-14 | 更多网盘 Provider | UC/115/阿里云盘/PikPak（Animeko 6.1.0 已用 PikPak 加速 BT） | Animeko/生态动向 |
| RM-15 | 长期评估项 | BT 流式播放（aria2c 体验受限，需谨慎评估）、图片验证码自动处理（Animeko 6.0 已实现，YuKi 文档当前划为范围外） | Animeko |

## 9. 维护规则

1. 对标基线（§2/§3）在竞品大版本发布或每季度时刷新一次；`KAZUMI.md` 第二部分差距对照随 RM-3/RM-6 动工一并更新到最新版本基线。
2. 每项动工时在 PROGRESS.md 登记执行批次；完成后在本文对应小节「当前状态」标注完成日期并链接测试证据（TEST_REPORT.md / RUNTIME_ISSUES.md）。
3. 文档冲突时按 [README.md](README.md) 的「文档状态优先级」判断；本文与 PROGRESS.md 冲突时以 PROGRESS.md 为准。
4. 新立项走本文追加编号（RM-N），不在 PROGRESS.md 另起第二份总待办。
