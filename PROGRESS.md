# YuKi — 当前开发状态

> 更新时间：2026-08-26
> 许可证：GPLv3（`LICENSE`，`package.json` `GPL-3.0-only`）
>
> 本文件是跨会话续作的首要入口，只记录当前有效状态、约束与下一步。完整历史流水见 [开发历史](docs/DEVELOPMENT_HISTORY.md)。

## 1. 项目快照

| 项目 | 当前值 |
|---|---|
| 应用版本 | `0.2.0` |
| 桌面宿主 | Electron 31，JavaScript |
| 后端 | FastAPI，Python 3.14 独立进程 |
| 内容引擎 | CatVod + Kazumi 双引擎 |
| 播放 | mpv 独立窗口 |
| 下载 | aria2c + ffmpeg |
| 主要平台 | Windows |
| 数据目录 | `~/.yuki/` 与 Electron `userData` |
| 项目状态 | 第一阶段安全/稳定性修复、2A/2B、UI/观看统计及 TVBox/FongMi G0.1-G0.3、S1.1-S1.4、C2.1-C2.5 已验收；2026-08-23/24 打包版用户问题批次修复与原生播放列表/边下边播去重/mpv 中文菜单/Anime4K 快捷键已完成；2026-08-26 UI 视觉系统升级（DESIGN.md 契约）、壁纸自定义调整、夸克转存失败修复与网盘源播放策略收敛已完成；N3（drpy / PC 原生运行时）与真实公共仓/发布环境验收仍未开始 |

源应用是 Android TV/CatVod 架构应用；当前桌面实现保留 CatVod Spider 契约，同时独立接入 Kazumi 规则系统。Kazumi Flutter 原版仅作为行为与功能参考。

## 2. 文档入口

| 需要了解的内容 | 文档 |
|---|---|
| 文档层级与维护规则 | [docs/README.md](docs/README.md) |
| 进程、接口、数据流和关键约束 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Kazumi 规则引擎 | [docs/KAZUMI.md](docs/KAZUMI.md)（整合说明与差距对照） |
| 最新运行异常与修复验证 | [docs/RUNTIME_ISSUES.md](docs/RUNTIME_ISSUES.md) |
| 全量功能测试矩阵与测试结果 | [docs/TEST_REPORT.md](docs/TEST_REPORT.md) |
| Phase、U/T 批次和历史决策 | [docs/DEVELOPMENT_HISTORY.md](docs/DEVELOPMENT_HISTORY.md) |
| TVBox 兼容性总览/执行计划 | [docs/TVBOX_FONGMI_PARITY_TASKS.md](docs/TVBOX_FONGMI_PARITY_TASKS.md) |

状态发生冲突时，按以下优先级判断：运行时问题记录 → 本文件 → 专项文档 → 历史开发记录 → Kazumi 原版参考文档。

## 3. 当前已完成范围

### 内容与搜索

- CatVod Python、JavaScript、CMS 和多仓配置加载。
- 首页、分类、当前源搜索、SSE 聚合搜索、详情、收藏和历史。
- Kazumi XPath/API 规则导入、编辑、测试、商店、有效性检测和批量更新。
- Bangumi 搜索、详情、日历、榜单、分集、角色、Staff、评论、关联和收藏同步。

### 播放与解析

- mpv 播放、硬件加速、倍速、续播、自动连播、断流重连和失败换线。
- 原生播放列表：在线整季经 `playlist-proxy` 本地按需解析代理（打开哪集解析哪集，302 交真实 CDN）交给 mpv 原生队列连播；静态直链批量直接入队，观看统计/历史逐集记账。
- mpv 右键中文菜单（menu.conf 注入）与 Anime4K 快捷键（K 键循环档位 + 菜单勾选态同步）；PGUP/PGDWN 上/下一集。
- 边下边播与手动下载同源同集去重（`dl-dedupe`，「站点 | 剧名 | 集名」稳定 key）。
- 网盘类源播放策略收敛：网盘源（夸克/UC/阿里/115/123/天翼/移动等）全局禁用原生播放列表（`pan-source.js` 统一判定，主进程拒建队 → 渲染层静默回退逐集连播；Kazumi 规则引擎豁免防误伤），并禁用自动线路回退防止转存风暴触发夸克风控。
- 隐藏 BrowserWindow 通过媒体请求拦截、DOM 轮询和 legacy iframe 跟随提取真实视频流。
- Anime4K 三档、VLC 外部播放、截图、定时关机。
- 外部播放器观看统计与历史：PotPlayer/VLC 进程退出按运行墙钟（口径同 mpv wallWatched，`ext-watch` 会话追踪 + `yuki:ext-player-exit` 事件）计入统计/最近观看/历史；主播放链、播放弹窗按钮与直链播放入口全覆盖（≥15s 记一次）。
- 解析窗口使用 3 个独立 partition 槽位，并通过 single-flight 合并同地址并发请求。

### 下载与数据

- aria2c 直链/种子下载与 ffmpeg HLS 合成。
- HLS 下载广告段过滤、下载记录持久化、完成通知和一键播放。
- 本地文件白名单、防路径穿越、上传、删除和本地播放。
- WebDAV、Bangumi 收藏同步、观看统计和最近观看。

### UI 与桌面能力

- 设置中心、主题、壁纸、系统字体、字号、分页、托盘驻留、快捷键、自定义缓存路径和首次引导。
- UI 视觉系统升级（2026-08-26）：按根目录 [DESIGN.md](DESIGN.md) 视觉契约整体重制 `ui.css`——中性灰阶骨架 + 主题色点睛、派生色 `color-mix` 现场计算、圆角/阴影/动效令牌化、微噪点质感、卡片入场错峰/悬浮抬升/按压反馈动效与网格空态 CSS 骨架屏；动画只动 transform/opacity 并尊重 `prefers-reduced-motion` 与应用内动画开关，类名/DOM/皮肤挂钩等禁改清单未动。
- 背景图自定义调整：选图后弹调整弹窗（拖动定位、缩放/透明度/模糊滑杆，预览即所得，保存才生效）；壁纸改经 `--wall-url` 单层伪元素按视口缩放绘制（修复大分辨率视口平铺铺不满）；遮罩强度新增「极弱」档位。
- 2A：移除运行时 MiSans 动态下载/注入和画中画入口；关于内容迁入设置一级分类；系统页移除版本号；设置固定在左侧功能项底部。
- Windows NSIS 安装包和自定义图标。

### TVBox / FongMi G0 基线、契约与健康模型（2026-08-18）

- 兼容基线默认使用 loopback 正常、异常、超时和无限循环夹具；G0 时由仓级父进程树兜底，
  S1 后改为逐 requestId 终止实际 Worker 并自然退出，后代 Python 已回收；公共 21 仓仅
  通过显式 `--public` 运行。
- `RuntimeRequest`、`RuntimeResponse`、L1-L6 `RuntimeError` 和 `SiteHealth` 已接入 `/action`、
  Runner、JAR RPC、解析窗口、本地代理和 mpv；异常响应统一为非 2xx 结构化错误。
- 配置摘要严格区分 configured/built/initialized/healthy；Android/Dex/native/DRM JAR 在
  Android Worker 未完成 enabled+ready 握手时保持 `L2_SITE_REQUIRES_ANDROID`，不计 healthy。
- 生产 Worker Supervisor、进程隔离硬杀、重启和熔断属于 S1，本轮未实现。

### TVBox / FongMi C2 配置标准化与能力路由（2026-08-18）

- 配置分下载（`ConfigFetchResult`）/ 解析（`ParsedConfig`）/ 运行（`ConfigSnapshot`）三层，
  更新按 prepare → validate → atomic swap；新配置一个站点都装配不出来时旧快照连站点一起
  保留，本次已起的 Worker 全部释放。同内容哈希重复加载只累加 `reuseCount`，不重启 Worker。
- 多仓 `urls` 由 `RepoTrail` 记录清单、截断数、尝试顺序、选中条目和逐条失败原因；嵌套多仓
  在深度 1 拒绝，子仓指向私网被守卫拦下，合并只增不删。
- `ext` 按 FongMi `ExtAdapter`/`fetchExt` 对齐：任意 JSON 值归一为字符串，只有 type=4/JS 在
  `homeContent` 前展开一次，type=3 拿原始字符串；空响应保留原 URL；失败只影响该站点。
- 能力路由集中在 `runtime/capability_router.py`，装配与诊断页共用同一结论；R4→R5 在字节级
  JAR 分级后收敛，与 JAR 加载器使用同一组 Android 信号，Android-only JAR 不再回退普通 JVM。
- 配置安全边界：仅 `http`/`https`，磁盘路径在 scheme 分派前判掉；响应/解压/`ext` 体积、跳转
  次数、多仓与 `ext` 递归深度均设限；私网信任按同源（scheme+host+port）继承，逐跳重新守卫。
- drpy 只做独立归类（C0、`worker` 为空），真正的 drpy 运行时和 type `15/16` 属于 N3，本轮
  未实现也未假装实现。

### 2026-08-09 2A 改动记录

- `src/renderer/index.html`：删除左侧独立“关于”入口和独立视图，将关于卡片迁入“设置 → 关于”；版本号仅保留在关于分类；系统页删除画中画控件和系统页版本号；设置保持在左侧功能项末尾，收缩按钮位于其下方。
- `src/renderer/js/app.js`、`panels.js`、`about.js`：移除字体注入启动链路和画中画事件绑定；进入设置的“关于”分类时渲染版本与系统信息。
- `src/preload/preload.js`、`src/main/index.js`：删除字体 CSS IPC、字体就绪事件、画中画 preload API 和主进程小窗 IPC；保留关于页使用的版本/系统信息 IPC。
- `src/renderer/css/ui.css`：统一使用系统字体，并补充设置/收缩按钮的导航顺序样式。
- `tests/js/settings-2a.test.js`：增加 2A 静态回归检查，确保旧入口、旧 DOM、字体运行时钩子和 PiP 钩子不会回归。

## 4. 当前边界与未完成项

### 需要继续完成

- [x] 重启应用后验证 `RUNTIME_ISSUES.md` 中 R1/R2/R4/R5/R6 的真实运行结果，尤其是 Bangumi token 与收藏接口。
- [x] 2A 实际界面验收：已通过临时调试实例（CDP 驱动）完成实测，全部通过，详见 §7。
- [x] 2B：直播页分页数量纳入设置（pageSizeLive）；下载页「打开下载目录」按钮；本地文件页背景模糊闪烁修复（T54）——均已完成。
- [x] 后续产品整理：“我的”页最近观看与左侧历史的整合方式已确认（历史保留左侧独立视图，最近观看并入“我的 → 最近观看”，收藏入口整合到“我的 → 我的收藏”，左侧独立收藏入口已删除）。
- [x] Kazumi/UI 后续：规则页布局优化（T55）、首页推荐功能（T62）均已完成。
- [x] 时间表后续：完整对齐 Kazumi 时间表——完整季节索引（近 20 年）、封面排名角标、排序/收藏过滤、点击进入二级详情页（T57/T58）。
- [x] TVBox/FongMi G0.1-G0.3：兼容基线、统一运行时错误契约、站点能力模型和确定性离线验收。
- [x] TVBox/FongMi S1.1-S1.4：可终止 Worker 进程隔离、绝对 deadline、聚合取消和熔断恢复。
- [x] TVBox/FongMi C2.1-C2.5：ConfigSnapshot 三层与原子换入、`ext` 完整语义、站点字段矩阵、
  Capability Router、配置安全边界（`run_all.py` 28 阶段全通过）。
- [ ] TVBox 兼容性 N3（drpy / PC 原生运行时）及真实公共仓/发布环境验收：按
  [主任务书](docs/TVBOX_FONGMI_PARITY_TASKS.md) 推进。
- [ ] macOS/Linux 实际打包与运行测试。
- [ ] Windows 安装后首次冷启动验证，包括资源路径、Python 后端和二进制发现。
- [x] 自动更新基础链路已接入 `electron-updater`（打包模式检查/下载/退出安装）；tag 发布 CI（release.yml）已就绪，GitHub 发布仓库与代码签名仍待定。
- [ ] 创建 GitHub 公开仓库并实测 tag→安装包流水线（release.yml 已就绪）；代码签名在建仓后补齐。

### 明确不作为当前待办

- 弹幕产品功能当前关闭。DanDanPlay API、ASS 生成和历史端点虽仍存在，但前端没有启用入口，不应把“补弹幕渲染”当作当前缺陷。
- SyncPlay 同步播放与 DLNA 投屏当前未实现。
- P2P/P3P、ed2k 和 thunder 协议不在当前范围。
- 验证码自动识别/自动过验证不在当前交付范围；现阶段保留检测、打开验证页面和 Cookie 复用。

## 5. 开发约束

1. CatVod 与 Kazumi 必须保持物理隔离：CatVod 走 `/action`，Kazumi 走 `/kazumi/action`。
2. 不修改恢复源码的行为契约。`app.py`、`runner.py`、`trigger.py` 保持原语义，`base/spider.py` 只允许已有 PC 适配。
3. 配置热更新必须先完整构建新状态，再一次性替换；禁止先销毁当前可用配置。
4. 所有异步 UI 请求使用 token/会话号防止过期回调覆盖新状态。
5. 删除和恢复默认等操作统一使用 `confirmDialog`。
6. 本地文件操作必须通过主进程和白名单根，任何解析结果都要再次检查路径未越界。
7. 播放器每次只接收单集；连播由渲染层维护上下文，旧播放会话退出事件不得推进新会话。
8. 解析窗口必须使用隔离 partition，用后销毁并清理 `webRequest` 监听。
9. 新增 UI 文案使用简体中文；所有远程封面使用 `referrerpolicy="no-referrer"` 和统一兜底。
10. 架构或链路变化先更新 [架构说明](docs/ARCHITECTURE.md)，功能状态变化同步更新本文件。

更细的 Spider、mpv、下载和历史决策见 [开发历史](docs/DEVELOPMENT_HISTORY.md)。

## 6. 环境与命令

已验证环境快照：Python 3.14.4、Node 24.18.1、Electron 31.7.7、mpv 0.41.0、aria2c 1.37.0。ffmpeg 等本地扩展由项目脚本准备；MiSans 旧静态资源和辅助脚本仍保留，但应用运行时已不再下载、注入或切换该字体。

```powershell
# 启动完整应用
npm start

# 运行全部 Python 测试、JavaScript 单元测试和语法检查
npm run test:all

# 单独运行后端
npm run backend

# 构建 Python 后端
npm run build:py

# 构建 Windows 安装包
npm run build:win
```

PowerShell 命令不要使用 Bash 的 `&&`；需要连续执行时使用 `;`。

## 7. 最近验证结果

2026-08-26 UI 视觉升级 + 网盘播放策略批次：

- **UI 视觉系统升级**：新增根目录 [DESIGN.md](DESIGN.md) 视觉契约（色彩/排版/圆角/阴影/间距/动效令牌与禁改清单），`ui.css` 按 契约整体重制（543 insertions / 320 deletions）——中性灰阶骨架 + `color-mix` 派生色、多层柔和阴影、微噪点、卡片入场错峰/悬浮抬升/按压反馈、网格空态 CSS 骨架屏；壁纸渲染层重构为 `--wall-url` 单层伪元素（修复大分辨率视口平铺铺不满）。类名/DOM/皮肤挂钩/布局度量等禁改清单项未动。
- **背景图自定义调整**：选图后弹「自定义背景」弹窗——预览框拖动定位（±50%）、缩放/透明度/模糊三滑杆即时联动，与实际壁纸层共用同一套 CSS 变量数学；保存才持久化（`wallpaperAdjust`，纳入 WebDAV 同步白名单）；遮罩强度新增「极弱」档位并与滑杆值双向归位。
- **夸克「转存失败」修复**：接口身份统一夸克 PC 客户端 UA（`QUARK_API_UA`，写操作转存按客户端签名做风控）、分享域名切 `drive-pc.quark.cn`、取流同 UA 防 412；`_QuarkSaveDenied` 硬拒绝不重试（code=41020 判快照令牌过期走实时目录树自愈），502 响应带语义化中文提示。
- **网盘源播放策略收敛**：新增 `src/main/pan-source.js` 统一网盘源判定——原生播放列表对网盘源全局禁用（主进程拒建队 → 渲染层静默回退逐集连播，外部主播放器整季 m3u 同源拦截），边下边播排除复用同一正则，自动线路回退对网盘源禁用（防转存风暴）；Kazumi 规则引擎豁免。
- **小修**：直播外部播放器起播判据改 `launched`（不再误报「直播播放失败」）；全部窗口 `spellcheck:false` 关闭拼写检查红波浪线；WebDAV 同步远程目录默认 `kazumiSync` → `YuKiSync`；网盘 Cookie/WebDAV 密码眼睛图标随明文状态切换。
- 验证：`tests/js/pan-source-playlist.test.js` 7/7（建队拦截/直链协定/Kazumi 豁免/正则同源/回退风暴钉死）；`python-backend/tests/test_quark_pan.py` 24/24 OK。全量回归与实机视觉 QA 待跑。

2026-08-23 打包版用户问题批次（14 项，4 个并行侦查代理定位根因后分簇修复）：

- **封面簇**：①历史页 kazumi 封面拉取失败根因是搜索点击回填的 `{id, cover:''}` 毒条目被
  `getBangumiMatch` 当完整命中永久短路且持久化跨重启——改为完整命中要求 id+cover 齐全、残缺条目
  按 id 拉详情自愈、`_saveBgmMatchCache`/`_loadBgmMatchCache` 过滤 id-only 条目、点击路径改选首个
  带 images 的结果；②「每页数量-搜索」重绘不丢封面（`grp.src` 键名本就正确），补 onViewShown
  条数未变时对可见分组续拉（负缓存 60s 过期后的重试触发点）；③设置页 Bangumi 同步改走
  `My.refreshBangumi()`（作废 localStorage 持久缓存 + 强制重拉 + Timeline 失效），无 Token 不再
  写空列表毒缓存；`_coverFillOne` 对 site='bangumi' 收藏卡改走 Bangumi 匹配管线（原 detailContent
  必 L2 失败，缺图条目永远补不回）。
- **滚动位置**：`App.showView` 集中保存/恢复各视图 scrollTop（display:none 切换会归零滚动位置），
  双 rAF 等布局建立后恢复；详情页固定回顶；新搜索重置滚动记忆。
- **直链截帧**：直链播放记录 site='direct'、vodId=播放 URL、标题取 URL 文件名；历史卡与本地/下载
  文件同待遇异步截帧（ffmpeg 原生支持 http/m3u8 输入，`urlThumb` md5(url) 缓存 + 30s 超时），
  点击直链卡可重播。
- **下载簇**：①全部开始/暂停卡片跳动——render 按 gid 首次出现顺序稳定排列（aria2 分组拼接序在
  RPC 过渡期会抖动）；②完成播放间歇「文件未找到」——`yuki:dl-play` 按旧路径找不到时依次兜底
  `+.mp4`/下载根目录同 basename/持久化记录新路径（完成时自动补 .mp4 改名后 aria2 仍报旧路径）；
  ③新增排序下拉（队列/名称/时间，localStorage 持久化）；④删除任务改三选弹窗（连文件删/仅移除/
  取消），残留收集补齐 HLS `.incomplete`/`.part`/`.adfilter.m3u8`/`.segs` 目录与 aria2 `.aria2`；
  ⑤设置-下载新增「恢复默认位置」（清 dlDir + 迁移 + 重启引擎），`#set_dl_dir_line` 目录展示行
  接通；⑥更换/恢复目录时迁移在途任务：aria2 侧 pauseAll→移文件+.aria2→重启→`continue:true` 重入队，
  HLS 侧 `migrateDir`（代数机制让杀进程后的旧异步续体自弃）+ 分片已存在跳过=断点续传；
  ⑦page 源手动下载对齐播放链——`_resolveDownloadUrl` 解析失败后补 captureDirect 隐藏窗口嗅探兜底。
- **WebDAV 恢复假成功**：后端逐文件吞异常/HTTP 200 空数据恒当成功——`webdav_restore` 改返回
  `{files, ok, error}`（连接错/非 404 HTTP 错/全 404 均判失败，单文件 404 跳过），端点失败回 500+msg，
  前端空数据判失败并透出原因。
- **切分类 L3_RUNTIME_CALL_FAILED**：双管齐下——前端 `_nextLoadToken()` 同代 AbortController
  真正中止在途分类/搜索请求（原令牌只丢弃渲染结果，请求风暴打满站点 worker 串行队列致上游限流），
  失败包络（CALL_FAILED/TIMEOUT/CIRCUIT_OPEN）800ms 后自动重试一次；后端 `CmsSpider._fetch` 对
  连接类瞬时错误退避 800ms 重试一次。
- 验证：`npm run test:all` 全绿——run_all.py 全阶段 ALL PASS（新增 webdav-restore 阶段 5 例）、
  编译 98 文件 0 error、JS 单元 326/326（新增 kazumi-bgmcache-heal 5 例 + downloads-order 5 例）、
  ESLint 0 error（73 条既有 warning）、Ruff 全过。打包/实机 QA 待用户验证。

2026-08-22 开源发布准备（G01–G12，任务书见 git 历史 docs/github.md）：**G01** 敏感扫描——全历史曾跟踪
`TV-fongmi/` 上游源码（729 路径）与 3 个 `*-error.zip` 运行残留，已用 git-filter-repo 清除并重扫零命中
（`.git` 约 39MB→3.6MB；清洗前备份 bundle 留存于临时目录）；当前跟踪的 cookie/token 命名文件均为测试
代码与 `fixture.invalid` 假数据。**G02** 通过：最大跟踪文件 1.16MB。**G03–G05/G06–G09/G12** 新增
LICENSE(GPLv3)（同日依所有者决定由 MIT 改为 GPL）、CHANGELOG.md、CONTRIBUTING.md、CODE_OF_CONDUCT.md、Issue/PR 模板 ×3、
[docs/THIRD_PARTY.md](docs/THIRD_PARTY.md)（mpv GPLv2+ / ffmpeg gyan.dev essentials GPLv3 / aria2c GPLv2 /
Anime4K MIT / MiSans 免费商用逐项核实）与 [.github/workflows/release.yml](.github/workflows/release.yml)
（tag→NSIS→Draft Release；mac/linux 占位待验收）；README 加徽章（OWNER 占位待建仓替换）与许可证章节。
**G10** 首轮基线审计零漏洞：`npm audit --omit=dev`（官方 registry）0 vulnerabilities、`pip-audit --strict`
无已知漏洞；门槛收紧（移除 `|| true`）按观察期执行。**R16 回归修复**：243afd9 重命名漏改
spider-loader.js 致 JS 源调用全挂（详见 [RUNTIME_ISSUES](docs/RUNTIME_ISSUES.md) R16）。验证：
`npm run test:all` 全绿——run_all.py 全阶段 ALL PASS（smoke 13 + phase3 30 + kazumi 18+5 等）、编译
100 文件 0 error、JS 单元 tests 313、ESLint 0 error（69 条既有 warning）、Ruff 全过。发布说明见 CHANGELOG.md。

2026-08-22 R15 修复（合并站点后可用源被旧探测屏蔽误隐藏）：探测/屏蔽持久化结论附带内容指纹
`probeFp`（`api|spiderType`，后端 `/sites` 增量暴露 `api`），指纹不符或缺失即作废重探并当场恢复展示，
同仓重启照常零请求复用；升级后首轮全量重探一次自愈历史误屏蔽。同日回归修正：迁移性全量重探曾把
有影片的慢源批量误杀——①连败计数改只在当前会话内累加（`init` 清跨会话欠账），死源收敛由同会话
补探第二轮保证；②`empty` 与失败包络同阈值（连续两轮确认全空才屏蔽）。验证：home-probe 79 例、
JS 单元 313/313、语法 41 文件 0 错、ESLint 0 error、Ruff PASS、`run_all.py` 全阶段 PASS +
100 文件编译 0 error。

2026-08-18 C2.1-C2.5 验收：`python-backend/tests/run_all.py` 28 阶段全通过、编译 79 个 Python
文件 0 error。四个新阶段共 157 条（config-snapshot 53、ext-semantics 39、capability-router 29、
config-security 36）全部走 `tests/offline_config_server.py` 的 loopback 夹具，不出网；配置形态
覆盖单仓 JSON、多仓 depot（嵌套/全坏/私网子仓/条目截断）、带注释 JSON、gzip 直链、传输层
gzip、JPEG/PNG 伪装、相对路径仓、未知 `type`、内联 JSON 与本地文件，四种载体解出同一个
内容哈希。本轮由测试暴露并修掉两个真实缺陷：`guard_url` 把 Windows 盘符当协议（诊断原因
与真实问题不符）、`detect_text` 只剥一层 BOM（双 BOM 配置被报成第 1 列 JSON 语法错误），
详见 [运行时问题](docs/RUNTIME_ISSUES.md) R13/R14。本轮按任务书停止，未进入 N3。

2026-08-18 S1.1-S1.4 验收：新增 spawn-only `RuntimeSupervisor`；Worker 在不可信加载前等待
Windows Job 绑定，deadline 覆盖排队、启动和收尾，超时/取消以进程树实际退出为证据。
JAR Range 断连可观察上游关闭；50 源连续搜索两次均在总预算内返回；配置/Cookie/用户重试
恢复穿过 HTTP 集成路径。20 次真实 Python/Node 热重载及 FastAPI/Electron 退出无
Python/Java/Node 后代或监听端口残留。`npm run test:all` 全绿：Python 24 阶段、70 文件编译、
Node 225/225、JS 语法 40/40、ESLint 0 error（64 条既有 warning）、Ruff PASS。本轮按任务书
停止，未进入 C2。

2026-08-18 G0.1-G0.3 验收：`npm run test:all` 在允许 Node 子进程的权限下通过；Python `run_all.py`
全部阶段通过并编译 57 个文件，离线兼容矩阵 4/4 通过（超时/无限循环强制终止 2/2、后代
Python 0 残留），Node 单元 222/222，JavaScript 语法 40/40，ESLint 0 error，Ruff 通过。
默认受管 Node 测试会因 `spawn EPERM` 失败，该环境限制已与代码断言失败分开记录。

2026-08-17 回归入口补全 + 配置解析回归修复：`test_kazumi.py`（83 用例）接入 `run_all.py` STAGES，Python 回归从 38 项扩到 121 项（smoke 13 + phase3 25 + kazumi 83），`npm run test:py` 全绿。接入后即捕获一处 HEAD 回归：7816695 的 `_strip_json_comment_lines` 无条件先剥行内 `//`，损坏内嵌 JS spider 源码（phase3 `ijs` 站点加载失败）——已改为严格 JSON 先行解析、注释剥除仅兜底（aa9002f）。同批：夸克 Cookie 误入库处置（214a8c8，DuoDuo/.quark 解除跟踪 + jar JVM cwd 固定到 `<cache>/jar-runtime`）。

2026-08-17 TVBox Phase A–E 代码收口：兼容套件 S1/S2/S4 改走真实 FastAPI `/action`，新增重试、离线 SKIP、JSON 报告和分层 skipped 原因聚合；新增端口泛化与夸克降级行为测试；`YUKI_PAN_FAST_PATH` 接入设置页；L1-L4 诊断、QuickJS 缺失全局警告和配置导入摘要完成；新增 TVBOX_CONTRACT_GAPS.md 与 DATA_MAP.md（两文档已于 2026-08-22 文档精简时归档删除）。渲染层 17 个脚本完成 `YUKI.<module>` 导出，兼容浏览器与 VM 测试环境。验证：Python 全量回归 ALL PASS、JS 单元 206/206、JS 语法 40/40、ESLint 0 错误、Ruff PASS。21 仓网络基线与实机/发布验收仍待外部环境。

2026-08-10 全量功能测试（已完成）：自动化测试共 **200 项全部通过**——JS 单元 60/60、Python 38/38（smoke 13 + phase3 25）、JS 语法 34 文件 0 错误、真实界面验收 10 个脚本 **102/102** 检查项（内容页/系统页/时间表/推荐/详情卡/我的页/观看统计/Kazumi 布局/分页滚动条/MiSans）。完整功能测试矩阵、自动化明细与需用户实测清单见 [docs/TEST_REPORT.md](docs/TEST_REPORT.md)。

2026-08-10 UI 打磨与性能优化（T65/T66）：列表批量渲染（home/live/records/timeline 由逐条 append 改拼串单次写入）+ 响应式卡片/字号（宽窗放大、窄窗缩小）；JS 语法 34/34、单元 60/60、`acceptance-bugfix.js` 6/6 通过（收藏 25 条分页渲染 + 滚动条隐藏 + 应用启动无本轮相关错误）。

2026-08-10 Bug 清理批次真实界面验收（已完成）：临时调试实例 + CDP 实测（`scripts/acceptance-bugfix.js`），**6/6 全部通过**：预置 25 条收藏，「我的 → 我的收藏」首页渲染 20 条、分页器可见、翻页后第 2 页显示剩余 5 条（分页功能实测正常）；`#view-my` 视图 `scrollbar-width:none`（滚动条已隐藏）；「我的」页仅两标签（无最近观看）；无本轮相关文件控制台错误。

2026-08-10 返工两项真实界面验收（已完成）：临时调试实例 + CDP 实测（`scripts/acceptance-rework.js`），**10/10 全部通过**：「我的」页仅 观看统计/我的收藏 两标签、无最近观看标签与面板 DOM；时间表卡片点击进入 `#view-bangumi-info` 二级详情视图（渲染 banner 与分集/角色/制作/评论/关联页签），源弹窗未弹出（非弹窗交互），返回键回到时间表；无本轮相关文件控制台错误。

2026-08-10 时间表完整复刻真实界面验收（已完成）：临时调试实例（独立 userData 副本清空 `lastConfigUrl`、跳过引导）+ CDP 实测（`scripts/acceptance-timeline.js`），**11/11 全部通过**：季节下拉含「本周（在播）」+ 近 20 年季度选项（≥70 项）按年 optgroup 分组；排序下拉三模式默认热度；收藏过滤行三 chip（无 token 置灰降级）；星期 tab 7 个默认高亮今天；切换历史季度进入 season 模式触发检索；时间表网格渲染本周 14 张卡片、8 个排名角标（真实 Bangumi 数据）；无 timeline.js 相关控制台错误。后端 `TestBangumiSeason` 4 例、前端 `timeline.test.js` 8 例通过；`test:py`/`test:jsunit`/`test:js` 全绿（JS 60/60）。

2026-08-10 T54/T55 + YuKi 更名真实界面验收（已完成）：临时调试实例（独立 userData 副本清空 `lastConfigUrl`、跳过引导）+ CDP 实测（`scripts/acceptance-t55.js`），**13/13 全部通过**：软件名 title/关于均为 YuKi；Kazumi 5 卡渲染并入全宽组（grid-column 1/-1）、规则行两行主块/时间可见/去折名/去误导 pointer/清空危险色；本地文件 `#view-tools` 不再应用 viewIn 入场动画且模糊卡保留 blur(8px)，首页对照视图仍有入场动画；无本轮相关文件控制台错误。

2026-08-10「我的」页与观看统计真实界面验收（已完成）：临时调试实例（独立 userData 副本预置 favorites/recentWatches/watchStats 测试数据、清空 `lastConfigUrl`）以 `--remote-debugging-port` 启动，经 CDP 实测（`scripts/acceptance-my-watch.js`，零依赖），**24/24 全部通过**：

- 观看统计链：渲染层真实 IPC 链路模拟断流重连，重连后 totalSeconds = 30+增量 30 = 60（非 30+60 双计）、观看次数只 +1、标题计数不重复、链内最大进度 60。
- ended 会话归属：当前会话 ended 判看完；旧会话延迟 ended 不误判新会话；新会话自身 ended 判看完。
- 「我的」页三标签切换 active 状态与面板显隐正确；收藏面板渲染/搜索过滤/标签筛选/多选删除（含确认对话框，删除后 settings.favorites 同步减条）/最近观看卡片（来源/时长/进度条）/统计数值（60s→1 分钟、1 次、1 部、7 天柱）。
- 旧收藏路由重定向到「我的 → 我的收藏」；本轮相关文件无控制台错误（仅一条与本轮无关的 Electron CSP 安全提示）。

2026-08-09 本轮 2A 代码验证结果：

- Python 全量测试：38 项通过（smoke 13、phase3 25、编译检查 29 个 Python 文件）。
- JavaScript 单元测试：45/45 通过，包含本轮 2A 回归测试。
- JavaScript 语法检查：33/33 通过。

2026-08-09 2A 实际界面验收（已完成）：用临时调试实例（独立 userData 副本清空 `lastConfigUrl`，避免 auto-reload 干扰）以 `--remote-debugging-port` 启动，经 CDP 实测，全部通过：

- 导航顺序：设置按真实几何排序位于左侧功能项末尾（`order:98`，其余功能项之上），收缩按钮在其下方并贴导航底部（`order:99`/`margin-top:auto`）。
- 关于分类：设置 → 关于渲染版本号 `0.1.0` 与系统信息（Electron 31.7.7 / Chromium 126 / Node 20.18 / V8 / win32·x64），技术栈与致谢完整。
- 系统页：无画中画控件、无版本号。
- 页面无 MiSans 动态注入：仅加载 `ui.css`，无 MiSans `link`/`@font-face`，根字体为系统字体栈。
- 控制台无错误（仅一条与 2A 无关的 Electron CSP 安全提示）。
- 验收脚本：`scripts/acceptance-2a.js`（临时脚本，独立实例运行，结束自动清理；不污染真实用户数据）。

此前的临时调试实例因浏览器控制连接中断未计为通过；本轮已重新启动独立实例完成实测。

## 8. 历史批次摘要（已归档）

> 本节保留早期会话的详细验收与 T/U 批次记录，仅用于追溯；当前状态、当前待办和最新测试口径以上方第 1–7 节及专项文档为准。完整历史见 [开发历史](docs/DEVELOPMENT_HISTORY.md)。

### 8.1 2026-08-09 用户任务整理与执行状态

### 已完成（本轮已写入代码并通过 JavaScript 验证）

- [x] 修复统一封面失败兜底：封面原图加载失败切换占位图后同步显示，避免因 `opacity:0` 看起来空白。
- [x] 修复搜索来源提示固定显示 20 条的问题，改为使用当前搜索分页设置值。
- [x] 增加直播分页设置项 `pageSizeLive`，接入设置页回填、保存和直播页分页计算。
- [x] 下载页增加“打开下载目录”按钮，复用既有下载目录 IPC，并提供失败提示。
- [x] 删除左侧独立“收藏”导航入口，开始将收藏与最近观看迁移到“我的”页面内部标签结构。
- [x] 完成“我的”页面内部三标签（观看统计/我的收藏/最近观看）的数据渲染与收藏操作接入：`my.js` 复用 `records.js` 的 `makeRecordView` 工厂（新增容器选择器参数）接入 `#my-panel-favorites`，支持搜索、标签筛选、分页、多选删除、批量标记想看/已看；`app.js` 旧收藏路由重定向到“我的 → 我的收藏”；`detail.js` 收藏提示改为“我的 → 我的收藏”。
- [x] 修复观看统计链路：`ended` 事件携带会话号并按会话匹配“看完”判定，起播时重置上一集 ended 时间戳；观看统计按观看链去重，断流重连复用旧链元信息、退出只补进度增量且不重复计次数/部数。
- [x] 已运行 `npm run test:js`：33 个 JavaScript 文件语法检查通过。
- [x] 已运行 `npm run test:jsunit`：52/52 个 JavaScript 单元测试通过（含新增的观看链去重、ended 会话归属、`mpv end-file eof` 会话测试）。
- [x] 2026-08-10「我的」页与观看统计真实界面验收：临时调试实例（独立 userData 副本预置收藏/最近观看/统计测试数据，清空 `lastConfigUrl`）+ CDP 实测，24 项全部通过，详见 §7。验收脚本 `scripts/acceptance-my-watch.js`（临时脚本，独立实例运行，结束自动清理，不污染真实用户数据）。

### 2026-08-11 首页空分类隐藏加固（T60 续）

- [x] 空分类结果持久化：`Home._emptyCls` 按 site 落盘到 `localStorage['yuki_home_empty_classes']`（`{ site: { ts, empty, ok } }`，兼容旧数组格式），`init()` 时载入——再次载入该源/重启后首屏即隐藏已知空分类，无「先闪现再隐藏」；源集合变更时同步清空持久化。
- [x] 探测不丢进度：结果按 site 键隔离记录，不随 token/换源丢弃——中断/换源不影响分类，任一轮完整探测即全部分类；`unclassified===0`（全部分类确认）才标记 `_clsProbed[site]`，出错留待下次载入重试且只探测未知分类；`_clsBusy[site]` 防并发重复探测。
- [x] **全源探测**：新增 `_probeAllClasses()` 后台扫描——为所有未探测分类的活跃源补齐类别空态探测（站点级并发 2、分类级并发 6），切换任意源即可直接过滤空分类；数据新鲜（`EMPTY_CLS_TTL` 24h）的源跳过不重复探测，过期/缺失才补探。
- [x] `renderClass` 激活分类判断做 `String(type_id)` 归一化，防数字型 type_id 误隐藏激活分类；曾判空分类恢复内容后自动取消隐藏并重渲。
- [x] 测试与验收：`tests/js/home-probe.test.js` 19 例（分类/门控/中断不丢进度/换源不重渲/出错重试/恢复显示/持久化往返+旧格式兼容+新鲜/过期/全源扫描/过滤）；`scripts/acceptance-empty-class.js` 6/6 PASS（内置离线 demo 源）；真实源诊断（`scripts/diag-real-app.js`，用户真实多仓配置）7/7 PASS——后台扫描自动探测 ≥5 个未选中源、量子资源（电影资讯/新闻资讯/娱乐新闻/演员空分类消失）+ 新浪资源 + 豆瓣资源探测完成且空分类全部隐藏、持久化多源落盘、无 home.js 控制台错误。

### 2026-08-11 推荐页切换卡顿修复

- [x] 卡顿根因：`Popular.enter()` 首次进入推荐页时同步等 `kazumiBangumiTrends` 网络请求（真实源实测 ~1.9s，命中 api.bgm.tv），期间网格空白 → 感知为「切换卡顿」。切换本身（showView 同步部分）实测仅 4ms。
- [x] 修复：①推荐（热门番组）数据本地缓存 `localStorage['popular_cache']`——首次进入先命中缓存立即上屏，再后台静默刷新；无缓存才等网络 ②启动时后台预载 `Popular.preload()` 填充内存并刷新缓存，点开推荐页即时显示、无首次网络等待 ③`load(page, silent)` 静默模式不弹 loading/toast，不打断已见内容；标签视图不覆盖热门番组缓存。
- [x] 测试与实测：`tests/js/popular-cache.test.js` 5 例（缓存命中上屏+后台刷新/无缓存加载+写缓存/会话内复用不重拉/silent 不弹 loading/标签不覆盖缓存）；真实应用 CDP 实测——点开推荐页网格填充耗时 **1906ms → 6ms**、showView 同步 0ms、无长任务。

### 2026-08-11 每页影片数量超过 20 不生效修复（T75）

- [x] 根因（真实源 CDP 实测，pageSizeHome=36）：①首页填充 `_extendHome` 只取 `classes[0]`（首个分类）——量子资源首个分类「电影片」仅 1 条，首页只显示 1 张卡，填不满设置条数；②分类页 `_fetchCat` 只取源返回的一页（源每页 ~20 条）→ 设 36 也只显示 20。
- [x] 修复：①首页填充改为逐分类逐页推进，首个分类空页/短页（<10 条）自动换下一个分类，直到填满目标（含 `_onResize` 补拉）；②分类页新增 `_catWin` 源页合并窗口（site|tid LRU）——`_fetchCat` 连续拉取后续源页合并填满每页条数，应用 pagecount = ceil(源总量/每页条数)，前进/后退翻页复用已拉数据不重复请求；force 刷新/切源/配置变更作废窗口。
- [x] 测试与实测：`tests/js/home-probe.test.js` +3 例（合并 2 源页得 36 条/翻页只补缺失源页/短页跳分类填满目标）；真实源 CDP——首页填充 1→46 卡（≥36）、分类页(动作片)显示 36 条、pagecount 137、翻第 2 页内容不同；全量回归 + 空分类隐藏实测通过。

### 2026-08-11 「全部」标签分页（T76）

- [x] 问题：「全部」标签是首页自适应视图（推荐位 + 分类铺满一页），末尾 `$('#home-pager').empty()` 明确清空分页器——设计上单页、无法翻页浏览源全部内容。
- [x] 修复：①后端 `homeVideoContent` 支持分页——`cms_spider.py` 返回 page/pagecount/limit/total/list，`server.py`/`app.py`/`runner.py` 透传 `pg`（runner 对不接受 pg 的旧爬虫 try/except 回退）；②前端 `loadHome(pg)`——第 1 页保持自适应首页，第 2 页起用源总览 feed（`_fetchHomeFeed`，复用 `_catWin` 合并窗口 key `site|__all__`，合并源页填满每页条数，翻页只补缺失源页）；③第 1 页载入后 `_probeHomeFeedTotal` 后台取 feed 首页定总页数并渲染分页器（总页数 = 1 自适应首页 + ceil(源总量/每页条数)；源无「全部」feed 则单页不出分页器）；`renderPager` mode=home 跳转 `loadHome(pg)`，刷新保留当前页。
- [x] 测试与实测：`tests/js/home-probe.test.js` +4 例（feed 第 2 页合并得 36 条/翻页只补源页 3,4/第 1 页定总页数并出分页器/无 feed 单页）；真实源 CDP（pageSizeHome=36）——「全部」第 1 页出分页器（pagecount 4138）、真实点击「下一页」→ 第 2 页显示 36 条 feed、第 3 页正常、页间内容不同；后端 `homeVideoContent pg=2` 返回 20 条 + total 148923；Python/JS/验收全绿。

### 2026-08-11 修改配置/每页条数后回到页面不立即生效修复（T77）

- [x] 问题：重新载入源配置（改分类）或改每页条数后，回到分类页仍显示旧缓存内容，需手动点刷新（force 清缓存）才生效。根因：`_pageCache`（分类页缓存）和 `_catWin`（合并窗口）在配置重载/改每页条数时未作废——`loadSites` 的源集合变更分支只重置了空分类探测状态，未清 `_pageCache`；改每页条数只清了 `pageSizeOf` 缓存，未清分类内容缓存。
- [x] 修复：新增 `Home.invalidatePageCaches()`（清 `_pageCache` + `_catWin`）；`loadSites()` 开头调用（覆盖配置重载/屏蔽源变更/启动），`invalidatePageSizeCache()`（common.js）改每页条数时联动调用。回到页面即命中新数据，无需手动刷新。
- [x] 测试与实测：`tests/js/home-probe.test.js` +1 例（invalidatePageCaches 作废两缓存）；真实应用 CDP——`loadSites` 后 `_catWin` 由 2→0（修复前不清）、离线 demo 源验证 `invalidatePageSizeCache` 清空 Home 内容缓存 + pageSizeOf 缓存；全量回归通过。

### 2026-08-11 「全部」标签按设置每页条数显示（T78）

- [x] 问题：设每页条数后，「全部」第 1 页（自适应首页：推荐位 + 各分类逐页铺满）显示条数与设置不符——首个分类内容少/源限流时填充极慢（实测 30s 未到目标、量子资源只到 6 条），而第 2 页起的 feed 正常（严格 = 设置条数）。
- [x] 修复：「全部」**所有页统一用源总览 feed**（`homeVideoContent`，合并源页填满每页条数）——`loadHome(pg)` 第 1 页也走 `_fetchHomeFeed`，`_fetchHomeFeed` 公式改为 `slice((pg-1)*size, pg*size)`、总页数 `ceil(源总量/每页条数)`（去掉第 1 页自适应首页的 +1 偏移）；仅当源不支持 homeVideoContent（feed 空）时，第 1 页回退自适应首页（推荐位 + 分类铺满），此时单页不分页。删除冗余 `_probeHomeFeedTotal`。
- [x] 测试与实测：`tests/js/home-probe.test.js` 更新 T76 用例（第 1 页 = feed 前 size 条、总页数无 +1、翻页补源页、无 feed 返回空触发回退）；真实源 CDP（PS=24）——「全部」第 1 页 **24/24 条**（原 6 条）、第 2/3 页 24 条、分页器渲染（PS=36 时 pagecount 4137、8 按钮、点「下一页」36 卡）；全量回归通过。

### 2026-08-11 「全部」底部分页器消失修复（T79）

- [x] 问题：T78 后「全部」标签分页器在部分源上消失。根因：`_fetchHomeFeed` 的总页数逻辑在 feed 有内容但源不返回 total/pagecount（如默认源 zp059，返回 20 条、total=0）时设为 `max(1, pg)=1` → `renderPagerBox` pagecount≤1 不渲染；旧 `_probeHomeFeedTotal` 在此情形会设成 2。
- [x] 修复：`_fetchHomeFeed` 总页数逻辑对齐分类页「未知总量暂允试下一页」——`total>0` 用 `ceil(total/size)`；已拉空（`items<need`）按实际条数；否则 `max(this.pagecount||1, pg+1)`，保证 feed 有内容就有分页器可翻页。
- [x] 测试与实测：`tests/js/home-probe.test.js` +1 例（feed 有内容无总量 → pagecount 2、翻页 pagecount 3）；离线 demo 源 + 桩 doAction 确定性验证——「全部」pagecount 2、分页器 6 按钮、20 条；全量回归通过。

### 2026-08-11 设置改每页条数后回页面不更新修复（T80）

- [x] 问题：设置里改完每页影片数量，返回对应页面（首页/分类）每页条数没更新，需手动切换页面或点刷新。根因：改页数只清了 `_pageSizeCache` 和分类内容缓存，但 `showView('home')` 不会重渲染当前模式（分类/全部仍用内存里的旧列表与旧分页器）。
- [x] 修复：`Home.invalidatePageCaches()` 置 `_pageSizeDirty` 脏标记；新增 `Home.onViewShown()`——回到首页视图时若脏，按当前模式（分类→`loadCategory`、搜索→`searchCurrent`、全部→`loadHome`）以新条数自动重载并清标记；`app.js showView('home')` 调用 `onViewShown()`；`loadHome` 完整重载后清标记。
- [x] 测试与实测：`tests/js/home-probe.test.js` +2 例（invalidatePageCaches 置脏、onViewShown 按模式重载/未脏不重载）；离线 demo 源 CDP——改页数→切设置再回首页：脏标记 true→false、`_loadToken` 变化（触发重载）、新页数 36 生效；全量回归通过。

### 2026-08-11 首页探测进度条（T81）

- [x] 需求（与用户商量确认）：启动/配置重载后的后台源探测（`_probeSites` 屏蔽无内容源 + `_probeAllClasses` 隐藏空分类）在首页显示进度条。时机：**合并两个探测为总进度**；**超过约 1 秒才显示**（避免快速探测闪现）；**完成显示「已完成」约 1.5 秒后淡出隐藏**。
- [x] 实现：`home.js` 新增 `_probeBar` 状态与 `_startProbe(total)`/`_probeOneDone()`/`_endProbe()`/`_updateProbeBar()`/`_hideProbeBar()`——`_probeSites` 按源、`_probeAllClasses` 按源各计进度，合并 total/done；1s 阈值用 showTimer 控制，完成态用 doneTimer 延迟 1.5s 隐藏；`index.html` 首页 `#home-probe-bar` 复用搜索进度条 `.search-status`/`.ss-*` 样式（spinner + 进度条 + X/Y 计数）。
- [x] 测试与实测：`tests/js/home-probe.test.js` +3 例（合并两探测总进度/完成态延迟隐藏/total≤0 不计入）；离线 demo 源 CDP 直接驱动——开始不显示、超 1s 显示「正在探测源…0/100」、完成态「已完成100/100」、1.5s 后隐藏；全量回归通过。

### 2026-08-11 搜索进度条卡顿修复 + 显示逻辑统一（T82）

- [x] 问题：搜索进度条搜索时 spinner 旋转动画卡顿——`_setStatus` 每次源完成都用 `.html()` 重建整个进度条（含 spinner 元素），CSS 旋转动画每次重置（源多时 ~141 次重建）；且搜索一开始就显示（与首页「超 1s 才显示」不一致）。
- [x] 修复（与用户商量确认）：①common.js 新增 `renderStatusBar($el, opts)`——spinner 元素一次性创建、后续只更新文字/进度条宽度/计数，动画不中断；②search.js `_setStatus` 重写——显示逻辑同首页：**有首个结果(recv>0)或超 1s 才显示**（避免快速搜索闪现）、**完成态约 1.5s 后淡出隐藏**，`run`/`stop` 重置状态；③home.js `_updateProbeBar` 改用 `renderStatusBar`（修同样的隐患）。
- [x] 测试与实测：CDP 实测（离线 demo）——spinner 元素跨更新稳定不重建、搜索 recv=0 不显示→超 1s 显示「0/50」→计数 7/50 更新→完成态「已完成」→1.5s 后隐藏；JS 单测 120、语法 34 文件、demo 验收全绿。

### 2026-08-11 搜索页签切换进度条凭空出现/常驻修复（T83）

- [x] 问题：点击聚合搜索/Kazumi 源页签，进度条会重新出现并常驻。根因：`search.js` 页签切换 `$('#search-filters, #search-status, #search-results').toggle(!isImage)`——切到聚合/Kazumi 时 `.toggle(true)` **无条件显示 `#search-status`**，即使没有任何搜索在进行；无搜索就不会触发隐藏逻辑 → 常驻。
- [x] 修复：①`#search-status` 改为 `$('#search-status').toggle(!isImage && this._statusShown)`——只在有进行中的搜索状态时才随页签显示；②`_setStatus` 显示路径（recv>0 / 1s 定时器）加 `_stab !== 'image'` 守卫——切到「以图搜番」页签时搜索仍在后台跑但状态不显示。
- [x] 测试与实测：CDP 实测（离线 demo）——无搜索切聚合/Kazumi 进度条隐藏（修复前显示）；有搜索按页签显隐（聚合/Kazumi 显示、以图搜番隐藏）；以图搜番页签下 `_setStatus(recv>0)` 不显示；全量回归通过。

### 2026-08-12 UI/功能批次（T1–T23，按 `.omo/plans/ui-batch-2026-08-11.md` 分 7 批并行执行）

- [x] **B1 记录系统（T4/T5）**：记录新增唯一 `uid`（`recGet` 迁移回填、`recCard` 输出 `data-uid`），历史/收藏的删除/编辑/标签/多选删除 6 处判定改按 `uid`（`updateProgress`/`getProgress` 仍用 `site|vodId` 条目级身份）；历史卡新增 `kazumi:` 分支（镜像 search.js → `openSourceDialog`），`kazumiSrc` 源页 URL 从 kazumi.js 经 `Player.play`→`_curMeta` 穿到记录；堵住 `Detail.vodId` 泄漏与跨引擎按名合并；`openBangumi` 清 `_vod` 防写 `site:''` 收藏；「我的→收藏」标签绑定选择器修正。records.test.js 13/13。
- [x] **B2 推荐/直播（T1/T2/T3/T14）**：推荐标签弹窗改原生 `#popular-tags` 下拉（首项「热门番组」）；直播默认跳过 redirect/live 项；频道检测复用 `renderStatusBar` 进度条（`#live-probe-bar`，1s 延迟显示 + 1.5s 完成隐藏 + `_probeToken` 作废）；外观新增「推荐」每页数量 `pageSizePopular`（选项限 ≤50 对齐后端趋势上限）。
- [x] **B3 卡片布局（T7/T8/T9）**：`fmtTime` 改 `YYYY-MM-DD HH:mm`；`.rec-playinfo` 补 `padding` 与标题左对齐（含响应式档）；移除「Bangumi 收藏」备注文字（保留封面角标）；`.rec-progress` 由绝对定位改入正常流（不再被圆角裁切）。
- [x] **B4 下载页（T11/T12/T13）**：五个工具栏按钮统一尺寸（去 `md-btn-sm`）；`.dl-list` 加 `margin-top` 消除与首卡重合；总速度常显（空闲 `0 B/s`）；HLS 速度从 ffmpeg `size=` 差分计算（异常安全回落 0，历史记录仍 0）。
- [x] **B6 收藏上传 Bangumi（T6）**：`uploadFavoritesToBangumi` 批量把非 bangumi 收藏按 `tag→type`（1想看/2看过/3在看/4搁置/5抛弃）幂等 set 到 Bangumi（免远端读绕开 100 上限），回写 `bangumiId` 避免重算，单条失败不中断；「我的→收藏」同步按钮先上传后拉取，汇总 toast。新增 kazumi-bgm-upload.test.js 7 例。
- [x] **B5 统计/进度/日志（T10/T18/T21）**：观看统计新增分来源（近 200 次，可选 `bySite` 累加器）、按星期分布（近 30 天）、最常观看（归一化近似重名）三块，`.my-stats-grid` 自适应 + 全量 `escHtml`；Kazumi 检测有效性真进度条（后端 `check_validity` 逐条写共享 `_validity_results` + 暴露 `total`，`_pollTask` 泛型进度条，批量更新搭车）；应用日志逐文件 try/catch（单文件锁定不作废整体）+ 来源过滤下拉 + 翻页请求前钳位 + `clearLogs` 真实计数/写入器 `_size` 复位 + 渲染端 `window.onerror`/`unhandledrejection` 上报。
- [x] **B7 设置页搬迁/文案（T15–T23）**：缓存卡宽度对齐外观（并入全宽组 `grid-column:1/-1`）；「指定 mpv.exe 路径」→「指定播放器路径」；`catvodBgmMatch` 开关移入「Bangumi 同步」；查看 Cookie 改 `#kazumiCookieDialog` 弹窗；Cookie 管理 + Bangumi 封面缓存移入「缓存」分类；恢复默认设置删内联提示、说明移入二次确认弹窗；关于页数据校正。
- [x] 修正 T74 全矩阵实现导致的 3 个陈旧收藏测试（`test_update_collection_put_ok` 等 mock 用旧 `raise_for_status` 语义，实现已改 `status_code` 检查）——测试对齐实现，test_kazumi 78/78。
- 验证：`npm run test:all` 全绿——Python smoke 13 + phase3 25 + compile 29 文件 0 错、JS 单元 131/131、JS 语法 34 文件 0 错。真实界面 QA 待用户在打包/运行环境实测。

### 2026-08-12 用户问题批次（8 项，并行子代理分批修复）

先只读侦查（4 个 explore agent）定位根因，再按 ui.css/detail.js 冲突约束分批委派修复，每批验证后提交。

- [x] **#5 MiSans 字体点击后回退系统字体**：真实 Chromium 探针确认非字重问题（330/630 单值经 CSS 匹配算法能命中 400/500/600/700）；根因是原生 `button/select/input/textarea` 在 Chromium 不继承 `font-family`（UA 样式表给 Arial），无 `.md-*` 类的原生控件回退系统字体。修复：全局 `button,select,input,textarea,optgroup,option{font-family:inherit}`。附：Windows 原生 `<option>` 展开列表由 OS 绘制无法用 web 字体（平台限制，已注释）。
- [x] **#2 收藏按钮 + 时间表筛选失效**：timeline `_buildColSets` 统一 `subject_id||subject.id||id` 取键 + `Number(type)` 归一（字符串 type 致集合恒空、过滤失效是根因）；`kazumi._applyBangumiColState` 同样 `Number(col.type)` 归一（否则设置成功后按钮不高亮，被误判失败）。+4 timeline 单测。
- [x] **#1 Bangumi 封面 1080p 锯齿**：根因是各处统一取 `images.large`(~600px+)，而卡片仅渲染 140-220px，1080p 降采样产生锯齿。新增 `bangumiCover(images,size)` 助手——网格/卡片用 `common`(~300-400px)、detail 用 card 尺寸；旧缓存 large URL 按 `lain.bgm.tv` 路径段迁移(`/l/→/c/`)。替换 6 文件 12 处取图 + 缓存迁移。+10 单测。
- [x] **#4 Kazumi 源验证码弹窗**：发现真实断链——`server.py` 直调 `kazumi_engine.search()`(把 `CaptchaRequiredException` 吞成普通 error)，而非 `search_with_captcha_retry()`(转成 `captcha_required` dict)；渲染层 `status==='captcha'` 的验证按钮永不出现，可见窗口流程虽完整却不可达。改两处 search 路径为 retry 包装，6 段链路(渲染→preload→ParseWindow→cookie_jar→rule_engine)打通。
- [x] **#8 安装包可选播放器 + 无播放器错误**：`oneClick:false` + `build/installer.nsh` 自定义 nsDialogs 复选框页「安装内置播放器(mpv)」(默认勾选)，取消则 `customInstall` 删 `resources/vendor/mpv`；应用内「设置→扩展」一键补装(下载到 userData + `setCustomPath`)兜底。无播放器崩溃兜底：`mpv-player.play()` spawn 前 `fs.existsSync` 二次校验 + `proc.on('error')` 捕获 ENOENT/EACCES(此前未监听会崩主进程)，广播 `spawn-error`→友好中文提示。+4 单测。
- [x] **#6 详情页重设计**：hero 横幅(封面+标题+放送/评分星级/Bangumi 排名/评分柱状分布+收藏/开始观看) + 概览/分集/角色/制作/评论/关联 tab 条现代化；CatVod 线路/选集与 Bangumi-only 分流渲染；保留全部 JS 依赖的 id/class 与收藏态归一修复。
- [x] **#3 下拉选择器统一美化**：`.md-select` 统一 `appearance:none` + 自定义 SVG chevron(`--md-select-chevron` 明暗两套令牌) + padding 避让，清晰 focus/hover/disabled 态；保留 timeline/toolbar 依赖的 min-width/height 几何与全局 `select{font-family:inherit}`。
- 验证：`npm run test:all` 全绿——Python smoke 13 + phase3 25 + compile 29/0、JS 单元 149/149、JS 语法 34/0。真实界面 QA(打包/运行、封面清晰度、验证码实解、安装器勾选)待用户在实机环境实测。

### 进行中

- 无（本轮两项已完成代码验证与真实界面验收；后续项见 §4「需要继续完成」与「未完成」清单）。

### 2026-08-24 原生播放列表、中文菜单与 Anime4K 快捷键（ca3dad5）

- [x] **原生播放列表**：新增 `src/main/playlist-proxy.js`——在线整季不能预解析直链（懒解析+签名时效+风控），每集映射为本地代理地址 `http://127.0.0.1:<port>/pl/<token>/<index>`，mpv 打开哪集才向后端 `playerContent` 解析哪集并 302 交真实 CDN；Kazumi 源经隐藏窗口 `captureDirect` 二段解析。边界：仅支持直连源（parse=1/DRM/空地址返回 502 + toast 并停队），会话 TTL 2h、上限 8 个；Range/Seek 由 mpv 直连上游不占代理带宽。静态直链批量直接进 mpv 原生队列。
- [x] **队列逐集记账**：原生队列 mpv 进程内推进不逐集退出——观看统计/历史改逐集 `ended` 记账，每集独立观看链（整季共用一条链会被链内去重扣成约一集），收藏进度逐集更新；`<15s` 短播不计入口径与旧逐集会话一致。
- [x] **右键中文菜单**：新增 `src/main/mpv-menu-conf.js` 译制 mpv `etc/menu.conf`（官方不做本地化），TAB 分隔/4 空格层级格式注入 userData，`--script-opt=select-menu_conf_path` 指定；仅译文案与 OSD 文字，命令与条件表达式原样保留。轨道/章节二级列表标题硬编码于 select.lua 无法汉化。
- [x] **Anime4K 快捷键**：hints.lua 注入 `a4k-<mode>` script-binding 写 `user-data/yuki/a4k-request`，主进程消费后运行时替换 glsl-shaders 链（无需重启）+ 持久化设置 + 广播 `yuki:a4k-changed` 同步设置页；`K` 键循环档位；菜单勾选态由启动时写入的当前档位驱动。修复过两处真实缺陷：lua 脚本命名空间错误致菜单点击落空、属性读取 API 不当致 K 键循环恒回第一档。
- [x] **上/下一集快捷键**：PGUP/PGDWN 触发 `yuki:episode-skip`，渲染层按当前线路推集回退。
- [x] **夸克会话自动续期**（go_proxy.py）：清共享 jar 前捕获响应滚动的夸克会话字段（__pus/__puus 等）节流合并回加密存储——修复 L-18 清 jar 设计把 Set-Cookie 轮换整体丢弃、Cookie 单向陈旧最终全量 412 的事故根因；6h±抖动低频保活探针维持会话活跃，412 标记可疑供自愈评估。
- [x] **Bangumi 分页聚合**（plugin_manager.py）：`_aggregate_pages` 自动翻页补足单次拉取总量（页间 0.3s 限速防风控、单页钳制 50），修复渲染层每页数量 60/120 设置触发上游拒绝导致整页空白；WebDAV 同步远程目录拼接补路径穿越守卫。
- [x] **打包资源定位**（134101a）：新增 `python-backend/hoststate.py` 宿主状态探测（端口/缓存目录/代理地址，替代 Android Java 桥）+ `~/.video-pc → ~/.yuki` 兜底迁移；冻结入口/只读目录下 Python 后端发现与二进制资源根解析修复（download-binaries/python-bridge/mpv-player 配合改造）。
- 验证：`tests/js/dl-dedupe.test.js` 10 例 + playlist-proxy/menu-conf/player-watch 等新单测，JS 单元 365/365、lint 0 错、check-js 44 文件 0 错；Python 侧 test_circuit/test_quark_session_refresh/test_webdav_conn/test_kazumi_cover_proxy/test_frozen_entrypoint/test_resources_root 新增接入 run_all.py（40 阶段）。打包/实机 QA 待用户验证。

### 2026-08-24 边下边播去重（同源同集不重复下载）

- [x] **同源同集下载去重**：新增 `src/main/dl-dedupe.js`——以「站点|剧名|集名」为稳定 key（直链带签名时效不能作 key；vod 一律用剧名使手动下载与播放链归到同一 key）。入队即写携带 `epKey` 的完整初始记录（跨重启可恢复、查重立即可见）；查重命中「进行中且任务存活 → downloading」「已完成且产物文件在 → done(file)」，失败/文件已删/引擎孤儿记录放行重下。
- [x] 接线点：`yuki:dl add/addHls`（详情页/Kazumi 手动下载，命中返回 `already-downloading`/`already-done`，渲染层 toast 汇总跳过数）；`yuki:play` 边下边播注册（T9，命中静默跳过不再建重复任务，修复此前每次重播/续播都重复下载）。`epKey` 全链路保留：persistInProgress、aria2/HLS 完成/失败事件、目录迁移重排与重启后恢复入队（gid 变更经 `carry` 转移）、删除任务同步清登记。清除列表/删除任务后允许重新下载（与用户直觉一致）。
- 验证：`tests/js/dl-dedupe.test.js` 10 例 + JS 单元 365/365、lint 0 错、check-js 44 文件 0 错。

### 未完成

- [x] Kazumi 独立首页推荐页及趋势数据适配（T62：新增「推荐」导航 + #view-popular，bangumi_trends 归一化 {items,total} 解 {subject} 包裹，卡片封面/排名角标/评分，分页，点击进二级详情页）。
- [x] 影片详情页仿 Kazumi 的视觉与二级内容结构优化（T63：`_renderBangumiDetail` banner 改仿 Kazumi InfoPage 信息卡——大标题 + 封面/放送开始/评分星级/「Bangumi Ranked」排名/评分透视柱状图，弹窗与二级页复用；新增 `.bangumi-info-card` 系列样式，窄窗隐藏柱状图）。
- [x] MiSans 改为打包内置并统一全站字体（T61：misans.js 去运行时下载仅探测内置字体、恢复主进程 yuki:font-css → 渲染层注入 <link>、ui.css 字体栈 MiSans 优先、build:* 前置 download-binaries misans 保证打包随附；真实验收确认 file:// 内置加载非网络下载）。
- [x] 响应式封面/字体与整体现代化交互收尾：滚动条隐藏（T59）、无内容源/空分类过滤（T59/T60）、列表批量渲染（T65）、卡片列宽与标题/备注字号随窗口自适应（T66）均已完成；交互动效（卡片 hover、视图切换、封面淡入）此前已具备。
- [ ] 完成 Windows 冷启动、打包后资源、离线/慢网和多窗口尺寸实测。

### 2026-08-10 本轮完成（T54/T55/T56/T57/T58/T59/T60/T61/T62/T63/T65/T66）

- [x] 本地文件页背景模糊闪烁修复（T54）：根因为 `.view.active` 入场动画作用在含 `backdrop-filter` 视图的祖先上（Chromium 合成闪烁）+ 列表逐条 append 反复重栅格化；修复为入场动画排除 `#view-tools`/`#view-detail`、`renderLocalPage` 改拼串一次性写入并删除逐条 `addFile`。
- [x] Kazumi 规则设置布局优化（T55）：Kazumi 分类卡并入全宽组（grid-column 1/-1，≥1500px 跨 2 列）；规则行改「名称+版本 / 安装·更新时间」两行主块，控件跨行对齐，去掉误导 pointer 与 break-all 折名，编辑钮 hover 与删除红区分，清空按钮改危险色；版本号内联样式收敛为 `.kazumi-subver`。
- [x] 软件显示名全面改为 YuKi（T56）：窗口标题/托盘/通知/关于/引导页/`build.productName`/`shortcutName`；内部兼容键保留——`name=yuki`、`appId`、数据目录 `~/.yuki/`、Electron userData（`AppData/Roaming/yuki`，由 package name 决定不受 productName 影响）、协议标识与 IPC 前缀 `yuki:*`。
- [x] 时间表完整复刻（T57，对齐 Kazumi TimelinePage）：①后端新增 `bangumi_season_calendar(start,end)` + `/kazumi/action do=kazumiBangumiSeason` 端点（v0/search/subjects 按 air_date 区间多页拉取去重、按播出星期分桶，与本周放送同形状）②近 20 年季节索引（下拉按年 optgroup，首项「本周（在播）」，季度键算日期区间）③排序（热度/评分/播出时间）④收藏过滤（不显示已抛弃/已看完、只看在看；经 Bangumi token 拉收藏建集合，无 token 置灰降级）⑤卡片排名角标（`rating.rank`）+ 评分/播出日期，二级详情弹窗 banner 补 Ranked #N⑥星期 tab 默认今天。真实界面验收 11/11 通过（本周 14 卡、8 排名角标实测渲染）。
- [x] 返工两项（T58，按用户最新要求）：①「我的」页移除「最近观看」标签与面板（与左侧历史页重复），保留 观看统计 + 我的收藏 两标签，my.js 删除 recent 渲染逻辑②时间表卡片点击改为进入仿 Kazumi 二级详情页（新增 `#view-bangumi-info` 视图 + 返回键回时间表），不再用弹窗；`Kazumi._renderBangumiDetail` 重构为容器化（`$box` 参数 + tabs/content 由 id 改 class），弹窗（Kazumi 源流程）与二级页复用同一渲染。真实界面验收 10/10 通过（`scripts/acceptance-rework.js`）。
- [x] Bug 清理批次（T59/T60）：①搜索封面立即加载——`vodCoverImg`/`vodCard` 增 eager 参数，搜索当前页封面改 `loading="eager"` 不再等懒加载②内嵌滚动区统一隐藏滚动条（弹窗体/Bangumi 详情内容/详情简介/直链视图，补 `scrollbar-width:none` + webkit 伪元素）③搜索页隐藏无结果的源（不出分组卡与来源筛选标签，源计数只统计有结果源）④首页屏蔽无影片分类（`_probeClasses` 后台并发 4 探测各分类 categoryContent，确认空的分类从分类栏隐藏，同源只探一次、激活分类不隐藏、出错保留，源集合变更作废缓存）⑤修复 `bangumi_user_collections` limit 上限钳制为 100（此前时间表收藏过滤请求 limit=200 触发 Bangumi API 400）⑥验证日志功能有效（`~/.yuki/logs/` electron-main/python-backend/python-console 正常写入，RotatingLogWriter 轮转）。真实界面验收：分页实测正常（25 条收藏→2 页、翻页生效，`scripts/acceptance-bugfix.js` 6/6 通过）；分页代码经核查本无缺陷。
- [x] 搜索页 Kazumi 结果封面从 Bangumi 拉取并缓存（T73）：Kazumi 规则源搜索无源封面，现按片名查 Bangumi 首个匹配 `{id, cover}` 并缓存——`Kazumi.getBangumiMatch`/`getCachedBangumiMatch`/`getBangumiCover`（内存 Map + `kazumi_bgm_cover` localStorage 持久化，同片名在途搜索去重、空匹配仅会话内缓存、旧版仅封面格式自动迁移）；复用既有 `fillMissingCovers` 补拉池（视口优先/并发/abortCoverFill），`_coverFillOne` 对 `kazumi:` 源改走 Bangumi 而非 detailContent，补上后重插规则名徽章；`_paintGrp` Kazumi 卡命中缓存直接渲染、未命中占位图标 `data-cover-missing`；点击卡片命中缓存 id 直接进 Bangumi 二级详情页（免重复搜索、封面与详情同源一致），搜索后回填缓存；设置页新增「Bangumi 封面缓存」卡 + 清空按钮（`clearBangumiCoverCache`）供匹配错误时重置。

### 2026-08-10 第二轮（问题清单批处理）

- [x] 详情页"想看"收藏 404 修复（T74）：`bangumi_update_collection`/`bangumi_delete_collection` 重写为全矩阵尝试 `{POST, PUT} × {`-` 通配当前用户, 真实用户名} × {当前基址, 官方/镜像另一基址}`，首个 2xx 即成功（对齐 Kazumi 原版 POST `/v0/users/-/collections/{id}`）；鉴权类错误 401/403 优先于 404 返回，便于排查。
- [x] 第三方源收藏自动匹配 Bangumi（T74）：`Records.toggleFavorite` 收藏时按片名 `bangumiSearch`+`bangumiInfo`，命中则用 Bangumi 片名/封面/`bangumiId` 存储（已存在，复核确认）。
- [x] 历史卡片按次记录（T74）：`recordPlay` 每次真实播放新增一条独立 `kind:'play'` 记录，不再合并累加「已播几集」；`addHistory`（打开详情）标 `kind:'view'`，`recordPlay` 清掉同片名浏览卡避免「开→播」双卡；`recCard` 移除「已播 N 集」文案，改为显示「集名 · 时长 · 播放时间」；历史/收藏缺封面后台补拉（`fillMissingCovers` + `data-source`），Kazumi 源历史卡封面从 Bangumi 拉取并缓存。
- [x] 搜索页 Kazumi 边搜边加载（T74）：新增后端 SSE 端点 `/search/kazumi-stream`（每源完成即推一条，含状态字段），前端 `_runKazumi` 改走 EventSource 流式渲染，不再等全部源结束。
- [x] 搜索进度提示优化（T74）：`#search-status` 由纯文字改为「spinner + 进度条 + 源/结果计数」组件（`.search-status` 系列样式）；后端 `/search/stream` 先发 `event: meta` 携总源数，进度条按已收/总数确定填充；Kazumi 页签按启用规则数确定进度；搜索启动立即显示（消除首个源到达前的空档），完成态转摘要文字 + 进度条满。
- [x] Kazumi 验证码源可见窗口验证（T74）：主进程 `yuki:captcha-verify` + `ParseWindow.captchaVerify`（可见 BrowserWindow，关闭/超时收割会话 Cookie 推给后端 cookie_jar，rule_engine 搜索自动带上）；搜索页验证码源分组提示行 + Kazumi 源弹窗验证码项点击打开，完成后自动重搜。
- [x] 搜索页源名分隔线与卡片间距（T74）：`.src-group > .vod-grid { margin-top:8px }` 在分隔线与首行卡片间留出清晰间距（曾用 -1px 使线与封面顶部重合，用户反馈后改为 8px）。
- [x] 卡片标题限行防溢出（T74）：`.vod-name` 固定 2 行（border-box 精确 min/max-height，响应式各档同步），非全屏窄窗也不溢出。
- [x] 获取 Bangumi Token 跳系统默认浏览器（T74）：主进程 `setWindowOpenHandler` 对 http(s) 外链调 `shell.openExternal` 并 `deny`，不再开应用内新窗。
- [x] 每页数量增加 10/16 选项（T74）：`PAGE_SIZE_OPTIONS` 加 10/16，设置页 5 个分页下拉同步；每页数量设置本就在「外观」分类下。
- [x] 界面动画开关与 MiSans 统一（T74）：`set_anim` 由下拉改为 `md-switch` 开关，移至「外观」MiSans 界面字体下方，panels.js 改 checked 处理。
- [x] 设置页删除外部播放器按钮（T74）：移除系统页「指定外部播放器/恢复默认」区块（功能已在播放页），清理 panels.js 失效绑定。
- [x] 缓存板块合并（T74）：「缓存」+「播放缓存（mpv）」合并为一个「缓存与播放缓存」卡，中间分隔线区分应用缓存与 mpv 缓存。
- [x] 下载页按钮排一行（T74）：`dl-uri` 输入单独一行，「新建下载/种子文件/打开下载目录/删除失败/清除已完成」统一 `.wall-row` 一排，新建下载位置在输入栏下方。
- [x] Kazumi 规则「检测有效性/批量更新」按钮避让（T74）：按钮独立一行，任务状态提示移到下方独立行，与规则列表留间距。
- [x] 代理开关关闭恢复（T74）：主进程关闭分支 `session.setProxy({proxyRules:''})` 改 `{mode:'system'}` 显式还原系统代理（部分 Electron 版本空规则不还原，渲染层网络仍走旧代理）。
- [x] 以图搜番修复（T74）：trace.moe URL 直传返回 403（反爬/需它自行抓取），后端改为先下载图片字节再原始上传（POST + `anilistInfo=2`，浏览器 UA）；`Content-Type` 按文件头自动识别（Kazumi 硬编码 jpeg，PNG 会被拒）；失败返回 `error` 字段，前端 toast 真实原因。另修复结果卡片封面显示：原 `onerror` 隐藏 img 在 AniList 封面被墙/慢时留灰底空框，改为 `vodCoverChain` 多级兜底（AniList 封面 → trace.moe 匹配帧 → 占位图，新增 `coverChainNext` 逐级切换），配单元测试（cover-chain.test.js）。
- [x] 详情页缓存（T74）：`detailContent` 按 `site|vodId` 缓存 10 分钟（detail.js），`Kazumi.bangumiInfo` 缓存 30 分钟（kazumi.js），详情页 Bangumi 匹配改走 `getBangumiMatch`（复用 T73 封面缓存），重复打开详情免重新拉取/免重复搜索 Bangumi。
- [x] CatVod 详情页自动匹配 Bangumi 可开关（T74）：设置 → 源设置新增「详情页自动匹配 Bangumi 数据」开关（默认关）；关闭时打开非 Kazumi 影片详情仅显示源自身信息，不再按片名匹配/拉取 Bangumi 数据；开启时恢复自动匹配（评分/吐槽/角色/收藏同步等）。
- [x] 开始观看重构为流式 SourceSheet（T74，完整对齐 Kazumi）：后端 `kazumiSearch` 支持 `plugin` 过滤 + 返回丰富状态（success/noresult/captcha/error），SSE `/search/kazumi-stream` 同步返回状态；`openSourceDialog` 改为并发流式弹窗——每启用源一张卡片带状态徽标（检索中/N 条/需验证/检索失败/无结果），首个有结果源自动展开；点结果行「获取中」→ 选集视图（带「← 返回选源」）；每源补救操作（重试/进行验证/手动检索/浏览器打开），手动检索关键词重查该源；验证码源弹窗验证后自动重查该源；弹窗关闭清理 SSE 流。
- [x] 统一两种详情页为单一自适应页（T74）：新增 `Detail.openBangumi`（Bangumi-only 入口复用 `#view-detail`），头部/概览自适应——有 CatVod 源显示线路/选集/本地收藏，有 Bangumi id 显示评分/收藏同步（想看/在看/看过/搁置/抛弃）/开始观看（Kazumi 源）/标签/分集；`Kazumi.openBangumiInfoPage` 改为委托统一页；移除 `#view-bangumi-info` 视图与 `_backFromInfo`，时间表/推荐/收藏/Bangumi 搜索入口全部进统一详情页；详情页图片点击放大、标签点击跳搜索。
- [x] 首页空分类自动隐藏（T60 已实现，复核确认）；卡片封面「已播几集」角标移除（并入历史按次记录重构）。
- [x] 卡片标题「恰好两行」精确截断（T74 收尾）：CSS `-webkit-line-clamp` 只隐藏超行文本显示，超出的行仍参与布局与绘制（触发 Chromium 白块绘制缺陷）。现由 common.js 新增 `fitVodTitle`/`fitVodTitles`/`refitVodTitles` 在网格渲染后按实际列宽把标题 JS 截到恰好两行——临时解除 line-clamp 读 `scrollHeight` 判溢出，二分求「加 '…' 后仍不超两行」的最长前缀改写 textContent，DOM 不再存在超行文字（无超行 → 无白块），省略号 JS 显式补单 '…'，完整标题保留在 title 悬浮提示。已接入 6 个渲染点（home 渲染/追加、search 分组/以图搜番、records、timeline、popular），并在窗口 resize（防抖 300ms，响应式断点）与 `applySkin`（字号/缩放变化）后全量重适配；`ui.css` clamp 注释同步说明其降级为 resize 防抖期间的瞬时兜底。


2026-08-09 已完成以下代码修复：

- Bangumi 搜索改为官方 `POST /v0/search/subjects` 并统一 User-Agent。
- Bangumi 收藏先通过 `/v0/me` 获取 username，再访问用户收藏端点。
- XPath 节点内 `//` 查询归一化为 `.//`，对齐 Kazumi Dart 语义。
- 解析窗口主框架加载失败时快速跳过，不再对每个死站等待完整超时。
- 解析窗口关闭 EventEmitter 监听器数量告警。

重启后的真实运行结果（2026-08-09）：Bangumi token 已配置（长度 40），`/v0/me` 有效，收藏接口返回 12 条；Bangumi 搜索返回 3 条。Kazumi 有效性检查中 7sefun 返回 3 条，DM84/enlie 分别仍受 522/SSL EOF 外部故障影响。失效解析地址通过 Electron IPC 在 128ms 内失败返回；连续 5 次解析调用均在 118–155ms 返回，应用与后端保持健康。详见 [运行时问题](docs/RUNTIME_ISSUES.md) 的重启后实测表。

这些修复的日志、证据和待验证项统一记录在 [运行时问题](docs/RUNTIME_ISSUES.md)，不要在其他文档重复维护故障细节。
