# 影视仓兼容性收敛计划（TVBox Compat Plan）

- **生成日期**: 2026-08-17
- **目标**: 让宿主回到 TVBox 的「纯契约运行时」定位——**规则随配置走，宿主零特判**。导入任意影视仓库时，坏了能快速定位到层（配置解析/建站/爬虫/播放链路/本地代理），修复打在契约层并进入回归保护，不再按仓库打地鼠。
- **背景**: CODE_REVIEW 64 项已收口、IMPROVEMENT_PLAN A-C 批已完成，本计划是下一阶段的专项收敛。诊断与原理见本文「附录A：为什么换了仓库就不适用」。

---

## 目录

- [总体架构原则](#总体架构原则)
- [任务一：自动化兼容性套件（止血，最先做）](#任务一自动化兼容性套件止血最先做)
- [任务二：本地代理端口泛化（消灭一类失效）](#任务二本地代理端口泛化消灭一类失效)
- [任务三：夸克特判降级为协议层兜底](#任务三夸克特判降级为协议层兜底)
- [任务四：FongMi 契约对齐审计](#任务四fongmi-契约对齐审计)
- [任务五：分层诊断增强](#任务五分层诊断增强)
- [执行顺序与依赖](#执行顺序与依赖)
- [附录A：诊断——为什么换了仓库就不适用](#附录a诊断为什么换了仓库就不适用)
- [附录B：验收清单](#附录b验收清单)

---

## 总体架构原则

所有修复必须归入以下四层之一，**禁止新增宿主侧按仓库/按 jar 版本的特判**：

```
L1 配置层   解析任意形态的配置（注释/gzip/图片伪装/多仓/相对路径/编码）
L2 建站层   按 TVBox 类型矩阵构建站点（type 0/1/3/4、csp_、per-site jar 覆盖）
L3 爬虫层   提供完整运行时（JVM 桥 / QuickJS 宿主环境 / Py 动态加载）
            + 六方法契约（home/category/detail/search/player/action）
L4 播放层   playerContent 语义（url/parse/headers）+ parses 路由 + 本地代理转发
```

判断一个修复是否打对位置的准绳：**「换一个同类型但不同作者的仓库，这个修复还有效吗？」**——有效=契约层修复；无效=特判，需重新设计成通用机制。

---

## 当前真实状态（2026-08-17 复核）

> 本文件曾标记"五任务全部完成"，**复核后不准确**。当前执行入口见 [TVBOX_COMPAT_PLAN_REMAINING.md](TVBOX_COMPAT_PLAN_REMAINING.md)。
> 多数任务只完成了代码主体，验收项未达成。剩余工作与已批准的执行计划见 **`TVBOX_COMPAT_PLAN_REMAINING.md`**。

| 任务 | 状态 | 已落地 | 剩余工作 |
|---|---|---|---|
| 一 兼容套件 | 🟡 部分完成 | 测试器 `test_config_compat.py`、21 仓语料 `compat_repos.json`（`1f3d34b`） | 从未跑通（拉取 8/21、解析 3/21、无基线）；缺 HTTP 生产路径、重试去抖、离线判定、`compat_baseline.json`、`compat_report.json`、skipped 分布、敏感性验证、CI workflow_dispatch 声明 |
| 二 端口泛化 | 🟡 代码完成、验收未完成 | `ensure_listener`/`_scan_jar_ports`/`_ensure_local_proxy_ports`（`7cbdb8b`） | 无验收测试：7777 行为级、保护端口、上限 16、真实 jar 扫描 |
| 三 夸克降级 | 🟡 部分实现 | `pan_fast_path` + jar 优先/兜底（`16cd025`） | 无用户开关入口、无行为级测试；默认开仍前置短路 |
| 四 FongMi 契约审计 | ❌ 未开始 | 无 | `docs/TVBOX_CONTRACT_GAPS.md` 未落盘；8 项待审计 |
| 五 分层诊断 | 🟡 部分完成 | `build_errors` 聚合 + 单测（`bec8c89`） | 缺 L1 结构化、L4 打点、QuickJS 缺全局警告、前端展示、套件复用标签 |

---

## 任务一：自动化兼容性套件（止血，最先做）

**状态**: 🟡 部分完成（提交 `1f3d34b`；验收未达成，见上方状态表）

**现状**: `test-repos.md` 记录了 21 个仓库的手工测试（全部「能导入」），但每次后端改动后的真实兼容性仍靠人工重测。21 个仓库的经验没有变成可回归的资产。

**产出物**:
1. `python-backend/tests/compat_repos.json` —— 仓库语料清单
2. `python-backend/tests/test_config_compat.py` —— 兼容性测试器（独立运行，依赖网络，**不进 run_all 默认链**）
3. `npm run test:compat` 入口
4. 基线报告 `python-backend/tests/compat_baseline.json`（首次运行的快照）

### 1.1 语料清单设计

```json
{
  "repos": [
    { "name": "饭太硬", "url": "http://www.饭太硬.net/tv", "tags": ["idn", "jpeg-disguise"] },
    { "name": "哈基米", "url": "https://17264.kstore.space/哈基米.png", "tags": ["png-disguise", "pan-quark"] },
    { "name": "游魂多仓", "url": "https://www.iyouhun.com/tv/dc", "tags": ["multi-repo"] },
    { "name": "老刘备多仓", "url": "https://raw.liucn.cc/box/m.json", "tags": ["multi-repo", "comments"] }
  ]
}
```

- 首批 21 条从 `test-repos.md` 全量录入（含 tags 标注特征：中文域名/图片伪装/gzip/多仓/CDN/网盘源）。
- **扩容规则**: 以后每遇到一个「用户报告播不了」的仓库，修完后必须录入清单（修复进套件 = 回归保护，这是本计划的核心反馈回路）。

### 1.2 测试器设计（test_config_compat.py）

**运行方式**: 独立 spawn 一个后端实例（复用 smoke.py 的进程内 uvicorn 模式，随机端口 + token），经真实 HTTP 端点驱动——覆盖的就是生产路径，且不污染全局 `server.sites` 状态之外的东西（每次 loadConfig 整体替换）。

**每个仓库的探测阶段**（全部带超时，单仓总预算 90s）:

| 阶段 | 做法 | 判定 |
|---|---|---|
| S1 拉取 | `do=fetchText`（走 `config.fetch_text`，含伪装/gzip/IDN 处理） | 返回非空文本 = OK |
| S2 解析 | `do=loadConfig` → 轮询 `do=configTask`（≤60s） | `task.done && sites>0` = OK；记录 skipped 原因 |
| S3 建站率 | 从 configTask 摘要取 `sites` / `skipped` | 建站率 = sites/(sites+skipped) |
| S4 首页冒烟 | 逐站点 `do=homeContent`（每站 15s 超时，最多探 15 站，站点多时抽样） | 任一站返回含 list/class = OK；记录成功率 |

**输出**: 控制台表格 + `compat_report.json`：

```
仓库          S1拉取  S2解析  建站率   首页冒烟   备注
饭太硬        OK      OK      96%     12/15     3站jar加载失败(记skipped原因)
哈基米        OK      OK      100%    15/15
—— 汇总: 21/21 拉取 · 21/21 解析 · 平均建站率 94% · 首页成功率 87%
```

**通过标准（对基线的回归检测）**:
- S1/S2 成功率不得低于基线（应恒为 100%，掉了=配置层回归，**硬失败**）；
- 建站率、首页成功率低于基线 5 个百分点以上 = 失败（**允许网络抖动 ±5%**：同一仓库连续跑两次取较好值，减少 CDN 抖动误报）；
- 与基线的差异明细打印（哪些仓库退化、skipped 原因分布）。

**基线更新**: 明确改善后 `--update-baseline` 重拍快照入库。

**离线模式**: 首个仓库拉取失败且 30s 内全部 S1 失败 → 判定离线，exit 0 并标注 SKIP（CI 可选开启）。

### 1.3 npm 接线

```json
"test:compat": "python-backend\\.venv\\Scripts\\python.exe python-backend\\tests\\test_config_compat.py"
```

`test:all` **不**包含 test:compat（依赖外网 + 慢）；CI 中加一个手动触发（workflow_dispatch）的 job。

**验收**:
- [ ] 21 仓全量跑通，产出基线（当前真实兼容水位有了数字）
- [ ] 人为注释掉 `_strip_json_comment_lines` 的兜底调用 → 套件能红（验证敏感性）
- [ ] 报告含 skipped 原因分布（后续任务四的输入）

---

## 任务二：本地代理端口泛化（消灭一类失效）

**现状**: `go_proxy.py:86-94` 按 jar 家族穷举硬编码端口（9978/7944/1314）。下一个仓库的 jar 硬编码别的端口 → 播放 URL 指向无人监听的端口 → 播放失败，又要打一轮地鼠。

**设计**: 两个互补机制，把「穷举」变成「按需覆盖」。

### 2.1 机制A：播放 URL 拦截（主机制）

所有 jar 站点的播放地址都流经 `jar_spider.py:104 playerContent` 的返回值——在这里拦截：

```python
# jar_spider.playerContent 返回前：
result = _ensure_local_proxy_ports(result)
```

```python
def _ensure_local_proxy_ports(result):
    """URL 指向本机未监听端口时，动态起同协议监听（端口泛化）。

    jar 家族把 127.0.0.1:<port> 硬编码进字节码，无法穷举；这里在
    播放 URL 流经点按需补监听，go_proxy._Handler 协议通用。
    """
    import re as _re
    from go_proxy import ensure_listener
    url = (result or {}).get('url')
    if isinstance(url, str):
        m = _re.match(r'^https?://127\.0\.0\.1:(\d+)(/|$)', url)
        if m:
            ensure_listener(int(m.group(1)))
    return result
```

### 2.2 机制B：jar 加载期静态扫描（预启动）

`jar_bridge.apply_jar_patches`（每次 jar 落盘/复用必经）返回前扫一遍 jar 原始字节：

```python
def _scan_jar_ports(jar_path):
    """扫 jar 字节里的 127.0.0.1:<port> 字面量（DEX string 表 / class 常量池
    均为明文），返回端口集合。命中的端口提前起监听，避免播放时首连失败。"""
    ports = set()
    try:
        with open(jar_path, 'rb') as f:
            data = f.read(8 << 20)   # 只扫前 8MB，jar 通常 <5MB
        for m in re.finditer(rb'127\.0\.0\.1:(\d{4,5})', data):
            p = int(m.group(1))
            if 1024 <= p <= 65535:
                ports.add(p)
    except OSError:
        pass
    return ports
```

命中端口（排除后端自身端口与已知端口）→ `ensure_listener`。机制B 让监听先于首次播放就绪；机制A 兜住扫描漏网（拼接出来的端口、转换产物）。

### 2.3 go_proxy.ensure_listener 实现

```python
_extra_servers = {}          # port -> server
_extra_servers_lock = threading.Lock()
EXTRA_LISTENER_CAP = 16      # 泛化监听上限（防异常 jar 打满端口）
PROTECTED_PORTS = set()      # 启动时注入：后端端口 + go_proxy 已知端口

def ensure_listener(port):
    """幂等：已监听（含被外部进程占用）直接返回 True；超出上限/保护端口返回 False。"""
    if port in PROTECTED_PORTS or not (1024 <= port <= 65535):
        return False
    with _extra_servers_lock:
        if port in _extra_servers:
            return True
        if len(_extra_servers) >= EXTRA_LISTENER_CAP:
            logger.warning('go-proxy 泛化监听达上限(%d)，忽略端口 %d', EXTRA_LISTENER_CAP, port)
            return False
        try:
            srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), _Handler)
        except OSError:
            return False   # 已被其他进程监听（可能就是真 go-proxy）→ 视为覆盖
        threading.Thread(target=srv.serve_forever, daemon=True,
                         name='go-proxy-auto-%d' % port).start()
        _extra_servers[port] = srv
        logger.info('go-proxy 泛化监听已启动: 127.0.0.1:%d', port)
        return True
```

**安全边界**（全部强制）:
- 只绑 `127.0.0.1`，绝不 `0.0.0.0`；
- 保护后端自身端口（避免把 go-proxy `_Handler` 挂到 API 端口上造成协议错乱）；
- 上限 16 个泛化监听 + 每个监听复用同一个 `_Handler`（ThreadingHTTPServer 每连接一线程，与现状同量级）；
- bind 失败（端口被占）视为「已有服务」返回成功——被占用的可能正是真代理。

**验收**:
- [ ] 行为级：构造一个硬编码 7777 端口的假 jar（test-spider 改一版返回 `http://127.0.0.1:7777/proxy?...`）→ playerContent 后 7777 有监听、请求可达
- [ ] jar 字节扫描：对现有 vendor 里任一真实 jar 跑 `_scan_jar_ports`，端口与已知硬编码（7944/9978/1314）吻合
- [ ] 上限与保护端口路径有测试
- [ ] 兼容套件跑一轮无回归

---

## 任务三：夸克特判降级为协议层兜底

**现状与定性**: `go_proxy` 的夸克 API 实现（分享解析/转存/v2play）**符合 TVBox 架构**——真 TVBox 的 go-proxy 本就在宿主内实现网盘取流协议，这部分保留。不符合架构的是 `jar_spider.py:105-135` 的**前置短路**：检测到「我的网盘文件」格式的 vodId 就绕过 jar 直接拼 URL（绑定了特定 jar 的 vodId 格式假设）。

**修改**（调序，不删逻辑）:

```
现状:  vodId 命中格式 → 直接短路返回 go-proxy URL（jar 根本不跑）
目标:  先走 jar playerContent → 失败/退化(url==id 或空) 且 vodId 命中
       格式 → 兜底拼 go-proxy URL
```

- 现有代码已有退化检测（`url == id` 判断，`jar_spider.py:127-131`），把前置短路的构造逻辑移入该分支即可；
- 保留原短路作为**可开关的快路径**：加后端配置项 `pan_fast_path`（默认开，现有用户零感知；关掉后完全走 jar）——出现新 jar 格式不兼容时，用户侧可一键降级排查，而不是等发版；
- `_quark_folder_id` 的格式解析保持宽松（JSON 含 folder fid 即命中），不写死字段名组合。

**验收**:
- [ ] 行为级：模拟 jar 返回正常结果时短路不生效（jar 优先）；jar NPE 退化时兜底 URL 正确产出
- [ ] `pan_fast_path=off` 时全走 jar，路径可跑通（用现有 test-spider 验证）
- [ ] 兼容套件哈基米仓（pan-quark tag）无回归

---

## 任务四：FongMi 契约对齐审计

**做法**: 逐项对照 FongMi TVBox 源码（Kazumi 原版在 `../Kazumi-main/` 的经验已证明「对照原版源码」是本项目最有效的对齐方法），产出 `docs/TVBOX_CONTRACT_GAPS.md` 差距清单，再按清单排修复。审计矩阵：

| 审计项 | 对照点 | 已知/待查 |
|---|---|---|
| 站点类型矩阵 | type 0/1/3/4、`csp_`、type 0 + spider 覆盖 | 已支持 0/1/3/4/csp_；**待查**: type 15（xiaoya 系）、type 16、`type: 0 + api 为 .js` |
| per-site spider/jar 覆盖 | site.jar / site.spider 覆盖顶层 | `_build_site` 已处理 site_jar；**待查**: 覆盖优先级与 FongMi 是否一致 |
| ext 解析 | 相对路径按配置 URL 解析、ext 为 URL 时拉取 | 已有相对路径解析；**待查**: ext 是 http URL 时是否拉取展开 |
| parses 路由 | parse=1 → 按 flag 匹配 parses（type 0 json / type 1 扩展 / type 3 webview嗅探）、`jx` 字段 | **已知缺口**: parse=1 时 parses 列表的使用程度、webview 嗅探（parse-window 是否覆盖 mix 型） |
| playerContent 语义 | url/parse/headers/playUrl、`flag` 与 `vipFlags` 匹配 | 基本支持；**待查**: playUrl 字段、header 透传到 mpv 的完整性 |
| lives | 直播源 txt/m3u/多线路 | 已有 lives 字段读取；**待查**: liveContent 契约完整度 |
| JS 宿主环境 | cheerio/CryptoJS/dayjs/pdfa·pdfh·pdft(drpy)/HikerWeb | 已注入 cheerio/CryptoJS/dayjs；**待查**: drpy 系全局缺失时的报错可见性 |
| 快捷字段 | wallpaper/drives/heat/hotList | wallpaper 已有；**待查**: drives（网盘挂载）、hotList |

**产出物**: 差距清单按「影响面 × 实现成本」排序，高影响低成本的直接转任务修复（修复同样进兼容套件语料）。

**验收**:
- [ ] `docs/TVBOX_CONTRACT_GAPS.md` 落盘，含每项的 FongMi 源码位置引用
- [ ] 高影响项转成具体任务并排期

---

## 任务五：分层诊断增强

**目标**: 用户报「某仓播不了」时，能在一分钟内定位到 L1-L4 哪层坏了，而不是考古。

**改动点**:
1. **configTask 摘要增强**（`server.py _config_task`）: 现有 skipped 原因基础上，按层聚合计数——`parse_errors / build_errors{type_unsupported, jar_failed, js_failed, py_failed} / sites_built`，前端配置导入摘要直接展示分层数字；
2. **site 加载失败结构化**: `_build_site` 抛错时统一带层标签（`[L2:type]`、`[L3:jar]`…），`skipped` 列表保留完整标签前缀（现有只留原因文本）；
3. **JS 宿主缺失全局可见化**: quickjs eval 报 `xxx is not defined` 时 logger.warning 明确提示「该 JS 源需要宿主未提供的全局 <xxx>」（现在 buried 在异常栈里）；
4. **播放链路打点**: `playerContent` 返回 `parse=1` 但 parses 列表为空/无匹配时，`_attach_jar_error` 风格附加明确原因（现在会静默落「无法播放」对话框）。

**验收**:
- [ ] 断网状态下导入一个仓 → configTask 摘要能区分「拉取失败(L1)」
- [ ] 构造 type:15 站点 → skipped 显示 `[L2:type] unsupported type: 15` 而非裸值
- [ ] 兼容套件报告直接复用这些分层标签（任务一 1.2 的 skipped 原因分布来源）

---

## 执行顺序与依赖

```
任务一 兼容套件 ──┬─→ 任务二 端口泛化 ──→ 任务三 夸克降级
（先拍基线）      │     （每步用套件回归）
                 └─→ 任务四 契约审计 ──→（差距清单驱动的后续修复）
任务五 诊断增强（与任务四并行，产出物互相引用）
```

- 任务一必须最先做：没有基线，任务二/三的「无回归」无法证明；
- 任务二先于任务三：端口泛化独立且收益直接；任务三涉及播放主路径，需要套件+行为级测试双重保护；
- 任务四是长线：审计产出驱动下一轮迭代，与任务五并行。

---

## 附录A：诊断——为什么换了仓库就不适用

**TVBox 的「万能」是架构性的**：宿主只实现契约（配置解析 + 爬虫运行时 + 六方法调用 + 播放路由 + 本地代理转发），**所有站点规则随配置自带**（jar/JS/Py/CMS 接口）。规则不命中宿主代码，换仓库自然无感。

**本项目当前架构已是 TVBox 模式**（type 0/1 CMS、type 3 内联 Py、type 4 QuickJS、csp_ jar 桥、parses、go-proxy 端口全覆盖均已实现），但历史修复混入了宿主侧特判：

| 特判 | 位置 | 换仓失效方式 |
|---|---|---|
| 夸克「我的网盘」前置短路 | `jar_spider.py:105-135` | 绑定特定 jar 的 vodId 格式；新 jar 格式变化即失效或误触发 |
| 按 jar 家族硬编码端口 | `go_proxy.py:86-94` | 新 jar 硬编码新端口 → 无人监听 → 播放失败 |
| jar 字节码补丁 | `jar_patch.py` | 仅对特定 jar 版本；上游更新即失效（可接受，属文档化的定向修复） |
| 21 仓手工修复记录 | `test-repos.md` | 修复散落在各提交，无回归保护，改一处可能退步另一处 |

`test-repos.md` 的存在本身就是「打地鼠模式」的记录：每个仓修一轮、无资产沉淀。本计划把经验语料化（任务一）、机制通用化（任务二/三）、差距清单化（任务四/五），从根上切换到契约层修复模式。

## 附录B：验收清单（总）【2026-08-17 复核：多数未达成，见 `TVBOX_COMPAT_PLAN_REMAINING.md`】

- [ ] 21 仓语料全量跑通并落基线；敏感性验证（故意破坏一处 → 套件变红）—— ❌ 未达成（拉取 8/21、解析 3/21、无基线）
- [ ] 端口泛化：假 jar 7777 端口行为级验证 + 真实 jar 扫描吻合已知端口 —— 🟡 代码完成，无验收测试
- [ ] 夸克降级：jar 优先/兜底两条路径行为级验证 + `pan_fast_path` 开关 —— 🟡 代码在，无开关入口与测试
- [ ] `docs/TVBOX_CONTRACT_GAPS.md` 差距清单落盘，高影响项转任务 —— ❌ 未开始
- [ ] 分层诊断：L1-L4 标签在 configTask/日志/套件报告三处可见 —— 🟡 仅 build_errors 聚合
- [ ] 全量回归（Python 133 + JS 206 + 双 lint）+ `test:compat` 全绿 —— 🟡 test:all 可绿；test:compat 未跑通
