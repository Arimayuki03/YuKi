# ADR-0001：drpy 运行时方案选择（N3.1 可行性 Spike 决策）

- 状态：**已接受**（Spike 阶段决策，随 N3.1 完整实现推进可修订）
- 日期：2026-08
- 关联：`docs/TVBOX_FONGMI_PARITY_TASKS.md` §9 N3.1；`docs/DRPY_SPIKE_REPORT.md`
- 上游参考（未修改）：`TV-fongmi/quickjs/src/main/java/com/fongmi/quickjs/crawler/Spider.java`、
  `TV-fongmi/quickjs/src/main/assets/js/lib/`

## 背景

drpy 规则依赖 `pdfa/pdfh/pdft/pd`、同步 `req()`、`local` KV、CryptoJS 等宿主全局，
与 CatVod QuickJS 契约不是同一运行时。当前 `capability_router.py` 将 drpy 独立归类为
`R3-drpy` / C0 / `L2_SITE_UNSUPPORTED`，不尝试任何运行时。N3.1 要求先做可行性 Spike，
比较三种候选方案后再实现。

## 决策

**采用方案 1：受 Supervisor 管理的独立 Node Worker 进程，作为 drpy 唯一正式运行时。**

1. 远程规则**禁止**在 Electron renderer 或主进程直接执行；禁止在 Python 后端进程内
   直接执行（QuickJS 仅作为研究中的降级路径，不承担 drpy 正式运行）。
2. Worker 通过 stdio JSON-RPC 2.0 与 Supervisor 通信；每个站点一个 Worker（生命周期
   与站点配置绑定），超时/内存超限由 Supervisor 强杀并重启。
3. 宿主能力全部经白名单注入：网络（`req/request/post/fetch`）、解析（`pdfa/pdfh/pdft/pd`、
   cheerio）、加解密（CryptoJS）、时间（dayjs）、`local` KV（按 siteKey 隔离 + 大小配额）。
4. 安全边界（Spike 已实测）：
   - 子进程：沙箱内 `child_process` 不可达，`require` 白名单只放行受控模块；
   - 文件系统：`fs` 仅允许 Worker 专属 `mkdtemp` 临时目录（路径前缀校验）；
   - 动态代码：`eval`/`new Function` 允许（drpy 模板规则必需），破坏力被进程级隔离
     限制在可杀死进程内；
   - 超时/内存：进程级 `kill()`，`NodeWorkerTimeoutError` / `NodeWorkerMemoryLimitError`
     对上层呈现结构化错误。
5. 统一输出：`NodeWorkerSpider` 实现 `base/spider.py::Spider`，返回标准 dict（
   `{class,list,page,pagecount,total}` / `{list:[vod_*]}` / `{parse,url,header}`），
   与现有 Runner 契约一致。

## 备选方案与否决理由

| 方案 | 结论 | 理由 |
|---|---|---|
| 方案2 扩展 QuickJS | **降级路径，不作为正式运行时** | 同步规则兼容良好、零新增依赖（Spike 13 项测试全 OK）；但异步规则（drpyS 风格 async/await/fetch）缺事件循环，需宿主泵微任务与大量补丁；`time_limit` 与 Python 回调互斥（`Can not call into Python with a time limit set`）；内存限制粒度受引擎影响。长期维护成本高于 Node Worker。 |
| 方案3 外部 drpy 服务 | **否决** | 网络+序列化开销实测仅 ~2.5ms/调用（loopback），但需要用户独立部署服务端（Node/Python 环境 + 端口 + 鉴权 + 看门狗），破坏任务书「单地址体验」，且规则执行点脱离统一 `/proxy` 数据面。仅适合专业用户自建。 |

## 已知风险与缓解（N3.1 完整实现阶段处理）

1. **Node 运行时打包（验收项「打包后无需用户另装 Node」）**：Worker 依赖 Node 二进制。
   缓解选项（按优先级）：
   a. 随安装包分发 Node 单文件（Windows node.exe 约 70–90MB）并校验版本；
   b. 复用 Electron 自带 Node（`utilityProcess` 或独立 fork 的纯 Node 模式），
      但需重新设计进程拓扑（drpy Worker 由 Electron 主进程管理还是 Python 后端管理），
      与「Python 后端统一调度」架构冲突，需架构评审；
   c. 仅对缺失 Node 的机器回退 QuickJS 兼容层（能力降级，站点标记 C1→C0 并明示）。
   决策时以「安装体积 vs 架构一致性 vs 兼容度」权衡，倾向 a，保留 c 为降级路径。
2. **内存限制粒度**：当前为调用返回后轮询 rss，一次性大分配可瞬时超阈值。
   缓解：独立监控线程高频采样 + Node `--max-old-space-size` 硬限制兜底 +
   分配触发式检查（RPC 前/后 + 定时）。
3. **同步请求实现**：Spike 用 `execFileSync` 转发 `sync_http.cjs` 子进程（隔离强但每请求
   一进程）。生产改为：Worker 内 `child_process.fork` 常驻 HTTP 代理子进程（stdio 帧协议）
   或 worker 内直接受控 `undici` 同步化封装，并挂接宿主代理/缓存/超时策略（N3.5）。
4. **`local` KV 语义**：Node 原型为进程内存 Map（随 Worker 生命周期）；FongMi 语义是
   持久化（SharedPreferences）。生产需落盘到站点隔离目录并限制大小，与 QuickJS 侧
   `js_local.json` 实现对齐。
5. **vm 沙箱逃逸面**：`vm.createContext` 非强安全边界。缓解：不向沙箱暴露真实
   `process`/`require`/`globalThis.constructor` 可达的宿主对象；以进程级隔离作为最终
   防线（沙箱被突破也只能破坏该 Worker 进程内状态，无法出进程）。Spike 已实测
   child_process 与 fs 越界均被拦截。
6. **drpy 识别**：继续沿用 `capability_router.py::is_drpy` 标记（`drpy/dr_py/drpys`），
   N3.1 完整实现后把 `WORKERS['drpy']` 从 `''` 改为 `'node-drpy'`、兼容级 C0→C1，
   并补充诊断信号。

## 决策影响

- `python-backend/js_spider.py` / `quickjs_host.py`：不承担 drpy 运行，保持现状；
  缺失全局的诊断（N3.2）继续生效。
- `python-backend/base/spider.py`：新增 `NodeWorkerSpider` 子类即可，接口不变。
- 打包/安装：新增 Node 运行时分发（见风险 1），安装体积增加。
- 安全模型：drpy 规则执行点从「无」变为「受控 Node Worker」，纳入现有 Worker
  生命周期/超时/取消/熔断体系。
