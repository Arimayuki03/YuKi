# 文档索引

这里维护影视 PC 的当前实现、专项设计、运行问题、测试结果和历史记录。Kazumi Flutter 原版以及 `TV-fongmi/` 目录中的文档属于对照资料，不是本项目的开发入口。

## 推荐阅读顺序

1. [项目 README](../README.md)：项目用途、快速开始和总入口。
2. [当前开发状态](../PROGRESS.md)：当前完成范围、边界、约束和下一步。
3. [系统架构](ARCHITECTURE.md)：进程模型、双引擎、播放、下载和数据流。
4. 根据具体任务进入专项文档或执行计划。

## 核心维护文档

| 文档 | 用途 | 维护方式 |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前系统架构、接口契约和安全边界 | 架构变化时更新 |
| [KAZUMI_INTEGRATION.md](KAZUMI_INTEGRATION.md) | Kazumi 规则系统的数据模型、接口和实现 | 实现变化时更新 |
| [KAZUMI_GAP_ANALYSIS.md](KAZUMI_GAP_ANALYSIS.md) | 与 Kazumi 原版的功能差距和产品取舍 | 对比结论变化时更新 |
| [RUNTIME_ISSUES.md](RUNTIME_ISSUES.md) | 运行异常、日志证据、修复和复测状态 | 按问题追加并更新结论 |
| [TEST_REPORT.md](TEST_REPORT.md) | 自动化测试、界面验收和用户实测清单 | 测试结果变化时更新 |
| [DEVELOPMENT_HISTORY.md](DEVELOPMENT_HISTORY.md) | Phase、U/T 批次、历史决策和踩坑记录 | 只追加或勘误 |

## 审查、计划与兼容性文档

这些文档位于根目录或专项位置，属于执行资料；它们不能替代 `PROGRESS.md` 的当前状态快照。

| 文档 | 用途 | 使用建议 |
|---|---|---|
| [代码审查报告](../CODE_REVIEW.md) | 安全问题、缺陷和审查基线 | 追溯问题来源 |
| [代码审查修复任务清单](../CODE_REVIEW_FIX_TASKS.md) | 修复步骤、工作流和验收记录 | 执行或复核修复 |
| [改进优化任务清单](../IMPROVEMENT_PLAN.md) | 测试、工程化、性能和发布待办 | 规划后续工作 |
| [TVBox 兼容性计划](TVBOX_COMPAT_PLAN.md) | 兼容性收敛方案和任务拆分 | 兼容性开发入口 |
| [当前未完成任务清单](UNFINISHED_TASKS.md) | 跨文档汇总当前仍开放的事项 | 先看这一份 |
| [TVBox 剩余工作计划](TVBOX_COMPAT_PLAN_REMAINING.md) | 未完成项、验收要求和执行顺序 | 当前继续开发入口 |
| [兼容性测试仓库清单](../test-repos.md) | 兼容性测试语料和手动测试步骤 | 执行兼容性测试 |

## 文档状态优先级

不同文档出现冲突时，按以下顺序判断：

1. `RUNTIME_ISSUES.md` 中带时间和证据的最新运行结论。
2. 根目录 `PROGRESS.md` 中的当前范围、边界和待办。
3. `ARCHITECTURE.md` 及 Kazumi 专项文档中的现行设计。
4. 对应任务计划中的执行状态和验收记录。
5. `DEVELOPMENT_HISTORY.md` 中的历史记录。
6. 上游项目或对照仓库中的说明。

“Kazumi 整合完成”只表示影视 PC 已完成既定接入范围，不代表与 Flutter 原版功能完全一致。

## 维护规则

- 当前状态只写入 `PROGRESS.md`，不要在历史文档中复制第二份总待办。
- 运行故障只在 `RUNTIME_ISSUES.md` 维护详细日志、根因和复测结论。
- 架构、接口或数据目录变化先更新 `ARCHITECTURE.md`，再改代码。
- Kazumi schema、端点或解析流程变化同步更新 `KAZUMI_INTEGRATION.md`。
- 与上游的功能差距变化时更新 `KAZUMI_GAP_ANALYSIS.md`。
- 已完成批次和重要历史原因写入 `DEVELOPMENT_HISTORY.md`，避免把流水账塞回 `PROGRESS.md`。
- 计划文档保留“目标、当前状态、剩余验收项”三部分；完成后标明完成日期，并链接到测试证据。
- 新增长期维护文档优先放入 `docs/`；根目录只保留项目入口、当前状态和需要显眼访问的执行计划。
- 使用稳定标题和相对链接，避免依赖会漂移的源码行号。

## 不纳入项目文档索引的 Markdown

- `node_modules/`、Python 虚拟环境等依赖目录中的许可证和上游说明。
- `TV-fongmi/` 中的上游参考文档；如需更新上游内容，应单独处理。
- `.omo/`、`.zcode/` 中的一次性侦查和代理工作记录；它们只用于追溯过程，不作为当前事实来源。
