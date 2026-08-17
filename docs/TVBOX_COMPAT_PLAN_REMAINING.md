# TVBOX_COMPAT_PLAN 剩余工作与执行计划

- **写入日期**: 2026-08-17
- **状态**: 已批准待执行（Phase A–F 按序实施）
- **配套**: `TVBOX_COMPAT_PLAN.md`（原计划）。旧版进度总结已并入本文件，后续只保留这一份执行记录。

## 背景：为什么说"五个任务已完成"不准确

旧版“5 个任务已完成”的说法不准确。复核代码、产物与测试报告后，该结论不成立——多数任务只完成了代码主体，验收项未达成：

| 任务 | 状态 | 已落地 | 剩余工作 |
|---|---|---|---|
| 一 兼容套件 | 🟡 部分完成 | 测试器 `tests/test_config_compat.py`、21 仓语料 `tests/compat_repos.json`（`1f3d34b`） | 从未跑通：`compat_report.txt` 拉取 8/21、解析 3/21、平均建站率 9%，"PASS — 无基线"只是无基线可比较；缺 HTTP 生产路径、重试去抖、离线判定、`compat_baseline.json`、`compat_report.json`、skipped 原因分布、敏感性验证、CI `workflow_dispatch` 声明 |
| 二 端口泛化 | 🟡 代码完成、验收未完成 | `go_proxy.ensure_listener`、`jar_bridge._scan_jar_ports`、`jar_spider._ensure_local_proxy_ports`（`7cbdb8b`） | 无验收测试：假 jar 7777 行为级、保护端口、上限 16、真实 jar 扫描吻合 |
| 三 夸克降级 | 🟡 部分实现 | `pan_fast_path` 开关与 jar 优先+兜底（`16cd025`） | 无用户开关入口（env 未接线）、无行为级测试；默认开启时仍前置短路，"移除前置短路"描述不实 |
| 四 FongMi 契约审计 | ❌ 未开始 | 无 | `docs/TVBOX_CONTRACT_GAPS.md` 未落盘；type 15/16、parses 路由、playUrl、drives/hotList 等 8 项待审计（`TV-fongmi/` 源码可对照） |
| 五 分层诊断 | 🟡 部分完成 | `build_errors` 聚合（config.py）+ `test_layered_diagnostics.py`（`bec8c89`） | 缺 L1 fetch/parse 结构化、L4 parses 打点、QuickJS 缺全局警告、前端导入摘要展示 build_errors、套件报告复用分层标签 |

---

## Phase A：任务一 兼容套件落地

文件：`python-backend/tests/test_config_compat.py`、`.github/workflows/ci.yml`

1. **HTTP 生产路径驱动**：`run_one` 的 S1/S2 改为进程内起 uvicorn（复用 `tests/smoke.py:68-79` 的 in-thread 启动模式，`server.create_app()`），经真实 HTTP 端点驱动：
   - S1 `POST /action do=fetchText` → 非空文本
   - S2 `POST /action do=loadConfig` → 轮询 `do=configTask`（≤60s）→ `task.status==done && summary.sites>0`
   - S4 `do=homeContent`（抽样）
   - 保留现有文件重定向防 PIPE 死锁。
2. **重试去抖**：S1/S2 失败时重试一次，两次取较好值。
3. **离线判定**：首个仓库 S1 失败且 30s 内全部 S1 失败 → 判定离线，exit 0 并标注 SKIP。
4. **报告结构化**：产出 `compat_report.json`（repos + aggregate + skipped 原因分布，按 `[Lx:xx]` 前缀聚合）；`compat_report.txt` 保留人类可读表格。
5. **基线**：`--update-baseline` 生成 `compat_baseline.json`；核对 `compare_baseline` 的 S1/S2 硬失败逻辑。
6. **CI**：`ci.yml` 顶层 `on:` 增加 `workflow_dispatch:`（现 compat job 引用了该事件但顶层未声明）。
7. **执行**：先跑 3-4 个代表性仓库验证改造；随后全量跑（21 仓，视网络可能 30-60 分钟）并 `--update-baseline` 落基线。若本机网络对部分仓确实不可达，基线如实记录，不伪造通过。

## Phase B：任务二 端口泛化验收测试

新文件：`python-backend/tests/test_port_generalization.py`

复用 `ensure_listener`（`go_proxy.py:894`）与 `_scan_jar_ports`（`jar_bridge.py:83`）：

1. **行为级 7777**：`ensure_listener(7777)` → 端口有监听；HTTP GET 可达。
2. **保护端口**：`PORT`(9978)、`EXTRA_PORTS`(7944/1314)、`hoststate.get_port()` 注入的后端端口 → 均返回 False。
3. **范围校验**：80、99999、非数字 → False。
4. **上限**：塞满 `EXTRA_LISTENER_CAP` → 第 17 个返回 False（构造后清理）。
5. **`_scan_jar_ports`**：对 `vendor/` 下任一真实 jar 扫描，断言覆盖已知 7944/9978/1314；本机无 jar 时用内联假字节 `b'127.0.0.1:7777'` 断言命中。
6. 测试结尾清理 `_extra_servers`。

## Phase C：任务三 夸克降级接线 + 验收测试

文件：`python-backend/hoststate.py`、`python-backend/server.py`、新 `python-backend/tests/test_quark_pan.py`

1. **开关入口**：`server.py` 启动段读取 `VPC_PAN_FAST_PATH` 环境变量（`"0"`/`"false"` 关）写入 `hoststate.configure(pan_fast_path=...)`，保留默认 `True`。
2. **验收测试**（不依赖 JVM，直接测 `JarSpider.playerContentRaw`）：
   - jar 返回正常结果 → 保留 jar 结果，不覆盖
   - jar 退化（`{'url':id}` / 空）→ 兜底产出 go-proxy `do=pan` URL
   - `pan_fast_path=False` 全走 jar（断言 `_call` 被调用）
   - `pan_fast_path=True` 短路生效（断言 `_call` 不被调用）
   - 使用真实 `_quark_folder_id` 宽松解析
3. 测试恢复默认值。

## Phase D：任务四 FongMi 契约审计

新文件：`docs/TVBOX_CONTRACT_GAPS.md`

已确认 `TV-fongmi/`（catvod/forcetech/tvbus/zlive/jianpian/quickjs/thunder 等）与 `../Kazumi-main/` 可作对照源码。按原计划矩阵产出差距清单，每项含 FongMi 源码路径/符号 + 本项目对应文件 + 明确差距 + 影响×成本排序。审计项：

1. 站点类型矩阵：type 0/1/3/4/csp_ vs type 15/16、`type:0+api 为 .js`
2. per-site `jar`/`spider` 覆盖优先级
3. ext 解析：相对路径已支持；ext 为 http URL 是否拉取展开
4. parses 路由：type 0/1/3、`jx`、webview 嗅探覆盖度（`parse-window.js`）
5. playerContent 语义：`url/parse/headers/playUrl`、flag/vipFlags、header 透传 mpv
6. lives/liveContent 契约完整度
7. JS 宿主环境：cheerio/CryptoJS/dayjs 已注入 vs drpy 系（`pdfa/pdfh/pdft`）、HikerWeb 缺失时报错可见性
8. 快捷字段：wallpaper（已有）/drives/heat/hotList

清单按"影响面×实现成本"排序；文档落盘为本轮产出，高影响低成本项转下阶段任务。

## Phase E：任务五 分层诊断补齐

文件：`python-backend/config.py`、`server.py`、`js-engine/quickjs_host.py`、`src/renderer/js/panels.js`

1. **L1 结构化**：`parse_config_json`/`_fetch_config` 抛错统一带 `[L1:fetch]`/`[L1:parse]` 前缀；summary 增加 `parse_errors` 计数。
2. **L4 打点**：`playerContent` 分支，结果 `parse==1` 且 `config_mgr.parses` 空/无匹配时，仿 `_attach_jar_error` 追加 `error: "当前配置未含匹配该线路的解析接口（parse=1）"`（渲染层 `player.js:407` 已有 `data.error` 提示逻辑）。
3. **QuickJS 缺全局可见化**：eval 异常处检测 `is not defined`/`ReferenceError`，提取缺失标识符并 `logger.warning('该 JS 源需要宿主未提供的全局 <%s>')`。
4. **前端导入摘要**：`panels.js applyConfigResult` 追加 build_errors 分层数字（`type_unsupported/jar_failed/js_failed/py_failed`）。
5. **套件复用分层标签**：Phase A 的 skipped 分布按 `[Lx:xx]` 前缀聚合。
6. **测试**：扩充 `test_layered_diagnostics.py`（L1 前缀、`parse_errors`、L4 打点、QuickJS 缺全局警告）。

## Phase F：文档与总验收

1. 本文件即如实进度报告，后续只在这里维护剩余执行项。
2. `TVBOX_COMPAT_PLAN.md` 各任务/附录 B 勾选已达成项。
3. 最终回归：`npm run test:all` + `npm run test:compat` 全绿（或如实报告网络受限的仓）。
4. 提交：按功能分 3-4 个提交（套件/验收测试、契约审计、诊断补齐）。

## 关键文件

- `python-backend/tests/test_config_compat.py`、`test_port_generalization.py`（新）、`test_quark_pan.py`（新）、`test_layered_diagnostics.py`（扩充）
- `python-backend/config.py`、`server.py`、`js-engine/quickjs_host.py`、`hoststate.py`
- `src/renderer/js/panels.js`
- `docs/TVBOX_CONTRACT_GAPS.md`（新）
- `TVBOX_COMPAT_PLAN.md`、`TVBOX_COMPAT_PLAN_REMAINING.md`
- `.github/workflows/ci.yml`

## 验证

- 静态：`node --check`（panels.js）、`py_compile`（改动的 py）、`npm run lint` / `lint:py`
- 单测：`npm run test:jsunit` + `python-backend/.venv/Scripts/python -m unittest tests.test_port_generalization tests.test_quark_pan tests.test_layered_diagnostics`
- 兼容套件：先跑 3-4 仓验证改造，再全量 + `--update-baseline`；`test:all` 全绿
- 行为级：7777 监听/保护/上限；夸克 jar 优先与兜底；L4 打点含 error；QuickJS 缺全局警告日志
- 文档：`docs/TVBOX_CONTRACT_GAPS.md` 落盘且每项有 FongMi 源码引用
