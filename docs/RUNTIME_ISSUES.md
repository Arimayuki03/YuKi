# 运行时问题记录（实时监测）

> 来源：后台运行日志 `yuki/session-logs/`（2026-08-09 起，实时监测）。
> 本文件只维护运行异常、日志证据、代码修复和复测结果。当前待办汇总见 [../PROGRESS.md](../PROGRESS.md)。

## 当前结论

| 编号 | 结论 | 验证状态 |
|---|---|---|
| R1 | Bangumi 收藏端点已改为先取真实 username | ✅ 已验证：有效 token、`/v0/me` 与收藏列表均成功 |
| R2 | XPath 节点内 `//` 语义已修正 | ✅ 已验证：7sefun 有结果；DM84/enlie 为外部站点故障 |
| R3 | 单规则失败隔离符合设计 | 无需修复 |
| R4 | 主框架加载失败可快速跳过死解析站 | ✅ 已验证：Electron 解析 IPC 在 128ms 内失败返回 |
| R5 | 解析窗口监听器告警已抑制 | ✅ 已验证：连续 5 次调用均快速返回，未见告警，应用保持存活 |
| R6 | Bangumi 搜索端点与 User-Agent 已修正 | ✅ 已验证：官方搜索接口返回结果 |
| R7 | 观看统计断流重连重复累计已改为按观看链去重 | ✅ 已验证：独立实例 CDP 实测重连只补增量、次数不重复 |
| R8 | `ended` 事件附带会话号并按会话匹配「看完」判定 | ✅ 已验证：旧会话延迟 ended 不误判新会话，新会话自身 ended 判看完 |
| R9 | G0 运行时契约、站点健康和兼容夹具退出边界 | ✅ 已验证：离线 4 夹具、Python 全量、Node 222/222、JS 语法 40/40 |
| R11 | S1 不可信运行时隔离、硬超时、聚合取消和熔断恢复 | ✅ 已验证：Python 24 阶段、Node 225/225、JS 语法 40/40、Ruff/ESLint 0 error |
| R12 | C2 配置三层分离、prepare→validate→atomic swap、`ext` 语义、能力路由与配置安全边界 | ✅ 已验证：`run_all.py` 28 阶段全通过、编译 79 文件 0 error；四个新阶段共 157 条全部走 loopback 夹具不出网 |
| R13 | `guard_url` 把 Windows 盘符当协议，`D:/tv.json` 报错原因与真实问题不符 | ✅ 已修复并验证：`test_config_security.py::test_blocked_local_disk_paths` |
| R14 | `detect_text` 只剥一层 BOM，双 BOM 配置被 `json.loads` 报成第 1 列语法错误 | ✅ 已修复并验证：`test_ext_semantics.py::test_bom_and_declared_and_fallback` |
| R15 | 多仓合并/主仓漂移后同名 key 的可用源被旧探测屏蔽记录误隐藏 | ✅ 已修复并验证：探测结论附带内容指纹 probeFp；home-probe 78 例、JS 单元 312/312、run_all.py 全阶段 PASS |
| R16 | `spider-loader.js` 协议桥命名与宿主断裂：243afd9 全局重命名 VPC→YuKi 时漏改 loader，宿主 `ctx.get('__YUKI_CALL__')` 取到 None，所有 JS 源方法调用报 `'NoneType' object is not callable` | ✅ 已修复并验证：loader 对齐 `__YUKI_CALL__/__YUKI_PENDING__/__YUKI_RESULT__/__YUKI_FETCH_RESULT__/__yuki_err__`；test_phase3 30/30 PASS（修复前必现 KeyError）、test_jar_proxy 4/4 OK、全量回归见 PROGRESS 同日记录 |

---

## 2026-08-09 2A 实际界面验收（补）

此前「实际 Electron 界面验收」因浏览器控制连接在读取页面前中断未计为通过。本轮改用**独立 userData 副本**（清空 `lastConfigUrl`，避免 auto-reload 拉站点/弹窗干扰）以 `--remote-debugging-port` 启动临时实例，经 CDP（`scripts/acceptance-2a.js`，零依赖，Node 内置 WebSocket）实测，**全部通过**：

| 验收项 | 实测结果 |
|---|---|
| 设置位于左侧功能项末尾 | ✅ 真实几何排序最后（`order:98`，其余功能项之上） |
| 收缩按钮在设置之下 | ✅ `order:99` + `margin-top:auto`，视觉贴导航底部 |
| 左侧无独立关于入口/视图 | ✅ 无 `data-view="about"` 导航项与 `#view-about` |
| 系统页无画中画 / 无版本号 | ✅ 系统分类卡片无 PiP 元素、无版本号文案/控件 |
| 关于分类渲染版本号 | ✅ `#about-version` = `0.1.0` |
| 关于分类渲染系统信息 | ✅ Electron 31.7.7 / Chromium 126 / Node 20.18 / V8 / win32·x64 |
| 无 MiSans 动态注入 | ✅ 仅加载 `ui.css`，无 MiSans link/`@font-face`，根字体为系统字体栈 |
| 控制台错误 | ✅ 0 条（仅 1 条与 2A 无关的 Electron CSP 安全提示） |

临时实例结束自动 kill 并删除副本目录，不污染真实用户数据。判定脚本输出 `OVERALL: PASS`。


状态用语：**代码已修**表示修改已落地；**已验证**表示已有修复后的运行证据。两者不要混用。

## 2026-08-18 G0 运行时契约与兼容退出验证

本轮只覆盖 G0.1/G0.2/G0.3。兼容套件使用 loopback 正常、异常、超时和无限循环夹具；
G0 当时的超时夹具由仓级父进程树兜底。S1 收口后该路径已替换为逐 requestId 的 Supervisor
硬取消，超时/无限循环记录自然退出且后代 Python 为 0；报告不写入 Cookie、token 或
Authorization。

`RuntimeRequest` 的客户端断连、deadline 和主动取消都映射为结构化 L3 错误，运行时登记
在协作式退出后清理；解析 JSON/iframe 超时会通知主进程取消并释放隐藏窗口槽位。JAR/Spider
返回的嵌入式错误会被 `/action` 装饰器提升为非 2xx `RuntimeResponse`。Android/Dex/native
或 DRM 信号在 Android Worker 未完成 enabled+ready 握手时保持 `L2_SITE_REQUIRES_ANDROID`，
不会通过迟到回调重新变成 healthy。

生产 Worker 的进程隔离、硬杀、重启和熔断仍属于 S1；本记录的硬终止证据仅针对兼容套件
父子进程边界，不把测试夹具的能力宣称为生产 Supervisor 能力。

## 2026-08-18 S1 可终止运行时与资源回收验证

本轮完成 S1.1-S1.4。Windows Worker 统一使用 `spawn`，远程 Python、QuickJS 和 portable
JAR 控制调用均进入可终止进程；绝对 deadline 覆盖排队、Worker/JVM 启动、RPC 与重启。
超时和取消会终止实际 Worker 进程树，不以 `Future.cancel()` 作为任务结束证明。Worker/JVM
崩溃后可自动恢复；聚合取消按 `requestId` 精确匹配，不误杀同站点并发调用。同阶段连续
3 次可重试失败进入 60 秒熔断，半开只允许一个探测。

确定性故障测试覆盖正常、异常、无限循环、超时、取消、进程崩溃、自动重启、HTTP 熔断
恢复、20 次真实 Python/Node 配置重载、FastAPI/Electron 退出、Python/Java/Node 后代和
端口释放。50 个源中 10 个永久阻塞时，连续两次聚合搜索都在总预算内返回 40 个健康结果，
阻塞 Worker 全部退出。JAR Proxy 的媒体字节经一次性 loopback 数据 socket 传输；Range
断连验证 JVM 上游 `InputStream.close()` 和数据端口关闭，不以本地 `_closed` 代替。

最终 `npm run test:all` 通过：Python `run_all.py` 24 阶段通过并编译 70 个文件，Node 单元
225/225，JavaScript 语法 40/40，ESLint 0 error（64 条既有 warning），Ruff 通过。诊断夹具
访问 `example.com` 时得到预期 404/502，这属于外部响应/故障分类覆盖，不是代码回归失败。
本轮未进入 C2；Android/Dex/native JAR 和真实公共仓可用性仍按后续阶段及外部环境单独验收。

---

## 2026-08-18 C2 配置加载与安全边界验证

本轮完成 C2.1–C2.5。配置分为下载 / 解析 / 运行三层，更新按 prepare → validate →
atomic swap；新配置装配不出任何站点时旧快照连站点一起保留，本次已起的 Worker 全部释放。
同内容哈希重复加载只累加 `reuseCount`，不重启 Worker；多仓复用判据是「清单哈希 | 选中
子仓 URL | 子仓正文哈希」三者合成，只看清单会在子仓内容变化时错误复用。`ext` 按 FongMi
`SiteApi` 的分歧处理：type=4/JS 在 `homeContent` 前展开一次，type=3 拿原始字符串；空响应
保留原 URL；展开失败只写进该站点的 `error`，取消则上抛为整次加载结束。

确定性离线验收全部走 `tests/offline_config_server.py` 的 loopback 夹具，不出网：
`test_config_snapshot.py` 53、`test_ext_semantics.py` 39、`test_capability_router.py` 29、
`test_config_security.py` 36。配置形态覆盖单仓 JSON、多仓 depot（含嵌套/全坏/私网子仓/
条目截断）、带注释 JSON、gzip 直链（正文即 gzip）、传输层 gzip（`Content-Encoding`）、
JPEG/PNG 伪装、相对路径仓、未知 `type`、内联 JSON 与本地文件。四种载体解出同一个内容
哈希，任何解码错误表现为哈希不等而不是夹具写错。超时/取消覆盖预算耗尽报 L1、取消前零
请求、装配中取消释放全部 Worker、多仓回退中取消停止扫描。

`run_all.py` 28 阶段全部通过，编译 79 个 Python 文件 0 error。

本轮由测试暴露并修掉的两个真实缺陷（均属产品缺陷，不是测试写错）：

| 编号 | 现象 | 根因与修复 |
|---|---|---|
| R13 | 配置填 `D:/tv.json` 时，诊断页报“不支持的协议 d://”，与真实原因（引用了本地磁盘路径）不符 | `urlsplit('C:\\x\\tv.json')` 把盘符当成 scheme，而 `guard_url` 先按 scheme 分派。已把磁盘路径判定移到 scheme 解析之前（`runtime/config_security.py`）。`file://` 等伪协议形状不同，仍落 `scheme_blocked` |
| R14 | 合法配置报 `Expecting value: line 1 column 1`，看上去像用户把 JSON 写坏了 | 已带 BOM 的文件又被按 `utf-8-sig` 编码一次会有两层 BOM，`detect_text` 只剥一层字节 BOM，解码后文本仍以 U+FEFF 开头。已在所有解码分支去掉残留 BOM 字符（`runtime/ext_resolver.py`），用例加强为同时覆盖单 BOM 与双 BOM |

环境侧两条与代码无关的干扰，单独记录以免误判为回归：裸 `python` 缺 `lxml`，导入
`config` 即 `ModuleNotFoundError`，必须用 `python-backend/.venv/Scripts/python.exe`；
夹具进入时若不隔离宿主代理（环境变量 + Windows 系统代理），指向 `*.invalid` 的用例会打到
公司代理并可能拿到 200 错误页，装配结果随宿主环境变化。

本轮未进入 N3：drpy 只做独立归类（C0、`worker` 为空），真正的 drpy 运行时和 type `15/16`
仍缺上游契约与真实配置，没有实现也没有假装实现。

---

## 2026-08-09 重启后真实运行验证

本轮先停止旧 Electron/Python 进程，再以正常桌面权限启动应用；验证完成后已关闭临时调试端口，并恢复为随机后端令牌运行。后端健康检查返回 `status=ok`，加载 141 个站点、18 条 Kazumi 规则；恢复后的后端拒绝临时测试令牌并返回 401，确认未遗留测试鉴权状态。

> 安全说明：设置文件中的 `bangumiToken` 仅读取配置状态和长度，不在日志或文档中输出 token 内容。本轮实测长度为 40。

| 编号 | 运行操作 | 实际结果 |
|---|---|---|
| R1 | 调用 `/kazumi/action`：`kazumiBangumiMe`、`kazumiBangumiCollections(limit=100)` | HTTP 200、`code=200`；`valid=true`、用户信息存在；收藏返回 12 条，首条包含 `subject_id/type/subject` 等字段 |
| R2 | 调用 `kazumiCheckValidity`，仅检查 `7sefun,DM84,enlie`，关键词「喵喵」 | `7sefun=valid`（3 条）；`DM84=invalid`（522）；`enlie=invalid`（SSL EOF）。单规则失败仍被隔离，符合外部站点故障预期 |
| R4 | 通过运行中的 Electron IPC 对失效解析地址调用 `captureDirect` | 返回 `{ok:false, reason:"capture-failed"}`，耗时 128ms；未等待 20s 超时，说明 `did-fail-load` 快速跳过生效 |
| R5 | 连续 5 次调用独立失效解析地址 | 5/5 返回 `capture-failed`，单次 118–155ms；应用进程和后端健康检查保持正常，未观察到 `MaxListenersExceededWarning` |
| R6 | 调用 `kazumiBangumiSearch`（关键词「葬送的芙莉莲」，limit=3） | HTTP 200、`code=200`，返回 3 条结果；字段包含 `id/name/name_cn/images/rating` 等 |

R4/R5 本轮验证的是隐藏解析窗口及其失败路径；真实可播放地址仍受外部解析站可用性影响。`session-logs/.current` 仍指向旧日志文件，故本轮接口结果以实际 HTTP/IPC 返回值为准。

---

## 2026-08-09 代码修复摘要

| 编号 | 修复内容 | 涉及文件 |
|---|---|---|
| R1 | Bangumi 收藏接口改用 `/v0/me` 拿 username → `/v0/users/{username}/collections`（不再用 `-`） | `plugin_manager.py` |
| R2 | XPath 策略 `//` 归一化为节点相对 `.//`（对齐 Kazumi Dart）——修复 7sefun 及所有 `//` 规则；DM84/enlie 为外部站点故障 | `xpath_strategy.py` |
| R4 | 解析窗口监听 `did-fail-load` 快速跳过死解析站（不再烧满 20s） | `parse-window.js` |
| R5 | `webContents.setMaxListeners(0)` 抑制监听器累积告警 | `parse-window.js` |
| R6 | Bangumi 搜索改 `POST /v0/search/subjects`（对齐 Kazumi）+ 全端点补 UA 头 | `plugin_manager.py` |

> 另：2026-08-09 按用户要求把 Bangumi 域名从 `api.bangumi.lol`/`next.bangumi.lol` 改回官方 `api.bgm.tv`/`next.bgm.tv`。

---

## 问题清单

### R1 · Bangumi 收藏列表接口 404

- **发现时间**：2026-08-09 13:10:04（启动后约 37s，出现 2 次）
- **日志级别**：WARNING
- **日志原文**：
  ```
  [python] 2026-08-09 13:10:04,295 yuki.kazumi.manager WARNING [kazumi] bangumi collections failed: 404 Client Error: Not Found for url: https://api.bangumi.lol/v0/users/-/collections?subject_type=2&limit=100&offset=0
  [python] 2026-08-09 13:10:04,296 yuki.kazumi.manager WARNING [kazumi] bangumi collections failed: 404 Client Error: Not Found for url: https://api.bangumi.lol/v0/users/-/collections?subject_type=2&limit=100&offset=0
  ```
- **触发链路**：前端 → `/kazumi/action do=kazumiBangumiCollections` → `PluginManager.bangumi_user_collections()`（`python-backend/kazumi/plugin_manager.py:529`）→ `GET https://api.bangumi.lol/v0/users/-/collections`
- **证据**：`bangumi_user_collections()` 在无 token 时提前返回 `[]`（`plugin_manager.py:532-533`），出现 404 说明**已配置 bangumiToken**，即真实请求打到镜像返回 404。
- **影响**：设置页「Bangumi 同步」卡的「我的收藏」列表无法加载；详情弹窗收藏状态回填也会受影响。
- **疑似根因**：
  1. 镜像 `api.bangumi.lol` 未代理 `/v0/users/-/collections`（用户鉴权端点），返回 404（规范上无效 token 应为 401）。
  2. 或 token 无效/过期，镜像以 404 掩盖鉴权失败。
- **状态**：✅ 已验证（2026-08-09 重启后：token 已配置且长度为 40；`/v0/me` 返回有效用户；`kazumiBangumiCollections(limit=100)` HTTP 200、返回 12 条）。token 内容未写入日志或文档。

### R6 · Bangumi 番剧搜索 404（端点路径错误：应为 /v0/search/subjects）

- **发现时间**：2026-08-09 13:32:05（用户搜索「黑暗灯火」时）
- **日志级别**：WARNING
- **日志原文**：
  ```
  [python] 2026-08-09 13:32:05,747 yuki.kazumi.manager WARNING [kazumi] bangumi search failed: 404 Client Error: Not Found for url: https://next.bangumi.lol/p1/search/subjects?limit=5&offset=0&keyword=%E6%9A%97%E9%BB%91%E7%81%AF%E7%81%AB
  ```
- **触发链路**：Kazumi 源弹窗/Bangumi 搜索 → `PluginManager.bangumi_search()`（`plugin_manager.py:359`）→ `GET next.bangumi.lol/p1/search/subjects?limit=5&offset=0&keyword=...`
- **实测确认**（本机 curl）：
  | next.bangumi.lol 端点 | 结果 |
  |---|---|
  | `/p1/search/subjects` | **404 ❌（缺失）** |
  | `/p1/calendar` | 200 ✅ |
  | `/p1/subjects/1/comments` | 200 ✅ |
  | `/p1/trending/subjects`（无参/date） | 400 ⚠️ → **已修**（必须带 type/limit/offset，实测带参 200，`bangumi_trends` 已补参） |
- **影响**：详情页 Kazumi 源弹窗/以图搜番相关的 Bangumi 搜索（番剧元数据）拿不到结果，弹窗顶部封面/简介缺失。
- **疑似根因**：**代码端点路径错误**，非镜像问题——官方 `next.bgm.tv/p1/search/subjects` 同样返回 `Route not found`。Kazumi 原版正确端点（`api_endpoints.dart:58-59`）是 **`/v0/search/subjects?limit={0}&offset={1}`**（在 api.bgm.tv 上）。需改用 `/v0/search/subjects` 并补 `keyword` 参数。
- **状态**：✅ 已验证（2026-08-09 重启后：`kazumiBangumiSearch` 使用关键词「葬送的芙莉莲」、limit=3，HTTP 200、返回 3 条；另已通过 `/v0/me` 和收藏接口确认同一 Bangumi token 链路有效）。

### R2 · 内置默认规则搜索结果与外部站点状态

- **发现时间**：2026-08-09 13:10:34 ~ 13:11:44（用户 Kazumi 源搜索期间，连续两轮）
- **日志级别**：WARNING
- **现象**：3 条内置默认规则（7sefun/DM84/enlie，开箱即用规则）连续两轮搜索**全部失败**：
  ```
  [kazumi] search failed: 7sefun: 7sefun returned no search results
  [DM84] search request failed: 522 Server Error ... https://example.invalid/search
  [enlie] search request failed: HTTPSConnectionPool(host='enlienli.link', port=443): ... SSLEOFError ... EOF occurred in violation of protocol
  ```
- **影响**：默认装好的 3 条规则搜不到东西，「开箱即用」体验失效；但其他规则（AGE/baimao/fcdm/MXdm 等）搜索正常，非全局故障。
- **疑似根因**（待复测确认）：7sefun=XPath 无结果（规则失效或站改）；DM84=522（站点 CDN 故障）；enlie=SSL EOF（反爬/TLS 拦截）。
- **状态**：✅ 已验证（2026-08-09 重启后有效性检查：7sefun 返回 3 条并标记 `valid`；DM84 仍为 522、enlie 仍为 SSL EOF，均为外部站点故障）。XPath 修复及回归测试保持有效。

### R3 · 其余规则搜索失败（预期隔离，非应用缺陷）

- **现象**：单规则失败均被隔离（单条异常不影响整体搜索），未见崩溃或连锁问题，符合 §11.3 错误隔离设计：
  - 403 Forbidden：dalvdm / mwcy / TvTFun（疑似反爬/需 Cookie）
  - 522 Server Error：DM84（CDN 故障）
  - SSL EOF：enlie
  - Read timed out：xfdm（超时 10s 生效）
  - requires captcha：giriGiriLove / mgnacg / mutefun（验证码检测生效）
- **状态**：✅ 无需修复（符合设计，属外部站点状况）

### R4 · 播放解析长时间「加载中」（死解析站 20s×N 串行等待）★ 本次排查核心

- **发现时间**：2026-08-09 13:12 前后（用户点击播放后）
- **现象**：点击播放后界面持续「加载中」约 2 分钟才出结果（甚至更久），体验即「一直加载中」。
- **日志原文**（目标地址 `https://example.invalid/video-share 个解析站全部 `ERR_CONNECTION_CLOSED`）：
  ```
  (node:32208) electron: Failed to load URL: https://example.invalid/jx-proxy with error: ERR_CONNECTION_CLOSED
  (node:32208) electron: Failed to load URL: https://jx.example.invalid/player with error: ERR_CONNECTION_CLOSED
  (node:32208) electron: Failed to load URL: https://jx.example.invalid/player with error: ERR_CONNECTION_CLOSED
  (node:32208) electron: Failed to load URL: https://jx.example.invalid/player with error: ERR_CONNECTION_CLOSED
  (node:32208) electron: Failed to load URL: https://example.invalid/m3u8-jx with error: ERR_CONNECTION_CLOSED
  (node:32208) electron: Failed to load URL: https://jx.example.invalid/player with error: ERR_CONNECTION_CLOSED
  ```
- **触发链路**：CatVod parse=1 源 → 渲染层 `player.js` 走 `window.yuki.resolveParse(url)`（`preload.js:82`）→ `yuki:parse`（`index.js:750`，**无整体超时**）→ `ParseWindow.resolve()`（`parse-window.js:151`）串行遍历 JSON 解析（15s/个）→ iframe 解析（20s/个）。
- **代码根因**：
  1. `parse-window.js _capture()`（213-316 行）**未监听 `did-fail-load`**。解析窗口 `loadURL` 失败（ERR_CONNECTION_CLOSED）时，`did-finish-load` 不触发，只能干等 20s `IFRAME_TIMEOUT`（23 行）超时后才 `finish(null)` 跳到下一个解析站。
  2. `resolve()`（165-168 行）串行尝试全部 iframe 解析，死站越多累计越久：6 个 ≈ 120s+，加上可能先试的 JSON 解析，总等待超 2 分钟。
  3. `yuki:parse` 与渲染层 `resolveParse` 都无整体超时上限，期间前端 `showLoading()`（`player.js:233`）一直转圈，到 `hideLoading()`（244 行）才结束。
- **性质**：解析站本身已死（外部配置/网络问题），但**应用对"加载失败"不快速失败**是缺陷——死链应秒级跳过而非烧满超时。
- **建议修复**：
  1. `_capture` 增加 `win.webContents.on('did-fail-load', ...)`：仅当 `isMainFrame && errorCode !== -3(ABORTED)` 时 `finish(null)` 快速跳过（子框架/主动中断忽略，避免误伤 legacy 跟随加载）。
  2. 可选：`resolve()` 增加整体时间预算（如 60s）兜底。
- **状态**：✅ 已验证（2026-08-09 重启后通过 Electron IPC 对失效解析地址调用 `captureDirect`，128ms 返回 `capture-failed`；未等待 `IFRAME_TIMEOUT=20s`。`_capture()` 的 `did-fail-load` 快速失败路径已生效。）

### R5 · MaxListenersExceededWarning（did-stop-loading 监听器累积）

- **发现时间**：2026-08-09 13:12（与 R4 同时）
- **日志原文**：`(node:32208) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 did-stop-loading listeners added to [WebContents]. MaxListeners is 10.`（出现 4 次）
- **分析**：业务代码**没有任何 `did-stop-loading` 监听**（全项目仅 `parse-window.js:271` 一个 `did-finish-load`，且每窗口独立销毁）。判断为 Electron `webContents` 内部按 `loadURL` 累积的监听器，被隐藏解析窗口反复失败加载触发。
- **影响**：仅告警，不影响功能；不排除随长时间使用持续累积。
- **建议**：对解析窗口 `webContents.setMaxListeners(0)` 抑制；或确认 Electron 版本行为后忽略。
- **状态**：✅ 已验证（2026-08-09 重启后连续 5 次失效解析调用均在 118–155ms 返回，应用进程/后端仍健康，未观察到 `MaxListenersExceededWarning`；长期压力测试仍不在本轮范围内。）

### R7 · 观看统计断流重连重复累计（totalSeconds/sessionCount 双计）

- **发现时间**：2026-08-10（代码审查，PROGRESS.md §4.1 进行中项）
- **现象**：断流退出时 `_recordWatch` 按首次绝对 `pos` 已累计并删除旧会话；主进程重连后新会话结束再次 `_recordWatch`，按重连段的绝对 `pos` 再累计，导致 `totalSeconds` 两段相加（而非该集实际进度）、`sessionCount`/`titles` 同一次观看被计两次。
- **触发链路**：`player.js _recordWatch` → `_writeWatch`（两段各自绝对 `pos` 叠加）；主进程 `index.js` 断流重连经 `yuki:player-session` 同步新会话号，渲染层复用旧元信息。
- **修复**：观看统计改按「观看链」（chainId）去重——显式起播开新链，断流重连经 `player-session` 复用旧链元信息（`_adoptSession`），`_writeWatch` 按「链内最大进度 − 已计进度」只补增量；观看次数与部数每条链只计一次；最近观看进度取链内最新。
- **状态**：✅ 已验证（2026-08-10 独立实例 CDP 实测：重连后 `totalSeconds=60`（30+增量 30，非 90）、`sessionCount=1`、标题计数 1、链内最大进度 60；`scripts/acceptance-my-watch.js` 24/24 通过）。

### R8 · `ended` 缺会话号致新集误判「看完」

- **发现时间**：2026-08-10（代码审查，PROGRESS.md §4.1 进行中项）
- **现象**：`mpv-player.js` 的 `end-file eof` 发出的 `ended` 事件不带会话号，渲染层 `_endedAt` 为全局时间戳。旧集 ended 后新集起播，若新集 IPC 断开且 exit 无 `pos`，`_onExit` 会以旧集 ended 时间戳把新集误判为「看完」并错误自动连播。
- **修复**：`ended` 事件附带活动会话 `sessionId`；渲染层 `_onEnded` 按会话记录 `_endedSessions`，提取 `_isDone` 按会话匹配兜底判定；`play()` 起播重置 `_endedAt`/`_endedSessions`，旧会话延迟 ended 不污染全局兜底。
- **状态**：✅ 已验证（2026-08-10 独立实例 CDP 实测：当前会话 ended 判看完；旧会话延迟 ended 不误判新会话；新会话自身 ended 判看完；`scripts/acceptance-my-watch.js` 24/24 通过）。

### R9 · Bangumi 收藏写入 404（想看/在看/看过等按钮）

- **发现时间**：2026-08-10（用户报告，T74）
- **现象**：详情页/统一详情页点击「想看」等收藏按钮提示 404；GET 收藏列表/同步正常。探测确认官方 `api.bgm.tv` 与镜像 `api.bangumi.lol` 的写入路由均存在（无 token 时 401），404 仅来自用户名/写法组合不匹配——旧实现只用真实用户名 + PUT 单路径，个别镜像/网络组合返回 404（Kazumi 原版为 POST `/v0/users/-/collections/{id}`）。
- **修复**：`bangumi_update_collection`/`bangumi_delete_collection` 重写为全矩阵尝试 `{POST, PUT} × {`-` 通配当前用户, 真实用户名} × {官方, 镜像}`，首个 2xx 即成功；鉴权类 401/403 优先于 404 返回便于排查。
- **状态**：✅ 已修复（代码 + 后端测试通过；待用户 token 实测确认）。

### R10 · 以图搜番失效（trace.moe URL 直传 403）

- **发现时间**：2026-08-10（用户报告，T74）
- **现象**：以图搜番返回「未识别到番剧」或失败。探测确认：`POST https://example.invalid/trace-moe 返回 **403**（trace.moe 反爬/需它自行抓取，URL 直传被拦）；原始文件上传（`data=bytes` + `Content-Type: image/*` + 浏览器 UA）返回 200。
- **修复**：后端 URL 搜索改为先下载图片字节再原始上传；`Content-Type` 按文件头自动识别（Kazumi 硬编码 jpeg，PNG 上传会被拒）；补浏览器 UA；失败返回 `error` 字段，前端 toast 真实原因。
- **状态**：✅ 已验证（真实图片实测：200 + 10 条结果，相似度 0.988）。

### R15 · 多仓合并/主仓漂移后同名 key 的可用源被旧探测屏蔽误隐藏

- **发现时间**：2026-08-22（用户报告：重启后探测源，合并站点后列表里能用的源被屏蔽）
- **现象**：合并多仓站点配置后重启应用，后台源探测把实际可用的源从源下拉中隐藏（提示「已自动屏蔽 N 个无内容源」），且不会自动恢复——要等 7 天复查期或到「设置 → 源设置」手动恢复。
- **根因**：渲染层探测/屏蔽持久化状态（`probedSites`/`blockedSites`/`probedAt`/`probeFailStreak`/`blockedReason`）全部按裸 site key 复用，而不同仓常存在同名 key 指向不同 api/spider 的站点。换仓重置只认 `lastConfigUrl` 变化（home.js 换仓分支）；同一 depot URL 下合并结果漂移（主仓按偏好回退、清单增删子仓）时 key→内容映射改变但持久化状态不失效，新鲜 `probedAt` 又阻止重探——旧仓的「屏蔽」结论被无限期套在合并后同 key 的可用源上。反向同样成立：旧的「已探过 OK」结论会让漂移后的坏内容漏探。
- **修复**：探测结论附带内容指纹 `probeFp`（key → `api|spiderType`，后端 `/sites` 增量暴露 `api` 字段）。读取时指纹不符或缺失（旧版数据无法证明内容未变）即作废旧结论、当场恢复展示并重探一次；指纹一致的同仓重启照常复用零请求。升级后首轮全量重探一次即可自愈历史误屏蔽，之后稳定无额外开销。换仓整库重置逻辑保持不变，作为粗粒度兜底。
- **回归修正（2026-08-22 同日）**：首版修复的迁移性全量重探暴露出两个误杀放大器——① `probeFailStreak` 跨会话累积：上次冷启动慢留下的连败欠账让本次一轮失败就越过 `PROBE_FAIL_LIMIT` 按死源屏蔽；② `empty` 判定零阈值：单轮确认空即屏蔽，软限流/预热期的空响应会误杀有影片的源。修正为：连败计数只在当前会话内累加（`init` 时 `_resetSessionEvidence` 清空遗留欠账），死源/空源收敛由同会话补探第二轮保证；确认空与失败包络同阈值，连续两轮确认全空才按无内容屏蔽。
- **状态**：✅ 已验证（`tests/js/home-probe.test.js` 79 例全绿，含指纹迁移自愈/匹配复用/变更失效、`_validBlocked` 矩阵与会话证据重置用例；JS 单元 313/313、语法 41 文件 0 错、ESLint 0 error、Ruff PASS、`run_all.py` 全部阶段 PASS + 100 文件编译 0 error）。

