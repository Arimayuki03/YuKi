# TVBox / FongMi 功能一致性详细任务书

- **编写日期**：2026-08-18
- **状态**：G0.1-G0.3、S1.1-S1.4 验收通过（2026-08-18）；未进入 C2
- **目标平台**：Windows 优先，macOS/Linux 在 PC 原生运行时稳定后跟进
- **产品目标**：用户只输入一个影视仓库地址，应用自动获取配置、识别并加载可运行的站点，最终成功播放用户有权访问的媒体
- **相关文档**：[现有兼容计划](TVBOX_COMPAT_PLAN.md)、[剩余验收项](TVBOX_COMPAT_PLAN_REMAINING.md)、[契约差距](TVBOX_CONTRACT_GAPS.md)、[FongMi 功能实现](FONGMI_FEATURE_IMPLEMENTATION.md)、[系统架构](ARCHITECTURE.md)

本文不重复已经完成的配置解析、代理、网盘和播放器补丁，而是定义从当前状态走到“使用体验接近 TVBox/FongMi”的完整执行路径。本文中的任务完成状态必须以测试证据为准，不能以“代码已写”或“仓库能导入”代替验收。

---

## 1. 最终目标与边界

### 1.1 用户最终流程

目标用户流程必须保持简单：

1. 用户在设置页粘贴一个仓库地址；
2. 应用自动完成 IDN、重定向、压缩、图片伪装、多仓和相对路径处理；
3. 应用读取仓库配置并建立站点清单；
4. 每个站点根据能力自动路由到 CMS、JavaScript、Python、drpy 或 Android Worker；
5. 首页、分类、搜索和详情只展示健康或可明确降级的站点；
6. 点击剧集后自动执行 `playerContent`、解析器、本地代理和请求头合并；
7. 播放器收到可验证的媒体地址并成功加载首帧；
8. 任一环节失败时，界面准确显示失败层级和建议，不出现永久加载、空白页或假成功。

用户不应被要求理解 JAR、QuickJS、drpy、解析器或代理端口。运行时选择属于宿主内部实现。

### 1.2 兼容等级

| 等级 | 定义 | 本计划定位 |
|---|---|---|
| C0 配置兼容 | 能下载并解析配置，但站点不一定能运行 | 仅诊断能力，不算产品完成 |
| C1 PC 原生兼容 | CMS、CatVod JS/Python、drpy、可移植 JVM JAR 可稳定运行和播放 | 第一交付目标 |
| C2 混合运行时兼容 | C1 + Android/Dex/native JAR 自动路由 Android Worker | 主目标，接近 FongMi 覆盖率 |
| C3 平台完全等价 | C2 + DRM、全部 Android 原生 ABI、平台专属播放器能力 | 独立决策，不作为首版承诺 |

“与 TVBox/FongMi 一致”在本项目中指配置、Spider、解析、代理和播放契约行为一致，不代表界面像素级一致，也不承诺已经失效、地区封锁、需要私有账号或服务端故障的第三方源一定可用。

### 1.3 必须实现

- 单仓、多仓、注释 JSON、gzip、图片伪装、中文域名、相对资源和仓库跳转；
- CMS、CatVod JavaScript、Python、drpy 和可移植 JAR；
- Android 依赖源的明确识别，以及 C2 阶段的 Android Worker 路由；
- `init/home/category/detail/search/player/proxy` 契约；
- `parse/jx/playUrl/header/cookie/subs/format/position` 播放结果归一；
- HTTP 重定向、Range、HLS、请求头、本地代理和流式转发；
- 调用级硬超时、熔断、重启、资源限额和取消；
- 以播放器首帧或 `file-loaded` 为播放成功标准；
- 可重复执行的离线契约测试、真实仓兼容测试和打包后实机测试。

### 1.4 不在首版强行承诺

- 对已经失效或要求未知私有令牌的公共仓提供可用性保证；
- 绕过付费、授权、地域或 DRM 限制；
- 在普通 Windows JVM 中直接运行 ARM Android `.so`；
- 用按仓库名、JAR 哈希或作者名编写的长期特判维持兼容；
- C3 级 Widevine/PlayReady 播放，除非完成单独的安全、许可和发布评估。

---

## 2. 当前基线与已确认根因

### 2.1 已有基础

当前项目已经具备：

- 配置下载、图片伪装、gzip、IDN、多仓与基本相对路径处理；
- CMS、Python Spider、QuickJS Spider 和普通 JVM JAR 桥；
- CatVod 六方法入口及 `/proxy` 基础能力；
- `parse=1`、隐藏 BrowserWindow 嗅探、请求头合并；
- mpv 播放、首播等待、连播、断流重连、历史和观看统计；
- 夸克 Provider 快路径、Cookie 管理和代理流式转发；
- L1-L4 分层错误与一批契约测试。

2026-08-18 本轮验证结果：

- Python 完整回归通过；
- JavaScript 单元测试 216/216 通过；
- 代表性真实仓库可以获取并解析配置；
- 真实仓库中的 Android API、DEX 和 native-library JAR 在普通 JVM 路径出现 `DexNative` 初始化失败；
- drpy 站点被当前配置层明确跳过；
- 真实首页探测超过三分钟仍未退出，说明线程取消不是硬终止边界。

### 2.2 主要根因

| 编号 | 根因 | 当前表现 | 影响 |
|---|---|---|---|
| B1 | 运行时不等价 | FongMi 使用 Android `DexClassLoader`，当前使用 dex2jar + 普通 JVM | Android Context、二次 DEX、WebView、ARM `.so` 源失败 |
| B2 | drpy 缺失 | 配置能解析，但 drpy 站点直接 skipped | 新仓库大量主要站点不可用 |
| B3 | 缺少可终止隔离 | Future 超时或 cancel 后底层线程仍运行 | 永久加载、退出等待、资源泄漏 |
| B4 | 健康状态过早 | 站点对象建成即计入成功，首次调用才暴露 JAR 初始化失败 | “导入成功但首页为空”的假成功 |
| B5 | FongMi 字段语义不完整 | HTTP `ext`、`playUrl/jx/flags`、解析器类型仍有差距 | 首页或播放行为与 FongMi 不一致 |
| B6 | 播放成功口径偏弱 | 获得 URL 或启动进程容易被当成成功 | HTML、403、过期 CDN 地址仍显示正在播放 |
| B7 | 外部源天然不稳定 | CDN、域名、令牌、账号和地域随时变化 | 不能只靠一次公共仓测试判断宿主正确性 |

### 2.3 必须改变的工程原则

1. **导入成功不等于兼容成功**：配置、建站、运行、解析、媒体探测、首帧必须分别计数。
2. **线程不是安全隔离边界**：远程 JS、Python、JAR 和 drpy 必须运行在可终止进程中。
3. **先识别能力，再选择运行时**：不能把 Android-native JAR继续盲目交给普通 JVM。
4. **修契约，不修仓库名**：新增补丁必须对同类型的其他仓库有效。
5. **公共仓只做趋势测试**：确定性回归必须依赖本地夹具和可控测试服务。
6. **首帧才是播放成功**：`playerContent` 返回 URL、解析成功或 mpv 进程启动都只是中间状态。

---

## 3. 目标架构

```mermaid
flowchart LR
    A["仓库地址"] --> B["配置获取与标准化"]
    B --> C["站点能力扫描与健康状态"]
    C --> D["CMS Worker"]
    C --> E["QuickJS Worker"]
    C --> F["Python Worker"]
    C --> G["drpy Worker"]
    C --> H["Portable JAR Worker"]
    C --> I["Android FongMi Worker"]
    D --> J["统一 SpiderResult"]
    E --> J
    F --> J
    G --> J
    H --> J
    I --> J
    J --> K{"直链 / parse / proxy / pan"}
    K --> L["解析器与 Chromium 嗅探"]
    K --> M["统一本地代理数据面"]
    L --> N["媒体探测"]
    M --> N
    N --> O["mpv"]
    N --> P["可选 DRM 播放内核"]
```

### 3.1 控制面与数据面

- **控制面**：短 JSON 请求，承载配置、健康状态和 Spider 方法；每个调用有 deadline、requestId 和结构化错误。
- **数据面**：视频、HLS 分片和 JAR/网盘代理流；支持 Range、取消和客户端断连传播，不能经过 JSON 或整流入内存。
- **Supervisor**：创建、复用、停止和重启各类 Worker；记录队列、超时、崩溃和熔断状态。
- **Capability Router**：根据站点类型、API、JAR 扫描结果和运行探测选择 Worker，不依赖仓库名称。

### 3.2 Worker 最小协议

所有运行时至少实现以下请求：

```json
{
  "requestId": "uuid",
  "siteKey": "site-key",
  "method": "playerContent",
  "deadlineMs": 30000,
  "args": {
    "flag": "line-name",
    "id": "episode-id",
    "vipFlags": []
  }
}
```

统一响应：

```json
{
  "requestId": "uuid",
  "ok": true,
  "runtime": "android",
  "elapsedMs": 1842,
  "result": {},
  "error": null
}
```

错误响应必须包含：

```json
{
  "code": "L3_RUNTIME_TIMEOUT",
  "stage": "runtime",
  "retryable": true,
  "siteKey": "site-key",
  "runtime": "jar",
  "message": "源响应超时，运行时已重启"
}
```

---

## 4. 总体验收口径

### 4.1 分阶段状态

| 阶段 | 名称 | 成功条件 | 失败示例 |
|---|---|---|---|
| S0 | 仓库获取 | 在限制大小和跳转次数内取得非空配置内容 | DNS、TLS、403、超时 |
| S1 | 配置解析 | 生成合法标准配置模型 | JSON/编码/伪装解码失败 |
| S2 | 站点装配 | 找到对应运行时并完成 `init` 或预检 | 类型不支持、JAR 不兼容 |
| S3 | 内容调用 | 首页、搜索、详情返回合法结构 | 空结构、异常、硬超时 |
| S4 | 播放路由 | `playerContent` 归一为直链、解析或代理任务 | URL 为空、字段冲突 |
| S5 | 媒体可达 | 使用最终请求头完成媒体探测 | HTML、403、Range 错误 |
| S6 | 播放就绪 | mpv/目标内核报告 `file-loaded` 或首帧 | 启动失败、加载超时 |

### 4.2 发布级硬指标

- 所有离线契约夹具 100% 通过；
- 任意 Worker 无限循环或阻塞时，必须在 deadline 后被终止，主进程不等待其自然退出；
- 单个坏源不能拖慢其他站点，也不能让应用退出卡住；
- 连续加载 20 次配置后，Worker、JVM、端口和临时目录数量回到稳定水位；
- 直链、`parse=1`、`proxy://`、HLS Range、带 Referer/Cookie 和网盘样例均完成首帧验收；
- 公共仓报告必须区分“宿主回归”和“上游不可达”，不能用外网波动掩盖确定性测试失败；
- UI 不允许以站点对象存在、URL 非空或播放器进程已创建作为最终成功提示。

### 4.3 默认调用预算

| 调用 | 默认 deadline | 超时动作 |
|---|---:|---|
| `init` | 30 秒 | 终止 Worker，站点标记不可用 |
| `homeContent` | 15 秒 | 取消请求；连续失败进入熔断 |
| `categoryContent` | 20 秒 | 取消请求；保留已加载页面 |
| `searchContent` | 20 秒 | 单源失败不影响其他源 |
| `detailContent` | 20 秒 | 取消请求并显示源级错误 |
| `playerContent` | 30 秒 | 终止本次播放链，不进入解析器 |
| JSON 解析接口 | 15 秒 | 尝试下一解析器 |
| WebView 嗅探 | 20 秒 | 关闭窗口和 partition 任务 |
| mpv 首次加载 | 30 秒 | 停止进程并返回明确失败原因 |

站点配置中的合法 `timeout` 可以在安全上限内覆盖默认值；任何远程配置都不能取消宿主硬上限。

---

## 5. 任务依赖与里程碑

```mermaid
flowchart TD
    G0["G0 基线与统一契约"] --> S1["S1 进程隔离与硬超时"]
    S1 --> C2["C2 配置与能力路由"]
    C2 --> N3["N3 PC 原生运行时"]
    C2 --> A4["A4 Android Worker"]
    N3 --> P5["P5 播放链路收敛"]
    A4 --> P5
    P5 --> U6["U6 单地址用户流程"]
    P5 --> Q7["Q7 兼容与故障测试"]
    U6 --> R8["R8 打包发布"]
    Q7 --> R8
```

| 里程碑 | 内容 | 完成定义 |
|---|---|---|
| M1 稳定宿主 | G0 + S1 | 坏源不再卡死、退出不等待、错误可定位 |
| M2 PC 主流兼容 | C2 + N3 + P5 原生部分 | CMS/JS/Python/drpy/portable JAR 可完成端到端播放 |
| M3 FongMi 混合兼容 | A4 + P5 Android 部分 | Android/Dex/native JAR 自动路由并可返回代理流 |
| M4 可发布 | U6 + Q7 + R8 | 安装包冷启动和真实播放矩阵通过，支持安全回滚 |

---

## 6. G0：基线、契约与诊断

### G0.1 固化当前兼容基线

**优先级**：P0  
**依赖**：无

工作内容：

- 保留 21 仓公共语料，同时增加不依赖公网的本地仓库夹具；
- 修复兼容套件在首页 Future 超时后仍等待线程退出的问题；
- 报告增加 S0-S6 字段，而不是只有 fetch/parse/home；
- 保存每个站点的 runtime、compatibility、init、home 和 play 状态；
- 公共报告记录测试时间、网络出口、失败域名和上游 HTTP 状态。

主要文件：

- `python-backend/tests/test_config_compat.py`
- `python-backend/tests/compat_repos.json`
- `python-backend/tests/compat_baseline.json`
- `python-backend/tests/fixtures/`

验收：

- [x] 单仓超过预算时父进程可以在 180 秒内强制终止且不残留 Java/Python 进程；
- [x] 本地夹具离线可运行；
- [x] 报告可以回答“配置成功但为什么不能播放”；
- [x] 基线更新必须显式使用 `--update-baseline`。

实现记录（2026-08-18）：默认兼容测试改为四个 loopback 离线夹具；21 仓公共语料仅在
`--public` 下运行。首页探测不使用会在 `__exit__` 等待失控线程的临时线程池；G0 验收时
曾由仓级父进程树终止超时夹具，S1.3 后已升级为逐 requestId 硬取消并自然退出，仓级强杀
只保留给整个子进程崩溃/失联兜底。报告保存 S0-S6、每站 runtime、compatibility、
init/home/play/media 状态，以及公共模式的测试时间、网络出口、失败域名和 HTTP 状态。
正常、异常、超时、无限循环和取消均有离线测试。

### G0.2 定义统一运行时与错误契约

**优先级**：P0  
**依赖**：无

工作内容：

- 新增统一 `RuntimeRequest`、`RuntimeResponse`、`RuntimeError` 和 `SiteHealth` 模型；
- 统一 L1-L6 错误码、是否可重试和用户提示；
- 给所有 `/action`、Worker、解析器和播放器请求分配 requestId/playSessionId；
- 保留运行时原始错误到日志，但返回界面前做脱敏和长度限制。

建议新增：

- `python-backend/runtime/contracts.py`
- `python-backend/runtime/errors.py`
- `python-backend/runtime/health.py`
- `python-backend/tests/test_runtime_contract.py`

验收：

- [x] 同一播放动作可通过 requestId 从前端追踪到 Worker、代理和 mpv；
- [x] 错误响应不再混用 HTTP 200 + 任意字符串表达失败；
- [x] 日志中的 Cookie、token、Authorization、网盘凭据完成脱敏。

实现记录（2026-08-18）：新增 `runtime/contracts.py`、`runtime/errors.py` 和
`runtime/health.py`。`/action`、Runner、JAR JSON-RPC、解析 IPC、本地 `/proxy` 和 mpv
会话贯穿 `requestId/playSessionId`；L1-L6 错误目录固定 stage、retryable、HTTP 状态和
用户提示。原始异常只进入脱敏限长日志。正常、异常、deadline 超时和主动取消均有离线测试。

### G0.3 建立站点能力模型

**优先级**：P0  
**依赖**：G0.2

建议字段：

```json
{
  "siteKey": "demo",
  "runtime": "android",
  "compatibility": "C2",
  "state": "healthy",
  "capabilities": ["home", "search", "detail", "player", "proxy"],
  "lastSuccessAt": 0,
  "lastError": null,
  "consecutiveFailures": 0,
  "circuitOpenUntil": 0
}
```

验收：

- [x] 配置摘要区分 configured/built/initialized/healthy；
- [x] Android-native JAR 在 Android Worker 未启用时显示“需要 Android 运行时”，不计为 healthy；
- [x] UI 可以隐藏不可用站点，但诊断页仍可查看跳过原因。

实现记录（2026-08-18）：`SiteHealth` 保存能力、兼容等级、四阶段装配状态、最近成功、
最后错误和连续失败数。JAR 在装配期执行 init；Dex、Android API、native 或 DRM 信号在
Android Worker 未启用时返回 `L2_SITE_REQUIRES_ANDROID`，不会回退为 healthy JVM 站点。
`/sites.sites` 仅返回 healthy 站点，`/sites.diagnostics` 与设置页“站点诊断”保留全部原因。
健康、初始化异常、超时、取消和 Android 缺失均有离线测试。

### G0 阶段退出结论（2026-08-18）

G0.1-G0.3 的确定性离线验收和现有回归均通过，本阶段退出；未实施 RuntimeSupervisor、
生产 Worker 进程隔离/强制终止、熔断或 S1 的搜索迁移。本轮到此停止，不进入 S1。

G0 检查点当时的验收证据：`test_config_compat_offline.py` 通过 4 个离线夹具，超时和无限循环
由父进程树终止且后代 Python 进程为 0；`run_all.py` 全部 Python 阶段和 57 个文件编译通过；
Node 单元测试 222/222、JavaScript 语法 40/40、ESLint 0 error、Ruff 通过。默认受管
环境的 Node 子进程测试会因 `spawn EPERM` 失败，已在允许子进程的权限下复跑并通过。
当前 S1 验收已由下节的 Supervisor 精确取消/自然退出证据取代该故意驻留夹具。

---

## 7. S1：进程隔离、硬超时与熔断

### S1.1 实现 RuntimeSupervisor

**优先级**：P0  
**依赖**：G0.2

工作内容：

- Windows 使用 `spawn` 模式创建 Worker，禁止依赖 `fork`；
- Worker 使用 JSON Lines、本地 socket 或命名管道通信；
- Supervisor 负责启动、健康检查、请求 deadline、强制终止、重启和销毁；
- 按运行时设置内存、并发、队列和重启频率上限；
- 应用退出、配置重载和设置重置都调用同一销毁流程。

建议新增：

- `python-backend/runtime/supervisor.py`
- `python-backend/runtime/worker_base.py`
- `python-backend/runtime/process_transport.py`
- `python-backend/tests/test_runtime_supervisor.py`

验收：

- [x] 无限循环夹具在 deadline 后被强制结束；
- [x] Worker 崩溃一次自动重启，连续崩溃进入熔断；
- [x] 配置重载 20 次无僵尸进程；
- [x] 后端退出不等待失控 Worker。

实现记录（2026-08-18）：新增 spawn-only `RuntimeSupervisor`、JSON pipe transport、
Worker 入口与按运行时策略。远程 Python import、QuickJS eval 和 portable JAR 控制调用不再
进入 FastAPI 进程。spawn 子进程先停在可信 `booted` 屏障，父进程成功绑定 kill-on-close
Job Object 后才发送 `start`，Job 绑定失败会终止启动，避免不可信 import/JVM 抢先派生后代。
队列、串行锁、启动握手与调用共享绝对 deadline；终止函数以进程已退出为证据。配置替换、
FastAPI lifespan、设置重启和 Electron 退出共用进程树销毁链。正常、异常、无限循环、超时、
取消、崩溃、启动期派生、20 次真实 Python/Node 热重载、活跃 Worker 退出和端口释放均有
Windows 离线测试。

### S1.2 迁移 JAR 调用边界

**优先级**：P0  
**依赖**：S1.1

工作内容：

- 保留现有 `SpiderRunner`，但由 Supervisor 管理每个 JAR Worker；
- 队列等待时间计入 deadline，不能只计算进入 `_call` 后的 60 秒；
- 同一 JAR 的慢站点不得永久阻塞同 JAR 其他站点；
- JVM 被杀后所有 pending 请求收到结构化 `L3_RUNTIME_RESTARTED`；
- Proxy 流与控制 RPC 分离，客户端断连时关闭上游流。

主要文件：

- `python-backend/jar_bridge.py`
- `python-backend/jar_spider.py`
- `python-backend/proxy_gateway.py`
- `python-backend/tests/test_jar_e2e.py`
- `python-backend/tests/test_proxy_stream.py`

验收：

- [x] 一个 JAR 方法阻塞不会让后续请求无限排队；
- [x] 杀死 JVM 后下一次健康请求可以自动恢复；
- [x] 视频代理不通过 stdout/JSON 整体传输；
- [x] Range 请求中断后上游连接释放。

实现记录（2026-08-18）：每个 JAR 站点由独立 Supervisor Worker 管理 `SpiderRunner`，
同一 JAR 的坏站不会占住另一站的 JVM。`JarBridge` 的锁等待、JVM 启动、RPC 等待和重启
共享请求剩余预算；超时杀死 Worker/Java 进程树。静态 Proxy 控制帧只返回状态、响应头和
一次性 loopback stream 描述符，视频字节由父进程直接连接 JVM 数据 socket；客户端关闭时
关闭该 socket。实际 Java 夹具覆盖异常、无限阻塞、取消、JVM 外部终止与恢复、配置热重载
和 FastAPI 退出；Range 中断夹具由上游 `InputStream.close()` 回连观察端口，并验证一次性
数据端口不再接受连接，不再用 Python 对象的 `_closed` 字段代替上游释放证据。

### S1.3 修复聚合搜索和兼容套件取消语义

**优先级**：P0  
**依赖**：S1.1

工作内容：

- 移除“Future cancel 即认为任务结束”的假设；
- 不使用会在 `__exit__` 中 `shutdown(wait=True)` 的临时线程池包住不可信调用；
- 聚合搜索只等待整体预算，预算结束立即返回已完成结果；
- 将尚未结束的实际工作交给 Supervisor 终止；
- 增加最大在途搜索源数和背压。

主要文件：

- `python-backend/server.py`
- `python-backend/tests/test_config_compat.py`
- `python-backend/tests/test_runtime_supervisor.py`

验收：

- [x] 50 个源中 10 个永久阻塞时，搜索仍在总预算内返回；
- [x] 后续搜索不被上一批遗留任务占满；
- [x] 测试进程按时结束，无人工 Ctrl+C。

实现记录（2026-08-18）：聚合搜索以 20 秒总预算和最多 16 个在途源做增量提交；预算结束
返回已完成结果，并按 `requestId` 并行终止本批实际 Worker，不误杀同站点并发的非搜索调用。
`Future.cancel()` 只阻止尚未开始的协调任务，不作为结束证明；线程池显式
`shutdown(wait=False)`。50 源（10 个永久阻塞）故障测试连续执行两次搜索，每次都在同一
总预算内返回 40 个健康结果，阻塞 Worker 全部退出。兼容套件为每个探测分配 requestId，
预算结束调用 `/runtime/cancel` 精确终止对应 Worker；只有接口同时报告 Worker 已终止且
dispatch 已收尾时才写 `cancelled`，超时/无限循环夹具自然退出，不依赖外层 `taskkill`。

### S1.4 熔断、退避与健康恢复

**优先级**：P1  
**依赖**：S1.1、G0.3

默认策略：

- 连续 3 次相同阶段失败：熔断 60 秒；
- 半开状态只允许 1 个探测请求；
- 探测成功关闭熔断并清零计数；
- 配置更新、Cookie 更新或用户主动重试可以提前触发一次半开探测；
- 永久不兼容错误不做自动重试。

验收：

- [x] 坏源不会持续刷请求和日志；
- [x] 临时网络恢复后无需重启应用即可恢复；
- [x] Cookie 缺失与网络超时使用不同恢复策略。

实现记录（2026-08-18）：同阶段连续 3 次可重试失败后打开 60 秒熔断，半开只放行一个探测；
成功探测清零并关闭。配置更新建立新运行时，Cookie 更新或 `runtimeRetry` 可提前放行一次探测。
凭据缺失使用不可自动重试的 `L3_RUNTIME_CREDENTIALS_REQUIRED`，网络超时使用可重试的
`L3_RUNTIME_TIMEOUT`；熔断期间不会启动新 Worker。确定性 HTTP `/action` 测试分别穿过
`runtimeRetry`、`panCookie act=set` 和配置重载，再执行健康调用验证熔断/永久凭据阻断恢复。

### S1 阶段退出结论（2026-08-18）

S1.1-S1.4 以可观察资源状态完成确定性 Windows 离线验收，第一迭代退出标准达到；本轮在此
停止，不进入 C2。验证覆盖启动屏障、实际 Python/QuickJS/JAR 无限循环、JVM 崩溃和重启、
HTTP 熔断恢复、连续两次 50 源聚合搜索、20 次真实 Python/Node 热重载、FastAPI/Electron
退出、Python/Java/Node 后代及监听端口回收；未新增按仓库名或 JAR 哈希的特判。兼容夹具
不再故意驻留等待父进程强杀。公共仓外网趋势仍与代码回归分开，不作为本阶段确定性门禁。

---

## 8. C2：配置标准化与能力路由

### C2.1 建立 ConfigSnapshot 标准模型

**优先级**：P0  
**依赖**：G0.2

工作内容：

- 下载结果、解析结果和运行中配置分离；
- 配置更新采用 prepare → validate → atomic swap；
- 失败时保留上一份健康配置，不先清空站点；
- 保存源 URL、最终 URL、ETag、Last-Modified、内容哈希和加载时间；
- 多仓记录选中条目及失败回退顺序。

主要文件：

- `python-backend/config.py`
- `python-backend/site_manager.py`
- `python-backend/tests/test_config_compat.py`

验收：

- [ ] 新配置失败时旧配置仍可使用；
- [ ] 同内容重复加载不重复重启全部 Worker；
- [ ] 多仓切换可以追踪实际选中的子仓。

### C2.2 对齐 `ext` 完整语义

**优先级**：P0  
**依赖**：C2.1

工作内容：

- 相对 `ext` 按配置最终 URL 解析；
- 对需要展开的 HTTP `ext` 拉取文本，并保留原 URL 供运行时按契约选择；
- 支持字符串、对象、数组和 JSON 字符串；
- 增加大小上限、超时、编码识别、缓存和 ETag；
- 防止递归 `ext` 无限展开。

验收：

- [ ] 与 FongMi `Site.fetchExt()` 行为夹具一致；
- [ ] 远程 JSON、普通文本和无需展开的 URL 均正确处理；
- [ ] `ext` 失败只影响对应站点，不破坏整个配置。

### C2.3 完善站点类型和字段矩阵

**优先级**：P1  
**依赖**：C2.1

字段至少覆盖：

- `type/api/jar/ext/key/name`；
- `searchable/quickSearch/filterable/changeable/indexs/hide`；
- `header/playUrl/click/categories/style/timeout`；
- 顶层 `spider/parses/flags/lives/wallpaper`；
- 站点级 `jar` 优先于顶层共享 `spider`。

对未知 `type`：

- 不得猜测成 CMS；
- 保存原始条目；
- 标记结构化 unsupported 原因；
- 有真实配置和上游契约后再增加适配器。

### C2.4 实现 Capability Router

**优先级**：P0  
**依赖**：G0.3、C2.3、N3/A4 对应 Worker

建议路由顺序：

1. CMS HTTP API → CMS Worker；
2. `.py` → Python Worker；
3. `.js` 或 type=4 → QuickJS/drpy 识别；
4. `csp_` + portable JAR → JVM JAR Worker；
5. `csp_` + Android/Dex/native 信号 → Android Worker；
6. 无可用 Worker → unsupported，不进行错误运行时尝试。

验收：

- [ ] 同一个配置中的 portable JAR 和 Android JAR 可以分别路由；
- [ ] 路由结果写入 SiteHealth 和兼容报告；
- [ ] 关闭 Android Worker 时不会回退到已知必失败的普通 JVM 路径。

### C2.5 配置安全边界

**优先级**：P0  
**依赖**：C2.1

- 默认只接受 `http/https` 仓库；本地文件需用户显式选择；
- 限制响应大小、跳转次数、解压后大小和递归深度；
- 远程配置不能指定任意本地可执行文件或任意磁盘路径；
- LAN/localhost 访问提供显式开关，避免远程仓库静默探测本机服务；
- 下载的 JAR/JS/Python 记录哈希，更新时重新评估能力和权限。

---

## 9. N3：PC 原生运行时

### N3.1 drpy 可行性验证与实现

**优先级**：P0  
**依赖**：S1.1、C2.4

第一步必须先做 3～5 个真实 drpy 规则的兼容试验，比较以下方案：

| 方案 | 优点 | 风险 |
|---|---|---|
| 独立 Node Worker | 更接近大量 drpy 规则的实际 JS 环境 | 打包、模块权限和远程代码安全 |
| 扩展 QuickJS | 体积小、现有基础多 | Node API、DOM/解析工具和同步语义差距大 |
| 外部 drpy 服务 | 接入快 | 用户部署复杂，不符合单地址体验 |

默认建议选择受 Supervisor 管理的独立 Node Worker，禁止在 Electron renderer 或主进程直接执行远程规则。

工作内容：

- 固化 drpy 方法、全局对象、请求、解析和 local storage 契约；
- 将网络、缓存和代理通过宿主白名单 API 暴露；
- 文件系统只允许 Worker 专属临时/缓存目录；
- 限制动态模块、子进程和任意 native addon；
- 输出统一 SpiderResult。

验收：

- [ ] 选定的 drpy 夹具通过 home/category/search/detail/player；
- [ ] 无限循环和内存膨胀规则可被杀死；
- [ ] 规则无法访问用户任意文件或启动进程；
- [ ] 打包后无需用户另装 Node。

### N3.2 QuickJS 宿主契约补齐

**优先级**：P1  
**依赖**：S1.1

工作内容：

- 以真实失败报告驱动补齐 `req/axios/cheerio/CryptoJS/dayjs` 等通用能力；
- 明确 CatVod JS 与 drpy 的边界，禁止用空函数伪造 drpy 全局；
- 完善 ESM 相对 import、循环依赖、缓存和 source URL；
- Promise、定时器和网络请求统一受 deadline 控制；
- `local` KV 按 siteKey 隔离并限制大小。

验收：

- [ ] 缺失全局给出变量名和运行时建议；
- [ ] 配置切换后不同站点不共享 JS 状态；
- [ ] JS 网络请求继承宿主代理和安全策略。

### N3.3 Python Spider 隔离

**优先级**：P1  
**依赖**：S1.1

- 动态 Python Spider 移入独立进程；
- 插件目录按内容哈希和 siteKey 隔离；
- 禁止路径穿越和覆盖宿主模块；
- 记录依赖缺失而不是运行时静默失败；
- 配置更新后销毁旧模块状态。

### N3.4 CMS 适配器收敛

**优先级**：P1  
**依赖**：C2.1

- JSON/XML、分页、搜索、详情和播放字段统一；
- 支持常见编码、重定向和服务端伪分页；
- HTML 页面不得误标为直链；
- CMS 失败不使用解析器掩盖配置接口错误。

### N3.5 统一 `/proxy` 数据面

**优先级**：P0  
**依赖**：S1.2

- JAR、JS、Python、drpy 和 PanProvider 共享一个调度入口；
- query、POST body、请求头和 `siteKey` 保持原始语义；
- 支持流式 body、Range、206、Content-Range、重定向和断连取消；
- 保留旧端口兼容，但内部统一转到当前网关；
- token 保护控制接口，播放代理使用不可猜测短期会话令牌或严格 loopback 限制。

---

## 10. A4：Android FongMi Worker

Android Worker 是 C2 级兼容的核心，也是风险最高的部分。必须先做可行性闸门，不能直接进入完整实现。

### A4.1 可行性 Spike 与 Go/No-Go

**优先级**：P0  
**依赖**：S1.1、C2.4

至少验证三类真实样例：

1. 只依赖 Android Context 的 DEX JAR；
2. 动态加载二级 DEX 的 JAR；
3. 包含 ARM native `.so` 和本地 Proxy 的 JAR。

评估方案：

| 方案 | 单机体验 | 主要风险 |
|---|---|---|
| 打包 Android guest/emulator | 最接近“只输入地址” | 安装体积、冷启动、内存、ARM 转译和许可证 |
| 配套 Android 设备 Worker | 兼容度高 | 需要另一台设备，不符合默认 PC 单机体验 |
| 自托管远程 Android Worker | PC 端轻量 | 隐私、运维、网络依赖和成本 |
| 继续补 JVM Android shim | 体积较小 | 无法解决完整 Android Framework 和 ARM native 库 |

Go 条件：

- [ ] 三类样例至少两类完成 `init/home/player/proxy`；
- [ ] 冷启动、安装体积和内存达到产品可接受范围；
- [ ] Worker 可被桌面端可靠启动、停止和更新；
- [ ] FongMi 代码、Android 镜像、ARM 转译及分发许可证完成审查；
- [ ] Cookie 和播放地址不需要上传到未知第三方。

No-Go 后的产品策略：正式定义 C1 为支持上限，对 Android-only 源给出明确提示，不再用 dex2jar 路径制造假兼容。

### A4.2 Android Worker RPC

**优先级**：P0  
**依赖**：A4.1 Go

Worker 至少实现：

- `hello/capabilities`；
- `loadJar/unloadJar`；
- `init/destroy`；
- `home/homeVideo/category/detail/search/player/live/action`；
- `proxyOpen/proxyRead/proxyClose` 或直接本地 HTTP 流地址；
- `setCookies/setProxy/clearCache`；
- `health/shutdown`。

验收：

- [ ] 协议有版本号和向后兼容策略；
- [ ] 所有请求带 requestId、siteKey 和 deadline；
- [ ] Worker 崩溃后宿主得到明确错误并可重启；
- [ ] 不把视频流编码进 JSON。

### A4.3 复用 FongMi Loader 契约

**优先级**：P0  
**依赖**：A4.2

- 在 Android 环境使用真实 `DexClassLoader`；
- 调用 JAR `Init`、`Proxy` 和 Spider `init`；
- 保持 site-level jar、shared spider 和 recent loader 语义；
- `ext`、Cookie、代理和缓存与桌面端配置同步；
- 不修改第三方 JAR 来适配某个仓库，必要适配应进入通用宿主 API。

### A4.4 Android Proxy 数据桥

**优先级**：P0  
**依赖**：A4.2、N3.5

- Android Worker 暴露 loopback 流或分块 IPC；
- 桌面代理转发 status、MIME、headers、Range 和 body；
- 客户端断开时通知 Android 关闭 InputStream；
- 代理会话有限时、有限并发、有限缓存；
- Android guest 内硬编码的 `127.0.0.1` 地址必须重写或映射到正确网络命名空间。

### A4.5 生命周期与打包

**优先级**：P1  
**依赖**：A4.3、A4.4

- 应用启动不强制立即启动 Android；首次需要时按需启动；
- 设置页显示安装体积、运行状态和资源占用；
- 退出应用默认停止 Worker，播放中退出按现有托盘策略处理；
- Worker 版本与桌面宿主版本建立兼容矩阵；
- 更新失败可以回滚上一版本。

---

## 11. P5：播放链路完整收敛

### P5.1 统一 PlayResult

**优先级**：P0  
**依赖**：G0.2

至少保留并归一：

```text
url, parse, jx, playUrl, header, headers, format,
subs, position, flag, drm, msg, code, proxy
```

规则：

- 未知扩展字段保留，避免宿主提前丢失未来契约；
- `headers` 与 `header` 归一但不覆盖优先级；
- `url` 为空不能回退到明显的 HTML episode id 并标记直链；
- 一次性 CDN URL 不进入长缓存；
- 原始站点 header、Spider header、解析器 header 按明确顺序合并。

### P5.2 对齐解析器语义

**优先级**：P0  
**依赖**：P5.1

- `parse=1`、`jx=1`、`playUrl` 前缀；
- `json:` 和 `parse:<name>`；
- type 0/1/2/4 解析器的路由、优先级和并发；
- `flags`、VIP 线路和站点级解析选择；
- JSON 响应嵌套字段、headers、重定向；
- iframe/WebView 嗅探、旧解析器 iframe 跟随和验证码会话；
- 所有失败窗口和 partition 必须按 playSessionId 清理。

验收：

- [ ] 离线解析夹具覆盖每种类型和优先级；
- [ ] 低优先级解析器先返回时不能抢占高优先级成功结果；
- [ ] 换集或取消后旧解析窗口不能触发新会话播放；
- [ ] 解析失败不残留 loading 和隐藏窗口。

### P5.3 请求头、Cookie 与会话

**优先级**：P0  
**依赖**：P5.1

- 大小写无关地合并 `User-Agent/Referer/Origin/Cookie/Authorization`；
- 解析 BrowserWindow 的会话 Cookie 可按域合并到最终媒体请求；
- Cookie 不写日志、不写前端 localStorage；
- 外部播放器不支持 header 时明确提示降级；
- 同一播放链的重定向、HLS master、variant 和 segment 使用一致会话。

### P5.4 媒体探测

**优先级**：P0  
**依赖**：P5.1、N3.5

播放器启动前执行轻量探测：

- 优先 HEAD；服务器不支持时 GET `Range: bytes=0-1`；
- 接受有效媒体 Content-Type、HLS 文本或可识别媒体魔数；
- 检测 HTML、JSON 错误页、登录页和 403；
- 探测使用最终 headers/cookies/proxy；
- 对一次性 URL 避免重复消耗，允许 Spider 标记 skipProbe。

探测失败进入下一解析线路或重新调用 `playerContent`，不能直接拉起 mpv 显示黑屏。

### P5.5 播放就绪与失败恢复

**优先级**：P0  
**依赖**：P5.4

- `playUrl` IPC 仅在 mpv `file-loaded`/ready 后返回 `ok=true`；
- 首帧超时主动停止对应会话进程；
- 断流重连重新评估一次性 URL，必要时重新调用 `playerContent`；
- 重连最多一次，避免无限循环；
- 用户关闭播放器立即终止重连和连播；
- 播放错误保留最终 URL、来源和错误层级供诊断，但 UI 不展示敏感 header。

### P5.6 网盘 Provider

**优先级**：P1  
**依赖**：N3.5、P5.3

- JAR 结果优先，宿主 Provider 只作为协议级降级；
- 夸克快路径开关保留并完成真实 Cookie 验收；
- UC、百度、天翼、123、迅雷先通过 JAR/Android Worker 验证，再决定是否增加 native adapter；
- 文件夹、多清晰度、转码、原画、短期 URL 和 Cookie 过期使用统一模型；
- 播放 URL 到期后自动刷新一次，不能缓存过期地址。

### P5.7 DRM 决策任务

**优先级**：P2  
**依赖**：M2 完成后单独立项

输出 ADR，比较 Chromium CDM、授权播放器 SDK、Android 播放器画面转交和明确不支持。未完成合法授权和安全评估前，不提供绕过 DRM 的实现。

---

## 12. U6：单仓库地址用户体验

### U6.1 配置加载进度

设置页显示：

```text
获取仓库 → 解析配置 → 检测 48 个站点 → 初始化运行时 → 可用 31 / 降级 6 / 不支持 11
```

要求：

- 阶段可取消；
- 取消后保留旧配置；
- 加载过程不冻结渲染层；
- 摘要可展开查看按运行时和错误层级分组的原因；
- 默认文案面向普通用户，技术详情放二级诊断。

### U6.2 健康站点展示

- healthy 正常展示；
- degraded 可展示，但首次进入前说明需要 Cookie/Android Worker/解析器；
- unsupported 默认隐藏，诊断页保留；
- circuit-open 暂时置灰并显示自动恢复倒计时或重试按钮；
- 不因单个首页为空永久屏蔽源，区分合法空内容和运行错误。

### U6.3 播放状态机

界面状态固定为：

```text
获取播放地址 → 选择解析线路 → 验证媒体 → 启动播放器 → 已加载
```

每一步只有当前 playSessionId 可以更新 UI。失败时给出：

- 当前失败阶段；
- 是否已尝试备用线路；
- 用户可执行动作：重试、换线路、更新 Cookie、启用 Android Worker、安装/指定 mpv；
- 技术详情复制入口，不复制 Cookie/token。

### U6.4 自动回退

- 当前线路 `playerContent` 失败时，可按用户设置尝试同影片其他线路；
- 自动回退有最大次数和总时间预算；
- 不跨影片标题盲目匹配；
- 回退成功后记录健康度，但不永久修改仓库配置；
- 用户主动选择线路时优先尊重用户选择。

---

## 13. Q7：测试与验收体系

### Q7.1 确定性离线夹具

新增本地 HTTP 测试服务，至少提供：

- JSON/XML CMS；
- 注释/gzip/JPEG/PNG 伪装配置；
- 多仓与相对 `api/jar/ext`；
- 直链 MP4；
- master/variant HLS；
- Referer/Cookie 校验；
- 302/307 重定向；
- Range 206 与故意错误的 Content-Range；
- HTML 假视频地址；
- 解析器 JSON、iframe 和媒体嗅探；
- 慢响应、无限流、连接中断和过期 URL。

### Q7.2 运行时契约夹具

- Python 正常/异常/无限循环 Spider；
- JS 正常/缺全局/Promise 永不完成 Spider；
- drpy 代表规则；
- portable JAR 正常/异常/Proxy 流；
- Android Context、二级 DEX、native `.so` 三类 JAR；
- 所有夹具必须具备可分发许可或由项目自行编写。

### Q7.3 公共仓兼容报告

21 仓及后续用户问题仓继续作为网络趋势语料，报告至少包含：

- S0/S1 成功率；
- configured/built/initialized/healthy 数量；
- 按 CMS/JS/Python/drpy/JAR/Android 分类的成功率；
- home/search/detail/player/media/ready 成功率；
- skipped 和错误码分布；
- 宿主回归、上游不可达、账号缺失三类归因。

公共仓 URL 和结果可能变化，不能把曾经的播放地址、Cookie 或受限媒体固化进仓库。

### Q7.4 故障注入

- 杀死 JVM、Node、Python 和 Android Worker；
- Worker 无限循环、内存增长、stdout 污染和半包 JSON；
- 代理客户端中途断开；
- 配置重载期间正在播放；
- DNS、TLS、HTTP 429/403/500；
- 磁盘只读、缓存损坏、端口冲突；
- mpv 缺失、启动失败、首帧超时和播放中断。

每个故障都必须验证：主程序不崩溃、不永久 loading、资源被回收、错误可定位、下一次健康请求可恢复。

### Q7.5 性能与资源

记录：

- 冷启动时间；
- 首次配置加载时间；
- 100 站点初始化峰值；
- 单次搜索总耗时和在途任务数；
- Python/JVM/Node/Android Worker 内存；
- 首次播放地址获取、解析、媒体探测和首帧分段耗时；
- 配置重载前后进程、线程、端口和句柄数量。

### Q7.6 打包后实机矩阵

| 场景 | Windows 开发态 | Windows 安装包 | macOS | Linux |
|---|---:|---:|---:|---:|
| CMS/JS/Python | 必须 | 必须 | M2 后 | M2 后 |
| drpy | 必须 | 必须 | M2 后 | M2 后 |
| portable JAR | 必须 | 必须 | 评估 | 评估 |
| Android Worker | Spike | M3 必须 | 单独评估 | 单独评估 |
| mpv 首帧 | 必须 | 必须 | 必须 | 必须 |
| 代理 Range/HLS | 必须 | 必须 | 必须 | 必须 |

---

## 14. R8：发布、开关与回滚

### R8.1 功能开关

至少提供：

- `runtime_drpy`；
- `runtime_android_worker`；
- `pan_fast_path`；
- `media_probe`；
- `auto_line_fallback`；
- `legacy_parser`。

开关用于灰度与回滚，不能成为长期绕过测试的手段。默认值必须记录在配置 schema 和迁移测试中。

### R8.2 数据迁移

- 旧配置历史、收藏、观看历史和 Cookie 不丢失；
- 旧站点缓存升级为 ConfigSnapshot/SiteHealth；
- 不兼容缓存可安全丢弃并重建；
- 回滚旧版本时不读取无法识别的 Worker 状态文件。

### R8.3 发布门禁

发布前必须同时满足：

- [ ] `npm run test:all` 全绿；
- [ ] 离线端到端播放矩阵全绿；
- [ ] 公共仓报告已生成并完成回归归因；
- [ ] Windows 安装后首次冷启动通过；
- [ ] 无 Worker/JVM/mpv 残留进程；
- [ ] 日志脱敏测试通过；
- [ ] 功能开关回滚验证通过；
- [ ] Android Worker 如启用，许可、更新与体积检查通过。

---

## 15. 风险清单

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| Android guest 体积和资源不可接受 | 高 | C2 无法单机交付 | A4.1 先 Spike；No-Go 时正式收敛 C1 |
| ARM native 库无法在目标 guest 运行 | 高 | 部分热门 JAR 仍失败 | 使用真实 ARM 样例验证，不以纯 Java JAR 代替 |
| 远程规则执行带来安全问题 | 高 | 文件、凭据和主机安全 | 独立进程、最小权限、网络/文件白名单、资源限额 |
| drpy 方言和宿主全局过多 | 中高 | 长尾规则失败 | 真实语料驱动能力矩阵，缺失能力明确报错 |
| 公共仓频繁失效 | 高 | 测试噪声 | 离线夹具做门禁，公共仓做趋势和归因 |
| 解析接口带验证码/登录态 | 中 | `parse=1` 失败 | 独立持久 session、人工验证入口、Cookie 合并 |
| 网盘短链过期 | 高 | 可播放结果很快失效 | 不长缓存，过期自动重新 `playerContent` 一次 |
| 多 Worker 增加安装体积 | 中高 | 发布和更新成本 | 按需组件、延迟安装、清晰展示体积 |
| 修复触碰用户现有未提交代码 | 中 | 回归或丢改动 | 小批次提交、先读 diff、避免跨模块机械重写 |

---

## 16. 预估排期

以下为一名熟悉 Electron、Python、Java/Android 和流媒体的工程师估算，不是固定承诺；Android Worker 的排期必须以 A4.1 结果重新评估。

| 阶段 | 预计工作量 | 可交付结果 |
|---|---:|---|
| G0 + S1 | 1.5～2.5 周 | 应用不再被坏源卡死，错误和健康度可信 |
| C2 | 1～2 周 | 配置、`ext`、能力路由和原子更新稳定 |
| N3 | 2～4 周 | drpy、QuickJS、Python、portable JAR 主流源可运行 |
| P5 原生部分 | 2～3 周 | 直链、解析、代理、网盘和首帧链路收敛 |
| A4.1 Spike | 1～2 周 | Android Worker Go/No-Go 与实测数据 |
| A4 完整实现 | Go 后 4～8 周 | Android/Dex/native JAR 混合运行时 |
| U6 + Q7 + R8 | 2～3 周 | 用户流程、实机矩阵和发布门禁 |

预期：

- **M1 稳定宿主**：约 2 周；
- **M2 PC 主流兼容**：约 5～8 周；
- **M3 混合运行时兼容**：约 10～16 周，取决于 Android Worker；
- 多人并行只能压缩 N3、A4、P5 和 Q7，G0/S1 的基础契约必须先统一。

---

## 17. 第一迭代建议（10 个工作日）

第一迭代不做新 UI 和 Android 完整实现，目标只有一个：让宿主面对坏源时稳定、可终止、可诊断。

### 第 1～2 天：契约和夹具

- [x] 完成 G0.2 运行时/错误模型；
- [x] 增加正常、异常、超时、取消和无限循环离线夹具；
- [x] 给 `/action` 增加 requestId 贯穿；
- [x] 固化当前代表仓测试证据。

### 第 3～6 天：Supervisor

- [x] 完成 S1.1 最小 Supervisor；
- [x] 先迁移 Python/测试 Worker，验证 Windows `spawn`；
- [x] 接入硬 deadline、terminate、restart；
- [x] 增加退出和配置重载资源回收测试。

### 第 7～8 天：JAR 与搜索

- [x] 将 JAR 生命周期接到 Supervisor；
- [x] 队列等待计入调用预算；
- [x] 修复聚合搜索和兼容套件 `shutdown(wait=True)` 卡住；
- [x] 验证一个阻塞 JAR 不影响其他健康源。

### 第 9～10 天：健康度和回归

- [x] 完成 configured/built/initialized/healthy 状态；
- [x] Android L3 JAR 未有 Worker 时不再假装健康；
- [x] 运行 Python、JS、兼容夹具和代表仓测试；
- [x] 更新 `ARCHITECTURE.md`、`RUNTIME_ISSUES.md` 和本任务状态。

第一迭代退出标准：

- 无限循环源在预算内被杀死；
- 真实仓兼容测试无需人工 Ctrl+C；
- 导入摘要不再把初始化失败的站点计为可用；
- 现有 Python/JS 回归不退化；
- 没有新增按仓库名称或 JAR 哈希的特判。

---

## 18. 任务执行规则

每个任务开始前必须具备：

- 明确输入夹具或真实失败证据；
- 已确定所属层级和运行时；
- 已写成功/失败验收条件；
- 已确认不会覆盖用户现有未提交修改。

每个任务完成必须同时具备：

- 生产代码；
- 正常、异常、超时和取消测试；
- 结构化日志和错误映射；
- 对应文档更新；
- 打包环境影响说明；
- 无资源泄漏证据。

禁止以下实现方式：

- 根据仓库名、作者名或单个线上 URL 分支；
- 用空结果伪装成功；
- 用线程 Future timeout 冒充可终止执行；
- 在 Electron renderer/main 直接执行远程规则；
- 将 Cookie、token 或 Authorization 写进报告；
- 未完成媒体探测和首帧确认就提示“播放成功”；
- 为提高公共仓数字而静默跳过失败阶段。

---

## 19. 状态维护

本文件负责下一阶段任务拆分和验收状态：

- 开始任务时把对应项标记为“进行中”，记录负责人或分支；
- 完成代码但未验收时只能标记“代码完成、待验收”；
- 完成后附测试命令、结果摘要和日期；
- 当前项目总状态同步到 `PROGRESS.md`；
- 具体故障证据同步到 `RUNTIME_ISSUES.md`；
- 架构或进程边界变化同步到 `ARCHITECTURE.md`；
- 旧的 `TVBOX_COMPAT_PLAN_REMAINING.md` 继续记录上一轮 Phase A-F 的外部环境验收，不与本文重复维护。
