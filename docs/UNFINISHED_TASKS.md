# 当前未完成任务清单

> 更新时间：2026-08-17
>
> 说明：本文是跨文档汇总入口，只收录当前仍未完成、仍需验收或仍需复核的事项。项目级状态仍以 [PROGRESS.md](../PROGRESS.md) 为准，专项细节仍以各自计划为准。

## 项目级待办

| 任务 | 当前状态 | 来源 |
|---|---|---|
| TVBox 兼容性 Phase A–F | 仍在推进，包含兼容套件、端口泛化、夸克降级、FongMi 契约审计、分层诊断 | [PROGRESS.md](../PROGRESS.md), [TVBOX_COMPAT_PLAN_REMAINING.md](TVBOX_COMPAT_PLAN_REMAINING.md) |
| macOS/Linux 实际打包与运行测试 | 未完成 | [PROGRESS.md](../PROGRESS.md) |
| Windows 安装后首次冷启动验证、打包后资源、离线/慢网和多窗口尺寸实测 | 未完成 | [PROGRESS.md](../PROGRESS.md) |
| 自动更新（`electron-updater`） | 未接入 | [PROGRESS.md](../PROGRESS.md) |
| 代码签名与 CI/CD | 待发布流程确定后补齐 | [PROGRESS.md](../PROGRESS.md) |

## TVBox 兼容性剩余项

| 任务 | 当前状态 | 来源 |
|---|---|---|
| 21 仓全量跑通、产出基线、敏感性验证 | 未达成 | [TVBOX_COMPAT_PLAN_REMAINING.md](TVBOX_COMPAT_PLAN_REMAINING.md) |
| 报告包含 skipped 原因分布，供后续诊断复用 | 未完成 | [TVBOX_COMPAT_PLAN_REMAINING.md](TVBOX_COMPAT_PLAN_REMAINING.md) |
| 7777 行为级验证、保护端口、真实 jar 扫描与上限测试 | 代码已在，验收未完成 | [TVBOX_COMPAT_PLAN_REMAINING.md](TVBOX_COMPAT_PLAN_REMAINING.md) |
| `pan_fast_path` 开关与夸克降级行为验证 | 代码已在，验收未完成 | [TVBOX_COMPAT_PLAN_REMAINING.md](TVBOX_COMPAT_PLAN_REMAINING.md) |
| `docs/TVBOX_CONTRACT_GAPS.md` 落盘并拆出高影响项 | 未开始 | [TVBOX_COMPAT_PLAN_REMAINING.md](TVBOX_COMPAT_PLAN_REMAINING.md) |
| L1-L4 分层诊断、QuickJS 全局警告、前端摘要展示 | 部分完成 | [TVBOX_COMPAT_PLAN_REMAINING.md](TVBOX_COMPAT_PLAN_REMAINING.md) |
| `npm run test:all` + `npm run test:compat` 全绿 | `test:all` 可绿，`test:compat` 未跑通 | [TVBOX_COMPAT_PLAN_REMAINING.md](TVBOX_COMPAT_PLAN_REMAINING.md) |

## 工程化与发布类待办

| 任务 | 当前状态 | 来源 |
|---|---|---|
| 重新扫码后新 Cookie 只写入数据目录，仓库根不再新生成目录 | 待下次启动网盘源后复核 | [IMPROVEMENT_PLAN.md](../IMPROVEMENT_PLAN.md) |
| `npm start` 正常启动 | 待下次启动复核 | [IMPROVEMENT_PLAN.md](../IMPROVEMENT_PLAN.md) |
| `scripts/build-python.js` 按锁文件安装 | 仍待确认是否改造 | [IMPROVEMENT_PLAN.md](../IMPROVEMENT_PLAN.md) |
| 全新 venv 按锁文件安装后 `npm run test:py` 通过 | 仍需在全新环境复核 | [IMPROVEMENT_PLAN.md](../IMPROVEMENT_PLAN.md) |
| push 后 Actions 两个 job 全绿、故意引入语法错误时 CI 能红 | 尚需真实推送/破坏验证 | [IMPROVEMENT_PLAN.md](../IMPROVEMENT_PLAN.md) |
| `docs/ARCHITECTURE.md` 增加冷启动耗时表并落地至少一个优化 | 未完成 | [IMPROVEMENT_PLAN.md](../IMPROVEMENT_PLAN.md) |
| 渲染层外部调用统一走 `VPC.<module>.<fn>`、页面无 console 报错、`kazumi.js` 去掉两处 onerror 内联 JS | 未完成 | [IMPROVEMENT_PLAN.md](../IMPROVEMENT_PLAN.md) |
| `src/main/index.js` 拆分到 < 600 行且不再堆积 `ipcMain.handle` | 未完成 | [IMPROVEMENT_PLAN.md](../IMPROVEMENT_PLAN.md) |
| `docs/DATA_MAP.md`、渲染层 `localStorage` 范围、M-30 竞态场景复测 | 未完成 | [IMPROVEMENT_PLAN.md](../IMPROVEMENT_PLAN.md) |
| 测试内复制源码逻辑的用例改为真实模块引用，`acceptance-*.js` 选入 CI 冒烟 | 未完成 | [IMPROVEMENT_PLAN.md](../IMPROVEMENT_PLAN.md) |

## 实机复测与手动验证

| 任务 | 当前状态 | 来源 |
|---|---|---|
| Kazumi Cookie 持久化用例在普通本机环境复跑 | 受管环境下写临时目录失败，需普通机器复核 | [KAZUMI_INTEGRATION.md](KAZUMI_INTEGRATION.md) |
| 现有配置重新载入、Kazumi 规则导入、直播源导入、首页站点列表、搜索、详情页播放、mpv、历史、收藏 | 仍在手动验证清单中 | [test-repos.md](../test-repos.md) |
| 配置导入速度、多仓扫描时间、播放启动速度 | 仍在手动验证清单中 | [test-repos.md](../test-repos.md) |

## 说明

- 如果这份清单与 [PROGRESS.md](../PROGRESS.md) 冲突，以 [PROGRESS.md](../PROGRESS.md) 为准。
- 已完成并收口的专项结论，不在这里重复。
- `docs/TVBOX_COMPAT_PLAN_COMPLETED.md` 已删除，TVBox 当前只看这份汇总和 `TVBOX_COMPAT_PLAN_REMAINING.md`。
