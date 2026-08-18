# drpy 可行性 Spike 报告（N3.1 第一阶段）

> 范围：仅 N3.1 的「drpy 可行性验证」，比较三种运行方案并给出 ADR。
> 本阶段**不**实现完整 drpy 运行时（N3.1 后续实现、N3.2 QuickJS 契约补齐、N3.5 统一 `/proxy` 数据面均不在本轮范围）。
> 上游参考 `TV-fongmi/` 未做任何修改；`docs/` 既有文档仅做事实性更新。

- 日期：2026-08（本报告随 Spike 完成）
- 结论先行：**推荐方案 1 —— Supervisor 管理的独立 Node Worker（进程级沙箱）**，
  与本项目 `docs/TVBOX_FONGMI_PARITY_TASKS.md` N3.1 的默认建议一致；
  唯一需要工程化的缺口是「打包后无需用户另装 Node」（见 ADR-0001）。

---

## 1. Spike 目标

任务书 N3.1 要求的第一步：

1. 选 3～5 个真实风格 drpy 规则做兼容试验；
2. 比较三种方案：独立 Node Worker / 扩展 QuickJS / 外部 drpy 服务；
3. 产出 drpy 方法与宿主全局能力矩阵；
4. 产出三方案的兼容度、安全性、打包体积、维护成本对比；
5. 可运行的最小原型 + home/category/search/detail/player 五方法实测；
6. 无限循环、文件访问、子进程、内存限制测试；
7. 最终 ADR 与明确推荐方案。

## 2. 规则夹具（4 条，覆盖典型 drpy 面）

夹具位于 `python-backend/spike/fixtures/`，全部按标准 drpy `rule` / `__jsEvalReturn`
双协议导出（同时兼容 CJS `exports.rule` 与 ESM `export {}`），配套离线
`mock_server.py`（动态端口、`patch_host()`、签名校验、命中统计）：

| 夹具 | 代表场景 | 用到的能力 |
|---|---|---|
| `rule1_simple_cms.js` | 传统 HTML/CMS 站点 | `pdfa/pdfh/pdft/pd` 选择器、`req` 同步请求、`joinUrl` |
| `rule2_crypto_auth.js` | 加密鉴权类 | `CryptoJS.MD5/SHA256/HmacSHA256/AES`、签名 header、AES 信封解密 play url |
| `rule3_template_eval.js` | 动态模板/二级解析 | `new Function`/`eval`、正则提取、Base64、动态构造播放地址 |
| `rule4_stateful_local.js` | 会话维持 | `local.get/set` token 缓存、跨调用 session 复用 |

## 3. drpy 方法与宿主全局能力矩阵

> 以 FongMi 注入面（`TV-fongmi/quickjs/src/main/assets/js/lib/`、`Global.java`）为基准，
> 结合 drpy/drpy2/drpyS 社区常用全局，实测三种原型。✅=可用且测试通过，⚠️=部分可用或有边界，❌=不可用。

### 3.1 drpy 核心方法契约（五方法 + 周边）

| 方法 | 入参 | 返回契约 | Node Worker | QuickJS 扩展 | 外部服务 |
|---|---|---|---|---|---|
| `init(ext)` | 字符串或 `{skey,stype,ext}` | void | ✅ | ✅ | ✅（REST 白名单） |
| `home(filter)` | bool | `{class[], filters{}}` | ✅ | ✅ | ✅ |
| `homeVod()` | — | `{list[]}` | ✅ | ✅ | ✅ |
| `category(tid,pg,filter,extend)` | string,string,bool,obj | `{list[],page,pagecount,limit,total}` | ✅ | ✅ | ✅ |
| `search(wd,quick,pg)` | string,bool,string | `{list[]}` | ✅ | ✅ | ✅ |
| `detail(id)` | string | `{list[{vod_*}]}` | ✅ | ✅ | ✅ |
| `play(flag,id,vipFlags)` | string,string,array | `{parse,url,header}` | ✅ | ✅ | ✅ |
| `proxy(param)` | obj | `[code,mime,body,headers]` | ✅（RPC） | ✅ | ⚠️（base64 传输还原） |
| `live(url)` / `action(a)` / `destroy()` | — | — | ✅ | ✅ | ✅ |

### 3.2 宿主全局对象/方法

| 全局 | 说明 | Node Worker | QuickJS 扩展 | 外部服务 |
|---|---|---|---|---|
| `req` / `request` | 同步 HTTP（drpy 默认同步语义） | ✅ 子进程转发 | ✅ Python 原生回调 | ✅ 服务端代执行 |
| `post` | 同步 POST | ✅ | ✅ | ✅ |
| `fetch` | 异步 HTTP（drpyS 常用） | ✅ 原生 fetch | ⚠️ Promise 泵 + 回调桥 | ✅ |
| `pdfa` / `pdfh` / `pdft` / `pd` | DOM 选择器 | ✅ cheerio | ✅ cat.js 兼容层 | ✅ |
| `cheerio` / `$` | 完整 cheerio | ✅ npm 包 | ⚠️ cat.js 子集 | ✅ |
| `CryptoJS` | 加解密全家桶 | ✅ npm 包（完整） | ⚠️ cat.js 内嵌实现 | ✅ |
| `dayjs` | 时间库 | ✅ npm 包 | ✅ cat.js | ✅ |
| `local.get/set/delete` | KV 存储 | ✅ 内存 Map（进程级） | ✅ 站点 key 隔离 + 大小配额 | ✅ 服务端进程内 |
| `joinUrl` | URL 拼接 | ✅ | ✅ | ✅ |
| `setTimeout/clearTimeout` | 定时器 | ✅ Node 原生 | ⚠️ 受限（无事件循环，需宿主泵） | ✅ |
| `console.*` | 日志 | ✅ stderr 转发 | ✅ | ✅ |
| `atob/btoa`, `Buffer`, `TextEncoder` | 编码 | ✅ | ⚠️ 部分 | ✅ |
| `process.env` 等 Node 专属 | — | ❌ 白名单空对象（安全） | ❌ 无 | ❌ 无 |
| `require('child_process')` | 子进程 | ❌ 明确禁止 | ❌ 不存在 | ❌ 不存在 |
| `fs` | 文件系统 | ⚠️ 仅 Worker 专属临时目录 | ❌ 不存在 | ❌ 不存在 |

### 3.3 关键差异结论

- **同步语义**：drpy 传统规则大量使用同步 `req()` 返回值，Node Worker 与 QuickJS 扩展
  都提供同步调用；Node 侧经 `execFileSync` 转发子进程（每请求一个 HTTP 子进程，隔离强、
  开销约数 ms），QuickJS 侧直接 Python 回调（最快但需注意 GIL 与超时中断交互）。
- **异步规则（drpyS 风格）**：Node Worker 天然支持 async/await + 原生 fetch；
  QuickJS-ng 无事件循环，需宿主 `execute_pending_job()` 泵微任务，复杂 Promise 链与
  真实定时器语义是主要边界（Spike 已验证两段 await 可解析，但嵌套定时器/多 promise
  竞态需要更多宿主补丁）。
- **`eval`/`new Function` 动态代码**：三方案均允许（drpy 模板规则必需），但只有
  进程级隔离的 Node Worker 能把动态代码的破坏力限制在可杀死进程内。

## 4. 三方案对比

| 维度 | 方案1 独立 Node Worker | 方案2 扩展 QuickJS | 方案3 外部 drpy 服务 |
|---|---|---|---|
| **兼容度** | ★★★★★ 真实 Node 环境，drpy/drpyS 主流通吃，async/await、原生 fetch、npm 生态 | ★★★☆☆ 同步规则基本可跑；异步规则需宿主泵与大量补丁；ES2020+ 语法与 Promise 竞态有边界 | ★★★★★ 服务端可用任意引擎，兼容度取决于服务端实现 |
| **安全性** | ★★★★☆ 进程级隔离 + vm 沙箱 + 受控 fs + 禁子进程；超时可 SIGKILL 强杀 | ★★★☆☆ 无文件/进程能力（天然），但同进程内 GIL 下死循环需靠引擎中断钩子；内存限制在进程内拦截 | ★★★☆☆ 网络面隔离，但服务可被任意调用（需鉴权）；杀不死服务内死循环（依赖服务端实现） |
| **打包体积** | ★★★☆☆ node_modules 仅 7.2MB（cheerio+crypto-js+dayjs）；但需随应用带 Node 运行时（约 70–90MB）或复用 Electron 自带 Node | ★★★★★ 无新增运行时依赖，`_quickjs.pyd` 已随 venv | ★★★☆☆ 服务端需独立部署（Node/Python 环境 + 端口），单地址体验被破坏 |
| **维护成本** | ★★★☆☆ 需要维护进程生命周期、IPC 协议、崩溃重启；但环境即 Node，规则行为可预测 | ★★★☆☆ 需要持续给 QuickJS 补 Node/DOM 能力（cheerio 子集、Promise 泵、定时器），工作量大且碎片化 | ★★★★☆ 服务端可独立演进；但升级/分发/端口冲突/看门狗都要自己管，且违反「单地址体验」 |
| **超时/取消** | ✅ 进程级 kill，干净利落 | ⚠️ 引擎级中断，Python 回调与 time_limit 有互斥（见 §6.3） | ⚠️ 依赖服务端实现 |
| **内存限制** | ✅ 轮询 rss/堆，超限 kill | ⚠️ `set_memory_limit` 进程内拦截（存在检测粒度问题，见 §6.4） | ⚠️ 依赖服务端 |

### 实测数据摘要

- **Node Worker**（`prototypes/node_worker/`，Node v24）：4 规则 × 五方法全部 PASS；
  child_process 与任意文件访问被拒；1.5s 超时强杀生效；50MB 内存限制触发（轮询
  检测存在粒度延迟，峰值到 1.7GB 才被拦，见 §6.4）。
- **QuickJS 扩展**（`prototypes/quickjs_ext/`，venv quickjs-ng）：13 项单元测试全 OK，
  含全局注入、选择器、CryptoJS、joinUrl、local 隔离、time_limit 中断死循环、
  memory_limit 拦截、Promise 泵、同步/异步 req、4 规则 e2e。
- **外部服务**（`prototypes/external_service/`）：契约/保活/开销/端口四组全 PASS；
  单次 loopback 调用网络+序列化开销 ≈ 2.5ms；冷连接 5.3ms vs 稳态 2.7ms；
  端口冲突干净失败；Bearer 鉴权生效；看门狗自动重启（pid 变化）且适配器无感恢复。

## 5. 五方法实测（home/category/search/detail/player）

三个原型均以标准 `Spider` 接口适配器输出统一 dict（`NodeWorkerSpider`、
`QuickJsDrpySpider`、`ExternalDrpySpider`，均继承 `base/spider.py::Spider`）：

| 场景 | Node Worker | QuickJS 扩展 | 外部服务 |
|---|---|---|---|
| `homeContent` | ✅ class=2~3, list>0 | ✅ | ✅ |
| `categoryContent` | ✅ page=1, list>0 | ✅ | ✅ |
| `detailContent` | ✅ vod_play_url 完整 | ✅ | ✅ |
| `searchContent` | ✅ list>0（签名校验通过） | ✅ | ✅ |
| `playerContent` | ✅ url+header（AES 解密路径） | ✅ | ✅ |

复现命令：

```powershell
python-backend\.venv\Scripts\python.exe python-backend\spike\prototypes\node_worker\test_node_worker.py
python-backend\.venv\Scripts\python.exe python-backend\spike\prototypes\quickjs_ext\test_quickjs_drpy.py
python-backend\.venv\Scripts\python.exe python-backend\spike\prototypes\external_service\run_proto.py
```

## 6. 安全与鲁棒性测试结果

### 6.1 无限循环（CPU 占用）
- Node Worker：规则内 `while` 死循环 → 调用 1.5s 超时 → Supervisor `kill()` 强杀，
  进程不再存活。✅
- QuickJS：`set_time_limit(1.0)` 后 `while(true){}` → 引擎抛 `interrupted`，宿主不冻结，
  2.5s 内返回。✅

### 6.2 文件访问
- Node Worker：`require('fs').readFileSync('C:\\Windows\\...\\hosts')` → 被 `ensureSafePath`
  拒绝（`Access denied: ... outside the allowed sandbox directory`），规则只能读写
  Worker 专属 `mkdtemp` 临时目录。✅
- QuickJS / 外部服务：无 `fs` 全局，天然不可达。✅

### 6.3 子进程
- Node Worker：`require('child_process')` → `[SecurityError] Module "child_process" is not
  allowed in sandbox`。✅（注意：Worker 自身内部 `sync_http.cjs` 转发子进程是宿主实现，
  规则不可达；`req()` 网络目标仍受宿主网络策略约束——这是 N3.5 统一数据面的工作）
- QuickJS / 外部服务：无 `child_process`。✅

### 6.4 内存限制
- Node Worker：`max_memory_mb` 轮询 rss，超限 kill + `NodeWorkerMemoryLimitError`。✅
  **已知风险**：轮询粒度（调用返回后检查）导致一次性大分配可瞬时冲到远超阈值
  （实测 50MB 限制下峰值 1.7GB 才被拦）；生产应改为独立监控线程高频采样 + Node
  `--max-old-space-size` 硬限制兜底。
- QuickJS：`set_memory_limit` 进程内拦截大数组分配。✅ **已知风险**：cat.js 引导本身
  需要约 20–30MB 堆，配额过小会导致引导失败；限制粒度受引擎实现影响。

### 6.5 取消/进程回收
- 三个原型的 `destroy()` 均回收子进程/服务（外部服务原型验证无孤儿进程）。
- Node Worker 超时/内存杀后 `is_alive()==False`，Supervisor 可重启。

## 7. 能力矩阵结论 → ADR

- **兼容度**：Node Worker > 外部服务 > QuickJS（同步规则 QuickJS 可用，异步规则边界多）。
- **安全性**：Node Worker 的进程级 kill 是唯一能对「任意动态代码」给出硬保证的方案；
  QuickJS 引擎级中断对纯 JS 死循环有效，但 Python 回调与 time_limit 互斥（
  `Can not call into Python with a time limit set`），需要宿主在回调段临时解限——这是
  生产实现必须处理的细节。
- **打包体积**：QuickJS 最优（0 新增依赖）；Node Worker 需解决 Node 运行时分发
  （约 70–90MB，或复用 Electron 内置 Node/utilityProcess）。
- **维护成本**：Node Worker 生态即真实 drpy 环境，长期成本最低；QuickJS 需要持续
  补 Node/DOM 语义，成本高且碎片化。

**推荐：方案1 独立 Node Worker（Supervisor 管理），与任务书默认建议一致。**
详细决策见 `docs/ADR-0001-drpy-runtime.md`。

## 8. 本阶段未完成/移交事项（不属 Spike 范围）

1. N3.1 完整运行时：Node 运行时打包与分发（满足「打包后无需用户另装 Node」）、
   宿主网络白名单 API（代理/缓存/策略）、Worker 池与配额调度、统一 SpiderResult 接入
   `runner.py`。
2. N3.2：QuickJS 宿主契约补齐（作为兼容层/降级路径的研究延续）。
3. N3.5：统一 `/proxy` 数据面接入 drpy 的 `proxy()`。
4. `capability_router.py` 中 drpy 仍为 `C0/unsupported` 的升级（N3.1 实现完成后改判）。
