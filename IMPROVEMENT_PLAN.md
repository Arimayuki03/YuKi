# YuKi（video-pc）改进优化任务清单（详细版）

- **生成日期**: 2026-08-16（同日更新为详细步骤版）
- **定位**: 承接 `CODE_REVIEW.md`（安全漏洞与功能 bug，9 高危 / 30 中危 / 25 低危，修复路线见其第五节），聚焦其**未覆盖的维度**：测试体系、架构组织、后端资源治理、工程化基建、仓库卫生、打包分发。
- **使用方式**: 按批次执行，完成后勾选条目；每个任务附「步骤」「验收」；与 CODE_REVIEW 修复可并行。

---

## 目录

- [⚠️ 第〇批：紧急——Cookie 已入 git 历史](#第〇批紧急cookie-已入-git-历史)
- [第一批：快赢项](#第一批快赢项)
- [第二批：工程化基建](#第二批工程化基建)
- [第三批：后端性能与资源治理](#第三批后端性能与资源治理)
- [第四批：架构与代码组织](#第四批架构与代码组织)
- [第五批：打包分发与长期项](#第五批打包分发与长期项)
- [附录A：测试覆盖缺口与补测清单](#附录a测试覆盖缺口与补测清单)
- [附录B：后端现状速览（改进基线）](#附录b后端现状速览改进基线)

---

## ⚠️ 第〇批：紧急——Cookie 已入 git 历史

### A0. 夸克登录 Cookie 已提交进 git 仓库

**现状（已核实）**：
- `DuoDuo/.quark`（1617 字节，JSON 含 `user` 键 = 夸克登录 Cookie）与 `DuoDuo/.config` 已被 git 跟踪，随提交 `47aa428`（2026-08-16）入库
- `TVBox/thread.json`（924 字节）同样被跟踪
- `.gitignore:18-20` 只忽略了 `FM/` 和 `python-backend/FM/`（注释明言"网盘蜘蛛运行时状态，含 cookie 敏感文件，禁止入库"），但**漏掉了 `DuoDuo/`、`TVBox/`、`VOX/`、`TV/` 这几个同类运行时目录**——说明有网盘 spider 以项目根目录为 cwd 运行，把状态写到了仓库里

**步骤**：

1. **停止跟踪（保留工作区文件，应用正在用）**：
   ```bash
   git rm --cached DuoDuo/.config DuoDuo/.quark TVBox/thread.json
   ```
2. **.gitignore 补全**——在现有 `FM/`、`python-backend/FM/` 条目旁追加：
   ```gitignore
   # 网盘蜘蛛运行时状态（含 cookie 敏感文件，禁止入库）
   FM/
   python-backend/FM/
   DuoDuo/
   VOX/
   TV/
   TVBox/
   python-backend/DuoDuo/
   python-backend/VOX/
   python-backend/TV/
   python-backend/TVBox/
   ```
   （更稳妥的长期方案见第 3 步——根治后这些目录不该出现在仓库根）
3. **根治来源**：定位哪个 spider 以仓库根为 cwd 创建了 `DuoDuo/`、`FM/`、`VOX/`、`TVBox/`——在 `python-backend` 中全局搜索这些目录名字符串（`grep -rn "DuoDuo\|TVBox\|VOX" python-backend/ --include="*.py" | grep -v test`），把运行时状态目录统一改到 `hoststate.get_cache_dir()` 之下；临时缓解可在启动后端时显式设置 `cwd` 为缓存目录
4. **评估历史是否需要重写**：
   - 仓库**从未 push 到远端** → 本地历史自用，风险可控，做完 1-2 步即可；稳妥起见仍建议做第 5 步
   - 仓库**已 push**（哪怕私有远端）→ 必须 `git filter-repo --path DuoDuo/.quark --path DuoDuo/.config --path TVBox/thread.json --invert-paths` 重写历史并 force-push，同时通知所有克隆
5. **轮换凭据**：无论是否重写历史，登录态都应视为已泄露——在应用内退出夸克登录并重新扫码，使旧 Cookie 失效
6. 提交：`fix(repo): 移除误入库的网盘运行时状态（含 cookie）`

**验收**：
- [x] `git ls-files | grep -E "DuoDuo|TVBox|VOX|FM"` 输出为空（214a8c8）
- [x] `git status` 中这些目录不再出现为未跟踪/已修改
- [ ] 重新扫码后新 Cookie 只写入数据目录，仓库根不再新生成这些目录（jar JVM 已固定 cwd 到 `<cache>/jar-runtime` 并带历史迁移；待下次启动网盘源后复核）
- [x] （已 push 情况）仓库无远端，不适用；如后续推远端需先 `git filter-repo` 清 47aa428 的历史

> ⚠️ 用户侧待办：应用内退出夸克登录并重新扫码，轮换已入过库的 Cookie。

---

## 第一批：快赢项

### A1. 接入被遗漏的 Kazumi 单测套件 ⚠️ 全项目最高性价比

**现状**：`python-backend/tests/test_kazumi.py` 是唯一的标准 unittest 套件（11 个类 83 个用例 1079 行，带 mock 和 tempdir），但 `run_all.py:16-21` 的 `STAGES` 没有包含它——`npm run test:py` 从不执行，回归等于没跑。

**步骤**：

1. 编辑 `python-backend/tests/run_all.py`，`STAGES` 增加一行（放在 phase3 之后、jar-phase 之前，kazumi 不依赖 jar 环境）：
   ```python
   STAGES = [
       ('smoke', [PY, os.path.join(HERE, 'smoke.py')]),
       ('phase3', [PY, os.path.join(HERE, 'test_phase3.py')]),
       ('kazumi', [PY, os.path.join(HERE, 'test_kazumi.py')]),   # 新增
       ('jar-phase', [PY, os.path.join(HERE, 'test_jar_phase.py')]),
       ('jar-e2e', [PY, os.path.join(HERE, 'test_jar_e2e.py')]),
   ]
   ```
2. 运行全套件，观察 kazumi 阶段结果：
   ```bash
   npm run test:py
   ```
3. **若有失败用例**（长期未跑可能已漂移）：逐个判断是「测试过时」还是「代码回归」——
   - 测试断言与当前正确行为不符 → 更新断言，提交说明注明原因
   - 代码真回归 → 修复代码（这是白捡的 bug 检测）
4. 同步更新 `PROGRESS.md` 中的测试计数（当前写的 "Python 38/38" 只统计了 smoke+phase3，接入后应为 38+83）

**验收**：
- [x] `npm run test:py` 输出含 `===== stage: kazumi =====` 且 PASS（f4875ab；接入即捕获 HEAD 回归：7816695 注释剥除损坏内嵌 JS 源，已修 aa9002f）
- [x] PROGRESS.md 测试计数更新（38 → 121 项）

### A2. 仓库卫生清理（磁盘侧）

> 入库侧已在 A0 处理；本任务清理 .gitignore 已忽略但仍占磁盘的调试遗留物。

**步骤**：

1. 逐一确认后删除（均为调试遗留，全仓库无代码引用）：
   ```bash
   rm -f nul                                          # Windows 重定向产物，0 字节
   rm -f python-backend/p2_backend.log python-backend/p2_backend.err.log
   rm -f ha-orchestrator.config.backup.json           # 备份文件（正式配置已被 .gitignore 忽略）
   ```
   删除前抽查内容确认无保留价值：`cat python-backend/p2_backend.log`（应为 44 字节的握手行）。
2. `tmp/`（290 个 Probe*.java 等调试探针）与 `TV/`（空目录）：
   ```bash
   rm -rf tmp TV
   ```
   `.gitignore:10` 已忽略 `tmp/`，不会影响 git；若近期还在用某些探针，先归档到仓库外。
3. `VOX/`、`DuoDuo/`、`FM/`、`TVBox/`（运行时状态）**不要手删**——应用正在使用（夸克 Cookie 就在里面）；等 A0 第 3 步把状态目录迁到数据目录后，随迁移清理。
4. 防复发：给 `.gitignore` 追加 `/nul` 已有（第 12 行 `/nul` 已覆盖）；`*.backup.json` 可再加一条。

**验收**：
- [x] `ls` 根目录只剩业务目录；`tmp/`、`nul`、`p2_backend*.log`、`*.backup.json` 消失
- [ ] `npm start` 正常启动（删除项均确认无代码引用；待下次启动复核）

### A3. Python 依赖锁定

**现状**：`python-backend/requirements.txt` 11 个依赖全部 `>=` 开区间，任何一次全新安装都可能拉到不兼容新版本；Python 3.14 属最前沿，第三方轮子兼容风险高（文件内注释已提到 ujson 因无轮子暂缓）。

**步骤**（二选一）：

**方案一：pip-tools（侵入最小）**
1. 在 venv 中安装：`python-backend\.venv\Scripts\python.exe -m pip install pip-tools`
2. 把现 `requirements.txt` 重命名为 `requirements.in`
3. 生成锁定文件：
   ```bash
   python-backend\.venv\Scripts\pip-compile.exe --generate-hashes -o python-backend/requirements.txt python-backend/requirements.in
   ```
4. 验证可复现安装：新建临时 venv 用锁文件安装，跑 `npm run test:py`

**方案二：uv（现代工具链，顺带解决安装速度）**
1. 安装 uv 后：`uv pip compile python-backend/requirements.in -o python-backend/requirements.txt`（或直接 `uv init` 转为 pyproject 管理）
5. 无论哪个方案：`build:py`（`scripts/build-python.js`）中的 PyInstaller 安装命令改为使用锁文件
6. 升级流程文档化：改 `requirements.in` → 重新 compile → 全量回归

**验收**：
- [x] 锁文件入库，内含具体版本号（8745d31，pip-compile 28 项含传递依赖）
- [ ] `scripts/build-python.js` 使用锁文件安装（该脚本本就不装依赖、假定 venv 已就绪；改为由 CI 与文档承担环境重建，见 B1）
- [ ] 全新 venv 按锁文件安装后 `npm run test:py` 通过（当前 venv 已对齐锁版本并回归通过；全新 venv 场景由 CI 首跑验证）

---

## 第二批：工程化基建

### B1. 持续集成（CI）

**现状**：无任何 CI；200+ 测试全靠本地手动 `npm run test:all`；`docs/TEST_REPORT.md` 是 2026-08-10 的人工记录。

**步骤**：

1. 新建 `.github/workflows/ci.yml`：
   ```yaml
   name: CI
   on:
     push: { branches: [master, main] }
     pull_request:
   jobs:
     js:
       runs-on: windows-latest          # 主开发平台是 Windows
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 20, cache: npm }
         - run: npm ci                   # postinstall 的 download-binaries 失败已容错(exit 0)
         - run: npm run test:jsunit
         - run: npm run test:js
     python:
       runs-on: windows-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-python@v5
           with: { python-version: '3.13' }   # 3.14 runner 可能没有，取接近版本
         - run: pip install -r python-backend/requirements.txt
         - run: python python-backend/tests/run_all.py
   ```
   注意点：
   - `run_all.py` 末段会对全后端 `py_compile`，无需额外步骤
   - jar-e2e 阶段在无 JDK 时自动跳过不算失败（`test_jar_e2e.py` 已处理），runner 自带 Java 则会真跑
   - A1 完成后 kazumi 阶段自动纳入
2. 先跑两周「只报告不拦截」（`continue-on-error: true` 或仅 push 触发），修完 flaky 用例再改为必须通过
3. 后续增强（可选）：`npm run build:py` + electron-builder 的 nightly 构建与产物上传

**验收**：
- [ ] push 后 Actions 两个 job 全绿（workflow 已创建；仓库尚无远端，首次推送时生效）
- [ ] 故意引入一个语法错误，CI 能红（验证门禁真实生效）

### B2. Lint / 格式化

**现状**：`scripts/check-js.js` 只做 `node --check` 语法门禁，不是 lint——CODE_REVIEW 中 H-7（未定义变量 `header`）、L-12（恒假条件）这类问题它拦不住。

**步骤**：

1. **Python 侧（Ruff，先做，收益立现）**：
   ```bash
   pip install ruff
   ```
   项目根建 `pyproject.toml`（或 `ruff.toml`），从零误伤规则起步：
   ```toml
   [tool.ruff]
   line-length = 120
   target-version = "py312"
   [tool.ruff.lint]
   select = ["E9", "F63", "F7", "F82", "F401"]   # 语法错误/未定义名/未使用导入
   ```
   先跑 `ruff check python-backend --statistics` 看存量，逐类修复后再逐步放开规则（`B`、`PL` 等）。
2. **JS 侧（ESLint flat config）**：
   ```bash
   npm install -D eslint
   ```
   建 `eslint.config.js`，首轮只开 `no-undef` / `no-unused-vars` / `no-undef-init`；渲染层脚本因依赖浏览器全局（`$`、`window`），用 `languageOptions.globals` 声明（`globals` 包或手写），**不要**为过 lint 改业务代码。
3. 接线：
   - `package.json` 增加 `"lint": "eslint src tests"`、`"lint:py": "ruff check python-backend"`、`"format": "ruff format python-backend"`
   - 本地先跑通零误伤，再挂进 B1 的 CI（同样先 warn 后 fail）
4. 格式化**不整仓一次做**（污染 blame）——规则定为「改哪个文件顺手 format 哪个」，或一次性单独提交 `chore: format` 与功能变更隔离。

**验收**：
- [x] `npm run lint` 与 `npm run lint:py` 在当前代码库通过（存量清零：JS 0 错误/82 警告——均为跨文件导出模式的预期误报；Python 21 处未使用导入已清）
- [x] 人为写一个未定义变量，两个 lint 都能报出（ESLint 首轮即捕获 3 处真实 ReferenceError：player.js:437 `header`=CODE_REVIEW H-7、detail.js:351 `data`=M-29、records.js:177 `entry` 越出 else 块——均已修复且回归通过；Ruff F82 规则已启用）

### B3. 依赖健康与供应链

**步骤**：

1. **二进制下载校验（已完成，见下）**：
   - [x] 新建 `scripts/binaries.lock.json`，为 mpv/aria2（锁 release tag + 压缩包 sha256）、anime4k（6 文件）、misans（202 分片）记录哈希；ffmpeg 上游无版本化摘要暂记 null
   - [x] `download-binaries.js`：mpv/aria2 按 lock 锁定 tag 取 release（更新=改 lock）；所有新下载完成后 sha256 强校验，不符删除产物并报错；anime4k/misans 已存在文件跳过时也校验
   - [x] 篡改测试通过：改坏任一哈希 → 文件被拒 + 清晰报错；恢复 lock 后重下校验通过
2. **依赖审计进 CI（已完成，首轮 `|| true` 观察基线，稳定后改为拦截）**：
   - [x] js job：`npm audit --omit=dev`
   - [x] python job：`pip-audit -r python-backend/requirements.txt --strict`
3. **Electron 升级窗口（需用户在场，方案已定）**：
   - 现状 `^31` → 最新 **43.4.0**（落后 12 个大版本，Chromium 安全补丁已停）。不建议 12 级阶梯升级（每级都要人工冒烟），建议一次到位：
     - ① `npm install -D electron@43 electron-builder@latest`（builder 25 对 43 的支持需同步升级）
     - ② 自动门禁：`npm run test:jsunit && npm run test:js && npm run lint`
     - ③ 核对 webPreferences 默认值变化（新版本 sandbox 默认收紧——与 CODE_REVIEW M-4/M-5 修复方向一致，先完成 M-4/M-5 可减少升级摩擦）、`session`/`protocol`/`utilityProcess` API 变更
     - ④ **用户手动冒烟**（此步必须用户在场）：播放（本地/直链/网盘源）、下载（aria2/HLS）、夸克扫码、推送、DLNA、截图
     - ⑤ 出问题按 `git revert` 单提交回退
   - [ ] 待用户安排时间执行 ①-⑤

---

## 第三批：后端性能与资源治理

> 改进基线见附录B。以下任务建议按 C1 → C2 → C3 顺序做，C4 穿插进行。

### C1. 统一 HTTP 客户端封装

**现状**：全后端只有 go_proxy 的 `_qses` 一个显式 `requests.Session`；其余全部模块级 `requests.get/post` 直调——每次请求新建 TCP 连接；超时散落 5/10/15/30/60s 六档；系统代理感知逻辑重复实现三份（`app.py:27-57`、`go_proxy.py:34-68`、`jar_bridge.py:188-228`）。

**步骤**：

1. 新建 `python-backend/http_client.py`，接口设计：
   ```python
   # 三档超时常量（连接, 读）
   TIMEOUT_FAST = (3, 5)   # spider 基类现值
   TIMEOUT_NORMAL = (5, 15)
   TIMEOUT_SLOW = (10, 60) # go_proxy 分段取流

   _session = None
   def get_session() -> requests.Session: ...   # 惰性创建，trust_env + 代理注入，线程安全加锁

   def http_get(url, *, timeout=TIMEOUT_NORMAL, proxy=True, retries=1, **kw) -> requests.Response: ...
   def http_post(url, *, ...) -> ...
   def system_proxies() -> dict: ...   # 收编 app.py 的实现作为唯一版本
   ```
2. 迁移顺序（按调用量从高到低，每步一个提交便于回退）：
   - ① `base/spider.py:93-101`（fetch/post——所有 Py spider 的底层，调用量最大）
   - ② `config.py`（fetch_text，配置拉取）+ `cms_spider.py`
   - ③ `app.py`（_fetch/redirect，顺带修 CODE_REVIEW L-11 的无限重定向——加 max_redirects=5）
   - ④ `kazumi/rule_engine.py` + `kazumi/plugin_manager.py`（散点最多，约 28 处）
   - ⑤ `jar_bridge.requests_get_jar`、`server.py` trace.moe 两处
3. 迁移完成后删除 `go_proxy._system_proxies` 与 `jar_bridge` 中各自的代理实现（`proxy_java_args` 改调 `http_client.system_proxies()`）
4. 每步迁移后跑 `npm run test:py` + 手动聚合搜索一次（8 并发 × 多站最能暴露连接问题）

**验收**：
- [x] 残余 `requests.get/post` 直调仅剩 go_proxy:202（取流专用会话，有意保留）与 http_client 自身/测试（已 grep 核实）
- [x] `def _system_proxies` 全后端为 0（app.py/go_proxy.py/jar_bridge.py 三份实现收编为 http_client 唯一版）
- [x] 回归通过（Python 121 项 ALL PASS + JS 206/206 + Ruff/ESLint 0 错误）；test_kazumi 的 mock 点已随迁移更新（`requests.get`→`http_client.get` 19 处）
- [x] 代理双来源兼容：环境变量（应用内代理，kazumi 链路原行为）优先、WinINET 兜底——避免破坏主进程注入的代理语义
- [x] 顺带修复 CODE_REVIEW L-11：`redirect()` 收编为 `fetch_follow_redirects`（深度上限 5 + 相对 Location urljoin）
- [x] Cookie 竖井：共享 Session 挂禁落地策略（Python 3.14 无 BlockAll，自定义 `set_ok=False`），显式 Cookie 头永不被 jar 覆盖（L-18 结论全局版）
- 备注：base/spider.py、go_proxy.py、server.py 三文件的迁移与既有未提交修复同在工作区，随用户那批一起提交；spider 基类 UA 从 python-requests 变为 okhttp（TVBox 客户端同款，生态兼容性更佳）

### C2. 缓存体系加上限与主动淘汰

**现状**：`CacheStore` 每 key 一个 JSON 文件、无条目/字节上限、惰性 TTL（`stats()` 全量读盘）；go_proxy `_SHARE_CACHE` 无上限仅读时判 TTL；`_SAVE_CACHE` 永久增长；JS 本地 KV 无限写且每次 set 全量重写；`_player_content_cache` 无锁。

**步骤**：

1. **CacheStore**（`cache_store.py`）：
   - `__init__` 记录 `self._total_bytes`（写/删时增减），设定上限常量 `MAX_TOTAL_BYTES = 50 * 1024 * 1024`
   - `set()` 时超限则淘汰：优先删已过期项，仍超限按 `os.path.getmtime` 淘汰最旧（简单 LRU-近似，够用）
   - `stats()` 改为维护计数器（写/删/淘汰时更新），消除全量读盘
2. **go_proxy**：
   - `_SHARE_CACHE` 读取命中过期即 `pop`（现在只跳过不删）；再加一个简单的上限（如 512 条）触顶全清——分享缓存本就 300s TTL，全清代价低
   - `_SAVE_CACHE` 落盘前检查条目数，超 2000 删最旧（按文件内 ts 字段）
3. **JS 本地 KV**（`quickjs_host.py:38-71`）：
   - 与 CODE_REVIEW M-24（按站点隔离）合并实施：结构改为 `{"<site_key>": {...}}`，写盘加单值 64KB / 总量 2MB 配额，超限抛 JS 可感知的异常
4. **_player_content_cache**（`server.py:84-85, 398-413`）：加 `threading.Lock` 保护 get/set/清理迭代；清理条件从「>1024 项」改为每次 set 后惰性检查（超 512 项即清过期）

**验收**：
- [ ] 单测：写超限数据后目录总字节不超上限、最旧条目被淘汰、get 过期条目返回 None 且文件被删
- [ ] A1 接入的 kazumi 套件 + smoke 全绿（CacheStore 协议未变）

### C3. 并发治理

**步骤**：

1. **全局 spider 并发信号量**（`server.py`）：
   - 模块级 `_SPIDER_SEMAPHORE = threading.BoundedSemaphore(16)`
   - 在所有 `run_in_threadpool(...)` 包裹 spider 调用的位置（`server.py:671/677/686` 一带）外层套：
     ```python
     with _SPIDER_SEMAPHORE:
         result = await run_in_threadpool(spider_call, ...)
     ```
   - 上限初值 16（anyio 默认 ~40 线程的 40%），观察后调整；语义是「超载请求排队而非雪崩」
2. **aggregate_search 改 as_completed**（`server.py:455-475`，非 SSE 路径）：
   ```python
   done, pending = wait(futs, timeout=timeout, return_when=ALL_COMPLETED)
   results = [f.result() for f in done if not f.cancelled() and not f.exception()]
   for f in pending: f.cancel()
   ```
   消除「慢源在前、总耗时 60s×N」的放大（SSE 版 `server.py:585` 已是 as_completed，可对齐其写法）
3. **JVM 桥排队观测**（暂不动架构，先量化）：
   - `jar_bridge.py` 的 `call()` 在获取 `_call_lock` 前后打点，记录等待时长到日志（现有 RotatingFileHandler 直接承接）
   - 若 P95 等待 > 2s 再考虑：按 `(jar, class)` 维度拆桥，或 JVM 实例池（成本高，需先有数据支撑）

**验收**：
- [ ] 压测脚本：并发 32 个 `/action searchContent`，后端无 5xx、无线程暴涨（`threading.active_count()` 稳定）
- [ ] aggregate_search 对「1 个慢源 + 7 个快源」返回总耗时 ≈ 慢源自身耗时（而非叠加）

### C4. 启动与预热（度量先行）

**步骤**：

1. 在关键节点打时间戳日志（复用现有 logging）：
   - 主进程：`python-bridge.js` spawn 前/后、解析到 `VPC_BACKEND_READY` 时
   - 后端：`server.py main()` 各阶段（load_default_sites 前/后、create_app 前/后）
   - 渲染层：`app.js` 首帧、首个 homeContent 请求发出/返回
2. 冷启动（重启机器后 `npm start`）记录 5 次取中位数，形成基线数字写进 `docs/ARCHITECTURE.md`
3. 依据数据决定优化项（候选：窗口先显示骨架屏再等后端；首页首站点 homeContent 在 READY 后立即预取而非等渲染层请求；PyInstaller `--onedir` 已是目录模式则检查是否误用 `--onefile`）
4. 打包版（dist 安装后）重复 1-2，对比 dev 差距，防打包回归

**验收**：
- [ ] `docs/ARCHITECTURE.md` 有冷启动耗时表（dev + 打包版）
- [ ] 至少落地一个数据支撑的优化，并更新表格

---

## 第四批：架构与代码组织

### D1. 渲染层模块化（渐进，不引框架）

**现状**：原生 JS + jQuery，`index.html` 固定顺序引 18 个 `<script>`；模块间靠隐式全局函数互调（跨文件调用如 `home.js` 调 `common.js` 的函数全凭加载顺序正确）。

**步骤**：

1. **先做零风险导出层**：每个 `src/renderer/js/*.js` 文件头部加计数注释，文件尾部统一挂命名空间：
   ```js
   // search.js 尾部
   window.VPC = window.VPC || {};
   VPC.search = { aggregateSearch, renderResults, switchSite /* 现有的全局函数名 */ };
   ```
   文件内部逻辑不动，纯追加——每次一个文件，跑 `npm run test:jsunit`（home-probe 等 vm 加载型测试最能发现破坏）。
2. **公共层收敛**：`common.js` 保持唯一公共依赖；排查其他文件是否重复定义了工具函数（CODE_REVIEW 已确认 `escHtml` 集中在 common.js:64，顺势审查 toast/分页/请求包装是否有多份拷贝）
3. **内联事件迁移**（为 CODE_REVIEW L-33 的 CSP 收尾铺路）：改到哪个页面就把该文件的 `onclick="..."` 模板字符串改为事件委托（`container.addEventListener('click', e => ...)` + `data-action` 属性），kazumi.js 两处 onerror 优先（正是 H-6 所在）
4. **（可选，收益递减）** 引入 Vite 做打包与 HMR：Electron 渲染层用 `vite-plugin-electron` 或纯静态构建均可，迁移期间新旧两种加载并存（未迁移文件继续 `<script>` 引入）
5. 每完成一个文件在本文档勾选：`home` `search` `detail` `panels` `kazumi` `player` `records` `downloads` `live` `my` `timeline` `popular` `bangumi-search` `about` `app` `cache`

**验收**：
- [ ] 任一文件的「被外部调用的函数」都能通过 `VPC.<module>.<fn>` 访问，`grep -c "function " src/renderer/js/search.js` 中无新增隐式全局依赖
- [ ] 全部页面手动走一遍无 console 报错
- [ ] kazumi.js 两处 onerror 内联 JS 消失（配合 CODE_REVIEW H-6 修复）

### D2. 主进程 index.js 拆分（2246 行 / 66 个 IPC handler）

**现状**：播放、下载、设置、网盘、推送、DLNA、SyncPlay、壁纸、窗口管理全部混在 `src/main/index.js`。

**建议拆分映射**（按 66 个通道的功能前缀实测分布）：

| 新文件 | 收编的 IPC 前缀 | 约通道数 | 附带搬走的本地状态 |
|---|---|---|---|
| `src/main/ipc/play.js` | `play` `player` `mpv` `external` `parse` | ~9 | 播放会话、直播备用线路循环（CODE_REVIEW M-7 所在） |
| `src/main/ipc/download.js` | `dl` `download` + clear 相关 | ~6 | 与 `downloader.js`/`hls-downloader.js` 的接线 |
| `src/main/ipc/settings.js` | `set` `get` `pick` `settings` + 部分 `clear` | ~13 | 设置变更的副作用（重拉起后端、壁纸） |
| `src/main/ipc/pan.js` | `pan` `captcha` | 3 | `pan-qr-window` 接线 |
| `src/main/ipc/syncplay.js` | `syncplay` | 5 | syncplay-client 接线 |
| `src/main/ipc/misc.js` | `win` `app` `file` `asset` `font` `log` `push` `capture` `dlna` `probe` `config` `load` `update` `onboarding` `test` `shutdown` | ~30 | — |

**步骤**：

1. 建 `src/main/ipc/` 目录，约定注册函数签名：
   ```js
   // ipc/play.js
   module.exports = function registerPlayIpc(ctx) {
     // ctx = { mpv, bridge, downloader, settings, mainWindow, ... } 由 index.js 装配传入
     ipcMain.handle('vpc:play', (_e, payload) => { ... });
   };
   ```
   `index.js` 只保留：窗口生命周期、模块装配（构造 ctx 逐个调 register）、`before-quit` 清理（顺带修 CODE_REVIEW M-8——抽公共 `gracefulShutdown()` 供 settings-reset 复用）。
2. 拆分顺序（每次一个文件、跑 `npm start` 冒烟 + `npm run test:jsunit`）：settings（最独立）→ syncplay → pan → download → play（最复杂放最后）→ misc
3. 顺手把 CODE_REVIEW 对应条目一起修：M-7（直播备用线路）、M-8（退出清理）、M-1（settings-set 白名单）正好分布在被拆文件里
4. 同法可拆渲染层与后端大文件（非必须，按修 bug 顺手原则）：
   - `src/renderer/js/kazumi.js`（2177 行）→ 搜索 / 详情 / 规则编辑 / Bangumi 同步 四块
   - `python-backend/kazumi/plugin_manager.py`（1622 行）→ 规则 CRUD / 商店 / 校验 / Bangumi 同步 四块
   - `panels.js`（1777）、`detail.js`（1561）同理

**验收**：
- [ ] `wc -l src/main/index.js` < 600 行；`grep -c "ipcMain.handle" src/main/index.js` 为 0
- [ ] 每拆一个文件：`npm start` 播放/下载/设置三条链路手动验证
- [ ] 拆分纯移动不改逻辑（diff 审查确认，修 bug 单独提交）

### D3. 数据层统一（分三步走）

**现状**：收藏/历史在渲染层，下载记录在主进程 `dl-records.json`，Kazumi 规则与 Cookie 在后端 `~/.video-pc/`——三处存储三套读写与同步逻辑，竞态类 bug（CODE_REVIEW M-30 系列）的根源。

**步骤**：

1. **盘点（半天）**：列表化每类数据的存储位置、读写方、迁移路径——产出 `docs/DATA_MAP.md`：渲染层 localStorage 键清单（`grep -rhoE "localStorage\.(get|set)Item\('[^']+'" src/renderer/js | sort -u`）+ 主进程 JSON 文件 + 后端 `~/.video-pc` 文件
2. **后端补齐通用记录 API**（`server.py` 已有 CacheStore 与 token 鉴权，增加 `/records/<type>` GET/POST/DELETE，内部走 CacheStore 或独立 JSON 文件，原子写参照 CODE_REVIEW M-28 的 tmp+replace 方案）
3. **逐类迁移**（每类一个 PR，保留旧数据一次性导入）：下载记录 → 历史/观看统计 → 收藏；渲染层改为纯 API 视图，localStorage 仅留 UI 偏好（主题、布局）
4. 迁移完的竞态修复验证：快速连续搜索/切源/收藏，数据不再串（对应 M-30 各条逐一回归）

**验收**：
- [ ] `docs/DATA_MAP.md` 存在且与代码一致
- [ ] 渲染层 `localStorage` 仅存 UI 偏好类键
- [ ] M-30 列举的四组竞态场景手动复测通过

### D4. i18n 预留

**步骤**：

1. 若有多语言规划：先抽 `src/renderer/js/strings.js` 字典（`zh-CN` 键值表），新代码一律用 `t('key')`；存量文案**不**一次性替换（低收益高噪声），只约束增量
2. 无规划则跳过本项（记录决策即可）

---

## 第五批：打包分发与长期项

### E1. 自动更新

**步骤**：

1. `npm install electron-updater`；`src/main/index.js`（或拆分后的更新模块）加 `app.isPackaged` 守卫的 `autoUpdater.checkForUpdates()`，feed 指向 GitHub Releases（私有分发用 generic 静态服务器 + `latest.yml`）
2. `package.json` build 段补 `publish: { provider: 'github' }`；CI（B1 增强）在 tag push 时构建并发布
3. Windows 无代码签名会触发 SmartScreen 与更新包被拦——决策点：采购证书（EV 免逐步信誉积累）或 README 明示安装警告
4. 更新策略：默认仅提示不自动安装（影视工具用户对后台静默重启敏感）

### E2. 安装包瘦身

**现状**：vendor 携带 ffmpeg 139M + mpv 113M + dex-tools 20M + aria2 5.4M + misans 4.6M ≈ 285M。

**步骤**：

1. 记录基线：当前 NSIS 安装包体积（`ls -la dist/*.exe`）
2. **ffmpeg 精简**（收益最大）：确认项目实际用到的能力（HLS 下载 demux + concat + 可能的转码）→ 用官方构建勾选最小 feature set 或找第三方精简构建，目标 < 40M
3. **dex-tools/dexdeps 按需化**：仅 jar 源（csp_ 站点）用户需要 DEX 转换——首次遇到 DEX jar 时提示下载到数据目录（复用 B3 的带校验下载器），vendor 不再携带
4. mpv/aria2 保留（核心功能）；misans 字体保留（体验）
5. 每项瘦身单独提交，装包后跑下载 + jar 源播放两条链路验证

**验收**：安装包体积有明确下降并记录在 README 或 RELEASE 说明。

### E3. 跨平台验证

**步骤**：

1. 抽象平台层：`grep -rn "win32\|CREATE_NO_WINDOW\|WinINET" src/main python-backend --include="*.js" --include="*.py"` 列出 Windows 专属点，收敛到 `platform.js`/`platform.py` 适配模块（mac: scutil 代理、`NSApp` 前台；linux: gsettings 代理）
2. macOS 真机：`npm run build:mac` → dmg 安装 → 冷启动 → 播放/下载冒烟（mpv/aria2/ffmpeg 的 mac 二进制需在 download-binaries.js 补源）
3. Linux 同理（AppImage 优先，deb 次之）
4. 结果回写 README「当前状态」段（移除"待验证"字样或明确列出已知问题）

### E4. 文档整理

**步骤**：

1. `PROGRESS.md`（50KB）拆分：
   - 历史流水段落剪切并入 `docs/DEVELOPMENT_HISTORY.md`（按日期追加）
   - 剩余能力矩阵 + 续作入口浓缩为 ≤ 300 行的 `STATUS.md`（或就地瘦身 PROGRESS.md）
2. `docs/ARCHITECTURE.md` 增补：本文附录B 的并发模型/缓存清单/JVM 生命周期，以及 C4 的启动耗时基线
3. README「文档」列表同步更新；本文件（IMPROVEMENT_PLAN.md）完成任务后归档到 docs/ 或删除

---

## 附录A：测试覆盖缺口与补测清单

> B1 落地后按此表补测；优先级依据「模块关键性 × 现有覆盖为零」。

| 模块 | 行数 | 现状 | 建议优先级 | 补测切入点 |
|---|---|---|---|---|
| `src/main/python-bridge.js` | 138 | **零测试** | 高 | mock child_process：READY 握手解析、健康检查失败重启、exit 竞态（CODE_REVIEW H-9 修复的回归测试） |
| `python-backend/go_proxy.py` | 740 | **零测试** | 高 | 进程内起 handler：Range 解析/206、无长度透传（H-8）、双重解码（M-11）、_SegStream 取消不泄漏线程（M-21） |
| `src/main/hls-downloader.js` | 543 | 仅 2 个纯函数 | 中 | 用本地 http server 喂 m3u8：下载/concat/恢复（header 持久化 L-8） |
| `src/main/parse-window.js` | 416 | 零测试 | 中 | 隐藏窗口注入解析规则的超时与清理 |
| `src/main/index.js` | 2246 | 仅正则扫文本 | 中 | D2 拆分后按 ipc 模块测（ctx 全部 mock） |
| `src/main/push-server.js` | 102 | 零测试 | 中 | token 校验、首页不回显 token（M-3 修复的绊网） |
| `pan-qr*.js` `dlna-caster.js` `ffmpeg.js` `file-manager.js` `syncplay-client.js` `system-proxy.js` `win-focus.js` `misans.js` | ~1200 | 零测试 | 低 | — |
| `python-backend/cms_spider.py` `js_spider.py` `pan_cookies.py` `jar_patch.py` | — | 零直接单测 | 低 | jar_patch 纯字节操作最好测 |

**既有测试的两处质量问题**：

- [ ] `tests/js/api-contract.test.js`、`hls-concurrent.test.js` 等**在测试内复制实现了源码逻辑**（注释自述"提取自 hls-downloader.js"）——源码漂移时测试仍绿。重构方案：先做 D1 第 1 步（源码导出纯函数），测试改为 `require('../../src/main/hls-downloader')` 真实模块，删除测试内拷贝
- [ ] `scripts/acceptance-*.js`（10 个 CDP 验收脚本）不在任何入口——挑 2~3 个稳定的改造进 CI 冒烟（依赖网络的排除或 mock）

---

## 附录B：后端现状速览（改进基线）

- **进程模型**：Electron 主进程 spawn Python（dev: `.venv/python.exe -X utf8 server.py` / 打包: PyInstaller exe），stdout 握手 `VPC_BACKEND_READY port=<p> token=<t>`（token 不走命令行）；健康检查 15s；崩溃指数退避重启 1s→60s。go-proxy 三个端口（9978/7944/1314）为兼容不同 jar 硬编码
- **并发**：单进程单事件循环；阻塞 spider 调用落 anyio 默认线程池（~40 线程，**无上限**）；聚合搜索每请求临时 8 线程池；JVM 按 jar 全局单例 + `_call_lock` 串行（60s 超时强杀）；go-proxy `ThreadingHTTPServer` 每连接一线程，≥32MiB 资源走 `_SegStream` 8 段并发（256KiB×24 队列深度背压 ≈ 48MiB/请求内存上限）
- **缓存**：`CacheStore`（每 key 一 JSON 文件，惰性 TTL，**无上限**）｜`_player_content_cache`（1024 项/60s，无锁）｜`_SHARE_CACHE`（300s，无上限）｜`_SAVE_CACHE`（永久落盘）｜JS 本地 KV（全量重写，无配额）
- **持久化**：无 sqlite，全部 JSON 文本（`~/.video-pc/`：pan_cookies、kazumi/plugins+cookies+mirror、js_local、cache/kv、cache/jar、cache/dl；Electron userData：settings.json、dl-records.json）
- **日志**：RotatingFileHandler 5MiB×5 + 控制台，脱敏 Formatter（token/secret/Authorization/Cookie），sys+threading excepthook 兜底——**体系健康，无需改动**
- **HTTP**：除夸克专用 `_qses` 外全部无连接池直调；超时六档（5/10/15/30/60s 等）不统一；代理感知三处重复（app.py / go_proxy.py / jar_bridge.py）

---

## 执行顺序建议（依赖关系）

```
A0（Cookie 泄漏，立即）
  └→ A2（磁盘清理）
A1（接入 kazumi 测试）─┐
A3（依赖锁定）─────────┼→ B1（CI）→ B2（lint）→ B3（供应链/升级）
                       │
C1（HTTP 封装）→ C2（缓存上限）→ C3（并发治理）
C4（启动度量，穿插）

D1（渲染层命名空间）→ 附录A 的"复制逻辑测试"重构（依赖 D1 导出）
D2（index.js 拆分）↔ CODE_REVIEW 第二/三批修复（同文件顺手做）
D3（数据层）→ M-30 竞态回归验证
E1-E4（长期，无前置）
```
