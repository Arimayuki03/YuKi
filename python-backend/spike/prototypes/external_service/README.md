# 方案3【外部 drpy 服务】原型

> 在 Python 后端之外运行一个独立的 drpy 专有服务（单 TCP 端口、HTTP REST），
> 后端通过 `ExternalDrpySpider` 适配器以 base `Spider` 接口调用并返回标准 dict。
> 对应 `docs/TVBOX_FONGMI_PARITY_TASKS.md` N3.1 中「外部 drpy 服务」方案（vs
> 方案1 独立 Node Worker、方案2 扩展 QuickJS）。

## 目录

| 文件 | 作用 |
|---|---|
| `drpy_service.py` | 独立的外部 drpy 服务进程（stdlib http.server，可 `--port 0` 自动分配端口；内置 3 条模拟 drpy 规则 + `--rule-dir` 扩展 + `--latency-ms` 耗时模拟 + `--token` Bearer 鉴权） |
| `external_service_spider.py` | Python 后端客户端适配器：`DrpyServiceClient`（keep-alive 传输）+ `ExternalDrpySpider`（base Spider 接口）+ `ManagedDrpyService`（进程保活原型） |
| `run_proto.py` | 端到端实测 + 评测驱动（A 契约 / B 保活 / C 开销 / D 部署风险），`ALL PASS` 退出码 0 |
| `README.md` | 本评测报告 |

## 架构

```
┌─────────────────────────── Python 后端 ───────────────────────────┐
│  base.Spider 接口约定                                              │
│  ExternalDrpySpider (适配器, 返回标准 dict)                        │
│    ├─ DrpyServiceClient   keep-alive HTTP (requests.Session)      │
│    └─ ManagedDrpyService  拉起/看门狗/退避重启 子进程              │
└───────────────┬───────────────────────────────────────────────────┘
                │ HTTP REST / JSON（单 TCP 端口，可本地可远程）
┌───────────────▼───────────────────────────────────────────────────┐
│  外部 drpy 服务进程 (drpy_service.py)                              │
│  GET /api/v1/ping | /rules | /rules/{rule} | /stats                │
│  POST /api/v1/invoke  {rule, method, args, kwargs} -> {ok, data}   │
│  方法白名单 == base Spider 接口（init/homeContent/.../playerContent）│
│  [生产形态：进程内跑真实 drpy JS 运行时，协议与适配器不变]          │
└────────────────────────────────────────────────────────────────────┘
```

## REST 契约

| 方法/路径 | 请求体 | 响应 |
|---|---|---|
| `GET /api/v1/ping` | – | `{ok, service, version, pid, uptime, rules}` |
| `GET /api/v1/rules` | – | `{ok, rules: [{rule, name, methods, payload_kb}]}` |
| `POST /api/v1/invoke` | `{rule, method, args, kwargs}` | `{ok, code, data}`；错误 `{ok:false, code, error}`（400/401/404/500） |
| `GET /api/v1/stats` | – | 服务端命中/响应字节/处理耗时累计 |

安全边界：可调用方法白名单与 `base/spider.py` 接口一一对应，外部调用方无法触达
服务端任意代码；`--token` 开启 Bearer 鉴权。

## 快速开始（全部在 `python-backend/` 目录下）

```powershell
# 1) 一键评测（自动拉起服务，A/B/C/D 四段，ALL PASS 退出码 0）
.\.venv\Scripts\python.exe -X utf8 spike\prototypes\external_service\run_proto.py

# 2) 手动部署固定端口 + 后端直连（生产形态）
.\.venv\Scripts\python.exe -X utf8 spike\prototypes\external_service\drpy_service.py --port 9810 --token mytoken
.\.venv\Scripts\python.exe -X utf8 -c "import sys; sys.path.insert(0, 'spike/prototypes/external_service'); from external_service_spider import ExternalDrpySpider; s = ExternalDrpySpider(base_url='http://127.0.0.1:9810', rule='demo_stateful', token='mytoken'); s.init(''); print(s.homeContent(False)['class']); s.destroy()"

# 3) 零配置接入（适配器自动拉起并保活独立服务进程，destroy() 时回收）
.\.venv\Scripts\python.exe -X utf8 spike\prototypes\external_service\external_service_spider.py
```

`ExternalDrpySpider` 实现 base `Spider` 全部接口：`init / homeContent / homeVideoContent /
categoryContent / detailContent / searchContent / playerContent / liveContent /
localProxy / action / isVideoFormat / manualVideoCheck / getName / getDependence /
destroy`，均返回标准 dict（`localProxy` 的 bytes 以 base64 承载还原）。

## 评测结果（2026-08-18，Python 3.14.4，本机 loopback 实测）

### A. 契约实测 —— PASS

五方法 + 辅助方法全部返回标准 dict：`homeContent` 返回 `{class,list,filters}`、
`detailContent` 返回 `vod_play_from/vod_play_url`（3 线 × 24 集）、`searchContent`
返回 8 条、`playerContent` 返回 `{url,parse,header}`；客户端统计 `calls=15 errors=0`。

### B. 进程保活机制 —— PASS（详见 `ManagedDrpyService`）

| 环节 | 实测 |
|---|---|
| 启动 | 子进程拉起 → 就绪行 `DRPY_SERVICE_READY url=...` → 健康检查通过 |
| 看门狗 | 后台线程每 1s `/ping`；进程死亡或连续 3 次健康失败触发重启 |
| 故障恢复 | `kill_for_test()` 杀死子进程 → 2s 退避后重启（`restart_count=1`，pid 变化）→ **适配器经 `on_restart` 回调自动重建连接，无需人工干预即可继续调用** |
| 有状态规则 | 外部服务重启后会话态随进程重建（`demo_stateful` 播放链接再次可用） |
| 清理 | `destroy()` 回收子进程；`atexit` 兜底，实测无孤儿进程 |

结论：保活机制有效，但「服务端内存会话态在进程重启后丢失」是外部服务的固有
代价 —— 与方案1（Node Worker 同样由 Supervisor 重启）一致；有状态站点需要
服务端做会话持久化或容忍重新登录。

### C. 网络开销 —— PASS（关键评测）

| 场景 | 冷连接 | 稳态 avg | p95 | 服务端计算 | 传输+序列化净开销 | bytes/调用 |
|---|---|---|---|---|---|---|
| `homeContent`（0ms 模拟延迟） | ~5.4 ms | ~2.8 ms | ~3.5 ms | ~0.02 ms | ~2.8 ms（≈99%） | 2035 B |
| `detailContent`（0ms） | – | ~2.9 ms | ~3.4 ms | ~0.02 ms | ~2.9 ms（≈99%） | 4113 B |
| `homeContent`（8ms 模拟规则耗时） | – | ~11.8 ms | – | ~8.4 ms | ~3.4 ms（≈29%） | 2035 B |

- **冷连接 vs 稳态**：新建 TCP 连接首调用约 5.4 ms（含解释器启动抖动时可到 24 ms），
  keep-alive 稳态约 2.8 ms —— 必须用 `requests.Session` 连接复用，实测收益约 2 倍。
- **传输 vs 计算**：规则计算极快时（0ms），传输+序列化占 99%；加入 8ms 模拟规则
  耗时后占比摊薄到约 29%。**真实 drpy 规则（DOM 解析/网络上游）通常远超 8ms，
  网络开销会被进一步稀释** —— 这是「外部服务」方案最大的可行性依据。
- **payload 大小**：307 B vs 4113 B 的响应差异在 loopback 上仅带来约 0.1–0.2 ms
  延迟差，本地部署几乎无感；远程部署时 payload 大小才值得关注（建议 detail 响应
  保持单次调用语义，不做额外合并）。

### D. 部署与端口占用风险 —— PASS（含一个真实缺陷的发现与修复）

| 风险 | 实测与处置 |
|---|---|
| 端口冲突 | `--port 0` 自动分配：两个实例实测拿到不同端口（如 6227/6228），互不影响；固定端口被占用时第二实例退出码 2 并给出可执行提示（`换 --port 或 --port 0 自动分配`），第一实例不受影响 |
| **Windows SO_REUSEADDR 陷阱** | 实测发现 `http.server` 默认 `allow_reuse_address=True`，在 Windows 上语义不同，**第二实例可静默绑定同一端口**。已在 `build_server()` 增加「不设 SO_REUSEADDR 的独占探测」，跨平台行为一致 |
| **keep-alive 下 401 未排空请求体** | 实测发现鉴权失败直接返回而未消费请求体，同一连接上的下一条请求被残留 body 污染（`Bad request syntax`）。已修复为先排空 body 再响应，并加入回归用例（同连接连续 2 次 401 均正确拒绝） |
| 端口裸露 | `--token` Bearer 鉴权实测：无 token 调用返回 401，携带 token 正常；生产建议 token + 仅监听 127.0.0.1（或防火墙白名单）+ 端口由配置中心管理 |
| 孤儿进程 | `destroy()`/`atexit` 双保险，实测子进程全部回收 |

## 结论与建议

1. **可行**：外部服务 + 统一适配器是三者中接入最快、隔离最彻底的方案；REST 契约
   已固化，将来把服务端模拟规则换成真实 drpy JS 运行时（Node Worker / QuickJS），
   后端适配器零改动。
2. **取舍**：方案3 的代价是「用户需另部署一个常驻服务进程」—— 与 N3.1 任务书
   「不符合单地址体验」的判断一致。若最终目标是单机双进程（后端自动托管子进程，
   如本原型的 `ManagedDrpyService`），体验与方案1 相近，但多一层 TCP 传输；
   若目标是跨机器/容器化部署，方案3 反而是最自然的形态。
3. **推荐路径**：以方案1（Supervisor 管理的 Node Worker）为最终形态时，本原型的
   REST 契约、保活看门狗、端口探测与鉴权实践可直接复用；若采用方案3，生产要点为：
   - 服务端嵌入真实 drpy 规则运行时，白名单接口保持不变；
   - 会话态持久化（Redis/磁盘）以消除重启丢会话；
   - 固定端口 + 配置中心登记 + token/防火墙，避免端口冲突与裸奔；
   - 保活看门狗纳入现有 Supervisor，与 JAR/JS Worker 统一生命周期。

## 复现

```powershell
cd python-backend
.\.venv\Scripts\python.exe -X utf8 spike\prototypes\external_service\run_proto.py   # 期望 ALL PASS
.\.venv\Scripts\python.exe -m ruff check spike\prototypes\external_service\          # 期望 All checks passed
```
