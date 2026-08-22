# YuKi 系统架构

> 更新时间：2026-08-22
> 许可证：[GPLv3](../LICENSE)（`package.json` `GPL-3.0-only`，见 [THIRD_PARTY.md](THIRD_PARTY.md)）
>
> 本文描述当前有效架构。历史方案、详细批次和踩坑记录见 [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md)。

## 1. 总体结构

```text
Electron 渲染层
  首页 / 搜索 / 详情 / 播放入口 / 下载 / 设置
              │ IPC
Electron 主进程
  窗口与托盘 / Python 生命周期 / mpv / aria2c / ffmpeg
  文件管理 / 隐藏解析窗口 / 局域网推送
              │ HTTP + token
FastAPI Python 后端
  /action         CatVod 引擎
  /kazumi/action  Kazumi 规则引擎
  /cache          Spider 缓存
  /proxy          Spider 本地代理
```

核心原则是让 CatVod 与 Kazumi 并行工作，而不是把一种规则强行适配成另一种规则。

## 2. 进程与鉴权

- Electron 主进程启动 Python 子进程。
- 后端通过标准输出发送 `YUKI_BACKEND_READY port=<p> token=<t>`。
- 服务只监听 `127.0.0.1` 和随机端口。
- 除 `/health`、`/cache`、`/proxy` 外，端点需要查询参数 `token` 或请求头 `X-Token`。
- 配置自动重载由主进程维护权威状态，渲染层同时监听事件和轮询状态，避免启动竞态。

## 3. 双内容引擎

### CatVod

- `/action` 保持恢复源码的 Spider 调用契约。
- 支持 Python Spider、QuickJS JavaScript Spider 和苹果 CMS JSON/XML。
- 配置支持普通仓与多仓；多仓使用上次成功条目优先、失败重试和跨条目合并。
- 聚合搜索通过 SSE 返回，单源失败不能影响其他源。

### Kazumi

- `/kazumi/action` 使用独立的 PluginManager、RuleEngine 和持久化文件。
- 支持 XPath 与受限 JSONPath/API 两种规则模式。
- 规则只负责找到番剧详情页和剧集播放页，真实媒体地址由 Electron 隐藏窗口提取。
- 规则搜索、商店、编辑、测试、有效性检测、批量更新和 Bangumi 元数据均属于 Kazumi 子系统。

详细说明与差距对照见 [KAZUMI.md](KAZUMI.md)。

## 4. 播放数据流

```text
搜索或详情
  → CatVod playerContent / Kazumi chapterResult
  → 统一 PlayResult（保留未知字段和 drm）
  → json: / parse:<name> / type 0、1、2、4 / flags 路由
  → 直链：进入媒体探测
  → 页面：隐藏 BrowserWindow 提取真实流
       1. webRequest 拦截媒体请求
       2. 注入脚本轮询 video/audio currentSrc
       3. legacy 模式监听并跟随 iframe src
  → 按站点、Spider、解析器、窗口会话顺序合并请求头
  → HEAD；不确定时 GET Range bytes=0-1
  → 拒绝 HTML/JSON/登录页/401/403/伪媒体
  → mpv 单集播放，等待 file-loaded/ready
  → 渲染层依据播放会话推进连播
```

关键约束：

- mpv 每次只播放一集，不使用播放列表承担业务连播。
- 每次播放分配会话号，旧会话退出不能影响当前会话。
- `yuki:play` 只有在 mpv 报告 `file-loaded`/ready 后才返回 `ok=true`；首帧超时会停止对应进程。
- 断流自动重连只允许每条观看链尝试一次，并重新调用原始 `playerContent`，不复用旧 CDN URL。
- `ended` 事件携带会话号，渲染层「看完」兜底判定按会话匹配，避免旧集 ended 误判新集。
- 观看统计按「观看链」累计：断流重连经 `player-session` 复用旧链元信息，重连退出只补增量、不重复计次数/部数。
- 同地址解析使用 single-flight 去重；解析窗口和 partition 由 playSessionId/requestId 隔离，
  完成、失败、超时和取消都会清理 hook、窗口与 partition。
- `User-Agent/Referer/Origin/Cookie/Authorization` 大小写无关地合并，优先级从低到高为：
  站点 header → Spider `header` → Spider `headers` → 解析器配置 → 解析结果 → BrowserWindow
  最终媒体域 Cookie/重定向 Cookie。
- HTML、JSON、登录页、401/403 和已过期签名地址不能直接交给 mpv；Spider 可用
  `skipProbe` 标记真正一次性、探测即消耗的 URL。
- JAR 网盘 Provider 是首选实现；native Quark Provider 只在显式快路径开启且 JAR 降级时接管。
- DRM 策略：当前明确不支持，不实现绕过（原 ADR-0002 已归档，结论保留）。

## 5. 下载数据流

- 普通文件、种子和 Metalink 交给 aria2c JSON-RPC。
- M3U8 交给 ffmpeg 拉流和封装，支持 AES-128 与失败重试。
- HLS 广告过滤仅在下载路径重写播放列表；播放时实时过滤尚未实现。
- 下载列表由主进程聚合状态并推送，渲染层只负责展示。
- 完成/失败记录写入 `dl-records.json`，保证跨重启可见。
- 下载目录切换需要重启 aria2c，但保留续传语义。

## 6. 本地文件与安全边界

- 浏览、复制、删除和本地播放都通过主进程 IPC。
- 渲染层只看到相对白名单路径。
- 所有路径经规范化后必须仍位于配置根目录内。
- 拒绝 `..`、绝对路径、盘符跳转和非媒体文件播放。
- 删除、清空、恢复默认和目录切换等高影响操作使用统一确认对话框。

## 7. 数据与持久化

| 数据 | 位置 |
|---|---|
| Python 缓存、Spider 与日志 | `~/.yuki/` |
| Kazumi 规则 | `~/.yuki/kazumi/plugins.json` |
| Kazumi Cookie | `~/.yuki/kazumi/cookies.json` |
| Electron 设置 | `<userData>/settings.json` |
| 文件管理根目录 | `<userData>/file-manager.json` |
| 下载记录 | `<userData>/dl-records.json` |
| mpv 续播 | `<userData>/mpv-watch-later/` |
| mpv 缓存 | 默认 `<userData>/mpv-cache/`，可配置 |

设置恢复默认时必须保留收藏、历史、配置历史、下载/缓存路径、观看统计和 Bangumi token 等用户数据键。

## 8. 前端状态与交互

- 视图滚动容器是 `.view`，不是 `window`。
- 异步加载使用 `_loadToken`、`_probeToken`、`_playToken` 或等价会话机制。
- Esc 由统一派发器先关闭对话框，再交给当前视图。
- 跨脚本经典全局对象不能依赖 `window.X` 探测顶层 `const`。
- 封面统一使用无 Referer、异步解码、占位图和错误兜底。
- 后台封面补拉优先级低于搜索和详情，并可被详情操作中止。

## 9. Spider 契约摘要

- 插件顶层类名为 `Spider`，继承 `base.spider.Spider` 并实现 `init`。
- Spider 返回值必须是 `dict`，不能返回已经序列化的 JSON 字符串。
- Python 3.14（当前 `python-backend/.venv` 实测 3.14.x）通过 `compat.py` 提供旧版 `SourceFileLoader.load_module` 兼容。
- QuickJS 原生回调只传递标量，复杂值统一使用 JSON 字符串桥接。
- JavaScript Spider 动态创建独立子类，防止基类单例污染不同站点。
- 配置更新采用“完整准备后一次性替换”，不能先清空当前站点。

完整恢复背景、方法签名和字节码陷阱保留在 [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md#5-spider-引擎契约phase-0-固化结论勿重做)。

## 10. 运行时控制面与站点健康

### 10.1 配置快照与加载事务

配置分三层，职责不重叠（`python-backend/runtime/config_snapshot.py`）：

| 层 | 类型 | 内容 | 生命周期 |
|---|---|---|---|
| 下载 | `ConfigFetchResult` | 源 URL、最终 URL、transport（`http`/`file`/`inline`/`depot`）、HTTP 状态、ETag、Last-Modified、内容哈希、体积、跳转链、伪装形态（`gzip`/`image`）、编码、耗时 | 每次取回一份 |
| 解析 | `ParsedConfig` | `entries`（`SiteEntry` 字段矩阵）、`spider`、`parses`、`flags`、`lives`、`wallpaper`、`header`、未知字段名单、原始顶层 JSON | 纯数据，可随时丢弃 |
| 运行 | `ConfigSnapshot` | 上两层 + 已装配 `sites`、`diagnostics`、`routes`、`summary`、`security`、`artifacts`、`state`（`prepared`/`running`/`rejected`/`retired`）、`snapshot_id`、`source_hash`、`swap_seq` | 原子替换的单位 |

- 加载事务是 prepare → validate → atomic swap。`_prepare` 把新站点装配进一份**新**列表，
  期间不碰正在运行的 `sites.sites`；`_validate` 拒绝重复 `key`，也拒绝“新配置全部装配
  失败但仍持有可用旧快照”；`_apply` 才整体替换清单与诊断，把上一份快照标记
  `retired`，随后销毁旧 Runner 与不再被引用的 JAR 桥。
- 因此新配置失败时旧配置继续可用：站点不会被先清空，`lastHealthySnapshot` 保留最近
  一次 healthy 数 > 0 的快照标识。取消与超时走同一条丢弃路径，已起的 Worker 全部回收。
- `source_hash` 是复用判据。同内容重复加载只增加 `reuseCount`，不重启任何 Worker；多仓
  的判据是「清单哈希 | 选中子仓 URL | 子仓正文哈希」三者合成，只看清单会在子仓内容变化
  时错误复用。
- 多仓（顶层 `urls`）由 `RepoTrail` 记录 `declared`、`truncated`、实际尝试顺序、上次成功的
  偏好条目、`selected`、每条失败原因和参与合并的子仓。第一个**装配出站点**的条目胜出，
  条目表上限 12 条，嵌套多仓在深度 1 处拒绝。合并只增不删：主条目出影片源，其余条目补
  `lives`/`sites`。
- 相对 `api`/`jar`/`ext`/`playUrl` 一律按 `fetch.base_url`（即跳转后的**最终** URL）解析。

安全边界（`python-backend/runtime/config_security.py`）：仅 `http`/`https`；本地文件需用户
显式选择；响应 8 MiB、解压后 32 MiB、`ext` 2 MiB、跳转 5 次、多仓深度 1、`ext` 展开深度 2
（均可用 `YUKI_CONFIG_MAX_*` 覆盖）；声明的 `Content-Length` 在读正文前就判上限，流式读取与
增量解压各自设限，避免“小包大解压”。此外磁盘路径在解析 scheme **之前**判掉——`urlsplit`
会把 `C:\...` 的盘符当成 scheme，若先按 scheme 分派，`D:/tv.json` 会被报成“不支持的协议
d://”，诊断页给出的原因和真实问题（引用了本地磁盘路径）就不一致。
信任继承是同源（scheme + host + port）而不是“同一台机器”，每一跳跳转都重新过守卫，
用户亲手输入的根地址才是信任根，内联 JSON 没有可继承的源。下载的 JAR/JS/Python 按 URL 与
sha256 登记，内容变化即重新评估能力与权限。

### 10.2 站点字段矩阵与能力路由

- `SiteEntry` 覆盖 `type/api/jar/ext/key/name`、`searchable/quickSearch/filterable/changeable/indexs/hide`、
  `header/playUrl/click/categories/style/timeout`，顶层 `spider/parses/flags/lives/wallpaper`；
  站点级 `jar` 优先于顶层共享 `spider`。整数语义对齐 FongMi：`searchable` 只有 1 为真，
  缺省 `type` 等于 0。
- 未知字段整条保留在 `raw` 并登记到 `unknown_fields`；未知 `type` 不折叠成 0、不猜成 CMS，
  条目本身仍然有效，只是带结构化 unsupported 原因。非法条目标记而不丢弃。
- `ext` 在矩阵层保持原始 JSON 值（字符串/对象/数组）。归一化成字符串、以及 HTTP `ext` 的
  展开都属于运行时契约：按 FongMi `SiteApi` 的分歧，只有 type=4/JS 在 `homeContent` 前
  `fetchExt()`，type=3 的 spider 拿到的是原始字符串，自己决定要不要去取。空响应保留原
  URL，展开失败只影响该站点。
- 运行时判定由 Capability Router 一处产出（`runtime/capability_router.py`），装配路径与诊断页
  共用同一结论：R1 CMS HTTP → R2 `.py` → R3 `.js`/type=4（并把 drpy 单独分类）→ R4
  portable JVM JAR → R5 Android/Dex/native JAR → R6 unsupported。判定是纯函数，不随调用
  顺序或并发变化，也不发起任何网络请求。

### 10.3 运行时控制面

- `/action` 为每个请求建立 `RuntimeRequest`，包含 requestId、playSessionId、siteKey、
  method、deadlineMs 和 args；Runner 与 JAR RPC 复用同一上下文。
- 错误按 L1 配置、L2 站点、L3 运行时、L4 解析、L5 媒体、L6 播放器分层；运行时错误
  返回非 2xx HTTP 和结构化 `RuntimeResponse`，UI 文本与日志均脱敏限长。
- 客户端断连、deadline 和主动取消通过 `/runtime/cancel` 传播到 Supervisor；非协作式
  Python/QuickJS/JAR 调用会终止实际 Worker 进程树。解析超时仍会销毁隐藏窗口并释放槽位。

### 10.4 站点健康

- `SiteHealth` 分别记录 configured、built、initialized、healthy 四个阶段，并带上路由结论
  （runtime、worker、命中的规则、兼容级别 C0/C1/C2、JAR 分级与信号、稳定错误码）。
  `/sites.sites` 是内容页可用清单，`/sites.diagnostics` 保存包括不兼容站点在内的完整诊断。
- 普通 JVM 仅接收 portable JAR。A4.1 在 2026-08-19 得出 No-Go，当前产品支持上限固定为
  C1；Dex、Android API、native 与 DRM 信号标记 C2 / `requires_android`，不得计入 healthy。
  路由与加载器使用同一份信号集合，
  已知 Android-only 的 JAR 不会回退到普通 JVM 路径；分级读不出来时如实记为 `L?` +
  `classify-failed`，不洗成干净的 L0。
- `runtime/android_policy.py` 是产品政策闸门：`ANDROID_WORKER_SHIPPED=false` 时，即使环境同时
  声明 enabled/ready 也不能扩大支持范围。错误 `L2_SITE_REQUIRES_ANDROID` 必须告诉用户
  “仅支持 Android、当前上限 C1、不回退 dex2jar/JVM、改用可移植源”。A4.1 的三个真实样例、
   JVM 实测和四方案比较见 git 历史归档（原 ANDROID_WORKER_SPIKE_REPORT）。
- drpy 规则由受 Supervisor 管理的独立 Node Worker 进程承载（`drpy-engine/`），
  能力路由判定为 C1 / `worker='drpy'`，实现零增量体积复用 Electron Node 运行时。
- 远程 Python、QuickJS、CMS 和 portable JAR 控制调用按站点进入 spawn Worker。Windows
  使用 kill-on-close Job Object 管理 Worker 与 Java/Node/Python 后代，并施加运行时内存上限。
- Worker 控制面使用本地 pipe 的有大小上限 JSON 帧；spawn 子进程先发送可信 `booted` 并
  等待，父进程绑定 Windows Job Object 后才允许加载站点模块/QuickJS/JAR。JAR
  `InputStream` 只经一次性 loopback 数据 socket 传输。队列等待、启动、RPC 与重启共享
  同一个绝对 deadline。
- 聚合搜索最多保留 16 个在途源，只等待整体预算；超时源由 Supervisor 实际终止，不以
  `Future.cancel()` 作为结束证据。
- 同阶段连续 3 次可重试失败熔断 60 秒；半开只允许一个探测。Cookie 缺失不自动重试，
  Cookie 更新、配置更新或用户重试可提前触发探测。
- 配置原子替换、FastAPI lifespan、设置重置和 Electron 退出复用同一资源销毁链；Windows
  Electron 后端停止检查 `taskkill` 返回码并在失败时回退。真实 Python 根进程及其
  Python/Java/Node 后代、JAR Worker/JVM 和本地监听端口均由生命周期测试观察回收。

## 11. 构建与验证

```powershell
npm run test:all   # test:py + test:jsunit + test:js + lint + lint:py
npm run build:py   # PyInstaller -> python-dist/
npm run build:win  # NSIS x64 安装包 -> dist/
```

`test:all` 最新全量 **ALL PASS**（2026-08-22：`run_all.py` 36 阶段全过、编译 100 文件 0 error、JS 单元 313 tests、ESLint 0 error、Ruff 全过；详见 [PROGRESS.md](../PROGRESS.md) §7 与 [RUNTIME_ISSUES.md](RUNTIME_ISSUES.md)）。Windows 已生成 NSIS 安装包；macOS/Linux 配置存在但尚未完成实机验证。发布流水线见 [.github/workflows/release.yml](../.github/workflows/release.yml)（tag `v*` → Windows 构建 → Draft Release）。

`run_all.py` 按阶段串行（任一阶段失败即停），其中 `config-snapshot`/`ext-semantics`/`capability-router`/`config-security` 四个阶段通过 `tests/offline_config_server.py` 起在 `127.0.0.1:0` 的 loopback 夹具跑，不出网；其余阶段覆盖 smoke/phase3/kazumi/cache/代理/JAR/站点健康等。夹具进入时会隔离宿主代理环境变量与 Windows 系统代理，否则开发机代理会吞请求；gzip、JPEG/PNG 伪装三种载体由 `single.json` 确定性派生（`ensure_binary_fixtures()`，`mtime=0`），四种载体哈希必须相等。

跑单个阶段要用项目虚拟环境的解释器，裸 `python` 缺 `lxml` 会在导入 `config` 时报 `ModuleNotFoundError`（环境问题）：

```powershell
cd python-backend
.\.venv\Scripts\python.exe tests\run_all.py
.\.venv\Scripts\python.exe tests\test_config_snapshot.py
```
