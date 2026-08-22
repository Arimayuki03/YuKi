# TVBox / FongMi 契约差距审计

更新时间：2026-08-19

本文只记录宿主契约层的差距，不把某个仓库或某个 JAR 的特例当成通用修复。FongMi 对照源码位于本仓库的 `TV-fongmi/`，运行时行为以配置随源携带、宿主只负责契约为准。

## 结论摘要

| 优先级 | 契约面 | 当前结论 | 影响 × 成本 | 后续动作 |
|---|---|---|---|---|
| P0 | `playerContent` 的 `parse=1` 与 `parses` 路由 | 已接入基本路由；无解析器/无匹配时已补 L4 错误，但 `type=1` 扩展解析和更复杂 `jx` 语义仍需实测 | 高 × 中 | 继续补 parse-window 行为样例 |
| P0 | 本地代理端口 | 9978/7944/1314 固定监听 + JAR 扫描 + 播放地址按需监听；行为回归已补 | 高 × 低 | 兼容套件中加入端口命中统计 |
| P1 | JAR / spider 覆盖优先级 | 已支持站点 `jar` 优先于顶层 `spider`；`spider` 仍只对 `csp_` 类名共享 | 高 × 中 | 录入带双层覆盖的配置样本 |
| P1 | QuickJS 宿主缺失全局 | 常用 `cheerio`、`CryptoJS`、`dayjs` 已注入；`ReferenceError` 已转为可检索警告 | 中 × 低 | 根据兼容报告补通用宿主 API |
| P1 | 配置 L1/L2/L3/L4 诊断 | 结构化摘要、分层 skipped 标签和前端摘要已接入 | 高 × 低 | 让兼容套件报告持续聚合标签 |
| P0 | Android-only JAR | A4.1 三个真实 DEX 输入完整契约 0/3，No-Go；产品上限正式为 C1 | 高 × 高 | 固定准确提示，不进入 dex2jar/JVM；A4.2 不启动 |
| P2 | `type=15/16` | 当前未实现，不能凭类型编号猜测契约 | 中 × 中 | 先收集真实样本，再按源码契约实现 |
| P2 | `drives`、`heat`、`hotList` | 尚未形成桌面端业务契约；`wallpaper` 已保留 | 中 × 中 | 确认产品范围后建数据模型 |

## 1. 站点类型矩阵

对照点：`TV-fongmi/app/src/main/java/com/fongmi/android/tv/bean/Site.java`、`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/config/VodConfig.java`。

当前 Python 宿主的运行时判定集中在 `python-backend/runtime/capability_router.py::route_site`
（`config.py::_build_site` 与诊断页 `infer_site_health` 共用同一结论，不再各写一份规则）：

- R1 type `0/1`：CMS HTTP 源（要求 `api` 是 http(s)，地址长得像脚本也不改判）；
- R2 `.py` 后缀或 type `3` 无更具体特征：Python spider；
- R3 `.js` 后缀或 type `4`：QuickJS spider，其中 drpy 单独归类；
- R4 `csp_` 类名或 `.jar`：portable JVM JAR；
- R5 字节级分级出现 Dex/native/Android API/DRM 信号：Android Worker；
- R6 其余（含 type `15/16`、未知 type、缺 `api`、`type` 写成非整数）：unsupported，带稳定
  错误码，不做任何“错误运行时尝试”。

缺省 `type`（缺失或 `null`）按 Gson 语义等于 0 → CMS。未知 `type` 原样保留、不折叠成 0，
条目本身仍然有效，只是不进入可用清单。

差距是 type `15/16` 的真实 FongMi 实现尚未在当前源码树中形成可运行桌面契约。后续不能简单把它们映射到 CMS；必须先拿到包含该类型的配置和对应 FongMi parser 行为。

## 2. per-site `jar` / `spider` 覆盖

对照点：`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/config/VodConfig.java` 的站点解析，以及 `TV-fongmi/app/src/main/java/com/fongmi/android/tv/bean/Site.java` 的 `spider` / `jar` 字段。

当前规则是：站点 `jar` 非空时优先；否则使用顶层 `spider`；`api=csp_XXX` 时将类名交给 JAR bridge。
优先级由 `runtime/config_snapshot.py::normalize_site_entry` 一处产出（`jar` / `jar_md5` /
`jar_from_site`），`_build_site` 只消费结果，不再把覆盖逻辑散落到 JAR 调用层。`jar` 的
`;md5` 后缀与伪装扩展名（`.jpg`/`.png`/`.bin`）在拆引用时都保留，相对 `jar` 按配置最终
URL 解析。

待补样本：同一配置同时提供顶层 JAR、站点 JAR、站点 `spider` 字段时的冲突优先级；额外字段
整条保留在 `raw` 并登记到 `unknown_fields`，不静默丢弃。

## 3. `ext` 与相对路径

对照点：`TV-fongmi/app/src/main/java/com/fongmi/android/tv/gson/ExtAdapter.java`、
`bean/Site.java` 的 `setExt`/`fetchExt`、`api/SiteApi.java` 的调用点；当前对应
`python-backend/runtime/ext_resolver.py`。

相对 `api`、`jar`、`ext`、`playUrl` 按配置的**最终** URL（跳转/多仓之后）解析；伪装后缀的
JAR URL 不按扩展名过滤，而由下载内容校验。`ext` 的完整语义已按上游对齐：任意 JSON 值
（字符串/对象/数组/数字/布尔）归一为字符串；对象与数组内部的相对路径同样按最终 URL 解析；
HTTP `ext` 的展开遵循 `SiteApi` 的分歧——只有 type=4/JS 在 `homeContent` 前展开一次，
type=3 的 spider 拿到原始字符串自己决定要不要取。空响应保留原 URL；展开有体积上限、
超时、编码识别（含无声明 GBK）、ETag 缓存、深度上限与环检测；失败只影响该站点，取消则
上抛为整次加载结束。

## 4. `parses`、`jx` 与播放路由

对照点：`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/config/VodConfig.java` 的 `parses`；`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/parser/ParseParser.java`（若上游版本提供该类）；当前对应 `src/main/parse-window.js` 和 `src/renderer/js/player.js`。

当前已覆盖：

- `parse=1`、`jx=1`、`json:`、`parse:<name>`、普通 `playUrl` 前缀和配置 `flags`；
- type 0 BrowserWindow、type 1 JSON、type 2 portable JAR `Json<name>.parse`、type 4 并发；
- type 4 等待候选完成后按配置 priority/order 选取，低优先级先返回不能抢占；
- JSON 嵌套 URL/header、重定向、媒体请求嗅探和 legacy iframe 跟随；
- 窗口、webRequest hook 和 partition 按 playSessionId/requestId 隔离并在失败/超时/取消后清理；
- 解析器的 `ext.flag` 与上游一致只作**偏好**（`VodConfig.getParses(type, flag)` 的
  `filter.isEmpty() ? items : filter`）：没有解析器点名当前线路时仍按配置顺序试全部解析器；
  配置完全没有可执行解析器时，后端只附带非致命 `warning`（`当前配置未含可用的解析接口（parse=1）`）
  并保留 `url/parse/header`，渲染层照上游 `ParseJob` 的 type 0 回退继续隐藏窗口嗅探，
  只有播放地址为空才提升为 424；
- 每个候选在交给播放器前执行媒体探测，HTML、JSON、登录页和 403 不进入 mpv。

边界：type 3/click 脚本不在 P5 指定范围；需要人工验证码的页面仍需用户完成验证，宿主只
保证同一窗口会话 Cookie 合并和资源清理。离线行为证据见
[P5_PLAYBACK_MATRIX.md](P5_PLAYBACK_MATRIX.md)，不能替代更多真实站点验收。

## 5. `playerContent` 语义与 header

对照点：`TV-fongmi/catvod/src/main/java/com/github/catvod/crawler/Spider.java` 的六方法契约，以及 `TV-fongmi/app/src/main/java/com/fongmi/android/tv/bean/Result.java` 的 `playUrl` 字段。

Python `Runner` 保持六方法入口；JAR、JS、Python、CMS 统一保留
`url/parse/jx/playUrl/header/headers/format/subs/position/flag/drm/msg/code/proxy` 和未知扩展字段。
五类敏感 header 大小写无关地按站点、Spider、解析器和窗口会话的明确顺序合并。内置 mpv
透传最终 header；外部播放器不能透传时返回 `headerDropped`，且只报告 launched，不伪造首帧成功。

播放前先 HEAD，结果不确定时 GET `Range: bytes=0-1`；只有 mpv `file-loaded`/ready 后
`yuki:play` 才返回 `ok=true`。一次性/签名 URL 不长缓存，断流时重新执行原始
`playerContent`，最多一次。真实夸克 Cookie 和真实 CDN 首帧仍是外部验收项，不以夹具冒充。

## 6. lives / liveContent

对照点：`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/parser/LiveParser.java`、`TV-fongmi/app/src/main/java/com/fongmi/android/tv/api/config/LiveConfig.java`。

配置的 `lives` 已保存并通过 `/sites` 暴露；JAR/JS/Python spider 的 `liveContent(url)` 已有统一入口。桌面端另有自定义 TXT/M3U 导入和本地播放链路。

差距：需要真实直播配置验证嵌套 `channels`、多线路、直播源重定向、EPG 与 `liveContent` 返回文本的编码/格式；目前没有将这些场景误标为完成。

## 7. JS 宿主环境

对照点：`TV-fongmi/quickjs/src/main/java/com/fongmi/quickjs/crawler/Spider.java`；当前对应 `python-backend/js-engine/host_bootstrap.js`、`quickjs_host.py`、`lib/cat.js`。

已注入常用 `cheerio/$`、`Crypto/CryptoJS`、`dayjs` 及若干 cat.js 工具。JS 加载或调用出现 `ReferenceError: xxx is not defined` 时，宿主会记录 `该 JS 源需要宿主未提供的全局 <xxx>`，并保留原错误路径。

未覆盖：drpy 专用 `pdfa/pdfh/pdft`、HikerWeb 等非 CatVod 全局。它们属于不同运行时契约，应该单独实现兼容层或明确跳过，不能静默注入空函数造成假成功。
自 C2.4 起 drpy 由 Capability Router 独立归类（规则 `R3-drpy`、兼容级 C0、错误码
`L2_SITE_UNSUPPORTED`、`worker` 为空），不再混进 QuickJS 路径造成“加载成功、调用期才炸”。
识别按路径/文件名的 drpy 标记做，不对 `predrive.js` 这类无关词误判。

drpy 正式运行时（N3.1）已基于独立 Node Worker 实现完毕（受 Supervisor 进程级托管，
包含完整 DOM 选择器、CryptoJS、受控同步网络请求与持久化 Local KV，具备超时强杀与自愈能力）；
`capability_router.py` 对 drpy 规则已正式升级为 `C1 / worker='drpy'`，并完全打通
SupervisedRunner 与健康诊断体系。

## 8. 快捷字段

| 字段 | 当前状态 |
|---|---|
| `wallpaper` | 已读取并在设置/皮肤链路使用 |
| `drives` | 未实现桌面端网盘挂载契约 |
| `heat` | 未形成统一数据模型 |
| `hotList` | 未形成统一数据模型 |

`drives`、`heat`、`hotList` 的实现成本取决于产品是否要暴露入口；在范围确认前仅保留审计结论，不把未使用字段误报为兼容缺陷。

## 具体后续任务

1. 在兼容语料中加入：站点级 JAR 覆盖、`parse=1` 无解析器、`parse=1` 多 flag、HTTP `.js`、伪装 JAR URL 五类最小配置。
2. 保持 type 0/1/2/4、`jx`、legacy iframe、媒体探测和首帧离线矩阵为发布回归门禁。
3. 取得真实 type 15/16 配置和 FongMi 对应 parser 后，再实现 L2 契约，不按编号猜测。
4. 兼容套件报告继续按 `[L1:*]`、`[L2:*]`、`[L3:*]` 聚合 skipped 原因。

## 2026-08-18 G0 契约收敛

- 已建立 `RuntimeRequest`、`RuntimeResponse`、`RuntimeError`、`SiteHealth`；错误层固定为
  L1 配置、L2 站点、L3 运行时、L4 解析、L5 媒体、L6 播放器。旧的
  `[L2:type]` / `[L3:js]` 细类仅作为脱敏诊断附加信息保留。
- `/action` 的 `requestId/playSessionId` 已贯穿 Runner、JAR RPC、解析窗口、本地代理和
  mpv 会话；运行时失败使用非 2xx HTTP + 结构化错误，不再以裸字符串表示失败。
- 配置摘要改为 configured/built/initialized/healthy。内容页只消费 healthy 站点，设置页
  的站点诊断仍展示跳过原因。
- Dex、Android API、native library 和 DRM JAR 在 Android Worker 缺失时固定为
  `L2_SITE_REQUIRES_ANDROID` / C2，不再进入普通 JVM 路径并误报 healthy。
- 兼容基线默认使用 loopback 正常/异常/超时/无限循环夹具；21 仓公共语料改为显式
  `--public`，外网失败不参与确定性成功判定。
- 兼容套件按探测 requestId 调用 `/runtime/cancel`，只有 Worker 已终止且 dispatch 已收尾才
  记录 cancelled；离线超时/无限循环夹具自然退出并验证后代 Python 为 0。外层进程树终止
  只保留为仓级异常兜底，`Future.cancel()` 不作为硬终止证据。
- `/action` 端点覆盖正常、异常、deadline、客户端断连和资源登记清理；解析 JSON/iframe
  取消会中止请求、销毁隐藏窗口并释放解析槽位。JAR/Spider 内嵌错误会被提升为非 2xx
  结构化响应，不再以 HTTP 200 + 字符串 error 表示失败。

## 2026-08-18 S1 可终止边界收敛

- 远程 Python、QuickJS、CMS 和 portable JAR 控制调用按站点进入 spawn Worker；子进程在
  加载不可信代码前等待父进程绑定 Windows Job Object，绑定失败不继续运行。Job Object
  负责内存上限和整棵进程树回收，超时后以 Worker 实际退出作为完成证据。
- 调用预算从进入 Supervisor 队列时开始，覆盖锁等待、Worker/JVM 启动、RPC 和重启。
  JAR 慢调用不再让后续请求无限排队；JVM 被杀后下一健康请求会重建运行时。
- JAR Proxy 的控制帧只含状态、headers 和一次性 stream 描述符；媒体字节仍走 loopback
  socket。Range 中断由上游 `InputStream.close()` 回连和数据端口关闭共同证明，不把视频
  整体编码到 JSON/stdout。
- 聚合搜索采用 20 秒总预算、16 个最大在途源和增量背压；未完成源由 Supervisor 终止。
  `Future.cancel()` 仅阻止未开始的协调任务，不再充当底层工作结束证明。
- 连续 3 次同阶段可重试错误熔断 60 秒，单探测半开成功后恢复。Cookie 缺失使用
  `L3_RUNTIME_CREDENTIALS_REQUIRED` 且不自动重试，网络超时使用可重试错误；Cookie/配置
  更新或用户主动重试可提前探测，三条恢复入口均有 HTTP `/action` 集成测试。
- 仍未解决的 Android/Dex/native JAR 属于后续 A4/C2 路由范围；S1 没有进入或伪造 C2。

## 2026-08-18 C2 配置与路由收敛

- 配置分成三层：`ConfigFetchResult`（下载层，记录源 URL、最终 URL、ETag、Last-Modified、
  内容哈希、载体与解码方式）、`ParsedConfig`（纯数据，可丢弃，解析期不碰网络）、
  `ConfigSnapshot`（运行中，原子换入单位）。更新按 prepare → validate → atomic swap；
  validate 不通过时旧快照连站点一起保留，本次新起的 Worker 全部释放，不先清空再装配。
- 同内容哈希重复加载复用运行中的快照，不重启全部 Worker；显式 force 仍会重建。运行中
  快照里没有任何 healthy 站点时拒绝复用，避免把一份坏配置永久钉住。
- 多仓 `urls` 记录 `RepoTrail`：清单 URL、被选中的条目、逐个失败原因与回退顺序。
  嵌套多仓在深度 1 处拒绝；子仓指向私网被守卫拦下；条目列表超限时截断且尾部不发请求。
  跨仓合并只增不删——主条目提供点播源，其余条目补 `lives`/`sites`。
- 站点字段矩阵由 `normalize_site_entry` 一处产出。未知字段进 `unknown_fields`、整条原文
  进 `raw`、未知 `type` 不折叠成 0；畸形条目标记为结构化 unsupported 而不是静默丢弃。
- Capability Router（`runtime/capability_router.py`）成为唯一路由入口，`_build_site` 与
  诊断页共用同一结论。R4→R5 由 `refine_with_jar` 在字节级分级之后收敛，与
  `jar_bridge._require_available_runtime` 用同一组 Android 信号；Android Worker 关闭时
  `worker` 为空并固定 `L2_SITE_REQUIRES_ANDROID`，不再回退已知必失败的普通 JVM 路径。
- 配置安全边界（`runtime/config_security.py`）：默认上限配置 8 MiB、解压后 32 MiB、
  单站点 `ext` 2 MiB、跳转 5 次、多仓深度 1、`ext` 深度 2。伪协议一律拒绝；磁盘路径在
  scheme 分派之前判掉。私网信任按 `scheme+host+port` 继承，不是「同机就行」；每一跳
  跳转都重新过守卫。体积防线分 `read_capped`（流式截断）与 `decompress_capped`
  （增量 zlib）两层，声明超长 `Content-Length` 在读正文前即被拒。
- 本轮修掉两个由测试暴露的真实缺陷：`guard_url` 把 Windows 盘符当协议，使
  `D:/tv.json` 报成「不支持的协议 d://」，诊断原因与真实问题不符；`detect_text` 只剥
  一层字节 BOM，重复 BOM 的配置解码后仍以 U+FEFF 开头，`json.loads` 在第 1 列报错，
  看上去像用户写错了配置。
- 仍未收敛：type `15/16` 缺真实配置与上游 parser 契约，不按编号猜测；drpy 只做独立
  归类（C0 / `worker` 为空），真正的运行时属于 N3.1，本轮没有实现也没有假装实现。

## 2026-08-19 A4.1 Android Worker Spike

- 固定三份真实 DEX 样例及 SHA-256：Android Context、`DexFile.loadDex`/`classes2.dex`、
  ARM v7/v8 native 下载路径 + `127.0.0.1:8944` Proxy。ARM payload 实测返回 HTTP 403，
  因而没有把 ABI 字符串冒充成 ELF/运行成功；上游 FongMi AAR 中两种 ARM ABI 的真实 `.so`
  只作为交叉证据，不替代 JAR 验收。
- JVM shim 的 `init/home/player/proxy` 最终完整结果为 0/3。player 探针必须从真实
  `home → category → detail` 取得 episode id、读到媒体字节并由 mpv 出首帧；proxy 必须有
  200/206、MIME 和 body，返回 URL 或初始化不抛错均不算完成。
- 当前机器没有 SDK/adb/emulator、配对设备或远程 Worker endpoint；对应 Android 方案的
  冷启动、内存、安装体积和生命周期均为未测，不能用 JVM shim 数字代替。
- 决策为 No-Go：`runtime/android_policy.py` 固定 C1 支持上限，Android-only 站点保留 C2
  诊断但不可运行；`L2_SITE_REQUIRES_ANDROID` 明确提示当前上限与替代源，并禁止 dex2jar
  回退。环境变量的 enabled/ready 握手不能越过产品策略。
- FongMi 根许可证确认是 GPLv3；Android 镜像、ARM 转译、第三方 native AAR/so 和组合分发
  未获批准，许可证 Go 门槛失败。完整证据见
  [ANDROID_WORKER_SPIKE_REPORT.md](ANDROID_WORKER_SPIKE_REPORT.md)。
