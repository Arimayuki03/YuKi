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
| R10 | 以图搜番 URL 直传被拦（trace.moe 需原始上传） | ✅ 已验证：原始文件上传 200 + 10 条结果 |
| R11 | S1 不可信运行时隔离、硬超时、聚合取消和熔断恢复 | ✅ 已验证：Python 24 阶段、Node 225/225、JS 语法 40/40、Ruff/ESLint 0 error |
| R12 | C2 配置三层分离、prepare→validate→atomic swap、`ext` 语义、能力路由与配置安全边界 | ✅ 已验证：`run_all.py` 28 阶段全通过、编译 79 文件 0 error；四个新阶段共 157 条全部走 loopback 夹具不出网 |
| R13 | `guard_url` 把 Windows 盘符当协议，`D:/tv.json` 报错原因与真实问题不符 | ✅ 已修复并验证：`test_config_security.py::test_blocked_local_disk_paths` |
| R14 | `detect_text` 只剥一层 BOM，双 BOM 配置被 `json.loads` 报成第 1 列语法错误 | ✅ 已修复并验证：`test_ext_semantics.py::test_bom_and_declared_and_fallback` |
| R15 | 多仓合并/主仓漂移后同名 key 的可用源被旧探测屏蔽记录误隐藏 | ✅ 已修复并验证：探测结论附带内容指纹 probeFp；home-probe 78 例、JS 单元 312/312、run_all.py 全阶段 PASS |
| R16 | `spider-loader.js` 协议桥命名与宿主断裂：243afd9 全局重命名 VPC→YuKi 时漏改 loader，宿主 `ctx.get('__YUKI_CALL__')` 取到 None，所有 JS 源方法调用报 `'NoneType' object is not callable` | ✅ 已修复并验证：loader 对齐 `__YUKI_CALL__/__YUKI_PENDING__/__YUKI_RESULT__/__YUKI_FETCH_RESULT__/__yuki_err__`；test_phase3 30/30 PASS（修复前必现 KeyError）、test_jar_proxy 4/4 OK、全量回归见 PROGRESS 同日记录 |
| R17 | WebDAV 恢复假成功：后端逐文件吞异常、HTTP 200 空数据恒当成功，用户看到「恢复成功」但数据没回来 | ✅ 已修复并验证：`webdav_restore` 返回 `{files, ok, error}`（连接错/非 404 HTTP 错/全 404 均判失败，单文件 404 跳过），端点失败回 500+msg；test_webdav_conn 新阶段接入 run_all.py |
| R18 | 历史页 Kazumi 封面拉取失败：搜索点击回填的 `{id, cover:''}` 毒条目被当完整命中永久短路且跨重启持久化 | ✅ 已修复并验证：完整命中要求 id+cover 齐全、残缺条目按 id 拉详情自愈、缓存读写双向过滤 id-only 条目；kazumi-bgmcache-heal 5 例 + test_kazumi_cover_proxy |
| R19 | 切换分类报 L3_RUNTIME_CALL_FAILED：旧加载令牌只丢弃渲染结果不中止请求，快速切分类时请求风暴打满站点 Worker 串行队列触发上游限流 | ✅ 已修复并验证：前端同代 AbortController 真正中止在途分类/搜索请求 + 失败包络 800ms 自动重试一次；后端 `CmsSpider._fetch` 连接类瞬时错误退避重试一次 |
| R20 | 外部主播放器选 PotPlayer 后三类内容全部无法播放：verbatim 手工引号的 `/referer="v"` 开关形态不被识别，且带空格安装路径的命令行首 token 被 CRT 式分词截断 | ✅ 已修复并验证：改为裸值开关交 libuv 自动引用；真实 PotPlayer 26.06.30 实测本地文件与 HTTP 流均正常播放、Referer/UA 完整到达 |

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

### R17 · WebDAV 恢复假成功（2026-08-23）

- **发现时间**：2026-08-23（打包版用户报告）
- **现象**：WebDAV 恢复提示成功，但收藏/设置等数据实际没有恢复。
- **根因**：后端逐文件 try/except 吞掉异常、HTTP 200 空数据恒当成功——任何一层失败都被包装成「恢复完成」。
- **修复**：`webdav_restore` 返回 `{files, ok, error}` 结构化结果——连接错误、非 404 HTTP 错误、全部文件 404 均判失败；单文件 404 视为远端无备份跳过；端点级失败回 500 + msg；前端空数据判失败并向用户透出真实原因。
- **状态**：✅ 已修复并验证（`test_webdav_conn.py` 新阶段 5 例接入 `run_all.py`；全量回归见 PROGRESS §7 同日记录）。

### R18 · 历史页 Kazumi 封面拉取失败（毒缓存短路）（2026-08-23）

- **发现时间**：2026-08-23（打包版用户报告）
- **现象**：历史页中 Kazumi 源条目封面永远拉不到，重启也不自愈。
- **根因**：搜索点击回填的 `{id, cover:''}` 残缺条目被 `getBangumiMatch` 当作完整命中永久短路且持久化跨重启——后续补拉逻辑看到「已有匹配」直接跳过，残缺条目永远无法自愈。
- **修复**：完整命中要求 id+cover 齐全；残缺条目按 id 拉 Bangumi 详情自愈补图；`_saveBgmMatchCache`/`_loadBgmMatchCache` 双向过滤 id-only 条目；点击路径改选首个带 images 的搜索结果。设置页 Bangumi 同步改走 `My.refreshBangumi()`（作废 localStorage 持久缓存 + 强制重拉），无 Token 不再写空列表毒缓存。
- **状态**：✅ 已修复并验证（kazumi-bgmcache-heal 5 例 + `test_kazumi_cover_proxy.py`；全量回归见 PROGRESS §7 同日记录）。

### R19 · 切换分类报 L3_RUNTIME_CALL_FAILED（请求风暴限流）（2026-08-23）

- **发现时间**：2026-08-23（打包版用户报告）
- **现象**：快速切换分类时报 L3 运行时错误，稍后才能恢复浏览。
- **根因**：前端 `_loadToken` 切换只丢弃过期渲染结果，不中止在途 HTTP 请求——快速切分类时旧请求继续打满站点 Worker 串行队列，触发上游限流，新请求反而排队超时。
- **修复**：双管齐下——前端同代 AbortController 真正中止在途分类/搜索请求，失败包络（CALL_FAILED/TIMEOUT/CIRCUIT_OPEN）800ms 后自动重试一次；后端 `CmsSpider._fetch` 对连接类瞬时错误退避 800ms 重试一次。
- **状态**：✅ 已修复并验证（全量回归见 PROGRESS §7 同日记录；打包实机 QA 待用户验证）。

### R20 · PotPlayer 作为主播放器三类内容全部无法播放（开关语法 + verbatim 分词）（2026-08-25）

- **发现时间**：2026-08-25（用户报告：选 PotPlayer 后本地文件、下载文件、在线视频均不能播）
- **现象**：PotPlayer 进程能拉起，但 URL 只被收进播放列表不加载（无反应）；带鉴权头的在线源完全卡死。应用日志侧对应时段出现 playlist-proxy `clientError` 记录。
- **触发链路**：`yuki:play` / `yuki:file-push` / `yuki:dl-play` → `launchExternalPlayer` → `buildExternalPlayerArgs('potplayer')`（verbatim 手工引号 `/referer="v"` `/user_agent="v"`）→ `spawn(..., { windowsVerbatimArguments: true })`
- **根因（两处叠加，均经真实 PotPlayer 26.06.30 实测确认）**：
  1. **开关语法错误**：verbatim 手工引号形态 `"/referer=\"...\""` 与 `"/referer=\"...\""`（值含内层引号）PotPlayer 一律无法识别为开关——URL 被收进播放列表后整个加载流程停摆。旧注释「必须 verbatim 手工引号」是对「整体包裹+内层转义」失败的错误归因推广。
  2. **命令行首 token 截断**：verbatim 下 libuv 不给 exe 路径加引号，`C:\Program Files\...` 在第一个空格处被 CRT 式分词截断成两个垃圾内容 token。此前 PotPlayer 靠扫描式解析容忍损坏前缀勉强能播本地文件，但叠加未知开关 token 后行为不可预期。
- **修复**：
  - `buildExternalPlayerArgs` potplayer 分支改为裸值开关（`/referer=值` `/user_agent=值`，值内引号/控制符仍剥除防注入），移除 `verbatim` 标记；
  - `launchExternalPlayer` 移除 `windowsVerbatimArguments` 分支，统一走 libuv 自动引用——exe 路径与含空格参数由 libuv 加外层引号，无内层转义序列。
- **验证证据（本机实测，Node spawn 与 Electron 31 libuv 行为一致）**：
  | 场景 | 命令行形态 | 结果 |
  |---|---|---|
  | 修复前：verbatim + 手工引号开关 | `exe "url" /referer="v" /user_agent="v"` | ❌ 零请求，播放列表挂条目不加载 |
  | 修复后：本地文件（空格路径） | `"exe" "C:/.../demo space.mp4"` | ✅ 标题变文件名，正常播放 |
  | 修复后：HTTP 流+完整头 | `"exe" url /referer=…a=b&c=d "/user_agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64)"` | ✅ 5 请求全部携带正确 Referer/UA |
- **状态**：✅ 已修复并验证（eslint 0 error；端到端复测见上表）。在线整季队列（pipe 管道模式）与单集直链共用此启动函数，一并生效。
- **追加（同日二段）**：用户复测发现 catvod m3u8 与 Kazumi 源（均走 `/pl/<token>/<n>` 播放列表代理）仍失败，PotPlayer 报错文本把 URL 与开关并排显示。原始 socket 抓包实锤：**PotPlayer 对无扩展名 URL 走「未知内容」路径，把命令行开关原样并入 HTTP 请求行**——`GET /pl/x/0 /user_agent=Mozilla/5.0 (...) HTTP/1.0`，Node 解析器报 `HPE_INVALID_CONSTANT: Expected HTTP/` 拒收（即本文件此前记录的 clientError 来源）。带扩展名 URL（.mp4 等）PotPlayer 能识别为媒体直链、正常解析开关，故此前实测未暴露。修复：新增 `isPlaylistProxyUrl()` 判定，管道代理地址交外部播放器时省略全部开关（管道模式数据面本就由代理带 `sess.headers` 注入上游，入站无需鉴权）；真实 CDN 直链仍保留开关。复测：无扩展名代理 URL 请求行干净、7 请求全部正常处理、PotPlayer 正常播放。
- **追加（同日三段）**：用户再测发现 catvod m3u8 单集直链（逐集回退路径，不经队列代理）仍失败——报错显示真实 CDN 地址与开关并排。追加差分矩阵实锤：**`.m3u8` 与 `.mp4` 直链带 `/user_agent=` 开关时请求行同样被污染**（此前 S2「成功」样本存在幸存者偏差：PotPlayer 行为受内部处理路径/时序影响非确定性），结论修正为 **PotPlayer 命令行开关整体不可靠，不可用于传递鉴权头**。最终修复：`PlaylistProxy.register()` 新增 `kind='static'` 静态直链会话（eps[].id 即真实直链、headers 由 ctx 注入、全量预填缓存免解析）；`yuki:play` 外部分支对「PotPlayer + 带鉴权头 + 真实直链」自动包一层单条目静态管道，PotPlayer 只见干净 URL。VLC/mpv 开关语法各自可靠，维持直传。验收（require 项目真实 PlaylistProxy 模块）：上游源站收到 7 请求全部携带正确 Referer+UA、0 失败；JS 单元 383/383 通过。
- **追加（同日四段）**：用户复测报「双窗口其一仅音频」。① 仅音频根因：PotPlayer 对无扩展名 URL 发 `Icy-MetaData` 请求按网络电台音频流解码（抓包证据见二段）——修复：代理地址携带内容一致的伪扩展名（static 会话从源直链提取真实扩展名，无法识别时默认 `.m3u8`；`TOKEN_RE`/`SEG_RE` 放宽匹配可选后缀）。② 双窗口根因：渲染层 play() 竞态双发（队列管道与逐集静态管道各 spawn 一个窗口；mpv 时代第二次启动会 `stop()` 收敛故从未暴露，外部播放器无 stop 句柄）——修复：主进程 `yuki:play` 外部分支加 5s 同播放意图去重（播放器 kind+site+title 指纹，命中直接返回 launched 不再 spawn）。验收：`.m3u8`/`.mp4` 后缀正确生成且路由正常、上游 7 请求鉴权全对、eslint 0 error、JS 单元 383/383。
- **追加（同日五段·外部启动层重写）**：用户复测报 Kazumi 先两窗后合并、catvod 两线路概率双窗口/播放失败/仅几分钟片段/不能拖动/时长随缓存增长/page 源无总时长。综合根因：**PotPlayer 对「单个裸 URL」入口的处理不可控**——无扩展名走 ICY/顺序流（不能 seek、时长=缓冲量）、竞态双发无收敛、HLS/mp4 认知靠猜。按用户要求重写外部启动层：① **统一本地 m3u8 播放列表文件入口**——多集写临时 `.m3u8`（EXTINF 集名，PotPlayer 原生列表接管连播），单条目直启 URL 不落盘；② **带鉴权头流量一律静态管道化**（`pipeWrapAuthUrl` 统一决策：管道地址原样 / 带头直链包 static 会话 / 无头直连 CDN；queue 懒解析会话条目统一补 `.m3u8` 后缀）；③ **同播放意图收敛升级为 kill+restart**——10s 内同 kind+site+title 二次启动先 `taskkill /T /F` 旧 pid 再起新窗（对齐 mpv 重启语义，任何时刻仅一个存活窗口）。验收：m3u 列表被 PotPlayer 接受且 EXTINF 集名进标题（「第01集 - PotPlayer」）、上游 6 请求鉴权全对 0 失败、Range 透传链路就绪；eslint 0 error、check-js 45 文件 0 错、JS 单元 383/383。
- **追加（同日六段）**：用户复测报 Kazumi 一直加载中、catvod 双窗口且无画面（日志伴随 clientError ECONNRESET 成串 + supervisor worker 池打满驱逐）。三处修复：① **列表文件扩展名 `.m3u8` → `.m3u`**——`.m3u8` 被 PotPlayer 按 HLS 变体清单语义并发探测列表内全部条目，触发代理懒解析风暴（worker 8/8 驱逐日志即此），响应超时黑屏；`.m3u` 为纯播放列表语义，播放器只按需顺序打开条目。② **收敛去掉时间窗**——外部播放器为单实例消费场景，切集/切线路间隔常超 10s 致旧窗残留；改为任何新启动先 kill 上一个 pid 再 spawn。③ **Kazumi 注册路径去抓流**——`_resolveKazumi` 拆两段：注册预热仅做轻量页面解析（kazumiResolve HTTP，实测 2ms~秒级）拿规则头与页信息缓存，隐藏窗口抓流（15s+）推迟到播放器实际请求该集时现场执行；抓流失败不再盲目重试（noRetry 标记，避免双倍超时）。验收：kazumi 注册零抓流且毫秒级返回、PotPlayer 经 `.m3u` 列表正常播放（标题「第01集」）、上游鉴权全对；eslint 0 error、check-js 0 错、JS 单元 383/383（含按新契约更新的 kazumi 预热用例）。
- **追加（同日七段）**：用户复测 Kazumi 已正常（冻结该链路）；page 线路 static 包装地址仍报错、偶发双窗口无画面；另提 m3u8 时长渐进/暂停停更诉求。三处修复：① **双窗口真竞态**——`pipeWrapAuthUrl` 的 register 是 await 点，渲染层双发在 await 间隙交错时入口处提前 kill 看不到对方新 pid，两边各自 spawn 即双窗；kill 移入 `launchExternalPlayerItems` 的 spawn 前一刻同步段（kill 与 spawn 之间无 await），无论并发怎么交错只留最后一窗。② **扩展名探测化**——page 源直链常无扩展名，原 `hintExt` 盲猜 `.m3u8` 会把 mp4 内容误导进 HLS 解析致黑屏；新增 `sniffMediaExt`（URL 已知扩展名直接用，否则 Range 探测 Content-Type 映射 .mp4/.mkv/.flv/.webm/.mov/.m3u8，失败回退 .m3u8），经 register 的 per-ep `hint` 字段传入。③ **HLS 清单定长回写**——`_pipeRemote` 与本地抓流清单分支显式 `Content-Length`（PotPlayer 对无长度界定的清单保守处理：时长渐进估算、暂停停更；顺带修复 writeHead 后 setHeader 抛 ERR_HTTP_HEADERS_SENT 致响应悬挂的回归）。验收：无扩展名 mp4 直链探测定 `.mp4`、代理 URL `/pl/<t>/0.mp4`、上游 Range 探测+拉流全对 0 失败；eslint 0 error、check-js 0 错、JS 单元 383/383。
- **追加（同日八段·实例模型实证与全路径收敛）**：用户复测 catvod 两线路仍概率双窗口+识别成音频。进程级实验澄清事实模型：① PotPlayer **允许多实例共存**（两次独立 spawn = 两个窗口，无单实例转发），kill-pid 收敛方向正确；② **单次 spawn 多个 content 参数 = 一个窗口 + 播放器自动建列表**（官方多 content 用法，实测三 URL 一窗且集中播首条）；③ `.m3u` 文件在隔离环境亦单窗正常，但真实环境仍有双窗报告 → 判定存在未收敛 spawn 路径（dl-play / file-push / external-player 弹窗按钮走旧 `launchExternalPlayer` 无收敛）。最终修复：① **弃用临时 m3u 文件，多条目改命令行多 content 参数直传**（消除文件扩展名的音频列表/HLS 清单语义歧义，播放器原生列表行为一致）；② **旧 `launchExternalPlayer` 同步接入 pid 收敛**，全部 spawn 路径共享同一收敛点。验收：模拟切线路两次启动仅剩一个存活窗口（新内容接管）；eslint 0 error、JS 单元 383/383。
- **追加（同日九段·时长对齐 mpv / kazumi 秒开 / 并发单飞）**：用户指出「mpv 能拿 catvod 完整时长而 PotPlayer 不行」并报 page 线路双窗无画面、kazumi 外部模式列表逐条加载极慢。三处修复：① **pipe 会话按需分流**——只有带会话头（防盗链）的条目才走 pipe 重写转发；会话头为空的条目 302 直连 CDN，与内置 mpv 完全一致（原始清单含 #EXT-X-ENDLIST 与真实分片地址，VOD 总时长即时准确、Range 由 CDN 原生支持）。此前无条件 pipe 的重写清单在 PotPlayer 上存在时长渐进估算/暂停停更表现。② **外部启动 single-flight**——static 包装含多个 await 点，竞态双发的两次 IPC 在 await 间隙交错时仅靠 kill 兜底仍有逃逸窗口；同播放意图（kind|site|title）的并发请求直接复用在途启动 promise，从源头串行化。③ **Kazumi 外部模式跳过整季队列**——每集必须隐藏窗口现场抓流（15s+/集），PotPlayer 打开列表即探测全部条目 = N×抓流串行等待（「列表一条一条加、加载非常长」）；跳过队列走逐集链路只解析当前集即出画面，代价是外部模式下 Kazumi 无原生列表连播。验收：无头源条目 302 直连（PotPlayer 拉到含 ENDLIST 原始清单并正常播分片）、有头源 pipe 转发（/seg 重写+鉴权注入）、eslint 0 error、JS 单元 383/383。
- **追加（同日十段·魔数嗅探 / UA 分流细化 / kazumi 并行预热 / 标题对齐）**：用户复测 page 源仍双窗+识别成音频、m3u8 时长仍渐进、要求恢复 kazumi 列表并对齐 mpv 标题格式。四项修复：① **扩展名魔数嗅探**——`sniffMediaExt` 改为 Range 取首块字节做容器魔数判定（ftyp→.mp4、#EXTM3U→.m3u8、FLV/MKV/Ogg/RIFF 等，对齐 media-probe.hasMediaMagic 判定面）：CDN 的 Content-Type 常为 octet-stream 且 page 直链常无扩展名，此前的 Content-Type/盲猜路径正是「识别成音频」根因；② **UA-only 头也 302 直连**——pipe 分流判定从「有任意头」收紧为「含 Referer/Cookie/Authorization」（多数 CDN 不校验 UA，为时长体验放弃透传；真防盗链源带 Referer 仍走 pipe）；③ **Kazumi 注册并行预热全部集目页信息（限流 2）**——PotPlayer 探测条目时命中 pageCache/合流 in-flight promise，消除串行 N×页面解析等待；渲染层恢复 Kazumi 走队列（列表回归）；抓流仍在拉取时现场执行。④ **标题对齐 mpv**——实测 `/title=` 开关有效，多参数启动追加 `/title=yuki · 片名`（裸值交 libuv 自动包裹；手工引号形态会让转义引号残留在标题里，实测）。验收：octet-stream 无扩展名直链魔数判 .mp4、UA-only 302/Referer pipe 分流正确且 ENDLIST 保留、PotPlayer 窗口标题「yuki · 测试片名」；eslint 0 error、check-js 0 错、JS 单元 383/383。
- **追加（同日十一段·列表集名内嵌 / title 假末集）**：用户复测报多集列表最后一集无法播放且名称是影片名、其余集名显示为序号。根因（用户贴的命令行直接实锤）：多 content 场景下尾部 `/title=` 开关被 PotPlayer 当作**最后一个内容条目**——文本当然不可播、列表名即该段影片文字；其余条目名取自 URL 文件名（裸序号 `0.m3u8`）。修复：① **集名内嵌代理 URL 路径段**——entries 变为 `/pl/<token>/<序号>/<清洗后集名>.<提示扩展名>`，PotPlayer 列表天然显示集名（实测窗口标题「第01集.m3u8」），不依赖任何开关；集名清洗剥除引号/斜杠/query 截断字符与控制符；`TOKEN_RE` 放宽匹配可选集名段与扩展名段。② **多条目启动不再追加 `/title=`**（假末集根源），单条目保留（实测单 content + 开关正常且无副作用）。③ clientError 日志聚合计数降噪（PotPlayer 对含中文集名条目先发未编码请求行触发 HPE_INVALID_URL、随后自行编码重试成功，属已知噪音）。验收：含中文/括号/空格集名的条目路由 302 正常、PotPlayer 列表按集名显示且无假末集、eslint 0 error、JS 单元 383/383。另：page 源 `L4_PARSE_UNAVAILABLE` 为源线路 parse=1 而配置未含解析接口（parses）所致，非代码回归——需在「设置 → 源设置」载入含 parses 的配置。
- **追加（同日十三段·彻底移除 /title= 开关）**：用户复测 page 源仍双窗+识别成音频，命令行显示单条目场景仍追加了 /title=（上轮仅对多条目禁用）。单 content + 开关组合在部分 PotPlayer 版本/状态下会开第二窗口尝试播放该文本（双窗+音频误判），与多条目的假末集同源。**彻底移除 /title= 追加逻辑**：集名内嵌 URL 后窗口/列表名天然为「集名.m3u8」（可读），开关已无存在价值且属纯风险面。验收：单条目含中文与「·」的 URL 单窗正常拉流；eslint 0 error、check-js 0 错、JS 单元 383/383。
- **追加（同日十二段·回滚 UA-only 302）**：用户复测报 Kazumi 列表正常但播放失败、page 源 mpv 正常而 PotPlayer 不行。根因为同日十段②的「UA-only 也 302 直连」优化过于激进：Kazumi 规则常只有 UA（恰为其防盗链头）、page 直链头部同态，302 后 PotPlayer 无法携带任何头 → 裸连 403；mpv 因全局 --http-header-fields 重定向后仍带头才正常。回滚该分支为「会话头非空即 pipe，仅完全无头 302」——播放可用性优先于时长体验（无头源仍享 302 直连的即时总时长）。另将集名清洗扩展到剥除全部空白字符（PotPlayer 发请求行不编码空格会致 HPE 拒收）。验收：UA-only 条目进 pipe 转发路径（502 上游不存在=已转发）、无头条目 302、含空格集名清洗后 URL 无空白；eslint/check-js/JS 单元 383/383 全绿。
- **追加（同日十七段·列表单条目定版）**：用户复测 catvod 两线路全变音频（串行化后）。机制定位：PotPlayer 打开多条目 m3u 会立即探测全部条目计算总时长，而 catvod 预取尚在途中（每集 playerContent 2-5s），探测批量等待超时主动断连（日志 ECONNRESET ×10）→ PotPlayer 判全部条目不可播 → 异常状态（音频窗）；叠加收敛 kill 旧窗后的新窗同样探测失败 → 「两窗皆音频」。结构性定版：**外部播放器的 m3u 列表只放当前起播的一集**——单条目探测仅 1 次且首集缓存已预热命中（实测响应 0-3ms）、秒开+时长即时+必然单窗；切集经 YuKi 界面重新起播（pid 收敛保证单窗替换），与内置 mpv 的逐集驱动语义对齐；代理会话仍保留整季条目与后台预取（加速后续切集响应）。验收：queue 会话 + 单条目 m3u 实测 PL 响应 0-3ms、clientError=0、单窗正常拉流；eslint/check-js/JS 单元 383/383 全绿。
- **追加（同日十八段·register 裸 return 致命 bug 修复）**：用户复测 catvod 两线路全变音频。排查中发现十六段引入的预取条件分支存在**裸 return 致命错误**：if (!strongAuth) return; 位于 register 函数中部，无头/UA-only 会话（catvod 绝大多数源）直接返回 undefined 而非落到尾部返回 { ok:true, token, entries... }——主进程与渲染层拿到 undefined 后整条队列链路失效，表现为音频窗/播放失败等全部异常（此前数轮的「时好时坏」很可能亦有此贡献）。修复：改为条件块包裹预取，register 必然落到尾部返回；顺带确认 test 文件首行 BOM 为无害显示问题。验收：playlist-proxy 单测 10/10、JS 全量 383/383、eslint/check-js 0 错。
- **追加（同日十六段·catvod 时长渐进根修）**：用户确认三源播放均恢复正常，剩 catvod 打开后剧集总时长随缓存缓慢增长。实测其直链子清单为标准 VOD（PLAYLIST-TYPE:VOD + ENDLIST + 367 分片），清单本身完备——根因是 PotPlayer 打开 m3u 列表会探测全部条目计算总时长，而 queue 会话懒解析下每次探测触发一次 playerContent（2-5s），总时长随探测进度缓慢增长（mpv 只显示当前集时长故从不暴露此问题）。修复：**catvod 注册后台异步预取全部集目直链**（限流 4、fire-and-forget 不阻塞注册；首集仍同步预热保起播速度），探测请求经 catvodInflight 合流同一 promise 零重复解析；预取失败静默（拉取时现场重试）。顺带修复 in-flight promise 被 catch 链改写为 undefined 导致合流异常的问题（存储原始 promise、静默消费链后挂）。验收：8 集注册 316ms 零阻塞、解析调用恰好 8 次（1 预热+7 预取）、全量复探零新增、JS 单元 383/383。
- **追加（同日十四段·m3u 文件入口重构定版）**：用户复测 page 源仍双窗音频无画面、m3u8 无总时长拉不了进度条，并指出 kazumi 全量预热对千级集数的灾难性影响。复盘定性：① **中文集名内嵌 URL 是双窗真凶**——PotPlayer 发请求行不编码非 ASCII 字符，HPE_INVALID_URL 拒收后播放器开新窗口换方式重试（一窗成功一窗卡死=「双窗其一识别成音频」），此前仅当日志噪音处理属误判；② kazumi 并行预热全部集目页信息在千级集数下注册耗时爆炸（渲染层竞速必然超时）。重构定版：① **外部启动统一 .m3u 文件单参数入口**（含单条目）——EXTINF 集名走 UTF-8 文件内容（不经过 HTTP，显示与请求合法彻底分离），条目 URL 回归纯 ASCII 序号+扩展名，TOKEN_RE 同步收窄；② **kazumi 预热回归起始集 only**，其余集目探测时按需解析（页信息+抓流合流 in-flight）。验收：三集含中文集名列表全 ASCII、PotPlayer 经 m3u 文件单窗播放且窗口标题为 EXTINF 集名、HPE 错误 0；eslint 0 error、JS 单元 383/383。
- **追加（同日十五段·外部启动串行化定版）**：用户复测 catvod 双窗+音频并附日志。日志链路还原：线路A 建队失败（VIP 拒）→ 回退逐集 static 包装 spawn；随后线路B 建队成功 → 队列 spawn——两次独立启动在各自 await（register/buildPlaylist）间隙交错，kill 收敛存在理论逃逸窗口。结构性修复：**外部启动串行链（extLaunchChain promise 队列）**——所有 launchExternalPlayerItems 调用严格依次执行，kill→spawn 位于串行头部且中间无 await，与任何并发交错都不可能产生第二个存活窗口（最后到达的启动胜出）；同时 spawn/kill 全量打点日志（m3u 文件名、条目数、首条 URL、pid）供后续观测。另以真实源形态（lzcdn31 master 清单 + 相对子清单 + 防盗链）做全链路实验：12 请求鉴权全对 0 拒绝、单窗播放、EXTINF 集名生效——pipe 链路对该源形态本身无缺陷，「音频窗」即双 spawn 中失败方的表现，随串行化一并消除。验收：eslint 0 error、JS 单元 383/383。

### R21 · VLC 作为主播放器时本地文件/下载文件只拉起窗口不播放（2026-08-26）

- **发现时间**：2026-08-26（用户报告：VLC 主播放器下「本地文件」页与「下载」页一键播放均只开空窗口）
- **现象**：选 VLC 为主播放器后，在线视频正常；本地文件管理页与下载完成一键播放只弹出 VLC 空主窗口，不加载任何媒体。
- **触发链路**：`yuki:file-push` / `yuki:dl-play` → `launchExternalPlayer(extPrimary, abs.replace(/\\/g,'/'))` → `buildExternalPlayerArgs('vlc')` → `spawn(execPath, [url, '--no-video-title-show'])`
- **根因（两处叠加）**：
  1. **正斜杠盘符路径的 MRL 歧义**：file-push/dl-pass 为规避 mpv 反斜杠转义问题统一传 `C:/path/to/file.mp4` 形态。PotPlayer/mpv 均可解析该形态，但 VLC 的 MRL 解析器会把 `C:` 当作未知 URI scheme（`c://host`），静默放弃加载 → 空窗口。此前 R20 实测表里 PotPlayer 对同形态正常，掩盖了 VLC 差异。
  2. **开关位于 URL 之后**：vlc 分支旧实现 `args=[url]` 再 push `--http-header-fields`/`--no-video-title-show`——选项缀在内容参数后，部分 VLC 版本把尾随 token 一并当内容条目处理，加重加载异常。
- **修复**：
  - 新增 `toExternalLocalUrl(abs, kind)`：VLC 走 `pathToFileURL` 生成 `file:///C:/...` 标准 URI（百分号编码空格/中文，彻底绕开 MRL scheme 歧义）；其余播放器维持正斜杠路径不变；
  - `yuki:file-push` 与 `yuki:dl-play` 外部分支均经该转换后起播（并补传 label，观看会话标题可记录文件名）；
  - `buildExternalPlayerArgs` vlc/mpv 分支统一改为**选项在前、URL 置末**（`args=[]` → push 开关 → 最后 `args.push(url)`），消除尾随 token 歧义。
- **状态**：✅ 已修复（回归测试见 `tests/js/external-player-spawn.test.js`：转换函数存在且 file-push/dl-play 两入口必经转换、URL 置于参数序列末尾）。内置 mpv 路径不受影响（仍用正斜杠形态）。

### R22 · VLC 播放在线视频失败——mpv 开关误用 + UA 封锁 + 302 丢头三因叠加（2026-08-26）

- **发现时间**：2026-08-26（用户报告；日志证据：`~/.yuki/logs/electron-main.log` 2026-08-25T15:46Z `spawn vlc pid目标 url=https://v.lzcdn31.com/...index.m3u8?sign=...` 与 08-26T00:53 本地 kazumi 队列 m3u spawn）
- **现象**：VLC 主播放器下在线视频全部失败（page/catvod 单集裸直链、kazumi 队列管道均未播成）；同一 URL 换 PotPlayer 可播、内置 mpv 可播。
- **根因（三处叠加）**：
  1. **vlc 分支误用 mpv 开关**：`buildExternalPlayerArgs('vlc')` 生成的 `--http-header-fields=...` 是 mpv/libav 语法，**VLC 根本不认识**——对未知开关 VLC 直接报 `unknown option or missing mandatory argument` 并拒绝加载（非静默忽略，VideoLAN 论坛实锤）。防盗链头从未真正生效过。VLC 真实开关为 `--http-user-agent=` 与 `--http-referrer=`（wiki.videolan.org Documentation:Modules/http；注意 referrer 双写 r）。
  2. **CDN WAF 封锁 VLC 默认 UA**：page 线路 header 置空后裸直链直接交给播放器，国内 CDN 按 UA 白名单放行——PotPlayer/mpv 默认 UA 恰好过关掩盖了缺陷，`VLC/3.x LibVLC` 是重点封锁对象 → 403。旁证：`sniffMediaExt` 以 `Mozilla/5.0` 探测同源即 200。
  3. **代理 302 直连丢头**：`_serveResolved` 对 static/catvod 的 Referer/UA-only 会话 302 直连（仅 Cookie/AuthZ 才 pipe），302 后播放器裸连上游、头留在代理侧——UA 校验 CDN 一律拒之。十二段已在 kazumi 上回滚过同一优化，static/catvod 存在同样问题。
- **修复**：
  - vlc 分支改用真实开关 `--http-user-agent=${ua}` / `--http-referrer=${referer}`；
  - `launchExternalPlayerItems` 对 VLC 统一前置 `--http-user-agent=Mozilla/5.0`（裸直链场景兜底；管道代理条目入站不校验 UA，开关无害）；
  - `_serveResolved` 分流条件统一为「会话头非空即 pipe」（kazumi/static/catvod 一致），时长体验由 catvod 预取 + 定长回写（七段③/九段①）兜底，不再依赖 302 直连。
- **验证**：JS 单元 400/400（含新增回归：vlc 分支禁用 `--http-header-fields` 且使用真实开关、items 路径 VLC 默认 UA 前置、static UA-only 管道会话转发上游带头非 302）；check-js 47 文件 0 错。kazumi 管道链路 PotPlayer 已验证可用（R20 六段），VLC 侧待用户实测复核。


### R23 · PotPlayer 播 m3u8 被识别成 MPEG TS——清单 Content-Type 缺失/generic 触发「未知内容」路径（2026-08-26）

- **发现时间**：2026-08-26（用户报告：PotPlayer 播放 page 线路 m3u8 源被识别成 MPEG TS）
- **触发链路**：`yuki:play`（page 单集，`isPageRoute` → header=null）→ `resolveExternalItems` → `pipeWrapAuthUrl` 无鉴权头原样返回 → `launchExternalPlayerItems` 单条目直启裸 CDN URL → PotPlayer 直连拉清单
- **根因（本机 PotPlayer 26.06.30 请求矩阵实测，本地同内容 HLS × 7 变体）**：

  | 变体 | URL 形态 | 响应头 | PotPlayer 行为 |
  |---|---|---|---|
  | A | `index.m3u8` | mpegurl+定长 | ✅ HLS 感知（取分片） |
  | B | `index.m3u8?sign=x` | mpegurl+定长 | ✅ HLS 感知 |
  | C | `index.m3u8?sign=x` | **video/mp2t** 谎报+定长 | ✅ HLS 感知（扩展名优先于 CT 谎报） |
  | D | `index.m3u8` | **octet-stream + chunked 无定长** | ❌ ICY 原始流探测 → MPEG TS 误判 |
  | E | master 变体清单 | mpegurl+定长 | ✅ HLS 感知 |
  | F | 本地 .m3u 文件间接入口 | — | ✅ HLS 感知 |
  | H | `file.m3u8?sign=x` | **完全无 Content-Type** | ❌ ICY/WINAMP 探测 → MPEG TS 误判 |

  结论：查询串不破坏扩展名识别、CT 谎报无碍；**唯一触发条件是清单响应缺 Content-Type 或为 application/octet-stream**——PotPlayer 据此把 URL 判入「未知内容」原始流路径（发 `Icy-MetaData:1`/WINAMP UA 探测），按 MPEG TS 解码（时长渐进、不可拖动）。国内 CDN 清单响应恰以 octet-stream/缺头常见（R20 七段已有记录）。f4393f0 把 page 源改为单集直连后该形态完全绕开代理的 mpegurl 回写，缺陷暴露。
- **修复**：
  - `playlist-proxy.js`：register 新增 `forcePipe` 会话标志；`_serveResolved` 分流条件放宽为 `needAuth || sess.forcePipe`（无头也强制管道）；`_pipeRemote` 对无会话头请求补默认浏览器 UA（Node http 不自动带 UA，部分 WAF 拒收无 UA 请求）；
  - `index.js`：`pipeWrapAuthUrl` 包装条件扩为「带鉴权头 **或** PotPlayer + 嗅探提示 .m3u8」，后者注册时携带 `forcePipe: true`；kind 经 `resolveExternalItems(items, kind)` 传入；`yuki:external-player` 单集入口同样经包装。VLC/mpv 内容嗅探不依赖 CT 头维持裸直链不变；mp4/flv 不包装维持旧行为。
- **验证**：JS 单元 406/406（新增回归：forcePipe 会话回写 mpegurl+定长+默认 UA 而非 302、无 forcePipe 维持 302、pipeWrapAuthUrl 门控与 forcePipe 携带、_serveResolved 条件、external-player 入口覆盖）；check-js 47 文件 0 错；eslint 0 error。端到端实测：真实 PlaylistProxy（forcePipe 无头 static）+ 真实 PotPlayer 26.06.30 + octet-stream 问题 CDN 模拟——PotPlayer 经代理取标准化清单后正常取分片（上游收到 UA=Mozilla/5.0 的清单与分片请求），误判消除。VLC/mpv 链路行为零变化。

### R24 · VLC 播 kazumi 队列弹「无法打开 MRL …/pl/&lt;token&gt;/%12、…/Z」——畸形路径静默 404 弹窗刷屏（2026-08-26）

- **发现时间**：2026-08-26（用户报告：VLC 主播放器播 kazumi 源报「您的输入无法被打开」，MRL 为 `http://127.0.0.1:14171/pl/<token>/%12` 与 `…/<token>/Z`）
- **现场证据**（electron-main.log 20:45:06 会话，token `mt94w0ta-s7s7rp15`）：
  - 磁盘 m3u 文件字节级干净（LF、无 BOM/NUL，8 条目全部 `/pl/<token>/N.m3u8` 规范形态）；
  - 代理侧第 1/2/3/4/7 集解析全部成功（~2.5s/集的跳扫节奏），**无任何解析失败记录**；
  - 垃圾路径命中 `_handleAsync` 的 TOKEN_RE 不匹配分支 → **静默 404 无日志**，VLC 每条弹一张模态报错框。
- **定位过程**（受控复现台：真实 PlaylistProxy + 模拟 kazumiResolve 后端 + 模拟上游 CDN + 真实 VLC，9 种清单形态矩阵）：
  - 合法媒体清单 → VLC 正常经 `/seg/` 取分片播放，链路本身无恙（R22 管道化对合法内容工作正常）；
  - gzip 未解压体 / HTML 错误页 / UTF-16 / BOM 等非清单元数据直通形态 → VLC 尾部 Range 探测后跳条目，**均不产生 `/pl/` 垃圾请求**；
  - Node WHATWG URL 对 `%zz` 等非法百分号序列并不抛错 → `_rewriteManifest` 的 `mapped || line` 兜底几乎不会保留远端清单行；
  - 结论：垃圾 MRL 只能由 VLC 把某份以 `/pl/<token>/N.m3u8` 为基址的响应内容按相对 URI 解析产生，触发源在真实源站（TikTok 系 CDN）的异常清单内容里，本地无法离线复现具体形态；
  - 全仓仅 register() 一处构造 `/pl/` URL，排除 YuKi 自身拼错地址。
- **修复**（症状层止血 + 可观测性，触发源待带日志复现实锤后另行根治）：
  - `playlist-proxy.js` `_handleAsync`：未匹配路径留痕日志（区分活令牌/无令牌）；**活跃令牌**下的越界下标与畸形路径改回最小合法空清单（`#EXTM3U\n#EXT-X-ENDLIST\n`，200 + mpegurl），VLC 静默跳过该条目而非弹窗刷屏——严格 TOKEN_RE 对畸形路径取不到会话，补宽松前缀 `/^\/pl\/([A-Za-z0-9_-]{8,64})\//` 二次提取令牌判存活；令牌不存在维持 404（静默跳过会掩盖过期/重启后的真实失效）；`/seg` 校验失败分支同样补日志；
  - 待办：~~用户下次复现时 electron-main.log 的 `[播放列表] 未匹配路径` 行可锁定确切触发时序~~ **已在 R27 破案**：畸形路径是「渐进式 MP4 冒充 .m3u8」被 VLC 按 m3u 拆解出的二进制碎片行相对解析所致，非源站清单内容异常；软响应继续作为兜底。
- **验证**：JS 单元 413/413（原「未知 token / 越界下标 → 404」改为「未知 token → 404；活令牌下越界/畸形路径 → 空清单软响应」，覆盖 `%12`/`Z` 实测形态）；eslint 0 error。

### R25 · VLC 播放列表面板：已播集名变乱码、当前集显示为片名——源流内嵌元数据被 VLC 改名（2026-08-26）

- **发现时间**：2026-08-26（R24 修复后用户复测：播放成功，但播放列表面板中已播条目变乱码、当前条目变成无集数的片名；重启 VLC/重播后恢复正常，再播再次出现）
- **定性**：**非 YuKi 数据缺陷，属 VLC 行为 × 源站流内嵌元数据的组合表现**
- **排除项**（受控复现台逐项实测，真实 VLC + HTTP 接口 `playlist.json` 码点级比对）：
  - m3u 文件的 EXTINF 集名写入 VLC 后逐码点正确（`第1集 测试` = U+7B2C,31,U+96C6,20,U+6D4B,U+8BD5）——加载环节零问题，BOM 有无均一致；
  - 上游媒体清单的 `#EXTINF:6.000,标题` 字段、响应头 `Icy-Name` / `Content-Disposition`、master 清单 `#EXT-X-STREAM-INF` 的 `NAME` 属性、段首裸 ID3v2 TIT2 帧——**均不会触发条目改名**；
  - 合法清单下播放列表面板保持 8 条目扁平结构，无子项展开。
- **结论**：改名发生在播放期——VLC 从每一路流的内嵌元数据实时更新条目名。该源直链为字节系（TikTok 级）CDN 的 HLS，其分片带业务用 timed-metadata；多数集的这类数据是垃圾字节（已播条目→乱码），个别可解析出标题（当前条目→片名、无集数）。重启后恢复是因为 m3u 重新加载了正确集名。具体载体（ID3-PES 变体/DVB 描述符等）未能离线合成复现，不影响定性。
- **处置**：
  - 不做代理侧剥离——管道模式下过滤流内嵌元数据需对 TS 分片做字节级手术，损坏风险远大于外观收益；
  - VLC 无公开开关禁用流元数据改写条目名（`--no-metadata-network-access` 仅限在线元数据查询）；
  - 对用户口径：纯外观问题、自愈性（重开即恢复）、mpv/PotPlayer 无此行为；介意者对该源换 mpv/PotPlayer 观看。
- **关联**：R24 的未匹配路径日志继续保留，用于后续该源其它异常的定位。

### R26 · kazumi 队列「解析成功后完全无反应」——直通模式上游断流不终止响应，播放器无限等待（2026-08-26）

- **发现时间**：2026-08-26（用户复测：播放列表面板正常显示，但起播毫无反应、不报错也不跳下一集）
- **现场证据**（electron-main.log 21:59 会话）：
  - `第 1 集解析成功` 后**再无任何请求日志**——VLC 未跳下一集、未报错、未取分片；
  - 54s 后仅一条 `clientError: ECONNRESET write`——连接一直挂着，最终被掐断时才暴露；
  - 用户在 12 分钟内重启应用 5 次：旧实例拉起的 VLC 是孤儿进程（detached 存活），其 m3u 指向已死实例的代理端口 → 连接拒绝 →「有播放列表但点了没反应」的表象之一。
- **根因**（代码审计 + 回归测试钉死）：`_passthrough` 用 `rs.stream.pipe(res)` 转发直通流——Node 的 `pipe()` 在**源 error/aborted 时不会 end 目标**。上游 CDN 断流（socket idle 超时销毁/服务器掐断）后：
  1. 播放器侧连接保持打开 → 把「断流」当「无限缓冲」永远等待（不报错、不超时、不前进）；
  2. 同族场景：清单收取循环只依赖 socket idle 超时，「每 <15s 滴一包却永不结束」的上游可无限躲过。
- **修复**（`playlist-proxy.js`）：
  - `_passthrough`：补 `aborted/error/close` 三事件 → `res.end()` 终止响应（对已完成响应二次 end 无害）；断流即明确收场，播放器立刻失败/跳下一集；
  - 清单收取加**总死线看门狗**（`MANIFEST_COLLECT_DEADLINE_MS`=30s，与活动无关，测试可经 `manifestCollectDeadlineMs` 注入短值）：触发即销毁上游流并回 **504**，不再服务截断清单；
  - 留痕日志：应答决策（pipe/302）、pipe 完成状态码、上游非 200 直通（st+ct）、上游取流失败原因、清单收取超时。
- **验证**：JS 单元 415/415（新增两回归：①直通上游中途 destroy → 响应必须在有限时间内 end；②注入 300ms 死线 → 慢滴清单回 504 且按时触发）；eslint 0 error。
- **用户侧注意**：外部播放器是 detached 进程，**重启 YuKi 不会回收旧 VLC 窗口**——排查前先关掉全部 VLC 再从 YuKi 重播，避免对着指向已死端口的孤儿窗口误判。

### R27 · 「单字母+地球图标」垃圾条目与 R24 悬案真因——kazumi/catvod 条目硬编码 .m3u8 标签，渐进式 MP4 被 VLC 按 m3u 拆解（2026-08-26）

- **发现时间**：2026-08-26（R26 修复后用户实测：VLC 播放列表面板出现大量「地球图标 + 随机单英文」条目）
- **破案日志**（22:16 会话，新增应答阶段留痕直接命中）：
  - `第 1 集解析成功 → https://v16.xzcs3zlph.com/.../video/tos/al…` + `上游非200直通 st=206 ct=video/mp4`——**该 kazumi 源抓到的真实流是渐进式 MP4，不是 HLS**；
  - 随后同一集连续多次 206 应答、一次 st=416（越界 Range）、ECONNRESET——VLC 在逐个尝试垃圾子条目。
- **根因链**：`register()` 对 kazumi/catvod 条目统一硬编码 `.m3u8` 标签 → VLC 按 URL 扩展名把 `/pl/<token>/N.m3u8` 交给 m3u 解析器 → MP4 二进制按 0x0A 断行拆成海量「行」→ 每行成为子条目（单字母/乱码 + 地球图标=相对解析回代理的网络项）→ 并诱发 `…/%12`、`…/Z` 畸形请求。**R24 的悬案（畸形路径来源）就此闭环：不是源站清单内容异常，而是「MP4 冒充 m3u8」的二进制碎片**。
- **修复**（`playlist-proxy.js`）：
  - 新增 `sniffExtFromHead(buf, ct)`：ftyp→.mp4、FLV→.flv、188 同步字节×3→.ts、EBML→.mkv，兜底按响应头 video/* 映射；识别失败返回 ''；
  - `_pipeRemote`：`.m3u8` 标签请求（含 206）一律进收取循环窥探判型——`#EXTM3U` 魔串照旧重写回写；非 HLS 且嗅探成功 → 销毁上游流并 **302 到同会话同集的正确扩展名地址**（demux 与内容对齐，垃圾条目无从产生）；嗅探失败维持原直通行为不冒险；
  - 非 `.m3u8` 标签请求行为完全不变；改标签扩展名永不为 .m3u8 → 无回环。
- **验证**：JS 单元 417/417（新增两回归：①ftyp+video/mp4 经 .m3u8 入口 → 302 至 /0.mp4 且纠偏地址正常直通；②TS 魔串 → 302 .ts、未知格式维持直通；R26 直通断流用例改用不可嗅探格式以继续覆盖终止语义）；eslint 0 error。
- **关联**：R24 畸形路径软响应继续保留（对历史遗留列表/其它未知形态兜底）；R26 断流终止语义不受影响。
